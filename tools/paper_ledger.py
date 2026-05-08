"""Paper lifecycle ledger tools for research-paper workflows."""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

from tools._helpers import parse_jsonl

DEFAULT_LEDGER = "corpus/paper_ledger.jsonl"
DEFAULT_MARKDOWN = "corpus/paper_ledger.md"
VALID_STATUSES = {
    "discovered",
    "assigned",
    "read",
    "deferred",
    "unavailable",
    "requested_support",
}
REQUIRED_FIELDS = ("paper", "authors_year_journal", "score", "reader_notes")


def _is_blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _norm(value: Any) -> str:
    return str(value).strip().lower()


def _project_path(raw: str | None) -> Path | None:
    if _is_blank(raw):
        return None
    path = Path(str(raw))
    return path if path.is_absolute() else Path.cwd() / path


def _score_allowed_empty(entry: dict[str, Any]) -> bool:
    status = entry.get("status")
    return status == "requested_support" or not _is_blank(entry.get("requested_for_claim")) or not _is_blank(entry.get("request_id"))


def _validate_score(entry: dict[str, Any], row: int, errors: list[str]) -> None:
    score = entry.get("score")
    if score is None or (isinstance(score, str) and score.strip().lower() in {"n/a", "na", ""}):
        if not _score_allowed_empty(entry):
            errors.append(f"line {row}: score is required unless this is targeted support")
        return

    try:
        value = float(score)
    except (TypeError, ValueError):
        errors.append(f"line {row}: score must be a number from 0 to 1, null, or n/a")
        return
    if not math.isfinite(value) or value < 0 or value > 1:
        errors.append(f"line {row}: score must be between 0 and 1")


def _validate_notes(entry: dict[str, Any], row: int, errors: list[str]) -> None:
    if entry.get("status") != "read":
        return

    notes_path = _project_path(entry.get("reader_notes"))
    if notes_path is None:
        errors.append(f"line {row}: read paper requires reader_notes")
        return
    if not notes_path.is_file():
        errors.append(f"line {row}: reader_notes does not exist: {entry.get('reader_notes')}")
        return

    anchor = entry.get("notes_anchor")
    if _is_blank(anchor):
        errors.append(f"line {row}: read paper requires notes_anchor")
        return

    text = notes_path.read_text(encoding="utf-8", errors="ignore")
    escaped = re.escape(str(anchor).strip())
    heading_re = re.compile(rf"^#+\s+.*{escaped}", re.MULTILINE)
    if not heading_re.search(text):
        errors.append(f"line {row}: reader_notes does not contain notes_anchor in a markdown heading")


def _validate_entry(entry: dict[str, Any], row: int, errors: list[str]) -> None:
    if not isinstance(entry, dict):
        errors.append(f"line {row}: row must be a JSON object")
        return
    if "_error" in entry:
        errors.append(f"line {row}: {entry['_error']}")
        return

    for field in REQUIRED_FIELDS:
        if field not in entry:
            errors.append(f"line {row}: missing required field '{field}'")
        elif field != "reader_notes" and _is_blank(entry.get(field)):
            errors.append(f"line {row}: required field '{field}' is blank")

    status = entry.get("status")
    if not _is_blank(status) and status not in VALID_STATUSES:
        errors.append(f"line {row}: invalid status '{status}'")

    _validate_score(entry, row, errors)

    pdf_path = _project_path(entry.get("pdf_path"))
    if pdf_path is not None and status != "unavailable" and not pdf_path.is_file():
        errors.append(f"line {row}: pdf_path does not exist: {entry.get('pdf_path')}")

    _validate_notes(entry, row, errors)


