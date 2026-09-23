"""
botference.py — Controller for botference mode.

Command parsing, auto-routing, free-form handoffs, finalize flow,
transcript management, and mode tracking.  The Ink TUI talks to this
controller through botference_ink_bridge.py; this module is the
headless logic layer so it can be tested without a UI.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum
from typing import Any, Awaitable, Callable, Optional, Protocol

from cli_adapters import (
    AdapterResponse,
    ClaudeAdapter,
    ClaudeInteractiveTmuxAdapter,
    CodexAdapter,
    PlannerWriteConfig,
    ToolSummary,
    add_granted_network_host,
    granted_network_hosts,
    is_credit_error,
    normalize_claude_transport,
    normalize_write_roots,
    planner_write_config,
    planner_write_roots_for_env,
)
from paths import BotferencePaths
from project_github import preflight, publish_project, slugify_repo_name
from project_store import (
    TASKS_FILE_NAME,
    ProjectInfo,
    ProjectStore,
    read_project_tasks,
)
from user_settings import load_user_settings, save_user_setting
from ui_types import (
    ProjectPanelProject,
    ProjectPanelSession,
    ProjectPanelState,
    ProjectPanelTask,
    RoomMode,
    StatusSnapshot,
)
from room_prompts import (
    ROOM_ROLE_SUFFIX,
    WRITER_PREAMBLE,
    adopt_room_note,
    checkpoint_preamble,
    deliverables_note,
    finalize_plan_preamble,
    free_form_protocol,
    free_form_resume_note,
    free_form_turn_status,
    reviewer_preamble,
    revision_from_plan_preamble,
    project_tasks_note,
    recommendations_note,
    room_preamble,
    project_skill_context,
    quote_check_note,
    subagents_note,
    verification_preamble,
    VERIFICATION_BADGE,
    video_watch_note,
    lasso_note,
    web_access_note,
)
from datetime import datetime as _dt, timezone as _tz
from handoff import build_frontmatter, validate_handoff
from render_blocks import parse_render_blocks
import video_watch
import lasso
import summon
from session_store import (
    SessionStore,
    SessionSummary,
    StaleSessionWrite,
    _display_title,
    append_crash_log,
    iso_now,
)

log = logging.getLogger(__name__)


# ── Token display helpers ────────────────────────────────────

def _humanize_tokens(n: int) -> str:
    """Format token count for display: 1234567 → '1.2M', 45000 → '45.0K'."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _format_token_display(tokens: Optional[int], window: Optional[int]) -> str:
    """Format token count for status display: '45.0K / 1.0M' or '--'."""
    if tokens is None:
        return "--"
    t = _humanize_tokens(tokens)
    if window:
        return f"{t} / {_humanize_tokens(window)}"
    return t


def _format_window_percent(tokens: Optional[int], window: Optional[int]) -> str:
    """Format percentage of full context window for status display."""
    if tokens is None or not window:
        return "--"
    return f"~{tokens / window * 100:.0f}%"


# ── Attachment staging ─────────────────────────────────────

# Repo root — two levels up from core/
_REPO_ROOT = Path(__file__).resolve().parent.parent
_STAGING_DIR = _REPO_ROOT / ".botference" / "tmp" / "attachments"


def stage_attachments(attachments: list[dict]) -> tuple[list[str], list[str]]:
    """Copy attached files (images, PDFs, documents, text) to a repo-local staging dir.

    Returns (staged_paths, missing_paths). Staged names are
    content-addressed; Claude can read them with its Read tool — no
    --file flag or session token needed. Missing paths are returned so
    the caller can TELL the user — silently dropping them is how pastes
    used to reach the bots as bare "[image N]" placeholders.
    """
    if not attachments:
        return [], []
    _STAGING_DIR.mkdir(parents=True, exist_ok=True)

    staged: list[str] = []
    missing: list[str] = []
    for att in attachments:
        if att.get("type") not in ("image", "file"):
            continue
        src = Path(str(att["path"])).expanduser()
        if not src.is_file():
            log.warning("Attachment not found: %s", src)
            missing.append(str(src))
            continue
        # Content-addressed name: <sha256[:16]>.<ext>
        sha = hashlib.sha256(src.read_bytes()).hexdigest()[:16]
        ext = src.suffix or ".png"
        dst = _STAGING_DIR / f"{sha}{ext}"
        if not dst.exists():
            shutil.copy2(src, dst)
        staged.append(str(dst))
    return staged, missing


# ── Input parsing ──────────────────────────────────────────


class InputKind(Enum):
    MESSAGE = "message"
    PROJECTS = "projects"
    PROJECT = "project"
    ADOPT = "adopt"
    NEW = "new"
    FILE = "file"
    DELETE = "delete"
    ARCHIVE = "archive"
    UNARCHIVE = "unarchive"
    LEAD = "lead"
    DRAFT = "draft"
    FINALIZE = "finalize"
    PERMISSIONS = "permissions"
    STATUS = "status"
    NOTIFY = "notify"
    AGENTS = "agents"
    AUTH = "auth"
    HELP = "help"
    QUIT = "quit"
    RELAY = "relay"
    AUTORELAY = "autorelay"
    HARNESS_COMMAND = "harness_command"
    RESUME = "resume"
    RENAME = "rename"
    MODEL = "model"
    EFFORT = "effort"
    CURRENT = "current"
    ALLOW_HOST = "allow_host"
    WATCH = "watch"
    LASSO = "lasso"
    VERIFY = "verify"


@dataclass(frozen=True)
class ParsedInput:
    kind: InputKind
    body: str = ""      # message body or command argument
    target: str = ""    # "@claude", "@codex", "@all" for messages;
                        # "claude", "codex" for relay target
    parallel: bool = False  # /parallel: both bots take the prompt at once


_SLASH_COMMANDS = {
    "/projects": InputKind.PROJECTS,
    "/project": InputKind.PROJECT,
    "/adopt": InputKind.ADOPT,
    "/new": InputKind.NEW,
    "/file": InputKind.FILE,
    "/add-to-project": InputKind.FILE,
    "/delete": InputKind.DELETE,
    "/archive": InputKind.ARCHIVE,
    "/unarchive": InputKind.UNARCHIVE,
    "/lead": InputKind.LEAD,
    "/draft": InputKind.DRAFT,
    "/finalize": InputKind.FINALIZE,
    "/resume": InputKind.RESUME,
    "/rename": InputKind.RENAME,
    "/permissions": InputKind.PERMISSIONS,
    "/status": InputKind.STATUS,
    "/notify": InputKind.NOTIFY,
    "/autorelay": InputKind.AUTORELAY,
    "/agents": InputKind.AGENTS,
    "/auth": InputKind.AUTH,
    "/model": InputKind.MODEL,
    "/effort": InputKind.EFFORT,
    "/current-model": InputKind.CURRENT,
    "/current": InputKind.CURRENT,
    "/allow-host": InputKind.ALLOW_HOST,
    "/watch": InputKind.WATCH,
    "/lasso": InputKind.LASSO,
    "/verify": InputKind.VERIFY,
    "/parallel": InputKind.MESSAGE,
    "/help": InputKind.HELP,
    "/quit": InputKind.QUIT,
    "/exit": InputKind.QUIT,
}

_MENTION_RE = re.compile(
    r"^(@(?:claude|codex|all))\s*(.*)", re.IGNORECASE | re.DOTALL
)
# `/parallel` anywhere in a message — start, end or middle — lifts out and
# sends the rest to both bots at the same time, each seeing the history up
# to the prompt and not the other's reply to it.
_PARALLEL_RE = re.compile(r"(?:(?<=\s)|^)/parallel(?=\s|$)", re.IGNORECASE)

# Relay command patterns
_RELAY_HYPHEN_RE = re.compile(r"^/relay-(claude|codex|both)$", re.IGNORECASE)
_RELAY_TARGET_RE = re.compile(r"^@?(claude|codex|both|all)$", re.IGNORECASE)
_HARNESS_TARGET_RE = re.compile(
    r"^@?(claude|codex)(?:\s+(.*))?$", re.IGNORECASE | re.DOTALL
)

_SESSION_TITLE_MAX = 80
_CODEX_DIFF_PREVIEW_LIMIT = 120_000

# Commands that require a @target argument, expanded into @claude/@codex variants
_TARGETED_COMMANDS = (
    "/lead", "/relay", "/tag", "/model", "/effort", "/compact", "/goal",
)

# ── The command table: one place every /help and every autocomplete reads ──
#
# Each row is one command as a reader would look it up: `cmd` (what is typed
# first), `args` (the rest, in the usual <required> [optional] notation),
# `hint` (ONE short plain line — the browser popup and the plugin's
# autocomplete show only this), `scope` (where typing it does something:
# "tui" = the terminal, "council" = the council web page, "plugin" = the
# browser plugin's Discuss drawer), `group` (the heading it sits under) and
# optionally `aliases` and `detail` (extra lines the terminal's /help prints
# under the hint). The terminal /help, the council popup and the plugin
# popup/autocomplete are all rendered from this list, so they cannot drift.
#
# The plugin runs its own composer: what the reader types there is wrapped as
# a message about the page, so only the commands the drawer itself handles
# (the @mentions, /lasso, /help) carry the "plugin" scope.
_ALL = ("tui", "council")
_EVERYWHERE = ("tui", "council", "plugin")

COMMAND_HELP: list[dict] = [
    # Talking to the bots
    {"cmd": "@claude", "args": "<msg>", "group": "Talking to the bots",
     "hint": "Send to Claude only", "scope": _EVERYWHERE},
    {"cmd": "@codex", "args": "<msg>", "group": "Talking to the bots",
     "hint": "Send to Codex only", "scope": _EVERYWHERE},
    {"cmd": "@all", "args": "<msg>", "group": "Talking to the bots",
     "hint": "Send to both bots", "scope": _EVERYWHERE,
     "detail": ["A message with no tag goes to both first, then to whoever"
                " you last tagged"]},
    {"cmd": "/parallel", "args": "<prompt>", "group": "Talking to the bots",
     "hint": "Both answer at once, neither seeing the other's reply",
     # the plugin too: the controller lifts the word out of any message text
     "scope": ("tui", "council", "plugin"),
     "detail": ["The word may sit anywhere in the prompt."
                " No bot-to-bot thread follows"]},
    {"cmd": "/watch", "args": "<url> [question]", "group": "Talking to the bots",
     "hint": "Gemini watches a YouTube video and reports back",
     "scope": _ALL},
    {"cmd": "/lasso", "args": "<words|path|link>", "group": "Talking to the bots",
     "hint": "Find your pages, chats and files — or paste a link",
     "scope": _EVERYWHERE,
     "detail": [
         "/lasso <path> attaches a file of your own directly",
         "/lasso attach <n|all> | /lasso detach <n> | /lasso — take an offer,"
         " take one off, or list what this chat carries",
         "Attachments are files the bots read when they need them",
     ]},
    {"cmd": "/lead", "args": "@claude|@codex", "group": "Planning",
     "hint": "Choose who writes the plan", "scope": _ALL},
    {"cmd": "/draft", "args": "[rounds]", "group": "Planning",
     "hint": "Write implementation-plan.md, with review rounds (default 2)",
     "scope": _ALL},
    {"cmd": "/finalize", "args": "", "group": "Planning",
     "hint": "Answer review comments, write the final plan",
     "scope": _ALL},

    # Models
    {"cmd": "/model", "args": "[@claude|@codex <id>]", "group": "Models",
     "hint": "Show or change a bot's model", "scope": _ALL},
    {"cmd": "/effort", "args": "[@claude|@codex <level>]", "group": "Models",
     "hint": "Show or change how hard a bot thinks", "scope": _ALL,
     "detail": ["claude: low|medium|high|xhigh|max;"
                " codex: low|medium|high|xhigh|max|ultra"]},
    {"cmd": "/current-model", "args": "", "aliases": ["/current"], "group": "Models",
     "hint": "Show both models and effort levels", "scope": _ALL},
    {"cmd": "/status", "args": "", "group": "Models",
     "hint": "How full each bot's memory is, who leads, sessions",
     "scope": _ALL},
    {"cmd": "/relay", "args": "@claude|@codex|@both", "group": "Models",
     "aliases": ["/tag", "/relay-claude", "/relay-codex", "/relay-both"],
     "hint": "Restart a bot fresh, with a summary of the chat so far",
     "scope": _ALL,
     "detail": ["@both: one shared summary, both restart from it at once"]},
    {"cmd": "/autorelay", "args": "[on|off]", "group": "Models",
     "hint": "Restart a bot by itself at 50% memory (on by default)",
     "scope": _ALL},
    {"cmd": "/compact", "args": "@claude [instructions]", "group": "Models",
     "hint": "Claude Code's own /compact (needs --claude-interactive)",
     "scope": _ALL},
    {"cmd": "/goal", "args": "@claude <objective>", "group": "Models",
     "hint": "Claude Code's own /goal (needs --claude-interactive)",
     "scope": _ALL},
    {"cmd": "/auth", "args": "[claude|codex|all]", "group": "Models",
     "hint": "Check the bots are signed in", "scope": _ALL},

    # Chat
    {"cmd": "/new", "args": "[title]", "group": "Chat",
     "hint": "Start a fresh chat (this one is saved)", "scope": _ALL,
     "detail": ["/new --project <id> files it there; --inbox leaves it unfiled"]},
    {"cmd": "/resume", "args": "[latest|number|title|id]", "group": "Chat",
     "hint": "Switch to a saved chat, in any project", "scope": _ALL},
    {"cmd": "/rename", "args": "<name>", "group": "Chat",
     "hint": "Name this chat", "scope": _ALL},
    {"cmd": "/adopt", "args": "[<id-prefix>]", "group": "Chat",
     "hint": "Carry on a Claude Code chat from outside here", "scope": _ALL},
    {"cmd": "/file", "args": "[<project-id>]", "group": "Chat",
     "aliases": ["/add-to-project"],
     "hint": "File this chat under a project", "scope": _ALL},
    {"cmd": "/delete", "args": "[<id-prefix>]", "group": "Chat",
     "hint": "Delete a saved chat (asks first)", "scope": _ALL},
    {"cmd": "/archive", "args": "[<id-prefix>|list]", "group": "Chat",
     "hint": "Put a saved chat away (can be undone)", "scope": _ALL},
    {"cmd": "/unarchive", "args": "[<id-prefix>]", "group": "Chat",
     "hint": "Bring an archived chat back", "scope": _ALL},
    {"cmd": "/projects", "args": "", "group": "Projects",
     "hint": "List your projects", "scope": _ALL},
    {"cmd": "/project", "args": "[open <id>|clear|create <title>|…]", "group": "Projects",
     "hint": "Open, show, create or tidy projects", "scope": _ALL,
     "detail": [
         "/project open <id> | clear | current | create <title> | create-from-chat"
         " | activate-build",
         "/project assign [<chat-id>] <project-id> — file this chat or a saved one",
         "/project unfile [<chat-id>] — back to Inbox; nothing is deleted",
         "/project contents [<project-id>] — its chats and its folder",
         "/project github [<project-id>] [<repo>] — push the folder to a new"
         " private GitHub repo (asks first)",
         "/project archive <id> | /project unarchive <id> — tuck away or bring back",
     ]},

    # Settings
    {"cmd": "/verify", "args": "[on|off]", "group": "Settings",
     "hint": "When they agree, the other bot checks the sources", "scope": _ALL},
    {"cmd": "/agents", "args": "[on|off]", "group": "Settings",
     "hint": "Let Claude use helper agents (off by default)", "scope": _ALL},
    {"cmd": "/notify", "args": "[on|off]", "group": "Settings",
     "hint": "Desktop notice when the bots finish", "scope": _ALL},
    {"cmd": "/allow-host", "args": "[<domain>]", "group": "Settings",
     "hint": "Let the bots fetch from a website", "scope": _ALL},
    {"cmd": "/permissions", "args": "", "group": "Settings",
     "hint": "Where the bots may write files", "scope": _ALL},

    # Help
    {"cmd": "/help", "args": "", "group": "Help",
     "hint": "This list", "scope": _EVERYWHERE},
    {"cmd": "/quit", "args": "", "aliases": ["/exit"], "group": "Help",
     "hint": "Leave without writing files", "scope": ("tui",)},
]


def command_help(scope: str | None = None) -> list[dict]:
    """COMMAND_HELP as plain JSON-ready dicts, optionally only one scope's."""
    out = []
    for row in COMMAND_HELP:
        if scope and scope not in row["scope"]:
            continue
        item = {k: v for k, v in row.items() if k != "scope"}
        item["scope"] = list(row["scope"])
        out.append(item)
    return out


def render_command_help(scope: str = "tui") -> list[str]:
    """The /help text lines for one scope, grouped, from COMMAND_HELP."""
    lines: list[str] = []
    group = None
    for row in command_help(scope):
        if row["group"] != group:
            if group is not None:
                lines.append("")
            group = row["group"]
            lines.append(f"{group}:")
        head = row["cmd"] + (f" {row['args']}" if row["args"] else "")
        aliases = row.get("aliases") or []
        if aliases:
            head += f" (also {', '.join(aliases)})"
        if len(head) <= 22:
            lines.append(f"  {head:<22} — {row['hint']}")
        else:
            lines.append(f"  {head}")
            lines.append(f"  {'':<22} — {row['hint']}")
        for d in row.get("detail") or []:
            lines.append(f"  {'':<24} {d}")
    return lines


# /project subcommands, surfaced to autocomplete as scoped completions
_PROJECT_SUBCOMMANDS = (
    "open", "clear", "current", "create", "create-from-chat",
    "assign", "unfile", "contents", "github",
    "archive", "unarchive", "activate-build",
)

# Known effort levels (passed through to the underlying CLI)
# Claude Code: low/medium/high/xhigh/max (Opus 5.5 defaults to medium, the rest high).
# Codex (GPT-6 Sol/Astra): low/medium/high/xhigh/max/ultra; Luna and GPT-5.x have no ultra.
_CLAUDE_EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
_CODEX_EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max", "ultra")


def _known_claude_models() -> list[str]:
    """Claude model IDs from the CLI adapter context-window table."""
    from cli_adapters import _CONTEXT_WINDOWS
    return [m for m in _CONTEXT_WINDOWS if m.startswith("claude-")]


def _known_codex_models() -> list[str]:
    """Non-Claude (OpenAI) model IDs from the CLI adapter context-window table."""
    from cli_adapters import _CONTEXT_WINDOWS
    return [m for m in _CONTEXT_WINDOWS if not m.startswith("claude-")]


def get_completion_context() -> dict:
    """Completion metadata for TUI autosuggest.

    Returns {"global": [...], "scoped": {prefix: [options], ...}}.
    Global entries prefix-match the input. Scoped entries kick in when
    the input starts with the prefix key and substring-match the remainder
    against the option list.
    """
    return {
        "global": get_slash_commands(),
        # the command table itself, so the browser /help popups and the
        # plugin's autocomplete read the same rows the terminal /help does
        "commands": command_help(),
        "scoped": {
            "/project ": list(_PROJECT_SUBCOMMANDS),
            "/model @claude ": _known_claude_models(),
            "/model @codex ": _known_codex_models(),
            "/effort @claude ": list(_CLAUDE_EFFORT_LEVELS),
            "/effort @codex ": list(_CODEX_EFFORT_LEVELS),
        },
    }


def get_slash_commands() -> list[str]:
    """Canonical completion list for TUI autosuggest.

    Sourced from _SLASH_COMMANDS plus relay/tag aliases; targeted commands
    are expanded with @claude/@codex variants (matching the /lead pattern).
    Trailing spaces on @mentions signal that a message body follows.
    """
    out: list[str] = []
    for cmd in _TARGETED_COMMANDS:
        out.append(f"{cmd} @claude")
        out.append(f"{cmd} @codex")
        if cmd in ("/relay", "/tag"):
            out.append(f"{cmd} @both")
    for cmd in _SLASH_COMMANDS:
        if cmd in _TARGETED_COMMANDS:
            continue
        out.append(cmd)
    out.extend(["@claude ", "@codex ", "@all "])
    return out


def parse_input(raw: str) -> ParsedInput:
    """Parse raw user input into a structured command."""
    text = raw.strip()
    if not text:
        return ParsedInput(kind=InputKind.MESSAGE)

    if _PARALLEL_RE.search(text):
        rest = re.sub(r"\s{2,}", " ", _PARALLEL_RE.sub(" ", text)).strip()
        inner = parse_input(rest) if rest else ParsedInput(kind=InputKind.MESSAGE)
        if inner.kind is not InputKind.MESSAGE:
            # a slash command with /parallel in it is still that command
            return inner
        return ParsedInput(kind=InputKind.MESSAGE, body=inner.body,
                           target="@all", parallel=True)

    # Slash commands
    if text.startswith("/"):
        parts = text.split(None, 1)
        cmd = parts[0].lower()

        # Hyphenated relay aliases: /relay-claude, /relay-codex
        m = _RELAY_HYPHEN_RE.match(cmd)
        if m:
            return ParsedInput(kind=InputKind.RELAY, target=m.group(1).lower())

        # /relay and /tag with target argument
        if cmd in ("/relay", "/tag"):
            arg = parts[1].strip() if len(parts) > 1 else ""
            m = _RELAY_TARGET_RE.match(arg)
            if m:
                target = m.group(1).lower()
                if target == "all":
                    target = "both"
                return ParsedInput(kind=InputKind.RELAY, target=target)
            return ParsedInput(kind=InputKind.RELAY, target="", body=arg)

        # Native harness slash-command passthrough. Botference owns the target
        # selector; the live harness receives only its native command.
        if cmd in ("/compact", "/goal"):
            arg = parts[1].strip() if len(parts) > 1 else ""
            m = _HARNESS_TARGET_RE.match(arg)
            if m:
                target = m.group(1).lower()
                rest = (m.group(2) or "").strip()
                body = cmd if not rest else f"{cmd} {rest}"
                return ParsedInput(
                    kind=InputKind.HARNESS_COMMAND,
                    target=target,
                    body=body,
                )
            return ParsedInput(
                kind=InputKind.HARNESS_COMMAND,
                target="",
                body=f"{cmd} {arg}".strip(),
            )

        kind = _SLASH_COMMANDS.get(cmd)
        if kind is not None:
            return ParsedInput(kind=kind, body=parts[1] if len(parts) > 1 else "")
        return ParsedInput(kind=InputKind.MESSAGE, body=text)

    # @mentions
    m = _MENTION_RE.match(text)
    if m:
        return ParsedInput(
            kind=InputKind.MESSAGE,
            body=m.group(2).strip(),
            target=m.group(1).lower(),
        )

    return ParsedInput(kind=InputKind.MESSAGE, body=text)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _extract_write_access_request(text: str) -> tuple[str, str] | None:
    match = _WRITE_ACCESS_REQUEST_RE.match(text.strip())
    if not match:
        return None
    return match.group(1).strip(), match.group(2).strip()


# ── Auto-routing ───────────────────────────────────────────


class AutoRouter:
    """Track which model(s) plain text routes to.

    Rules (from plan):
    - First turn with no @mention → @all
    - After @all → stays @all until directed @claude or @codex
    - After @claude or @codex → plain text goes to that model
    """

    def __init__(self):
        self.current_route: str = "@all"
        self._had_first_turn: bool = False

    def resolve(self, parsed: ParsedInput) -> str:
        """Return "@claude", "@codex", or "@all"."""
        if parsed.target:
            self.current_route = parsed.target
            self._had_first_turn = True
            return parsed.target
        if not self._had_first_turn:
            self._had_first_turn = True
            return "@all"
        return self.current_route


# ── Transcript management ──────────────────────────────────


@dataclass
class TranscriptRecord:
    speaker: str                         # user | claude | codex | system
    text: str
    tool_summaries: list = field(default_factory=list)
    turn_index: int = 0


@dataclass
class DisplayRecord:
    speaker: str
    text: str
    #: Extra the frontends render from — today only the summoned agent's
    #: card: {"id", "card", "parent_stream_id", "summoned_by", "model",
    #: "effort", "label", "status", "elapsed_s", "brief"}. None otherwise.
    meta: Optional[dict] = None


# Bound relay/late-join backfill so a freshly (re)started model session cannot be
# handed a Room-History block large enough to overflow its context window. The
# handoff document already carries the durable summary; the backfill only needs the
# most-recent turns for continuity. Without this bound a relay could rebuild a
# prompt as large as the session that triggered it — the failure that wedged long
# sessions, where recovery itself overflowed.
_BACKFILL_MAX_CHARS = 60_000

# On resume, only this many room-history entries are replayed into the UI.
# The Ink side keeps a bounded display log anyway (older entries would be
# trimmed on arrival), so replaying more only slows resume down. The complete
# history remains in the session file and in self._room_history.
_REPLAY_MAX_ENTRIES = 2_000

# How many recent chats the project panel lists per project (every project,
# not just the active one — the sidebar browses any project without switching).
#
# This was 8, and 8 was a UI number pretending to be a payload number: the
# sidebar looked tidy, but a project with a dozen chats simply could not show
# you the older ones, and /resume from the web could not confirm a chat that
# had fallen off the shortlist (hence the active-session append below). The
# real constraint is that this whole snapshot is recomputed after every turn
# and broadcast to every attached tab, so it wants a bound — just a bound set
# by bytes rather than by taste. A row is ~100 bytes of JSON; 100 rows per
# project keeps a normal workspace's snapshot comfortably under ~100 KB while
# being, for any personal workspace, effectively no limit at all. The
# frontends scroll their own lists.
#
# BOTFERENCE_PANEL_SESSION_LIMIT overrides it; 0 (or negative) means truly
# unlimited, for anyone who would rather pay the bytes.
def _panel_session_limit_from_env(raw: str | None) -> int:
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return 100
    return value if value > 0 else 0


PANEL_SESSION_LIMIT = _panel_session_limit_from_env(
    os.environ.get("BOTFERENCE_PANEL_SESSION_LIMIT")
)


def _human_bytes(size: int) -> str:
    """1536 -> '1.5 KB'. For listings a person reads, not for arithmetic."""
    value = float(max(0, int(size)))
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            if unit == "B":
                return f"{int(value)} B"
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"  # pragma: no cover - loop always returns


def _take_tail_within_budget(blocks: list[str], max_chars: int) -> tuple[list[str], int]:
    """Keep the most-recent blocks whose combined length fits *max_chars*.

    Returns ``(kept_in_original_order, num_elided_from_front)``. At least the
    single most-recent block is always kept, even if it alone exceeds the budget.
    """
    if max_chars <= 0 or not blocks:
        return list(blocks), 0
    kept: list[str] = []
    total = 0
    for block in reversed(blocks):
        total += len(block) + 1
        if kept and total > max_chars:
            break
        kept.append(block)
    kept.reverse()
    return kept, len(blocks) - len(kept)


class Transcript:
    """Shared room transcript with cross-model context injection."""

    def __init__(self):
        self.entries: list[TranscriptRecord] = []
        self._counter: int = 0
        self._last_seen: dict[str, int] = {}   # model → turn_index

    def add(self, speaker: str, text: str,
            tool_summaries: list | None = None) -> TranscriptRecord:
        rec = TranscriptRecord(
            speaker=speaker, text=text,
            tool_summaries=tool_summaries or [],
            turn_index=self._counter,
        )
        self._counter += 1
        self.entries.append(rec)
        return rec

    def mark_seen(self, model: str) -> None:
        if self.entries:
            self._last_seen[model] = self.entries[-1].turn_index

    def mark_seen_through(self, model: str, turn_index: int) -> None:
        """Seen up to *turn_index* only — what a /parallel round needs.

        Both bots answered the same prompt without seeing each other, so
        each is marked as having seen the prompt and nothing after it; the
        other's reply reaches it on its next turn as an ordinary update.
        """
        self._last_seen[model] = turn_index

    def last_turn_index(self) -> int:
        return self.entries[-1].turn_index if self.entries else -1

    def _entry_block(self, e) -> str:
        """Format one transcript entry as a backfill block (text + tool previews)."""
        label = {"user": "User", "claude": "Claude",
                 "codex": "Codex", "system": "System"}.get(e.speaker, e.speaker)
        lines = [f"[{label} said:]", e.text]
        if e.tool_summaries:
            lines.append(f"\n[{label} explored:]")
            for ts in e.tool_summaries:
                out = f" -> {ts.output_preview}" if ts.output_preview else ""
                lines.append(f"- {ts.name}({ts.input_preview}){out}")
        lines.append("")
        return "\n".join(lines)

    def context_since(self, model: str, user_message: str,
                      max_chars: int = _BACKFILL_MAX_CHARS) -> str:
        """Build context injection for *model* covering everything unseen.

        History is bounded to the most-recent ``max_chars`` so a late-joining or
        relayed session cannot be handed a backfill large enough to overflow.
        """
        last = self._last_seen.get(model, -1)
        unseen = [e for e in self.entries
                  if e.turn_index > last and e.speaker != model]

        parts: list[str] = []
        if unseen:
            kept, elided = _take_tail_within_budget(
                [self._entry_block(e) for e in unseen], max_chars)
            header = "[Room update since your last response]\n"
            if elided:
                header += (f"[… {elided} earlier update(s) elided to fit "
                           "context …]\n")
            parts.append(header)
            parts.extend(kept)

        if user_message:
            parts.append("[User says:]")
            parts.append(user_message)

        parts.append(ROOM_ROLE_SUFFIX)
        return "\n".join(parts)

    def context_after(self, after_turn: int,
                      max_chars: int = _BACKFILL_MAX_CHARS) -> str:
        """Build backfill covering entries after a specific turn index.

        Bounded to the most-recent ``max_chars`` (see :meth:`context_since`).
        """
        entries = [e for e in self.entries if e.turn_index > after_turn]

        parts: list[str] = []
        if entries:
            kept, elided = _take_tail_within_budget(
                [self._entry_block(e) for e in entries], max_chars)
            header = "[Room history since relay]\n"
            if elided:
                header += (f"[… {elided} earlier "
                           f"entr{'y' if elided == 1 else 'ies'} elided to fit "
                           "context …]\n")
            parts.append(header)
            parts.extend(kept)

        parts.append(ROOM_ROLE_SUFFIX)
        return "\n".join(parts)


_VISUAL_VERIFICATION_SUMMARY_TOKENS = (
    "check_figure",
    "compile_latex",
    "latexmk",
    "page.screenshot",
    "pdflatex",
    "playwright",
    "puppeteer",
    "tectonic",
    "view_pdf_page",
    "visual_check_html",
)


def _tool_summary_is_verification_step(ts: ToolSummary) -> bool:
    text = "\n".join([ts.name, ts.input_preview, ts.output_preview]).lower()
    return any(token in text for token in _VISUAL_VERIFICATION_SUMMARY_TOKENS)


