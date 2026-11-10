"""Core tools: read_file, write_file, bash, git_commit, git_push.

These are ghuntley's essential primitives — every agent gets them
(except bash, which is restricted to agents that need full shell access).
"""

import os
import subprocess
import tempfile


def _handle_read_file(inp):
    try:
        with open(inp["file_path"], "r") as f:
            return f.read()
    except Exception as e:
        return f"Error reading file: {e}"


def _handle_write_file(inp):
    # Validate inputs before touching the filesystem
    if "content" not in inp or "file_path" not in inp:
        return "Error: write_file requires 'file_path' and 'content' parameters"

    file_path = inp["file_path"]
    content = inp["content"]

    # Check for size regression before writing
    old_size = 0
    if os.path.exists(file_path):
        old_size = os.path.getsize(file_path)

    dir_name = os.path.dirname(file_path) or "."
    os.makedirs(dir_name, exist_ok=True)

    # Atomic write: temp file in same directory, then os.replace()
    try:
        fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(content)
            os.replace(tmp_path, file_path)
        except Exception:
            os.unlink(tmp_path)
            raise
    except Exception as e:
        return f"Error writing file: {e}"

    msg = f"Wrote {len(content)} chars to {file_path}"
    if old_size > 100 and len(content) < old_size * 0.2:
        reduction = 100 - len(content) * 100 // old_size
        msg += f" ⚠ WARNING: file shrank from {old_size} to {len(content)} chars ({reduction}% reduction)"
    return msg


def _handle_bash(inp):
    result = subprocess.run(
        ["bash", "-c", inp["command"]],
        capture_output=True, text=True, timeout=120,
    )
    output = result.stdout + result.stderr
    if result.returncode != 0:
        return f"(exit code {result.returncode})\n{output}"
    return output if output.strip() else "(no output)"


# Seconds a git call may take before it is given up on. Commits get longer:
# a repository's own pre-commit checks run inside them.
_GIT_TIMEOUT = 30
_GIT_COMMIT_TIMEOUT = 120
_GIT_PUSH_TIMEOUT = 120


class _GitTimedOut(Exception):
    pass


def _git(args, timeout=_GIT_TIMEOUT):
    """Run git; a call that hangs (a lock, a credential prompt) is stopped
    after *timeout* seconds and raised as _GitTimedOut."""
    try:
        return subprocess.run(
            ["git"] + args, capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise _GitTimedOut(
            f"Error: `git {args[0]}` did not finish within {timeout} seconds "
            "and was stopped."
        )


def _handle_git_commit(inp):
    try:
        return _git_commit(inp)
    except _GitTimedOut as e:
        return str(e)


def _git_commit(inp):
    message = inp.get("message")
    if not message:
        return "Error: git_commit requires 'message' parameter"
    files = inp.get("files") or []

    # Stage files
    if files:
        stage_cmd = ["add", "--"] + files
    else:
        stage_cmd = ["add", "-A"]
    result = _git(stage_cmd)
    if result.returncode != 0:
        return f"Error staging files: {result.stderr}"

    # Check if there's anything to commit
    status = _git(["status", "--porcelain"])
    if not status.stdout.strip():
        return "Nothing to commit"

    # Commit
    result = _git(["commit", "-m", message], timeout=_GIT_COMMIT_TIMEOUT)
    output = result.stdout + result.stderr
    if result.returncode != 0:
        return f"(exit code {result.returncode})\n{output}"
    return output if output.strip() else "(committed)"


def _handle_git_push(inp):
    try:
        return _git_push(inp)
    except _GitTimedOut as e:
        return str(e)


def _git_push(inp):
    remote = inp.get("remote", "origin")
    branch = inp.get("branch", "")

    if not branch:
        r = _git(["rev-parse", "--abbrev-ref", "HEAD"])
        if r.returncode != 0:
            return "Error: not in a git repository or HEAD is detached"
        branch = r.stdout.strip()
        if not branch or branch == "HEAD":
            return "Error: HEAD is detached — specify a branch name"

    r = _git(["remote", "get-url", remote])
    if r.returncode != 0:
        return f"No remote '{remote}' configured. Add one with: git remote add {remote} <url>"

    r = _git(["push", remote, branch], timeout=_GIT_PUSH_TIMEOUT)
    output = r.stdout + r.stderr
    if r.returncode != 0:
        return f"Push failed: {output.strip()}"
    return output.strip() or f"Pushed to {remote}/{branch}"


TOOLS = {
    "read_file": {
        "name": "read_file",
        "description": "Read the contents of a file. Use this to inspect any file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to the file to read"},
            },
            "required": ["file_path"],
        },
        "function": _handle_read_file,
    },
    "write_file": {
        "name": "write_file",
        "description": "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "Path to the file to write"},
                "content": {"type": "string", "description": "Content to write"},
            },
            "required": ["file_path", "content"],
        },
        "function": _handle_write_file,
    },
    "bash": {
        "name": "bash",
        "description": "Execute a bash command and return its output. Use for git, pdflatex, and other shell operations.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The bash command to execute"},
            },
            "required": ["command"],
        },
        "function": _handle_bash,
    },
    "git_commit": {
        "name": "git_commit",
        "description": "Stage files and create a git commit. Use this for the yield protocol.",
        "input_schema": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Commit message"},
                "files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Files to stage. If omitted, stages all changes (git add -A).",
                },
            },
            "required": ["message"],
        },
        "function": _handle_git_commit,
    },
    "git_push": {
        "name": "git_push",
        "description": "Push local commits to a remote repository. Returns an error message if no remote is configured. Never force-pushes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "remote": {"type": "string", "description": "Remote name (default: 'origin')"},
                "branch": {"type": "string", "description": "Branch to push (default: current branch)"},
            },
            "required": [],
        },
        "function": _handle_git_push,
    },
}
