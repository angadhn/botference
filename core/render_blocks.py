"""Structured transcript block parsing for Ink/Textual renderers."""

from __future__ import annotations

import re
from typing import Any, List, Literal, Optional, TypedDict, Union


class SnippetHeader(TypedDict):
    filePath: str
    startLine: int
    endLine: Optional[int]


class TextBlock(TypedDict):
    type: Literal["text"]
    lines: List[str]


class CodeBlock(TypedDict):
    type: Literal["code"]
    header: Optional[SnippetHeader]
    language: Optional[str]
    leadingBlankLines: int
    lines: List[str]


class DiffBlock(TypedDict):
    type: Literal["diff"]
    filePath: Optional[str]
    language: Optional[str]
    lines: List[str]


RenderBlock = Union[TextBlock, CodeBlock, DiffBlock]

_SNIPPET_HEADER_RE = re.compile(
    r"""^['`"]?([^'"`]+?\.[A-Za-z0-9_.-]+)['`"]?\s+lines?\s+(\d+)(?:-(\d+))?:?\s*$"""
)
_PATCH_SUMMARY_RE = re.compile(
    r"^(Edited|Updated|Added|Deleted) in (.+?) \(\+\d+ -\d+\)$"
)
_DIFF_GIT_RE = re.compile(r"^diff --git a/(.+?) b/(.+)$")
_DIFF_META_RE = re.compile(r"^(diff --git|index\b|--- |\+\+\+ |@@)")
_PATCH_FILE_RE = re.compile(r"^\*\*\* (?:Update|Add|Delete|Move to):\s+(.+)$")
_LANGUAGE_ALIASES = {
    "py": "python",
    "python3": "python",
    "node": "javascript",
    "shellsession": "shell",
    "shell-session": "shell",
    "console": "shell",
    "typescriptreact": "tsx",
    "typescript-react": "tsx",
    "javascriptreact": "jsx",
    "javascript-react": "jsx",
}


def parse_snippet_header(raw_line: str) -> Optional[SnippetHeader]:
    match = _SNIPPET_HEADER_RE.match(raw_line.strip())
    if not match:
        return None
    return {
        "filePath": match.group(1),
        "startLine": int(match.group(2)),
        "endLine": int(match.group(3)) if match.group(3) else None,
    }


def fallback_language_from_path(file_path: str) -> Optional[str]:
    _, dot, ext = file_path.rpartition(".")
    if not dot:
        return None
    ext = ext.lower()
    if ext == "py":
        return "python"
    if ext in {"ts", "tsx", "js", "jsx", "mjs", "cjs"}:
        return ext
    if ext in {"sh", "bash", "zsh"}:
        return "bash"
    if ext == "json":
        return "json"
    if ext in {"yml", "yaml"}:
        return "yaml"
    if ext == "md":
        return "markdown"
    return ext


def normalize_language_name(language: Optional[str]) -> Optional[str]:
    if not language:
        return None
    lowered = language.lower()
    return _LANGUAGE_ALIASES.get(lowered, lowered)


def normalize_fence_language(raw_fence: str, header: Optional[SnippetHeader]) -> Optional[str]:
    trimmed = raw_fence.strip()
    match = re.match(r"^```([\w.+-]+)?", trimmed)
    explicit = normalize_language_name(match.group(1) if match and match.group(1) else None)
    if explicit:
        return explicit
    if header:
        return normalize_language_name(fallback_language_from_path(header["filePath"]))
    return None


def _split_content_lines(text: str) -> List[str]:
    if text == "":
        return []
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]
    return lines


def _synthetic_hunk_header(old_count: int, new_count: int) -> str:
    return f"@@ -1,{max(old_count, 1)} +1,{max(new_count, 1)} @@"


def _edit_action_name(old_lines: List[str], new_lines: List[str]) -> str:
    if old_lines and new_lines:
        return "Edited"
    if new_lines:
        return "Added"
    if old_lines:
        return "Deleted"
    return "Edited"


def _extract_write_content(tool_input: dict[str, Any]) -> str:
    for key in ("content", "text", "file_text"):
        value = tool_input.get(key)
        if isinstance(value, str):
            return value
    return ""


def build_tool_use_blocks(tool_name: str, tool_input: Any) -> List[RenderBlock]:
    if not isinstance(tool_input, dict):
        return []

    normalized_name = tool_name.strip().lower()
    file_path = str(tool_input.get("file_path") or tool_input.get("path") or "").strip()
    if not file_path:
        return []

    language = normalize_language_name(fallback_language_from_path(file_path))

    if normalized_name == "edit":
        old_lines = _split_content_lines(str(tool_input.get("old_string") or ""))
        new_lines = _split_content_lines(str(tool_input.get("new_string") or ""))
        if not old_lines and not new_lines:
            return []

        diff_lines: List[str] = [
            f"{_edit_action_name(old_lines, new_lines)} in {file_path} (+{len(new_lines)} -{len(old_lines)})",
            _synthetic_hunk_header(len(old_lines), len(new_lines)),
        ]
        diff_lines.extend(f"-{line}" for line in old_lines)
        diff_lines.extend(f"+{line}" for line in new_lines)
        return [{
            "type": "diff",
            "filePath": file_path,
            "language": language,
            "lines": diff_lines,
        }]

    if normalized_name == "multiedit":
        edits = tool_input.get("edits")
        if not isinstance(edits, list):
            return []
        diff_lines: List[str] = [f"Edited in {file_path} (+0 -0)"]
        total_old = 0
        total_new = 0
        saw_edit = False
        for edit in edits:
            if not isinstance(edit, dict):
                continue
            old_lines = _split_content_lines(str(edit.get("old_string") or ""))
            new_lines = _split_content_lines(str(edit.get("new_string") or ""))
            if not old_lines and not new_lines:
                continue
            saw_edit = True
            total_old += len(old_lines)
            total_new += len(new_lines)
            diff_lines.append(_synthetic_hunk_header(len(old_lines), len(new_lines)))
            diff_lines.extend(f"-{line}" for line in old_lines)
            diff_lines.extend(f"+{line}" for line in new_lines)
        if not saw_edit:
            return []
        diff_lines[0] = f"Edited in {file_path} (+{total_new} -{total_old})"
        return [{
            "type": "diff",
            "filePath": file_path,
            "language": language,
            "lines": diff_lines,
        }]

    if normalized_name == "write":
        content = _extract_write_content(tool_input)
        code_lines = _split_content_lines(content)
        return [{
            "type": "code",
            "header": {
                "filePath": file_path,
                "startLine": 1,
                "endLine": len(code_lines) or 1,
            },
            "language": language,
            "leadingBlankLines": 0,
            "lines": code_lines,
        }]

    return []


