# Triage Report

**Date:** YYYY-MM-DD
**Thread:** <thread>
**Inputs consumed:**
- corpus_index.jsonl: [N entries]
- scored_papers.md: [N papers scored across M scout iterations]
- deep-reader notes.md: [N papers already read, or "not available"]
- grading-rubric.md: [loaded / not found]

## Corpus Statistics

| Metric | Count |
|--------|-------|
| Total entries (pre-dedup) | N |
| Unique papers (post-dedup) | N |
| Duplicates identified | N |
| Grade conflicts resolved | N |
| Papers already read | N |
| Papers in reading plan | N |
| Papers deferred | N |
| Papers unavailable (no PDF) | N |

## Deduplication Log

### Duplicate Cluster 1: [Representative title]

| Entry | Source Iteration | Grade | Match Type |
|-------|-----------------|-------|------------|
| [citation_key_1] | scout iteration N | [grade] | — (kept) |
| [citation_key_2] | scout iteration M | [grade] | DOI match |

**Action:** Merged into `[kept_key]`. Rationale: [why this entry was kept]
**Tags merged:** [combined tag list]

*(One section per cluster. If no duplicates: "No duplicates identified.")*

## Grade Conflict Resolutions

### Conflict 1: [citation_key] — "[Paper title]"

| Scout Iteration | Grade | Score | Reasoning |
|----------------|-------|-------|-----------|
| [iteration N] | [grade] | [score] | [reasoning] |
| [iteration M] | [grade] | [score] | [reasoning] |

**Final grade:** [grade] — **Final score:** [score]
**Resolution reasoning:** [Reference grading-rubric.md criteria.]

*(One section per conflict. If none: "No grade conflicts found.")*

## Deferred Papers

| # | Citation Key | Grade | Reason Deferred |
|---|-------------|-------|-----------------|
| 1 | [key] | C | Below reading threshold |

*(If none: "No papers deferred — all unique papers assigned to reading plan.")*
