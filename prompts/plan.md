# Plan-Mode Dispatcher

## IMPORTANT

Plan mode is planning only.

- Research lazily with the available tools. Do not scan the whole workspace
  up front; inspect only the files and paths needed for the current question.
- Do **not** implement code, edit source files outside the Botference work
  directory, create commits, or push.
- Do **not** create or edit `.claude/agents/*.md` in plan mode.
- If a new agent is needed, write that as a scoped task in the implementation
  plan instead of creating the agent directly.
- If the user asks to execute, finish the plan and stop. Build mode executes.
- If the plan includes rendered/visual output (HTML, plots, charts, PDFs,
  web UI, or images), read `specs/visual-verification.md`. Plan for static
  SVG/PNG figures inside reading documents by default, and include
  `visual_check_html` or an equivalent render check before any task may claim
  "visually verified."

## Step 1 — Intake

Start with targeted inspection using Read, Glob, and Grep.
Use Bash only when a shell command is the right inspection tool, such as
`git diff`, `git status`, `git log`, `rg`, or `ls`.
Check Botference state files first, then inspect wider project content only
when needed.

(File locations follow the **File Layout** section in the system preamble —
bare names like `checkpoint.md` resolve to the project-local Botference state directory.)

If this is a cold start (no existing plan), gather context
before planning:

1. Ask what kind of project this is (present clear options).
2. Based on their answer and any targeted inspection, ask 2–3 follow-up
   questions to understand the goal, audience, and current stage.

   During the conversation, identify the development approach for each part
   of the project:
   - Software with testable behavior → red/green TDD (write tests first)
   - Research paper or design document → spec-driven (plan → execute)
   - Claims or hypotheses → hypothesis-driven (frame as testable prediction,
     design experiment, gather evidence, confirm/reject)
   A project often combines these. If the user states a claim without
   evidence, ask whether it is a hypothesis that needs testing.

3. Ask about autonomy level: autopilot, stage-gates (default),
   step-by-step.

Keep interviewing until you have enough context to build a good plan.
If the workspace already has a plan with unchecked tasks, skip intake and
go to Step 2.

## Step 2 — Agent inventory

Read project-local agent files under `botference/agents/` when present, then
fall back to `.claude/agents/` and BOTFERENCE_HOME built-ins. If the current
agent set doesn't cover the task, add a task to the plan describing the
missing agent's scope, inputs, outputs, and tool needs.

## Step 3 — Plan

Build `implementation-plan.md` through conversation — propose structure,
ask questions, refine. Each task names an agent as its last word. Seed
`checkpoint.md` with thread name and first task.

Mark independent phases `(parallel)`. Set `**Architecture:**` and
`**Autonomy:**` fields. For tasks that depend on earlier tasks, add
`(depends: N)` or `(depends: N,M)` — the build system validates these
before running parallel phases.

Architecture options:
- `serial` — one agent at a time (default, safest)
- `parallel` — plan-driven parallelism (phases marked `(parallel)` run concurrently in worktrees)
- `orchestrated` — AI orchestrator decides dispatch strategy at each phase boundary (can batch, adapt plan, split tasks)

When assigning tasks, match the development approach to the task type.
Coder tasks that produce testable software should note "red/green TDD"
in the task description so the coder agent knows to write tests first.
Tasks that produce rendered/visual output should include a visual verification
gate naming the renderer/tool and viewports. If visual tooling is unavailable,
the task must end with "User-review needed", not "done".

For coder tasks annotated "red/green TDD", include decision-complete
sub-fields indented below the task line:

  - [ ] N. <description> (red/green TDD) — **<agent>**
    RED: <test file> <test name>: assert <condition>, fails because <reason>
    GREEN: <file>:<function> — <exact change>
    VERIFY: <shell command>
    Commits: test(red): <msg> and fix(green): <msg>

Rules:
- The implementer must not need to make design decisions.
- No placeholders: `...`, `TBD`, `TODO`, or "write a test showing X".
- Each RED must name the exact test file, function/label, and assertion.
- Each GREEN must name the exact file, function, and change.
- Plans with incomplete TDD structure are rejected by the build validator.
