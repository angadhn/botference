# Review site — card & decision schema (v3, generic multi-user engine)

Built per `.claude/skills/paper-review/design.md`, P1+P2 scope. All document-specific values live in `review/review.config.json`; engine files contain no paper-specific strings. Regenerate with `node review/build.mjs` (reads sources; never writes to them).

## Config (`review/review.config.json`)

| key | notes |
|---|---|
| `slug` | short project id; keys browser storage and exports |
| `format` | `latex` · `markdown` — selects the renderer |
| `main` | master file (LaTeX: the `\documentclass` file; paper title is parsed from it each build) |
| `title` | optional masthead override; wins over the `\title{}` parse. Detect emits `"title": ""` when the master has no `\title{}` — fill it in to name the paper |
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

- **Live mode (preferred):** `node review/server.mjs`, open <http://localhost:4177>. Identity = `git config github.user` (fallback: slugged `user.name`). Your decisions/comments mirror (one-way, debounced, save-as-you-type) to `review/state/users/<handle>.json` — the only file your browser writes. The UI merges every `users/*.json`: yours editable, others' read-only and labeled with their handle. Bot replies (`state/threads.json`) render threaded under comments; suggestion cards with `reply_to` nest under the comment that prompted them. SSE (`GET /events`) live-updates the margin on state changes and reloads the page on site rebuilds. **🚩 Flag for agents** saves a flag file; it does not notify — say "read my comments" in chat.
- **Collaborators without botference:** clone → `node review/server.mjs` → comment in browser → `node review/submit.mjs [--push]` commits their own user file. `state/` is gitignored *except* `state/users/`, which travels through the repo.
- **Hosted auth (`--hosted`/`--share`):** browsers see an in-page password gate (no basic-auth popup): correct password sets an HMAC-signed `review_auth` cookie (HttpOnly, SameSite=Lax, Secure behind https, **7-day lifetime**, keyed by the gitignored `state/.auth-secret`) and redirects to the requested page. Only GET requests accepting `text/html` get the gate; JSON/SSE/asset requests get plain 401 JSON. curl and other tools may instead send `Authorization: Basic` with **any username** and the password (e.g. `curl -u x:$REVIEW_PASSWORD …`). `POST /auth` shares the per-IP write rate limit.
- **Static mode:** open `site/index.html` via `file://`; Export/Import decisions buttons bridge manually (browser storage is origin-scoped).
- **File ownership:** `users/<handle>.json` = that human (via server) · `summon.json` = browser flag · `suggestions.json` + `threads.json` + `ack.json` = bots · `site/` = build.mjs only (disposable, gitignored; canonical UI assets live in tracked `review/assets/` and are copied in at build). Nobody writes another writer's file.
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

## Decisions export (`decisions-round1.json`)

```json
{ "exported": "...", "build": { "site_version": 2, "built_at": "...", "source_commit": "2a62d86-dirty", "suggestion_ids": [...] },
  "decisions": { "<card-id>": { "status": "accepted|rejected|commented", "comment": "..." },
                 "user-<blk>-<ts>": { "status": "user-comment", "comment": "...", "anchor": "<blk>", "section": "...", "excerpt": "...", "quote": "<exact selected text, absent for block-level comments>" } } }
```

**Two-way threads:** every card/comment id can carry a conversation. Bot entries live in `state/threads.json[id]` (`{author, ts, text, suggestion_id?}`); each human's replies live in their *own* `users/<handle>.json` under `decisions[id].thread` (`[{ts, text}]`, author implied by the file). The UI merges all sources chronologically by `ts` and offers an inline reply box on every card and thread entry — a reply only ever appends to the viewer's own file.

Apply rules (Task 2+): accepted cards are applied to LaTeX by unique-span replacement only, atomically with any `bib_entries`; ambiguous/drifted spans are flagged `needs_manual_resolution`, never guessed. Span matching (shared `assets/span-match.js`, used by both the in-page tracked-changes renderer and apply) is whitespace- and smart-quote-tolerant: `\s+` runs collapse to one space and curly quotes fold to ASCII on both sides for matching *and* uniqueness counting, while the actual wrap/replacement uses true offsets in the raw text.

## Known limitations (accepted for review surface)

- Equations are numbered globally in paper order (`(N)` right-aligned); `eq:` labels are extracted into anchors so `Eq. (N)` refs link across pages. Numbering assumes all display math uses `equation` envs (true here); it can drift from the PDF if that changes. Figures/tables likewise globally renumbered.
- Citations render in Chicago author-date, not the journal's numbered style; canonical remains `.tex` + PDF.
- In-browser pixel verification was blocked in both agents' sandboxes (macOS seatbelt kills headless Chrome/Playwright); the site is DOM-audited. User's first open is the visual check of record.
