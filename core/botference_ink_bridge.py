"""
botference_ink_bridge.py — JSON-lines bridge between Ink TUI and Botference controller.

Implements UIPort protocol, serializing calls as JSON to stdout.
Reads user input as JSON from stdin.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from cli_adapters import (
    ClaudeAdapter,
    ClaudeInteractiveTmuxAdapter,
    CodexAdapter,
    normalize_claude_transport,
    planner_write_config,
    planner_write_roots_for_env,
)
from paths import BotferencePaths
from botference import Botference, WritePermissionRequest, get_completion_context
from ui_types import ProjectPanelState, RoomMode, StatusSnapshot
from render_blocks import parse_render_blocks
from session_store import append_crash_log

log = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1)


@dataclass
class QueuedInput:
    text: str
    attachments: list[dict] = field(default_factory=list)


def emit(obj: dict) -> None:
    """Write a JSON line to stdout (for the Ink process to read)."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


# Streaming text deltas are coalesced before crossing the process boundary:
# per-chunk emits caused one Ink re-render per CLI chunk (dozens/second).
# Buffering for a frame interval keeps typing visibly live at ~14 updates/s
# while cutting renders by an order of magnitude.
_STREAM_FLUSH_INTERVAL = 0.07  # seconds

# Desktop notifications only fire for turns long enough that the user has
# plausibly looked away — instant commands (/help, /status) never ping.
_NOTIFY_MIN_TURN_SECONDS = 5.0

# stream-events.jsonl records every stream event for every turn — it grows
# without bound in a long-lived work dir unless rotated. When the file
# exceeds the cap it rotates to stream-events.jsonl.1 (one previous
# generation kept), bounding total disk use to ~2x the cap.
_STREAM_LOG_MAX_BYTES = 16 * 1024 * 1024


def _emit_notify(body: str) -> None:
    """Ask the Ink process to post a desktop notification via the terminal."""
    emit({"type": "notify", "title": "botference", "body": body})


def _abnormal_runs_since(root: Path, seen: float) -> str:
    """Summarize abnormal exits from the launcher's run ledger.

    The ledger pairs run_start/run_end lines by pid. A nonzero exit code is
    abnormal; so is a start with no end (hard kill) — except the newest
    start, which is the run reading this. Catches deaths that leave no
    other artifact (SIGKILL, terminal close).
    """
    ledger = root / ".botference" / "run-ledger.jsonl"
    try:
        lines = ledger.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    open_starts: list[tuple[object, float]] = []
    abnormal = 0
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        try:
            ts = datetime.fromisoformat(
                str(rec.get("ts", "")).replace("Z", "+00:00")
            ).timestamp()
        except ValueError:
            continue
        event = rec.get("event")
        if event == "run_start":
            open_starts.append((rec.get("pid"), ts))
        elif event == "run_end":
            pid = rec.get("pid")
            open_starts = [s for s in open_starts if s[0] != pid]
            if rec.get("exit_code") not in (0, None) and ts > seen:
                abnormal += 1
    for _pid, ts in open_starts[:-1]:
        if ts > seen:
            abnormal += 1
    if not abnormal:
        return ""
    return (
        f"{abnormal} run(s) ended abnormally since the last check "
        f"(full history: {ledger})."
    )


def _fresh_crash_artifacts(paths: BotferencePaths) -> list[str]:
    """Crash artifacts newer than the last time the user was told.

    The TUI logs UI crashes to .botference/ink-crash.log, node writes fatal
    (OOM/abort) reports to .botference/crash-reports/, and the controller/
    bridge log Python exceptions to <sessions>/crash.log. Surfacing them at
    the next launch turns "the app crashed and I have no idea why" into a
    pointer at the evidence. A marker file records what was already shown.
    """
    root = paths.project_root
    marker = root / ".botference" / "crash-notice.seen"
    try:
        seen = marker.stat().st_mtime
    except OSError:
        seen = 0.0
    candidates = [
        root / ".botference" / "ink-crash.log",
        paths.session_crash_log,
    ]
    reports_dir = root / ".botference" / "crash-reports"
    if reports_dir.is_dir():
        candidates.extend(sorted(reports_dir.glob("*.json")))
    fresh: list[str] = []
    for path in candidates:
        try:
            if path.stat().st_mtime > seen:
                fresh.append(str(path))
        except OSError:
            continue
    run_summary = _abnormal_runs_since(root, seen)
    if run_summary:
        fresh.append(run_summary)
    if fresh:
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.touch()
        except OSError:
            pass
    return fresh


