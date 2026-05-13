"""
cli_adapters.py — Async subprocess wrappers for Claude and Codex CLIs.

Botference mode wraps installed CLIs as subprocesses (no API keys, no providers.py).
Auth comes from existing CLI logins (claude login / codex login).

Verified syntax from spike-output/CLI-SPIKE-RESULTS.md (Task 0, commit 55e2209).
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
import json
import logging
import os
import re
import shlex
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from providers import percent_of_limit
from render_blocks import build_tool_use_blocks, parse_render_blocks

log = logging.getLogger(__name__)

StreamCallback = Callable[[dict[str, Any]], None]

_ANSI_RE = re.compile(
    r"(?:\x1b\][^\x07]*(?:\x07|\x1b\\))|(?:\x1b\[[0-?]*[ -/]*[@-~])"
)


def normalize_claude_transport(value: Optional[str]) -> str:
    raw = (value or os.environ.get("BOTFERENCE_CLAUDE_TRANSPORT", "")).strip().lower()
    if raw in ("", "default", "programmatic", "cli", "claude-p", "print"):
        return "programmatic"
    if raw in ("tmux", "interactive", "claude-interactive"):
        return "tmux"
    raise ValueError(
        f"Unsupported Claude transport '{value}'. Use 'programmatic' or 'tmux'."
    )


def tmux_safe_name(*parts: str, max_len: int = 80) -> str:
    raw = "-".join(part for part in parts if part)
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", raw).strip("-")
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return (cleaned or "botference-claude")[:max_len]


def normalize_tmux_capture(text: str) -> str:
    text = _ANSI_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def tmux_capture_delta(previous: str, current: str) -> str:
    previous = normalize_tmux_capture(previous)
    current = normalize_tmux_capture(current)
    if not current or current == previous:
        return ""
    if previous and current.startswith(previous):
        return current[len(previous):].lstrip("\n")

    prev_lines = previous.splitlines()
    cur_lines = current.splitlines()
    max_overlap = min(len(prev_lines), len(cur_lines))
    for overlap in range(max_overlap, 0, -1):
        if prev_lines[-overlap:] == cur_lines[:overlap]:
            return "\n".join(cur_lines[overlap:]).strip("\n")
    return current


def build_tmux_paste_payload(prompt: str) -> bytes:
    if not prompt.endswith("\n"):
        prompt += "\n"
    return prompt.encode("utf-8")


def normalize_interactive_claude_model(model: str) -> str:
    """Interactive Claude Code does not accept Botference's `[1m]` model suffix."""
    return re.sub(r"\[1m\]?$", "", model.strip())


def extract_tmux_assistant_text(capture: str) -> str:
    """Extract Claude-visible response/tool text from an interactive TUI screen.

    Claude Code's interactive UI continuously redraws the whole screen. This
    intentionally ignores prompt echoes, status bars, splash text, and activity
    spinners, then keeps only assistant/tool-looking blocks.
    """
    blocks: list[str] = []
    current: list[str] = []
    seen_blocks: set[str] = set()

    def flush_current() -> None:
        nonlocal current
        while current and current[-1] == "":
            current.pop()
        block = "\n".join(current).strip()
        current = []
        if not block or block in seen_blocks:
            return
        seen_blocks.add(block)
        blocks.append(block)

    for raw_line in normalize_tmux_capture(capture).splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            if current and current[-1] != "":
                current.append("")
            continue
        if (
            "Claude Code v" in stripped
            or "Claude Max" in stripped
            or "⟳" in stripped
            or "/effort" in stripped
            or "paste again" in stripped.lower()
            or "don't ask on" in stripped.lower()
            or re.fullmatch(r"[─━]+.*", stripped)
            or stripped.startswith(("▐", "▝", "▘", "✢", "✽", "✻", "✶"))
        ):
            flush_current()
            continue
        if re.match(r"^[❯>]\s", stripped):
            flush_current()
            continue
        assistant_match = re.match(r"^[⏺●]\s*(.*)", stripped)
        if assistant_match:
            flush_current()
            text = assistant_match.group(1).strip()
            if text:
                current.append(text)
            continue
        if stripped.startswith(("⎿", "↳", "⤷")):
            current.append(stripped)
            continue
        if current and raw_line.startswith(("  ", "\t")):
            current.append(stripped)
            continue
        flush_current()

    flush_current()
    return "\n\n".join(blocks)


def tmux_capture_looks_idle(capture: str) -> bool:
    text = normalize_tmux_capture(capture).lower()
    if not text:
        return False
    tail_lines = text.splitlines()[-24:]
    tail = "\n".join(tail_lines)
    busy_markers = (
        "esc to interrupt",
        "press esc to interrupt",
        "ctrl+c to cancel",
        "thinking",
        "running",
        "working",
        "percolating",
        "churning",
    )
    if any(marker in tail for marker in busy_markers):
        return False
    return bool(
        any(re.match(r"\s*(>|❯|›)\s*$", line) for line in tail_lines)
        or "what would you like" in tail
        or "try \"" in tail and "claude" in tail
    )


def _resolve_write_root_entry(project_root: Path, root: str | Path) -> Path | None:
    raw = str(root).strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = project_root / candidate
    return candidate.resolve()


_DEFAULT_PLAN_ALLOWED_HOSTS = (
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "api.github.com",
)


def _plan_network_enabled() -> bool:
    raw = os.environ.get("BOTFERENCE_PLAN_ALLOW_NETWORK", "").strip().lower()
    if raw == "":
        return True
    return raw in ("1", "true", "yes", "on")


def _plan_allowed_hosts() -> list[str]:
    raw = os.environ.get("BOTFERENCE_PLAN_ALLOWED_HOSTS", "").strip()
    if not raw:
        return list(_DEFAULT_PLAN_ALLOWED_HOSTS)
    return [h.strip() for h in raw.split(",") if h.strip()]


@dataclass(frozen=True)
class PlannerWriteConfig:
    write_roots: list[Path]
    claude_cwd: str
    claude_add_dirs: list[str]
    claude_settings: dict
    codex_cwd: str
    codex_add_dirs: list[str]
    codex_sandbox: str
    codex_network_access: bool = False


