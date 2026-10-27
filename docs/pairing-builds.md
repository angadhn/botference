# Pairing builds: long-running, two-bot code work in the council

Status: design agreed in chat on 2026-10-27, implementation delegated to an Opus agent. This page is the spec it works from and the record of why.

## The ask, in one paragraph

Run the council inside a code repo, with no new commands to remember, and let Claude and Codex build something big together, for as long as it takes, the way auto mode works in Claude Code or Codex. The two should take turns sensibly: one builds, the other reviews, and the roles follow each model's strengths. Tests must not balloon. The write grant should be asked once, not every session. And `botference` on its own should open the room, with no `plan` word.

## What already exists and is reused

Most of the machinery is in place. The design adds rules on top rather than new engines.

- **Summoned builders.** A bot in the room ends a reply with a `summon:` line and a fresh agent is started in the project with that brief. The default builder is Claude Code on Opus 5.5, with no time cap. `context-budgets.json` can give Codex's summons a Codex builder instead. The room bots never build; they spec and judge.
- **Bot-to-bot threads.** After your message, the bots can hand each other the floor through a JSON footer until one hands back to you. A thread is capped at 6 turns plus one extension.
- **Write roots.** The bots and the builders may only write inside the roots listed under `write_roots.plan` in the project's `botference/project.json`. A bot that wants more triggers an allow or deny prompt in the terminal, and an allow lasts for the session.
- **Verification turn.** When a thread converges, the other bot gets one turn to check the final claims against the sources.

## The design

### 1. A build thread runs until the build is done

There is no command for this. The bots decide from what you say. When you ask for something to be built, the bots spec it and one of them marks its footer `"build": "building"`. From that turn the thread is a build thread and the normal caps are lifted:

- No turn cap and no output-token cap. The thread ends when a bot's footer says `converged` with `"build": "done"`, when a bot says `blocked`, when you type anything, or when the wall-clock budget runs out. The default wall-clock budget is 8 hours, set by `BOTFERENCE_BUILD_HOURS` or `"build_hours"` in `botference/project.json`.
- The summon budget inside a build thread is one summon per bot per turn, as now, but it resets every turn rather than every user message. That is what lets a thread hold many builds in sequence.
- Every tenth turn, or when a bot's context passes 60 percent, the controller runs the existing relay with a structured handoff for that bot. The room does not stop for it.
- The footer gains one optional field, `"build": "specifying" | "building" | "reviewing" | "done"`, so the status line can show where the thread is. `done` is accepted only when the last builder report in the thread succeeded and the project's test command, if `botference/project.json` names one under `"test"`, exited zero. If either is false, the controller tells the bots and the thread continues.
- The protocol tells the bots to ask you before entering a build thread when the brief is thin, using the existing `blocked` and `@user` mechanism, and to say in one line that they are starting a long build when they do. A thread with no `build` field keeps the existing 6 plus 3 caps. Nothing changes for conversations.

Models: the room bots stay on Fable 5.1 and GPT-6 Astra, which is where the specification and the argument happen. Builders are Opus 5.5 for Claude's summons and Astra for Codex's summons. Both are the current defaults, so no config change is needed for a fresh checkout.

### 2. Roles by strength, review in both directions

The summon brief gets a kind tag, in the style of the existing `[imagegen]` tag:

| Tag | Builder | Use for |
|---|---|---|
| `[ui]` | Claude Code on Opus 5.5 | Anything a person sees: layout, styling, copy, terminal UI, web pages, charts |
| `[logic]` | Codex on GPT-6 Astra | Behaviour: controller code, adapters, parsing, protocols, shell |
| none | The summoner's own default, as today | Mixed or unclear work |

The tag decides the builder regardless of which bot summoned. This is how the two subscriptions share the load: UI work goes to Anthropic, logic to OpenAI, and the room bots can be told to balance when a task could go either way.

The review rule is in the free-form protocol for build threads:

- The bot that summoned a builder does not judge its own report. The footer must hand to the other bot with `"build": "reviewing"`.
- The reviewer reads the diff with `git diff`, runs the tests, and reports in at most ten lines what is wrong, what is missing and what is good. Then it either summons a fix with the same tag or marks the task done and moves to the next one.
- Detail review is where Astra is strongest, so Codex is the default reviewer for `[ui]` builds and Claude for `[logic]` builds. This falls out of the rule above with no extra code.

### 3. Tests stay proportionate

Both the free-form protocol for build threads and the builder prompt carry the same short rule:

> Write a test only for behaviour that is a stated contract or that you just saw fail. One test per behaviour, no snapshot tests, no tests of the framework, no tests that restate the implementation. If a change needs more than three new tests, say why in your report.

The reviewer is asked to count new tests against that rule and flag overreach as a defect, the same as a bug. This is a prompt rule, not a hard cap, because a hard cap would block the rare legitimate case.

### 4. One permanent write grant

The terminal prompt gets a third choice: `Allow always`. Choosing it writes the directory into `write_roots.plan` and `write_roots.build` in `botference/project.json`, creating the file if needed, and grants it for the session as now. From then on that root is in the base roots on every launch, so the prompt never comes back for it. `Allow once` and `Deny` keep their current meaning. The same keys apply: Y allows once, A allows always, N denies.

For a repo being used to build itself, the natural first answer is `Allow always` on the repo root. The `.git` folder stays unwritable whatever is granted, as now.

### 5. `botference` opens the room

With no mode word, `botference` now behaves as `botference plan` did: the Ink terminal room with both bots. The build loop that used to be the default moves behind its word, `botference build`, which it already accepts, and `botference -p` with no word still means the headless build loop, so scripts and CI do not change. A bare number as the only argument used to mean build iterations and is now an error that points at `botference build N`.

Docs to update together, as the project rules require: README usage block, `/help` text in `core/botference.py`, the man page, and the changelog.

## What is deliberately not in this round

- No two bots editing at once. One builder runs at a time per thread. Parallel builders would need worktrees and merge handling, and the review loop above gets most of the value without them.
- No automatic commits. The bots may commit when you ask in the brief. The build thread itself never commits or pushes.
- No change to the browser plugin or the Discuss companion. This is council only.

## Files the implementation touches

- `core/botference.py`: `_run_free_form_thread` and the budget constants near it, `_maybe_summon_for_bot`, `_run_summon`, the `/help` table if any wording changes, the `Allow always` path in `request_write_permission`.
- `core/room_prompts.py`: a build-thread variant of `free_form_protocol`, the footer schema with the `build` field.
- `core/summon.py`: `builder_task` learns `[ui]` and `[logic]`, `builder_spec` routes on them, `builder_prompt` carries the test rule.
- `core/cli_adapters.py`: a helper that appends a root to `write_roots` in `project.json`.
- `core/botference_ink_bridge.py` and `ink-ui/src/App.tsx`: the third prompt choice and its key.
- `lib/config.sh` and `botference`: default mode.
- Tests in `tests/test_botference.py`, `tests/test_summon.py`, `tests/test_room_prompts.py`, `tests/test_command_help.py`, `tests/test_cli_adapters.py`, and `ink-ui` tests for the prompt.
- Docs: README, man page, CHANGELOG.