def is_diff_start_line(raw_line: str) -> bool:
    trimmed = raw_line.lstrip()
    return bool(
        _PATCH_SUMMARY_RE.match(trimmed)
        or _PATCH_FILE_RE.match(trimmed)
        or _DIFF_META_RE.match(trimmed)
    )


def is_diff_continuation_line(raw_line: str, *, in_diff_block: bool) -> bool:
    if not in_diff_block:
        return is_diff_start_line(raw_line)
    if raw_line == "":
        return False
    if is_diff_start_line(raw_line):
        return True
    if raw_line.startswith((" ", "+", "-")):
        return not raw_line.startswith(("--- ", "+++ ")) or raw_line.startswith(" ")
    return False


def next_diff_file_path(current: Optional[str], raw_line: str) -> Optional[str]:
    trimmed = raw_line.strip()

    patch_summary = _PATCH_SUMMARY_RE.match(trimmed)
    if patch_summary:
        return patch_summary.group(2)

    patch_file = _PATCH_FILE_RE.match(trimmed)
    if patch_file:
        return patch_file.group(1)

    diff_git = _DIFF_GIT_RE.match(trimmed)
    if diff_git:
        return diff_git.group(2) or diff_git.group(1) or current

    if trimmed.startswith("+++ b/"):
        return trimmed[len("+++ b/") :]
    if trimmed.startswith("--- a/") and current is None:
        return trimmed[len("--- a/") :]

    return current


def parse_render_blocks(text: str) -> List[RenderBlock]:
    raw_lines = text.split("\n")
    blocks: List[RenderBlock] = []
    text_lines: List[str] = []
    pending_header: Optional[SnippetHeader] = None
    pending_header_blank_lines = 0

    def flush_text_block() -> None:
        nonlocal text_lines
        if not text_lines:
            return
        blocks.append({"type": "text", "lines": text_lines})
        text_lines = []

    i = 0
    while i < len(raw_lines):
        raw_line = raw_lines[i]
        snippet_header = parse_snippet_header(raw_line)

        if snippet_header is not None:
            flush_text_block()
            pending_header = snippet_header
            pending_header_blank_lines = 0
            i += 1
            continue

        if pending_header and raw_line.strip() == "":
            pending_header_blank_lines += 1
            i += 1
            continue

        if raw_line.lstrip().startswith("```"):
            flush_text_block()
            language = normalize_fence_language(raw_line, pending_header)
            code_lines: List[str] = []
            i += 1
            while i < len(raw_lines):
                code_line = raw_lines[i]
                if code_line.lstrip().startswith("```"):
                    break
                code_lines.append(code_line)
                i += 1
            blocks.append(
                {
                    "type": "code",
                    "header": pending_header,
                    "language": language,
                    "leadingBlankLines": pending_header_blank_lines,
                    "lines": code_lines,
                }
            )
            pending_header = None
            pending_header_blank_lines = 0
            i += 1
            continue

        if is_diff_start_line(raw_line):
            flush_text_block()
            diff_lines: List[str] = []
            file_path: Optional[str] = None
            while i < len(raw_lines):
                diff_line = raw_lines[i]
                if not is_diff_continuation_line(diff_line, in_diff_block=bool(diff_lines)):
                    break
                diff_lines.append(diff_line)
                file_path = next_diff_file_path(file_path, diff_line)
                i += 1
            blocks.append(
                {
                    "type": "diff",
                    "filePath": file_path,
                    "language": normalize_language_name(fallback_language_from_path(file_path)) if file_path else None,
                    "lines": diff_lines,
                }
            )
            pending_header = None
            pending_header_blank_lines = 0
            continue

        if pending_header is not None:
            blocks.append(
                {
                    "type": "code",
                    "header": pending_header,
                    "language": normalize_language_name(fallback_language_from_path(pending_header["filePath"])),
                    "leadingBlankLines": 0,
                    "lines": [],
                }
            )
            pending_header = None
            pending_header_blank_lines = 0

        text_lines.append(raw_line)
        i += 1

    if pending_header is not None:
        blocks.append(
            {
                "type": "code",
                "header": pending_header,
                "language": normalize_language_name(fallback_language_from_path(pending_header["filePath"])),
                "leadingBlankLines": 0,
                "lines": [],
            }
        )
    flush_text_block()
    return blocks