def plan_allowed_tools_for_work_dir(
    project_root: str | Path, work_dir: str | Path
) -> list[str]:
    """Allowed Claude plan-mode tools for the Botference work area.

    When the work dir is a dedicated subdirectory (`botference/` or `work/`),
    grant Write/Edit/MultiEdit across that tree. If the resolved work dir
    collapses to the project root, keep the older narrow allowlist rather than
    silently opening the whole repo to writes.
    """

    base_tools = ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"]
    project_root_path = Path(project_root).resolve()
    work_dir_path = Path(work_dir).resolve()

    if work_dir_path == project_root_path:
        return base_tools + [
            "Edit(/checkpoint.md)",
            "Edit(/implementation-plan.md)",
            "Edit(/implementation-plan-*.md)",
            "Edit(/inbox.md)",
            "Write(/checkpoint.md)",
            "Write(/implementation-plan.md)",
            "Write(/implementation-plan-*.md)",
            "Write(/inbox.md)",
        ]

    work_rel = os.path.relpath(work_dir_path, project_root_path).replace(os.sep, "/")
    patterns = [f"/{work_rel}/*", f"/{work_rel}/**"]
    allowed = list(base_tools)
    for tool in ("Edit", "Write", "MultiEdit"):
        for pattern in patterns:
            allowed.append(f"{tool}({pattern})")
    return allowed


def planner_write_roots_for_env(
    project_root: str | Path,
    fallback_dir: str | Path,
    *,
    mode: str = "plan",
) -> list[Path]:
    """Resolve explicit write roots from Botference env for a mode."""
    project_root_path = Path(project_root).resolve()
    config_name = os.environ.get("BOTFERENCE_PROJECT_DIR_NAME", "botference")
    project_config = project_root_path / config_name / "project.json"
    env_name = "BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS" if mode == "plan" else "BOTFERENCE_BUILD_EXTRA_WRITE_ROOTS"
    raw_roots = os.environ.get(env_name, "").strip()
    if raw_roots:
        roots = []
        for root in raw_roots.split(","):
            resolved = _resolve_write_root_entry(project_root_path, root)
            if resolved is not None:
                roots.append(resolved)
        return roots
    if project_config.exists():
        return []
    return [Path(fallback_dir).resolve()]


def normalize_write_roots(write_roots: list[str | Path]) -> list[Path]:
    normalized: list[Path] = []
    seen: set[Path] = set()
    for root in write_roots:
        path = Path(root).resolve()
        if path in seen:
            continue
        seen.add(path)
        normalized.append(path)
    return normalized


def claude_plan_settings_for_write_roots(write_roots: list[str | Path]) -> dict:
    """Build Claude Code settings for planner sessions from explicit write roots."""
    normalized_roots = normalize_write_roots(write_roots)

    allow_rules = [
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "WebSearch",
        "WebFetch",
    ]
    sandbox = {
        "enabled": True,
        "allowUnsandboxedCommands": False,
    }
    if _plan_network_enabled():
        sandbox["network"] = {"allowedDomains": _plan_allowed_hosts()}

    seen = set()
    for root in normalized_roots:
        root_abs = root.as_posix().lstrip("/")
        if root_abs in seen:
            continue
        seen.add(root_abs)
        allow_rules.extend([
            f"Edit(//{root_abs})",
            f"Edit(//{root_abs}/*)",
            f"Edit(//{root_abs}/**)",
        ])

    return {
        "permissions": {
            "defaultMode": "dontAsk",
            "allow": allow_rules,
        },
        "sandbox": sandbox,
    }


def claude_plan_settings_for_work_dir(
    project_root: str | Path, work_dir: str | Path
) -> dict:
    """Backward-compatible wrapper for existing tests/callers."""
    roots = planner_write_roots_for_env(project_root, work_dir, mode="plan")
    return claude_plan_settings_for_write_roots([str(root) for root in roots])


def planner_write_config(
    project_root: str | Path,
    write_roots: list[str | Path],
) -> PlannerWriteConfig:
    """Build the runtime CLI config for planner sessions from write roots."""
    project_root_path = Path(project_root).resolve()
    normalized_roots = normalize_write_roots(write_roots)
    primary_root = normalized_roots[0] if normalized_roots else project_root_path

    claude_add_dirs: list[str] = []
    if primary_root != project_root_path:
        claude_add_dirs.append(str(project_root_path))
    for root in normalized_roots[1:]:
        root_str = str(root)
        if root_str not in claude_add_dirs:
            claude_add_dirs.append(root_str)

    codex_add_dirs = [str(root) for root in normalized_roots[1:]]

    return PlannerWriteConfig(
        write_roots=normalized_roots,
        claude_cwd=str(primary_root),
        claude_add_dirs=claude_add_dirs,
        claude_settings=claude_plan_settings_for_write_roots(normalized_roots),
        codex_cwd=str(primary_root),
        codex_add_dirs=codex_add_dirs,
        codex_sandbox="workspace-write" if normalized_roots else "read-only",
        codex_network_access=_plan_network_enabled(),
    )

# ── Response types ───────────────────────────────────────────


@dataclass
class ToolSummary:
    id: str  # stable item ID for dedup (tool_use_id or codex item.id)
    name: str
    input_preview: str  # truncated input for TUI display
    output_preview: str = ""  # filled when tool_result arrives
    output_blocks: list[dict] = field(default_factory=list)
    pending_output_blocks: list[dict] = field(default_factory=list)


