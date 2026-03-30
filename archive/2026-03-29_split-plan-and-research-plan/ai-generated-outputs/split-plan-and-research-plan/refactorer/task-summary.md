# Task 2 Summary — Refactor `council` planning launch flow

## What was changed

**File:** `council` (1 file, 3 commits)

### Commit 1: Conditional prompt-file resolution + expanded interactive guard
- `PROMPT_FILE` resolution (lines 35-41) now wrapped in `if [ -n "$PROMPT_FILE" ]` — skips when empty (bare `plan` sets it to `""`)
- Interactive-only guard (line 26) expanded from `plan` to both `plan` and `research-plan`
- Error message uses `$LOOP_MODE` instead of hardcoded "plan"

### Commit 2: Widen planning branch + differentiate council-room path
- Planning branch condition (line 137) widened: `if [ "$LOOP_MODE" = "plan" ] || [ "$LOOP_MODE" = "research-plan" ]`
- Council-room PROMPT: loaded from file only for `research-plan`; empty string for bare `plan`
- Council-room PLAN_SYSTEM: loaded from `.claude/agents/plan.md` only for `research-plan`; empty for bare `plan`
- Inbox absorption preserved for both modes

### Commit 3: Solo-Claude path differentiation
- Solo-Claude PROMPT: conditional on non-empty `PROMPT_FILE`
- Solo-Claude PLAN_SYSTEM: conditional on `research-plan` mode
- `--append-system-prompt` omitted when PLAN_SYSTEM is empty (via `SYS_ARGS` array)
- Empty PROMPT launches `claude` directly in interactive mode (no pipe)
- Usage logging changed from hardcoded `"plan"` to `"$LOOP_MODE"`
- Status message shows actual `$LOOP_MODE`

## Verification

| Check | Before | After |
|-------|--------|-------|
| `bash -n council` | PASS | PASS |
| `bash -n lib/config.sh` | PASS | PASS |
| `pytest tests/test_council.py -q` | 81 passed | 81 passed |

## Notes

- No behavior changes for `research-plan` — it follows the exact same code path as the old `plan` did.
- `resolve_model "plan"` and `resolve_model_and_effort ... "plan"` kept unchanged for both modes (shared budget key).
- Task 3 will handle the empty `--- System Prompt ---` / `--- Task ---` headers that `council.py` still emits when PLAN_SYSTEM/PROMPT are empty.
