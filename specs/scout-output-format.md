# Scout Output Format

## summary.md structure (~30-40 lines)

**Corpus-building mode:**
1. **Overview** (3-4 sentences): What this search covered, key themes found
2. **Key findings** (5-8 bullets): Most important discoveries, each with a citation
3. **Coverage gaps** (3-5 bullets): What's missing from the literature
4. **Cross-links** (2-3 bullets): Connections across themes

**Gap-fill mode:**
1. **Overview** (3-4 sentences): What gaps were searched, key papers found
2. **Key findings** (5-8 bullets): Most important discoveries, each with a citation
3. **Coverage gaps** (3-5 bullets): What's still missing from the literature
4. **Relevance** (2-3 bullets): How these papers address the identified gap

## scored_papers.md format

Follow `specs/grading-rubric.md` entry format exactly. Each paper entry includes:

```markdown
### Author2024 — Title
- **Score:** 0.72 (A)
- **Relevance (0.6):** [1-sentence justification]
- **Citation signal (0.2):** [citation count + venue quality]
- **Recency (0.2):** [year, field pace context]
- **Tags:** [SEMINAL] (if applicable)
- **DOI:** 10.xxxx/xxxxx
- **Key contribution:** [1-2 sentences]
```

## report.bib format

Every entry MUST include a `doi` field if one was found during lookup.
Format: `doi = {10.xxxx/xxxxx}` (no URL prefix, just the DOI string).
Entries without a verified DOI should include `note = {DOI not found}`.