@dataclass
class AdapterResponse:
    text: str
    tool_summaries: list = field(default_factory=list)
    raw_output: str = ""  # full JSONL for debug panes
    exit_code: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    context_window: int = 0  # from modelUsage (Claude) or default (Codex)
    tool_result_tokens_estimate: int = 0  # estimated tokens from tool results
    occupancy_tokens: int = 0  # point-in-time prompt occupancy from last assistant event
    turn_input_tokens: int = 0  # last-turn prompt footprint (Codex delta of cumulative usage)
    turn_cached_input_tokens: int = 0  # last-turn cached input component for debugging/UI
    turn_output_tokens: int = 0  # last-turn output tokens for debugging/UI
    context_tokens_reliable: bool = True  # false when usage lacks a stable baseline
    session_id: str = ""  # session/thread ID for resume
    stream_id: str = ""  # UI stream ID used to replace live partial output


# ── Context windows (fallback when not reported by CLI) ──────

_CONTEXT_WINDOWS = {
    "claude-opus-4-6": 1_000_000,
    "claude-opus-4-7": 1_000_000,
    "claude-sonnet-4-6": 1_000_000,
    "claude-haiku-4-5": 200_000,
    "gpt-5-latest": 272_000,
    "gpt-5.5": 258_000,
    "gpt-5.4": 272_000,
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "o3": 200_000,
    "o4-mini": 200_000,
}

_CODEX_MODEL_ALIASES = {
    # Probe the current Codex/OpenAI path for the newest GPT-5 release we want
    # to use, but fall back to GPT-5.4 until that model is actually live there.
    "gpt-5-latest": ("gpt-5.5", "gpt-5.4"),
}

_CODEX_MODEL_PROBE_PROMPT = "Reply with exactly OK."

_DEFAULT_TIMEOUT = 3600  # seconds


def _timeout_from_env(*names: str, default: int = _DEFAULT_TIMEOUT) -> int:
    for name in names:
        raw = os.environ.get(name, "").strip()
        if not raw:
            continue
        try:
            value = int(raw)
        except ValueError:
            log.warning("Ignoring invalid %s=%r; expected integer seconds", name, raw)
            continue
        if value > 0:
            return value
        log.warning("Ignoring non-positive %s=%r; expected integer seconds", name, raw)
    return default


def _tail_excerpt(raw_lines: list[str], limit: int = 8) -> str:
    if not raw_lines:
        return ""
    return "\n".join(raw_lines[-limit:])


def _truncate(s: str, limit: int = 120) -> str:
    return s if len(s) <= limit else s[:limit] + "..."


def _delta_from_cumulative(current: int, previous: int) -> int:
    """Convert cumulative token counters into a last-turn delta."""
    if current <= 0:
        return 0
    if previous <= 0 or current < previous:
        return current
    return current - previous


def _structured_output_blocks(text: str, limit: int = 8000) -> list[dict]:
    if not text:
        return []
    blocks = parse_render_blocks(text[:limit])
    if all(block.get("type") == "text" for block in blocks):
        return []
    return blocks


def _tool_result_failed(text: str) -> bool:
    lowered = text.lower()
    failure_markers = (
        "error",
        "failed",
        "could not",
        "couldn't",
        "cannot",
        "not found",
        "no changes",
        "did not match",
        "unable to",
    )
    return any(marker in lowered for marker in failure_markers)


# ── Shared JSONL reader ─────────────────────────────────────


async def _read_jsonl_lines(stream: asyncio.StreamReader, raw_lines: list,
                           debug_file=None):
    """Yield parsed JSON objects from an async stream.

    Every stdout line (JSON or not) is appended to raw_lines for debug panes.
    If *debug_file* is an open file handle, lines are also written there in
    real-time so ``tail -f`` shows live output.
    Non-JSON lines are captured but not yielded.

    Uses chunk-based reading to handle lines >64KB (Claude tool results
    can be very large, exceeding asyncio.StreamReader's default limit).
    """
    buf = b""
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            # Process any remaining data in buffer
            if buf:
                line = buf.decode("utf-8", errors="replace").strip()
                if line:
                    raw_lines.append(line)
                    if debug_file:
                        debug_file.write(line + "\n")
                        debug_file.flush()
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        log.debug("non-JSON stdout line: %s", line[:200])
            break
        buf += chunk
        while b"\n" in buf:
            line_bytes, buf = buf.split(b"\n", 1)
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            raw_lines.append(line)
            if debug_file:
                debug_file.write(line + "\n")
                debug_file.flush()
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                log.debug("non-JSON stdout line: %s", line[:200])


# ── Claude Adapter ───────────────────────────────────────────


