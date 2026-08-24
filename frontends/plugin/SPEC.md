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
  bridge-system-prompt.md  ← bot role file              (companion agent)
  test/
    companion.test.mjs     ← endpoint tests w/ mock bridge (companion agent)
    collateral.test.mjs    ← the collateral-edit diff, dedupe and caps (companion agent)
    workspace.test.mjs     ← project artifact pages, end to end (companion agent)
    fixtures/article.html  ← sample static article, served at /test-page (companion agent)
    harness.html           ← loads extension JS with chrome-API + companion mocks for visual QA (extension agent)
    anchor.test.mjs        ← anchoring unit tests        (extension agent)
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
- One turn in flight, FIFO queue across pages. `{"type":"ready"}` is the turn boundary
  (note: one startup `ready` arrives before any turn).
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
  `wait: 'bridge_starting' | 'busy'` (absent once the turn is genuinely
  running), which rides POST /thread and /reply beside `queued`/`position`. The
  drawer renders "waking the agents…" / "queued behind another chat…" /
  "queued (#N)", each with the same ◐ every other live state uses — a wait must
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

## Out of scope for v1 (do not build)

Firefox packaging, hosted/multi-user mode, settings UI, annotation sharing.
(SPA navigation was on this list and is now handled — see the 2026-08-24
amendment; what stays out of scope is a mutation observer over the ARTICLE, not
knowing which article one is.)
