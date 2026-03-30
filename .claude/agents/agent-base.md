# Agent Base — Shared Protocol

All agents inherit these rules. Agent-specific prompts override when they conflict.

## Path Resolution

botference may run as an engine on a separate project repo. Two roots exist:

- **BOTFERENCE_HOME** (framework): contains `specs/`, `templates/`, `scripts/`, `tools/`, and built-in `.claude/agents/`
- **Working directory** (project): contains `work/` (thread state), `build/` (generated outputs), `sections/`, `figures/`, `corpus/`, `references/`, `papers/`
- **Agent files** resolve workspace-first: `.claude/agents/{name}.md` is checked in the project directory before BOTFERENCE_HOME. Custom agents in the workspace override built-in agents of the same name.

When a "Path Context" section is present at the top of this prompt, use its BOTFERENCE_HOME path to prefix framework file reads (e.g., `specs/writing-style.md` → `$BOTFERENCE_HOME/specs/writing-style.md`). Project files are always relative to the working directory.

When no Path Context is present, BOTFERENCE_HOME equals the working directory — all paths resolve as-is.

## Budget and Yield

- Before each major step, read `$BOTFERENCE_RUN/budget-info` (BOTFERENCE_RUN defaults to `./run`). Follow its recommendation: PROCEED, CAUTION (finish current step only), or YIELD (save state and exit).
- Before each major step, check `$BOTFERENCE_RUN/yield`. If it exists, update `checkpoint.md` and exit immediately.

## Incremental Commit

After each major step, commit all modified output files immediately (`git add <outputs> && git commit`). This caps work loss to one step if the process dies.

## Checkpoint Discipline

- Read `checkpoint.md` first — it determines your task and mode.
- Write `checkpoint.md` last — update Knowledge State and set Next Task for the next agent.
- Before exiting (normal or yield): always commit your critical deliverable + `checkpoint.md`.

## Parallel Execution

When running as part of a parallel phase, the environment variable `PARALLEL_TASK_IDX` is set to a unique integer identifying this agent's task slot. If `PARALLEL_TASK_IDX` is set, namespace output files with it to avoid collisions with other parallel agents writing to the same canonical paths.

## Read-Only Inputs

Agents produce outputs in their designated directories. Never modify another agent's output files or the user's source data.

## Commit Gates

Every agent prompt lists commit gates. Verify all gates pass before the final commit. If a gate fails, fix it or document why it was skipped.
