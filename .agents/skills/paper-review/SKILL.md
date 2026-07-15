---
name: paper-review
description: Rework/extend a project's review/ site (LaTeX→HTML with margin comments) into the generic, multi-user, Google-Docs-style botference review system. Use when the user asks to rework the review site, make it generic/multi-user, apply "the paper-review skill", or run a review round over reader comments.
---

# paper-review — generic document review with bot participation

You (Claude or Codex in a botference room) are upgrading an existing
`review/` prototype — like the one in
`projects/ActaAstonautica_Collision_Paper/review/` — into the generic
system specified in `design.md` next to this file. **Read `design.md`
first**; this file is the work order and the contract. The prototype's
build/server/UI code is the starting point: generalize it in place,
don't rewrite from zero.

## Scope for the current rework (P1 + P2 of design.md)

Build these, testable at every step against the live paper:

1. **Config, not constants.** All paper-specific values move to
   `review/review.config.json`:

   ```json
   {
     "slug": "acta-collision",
     "format": "latex",
     "main": "AsciNanjangud_Acta.tex",
     "sections": [{ "file": "tex/Introduction.tex", "title": "1. Introduction" }],
     "bib": ["TN.bib"],
     "abbreviations": "abbreviations.tex",
     "todo_macros": { "todoSimone": "Simone", "todoAngadh": "Angadh", "todo": "unknown" },
     "figures_dir": "Figures",
     "port": 4177
   }
   ```

   `build.mjs`, `server.mjs`, and the UI read this. `abbreviations` and
   `todo_macros` are optional. `format: "markdown"` renders md sections
   via pandoc with the same UI (keep the renderer pluggable). After the
   rework, the engine files must contain **zero** strings specific to
   this paper — that is the test that they can later be lifted into
   botference-main unchanged.

2. **Per-user comments, git-identified (multi-human collab).**
   - Each human's comments/decisions live in
     `review/state/users/<handle>.json` (same shape as today's
     decisions export). Handle = `git config github.user`, falling back
     to a slug of `git config user.name`. The server exposes
     `GET /whoami`; the browser's live mirror writes only *that* file.
   - The UI merges every `users/*.json`: own comments editable, other
     users' read-only, each card labeled with the handle.
   - Git split: everything conversational is **committed** so it travels
     through the repo to collaborators without botference —
     `state/users/*.json`, `state/threads.json`, `suggestions.json`.
     Only runtime files are gitignored: `state/ack.json`,
     `state/summon.json`, live-mirror/journal files, and `site/` (build
     product; collaborators rebuild locally).
   - `review/submit.mjs`: commits (optionally `--push`) the caller's
     own user file, so a collaborator without botference can
     clone → comment in the browser → submit.
   - Acceptance test: simulate a second user (temporary
     `users/student-test.json`), confirm their comments render
     read-only with their handle, and that a `git pull` bringing a new
     user file live-updates the open page.

3. **Bots reply under comments; live page.**
   - Bot replies go in `review/state/threads.json`:
     `{ "<card-or-comment-id>": [{ "author": "claude|codex", "ts": …, "text": …, "suggestion_id": … }] }`.
     Suggestion cards gain optional `reply_to: <comment-id>` so a card
     hangs under the comment thread that prompted it.
   - `review/state/ack.json` (bot-owned): last processed timestamp per
     bot.
   - `server.mjs` adds `GET /data` (all state merged) and `GET /events`
     (SSE). Watch `suggestions.json`, `state/`, and `site/`; on state
     change the browser refetches `/data` and re-renders the margin in
     place; on `site/` change it reloads (rebuild happened). Card ids
     are stable so decisions and threads survive reloads.

4. **Calm UI (hard rules).**
   - No `prompt()` / `alert()` / `confirm()` anywhere — inline
     textareas and popovers only. (Also: browser dialogs freeze
     automation tools.)
   - Creating or editing a comment must never scroll the page.
   - A comment is saved as you type (debounced mirror), with resolved
     comments archived to a "Resolved" list (GDocs-style), never
     deleted by workflow.
   - **Author filter.** The margin fills up fast with multiple humans +
     bots: provide filter chips (one per participant — each human
     handle, each bot, "all") that show only the selected authors'
     comment threads and their replies. Filter state is local to each
     viewer (localStorage), never shared.

5. **Hosted mode (V1.5 — same URL for every collaborator).**
   `server.mjs --hosted`: HTTP basic auth from a `REVIEW_PASSWORD` env
   var, a one-time handle picker per browser (localStorage; that
   browser writes only `users/<that-handle>.json`), rate-limited
   writes. Primary transport: the owner tunnels their running server
   (`cloudflared tunnel --url localhost:<port>`) so a machineless
   collaborator comments on the owner's live page and gets bot replies
   over SSE in real time. See design.md §V1.5 for the optional
   always-on deploy + `review-round.yml` CI round (reply-and-suggest
   only, auth from a repo secret, never a key in the tree, never
   editing paper sources).

## File ownership (never write another writer's file)

| File | Writer |
|---|---|
| `state/users/<handle>.json` | that human's browser (via server) |
| `state/summon.json` | browser 🚩 |
| `suggestions.json` | bots |
| `state/threads.json` | bots |
| `state/ack.json` | bots |
| `site/`, `suggestions.js` | build.mjs only |

## Round protocol (ongoing use, after the rework)

When the user says "read my comments" / "review round" (or
`state/summon.json` is newer than your `ack.json` entry):

1. Read all `users/*.json`, diff against your ack.
2. Reply to each new comment in `threads.json` — length is
   case-by-case, **never more than 6–8 sentences**, no restating the
   comment, no preamble. If a text change is warranted, add a
   suggestion card (`current_text`/`proposed_text`, `reply_to`).
3. Rejected cards get exactly one follow-up (concede or your single
   best counter-argument).
4. **Never edit the paper source during a round.** Source edits happen
   only through the apply flow (design.md §gates), which the user
   triggers explicitly. Apply and commit are separate user decisions.
5. Update `ack.json` last.

## Verification bar

Follow `specs/visual-verification.md` for anything rendered. Do not
declare done until: a full rebuild passes; the browser page shows
merged multi-user comments; an SSE-driven margin update has been
observed end-to-end (write to `threads.json`, watch the open page
change); and the engine files grep clean of paper-specific strings.
