# Botference Web Annotator — build contract

Browser extension (Chromium MV3, Brave-first) + local companion server. Highlight text on
static article pages, comment on it, @-mention bots for inline replies, export everything
to Obsidian. Bot conversations persist as botference sessions under project "Plugin pages".

This file is the interface contract between `extension/` and the companion server.
Both sides code against it. Do not change shapes unilaterally — the contract owner
(the managing agent) arbitrates.

## Product behavior (settled with the user — do not redesign)

- **One interface, no modes.** Highlight → floating 💬 button → comment box → save.
  An `@claude` / `@codex` / `@all` mention anywhere in a message is the only signal that
  summons bots. Mentions work in *any* message, including later replies in an existing
  thread (a personal thread becomes a bot chat the moment a reply tags a bot).
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
  export.mjs               ← Obsidian export            (companion agent)
  bridge-system-prompt.md  ← bot role file              (companion agent)
  test/
    companion.test.mjs     ← endpoint tests w/ mock bridge (companion agent)
    fixtures/article.html  ← sample static article, served at /test-page (companion agent)
    harness.html           ← loads extension JS with chrome-API + companion mocks for visual QA (extension agent)
    anchor.test.mjs        ← anchoring unit tests        (extension agent)
  extension/               ← the whole MV3 extension     (extension agent owns)
    manifest.json
    background.js          ← service worker: owns WS to companion, all fetches, tab broadcast
    content.js             ← selection UX, highlight painting, drawer host
    anchor.js              ← quote+context anchoring (adapt frontends/review/assets/span-match.js)
    drawer.js  drawer.css  ← the drawer UI (shadow DOM)
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
  "created_at": "ISO", "updated_at": "ISO",
  "session_id": null,                     // botference sid once bots joined
  "threads": [                            // anchored comment threads, page order maintained on insert
    { "id": "t-<ts>-<rand4>",
      "quote": "exact selected text",
      "prefix": "≤32 chars before", "suffix": "≤32 chars after",
      "orphaned": false,
      "msgs": [ { "author": "angadh"|"claude"|"codex", "ts": "ISO", "text": "…" } ] }
  ],
  "page_chat": [ { "author": "…", "ts": "ISO", "text": "…" } ] }
```

- `<ROOT>/.botference/plugin/index.json`: `{ "<pageKey>": {"url","title","threads":N,"updated_at"} }`
  (for the extension's "which pages have annotations" check).
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
| POST | `/thread` | `{url, quote, prefix, suffix, msg:{text}}` | creates thread + first msg (server stamps id/author/ts) → `{ok, thread, queued?}` |
| POST | `/reply` | `{url, thread_id, text}` (`thread_id:"__page__"` = page chat) | appends msg → `{ok, msg, queued?, position?}` |
| POST | `/edit` | `{url, thread_id, ts, text}` | edits own (author=config.author) msg |
| POST | `/delete` | `{url, thread_id, ts?}` | ts absent → whole thread; present → one msg |
| POST | `/orphan` | `{url, thread_id, orphaned:bool}` | extension reports anchor status |
| POST | `/export` | `{url}` | writes Obsidian note → `{ok, path}` |
| POST | `/interrupt` | `{url}` | forwards interrupt to bridge if that page's turn is running |
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
- Launcher: `botference plugin --install-autostart` / `--uninstall-autostart` (macOS
  LaunchAgent `com.botference.plugin-web`, KeepAlive SuccessfulExit=false, hand-run
  instance wins the lock; launchd takes over ~10s after it exits).

## Out of scope for v1 (do not build)

Firefox packaging, hosted/multi-user mode, resolve/archive states in the drawer,
settings UI, SPA mutation observers, annotation sharing.
