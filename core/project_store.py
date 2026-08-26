"""
project_store.py - Lightweight project discovery for Botference planner rooms.

Projects are durable work containers under project-root/projects/.  This module
keeps the first pass intentionally filesystem-based so existing folders show up
without a migration.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from session_store import atomic_write_json, file_lock


_SKIP_DIRS = {"__pycache__", ".git", ".obsidian", "node_modules"}


@dataclass(frozen=True)
class ProjectInfo:
    id: str
    title: str
    root: Path
    status: str = "active"
    priority: int | None = None
    next_action: str = ""
    session_ids: tuple[str, ...] = ()
    #: Browsable URL of the private GitHub repo this folder was pushed to,
    #: or "" when it has never been published. Written by set_github().
    github: str = ""

    @property
    def session_dir(self) -> Path:
        return self.root / "sessions"


# ── projects/<id>/TASKS.md ────────────────────────────────────────────
#
# A project's standing task list, curated by the bots: they append items,
# tick them off and prune dead ones, and the panels show it read-only.
# It is BOT-WRITTEN MARKDOWN, so the parser tolerates junk absolutely:
# prose, headings, nested indentation, `*` and `-` and `+` bullets, `[X]`
# and `[x]`, stray blank checkboxes, and a file that is not a list at all.
# Anything it cannot read is skipped rather than failing the panel.

TASKS_FILE_NAME = "TASKS.md"
# A curated list, not a log. Both bounds are defensive: a runaway bot
# rewriting this file must not be able to stall a panel refresh.
TASKS_MAX_BYTES = 256 * 1024
TASKS_MAX_ITEMS = 200
TASKS_MAX_TEXT = 300

_TASK_LINE = re.compile(
    r"^[ \t]*[-*+][ \t]+\[[ \t]*([xX ]?)[ \t]*\][ \t]+(.*\S.*)$",
)


@dataclass(frozen=True)
class ProjectTask:
    text: str
    done: bool = False


def parse_tasks_md(text: str) -> list[ProjectTask]:
    """Pull the checklist items out of a TASKS.md body.

    Only lines that are unambiguously markdown task items count. Everything
    else in the file — a title, a paragraph explaining why an item left the
    list, a table — is ignored, which is what lets the bots write prose
    around the list without breaking the panel.
    """
    tasks: list[ProjectTask] = []
    seen: set[str] = set()
    for line in str(text).splitlines():
        match = _TASK_LINE.match(line)
        if not match:
            continue
        body = " ".join(match.group(2).split()).strip()
        if not body:
            continue
        if len(body) > TASKS_MAX_TEXT:
            body = body[:TASKS_MAX_TEXT - 1].rstrip() + "…"
        key = body.casefold()
        if key in seen:  # a bot that pasted the list twice
            continue
        seen.add(key)
        tasks.append(ProjectTask(text=body, done=match.group(1).strip().lower() == "x"))
        if len(tasks) >= TASKS_MAX_ITEMS:
            break
    return tasks


def read_project_tasks(project_root: Path) -> list[ProjectTask]:
    """Read projects/<id>/TASKS.md. Missing, unreadable or oversized → []."""
    path = Path(project_root) / TASKS_FILE_NAME
    try:
        if path.stat().st_size > TASKS_MAX_BYTES:
            return []
        text = path.read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return []
    return parse_tasks_md(text)


# ── projects/<id>/ contents ───────────────────────────────────────────
#
# Read-only listing behind the project contents view. Same defensive
# posture as TASKS.md: a project folder is a place a person (or a bot)
# drops files, so it may contain a checked-out repo, a venv, or a
# thousand PDFs — none of which may be allowed to stall a panel refresh.

CONTENTS_MAX_DEPTH = 1        # top level, plus one level inside each folder
CONTENTS_MAX_ENTRIES = 400


@dataclass(frozen=True)
class ProjectFile:
    """One row of the project contents view."""

    #: Path relative to projects/<id>/, posix-style.
    path: str
    name: str
    is_dir: bool = False
    size: int = 0
    modified: float = 0.0
    depth: int = 0
    #: True when a directory's children were not walked (depth cap).
    truncated: bool = False


def _walk_shallow(root: Path, here: Path, *, depth: int) -> list[ProjectFile]:
    out: list[ProjectFile] = []
    try:
        children = sorted(
            here.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()),
        )
    except OSError:
        return out
    for child in children:
        if child.name.startswith(".") or child.name in _SKIP_DIRS:
            continue
        try:
            stat = child.stat()
        except OSError:
            continue
        is_dir = child.is_dir()
        rel = child.relative_to(root).as_posix()
        deeper = depth < CONTENTS_MAX_DEPTH
        out.append(ProjectFile(
            path=rel,
            name=child.name,
            is_dir=is_dir,
            size=0 if is_dir else int(stat.st_size),
            modified=float(stat.st_mtime),
            depth=depth,
            truncated=is_dir and not deeper,
        ))
        if len(out) >= CONTENTS_MAX_ENTRIES:
            return out[:CONTENTS_MAX_ENTRIES]
        if is_dir and deeper:
            out.extend(_walk_shallow(root, child, depth=depth + 1))
            if len(out) >= CONTENTS_MAX_ENTRIES:
                return out[:CONTENTS_MAX_ENTRIES]
    return out


def _title_from_slug(slug: str) -> str:
    parts = re.split(r"[-_]+", slug)
    return " ".join(part[:1].upper() + part[1:] for part in parts if part)


def _first_heading(path: Path) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("# "):
                return stripped[2:].strip()
    except OSError:
        return ""
    return ""


def _load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def slugify_project_title(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug or "untitled-project"


def _portfolio_entries(projects_root: Path) -> dict[str, dict[str, Any]]:
    """Load optional projects/portfolio.json metadata.

    YAML can come later; JSON keeps this dependency-free for the controller.
    Shape:
      {"projects": [{"id": "career-switch", "title": "..."}]}
    """

    data = _load_json(projects_root / "portfolio.json")
    raw_projects = data.get("projects", [])
    if not isinstance(raw_projects, list):
        return {}
    entries: dict[str, dict[str, Any]] = {}
    for raw in raw_projects:
        if not isinstance(raw, dict):
            continue
        project_id = str(raw.get("id") or raw.get("slug") or "").strip()
        if project_id:
            entries[project_id] = raw
    return entries


def _session_index(projects_root: Path) -> dict[str, list[str]]:
    """Map project id -> session ids from optional projects/session-index.json."""

    data = _load_json(projects_root / "session-index.json")
    raw_sessions = data.get("sessions", [])
    if not isinstance(raw_sessions, list):
        return {}
    out: dict[str, list[str]] = {}
    for raw in raw_sessions:
        if not isinstance(raw, dict):
            continue
        project_id = str(raw.get("project") or raw.get("project_id") or "").strip()
        session_id = str(raw.get("session_id") or raw.get("id") or "").strip()
        if project_id and session_id:
            out.setdefault(project_id, []).append(session_id)
    return out


def _session_index_map(projects_root: Path) -> dict[str, str]:
    """Return canonical session_id -> project_id from session-index.json.

    Older indexes may contain the same session more than once.  Preserve
    append-order semantics: the most recent association wins.
    """

    data = _load_json(projects_root / "session-index.json")
    raw_sessions = data.get("sessions", [])
    if not isinstance(raw_sessions, list):
        return {}
    out: dict[str, str] = {}
    for raw in raw_sessions:
        if not isinstance(raw, dict):
            continue
        project_id = str(raw.get("project") or raw.get("project_id") or "").strip()
        session_id = str(raw.get("session_id") or raw.get("id") or "").strip()
        if project_id and session_id:
            out[session_id] = project_id
    return out


class ProjectStore:
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.projects_root = project_root / "projects"

    def session_index_map(self) -> dict[str, str]:
        """Return session_id -> project_id from session-index.json (cheap)."""
        return _session_index_map(self.projects_root)

    def list_projects(self) -> list[ProjectInfo]:
        if not self.projects_root.is_dir():
            return []

        metadata = _portfolio_entries(self.projects_root)
        session_index: dict[str, list[str]] = {}
        for session_id, project_id in _session_index_map(self.projects_root).items():
            session_index.setdefault(project_id, []).append(session_id)
        projects: list[ProjectInfo] = []
        for child in sorted(self.projects_root.iterdir(), key=lambda p: p.name.lower()):
            if not child.is_dir() or child.name.startswith(".") or child.name in _SKIP_DIRS:
                continue
            project_id = child.name
            meta = metadata.get(project_id, {})
            title = str(meta.get("title") or "").strip()
            if not title:
                title = _first_heading(child / "PROJECT.md")
            if not title:
                title = _first_heading(child / "README.md")
            if not title:
                title = _title_from_slug(project_id)
            status = str(meta.get("status") or "active").strip() or "active"
            next_action = str(meta.get("next_action") or "").strip()
            priority_raw = meta.get("priority")
            try:
                priority = int(priority_raw) if priority_raw is not None else None
            except (TypeError, ValueError):
                priority = None
            projects.append(ProjectInfo(
                id=project_id,
                title=title,
                root=child,
                status=status,
                priority=priority,
                next_action=next_action,
                session_ids=tuple(session_index.get(project_id, [])),
                github=str(meta.get("github") or "").strip(),
            ))

        return sorted(projects, key=lambda p: (
            p.status != "active",
            p.priority is None,
            p.priority if p.priority is not None else 999,
            p.title.lower(),
        ))

    def tasks(self, project_id: str) -> list[ProjectTask]:
        """The project's curated task list, or [] when it has none."""
        project_id = str(project_id).strip()
        if not project_id:
            return []
        return read_project_tasks(self.projects_root / project_id)

    def contents(self, project_id: str) -> list[ProjectFile]:
        """A shallow listing of projects/<id>/ — what is actually in there.

        Deliberately SHALLOW (top level plus one level inside each folder,
        `CONTENTS_MAX_DEPTH`): the point is "what is in this project", not a
        file browser, and a project folder that happens to contain a cloned
        repo or a node_modules must not be able to stall a panel refresh.
        Entries are capped at `CONTENTS_MAX_ENTRIES` and sorted folders-first
        then by name, which is how a person reads a directory.
        """
        project_id = str(project_id).strip()
        if not project_id:
            return []
        root = self.projects_root / project_id
        if not root.is_dir():
            return []
        return _walk_shallow(root, root, depth=0)

    def get(self, project_id_or_title: str) -> ProjectInfo | None:
        query = project_id_or_title.strip().lower()
        if not query:
            return None
        projects = self.list_projects()
        by_id = {p.id.lower(): p for p in projects}
        if query in by_id:
            return by_id[query]
        matches = [
            p for p in projects
            if p.id.lower().startswith(query) or p.title.lower().startswith(query)
        ]
        if len(matches) == 1:
            return matches[0]
        contains = [
            p for p in projects
            if query in p.id.lower() or query in p.title.lower()
        ]
        return contains[0] if len(contains) == 1 else None

    def create_project(self, title: str) -> ProjectInfo:
        clean_title = " ".join(title.split()).strip()
        if not clean_title:
            raise ValueError("Project title is required.")
        project_id = slugify_project_title(clean_title)
        project_root = self.projects_root / project_id
        if project_root.exists():
            raise FileExistsError(project_id)

        project_root.mkdir(parents=True, exist_ok=False)
        project_root.joinpath("PROJECT.md").write_text(
            f"# {clean_title}\n\n"
            "**Status:** active\n"
            "**Priority:** \n"
            "**Cadence:** weekly\n\n"
            "## Why This Matters\n\n"
            "TODO\n\n"
            "## Desired Outcome\n\n"
            "TODO\n\n"
            "## Next Action\n\n"
            "TODO\n",
            encoding="utf-8",
        )
        self._upsert_portfolio_entry({
            "id": project_id,
            "title": clean_title,
            "status": "active",
            "priority": None,
            "root": f"projects/{project_id}",
            "cadence": "weekly",
            "why": "TODO",
            "desired_outcome": "TODO",
            "next_action": "TODO",
        })
        return ProjectInfo(
            id=project_id,
            title=clean_title,
            root=project_root,
            status="active",
            priority=None,
            next_action="TODO",
        )

    def set_status(self, project_id: str, status: str, *, title: str = "") -> bool:
        """Flip a project's portfolio status (e.g. active -> archived).

        Nothing is moved or deleted: the project folder, its PROJECT.md and
        every chat filed under it stay exactly where they are — only the
        `status` field in projects/portfolio.json changes, so the reverse is
        another set_status() call. list_projects() sorts non-active projects
        last and frontends tuck them away.

        Returns False when the project id is empty; a filesystem-discovered
        project with no portfolio row yet gets one written for it.
        """
        status = status.strip() or "active"
        return self._patch_portfolio_entry(
            project_id, {"status": status}, title=title, default_status=status,
        )

    def set_github(self, project_id: str, url: str, *, title: str = "") -> bool:
        """Remember which private GitHub repo this project was pushed to.

        Only the ``github`` field in projects/portfolio.json changes — the
        folder and its git remote are the real state; this is the copy the
        panels read so a published project can show its link without shelling
        out to git on every refresh. Passing "" forgets the link.
        """
        return self._patch_portfolio_entry(
            project_id, {"github": str(url or "").strip()}, title=title,
        )

    def _patch_portfolio_entry(
        self,
        project_id: str,
        patch: dict[str, Any],
        *,
        title: str = "",
        default_status: str = "active",
    ) -> bool:
        """Merge *patch* into one project's portfolio.json row, under lock.

        Returns False when the project id is empty; a filesystem-discovered
        project with no portfolio row yet gets one written for it.
        """
        project_id = project_id.strip()
        if not project_id:
            return False
        path = self.projects_root / "portfolio.json"
        # portfolio.json is shared state, and this was the one unlocked
        # read-modify-write left in the module: archiving a project while
        # another process created one dropped the new project's row on the
        # floor (or resurrected an archived one). Same discipline as
        # _upsert_portfolio_entry and associate_session.
        with file_lock(path):
            data = _load_json(path)
            raw_projects = data.get("projects")
            if not isinstance(raw_projects, list):
                raw_projects = []
            found = False
            projects: list[Any] = []
            for raw in raw_projects:
                if (
                    isinstance(raw, dict)
                    and str(raw.get("id") or raw.get("slug") or "").strip() == project_id
                ):
                    entry = dict(raw)
                    entry.update(patch)
                    projects.append(entry)
                    found = True
                else:
                    projects.append(raw)
            if not found:
                projects.append({
                    "id": project_id,
                    "title": title or _title_from_slug(project_id),
                    "status": default_status,
                    "root": f"projects/{project_id}",
                    **patch,
                })
            data["version"] = data.get("version", 1)
            data["projects"] = projects
            self._write_json(path, data)
        return True

    def associate_session(self, project_id: str, session_id: str) -> None:
        project_id = project_id.strip()
        session_id = session_id.strip()
        if not project_id or not session_id:
            return
        path = self.projects_root / "session-index.json"
        # session-index.json is shared state: the TUI and every web-council
        # bridge file chats into projects concurrently. Read-modify-write it
        # under a lock, or one writer's association silently overwrites
        # another's and that chat drops back to Inbox (or keeps a project it
        # was just moved out of).
        with file_lock(path):
            data = _load_json(path)
            sessions = data.get("sessions")
            if not isinstance(sessions, list):
                sessions = []
            kept_sessions = []
            changed = False
            matched = 0
            for raw in sessions:
                if not isinstance(raw, dict):
                    kept_sessions.append(raw)
                    continue
                raw_session_id = str(raw.get("session_id") or raw.get("id") or "").strip()
                if raw_session_id == session_id:
                    matched += 1
                    if str(raw.get("project") or raw.get("project_id") or "").strip() != project_id:
                        changed = True
                    continue
                kept_sessions.append(raw)
            # Already filed here exactly once: skip the rewrite entirely. Every
            # persisted turn calls this, and a no-op rewrite is pure contention
            # (plus a chance to lose a concurrent writer's association).
            if matched == 1 and not changed:
                return
            kept_sessions.append({"session_id": session_id, "project": project_id})
            data["version"] = data.get("version", 1)
            data["sessions"] = kept_sessions
            self._write_json(path, data)

    def dissociate_session(self, session_id: str) -> None:
        """Drop a chat from the project index (e.g. when it is deleted)."""
        session_id = session_id.strip()
        if not session_id:
            return
        path = self.projects_root / "session-index.json"
        with file_lock(path):
            data = _load_json(path)
            sessions = data.get("sessions")
            if not isinstance(sessions, list):
                return
            kept = [
                raw for raw in sessions
                if not (isinstance(raw, dict)
                        and str(raw.get("session_id") or raw.get("id") or "").strip()
                        == session_id)
            ]
            if len(kept) == len(sessions):
                return
            data["sessions"] = kept
            self._write_json(path, data)

    def _upsert_portfolio_entry(self, entry: dict[str, Any]) -> None:
        path = self.projects_root / "portfolio.json"
        with file_lock(path):
            data = _load_json(path)
            projects = data.get("projects")
            if not isinstance(projects, list):
                projects = []
            project_id = str(entry.get("id", ""))
            updated = False
            new_projects: list[Any] = []
            for raw in projects:
                if isinstance(raw, dict) and raw.get("id") == project_id:
                    new_projects.append(entry)
                    updated = True
                else:
                    new_projects.append(raw)
            if not updated:
                new_projects.append(entry)
            data["version"] = data.get("version", 1)
            data["active_project_limit"] = data.get("active_project_limit", 10)
            data["projects"] = new_projects
            self._write_json(path, data)

    @staticmethod
    def _write_json(path: Path, data: dict[str, Any]) -> None:
        # Atomic: a plain write_text leaves the file truncated mid-write, and
        # a concurrent reader that parses it then sees NO project memberships
        # at all — every chat blinks into Inbox.
        atomic_write_json(path, data, indent=2)
