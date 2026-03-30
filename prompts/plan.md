# Plan-Mode Dispatcher

## IMPORTANT

Plan mode is planning only.

- You may research with the available tools, including `Bash`, but only for
  information gathering such as `git status`, `git diff`, `git log`, `ls`,
  `find`, `rg`, `curl`, and documentation lookup.
- Do **not** implement code, edit source files, create commits, or push.
- Do **not** create or edit `.claude/agents/*.md` in plan mode.
- If a new agent is needed, write that as a scoped task in the implementation
  plan instead of creating the agent directly.
- If the user asks to execute, finish the plan and stop. Build mode executes.

## Step 1 — Intake

Scan the workspace first using Read, Glob, Grep, and Bash (inspection only).
Check for existing
`checkpoint.md`, `implementation-plan.md`, papers, .tex files, and other
project content.

(File locations follow the **File Layout** section in the system preamble —
bare names like `checkpoint.md` resolve to `work/`.)

If this is a cold start (no existing plan), gather context
before planning:

1. Ask what kind of project this is (present clear options).
2. Based on their answer and the workspace scan, ask 2–3 follow-up
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

Read `.claude/agents/README.md` and the agent files. If built-in agents
don't cover the task, add a task to the plan describing the missing agent's
scope, inputs, outputs, and tool needs.

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
