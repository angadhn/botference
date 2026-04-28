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


class SessionStore:
    def __init__(self, paths: BotferencePaths):
        self.paths = paths

    def save(self, session_id: str, payload: dict[str, Any]) -> None:
        _atomic_write_json(self.paths.session_state_file(session_id), payload)

    def load(self, session_id: str) -> dict[str, Any]:
        path = self.paths.session_state_file(session_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def delete(self, session_id: str) -> None:
        self.paths.session_state_file(session_id).unlink(missing_ok=True)

    def list_summaries(self, *, limit: int = 10, exclude_session_id: str = "") -> list[SessionSummary]:
        summaries: list[SessionSummary] = []
        for path in sorted(
            self.paths.session_dir.glob("*.json"),
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
            entry_count = _entry_count(payload)
            if entry_count < 1:
                continue
            summaries.append(SessionSummary(
                session_id=session_id,
                created_at=str(payload.get("created_at", "")),
                updated_at=str(payload.get("updated_at", "")),
                title=_display_title(payload),
                entry_count=entry_count,
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
