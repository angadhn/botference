"""
cli_adapters.py — Async subprocess wrappers for Claude and Codex CLIs.

Botference mode wraps installed CLIs as subprocesses (no API keys, no providers.py).
Auth comes from existing CLI logins (claude login / codex login).

Verified syntax from spike-output/CLI-SPIKE-RESULTS.md (Task 0, commit 55e2209).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from typing import Optional

from providers import percent_of_limit

log = logging.getLogger(__name__)

# ── Response types ───────────────────────────────────────────


@dataclass
class ToolSummary:
    id: str  # stable item ID for dedup (tool_use_id or codex item.id)
    name: str
    input_preview: str  # truncated input for TUI display
    output_preview: str = ""  # filled when tool_result arrives


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


# ── Context windows (fallback when not reported by CLI) ──────

_CONTEXT_WINDOWS = {
    "claude-opus-4-6": 1_000_000,
    "claude-sonnet-4-6": 1_000_000,
    "claude-haiku-4-5": 200_000,
    "gpt-5.4": 272_000,
    "o3": 200_000,
    "o4-mini": 200_000,
}

_DEFAULT_TIMEOUT = 300  # seconds


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
                 allowed_tools: Optional[list] = None):
        self.model = model
        self.tools = tools or ["Read", "Glob", "Grep", "Bash"]
        self.effort = effort
        self.timeout = timeout or _timeout_from_env(
            "BOTFERENCE_CLAUDE_TIMEOUT",
            "BOTFERENCE_CLI_TIMEOUT",
        )
        self.debug_log_path = debug_log_path
        self.allowed_tools = allowed_tools  # path-restricted tool permissions
        self.session_id: str = ""

    def _build_cmd(self, resume: bool) -> list:
        cmd = ["claude", "-p"]
        if resume:
            cmd += ["--resume", self.session_id]
        else:
            cmd += ["--session-id", self.session_id]
        cmd += [
            "--output-format", "stream-json",
            "--verbose",
            "--model", self.model,
            "--tools", ",".join(self.tools),
        ]
        if self.effort:
            cmd += ["--effort", self.effort]
        if self.allowed_tools:
            cmd += ["--permission-mode", "plan",
                    "--allowedTools"] + self.allowed_tools
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
                    for block in event.get("message", {}).get("content", []):
                        btype = block.get("type", "")
                        if btype == "text":
                            text_parts.append(block["text"])
                        elif btype == "tool_use":
                            tool_id = block.get("id", "")
                            ts = ToolSummary(
                                id=tool_id,
                                name=block.get("name", ""),
                                input_preview=_truncate(
                                    json.dumps(block.get("input", {}))
                                ),
                            )
                            pending_tools[tool_id] = ts
                            tool_summaries.append(ts)
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
                                pending_tools[tid].output_preview = _truncate(
                                    content_str, 200
                                )

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

        response.text = "\n".join(text_parts) if text_parts else ""
        response.tool_summaries = tool_summaries
        response.raw_output = "\n".join(raw_lines)
        response.exit_code = proc.returncode or 0
        return response

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


# ── Codex Adapter ────────────────────────────────────────────


class CodexAdapter:
    """Wraps `codex exec` with session continuity via thread_id resume."""

    def __init__(self, model: str = "gpt-5.4",
                 sandbox: str = "read-only",
                 timeout: Optional[int] = None,
                 debug_log_path: str = "",
                 fallback_api_key: str = ""):
        self.model = model
        self.sandbox = sandbox
        self.timeout = timeout or _timeout_from_env(
            "BOTFERENCE_CODEX_TIMEOUT",
            "BOTFERENCE_CLI_TIMEOUT",
        )
        self.debug_log_path = debug_log_path
        self.fallback_api_key = fallback_api_key
        self._using_api_key: bool = False
        self.thread_id: str = ""
        self._last_cumulative_input_tokens: int = 0
        self._last_cumulative_cached_input_tokens: int = 0
        self._last_cumulative_output_tokens: int = 0

    def _build_send_cmd(self, prompt: str) -> list:
        cmd = ["codex", "exec",
               "--sandbox", self.sandbox,
               "--skip-git-repo-check",
               "--json"]
        if self.model:
            cmd += ["-m", self.model]
        cmd.append(prompt)
        return cmd

    def _build_resume_cmd(self, message: str) -> list:
        return [
            "codex", "exec", "resume", self.thread_id,
            "--json",
            "--skip-git-repo-check",
            message,
        ]

    async def send(self, prompt: str) -> AdapterResponse:
        """First message — creates a new thread."""
        self.thread_id = ""
        self._last_cumulative_input_tokens = 0
        self._last_cumulative_cached_input_tokens = 0
        self._last_cumulative_output_tokens = 0
        return await self._run(self._build_send_cmd(prompt))

    async def resume(self, message: str) -> AdapterResponse:
        """Follow-up message in existing thread."""
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
                    elif itype == "command_execution":
                        agg_output = item.get("aggregated_output", "")
                        response.tool_result_tokens_estimate += len(agg_output) // 4
                        tool_summaries.append(ToolSummary(
                            id=item_id,
                            name=item.get("command", "")[:80],
                            input_preview="",
                            output_preview=_truncate(agg_output, 200),
                        ))

                elif etype == "item.started":
                    item = event.get("item", {})
                    if item.get("type") == "command_execution":
                        tool_summaries.append(ToolSummary(
                            id=item.get("id", ""),
                            name=item.get("command", "")[:80],
                            input_preview="(running)",
                        ))

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
