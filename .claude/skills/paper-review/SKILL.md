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
   - **Threads are two-way.** Every thread (and every card) must offer
     a reply box to the human viewer — including under bot replies. A
     human reply is written to *their own* `users/<handle>.json` under
     the same card/comment id (a `thread` array of `{ts, text}`); the
     UI renders one merged, chronological thread from all user files +
     `threads.json`. No dead ends: if a bot can say it, a human can
     answer it, and vice versa.
   - **You can always edit your own words.** Every entry a human owns —
     comments, decisions notes, thread replies — is editable and
     deletable in place by that human (and only by them; other users'
     and bots' entries are read-only). Edits update `{ts, edited: true}`
     in their own user file. Bots must treat an edited entry newer than
     their ack as new input.
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
   - **Every author is visually distinct at a glance (user
     2026-07-15).** Each participant gets a stable accent color used
     consistently everywhere they appear: comment-card left border +
     author label, thread entries, filter chip, and (P4) inline
     tracked changes. Claude = coral family, Codex = an equal-weight
     blue, humans = muted distinct hues; colors must read in both
     themes. Cards must not look interchangeable: bot suggestion cards,
     bot replies, and human comments each get a distinct visual
     treatment (badge + accent), while sharing the theme.css baseline
     (spacing, radius, typography) for a polished, non-IDE feel.
   - **Author filter.** The margin fills up fast with multiple humans +
     bots: provide filter chips (one per participant — each human
     handle, each bot, "all") that show only the selected authors'
     comment threads and their replies. Filter state is local to each
     viewer (localStorage), never shared.
   - **Responsive layout.** Resizing the window must reflow, not break:
     no fixed multi-column grid; on narrow viewports the margin rail
     collapses to inline affordances (tap a highlight to open its
     thread) instead of disappearing.
     Re-run card positioning on every resize.
   - **Theming.** Adopt the design tokens in `theme.css` next to this
     file (Anthropic-flavoured: warm paper/near-black, humanist serif
     prose, coral accent, light AND dark via `prefers-color-scheme`) so
     the review site matches the user's other review tooling. Replace
     the prototype's Palatino/#8b0000 stylesheet. Include a **visible
     theme toggle** (light / dark / system) in the sidebar, persisted
     per browser in localStorage — `prefers-color-scheme` is only the
     default, never a cage (user 2026-07-15: "just in this dark mode
     forever" is unacceptable for daytime reading). Implement by
     stamping `data-theme` on the root element with CSS overrides that
     win over the media query in both directions.

5. **Hosted mode (V1.5 — same URL for every collaborator).**
   `server.mjs --hosted`: HTTP basic auth from a `REVIEW_PASSWORD` env
   var, a one-time handle picker per browser (localStorage; that
   browser writes only `users/<that-handle>.json`), rate-limited
   writes. Primary transport: the owner tunnels their running server
   (`cloudflared tunnel --url localhost:<port>`) so a machineless
   collaborator comments on the owner's live page and gets bot replies
   over SSE in real time. On `--hosted` startup, print the ready-to-run
   tunnel command for this project's port (e.g. `cloudflared tunnel
   --url http://localhost:<port>`) so sharing is copy-paste; one
   server+tunnel per project, each with its own URL and password.
   **Hard security requirement (tunnel-exposed):** the server must
   serve *only* `review/site/` and the configured figures dir (keep and
   test the path-traversal guard — reject any resolved path outside
   them), accept POSTs *only* to the state endpoints with size limits,
   never list directories, and never expose paper sources, git, or
   anything else on the machine. A visitor with the URL + password can
   read the rendered paper and comment — nothing more. See design.md §V1.5 for the optional
   always-on deploy + `review-round.yml` CI round (reply-and-suggest
   only, auth from a repo secret, never a key in the tree, never
   editing paper sources).

6. **P3 — no terminal round-trips (green-lit 2026-07-15).** The review
   server becomes a botference frontend so the user never returns to
   the TUI mid-review:
   - `server.mjs --chat` spawns the bridge as a child process:
     `python3 $BOTFERENCE_HOME/core/botference_ink_bridge.py` with the
     workspace as `BOTFERENCE_PROJECT_ROOT` (read
     `core/botference_ink_bridge.py` and `lib/config.sh` in
     `$BOTFERENCE_HOME` first — the protocol is JSON lines: user input
     on stdin, room entries/stream events on stdout; resume the
     existing session via the session store rather than starting cold).
   - A browser comment tagged `@claude` / `@codex` / `@all` (and the
     🚩 batch) is composed into a user turn and written to the bridge's
     stdin; bot output streams into a sidebar chat panel (which also
     gets a free-text box). Bots keep writing `threads.json` /
     `suggestions.json` exactly as in rounds — the SSE path is
     unchanged.
   - **The browser UI half is mandatory, not optional:** detect
     `@claude`/`@codex`/`@all` in a saved comment/reply and POST it to
     `/mention`; render the sidebar chat panel with its free-text box
     (POST `/chatbox`). A server-side `--chat` with no UI wiring is not
     P3 done (this exact gap shipped once: 2026-07-15, the user tagged
     @claude and nothing happened).
   - **Comments are the ONLY conversation surface (user decision
     2026-07-16, supersedes the earlier chat-panel design).** There is
     no chat panel: all discussion — human and bot — happens in margin
     comment threads, Google-Docs style ("we can discuss the paper
     through comments anyway; managing so many conversations becomes
     hard"). The working indicator and streaming reply render inside
     the thread card under the user's comment. Unanchored conversation
     belongs in the botference TUI, not the review page. Raw
     bridge/turn debug text never appears anywhere in the UI.
     that bot alone; the other bot must not take the floor via the
     free-form footer on review turns (bridge-system-prompt rule).
     Only @all engages both.
   - **Mentions fire only on explicit confirm.** A tag becomes a turn
     only when the user saves/confirms the comment (Done/Enter) —
     never on input, change, or paste events. (Shipped bug 2026-07-15:
     pasting text containing @claude summoned the bot mid-composition.)
   - **Ambient presence strip (user 2026-07-16).** A persistent, small
     status element (sidebar or header) always shows: connection state
     (● live / ○ sync failed / ✕ server down), whether chat mode is on,
     and per-agent presence with an animated spinner + botference's
     whimsical verbs ("Claude is crystallizing…", "Codex is
     responding…") in each agent's accent color — visible from
     anywhere on the page even when the active thread is off-screen or
     on another section. Idle agents show as quiet dots, not text.
   - **Visible activity, end to end.** The viewer must always be able
     to tell the invited bot is doing what it was asked: on submit show
     "queued" on that comment; on `turn-start` show a working indicator
     ("Claude is on it…") on the thread *and* in the chat panel; stream
     the turn text live; clear on `turn-end` when the reply lands in
     the thread. Every failure is surfaced in place — a 409 (server not
     in `--chat`), a bridge exit, a rejected mention — never a silent
     no-op. The chat.mjs SSE events (turn-start/stream/turn-end/
     bridge-log/bridge-exit) already carry everything needed.
   - Hard rule: one frontend per session — refuse `--chat` (with a
     clear message) if the TUI currently has the session open, and
     vice versa document that the TUI must not attach while `--chat`
     runs.
   - In `--hosted` mode, only the owner's browser (first authenticated
     handle, or a `?owner` token) may send turns to the bridge;
     collaborators' tagged comments queue for the owner to release —
     bots must not be summonable by non-owners by default.

7. **P4 — Apply / Commit / Revert in the UI (green-lit 2026-07-15).**
   Owner-only buttons (never shown to non-owner handles in hosted mode):
   - Per accepted card and as "Apply all accepted": **Apply** runs
     `apply.mjs` — deterministic unique-span replacement of
     `current_text` in `source_file`, bib entries appended atomically;
     ambiguous/drifted spans flagged `needs_manual_resolution`, never
     guessed. Rebuild follows; the page reloads via SSE and the card
     shows "applied, uncommitted".
   - **Commit** (after the owner has read the applied render) commits
     the round in the paper repo with a message listing applied card
     ids; **Revert** restores the pre-apply state via git. Apply and
     commit are always separate clicks.
   - These buttons drive the same chat/bridge path as P3 (an apply
     turn), so the transcript records every apply/commit/revert.

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
