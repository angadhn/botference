#!/usr/bin/env python3
"""Extract aggregated usage from a Claude session JSONL file.

Reads all assistant messages, sums token usage, and outputs a single JSON
object on stdout suitable for appending to logs/usage.jsonl.

Usage:
    python scripts/extract_session_usage.py ~/.claude/projects/<hash>/<session>.jsonl
"""

import json
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <session.jsonl>", file=sys.stderr)
        sys.exit(1)

    session_path = Path(sys.argv[1])
    if not session_path.exists():
        print(f"File not found: {session_path}", file=sys.stderr)
        sys.exit(1)

    input_tokens = 0
    cache_read = 0
    cache_create = 0
    output_tokens = 0
    num_turns = 0
    model = "unknown"
    first_ts = None
    last_ts = None

    with open(session_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get("type") != "assistant":
                continue

            msg = entry.get("message", {})
            usage = msg.get("usage", {})
            if not usage:
                continue

            num_turns += 1
            input_tokens += usage.get("input_tokens", 0)
            cache_read += usage.get("cache_read_input_tokens", 0)
            cache_create += usage.get("cache_creation_input_tokens", 0)
            output_tokens += usage.get("output_tokens", 0)

            if model == "unknown" and msg.get("model"):
                model = msg["model"]

            ts = entry.get("timestamp")
            if ts:
                if first_ts is None:
                    first_ts = ts
                last_ts = ts

    # Estimate duration from timestamps
    duration_ms = 0
    if first_ts and last_ts:
        try:
            from datetime import datetime, timezone

            def parse_ts(s):
                for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ",
                            "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
                    try:
                        return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
                    except ValueError:
                        continue
                return None

            t0 = parse_ts(first_ts)
            t1 = parse_ts(last_ts)
            if t0 and t1:
                duration_ms = int((t1 - t0).total_seconds() * 1000)
        except Exception:
            pass

    result = {
        "model": model,
        "num_turns": num_turns,
        "duration_ms": duration_ms,
        "input_tokens": input_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_create,
        "output_tokens": output_tokens,
        "cost_usd": None,  # not available from session JSONL; usage_report.py will estimate
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