class ClaudeAdapter:
    """Wraps `claude -p` with session continuity via --session-id / --resume."""

    def __init__(self, model: str = "claude-sonnet-4-6",
                 tools: Optional[list] = None,
                 effort: str = "",
                 timeout: Optional[int] = None,
                 debug_log_path: str = "",
                 cwd: str = "",
                 add_dirs: Optional[list[str]] = None,
                 settings: Optional[dict] = None,
                 stream_callback: Optional[StreamCallback] = None):
        self.model = model
        self.tools = tools or ["Read", "Glob", "Grep", "Bash"]
        self.effort = effort
        self.timeout = timeout or _timeout_from_env(
            "BOTFERENCE_CLAUDE_TIMEOUT",
            "BOTFERENCE_CLI_TIMEOUT",
        )
        self.debug_log_path = debug_log_path
        self.cwd = cwd
        self.add_dirs = add_dirs or []
        self.settings = settings
        self.session_id: str = ""
        self.stream_callback = stream_callback

    def _emit_stream(self, event: dict[str, Any]) -> None:
        if not self.stream_callback:
            return
        try:
            self.stream_callback(event)
        except Exception:
            log.exception("Claude stream callback failed")

    def _build_cmd(self, resume: bool) -> list:
        cmd = ["claude", "-p"]
        if resume:
            cmd += ["--resume", self.session_id]
        else:
            cmd += ["--session-id", self.session_id]
        cmd += [
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--verbose",
            "--model", self.model,
            "--tools", ",".join(self.tools),
        ]
        if self.effort:
            cmd += ["--effort", self.effort]
        for path in self.add_dirs:
            cmd += ["--add-dir", path]
        if self.settings:
            cmd += ["--settings", json.dumps(self.settings, separators=(",", ":"))]
        return cmd

    async def send(self, prompt: str) -> AdapterResponse:
        """First message — creates a new session."""
        self.session_id = str(uuid.uuid4())
        return await self._run(prompt, resume=False)

    async def resume(self, message: str) -> AdapterResponse:
        """Follow-up message in existing session."""
        if not self.session_id:
            raise RuntimeError("No session to resume — call send() first")
        return await self._run(message, resume=True)

    async def _run(self, prompt: str, *, resume: bool) -> AdapterResponse:
        cmd = self._build_cmd(resume)
        log.debug("claude cmd: %s", " ".join(cmd))

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd or None,
            )
        except FileNotFoundError:
            return AdapterResponse(
                text="Error: `claude` CLI not found. "
                     "Install with: npm install -g @anthropic-ai/claude-code",
                exit_code=127,
            )

        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        text_parts = []
        streamed_text: dict[str, str] = {}
        tool_summaries = []
        raw_lines = []
        pending_tools = {}  # tool_use_id -> ToolSummary
        response = AdapterResponse(text="", session_id=self.session_id)
        debug_file = (open(self.debug_log_path, "a")
                      if self.debug_log_path else None)

        async def _drain():
            nonlocal text_parts
            async for event in _read_jsonl_lines(proc.stdout, raw_lines,
                                                 debug_file):
                etype = event.get("type", "")

                if etype == "assistant":
                    message = event.get("message", {})
                    message_id = message.get("id", "")
                    for index, block in enumerate(message.get("content", [])):
                        btype = block.get("type", "")
                        if btype == "text":
                            text = block.get("text", "")
                            if not text:
                                continue
                            key = f"{message_id}:{index}" if message_id else f"assistant:{index}"
                            previous = streamed_text.get(key, "")
                            if text.startswith(previous):
                                delta = text[len(previous):]
                                streamed_text[key] = text
                            elif previous and previous.endswith(text):
                                delta = ""
                            else:
                                delta = text
                                streamed_text[key] = previous + text
                            if delta:
                                self._emit_stream({
                                    "kind": "text_delta",
                                    "model": "claude",
                                    "text": delta,
                                })
                        elif btype == "tool_use":
                            tool_id = block.get("id", "")
                            ts = ToolSummary(
                                id=tool_id,
                                name=block.get("name", ""),
                                input_preview=_truncate(
                                    json.dumps(block.get("input", {}))
                                ),
                                pending_output_blocks=build_tool_use_blocks(
                                    block.get("name", ""),
                                    block.get("input", {}),
                                ),
                            )
                            pending_tools[tool_id] = ts
                            tool_summaries.append(ts)
                            self._emit_stream({
                                "kind": "tool_start",
                                "model": "claude",
                                "tool_id": tool_id,
                                "name": ts.name,
                                "input_preview": ts.input_preview,
                            })
                    # Capture point-in-time occupancy from assistant event usage
                    usage = event.get("message", {}).get("usage")
                    if usage:
                        response.occupancy_tokens = (
                            usage.get("input_tokens", 0)
                            + usage.get("cache_creation_input_tokens", 0)
                            + usage.get("cache_read_input_tokens", 0)
                        )

                elif etype == "user":
                    for block in event.get("message", {}).get("content", []):
                        if block.get("type") == "tool_result":
                            tid = block.get("tool_use_id", "")
                            content = block.get("content", "")
                            if isinstance(content, list):
                                content = " ".join(
                                    str(c.get("text", c)) for c in content
                                )
                            content_str = str(content)
                            response.tool_result_tokens_estimate += len(content_str) // 4
                            if tid in pending_tools:
                                structured_blocks = _structured_output_blocks(content_str)
                                pending_tools[tid].output_preview = _truncate(
                                    content_str, 200
                                )
                                if structured_blocks:
                                    pending_tools[tid].output_blocks = structured_blocks
                                elif (
                                    pending_tools[tid].pending_output_blocks
                                    and not _tool_result_failed(content_str)
                                ):
                                    pending_tools[tid].output_blocks = (
                                        pending_tools[tid].pending_output_blocks
                                    )
                                self._emit_stream({
                                    "kind": "tool_done",
                                    "model": "claude",
                                    "tool_id": tid,
                                    "name": pending_tools[tid].name,
                                    "output_preview": pending_tools[tid].output_preview,
                                })

                elif etype == "result":
                    result_text = event.get("result", "")
                    if result_text:
                        text_parts = [result_text]
                    usage = event.get("usage", {})
                    response.input_tokens = usage.get("input_tokens", 0)
                    response.output_tokens = usage.get("output_tokens", 0)
                    response.cache_read_tokens = usage.get(
                        "cache_read_input_tokens", 0
                    )
                    response.cache_creation_tokens = usage.get(
                        "cache_creation_input_tokens", 0
                    )
                    # Extract context window from modelUsage if available
                    for mdata in event.get("modelUsage", {}).values():
                        cw = mdata.get("contextWindow", 0)
                        if cw:
                            response.context_window = cw
                            break
                    if not response.context_window:
                        response.context_window = _CONTEXT_WINDOWS.get(
                            self.model, 200_000
                        )

        try:
            try:
                await asyncio.wait_for(_drain(), timeout=self.timeout)
            except asyncio.TimeoutError:
                proc.kill()
                if debug_file:
                    debug_file.close()
                tail = _tail_excerpt(raw_lines)
                message = "Error: Claude CLI timed out after %ds" % self.timeout
                if tail:
                    message += "\nRecent CLI output:\n" + tail
                return AdapterResponse(
                    text=message,
                    raw_output="\n".join(raw_lines),
                    exit_code=-1,
                    session_id=self.session_id,
                )

            stderr = (await proc.stderr.read()).decode("utf-8", errors="replace")
            await proc.wait()

            if stderr.strip():
                raw_lines.append("[stderr] " + stderr.strip())
                if debug_file:
                    debug_file.write("[stderr] " + stderr.strip() + "\n")

            if debug_file:
                debug_file.close()

            if proc.returncode != 0 and not text_parts:
                text_parts.append(
                    "Error: claude exited %d\n%s" % (proc.returncode, stderr)
                )

            response.text = (
                "\n".join(text_parts)
                if text_parts else "\n".join(streamed_text.values())
            )
            response.tool_summaries = tool_summaries
            response.raw_output = "\n".join(raw_lines)
            response.exit_code = proc.returncode or 0
            return response
        except asyncio.CancelledError:
            with suppress(ProcessLookupError):
                proc.kill()
            with suppress(Exception):
                await proc.wait()
            if debug_file:
                debug_file.close()
            raise

    def context_percent(self, resp: AdapterResponse) -> float:
        """Projected next-turn occupancy as % of yield limit. 100 = yield now."""
        window = resp.context_window or _CONTEXT_WINDOWS.get(self.model, 200_000)
        base = (resp.occupancy_tokens if resp.occupancy_tokens
                else (resp.input_tokens + resp.cache_creation_tokens))
        projected = base + len(resp.text) // 4
        return percent_of_limit(projected, 0, 0, window)

    def context_tokens(self, resp: AdapterResponse) -> int:
        """Current context occupancy in tokens (for display)."""
        if resp.occupancy_tokens:
            return resp.occupancy_tokens
        # Fallback: sum all input components (includes cache_read_tokens)
        return (resp.input_tokens
                + resp.cache_creation_tokens
                + resp.cache_read_tokens)


