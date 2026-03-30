# Synthesizer Output Format

Three files per iteration in `AI-generated-outputs/<thread>/synthesis/`:

| File | Purpose |
|------|---------|
| `synthesis.md` | Prose narrative weaving all findings — themes, conflicts, provocateur responses, story arc |
| `master.bib` | Merged, deduplicated, lint-clean bibliography from all inputs |
| `section_outline.md` | Sections → claims → evidence → citations, with word budgets |

Templates: `templates/synthesizer-synthesis.md`, `templates/synthesizer-section-outline.md`

## Key rules

- Every claim in `synthesis.md` gets an inline source key (Author2024 format).
- Tag conflicts with `[CONFLICT]`: both positions, both citations, resolution status.
- Provocateur integration table: top 5+ provocations with disposition (Addressed / Acknowledged / Out-of-scope). Out-of-scope needs 1-sentence justification.
- 3–7 themes per synthesis. More than 7 → merge.
- `master.bib`: deduplicate by DOI then author+year+title. Annotate each entry with source file. Mark unverifiable DOIs.

## Evidence strength levels

| Strength | Meaning | Manuscript language |
|----------|---------|-------------------|
| **Strong** | Multiple independent sources, converging evidence | "demonstrates," "shows," "establishes" |
| **Moderate** | Single high-quality source, or multiple with caveats | "suggests," "indicates," "provides evidence that" |
| **Weak** | Single source with limitations, or indirect evidence | "may," "could," "preliminary evidence suggests" |

Maps to claim-calibration rules in `specs/writing-style.md`.

## Commit gates

- [ ] `synthesis.md` exists; every factual claim has an inline source key
- [ ] All `[CONFLICT]` tags include both positions with source keys and resolution status
- [ ] Provocateur integration table present (or "No provocations available" with reason)
- [ ] Open questions section present (3+ items, or explicit "None" with reasoning)
- [ ] Story arc section present
- [ ] `master.bib` exists; `citation_lint` passes; no duplicates
- [ ] `citation_verify_all` run on `master.bib` (unverified entries annotated)
- [ ] Every `master.bib` entry has a `doi` field (or `note = {DOI not found}`)
- [ ] `section_outline.md` exists; every section has ≥1 claim and a word budget (or "—")
- [ ] Claim–Evidence Summary table covers all claims
- [ ] No input files modified
- [ ] `checkpoint.md` Next Task set

## Yield priority

If yielding early, produce in this order: (1) `master.bib` (mechanical), (2) `section_outline.md` (structural), (3) `synthesis.md` (context-dependent). Mark partial output with `(PARTIAL)` header.
