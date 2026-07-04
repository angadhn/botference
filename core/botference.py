"""
botference.py — Controller for botference mode.

Command parsing, auto-routing, free-form handoffs, finalize flow,
transcript management, and mode tracking.  The Ink TUI talks to this
controller through botference_ink_bridge.py; this module is the
headless logic layer so it can be tested without a UI.
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
from typing import Any, Awaitable, Callable, Optional, Protocol

from cli_adapters import (
    AdapterResponse,
    ClaudeAdapter,
    ClaudeInteractiveTmuxAdapter,
    CodexAdapter,
    PlannerWriteConfig,
    ToolSummary,
    is_credit_error,
    normalize_claude_transport,
    normalize_write_roots,
    planner_write_config,
    planner_write_roots_for_env,
)
from paths import BotferencePaths
from project_store import ProjectInfo, ProjectStore
from ui_types import (
    ProjectPanelProject,
    ProjectPanelSession,
    ProjectPanelState,
    RoomMode,
    StatusSnapshot,
)
from room_prompts import (
    ROOM_ROLE_SUFFIX,
    WRITER_PREAMBLE,
    checkpoint_preamble,
    finalize_plan_preamble,
    free_form_protocol,
    free_form_resume_note,
    free_form_turn_status,
    reviewer_preamble,
    revision_from_plan_preamble,
    room_preamble,
    project_skill_context,
)
from datetime import datetime as _dt, timezone as _tz
from handoff import build_frontmatter, validate_handoff
from render_blocks import parse_render_blocks
from session_store import (
    SessionStore,
    SessionSummary,
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
    PROJECTS = "projects"
    PROJECT = "project"
    LEAD = "lead"
    DRAFT = "draft"
    FINALIZE = "finalize"
    PERMISSIONS = "permissions"
    STATUS = "status"
    AUTH = "auth"
    HELP = "help"
    QUIT = "quit"
    RELAY = "relay"
    HARNESS_COMMAND = "harness_command"
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
    "/projects": InputKind.PROJECTS,
    "/project": InputKind.PROJECT,
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
_HARNESS_TARGET_RE = re.compile(
    r"^@?(claude|codex)(?:\s+(.*))?$", re.IGNORECASE | re.DOTALL
)

_SESSION_TITLE_MAX = 80
_CODEX_DIFF_PREVIEW_LIMIT = 120_000

# Commands that require a @target argument, expanded into @claude/@codex variants
_TARGETED_COMMANDS = (
    "/lead", "/relay", "/tag", "/model", "/effort", "/compact", "/goal",
)

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
    Trailing spaces on @mentions signal that a message body follows.
    """
    out: list[str] = []
    for cmd in _TARGETED_COMMANDS:
        out.append(f"{cmd} @claude")
        out.append(f"{cmd} @codex")
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


# Bound relay/late-join backfill so a freshly (re)started model session cannot be
# handed a Room-History block large enough to overflow its context window. The
# handoff document already carries the durable summary; the backfill only needs the
# most-recent turns for continuity. Without this bound a relay could rebuild a
# prompt as large as the session that triggered it — the failure that wedged long
# sessions, where recovery itself overflowed.
_BACKFILL_MAX_CHARS = 60_000


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


# ── UI callback protocol ──────────────────────────────────


class UIPort(Protocol):
    """Minimal interface the controller needs from the TUI."""
    def add_room_entry(
        self, speaker: str, text: str, blocks: Optional[list[dict]] = None,
    ) -> None: ...
    def set_status(self, status: StatusSnapshot) -> None: ...
    def set_projects(self, state: ProjectPanelState) -> None: ...
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