def _tool_summary_display_text(tool_summaries: list) -> str:
    """Collapse a tool run into a short human-readable summary block."""
    if not tool_summaries:
        return ""

    def _extract_arg(preview: str, key: str) -> str:
        if not preview:
            return ""
        try:
            parsed = json.loads(preview)
            if isinstance(parsed, dict):
                value = parsed.get(key, "")
                return str(value).strip()
        except Exception:
            pass
        match = re.search(rf'"{re.escape(key)}"\s*:\s*"([^"]+)"', preview)
        return match.group(1).strip() if match else ""

    def _clean_shell_command(command: str) -> str:
        cmd = command.strip()
        shell_match = re.match(r"^(?:/bin/\S+|\S+)\s+-lc\s+(.+)$", cmd)
        if shell_match:
            cmd = shell_match.group(1).strip()
        if len(cmd) >= 2 and cmd[0] == cmd[-1] and cmd[0] in ("'", '"'):
            cmd = cmd[1:-1]
        return cmd if len(cmd) <= 72 else cmd[:72] + "..."

    def _display_path(path_str: str) -> str:
        if not path_str:
            return ""
        try:
            return Path(path_str).name or path_str
        except Exception:
            return path_str

    def _summarize_tool(ts: ToolSummary) -> str:
        name = ts.name.strip()
        preview = ts.input_preview.strip()

        if name == "Read":
            file_path = _extract_arg(preview, "file_path")
            return f"Read {_display_path(file_path)}" if file_path else "Read file"

        if name == "Glob":
            pattern = _extract_arg(preview, "pattern")
            return f"Glob {pattern}" if pattern else "Glob files"

        if name == "Grep":
            pattern = _extract_arg(preview, "pattern")
            path_str = _extract_arg(preview, "path")
            if pattern and path_str:
                return f"Search {pattern} in {_display_path(path_str)}"
            if pattern:
                return f"Search {pattern}"
            return "Search files"

        if name == "WebSearch":
            query = _extract_arg(preview, "query")
            return f"Search web for {query}" if query else "Search web"

        if name == "WebFetch":
            url = _extract_arg(preview, "url")
            return f"Fetch {url}" if url else "Fetch page"

        if name == "Bash":
            command = _extract_arg(preview, "command")
            return f"Shell {_clean_shell_command(command)}" if command else "Shell command"

        if name in {"Edit", "MultiEdit"}:
            file_path = _extract_arg(preview, "file_path")
            return f"Edit {_display_path(file_path)}" if file_path else "Edit file"

        if name == "Write":
            file_path = _extract_arg(preview, "file_path")
            return f"Write {_display_path(file_path)}" if file_path else "Write file"

        if name == "Diff":
            return "Show file changes"

        if preview and preview != "(running)":
            return f"{name} {preview}"

        return f"Shell {_clean_shell_command(name)}"

    lines = ["Explored"]
    for idx, ts in enumerate(tool_summaries):
        branch = "└" if idx == len(tool_summaries) - 1 else "├"
        summary = _summarize_tool(ts)
        if _tool_summary_is_verification_step(ts):
            summary = f"[verify] {summary}"
        lines.append(f"{branch} {summary}")
    return "\n".join(lines)


def _tool_summary_display_blocks(tool_summaries: list) -> list[dict]:
    text_blocks = parse_render_blocks(_tool_summary_display_text(tool_summaries))
    output_blocks: list[dict] = []
    for ts in tool_summaries:
        output_blocks.extend(getattr(ts, "output_blocks", []) or [])
    return text_blocks + output_blocks


_VISUAL_ARTIFACT_EXTENSIONS = {
    ".css",
    ".gif",
    ".htm",
    ".html",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".svg",
    ".tex",
    ".webp",
}
_HTML_ARTIFACT_EXTENSIONS = {".htm", ".html"}
_LATEX_ARTIFACT_EXTENSIONS = {".tex"}
_IMAGE_OR_PDF_ARTIFACT_EXTENSIONS = {
    ".gif",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".svg",
    ".webp",
}
_MUTATING_VISUAL_TOOL_NAMES = {
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Patch",
    "Write",
    "create_file",
    "update_file",
}
_SHELL_VISUAL_WRITE_TOKENS = (
    ">",
    "cat ",
    "cp ",
    "latexmk",
    "matplotlib",
    "mv ",
    "pdflatex",
    "plotly",
    "savefig",
    "sips ",
    "tee ",
    "tectonic",
    "write_image",
)
_HTML_VERIFY_TOKENS = (
    "visual_check_html",
    "page.screenshot",
    "playwright",
    "puppeteer",
)
_LATEX_COMPILE_TOKENS = (
    "compile_latex",
    "latexmk",
    "pdflatex",
    "tectonic",
)
_PDF_VISUAL_TOKENS = (
    "view_pdf_page",
    "pdftoppm",
    "screenshot",
)
_STATIC_VISUAL_TOKENS = (
    "check_figure",
    "page.screenshot",
    "playwright",
    "visual_check_html",
    "view_pdf_page",
)
_COMPLETION_CLAIM_RE = re.compile(
    r"\b(done|fixed|ready|this works|verified|complete|completed)\b",
    re.IGNORECASE,
)
_VISUAL_PATH_RE = re.compile(
    r"(?P<path>(?:~|\.{1,2}|/)?[A-Za-z0-9_./:@%+= -]+"
    r"\.(?:css|gif|html?|jpe?g|pdf|png|svg|tex|webp))"
)


def _tool_preview_arg(preview: str, key: str) -> str:
    if not preview:
        return ""
    try:
        parsed = json.loads(preview)
        if isinstance(parsed, dict):
            value = parsed.get(key, "")
            return str(value).strip()
    except Exception:
        pass
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"([^"]+)"', preview)
    return match.group(1).strip() if match else ""


def _tool_summary_text(ts: ToolSummary) -> str:
    parts = [ts.name, ts.input_preview, ts.output_preview]
    for block in ts.output_blocks + ts.pending_output_blocks:
        if not isinstance(block, dict):
            continue
        for key in ("text", "content", "code", "body", "line", "lines"):
            value = block.get(key)
            if isinstance(value, str):
                parts.append(value)
            elif isinstance(value, list):
                parts.extend(str(item) for item in value)
    return "\n".join(part for part in parts if part)


def _is_visual_path(path_str: str) -> bool:
    clean = path_str.strip().strip("'\"`")
    return Path(clean).suffix.lower() in _VISUAL_ARTIFACT_EXTENSIONS


def _normalize_visual_path(path_str: str) -> str:
    clean = path_str.strip().strip("'\"`,)")
    if clean.startswith("diff --git "):
        parts = clean.split()
        if len(parts) >= 3:
            clean = parts[2]
    elif clean.startswith("--- ") or clean.startswith("+++ "):
        parts = clean.split()
        if len(parts) >= 2:
            clean = parts[1]
    if clean.startswith(("a/", "b/")):
        clean = clean[2:]
    return clean


def _visual_paths_in_text(text: str) -> set[str]:
    paths: set[str] = set()
    for match in _VISUAL_PATH_RE.finditer(text or ""):
        path_str = _normalize_visual_path(match.group("path"))
        if _is_visual_path(path_str):
            paths.add(path_str)
    return paths


def _summary_mutates_visual_artifacts(ts: ToolSummary) -> bool:
    name = ts.name.strip()
    if name == "Diff":
        return True
    if name in _MUTATING_VISUAL_TOOL_NAMES:
        return True
    if name.lower() in {"bash", "shell", "exec_command"}:
        text = _tool_summary_text(ts).lower()
        return any(token in text for token in _SHELL_VISUAL_WRITE_TOKENS)
    return False


def _visual_artifacts_from_tool_summaries(tool_summaries: list[ToolSummary]) -> list[str]:
    artifacts: set[str] = set()
    for ts in tool_summaries:
        if not _summary_mutates_visual_artifacts(ts):
            continue
        for key in ("file_path", "path", "html_file", "output_file"):
            value = _tool_preview_arg(ts.input_preview, key)
            if value and _is_visual_path(value):
                artifacts.add(value)
        artifacts.update(_visual_paths_in_text(_tool_summary_text(ts)))
    return sorted(artifacts)


def _visual_verification_warning(model: str, resp: AdapterResponse) -> str:
    artifacts = _visual_artifacts_from_tool_summaries(resp.tool_summaries)
    if not artifacts:
        return ""

    lower_tool_text = "\n".join(
        _tool_summary_text(ts).lower() for ts in resp.tool_summaries
    )
    html_artifacts = [
        path for path in artifacts
        if Path(path).suffix.lower() in _HTML_ARTIFACT_EXTENSIONS
    ]
    latex_artifacts = [
        path for path in artifacts
        if Path(path).suffix.lower() in _LATEX_ARTIFACT_EXTENSIONS
    ]
    static_artifacts = [
        path for path in artifacts
        if Path(path).suffix.lower() in _IMAGE_OR_PDF_ARTIFACT_EXTENSIONS
    ]

    missing: list[str] = []
    if html_artifacts and not any(token in lower_tool_text for token in _HTML_VERIFY_TOKENS):
        missing.append("HTML/browser render check (`visual_check_html` or Playwright screenshot)")
    if latex_artifacts:
        compiled = any(token in lower_tool_text for token in _LATEX_COMPILE_TOKENS)
        inspected = any(token in lower_tool_text for token in _PDF_VISUAL_TOKENS)
        if not compiled or not inspected:
            missing.append(
                "LaTeX PDF verification (`compile_latex`/pdflatex plus `view_pdf_page` or screenshot)"
            )
    if static_artifacts and not any(token in lower_tool_text for token in _STATIC_VISUAL_TOKENS):
        missing.append("static figure/PDF visual inspection (`check_figure`, `view_pdf_page`, or screenshot)")
    if "playwright-missing" in lower_tool_text:
        missing.append("working browser dependency; Playwright was reported missing")

    if not missing:
        return ""

    artifact_text = ", ".join(artifacts[:6])
    if len(artifacts) > 6:
        artifact_text += f", and {len(artifacts) - 6} more"
    claim_note = (
        " Completion claim rejected."
        if _COMPLETION_CLAIM_RE.search(resp.text or "")
        else ""
    )
    required = "; ".join(dict.fromkeys(missing))
    return (
        f"Visual verification gate: {model.capitalize()} changed/generated rendered "
        f"artifact(s): {artifact_text}. Status: User-review needed.{claim_note} "
        f"Required before calling this done: {required}. For `.tex` files, the PDF "
        "is the rendered artifact, so compile it and inspect the PDF output."
    )


# ── Free-form room footer ─────────────────────────────────

_FOOTER_FENCED_RE = re.compile(
    r"```(?:json)?\s*(\{[^`]*\})\s*```\s*$", re.DOTALL
)
_FOOTER_RAW_RE = re.compile(
    r'(\{[^{]*"status"[^}]*\})\s*$', re.DOTALL
)

_FF_MENTION_RE = re.compile(r"@(claude|codex|user)\b", re.IGNORECASE)


@dataclass(frozen=True)
class RoomFooter:
    status: str    # continuing | converged | blocked
    next: str      # @claude | @codex | @user | ""
    summary: str
    writer: str = ""   # @claude | @codex | "" — vote for who drafts the plan

    @classmethod
    def parse(cls, text: str) -> Optional["RoomFooter"]:
        """Extract the free-form JSON footer from model response text."""
        for regex in (_FOOTER_FENCED_RE, _FOOTER_RAW_RE):
            m = regex.search(text)
            if m:
                try:
                    d = json.loads(m.group(1))
                except json.JSONDecodeError:
                    continue
                if "status" in d and "next" in d:
                    return cls(
                        status=str(d.get("status", "continuing")),
                        next=str(d.get("next", "")),
                        summary=str(d.get("summary", "")),
                        writer=str(d.get("writer", "")),
                    )
        return None

    @classmethod
    def strip_footer(cls, text: str) -> str:
        """Return *text* with the JSON footer removed."""
        for regex in (_FOOTER_FENCED_RE, _FOOTER_RAW_RE):
            cleaned = regex.sub("", text).rstrip()
            if cleaned != text.rstrip():
                return cleaned
        return text


def free_form_next_target(speaker: str, text: str) -> Optional[str]:
    """Decide who (if anyone) gets the floor after *speaker*'s reply.

    Returns "claude"/"codex" to dispatch the other bot, "user" for an
    explicit handoff to the user, or None when the reply carries no
    handoff (floor returns to the user silently).

    Routing prefers the structured footer; prose @mentions of the other
    participant are the fallback so a forgotten footer degrades to a
    working handoff instead of a dead thread.
    """
    other = "codex" if speaker == "claude" else "claude"
    footer = RoomFooter.parse(text)
    if footer is not None:
        nxt = footer.next.lstrip("@").lower()
        if nxt == other:
            return other
        if nxt == "user":
            return "user"
        return None  # self-handoff or empty → floor opens
    mentions = {m.lower() for m in _FF_MENTION_RE.findall(text)}
    if other in mentions:
        return other
    if "user" in mentions:
        return "user"
    return None


# ── Native Claude Code session discovery (/adopt) ─────────


@dataclass(frozen=True)
class NativeClaudeSession:
    session_id: str
    mtime: float
    snippet: str


def _native_session_snippet(path: Path) -> str:
    """First real user message in a native Claude Code session log."""
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("type") != "user" or event.get("isSidechain"):
                    continue
                message = event.get("message") or {}
                content = message.get("content")
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            text = str(part.get("text", ""))
                            break
                text = " ".join(text.split())
                # Skip harness wrappers (slash-command echoes, caveats).
                if text and not text.startswith("<"):
                    return text
    except OSError:
        pass
    return ""


