# Botference document review — comment-driven chat over rendered sources

**Design · 2026-07-15 · rev 4** — agreed with the user over four review rounds; implement per SKILL.md scope

## Goal

One command from any terminal, in any project — no TUI, no prior
botference chat required:

```
botference review <dir-or-file>   # detect, confirm in chat, build, serve, open
```

- **Conversational scaffold, not flags.** On first run the page opens
  with a bot message in the chat panel: "I found `AsciNanjangud_Acta.tex`
  — it has `\documentclass` and inputs 7 sections, so I think it's the
  master file. Render these for review?" You approve (or correct it) in
  the chat, then it builds. Detection first, your confirmation always.
- The **source** (LaTeX now; Markdown and other pandoc-able formats next)
  renders as commentable HTML. The HTML is a pure build product — never
  edited directly; every change goes source-first, then re-render.
- Comments are yours until you **tag** `@claude`, `@codex`, or `@all`.
  Tagged comments become bot turns; untagged ones accumulate (🚩 batches).
- Bots reply *under* your comments (case-by-case length, ceiling ~6–8
  sentences) and post suggestion cards.
- Bot suggestions render as **tracked changes in the body**, one color
  per agent (insertions tinted, deletions colored strikethrough).
  **Finalize** on a change block = apply + commit for that block;
  Apply/Commit buttons remain for card-level and batch flows.
- Handled comments are **resolved** to a GDocs-style archive tab, out of
  the margin but on the record.

## Human collaborators over GitHub (build early — Acta student)

The source repo is the shared truth — comments ride along in it. Each
human gets a state file, `review/state/users/<github-handle>.json`,
committed and pushed (runtime files stay gitignored). The UI merges every
user file: yours editable, others' read-only, labeled by handle.
Identity: trust the git commit author (decided).

A collaborator **without** bots needs no botference: clone, run
`node review/server.mjs` (static mode, no bridge), comment, and
`review/submit.mjs` commits their comments. You pull → their comments
appear → your bots can reply to them like yours.

## Product track: local-first, cloud-second

What comments 11–12 describe is a product: drag a document in, discuss
it with agents, collaborators join with GitHub. Keep two tiers of the
same codebase:

- **Local (V1, this proposal):** everything above — free, private,
  git-synced. This is what the Acta paper runs on and stays the test bed.
- **Cloud (V2, later):** the same review page deployed and
  GitHub-login-gated per project (collaborator allowlist — "password
  protected" done right). Comments sync through the server instead of
  git pushes. Agents: each collaborator with their own Claude/Codex sub
  connects it and their agents join the room; a **shared project agent**
  (API-key-funded) is the fallback so botless collaborators still get
  bot replies. Drag-and-drop onboarding = the same conversational
  scaffold ("I think this is the master file — render it?"). Plausibly
  paid.

The V1/V2 split costs nothing extra now: the state files and the
comment→turn protocol are identical; only transport (git vs server) and
auth differ. Design V1 so V2 is a deployment, not a rewrite. (Your
project notes already flag that the controller is headless and only the
frontend is replaceable — a web frontend is that same observation.)

## Why it works

- The controller is headless; the Ink TUI is just a JSON-lines client of
  `botference_ink_bridge.py`. The review server is a second frontend: it
  spawns the bridge and resumes your ongoing session, or starts a fresh
  one for a new directory.
- Scaffolding is idempotent and detection-first: existing botference
  traces (a `review/`, project state, old sessions — as in the Acta dir)
  are reused; only missing pieces get created; nothing is overwritten.
- Skills auto-load from `.claude/skills`/`.agents/skills` — bot-side
  protocol ships as a SKILL.md, no core prompt changes.
- Plain-language note on "owns the session": a *session* is the saved
  chat history (a JSON file), not a terminal window. The review server
  runs the bots invisibly — no extra terminal appears. "Owns" just means
  don't open the *same* chat in the TUI and the review page at once;
  close one, open the other, nothing is lost.

## Design rules

1. **Source is canonical; HTML is disposable.** Nobody edits `site/` by
   hand; a change is made once, in the `.tex`/`.md`, and the page follows.
2. **Config, not hardcoding.** `review/review.config.json`: `format`
   (latex | markdown | …, pluggable renderers), main file, sections, bib,
   todo macros, port — written by the conversational scaffold after you
   confirm its detection.
3. **Ownership-partitioned files.** Per-human `users/<handle>.json`
   (committed); bots own `threads.json` / `suggestions.json` / `ack.json`.
   Nobody writes anyone else's file — which is what makes both the git
   merge story and the future cloud sync clean.
4. **Bots write files, server watches.** Tagged comment → turn; bot
   appends replies/cards with its normal tools; server `fs.watch`es →
   SSE → margin updates in ~1s. Sidebar streams the raw turn and includes
   a free-text chat box.
5. **Calm UI.** No scroll-jumps: creating or updating a comment never
   moves your viewport; live updates re-render in place.
6. **Gates before the source changes.** Rounds never touch source →
   you accept → **Apply** ("applied, uncommitted") → you read →
   **Commit** or Revert. **Finalize** on an inline block is the one-click
   shortcut for that block alone.

## Phases (each tested on the live Acta paper)

| Phase | Deliverable |
|---|---|
| P1 | Generic engine (config + renderers) + per-user comment files & merged rendering (git collab from day one) |
| P2 | Bot replies + live SSE margin + resolved tab; `submit.mjs` for botless collaborators |
| P3 | Bridge frontend: conversational scaffold, tagged comments → turns, session resume/fresh, chat panel |
| P4 | Apply / Commit / Revert + per-agent-colored inline tracked changes with Finalize |
| V2 | Cloud deployment: GitHub login, server-synced comments, bring-your-own-sub agents + shared project agent |

Ships in botference-main: engine in `frontends/review/`, protocol in
`.claude/skills/paper-review/SKILL.md`.

## Open questions

1. Format priority after LaTeX — Markdown only, or also docx (pandoc can,
   but round-tripping edits into docx is messier)?
2. Agent colors: fixed palette (Claude = coral, Codex = blue, humans
   auto-assigned) or configurable per project? (I'd fix it — recognition
   beats choice.)
3. Green light to start P1 on the Acta paper, or another doc round
   first?
