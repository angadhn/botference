"""
session_store.py — Crash-safe persistence for Botference plan sessions.
"""

from __future__ import annotations

import json
import shutil
import threading
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Iterator

from paths import BotferencePaths

try:  # POSIX advisory locking; absent on Windows.
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - Windows
    _fcntl = None


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Cross-process advisory lock guarding read-modify-write of *path*.

    Several Botference processes now share one workspace (the Ink TUI plus
    one web-council bridge per open chat), and they all read-modify-write the
    same shared index files. Without a lock the last writer silently drops
    whatever another process wrote in between.

    The lock lives in a sidecar `.<name>.lock` file, not in *path* itself:
    shared files are replaced atomically, so a lock held on the old inode
    would protect nothing. (Dot-prefixed because these directories are also
    the user's own project folders — and because every session-dir scan
    already skips dotfiles.) Degrades to a no-op where locking is unavailable
    (Windows, read-only filesystem) — the merge logic still limits the damage.
    """
    handle = None
    if _fcntl is not None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            handle = open(path.with_name(f".{path.name}.lock"), "a+")
            _fcntl.flock(handle.fileno(), _fcntl.LOCK_EX)
        except OSError:
            if handle is not None:
                handle.close()
            handle = None
    try:
        yield
    finally:
        if handle is not None:
            try:
                _fcntl.flock(handle.fileno(), _fcntl.LOCK_UN)
            except OSError:
                pass
            handle.close()


def atomic_write_json(
    path: Path,
    payload: dict[str, Any],
    *,
    indent: int | None = None,
) -> float:
    """Write *payload* to *path* atomically; return the written file's mtime.

    The mtime is read from the temp file's inode BEFORE the rename — that is
    the inode the reader will stat, and it stays correct even if another
    process replaces *path* a moment later. Stat-ing *path* after the rename
    would hand back a competing writer's mtime and pin our (now stale) data
    to their timestamp, which is exactly how a stale metadata-index row
    becomes permanent instead of self-healing on the next scan.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        # Compact separators, no indent/sort by default: the session file is
        # rewritten in full on every room entry, so serialization cost scales
        # with chat length. indent=2 + sort_keys measured ~4x slower and ~20%
        # larger at 10K transcript entries (~340ms vs ~90ms per save) — enough
        # to stall the controller's event loop several times per turn.
        if indent is None:
            json.dump(payload, tmp, separators=(",", ":"))
        else:
            json.dump(payload, tmp, indent=indent)
        tmp.write("\n")
        tmp_path = Path(tmp.name)
    try:
        mtime = tmp_path.stat().st_mtime
    except OSError:
        mtime = 0.0
    tmp_path.replace(path)
    return mtime


# Back-compat alias: the private name predates the shared helper.
_atomic_write_json = atomic_write_json


def _entry_count(payload: dict[str, Any]) -> int:
    transcript = payload.get("transcript", [])
    return len(transcript) if isinstance(transcript, list) else 0


def _default_title(payload: dict[str, Any]) -> str:
    transcript = payload.get("transcript", [])
    if isinstance(transcript, list):
        for entry in transcript:
            if not isinstance(entry, dict):
                continue
            if entry.get("speaker") != "user":
                continue
            text = " ".join(str(entry.get("text", "")).split()).strip()
            if text:
                return text[:80]
    task = " ".join(str(payload.get("task", "")).split()).strip()
    return task[:80] if task else "Untitled session"


def _display_title(payload: dict[str, Any]) -> str:
    custom_title = str(payload.get("custom_title") or "").strip()
    if custom_title:
        return custom_title
    title = str(payload.get("title") or "").strip()
    if title and title != "Untitled session":
        return title
    return _default_title(payload)


@dataclass(frozen=True)
class SessionSummary:
    session_id: str
    created_at: str
    updated_at: str
    title: str
    entry_count: int
    source_path: str = ""
    project_id: str = ""


