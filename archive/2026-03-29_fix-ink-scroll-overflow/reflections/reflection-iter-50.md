# Reflection — Iteration 50 — 2026-03-29

## Trajectory: on track

## Working
- Red/green TDD discipline is clean — each task has a failing RED commit followed by a GREEN implementation, with commit hashes recorded.
- Pure helper extraction strategy is paying off: `computeLayoutBudget`, `computeViewportSlice`, and `truncateTitle` are all tested independently in `layout.ts` before wiring into App.
- 9/9 tests passing across 3 tasks. Each helper is well-isolated and deterministic.
- Serial progression through Phase 1 is methodical — no skipped steps.

## Not working
- Nothing blocked. The approach is straightforward and each task builds cleanly on the prior one.

## Next 5 iterations should focus on
1. Task 4: Move `preRenderLines` to `layout.ts` with string-width fix (this iteration)
2. Task 5: Wire all parent-owned dimensions into App/Pane (the big refactor)
3. Task 6: Full regression — TypeScript + layout tests + Python tests
4. Task 7: Auto-scroll policy (Phase 2 begins)
5. Task 8: New messages indicator

Phase 1 is 2 tasks away from completion (tasks 4 and 5), then task 6 is the verification gate. Phase 2 is UX polish.

## Adjustments
None needed. Task 4 is the correct next step — it moves `preRenderLines` and its supporting types/constants to `layout.ts` and fixes the `.length` → `stringWidth` bug, which task 5 depends on for the final wiring.
