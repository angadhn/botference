# Task 3 Summary — Remove empty workflow-section headers

## What was changed
`core/council.py:_build_initial_prompt` — conditionally include `--- System Prompt ---` and `--- Task ---` sections only when `self.system_prompt` and `self.task` are non-empty. Previously both headers were always emitted, producing blank framing in freeform `plan` mode.

## Files modified
- `core/council.py` — `_build_initial_prompt` method (5 lines changed)
- `tests/test_council.py` — added `TestInitialPromptSections` class (2 tests)

## Test results
- RED commit: `3935c6e` — `test_build_initial_prompt_omits_empty_system_and_task_blocks` fails as expected
- GREEN commit: `3f4cb4b` — both new tests pass
- Full suite: 83 passed (81 existing + 2 new), 0 failures

## Deviations from plan
None.

---

# Task 5 Summary — Final review (critic)

## Verification results

1. **Syntax check:** `bash -n council lib/config.sh` — PASS (exit 0)
2. **Test suite:** `pytest tests/test_council.py -q` — 83 passed, 0 failures
3. **Stale references:** Found and fixed `lib/README.md` showing `./council -p plan` (now rejected). Fixed in commit `bb2a31a`.
4. **`core/council_ink_bridge.py`:** Confirmed no changes needed — takes `--system-prompt-file` and `--task-file` as arguments, mode-agnostic.
5. **Logging:** `log_interactive_session` at `council:325` passes `$LOOP_MODE` directly, correctly distinguishing `plan` vs `research-plan` in `logs/usage.jsonl`.
6. **Help text:** `lib/config.sh:show_help` correctly documents both modes, examples, and the interactive-only constraint.
7. **README.md:** Properly describes `plan` as freeform and `research-plan` as structured.

## Issues found and resolved
- `lib/README.md` listed `./council -p plan` as a valid example — stale after task 1 made planning modes interactive-only. Fixed.

## No issues remaining
All code paths, documentation, help text, and logging correctly distinguish the two planning modes.
