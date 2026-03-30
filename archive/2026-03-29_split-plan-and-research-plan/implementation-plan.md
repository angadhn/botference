# Implementation Plan — Split Freeform `plan` From Structured `research-plan`

**Thread:** split-plan-and-research-plan
**Created:** 2026-03-29
**Architecture:** serial
**Autonomy:** stage-gates

## Decisions

- `./council plan` becomes the freeform planning room.
- `./council research-plan` becomes the current structured planner and inherits the existing `prompts/plan.md` + `.claude/agents/plan.md` behavior.
- Bare `plan` keeps the council runtime scaffolding: room setup, Codex bridge, context monitor, resume behavior, and permission-restricted plan-file writes.
- Bare `plan` may still write `implementation-plan.md` and `checkpoint.md`.
- No new prompt/runtime files will be added.
- `core/council_ink_bridge.py` is not part of the intended change set unless implementation reveals a real bug.
- Both planning modes continue to use the existing `"plan"` model/budget key; no `context-budgets.json` changes are planned.
- Usage logging must record the actual loop mode (`plan` vs `research-plan`) instead of hard-coding `"plan"`.

## Tasks

- [x] 1. Split CLI planning modes in `lib/config.sh` so `plan` is freeform and `research-plan` preserves the current structured planner, while updating usage/help text and examples (red/green TDD) — **coder**
  RED: `tests/test_council.py::TestPlanningModeRouting::test_parse_loop_args_splits_plan_and_research_plan`: source `lib/config.sh`, run `parse_loop_args plan` and `parse_loop_args research-plan`, assert the first yields `LOOP_MODE=plan`, `PROMPT_FILE=`, `COUNCIL_MODE=true` and the second yields `LOOP_MODE=research-plan`, `PROMPT_FILE=prompts/plan.md`, `COUNCIL_MODE=true`; fails because `research-plan` is not recognized and `plan` still resolves to `prompts/plan.md`.
  GREEN: `lib/config.sh:parse_loop_args` — rename the current `plan)` route to `research-plan)`, add a new `plan)` route with empty `PROMPT_FILE`, and update `show_help` usage/mode/example lines to document both commands precisely.
  VERIFY: `pytest tests/test_council.py -q -k PlanningModeRouting`
  Commits: `test(red): cover plan vs research-plan mode parsing` and `fix(green): split freeform and structured planning modes`

- [x] 2. Refactor `council` so bare `plan` runs without prompt files and `research-plan` keeps the current structured injections — **refactorer**
  Change the top-level prompt-file resolution so `PROMPT_FILE` is only resolved and file-checked when non-empty.
  Expand the interactive-only guard so both `plan` and `research-plan` reject `-p`.
  Widen the planning branch to handle both loop modes.
  In the council-room path, set `PROMPT=""` and `PLAN_SYSTEM=""` for bare `plan`, but keep `PROMPT=$(cat "$PROMPT_FILE")` and `PLAN_SYSTEM="$(cat "${COUNCIL_HOME}/.claude/agents/plan.md")"` for `research-plan`.
  Preserve `inbox.md` absorption in both modes so bare `plan` can start from operator notes without any dispatcher prompt.
  In the solo-Claude path, omit `--append-system-prompt` when `PLAN_SYSTEM` is empty and avoid piping an empty string into `claude`; if `PROMPT` is empty, launch `claude` directly in interactive mode.
  Change interactive usage logging from `"plan"` to `"$LOOP_MODE"`.
  Keep `resolve_model "plan"` / `resolve_model_and_effort ... "plan"` unchanged for both planning modes.

- [x] 3. Remove empty workflow-section headers from the room's initial prompt construction so freeform `plan` starts cleanly without blank `--- System Prompt ---` / `--- Task ---` frames (red/green TDD) — **coder**
  RED: `tests/test_council.py::TestInitialPromptSections::test_build_initial_prompt_omits_empty_system_and_task_blocks`: instantiate `Council` with `system_prompt=""` and `task=""`, call `_build_initial_prompt("claude")`, assert the result includes the room preamble and room history but excludes `--- System Prompt ---` and `--- Task ---`; fails because the current implementation always emits both headers.
  GREEN: `core/council.py:Council._build_initial_prompt` — start `parts` with `room_preamble(name, other)` and only append the `--- System Prompt ---` block when `self.system_prompt` is non-empty and the `--- Task ---` block when `self.task` is non-empty.
  VERIFY: `pytest tests/test_council.py -q -k InitialPromptSections`
  Commits: `test(red): cover empty freeform prompt framing` and `fix(green): omit empty task and system sections`

- [x] 4. Update the top-level documentation so command examples and mode descriptions match the new split between freeform `plan` and structured `research-plan` — **editor**
  Update `README.md` quick-start examples to show `./council plan`, `./council research-plan`, and `./council research-plan --claude`.
  Rewrite the mode descriptions so `plan` is described as a freeform planning room that may still write `implementation-plan.md` and `checkpoint.md`, and `research-plan` is described as the existing structured planning workflow.

- [x] 5. Review the final change set for behavior gaps, wording regressions, and verification coverage before handoff — **critic**
  Confirm there are no remaining references that imply `./council plan` is the structured planner.
  Confirm `core/council_ink_bridge.py` did not need changes and that this remains true after implementation.
  Verify the final behavior with `bash -n council lib/config.sh` and `pytest tests/test_council.py -q`.
  Check that logs now distinguish `plan` from `research-plan`.
