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
from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum
from typing import Optional, Protocol

from cli_adapters import AdapterResponse, ClaudeAdapter, CodexAdapter, ToolSummary
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
    STATUS = "status"
    AUTH = "auth"
    HELP = "help"
    QUIT = "quit"
    RELAY = "relay"


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
    "/status": InputKind.STATUS,
    "/auth": InputKind.AUTH,
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
    def add_room_entry(self, speaker: str, text: str) -> None: ...
    def add_caucus_entry(self, speaker: str, text: str) -> None: ...
    def set_status(self, status: StatusSnapshot) -> None: ...
    def set_mode(self, mode: RoomMode) -> None: ...

def _strip_response_frontmatter(text: str) -> str:
    """Strip any YAML frontmatter a model may have included in its response."""
    m = re.match(r"\A---[ \t]*\n.*?\n---[ \t]*\n", text, re.DOTALL)
    return text[m.end():] if m else text



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
    ):
        self.claude = claude
        self.codex = codex
        self.system_prompt = system_prompt
        self.task = task
        self.paths = paths or BotferencePaths.resolve()

        self.transcript = Transcript()
        self.router = AutoRouter()
        self.mode = RoomMode.PUBLIC
        self.lead: str = "auto"
        self.observe: bool = True

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
        self._quit_requested: bool = False

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
            ui.add_room_entry("system", "Exiting council. No files written.")
            return

        if parsed.kind is InputKind.HELP:
            self._show_help(ui)
            return

        if parsed.kind is InputKind.STATUS:
            self._show_status(ui)
            return

        if parsed.kind is InputKind.AUTH:
            self._show_auth_status(parsed.body, ui)
            return

        if parsed.kind is InputKind.LEAD:
            self._set_lead(parsed.body, ui)
            return

        if parsed.kind is InputKind.RELAY:
            if not parsed.target:
                ui.add_room_entry("system", _RELAY_USAGE)
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
        ui.add_room_entry("system", "\n".join([
            "Commands:",
            "  /caucus <topic>     — Start a structured discussion between Claude and Codex",
            "  /lead @claude|@codex — Set who writes the plan",
            "  /draft [rounds]     — Update implementation-plan.md with 0/1/2+ AI review rounds (default: 2)",
            "  /finalize           — Address reviewer comments, write final plan, create checkpoint.md",
            "  /relay @claude|@codex — Reset model session with structured handoff",
            "  /status             — Show context %, lead, mode, sessions",
            "  /auth [claude|codex|all] — Check local CLI auth status",
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
            "Context shows current prompt occupancy / context window size.",
            "Based on the model's last turn.",
        ]))

    # ── /status ───────────────────────────────────────────

    def _show_status(self, ui: UIPort) -> None:
        c = _format_token_display(self._claude_tokens, self._claude_window)
        x = _format_token_display(self._codex_tokens, self._codex_window)
        c_pct = _format_window_percent(self._claude_tokens, self._claude_window)
        x_pct = _format_window_percent(self._codex_tokens, self._codex_window)
        lines = [
            f"Mode: {self.mode.value}",
            f"Lead: {self.lead}",
            f"Route: {self.router.current_route}",
            f"Claude: {c_pct} ({c})  (session {self.claude.session_id or '-'})",
            f"Codex:  {x_pct} ({x})  (thread {self.codex.thread_id or '-'})",
            f"Observe: {'on' if self.observe else 'off'}",
            f"Turns: {len(self.transcript.entries)}",
        ]
        ui.add_room_entry("system", "\n".join(lines))

    def _show_auth_status(self, arg: str, ui: UIPort) -> None:
        target = arg.strip().lower().lstrip("@")
        if target in ("", "all", "both"):
            targets = ["claude", "codex"]
        elif target in ("claude", "codex"):
            targets = [target]
        else:
            ui.add_room_entry("system", "Usage: /auth [claude|codex|all]")
            return

        lines = ["Auth diagnostics:"]
        for model in targets:
            lines.extend(self._auth_status_lines(model))
        ui.add_room_entry("system", "\n".join(lines))

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
            ui.add_room_entry("system", f"Lead set to {self.lead}")
        else:
            ui.add_room_entry("system",
                              "Usage: /lead auto|@claude|@codex")
        ui.set_status(self.status_snapshot())

    # ── /relay ────────────────────────────────────────────

    async def _relay_model(self, model: str, ui: UIPort) -> None:
        """Relay a model's session: create handoff, tear down, arm bootstrap."""
        if model not in ("claude", "codex"):
            ui.add_room_entry("system", _RELAY_USAGE)
            return
        if model not in self._models_initialized:
            ui.add_room_entry(
                "system",
                f"Cannot relay {model} — no active session.",
            )
            return

        # Read relay prompt
        relay_prompt = self._read_relay_prompt()
        if relay_prompt is None:
            ui.add_room_entry(
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
            ui.add_room_entry(
                "system",
                f"Relay failed for {model} — could not generate valid handoff.",
            )
            return

        # Write live handoff file
        live_path = self.paths.handoff_live_file(model)
        live_path.parent.mkdir(parents=True, exist_ok=True)
        live_path.write_text(handoff_doc, encoding="utf-8")

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

        # Confirmation
        ui.add_room_entry(
            "system",
            f"Relayed {model} (tier: {used_tier}). "
            f"Next message to {model} starts a fresh session.",
        )
        ui.set_status(self.status_snapshot())

    def _relay_tier_sequence(self, model: str, pct: float) -> list[str]:
        """Return ordered list of generation tiers to attempt."""
        if pct < RELAY_TIER_SELF_MAX:
            return ["self", "cross", "mechanical"]
        if pct < RELAY_TIER_CROSS_MAX:
            return ["cross", "mechanical"]
        return ["mechanical"]

    def _read_handoff_if_present(
        self, model: str,
    ) -> tuple[str | None, Path | None]:
        """Return (content, path) if a live handoff file exists, else (None, None)."""
        path = self.paths.handoff_live_file(model)
        if path.is_file():
            return path.read_text(encoding="utf-8"), path
        return None, None

    def _read_relay_prompt(self) -> Optional[str]:
        """Read the relay generation prompt from disk."""
        path = self.paths.relay_prompt
        if not path.is_file():
            return None
        return path.read_text(encoding="utf-8")

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

    async def _send_message(
        self, parsed: ParsedInput, ui: UIPort,
        *, attachments: list | None = None,
    ) -> None:
        route = self.router.resolve(parsed)

        prefix = f"{route} " if parsed.target else f"(→{route}) "
        ui.add_room_entry("user", prefix + parsed.body)

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

    async def _send_to_model(
        self, model: str, message: str, ui: UIPort,
    ) -> Optional[AdapterResponse]:
        adapter = self.claude if model == "claude" else self.codex

        if model not in self._models_initialized:
            # Check for a live handoff file (post-relay bootstrap)
            handoff_doc, handoff_path = self._read_handoff_if_present(model)
            relay_turn = self.relay_boundary(model)

            prompt = self._build_initial_prompt(
                model,
                handoff_doc=handoff_doc,
                after_turn=relay_turn,
            )
            self._models_initialized.add(model)
            label = "Resuming" if handoff_doc else "Starting"
            ui.add_room_entry("system", f"{label} {model} session…")
            try:
                resp = await adapter.send(prompt)
            except Exception as e:
                ui.add_room_entry("system", f"Error starting {model}: {e}")
                self._models_initialized.discard(model)
                return None
            # Consume handoff only after successful send
            if handoff_path is not None:
                handoff_path.unlink(missing_ok=True)
            self.transcript.mark_seen(model)
        else:
            # Resume — the user entry is already in the transcript (added
            # by _send_message before dispatch), so context_since picks it
            # up.  Passing "" avoids injecting the user message twice.
            context = self.transcript.context_since(model, "")
            try:
                resp = await adapter.resume(context)
            except Exception as e:
                ui.add_room_entry("system", f"Error from {model}: {e}")
                return None

        if resp.text:
            ui.add_room_entry(model, resp.text)
        for ts in resp.tool_summaries:
            out = f" → {ts.output_preview}" if ts.output_preview else ""
            ui.add_room_entry(model, f"  > {ts.name}({ts.input_preview}){out}")
        if resp.exit_code == -1:
            ui.add_room_entry(
                "system",
                f"{model.capitalize()} CLI timed out. Run /auth {model} to check login state. "
                f"If auth looks fine, /relay @{model} will reset the session.",
            )
        if resp.exit_code not in (0, -1):
            ui.add_room_entry("system",
                              f"{model} exited with code {resp.exit_code}")
            # Detect subscription rate limit and suggest API key fallback
            if "usage limit" in resp.text.lower():
                key_name = ("OPENAI_API_KEY" if model == "codex"
                            else "ANTHROPIC_API_KEY")
                ui.add_room_entry(
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
        parts = [room_preamble(name, other)]
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

    def _update_pct(self, model: str, resp: AdapterResponse,
                    ui: Optional[UIPort] = None) -> None:
        adapter = self.claude if model == "claude" else self.codex
        yield_pct = adapter.context_percent(resp)
        tokens = adapter.context_tokens(resp)
        window = resp.context_window or 200_000
        raw_pct = (tokens / window * 100) if window else 0.0

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
                and model not in self._warned_overlimit_models):
            self._warned_overlimit_models.add(model)
            ui.add_room_entry(
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
        models see prior discussion.  After relay, consumes the live
        handoff file atomically (deleted only after successful send).
        """
        if model in self._models_initialized:
            return True
        adapter = self.claude if model == "claude" else self.codex

        handoff_doc, handoff_path = self._read_handoff_if_present(model)
        relay_turn = self.relay_boundary(model)

        prompt = self._build_initial_prompt(
            model,
            handoff_doc=handoff_doc,
            after_turn=relay_turn,
        )
        self._models_initialized.add(model)
        label = "Resuming" if handoff_doc else "Starting"
        ui.add_room_entry("system", f"{label} {model} session…")
        try:
            resp = await adapter.send(prompt)
        except Exception as e:
            ui.add_room_entry("system", f"Error starting {model}: {e}")
            self._models_initialized.discard(model)
            return False
        # Consume handoff only after successful send
        if handoff_path is not None:
            handoff_path.unlink(missing_ok=True)
        self._update_pct(model, resp, ui)
        self.transcript.mark_seen(model)
        ui.set_status(self.status_snapshot())
        return True

    # ── /caucus ───────────────────────────────────────────

    async def _run_caucus(self, topic: str, ui: UIPort) -> None:
        if not topic:
            ui.add_room_entry("system", "Usage: /caucus <topic>")
            return

        self.mode = RoomMode.CAUCUS
        ui.set_mode(RoomMode.CAUCUS)
        ui.add_caucus_entry("system", f"--- caucus: {topic} ---")
        ui.add_room_entry("system", f"Caucus started: {topic}")

        # Ensure both models are initialised (with transcript backfill)
        for model in ("claude", "codex"):
            if not await self._ensure_initialized(model, ui):
                ui.add_room_entry("system",
                                  f"Caucus aborted — failed to start {model}.")
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
                    ui.add_caucus_entry("system", f"Error from {speaker}: {e}")
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
                ui.add_caucus_entry(speaker, display)
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
        ui.add_caucus_entry("system", "--- caucus ended ---")
        ui.add_room_entry("summary", summary)
        self.transcript.add("system", f"[Caucus summary: {summary}]")

        # Auto-lead from consensus votes
        if self.lead == "auto" and writer_votes:
            votes = list(writer_votes.values())
            if len(set(votes)) == 1:
                self.lead = f"@{votes[0]}"
                ui.add_room_entry(
                    "system", f"Writer consensus → lead set to {self.lead}"
                )

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
            ui.add_room_entry(
                "system",
                "No lead set. Use /lead @claude|@codex or run /caucus first.",
            )
            return

        arg = draft_arg.strip()
        if not arg:
            rounds = 2
        elif re.fullmatch(r"\d+", arg):
            rounds = int(arg)
        else:
            ui.add_room_entry(
                "system",
                "Usage: /draft [rounds]  where rounds is 0, 1, 2, ...",
            )
            return

        self.mode = RoomMode.DRAFT
        ui.set_mode(RoomMode.DRAFT)
        ui.add_room_entry(
            "system",
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
            ui.add_room_entry("system", f"Error drafting: {e}")
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        self._update_pct(lead, resp, ui)
        ui.add_room_entry(lead, resp.text)
        self.transcript.add(lead, resp.text, resp.tool_summaries)
        self.transcript.mark_seen(lead)
        current_plan = resp.text
        self._write_work_file(self._plan_path, current_plan)
        ui.add_room_entry(
            "system",
            f"Updated {self.paths.work_prefix}implementation-plan.md",
        )

        next_round = self._next_reviewer_round()
        for round_number in range(next_round, next_round + rounds):
            self.mode = RoomMode.REVIEW
            ui.set_mode(RoomMode.REVIEW)
            ui.add_room_entry(
                "system",
                f"{reviewer_cap} is reviewing draft round {round_number}…",
            )
            try:
                rev_resp = await rev_adapter.resume(
                    reviewer_preamble(lead_cap, current_plan)
                )
            except Exception as e:
                ui.add_room_entry("system", f"Error reviewing: {e}")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                return

            self._update_pct(reviewer, rev_resp, ui)
            ui.add_room_entry(reviewer, rev_resp.text)
            self.transcript.add(reviewer, rev_resp.text, rev_resp.tool_summaries)
            self.transcript.mark_seen(reviewer)

            review_path = self._reviewer_comments_path(round_number)
            self._write_work_file(review_path, rev_resp.text)
            ui.add_room_entry(
                "system",
                f"Saved reviewer comments to {self.paths.work_prefix}{review_path.name}",
            )

            self.mode = RoomMode.DRAFT
            ui.set_mode(RoomMode.DRAFT)
            ui.add_room_entry(
                "system",
                f"{lead_cap} is revising implementation-plan.md for round {round_number}…",
            )
            try:
                revised_resp = await adapter.resume(
                    revision_from_plan_preamble(
                        current_plan, reviewer_cap, rev_resp.text, round_number
                    )
                )
            except Exception as e:
                ui.add_room_entry("system", f"Error revising: {e}")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                return

            self._update_pct(lead, revised_resp, ui)
            ui.add_room_entry(lead, revised_resp.text)
            self.transcript.add(lead, revised_resp.text, revised_resp.tool_summaries)
            self.transcript.mark_seen(lead)
            current_plan = revised_resp.text
            self._write_work_file(self._plan_path, current_plan)
            ui.add_room_entry(
                "system",
                f"Updated {self.paths.work_prefix}implementation-plan.md",
            )

        self.mode = RoomMode.PUBLIC
        ui.set_mode(RoomMode.PUBLIC)
        ui.set_status(self.status_snapshot())
        ui.add_room_entry(
            "system",
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
            ui.add_room_entry(
                "system",
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
            ui.add_room_entry(
                "system",
                f"No drafted plan found at {self.paths.work_prefix}implementation-plan.md. "
                "Run /draft first.",
            )
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        review_bundle = self._review_bundle()
        final_plan = current_plan
        if review_bundle:
            ui.add_room_entry(
                "system",
                f"{lead_cap} is finalizing implementation-plan.md and addressing all reviewer comments…",
            )
            try:
                final_resp = await adapter.resume(
                    finalize_plan_preamble(current_plan, review_bundle)
                )
            except Exception as e:
                ui.add_room_entry("system", f"Error finalizing plan: {e}")
                self.mode = RoomMode.PUBLIC
                ui.set_mode(RoomMode.PUBLIC)
                return

            self._update_pct(lead, final_resp, ui)
            ui.add_room_entry(lead, final_resp.text)
            self.transcript.add(lead, final_resp.text, final_resp.tool_summaries)
            self.transcript.mark_seen(lead)
            final_plan = final_resp.text
            self._write_work_file(self._plan_path, final_plan)
            ui.add_room_entry(
                "system",
                f"Updated {self.paths.work_prefix}implementation-plan.md",
            )

        ui.add_room_entry("system", f"{lead_cap} is creating checkpoint.md…")
        try:
            checkpoint_resp = await adapter.resume(checkpoint_preamble(final_plan))
        except Exception as e:
            ui.add_room_entry("system", f"Error generating checkpoint: {e}")
            self.mode = RoomMode.PUBLIC
            ui.set_mode(RoomMode.PUBLIC)
            return

        self._update_pct(lead, checkpoint_resp, ui)
        ui.add_room_entry(lead, checkpoint_resp.text)
        self.transcript.add(lead, checkpoint_resp.text, checkpoint_resp.tool_summaries)
        self.transcript.mark_seen(lead)
        self._write_work_file(self._checkpoint_path, checkpoint_resp.text)
        ui.add_room_entry(
            "system",
            f"Updated {self.paths.work_prefix}checkpoint.md",
        )

        archived_comments = self._archive_reviewer_comments()
        if archived_comments:
            ui.add_room_entry(
                "system",
                f"Archived {archived_comments} reviewer comment file(s) to archive/reviewer-comments/{self._thread_slug()}/",
            )

        self.mode = RoomMode.PUBLIC
        ui.set_mode(RoomMode.PUBLIC)
        ui.set_status(self.status_snapshot())
        ui.add_room_entry(
            "system",
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
    parser.add_argument("--openai-model", default="gpt-5.4")
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

    claude = ClaudeAdapter(model=args.anthropic_model, effort=args.claude_effort,
                           tools=["Read", "Glob", "Grep", "Bash",
                                  "WebSearch", "WebFetch"],
                           debug_log_path=claude_log)
    codex = CodexAdapter(model=args.openai_model, debug_log_path=codex_log,
                         fallback_api_key=_fallback_api_key)
    paths = BotferencePaths.resolve()
    botference = Botference(
        claude=claude, codex=codex,
        system_prompt=args.system_prompt, task=args.task,
        paths=paths,
    )
    botference.observe = args.debug_panes

    app = BotferenceApp(initial_status=botference.status_snapshot())

    def on_submit(text: str) -> None:
        async def _handle() -> None:
            await botference.handle_input(text, app)
            if botference.quit_requested:
                app.exit()
        app.run_worker(_handle(), exclusive=True)

    app.on_submit = on_submit
    app.run()


if __name__ == "__main__":
    main()
