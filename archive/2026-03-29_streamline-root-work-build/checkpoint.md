# Checkpoint — streamline-root-work-build

**Thread:** streamline-root-work-build
**Last updated:** 2026-03-29
**Last agent:** coder
**Status:** All tasks complete — thread ready to archive

## Knowledge State

| Task | Status | Notes |
|------|--------|-------|
| 1. Bootstrap-safe path initialization | done | `COUNCIL_HOME` and `COUNCIL_PROJECT_ROOT` computed at bootstrap, before lib sourcing |
| 2. Centralized path variables and shims | done | `init_council_paths()` in `lib/config.sh`; migration shims for `work/` and `build/`; `council` calls it |
| 3. Hardcoded path replacement | done | All shell and Python code uses centralized vars; prompt/contract text deferred to Task 4 |
| 4. Phase 1 Claude-agent path contract | done | File layout preamble always emitted; prompts reference the contract; agent docs keep bare names |
| 5. Phase 1 verification | done | All modes verified: syntax, path init, agent detection, prompt assembly, archive parsing, help. No regressions. |
| 6. Atomic `work/` and `build/` migration | done | Files moved; council `--allowedTools` uses dynamic prefix; `.gitignore` updated; compatibility symlinks in place |
| 7. Phase 2 docs/agents/tests update | done | Preambles simplified to explicit paths; README updated; .gitignore cleaned; archive tests use work/build layout |
| 8. Final verification | done | 223 tests pass. Archive flatness confirmed. Migration shim works both ways. Symlink case handled. No stale root files. Preamble and prompts correct. |

## Last Reflection

All 8 tasks complete. The `work/` + `build/` refactor is fully verified and working. The thread is ready to archive.

## Next Task

None — thread complete. Run `./council archive` to archive this thread.
