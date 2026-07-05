"""
session_store.py — Crash-safe persistence for Botference plan sessions.
"""

from __future__ import annotations

import json
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from paths import BotferencePaths


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, indent=2, sort_keys=True)
        tmp.write("\n")
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)


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


class SessionStore:
    def __init__(self, paths: BotferencePaths):
        self.paths = paths
        self._metadata_cache: dict[str, SessionMetadata] | None = None

    @property
    def _metadata_index_path(self) -> Path:
        return self.paths.session_dir / _METADATA_INDEX_NAME

    def save(self, session_id: str, payload: dict[str, Any]) -> None:
        path = self.paths.session_state_file(session_id)
        _atomic_write_json(path, payload)
        # Keep the metadata index in sync so project_panel_snapshot stays cheap
        # without losing accuracy. Cache loads lazily on first read.
        if self._metadata_cache is not None:
            try:
                mtime = path.stat().st_mtime
            except OSError:
                mtime = 0.0
            transcript = payload.get("transcript", [])
            entry_count = (
                len(transcript) if isinstance(transcript, list) else 0
            )
            self._metadata_cache[session_id] = SessionMetadata(
                mtime=mtime,
                project_id=str(payload.get("project_id", "") or ""),
                entry_count=entry_count,
                updated_at=str(payload.get("updated_at", "") or ""),
                title=_display_title(payload),
                created_at=str(payload.get("created_at", "") or ""),
            )
            self._save_metadata_index(self._metadata_cache)

    def load(self, session_id: str) -> dict[str, Any]:
        path = self.paths.session_state_file(session_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def load_from_path(self, path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8"))

    def delete(self, session_id: str) -> None:
        self.paths.session_state_file(session_id).unlink(missing_ok=True)
        if self._metadata_cache is not None and session_id in self._metadata_cache:
            del self._metadata_cache[session_id]
            self._save_metadata_index(self._metadata_cache)

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
        removed = 0
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
                removed += 1
            except OSError:
                continue
        if removed and self._metadata_cache is not None:
            self._metadata_cache = None  # force rebuild on next read
        return removed

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
            _atomic_write_json(self._metadata_index_path, payload)
        except OSError:
            pass

    def metadata_index(self) -> dict[str, SessionMetadata]:
        """Cheap metadata lookup for project_panel_snapshot.

        Builds (or refreshes) work/sessions/.metadata-index.json so we can
        derive per-project counts and skip empty/unresumable snapshots
        without re-parsing every session JSON on every panel refresh.

        Falls back gracefully if the index can't be written (read-only fs).
        """
        if self._metadata_cache is None:
            self._metadata_cache = self._load_metadata_index()
        cache = self._metadata_cache
        session_dir = self.paths.session_dir
        if not session_dir.is_dir():
            return cache

        seen: set[str] = set()
        changed = False
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
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            transcript = payload.get("transcript", [])
            entry_count = (
                len(transcript) if isinstance(transcript, list) else 0
            )
            cache[session_id] = SessionMetadata(
                mtime=mtime,
                project_id=str(payload.get("project_id", "") or ""),
                entry_count=entry_count,
                updated_at=str(payload.get("updated_at", "") or ""),
                title=_display_title(payload),
                created_at=str(payload.get("created_at", "") or ""),
            )
            changed = True

        # Drop entries whose session files were deleted out from under us.
        for session_id in list(cache.keys()):
            if session_id not in seen:
                del cache[session_id]
                changed = True

        if changed:
            self._save_metadata_index(cache)
        # Return a shallow snapshot so background readers (e.g. the
        # async project-panel hydration) can iterate without racing a
        # concurrent save() that mutates the live cache. Entries are
        # frozen dataclasses, so a dict copy is enough.
        return dict(cache)

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
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\n")
