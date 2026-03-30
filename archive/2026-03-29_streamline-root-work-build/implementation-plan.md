# Implementation Plan — streamline-root-work-build

**Thread:** streamline-root-work-build
**Created:** 2026-03-29
**Architecture:** serial
**Autonomy:** autopilot

## Tasks

- [x] 1. Add bootstrap-safe path initialization in `council` and define the canonical path model — **coder**
- [x] 2. Introduce centralized framework/project path variables and derived file paths, with migration shims and no visible layout change yet (depends: 1) — **coder**
- [x] 3. Replace hardcoded shell and Python paths to use the centralized path model while keeping current behavior intact (depends: 2) — **coder**
- [x] 4. Update the Claude-agent path contract in the preamble and prompts for Phase 1 fallback behavior, while keeping agent docs on bare logical names for now (depends: 3) — **coder**
- [x] 5. Verify Phase 1 end-to-end with no file moves: `plan`, `research-plan`, `build`, and `archive` must still work (depends: 4) — **coder**

<!-- gate -->

- [x] 6. Atomically create `work/` and `build/`, move active thread files and generated/runtime artifacts, and update archive/reset behavior to use the new locations (depends: 5) — **coder**
- [x] 7. Update prompts, Claude agent docs, tests, README, and `.gitignore` for the Phase 2 layout; simplify the path contract from fallback mode to explicit `work/` and `build/` paths (depends: 6) — **coder**
- [x] 8. Run full post-move verification, including legacy-thread migration behavior, archive flatness, and the `ai-generated-outputs` symlink case (depends: 7) — **coder**

## Goal

Reduce root-level clutter and make the repository easier to navigate for both humans and LLMs by separating:

- active working state
- generated/runtime artifacts
- framework guidance
- source code

This thread covers the `work/` + `build/` refactor and the supporting path abstraction required to make it safe.

This thread does **not** move source directories into `src/`. That is a separate follow-on refactor.

## Locked Decisions

- `council` stays at the repository root.
- `work/` will hold active thread files:
  - `implementation-plan.md`
  - `checkpoint.md`
  - `inbox.md`
  - `HUMAN_REVIEW_NEEDED.md`
  - `iteration_count`
- `build/` will hold generated and runtime artifacts:
  - `AI-generated-outputs/`
  - `logs/`
  - `run/`
- `build/` is fully gitignored in this refactor.
- `archive/` stays at the root and archive contents remain flat.
- `specs/` stays physically in place for now.
- `prompts/` and `templates/` stay at the root for now.
- Source directories (`core/`, `lib/`, `tools/`, `scripts/`, `ink-ui/`, `tests/`) stay where they are in this thread.
- The eventual `src/` consolidation is a separate future thread.
- Renaming the application to `botference` is a separate future refactor.

## Canonical Path Model

### Framework-owned paths

These remain anchored on `COUNCIL_HOME`.

- `COUNCIL_HOME`
- `COUNCIL_SPECS_DIR="$COUNCIL_HOME/specs"`
- `COUNCIL_PROMPTS_DIR="$COUNCIL_HOME/prompts"`
- `COUNCIL_TEMPLATES_DIR="$COUNCIL_HOME/templates"`

### Project-owned paths

These are anchored on the project working directory, not `COUNCIL_HOME`.

- `COUNCIL_PROJECT_ROOT="$(pwd -P)"`
- `COUNCIL_PROJECT_SPECS_DIR="$COUNCIL_PROJECT_ROOT/specs"`
- `COUNCIL_WORK_DIR`
- `COUNCIL_BUILD_DIR`
- `COUNCIL_ARCHIVE_DIR="$COUNCIL_PROJECT_ROOT/archive"`

### Derived paths

Define and use derived paths instead of repeating string concatenation throughout the codebase.

- `COUNCIL_PLAN_FILE`
- `COUNCIL_CHECKPOINT_FILE`
- `COUNCIL_INBOX_FILE`
- `COUNCIL_REVIEW_FILE`
- `COUNCIL_COUNTER_FILE`
- `COUNCIL_AI_OUTPUTS_DIR`
- `COUNCIL_LOGS_DIR`
- `COUNCIL_RUN_DIR`

