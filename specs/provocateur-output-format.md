# Provocateur Output Format

## provocations.md structure

One report per provocateur iteration. Covers the full research corpus and manuscript (if it exists).

```markdown
# Provocations

**Date:** YYYY-MM-DD
**Thread:** <thread>
**Inputs reviewed:** [list of files read — deep-reader notes, reports, critic review, manuscript sections]
**Provocation count:** N total (Lens 1: n, Lens 2: n, Lens 3: n)

## Claim Inventory

The paper's strongest claims, extracted from deep-reader reports and manuscript:

| # | Claim | Source | Evidence Basis | Strength |
|---|-------|--------|---------------|----------|
| 1 | [claim] | [report/section file] | [what evidence supports it] | Strong / Moderate / Weak |
| 2 | [claim] | [report/section file] | [evidence] | Strong / Moderate / Weak |

*(5–10 claims. This inventory is the raw material for all three lenses.)*

## Lens 1: Negative Space

What is conspicuously absent from the research?

### Provocation 1.1: [Short title]

- **Target:** [specific claim, section, or methodology — with file reference]
- **Gap:** [what is missing — missing control, unaddressed failure mode, excluded population, untested boundary condition, unconsidered alternative explanation]
- **Impact:** [HIGH / MEDIUM / LOW] — [why this matters: would a reviewer flag this? does it threaten validity?]
- **Actionable response:** [what the authors could do — add experiment, add discussion paragraph, add caveat, cite counter-evidence]
- **Evidence:** [what in the corpus prompted this — quote or paraphrase from the sources read]

### Provocation 1.2: [Short title]
*(same structure)*

### Provocation 1.N: [Short title]
*(3–7 provocations per lens)*

## Lens 2: Inverted Assumptions

What if a core assumption is wrong?

### Assumptions Identified

| # | Assumption | Stated or Implicit | Where | Tested? |
|---|-----------|-------------------|-------|---------|
| 1 | [assumption] | Stated / Implicit | [section/report reference] | Yes (how) / No |
| 2 | [assumption] | Stated / Implicit | [reference] | Yes / No |

*(3–5 core assumptions)*

### Provocation 2.1: [Short title — "What if [assumption] is wrong?"]

- **Assumption:** [the assumption being inverted]
- **Inversion:** [what the world looks like if this assumption fails]
- **Consequence severity:** **Fatal** (contribution collapses) / **Significant** (major revision needed) / **Contained** (addressable with a paragraph)
- **Disconfirming evidence:** [what evidence would show the assumption is wrong? does any exist in the corpus?]
- **Actionable response:** [how authors could test, hedge, or explicitly justify the assumption]
- **Evidence:** [what in the corpus prompted this]

### Provocation 2.2: [Short title]
*(same structure, 3–7 provocations)*

## Lens 3: Cross-Domain Bridges

What can other fields teach this research?

### Provocation 3.1: [Short title — "[Source field] → [Target application]"]

- **Target:** [specific claim, method, or gap in the paper]
- **Bridge:** [analogous problem, method, or framework from another field]
- **Analogy strength:** **Strong** (well-documented parallel) / **Suggestive** (plausible but untested) / **[SPECULATIVE]** (worth exploring but ungrounded)
- **Potential import:** [what specifically could be borrowed — a method, a theoretical lens, a dataset, a benchmark]
- **Actionable response:** [what the authors could do — cite the cross-domain work, apply the method, reframe a section]
- **Evidence:** [what in the corpus prompted this connection]

### Provocation 3.2: [Short title]
*(same structure, 3–7 provocations)*

## Priority Ranking

The top 5 provocations across all lenses, ranked by potential impact:

| Rank | ID | Title | Lens | Impact | Why prioritize |
|------|-----|-------|------|--------|---------------|
| 1 | [e.g., 1.3] | [title] | Negative Space | HIGH | [1-sentence reason] |
| 2 | [e.g., 2.1] | [title] | Inverted Assumptions | Fatal | [reason] |
| 3 | [e.g., 3.2] | [title] | Cross-Domain | Strong | [reason] |
| 4 | ... | ... | ... | ... | ... |
| 5 | ... | ... | ... | ... | ... |
```

## Impact levels

### Negative Space (Lens 1)

| Impact | Meaning |
|--------|---------|
| **HIGH** | A reviewer would likely flag this gap; threatens validity or generalizability |
| **MEDIUM** | Worth addressing; strengthens the paper but isn't a fatal omission |
| **LOW** | Nice to have; completeness concern rather than validity concern |

### Inverted Assumptions (Lens 2)

| Consequence | Meaning |
|-------------|---------|
| **Fatal** | If the assumption is wrong, the paper's core contribution collapses |
| **Significant** | Major revision needed — changes the scope or strength of claims |
| **Contained** | Authors could address with a discussion paragraph or sensitivity analysis |

### Cross-Domain Bridges (Lens 3)

| Analogy Strength | Meaning |
|-----------------|---------|
| **Strong** | Well-documented parallel in the literature; high confidence the import would work |
| **Suggestive** | Plausible connection; would need investigation to confirm applicability |
| **[SPECULATIVE]** | Creative connection worth exploring but currently ungrounded; must be labeled `[SPECULATIVE]` |

## File locations

```
AI-generated-outputs/<thread>/provocateur/
└── provocations.md     # Overwrites each iteration
```

The full provocation history is preserved in git commits.

## Commit gates (checked before final commit)

- [ ] All three lenses are present (even if a lens found nothing notable — write "No significant [gaps/inversions/bridges] identified")
- [ ] Claim inventory table is present with 5–10 entries
- [ ] Every provocation includes: target (specific reference), the provocation itself, impact/severity, actionable response, and evidence from sources
- [ ] Provocation count per lens is 3–7 (if more were found, only the top entries are kept; note "N additional lower-priority items omitted")
- [ ] Priority ranking table is present with top 5
- [ ] `[SPECULATIVE]` tag is applied to any ungrounded cross-domain connections
- [ ] No .tex files or other agent outputs were modified
- [ ] `checkpoint.md` Next Task is set appropriately

## Partial report (yield scenario)

If the provocateur must yield before completing all three lenses:

```markdown
# Provocations (PARTIAL)

**Lenses completed:** [list]
**Lenses remaining:** [list]
**Reason for partial:** [yield signal / context limit]

[completed lens sections as above]
```

The checkpoint should note which lenses were completed so the next iteration can resume.