class ClaudeInteractiveTmuxAdapter:
    """Experimental interactive Claude Code transport mirrored through tmux.

    This adapter intentionally screen-scrapes an interactive tmux pane. It is a
    best-effort mirror for users who explicitly opt in; the structured
    `claude -p` adapter remains the default.
    """

    abort_all_on_startup_failure = True

    def __init__(self, model: str = "claude-sonnet-4-6",
                 tools: Optional[list] = None,
                 effort: str = "",
                 timeout: Optional[int] = None,
                 debug_log_path: str = "",
                 cwd: str = "",
                 add_dirs: Optional[list[str]] = None,
                 settings: Optional[dict] = None,
                 stream_callback: Optional[StreamCallback] = None,
                 session_name: str = "",
                 window_name: str = "claude"):
        self.model = model
        self.tools = tools or []
        self.effort = effort
        self.timeout = timeout or _timeout_from_env(
            "BOTFERENCE_CLAUDE_TMUX_TIMEOUT",
            "BOTFERENCE_CLAUDE_TIMEOUT",
        )
        if debug_log_path:
            self.debug_log_path = debug_log_path
        else:
            log_dir = os.environ.get("BOTFERENCE_RUN") or os.path.join(
                os.getcwd(), ".botference", "logs"
            )
            self.debug_log_path = os.path.join(log_dir, "debug-claude-tmux.log")
        self.cwd = cwd
        self.add_dirs = add_dirs or []
        self.settings = settings
        self.stream_callback = stream_callback
        self.session_id = session_name
        self.window_name = tmux_safe_name(window_name, max_len=32)
        self._last_capture = ""
        self._last_assistant_text = ""
        self._capture_interval = float(
            os.environ.get("BOTFERENCE_CLAUDE_TMUX_POLL_SECONDS", "1.0")
        )
        self._idle_grace = float(
            os.environ.get("BOTFERENCE_CLAUDE_TMUX_IDLE_SECONDS", "4.0")
        )
        self._capture_start = os.environ.get(
            "BOTFERENCE_CLAUDE_TMUX_CAPTURE_START", "-120"
        )

    @property
    def tmux_target(self) -> str:
        return f"{self.session_id}:{self.window_name}"

    def _emit_stream(self, event: dict[str, Any]) -> None:
        if not self.stream_callback:
            return
        try:
            self.stream_callback(event)
        except Exception:
            log.exception("Claude tmux stream callback failed")

    def _log(self, event: str, payload: str = "") -> None:
        if not self.debug_log_path:
            return
        Path(self.debug_log_path).parent.mkdir(parents=True, exist_ok=True)
        with open(self.debug_log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": time.time(),
                "transport": "tmux",
                "session": self.session_id,
                "window": self.window_name,
                "event": event,
                "payload": payload,
            }, ensure_ascii=False) + "\n")

    async def _run_command(
        self,
        *args: str,
        input_bytes: Optional[bytes] = None,
        check: bool = False,
    ) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE if input_bytes is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate(input_bytes)
        out = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")
        if check and proc.returncode != 0:
            raise RuntimeError(f"{' '.join(args)} failed: {err.strip() or out.strip()}")
        return proc.returncode or 0, out, err

    def _build_claude_command(self) -> str:
        # Keep the interactive transport close to a normal `claude` session.
        # The programmatic adapter owns strict tool/settings enforcement; this
        # mirror path should let Claude Code ask for permissions normally.
        cmd = ["claude", "--model", normalize_interactive_claude_model(self.model)]
        if self.session_id:
            cmd += ["--name", self.session_id]
        if self.effort:
            cmd += ["--effort", self.effort]
        return " ".join(shlex.quote(part) for part in cmd)

    def _startup_failure(self, detail: str) -> AdapterResponse:
        message = (
            "Error: interactive Claude tmux session failed to start. "
            f"{detail} "
            f"Debug log: {self.debug_log_path}. "
            f"Try attaching manually with: tmux attach -t {self.session_id}"
        )
        self._log("startup_failure", message)
        return AdapterResponse(
            text=message,
            exit_code=1,
            session_id=self.session_id,
            context_window=_CONTEXT_WINDOWS.get(self.model, 200_000),
            context_tokens_reliable=False,
        )

    async def _session_exists(self) -> bool:
        if not self.session_id:
            return False
        code, _, err = await self._run_command(
            "tmux", "has-session", "-t", self.session_id
        )
        if code != 0 and err.strip():
            self._log("has_session_stderr", err.strip())
        return code == 0

    async def _ensure_session(self) -> Optional[AdapterResponse]:
        if not shutil.which("tmux"):
            return AdapterResponse(
                text="Error: tmux is required for --claude-interactive but was not found on PATH.",
                exit_code=127,
                session_id=self.session_id,
            )
        if not shutil.which("claude"):
            return AdapterResponse(
                text="Error: `claude` CLI not found. Install Claude Code before using --claude-interactive.",
                exit_code=127,
                session_id=self.session_id,
            )
        if not self.session_id:
            thread = os.environ.get("CURRENT_THREAD", "") or os.environ.get(
                "BOTFERENCE_CURRENT_THREAD", ""
            )
            self.session_id = tmux_safe_name(
                "botference", "claude", thread, str(uuid.uuid4())[:8]
            )

        if await self._session_exists():
            self._log("reuse_session")
            return None

        cwd = self.cwd or os.getcwd()
        cmd = self._build_claude_command()
        code, out, err = await self._run_command(
            "tmux",
            "new-session",
            "-d",
            "-s",
            self.session_id,
            "-n",
            self.window_name,
            "-c",
            cwd,
            cmd,
        )
        if code != 0:
            detail = err.strip() or out.strip() or "tmux new-session failed."
            return self._startup_failure(detail)
        self._log("start_session", cmd)
        await asyncio.sleep(1.0)
        if not await self._session_exists():
            return self._startup_failure(
                "The tmux session exited before it was ready; interactive "
                "`claude` likely exited immediately."
            )
        self._last_capture = await self._capture()
        return None

    async def _capture(self) -> str:
        _, out, err = await self._run_command(
            "tmux",
            "capture-pane",
            "-p",
            "-S",
            self._capture_start,
            "-t",
            self.tmux_target,
        )
        if err.strip():
            self._log("capture_stderr", err.strip())
        self._log("raw_capture", out)
        return out

    async def _paste_prompt(self, prompt: str) -> Optional[AdapterResponse]:
        if not await self._session_exists():
            return self._startup_failure(
                "The tmux session is not running, so Botference did not paste "
                "the prompt."
            )
        buffer_name = tmux_safe_name("botference", "prompt", str(uuid.uuid4())[:8])
        code, out, err = await self._run_command(
            "tmux",
            "load-buffer",
            "-b",
            buffer_name,
            "-",
            input_bytes=build_tmux_paste_payload(prompt),
        )
        if code != 0:
            return self._startup_failure(err.strip() or out.strip() or "tmux load-buffer failed.")
        code, out, err = await self._run_command(
            "tmux",
            "paste-buffer",
            "-b",
            buffer_name,
            "-t",
            self.tmux_target,
        )
        if code != 0:
            return self._startup_failure(err.strip() or out.strip() or "tmux paste-buffer failed.")
        await asyncio.sleep(0.2)
        code, out, err = await self._run_command(
            "tmux", "send-keys", "-t", self.tmux_target, "C-m",
        )
        if code != 0:
            return self._startup_failure(err.strip() or out.strip() or "tmux send-keys failed.")
        await self._run_command("tmux", "delete-buffer", "-b", buffer_name)
        self._log("prompt_sent", prompt)
        return None

    async def send(self, prompt: str) -> AdapterResponse:
        return await self._run(prompt)

    async def resume(self, message: str) -> AdapterResponse:
        return await self._run(message)

    async def _run(self, prompt: str) -> AdapterResponse:
        setup_error = await self._ensure_session()
        if setup_error:
            return setup_error

        before = self._last_capture or await self._capture()
        previous_assistant_text = (
            self._last_assistant_text or extract_tmux_assistant_text(before)
        )
        paste_error = await self._paste_prompt(prompt)
        if paste_error:
            return paste_error

        collected = ""
        emitted_chunks: set[str] = set()
        last_change = time.monotonic()
        deadline = time.monotonic() + self.timeout
        last_capture = before

        while time.monotonic() < deadline:
            await asyncio.sleep(self._capture_interval)
            capture = await self._capture()
            assistant_text = extract_tmux_assistant_text(capture)
            delta = tmux_capture_delta(previous_assistant_text, assistant_text)
            if delta:
                cleaned = delta.strip("\n")
                if cleaned and cleaned not in emitted_chunks:
                    emitted_chunks.add(cleaned)
                    collected += ("\n" if collected else "") + cleaned
                    self._emit_stream({
                        "kind": "text_delta",
                        "model": "claude",
                        "text": cleaned + "\n",
                    })
                    self._log("parsed_delta", cleaned)
                    last_change = time.monotonic()
                elif cleaned:
                    self._log("duplicate_delta_ignored", cleaned)
                previous_assistant_text = assistant_text
                last_capture = capture
                continue

            if (
                time.monotonic() - last_change >= self._idle_grace
                and tmux_capture_looks_idle(capture)
            ):
                self._last_capture = capture
                self._last_assistant_text = assistant_text
                return AdapterResponse(
                    text=collected.strip(),
                    raw_output=normalize_tmux_capture(capture),
                    exit_code=0,
                    session_id=self.session_id,
                    context_window=_CONTEXT_WINDOWS.get(self.model, 200_000),
                    context_tokens_reliable=False,
                )

        self._last_capture = last_capture
        self._last_assistant_text = previous_assistant_text
        return AdapterResponse(
            text=(
                collected.strip()
                or "Timed out waiting for interactive Claude tmux session to become idle. "
                f"Attach with: tmux attach -t {self.session_id}"
            ),
            raw_output=normalize_tmux_capture(last_capture),
            exit_code=-1,
            session_id=self.session_id,
            context_window=_CONTEXT_WINDOWS.get(self.model, 200_000),
            context_tokens_reliable=False,
        )

    def context_percent(self, resp: AdapterResponse) -> float:
        return 0.0

    def context_tokens(self, resp: AdapterResponse) -> int:
        return 0


