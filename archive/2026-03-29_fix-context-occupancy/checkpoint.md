# Checkpoint — fix-context-occupancy

**Thread:** fix-context-occupancy  
**Last updated:** 2026-03-29  
**Last agent:** coder  
**Status:** done

## Knowledge State

| Task | Status | Notes |
|------|--------|-------|
| 1. Capture Claude occupancy from the last assistant event | done | RED 50079e3, GREEN f4e70eb, 49/49 pass |
| 2. Rewrite Claude context % to use occupancy snapshot semantics | done | RED 3e3cf55, GREEN 3682a23, new test passes, 5 old Claude regressions expected to fail (task 3) |
| 3. Update Claude regression expectations to occupancy semantics | done | 5 failing + 1 passing tests updated to use occupancy_tokens; 50/50 pass |
| 4. Add a first-turn over-limit warning for Codex prompt budget | done | RED 94aaefb, GREEN d41dbec, 80/80 council + 50/50 adapter pass |
| 5. Remove `_baseline_tokens` dead code | done | 3 locations removed, 50/50 adapter + 80/80 council pass |
| 6. Update `/help` text to describe occupancy | done | RED 1ff6ba1, GREEN 47ef304, 81/81 council + 50/50 adapter pass |
| 7. Run full regression suite and Ink verification pass | done | 209/209 Python tests pass, Ink tsc clean |

## Last Reflection

Iteration 10 reflection: trajectory complete. All 7 tasks implemented and verified (209/209 pass). Tracking files were out of sync with committed code — restored from HEAD. No further code work needed for this thread.

## Next Task

All tasks complete. Thread finished.