### Migration shim behavior

Phase 1 must support in-flight threads.

Working files:

- if `"$COUNCIL_PROJECT_ROOT/work"` exists, use it
- otherwise fall back to `"$COUNCIL_PROJECT_ROOT"`

Build files:

- if `"$COUNCIL_PROJECT_ROOT/build"` exists, use it
- otherwise fall back to `"$COUNCIL_PROJECT_ROOT"`

This compatibility layer exists only to make the transition safe. It should be removable after the repo fully migrates.

## Why This Path Model Exists

The repo already distinguishes framework files from project files when `COUNCIL_HOME != CWD`.

That distinction must be preserved.

- framework guidance belongs with the framework
- active thread state, project-specific specs, generated outputs, and archives belong with the project workspace

This keeps the current monolith case working while preserving a clean split-layout model in the future.

## Target Layout After This Thread

```text
.ralph/
├── council
├── README.md
├── core/
├── lib/
├── tools/
├── scripts/
├── ink-ui/
├── tests/
├── specs/
├── prompts/
├── templates/
├── work/
├── build/
├── archive/
├── context-budgets.json
├── requirements.txt
└── CHANGELOG.md
```

This is not the final end-state for the repo, but it is the intended Phase 2 state for this thread.

The key improvement is semantic separation:

- `work/` = active thread state
- `build/` = generated/runtime artifacts
- root no longer mixes those with source and framework files

## Phase 1 Details

### Task 1. Add bootstrap-safe path initialization in `council`

`council` has one unavoidable bootstrap responsibility: it must find the loader before any abstraction exists.

Requirements:

- keep a small intentional hardcoded bootstrap at the top of `council`
- compute `COUNCIL_HOME` and `COUNCIL_PROJECT_ROOT` before loading the rest of the system
- do not rely on future `src/` assumptions in this thread
- update early bare references in `council` itself, including:
  - plan path resolution
  - `run/` initialization
  - any root-relative references that occur before helper functions take over

### Task 2. Introduce centralized variables and derived file paths

Requirements:

- define the canonical variables listed above in the central config loader
- use absolute project-root-based paths, not `./work` or `./build`
- keep `COUNCIL_SPECS_DIR` and `COUNCIL_PROJECT_SPECS_DIR` logically separate even though they currently point at the same physical directory in the monolith case
- ensure the shim supports legacy root-level threads

### Task 3. Replace hardcoded paths in code

Scope includes:

- `council`
- `lib/*.sh`
- `scripts/archive.sh`
- `core/*.py`
- `tools/*.py`
- evaluation helpers
- monitoring/helpers that read or write plan/checkpoint/log/output files

Requirements:

- remove bare references to:
  - `implementation-plan.md`
  - `checkpoint.md`
  - `inbox.md`
  - `HUMAN_REVIEW_NEEDED.md`
  - `iteration_count`
  - `AI-generated-outputs/`
  - `logs/`
  - `run/`
- switch all of them to the centralized path model
- keep behavior unchanged before files move

### Task 4. Update the Claude-agent path contract for Phase 1

This is the linchpin of the refactor.

In Phase 1:

- the agent preamble must explain conditional path resolution
- agent docs should continue using bare logical names such as:
  - `checkpoint.md`
  - `implementation-plan.md`
  - `inbox.md`

The preamble should instruct agents:

- if `work/` exists, thread files are under `work/`
- otherwise they are still at project root
- generated outputs are under `build/` if it exists, otherwise root legacy locations apply

Do **not** switch agent docs to explicit `work/...` paths in Phase 1, because the directories do not exist yet and the config shim does not help the model when it directly reads paths.

Scope includes:

- preamble/resolver text in the agent execution flow
- `prompts/plan.md`
- `prompts/build.md`

### Task 5. Verify Phase 1 before any physical move

Must verify:

- `./council plan`
- `./council research-plan`
- `./council build`
- `./council archive`

Acceptance criteria:

- no files have moved yet
- all commands still work
- path abstraction is in place
- Claude-agent guidance is correct for fallback mode

## Phase 2 Details

### Atomicity rule