class InkBridge:
    """UIPort implementation that emits JSON-lines to stdout."""

    def __init__(self, paths: BotferencePaths) -> None:
        # Overridden in main() to read the controller's /notify preference.
        self.notify_enabled: "Callable[[], bool]" = lambda: False
        self._pending_permission: asyncio.Future[bool] | None = None
        self._pending_choice: asyncio.Future[int | None] | None = None
        self._stream_buffer: dict[tuple, dict] = {}
        self._flush_handle: asyncio.TimerHandle | None = None
        self.stream_log_path = paths.session_dir / "stream-events.jsonl"
        self.stream_log_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._stream_log_bytes = self.stream_log_path.stat().st_size
        except OSError:
            self._stream_log_bytes = 0
        self._append_stream_log({
            "ts": time.time(),
            "type": "stream_log_opened",
            "path": str(self.stream_log_path),
        })

    def _append_stream_log(self, obj: dict) -> None:
        """Append one JSON line to the stream log, rotating at the size cap.

        Log-keeping is diagnostics, not product behavior: any OSError (full
        disk, read-only fs) is swallowed so it can never fail a live turn.
        """
        line = json.dumps(obj) + "\n"
        try:
            if self._stream_log_bytes >= _STREAM_LOG_MAX_BYTES:
                self.stream_log_path.replace(
                    self.stream_log_path.with_name(
                        self.stream_log_path.name + ".1"
                    )
                )
                self._stream_log_bytes = 0
            with self.stream_log_path.open("a", encoding="utf-8") as f:
                f.write(line)
            self._stream_log_bytes += len(line.encode("utf-8"))
        except OSError:
            pass

    def add_room_entry(
        self,
        speaker: str,
        text: str,
        blocks: list[dict] | None = None,
        *,
        stream_id: str = "",
        restored: bool = False,
    ) -> None:
        event = {
            "type": "room",
            "speaker": speaker,
            "text": text,
            "blocks": blocks if blocks is not None else parse_render_blocks(text),
        }
        if stream_id:
            event["stream_id"] = stream_id
        if restored:
            event["restored"] = True
        emit(event)

    def restore_entries(
        self,
        room: list,
        *,
        chunk_size: int = 80,
    ) -> None:
        """Bulk-restore historical entries in batches.

        Replaces per-entry replay (one emit + render + reflow each) with a handful
        of batched ``restore`` events the Ink UI applies in single state updates —
        turning reload from O(N^2) into O(N). Each item is ``(speaker, text,
        blocks_or_None)``.
        """
        for start in range(0, len(room), chunk_size):
            batch = room[start:start + chunk_size]
            emit({
                "type": "restore",
                "pane": "room",
                "entries": [
                    {
                        "speaker": speaker,
                        "text": text,
                        "blocks": blocks if blocks is not None
                        else parse_render_blocks(text),
                    }
                    for speaker, text, blocks in batch
                ],
            })

    def stream_event(self, event: dict) -> None:
        payload = {"type": "stream", **event}
        self._append_stream_log({"ts": time.time(), **payload})

        if payload.get("kind") == "text_delta":
            key = (
                payload.get("stream_id"),
                payload.get("pane"),
                payload.get("model"),
            )
            buffered = self._stream_buffer.get(key)
            if buffered is not None:
                buffered["text"] = (
                    str(buffered.get("text", "")) + str(payload.get("text", ""))
                )
            else:
                self._stream_buffer[key] = dict(payload)
            self._schedule_stream_flush()
            return

        # Non-delta events (start/tool/done) act as ordering barriers:
        # flush buffered text first so the UI never sees them out of order.
        self._flush_stream_buffer()
        emit(payload)

    def _schedule_stream_flush(self) -> None:
        if self._flush_handle is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._flush_stream_buffer()
            return
        self._flush_handle = loop.call_later(
            _STREAM_FLUSH_INTERVAL, self._on_stream_flush_timer
        )

    def _on_stream_flush_timer(self) -> None:
        self._flush_handle = None
        self._flush_stream_buffer()

    def _flush_stream_buffer(self) -> None:
        if self._flush_handle is not None:
            self._flush_handle.cancel()
            self._flush_handle = None
        if not self._stream_buffer:
            return
        buffered = list(self._stream_buffer.values())
        self._stream_buffer.clear()
        for payload in buffered:
            emit(payload)

    def set_status(self, status: StatusSnapshot) -> None:
        emit({
            "type": "status",
            "mode": status.mode.value,
            "lead": status.lead,
            "route": status.route,
            "project": status.project,
            "claude_pct": status.claude_percent,
            "codex_pct": status.codex_percent,
            "claude_tokens": status.claude_tokens,
            "claude_window": status.claude_window,
            "codex_tokens": status.codex_tokens,
            "codex_window": status.codex_window,
            "claude_model": status.claude_model,
            "codex_model": status.codex_model,
            "observe": status.observe_enabled,
        })

    def set_projects(self, state: ProjectPanelState) -> None:
        emit({
            "type": "projects",
            "active_project_id": state.active_project_id,
            "inbox_session_count": state.inbox_session_count,
            "projects": [
                {
                    "id": project.project_id,
                    "title": project.title,
                    "status": project.status,
                    "next_action": project.next_action,
                    "active": project.active,
                    "session_count": project.session_count,
                    "sessions": [
                        {
                            "session_id": session.session_id,
                            "title": session.title,
                            "updated_at": session.updated_at,
                            "active": session.active,
                        }
                        for session in project.sessions
                    ],
                }
                for project in state.projects
            ],
        })

    def set_mode(self, mode: RoomMode) -> None:
        emit({"type": "mode", "mode": mode.value})

    def clear_panes(self) -> None:
        emit({"type": "clear_panes"})

    async def request_write_permission(
        self,
        request: WritePermissionRequest,
    ) -> bool:
        if self._pending_permission is not None and not self._pending_permission.done():
            raise RuntimeError("Permission request already pending")
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()
        self._pending_permission = future
        emit({
            "type": "permission_request",
            "request_id": request.request_id,
            "model": request.model,
            "path": request.path,
            "reason": request.reason,
        })
        # A pending permission blocks the whole turn — worth a ping even
        # though the bots have not finished yet.
        if self.notify_enabled():
            _emit_notify(
                f"@{request.model} is waiting for write permission: "
                f"{request.path}"
            )
        try:
            return await future
        finally:
            self._pending_permission = None
            emit({"type": "permission_cleared"})

    def resolve_permission_request(self, allow: bool) -> None:
        if self._pending_permission is None or self._pending_permission.done():
            return
        self._pending_permission.set_result(allow)

    async def request_choice(
        self, prompt: str, options: list[str],
    ) -> int | None:
        """Show an arrow-key option picker in the Ink UI.

        Returns the selected option index, or None when dismissed (Esc).
        """
        if self._pending_choice is not None and not self._pending_choice.done():
            raise RuntimeError("Choice request already pending")
        loop = asyncio.get_running_loop()
        future: asyncio.Future[int | None] = loop.create_future()
        self._pending_choice = future
        emit({
            "type": "choice_request",
            "prompt": prompt,
            "options": list(options),
        })
        try:
            return await future
        finally:
            self._pending_choice = None
            emit({"type": "choice_cleared"})

    def resolve_choice_request(self, index: object) -> None:
        if self._pending_choice is None or self._pending_choice.done():
            return
        value = index if isinstance(index, int) and index >= 0 else None
        self._pending_choice.set_result(value)


