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
from concurrent.futures import ThreadPoolExecutor

from cli_adapters import ClaudeAdapter, CodexAdapter
from botference import Botference
from botference_ui import RoomMode, StatusSnapshot

log = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1)


def emit(obj: dict) -> None:
    """Write a JSON line to stdout (for the Ink process to read)."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class InkBridge:
    """UIPort implementation that emits JSON-lines to stdout."""

    def add_room_entry(self, speaker: str, text: str) -> None:
        emit({"type": "room", "speaker": speaker, "text": text})

    def add_caucus_entry(self, speaker: str, text: str) -> None:
        emit({"type": "caucus", "speaker": speaker, "text": text})

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


async def _read_line() -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, sys.stdin.readline)


async def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="botference ink bridge")
    parser.add_argument("--anthropic-model", default="claude-sonnet-4-6")
    parser.add_argument("--claude-effort", default="")
    parser.add_argument("--openai-model", default="gpt-5.4")
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

    claude = ClaudeAdapter(
        model=args.anthropic_model,
        effort=args.claude_effort,
        debug_log_path=claude_log,
    )
    codex = CodexAdapter(
        model=args.openai_model,
        debug_log_path=codex_log,
        fallback_api_key=fallback_api_key,
    )
    botference = Botference(
        claude=claude, codex=codex,
        system_prompt=system_prompt, task=task,
    )
    botference.observe = args.debug_panes

    bridge = InkBridge()

    # Send initial state
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
            text = msg.get("text", "")
            attachments = msg.get("attachments", [])
            await botference.handle_input(text, bridge, attachments=attachments)
            bridge.set_status(botference.status_snapshot())

            if botference.quit_requested:
                emit({"type": "exit"})
                break

            emit({"type": "ready"})

    _executor.shutdown(wait=False)


if __name__ == "__main__":
    asyncio.run(main())
