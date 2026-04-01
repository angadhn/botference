#!/usr/bin/env python3
"""Generate a Shields-compatible tracked-code LOC badge payload."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = REPO_ROOT / "docs" / "badges" / "loc.json"
CODE_EXTENSIONS = {".py", ".sh", ".ts", ".tsx", ".js", ".jsx", ".mjs"}
EXCLUDED_PARTS = {
    ".git",
    ".pytest_cache",
    "archive",
    "build",
    "docs",
    "ink-ui/dist",
    "ink-ui/node_modules",
    "specs",
    "templates",
    "work",
}
ROOT_CODE_FILES = {"botference"}


def _tracked_files(repo_root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=repo_root,
        check=True,
        capture_output=True,
    )
    raw_paths = [p for p in result.stdout.decode("utf-8").split("\0") if p]
    return [repo_root / p for p in raw_paths]


def include_path(path: Path) -> bool:
    rel = path.relative_to(REPO_ROOT)
    rel_str = rel.as_posix()
    if rel_str in ROOT_CODE_FILES:
        return True
    if path.suffix not in CODE_EXTENSIONS:
        return False
    parts = set(rel.parts)
    if "dist" in parts and "ink-ui" in parts:
        return False
    if "node_modules" in parts:
        return False
    return not any(part in parts for part in EXCLUDED_PARTS)


def count_lines(path: Path) -> int:
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for _ in handle)


def format_loc(lines: int) -> str:
    if lines >= 1000:
        value = lines / 1000
        rounded = round(value, 1)
        if rounded.is_integer():
            return f"{int(rounded)}k"
        return f"{rounded:.1f}k"
    return str(lines)


def build_payload(total_lines: int, file_count: int) -> dict[str, object]:
    del file_count
    return {
        "schemaVersion": 1,
        "label": "tracked code loc",
        "message": format_loc(total_lines),
        "color": "0b7285",
        "cacheSeconds": 86400,
        "namedLogo": "github",
        "labelColor": "1f2937",
        "isError": False,
    }


def main() -> None:
    tracked = [path for path in _tracked_files(REPO_ROOT) if include_path(path)]
    total_lines = sum(count_lines(path) for path in tracked)
    payload = build_payload(total_lines, len(tracked))
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}: {payload['message']} across {len(tracked)} files")


if __name__ == "__main__":
    main()
