#!/usr/bin/env python3
"""Un-wedge a botference session whose model relay got stuck.

Long sessions could wedge when a relay/handoff was generated but the fresh session
failed to start (its own backfill overflowed the context window), leaving a stuck
entry in ``pending_relay_handoffs`` and stale, over-100 ``yield_pressure``. This
script clears that state and (optionally) trims oversized tool output from the
transcript so the session loads and relays cleanly again.

IMPORTANT: stop botference first. If the app is running it will overwrite the
session file from memory and undo these edits. This script refuses to run while
botference appears to be running unless you pass --force.

Usage:
    python scripts/unwedge_session.py [SESSION_JSON]
    python scripts/unwedge_session.py --help

With no path, defaults to the known wedged session under ../botference.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_SESSION = (
    Path(__file__).resolve().parent.parent.parent
    / "botference" / "work" / "sessions"
    / "ec53fd69-37ec-435e-aa1c-4a8fcc51df32.json"
)

TOOL_OUTPUT_BLOCK_LIMIT = 2000  # match cli_adapters._TOOL_OUTPUT_BLOCK_LIMIT
OUTPUT_PREVIEW_LIMIT = 240
RECENT_MODIFIED_SECONDS = 300  # if the session file changed this recently, the app
#                                is likely live and will overwrite our edits.


def _app_running() -> bool:
    """Best-effort check for a live botference process (macOS/Linux)."""
    patterns = ("botference_ink_bridge.py", "ink-ui/dist/bin.js")

    # Prefer pgrep -f: it matches the full command line. Plain `ps ax` truncates
    # long command lines (which hid the running bridge during development).
    try:
        for pat in patterns:
            res = subprocess.run(
                ["pgrep", "-f", pat], capture_output=True, text=True, timeout=10
            )
            if res.returncode == 0 and res.stdout.strip():
                return True
        return False
    except FileNotFoundError:
        pass  # pgrep unavailable; fall back to a non-truncating ps below
    except Exception:
        return False

    try:
        out = subprocess.run(
            ["ps", "-Awwo", "command"], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return False
    return any(pat in out for pat in patterns)


def _truncate_blocks(blocks: list) -> int:
    """Cap text within structured tool-output blocks. Returns chars removed."""
    removed = 0
    for block in blocks:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            text = block["text"]
            if len(text) > TOOL_OUTPUT_BLOCK_LIMIT:
                removed += len(text) - TOOL_OUTPUT_BLOCK_LIMIT
                block["text"] = (
                    text[:TOOL_OUTPUT_BLOCK_LIMIT]
                    + "\n[… truncated by unwedge_session]"
                )
    return removed


def unwedge(path: Path, *, trim_tools: bool, backup: bool) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))

    if backup:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        bak = path.with_suffix(path.suffix + f".bak-{stamp}")
        shutil.copy2(path, bak)
        print(f"  backup: {bak}")

    # 1. Clear stuck relay handoffs.
    pending = data.get("pending_relay_handoffs") or {}
    if pending:
        print(f"  clearing pending_relay_handoffs for: {', '.join(pending)}")
        data["pending_relay_handoffs"] = {}
    else:
        print("  pending_relay_handoffs: already empty")

    # 2. Reset stale over-threshold yield pressure so relays re-evaluate cleanly.
    yp = data.get("yield_pressure") or {}
    reset = {
        m: v for m, v in yp.items()
        if isinstance(v, (int, float)) and v > 100
    }
    if reset:
        print("  resetting stale yield_pressure: "
              + ", ".join(f"{m}={v:.0f}" for m, v in reset.items()))
        data["yield_pressure"] = {
            m: (0.0 if (isinstance(v, (int, float)) and v > 100) else v)
            for m, v in yp.items()
        }
    else:
        print("  yield_pressure: nothing stale to reset")

    # 3. Optionally trim oversized tool output from the transcript (shrinks the
    #    file and the relay backfill; matches the capture-time cap in the fix).
    if trim_tools:
        total_removed = 0
        for entry in data.get("transcript", []) or []:
            for ts in entry.get("tool_summaries", []) or []:
                if not isinstance(ts, dict):
                    continue
                blocks = ts.get("output_blocks")
                if isinstance(blocks, list):
                    total_removed += _truncate_blocks(blocks)
                op = ts.get("output_preview")
                if isinstance(op, str) and len(op) > OUTPUT_PREVIEW_LIMIT:
                    total_removed += len(op) - OUTPUT_PREVIEW_LIMIT
                    ts["output_preview"] = op[:OUTPUT_PREVIEW_LIMIT] + "…"
        if total_removed:
            print(f"  trimmed ~{total_removed:,} chars of tool output from transcript")
        else:
            print("  transcript tool output: nothing oversized to trim")

    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"  wrote: {path} ({path.stat().st_size:,} bytes)")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("session", nargs="?", type=Path, default=DEFAULT_SESSION,
                    help="Path to the session JSON (default: known wedged session)")
    ap.add_argument("--no-trim-tools", action="store_true",
                    help="Do not trim oversized tool output from the transcript")
    ap.add_argument("--no-backup", action="store_true", help="Skip the .bak copy")
    ap.add_argument("--force", action="store_true",
                    help="Run even if botference appears to be running (unsafe)")
    args = ap.parse_args()

    path: Path = args.session
    if not path.exists():
        print(f"error: session file not found: {path}", file=sys.stderr)
        return 1

    if _app_running() and not args.force:
        print(
            "error: botference appears to be RUNNING. Quit it first (Ctrl+C) or the "
            "app will overwrite these edits from memory. Use --force to override.",
            file=sys.stderr,
        )
        return 2

    # Defense-in-depth (works even where process listing is unavailable): a very
    # recently modified session file means the app is almost certainly still live.
    age = time.time() - path.stat().st_mtime
    if age < RECENT_MODIFIED_SECONDS and not args.force:
        print(
            f"error: {path.name} was modified {age:.0f}s ago — botference may be "
            "running and would overwrite these edits. Quit it first, or use --force.",
            file=sys.stderr,
        )
        return 2

    print(f"unwedging: {path}")
    unwedge(path, trim_tools=not args.no_trim_tools, backup=not args.no_backup)
    print("done. Restart botference to load the recovered session.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