# ── Codex Adapter ────────────────────────────────────────────


class CodexAdapter:
    """Wraps `codex exec` with session continuity via thread_id resume."""

    def __init__(self, model: str = "gpt-5.5",
                 sandbox: str = "read-only",
                 cwd: str = "",
                 add_dirs: Optional[list[str]] = None,
                 reasoning_effort: str = "",
                 timeout: Optional[int] = None,
                 debug_log_path: str = "",
                 fallback_api_key: str = "",
                 network_access: bool = False,
                 stream_callback: Optional[StreamCallback] = None):
        self.requested_model = model
        self.model = model
        self.sandbox = sandbox
        self.cwd = cwd
        self.add_dirs = add_dirs or []
        self.reasoning_effort = reasoning_effort
        self.network_access = network_access
        self.timeout = timeout or _timeout_from_env(
            "BOTFERENCE_CODEX_TIMEOUT",
            "BOTFERENCE_CLI_TIMEOUT",
        )
        self.debug_log_path = debug_log_path
        self.fallback_api_key = fallback_api_key
        self._using_api_key: bool = False
        self._model_resolution_attempted = False
        self.thread_id: str = ""
        self._last_cumulative_input_tokens: int = 0
        self._last_cumulative_cached_input_tokens: int = 0
        self._last_cumulative_output_tokens: int = 0
        self.stream_callback = stream_callback

    def _emit_stream(self, event: dict[str, Any]) -> None:
        if not self.stream_callback:
            return
        try:
            self.stream_callback(event)
        except Exception:
            log.exception("Codex stream callback failed")

    def set_model(self, model: str) -> None:
        """Update the requested model and clear any cached alias resolution."""
        self.requested_model = model
        self.model = model
        self._model_resolution_attempted = False

    def _build_send_cmd(self, prompt: str) -> list:
        cmd = ["codex", "exec",
               "--sandbox", self.sandbox,
               "--skip-git-repo-check",
               "--json"]
        if self.cwd:
            cmd += ["--cd", self.cwd]
        for path in self.add_dirs:
            cmd += ["--add-dir", path]
        if self.model:
            cmd += ["-m", self.model]
        if self.reasoning_effort:
            cmd += ["-c", f'model_reasoning_effort="{self.reasoning_effort}"']
        if self.network_access:
            cmd += ["-c", "sandbox_workspace_write.network_access=true"]
        cmd.append(prompt)
        return cmd

    def _build_probe_cmd(self, model: str) -> list:
        cmd = [
            "codex", "exec",
            "--sandbox", "read-only",
            "--skip-git-repo-check",
            "--json",
        ]
        if self.cwd:
            cmd += ["--cd", self.cwd]
        for path in self.add_dirs:
            cmd += ["--add-dir", path]
        cmd += ["-m", model, _CODEX_MODEL_PROBE_PROMPT]
        return cmd

    def _build_resume_cmd(self, message: str) -> list:
        cmd = ["codex", "exec", "--sandbox", self.sandbox]
        if self.cwd:
            cmd += ["--cd", self.cwd]
        for path in self.add_dirs:
            cmd += ["--add-dir", path]
        if self.reasoning_effort:
            cmd += ["-c", f'model_reasoning_effort="{self.reasoning_effort}"']
        if self.network_access:
            cmd += ["-c", "sandbox_workspace_write.network_access=true"]
        cmd += [
            "resume", self.thread_id,
            "--json",
            "--skip-git-repo-check",
        ]
        cmd.append(message)
        return cmd

    async def _probe_model(self, model: str) -> bool:
        probe = await self._run_once(self._build_probe_cmd(model), isolated=True)
        if probe.exit_code != 0:
            return False
        return not probe.text.lstrip().lower().startswith("error:")

    async def _resolve_model_alias(self) -> None:
        if self._model_resolution_attempted:
            return
        self._model_resolution_attempted = True

        requested = self.requested_model or self.model
        candidates = _CODEX_MODEL_ALIASES.get(requested)
        if not candidates:
            self.model = requested
            return

        for candidate in candidates:
            if await self._probe_model(candidate):
                self.model = candidate
                log.info("Resolved Codex model alias %s -> %s", requested, candidate)
                return

        # Fall back to the last candidate so the real send still runs on the
        # most conservative supported model if the probes fail for non-model
        # reasons (for example, auth or transient CLI issues).
        self.model = candidates[-1]
        log.warning(
            "Failed to verify any Codex model candidate for %s; defaulting to %s",
            requested,
            self.model,
        )

    async def send(self, prompt: str) -> AdapterResponse:
        """First message — creates a new thread."""
        await self._resolve_model_alias()
        self.thread_id = ""
        self._last_cumulative_input_tokens = 0
        self._last_cumulative_cached_input_tokens = 0
        self._last_cumulative_output_tokens = 0
        return await self._run(self._build_send_cmd(prompt))

    async def resume(self, message: str) -> AdapterResponse:
        """Follow-up message in existing thread."""
        await self._resolve_model_alias()
        if not self.thread_id:
            raise RuntimeError("No thread to resume — call send() first")
        return await self._run(self._build_resume_cmd(message))

    def _make_env(self):
        """Build subprocess env. Injects OPENAI_API_KEY when available."""
        if self.fallback_api_key:
            env = dict(os.environ)
            env["OPENAI_API_KEY"] = self.fallback_api_key
            return env
        return None  # inherit parent env (subscription auth)

    async def _run(self, cmd: list, isolated: bool = False) -> AdapterResponse:
        return await self._run_once(cmd, isolated=isolated)

    async def _run_once(self, cmd: list, isolated: bool = False) -> AdapterResponse:
        log.debug("codex cmd: %s", " ".join(cmd))
        prev_cumulative_input = 0 if isolated else self._last_cumulative_input_tokens
        prev_cumulative_cached = (0 if isolated
                                  else self._last_cumulative_cached_input_tokens)
        prev_cumulative_output = 0 if isolated else self._last_cumulative_output_tokens

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self._make_env(),
            )
        except FileNotFoundError:
            return AdapterResponse(
                text="Error: `codex` CLI not found. "
                     "Install with: npm install -g @openai/codex",
                exit_code=127,
            )

        text_parts = []
        tool_summaries = []
        raw_lines = []
        response = AdapterResponse(text="", session_id=self.thread_id)
        debug_file = (open(self.debug_log_path, "a")
                      if self.debug_log_path else None)

        async def _drain():
            async for event in _read_jsonl_lines(proc.stdout, raw_lines,
                                                 debug_file):
                etype = event.get("type", "")

                if etype == "thread.started":
                    tid = event.get("thread_id", "")
                    response.session_id = tid
                    if not isolated:
                        self.thread_id = tid

                elif etype == "item.completed":
                    item = event.get("item", {})
                    itype = item.get("type", "")
                    item_id = item.get("id", "")
                    if itype == "agent_message":
                        text = item.get("text", "")
                        if text:
                            text_parts.append(text)
                            if not isolated:
                                self._emit_stream({
                                    "kind": "text_delta",
                                    "model": "codex",
                                    "text": text,
                                })
                    elif itype == "command_execution":
                        agg_output = item.get("aggregated_output", "")
                        response.tool_result_tokens_estimate += len(agg_output) // 4
                        ts = ToolSummary(
                            id=item_id,
                            name=item.get("command", "")[:80],
                            input_preview="",
                            output_preview=_truncate(agg_output, 200),
                            output_blocks=_structured_output_blocks(agg_output),
                        )
                        tool_summaries.append(ts)
                        if not isolated:
                            self._emit_stream({
                                "kind": "tool_done",
                                "model": "codex",
                                "tool_id": ts.id,
                                "name": ts.name,
                                "output_preview": ts.output_preview,
                            })

                elif etype == "item.started":
                    item = event.get("item", {})
                    if item.get("type") == "command_execution":
                        ts = ToolSummary(
                            id=item.get("id", ""),
                            name=item.get("command", "")[:80],
                            input_preview="(running)",
                        )
                        tool_summaries.append(ts)
                        if not isolated:
                            self._emit_stream({
                                "kind": "tool_start",
                                "model": "codex",
                                "tool_id": ts.id,
                                "name": ts.name,
                                "input_preview": ts.input_preview,
                            })

                elif etype == "turn.completed":
                    usage = event.get("usage", {})
                    cumulative_input = usage.get("input_tokens", 0)
                    cumulative_output = usage.get("output_tokens", 0)
                    cumulative_cached = usage.get("cached_input_tokens", 0)
                    baseline_available = any((
                        prev_cumulative_input,
                        prev_cumulative_output,
                        prev_cumulative_cached,
                    ))

                    response.input_tokens = cumulative_input
                    response.output_tokens = cumulative_output
                    response.cache_read_tokens = cumulative_cached
                    response.turn_input_tokens = _delta_from_cumulative(
                        cumulative_input, prev_cumulative_input
                    )
                    response.turn_output_tokens = _delta_from_cumulative(
                        cumulative_output, prev_cumulative_output
                    )
                    response.turn_cached_input_tokens = _delta_from_cumulative(
                        cumulative_cached, prev_cumulative_cached
                    )
                    response.context_tokens_reliable = baseline_available
                    response.context_window = _CONTEXT_WINDOWS.get(
                        self.model, 200_000
                    )
                    if not isolated:
                        self._last_cumulative_input_tokens = cumulative_input
                        self._last_cumulative_output_tokens = cumulative_output
                        self._last_cumulative_cached_input_tokens = cumulative_cached

                elif etype in ("error", "turn.failed"):
                    msg = (event.get("message", "")
                           or event.get("error", {}).get("message", ""))
                    text_parts.append("Error: %s" % msg)

        try:
            try:
                await asyncio.wait_for(_drain(), timeout=self.timeout)
            except asyncio.TimeoutError:
                proc.kill()
                if debug_file:
                    debug_file.close()
                tail = _tail_excerpt(raw_lines)
                message = "Error: Codex CLI timed out after %ds" % self.timeout
                if tail:
                    message += "\nRecent CLI output:\n" + tail
                return AdapterResponse(
                    text=message,
                    raw_output="\n".join(raw_lines),
                    exit_code=-1,
                    session_id=response.session_id,
                )

            stderr = (await proc.stderr.read()).decode("utf-8", errors="replace")
            await proc.wait()

            if stderr.strip():
                raw_lines.append("[stderr] " + stderr.strip())
                if debug_file:
                    debug_file.write("[stderr] " + stderr.strip() + "\n")

            if debug_file:
                debug_file.close()

            if proc.returncode != 0 and not text_parts:
                text_parts.append(
                    "Error: codex exited %d\n%s" % (proc.returncode, stderr)
                )

            # Deduplicate tool summaries — item.started then item.completed
            # produce two entries for the same item.id; merge into one
            seen = {}
            deduped = []
            for ts in tool_summaries:
                if ts.id and ts.id in seen:
                    existing = seen[ts.id]
                    existing.output_preview = ts.output_preview or existing.output_preview
                    existing.output_blocks = ts.output_blocks or existing.output_blocks
                    if ts.input_preview != "(running)":
                        existing.input_preview = ts.input_preview
                else:
                    if ts.id:
                        seen[ts.id] = ts
                    deduped.append(ts)

            response.text = "\n".join(text_parts) if text_parts else ""
            response.tool_summaries = deduped
            response.raw_output = "\n".join(raw_lines)
            response.exit_code = proc.returncode or 0
            return response
        except asyncio.CancelledError:
            with suppress(ProcessLookupError):
                proc.kill()
            with suppress(Exception):
                await proc.wait()
            if debug_file:
                debug_file.close()
            raise

    def context_percent(self, resp: AdapterResponse) -> float:
        """Projected next-turn usage as % of yield limit. 100 = yield now."""
        if not resp.context_tokens_reliable:
            return 0.0
        window = resp.context_window or _CONTEXT_WINDOWS.get(self.model, 200_000)
        turn_input = resp.turn_input_tokens or resp.input_tokens
        return percent_of_limit(turn_input, 0, 0, window)

    def context_tokens(self, resp: AdapterResponse) -> Optional[int]:
        """Current context occupancy in tokens (for display)."""
        if not resp.context_tokens_reliable:
            return None
        return resp.turn_input_tokens or resp.input_tokens
