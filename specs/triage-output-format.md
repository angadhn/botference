# Triage Output Format

Two reports + one data file per iteration:

| File | Location | Purpose |
|------|----------|---------|
| `triage_report.md` | `AI-generated-outputs/<thread>/triage/` | Dedup results, conflict resolutions, corpus stats |
| `reading_plan.md` | `AI-generated-outputs/<thread>/triage/` | Prioritized reading plan for deep-reader |
| `corpus_index_deduped.jsonl` | `corpus/` | Deduplicated corpus (original preserved) |

Templates: `templates/triage-report.md`, `templates/triage-reading-plan.md`

## corpus_index_deduped.jsonl schema

Same as `corpus_index.jsonl` plus these triage-added fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `triage_status` | string | yes | assigned / read / deferred / unavailable |
| `triage_notes` | string | no | Deduplication and grade change notes |
| `reading_batch` | integer | if assigned | Batch number in reading plan |
| `theme` | string | if assigned | Theme from scout summary |

## Deduplication match types

| Match Type | Confidence | Criteria |
|------------|-----------|----------|
| **DOI match** | Highest | Exact DOI (case-insensitive, URL prefix stripped) |
| **Title match** | High | Normalized titles >90% character overlap |
| **Author+year** | Medium | Same first author surname + same year |

Merge rule: keep entry with most complete metadata, union tags, trigger conflict resolution if grades differ.

## Commit gates

- [ ] `triage_report.md` exists with all 8 corpus statistics populated
- [ ] Every duplicate cluster: entries, match type, action, rationale
- [ ] Every grade conflict: original grades, final grade, reasoning citing grading-rubric.md
- [ ] `reading_plan.md` exists with ≥1 batch; excludes already-read papers
- [ ] Each planned paper has: citation key, title, grade, page count, PDF status
- [ ] Reading batches include context budget estimates
- [ ] `corpus_index_deduped.jsonl` exists; entries ≤ original; every entry has `triage_status`
- [ ] Assigned entries have `reading_batch` and `theme`
- [ ] Original `corpus_index.jsonl` unmodified; no scout outputs modified
- [ ] `checkpoint.md` Next Task set

## Yield priority

Produce in order: (1) `corpus_index_deduped.jsonl` (mechanical), (2) `triage_report.md` (documentation), (3) `reading_plan.md` (planning). Mark partial with `(PARTIAL)` header.
