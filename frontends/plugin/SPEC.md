# Botference Discuss (the web annotator) — build contract

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
  run.mjs                  ← running a python code block (companion agent)
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
  "threads": [                            // anchored comment threads, page order maintained on insert
    { "id": "t-<ts>-<rand4>",
      "quote": "exact selected text",
      "prefix": "≤32 chars before", "suffix": "≤32 chars after",
      "orphaned": false,
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

- API keys (`keys.mjs`). Per-agent auth for the CLIs the bridge spawns, since
  both already read a key from the environment. Stored in
  `~/.botference/discuss-keys.json` (0600, mtime-watched like grants.json) as
  `{keys:{claude,codex}, modes:{claude,codex}}`. Modes are `auto` (default —
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

## Out of scope for v1 (do not build)

Firefox packaging, hosted/multi-user mode, resolve/archive states in the drawer,
settings UI, SPA mutation observers, annotation sharing.
