"""
botference.py — Controller for botference mode.

Command parsing, auto-routing, caucus protocol, finalize flow,
transcript management, and mode tracking.  The TUI lives in
botference_ui.py; this module is the headless logic layer so it can
be tested without Textual.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum
from typing import Optional, Protocol

from cli_adapters import (
    AdapterResponse,
    ClaudeAdapter,
    CodexAdapter,
    PlannerWriteConfig,
    ToolSummary,
    normalize_write_roots,
    planner_write_config,
    planner_write_roots_for_env,
)
from paths import BotferencePaths
from botference_ui import RoomMode, StatusSnapshot
from room_prompts import (
    ROOM_ROLE_SUFFIX,
    WRITER_PREAMBLE,
    caucus_first_turn,
    caucus_turn,
    checkpoint_preamble,
    finalize_plan_preamble,
    reviewer_preamble,
    revision_from_plan_preamble,
    room_preamble,
)
from datetime import datetime as _dt, timezone as _tz
from handoff import build_frontmatter, validate_handoff
from render_blocks import parse_render_blocks
from session_store import SessionStore, iso_now, append_crash_log

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


def stage_attachments(attachments: list[dict]) -> list[str]:
    """Copy image files to a repo-local staging dir.

    Returns a list of staged file paths (content-addressed).
    Claude can read these with its Read tool — no --file flag or
    session token needed.
    """
    if not attachments:
        return []
    _STAGING_DIR.mkdir(parents=True, exist_ok=True)

    staged: list[str] = []
    for att in attachments:
        if att.get("type") != "image":
            continue
        src = Path(att["path"])
        if not src.is_file():
            log.warning("Attachment not found: %s", src)
            continue
        # Content-addressed name: <sha256[:16]>.<ext>
        sha = hashlib.sha256(src.read_bytes()).hexdigest()[:16]
        ext = src.suffix or ".png"
        dst = _STAGING_DIR / f"{sha}{ext}"
        if not dst.exists():
            shutil.copy2(src, dst)
        staged.append(str(dst))
    return staged


# ── Input parsing ──────────────────────────────────────────


class InputKind(Enum):
    MESSAGE = "message"
    CAUCUS = "caucus"
    LEAD = "lead"
    DRAFT = "draft"
    FINALIZE = "finalize"
    PERMISSIONS = "permissions"
    STATUS = "status"
    AUTH = "auth"
    HELP = "help"
    QUIT = "quit"
    RELAY = "relay"
    RESUME = "resume"
    RENAME = "rename"
    MODEL = "model"
    EFFORT = "effort"
    CURRENT = "current"


@dataclass(frozen=True)
class ParsedInput:
    kind: InputKind
    body: str = ""      # message body or command argument
    target: str = ""    # "@claude", "@codex", "@all" for messages;
                        # "claude", "codex" for relay target


_SLASH_COMMANDS = {
    "/caucus": InputKind.CAUCUS,
    "/lead": InputKind.LEAD,
    "/draft": InputKind.DRAFT,
    "/finalize": InputKind.FINALIZE,
    "/resume": InputKind.RESUME,
    "/rename": InputKind.RENAME,
    "/permissions": InputKind.PERMISSIONS,
    "/status": InputKind.STATUS,
    "/auth": InputKind.AUTH,
    "/model": InputKind.MODEL,
    "/effort": InputKind.EFFORT,
    "/current-model": InputKind.CURRENT,
    "/current": InputKind.CURRENT,
    "/help": InputKind.HELP,
    "/quit": InputKind.QUIT,
    "/exit": InputKind.QUIT,
}

_MENTION_RE = re.compile(
    r"^(@(?:claude|codex|all))\s*(.*)", re.IGNORECASE | re.DOTALL
)

# Relay command patterns
_RELAY_HYPHEN_RE = re.compile(r"^/relay-(claude|codex)$", re.IGNORECASE)
_RELAY_TARGET_RE = re.compile(r"^@?(claude|codex)$", re.IGNORECASE)

_SESSION_TITLE_MAX = 80

# Commands that require a @target argument, expanded into @claude/@codex variants
_TARGETED_COMMANDS = ("/lead", "/relay", "/tag", "/model", "/effort")

# Known effort levels (passed through to the underlying CLI)
_CLAUDE_EFFORT_LEVELS = ("low", "medium", "high", "xhigh")
_CODEX_EFFORT_LEVELS = ("minimal", "low", "medium", "high")


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
        "scoped": {
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
    Trailing spaces on /caucus and @mentions signal that a message body
    follows.
    """
    out: list[str] = ["/caucus "]
    for cmd in _TARGETED_COMMANDS:
        out.append(f"{cmd} @claude")
        out.append(f"{cmd} @codex")
    for cmd in _SLASH_COMMANDS:
        if cmd in _TARGETED_COMMANDS or cmd == "/caucus":
            continue
        out.append(cmd)
    out.extend(["@claude ", "@codex ", "@all "])
    return out


