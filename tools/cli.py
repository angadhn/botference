#!/usr/bin/env python3
"""CLI dispatcher — invoke any botference tool from Bash.

Usage:
  python3 $BOTFERENCE_HOME/tools/cli.py <tool_name> '<json_args>'

Example:
  python3 $BOTFERENCE_HOME/tools/cli.py check_language '{"file_path":"sections/intro.tex"}'

Exits 0 on success, 1 on error.
"""

import json
import sys
from pathlib import Path

# Allow running as a script outside the package root.
sys.path.insert(0, str(Path(__file__).parent.parent))

from tools import execute_tool  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print("Usage: cli.py <tool_name> [json_args]", file=sys.stderr)
        sys.exit(1)

    tool_name = sys.argv[1]
    raw_args = sys.argv[2] if len(sys.argv) > 2 else "{}"

    try:
        tool_input = json.loads(raw_args)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON args: {exc}", file=sys.stderr)
        sys.exit(1)

    result = execute_tool(tool_name, tool_input)

    if isinstance(result, str) and result.startswith("Unknown tool:"):
        print(result, file=sys.stderr)
        sys.exit(1)

    print(result)


if __name__ == "__main__":
    main()
