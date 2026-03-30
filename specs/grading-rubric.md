# Grading Rubric — Paper Scoring

> Used by scout to evaluate and rank papers. Every paper in `scored_papers.md` must be scored using this rubric.

## Scoring Dimensions

### Relevance (weight: 0.6)

How directly the paper addresses the project's research questions.

| Score | Anchor |
|-------|--------|
| 1.0 | Directly addresses a core research question with primary data or analysis |
| 0.8 | Addresses a core question but from an adjacent angle or with partial data |
| 0.6 | Relevant methodology or framework applicable to research questions |
| 0.4 | Tangentially related — useful background but not directly applicable |
| 0.2 | Peripheral — only one finding or method overlaps |
| 0.0 | Not relevant to the project |

### Citation Signal (weight: 0.2)

Influence within the field, assessed from citation count relative to age and venue.

| Score | Anchor |
|-------|--------|
| 1.0 | Landmark paper (>500 citations, or >100/year), widely cited across subfields |
| 0.8 | Highly cited (>200, or >50/year), recognized as key reference |
| 0.6 | Well-cited (>50, or >20/year), established contribution |
| 0.4 | Moderately cited (>15), solid but not widely known |
| 0.2 | Few citations (<15), recent or niche |
| 0.0 | Uncited or unable to verify |

### Recency (weight: 0.2)

How current the work is. More recent papers score higher unless the seminal override applies.

| Score | Anchor |
|-------|--------|
| 1.0 | Published within last 12 months |
| 0.8 | Published 1-2 years ago |
| 0.6 | Published 2-4 years ago |
| 0.4 | Published 4-7 years ago |
| 0.2 | Published 7-15 years ago |
| 0.0 | Published >15 years ago |

## Seminal Paper Override

Foundational or seminal papers that established a field, coined key terminology, or introduced a widely-adopted method override the recency score to **0.8** regardless of publication date. Tag these with `[SEMINAL]` in `scored_papers.md`.

Criteria for `[SEMINAL]`: paper must meet at least two of:
- Introduced a method, framework, or term still in active use
- Citation count >500 (absolute)
- Referenced in >3 other papers already in the corpus

## Formula

```
score = (relevance * 0.6) + (citation_signal * 0.2) + (recency * 0.2)
```

## Grade Thresholds

| Grade | Score Range | Action |
|-------|------------|--------|
| **A** | >= 0.7 | Download PDF. Include in deep-reader queue. |
| **B** | >= 0.4, < 0.7 | Download if open-access. Note key findings only. |
| **C** | < 0.4 | Log in scored_papers.md but do not download. |

## Entry Format for `scored_papers.md`

Use this format for each paper entry:

```markdown
### Author2024 — Title
- **Authors:** Last, F.; Last, F.; ...
- **Year:** 2024
- **DOI:** 10.xxxx/xxxxx
- **Grade:** A
- **Relevance:** 0.8 — [1-sentence justification]
- **Citation Signal:** 0.6 — [citation count, venue context]
- **Recency:** 1.0 — [publication date context]
- **Score:** 0.72
- **Tags:** [SEMINAL] *(only if override applied)*
- **Reason:** [1-sentence summary of why this paper matters for the project]
```