def parse_input(raw: str) -> ParsedInput:
    """Parse raw user input into a structured command."""
    text = raw.strip()
    if not text:
        return ParsedInput(kind=InputKind.MESSAGE)

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
                return ParsedInput(
                    kind=InputKind.RELAY, target=m.group(1).lower(),
                )
            return ParsedInput(kind=InputKind.RELAY, target="", body=arg)

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

    def context_since(self, model: str, user_message: str) -> str:
        """Build context injection for *model* covering everything unseen."""
        last = self._last_seen.get(model, -1)
        unseen = [e for e in self.entries
                  if e.turn_index > last and e.speaker != model]

        parts: list[str] = []
        if unseen:
            parts.append("[Room update since your last response]\n")
            for e in unseen:
                label = {"user": "User", "claude": "Claude",
                         "codex": "Codex", "system": "System"
                         }.get(e.speaker, e.speaker)
                parts.append(f"[{label} said:]")
                parts.append(e.text)
                if e.tool_summaries:
                    parts.append(f"\n[{label} explored:]")
                    for ts in e.tool_summaries:
                        out = f" -> {ts.output_preview}" if ts.output_preview else ""
                        parts.append(f"- {ts.name}({ts.input_preview}){out}")
                parts.append("")

        if user_message:
            parts.append("[User says:]")
            parts.append(user_message)

        parts.append(ROOM_ROLE_SUFFIX)
        return "\n".join(parts)

    def context_after(self, after_turn: int) -> str:
        """Build backfill covering entries after a specific turn index."""
        entries = [e for e in self.entries if e.turn_index > after_turn]

        parts: list[str] = []
        if entries:
            parts.append('[Room history since relay]\n')
            for e in entries:
                label = {'user': 'User', 'claude': 'Claude',
                         'codex': 'Codex', 'system': 'System'
                         }.get(e.speaker, e.speaker)
                parts.append(f'[{label} said:]')
                parts.append(e.text)
                if e.tool_summaries:
                    parts.append(f'\n[{label} explored:]')
                    for ts in e.tool_summaries:
                        out = f' -> {ts.output_preview}' if ts.output_preview else ''
                        parts.append(f'- {ts.name}({ts.input_preview}){out}')
                parts.append('')

        parts.append(ROOM_ROLE_SUFFIX)
        return '\n'.join(parts)


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

        if preview and preview != "(running)":
            return f"{name} {preview}"

        return f"Shell {_clean_shell_command(name)}"

    lines = ["Explored"]
    for idx, ts in enumerate(tool_summaries):
        branch = "└" if idx == len(tool_summaries) - 1 else "├"
        lines.append(f"{branch} {_summarize_tool(ts)}")
    return "\n".join(lines)


def _tool_summary_display_blocks(tool_summaries: list) -> list[dict]:
    text_blocks = parse_render_blocks(_tool_summary_display_text(tool_summaries))
    output_blocks: list[dict] = []
    for ts in tool_summaries:
        output_blocks.extend(getattr(ts, "output_blocks", []) or [])
    return text_blocks + output_blocks


# ── Caucus footer parsing ──────────────────────────────────

_TERMINAL_STATUSES = frozenset(
    {"ready_to_draft", "need_user_input", "blocked", "no_objection", "disagree"}
)

_FOOTER_FENCED_RE = re.compile(
    r"```(?:json)?\s*(\{[^`]*\})\s*```\s*$", re.DOTALL
)
_FOOTER_RAW_RE = re.compile(
    r'(\{[^{]*"status"[^}]*\})\s*$', re.DOTALL
)


@dataclass(frozen=True)
class CaucusFooter:
    status: str        # continue | ready_to_draft | …
    handoff_to: str    # claude | codex | user
    writer_vote: str   # claude | codex | none
    summary: str

    @property
    def is_terminal(self) -> bool:
        return self.status in _TERMINAL_STATUSES

    @classmethod
    def parse(cls, text: str) -> Optional["CaucusFooter"]:
        """Extract JSON footer from model response text."""
        for regex in (_FOOTER_FENCED_RE, _FOOTER_RAW_RE):
            m = regex.search(text)
            if m:
                try:
                    d = json.loads(m.group(1))
                    if "status" in d:
                        return cls(
                            status=d.get("status", "continue"),
                            handoff_to=d.get("handoff_to", "user"),
                            writer_vote=d.get("writer_vote", "none"),
                            summary=d.get("summary", ""),
                        )
                except (json.JSONDecodeError, KeyError):
                    continue
        return None

    @classmethod
    def strip_footer(cls, text: str) -> str:
        """Return *text* with the JSON footer removed."""
        for regex in (_FOOTER_FENCED_RE, _FOOTER_RAW_RE):
            cleaned = regex.sub("", text).rstrip()
            if cleaned != text.rstrip():
                return cleaned
        return text


# ── UI callback protocol ──────────────────────────────────


class UIPort(Protocol):
    """Minimal interface the controller needs from the TUI."""
    def add_room_entry(
        self, speaker: str, text: str, blocks: Optional[list[dict]] = None,
    ) -> None: ...
    def add_caucus_entry(
        self, speaker: str, text: str, blocks: Optional[list[dict]] = None,
    ) -> None: ...
    def set_status(self, status: StatusSnapshot) -> None: ...
    def set_mode(self, mode: RoomMode) -> None: ...
    async def request_write_permission(
        self, request: "WritePermissionRequest",
    ) -> bool: ...


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



