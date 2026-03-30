"""GitHub CLI tool: gh.

Wraps the `gh` CLI for GitHub operations (PRs, issues, releases).
Only assigned to agents that need GitHub interaction (e.g., coder).
"""

import shutil
import subprocess

_BLOCKED = {"repo delete", "repo archive"}


def _handle_gh(inp):
    subcommand = inp["subcommand"]
    args = inp.get("args", [])

    if not shutil.which("gh"):
        return "Error: gh CLI is not installed. Install from https://cli.github.com/"

    for blocked in _BLOCKED:
        if subcommand.startswith(blocked):
            return f"Blocked: '{subcommand}' is not allowed for safety reasons"

    cmd = ["gh"] + subcommand.split() + args
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    output = r.stdout + r.stderr
    if r.returncode != 0:
        return f"(exit code {r.returncode})\n{output}"
    return output if output.strip() else "(no output)"


TOOLS = {
    "gh": {
        "name": "gh",
        "description": "Run a GitHub CLI (gh) command for PRs, issues, releases, etc. Requires gh to be installed and authenticated.",
        "input_schema": {
            "type": "object",
            "properties": {
                "subcommand": {"type": "string", "description": "gh subcommand (e.g., 'pr create', 'issue list', 'pr view 123')"},
                "args": {"type": "array", "items": {"type": "string"}, "description": "Additional flags (e.g., ['--title', 'Fix bug', '--body', 'Details'])"},
            },
            "required": ["subcommand"],
        },
        "function": _handle_gh,
    },
}