async def _read_line() -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, sys.stdin.readline)


def decode_stdin_line(raw: str) -> dict | None:
    """Parse one stdin line into a bridge message dict, or None.

    Anything that is not a JSON object is dropped: a malformed or non-dict
    payload (e.g. a bare number) must never crash the input loop — that
    would take the whole controller down mid-session.
    """
    try:
        msg = json.loads(raw.strip())
    except json.JSONDecodeError:
        return None
    return msg if isinstance(msg, dict) else None


async def _hydrate_project_panel(
    bridge: InkBridge,
    botference: Botference,
    paths: BotferencePaths,
) -> None:
    """Compute project_panel_snapshot off the event loop and send the result.

    Failures are written to the crash log so a broken snapshot can't take
    the bridge down — the Ink UI keeps the placeholder panel emitted at
    startup until/unless a later turn refreshes it.
    """
    try:
        # Sweep launch corpses (empty, day-old session files) before the
        # snapshot so their ghosts never reach the panel counts.
        await asyncio.to_thread(botference.session_store.prune_empty)
        snapshot = await asyncio.to_thread(botference.project_panel_snapshot)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        append_crash_log(
            paths,
            location="botference_ink_bridge.hydrate_project_panel",
            session_id=botference.session_id,
            exc=exc,
        )
        return
    bridge.set_projects(snapshot)


