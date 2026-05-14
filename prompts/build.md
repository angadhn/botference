# Build-Mode Dispatcher

Study checkpoint.md and implementation-plan.md.
Pick the highest-priority task to do.

(File locations follow the **File Layout** section in the system preamble —
bare names like `checkpoint.md` resolve to the project-local Botference state directory.)

The last word in the task name is the agent.
Read the agent prompt at `botference/agents/{agent}.md` (falls back to
project `.claude/agents/{agent}.md`, then BOTFERENCE_HOME built-ins) and follow its Workflow.

If the task has a mode prefix (STYLE-CHECK critic,
GAP-FILL scout), the agent is still the last word.

One iteration = one agent = one task. Do not start a second task in the same context window. Exit after completing the task so the loop can start a fresh iteration.

IMPORTANT:
- if `$BOTFERENCE_RUN/reflect` exists (BOTFERENCE_RUN defaults to `./run`), read `specs/reflection-template.md` (framework file) and complete the reflection BEFORE starting the task
- if `$BOTFERENCE_RUN/yield` exists, save state to checkpoint.md and exit immediately
- before each major step, check `$BOTFERENCE_RUN/budget-info`. If recommendation is YIELD, update checkpoint.md and exit. If CAUTION, finish current step only.
- after each major step, commit all modified files immediately. Do not wait until the end. If the process dies, only the current step's work is lost.
- after the task, run the agent's commit gates
- update implementation-plan.md when the task is done
- when checks pass, commit all modified files
- update checkpoint.md with what you did and what comes next
- if the task produces rendered/visual output (HTML, plots, charts, PDFs,
  web UI, or images), follow `specs/visual-verification.md`. Use
  `visual_check_html` for HTML outputs when available. Do not report
  "done/fixed/ready" unless the rendered output is visually verified; otherwise
  report "Changed" or "Generated" plus "User-review needed."

## Autonomy Gates

Read the `**Autonomy:**` field in `implementation-plan.md`.

All modes complete ONE task per iteration, then exit. The loop starts a
fresh context window for each task. Autonomy controls only whether human
review gates are created between phases:

- **autopilot** — after completing the task, update checkpoint and exit.
  The loop picks up the next task automatically. No human review gates.
- **stage-gates** — same as autopilot, but if the next task crosses a
  phase boundary (marked with `## Phase` headings or `<!-- gate -->`
  comments in the plan), create `HUMAN_REVIEW_NEEDED.md` with a summary
  of what was completed and what the next phase will do before exiting.
  Write the **next task line** from the implementation plan into
  checkpoint.md's `## Next Task`. The loop pauses for human review.
- **step-by-step** — create `HUMAN_REVIEW_NEEDED.md` after every task.

If the field is missing, default to **stage-gates**.

## Status Reporting

- Start: `>>> Starting: [task name] — [1-sentence description]`
- Steps: `>>> [step description]`
- Done: `>>> Done: [what was accomplished] | Next: [what remains]`
