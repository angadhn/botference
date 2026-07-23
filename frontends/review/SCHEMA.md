# Review site — card & decision schema (v3, generic multi-user engine)

Built per `.claude/skills/paper-review/design.md`, P1+P2 scope. All document-specific values live in `review/review.config.json`; engine files contain no paper-specific strings. Regenerate with `node review/build.mjs` (reads sources; never writes to them).

## Config (`review/review.config.json`)

| key | notes |
|---|---|
| `slug` | short project id; keys browser storage and exports |
| `format` | `latex` · `markdown` — selects the renderer |
| `main` | master file (LaTeX: the `\documentclass` file; paper title is parsed from it each build) |
| `title` | optional masthead override; wins over the `\title{}` parse. When the master has no `\title{}`, detect derives one (markdown H1, else the humanized folder name) so the masthead is never blank — edit it to rename. Set `"title": false` to render no masthead at all |
| `sections` | ordered `[{file, title, split?}]`. A LaTeX file containing **two or more `\section` commands is auto-split at build time** into one page per section (single-file papers): content between `\begin{document}` and the first `\section` becomes an Abstract/Front Matter page, and each chunk is re-wrapped with the preamble so `\newcommand` macros keep working. The split is recomputed from the source every build (nothing stored); set `"split": false` on an entry to opt out |
| `bib` | list of `.bib` files (optional) |
| `abbreviations` | file defining `\newacronym` (optional) |
| `todo_macros` | `{macroName: author}` for legacy `\todo*` extraction (optional) |
| `figures_dirs` | **array** of figure directories, detected from `\graphicspath` and `\includegraphics` arguments; every dir is served (path-guarded) and rewritten in built pages. Back-compat: the legacy `figures_dir` (single string) is still read everywhere — existing configs keep working verbatim |
| `port` | server port (`PORT` env and `--port` override) |
| `legacy_storage_keys` | old browser-storage keys to migrate (optional) |
| `bridge` | bot-bridge block, owned by `init-config.mjs` |

Figure handling at build: every `<img>` src is resolved against the repo root and each figure dir with LaTeX `\graphicspath` semantics, probing `.png/.jpg/.jpeg/.svg/.gif/.webp/.pdf` for extensionless `\includegraphics` refs. PDF-only and missing figures render as labeled placeholders instead of broken images. `tikzpicture` environments (which pandoc drops) are compiled to SVG at build time — `documentclass[tikz]{standalone}` + the paper's preamble minus page-layout packages, via `pdflatex` then `pdftocairo -svg` (or `dvisvgm --pdf`) — cached by content hash under `site/tikz/`; the wrapping figure/caption/label stay with pandoc so global numbering and refs are unaffected, and a compile failure or missing toolchain degrades to a placeholder plus a build warning, never a broken build.

## How to review

- **Live mode (preferred):** `node review/server.mjs`, open <http://localhost:4177>. Identity = `git config github.user` (fallback: slugged `user.name`). Your decisions/comments mirror (one-way, debounced, save-as-you-type) to `review/state/users/<handle>.json` — the only file your browser writes. The UI merges every `users/*.json`: yours editable, others' read-only and labeled with their handle. Bot replies (`state/threads.json`) render threaded under comments; suggestion cards with `reply_to` nest under the comment that prompted them. Live updates ride a WebSocket (`/ws`, primary — proxies/CDN edges such as the `--share` cloudflared tunnel buffer streamed HTTP bodies, so SSE stalls through them) with SSE (`GET /events`) as the fallback; both carry the same JSON events, live-update the margin on state changes, and reload the page on site rebuilds. Agents engage **only** via an explicit `@claude`/`@codex`/`@all` tag — there is no second summoning mechanism (the old 🚩 flag button and `POST /summon` were removed: they wrote a file and notified nobody, while *looking* like they summoned someone).
- **Collaborators without botference:** clone → `node review/server.mjs` → comment in browser → `node review/submit.mjs [--push]` commits their own user file. `state/` is gitignored *except* `state/users/`, which travels through the repo.
- **Hosted auth (`--hosted`/`--share`):** browsers see an in-page password gate (no basic-auth popup) asking for **a name and the password together** — the name is not a credential, it only decides which `users/<handle>.json` the guest writes, and asking for it on the gate is what makes hosted mode work on a phone (the sidebar handle picker lives in a drawer there, so a guest who authenticated first could never pick one and everything they wrote was silently dropped). Correct password sets an HMAC-signed `review_auth` cookie (HttpOnly, SameSite=Lax, Secure behind https, **7-day lifetime**, keyed by the gitignored `state/.auth-secret`) plus a readable `review_handle` cookie carrying the sanitized name, and redirects to the requested page. `who()` prefers the `x-review-handle` header (the sidebar picker can still change it) and falls back to that cookie. Claiming the owner's handle is refused at the gate exactly as it is in `who()` — only the owner token confers ownership. Only GET requests accepting `text/html` get the gate; JSON/SSE/asset requests get plain 401 JSON. curl and other tools may instead send `Authorization: Basic` with **any username** and the password (e.g. `curl -u x:$REVIEW_PASSWORD …`). `POST /auth` shares the per-IP write rate limit.
- **Static mode:** open `site/index.html` via `file://`; Export/Import decisions buttons bridge manually (browser storage is origin-scoped).
- **File ownership:** `users/<handle>.json` = that human (via server), and this is where a human's **suggestions** live too · `suggestions.json` + `threads.json` + `ack.json` = bots · `grants.json` + `grant-usage.json` = the owner/server · `site/` = build.mjs only (disposable, gitignored; canonical UI assets live in tracked `review/assets/` and are copied in at build). Nobody writes another writer's file. **Presence is not a file** — it lives only in server memory (see below).
- **UI rules:** no browser dialogs anywhere; comment creation/editing never scrolls the page; resolve archives to the sidebar "resolved" list, never deletes.