async def _send_initial_state_and_schedule_hydration(
    bridge: InkBridge,
    botference: Botference,
    paths: BotferencePaths,
) -> asyncio.Task:
    """Paint a usable Ink UI immediately and schedule project-panel hydration.

    The initial projects payload is an empty placeholder so launch is not
    gated on scanning the session corpus — the real snapshot lands later
    via the returned background task.
    """
    emit({"type": "completion_context", **get_completion_context()})
    bridge.set_status(botference.status_snapshot())
    bridge.set_projects(ProjectPanelState(
        projects=(),
        active_project_id=botference.active_project_id,
        inbox_session_count=0,
    ))
    bridge.add_room_entry(
        "system", "Council room ready. First plain text routes to @all."
    )
    fresh_crashes = _fresh_crash_artifacts(paths)
    if fresh_crashes:
        bridge.add_room_entry(
            "system",
            "A previous run appears to have crashed. Evidence:\n"
            + "\n".join(f"  {p}" for p in fresh_crashes),
        )
    emit({"type": "ready"})
    return asyncio.create_task(
        _hydrate_project_panel(bridge, botference, paths)
    )


async def _wait_for_turn(
    task: asyncio.Task,
    botference: Botference,
    bridge: InkBridge,
    paths: BotferencePaths,
    *,
    emit_ready: bool = True,
) -> bool:
    should_exit = False
    try:
        await task
        bridge.set_status(botference.status_snapshot())
        bridge.set_projects(botference.project_panel_snapshot())
    except asyncio.CancelledError:
        botference.interrupt(bridge)
        bridge.set_status(botference.status_snapshot())
        bridge.set_projects(botference.project_panel_snapshot())
    except Exception as exc:
        append_crash_log(
            paths,
            location="botference_ink_bridge.handle_input",
            session_id=botference.session_id,
            exc=exc,
        )
        bridge.add_room_entry("system", f"Unhandled controller error: {exc}")
        bridge.set_status(botference.status_snapshot())
        bridge.set_projects(botference.project_panel_snapshot())
    finally:
        if botference.quit_requested:
            emit({"type": "exit"})
            should_exit = True
        else:
            if emit_ready:
                emit({"type": "ready"})
    return should_exit


class InputTurnQueue:
    """Serialize user inputs so messages submitted during a turn run next."""

    def __init__(
        self,
        botference: Botference,
        bridge: InkBridge,
        paths: BotferencePaths,
    ) -> None:
        self._botference = botference
        self._bridge = bridge
        self._paths = paths
        self._pending: deque[QueuedInput] = deque()
        self._runner: asyncio.Task | None = None
        self._current_turn: asyncio.Task | None = None
        self._interrupted = False

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def is_running(self) -> bool:
        return (
            (self._runner is not None and not self._runner.done())
            or (self._current_turn is not None and not self._current_turn.done())
        )

    def submit(self, text: str, attachments: list[dict]) -> None:
        # Mid-turn input first tries steering — injected into the active
        # bot's in-flight turn (read after its current tool call), like
        # typing in Claude Code. Falls through to the queue when the turn
        # isn't steerable (Codex, drafts, slash commands, other targets).
        if self.is_running and not attachments:
            if self._botference.steer_active(text, self._bridge):
                return
        was_running = self.is_running
        self._pending.append(QueuedInput(text=text, attachments=attachments))
        if was_running:
            self._emit_queue_state()
        if not self.is_running:
            self._runner = asyncio.create_task(self._run())

    def interrupt(self) -> None:
        self._interrupted = True
        cleared = len(self._pending)
        self._pending.clear()
        if self._current_turn is not None and not self._current_turn.done():
            self._current_turn.cancel()
        if cleared:
            suffix = "" if cleared == 1 else "s"
            self._bridge.add_room_entry(
                "system", f"Cleared {cleared} queued message{suffix}."
            )
            self._emit_queue_state()

    async def wait_idle(self) -> None:
        if self._runner is not None:
            await self._runner

    def _emit_queue_state(self) -> None:
        emit({"type": "queue", "pending": len(self._pending)})

    async def _run(self) -> None:
        batch_started = time.monotonic()
        self._interrupted = False
        while self._pending:
            item = self._pending.popleft()
            self._emit_queue_state()
            self._current_turn = asyncio.create_task(
                self._botference.handle_input(
                    item.text,
                    self._bridge,
                    attachments=item.attachments,
                )
            )
            should_exit = await _wait_for_turn(
                self._current_turn,
                self._botference,
                self._bridge,
                self._paths,
                emit_ready=False,
            )
            self._current_turn = None
            if should_exit:
                self._pending.clear()
                self._emit_queue_state()
                return

        self._emit_queue_state()
        self._maybe_notify(time.monotonic() - batch_started)
        emit({"type": "ready"})

    def _maybe_notify(self, elapsed: float) -> None:
        """Ping when a long-enough turn batch finishes uninterrupted.

        An interrupt means the user is at the keyboard; short batches mean
        they never had a reason to look away.
        """
        if self._interrupted or elapsed < _NOTIFY_MIN_TURN_SECONDS:
            return
        if not getattr(self._botference, "notify", False):
            return
        _emit_notify("The bots have finished — the floor is yours.")


