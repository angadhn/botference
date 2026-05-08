import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools import get_tools_for_agent
from tools.paper_ledger import (
    render_paper_ledger_markdown,
    validate_paper_ledger_file,
    _handle_validate_support_requests,
)


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def _valid_row(**overrides):
    row = {
        "paper": "Careful Paper",
        "authors_year_journal": "Smith et al. (2024), Nature",
        "score": 0.82,
        "reader_notes": "",
        "paper_id": "Smith2024",
        "doi": "10.1234/example",
        "status": "discovered",
    }
    row.update(overrides)
    return row


def test_valid_ledger_passes(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write_jsonl(Path("corpus/paper_ledger.jsonl"), [_valid_row()])

    ok, errors, entries = validate_paper_ledger_file()

    assert ok is True
    assert errors == []
    assert len(entries) == 1


def test_missing_required_field_fails(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    row = _valid_row()
    del row["authors_year_journal"]
    _write_jsonl(Path("corpus/paper_ledger.jsonl"), [row])

    ok, errors, _entries = validate_paper_ledger_file()

    assert ok is False
    assert any("authors_year_journal" in err for err in errors)


def test_duplicate_doi_and_paper_id_fail(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write_jsonl(
        Path("corpus/paper_ledger.jsonl"),
        [
            _valid_row(),
            _valid_row(paper="Another Paper"),
        ],
    )

    ok, errors, _entries = validate_paper_ledger_file()

    assert ok is False
    joined = "\n".join(errors)
    assert "duplicate paper_id" in joined
    assert "duplicate doi" in joined


def test_read_row_requires_existing_notes_with_anchor(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    notes = Path("AI-generated-outputs/thread/deep-analysis/notes.md")
    notes.parent.mkdir(parents=True)
    notes.write_text("Notes about a different paper\n", encoding="utf-8")
    _write_jsonl(
        Path("corpus/paper_ledger.jsonl"),
        [_valid_row(status="read", reader_notes=str(notes), notes_anchor="Smith2024")],
    )

    ok, errors, _entries = validate_paper_ledger_file()

    assert ok is False
    assert any("does not contain notes_anchor in a markdown heading" in err for err in errors)


def test_read_row_requires_notes_anchor(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    notes = Path("AI-generated-outputs/thread/deep-analysis/notes.md")
    notes.parent.mkdir(parents=True)
    notes.write_text("### Smith2024 -- Careful Paper\nFindings...\n", encoding="utf-8")
    _write_jsonl(
        Path("corpus/paper_ledger.jsonl"),
        [_valid_row(status="read", reader_notes=str(notes), notes_anchor="")],
    )

    ok, errors, _entries = validate_paper_ledger_file()

    assert ok is False
    assert any("requires notes_anchor" in err for err in errors)


def test_read_row_passes_when_notes_contain_anchor(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    notes = Path("AI-generated-outputs/thread/deep-analysis/notes.md")
    notes.parent.mkdir(parents=True)
    notes.write_text("### Smith2024 -- Careful Paper\nFindings...\n", encoding="utf-8")
    _write_jsonl(
        Path("corpus/paper_ledger.jsonl"),
        [_valid_row(status="read", reader_notes=str(notes), notes_anchor="Smith2024")],
    )

    ok, errors, _entries = validate_paper_ledger_file()

    assert ok is True
    assert errors == []


def test_score_rejects_nan_and_inf(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write_jsonl(Path("corpus/paper_ledger.jsonl"), [_valid_row(score="nan"), _valid_row(paper_id="Jones2025", doi="10.1234/other", score="inf")])

    ok, errors, _entries = validate_paper_ledger_file()

    assert ok is False
    assert sum("score must be between 0 and 1" in err for err in errors) == 2


def test_requested_support_allows_na_score(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write_jsonl(
        Path("corpus/paper_ledger.jsonl"),
        [
            _valid_row(
                score="n/a",
                status="requested_support",
                requested_for_claim="Need evidence for scaling claim.",
            )
        ],
    )

    ok, errors, _entries = validate_paper_ledger_file()

    assert ok is True
    assert errors == []


def test_markdown_renderer_uses_minimal_columns(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write_jsonl(Path("corpus/paper_ledger.jsonl"), [_valid_row(reader_notes="notes.md")])

    report = render_paper_ledger_markdown()
    rendered = Path("corpus/paper_ledger.md").read_text(encoding="utf-8")

    assert "**PASS**" in report
    assert "| Paper | Authors/Year/Journal | Score | Reader Notes |" in rendered
    assert "Careful Paper" in rendered
    assert "0.82" in rendered


def test_resolved_support_request_must_point_to_known_paper(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write_jsonl(Path("corpus/paper_ledger.jsonl"), [_valid_row()])
    _write_jsonl(
        Path("AI-generated-outputs/thread/support_requests.jsonl"),
        [
            {
                "request_id": "req-1",
                "requester": "paper-writer",
                "claim": "A claim needs support.",
                "needed_evidence": "Quantitative confirmation.",
                "status": "resolved",
                "resolved_by_papers": ["Missing2025"],
            }
        ],
    )

    report = _handle_validate_support_requests({"thread": "thread"})

    assert "**FAIL**" in report
    assert "resolved paper not found" in report


def test_resolved_support_request_surfaces_invalid_ledger(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _write_jsonl(
        Path("corpus/paper_ledger.jsonl"),
        [
            _valid_row(),
            _valid_row(paper="Broken Paper", paper_id="Broken2025", doi="10.9999/broken", score="nan"),
        ],
    )
    _write_jsonl(
        Path("AI-generated-outputs/thread/support_requests.jsonl"),
        [
            {
                "request_id": "req-1",
                "requester": "paper-writer",
                "claim": "A claim needs support.",
                "needed_evidence": "Quantitative confirmation.",
                "status": "resolved",
                "resolved_by_papers": ["Smith2024"],
            }
        ],
    )

    report = _handle_validate_support_requests({"thread": "thread"})

    assert "**FAIL**" in report
    assert "paper ledger issue" in report
    assert "score must be between 0 and 1" in report


def test_research_agents_have_ledger_tools():
    scout_tools, _ = get_tools_for_agent("scout")
    triage_tools, _ = get_tools_for_agent("triage")
    reader_tools, _ = get_tools_for_agent("deep-reader")
    writer_tools, _ = get_tools_for_agent("paper-writer")

    assert "validate_paper_ledger" in scout_tools
    assert "render_paper_ledger_markdown" in triage_tools
    assert "validate_paper_ledger" in reader_tools
    assert "validate_support_requests" in writer_tools