def validate_paper_ledger_file(ledger_file: str = DEFAULT_LEDGER) -> tuple[bool, list[str], list[dict[str, Any]]]:
    path = Path(ledger_file)
    if not path.is_file():
        return False, [f"ledger file not found: {ledger_file}"], []

    entries = parse_jsonl(str(path), on_error="record")
    if not entries:
        return False, [f"ledger file is empty: {ledger_file}"], []

    errors: list[str] = []
    seen_paper_ids: dict[str, int] = {}
    seen_dois: dict[str, int] = {}
    for row, entry in enumerate(entries, 1):
        _validate_entry(entry, row, errors)
        if not isinstance(entry, dict):
            continue

        paper_id = entry.get("paper_id")
        if not _is_blank(paper_id):
            key = _norm(paper_id)
            if key in seen_paper_ids:
                errors.append(f"line {row}: duplicate paper_id '{paper_id}' also seen on line {seen_paper_ids[key]}")
            else:
                seen_paper_ids[key] = row

        doi = entry.get("doi")
        if not _is_blank(doi):
            key = _norm(doi)
            if key in seen_dois:
                errors.append(f"line {row}: duplicate doi '{doi}' also seen on line {seen_dois[key]}")
            else:
                seen_dois[key] = row

    return not errors, errors, entries


def _format_score(score: Any) -> str:
    if score is None:
        return "n/a"
    if isinstance(score, str):
        stripped = score.strip()
        if stripped.lower() in {"", "n/a", "na"}:
            return "n/a"
        try:
            return f"{float(stripped):.2f}"
        except ValueError:
            return stripped
    try:
        return f"{float(score):.2f}"
    except (TypeError, ValueError):
        return str(score)


def _md_cell(value: Any) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\n", " ").strip()


def render_paper_ledger_markdown(ledger_file: str = DEFAULT_LEDGER, output_file: str = DEFAULT_MARKDOWN) -> str:
    ok, errors, entries = validate_paper_ledger_file(ledger_file)
    if not ok:
        return _format_validation_report("paper ledger", ledger_file, False, errors, 0)

    lines = [
        "# Paper Ledger",
        "",
        "| Paper | Authors/Year/Journal | Score | Reader Notes |",
        "| --- | --- | --- | --- |",
    ]
    for entry in entries:
        lines.append(
            "| "
            + " | ".join(
                [
                    _md_cell(entry.get("paper")),
                    _md_cell(entry.get("authors_year_journal")),
                    _md_cell(_format_score(entry.get("score"))),
                    _md_cell(entry.get("reader_notes")),
                ]
            )
            + " |"
        )
    lines.append("")

    rendered = "\n".join(lines)
    out = Path(output_file)
    out.parent.mkdir(parents=True, exist_ok=True)
    if not out.exists() or out.read_text(encoding="utf-8", errors="ignore") != rendered:
        out.write_text(rendered, encoding="utf-8")
    return f"**PASS** — rendered {len(entries)} paper ledger row(s) to {output_file}"


def _format_validation_report(name: str, path: str, ok: bool, errors: list[str], count: int) -> str:
    lines = [f"## validate_{name.replace(' ', '_')} report", "", f"File: {path}", f"Rows: {count}", ""]
    if ok:
        lines.append("**PASS** — no issues found.")
        return "\n".join(lines)
    lines.append(f"**FAIL** — {len(errors)} issue(s) found:")
    lines.extend(f"- {err}" for err in errors)
    return "\n".join(lines)


def _handle_validate_paper_ledger(inp: dict[str, Any]) -> str:
    ledger_file = inp.get("ledger_file") or inp.get("file_path") or DEFAULT_LEDGER
    ok, errors, entries = validate_paper_ledger_file(str(ledger_file))
    return _format_validation_report("paper ledger", str(ledger_file), ok, errors, len(entries))


def _handle_render_paper_ledger_markdown(inp: dict[str, Any]) -> str:
    ledger_file = inp.get("ledger_file") or inp.get("file_path") or DEFAULT_LEDGER
    output_file = inp.get("output_file") or DEFAULT_MARKDOWN
    return render_paper_ledger_markdown(str(ledger_file), str(output_file))


