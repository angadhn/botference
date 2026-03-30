# Editor Change Log — README.md

**Section:** README.md
**Date:** 2026-03-29
**Pre-edit check_language issues:** 3
**Post-edit check_language issues:** 3

## Changes

1. **[Line ~8–11]** Quick Start: replaced 2 `plan` examples with 4 examples showing `plan`, `plan --claude`, `research-plan`, and `research-plan --claude` — *Reason:* implementation-plan task 4 requires showing both commands; matches `show_help` examples in `lib/config.sh`
2. **[Line ~8–9]** Quick Start comments: changed "Plan with Claude + Codex (default)" to "Freeform planning room (Claude + Codex)" and "Plan with Claude only" to "Freeform planning (Claude only)" — *Reason:* align with the new semantics where `plan` is freeform, not the structured planner
3. **[Line ~33]** Modes: rewrote Plan mode description from "Interactive session to produce an implementation plan" to "Freeform planning room that may write `implementation-plan.md` and `checkpoint.md` but does not inject structured prompts or system instructions" — *Reason:* implementation-plan decision that bare `plan` keeps room scaffolding but omits `PROMPT_FILE` and `PLAN_SYSTEM`
4. **[Line ~35]** Modes: added new Research-plan mode paragraph describing `./council research-plan` as structured planning with `prompts/plan.md` and `.claude/agents/plan.md` — *Reason:* implementation-plan task 4 requires documenting the new command; matches `show_help` in `lib/config.sh`

## Unresolved Concerns

- All 3 check_language errors are citation_density false positives (README is documentation, not an academic manuscript). No action needed.
