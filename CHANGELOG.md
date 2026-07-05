# CHANGELOG

## 2026-07-06

- **Built-in `review-doc` skill.** Both bots now discover a skill for
  rendering review documents (implementation plans, proposals) as
  self-contained HTML with Google-Docs-style margin commenting and
  feedback export — highlight, comment, export, hand the feedback file
  back to the council. Vendored under `.claude/skills/` and
  `.agents/skills/` like `grill-me`.

## 2026-07-05

- **Chat lifecycle commands.** `/new [title]` starts a fresh chat in place
  (previous chat stays saved and resumable; project context is kept).
  `/file` opens a project picker to file the current chat (alias
  `/add-to-project`; `/file <project-id>` for direct hits). `/delete`
  opens a picker of recent chats — always with a confirm step — cleans the
  project index, and deleting the current chat rolls into a fresh one.
  `/help` is regrouped around the lifecycle.
- **No more empty-session litter.** Sessions are created lazily: a chat
  only hits disk on its first message (or `/rename`, or opening a
  project). On launch, day-old zero-transcript session files are swept
  automatically. Also fixed: launching botference from *inside* a state
  directory (e.g. `cd botference && botference plan`) used to silently
  start a second session store at `<state>/work/sessions` — a path guard
  now keeps a state dir from nesting another store.
- **`/adopt` works under `--claude-interactive`.** The tmux pane now
  launches as `claude --resume <adopted chat>`, so botference steers a
  real, attachable Claude Code session resumed from your past chat —
  watch it live with `tmux attach`. (The programmatic transport remains
  the more robust path; the interactive mirror is still experimental.)
- **`/adopt` — bring an existing Claude Code chat into the council.** Lists
  recent native `claude` sessions for the current folder in the arrow-key
  picker (or `/adopt <id-prefix>` directly). The chosen chat becomes the
  room's Claude session with its full native context; Claude receives the
  room protocol and writes a handoff summary into the shared transcript, so
  Codex late-joins already briefed. Failed adoptions roll back cleanly.

## 2026-07-04

- **Steadier Codex context meter.** The status line previously showed
  Codex's raw last-turn input delta, which spiked on tool-heavy turns
  (each internal API call re-sends the full context) and dropped on short
  ones — hence the oscillation. `codex exec --json` exposes no native
  occupancy event, so the adapter now estimates occupancy: a tool-free
  turn's delta is the exact full prompt (verified against codex-cli
  0.142) and overwrites the estimate — including downward, so
  auto-compaction shows honestly — while tool turns contribute
  `delta / (tool_calls + 1)` as an approximate sample. The first Codex
  turn now shows a reading instead of "unavailable", and yield-pressure
  warnings use the same, more faithful number.

- **Free-form is now the only planning mode.** The `--free-form` flag is gone
  from the launcher, `lib/config.sh`, the Ink UI, and the bridge; the room
  footer/handoff protocol is always active. Turn-based behavior survives as
  the degenerate case: a reply with no footer handoff and no @mention simply
  returns the floor to you. Budgets, preemption, and the conciseness nudge
  are unchanged.
- **Projects panel polish.** Session rows show a compact relative age
  (`5m`, `3h`, `2d`) and are strictly sorted newest-first; the currently
  open chat is marked `▸ … · open` in bold. With the panel focused, typing
  filters projects and chats by title (shown in the panel header; Esc or
  Backspace edits it, `/` still starts a slash command, and the filter
  clears when you Tab away or open a row).
- **/draft now runs through the free-form room flow.** Draft, review, revise,
  finalize, and checkpoint turns stream live in the council like any other
  turn. The reviewer ends each review with the room footer: `converged`
  skips the revision (sign-off), `blocked` / `next: "@user"` saves the
  comments and pauses the draft for your input, and typing mid-draft pauses
  at the next round boundary. The deterministic file writes are unchanged —
  `implementation-plan.md`, per-round reviewer comments, and `/finalize`'s
  `checkpoint.md` — and any stray footer a model appends is stripped before
  the file is written.
- **The caucus is retired.** `/caucus`, the caucus pane, prompts, and
  `RoomMode.CAUCUS` are removed — the bots debate in the open council via
  free-form handoffs instead, and the council pane is now full-width next to
  the Projects panel. The caucus writer vote lives on in the room footer: an
  optional `writer: "@claude"|"@codex"` field; when both bots vote for the
  same writer the lead is set automatically (manual `/lead` always wins,
  votes persist across resume). Old sessions restore fine — their
  `caucus_history` display log is dropped, transcript summaries are kept,
  and legacy caucus footers are still stripped from the display.

## 2026-07-02

- **Free-form mode (`--free-form`)**: bots may hand each other the floor in
  the council via a JSON room footer (`next: "@claude"|"@codex"|"@user"`) or a
  prose @mention, recursively, until they hand back to the user. Bot-to-bot
  threads are budgeted (6 turns / ~8K output tokens, one automatic extension),
  the countdown is shown to the models each turn, oversized turns get a
  conciseness nudge, and typing mid-thread pauses it at the next turn
  boundary. Budget exhaustion pauses the thread and returns the floor — reply
  "continue" to resume. Turn-based behavior is unchanged without the flag.
- **Removed the Textual (Python) TUI and legacy Ink backend.** The Ink TUI is
  now the only frontend; `--textual`, `--ink-legacy`, and `--ink-v2` flags are
  gone. Shared UI dataclasses moved from `botference_ui.py` to
  `core/ui_types.py`. Ctrl+Y native terminal selection now works in the main
  Ink UI. The `textual` dependency was dropped from `requirements.txt`.
- **Project filing**: the first message of an Inbox chat now opens an
  arrow-key picker in the Ink UI (matched projects / new project from chat /
  stay in Inbox; Esc dismisses) via a new `choice_request`/`choice_response`
  bridge protocol; new `/project assign [<session-id-prefix>] <project-id>` files the
  current or any saved chat under a project via `session-index.json` without
  switching the active context. Resuming an old chat under `--free-form` now
  injects a one-time protocol note so pre-existing model sessions learn the
  footer handoff.
- **Smoother streaming**: the Ink bridge now coalesces streaming text deltas
  and flushes every ~70ms, cutting per-chunk re-renders by an order of
  magnitude while keeping typing visibly live.