Tasks 6 and 7 are a single physical migration phase and should not be merged partially.

There must not be a repo state where:

- prompts assume `work/` exists but files are still at root
- archive writes to `work/` but reset logic still targets root
- `build/` is partially introduced while logs/run/outputs remain split across locations

### Task 6. Atomically create `work/` and `build/` and move files

Move into `work/`:

- `implementation-plan.md`
- `checkpoint.md`
- `inbox.md`
- `HUMAN_REVIEW_NEEDED.md`
- `iteration_count`

Move into `build/`:

- `AI-generated-outputs/`
- `logs/`
- `run/`

Requirements:

- update template reset logic to restore blank working files into `work/`
- update archive collection logic to read from `work/` and `build/`
- keep archive output flat
- handle the existing `ai-generated-outputs` symlink mode safely
- clean up stale root artifacts such as root `__pycache__/` if present

### Task 7. Update docs, prompts, agents, tests, and ignores for the new layout

After `work/` and `build/` exist, simplify the contract.

Requirements:

- update the preamble from fallback mode to explicit `work/` / `build/` paths
- update Claude agent docs from bare logical names to explicit paths if that is now preferred by the final contract
- keep prompt text and agent docs consistent with the preamble
- add a concise `Structure` section near the top of `README.md`
- fully gitignore `build/`
- remove obsolete ignore entries made redundant by `build/`
- update tests and fixtures that assumed root-level files

The README structure section should clearly explain:

- `council`
- `specs/`
- `work/`
- `build/`
- `archive/`
- the still-root-level source/framework directories in this thread

## Verification And Completion

### Task 8. Final verification

Verify all of the following:

- `./council plan`
- `./council research-plan`
- `./council build`
- `./council archive`

Verify specific outcomes:

- active thread files are created and updated under `work/`
- generated artifacts land under `build/`
- archive reads from the new locations
- archive output remains flat
- legacy in-flight threads are still recoverable via the migration shim during transition
- the `ai-generated-outputs` symlink case works
- Claude-agent workflows in research-plan mode still function correctly

## Risks And Mitigations

### Risk: `council` bootstrap breaks
Mitigation:
Keep one intentional bootstrap path in `council` and move all other path logic behind centralized config.

### Risk: hardcoded path references remain hidden
Mitigation:
Do a systematic audit in shell and Python before moving files.

### Risk: Claude agents read or write the wrong location
Mitigation:
Treat the agent path contract as a first-class migration task. Phase 1 uses fallback rules; Phase 2 switches to the final explicit layout.

### Risk: in-flight threads are stranded
Mitigation:
Use the `work/` and `build/` migration shims during the transition.

### Risk: archive behavior regresses
Mitigation:
Update archive collection/reset as part of the atomic move and explicitly verify flat archive output.

### Risk: symlinked `ai-generated-outputs` breaks
Mitigation:
Handle the symlink case explicitly during the `build/` migration and test it in final verification.

### Risk: `specs/` still mixes framework and project-specific content
Mitigation:
Keep the physical layout unchanged in this thread, but preserve the logical separation via `COUNCIL_SPECS_DIR` and `COUNCIL_PROJECT_SPECS_DIR`.

## Out Of Scope In This Thread

These are intentionally deferred:

- moving source directories under `src/`
- physically splitting framework specs from project-specific specs
- moving `prompts/` and `templates/`
- renaming the project to `botference`

## Follow-On Thread After This One

After this thread stabilizes, open a separate implementation thread for `src/` consolidation.

That future thread will handle:

- `core/`
- `lib/`
- `tools/`
- `scripts/`
- `ink-ui/`
- `tests/`

That work is larger and riskier because it changes shell sourcing, Python imports, test paths, and UI/build assumptions. It should not be bundled into this thread.

## Completion Criteria

This thread is complete when all of the following are true:

- centralized framework/project path variables exist
- migration shims are in place for the transition
- `work/` and `build/` are the live locations
- `build/` is fully gitignored
- archive reads from the new layout and writes flat archives
- all four top-level modes still work
- Claude-agent workflows still work in research-plan mode
- README explains the structure clearly
- tests and smoke checks pass
