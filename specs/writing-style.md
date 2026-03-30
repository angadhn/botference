# Writing Style Guide — Scientific Integrity and Anti-LLM-Speak

> This document is mandatory reading for every writing-phase agent. The `check_language.py` script enforces a subset of these rules programmatically.

## Part I: Scientific Writing Standards

These rules encode principles from Mensh & Kording (PLOS Comp. Bio. 2017), Boutron et al. (spin bias taxonomy), PNAS editorial policies, and Rapoport's rules for scholarly criticism.

### 1. Substantiate every claim

No floating claims. Every paragraph that makes factual assertions needs at least one `\cite{}`. If you did not measure it, cannot cite it, or cannot derive it from your results, do not assert it.

Verify that each citation actually says what you claim it says. 9.3% of citations in biomedical literature contain inaccuracies; 9.5% completely misrepresent the cited source (OncoDaily analysis, 2024). A citation that misrepresents the source is a research integrity violation, not merely a writing error.

### 2. Calibrate claim strength to evidence

Match modal verb strength to evidence level:

| Evidence level | Language |
|---|---|
| Established result, directly shown by data | "demonstrates," "shows," "establishes" |
| Inference from partial evidence | "suggests," "indicates," "appears to," "is consistent with" |
| Speculation / low certainty | "may," "might," "could," "it is possible that" |

Do not open a claim with a strong assertion ("we demonstrate") and close it with weak hedging ("might possibly"). Be internally consistent.

Avoid double hedging ("it might be suggested that it is possible that...") — choose one hedging device per claim.

### 3. Do not overreach about implications

The five spin strategies to avoid (Boutron et al., Catalog of Bias):

1. **Selective reporting** — highlighting only significant secondary outcomes while downplaying non-significant primary ones.
2. **False subgroup focus** — basing conclusions on post-hoc subgroup analyses not pre-specified.
3. **Claiming equivalence falsely** — treating a non-significant result as evidence of no difference.
4. **Linguistic spin** — using emphatic words ("groundbreaking," "novel," "crucial," "unprecedented") not warranted by evidence.
5. **Unsupported extrapolation** — extending conclusions to populations, settings, or mechanisms not studied.

**The superlative test:** If your abstract or title contains words like "groundbreaking," "unprecedented," "first-ever," or "transformative," ask whether a skeptical reviewer reading only your Methods and Results would accept that word. If not, cut it.

**The abstract-body consistency test:** Read your abstract conclusions alongside your Results. If the abstract is stronger in tone than what the Results show, that is spin.

### 4. Do not underplay others' contributions

Before criticizing prior work, apply Rapoport's Rules (via Dennett):

1. Re-express the prior work's argument so clearly and fairly that its authors would say "thanks, I wish I'd put it that way."
2. List any points of agreement.
3. Acknowledge what you learned from it.
4. Only then offer a rebuttal.

Give credit generously. The introduction should identify a specific gap in knowledge — not a failure or error by prior authors — and show how your work addresses it (Mensh & Kording, Rule 6).

Cite conflicting evidence. Search the literature for publications reporting findings that conflict with your conclusions and engage with them, rather than citing only supportive sources.

### 5. Balanced presentation

- **One central contribution.** Papers that simultaneously claim multiple contributions tend to be less convincing about each. Focus on one central claim and make it well-supported (Mensh & Kording, Rule 1).
- **Discussion must include limitations.** Explain how the gap was filled, the limitations of the interpretation, caveats, and alternative explanations for your findings (Mensh & Kording, Rule 8).
- **Conclusions must be directly supported by presented results.** If your data show a modest effect, you cannot claim to have solved the problem.

---

## Part II: Anti-LLM-Speak Rules

LLM-generated academic writing fails not because of individual word choices but because of **structural predictability**: uniform sentence length, templated paragraphs, claims floating without sources, mechanical balanced clauses, and stock framings substituting for domain-specific vocabulary.

### 6. Vary sentence length

Mix short sentences (8–12 words) with longer ones (25–35 words). Standard deviation of word counts across sentences in a paragraph should be high.

### 7. No balanced antithetical clauses

Do not repeat "While X, Y" or "Although X, Y" more than twice per section. Vary the connective structure.

### 8. Use domain-specific technical vocabulary

<!-- PROJECT-SPECIFIC: Replace these examples with terms from your field. -->
Replace vague language ("harsh conditions", "significant advantages") with precise technical terms and quantities from your domain.

### 9. No stock framings

| Stock framing | What to do instead |
|---|---|
| "In recent years, there has been growing interest in..." | State the specific development that created the interest |
| "It is well known that..." | Cite the specific paper that established this |
| "This represents a promising avenue for..." | State what specifically was demonstrated and what remains |
| "Further research is needed to..." | State the specific open problem and why existing approaches fail |
| "plays a crucial role in..." | Describe the specific mechanism |
| "has attracted significant attention" | Cite the 2-3 papers that represent this attention |
| "offers a compelling alternative" | Quantify the advantage |
| "remains an active area of research" | Name the specific open problems |

### 10. Ground comparisons in numbers

Replace "significantly lighter" with mass ratios. Replace "much smaller" with volume fractions. Every comparison should include at least one quantitative figure with a citation.

### 11. Equations where they clarify

Use equations for defining quantities that words make ambiguous, expressing scaling relationships, and comparing approaches quantitatively.

---

## Per-Paragraph Checklist

For each paragraph or claim block, verify:

1. Is every factual claim either derived from your own reported data, or followed by a citation?
2. Does the cited source actually say what you attribute to it?
3. Is the modal strength of your language calibrated to the strength of your evidence?
4. Have you stated limitations and alternative interpretations (especially in the Discussion)?
5. Have you avoided the five spin strategies?
6. Before criticizing prior work, have you stated what it did correctly (Rapoport)?
7. Does your abstract match the actual strength of your Results?
8. Have you removed all superlatives that a skeptical reviewer would not accept from your data alone?
9. Would the authors of the prior work you cite recognize and accept your characterization of their contributions?

## What `check_language.py` Enforces

The script flags:
1. **Paragraphs with zero inline citations** — every paragraph that makes factual claims needs at least one `\cite{}`
2. **Low sentence length variance** — standard deviation of word counts across sentences must exceed a threshold
3. **Stock framing patterns** — regex matching for known LLM structural patterns
4. **Citation-free generalizations** — sentences starting with "It is well known", "There has been growing", etc.
5. **Excessive balanced clauses** — "While X, Y" or "Although X, Y" appearing more than twice per section

## Sources

- Mensh & Kording, "Ten Simple Rules for Structuring Papers," PLOS Comp. Bio. (2017)
- Boutron et al., Spin Bias — Catalog of Bias
- PNAS Editorial Policies
- Rapoport's Rules, via Daniel Dennett
- Cochrane, "Writing Tips for PhD Students"
- "Bold Claims and Lost Nuances: The Disappearance of Hedging in Scientific Writing," OncoDaily (2024)
- "Effective Use of Hedging in Scientific Manuscripts," PMC (2023)
