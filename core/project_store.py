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

    @property
    def session_dir(self) -> Path:
        return self.root / "sessions"


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
            ))

        return sorted(projects, key=lambda p: (
            p.status != "active",
            p.priority is None,
            p.priority if p.priority is not None else 999,
            p.title.lower(),
        ))

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

    def associate_session(self, project_id: str, session_id: str) -> None:
        project_id = project_id.strip()
        session_id = session_id.strip()
        if not project_id or not session_id:
            return
        path = self.projects_root / "session-index.json"
        data = _load_json(path)
        sessions = data.get("sessions")
        if not isinstance(sessions, list):
            sessions = []
        kept_sessions = []
        changed = False
        for raw in sessions:
            if not isinstance(raw, dict):
                kept_sessions.append(raw)
                continue
            raw_session_id = str(raw.get("session_id") or raw.get("id") or "").strip()
            if raw_session_id == session_id:
                changed = True
                continue
            kept_sessions.append(raw)
        kept_sessions.append({"session_id": session_id, "project": project_id})
        data["version"] = data.get("version", 1)
        data["sessions"] = kept_sessions
        if not changed and sessions == kept_sessions:
            return
        self._write_json(path, data)

    def dissociate_session(self, session_id: str) -> None:
        """Drop a chat from the project index (e.g. when it is deleted)."""
        session_id = session_id.strip()
        if not session_id:
            return
        path = self.projects_root / "session-index.json"
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
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
