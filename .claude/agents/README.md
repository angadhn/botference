> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

# Agents — Planner's Menu

Fourteen agents forming the Botference loop. Each reads `checkpoint.md`, produces outputs, updates checkpoint, and yields.
All agents inherit shared protocol from `agent-base.md`.

Custom workspace agents (in project `.claude/agents/`) override framework agents of the same name and declare their tools in a `## Tools` section.

## Agent Reference

| Agent | Role | Tools (beyond essentials) | Upstream → | → Downstream | Assign when… |
|---|---|---|---|---|---|
| scout | Search + score papers | pdf_metadata, citation_lookup/verify/verify_all, citation_manifest/download, validate_paper_ledger, render_paper_ledger_markdown, validate_support_requests | user/planner | triage | Starting literature search or filling gaps |
| triage | Dedup corpus, resolve grade conflicts, generate reading plan | pdf_metadata, citation_verify_all, validate_paper_ledger, render_paper_ledger_markdown | scout | deep-reader | After scout completes a round |
| deep-reader | Read PDFs, extract claims/data, map sections | pdf_metadata, extract_figure, validate_paper_ledger, render_paper_ledger_markdown, validate_support_requests | triage | critic, provocateur, synthesizer | After triage produces a reading plan |
| critic | Assess structure; check style/journal/figure compliance; propose figures | check_language, check_journal, check_figure, check_claims, citation_verify_all | deep-reader (survey), paper-writer (STYLE-CHECK), editor (compliance) | provocateur, synthesizer (survey); paper-writer (STYLE-CHECK); research-coder (FIGURE-PROPOSAL) | After deep-reader finishes, or after each paper-writer section |
| provocateur | Stress-test: negative space, inverted assumptions, cross-domain bridges | — | deep-reader + critic | synthesizer | After critic's survey assessment |
| synthesizer | Merge findings into synthesis narrative + outline | citation_lint, citation_verify_all | deep-reader + critic + provocateur | paper-writer | After all analysis agents complete |
| paper-writer | Write/revise sections; review editor changes | check_language, citation_lint, validate_support_requests | synthesizer (write), critic (revise), editor (REVIEW-EDITS) | critic (STYLE-CHECK), editor | When outline is ready or revisions approved |
| editor | Substantiated edits to .tex with evidence backing | check_claims, check_language, citation_lint, citation_verify_all | paper-writer | coherence-reviewer, paper-writer (REVIEW-EDITS) | After paper-writer completes a section |
| coherence-reviewer | Post-editing: promise-delivery, terminology, contradictions, novelty claims | check_claims, check_language | editor | editor (fixes) | After all sections are edited |
| research-coder | Analysis scripts, simulations, figures from data | — | critic (FIGURE-PROPOSAL), planner | figure-stylist (figures), paper-writer (data) | When figures proposed or data analysis needed |
| figure-stylist | Visual clarity + print readiness review | check_figure | research-coder | research-coder (revise) or next phase | After each figure is generated |
| coder | Read, modify, and test application code | — | planner | planner (task complete) | When implementation tasks require source code changes |
| refactorer | Restructure code to reduce duplication | — | planner | planner (task complete) | When task says "refactor" |
| orchestrator | AI-driven dispatch at phase boundaries | read_file, list_files | planner | parallel/serial agents | When Architecture is `orchestrated` |

## Typical flow

```
scout → triage → deep-reader → critic → provocateur → synthesizer
  → paper-writer → critic (STYLE-CHECK) → editor → coherence-reviewer
  → paper-writer (REVIEW-EDITS) → research-coder (figures) → figure-stylist
```

## Architecture modes

| Mode | Flag | How it works |
|------|------|--------------|
| serial | `--serial` (default) | One agent at a time, deterministic |
| parallel | `--parallel` | Phases marked `(parallel)` run concurrently in git worktrees |
| orchestrated | `--orchestrated` | AI orchestrator decides dispatch strategy per phase (can batch, adapt, split) |

## Adding a new agent

1. Copy `agent-template.md` and fill in each section
2. Target **60 lines or fewer** — offload verbose templates to `specs/`
3. Agent inherits `agent-base.md` for yield/commit/checkpoint protocol
4. If structured output, add `specs/<agent>-output-format.md` and `templates/` if needed
5. Declare tools in the `## Tools` section of your agent `.md` file — `botference_agent.py` parses it automatically. Only add to `tools/__init__.py` `AGENT_TOOLS` for framework agents.

## The `inputs/` directory

User-provided context that agents read but never write:

| File type | Example | Used by |
|-----------|---------|---------|
| Reviewer feedback | `reviews-round1.pdf` | editor, paper-writer |
| Prior submissions | `v1-submitted.pdf` | editor, coherence-reviewer |
| Venue guidelines | `icml2025-style-guide.pdf` | editor, paper-writer |
| Style files | `neurips_2025.sty` | paper-writer |
| Supplementary notes | `advisor-notes.md` | all agents |

Only humans populate `inputs/`. Created by `scripts/init-project.sh`.
