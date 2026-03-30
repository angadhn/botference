# Coherence Reviewer Output Format

## coherence_review.md structure

One report per coherence review iteration. Covers the full manuscript.

```markdown
# Coherence Review

**Date:** YYYY-MM-DD
**Sections reviewed:** [list of section files in document order]
**Overall verdict:** [COHERENT / ISSUES FOUND (N issues, M critical)]

## Check 1: Promise–Delivery Alignment

### Promises (from introduction)
1. [Quoted or paraphrased promise] — Section: [intro section file]
2. [Quoted or paraphrased promise] — Section: [intro section file]

### Delivery Status
| # | Promise | Delivered in | Status | Notes |
|---|---------|-------------|--------|-------|
| 1 | [promise] | [section file, or "NOT FOUND"] | ✅ Delivered / ⚠️ Partial / ❌ Missing | [details] |
| 2 | [promise] | [section file, or "NOT FOUND"] | ✅ / ⚠️ / ❌ | [details] |

### Unforeshadowed Results
- [Result in section X that has no corresponding promise in the introduction]

### Issues
- **[SEVERITY]** [description] — *Sections:* [affected sections] — *Suggested fix:* [action]

## Check 2: Terminology Consistency

### Term Registry
| Term | Definition/First Use | Sections Used | Variants Found |
|------|---------------------|---------------|----------------|
| [term] | [section file, line ~N] | [list] | [inconsistent variants, if any] |

### Acronym Registry
| Acronym | Expansion | Defined in | Used without definition in |
|---------|-----------|-----------|---------------------------|
| [acronym] | [expansion] | [section] | [sections, if any] |

### Issues
- **[SEVERITY]** [description] — *Sections:* [affected sections] — *Suggested fix:* [action]

## Check 3: Internal Contradictions

### Flagged Contradictions
1. **[SEVERITY]** [description]
   - *Claim A:* "[quoted text]" — Section: [file], line ~N
   - *Claim B:* "[quoted text]" — Section: [file], line ~N
   - *Nature:* [numerical disagreement / directional conflict / hedging mismatch / scope conflict]
   - *Suggested resolution:* [which claim to revise and how]

### Editor Change Conflicts
- [Any contradictions introduced by recent editor changes, referencing change_log.md]

### Issues
- (listed inline above)

## Check 4: Novelty Claims vs Related Work

### Novelty Claims Found
| # | Claim | Section | Exact Phrasing | Ledger Support |
|---|-------|---------|----------------|----------------|
| 1 | [claim] | [section file] | "[quoted text]" | [supported / weak / missing] |

### Related Work Cross-Check
| # | Novelty Claim | Potentially Overlapping Prior Work | Overlap Assessment |
|---|---------------|-----------------------------------|-------------------|
| 1 | [claim] | [cited work in related work section] | [no overlap / partial overlap / significant overlap] |

### Issues
- **[SEVERITY]** [description] — *Sections:* [affected sections] — *Suggested fix:* [action]

## Tool Diagnostics

### check_claims
- [Summary of flags across all sections: N unsupported claims, M low-confidence, K stale entries]

### check_language
- [Summary of terminology-related flags across all sections]

## Summary

| Check | Issues | Critical | Moderate | Minor |
|-------|--------|----------|----------|-------|
| Promise–Delivery | N | n | n | n |
| Terminology | N | n | n | n |
| Contradictions | N | n | n | n |
| Novelty Claims | N | n | n | n |
| **Total** | **N** | **n** | **n** | **n** |
```

## Severity levels

Every issue must be tagged with exactly one severity:

| Severity | Tag | Meaning | Action |
|----------|-----|---------|--------|
| Critical | `**[CRITICAL]**` | Factual contradiction, undelivered core promise, false novelty claim | Must fix before submission |
| Moderate | `**[MODERATE]**` | Terminology drift that could confuse readers, partial promise delivery, hedging inconsistency | Should fix; editor can address |
| Minor | `**[MINOR]**` | Cosmetic inconsistency, acronym re-expansion, stylistic synonym variation | Fix if convenient; low priority |

## File locations

```
AI-generated-outputs/<thread>/coherence-review/
└── coherence_review.md     # Overwrites each iteration
```

The full review history is preserved in git commits.

## Verdict logic

- **COHERENT:** Zero critical issues AND zero moderate issues
- **ISSUES FOUND:** Any critical or moderate issues present. Report count and breakdown.

## Commit gates (checked before final commit)

- [ ] All four checks are present (even if "No issues found")
- [ ] Every issue has a severity tag (`[CRITICAL]`, `[MODERATE]`, or `[MINOR]`)
- [ ] Every issue includes section references (file paths)
- [ ] Every contradiction includes quoted text from both sides
- [ ] Every novelty claim includes the exact phrasing from the manuscript
- [ ] Summary table counts match the issues listed in each section
- [ ] Overall verdict matches the severity breakdown (COHERENT only if zero critical + zero moderate)
- [ ] No .tex files were modified

## Partial report (yield scenario)

If the coherence reviewer must yield before completing all four checks, the report should include:

```markdown
# Coherence Review (PARTIAL)

**Checks completed:** [list]
**Checks remaining:** [list]
**Reason for partial:** [yield signal / context limit]

[completed check sections as above]
```

The checkpoint should note which checks were completed so the next iteration can resume.