@dataclass(frozen=True)
class SessionMetadata:
    mtime: float
    project_id: str
    entry_count: int
    updated_at: str
    title: str = ""
    created_at: str = ""


_METADATA_INDEX_NAME = ".metadata-index.json"


class StaleSessionWrite(RuntimeError):
    """A save would have overwritten a session file a newer writer changed.

    Raised only when the copy on disk is demonstrably AHEAD of the payload
    being written (more transcript entries), which is the one shape of the
    race that loses a whole turn. Everything else — an equal or shorter file,
    an unreadable one, a first write — proceeds, because the single-writer
    case must stay exactly as fast and as quiet as it was.
    """

    def __init__(self, session_id: str, ours: int, theirs: int):
        self.session_id = session_id
        self.ours = ours
        self.theirs = theirs
        super().__init__(
            f"refusing to overwrite session {session_id}: the file on disk has "
            f"{theirs} transcript entries, this writer has {ours}. Another "
            f"process saved it after we last read it."
        )


class SessionStore:
    def __init__(self, paths: BotferencePaths):
        self.paths = paths
        self._metadata_cache: dict[str, SessionMetadata] | None = None
        # session_id -> the mtime of the file as this process last left it
        # (written by save/set_project, or observed by load). A file whose
        # mtime no longer matches has moved under us; see _check_not_stale.
        self._seen_mtime: dict[str, float] = {}
        # The panel hydrates on a worker thread while the controller saves on
        # the event loop thread, so cache mutation and index writes are guarded.
        self._lock = threading.RLock()

    @property
    def _metadata_index_path(self) -> Path:
        return self.paths.session_dir / _METADATA_INDEX_NAME

    def _check_not_stale(
        self, session_id: str, path: Path, payload: dict[str, Any],
    ) -> None:
        """Raise StaleSessionWrite if *path* moved under us and is ahead.

        The session file is rewritten whole on every persisted turn, so two
        writers on one session id silently lose a turn: A resumes S, B saves
        S, A writes its stale copy back. Nothing enforces "one writer per
        session" in Python — the plugin pool holds it in Node (SPEC §5) and
        the council web UI holds it by having one bridge per chat. This is
        the belt: the writer that would destroy work notices and says so,
        rather than the loss being invisible.

        Deliberately NOT a lock. The single-writer path costs one extra stat
        per save and never blocks.
        """
        try:
            mtime = path.stat().st_mtime
        except OSError:
            self._seen_mtime.pop(session_id, None)
            return  # no file yet (or unreadable): nothing to lose
        if self._seen_mtime.get(session_id) == mtime:
            return  # exactly as we left it
        try:
            on_disk = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return  # unparseable: our payload is strictly better than junk
        if not isinstance(on_disk, dict):
            return
        theirs = _entry_count(on_disk)
        ours = _entry_count(payload)
        if theirs > ours:
            raise StaleSessionWrite(session_id, ours, theirs)
        # Their copy is not ahead of ours (a re-save, a rename, a set_project
        # stamp, or our own first write): adopt the mtime and carry on.
        self._seen_mtime[session_id] = mtime

    def save(
        self, session_id: str, payload: dict[str, Any], *, force: bool = False,
    ) -> None:
        """Persist a session. Raises StaleSessionWrite when a newer writer
        has a longer transcript on disk, unless *force* is set."""
        path = self.paths.session_state_file(session_id)
        if not force:
            self._check_not_stale(session_id, path, payload)
        mtime = atomic_write_json(path, payload)
        self._seen_mtime[session_id] = mtime
        self._publish_metadata_row(session_id, payload, mtime)

    def set_project(
        self,
        session_id: str,
        project_id: str,
        *,
        path: Path | None = None,
    ) -> bool:
        """Stamp ``project_id`` into a saved chat's payload on disk.

        Filing a chat you are NOT currently sitting in. The payload is the
        authority on project membership everywhere it is resolved (project
        panel, /resume, restore); ``projects/session-index.json`` only
        backfills legacy chats whose payload predates the field. So an index
        association alone silently loses to whatever the payload already
        says — this is the other half of that move.

        Best effort by design: if the chat is open in another bridge process
        right now, that process's next save re-stamps its own in-memory
        active project. Cross-process signalling is deliberately out of
        scope; close the chat there (or /project open inside it) instead.
        """
        target = path or self.paths.session_state_file(session_id)
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if not isinstance(payload, dict):
            return False
        payload["project_id"] = project_id
        try:
            mtime = atomic_write_json(target, payload)
        except OSError:
            return False
        # Only the global session dir is covered by the metadata index;
        # project-local session files are parsed inline by the panel.
        try:
            indexed = target.resolve() == self.paths.session_state_file(
                session_id
            ).resolve()
        except (OSError, RuntimeError, ValueError):
            indexed = False
        if indexed:
            self._seen_mtime[session_id] = mtime
            self._publish_metadata_row(session_id, payload, mtime)
        return True

    def _publish_metadata_row(
        self, session_id: str, payload: dict[str, Any], mtime: float,
    ) -> None:
        # Keep the metadata index in sync so project_panel_snapshot stays cheap
        # without losing accuracy. Cache loads lazily on first read.
        if self._metadata_cache is not None:
            transcript = payload.get("transcript", [])
            entry_count = (
                len(transcript) if isinstance(transcript, list) else 0
            )
            entry = SessionMetadata(
                mtime=mtime,
                project_id=str(payload.get("project_id", "") or ""),
                entry_count=entry_count,
                updated_at=str(payload.get("updated_at", "") or ""),
                title=_display_title(payload),
                created_at=str(payload.get("created_at", "") or ""),
            )
            with self._lock:
                if self._metadata_cache is None:  # pruned from another thread
                    return
                self._metadata_cache[session_id] = entry
                # Publish just THIS row into the shared index. Dumping our whole
                # cache would resurrect stale rows for chats another process has
                # since moved to a different project.
                self._metadata_cache = self._sync_metadata_index(
                    {session_id: entry}
                )

    def load(self, session_id: str) -> dict[str, Any]:
        path = self.paths.session_state_file(session_id)
        payload = json.loads(path.read_text(encoding="utf-8"))
        # Reading is how a writer becomes current: the next save compares
        # against the state we just took a copy of.
        try:
            self._seen_mtime[session_id] = path.stat().st_mtime
        except OSError:
            pass
        return payload

    def load_from_path(self, path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8"))

    def delete(self, session_id: str) -> None:
        self.paths.session_state_file(session_id).unlink(missing_ok=True)
        self._forget(session_id)

    def _forget(self, session_id: str) -> None:
        """Drop a session from the metadata index (its file left session_dir).

        Publishes the removal into the SHARED index under the lock — a
        wholesale cache dump here would resurrect stale rows for chats
        another process has since moved (delete and archive both funnel
        through this).
        """
        self._seen_mtime.pop(session_id, None)
        with self._lock:
            if self._metadata_cache is not None:
                self._metadata_cache.pop(session_id, None)
            if self._metadata_cache is not None or self._metadata_index_path.exists():
                merged = self._sync_metadata_index({}, removals={session_id})
                if self._metadata_cache is not None:
                    self._metadata_cache = merged

    # ── archive: out of the listing, never off the disk ──────────────
    #
    # Archiving MOVES work/sessions/<id>.json to archive/sessions/<id>.json.
    # Nothing is rewritten, so the operation is a single atomic rename and
    # unarchive() is the exact inverse. Every listing path globs
    # paths.session_dir, so the chat simply stops appearing — no payload
    # flag to keep in sync, and no read-modify-write race with another
    # bridge process that has the same workspace open.

    def archive(self, session_id: str) -> bool:
        """Move a saved chat into archive/sessions/. Returns False when the
        file is already gone (deleted or archived by another process)."""
        return self._relocate(
            self.paths.session_state_file(session_id),
            self.paths.archived_session_state_file(session_id),
            forget=session_id,
        )

    def unarchive(self, session_id: str) -> bool:
        """Move an archived chat back into the active listing.

        Returns False when there is no archived file, or when an active
        session with that id already exists — restoring must never clobber
        live state (the archived copy is left untouched for inspection).
        """
        active = self.paths.session_state_file(session_id)
        if active.exists():
            return False
        return self._relocate(
            self.paths.archived_session_state_file(session_id), active,
        )

    def list_archived_summaries(self, *, limit: int = 200) -> list[SessionSummary]:
        """Summaries for archived chats (newest first)."""
        return self.list_summaries(
            limit=limit, session_dirs=[self.paths.archived_session_dir],
        )

    def _relocate(self, src: Path, dst: Path, *, forget: str = "") -> bool:
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.replace(dst)  # atomic within one filesystem
        except FileNotFoundError:
            return False
        except OSError:
            # Different mounts (a bind-mounted archive dir): fall back to a
            # copy+unlink move, which is still no-loss.
            try:
                shutil.move(str(src), str(dst))
            except (OSError, shutil.Error):
                return False
        if forget:
            self._forget(forget)
        return True

    def prune_empty(self, *, max_age_seconds: float = 86_400.0) -> int:
        """Delete zero-transcript session files older than *max_age_seconds*.

        Empty sessions are launch corpses — nothing a user could resume.
        The age guard protects a chat that is open right now in another
        process but hasn't received its first message yet. Returns the
        number of files removed.
        """
        import time as _time
        session_dir = self.paths.session_dir
        if not session_dir.is_dir():
            return 0
        cutoff = _time.time() - max_age_seconds
        removed_ids: set[str] = set()
        for path in session_dir.glob("*.json"):
            if path.name.startswith("."):
                continue
            try:
                if path.stat().st_mtime > cutoff:
                    continue
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            transcript = payload.get("transcript", [])
            if isinstance(transcript, list) and len(transcript) >= 1:
                continue
            try:
                path.unlink()
                removed_ids.add(path.stem)
            except OSError:
                continue
        if removed_ids:
            with self._lock:
                if self._metadata_index_path.exists():
                    # Drop the pruned rows from the SHARED index without
                    # republishing our own (possibly stale) cache.
                    self._sync_metadata_index({}, removals=removed_ids)
                if self._metadata_cache is not None:
                    self._metadata_cache = None  # force rebuild on next read
        return len(removed_ids)

    def _load_metadata_index(self) -> dict[str, SessionMetadata]:
        path = self._metadata_index_path
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(data, dict):
            return {}
        raw_entries = data.get("entries", {})
        if not isinstance(raw_entries, dict):
            return {}
        out: dict[str, SessionMetadata] = {}
        for session_id, raw in raw_entries.items():
            if not isinstance(raw, dict):
                continue
            try:
                mtime = float(raw.get("mtime", 0.0) or 0.0)
            except (TypeError, ValueError):
                mtime = 0.0
            try:
                entry_count = int(raw.get("entry_count", 0) or 0)
            except (TypeError, ValueError):
                entry_count = 0
            out[str(session_id)] = SessionMetadata(
                mtime=mtime,
                project_id=str(raw.get("project_id", "") or ""),
                entry_count=entry_count,
                updated_at=str(raw.get("updated_at", "") or ""),
                title=str(raw.get("title", "") or ""),
                created_at=str(raw.get("created_at", "") or ""),
            )
        return out

    def _save_metadata_index(self, cache: dict[str, SessionMetadata]) -> None:
        payload = {
            "version": 1,
            "entries": {
                session_id: {
                    "mtime": entry.mtime,
                    "project_id": entry.project_id,
                    "entry_count": entry.entry_count,
                    "updated_at": entry.updated_at,
                    "title": entry.title,
                    "created_at": entry.created_at,
                }
                for session_id, entry in cache.items()
            },
        }
        try:
            atomic_write_json(self._metadata_index_path, payload)
        except OSError:
            pass

    def _sync_metadata_index(
        self,
        updates: dict[str, SessionMetadata],
        *,
        removals: set[str] | frozenset[str] = frozenset(),
    ) -> dict[str, SessionMetadata]:
        """Merge *updates* into the shared on-disk index; return the result.

        The index is shared state: the TUI and every web-council bridge write
        it concurrently. A writer that rewrote the file from its own in-memory
        cache would (a) delete rows for chats it has never seen and (b)
        resurrect its stale `project_id` for chats another process has since
        moved — which is how a rockets chat ends up listed under Health &
        Fitness. So we re-read the file inside a lock and overlay only the
        rows we actually verified this pass, freshest mtime winning per row.

        A row is removed only if its session file is really gone: a chat
        created by another process microseconds ago must survive our write.
        """
        path = self._metadata_index_path
        with self._lock, file_lock(path):
            on_disk = self._load_metadata_index()
            merged = dict(on_disk)
            for session_id, entry in updates.items():
                current = merged.get(session_id)
                if current is None or entry.mtime >= current.mtime:
                    merged[session_id] = entry
            for session_id in removals:
                if self.paths.session_state_file(session_id).exists():
                    continue
                merged.pop(session_id, None)
            if merged != on_disk:
                self._save_metadata_index(merged)
            return merged

    def metadata_index(self) -> dict[str, SessionMetadata]:
        """Cheap metadata lookup for project_panel_snapshot.

        Builds (or refreshes) work/sessions/.metadata-index.json so we can
        derive per-project counts and skip empty/unresumable snapshots
        without re-parsing every session JSON on every panel refresh.

        The session file on disk — not any cached row — is the authority on
        which project a chat belongs to: a row whose mtime no longer matches
        its file is re-parsed, so a row another process got wrong self-heals.

        Falls back gracefully if the index can't be written (read-only fs).
        """
        with self._lock:
            if self._metadata_cache is None:
                self._metadata_cache = self._load_metadata_index()
            # Scan against a snapshot, not the live cache: this runs on the
            # panel's worker thread while the controller saves on the event
            # loop, and holding the lock across the whole scan would stall
            # every save behind it.
            cache = dict(self._metadata_cache)
        session_dir = self.paths.session_dir
        if not session_dir.is_dir():
            return cache

        seen: set[str] = set()
        verified: dict[str, SessionMetadata] = {}
        for path in session_dir.glob("*.json"):
            session_id = path.stem
            if session_id.startswith("."):
                continue
            seen.add(session_id)
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            cached = cache.get(session_id)
            # Cached title="" signals a pre-upgrade entry written before we
            # cached display title; re-parse once to backfill so the project
            # panel can build summaries from the index alone next launch.
            # _display_title() never returns the empty string, so this is safe.
            if cached is not None and cached.mtime == mtime and cached.title:
                verified[session_id] = cached
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            transcript = payload.get("transcript", [])
            entry_count = (
                len(transcript) if isinstance(transcript, list) else 0
            )
            verified[session_id] = SessionMetadata(
                mtime=mtime,
                project_id=str(payload.get("project_id", "") or ""),
                entry_count=entry_count,
                updated_at=str(payload.get("updated_at", "") or ""),
                title=_display_title(payload),
                created_at=str(payload.get("created_at", "") or ""),
            )

        # Entries whose session files were deleted out from under us. The
        # merge re-checks each one on disk, so a chat another process created
        # after our scan started is never dropped.
        gone = {session_id for session_id in cache if session_id not in seen}

        # Publish what we verified and adopt whatever other processes have
        # written meanwhile, so our cache never drifts behind the workspace.
        with self._lock:
            merged = self._sync_metadata_index(verified, removals=gone)
            self._metadata_cache = merged
        # Return a shallow snapshot so background readers (e.g. the
        # async project-panel hydration) can iterate without racing a
        # concurrent save() that mutates the live cache. Entries are
        # frozen dataclasses, so a dict copy is enough.
        return dict(merged)

    def summary_from_metadata(
        self,
        session_id: str,
        entry: SessionMetadata,
        *,
        project_id: str = "",
    ) -> SessionSummary:
        """Build a SessionSummary purely from a cached metadata entry.

        Used by the project panel shortlist so we don't have to re-read each
        session JSON to populate title/created_at. `project_id` is the
        fallback membership when entry.project_id is empty (legacy sessions
        whose payload predates the project_id field — membership comes from
        ProjectStore.session_index_map() and is supplied by the caller).
        """
        return SessionSummary(
            session_id=session_id,
            created_at=entry.created_at,
            updated_at=entry.updated_at,
            title=entry.title or "Untitled session",
            entry_count=entry.entry_count,
            source_path=str(self.paths.session_state_file(session_id)),
            project_id=entry.project_id or project_id,
        )

    def list_summaries(
        self,
        *,
        limit: int = 10,
        exclude_session_id: str = "",
        session_dirs: list[Path] | None = None,
        project_id: str = "",
    ) -> list[SessionSummary]:
        summaries: list[SessionSummary] = []
        dirs = session_dirs or [self.paths.session_dir]
        paths: list[Path] = []
        seen_paths: set[Path] = set()
        for session_dir in dirs:
            if not session_dir.is_dir():
                continue
            for path in session_dir.glob("*.json"):
                resolved = path.resolve()
                if resolved in seen_paths:
                    continue
                seen_paths.add(resolved)
                paths.append(path)

        seen_sessions: set[str] = set()
        for path in sorted(
            paths,
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            session_id = str(payload.get("session_id") or path.stem)
            if exclude_session_id and session_id == exclude_session_id:
                continue
            if session_id in seen_sessions:
                continue
            seen_sessions.add(session_id)
            payload_project = str(payload.get("project_id") or payload.get("project") or "")
            if project_id and payload_project and payload_project != project_id:
                continue
            entry_count = _entry_count(payload)
            if entry_count < 1:
                continue
            summaries.append(SessionSummary(
                session_id=session_id,
                created_at=str(payload.get("created_at", "")),
                updated_at=str(payload.get("updated_at", "")),
                title=_display_title(payload),
                entry_count=entry_count,
                source_path=str(path),
                project_id=payload_project,
            ))
            if len(summaries) >= limit:
                break
        return summaries


# The crash log is append-only across every session in a work dir; without a
# cap a long-lived install (or a crash loop) grows it forever. When it exceeds
# the cap the current file rotates to crash.log.1 (one previous generation
# kept), so recent history always survives.
_CRASH_LOG_MAX_BYTES = 5 * 1024 * 1024


def _rotate_if_oversized(path: Path, max_bytes: int) -> None:
    try:
        if path.stat().st_size <= max_bytes:
            return
    except OSError:
        return
    try:
        path.replace(path.with_name(path.name + ".1"))
    except OSError:
        pass


def append_crash_log(
    paths: BotferencePaths,
    *,
    location: str,
    session_id: str,
    exc: BaseException,
) -> None:
    payload = {
        "timestamp": iso_now(),
        "location": location,
        "session_id": session_id,
        "error_type": type(exc).__name__,
        "message": str(exc),
        "traceback": "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
    }
    path = paths.session_crash_log
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_oversized(path, _CRASH_LOG_MAX_BYTES)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload) + "\n")
    except OSError:
        # Crash logging must never introduce a second failure on top of the
        # one being reported (e.g. read-only or full filesystem).
        pass