_RELAY_USAGE = "Usage: /relay @claude|@codex  (aliases: /relay-claude, /tag @claude)"
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
        self.active_project_id: str = ""
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
        self._ff_writer_votes: dict[str, str] = {}  # model → "claude"/"codex" writer vote
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
        self._stream_seq: int = 0
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
            observe_enabled=self.observe,
        )

    @property
    def _plan_path(self) -> Path:
        return self._planning_scope_root() / "implementation-plan.md"

    @property
    def _checkpoint_path(self) -> Path:
        return self._planning_scope_root() / "checkpoint.md"

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
        return [summary for _, summary in rows[:limit]]

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

    def project_panel_snapshot(self) -> ProjectPanelState:
        # Hot path: this fires at startup and after every turn. We rely on a
        # cached metadata index (work/sessions/.metadata-index.json) so we
        # never parse the full session corpus more than once per process,
        # and counts honor both `payload.project_id` AND empty/unresumable
        # filtering — the things a raw filesystem count would get wrong.
        projects = self.project_store.list_projects()
        indexed_to_project = self.project_store.session_index_map()
        metadata = self.session_store.metadata_index()

        global_dir = self.paths.session_dir
        inbox_count = 0
        global_count_by_project: dict[str, int] = {}
        for session_id, entry in metadata.items():
            if entry.entry_count < 1:
                continue
            project_id = entry.project_id or indexed_to_project.get(session_id, "")
            if project_id:
                global_count_by_project[project_id] = (
                    global_count_by_project.get(project_id, 0) + 1
                )
            else:
                inbox_count += 1

        local_count_by_project: dict[str, int] = {}
        for project in projects:
            local_dir = project.session_dir
            if local_dir == global_dir or not local_dir.is_dir():
                continue
            # Project-local dirs are typically tiny — parse inline to match
            # the same "entry_count >= 1" filter we apply globally.
            count = 0
            for path in local_dir.glob("*.json"):
                if path.name.startswith("."):
                    continue
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                transcript = payload.get("transcript", [])
                if (
                    isinstance(transcript, list)
                    and len(transcript) >= 1
                    and self._payload_belongs_to_project(
                        payload, project, source_path=path
                    )
                ):
                    count += 1
            local_count_by_project[project.id] = count

        panel_projects: list[ProjectPanelProject] = []
        for project in projects:
            is_active = project.id == self.active_project_id
            session_count = (
                global_count_by_project.get(project.id, 0)
                + local_count_by_project.get(project.id, 0)
            )
            if is_active:
                summaries = self._project_tagged_summaries(project, limit=8)
                panel_sessions = tuple(
                    ProjectPanelSession(
                        session_id=s.session_id,
                        title=s.title,
                        updated_at=s.updated_at,
                        active=s.session_id == self.session_id,
                    )
                    for s in summaries
                )
            else:
                panel_sessions = ()
            panel_projects.append(ProjectPanelProject(
                project_id=project.id,
                title=project.title,
                status=project.status,
                next_action=project.next_action,
                active=is_active,
                session_count=session_count,
                sessions=panel_sessions,
            ))
        return ProjectPanelState(
            projects=tuple(panel_projects),
            active_project_id=self.active_project_id,
            inbox_session_count=inbox_count,
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
            "project_id": self.active_project_id,
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
            "writer_votes": dict(self._ff_writer_votes),
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
            if self.active_project_id:
                self.project_store.associate_session(
                    self.active_project_id, self.session_id
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
            "Use /project open <id> to filter by project, or /project clear for Inbox/global.",
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
            self.active_project_id = str(payload.get("project_id", "") or "")
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
            self._ff_writer_votes = {
                str(model): str(vote)
                for model, vote in (payload.get("writer_votes", {}) or {}).items()
            }

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
            self._pending_relay_handoffs = {
                str(model): str(value)
                for model, value in (payload.get("pending_relay_handoffs", {}) or {}).items()
            }
        finally:
            self._restoring_session = False
        return saved_mode

    def _replay_restored_session(self, ui: UIPort) -> None:
        room = [
            (e.speaker, e.text, self._structured_blocks(e.text))
            for e in self._room_history
            if not self._is_routine_restored_system_entry(e)
        ]
        # Fast path: bulk-restore in batches (single state update per batch).
        # Falls back to per-entry replay for any UIPort without restore_entries.
        bulk = getattr(ui, "restore_entries", None)
        if callable(bulk):
            bulk(room)
            return
        for speaker, text, blocks in room:
            self._emit_room_entry(ui, speaker, text, blocks, restored=True)

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
            matches = [
                summary.session_id
                for summary in summaries
                if summary.session_id == query or summary.session_id.startswith(query)
            ]
            if not matches:
                matches = self._matching_sessions_by_title(summaries, query)
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
            self._handle_project_cmd(parsed.body, ui)
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

        if parsed.kind is InputKind.HARNESS_COMMAND:
            await self._run_harness_command(parsed.target, parsed.body, ui)
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
            "  /projects          — List project folders under projects/",
            "  /project [open <id>|clear|current|create <title>|create-from-chat|activate-build]",
            "                     — Set, show, or create the active project context",
            "  /project assign [<session-id-prefix>] <project-id>",
            "                     — File this chat (or a saved one) under a project without switching context",
            "  /lead @claude|@codex — Set who writes the plan (auto-set when the bots agree on a writer)",
            "  /draft [rounds]     — Update implementation-plan.md with 0/1/2+ AI review rounds (default: 2)",
            "  /finalize           — Address reviewer comments, write final plan, create checkpoint.md",
            "  /relay @claude|@codex — Reset model session with structured handoff",
            "  /compact @claude [instructions] — Send native Claude Code /compact (requires --claude-interactive)",
            "  /goal @claude <objective> — Send native Claude Code /goal (requires --claude-interactive)",
            "  /resume [latest|number|title|id] — Switch to a saved plan session (works mid-chat; current session is auto-persisted)",
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
            "Workflow: discuss (bots hand each other the floor) → /draft [rounds] → /finalize",
            "",
            "Keys (Ink TUI): Esc interrupts the current turn. Shift+Enter inserts a newline.",
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
        ])
        self._add_room_entry(ui, "system", "\n".join(lines))

    def _handle_project_cmd(self, arg: str, ui: UIPort) -> None:
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
            self.active_project_id = ""
            self._persist_session()
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
        self.active_project_id = project.id
        self._persist_session()
        self.project_store.associate_session(project.id, self.session_id)
        self._sync_project_ui(ui)
        self._show_room_notice(
            ui,
            "system",
            f"Project context set to {project.title} ({project.id}).\n"
            f"Plan writes now target {self._planning_display_path(self._plan_path)}.\n"
            f"Run /resume to see chats for this project.",
        )

    def _assign_session_to_project(self, arg: str, ui: UIPort) -> None:
        """File a chat into a project without switching the active context.

        Usage: /project assign <project-id>                (current chat)
               /project assign <session-id-prefix> <project-id>
        """
        usage = ("Usage: /project assign <project-id>  or  "
                 "/project assign <session-id-prefix> <project-id>")
        parts = arg.split()
        if not parts or len(parts) > 2:
            self._add_room_entry(ui, "system", usage)
            return

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

        project = self.project_store.get(project_query)
        if not project:
            self._add_room_entry(
                ui, "system",
                f"No project matched '{project_query}'. "
                "Run /projects to list available projects.",
            )
            return

        self.project_store.associate_session(project.id, session_id)
        self._sync_project_ui(ui)
        self._add_room_entry(
            ui, "system",
            f"Filed {session_label} under {project.title} ({project.id}). "
            "The active context is unchanged — use /project open "
            f"{project.id} to switch to it.",
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
        """
        if self.active_project_id:
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
            self.active_project_id = project.id
            self._persist_session()
            self.project_store.associate_session(project.id, self.session_id)
            self._sync_project_ui(ui)
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

        self.active_project_id = project.id
        self.project_store.associate_session(project.id, self.session_id)
        self._persist_session()
        self._sync_project_ui(ui)
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
    ) -> AdapterResponse:
        stream_id = self._next_stream_id(model, pane)
        old_callback = getattr(adapter, "stream_callback", None)
        self._emit_stream_event(ui, {
            "kind": "start",
            "stream_id": stream_id,
            "pane": pane,
            "model": model,
        })

        def _callback(event: dict[str, Any]) -> None:
            self._emit_stream_event(ui, {
                **event,
                "stream_id": stream_id,
                "pane": pane,
                "model": model,
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
    ) -> None:
        if stream_id or restored:
            try:
                ui.add_room_entry(
                    speaker,
                    text,
                    blocks,
                    stream_id=stream_id,
                    restored=restored,
                )  # type: ignore[call-arg]
                return
            except TypeError:
                pass
        ui.add_room_entry(speaker, text, blocks)

    def _add_room_entry(
        self, ui: UIPort, speaker: str, text: str, *, stream_id: str = "",
    ) -> None:
        self._room_history.append(DisplayRecord(speaker=speaker, text=text))
        self._emit_room_entry(
            ui,
            speaker,
            text,
            self._structured_blocks(text),
            stream_id=stream_id,
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
        fall back to the cheaper Claude Opus 4.8.

        The default Claude participant is Fable 5, which bills at a premium; when
        its credit balance runs out the raw CLI error is opaque, so surface the
        exact switch command instead. Suppressed once already on Opus 4.8 (a bare
        balance problem there needs a top-up, not a model switch).
        """
        if model != "claude" or not is_credit_error(text):
            return
        fallback = "claude-opus-4-8"
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
            f"limit. Switch to the cheaper Claude Opus 4.8 with:\n"
            f"    /model @claude {fallback}\n"
            f"or relaunch botference with:  --anthropic-model {fallback}",
        )

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
        await self._maybe_suggest_project(body, ui)

        targets = (
            ["claude", "codex"] if route == "@all"
            else [route.lstrip("@")]
        )

        last_speaker: Optional[str] = None
        last_resp: Optional[AdapterResponse] = None
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
                visual_warning = _visual_verification_warning(model, resp)
                if visual_warning:
                    self._add_room_entry(ui, "system", visual_warning)
                    self.transcript.add("system", visual_warning)
                self.transcript.mark_seen(model)
                self._update_pct(model, resp, ui)
                ui.set_status(self.status_snapshot())
                self._persist_session()
                last_speaker, last_resp = model, resp

        if (
            self.mode is RoomMode.PUBLIC
            and last_speaker is not None
            and last_resp is not None
        ):
            await self._run_free_form_thread(last_speaker, last_resp, ui)

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

        while True:
            target = free_form_next_target(current_speaker, current_resp.text)
            if target is None or target == "user":
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
            visual_warning = _visual_verification_warning(target, next_resp)
            if visual_warning:
                self._add_room_entry(ui, "system", visual_warning)
                self.transcript.add("system", visual_warning)
            self.transcript.mark_seen(target)
            self._update_pct(target, next_resp, ui)
            ui.set_status(self.status_snapshot())
            self._persist_session()

            tokens_used += self._response_output_tokens(next_resp)
            current_speaker, current_resp = target, next_resp

    async def _send_to_model(
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
        self._write_work_file(self._plan_path, plan_text)
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
            self._write_work_file(self._plan_path, final_plan)
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
        self._write_work_file(self._checkpoint_path, checkpoint_text)
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
        self.transcript.add("system", "[Interrupted current turn]")
        self._persist_session()

    def _resolve_lead(self) -> Optional[str]:
        """Resolve lead to bare model name, or None if auto."""
        if self.lead == "auto":
            return None
        return self.lead.lstrip("@")