# ── Botference controller ────────────────────────────────────

_CAUCUS_MIN_TURNS = 3   # each model speaks at least 3 times
_CAUCUS_MAX_TURNS = 5   # each model speaks at most 5 times

_RELAY_USAGE = "Usage: /relay @claude|@codex  (aliases: /relay-claude, /tag @claude)"

# Relay tier thresholds (yield-pressure percent from adapter.context_percent)
RELAY_TIER_SELF_MAX = 70       # < 70%: self-authored handoff
RELAY_TIER_CROSS_MAX = 90      # 70–89%: cross-authored handoff
                                # >= 90%: mechanical handoff

# Mechanical handoff: how many transcript entries from the tail to scan
_MECHANICAL_TAIL_ENTRIES = 20


class Botference:
    """Main controller: command dispatch, routing, caucus, finalize."""

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
        self.system_prompt = system_prompt
        self.task = task
        self.paths = paths or BotferencePaths.resolve()
        self.session_store = SessionStore(self.paths)
        self.session_id = str(uuid.uuid4())
        self.created_at = iso_now()
        self.updated_at = self.created_at
        self.custom_title: str = ""

        self.transcript = Transcript()
        self.router = AutoRouter()
        self.mode = RoomMode.PUBLIC
        self.lead: str = "auto"
        self.observe: bool = True
        self._room_history: list[DisplayRecord] = []
        self._caucus_history: list[DisplayRecord] = []
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
        self._pending_relay_handoffs: dict[str, str] = {}  # model → in-process one-shot relay bootstrap
        self._quit_requested: bool = False
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
            claude_percent=self._claude_pct,
            codex_percent=self._codex_pct,
            claude_tokens=self._claude_tokens,
            claude_window=self._claude_window,
            codex_tokens=self._codex_tokens,
            codex_window=self._codex_window,
            observe_enabled=self.observe,
        )

    @property
    def _plan_path(self) -> Path:
        return self.paths.work_dir / "implementation-plan.md"

    @property
    def _checkpoint_path(self) -> Path:
        return self.paths.work_dir / "checkpoint.md"

    @property
    def _archive_root(self) -> Path:
        env_dir = os.environ.get("BOTFERENCE_ARCHIVE_DIR")
        return Path(env_dir) if env_dir else (self.paths.project_root / "archive")

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
            "route": self.router.current_route,
            "router_had_first_turn": self.router._had_first_turn,
            "observe": self.observe,
            "base_plan_write_roots": self._serialize_write_roots(
                self._base_plan_write_roots
            ),
            "granted_plan_write_roots": self._serialize_write_roots(
                self._granted_plan_write_roots
            ),
            "room_history": [
                {"speaker": entry.speaker, "text": entry.text}
                for entry in self._room_history
            ],
            "caucus_history": [
                {"speaker": entry.speaker, "text": entry.text}
                for entry in self._caucus_history
            ],
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
            "pending_relay_handoffs": dict(self._pending_relay_handoffs),
        }

    def _persist_session(self) -> None:
        if self._restoring_session:
            return
        try:
            self.updated_at = iso_now()
            self.session_store.save(self.session_id, self._session_payload())
        except OSError as exc:
            log.warning("Failed to persist botference session %s: %s", self.session_id, exc)

    def _can_replace_with_resumed_session(self) -> bool:
        return (
            not self.transcript.entries
            and not self._models_initialized
            and not self._caucus_history
        )

    def _format_session_list(self, summaries: list) -> str:
        if not summaries:
            return "No saved sessions found."
        lines = ["Saved sessions:"]
        for idx, summary in enumerate(summaries, start=1):
            lines.append(
                f"  {idx:>2}. {summary.session_id[:12]}  {summary.updated_at}  {summary.title}"
            )
        lines.extend([
            "",
            "Run /resume latest, /resume <number>, /resume <title>, or /resume <session-id-prefix>.",
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
            self.observe = bool(payload.get("observe", self.observe))
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
                )
                for entry in payload.get("room_history", []) or []
                if isinstance(entry, dict)
            ]
            self._caucus_history = [
                DisplayRecord(
                    speaker=str(entry.get("speaker", "system")),
                    text=str(entry.get("text", "")),
                )
                for entry in payload.get("caucus_history", []) or []
                if isinstance(entry, dict)
            ]

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
            self._yield_pressure = {
                str(model): float(value)
                for model, value in (payload.get("yield_pressure", {}) or {}).items()
            }
            self._relay_boundary = {
                str(model): int(value)
                for model, value in (payload.get("relay_boundary", {}) or {}).items()
            }
            self._pending_relay_handoffs = {
                str(model): str(value)
                for model, value in (payload.get("pending_relay_handoffs", {}) or {}).items()
            }
        finally:
            self._restoring_session = False
        return saved_mode

    def _replay_restored_session(self, ui: UIPort) -> None:
        for entry in self._room_history:
            ui.add_room_entry(entry.speaker, entry.text, self._structured_blocks(entry.text))
        for entry in self._caucus_history:
            ui.add_caucus_entry(entry.speaker, entry.text, self._structured_blocks(entry.text))

    def _show_resume_list(self, ui: UIPort) -> None:
        summaries = self.session_store.list_summaries(
            limit=10, exclude_session_id=self.session_id,
        )
        self._add_room_entry(ui, "system", self._format_session_list(summaries))

    def _resume_session(self, arg: str, ui: UIPort) -> None:
        replaceable = self._can_replace_with_resumed_session()
        if not replaceable:
            self._add_room_entry(
                ui,
                "system",
                "Resume is only available in a fresh controller session. Start a new plan session first.",
            )
            return

        query = arg.strip()
        summaries = self.session_store.list_summaries(
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
            matches = [
                summary.session_id
                for summary in summaries
                if summary.session_id == query or summary.session_id.startswith(query)
            ]
            if not matches:
                matches = self._matching_sessions_by_title(summaries, query)
            if not matches:
                self._add_room_entry(
                    ui,
                    "system",
                    f"No saved session matched '{query}'.\n\n{self._format_session_list(summaries[:10])}",
                )
                return
            if len(matches) > 1:
                by_id = {summary.session_id: summary for summary in summaries}
                self._add_room_entry(
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

        payload = self.session_store.load(target_id)
        old_session_id = self.session_id
        saved_mode = self._restore_from_payload(payload)
        if old_session_id != self.session_id and replaceable:
            self.session_store.delete(old_session_id)
        self._replay_restored_session(ui)
        note = (
            f"Resumed session {self._session_title()} "
            f"({self.session_id[:12]}) from {self.updated_at}."
        )
        if saved_mode != RoomMode.PUBLIC.value:
            note += f" Restored interrupted {saved_mode} session in public mode."
        self._add_room_entry(ui, "system", note)
        ui.set_mode(self.mode)
        ui.set_status(self.status_snapshot())
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
        text = self._read_work_file(self._plan_path)
        return "" if self._looks_like_template(text) else text

    def _thread_slug(self) -> str:
        candidates = [self._current_plan_text(), self._read_work_file(self._checkpoint_path)]
        for text in candidates:
            if not text:
                continue
            m = re.search(r"^\*\*Thread:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
            if m:
                return re.sub(r"\s+", "", m.group(1).strip())
        return "unknown-thread"

    def _reviewer_comments_name(self, round_number: int) -> str:
        return f"AI-reviewer_comments_round-{round_number}.md"

    def _reviewer_comments_path(self, round_number: int) -> Path:
        return self.paths.work_dir / self._reviewer_comments_name(round_number)

    def _active_reviewer_comments_paths(self) -> list[Path]:
        return sorted(
            self.paths.work_dir.glob("AI-reviewer_comments_round-*.md"),
            key=lambda p: self._extract_round_number(p.name),
        )

    def _archived_reviewer_comments_dir(self) -> Path:
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

        if parsed.kind is InputKind.QUIT:
            self._quit_requested = True
            self._add_room_entry(ui, "system", "Exiting council. No files written.")
            self._persist_session()
            return

        if parsed.kind is InputKind.HELP:
            self._show_help(ui)
            return

        if parsed.kind is InputKind.STATUS:
            self._show_status(ui)
            return

        if parsed.kind is InputKind.PERMISSIONS:
            self._show_permissions(ui)
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
            await self._relay_model(parsed.target, ui)
            return

        if parsed.kind is InputKind.CAUCUS:
            await self._run_caucus(parsed.body, ui)
            return

        if parsed.kind is InputKind.DRAFT:
            await self._run_draft(ui, parsed.body)
            return

        if parsed.kind is InputKind.FINALIZE:
            await self._run_finalize(ui)
            return

        await self._send_message(parsed, ui, attachments=attachments)

    # ── /help ─────────────────────────────────────────────

    def _show_help(self, ui: UIPort) -> None:
        self._add_room_entry(ui, "system", "\n".join([
            "Commands:",
            "  /caucus <topic>     — Start a structured discussion between Claude and Codex",
            "  /lead @claude|@codex — Set who writes the plan",
            "  /draft [rounds]     — Update implementation-plan.md with 0/1/2+ AI review rounds (default: 2)",
            "  /finalize           — Address reviewer comments, write final plan, create checkpoint.md",
            "  /relay @claude|@codex — Reset model session with structured handoff",
            "  /resume [latest|number|title|id] — Restore a saved plan session in a fresh controller",
            "  /rename <name>      — Name this saved session for future /resume lookup",
            "  /permissions        — Show current planner write roots and runtime grants",
            "  /status             — Show context %, lead, mode, sessions",
            "  /auth [claude|codex|all] — Check local CLI auth status",
            "  /model [@claude|@codex <id>] — Show or set the model for a participant",
            "  /effort [@claude|@codex <level>] — Show or set reasoning effort",
            "  /current-model (or /current) — Show both loaded models and effort levels",
            "  /help               — Show this help",
            "  /quit | /exit       — Exit without writing files",
            "",
            "Messaging:",
            "  @claude <msg>       — Send to Claude only",
            "  @codex <msg>        — Send to Codex only",
            "  @all <msg>          — Send to both",
            "  <msg>               — Auto-routed (first message → @all, then sticky)",
            "",
            "Aliases: /relay-claude, /relay-codex, /tag @claude, /tag @codex",
            "",
            "Workflow: discuss → /caucus → /lead → /draft [rounds] → /finalize",
            "",
            "Keys (Ink TUI): Esc interrupts the current turn. Shift+Enter inserts a newline.",
            "",
            "Claude context shows prompt occupancy / context window size.",
            "Codex shows a last-turn prompt-footprint proxy once it has a baseline.",
        ]))

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

    # ── /status ───────────────────────────────────────────

    def _show_status(self, ui: UIPort) -> None:
        c = _format_token_display(self._claude_tokens, self._claude_window)
        x = _format_token_display(self._codex_tokens, self._codex_window)
        c_pct = _format_window_percent(self._claude_tokens, self._claude_window)
        x_pct = _format_window_percent(self._codex_tokens, self._codex_window)
        lines = [
            f"Session: {self.session_id[:12]}",
            f"Mode: {self.mode.value}",
            f"Lead: {self.lead}",
            f"Route: {self.router.current_route}",
            f"Claude: {c_pct} ({c})  (session {self.claude.session_id or '-'})",
            f"Codex:  {x_pct} ({x})  (thread {self.codex.thread_id or '-'})",
            f"Observe: {'on' if self.observe else 'off'}",
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
        live_path = self.paths.handoff_live_file(model)
        live_path.unlink(missing_ok=True)
        self._pending_relay_handoffs[model] = handoff_doc

        restarted = await self._ensure_initialized(model, ui)

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
        live_path = self.paths.handoff_live_file(model)
        live_path.parent.mkdir(parents=True, exist_ok=True)
        live_path.write_text(handoff_doc, encoding="utf-8")

    async def _start_model_session(
        self,
        model: str,
        ui: UIPort,
        *,
        handoff_doc: str | None = None,
        after_turn: int | None = None,
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
            resp = await adapter.send(prompt)
        except Exception as e:
            self._add_room_entry(ui, "system", f"Error starting {model}: {e}")
            self._models_initialized.discard(model)
            if handoff_doc:
                self._persist_failed_relay_handoff(model)
            self._persist_session()
            return None

        if handoff_doc:
            self._pending_relay_handoffs.pop(model, None)
            self.paths.handoff_live_file(model).unlink(missing_ok=True)

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

    def _add_room_entry(self, ui: UIPort, speaker: str, text: str) -> None:
        self._room_history.append(DisplayRecord(speaker=speaker, text=text))
        ui.add_room_entry(speaker, text, self._structured_blocks(text))
        self._persist_session()

    def _add_caucus_entry(self, ui: UIPort, speaker: str, text: str) -> None:
        self._caucus_history.append(DisplayRecord(speaker=speaker, text=text))
        ui.add_caucus_entry(speaker, text, self._structured_blocks(text))
        self._persist_session()

    async def _send_message(
        self, parsed: ParsedInput, ui: UIPort,
        *, attachments: list | None = None,
    ) -> None:
        route = self.router.resolve(parsed)

        prefix = f"{route} " if parsed.target else f"(→{route}) "
        self._add_room_entry(ui, "user", prefix + parsed.body)

        # Stage image attachments to repo-local tmp dir so agents
        # can read them as normal files — no --file flag or tokens needed.
        staged = stage_attachments(attachments or [])
        body = parsed.body
        if staged:
            refs = "\n".join(
                f"[Attached image: {p}]" for p in staged
            )
            body = f"{body}\n\n{refs}"

        self.transcript.add("user", body)
        self._persist_session()

        targets = (
            ["claude", "codex"] if route == "@all"
            else [route.lstrip("@")]
        )

        for model in targets:
            resp = await self._send_to_model(model, body, ui)
            if resp:
                self.transcript.add(model, resp.text, resp.tool_summaries)
                self.transcript.mark_seen(model)
                self._update_pct(model, resp, ui)
                ui.set_status(self.status_snapshot())
                self._persist_session()

    async def _send_to_model(
        self, model: str, message: str, ui: UIPort,
    ) -> Optional[AdapterResponse]:
        adapter = self.claude if model == "claude" else self.codex

        if model not in self._models_initialized:
            handoff_doc = self._pending_relay_handoffs.get(model)
            relay_turn = self.relay_boundary(model) if handoff_doc else None
            resp = await self._start_model_session(
                model,
                ui,
                handoff_doc=handoff_doc,
                after_turn=relay_turn,
            )
            if resp is None:
                return None
            self.transcript.mark_seen(model)
        else:
            # Resume — the user entry is already in the transcript (added
            # by _send_message before dispatch), so context_since picks it
            # up.  Passing "" avoids injecting the user message twice.
            context = self.transcript.context_since(model, "")
            try:
                resp = await adapter.resume(context)
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
                resp = await adapter.resume(follow_up)
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

        tool_display = _tool_summary_display_text(resp.tool_summaries)
        if tool_display:
            ui.add_room_entry(
                model,
                tool_display,
                _tool_summary_display_blocks(resp.tool_summaries),
            )
        if resp.text:
            self._add_room_entry(ui, model, resp.text)
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

    # ── /caucus ───────────────────────────────────────────

    async def _run_caucus(self, topic: str, ui: UIPort) -> None:
        if not topic:
            self._add_room_entry(ui, "system", "Usage: /caucus <topic>")
            return

        self.mode = RoomMode.CAUCUS
        ui.set_mode(RoomMode.CAUCUS)
        self._add_caucus_entry(ui, "system", f"--- caucus: {topic} ---")
        self._add_room_entry(ui, "system", f"Caucus started: {topic}")

        # Ensure both models are initialised (with transcript backfill)
        for model in ("claude", "codex"):
            if not await self._ensure_initialized(model, ui):
                self._add_room_entry(ui, "system", f"Caucus aborted — failed to start {model}.")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                ui.set_status(self.status_snapshot())
                return

        speakers = ["claude", "codex"]
        last_resp_text = ""
        writer_votes: dict[str, str] = {}
        final_footer: Optional[CaucusFooter] = None
        caucus_error = False

        for _round in range(_CAUCUS_MAX_TURNS):
            round_footers: dict[str, CaucusFooter] = {}

            for speaker in speakers:
                adapter = self.claude if speaker == "claude" else self.codex
                other = "Codex" if speaker == "claude" else "Claude"

                turn_number = _round + 1
                if last_resp_text:
                    turn = caucus_turn(
                        other, last_resp_text, topic,
                        turn_number=turn_number,
                        min_turns=_CAUCUS_MIN_TURNS,
                        max_turns=_CAUCUS_MAX_TURNS,
                    )
                else:
                    turn = caucus_first_turn(
                        topic,
                        turn_number=turn_number,
                        min_turns=_CAUCUS_MIN_TURNS,
                        max_turns=_CAUCUS_MAX_TURNS,
                    )

                try:
                    resp = await adapter.resume(turn)
                except Exception as e:
                    self._add_caucus_entry(ui, "system", f"Error from {speaker}: {e}")
                    final_footer = CaucusFooter(
                        status="blocked", handoff_to="user",
                        writer_vote="none",
                        summary=f"{speaker} failed: {e}",
                    )
                    caucus_error = True
                    break

                self._update_pct(speaker, resp, ui)
                self.transcript.mark_seen(speaker)

                footer = CaucusFooter.parse(resp.text)
                display = (CaucusFooter.strip_footer(resp.text)
                           if footer else resp.text)
                self._add_caucus_entry(ui, speaker, display)
                last_resp_text = resp.text

                if footer:
                    if footer.writer_vote != "none":
                        writer_votes[speaker] = footer.writer_vote
                    round_footers[speaker] = footer

                ui.set_status(self.status_snapshot())

            if caucus_error:
                break

            # Only check termination after both speakers have spoken
            # and the minimum turns threshold is met (_round is 0-indexed,
            # so _round + 1 is the number of messages each model has sent)
            turns_completed = _round + 1
            if turns_completed >= _CAUCUS_MIN_TURNS:
                if any(f.is_terminal for f in round_footers.values()):
                    final_footer = round_footers.get(
                        speakers[-1], next(iter(round_footers.values()), None)
                    )
                    break

        # Summary
        summary = self._caucus_summary(topic, final_footer, writer_votes)
        self._add_caucus_entry(ui, "system", "--- caucus ended ---")
        self._add_room_entry(ui, "summary", summary)
        self.transcript.add("system", f"[Caucus summary: {summary}]")
        self._persist_session()

        # Auto-lead from consensus votes
        if self.lead == "auto" and writer_votes:
            votes = list(writer_votes.values())
            if len(set(votes)) == 1:
                self.lead = f"@{votes[0]}"
                self._add_room_entry(ui, "system", f"Writer consensus → lead set to {self.lead}")

        self.mode = RoomMode.PUBLIC
        ui.set_mode(RoomMode.PUBLIC)
        ui.set_status(self.status_snapshot())

    @staticmethod
    def _caucus_summary(
        topic: str,
        footer: Optional[CaucusFooter],
        writer_votes: dict[str, str],
    ) -> str:
        if footer is None:
            return f"Caucus on '{topic}' completed (max rounds reached)."
        if footer.status == "disagree":
            return (f"Caucus on '{topic}' — disagreement.\n"
                    f"{footer.summary}\nDecision needed from user.")
        if footer.status == "need_user_input":
            return (f"Caucus on '{topic}' — needs user input.\n"
                    f"{footer.summary}")
        if footer.status == "blocked":
            return f"Caucus on '{topic}' — blocked. {footer.summary}"
        if footer.status in ("ready_to_draft", "no_objection"):
            v = f" Writer votes: {writer_votes}" if writer_votes else ""
            return (f"Caucus on '{topic}' — agreement reached.{v}\n"
                    f"{footer.summary}")
        return f"Caucus on '{topic}' completed. {footer.summary}"

    # ── /draft ────────────────────────────────────────────

    async def _run_draft(self, ui: UIPort, draft_arg: str = "") -> None:
        lead = self._resolve_lead()
        if not lead:
            self._add_room_entry(
                ui, "system",
                "No lead set. Use /lead @claude|@codex or run /caucus first.",
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
        self._add_room_entry(
            ui, "system",
            f"Drafting implementation-plan.md ({lead}, {rounds} AI review round(s))…",
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
            )
        else:
            prompt = WRITER_PREAMBLE

        try:
            resp = await adapter.resume(prompt)
        except Exception as e:
            self._add_room_entry(ui, "system", f"Error drafting: {e}")
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        self._update_pct(lead, resp, ui)
        self._add_room_entry(ui, lead, resp.text)
        self.transcript.add(lead, resp.text, resp.tool_summaries)
        self._persist_session()
        self.transcript.mark_seen(lead)
        current_plan = resp.text
        self._write_work_file(self._plan_path, current_plan)
        self._add_room_entry(
            ui, "system",
            f"Updated {self.paths.work_prefix}implementation-plan.md",
        )

        next_round = self._next_reviewer_round()
        for round_number in range(next_round, next_round + rounds):
            self.mode = RoomMode.REVIEW
            ui.set_mode(RoomMode.REVIEW)
            self._add_room_entry(
                ui, "system",
                f"{reviewer_cap} is reviewing draft round {round_number}…",
            )
            try:
                rev_resp = await rev_adapter.resume(
                    reviewer_preamble(lead_cap, current_plan)
                )
            except Exception as e:
                self._add_room_entry(ui, "system", f"Error reviewing: {e}")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                return

            self._update_pct(reviewer, rev_resp, ui)
            self._add_room_entry(ui, reviewer, rev_resp.text)
            self.transcript.add(reviewer, rev_resp.text, rev_resp.tool_summaries)
            self._persist_session()
            self.transcript.mark_seen(reviewer)

            review_path = self._reviewer_comments_path(round_number)
            self._write_work_file(review_path, rev_resp.text)
            self._add_room_entry(
                ui, "system",
                f"Saved reviewer comments to {self.paths.work_prefix}{review_path.name}",
            )

            self.mode = RoomMode.DRAFT
            ui.set_mode(RoomMode.DRAFT)
            self._add_room_entry(
                ui, "system",
                f"{lead_cap} is revising implementation-plan.md for round {round_number}…",
            )
            try:
                revised_resp = await adapter.resume(
                    revision_from_plan_preamble(
                        current_plan, reviewer_cap, rev_resp.text, round_number
                    )
                )
            except Exception as e:
                self._add_room_entry(ui, "system", f"Error revising: {e}")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                return

            self._update_pct(lead, revised_resp, ui)
            self._add_room_entry(ui, lead, revised_resp.text)
            self.transcript.add(lead, revised_resp.text, revised_resp.tool_summaries)
            self._persist_session()
            self.transcript.mark_seen(lead)
            current_plan = revised_resp.text
            self._write_work_file(self._plan_path, current_plan)
            self._add_room_entry(
                ui, "system",
                f"Updated {self.paths.work_prefix}implementation-plan.md",
            )

        self.mode = RoomMode.PUBLIC
        ui.set_mode(RoomMode.PUBLIC)
        ui.set_status(self.status_snapshot())
        self._add_room_entry(
            ui, "system",
            (
                "Draft complete. "
                f"{self.paths.work_prefix}implementation-plan.md now reflects "
                f"{rounds} AI review round(s)."
            ),
        )

    # ── /finalize ─────────────────────────────────────────

    async def _run_finalize(self, ui: UIPort) -> None:
        lead = self._resolve_lead()
        if not lead:
            self._add_room_entry(
                ui, "system",
                "No lead set. Use /lead @claude|@codex or run /caucus first.",
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
                f"No drafted plan found at {self.paths.work_prefix}implementation-plan.md. "
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
                f"{lead_cap} is finalizing implementation-plan.md and addressing all reviewer comments…",
            )
            try:
                final_resp = await adapter.resume(
                    finalize_plan_preamble(current_plan, review_bundle)
                )
            except Exception as e:
                self._add_room_entry(ui, "system", f"Error finalizing plan: {e}")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                return

            self._update_pct(lead, final_resp, ui)
            self._add_room_entry(ui, lead, final_resp.text)
            self.transcript.add(lead, final_resp.text, final_resp.tool_summaries)
            self._persist_session()
            self.transcript.mark_seen(lead)
            final_plan = final_resp.text
            self._write_work_file(self._plan_path, final_plan)
            self._add_room_entry(
                ui, "system",
                f"Updated {self.paths.work_prefix}implementation-plan.md",
            )

        self._add_room_entry(ui, "system", f"{lead_cap} is creating checkpoint.md…")
        try:
            checkpoint_resp = await adapter.resume(checkpoint_preamble(final_plan))
        except Exception as e:
            self._add_room_entry(ui, "system", f"Error generating checkpoint: {e}")
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        self._update_pct(lead, checkpoint_resp, ui)
        self._add_room_entry(ui, lead, checkpoint_resp.text)
        self.transcript.add(lead, checkpoint_resp.text, checkpoint_resp.tool_summaries)
        self._persist_session()
        self.transcript.mark_seen(lead)
        self._write_work_file(self._checkpoint_path, checkpoint_resp.text)
        self._add_room_entry(
            ui, "system",
            f"Updated {self.paths.work_prefix}checkpoint.md",
        )

        archived_comments = self._archive_reviewer_comments()
        if archived_comments:
            self._add_room_entry(
                ui, "system",
                f"Archived {archived_comments} reviewer comment file(s) to archive/reviewer-comments/{self._thread_slug()}/",
            )

        self.mode = RoomMode.PUBLIC
        ui.set_mode(RoomMode.PUBLIC)
        ui.set_status(self.status_snapshot())
        self._add_room_entry(
            ui, "system",
            "Finalize complete. implementation-plan.md and checkpoint.md are up to date.",
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
        self.transcript.add("system", "[Interrupted current turn]")
        self._persist_session()

    def _resolve_lead(self) -> Optional[str]:
        """Resolve lead to bare model name, or None if auto."""
        if self.lead == "auto":
            return None
        return self.lead.lstrip("@")


# ── CLI entrypoint ────────────────────────────────────────


def main() -> None:
    """Launch botference TUI."""
    import argparse
    import os
    import tempfile

    parser = argparse.ArgumentParser(description="botference mode")
    parser.add_argument("--anthropic-model", default="claude-sonnet-4-6")
    parser.add_argument("--claude-effort", default="")
    parser.add_argument("--openai-model", default="gpt-5.5")
    parser.add_argument("--openai-effort", default="")
    parser.add_argument("--system-prompt", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--debug-panes", action="store_true")
    args = parser.parse_args()

    from botference_ui import BotferenceApp

    # Load OPENAI_API_KEY from .env as a fallback (not into global env).
    # Codex tries subscription auth first; only uses this key on rate limit.
    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _fallback_api_key = os.environ.get("OPENAI_API_KEY", "")
    if not _fallback_api_key:
        for env_name in (".env.local", ".env"):
            env_path = os.path.join(_project_dir, env_name)
            if os.path.isfile(env_path):
                with open(env_path) as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key, _, val = line.partition("=")
                            if key.strip() == "OPENAI_API_KEY":
                                _fallback_api_key = val.strip().strip("'\"")
                break

    # Set up debug log files when --debug-panes is on
    claude_log = ""
    codex_log = ""
    if args.debug_panes:
        log_dir = os.environ.get(
            "BOTFERENCE_RUN",
            os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs"),
        )
        os.makedirs(log_dir, exist_ok=True)
        claude_log = os.path.join(log_dir, "debug-claude.log")
        codex_log = os.path.join(log_dir, "debug-codex.log")
        # Truncate previous logs
        for p in (claude_log, codex_log):
            with open(p, "w") as f:
                f.write("")
        print(f"Debug logs:\n  Claude: {claude_log}\n  Codex:  {codex_log}")
        print("In other tmux panes, run:")
        print(f"  tail -f {claude_log}")
        print(f"  tail -f {codex_log}")
        print()

    paths = BotferencePaths.resolve()
    plan_write_roots = planner_write_roots_for_env(
        paths.project_root, paths.work_dir, mode="plan"
    )
    planner_config = planner_write_config(paths.project_root, plan_write_roots)
    claude = ClaudeAdapter(
        model=args.anthropic_model,
        effort=args.claude_effort,
        tools=[
            "Read",
            "Glob",
            "Grep",
            "Bash",
            "Write",
            "Edit",
            "MultiEdit",
            "WebSearch",
            "WebFetch",
        ],
        debug_log_path=claude_log,
        cwd=planner_config.claude_cwd,
        add_dirs=planner_config.claude_add_dirs,
        settings=planner_config.claude_settings,
    )
    codex = CodexAdapter(
        model=args.openai_model,
        sandbox=planner_config.codex_sandbox,
        cwd=planner_config.codex_cwd,
        add_dirs=planner_config.codex_add_dirs,
        reasoning_effort=args.openai_effort,
        debug_log_path=codex_log,
        fallback_api_key=_fallback_api_key,
        network_access=planner_config.codex_network_access,
    )
    botference = Botference(
        claude=claude, codex=codex,
        system_prompt=args.system_prompt, task=args.task,
        paths=paths,
        plan_write_roots=planner_config.write_roots,
    )
    botference.observe = args.debug_panes

    app = BotferenceApp(initial_status=botference.status_snapshot())

    def on_submit(text: str) -> None:
        async def _handle() -> None:
            try:
                await botference.handle_input(text, app)
            except Exception as exc:
                append_crash_log(
                    paths,
                    location="botference.main.handle_input",
                    session_id=botference.session_id,
                    exc=exc,
                )
                app.add_room_entry("system", f"Unhandled controller error: {exc}")
            if botference.quit_requested:
                app.exit()
        app.run_worker(_handle(), exclusive=True)

    app.on_submit = on_submit
    app.run()


if __name__ == "__main__":
    main()
