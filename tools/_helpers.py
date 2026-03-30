"""Shared helpers — JSONL parsing, truncated formatting, file collection, pub reqs."""

import json
import re
from pathlib import Path


def parse_jsonl(path: str, on_error: str = "record") -> list[dict]:
    """Parse a JSONL file, handling blank lines and malformed JSON.

    on_error:
        "record" — append {"_error": "line N: malformed JSON"}
        "skip"   — silently skip bad lines
    """
    entries = []
    try:
        with open(path, encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    if on_error == "record":
                        entries.append({"_error": f"line {i}: malformed JSON"})
    except FileNotFoundError:
        pass
    return entries


def format_truncated(items: list, limit: int, fmt=str) -> list[str]:
    """Format first `limit` items, appending '... and N more' if truncated.

    Returns list of formatted strings (without trailing blank line).
    """
    lines = [fmt(item) for item in items[:limit]]
    if len(items) > limit:
        lines.append(f"  ... and {len(items) - limit} more")
    return lines


def collect_files(paths: list, extensions: set) -> list[Path]:
    """Expand directories into files matching given extensions.

    For each path:
    - Directory → glob for matching extensions
    - Existing file with matching extension → include
    - Otherwise → try as glob pattern
    """
    files = []
    for path_str in paths:
        path = Path(path_str)
        if path.is_dir():
            for ext in sorted(extensions):
                files.extend(sorted(path.glob(f"*{ext}")))
        elif path.exists() and path.suffix.lower() in extensions:
            files.append(path)
        else:
            for match in sorted(Path(".").glob(path_str)):
                if match.suffix.lower() in extensions:
                    files.append(match)
    return files


def parse_pub_reqs(path: str, patterns: dict, defaults: dict,
                   post_process=None) -> dict:
    """Parse specs/publication-requirements.md for numeric thresholds.

    patterns: {key: regex_with_one_capture_group}
    defaults: {key: default_value} — copied as starting point
    post_process: optional callable(reqs, text) for extra rules
    """
    reqs = dict(defaults)
    text = Path(path).read_text(encoding="utf-8")
    for key, pat in patterns.items():
        match = re.search(pat, text, re.IGNORECASE)
        if match:
            val = match.group(1)
            reqs[key] = float(val) if "." in val else int(val)
    if post_process:
        post_process(reqs, text)
    return reqs