## Suggestion card (`review/suggestions.json`, mirrored into `site/suggestions.js`)

| field | req | notes |
|---|---|---|
| `id` | ✓ | stable, unique; decisions are keyed on it |
| `type` | ✓ | `old-todo` (extracted `\todo*`) · `reference-add` · `rewrite` · `claim-tune` · `alignment` |
| `section` | ✓ | page slug, e.g. `01-introduction` |
| `author` | ✓ | legacy todo-macro authors per config's `todo_macros`; `claude`/`codex` for agents |
| `text` |  | card body when there is no explicit diff |
| `source_file` / `source_label` |  | e.g. `tex/Introduction.tex`, nearest `\label` |
| `anchor_text` |  | short verbatim quote locating the spot in prose |
| `current_text` / `proposed_text` |  | rendered as del/ins diff; `current_text` must be unique in `source_file` (span-anchor apply rule) |
| `rationale` / `evidence` |  | why; evidence may be a list (papers, DOIs) |
| `category` / `priority` |  | badges, e.g. `references`/`high` |
| `bibtex_keys` / `bib_entries` |  | new citation keys + full BibTeX to append to `TN.bib` on accept |
| `apply_notes` |  | anything the applier must know |

## Human suggestions (`state/users/<handle>.json`)

A human — including the owner — can propose text, not only ask a bot to. On highlight the composer offers two modes: **Comment** (unchanged) and **Suggest**. A human suggestion is an entry in that human's *own* user file (`suggestions.json` stays bot-owned) and flows through the identical render/apply paths as a bot card.

| field | req | notes |
|---|---|---|
| `status` | ✓ | literally `user-suggestion` — the entry type |
| `section` / `anchor` / `quote` | ✓ | page slug, block `data-cid`, and the exact selection |
| `current_text` | ✓* | the **unique** source span. \*absent only when `source_json` is used |
| `proposed_text` | ✓ | replacement, in *source* form (a heading proposal is the whole macro) |
| `display_text` / `display_proposed` | | rendered forms, for the inline del/ins — a macro-anchored card shows the words, never the LaTeX |
| `source_file` | | repo-relative source; mutually exclusive with `source_json` |
| `source_json` | | `{file, key}` for a title that lives in `review.config.json` — applied **JSON-aware** (parse → set key → re-serialize), never string-replaced |
| `head` / `tail` | | macro wrapper (`\section{` / `}`), so an edit can rebuild the proposal |
| `comment` | | optional rationale; an `@tag` in it routes like any mention |
| `decision` | | the *viewer's* accept/reject. Bot cards keep using `status`; a human suggestion already occupies `status` with its entry type, so its decision lands here. `acceptedIds()` and the UI read both |

**Unique anchoring happens at COMPOSE time, not apply time.** The composer fetches the real source (`GET /source?file=…`, restricted to configured files plus the config itself), locates the selection, and:

- **ordinary prose** — if the span is ambiguous it is widened word-by-word with surrounding block text until it matches exactly once, and the UI *shows what it locked onto* ("widened past your selection to make it unique");
- **headings** — anchors on the enclosing LaTeX macro (`\section{Introduction}` → `\section{New Title}`), never the bare word, which is ambiguous everywhere it also appears in prose;
- **the paper title** — targets `\title{…}` in the master, or, when the masthead comes from the config's `title` key (papers with no `\title{}`), that JSON key.

If no unique anchor can be found the composer fails **there**, with the reason, and saves nothing. Failing at compose time is acceptable; failing silently at Apply time is not. `build.mjs` publishes what the browser needs for this in `BUILD_META`: `sections` (slug → source file) and `title_source`.

## Presence (in memory only)

Desktop clients `POST /beat` every ~15s with `{state, section, section_title, focused_id}`; the server keeps a `Map<handle, …>` and fans out a `presence` event on the existing WS/SSE stream. **Non-negotiable properties:** never written to disk (there is no attendance log), symmetric (everyone sees everyone at the same granularity), and coarse (state + section only — no keystrokes, no dwell, no durations). `active` = real pointer/scroll/key/selection interaction within 60s **and** `visibilityState === 'visible'`; `idle` = visible but untouched, or the tab hidden (reacted to immediately); `offline` = no beat for ~45s. **Desktop only** (`matchMedia('(min-width: 900px)')`): phones send no beats and simply don't appear. Mobile keeps full read + comment.

