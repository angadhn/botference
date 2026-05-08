# Paper Ledger Format

`corpus/paper_ledger.jsonl` is the machine-readable paper lifecycle ledger. `corpus/paper_ledger.md` is generated from it for human browsing and must not be edited as a separate source of truth.

## Required JSONL Fields

Each row must include:

```json
{"paper":"Full paper title","authors_year_journal":"Smith et al. (2024), Nature","score":0.82,"reader_notes":"AI-generated-outputs/thread/deep-analysis/notes.md"}
```

- `paper`: paper title or recognizable paper name.
- `authors_year_journal`: compact human display string.
- `score`: numeric `0..1`; use `null` or `"n/a"` only for targeted support papers requested to fill a claim/evidence gap.
- `reader_notes`: path to reader notes. Leave empty until read; required once `status` is `read`.

Optional provenance fields:

- `paper_id`: stable short identifier, such as `Smith2024`.
- `doi`: DOI when known.
- `pdf_path`: local PDF path.
- `status`: one of `discovered`, `assigned`, `read`, `deferred`, `unavailable`, `requested_support`.
- `requested_for_claim`: claim that caused targeted support search.
- `request_id`: support request id.
- `notes_anchor`: text expected to appear in `reader_notes` for this paper.

## Human Markdown View

Render `corpus/paper_ledger.md` from JSONL with:

| Paper | Authors/Year/Journal | Score | Reader Notes |
| --- | --- | --- | --- |

Run `render_paper_ledger_markdown` after updating the JSONL ledger.

## Deterministic Checks

`validate_paper_ledger` verifies JSONL parsing, required fields, score bounds, duplicate `paper_id`/`doi`, local PDF existence when `pdf_path` is present, and notes-file anchoring for rows marked `read`.
