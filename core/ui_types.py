"""
ui_types.py — UI-facing data types shared by the controller and the Ink bridge.

These are plain dataclasses/enums with no rendering dependencies. The Ink TUI
receives them serialized as JSON-lines via botference_ink_bridge.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class RoomMode(str, Enum):
    PUBLIC = "public"
    DRAFT = "draft"
    REVIEW = "review"


@dataclass(frozen=True)
class StatusSnapshot:
    mode: RoomMode = RoomMode.PUBLIC
    lead: str = "auto"
    route: str = "@all"
    project: str = "Inbox"
    claude_percent: Optional[float] = None
    codex_percent: Optional[float] = None
    claude_tokens: Optional[int] = None
    claude_window: Optional[int] = None
    codex_tokens: Optional[int] = None
    codex_window: Optional[int] = None
    claude_model: Optional[str] = None
    codex_model: Optional[str] = None
    observe_enabled: bool = True


@dataclass(frozen=True)
class ProjectPanelSession:
    session_id: str
    title: str
    updated_at: str = ""
    active: bool = False


@dataclass(frozen=True)
class ProjectPanelProject:
    project_id: str
    title: str
    status: str = "active"
    next_action: str = ""
    active: bool = False
    session_count: int = 0
    sessions: tuple[ProjectPanelSession, ...] = ()


@dataclass(frozen=True)
class ProjectPanelState:
    projects: tuple[ProjectPanelProject, ...] = ()
    active_project_id: str = ""
    inbox_session_count: int = 0
