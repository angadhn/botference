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
    # Reasoning effort per participant, so a frontend can show (and offer)
    # the level each model is thinking at alongside the model itself.
    claude_effort: Optional[str] = None
    codex_effort: Optional[str] = None
    observe_enabled: bool = True
    auto_relay: bool = True
    # Relay provenance: when each model's session was last relayed and which
    # tier authored the handoff ("self"/"cross"/"mechanical"). None = never.
    claude_last_relay_at: Optional[str] = None
    claude_last_relay_tier: Optional[str] = None
    codex_last_relay_at: Optional[str] = None
    codex_last_relay_tier: Optional[str] = None


@dataclass(frozen=True)
class ProjectPanelSession:
    session_id: str
    title: str
    updated_at: str = ""
    active: bool = False


@dataclass(frozen=True)
class ProjectPanelTask:
    """One line of a project's curated projects/<id>/TASKS.md."""

    text: str
    done: bool = False


@dataclass(frozen=True)
class ProjectPanelProject:
    project_id: str
    title: str
    status: str = "active"
    next_action: str = ""
    active: bool = False
    session_count: int = 0
    sessions: tuple[ProjectPanelSession, ...] = ()
    tasks: tuple[ProjectPanelTask, ...] = ()
    #: Browsable URL of the private GitHub repo this project was pushed to,
    #: or "" when it has never been published (see /project github).
    github: str = ""


@dataclass(frozen=True)
class ProjectPanelState:
    projects: tuple[ProjectPanelProject, ...] = ()
    active_project_id: str = ""
    inbox_session_count: int = 0
    inbox_sessions: tuple[ProjectPanelSession, ...] = ()
