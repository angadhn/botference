"""Search tools: list_files, code_search.

ghuntley's essential primitives for codebase navigation. Every agent gets these.
"""

import os
import subprocess


def _handle_list_files(inp):
    path = inp.get("path", ".")
    pattern = inp.get("pattern")
    if pattern:
        # Use glob via find for pattern matching
        import glob
        matches = sorted(glob.glob(os.path.join(path, pattern), recursive=True))
        if not matches:
            return f"No files matching '{pattern}' in {path}"
        return "\n".join(matches)
    # Simple directory listing
    try:
        entries = sorted(os.listdir(path))
        result = []
        for e in entries:
            full = os.path.join(path, e)
            suffix = "/" if os.path.isdir(full) else ""
            result.append(f"{e}{suffix}")
        return "\n".join(result) if result else "(empty directory)"
    except Exception as e:
        return f"Error listing {path}: {e}"


def _handle_code_search(inp):
    cmd = ["rg", "--no-heading", "--line-number", "--color=never"]
    if inp.get("case_insensitive"):
        cmd.append("-i")
    if inp.get("glob"):
        cmd.extend(["--glob", inp["glob"]])
    if inp.get("max_results"):
        cmd.extend(["--max-count", str(inp["max_results"])])
    cmd.append(inp["pattern"])
    cmd.append(inp.get("path", "."))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    output = result.stdout
    if not output.strip():
        return f"No matches for '{inp['pattern']}'"
    return output


TOOLS = {
    "list_files": {
        "name": "list_files",
        "description": (
            "List files in a directory. Optionally filter with a glob pattern "
            "(e.g. '**/*.py' for all Python files recursively). "
            "Use this to understand project structure before reading files."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory to list (default: current directory)"},
                "pattern": {"type": "string", "description": "Glob pattern for filtering (e.g. '**/*.py', '*.md')"},
            },
            "required": [],
        },
        "function": _handle_list_files,
    },
    "code_search": {
        "name": "code_search",
        "description": (
            "Search file contents using ripgrep. Returns matching lines with file paths "
            "and line numbers. Use this to find function definitions, references, patterns."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regex pattern to search for"},
                "path": {"type": "string", "description": "File or directory to search in (default: current directory)"},
                "glob": {"type": "string", "description": "Filter files by glob (e.g. '*.py', '*.md')"},
                "case_insensitive": {"type": "boolean", "description": "Case-insensitive search (default: false)"},
                "max_results": {"type": "integer", "description": "Maximum matches per file"},
            },
            "required": ["pattern"],
        },
        "function": _handle_code_search,
    },
}