def _support_request_path(inp: dict[str, Any]) -> str:
    explicit = inp.get("support_requests_file") or inp.get("file_path")
    if explicit:
        return str(explicit)
    thread = inp.get("thread")
    if thread:
        return str(Path("AI-generated-outputs") / str(thread) / "support_requests.jsonl")
    return "AI-generated-outputs/support_requests.jsonl"


def _known_paper_ids(entries: list[dict[str, Any]]) -> set[str]:
    known: set[str] = set()
    for entry in entries:
        for field in ("paper_id", "paper", "doi"):
            value = entry.get(field)
            if not _is_blank(value):
                known.add(_norm(value))
    return known


def _handle_validate_support_requests(inp: dict[str, Any]) -> str:
    request_file = _support_request_path(inp)
    request_path = Path(request_file)
    errors: list[str] = []
    if not request_path.is_file():
        return _format_validation_report("support requests", request_file, False, [f"support request file not found: {request_file}"], 0)

    requests = parse_jsonl(str(request_path), on_error="record")
    ledger_file = str(inp.get("ledger_file") or DEFAULT_LEDGER)
    ledger_ok, ledger_errors, ledger_entries = validate_paper_ledger_file(ledger_file)
    known = _known_paper_ids(ledger_entries)
    has_resolved_request = False

    for row, request in enumerate(requests, 1):
        if not isinstance(request, dict):
            errors.append(f"line {row}: row must be a JSON object")
            continue
        if "_error" in request:
            errors.append(f"line {row}: {request['_error']}")
            continue
        for field in ("request_id", "requester", "claim", "needed_evidence", "status"):
            if field not in request or _is_blank(request.get(field)):
                errors.append(f"line {row}: missing required field '{field}'")
        if request.get("status") == "resolved":
            has_resolved_request = True
            resolved = request.get("resolved_by_papers")
            if not isinstance(resolved, list) or not resolved:
                errors.append(f"line {row}: resolved request requires non-empty resolved_by_papers")
            else:
                for paper in resolved:
                    if _norm(paper) not in known:
                        errors.append(f"line {row}: resolved paper not found in paper ledger: {paper}")

    if has_resolved_request and not ledger_ok:
        errors.extend(f"paper ledger issue: {err}" for err in ledger_errors)

    return _format_validation_report("support requests", request_file, not errors, errors, len(requests))


TOOLS = {
    "validate_paper_ledger": {
        "name": "validate_paper_ledger",
        "description": "Validate corpus/paper_ledger.jsonl for paper, score, local PDF, and reader-notes integrity.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ledger_file": {"type": "string", "description": "Paper ledger JSONL path. Defaults to corpus/paper_ledger.jsonl."},
                "file_path": {"type": "string", "description": "Alias for ledger_file."},
            },
        },
        "function": _handle_validate_paper_ledger,
    },
    "render_paper_ledger_markdown": {
        "name": "render_paper_ledger_markdown",
        "description": "Render the paper ledger JSONL into a human-readable Markdown table.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ledger_file": {"type": "string", "description": "Paper ledger JSONL path. Defaults to corpus/paper_ledger.jsonl."},
                "file_path": {"type": "string", "description": "Alias for ledger_file."},
                "output_file": {"type": "string", "description": "Markdown output path. Defaults to corpus/paper_ledger.md."},
            },
        },
        "function": _handle_render_paper_ledger_markdown,
    },
    "validate_support_requests": {
        "name": "validate_support_requests",
        "description": "Validate paper-writer or deep-reader support requests against the paper ledger.",
        "input_schema": {
            "type": "object",
            "properties": {
                "support_requests_file": {"type": "string", "description": "Support request JSONL path."},
                "file_path": {"type": "string", "description": "Alias for support_requests_file."},
                "thread": {"type": "string", "description": "Thread name for AI-generated-outputs/<thread>/support_requests.jsonl."},
                "ledger_file": {"type": "string", "description": "Paper ledger path. Defaults to corpus/paper_ledger.jsonl."},
            },
        },
        "function": _handle_validate_support_requests,
    },
}
