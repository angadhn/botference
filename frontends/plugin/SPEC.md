# Botference Discuss (the web annotator) — build contract

Browser extension (Chromium MV3, Brave-first) + local companion server. Highlight text on
static article pages, comment on it, @-mention bots for inline replies, export everything
to Obsidian. Bot conversations persist as botference sessions under project "Plugin pages".

This file is the interface contract between `extension/` and the companion server.
Both sides code against it. Do not change shapes unilaterally — the contract owner
(the managing agent) arbitrates.

## Product behavior (settled with the user — do not redesign)

- **One interface, no modes.** Highlight → floating 💬 button → comment box → save.
  An `@claude` / `@codex` / `@all` mention anywhere in a message summons bots.
  Mentions work in *any* message, including later replies in an existing
  thread (a personal thread becomes a bot chat the moment a reply tags a bot).
  A mention was once the ONLY such signal; it is now the first of three, and
  still the one that outranks the rest — see the 2026-08-19 amendment (untagged
  page chat on a project artifact goes to `@all`) and the 2026-08-24 one (a
  comment thread remembers who it is talking to, and its composer's pill row).
- **In the page: only highlights** (subtle yellow marks). All conversation UI lives in a
  **right-side drawer** (shadow DOM, ~380px) with two tabs: **Comments** (stack of
  anchored threads, page order) and **Page chat** (one general thread about the page).
  The drawer remembers the last-used tab **per site (hostname)** and opens there next
  time. No settings UI beyond that.
- Click a highlight → drawer opens scrolled to that thread; click a thread's quote →
  page scrolls to the highlight. Orphaned anchors (text gone) still show in the drawer
  with an "orphaned" badge.
- Bot replies stream **inline in the drawer thread** (like the review-doc UI): streaming
  text accumulates live, then is replaced by the final message. Status chip
  "agents are working…" while a turn runs.
- **Everything is exportable to Obsidian** — personal comments and bot exchanges alike.
  One note per page. Re-export regenerates the note (idempotent overwrite).
- **Chat title = the article's own headline** (in-article `<h1>` → `og:title` →
  `document.title` with site-name suffix stripped), never the URL or the site name.
- Static article pages only. No SPA re-render chasing. If anchoring fails, degrade to
  orphaned — never lose the comment.

## Repo layout & ownership

```
frontends/plugin/
  SPEC.md                  ← this file (managing agent owns)
  server.mjs               ← companion server           (companion agent owns)
  chat.mjs                 ← bridge adapter, adapted from frontends/review/chat.mjs (companion agent)
  store.mjs                ← page/thread persistence    (companion agent)
  workspace.mjs            ← project artifact pages: council-root detection,
                             the project's chat archive   (companion agent)
  export.mjs               ← Obsidian export            (companion agent)
  run.mjs                  ← running a python code block (companion agent)
  more.mjs                 ← the `<!--more-->` marker: canonical splitMore/stripMore,
                             copied byte-for-byte into drawer.js and reader.js (companion agent)
  collateral.mjs           ← the edits nobody commented on: the turn-end diff of the
                             review document, its regions, dedupe and caps (companion agent)
  blog.mjs                 ← blog source pages: which repo a local site is served
                             from, which markdown a url renders from, the census
                             over it, and the write rules (companion agent)
  bridge-system-prompt.md  ← bot role file              (companion agent)
  test/
    companion.test.mjs     ← endpoint tests w/ mock bridge (companion agent)
    collateral.test.mjs    ← the collateral-edit diff, dedupe and caps (companion agent)
    workspace.test.mjs     ← project artifact pages, end to end (companion agent)
    blog.test.mjs          ← blog source pages: mapping, scope, reload, no-git (companion agent)
    fixtures/article.html  ← sample static article, served at /test-page (companion agent)
    harness.html           ← loads extension JS with chrome-API + companion mocks for visual QA (extension agent)
    anchor.test.mjs        ← anchoring unit tests        (extension agent)
    pdf-perf.test.mjs      ← a 300-page book with 250 threads, in a real browser:
                             the ceilings that keep a textbook openable (extension agent)
  extension/               ← the whole MV3 extension     (extension agent owns)
    manifest.json
    background.js          ← service worker: owns WS to companion, all fetches, tab broadcast
    content.js             ← selection UX, highlight painting, drawer host
    anchor.js              ← quote+context anchoring (adapt frontends/review/assets/span-match.js)
    drawer.js  drawer.css  ← the drawer UI (shadow DOM)
    vendor/katex/          ← KaTeX 0.18.2 dist, vendored (see the math amendment)
    icons/                 ← simple generated PNGs (16/48/128)
```

Stay inside your ownership column. Shared code may be duplicated rather than imported
across the extension/server boundary (extension can't import server files).

## Companion server

- Node ≥18, zero npm dependencies (match the house style of `frontends/*/server.mjs`).
- Port **4189**, binds `127.0.0.1` only, no auth, **no CORS headers** — the extension
  does every fetch/WS from the background service worker with
  `host_permissions: ["http://127.0.0.1:4189/*", "ws://127.0.0.1:4189/*"]` (background
  fetches bypass CORS). Content scripts never talk to the network directly.
- Single-instance lock `<ROOT>/.botference/plugin-web.lock` (copy council's lock pattern).
- `ROOT = BOTFERENCE_PROJECT_ROOT || <repo root>`; `HOME = BOTFERENCE_HOME || <repo root>`.
- Reuse `frontends/review/ws.mjs` (import it directly — read-only dependency is fine):
  WS `/ws` primary, SSE `/events` fallback, server→client only.

### Storage (store.mjs)

- `pageKey = sha1(normUrl)` where `normUrl` = URL minus hash, minus
  `utm_*`/`fbclid`/`gclid` params, minus trailing slash.
- `<ROOT>/.botference/plugin/pages/<pageKey>.json`:

```jsonc
{ "version": 1,
  "url": "https://…", "title": "Article headline", "site": "skysports.com",
  "kind": "article",                      // article|pdf|gdocs — the adapter's word
  "custom_title": null,                   // the reader's own name for it, if any
  "tags": [],                             // the reader's own filing
  "created_at": "ISO", "updated_at": "ISO",
  "session_id": null,                     // botference sid once bots joined
  "session_title": "…",                   // what that chat is currently called
  // project artifact pages only (see "Project artifact pages"): the mirrored
  // council chat's length, and the session file's mtime as of the last refill
  "session_total": 0, "session_sync": 0,
  "threads": [                            // anchored comment threads, page order maintained on insert
    { "id": "t-<ts>-<rand4>",
      "quote": "exact selected text",
      "prefix": "≤32 chars before", "suffix": "≤32 chars after",
      "orphaned": false,
      // RESOLVED — the reader has marked this thread handled. All four fields
      // are absent on an open thread: reopening DELETES them rather than
      // writing resolved:false, so a never-resolved thread and a reopened one
      // are the same record. `summary` is the exception — it survives a reopen.
      "resolved": true, "resolved_at": "ISO", "resolved_by": "angadh",
      "summary": "3-5 sentences: what was asked, what came of it",
      "summary_by": "claude",               // absent ⇒ still the instant placeholder
      "summary_at": "ISO",
      "msgs": [ { "author": "angadh"|"claude"|"codex", "ts": "ISO", "text": "…" } ] }
  ],
  "page_chat": [ { "author": "…", "ts": "ISO", "text": "…" } ] }
```

- `<ROOT>/.botference/plugin/index.json`:
  `{ "<pageKey>": {"url","title","threads":N,"has_session","kind","tags?","updated_at"} }`
  (for the extension's "which pages have annotations" check). `title` here is the
  DISPLAY title — every list is drawn from this file alone.
- `<ROOT>/.botference/plugin/config.json`, created on first run with defaults:

```jsonc
{ "vault_path": "<auto-detected: nearest ancestor with .obsidian/, else $HOME>",
  "export_folder": "Web Clippings",
  "author": "<os username>" }
```

- Atomic writes (tmp + rename), same as the rest of the repo.

### HTTP API

All bodies JSON. All error responses `{ok:false, error:"…"}` with 4xx/5xx.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | — | `{ok:true, bridge:"running"\|"stopped", queue:N}` |
| GET | `/index` | — | the index.json map |
| GET | `/page?url=<enc>` | — | full page record (above) or `{ok:true, page:null}` |
| POST | `/page` | `{url,title,site}` | upserts page shell → full page record |
| POST | `/thread` | `{url, quote, prefix, suffix, msg:{text}}` | creates thread + first msg (server stamps id/author/ts) → `{ok, thread, queued?, position?, wait?}` |
| POST | `/reply` | `{url, thread_id, text}` (`thread_id:"__page__"` = page chat) | appends msg → `{ok, msg, queued?, position?, wait?}` (`wait`: `bridge_starting`\|`busy`) |
| POST | `/edit` | `{url, thread_id, ts, text}` | edits own (author=config.author) msg |
| POST | `/delete` | `{url, thread_id, ts?}` | ts absent → whole thread; present → one msg |
| POST | `/orphan` | `{url, thread_id, orphaned:bool}` | extension reports anchor status |
| POST | `/resolve` | `{url, thread_id, resolved:bool}` | files a thread / puts it back → `{ok, thread, summarizing?}` |
| POST | `/summarize` | `{url, thread_id}` | queues the filing turn again → `{ok, summarizing}` (409 with agents off) |
| POST | `/export` | `{url, mode?}` (`mode`: `all` (default) \| `comments`) | writes Obsidian note → `{ok, path, mode}` |
| POST | `/rename-page` | `{url, title}` | owner: the reader's own name for a page (`''` clears it) → `{ok, title, custom_title}` |
| POST | `/tag-page` | `{url, tags:[…]}` | owner: normalised, stored, indexed → `{ok, tags}` |
| POST | `/interrupt` | `{url}` | forwards interrupt to bridge if that page's turn is running |
| GET | `/run` | — | owner: `{ok, enabled, timeout_ms, python}` (may a block be run here) |
| POST | `/run` | `{url, thread_id?, ts, author?, kind?, block_index}` | owner: runs THAT stored block → `{ok, run, block_index, stored}` |
| POST | `/run-cancel` | same address | owner: kills that run → `{ok, cancelled}` |
| GET | `/run-figure?key=\|url=&run=&name=[&as=json]` | — | owner: one figure from a run |
| GET | `/test-page` | — | serves `test/fixtures/article.html` |

On `/thread` and `/reply`, the server scans `msg.text` with `/@(claude|codex|all)\b/i`.
Match → enqueue a bot turn (see below) and include `queued:true, position:N` in the response.

### Event stream (WS `/ws` primary, SSE `/events` fallback, identical JSON)

```jsonc
{"type":"hello"}
{"type":"ping"}                                   // heartbeat 15s
{"type":"page","url":"…"}                          // invalidation: refetch /page
{"type":"chat","url":"…","target":"<thread_id>|__page__","kind":"turn-start"}
{"type":"chat","url":"…","target":"…","kind":"stream","model":"claude|codex","stream_id":"…","text":"delta chunk"}
{"type":"chat","url":"…","target":"…","kind":"stream-done","model":"…","stream_id":"…"}
{"type":"chat","url":"…","target":"…","kind":"reply","msg":{"author":"claude","ts":"ISO","text":"final full text"}}  // authoritative; replaces streamed text
{"type":"chat","url":"…","target":"…","kind":"turn-end"}
{"type":"chat","url":"…","target":"…","kind":"error","error":"…"}
{"type":"bridge","state":"starting"|"running"|"exited","error":"…?"}
```

The `reply` event is emitted after the server appends the bot msg to the page file, so a
`/page` refetch after `turn-end` is consistent with the stream.

### Bridge integration (chat.mjs) — adapt `frontends/review/chat.mjs`

- Spawn `python3 <HOME>/core/botference_ink_bridge.py --system-prompt-file
  frontends/plugin/bridge-system-prompt.md` with env
  `BOTFERENCE_HOME`, `BOTFERENCE_PROJECT_ROOT`, `BOTFERENCE_CLAUDE_TRANSPORT=programmatic`
  (scrub other inherited `BOTFERENCE_*` like review does). JSONL stdin/stdout —
  stdin vocabulary: `{"type":"input","text":…}`, `{"type":"interrupt"}`,
  `{"type":"permission_response","allow":…}`, `{"type":"choice_response","index":…}`.
- Lazy start on first bot turn; keep alive after. **Never send `/quit`.**
- Test escape hatch: env `PLUGIN_BRIDGE_CMD` = JSON argv array replacing the python
  command (mirror `COUNCIL_BRIDGE_CMD`), used by companion.test.mjs with a mock bridge.
- One turn in flight per CHILD, FIFO. `{"type":"ready"}` is the turn boundary
  (note: one startup `ready` arrives before any turn). It was one turn in flight
  for the whole companion until the 2026-08-24 parallel-turns amendment, which
  put several children behind a dispatcher — see it for what may overlap and
  what may never.
- Auto-answer `choice_request` by picking the "Stay in Inbox"-style option if present
  else index 0 misgivings-free (copy review's logic); auto-deny permissions after 120s;
  forward permission requests as a `chat`/`error`-adjacent event only if simple — v1 may
  auto-allow reads: send `{"type":"permission_response","allow":true}` for `path`s under
  ROOT, deny otherwise.

**Per-page session choreography** (serialize as queued control turns, waiting for
`ready` between each):

1. First bot turn ever: `/project create Plugin pages` (tolerate the error text if it
   already exists), then `/project open plugin-pages`.
2. First bot turn for a page: `/new` → wait ready → `/rename <article title>` → capture
   the active `session_id` from the next `{"type":"projects"}` event (the session with
   `"active":true`) → store into the page file.
3. Page already has a `session_id` but the bridge's active session differs:
   `/resume <sid>` first. Track the active sid from `projects` events.
4. Then send the user turn.

**Turn envelope.** Route prefix from the mention: exactly one of claude/codex →
`@claude ` / `@codex `; `@all` or multiple → `@all `. Then:

- First turn of a page session prepends context:
  `[web page: "<title>" · <url>]\n<first ~6000 chars of extracted article text, if the extension supplied it>\n---\n`
- Anchored thread: `The user highlighted this passage:\n> <quote>\n\nand wrote:\n<text>\n\nReply concisely in this turn — your reply text is posted directly into the comment thread.`
- Page chat: `The user asked about this page:\n<text>\n\nReply concisely in this turn.`
- Thread with history: include the prior msgs of *that thread* (author: text lines)
  above the new message so the bot has thread context after a `/resume`.

**Capturing replies:** during the turn, forward `stream` `text_delta` events (kind
`stream`) tagged with the page url + target. On each final `{"type":"room"}` with
speaker `claude`/`codex`, append `{author, ts, text}` to the thread (or page_chat) and
emit the `reply` event. `ready` → `turn-end`.

- `/page` upsert of `title` also triggers nothing bridge-side; rename only happens at
  session creation.
- POST `/thread`, `/reply` may carry optional `article_text` (extension sends it with
  the *first* bot-mention on a page only) — server stores it transiently for the
  first-turn envelope, never persists it.

### Obsidian export (export.mjs)

Write `<vault_path>/<export_folder>/<sanitized title>.md` (create folder if missing;
sanitize `/:\\` etc.; collision with a *different* url → append ` (2)`):

```markdown
---
url: https://…
site: skysports.com
saved: 2026-08-07
tags: [web-annotation]
---

# <Article headline>

> <quote, line-wrapped as blockquote>

<comment text>                          ← single-msg thread by the user: bare text

> <quote>

**angadh:** first comment
**claude:** bot reply                   ← multi-msg thread: author-prefixed lines

## Page chat                            ← only if page_chat non-empty

**angadh:** …
**claude:** …
```

## Extension (MV3)

- `manifest_version: 3`. Permissions: `storage`, `activeTab`, `scripting`, `alarms`;
  `host_permissions`: `http://127.0.0.1:4189/*`. Content script on `<all_urls>` at
  `document_idle`, but **dormant by default**: on load it asks the background whether
  this normUrl is in the cached `/index`; only annotated pages auto-restore highlights.
  Toolbar click (action) or first text-selection popup activates the page.
- **background.js** owns: the WS connection (reconnect with backoff, `chrome.alarms`
  keepalive), the `/index` cache, all HTTP fetches (content scripts message it via
  `chrome.runtime.sendMessage`), and rebroadcast of `chat`/`page` events to the tab(s)
  whose normUrl matches. Badge = thread count for the active tab's page.
- **Selection UX (content.js):** on mouseup with a non-collapsed selection in article
  text, float a small 💬 button near the selection end; click → capture
  quote/prefix/suffix via anchor.js, paint a provisional highlight, open the drawer with
  a composer bound to that new thread. Esc closes drawer. Saving posts `/thread`.
- **anchor.js:** quote + 32-char prefix/suffix anchoring. Re-anchor by scanning the
  page's block-level text with whitespace/smart-quote-tolerant matching — adapt
  `frontends/review/assets/span-match.js` (fold runs of whitespace, normalize curly
  quotes/dashes). Exact-once match required; ambiguous matches disambiguated by
  prefix/suffix; failure → report `/orphan`. Highlight painting wraps the matched range's
  text nodes in `<mark class="bfp-hl" data-bfp="<thread_id>">` with inline styles
  (yellowish `rgba(250, 210, 80, .45)`, `rgba(250,190,60,.6)` when focused); unwrap
  cleanly on delete.
- **drawer.js/css:** shadow DOM host `<div id="bfp-root">` so page CSS can't leak in.
  Fixed right side, width 380px, full height, slides in/out. Header: article title,
  export button, close. Tabs: Comments / Page chat (remember last per hostname in
  `chrome.storage.local`). Match the review-doc look — palette from
  `frontends/review/assets/style.css`: bg `#faf7f0`/dark `#1a1712`, card `#fff`/`#241f18`,
  accent `#d97757`, claude `#d97757`, codex `#4a86c8`, author-colored
  `border-left: 3px solid`, `.badge` chips, dark mode via `prefers-color-scheme`.
  Thread card: quote block (click → scroll page to highlight), messages, reply composer.
  Streaming: `.reply.streaming` with accumulating `<pre>` text, replaced by the final
  `reply` event; status chip "◐ agents are working…" during turn-start→turn-end; small
  interrupt (✕ stop) button while running which POSTs `/interrupt`.
  Composer hint text: "@claude, @codex or @all to bring in the bots".
- **Article extraction (content.js):** headline = first `<article> h1` / `<main> h1` /
  `h1` → `og:title` → `document.title` minus ` - Site` / ` | Site` suffix. Article text
  for the first bot turn: text of `<article>` or `<main>` or largest text block,
  whitespace-collapsed, ≤6000 chars.
- No build step: plain JS/CSS files, loadable via brave://extensions → Load unpacked →
  `frontends/plugin/extension`.

## Testing requirements

- `test/companion.test.mjs`: node script (no framework, exit non-zero on failure) using
  `PLUGIN_BRIDGE_CMD` mock bridge (a tiny node script that speaks the JSONL protocol,
  emits `ready`, echoes canned `stream`/`room`/`projects` events). Cover: page CRUD,
  thread/reply, mention → queue → stream events → reply persisted, session choreography
  (`/project create` → `/new` → `/rename` → sid capture), export file content, orphan,
  interrupt.
- `test/anchor.test.mjs`: node script unit-testing anchor.js matching (exact, smart
  quotes, whitespace runs, ambiguity via prefix/suffix, orphan case) — anchor.js must
  therefore keep its matching logic in pure functions that run in node.
- `test/envelope.test.mjs`: node script over the drawer's pure `splitEnvelopes`
  and `agentOf`. The load-bearing cases are the ones that must NOT fire: an
  envelope inside a fenced code block stays put (fence ordinals are the Run
  button's address) and a footer coming off never takes a checkbox line with
  it (tick ordinals are the companion's address).
- `test/more.test.mjs`: node script over the `<!--more-->` marker — the parser, the
  three byte-identical copies (more.mjs / drawer.js / reader.js), and the export
  keeping BOTH halves. The load-bearing negative is the same one envelope.test.mjs
  guards: a marker inside a fenced code block is code and must not split.
- `test/harness.html`: standalone page embedding the fixture article + extension
  scripts with a `chrome` shim + scripted fake companion responses, so the full drawer
  UI renders without installing the extension (used for screenshot QA).

## Amendments (rounds 2–3, shipped)

Contract deltas agreed during live testing — authoritative over the sections above:

- `server.mjs --no-agents`: no bridge ever; mentions persist but return
  `{ok:true, queued:false, reason:"agents are off on this companion"}` + a `chat`/`error`
  event; `/health` reports `bridge:"disabled"`.
- `POST /thread` accepts optional `index` (page-order insert) and auto-creates the page
  shell. `POST /delete` with `ts`: deleting a thread's last message deletes the thread
  (`{ok:true, thread_deleted:true}`); `store.readPage()` prunes empty-msgs threads
  retroactively on any read.
- Tool activity: room entries whose `stream_id` ends in `:tools` (fallback: "Explored"
  + branch lines) persist as msgs with `kind:"tools"`; excluded from Obsidian export;
  drawer groups a turn's tools msgs into one collapsed "Explored · N steps" row hoisted
  above the answer. `reply` events carry `kind`; tools replies append (never replace
  the streamed block).
- Turn events carry `agents:["claude"|"codex",...]` (from the route prefix) on
  `turn-start`/`turn-end`; drawer shows logomark avatar-ring spinners, the spinning ring
  following the live stream `model` on @all turns.
- `GET /models` → `{ok, current, options, status, bridge}`;
  `status = {claude:{pct,tokens,window,model,last_relay_at,last_relay_tier}, codex:{…},
  auto_relay}` (null until the bridge speaks). `{"type":"models"}` broadcasts the same
  shape, fired only on meaningful change (pct/model/relay/auto_relay — not token creep).
  `POST /model {agent, model}` queues a `/model` control turn (starts the bridge if
  needed); `POST /relay {agent:"claude"|"codex"|"both"}` queues `/relay` (409 "agents
  are idle — nothing to relay" when the bridge is stopped; never spawns).
- Drawer: pushes the page aside via inline `margin-right` on `<html>` (restored on
  close); left-edge drag resize clamped [320, min(720, 50vw)], persisted globally,
  double-click resets 420. Gear popover = minimal agents panel (model selects, context
  gauges with 50% tick, relay buttons, sleeping/off states). Bot replies render
  markdown (safe DOM building, http/https links only). Composers clear only on
  successful send. Export button = inline Obsidian crystal SVG.
- Pages view: a stacked-pages header button swaps the drawer body to the full
  annotation history (from `GET /index`, newest first, current page marked); clicking a
  row makes the background open/focus a tab at that url after arming a one-shot
  `bfp-autoopen:<normUrl>` flag in chrome.storage.local that content.js consumes on
  load to auto-open the drawer (`{t:'open-page', url}` / `{t:'autoopen'}` messages;
  manifest gained the `tabs` permission). Per-row Obsidian export button. Council
  filing underneath is unchanged — the plugin is simply the primary browser of its own
  history.
- Site adapters (`extension/adapters.js`, classic script before content.js): registry
  keyed by URL; an adapter may override title/articleText and declare
  `capabilities.highlights:false` (no selection pill, drawer opens to Page chat,
  Comments tab disabled with tooltip, existing anchors orphaned locally without
  POSTing /orphan). First adapter: Google Docs — text via the doc's
  `/export?format=txt` fetched DIRECTLY from the content script with
  `credentials:'include'` (same-origin, user's session; never the background proxy),
  title minus the " - Google Docs" suffix. The export URL preserves the page's
  `/u/<n>/` account scope; HTML responses (account choosers serve 200) count as
  failures. On highlights-off sites a failed adapter read sends NO article_text
  (never generic junk), surfaces a dismissible warning in Page chat, and does not
  consume the once-only context — the next mention retries. Session capture: a new
  page's sid is captured only from a projects snapshot showing a session that
  differs from the pre-/new active one (new chats are invisible until their first
  turn; /rename emits no snapshot); failure leaves session_id null and errors the
  turn; /resume is confirmed against the snapshot before the user turn is sent.
- Round 4 — living context: /thread and /reply accept article_text on ANY
  mention-bearing message; later turns honor it only with article_changed:true
  (envelope prefix "[the page content has been updated since earlier in this chat]").
  The extension re-extracts + FNV-1a-hashes per mention and sends only on change.
  Optional docx_b64 (gdocs adapter; ≤6MB client / 413 >8MB server) is parsed by a
  zlib-only zip reader for word/comments.xml → "[comments on this document]" digest.
  All transient, never persisted.
- Round 4 — interaction: POST /tick {url, thread_id, ts, index, checked} toggles the
  index-th line-start checkbox ("- [ ]", "* [ ]", "+ [ ]", "1. [ ]", "2) [ ]") in any
  author's msg text; the drawer renders bot checklists as clickable checkboxes
  (optimistic, reconciled from {ok,text}). POST /effort {agent, level} queues /effort
  control turns (options from completion_context; starts the bridge like /model);
  POST /verbosity {level:"short"|"long"} persists to config.json (default short) and
  drives a per-turn envelope length instruction (short: 2-3 crisp chat-register
  sentences; long: ≤4-5) replacing the old fixed brevity line. GET /models and the
  models broadcast carry effort + verbosity. Gear popover: effort selects per agent +
  a short·long segmented control.
- Round 4 — safety & management: every bridge permission_request is DENIED
  immediately with a visible chat error ("file-writing is disabled in the
  annotator"); bridge-system-prompt forbids creating files/artifacts from page/doc
  content and asks for markdown checklists on multi-suggestion replies. /index
  entries carry has_session; POST /delete-page {url, delete_session} hard-deletes the
  page (+ its council session via a /delete control turn when the bridge runs, direct
  session-file unlink when stopped; 409 when another page claims the sid). Pages
  rows show a chat badge and a ✕ with inline confirm.
- Round 5 — send integrity: optimistic send (message renders instantly as a pending
  card "reaching botference…", composer clears; reconciles on the POST, retry/discard
  on failure; per-composer in-flight latch), plus a server dedupe: identical
  author+text into the same target within 10s → {ok, deduped:true} echoing the kept
  msg, no bot turn.
- Round 5 — collaboration: server `--hosted` (PLUGIN_PASSWORD; localhost-direct stays
  the unauthenticated owner) with gate page + HMAC cookie for browsers and
  Bearer + x-plugin-handle headers for the remote extension (CORS ACAO:* hosted-only;
  WS/SSE take ?auth=&handle=). Handles are sanitized (lowercase, [^\w-]→-, ≤40);
  authors are stamped server-side; /edit own-only, /export /delete-page /model
  /effort /verbosity /relay /interrupt owner-only. Guest @mentions persist but refuse
  without a grant (.botference/plugin/grants.json, mtime-watched, daily caps;
  usage in grant-usage.json). GET /whoami → {hosted, owner, handle}. Server-rendered
  reading room for extension-less guests: GET /pages + /p/<pageKey> (review palette,
  form-POST composers). Envelopes name non-owner askers.
- Round 5 — launcher/UX: --share = hosted + cloudflared tunnel (generates
  PLUGIN_PASSWORD, share line; --service variant 'plugin-share'); sticky workspace
  (~/.botference/plugin-workspace records the last workspace; any-directory reuse,
  --here overrides); extension options page (companion URL / password / display
  name, test-connection); offline notice is a numbered walkthrough naming
  --install-autostart; completions cover plugin in zsh + bash.
- Message resolution: /edit, /tick, and /delete (single-message form) accept optional
  `author` (matched after handle sanitization) and `kind` ("tools" addresses a bot's
  tool-activity summary; otherwise the non-tools message is preferred) alongside `ts`,
  because timestamps are addresses, not identities — two messages can share a
  millisecond. Both are preferences (legacy payloads on a unique ts are unchanged);
  /edit always, and /delete for guests, defaults author to the caller's own handle.
  An unbreakable tie resolves to the first match with `ambiguous:true` in the
  response. store.resolveMsg() is the single resolver. The drawer's queued status is
  lifecycle-scoped: written only if the turn hasn't already started (epoch check),
  superseded by the working chip at turn-start, structurally removed at
  reply/turn-end/error.
- Pages view: the row for the page you are on is the emphasised one — accent
  rail, faint accent wash, its title at full contrast and bold — and the other
  rows step back (title at ~60% of --heading, meta at .75 opacity, both restored
  on hover) so the emphasis is visible rather than merely present. The button
  that opens the list wears the braid itself, drawn the way icons/make-icons.mjs
  draws the 16px tile: half a turn, one crossing, three strands, casing in
  --bg so over/under reads in both themes.
- Identity assets: extension icons are a full-bleed braid mark (per-size redrawn
  variants in icons/make-icons.mjs + braid.svg source; the 16px read is the
  acceptance bar); site/og-image.png is the braid share card; site/favicon.png from
  the same mark.
- TeX math in messages: every message, whoever wrote it, renders `$…$` / `\(…\)`
  inline and `$$…$$` / `\[…\]` display via KaTeX 0.18.2 vendored at
  `extension/vendor/katex/` (katex.min.js as the first content script, woff2 only,
  no CDN and no network). Math is tokenized OUT of the source before the markdown
  parser runs and substituted back after, so `_`/`*`/`\\` inside TeX survive; code
  spans and fenced blocks are skipped by the tokenizer and keep their `$` literal.
  A single `$` opens math only when the next character is not a space, the
  previous one is not alphanumeric, and a closer (not preceded by a space, not
  followed by a digit) exists in the same paragraph — so "costs $5 and $10" stays
  prose. Unparseable TeX and an unavailable KaTeX both degrade to the raw source
  text; a formula never blanks or throws a message. `katex.min.css` is linked into
  the shadow root, but its `@font-face` rules do not register there, so content.js
  links a font-only `katex-fonts.css` into the PAGE document (both web-accessible).
  Obsidian export is unchanged and deliberately so: the raw `$…$` source is what
  reaches the vault, because Obsidian typesets it itself.
- Folding is the reader's, once they say so: any thread (or page chat) with 3+
  drawn units carries a manual control in the same slot the expander uses —
  "Hide N earlier replies" when it is open, "Show N earlier replies" when it is
  not. A hand fold is tighter than the automatic one (KEEP_TAIL_SHUT = 1: the
  root and the newest unit), and the choice outranks the rule for that target
  for the rest of the session — in memory, per target, cleared with everything
  else on a page delete. Neither direction is undone by a new reply: a folded
  thread that gets an answer shows it at the bottom and stays folded, and one
  opened by hand stays open however long it grows. `collapsePlan(units, manual)`
  takes undefined (the rule decides) / FOLD_OPEN / FOLD_SHUT and is the whole
  state machine (test/collapse.test.mjs).
- Long threads fold: past 3 drawn units a thread (and the page chat) keeps its
  root and the last 2 units and hides the rest behind one `.showmore` line,
  "Show N earlier replies" — singular "Show 1 earlier reply" when the fold hides
  exactly one, which a four-unit thread does — N counting messages and not tool
  rows. A middle that holds no message at all (only tool rows) is not folded, so
  the line never claims zero. The unit of
  folding is what the drawer draws — a person's message, or a bot's whole turn
  (its merged tools row plus every answer in it) — so a tools disclosure can
  never survive above an answer that was folded away. Expansion is one-way and
  per-target, in memory for the session (`D.expanded`, cleared with the rest on
  a page delete); the outbox, streaming blocks and the status chip render after
  the fold and are therefore always visible. `msgUnits`/`collapsePlan` are pure
  and unit-tested (test/collapse.test.mjs).
- Export comes in two modes, chosen at the crystal: **Everything** (the note as
  it has always been) and **Comments only** — the reading without the
  conversation. "Comments only" drops every bot-authored message and every
  message of the reader's own that carries a mention (`hasMention`, the
  companion's own routing rule, and `isBotAuthor` from the same roster in
  chat.mjs — there is no second regex), and drops the page chat entirely, since
  it is bot conversation by nature. The blockquote ALWAYS survives, for every
  thread, including one whose messages all filtered away: the passage someone
  marked is the annotation. Mode rides POST /export as `mode` and comes back in
  the answer; anything unrecognised (an older extension included) is `all`.
  One note per page either way — a re-export REPLACES, so changing your mind is
  one more click, not a second file. The chooser is two rows, one click each,
  Esc dismisses, and the last choice is remembered in extension storage
  (`bfp:exportMode`, the same idiom as the tab and the width) and preselected.
  A row's crystal in the Pages view does NOT ask — it runs the remembered mode
  straight away and names it in its tooltip.
- Liveness: the drawer converges on the record without a reload, always. The
  event stream is a fast path, never the only one. Every content→background
  message carries `page_url` and re-registers the tab in the worker's routing
  table (memory-only, and an MV3 worker is retired and respawned at Chrome's
  discretion — a respawned worker that has forgotten a tab delivers it nothing,
  which is how a reply could land in the record while the tab still showed
  "queued…"). Belt and braces, all four: a long-lived port per tab
  (`chrome.runtime.connect`, name `bfp`) whose DISCONNECT is the page's notice
  that the worker died — it reconnects (starting a worker) and refetches; a
  fresh worker asks every open tab `{t:'whereami'}`; `{t:'conn', resumed:true}`
  on every socket (re)open makes each drawer refetch what it may have missed;
  and after any send, checks at 4s and 10s refetch if no event has arrived.
  A page that is visibly waiting and hearing nothing polls every 4s (bounded,
  ~2 min). A running turn with no event for 45s is settled locally
  (`quietTurns`/`endTurn`) so a lost `turn-end` cannot spin for ever, and a
  refetch that shows the bots answered clears a stale wait structurally. One
  malformed event can never freeze the stream: `onEvent` catches, counts, and
  the next event is handled normally (the failure triggers a refetch).
- Waiting states say what they are waiting for: `chat.submit` reports
  `wait: 'bridge_starting' | 'busy' | 'pool_busy'` (absent once the turn is
  genuinely running), which rides POST /thread and /reply beside
  `queued`/`position`. The drawer renders "waking the agents…" / "queued behind
  this conversation…" / "queued behind another chat…" / "queued (#N)", each with the same ◐ every other live state uses — a wait must
  look alive, not stalled. An older companion sends no `wait` and still gets a
  plain, spinning "queued…".
- @-mentions complete themselves: typing `@` at a word boundary in any composer
  (new comment, reply, page chat) opens a small menu of the agents the drawer
  knows about (from the same models/status data the gear popover reads — never a
  hardcoded pair) plus `@all`, each with its logomark. Typing filters by
  case-insensitive prefix, ↑/↓ move, Enter/Tab/click complete to `@handle `
  (trailing space), Esc or no match closes it and leaves the text exactly as
  typed. Mid-message mentions count — the token under the CARET is what is
  completed — and an `@` inside a word (an email address) never opens it.
  `mentionToken`/`mentionCandidates` are pure and unit-tested
  (test/mentions.test.mjs).
- Launcher: `botference plugin --install-autostart` / `--uninstall-autostart` (macOS
  LaunchAgent `com.botference.plugin-web`, KeepAlive SuccessfulExit=false, hand-run
  instance wins the lock; launchd takes over ~10s after it exits).
- One permanent address. `--install-tunnel` / `--uninstall-tunnel` give the
  companion a named Cloudflare tunnel instead of `--share`'s disposable
  trycloudflare URL: tunnel `botference-plugin` (created once, reused after),
  DNS route to `plugin.botference.com` (both overridable —
  `BOTFERENCE_PLUGIN_TUNNEL`, `BOTFERENCE_PLUGIN_HOSTNAME`),
  `~/.cloudflared/botference-plugin.yml` with a single ingress rule to
  `http://127.0.0.1:<port>` plus the mandatory `http_status:404` catch-all, and
  a second LaunchAgent `com.botference.plugin-tunnel` (unconditional KeepAlive
  — a tunnel that exits cleanly because the edge hung up must still return).
  The companion's own LaunchAgent gains `--hosted`, rebuilt from the plist it
  already has so `--port`/`--no-agents` survive and exactly one `--hosted` is
  ever added. The password is generated once (four dictionary words + a
  number) into `~/.botference/plugin-password` (0600) and is NEVER written into
  a plist: launchd runs the launcher, and `--hosted` with no `PLUGIN_PASSWORD`
  in the environment reads that file. `--uninstall-tunnel` boots out the tunnel
  agent and rebuilds the companion's without `--hosted`, leaving the Cloudflare
  tunnel and DNS record in place (naming the `cloudflared tunnel delete` that
  would remove them).
- Owner vs guest, restated for a proxy that lives on this machine.
  `isLocalDirect` is the entire boundary and now requires three independent
  things: a loopback `Host`, a loopback socket peer, AND the absence of every
  header in `PROXY_HEADERS` (`cf-connecting-ip`, `cf-ray`, `cf-visitor`,
  `cf-ipcountry`, `cf-worker`, `x-forwarded-for`, `x-forwarded-proto`,
  `x-forwarded-host`, `x-real-ip`). cloudflared's hop to the companion comes
  from 127.0.0.1 like the extension's, so the socket cannot separate them;
  Host does (cloudflared forwards the public hostname unchanged) and the
  Cloudflare-stamped headers do even if Host is ever rewritten by an
  `httpHostHeader` ingress setting. It fails closed: the worst a false
  negative can do is ask the owner for their own password.

- One owner identity, shared with the review docs (`identity.mjs`). The review
  hub had already solved "prove you are the owner from a phone" twice, and both
  halves are reused here verbatim rather than re-invented:
  · **an approved device** — hub.mjs's `hub_device = exp.<deviceId>.<hmac>`
    cookie, signed with `~/.botference/.review-hub-device-secret`, 365 days,
    scoped by the hub to the PARENT domain. plugin.botference.com is inside
    that scope, so a browser already approved for review.botference.com is the
    owner here with nothing typed. The annotator only ever VERIFIES that
    cookie; minting one stays the hub's osascript approval flow.
  · **the owner password** — resolved exactly as hub.mjs's `ownerPassword()`
    does: `PLUGIN_OWNER_PASSWORD` → `REVIEW_HUB_PASSWORD` → `.owner` in
    `~/.botference/review-paper-secrets.json`, generated and persisted there on
    first use. That is the same value the hub hands every paper as
    `REVIEW_OWNER_PASSWORD`, so it is one password for every botference thing.
  An owner authenticated either way gets FULL owner rights remotely — export,
  delete-page, model/effort/verbosity/relay/interrupt, and bot mentions with no
  grant. Localhost-direct remains the unauthenticated owner, and `isLocalDirect`
  (Host + PROXY_HEADERS + loopback peer) is still what separates it from tunnel
  traffic.
- Sessions carry a SIGNED name. `plugin_auth` is now `exp.role.handle.<hmac>`:
  the handle used to sit outside the signature in the unsigned `plugin_handle`
  cookie, which `identity()` then trusted — so any signed-in guest could rename
  themselves to another guest and write under their name. The unsigned cookie
  survives for labelling only and is never consulted for identity; a header
  handle is honoured only alongside a bearer token (the extension's path).
  TTL 30 days, re-issued whenever a request arrives past half its life, so a
  phone in regular use never meets the gate twice. `GET /signout` clears it.
- **Article snapshots** (`sanitize.mjs`, `store.mjs`, `reader.js`). The
  extension captures the prose of an annotated page and the companion serves it
  back, so the page can be READ and marked up from a phone that never visited
  it.
  · `POST /snapshot {url, html}` — owner-only (a snapshot is what everyone else
    reads). The companion sanitizes on the way in and stores the result at
    `.botference/plugin/snapshots/<pageKey>.html`, replaced whole on refresh,
    ≤2 MB after sanitizing (`SNAPSHOT_MAX`; larger ⇒
    `{ok:true, stored:false, reason}`). Answers `{ok, stored, bytes, dropped}`
    and broadcasts a `page` event. Deleting a page deletes its snapshot.
  · The extension sends on the cadence the article TEXT already used: once when
    the page gets its first thread, and thereafter only when an FNV-1a hash of
    the captured HTML changes (checked on every mention). It unwraps its own
    `mark.bfp-hl` (never removes them — they wrap the sentence the comment is
    about), drops the obvious furniture, and absolutizes href/src while it
    still knows the page. Client cap 3 MB.
  · `sanitizeArticle()` rebuilds the HTML from a token stream against an
    allowlist: a KILL set dropped with its subtree (script/style/iframe/svg/
    form/…), everything else either kept or UNWRAPPED (tag gone, words kept),
    a per-element attribute allowlist (which is what removes every `on*` and
    every `style` without a blocklist), href/src required to be literally
    http(s) after control characters are stripped, and text re-escaped.
  · `GET /a/<pageKey>` — the article view. Serves the snapshot under
    `default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…';
    img-src https: data:; connect-src 'self'; form-action 'self';
    base-uri 'none'; frame-ancestors 'none'` plus `referrer-policy: no-referrer`.
    Remote images are allowed (an article without them reads poorly); the
    reader's IP reaching the origin's CDN is the accepted cost.
  · `GET /assets/anchor.js` serves the EXTENSION'S OWN anchor.js unchanged, and
    `/assets/reader.js` the phone UI. Anchoring the phone by the same code is
    what makes a highlight made there findable on the Mac: both sides store
    `{quote, prefix, suffix}` from the same `buildAnchor`, and both re-find it
    with the same `locate()`. The snapshot is only the article, the Mac indexes
    the whole page, and the anchor survives the difference (tested).
  · `reader.js`: paints every thread, tap a highlight → bottom sheet with that
    thread and a composer, `chat` → page chat, selection → pill → new thread
    (POST /thread with a freshly built anchor), owner-only export with the
    same two-mode chooser, and the drawer's wait vocabulary
    (`bridge_starting`/`busy`/turn-start → turn-end) driven by the same WS
    events. Writes go to the same JSON endpoints the extension posts to.
  · `/p/<pageKey>` is unchanged and remains the conversation view (stable
    links, form redirects); it gains a link to the article. `/pages` opens the
    article for rows that have a snapshot, the conversation for those that do
    not. A page annotated before snapshots existed degrades to a one-line
    explanation naming the fix, with its comments one tap away.

- The product is called **Discuss**, at **discuss.botference.com**. Only the
  name and the address moved; nothing structural did, deliberately, because a
  rename that costs a data migration is a rename not worth having. Still
  `plugin` everywhere it is not read by a person: the `botference plugin`
  command (with `botference discuss` as an equal alias), `.botference/plugin/`
  and its `pages/`, `snapshots/`, `grants.json`, `~/.botference/plugin-*`,
  the `com.botference.plugin-web` / `com.botference.plugin-tunnel` LaunchAgent
  labels, the `plugin-web`/`plugin-share` service names, the
  `botference-plugin` tunnel, this directory, and every file in it. Changed:
  the extension's `name` ("Botference Discuss") and description, the reading
  room's and the gate's titles, the drawer's aria-label, and the docs.
  `plugin.botference.com` remains routed and served — `--install-tunnel`
  writes a SECOND ingress rule to the same local service rather than a
  redirect, so an old bookmark or a remote extension configured before the
  rename reaches the same companion and the same annotations. The legacy
  hostname is best-effort: if its DNS route fails the install says so and
  carries on with the canonical one. `BOTFERENCE_PLUGIN_HOSTNAME` and
  `BOTFERENCE_PLUGIN_LEGACY_HOSTNAME` (empty to drop it) override both.
  Nothing in the server binds to a specific public hostname: `isLocalDirect`
  only asks whether the Host is loopback, so every remote hostname is treated
  identically, and the review hub's `hub_device` cookie is scoped to the parent
  domain and therefore reaches both. Sessions are host-only cookies (no
  `Domain`), so signing in at one hostname does not carry to the other — which
  is why the canonical address is the one the install tells you to bookmark.

- API keys (`../shared/keys.mjs`, shared with the council web server — one
  stored key serves both, and each product keeps its own mode; the tunnel test
  behind them, `isLocalDirect`, lives in `../shared/local.mjs` and is
  re-exported by `hosted.mjs`). Per-agent auth for the CLIs the bridge spawns,
  since both already read a key from the environment. Stored in
  `~/.botference/discuss-keys.json` (0600, mtime-watched like grants.json) as
  `{keys:{claude,codex}, modes:{claude,codex}}` — the `modes` there are
  Discuss's (the council's live in its own workspace state file). Modes are `auto` (default —
  a stored key is used, else the subscription, mirroring Claude Code itself),
  `subscription`, `key`. `applyEnv()` is the only consumer: called at every
  bridge spawn, it sets `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` when a key
  applies and otherwise **deletes** them — absent, never empty, because an
  empty key is not the same thing as no key to a CLI. It also always clears the
  sibling auth sources (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_AWS_API_KEY`,
  `ANTHROPIC_FOUNDRY_*`, `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_USE_{BEDROCK,
  VERTEX,FOUNDRY}`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`), any of which would
  override a subscription just as a key would.
  Routes, all **localhost-direct only** (stricter than owner-only — `isLocalDirect`,
  so the remote owner is refused too and a key never crosses the tunnel):
  `GET /keys` → `{claude:'set'|'unset', codex:…, modes:{…}}` and never key
  material; `POST /keys {agent, key}`; `POST /keys/remove {agent}` →
  `{removed:bool, …}`, a real delete rather than a blank overwrite;
  `POST /key-mode {agent, mode}`. Each answers with the status plus
  `applies:'now'|'next-restart'` — an environment is fixed at spawn, so an idle
  bridge is stopped (respawning on the next mention) and a busy one is left to
  finish. `GET /models` and the `models` broadcast carry `keys` (status +
  modes) so the gear popover can render a per-agent billing control, which —
  like verbosity, and unlike model/effort — survives a sleeping bridge because
  it is the companion's setting. Keys are never logged, never echoed into an
  error, and never written to a page record.
  **Entry stays on the options page; the drawer only ever links to it.** The
  drawer is injected into whatever page the reader is on — its DOM is that
  page's DOM — so a key is typed on the extension's own options page and
  nowhere else, and both the billing control and the popover's quiet "API keys…"
  link do the same thing about it: send `{t:'open-options', agent?}` to
  background.js, which arms a one-shot `bfp:focus-key` hint in
  `chrome.storage.local` and calls `chrome.runtime.openOptionsPage()`
  (options.js focuses that field and deletes the hint).
  **The control is a two-position switch: subscription ↔ API key.** The stored
  mode stays the tri-state above; the switch shows what it RESOLVES to (`auto`
  = the key when one is saved, else the subscription), and moving it POSTs the
  explicit mode, never `auto`. Asking for "API key" with no key saved is not a
  setting that could work, so it is not sent: the switch is held visibly
  mid-flight, the options page opens at that agent's field, and only the
  companion's next `keys` — a `models` broadcast, or the refetch the drawer
  fires when its window is focused again — settles it, into "API key" if a key
  really was saved and back to "subscription" if not. No key, no key mode.
  **The CLIs disagree and the UI says so.** claude: a key set in the
  environment beats the subscription (documented; no prompt in the `-p` mode
  the bridge uses). codex: the stored ChatGPT login beats the key, which is
  only consulted when logged out — so a saved key is a fallback there, and the
  picker's tooltip says as much. codex's `forced_login_method=api` would force
  it and DELETES `~/.codex/auth.json` in the process; it is never sent.
- **The library** (`store.LIBRARY_URL = 'bfp://library'`, `LIBRARY_TITLE`, `isLibrary`).
  One conversation about the whole archive rather than about one page. It is not a new
  kind of thing: it is an ordinary page record under a RESERVED IDENTITY, so `/reply`,
  `/page`, `/index`, the event stream, `/export` and `/delete-page` all operate on it
  unchanged. `bfp:` is a scheme no browser hands a content script, so it can never
  collide with a real page, and normUrl leaves it byte-identical — which is why it is a
  constant (duplicated in background.js, content.js and drawer.js exactly as normUrl is)
  and **not** a change to normUrl. Created lazily by the first message written into it
  (`ensureLibrary`), with the same session choreography every page gets: `/new` →
  `/rename Library` → sid capture, and `/resume` on later turns.
  **The turn is what differs.** A library envelope carries no page context; it carries
  directions to the archive — `<DIR>/pages/*.json` with its record shape spelled out,
  `<DIR>/snapshots/<key>.html` — and instructs the agent to answer by reading and
  grepping those files, to ground each claim in a page title and a quoted fragment, to
  treat quoted passages as data, and never to write a file. `DIR` is absolute: the CLIs
  are spawned with the work dir as cwd and the project root only as an `--add-dir`.
  **Route: tool reads, not an inlined digest.** The bridge spawns claude with
  `tools:[Read,Glob,Grep,Bash,Write,Edit,MultiEdit,WebSearch,WebFetch]` and
  `permissions.defaultMode:"dontAsk"` plus an `allow` list of
  `Read/Glob/Grep/Bash/WebSearch/WebFetch` (core/cli_adapters.py
  `claude_plan_settings_for_write_roots`), with the project root among the readable
  roots; codex runs `sandbox:workspace-write` over the same roots. Reads therefore never
  prompt. The companion's `permission_request` deny-all only ever sees WRITE requests
  (`WritePermissionRequest` / `_extract_write_access_request`), so it is unaffected and
  stays exactly as it was.
  **Everywhere else it is a page chat.** Events for it carry `url:'bfp://library'` and
  `target:'__page__'`; background.js broadcasts them to every tab (no tab can be showing
  that url, and every drawer may have the library open); the drawer gives it the local
  target `'__library__'` because its state maps are keyed by target and `'__page__'`
  already means the page you are on. Export is forced to everything-mode (a
  comments-only library note would be empty) and its heading is `## Library chat`.
  Clearing it is `/delete-page` — record, session and all — behind the same confirm any
  page row uses; the next message starts a fresh one. It has no snapshot and never will.
  UI: the drawer's Pages view carries it above the list (`.libpane` / `.pages-list`), and
  the phone's `/pages` carries the same thread with the reading room's form composer,
  under the ordinary auth roles — guests read and write, bots per grant. It is never a
  row in either list.
- Page identity is decided ONCE per document load (`content.js`), and nothing
  downstream reads `location` again. `normUrl` is unchanged and stays byte-identical
  in its three copies — the choice happens *before* normUrl, in content.js only:

      IDENT_HREF = canonicalPageUrl(location.href, <link rel="canonical">) || location.href
      URL_NOW    = normUrl(IDENT_HREF)

  and `URL_NOW`/`IDENT_HREF` are the only things sent anywhere (hello, `page_url` on
  every background message, /page, /thread, /reply, /snapshot). A site that rewrites
  its path with `history.pushState` as you move through one article therefore cannot
  splinter it into several records: a real navigation reloads the content script,
  which is precisely when the identity should be redecided, and nothing else can.
  `canonicalPageUrl` (adapters.js, pure, node-tested) is a stack of refusals — same
  origin and http(s), never the bare site root, and the address bar's path must be the
  canonical's path with extra characters glued onto its LAST segment (`/post-slug` ←
  `/post-slug-appendix-a`) or equal to it. A canonical that drops whole path segments
  (`/2026` ← `/2026/01/some-article`) is a hub page and is refused: merging a splinter
  is worth doing, merging two different articles is not. A site adapter owns its own
  identity (Google Docs), so canonical is not consulted there.
  Records that split before this existed stay split — there is no migration.
- Titles: `genericHeadline()` takes the first `<h1>` only on a page that has ONE.
  A long piece that uses `h1` for its section headings (appendices, chapters) is as
  likely to hand back "Appendix A" as its own name, so where several exist the page's
  `og:title` — which exists to answer exactly this — wins instead.
- Model and effort are PREFERENCES, not bridge state (`config.json` →
  `agents:{model,effort,model_options,effort_options}`, all per-agent). The bridge is
  a lazily-spawned child, so a setting that lived only inside it could not be chosen
  before the first message — which is precisely when anyone wants to choose it.
  `POST /model` and `POST /effort` therefore always store, and answer
  `{queued, applies:'now'|'at-wake'}`: a running bridge is also told at once (the same
  control turn as before), a sleeping one is **never woken for a setting**. Both
  broadcast `models` so other tabs follow immediately.
  At every wake the stored preferences are queued as control turns at the FRONT of the
  queue (`queuePrefTurns`, on the startup `ready`) — ahead of the turn that woke the
  bridge, so that turn is already answered under them. Safe there because a control
  turn is a bare slash command (no choreography, no envelope, no capture) and the
  child's model/effort are process-wide, not per-session: nothing it does moves
  `activeSid`, so the `/new` → capture rule is untouched, and at the startup `ready`
  nothing can be in flight to cut in front of.
  `GET /models` and the broadcast report the preference over the bridge's live answer
  (the live value lags a preference by exactly one control turn; the bridge fills in
  only where no preference has been stated). `status` stays strictly the bridge's.
  `*_options` caches the lists `completion_context` advertised, so the pickers still
  work — and POSTs are still validated — while the bridge sleeps; a companion that has
  never run the agents has no lists and its pickers are honestly dead. Every value is
  interpolated into a slash command on the bridge's stdin, so `normalizeAgents()`
  re-validates the whole block on every read (`[\w.-]` / `[\w-]`, lists capped): a
  hand-edited config.json cannot smuggle a second command in.
- Usage beacon (`beacon.mjs`). One anonymous GA4 Measurement Protocol event,
  `discuss_alive`, at most once per day, fired after `listen()` so nothing
  about serving waits on it. Payload is exactly
  `{client_id, non_personalized_ads:true, events:[{name, params:{app_version,
  engagement_time_msec}}]}` — no URL, title, annotation, handle, username,
  path, locale or counts. `client_id` is 16 random bytes minted once into
  `.botference/plugin/.beacon` alongside the last-ping timestamp; an id that is
  not 32 hex characters is discarded rather than trusted, so a hand-edited file
  cannot become a meaningful identifier. Three independent opt-outs, all
  checked before any network call: `BOTFERENCE_NO_TELEMETRY=1`,
  `"telemetry": false` in config.json, and an empty/placeholder `API_SECRET`
  (which is how it ships — a fresh clone never sends anything).
  `BOTFERENCE_TELEMETRY_SECRET` overrides the constant, which is how the tests
  exercise the send path without a secret existing in the repo. The day is
  stamped BEFORE the request, so a dead network costs one skipped day rather
  than a retry loop, and a failed send never surfaces.

- **Web PDFs** (`extension/pdf/`, `extension/vendor/pdfjs/`, the `pdf` adapter).
  A PDF on the open web is handed to the browser's OWN viewer, which is another
  extension's document: no content script runs there, `scripting` cannot reach
  it, and there is no DOM to select, wrap or anchor in. So the extension becomes
  the viewer. **http/https only in this round** — `file://` was refused because
  a path on one disk is not an identity a record can be filed under. (The
  "Local PDFs" amendment below keeps that reasoning and answers it: the
  identity is the file's BYTES, not its path.)
  · **Interception.** A dynamic `declarativeNetRequest` redirect rule, installed
    at every worker start (dynamic, not static, because the target carries the
    extension id): main-frame requests matching
    `^https?://[^#]*\.[pP][dD][fF](?:$|\?[^#]*$)` are redirected to
    `pdf/viewer.html#raw=<the whole matched url>`. MV3 has no blocking
    webRequest, so **nothing can read Content-Type before deciding** — the rule
    is url-shaped and that is the honest limit. `#raw=` rather than `?src=`
    because DNR substitutes the match VERBATIM and cannot percent-encode, so a
    PDF url with `&` in its query would be cut in half; adapters.js reads both
    spellings (`?src=` stays for the urls we build ourselves).
    **Known misses, all of them:** a PDF whose url has no `.pdf` (a
    `/download?id=…`, a Content-Disposition attachment, a viewer shell); a PDF
    reached by POST; `blob:`/`data:`; a `.pdf` url that is actually HTML (the
    viewer says so and offers the way back); and a `.pdf` navigation that would
    have DOWNLOADED now opens in the viewer instead (a Save-link-as download is
    not a main-frame navigation and is unaffected). The toolbar is the fallback
    for every one of them: an action click on an http(s) tab whose content
    script does not answer opens that url in the viewer, which is exactly the
    built-in-PDF-viewer case.
    One more limit, and it is first-install-only: dynamic rules PERSIST and are
    enforced with the worker asleep, so from the second browser start onward the
    redirect is live before anything can navigate — but the very first
    navigation after an install or an unpacked reload can beat
    `updateDynamicRules` and reach the built-in viewer. Reloading the tab is the
    whole of the fix; the toolbar button also opens it.
    `pdf/viewer.html` is therefore web-accessible, the
    permission `declarativeNetRequest` is required, and host permissions widen
    to `http://*/*` + `https://*/*` — an extension page must be able to FETCH
    the PDF (with `withCredentials`, for a paper behind a library login). The
    switch is `bfp:pdf` in extension storage (absent = on), on the options page;
    the worker installs or withdraws the rule when it changes. "Open it in the
    browser instead" asks the worker for a one-shot higher-priority `allow` rule
    scoped to that url, withdrawn after a minute — otherwise the escape hatch
    would be caught by the rule it is escaping.
  · **One viewport per page per layout** — the invariant, learned the hard way.
    PDF.js positions text-layer spans as PERCENTAGES of `viewport.rawDims`,
    which is the page's **unscaled** viewBox (612×792pt for Letter), and the
    vendored stylesheet sizes the layer as
    `--total-scale-factor × rawDims.pageWidth`. So `--scale-factor` is not "a
    zoom level": it is exactly `viewport.width / viewport.rawDims.pageWidth`,
    and `viewer.js` derives it from the very viewport object the page box, the
    canvas and the TextLayer were all built from (`--user-unit` is pinned to 1
    in viewer.css and folded into that ratio, so a UserUnit PDF needs no second
    knob). **The first release got this wrong**: the page box was sized from a
    viewport built at `PixelsPerInch.PDF_TO_CSS_UNITS × scale` while
    `--scale-factor` was handed the bare `scale`, so the text layer laid itself
    out inside a box 3/4 the width of the page it covered — text still
    selectable, every selection rectangle in the wrong place, bars in the
    margins and pooled blocks in the whitespace. The canvas was drawn at a third
    convention and CSS-stretched to fit, which is why the page still LOOKED
    right. `scale` now means "the argument to getViewport" everywhere, in
    points, and the CSS-units constant appears only in the zoom limits.
    `test/pdf-render.test.mjs` measures the invariant against the fixture's own
    PDF coordinates (margin 72pt, size 14pt) at fit, zoomed and refit;
    reintroducing the old two lines turns 9 of its assertions red.
  · **The viewer** (`pdf/viewer.html` + `viewer.js` + `viewer.css`) renders with
    PDF.js **including its text layer** — absolutely-positioned transparent
    spans over the canvas, which are ordinary text nodes, which is the entire
    reason anchor.js, drawer.js and content.js need no changes. It includes the
    same script chain the manifest injects, as plain `<script>` tags. Canvases
    are painted lazily (IntersectionObserver); **text layers are built for every
    page regardless**, in order, yielding between pages — an anchor on page 40
    must be findable whether or not page 40 has been looked at — and it is also
    why a highlight survives scrolling away and back: nothing is ever torn down.
    Zooming calls `TextLayer.update()`, which relayouts the existing spans in
    place, so a painted `<mark>` survives that too.
    The viewer tells the annotator to re-anchor (`window.__bfp.refresh()`,
    debounced) as each page lands, and re-posts `/page` only when the title
    actually changes (PDF `/Title` replacing the file name).
  · **Identity — the point.** The address bar says
    `chrome-extension://<id>/pdf/viewer.html…` and that is NOT the document. An
    adapter may now declare `identityHref`, which outranks `<link rel=canonical>`
    and `location` in content.js's `IDENT_HREF`; the `pdf` adapter reports the
    original http(s) url. `HOSTNAME` is derived from `IDENT_HREF` too (the site
    in the record, the drawer's per-site tab memory). Two latent bugs went with
    it: the port ping and the `whereami` answer sent `HREF`, so a canonical
    splinter registered the wrong routing key — both now send `IDENT_HREF`.
  · **Anchors gain an optional `page`** (1-based). It is stored beside
    `quote/prefix/suffix` and is **never consulted by `locate()`** — re-anchoring
    is the same whitespace-tolerant text search it has always been. Absent on
    every article thread and on every thread saved before this existed, and
    absent payloads behave exactly as before. `POST /thread` accepts `page`
    (number or numeric string; anything else is dropped), `store.addThread`
    stores it only when > 0, the Obsidian export writes it as the blockquote's
    attribution line (`> — p. 12`), and `/p/<key>` + the phone reader show the
    same words. content.js captures it at selection time from
    `SITE.pageOf(node)`; reader.js reads it back off the snapshot's `Page N`
    heading, so a highlight made on a phone carries one too.
  · **Text, once.** The adapter reads the text layer back out of the DOM rather
    than calling `getTextContent()` a second time, so the article text, the
    snapshot and the anchors all derive from ONE string. A line is a `<br>`
    (PDF.js emits one per end-of-line) and a run is a `<span>`; lines are
    whitespace-folded and empty ones dropped. Article text is `[page N]`-marked
    blocks, capped at the adapter's `TEXT_LIMIT`. The snapshot is
    `<section><h2>Page N</h2><p>line<br>line</p></section>` per page — text
    only, which is the honest fidelity for a PDF on a phone (no figures, no
    columns, no typesetting), and exactly what `sanitize.mjs` keeps. Because
    both sides are built from the same lines under the same page markers, a
    quote captured in the viewer re-locates in the snapshot and vice versa
    (tested three ways: pure, in the harness, and against real PDF.js).
    Hyphenation is left alone: a line ending `struc-` reads `struc- ture` in the
    quote, identically on both sides, which keeps the anchor exact.
  · **Two more adapter capabilities**, both defaulting to the old behaviour:
    `textFallback:false` (an empty `articleText()` is FINAL — a scanned PDF has
    text nodes, so highlights stay on, but scraping the DOM would hand the bots
    the viewer's own chrome) and `reportOrphans:false` (an anchor this page
    cannot find is badged locally and never POSTed to `/orphan` — a PDF renders
    page by page, so "not found" usually means "not yet"). A scan is announced
    once in the viewer and once at the composer (`SITE.contextNote`), and there
    is no OCR.
  · **Vendored** at `extension/vendor/pdfjs/`, pinned to **6.2.108**, the
    **legacy** build (transpiled, so `minimum_chrome_version: 116` stays true):
    `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `web/pdf_viewer.css`,
    `standard_fonts/`, `cmaps/`, `iccs/`, `wasm/` (no quickjs — PDF scripting is
    off, `isEvalSupported:false`). `content_security_policy.extension_pages`
    gains `'wasm-unsafe-eval'` for the three decoders. See
    `vendor/pdfjs/VERSION` for provenance and the upgrade steps.
  · **Testing.** `test/pdf.test.mjs` (pure: identity, extraction, the snapshot,
    the anchor round trip on strings, the record); harness `?pdf=1&selftest=1`
    (a synthetic text layer in a real browser, driving the whole loop) and
    `?pdf=scan` (the screenshot state); `test/pdf-render.test.mjs`, which runs
    REAL PDF.js on `test/fixtures/two-pages.pdf` over the DevTools protocol.
    The last one cannot use `--virtual-time-budget --dump-dom` like the harness
    does: PDF.js parses in a **worker**, whose clock virtual time does not
    advance, so the document promise never resolves and the page dumps empty.
    A real clock, a real wait. It skips itself where no Chromium exists.
    It also runs **the annotated-copy export end to end** (amended 2026-08-25)
    — real PDF.js, real `pdf-lib`, the viewer's own `exportAnnotated()`, on a
    web PDF *and* on a real `file:` one — gating only the Save dialog, which is
    the one thing headless Chrome cannot answer, and re-parsing the copy it
    captured. The local half is why the browser is launched with
    `--allow-file-access-from-files`: a `file:` document is the only way to
    take the LOCAL boot branch, and that branch is where the bytes are read.

- **Running a code block** (`run.mjs`, `POST /run`). Any fenced ```` ```python ````
  (or `py`/`python3`) block in ANY message — a person's or a bot's, in a comment
  thread, the page chat or the library — carries a quiet **Run** button in the
  drawer. Pressing it runs that snippet on this Mac with the reader's own
  privileges. There is no sandbox and nothing claims one; see "Safety framing"
  below, which is the whole of the story and is not to be embellished.
  · **The code that runs is the code that is STORED.** A request carries an
    ADDRESS, never a snippet: `{url, thread_id?, ts, author?, kind?,
    block_index}` — the same `store.resolveMsg` triple every other
    message-addressing endpoint uses — plus the block's 0-based ordinal. The
    companion re-parses that message's own text and takes the block out of it.
    Both sides number EVERY fenced block, python or not (drawer.js's
    `renderMarkdown` counts fences into `data-block`, `run.mjs codeBlocks` does
    the same on the server), so the ordinal cannot drift over a language tag;
    the language decides only whether a block may run (400 otherwise).
  · **One directory per run.** `.botference/plugin/runs/<pageKey>/<runId>/` is
    created fresh, holds `snippet.py` + a generated `sitecustomize.py`, and is
    the child's cwd. `python3` is spawned detached (its own process group), with
    stdin closed, a built environment (`PATH`, `HOME`, `LANG`, `TMPDIR`,
    `MPLBACKEND=Agg`, `PYTHONPATH=<run dir>`, `BFP_RUN_DIR`, unbuffered, no
    bytecode) and a 30s timeout (`PLUGIN_RUN_TIMEOUT_MS` for tests) that SIGTERMs
    then SIGKILLs the group. stdout and stderr are captured and cut at 64KB each
    with `…truncated (N bytes of output in all)`.
  · **Figures.** The generated `sitecustomize.py` wraps `matplotlib.pyplot.show`
    (found by watching imports) so it saves every open figure as
    `figure-NN.png` instead of trying to open a window, and saves whatever is
    still open at exit — so a snippet that never calls `show()` still produces
    its plots. Anything the snippet writes itself is picked up too: after the
    child exits, every `*.png`/`*.svg` in the run directory (≤8MB, ≤12 of them,
    name order) is the result's `figures`. matplotlib is NOT a dependency of
    anything here; without it a block simply prints.
  · **Message shape, extended compatibly.** A result rides on the message it
    came from, keyed by block ordinal:
    `msg.runs = { "<block_index>": {run_id, status, exit, signal, stdout,
    stderr, stdout_truncated, stderr_truncated, figures:[name], ms, python,
    ran_at} }`. `kind` stays `"msg"` — this is a FIELD, not a new kind of
    message — and every message written before this has no `runs` and behaves
    exactly as it always did. `status` is `ok | error | timeout | cancelled |
    failed`. Re-running a block REPLACES that entry and deletes the old run
    directory; deleting the message, the thread or the page deletes the
    directories of everything that went (`store.runIdsOf` / `deleteRuns`, and
    `deletePage` takes `runs/<pageKey>` whole); `/edit` drops a message's
    results, because a result under changed code is a claim about a message
    that no longer exists.
  · **Auth — owner only, end to end.** `GET /run` (is this on? `{enabled,
    timeout_ms, python}`), `POST /run`, `POST /run-cancel` (kills the process
    group; the timeout remains the backstop) and `GET /run-figure` are all
    behind `hosted.isOwner`, so localhost-direct and an authenticated remote
    OWNER may run code and a guest is refused with 403 — through a cookie, a
    bearer token, or any request wearing `PROXY_HEADERS`. The drawer asks
    `GET /run` once and only draws the button if the answer is yes, so a guest
    never sees it either. Figures are `GET /run-figure?key=<pageKey>|url=<enc>
    &run=<runId>&name=<basename>` (`&as=json` → `{mime, data_url}`), each
    argument validated into a shape that cannot leave the run directory. They
    are NEVER web-accessible or unauthenticated; the drawer fetches them through
    the background worker (which carries the credentials) and paints a data:
    url, because it lives inside somebody else's page. A page whose own CSP
    forbids `data:` images shows a one-line caption instead of the plot — the
    run is unaffected.
  · **Drawer.** The button is a 12px outlined control under the block, in the
    tools row's register rather than the composer's, titled exactly "Runs this
    code on this Mac as you". While a run is going the bar shows the drawer's
    own `◐` spinner and a `✕ stop`. Results render under the block: stdout in a
    mono block folded behind "Show all N lines" past 30 lines (the `.showmore`
    idiom), stderr in the same red the destructive confirms use, and figures as
    inline thumbnails that wrap (two-up past one). Clicking a thumbnail opens a
    lightbox over the whole viewport (the shadow host already covers it) — Esc
    or a click on the scrim closes it, one layer at a time, ahead of the
    drawer's own Esc.
  · **A COMPLETED RUN IS ALWAYS VISIBLY DIFFERENT FROM NO RUN.** Every result
    opens with one quiet 12px line (`.runstat`), and the exit status is the
    only part of it that changes register. A clean run reads `✓ ran · 79 ms` in
    the muted colour; a run that printed nothing at all — `doubling_time =
    log(2)/0.61` exits 0 in 79ms and prints nothing, which is a completely
    ordinary thing for a snippet to do — reads `✓ ran · 79 ms · no output`, and
    says it because otherwise it would say NOTHING and be indistinguishable
    from a button that is broken. A failure keeps its louder red line and gains
    the same timing (`exit 1 · 214 ms`, `timed out · 30 s`). The duration lives
    here rather than in the bar beside the button, so it is read WITH the
    result; the bar keeps only which interpreter answered (`python 3.12.4`).
    The line is drawn by the same `runResult()` as everything else under it, so
    a result stored on the message by a PREVIOUS session renders it on refetch
    with nothing clicked and no client state, exactly as the stdout does.
  · **Phone (`views.mjs`, `reader.js`).** Results — stdout, stderr, figures,
    and a lightbox in the article view — are shown READ-ONLY and **only to the
    owner**; a guest sees the message and no output at all. Deliberate: this is
    output from a program on somebody's own machine, and owner-only end to end
    is both simpler and safer than a per-run judgement. Nothing can be STARTED
    from a phone — the button lives beside the machine it runs on. `/a/<key>`'s
    CSP gains `img-src 'self'` for `/run-figure`.
  · **Export.** In "everything" mode a block's latest result is written under
    its fence: stdout (and stderr, labelled) as fenced `text` blocks, an
    `**exit N**` line when it failed, and figures COPIED into
    `<vault>/<export_folder>/attachments/<pageKey>-<n>.png` with ordinary
    `![figure n](…)` links, so Obsidian renders them and the note survives the
    workspace. A re-export replaces the copies (every `<pageKey>-*` is cleared
    first), exactly as it replaces the note. "Comments only" is unchanged: a
    result rides with its message, and bot messages and mention-bearing ones
    are already dropped.
  · **Safety framing, and no more than this.** Code — including code a bot
    wrote — runs with the reader's user privileges. The README says so plainly:
    treat it like pasting into your terminal, and prompt-injection through page
    content is a real vector. Nothing runs on its own: a block runs when the
    button is pressed and never otherwise. One line switches the whole feature
    off: `"run_python": false` in config.json (default true, absent = true)
    removes the button (`GET /run` answers `enabled:false`) and makes `POST
    /run` a 409.

- **Organising the archive** (`store.mjs`, `POST /rename-page`, `POST /tag-page`).
  A list of two hundred pages is only useful if it can be narrowed, and a page's
  own name is often not the name it deserves. Three fields on the page record,
  and nothing else moves.
  · **`kind`** — `article | pdf | gdocs`. The ADAPTER declares it (`SITE.kind`,
    sent with every `POST /page`), because the adapter is the only thing that
    actually knows: a PDF's record wears the PDF's url, not the viewer's, and no
    url rule could tell a Doc from an article reliably. For every record written
    before this existed there is no adapter to ask, so `inferKind(url)` answers
    from the url alone — a `.pdf` path, a `docs.google.com/document/` url, and
    otherwise `article`, which is the honest default. The backfill is **in
    memory, on the way out** (`readPage`, `readIndex`): no migration, no rewrite
    of records nobody has opened, and the next save persists it. A revisit
    replaces the inference with the adapter's word.
  · **`custom_title`** — the reader's own name for the page, `null` when they
    have not given one. `displayTitle(page) = custom_title || title || url` and
    it wins EVERYWHERE: the drawer's rows, the index (whose `title` is the
    display title, since every list is drawn from the index alone), `/pages` and
    `/p/<key>`, the Obsidian note's `# H1` **and its file name**, and the
    botference session behind the page. `POST /rename-page {url, title}`, owner
    only; an empty title is not an error but the way back — the page calls itself
    whatever it calls itself again. `POST /page` still refreshes the scraped
    `title` underneath, and can never undo a rename.
  · **The rename reaches the council chat lazily.** Renaming spends no turn and
    never wakes the bridge. `page.session_title` records what the chat was last
    called (stamped at `captureNewSid`); `planSteps` compares it with the title
    it is about to use and, when they differ, inserts one `/rename <title>`
    **after** the `/resume` (so the session being renamed is certainly this
    page's) and before the user turn, then writes the new `session_title` back.
    An absent `session_title` — every record written before this — reads as the
    page's own name, so an untouched page never renames.
  · **`tags`** — an array of short free-form strings, the reader's own filing.
    `POST /tag-page {url, tags:[…] | "a, b"}`, owner only, and
    `store.normalizeTags` is the single shaper: trim, collapse whitespace, drop a
    leading `#` (Obsidian's spelling, not ours), dedupe case-insensitively
    keeping the casing of the first one written, ≤40 chars each, ≤12 in all.
    Stored on the record and mirrored into the index row (omitted entirely when
    empty — the index is read on every list draw). The library is neither
    renameable nor taggable (400): it is one conversation with a name of its own.
  · **Export.** The note's H1 and its file NAME are the display title, so a
    rename moves the note — and `exportPage` therefore looks the folder up by
    URL first (`notesForUrl`, reading each note's `url:` frontmatter), writes the
    new file, and **deletes the file that held this url under its old name**,
    numbered variants included. One page, one note, whatever it has been called.
    Tags merge into the frontmatter beside `botference-discuss`, which is always
    first and never doubled; spaces become dashes and anything that would break
    the flow sequence is quoted (`tags: [botference-discuss, fluids, "a,b"]`).
    The library envelope names `tags`/`custom_title` in the record shape it
    describes, so a question about a topic can honour them.
  · **UI.** Drawer: a quiet chip row above the pages list — All · Articles ·
    PDFs · Docs, drawn only for the kinds present (plus whichever is selected,
    so a filter can never strand you), with counts — and a rail of every tag in
    use beside it; both filters combine, the head reads "N of M" while one is
    on, and the pair is remembered in extension storage (`bfp:pageFilter`, the
    same idiom as the tab, the width and the export mode). Each row carries its
    tags as chips (click to filter, in the rows and in the rail alike) and, for
    the owner only, `✎` and `#`: one inline box each, Enter saves, Esc closes the
    editor and not the drawer, and the tag box completes the token under the
    caret against every tag already in use (the @-menu's shape over a different
    vocabulary). Ownership is the companion's answer, not a guess:
    `GET /whoami` → background `{t:'identity'}.is_owner` → `drawer.setOwner()`,
    false until it says otherwise. Phone: `/pages?kind=&tag=` — the same two
    rails as ordinary links, because the reading room has no client state and a
    filtered archive should be a link worth sending; tags show on every row and
    tap to filter; `/p/<key>` carries the owner-only rename and tags forms as
    plain form posts (both routes accept form encoding and redirect back).

- **Three live-reported PDF/drawer bugs, and what each of them actually was**
  (`extension/pdfrules.js` is new: the decisions, pure and node-tested).
  · **"PDFs don't open consistently."** NOT the worker-restart window the
    theory suggested — that was tested directly (22 navigations with the service
    worker stopped immediately before each: 22 in the viewer; the single atomic
    `updateDynamicRules` shows no enforcement gap, and dynamic rules are
    enforced with no worker at all). The cause was **"open it in the browser
    instead"**. It installs a higher-priority `allow` rule for that exact url —
    a DYNAMIC rule, which persists on disk and is enforced with the worker dead
    — and removed it with a `setTimeout` **inside the MV3 worker**, which Chrome
    retires whenever it likes (this one holds a 30-second alarm, so it is
    retired and respawned constantly). Any teardown inside that minute stranded
    the rule permanently, and that one document then opened in the browser's own
    viewer for ever while every other PDF worked. The deadline is now WRITTEN
    DOWN (`bfp:pdf-bypass` in session storage, `{url, until}`) and swept from
    three directions — every worker start, every keepalive alarm, and the moment
    the navigation it existed for commits. The timer remains only as a fast
    path. `bypassExpired()` treats anything unreadable as expired, deliberately:
    a bypass that ends early costs one redirect the reader can repeat, one that
    ends late costs them a document that never opens in Discuss.
  · **The rule is now asserted only when wrong.** `applyPdfRules` reads
    `getDynamicRules()` first and `pdfRulePlan()` (pure) answers "nothing to do"
    when the store already holds the right rule — which, after the first
    install, is always. A worker wakes for every hello and every event; rewriting
    a rule on each of those was churn, and the write is the only moment the rule
    could be absent, so the window is closed by not opening it. A rule left by a
    PREVIOUS extension id, or with the wrong filter or resource types, is still
    rewritten.
  · **The belt.** A url-shaped rule has honest ways past it (the first
    navigation after an install, a PDF with no `.pdf` in its address, a bypass
    just spent). Rather than enumerate them, the OUTCOME is watched:
    `chrome.tabs.onUpdated` sees a tab land on a main-frame `.pdf` that is not
    our viewer — which means the browser's own took it — and reopens it in ours.
    Once per tab per url, off when `bfp:pdf` is off, and skipped (and the rule
    cleared) when it is the bypass the reader just asked for. `tabs.onUpdated`
    and not `webNavigation` deliberately: the `tabs` permission is already held,
    and asking for "read your browsing history" to reopen a file the reader
    just requested would be a poor trade. Verified with the redirect rule
    REMOVED entirely: the PDF still lands in the viewer.
  · **"Renaming its chat doesn't change the name in the header."** The viewer
    drew its bar once, from the PDF's metadata, and nothing ever told it
    otherwise. Two names are now kept apart: `window.__BFP_PDF_TITLE` is what
    the DOCUMENT calls itself (the adapter reports it, `POST /page` keeps it
    fresh underneath, and it is what a cleared rename falls back to), while
    `document.title` and the top bar show what the READER calls it. content.js
    applies the companion's own `displayTitle` rule (`custom_title || title ||
    url`) to every record it hands on, and publishes `window.__bfp.onTitle(cb)`
    — a subscription the viewer holds. A rename broadcasts `page`, which
    content.js already refetches on, so the bar, the tab and the drawer all
    change live, from any surface, with nothing reloaded. The adapter no longer
    reads `document.title` first, so a rename can never be written back as the
    page's own name. content.js also stopped MUTATING the record it was handed
    (it hands the drawer a copy carrying `own_title`), which is what made
    clearing a rename lose the document's name.
  · **"Companion offline" while the companion was up.** Two different facts
    shared one flag: "the companion answered" is an HTTP fact, "the live socket
    is open" is a WebSocket one — and a freshly woken worker answers
    `hello` with `connected:false` while every request works perfectly. That
    answer could also land AFTER a successful `GET /page` and overwrite it, so a
    healthy companion drew the full onboarding banner: a permanent verdict from
    a transient probe. It showed up mostly on PDFs because opening one is a
    fresh extension page, which is a fresh worker wake far more often than a tab
    on an article. Now only HTTP may say "offline", and only after `CONN_GRACE`
    (2) failures, each chased up by an automatic recheck at 700ms and 2s; the
    socket may only ever confirm. The drawer's existing soft state
    (`connKnown:false` → "connecting…") covers the gap, and a `conn` event
    clears the banner and refetches with nothing clicked. Shared layer, so
    articles get it too.

- **Local PDFs** (`file://`, and the identity that makes them possible).
  The papers people actually annotate are on their own disk. The reason they
  were refused was never the rendering — the viewer is the same viewer — it was
  that `file:///Users/me/Downloads/paper.pdf` is where a document IS, not what
  it is, and a record filed under a path is stranded the first time the file is
  moved into a folder or renamed after being read.
  · **Identity: the bytes.** A local PDF is filed under
    `bfp-pdf://sha256/<64 lowercase hex>` — the SHA-256 of the whole file,
    computed in the viewer with `crypto.subtle.digest`. It is a url in shape so
    that every layer beneath carries it unchanged: `normUrl` leaves it
    byte-identical (no query, no fragment, no trailing slash), `pageKey` is the
    ordinary sha1 of that, and store/server/export have always treated identity
    as a string (proved, not assumed: one round trip through `/page`,
    `/thread`, `/snapshot`, `/rename-page`, `/tag-page`, `/export`, `/p/<key>`
    and `/pages` in companion.test.mjs — **zero server changes were needed for
    the scheme itself**). `bfp://library` set the precedent; this is a scheme of
    its own so the two can never be confused, and `adapters.js` owns the
    constant.
    **The semantics, which are designed and not incidental:** the same bytes
    anywhere are the same page — move the file, rename it, keep two copies, sync
    it to another Mac; a MODIFIED file (annotated in Preview, re-downloaded as
    v2) is a different document and gets a fresh page, the old one keeping its
    comments under the old hash; and the same paper read from the web and from
    disk is two pages, because one is identified by a url and the other by its
    contents. The file itself is NEVER uploaded, copied or stored — the snapshot
    is the per-page text extract, exactly as for a web PDF, and that is what a
    phone reads.
  · **Identity moves FIRST — the boot path.** `viewer.html` no longer carries
    the script chain as `<script>` tags. content.js decides which page it is on
    ONCE, at parse time, and a local PDF's identity does not exist until its
    bytes have been read and hashed. So `viewer.js` is the only script the page
    loads: it injects `adapters.js` (the extension's only parser for a viewer
    address — a second copy of that rule is how the record and the render come
    to disagree), resolves the identity, publishes it on
    `window.__BFP_PDF_IDENT`, and only then injects the annotator —
    katex → anchor → drawer → content, `async = false` so insertion order is
    execution order. One boot path for both kinds of source; the http(s) case is
    unchanged in every observable way. `pdfIdentity(src, published)` is the
    whole decision, pure and tested: a url identifies itself, a file: source
    takes the published hash, and a file: source with NO hash has no identity at
    all — in which case the annotator is not injected and nothing is filed.
  · **Getting in.** DNR cannot redirect a `file:` navigation (it is not a
    network request), so the redirect rule is untouched and irrelevant here.
    Two ways in, both verified in a real browser: the **toolbar** (an action
    click whose content script does not answer → `openInPdfViewer`, now allowing
    `file:///…pdf`), and the **`tabs.onUpdated` belt**, which does deliver
    main-frame `file:` urls once file access is granted and reopens them in the
    viewer once per tab per url. The belt is gated on file access being known-on
    (`bfp:file-access` in extension storage): hijacking a PDF the browser was
    displaying perfectly well, into a viewer that can read nothing, would be
    vandalism. UNKNOWN counts as yes exactly once — the viewer then either works
    or names the toggle, and writes the answer down.
  · **Permissions, the minimum.** `host_permissions` gains `file:///*` — that is
    all. It is what lets the extension PAGE read the file; the content-script
    `<all_urls>` match already covers `file:` and was not widened. Neither
    grants anything by itself: Chrome's per-extension **"Allow access to file
    URLs"** switch is the real gate, cannot be set or prompted for by an
    extension, and is off by default. `chrome.extension.isAllowedFileSchemeAccess()`
    (extension pages only — it does not exist in a service worker) is asked on
    the options page and in the viewer, and the answer is stored for the worker.
    When it is off, both say the same sentence and never fail mutely:
    *Local PDFs need "Allow access to file URLs" — brave://extensions →
    Botference Discuss → Details → toggle it on.*
    The bytes are read with **XMLHttpRequest**, not `fetch` — Chrome's fetch
    refuses the `file:` scheme outright, while XHR is exactly what that toggle
    governs. A file: response has status 0 on success, so the response is what
    is checked.
  · **The record.** The adapter supplies `kind:'pdf'` as before and now also
    `site:'local pdf'` — `siteOf()` on the pseudo-url would answer `sha256`,
    which names an algorithm rather than a place — plus `file_name`, the file's
    own name (extension included, path never). `store.upsertPage` stores it and
    refreshes it on every visit, so re-opening the same bytes under a new name
    records the new name. `inferKind` answers `pdf` for a `bfp-pdf://` url, for
    a record read without an adapter to ask. Title, rename/`custom_title`, tags,
    filters, the pages list and the phone all work off the record exactly as
    they do for any page; the drawer and `/pages` show "local pdf" and "a PDF on
    your Mac" rather than a hostname or 64 hex characters, and a heading whose
    identity is not an address is not rendered as a link.
  · **Export.** The frontmatter `url:` carries the pseudo-url, because that is
    what a re-export matches a note on (`notesForUrl`/`targetFile`) and is the
    integrity of replace-on-re-export. Beside it, and only when there is one, a
    `file:` line names the file the page was opened from — a hash tells a reader
    nothing, and the frontmatter is where Obsidian shows it. Every note written
    before this is byte-for-byte unchanged.
  · **Nothing is annotated at a path.** With file access granted, `<all_urls>`
    makes content.js run on `file:` documents, so it now returns immediately on
    one (unless `__BFP_HREF` names another address — the harness's existing
    escape). Two reasons, both real: a record under a path has the identity
    problem this whole amendment exists to solve, and — found in testing —
    Chrome's built-in PDF viewer is an iframe inside an empty top-level document
    AT the file: url, where the content script does run and would ANSWER the
    toolbar's `{t:'toggle'}`, so the "no content script answered" fallback never
    fired and clicking the button filed the empty shell under its path.
  · **One neighbouring bug, fixed here.** `viewer.html` is an extension page, and
    `chrome.runtime.sendMessage` from an extension page reaches every OTHER
    extension context — including this same content.js in a second viewer tab.
    Chrome delivers whichever listener answers first, so an open viewer tab was
    answering its neighbour's `hello` with `{ok:false, error:'unknown'}` and
    that neighbour then sat dormant on a page it had annotations for. content.js
    no longer answers messages it does not understand; the worker's answer wins.
  · **Testing.** `test/pdf.test.mjs` (the hex formatter against known vectors,
    the pseudo-url, `normUrl`/`pageKey` stability, `pdfIdentity`, the adapter on
    both source kinds, and a real file moved and renamed on a real filesystem —
    same identity, same page key — then edited, and honestly a different one);
    `test/pdfrules.test.mjs` (`looksLocalPdfUrl`, kept a separate question from
    the redirect rule's shape); `test/companion.test.mjs` (the round trip);
    harness `?pdf=local&selftest=1` (the identity-before-chain contract with a
    stubbed digest, and that a hash published AFTER the chain changes nothing);
    `test/pdf-render.test.mjs` asserts the same contract in a real Chromium.

- **A content script that outlived its extension** (`content.js`, the context
  guard). Reloading the extension ORPHANS every content script already running.
  The JavaScript keeps executing — its closures, its DOM, its timers are all
  intact — but the `chrome.*` bridge it was injected with is gone, and every
  call through it now throws `Extension context invalidated`. Those throws are
  UNCAUGHT (they come out of `getURL` and out of message callbacks), so a tab
  left open across a reload fills its console with red on a page whose reader is
  simply reading; the one people hit is `ensureMathFonts`, because it is on the
  activate path and `chrome.runtime.getURL` on a dead context throws rather than
  answering.
  · **There is nothing to repair from.** A content script cannot re-inject
    itself; only a reload of the TAB puts a live one back. So the whole
    behaviour is: notice once, say so once, go quiet — one `console.info`,
    `Discuss was updated — reload this tab to reconnect.`, and then the port
    retry and the liveness interval are cleared so the one line stays one line.
    No banner: the drawer's own "offline" state is a claim about the companion,
    which is a different fact and is very possibly still true.
  · **The rule is a factory, not a flag.** `makeContextGuard(probe, say, stop)`
    has nothing of chrome in it — `probe()` answers whether the extension is
    still ours (`chrome.runtime.id`, read inside a try: an orphan still has a
    `chrome.runtime`, what it has lost is the id), `say` is where the line goes,
    `stop` is what should stop running. `run(fn, fallback)` is the only entry
    point, and it **rethrows anything that is not a context invalidation** — a
    blanket catch here would bury ordinary bugs, which is a worse console than
    the one being fixed. Every chrome-touching entry point goes through it:
    `extUrl` (hence `ensureMathFonts`, `cssUrl`, `katexCssUrl`), `bg()` before
    and inside the `sendMessage` callback, `connectPort`/`pingPort`,
    `consumeAutoOpen`, and the `onMessage` listener registration.
  · **Testing, honestly.** A real invalidation needs a real extension reload,
    which no harness can stage — nothing below asserts that Chrome's own throw
    is caught in the wild. What IS tested, and is where the logic lives, is the
    factory: harness `?selftest=1` builds its own guards over a fake probe and
    asserts the fallback, the once-only line, the stop, the second call being
    silent, the probe-noticed case with no throw at all, both spellings Chrome
    has used, an unrelated failure NOT being mistaken for one, and a `TypeError`
    coming straight back out. The page's own guard is left alone (tripping it
    would take the rest of the selftest with it) and asserted never to have
    fired.

- **The tab icon** (`GET /favicon.ico`, `views.FAVICON_LINK`). The hosted views
  wear the same braid the extension wears in the toolbar: `extension/icons/
  icon128.png`, served byte-for-byte from `/favicon.ico` and `/favicon.png`
  (a png under the `.ico` name, which every browser since IE has accepted, and
  which saves carrying a second copy of the same picture). `/pages`, `/p/<key>`,
  `/a/<key>` and the sign-in gate all carry the `<link rel="icon">`; `/a/`'s
  strict CSP already allows it under `img-src 'self'`.
  · **Ahead of the gate, on purpose.** Browsers ask for `/favicon.ico` whether
    or not a page linked one, so a gated icon is a 401 in the network log of
    every view AND a blank tab on the sign-in page itself. An extension's own
    logo is not a secret, and the route reads exactly ONE fixed path — there is
    no name to smuggle past the gate through it. `test/companion.test.mjs`
    asserts the bytes, the content-type, the cache header, the link in the
    views and in the gate, that it answers unauthenticated over a tunnel Host,
    and that `/index`, `/pages` and `/assets/*` are still 401 beside it.

- **The chat reads the snapshot** (`chat.mjs` envelope, `server.mjs` summon).
  The bots used to see a page through two caps in series — the adapter's
  `TEXT_LIMIT` (12k, walked from page 1) and the envelope's `ARTICLE_MAX` (6k)
  — which on a 15-page PDF is pages 1–2, whatever page the comment sat on,
  while the FULL text already sat on disk as the page's snapshot. So where
  `.botference/plugin/snapshots/<pageKey>.html` exists (checked with
  `store.hasSnapshot` at the moment the turn is planned, `planSteps` — a
  snapshot that lands while the turn queues counts, and one deleted meanwhile
  is simply not named), the envelope names that file's ABSOLUTE path and
  instructs the bot to READ it for anything beyond the inline text, stating
  the file's shape (sanitized HTML; a PDF has one `<section>` per page, each
  headed "Page N"). The route is the library's, copied deliberately: reads are
  pre-allowed (claude runs `permissions.defaultMode:"dontAsk"` with a
  Read/Glob/Grep allow list, codex a workspace sandbox over the same roots;
  the companion's deny-all permission gate only ever sees WRITE requests), so
  a named path costs no prompt and no new permission surface.
  · The inline slice stays, for orientation, but drops to `SNAPSHOT_INLINE`
    (2500 chars) on snapshot-backed turns. Without a snapshot the envelope is
    byte-for-byte what it always was — `ARTICLE_MAX`, the first-turn /
    `article_changed` rules unchanged — and a missing file is never an error.
  · The path line rides EVERY turn on a snapshot-backed page, not only the
    first. The envelope is rebuilt per turn anyway, the line costs two of
    them, and a turn is the only thing a resumed session is guaranteed to be
    carrying: a `/resume`'s replayed history is uneven and a bridge restart
    drops it entirely. (First-turn-only was the alternative and was rejected
    for exactly that.)
  · Page locality rides beside it: an anchored thread on a paged document
    already stores its `page` (the web-PDFs amendment — nothing new travels
    from the extension), so `summon` hands `thread.page` to the turn and the
    envelope adds "This comment is on page N of the document." under the
    quote. Page chat and unpaged threads say nothing; replies inherit the
    thread's page, which is the page the conversation is anchored to.
  · Articles benefit identically — same code path, no PDF special-casing
    beyond the sentence describing the section-per-page shape.

- **Local PDFs, round two: the identity is the WORDS, not the bytes**
  (`extension/adapters.js`, `extension/pdf/viewer.js`, `store.mjs`, `export.mjs`).
  The byte-hash identity above survived moves and renames and then met Adobe
  Acrobat, which rewrites the file's bytes on every save: one sticky-note
  comment and the page re-keyed, the chat "lost", three times in one day. The
  bytes were never what the reader meant by "this paper". Its TEXT is.
  · **The durable identity is a new scheme variant:**

        bfp-pdf://text/<64 lowercase hex>

    — the SHA-256 of the document's extracted text, normalized: the text-layer
    lines the extension already derives everything from (whitespace-folded,
    trimmed, empties dropped — `pdfLayerLines`), all pages, joined with single
    spaces, whitespace collapsed once more, trimmed (`pdfNormalizedText`,
    adapters.js — pure, node-tested). Annotating, form-filling, re-saving,
    renaming, re-downloading the same document leaves the page text alone →
    same identity, the chat follows the paper. A genuinely revised document
    (its text changed) is a NEW page with a fresh chat, deliberately: no fuzzy
    matching, ever. normUrl leaves the new scheme byte-identical exactly as it
    leaves `bfp-pdf://sha256/…`, and normUrl itself is untouched.
    **Why a new scheme and not sha256-as-label with aliases:** the text url is
    a pure function of the file, so the viewer can decide the identity locally,
    before the chain, with the companion offline — an alias table would have
    made identity a server round trip and a downed companion a split identity.
    Records are kept safe by making adoption (below) the companion's one
    careful move rather than smearing aliasing through every endpoint.
  · **Scans keep the byte hash.** A PDF with no text layer has no text to
    hash; it stays `bfp-pdf://sha256/<bytes>` with exactly the old semantics
    (an edit re-keys it — the honest answer when the words cannot be read).
    Both spellings are legal local-PDF identities everywhere
    (`isPdfIdentUrl`); a parse failure (password refused, corrupt file) also
    falls back to the byte hash, uncached.
  · **The byte hash stays as the fast path.** `bfp:pdf-ids` in
    `chrome.storage.local` maps byte-hash → identity (capped at 400, oldest
    dropped). A cache hit skips extraction entirely, so reopening an untouched
    file boots exactly as fast as before. Extension storage and not the
    companion, deliberately: the map caches a DETERMINISTIC function, so losing
    it (reinstall, another machine) costs one re-extraction and can never
    re-key a page — and the fast path keeps working with the companion down.
  · **Boot order** (viewer.js) keeps identity-before-chain: on a cache hit the
    boot is byte-for-byte yesterday's (publish → inject → render). On a miss
    the document is RENDERED FIRST — the annotator is not injected, so nothing
    can register under a provisional identity — and the identity is computed
    from the same DOM lines the snapshot and the anchors use, then published,
    then the annotator injected. First open (and the open after each Adobe
    save) pays one full text-layer pass before the drawer exists; every other
    open is a cache hit. Web PDFs are untouched: a url identifies itself.
  · **Adoption: existing byte-hash records migrate, once, automatically.**
    The companion cannot rehash bytes it never kept — but it kept the
    SNAPSHOT, which is built from the very lines the text hash is a digest of.
    `store.readPage()` on a `bfp-pdf://text/…` url with no record asks every
    `bfp-pdf://sha256/…` record with a snapshot (newest first) whether its
    snapshot's normalized text (`snapshotPdfText` — h2 page labels dropped,
    tags to separators, entities unescaped, whitespace collapsed; hashes
    memoized by snapshot mtime) matches; the first match is MIGRATED to the
    text url: record rewritten (atomic write), snapshot and runs directory
    renamed to the new pageKey, index row moved, old page file removed last,
    threads/session/tags/rename/created_at all intact, and the old identity
    kept on `prior_urls`. This is why the reader's live record survives even
    though the file's current bytes match nothing: the words still do. An old
    record WITHOUT a snapshot cannot be matched and is left alone (its rows
    stay listed; nothing is deleted). Two old records with the same text: the
    most recently updated one is adopted, the others are never merged — merges
    are the reader's call. And because the index still holds the OLD row until
    adoption runs, `hello` would answer known:false on the first open —
    content.js therefore probes `GET /page` once for a dormant
    `bfp-pdf://text/…` page (the read is what adopts; page:null creates
    nothing and dormant stands), so the migrated paper's highlights restore on
    the very first open with nothing clicked.
  · **Export follows the migration.** `exportPage`/`targetFile` match a note
    by the page's url OR any `prior_urls` entry, so the note written under the
    byte-hash identity is replaced, not duplicated with a " (2)". The
    frontmatter `url:` is the current (text) identity.
  · This block supersedes the byte-hash amendment's sentence "a MODIFIED file
    is a different document": modified BYTES with the same text are the same
    page now; modified TEXT is a new one. Everything else there stands.

- **No record until the reader acts** (`extension/content.js`). Visiting a
  page used to file it: activation (a toolbar click, or merely selecting text)
  POSTed `/page`, the companion wrote `pages/<key>.json` and an index row, and
  the library filled with search results, checkout pages and feeds — browsing
  history persisted to disk. Wrong UX, wrong privacy posture. Now nothing is
  written anywhere until the reader ACTS on the page.
  · **Registration is simply not sent.** The extension keeps a `registered`
    flag: true only once `GET /page` has answered with a real record. An
    unregistered page never POSTs `/page` (activation and the viewer's title
    refresh both hold their fire); the drawer still opens instantly and works
    normally off the locally-built record, exactly as it always did when
    `/page` answered `page:null`. Client-side and not a companion holding
    transient shells, deliberately: the companion needs no new state, no
    restart-loses-the-shell edge, and a page that was never spoken about never
    crosses the wire at all.
  · **The acts that earn the record**, each of which first awaits
    `ensureRegistered()` (one `POST /page` with the real title/site/kind/
    file_name): saving a comment thread, sending a page-chat reply, and
    exporting the page. Rename and tag presuppose an index row and therefore a
    record, so they cannot reach an unregistered page by construction; the
    library keeps its own lazy creation (`ensureLibrary`) and a library
    message registers nothing about the page it was typed on. Deleting the
    page you are on drops the flag again, so a deleted page does not
    resurrect itself on the next visit — which the old on-activation upsert
    quietly did.
  · **The snapshot defers with the record, and lands BEFORE the first turn.**
    On the first-ever action the client awaits, in order: `POST /page`,
    `POST /snapshot`, and only then the `/thread` or `/reply` that may summon
    the bots — so by the time the companion queues (let alone plans) the turn,
    the record and the snapshot are both on disk and `planSteps`'
    `hasSnapshot` check finds the full text ("The chat reads the snapshot" is
    strictly better off than before, when the snapshot raced the first turn).
    A failed snapshot never blocks the message (a guest's 403, an oversized
    page); later snapshots keep the existing changed-prose cadence.
  · Existing junk rows are NOT deleted — the owner sweeps those. `/index`,
    `/pages`, `/p/<key>`, `/a/<key>` need no changes: a never-persisted page
    is simply unknown (404 by key), and every list draws from the index, which
    only ever hears about pages that earned themselves.

- **A tag's color is its name** (`drawer.js tagHue`, duplicated byte-for-byte
  in `views.mjs` exactly as normUrl is — test/tags.test.mjs holds the copies
  together). FNV-1a over the lowercased, trimmed name → a hue 0..359; the
  THEME owns saturation and lightness (`--tag-fg-l/--tag-bg-l/--tag-line-l`,
  light 30/93/72, dark 80/20/36 — the same four constants in drawer.css and
  the phone's stylesheet), and every one of the 360 hues clears WCAG AA 4.5:1
  under them, asserted for all 360 in both themes. Same tag = same color on
  every surface: the drawer's row chips, the tag rail, the completion menu,
  and the phone's `/pages` + `/p/<key>` rails. No picker, no persistence, no
  export change (frontmatter tags stay plain — Obsidian has its own ideas
  about color). Selection ("on") is a full-strength border on the same hue,
  never a different color. And picking beats remembering: the tag editor's
  completion menu now renders its candidates as those same colored chips, the
  input opens with an EMPTY token (the row's existing tags are seeded with a
  trailing ", "), and an empty token offers every tag in use — so focusing
  the box shows the whole in-use palette, click or Tab/Enter to apply, the
  @-menu's keyboard manners throughout.

- **Who is speaking is a colour AND a typeface** (the council web chat's
  grammar, ported so the two surfaces read as one product). Claude writes in
  `--font-claude` (the serif), Codex in `--font-codex` (a grotesque), everyone
  human in the drawer's own sans; `agentOf()` is the single rule that decides
  both the class and the colour, so the two can never disagree. Colour alone
  dies on a greyscale screen and at the speed of a scroll; type alone is too
  quiet at 14px. **The reader's own turns are `--you`**, not a hash of their
  handle (`speakerColor`) — green ground, green right edge where every other
  message wears a left rail, and set in from the left, so "what did I ask?" is
  findable without reading. Every OTHER handle on a shared companion keeps its
  deterministic hue. Both themes, and note the two colour triples: `--mark-*`
  is the braid MARK (the values `icons/make-icons.mjs` rasterises the toolbar
  icon from — identical in both themes, because a mark that changes colour
  stops being the same mark), while `--claude/--codex/--you` are the SPEAKERS
  and are re-picked per theme against their own paper. Fonts are system stacks
  only: a content script must never load a webfont.
- **Every message copies out in two flavours** (`doCopy`): the rendered HTML,
  so a paste into a document keeps the links live, and the raw markdown the
  author wrote (`data-raw`, set by `fillMarkdown` from the envelope-stripped
  source), so a paste into a text field is what was typed. `ClipboardItem`
  first; where it is missing — plenty of host pages are plain http — both
  flavours still go over through a `copy` event on a textarea of the drawer's
  own inside the shadow root, so the host page's DOM is never touched. The Run
  bar and its output never travel; `.acts` and `.runbar` are `user-select:
  none`, so dragging a selection across a message picks up prose and nothing
  else.
- **A leaked room-protocol footer renders as a chip, never as raw JSON**
  (`splitEnvelopes` → `.envrow`). Free-form mode has every bot end its turn
  with `{"status","next","writer","summary"}`; the controller strips a
  well-formed TRAILING one, but a pretty-printed, mid-message or half-streamed
  one reaches the drawer — and here the prose is PERSISTED, so a leak is
  permanent. One deliberate exception: an envelope inside a fenced code block
  is left exactly where it is, because the Run button addresses a block by its
  ordinal among the fences of the stored text (`run.mjs codeBlocks` counts the
  same way) and removing or hollowing out a fence would run the wrong code.
  test/envelope.test.mjs holds that line, and the checkbox ordinals with it.

- **A thread can be RESOLVED, and resolving never hides a passage.** A page
  collects comments faster than anyone works through them, so the reader marks
  one handled: the card leaves the main list for a single collapsed "Resolved
  (N)" section at the FOOT of that list (never a tab, never a filter), and the
  highlight on the page stays exactly where it is and turns from yellow to a
  desaturated sage green (`anchor.js HL_BG_DONE`, `mark.bfp-hl.bfp-done`,
  `--done/--done-line` per theme in drawer.css and the phone's stylesheet).
  Deliberately NOT the braid's mint `--you`: a handled annotation and a person
  speaking must not read as the same thing. Green marks stay clickable and
  click through to their own thread — `drawer.focus()` opens the archive and
  unfolds that card, so the reveal is part of focusing rather than something
  every caller has to remember.
  - **It is TRIAGE, so it costs one click.** A quiet ✓ sits beside the ✕ on
    every thread row — no menu, no dialog, no confirmation anywhere in the
    path (Reopen is the undo, and it is one click too). The card moves
    optimistically, the Comments count is the count of OPEN threads so the
    list visibly shrinks, and a refusal puts card and highlight back.
  - **New activity is the end of resolved.** `store.appendMsg` clears the
    flag, so the reader replying, the reading room's composer and a bot's
    answer off the bridge all reopen a filed thread through one rule.
  - **A filed card is a digest, not a dimmed thread**: the quote, then 3–5
    sentences saying what was asked and what came of it, with the full thread
    folded away underneath and expandable in place. The summary is written
    twice — `store.threadDigest` puts a deterministic placeholder in the same
    request as the flag (triage never waits on an agent), and a SILENT summary
    turn (`job.summary`, `chat.summaryPrompt`) drains behind whatever else the
    bridge is doing and replaces it. That turn's answer is never appended to
    the thread — it leaves chat.mjs as a `summary` event and lands in the
    `summary` FIELD — because a message would reopen the very thread it
    describes. A reopen cancels nothing: the paragraph lands unused, which is
    also what makes a re-resolve instant.
  - Server state throughout (`/resolve`, `/summarize`), so the green survives
    a reload and reaches the phone and the other machine. The reading room
    gets the same two states out of `<details>` and a form post; the Obsidian
    note says *Resolved by …* and carries the paragraph; and the library
    prompt tells the agents what a resolved thread means so an archive of
    filed threads is not read back as a pile of open questions.

- **The tasks card: the current checklist, at the top of the drawer**
  (`drawer.js taskSource/taskCardHtml/fillTasks/jumpToTasks`, `.tasks` in
  drawer.css). The bots write and rewrite markdown checklists as a plan moves,
  and the live one ends up wherever the conversation left it — twenty replies up
  a comment thread, or above a bot turn in Page chat. So the top of the drawer
  carries the checklist from the **newest message on this page that has one**,
  across every comment thread AND page chat, and a revised list **replaces** it:
  there is exactly one list there and it is the current state. No list anywhere
  on the page → no card.
  - **Derived, never stored.** `D.tasks` is recomputed from the record by every
    `render()` — the paths a message arrival, a tick, a refetch and a `setPage`
    already go through — so nothing polls, no event changed shape and no copy of
    a list exists anywhere. Each conversation is scanned from its END and
    abandoned at its first hit (its own array order is authoritative), and the
    winner is the newest by timestamp, with page chat taking a tie because two
    messages can share a millisecond. A **restored** message
    (`restored:true`, `ts = "<sid>#<n>"`) sorts below everything live: its `ts`
    is an address, not a date, and the council chat it came out of predates
    every message on the page.
  - **Its checkboxes are the transcript's own.** The card is rendered from the
    source message's text and keeps `data-tick` — the ordinal over that whole
    message — so a box in the card addresses exactly the box the transcript's
    does and goes through the same `POST /tick` (`doTick` reads the address off
    the card instead of off a `.reply`). Optimistic flip, authoritative body
    back, one `render()` and both renderings agree by construction. The card
    holds no checkbox state of its own; there is nothing to keep in sync.
  - **A restored council list is READ-ONLY**, in the card and in the transcript:
    ticking it would mean editing a session this companion does not own, so the
    boxes are disabled with a hover reason and the card says *"from the council
    chat — tick it there"*. `↑ source` still works. (The transcript's restored
    replies carry `data-restored` and are locked by `lockRestored()` for the
    same reason they are offered no ✎ and no ✕.)
  - **Both panes, at the top of each.** The tab bar sits above the panes and each
    pane scrolls alone, so there is no shared strip to pin one card to — and a
    list that came out of a comment thread is exactly what a reader typing in
    Page chat needs. Both copies come from the same message text. Not in the
    Pages view, which is about other pages.
  - **Meta and jump.** One quiet line: who wrote it · `n/m done` · the thread's
    quote or "page chat" (the fold's own line keeps the count). `↑ source`
    crosses to the right tab, unfolds the thread (`D.expanded → FOLD_OPEN` —
    an older list is exactly what a long thread hides), spotlights the card
    through the existing `focus()`, and flashes the message itself
    (`.reply.tasksrc`). The fold is session state like every other reading
    position in the drawer (`D.tasksOpen`), never persisted.
  - Tests: harness `?selftest=1` (the card appears, newest wins, a revision
    replaces it, a card tick is the same `/tick` as a thread tick and both
    renderings move, a thread-sourced list and its jump, the fold, the card
    disappearing with its list) and `?workspace=1&selftest=1` (a restored list,
    read-only, shown though its message is folded away). Screenshot states:
    `?tasks=1` and `?tasks=1&folded=1`.

## Project artifact pages (Phase 1, shipped)

A council chat writes HTML into its own project folder —
`<council>/projects/spaceship-engineering/index.html` — and the reader opens it
as a `file://` page. Those pages are first-class Discuss pages, **zero-config**,
and the chat behind them is the REAL council chat that produced them.

**Identity is the PATH, deliberately.** Everywhere else in this contract a
local file is identified by the hash of its bytes and content.js says at length
why (a path is where a thing is this morning). A project artifact gets the
opposite rule and for the same reason: these files are regenerated in place —
that is what the project is *for* — so under a content hash every rebuild would
be a new page and every annotation would be stranded by the next build. The
path is what is stable: `projects/<id>/index.html` is the artifact, whatever it
currently says. `normUrl` handles `file:` urls unchanged and must keep doing so
in all three copies (background.js, content.js, store.mjs).

### Detection (workspace.mjs, companion)

- A **council root** is a directory holding all three of `project.json`,
  `work/` and `projects/`. Any one alone is an ordinary directory.
- A file: url is a **project artifact** iff: it names an existing `.html`/`.htm`
  file; walking up from it (≤24 levels, nearest wins) finds a council root; the
  file sits under `<root>/projects/<id>/`; and that project folder still
  exists. A deleted project ends the page.
- The project **title** comes from `<root>/projects/portfolio.json`, falling
  back to the folder name.
- Symlinks are resolved on both sides of every comparison (`realish`).

### The one-time council confirmation

A directory with three familiar names in it is a hint, never a licence: what
hangs off a yes is a bridge spawned with that folder as its workspace. So the
first time a NEW root is seen the drawer asks, once, and the answer is kept in
the plugin's own `config.json` as `council_roots: {"<abs path>": true|false}`.
A **no** is kept as firmly as a yes — the extension does not attach to pages
under that root again. Nothing is ever written inside a council root by the
companion; only botference itself writes there, saving the session.

### HTTP API (owner-only, all four — the answers are paths on this machine)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/project-page?url=<enc>` | — | `{ok, artifact:{root, project_id, project_title, rel, path, confirmed, declined, via, ident_href?} \| null}` |
| POST | `/council-root` | `{root, confirm:bool}` | `{ok, root, state:"yes"\|"no"}` (400 if not a council root); broadcasts `{"type":"council-root", root, state}` |
| GET | `/project-sessions?url=<enc>` | — | `{ok, project_id, project_title, root, current, sessions:[{session_id,title,updated_at,created_at,entry_count}]}` (409 unconfirmed) |
| GET | `/project-session?url=<enc>&sid=` | — | `{ok, session:{session_id,title,updated_at,project_id,msgs,truncated}}` |
| POST | `/project-chat` | `{url, sid}` or `{url, new:true}` | `{ok, session_id, session_title, page}` |

The archive is read from `<root>/work/sessions/.metadata-index.json` — the same
cache botference's own project panel is built from, so the list agrees with the
TUI without parsing a transcript — plus any `projects/<id>/sessions/*.json`,
with `projects/session-index.json` backfilling chats whose payload predates the
`project_id` field. Chats with no turns are left out, as the panel leaves them
out. A `sid` is checked against `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` before it
addresses a file.

### The second bridge

`createChat({onEvent, root, projectOf})`. `root` is `BOTFERENCE_PROJECT_ROOT`
for the child (`BOTFERENCE_HOME`, page records, config and the task file all
stay put — they are the plugin's, not the council's). `projectOf(url)` answers
`{id, title, path}`.

- Ordinary pages: unchanged — `/project create Plugin pages` → `/project open
  plugin-pages`, once per child.
- A workspace bridge **never creates a project** (it exists — that is the
  premise) and re-opens on every change: `/project open <id>` whenever the
  project differs from the last one this child opened, because one council root
  can hold artifacts from a dozen projects.
- One bridge per council root, lazy, kept alive, never sent `/quit`. The
  deny-all write gate stays on: file writes are Phase 2.
- The **lazy rename never fires on a project artifact**. That chat has a name
  the council gave it; a page whose `<h1>` differs is not evidence the reader
  wanted it renamed. Only a chat the page itself created is renamed, once.
- `/delete-page` never deletes a council session. Forgetting the page must not
  destroy the project's chat.
- `/health` and `/models` report `running` if ANY bridge is up; `queue` is the
  sum. `/model`, `/effort` and `/relay` are imposed on every awake child.
- Envelope: a project artifact's first-turn banner is
  `[project artifact: "<title>" · project <name> (<id>) · <abs path>]` followed
  by "This file is in your workspace — READ it for anything not shown below."
  rather than the `[web page: …]` banner.
- An **unconfirmed** root routes to no bridge at all: the comment is kept and
  `{queued:false, reason}` says why.

### Page chat becomes the project's chat archive

Opening a past chat is a companion-side move of the page record's
`session_id` — which is ALREADY the whole of the resume machinery (chat.mjs
plans `/resume` when it is set and `/new` when it is not). So nothing new was
invented: `POST /project-chat {sid}` sets `session_id`/`session_title` and
replaces `page_chat` with that session's recent tail; `{new:true}` clears all
three. What renders under the archive bar is an ordinary page record, so the
fold (head + tail + "Show N earlier replies"), the composer and the streaming
are untouched.

Restored messages (`restored:true`) came out of a session record, not out of
this companion's page file. They are offered no edit and no delete (nothing
here owns them), and their `ts` is an ADDRESS (`<sid>#<n>`) rather than a date —
so `when()` renders nothing rather than inventing a time the transcript never
recorded. A user turn that carried a drawer envelope has it taken back off
(`workspace.stripEnvelope`); a chat typed in the TUI passes through untouched.

### Extension

- content.js still refuses `file:` documents, with one exception: an HTML
  document (contentType `text/html`, no top-level `<embed type=application/pdf>`
  — both guards are about Chrome's PDF shell) whose url the companion confirms
  is a project artifact. That is the file's ONE `await` during boot; every
  other page still wires itself up synchronously.
- Such a page is **never dormant**: it activates on load (drawer shut) like an
  annotated page.
- `HOSTNAME` — and therefore the record's `site` and the drawer's per-site tab
  memory — is the project id, because a file: url has no hostname.
- Drawer: `opts.project` / `d.setProject(p)`; header line "part of project
  <name>"; callbacks `onConfirmRoot(bool)`, `onProjectSessions()`,
  `onOpenSession(sid|null)`. Switching chats clears that target's outbox,
  streams, note and spinner — they belonged to the conversation that left.
- `test/harness.html?workspace=1` (plus `&unconfirmed=1`) is the visual QA
  state; `window.__BFP_PROJECT` is the same isolated-world escape
  `__BFP_HREF` is.

Phase 2 (below) makes the write gate conditional for exactly these pages and
adds the reload.

### Amendments (2026-08-18, shipped)

- **Both sessions layouts are read.** `workspace.mjs` resolves session
  stores from `<root>/work/sessions` (project-local layout) AND
  `<root>/sessions` (the legacy self-hosted layout the original vault
  runs), for the metadata index and the payloads alike; work/sessions
  wins when a sid appears in both. The live spaceship-engineering root
  is legacy-layout — code that only knows work/sessions lists nothing.
- **The restored-tail note.** `sessionTail` returns `total` (renderable
  messages in the whole chat, system lines never counted) and
  `/project-chat` persists it as `page.session_total`. Over a restored
  chat the drawer renders one line — "Restored council chat — the last
  N of TOTAL messages" — with a link to the complete chat in the
  council web UI: `<council_web>/?chat=<sid>`, target _blank.
  `council_web` rides the `/project-page` artifact payload, from the
  companion config key `council_web`, default `http://localhost:4187`.
  There is deliberately NO in-drawer "load earlier" paging: a
  400-message read belongs in the council UI, and the link is the
  feature.

### Phase 2 (2026-08-18, shipped): the bots may edit the project

On a **confirmed project artifact page** the bots may create and modify files
under **that project's folder** — `<root>/projects/<id>/` — and nowhere else.
Not the council root, not another project, not `corpus/`, not `work/`, not the
companion's own state, not the rest of the disk. Owner and localhost only:
nothing about hosted mode or a guest changes, because a guest never reaches
`chatFor` at all (`/reply` from a guest is stored, and the bridge that answers
it is the owner's). Ordinary web pages, PDFs and library chat keep deny-all
writes exactly as before.

#### Where the scope is enforced, honestly

The scope is decided when a bridge CHILD IS SPAWNED, not per turn and not per
file. `createChat({writeRoot})` (chat.mjs) passes the project directory as
`BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS`, which `core/cli_adapters.py`
(`planner_write_roots_for_env` → `planner_write_config`) turns into the CLIs'
own configuration:

| | what the CLI is given | what it mechanically prevents |
|---|---|---|
| **claude** | `cwd` = the project dir; `permissions.allow` = `Read, Glob, Grep, Bash, WebSearch, WebFetch` plus `Edit(//<dir>)`, `Edit(//<dir>/*)`, `Edit(//<dir>/**)` and no other writable path, under `permissions.defaultMode:"dontAsk"` and `sandbox.enabled`; the council root rides along as `--add-dir` so reads still work | `Write`/`Edit`/`MultiEdit` anywhere but the project folder |
| **codex** | `cwd` = the project dir, `--sandbox workspace-write`, **no** extra writable roots | every write outside the project folder, by any means, at the OS sandbox level. Reads stay unrestricted, as codex's sandbox restricts writes only |

**The gap, stated plainly.** Claude's `Bash` tool is pre-allowed and runs
inside Claude's sandbox, whose writable workspace is `cwd` plus its
`--add-dir`s — and the council root is an `--add-dir`, because the bots need to
read it. So a *shell* write elsewhere **inside the council root** is not
mechanically blocked for claude; it is blocked by instruction only. Everything
outside the council root is blocked for both agents, and codex is fully bounded
either way. Closing this would mean either dropping read access to the council
root (which breaks Phase 1's premise) or changing `planner_write_config` in
`core/`, which is the TUI's configuration too. Deliberately not done here.

**Per-project, therefore per-child.** An environment is fixed when a process
starts and there is no command that re-scopes a live bridge, so the server now
keys workspace bridges by **(council root, project id)** rather than by root
alone (`wsKey`). A second project in the same council gets a second child with
its own folder; the `/project open <id>` choreography is unchanged (it now
fires once per child rather than per switch). Cost: a reader who opens
artifacts from several projects has several sleeping children. Deliberate — the
alternative leaves the first project writable under the second project's page.

**The permission gate does NOT open.** `permission_request` is still answered
`allow:false` on every bridge including a workspace one, and that is not an
oversight: the controller answers a yes by granting a whole additional write
ROOT for the rest of the session (`_handle_write_access_request` →
`_grant_plan_write_root`), which is exactly the widening this refuses. The
project folder is writable without asking; anything that has to ask is by
definition outside it. The refusal message names the one writable directory.

**The envelope says it in words too.** Every turn on a project artifact page —
not just the first — carries "You may create and edit files under `<abs project
dir>` — this project's own folder and nothing outside it…", beside the
snapshot-path line and for the same reason (a resumed session's replayed
history is uneven and a bridge restart drops it whole).

**The confirmation card now discloses it.** "…and the bots may edit that
project's files when you ask them to. Nothing outside `projects/<id>/` is ever
writable." An **already-confirmed root keeps working with no re-confirmation**:
the answer stands and the new wording is for the next council the reader opens.

#### Tab auto-reload after a turn

The companion takes a **census** of the project folder at turn-start and
another at turn-end (`workspace.scanProject` → `diffScans`, server.mjs
`noteTurnStart`/`reportProjectChanges`) and broadcasts the difference:

```
{type:"project-files", url, root, project_id, project_title,
 count, page_changed, files:[rel…≤20], at}
```

- A **census, not a watcher**: nothing runs while the reader is reading — no
  polling at rest, no `fs.watch` handles — and no event unless a turn happened
  **and** something under the project actually moved.
- `sessions/`, dot-entries and `node_modules` are never counted. botference
  writes the chat into `sessions/` during every turn, so counting it would make
  every turn a change. Caps: 4000 files, 12 levels, symlinks not followed.
- A summary (thread-filing) job emits no turn-start/turn-end and so never
  triggers a census.
- No loop is possible: a reload starts no turn, and only a turn-end emits the
  event.

The extension (`content.js onProjectFiles`) then does one of two things, and
the difference is the point:

- **this page's own file changed** → `location.reload()`. The drawer's state
  survives it as far as it survives any reload: the record lives on the
  companion, and the tab re-attaches and re-activates (a project artifact page
  is never dormant).
- **only siblings changed** → one line in the page chat — "the bots changed N
  files in this project — not this page" — and nothing else. Reloading a page
  whose bytes did not change would throw away the reader's scroll position,
  selection and half-typed comment to show them what they were already looking
  at.

Duplicate events (SSE and the socket both up) reload once, deduped on `at`.

`GET /project-changes?url=<enc>` → `{ok, changes:{…}|null}` — the last change
set for a page, for a tab whose socket was down across the turn. Owner-only
(403 for a guest), 404 for a non-artifact, 409 unconfirmed, like the other
`/project-*` routes.

**Tests.** `test/workspace.test.mjs` (the Phase 2 block: the exact write-root
environment a workspace child is spawned with vs an ordinary one, one child per
project, the envelope wording, the gate staying shut even for a path inside the
project, the event for the page's own file and for a sibling, silence when
nothing changed, silence when something outside the project moved, `sessions/`
not counting, the guest 403). Harness `?workspace=1&selftest=1` asserts the
confirm-card wording and drives scripted `project-files` events; the reload
itself is held back by `window.__BFP_NO_RELOAD` and **counted**
(`window.__bfp.reloads`) rather than performed, since a real reload would take
the harness down mid-selftest — the same seam `__BFP_HREF`/`__BFP_PROJECT`
already are.

### Amendment (2026-08-18, shipped): the same artifact through the council web UI

A bot links the file it just wrote into the chat as `/files/<rel>` on the
council's own web server (`frontends/council/server.mjs`, `GET /files/…`, the
remainder `decodeURIComponent`d and resolved against the council root, any
dot-segment refused). So the reader usually meets an artifact at an **http(s)
address**, not at its `file://` one — and it is the same document, which has to
mean the same Discuss page: same project, same archive, same threads, **one
record**. Before this amendment the council-web view was an ordinary web page
with a chat of its own.

**Detection (workspace.mjs).** `artifactFor(url)` now answers for an http(s)
url too, iff **all** of:

- the url's **origin is trusted** (below);
- its pathname starts with `/files/`;
- the decoded remainder is a plain descending path — every segment non-empty and
  not starting with `.`, checked **after** decoding, because `%2e%2e%2f` is the
  same traversal as `../` and only the encoded form survives URL parsing (a
  plainly-written `..` is collapsed by the parser, exactly as the browser and
  the council server see it);
- resolved against a **candidate council root**, it names a file that passes
  every existing rule — a real `.html`/`.htm` file, inside a council root, inside
  that root's `projects/<id>/`, symlinks resolved on both sides.

Candidate roots are the keys of `council_roots` (confirmed first, then declined),
because an http url carries no absolute path to walk up from and that map is the
only honest source. **Consequence:** a council the companion has never been
*asked* about cannot be recognised through its web UI until it has been seen
once at a `file://` address (which is what puts the root in the map). A declined
root still resolves, so the answer stays "that root, declined" rather than
quietly becoming an ordinary page for a different reason than the reader chose.

The answer carries `via: 'council-web' | 'file'` and, for the council-web view
only, **`ident_href`** — the `file://` url of the same file. The `file://` view
gets no `ident_href`: its address already *is* its identity, and rewriting it
would be a chance to disagree with a record that already exists.

**Trusted origins, strictly (`councilWebOrigins`).** The companion's
`council_web` config value, its default `http://localhost:4187`, and the
optional `council_web_origins` list — exact origins, lowercased, http(s) only,
no pattern and no wildcard. Adding a tunnel is one line of `config.json`:

```json
"council_web_origins": ["https://council.botference.com"]
```

**Why the allowlist is the whole of the trust.** What is on the screen is
whatever that origin served. `https://evil.com/files/projects/<id>/index.html`
maps to the identical relative path, so believing the path would hand an
attacker-controlled page the reader's project trust: the council header and
project name, the project's entire chat archive (titles and transcripts of their
own council sessions), the identity of a real artifact record — and, since Phase
2, a bridge child spawned **write-enabled** inside `projects/<id>/`, driven by
comments on a page the attacker wrote. An unlisted origin is an ordinary web
page, full stop.

**One identity, not twins (extension).** `content.js` still refuses `file:`
documents except a confirmed artifact, and now also asks about an **http(s)
document whose path starts with `/files/`** — one cheap `GET /project-page`, and
a `no` there simply leaves it an ordinary web page (unlike the file: gate, where
a no ends the page). Every other page in the world keeps its zero
companion round-trips per load: the path prefix is what decides whether to ask.
`IDENT_HREF` then takes `PROJECT.ident_href` ahead of an adapter's
`identityHref`, the canonical link and the address — the same "the document's
identity is not its address" mechanism the PDF viewer uses, decided once at load
and never revisited. Everything downstream already comes from `IDENT_HREF` and
nothing else (hello, `/page`, `/thread`, `/reply`, the snapshot, the worker's
routing table, `project-files` events, the auto-open key), so the council-web tab
and the `file://` tab address one record, with `HOSTNAME` the project id in both.

Two knock-on notes, both deliberate: an ordinary page record created for the
https url **before** this amendment is not migrated (it is simply left behind);
and the drawer's Pages list still cannot *open* an artifact row, because
`openPage` only navigates to http(s) urls and the record's url is the `file://`
one — unchanged by this amendment, which is about identity and not navigation.

**Tests.** `test/workspace.test.mjs` — "the council web view" (trusted origin
with URL-encoded segments; identity equal to the file: twin's and absent on the
twin; untrusted origins including a wrong port, a wrong scheme and the unlisted
tunnel; the tunnel accepted once listed and refused again once removed; garbage
in the list ignored; traversal plain and encoded; only `/files/`; only a real
`.html`; outside `projects/<id>/`; an unknown root; a declined root) and, at the
companion level, `/project-page` for a trusted council-web url (`via`,
`ident_href`, the root's confirmation travelling), the untrusted refusals, the
tunnel as one line of config.json, `/project-sessions` and `/project-session`
answering a council-web url, and a reply posted through the council-web view
landing in the **file: twin's record** with nothing filed under the http
address. Harness `?workspace=1&councilweb=1` (plus `&unconfirmed=1`) stages the
council-web origin: `__BFP_PROJECT` is deliberately *not* preset, so the gate
does the asking, and the selftest asserts the ask, the canonicalised identity
and that hello/routing carry the twin's url.

### Amendment (2026-08-19, shipped): the mirror stays level, and plain text is the room's

Two fixes to project artifact pages, both about the same fact: **an artifact's
Page chat is not a chat about a web page — it is a council chat**, the very
session the TUI is driving, reached through a second bridge.

#### 1. The mirror is refreshed in both directions

`page_chat` on an artifact page is a MIRROR of a council session: the tail
`sessionTail` read off disk when the chat was opened, plus what the drawer has
appended since. The same session is written by the TUI and by the council web
UI — a different process, the same file — and nothing told this companion. The
reader chatted in the council, came back to the artifact tab, and saw a
conversation that stopped hours ago.

**The sync mark.** `page.session_sync` is the session file's mtime in whole
milliseconds as of the last refill (`workspace.sessionMtime`; `sessionFile`
gives the path). Disagreement with the file on disk is the whole of the
freshness test, and the answer is to read the tail again — same
`sessionTail`, same `restored:true` semantics `/project-chat` uses, plus a
refreshed `session_total` and `session_title`.

**On read.** `GET /page` runs `freshenMirror` first: an artifact page standing
in a confirmed root's session whose mark is stale is refilled before the record
is answered. Every drawer asks `/page` on load and after every `page`
broadcast, so a tab returning to a stale mirror catches up with no watcher
involved and nothing running while nobody is looking.

**While open.** A session a connected tab is standing in is watched with
`fs.watch`, debounced 300 ms; an external change refills and broadcasts
`{type:'page', url}` — the existing re-render signal — so open drawers catch up
without a reload. Design notes, each load-bearing:

- **`fs.watch`, not a heartbeat stat.** The SSE heartbeat is 15 s, and "your
  council reply shows up within fifteen seconds" is not a live mirror; the
  reader flips tabs in one. The watcher is event-driven and still does zero
  work at rest.
- **The DIRECTORY is watched, not the file.** botference saves a session by
  writing a temp file and renaming it over the old one; a watch on the file
  follows the replaced inode and goes deaf after the first save. Events are
  filtered to the one basename (a platform that reports no filename falls back
  to the whole directory) and answered with one `stat`.
- **Nothing at rest.** A watcher exists only while at least one client is
  connected AND at least one recently-read page is standing in a council
  session (`standing`, 10-minute TTL, 40 entries max). The last tab closing
  closes them; `persistent:false` means one can never hold the process open.
- **Never from our own writes.** The bridge this companion spawns *is*
  botference and saves the same file every turn. `refillMirror` refuses while a
  turn for that page is in flight or queued (`chat.busyFor` → `pageBusy`), so a
  turn's saves never rewrite the conversation it is answering into; the save
  that lands after turn-end is picked up on the next event or read, when it is
  simply the truth like any other. A refill that is not needed writes nothing
  and broadcasts nothing, so no loop is possible.

**The honesty rule.** After a refill the session file is the truth: a message
the drawer authored becomes a `restored:true` entry like every other, offered
no edit and no delete, because that is now what it is. The single exception is
a message the file *cannot* have seen — anything this companion stamped after
the file's own mtime (a note typed with the agents off, a guest comment that
summoned nobody). Deleting those would lose words no other copy holds, so up to
20 of them are kept under the refilled tail. `{new:true}` clears the mark with
the mirror.

Client-side drafts survive the re-render as they survive every other one
(`render` → `harvestDrafts`); nothing about `D.drafts` had to change.

**Concurrency caveat, documented and not solved.** Two bridges over one session
is supported **sequentially** — chat in the council, come back, chat in the
drawer. Both sides typing at the same moment is out of scope: the council owns
the file, the companion only reads it, and last writer wins.

#### 2. Untagged page chat on an artifact goes to `@all`

> **Superseded in part** by "a thread remembers who it is talking to"
> (2026-08-24): "everywhere else, no mention means a note" now holds for page
> chat and for a thread nobody has ever addressed — a thread the reader HAS
> addressed keeps summoning whoever they last wrote to. The rule stated here for
> page chat, and its deliberate narrowness, are unchanged.

Everywhere else in Discuss no mention means a note and no bots — deliberate,
and kept. But the council's own rule is that plain text is addressed to the
room, and this IS a council chat. So on a **confirmed project artifact page**,
in **page chat only**, an untagged message is routed `@all`.

- Decided companion-side, where the artifact is known: `untaggedGoesToAll(page,
  target, text)` in server.mjs (`target === PAGE_CHAT`, no mention, artifact,
  confirmed). It rides the turn as `untaggedAll:true`.
- `chat.routeOf(text, untaggedAll)` supplies the prefix — `routePrefix` first,
  `@all ` only where the flag says so — and `envelope` and `routedAgents` both
  go through it, so the spinner spins the agents that are actually working. The
  reader's own words are untouched: the prefix is the envelope's, never
  something typed into the message on their behalf.
- **Unchanged everywhere else**: comment threads on artifact pages included, all
  page chat on ordinary pages, the library, and an **unconfirmed** root (an
  untagged sentence must not be the thing that asks the reader to vouch for a
  folder).
- The drawer's page-chat hint on an artifact page reads *plain text goes to
  @all — or tag one bot*; thread composers keep `@claude, @codex or @all to
  bring in the bots`. The empty-state line changed to match.

**Tests.** `test/workspace.test.mjs` — "the mirror stays level with the
council" (the mark recorded on open; a council turn reaching the mirror on the
next read with `session_total` moving and everything restored; an idempotent
re-read that writes and broadcasts nothing; the watcher's `page` broadcast to a
connected client; another chat in the same folder ignored; a turn in flight
deferring the refill and the reader's words surviving it; the deferred refill
landing after turn-end with post-mtime messages kept; `{new:true}` clearing the
mark; an ordinary page never growing one) and "untagged page chat on an
artifact goes to @all" (the `@all ` prefix on the wire with the message body
unchanged, both bots answering, strict routing still strict when tagged, an
untagged thread comment and reply queueing nothing, an untagged ordinary page
queueing nothing, an unconfirmed root queueing nothing). Harness
`?workspace=1&selftest=1` asserts both hint lines and drives a scripted `page`
broadcast carrying a council turn, checking the new tail renders **and** a
half-typed draft survives it.

### Amendment (2026-08-19, shipped): the send-review button

> **Superseded in part** by "send review fans out" below: the button, its
> placement, its confirm and its gates are exactly as described here, but the
> ONE-TURN digest this section specifies is gone. A round is now a preamble turn
> plus one turn per thread, and `workspace.reviewDigest` has been retired.

A reader reviews a draft the way they always have: down the page, highlighting
passages and writing in the margins. At the end of that pass they have twenty
comments and a bot that has read none of them. Retyping the review into the
chat is the work the machine should be doing, so on a **confirmed project
artifact page** one button — **send review** — hands the whole thing over as a
single page-chat turn. It is the Obsidian-export move applied to a document
review: one click, no retyping.

**Where it is, and why there.** Its own row directly under the archive bar on
the **Page chat** tab. Two decisions, both deliberate:

- **Chat, not Comments.** The threads are on the Comments tab, but the ANSWER
  lands in page chat. A button whose result appears on a tab the reader is not
  looking at is a button that seems not to have worked.
- **Its own row, not a third control in the archbar.** Three buttons do not fit
  across a drawer that is often 320px wide (they did not, and the screenshot
  said so); and the bar above is about which CONVERSATION this page is standing
  in, while this is about the DRAFT. Different questions, different rows.

**Disabled honestly.** With no open comment threads the button is dead and its
tooltip says why — "nothing to send yet — this page has no open comments.
Highlight a passage and comment on it first" — rather than being live and
failing. With comments it carries the count: *send review (3)*.

**One-step inline confirm**, never `window.confirm` (the same rule del-thread
follows, and for the same reason: the page's own modals and focus traps would
fight with a browser dialog). The row becomes *send 3 open comments to the
bots? yes no*. The count IS the warning — this spends real agent time on a
message nobody typed.

#### The digest (`workspace.reviewDigest`)

A pure function of the page record, so every rule about what goes in, in what
order, and what gets cut is testable without a server, a bridge or a browser,
and exists in exactly one place.

- **OPEN threads only.** A resolved thread is a decision the reader already
  closed; sending it back asks the bots to reopen an argument that is over.
- **Page order as far as page order is knowable.** On a paged document (a PDF)
  each thread stores the page its highlight sits on, so that is the sort key
  (stable, so ties hold). On an unpaged HTML artifact every thread's page is 0
  and **record order** stands — which is the order the Comments tab lists them
  in and the order they were made. The companion has no DOM and cannot know
  where on an HTML page a highlight really falls, so it does not pretend to.
- **Per thread**: the quote, then every message attributed by author — the
  bots' own replies included, because a thread where a bot answered and the
  reader pushed back is precisely the thread that needs the push-back read.
- **The preamble**: the reader has finished reviewing this draft; work through
  every point; where a point calls for a change to the files, MAKE it and say
  what you changed; and — in the same breath — *nothing is resolved by this
  message*. Phase 2's write rules ride the turn as they ride every turn on
  these pages, so "make the change" is a thing the bots can actually do, scoped
  to `projects/<id>/`.

```
I have finished reviewing this draft. Here is my whole margin review — 3 open
comment threads, in page order, quote first and the conversation under it.

Work through every point. Where a point calls for a change to the files, MAKE
the change (the write rules on this turn say where you may write) and say what
you changed; where it does not, answer it here. Nothing is resolved by this
message — I file the threads myself once I am satisfied.

--- comment 1 of 3 ---
> the truss, not the hull
angadh: this mass number looks wrong
claude: it is the dry mass
angadh: then say so in the caption

--- comment 2 of 3 · page 4 ---
> the radiator area
angadh: cite a source for this
```

**Caps, and never a silent truncation.** 20 threads, ~8000 characters, 300 per
quote, 800 per message, 12 messages per thread. A clipped quote or comment ends
in an ellipsis; a thread that lost messages says `(N earlier messages in this
thread are not shown)` and keeps the LATEST ones; and a digest that could not
carry every thread ends with "…and N more open comment threads that did not fit
in one turn — read the page's own records for those". The reader is looking at
the same threads in the Comments tab and would otherwise have no way to know
which of them the bots were never shown. One exception to the character cap:
the FIRST thread always goes in however long it is, because a cap that can send
nothing is a button that silently does nothing.

#### `POST /send-review {url}` — owner only

Owner-only like every other `/project-*` route (the answer names this reader's
projects), and gated exactly as they are: guest **403**, not an artifact
**404**, unconfirmed root **409**, nothing open to send **400** with a friendly
error naming the fix. Agents off gives the same `{queued:false, reason}` shape
as any other submit — and, as with any other refused submit, the message is
still kept.

The route adds one thing to a typed message: the text. The digest is appended
as a **real user message** in page chat (visible, editable, deletable, in the
session file) and then goes through `summon` like anything else — queued,
streamed, persisted, mirrored, double-click-guarded. Nothing about the submit
path, the mirror or the census has a case for it.

**Routed `@all`, whatever the quoted comments say.** `summon` takes
`extras.forceAll` and `chat.routeOf` now lets the flag WIN over `routePrefix`.
For the flag's original caller (`untaggedGoesToAll`) that precedence is
provably a no-op — the flag is only ever set when `hasMention(text)` is false,
and hasMention reads exactly the tags routePrefix reads — so nothing else
changes. What it buys is this turn: a review of a whole draft is the room's
business, and an "@claude" the reader typed at one thread three weeks ago is
not the address of it.

**Nothing is resolved.** The bots reply in page chat; the reader files the
threads they are satisfied with, one click each. A button that closed twenty
threads on the strength of an answer nobody has read yet would be filing the
reader's decisions for them.

**Tests.** `test/workspace.test.mjs` — "the send-review digest" (open threads
only with the quote and the attributed talk; a resolved thread left out; no
digest at all with nothing open; paged order vs record order; quote and comment
clipping; a long thread keeping its latest and naming the drop; the thread cap
and the character cap each naming what did not fit; one enormous thread still
going) and "companion — POST /send-review" (400/404/409, the whole review
reaching the mock bridge as ONE turn prefixed `@all` despite a quoted `@codex`,
the Phase 2 write rules on that turn, the digest visible as a user message in
page chat, the threads left unresolved, both bots answering, a guest's 403, the
agents-off `{queued:false, reason}` with the review still kept, and the
double-click guard). Harness `?workspace=1&selftest=1` drives the button
end-to-end: present and counting, disabled with its tooltip when every thread
is filed and live again when they are reopened, the inline confirm asking and
sending nothing until it is answered, backing out, and a confirmed send putting
the digest in page chat with nothing resolved behind it.
`?workspace=1&review=1` is the screenshot pose (the confirm, mid-step).

### Amendment (2026-08-19, shipped): one margin, and it is Discuss's

Some of the pages a reader opens are already a review surface. The review
engine's build (`frontends/review/build.mjs`) and the review-doc skill's
single-file `*.review.html` both paint their own highlights, keep their own
margin rail, and pop their own **💬 Comment** pill the moment a drag ends. Put
the Discuss drawer on top of that and one selection raises two pills, from two
systems, writing into two records neither of which knows about the other. That
is not a feature with a workaround; it is a page the reader cannot use.

**One of them has to win, and with the plugin installed it is ours.** On such a
page Discuss KEEPS the margin and **the page's own selection pill is put
away**. The rule is the reader's own if/else: *if the plugin is here, the
plugin's comment button; otherwise the page's own.*

The reason is not that our pill is prettier. It is where the comments GO. A
comment written into the page's own record is a line in a JSON file beside the
document; a comment written into Discuss reaches the bots, joins **send
review**, lands in the project's chat and shows up in the pages library. On a
page the owner is reviewing with their council, the second of those is the only
one that does anything.

**Nobody else is affected.** A visitor without the extension gets the page's
built-in commenting exactly as the page ships it — the suppression is a
stylesheet the content script injects into a page it is already running in, and
the file on disk is untouched. There is no version of this that degrades a
plugin-less reader's page.

#### What is suppressed, and what is not

Only the **selection-triggered** affordance:

```
#selpop        the review-doc single file's "💬 Comment" pill
#sel-pill      the review engine's "💬 Comment on selection"
#sel-pop       …and its selection popup
```

hidden by an injected `<style id="bfp-page-sel-off">` carrying
`display:none !important`, which outranks the inline `display`/`hidden` both
engines toggle. Nothing of the page's DOM is touched, so the engine can go on
showing and hiding an element that simply does not paint, and undoing the whole
thing is removing one node.

**The engines' TOOLBARS stay.** "+ General comment", "Copy feedback",
"Export ⬇", "Send to Claude", the resolved filter — these are how the reader
works with the comments that already live in that page's own record, and none
of them is a second answer to a drag. Suppressing them would break a page we
were only trying to de-duplicate.

#### The marker

Detection is **one `querySelector`, once, at attach time** in content.js
(`REVIEW_UI_MARKER`) — never inferred from the url, because a review build is
served from wherever the reader put it (file:, the council web server, a static
host), and never re-run, because a page does not stop being a review surface
while it is open.

```
body[data-docid] > #selpop        the review-doc single file
body[data-slug]  > aside#margin   the review engine's build
```

Each alternative demands **both** halves: a body-level data attribute the
engine writes (`data-docid` / `data-slug`), **and** that engine's own
commenting element as a **direct child of body**. Structural, cheap, and hard
to trip by accident — an ordinary prose page has neither half; a CMS that
happens to put `data-slug` on its body, or a layout with a stray `#margin`,
has only one. `window.__bfp.reviewHost.marker` exposes the selector so the
harness asserts against the real string rather than a copy of it.

#### The switch: "use the page's own commenting"

The default is the sensible one, not a verdict. A reader who wants the page's
own margin back can have it — **once per page**, and the answer is remembered.

**Where.** A one-line note at the top of the **Comments tab**, with the switch
in the same block:

> Discuss is handling comments on this page, so its own 💬 is put away — one
> margin, and your comments reach the bots.  **[use the page's own commenting]**

Not a gear popover: the note is the sentence that explains where the page's own
💬 went, and the switch is the answer to that sentence. Split them and the
reader hunts for a setting they do not yet know exists. A gear would also be a
new surface on a drawer that has none — and the Comments tab is precisely where
a reader goes when they wonder about their comments.

**After the switch** the note stays and gets LOUDER (a solid card rather than
the default's dashed, dimmed line), reading *"This page's own review commenting
is handling the margin — new comments there won't reach the bots. Discuss
threads already here still work"* with **[let Discuss comment here]**. The
default is the quiet one because nothing has gone wrong in it; the handed-back
state is the one worth a second look, because comments written over there do
not reach the bots.

Standing down is NARROW. It withdraws exactly two things — our selection pill
and `beginNew` — and **nothing else**: Page chat, the project archive, the
tasks card, the project header, send-review, the pages library, Phase 2's write
rules, and every Discuss thread already on the page, which still renders, still
paints its highlight and **still takes replies** in both arrangements.

**Persistence.** `chrome.storage.local`, key `bfp:page-comments:<URL_NOW>` —
the page's settled identity, so the file: twin and the council-web twin of one
artifact share the answer, and nothing else on the web is affected. Read once
at boot and only on a page where the question arises; an ordinary page never
touches storage for this. **Unknown reads as the default** (Discuss has the
margin), and the suppression is applied SYNCHRONOUSLY at boot, before storage
answers, so the page's pill cannot flash up on the reader's first drag while a
callback is in flight. Turning it on stores `true`; turning it off *removes*
the key rather than storing a false.

**Ordinary pages and non-review artifacts are byte-identical**: no marker, no
note, no stylesheet, no storage read, no branch taken.

#### Testing

Harness `?reviewpage=1` wears the marker on the ordinary article (docid on the
body, an engine-shaped `#selpop` as a direct child of it, and the engine's
toolbar buttons beside it) with the three usual threads restored. `&selftest=1`
asserts: the marker is seen and Discuss does NOT stand down; the page's own
pill is suppressed and stays invisible even when the page itself sets an inline
`display:block`; the suppression is a stylesheet and the pill is still in the
DOM; the toolbar buttons are untouched; our pill floats on a drag and starts a
comment; the three threads still list, still paint and still take a reply; the
note is shown, in its quiet state, naming Discuss as the one handling comments;
"use the page's own commenting" stands Discuss down, persists the key, gives
the page's pill back, flips the note to its loud state, refuses `beginNew` and
leaves the threads alone; and "let Discuss comment here" restores every one of
those, forgetting the key. `?reviewpage=1&pageown=1` is the screenshot pose for
the handed-back state.

### Amendment (2026-08-19, shipped): ready for review — the bots get a middle state

Resolving stays **the reader's click alone**. A bot must never close the
reader's question, and nothing in this amendment lets one.

But between "open" and "resolved" there was a gap. After a round with the bots
the reader had no way to see WHICH threads had moved — the list looked exactly
as it had before, and the only way to find out was to re-read every thread on
the page. So a thread now has a third state: **addressed**, shown as *ready for
review*.

#### The mechanism, and why this one

**A bot's reply landing in a thread marks it.** That is the whole rule, and it
needs no new API on the bot side at all: the bots already reply into threads
whenever the reader tags them there, and every write into a thread — `/reply`,
the reading room's composer, the bridge's `reply` event — goes through
`store.appendMsg`. So the rule is stated once, beside the "new activity is the
end of resolved" rule that already lived there:

```
a BOT wrote into this thread    → addressed  (their go is done; the reader's turn)
a HUMAN wrote into this thread  → not addressed  (a new question; any claim is stale)
a bot's `tools` line            → nothing  (narrating, not answering)
```

Same shape as `resolved`, deliberately: **state, not history**. Clearing
REMOVES `addressed` / `addressed_at` / `addressed_by`, so a thread that was
never addressed is byte-identical to one that was addressed and written into
again, and every record written before this reads as not-addressed. Resolving
clears it (the reader has looked) and so does reopening (the reader saying "not
done" is exactly the answer the badge was asking for).

**What was considered and NOT built:** telling the bots, in the send-review
digest, to "reply one line into each comment's own thread". They cannot. The
bridge fixes a turn's target when the job is queued (`chat.mjs`, `job.target`)
and the bot's whole turn text is posted back into that same target; a bot has
no way to choose a different thread. A send-review turn is queued against page
chat, so its answer lands in page chat, and an instruction to reply into each
thread would be an instruction the bots could not obey. ~~**Deferred, not
built:** a send-review that fans out one job per thread would close that loop —
at the cost of N turns of agent time and the "one turn for the whole review"
property the endpoint is built on.~~ — **built**, see "send review fans out"
below: the COMPANION chooses the thread, because it is the thing that queues the
job, and the one-turn property was worth less than answers that land where the
comments are.

`POST /addressed {url, thread_id, addressed}` exists for the CLEARING
direction, which is the one thing only a person can mean. Same gate as
`/resolve` (an author, not ownership): on a shared companion the people reading
the page are the people working through its comments, and the act is free to
undo. The `addressed:true` direction is accepted for symmetry and so a second
reader can hand a thread over without replying into it, but nothing in the
drawer offers it.

#### In the drawer

An addressed thread wears an amber **ready for review** badge — inside the
quote, flowing after it the way the orphan badge always has, because a badge in
the row beside it takes a flex share and squeezes a three-line quote into a
column — and sorts into a **"Ready for review (N)"** section between the open
list and the Resolved archive. That is where these threads are in their life:
past the bots, not yet past the reader.

Collapsible like the archive, but **open by default**: the archive's whole
point is to be out of the way, and this section is the thing the reader came
back to the page to look at. Its cards are the ORDINARY cards, because a thread
here is still a live conversation that takes replies.

The reader's **✓** files it exactly as it files an open one. **↺ "not done"**
is the one-click disagreement: back into the open list, in page order, and a
candidate for the next send review again. Replying into it does the same thing
implicitly, because the reader writing there is a new question.

The **tab count is unchanged**: it counts every unresolved thread, ready ones
included, because a ready thread still wants the reader — that is what ready
means. What "All clear" means is unchanged too: it appears only when every
thread is FILED, never while one is merely ready.

#### On the page

A third highlight tint, between the other two on the same arc:

```
--hl     yellow   nobody has been here
--ready  amber    somebody has; your turn        (bfp-ready)
--done   sage     done                           (bfp-done)
```

Resolved outranks ready outranks open, read off the mark's own classes, so a
repaint from the record can never disagree with what is on screen. Read down a
page the three tints are a progress bar the reader never has to open the drawer
to see.

#### send-review sends only OPEN threads

`workspace.openThreads` now excludes `addressed` as well as `resolved`, and the
drawer's button count applies the same rule so the number it shows is the
number that is sent. Re-sending a thread a bot has already reported on would
ask for work that has been done — and a second send after a round is precisely
the case this state exists for.

#### before → after, when a change rewrote the passage

A change that REWRITES the quoted passage orphans its highlight: the thread
still carries the old wording, the page no longer contains it, and nothing says
what replaced it. So the bots are asked — in the digest, and as rule 5 of the
bridge system prompt — to quote the new wording back verbatim when that
happens: `done — this passage now reads: "…"`.

That one line is enough. On a **ready** thread the drawer looks at the last
bot message for that explicit phrasing (`now reads` / `reads now` / `now says` /
`new wording`, followed by a quoted string — never a loose "any quoted string in
a reply", which would draw a diff every time an agent quoted the reader back at
themselves) and renders a compact **before → after** word diff against the
thread's stored quote: the same suggested-edit idiom the review engine uses,
struck-through where words left, the accepted tint where they arrived.

Word-level LCS, whitespace never diffed and every run re-joined with a single
space (diffing the gaps as tokens is what makes a word diff render as
"beenhad ingone"). On any doubt — a passage too long to diff, or two versions
sharing less than a fifth of their length, which is two different sentences
rather than an edit — it falls back to the two quotes stacked and labelled
**was / now**, which says the same thing and cannot mislead. Pure client-side:
no new data, nothing server-side, no page-side rendering.

~~**Deferred, not built:** having the companion RE-ANCHOR the thread to the new
wording (anchor.js) when a bot reply carries it, so the highlight moves onto the
rewritten passage instead of orphaning at all.~~ — **built**, see the next
amendment.

#### Testing

`resolve.test.mjs` covers the state transition and `store.appendMsg`'s rule
(bot marks, human clears, `tools` marks nothing, page chat is never marked,
resolve and reopen both clear it). `companion.test.mjs` drives the endpoints: a
bot's answer marking a thread over the wire, the reader's reply clearing it,
`/addressed` in both directions and its 404, and filing/reopening spending the
claim. `workspace.test.mjs` covers the digest — an addressed thread is not
sent, a page whose every thread is ready composes no digest, and the digest
carries the new-wording instruction.

Harness `?ready=1&selftest=1` drives the whole thing in the DOM: a bot reply
marking the thread, the badge, the section and its count, the fold, the amber
highlight, the tab count that does not drop, "not done" and its refusal path,
the reader's ✓ still resolving through `/resolve`, reopening landing in the
OPEN list rather than back in Ready for review, the reader's own reply clearing
it, and the before→after diff (word diff, stacked fallback, and nothing at all
for a reply that quotes no new wording). `?ready=1` is the screenshot pose and
`?ready=1&rewrite=1` the one for the diff. The workspace selftest asserts the
send-review count drops when a thread goes ready and comes back when it does.

### Amendment (2026-08-19, shipped): track changes on the page

The previous amendment gave the reader a **card** that says what a bot's change
did to a passage. It left the **page** saying nothing at all.

A change that rewrites the quoted passage orphans its highlight. The old
wording is not there any more, so nothing is painted; the new wording is there,
unmarked, indistinguishable from prose nobody has touched. The reader
re-reading their own draft after a round with the bots has no bearing on where
the change landed or what it replaced — the one thing they came back to look
at. The card knew; the document did not.

So: **the highlight moves onto the rewritten passage, and the wording it
replaced is shown, struck through, immediately before it.** Word's idiom, and
the same before→after idiom the card already used, in the body of the page.

#### 1. Re-anchoring — and who is allowed to do it

The bot has already said what the passage now reads (`done — this passage now
reads: "…"`, bridge-system-prompt rule 5). That sentence is now doing two jobs,
so **the parse moved to `anchor.js`** (`Anchor.newWording`) — beside the
locating it feeds. `drawer.js` calls it for the diff and `content.js` calls it
for the anchor; two copies of the rule could drift into a card that draws a
change the page does not show.

**Where it fires: the extension, on the first successful LOCATE — not at the
choke point that sets `addressed`.** This was the choice, and it is not the
convenient one:

> The companion has no DOM. `store.appendMsg` can know that a bot CLAIMED a new
> wording; it can never know the wording is on the page. Re-anchoring there
> would rewrite a thread's anchor on the strength of a sentence — and would
> happily destroy an anchor that still matched perfectly, on a page the change
> never reached. So the page proves it first.

`content.js`'s `reanchorAll` already locates every thread against clean text.
A thread that fails to locate, is `addressed`, is not `resolved`, and carries a
parsed new wording is looked up a second time — `Anchor.locate` against the new
wording, with the thread's OLD prefix/suffix, because a rewrite replaces the
passage and not the paragraph around it. On success the thread is located,
painted READY amber and clicks through to its card like any other. **On failure
nothing happens at all: the thread stays orphaned exactly as it did before any
of this existed, and nothing is written down.**

**Durable, `POST /reanchor {url, thread_id, quote, prefix, suffix}`** —
`store.reanchorThread`. `prior_quote` takes the original wording (written ONCE:
a passage rewritten twice still has one original — it is the "was" half of the
card's diff, and the only thing here that nothing can recover), `quote` becomes
the new wording, prefix/suffix the fresh context, `orphaned` goes false, and
`reanchored_at` stamps it. Idempotent: a second tab locating the same passage
is not a second rewrite.

**OWNER-ONLY**, unlike `/resolve` and `/addressed`. Those are opinions about a
thread and are free to undo; this EDITS the record's own anchor.

And the companion is still the authority on one thing: **which** wording may be
written. `store.newWording` re-parses the thread's own last bot message and
refuses anything else, so the door cannot be used to set a quote to whatever a
client likes. (That parse is the node-side twin of `Anchor.newWording`; the two
are kept in step by hand and both are unit-tested.)

The drawer's `rewriteHtml` reads its "was" from `t.prior_quote || t.quote`:
once the re-anchor has happened `quote` IS the new wording, and diffing it
against itself would draw nothing.

#### 2. The markup, and why it is not a fourth tint

```
<del class="bfp-was" data-bfp="<id>" aria-hidden="true">the old wording </del>
<mark class="bfp-hl bfp-ready bfp-ins" data-bfp="<id>">the new wording</mark>
```

The obvious move — paint the arrival in the green/ok tint — was **not** taken.
Three background tints already mean three states of a THREAD (yellow open,
amber ready, sage filed), read down a page as a progress bar, and a fourth
would muddle the one thing the colours are for. Worse, "green" is already
*filed*. So the mark keeps the tint its thread's state earns it, and the
arrival is marked the way Word marks an insertion: **an underline in the
accepted green**, over whatever background is already there. The departure is
the struck, dimmed `<del>`, which is not part of the page at all.

Clicking either opens the thread — the click handler takes
`mark.bfp-hl, del.bfp-was[data-bfp]`, because to the reader it is one thing.

#### 3. Display-only, and the proof of it

The `<del>` is inserted into the page's own DOM, which is a thing worth being
paranoid about. Four doors, all shut:

| door | what happens |
| --- | --- |
| `Anchor.buildTextIndex` | `WAS_CLASS` is **skipped in the walk**, beside `#bfp-root`. This is the single place every locate, offset and paint reads the page through — so the struck text is invisible to anchoring, and a thread can never re-anchor onto its own ghost. |
| `snapshotHtml` | **removed outright** (not unwrapped, which is what our `mark`s get — those wrap the very text an anchor points at). A deleted sentence must not go back into the prose the phone reads. |
| `genericArticleText` | `innerText` renders what is laid out, and has no structural door. So `withoutWasMarkup` hides the nodes for the length of the read and restores them in a `finally`. The bots must never be handed a draft with the sentences a change removed still in it. |
| the reader's own selection | `user-select: none`, so a drag across the passage cannot capture a quote half of which is not on the page. |

Plus `aria-hidden="true"`: a screen reader working down the prose should hear
the draft as it stands.

#### 4. The reader's switch

`.trackbar`, at the top of the Comments pane with the standdown note and for
the same reason — it is the answer to a question the page itself raises ("why
is there a struck sentence in my draft?"), and a setting behind a gear is a
setting nobody finds. It renders **only where there is such a passage**.

**Default ON**: the change should be visible without being asked for.
Persisted per page in `chrome.storage.local` under
`bfp:track-changes:<url>` — and, like the margin switch, only the NON-default
is stored, so a page nobody has an opinion about costs no storage.

**Filing a thread (✓) takes its markup down with it** and the highlight goes
sage, as always. Note that reopening does NOT bring it back: `/resolve` clears
`addressed` in both directions (that rule predates this and is right — "not
done" is what a reopen means), so a reopened thread is an open thread, yellow
and unmarked, until a bot claims something about it again. The markup is a pure
function of `addressed && located && prior_quote && switch on`, swept in one
place (`paintTrackChanges`), so nothing can outlive the state that justified it.

#### 5. Cap sanity

Passages are prose spans, not pages (`Anchor.WAS_MAX = 600`). Past that, or
where the new wording located only by prefix/suffix scoring rather than
uniquely, **the highlight still moves** — the thread has a place again, which
is most of the value — but the old wording is not put inline, and the mark
carries a `title` saying which of the two reasons it was.

A locate that fails outright is a different case and keeps its old behaviour:
orphaned, no highlight, no markup, nothing written down.

#### Plugin-less visitors

See nothing of this. All of it is extension-side except `prior_quote` /
`reanchored_at` on the record, which are inert data — the reading room and the
Obsidian export read `quote` exactly as they always did.

#### Testing

`anchor.test.mjs` covers the parse (the four phrasings, curly quotes, last bot
word wins, a reader cannot move an anchor by typing the sentence, a `tools`
line claims nothing, a bot quoting the reader back claims nothing) and the
locate of the named wording against the old context, including the ambiguous
and not-found cases. `resolve.test.mjs` covers `store.newWording` and
`reanchorThread` — the rewrite, `prior_quote` written once across two rewrites,
idempotency, whitespace-insensitive comparison, and every refusal (a forged
quote, an unanswered thread, a filed one, a bot that claimed nothing).
`companion.test.mjs` drives `/reanchor` over the wire, including the 409 before
a bot has claimed anything, the forged-quote refusal, and the 404.
(`mock-bridge.mjs` gained `[mock:reads:…]`, which makes a mock turn answer with
the rule-5 sentence.)

Harness `?ready=1&selftest=1` drives the whole thing in the DOM: the paragraph
rewritten under the thread, the highlight moving onto the new wording in amber,
the re-anchor posted once and the record carrying `prior_quote`, the struck
`<del>` immediately before the mark with the old wording in it, the arrival
underline, `aria-hidden` and `user-select`, the card's diff still two-ended
from the stored original, all four leak doors (the index, `findSpans` on the
old quote, the snapshot, the article text), the switch and its persistence in
both directions, resolve taking it down and the highlight going sage, and a
claimed wording the page cannot find leaving the thread orphaned with nothing
written. `?ready=1&rewrite=1` is the screenshot pose and now rewrites the page
itself rather than only the record.

### Amendment (2026-08-19, shipped): send review fans out — one turn per comment

The button was right and its answer was in the wrong place. A reader who sent
twenty margin comments got back one page-chat essay about twenty comments: no
sentence of it attached to the thread it answered, no thread marked as dealt
with, no badge, no before→after card, nothing on the page. Every mechanism built
for "a bot answered this comment" sat idle, because none of them can see a turn
that landed in page chat.

**So the round is the unit now, not the turn.** `POST /send-review` queues:

1. **One PREAMBLE turn into page chat** — short, routed `@all`, appended as a
   real user message like any other. It says a round is starting, how many
   comments follow, that each is its own turn, and what a bot is expected to do
   with one (make the change, say what changed, quote the new wording when a
   passage is rewritten, resolve nothing). It exists for two reasons: the
   council's own chat should record that a review happened, and it is where
   cross-comment context lives — a bot reading comment 7 has the round's terms
   in its session, not just the one comment in front of it.
2. **One job per OPEN thread, in page order, each targeted AT THAT THREAD** —
   queued through exactly the path a directly-tagged thread reply is queued
   through today (`summon` → `chat.submit`, `job.target` = the thread). Each
   turn carries its thread's own envelope (quote, page number, the conversation)
   plus one line of round context: *"[review round · comment 3 of 12] … the
   draft's files are yours to edit …"*.

**Why this works where an instruction could not.** The bridge fixes a turn's
target when the job is QUEUED and posts the whole answer back into that target,
so a bot can never choose a thread. The thing that CAN choose is the thing that
queues, which is the companion. That is the entire content of this amendment,
and it is why "reply into each comment's thread" had to become N jobs rather
than N sentences.

#### Everything downstream was already built

Nothing new happens after the reply lands. Verified end to end, in that order:

```
bot reply into the thread   → store.appendMsg (the choke point, untouched)
                            → addressed / addressed_by
                            → the amber "ready for review" badge and section
                            → "…now reads: “…”"  → Anchor.newWording
                            → POST /reanchor → prior_quote → track changes
```

One bug fell out of exercising it: `appendMsg` CLEARED `addressed` on a bot's
`tools` line, because reopening spends the claim (`setResolved`) and a narration
came through that door. SPEC's own table said a `tools` line marks nothing — it
must unmark nothing either, or a codex turn whose tool summary lands after its
answer takes down the badge that answer just earned. With one bot turn per
thread that ordering is ordinary, so the choke point now puts the claim back.

#### In the drawer

The button, its count, its tooltip, its one-step inline confirm and its
placement are all unchanged. What changed is the receipt: the outcome line reads
*"sent 3 comments — one turn each, answered in the threads"*, and every thread
with a turn coming gets the ORDINARY waiting note on its own card — *"◐ queued
in this review round…"*. That is the whole spinner story, and it is deliberately
not a new affordance: a round of twelve reads as twelve waiting THREADS, one of
them working, rather than twelve spinners stacked on a page chat that is not
where the work is. Each note is taken down by exactly what takes down any wait —
that thread's own `turn-start`, or a refetch showing a new bot message in it
(`clearAnsweredWaits`).

The reader still lands on **Page chat** after sending, where the button and the
preamble are; the tab strip's count is what says the threads have started
moving.

#### Routing: `@all`, unless the reader already chose

Each per-thread turn is addressed by `workspace.reviewRoute`: `@all`, unless the
thread's **last human message** tags exactly one bot, in which case that bot
alone. The reader picked who they were talking to in that thread and a round has
no business overruling them (nor spending a second agent's turn doing it). Bot
messages are not read for this — a bot writing "@codex, over to you" is not the
reader's address — and neither is a `tools` line. An EARLIER tag never wins: the
last word is the address. The tag rides the turn's own text, so the bridge routes
it exactly as it routes every other turn (`chat.routePrefix`); `forceAll` is now
used for the preamble alone.

#### Caps, rethought

- **20 threads still.** The first 20 open threads go; the preamble carries
  *"…and N more open comment threads did not fit in this round — send review
  again after these"*, which is now true advice rather than a consolation: the
  threads a bot never reached are still open, so a second click sends precisely
  those.
- **The ~8000-character whole-review cap is retired** (`REVIEW_CHARS_MAX` is
  gone). It was the size of ONE turn's digest and there is no such turn. Twenty
  fat threads are twenty ordinary turns.
- **Per-thread caps stand and now apply per turn**: 300 per quote, 800 per
  message, 12 messages, latest kept, and the turn SAYS `(N earlier messages in
  this thread are not shown.)` — never a silent truncation.
- Response shape: `{ok, sent, omitted, total, queued, threads}` — `queued`
  counts the turns (the preamble plus one per thread; `0` when the bots were
  refused), `threads` names the threads with a turn coming, for the queued
  markers. `msg` is still the preamble message.

#### Failure honesty

If the companion dies mid-round, **whatever was still queued is lost**, exactly
as any queued turn is lost. There is no resume machinery and none is planned:
the threads nothing answered are still open, so the remedy is the button the
reader already has. A refused submit (agents off, a guest's budget) queues
**nothing at all** — twenty per-thread turns behind a refusal would be twenty
identical error lines in twenty threads — and the preamble is still kept, in the
`{queued:false, reason}` shape every other refused submit answers with.

The gates are untouched: guest **403**, not an artifact **404**, unconfirmed root
**409**, nothing open **400**, agents off `{queued:false, reason}`, and the
double-click guard (now keyed on the preamble) swallows the second click of a
round.

#### Testing

`workspace.test.mjs` covers `reviewFanout` as a pure function (one turn per open
thread with its quote and conversation; the preamble carrying no comment text;
resolved and addressed threads excluded; page order vs record order; per-turn
quote/message clipping and the named drop; a `tools` line out of the
conversation; the 20-thread cap naming the remainder; twenty fat threads all
going now that no character cap binds; `REVIEW_CHARS_MAX` gone) and
`reviewRoute` on its own (default room, the last human tag winning, an earlier
tag not winning, a bot's tag and a `tools` line claiming nothing, both-tagged =
room). Over the wire it drives a real round against the mock bridge: the
preamble first with the page-chat envelope routed `@all`, then one turn per
thread in page order with the THREAD envelope and "posted directly into the
comment thread", the routes (`@all` and `@codex`), the Phase 2 write rules on
every turn of the round, `queued: 3` and the named threads, the answers landing
in the threads, `addressed` flipping on both, nothing resolved, a second send
refused because every thread is now ready, the agents-off round queueing nothing
while keeping the review, and the double-click guard. `resolve.test.mjs` holds
the `tools`-line fix. Harness `?workspace=1&selftest=1` drives the round in the
DOM: a preamble and one turn per thread with the right targets and routes, the
queued marker on every waiting card and only one card working at a time, replies
landing IN the threads, the flip to ready and the section that grows from it,
the markers cleared by the turns that answered them, and nothing filed.
`?workspace=1&round=1` is the mid-round screenshot pose (the queue held, the
first thread's turn frozen mid-stream).

### Amendment (2026-08-19, shipped): "▸ more" — a capped answer keeps its long half

Every turn ends with a length instruction and the bots obey it, which is right
for a margin note and wrong for the question that genuinely has a long answer:
the choice was a wall of text or an amputated one. So a reply may now carry
BOTH — the capped answer, and the long version folded behind one disclosure the
reader opens. Nothing about the cap changes; what changes is what happens when
the cap is not enough.

**The marker.** One line, alone on its line, spelled exactly:

```
<!--more-->
```

Inner spaces and case are tolerated (`<!--  MORE  -->`), as is leading
indentation, because models retype it. Anything else on the line makes it
prose, not a marker. It was chosen over `⟨more⟩` and friends because it is
inert in every markdown renderer there is, every model already knows it from a
decade of blog engines, and nobody types it by accident.

- **A marker inside a fenced code block is CODE.** The same rule
  `splitEnvelopes` obeys and for the same reason: fence ordinals are the Run
  button's address, and a reply *about* the marker (a fenced `<!--more-->`)
  must render as what it is.
- **The first unfenced marker splits; later ones are dropped** from the tail
  rather than splitting again — one message, one fold.
- **A marker with nothing after it, or nothing before it, folds nothing.** The
  reply is the reply; an empty half is never drawn, and a bot that put
  everything below the marker still gets read.
- **Nothing is ever discarded.** `splitMore(text) → {head, more}` and
  `stripMore(text)` (head + tail, seam closed, every marker gone) are the two
  entry points; the STORED text keeps the marker exactly as written, as it
  keeps its markdown.

**Where the parser lives.** `more.mjs` (the companion) is canonical;
`extension/drawer.js` and `reader.js` carry byte-identical copies between
`⟦more⟧ begin`/`⟦more⟧ end` sentinels — the extension cannot import from the
server and the phone's script has no build step, the same duplication `normUrl`
and `tagHue` carry. `views.mjs` re-exports the companion's copy rather than
owning a fourth. `test/more.test.mjs` pins the three source blocks to the same
text (dedented — indentation is the only licensed difference) and the two
callable ones to the same answers.

**The prompt side.** `bridge-system-prompt.md` rule 1 gains the escape hatch:
lead with the capped answer, then the marker, then the long version. The head
must stand alone as a complete answer ("the short version is X", never "see
below"); most replies carry no marker at all; a checklist stays in the HEAD
(the drawer pins the newest one, and a folded checklist is a hidden one). The
same sentence rides on EVERY turn as part of `chat.mjs`'s `verbosityLine` —
a resumed session's system prompt is not something a turn can rely on, which is
why the write rule and the snapshot path ride there too.

**The drawer.** `replyHtml` splits the message and draws the head as the whole
reply, with a `.more` disclosure under it in the same grammar as the tools row
above: a 12px muted `▸ more` button, `aria-expanded`, and a `.more-body` that
holds the tail's own markdown behind a rail. Both directions (`more` / `less`),
unlike the thread fold — a reader who opened the long half of one answer is
reading it, not committing to it. State is `D.moreOpen[target|ts|more]`,
session-only, and it survives a re-render exactly as `D.toolsOpen` does.

- **The ordinals continue across the seam.** One message drawn as two fragments
  would otherwise restart both counters at zero, and both are ADDRESSES the
  companion re-derives from the whole stored message (`run.mjs codeBlocks`,
  the tick walk in `store.mjs`) — the tail's Run button would run the head's
  code. `renderMarkdown(src, carry)` takes a second argument that keeps
  `codeSeq`/`taskSeq` going, and the tail's slot is marked `data-md-cont`.
  The marker line itself is neither a fence nor a checkbox, so removing it
  cannot move an ordinal.
- **Copy hands back the message**, both halves, folded or not (`copyFlavours`
  now walks every `.ctext.md` in the reply rather than the first).
- **A live stream shows the whole answer with the seam stripped** — mid-turn
  there is no settled message to key a fold on, and a marker appearing and then
  vanishing in the preview is worse than no marker at all.
- **It composes with the long-thread fold** without touching it: the fold works
  on units, and a folded unit is not drawn at all.

**Everywhere else the text is read.** `views.mjs` (the reading room) and
`reader.js` (the phone) draw the same split as a `<details class="more">` —
no script, which is the reading room's rule. **The Obsidian export takes
`stripMore`**: the vault gets the WHOLE answer with the marker gone, never the
truncated head — a note that quietly dropped the half the reader asked to see
would be the worst failure this feature has.

**Tests.** `test/more.test.mjs` (57 assertions: the parser, the fence
negatives, the three copies, the reading room, the note, and the prompt lines).
Harness `?more=1&selftest=1` drives the fold in the DOM — head alone, no marker
in the prose, the disclosure opening and closing, the ordinals not moving, the
fold surviving a re-render, a fenced marker folding nothing, and the same
inside a comment thread with the thread's own fold untouched. `?more=1` /
`?more=open` are the screenshot states.

### Amendment (2026-08-19, shipped): collateral edits — the changes nobody commented on

Track changes showed the reader what a bot's change did **to the passage a
comment was anchored to**. Everything else it did was invisible.

That gap is not an edge case, it is the normal shape of an edit. Fix the
sentence a comment is about and the cross-reference two sections down is now
wrong; tighten a claim and the paragraph that restates it disagrees with
itself. Following the change out is **right, and wanted**. But there is no
thread at those passages, so nothing narrates them, nothing anchors to them,
and the tab reloads with the new sentence sitting in the prose looking exactly
like prose nobody has touched. The one edit the reader never asked for is the
one they are never shown, and nothing is there to approve.

Two layers, and the order matters: the prompt supplies the reason, **the file
supplies the truth**, and where they disagree the file wins.

#### 0. First: what ↺ actually is (a correction to the brief)

Worth stating plainly, because it is easy to assume otherwise from the
track-changes amendment above: **there is no revert-the-text path in Discuss,
and there never has been.** The two buttons on a ready thread are `✓` resolve
and `↺` **reopen / "not done"** — opinions about a *thread*, written to
`/resolve` and `/addressed`. Neither writes a byte of the document. The
struck-through old wording is display-only markup (`del.bfp-was`), inserted by
`content.js` and shut out of the text index, the snapshot and the article text
by four separate doors. `grep -n revert` over `server.mjs`, `store.mjs` and
`workspace.mjs` returns nothing.

So the auto-threads below **accept by being resolved** — the new text is
already in the file; ✓ is the reader saying they have looked. `↺` puts the
thread back in the open list, where the reader can tell the bots to put it
back, which is the remedy that exists today.

**If a real revert is ever built**, this feature is the one that makes it
cheap, and the shape is already determined by the record:

> `POST /revert {url, thread_id}`, owner-only (it edits the document, so it
> takes `/reanchor`'s gate and not `/resolve`'s). The companion resolves the
> page to a project artifact, refuses unless the root is confirmed, reads the
> file, and replaces the FIRST occurrence of the fold-normalized `thread.quote`
> with `thread.prior_quote` — refusing outright on zero matches or more than
> one, because a revert that guesses is a corruption. Then `savePage`,
> `broadcast('project-files')`, and the thread is resolved with a note saying
> it was reverted.
>
> The one thing it needs from the record is `prior_quote`, and **an auto-thread
> supplies it by construction** — it is written from the diff, so the "was" half
> is the file's own previous bytes rather than a sentence a bot typed. No
> special case, no second code path: a narrated thread and an auto-thread are
> the same three fields. The reason it is not built here is scope — a companion
> that edits the artifact is a new kind of writer in this system (locking,
> concurrent bot writes, a conflict story), and that is its own amendment.

#### 1. Layer (a): the bot says so — `also changed`

`bridge-system-prompt.md` gains **rule 5b**, beside rule 5's `now reads`:

```
also changed — this passage now reads: "…"
```

One line per collateral edit, AFTER the rule-5 line and never before it (
`store.newWording` reads the *first* match in a message, and a claim about
somewhere else must not be able to move the answering thread's own anchor).
A clause saying *why* is encouraged. The same sentence rides `chat.envelope`'s
write rules — which are on **every** turn on these pages, not just the first —
and the review round's preamble and per-comment turns (`workspace.reviewPreamble`,
`reviewTurn`), because a resumed session's replayed history is uneven and the
only thing a turn can rely on carrying is the turn.

The prompt explicitly tells bots that **opening threads on work they were asked
to do is expected** — it is the receipt, not clutter.

**These lines do not create threads.** A bot's sentence is not evidence about a
file. What they do is give the thread the *diff* created its **reason**: matched
by the wording they quote, the bot's own line becomes the auto-thread's first
message. A line quoting a wording the diff cannot find is dropped.

#### 2. Layer (b): the backstop — the file is the witness

`collateral.mjs` (new, pure, node-side). The census that already runs at the
turn boundary (`workspace.scanProject`) records mtime and size — enough to say
THAT the artifact moved, nothing about what moved in it. So `noteTurnStart` now
also keeps **the artifact's own bytes** (`SNAPSHOT_MAX` 4MB; a read that fails
is simply no snapshot and costs the turn its collateral threads and nothing
else) and the turn-start timestamp. At turn-end, where `page_changed` is true,
the before/after are diffed and every changed region no thread already covers
becomes a thread.

**The text the diff runs over is the text the PAGE carries** — `docBlocks`
splits on the same block-level tags `Anchor.buildTextIndex` separates on, folds
inline tags away, decodes entities, and drops script/style/doctype. A quote
synthesized from anything else would anchor to nothing. This is deliberately a
second implementation of a browser rule rather than a shared one (the companion
has no DOM and cannot borrow `anchor.js`'s walk), and it is kept honest the only
way that works: the harness drives a real page and asserts the synthesized quote
locates in it.

**Granularity.** Block-level LCS after a common head/tail trim, so a one-sentence
edit in a long draft diffs over a handful of blocks. Then:

| case | anchor (`quote`) | `prior_quote` |
| --- | --- | --- |
| `edit`, one block ↔ one block | the words that actually moved — shared head and tail are trimmed off at WORD granularity and become prefix/suffix, grown back out to `MIN_QUOTE` (24) so a three-word quote cannot anchor to forty places | the words they replaced |
| `edit`, multi-block | the whole changed run | the whole run it replaced |
| `insert` | the new text | *(empty — nothing left, so the page draws no strike-through; the thread still anchors and still turns amber)* |
| `delete` | **the surviving block that now follows the hole** (or precedes it, at the end of a document) | the departed wording — so the page strikes the deleted sentence through immediately before the paragraph that outlived it, which is where it was |
| a sentence deleted from INSIDE a paragraph | the whole surviving paragraph | the whole original — there is no shorter thing on the page to point at |

**Adjacent changed blocks merge into one region** — a bot that rewrote two
paragraphs in a row made one change there. Blocks with so much as one untouched
block between them are **never** merged: that would swallow prose nobody touched
into the quote and highlight a sentence that had not changed. Quotes past
`QUOTE_MAX` (1000) are clipped at a word boundary, which keeps them an exact
substring and therefore still locatable.

#### 3. What the extension had to change: nothing

This is the whole reason the feature is cheap, and it is worth stating as the
claim it is. `content.js`'s paint loop reads
**`t.addressed && !t.resolved && t.prior_quote`** off the record and asks no
questions about who wrote them or whether a bot ever said a word. So an
auto-thread — `quote` = what stands there now, `prior_quote` = what it replaced,
`addressed` set — paints struck-old-then-green-new on the page, sorts into
"Ready for review", clicks through to its card and files with ✓, through the
machinery that was already there. Written with `store.addThread` +
`store.setAddressed`; **no new endpoint, no new storage, no new event** (the
`project-files` payload gains `collateral: true`, and a `page` event is
broadcast so the tab refetches the record).

One field is new on the record — **`auto: true`** — and it exists for §4 to
read. Nothing renders differently on it. `auto_summary: true` marks the capped
note. Plugin-less visitors and the Obsidian export see an ordinary thread.

The one drawer change is two words wide: `rewriteHtml` took its "now" half from
the bot's narration, which an auto-thread does not have, so it now reads
`newWordingOf(t) || (t.auto ? t.quote : '')` — the thread was *born* anchored to
the new wording, so the quote IS the now.

#### 4. Dedupe — the rule that decides whether this helps or doubles everything

A change a bot **narrated** into the thread it was answering is already on its
way to being shown; an auto-thread at the same spot would be two cards and two
highlights fighting over one paragraph. The test is coverage of the **new** text
(fold-normalized containment either way, with a 16-character floor):

- **`newWording(t)`** for any thread — the narrated case. Caught *before* the
  extension has re-anchored anything, because the census runs at turn-end in the
  companion with no browser involved; that is the only reason the two paths can
  never race.
- **`t.quote`** for any thread — something is already anchored exactly there
  (the reader's own comment, or an auto-thread from an earlier turn that has not
  moved).
- one exception on the **old** text: a **non-auto**, unresolved, `addressed`
  thread whose quote is the wording that just left — the narrated case where the
  bot forgot to narrate. The change belongs to the reader's thread and they are
  already looking at it.

**The old text is otherwise deliberately not part of the test**, and this is the
subtle one: an auto-thread created last turn carries the old wording as its
quote, so matching on it would suppress the thread announcing that the passage
changed **again**. The reader would be shown one change and silently given two.
`!t.auto` on the exception above is what keeps that case open.

Layer (a) cannot double layer (b) either, because layer (a) never creates a
thread — it only supplies text to the one the diff creates.

#### 5. The cap

A backstop that spams the rail is worse than none: the reader stops reading the
rail and the one change they needed goes down with the rest. Past
`REGIONS_MAX` = 6 fresh regions, or where the changed blocks cover more than
half the document, or where the two versions are too far apart to diff at all
(`LCS_CELLS`), the turn gets **one summary thread** — anchored to the first
region so it clicks through somewhere real, saying how many passages moved and
listing up to 20 of them by their opening words. Never a silent drop.

#### 6. Send review

**Needs no new rule.** An auto-thread is `addressed`, and `workspace.openThreads`
already excludes addressed threads because a bot has had its go and it is the
reader's turn to look — which is exactly what an auto-thread is. `↺` "not done"
puts it back in the round, like any other ready thread.

#### Testing

`test/collateral.test.mjs` (75 assertions): the block extraction; granularity
(the words that moved, adjacent merge, no merge across untouched prose, insert,
delete, inner deletion, grow-back, clip); every dedupe branch **including the
second-change-to-an-auto-thread case that must NOT be suppressed**; the
`also changed` parse (that it takes the second quote and not rule 5's, that
`store.newWording` still reads rule 5's, that a human typing it claims nothing,
that a claim from before this turn is not this turn's, that an unconfirmable
claim attaches to nothing); both caps; and the composed record — `addressed`,
attributed, `prior_quote`, `auto`, 32-char context, and out of `openThreads`.

Harness **`?colledit=1&selftest=1`** (21 assertions) is the claim of §3 in a
real DOM: a thread written by a diff, with **no narration anywhere on the page
to parse**, produces the amber highlight on the new wording, the struck old
wording immediately before it, the arrival underline, the card's before→after,
and the "nobody commented here" text — with `/reanchor` never posted once. Then
the reader's switch takes it off and puts it back, and ✓ files it sage.
`?colledit=1` alone is the screenshot state.

#### Known limits (deliberate, documented rather than fixed)

- **Attribution on `@all` turns.** The diff cannot tell which of two bots wrote
  which line, so the thread is authored by the first agent on the turn and its
  text says "the bots".
- **A trailing deletion** anchors to the *preceding* block, so its struck
  wording renders before that block rather than after it.
- **A `delete` region's card diff** reads as "departed wording → surviving
  paragraph", which is a replacement it was not. The page markup is right; the
  card's word-diff is approximate.
- **Only the artifact's own file** is diffed. Other files the bots changed in
  the project are still reported by the census as "N files changed" and nothing
  more — they are not what the tab is showing.

### Amendment (2026-08-24, shipped): a thread remembers who it is talking to

The tag rule — *an @-mention is the only thing that summons a bot* — was read
literally and the reader's intent not at all. Tag `@claude` under a passage, ask
the follow-up without retyping the tag, and the follow-up became a note to self:
a dead message in a live conversation, and the most-complained-about thing about
comment threads. A thread is a conversation with somebody. It now says so.

#### The sticky address (`chat.stickyRoute`)

A thread's address is the LAST message the reader wrote in it, read two ways:
the tag in its words (`routePrefix`), or — where a pill said it instead of a tag
— the `route` the companion stamped on the message when it was written. Bot
messages are not read (a bot writing "@codex, over to you" is narration, not the
reader's address) and neither is a `tools` line. An earlier tag never wins.
`''` is a real answer and means nobody, which is what a thread the reader has
only ever taken notes in still is.

`workspace.reviewRoute` was rewritten to CALL it rather than restate it, so a
send-review round and an untagged reply can never disagree about whose thread it
is — and a thread addressed by clicking a pill is a codex thread in a round too,
though the word "@codex" was never typed in it.

#### Precedence, stated once (`server.mjs addressOf`)

1. an **@-mention in the words** — the sentence the reader just wrote
2. the **composer pill on the wire** (`route` on `/thread` and `/reply`)
3. the **thread's sticky address**
4. **nobody** — a note, exactly as Discuss began

A tag beats a pill because the tag is *in* the message and the pill is beside
it. `none` is a real choice and not an absent one: it is how a reader steps out
of a conversation and writes a plain note under a passage they were discussing,
and it unsticks the thread for the next message too.

**Comment threads only.** Page chat is untouched: its untagged rule is the one
`untaggedGoesToAll` states (the room on a project artifact, nobody anywhere
else), a `route` on the wire cannot talk it into a second one, and the composer
there grows no pills.

The resolved address rides the turn as `routeHint`, the third and weakest
register of `chat.routeOf` — `untaggedAll`/`forceAll` first, then the text's own
tag, then the hint. The reader's words are never rewritten: the prefix is the
envelope's, as it always was. A message that summons this way carries the page
context and any `.docx` digest exactly as a tagged one does (`mentionContext`,
`docxDigestOf` — a summoning message needs the page in front of the bot however
it got addressed). And `store.appendMsg`/`addThread` stamp `route` on the
message, absent on a bot's and absent on a note: the field only ever records an
address, and it is what makes a pill stick with nothing to read in the text.

#### The pill row

Above a thread composer, folding with the Send row and for the same reason (a
column of idle threads must not cost a line each): `Note · Claude · Codex · All`,
the current address lit in the drawer's accent. Bot names come from the live
roster (`agentRoster`), not from this file. Clicking one aims the next message
and leaves the draft and the caret where they were; typing a tag lights that bot
as it is typed (`syncRoutes`, repainted in place — re-rendering a composer under
a caret loses the caret); sending settles the row on where the message actually
went, so the next untagged reply goes where the reader can already see it will.
A brand-new thread's composer carries the row too, defaulted to Note, which is
Discuss's original rule drawn instead of assumed.

The phone reading room has the same row over the same rule (`reader.js`,
`views.mjs` styling), sending the same `route` field. The no-script form
composer sends none — and needs none, because the sticky address is decided
companion-side for any client that says nothing.

#### Testing

`companion.test.mjs` — `stickyRoute` and `routeOf` as pure functions (an empty
thread, the last human tag winning, an earlier one not, both-tagged = the room,
a bot's tag and a `tools` line claiming nothing, a pill-stamped message counting
and its words still outranking its stamp, a hint filling in only for an untagged
message) and a real thread against the mock bridge: the opening `@claude`, the
untagged follow-up reaching claude, a new tag re-aiming it, a bot's reply not
re-aiming it, `Note` summoning nobody AND unsticking the thread, a pill routing
a message with no tag in it and sticking, a tag beating the pill beside it, a
pill on the first comment, a thread nobody ever addressed staying a notebook,
page chat untouched (both directions), and a nonsense route ignored rather than
obeyed. Harness `?selftest=1` drives the row in the DOM: every thread composer
carries one, the four pills in order, Note lit on a thread whose last word
tagged nobody, a typed tag lighting that bot and only that bot, clearing it
handing the row back to the thread, a click aiming the next message with the
draft surviving, and page chat with no row at all. `?routes=1` is the screenshot
pose.

### Amendment (2026-08-24, shipped): a single-page app moved the reader

**The bug.** One reader's comment on a Medium article was filed against a
*different* Medium article they had been reading ten minutes earlier. Not
`normUrl` (the two slugs hash differently) and not the companion (every write
route resolves the page from the url on the wire). The extension: `URL_NOW` was
a `const`, resolved once at injection, on the reasoning that "a real navigation
reloads the content script". True of a link; false of an SPA. Medium, Substack
and their like swap one article for the next with `history.pushState` — the
document is never torn down, the content script is never re-injected — so every
url this tab put on the wire afterwards named an article that had left the
screen. The quiet half of the same bug: `refresh()` reads `headline()` live, so
the OLD record silently acquired the NEW article's title, and `snapshotNow()`
wrote the new article's text over the old article's snapshot.

**The invariant now enforced:** a message is filed under the document the reader
is looking at when they send it.

- Identity is **re-derivable**, not frozen: `readCanonical` / `identityFor` /
  `rebindIdentity` run the live address through the very same funnel that
  decided it at load — the canonical link re-read (an SPA rewrites it on the way
  past), `Adapters.canonicalPageUrl` applied again, `normUrl` applied again. No
  site is special-cased. `IDENT_HREF`, `URL_NOW`, `CANONICAL_HREF` and the three
  per-page storage keys became `let`; `__bfp.url`/`identHref`/`canonical` became
  getters.
- **The section-splinter case is unharmed, and that is the point.** A route
  change that resolves to the identity already held returns false and changes
  nothing — `/post-slug-section-3` still collapses onto `/post-slug`. Only a
  genuinely different document rebinds. Where an ADAPTER or a project artifact
  owns the identity the address bar never was the identity, so a route change
  there means nothing and is ignored outright.
- **When it does move**, the tab stops being the old page's: `forgetPage()` (the
  reset that already existed for "you deleted the page you are standing on",
  extracted rather than written twice) unpaints, drops the record, re-arms the
  first-turn context and the snapshot; the storage keys move; `hello` re-keys
  the tab in the worker so the bots' replies are delivered to the right page;
  and the new page is loaded as a fresh injection would have loaded it — dormant
  unless the companion says it is annotated, because activation is still not an
  act.
- **Three detectors and a gate.** `history.pushState`/`replaceState` wrapped
  (narrowly, never swallowing the site's own call), `popstate`, and a `<head>`
  MutationObserver as the last resort for a router that does neither — all
  coalesced into one deferred check, because a framework rewrites the address
  first and the document a moment later. Then the gate that makes it a promise
  rather than a race: `ensureRegistered()` — which every write goes through
  first — re-checks before the url goes on the wire, and `refresh()` re-checks
  before it can post a title.

**Testing.** Harness `?canon=1&selftest=canon` now covers both directions: the
splinter pushState still moving nothing (unchanged), and then a route change to
a DIFFERENT document — canonical rewritten, path pushed, exactly as Medium does
it — moving the identity, saying hello about it, re-reading the record for the
document now on screen, and filing the next message under it and never under the
one the reader has left.

**The data.** The one misfiled record was repaired by hand: the thread moved to
the correct page record, the emptied record and its index row removed. Its
council session was left on disk rather than deleted.

### Amendment (2026-08-24, shipped): the diff heals the orphan it made

Track changes moves a comment onto the passage a bot's change put there — but
only where the bot **said so**. Rule 5's `now reads: "…"` is what the page has
to locate against, and `store.reanchorThread` refuses anything else on purpose:
a claim is not evidence that a wording is on the page.

So the silent case fell through the floor, and it is not a rare one. A bot
rewrites the passage a reader's comment is anchored to while working on some
*other* comment, narrates nothing into that thread, and the reader comes back to
their own comment on their own draft **pointing at nothing**: no highlight, no
struck old wording, a card that says `orphaned` and stops there.

The information to fix it already existed. The turn-end diff
(`collateral.mjs`) holds the departed wording and the wording that replaced it,
and it was already matching that pair against the reader's threads — using the
answer only to keep quiet. `coveredBy`'s third branch treated "this change
belongs to a thread the reader is looking at" as a reason to skip the region.
True of the card. A lie about the page.

**So the diff now routes into the thread instead of past it.**

#### 1. Why the file may re-anchor and a sentence may not

Worth stating plainly, because it looks like a hole in the `/reanchor` gate and
is not one:

> `/reanchor` is the PAGE's door. The companion has no DOM, so a bot's claim
> about a wording is unverifiable there and could destroy an anchor that still
> matched perfectly — the extension has to locate it first.
>
> This is the FILE's door. The diff did not claim the new wording is in the
> document; it read the document's own bytes, before and after the turn, and
> the wording came out of the "after". There is nothing left to prove, which is
> also why the two paths cannot race: `coveredBy` runs first, so a thread that
> narrated its change is left to the page, every time.

`store.healThread(thread, {quote, prefix, suffix, deleted})` — companion-side
only, **not exposed over HTTP**. No client asks for this: it happens at
turn-end, from bytes on disk, or not at all. Same three-field result the
narrated path produces, so nothing downstream can tell the difference.

#### 2. The two shapes

| the change | `quote` becomes | `prior_quote` | the card |
| --- | --- | --- | --- |
| **rewrite** | the wording that replaced the passage | the reader's own quoted passage | the ordinary before→after, on the reader's card |
| **delete** | the surviving block next door (the diff already computes this anchor for a delete region) | the departed passage | `this passage was deleted` — `gone` / `now on`, never a word diff |

A deletion drawn as a rewrite would read as an edit that never happened —
"the sentence that left" word-diffed against "the paragraph that outlived it" is
a replacement nobody made. `deleted_passage` is the one new field, and the one
thing on the card it changes.

#### 3. What the extension had to change: two things, both small

The paint loop is untouched — `t.addressed && !t.resolved && t.prior_quote` is
still the whole contract, so a healed thread paints struck-old-then-green-new
with no new code at all. What changed in `drawer.js`:

- `rewriteHtml` takes its "now" from `newWordingOf(t) || (t.auto || t.healed_at
  ? t.quote : '')` — a healed thread is in an auto-thread's position (nobody
  narrated it, so the quote IS the now);
- …and returns the deleted card outright when `deleted_passage` is set, before
  any diffing is attempted.

The narration the bot never wrote is appended to the thread as a real message,
by the agent that ran the turn — which is also what flips it amber
(`appendMsg` sets `addressed` for an agent author), so it sorts into Ready for
review with everything else the bots did.

#### 4. The rules, and why each one is load-bearing

- **`!t.auto`.** An auto-thread is the machine's note, not a reader's comment.
  A second change to that passage is news to report (a fresh thread), not a
  rewrite of the note — the case §4 of the collateral amendment has protected
  since it shipped, and the reason healing is scoped to threads a person wrote.
- **`!t.resolved`.** A filed thread is closed. Healing it would drag it back
  onto the page under a green highlight nobody asked to move.
- **No `addressed` requirement**, unlike the old skip branch. A thread nobody
  answered is exactly the one at risk: the bots were working elsewhere and took
  the passage with them.
- **One heal per thread per turn**, so two regions cannot fight over one anchor.
- **A healed region never also spawns an auto-thread.** Two cards and two
  highlights over one change is the failure this whole feature exists to avoid.
- **Heals are not capped and are never replaced by the summary note.** The cap
  exists to stop the rail filling with threads nobody asked for; a heal adds no
  row to the rail — it repairs one that is already there — and "the document
  changed a lot" is no reason to leave a reader's comment pointing at nothing.
- **Both granularities are matched.** `regionsFrom` narrows a one-block edit to
  the words that moved (right for an auto-thread: "these words changed"), so
  each edit region also carries the un-narrowed `whole` pair. Healing matches
  on either — a four-word narrowing can fall under the 16-character overlap
  floor — and **anchors with `whole`**, because a reader's comment was on the
  whole passage and shrinking their highlight to a fragment would leave the
  card diffing a sentence against a piece of one.

#### Testing

`test/collateral.test.mjs` (75 → 111 assertions): the unanswered orphan healed
rather than stepped over; a narrated rewrite left to the page; a resolved
thread and an auto-thread both refused (and the change reported on its own
instead); the deletion anchoring to the survivor and marked; two changed places
where only one is a heal; the bot's `also changed` line borrowed as the reason;
and the composed record end to end — the paint contract satisfied,
`prior_quote` written once across two heals, idempotence, and the refusal at
the store.

Harness **`?orphanheal=1&selftest=1`** (14 assertions) and
**`?orphanheal=delete&selftest=1`** (16) drive it in a real DOM, with the page
itself rewritten under the thread: the highlight back on the page, the struck
passage immediately before it, the orphan badge gone, the card's diff (or the
deleted card, which must draw no diff), no bot narration anywhere to parse,
**`/reanchor` never posted**, and ✓ still taking it all down. Without
`&selftest=1` both are screenshot states.

#### Known limits (deliberate)

- A heal borrows the diff's anchor, so a **trailing deletion** anchors to the
  *preceding* block — the same limit the delete auto-thread already carries.
- Attribution on an `@all` turn is the first agent of the turn, as everywhere
  else here: the diff cannot tell which bot wrote which line.

### Amendment (2026-08-24, shipped): the review round, as one visible thing

Send review fans a round out into one turn per open comment. Each of those
turns spins its own card and re-renders it when the answer lands — which is
right for the card and useless for the round. Twenty comments in, the reader
had no count, no position, and no way to tell "still working" from "finished
and quiet". The footbar could not say it either: it reports the TURN in flight,
which is one twentieth of the thing they started.

**A second, persistent line, above the footbar, that belongs to the ROUND.**
Same rail, same type, same 34px rhythm — they are two lines of one status
region — with an accent left edge as the only thing separating them, because a
reader glancing down needs to know which line answers "is it still going?".

#### 1. The state is the companion's, and that is the whole design

`rounds` (server.mjs): page url → `{pending, quotes, total, answered, current,
started_at, done_at}`.

The companion is what HAS the round. It built the queue in `/send-review`, it
names the threads, and it sees every turn boundary. A drawer counting turns for
itself would be wrong the moment a tab was refreshed, reopened, or opened
second — and would have no idea what happened while it was not listening.

- `startRound` fires in `/send-review` where the queue is known, so the strip
  can say "0 of 12" while the preamble is still going out. The preamble turn is
  deliberately not one of the twelve: it is the round announcing itself.
- `roundTurn(ev, 'start'|'end')` hangs off the same `turn-start`/`turn-end`
  events the census already uses, and only for a target in `pending`.
- The round ends when `pending` empties. That **counts a stranded turn** —
  `chat.mjs` emits `turn-end` for every job it drops when a bridge dies — which
  is deliberate: the strip must not spin forever because a bridge fell over.
- Broadcast as `{type:'round', …}` on every transition, and routed by the
  background worker to the tabs showing that page, like every other event
  carrying a url.
- Kept `ROUND_KEEP_MS` (5 min) past the end, so a tab that was closed for the
  last turn comes back to the outcome rather than to silence.

**`GET /round?url=`** is the other half: a tab that woke mid-round asks, and the
strip is right on its FIRST paint instead of appearing at the next turn
boundary. Owner-only, like everything else about a round — it describes a queue
of the owner's agent time.

#### 2. What the strip says

- in flight: `◐ answering comment 4 of 12  “the quote…”  3/12`
- between turns: `◐ 3 of 12 answered · waiting for the next turn` — because
  claiming a comment is being answered when none is would be a small lie
- at the end: `✓ round done — 12 of 12 answered  ✕`

**Naming the comment is the point of it.** "4 of 12" alone is a progress bar,
and a progress bar is not what a reader wants here; the quote makes it a place,
and clicking it focuses and scrolls to that thread through the same `onJump`
the card's own quote uses. The label never truncates and the quote gives way
first — "answering comment 2 o…" is worse than no strip at all.

The done note is dismissible. A note that cannot be put away is a note that
eventually gets ignored.

#### 3. The drawer holds none of it

`D.round` is the broadcast, stored verbatim; `paintRound()` is a pure function
of it; `setRound()` is the `/round` answer arriving. Nothing is computed,
inferred or counted in the tab — which is exactly why a refresh, a reopen and a
second tab all agree.

#### Testing

`test/workspace.test.mjs` (116 → 120): the round's shape and length over the
wire after a real fan-out against the mock bridge; the end state (running
false, `answered === total`, `current` null, `done_at` stamped); a page with no
round answering `null` rather than an empty round; and the owner gate.

Harness **`?roundticker=1&selftest=1`** (16 assertions): the tab ASKING for the
round it walked in on, the strip naming the length and the position, the
spinner, the count, the comment named and clickable, clicking it focusing that
card, a turn boundary moving it on and renaming it, the between-turns wording,
the done note with its count, the spinner stopping, and the dismiss.
`?roundticker=1` and `?roundticker=done` alone are the screenshot states.

### Amendment (2026-08-24, shipped): parallel turns — several conversations at once

One bridge child runs ONE turn at a time. That is the bridge's protocol and not
a choice this companion makes: `ready` is the turn boundary and there is only
one of it. For as long as every ordinary page shared one child, that made every
turn in the building wait for every other one — a question on a blog post
queued behind a twelve-comment review round on a paper, and a send-review
fan-out held the whole companion for minutes with nothing else able to speak.

The fix is more children. The entire difficulty is deciding which turn may go
to which child, and two rules answer it:

1. **A lane is a conversation.** Turns in one lane are strictly serial, in
   submission order, on ONE child. A page's chat is one session; its ordering
   is its meaning.
2. **Different lanes run at the same time**, up to a cap.

#### 1. The lock taxonomy

There are exactly two kinds of lane, and `chatFor(url)` in server.mjs is the
whole of the decision:

| page | lane | what serializes it |
| --- | --- | --- |
| ordinary web page (and the library) | `pg:<normalized url>` | the pool binds the lane to one child (pool.mjs) |
| project artifact, confirmed root | the PROJECT | that project already has a child of its own: one `(root, project_id)` → one process → one FIFO |

The second row is the **per-project write lock**, and nothing had to be built
for it. It was already load-bearing before parallelism existed: Phase 2 bakes
the one writable directory into the child's environment at spawn, so a project
has had a child to itself since 2026-08-18. Parallelism was written to leave
that arrangement exactly alone.

An **unconfirmed** root still routes to no bridge at all, unchanged.

#### 2. What this buys, and what it deliberately does not

Concurrent: two ordinary pages; an ordinary page and a project; two different
projects; an ordinary page and a review round.

Serial, on purpose:

- **Two turns on one page.** A page's chat is one botference session. Two
  children driving one session id is a silent lost turn (§5), and interleaved
  turns in one conversation are not a conversation.
- **Two pages in one project.** They share a writable directory and a change
  census. Everything that attributes an edit to a turn depends on this.
- **A send-review fan-out.** The round is one conversation across many threads,
  its turns all belong to one page, and the round ticker counts turn
  boundaries. It is serial because it is one lane, not because a rule was added
  for it.

Both of the fragile machines are therefore safe **by construction rather than
by care**:

- the **collateral census** (`noteTurnStart` → `reportProjectChanges` →
  `collateral.mjs`, including the orphan healing) snapshots a PROJECT DIRECTORY
  at turn-start and diffs it at turn-end. Nothing that shares a project
  directory can run concurrently, because a project is one child.
- the **round ticker** (`rounds`, `{type:'round'}`, GET `/round`) counts
  turn-start/turn-end on ONE page. Nothing that shares a page can run
  concurrently, because a page is one lane. A turn on another page emits
  boundaries for another url and `roundTurn` never sees it.

#### 3. The pool (pool.mjs)

`createPool({onEvent, max, idleMs})` presents exactly the surface one bridge
presented — `submit`, `control`, `models`, `interrupt`, `state`,
`queueLength`, `busyFor`, `jobs`, `stop` — so server.mjs binds it to `chat` and
everything downstream reads as it always did. `bridge_pool: 1` is the old
behaviour, unchanged, and is the degenerate case the whole of
`test/companion.test.mjs` still runs on.

**Choosing a child**, in order:

1. the one this lane is already bound to — ordering, and §5;
2. a child holding no lanes at all — free capacity, no sharing;
3. a new child, if under the cap — parallelism is the point;
4. the least encumbered child — fewest lanes, then shortest queue.

**The primary** is `members[0]`. It exists from the first moment (the object,
not the process — the child is as lazy as it ever was), it is what the model
and effort pickers read, and it is never reaped. Retiring one is logged to
stderr and NOT broadcast: a `bridge` event would write it into the drawer's
footer, and housekeeping is not something the reader is waiting on.

This is the arrangement the council web UI has run for a while (one bridge per
open chat, `COUNCIL_MAX_CHATS`, idle chats parked at the cap). Discuss's lane
is a page rather than a chat, and its cap counts children rather than chats,
but the shape is deliberately the same one.

**Reaping.** A child beyond the first that has been idle longer than
`bridge_idle_ms` is stopped and its lanes released. The pool grows to meet a
busy afternoon and shrinks back to yesterday's footprint when the reader stops;
the cost of being wrong is one "waking the agents…" the next time that page
speaks, which is a wait the drawer already knows how to say. `0` never reaps.

#### 4. What the reader is told while waiting

`chat.submit` reports `wait`, and it now has three values:

| `wait` | the drawer says | means |
| --- | --- | --- |
| `bridge_starting` | waking the agents… | no child yet, or it has not booted |
| `busy` | queued behind this conversation… | this lane's own previous turn has the floor |
| `pool_busy` | queued behind another chat… | every child is on somebody else's lane |

Only the pool can tell the last two apart, so `chat.mjs` reports `busy` for any
warm child and `pool.submit` refines it by asking `busyFor(url)` **before** the
push.

`cold` in chat.mjs was fixed on the way past: it read `!available || !ready`,
and `ready` is false for the whole of every turn — so a turn queued behind a
live one said "waking the agents…" through the entire wait and `busy` was
unreachable. It now reads `!available || !running`, which is what cold meant.

#### 5. WHY A LANE NEVER MOVES OFF A LIVE CHILD

The controller's session file (`<work>/sessions/<sid>.json`) is rewritten whole
on every persisted turn — atomically, but with **no lock and no version check**
(`core/session_store.py`). Two children driving one session id is therefore a
silent whole-turn loss: A resumes S, B resumes S and saves, A persists its
stale copy and B's turn is gone. Nothing in Python enforces the invariant that
stops it; it is held in Node, and it is held here.

So a lane binds on its first turn and stays bound for as long as that child
exists. Load is balanced at binding time and **never afterwards** — the
dispatcher will let a lane wait behind another lane on its own child while a
different child sits idle, and that is the correct trade: the wait costs
seconds and the migration would cost a turn, silently. A lane is released only
when its child is gone (reaped, or exited), which is exactly the condition
under which the old child can no longer write that session file.

`/resume` re-reads from disk every time (`_resume_session`), and chat.mjs
re-issues it whenever the bridge's active session is not this page's — so a
lane picked up by a fresh child after a reap sees the whole transcript.

#### 6. Failure modes

- **A child dies mid-turn.** `chat.mjs died()` strands only ITS queue: an error
  and a `turn-end` per dropped job, for that child's lanes alone. Other
  children never notice. The pool releases the dead child's lanes on the
  `{state:'exited'}` event, so the next turn re-decides where those pages go —
  the object stays in the pool, because chat.mjs leaves a dead child
  restartable and a restartable child is capacity, not a corpse.
- **Stranded turns and the ticker.** A stranded turn still emits `turn-end`, so
  a round whose child died completes rather than spinning for ever. That was
  already true and stays true.
- **Restart.** A companion restart still eats every queued turn. A queue in
  memory cannot fix that and this amendment does not pretend to. What it does
  is stop `queue: 0` from being the only thing a reader can ask: GET `/health`
  now also returns `queues` — one row per page with anything running or waiting
  (`{url, running, queued}`) — and `bridges: {live, max, workspace}`. "Is MY
  page's turn the one running or the one behind?" is now answerable.
- **`/delete <sid>`.** Deleting a page's chat must reach the child that holds
  that session in memory, not "some running child". `pool.controlFor(url, …)`
  routes to the lane's holder and answers false when nobody holds it — in which
  case no child owns the file and the companion removes it itself. Sharper than
  what it replaced, not looser.

#### 7. The gap this opened, and how it was closed (2026-08-25)

Every child in the pool works in the same root and files under the same project
("Plugin pages"). The session index and the project index are both `flock`'d
and safe. The controller's **per-project scratch files were not**:
`work/handoff-<model>.md` above all, plus `implementation-plan.md` and
`checkpoint.md`, were scoped to the planning root rather than to a session, so
two children relaying at the same moment could overwrite each other's handoff.
It was rare (a relay needs a context ceiling and these turns are short) and it
cost a relay rather than a transcript. This amendment shipped with that
recorded as designed-not-built; the controller side landed the next day, and
all three parts are now **built**:

- **Per-session scratch.** `BotferencePaths.session_scratch_dir(sid)` roots
  everything one chat writes for itself at `work/scratch/<session-id>/`.
  `handoff-<model>.md` moved there outright — it is pure scratch, nothing
  outside the relay reads it — and `handoff_live_candidates()` still lists the
  old root-scoped path second, so a chat resumed across the upgrade finds the
  artifact its previous process left and `_clear_live_handoff()` removes both.
- **The plan and the checkpoint kept their canonical paths**, because they are
  deliverables and not scratch: the artifacts panel lists them, `/project
  build-plan` copies them, and the planner's tool allowlist names them by
  path. Each chat now also writes a mirror under its own scratch dir, plus a
  `.<name>.owner` sidecar naming the last writer. A read takes the canonical
  file whenever this chat owns it — so a hand-edited plan is still the plan —
  and falls back to the chat's own mirror only when the sidecar names somebody
  else, which is exactly the concurrent-write case. Losing the race on the
  shared file therefore no longer feeds a stranger's plan into your
  `/finalize`, and never destroys your own copy.
- **`SessionStore.save` has a stale-write guard.** The store remembers the
  mtime it last wrote or read per session id; a save whose file has moved
  since re-reads it and raises `StaleSessionWrite` **only** when the copy on
  disk has MORE transcript entries than the payload being written — the one
  shape of the race that loses a whole turn. Equal, shorter, unparseable, or
  first writes all proceed, so the single-writer case costs one `stat` and
  never blocks. `_persist_session` catches it, logs an error and appends to
  the crash log rather than crashing or writing anyway. It is a belt: the
  invariant is still held in Node (§5), and this is not a locking framework.
- **`ProjectStore.set_status`** now takes the same `file_lock` on
  `portfolio.json` as `_upsert_portfolio_entry` and `associate_session`.

Covered by `tests/test_paths.py::TestSessionScratchPaths` and, in
`tests/test_botference.py`, `TestSessionKeyedScratch`,
`TestStaleSessionWriteGuard` and `TestProjectStatusLocking` (19 tests; pytest
709 → 728).

#### 8. Configuration

`config.json`, both clamped and both overridable by environment (the test
escape hatch, `PLUGIN_BRIDGE_CMD`'s precedent):

- `bridge_pool` (default **3**, 1–8, env `PLUGIN_BRIDGE_POOL`) — how many
  children the plugin's own pool may run at once. Each is a python bridge with
  a claude and a codex CLI under it, so this is a resource decision. `1` is the
  pre-amendment world exactly. Project-artifact pages are not counted by it:
  their child is per project and always has been.
- `bridge_idle_ms` (default **15 min**, env `PLUGIN_BRIDGE_IDLE_MS`) — how long
  a child beyond the first may sit idle before it is retired. `0` never
  retires one.

`readConfig()` was fixed on the way past: its first-run branch returned the raw
defaults without normalizing them, so an environment override was honoured on
every run but the first — which is the run a throwaway root always is.

#### Testing

`test/parallel.test.mjs` (23), in two halves:

- **the dispatcher on a fake bridge**, every turn boundary a method call and
  not a timer: a lane per page, a child per lane up to the cap, two turns on
  one page serial on one child, no migration off a live child even with an idle
  one beside it, sharing at the cap by fewest-lanes-then-shortest-queue,
  `bridge_pool: 1` being yesterday, a death stranding only its own lanes,
  reaping (and never the primary, and never a busy child, and never at all at
  `idleMs: 0`), `controlFor` reaching one child and no other, a process-wide
  setting reaching all of them, and the clamping.
- **a real companion with several mock children**: two pages answering at once
  while one page never does; `/health` naming whose turn runs and whose waits;
  a cap of one being strictly serial; a child killed with `SIGKILL` stranding
  its page and only its page while the other still gets its answer; two pages
  in ONE project serial and two projects concurrent; a send-review round of
  three comments staying ordered, counting straight and landing every answer in
  its own thread while an unrelated article page is answered in the middle of
  it; and a collateral edit attributed to the turn that made it with an
  unrelated page's turn running for the whole of that turn.

`test/mock-bridge.mjs` grew `MOCK_LOG_DIR` (one log per child, named by pid —
a single log cannot answer "which child sent this"), pid-stamped session ids
under it (two children both starting their counter at 1 is a collision the real
controller cannot have), and `[mock:sleep:N]` for holding one turn open while
another runs.

`test/companion.test.mjs` runs at `PLUGIN_BRIDGE_POOL: '1'` throughout, and
that is deliberate: almost every test in it is about what a single child is
told and in what order, read off one shared log. It therefore remains the proof
that the degenerate case still is what it was.

### Amendment (2026-08-25, shipped): the project's own task list

The drawer has had a tasks card since the checklist work: the newest checklist
in THIS page's conversation, derived from the record, pinned at the top of both
panes. It belongs to one conversation, and the bots are told to re-issue it
whole every time it changes.

There is a second kind of list that card cannot be. A project accumulates work
across many conversations, and the thing that survives them is a file:
`projects/<id>/TASKS.md`. The bots curate it — **extend, tick, prune, and never
rewrite wholesale** — because another chat's items live in it and a wholesale
rewrite deletes them where nobody can put them back. Those rules are in
`core/room_prompts.py::project_tasks_note()`, added with this amendment (only
the in-chat checklist rules existed before), and the controller adds the note
only when a project is open, naming that project's real path.

#### What the plugin does with it

`workspace.projectTasks(root, id)` reads and parses the file — a deliberate
mirror of `parse_tasks_md` in `core/project_store.py`, same bounds (256 KB,
200 items, 300 characters a line) and same tolerance, because two parsers that
disagree about a file are worse than one. It is bot-written markdown, so
anything that is not unambiguously a task line is skipped: prose, headings,
tables, plain bullets, an empty item. `-`, `*` and `+` all count; `[x]`, `[X]`
and a bare `[]` all count; a duplicated item counts once.

`GET /project-page` carries the result as `artifact.tasks`, and **only on a
confirmed root** — an unconfirmed root is a folder the reader has not yet said
belongs to them, and reading its files into the drawer would answer that
question on their behalf. A project with no list gets no key at all, so the
drawer sees an absent section rather than an empty one.

The drawer renders it as `.tasks.ptasks`, above the page's own tasks card in
both panes, drawn one step quieter (dashed edge, muted accent instead of an
author's colour, because no author wrote this one). Its boxes are **disabled**:
nothing in the browser owns that file, and a tick would mean the companion
rewriting somebody else's markdown. The fold is session state like every other
reading position here.

`fillTasks()` was fixed on the way past. It walked `.tasks` and rebuilt every
card it found from the page's newest message — which, once a second card
existed, painted this page's checklist into the project's card and left it
claiming to have come from `TASKS.md`. It now walks `.tasks:not(.ptasks)`.
Caught by looking at a screenshot; the two cards were byte-identical and no
test would have said a word.

The council web UI grew the same section from the same file, fed by the
`projects` event (`ProjectPanelProject.tasks`) rather than by an endpoint of
its own. Those are the two tasks panels this list appears in; the Ink TUI has
a projects pane and no tasks panel, so there was nothing there to add it to.

#### Testing

`test/workspace.test.mjs` (120 → 126): the parser against a deliberately
horrible file, junk in / nothing out, the two bounds, `projectTasks` over a
real fixture root (missing file, missing project, a DIRECTORY where the file
should be), and on the wire — an unconfirmed root's list never leaving disk, a
confirmed project's list arriving with the page, following the project rather
than the page, and disappearing when the file is deleted.

Harness `?workspace=1&selftest=1` gained the card's assertions (its items, the
struck-through tick, the count, the disabled boxes, the project name and the
file name, both panes, the fold); `?workspace=1&ptasks=0` is the project that
keeps no list, and asserts the card is absent.

### Amendment (2026-08-25, shipped): one store, and the commenters in it

Two halves of one idea, and the first is the reason the second exists.

#### Half one: the visitor's comments come home

"One margin, and it is Discuss's" (2026-08-19) settled what happens on a review
page when the plugin is installed: Discuss keeps the margin, and the page's own
selection pill is put away. It said, correctly, that **nobody else is affected**
— a visitor without the extension gets the page's built-in commenting exactly
as the page ships it.

That sentence was true and the situation it described was bad. The visitor's
comment went into `review/state/users/<handle>.json` and stopped there: a line
in a JSON file beside the document. The owner's drawer could not see it. The
bots were not in it. **Send review** did not gather it. The Obsidian export
never heard about it. Meanwhile the owner, reading the same page with the
extension, wrote into the companion's store. **Two records of one
conversation, neither knowing the other existed** — and the person who had
least reason to know that was the visitor, who had simply typed into the margin
they were given.

So the comments MOVE. One way, into the companion:

```
review page  ──POST /review-comments──▶  companion   every user-comment,
                                                     under its own id
review page  ◀───GET /page?url=───────   companion   whatever was said back,
                                                     folded into the margin
```

**Why this direction and not the other.** The companion's record is the one
with the bots, the send-review digest, the pages library, the round ticker and
the export hanging off it. The review record is a file beside a document.
Moving the small thing into the big one costs one endpoint and leaves everyone
on both surfaces looking at the same conversation; the reverse would have meant
teaching the drawer, the digest, the library and the export about a second
store, and would still have left the bots on the wrong side of it.

**Where it lives.** `frontends/review/discuss.mjs` — the review server's half —
plus one endpoint here. Every byte crosses between two servers on the loopback,
so a guest's cookie, the tunnel's CORS rules and the review page's own
scriptless margin are all left out of it.

##### The door: `POST /review-comments`

**Loopback only**, the same three-part `isLocalDirect` test the API keys stand
behind, and for a sharper reason than theirs: this endpoint **names its own
author**, which is exactly the power a guest must never hold. A caller on this
machine already owns the files these threads live in — naming one there is no
privilege it did not already have. Through the tunnel it is a flat 403 whatever
credential it carries, and unauthenticated it never reaches the route at all.

One POST carries every comment on one page:

```
{ url, title?, site?, summon?,
  comments: [ { id, author, ts, quote, prefix, suffix, text, resolved?,
                replies: [{author, ts, text}] } ] }
→ { url, threads: {<id>: <thread_id|"__page__">}, created, appended, skipped, refusals }
```

It is a **projection, not a second write path**, and therefore idempotent by
construction: each comment is filed under `origin: {system:"review", id}`
(store.mjs), and one already there is left alone. The review server re-posts a
page whenever anything on it changes, so "already seen" is the common case and
has to cost nothing.

What crosses, and why each:

```
author     the file the comment lives in — authorship is the point of unifying
ts         the moment it was WRITTEN, or the page's history would say every
           visitor commented the second the companion first heard of them
quote      the anchor. prefix/suffix ride along when the page has them
replies    the visitor's own follow-ups, each landing once (author + ts)
resolved   filed over there files here — see below
```

**A comment with no quote goes to page chat.** The review engine's block-level
comment is about the document rather than a passage; Discuss already has the
surface for exactly that thought, and minting an anchorless thread would only
produce an orphan.

**Resolving travels one way, and once.** Filed over there files the thread here
— the person who wrote it has said they are done. Reopening here is never
undone: `origin_filed` is the one bit that remembers we already acted, so a
months-old `resolved: true` cannot close a thread the reader has just reopened,
and it is cleared when the review record says the comment is open again, so a
genuine re-file files it again. **Nothing is ever deleted.** A comment
withdrawn over there leaves its thread standing, because that thread may by now
hold a bot's answer and the owner's reply, and neither belongs to the person
who withdrew the question.

**The bots, once.** `summon` is set only when the paper is running WITHOUT its
own `--chat` bridge. A paper that has one already answers its margin mentions
there and its answers already land in the review record; summoning here as well
would spend two agents to say one thing twice. Where it is set, `summon()` runs
with `{handle, owner:false}` — so a guest is governed by `grants.json` exactly
as they are in the reading room, and a refusal comes back in `refusals` for the
mirror to relay.

##### The identity, which is the whole difficulty

A page's identity here is `sha1(normUrl(url))`, and the projection has to
choose the SAME url the owner's extension chooses, or unification produces two
records instead of one and is worse than the silo it replaced.

It uses **the address the visitor had in their address bar**: the origin the
mirroring request arrived on (`Host` + `X-Forwarded-Proto`) plus `/<section>.html`,
which is exactly how the review server serves its pages. No synthetic scheme,
no build change, no new question for content.js to ask — the owner reading that
page with the extension files it under precisely that string.

**The honest limit:** a paper reachable at two addresses (localhost and the
hub's hostname) is two records, one per address, exactly as any other page
served twice is. `discuss.base` in `review.config.json` pins one address when
that matters. This is the same problem `ident_href` solves for a council
artifact reached through the council's web UI, and the same answer would work
here; it is not built, because in practice the owner and the guests of a hosted
paper are both on the hub's hostname, and pinning is one config line.

##### Coming back

The other direction is a **poll, not a push**, and it lives entirely in the
review server: every five seconds, only while somebody has the page open, it
reads each mirrored page's record and folds every message that did not come
from there into `mergedData().threads` under the comment's own id — the exact
shape `state/threads.json` already uses, so the margin renders a Discuss answer
with **no new rendering code at all**. A mirrored message carries `origin`,
which is what stops the round trip echoing forever.

`/data` is answered from that cache synchronously: a request that waited on
another server's http would make the margin as slow as the slowest hop.

##### The silo keeps working

`review.config.json` grows one optional block:

```json
"discuss": { "companion": "http://127.0.0.1:4189" }
```

and **without it nothing runs** — not a fetch, not a timer, not a branch, not a
state file. A clone with no companion, a collaborator's checkout, a static
`site/` opened over `file://`, every paper that exists today: all keep exactly
the commenting they have. Unification is what happens when there is a companion
to unify with, and never a dependency on one. The companion is equally
unbothered: `/review-comments` is a route nobody calls.

#### Half two: commenter filter pills

Once a margin holds the owner, several guests, the bots AND the visitors
projected in from the review page, "what did mira say" is a question the drawer
made you answer by scrolling. So the Comments pane grows **one pill per
commenter present on the page**, `All` first, and pressing one shows that
person's threads.

**Derived, never maintained.** The roster is recomputed from the record on
every render — every author of every non-`tools` message — so somebody who has
not spoken here has no pill and somebody who just did gets one without any list
to keep. A bot is a commenter like anybody else. Fewer than two voices is not a
choice and draws no row, the same rule the archive's kind chips have always
followed.

**A pill wears the speaker's own colour** — `speakerColor`, the same hash that
paints that person's messages and that card's rail — so a pill and the comments
it finds are visibly one person. Deliberately **not** `tagHue`: that is the TAG
hash, and painting one handle two colours on one screen is the exact bug
`tagHue`'s byte-identical duplication exists to prevent.

**Whole cards, never slices.** A thread is a person's if they said ANYTHING in
it, so a thread the owner opened and mira replied in is in both their pills. A
filter hides whole thread cards; half a conversation is not a conversation. The
count on a pill is therefore a **thread** count — what pressing it will show.

**It composes rather than fights.** The filter is applied ONCE, before the
three buckets are cut, so the open list, **Ready for review** and the
**Resolved** archive are all the same person's, their counts are counts under
this filter, and every fold state carries on untouched. Filtering inside the
buckets instead would have been three places to keep in step and a section
header that lied.

**The tab badge does not move.** It counts every unresolved thread on the page,
filter or no filter: it is a workload number, not a view number, and a reader
who has narrowed the list to one person has not finished the others.

**A highlight click always wins.** `reveal(id)` already does whatever it takes
to make a thread visible — opens the archive, unfolds the card, switches tabs —
and a commenter filter hiding it is one more thing in the way, so it stands
aside. A click on the page can never be swallowed by a filter.

**View state, per tab, never persisted.** `D.commenter` lives beside the fold
states and follows their rule: a reading position, not a decision. `setPage`
clears it, because a handle in this page's margin is usually nowhere near the
next one and a filter that survived the navigation would show an empty pane on
a page that person has never been near. Nothing is written to
`chrome.storage.local` and nothing is sent anywhere.

**A filter that matches nothing says so** — *"Nothing from `<name>` here"* with
**show everyone** — rather than "No comments yet" under a rail full of names,
which would be a plain lie.

##### In the reading room

The same thing, as the only thing a scriptless view can be: a rail of LINKS,
`?by=<handle>`, exactly as the archive filters by kind and tag. A margin
narrowed to one commenter is therefore something a reader can send somebody.
An unknown handle filters to nothing and offers the way back, rather than
quietly showing everyone — a link that shows the whole page when it promised
one person is the more confusing of the two failures.

Deliberately **uncoloured**, unlike the drawer's pills: nothing in that view is
coloured by author, and inventing a second per-name hash for one rail would
paint the same handle two different colours across the two surfaces.

#### Testing

`companion.test.mjs` drives the door: a visitor's comment landing as a thread
under their name, quote, prefix/suffix and original timestamp; the same comment
mirrored twice being one thread; a reply landing once; a quote-less comment
going to page chat and not becoming an orphan; filing travelling one way and a
reopen surviving the next mirror pass; `summon` off by default and a mention
being what summons when it is on; a mirrored thread being an ordinary thread
everywhere else (a reply written here carries no `origin`, which is how the
read-back knows to send it over); malformed comments being skipped rather than
half-filed; and the door refusing a signed-in guest, a bearer token and the
tunnel alike while answering the loopback. It also covers the reading room's
`?by=` rail, its `on` state and its empty state.

`tests/review-engine.test.mjs` drives the review half against a fake companion:
the projection reaching it with the right url, authorship and shape; the
accepted-card decisions NOT travelling (they are not comments); an unchanged
page not being re-posted on every keystroke; a companion answer arriving in
`/data` under the comment's own id and the visitor's own words not coming home
again; **and a paper with no `discuss` block making no calls, growing no state
file and answering `/data` with its own `threads.json` exactly as before.**
`collect` / `sectionUrl` / `baseOf` / `repliesFrom` / `mergeThreads` are pure
and unit-tested beside it.

Harness `?commenters=1` is the page five voices have written on — the owner's
threads, two projected in from a review margin, a guest replying in somebody
else's thread, one of hers filed. `&selftest=1` asserts the row is drawn, All
comes first, every voice has a pill, the pills carry the speaker's colour, a
count is a thread count, pressing one narrows the pane, the tab badge does not
move, the archive and Ready for review are filtered by the same rule, a thread
somebody only replied in is kept whole, pressing the pill you are on clears the
filter, a filter matching nothing says so and offers the way back, a hidden
thread's highlight stands the filter aside, nothing is persisted, and a new
page opens showing everyone. `?commenters=1&by=mira` is the screenshot pose.

(The harness's own status bar is now PINNED to the bottom of the viewport while
a selftest runs, and the first ✗ is printed at the FRONT of the tally. The
article scrolls itself to a highlight on mount, which used to carry a sticky
top bar out of frame and leave the tally — the only thing a selftest produces —
unreadable in the one screenshot meant to carry it.)

## Amendment (2026-08-25) — the host is the page's to delete, so mounting is not once

`<div id="bfp-root">` is a child of the PAGE's `<html>`, which means the page
can take it away, and a site that renders its whole document from a framework
does exactly that: **React hydrating `<html>` removes every child of it that
React did not put there** — the drawer host included, roughly half a second
after the content script appends it. Medium is the case in hand.

Nothing throws when that happens. `D.mounted` is still true, `D.host` and
`D.shadow` are still live, every method still runs — into a subtree that is no
longer in the document. The user-visible result is the whole extension
apparently dead on that page: no pill on a selection, no panel behind the
toolbar icon, for the life of the tab, with a clean console.

So the contract is now:

- `mount()` means **attached**, not *ever attached*. `if (D.mounted) return` is
  narrowed to `if (D.mounted && D.host.isConnected) return`, and a host that was
  evicted is re-appended. Every UI entry point already funnels through `mount()`
  (`open()`, `showSel()`), which is what makes the reader's next gesture repair
  it.
- A drawer already ON SCREEN has no next gesture to wait for, so eviction is
  also **observed**: a `MutationObserver` on `documentElement`'s children
  re-appends the host when it is removed (bounded to 20 repairs, so a page that
  genuinely insists on removing the element wins rather than spinning against
  us; re-armed if `<html>` itself is replaced).
- The **same host** goes back, never a rebuilt one: the shadow root, its
  listeners and the conversation in it are untouched. Re-mounting would discard
  all three.

**Testing.** Harness `?hydrate=1&selftest=1` (11 assertions) does hydration's
one relevant act — `documentElement.removeChild(host)` — three times over: with
the drawer open (it comes back on its own, same host, same threads, still
open), before a selection (the pill appears *and has layout geometry*, which is
what a detached tree cannot fake), and before a toolbar-icon open. Without the
fix it scores 7/11; the four failures are precisely the reported symptoms. Note
which assertion still PASSES unfixed: "a selection gets its pill" — the class
toggles happily on a detached node. That is why every suite was green while the
extension was dead on the page.

## Amendment (2026-08-25, shipped): the PDF's own margin, both directions

A manuscript that has been round a supervisor, a co-author and a copy editor
comes back with the comments already IN it: Acrobat highlights, Preview sticky
notes, an author, a date and a paragraph of popup text each. Discuss rendered
that file beautifully and then printed **"No comments yet"** beside it — a
statement that was false about the document on screen, and the reason the
reader had two margins for one paper.

So the comments cross, both ways:

```
the file's annotations ──POST /pdf-annotations──▶  companion   offered once,
   (read in the VIEWER)                                        filed by origin

Discuss threads ──written in the VIEWER, downloaded──▶  a COPY of the PDF
   (bots included)                                      standard annotations
```

### Half one: import

**Who reads the file.** `pdf/viewer.js`, and only it. The parsed document
(`page.getAnnotations()`) and the text layer are both in that tab, and "which
words are under this quad" is a question only the two of them together can
answer. The companion never sees the file — the local-PDF amendment's promise
that the bytes are *never uploaded, copied or stored* is kept exactly as
written. What crosses the wire is a comment: an id, a page, an author, a
timestamp, a quote and its prefix/suffix. The rectangles stay behind; they are
how this side FOUND the comment, and mean nothing to a thread.

**What counts as a comment.** The four text markups (Highlight, Underline,
StrikeOut, Squiggly) and a text note (Text/FreeText) — WITH contents. A markup
with nothing said in it is a reader's own yellow marker, not a remark to
anybody, and is left alone. A `Popup` is the window of a comment and never a
second copy of it; a `Link` is not a comment at all. Acrobat's reply chains
(`/IRT`) fold into the comment they answer, so one conversation is one thread.

**Quote, prefix, suffix — the same three fields a selection captures**, so an
imported thread anchors, re-anchors and orphans exactly as a hand-made one
does. They are computed in PDF USER SPACE: every text-layer span's client
rectangle is converted through `viewport.convertToPdfPoint` into the space the
QuadPoints are written in, and a span counts as under the mark when a third of
it is covered (any touch would swallow the line above, since a highlight
overshoots; most-of-it would drop the clipped first and last words). A sticky
note has no quads and is pinned at a point: it takes the line it points at —
the nearest span, with the one in its own vertical band winning a tie — and a
note with nothing within 400pt of it (a note on a blank page) gets **no quote
and becomes page chat**, exactly as a review page's block-level comment does.

**The origin scheme, which is the whole of idempotence.** Every comment is
filed under `origin: {system:'pdf-annot', id}` — the store's existing marker
(2026-08-25, the unified comment store), one more entry in `ORIGIN_SYSTEMS`,
and nothing else in the record, the drawer, the digest or the export needs to
know it exists.

The id is a **16-hex hash of what the comment IS**: its page, its rectangle
rounded to a tenth of a point, its author and its words whitespace-folded
(`annotKey`, `pdf/annots.js` — FNV-1a over two lanes, pure, synchronous, the
same answer in node and in the page). Deliberately NOT the annotation's object
number (`489R`): that is the file's address for it, and Acrobat renumbers every
object on every save — an id that moved when the reader pressed ⌘S would
re-offer the entire document as new, which is the exact bug the marker exists
to prevent.

Two consequences, both chosen:

- **Re-opening offers nothing.** However many times the paper is saved,
  renamed, synced to another Mac or re-downloaded, the ids are the same and
  the companion already has them. Nothing is remembered anywhere about having
  offered before — the answer is recomputed from the record every load, which
  is what takes the card down the moment the last one lands.
- **An annotation EDITED in Acrobat comes back as a NEW comment.** Its words
  changed, so its id changed. The thread already here is left exactly as it
  is, because by now it may hold a bot's answer and the reader's reply, and
  neither of those belongs to the sentence that was edited. Nothing is ever
  deleted, rewritten or merged — the same rule the review mirror follows, for
  the same reason.

**Offered, never automatic.** A card at the top of the Comments pane —
*"This PDF carries N comments"*, **import N comments** / **not now** — and
nothing happens until it is pressed. Filing somebody else's words, under
somebody else's name, into the reader's own record is not a decision the
extension gets to make. The card draws only for the OWNER (the endpoint refuses
everybody else, and a button that produces a 403 is worse than no button), only
while something is genuinely un-imported, and never again in that tab once it
has been answered either way. Only the PENDING comments cross the wire: the
companion would skip the rest anyway, but a re-import of a sixty-comment
manuscript should not be sixty comments sent to be thrown away.

**The door: `POST /pdf-annotations`.** Owner-only, for the same reason
`/review-comments` is loopback-only — **it names its own authors**. "adril" is
a `/T` field in somebody's file, not anybody who signed in, and minting
comments under other people's names is precisely the power a guest must never
hold.

```
{ url, title?, site?, kind?, file_name?,
  annots: [ { id, page, author, ts, text, quote, prefix, suffix, kind?,
              replies: [{id, author, ts, text}] } ] }
→ { url, threads: {<id>: <thread_id|"__page__">}, created, appended, skipped }
```

**Nothing summons a bot.** An imported comment is somebody else's remark, and
an `@claude` inside a supervisor's annotation was addressed to a person, not to
this companion. The thread is ordinary in every other way, so the reader can
reply into it with a mention and get an answer — which is the reader deciding
which of the sixty is worth an agent, one at a time.

### Half two: export — the discussion, written back into the file

The person who most needs to read a Discuss thread is often the one who does
not have Discuss. So a PDF page's threads (bot replies included) can be written
into a **copy** of the file as standard Highlight annotations with the whole
conversation in the popup, downloaded through the browser.

**Where the bytes go: nowhere.** This was the one real design decision, and it
went against the codebase's usual grain (the companion writes files; the
extension cannot). Writing in the companion would have meant uploading the
manuscript — 7 MB for the paper in hand, against the snapshot pipeline's 2 MB
cap — to a process that has never seen it and whose whole contract about local
PDFs is that it never will. And the geometry is not there either: a thread is a
QUOTE, and the only thing on this machine that knows where those words are in
PDF coordinates is the text layer in the viewer's tab. So **the viewer writes
it, in memory, and hands the result to the reader**. Nothing is written beside
the original, no path is guessed, and the original is never touched. It is
named `<name> (discussed).pdf` — an export must not be able to overwrite the
file it was made from.

**Where it lands: the reader says** (amended 2026-08-25). It used to go
straight to the browser's own downloader — a blob and an `<a download>` from an
extension page — which meant a click produced a file in a folder the reader had
not chosen, with nothing on screen to say so. Now `showSaveFilePicker` puts a
real Save dialog up. That API has one hard rule: it must be called while the
click that asked for it is still live, and writing the file (half a megabyte of
`pdf-lib`, a re-read of the original) takes longer than that activation lasts —
so **the dialog comes first and the bytes are written into the handle
afterwards**. Its three answers are three different things: a handle (write
there and nowhere else), an `AbortError` (the reader said no — nothing written,
and emphatically no download behind their back), or anything else (no dialog
could be shown at all: fall back to the downloader, which is what this always
did). Which of the two happened is reported: "Saved …" or "Downloaded …".

**And it says so out loud.** Every word the export used to say landed in the
footbar — a 12px muted line at the far bottom of a panel whose top is where the
reader just clicked — so a save that worked, a save that failed and a click
that did nothing at all looked identical. The export now reports in the
comments pane, in the same card as the import offer above it (`.pdfsaved`):
while it is writing, then where it landed and how much of the margin went with
it, or, in the bad colour, why it did not. Good news clears itself after 12s; a
failure stays until it is dismissed. A second press while a write is in flight
starts nothing second — one Save dialog at a time.

**Where the bytes come from: the file, again, every time** (amended
2026-08-25). The export used to reuse the copy of a local PDF that was read at
boot, and it could not: `getDocument({data})` posts that buffer to the PDF.js
worker **as a transferable** (`sendWithPromise("GetDocRequest", …, [r.buffer])`
in the vendored build), which detaches it here. Building a second `Uint8Array`
over it throws *"Cannot perform Construct on a detached ArrayBuffer"* — which
is how this died on every local PDF, and only on local ones, because a web PDF
is given to PDF.js as a url and never as bytes. So `run()` now **drops the
reference in the same breath as the hand-over**, and `sourceBytes()` reads the
document again — XHR for a `file:`, `fetch` for the web. Re-reading also means
writing over the file as it is now rather than as it was an hour ago, and it
costs nothing until somebody actually exports; keeping a private copy alive
instead would double the memory of every local PDF for a button most readers
never press.

**Where the ink goes.** From the PAINTED HIGHLIGHT, not from a fresh text hunt:
`anchor.js` has already decided where a thread is (including after a re-anchor,
including after a bot rewrote the passage), so the ink in the file lands exactly
where the ink on screen is. Each mark's client rectangles are converted back
through the same `convertToPdfPoint` the import uses, one quad per line, grouped
by page — a quote across a page break is two annotations, because an annotation
belongs to one page. A thread whose highlight is ORPHANED has no marks and is
reported as skipped rather than guessed at.

**One annotation per thread, not a reply chain.** Acrobat models a conversation
as a parent plus `/IRT` children, and macOS Preview, Skim and every in-browser
viewer ignore that completely — they show the parent's `/Contents` and nothing
else. The entire point of the export is the person who does not have Discuss,
so the format is the one every viewer renders: **one popup with the whole
conversation in it**, each entry named and dated, the quote at the top, the
bots' tool-narration left out. Everything written is written in the live yellow
(a strikeout in red, below); two kinds of thread are not written at all —
a thread that came out of THIS FILE and has not been added to since, because
putting the supervisor's own comment back beside itself is not an export, and a
**RESOLVED** thread, because a settled argument is not the reader's to re-open.
See the 2026-08-27 amendment for the second of those.

**Appearance streams are not optional.** A Highlight with no `/AP` is drawn by
pdf.js and by Preview, and by Acrobat only sometimes — a viewer is entitled to
render nothing for an annotation that does not say how it looks. So every
annotation carries the appearance Acrobat itself writes: a Form XObject in a
`/Transparency` group, `/BM /Multiply`, one filled box per quad. That blend is
also the difference between ink over the glyphs and a block covering them. It
is verified by rendering the written file through **macOS PDFKit** (Quick Look,
which is Preview's own engine): the highlight paints and the words read through
it.

**The writer** is pdf-lib 1.17.1, MIT, vendored at
`extension/vendor/pdf-lib/` the way pdf.js is — pinned, offline, with a VERSION
file carrying the source url, the sha256 and the upgrade steps. The UMD build
deliberately: one file serves both the viewer (a classic script, `window.PDFLib`)
and the node test (`createRequire`), and it is injected ON DEMAND, the first
time somebody exports — half a megabyte is not worth spending on every PDF that
is merely read. Checked for `eval`/`new Function` before vendoring; there are
none, and the extension page's CSP would refuse them.

### THE INVARIANT, stated once and pinned twice

A local PDF is identified by the SHA-256 of its extracted, normalized TEXT
(`bfp-pdf://text/…`). **Annotations are not text.** Writing them changes every
byte of the file and not one word of the extract, so:

> the annotated copy is THE SAME PAGE — same identity, same page key, same
> chat, same highlights — and re-opening it shows the discussion it was
> written from.

That is not a happy accident; it is why the text identity exists (the byte-hash
identity it replaced was re-keyed by exactly this act). It is pinned at both
levels: `pdf-annot.test.mjs` asserts that writing does not touch a single text
operator on any page, and `pdf-render.test.mjs` asserts in a real browser that
the annotated fixture and the plain one normalize to the same string — with the
plain fixture's own words checked, so it cannot be two empty strings agreeing.
Verified once by hand at full scale as well: the reader's own 18-page, 7 MB
manuscript, annotated by this writer, comes back as
`bfp-pdf://text/abde28e2…` both before and after.

### Files

```
extension/pdf/annots.js         NEW — dates, the origin key, the geometry, the
                                popup's text, and the writer (handed pdf-lib
                                rather than importing it, so node tests it)
extension/pdf/viewer.js         reads the file's annotations after the text
                                layers land; writes the discussion back
extension/content.js            pending = the file's ids minus the record's;
                                the import POST and the export call
extension/drawer.js             the offer card, and the chooser's third row
extension/drawer.css            .pdfimport
extension/vendor/pdf-lib/       vendored writer + LICENSE + VERSION
store.mjs                       ORIGIN_SYSTEMS gains 'pdf-annot'
server.mjs                      POST /pdf-annotations (owner-only)
```

### Testing

`test/pdf-annot.test.mjs` (81) — the dates in every spelling a producer uses,
which annotations are comments, the origin key's two properties (stable across
a re-save, different after an edit), reply folding, the geometry, the popup's
text, and then the writer FOR REAL against the two-page fixture: the
dictionaries read back, UTF-16 contents, the appearance stream's shape, a
thread that could not be placed reported rather than invented, and the
invariant.

`test/pdf-render.test.mjs` (31 → 61) — a fixture annotated at startup (built
in code, so what the import is tested against is a file this repo can account
for), rendered by REAL PDF.js in a real Chromium: three annotations arrive as
two comments, in their authors' names and at their own moments, quoting the
words their quads actually cover; the identity is unchanged; the round trip —
import the comment, make the thread, paint it, ask the export what it would
write — lands its quads back on the passage the original mark covered; and
then the writer runs IN THE PAGE (the vendored UMD build loaded as a classic
script) and what it wrote is re-parsed in the same tab by the vendored pdf.js:
the supervisor's comments still there, the discussion beside them, and every
word of the document identical.

`test/companion.test.mjs` (186 → 195) — the door: an Acrobat highlight becoming
a thread under its author's name and page, re-import creating nothing, a reply
chain landing once, an edited annotation being a new comment beside the old
thread, a quote-less note going to page chat, an imported thread being ordinary
everywhere else, nothing summoning a bot, malformed annotations skipped rather
than half-filed, and the door refused to a signed-in guest, a bearer token and
an unauthenticated caller alike.

Harness `?pdfannot=1&selftest=1` (20) — the offer, driven at the seam
`pdf/viewer.js` uses (`window.__bfp.pdfAnnots`), with no PDF at all: the count
is the pending one, only the pending comments cross the wire, they land as
ordinary cards in their authors' names, the card goes when there is nothing
left to offer, re-opening the file offers nothing and posts nothing, an edited
annotation comes back as one, "not now" holds for the tab, and nothing is
persisted. `?pdfannot=export&selftest=1` (25) adds the other direction over a
stubbed viewer — the chooser's third row beside the two Obsidian modes, one
call through, and the footer naming the file and what could not be written.
`?pdfannot=1` is the screenshot pose.

## Amendment (2026-08-25, shipped): the other mark — a strikeout, Adobe's way

A reader of papers does not only point at sentences. Half of what they do to a
manuscript is say **this should come out**, and Acrobat has had the tool for
that in its toolbar for twenty years, right beside the highlighter. Discuss had
one tool, so every remark — "look at this", "check this number", "delete this
paragraph" — arrived as the same yellow wash, and the document itself never
said which was which.

So a PDF's selection pill gains Adobe's second tool.

### 1. What a mark is, and what it is not

A thread now carries a **`mark`**: `highlight` (the default) or `strike`. It is
not a fourth state and must never be read as one. The three background tints
already mean three states of a THREAD — yellow open, amber ready, sage filed,
read down a page as a progress bar — and `mark` is orthogonal to all three: it
says what was DONE to the passage, not how far along the conversation is. A
struck thread goes yellow → amber → sage exactly as a highlighted one does; what
changes is that its state is carried by the colour of the LINE rather than by a
wash.

**Absent means highlight.** Nothing is written for the ordinary case
(`store.addThread` writes the field only when it is `strike`), so every thread
made before this existed — and every thread on an ordinary article — is
untouched on disk and reads back exactly as it always did. `store.markOf` is the
only thing that should ever ask, and it answers `'highlight'` for a record with
no opinion.

### 2. PDFS ONLY, and that is a decision

The paint machinery would have generalised to articles nearly for free — it is
the same `anchor.js` `<mark>` on both. It was still not done, and the reason is
not cost:

> A strikeout is a **suggested edit to a document under revision**. A PDF is
> what gets marked up — it is a draft, it has an author waiting, and the file
> can carry the strikeout back OUT as a standard annotation that author will
> see. A news article on the web is not a draft, nobody is going to accept the
> deletion, and there is nowhere for the mark to go. A second tool on that pill
> would be a gesture with no destination.

The gate is a capability, not a url test: the PDF adapter alone declares
`capabilities.strike`, `drawer.js` draws the second button only where it is set,
and `content.js` refuses a `strike` selection where it is not. An article's pill
is byte-for-byte the single "💬 comment" button it has always been.

### 3. The pill grows a second tool

```
article        [ 💬 comment ]              ← unchanged, and its DOM is unchanged
PDF            [  ▤  |  ▤̶  ]              ← two icon segments in one pill
```

`.selbtn` stays what it was — the first button, the comment one, so every
existing test that reaches for `.selbtn` still gets the tool it meant. What is
new is the `.selpill` around it: the border, the radius and the shadow moved out
to the container so two buttons read as **one** control with a hairline between
them rather than as two pills sitting next to each other. The `on` class goes on
the pill and on each tool inside it, so nothing that ever asked the BUTTON
whether the pill was up gets a new answer.

The icons are the sign each tool is already known by (amended 2026-08-25): the
speech bubble the article pill has always shown, drawn as a stroke rather than
set as the 💬 emoji so it takes the pill's colour and matches its twin's
weight; and the strikethrough button out of every editor there has ever been,
an **S** with the red rule drawn through it. The S is a path, not a `<text>`
element — at 16px a glyph is at the mercy of whatever font the host page hands
us. Neither sign is lettered and neither carries a caption; the red rule is the
only colour in the pill, which is what tells the pair apart at a glance.
(They were, until this amendment, three strokes of text on a marker's amber
band and the same strokes with a red rule through them — a pair that read as
"highlight" and "highlight, struck" rather than as "comment" and "strike".)
The click reports which tool by the button's own `data-mark`, through the
existing `onSelect` callback (`onSelect(kind)`); nothing else about the
selection path changed.

### 4. A LINE, NOT A WASH — and how it avoids the strike already on the page

The reader asked for "the same nice strikethrough we see in Adobe", which is a
thin rule through the middle of the words and emphatically **not** a coloured
block over them. So a struck mark has `background-color: transparent` and draws
its line as a **background gradient** — a 2px band at 55% of the mark's box,
which is the middle of the x-height for the fonts a paper is set in and is the
same 55% at every zoom. The words underneath stay black on white, undimmed.

Why a gradient and not `text-decoration: line-through`? Two reasons, both about
not colliding with something that already exists:

| | |
| --- | --- |
| the ins-underline | Track changes marks an ARRIVED wording with `text-decoration: underline` in the accepted green. One element has one `text-decoration-color`. A struck passage that a bot then rewrote would have had to choose between the two lines, or draw both in one colour. A background is mechanically independent of a decoration, so the two markings can sit on the same mark and neither knows about the other. |
| the font's own metric | A decoration lands on the font's strikeout position, which in a PDF text layer — spans whose font-size is a scaled glyph height — wanders. A percentage of the box does not. |

And it is not the track-changes `<del>` (`bfp-was`) either, which is the OTHER
struck thing a reader may be looking at. They are told apart on four axes at
once, and `?pdf=1&strike=1` puts both on the same LINE of page 2 so the
difference is a thing you can see rather than a claim in a comment:

| | strikeout (`mark.bfp-hl.bfp-strike`) | the replaced wording (`del.bfp-was`) |
| --- | --- | --- |
| element | a `<mark>`, painted by `paintOffsets` | a `<del>`, painted by `paintWas` |
| from | the thread's `mark` field | the thread's `prior_quote` |
| ink | 2px saturated line, no wash | a hairline in the page's own text colour |
| the words | full opacity — they are still the document | dimmed to .55 over a pale red wash — they are NOT part of the page |

The line carries the thread's state, because the wash it replaced used to: open
is Acrobat's own red (a thin YELLOW line on white paper is not a line, it is a
rumour), ready keeps the amber, filed keeps the sage. Focus, which a strike
cannot say with a darker wash because it has no wash, thickens the line to 3px
and brings up a 12% tint of its own colour. Hover and click are identical to a
highlight's — to the reader it is one kind of thing, a mark on a passage, and
the click handler was already `mark.bfp-hl`.

### 5. The note is optional, and the quote is the suggestion

Adobe's strikeout with no popup means "delete this", and requiring a sentence to
say so again would make the quicker of the two tools the slower one. So
`POST /thread` waives its empty-comment refusal **for a strike and only for a
strike** — an empty highlight still says nothing and is still a 400. The
composer opens as it does for a highlight, with a placeholder that invites
rather than demands and a hint saying what an empty Send will do.

A thread whose first message has no words renders as the quiet line it is —
*"the passage was struck through, with no note"* — in the drawer, and as
`(no note)` in the PDF popup, rather than as an author's name over a blank,
which reads as a comment that failed to save. The card badges the mark either
way: **struck** when something was said, **suggested deletion** when nothing was.

Striking a passage that was already highlighted is a second, different comment:
the mark is part of the dedupe key, because it is part of what the act WAS.

### 6. Both directions through the file

**Import.** The four text markups already crossed as threads; now
`StrikeOut` and `Squiggly` cross as `mark: 'strike'` (a squiggly is a wavy line
through the words and means the same thing to whoever drew it), and
`Highlight`/`Underline` stay highlights and carry no field at all. The rule has
two copies — `Ann.markForKind` in the page, `store.markForAnnotKind` in the
companion — and `pdf-annot.test.mjs` asserts the two agree for every subtype,
the pattern `tags.test.mjs` set.

**Export.** A struck thread is written into the annotated copy as a real
`/StrikeOut` in Acrobat's red, not a Highlight with a note saying "delete this":
the whole point of the export is the person who does not have Discuss, and
red-line-through-the-words is the one mark every reader of PDFs already knows.
Same quads, same popup, same everything else. Its appearance stream is the same
one-box-per-quad Form XObject a highlight gets, with two differences that are
the difference between a line and a block: each box is flattened to ~1.1pt and
lifted to 42% of the quad's height, and the blend is **Normal** rather than
Multiply — multiply is what makes a highlight read as ink over glyphs, and a
line through them is meant to be opaque. A FILED strikeout is not exported at
all — see the 2026-08-27 amendment; on the page it still keeps its sage.

### 7. Downstream

`mark` is inert data everywhere else, so nothing had to learn about it — but
three surfaces show it anyway, because what was done to a passage is part of
what the comment SAYS, and a year later the note is the only place either
survives:

- the **reading room** and the phone sheet quote a struck passage struck, with
  one line under it saying it is a suggested deletion;
- the **Obsidian note** wraps the quote in `~~`, which every markdown renderer
  draws as a line through the words, with `*suggested deletion*` inside the
  blockquote beside the page number. A note with nothing struck in it is
  byte-for-byte the note this always wrote.

The bots are NOT told which mark a thread carries (they are handed the quote and
the conversation, as before). A struck thread with no note therefore gives an
agent nothing to answer — which is correct, because nothing summons one: a
strikeout files a suggestion, it does not ask a question.

### Files

```
store.mjs                       THREAD_MARKS / cleanMark / markOf /
                                markForAnnotKind; addThread takes `mark`
server.mjs                      POST /thread takes `mark`, waives the empty
                                refusal for a strike, and dedupes on it;
                                POST /pdf-annotations maps the subtype
extension/adapters.js           the PDF adapter alone: capabilities.strike
extension/anchor.js             STRIKE_CLASS, the three line colours, the
                                gradient, paintOffsets' 6th argument
extension/content.js            the mark on the pending selection, on the
                                repaint, and on the POST
extension/drawer.js             the two-tool pill, the struck quote and its
                                badge, the optional note, the wordless message
extension/drawer.css            .selpill, --strike-line, .quote.struck
extension/pdf/annots.js         markForKind, strikeBar, the StrikeOut subtype
                                and its appearance
extension/pdf/viewer.js         a struck thread is written as a StrikeOut in red
views.mjs / reader.js           a struck quote in the reading room
export.mjs                      …and in the Obsidian note
```

### Testing

`pdf-annot.test.mjs` (81 → 111) — which subtypes are deletions and that the
companion agrees about every one of them, the bar's geometry (thin, never
thicker than the line it strikes, thinner still on 4pt type), and then the
writer FOR REAL against the fixture: a `/StrikeOut` dictionary with a
highlight's quads, Acrobat's red, a subject that says what it is, a `(no note)`
popup rather than a signed blank, an appearance stream that is one thin bar and
is NOT blended Multiply — and the default untouched, so an item that says
nothing about its subtype is still a Highlight. Plus the store's own half:
`cleanMark`, and an ordinary thread carrying no `mark` field at all.

`companion.test.mjs` (195 → 203) — the door: a StrikeOut and a Squiggly coming
in struck, a Highlight and an Underline coming in with no field, a thread struck
by hand, a strikeout filed with an empty message (still signed), the same POST
refused for a highlight, an unknown mark falling back rather than erroring, and
the dedupe: the same words twice is one comment, but striking them is not the
same act.

`export.test.mjs` (70 → 75) — a struck quote in the Obsidian note, with and
without a note under it, an ordinary highlight quoted exactly as it always was,
and a note with nothing struck in it byte-for-byte unchanged.

Harness `?pdf=1&strike=1&selftest=1` (39) — the pill has two tools and the first
is still the comment one; the strike tool opens the composer, paints the
provisional mark already struck, and Sends with an empty box; the passage is
painted on both typeset lines, inside the text layer, with NO background colour
and a gradient carrying the line; an ordinary highlight on the same document is
still the yellow wash it always was; and then the collision, on one line of page
2 — a `<del>` that is a different element, dimmed, washed, and struck by a
text-decoration rather than a background, beside a `<mark>` that is none of
those things. Then the filed strikeout's sage line, focus, the card's struck
quote and its two badges, the wordless message, and a click opening the thread.
`?pdf=1&strike=1` is the screenshot pose (scrolled to page 2);
`&strike=pill` puts the two-tool pill up over it.

Two notes for whoever runs the harness next. The tint a focus brings up is
asserted off the INLINE declaration, not `getComputedStyle`: the mark carries
`transition: background-color`, and under a headless render's virtual clock a
transition never advances, so the computed value is stuck at the colour it is
transitioning FROM. (`?hydrate=1&selftest=1` used to score 8–9/11 under `botference see` for the
same class of reason — its three `.panel.open` assertions read a class added in
a `requestAnimationFrame`. Fixed on 2026-08-26; see the harness amendment
below.)

## Amendment (2026-08-26, shipped): answers are typed, not dropped

A bridge hands the surface text in whatever chunks the tokenizer and the
network happened to produce — a sentence, then eleven characters, then nothing
for a second, then a paragraph. Painted the instant each lands, an answer
arrives in visible lurches, and the size of the lurch is an implementation
detail of somebody else's stack showing through.

So a live answer is now **drained** onto the screen rather than dropped onto
it. This is not artificial slowness and the distinction is the whole design:
the drain only ever reveals text that has ALREADY ARRIVED.

- Each live stream carries `text` (everything received) and `shown` (how much
  of it is on screen). A 16ms timer walks the second toward the first.
- The step is **a fraction of the backlog**, not a constant: `max(1,
  ceil(backlog / 8))` characters per tick. Two things fall out of that for
  free. A slow stream settles at a lag of about a dozen characters — the
  backlog can only grow until an eighth of it equals the arrival rate — which
  is what reads as typing. And a burst (a whole paragraph at once) drains in a
  few frames rather than being typed out at leisure.
- **A finished answer is never held hostage.** In the drawer, `stream-done`
  switches the step to `max(12, ceil(backlog / 3))`, so the tail of an answer
  lands in a few frames; the authoritative `reply` clears the live block
  regardless. In council web the authoritative `room` event paints the final
  text whole (`finalizeStream`), so the drain has nothing left to hold.
- The timer stops itself on the first tick with nothing behind, and is started
  by the next delta. Nothing ever holds it open.
- Markdown is unaffected. The drawer's live block is a `<pre>` of plain text
  (markdown arrives with the settled reply), and council web re-renders the
  whole revealed prefix through `renderMarkdown` on every tick exactly as it
  re-rendered the whole received text before — the pacing is applied to the
  TEXT, before the render, so a half-revealed `**bold` is never half-parsed
  into the DOM.

**The way back, per surface, in that surface's own idiom.**

- Drawer: a two-position switch in the gear popover, under the reply-length
  one it is modelled on — `typed · instant` — stored as `bfp:typing` in
  extension storage, the same one-key idiom as the tab, the width, the export
  mode and the pages filter. Note the state field is `D.typeMode`, not
  `D.typing`: the public surface is `Object.assign`'d onto `D` and carries a
  `typing()` reader that would otherwise eat the field.
- Council web: a `typed · instant` seg in the sidebar footer beside the theme
  control, stored as `council-typing` in `localStorage`, following the theme
  pattern exactly (`typingPref` / `setTyping` / `renderTyping`).
- Flipping the switch mid-answer never rewinds or freezes the text: instant
  jumps `shown` to the end, typed starts pacing from where the reader's eye
  already is.

**`prefers-reduced-motion: reduce` wins over both.** It is read live (not
cached — the setting can change under a running tab), forces the instant path,
and the switch says so: it shows `instant`, greys, and disables, while the
reader's own choice is remembered underneath for when the OS setting goes away.

**Not the reading room.** The phone/reading-room surface does not stream at
all — it renders the answer at turn-end — and is untouched.

### Testing

Harness `?selftest=1` (+11) — a 400-character burst is held back rather than
dumped, the block is on screen from the first frame with exactly `shown`
characters in it, the drain reaches all 400 in under three seconds and in
order, instant mode paints the whole chunk the moment it lands, and the gear's
switch has two positions, shows which is on, and moves the setting when
clicked.

`tests/council-web.test.mjs` (+3, and two existing tests taught to drain) — the
same burst claim with the drain STEPPED BY HAND (`C.typeDrain()`) rather than
waited on, so the assertion is about pacing and not about wall time, plus the
catch-up bound (under 60 ticks); instant mode and its remembered
`council-typing`; and a stubbed `matchMedia` proving reduced motion overrides
the reader's `type` setting and disables the switch. The two existing tests
that asserted stream text immediately after a single delta now step the drain
first — a delta puts text in hand, the drain puts it on screen.

## Amendment (2026-08-26, shipped): the reader struck it — say so, and do nothing

A thread whose anchor is a strikethrough (`thread.mark === 'strike'`, PDFs
only) is a **suggested deletion the reader has drawn on the document**. A bot
summoned into that thread was not told, and answered a question about a
sentence as though the sentence were uncontested.

It is told now, and told in the same register as the page number that already
rides a PDF thread ("This comment is on page N") — one line of standing
context between the passage and the reader's words:

> The reader has STRUCK this passage through — a suggested deletion marked on
> the document itself. This is background, not an instruction: answer what they
> actually ask, and do not carry out, argue for, or offer to make the deletion
> unless they ask.

The second sentence is load-bearing and is asserted verbatim. Without it a
helpful model proposes the deletion, or rewrites the passage, when all it was
asked was what the passage means — which is worse than not knowing, because it
spends the turn on something the reader did not request.

Plumbing: `server.mjs` puts `mark` on the job beside `pageNumber` (empty for
every ordinary highlight, so an article's turn is byte-for-byte the one it
always was); `chat.mjs` `planSteps` passes it to `envelope`, which composes the
`struck` line. Page chat sits on no thread and never carries it.

**Testing.** `companion.test.mjs` (+2): a struck thread's turn carries the
wording, all four clauses, beside an untouched page line; an ordinary highlight
on the same kind of document says nothing about strikes at all.

## Amendment (2026-08-26, shipped): the fonts are the drawer's to keep too

Follow-up to the hydration amendment above, which named it. The drawer owns
exactly **two** nodes outside its own shadow root: `#bfp-root`, and the KaTeX
`@font-face` `<link>` in the page's `<head>` (`@font-face` inside a shadow root
does not register, which is why it cannot live with the rest of the styling).
The same hydration that deletes the host deletes the link, and `ensureMathFonts`
only ever ran on activate — so on a hydrating page every formula in the drawer
silently fell back to the page's serif for the life of the tab. No error, no
missing element; just the wrong typeface.

The fix hangs on the repair path that already exists:

- `Drawer.create` takes `onAttach`, a hook the owner of those outside nodes
  registers; `content.js` passes `ensureMathFonts`, which is idempotent by id.
- `attach()` calls it — so every re-attach of the host brings the fonts back
  with it.
- The host observer calls it **before** its `isConnected` guard, because a page
  can take the link and leave the host standing.
- …and `<head>` gets an observer of its own, because removing a `<link>` from
  `<head>` is a mutation of HEAD's children, not of `<html>`'s, and the host
  observer never sees it. One observer, armed once, doing nothing but calling
  an idempotent repair.

**Testing.** `?hydrate=1&selftest=1` grows from 11 to 15. `evictDrawerHost()`
now takes both nodes (which is what hydration does), plus a new `evictMathFonts()`
for the head-only case; the pose asserts the link is there to begin with, comes
back with the host, and comes back on its own when only it is taken.

## Amendment (2026-08-26, shipped): a Send holds its thread

Reported from a long PDF and not about PDFs: pressing Send loses the reader the
card. It drops back into page order, stops looking current, and when the bot
answers they have to go back to the document and click the right highlight to
find their own conversation again.

A Send now takes a **hold** on that thread. The hold is not a new affordance —
it is the focus the drawer already has (the `focused` card, the pane's
`dim-others`) plus one promise: every render puts that card back where the
reader can see it. The bot's reply, and the typewriter draining it, therefore
happen in view.

- `doSend()` is the single choke point and takes the hold there (`holdOn`),
  which covers replies into a thread and new threads from the selection pill
  alike. Page chat and the library are excluded: they are single scrolling
  conversations that already follow their own tail, and there is no card to
  focus — pointing `focused` at one of them would dim every card and spotlight
  nothing.
- `holdInView()` runs at the END of `render()`, after the scrollTop restore it
  deliberately overrides — the pane being where it was is exactly what loses
  the card. A card that FITS lands at the top of the pane, the same landing
  `scrollToThread` gives a highlight click, so arriving by Send and arriving by
  click look like the same place. A card too tall to fit is shown by its TAIL,
  because on a long thread the words just written and the answer arriving under
  them are at the bottom and top-aligning would put both off screen.
- The typewriter drain patches the live `<pre>` without a render, so
  `paintStream` re-applies the hold too — otherwise the answer types its way
  off the bottom of the pane.
- A brand-new thread is held as `__new__` and **promoted**, not released, when
  the server mints its id. Two places do it, because content.js focuses the new
  id BEFORE the send's own success path runs: `focus()` promotes a `__new__`
  hold (guarded on a send actually being in flight, so clicking a different
  highlight mid-send still releases), and `deliver()` re-points it as well.

**"Until I do something else" is the whole release rule**, and it is why every
release hook hangs off a GESTURE rather than off a render or an event:

| releases | does not release |
| --- | --- |
| the reader scrolling the column (wheel, touch-drag, PageUp/Down/Home/End) | a `stream` delta, a whole answer, `turn-end` |
| focusing another thread — a card click, a highlight click | a re-render, a `page` event, the round ticker |
| changing tab, opening the pages library, closing the drawer | the typewriter drain |

A `scroll` listener cannot serve this: `holdInView` writes `scrollTop` itself
and so does every render, so the gestures are listened for instead. Arrow keys
inside a composer are exempt — an ArrowDown there is a caret move, not a
scroll, and must not release the thread being typed into.

**Testing.** New pose `?sendfocus=1&selftest=1` (13) on the plain article
fixture, because the mechanism is the drawer's and not the document's: the
reader is parked at the far end of the column and writes into the FIRST card;
the thread is held, on screen, focused, with the rest stood down; a 640-
character answer streams into it and neither the stream, the drain, nor
`turn-end` releases it, and it is still in view when the drain finishes; then
each gesture in turn releases it, with a fresh Send re-taking it between them.
Plus one assertion in `?selftest=1` (648 → 649) that a Send on a brand-new
thread is still holding it once the server has minted the id.

## Amendment (2026-08-26): the harness is a thing an agent can trust

Three poses were known-unreliable and SPEC-noted as such. All three were the
harness's own bugs, not the product's.

**`?hydrate=1&selftest=1` scored 8-9/11 under headless virtual time.** Its
three `.panel.open` assertions read a class that `open()` adds inside a
`requestAnimationFrame` — one frame, so the CSS transition runs on a first
open — and a headless run under `--virtual-time-budget` is not guaranteed to
service a frame at all. The assertions are about whether the drawer OPENED, not
about when a transition class landed, so they now wait for a frame if the
runner will give one (with a 60ms floor) and then read what `open()` does
SYNCHRONOUSLY: `isOpen()`, and the `margin-right` it pushes the page over by —
accepting the class when the frame did arrive. Same verdict in a real browser,
no coin toss headlessly.

**`?workspace=1&selftest=1` died on a null `.click()`.** Two real bugs, both
introduced by later work that nobody re-ran this pose against:

- `tcard()` selected `.pane[data-pane="chat"] .tasks` when there are now TWO
  tasks cards on that pane — the project's `TASKS.md` card pinned above the
  conversation, and the one derived from a message. The bare selector picked
  the project card, which has no `↑ source` button, and the pose died on the
  null. It is `.tasks:not(.ptasks)` now.
- "…at the very top of the pane" was asserting `firstElementChild`, which the
  claim never meant: the archive bar and the send-review row both sit above the
  card and are not the conversation. It asserts what it means — the card is
  above the conversation, and is the first tasks card in the pane.

**`?commenters=1&selftest=1` "never started" headlessly.** It always ran; it
published its result ONLY as `window.__selftest`, invisible to `--dump-dom` and
to any runner grepping `#h-log` for `SELFTEST`, so a clean pass and a run that
never began looked identical. It writes the same six-line tally as every other
pose now.

**A fourth, found by running the sweep properly.** `?roundticker=1&selftest=1`
passed alone and scored 2/8 in a sweep. The strip becomes VISIBLE before it is
necessarily FILLED — the round it describes arrives from the companion, and on
a loaded machine those are not the same frame — and the pose asserted the
text the instant the strip appeared. It waits for the condition it is asserting
now, which also settles the five later assertions and the null click that were
following it down.

**And the class of failure behind two of those.** A pose is a script of
gestures; a gesture aimed at a control that is not there is worth one failed
check. As a bare `x.click()` on null it was worth the whole run — the pose is
`async`, nothing catches, the TypeError becomes an unhandled rejection,
`fault()` paints `#h-log` red with it, the tally is never written, and every
later assertion is simply never made. `hitter(check)` turns that back into one
named failure with the rest of the pose still to run, and the fragile poses use
it at every click. (`until` answers null on timeout rather than throwing, which
is why every await-then-click site wants this shape.)

**Two more poses were answering the wrong questions**, found by running the
sweep with the right flags for the first time. `?roundticker=done` is a
DIFFERENT FIXTURE from `?roundticker=1` — the round has finished — and it fell
through to the in-flight pose's sixteen assertions about a round that is still
going (10/16, every failure "the fixture is not that one"). It has a pose of
its own now. And `?selftest=canon` needs `?canon=1` with it, or the splinter
url it is about is never set up; that one was the runner's mistake, and the
sweep list above carries the pair.

**`?pdf=scan` was not a selftest pose and did not degrade gracefully.** `PDFV`
is true for `scan`, so `?pdf=scan&selftest=1` ran `selftestPdf` — fifty
assertions about anchoring inside a text layer, against a document that has no
text layer at all. It scored 25/50 and every failure was the harness asking the
wrong document the wrong questions. It has a five-assertion pose of its own now
(identity, no text layer, the bots are sent nothing, the reader is told why,
nothing threw); the `?pdf=1` pose still covers a document that LOSES its text,
which is a different path from one that never had any.

**And the leak that made the sweep itself untrustworthy.** The harness's fake
extension storage is persisted to one `localStorage` key, which is per-ORIGIN
and therefore shared by every pose in a sweep: a run that ended on the Page
chat tab, or with the pages list filtered, silently handed that to the next
pose. Poses passed alone and failed in the sweep for reasons nothing in them
could see (`?roundticker=1` was the one that showed it). Under `selftest` the
store now starts empty, always. A human reloading a screenshot pose still gets
their tab and width back; a selftest is a fresh profile every time, which is
the only thing that makes a sweep mean anything.

**How to run the sweep.** `file://` does not work — the harness comes up inert,
`window.__bfp` never appears, and nothing is logged. Serve `frontends/plugin`
over http (docroot at `frontends/plugin`, NOT at `test/`, or `../extension/*`
is unreachable) and drive it with Playwright, waiting on `#h-log` matching
/SELFTEST/ and reading `dataset.detail`. Every selftest pose passes headless,
three runs in a row.

## Amendment (2026-08-26, shipped): a page filed in a council project

The reader is marking up the second draft of somebody's manuscript. Everything
that was said about the FIRST draft is in a council project, in chats this
companion can read and has never had any reason to open — because that PDF is a
different page record, keyed on different bytes, made on a different day. The
bots answering on draft two have no idea draft one was ever discussed, and the
reader is left retyping the last round's objections into the margin of this one.

A page can now be **filed** under one or more council projects. Filing is a
**READ, not custody**: the page keeps its own lane, its own bridge and its own
(absent) write scope; what changes is that every turn on it carries a digest of
what those projects already know.

#### 1. Filed is not the same as artifact, and the difference is the whole design

| | project **artifact** page | page **filed in** a project |
|---|---|---|
| where it lives | `projects/<id>/` — the path is its identity | anywhere; a PDF in Downloads |
| how many projects | exactly one, by where the file is | zero or more, by the reader's say-so |
| its lane | the project (`(root, id)` → one child) | its own (`pg:<url>`), unchanged |
| write scope | that project's folder | **none**, unchanged |
| how it got there | the file system | one click, reversible |

**THE LANE NEVER MOVES.** A filed page is not handed the project's bridge, and
this is not caution — it is forced. §5 of the parallel-turns amendment ("why a
lane never moves off a live child") says a lane binds on its first turn and is
released only when its child is gone, because two children driving one session
id is a silent whole-turn loss. A page may be filed under SEVERAL projects, so
there is no single lane to move it to even if moving were safe. Filing is
therefore a pure envelope change, and the same argument is what makes it
reversible: unfiling is `delete page.projects` and nothing else.

#### 2. The record (`store.projectsOf`, `store.filePageInProject`)

```json
"projects": [{ "root": "/abs/council", "id": "adriana-paper", "at": "2026-08-26T…" }]
```

A LIST, for the reason above. Written only when it is not the default, in this
contract's usual way (`mark`, `tags`, `page`): a page filed nowhere has no such
key and no record needs migrating. `ATTACH_MAX = 6`. Attaching twice keeps the
first attachment and its date; detaching something never attached answers with
the page rather than an error, so the drawer renders one result either way. The
index row carries `projects: ["<id>"]` on the same terms as `tags`.

#### 3. The digest, and its budget (`workspace.attachedContext`)

Per project, in this order: title and path, `TASKS.md`, the top-level file
names, the chat titles newest-first, then **the actual words** of the two most
recent chats — the tail of each, envelope-stripped, attributed. Titles alone
would say a conversation happened; the point is what was decided in it.

| bound | value | why |
|---|---|---|
| `DIGEST_PROJECTS` | 3 | filed under more? the three newest talk, and the block says how many did not |
| `DIGEST_CHATS` | 8 | titles listed per project |
| `DIGEST_TASKS` / `DIGEST_FILES` | 10 / 12 | |
| `DIGEST_TAIL_CHATS` / `DIGEST_TAIL_MSGS` | 2 / 6 | whose words are quoted, and how many |
| `DIGEST_MSG_CHARS` | 400 | per quoted message |
| `DIGEST_PROJECT_CHARS` | 3000 | per project |
| `DIGEST_TOTAL_CHARS` | 6000 | across all of them |

Two budgets rather than one, deliberately: filing a page under five projects
must not be able to push the PAGE out of the model's window. It rides on
**every** turn, beside the snapshot path and the write rule and for the same
reason — a resumed session's replayed history is uneven and a bridge restart
drops it whole, so the only thing a turn can rely on carrying is the turn. It
is cached against the newest session mtime in the project, so a turn that
changed nothing costs one index read.

An attachment whose root is no longer confirmed, or whose project has been
deleted, is **skipped in silence**: the record keeps it (the project may come
back) and the envelope simply does not claim to know something it cannot read.

#### 4. Two ways in, and only one of them files anything

**The picker.** A folder button in the header opens `.popover.projpick`, the
export chooser's twin — because it asks the same shape of question — with one
difference that matters: these rows are TOGGLES, so a filed project is ticked
and stays clickable to unfile. Each row carries a **peek**: the project's
recent chat titles and its top-level file names, so two similarly-named
projects can be told apart without opening either. Only projects of
**confirmed** council roots are listed, the same rule that decides whether an
artifact page gets a bridge at all. No confirmed roots → the popover says so
and says what to do about it, rather than being empty.

**The bot.** On a page filed NOWHERE, the first turn carries the roster —
project ids, titles and the portfolio's own one-liner, nothing else, because
this rides on pages that have nothing to do with the council — and this
instruction:

> If — and only if — this page clearly belongs with one of them, END your reply
> with a line of its own reading `file-in: <project-id> — <one short reason>`.
> The reader gets a button; you are not filing anything. Say nothing at all if
> none of them fit, and never guess.

`workspace.parseSuggestion` reads it back. **Only a line of its own** counts,
markdown around it is stripped, the LAST one wins, and the id must be one the
roster actually offered — a bot that invents a project name gets ignored rather
than producing a button that files a page nowhere. The line is lifted off the
reply into `msg.file_in` and **removed from the words**: it is machinery, not
prose. The drawer draws it as `.filechip`, the one-step inline confirm this
drawer uses everywhere (del-thread, page-del, send-review): the sentence is the
whole of the warning, "File it" and "No" are the whole of the act.

**BOTS NEVER FILE.** The suggestion is an offer with a button on it, and the
page is filed nowhere until the reader presses it. "No" is per tab and is not
remembered anywhere: saying no to a suggestion is not a fact about the page.
The roster and the digest are mutually exclusive, and neither ever appears on
a project artifact page — it is in a project already, by where it lives.

#### 5. HTTP API (owner-only, both)

| | |
|---|---|
| `GET /projects?url=` | `{projects: [{root, id, title, status, next_action, github, chats:[{title, updated_at}], files:[…]}], filed: [{root, id, at}]}` |
| `POST /page-projects {url, root, id, attach}` | `{url, filed}`; 400 unless the project exists in a **confirmed** council root |

Owner-only for the reason `/project-page` is: the answers name this reader's
projects and the absolute paths of their council, which is nobody's business
over a tunnel.

#### Testing

`test/filing.test.mjs` (20), in four parts: the roster and the record (a
declined root offers nothing; the peek is top level only; attaching is
idempotent in both directions and unfiling leaves no key on disk); the digest
(the past chats' actual words ride along; TASKS.md and the file list; the
DIGEST_PROJECTS cap says how many it dropped and drops the OLDEST; an
unconfirmed root and a deleted project both claim nothing); the suggestion
(the block forbids guessing; only a roster project is read; markdown does not
hide the line and the last one wins); and end to end against a real companion
with mock children — the filed page's envelope carries the past chat and does
NOT carry `[project artifact:` or a write rule, an unfiled page carries the
roster instead, never both, and a bot's suggestion becomes `msg.file_in` with
the line taken out of its text while `page.projects` stays absent.

`test/mock-bridge.mjs` grew `[mock:says:…]` (`\n` for newlines) for the tests
that care what a bot's WORDS are rather than that it answered.

Harness poses: `?filein=1` is the picker open on an ordinary page with one
project already ticked; `?filein=chip` is a bot's suggestion as a confirm chip.
Both screenshot states.

#### Known limits (deliberate)

- **A suggestion names a project id, not a root.** With two confirmed councils
  holding a project of the same id, the first in roster order wins. Nobody has
  two councils; when somebody does, the marker grows a root index.
- **The digest is not the project.** It is a tail, not an archive: a question
  about something said thirty chats ago will not be answered from it. The
  bots can read the council root, and the digest names the paths.

## Amendment (2026-08-26, shipped): the strikethrough a discussion arrives at

The reader opened an ordinary comment on "Long-term simulations" in a
manuscript, argued about it with the bots, and between them decided the passage
should come out. The thread stayed an amber highlight. There was no way to say
so: the two tools were a choice made at the moment of SELECTION and never again,
so the only route to the red line was to delete the thread and draw the
strikeout over the passage a second time — losing the conversation that reached
the decision.

Two doors close that gap, and the whole design is that **they are not the same
door**.

#### 1. `POST /mark` — the reader converts the thread in front of them

Owner-only, one field, both directions.

```
POST /mark { url, thread_id, mark: "strike" | "highlight" }  → { thread, changed }
```

`store.setThreadMark(thread, mark)` writes `mark: "strike"` or DELETES the key —
absent means highlight, as it always has, so a converted-and-reverted thread is
byte-for-byte the record it was and nothing on disk needs migrating.
**Retroactivity is therefore inherent**: a thread written before the mark
existed has no `mark` key, and converting it is the same one-key write
(`strike.test.mjs`, "RETROACTIVITY").

Nothing else on the record moves. `quote`, `prefix`, `suffix`, `page`,
`prior_quote` and the entire message chain are exactly what they were — which is
why the export still signs the annotation with whoever OPENED the thread, why
track changes and the collateral machinery carry straight over, and why no bot is
summoned by a conversion.

**Refusals** (`server.mjs strikeable`):

| | |
|---|---|
| not a PDF (`store.kindOf`) | 409 — a strikeout is an `/StrikeOut`, and only a PDF can carry one |
| the thread is FILED | 409 — the argument is over; reopen it first |
| unknown thread | 404 |
| a guest | 403, like `/reanchor` — a guest may hold an opinion about a thread, not draw on the owner's manuscript |
| the mark it already has | 200, `changed: false`, no write and no broadcast |

The server's answer about the document is its OWN (`store.kindOf`), never the
client's: the extension gates the affordance on the adapter's `strike`
capability, and a door must not take a client's word for what it may do.
**Undoing** is not gated on the document — a mark already on the record must
always be removable, whatever the page has since been decided to be.

**The affordance** is a struck `S` in the card head beside the ✓ and the ✕, on
hover like every other per-row control, hovering to the strike's own red rather
than the delete's. The REVERSE is deliberately quieter — a third of the opacity,
no red, and the glyph without its line: striking a passage is a statement about
the document, putting it back is a correction of a click. (The line through the
glyph is CSS; U+0336 does not render in the drawer's face.)

#### 2. `POST /strike-from` — a bot suggested it and the reader agreed

The suggestion is the `file-in:` idiom exactly (`workspace.mjs` SUGGEST_MARK):

- The turn carries an invitation, composed in `summon` and passed to
  `chat.envelope` as `strikeContext`, only when `strikeable(page, thread)` — so a
  model that is never shown it cannot learn the convention. It rides EVERY turn
  of the thread, not the first: a conclusion is reached on the fourth exchange.
- A bot may end a reply with a line of its own: `strike: <the note>` (**amended
  2026-08-27** — it was `<one short reason>`, which is what produced a note the
  document could not use; see the amendment below).
  `store.parseStrikeSuggestion` reads it back — a line of its own, the LAST one
  counts, a note is required (a bare `strike:` is a model echoing the
  convention, not concluding anything).
- `server.mjs` lifts the line OFF the reply's words into `msg.strike = { why }`
  and the drawer draws a chip: **Strike it / No**. Bots never mark anything up.
  (**Amended 2026-08-27**: a note that points back at the discussion, or one
  past `STRIKE_NOTE_MAX`, is lifted as `{ why, rejected }` and draws a chip with
  no button at all.)

**BOTH BOTS MAY SUGGEST, and the reader picks.** Asking claude, then asking
codex, and comparing the two answers is the ordinary way one of these threads
gets used — so the whole path is PER REPLY and there is no last-one-wins
anywhere in it. The lift is `msg.strike`, exactly as filing's is `msg.file_in`;
two suggestions in one conversation are two chips, each in its own bubble,
each carrying its own bot's wording; and confirming one mints the strike from
THAT reply's reason.

Which one was taken is on the record as `from_msg` (the reply's `ts`), because
"this thread produced a strike" is not a precise enough answer for the drawer.
The chosen chip becomes `Struck through, in your name. · view`; the siblings
**retire rather than vanish** — `Not chosen — <what it proposed>`, muted.
The reader chose between two proposals and is entitled to go on seeing what the
one they turned down said. (**Amended 2026-08-27**: a retired chip keeps ONE
control, `Use this note`, and confirming it rewrites the note on the strike that
already exists. "Nothing left to click" was right while a second click could
only have made a second red line, and wrong once the note it made could be the
wrong one.)

**And confirming does NOT convert the discussion.** It mints a SECOND thread:

```
POST /strike-from { url, thread_id, note }  → { thread, deduped? }
```

Same quote, same prefix/suffix, same page number, `mark: "strike"`, authored by
the OWNER with their own timestamp, carrying at most one short note — the reason
the suggestion gave, or nothing at all, and **not one word of the conversation**.

The reason is the whole feature. The reader's next act is to DELETE the
discussion, and what the co-author receives is then a red line with a human's
name on it and one sentence in the popup: no bot names, no reply chain, no
agentic chatter. Converting in place would have put the entire conversation into
that popup, because `Ann.threadContents` writes the whole thread into
`/Contents`.

The minted thread is therefore **wholly independent**. The only link is a soft
`from_thread: <id>` on the new record, which this drawer reads for a "view" link
and for the delete fall-through below. It may dangle, nothing looks it up
expecting to find anything, and **nothing in the exported annotation references
it** — `pdf/viewer.js collectItems` has never heard of the field.

Idempotent by the same argument as everything else here: same passage, same
hand, already struck → that IS this strike, handed back with `deduped: true`.
Two suggestions inside one thread are two opinions about the SAME passage and
can only ever produce one strikeout, while a suggestion about a genuinely
different passage is a different anchor and mints its own.

> **Amended 2026-08-27.** Two corrections to the paragraph above. The match is
> the LINK first (`from_thread`) and the quote only as a fallback — an anchor
> that has drifted must not be allowed to mint a second line. And a confirm
> carrying a DIFFERENT note no longer does nothing: it **rewrites the note on
> the strike that is there** and answers `updated: true`. `deduped: true` now
> means only what it should ever have meant — the same note, or no note, twice.
No bot is summoned. `index` puts it beside the discussion in the record; the
drawer then orders the column by document position, as it always has.

#### 3. Where the reader is left — the send-hold contract decides

Clicking "Strike it" is a deliberate gesture, so focus MAY move. It does not.
The reader is standing in the discussion, that is what they were reading, and
their next act is one of two things — keep talking, or delete this thread — and
both happen there. So:

- the discussion is **held** (`holdOn`): the spotlight it already had, plus the
  promise that every render keeps it in view;
- the new card simply appears in the column with a four-second arrival wash and
  a red rail (`.card.arrived`), because **arriving content never takes the
  scroll** — and a card the reader did not ask to be taken to is arriving
  content however deliberate the click that caused it;
- the chip settles into `Struck through, in your name. · view`, and "view" is a
  deliberate arrival that ends the hold through `focus()`'s own release rule.

**Deleting the discussion then falls through to its heir.** Without it the focus
would point at a card that no longer exists and the reader would be looking at a
column with nothing lit in it. The heir is found on the RECORD (`from_thread`),
not in session memory, so it works after a reload and in another tab; it is
HELD rather than merely focused, because the column just lost a card above it
and everything below has moved up.

### Files

```
store.mjs                       setThreadMark; STRIKE_MARK / strikeOfferBlock /
                                parseStrikeSuggestion; addThread takes
                                `from_thread` and `from_msg`; appendMsg carries
                                `strike` (per MESSAGE, like `file_in`)
server.mjs                      strikeable(); POST /mark; POST /strike-from;
                                the reply-event lift; `strikeContext` in summon
chat.mjs                        envelope takes `strikeContext`, after the body
                                and before the roster
extension/anchor.js             markStruck(id, on) — the class toggled and the
                                mark restyled in place, like markResolved
extension/content.js            onSetMark, onStrikeFrom
extension/drawer.js             the card-head S̶ and its quieter reverse, the
                                strike chip, doSetMark / doStrikeFrom, the hold
                                on confirm and the delete fall-through
extension/drawer.css            .rebtn.thr-mark(.back), .filechip.strikechip
                                (.done/.passed), .card.arrived
bridge-system-prompt.md         rule 13 — suggest rarely, only when invited,
                                and (2026-08-27) with a note that stands alone
```

**Testing.** `test/strike.test.mjs` (28) is the store's primitives, both
endpoints and every refusal, the retroactive thread, the envelope offer's three
conditions, the suggestion lift, the mint, its independence after the discussion
is deleted, and what `Ann.threadContents` writes for it (the owner's name, the
reason, no bot, no discussion, no `from_thread`). `companion.test.mjs` adds
`/mark` and `/strike-from` to the owner-only 403 list. Harness
`?pdf=1&strike=1&selftest=1` grows from 39 to 69: the affordance on a plain
thread, the quieter reverse on a struck one, neither on a filed one, the
conversion and its repaint and its undo, TWO chips from two bots each with its
own wording, taking the second one, the first retiring to "not chosen", the
mint's independence, the arrival, the hold, and the fall-through on delete.
Both suites drive the reader's actual scenario — ask claude, ask codex, take
codex's — end to end.

`test/mock-bridge.mjs`: `[mock:says:…]` now takes the LAST match in the turn
rather than the first, for the reason `[mock:write]` already did — the envelope
replays the thread's history above the new message, so a directive from two
turns ago is still in this turn's text, and a thread where the reader asks
claude and then codex had codex answering in claude's words.

#### Known limits (deliberate)

- **Two threads on one passage is two markings on one passage.** Between the
  mint and the delete, the passage carries the discussion's amber wash and the
  new red line at once. That is honest — it is what the record says — and it
  resolves itself the moment the reader deletes the discussion, which is the
  workflow the feature exists for.
- **`from_thread` and `from_msg` may dangle**, by design. They are provenance,
  not foreign keys — deleting the discussion is the point of the feature.
- **A suggestion can be inside the long-thread fold.** Four units is a folded
  thread (`collapsePlan`), so on a conversation that went back and forth the
  first bot's chip sits behind "Show 1 earlier reply". That is the fold doing
  its job; the reader opens it to compare the two proposals anyway.
- **A struck thread cannot be filed and then re-struck.** Reopen it first; the
  refusal says so.

## Amendment (2026-08-26, shipped): a mark knows what else is marked beside it

Reported on a real manuscript, and it is the failure the strikeout feature made
possible. One sentence, three marks: two passages already struck, a third still
being discussed. The reader asks the bot in the third thread for a rewording,
likes it, says "add it" — and what comes back rewrites the WHOLE SENTENCE,
swallowing the words the other two marks already cover, and does not match the
suggestion it had just made.

It reads as disobedience and it is not. **The turn showed it a passage and never
drew it a fence.** `chat.envelope` on a thread carried the thread's own quote,
its page number, the `struck` line if this thread was struck, the strike offer,
the conversation — and nothing whatever about any other mark on the page. The
neighbouring strikeouts do not exist in that turn. A model asked to improve a
sentence it has been handed will improve the sentence it has been handed; the
words it must NOT touch are invisible to it, and "the user highlighted this
passage" reads as where to start, not where to stop.

So two things ride every thread turn now, and they are one thought.

### 1. The neighbours (`store.nearbyMarksBlock`)

A compact block listing the OTHER threads sitting on or beside this thread's
quote — each with its kind, its state and its exact wording, nearest first:

```
OTHER MARKS ON THIS SAME PASSAGE. Yours is not the only mark here — these other
comment threads sit on or beside the passage you were given, nearest first, and
the words each one quotes are already covered by its own mark:
- strikeout — a suggested deletion; open: "of the tumbling debris"
- strikeout, minted from a discussion; open: "as we shall see below,"
(…and 2 more nearby, not listed.)
Leave their text alone: do not restate it, re-cover it, or fold it into a
wording of your own. A suggestion that swallowed one of them would apply the
same edit twice.
```

**NEAR, defined so it can be computed on the companion and tested without a
browser.** A neighbour qualifies when it is on the **same anchor page** (a PDF
thread stores its page; 0 is unpaged) and, in that page's snapshot text, its
span **overlaps this thread's or lies within `NEARBY_CHARS` of it** — a couple
of sentences, not a section. The snapshot is the same file the envelope already
names, read once per turn and measured **a page at a time** (`snapshotPageText`),
or a quote that also occurs on page 4 would drag page 4's marks into a turn
about page 7. Quotes are located prefix-first: a short quote occurs a dozen times
on a page and the 32 characters the anchor kept are exactly what tells those
dozen apart.

Where there is no snapshot, or a quote no longer matches the text under it (a
rewritten passage, an orphan), the fallback is the anchors themselves — a
neighbour counts when its quote falls inside this thread's `prefix+quote+suffix`
window or vice versa. That is a 32-character horizon rather than 240: it
**under-reports rather than inventing** neighbours that are not there.

| cap | value | why |
|---|---|---|
| `NEARBY_MAX` | 6 | a list nobody reads is a list nobody obeys; what did not fit is counted out loud |
| `NEARBY_QUOTE_MAX` | 160 | enough to recognise a passage, never enough to quote a paragraph twice |
| `NEARBY_LIST_MAX` | 1200 | the list is clipped; the closing instruction is appended AFTER the cap, so the one line that matters most can never be the line that gets cut |
| `NEARBY_CHARS` | 240 | "beside it" is a sentence or two either way |

**PDFs only**, like the strike offer and for the same reason: an `/StrikeOut` is
what makes a neighbour a decision rather than a conversation, and only a PDF
carries one. An article's turn is byte-for-byte the turn it was, plus §2.

### 2. The span rule (`chat.SPAN_DISCIPLINE`)

Phrased **once**, in `chat.envelope`, and therefore on every turn that quotes a
passage: an ordinary reply, a review round's per-comment turn (`/send-review`
funnels through the same `summon`), a thread about to conclude in a strikeout.
Never on page chat (no quote, nothing to confine to), never on a library turn,
never on a filing summary (neither writes anything).

> YOUR REMIT IS THE QUOTED PASSAGE, EXACTLY. Any rewording you propose, any
> replacement you write and any deletion you suggest must fit inside the passage
> quoted above and must not change a single word outside it — not the rest of the
> sentence, not the words either side of it, and never text that another mark on
> this page already covers. If the change you believe in genuinely needs
> something outside the quote to move as well, do not quietly widen your wording
> to reach it: say so, in a line of its own — "this would also need changing
> outside your highlight: …" — and leave that text where it is. And when the
> reader says "add it" or "do it", implement EXACTLY the suggestion as you
> already stated it in this thread, word for word, with no scope growth; "add
> some of it" means the part they named and nothing else.

The escape hatch is the half that keeps this honest. A rule with no way out is a
rule a model breaks quietly; **saying so out loud is a better answer than a
silent widening**, and it lands in the thread where the reader can act on it.

The neighbours ride directly above it, in that order: here is where your passage
ends, and here is who owns what is past it.

### Files

```
store.mjs                       snapshotPageText, nearbyMarks, nearbyMarksBlock
                                and the four NEARBY_* caps
chat.mjs                        SPAN_DISCIPLINE; envelope takes `nearbyContext`
                                and emits both, between `struck` and the history
server.mjs                      `nearbyContext` composed in summon, PDFs only,
                                measured in this thread's page of the snapshot
```

**Testing.** `test/strike.test.mjs` (30 → 43): the page-at-a-time snapshot read;
the reported fixture (one sentence, two strikeouts and an open thread) seeing
both neighbours nearest-first with the right kinds; a mark further down the page
excluded; the same phrase on another page excluded; a filed neighbour saying so
and an overlap measuring zero; the no-snapshot fallback under-reporting; the caps
with the closing instruction surviving the clip; the span rule present on a
quote-bearing turn and absent from page chat, the library and a summary; and,
against the live server, the whole thing arriving in a real envelope, absent on a
lonely passage, absent on an article, absent on page chat.

#### Known limits (deliberate)

- **Articles get the rule and not the neighbours.** Nothing on a web page can be
  struck, so a neighbour there is only ever another conversation.
- **No snapshot, no distance.** The anchor fallback sees 32 characters either
  side, so two marks in one long sentence that do not touch will not know about
  each other until the page has been snapshotted.
- **It is context, never a constraint.** The companion cannot check that a
  suggestion stayed inside its span — it has no DOM and no document. This tells
  the bot where the fence is; it does not build one.

## Amendment (2026-08-27, shipped): the question vault — what you read, asked back

The reader spends an afternoon on a chapter of a probability textbook and a
Taleb transcript, argues about both with the bots, understands them, and closes
the tab. In March they open the same chapter and it is new. Everything Discuss
holds is a record of having understood something once; nothing in it was ever
going to bring any of it back.

So: **a small button that says "this is interesting, make a question of it"**,
and a quiz that asks those questions back on a schedule. In the reader's own
words, and the sentence the whole design answers to.

### 1. THE READER'S ONLY DECISION IS WHICH PASSAGE

This is the constitution of the feature and every other choice below is
downstream of it.

| the reader decides | nobody asks them |
|---|---|
| which passage becomes a question | what kind of question it is |
| — | how it is worded |
| — | how hard it is |
| — | when it comes back |
| — | which deck it goes in |

There is no card editor, no approve-before-filing step, no format picker, no
difficulty slider, no interval setting, no deck management, and **no settings
surface of any kind** in this path. A bot writes the card; SM-2 schedules it;
the vault is one bank. The reader was explicit that they will not sit grading
cards Anki-style, and a feature that costs a decision per card is a feature
that gets used for a week. The cost of that is that some cards will be bad —
which is what the flag on every card, and the source link beside it, are for.

### 2. Two ways a card is made, and only one of them is a bot's

**The reader's button**, in three places, all one click:

- the **card head's `?`**, beside the ✓ and the S̶ — the same kind of thing they
  are, a one-click statement about this thread, on hover, owner-only. Not on a
  filed thread: that argument is over, and the passage is still selectable.
- the **selection pill's third tool**, on EVERY page. A strikeout is PDF-only
  because an `/StrikeOut` is a thing a file can carry; a question is about an
  IDEA and nothing about it is a property of the file format. The pill's
  question tool makes no mark, opens no thread and paints nothing — a question
  is a note in the reader's own memory, and drawing a highlight for one would
  be a lie about what the page now carries.
- the **chip under a bot's offer** (below).

**The bot's offer**, which files nothing. The reader is not the only one who
can tell that something here is worth coming back to: a bot three exchanges
into explaining conditional probability can see that the reader has not got it
— they asked the same thing twice — and the reader, busy understanding it, is
the last person likely to press a button about it. So the `strike:` /
`file-in:` idiom for the third time, deliberately identical:

```
question: <the one idea they should be able to recall>
```

`questions.parseQuestionSuggestion` reads it back — a line of its own, the LAST
one counts, markdown stripped, a reason REQUIRED (a bare `question:` is a model
echoing the convention, not concluding anything). `server.mjs` lifts it off the
reply's words into `msg.question` (per MESSAGE, like `file_in` and `strike`, so
claude offering and codex offering are two chips) and the drawer draws **File
it / No**. The invitation (`questions.questionOfferBlock`) rides every thread
turn of every page — a gap shows itself on the fourth exchange, not the first —
and a model never shown it cannot use the convention. `bridge-system-prompt.md`
rule 14 says the rest: rarely, only on a real gap, never in doubt.

**BOTS NEVER FILE.** The vault stays empty until the reader clicks. "No" is per
tab and remembered nowhere: declining an offer is not a fact about the page.

### 3. The card a bot writes, and reading it back

`strike:` and `file-in:` are single lines because they carry one fact. A card
carries seven, so it is a **fenced block** — fenced for exactly the reason those
two are line-anchored: a boundary a model cannot half-produce and a parser
cannot half-read.

````
```question
Q: What does the law of large numbers promise about the sample mean?
A) it converges to the population mean as n grows
B) it equals the population mean for any n
C) the sample variance goes to zero
D) the sample mean is normally distributed
correct: A
why: It is a statement about the limit, not about any particular sample.
kind: mcq
difficulty: 2
```
````

The LAST block in the reply wins (a model that shows its working and then
writes the card has written one card). `why:` may run over several lines;
everything else is one line. `correct:` may be a letter, a number, or the
option's own text — a model will write any of them and all three mean the same
thing. `kind` is `mcq` | `truefalse` | `cloze`, inferred where absent (two
True/False options; a `____` in the question); a true/false card written
without its options spelled out gets them supplied, and **nothing else is ever
invented**.

**A malformed reply costs exactly one visible row and can never corrupt the
vault.** Ten refusals are enumerated in `questions.test.mjs`; each one writes
`state: "failed"` with the reason on the card, which the quiz reports and the
drawer says out loud. That is the whole parsing contract.

The turn itself is `summarizeThread`'s twin: queued on the page's own lane,
**silent by construction** (no turn-start, no turn-end, nothing spins), and its
answer leaves `chat.mjs` as `card` rather than `chat` so no listener can mistake
a fenced block of machinery for a bot joining the conversation. The prompt is
`chat.cardPrompt` + `CARD_SHAPE`, and it carries the thread's history: a card
written off the argument that reached the point is a better card than one
written off the sentence alone, and the reader's own confusion is on record
there.

**The row exists before the turn does.** `POST /question` files a `pending`
card and answers immediately; the bot fills it in later. This is the only way a
generation that never comes back is VISIBLE rather than a click that did
nothing — and it is why the drawer's receipt has two stages ("a question is
being written" → "it is in the quiz now" / "it could not be written — …").

### 4. The vault (`questions.mjs`, `<ROOT>/.botference/plugin/questions.json`)

One file, atomic (tmp + rename) like every other record here. A page is a
directory because it holds snapshots and figures; a card is four short strings,
and pages went the other way because pages are written concurrently by several
lanes while the vault is written by the reader, one gesture at a time.

```jsonc
{ "version": 1,
  "cards": [{
    "id": "q-<ts>-<rand4>",
    "state": "pending" | "live" | "failed" | "flagged",
    "kind": "mcq" | "truefalse" | "cloze",
    "question": "…", "options": ["…"], "answer": 0,
    "why": "one or two sentences", "difficulty": 1|2|3,
    "source": { "url", "page_key", "title", "site", "quote",
                "thread_id", "page", "projects": [], "tags": [] },
    "created_at": "ISO", "settled_at": "ISO", "model": "claude"|"codex",
    "from_msg": "<the offer's ts>", "hint": "<the gap it named>",
    "error": "…",                        // failed only
    "flag": { "at": "ISO", "note": "…" },  // flagged only
    "sched": { "due", "interval", "ease", "reps", "lapses", "last", "last_grade", "seen" }
  }] }
```

**ONE BANK, NOT DECKS.** A card carries its provenance — the page, the council
projects that page is filed under, the reader's own tags on it — and the quiz's
filter chips are drawn from those and nothing else (`questions.facets`).
Filtering is a way of LOOKING at one vault, never a second act of filing, and
there is no gesture anywhere that puts a card somewhere. Each chip carries how
many of that topic are due and wears a ✗ where the reader has lapsed on it,
which is the whole of the analytics: it answers "where am I weak" for the cost
of a count.

### 5. SM-2, with the one simplification the product forces

SuperMemo 2 — Anki's algorithm, twenty years of other people's evidence — with
**a binary grade**. The reader taps an option and it is right or wrong; there
is no hard/good/easy, because self-assessment is the step that makes review
feel like admin.

| | q | what happens |
|---|---|---|
| right | 4 | reps+1; interval 1 day, then 6, then `round(interval × ease)`; **ease unchanged** — q=4 is the fixed point of SM-2's own ease update, which is exactly what "you knew it" should mean |
| wrong | 2 | reps→0, interval→0, lapses+1, ease −0.32, **due NOW** |

`ease` starts at 2.5 and is floored at `EASE_MIN = 1.3`, so a card the reader
keeps failing cannot spiral into being asked forever. A new card is due the
moment it exists.

**Due order: longest-overdue first.** A card three weeks overdue is closer to
being forgotten than one due this morning, and a reader who reviews irregularly
(which is every reader) should meet the oldest debt first. Ties inside one
second: whoever has LAPSED goes first (the weaker memory), then the older card,
so a queue is stable across reloads.

**And the thing the schedule on disk cannot express: a card got wrong must come
back before the reader stands up.** SM-2 makes it due this instant, which is
necessary and not sufficient — they would have to start another sitting to meet
it. So a SESSION is an order: `SESSION_MAX = 20` cards drawn from what is due,
and a wrong answer splices the card back in `REQUEUE_GAP = 3` places later (or
at the end, on a short queue, which is how a two-card sitting still asks it
again). Sessions are **memory only, deliberately**: every consequence of an
answer is written to the vault the instant it is given, so a restart costs the
ORDER of the sitting in progress and nothing else.

### 6. The quiz lives in the reading room, and that is the point

`GET /quiz` is a page in the reading room, not a panel in the drawer, because
review happens on a phone, on a train, away from the Mac the extension is
installed on. The drawer cannot be there; this page can. The drawer's header
therefore carries a **door** rather than a quiz — one icon, owner-only, whose
only piece of information is how many are due, because "6 due" is the only
thing that ever gets anybody to open it.

**Scriptless, like everything else in that room.** One card; the options are
form posts; the query string is the state. It works with JavaScript off, which
on a train is not hypothetical. `?reveal=1` paints the answer just given (from
the session), and asking for the next card is what clears it — so refreshing a
reveal cannot double-grade.

- **right** → a brief confirm, the options with the right one lit, `next ›`.
- **wrong** → the same, plus the chosen option in the strike's red, the `why`,
  and **THE SOURCE**: the passage itself with its page number, a link to the
  page (`/a/<key>` where a readable copy exists, `/p/<key>` otherwise), a link
  to the conversation the card came out of (`/p/<key>#<thread_id>`), the
  original url, and which bot wrote it. That block is never optional. A bot
  wrote this card and the reader may not believe it; being one tap from the
  paragraph is what makes the whole thing trustworthy.
- **"this card seems wrong"** → `POST /quiz-flag`. The card leaves the rotation
  at once — a card the reader does not trust must not go on being asked — and
  keeps everything it had, because phase 2 hands it back to the bots to revise.

### 7. HTTP API (owner-only, all of it)

Owner-only for the reason `/project-page` is: this is the reader's own memory
and the record of what they keep getting wrong, which is nobody's business over
a tunnel — and it spends the owner's agents.

| | |
|---|---|
| `POST /question {url, thread_id?, quote?, page?, from_msg?, hint?}` | `{card, queued}` — files a pending row and queues the turn |
| `GET /questions[?project=&tag=&key=&all=1]` | `{counts, facets, due[]}` |
| `POST /quiz-answer {id, choice}` | `{card, correct}`, or 303 back to `/quiz?reveal=1` from a form |
| `POST /quiz-flag {id, note?}` / `POST /quiz-delete {id}` | out of the rotation / gone |
| `GET /quiz[?project=&tag=&reveal=1]` | the page |

The quiz's redirects deliberately do NOT go through `backTo()`: that helper's
allowlist is `/p/<key>` and widening an anti-open-redirect guard for a page
that needs no redirect from anywhere else would be paying for this feature out
of somebody else's safety.

### Files

```
questions.mjs                   NEW — the vault, SM-2, the block parser, the
                                offer convention, the session order
chat.mjs                        CARD_SHAPE / cardPrompt; envelope takes `card`,
                                `cardHint` and `questionContext`; a card job is
                                silent and leaves as `card`
server.mjs                      makeCard(); questionable(); the reply-event
                                lift; POST /question, GET /questions,
                                POST /quiz-answer, /quiz-flag, /quiz-delete,
                                GET /quiz; the in-memory sittings
store.mjs                       appendMsg carries `question` (per MESSAGE, like
                                `strike` and `file_in`)
views.mjs                       quizView + QUIZ_STYLE; shell takes a page's own
                                stylesheet; the pages list links the quiz
extension/drawer.js             the card head's `?`, the pill's third tool, the
                                header door and its count, the offer chip, the
                                receipt line, doMakeQuestion
extension/drawer.css            .rebtn.thr-q, .filechip.qchip, .qnote,
                                .iconbtn.quiz, .selpill.plus
extension/content.js            onMakeQuestion / onQuestionCounts / onOpenQuiz;
                                commitSelection('question') marks nothing
extension/background.js         `open-here` — a tab at THIS companion, path
                                allowlisted
bridge-system-prompt.md         rule 14 — offer rarely, only when invited
```

**Testing.** `test/questions.test.mjs` (51), in five parts: the record (a
pending row before any bot has written; a malformed reply costing one failed
row with the good card untouched; the disk round trip leaving no tmp file); the
block (the last one winning, three ways of writing `correct`, true/false
without its options, and six negatives that must each produce a VISIBLE
failure); SM-2 (1 → 6 → interval × ease with the ease unmoved, a lapse
resetting and taking the penalty, the ease floor, due ordering, and the wrong
card really being asked again inside the sitting); one bank seen from angles;
and the endpoints against a live companion with mock children — capture →
pending → the bot's block → live → due → answered wrong → rescheduled → asked
again → flagged, a bare selection with no thread, and a bot's offer becoming
`msg.question` with the line taken out of its words while the vault stays
empty. `companion.test.mjs` adds the four question doors to the owner-only 403
list, and its envelope test now asserts that the offer rides AFTER the reader's
length instruction rather than before it.

Harness poses: `?question=1&selftest=1` (21) — the card-head button, one click
posting this thread's passage, the two-stage receipt, the header door lighting
with its count, a bot's chip filing nothing until it is pressed and then filing
exactly one card aimed at the gap it named, and the pill's third tool beside
the comment button. `?question=fail&selftest=1` (5) is the outcome that must
never be silent: a reply with no block in it says so, in the failure colour,
with the reason. `?pdf=1&strike=1` grew two assertions: the pill now carries
two MARKUP tools plus the question tool, which draws on nothing.

#### Known limits (deliberate)

- **No images on a card.** Where the source region has a picture cheaply
  available (a PDF page render, a snapshot `<img>`) a card could carry it, and
  the schema has room: an `image` on the card and a `figure` on the source.
  Phase 1 does not build it — the plumbing runs from the viewer through the
  companion to a scriptless page, and none of that is cheap enough to ride
  along with the rest of this.
- **A flagged card is not yet revised.** Flagging takes it out of rotation and
  records the complaint. Phase 2 hands the card, its source and the reader's
  note back to the bots as another silent turn, and replaces it in place.
- **The sitting is memory-only.** A companion restart mid-quiz loses the order,
  not the schedule: the next GET starts a fresh sitting over the same due
  cards. A card answered is written before the response goes out.
- **Nothing is deleted for you.** Failed rows accumulate until the reader
  removes them; the quiz says how many there are rather than tidying them away.
- **One reader.** The sittings are keyed by handle and the whole vault is
  owner-only, so there is no story here for a shared companion, and there does
  not need to be: it is one person's memory.

## Amendment (2026-08-27, shipped): a settled argument does not travel

The annotated copy carried RESOLVED threads — green, subject `Discuss ·
resolved`, sitting in the file beside the live ones. That is one export doing
two jobs, and it does the second one badly.

**The copy is for somebody else.** It exists for the co-author, the supervisor,
the reader with no Discuss and no companion: a PDF they open in Preview and
read. What they need to see is what is still ASKED. A filed thread is a
question already answered, an argument already had, and putting it in front of
a reader who was not in it invites them to re-open it — which is exactly what
filing decided not to do. So: **`collectItems` drops a resolved thread**, in the
same breath and for the same kind of reason as it drops one that came out of
this file already.

**And the vault note does the opposite, deliberately.** `export.mjs` keeps
filed threads, writes `*Resolved by …*` and the summary under them, and hides
nothing — because that note is not a copy for anybody, it is **the reader's own
complete archive** of what was said about this page. Two exports, two
audiences, two policies. `test/export.test.mjs` pins the note's half and
`test/pdf-render.test.mjs` the copy's, so neither drifts into the other.

**Three interactions, none of them accidental:**

- A **purely imported** thread that is resolved was already excluded, for the
  other reason. Order in `collectItems` is unchanged — `purelyImported` is
  still tested first — so its tally still lands in `already`, and nothing about
  that case moved.
- A **GROWN imported** thread that is resolved now stays out. Its original
  annotation is still natively in the file's bytes, so the supervisor's own
  remark is still there for the reader; only the discussion that followed it
  is withheld. That is unavoidable — the export writes, it does not redact —
  and it is the right side to err on.
- A resolved thread is **not a failure to place**. It never reaches
  `quadsForThread`, is counted in a new `filed`, and `filed` is deliberately
  NOT added to the drawer's `skipped`. "N comments written · M could not be
  placed" stays a true sentence about anchoring.

**When there is nothing left,** the refusal says why: *"every comment here is
resolved or already in the file"* — the old wording blamed the anchors, which
on a page where everything placed perfectly is a lie. No Save dialog is opened
for a copy that would be byte-identical to the original.

The green (`DISCUSS_GREEN`) and the `· resolved` subject are **deleted**, not
left behind: no caller can reach them any more, and a dead branch that names a
policy the code no longer has is worse than no branch.

### Files

```
extension/pdf/viewer.js         collectItems: the resolved guard, the `filed`
                                tally, DISCUSS_GREEN and the '· resolved'
                                subject gone; exportAnnotated's refusal reworded
```

### Testing

`test/pdf-render.test.mjs` (82 → 95) — the round trip gains a grown, painted,
placeable, FILED thread: not written, not counted as unplaceable, and what it
settled nowhere in the items. The real end-to-end export (both the web and the
local boot) now stages a MIXED page — one live strikeout, one filed thread on
its own passage — and re-parses the copy: the live one is there as a
`/StrikeOut`, the settled one is nowhere in the file. And an ALL-FILED page:
`ok:false`, the new wording, and `showSaveFilePicker` never called.

`test/pdf-annot.test.mjs` (111 → 112) — the writer's second fixture item is a
live yellow comment rather than a green one (the writer only ever sees live
threads now), and no written annotation carries `resolved` in its `/Subj`.

`test/export.test.mjs` (75 → 76) — the asymmetry pinned from the other side:
the vault note still keeps the filed thread, its `*Resolved by …*` line and its
summary.

Harness `?pdfannot=export&selftest=1` (35 → 36) — the stubbed viewer now
answers with `filed: 2`, and the card is asserted NOT to fold them into
"could not be placed", in the card or in the footer.

## Amendment (2026-08-27, shipped): a strikeout's note has to stand on its own

Reported from a live session on a real manuscript, and it is three failures
wearing one coat. The reader asked the bots for replacement wording for a
passage and a citation to go with it. Claude wrote the whole replacement in the
body of its reply and then made its `strike:` line a POINTER at it — "replace
with the wording above naming Shan [X], ET-Class [9] and Figure 1". The reader
confirmed the chip, and the strikeout was minted carrying THAT sentence.

Which is useless, and useless in the exact way this feature exists to prevent.
The minted strike carries no word of the conversation ON PURPOSE: the reader
deletes the discussion, and what the co-author receives is a red line, a human's
name and one note. A note that says "the wording above" points into a thread
that no longer exists, for a reader who never had it.

Then the second failure. Claude, told the note was wrong, reissued the
suggestion with the replacement inline — and the confirm did NOTHING, because
the door deduped on the quote and handed the existing strike back. There was no
route, anywhere in the product, to change the note on a strikeout that had been
minted. And the third: the note that DID get through was cut at 200 characters,
mid-word, silently — "…which extends their stiff/flexibl" — after which the bot
told the reader to paste the rest in by hand, which is precisely the clerical
work this whole feature is for.

None of that is model misbehaviour that better prompting alone would fix. The
convention asked for "one short reason", the record cut at 200, and the door
refused corrections. The bots then reported the deletion as done, because
nothing anywhere told them otherwise.

### 1. The note is the payload, not a label (`store.strikeOfferBlock`)

The offer now says, firmly, the two things the failure turned on: the note is
read by someone who has ONLY the struck passage and that line, so it may not
refer to this conversation; and where the conclusion is a replacement, the note
carries the replacement IN FULL, in quotes, however long that makes it. "One
short reason" is gone — a full replacement sentence is not verbosity, it is the
thing being filed. `bridge-system-prompt.md` rule 13 says the same in the same
words, including the sentence that matters most for honesty: **a refused line
means nothing was marked up, so never tell the reader a deletion was made.**

### 2. The guard, and why its false-positive rate is what it is

`store.strikeNoteFault(why)` answers `''`, `'deictic'` or `'long'`, with the
offending phrase for the first.

```
STRIKE_NOTE_MAX = 1200          // generous: a replacement with a citation is long
STRIKE_DEICTIC  = [ …7 patterns… ]
STRIKE_QUOTED   = /["“”«»„`][^"“”«»„`]{8,}["“”«»„`]/
```

A note is deictic when a word-boundary pattern matches AND the note carries no
quoted span. Both halves are load-bearing:

- The patterns are **narrow**. A bare `above`, a bare `earlier`, a bare `below`
  never fire: "the paragraph above already says this" is about the DOCUMENT, is
  perfectly readable beside the struck passage, and is exactly the kind of
  legitimate reason a bot writes. What fires is a REFERRING NOUN (wording,
  phrasing, version, sentence, rewrite, replacement, draft, suggestion,
  proposal, edit, revision, note, answer, reply, comment, message) pointing at
  `above` / `below` / `earlier` / `here` / "I gave"; `my earlier <noun>`; `as
  discussed` / `as I said` and their family; `see|per|use my|the … above`;
  `this thread|discussion|conversation`; and `replace … with the … above`.
- The **quoted-span escape** is what makes a false positive cheap. A note that
  contains the actual words is self-contained however it introduces itself, so
  `as discussed, replace with: "…"` passes. The cost of a wrong refusal is one
  chip the reader wanted; the cost of a wrong acceptance is a useless note on a
  document somebody else receives. The asymmetry is why the guard exists at all,
  and the escape is why it can afford to be firm.

**A refusal is VISIBLE, at both ends.** The line still comes off the reply's
words (it is machinery), and the message keeps `strike: { why, rejected,
phrase }`, which `store.appendMsg` now persists. The drawer draws a dashed,
buttonless chip — *"Not filed — the note refers to this discussion ("the wording
above"), and the co-author will only see the passage. Nothing was marked up."* —
and the bot is told on its next turn in that thread
(`store.strikeRefusedBlock`, composed by `server.mjs refusedStrikeNote`, LAST
suggestion only, so a bot that fixed it is not lectured). Silence was how the
reader ended up being told a deletion had happened.

**Nothing is ever cut.** `parseStrikeSuggestion` no longer slices (and no longer
strips markdown from the middle of the line, which used to mangle a replacement
containing emphasis); `/strike-from` refuses a note past the cap with a 400
rather than trimming it. A note is filed whole or not at all.

### 3. A minted note is CORRECTABLE (`POST /strike-from`, amended)

```
POST /strike-from { url, thread_id, note, from_msg }
  → { thread, deduped? }   same note, or no note        — nothing written
  → { thread, updated? }   a DIFFERENT note             — the note is rewritten
  → { thread }             no strike on this passage yet — minted, as before
```

Which existing strike it finds: **`from_thread` first, the quote second.** The
link is what this discussion actually minted; the quote is a guess that goes
wrong the moment an anchor drifts (the passage is rewritten, the discussion
re-anchors, and quote-equality would put a second red line beside the first).

Update semantics, and they are deliberately conservative: the note is rewritten
in place (`msgs[0].text`), the OWNER and the CREATED timestamp are untouched —
that date is the annotation's date and the export's — the message gains
`edited`, and the thread gains `updated` (ISO, absent on every strike never
renoted, so no record migrates). `from_msg` and `from_thread` follow the note.
The card and the exported `/Contents` both read `msgs[0].text`, so the
correction lands everywhere by construction.

**The owner's own hand-edit was free.** The minted comment is the reader's own
message, so `POST /edit` already took it, and the export already read it; the
only thing needed was to verify and pin it. There is no second editing path.

**The reader's route to all this** is the retired chip. Both bots may suggest;
the one not taken now reads `Not chosen — <what it proposed>` **with a `Use this
note` button**, and the chosen chip settles into `Note updated on the strikeout,
in your name. · view` when a click rewrote rather than minted. Which of the two
things happened is on the chip, never inferred.

### 4. The minted card stays inert, and keeps a way home

`strikeable` still excludes a thread that is already struck, so no offer rides a
turn in the minted card, the lift never fires there, and no chip can appear on
it. That is the enforcement of the rule the whole feature rests on: the reader
deletes the discussion so that no bot chatter travels, and running the machinery
on the one thread that must stay clean would put it straight back. All
correction happens in the discussion.

But the two are LINKED while the discussion lives. The chip points forward
(`· view`); the minted card now carries the same link read backwards — a quiet
`from a discussion · view` under the quote, rendered only while the origin is
still on the record. This closes a real navigation dead end: the strike's paint
sits over the discussion's highlight on the page, so clicking the passage cannot
reach the conversation any more, and this button is the only road back. A
RESOLVED discussion is still a discussion — filed in the archive, still jumped
to, link unchanged. A DELETED one leaves a dangling `from_thread`, and the card
simply drops the affordance and stands alone: soft link, never an error.
(Click-cycling overlapping marks on the page itself — click again for the mark
underneath — was considered and deliberately not built; the view button is the
fix, that would be a second one.)

### Files

```
store.mjs                       STRIKE_NOTE_MAX; strikeOfferBlock rewritten;
                                strikeRefusedBlock; strikeNoteFault /
                                STRIKE_DEICTIC / strikeNoteQuotes;
                                parseStrikeSuggestion no longer truncates;
                                appendMsg keeps strike.rejected / .phrase
server.mjs                      the lift consults strikeNoteFault;
                                refusedStrikeNote rides the next turn;
                                /strike-from: link-first match, the update
                                path, the over-cap 400
chat.mjs                        (comment only — the struck turn carries no offer)
extension/content.js            onStrikeFrom passes `updated` through
extension/drawer.js             the refused chip; "Use this note" on a retired
                                one; "Note updated…"; D.strikes.updated;
                                fromDiscussionHtml
extension/drawer.css            .strikechip.refused, .fromdisc
bridge-system-prompt.md         rule 13 rewritten
```

**Testing.** `test/strike.test.mjs` (43 → 57): the parse keeping a 400-character
replacement byte for byte; seven deictic notes refused and six legitimate ones
(document-deixis, and a deictic one carrying quoted words) passing; the cap
refusing rather than cutting; the lift recording `rejected` + `phrase` and
marking nothing up; the refusal riding the next turn and going away after a good
line; a full replacement intact at lift, mint, record and `Ann.threadContents`;
double-tap and empty-note still `deduped`; a better note rewriting the note,
keeping the owner and the created date and reaching the export; the owner's
hand-edit through `/edit`; and the link beating the quote after a `/reanchor`.
The envelope tests assert the new offer wording, and the already-struck one now
also pins that a minted strike is INERT.

Harness `?pdf=1&strike=1&selftest=1` (69 → 81): the fixture's third bot reply
carries a refused suggestion, so the pose asserts a chip that is visible, says
which words did it and has nothing to click; that the two live offers are still
two; that the retired chip offers `Use this note`; the correction click and its
five consequences (one red line, the new note, owner and date kept, `(edited)`
on the card, the chip saying which thing it did, the other chip standing down);
and the `from a discussion · view` link present while the discussion lives and
gone — not broken — after it is deleted.


## Amendment (2026-08-27, shipped): Memorize — the vault gets a face, an address, and a way home

The question vault shipped working and plain: a `/quiz` page in the reading
room, one card at a time, correct answers in green and everything else in a
column. Three things were missing, and they are the same thing said three ways
— **the vault is a product, and it was living as a view.**

### 1. THE LOOK

The reading room is a LIST and reads like one: dense, sans, functional. The
quiz is a single question met on a phone at the end of a day, and it is the
only page here whose whole job is to be READ. So it gets a register of its own,
built entirely out of the plugin's existing palette (`views.mjs` `QUIZ_STYLE`):

| token | light | dark | what it is |
|---|---|---|---|
| `--q-ground` | `#f8f4ea` | `#191510` | the page, one shade warmer than the room's ivory |
| `--q-card` | `#fffdf7` | `#221d16` | every card |
| `--q-line` / `--q-line-soft` | `#e6dcc9` / 22% warm grey | 20% clay / 14% | borders, and the hairline down a margin card |
| `--q-right` | `#2f7d55` | `#86c9a0` | a calm confirm — never a fanfare |
| `--q-warm` | `#a8552e` | `#e79b70` | **wrong, warmly**: deliberately NOT `--strike-line` |
| `--accent` | the plugin's own clay `#d97757` | | one accent, and only one |
| `--q-serif` | Georgia / Iowan Old Style / Palatino / Times | | the question, and nothing else |

**No web font is fetched.** This page has to work on a train with a bad
connection and JavaScript off; Georgia is on every device that will ever open
it. The sans stays the reading room's own, so the machinery never competes with
the sentence.

**Wrong is warm on purpose.** A red line in this product means "this passage
should come out". A verdict is not a correction, and being wrong in your own
memory is the ordinary business of remembering.

Both schemes are DEFINED, not derived: dark is a designed palette, not an
inversion. The page carries a `<title>` of its own (`Memorizer — botference`),
the braid favicon, and a small identity mark (`memorize · botference`) that
links home.

### 2. MARGIN NOTES, BECAUSE THIS PRODUCT IS BUILT ON THEM

On a wide screen (`min-width: 62rem`) the page is two columns:

```
grid-template-areas:  "card  margin"
                      "acts  margin"
```

The question stays exactly where it is and everything the answer brought with
it — the why, the passage it was made from, who wrote the card — sits BESIDE it
as margin notes sit beside a manuscript. **The margin column is reserved in
every state**, so revealing an answer never moves the question the reader is
still looking at.

On a phone there is no margin, so the same cards STACK under the options, met
in reading order (question → your answer → why → where it came from) with the
action bar `position: sticky; bottom: 0`. `next ›` has to be under the thumb
while the eye is still in the explanation; that is the whole argument for
pinning it, and it is the same argument the drawer's own action row makes.

### 3. `memorizer.botference.com` — the vault at an address of its own

One companion, two doors, one tunnel. `lib/plugin.sh` routes a third hostname
at the same local service (exactly as it already routes the legacy
`plugin.botference.com`), and `server.mjs` is host-aware:

| | |
|---|---|
| `memorizer.botference.com/` | **is the quiz** (GET/HEAD rewritten to `/quiz` before routing, after the gate) |
| that host, `MEMORY_PATHS` | `/quiz`, `/quiz-answer`, `/quiz-flag`, `/quiz-delete`, `/questions`, `/question`, `/auth`, `/signout`, `/whoami`, `/health` |
| that host, anything else | `302 → /` for GET/HEAD, a clean `404` for anything else |
| `discuss.botference.com` | unchanged in every respect |
| override | `PLUGIN_MEMORY_HOSTNAME` (comma-separated), `PLUGIN_READING_HOSTNAME` |

**Nothing about auth changes, and that is the point.** `hosted.mjs` has never
looked at hostnames — `isLocalDirect` asks only whether the request came from
localhost — and the review hub's device cookie is scoped to the PARENT domain,
so a phone already approved for `review.botference.com` is the owner here with
nothing typed. A `plugin_auth` session cookie is host-only, so signing in with
the password on the new host is its own sign-in, which is the same behaviour
the legacy door has had since the rename.

Because the reading room is a DIFFERENT address from there, a card's source
links have to be absolute on that host: `readingRoomOrigin(req)` swaps the
leading label (`memorizer.` → `discuss.`) and every link in the view takes a
`home` prefix that is empty everywhere else.

### 4. Both directions of one link

Filing a question paints NOTHING on the document — deliberately: a question is
a note in the reader's own memory, not a property of the file. That is right,
and it left a thread with no way to say what it had produced, and a card with
no cheap way back. Both are now drawn, in the idiom the strikeout's `from a
discussion · view` established:

- **On a card (every state, not only a wrong answer):** one muted line,
  `from a discussion · trace ↗` / `from a page you read · trace ↗`, opening in
  a new window (`target="_blank" rel="noopener noreferrer"` — scriptless).
  `server.mjs traceOf()` resolves it against the LIVE record at render time and
  has exactly three outcomes: the discussion if that thread still exists, the
  page if only the page does, and **nothing at all** if the page is gone. A
  card's `thread_id` is a soft link by design, like a strikeout's `from_thread`.
  The wrong-answer state keeps the full source block as well — quote, page
  number, every link — and its "the conversation" link is resolved by the same
  `trace`, so a card can never outlive its discussion into a dead link.
- **On a thread:** `filed as a memory · view` (`filed as 3 memories` for
  several), owner-only, read off the vault rather than the thread so that a
  card discarded in the quiz stops the line appearing. `GET /questions?page=<url>`
  answers it in the request the drawer was already making, as
  `threads: {thread_id: n}` — a failed row is not a memory; a pending one is
  about to be and counts.

### 5. The Memorize tab — the near view

`memorizer.botference.com` is the everything-bank, for revising CONCEPTS away
from the Mac. The drawer gets the other half: **revise the page you are still
standing on, while the argument that produced the questions is open beside it.**

- A third tab, **Memorize**, owner-only, with the due count for the page.
- Scope chips: `this page`, and the council projects that page is filed in.
  **Never "everything"** — that is the far view, at its own address, and a
  drawer offering it too would be two homes for one archive.
- `GET /memory?url=<page>[&scope=page|project:<id>]` → `{scope, scopes[], counts, cards[]}`.
  Owner-only. It adds the SCOPE and nothing else: answering goes through
  `POST /quiz-answer`, the very endpoint the scriptless page posts to, so there
  is **one SM-2 record on disk written by one place**. The sitting's ORDER is
  drawer-local (a wrong card returns `MEM_REQUEUE = 3` places later), memory-only
  for the same reason the server's sitting is.
- Tapping a thread's `filed as a memory · view` opens the tab on that thread's
  own question — reordering what is already due, never surfacing a card the
  schedule is resting.

**The wrong-answer moment, in a 320px column.** There is no margin here, and
the naive translation (keep four option boxes, squeeze the explanation under
them) spends the whole column on what the reader has already finished with. So
the card becomes a **correction slip**:

1. what they pressed shrinks to one struck line — `you said · B · …`;
2. the distractors GO. They did their work at the moment of the tap; after it
   they are three plausible wrong sentences between the reader and the answer;
3. the right answer is promoted to a labelled slab in the confirm green — the
   only option still at full size, so there is nothing to misread;
4. the why then gets the full width, with the accent hairline the margin cards
   wear on the quiz page — the same object, stacked rather than set beside;
5. `next ›` sticks to the foot of the pane.

### 6. Two ways a card leaves, and they are different acts

| | route | what it means |
|---|---|---|
| **seems wrong** | `POST /quiz-flag` | PARKED: out of rotation, everything kept, waiting to be rewritten (phase 2 hands it back to the bots) |
| **discard** | `POST /quiz-delete` | DROPPED: this was not worth remembering after all — **the row is removed from the vault, with no tombstone and no undo** |

Both are offered on the quiz page and in the Memorize tab, quiet and well under
the answer, so nothing competes with reading the explanation. Neither is silent:
the quiz redirects to `?gone=discarded|flagged` and says which happened in one
line; the tab says the same thing in its own beat for four seconds.

### Files

```
views.mjs                 QUIZ_STYLE rewritten; quizView takes `trace`, `home`
                          and `gone`; sourceHtml resolves its thread link;
                          traceHtml; the identity mark and the page's <title>
server.mjs                MEMORY_HOSTS / MEMORY_PATHS / readingRoomOrigin /
                          isMemoryHost; the host rewrite in handler();
                          traceOf(); GET /memory; /questions gains `page`,
                          `threads` and `page_counts`; quizBack carries `gone`
questions.mjs             threadCounts()
extension/drawer.js       the Memorize tab (state, loadMemory, answerMemory,
                          retireMemory, the correction slip); memoryLineHtml on
                          a card; refreshDue carries the thread map
extension/content.js      onMemoryCards / onQuizAnswer / onQuizFlag /
                          onQuizDiscard; onQuestionCounts asks about this page
extension/drawer.css      .pane[data-pane="memory"] and everything under it;
                          .fromdisc.frommem
lib/plugin.sh             PLUGIN_TUNNEL_MEMORY_HOSTNAME — a third ingress rule
                          at the same companion
```

**Testing.** `questions.test.mjs` (51 → 66) gains three parts: the two-way link
(a page naming which threads minted a memory; the door's count staying global
while it does; a failed row not counting and a discarded one stopping; the
trace across all three existence states, ending in NO affordance at all);
the near view (page scope, project scopes, a 404 for an unknown page, and an
answer from the tab writing the one SM-2 record — the lapse, the ease penalty,
the right answer leaving the ease alone, the card leaving the due list);
and the host (`/` is the quiz there, `/quiz` still is, the reading room 302s
home, a write to an unserved path 404s, the source links go absolute, an answer
and a flag round-trip and land back on that host, and `discuss` is untouched).
`companion.test.mjs` (205 → 206) adds the new host to the hosted server: the
gate in front of `/`, an approved device being the owner through it, a
signed-in GUEST still refused, and `/pages` going home. `launcher.test.mjs`
pins the third DNS route and the third ingress rule.

Harness `?question=memorize&selftest=1` (22): the thread's line and its count,
opening the tab on that thread's card, the two scopes and never a third, the
answer going to `/quiz-answer`, the correction slip (the struck line, the
promoted answer, the distractors gone, the why at width, the trace, `next`),
and discard removing the card from the BANK with a beat that says so.

#### Known limits (deliberate)

- **Discard has no undo.** The row is gone. "Seems wrong" is the reversible one
  and is the right button for "this card is bad"; discard means "I do not want
  to be asked this again", which is a statement about the reader's own bank.
- **The tab's sitting is drawer-local.** Closing the drawer costs the order of
  the sitting, never the schedule — the same trade the server's own sitting
  makes, for the same reason.
- **The tab never shows the whole bank.** By design. If the reader wants
  everything, the answer is the address, not a chip.

## Amendment (2026-08-28, shipped): the bots can see the page

The reader highlighted a figure caption on their own manuscript — *"Figure 2:
Concept renders of two inflation roles"* — and asked what the render actually
showed. The answer came back that it could not be seen. It was a true answer,
and it was the product failing: a PDF reaches the agents as **extracted text**,
and a figure is not text. It is absent from the snapshot, absent from the
envelope's inline slice, absent from PDF.js's own text layer. Everything this
product does with a manuscript it did blind, and the only thing a bot could do
with a plot was paraphrase its caption back.

So the page itself crosses.

```
   the viewer renders page N ──POST /page-image──▶  snapshots/<key>-p<N>.png
   (it is drawing that page anyway)                          │
                                                             ▼
                             the turn NAMES that file, and the CLI opens it
                             (claude: Read · codex: view_image)
```

### 1. WHO RENDERS IT, AND WHY IT IS NOT THE COMPANION

The tab, and only the tab — the same call the PDF export made, for the same
reason. The companion has never seen the document (the local-PDF promise is
that the bytes are never uploaded, copied or stored) and could not rasterize it
if it had. `pdf/viewer.js` already holds a parsed `PDFPageProxy` for every page,
so `capture(n)` draws that page to an **offscreen** canvas and hands back
base64. Offscreen deliberately: the display canvas belongs to the zoom the
reader chose, may be mid-render, and for a page forty pages down does not exist
at all (the viewer paints only what is on screen — a page has a text layer long
before it has pixels). None of those should decide what the bots get to see.

What crosses is a **picture of one page**, exactly as the snapshot is a copy of
the words on one page. The invariant is untouched: an image is not text, so it
does not enter the identity, the anchors, the export or the record.

**The scale is 1700px on the long edge**, which is the one number this had to
get right: 9pt type in a two-column paper is legible at it, a dense table reads
at it, and a text page costs 300–500 KB. Measured on the reader's own 18-page
manuscript through the real viewer: 1202×1700, 311–515 KB, **36–107 ms** a
page. A page of photographs can still pass the companion's 4 MB cap as PNG, so
that one page re-encodes as JPEG at 0.85 rather than being dropped — a slightly
soft figure is worth incomparably more than no figure.

### 2. WHEN IT IS CAPTURED

On the cadence the snapshot already proved, and for the same reason: **before
the message that may summon**. `content.js` captures the page a comment is
being made on (`onSave`, from `pendingSel.page`) and the page a reply's thread
sits on (`onReply`, from the record), then posts, then sends the message — so
`planSteps` finds the file already on disk when it plans the turn.

Not only on mentions. The summon may come hours later from the phone with this
tab long closed, and **a page nobody captured then is a page nobody can capture
at all**. So any comment on a page of a document buys that page's picture.

Never at the cost of the comment. The capture is raced against 6 seconds and
every failure — no viewer, a render that throws, a refused POST — resolves
quietly; the message goes either way, and the turn then says the page could not
be seen rather than pretending.

**Content-keyed at both ends.** The extension hashes what it captured and does
not send an unchanged page twice; the companion hashes what arrives and, if the
bytes match the file it holds, writes nothing and does not even touch the
mtime. A re-capture is free, which is what lets the cadence be this liberal.

### 3. THE DOOR: `POST /page-image` (owner-only)

```
{ url, page, ext?, data }        data: base64, or a whole data: url
→ { ok, stored, unchanged, page, bytes, path }
```

Owner-only for a sharper reason than the snapshot's: this file is handed to an
agent **to look at**. Choosing the pixels a model reads is the last power a
guest may hold. Capped at 4 MB (`PAGE_IMAGE_MAX`), and the bytes must actually
BE a PNG or a JPEG — checked by magic number, because a field called `ext` is
not evidence of anything. Over the cap answers `{stored:false, reason}` rather
than failing, exactly as an oversized snapshot does.

Storage is `store.savePageImage` → `snapshots/<pageKey>-p<N>.png` (or `.jpg`),
beside that page's snapshot, one file per page, replaced whole. It is a cache
of the document as it is now, never a version history. `pageImagesOf(key)` reads
the answer off the directory rather than out of the record, so there is no
second place for the truth to live and go stale. Deleting the page deletes the
pictures with it.

### 4. WHAT THE TURN SAYS — THREE STATES, AND THE MISSING ONE IS SAID OUT LOUD

`chat.figureBlock` (pure, exported, unit-tested), composed in `planSteps` at
the moment the turn is planned — like `hasSnapshot`, so a capture that landed
while the turn queued counts — and riding in `standing` beside the snapshot
path, on **every** turn and for the same reason (a resumed session's replayed
history is uneven; a bridge restart drops it whole).

| the turn | what it says |
|---|---|
| anchored to page N, captured | *"A rendered image of page N of this document is on this machine, at `<path>` — open it (claude: the Read tool; codex: view_image) to SEE that page as it is printed… The passage quoted below is on that page. Answer figure questions from what you can SEE in the image — never infer what a figure shows from its caption."* |
| anchored to page N of a paged document, NOT captured | *"No rendered image of page N is available… you can read its words but you CANNOT see its figures. If what is being asked is about a figure, say plainly that you cannot see it and ask the reader to open the document again; do not answer from the caption as though you had looked."* |
| page chat on a document that has pictures | the pages that have one, each named by path |
| an article, or any turn on no page | nothing at all — byte-for-byte the envelope it always was |

The second row is the load-bearing one. A turn whose page was never captured
must not look like a turn on a page with no figures: silence there is precisely
how a model ends up confidently describing a plot it has not seen. So the
absent state is a sentence, and it is an instruction to say so.

### 5. BOTH BOTS, HONESTLY — AND CODEX CAN SEE

The envelope names each CLI's own verb because a model made to guess which tool
applies is a model that wastes the turn. **Verified empirically against a real
image, not assumed**: `claude -p` opens a PNG with `Read` and reads it back;
`codex exec` (0.147.0) opens it with its `view_image` tool and reads it back.
Both therefore see the page, and reads are already pre-allowed on plugin turns
(the deny gate only ever sees WRITE requests), so a named path costs no prompt
and no new permission surface — the snapshot path's own argument, unchanged.

Had codex been blind it would have been told an image exists and where, and
told to say it could not open it. The wording degrades that way by
construction; it simply did not have to.

### Files

```
extension/pdf/viewer.js   capturePage(n) — offscreen render, SHOT_EDGE 1700,
                          PNG with a JPEG fallback over SHOT_MAX; exposed as
                          __BFP_PDF.capture
extension/content.js      capturePage/pageOfThread — the cadence, the hash, the
                          6s race; awaited in onSave and onReply
server.mjs                POST /page-image (owner-only), PAGE_IMAGE_MAX,
                          pngLike/jpegLike
store.mjs                 pageImageFile / findPageImage / pageImageInfo /
                          pageImagesOf / savePageImage / deletePageImages;
                          deletePage takes the pictures too
chat.mjs                  figureBlock; envelope gains pageImage / pageImages /
                          paged; planSteps computes all three
```

### Testing

`companion.test.mjs` (206 → 212): the picture stored beside the snapshot and
named by page; a re-capture writing nothing and not touching the mtime; a
changed page replacing; a `data:` url accepted; the door refusing a non-image,
an oversized page, a missing page number, empty data and an unknown page; the
guest 403 beside the other owner-only doors; and then the three envelope states
end to end through the mock bridge — the image named by absolute path with both
CLIs' verbs on a captured page, "No rendered image of page 9" on one never
captured, the list on page chat, and an ARTICLE saying nothing either way.
Deleting the page deletes the pictures.

`pdf.test.mjs` (172 → 186): the store's half pure — the content key, the
re-encode replacing rather than doubling, `pageImagesOf` ascending, deletion —
and `figureBlock`'s four shapes.

`pdf-render.test.mjs` (95 → 106): the seam FOR REAL. The two-page fixture in a
real Chromium, `__BFP_PDF.capture(1)` through real PDF.js: real PNG bytes at a
legible size, a page that does not exist coming back `null` rather than
invented, the store filing it, and **the path the envelope prints existing on
disk and being an image**. A live bridge cannot be stood up in a test, so that
is exactly where the assertion stops — the seam is the path, and the path
resolves.

Harness `?pdf=1&selftest=1` (50 → 59), driven at the seam the viewer uses: a
comment on page 2 renders page 2, posts it as base64 under the PDF's own url,
and does so BEFORE the message; a second comment on the same page posts
nothing; and a render that throws still saves the comment and posts nothing.

#### Known limits (deliberate)

- **Web articles are still text-only.** An `<img>` beside a quote is not
  fetched. The shape is the same one (nearest image to the anchor at thread
  creation, downloaded by the companion, named the same way) and is designed,
  not built.
- **A region you cannot select is still not commentable.** Page-vision covers
  most of that pain — comment on any text on the page, or in page chat, and the
  bot sees the whole page, figure included — but where a scanned page has no
  text at all there is nothing to anchor to. The intended shape is a rect
  comment: alt-drag on the page, the nearest caption line as the thread's quote
  (so it anchors, exports and orphans exactly as every other thread does), with
  `region:{page,x,y,w,h}` beside it for the badge and the turn. Designed, not
  built: it is a selection-UX change, a drawer change and a record-shape change
  for a case page-vision already softens.
- **Only pages that have been commented on are captured.** No pre-capture of a
  whole document: 18 pages of PNG for a paper the reader may mark up twice is
  a cost the product should not take without being asked.

## Amendment (2026-08-28, shipped): a filed question can be CORRECTED

Reported from the live vault. The reader filed a card off a discussion, read
it, decided the wording was wrong, and asked the bot in that same thread to
rewrite it. The bot did the only thing the conventions gave it: it wrote
another question. Two live cards from one argument, both about one idea, the
first one standing — and **no route anywhere in the product to change a card
once it exists**. A bot could mint and nothing else.

That is the strikeout's failure of 2026-08-27 exactly (a note that came out
wrong, with no way to correct it), so it gets the strikeout's answer, in the
same shape and the same words: a suggestion the reader confirms UPDATES what is
already there.

### 1. The convention: a block that names the card it replaces

The offer block (`questions.questionOfferBlock`) now takes what this discussion
has already filed, and rides the turn carrying it — id and the first words of
each question, `questions.mintedIn` reading the live vault at envelope time,
exactly as the strike offer reads the record:

```
QUESTIONS THIS DISCUSSION HAS ALREADY FILED:
  · q-1756…-a1b2 — “What does the law of large numbers promise…”
```

…and teaches the form for changing one. `strike:` and `file-in:` are single
lines because they carry one fact; a card carries seven, so a REVISION is the
same fenced block a card has always been, with one line more:

````
```question
revises: q-1756…-a1b2
Q: What does the law of large numbers promise about the SAMPLE MEAN?
A) it converges to the population mean as n grows
B) it equals the population mean once n is large enough
correct: A
why: A statement about the limit, not about any particular sample.
```
````

`revises` is a field of the block, not a line of the reply, because it belongs
to the card and not to the conversation — and being a field means it also
closes a running `why:`, whichever order a model writes its fields in.
`revises:` / `revise:` / `updates:` are all read; the last block naming a card
wins, like every other convention here.

**The sentence that carries the whole fix is the negative one.** The offer says
plainly that a ```question block WITHOUT a `revises:` line asks for a NEW,
SECOND card, so if the intent is to change one of the questions listed above
the line is not optional. `bridge-system-prompt.md` rule 14 says the same. A
bot asked to "reword that" that writes a plain block still mints a duplicate —
there is no way to infer the intent from a block that does not carry it (two
questions about one passage are an ordinary thing to want), so that residual
risk is accepted and answered on the other side by the duplicate hint below.

**The lift and the chip.** `server.mjs` lifts the block off the reply's words
into `msg.question = { revises, why, card }` (per MESSAGE, like `strike` and
`file_in`), `store.appendMsg` persists it, and the drawer draws **Revise the
card / No** instead of **File it / No**. Confirming it summons nobody: the
corrected card is already on the record, and `POST /question-revise` reads it
from there rather than from the request — so the chip carries pointers only and
no client can post a card of its own invention into the reader's bank.

### 2. What an update changes, and what survives

```
POST /question-revise { url, thread_id, from_msg }   → { card, revised: true }
```

`questions.reviseCard` replaces the question, the options, the correct answer,
the why, the kind and the difficulty — the whole of what a bot writes — and
keeps:

- **THE SCHEDULE, untouched.** Not the ease the reader has earned on this idea
  over four months, not the lapses, not the due date. The card is a handle on a
  CONCEPT; the reader's history with that concept is the valuable thing in this
  file and the wording is the cheap part. Resetting SM-2 because a sentence was
  rephrased would throw away the only data here that took time to make, and
  would punish correcting a card — the last thing this should do.
- the provenance (`source`), so the trace links, the page, the projects and the
  tags all still point where they did;
- `created_at` and `model` — when the memory was made, and who wrote the card
  that made it. `updated_at`, `revised_by` and `revised_from` are recorded
  BESIDE them, never over them (the `edited` idiom `store.appendMsg` uses).

A **flagged** card goes back to `live`: "seems wrong" parks a card waiting to be
rewritten, and this is the rewrite — leaving it parked would make the fix
invisible. A **failed** one goes live too; a row saying "the reply had no block
in it" is exactly the row a second try repairs. And `settle` / `failCard` now
touch a PENDING row only, so a generation that comes back minutes late cannot
write a stale draft over a card the reader has since corrected.

### 3. Two refusals, and neither may ever mint

Checked at the lift, against the vault the reader actually has, and re-checked
at the door against the vault as it is by then:

| the `revises:` names | `rejected` | the chip says |
|---|---|---|
| a card that is not in the vault | `unknown` | *"Not changed — there is no such card in your vault (q-…). Nothing was filed either."* |
| a card belonging to another page | `elsewhere` | *"…that card belongs to another page, and a question is only revised from the discussion it was made in."* |
| a block that will not parse | `unparsed` | *"…the corrected card could not be read."* |

The chip is dashed and **has no button at all**, exactly like a refused strike
note, and for the identical reason: the reader watched a bot propose a
correction, and a proposal that silently amounts to nothing is how they end up
being told a card was fixed when it was not. Falling through into minting a new
card would be worse still — that is the failure this whole amendment exists to
end. The bot is told on its next turn in the thread
(`questions.reviseRefusedBlock`, composed by `server.mjs refusedRevision`, LAST
suggestion only), including the ids it could have named.

### 4. "This looks like a duplicate" — a hint, and nothing more

The reader can still end up with two cards about one idea (a bot minting
instead of revising; a second click on a passage already filed), and the place
they NOTICE is the place they are asked both. So `questions.duplicateOf` — one
pass over the bank per card drawn, no index, no model call:

> Two **live** cards look like the same question when they are from the same
> page and either they came out of the **same discussion** (`thread_id` — the
> case that actually happened, and the strongest evidence there is: one
> argument, one point, two cards) or their question texts overlap by
> `DUP_SIM = 0.7` (Jaccard over words of 3+ letters, stable against stopwords
> and word order).

It rides the cards (`GET /memory`, and the quiz's own reveal) rather than being
a request of its own, because both surfaces draw it beside the card. It offers
the three answers there are — discard that one, discard this one, or **they are
different** (`POST /quiz-keep`, which pins the pair on BOTH cards so the hint
never returns). Nothing merges, nothing goes automatically, and a hint the
reader ignores costs one quiet line. On the quiz it appears **on the reveal
only**: the moment to decide what to keep is after a card has been asked, never
while they are trying to answer it.

### 5. The two quiet exits, findable

`seems wrong` and `discard` existed and the reader could not find them: they
were drawn only AFTER an answer, so the only way to be rid of a card was to
answer it first — which grades a question you are trying to delete. They are a
statement about the CARD, and the card is on screen before it is answered as
much as after it, so the row is now drawn in **both states of the Memorize
tab**, same place, same words, same quiet register.

### Files

```
questions.mjs           reviseCard(); mintedIn(); parseCardRevision();
                        reviseOfferBlock() + reviseRefusedBlock();
                        duplicateOf() / textOverlap() / keepBoth();
                        `revises` in the block grammar; settle/failCard
                        act on a PENDING row only
server.mjs              the revision lift and its two refusals; mintedHere() /
                        refusedRevision() on the envelope funnel; POST
                        /question-revise, POST /quiz-keep; withDuplicate() on
                        /memory and the quiz's reveal
store.mjs               appendMsg carries question.revises / .card / .rejected
views.mjs               dupHtml() + the .mcard.dup rules
extension/drawer.js     the Revise-the-card chip and the refused one;
                        doReviseQuestion(); memMinorHtml in both states;
                        memDupHtml() + keepMemoryPair()
extension/drawer.css    .filechip.qchip.refused, .memdup
extension/content.js    onQuestionRevise, onQuizKeep
bridge-system-prompt.md rule 14 — change it, do not write another one
```

**Testing.** `questions.test.mjs` (66 → 89). Pure: the offer block naming what
was filed and refusing to invite an invented id; the block parsed whole, the
last one winning, a plain block still meaning a NEW card, and an unparseable
one still recognised as an attempted revision; the update with the schedule
asserted byte-for-byte unchanged; a flagged card revived; a late generation
dropped; and the duplicate signal in both its shapes with the negatives (a
different question, another page, a parked card, and the veto). Live: the
envelope carrying the minted list, the block coming off the words, the vault
untouched until the click, the confirm rewriting ONE card with its schedule,
both refusals minting nothing and refused at the door too, the bot being told,
and the hint over the wire with `/quiz-keep` pinning it on both cards.
`companion.test.mjs` adds the two new doors to the owner-only 403 list.

Harness: new pose `?question=revise&selftest=1` (15) — the two chips (an offer
whose button says *Revise the card*, and a buttonless dashed refusal), nothing
changing until it is pressed, one card and not two afterwards, and the schedule
proved intact through the fake companion. `?question=memorize` (22 → 30) gains
the exits in the unanswered state and the duplicate hint with its veto.

#### Known limits (deliberate)

- **A bot that ignores `revises:` still mints.** Answered by prompt wording and
  by the duplicate hint, not by inference. See §1.
- **The hint is not a dedupe engine.** No merging, no clustering, no
  cross-page pairing, and no hint at all for two cards that say the same thing
  in genuinely different words. One cheap signal, surfaced where the reader is
  already looking.
- **A revision is not versioned.** `revisions` counts them; the previous
  wording is not kept. The card is the artifact and the discussion is the
  workshop — the old wording is still in the thread that wrote it.

## Amendment (2026-08-28, shipped): a textbook opens

The reader wants to mark up a five-hundred-page book. On the manuscripts this
product was built against — eighteen pages, a dozen threads — nothing was ever
wrong. At a hundred pages with a hundred threads the tab froze for **two
minutes and seventeen seconds** before a single highlight appeared, and every
comment filed froze it again. At the size actually wanted it did not open at
all.

Nothing was broken. Every assertion in every suite passed, before and after.
The product was simply **quadratic in the length of the document**, in two
places, for one reason.

### 1. THE BUG, WHICH IS THE SAME BUG TWICE

```js
    raw += n.data;                       // V8 builds a CONS-STRING rope
    …
    if (raw[raw.length - 1] === '\n')     // …and INDEXING a rope flattens it
```

Both hot loops built a string with `+=` and then asked that string for its last
character. `buildTextIndex` asked at every block boundary; `normIndex` asked at
every whitespace character. Each question copied every character accumulated so
far, so a walk that should be linear in the page was quadratic in it — and the
cost is invisible until the page is a book:

| the whole page's text | one `normIndex` inside one `locate` |
| --- | --- |
| 40 pages (93 K chars) | 59 ms |
| 120 pages (281 K chars) | 1.0 s |
| 250 pages (593 K chars) | 4.5 s |
| 500 pages (1.19 M chars) | **17.9 s** |

`locate` runs once per thread, so a 500-page book with 300 threads spent about
**ninety minutes** re-anchoring itself, once per repaint, of which there are
many during a load. Chunks in an array, joined once, with the "does it end in a
newline / a space" question answered by a boolean: same output character for
character, linear.

### 2. THE PAGE'S TEXT IS NORMALIZED ONCE PER REPAINT, NOT ONCE PER THREAD

`findSpans` normalized the whole document afresh for every thread it looked
for. Linear now rather than quadratic, but still multiplied by the thread
count. One entry, keyed on **string identity** — every thread in a repaint is
located against the same `raw` — and only for haystacks over 4 KB, so a needle
can never evict the page (`normIndexOf`).

### 3. THE INDEX IS MENDED, NOT THROWN AWAY

`reanchorAll` rebuilt the entire text index between every two highlights, on
the honest ground that painting splits text nodes and leaves the index stale.
But the damage a paint does is small and exactly known: **one text node became
at most three, over the same span of offsets, and nothing else moved.**

So `paintOffsets` now writes the split back into `index.segs` in place, and one
index serves the whole sweep. A caller that rebuilds anyway is still correct,
just slower. Measured over a load of a 120-page document with 100 threads: the
document was walked **184 times (23.2 s)** and is now walked **4 times (16 ms)**.

`textNodesIn` and `locusFor` also stopped scanning all 35,000 segments to find
one — the array is contiguous and ascending by construction, so they halve
instead (`segIndexAt`).

### THE NUMBERS

The real viewer, real PDF.js and the real extension in headless Chromium over
CDP, on a synthetic PDF with a record of threads spread evenly through it.

**120 pages, 100 threads** — the largest size the old code could be made to
finish at all:

| | before | after |
| --- | --- | --- |
| load: nav → every page box AND every highlight painted | 137,192 ms | **1,032 ms** |
| whole-document walks during that load | 184 (23,184 ms) | **4 (16 ms)** |
| `reanchorAll` — the whole page re-anchored and repainted | 92,962 ms | **67 ms** |
| `locate` × 25 | 20,422 ms | **4.0 ms** |
| `buildTextIndex`, once | 143 ms | **8.7 ms** |
| Send → the reader's words visibly in the thread | 54 ms | 58 ms |
| scroll, p99 frame gap | 9.3 ms | 9.2 ms |

**500 pages, 300 threads** — the size actually asked for. There is no "before"
column because there is no before: a single repaint was ~90 minutes.

| load | `reanchorAll` | `buildTextIndex` | drawer redraw | Send → visible | scroll p99 |
| --- | --- | --- | --- | --- | --- |
| 3,793 ms | 394 ms | 34.5 ms | 66 ms | 106 ms | 13.2 ms |

`reanchorAll` at that size breaks down as: 300 unpaints 25 ms · index 38 ms ·
300 locates 179 ms · 300 paints 89 ms · the rest (reconcile, track-changes,
`setOrphans`) ~94 ms.

**Neither the Send path nor scrolling was ever the problem.** The Send is
optimistic and always was — the words are in the thread before anything is
awaited, and the figure capture is on the path but behind that (`imagePosts:1`
was confirmed on every measured Send, so nothing about the capture-at-save
guarantee changed). Scrolling a settled document was always smooth. What made
both FEEL slow was the re-anchor that a `page` event kicked off underneath
them: a minute and a half of frozen tab, arriving just after the reader
pressed something.

### Files

```
extension/anchor.js    normIndex (linear) · normIndexOf (the one-entry haystack
                       cache) · buildTextIndex (linear) · segIndexAt · textNodesIn
                       returns its seg · paintOffsets mends index.segs in place
extension/content.js   reanchorAll paints every thread against ONE index
test/pdf-perf.test.mjs the ceilings, on a 300-page / 250-thread book
```

Nothing about the anchoring CONTRACT moved: a quote must still match exactly
once in the whole document, ties are still broken by prefix/suffix overlap, and
an unresolvable one is still an orphan. Every existing suite passes unchanged
(anchor 47, pdf 186, pdf-render 106, pdf-annot 112, strike 57, companion 212,
workspace 126, …), as does every harness pose except the three already known
broken on HEAD (`tasks=1`, `checklist=1`, `unconfirmed=1&workspace=1`).

### Testing

`pdf-perf.test.mjs` (new, 11): a 300-page book generated with the vendored
pdf-lib, 250 threads spread through it in a realistic mix (open, ready for
review, filed in the closed archive, struck), driven through the real viewer.
It asserts every page laid out, every thread anchored and painted, none
orphaned — and then five ceilings: load 12 s, `buildTextIndex` 600 ms,
`locate`×25 600 ms, `reanchorAll` 3 s, Send 2.5 s. Measured on the author's
laptop: 1.7–2.3 s · 21 ms · 9 ms · 240 ms · 94–463 ms. **The ceilings are
deliberately loose and must not be tightened towards the measurements**: they
exist to catch the return of a quadratic, which is two orders of magnitude, not
to police a percentage. It skips (exit 0) with no Chromium, exactly as
`pdf-render.test.mjs` does, and the whole run costs about four seconds.

#### Known limits (deliberate)

- **Re-anchoring is still WHOLE-DOCUMENT, and is now the largest remaining
  cost.** 394 ms at 500 pages / 300 threads, on every `page` event — a visible
  hitch, no longer a freeze. The designed fix is per-page, incremental
  anchoring: a PDF thread already records the `page` it sits on and the viewer
  already renders page-at-a-time, so a repaint could touch only the pages whose
  threads changed and locate within that page's text (300 × 2.4 K chars instead
  of 300 × 1.19 M). **Designed, not built**, and the reason is the contract, not
  the work: uniqueness is currently document-wide, and a page-scoped search
  would accept a quote that is ambiguous across the book. Doing it properly
  means deciding what "exactly once" means on a paged document, which is a
  product decision and not a performance one.

- **The drawer's comment list is rebuilt whole on every change.** ~58 ms at 250
  threads, ~66 ms at 300, ~140 ms at 600 — linear, and it is what a Send
  actually costs (a small number of rebuilds; two on the minimal path). The
  designed fix is **windowing**: only the cards near the scroll position are
  built, the rest are height-reserved placeholders. Per-thread folding and the
  closed Resolved archive already do a version of this and are why the number
  is as good as it is. **Designed, not built** — it has to be reconciled with
  the send-hold (`holdInView` needs the held card to be a real node), with
  `focus`, with `restoreMention` and with the scrollTop restore, and none of
  those may regress for a win on a size the product now handles.

- **600 threads is past the shoulder.** `reanchorAll` 795 ms and Send 800 ms at
  500 pages / 600 threads: usable, not pleasant, and the two limits above are
  what would fix it.

- **The record travels whole.** `GET /page` ships every thread on every
  refresh, and a 500-page PDF's snapshot POST is 1.26 MB. Both are gated (the
  snapshot by its own content hash) and neither was measurable beside the
  anchoring, so neither was touched.

## Amendment (2026-08-29, shipped): blog source pages — the draft behind the page

The reader writes a post in markdown, runs `jekyll serve`, opens
`http://localhost:4000/…` and reads it the way anybody else will. Then they
comment on a paragraph — and until now the bots could answer that comment in
prose and could not act on it, because everything they can see is the RENDERED
page: a file under `_site/` that the next build throws away. The document was
three directories away and nothing in this companion could find it.

A page of the reader's own locally-served site is now a **blog source page**:
Discuss resolves which markdown file it was rendered from, spawns a bridge
child with that repository writable, and closes the loop — the bots edit the
source, jekyll rebuilds, the tab reloads, the reader sees the result.

### 1. What is new, in one table

| | project **artifact** page | **blog source** page |
|---|---|---|
| the address | `file://…/projects/<id>/index.html` | `http://localhost:4000/<permalink>/` |
| what the reader sees | the file itself | a RENDERING of the file |
| what the bots edit | that same file | the markdown three directories away |
| how it is found | walk up to a council root | resolve the url against the repo |
| the write root | `projects/<id>/` | the whole repository |
| the lane | the project | the repository |
| filed where | the council project's own chats | "Plugin pages", like any web page |
| publishing | n/a | **never — see §6** |

Everything else is machinery that already existed and was left alone: the
turn-end census, the reload broadcast, collateral threads, track changes,
re-anchoring, the confirmation contract.

### 2. Registration is TWO answers, deliberately

`config.json`, in the companion's own workspace:

```json
"blog_sites": [{ "serve_origin": "http://localhost:4000",
                 "root": "/Users/me/sites/angadhn.github.io", "kind": "jekyll" }],
"blog_roots":  { "/Users/me/sites/angadhn.github.io": true }
```

- **`blog_sites` is the DECLARATION** — "the site at this address is built from
  this folder of mine". Only the owner can make it (`POST /blog-site`, or the
  config by hand), and it is refused for anything that is not an http(s) origin
  pointing at a directory with a `_config.yml` or a `_posts/` in it. A list,
  because a reader may run two sites. The origin is matched EXACTLY: no
  wildcard, no "any localhost port".
- **`blog_roots` is the ANSWER** — the one-time "is this your site?" card in
  the drawer, kept per resolved path, a NO kept as firmly as a YES. It exists
  for exactly the reason `council_roots` does: what hangs off a yes is a bridge
  child spawned with that directory writable.

Declared-but-unconfirmed is a real state and it is the one the card asks in.
A comment made in it is KEPT and the bots are not summoned — the same refusal
an unconfirmed council root makes, with its own wording so the reader knows
which folder is being asked about.

### 3. Mapping is a READ OF THE REPO, never a guess from the url

`blog.indexOf(root)` walks `_posts/`, `_drafts/`, `_pages/`, every collection
directory (from `_config.yml`'s `collections:`, or the `_name` directories that
exist) and the top-level pages, reads the first 8 KB of each for its front
matter, and gives every document the list of urls it could be served at:

1. **front-matter `permalink`** — the document's own word, and it wins outright.
2. **the configured template** — the site-wide `permalink:` for posts, the
   collection's own for a collection, expanded with `:categories`, `:title`,
   `:year`, `:month`, `:day`, `:collection`, `:path` and the named styles
   (`pretty`, `date`, `ordinal`, `none`). Categories are slugified the way
   Jekyll slugifies them.
3. **the conventions** — `/slug/`, `/YYYY/MM/DD/slug/`, `/cat/slug/`,
   `/collection/slug/`, a page at its own path.

A request path is normalized (decoded, `index.html` dropped, one trailing
slash) and looked up. Anything the table misses falls to **the slug fallback**:
the last real segment of the address, matched against the slugs the repo
contains. That is what carries a permalink style this module does not model —
and where TWO documents share a slug the answer is **ambiguous**, named as
such, with both paths, rather than resolved by luck.

The index is cached per repo against the mtimes of the document directories,
`_config.yml`, and every document — so a new post, a renamed one and a
permalink edited inside an existing file are all picked up without restarting
anything.

**An unmappable page under a registered origin is an ANSWER, not a silence.**
The drawer says which address could not be resolved and why; the page stays an
ordinary web page that can be discussed; nothing is writable. A bot let loose
on a repository with no idea which file the reader means is precisely what this
module exists to prevent.

### 4. The write scope, honestly

The child is spawned with the REPOSITORY as its one extra write root
(`BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS` → claude's `permissions.allow` Edit rules,
codex's `workspace-write` sandbox). So:

- **"nothing outside this repository" is enforced by the tools.**
- **"only this post and its images" is not.** It is the envelope's instruction
  plus the turn-end census that shows the reader every file that moved. A
  directory is the only boundary an OS sandbox understands, and pretending
  otherwise would be the kind of promise this SPEC does not make. (The same
  honest gap the project-artifact amendment documents for claude's `Bash`.)

The envelope block (`blog.blogBlock`) rides EVERY turn on the page, like the
project write rule and for the same reason. It carries the source path, the
asset directories, the instruction to leave `_site/`, `_config.yml`,
`_layouts/`, `_includes/` and other posts alone — and one thing no other
envelope has to say:

> Quotes in this conversation come from the RENDERED page, so the wording you
> are given is the prose without its markdown. Find the matching passage in the
> source yourself and edit it there.

That is the whole of the source-map machinery, and deliberately so: the reader
comments on rendered text, the bot edits markdown, and a model is good at
finding the sentence. Nothing tries to map offsets between the two.

Images may be **added** (a file under `assets/`, referenced site-absolutely in
the style the post already uses) or **edited** with whatever the machine has —
`sips`, ImageMagick — which the envelope names rather than assumes. No image
editor was built and none should be.

### 5. The loop closes at the turn boundary

Turn-start takes a census of the repo and a snapshot of the source file;
turn-end diffs both.

- The census **skips `_site/`, `.jekyll-cache/`, `vendor/`, `node_modules/`**
  and every dotfile. Those move a second after the bots save, *because jekyll
  rebuilt* — counting them would make every turn "42 files changed" and the
  reload would be reporting the build instead of the edit.
- `blog-files` carries `page_changed`, and the tab does what it does for a
  project artifact: this post's source moved (or a picture in it) → reload;
  something else in the site moved → one line in the chat and nothing else.
- **The build is not waited for.** Discuss does not poll `_site/` for somebody
  else's watcher to settle. `jekyll serve` rebuilds by itself, and with
  `--livereload` the page reloads itself too — both are supported, neither is
  required, and a reload that lands a moment early is corrected by the next
  one. No loop is possible: a reload starts no turn.
- **Collateral is diffed on the SOURCE**, not on the page — the rendered copy
  is regenerated wholesale and diffing it would attribute the build to the
  bots. Markdown carries no tags for `collateral.docBlocks` to find, so the
  file is presented to the diff one paragraph per block (`blog.mdDoc`);
  without that, any edit anywhere reads as one enormous region.
  **The anchoring caveat:** an auto-thread's quote is then MARKDOWN. For
  ordinary prose that is the same string the page shows and it anchors; for a
  passage that is mostly markup it will not, and the reader gets an orphaned
  thread they can still read. That is better than a silent rewrite, and it is
  the honest cost of the reader and the bot looking at two different documents.

### 6. THE SITE'S REPOSITORY IS THE READER'S ALONE

**Discuss edits working files and stops there.** There is no publish button, no
publish endpoint, and no git anywhere in this feature: nothing here stages,
commits, pushes, branches or tags in a blog root, and the bots are told in so
many words not to. The reader puts their site live by their own hand, by their
own route.

This is a **design commitment, not an omission**, and it is stated here so that
nobody later reads the gap as a missing feature. The road from a draft to the
public internet is the author's, and a machine that could take it on their
behalf — even behind a confirm — is a machine that will one day take it by
accident.

**The contrast with the review engine is deliberate.** `frontends/review`
keeps its bot commit/push powers untouched: a paper repository under review is
a collaborative working copy where committing is the point. A blog repository
is somebody's published identity. Same company, different object.

**The guarantee lives in CODE, not in config.** `blog.KIND_RULES` gives every
kind of blog root `git: false`, `blog.gitAllowed()` is the one place that is
asked, and `normalizeSite()` keeps exactly three fields off a config row
(`serve_origin`, `root`, `kind`) so a fourth cannot be smuggled in. This
matters because the companion's `config.json` RIDES THE READER'S NIGHTLY BACKUP
REPO and will be restored onto other machines: the config records *which*
directories are blog roots — the path may differ per machine, and
re-registering is one call — while *what a blog root can never do* is not in
the file at all. A copied, hand-edited or restored config can move the path and
cannot weaken the rule; there is no flag to flip and no code path to reach.

**Defence in depth, named for what it is.** The blog child is additionally
spawned with `BOTFERENCE_PLAN_DENY_BASH=git,gh`, which
`cli_adapters._plan_denied_commands` turns into claude's `permissions.deny`
(deny beats allow, so the blanket `Bash` does not reopen it) plus a deny on
writes into `.git/`. That is a command-prefix rule enforced by one CLI; codex
has no equivalent. It is a second lock, not the lock. **The guarantee that
holds is that the companion has no publishing code path at all** — asserted in
the suite by 404ing every route anyone might reach for and by checking that
`blog.mjs` starts no processes whatsoever.

The environment variable is empty everywhere else, so council and review
sessions are byte-for-byte what they were.

### 7. Files

`blog.mjs` (new, ~700 lines: registration, mapping, census, the envelope
block — every function in it a READ), `server.mjs` (the blog children,
`chatFor`'s third answer, the blog census and `blog-files`, five endpoints:
`GET /blog-page`, `GET /blog-sites`, `POST /blog-site`, `POST /blog-root`),
`chat.mjs` (`denyBash`, the `blogContext` block in the envelope),
`core/cli_adapters.py` (`_plan_denied_commands`, env-gated and empty by
default), `extension/content.js` (`loadBlog`, `onBlogFiles`, the confirm
callback), `extension/drawer.js` (`setBlog`, the source card, the confirm
card), `extension/drawer.css`.

### 8. Testing

`test/blog.test.mjs` (new, 45) against a **synthetic** Jekyll repo in a temp
dir — the developer's real site is never read, never written and never bridged
against, and no git runs because there is no git to run. Front matter and
`_config.yml` parsing; every mapping rule including the permalink override, the
category template, both collection templates, the slug fallback, the ambiguous
slug, the unmappable url, `_site/` never being a source, and the index
rebuilding when a post is added or a permalink edited in place. Then the
companion end against the mock bridge: the unconfirmed refusal, a DECLINED repo
going back to being an ordinary web page, the write root being the repo, one
child per repo, no write root on an unmappable page, the
envelope's source path and rules, `blog-files` on a source edit, silence on a
`_site/` rebuild, a reload on a new image, collateral on the source — and the
whole of §6.

`test/harness.html?blog=1` (plus `?blog=unconfirmed`, `?blog=unmapped`), with
`&selftest=1`: 12/12, 9/9 and 5/5, headless. The poses already on HEAD are
unmoved by all of this — main 649/649, workspace 88/88, more 21/21, colledit
21/21 in the same sweep. The last two assertions of every
one of them are that there is no publish control anywhere on the drawer and
that nothing offers to put the site live.

`tests/test_cli_adapters.py` (+3): no deny rules by default, the deny rules a
list produces, and a value that is not a command name being ignored.

Full node sweep green (blog 45, companion 212, workspace 126, adapters 314,
pdf 186, …); `pytest tests/` 769 passed.

## Amendment (2026-08-29, shipped): suggest mode — the bots propose, the reader decides

A blog source page shipped this morning with the bots editing the markdown
directly. That is right for a manuscript under review and wrong for somebody's
published writing: the reader asks a question about a paragraph, and the answer
is that their draft has already been changed. The undo is a text editor.

On a blog page the bots now **propose**. A change arrives as a suggestion card
— the passage as it stands, the passage as it would read, and one line saying
why — and **nothing touches the file until the reader presses Accept**.

### 1. THIS IS A PORT, AND THAT IS THE POINT

`frontends/review` solved this in full for LaTeX papers, and the pipeline did
not cross when Discuss absorbed review-page commenting: the unified comment
store came over, the suggest/apply half did not. What follows is that half,
brought over rather than invented a second time.

| ported from `frontends/review` | how it arrives here |
|---|---|
| the card's fields (`SCHEMA.md`: `current_text` / `proposed_text`) | `current` / `proposed` / `why` on `msg.suggestions` |
| rendered as a del/ins diff | the drawer's own `wordDiff` + `.wasnow` markup, which track changes already used |
| accept = **unique-span replacement** in the source | `suggest.applyCard` |
| whitespace- and smart-quote-tolerant matching, true offsets for the replacement | `assets/span-match.js`, **imported, not copied** |
| ambiguous or drifted spans → `needs_manual_resolution`, never guessed | the card's `needs-manual` state, with the reason on its face |
| human suggestions go through the same apply path as a bot's | n/a here — a reader who wants to edit their own post has an editor open |

**The matcher is imported.** `suggest.mjs` does
`import SpanMatch from '../review/assets/span-match.js'`. It runs in node, in
the companion, so there is nothing to copy across the extension boundary and
none of the `normUrl` / `tagHue` duplication precedent applies. If a second
matcher ever appears beside this one, that is the bug — and `test/suggest.mjs`
carries the review engine's own edge cases (a wrapped passage matched by a
single-spaced needle, curly quotes folded to straight, two matches, none)
precisely so the two cannot drift apart quietly.

**What was deliberately NOT ported.** `apply.mjs` keeps a round ledger
(`state/apply.json`) because a review round ends in `git commit`, with
`git checkout` as the undo. A blog root has no git at all — that is the settled
promise of the previous amendment, held in `blog.KIND_RULES` — so there is no
round, nothing to commit and nothing to revert. A card's whole life is on the
card. `bib_entries` and `source_json` do not port either: a post has no
bibliography, and its front matter is markdown.

### 2. The block a bot writes

The fourth use of the established idiom — machinery inside a reply, lifted off
the words by the companion, drawn as something the reader answers. `strike:`
and `file-in:` are single lines because they carry one fact; a proposal carries
a whole passage twice over, so it is a **fenced block**, for the same reason
the question vault's card is:

```suggest
current: The mass saving is the whole argument and it is not a small one.
proposed: The mass saving is the whole argument, and it is not small.
why: the double negative reads as a hedge
```

- `current:` must appear **exactly once** in the source file. That is the whole
  apply rule. The envelope tells the bot what to do when it does not: widen the
  passage until it is unique.
- `current:` and `proposed:` may run over several lines; a key line closes the
  field before it. Line breaks and straight-versus-curly quotes do not matter
  (that is the matcher's job); every other character does.
- **A cut must be said**: `proposed: (delete)`. An empty `proposed:` is refused
  rather than guessed at — it is far more often a model losing its footing than
  a model meaning to remove a paragraph.
- **EVERY block in the reply counts**, and this is the one place the convention
  differs from the question vault's last-block-wins. A typo sweep is ten small
  proposals; they are not alternatives, they are the answer.

Capped at 30 cards a reply. A block that will not parse still comes off the
words and still becomes a card — a buttonless one saying what was wrong.
Refusing **visibly** is the rule the strike chip already established: a
proposal that vanishes silently is indistinguishable from one that landed, and
the bot's own next sentence would be the only account of it the reader had.

### 3. Accept, reject, accept-all

Three owner-only doors (`POST /suggest-accept`, `/suggest-reject`,
`/suggest-accept-all`). None of them carries a path: the companion resolves
which file this page renders from, so the most a request can ever ask for is
"the change proposed on this page".

**Accept** replaces the unique span and writes the file. Then the same census
the turn boundary takes is taken around the write and the same `blog-files`
event is broadcast — so jekyll rebuilds, the tab reloads, and tracked changes
on the page come free, because the file really did move.

**The refusals, which are the safety property.** A span that occurs zero times
(the source has drifted) or more than once (ambiguous) is refused: **nothing is
written**, the card goes to `needs-manual` with the reason on its face, and the
answer is a 200 rather than an error — the request was answered, and the answer
belongs on the card where the reader is looking. There is no third outcome and
no best-effort.

**Accept all** applies a sweep in **document order** — the reader watching the
post rebuild sees the changes arrive top to bottom — re-resolving each card
against a freshly read file, because every accepted edit moves every offset
after it. It **stops at the first refusal**, loudly: what already landed stays
landed, the card that stopped it says why, and the rest are still the reader's
to answer. A card that had no address in the document *to begin with* sorts
last rather than derailing nine changes the reader has already read and agreed
to; a card that **loses** its address mid-run — because an earlier accepted
edit took the passage it was sitting in — stops the run where it stands.

**Reject** writes nothing and is remembered ON THE RECORD, unlike the three
chips before it whose "no" is a per-tab dismissal. A turned-down proposal is
something the bot has to be told about.

**The card is the whole record.** Five states, no sixth: `open`, `applied`,
`rejected`, `needs-manual`, `unreadable`. `store.sanitizeCard` keeps exactly
the fields a card has, so a restored or hand-edited record cannot smuggle in a
fifth.

### 4. What the turn says, and what it is told back

`blog.blogBlock` no longer says "edit it". It still spells out the write scope,
because that is still true and still the sandbox's own boundary — but it is now
named as the **safety net rather than the route**, and the deny-git paragraph
is untouched. The one genuine write left is a **picture**: an image file cannot
be proposed as a passage of text, so images are still placed and edited
directly, while the markdown line that references a new one is proposed like
every other line.

`suggest.suggestBlock` rides every blog turn beside it, for the reason every
standing block does: a resumed session's replayed history is uneven, a bridge
restart drops it whole, and a model never shown a convention cannot use it.

And `suggest.verdictBlock` rides the next turn: what the reader accepted, what
they turned down, and what could not be placed. Same sentence-on-the-next-turn
rule as `store.strikeRefusedBlock` and `questions.reviseRefusedBlock`, same
reason — a bot with no news assumes the file changed and tells the reader so.
Only the LAST stack is reported, exactly as those two report only the last
suggestion.

### 5. Collateral does not run on a blog turn any more

The turn-end diff exists to catch an edit that landed with **no comment at it**.
In suggest mode nothing lands during a turn at all, so a diff has nothing to
narrate — and two things it could do instead are both wrong: report the
reader's own accepted changes back to them as if a bot had slipped them in, and
collapse a sweep the reader is halfway through into one `>6 regions` summary
note. **Suggestions are cards by construction, not regions found in a diff, and
they are never summary-collapsed.** `noteBlogTurnStart` marks the turn
`noCollateral` and `reportCollateral` returns at the door.

**The census stays**, and it is the guarantee §4 of the previous amendment
actually makes about a bot that writes anyway against its instructions: every
file that moved is counted, named and broadcast, and the tab reloads. Only the
auto-threads are gone.

### 6. Scope

- **Blog pages: suggest mode is the default and the only mode.** It is a
  property of the KIND (`blog.KIND_RULES` → `blog.suggestMode`), asked in one
  place, with no per-site override and no config key — the same shape as the
  git promise, and for the same reason: a config that rides the reader's
  nightly backup can move the path and cannot weaken the rule.
- **Review / LaTeX pages** keep their own engine, untouched.
- **Project and workspace artifact pages** keep direct editing. That is their
  SPEC contract — a project artifact is a file the council itself wrote, not
  the reader's published identity — and a per-page toggle between the two modes
  is **designed and not built**: the mode would have to be a property of the
  page kind (where it is now) rather than a switch, or the promise stops being
  a promise.
- **PDFs are untouched.** A strike suggestion is its own thing and stays that.

### 7. Files

`suggest.mjs` (new, ~330 lines: the grammar, the lift, the ported apply rule,
the two envelope blocks), `blog.mjs` (`KIND_RULES.suggest`, `suggestMode`,
`suggest_mode` on the wire, `blogBlock` rewritten), `server.mjs` (the lift in
`onChatEvent`, `suggestVerdict`, `suggestTargetOf`, `announceBlogWrite`, the
three endpoints, the collateral gate), `store.mjs` (`CARD_STATES`,
`sanitizeCard`, `findCardIn`, `setCardState`, `suggestions` through
`appendMsg`), `extension/drawer.js` (`suggestStackHtml`, `sgCardHtml`,
`sgDiffHtml`, `doSuggest`, three acts), `extension/content.js` (three
callbacks), `extension/drawer.css` (`.sgstack` and the four states).

### 8. Testing

`test/suggest.test.mjs` (new, 42). The grammar and the apply rule with no
server near them — every block counting, multi-line fields, the refused empty
`proposed:`, the review engine's four span cases, byte-precise replacement, a
refusal writing nothing, document order, the mid-run stop, and an edit that
shifts every offset after it. Then the companion end against a synthetic Jekyll
repo and the mock bridge: the lift, the block coming off the words, the file
untouched by the turn, accept/reject/needs-manual/accept-all end to end, the
`blog-files` reload, the verdict on the next turn, an ordinary web page
carrying no cards at all, and all three doors owner-only.

`test/blog.test.mjs` (45): the collateral assertion is inverted and says why —
the census still names every file that moved and still reloads the tab; only
the auto-threads are gone.

`test/harness.html?suggest=1` (17/17), `?suggest=states` (12/12),
`?suggest=sweep` (10/10), all headless. The blog poses are unmoved (12/12, 9/9,
5/5) and so is everything else — main 649/649, workspace 88/88, gdocs 83/83,
pdf-strike 81/81, question 21/21, more 21/21, colledit 21/21 in the same sweep.
Full node sweep green (suggest 42, blog 45, companion 212, workspace 126,
adapters 314, pdf 186, questions 89, …). `core/` is untouched, so `pytest` was
not re-run.

## Amendment (2026-08-29, shipped): one discussion, several changes — and a bot that can correct the highlight

Reported from a live session on the reader's manuscript, and it is two failures
in one screenshot. The reader had highlighted **"nflatable-arm"** — missing the
initial letter, stopping short of the words either side — and the thread
concluded that the phrase should read differently. The bot **refused to
suggest anything**: *"the highlight omitted part of the phrase, re-highlight the
full wording."* That is the clerical work this whole feature exists to abolish,
handed to the one person who should never be doing it. And underneath it, the
structural limit: one discussion routinely concludes that **two or three
separate places** must change, while a thread could only ever mint one card for
its own quote.

Two additions, and they are the same addition seen twice: a suggestion is no
longer bound to the reader's selection, in NUMBER or in SPAN.

### 1. A reply may carry several suggestions (`STRIKE_PER_REPLY_MAX = 3`)

`store.parseStrikeSuggestions` reads them all, in order, instead of taking the
last line and throwing the rest away. Each becomes its own chip; each confirmed
chip mints its own card; all of them link back to the same discussion through
`from_thread`, exactly as one did.

Three per reply — the reader's number. Enough for "the phrase, the citation and
the sentence after it"; few enough that a reply is not a wall of buttons. It is
per REPLY, not per conversation: a later answer may carry three more. A fourth
line in one reply is not dropped, it is **refused out loud** (`rejected:
'capped'`, a buttonless chip, and the bot told on its next turn) — the rule the
2026-08-27 amendment settled: a suggestion that vanished is indistinguishable
from one never made.

**Two `strike:` lines about the same passage are still one mark.** That is not a
cap, it is arithmetic: they are two opinions about one span (the two-bots case,
which is unchanged), and the door dedupes them onto one red line. Several
suggestions therefore MEAN several passages, and the offer says so.

**On the record.** The message carries `strikes: [ … ]`; `strike` stays exactly
what it was on every reply already written, and `store.strikesOf(msg)` is the
only thing that asks which shape a message is in. Nothing on disk migrates. A
minted card gains `from_idx` — which suggestion IN that reply — because
`from_msg` alone stopped being precise enough the moment a reply could carry
three.

**The brood, in the drawer.** The parent card carries the link its children
already carried backwards: *"struck through here — 3 changes · 1 · 2 · 3"*,
each number a jump to that card, in document order. Derived from `from_thread`
(`store.broodOf`), never stored: nothing to keep in step, nothing to repair when
a card is deleted, and a card that changes parents is in one brood and out of
the other by construction.

### 2. A child has one parent, and may be RE-ADOPTED

Editing a long draft surfaces inconsistencies late. A discussion on page 9
concludes that the mark decided in a discussion on page 3 now needs different
words — and that later conversation is legitimately the one standing behind the
note. So `from_thread` **moves**: the old brood drops the card, the new brood
gains it, both view links follow, and `store.adoptStrike` pushes the previous
parent onto `prior_threads` (oldest first, capped at `PRIOR_THREADS_MAX = 8`) so
the move is a record rather than an erasure. Soft ids, like `from_thread`
itself — every one of them may dangle.

Adoption happens on the ordinary confirm path and is reported as `adopted: true`
beside `updated`. It also makes a same-note confirm **not** a no-op: a click
that only moves the parent still writes, because something moved.

**Which card a confirm is about**, amended once more. It was the link
(`from_thread`) first and the quote second. The link is now the CHIP's link —
thread + `from_msg` + `from_idx`, which is "the card this very chip made" — and
the quote match does the work one rung out: a different chip, the other bot, a
different discussion, all landing on the same span. The chip link still beats
the quote after an anchor has drifted, which is the case the ordering exists
for.

### 3. `passage:` — the bot names its own span

A suggestion may put a line of its own DIRECTLY ABOVE its `strike:` line:

```
passage: The inflatable-arm literature
strike:  replace with: "Work on inflatable arms is thin."
```

It binds FORWARD (a heading over the change it introduces, which is the order a
model writes it in anyway, and a stray one then aims at nothing rather than
silently re-aiming the suggestion above it). Both lines come off the reply's
words; both are machinery.

**`store.resolvePassage` is the check**, and it is strict, because the mark it
authorises is drawn in the READER'S name on a file they hand to a co-author:

| fault | what it means |
|---|---|
| `unlocatable` | not in the page's snapshot text — or there is no snapshot, because a span this companion cannot locate is one it must not anchor |
| `offpage` | found in the document, but not on the thread's page |
| `ambiguous` | found more than once on the page: it names neither |
| `covered` | it runs across PART of another mark already on this page |

A clean answer comes back as an anchor — the quote plus 32 characters of the
page's own context each side, the same shape the extension computes for a
hand-drawn highlight. The confirm anchors THERE. **The reader never re-highlights
anything.** Checked at the lift (so a bad wording never becomes a button) and
again at the door (so a client's word is never taken for where a mark may go).

**Disjoint is allowed, and that was the decision to make.** The passage must sit
on the thread's page; it need not touch the thread's quote. The alternative —
overlap required for the first child, disjoint only for explicitly-additional
ones — was rejected on two grounds. It makes the state of the record decide what
grammar means (the same line is legal or illegal depending on what has already
been minted, which is unexplainable to a model and untestable in isolation), and
it makes the promise of §1 unkeepable: "one discussion, several changes" is
about several PLACES, and a rule that every passage must touch the highlight
leaves only nested variants of one span.

What makes disjoint safe is not overlap, it is **consent plus a mechanical
floor**. The chip shows the exact wording — struck through, which is what the
button will do to it — before it is pressed, and nothing is marked up until the
reader presses it; that is the same rule the whole feature rests on. And
`covered` is the floor consent cannot supply: a mark landing half-across
somebody else's is refused whatever anyone clicks. Landing on exactly the same
span is not covering it — that is the adoption path of §2, and the door handles
it.

That `covered` check is also the first MECHANICAL enforcement of the span
discipline of 2026-08-26. Until now the companion could only tell a bot to keep
its hands off a neighbour's text; a named passage is a span it can actually
measure.

### 4. The wording, reconciled

`SPAN_DISCIPLINE` (chat.mjs) said "never change a word outside the quote", which
is what taught bots to send the reader away to re-highlight. It now names the
one sanctioned way past the fence — a `passage:` line on a strike suggestion,
where the turn has invited one, because it says the words out loud and the
reader sees them before anything happens — and keeps the prohibition where it
belongs: **silent widening**, a rewording that quietly swallows text the quote
did not contain. `strikeOfferBlock` and `bridge-system-prompt.md` rule 13 carry
the same two paragraphs: several changes are allowed, and *never ask the reader
to go back and re-highlight*.

### 5. Everything downstream was already right

A child is an ordinary strike thread. `pdf/viewer.js collectItems` writes one
`/StrikeOut` per placed thread and has never had a one-per-quote assumption in
it; `export.mjs` renders `~~quote~~` per thread. Several children per parent
therefore need nothing from the export at all, which the tests now pin rather
than assume. `from_thread`, `from_idx`, `prior_threads` and `passage_named` are
provenance and **nothing in either export has heard of any of them** — what the
co-author receives is still a red line, a human's name and one note.

### Files

```
store.mjs                       STRIKE_PER_REPLY_MAX / STRIKE_ENTRY_MAX /
                                PASSAGE_MARK / PASSAGE_MIN; parseStrikeSuggestions
                                (parseStrikeSuggestion is now its last hit);
                                strikesOf; resolvePassage; broodOf; adoptStrike /
                                PRIOR_THREADS_MAX; strikeFaultWhy and the six
                                faults; strikeOfferBlock rewritten; addThread
                                takes from_idx / passage_named; appendMsg keeps
                                `strikes`
server.mjs                      the lift reads every suggestion, caps at three
                                and resolves each `passage:`; refusedStrikeNote
                                reads the list; /strike-from takes `passage` and
                                `from_idx`, matches chip-first, adopts, and mints
                                after the last child
chat.mjs                        SPAN_DISCIPLINE names the sanctioned way out
extension/drawer.js             strikeChipHtml maps the list; oneStrikeChipHtml;
                                the four new refusals; `.fcpassage`; broodHtml on
                                open and resolved cards; doStrikeFrom keyed by
                                ts#idx; per-chip decline
extension/content.js            onStrikeFrom passes from_idx and passage
extension/drawer.css            .fromdisc.brood, .broodsep, .strikechip .fcpassage
bridge-system-prompt.md         rule 13 — several changes, and `passage:`
```

**Testing.** `test/strike.test.mjs` (57 → 73). Pure: the multi-block parse with
its forward-binding `passage:` and its orphan line, `strikesOf` over both record
shapes, the offer teaching both new things, the span rule naming the sanctioned
route, and every fault's sentence. End to end against the mock bridge and a real
snapshot: **the reported case** — a `nflatable-arm` highlight, a `passage:`
naming the full phrase, and a mint anchored on `The inflatable-arm literature`
with the page's own prefix and suffix, the discussion's own quote untouched;
three suggestions in one reply becoming three cards under one parent with
`from_idx` 0/1/2; a fourth refused as `capped` and the bot told; the four
passage faults refused at the door and `covered` refused at the lift as well;
re-adoption moving `from_thread`, keeping `prior_threads`, and updating both
broods; a mark that never moved carrying no lineage key at all; and the Obsidian
export rendering all three children without being asked to.

Harness `?pdf=1&strike=1&selftest=1` (81 → 92): a codex reply carrying TWO
suggestions, each naming its own passage; both chips live (a second place is a
second change, never a rival); each showing its wording, struck through, before
the click; both confirmed, two more cards minted, and the discussion's brood
line reading "3 changes" with three numbered jumps. Full node sweep and harness
sweep green.

#### Known limits (deliberate)

- **A `passage:` on a page with no snapshot cannot be taken.** The companion
  refuses rather than guesses. On a PDF the snapshot is written by the viewer,
  so this bites only on a record made before the page was ever rendered.
- **Adoption is by the confirm, never automatic.** A card whose parent is
  deleted keeps a dangling `from_thread` and stands alone, exactly as before;
  nothing hunts for a new parent for it.
- **`prior_threads` is a trace, not a history.** It holds ids, not what was said,
  and it is capped — a card passed back and forth many times keeps the last
  eight hands.

## Out of scope for v1 (do not build)

Firefox packaging, hosted/multi-user mode, settings UI, annotation sharing.
(SPA navigation was on this list and is now handled — see the 2026-08-24
amendment; what stays out of scope is a mutation observer over the ARTICLE, not
knowing which article one is.)
