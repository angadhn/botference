# ARIA APC2 — AI Scientist Framing (Planning Room Notes)

Source: planning-room discussion between Angadh, Claude, and Codex.
RFP: https://aria.org.uk/media/ltnnjubg/activation-partners-cohort-2_rfp.pdf
Deadline: **21 May 2026, 14:00 BST** (clarification deadline 14 May 2026).

## TL;DR

Don't pitch ralPhD as a paper-writing loop. The paper writer is the **scientific
audit / output layer**. The real architecture under Botference + ralPhD is
closer to an **auditable, human-gated AI Scientist for ARIA Creators**:

`literature intake -> gap finding -> adversarial hypothesis generation ->
synthesis -> simulation/analysis -> critique -> citable write-up`

ARIA APC2 explicitly calls out "AI Scientists, autonomous reasoning systems,
and AI tools for hypothesis generation, data analysis, and design of
experiments" — so the framing fits the call.

## What already exists in the codebase

- **Botference** — multi-LLM planning rooms (council + caucus), structured
  handoffs, implementation-plan / checkpoint workflow, per-agent skills.
  Caucus = multi-model adversarial reasoning + decision convergence.
- **ralPhD** — specialised research agents with per-agent tool registries
  (ghuntley pattern), a human-gated loop, citation/claim-oriented checks,
  and journal/figure compliance tooling.
  - `scout`, `triage`, `deep-reader` — corpus + evidence ingestion
  - `critic`, `provocateur` — blind spots, contradictions, inverted
    assumptions, cross-domain bridges
  - `synthesizer` — merges evidence into coherent candidate directions
  - `research-coder` — already has **simulation** + **analysis** modes,
    not just figure generation
  - `paper-writer`, `editor`, `coherence-reviewer` — the audit / output layer
- **Provenance** — checkpoint.md, HUMAN_REVIEW_NEEDED.md, per-agent tools,
  citation verification — this is the trust differentiator vs autonomous-
  scientist hype.

## How to position the first test

The first test can be the literature-review-to-paper pipeline, but it should
be framed as the **validation harness**, not the final product. It tests
whether the system can read, reason, cite, critique, and produce an auditable
scientific argument before being trusted to propose new experiments.

## Missing pieces for a credible AI Scientist bid

1. **Hypothesis proposer** — generalise `provocateur` + `synthesizer` into a
   first-class agent emitting ranked, falsifiable hypotheses with novelty,
   feasibility, expected evidence, and failure modes.
2. **Experiment designer** — new agent that turns a hypothesis into a
   simulation or experimental protocol: variables, controls, expected
   outputs, success / failure criteria.
3. **Domain simulator integration** — `research-coder` can run code, but the
   bid needs **one lighthouse domain** where simulation is real, not
   abstract.
4. **Evaluator** — score outputs against novelty, feasibility,
   falsifiability, evidence support, and expert review.
5. **Provenance layer** — lean hard on citations, claim verification,
   checkpointing, human review gates, reproducible scripts.

## Phased pilot pitch

- **Phase 0 (works today)** — literature-to-auditable-paper loop on one
  ARIA-relevant domain.
- **Phase 1** — hypothesis generation + adversarial ranking.
- **Phase 2** — experiment / simulation design.
- **Phase 3** — closed-loop simulation/analysis with human review at every
  decision gate.

Suggested success metrics:

- expert-rated novelty, usefulness, and falsifiability of hypotheses
- percentage of claims traceable to verified sources
- number of hypotheses converted into executable simulations/analyses
- reproducibility of generated scripts and figures
- time saved for the Creator / PI compared with their normal workflow

## Key bid sentence

> Most AI Scientist systems optimise for autonomy; we optimise for
> trustworthy acceleration: every hypothesis, claim, simulation, and
> conclusion is traceable, critic-reviewed, and human-gated.

## Hard blockers before applying

1. **Pick one lighthouse scientific domain** (an ARIA opportunity space).
   Without this, the bid stays platform ambition rather than a deployment
   plan.
2. **Recruit at least one credible scientist / Creator** willing to be the
   lighthouse user inside the 9-day window.
3. **Delivery wrapper** — UK entity or UK lead partner, named delivery team,
   evidence the system works on real scientific workflows.
4. **Novelty story vs Sakana AI Scientist, Coscientist, FunSearch, ChemCrow**
   — reviewers will know all of these. Defensible angle is *human-gated,
   multi-model, fully auditable, journal-grade output* — not autonomy.

## Application options ranked

1. **Phased direct bid** — credible only if blockers 1-3 are solved this
   week. Pitch as an Activation Partner pilot with hard go/no-go milestones,
   not as a mature platform rollout. Budget should match the delivery wrapper:
   modest if it is Angadh + lighthouse collaborators, larger only with a
   credible UK partner/team.
2. **Embedded subcontractor in another applicant's bid** — Botference +
   ralPhD as "AI in Science" specialist services inside a larger Activation
   Partner bid. Realistic only with an existing relationship to a likely
   applicant.
3. **One-pager to ARIA Programme Directors** instead of a bid — forfeits
   APC2, builds the relationship for APC3 / direct PI engagements. Lowest
   cost, honest about today's TRL.

## Open question

Which ARIA opportunity space (and which Creator / PI) do you want to bind
to? Everything else in the bid is downstream of that choice.
