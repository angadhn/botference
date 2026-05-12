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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from cli_adapters import (
    ClaudeAdapter,
    CodexAdapter,
    planner_write_config,
    planner_write_roots_for_env,
)
from paths import BotferencePaths
from botference import Botference, WritePermissionRequest, get_completion_context
from botference_ui import RoomMode, StatusSnapshot
from render_blocks import parse_render_blocks
from session_store import append_crash_log

log = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1)


def emit(obj: dict) -> None:
    """Write a JSON line to stdout (for the Ink process to read)."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class InkBridge:
    """UIPort implementation that emits JSON-lines to stdout."""

    def __init__(self, paths: BotferencePaths) -> None:
        self._pending_permission: asyncio.Future[bool] | None = None
        self.stream_log_path = paths.session_dir / "stream-events.jsonl"
        self.stream_log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.stream_log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": time.time(),
                "type": "stream_log_opened",
                "path": str(self.stream_log_path),
            }) + "\n")

    def add_room_entry(
        self,
        speaker: str,
        text: str,
        blocks: list[dict] | None = None,
        *,
        stream_id: str = "",
    ) -> None:
        event = {
            "type": "room",
            "speaker": speaker,
            "text": text,
            "blocks": blocks if blocks is not None else parse_render_blocks(text),
        }
        if stream_id:
            event["stream_id"] = stream_id
        emit(event)

    def add_caucus_entry(
        self,
        speaker: str,
        text: str,
        blocks: list[dict] | None = None,
        *,
        stream_id: str = "",
    ) -> None:
        event = {
            "type": "caucus",
            "speaker": speaker,
            "text": text,
            "blocks": blocks if blocks is not None else parse_render_blocks(text),
        }
        if stream_id:
            event["stream_id"] = stream_id
        emit(event)

    def stream_event(self, event: dict) -> None:
        payload = {"type": "stream", **event}
        with self.stream_log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": time.time(), **payload}) + "\n")
        emit(payload)

    def set_status(self, status: StatusSnapshot) -> None:
        emit({
            "type": "status",
            "mode": status.mode.value,
            "lead": status.lead,
            "route": status.route,
            "claude_pct": status.claude_percent,
            "codex_pct": status.codex_percent,
            "claude_tokens": status.claude_tokens,
            "claude_window": status.claude_window,
            "codex_tokens": status.codex_tokens,
            "codex_window": status.codex_window,
            "observe": status.observe_enabled,
        })

    def set_mode(self, mode: RoomMode) -> None:
        emit({"type": "mode", "mode": mode.value})

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
        try:
            return await future
        finally:
            self._pending_permission = None
            emit({"type": "permission_cleared"})

    def resolve_permission_request(self, allow: bool) -> None:
        if self._pending_permission is None or self._pending_permission.done():
            return
        self._pending_permission.set_result(allow)


async def _read_line() -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, sys.stdin.readline)


async def _wait_for_turn(
    task: asyncio.Task,
    botference: Botference,
    bridge: InkBridge,
    paths: BotferencePaths,
) -> None:
    try:
        await task
        bridge.set_status(botference.status_snapshot())
    except asyncio.CancelledError:
        botference.interrupt(bridge)
        bridge.set_status(botference.status_snapshot())
    except Exception as exc:
        append_crash_log(
            paths,
            location="botference_ink_bridge.handle_input",
            session_id=botference.session_id,
            exc=exc,
        )
        bridge.add_room_entry("system", f"Unhandled controller error: {exc}")
        bridge.set_status(botference.status_snapshot())
    finally:
        if botference.quit_requested:
            emit({"type": "exit"})
        else:
            emit({"type": "ready"})


async def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="botference ink bridge")
    parser.add_argument("--anthropic-model", default="claude-sonnet-4-6")
    parser.add_argument("--claude-effort", default="")
    parser.add_argument("--openai-model", default="gpt-5.5")
    parser.add_argument("--openai-effort", default="")
    parser.add_argument("--system-prompt-file", required=True)
    parser.add_argument("--task-file", required=True)
    parser.add_argument("--debug-panes", action="store_true")
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
    current_turn: asyncio.Task | None = None

    # Send initial state
    emit({"type": "completion_context", **get_completion_context()})
    bridge.set_status(botference.status_snapshot())
    bridge.add_room_entry("system", "Council room ready. First plain text routes to @all.")
    bridge.add_caucus_entry("system", "(empty until /caucus)")
    emit({"type": "ready"})

    # Main input loop
    while True:
        raw = await _read_line()
        if not raw:
            break

        try:
            msg = json.loads(raw.strip())
        except json.JSONDecodeError:
            continue

        if msg.get("type") == "input":
            if current_turn is not None and not current_turn.done():
                bridge.add_room_entry("system", "A turn is already running.")
                continue
            text = msg.get("text", "")
            attachments = msg.get("attachments", [])
            current_turn = asyncio.create_task(
                botference.handle_input(text, bridge, attachments=attachments)
            )
            asyncio.create_task(_wait_for_turn(current_turn, botference, bridge, paths))
            continue

        if msg.get("type") == "interrupt":
            if current_turn is not None and not current_turn.done():
                current_turn.cancel()
            continue

        if msg.get("type") == "permission_response":
            bridge.resolve_permission_request(bool(msg.get("allow")))
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