async def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="botference ink bridge")
    parser.add_argument("--anthropic-model", default="claude-fable-5")
    # Both participants run at high effort by default — explicit rather
    # than trusting each CLI's own default to stay "high" forever.
    parser.add_argument("--claude-effort", default="high")
    parser.add_argument("--openai-model", default="gpt-5.6-sol")
    parser.add_argument("--openai-effort", default="")
    parser.add_argument("--system-prompt-file", required=True)
    parser.add_argument("--task-file", required=True)
    parser.add_argument("--debug-panes", action="store_true")
    parser.add_argument(
        "--claude-transport",
        default=os.environ.get("BOTFERENCE_CLAUDE_TRANSPORT", "programmatic"),
    )
    args = parser.parse_args()

    with open(args.system_prompt_file) as f:
        system_prompt = f.read()
    with open(args.task_file) as f:
        task = f.read()

    # Load API keys from .env (same logic as botference.py main)
    project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    fallback_api_key = os.environ.get("OPENAI_API_KEY", "")
    if not fallback_api_key:
        for env_name in (".env.local", ".env"):
            env_path = os.path.join(project_dir, env_name)
            if os.path.isfile(env_path):
                with open(env_path) as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key, _, val = line.partition("=")
                            if key.strip() == "OPENAI_API_KEY":
                                fallback_api_key = val.strip().strip("'\"")
                break

    # Debug log setup
    claude_log = ""
    codex_log = ""
    if args.debug_panes:
        log_dir = os.environ.get(
            "BOTFERENCE_RUN",
            os.path.join(project_dir, "logs"),
        )
        os.makedirs(log_dir, exist_ok=True)
        claude_log = os.path.join(log_dir, "debug-claude.log")
        codex_log = os.path.join(log_dir, "debug-codex.log")
        for p in (claude_log, codex_log):
            with open(p, "w") as f:
                f.write("")
    elif normalize_claude_transport(args.claude_transport) == "tmux":
        log_dir = os.environ.get(
            "BOTFERENCE_RUN",
            os.path.join(project_dir, ".botference", "logs"),
        )
        os.makedirs(log_dir, exist_ok=True)
        claude_log = os.path.join(log_dir, "debug-claude-tmux.log")

    paths = BotferencePaths.resolve()
    plan_write_roots = planner_write_roots_for_env(
        paths.project_root, paths.work_dir, mode="plan"
    )
    planner_config = planner_write_config(paths.project_root, plan_write_roots)

    claude_cls = (
        ClaudeInteractiveTmuxAdapter
        if normalize_claude_transport(args.claude_transport) == "tmux"
        else ClaudeAdapter
    )
    claude = claude_cls(
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
        fallback_api_key=fallback_api_key,
        network_access=planner_config.codex_network_access,
    )
    botference = Botference(
        claude=claude, codex=codex,
        system_prompt=system_prompt, task=task,
        paths=paths,
        plan_write_roots=planner_config.write_roots,
    )
    botference.observe = args.debug_panes

    bridge = InkBridge(paths)
    bridge.notify_enabled = lambda: botference.notify
    turn_queue = InputTurnQueue(botference, bridge, paths)
    # Let a free-form bot-to-bot thread yield the floor when the user has
    # typed something mid-thread.
    botference.pending_input_check = lambda: turn_queue.pending_count > 0

    # Paint the UI now; hydrate project/session data in the background.
    # The returned task is held to prevent GC of the running coroutine.
    hydration_task = await _send_initial_state_and_schedule_hydration(
        bridge, botference, paths
    )

    # Main input loop
    while True:
        raw = await _read_line()
        if not raw:
            break

        msg = decode_stdin_line(raw)
        if msg is None:
            continue

        if msg.get("type") == "input":
            text = msg.get("text", "")
            attachments = msg.get("attachments", [])
            turn_queue.submit(text, attachments)
            continue

        if msg.get("type") == "interrupt":
            turn_queue.interrupt()
            continue

        if msg.get("type") == "permission_response":
            bridge.resolve_permission_request(bool(msg.get("allow")))
            continue

        if msg.get("type") == "choice_response":
            bridge.resolve_choice_request(msg.get("index"))
            continue

    _executor.shutdown(wait=False)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        append_crash_log(
            BotferencePaths.resolve(),
            location="botference_ink_bridge.main",
            session_id="",
            exc=exc,
        )
        raise
