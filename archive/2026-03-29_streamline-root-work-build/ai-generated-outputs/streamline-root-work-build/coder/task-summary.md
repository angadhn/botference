# Task 8 Summary — Final Post-Move Verification

**Task:** Run full post-move verification, including legacy-thread migration behavior, archive flatness, and the `ai-generated-outputs` symlink case.

## Verification Results

All checks passed:

| Check | Result |
|-------|--------|
| Test suite (223 tests) | PASS |
| Shell syntax (`council`, `lib/*.sh`, `scripts/*.sh`) | PASS |
| `council --help` end-to-end | PASS |
| `work/` contains all thread files | PASS |
| `build/` contains AI-generated-outputs, logs, run | PASS |
| No stale root-level thread files | PASS |
| `.gitignore` covers `build/` and `work/iteration_count` | PASS |
| Archive entries are flat (no `work/` or `build/` nesting) | PASS |
| Archive script uses centralized path vars | PASS |
| Archive template restore targets `work/` | PASS |
| Migration shim: legacy root fallback (no `work/` dir) | PASS |
| Migration shim: new layout (with `work/` dir) | PASS |
| Symlink case documented and handled in archive.sh | PASS |
| Preamble emits explicit `work/` and `build/` paths | PASS |
| Prompts reference the File Layout contract | PASS |
| No hardcoded root-relative paths in shell code | PASS |
| Python code reads centralized env vars | PASS |
| README structure section is accurate | PASS |

## Specific Outcomes Verified

1. **Active thread files under `work/`:** checkpoint.md, implementation-plan.md, inbox.md, HUMAN_REVIEW_NEEDED.md, iteration_count all live in `work/`.
2. **Generated artifacts under `build/`:** AI-generated-outputs/, logs/, run/ all under `build/`.
3. **Archive reads from new locations:** archive.sh uses `$COUNCIL_CHECKPOINT_FILE`, `$COUNCIL_PLAN_FILE`, `$COUNCIL_AI_OUTPUTS_DIR` — all resolved via `init_council_paths()`.
4. **Archive output remains flat:** Existing archives contain files directly (no `work/` or `build/` subdirectories).
5. **Legacy migration shim works:** Without `work/` directory, paths fall back to project root. With `work/`, paths point to `work/`.
6. **Symlink case:** Archive script notes symlink transparency; `[ -d ... ]` and `mv` resolve through symlinks.
7. **Claude-agent contract:** Preamble in `lib/exec.sh` emits File Layout section mapping bare names to `work/` and `build/`.

## No Code Changes

This was a verification-only task. No source files were modified.