The top-right cluster shows humans (initials disc in that handle's hashed author colour — the same colour as their comments and chips) and agents (brand glyph + rotating "working" ring) with a hairline between them: two visual grammars, so a person is never mistaken for a bot.

## Per-handle agent grants (`state/grants.json`)

Hosted mode has three tiers, not two. `{"<handle>": {"agents": true, "daily_cap": N}}`, **owner-written only** (`POST /grants`), with the day's counts in the server-owned `state/grant-usage.json`.

- **owner** — everything.
- **granted handle, within cap** — their `/mention` goes straight to the bridge; one budget unit is spent and the response says how many calls are left.
- **everyone else, and anyone over cap** — the existing `pending-mentions.json` queue, with an honest "daily cap reached (N/N)" message rather than a silent throttle.

The cap is visible to the granted guest in their own sidebar ("4 of 5 agent calls left today") — it is a budget meant to teach judicious use. Revocation and cap changes are read per request, so they take effect on the very next one. **Apply, Commit, Revert, model switching and permission/choice answers stay owner-only forever; a grant never confers them.**

## Task console + Settings (owner-only, desktop-only)

- **Task console** — a bottom-docked collapsible bar for *document-level* instructions that have no anchor text ("apply all", "commit", "restructure section 3", "verify every citation resolves"). It is **not** a chat about the paper: content discussion stays in anchored margin comments. Routing is as strict as everywhere else — nothing reaches an agent without `@claude`/`@codex`/`@all` (`POST /task`, owner-only, envelope marked DOCUMENT-LEVEL so bots answer in the turn instead of writing a thread entry). The **Changes widget** (Apply / Commit / Revert / out-of-band commit) lives inside it, because committing *is* a document-level task.
- **Settings** (gear in the cluster) — live per-agent context occupancy (exact, from bridge `status` events), this session's turns and prompt tokens per agent **and per handle** (the mention payload already carries the author, so each turn's cost is attributed to whoever triggered it), a local today/this-week rollup of *real billed* cost from botference's `logs/usage.jsonl` when present, and the relocated model switcher with its credit-exhaustion warnings. The session money figure is labeled an **estimate** with its basis stated: the CLI bridge reports prompt occupancy but neither output tokens nor billed cost. There is deliberately **no subscription-quota meter** — neither provider exposes Pro/Max or ChatGPT plan quota to anything but their interactive CLIs, so the panel says so and points at `/usage` in Claude Code instead of inventing a number.

## Decisions export (`decisions-round1.json`)

```json
{ "exported": "...", "build": { "site_version": 2, "built_at": "...", "source_commit": "2a62d86-dirty", "suggestion_ids": [...] },
  "decisions": { "<card-id>": { "status": "accepted|rejected|commented", "comment": "..." },
                 "user-<blk>-<ts>": { "status": "user-comment", "comment": "...", "anchor": "<blk>", "section": "...", "excerpt": "...", "quote": "<exact selected text, absent for block-level comments>" } } }
```

**Two-way threads:** every card/comment id can carry a conversation. Bot entries live in `state/threads.json[id]` (`{author, ts, text, suggestion_id?}`); each human's replies live in their *own* `users/<handle>.json` under `decisions[id].thread` (`[{ts, text}]`, author implied by the file). The UI merges all sources chronologically by `ts` and offers an inline reply box on every card and thread entry — a reply only ever appends to the viewer's own file.

Apply rules (Task 2+): apply is **author-agnostic** — it acts on bot cards from `suggestions.json` and human suggestions from `users/*.json` through the same code. Accepted cards are applied to LaTeX by unique-span replacement only, atomically with any `bib_entries`; a card carrying `source_json` is applied by parsing that JSON file, setting the key and re-serializing (with a drift guard on the previous value) — a JSON document is never string-replaced. Ambiguous/drifted spans are flagged `needs_manual_resolution`, never guessed. Span matching (shared `assets/span-match.js`, used by both the in-page tracked-changes renderer and apply) is whitespace- and smart-quote-tolerant: `\s+` runs collapse to one space and curly quotes fold to ASCII on both sides for matching *and* uniqueness counting, while the actual wrap/replacement uses true offsets in the raw text.

## Known limitations (accepted for review surface)

- Equations are numbered globally in paper order (`(N)` right-aligned); `eq:` labels are extracted into anchors so `Eq. (N)` refs link across pages. Numbering assumes all display math uses `equation` envs (true here); it can drift from the PDF if that changes. Figures/tables likewise globally renumbered.
- Citations render in Chicago author-date, not the journal's numbered style; canonical remains `.tex` + PDF.
- In-browser pixel verification was blocked in both agents' sandboxes (macOS seatbelt kills headless Chrome/Playwright); the site is DOM-audited. User's first open is the visual check of record.
