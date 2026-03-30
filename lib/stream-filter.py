"""Stream filter for claude --output-format stream-json.

Reads JSONL events from stdin, prints condensed progress to stderr,
and writes the final result JSON to the path given as argv[1].

Usage:
    claude -p --output-format stream-json --verbose ... \
      | python3 lib/stream-filter.py run/output.json
"""

import json
import os
import sys
import time

_start = time.monotonic()
_tool_count = 0


def _elapsed():
    s = int(time.monotonic() - _start)
    return f"[{s // 60}m {s % 60:02d}s]"


def _log(msg):
    print(f"  {_elapsed()}  {msg}", file=sys.stderr, flush=True)


def _summarize_tool(name, inp):
    """Return a short description for a tool_use event."""
    if name == "Agent":
        desc = inp.get("description", "")
        stype = inp.get("subagent_type", "")
        label = f"{stype}: " if stype else ""
        return f"Agent → {label}\"{desc}\""
    if name in ("Read", "Edit", "Write"):
        path = inp.get("file_path", "")
        # Show basename + parent for brevity
        parts = path.rsplit("/", 2)
        short = "/".join(parts[-2:]) if len(parts) >= 2 else path
        return f"{name} → {short}"
    if name == "Bash":
        desc = inp.get("description", "")
        if desc:
            return f"Bash → {desc[:70]}"
        cmd = inp.get("command", "")
        return f"Bash → {cmd[:70]}"
    if name in ("Grep", "Glob"):
        pat = inp.get("pattern", "")
        return f"{name} → {pat[:60]}"
    if name == "Skill":
        return f"Skill → {inp.get('skill', '?')}"
    if name == "TaskCreate":
        return f"TaskCreate → {inp.get('description', '')[:60]}"
    return name


def main():
    if len(sys.argv) < 2:
        print("Usage: stream-filter.py <output-json-path>", file=sys.stderr)
        sys.exit(1)

    output_path = sys.argv[1]
    global _tool_count

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = event.get("type", "")

        if etype == "assistant":
            msg = event.get("message", {})
            for block in msg.get("content", []):
                btype = block.get("type", "")
                if btype == "tool_use":
                    _tool_count += 1
                    name = block.get("name", "?")
                    inp = block.get("input", {})
                    _log(_summarize_tool(name, inp))
                elif btype == "text":
                    text = block.get("text", "").strip()
                    if text and len(text) > 10:
                        # Show brief snippet of reasoning
                        snippet = text[:100].replace("\n", " ")
                        if len(text) > 100:
                            snippet += "..."
                        _log(f"... {snippet}")

        elif etype == "result":
            # Write the result event as the output.json for downstream processing
            os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
            with open(output_path, "w") as f:
                json.dump(event, f)
            turns = event.get("num_turns", "?")
            cost = event.get("total_cost_usd", 0)
            _log(f"Done — {turns} turns, ${cost:.2f}, {_tool_count} tool calls")


if __name__ == "__main__":
    main()
