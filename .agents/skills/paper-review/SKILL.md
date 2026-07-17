---
name: paper-review
description: Set up and run the botference document-review interface (Google-Docs-style comments on rendered LaTeX/Markdown, bots replying in threads, apply/commit of accepted changes) in any repo — and follow the round protocol when the user asks for a review round or tags you from the review page.
---

# paper-review — GDocs-style review of rendered sources, with bots

The engine is built and battle-tested. **Canonical engine:
`$BOTFERENCE_HOME/frontends/review/`** (ships with botference). Architecture, decision history, and the unbuilt roadmap (CI
rounds, cloud version): `design.md` next to this file. This file tells
you how to USE the system.

## Setting up a new project ("set up paper review in <dir>")

**Preferred: `botference review [dir]`** — one command does all of the
below (engine copy, detection via `scripts/review-detect.mjs` with an
echoed summary, gitignore, build, serve; `--share`, `--hosted`,
`--port N`, `--no-agents`, `--upgrade`). Use the manual steps only when
the launcher isn't available:

1. Copy the engine from the reference implementation into
   `<dir>/review/`: `build.mjs`, `server.mjs`, `chat.mjs`, `apply.mjs`,
   `submit.mjs`, `init-config.mjs`, `bridge-system-prompt.md`,
   `SCHEMA.md`, `assets/` (review.js, style.css). Never copy
   `review.config.json`, `state/`, `suggestions.json`, or `site/` —
   those are per-project.
2. Run `node review/init-config.mjs` from `<dir>` (it inspects the
   directory: master file via `\documentclass`, sections via
   `\input`/`\include` order, bib, abbreviations, todo macros, figures
   dir, a free port, and the bridge block). **Show the user what was
   detected and get their confirmation before proceeding** — never
   guess the master file silently.
3. Add the gitignore block (see reference repo): `review/site/` and
   `review/state/*` ignored EXCEPT `state/users/` and
   `state/threads.json`; `suggestions.json` tracked. Conversation must
   travel through the repo; runtime files must not.
4. `node review/build.mjs`, then commit `review/` ("Add review
   interface"). Requires `pandoc` on PATH — check and tell the user if
   missing.

## Running it

> Sync note: the workspace copies of this skill at
> `<vault>/botference/.claude/skills/paper-review/SKILL.md` and
> `<vault>/botference/.agents/skills/paper-review/SKILL.md` are plain
> copies of this file — when you edit it (either copy in botference-main
> or those), update all four.

- `botference review` — build + serve; **agents are on by default when
  the machine can run them** (python3 + a `claude`/`codex` CLI on
  PATH — the launcher prints `agents: on (…)` or an `agents: off`
  explanation). `--no-agents` forces off; `--agents` forces on (clear
  error if impossible).
- `botference review --share` — hosted mode behind a cloudflared quick
  tunnel: respects `REVIEW_PASSWORD` or generates one, prints
  `share this: <url>   password: <pw>`; Ctrl-C stops server + tunnel
  together. Missing cloudflared → install hint, keeps serving locally.
- Manual (no launcher): `node review/server.mjs` — static + comment
  mirror, no bots; `--chat` adds the bot bridge (needs
  `BOTFERENCE_HOME` or the config's `bridge.core_dir`); `--hosted` adds
  `REVIEW_PASSWORD` basic auth, per-browser handle picker, rate limits,
  owner-only summons. The server serves ONLY `review/site/` + the
  figures dir (path-traversal guarded) — keep it that way.
- Collaborator options: the owner's `--share` URL (read + comment;
  their agent summons queue for the owner to release), or clone the
  repo and run the identical `botference review` (agents auto-detected;
  without the CLIs they still read and comment), or plain
  `node review/server.mjs` — then `node review/submit.mjs [--push]`
  (commits only their own `state/users/<handle>.json`).
- The server is long-lived and owned by the human; don't leave your own
  test servers running.

## The interface contract (don't regress these)

- **Comments are the only conversation surface.** No chat panel. All
  discussion lives in margin threads under comments; the sidebar
  presence strip (connection ●, agents on/off, per-agent animated
  "Claude is crystallizing…" in author colors) is the only global
  signal. Interrupts (permissions/choices) render on the card, or as
  sidebar toasts when off-page (120s default-deny).
- **Strict-but-social routing.** `@claude` routes to Claude alone; the
  free-form footer handoff is disabled on review turns. To involve the
  other agent, @-tag it in your thread reply — the server converts
  that into a visible mention turn (depth cap 1 per thread per round).
  `@all` engages both.
- **Mentions fire only on explicit confirm** (Done/Enter), never while
  composing.
- **Every author is visually distinct** (stable accent color; Claude
  coral, Codex blue, humans hashed hues); resolved comments live in a
  reopenable resolved tab; humans can edit/delete their own entries
  (`edited: true` — treat an edited entry newer than your ack as new
  input); author filter chips; light/dark/system theme toggle.
- **Changes widget** (top of sidebar, owner-only) is the commit
  workflow: accept → ⚡ Apply → read → ✓ Commit (or ↩ Revert). Apply is
  deterministic (`apply.mjs`: unique-span replacement, atomic bib
  append, `needs_manual_resolution` on drift — never guessed). Apply
  and commit are always separate actions. Out-of-band source edits
  surface in the widget with a commit action.
- **Calm UI**: no `prompt()`/`alert()`/`confirm()`, no scroll-jumps,
  layout reflows (nothing overlays content), engine files stay 100%
  document-agnostic (all specifics in `review.config.json`).

## File ownership (never write another writer's file)

| File | Writer |
|---|---|
| `state/users/<handle>.json` | that human's browser (via server) |
| `state/summon.json` | browser 🚩 |
| `suggestions.json` | bots |
| `state/threads.json` | bots |
| `state/ack.json` | bots |
| `state/apply.json` | apply.mjs (round ledger) |
| `site/`, `suggestions.js` | build.mjs only |

## Round protocol (when summoned — by tag, 🚩, or "read my comments")

1. Read all `users/*.json`, diff against your `ack.json` entry
   (include entries with `edited:true` newer than your ack).
2. Reply to each new comment in `threads.json` — length case-by-case,
   **never more than 6–8 sentences**, no restating, no preamble. If a
   text change is warranted, add a suggestion card
   (`current_text`/`proposed_text`, `reply_to`) — see SCHEMA.md.
3. Rejected cards get exactly one follow-up (concede or your single
   best counter-argument).
4. **Never edit document sources during a round.** Source changes go
   through the user's Apply/Commit buttons only. Site styling/engine
   fixes the user asks for directly may be made in `review/` files and
   committed with a clear message.
5. Update `ack.json` last (crash mid-round → the round re-triggers).

## Verification bar for any engine change

`node --check` all touched JS; rebuild; confirm served assets updated;
never kill the human's running server (verify on a throwaway port);
grep engine files clean of document-specific strings; if a change
touches document sources, compile the document (e.g. `latexmk -pdf`)
and inspect the output before claiming done.
