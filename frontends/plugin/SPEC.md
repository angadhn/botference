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
| POST | `/thread` | `{url, quote, prefix, suffix, msg:{text}}` | creates thread + first msg (server stamps id/author/ts) → `{ok, thread, queued?, position?, wait?}` |
| POST | `/reply` | `{url, thread_id, text}` (`thread_id:"__page__"` = page chat) | appends msg → `{ok, msg, queued?, position?, wait?}` (`wait`: `bridge_starting`\|`busy`) |
| POST | `/edit` | `{url, thread_id, ts, text}` | edits own (author=config.author) msg |
| POST | `/delete` | `{url, thread_id, ts?}` | ts absent → whole thread; present → one msg |
| POST | `/orphan` | `{url, thread_id, orphaned:bool}` | extension reports anchor status |
| POST | `/export` | `{url, mode?}` (`mode`: `all` (default) \| `comments`) | writes Obsidian note → `{ok, path, mode}` |
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

## Out of scope for v1 (do not build)

Firefox packaging, hosted/multi-user mode, resolve/archive states in the drawer,
settings UI, SPA mutation observers, annotation sharing.