def list_native_claude_sessions(
    projects_dir: Path, *, limit: int = 8,
) -> list[NativeClaudeSession]:
    """Recent native Claude Code chats under ~/.claude/projects/<cwd-slug>/."""
    if not projects_dir.is_dir():
        return []
    files = sorted(
        projects_dir.glob("*.jsonl"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    sessions: list[NativeClaudeSession] = []
    for path in files:
        snippet = _native_session_snippet(path)
        if not snippet:
            continue  # empty or unparseable chat — nothing to adopt
        sessions.append(NativeClaudeSession(
            session_id=path.stem,
            mtime=path.stat().st_mtime,
            snippet=snippet,
        ))
        if len(sessions) >= limit:
            break
    return sessions


def _age_label(mtime: float, now: Optional[float] = None) -> str:
    """Compact age for picker rows, e.g. "5m", "3h", "2d"."""
    import time as _time
    seconds = max(0, int((now if now is not None else _time.time()) - mtime))
    if seconds < 60:
        return "now"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


# ── UI callback protocol ──────────────────────────────────


class UIPort(Protocol):
    """Minimal interface the controller needs from the TUI."""
    def add_room_entry(
        self, speaker: str, text: str, blocks: Optional[list[dict]] = None,
    ) -> None: ...
    def set_status(self, status: StatusSnapshot) -> None: ...
    def set_projects(self, state: ProjectPanelState) -> None: ...
    # Optional (frontends that draw a Gemini indicator implement it; the
    # controller calls it defensively, so an older UI simply misses out).
    # def video_watch(self, event: dict) -> None: ...
    def set_mode(self, mode: RoomMode) -> None: ...
    def clear_panes(self) -> None: ...
    async def request_write_permission(
        self, request: "WritePermissionRequest",
    ) -> bool: ...
    async def request_choice(
        self, prompt: str, options: list[str],
    ) -> Optional[int]: ...


@dataclass(frozen=True)
class WritePermissionRequest:
    request_id: str
    model: str
    path: str
    reason: str


_WRITE_ACCESS_REQUEST_RE = re.compile(
    r'^\s*<write-access-request\s+path="([^"\n]+)"\s+reason="([^"\n]+)"\s*/>\s*$',
    re.IGNORECASE,
)

def _strip_response_frontmatter(text: str) -> str:
    """Strip any YAML frontmatter a model may have included in its response."""
    m = re.match(r"\A---[ \t]*\n.*?\n---[ \t]*\n", text, re.DOTALL)
    return text[m.end():] if m else text


def _clean_session_title(text: str) -> str:
    """Normalize a user-facing session title for storage and matching."""
    title = " ".join(text.split()).strip()
    return title[:_SESSION_TITLE_MAX]


def _project_title_from_session_title(title: str) -> str:
    cleaned = _clean_session_title(title)
    if not cleaned or cleaned == "Untitled session":
        return "Untitled Project"
    cleaned = re.sub(r"^[/@]\S+\s*", "", cleaned).strip()
    return cleaned or "Untitled Project"


@dataclass(frozen=True)
class WorktreeDiffSnapshot:
    diff_text: str
    untracked_files: frozenset[str]


def _run_git_text(project_root: Path, args: list[str]) -> str:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=project_root,
            check=False,
            capture_output=True,
            text=True,
        )
    except (OSError, ValueError):
        return ""
    return proc.stdout if proc.returncode in (0, 1) else ""


def _worktree_diff_snapshot(project_root: Path) -> WorktreeDiffSnapshot:
    diff_text = _run_git_text(
        project_root,
        ["diff", "--no-ext-diff", "--no-color", "--unified=80", "--"],
    )
    raw_untracked = _run_git_text(
        project_root,
        ["ls-files", "--others", "--exclude-standard", "-z"],
    )
    untracked = frozenset(path for path in raw_untracked.split("\0") if path)
    return WorktreeDiffSnapshot(diff_text=diff_text, untracked_files=untracked)


def _untracked_file_diff(project_root: Path, rel_path: str) -> str:
    path = project_root / rel_path
    if not path.is_file():
        return ""
    try:
        if path.stat().st_size > _CODEX_DIFF_PREVIEW_LIMIT:
            return ""
    except OSError:
        return ""
    return _run_git_text(
        project_root,
        [
            "diff",
            "--no-index",
            "--no-color",
            "--unified=80",
            "--",
            "/dev/null",
            rel_path,
        ],
    )


def _codex_worktree_diff_blocks(
    project_root: Path,
    before: WorktreeDiffSnapshot,
) -> list[dict]:
    after = _worktree_diff_snapshot(project_root)
    diff_parts: list[str] = []
    if after.diff_text and after.diff_text != before.diff_text:
        diff_parts.append(after.diff_text)

    new_untracked = sorted(after.untracked_files - before.untracked_files)
    for rel_path in new_untracked:
        text = _untracked_file_diff(project_root, rel_path)
        if text:
            diff_parts.append(text)

    if not diff_parts:
        return []

    diff_text = "\n".join(part.strip("\n") for part in diff_parts)
    if len(diff_text) > _CODEX_DIFF_PREVIEW_LIMIT:
        diff_text = (
            diff_text[:_CODEX_DIFF_PREVIEW_LIMIT]
            + "\n[diff preview truncated]"
        )
    return parse_render_blocks(diff_text)



# ── Botference controller ────────────────────────────────────


# Free-form mode: bot-to-bot thread budgets. Exhaustion never kills the
# thread — it forces the floor back to the user, who can say "continue".
_FREE_FORM_MAX_BOT_TURNS = 6          # bot turns per thread before handoff
_FREE_FORM_OUTPUT_TOKEN_BUDGET = 8_000  # output tokens per thread
_FREE_FORM_EXTENSION_TURNS = 3        # one automatic extension, then handoff
_FREE_FORM_EXTENSION_TOKENS = 4_000
_FREE_FORM_TURN_NUDGE_TOKENS = 400    # per-turn size above which we nudge

_RELAY_USAGE = (
    "Usage: /relay @claude|@codex|@both  "
    "(aliases: /relay-claude, /relay-both, /tag @claude)"
)
_HARNESS_COMMAND_USAGE = (
    "Usage: /compact @claude [instructions] or /goal @claude <objective>. "
    "Native passthrough requires --claude-interactive."
)

# Relay tier thresholds (yield-pressure percent from adapter.context_percent)
RELAY_TIER_SELF_MAX = 70       # < 70%: self-authored handoff
RELAY_TIER_CROSS_MAX = 90      # 70–89%: cross-authored handoff
                                # >= 90%: mechanical handoff

# Mechanical handoff: how many transcript entries from the tail to scan
_MECHANICAL_TAIL_ENTRIES = 20

# Auto-relay: occupancy (% of the raw context window) at which a model is
# automatically relayed with a handoff. Same machinery as manual /relay, but
# triggered on crossing this threshold rather than by command. Deferred until
# the current round/thread completes so a relay never lands mid-turn.
AUTO_RELAY_THRESHOLD_PCT = 50


class Botference:
    """Main controller: command dispatch, routing, free-form threads, finalize."""

    def __init__(
        self,
        claude: ClaudeAdapter,
        codex: CodexAdapter,
        system_prompt: str,
        task: str,
        paths: Optional[BotferencePaths] = None,
        plan_write_roots: Optional[list[str | Path]] = None,
    ):
        self.claude = claude
        self.codex = codex
        # Optional callback set by the UI layer: returns True when the user
        # has queued input, so a free-form thread yields the floor early.
        self.pending_input_check: Optional[Callable[[], bool]] = None
        self._ff_last_output_tokens: dict[str, int] = {}
        self.system_prompt = system_prompt
        self.task = task
        self.paths = paths or BotferencePaths.resolve()
        self.session_store = SessionStore(self.paths)
        self.project_store = ProjectStore(self.paths.project_root)
        # Two different questions, deliberately two different fields:
        #
        #   active_project_id — the LENS. Which project's plan/checkpoint
        #       files this room writes to, which project the panel highlights,
        #       what /resume is scoped to. Moves as you browse.
        #   session_project_id — the FILING. Which project THIS chat belongs
        #       to. Set once, by an explicit act (/file, /project assign,
        #       /project open, filed-at-creation), and never inferred again.
        #
        # They used to be one field, and _persist_session stamped the lens
        # into the payload on every save. That meant whatever project happened
        # to be active when a save fired silently re-filed the chat — chats
        # hopped projects behind the user's back, and a stale tab holding an
        # old lens could re-file a chat it wasn't even showing. Saving must
        # never be an act of filing; that is the whole point of the split.
        self.active_project_id: str = ""
        self.session_project_id: str = ""
        # "Inbox" said out loud rather than by omission — /project clear, or
        # /new --inbox. The first-message "where should this go?" prompt is
        # for chats nobody has decided about; re-asking someone who just
        # answered is how a helpful nudge turns into nagging.
        self._inbox_by_choice: bool = False
        # THE VERIFICATION TURN (adversarial review, 2026-09-22). When the bots
        # mark the thread converged, one extra turn runs before the floor comes
        # back: the OTHER bot checks the final claims against the sources the
        # room has, with the discussion left out of the envelope. On by default,
        # per chat, because agreement between two bots reasoning from one
        # context is the failure it exists to catch — and it costs one turn.
        self.verify_enabled: bool = True
        self.session_id = str(uuid.uuid4())
        self.created_at = iso_now()
        self.updated_at = self.created_at
        self.custom_title: str = ""

        self.transcript = Transcript()
        # (entry count, title) at last persist — persists that change neither
        # leave updated_at alone (see _persist_session)
        self._persisted_activity: tuple[int, str] = (0, "")
        self.router = AutoRouter()
        self.mode = RoomMode.PUBLIC
        self.lead: str = "auto"
        self.observe: bool = True
        # Desktop notification on turn completion — a user preference, not
        # chat state, so it persists globally rather than per-session.
        self.notify: bool = bool(load_user_settings().get("notify", True))
        # Auto-relay is a user preference (global, like notify); the pending/armed
        # bookkeeping below is per-session chat state (persisted with the session).
        self.auto_relay: bool = bool(load_user_settings().get("auto_relay", True))
        self._room_history: list[DisplayRecord] = []
        self._ff_writer_votes: dict[str, str] = {}  # model → "claude"/"codex" writer vote
        # Said once per chat, so a keyless user is told, not nagged.
        self._video_no_key_told: bool = False
        # The last video watched in this chat — what `ask gemini:` is about.
        self._last_watched_url: str = ""
        # model -> questions put to Gemini during the current user turn.
        self._gemini_asks: dict[str, int] = {}
        # model -> build agents summoned during the current user turn
        # (core/summon.py); reset with _gemini_asks.
        self._summons: dict[str, int] = {}
        self._summon_seq: int = 0
        # ---- lasso (core/lasso.py) ------------------------------------
        # What this chat has had brought INTO it: past discussions, pages the
        # user annotated in the browser, papers out of their own folders. Each
        # row is {kind, id, title, path, summary, at} and the envelope names it
        # by PATH on every turn — the contents are a file the bots read, never
        # something inlined into the conversation.
        self._attachments: list[dict] = []
        # …and the OFFERS behind the last card, so "attach 2" means the second
        # row the user is actually looking at. Not persisted: a search is not a
        # fact about anything, and a card from three days ago is not a menu.
        self._lasso_offer: list[dict] = []
        self._lasso_query: str = ""
        self._restoring_session: bool = False

        self._claude_pct: Optional[float] = None
        self._codex_pct: Optional[float] = None
        self._claude_tokens: Optional[int] = None
        self._claude_window: Optional[int] = None
        self._codex_tokens: Optional[int] = None
        self._codex_window: Optional[int] = None
        self._models_initialized: set[str] = set()
        self._warned_overlimit_models: set[str] = set()
        self._yield_pressure: dict[str, float] = {}   # model → normalized yield pressure (100 = yield now)
        self._relay_boundary: dict[str, int] = {}      # model → transcript turn_index at relay point
        self._last_relay: dict[str, dict[str, str]] = {}  # model → {"at": iso, "tier": tier} provenance
        self._pending_relay_handoffs: dict[str, str] = {}  # model → in-process one-shot relay bootstrap
        self._pending_auto_relay: set[str] = set()      # models due an auto-relay before their next turn
        self._auto_relay_armed: dict[str, bool] = {}    # model → armed; absent means armed (re-arms below threshold)
        self._quit_requested: bool = False
        self._stream_seq: int = 0
        self._active_steer_model: str = ""  # model whose room turn is in flight
        roots = plan_write_roots
        if roots is None:
            roots = planner_write_roots_for_env(
                self.paths.project_root,
                self.paths.work_dir,
                mode="plan",
            )
        self._base_plan_write_roots = normalize_write_roots(list(roots))
        self._granted_plan_write_roots: list[Path] = []
        self._apply_planner_write_config()
        self._persist_session()

    @property
    def quit_requested(self) -> bool:
        return self._quit_requested

    def status_snapshot(self) -> StatusSnapshot:
        return StatusSnapshot(
            mode=self.mode,
            lead=self.lead,
            route=self.router.current_route,
            project=self._active_project_label(),
            claude_percent=self._claude_pct,
            codex_percent=self._codex_pct,
            claude_tokens=self._claude_tokens,
            claude_window=self._claude_window,
            codex_tokens=self._codex_tokens,
            codex_window=self._codex_window,
            claude_model=getattr(self.claude, "model", None),
            codex_model=getattr(self.codex, "model", None),
            claude_effort=getattr(self.claude, "effort", None),
            codex_effort=getattr(self.codex, "reasoning_effort", None),
            observe_enabled=self.observe,
            auto_relay=self.auto_relay,
            claude_last_relay_at=self._last_relay.get("claude", {}).get("at") or None,
            claude_last_relay_tier=self._last_relay.get("claude", {}).get("tier") or None,
            codex_last_relay_at=self._last_relay.get("codex", {}).get("at") or None,
            codex_last_relay_tier=self._last_relay.get("codex", {}).get("tier") or None,
        )

    @property
    def _plan_path(self) -> Path:
        return self._planning_scope_root() / "implementation-plan.md"

    @property
    def _checkpoint_path(self) -> Path:
        return self._planning_scope_root() / "checkpoint.md"

    # ── per-session scratch ──────────────────────────────────────────
    #
    # Every controller process in one workspace used to share these files:
    # work/handoff-<model>.md always, and implementation-plan.md /
    # checkpoint.md whenever two chats sat in the same planning scope. Since
    # the plugin runs a pool of bridge children (SPEC §7), two chats can be
    # mid-turn at the same instant, and the second writer's copy was simply
    # the one that survived.
    #
    # The scheme: everything a chat writes for itself lives under
    # work/scratch/<session-id>/. The handoff is PURE scratch and moves there
    # outright (the old root-scoped file is still read as a fallback, and
    # cleaned up once we have written our own). The plan and the checkpoint
    # are also DELIVERABLES — the artifacts panel lists them, /project
    # build-plan copies them, and the planner's tool allowlist names them by
    # path — so they keep their canonical location and gain a session-keyed
    # mirror beside it. Writes go to both; reads take whichever is newer, so
    # a concurrent chat's write can no longer feed a foreign plan into this
    # chat's /finalize, and a human editing the canonical file still wins.

    def _scratch_scope_slug(self) -> str:
        project = self._active_project()
        return project.id if project else "_global"

    def _planning_mirror(self, path: Path) -> Path:
        return self.paths.scratch_file(
            path.name, self.session_id, scope=self._scratch_scope_slug(),
        )

    @staticmethod
    def _planning_owner_file(path: Path) -> Path:
        """Sidecar naming the chat that last wrote the canonical file."""
        return path.with_name(f".{path.name}.owner")

    def _planning_owner(self, path: Path) -> str:
        try:
            return self._planning_owner_file(path).read_text(
                encoding="utf-8",
            ).strip()
        except OSError:
            return ""

    def _read_planning_file(self, path: Path) -> str:
        """Read a planning deliverable — this chat's copy of it.

        The canonical file wins whenever this chat was the last to write it,
        which keeps a hand-edited implementation-plan.md authoritative exactly
        as it always was. It loses only when the owner sidecar names ANOTHER
        chat: that is the concurrent-write case, and reading a stranger's plan
        into this chat's /finalize is the bug. Then we read the mirror, which
        is this chat's own last write and nobody else's.
        """
        mirror = self._planning_mirror(path)
        if not mirror.is_file():
            return self._read_work_file(path)
        if not path.is_file():
            return self._read_work_file(mirror)
        owner = self._planning_owner(path)
        if owner and owner != self.session_id:
            return self._read_work_file(mirror)
        return self._read_work_file(path)

    def _write_planning_file(self, path: Path, text: str) -> None:
        """Write a planning deliverable to this chat's mirror AND to the
        canonical path. The mirror goes first, so losing the race on the
        shared file still leaves this chat's own copy intact."""
        try:
            self._write_work_file(self._planning_mirror(path), text)
        except OSError as exc:
            log.warning("Could not write planning mirror for %s: %s", path.name, exc)
        self._write_work_file(path, text)
        try:
            self._planning_owner_file(path).write_text(
                self.session_id + "\n", encoding="utf-8",
            )
        except OSError:
            pass  # ownership is an optimisation, never a precondition

    def _project_tasks_note(self) -> str:
        """Rules for projects/<id>/TASKS.md — only when a project is open.

        There is no project-level list without a project, and the note names
        a real path, so an Inbox chat is told nothing about it.
        """
        project = self._active_project()
        if not project:
            return ""
        return project_tasks_note(
            project.title,
            self._relative_project_path(project.root / TASKS_FILE_NAME),
        )

    def _live_handoff_path(self, model: str) -> Path:
        return self.paths.handoff_live_file(model, self.session_id)

    def _clear_live_handoff(self, model: str) -> None:
        """Remove this chat's live handoff artifact, legacy copy included."""
        for path in self.paths.handoff_live_candidates(model, self.session_id):
            path.unlink(missing_ok=True)

    @property
    def _archive_root(self) -> Path:
        env_dir = os.environ.get("BOTFERENCE_ARCHIVE_DIR")
        return Path(env_dir) if env_dir else (self.paths.project_root / "archive")

    def _active_project(self) -> ProjectInfo | None:
        if not self.active_project_id:
            return None
        return self.project_store.get(self.active_project_id)

    def _planning_scope_root(self) -> Path:
        project = self._active_project()
        return project.root if project else self.paths.work_dir

    def _planning_scope_label(self) -> str:
        project = self._active_project()
        return f"Project: {project.title} ({project.id})" if project else "Inbox/global"

    def _planning_display_path(self, path: Path) -> str:
        return self._relative_project_path(path)

    def _active_project_label(self) -> str:
        project = self._active_project()
        return project.title if project else "Inbox"

    def _summary_belongs_to_project(
        self,
        summary,
        project: ProjectInfo,
        indexed_to_project: dict[str, str],
    ) -> bool:
        # Saved payload metadata is authoritative.  The session index only
        # backfills older sessions that do not yet carry project_id.
        if summary.project_id:
            return summary.project_id == project.id
        try:
            source = Path(summary.source_path).resolve()
            project_session_dir = project.session_dir.resolve()
            if _is_relative_to(source, project_session_dir):
                return True
        except (OSError, RuntimeError, ValueError):
            pass
        return indexed_to_project.get(summary.session_id, "") == project.id

    def _payload_belongs_to_project(
        self,
        payload: dict,
        project: ProjectInfo,
        *,
        source_path: Path | None = None,
    ) -> bool:
        project_id = str(payload.get("project_id") or payload.get("project") or "")
        if project_id:
            return project_id == project.id
        if source_path is None:
            return False
        try:
            return _is_relative_to(source_path.resolve(), project.session_dir.resolve())
        except (OSError, RuntimeError, ValueError):
            return False

    def _project_tagged_summaries(self, project: ProjectInfo, *, limit: int = 100):
        # Global rows come from the metadata index — title/updated_at/created_at
        # are cached, so we do not re-read any session JSON to build them.
        # Membership precedence still matches _summary_belongs_to_project:
        # payload.project_id wins; session-index.json backfills legacy sessions
        # whose payload predates the project_id field.
        #
        # Project-local session dirs (projects/<id>/sessions/) are typically
        # tiny and aren't covered by the global index, so we still parse them
        # inline to find their rows.
        metadata = self.session_store.metadata_index()
        indexed_to_project = self.project_store.session_index_map()
        global_dir = self.paths.session_dir

        rows: list[tuple[float, SessionSummary]] = []

        for session_id, entry in metadata.items():
            if entry.entry_count < 1:
                continue
            membership = entry.project_id or indexed_to_project.get(session_id, "")
            if membership != project.id:
                continue
            rows.append((
                entry.mtime,
                self.session_store.summary_from_metadata(
                    session_id, entry, project_id=project.id
                ),
            ))

        for session_dir in self._project_session_dirs(project):
            if session_dir == global_dir or not session_dir.is_dir():
                continue
            for path in session_dir.glob("*.json"):
                if path.name.startswith("."):
                    continue
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                transcript = payload.get("transcript", [])
                if not (isinstance(transcript, list) and len(transcript) >= 1):
                    continue
                if not self._payload_belongs_to_project(
                    payload, project, source_path=path
                ):
                    continue
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    mtime = 0.0
                rows.append((mtime, SessionSummary(
                    session_id=str(payload.get("session_id") or path.stem),
                    created_at=str(payload.get("created_at", "")),
                    updated_at=str(payload.get("updated_at", "")),
                    title=_display_title(payload),
                    entry_count=len(transcript),
                    source_path=str(path),
                    project_id=str(payload.get("project_id") or project.id),
                )))

        rows.sort(key=lambda r: r[0], reverse=True)
        # One row per chat. A session that lives in the global index AND in a
        # project-local sessions/ dir would otherwise be listed twice — the
        # "same chat twice in the sidebar" report.
        deduped: list[SessionSummary] = []
        seen_ids: set[str] = set()
        for _, summary in rows:
            if summary.session_id in seen_ids:
                continue
            seen_ids.add(summary.session_id)
            deduped.append(summary)
            if len(deduped) >= limit:
                break
        return deduped

    def _project_session_dirs(self, project: ProjectInfo | None = None) -> list[Path]:
        dirs = [self.paths.session_dir]
        if project and project.session_dir != self.paths.session_dir:
            dirs.append(project.session_dir)
        return dirs

    def _session_summaries_for_resume(self, *, limit: int, exclude_session_id: str):
        project = self._active_project()
        summaries = self.session_store.list_summaries(
            limit=max(limit * 10, 1000) if project else limit,
            exclude_session_id=exclude_session_id,
            session_dirs=self._project_session_dirs(project),
        )
        if not project:
            return summaries

        tagged: list = []
        indexed_to_project = self.project_store.session_index_map()
        for summary in summaries:
            if self._summary_belongs_to_project(summary, project, indexed_to_project):
                tagged.append(summary)
        return tagged[:limit]

    def _session_summaries_any_project(self, *, limit: int, exclude_session_id: str):
        """Every resumable chat, regardless of which project owns it.

        The sidebar lists chats for every project, so `/resume <id>` has to
        reach a chat that the *active* project doesn't contain. This is only
        used as a fallback when the project-scoped list has no match, so the
        wider (and slightly more expensive) walk stays off the hot path.
        """
        dirs = [self.paths.session_dir]
        for project in self.project_store.list_projects():
            session_dir = project.session_dir
            if session_dir not in dirs and session_dir.is_dir():
                dirs.append(session_dir)
        return self.session_store.list_summaries(
            limit=limit,
            exclude_session_id=exclude_session_id,
            session_dirs=dirs,
        )

    @staticmethod
    def _panel_recency_key(row: tuple[float, str, str, str]) -> str:
        """Order chats by last ACTIVITY (updated_at), not file mtime — merely
        opening a chat re-saves its file, and mtime ordering made opened
        chats outrank recently-messaged ones. Rows without updated_at fall
        back to an ISO stamp derived from mtime (same format, so comparable).
        """
        if row[3]:
            return row[3]
        return (
            _dt.fromtimestamp(row[0], _tz.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )

    def _panel_sessions(
        self, rows: list[tuple[float, str, str, str]]
    ) -> list[ProjectPanelSession]:
        """Newest-first shortlist of panel rows, deduped by session id."""
        sessions: list[ProjectPanelSession] = []
        seen: set[str] = set()
        ordered = sorted(rows, key=self._panel_recency_key, reverse=True)
        for _mtime, session_id, title, updated_at in ordered:
            if session_id in seen:
                continue
            seen.add(session_id)
            sessions.append(ProjectPanelSession(
                session_id=session_id,
                title=title,
                updated_at=updated_at,
                active=session_id == self.session_id,
            ))
            if PANEL_SESSION_LIMIT and len(sessions) >= PANEL_SESSION_LIMIT:
                break
        # The active chat must always be visible even when it falls off the
        # recency shortlist: web frontends confirm a /resume by finding the
        # active flag in these rows, so a shortlisted-out chat would be
        # unresumable from their side.
        if self.session_id not in seen:
            for _mtime, session_id, title, updated_at in ordered:
                if session_id == self.session_id:
                    sessions.append(ProjectPanelSession(
                        session_id=session_id,
                        title=title,
                        updated_at=updated_at,
                        active=True,
                    ))
                    break
        return sessions

    def project_panel_snapshot(self) -> ProjectPanelState:
        # Hot path: this fires at startup and after every turn. We rely on a
        # cached metadata index (work/sessions/.metadata-index.json) so we
        # never parse the full session corpus more than once per process,
        # and counts honor both `payload.project_id` AND empty/unresumable
        # filtering — the things a raw filesystem count would get wrong.
        #
        # EVERY project gets its recent chats, not just the active one: the
        # web sidebar expands any project and opens any chat directly, with
        # no "make this the active project" step. That stays cheap because
        # the rows come out of the same single sweep that computes the counts
        # (title/updated_at are cached in the index) — no extra file reads,
        # and only (mtime, id, title, updated_at) tuples are accumulated.
        projects = self.project_store.list_projects()
        indexed_to_project = self.project_store.session_index_map()
        metadata = self.session_store.metadata_index()
        known_project_ids = {project.id for project in projects}

        global_dir = self.paths.session_dir
        inbox_count = 0
        # Count session IDS, not rows: the same chat reachable from both the
        # global index and a project-local sessions/ dir must count once.
        global_ids_by_project: dict[str, set[str]] = {}
        counted_globally: set[str] = set()
        rows_by_project: dict[str, list[tuple[float, str, str, str]]] = {}
        inbox_rows: list[tuple[float, str, str, str]] = []

        def add_row(
            project_id: str, mtime: float, session_id: str, title: str, updated_at: str
        ) -> None:
            rows_by_project.setdefault(project_id, []).append(
                (mtime, session_id, title, updated_at)
            )

        for session_id, entry in metadata.items():
            if entry.entry_count < 1:
                continue
            project_id = entry.project_id or indexed_to_project.get(session_id, "")
            counted_globally.add(session_id)
            if not project_id:
                inbox_count += 1
                inbox_rows.append((
                    entry.mtime,
                    session_id,
                    entry.title or "Untitled session",
                    entry.updated_at,
                ))
                continue
            global_ids_by_project.setdefault(project_id, set()).add(session_id)
            # Rows only for projects that still exist on disk — a stale
            # project_id still counts (unchanged semantics) but has no panel.
            if project_id in known_project_ids:
                add_row(
                    project_id,
                    entry.mtime,
                    session_id,
                    entry.title or "Untitled session",
                    entry.updated_at,
                )

        local_count_by_project: dict[str, int] = {}
        for project in projects:
            local_dir = project.session_dir
            if local_dir == global_dir or not local_dir.is_dir():
                continue
            # Project-local dirs are typically tiny — parse inline to match
            # the same "entry_count >= 1" filter we apply globally.
            local_ids: set[str] = set()
            for path in local_dir.glob("*.json"):
                if path.name.startswith("."):
                    continue
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                transcript = payload.get("transcript", [])
                if not (
                    isinstance(transcript, list)
                    and len(transcript) >= 1
                    and self._payload_belongs_to_project(
                        payload, project, source_path=path
                    )
                ):
                    continue
                session_id = str(payload.get("session_id") or path.stem)
                # Already seen in the global index (possibly under another
                # project): counted once, listed once.
                if session_id in counted_globally or session_id in local_ids:
                    continue
                local_ids.add(session_id)
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    mtime = 0.0
                add_row(
                    project.id,
                    mtime,
                    session_id,
                    _display_title(payload),
                    str(payload.get("updated_at", "") or ""),
                )
            local_count_by_project[project.id] = len(local_ids)

        panel_projects: list[ProjectPanelProject] = []
        for project in projects:
            is_active = project.id == self.active_project_id
            session_count = (
                len(global_ids_by_project.get(project.id, ()))
                + local_count_by_project.get(project.id, 0)
            )
            panel_sessions = tuple(
                self._panel_sessions(rows_by_project.get(project.id, []))
            )
            panel_projects.append(ProjectPanelProject(
                project_id=project.id,
                title=project.title,
                status=project.status,
                next_action=project.next_action,
                active=is_active,
                session_count=session_count,
                sessions=panel_sessions,
                # projects/<id>/TASKS.md — one small file per project, read
                # on the same sweep that already reads PROJECT.md for the
                # title. Missing or unparseable is simply an empty list.
                tasks=tuple(
                    ProjectPanelTask(text=task.text, done=task.done)
                    for task in read_project_tasks(project.root)
                ),
                github=project.github,
            ))
        return ProjectPanelState(
            projects=tuple(panel_projects),
            active_project_id=self.active_project_id,
            inbox_session_count=inbox_count,
            inbox_sessions=tuple(self._panel_sessions(inbox_rows)),
        )

    def _sync_project_ui(self, ui: UIPort) -> None:
        ui.set_status(self.status_snapshot())
        ui.set_projects(self.project_panel_snapshot())

    def _relative_project_path(self, path: Path) -> str:
        resolved = path.resolve()
        project_root = self.paths.project_root.resolve()
        if _is_relative_to(resolved, project_root):
            rel = resolved.relative_to(project_root).as_posix()
            return rel or "."
        return str(resolved)

    def _plan_write_roots(self) -> list[Path]:
        return normalize_write_roots(
            self._base_plan_write_roots + self._granted_plan_write_roots
        )

    def _plan_write_roots_display(self) -> str:
        roots = self._plan_write_roots()
        if not roots:
            return "(none)"
        return ", ".join(self._relative_project_path(root) for root in roots)

    def _serialize_write_roots(self, roots: list[Path]) -> list[str]:
        return [self._relative_project_path(root) for root in normalize_write_roots(roots)]

    def _apply_planner_write_config(self) -> None:
        config = planner_write_config(
            self.paths.project_root,
            self._plan_write_roots(),
        )
        self._configure_planner_adapters(config)

    def _configure_planner_adapters(self, config: PlannerWriteConfig) -> None:
        self.claude.cwd = config.claude_cwd
        self.claude.add_dirs = list(config.claude_add_dirs)
        self.claude.settings = dict(config.claude_settings)
        self.codex.cwd = config.codex_cwd
        self.codex.add_dirs = list(config.codex_add_dirs)
        self.codex.sandbox = config.codex_sandbox
        self.codex.network_access = config.codex_network_access

    def _resolve_requested_write_root(self, raw_path: str) -> tuple[Path | None, str]:
        candidate = raw_path.strip()
        if not candidate:
            return None, "empty path"
        path = Path(candidate)
        resolved = (
            path.resolve()
            if path.is_absolute()
            else (self.paths.project_root / path).resolve()
        )
        if resolved.exists() and resolved.is_file():
            resolved = resolved.parent
        elif not resolved.exists() and resolved.suffix:
            resolved = resolved.parent
        project_root = self.paths.project_root.resolve()
        if not _is_relative_to(resolved, project_root):
            return None, "path is outside the project root"
        if ".git" in resolved.relative_to(project_root).parts:
            return None, "paths under .git are never writable"
        return resolved, ""

    def _is_write_root_allowed(self, candidate: Path) -> bool:
        resolved = candidate.resolve()
        return any(
            _is_relative_to(resolved, root.resolve())
            for root in self._plan_write_roots()
        )

    def _grant_plan_write_root(self, root: Path) -> str:
        resolved = root.resolve()
        if not self._is_write_root_allowed(resolved):
            self._granted_plan_write_roots = normalize_write_roots(
                self._granted_plan_write_roots + [resolved]
            )
            self._apply_planner_write_config()
            self._persist_session()
        return self._relative_project_path(resolved)

    def _serialize_tool_summary(self, summary: ToolSummary) -> dict:
        return {
            "id": summary.id,
            "name": summary.name,
            "input_preview": summary.input_preview,
            "output_preview": summary.output_preview,
            "output_blocks": summary.output_blocks,
            "pending_output_blocks": summary.pending_output_blocks,
        }

    def _deserialize_tool_summary(self, payload: dict) -> ToolSummary:
        return ToolSummary(
            id=str(payload.get("id", "")),
            name=str(payload.get("name", "")),
            input_preview=str(payload.get("input_preview", "")),
            output_preview=str(payload.get("output_preview", "")),
            output_blocks=list(payload.get("output_blocks", []) or []),
            pending_output_blocks=list(payload.get("pending_output_blocks", []) or []),
        )

    def _session_title(self) -> str:
        if self.custom_title:
            return self.custom_title
        for entry in self.transcript.entries:
            if entry.speaker != "user":
                continue
            text = _clean_session_title(entry.text)
            if text:
                return text
        task = _clean_session_title(self.task)
        return task if task else "Untitled session"

    def _session_payload(self) -> dict:
        return {
            "version": 2,
            "session_id": self.session_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "custom_title": self.custom_title,
            "title": self._session_title(),
            "system_prompt": self.system_prompt,
            "task": self.task,
            "mode": self.mode.value,
            "lead": self.lead,
            # The chat's own filing, never the browsing lens (see __init__).
            "project_id": self.session_project_id,
            "route": self.router.current_route,
            "router_had_first_turn": self.router._had_first_turn,
            "observe": self.observe,
            "claude_subagents": self._claude_subagents_enabled(),
            "base_plan_write_roots": self._serialize_write_roots(
                self._base_plan_write_roots
            ),
            "granted_plan_write_roots": self._serialize_write_roots(
                self._granted_plan_write_roots
            ),
            "room_history": [
                {"speaker": entry.speaker, "text": entry.text,
                 **({"agent": entry.meta} if entry.meta else {})}
                for entry in self._room_history
            ],
            "writer_votes": dict(self._ff_writer_votes),
            # Written only when it is OFF, the convention every other
            # non-default in this payload keeps: a chat that never touched
            # /verify costs nothing on disk and needs no migration.
            **({"verify": False} if not self.verify_enabled else {}),
            # What has been lassoed into this chat. Written only when there is
            # something, so a chat that never used it costs nothing on disk and
            # no session written before this needs migrating.
            **({"attachments": list(self._attachments)} if self._attachments else {}),
            "transcript": [
                {
                    "speaker": entry.speaker,
                    "text": entry.text,
                    "turn_index": entry.turn_index,
                    "tool_summaries": [
                        self._serialize_tool_summary(summary)
                        for summary in entry.tool_summaries
                    ],
                }
                for entry in self.transcript.entries
            ],
            "last_seen": dict(self.transcript._last_seen),
            "claude": {
                "session_id": self.claude.session_id,
                "percent": self._claude_pct,
                "tokens": self._claude_tokens,
                "window": self._claude_window,
                "model": getattr(self.claude, "model", None),
                "effort": getattr(self.claude, "effort", None),
            },
            "codex": {
                "thread_id": self.codex.thread_id,
                "percent": self._codex_pct,
                "tokens": self._codex_tokens,
                "window": self._codex_window,
                "model": getattr(self.codex, "model", None),
                "reasoning_effort": getattr(self.codex, "reasoning_effort", None),
            },
            "models_initialized": sorted(self._models_initialized),
            "yield_pressure": dict(self._yield_pressure),
            "relay_boundary": dict(self._relay_boundary),
            "last_relay": {m: dict(v) for m, v in self._last_relay.items()},
            "pending_relay_handoffs": dict(self._pending_relay_handoffs),
            "pending_auto_relay": sorted(self._pending_auto_relay),
            "auto_relay_armed": dict(self._auto_relay_armed),
        }

    def _persist_session(self) -> None:
        if self._restoring_session:
            return
        # Lazy creation: an untouched chat never hits disk. Constructor and
        # /new call this as a no-op; the first user message (or a /rename,
        # or deliberately opening a project) creates the file. Kills the
        # empty-session litter that used to accumulate one file per launch.
        if (
            not self.transcript.entries
            and not self._models_initialized
            and not self.custom_title
            and not self.session_project_id
        ):
            return
        try:
            # updated_at means "last real activity" (new transcript entries or
            # a rename), NOT "last persisted": merely opening a chat re-saves
            # it, and bumping here would let opened-but-idle chats outrank
            # recently-messaged ones in the recents panel.
            activity = (len(self.transcript.entries), self.custom_title)
            if activity != self._persisted_activity:
                self.updated_at = iso_now()
                self._persisted_activity = activity
            try:
                self.session_store.save(self.session_id, self._session_payload())
            except StaleSessionWrite as stale:
                # Another process saved this chat after we last read it, and
                # its copy is longer than ours. Writing would delete a turn
                # nobody would ever see go. Say so loudly (log + crash log)
                # and leave the newer file alone; /resume re-reads from disk.
                log.error("%s", stale)
                append_crash_log(
                    self.paths,
                    location="_persist_session",
                    session_id=self.session_id,
                    exc=stale,
                )
                return
            # Re-assert the chat's OWN filing only. Using the active project
            # here is what let a save re-file a chat into whatever the user
            # happened to be browsing; an unfiled chat stays unfiled no matter
            # which project is open.
            if self.session_project_id:
                self.project_store.associate_session(
                    self.session_project_id, self.session_id
                )
        except OSError as exc:
            log.warning("Failed to persist botference session %s: %s", self.session_id, exc)

    def _can_replace_with_resumed_session(self) -> bool:
        return (
            not self.transcript.entries
            and not self._models_initialized
        )

    def _format_session_list(self, summaries: list) -> str:
        if not summaries:
            return "No saved sessions found."
        project = self._active_project()
        if project:
            lines = [f"Saved sessions for {project.title}:"]
        else:
            lines = ["Saved sessions:"]
        for idx, summary in enumerate(summaries, start=1):
            source = ""
            if summary.source_path:
                try:
                    rel = self._relative_project_path(Path(summary.source_path))
                    source = f"  [{rel}]"
                except Exception:
                    source = ""
            lines.append(
                f"  {idx:>2}. {summary.session_id[:12]}  {summary.updated_at}  {summary.title}{source}"
            )
        lines.extend([
            "",
            "Run /resume latest, /resume <number>, /resume <title>, or /resume <session-id-prefix>.",
            "This list is scoped to the current project, but /resume <id> reaches any chat —",
            "opening one makes its project active. /project open <id> refiles this list; /project clear = Inbox/global.",
        ])
        return "\n".join(lines)

    def _matching_sessions_by_title(self, summaries: list, query: str) -> list[str]:
        needle = _clean_session_title(query).lower()
        if not needle:
            return []

        def title(summary) -> str:
            return _clean_session_title(summary.title).lower()

        exact = [s.session_id for s in summaries if title(s) == needle]
        if exact:
            return exact
        prefix = [s.session_id for s in summaries if title(s).startswith(needle)]
        if prefix:
            return prefix
        return [s.session_id for s in summaries if needle in title(s)]

    def _match_sessions(self, summaries: list, query: str) -> list[str]:
        """Session ids matching *query* by id (exact/prefix), else by title."""
        matches = [
            summary.session_id
            for summary in summaries
            if summary.session_id == query or summary.session_id.startswith(query)
        ]
        return matches or self._matching_sessions_by_title(summaries, query)

    def _rename_session(self, arg: str, ui: UIPort) -> None:
        title = _clean_session_title(arg)
        if not title:
            self._add_room_entry(
                ui,
                "system",
                f"Current session name: {self._session_title()}\nUsage: /rename <session name>",
            )
            return
        self.custom_title = title
        self._persist_session()
        self._add_room_entry(ui, "system", f"Session renamed to: {title}")

    def _restored_project_id(self, payload: dict) -> str:
        """Which project a resumed chat belongs to.

        Same precedence the project panel uses (payload wins, session-index
        backfills legacy chats), so the project a chat is *listed* under is
        the project you land in when you open it.
        """
        project_id = str(payload.get("project_id", "") or "")
        if project_id:
            return project_id
        session_id = str(payload.get("session_id", "") or "")
        if not session_id:
            return ""
        indexed = self.project_store.session_index_map().get(session_id, "")
        if indexed and self.project_store.get(indexed):
            return indexed
        return ""

    def _restore_from_payload(self, payload: dict) -> str:
        self._restoring_session = True
        try:
            self.session_id = str(payload.get("session_id", self.session_id))
            self.created_at = str(payload.get("created_at", self.created_at))
            self.updated_at = str(payload.get("updated_at", self.updated_at))
            self.custom_title = _clean_session_title(
                str(payload.get("custom_title", "") or "")
            )
            self.system_prompt = str(payload.get("system_prompt", self.system_prompt))
            self.task = str(payload.get("task", self.task))
            self.lead = str(payload.get("lead", "auto"))
            # Opening a chat carries you into its project — that is what makes
            # "click any chat in any project and it just works" true. The
            # filing comes along unchanged: this is also the migration path
            # for chats saved before the split, whose membership the session
            # index (not the payload) records.
            self.session_project_id = self._restored_project_id(payload)
            self.active_project_id = self.session_project_id
            self._inbox_by_choice = False
            self.observe = bool(payload.get("observe", self.observe))
            self._set_claude_subagents(bool(payload.get("claude_subagents")))
            self.router.current_route = str(payload.get("route", "@all"))
            self.router._had_first_turn = bool(payload.get("router_had_first_turn", False))
            saved_base_roots = payload.get("base_plan_write_roots")
            if isinstance(saved_base_roots, list):
                resolved_roots = []
                for raw_root in saved_base_roots:
                    resolved, error = self._resolve_requested_write_root(str(raw_root))
                    if resolved is not None and not error:
                        resolved_roots.append(resolved)
                self._base_plan_write_roots = normalize_write_roots(resolved_roots)
            saved_granted_roots = payload.get("granted_plan_write_roots")
            if isinstance(saved_granted_roots, list):
                resolved_grants = []
                for raw_root in saved_granted_roots:
                    resolved, error = self._resolve_requested_write_root(str(raw_root))
                    if resolved is not None and not error:
                        resolved_grants.append(resolved)
                self._granted_plan_write_roots = normalize_write_roots(resolved_grants)
            self._apply_planner_write_config()

            saved_mode = str(payload.get("mode", RoomMode.PUBLIC.value))
            self.mode = RoomMode.PUBLIC

            self._room_history = [
                DisplayRecord(
                    speaker=str(entry.get("speaker", "system")),
                    text=str(entry.get("text", "")),
                    meta=entry.get("agent") if isinstance(entry.get("agent"), dict) else None,
                )
                for entry in payload.get("room_history", []) or []
                if isinstance(entry, dict)
            ]
            self._ff_writer_votes = {
                str(model): str(vote)
                for model, vote in (payload.get("writer_votes", {}) or {}).items()
            }
            # absent means on, which is what every session written before the
            # verification turn existed should mean
            self.verify_enabled = payload.get("verify", True) is not False
            # A resumed chat keeps what was lassoed into it — that is the whole
            # point of it being on the record rather than in memory. The last
            # search's OFFERS are not restored: they were a menu, not a fact.
            self._attachments = [
                row for row in (payload.get("attachments", []) or [])
                if isinstance(row, dict) and row.get("path") and row.get("title")
            ][:lasso.ATTACHMENTS_MAX]
            self._lasso_offer = []
            self._lasso_query = ""

            self.transcript = Transcript()
            transcript_entries = payload.get("transcript", []) or []
            for entry in transcript_entries:
                if not isinstance(entry, dict):
                    continue
                self.transcript.entries.append(TranscriptRecord(
                    speaker=str(entry.get("speaker", "system")),
                    text=str(entry.get("text", "")),
                    tool_summaries=[
                        self._deserialize_tool_summary(item)
                        for item in entry.get("tool_summaries", []) or []
                        if isinstance(item, dict)
                    ],
                    turn_index=int(entry.get("turn_index", len(self.transcript.entries))),
                ))
            if self.transcript.entries:
                self.transcript._counter = max(
                    entry.turn_index for entry in self.transcript.entries
                ) + 1
            else:
                self.transcript._counter = 0
            self.transcript._last_seen = {
                str(model): int(turn)
                for model, turn in (payload.get("last_seen", {}) or {}).items()
            }

            claude_state = payload.get("claude", {}) or {}
            codex_state = payload.get("codex", {}) or {}
            self.claude.session_id = str(claude_state.get("session_id", ""))
            self.codex.thread_id = str(codex_state.get("thread_id", ""))
            self._claude_pct = claude_state.get("percent")
            self._claude_tokens = claude_state.get("tokens")
            self._claude_window = claude_state.get("window")
            self._codex_pct = codex_state.get("percent")
            self._codex_tokens = codex_state.get("tokens")
            self._codex_window = codex_state.get("window")
            saved_claude_model = claude_state.get("model")
            if saved_claude_model and hasattr(self.claude, "model"):
                self.claude.model = str(saved_claude_model)
            saved_claude_effort = claude_state.get("effort")
            if saved_claude_effort is not None and hasattr(self.claude, "effort"):
                self.claude.effort = str(saved_claude_effort)
            saved_codex_model = codex_state.get("model")
            if saved_codex_model and hasattr(self.codex, "model"):
                self.codex.model = str(saved_codex_model)
            saved_codex_effort = codex_state.get("reasoning_effort")
            if saved_codex_effort is not None and hasattr(self.codex, "reasoning_effort"):
                self.codex.reasoning_effort = str(saved_codex_effort)

            self._models_initialized = set(payload.get("models_initialized", []) or [])
            if not self.claude.session_id:
                self._models_initialized.discard("claude")
            if not self.codex.thread_id:
                self._models_initialized.discard("codex")
            # Resumed models keep their native CLI sessions and never see the
            # free-form section of the initial prompt — teach them via the
            # shared transcript instead (once per session).
            if self._models_initialized and not any(
                "Free-form mode is active" in e.text
                for e in self.transcript.entries
                if e.speaker == "system"
            ):
                self.transcript.add("system", free_form_resume_note())
            self._yield_pressure = {
                str(model): float(value)
                for model, value in (payload.get("yield_pressure", {}) or {}).items()
            }
            self._relay_boundary = {
                str(model): int(value)
                for model, value in (payload.get("relay_boundary", {}) or {}).items()
            }
            self._last_relay = {
                str(model): {
                    "at": str((value or {}).get("at", "")),
                    "tier": str((value or {}).get("tier", "")),
                }
                for model, value in (payload.get("last_relay", {}) or {}).items()
            }
            self._pending_relay_handoffs = {
                str(model): str(value)
                for model, value in (payload.get("pending_relay_handoffs", {}) or {}).items()
            }
            # auto_relay itself is a global user preference (set in __init__),
            # so it is NOT restored here — only the per-session queue/armed state.
            self._pending_auto_relay = {
                str(model)
                for model in (payload.get("pending_auto_relay", []) or [])
            }
            self._auto_relay_armed = {
                str(model): bool(value)
                for model, value in (payload.get("auto_relay_armed", {}) or {}).items()
            }
            # Restored content is not new activity: the persist that follows a
            # resume must keep the chat's updated_at (and panel recency) put.
            self._persisted_activity = (
                len(self.transcript.entries), self.custom_title,
            )
        finally:
            self._restoring_session = False
        return saved_mode

    def _replay_restored_session(self, ui: UIPort) -> None:
        display = [
            e for e in self._room_history
            if not self._is_routine_restored_system_entry(e)
        ]
        # Replay only the most-recent tail into the UI. A multi-thousand-entry
        # replay makes resume O(minutes) (block parsing + render) for scrollback
        # nobody reads; the full record stays in the session file and in
        # self._room_history, so nothing durable is lost.
        elided = max(0, len(display) - _REPLAY_MAX_ENTRIES)
        if elided:
            display = display[-_REPLAY_MAX_ENTRIES:]
        room = [
            (e.speaker, e.text, self._structured_blocks(e.text), e.meta)
            if e.meta else (e.speaker, e.text, self._structured_blocks(e.text))
            for e in display
        ]
        if elided:
            notice = (
                f"[… {elided} earlier entr{'y' if elided == 1 else 'ies'} not "
                "replayed — the full transcript is preserved in the session "
                "file …]"
            )
            room.insert(0, ("system", notice, self._structured_blocks(notice)))
        # Fast path: bulk-restore in batches (single state update per batch).
        # Falls back to per-entry replay for any UIPort without restore_entries.
        bulk = getattr(ui, "restore_entries", None)
        if callable(bulk):
            bulk(room)
            return
        for speaker, text, blocks, *_meta in room:
            self._emit_room_entry(ui, speaker, text, blocks, restored=True)
        # …and what this chat is CARRYING, so a browser landing on a resumed
        # conversation sees its attachment strip rather than an empty box that
        # happens to be sending paths to the bots.
        self._emit_lasso_strip(ui)

    @staticmethod
    def _is_routine_restored_system_entry(entry: DisplayRecord) -> bool:
        if entry.speaker != "system":
            return False
        text = " ".join(entry.text.split())
        routine_prefixes = (
            "Project context set to ",
            "Project context cleared.",
            "Current project: ",
            "Saved sessions",
            "No saved sessions found.",
            "No saved session matched ",
            "Multiple sessions matched:",
            "Run /resume latest,",
            "Use /project open ",
            "Resumed session ",
            "Council room ready.",
        )
        return text.startswith(routine_prefixes)

    def _show_resume_list(self, ui: UIPort) -> None:
        summaries = self._session_summaries_for_resume(
            limit=10, exclude_session_id=self.session_id,
        )
        self._show_room_notice(ui, "system", self._format_session_list(summaries))

    def _resume_session(self, arg: str, ui: UIPort) -> None:
        # The previous controller version refused to resume once any messages
        # had been exchanged. We allow the switch now: the current session is
        # persisted on every turn so the in-memory state is recoverable, and
        # the cleaner UX from the sidebar is "click chat → switch to it".
        # `replaceable` is still used to decide whether to delete the
        # empty boot-time session (no point keeping that around).
        replaceable = self._can_replace_with_resumed_session()
        # Defensive: persist any pending state before swapping so the chat we
        # are leaving is on disk in case the user wants to resume it later.
        if not replaceable:
            self._persist_session()

        query = arg.strip()
        summaries = self._session_summaries_for_resume(
            limit=100, exclude_session_id=self.session_id,
        )
        if not query:
            self._show_resume_list(ui)
            return

        if query.lower() == "latest":
            if not summaries:
                self._add_room_entry(ui, "system", "No saved sessions found.")
                return
            target_id = summaries[0].session_id
        elif query.isdigit() and 1 <= int(query) <= len(summaries):
            target_id = summaries[int(query) - 1].session_id
        else:
            matches = self._match_sessions(summaries, query)
            if not matches:
                # Not in the active project? Look everywhere. The sidebar
                # lists every project's chats and clicking one must just open
                # it — the chat's own project becomes active on restore.
                wider = self._session_summaries_any_project(
                    limit=1000, exclude_session_id=self.session_id,
                )
                wider_matches = self._match_sessions(wider, query)
                if wider_matches:
                    matches = wider_matches
                    summaries = wider
            if not matches:
                self._show_room_notice(
                    ui,
                    "system",
                    f"No saved session matched '{query}'.\n\n{self._format_session_list(summaries[:10])}",
                )
                return
            if len(matches) > 1:
                by_id = {summary.session_id: summary for summary in summaries}
                self._show_room_notice(
                    ui,
                    "system",
                    "Multiple sessions matched:\n"
                    + "\n".join(
                        f"  {session_id[:12]}  {by_id[session_id].title}"
                        for session_id in matches[:10]
                    ),
                )
                return
            target_id = matches[0]

        by_id = {summary.session_id: summary for summary in summaries}
        target_summary = by_id.get(target_id)
        if target_summary and target_summary.source_path:
            payload = self.session_store.load_from_path(Path(target_summary.source_path))
        else:
            payload = self.session_store.load(target_id)
        old_session_id = self.session_id
        saved_mode = self._restore_from_payload(payload)
        if old_session_id != self.session_id and replaceable:
            self.session_store.delete(old_session_id)
        ui.clear_panes()
        self._replay_restored_session(ui)
        note = (
            f"Resumed session {self._session_title()} "
            f"({self.session_id[:12]}) from {self.updated_at}."
        )
        if saved_mode != RoomMode.PUBLIC.value:
            note += f" Restored interrupted {saved_mode} session in public mode."
        self._add_room_entry(ui, "system", note)
        ui.set_mode(self.mode)
        self._sync_project_ui(ui)
        self._persist_session()

    def _read_work_file(self, path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def _write_work_file(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        cleaned = _strip_response_frontmatter(text).strip()
        path.write_text(cleaned + ("\n" if cleaned else ""), encoding="utf-8")

    def _looks_like_template(self, text: str) -> bool:
        stripped = text.strip()
        if not stripped:
            return True
        placeholders = (
            "<thread name>",
            "<thread-name>",
            "<task description>",
            "<current status>",
            "<next task from implementation plan>",
        )
        return any(token in stripped for token in placeholders)

    def _current_plan_text(self) -> str:
        text = self._read_planning_file(self._plan_path)
        return "" if self._looks_like_template(text) else text

    def _thread_slug(self) -> str:
        candidates = [
            self._current_plan_text(),
            self._read_planning_file(self._checkpoint_path),
        ]
        for text in candidates:
            if not text:
                continue
            m = re.search(r"^\*\*Thread:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
            if m:
                return re.sub(r"\s+", "", m.group(1).strip())
        return "unknown-thread"

    def _reviewer_comments_name(self, round_number: int) -> str:
        return f"AI-reviewer_comments_round-{round_number}.md"

    def _reviewer_comments_root(self) -> Path:
        project = self._active_project()
        return project.root / "reviewer-comments" if project else self.paths.work_dir

    def _reviewer_comments_path(self, round_number: int) -> Path:
        return self._reviewer_comments_root() / self._reviewer_comments_name(round_number)

    def _active_reviewer_comments_paths(self) -> list[Path]:
        return sorted(
            self._reviewer_comments_root().glob("AI-reviewer_comments_round-*.md"),
            key=lambda p: self._extract_round_number(p.name),
        )

    def _archived_reviewer_comments_dir(self) -> Path:
        project = self._active_project()
        if project:
            return project.root / "archive" / "reviewer-comments" / self._thread_slug()
        return self._archive_root / "reviewer-comments" / self._thread_slug()

    def _extract_round_number(self, name: str) -> int:
        m = re.search(r"round-(\d+)\.md$", name)
        return int(m.group(1)) if m else 0

    def _next_reviewer_round(self) -> int:
        highest = 0
        for path in self._active_reviewer_comments_paths():
            highest = max(highest, self._extract_round_number(path.name))
        archived_dir = self._archived_reviewer_comments_dir()
        if archived_dir.is_dir():
            for path in archived_dir.glob("AI-reviewer_comments_round-*.md"):
                highest = max(highest, self._extract_round_number(path.name))
        return highest + 1

    def _review_bundle(self) -> str:
        parts: list[str] = []
        for path in self._active_reviewer_comments_paths():
            parts.append(f"[{path.name}]\n{self._read_work_file(path).strip()}")
        return "\n\n".join(parts).strip()

    def _archive_reviewer_comments(self) -> int:
        moved = 0
        active = self._active_reviewer_comments_paths()
        if not active:
            return moved
        target_dir = self._archived_reviewer_comments_dir()
        target_dir.mkdir(parents=True, exist_ok=True)
        for path in active:
            shutil.move(str(path), str(target_dir / path.name))
            moved += 1
        return moved

    # ── dispatch ──────────────────────────────────────────

    async def handle_input(
        self, raw: str, ui: UIPort, *, attachments: list | None = None,
    ) -> None:
        parsed = parse_input(raw)

        if parsed.kind is InputKind.MESSAGE and parsed.parallel and not parsed.body:
            self._add_room_entry(
                ui, "system",
                "/parallel needs a prompt: `/parallel <what you want both bots "
                "to answer>` — the word may sit anywhere in it. Both answer at "
                "once, neither seeing the other's reply.",
            )
            return

        if parsed.kind is InputKind.QUIT:
            self._quit_requested = True
            self._add_room_entry(ui, "system", "Exiting council. No files written.")
            self._persist_session()
            return

        if parsed.kind is InputKind.HELP:
            self._show_help(ui)
            return

        if parsed.kind is InputKind.PROJECTS:
            self._show_projects(ui)
            return

        if parsed.kind is InputKind.PROJECT:
            await self._handle_project_cmd(parsed.body, ui)
            return

        if parsed.kind is InputKind.STATUS:
            self._show_status(ui)
            return

        if parsed.kind is InputKind.PERMISSIONS:
            self._show_permissions(ui)
            return

        if parsed.kind is InputKind.NOTIFY:
            self._run_notify(parsed.body, ui)
            return

        if parsed.kind is InputKind.AUTORELAY:
            self._run_autorelay(parsed.body, ui)
            return

        if parsed.kind is InputKind.AGENTS:
            self._run_agents(parsed.body, ui)
            return

        if parsed.kind is InputKind.VERIFY:
            self._run_verify(parsed.body, ui)
            return

        if parsed.kind is InputKind.AUTH:
            self._show_auth_status(parsed.body, ui)
            return

        if parsed.kind is InputKind.LEAD:
            self._set_lead(parsed.body, ui)
            return

        if parsed.kind is InputKind.RESUME:
            self._resume_session(parsed.body, ui)
            return

        if parsed.kind is InputKind.RENAME:
            self._rename_session(parsed.body, ui)
            return

        if parsed.kind is InputKind.MODEL:
            await self._handle_model_cmd(parsed.body, ui)
            return

        if parsed.kind is InputKind.EFFORT:
            self._handle_effort_cmd(parsed.body, ui)
            return

        if parsed.kind is InputKind.CURRENT:
            self._show_current(ui)
            return

        if parsed.kind is InputKind.RELAY:
            if not parsed.target:
                self._add_room_entry(ui, "system", _RELAY_USAGE)
                return
            if parsed.target == "both":
                await self._relay_both(ui)
            else:
                await self._relay_model(parsed.target, ui)
            return

        if parsed.kind is InputKind.HARNESS_COMMAND:
            await self._run_harness_command(parsed.target, parsed.body, ui)
            return

        if parsed.kind is InputKind.ADOPT:
            await self._run_adopt(parsed.body, ui)
            return

        if parsed.kind is InputKind.NEW:
            title, filing, error = self._parse_new_args(parsed.body)
            if error:
                self._add_room_entry(ui, "system", error)
                return
            self._start_new_chat(title, ui, filing=filing)
            return

        if parsed.kind is InputKind.FILE:
            await self._run_file(parsed.body, ui)
            return

        if parsed.kind is InputKind.DELETE:
            await self._run_delete(parsed.body, ui)
            return

        if parsed.kind is InputKind.ARCHIVE:
            await self._run_archive(parsed.body, ui)
            return

        if parsed.kind is InputKind.ALLOW_HOST:
            self._run_allow_host(parsed.body, ui)
            return

        if parsed.kind is InputKind.WATCH:
            await self._run_watch_cmd(parsed.body, ui)
            return

        if parsed.kind is InputKind.LASSO:
            self._run_lasso_cmd(parsed.body, ui)
            return

        if parsed.kind is InputKind.UNARCHIVE:
            await self._run_unarchive(parsed.body, ui)
            return

        if parsed.kind is InputKind.DRAFT:
            await self._run_draft(ui, parsed.body)
            return

        if parsed.kind is InputKind.FINALIZE:
            await self._run_finalize(ui)
            return

        await self._send_message(parsed, ui, attachments=attachments)

    # ── /allow-host ───────────────────────────────────────

    _ALLOW_HOST_RE = re.compile(r"^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$")

    def _run_allow_host(self, body: str, ui: UIPort) -> None:
        """Grant the bots' sandbox network access to a site the user names.

        The grant is a workspace file the Claude adapter re-reads at every
        spawn, so it applies from each bot's next turn — no restarts.
        """
        raw = body.strip()
        if not raw:
            granted = granted_network_hosts()
            lines = ["Bot network access is limited to an allowlist."]
            lines.append(
                "Granted for this workspace: "
                + (", ".join(granted) if granted else "(none beyond the defaults)")
            )
            lines.append("Grant a new site with /allow-host <domain> "
                         "(e.g. /allow-host example.org — applies from the "
                         "bots' next turn).")
            self._show_room_notice(ui, "system", "\n".join(lines))
            return
        host = raw.lower()
        # accept a pasted URL: keep just the hostname
        host = re.sub(r"^[a-z]+://", "", host).split("/")[0].split("?")[0]
        host = host.strip(".")
        if not self._ALLOW_HOST_RE.match(host):
            self._add_room_entry(
                ui, "system",
                f"'{raw}' does not look like a domain. "
                "Usage: /allow-host <domain>  (e.g. example.org or *.example.org)",
            )
            return
        granted = add_granted_network_host(host)
        self._add_room_entry(
            ui, "system",
            f"Granted bot network access to {host} — applies from each bot's "
            f"next turn. Granted this workspace: {', '.join(granted)}",
        )

    # ── Watching YouTube videos (via Gemini) ──────────────
    #
    # Claude and Codex cannot take video. Gemini can, so a YouTube link in a
    # message — or one a bot asks for with a `watch:` line — is handed to
    # Gemini and what comes back is put in the chat as a written report.

    _VIDEO_WATCH_CAP = 3   # videos watched automatically per message

    @staticmethod
    def _video_watch_auto_enabled() -> bool:
        """BOTFERENCE_VIDEO_WATCH=off turns OFF only the automatic watching.

        /watch and a bot's `watch:` line are explicit requests and keep working.
        """
        setting = (os.environ.get("BOTFERENCE_VIDEO_WATCH") or "").strip().lower()
        return setting not in ("off", "0", "false", "no")

    @staticmethod
    def _emit_video_watch(ui: UIPort, event: dict) -> None:
        """Structured watch event for frontends that draw a Gemini indicator.

        Optional on the UI: a frontend that has no such indicator simply does
        not implement it, and the room notes carry the news instead.
        """
        sink = getattr(ui, "video_watch", None)
        if sink is None:
            return
        try:
            sink(event)
        except Exception:  # an indicator must never break a turn
            log.debug("video_watch event sink failed", exc_info=True)

    async def _watch_one_video(
        self, url: str, question: Optional[str], ui: UIPort,
    ) -> "video_watch.WatchResult":
        """Watch one video off the event loop, narrating start and duration."""
        self._show_room_notice(ui, "system", f"Watching {video_watch.display_url(url)} …")
        self._emit_video_watch(ui, {
            "state": "start", "url": url, "model": video_watch.DEFAULT_MODEL,
        })
        started = time.monotonic()
        try:
            result = await asyncio.to_thread(video_watch.watch, url, question)
        except Exception as exc:  # never let a watch kill the turn
            log.exception("Video watch failed")
            result = video_watch.WatchResult(
                url=url, question=question,
                error=f"The video watcher itself failed: {exc}",
            )
        took = time.monotonic() - started
        result.seconds = took
        # What it saw is posted as its own message (see _post_video_report),
        # which carries the duration — a second "watched it in 12s" note here
        # would only say it twice.
        self._emit_video_watch(ui, {
            "state": "error" if result.error else "done",
            "url": url,
            "model": result.model,
            "seconds": round(took, 1),
            "cached": bool(result.cached),
            "error": result.error or "",
        })
        return result

    async def _append_video_reports(self, body: str, ui: UIPort) -> str:
        """Append a Gemini report for each YouTube link the user sent."""
        if not self._video_watch_auto_enabled():
            return body
        urls = video_watch.find_youtube_urls(body)
        if not urls:
            return body
        if not video_watch.gemini_key():
            if self._video_no_key_told:
                return body
            self._video_no_key_told = True
            note = ("[YouTube link noticed — no Gemini key set, so nobody "
                    "watched it; see /watch]")
            self._add_room_entry(ui, "system", note)
            return f"{body}\n\n{note}"

        blocks: list[str] = []
        for url in urls[:self._VIDEO_WATCH_CAP]:
            result = await self._watch_one_video(url, None, ui)
            self._last_watched_url = url
            # the reader sees the report as Gemini's own message; the bots get
            # the same report inside the message they are about to answer
            self._post_video_report(result, ui, for_the_bots=False)
            blocks.append(video_watch.format_report(result))
        if len(urls) > self._VIDEO_WATCH_CAP:
            blocks.append(
                f"[{len(urls)} YouTube links were sent; the first "
                f"{self._VIDEO_WATCH_CAP} were watched. Ask for the rest with "
                "/watch <url>.]"
            )
        return body + "\n\n" + "\n\n".join(blocks)

    async def _run_watch_cmd(self, body: str, ui: UIPort) -> None:
        """/watch <url> [question] — have Gemini watch a video for the room."""
        raw = body.strip()
        if not raw:
            self._show_room_notice(ui, "system", (
                "Usage: /watch <youtube-url> [question]\n"
                "Gemini watches the video and its report is posted here, so "
                "Claude and Codex can read it on their next turn. Needs a "
                "Google AI Studio key in ~/.botference/gemini-key (or "
                "GEMINI_API_KEY)."
            ))
            return
        parts = raw.split(None, 1)
        url, question = parts[0], (parts[1].strip() if len(parts) > 1 else None)
        if not video_watch.is_youtube_url(url):
            self._add_room_entry(ui, "system", (
                f"'{url}' is not a YouTube link. "
                "Usage: /watch <youtube-url> [question]"
            ))
            return
        if not video_watch.gemini_key():
            self._add_room_entry(ui, "system", video_watch.NO_KEY_MESSAGE)
            return
        result = await self._watch_one_video(url, question, ui)
        self._last_watched_url = url
        self._post_video_report(result, ui)
        if result.error:
            return
        # /watch is not a filing cabinet: the reader asked for a video to be
        # watched because they want the room to talk about it, so the bots get
        # their turn without the user having to type "so, thoughts?".
        prompt = (
            f"Gemini has just watched {url} (report above). Discuss what "
            "matters in it for this chat; if you need something checked in "
            "the footage, ask Gemini."
        )
        await self._send_message(
            ParsedInput(kind=InputKind.MESSAGE, body=prompt, target="@all"),
            ui, watch_links=False,   # the report is already in the room
        )

    # ── /lasso ────────────────────────────────────────────
    #
    # THREE SHAPES, one command:
    #
    #   /lasso <words>          search everything the user has
    #   /lasso <path>           attach that file, no card, no clicking
    #   /lasso attach <n|all>   take one (or all) of the last card's offers
    #   /lasso detach <n>       take one off again
    #   /lasso                  what this chat is carrying
    #
    # A search shows a CARD and changes nothing. That is the rule the whole
    # feature rests on and it is the same rule the plugin keeps: bots may ask
    # for a search (`lasso:`), the user does the attaching, and an attachment
    # is a file on disk that the envelope names by path.

    @staticmethod
    def _emit_lasso(ui: UIPort, event: dict) -> None:
        """The card, for a frontend that can draw one.

        Optional on the UI, like the video-watch indicator: a frontend without
        it simply does not implement the sink and the room note below carries
        the same offers as text, which the TUI reads perfectly well.
        """
        sink = getattr(ui, "lasso", None)
        if sink is None:
            return
        try:
            sink(event)
        except Exception:  # a card must never break a turn
            log.debug("lasso event sink failed", exc_info=True)

    def _emit_lasso_strip(self, ui: UIPort) -> None:
        """What this chat is carrying, for a frontend that draws a strip.

        Separate from the search event because they are different things: one
        is a menu that goes away, the other is state that does not.
        """
        self._emit_lasso(ui, {"attachments": [
            {"kind": a.get("kind", ""), "title": a.get("title", ""),
             "path": a.get("path", ""), "summary": a.get("summary", "")}
            for a in self._attachments
        ]})

    def _lasso_rows_text(self, rows: list[dict]) -> str:
        out = []
        for i, r in enumerate(rows, 1):
            hit = str(r.get("hit") or "").strip()
            out.append(f"  {i}. [{r.get('kind', '?')}] {r.get('title') or r.get('id')}"
                       + (f"\n     {hit}" if hit else ""))
        return "\n".join(out)

    def _lasso_carrying(self) -> str:
        if not self._attachments:
            return ("This chat is carrying nothing. `/lasso <words>` searches what you "
                    "have read and said; `/lasso <path>` attaches a file of your own.")
        rows = "\n".join(
            f"  {i}. [{a.get('kind', '?')}] {a.get('title')} — {a.get('path')}"
            for i, a in enumerate(self._attachments, 1))
        return (f"Attached to this chat ({len(self._attachments)}):\n{rows}\n"
                "The bots read these when they matter. `/lasso detach <n>` takes one off.")

    def _lasso_show(self, result: "lasso.SearchResult", ui: UIPort) -> None:
        self._lasso_offer = list(result.results)
        self._lasso_query = result.query
        # WHERE THE ANSWER CAME FROM, always. The fallback covers this council's
        # own chats and nothing else; a user who thought their annotated pages
        # were searched and got silence would conclude they had nothing.
        scope = ("" if not result.narrow else
                 "  (the browser companion is not running, so this searched this "
                 "council's own chats only)")
        self._emit_lasso(ui, {
            "query": result.query, "results": result.results,
            "source": result.source, "carrying": len(self._attachments),
        })
        if not result.results:
            self._show_room_notice(
                ui, "system", f"Nothing of yours matches “{result.query}”.{scope}")
            return
        self._show_room_notice(ui, "system", (
            f"{len(result.results)} match"
            f"{'' if len(result.results) == 1 else 'es'} for “{result.query}”:{scope}\n"
            f"{self._lasso_rows_text(result.results)}\n"
            "Attach one with /lasso attach <n> (or `all`). Nothing is attached until you do."))

    def _lasso_attach_rows(self, rows: list[dict], ui: UIPort) -> None:
        """Build and record each of `rows`, saying what came of every one."""
        done, failed = [], []
        for row in rows:
            built = lasso.attach(self.paths.project_root, self.session_id,
                                 str(row.get("kind") or ""), str(row.get("id") or ""))
            if built.get("error"):
                failed.append(f"{row.get('title') or row.get('id')}: {built['error']}")
                continue
            built["at"] = _dt.now(_tz.utc).isoformat()
            kept, why = lasso.add_attachment(self._attachments, built)
            self._attachments = kept
            if why:
                failed.append(why)
                break
            done.append(built)
        if done:
            self._persist_session()
            self._emit_lasso_strip(ui)
            lines = "\n".join(f"  · {a['title']} — {a['path']}" for a in done)
            # The bots are told IN THE ROOM, not only in the envelope: an
            # attachment arriving mid-conversation is news, and a model that
            # only meets it as a standing block may not notice it is new.
            note = (f"[{len(done)} attachment{'' if len(done) == 1 else 's'} added to this "
                    f"chat — read the file when it is relevant, never paste it back:\n{lines}]")
            self._add_room_entry(ui, "system", note)
            self.transcript.add("system", note)
            self._persist_session()
        for why in failed:
            self._add_room_entry(ui, "system", f"Not attached — {why}")

    def _run_lasso_cmd(self, body: str, ui: UIPort) -> None:
        """/lasso — search what you have already read and said, and attach it."""
        raw = (body or "").strip()
        if not raw:
            self._add_room_entry(ui, "system", self._lasso_carrying())
            return

        low = raw.lower()
        if low == "list" or low == "carrying":
            self._add_room_entry(ui, "system", self._lasso_carrying())
            return

        if low.startswith("detach"):
            which = raw.split(None, 1)[1].strip() if len(raw.split(None, 1)) > 1 else ""
            kept, gone = lasso.detach(self._attachments, which)
            if gone is None:
                self._add_room_entry(ui, "system", (
                    "Nothing to detach there. `/lasso` lists what this chat is carrying."))
                return
            self._attachments = kept
            self._persist_session()
            self._emit_lasso_strip(ui)
            self._add_room_entry(ui, "system", f"Detached {gone.get('title')}.")
            return

        if low.startswith("attach"):
            which = raw.split(None, 1)[1].strip() if len(raw.split(None, 1)) > 1 else ""
            if not self._lasso_offer:
                self._add_room_entry(ui, "system", (
                    "There is nothing on offer — run `/lasso <words>` first, or "
                    "`/lasso <path>` to attach a file of your own directly."))
                return
            if which.lower() in ("all", "*"):
                self._lasso_attach_rows(list(self._lasso_offer), ui)
                return
            if not which.isdigit() or not (1 <= int(which) <= len(self._lasso_offer)):
                self._add_room_entry(ui, "system", (
                    f"Say which one: /lasso attach 1…{len(self._lasso_offer)}, or `all`."))
                return
            self._lasso_attach_rows([self._lasso_offer[int(which) - 1]], ui)
            return

        # A PATH is not a search: the user who typed one has already chosen.
        if lasso.looks_like_path(raw):
            p, why = lasso.resolve_owner_path(raw)
            if p is None:
                self._add_room_entry(ui, "system", f"Not attached — {why}.")
                return
            self._lasso_attach_rows([{"kind": "file", "id": str(p), "title": p.name}], ui)
            return

        self._lasso_show(lasso.search(self.paths.project_root, raw), ui)

    def _maybe_lasso_for_bot(self, reply_text: str, ui: UIPort) -> None:
        """Honour a `lasso:` line a bot ended its reply with.

        It runs the SEARCH and shows the user the card. It never attaches
        anything — same discipline as `watch:` (which does act, because
        watching a video reads nothing of the user's) and as the plugin's
        `file-in:` (which does not, for exactly this reason).
        """
        query = lasso.parse_lasso_request(reply_text)
        if not query:
            return
        self._lasso_show(lasso.search(self.paths.project_root, query), ui)

    def _post_video_report(
        self, result: "video_watch.WatchResult", ui: UIPort,
        *, for_the_bots: bool = True, asked_by: str = "",
    ) -> None:
        """Show the report to the READER, and give the bots their copy.

        Two audiences, two texts. The reader gets a `gemini` room entry — a
        message from the thing that did the watching, so nobody thinks Claude
        watched it. The bots get the bracketed envelope in the transcript,
        which says in words that a report is a witness account. When the report
        already travels inside the user's own turn (the automatic watch), the
        bots' copy is skipped rather than sent twice.
        """
        self._add_room_entry(
            ui, "gemini", video_watch.format_entry(result, asked_by))
        if for_the_bots:
            self.transcript.add("system", video_watch.format_report(result))
        self._persist_session()

    #: How many questions one bot may put to Gemini in a single user turn.
    _GEMINI_ASK_BUDGET = 2

    def _video_note(self, text: str, ui: UIPort) -> None:
        """One honest line, to the reader and to the bots."""
        self._add_room_entry(ui, "system", text)
        self.transcript.add("system", text)
        self._persist_session()

    async def _maybe_watch_for_bot(
        self, reply_text: str, ui: UIPort, model: str = "", *, depth: int = 0,
    ) -> None:
        """Honour a `watch:` or `ask gemini:` line a bot ended its reply with.

        The line stays in the reply — it is honest about what was asked for.
        A question gets an answer AND the floor back: the asking bot (only the
        asking bot) is woken with the answer in front of it. That wake-up is
        the end of the chain — a request inside it is not acted on, or two
        bots could keep a video conversation going without the user.
        """
        if depth:
            return
        req = video_watch.parse_video_request(reply_text)
        if not req:
            return
        asking = model or ""
        question = req.get("question") or ""

        if req["kind"] == "ask":
            if not self._last_watched_url:
                self._video_note(
                    "[A bot asked Gemini about a video, but nothing has been "
                    "watched in this chat yet. Send a YouTube link, or use "
                    "/watch <url>.]", ui)
                return
            url = self._last_watched_url
        else:
            url = req["url"]

        if question:
            used = self._gemini_asks.get(asking, 0)
            if used >= self._GEMINI_ASK_BUDGET:
                self._video_note(
                    f"[{asking.capitalize() or 'A bot'} has already put "
                    f"{self._GEMINI_ASK_BUDGET} questions to Gemini this turn "
                    "— the rest is for the user to ask.]", ui)
                return
            self._gemini_asks[asking] = used + 1

        if not video_watch.gemini_key():
            self._video_note(
                f"[A bot asked for {url} to be watched, but no Gemini key is "
                "set. Add one to ~/.botference/gemini-key.]", ui)
            return

        result = await self._watch_one_video(url, question or None, ui)
        self._last_watched_url = url
        self._post_video_report(result, ui, asked_by=asking if question else "")
        if question and asking:
            await self._wake_after_gemini(asking, ui)

    # ── summoned build agents (core/summon.py) ────────────────

    #: Stamp on a bot's reply that wrote a deliverable itself. Nothing is
    #: undone — the reader sees that the rule was not followed.
    IN_CHAT_BUILD_STAMP = "⚠ built in-chat, not delegated"

    def _stamp_in_chat_build(
        self, model: str, resp: AdapterResponse, ui: UIPort,
    ) -> None:
        if model not in ("claude", "codex"):
            return
        files = _visual_artifacts_from_tool_summaries(resp.tool_summaries)
        if not files:
            return
        shown = ", ".join(Path(f).name for f in files[:4])
        more = f" (+{len(files) - 4} more)" if len(files) > 4 else ""
        note = (f"{self.IN_CHAT_BUILD_STAMP}: {model.capitalize()} wrote "
                f"{shown}{more} in this chat. Deliverables go to a summoned "
                "build agent (`summon: <brief>`).")
        self._add_room_entry(ui, "system", note)
        self.transcript.add("system", note)

    def _recent_room_history_text(self, max_entries: int = 12,
                                  max_chars: int = 24_000) -> str:
        """The last few turns, as the build agent's only view of the room."""
        recent = [
            e for e in self.transcript.entries[-max_entries * 2:]
            if e.speaker in ("user", "claude", "codex", "gemini", "agent")
        ][-max_entries:]
        blocks = [self.transcript._entry_block(e) for e in recent]
        kept, _ = _take_tail_within_budget(blocks, max_chars)
        return "\n".join(kept)

    def _artifacts_dir_display(self) -> str:
        pid = self.session_project_id or self.active_project_id
        if pid:
            return f"projects/{pid}/artifacts"
        return "work/artifacts"

    def _make_builder(self, spec: dict):
        """A fresh adapter for one build. Nothing is shared with the bots.

        It may write where the bots may write, plus the artifacts folder the
        brief names — that folder is the whole point of the build, so it is
        not gated behind a write-access request the agent cannot make.
        """
        artifacts = (self.paths.project_root / self._artifacts_dir_display()).resolve()
        try:
            artifacts.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        roots = list(self._plan_write_roots()) + [artifacts]
        config = planner_write_config(self.paths.project_root, roots)
        if spec["cli"] == "codex":
            return CodexAdapter(
                model=spec["model"],
                sandbox=config.codex_sandbox,
                cwd=config.codex_cwd,
                add_dirs=list(config.codex_add_dirs),
                reasoning_effort=spec.get("effort", ""),
                timeout=spec["timeout_s"],
                debug_log_path=getattr(self.codex, "debug_log_path", ""),
                fallback_api_key=getattr(self.codex, "fallback_api_key", ""),
                network_access=config.codex_network_access,
            )
        return ClaudeAdapter(
            model=spec["model"],
            tools=["Read", "Glob", "Grep", "Bash", "Write", "Edit",
                   "WebFetch", "WebSearch"],
            effort=spec.get("effort", ""),
            timeout=spec["timeout_s"],
            debug_log_path=getattr(self.claude, "debug_log_path", ""),
            cwd=config.claude_cwd,
            add_dirs=list(config.claude_add_dirs),
            settings=dict(config.claude_settings),
        )

    async def _maybe_summon_for_bot(
        self, resp: AdapterResponse, ui: UIPort, model: str, *, depth: int = 0,
    ) -> None:
        """Honour a `summon:` brief a bot ended its reply with.

        One per bot per user turn. The agent's card nests under the reply
        that summoned it (parent_stream_id), the report goes into the shared
        transcript as the agent's own words, and the summoner is woken once
        with it. A summon inside that wake-up is not acted on (depth), so a
        bot cannot chain builds without the reader.
        """
        if depth or model not in ("claude", "codex"):
            return
        brief = summon.parse_summon_request(resp.text)
        if not brief:
            return
        used = self._summons.get(model, 0)
        if used >= summon.SUMMON_BUDGET:
            note = (f"[{model.capitalize()} asked for another build agent this "
                    f"turn; the budget is {summon.SUMMON_BUDGET} per turn. Ask "
                    "for it yourself if you want it run.]")
            self._add_room_entry(ui, "system", note)
            self.transcript.add("system", note)
            return
        self._summons[model] = used + 1
        await self._run_summon(brief, model, resp.stream_id, ui)

    async def _run_summon(
        self, brief: str, summoner: str, parent_stream_id: str, ui: UIPort,
    ) -> None:
        spec = summon.builder_spec(summoner, self.paths.botference_home)
        self._summon_seq += 1
        agent_id = f"{self.session_id}:agent:{self._summon_seq}"
        label = summon.builder_label(spec)
        meta = {
            "id": agent_id,
            "card": "report",
            "parent_stream_id": parent_stream_id or "",
            "summoned_by": summoner,
            "cli": spec["cli"],
            "model": spec["model"],
            "effort": spec.get("effort", ""),
            "label": label,
            "brief": brief,
            "status": "working",
            "elapsed_s": 0,
        }
        self._add_room_entry(
            ui, "agent",
            f"{label} is building… (summoned by {summoner.capitalize()})",
            stream_id=f"{agent_id}:card", agent=meta,
        )
        self.transcript.add(
            "system",
            f"[{summoner.capitalize()} summoned a build agent — {label} — with "
            f"the brief: {brief}]",
        )
        self._persist_session()

        prompt = summon.builder_prompt(
            brief=brief,
            summoner=summoner,
            history=self._recent_room_history_text(),
            artifacts_dir=self._artifacts_dir_display(),
            project_root=str(self.paths.project_root),
        )
        adapter = self._make_builder(spec)
        started = time.monotonic()
        status = "done"
        resp: Optional[AdapterResponse] = None
        try:
            resp = await asyncio.wait_for(
                self._run_adapter_streamed(
                    adapter, "agent", "room", ui, lambda: adapter.send(prompt),
                    extra={"agent": meta},
                ),
                timeout=spec["timeout_s"] + 5,
            )
        except asyncio.TimeoutError:
            status = "timeout"
        except asyncio.CancelledError:
            raise
        except Exception as e:  # the agent failing is a report, not a crash
            status = "failed"
            resp = AdapterResponse(text=f"Error: {e}", exit_code=1)
        elapsed = int(time.monotonic() - started)
        if resp is not None and resp.exit_code == -1:
            status = "timeout"
        elif resp is not None and resp.exit_code not in (0, -1) and status == "done":
            status = "failed"

        tools_text = _tool_summary_display_text(resp.tool_summaries) if resp else ""
        if tools_text:
            self._emit_room_entry(
                ui, "agent", tools_text,
                _tool_summary_display_blocks(resp.tool_summaries),
                stream_id=f"{agent_id}:tools",
                agent={**meta, "card": "tools", "status": status,
                       "elapsed_s": elapsed},
            )
        report = (resp.text.strip() if resp and resp.text.strip()
                  else {"timeout": "The build agent ran out of time.",
                        "failed": "The build agent failed before reporting."}
                  .get(status, "The build agent reported nothing."))
        done_meta = {**meta, "status": status, "elapsed_s": elapsed}
        self._add_room_entry(
            ui, "agent", report, stream_id=f"{agent_id}:card", agent=done_meta,
        )
        self.transcript.add(
            "agent",
            f"[Build agent {label}, summoned by {summoner.capitalize()}, "
            f"{status} after {elapsed}s:]\n{report}",
        )
        self._persist_session()
        await self._wake_after_summon(summoner, label, status, ui)

    async def _wake_after_summon(
        self, model: str, label: str, status: str, ui: UIPort,
    ) -> None:
        """Give the floor back to the bot whose agent just reported."""
        nudge = (f"[The build agent {model.capitalize()} summoned ({label}) "
                 f"has {status} — its report is above. {model.capitalize()}, "
                 "look at what it made if you can, then tell the user what to "
                 "open and what is still missing. Do not summon again this turn.]")
        self.transcript.add("system", nudge)
        resp = await self._send_to_model(model, "", ui)
        if resp is None:
            return
        self.transcript.add(model, resp.text, resp.tool_summaries)
        self.transcript.mark_seen(model)
        self._update_pct(model, resp, ui)
        ui.set_status(self.status_snapshot())
        self._persist_session()
        await self._maybe_watch_for_bot(resp.text, ui, model, depth=1)
        await self._maybe_summon_for_bot(resp, ui, model, depth=1)

    # ── /parallel ─────────────────────────────────────────

    async def _send_parallel(self, body: str, ui: UIPort) -> None:
        """Both bots take the prompt at once, neither seeing the other's reply.

        Replies stream side by side and land in the shared history when they
        finish; each bot is marked as having seen the prompt and nothing
        after, so the other's take reaches it on its next ordinary turn. No
        bot-to-bot thread follows: the point is two independent readings.
        """
        prompt_index = self.transcript.last_turn_index()
        results = await asyncio.gather(
            self._send_to_model("claude", body, ui),
            self._send_to_model("codex", body, ui),
            return_exceptions=True,
        )
        for model, resp in zip(("claude", "codex"), results):
            if isinstance(resp, BaseException):
                if isinstance(resp, asyncio.CancelledError):
                    raise resp
                self._add_room_entry(ui, "system", f"Error from {model}: {resp}")
                continue
            if resp is None:
                continue
            self.transcript.add(model, resp.text, resp.tool_summaries)
            self._stamp_in_chat_build(model, resp, ui)
            visual_warning = _visual_verification_warning(model, resp)
            if visual_warning:
                self._add_room_entry(ui, "system", visual_warning)
                self.transcript.add("system", visual_warning)
            self._update_pct(model, resp, ui)
        for model in ("claude", "codex"):
            if model in self._models_initialized:
                self.transcript.mark_seen_through(model, prompt_index)
        ui.set_status(self.status_snapshot())
        self._persist_session()
        for model, resp in zip(("claude", "codex"), results):
            if isinstance(resp, AdapterResponse):
                await self._maybe_watch_for_bot(resp.text, ui, model)
                self._maybe_lasso_for_bot(resp.text, ui)
                await self._maybe_summon_for_bot(resp, ui, model)

    async def _wake_after_gemini(self, model: str, ui: UIPort) -> None:
        """Give the floor back to the bot whose question Gemini just answered.

        Only that bot: the other one has not asked anything and does not need
        a turn to read someone else's answer.
        """
        # The message reaches the bot through the shared transcript (a resume
        # carries the room's own backfill, not an out-of-band prompt), so the
        # nudge is a room entry — which also lets the reader see why the bot
        # spoke again.
        nudge = (f"[Gemini answered {model.capitalize()}'s question (above). "
                 f"{model.capitalize()}, continue.]")
        self.transcript.add("system", nudge)
        resp = await self._send_to_model(model, "", ui)
        if resp is None:
            return
        self.transcript.add(model, resp.text, resp.tool_summaries)
        self.transcript.mark_seen(model)
        self._update_pct(model, resp, ui)
        ui.set_status(self.status_snapshot())
        self._persist_session()
        # depth 1: a further request in this reply is not acted on
        await self._maybe_watch_for_bot(resp.text, ui, model, depth=1)

    # ── /help ─────────────────────────────────────────────

    def _show_help(self, ui: UIPort) -> None:
        # Rendered from COMMAND_HELP — the same rows the browser popups and
        # the plugin's autocomplete show — plus the terminal's own notes.
        self._add_room_entry(ui, "system", "\n".join(
            render_command_help("tui") + [
            "",
            "Typing while Claude is working steers its current turn (read after",
            "its next tool call, like Claude Code). Codex can't be steered —",
            "messages typed during its turns queue for the next turn.",
            "",
            "Workflow: discuss (bots hand each other the floor) → /draft [rounds] → /finalize",
            "",
            "Keys (Ink TUI): Esc interrupts the current turn. Shift+Enter inserts a newline.",
            "Images, PDFs, spreadsheets & Word files: drag them in (or Finder Cmd+C → Cmd+V) to",
            "attach by path — several at once. Ctrl+V attaches a raw copied image (screenshot).",
            "",
            "YouTube links you send are watched for you by Gemini (needs a key in",
            "~/.botference/gemini-key); the report is posted as a message from Gemini",
            "and travels with your turn. A bot can ask for one too — `watch: <url>`,",
            "`watch: <url> — <question>` or `ask gemini: <question>` about the last",
            "video watched. BOTFERENCE_VIDEO_WATCH=off turns the automatic watching",
            "off; /watch still works.",
            "",
            "Claude context shows prompt occupancy / context window size.",
            "Codex shows estimated occupancy (exact after tool-free turns).",
        ]))

    # ── /projects / /project ─────────────────────────────

    def _show_projects(self, ui: UIPort) -> None:
        projects = self.project_store.list_projects()
        if not projects:
            self._add_room_entry(
                ui,
                "system",
                "No projects found. Use /project create <title> or create folders under projects/.",
            )
            return
        lines = ["Projects:"]
        for project in projects:
            active = "●" if project.id == self.active_project_id else " "
            priority = f"p{project.priority}" if project.priority is not None else "-"
            session_count = len(self._project_tagged_summaries(project))
            meta = f"{project.status}, {priority}, {session_count} chat(s)"
            lines.append(f"  {active} {project.id} — {project.title} ({meta})")
            if project.next_action:
                lines.append(f"      next: {project.next_action}")
        lines.extend([
            "",
            "Use /project open <id> to switch context, /project clear for Inbox/global.",
            "Use /project create <title> or /project create-from-chat to add one.",
            "Use /project archive <id> to tuck one away (reversible with unarchive).",
        ])
        self._add_room_entry(ui, "system", "\n".join(lines))

    async def _handle_project_cmd(self, arg: str, ui: UIPort) -> None:
        raw = arg.strip()
        if not raw or raw == "current":
            project = self._active_project()
            if project:
                self._add_room_entry(
                    ui,
                    "system",
                    f"Current project: {project.title} ({project.id})\n"
                    f"Root: {self._relative_project_path(project.root)}\n"
                    f"Plan: {self._planning_display_path(self._plan_path)}\n"
                    f"Checkpoint: {self._planning_display_path(self._checkpoint_path)}",
                )
            else:
                self._add_room_entry(
                    ui,
                    "system",
                    "Current project: Inbox\n"
                    f"Plan: {self._planning_display_path(self._plan_path)}\n"
                    f"Checkpoint: {self._planning_display_path(self._checkpoint_path)}",
                )
            return

        parts = raw.split(None, 1)
        action = parts[0].lower()
        value = parts[1].strip() if len(parts) > 1 else ""
        if action == "clear":
            # Unfiling is as explicit as filing: clear both the filing and
            # the lens, so the chat really lands back in Inbox.
            self.session_project_id = ""
            self.active_project_id = ""
            self._inbox_by_choice = True
            self._persist_session()
            # The payload now says Inbox, and an empty payload project_id
            # falls back to the session index — so a leftover association
            # would keep listing this chat under the project it just left.
            self.project_store.dissociate_session(self.session_id)
            self._sync_project_ui(ui)
            self._show_room_notice(
                ui, "system", "Project context cleared. Current project: Inbox"
            )
            return

        if action == "create":
            self._create_project(value, ui)
            return

        if action == "assign":
            self._assign_session_to_project(value, ui)
            return

        if action == "unfile":
            self._unfile_session(value, ui)
            return

        if action == "contents":
            self._show_project_contents(value, ui)
            return

        if action == "github":
            await self._publish_project_to_github(value, ui)
            return

        if action in ("archive", "unarchive"):
            self._set_project_status(
                value, "archived" if action == "archive" else "active", ui,
            )
            return

        if action == "create-from-chat":
            if value:
                self._add_room_entry(ui, "system", "Usage: /project create-from-chat")
                return
            title = _project_title_from_session_title(self._session_title())
            self._create_project(title, ui)
            return

        if action == "activate-build":
            if value:
                self._add_room_entry(ui, "system", "Usage: /project activate-build")
                return
            self._activate_project_build_plan(ui)
            return

        query = value if action == "open" else raw
        if not query:
            self._add_room_entry(ui, "system", "Usage: /project open <project-id>")
            return
        project = self.project_store.get(query)
        if not project:
            self._add_room_entry(
                ui,
                "system",
                f"No project matched '{query}'.\n\nRun /projects to list available projects.",
            )
            return
        self._activate_project(project, ui)
        self._show_room_notice(
            ui,
            "system",
            f"Project context set to {project.title} ({project.id}).\n"
            f"Plan writes now target {self._planning_display_path(self._plan_path)}.\n"
            f"Run /resume to see chats for this project.",
        )

    def _activate_project(self, project: ProjectInfo, ui: UIPort) -> None:
        """Make *project* this chat's project — the only way that sticks.

        This is one of the few places allowed to write ``session_project_id``:
        filing is an explicit act, and every "file the current chat" path
        funnels through here. The lens moves with it, because filing the chat
        you are sitting in and then being left looking at some other project's
        plan files would be nonsense.
        """
        self.session_project_id = project.id
        self.active_project_id = project.id
        self._persist_session()
        self.project_store.associate_session(project.id, self.session_id)
        self._sync_project_ui(ui)

    def _set_project_status(self, query: str, status: str, ui: UIPort) -> None:
        """Archive/unarchive a project by flipping portfolio.json status.

        Nothing moves on disk: the folder and every chat filed under it stay
        put, archived projects just sort last and get tucked away in the
        frontends. /project unarchive <id> is the exact reverse.
        """
        verb = "archive" if status != "active" else "unarchive"
        query = query.strip()
        if not query:
            self._add_room_entry(
                ui, "system", f"Usage: /project {verb} <project-id>",
            )
            return
        project = self.project_store.get(query)
        if not project:
            self._add_room_entry(
                ui, "system",
                f"No project matched '{query}'.\n\n"
                "Run /projects to list available projects.",
            )
            return
        if project.status == status:
            state = "archived" if status != "active" else "active"
            self._add_room_entry(
                ui, "system", f"{project.title} is already {state}.",
            )
            return

        self.project_store.set_status(project.id, status, title=project.title)
        if status != "active" and self.active_project_id == project.id:
            # Don't leave the room pointed at a project the user just filed
            # away — fall back to Inbox/global scope. Only the lens moves:
            # archiving explicitly promises the chats stay put, so the
            # filing (session_project_id) is left alone and unarchiving
            # brings this chat back with the rest of them.
            self.active_project_id = ""
        self._sync_project_ui(ui)
        if status == "active":
            self._add_room_entry(
                ui, "system",
                f"Unarchived {project.title} ({project.id}). "
                f"Use /project open {project.id} to work in it.",
            )
        else:
            self._add_room_entry(
                ui, "system",
                f"Archived {project.title} ({project.id}). Its folder and "
                f"chats are untouched — /project unarchive {project.id} "
                "restores it.",
            )

    def _assign_session_to_project(self, arg: str, ui: UIPort) -> None:
        """File a chat into a project.

        Usage: /project assign <project-id>                (current chat)
               /project assign <session-id-prefix> <project-id>

        Filing THIS chat moves the active context with it (see
        ``_activate_project``). Filing another saved chat rewrites that
        chat's payload on disk and leaves this chat where it is.
        """
        usage = ("Usage: /project assign <project-id>  or  "
                 "/project assign <session-id-prefix> <project-id>")
        parts = arg.split()
        if not parts or len(parts) > 2:
            self._add_room_entry(ui, "system", usage)
            return

        session_path: Path | None = None
        if len(parts) == 1:
            session_id, session_label = self.session_id, "this chat"
            project_query = parts[0]
        else:
            session_query, project_query = parts
            summaries = self.session_store.list_summaries(limit=200)
            matches = [s for s in summaries
                       if s.session_id.startswith(session_query)]
            if not matches:
                self._add_room_entry(
                    ui, "system",
                    f"No saved session matched '{session_query}'. "
                    "Run /resume to list sessions.",
                )
                return
            if len(matches) > 1:
                self._add_room_entry(
                    ui, "system",
                    f"'{session_query}' is ambiguous "
                    f"({len(matches)} sessions match). Use a longer prefix.",
                )
                return
            session_id = matches[0].session_id
            session_label = f"'{matches[0].title or session_id[:8]}'"
            if matches[0].source_path:
                session_path = Path(matches[0].source_path)

        project = self.project_store.get(project_query)
        if not project:
            self._add_room_entry(
                ui, "system",
                f"No project matched '{project_query}'. "
                "Run /projects to list available projects.",
            )
            return

        if session_id == self.session_id:
            # Filing the chat you are in = moving its working context too;
            # _activate_project writes the filing and the lens together.
            self._activate_project(project, ui)
            self._add_room_entry(
                ui, "system",
                f"Filed this chat under {project.title} ({project.id}) — "
                "it is now the active project.\n"
                f"Plan writes now target "
                f"{self._planning_display_path(self._plan_path)}.",
            )
            return

        self.project_store.associate_session(project.id, session_id)
        # The payload wins over the session index everywhere membership is
        # resolved, so the saved chat has to be re-stamped on disk too.
        if not self.session_store.set_project(
            session_id, project.id, path=session_path,
        ):
            log.warning(
                "Could not rewrite project_id for session %s", session_id,
            )
        self._sync_project_ui(ui)
        self._add_room_entry(
            ui, "system",
            f"Filed {session_label} under {project.title} ({project.id}). "
            "The active context is unchanged — use /project open "
            f"{project.id} to switch to it.",
        )

    def _unfile_session(self, arg: str, ui: UIPort) -> None:
        """Take a chat out of its project without deleting anything.

        Usage: /project unfile                        (this chat)
               /project unfile <session-id-prefix>    (a saved chat)

        The reversible half of the sidebar's "remove from this project": the
        chat, its transcript and its title are untouched — only the filing
        goes, so it lands back in Inbox and /file puts it wherever you meant.
        Deleting a chat because it was filed in the wrong place is the mistake
        this exists to make unnecessary.
        """
        query = arg.strip()
        if not query or self.session_id.startswith(query):
            # This chat: identical to /project clear, and says so.
            self.session_project_id = ""
            self.active_project_id = ""
            self._inbox_by_choice = True
            self._persist_session()
            self.project_store.dissociate_session(self.session_id)
            self._sync_project_ui(ui)
            self._show_room_notice(
                ui, "system",
                "Took this chat out of its project. It is in Inbox now — "
                "nothing was deleted.",
            )
            return

        summaries = self.session_store.list_summaries(limit=200)
        matches = [s for s in summaries if s.session_id.startswith(query)]
        if not matches:
            self._add_room_entry(
                ui, "system",
                f"No saved chat matched '{query}'. /resume lists them.",
            )
            return
        if len(matches) > 1:
            self._add_room_entry(
                ui, "system",
                f"'{query}' is ambiguous ({len(matches)} chats). "
                "Use a longer prefix.",
            )
            return
        target = matches[0]
        label = target.title or target.session_id[:8]
        self.project_store.dissociate_session(target.session_id)
        # The payload wins over the session index wherever membership is
        # resolved, so an empty project_id has to be stamped on disk too —
        # otherwise the next panel sweep reads the old filing straight back.
        self.session_store.set_project(
            target.session_id, "",
            path=Path(target.source_path) if target.source_path else None,
        )
        self._sync_project_ui(ui)
        self._add_room_entry(
            ui, "system",
            f"Took “{label}” out of its project — it is in Inbox now. "
            "Nothing was deleted.",
        )

    def _show_project_contents(self, arg: str, ui: UIPort) -> None:
        """Print what is actually inside projects/<id>/ — files and chats.

        Read-only, and shallow on purpose (see ProjectStore.contents). The
        council web sidebar renders the same two lists as a panel; this is
        the same answer for anyone at a terminal.
        """
        query = arg.strip()
        project = (
            self.project_store.get(query) if query else self._active_project()
        )
        if not project:
            self._add_room_entry(
                ui, "system",
                f"No project matched '{query}'." if query else
                "No project is open. Usage: /project contents <project-id>",
            )
            return

        snapshot = self.project_panel_snapshot()
        row = next(
            (p for p in snapshot.projects if p.project_id == project.id), None,
        )
        lines = [f"{project.title} ({project.id}) — projects/{project.id}/"]
        if project.github:
            lines.append(f"GitHub: {project.github}")

        chats = list(row.sessions) if row else []
        total = row.session_count if row else 0
        lines.append("")
        lines.append(f"Chats ({total}):")
        if not chats:
            lines.append("  (none yet)")
        for session in chats:
            when = (session.updated_at or "")[:10]
            mark = " ←" if session.active else ""
            lines.append(
                f"  {session.title or session.session_id[:8]}"
                f"  {when}  {session.session_id[:8]}{mark}"
            )
        if total > len(chats):
            lines.append(f"  … and {total - len(chats)} more")

        files = self.project_store.contents(project.id)
        lines.append("")
        lines.append(f"Files ({len(files)}):")
        if not files:
            lines.append("  (empty)")
        for entry in files:
            indent = "  " + ("  " * entry.depth)
            if entry.is_dir:
                suffix = "/…" if entry.truncated else "/"
                lines.append(f"{indent}{entry.name}{suffix}")
            else:
                lines.append(f"{indent}{entry.name}  {_human_bytes(entry.size)}")
        self._add_room_entry(ui, "system", "\n".join(lines))

    async def _publish_project_to_github(self, arg: str, ui: UIPort) -> None:
        """Push a project's folder to a NEW PRIVATE GitHub repo. Confirm-gated.

        Usage: /project github [<project-id>] [<repo-name>]

        Never one click: creating a repo under someone's GitHub account is
        not undoable from here, so a UI that can ask is made to ask, and a UI
        that cannot ask is refused rather than guessed at. gh's own auth does
        the talking — Botference never handles a token.
        """
        parts = arg.split()
        project = None
        repo_name = ""
        if parts:
            project = self.project_store.get(parts[0])
            if project is not None:
                repo_name = parts[1] if len(parts) > 1 else ""
            else:
                # A single unmatched word is a name for the open project,
                # not a typo'd project id — /project github my-notes.
                project = self._active_project()
                repo_name = parts[0] if len(parts) == 1 else ""
                if project is None or len(parts) > 1:
                    self._add_room_entry(
                        ui, "system",
                        f"No project matched '{parts[0]}'. "
                        "Run /projects to list available projects.",
                    )
                    return
        else:
            project = self._active_project()
        if project is None:
            self._add_room_entry(
                ui, "system",
                "No project is open. Usage: /project github <project-id>",
            )
            return

        if project.github:
            self._add_room_entry(
                ui, "system",
                f"{project.title} already has a repo: {project.github}\n"
                "Pushing again will just update it.",
            )

        name = slugify_repo_name(repo_name or project.title, fallback=project.id)
        ready = preflight(cwd=project.root)
        if not ready.ok:
            self._add_room_entry(ui, "system", ready.error)
            return

        request_choice = getattr(ui, "request_choice", None)
        if request_choice is None:
            self._add_room_entry(
                ui, "system",
                "Creating a GitHub repo needs a confirmation this interface "
                "cannot ask for. Run /project github from the TUI or the "
                "council web UI.",
            )
            return
        confirm = await request_choice(
            f"Push projects/{project.id}/ to a NEW PRIVATE GitHub repo "
            f"called “{name}”?",
            [f"Create {name} (private)", "Cancel"],
        )
        if confirm != 0:
            self._add_room_entry(ui, "system", "Not published.")
            return

        self._add_room_entry(
            ui, "system", f"Publishing {project.title} to GitHub as {name}…",
        )
        outcome = await asyncio.to_thread(
            publish_project, project.root, name,
        )
        if not outcome.ok:
            self._add_room_entry(ui, "system", outcome.error)
            return
        if outcome.url:
            self.project_store.set_github(
                project.id, outcome.url, title=project.title,
            )
        self._sync_project_ui(ui)
        verb = (
            "Created a private repo and pushed"
            if outcome.action == "created"
            else "Pushed to the repo it already had"
        )
        self._add_room_entry(
            ui, "system",
            f"{verb}: {outcome.url or '(no URL reported)'}",
        )

    _SUGGESTION_STOPWORDS = frozenset({
        "this", "that", "with", "have", "want", "need", "like", "about",
        "what", "when", "where", "should", "could", "would", "there",
        "then", "them", "they", "will", "from", "into", "please", "help",
        "make", "just", "some", "more", "think", "know", "going",
    })

    def _suggest_projects_for_text(self, text: str) -> list[ProjectInfo]:
        """Rank existing projects by keyword overlap with *text* (top 2)."""
        words = {
            w for w in re.findall(r"[a-z0-9]{4,}", text.lower())
            if w not in self._SUGGESTION_STOPWORDS
        }
        if not words:
            return []
        scored: list[tuple[int, ProjectInfo]] = []
        for project in self.project_store.list_projects():
            haystack = " ".join([
                project.id.replace("-", " "),
                project.title,
                project.next_action,
            ]).lower()
            project_words = set(re.findall(r"[a-z0-9]{4,}", haystack))
            score = len(words & project_words)
            if score > 0:
                scored.append((score, project))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [project for _, project in scored[:2]]

    async def _maybe_suggest_project(self, body: str, ui: UIPort) -> None:
        """On the first message of an Inbox chat, ask where to file it.

        UIs that implement ``request_choice`` get an arrow-key picker;
        others get a passive system note with ready-to-copy commands.

        Gated on the chat's own filing, not the lens: a chat you never filed
        is an Inbox chat even if you happen to be browsing a project.
        """
        if self.session_project_id or self._inbox_by_choice:
            return
        user_turns = sum(1 for e in self.transcript.entries
                         if e.speaker == "user")
        if user_turns != 1:
            return
        suggestions = self._suggest_projects_for_text(body)

        request_choice = getattr(ui, "request_choice", None)
        if request_choice is None:
            lines = ["This chat is in Inbox."]
            if suggestions:
                lines.append("It might belong to:")
                for project in suggestions:
                    lines.append(
                        f"  • {project.title} — /project open {project.id}"
                    )
            lines.append(
                "Start a new project with /project create-from-chat, "
                "or ignore this to stay in Inbox."
            )
            self._show_room_notice(ui, "system", "\n".join(lines))
            return

        options = [f"File under {p.title}" for p in suggestions]
        options.append("Create a new project from this chat")
        options.append("Stay in Inbox")
        try:
            choice = await request_choice(
                "New chat — where should it live?", options,
            )
        except Exception:
            return
        if choice is None or not 0 <= choice < len(options):
            return

        if choice < len(suggestions):
            project = suggestions[choice]
            # Already correct (sets the active project before persisting);
            # routed through the shared helper so it stays that way.
            self._activate_project(project, ui)
            self._show_room_notice(
                ui, "system",
                f"Project context set to {project.title} ({project.id}).",
            )
        elif choice == len(suggestions):
            title = _project_title_from_session_title(self._session_title())
            self._create_project(title, ui)
        # "Stay in Inbox" → nothing to do.

    def _create_project(self, title: str, ui: UIPort) -> None:
        try:
            project = self.project_store.create_project(title)
        except ValueError as exc:
            self._add_room_entry(ui, "system", f"Could not create project: {exc}")
            return
        except FileExistsError as exc:
            project_id = str(exc) or title
            self._add_room_entry(
                ui,
                "system",
                f"Project '{project_id}' already exists. Use /project open {project_id}.",
            )
            return

        self._activate_project(project, ui)
        self._add_room_entry(
            ui,
            "system",
            f"Created project {project.title} ({project.id}) and set it active.\n"
            f"Plan writes now target {self._planning_display_path(self._plan_path)}.",
        )

    def _activate_project_build_plan(self, ui: UIPort) -> None:
        project = self._active_project()
        if not project:
            self._add_room_entry(
                ui,
                "system",
                "No active project. Use /project open <project-id> first.",
            )
            return

        project_plan = project.root / "implementation-plan.md"
        project_checkpoint = project.root / "checkpoint.md"
        missing = [
            self._planning_display_path(path)
            for path in (project_plan, project_checkpoint)
            if not path.is_file()
        ]
        if missing:
            self._add_room_entry(
                ui,
                "system",
                "Cannot activate build plan; missing:\n"
                + "\n".join(f"  {path}" for path in missing),
            )
            return

        work_plan = self.paths.work_dir / "implementation-plan.md"
        work_checkpoint = self.paths.work_dir / "checkpoint.md"
        work_plan.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(project_plan, work_plan)
        shutil.copyfile(project_checkpoint, work_checkpoint)
        self._add_room_entry(
            ui,
            "system",
            "Activated project plan for build:\n"
            f"  {self._planning_display_path(project_plan)} -> "
            f"{self._planning_display_path(work_plan)}\n"
            f"  {self._planning_display_path(project_checkpoint)} -> "
            f"{self._planning_display_path(work_checkpoint)}",
        )

    def _show_permissions(self, ui: UIPort) -> None:
        lines = [
            "Planner write roots:",
            f"  Active: {self._plan_write_roots_display()}",
        ]
        if self._granted_plan_write_roots:
            lines.append(
                "  Runtime grants: "
                + ", ".join(
                    self._relative_project_path(root)
                    for root in self._granted_plan_write_roots
                )
            )
        else:
            lines.append("  Runtime grants: none")
        lines.extend([
            "",
            "If a model needs to edit a protected area, the Ink UI will show an allow/deny prompt.",
        ])
        self._add_room_entry(ui, "system", "\n".join(lines))

    # ── /notify ───────────────────────────────────────────

    def _run_notify(self, arg: str, ui: UIPort) -> None:
        """/notify [on|off] — desktop notification when the bots finish."""
        raw = arg.strip().lower()
        if raw in ("on", "off"):
            self.notify = raw == "on"
        elif not raw:
            self.notify = not self.notify
        else:
            self._add_room_entry(ui, "system", "Usage: /notify [on|off]")
            return
        save_user_setting("notify", self.notify)
        if self.notify:
            message = (
                "Notifications on — your terminal will post a desktop "
                "notification when the bots finish a turn (most terminals "
                "only show it while the window is unfocused)."
            )
        else:
            message = "Notifications off."
        self._add_room_entry(ui, "system", message)

    # ── /autorelay ────────────────────────────────────────

    def _run_autorelay(self, arg: str, ui: UIPort) -> None:
        """/autorelay [on|off] — auto-relay a model when it crosses the threshold."""
        raw = arg.strip().lower()
        if raw in ("on", "off"):
            self.auto_relay = raw == "on"
        elif not raw:
            self.auto_relay = not self.auto_relay
        else:
            self._add_room_entry(ui, "system", "Usage: /autorelay [on|off]")
            return
        save_user_setting("auto_relay", self.auto_relay)
        if self.auto_relay:
            message = (
                f"Auto-relay on — a model that crosses {AUTO_RELAY_THRESHOLD_PCT}% "
                "of its context window is relayed with a handoff before its next "
                "turn (never mid-turn)."
            )
        else:
            message = "Auto-relay off."
        self._add_room_entry(ui, "system", message)

    # ── /agents ───────────────────────────────────────────

    _SUBAGENT_TOOL = "Task"

    def _claude_subagents_enabled(self) -> bool:
        return self._SUBAGENT_TOOL in getattr(self.claude, "tools", [])

    def _set_claude_subagents(self, enabled: bool) -> None:
        if isinstance(self.claude, ClaudeInteractiveTmuxAdapter):
            return
        tools = getattr(self.claude, "tools", None)
        if tools is None:
            return
        if enabled and self._SUBAGENT_TOOL not in tools:
            tools.append(self._SUBAGENT_TOOL)
        elif not enabled and self._SUBAGENT_TOOL in tools:
            tools.remove(self._SUBAGENT_TOOL)

    def _run_agents(self, arg: str, ui: UIPort) -> None:
        """/agents [on|off] — grant/revoke Claude's subagent (Task) tool.

        Enforcement is hard, not prompt-level: the tool list is passed to
        the CLI on every turn, so an ungranted Claude simply does not have
        Task. Off by default in every chat; Claude is told to suggest the
        grant when subagents would help. Codex has no subagent facility.
        """
        if isinstance(self.claude, ClaudeInteractiveTmuxAdapter):
            self._add_room_entry(
                ui, "system",
                "/agents is not available under --claude-interactive — the "
                "native session manages its own tools.",
            )
            return
        raw = arg.strip().lower().lstrip("@")
        if raw in ("claude",):
            raw = ""
        if raw == "on":
            self._set_claude_subagents(True)
            self._persist_session()
            self._add_room_entry(
                ui, "system",
                "Subagents granted — Claude gets the Task tool from its "
                "next turn (this chat only). Revoke with /agents off.",
            )
        elif raw == "off":
            self._set_claude_subagents(False)
            self._persist_session()
            self._add_room_entry(ui, "system", "Subagents revoked for Claude.")
        elif not raw:
            state = "granted" if self._claude_subagents_enabled() else "off"
            self._add_room_entry(
                ui, "system",
                f"Subagents (Claude Task tool): {state}. "
                "Use /agents on|off to change. Codex has no subagent "
                "facility.",
            )
        else:
            self._add_room_entry(ui, "system", "Usage: /agents [on|off]")

    # ── /verify ───────────────────────────────────────────

    def _run_verify(self, arg: str, ui: UIPort) -> None:
        """/verify [on|off] — the convergence verification turn, per chat."""
        raw = arg.strip().lower()
        if raw == "on":
            self.verify_enabled = True
            self._persist_session()
            self._add_room_entry(
                ui, "system",
                "Verification on — when the bots converge, the other one "
                "checks the final claims against the sources before the floor "
                "comes back to you.",
            )
        elif raw == "off":
            self.verify_enabled = False
            self._persist_session()
            self._add_room_entry(
                ui, "system", "Verification off — convergence hands straight back to you.",
            )
        elif not raw:
            self._add_room_entry(
                ui, "system",
                f"Verification: {'on' if self.verify_enabled else 'off'}. "
                "Use /verify on|off to change (this chat only).",
            )
        else:
            self._add_room_entry(ui, "system", "Usage: /verify [on|off]")

    # ── /status ───────────────────────────────────────────

    def _show_status(self, ui: UIPort) -> None:
        c = _format_token_display(self._claude_tokens, self._claude_window)
        x = _format_token_display(self._codex_tokens, self._codex_window)
        c_pct = _format_window_percent(self._claude_tokens, self._claude_window)
        x_pct = _format_window_percent(self._codex_tokens, self._codex_window)
        lines = [
            f"Session: {self.session_id[:12]}",
            f"Project: {self._active_project_label()}",
            f"Plan scope: {self._planning_scope_label()}",
            f"Plan file: {self._planning_display_path(self._plan_path)}",
            f"Mode: {self.mode.value}",
            f"Lead: {self.lead}",
            f"Route: {self.router.current_route}",
            f"Claude: {c_pct} ({c})  (session {self.claude.session_id or '-'})",
            f"Codex:  {x_pct} ({x})  (thread {self.codex.thread_id or '-'})",
            f"Observe: {'on' if self.observe else 'off'}",
            f"Notifications: {'on' if self.notify else 'off'}",
            f"Auto-relay: {'on' if self.auto_relay else 'off'} "
            f"(at {AUTO_RELAY_THRESHOLD_PCT}% context)",
            f"Subagents: {'granted' if self._claude_subagents_enabled() else 'off'} (Claude Task tool)",
            f"Verification: {'on' if self.verify_enabled else 'off'} (a check at convergence)",
            f"Turns: {len(self.transcript.entries)}",
        ]
        self._add_room_entry(ui, "system", "\n".join(lines))

    def _show_auth_status(self, arg: str, ui: UIPort) -> None:
        target = arg.strip().lower().lstrip("@")
        if target in ("", "all", "both"):
            targets = ["claude", "codex"]
        elif target in ("claude", "codex"):
            targets = [target]
        else:
            self._add_room_entry(ui, "system", "Usage: /auth [claude|codex|all]")
            return

        lines = ["Auth diagnostics:"]
        for model in targets:
            lines.extend(self._auth_status_lines(model))
        self._add_room_entry(ui, "system", "\n".join(lines))

    def _auth_status_lines(self, model: str) -> list[str]:
        if model == "codex":
            cmd = ["codex", "login", "status"]
            session = self.codex.thread_id or "-"
            label = "Codex"
        else:
            cmd = ["claude", "auth", "status"]
            session = self.claude.session_id or "-"
            label = "Claude"

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except FileNotFoundError:
            return [
                f"{label}: CLI not found",
                f"  Session: {session}",
            ]
        except subprocess.TimeoutExpired:
            return [
                f"{label}: auth status check timed out",
                f"  Session: {session}",
            ]

        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        if model == "claude":
            try:
                payload = json.loads(stdout or "{}")
            except json.JSONDecodeError:
                payload = {}
            logged_in = bool(payload.get("loggedIn"))
            auth_method = payload.get("authMethod", "unknown")
            provider = payload.get("apiProvider", "unknown")
            summary = (
                f"{label}: logged in via {auth_method} ({provider})"
                if logged_in
                else f"{label}: not logged in ({auth_method})"
            )
        else:
            summary = stdout or stderr or f"{label}: auth status unavailable"

        lines = [summary, f"  Session: {session}"]
        if result.returncode != 0 and stderr and stderr != stdout:
            lines.append(f"  Detail: {stderr}")
        if model in ("claude", "codex"):
            lines.append(f"  After reauth: /relay @{model}")
        return lines

    # ── /lead ─────────────────────────────────────────────

    def _set_lead(self, arg: str, ui: UIPort) -> None:
        arg = arg.strip().lower()
        if arg in ("auto", "@claude", "@codex"):
            self.lead = arg
            self._add_room_entry(ui, "system", f"Lead set to {self.lead}")
        else:
            self._add_room_entry(ui, "system",
                              "Usage: /lead auto|@claude|@codex")
        ui.set_status(self.status_snapshot())
        self._persist_session()

    # ── /model and /effort ────────────────────────────────

    def _split_target_value(self, arg: str) -> tuple[str, str]:
        parts = arg.strip().split(None, 1)
        target = parts[0].lower().lstrip("@") if parts else ""
        value = parts[1].strip() if len(parts) > 1 else ""
        return target, value

    async def _handle_model_cmd(self, arg: str, ui: UIPort) -> None:
        target, value = self._split_target_value(arg)
        if not target:
            self._add_room_entry(ui, "system", "\n".join([
                f"claude model: {self.claude.model}",
                f"codex  model: {self.codex.model}",
                "Usage: /model @claude|@codex <model-id>",
            ]))
            return
        if target not in ("claude", "codex"):
            self._add_room_entry(ui, "system",
                              "Usage: /model @claude|@codex <model-id>")
            return
        adapter = self.claude if target == "claude" else self.codex
        if not value:
            self._add_room_entry(ui, "system", f"{target} model: {adapter.model}")
            return
        valid = _known_claude_models() if target == "claude" else _known_codex_models()
        if value not in valid:
            self._add_room_entry(ui, "system",
                              f"Unknown {target} model '{value}'. Known: {', '.join(valid)}")
            return
        if value == adapter.model:
            self._add_room_entry(ui, "system",
                              f"{target} model already {value} — no change.")
            return
        # If the participant is already running a live session, relay it so the
        # handoff is authored by the old model and the fresh session picks up
        # the new one. Otherwise just queue the change for startup.
        if target in self._models_initialized:
            self._add_room_entry(
                ui, "system",
                f"Relaying {target} to switch model → {value}…",
            )
            await self._relay_model(target, ui, new_model=value)
            return
        if target == "codex" and hasattr(adapter, "set_model"):
            adapter.set_model(value)
        else:
            adapter.model = value
        self._add_room_entry(
            ui, "system",
            f"{target} model → {value} (will apply when the participant starts)",
        )
        ui.set_status(self.status_snapshot())
        self._persist_session()

    def _show_current(self, ui: UIPort) -> None:
        claude_eff = self.claude.effort or "(default)"
        codex_eff = self.codex.reasoning_effort or "(default)"
        self._add_room_entry(ui, "system", "\n".join([
            "Currently loaded:",
            f"  @claude: {self.claude.model}  (effort: {claude_eff})",
            f"  @codex:  {self.codex.model}  (effort: {codex_eff})",
        ]))

    def _handle_effort_cmd(self, arg: str, ui: UIPort) -> None:
        target, value = self._split_target_value(arg)
        if not target:
            self._add_room_entry(ui, "system", "\n".join([
                f"claude effort: {self.claude.effort or '(default)'}",
                f"codex  effort: {self.codex.reasoning_effort or '(default)'}",
                "Usage: /effort @claude|@codex <level>",
            ]))
            return
        if target not in ("claude", "codex"):
            self._add_room_entry(ui, "system",
                              "Usage: /effort @claude|@codex <level>")
            return
        if target == "claude":
            current = self.claude.effort or "(default)"
            valid = _CLAUDE_EFFORT_LEVELS
        else:
            current = self.codex.reasoning_effort or "(default)"
            valid = _CODEX_EFFORT_LEVELS
        if not value:
            self._add_room_entry(ui, "system", f"{target} effort: {current}")
            return
        if value.lower() not in valid:
            self._add_room_entry(ui, "system",
                              f"Unknown {target} effort '{value}'. Valid: {', '.join(valid)}")
            return
        value = value.lower()
        if target == "claude":
            self.claude.effort = value
        else:
            self.codex.reasoning_effort = value
        self._add_room_entry(
            ui, "system",
            f"{target} effort → {value} (applies on next turn)",
        )
        ui.set_status(self.status_snapshot())
        self._persist_session()

    # ── native harness commands ───────────────────────────

    async def _run_harness_command(
        self, target: str, command: str, ui: UIPort,
    ) -> None:
        if target not in ("claude", "codex") or not command:
            self._add_room_entry(ui, "system", _HARNESS_COMMAND_USAGE)
            return

        if target == "codex":
            self._add_room_entry(
                ui,
                "system",
                "Native Codex slash commands are not available through "
                "`codex exec`. Botference can resume a Codex thread with "
                "`codex exec resume`, but that is not the interactive Codex "
                "slash-command layer.",
            )
            return

        run_native = getattr(self.claude, "run_harness_command", None)
        if run_native is None:
            self._add_room_entry(
                ui,
                "system",
                "Native Claude slash commands require Botference to be "
                "launched with the interactive Claude tmux transport "
                "(`--claude-interactive`).",
            )
            return

        self._show_room_notice(
            ui,
            "system",
            f"Sending native Claude command: {command}",
        )
        try:
            resp = await run_native(command)
        except Exception as exc:
            self._add_room_entry(
                ui,
                "system",
                f"Error sending native Claude command: {exc}",
            )
            return

        if resp.session_id:
            self.claude.session_id = resp.session_id
        if resp.text:
            self._add_room_entry(ui, "system", resp.text)
        if resp.exit_code == 0:
            self._models_initialized.add("claude")
            self._update_pct("claude", resp, ui)
        ui.set_status(self.status_snapshot())
        self._persist_session()

    # ── /relay ────────────────────────────────────────────

    async def _relay_model(
        self, model: str, ui: UIPort, *, new_model: str | None = None,
    ) -> None:
        """Relay a model's session: create handoff with the live (old) model,
        tear down, optionally swap the adapter's model, restart fresh.

        When ``new_model`` is provided, the handoff is generated by the
        currently-live model, then the adapter is mutated just before restart
        so the fresh session starts on the new model.
        """
        if model not in ("claude", "codex"):
            self._add_room_entry(ui, "system", _RELAY_USAGE)
            return
        if model not in self._models_initialized:
            self._add_room_entry(
                ui,
                "system",
                f"Cannot relay {model} — no active session.",
            )
            return

        # Read relay prompt
        relay_prompt = self._read_relay_prompt()
        if relay_prompt is None:
            self._add_room_entry(
                ui,
                "system",
                f"Relay failed — prompt file not found: {self.paths.relay_prompt}",
            )
            return

        # Determine tier sequence from yield pressure
        pct = self.yield_pressure(model)
        tiers = self._relay_tier_sequence(model, pct)

        # Try each tier until one produces a valid handoff
        now = _dt.now(_tz.utc)
        handoff_doc = None
        used_tier = None

        for tier in tiers:
            body = None
            if tier == "self":
                body = await self._relay_generate_self(model, relay_prompt, ui)
            elif tier == "cross":
                body = await self._relay_generate_cross(model, relay_prompt, ui)
            elif tier == "mechanical":
                body = self._relay_generate_mechanical(model)

            if body is None:
                continue

            doc = self._build_handoff_doc(model, tier, now, body)
            result = validate_handoff(doc)
            if result.valid:
                handoff_doc = doc
                used_tier = tier
                break
            log.warning(
                "Relay tier %s for %s failed validation: %s",
                tier, model, result.errors,
            )

        if handoff_doc is None:
            self._add_room_entry(
                ui,
                "system",
                f"Relay failed for {model} — could not generate valid handoff.",
            )
            return

        # Write timestamped history copy
        ts_filename = now.strftime("%Y-%m-%dT%H-%M-%SZ")
        history_dir = self.paths.handoff_model_history_dir(model)
        history_dir.mkdir(parents=True, exist_ok=True)
        (history_dir / f"{ts_filename}_handoff.md").write_text(
            handoff_doc, encoding="utf-8",
        )

        # Record relay boundary in transcript
        self.set_relay_boundary(model)

        # Tear down session state
        self._teardown_model_session(model, ui)

        # Swap the adapter's model right before restart so the fresh session
        # starts on the new model while the handoff above was generated by
        # the old (live) session.
        adapter = self.claude if model == "claude" else self.codex
        model_changed = False
        if new_model is not None and new_model != adapter.model:
            if model == "codex" and hasattr(adapter, "set_model"):
                adapter.set_model(new_model)
            else:
                adapter.model = new_model
            model_changed = True

        # Relay bootstrap is in-process only. Clear any prior failure artifact,
        # then keep the handoff in memory for the immediate restart attempt.
        self._clear_live_handoff(model)
        self._pending_relay_handoffs[model] = handoff_doc

        restarted = await self._ensure_initialized(model, ui)

        self._record_relay(model, used_tier, now)

        # Confirmation
        suffix = f" on {new_model}" if model_changed else ""
        if restarted:
            self._add_room_entry(
                ui,
                "system",
                f"Relayed {model} (tier: {used_tier}) and started a fresh session{suffix}.",
            )
        else:
            self._add_room_entry(
                ui,
                "system",
                f"Relayed {model} (tier: {used_tier}){suffix}, but fresh-session startup failed. "
                f"Retry by messaging {model}.",
            )
        ui.set_status(self.status_snapshot())
        self._persist_session()

    def _record_relay(self, model: str, tier: str | None, now: _dt) -> None:
        """Record relay provenance for the status panel (UI 'memory freshness')."""
        self._last_relay[model] = {
            "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tier": tier or "",
        }

    async def _relay_both(self, ui: UIPort) -> None:
        """/relay @both — reset both agents at once from one shared handoff.

        Token-efficient by design: the live agent with the most context
        headroom authors a single handoff document and both fresh sessions
        bootstrap from it (the author's copy is tier "self", the peer's is
        tier "cross"), so only one generation is paid instead of two. The
        restarts then run concurrently. Falls back to per-model mechanical
        handoffs when the healthiest author is already too degraded
        (>= RELAY_TIER_CROSS_MAX) or generation/validation fails.
        """
        models = [m for m in ("claude", "codex") if m in self._models_initialized]
        if not models:
            self._add_room_entry(ui, "system", "Cannot relay — no active sessions.")
            return
        if len(models) == 1:
            self._add_room_entry(
                ui,
                "system",
                f"Only {models[0]} has an active session — relaying it alone.",
            )
            await self._relay_model(models[0], ui)
            return

        relay_prompt = self._read_relay_prompt()
        if relay_prompt is None:
            self._add_room_entry(
                ui,
                "system",
                f"Relay failed — prompt file not found: {self.paths.relay_prompt}",
            )
            return

        author = min(models, key=self.yield_pressure)
        now = _dt.now(_tz.utc)

        body = None
        if self.yield_pressure(author) < RELAY_TIER_CROSS_MAX:
            adapter = self.claude if author == "claude" else self.codex
            prompt = (
                "[System: Both agents are being relayed simultaneously. Both "
                "sessions will be torn down after this. Generate ONE shared "
                "handoff document that will bootstrap BOTH successor sessions "
                "— yours and your peer's — so cover the whole room, not just "
                "your own thread. Write ONLY the Markdown body sections — the "
                "controller will add frontmatter.]\n\n" + relay_prompt
            )
            try:
                resp = await adapter.resume(prompt)
            except Exception as e:
                log.warning("Shared relay handoff by %s failed: %s", author, e)
                resp = None
            if resp is not None and resp.text and not resp.text.startswith("Error:"):
                self._update_pct(author, resp, ui)
                body = _strip_response_frontmatter(resp.text)

        docs: dict[str, tuple[str, str]] = {}  # model → (tier, doc)
        if body is not None:
            for model in models:
                tier = "self" if model == author else "cross"
                doc = self._build_handoff_doc(model, tier, now, body)
                result = validate_handoff(doc)
                if not result.valid:
                    log.warning(
                        "Shared relay doc for %s failed validation: %s",
                        model, result.errors,
                    )
                    docs = {}
                    break
                docs[model] = (tier, doc)

        if not docs:
            for model in models:
                mech = self._relay_generate_mechanical(model)
                doc = self._build_handoff_doc(model, "mechanical", now, mech or "")
                result = validate_handoff(doc)
                if mech is None or not result.valid:
                    self._add_room_entry(
                        ui,
                        "system",
                        f"Relay failed for {model} — could not generate valid handoff.",
                    )
                    return
                docs[model] = ("mechanical", doc)

        # History copies, boundaries, teardown — then restart both
        # concurrently: this is what makes @both simultaneous.
        ts_filename = now.strftime("%Y-%m-%dT%H-%M-%SZ")
        for model, (_tier, doc) in docs.items():
            history_dir = self.paths.handoff_model_history_dir(model)
            history_dir.mkdir(parents=True, exist_ok=True)
            (history_dir / f"{ts_filename}_handoff.md").write_text(
                doc, encoding="utf-8",
            )
            self.set_relay_boundary(model)
            self._teardown_model_session(model, ui)
            self._clear_live_handoff(model)
            self._pending_relay_handoffs[model] = doc

        results = await asyncio.gather(
            *(self._ensure_initialized(m, ui) for m in models)
        )

        for model, restarted in zip(models, results):
            tier = docs[model][0]
            self._record_relay(model, tier, now)
            if restarted:
                self._add_room_entry(
                    ui,
                    "system",
                    f"Relayed {model} (tier: {tier}) and started a fresh session.",
                )
            else:
                self._add_room_entry(
                    ui,
                    "system",
                    f"Relayed {model} (tier: {tier}), but fresh-session startup "
                    f"failed. Retry by messaging {model}.",
                )
        ui.set_status(self.status_snapshot())
        self._persist_session()

    def _relay_tier_sequence(self, model: str, pct: float) -> list[str]:
        """Return ordered list of generation tiers to attempt."""
        if pct < RELAY_TIER_SELF_MAX:
            return ["self", "cross", "mechanical"]
        if pct < RELAY_TIER_CROSS_MAX:
            return ["cross", "mechanical"]
        return ["mechanical"]

    def _read_relay_prompt(self) -> Optional[str]:
        """Read the relay generation prompt from disk."""
        path = self.paths.relay_prompt
        if not path.is_file():
            return None
        return path.read_text(encoding="utf-8")

    def _persist_failed_relay_handoff(self, model: str) -> None:
        """Persist an in-process relay handoff as a failure artifact."""
        handoff_doc = self._pending_relay_handoffs.get(model)
        if not handoff_doc:
            return
        live_path = self._live_handoff_path(model)
        live_path.parent.mkdir(parents=True, exist_ok=True)
        live_path.write_text(handoff_doc, encoding="utf-8")

    async def _start_model_session(
        self,
        model: str,
        ui: UIPort,
        *,
        handoff_doc: str | None = None,
        after_turn: int | None = None,
        stream: bool = False,
        pane: str = "room",
    ) -> Optional[AdapterResponse]:
        """Start a fresh model session, optionally from an in-process relay handoff."""
        adapter = self.claude if model == "claude" else self.codex
        prompt = self._build_initial_prompt(
            model,
            handoff_doc=handoff_doc,
            after_turn=after_turn,
        )
        self._models_initialized.add(model)
        label = "Restarting" if handoff_doc else "Starting"
        self._add_room_entry(ui, "system", f"{label} {model} session…")
        try:
            if stream:
                resp = await self._run_adapter_streamed(
                    adapter,
                    model,
                    pane,
                    ui,
                    lambda: adapter.send(prompt),
                )
            else:
                resp = await adapter.send(prompt)
        except asyncio.CancelledError:
            # Cancellation is a BaseException: without this clause an
            # interrupt mid-start leaves the model marked initialized with
            # no thread, and every later turn dies with "No thread to
            # resume — call send() first".
            self._models_initialized.discard(model)
            if handoff_doc:
                self._persist_failed_relay_handoff(model)
            self._persist_session()
            raise
        except Exception as e:
            self._add_room_entry(ui, "system", f"Error starting {model}: {e}")
            self._models_initialized.discard(model)
            if handoff_doc:
                self._persist_failed_relay_handoff(model)
            self._persist_session()
            return None

        if resp.exit_code not in (0, -1):
            detail = resp.text.strip() or f"{model} exited with code {resp.exit_code}"
            self._add_room_entry(ui, "system", f"Error starting {model}: {detail}")
            self._maybe_credit_fallback_hint(model, resp.text, ui)
            self._models_initialized.discard(model)
            if handoff_doc:
                self._persist_failed_relay_handoff(model)
            self._persist_session()
            return None

        if model == "codex" and not adapter.thread_id:
            # Restore applies the same invariant (no thread id ⇒ not
            # initialized); a start that yielded no thread cannot be
            # resumed later.
            self._models_initialized.discard(model)

        if handoff_doc:
            self._pending_relay_handoffs.pop(model, None)
            self._clear_live_handoff(model)

        self._persist_session()
        return resp

    async def _relay_generate_self(
        self, model: str, relay_prompt: str, ui: UIPort,
    ) -> Optional[str]:
        """Target model generates its own handoff body."""
        adapter = self.claude if model == "claude" else self.codex
        prompt = (
            "[System: You are being relayed. Your session will be torn down "
            "after this. Generate a handoff document for your successor "
            "session. Write ONLY the Markdown body sections — the controller "
            "will add frontmatter.]\n\n" + relay_prompt
        )
        try:
            resp = await adapter.resume(prompt)
        except Exception as e:
            log.warning("Self-authored relay for %s failed: %s", model, e)
            return None
        if not resp.text or resp.text.startswith("Error:"):
            return None
        self._update_pct(model, resp, ui)
        return _strip_response_frontmatter(resp.text)

    async def _relay_generate_cross(
        self, model: str, relay_prompt: str, ui: UIPort,
    ) -> Optional[str]:
        """Peer model generates handoff body for the target."""
        peer = "codex" if model == "claude" else "claude"
        if peer not in self._models_initialized:
            return None
        adapter = self.claude if peer == "claude" else self.codex
        name = model.capitalize()
        prompt = (
            f"[System: {name}'s session is being relayed. Generate a handoff "
            f"document summarizing {name}'s discussion context for their "
            "successor session. Write ONLY the Markdown body sections — the "
            "controller will add frontmatter.]\n\n" + relay_prompt
        )
        try:
            resp = await adapter.resume(prompt)
        except Exception as e:
            log.warning(
                "Cross-authored relay for %s (via %s) failed: %s",
                model, peer, e,
            )
            return None
        if not resp.text or resp.text.startswith("Error:"):
            return None
        self._update_pct(peer, resp, ui)
        return _strip_response_frontmatter(resp.text)

    def _relay_generate_mechanical(self, model: str) -> Optional[str]:
        """Generate handoff body from controller state alone (no LLM).

        Conservative transcript extraction: preserves explicit user
        constraints and settled decisions; does not invent agreement.
        """
        tail = self.transcript.entries[-_MECHANICAL_TAIL_ENTRIES:]

        # ── Objective ──
        if self.task:
            objective = self.task
        elif tail:
            user_msgs = [e.text for e in reversed(tail) if e.speaker == "user"]
            objective = user_msgs[0] if user_msgs else "None"
        else:
            objective = "None"

        # ── Resolved Decisions ──
        # Only preserve explicit agreements stated by user or system
        resolved_parts: list[str] = []
        for e in tail:
            if e.speaker == "system" and ("agreed" in e.text.lower()
                                          or "consensus" in e.text.lower()
                                          or "decision" in e.text.lower()):
                resolved_parts.append(f"- {e.text.strip()}")
        resolved = "\n".join(resolved_parts) if resolved_parts else "None"

        # ── Open Questions ──
        questions: list[str] = []
        for e in tail:
            if e.speaker == "user" and "?" in e.text:
                questions.append(
                    f"- User asked: {e.text.strip()}"
                )
        open_questions = "\n".join(questions) if questions else "None"

        # ── Positions In Play ──
        converging: list[str] = []
        contested: list[str] = []
        model_entries = [e for e in tail if e.speaker in ("claude", "codex")]
        for e in model_entries:
            speaker = e.speaker.capitalize()
            # Truncate very long entries for the handoff
            text = e.text.strip()
            if len(text) > 200:
                text = text[:200] + "…"
            converging.append(f"- {speaker}: {text}")
        converging_text = "\n".join(converging) if converging else "None"
        contested_text = "None"

        # ── Constraints ──
        constraint_patterns = re.compile(
            r"(?:must|don't|do not|should not|shouldn't|always|never)\b",
            re.IGNORECASE,
        )
        constraints: list[str] = []
        for e in tail:
            if e.speaker == "user" and constraint_patterns.search(e.text):
                constraints.append(f"- {e.text.strip()}")
        constraints_text = "\n".join(constraints) if constraints else "None"

        # ── Current Thread ──
        if tail:
            recent = tail[-1]
            current_thread = recent.text.strip()
            if len(current_thread) > 200:
                current_thread = current_thread[:200] + "…"
        else:
            current_thread = "None"

        # ── Response Obligation ──
        user_tail = [e for e in tail if e.speaker == "user"]
        if user_tail:
            last_user = user_tail[-1].text.strip()
            obligation = f"Continue from: {last_user}"
        else:
            obligation = "Resume the discussion"

        # ── Decision Criteria ──
        decision_criteria = "None"

        # ── Next Action ──
        if user_tail:
            next_action = f"Address the user's latest message: {user_tail[-1].text.strip()}"
            if len(next_action) > 200:
                next_action = next_action[:200] + "…"
        elif self.task:
            next_action = f"Continue working on: {self.task}"
        else:
            next_action = "Await user direction"

        # ── Room context ──
        mode_note = ""
        if self.mode != RoomMode.PUBLIC:
            mode_note = f"\n\nRoom is in {self.mode.value} mode."
        if self.lead != "auto":
            mode_note += f"\nLead is {self.lead}."

        return (
            f"## Objective\n{objective}{mode_note}\n"
            f"\n## Resolved Decisions\n{resolved}\n"
            f"\n## Open Questions\n{open_questions}\n"
            f"\n## Positions In Play\n"
            f"\n### Converging\n{converging_text}\n"
            f"\n### Contested\n{contested_text}\n"
            f"\n## Constraints\n{constraints_text}\n"
            f"\n## Current Thread\n{current_thread}\n"
            f"\n## Response Obligation\n{obligation}\n"
            f"\n## Decision Criteria\n{decision_criteria}\n"
            f"\n## Next Action\n{next_action}\n"
        )

    def _build_handoff_doc(
        self, model: str, tier: str, now: _dt, body: str,
    ) -> str:
        """Combine controller-built frontmatter with generated body."""
        adapter = self.claude if model == "claude" else self.codex
        session_id = (adapter.session_id if model == "claude"
                      else adapter.thread_id)
        tokens = ((self._claude_tokens or 0) if model == "claude"
                  else (self._codex_tokens or 0))
        window = ((self._claude_window or 200_000) if model == "claude"
                  else (self._codex_window or 200_000))
        fm = build_frontmatter(
            model=model,
            session_id=session_id or "",
            created=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            room_mode=self.mode.value,
            lead=self.lead,
            yield_pct=self.yield_pressure(model),
            context_tokens=tokens,
            context_window=window,
            generation_tier=tier,
        )
        return fm + "\n" + body

    def _teardown_model_session(self, model: str, ui: UIPort) -> None:
        """Tear down session state for a relayed model."""
        adapter = self.claude if model == "claude" else self.codex

        # Clear session/thread identifiers
        if model == "claude":
            adapter.session_id = ""
        else:
            adapter.thread_id = ""
            adapter._last_cumulative_input_tokens = 0
            adapter._last_cumulative_cached_input_tokens = 0
            adapter._last_cumulative_output_tokens = 0

        # Remove from initialized models
        self._models_initialized.discard(model)

        # Clear over-limit warning
        self._warned_overlimit_models.discard(model)

        # Clear raw occupancy/status fields
        if model == "claude":
            self._claude_pct = None
            self._claude_tokens = None
            self._claude_window = None
        else:
            self._codex_pct = None
            self._codex_tokens = None
            self._codex_window = None

        # Clear yield pressure
        self._yield_pressure.pop(model, None)

    # ── message routing ───────────────────────────────────

    def _structured_blocks(self, text: str) -> list[dict]:
        return parse_render_blocks(text)

    def _emit_stream_event(self, ui: UIPort, event: dict[str, Any]) -> None:
        stream_event = getattr(ui, "stream_event", None)
        if not callable(stream_event):
            return
        stream_event(event)

    def _next_stream_id(self, model: str, pane: str) -> str:
        self._stream_seq += 1
        return f"{self.session_id}:{pane}:{model}:{self._stream_seq}"

    async def _run_adapter_streamed(
        self,
        adapter: ClaudeAdapter | CodexAdapter,
        model: str,
        pane: str,
        ui: UIPort,
        call: Callable[[], Awaitable[AdapterResponse]],
        *,
        extra: Optional[dict] = None,
    ) -> AdapterResponse:
        stream_id = self._next_stream_id(model, pane)
        old_callback = getattr(adapter, "stream_callback", None)
        extra = dict(extra or {})
        self._emit_stream_event(ui, {
            "kind": "start",
            "stream_id": stream_id,
            "pane": pane,
            "model": model,
            **extra,
        })

        def _callback(event: dict[str, Any]) -> None:
            self._emit_stream_event(ui, {
                **event,
                "stream_id": stream_id,
                "pane": pane,
                "model": model,
                **extra,
            })

        adapter.stream_callback = _callback
        try:
            resp = await call()
        finally:
            adapter.stream_callback = old_callback

        resp.stream_id = stream_id
        self._emit_stream_event(ui, {
            "kind": "done",
            "stream_id": stream_id,
            "pane": pane,
            "model": model,
            **extra,
        })
        return resp

    def _emit_room_entry(
        self,
        ui: UIPort,
        speaker: str,
        text: str,
        blocks: list[dict],
        *,
        stream_id: str = "",
        restored: bool = False,
        agent: Optional[dict] = None,
    ) -> None:
        if stream_id or restored or agent:
            kwargs: dict[str, Any] = {"stream_id": stream_id, "restored": restored}
            if agent:
                kwargs["agent"] = agent
            try:
                ui.add_room_entry(speaker, text, blocks, **kwargs)  # type: ignore[call-arg]
                return
            except TypeError:
                pass
            if agent:
                try:
                    ui.add_room_entry(
                        speaker, text, blocks,
                        stream_id=stream_id, restored=restored,
                    )  # type: ignore[call-arg]
                    return
                except TypeError:
                    pass
        ui.add_room_entry(speaker, text, blocks)

    def _add_room_entry(
        self, ui: UIPort, speaker: str, text: str, *, stream_id: str = "",
        agent: Optional[dict] = None,
    ) -> None:
        if agent:
            # a card that is replaced (working → done) keeps ONE history
            # entry, so a reload shows the outcome and not the wait
            for i in range(len(self._room_history) - 1, -1, -1):
                prev = self._room_history[i]
                if prev.meta and prev.meta.get("id") == agent.get("id") \
                        and prev.meta.get("card") == agent.get("card"):
                    self._room_history[i] = DisplayRecord(
                        speaker=speaker, text=text, meta=dict(agent))
                    break
            else:
                self._room_history.append(
                    DisplayRecord(speaker=speaker, text=text, meta=dict(agent)))
        else:
            self._room_history.append(DisplayRecord(speaker=speaker, text=text))
        self._emit_room_entry(
            ui,
            speaker,
            text,
            self._structured_blocks(text),
            stream_id=stream_id,
            agent=agent,
        )
        self._persist_session()

    def _show_room_notice(
        self, ui: UIPort, speaker: str, text: str, *, stream_id: str = "",
    ) -> None:
        self._emit_room_entry(
            ui,
            speaker,
            text,
            self._structured_blocks(text),
            stream_id=stream_id,
        )

    def _maybe_credit_fallback_hint(
        self, model: str, text: str, ui: UIPort,
    ) -> None:
        """If Claude reported a credit/billing exhaustion, tell the user how to
        fall back to the cheaper Claude Opus 5.

        The default Claude participant is Fable 5.1, which bills at a premium; when
        its credit balance runs out the raw CLI error is opaque, so surface the
        exact switch command instead. Suppressed once already on Opus 5 (a bare
        balance problem there needs a top-up, not a model switch).
        """
        if model != "claude" or not is_credit_error(text):
            return
        fallback = "claude-opus-5"
        if fallback in (self.claude.model or ""):
            self._add_room_entry(
                ui,
                "system",
                f"Claude ({self.claude.model}) is out of credits / hit a billing "
                "limit. Add credits at console.anthropic.com/settings/billing to "
                "continue.",
            )
            return
        self._add_room_entry(
            ui,
            "system",
            f"Claude ({self.claude.model}) is out of credits / hit a billing "
            f"limit. Switch to the cheaper Claude Opus 5 with:\n"
            f"    /model @claude {fallback}\n"
            f"or relaunch botference with:  --anthropic-model {fallback}",
        )

    async def _send_message(
        self, parsed: ParsedInput, ui: UIPort,
        *, attachments: list | None = None, watch_links: bool = True,
    ) -> None:
        route = self.router.resolve(parsed)
        # each user turn buys each bot a fresh (small) allowance of questions
        # to Gemini, and of build agents — the budget is per turn, not per chat
        self._gemini_asks = {}
        self._summons = {}

        prefix = f"{route} " if parsed.target else f"(→{route}) "
        if parsed.parallel:
            prefix = "/parallel " + prefix
        self._add_room_entry(ui, "user", prefix + parsed.body)

        # Stage attachments (images, PDFs) to repo-local tmp dir so agents
        # can read them as normal files — no --file flag or tokens needed.
        staged, missing = stage_attachments(attachments or [])
        if missing:
            names = ", ".join(Path(p).name for p in missing)
            self._add_room_entry(
                ui, "system",
                f"⚠ {len(missing)} attachment(s) could not be found and "
                f"were NOT sent to the bots: {names}",
            )
        body = parsed.body
        if staged:
            def _ref(p: str) -> str:
                low = p.lower()
                if low.endswith(".pdf"):
                    return f"[Attached PDF: {p} — read it with your file-reading tool]"
                if low.endswith((".xlsx", ".xls", ".csv")):
                    return (f"[Attached spreadsheet: {p} — read it with your "
                            "tools (python/pandas or openpyxl work well)]")
                if low.endswith((".docx", ".doc")):
                    return (f"[Attached Word document: {p} — extract its text "
                            f"with: textutil -convert txt -stdout '{p}' . To "
                            "hand back an edited version, write a new file "
                            "into the workspace (textutil converts txt/html "
                            "to docx) and tell the user where it is]")
                if low.endswith((".md", ".markdown", ".txt", ".json")):
                    return f"[Attached text file: {p} — read it with your file-reading tool]"
                return f"[Attached image: {p} — view it with your file-reading tool]"
            refs = "\n".join(_ref(p) for p in staged)
            body = f"{body}\n\n{refs}"

        # A YouTube link is watched for the bots (they cannot take video) and
        # the report travels with the message.
        if watch_links:
            body = await self._append_video_reports(body, ui)

        self.transcript.add("user", body)
        self._persist_session()
        await self._maybe_suggest_project(body, ui)

        # Honor any auto-relay queued on a prior round (or restored from disk)
        # before a model takes its next turn — never mid-turn or mid-thread.
        await self._drain_pending_auto_relays(ui)

        targets = (
            ["claude", "codex"] if route == "@all"
            else [route.lstrip("@")]
        )

        last_speaker: Optional[str] = None
        last_resp: Optional[AdapterResponse] = None
        if parsed.parallel:
            await self._send_parallel(body, ui)
            await self._drain_pending_auto_relays(ui)
            return
        for model in targets:
            resp = await self._send_to_model(model, body, ui)
            if resp is None and route == "@all" and model == "claude" and getattr(
                self.claude, "abort_all_on_startup_failure", False
            ):
                self._add_room_entry(
                    ui,
                    "system",
                    "Codex was not started because the interactive Claude "
                    "session failed to start.",
                )
                break
            if resp:
                self.transcript.add(model, resp.text, resp.tool_summaries)
                self._stamp_in_chat_build(model, resp, ui)
                visual_warning = _visual_verification_warning(model, resp)
                if visual_warning:
                    self._add_room_entry(ui, "system", visual_warning)
                    self.transcript.add("system", visual_warning)
                self.transcript.mark_seen(model)
                self._update_pct(model, resp, ui)
                ui.set_status(self.status_snapshot())
                self._persist_session()
                await self._maybe_watch_for_bot(resp.text, ui, model)
                self._maybe_lasso_for_bot(resp.text, ui)
                await self._maybe_summon_for_bot(resp, ui, model)
                last_speaker, last_resp = model, resp

        if (
            self.mode is RoomMode.PUBLIC
            and last_speaker is not None
            and last_resp is not None
        ):
            await self._run_free_form_thread(last_speaker, last_resp, ui)

        # Thread/round is complete — safe to drain anything that crossed the
        # threshold during it, so the relay lands before the next turn.
        await self._drain_pending_auto_relays(ui)

    @staticmethod
    def _response_output_tokens(resp: AdapterResponse) -> int:
        """Best-available output-token count for budget accounting."""
        return (
            resp.turn_output_tokens
            or resp.output_tokens
            or max(1, len(resp.text) // 4)
        )

    def _record_writer_vote(
        self, model: str, footer: RoomFooter, ui: UIPort,
    ) -> None:
        """Track footer `writer` votes; set the lead on bot consensus.

        A vote is remembered per bot (latest wins). When both bots have
        voted for the same writer and no lead was set manually, the lead
        is set automatically — the free-form replacement for the old
        caucus writer vote.
        """
        vote = footer.writer.lstrip("@").lower()
        if vote not in ("claude", "codex"):
            return
        self._ff_writer_votes[model] = vote
        if self.lead != "auto":
            return
        votes = set(self._ff_writer_votes.values())
        if len(self._ff_writer_votes) == 2 and len(votes) == 1:
            self.lead = f"@{vote}"
            self._add_room_entry(
                ui, "system", f"Writer consensus → lead set to {self.lead}"
            )
            ui.set_status(self.status_snapshot())

    async def _run_free_form_thread(
        self, speaker: str, resp: AdapterResponse, ui: UIPort,
    ) -> None:
        """Bot-to-bot floor control after a user-initiated turn.

        Each bot reply may hand the floor to the other bot (footer `next`
        or a prose @mention). The thread runs until a bot hands back to
        @user, stops mentioning anyone, or the budget runs out. Budget
        exhaustion grants one automatic extension, then forces the floor
        back to the user with the last footer summary — the thread pauses
        rather than dies, and any user reply starts a fresh budget.
        """
        turns = 0
        tokens_used = self._response_output_tokens(resp)
        max_turns = _FREE_FORM_MAX_BOT_TURNS
        token_budget = _FREE_FORM_OUTPUT_TOKEN_BUDGET
        extended = False
        current_speaker, current_resp = speaker, resp
        handed_back = False

        while True:
            target = free_form_next_target(current_speaker, current_resp.text)
            if target is None or target == "user":
                handed_back = True
                break

            if self.pending_input_check is not None and self.pending_input_check():
                notice = ("Free-form thread paused — you have queued "
                          "messages; the floor is yours.")
                self._add_room_entry(ui, "system", notice)
                self.transcript.add("system", f"[{notice}]")
                self._persist_session()
                break

            if turns >= max_turns or tokens_used >= token_budget:
                if not extended:
                    extended = True
                    max_turns += _FREE_FORM_EXTENSION_TURNS
                    token_budget += _FREE_FORM_EXTENSION_TOKENS
                    notice = (
                        f"Free-form budget reached — granting one extension "
                        f"(+{_FREE_FORM_EXTENSION_TURNS} turns, "
                        f"+{_FREE_FORM_EXTENSION_TOKENS} tokens)."
                    )
                    self._add_room_entry(ui, "system", notice)
                    self.transcript.add("system", f"[{notice}]")
                else:
                    footer = RoomFooter.parse(current_resp.text)
                    summary = footer.summary if footer else ""
                    notice = "Free-form budget exhausted — the floor returns to you."
                    if summary:
                        notice += f" Last status: {summary}"
                    notice += ' Reply (e.g. "continue") to let them keep going.'
                    self._add_room_entry(ui, "system", notice)
                    self.transcript.add("system", f"[{notice}]")
                    self._persist_session()
                    break

            turns += 1
            status_note = free_form_turn_status(
                turns,
                max_turns,
                tokens_used,
                token_budget,
                last_turn_tokens=self._ff_last_output_tokens.get(target, 0),
                nudge_threshold=_FREE_FORM_TURN_NUDGE_TOKENS,
            )
            self.transcript.add("system", status_note)

            next_resp = await self._send_to_model(target, "", ui)
            if next_resp is None:
                break
            self.transcript.add(target, next_resp.text, next_resp.tool_summaries)
            self._stamp_in_chat_build(target, next_resp, ui)
            visual_warning = _visual_verification_warning(target, next_resp)
            if visual_warning:
                self._add_room_entry(ui, "system", visual_warning)
                self.transcript.add("system", visual_warning)
            self.transcript.mark_seen(target)
            self._update_pct(target, next_resp, ui)
            ui.set_status(self.status_snapshot())
            self._persist_session()
            await self._maybe_watch_for_bot(next_resp.text, ui, target)
            self._maybe_lasso_for_bot(next_resp.text, ui)
            await self._maybe_summon_for_bot(next_resp, ui, target)

            tokens_used += self._response_output_tokens(next_resp)
            current_speaker, current_resp = target, next_resp

        # The floor is going back to the user. If the room said it had
        # CONVERGED, one turn runs first (see _run_verification_turn) — the
        # thread paused by a budget, a queued message or an error is not
        # agreement and gets no check.
        if handed_back:
            await self._run_verification_turn(current_speaker, current_resp, ui)

    # ── the verification turn ─────────────────────────────

    #: Under this many words the "final claim" is a sign-off, not a claim.
    _VERIFY_MIN_WORDS = 40
    #: What rides the envelope, at most. A converged room's last message is a
    #: paragraph; anything longer is clipped rather than allowed to become a
    #: second copy of the discussion.
    _VERIFY_CLAIMS_MAX = 6000

    def _verification_sources(self) -> str:
        """What the room actually has that a claim can be checked against.

        Paths, never contents — the same discipline lasso.attachments_block
        keeps: the bot opens what it needs. Empty means there is nothing to
        check against, and the turn does not run at all. A verification with no
        source would be exactly the second opinion this is built to replace.
        """
        parts: list[str] = []
        block = lasso.attachments_block(self._attachments)
        if block:
            parts.append(block.rstrip())
        plan = self._plan_path
        try:
            if plan.is_file():
                parts.append(f"The plan this room has been writing: {plan}")
        except OSError:
            pass
        project = self._active_project()
        if project is not None:
            files = []
            try:
                files = sorted(
                    p.name for p in project.root.iterdir()
                    if p.is_file() and not p.name.startswith(".")
                )[:20]
            except OSError:
                files = []
            if files:
                parts.append(
                    f"Project {project.title} ({project.id}) at {project.root} — "
                    + ", ".join(files)
                )
        return "\n\n".join(parts)

    async def _run_verification_turn(
        self, speaker: str, resp: "AdapterResponse", ui: UIPort,
    ) -> None:
        """One check against the sources, when the bots say they agree.

        WHY THIS IS NOT A SECOND OPINION. Two bots reasoning from the same
        context converge on wrong facts, and a longer discussion only makes the
        shared premise stickier — so asking the other one "do you agree?" adds
        nothing. What adds something is holding the CLAIM against the SOURCE.
        So the turn goes to the bot that did NOT write the last claim, and its
        envelope carries the claim, the sources, and the instruction — and not
        the thread: `mark_seen` first, so `context_since` has nothing of the
        conversation left to backfill.

        Three ways it does not run, each because the check would be empty:
        /verify off, a final message too short to be a claim, and a room with
        no source to check anything against.
        """
        if not self.verify_enabled:
            return
        footer = RoomFooter.parse(resp.text)
        if footer is None or footer.status != "converged":
            return
        claims = RoomFooter.strip_footer(resp.text).strip()
        if len(claims.split()) < self._VERIFY_MIN_WORDS:
            return
        sources = self._verification_sources()
        if not sources:
            return
        target = "codex" if speaker == "claude" else "claude"
        # …and a fourth: the counterpart has to be IN the room. Starting a
        # second CLI session for the check would cost a whole initial prompt
        # whose transcript backfill is the very discussion this turn is meant
        # not to have seen — the opposite of the point.
        if target not in self._models_initialized:
            return
        envelope = verification_preamble(claims[: self._VERIFY_CLAIMS_MAX], sources)
        self._add_room_entry(
            ui, "system",
            f"Converged — asking {target} to check the claims against the "
            "sources. It is given the claims and the sources, not the "
            "discussion. (/verify off to stop this.)",
        )
        # the whole of "a fresh envelope": everything already said is marked
        # seen, so the only thing this turn carries is the envelope below
        self.transcript.mark_seen(target)
        self.transcript.add("system", envelope)
        self._persist_session()
        v_resp = await self._send_to_model(target, "", ui)
        if v_resp is None:
            return
        text = RoomFooter.strip_footer(v_resp.text).strip()
        if not text:
            return
        # the badge is the model's to write (the envelope asks for it as the
        # first line) — put it back only when it did not, so the transcript
        # never carries it twice
        badged = text if text.startswith(VERIFICATION_BADGE) else f"{VERIFICATION_BADGE}\n{text}"
        self.transcript.add(target, badged, v_resp.tool_summaries)
        self.transcript.mark_seen(target)
        self._update_pct(target, v_resp, ui)
        ui.set_status(self.status_snapshot())
        self._persist_session()

    def steer_active(self, raw: str, ui: UIPort) -> str:
        """Try to inject user input into the currently-running bot turn.

        Mirrors Claude Code's steering: a message typed while a bot works
        is read after its current tool call instead of waiting in the
        queue. Returns the steered model's name, or "" when the input
        should take the normal queued-turn path (no room turn in flight,
        slash command, @mention of another participant, or a transport
        without steering support — Codex's exec mode has none).
        """
        model = self._active_steer_model
        if not model:
            return ""
        parsed = parse_input(raw)
        if parsed.kind is not InputKind.MESSAGE or not parsed.body:
            return ""
        if parsed.target and parsed.target != f"@{model}":
            return ""
        adapter = self.claude if model == "claude" else self.codex
        steer = getattr(adapter, "steer", None)
        if steer is None or not steer(
            f"[User interjects mid-turn:]\n{parsed.body}"
        ):
            return ""
        # Recorded before the bot's reply so the shared transcript keeps
        # true order; if the turn dies before the bot reads it, the entry
        # stays unseen and reaches the model next turn via backfill.
        self.transcript.add("user", parsed.body)
        self._add_room_entry(ui, "user", f"(↪@{model}) {parsed.body}")
        return model

    async def _send_to_model(
        self, model: str, message: str, ui: UIPort,
    ) -> Optional[AdapterResponse]:
        # Mark the active speaker so input typed mid-turn can be steered
        # into this turn (bridge submit → steer_active).
        self._active_steer_model = model
        try:
            return await self._send_to_model_inner(model, message, ui)
        finally:
            self._active_steer_model = ""

    async def _send_to_model_inner(
        self, model: str, message: str, ui: UIPort,
    ) -> Optional[AdapterResponse]:
        adapter = self.claude if model == "claude" else self.codex
        codex_before_diff = (
            _worktree_diff_snapshot(self.paths.project_root)
            if model == "codex"
            else None
        )

        if model not in self._models_initialized:
            handoff_doc = self._pending_relay_handoffs.get(model)
            relay_turn = self.relay_boundary(model) if handoff_doc else None
            resp = await self._start_model_session(
                model,
                ui,
                handoff_doc=handoff_doc,
                after_turn=relay_turn,
                stream=True,
                pane="room",
            )
            if resp is None:
                return None
            self.transcript.mark_seen(model)
        else:
            # Resume — the user entry is already in the transcript (added
            # by _send_message before dispatch), so context_since picks it
            # up.  Passing "" avoids injecting the user message twice.
            context = self.transcript.context_since(model, "")
            # …and the attachments block on EVERY turn, not only the first: a
            # resumed session's replayed history is uneven and a relay drops it
            # whole, so the only thing a turn can rely on carrying is the turn.
            # It is cheap (one line per attachment, capped) and it is the whole
            # of how a bot knows the file is there to be read.
            block = lasso.attachments_block(self._attachments)
            if block:
                context = f"{block}\n{context}"
            try:
                resp = await self._run_adapter_streamed(
                    adapter,
                    model,
                    "room",
                    ui,
                    lambda: adapter.resume(context),
                )
            except Exception as e:
                self._add_room_entry(ui, "system", f"Error from {model}: {e}")
                return None

        for _ in range(3):
            permission_request = _extract_write_access_request(resp.text)
            if not permission_request:
                break
            follow_up = await self._handle_write_access_request(
                model,
                permission_request,
                ui,
            )
            try:
                resp = await self._run_adapter_streamed(
                    adapter,
                    model,
                    "room",
                    ui,
                    lambda: adapter.resume(follow_up),
                )
            except Exception as e:
                self._add_room_entry(ui, "system", f"Error from {model}: {e}")
                return None
        else:
            self._add_room_entry(
                ui,
                "system",
                f"{model.capitalize()} hit the write-permission request limit for one turn.",
            )
            return None

        if model == "codex" and codex_before_diff is not None:
            diff_blocks = _codex_worktree_diff_blocks(
                self.paths.project_root,
                codex_before_diff,
            )
            if diff_blocks:
                resp.tool_summaries.append(ToolSummary(
                    id=f"codex-diff-{len(resp.tool_summaries)}",
                    name="Diff",
                    input_preview="",
                    output_preview="worktree changed",
                    output_blocks=diff_blocks,
                ))

        tool_display = _tool_summary_display_text(resp.tool_summaries)
        if tool_display:
            self._emit_room_entry(
                ui,
                model,
                tool_display,
                _tool_summary_display_blocks(resp.tool_summaries),
                stream_id=f"{resp.stream_id}:tools" if resp.stream_id else "",
            )
        # The JSON room footer drives routing; keep it in the transcript
        # (models use it) but strip it from the display.
        display_text = RoomFooter.strip_footer(resp.text)
        if display_text:
            self._add_room_entry(ui, model, display_text, stream_id=resp.stream_id)
        footer = RoomFooter.parse(resp.text)
        if footer is not None:
            self._record_writer_vote(model, footer, ui)
        self._ff_last_output_tokens[model] = self._response_output_tokens(resp)
        if resp.exit_code == -1:
            self._add_room_entry(
                ui,
                "system",
                f"{model.capitalize()} CLI timed out. Run /auth {model} to check login state. "
                f"If auth looks fine, /relay @{model} will reset the session.",
            )
        if resp.exit_code not in (0, -1):
            self._add_room_entry(ui, "system", f"{model} exited with code {resp.exit_code}")
            # Detect subscription rate limit and suggest API key fallback
            if "usage limit" in resp.text.lower():
                key_name = ("OPENAI_API_KEY" if model == "codex"
                            else "ANTHROPIC_API_KEY")
                self._add_room_entry(
                    ui,
                    "system",
                    f"Tip: Add {key_name}=... to .botference/.env to use API "
                    f"key auth as a fallback. See .env.example for details.",
                )
        self._maybe_credit_fallback_hint(model, resp.text, ui)
        return resp

    def _build_initial_prompt(
        self, model: str, *,
        handoff_doc: str | None = None,
        after_turn: int | None = None,
    ) -> str:
        """System prompt + task + transcript backfill for late-joining models.

        When *handoff_doc* is provided the prompt includes the handoff and
        limits transcript backfill to entries after *after_turn* (the relay
        boundary).
        """
        name = model.capitalize()
        other = "Codex" if model == "claude" else "Claude"
        parts = [room_preamble(name, other, self._plan_write_roots_display())]
        parts.append(free_form_protocol(name, other))
        web_note = web_access_note(model)
        if web_note:
            parts.append(web_note)
        agents_note = subagents_note(model)
        if agents_note:
            parts.append(agents_note)
        parts.append(deliverables_note())
        parts.append(recommendations_note())
        parts.append(video_watch_note())
        parts.append(lasso_note())
        parts.append(quote_check_note())
        tasks_note = self._project_tasks_note()
        if tasks_note:
            parts.append(tasks_note)
        skill_context = project_skill_context(
            model,
            [self.paths.project_root, self.paths.botference_home],
        )
        if skill_context:
            parts.append(skill_context)
        if self.system_prompt:
            parts.extend(["--- System Prompt ---", self.system_prompt])
        if self.task:
            parts.extend(["--- Task ---", self.task])
        if handoff_doc:
            parts.extend(["--- Handoff ---", handoff_doc])
            backfill = self.transcript.context_after(
                after_turn if after_turn is not None else -1,
            )
        else:
            backfill = self.transcript.context_since(model, "")
        # What the user has lassoed into this chat: one line each — title,
        # kind, PATH, a sentence — and never the contents. An attachment is a
        # file the bots open when it matters, exactly as the plugin's page
        # snapshot is (SPEC "BOTS READ THE WHOLE DOCUMENT").
        block = lasso.attachments_block(self._attachments)
        if block:
            parts.append(block)
        parts.extend(["--- Room History ---", backfill])
        return "\n\n".join(parts)

    async def _handle_write_access_request(
        self,
        model: str,
        request: tuple[str, str],
        ui: UIPort,
    ) -> str:
        raw_path, reason = request
        resolved, error = self._resolve_requested_write_root(raw_path)
        if resolved is None:
            self._add_room_entry(
                ui,
                "system",
                f"Ignored invalid write-access request from {model}: {raw_path} ({error}).",
            )
            self.transcript.add(
                "system",
                f"[Ignored invalid write-access request from {model}: {raw_path} ({error})]",
            )
            self._persist_session()
            return (
                "Your write-access request was invalid. Continue without editing "
                "outside the current writable roots and explain the limitation."
            )

        rel_path = self._relative_project_path(resolved)
        if self._is_write_root_allowed(resolved):
            return (
                f"Write access to {rel_path} is already available. Continue with the pending task."
            )

        approved = await ui.request_write_permission(
            WritePermissionRequest(
                request_id=str(uuid.uuid4()),
                model=model,
                path=rel_path,
                reason=reason,
            )
        )
        if approved:
            granted_path = self._grant_plan_write_root(resolved)
            self._add_room_entry(
                ui,
                "system",
                f"Granted write access to {granted_path} for this planner session.",
            )
            self.transcript.add(
                "system",
                f"[Granted write access to {granted_path} for this planner session]",
            )
            self._persist_session()
            return (
                f"Write access to {granted_path} is now approved for this planner session. "
                "Continue with the pending task."
            )

        self._add_room_entry(
            ui,
            "system",
            f"Denied write access to {rel_path}.",
        )
        self.transcript.add("system", f"[Denied write access to {rel_path}]")
        self._persist_session()
        return (
            f"Write access to {rel_path} was denied. Continue without editing "
            "outside the current writable roots, and explain any remaining limitation."
        )

    def _update_pct(self, model: str, resp: AdapterResponse,
                    ui: Optional[UIPort] = None) -> None:
        adapter = self.claude if model == "claude" else self.codex
        yield_pct = adapter.context_percent(resp)
        tokens = adapter.context_tokens(resp)
        window = resp.context_window or 200_000
        raw_pct = (tokens / window * 100) if (tokens is not None and window) else 0.0

        self._yield_pressure[model] = yield_pct if yield_pct is not None else 0.0

        if getattr(resp, "context_overflow", False):
            # The CLI reported a context-window overflow. Force maximum yield
            # pressure so a relay uses the mechanical tier, and surface an
            # actionable prompt. With the bounded relay backfill, /relay now
            # rebuilds a fresh, fitting session instead of overflowing again.
            self._yield_pressure[model] = max(
                self._yield_pressure.get(model, 0.0), 999.0)
            if ui is not None and model not in self._warned_overlimit_models:
                self._warned_overlimit_models.add(model)
                self._add_room_entry(
                    ui,
                    "system",
                    f"⚠ {model.capitalize()} hit its context-window limit. "
                    f"Run /relay @{model} to continue in a fresh session with a "
                    "handoff (older history is summarized, recent turns kept).",
                )

        if model == "claude":
            self._claude_pct = raw_pct
            self._claude_tokens = tokens
            self._claude_window = window
        else:
            self._codex_pct = raw_pct
            self._codex_tokens = tokens
            self._codex_window = window

        if (ui is not None and yield_pct is not None and yield_pct > 100
                and tokens is not None
                and model not in self._warned_overlimit_models):
            self._warned_overlimit_models.add(model)
            self._add_room_entry(
                ui,
                "system",
                f"⚠ {model.capitalize()} last turn used {tokens:,} / {window:,} "
                f"tokens ({raw_pct:.0f}% of window), above botference's yield "
                f"threshold. Consider yielding.",
            )

        self._maybe_arm_auto_relay(model, raw_pct, ui)

    def _maybe_arm_auto_relay(
        self, model: str, raw_pct: float, ui: Optional[UIPort],
    ) -> None:
        """Queue an auto-relay when *model* crosses the occupancy threshold.

        Re-arms only after occupancy drops back below the threshold, so a single
        crossing queues exactly one relay — no loop while the model sits high or
        while its relay is pending. The relay itself is deferred (never fired
        here) so it can't land mid-turn; the drain runs at round boundaries.
        """
        if raw_pct < AUTO_RELAY_THRESHOLD_PCT:
            self._auto_relay_armed[model] = True
            return
        if not self.auto_relay or model not in self._models_initialized:
            return
        if model in self._pending_auto_relay:
            return
        if not self._auto_relay_armed.get(model, True):
            return
        self._auto_relay_armed[model] = False
        self._pending_auto_relay.add(model)
        if ui is not None:
            self._add_room_entry(
                ui,
                "system",
                f"Auto-relay: {model} crossed {AUTO_RELAY_THRESHOLD_PCT}% "
                "context — relaying with handoff.",
            )

    async def _drain_pending_auto_relays(self, ui: UIPort) -> None:
        """Relay any models queued for auto-relay at a safe round boundary.

        Reuses the manual /relay machinery. The relay's fresh session reports
        low occupancy, which re-arms the model via _update_pct.
        """
        if not self._pending_auto_relay:
            return
        for model in ("claude", "codex"):
            if model not in self._pending_auto_relay:
                continue
            self._pending_auto_relay.discard(model)
            if model in self._models_initialized:
                await self._relay_model(model, ui)

    # ── session bootstrap ────────────────────────────────

    async def _ensure_initialized(self, model: str, ui: UIPort) -> bool:
        """Bootstrap a model session if it hasn't started yet.

        Returns True if the model is ready, False on init failure.
        The initial prompt includes transcript backfill so late-joining
        models see prior discussion. Relay handoffs are consumed only from
        in-process controller state, never from persisted live files.
        """
        if model in self._models_initialized:
            return True

        handoff_doc = self._pending_relay_handoffs.get(model)
        relay_turn = self.relay_boundary(model) if handoff_doc else None
        resp = await self._start_model_session(
            model,
            ui,
            handoff_doc=handoff_doc,
            after_turn=relay_turn,
        )
        if resp is None:
            return False
        self._update_pct(model, resp, ui)
        self.transcript.mark_seen(model)
        ui.set_status(self.status_snapshot())
        return True

    # ── /adopt ────────────────────────────────────────────

    def _native_claude_projects_dir(self) -> Path:
        """Native Claude Code session store for the planner's working dir."""
        cwd = getattr(self.claude, "cwd", "") or str(self.paths.project_root)
        slug = str(Path(cwd).resolve()).replace("/", "-")
        return Path.home() / ".claude" / "projects" / slug

    async def _run_adopt(self, arg: str, ui: UIPort) -> None:
        """Attach a pre-existing native Claude Code chat as this room's
        Claude session, then have Claude brief the room so Codex can join."""
        if "claude" in self._models_initialized or self.claude.session_id:
            self._add_room_entry(
                ui, "system",
                "Claude already has a live session in this chat — /adopt "
                "needs a fresh chat (restart, or /resume another).",
            )
            return

        projects_dir = self._native_claude_projects_dir()
        sessions = list_native_claude_sessions(projects_dir)
        # Hide chats botference itself created for this session store.
        own_ids = {self.session_id}
        sessions = [s for s in sessions if s.session_id not in own_ids]
        prefix = arg.strip().lower()
        if prefix:
            sessions = [s for s in sessions if s.session_id.startswith(prefix)]
        if not sessions:
            self._add_room_entry(
                ui, "system",
                f"No native Claude Code chats found in {projects_dir} "
                + (f"matching '{prefix}'." if prefix else
                   "(run /adopt from the folder where you had the chat)."),
            )
            return

        chosen: Optional[NativeClaudeSession] = None
        if prefix and len(sessions) == 1:
            chosen = sessions[0]
        else:
            request_choice = getattr(ui, "request_choice", None)
            if request_choice is None:
                listing = "\n".join(
                    f"  {s.session_id[:8]}  ({_age_label(s.mtime)})  {s.snippet[:60]}"
                    for s in sessions
                )
                self._add_room_entry(
                    ui, "system",
                    "Native Claude Code chats here:\n" + listing
                    + "\nRun /adopt <id-prefix> to pick one.",
                )
                return
            labels = [
                f"{_age_label(s.mtime)} — {s.snippet[:70]}"
                for s in sessions
            ]
            index = await request_choice(
                "Adopt which Claude Code chat?", labels,
            )
            if index is None or not (0 <= index < len(sessions)):
                self._add_room_entry(ui, "system", "Adopt cancelled.")
                return
            chosen = sessions[index]

        # Programmatic transport: the native session is live immediately
        # (True → next call resumes it). Tmux transport: the pane launches
        # with `claude --resume <id>` on the first send (False → let the
        # normal bootstrap start it, initial prompt included).
        adopt = getattr(self.claude, "adopt_native_session", None)
        if adopt is not None:
            live_now = adopt(chosen.session_id)
        else:
            self.claude.session_id = chosen.session_id
            live_now = True
        if live_now:
            self._models_initialized.add("claude")
        name = "Claude"
        other = "Codex"
        self.transcript.add(
            "system",
            adopt_room_note(name, other, self._plan_write_roots_display()),
        )
        self._add_room_entry(
            ui, "system",
            f"Adopted Claude Code chat {chosen.session_id[:8]} "
            f"({_age_label(chosen.mtime)} old: “{chosen.snippet[:60]}…”). "
            "Asking Claude for a room handoff…",
        )
        self._persist_session()

        resp = await self._send_to_model("claude", "", ui)
        if resp is None or resp.exit_code != 0:
            # Adoption failed (e.g. the native session no longer resumes);
            # roll back so the room stays usable.
            if adopt is not None:
                adopt("")
            else:
                self.claude.session_id = ""
            self._models_initialized.discard("claude")
            self._add_room_entry(
                ui, "system",
                "Adopt failed — the native session did not resume. "
                "The room is back to a fresh state.",
            )
            self._persist_session()
            return
        self.transcript.add("claude", resp.text, resp.tool_summaries)
        self.transcript.mark_seen("claude")
        self._update_pct("claude", resp, ui)
        ui.set_status(self.status_snapshot())
        self._persist_session()
        await self._run_free_form_thread("claude", resp, ui)

    # ── chat lifecycle: /new, /file, /delete ──────────────

    _NEW_USAGE = (
        "Usage: /new [title]\n"
        "       /new --project <project-id> [title]   file it in a project\n"
        "       /new --inbox [title]                  leave it unfiled"
    )

    def _parse_new_args(self, body: str) -> tuple[str, str | None, str]:
        """Split ``/new`` arguments into (title, filing, error).

        ``filing`` is the project id to file the new chat under, ``""`` for a
        deliberate Inbox chat, or ``None`` for "no preference stated" (the
        chat inherits the project you are sitting in, as /new always has).
        The distinction matters: the council web's new-chat dropdown makes
        the user say which one they mean up front, and "just a chat" has to
        survive being clicked while a project is open.
        """
        raw = body.strip()
        if raw.startswith("--inbox"):
            return raw[len("--inbox"):].strip(), "", ""
        if raw.startswith("--project"):
            rest = raw[len("--project"):].strip()
            if not rest:
                return "", None, self._NEW_USAGE
            parts = rest.split(None, 1)
            project = self.project_store.get(parts[0])
            if not project:
                return "", None, (
                    f"No project matched '{parts[0]}'.\n\n"
                    "Run /projects to list available projects."
                )
            return (parts[1].strip() if len(parts) > 1 else ""), project.id, ""
        return raw, None, ""

    def _start_new_chat(
        self, title: str, ui: UIPort, *, filing: str | None = None,
    ) -> None:
        """Persist the current chat and start a fresh one in place.

        *filing* is the new chat's project: a project id files it there, ``""``
        forces Inbox, and ``None`` inherits the project you are sitting in.
        Creation is the one moment where inheriting the lens is honest — the
        user is standing inside a project when they ask for a new chat — but
        it is written into ``session_project_id`` once, here, and never
        re-derived on later saves. Both model sessions start clean.
        """
        old_label = self._session_title()
        had_content = bool(self.transcript.entries)
        self._persist_session()

        self.session_id = str(uuid.uuid4())
        self.created_at = iso_now()
        self.updated_at = self.created_at
        self.custom_title = _clean_session_title(title) if title.strip() else ""
        # Stamp the filing exactly once (see the docstring). A named project
        # also moves the lens, so the new chat opens with that project's files
        # and plan already in context — the whole point of "+ new chat" inside
        # a project row.
        if filing is None:
            self.session_project_id = self.active_project_id
            self._inbox_by_choice = False
        else:
            self.session_project_id = filing
            self.active_project_id = filing
            # --inbox is an answer, not a shrug (see _inbox_by_choice)
            self._inbox_by_choice = filing == ""
        self.transcript = Transcript()
        # (entry count, title) at last persist — persists that change neither
        # leave updated_at alone (see _persist_session)
        self._persisted_activity: tuple[int, str] = (0, "")
        self.router = AutoRouter()
        self.mode = RoomMode.PUBLIC
        self.lead = "auto"
        self._room_history = []
        self._ff_writer_votes = {}
        self._ff_last_output_tokens = {}
        self._models_initialized = set()
        self._warned_overlimit_models = set()
        self._yield_pressure = {}
        self._relay_boundary = {}
        self._pending_relay_handoffs = {}
        self._pending_auto_relay = set()
        self._auto_relay_armed = {}
        self._claude_pct = self._codex_pct = None
        self._claude_tokens = self._claude_window = None
        self._codex_tokens = self._codex_window = None
        self.claude.session_id = ""
        self.codex.thread_id = ""
        self._set_claude_subagents(False)  # grants are per-chat

        ui.clear_panes()
        ui.set_mode(self.mode)
        ui.set_status(self.status_snapshot())
        self._sync_project_ui(ui)
        note = "Started a new chat"
        if self.custom_title:
            note += f": {self.custom_title}"
        # Say where it landed, so "file in project / just a chat" is a
        # decision the user can see the result of instead of guessing.
        filed = self._active_project() if self.session_project_id else None
        if filed:
            note += f" in {filed.title}"
        elif filing == "":
            note += " in Inbox"
        if had_content:
            note += f". The previous chat ({old_label}) is saved — /resume brings it back."
        else:
            note += "."
        self._show_room_notice(ui, "system", note)
        # Lazy persist: the new chat only hits disk once something happens.
        self._persist_session()

    async def _run_file(self, arg: str, ui: UIPort) -> None:
        """File the current chat under a project (picker when no args)."""
        if arg.strip():
            self._assign_session_to_project(arg, ui)
            return

        projects = self.project_store.list_projects()
        request_choice = getattr(ui, "request_choice", None)
        if request_choice is None:
            self._add_room_entry(
                ui, "system",
                "Usage: /file <project-id>  (see /projects for ids)",
            )
            return
        options = [f"File under {p.title}" for p in projects]
        options.append("Create a new project from this chat")
        options.append("Cancel")
        choice = await request_choice("File this chat where?", options)
        if choice is None or not 0 <= choice < len(options) or choice == len(options) - 1:
            return
        if choice < len(projects):
            project = projects[choice]
            self._activate_project(project, ui)
            self._add_room_entry(
                ui, "system",
                f"Filed this chat under {project.title} ({project.id}) — "
                "it is now the active project.\n"
                f"Plan writes now target "
                f"{self._planning_display_path(self._plan_path)}.",
            )
            return
        title = _project_title_from_session_title(self._session_title())
        self._create_project(title, ui)

    async def _run_delete(self, arg: str, ui: UIPort) -> None:
        """Delete a saved chat (picker + confirm; deleting the current chat
        rolls into a fresh one)."""
        prefix = arg.strip()
        request_choice = getattr(ui, "request_choice", None)

        candidates = [
            s for s in self.session_store.list_summaries(limit=200)
        ]
        if prefix:
            matches = [s for s in candidates
                       if s.session_id.startswith(prefix)]
            if not matches and self.session_id.startswith(prefix):
                target_id, target_label = self.session_id, self._session_title()
            elif len(matches) == 1:
                target_id = matches[0].session_id
                target_label = matches[0].title or target_id[:8]
            elif not matches:
                self._add_room_entry(
                    ui, "system",
                    f"No saved chat matched '{prefix}'. /resume lists them.",
                )
                return
            else:
                self._add_room_entry(
                    ui, "system",
                    f"'{prefix}' is ambiguous ({len(matches)} chats). "
                    "Use a longer prefix.",
                )
                return
        else:
            if request_choice is None:
                self._add_room_entry(
                    ui, "system",
                    "Usage: /delete <session-id-prefix>  (/resume lists ids)",
                )
                return
            recent = candidates[:8]
            if not recent:
                self._add_room_entry(ui, "system", "No saved chats to delete.")
                return
            labels = [
                ("(this chat) " if s.session_id == self.session_id else "")
                + f"{s.title or s.session_id[:8]}"
                for s in recent
            ]
            labels.append("Cancel")
            index = await request_choice("Delete which chat?", labels)
            if index is None or not 0 <= index < len(recent):
                return
            target_id = recent[index].session_id
            target_label = recent[index].title or target_id[:8]

        if request_choice is not None:
            confirm = await request_choice(
                f"Delete “{target_label}” permanently? This cannot be undone.",
                ["Delete it", "Cancel"],
            )
            if confirm != 0:
                self._add_room_entry(ui, "system", "Delete cancelled.")
                return
        elif not prefix or len(prefix) < 8:
            self._add_room_entry(
                ui, "system",
                "No picker available to confirm — pass at least 8 characters "
                "of the id: /delete <longer-prefix>",
            )
            return

        self.session_store.delete(target_id)
        self.project_store.dissociate_session(target_id)
        if target_id == self.session_id:
            # The chat we're sitting in is gone — roll into a fresh one
            # without re-persisting the old id.
            self._restoring_session = True
            try:
                self.transcript = Transcript()
                self.custom_title = ""
                self._models_initialized = set()
            finally:
                self._restoring_session = False
            self._start_new_chat("", ui)
            self._add_room_entry(
                ui, "system", f"Deleted this chat ({target_label}).",
            )
        else:
            self._sync_project_ui(ui)
            self._add_room_entry(ui, "system", f"Deleted “{target_label}”.")

    # ── chat archive: /archive, /unarchive ────────────────
    #
    # Archiving is the reversible half of /delete: the session JSON moves to
    # archive/sessions/ (BOTFERENCE_ARCHIVE_DIR), so the chat drops out of
    # every listing while every byte survives. /unarchive moves it back.

    async def _resolve_saved_chat(
        self,
        prefix: str,
        summaries: list,
        *,
        prompt: str,
        empty_note: str,
        ui: UIPort,
        allow_current: bool = False,
    ) -> tuple[str, str] | None:
        """Resolve one saved chat by id-prefix, or ask the user to pick.

        Returns (session_id, label), or None when nothing matched, the list
        was empty, or the user cancelled (a note is posted either way).
        """
        def label_of(summary) -> str:
            return summary.title or summary.session_id[:8]

        prefix = prefix.strip()
        if prefix:
            matches = [s for s in summaries if s.session_id.startswith(prefix)]
            if not matches and allow_current and self.session_id.startswith(prefix):
                return self.session_id, self._session_title()
            if len(matches) == 1:
                return matches[0].session_id, label_of(matches[0])
            if not matches:
                self._add_room_entry(
                    ui, "system", f"No chat matched '{prefix}'.",
                )
                return None
            self._add_room_entry(
                ui, "system",
                f"'{prefix}' is ambiguous ({len(matches)} chats). "
                "Use a longer prefix.",
            )
            return None

        if not summaries:
            self._add_room_entry(ui, "system", empty_note)
            return None

        request_choice = getattr(ui, "request_choice", None)
        if request_choice is None:
            # No picker (headless/scripted UI): print ids to pass explicitly.
            lines = [prompt] + [
                f"  {s.session_id[:8]} — {label_of(s)}" for s in summaries[:20]
            ]
            self._add_room_entry(ui, "system", "\n".join(lines))
            return None

        recent = summaries[:8]
        labels = [
            ("(this chat) " if s.session_id == self.session_id else "")
            + label_of(s)
            for s in recent
        ]
        labels.append("Cancel")
        index = await request_choice(prompt, labels)
        if index is None or not 0 <= index < len(recent):
            return None
        return recent[index].session_id, label_of(recent[index])

    def _show_archived_chats(self, ui: UIPort) -> None:
        summaries = self.session_store.list_archived_summaries()
        if not summaries:
            self._add_room_entry(
                ui, "system",
                "No archived chats. /archive [<id-prefix>] puts one here.",
            )
            return
        lines = ["Archived chats:"]
        for summary in summaries[:30]:
            lines.append(
                f"  {summary.session_id[:8]} — "
                f"{summary.title or 'Untitled'} ({summary.entry_count} entries)"
            )
        lines.extend([
            "",
            f"Files live in {self._relative_project_path(self.paths.archived_session_dir)}/.",
            "Use /unarchive <id-prefix> to bring one back.",
        ])
        self._add_room_entry(ui, "system", "\n".join(lines))

    async def _run_archive(self, arg: str, ui: UIPort) -> None:
        """Archive a saved chat (picker without args; `/archive list` shows
        what is already archived)."""
        prefix = arg.strip()
        if prefix.lower() in ("list", "ls"):
            self._show_archived_chats(ui)
            return

        target = await self._resolve_saved_chat(
            prefix,
            self.session_store.list_summaries(limit=200),
            prompt="Archive which chat?",
            empty_note="No saved chats to archive.",
            ui=ui,
            allow_current=True,
        )
        if target is None:
            return
        target_id, target_label = target

        if target_id == self.session_id:
            # Save the chat we're sitting in and step into a fresh one first,
            # so nothing re-creates the file we're about to move.
            self._start_new_chat("", ui)

        if not self.session_store.archive(target_id):
            self._add_room_entry(
                ui, "system",
                f"“{target_label}” is no longer on disk — nothing to archive.",
            )
            return
        self._sync_project_ui(ui)
        self._add_room_entry(
            ui, "system",
            f"Archived “{target_label}”. Nothing was deleted — the chat is in "
            f"{self._relative_project_path(self.paths.archived_session_dir)}/; "
            f"/unarchive {target_id[:8]} brings it back.",
        )

    async def _run_unarchive(self, arg: str, ui: UIPort) -> None:
        """Restore an archived chat to the active listing (picker without args)."""
        target = await self._resolve_saved_chat(
            arg,
            self.session_store.list_archived_summaries(),
            prompt="Restore which archived chat?",
            empty_note="No archived chats. /archive [<id-prefix>] puts one here.",
            ui=ui,
        )
        if target is None:
            return
        target_id, target_label = target

        if not self.session_store.unarchive(target_id):
            self._add_room_entry(
                ui, "system",
                f"Could not restore “{target_label}” — an active chat with "
                "that id already exists (the archived copy is untouched).",
            )
            return
        self._sync_project_ui(ui)
        self._add_room_entry(
            ui, "system",
            f"Restored “{target_label}”. /resume {target_id[:8]} opens it.",
        )

    # ── /draft ────────────────────────────────────────────

    async def _run_draft(self, ui: UIPort, draft_arg: str = "") -> None:
        lead = self._resolve_lead()
        if not lead:
            self._add_room_entry(
                ui, "system",
                "No lead set. Use /lead @claude|@codex, or let the bots "
                "agree on a writer in discussion.",
            )
            return

        arg = draft_arg.strip()
        if not arg:
            rounds = 2
        elif re.fullmatch(r"\d+", arg):
            rounds = int(arg)
        else:
            self._add_room_entry(
                ui, "system",
                "Usage: /draft [rounds]  where rounds is 0, 1, 2, ...",
            )
            return

        self.mode = RoomMode.DRAFT
        ui.set_mode(RoomMode.DRAFT)
        plan_display = self._planning_display_path(self._plan_path)
        self._add_room_entry(
            ui, "system",
            f"Drafting {plan_display} ({lead}, {rounds} AI review round(s))…",
        )

        if not await self._ensure_initialized(lead, ui):
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        reviewer = "codex" if lead == "claude" else "claude"
        if rounds > 0 and not await self._ensure_initialized(reviewer, ui):
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        adapter = self.claude if lead == "claude" else self.codex
        rev_adapter = self.codex if lead == "claude" else self.claude
        lead_cap = lead.capitalize()
        reviewer_cap = reviewer.capitalize()

        current_plan = self._current_plan_text()
        if current_plan:
            prompt = (
                "Update the current implementation plan based on the discussion so far.\n\n"
                f"Current implementation plan:\n\n{current_plan}\n\n"
                "Return the full updated implementation plan as clean markdown."
                "\nReturn only the document markdown — do not append the room "
                "footer; your response is written to a file verbatim."
            )
        else:
            prompt = WRITER_PREAMBLE

        current_plan = await self._draft_plan_turn(lead, prompt, ui)
        if current_plan is None:
            return

        next_round = self._next_reviewer_round()
        completed_rounds = 0
        for round_number in range(next_round, next_round + rounds):
            if self.pending_input_check is not None and self.pending_input_check():
                self._add_room_entry(
                    ui, "system",
                    "Draft paused — you have queued messages; the plan so far "
                    "is saved. Run /draft again to resume review rounds.",
                )
                break

            self.mode = RoomMode.REVIEW
            ui.set_mode(RoomMode.REVIEW)
            self._add_room_entry(
                ui, "system",
                f"{reviewer_cap} is reviewing draft round {round_number}…",
            )
            try:
                rev_resp = await self._run_adapter_streamed(
                    rev_adapter,
                    reviewer,
                    "room",
                    ui,
                    lambda: rev_adapter.resume(
                        reviewer_preamble(lead_cap, current_plan)
                    ),
                )
            except Exception as e:
                self._add_room_entry(ui, "system", f"Error reviewing: {e}")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                return

            self._update_pct(reviewer, rev_resp, ui)
            # The footer is flow-control metadata: keep it in the transcript,
            # strip it from the display and the saved comments file.
            review_footer = RoomFooter.parse(rev_resp.text)
            review_text = RoomFooter.strip_footer(rev_resp.text)
            self._add_room_entry(
                ui, reviewer, review_text, stream_id=rev_resp.stream_id,
            )
            self.transcript.add(reviewer, rev_resp.text, rev_resp.tool_summaries)
            self._persist_session()
            self.transcript.mark_seen(reviewer)

            review_path = self._reviewer_comments_path(round_number)
            self._write_work_file(review_path, review_text)
            self._add_room_entry(
                ui, "system",
                f"Saved reviewer comments to {self._planning_display_path(review_path)}",
            )

            if review_footer is not None and review_footer.status == "converged":
                completed_rounds += 1
                self._add_room_entry(
                    ui, "system",
                    f"{reviewer_cap} signed off on the plan — no revision needed.",
                )
                break

            if review_footer is not None and (
                review_footer.status == "blocked"
                or review_footer.next.lstrip("@").lower() == "user"
            ):
                summary = f" {review_footer.summary}" if review_footer.summary else ""
                self._add_room_entry(
                    ui, "system",
                    f"{reviewer_cap} needs your input before revising —"
                    f" draft paused.{summary} The comments are saved; reply in"
                    " the room, then run /draft to revise.",
                )
                break

            self.mode = RoomMode.DRAFT
            ui.set_mode(RoomMode.DRAFT)
            self._add_room_entry(
                ui, "system",
                f"{lead_cap} is revising {self._planning_display_path(self._plan_path)} "
                f"for round {round_number}…",
            )
            revised_plan = await self._draft_plan_turn(
                lead,
                revision_from_plan_preamble(
                    current_plan, reviewer_cap, review_text, round_number
                ),
                ui,
                error_label="revising",
            )
            if revised_plan is None:
                return
            current_plan = revised_plan
            completed_rounds += 1

        self.mode = RoomMode.PUBLIC
        ui.set_mode(RoomMode.PUBLIC)
        ui.set_status(self.status_snapshot())
        self._add_room_entry(
            ui, "system",
            (
                "Draft complete. "
                f"{self._planning_display_path(self._plan_path)} now reflects "
                f"{completed_rounds} AI review round(s)."
            ),
        )

    async def _draft_plan_turn(
        self, lead: str, prompt: str, ui: UIPort, *, error_label: str = "drafting",
    ) -> Optional[str]:
        """One streamed lead turn whose response becomes implementation-plan.md.

        Returns the plan text written to disk, or None on error (mode is
        reset to PUBLIC before returning). Any room footer the model appends
        despite instructions is stripped before the file write.
        """
        adapter = self.claude if lead == "claude" else self.codex
        try:
            resp = await self._run_adapter_streamed(
                adapter, lead, "room", ui, lambda: adapter.resume(prompt),
            )
        except Exception as e:
            self._add_room_entry(ui, "system", f"Error {error_label}: {e}")
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return None

        self._update_pct(lead, resp, ui)
        plan_text = RoomFooter.strip_footer(resp.text)
        self._add_room_entry(ui, lead, plan_text, stream_id=resp.stream_id)
        self.transcript.add(lead, resp.text, resp.tool_summaries)
        self._persist_session()
        self.transcript.mark_seen(lead)
        self._write_planning_file(self._plan_path, plan_text)
        self._add_room_entry(
            ui, "system",
            f"Updated {self._planning_display_path(self._plan_path)}",
        )
        return plan_text

    # ── /finalize ─────────────────────────────────────────

    async def _run_finalize(self, ui: UIPort) -> None:
        lead = self._resolve_lead()
        if not lead:
            self._add_room_entry(
                ui, "system",
                "No lead set. Use /lead @claude|@codex, or let the bots "
                "agree on a writer in discussion.",
            )
            return

        lead_cap = lead.capitalize()
        if not await self._ensure_initialized(lead, ui):
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        adapter = self.claude if lead == "claude" else self.codex
        self.mode = RoomMode.DRAFT
        ui.set_mode(RoomMode.DRAFT)
        current_plan = self._current_plan_text()
        if not current_plan:
            self._add_room_entry(
                ui, "system",
                f"No drafted plan found at {self._planning_display_path(self._plan_path)}. "
                "Run /draft first.",
            )
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        review_bundle = self._review_bundle()
        final_plan = current_plan
        if review_bundle:
            self._add_room_entry(
                ui, "system",
                f"{lead_cap} is finalizing {self._planning_display_path(self._plan_path)} "
                "and addressing all reviewer comments…",
            )
            try:
                final_resp = await self._run_adapter_streamed(
                    adapter, lead, "room", ui,
                    lambda: adapter.resume(
                        finalize_plan_preamble(current_plan, review_bundle)
                    ),
                )
            except Exception as e:
                self._add_room_entry(ui, "system", f"Error finalizing plan: {e}")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                return

            self._update_pct(lead, final_resp, ui)
            final_plan = RoomFooter.strip_footer(final_resp.text)
            self._add_room_entry(ui, lead, final_plan, stream_id=final_resp.stream_id)
            self.transcript.add(lead, final_resp.text, final_resp.tool_summaries)
            self._persist_session()
            self.transcript.mark_seen(lead)
            self._write_planning_file(self._plan_path, final_plan)
            self._add_room_entry(
                ui, "system",
                f"Updated {self._planning_display_path(self._plan_path)}",
            )

        self._add_room_entry(
            ui,
            "system",
            f"{lead_cap} is creating {self._planning_display_path(self._checkpoint_path)}…",
        )
        try:
            checkpoint_resp = await self._run_adapter_streamed(
                adapter, lead, "room", ui,
                lambda: adapter.resume(checkpoint_preamble(final_plan)),
            )
        except Exception as e:
            self._add_room_entry(ui, "system", f"Error generating checkpoint: {e}")
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        self._update_pct(lead, checkpoint_resp, ui)
        checkpoint_text = RoomFooter.strip_footer(checkpoint_resp.text)
        self._add_room_entry(
            ui, lead, checkpoint_text, stream_id=checkpoint_resp.stream_id,
        )
        self.transcript.add(lead, checkpoint_resp.text, checkpoint_resp.tool_summaries)
        self._persist_session()
        self.transcript.mark_seen(lead)
        self._write_planning_file(self._checkpoint_path, checkpoint_text)
        self._add_room_entry(
            ui, "system",
            f"Updated {self._planning_display_path(self._checkpoint_path)}",
        )

        archived_comments = self._archive_reviewer_comments()
        if archived_comments:
            self._add_room_entry(
                ui, "system",
                f"Archived {archived_comments} reviewer comment file(s) to "
                f"{self._planning_display_path(self._archived_reviewer_comments_dir())}/",
            )

        self.mode = RoomMode.PUBLIC
        ui.set_mode(RoomMode.PUBLIC)
        ui.set_status(self.status_snapshot())
        self._add_room_entry(
            ui, "system",
            "Finalize complete. "
            f"{self._planning_display_path(self._plan_path)} and "
            f"{self._planning_display_path(self._checkpoint_path)} are up to date.",
        )

    # ── helpers ───────────────────────────────────────────

    def yield_pressure(self, model: str) -> float:
        """Last normalized yield pressure for *model* (100 = yield now)."""
        return self._yield_pressure.get(model, 0.0)

    def relay_boundary(self, model: str) -> Optional[int]:
        """Transcript turn index at which *model* was last relayed, or None."""
        return self._relay_boundary.get(model)

    def set_relay_boundary(self, model: str) -> None:
        """Record current transcript position as the relay boundary for *model*."""
        if self.transcript.entries:
            self._relay_boundary[model] = self.transcript.entries[-1].turn_index
        else:
            self._relay_boundary[model] = -1

    def interrupt(self, ui: UIPort) -> None:
        """Record that the user interrupted the active turn."""
        self._add_room_entry(ui, "system", "Interrupted current turn.")
        # The bots see this next turn. The message they were answering was
        # not answered; it is in the history in full — say so, or the next
        # turn asks the user to send it again.
        self.transcript.add(
            "system",
            "[Interrupted current turn — the user's last message above was "
            "not answered. It is complete as written; take it up on your next "
            "turn unless the user says otherwise.]",
        )
        self._persist_session()

    def _resolve_lead(self) -> Optional[str]:
        """Resolve lead to bare model name, or None if auto."""
        if self.lead == "auto":
            return None
        return self.lead.lstrip("@")
