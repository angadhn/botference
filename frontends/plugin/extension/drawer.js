// drawer.js — the right-side annotation drawer, entirely inside a shadow root.
//
// Nothing in here talks to the network or the DOM of the page; content.js owns
// both and hands this file (a) page records to render and (b) callbacks to call.
// Everything visual lives in drawer.css, linked into the shadow root — so page
// CSS cannot reach in and drawer CSS cannot leak out.
//
// Exposed as window.BFPDrawer (classic script, isolated content-script world).
//
//   const d = BFPDrawer.create({ hostname, cssUrl, katexCssUrl, theme,
//                                capabilities, on… });
//   d.mount(); d.setPage(record); d.open('comments');
//
// `d.setAuthor(handle)` tells the drawer who the READER is on this companion.
// It matters now that a page's messages can come from any number of handles (a
// shared companion): "my message" — the one with the ✎ on it — is the one whose
// author matches this, and every other handle simply gets its own colour.
//
// `capabilities` is what content.js's site adapter says this page can do
// (default {highlights:true}). With {highlights:false} — Google Docs, whose
// text is painted to a canvas — the drawer opens on Page chat whatever the
// per-site memory says, and the Comments tab stays visible but inert.
//
// `reviewHost` ({hosts, pageOwns}) is the other, narrower switch: a page that
// carries the review engine's OWN commenting UI (content.js's marker). Two
// selection UIs must never fight over one drag, so exactly one of them is
// live — and with the plugin installed the DEFAULT is ours: Discuss keeps the
// margin and content.js puts the page's own selection pill away. The Comments
// tab says so in one quiet line and offers the reader the other choice ("use
// the page's own commenting" → `onPageComments(true)`), which content.js
// persists per page and hands back through `setReviewHost`. With `pageOwns`
// set, Discuss stands down instead: no pill, no new threads — and nothing else
// changes, because Page chat, the archive, the tasks card, send-review and
// every thread already on the page carry on either way.
//
// Callbacks (all optional, all may return a Promise):
// Sending is OPTIMISTIC: the message appears in its thread and the composer
// empties before onSave/onReply is even called (they are slow — they re-read
// the page and may attach a document). Both may answer:
//   {ok:true, queued, position,   normal; the bots were summoned or not.
//    wait}                        `wait` is WHY nothing has started yet —
//                                 'bridge_starting' (the agents are being
//                                 woken), 'busy' (this conversation's own
//                                 previous turn still has the floor) or
//                                 'pool_busy' (every agent is on somebody
//                                 else's page) — and decides the words on the
//                                 spinning wait line. Absent = under way.
//   {ok:true, reason:'…'}         saved, but the bots will NOT run for this
//                                 sender (a guest, or --no-agents) — shown at
//                                 the composer, nothing rolled back
//   {ok:true, deduped:true}       the companion already had this message; the
//                                 caller must have reconciled it idempotently
//   {ok:false, error:'…'}         the pending message stays on screen with a
//                                 retry and a discard
//
//   onSave({quote,prefix,suffix,text,route})  new anchored thread committed
//   onCancelNew()                       the pending new-thread card dismissed
//   onReply(threadId, text, route)      threadId '__page__' = page chat
//     `route` (threads only) is the composer pill: 'none'|'claude'|'codex'|
//     'all' — who this message is for when its words tag nobody
//   onEdit(threadId, ts, text)
//   onDelete(threadId, ts|null)         null ts = delete the whole thread
//   onResolve(threadId, resolved)       file a thread / put it back →
//                                       {ok, thread, summarizing}
//   onNotDone(threadId)                 the reader disagreeing that a thread
//                                       is handled: out of "Ready for review"
//                                       and back into the open list → {ok,
//                                       thread}. There is no onAddressed:
//                                       marking a thread ready is what a bot's
//                                       reply landing in it does, server-side,
//                                       and is never a click.
//   onSummarize(threadId)               ask the agents to write a filed
//                                       thread's paragraph again → {ok}
//   onTick(threadId, ts, index, checked) a checkbox in a bot's markdown
//                                        checklist was clicked; index is its
//                                        0-based ordinal in that message
//                                        → {ok, text}   (POST /tick) — `text`
//                                        is the message's authoritative new
//                                        body and replaces the optimistic tick
//   onRun(target, ts, author, block)    a ```python block's Run button was
//                                        pressed; `block` is its 0-based
//                                        ordinal among the fenced blocks of
//                                        that message → {ok, run:{…}} (POST
//                                        /run). Nothing executable is sent —
//                                        the companion takes the code out of
//                                        the message it already holds.
//   onRunCancel(target, ts, author, block) stop that run  (POST /run-cancel)
//   onRunFigure(target, run_id, name)   → {ok, data_url}  (GET /run-figure) —
//                                        a figure is owner-only, so its bytes
//                                        come through the background worker
//                                        rather than as an <img src>
//   onExport(mode)                      → {ok, path} to show in the footbar
//                                         mode: 'all' | 'comments'
//   onPages()                           → {ok, index:{pageKey:{url,title,threads,
//                                         has_session,kind,tags,updated_at}}}
//                                         (GET /index) — `kind` is what sort of
//                                         document it is (article|pdf|gdocs) and
//                                         `tags` what the reader filed it under;
//                                         both are what the list filters by
//   onRenamePage(url, title)            → {ok, title}   (POST /rename-page) —
//                                         owner only; '' puts the page's own
//                                         name back
//   onTagPage(url, tags)                → {ok, tags}     (POST /tag-page) —
//                                         owner only; the companion normalises
//   onOpenPage(url)                     → {ok}  open/focus a tab at that page
//   onLibrary()                         → {ok, page|null}   the library record
//                                         (GET /page on the reserved url).
//                                         page:null = nothing said in it yet
//   onLibraryReply(text)                → same answers as onReply — it IS a
//                                         reply, on a page nobody is standing
//                                         on, so the url travels instead of
//                                         being assumed
//   onExportPage(url, mode)             → {ok, path}   (POST /export {url, mode})
//   onDeletePage(url)                   → {ok, session_deleted, current}
//                                         (POST /delete-page) — `current` says
//                                         the deleted page is the one we are on
//   onInterrupt()
//   onJump(threadId)                    quote clicked: scroll page to highlight
//   onFocus(threadId|null)              card focused/blurred: tint the highlight
//   onModels()                          → {ok, current, options, status, bridge,
//                                            effort, verbosity, keys}    (GET /models)
//                                         keys: {claude:'set'|'unset', codex:…,
//                                         modes:{…}} — status, never key material
//   onSetModel(agent, model)            → {ok, queued}                    (POST /model)
//   onSetEffort(agent, level)           → {ok, queued} | {ok:false,error} (POST /effort)
//   onSetKeyMode(agent, mode)           → {ok, applies} | {ok:false,error}  (POST /key-mode)
//   onOpenOptions(agent|null)           → {ok}  open the extension's OWN options
//                                         page, optionally asking it to focus one
//                                         agent's key field. The only key
//                                         affordance the drawer has: a key is
//                                         never typed in here (see SPEC.md — this
//                                         panel renders inside the page you are
//                                         reading, and its DOM is that page's)
//   onSetVerbosity(level)               → {ok, queued} | {ok:false,error} (POST /verbosity)
//                                         level: 'short'|'long'
//   onRelay(agent)                      → {ok, queued} | {ok:false,error} (POST /relay)
//                                         agent: 'claude'|'codex'|'both'
//   onConfirmRoot(confirm)              the one-time "is <root> your council?"
//                                        answer  (POST /council-root) — a NO is
//                                        kept as firmly as a yes
//   onProjectSessions()                 → {ok, sessions:[{session_id,title,
//                                          updated_at,entry_count}], current}
//                                        (GET /project-sessions) — the chats
//                                        this project already has
//   onOpenSession(sid|null)             → {ok, session_id}  (POST /project-chat)
//                                        stand this page in that chat; null
//                                        starts a fresh one
//   onSendReview()                      → {ok, sent, omitted, total, queued,
//                                          threads:[id], reason}
//                                          | {ok:false, error}
//                                        (POST /send-review) — hand every OPEN
//                                        comment thread on this page to the
//                                        bots as a ROUND: one preamble turn in
//                                        page chat, then one turn per thread,
//                                        each answered IN that thread. `queued`
//                                        counts the turns; `threads` names the
//                                        ones with a turn coming. The companion
//                                        writes every word of it; nothing is
//                                        resolved by it
//   onClose() / onReconnect() / onSelect()
//
// `project` (and `d.setProject(p)`) is the council project behind a PROJECT
// ARTIFACT page — a local file the reader's own council wrote, opened as a
// file: url (workspace.mjs). Null everywhere else, and where it is null
// nothing about this drawer changes. Where it is set:
//   · the header carries a second line, "part of project <name>"
//   · Page chat becomes that PROJECT's chat archive rather than one
//     conversation about one document: a bar naming the chat this page is
//     standing in, the project's other chats behind it, and "+ new"
//   · until `project.confirmed`, the tab holds the confirmation question and
//     nothing else — no bridge is spawned against a folder nobody vouched for
// Opening a past chat is a companion-side move of the page's `session_id`,
// so what renders under the bar is an ordinary page record with an ordinary
// `page_chat` — the fold, the composer and the streaming are untouched.
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const isBot = a => /^(claude|codex)/i.test(String(a || '').trim());
  // which bot an author name is, or '' for a person. The class it returns is
  // what the per-agent type treatment hangs off (drawer.css --font-claude /
  // --font-codex), so colour and typeface are decided by the same rule.
  function agentOf(name) {
    const a = String(name || '').toLowerCase().trim();
    return a.startsWith('claude') ? 'claude' : a.startsWith('codex') ? 'codex' : '';
  }
  // per-author identity, same rule as the review UI: bots get theme colors,
  // humans a deterministic muted hue from their handle
  function authorColor(name) {
    const a = String(name || '').toLowerCase().trim();
    const bot = agentOf(a);
    if (bot) return 'var(--' + bot + ')';
    let h = 5381;
    for (let i = 0; i < a.length; i++) h = ((h << 5) + h + a.charCodeAt(i)) >>> 0;
    return 'oklch(var(--author-l, 0.52) 0.09 ' + (h % 360) + ')';
  }
  function when(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  const HINT = '@claude, @codex or @all to bring in the bots';
  // …except on a project artifact's page chat, which IS a council chat: the
  // council's own rule is that plain text goes to the room, and the companion
  // routes an untagged message there (server.mjs untaggedGoesToAll). The line
  // has to say so, or the reader types a sentence expecting a note and gets
  // two bots. Threads on the same page keep the ordinary rule and the ordinary
  // hint — the difference is real, so it is stated where it applies.
  const COUNCIL_HINT = 'plain text goes to @all — or tag one bot';
  // THE PILL ROW, and the rule it draws.
  //
  // A thread is a conversation with somebody: once the reader has tagged a bot
  // in one, the next message is almost always for the same bot — and having to
  // retype "@claude" every turn (or watch the turn become a note to self when
  // they forget) is the single most-complained-about thing about threads. So a
  // thread remembers its address, the pills SAY what it is, and clicking one
  // changes it without typing.
  //
  // `none` is a first-class pill and not an absence: a note under a passage you
  // have been discussing is a real thing to want, and it is how the reader
  // steps out of a conversation. It is also the default of a thread nobody has
  // ever addressed, which is Discuss's original rule, unmoved.
  //
  // Threads only. Page chat's routing is a different rule with a different
  // reason (server.mjs untaggedGoesToAll) and two pill rows disagreeing about
  // what plain text means would be worse than no pills at all.
  const ROUTE_LABEL = { none: 'Note', all: 'All' };
  const routeLabel = h => ROUTE_LABEL[h] || (h.charAt(0).toUpperCase() + h.slice(1));
  const ROUTE_TIP = {
    none: 'a note in this thread — no bot is summoned',
    all: 'both bots answer this thread',
  };
  const routeTip = h => ROUTE_TIP[h] || `@${h} answers this thread — and untagged replies keep going to @${h}`;
  // ⧉ is the same overlap glyph the council's copy button draws as an SVG.
  // A glyph and not a word: the drawer's message controls are a 24px row in
  // the corner of a 420px column, and "copy" would not fit beside ✎ and ✕.
  const COPY_GLYPH = '⧉';
  const COPY_TIP = 'copy this message';
  const COPY_FAIL = 'this browser would not let the drawer copy';
  const COPY_HOLD = 1400;      // how long the button says so
  const PAGE_TARGET = '__page__';
  // The library — one conversation about everything the reader has annotated,
  // as opposed to one page. On the wire it is an ordinary page chat on a page
  // nobody visits (`bfp://library`, the companion's store.mjs owns the
  // definition; this is the same literal, duplicated as normUrl is). In HERE it
  // needs a target of its own, because every map is keyed by target and
  // '__page__' already means the page you are standing on.
  const LIBRARY_URL = 'bfp://library';
  const LIBRARY_TARGET = '__library__';
  const isLibraryUrl = u => String(u || '') === LIBRARY_URL;
  const TAB_KEY = 'bfp:lastTab';
  const WIDTH_KEY = 'bfp:width';
  const EXPORT_KEY = 'bfp:exportMode';
  // which slice of the archive the pages list is showing — the same
  // one-key-in-extension-storage idiom as the tab, the width and the export
  // mode. A reader who filters to their PDFs is usually still after their PDFs
  // the next time they open the list.
  const FILTER_KEY = 'bfp:pageFilter';
  // The kinds of document a record can be, in the order the chips are drawn.
  // The companion decides a page's kind (its adapter declares it); the drawer
  // only names them.
  const KINDS = [['article', 'Articles'], ['pdf', 'PDFs'], ['gdocs', 'Docs']];
  const KIND_NAME = { article: 'article', pdf: 'PDF', gdocs: 'Doc' };
  const kindOfRow = p => (KIND_NAME[p && p.kind] ? p.kind : 'article');
  const tagsOfRow = p => (Array.isArray(p && p.tags) ? p.tags : []);
  const TAGS_MAX = 12, TAG_MAX = 40;

  // A tag's color IS its name: FNV-1a over the lowercased name → a hue,
  // 0..359. No picker, no persistence, and the same tag wears the same color
  // on every surface — the saturation and lightness are the theme's
  // (drawer.css --tag-*-l), so the hue is the only thing computed here.
  // Duplicated in views.mjs for the phone (the extension/server boundary,
  // exactly as normUrl is duplicated): the two must agree or one tag is two
  // colors. Case-insensitive because normalizeTags dedupes case-insensitively.
  function tagHue(name) {
    const s = String(name == null ? '' : name).trim().toLowerCase();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % 360;
  }
  const W_DEFAULT = 420, W_MIN = 320, W_MAX = 720;

  // The drawer pushes the page aside rather than covering it, so the width has
  // to be clamped against the viewport: never below W_MIN, never more than half
  // the window (and never past W_MAX). On a window narrower than 2×W_MIN the
  // floor wins and we go back to overlapping — better than a 140px drawer.
  function clampWidth(w) {
    const half = (typeof window !== 'undefined' ? window.innerWidth : 1200) / 2;
    const hi = Math.max(W_MIN, Math.min(W_MAX, Math.floor(half)));
    return Math.max(W_MIN, Math.min(Math.round(w) || W_DEFAULT, hi));
  }

  // ── markdown, for every message ────────────────────────────────────────
  // Bot output is untrusted text; so, for these purposes, is the user's own
  // (another person's, on a shared companion). Every node below is built with
  // createElement and textContent — there is no HTML string anywhere on this
  // path, so markup inside a message can never become markup on the page.
  // Deliberately tiny: fenced code, `- `/`1. ` lists, `- [ ]` checkboxes,
  // #-headings, blank-line paragraphs, [text](http…), bare http(s) urls,
  // **bold**, *italic*, `code`. Anything else stays literal.
  //
  // What is STORED is always the raw text. This is a rendering, and the editor
  // reads the record (findMsg) rather than reading a rendering back.
  const SAFE_URL = /^https?:\/\//i;
  const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
  // Any indent, not the usual ≤3: the companion counts a message's checkboxes
  // with the same line-anchored rule, and a nested "    - [ ] …" it counted but
  // this renderer treated as prose would put every later tick on the WRONG box.
  // (Nested lists flatten as a result — the drawer is a 420px column and never
  // drew the second level anyway.)
  const BULLET = /^[ \t]*[-*+]\s+(.*)$/;
  const NUMBER = /^[ \t]*(\d{1,9})[.)]\s+(.*)$/;
  // "- [ ] thing" / "* [x] thing" / "1. [ ] thing" — a real checkbox, not a
  // picture of one. The state lives in the message TEXT (the companion rewrites
  // the brackets), so a refetched thread renders the same ticks with no client
  // state at all.
  const TASK = /^\[([ xX])\]\s+(.*)$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  // one alternation, tried left to right: code spans win over emphasis, so
  // `**not bold**` inside backticks stays literal. The bare url comes LAST and
  // is only ever reached at a position no other rule claimed — the leftmost
  // match wins, so `[text](http…)` and a url inside backticks are both handled
  // by the rule above it and never autolinked twice.
  const INLINE = /(`+)([\s\S]*?)\1|\[([^\]\n]*)\]\(\s*([^()\s]+)\s*\)|\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*|(https?:\/\/[^\s`<>*]+)/;
  // sentence punctuation is not part of the url: "see https://x.example/a." —
  // the full stop belongs to the sentence, and a pasted url in brackets keeps
  // its brackets outside the link
  const URL_TAIL = /[.,;:!?'"\)\]\}]+$/;

  const mk = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };

  // ── TeX math, for every message ────────────────────────────────────────
  // Math is cut out of the source BEFORE the markdown parser ever sees it.
  // It has to be: `x_1` is a subscript to TeX and an unclosed emphasis to
  // markdown, `\\` is a line break to TeX and nothing to markdown, and a
  // `*` inside \times would come back italicised. So scanMath() finds the
  // spans, protectMath() swaps each one for a placeholder no markdown rule
  // can match, markdown runs on the holed-out text, and substituteMath()
  // puts the RENDERED formula back where the placeholder landed.
  //
  // Delimiters: $…$ and \(…\) inline, $$…$$ and \[…\] display. Rendering is
  // KaTeX (vendored, extension/vendor/katex — no network, ever); with KaTeX
  // absent or the TeX invalid the span degrades to its own source text, so a
  // bad formula costs you a formula and never the message around it.
  //
  // A multi-line $$…$$ collapses to a one-line placeholder, so the drawer and
  // the companion could in principle disagree about a checkbox's ordinal — but
  // only if a line inside the TeX began with "- [ ] ", which is not something
  // valid maths can contain. Not worth padding the placeholder for.
  //
  // The placeholder is NUL-delimited because NUL is the one character that
  // cannot survive a keyboard, a bot, or the companion's JSON — and because
  // no rule in this file (FENCE/BULLET/NUMBER/HEADING/TASK/INLINE) can match
  // it, a placeholder passes through the parser as inert text.
  const MATH_TOKEN = /\u0000(\d+)\u0000/;
  const MATH_TOKEN_G = /\u0000(\d+)\u0000/g;
  // a line that is nothing but one display placeholder — it becomes a block of
  // its own rather than a lump inside a paragraph
  const MATH_BLOCK = /^\s*\u0000(\d+)\u0000\s*$/;

  // how many of `ch` in a row start at i
  function runLen(s, i, ch) {
    let n = 0;
    while (s[i + n] === ch) n++;
    return n;
  }
  // the next run of EXACTLY `want` copies of `ch` at or after `from`
  function findRun(s, from, ch, want) {
    for (let i = s.indexOf(ch, from); i >= 0; i = s.indexOf(ch, i)) {
      const n = runLen(s, i, ch);
      if (n === want) return i;
      i += n;
    }
    return -1;
  }
  // a single $ never reaches past its own paragraph: an opening $ with no
  // partner would otherwise swallow everything down to the next dollar sign
  // three paragraphs later
  function paraEnd(s, from) {
    const m = /\n[ \t]*\n/.exec(s.slice(from));
    return m ? from + m.index : s.length;
  }

  // Where a $…$ actually closes, or -1. Only the FIRST dollar after the opener
  // is ever considered: if that one is not a closer the whole candidate is
  // abandoned, rather than reaching past it for a later dollar. That is what
  // keeps "the $5 fee scales as $n^2$" from typesetting "5 fee scales as $n^2"
  // — the opener at "$5" dies on the space in front of the next dollar, the
  // scanner walks on, and the real formula is found from "$n^2$".
  function closeDollar(s, open, stop) {
    let k = open + 1;
    for (;;) {
      k = s.indexOf('$', k);
      if (k < 0 || k >= stop) return -1;
      if (s[k - 1] !== '\\') break;                // \$ is a literal dollar
      k++;
    }
    if (/\s/.test(s[k - 1])) return -1;            // "…$ 10" — not a closer
    if (/\d/.test(s[k + 1] || '')) return -1;      // "…and$10" — an amount
    return k;
  }

  // Every math span in `src`, in source order: {start, end, tex, display, raw}.
  // Pure — no DOM, no KaTeX — so the node tests can drive it directly.
  function scanMath(src) {
    const s = String(src == null ? '' : src);
    const out = [];
    const add = (start, end, tex, display) => {
      if (!tex.trim()) return false;               // "$$" / "\(\)" is not math
      out.push({ start, end, tex, display, raw: s.slice(start, end) });
      return true;
    };
    let i = 0;
    while (i < s.length) {
      const c = s[i];

      if (c === '`') {
        // a code run — an inline span or a fenced block, both closed by a run
        // of the same length (the rule INLINE already uses). Everything inside
        // is code: `$5` and a fenced block full of \alpha stay literal.
        const run = runLen(s, i, '`');
        const close = findRun(s, i + run, '`', run);
        i = close < 0 ? i + run : close + run;
        continue;
      }

      if (c === '\\') {
        const n = s[i + 1];
        if (n === '(' || n === '[') {
          const shut = n === '(' ? '\\)' : '\\]';
          const end = s.indexOf(shut, i + 2);
          // like $$ above: an empty \(\) is eaten whole, never reopened
          if (end > 0) { add(i, end + 2, s.slice(i + 2, end), n === '['); i = end + 2; continue; }
        }
        i += 2;                                    // \$ \\ \` — never an opener
        continue;
      }

      if (c === '$') {
        if (s[i + 1] === '$') {
          // display math may run over as many lines as it likes; only the
          // single-$ form is paragraph-bound
          const end = s.indexOf('$$', i + 2);
          // an empty pair is consumed whole rather than half: "$$ $$" is two
          // dollar signs and a space, not an opener whose partner is the
          // NEXT "$$" three words later
          if (end > 0) { add(i, end + 2, s.slice(i + 2, end), true); i = end + 2; continue; }
          i += 2;
          continue;
        }
        const prev = i ? s[i - 1] : '';
        const next = s[i + 1] || '';
        // no space after the opening $, nothing word-like before it (kills
        // "US$5"), and a closer inside the same paragraph — or this is a
        // dollar sign and the scanner walks on
        if (!/[A-Za-z0-9]/.test(prev) && next && !/\s/.test(next)) {
          const k = closeDollar(s, i, paraEnd(s, i));
          if (k > 0 && add(i, k + 1, s.slice(i + 1, k), false)) { i = k + 1; continue; }
        }
        i++;
        continue;
      }

      i++;
    }
    return out;
  }

  // src → {text, spans}: the same string with every math span replaced by its
  // placeholder. Also pure.
  function protectMath(src) {
    const s = String(src == null ? '' : src);
    const spans = scanMath(s);
    if (!spans.length) return { text: s, spans };
    const parts = [];
    let at = 0;
    spans.forEach((sp, n) => {
      parts.push(s.slice(at, sp.start), '\u0000' + n + '\u0000');
      at = sp.end;
    });
    parts.push(s.slice(at));
    return { text: parts.join(''), spans };
  }

  // One rendered formula. KaTeX builds real nodes (katex.render, not
  // renderToString), so the no-HTML-string rule of this whole path holds.
  function mathNode(span) {
    const el = mk(span.display ? 'div' : 'span', 'md-math' + (span.display ? '' : ' inline'));
    const K = root.katex;
    try {
      if (!K || !K.render) throw new Error('katex unavailable');
      K.render(span.tex, el, {
        displayMode: span.display,
        throwOnError: true,     // caught right here — see below
        strict: 'ignore',       // no console noise over \over and friends
        trust: false,           // \href / \url never become links
      });
    } catch (e) {
      // Fail soft, always. A formula the bot got half-right, or a KaTeX that
      // did not load, shows the TeX as it was written — the reader loses the
      // typesetting and keeps every word of the message.
      // `raw` is ADDED, never assigned: an inline formula that failed is still
      // inline, and dropping the class would break the sentence onto two lines
      el.classList.add('raw');
      el.textContent = span.raw;
    }
    return el;
  }

  // Put the formulas back. Walks the text nodes markdown produced and splits
  // each one on its placeholders. Inside <code>/<pre> the SOURCE goes back
  // instead of a rendering — scanMath skips code, so this only fires if the
  // two disagree about where a backtick run ended, and code winning is the
  // safe way to disagree.
  function substituteMath(frag, spans) {
    const walk = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (MATH_TOKEN.test(n.nodeValue)) hits.push(n);
    }
    for (const node of hits) {
      let code = false;
      for (let p = node.parentNode; p && p !== frag; p = p.parentNode) {
        const t = p.tagName;
        if (t === 'CODE' || t === 'PRE') { code = true; break; }
      }
      const out = document.createDocumentFragment();
      const text = node.nodeValue;
      let at = 0, m;
      MATH_TOKEN_G.lastIndex = 0;
      while ((m = MATH_TOKEN_G.exec(text))) {
        if (m.index > at) out.appendChild(document.createTextNode(text.slice(at, m.index)));
        const span = spans[Number(m[1])];
        if (!span) out.appendChild(document.createTextNode(m[0]));
        else if (code) out.appendChild(document.createTextNode(span.raw));
        else out.appendChild(mathNode(span));
        at = m.index + m[0].length;
      }
      if (at < text.length) out.appendChild(document.createTextNode(text.slice(at)));
      node.parentNode.replaceChild(out, node);
    }
  }

  function mdInline(text, out) {
    let s = String(text == null ? '' : text);
    for (let guard = 0; guard < 500; guard++) {
      const m = INLINE.exec(s);
      if (!m) break;
      if (m.index) out.appendChild(document.createTextNode(s.slice(0, m.index)));
      if (m[2] !== undefined) {
        const c = mk('code');
        c.textContent = m[2].replace(/^ (.*) $/, '$1');
        out.appendChild(c);
      } else if (m[3] !== undefined) {
        if (SAFE_URL.test(m[4])) {
          const a = mk('a');
          a.setAttribute('href', m[4]);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.textContent = m[3] || m[4];
          out.appendChild(a);
        } else {
          // anything that is not plain http(s) — javascript:, data:, mailto: —
          // is never linkified; the source text is shown as the bot wrote it
          out.appendChild(document.createTextNode(m[0]));
        }
      } else if (m[5] !== undefined) mdInline(m[5], out.appendChild(mk('strong')));
      else if (m[6] !== undefined) mdInline(m[6], out.appendChild(mk('em')));
      else if (m[7] !== undefined) {
        // A url somebody just pasted, which is what a link in a person's own
        // message almost always is. Same rules as a markdown link: http(s)
        // only, opened in a new tab with no window.opener back-reference.
        let url = m[7], tail = '';
        const t = URL_TAIL.exec(url);
        if (t) { tail = t[0]; url = url.slice(0, -tail.length); }
        if (SAFE_URL.test(url) && url.length > 'https://'.length) {
          const a = mk('a');
          a.setAttribute('href', url);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.textContent = url;
          out.appendChild(a);
        } else out.appendChild(document.createTextNode(url));
        if (tail) out.appendChild(document.createTextNode(tail));
      }
      s = s.slice(m.index + m[0].length);
    }
    if (s) out.appendChild(document.createTextNode(s));
    return out;
  }

  const isBlockStart = l =>
    FENCE.test(l) || BULLET.test(l) || NUMBER.test(l) || HEADING.test(l) ||
    MATH_BLOCK.test(l) || !l.trim();

  // The tick index a click reports back to the companion: the 0-based ordinal
  // of the checkbox WITHIN ITS MESSAGE, counted in document order. Reset per
  // renderMarkdown() call, which is once per message.
  let taskSeq = 0;
  // …and the same idea for fenced code blocks, which is how a Run button says
  // WHICH block it is about. EVERY fence is counted, python or not: the
  // companion counts the same way (run.mjs codeBlocks), so the ordinal cannot
  // drift between the two over a language tag.
  let codeSeq = 0;

  // `carry` renders a CONTINUATION of the message just rendered: the tick and
  // fence counters keep going instead of restarting at zero. The "▸ more" fold
  // draws one message as two fragments, and both ordinals are ADDRESSES the
  // companion re-derives from the whole stored message (run.mjs codeBlocks,
  // store.mjs's tick walk) — restart them and the second half's Run button
  // runs the first half's code.
  function renderMarkdown(src, carry) {
    const frag = document.createDocumentFragment();
    // math first, always: the parser below must never see a `_`, a `*` or a
    // `\\` that belonged to a formula
    const held = protectMath(String(src == null ? '' : src).replace(/\r\n?/g, '\n'));
    const lines = held.text.split('\n');
    if (!carry) { taskSeq = 0; codeSeq = 0; }
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      // display math alone on its line is a block, not a lump in a paragraph
      const solo = MATH_BLOCK.exec(line);
      if (solo && held.spans[Number(solo[1])] && held.spans[Number(solo[1])].display) {
        frag.appendChild(mathNode(held.spans[Number(solo[1])]));
        i++;
        continue;
      }

      const fence = FENCE.exec(line);
      if (fence) {
        const close = fence[1][0] === '`' ? /^\s{0,3}```/ : /^\s{0,3}~~~/;
        const buf = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
        i++;                                     // the closing fence, if there is one
        const pre = mk('pre', 'md-code');
        pre.setAttribute('data-block', String(codeSeq++));
        if (fence[2]) pre.setAttribute('data-lang', fence[2]);
        const code = mk('code');
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      const head = HEADING.exec(line);
      if (head) {
        // rendered as one weight, not six sizes: this is a 420px column, and a
        // bot's "###" should read as a label, not as a billboard
        mdInline(head[2], frag.appendChild(mk('div', 'md-h')));
        i++;
        continue;
      }

      if (BULLET.test(line) || NUMBER.test(line)) {
        const ordered = !BULLET.test(line);
        const list = mk(ordered ? 'ol' : 'ul', 'md-list');
        if (ordered) {
          const n = Number(NUMBER.exec(line)[1]);
          if (n > 1) list.setAttribute('start', String(n));
        }
        let tasks = 0;
        while (i < lines.length) {
          const m = (ordered ? NUMBER : BULLET).exec(lines[i]);
          if (!m) break;
          i++;
          let txt = ordered ? m[2] : m[1];
          // lazy continuation: a wrapped item keeps flowing into the same <li>
          while (i < lines.length && !isBlockStart(lines[i])) txt += ' ' + lines[i++].trim();
          const task = TASK.exec(txt);
          const li = list.appendChild(mk('li'));
          if (!task) { mdInline(txt, li); continue; }
          tasks++;
          const done = task[1] !== ' ';
          li.className = 'md-task' + (done ? ' done' : '');
          const box = mk('input', 'md-tick');
          box.type = 'checkbox';
          box.checked = done;
          box.setAttribute('data-tick', String(taskSeq++));
          box.setAttribute('aria-label', task[2]);
          li.appendChild(box);
          mdInline(task[2], li.appendChild(mk('span', 'md-tasktext')));
        }
        // a list of checkboxes carries its own markers; the bullets would be
        // a second, quieter bullet in front of every one of them
        if (tasks) list.classList.add('md-tasklist');
        frag.appendChild(list);
        continue;
      }

      const buf = [];
      while (i < lines.length && !isBlockStart(lines[i])) buf.push(lines[i++]);
      mdInline(buf.join('\n'), frag.appendChild(mk('p', 'md-p')));
    }
    if (held.spans.length) substituteMath(frag, held.spans);
    return frag;
  }

  // ── the room protocol's JSON footer ────────────────────────────────────
  // Free-form mode tells each bot to end its turn with a JSON footer
  // {"status","next","writer","summary"} (core/room_prompts.py). The
  // controller strips a well-formed TRAILING one before the companion ever
  // sees it, but a bot that pretty-prints it, drops it mid-message, or is
  // still half-way through writing it leaks raw braces into the prose — and
  // here the prose is PERSISTED, so a leak is permanent. So lift every
  // envelope out wherever it sits and render it as a subdued chip.
  //
  // One deliberate exception: an envelope inside a fenced code block is left
  // exactly where it is. The drawer numbers fenced blocks for the Run button
  // and the companion re-parses the STORED text with the same counter
  // (run.mjs codeBlocks), so removing a fence — or hollowing one out — would
  // point every later Run button at the wrong block.
  const ENV_KEYS = new Set(['status', 'next', 'writer', 'summary']);
  const isEnvelope = v =>
    v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.status === 'string' &&
    ('next' in v || 'summary' in v) &&
    Object.keys(v).every(k => ENV_KEYS.has(k));
  // a half-written envelope at the very end of a live stream: `{"status": "co`
  // with no closing brace yet
  const PARTIAL_ENV = /[ \t]*\{[ \t\r\n]*"(?:status|next|writer|summary)"[ \t]*:[^{}]*$/;
  // how far past a '{' the "status" key may sit before we stop believing this
  // is an envelope — also what keeps a message full of JSON from costing a
  // balanced-brace scan per opening brace on every streamed delta
  const ENV_LOOKAHEAD = 600;

  // [start, end) of every fenced code block, so nothing above reaches inside
  // one. An unclosed fence (mid-stream) runs to the end of the text.
  function fencedRanges(s) {
    const out = [];
    let at = 0, open = null;
    for (const line of s.split('\n')) {
      const f = FENCE.exec(line);
      if (!open) { if (f) open = { start: at, ch: f[1][0] }; }
      else if (new RegExp('^\\s{0,3}' + (open.ch === '`' ? '```' : '~~~')).test(line)) {
        out.push([open.start, at + line.length]);
        open = null;
      }
      at += line.length + 1;
    }
    if (open) out.push([open.start, s.length]);
    return out;
  }

  // brace-balanced read of the JSON object starting at s[at] ('{'), honouring
  // strings and escapes so a "}" inside a summary cannot end it early
  function readObject(s, at) {
    let depth = 0, inStr = false, esc = false;
    for (let i = at; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return { value: JSON.parse(s.slice(at, i + 1)), end: i + 1 }; }
          catch { return null; }
        }
      }
    }
    return null;              // unterminated (mid-stream, or not JSON at all)
  }

  // text -> {text, envs}: the prose with every bare envelope lifted out, in
  // the order they appeared.
  function splitEnvelopes(raw) {
    const s = String(raw == null ? '' : raw);
    const envs = [];
    if (s.indexOf('"status"') === -1) return { text: s, envs };
    const fences = fencedRanges(s);
    const inFence = i => fences.some(([a, b]) => i >= a && i < b);
    let out = '', i = 0;
    for (;;) {
      const j = s.indexOf('{', i);
      if (j < 0) { out += s.slice(i); break; }
      if (inFence(j) || !/"status"[ \t]*:/.test(s.slice(j, j + ENV_LOOKAHEAD))) {
        out += s.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const got = readObject(s, j);
      if (got && isEnvelope(got.value)) {
        out += s.slice(i, j);
        envs.push(got.value);
        i = got.end;
        continue;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
    }
    // …and the one that is still being typed, if the tail is not inside a fence
    if (!inFence(s.length - 1)) {
      const cut = out.replace(PARTIAL_ENV, '');
      if (cut !== out) { out = cut; envs.push(null); }
    }
    // an envelope on its own line leaves the line behind it: close the gap so
    // the prose does not grow a hole where the JSON used to be. Only when
    // something was actually taken — a message with no footer keeps its own
    // blank lines exactly as written, fenced code included.
    if (envs.length) out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return { text: envs.length ? out.trim() : out, envs: envs.filter(Boolean) };
  }

  // ── "▸ more": the long half of a capped answer ──────────────────────────
  // A bot leads with the short answer and puts the rest after one marker line,
  // `<!--more-->` (bridge-system-prompt rule 1). The drawer shows the head and
  // folds the tail behind a disclosure exactly like the tools row above.
  // A marker inside a fenced block is code, not a marker — the same rule
  // splitEnvelopes obeys, and for the same reason.
  //
  // This parser is duplicated, byte for byte, in ../more.mjs (the companion,
  // for the Obsidian export) and in reader.js (the phone) — the extension can
  // import from neither. test/more.test.mjs pins the three copies together.

  // ⟦more⟧ begin — byte-identical in extension/drawer.js and reader.js
  var MORE_MARK = /^[ \t]*<!--[ \t]*more[ \t]*-->[ \t]*$/i;
  function splitMore(raw) {
    var s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    if (s.indexOf('<!--') === -1) return { head: s, more: '' };
    var lines = s.split('\n');
    var fence = '', at = -1, tail = [];
    for (var i = 0; i < lines.length; i++) {
      var f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(lines[i]);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1].charAt(0) === fence.charAt(0) && f[1].length >= fence.length) fence = '';
      } else if (!fence && MORE_MARK.test(lines[i])) {
        if (at < 0) at = i;
        continue;
      }
      if (at >= 0) tail.push(lines[i]);
    }
    if (at < 0) return { head: s, more: '' };
    var head = lines.slice(0, at).join('\n').replace(/\s+$/, '');
    var more = tail.join('\n').replace(/^\s+/, '').replace(/\s+$/, '');
    if (!head) return { head: more, more: '' };
    return { head: head, more: more };
  }
  function stripMore(raw) {
    var p = splitMore(raw);
    return p.more ? p.head + '\n\n' + p.more : p.head;
  }
  // ⟦more⟧ end

  // The renderers below build HTML strings; markdown must not. Each bot reply
  // parks its text in this slot map and gets an empty <div data-md="…">, which
  // render() fills from the DOM side once the string has landed.
  let mdSeq = 0;
  const mdSlots = new Map();
  function mdSlot(text) {
    const id = 'md' + (++mdSeq);
    mdSlots.set(id, text);
    return id;
  }
  // The footer as one quiet line: a status dot, the status word, whatever the
  // bot summarised, and who it handed the floor to. DOM nodes and textContent
  // only, like everything else on the message path.
  const ENV_NEXT = { '@user': 'back to you', '@claude': 'over to @claude', '@codex': 'over to @codex' };
  function envRow(envs) {
    const row = mk('div', 'envrow');
    for (const env of envs) {
      const chip = row.appendChild(mk('div', 'env env-' + String(env.status).replace(/\W+/g, '')));
      chip.appendChild(mk('span', 'env-dot')).setAttribute('aria-hidden', 'true');
      chip.appendChild(mk('span', 'env-status')).textContent = String(env.status || '');
      if (env.summary) chip.appendChild(mk('span', 'env-sum')).textContent = String(env.summary);
      const next = String(env.next || '').toLowerCase();
      if (next) {
        chip.appendChild(mk('span', 'env-next')).textContent =
          ENV_NEXT[next] || ('over to ' + next);
      }
      if (env.writer) chip.appendChild(mk('span', 'env-writer')).textContent = 'writer ' + env.writer;
      chip.setAttribute('title', 'room protocol footer — ' + JSON.stringify(env));
    }
    return row;
  }
  function fillMarkdown(scope) {
    scope.querySelectorAll('.ctext[data-md]').forEach(el => {
      const text = mdSlots.get(el.getAttribute('data-md'));
      if (text == null) return;
      const split = splitEnvelopes(text);
      el.textContent = '';
      el.appendChild(renderMarkdown(split.text, el.hasAttribute('data-md-cont')));
      // what the copy button hands back: what was WRITTEN, not what was drawn
      el.setAttribute('data-raw', split.text);
      if (split.envs.length) el.insertAdjacentElement('afterend', envRow(split.envs));
    });
    mdSlots.clear();
  }

  // ── long threads collapse in the middle ────────────────────────────────
  // A thread that has been going for a while is mostly scrollback: the reader
  // wants the passage it started from and whatever was said last, not the
  // twenty turns in between. So past a threshold the middle folds away behind
  // one quiet line and the thread stops pushing every other card off screen.
  //
  // The unit of collapsing is NOT the message, it is what the drawer draws: a
  // person's message is one unit, and a bot's whole turn — its merged tool row
  // plus every answer in it — is another. Collapsing by message would let a
  // turn's "Explored · 4 steps" row survive on its own, hovering above an
  // answer that had been hidden, which is worse than showing nothing.
  const COLLAPSE_AT = 3;   // units on screen before any folding happens
  const KEEP_HEAD = 1;     // the thread root: the message under the quote
  const KEEP_TAIL = 2;     // the tail of the conversation, always live
  // A fold the reader ASKED for is tighter than one the drawer chose: they
  // want the thread out of the way, not tidied. The newest unit still shows,
  // so a folded thread that gets an answer still says so.
  const KEEP_TAIL_SHUT = 1;

  // …and once they have said so, it is theirs. `manual` is undefined (the rule
  // above decides), FOLD_OPEN (they opened it) or FOLD_SHUT (they folded it),
  // and a manual choice survives everything that happens afterwards — a thread
  // somebody folded must not spring open because a bot answered into it.
  const FOLD_OPEN = 'open';
  const FOLD_SHUT = 'shut';
  // Whether a manual fold/unfold control is worth offering at all: three drawn
  // units is the same threshold the automatic rule uses.
  const foldable = units => ((units || []).length) >= COLLAPSE_AT;

  // The raw msgs list grouped exactly the way msgsHtml draws it.
  function msgUnits(list) {
    const msgs = (list || []).filter(Boolean);
    const units = [];
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].kind !== 'tools' && !isBot(msgs[i].author)) { units.push([msgs[i]]); continue; }
      const span = [];
      while (i < msgs.length && (msgs[i].kind === 'tools' || isBot(msgs[i].author))) span.push(msgs[i++]);
      i--;
      units.push(span);
    }
    return units;
  }

  // What to draw, given those units: units [from, to) fold away and `hidden`
  // is what the expander line claims. Pure, and the only place the arithmetic
  // lives (test/collapse.test.mjs drives it directly).
  //
  // `manual` is the reader's own decision about THIS thread, and it outranks
  // the threshold in both directions: FOLD_SHUT folds a thread the rule would
  // have left alone, FOLD_OPEN (or a plain `true`, which is what the expander
  // used to set) keeps one open however long it grows.
  function collapsePlan(units, manual) {
    const n = (units || []).length;
    const none = { collapsed: false, from: n, to: n, hidden: 0, manual: false };
    const shut = manual === FOLD_SHUT;
    if (!shut && (manual || n <= COLLAPSE_AT)) return none;
    const from = KEEP_HEAD, to = n - (shut ? KEEP_TAIL_SHUT : KEEP_TAIL);
    if (to <= from) return none;
    // tool rows are process detail, not messages — the line says "9 earlier
    // replies" and the reader must find nine of them when it opens
    let hidden = 0;
    for (let i = from; i < to; i++) {
      for (const m of units[i]) if (m.kind !== 'tools') hidden++;
    }
    // hiding one message is worth the line ("Show 1 earlier reply"); hiding
    // none is not — a middle made only of tool rows has nothing to announce
    if (hidden < 1) return none;
    return { collapsed: true, from, to, hidden, manual: shut };
  }

  // ── @-mentions: completing the handle you are typing ─────────────────────
  // Mentions are the only way to summon a bot and they work anywhere in a
  // message, so the completion follows the CARET, not the start of the box.
  // Both halves are pure and unit-tested (test/mentions.test.mjs): what token
  // is being typed, and which handles match it.
  const HANDLE_CHAR = /[A-Za-z0-9_-]/;
  // The character before an "@" decides whether it is a mention at all. A
  // handle starts a word: after whitespace, at the very beginning, or after
  // the punctuation people actually type in front of one. Anything else —
  // crucially a letter or digit — makes it an email address or a path, and
  // those must be typeable without a menu appearing over them.
  const MENTION_OPENER = /[\s(\[{"'“‘*_>~,;:/-]/;

  // The @-token the caret is sitting in, or null. `start` is the "@" itself,
  // `end` the caret: replacing [start, end) is what completing means.
  function mentionToken(text, caret) {
    const s = String(text == null ? '' : text);
    const at = Math.max(0, Math.min(Number(caret) || 0, s.length));
    let i = at;
    while (i > 0 && HANDLE_CHAR.test(s[i - 1])) i--;
    if (i === 0 || s[i - 1] !== '@') return null;
    const start = i - 1;
    if (start > 0 && !MENTION_OPENER.test(s[start - 1])) return null;
    return { start, end: at, query: s.slice(i, at) };
  }

  // Who can be summoned: whatever agents the drawer knows about, plus @all,
  // filtered by what has been typed so far (case-insensitive prefix). The
  // agents are never hardcoded here — the caller passes what the companion
  // said — but @all is always on the list, because it always works.
  function mentionCandidates(agents, query) {
    const q = String(query || '').toLowerCase();
    const out = [];
    for (const a of [...(agents || []), 'all']) {
      const h = String(a || '').trim().toLowerCase();
      if (!h || out.indexOf(h) !== -1) continue;
      if (h.indexOf(q) === 0) out.push(h);
    }
    return out;
  }

  // What the fold line says, in either direction. A fold that hides exactly one
  // message has to read "Show 1 earlier reply" — folds start at four units, so
  // the singular is the common case, not a curiosity — and the manual control
  // is the same sentence with the other verb, because it is the same idea.
  function moreLabel(hidden, action) {
    return (action === 'hide' ? 'Hide ' : 'Show ') + hidden +
      ' earlier repl' + (hidden === 1 ? 'y' : 'ies');
  }

  // Official agent logomarks for the header presence cluster — the same Simple
  // Icons path data the review UI uses (frontends/review/assets/review.js), so
  // the two surfaces show the identical avatars.
  const MARKS = {
    claude: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
    codex: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  };
  // One circle per agent engaged in the turn. `working` = the ring spins in that
  // agent's colour; anyone else in the turn stays dimmed and still. No visible
  // text — the state is the tooltip.
  function avatarHtml(agent, working) {
    const label = agent + ' — ' + (working ? 'working…' : 'waiting…');
    return `<span class="avatar-ring${working ? ' working' : ''}" data-agent="${agent}"` +
      ` style="--author:var(--${agent})" title="${label}" aria-label="${label}">` +
      `<span class="avatar">${MARKS[agent]}</span></span>`;
  }

  // The Obsidian mark, inline so it needs no web_accessible_resource and no
  // network. Static, authored markup — the only HTML string in the file that
  // is not escaped user data.
  const OBSIDIAN_SVG =
    '<svg class="obs" viewBox="0 0 100 120" fill="none" aria-hidden="true" focusable="false">' +
    '<polygon points="50,0 85,35 75,120 25,120 15,35" fill="#7C3AED"/>' +
    '<polygon points="50,0 85,35 50,45" fill="#8B5CF6"/>' +
    '<polygon points="50,0 15,35 50,45" fill="#6D28D9"/>' +
    '<polygon points="15,35 25,120 50,45" fill="#5B21B6"/>' +
    '<polygon points="85,35 75,120 50,45" fill="#A78BFA"/>' +
    '<polygon points="25,120 75,120 50,45" fill="#7C3AED"/></svg>';

  // Two stacked sheets: the header's own glyph for "every page you have
  // annotated". Stroked in currentColor so it inherits the icon button's
  // hover/active colour like the ⚙ and ✕ next to it.
  // A speech bubble: "there are bots in this one". Muted, stroked in
  // currentColor like the header's own glyphs, and never a second colour —
  // the row is a destination, not a status board.
  const CHAT_TIP = 'has a bot chat';
  const CHAT_SVG =
    '<svg class="cico" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" ' +
    'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13.6 9.2A1.9 1.9 0 0 1 11.7 11H6.2L3 13.4V4.6A1.9 1.9 0 0 1 4.9 2.8h6.8a1.9 1.9 0 0 1 1.9 1.8z"/>' +
    '</svg>';

  // The braid — the plugin's own mark, the one on the extension icon and the
  // share card, and the way into its own list of pages. It replaces a stacked-
  // pages outline that read as a copy icon, which is not what this button does.
  //
  // Drawn the way icons/make-icons.mjs draws the 16px tile (VARIANTS, min:0):
  // HALF a turn, one crossing, three fat strands, no bloom and no flares —
  // everything the full braid does is illegible at row scale. The casing is
  // painted in the drawer's own background so over/under reads in both themes,
  // and the strand order (codex, you, claude) is what makes the crossing a
  // crossing rather than three lines meeting.
  //
  // The strands are --mark-* and NOT the speaker colours: this is the mark on
  // the toolbar button, rasterised from those exact values, and it must look
  // the same in both themes even though who-is-speaking does not.
  const BRAID_STRANDS = [
    ['codex', 'M12.07 17.2L11.38 15.67L10.43 14.13L9.27 12.6L8 11.07L6.71 9.53L5.5 8L4.47 6.47L3.7 4.93L3.26 3.4L3.15 1.87L3.39 0.33L3.93 -1.2'],
    ['you', 'M8 17.2L9.24 15.67L10.42 14.13L11.47 12.6L12.3 11.07L12.82 9.53L13 8L12.82 6.47L12.3 4.93L11.47 3.4L10.42 1.87L9.24 0.33L8 -1.2'],
    ['claude', 'M3.93 17.2L3.39 15.67L3.15 14.13L3.26 12.6L3.7 11.07L4.47 9.53L5.5 8L6.71 6.47L8 4.93L9.27 3.4L10.43 1.87L11.38 0.33L12.07 -1.2'],
  ];
  const BRAID_SVG =
    '<svg class="pico braid" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    BRAID_STRANDS.map(([name, d]) =>
      `<path d="${d}" stroke="var(--bg)" stroke-width="3.4"/>` +
      `<path d="${d}" stroke="var(--mark-${name})" stroke-width="2"/>`).join('') +
    '</svg>';
  const PAGES_SVG = BRAID_SVG;

  function create(opts) {
    opts = opts || {};
    const cb = name => (...args) => (typeof opts[name] === 'function' ? opts[name](...args) : undefined);

    // Site capabilities (content.js's adapter). Only `highlights` so far, and
    // everything that reads it is one branch — the shape is here so the next
    // adapter can turn something else off without a redesign.
    const CAPS = Object.assign({ highlights: true }, opts.capabilities || {});
    const NOHL = 'highlights aren’t supported on this site — use Page chat';

    // A page that carries its own margin commenting (content.js's
    // REVIEW_UI_MARKER — the review engine's build, or a review-doc
    // `*.review.html`). This is a property of the DOM, not of the site, so it
    // arrives separately from CAPS and can change while the drawer is up: the
    // reader may decide, once per page, to hand the margin back to the page's
    // own commenting (`pageOwns`).
    //
    // Standing down is NARROW on purpose. It withdraws exactly two things —
    // the selection pill and the ability to start a thread — and nothing else.
    // Page chat, the archive, the tasks card, the project header, send-review
    // and every thread already on this page carry on untouched, because a
    // conversation already in flight is not undone by whose pill is showing.
    const RH = Object.assign({ hosts: false, pageOwns: false }, opts.reviewHost || {});
    const standDown = () => RH.hosts && !!RH.pageOwns;

    // TRACK CHANGES ON THE PAGE. content.js owns the markup and the storage;
    // this is only the switch and the fact that there is anything to switch.
    // `threads` is the list of thread ids currently carrying (or entitled to
    // carry) inline markup — the control does not render at all when it is
    // empty, because a toggle for a thing that is not on the page is clutter
    // in the one pane the reader came to for their comments.
    const TC = { on: opts.trackChanges !== false, threads: [] };

    const D = {
      page: null,          // the page record from /page
      // the review round in flight, exactly as the companion broadcasts it.
      // Never computed here: the companion owns the queue, so a tab that was
      // closed for half the round still comes back to the truth (see /round).
      round: null,
      orphans: {},         // threadId -> bool (content.js's live anchoring verdict)
      streams: {},         // stream_id -> {who, target, text}
      running: {},         // target -> true while a turn is in flight
      turnAgents: {},      // target -> ['claude'|'codex'] as announced by turn-start
      liveAgents: {},      // target -> agents actually seen streaming this turn
      speaker: {},         // target -> the agent whose stream arrived most recently
      // target -> status line {text, err, transient}. `transient` marks a line
      // that is only true WHILE WE WAIT ("queued…", "stopping…"): the working
      // chip supersedes it and any turn boundary removes it. A plain note (a
      // refusal, an error) is a message and survives the turn.
      notes: {},
      // target -> a counter bumped on every turn boundary for that target. The
      // companion pumps its queue from inside the call that answers the POST,
      // so `turn-start` regularly beats {queued:true} back to us; a send whose
      // generation has already moved on has missed its window to say "queued".
      turnSeq: {},
      // target -> when a chat event for it last arrived. A turn ends with an
      // event, so a running turn nobody has heard from in a long time is a
      // turn whose ending was lost in transit — see quietTurns/endTurn.
      heard: {},
      // the open @-menu, if any: {target, start, end, caret, items, index}
      mention: null,
      // 'all' | 'comments' — which export the crystal will run, remembered
      // across sessions by content.js (setExportMode) and changed by choosing
      exportMode: 'all',
      exportOpen: false,
      warn: '',            // page-chat warning banner (setWarning), '' = none
      drafts: {},          // target -> composer text, preserved across renders
      // WHO THE NEXT MESSAGE IN A THREAD IS FOR — the composer's pill row.
      // target -> 'none'|'claude'|'codex'|'all', set by clicking a pill and by
      // sending a message that typed a tag. UNSET is the normal state and does
      // not mean "nobody": it means the thread's own sticky address answers
      // (stickyRouteOf), which is what makes a reopened drawer show the same
      // pill lit that the reader left lit.
      routes: {},
      // OPTIMISTIC SEND (round 5). A message the user has committed to but the
      // companion has not confirmed lives here, not in the composer: it is
      // rendered as a real (dimmed, spinner-bearing) message in its thread the
      // instant Send is pressed, and the composer empties. On success it is
      // dropped and the server's own copy takes its place; on failure it stays
      // put with a retry, so the text is never in limbo and never lost.
      outbox: {},          // target -> [{id, text, state:'sending'|'failed', error, seen}]
      sendLock: {},        // target -> true for the synchronous span of a send
      pending: null,       // {quote, prefix, suffix} while composing a new thread
      confirm: null,       // threadId whose "delete thread?" confirm is showing
      // {key:"target|ts", ok} for ~1.4s after a message was copied, so the
      // confirmation survives a render() landing on top of it
      copied: null,
      toolsOpen: {},       // tool-activity disclosure key -> expanded
      moreOpen: {},        // "▸ more" disclosure key (target|ts|more) -> expanded
      // ---- running a ```python block (setCanRun / onRun) ----------------
      // The button exists only where the companion says it does: owner, and
      // not switched off in config.json. Guests never see it and would be
      // refused if they did.
      canRun: false,
      runState: {},        // "target|ts|block" -> 'running'
      runErr: {},          // …-> a refusal to show under that block
      runOpen: {},         // …-> the reader opened a long stdout
      figs: {},            // "runId|name" -> data: url (fetched through the worker)
      figLoading: {},      // …-> a fetch is in flight
      light: null,         // the open lightbox's src, or null
      // target -> true once the reader has opened a long thread's hidden
      // middle. In memory for the session only: a collapse is a reading
      // convenience, not a decision worth persisting.
      expanded: {},
      // ---- the tasks card ------------------------------------------------
      // The newest checklist on this page, wherever it lives, pinned at the
      // top of both panes. DERIVED: `tasks` is recomputed from the record by
      // every render() and holds nothing of its own —
      // {target, thread, msg, key} or null. `tasksOpen` is the fold, session
      // only, like every other reading position in here.
      tasks: null,
      tasksOpen: true,
      // ---- resolved threads ---------------------------------------------
      // The main list is what still needs the reader; everything they have
      // marked handled drops into one collapsed section at the bottom. Both
      // pieces of state are for the session only: which section is open and
      // which digest cards have been unfolded are reading positions, not
      // decisions — the decision (resolved / not) lives in the record.
      resolvedOpen: false,   // the "Resolved (N)" section is expanded
      // …the "Ready for review (N)" section, OPEN by default — unlike the
      // archive, whose whole point is to be out of the way, this section is
      // the thing the reader came back to the page to look at
      readyOpen: true,
      addressing: {},        // threadId -> a "not done" round trip is in flight
      resolvedCards: {},     // threadId -> the full thread under its digest is open
      resolving: {},         // threadId -> a resolve/reopen is in flight
      // ---- the council project behind a project artifact page -----------
      // Null on every ordinary page, and on those NOTHING below changes. On a
      // page the reader's own council wrote (workspace.mjs), Page chat stops
      // being one conversation about one document and becomes that PROJECT's
      // chat archive: the chats it already has, the one this page is standing
      // in, and the way between them.
      //   project   {root, project_id, project_title, rel, path, confirmed}
      //   archive   the list, once asked for: {list, loading, err, current}
      //   picking   true while the list is showing instead of the conversation
      project: opts.project || null,
      archive: { list: null, loading: false, err: '', current: null, busy: '' },
      picking: false,
      // "send review": the one-step inline confirm (never window.confirm — see
      // del-thread), the in-flight flag, and whatever the companion said last
      review: { confirm: false, busy: false, err: '', note: '' },
      // who WE are on this companion (setAuthor); '' until the background says
      author: opts.author || '',
      focused: null,
      // a page with no highlights has no Comments to open on
      tab: CAPS.highlights ? 'comments' : 'chat',
      // 'threads' = the Comments/Page-chat tabs; 'pages' = the library of every
      // annotated page, which takes over the whole body and hides the tab bar
      view: 'threads',
      // `confirm` = the url whose inline "delete page + its chat?" is showing;
      // `rowErr` = a refusal from the companion, shown under the row it is about;
      // `kind`/`tag` = the filter the list is under ('' = everything), which is
      // remembered per browser; `renaming`/`tagging` = the url whose inline
      // editor is open (owner only — a guest never sees the affordance)
      pages: { list: null, loading: false, err: '', confirm: null, rowErr: null,
               kind: '', tag: '', renaming: null, tagging: null, pick: 0 },
      // whether this browser is the OWNER of this companion, as the companion
      // itself says (GET /whoami, through the background). Renaming and tagging
      // are the owner's; a guest is refused and never sees the controls.
      owner: false,
      // the library conversation, which lives under the pages list: `page` is
      // the companion's record for the reserved url (null = nothing said in it
      // yet, which is a state and not an error)
      library: { page: null, loading: false, err: '', confirm: false, note: '' },
      connected: false,
      connKnown: false,    // false until the background has told us either way
      bridge: '',
      foot: '',
      // effort mirrors models ({current, options}, null until the bridge has
      // spoken); verbosity is a companion-level preference, so it is a string
      models: { current: {}, options: null, status: null, bridge: '', note: '', loading: false,
                effort: null, verbosity: '',
                // {claude:'set'|'unset', codex:…, modes:{…}} — status, never keys
                keys: null,
                // the agent whose billing switch has been flipped to "API key"
                // with no key saved: held mid-flight until the companion says
                // whether one turned up. Never a mode — the drawer does not get
                // to invent one.
                keyPending: null },
      modelsOpen: false,
      relaying: false,     // a POST /relay is in flight — every relay button waits
      width: W_DEFAULT,
      pushed: null,        // saved inline style of <html> while the page is pushed
      host: null, shadow: null, el: {},
      mounted: false,
      // NOT `open`: Object.assign below publishes an open() METHOD on D, and a
      // boolean of the same name would clobber it the first time the drawer was
      // opened — after which d.open('comments') threw "not a function".
      opened: false,
    };

    // ---- mount ----------------------------------------------------------
    function mount() {
      if (D.mounted) return D;
      const host = document.createElement('div');
      host.id = 'bfp-root';
      // the host lives in the page's tree, so its own critical geometry is
      // pinned inline-!important; everything inside is drawer.css's business
      const pin = {
        all: 'initial', position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
        width: 'auto', height: 'auto', margin: '0', padding: '0', border: '0',
        'z-index': '2147483647', 'pointer-events': 'none', display: 'block',
      };
      for (const k in pin) host.style.setProperty(k, pin[k], 'important');
      if (opts.theme) host.setAttribute('data-theme', opts.theme);

      const shadow = host.attachShadow({ mode: 'open' });
      // KaTeX's own stylesheet goes in FIRST so drawer.css keeps the last word
      // on anything the two both style. Its @font-face rules are inert in here
      // — a shadow root does not register fonts — which is why content.js also
      // links katex-fonts.css into the page document; without that half every
      // formula draws in fallback serif.
      if (opts.katexCssUrl) {
        const kl = document.createElement('link');
        kl.rel = 'stylesheet';
        kl.href = opts.katexCssUrl;
        shadow.appendChild(kl);
      }
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = opts.cssUrl || 'drawer.css';
      shadow.appendChild(link);

      const wrap = document.createElement('div');
      wrap.innerHTML = shell();
      while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

      (document.documentElement || document.body).appendChild(host);

      D.host = host; D.shadow = shadow; D.mounted = true;
      D.el = {
        panel: shadow.querySelector('.panel'),
        title: shadow.querySelector('.hdr .title'),
        site: shadow.querySelector('.hdr .site'),
        proj: shadow.querySelector('.hdr .proj'),
        conn: shadow.querySelector('.hdr .conn'),
        tabs: shadow.querySelector('.tabs'),
        cCount: shadow.querySelector('.tab[data-tab="comments"] .count'),
        comments: shadow.querySelector('.pane[data-pane="comments"]'),
        chat: shadow.querySelector('.pane[data-pane="chat"]'),
        pages: shadow.querySelector('.pane[data-pane="pages"]'),
        foot: shadow.querySelector('.footbar'),
        round: shadow.querySelector('.roundbar'),
        selbtn: shadow.querySelector('.selbtn'),
        pop: shadow.querySelector('.popover.models'),
        exportpick: shadow.querySelector('.popover.exportpick'),
        light: shadow.querySelector('.lightbox'),
        grip: shadow.querySelector('.grip'),
      };
      // the Comments tab is left on screen — the drawer must read the same on
      // every site — but there is nothing behind it here, so it is inert and
      // says why on hover
      if (!CAPS.highlights) {
        const ct = shadow.querySelector('.tab[data-tab="comments"]');
        if (ct) { ct.disabled = true; ct.title = NOHL; ct.setAttribute('aria-disabled', 'true'); }
      }

      applyWidth(D.width);
      wireEvents();
      paintProject();
      paintTabs();
      restoreTab();
      restoreWidth();
      restoreExportMode();
      restoreFilter();
      return D;
    }

    function shell() {
      return `
<button class="selbtn" type="button" title="Comment on this selection"><span class="glyph">💬</span>comment</button>
<aside class="panel" role="complementary" aria-label="Botference Discuss">
  <div class="grip" title="Drag to resize · double-click to reset" role="separator" aria-orientation="vertical"></div>
  <div class="hdr">
    <div class="title">—</div>
    <div class="meta"><span class="site"></span><span class="proj" hidden></span><span class="conn" title="companion connection"><span class="dot"></span><span class="ctext">connecting…</span></span></div>
    <div class="acts">
      <button class="iconbtn pages" data-act="pages" type="button" title="All annotated pages" aria-label="All annotated pages" aria-pressed="false">${PAGES_SVG}</button>
      <button class="iconbtn" data-act="models" type="button" title="Models" aria-label="Models">⚙</button>
      <button class="iconbtn obsidian" data-act="export" type="button" title="Export to Obsidian" aria-label="Export to Obsidian">${OBSIDIAN_SVG}</button>
      <button class="iconbtn" data-act="close" type="button" title="Close (Esc)">✕</button>
    </div>
  </div>
  <div class="popover models" role="dialog" aria-label="Models" hidden></div>
  <div class="popover exportpick" role="menu" aria-label="Export to Obsidian" hidden></div>
  <nav class="tabs">
    <button class="tab on" data-tab="comments" type="button">Comments<span class="count">0</span></button>
    <button class="tab" data-tab="chat" type="button">Page chat</button>
  </nav>
  <div class="pane" data-pane="comments"></div>
  <div class="pane" data-pane="chat" hidden></div>
  <div class="pane pages" data-pane="pages" hidden></div>
  <!-- the review round as one visible thing, above the per-turn footbar: the
       footbar reports the TURN in flight, this reports the round the reader
       started, which outlives every turn in it -->
  <div class="roundbar" role="status" aria-live="polite" hidden></div>
  <div class="footbar"></div>
</aside>
<div class="lightbox" role="dialog" aria-label="figure" aria-modal="true" hidden></div>`;
    }

    // ---- tab memory (per hostname) --------------------------------------
    function restoreTab() {
      // per-site memory is overridden, not consulted, where Comments is dead
      if (!CAPS.highlights) return;
      const hn = opts.hostname || 'default';
      try {
        chrome.storage.local.get(TAB_KEY, r => {
          const m = (r && r[TAB_KEY]) || {};
          if (m[hn] === 'chat' || m[hn] === 'comments') { D.tab = m[hn]; paintTabs(); }
        });
      } catch { /* no storage (harness fallback) — keep the default */ }
    }
    function rememberTab() {
      if (!CAPS.highlights) return;   // never write a forced choice back
      const hn = opts.hostname || 'default';
      try {
        chrome.storage.local.get(TAB_KEY, r => {
          const m = (r && r[TAB_KEY]) || {};
          m[hn] = D.tab;
          chrome.storage.local.set({ [TAB_KEY]: m });
        });
      } catch { /* ignore */ }
    }

    // ---- width + page push ----------------------------------------------
    // The drawer used to sit on top of the article; at half-screen widths that
    // covered the text it exists to annotate. Now it pushes: an inline
    // margin-right on <html> equal to the drawer's width, transitioned in step
    // with the panel's own slide. The host stays position:fixed, so if a page's
    // own root styling ignores the margin (rare on static articles) the drawer
    // simply overlaps again — the degradation is silent and harmless.
    const rootEl = () => (typeof document !== 'undefined' && document.documentElement) || null;

    function pushPage(on, animate) {
      const html = rootEl();
      if (!html) return;
      try {
        if (on) {
          if (!D.pushed) D.pushed = { margin: html.style.marginRight, transition: html.style.transition };
          html.style.transition = animate === false ? '' : 'margin-right .22s cubic-bezier(.32,.72,0,1)';
          html.style.marginRight = D.width + 'px';
        } else if (D.pushed) {
          html.style.marginRight = D.pushed.margin;
          html.style.transition = D.pushed.transition;
          D.pushed = null;
        }
      } catch { /* a page that refuses inline styles: overlay, as before */ }
    }

    function applyWidth(w, animate) {
      D.width = clampWidth(w);
      if (D.el.panel) D.el.panel.style.width = D.width + 'px';
      if (D.opened) pushPage(true, animate);
      return D.width;
    }

    function restoreWidth() {
      try {
        chrome.storage.local.get(WIDTH_KEY, r => {
          const w = r && Number(r[WIDTH_KEY]);
          if (w) applyWidth(w);
        });
      } catch { /* no storage (harness fallback) — keep the default */ }
    }
    function rememberWidth() {
      try { chrome.storage.local.set({ [WIDTH_KEY]: D.width }); } catch { /* ignore */ }
    }

    // ---- which export, remembered ---------------------------------------
    // The same one-key-in-extension-storage idiom as the tab and the width:
    // a preference this small has no business being a settings screen, and a
    // reader who exports comments-only once almost always means it next time.
    function restoreExportMode() {
      try {
        chrome.storage.local.get(EXPORT_KEY, r => setExportMode(r && r[EXPORT_KEY]));
      } catch { /* no storage (harness fallback) — 'all', as it always was */ }
    }
    function rememberExportMode() {
      try { chrome.storage.local.set({ [EXPORT_KEY]: D.exportMode }); } catch { /* ignore */ }
    }

    // ---- which slice of the archive, remembered -------------------------
    // Same idiom again, one key: {kind, tag}. Restored before the list is ever
    // drawn, so the view opens where it was left rather than opening on
    // everything and jumping.
    function restoreFilter() {
      try {
        chrome.storage.local.get(FILTER_KEY, r => {
          const f = (r && r[FILTER_KEY]) || null;
          if (!f || typeof f !== 'object') return;
          D.pages.kind = KIND_NAME[f.kind] ? f.kind : '';
          D.pages.tag = typeof f.tag === 'string' ? f.tag.slice(0, TAG_MAX) : '';
          if (D.view === 'pages') renderPages();
        });
      } catch { /* no storage (harness fallback) — everything, as it was */ }
    }
    function rememberFilter() {
      try {
        chrome.storage.local.set({ [FILTER_KEY]: { kind: D.pages.kind, tag: D.pages.tag } });
      } catch { /* ignore */ }
    }

    // Drag from the left edge. Width is measured off the viewport's right edge
    // rather than accumulated from a delta, so a fast drag that outruns the
    // mousemove stream can never drift.
    function beginDrag(ev) {
      ev.preventDefault();
      const html = rootEl();
      const priorTransition = html ? html.style.transition : '';
      if (html) html.style.transition = '';
      D.el.panel.classList.add('dragging');
      const move = e => {
        const x = e.touches ? e.touches[0].clientX : e.clientX;
        applyWidth(window.innerWidth - x, false);
      };
      const up = () => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        D.el.panel.classList.remove('dragging');
        if (html) html.style.transition = priorTransition;
        rememberWidth();
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    }

    function onWinResize() {
      // halving the window must not leave the drawer owning most of it
      const w = clampWidth(D.width);
      if (w !== D.width) applyWidth(w, false);
      else if (D.opened) pushPage(true, false);
    }

    // ---- rendering ------------------------------------------------------
    function threadAuthor(t) {
      const m = (t.msgs || [])[0];
      return (m && m.author) || 'you';
    }

    function replyHtml(target, r, mine) {
      const bot = isBot(r.author);
      // edit is restricted to the user's own messages (the server refuses the
      // rest); delete is allowed on anything, so a bad bot answer can be pruned.
      // Copy is on every message, whoever wrote it — it is the one control
      // here that takes nothing away.
      // "copied ✓" is a piece of STATE, not a piece of DOM: a stream landing
      // in another thread rebuilds this whole pane, and a confirmation that
      // vanishes half a second after the click is a confirmation nobody sees
      const ckey = target + '|' + r.ts;
      const cp = D.copied && D.copied.key === ckey ? D.copied : null;
      // A RESTORED message came out of a council session record, not out of
      // this companion's page file (workspace.mjs sessionTail). Nothing here
      // owns it: there is nothing to edit and nothing to delete, and its `ts`
      // is an address rather than a date, so it is offered neither control and
      // shows no time. Copy stays — it takes nothing away.
      const own = !!r.restored;
      const acts = `<div class="acts">` +
        `<button class="rebtn${cp && cp.ok ? ' done' : ''}" data-act="copy" data-copykey="${esc(ckey)}"` +
        ` title="${esc(cp ? (cp.ok ? 'copied' : COPY_FAIL) : COPY_TIP)}"` +
        ` aria-label="copy this message">${cp ? (cp.ok ? '✓' : '✕') : COPY_GLYPH}</button>` +
        (mine && !own ? `<button class="rebtn" data-act="edit" data-target="${esc(target)}" data-ts="${esc(r.ts)}" title="edit this message" aria-label="edit">✎</button>` : '') +
        (own ? '' : `<button class="rebtn" data-act="del-msg" data-target="${esc(target)}" data-ts="${esc(r.ts)}" title="delete this message" aria-label="delete">✕</button>`) +
        `</div>`;
      // EVERY message is markdown now, whoever wrote it — people paste links
      // into their own comments and expect them to be links. Same renderer as
      // the bots get, which is the point: it builds DOM with createElement and
      // textContent (never an HTML string), and only http/https urls become
      // anchors. What is STORED stays the raw markdown; only the rendering
      // changes, which is why the editor reads msg.text and not this DOM.
      // A capped answer with a longer version behind it (bridge-system-prompt
      // rule 1) arrives as one message with one `<!--more-->` line in it. The
      // head reads as the whole reply; the tail folds behind the same quiet
      // disclosure the tools row uses, and the reader's choice is remembered
      // per message for the session, like every other fold here.
      const cut = splitMore(r.text);
      const mkey = target + '|' + r.ts + '|more';
      const mopen = !!D.moreOpen[mkey];
      const body = cut.more
        ? `<div class="ctext md" data-md="${esc(mdSlot(cut.head))}"></div>` +
          `<div class="more${mopen ? ' open' : ''}" data-more="${esc(mkey)}">` +
          `<button class="more-head" data-act="more" data-key="${esc(mkey)}" type="button" aria-expanded="${mopen}">` +
          `<span class="caret">▸</span><span class="more-label">${mopen ? 'less' : 'more'}</span></button>` +
          `<div class="more-body"${mopen ? '' : ' hidden'}>` +
          `<div class="ctext md" data-md-cont="1" data-md="${esc(mdSlot(cut.more))}"></div></div></div>`
        : `<div class="ctext md" data-md="${esc(mdSlot(r.text))}"></div>`;
      // the agent's own class carries its typeface (drawer.css --font-claude /
      // --font-codex); the colour rides the same rule through speakerColor
      const who = agentOf(r.author);
      return `<div class="reply${bot ? ' bot' : ''}${who ? ' ' + who : ''}${mine ? ' mine' : ''}${own ? ' restored' : ''}" data-ts="${esc(r.ts)}" data-author="${esc(r.author)}"${own ? ' data-restored="1"' : ''} style="--author:${speakerColor(r.author)}">
        <span class="who"><span class="author">${esc(r.author)}</span>${bot ? '<span class="badge bot-badge">bot reply</span>' : ''}${r.edited ? '<span class="edited">(edited)</span>' : ''}<span class="when">${esc(when(r.ts))}</span></span>
        ${body}${acts}</div>`;
    }

    // Tool activity (msg.kind === 'tools') is process detail, not an answer: a
    // slim collapsed disclosure, no author, no badge, nothing that competes
    // with the real text. Every tools message in a bot's turn merges into ONE
    // row, and the row is always hoisted above that turn's answer — the stream
    // may deliver a tool summary after the reply it belongs to, but the reading
    // order is fixed: user message → one "Explored" row → bot reply.
    // Messages with no `kind` (all stored data from before this) are untouched.
    function toolsHtml(target, group) {
      let steps = 0, head = '';
      const parts = [];
      for (const m of group) {
        const lines = String(m.text == null ? '' : m.text).split('\n')
          .map(s => s.replace(/\s+$/, '')).filter(s => s.trim());
        if (!lines.length) continue;
        // a multi-line summary is "<header>\n<step>\n<step>"; a lone line is
        // itself one step
        if (lines.length > 1) { if (!head) head = lines[0].trim(); steps += lines.length - 1; }
        else steps += 1;
        parts.push(lines.join('\n'));
      }
      if (!parts.length) return '';
      const text = parts.join('\n');
      head = head || 'Explored';
      const key = target + '|' + ((group[0] && group[0].ts) || '0');
      const open = !!D.toolsOpen[key];
      return `<div class="tools${open ? ' open' : ''}" data-tools="${esc(key)}">
        <button class="tools-head" data-act="tools" data-key="${esc(key)}" type="button" aria-expanded="${open}">
          <span class="caret">⌄</span><span class="tools-label">${esc(head)} · ${steps} step${steps === 1 ? '' : 's'}</span>
        </button>
        <pre class="tools-body"${open ? '' : ' hidden'}>${esc(text)}</pre>
      </div>`;
    }

    // A "span" is everything a bot produced between two user messages. Inside a
    // span the tools messages are pulled out, merged and emitted first, whatever
    // order they arrived in; the answers follow in their own order.
    function unitHtml(target, span) {
      const out = [];
      const tools = span.filter(x => x.kind === 'tools');
      if (tools.length) out.push(toolsHtml(target, tools));
      for (const r of span) {
        if (r.kind === 'tools') continue;
        out.push(replyHtml(target, r, !isBot(r.author) && sameAuthor(r.author)));
      }
      return out.join('');
    }

    // The folded middle of a long thread. One line, no card, no chrome — it is
    // a way back into the scrollback, not a participant in the conversation.
    // The same line, with the other verb, is how a thread is folded BY HAND:
    // one control in one place that means "less of this" / "more of this",
    // rather than a second widget somewhere else in the card.
    function moreHtml(target, hidden) {
      return `<button class="showmore" data-act="expand" data-target="${esc(target)}" type="button" aria-expanded="false">${esc(moreLabel(hidden))}</button>`;
    }
    function foldHtml(target, hidden) {
      return `<button class="showmore fold" data-act="fold" data-target="${esc(target)}" type="button" aria-expanded="true">${esc(moreLabel(hidden, 'hide'))}</button>`;
    }

    // The thread root and the live tail stay on screen; everything between them
    // folds behind moreHtml() until the reader asks for it. The outbox, the
    // streaming block and the status chip are rendered by cardHtml AFTER this,
    // so a message being sent, a bot mid-answer and "agents are working…" are
    // never inside the fold.
    //
    // Open, and long enough to be worth folding, the same slot offers the way
    // back: "Hide N earlier replies", which is what a reader who has finished
    // with a thread wants and had no way to say.
    function msgsHtml(target, list) {
      const units = msgUnits(list);
      const plan = collapsePlan(units, D.expanded[target]);
      // what folding this thread by hand WOULD hide — the label needs the
      // number, and a thread with nothing to hide is offered no control
      const byHand = plan.collapsed || !foldable(units) ? null : collapsePlan(units, FOLD_SHUT);
      const out = [];
      for (let i = 0; i < units.length; i++) {
        if (plan.collapsed && i === plan.from) out.push(moreHtml(target, plan.hidden));
        else if (byHand && byHand.collapsed && i === byHand.from) out.push(foldHtml(target, byHand.hidden));
        if (plan.collapsed && i >= plan.from && i < plan.to) continue;
        out.push(unitHtml(target, units[i]));
      }
      return out.join('');
    }

    function streamsHtml(target) {
      return Object.keys(D.streams).filter(k => D.streams[k].target === target).map(k => {
        const s = D.streams[k];
        const who = agentOf(s.who);
        // the room footer is being typed in front of the reader on a live
        // stream: hold it back here too, or a finished answer visibly grows a
        // set of JSON braces and then loses them again
        // …and the "▸ more" marker with it: mid-stream there is nothing to
        // fold yet (the fold needs a settled message to key its state on), so
        // the preview shows the whole answer and simply does not show the seam
        const text = stripMore(splitEnvelopes(s.text).text);
        return `<div class="reply bot streaming${who ? ' ' + who : ''}" data-stream="${esc(k)}" style="--author:${authorColor(s.who)}">
          <span class="who"><span class="author">${esc(s.who)}</span><span class="badge bot-badge">writing…</span></span>
          <pre class="stream-text">${esc(text)}</pre></div>`;
      }).join('');
    }

    // ---- who is working ---------------------------------------------------
    // Roster = whoever turn-start named; if it named nobody (older companion)
    // fall back to whoever has actually been seen streaming. The spinning ring
    // then follows the *live* speaker — the `model` on the incoming stream
    // events — so on an @all turn the floor visibly passes from one agent to the
    // other. Between streams (thinking, tool time) the ring stays with whoever
    // spoke last; before any stream at all it sits on the first named agent.
    const AGENT_ORDER = ['claude', 'codex'];
    function agentsFor(target) {
      const named = D.turnAgents[target] || [];
      const list = named.length ? named : (D.liveAgents[target] || []);
      return list.slice().sort((a, b) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b));
    }
    function speakerFor(target) {
      const roster = agentsFor(target);
      const s = D.speaker[target];
      return (s && roster.indexOf(s) !== -1) ? s : (roster[0] || null);
    }
    function workingLabel(targets) {
      const seen = [];
      for (const t of targets) for (const a of agentsFor(t)) if (seen.indexOf(a) === -1) seen.push(a);
      seen.sort((a, b) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b));
      if (!seen.length) return 'agents are working…';
      if (seen.length === 1) return seen[0] + ' is working…';
      return seen.join(' + ') + ' are working…';
    }
    function chipAvatars(targets) {
      const roster = [], speaking = [];
      for (const t of targets) {
        for (const a of agentsFor(t)) if (MARKS[a] && roster.indexOf(a) === -1) roster.push(a);
        const s = speakerFor(t);
        if (s && MARKS[s] && speaking.indexOf(s) === -1) speaking.push(s);
      }
      if (!roster.length) return '';
      roster.sort((a, b) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b));
      return '<span class="chip-agents">' +
        roster.map(a => avatarHtml(a, speaking.indexOf(a) !== -1)).join('') + '</span>';
    }
    // a companion that names nobody at all still gets an honest chip
    const chipBody = targets => chipAvatars(targets) || `<span class="spin">◐</span>agents are working…`;

    // The chip and the note are two different facts and can both be true at
    // once: a `chat`/`error` event now arrives MID-TURN (the companion denies
    // every bot file-write and says so, then lets the turn finish). Showing
    // only the chip would swallow that message, and showing only the note
    // would claim the turn had stopped when it has not.
    // …with one exception, and it is the whole point of `transient`: a waiting
    // line ("queued…") is a claim about a turn that has NOT started, so the
    // chip does not sit beside it, it replaces it. Structural, so the promise
    // holds even if an event went missing.
    // A wait is a live state, so it looks like one: the same ◐ the working chip
    // falls back to. Flat text next to a composer reads as something that has
    // stalled — which is exactly how "queued…" was being read while the bridge
    // spent twenty seconds waking up.
    function statusHtml(target) {
      const note = D.notes[target];
      const noteHtml = note
        ? `<div class="status-chip${note.err ? ' err' : ''}">` +
          `${note.transient ? '<span class="spin">◐</span>' : ''}${esc(note.text)}</div>` : '';
      if (D.running[target]) {
        return `<div class="status-chip" aria-label="${esc(workingLabel([target]))}">${chipBody([target])}<button class="stop" data-act="interrupt" type="button" title="stop this turn">✕ stop</button></div>`
          + (note && note.transient ? '' : noteHtml);
      }
      return noteHtml;
    }

    // The composer is NEVER frozen by a send in flight: the message has already
    // left it (see D.outbox) and the next one can be typed straight away. The
    // one exception is a brand-new thread, where a second send before the
    // server has minted an id would create a second thread for the same
    // passage — that button waits.
    function composerHtml(target, label, extra, hint, pills) {
      const draft = D.drafts[target] || '';
      const busy = target === '__new__' && inFlight(target) ? ' disabled' : '';
      return `<div class="composer${draft.trim() ? ' has-draft' : ''}" data-target="${esc(target)}">
        ${pills ? routesHtml(target) : ''}
        <div class="mentions" role="listbox" aria-label="mentionable agents" hidden></div>
        <textarea rows="2" placeholder="${esc(label)}">${esc(draft)}</textarea>
        <div class="crow"><span class="hint">${esc(hint || HINT)}</span>${extra || ''}<button class="send" data-act="send" data-target="${esc(target)}" type="button"${busy}>Send</button></div>
      </div>`;
    }

    // ---- the pill row -------------------------------------------------------
    // A thread's SETTLED address: who the reader last wrote to here. The rule is
    // the companion's (chat.stickyRoute) and this is the second copy of it —
    // deliberately, as normUrl and tagHue are duplicated across this boundary,
    // because the pill has to be lit before any round trip and a lit pill that
    // the server then disagreed with would be a lie. test/tags.test.mjs's
    // pattern applies: the copies are asserted against each other in the tests.
    //
    // Only the reader's own messages count (a bot writing "@codex, over to you"
    // is not an instruction from the reader), `tools` narration counts for
    // nothing, and a message says where it went either in its words or in the
    // `route` the companion stamped on it when a pill said it instead.
    function stickyRouteOf(target) {
      const msgs = realMsgs(target);
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.kind === 'tools' || isBot(m.author)) continue;
        return routeWordOf(m.text) || String(m.route || '').trim().replace(/^@/, '') || 'none';
      }
      return 'none';
    }
    // the tag a message's own words carry, as a pill name — the same strict
    // rule the companion routes by (chat.routePrefix): one bot named is that
    // bot's, @all or both named is the room's, nothing named is nothing
    function routeWordOf(text) {
      const found = String(text || '').match(/@(claude|codex|all)\b/gi) || [];
      const tags = [];
      for (const f of found) {
        const h = f.slice(1).toLowerCase();
        if (tags.indexOf(h) === -1) tags.push(h);
      }
      if (!tags.length) return '';
      return (tags.indexOf('all') >= 0 || tags.length > 1) ? 'all' : tags[0];
    }
    // What the NEXT message in this composer will do: the pill the reader
    // clicked, else the thread's sticky address — overruled live by a tag
    // actually typed into the box, because that is the message that will be
    // sent and the row must not claim otherwise while it is being written.
    function routeNow(target) {
      const typed = routeWordOf(D.drafts[target] || '');
      if (typed) return typed;
      return D.routes[target] || stickyRouteOf(target);
    }
    function routesHtml(target) {
      const now = routeNow(target);
      const pills = ['none'].concat(agentRoster(), ['all']);
      return `<div class="routes" role="group" aria-label="who this message is for">`
        + pills.map(h => `<button class="rpill${h === now ? ' on' : ''}" type="button"
            data-act="route" data-target="${esc(target)}" data-route="${esc(h)}"
            aria-pressed="${h === now}" title="${esc(routeTip(h))}">${esc(routeLabel(h))}</button>`).join('')
        + `</div>`;
    }
    // Typing "@codex" into the box must light Codex the moment it is typed —
    // the row is a promise about the next send, and a stale promise beside a
    // half-typed tag is exactly the confusion the pills exist to end. Repainted
    // in place rather than through render(), because re-rendering a composer
    // under a caret is how you lose the caret.
    function syncRoutes(ta) {
      const box = ta && ta.closest && ta.closest('.composer');
      const row = box && box.querySelector('.routes');
      if (!row) return;
      const target = box.getAttribute('data-target');
      const typed = routeWordOf(ta.value);
      const now = typed || D.routes[target] || stickyRouteOf(target);
      row.querySelectorAll('.rpill').forEach(b => {
        const on = b.dataset.route === now;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    // Clicking a pill is not a send: it sets where the next message goes and
    // repaints the row, leaving the draft (and the caret) exactly where it was.
    function pickRoute(target, route) {
      if (!target || !route) return;
      harvestDrafts();
      D.routes[target] = route;
      render();
      const box = composerBox(target);
      if (box) box.focus();
    }

    // ---- the @-menu ---------------------------------------------------------
    // Typing "@" in any composer opens a short list of who can be summoned.
    // The list is whatever the companion has told us about (the same agent
    // data the gear popover reads) plus @all — nothing about claude or codex
    // is written into this file's behaviour. Everything about it is optional:
    // no match closes it, Esc closes it, and a literal "@" in prose is left
    // completely alone (see MENTION_OPENER).
    function agentRoster() {
      const m = D.models || {};
      const keys = o => (o && typeof o === 'object' ? Object.keys(o) : []);
      const seen = [];
      for (const list of [keys(m.current), keys(m.status), keys(m.effort && m.effort.current)]) {
        for (const a of list) {
          if (a && a !== 'auto_relay' && seen.indexOf(a) === -1) seen.push(a);
        }
      }
      // a companion that has not spoken yet still has to offer something: the
      // agents this build ships logomarks for, in the order it draws them
      const roster = seen.length ? seen : Object.keys(MARKS);
      return roster.slice().sort((a, b) => AGENT_ORDER.indexOf(a) - AGENT_ORDER.indexOf(b));
    }

    // @all has no logomark of its own, so it wears the braid: three strands,
    // which is exactly what it means.
    const mentionMark = h => (MARKS[h]
      ? `<span class="mmark" style="color:var(--${h})">${MARKS[h]}</span>`
      : `<span class="mmark">${BRAID_SVG}</span>`);

    function menuFor(target) {
      return D.mounted &&
        D.shadow.querySelector('.composer[data-target="' + cssq(target) + '"] .mentions');
    }

    function closeMention() {
      if (D.mounted) {
        D.shadow.querySelectorAll('.mentions').forEach(m => { m.hidden = true; m.innerHTML = ''; });
      }
      D.mention = null;
    }

    function paintMention() {
      const m = D.mention;
      const menu = m && menuFor(m.target);
      if (!menu) return;
      menu.innerHTML = m.items.map((h, i) =>
        `<button class="mrow${i === m.index ? ' on' : ''}" type="button" role="option"
           aria-selected="${i === m.index}" data-act="mention" data-handle="${esc(h)}"
           data-target="${esc(m.target)}">${mentionMark(h)}<span class="mname">@${esc(h)}</span></button>`).join('');
      menu.hidden = false;
    }

    // Recompute from the box itself: what is typed and where the caret is are
    // the only inputs, so this is safe to call from input, keyup and click.
    function syncMention(ta) {
      const box = ta && ta.closest && ta.closest('.composer');
      if (!box) return closeMention();
      const target = box.getAttribute('data-target');
      const tok = mentionToken(ta.value, ta.selectionStart);
      const items = tok ? mentionCandidates(agentRoster(), tok.query) : [];
      // nothing matches what is being typed: the menu goes away and the typing
      // carries on untouched — never a swallowed keystroke
      if (!tok || !items.length) return closeMention();
      const same = D.mention && D.mention.target === target &&
        D.mention.items.join(',') === items.join(',');
      const index = same ? Math.min(D.mention.index, items.length - 1) : 0;
      D.mention = { target, start: tok.start, end: tok.end, caret: tok.end, items, index };
      paintMention();
    }

    // Completing writes "@handle " — with the trailing space, because the
    // mention is finished and the sentence goes on.
    function insertMention(handle) {
      const m = D.mention;
      if (!m || !handle) return closeMention();
      const ta = composerBox(m.target);
      if (!ta) return closeMention();
      const v = ta.value;
      const ins = '@' + handle + ' ';
      const before = v.slice(0, m.start);
      ta.value = before + ins + v.slice(m.end);
      const caret = before.length + ins.length;
      D.drafts[m.target] = ta.value;
      closeMention();
      ta.focus();
      ta.setSelectionRange(caret, caret);
    }

    // render() rebuilds the composer, so an open menu has to be put back —
    // together with the caret, which is the only thing that makes it mean
    // anything. Only ever while the menu was already open.
    function restoreMention() {
      const m = D.mention;
      if (!m) return;
      const ta = composerBox(m.target);
      if (!ta) { D.mention = null; return; }
      paintMention();
      ta.focus();
      ta.setSelectionRange(m.caret, m.caret);
    }

    // ---- the outbox: messages sent but not yet confirmed -------------------
    // Rendered as ordinary messages so the thread reads in the order it was
    // written, dimmed with a spinner while the POST is out, and turned into a
    // retry/discard row if it fails. Everything here is per-target.
    const SENDING_TEXT = 'reaching botference…';
    const SEND_FAIL = 'couldn’t reach the companion';
    let outSeq = 0;

    const outboxFor = t => D.outbox[t] || [];
    const inFlight = t => outboxFor(t).some(e => e.state === 'sending');
    // Where the settled messages of ANY conversation live: the page chat, one
    // comment thread, or the library. Everything in here is keyed by target and
    // three different places used to fork on `target === PAGE_TARGET`; this is
    // that fork, once. `create` is for the one caller that appends.
    function msgListFor(target, create) {
      if (target === LIBRARY_TARGET) {
        const lib = D.library.page;
        if (!lib) return null;
        return lib.page_chat || (create ? (lib.page_chat = []) : null);
      }
      if (!D.page) return null;
      if (target === PAGE_TARGET) return D.page.page_chat || (create ? (D.page.page_chat = []) : null);
      const t = (D.page.threads || []).find(x => x.id === target);
      return (t && t.msgs) || null;
    }
    function realMsgs(target) {
      return msgListFor(target) || [];
    }
    // How many human messages with exactly this text the record already holds.
    // The pending copy is hidden as soon as that count passes the number it was
    // created with — which is how the same message never appears twice even
    // though the record can be updated (setPage, a `page` refetch, another tab)
    // BEFORE the POST that carried it resolves here.
    function countSame(target, text) {
      const t = String(text == null ? '' : text).trim();
      let n = 0;
      for (const m of realMsgs(target)) {
        if (m && !isBot(m.author) && String(m.text == null ? '' : m.text).trim() === t) n++;
      }
      return n;
    }
    function outboxVisible(target) {
      return outboxFor(target).filter(e =>
        e.state === 'failed' || countSame(target, e.text) <= e.seen);
    }
    function outboxHtml(target) {
      const author = D.author || opts.author || 'you';
      return outboxVisible(target).map(e => {
        const failed = e.state === 'failed';
        const state = failed
          ? `<div class="sendstate err"><span class="stext">${esc(e.error || SEND_FAIL)}</span>` +
            `<button class="rebtn retry" data-act="send-retry" data-target="${esc(target)}" data-out="${esc(e.id)}" type="button" title="send it again">↻ retry</button>` +
            `<button class="rebtn discard" data-act="send-discard" data-target="${esc(target)}" data-out="${esc(e.id)}" type="button" title="put it back in the box" aria-label="discard">✕</button></div>`
          : `<div class="sendstate"><span class="spin">◐</span><span class="stext">${esc(SENDING_TEXT)}</span></div>`;
        // rendered exactly like the settled message it is about to become, so
        // nothing reflows or reformats under the reader when it lands
        return `<div class="reply mine sending${failed ? ' failed' : ''}" data-out="${esc(e.id)}" style="--author:${MY_COLOR}">
          <span class="who"><span class="author">${esc(author)}</span><span class="when">now</span></span>
          <div class="ctext md" data-md="${esc(mdSlot(e.text))}"></div>${state}</div>`;
      }).join('');
    }

    const isResolved = t => !!(t && t.resolved);
    // The middle state. A bot has replied into this thread since the reader
    // last wrote in it, so it is waiting on the READER now, not on the bots —
    // "ready for review", never "resolved": closing the reader's question is
    // the reader's click and nothing else's.
    const isAddressed = t => !!(t && t.addressed && !t.resolved);
    // `extra` rides INSIDE the quote, flowing after the closing curly quote the
    // way the orphan badge always has — a badge in the row beside it would take
    // a flex share and squeeze a three-line quote down to a column.
    const quoteHtml = (t, orph, extra) =>
      `<div class="quote" data-act="jump" data-target="${esc(t.id)}" title="${orph ? 'the anchor text is gone from this page' : 'scroll to this highlight'}">“${esc(t.quote)}”${orph ? '<span class="badge orphan-badge">orphaned</span>' : ''}${extra || ''}</div>`;

    // The resolve control. One click, no confirm, no menu, no dialog: the
    // reader is triaging a page with forty threads on it and the whole value
    // of this is that the list shrinks as fast as they can click. Reopen IS
    // the undo, and it is one click too — so there is nothing to confirm.
    //
    // Quiet on purpose: a ✓ at the same weight and opacity as the ✕ beside it,
    // showing on hover like every other per-row control, because a control
    // that shouted would add its own clutter to the very rows it exists to
    // clear away.
    const resolveBtn = t => (D.resolving[t.id]
      ? `<span class="rebtn thr-res busy" aria-hidden="true">◌</span>`
      : `<button class="rebtn thr-res" data-act="resolve" data-target="${esc(t.id)}" type="button" title="resolve — it files itself below and the highlight turns green" aria-label="resolve this thread">✓</button>`);
    const reopenBtn = t => (D.resolving[t.id]
      ? `<span class="rebtn thr-res busy" aria-hidden="true">◌</span>`
      : `<button class="rebtn thr-reopen" data-act="reopen" data-target="${esc(t.id)}" type="button" title="reopen — back to the list, highlight back to yellow" aria-label="reopen this thread">↺</button>`);
    // …and the same undo one rung lower: "not done" takes a thread OUT of
    // Ready for review and back into the open list. It sits beside the ✓ and
    // not instead of it — the reader may agree (✓, which files it) or disagree
    // (↺, which puts it back in the queue), and both are one click.
    const notDoneBtn = t => (D.addressing[t.id]
      ? `<span class="rebtn thr-res busy" aria-hidden="true">◌</span>`
      : `<button class="rebtn thr-notdone" data-act="not-done" data-target="${esc(t.id)}" type="button" title="not done — back to the open list, highlight back to yellow" aria-label="put this thread back in the open list">↺</button>`);

    // ---- before → after, when a bot's change rewrote the passage -----------
    //
    // A change that rewrites the quoted passage ORPHANS the highlight: the
    // thread still carries the old wording, the page no longer contains it,
    // and the reader is left re-reading the draft to find out what replaced
    // it. The bots are asked (bridge-system-prompt rule 5) to quote the new
    // wording back — "this passage now reads: “…”" — and that one line is
    // enough to draw the difference here, with no new data and nothing
    // server-side.
    //
    // Only on a READY thread, only from a BOT's message, and only on that
    // explicit phrasing. A loose "quoted string in a reply" rule would draw a
    // diff every time an agent quoted the reader back at themselves.
    // The parse itself lives in anchor.js, beside the LOCATING it also feeds:
    // the same sentence that draws this diff is what moves the highlight onto
    // the rewritten passage, and two copies of the rule could drift into a
    // card that draws a change the page does not show (or the reverse).
    const NOW_READS = /\b(?:(?:now reads|reads now|now says|new wording(?: is)?)\b\s*[:—-]?|(?:reworded|rewritten|rewrote)\b[^"“\n]{0,80}[:—-]|(?:changed|updated)(?: it)? to\b\s*[:—-]?)\s*[“"']([\s\S]{4,400}?)[”"']/i;
    const ANCH = (typeof BFPAnchor !== 'undefined' && BFPAnchor) ? BFPAnchor : null;
    const newWordingOf = t => {
      if (ANCH && ANCH.newWording) return ANCH.newWording(t);
      const msgs = (t && t.msgs) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.kind === 'tools' || !isBot(m.author)) continue;
        const hit = NOW_READS.exec(String(m.text || ''));
        return hit ? hit[1].trim() : '';   // the LAST bot word on it, or nothing
      }
      return '';
    };
    // Word-level LCS. Both sides are one passage, so the quadratic table is
    // small — and anything unreasonable falls back to the stacked pair below
    // rather than being diffed at any cost.
    const DIFF_WORDS_MAX = 220;
    // words only — the whitespace between them is never diffed, and every run
    // is re-joined with a single space. Diffing the gaps as tokens is what
    // makes a word diff render as "beenhad ingone": the space ends up inside
    // one side of the change and the two runs collide.
    const words = s => String(s).trim().split(/\s+/).filter(Boolean);
    function wordDiff(a, b) {
      const A = words(a), B = words(b);
      if (!A.length || !B.length || A.length > DIFF_WORDS_MAX || B.length > DIFF_WORDS_MAX) return null;
      const n = A.length, m = B.length;
      const L = new Uint16Array((n + 1) * (m + 1));
      const at = (i, j) => i * (m + 1) + j;
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          L[at(i, j)] = A[i] === B[j] ? L[at(i + 1, j + 1)] + 1
            : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
        }
      }
      const ops = [];           // {t:'=' | '-' | '+', s} — s is a run of words
      const push = (t, w) => {
        const last = ops[ops.length - 1];
        if (last && last.t === t) last.s += ' ' + w; else ops.push({ t, s: w });
      };
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { push('=', A[i]); i++; j++; }
        else if (L[at(i + 1, j)] >= L[at(i, j + 1)]) { push('-', A[i]); i++; }
        else { push('+', B[j]); j++; }
      }
      while (i < n) push('-', A[i++]);
      while (j < m) push('+', B[j++]);
      const kept = ops.filter(o => o.t === '=').reduce((s, o) => s + o.s.length, 0);
      // nothing recognisably shared: two different sentences, not an edit —
      // a diff of those is confetti, and the stacked pair is the honest read
      if (kept < Math.min(String(a).trim().length, String(b).trim().length) * 0.2) return null;
      return ops;
    }
    // The same suggested-edit idiom the review engine uses: struck-through
    // where words left, the accepted tint where they arrived. On any doubt —
    // no shared words, a passage too long to diff — the two are simply stacked
    // and labelled, which says the same thing and can never mislead.
    function rewriteHtml(t) {
      // Normally the "now" half is what a bot SAID the passage now reads: the
      // thread was anchored to the old wording and the sentence is the only
      // thing that knows where the change landed.
      //
      // A thread the companion's turn-end diff wrote (`auto`) inherits none of
      // that and needs none of it: there was no comment at that passage, so no
      // bot ever narrated it — the thread was BORN anchored to the new wording,
      // with `prior_quote` carrying what it replaced. So the quote itself is
      // the "now", and the card draws the same before→after the page is already
      // drawing. (An auto-thread on an INSERTION has no prior_quote, `was`
      // falls back to the quote, and the guard below correctly draws nothing:
      // text that arrived where there was none has no before half.)
      // A DELETION is not a rewrite and must not be drawn as one. There is no
      // "now" wording — the passage is gone, and the quote the thread carries
      // is the surviving paragraph it was re-anchored to so the comment has
      // somewhere to stand. Word-diffing "the sentence that left" against "the
      // paragraph that outlived it" would render as an edit that never
      // happened, so the card says the plain thing instead.
      if (t.deleted_passage) {
        const gone = String(t.prior_quote || '').trim();
        if (!gone) return '';
        return `<div class="wasnow" data-deleted="1">`
          + `<span class="wnhead">this passage was deleted</span>`
          + `<div class="wnstack"><div class="wnrow"><span class="wnlab">gone</span>`
          + `<span class="wnval"><del>${esc(gone)}</del></span></div>`
          + `<div class="wnrow"><span class="wnlab">now on</span>`
          + `<span class="wnval">${esc(String(t.quote || ''))}</span></div></div></div>`;
      }
      // A thread the turn-end diff HEALED (`healed_at`) is in the same position
      // an auto-thread is: nobody narrated the change, so there is no sentence
      // to parse — the quote it now carries IS the new wording, because the
      // diff put it there out of the file's own bytes.
      const now = newWordingOf(t) || (t.auto || t.healed_at ? String(t.quote || '') : '');
      if (!now) return '';
      // `prior_quote` is the wording the thread was ANCHORED to before the
      // page re-anchored it onto the rewrite. Once that has happened `quote`
      // IS the new wording, and diffing it against itself would draw nothing —
      // so the original is what the "was" half reads from wherever it exists.
      const was = String(t.prior_quote || t.quote || '');
      if (!was.trim() || was.trim() === now.trim()) return '';
      const ops = wordDiff(was, now);
      const body = ops
        ? `<div class="wndiff">${ops.map(o => o.t === '=' ? esc(o.s)
            : o.t === '-' ? `<del>${esc(o.s)}</del>` : `<ins>${esc(o.s)}</ins>`).join(' ')}</div>`
        : `<div class="wnstack"><div class="wnrow"><span class="wnlab">was</span><span class="wnval">${esc(was)}</span></div>`
          + `<div class="wnrow"><span class="wnlab">now</span><span class="wnval">${esc(now)}</span></div></div>`;
      return `<div class="wasnow"${ops ? '' : ' data-stacked="1"'}>`
        + `<span class="wnhead">the passage was rewritten</span>${body}</div>`;
    }

    function cardHtml(t) {
      const orph = D.orphans[t.id] != null ? D.orphans[t.id] : !!t.orphaned;
      const author = threadAuthor(t);
      const ready = isAddressed(t);
      const cls = ['card', ready ? 'ready' : '', orph ? 'orphaned' : '', D.focused === t.id ? 'focused' : '', D.running[t.id] ? 'working' : ''].filter(Boolean).join(' ');
      const msgs = msgsHtml(t.id, t.msgs);
      // one-step inline confirm — never a browser confirm() dialog, which the
      // page's own modals and focus traps would fight with
      const head = D.confirm === t.id
        ? `<div class="confirm">delete thread?
             <button class="rebtn yes" data-act="del-thread-yes" data-target="${esc(t.id)}" type="button">yes</button>
             <button class="rebtn" data-act="del-thread-no" type="button">no</button></div>`
        : `${resolveBtn(t)}${ready ? notDoneBtn(t) : ''}<button class="rebtn thr-del" data-act="del-thread" data-target="${esc(t.id)}" type="button" title="delete this thread" aria-label="delete thread">✕</button>`;
      // The badge says WHICH bot claimed it and leaves the verdict to the
      // reader — "ready for review", never "done". It rides the quote row, the
      // one line of the card that is always visible however long the thread.
      const badge = ready
        ? `<span class="badge ready-badge" title="${esc((t.addressed_by ? t.addressed_by + ' has' : 'a bot has')
            + ' replied here since you last wrote — resolving is still your click')}">ready for review</span>`
        : '';
      return `<div class="${cls}" data-thread="${esc(t.id)}" style="--author:${speakerColor(author)}">
        <div class="chead">
          ${quoteHtml(t, orph, badge)}
          ${head}
        </div>
        ${ready ? rewriteHtml(t) : ''}
        <div class="thread">${msgs}${outboxHtml(t.id)}${streamsHtml(t.id)}</div>
        ${statusHtml(t.id)}
        ${composerHtml(t.id, 'Reply…', '', '', true)}
      </div>`;
    }

    // A FILED thread, and the reason the archive is worth opening: not a
    // dimmed copy of the thread but a record OF it — the passage, and a
    // paragraph saying what the comment asked and what came of it. The
    // Resolved section read top to bottom is then a digest of decisions,
    // which is the thing a reader actually wants weeks later; the thread
    // itself is still right there, one click down, in place.
    //
    // `summary` is whatever the record holds: the instant heuristic the
    // companion wrote when the reader clicked resolve, or the agents' three
    // to five sentences once that job has drained over the top of it. The
    // card cannot tell and does not need to.
    function resolvedCardHtml(t) {
      const orph = D.orphans[t.id] != null ? D.orphans[t.id] : !!t.orphaned;
      const open = !!D.resolvedCards[t.id];
      const author = threadAuthor(t);
      const cls = ['card', 'resolved', open ? 'unfolded' : '', orph ? 'orphaned' : '',
        D.focused === t.id ? 'focused' : '', D.running[t.id] ? 'working' : ''].filter(Boolean).join(' ');
      const n = (t.msgs || []).length;
      const by = t.resolved_by ? ` by ${esc(t.resolved_by)}` : '';
      const pending = !t.summary_by;   // still the companion's placeholder
      return `<div class="${cls}" data-thread="${esc(t.id)}" style="--author:${speakerColor(author)}">
        <div class="chead">
          ${quoteHtml(t, orph)}
          ${reopenBtn(t)}
        </div>
        <p class="digest${pending ? ' provisional' : ''}">${esc(t.summary || '')}</p>
        <div class="drow">
          <button class="dtoggle" data-act="resolved-card" data-target="${esc(t.id)}" type="button" aria-expanded="${open ? 'true' : 'false'}">${open ? '▾ hide the thread' : `▸ show the thread (${n} message${n === 1 ? '' : 's'})`}</button>
          <span class="dmeta" title="resolved${by}">${pending ? 'summarizing…' : `filed${by}`}</span>
          <button class="rebtn dsum" data-act="summarize" data-target="${esc(t.id)}" type="button" title="ask the agents to write this summary again" aria-label="rewrite this summary">↻</button>
        </div>
        ${open ? `<div class="thread">${msgsHtml(t.id, t.msgs)}${outboxHtml(t.id)}${streamsHtml(t.id)}</div>
          ${statusHtml(t.id)}
          ${composerHtml(t.id, 'Reply — replying reopens this thread…', '', '', true)}` : ''}
      </div>`;
    }

    function pendingHtml() {
      const p = D.pending;
      const out = outboxHtml('__new__');
      return `<div class="card pending${D.focused === '__new__' ? ' focused' : ''}" data-thread="__new__" style="--author:${MY_COLOR}">
        <div class="quote" title="the passage you selected">“${esc(p.quote)}”</div>
        ${out ? `<div class="thread">${out}</div>` : ''}
        ${composerHtml('__new__', 'Comment on this passage…',
          '<button class="cancel" data-act="cancel-new" type="button">Cancel</button>', '', true)}
        ${statusHtml('__new__')}
      </div>`;
    }

    // Whose messages carry the edit affordance. A page's messages may now come
    // from ANY handle (a shared companion), so "mine" is the identity this
    // browser is configured with — the handle from the options page, or, on a
    // local companion, whatever the owner is called. content.js supplies it
    // (setAuthor) as soon as the background has answered.
    const sameAuthor = a =>
      String(a || '').toLowerCase() === String(D.author || opts.author || 'angadh').toLowerCase();

    // The reader's own colour is the braid's green, not a hash of their handle
    // — theirs is the one identity in the transcript somebody is actually
    // looking for while scrolling, and the one the eye should find without
    // reading. Every other handle on a shared companion keeps its hue.
    const MY_COLOR = 'var(--you)';
    const speakerColor = a => (!isBot(a) && sameAuthor(a)) ? MY_COLOR : authorColor(a);

    // The companion is a process the user has to have started. When it is down
    // that is the single most important thing on screen — so it gets the actual
    // steps, in order, with the commands as copyable code, not a name-drop and
    // not a 12px grey dot.
    const offlineHtml = () => (D.connKnown && !D.connected)
      ? `<div class="notice"><b>Companion offline — the plugin needs its local server:</b>` +
        `<ol class="steps">` +
        `<li>open Terminal</li>` +
        `<li>run: <code>botference plugin</code>` +
        `<div class="sub">first time? run it from your botference folder; after that it works from anywhere</div></li>` +
        `<li>come back and hit retry</li>` +
        `</ol>` +
        `<div class="alt">one-time alternative: <code>botference plugin --install-autostart</code> ` +
        `— starts at login, no terminal again (macOS)</div>` +
        `<button data-act="retry" type="button">↻ Retry connection</button></div>`
      : '';

    // Sites where nothing can be wrapped keep the pane (and its history) but
    // say so where the comments would be, in the same words as the tooltip.
    const nohlHtml = () => CAPS.highlights ? ''
      : `<div class="nohl">${esc(NOHL)}</div>`;

    // Which margin owns this page, said out loud, with the other choice next
    // to it.
    //
    // WHERE. At the top of the Comments tab, not behind a gear. The note is
    // the sentence that explains why the page's own 💬 stopped appearing (or
    // why ours did), and the switch is the answer to that sentence — putting
    // them anywhere apart makes the reader hunt for a setting they do not yet
    // know exists. A gear popover would also be a new surface on a drawer that
    // has none, and the Comments tab is precisely where a reader goes when
    // they wonder where their comments went.
    //
    // It is shown in BOTH states, so the arrangement is never a mystery and is
    // always one click from being the other one. The default state is the
    // quieter of the two: nothing has gone wrong, and the reader who never
    // wonders should not be made to read a box about it.
    const standdownHtml = () => {
      if (!RH.hosts || !CAPS.highlights) return '';
      const own = standDown();          // the page's own commenting has it
      return `<div class="standdown${own ? ' pageown' : ''}" role="status">` +
        `<span class="sdtext">${own
          ? esc('This page’s own review commenting is handling the margin — new comments there won’t reach the bots. Discuss threads already here still work.')
          : esc('Discuss is handling comments on this page, so its own 💬 is put away — one margin, and your comments reach the bots.')
        }</span>` +
        `<button class="sdbtn" data-act="page-comments" data-want="${own ? '0' : '1'}" type="button" ` +
        `title="${own ? esc('Comment with Discuss on this page instead') : esc('Give the margin back to this page’s own review commenting')}">` +
        `${own ? 'let Discuss comment here' : 'use the page’s own commenting'}</button></div>`;
    };

    // The reader's switch for the track changes on the PAGE — the old wording,
    // struck through, beside the wording a bot's change put in its place.
    //
    // WHERE. In the Comments pane with the standdown note, and for the same
    // reason: it is the answer to a question the page itself raises ("why is
    // there a struck sentence in my draft?"), and a setting behind a gear the
    // reader has to go looking for is a setting they never find. It renders
    // only where there IS such a passage — a control for something that is not
    // on the page is clutter in the pane the reader came here for.
    //
    // Default ON, which is the whole point: the change should be visible
    // without being asked for.
    const trackHtml = () => {
      if (!TC.threads.length || !CAPS.highlights) return '';
      const n = TC.threads.length;
      const what = n === 1 ? 'One passage on this page was rewritten'
        : `${n} passages on this page were rewritten`;
      return `<div class="trackbar${TC.on ? ' on' : ''}" role="status">` +
        `<span class="tctext">${esc(what)}${TC.on
          ? esc(' — the old wording is shown struck through, in place.')
          : esc(' — the changes are hidden on the page.')}</span>` +
        `<button class="sdbtn" data-act="track-changes" data-want="${TC.on ? '0' : '1'}" type="button" ` +
        `title="${TC.on ? esc('Hide the struck-through old wording on the page')
          : esc('Show the old wording, struck through, where each change landed')}">` +
        `${TC.on ? 'hide changes on the page' : 'show changes on the page'}</button></div>`;
    };

    // Something the bots are about to answer WITHOUT — the page text a site
    // adapter could not read (content.js sets it). It belongs in Page chat
    // because that is where the user is typing the question, and it is
    // dismissible because it reports a turn already spent, not a task: there
    // is nothing to do here but reload the tab.
    const warnHtml = () => D.warn
      ? `<div class="ctxwarn" role="status"><span class="wtext">${esc(D.warn)}</span>` +
        `<button class="rebtn wclose" data-act="warn-dismiss" type="button" ` +
        `title="Dismiss" aria-label="Dismiss this warning">✕</button></div>`
      : '';

    // ── the tasks card: the current checklist, never lost to scroll ────────
    // The bots write and rewrite markdown checklists as a plan moves, and the
    // live one ends up wherever the conversation happened to leave it — twenty
    // replies up a comment thread, or above a bot turn in Page chat. So the top
    // of the drawer carries the checklist from the NEWEST message on this page
    // that has one, whichever conversation it is in, and a revised list
    // REPLACES it: there is only ever one list here and it is the current one.
    // No list anywhere on the page → no card.
    //
    // It is rendered into BOTH panes (renderComments and renderChat), at the
    // top of each pane's own scrolling content. The tab bar sits above the
    // panes and each pane scrolls alone, so there is no shared strip to pin it
    // to — and a list that came out of a comment thread is exactly what a
    // reader typing in Page chat needs to see. Both copies are built from the
    // same message text, so they cannot disagree.
    //
    // NOTHING is stored and nothing is remembered: `D.tasks` is recomputed
    // from the record on the render paths that already exist (a message
    // arriving, a tick coming back, a refetch), which is why a revision
    // replaces the card by itself and why there is no polling here.
    //
    // Ticks are the transcript's own ticks — the SAME /tick call, which is a
    // message edit the companion performs and answers with (see "checklists"
    // below). The card holds no checkbox state of its own; both renderings come
    // out of the message text, so they move together by construction.
    const READONLY_TIP = 'this list lives in the council chat — tick it there';
    // The same shape renderMarkdown's BULLET/NUMBER + TASK pair recognises, so
    // "there is a checklist in here" and "these are its boxes" can never
    // disagree. Deliberately not run over the envelope-stripped text: a room
    // footer is JSON and cannot hold a checklist line.
    const TASK_LINE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]\s/;
    const hasTasks = text =>
      String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n').some(l => TASK_LINE.test(l));

    // How old a message is, for "newest wins". A live message has a real
    // timestamp; a RESTORED one (workspace.mjs sessionTail) has an ADDRESS
    // (`<sid>#<n>`) and no date at all — and it is history: every live message
    // on the page was written after the council chat it was restored from. So
    // restored messages sort below everything live, and among themselves by
    // their ordinal in the session.
    function msgAge(m) {
      if (m && m.restored) {
        const n = Number(String(m.ts || '').split('#')[1]);
        return -1e15 + (isFinite(n) ? n : 0);
      }
      const t = Date.parse((m && m.ts) || '');
      return isFinite(t) ? t : 0;
    }

    // The newest message on this page carrying a checklist, across every
    // comment thread AND page chat. Each conversation is scanned from its END
    // and abandoned at its first hit — its own array order is authoritative, so
    // that is one comparison per conversation, not one per message.
    function taskSource() {
      const convos = ((D.page && D.page.threads) || []).map(t => ({ target: t.id, thread: t, msgs: t.msgs || [] }));
      // page chat last: it is the live conversation, so it takes a tie (two
      // messages CAN share a millisecond — see findMsg)
      convos.push({ target: PAGE_TARGET, thread: null, msgs: (D.page && D.page.page_chat) || [] });
      let best = null;
      for (const c of convos) {
        for (let i = c.msgs.length - 1; i >= 0; i--) {
          const m = c.msgs[i];
          // a tool-activity row is process detail, not an answer, and is not
          // rendered as markdown at all
          if (!m || m.kind === 'tools' || !hasTasks(m.text)) continue;
          const key = msgAge(m);
          // an ADDRESS, not the object: the card resolves it through findMsg,
          // exactly as the transcript's own renderer and /tick do, so the two
          // cannot end up rendering two different copies of one message
          if (!best || key >= best.key) {
            best = { target: c.target, thread: c.thread, ts: m.ts, author: m.author,
                     restored: !!m.restored, key };
          }
          break;
        }
      }
      return best;
    }
    // the message the card is showing, addressed the way every other
    // message-addressing path in here addresses one
    const taskMsg = () => (D.tasks ? findMsg(D.tasks.target, D.tasks.ts, D.tasks.author) : null);

    const trunc = (s, n) => {
      const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      return t.length > n ? t.slice(0, n - 1) + '…' : t;
    };

    // The shell only. The list itself is DOM, built by fillTasks() from the
    // message text — markdown never travels as an HTML string in here.
    function taskCardHtml() {
      const s = D.tasks;
      if (!s) return '';
      const open = D.tasksOpen;
      const ro = !!s.restored;
      const hide = open ? '' : ' hidden';
      return `<div class="tasks${open ? '' : ' folded'}${ro ? ' ro' : ''}"
        data-taskfor="${esc(s.target)}" data-taskts="${esc(s.ts)}" data-taskauthor="${esc(s.author)}"
        style="--author:${speakerColor(s.author)}">
        <div class="taskhead">
          <button class="taskfold" data-act="tasks-fold" type="button" aria-expanded="${open ? 'true' : 'false'}"
            title="${open ? 'fold the task list away' : 'show the task list'}">
            <span class="tcaret" aria-hidden="true">${open ? '▾' : '▸'}</span>Tasks<span class="tcount"></span></button>
          <button class="rebtn taskjump" data-act="tasks-jump" type="button"
            title="go to the message this list came from" aria-label="go to the message this list came from">↑ source</button>
        </div>
        <div class="taskbody"${hide}></div>
        ${ro ? `<div class="tasknote"${hide}>from the council chat — tick it there</div>` : ''}
        <div class="taskmeta"${hide}></div>
      </div>`;
    }

    // Move the checklists out of a fresh rendering of the source message and
    // into the card — the lists only, never the prose around them. Rendering
    // the WHOLE message is the point: `data-tick` is an ordinal over the
    // message, so the card's boxes address exactly the same boxes the
    // transcript's do, and a /tick from either lands on the same line.
    function fillTasks() {
      const s = D.tasks;
      const msg = taskMsg();
      if (!D.mounted || !s || !msg) return;
      const text = splitEnvelopes(String(msg.text == null ? '' : msg.text)).text;
      D.shadow.querySelectorAll('.tasks').forEach(sec => {
        const body = sec.querySelector('.taskbody');
        if (!body) return;
        body.textContent = '';
        const frag = renderMarkdown(text);
        frag.querySelectorAll('ul.md-tasklist, ol.md-tasklist').forEach(l => body.appendChild(l));
        const boxes = [...body.querySelectorAll('.md-tick')];
        const done = boxes.filter(b => b.checked).length;
        // A restored council message is READ-ONLY here for the same reason it
        // is offered no ✎ and no ✕ in the transcript: ticking it would mean
        // editing a council session this companion does not own. The list still
        // shows, and ↑ source still goes to it.
        if (s.restored) boxes.forEach(b => { b.disabled = true; b.title = READONLY_TIP; });
        const count = sec.querySelector('.tcount');
        if (count) count.textContent = boxes.length ? `${done}/${boxes.length}` : '';
        const meta = sec.querySelector('.taskmeta');
        if (meta) {
          meta.textContent = [
            s.author || '',
            `${done}/${boxes.length} done`,
            s.thread ? '“' + trunc(s.thread.quote, 38) + '”' : 'page chat',
          ].filter(Boolean).join(' · ');
        }
      });
    }

    // ↑ source. Whatever it takes to put the message on screen: the right tab,
    // the thread unfolded (a long thread's middle is exactly where an older
    // list hides) and spotlit the way a highlight click spotlights it, then the
    // message itself flashed so the eye finds it among its neighbours.
    function jumpToTasks() {
      const s = D.tasks;
      if (!s || !D.mounted) return;
      const chat = s.target === PAGE_TARGET;
      if (D.view === 'pages') showThreads();
      if (D.tab !== (chat ? 'chat' : 'comments') && CAPS.highlights) {
        D.tab = chat ? 'chat' : 'comments';
        paintTabs();
        rememberTab();
      }
      D.expanded[s.target] = FOLD_OPEN;
      if (!chat) focus(s.target);            // reveals a FILED thread, and dims the rest
      render();                              // …and the unfold lands here
      const pane = chat ? D.el.chat : D.el.comments;
      const reply = [...pane.querySelectorAll('.reply[data-ts]')].find(r =>
        r.getAttribute('data-ts') === String(s.ts) &&
        r.getAttribute('data-author') === String(s.author));
      if (!reply) { if (!chat) scrollToThread(s.target); return; }
      const top = reply.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
      pane.scrollTop = Math.max(0, top - 10);
      reply.classList.add('tasksrc');
      setTimeout(() => reply.classList.remove('tasksrc'), 1600);
    }

    function renderComments() {
      const threads = (D.page && D.page.threads) || [];
      // three buckets, in the order a thread travels through them: still
      // waiting on somebody → answered and waiting on the reader → filed
      const live = threads.filter(t => !isResolved(t));
      const open = live.filter(t => !isAddressed(t));
      const ready = live.filter(isAddressed);
      const done = threads.filter(isResolved);
      let html = offlineHtml() + nohlHtml() + standdownHtml() + trackHtml() + taskCardHtml();
      html += D.pending ? pendingHtml() : '';
      // "select any text and hit 💬" is a lie where selection does nothing —
      // the note above has already said what to do instead. Same on a page
      // that owns its own margin: the stand-down note is the instruction.
      if (!threads.length && !D.pending && CAPS.highlights && !standDown()) {
        html += `<div class="empty"><b>No comments yet</b>Select any text on the page and hit 💬.</div>`;
      } else if (!live.length && !D.pending && CAPS.highlights && !standDown()) {
        // every thread on this page is filed — say so, rather than showing the
        // "no comments yet" line above a section full of them. (A thread that
        // is merely READY is not filed: it is exactly what the reader still
        // has to do, so "all clear" would be a lie while one is sitting there.)
        html += `<div class="empty allclear"><b>All clear</b>Every comment on this page is resolved.</div>`;
      }
      html += open.map(cardHtml).join('');
      // BETWEEN the open list and the archive, because that is where these
      // threads are in their life: past the bots, not yet past the reader.
      // Collapsible like the archive — a page whose whole review came back at
      // once would otherwise bury the threads still waiting on a bot — but
      // OPEN by default, and its cards are the ordinary cards, because a
      // thread here is still a live conversation that takes replies.
      if (ready.length) {
        html += `<div class="ready-sec${D.readyOpen ? ' open' : ''}">
          <button class="ready-head" data-act="ready-toggle" type="button" aria-expanded="${D.readyOpen ? 'true' : 'false'}">
            <span class="rcaret" aria-hidden="true">${D.readyOpen ? '▾' : '▸'}</span>Ready for review <span class="rcount">${ready.length}</span>
          </button>
          ${D.readyOpen ? `<div class="ready-list">${ready.map(cardHtml).join('')}</div>` : ''}
        </div>`;
      }
      // ONE collapsed section at the bottom, never a tab: the archive is the
      // foot of this page's list, not a place to navigate to. Closed by
      // default, and its cards are not built at all until it is opened — a
      // page with sixty filed threads must cost nothing to scroll past.
      if (done.length) {
        html += `<div class="resolved-sec${D.resolvedOpen ? ' open' : ''}">
          <button class="resolved-head" data-act="resolved-toggle" type="button" aria-expanded="${D.resolvedOpen ? 'true' : 'false'}">
            <span class="rcaret" aria-hidden="true">${D.resolvedOpen ? '▾' : '▸'}</span>Resolved <span class="rcount">${done.length}</span>
          </button>
          ${D.resolvedOpen ? `<div class="resolved-list">${done.map(resolvedCardHtml).join('')}</div>` : ''}
        </div>`;
      }
      D.el.comments.innerHTML = html;
      // the dim rides the PANE, not the cards, so a re-render mid-focus can't
      // strand a stale dim on rebuilt rows — the class survives innerHTML
      D.el.comments.classList.toggle('dim-others', !!D.focused);
      // the tab counts what still wants the reader — the list visibly shrinks
      // as they sweep down it, which is the whole point of resolving. A READY
      // thread still wants them (that is what ready means), so it counts:
      // the number is every unresolved thread, exactly as it always was.
      D.el.cCount.textContent = String(live.length);
    }

    // ---- Page chat on a project artifact page ---------------------------
    // Everywhere else Page chat is ONE conversation about the document in
    // front of you. Here the document came out of a project that already has
    // conversations, so the tab is that project's chat archive: which chat
    // this page is standing in, the rest of them, and the way between. What is
    // rendered underneath is unchanged — opening a past chat moves the page's
    // `session_id` and refills its `page_chat` with that chat's recent tail
    // (companion side), so the thread, the fold, the composer and the
    // streaming all work exactly as they always did.

    // "3d", "2h", "now" — a chat list wants to say how stale a thing is in
    // the width of a chip, not to print a date nobody reads.
    function shortAge(iso) {
      const t = Date.parse(String(iso || ''));
      if (!t) return '';
      const s = Math.max(0, (Date.now() - t) / 1000);
      if (s < 90) return 'now';
      if (s < 3600) return Math.round(s / 60) + 'm';
      if (s < 86400) return Math.round(s / 3600) + 'h';
      if (s < 86400 * 30) return Math.round(s / 86400) + 'd';
      if (s < 86400 * 365) return Math.round(s / (86400 * 30)) + 'mo';
      return Math.round(s / (86400 * 365)) + 'y';
    }

    // A directory with three familiar names in it is a hint, never a licence:
    // what hangs off a yes here is a bridge spawned with that folder as its
    // workspace, writing sessions into it. So it is asked once, in words, and
    // a no is kept as firmly as a yes.
    //
    // Since Phase 2 a yes also buys the bots an EDIT permission — scoped to
    // that one project's folder — and a question that did not say so would be
    // asking for consent to something else. So the card says it, in the
    // sentence the reader is agreeing to. An already-confirmed root is not
    // asked again (SPEC.md Phase 2): the answer stands, and the new wording is
    // for the next council the reader opens.
    function confirmRootHtml() {
      const p = D.project;
      if (!p) return '';
      return `<div class="card confirmroot">
        <div class="confirmq">Is this your council?</div>
        <p class="confirmp">This page is a file inside <code class="rootpath">${esc(p.root)}</code> — a folder that looks like a botference workspace.</p>
        <p class="confirmp">Say yes and the chat behind this page becomes the real chat of project <b>${esc(p.project_title || p.project_id)}</b>, filed in that workspace beside all its others — and the bots may edit that project&rsquo;s files when you ask them to. Nothing outside <code class="rootpath">projects/${esc(p.project_id)}/</code> is ever writable. Asked once per folder.</p>
        <div class="confirmacts">
          <button class="pbtn yes" data-act="root-yes" type="button">Yes, that is my council</button>
          <button class="pbtn no" data-act="root-no" type="button">No, leave this page alone</button>
        </div></div>`;
    }

    // How many comment threads a "send review" would actually send: the OPEN
    // ones. (workspace.openThreads applies the same rule server-side and is
    // the authority; this count exists so the button can say the number before
    // anything is sent, and so it can be disabled honestly when it is zero.)
    // (…and not the ADDRESSED ones either: a thread a bot has already replied
    // into is sitting under "Ready for review" waiting on the reader, and
    // sending it again would ask for work that has been reported. Re-sending
    // after a round is precisely what that state exists to prevent.)
    const openThreadCount = () =>
      (((D.page && D.page.threads) || []).filter(t =>
        t && !isResolved(t) && !isAddressed(t) && (t.msgs || []).length)).length;

    // Obsidian-export for a margin review: everything the reader wrote down
    // the side of the draft, handed over in one click and worked through one
    // comment per turn, without retyping any of it.
    //
    // Placement, twice decided. It is on the CHAT tab and not on Comments
    // where the threads are, because the chat is where the round OPENS (the
    // preamble) and where its receipt is: the answers now land in the threads,
    // but a button whose click showed nothing at all on the tab you are looking
    // at is a button that seems not to have worked. And it sits in its OWN row under the
    // archive bar rather than as a third control inside it — partly because
    // three buttons do not fit across a drawer that is often 320px wide, and
    // partly because it is not a chat control at all: the bar above says which
    // conversation you are in, and this says something about the DRAFT.
    function reviewHtml() {
      const r = D.review;
      const n = openThreadCount();
      const inner = r.busy
        ? `<span class="rvnote busy">handing ${n} comment${n === 1 ? '' : 's'} to the bots…</span>`
        : r.confirm
          ? `<span class="rvq">send ${n} open comment${n === 1 ? '' : 's'} to the bots?</span>
             <button class="rebtn yes" data-act="review-yes" type="button">yes</button>
             <button class="rebtn" data-act="review-no" type="button">no</button>`
          : `<button class="archsend" data-act="send-review" type="button"
               title="${esc(n
                 ? `hand all ${n} open comment${n === 1 ? '' : 's'} on this page to the bots — one turn each, answered in the threads`
                 : 'nothing to send yet — this page has no open comments. Highlight a passage and comment on it first.')}"${n ? '' : ' disabled'}>send review${n ? ` (${n})` : ''}</button>`
            + (r.err ? `<span class="rvnote err">${esc(r.err)}</span>`
              : r.note ? `<span class="rvnote note">${esc(r.note)}</span>` : '');
      return `<div class="reviewrow${r.confirm ? ' confirm' : ''}">${inner}</div>`;
    }

    function archiveHtml() {
      const p = D.project;
      if (!p || !p.confirmed) return '';
      const a = D.archive;
      const now = (D.page && D.page.session_title)
        || (D.page && D.page.session_id ? 'this chat' : '');
      const bar = `<div class="archbar">
        <button class="archpick" data-act="arch-list" type="button" aria-expanded="${D.picking ? 'true' : 'false'}"
          title="the chats in project ${esc(p.project_title || p.project_id)}">
          <span class="archnow">${esc(now || 'new chat')}</span><span class="chev">${D.picking ? '▴' : '▾'}</span></button>
        <button class="archnew" data-act="arch-new" type="button"
          title="start a new chat in this project"${a.busy ? ' disabled' : ''}>+ new</button>
      </div>` + reviewHtml();
      if (!D.picking) return bar;
      let body;
      if (a.loading) body = `<div class="archnote">reading this project&rsquo;s chats…</div>`;
      else if (a.err) body = `<div class="archnote err">${esc(a.err)}</div>`;
      else if (!a.list || !a.list.length) body = `<div class="archnote">no chats in this project yet</div>`;
      else {
        body = a.list.map(row => {
          const on = row.session_id === ((D.page && D.page.session_id) || a.current);
          return `<button class="archrow${on ? ' on' : ''}${a.busy === row.session_id ? ' busy' : ''}"
            data-act="arch-open" data-sid="${esc(row.session_id)}" type="button"${a.busy ? ' disabled' : ''}>
            <span class="at">${esc(row.title)}</span>
            <span class="ax">${esc(shortAge(row.updated_at || row.created_at))}</span></button>`;
        }).join('');
      }
      return bar + `<div class="archlist">${body}</div>`;
    }

    function renderChat() {
      // an unvouched-for council root has one thing on this tab and it is the
      // question — nothing else here is true until it is answered
      if (D.project && !D.project.confirmed) {
        D.el.chat.innerHTML = offlineHtml() + confirmRootHtml();
        return;
      }
      // page chat on a confirmed artifact is the project's council chat, where
      // an untagged message is the room's, not a note
      const councilChat = !!(D.project && D.project.confirmed);
      const msgs = (D.page && D.page.page_chat) || [];
      // A restored council chat opens on its tail, not its whole history.
      // Say so, in numbers, and hand over a link to the complete chat in the
      // council web UI — that is where a 400-message read belongs, not here.
      let restnote = '';
      const shown = msgs.filter(m => m && m.restored).length;
      if (D.project && D.page && D.page.session_id && shown) {
        // a chat opened before totals were stored has none — claim nothing
        const total = Number(D.page.session_total) || 0;
        const counts = total > shown ? ` — the last ${shown} of ${total} messages`
          : total ? ` — all ${shown} messages` : '';
        const base = String(D.project.council_web || 'http://localhost:4187').replace(/\/$/, '');
        restnote = `<div class="restnote">Restored council chat${counts}.
          <a href="${esc(base)}/?chat=${encodeURIComponent(D.page.session_id)}" target="_blank" rel="noopener">Open the full chat ↗</a></div>`;
      }
      const body = restnote + msgsHtml(PAGE_TARGET, msgs) + outboxHtml(PAGE_TARGET) + streamsHtml(PAGE_TARGET);
      const empty = D.project
        ? `<div class="empty"><b>A new chat in ${esc(D.project.project_title || D.project.project_id)}</b>Ask about this page — plain text goes to both bots, or tag one. It files with the project\u2019s other chats.</div>`
        : `<div class="empty"><b>Ask about this page</b>Anything at all — mention a bot to get an answer.</div>`;
      D.el.chat.innerHTML = offlineHtml() + warnHtml() + archiveHtml() + taskCardHtml() + `<div class="card chatpane" data-thread="${PAGE_TARGET}" style="--author:${MY_COLOR}">
        ${body ? `<div class="thread">${body}</div>` : empty}
        ${statusHtml(PAGE_TARGET)}
        ${composerHtml(PAGE_TARGET, 'Ask about this page\u2026', '', councilChat ? COUNCIL_HINT : '')}
      </div>`;
    }

    // ---- archive actions -------------------------------------------------
    async function loadArchive() {
      if (D.archive.loading) return;
      D.archive.loading = true; D.archive.err = '';
      render();
      const r = await cb('onProjectSessions')();
      D.archive.loading = false;
      if (r && r.ok) {
        D.archive.list = r.sessions || [];
        D.archive.current = r.current || null;
      } else {
        D.archive.err = (r && r.error) || 'the companion did not answer';
      }
      render();
    }
    // Opening a past chat, or starting a fresh one (sid null). The list is
    // dropped afterwards rather than patched: the companion has just changed
    // which session is current, and re-asking is one cheap call against
    // guessing.
    async function openSession(sid) {
      if (D.archive.busy) return;
      D.archive.busy = sid || 'new';
      D.archive.err = '';
      render();
      const r = await cb('onOpenSession')(sid || null);
      D.archive.busy = '';
      if (r && r.ok) {
        D.picking = false;
        D.archive.list = null;
        D.archive.current = r.session_id || null;
        // Everything the PREVIOUS chat left on this tab goes with it. A
        // pending send, a half-streamed answer, a "queued…" line and a
        // spinner all belong to the conversation that is no longer here, and
        // leaving any of them hanging over the new one would be a lie about
        // which chat they came from.
        delete D.outbox[PAGE_TARGET];
        delete D.notes[PAGE_TARGET];
        delete D.running[PAGE_TARGET];
        for (const k of Object.keys(D.streams)) {
          if (D.streams[k].target === PAGE_TARGET) delete D.streams[k];
        }
        D.expanded[PAGE_TARGET] = null;   // a chat just opened starts folded
        D.tab = 'chat';
      } else {
        D.archive.err = (r && r.error) || 'could not open that chat';
      }
      render();
    }
    // The preamble comes back as an ordinary message in the pane (the companion
    // appends it and content.js reloads the record), so there is nothing to
    // render here but the outcome line — what went, what did not, and whether
    // the bots were actually summoned — plus one thing the round needs that a
    // typed message never did: a QUEUED marker on every thread with a turn
    // coming.
    //
    // Those markers are the ordinary waiting notes, one per thread target, so a
    // round of twelve renders as twelve cards each saying it is waiting rather
    // than as twelve spinners stacked on the page chat. Each is cleared by
    // exactly what clears any wait: that thread's own turn-start, or a refetch
    // that shows a new bot message in it (clearAnsweredWaits).
    async function sendReview() {
      const r = D.review;
      if (r.busy) return;
      r.busy = true; r.err = ''; r.note = ''; r.confirm = false;
      render();
      const a = await cb('onSendReview')();
      r.busy = false;
      if (!a || !a.ok) {
        r.err = (a && a.error) || 'the companion did not answer';
      } else if (!a.queued && a.reason) {
        // agents off, or a guest's budget: the review IS posted, only the bots
        // are withheld — say which of the two happened
        r.note = `sent ${a.sent} comment${a.sent === 1 ? '' : 's'} — but ${a.reason}`;
      } else {
        for (const id of a.threads || []) {
          if (D.running[id]) continue;   // this one is already under way
          D.notes[id] = { text: 'queued in this review round…', transient: true, bots: botsIn(id) };
        }
        r.note = a.omitted
          ? `sent ${a.sent} of ${a.total} comments — one turn each; send review again for the other ${a.omitted}`
          : `sent ${a.sent} comment${a.sent === 1 ? '' : 's'} — one turn each, answered in the threads`;
      }
      // The round OPENS in page chat (the preamble is the last thing in the
      // pane) and the answers land on Comments. Landing here, where the button
      // is: the outcome line and the preamble are both on this tab, the tab
      // strip's own count says when the threads start moving, and a click is
      // all it takes to go and watch.
      D.tab = 'chat';
      paintTabs();
      render();
      if (D.el && D.el.chat) D.el.chat.scrollTop = D.el.chat.scrollHeight;
    }

    async function answerRoot(yes) {
      const r = await cb('onConfirmRoot')(!!yes);
      if (!r || !r.ok) { D.archive.err = (r && r.error) || 'the companion did not answer'; render(); return; }
      if (D.project) D.project.confirmed = !!yes;
      paintProject();
      render();
    }

    // ---- the Pages view -------------------------------------------------
    // The plugin's own history: every page the companion has a record for,
    // browsable from inside the drawer instead of from the council. It is not
    // a third tab — it replaces the whole body (tabs included) and comes back
    // with the ← Back button, because it is about OTHER pages while the tabs
    // are about this one.
    function hostOf(u) {
      // A local PDF is filed under a content hash (bfp-pdf://text/… for its
      // words, bfp-pdf://sha256/… for a scan's bytes), whose "hostname" names
      // an algorithm, not a place. Say where it came from.
      if (/^bfp-pdf:/i.test(String(u || ''))) return 'local pdf';
      try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return ''; }
    }
    // content.js owns normUrl (it must agree with the background and the
    // companion); without it, fall back to a plain string compare.
    function sameUrl(a, b) {
      if (!a || !b) return false;
      const n = typeof opts.normUrl === 'function' ? opts.normUrl : String;
      return n(a) === n(b);
    }
    // Two names for the same page: the address content.js is running on, and
    // the url on the record the companion answered with. They agree in the
    // browser; in the harness only the record does, so accept either.
    const isCurrentUrl = u =>
      sameUrl(u, opts.currentUrl) || sameUrl(u, D.page && D.page.url);

    // A row's crystal runs straight away in the remembered mode, so the row
    // has to SAY which one that is — the chooser lives on the header's crystal.
    const EXPORT_ROW_TIP = () => 'Export this page to Obsidian (' +
      (D.exportMode === 'comments' ? 'comments only' : 'everything') + ')';

    // ---- the archive, sliced ---------------------------------------------
    // Two filters over one list, and they combine: a KIND (what sort of
    // document it is, which the companion knows because the adapter declared
    // it) and a TAG (what the reader filed it under). Neither is a search box:
    // both are chips, because the whole point is to answer "where are my
    // papers" in one click.
    const matchesFilter = p =>
      (!D.pages.kind || kindOfRow(p) === D.pages.kind) &&
      (!D.pages.tag || tagsOfRow(p).some(t => t.toLowerCase() === D.pages.tag.toLowerCase()));
    const shownPages = () => (D.pages.list || []).filter(matchesFilter);

    // A chip is drawn for a kind the archive actually contains — plus, always,
    // whichever one is selected, so a filter can never strand the reader with
    // no way back out of it.
    function kindChips(list) {
      const counts = new Map();
      for (const p of list) {
        const k = kindOfRow(p);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const kinds = KINDS.filter(([k]) => counts.has(k) || D.pages.kind === k);
      if (kinds.length < 2) return '';   // one kind is not a choice
      const chip = (kind, label, n) =>
        `<button class="fchip${D.pages.kind === kind ? ' on' : ''}" type="button"
           data-act="filter-kind" data-kind="${esc(kind)}"
           ${D.pages.kind === kind ? 'aria-pressed="true"' : 'aria-pressed="false"'}
           >${esc(label)}${n == null ? '' : `<span class="fn">${n}</span>`}</button>`;
      return `<div class="fkinds" role="group" aria-label="Filter by kind">`
        + chip('', 'All', list.length)
        + kinds.map(([k, label]) => chip(k, label, counts.get(k) || 0)).join('')
        + `</div>`;
    }

    // The tags in use across the whole archive, so the rail is stable as the
    // list filters underneath it — a tag that vanished the moment you clicked
    // it would be a rail you could only use once.
    function tagRail(all) {
      const tags = knownTags(all);
      if (!tags.length) return '';
      return `<div class="ftags" role="group" aria-label="Filter by tag">`
        + tags.map(t => `<button class="tchip${D.pages.tag.toLowerCase() === t.toLowerCase() ? ' on' : ''}"
             type="button" data-act="filter-tag" data-tag="${esc(t)}" style="--th:${tagHue(t)}"
             title="Only pages tagged ${esc(t)}">${esc(t)}</button>`).join('')
        + `</div>`;
    }

    // every tag anywhere in the list, first-casing wins, alphabetical
    function knownTags(list) {
      const seen = new Map();
      for (const p of (list || [])) {
        for (const t of tagsOfRow(p)) {
          const k = String(t).toLowerCase();
          if (!seen.has(k)) seen.set(k, String(t));
        }
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b));
    }

    // ---- a row's own tags, and the two owner-only editors ----------------
    const tagChipsHtml = p => {
      const tags = tagsOfRow(p);
      if (!tags.length) return '';
      return `<span class="ptags">` + tags.map(t =>
        `<button class="tchip row${D.pages.tag.toLowerCase() === t.toLowerCase() ? ' on' : ''}"
           type="button" data-act="filter-tag" data-tag="${esc(t)}" style="--th:${tagHue(t)}"
           title="Only pages tagged ${esc(t)}">${esc(t)}</button>`).join('') + `</span>`;
    };

    // The rename box carries the name the row is CURRENTLY shown under —
    // emptying it is how a reader takes their own name back off and lets the
    // page call itself whatever it calls itself again.
    const renameHtml = p => `<div class="pedit rename">
        <input class="pinput" type="text" value="${esc(p.title || '')}" aria-label="Name for this page"
          maxlength="200" data-act="rename-input" data-url="${esc(p.url)}">
        <button class="rebtn" data-act="rename-save" data-url="${esc(p.url)}" type="button">save</button>
        <button class="rebtn" data-act="rename-no" type="button">cancel</button>
        <span class="phint">empty = the page’s own name</span>
      </div>`;

    // One box holding the whole list, comma-separated: adding and removing are
    // the same edit, and the menu underneath completes the tag being typed
    // against every tag already in use.
    // The value is seeded with a trailing ", " when the row already has tags,
    // so the token under the caret opens EMPTY — and an empty token is what
    // makes the menu below offer every tag in use (pick-from-existing) instead
    // of only completions of the last tag. saveTags splits on commas and drops
    // empties, so the seed costs nothing on the way back.
    const tagEditHtml = p => `<div class="pedit tags">
        <input class="pinput" type="text" value="${esc(tagsOfRow(p).join(', ') + (tagsOfRow(p).length ? ', ' : ''))}"
          aria-label="Tags for this page" maxlength="520" autocomplete="off"
          data-act="tag-input" data-url="${esc(p.url)}">
        <button class="rebtn" data-act="tag-save" data-url="${esc(p.url)}" type="button">save</button>
        <button class="rebtn" data-act="tag-no" type="button">cancel</button>
        <div class="tagmenu" hidden></div>
      </div>`;

    function pageRowHtml(p) {
      const n = p.threads | 0;
      const cur = isCurrentUrl(p.url);
      // has_session = the companion holds a botference session for this page,
      // i.e. there are bots in it. A page of pure notes has none, and the
      // difference is worth one muted glyph.
      const chat = p.has_session
        ? `<span class="pchat" title="${esc(CHAT_TIP)}" aria-label="${esc(CHAT_TIP)}">${CHAT_SVG}</span>`
        : '';
      const confirming = D.pages.confirm != null && sameUrl(D.pages.confirm, p.url);
      const err = D.pages.rowErr && sameUrl(D.pages.rowErr.url, p.url)
        ? `<div class="prow-err">${esc(D.pages.rowErr.text)}</div>` : '';
      // Naming a page and filing it are the OWNER's: a guest reading a shared
      // companion never sees either control, and the companion would refuse
      // them anyway.
      const mine = !!D.owner;
      const editing = D.pages.renaming != null && sameUrl(D.pages.renaming, p.url);
      const filing = D.pages.tagging != null && sameUrl(D.pages.tagging, p.url);
      const acts = confirming
        ? `<span class="pconfirm">delete page + its chat?
             <button class="rebtn yes" data-act="page-del-yes" data-url="${esc(p.url)}" type="button">yes</button>
             <button class="rebtn" data-act="page-del-no" type="button">no</button></span>`
        : `${mine ? `<button class="rebtn pren" data-act="page-rename" data-url="${esc(p.url)}" type="button"
             title="Rename this page" aria-label="Rename this page">✎</button>
           <button class="rebtn ptag" data-act="page-tag" data-url="${esc(p.url)}" type="button"
             title="Tag this page" aria-label="Tag this page">#</button>` : ''}
           <button class="rebtn pexport" data-act="page-export" data-url="${esc(p.url)}" type="button"
             title="${esc(EXPORT_ROW_TIP())}" aria-label="${esc(EXPORT_ROW_TIP())}">${OBSIDIAN_SVG}</button>
           <button class="rebtn pdel" data-act="page-del" data-url="${esc(p.url)}" type="button"
             title="Delete this page and its chat" aria-label="Delete this page and its chat">✕</button>`;
      const edit = mine && editing ? renameHtml(p) : (mine && filing ? tagEditHtml(p) : '');
      return `<div class="prow${cur ? ' current' : ''}" data-url="${esc(p.url)}" data-kind="${esc(kindOfRow(p))}">
        <button class="prow-main" data-act="page-open" data-url="${esc(p.url)}" type="button"
          title="${esc(cur ? 'back to this page’s comments' : p.url)}">
          <span class="ptitle">${esc(p.title || p.url)}</span>
          <span class="pmeta"><span class="psite">${esc(hostOf(p.url))}</span> · <span class="pkind">${esc(KIND_NAME[kindOfRow(p)])}</span> · <span class="pcount">${n} thread${n === 1 ? '' : 's'}</span> · <span class="pwhen">${esc(relTime(p.updated_at))}</span>${cur ? '<span class="pcur"> · this page</span>' : ''}${chat}</span>
        </button>
        ${acts}${tagChipsHtml(p)}${edit}${err}
      </div>`;
    }

    function renderPages() {
      if (!D.mounted || !D.el.pages) return;
      const list = D.pages.list;
      const shown = list ? shownPages() : [];
      const filtered = !!(D.pages.kind || D.pages.tag);
      let body;
      if (!list && D.pages.loading) body = `<div class="empty">loading…</div>`;
      else if (D.pages.err && !(list && list.length)) {
        body = `<div class="empty"><b>Could not load your pages</b>${esc(D.pages.err)}</div>`;
      } else if (!list || !list.length) {
        body = `<div class="empty">nothing annotated yet — highlight some text to start</div>`;
      } else if (!shown.length) {
        // a filter that matches nothing says so as a filter, not as an empty
        // archive — and offers the way out in the same line
        body = `<div class="empty">nothing here under this filter —
          <button class="fclear" data-act="filter-clear" type="button">show everything</button></div>`;
      } else {
        body = shown.map(pageRowHtml).join('');
      }
      const filters = list && list.length
        ? `<div class="pfilter">${kindChips(list)}${tagRail(list)}</div>` : '';
      D.el.pages.innerHTML = `<div class="pages-head">
          <button class="backbtn" data-act="pages-back" type="button" title="Back to this page">← Back</button>
          <span class="pages-title">Library</span>
        </div><div class="libpane"></div>
        <div class="pages-list"><div class="list-head">All annotated pages${
          list && list.length ? ' · ' + (filtered ? `${shown.length} of ${list.length}` : list.length) : ''
        }</div>${filters}${body}</div>`;
      renderLibrary();
      // an editor that was open before the repaint gets its caret back, or
      // typing a tag would be interrupted by every live refresh of the list
      focusRowEditor();
    }

    // The inline rename/tag box, after a repaint: focus restored, caret at the
    // end, and the completion menu redrawn from what is in the box.
    function focusRowEditor() {
      const el = D.el.pages && D.el.pages.querySelector('.pedit .pinput');
      if (!el || (D.shadow.activeElement && D.shadow.activeElement === el)) return;
      el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignore */ }
      if (el.dataset.act === 'tag-input') paintTagMenu(el);
    }

    // ---- the library ----------------------------------------------------
    // One conversation about everything in the list below it. Rendered from the
    // same four helpers the page chat uses (msgsHtml · outboxHtml · streamsHtml
    // · statusHtml) and the same composer, so markdown, maths, tool rows,
    // folding, wait states, optimistic sends and the @-menu all arrive here
    // already working — the only thing that is ours is the copy and the target.
    //
    // It repaints on its own, without the pages list: an answer arriving must
    // not rebuild the rows underneath it (and take their scroll position with
    // them) every time a token lands.
    function renderLibrary() {
      const el = D.el.pages && D.el.pages.querySelector('.libpane');
      if (!el) return;
      const T = LIBRARY_TARGET;
      const msgs = (D.library.page && D.library.page.page_chat) || [];
      const body = msgsHtml(T, msgs) + outboxHtml(T) + streamsHtml(T);
      const has = !!(D.library.page && (msgs.length || (D.outbox[T] || []).length));
      const note = D.library.note
        ? `<div class="lib-note${D.library.err ? ' err' : ''}">${esc(D.library.note)}</div>` : '';
      const acts = has
        ? `<button class="libact" data-act="lib-export" type="button" title="Write this conversation to Obsidian">Export</button>`
          + (D.library.confirm
            ? `<span class="libconfirm">clear it?<button class="libact danger" data-act="lib-clear-yes" type="button">yes</button>`
              + `<button class="libact" data-act="lib-clear-no" type="button">no</button></span>`
            : `<button class="libact" data-act="lib-clear" type="button" title="Forget this conversation and start again">Clear</button>`)
        : '';
      el.innerHTML = `<div class="lib-head">
          <span class="lib-sub">one conversation about everything below</span>${acts}</div>
        <div class="card libchat" data-thread="${T}" style="--author:${MY_COLOR}">
          ${body ? `<div class="thread">${body}</div>`
            : `<div class="empty"><b>Ask about everything you've read</b>The bots read your saved pages, quotes and comments to answer — mention one to begin.</div>`}
          ${note}
          ${statusHtml(T)}
          ${composerHtml(T, 'Ask about everything you’ve read…')}
        </div>`;
      // The whole shadow root, not just this pane: fillMarkdown empties the
      // slot map as it goes, so filling a subtree would strand every slot the
      // other panes had just minted. Filling everything is idempotent — a slot
      // already filled is simply no longer in the map.
      fillMarkdown(D.shadow);
      decorateRuns(D.shadow);
    }

    // /index is a map keyed by pageKey; the list is ours to order — newest
    // conversation first, which is the only order anybody browses history in.
    function toPageList(index) {
      const out = [];
      for (const k of Object.keys(index || {})) {
        const v = index[k];
        if (v && v.url) out.push(v);
      }
      return out.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
    }

    // `quiet` = a live refresh behind an already-populated list: no loading
    // flicker, and a companion that blinks out leaves the last list on screen.
    async function loadPages(quiet) {
      D.pages.loading = !quiet;
      if (!quiet) { D.pages.err = ''; renderPages(); }
      const r = await cb('onPages')();
      D.pages.loading = false;
      if (r && r.ok !== false) { D.pages.list = toPageList(r.index); D.pages.err = ''; }
      else D.pages.err = (r && r.error) || 'could not reach the companion';
      if (D.view === 'pages') renderPages();
    }

    // Full re-render, but never at the cost of what the user is typing or
    // where they are scrolled: drafts are read back into D.drafts first and
    // scroll offsets restored after.
    function render() {
      if (!D.mounted) return;
      harvestDrafts();
      const cTop = D.el.comments.scrollTop, chTop = D.el.chat.scrollTop;
      const pTop = D.el.pages ? D.el.pages.scrollTop : 0;
      // the newest checklist on the page, recomputed from the record: derived
      // state, so a revision replaces the card and a vanished list removes it
      D.tasks = taskSource();
      // …and only if the address still resolves to a message with a list in it:
      // two messages can share a timestamp, and the card must show whatever
      // findMsg shows the transcript rather than a second copy of it
      if (D.tasks && !hasTasks((taskMsg() || {}).text)) D.tasks = null;
      renderComments();
      renderChat();
      // the library is a conversation like the others and moves with the same
      // events; the list it sits above is not touched
      if (D.view === 'pages') renderLibrary();
      fillMarkdown(D.shadow);
      // …and then the code blocks get their Run buttons and their results,
      // which need the markdown to exist first and the record to say what the
      // last run of each block printed
      decorateRuns(D.shadow);
      // …and the tasks card gets the newest checklist, moved out of a rendering
      // of the message it lives in (same ordinals, same /tick)
      fillTasks();
      lockRestored(D.shadow);
      D.el.comments.scrollTop = cTop;
      D.el.chat.scrollTop = chTop;
      if (D.el.pages) D.el.pages.scrollTop = pTop;
      restoreMention();
      paintFoot();
      paintRound();
    }

    function harvestDrafts() {
      if (!D.mounted) return;
      D.shadow.querySelectorAll('.composer').forEach(c => {
        const target = c.getAttribute('data-target');
        const ta = c.querySelector('textarea');
        if (!target || !ta) return;
        // No in-flight exception is needed any more: a sent message leaves the
        // composer synchronously (queueSend) and lives in D.outbox until the
        // companion confirms it, so there is nothing here to read back.
        if (ta.value) D.drafts[target] = ta.value; else delete D.drafts[target];
      });
    }

    function paintTabs() {
      if (!D.mounted) return;
      if (!CAPS.highlights && D.tab !== 'chat') D.tab = 'chat';
      // a council folder nobody has vouched for yet has exactly one thing to
      // say, and it is on this tab
      if (D.project && !D.project.confirmed) D.tab = 'chat';
      D.el.tabs.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === D.tab));
      paintView();
    }

    // One switch decides what the body is: the tabbed thread views, or the
    // pages library on top of both (tab bar included — there is nothing to
    // switch between while you are browsing other pages).
    function paintView() {
      if (!D.mounted) return;
      const pages = D.view === 'pages';
      D.el.tabs.hidden = pages;
      D.el.pages.hidden = !pages;
      D.el.comments.hidden = pages || D.tab !== 'comments';
      D.el.chat.hidden = pages || D.tab !== 'chat';
      const btn = D.shadow.querySelector('[data-act="pages"]');
      if (btn) {
        btn.classList.toggle('on', pages);
        btn.setAttribute('aria-pressed', pages ? 'true' : 'false');
      }
    }

    function paintConn() {
      if (!D.mounted) return;
      const off = D.connKnown && !D.connected;
      D.el.conn.classList.toggle('off', off);
      D.el.conn.classList.toggle('pending', !D.connKnown);
      D.el.conn.querySelector('.ctext').textContent =
        !D.connKnown ? 'connecting…' : (D.connected ? 'connected' : 'companion offline — retry');
    }

    // ---- the review round strip -----------------------------------------
    //
    // Send review fans a round out into one turn per open comment, and each of
    // those turns re-renders its own card. That is right for the card and
    // useless for the round: twenty comments in, the reader has no count, no
    // position, and no way to tell "still working" from "finished and quiet".
    // The footbar cannot say it either — it reports the TURN in flight, which
    // is one twentieth of the thing they started.
    //
    // So this is a second, persistent line that belongs to the ROUND. Its
    // state is the companion's (it built the queue and sees every turn
    // boundary) and arrives as a broadcast, which is what makes it survive a
    // refresh, a reopened drawer, and a second tab watching the same page.
    //
    // Naming the comment is the point of it — "answering comment 4 of 12" with
    // nothing else is a progress bar, and a progress bar is not what a reader
    // wants here. The quote makes it a place, and clicking it goes there.
    const roundQuote = q => {
      const s = String(q || '').replace(/\s+/g, ' ').trim();
      return s.length > 90 ? s.slice(0, 89) + '…' : s;
    };
    function paintRound() {
      if (!D.mounted || !D.el.round) return;
      const r = D.round;
      if (!r) { D.el.round.hidden = true; D.el.round.innerHTML = ''; return; }
      const total = Number(r.total) || 0;
      const done = Number(r.answered) || 0;
      if (!r.running) {
        // the outcome, and a way to put it away: a note that cannot be
        // dismissed is a note that eventually gets ignored
        D.el.round.className = 'roundbar done';
        D.el.round.innerHTML = `<span class="rtick">✓</span>`
          + `<span class="rtext">round done — ${done} of ${total} answered</span>`
          + `<button class="rdismiss" data-act="round-dismiss" type="button" aria-label="dismiss">✕</button>`;
        D.el.round.hidden = false;
        return;
      }
      const at = Math.min(done + 1, total);
      const quote = roundQuote(r.current_quote);
      // Between turns there is nothing in flight and saying "answering
      // comment N" would be a small lie, so it says what is true instead.
      const body = r.current
        ? `<span class="rtext">answering comment ${at} of ${total}</span>`
          + (quote ? `<button class="rjump" data-act="round-jump" data-target="${esc(r.current)}" type="button" title="scroll to this comment">“${esc(quote)}”</button>` : '')
        : `<span class="rtext">${done ? `${done} of ${total} answered` : `review round — ${total} comments`} · waiting for the next turn</span>`;
      D.el.round.className = 'roundbar';
      D.el.round.innerHTML = `<span class="spin">◐</span>${body}`
        + `<span class="rcount">${done}/${total}</span>`;
      D.el.round.hidden = false;
    }

    function paintFoot() {
      if (!D.mounted) return;
      const busy = Object.keys(D.running).filter(k => D.running[k]);
      const anyRunning = busy.length > 0;
      let html = '';
      if (anyRunning) {
        html = chipBody(busy) + `<button class="stop" data-act="interrupt" type="button">✕ stop</button>`;
        D.el.foot.setAttribute('aria-label', workingLabel(busy));
      } else if (D.foot) {
        html = esc(D.foot);
      } else if (D.bridge) {
        html = esc('bridge: ' + D.bridge);
      } else {
        html = esc(HINT);
      }
      if (!anyRunning) D.el.foot.removeAttribute('aria-label');
      D.el.foot.innerHTML = html;
      D.el.foot.classList.toggle('err', !!D.footErr && !anyRunning);
    }

    // ---- agents popover --------------------------------------------------
    // Deliberately behind a gear: a model picker, two context gauges and a
    // relay button in the header would be clutter on controls almost nobody
    // touches twice a day. It is the council's agents panel boiled down to
    // what fits in a popover. Built with DOM nodes because everything in it —
    // option lists, gauge numbers, companion error text — is data reported by
    // the bridge, and none of it should ever become markup.

    // The companion's empty state is {current:null, options:null, status:null,
    // bridge:"stopped"}: nothing is broken, the bridge simply has not been
    // started — it starts on the first @mention. "disabled" is the one state
    // the user cannot fix from here (companion launched --no-agents).
    const SLEEP_TEXT = {
      asleep: 'agents are asleep — they wake on the first @mention',
      off: 'agents are off on this companion',
    };
    function popMode() {
      const m = D.models;
      if (m.bridge === 'disabled') return 'off';
      // a companion that never answered is not the same as a sleeping bridge:
      // say nothing about the agents, the error line already speaks
      if (m.err && !m.options) return 'unknown';
      if (m.bridge === 'stopped' || !m.options) return 'asleep';
      return 'live';
    }

    // 86000 → "86k", 1500 → "1.5k", 640 → "640"
    function compactK(n) {
      if (n == null || !isFinite(n)) return '';
      const a = Math.abs(n);
      if (a < 1000) return String(Math.round(n));
      const v = n / 1000;
      return (a < 10000 ? Math.round(v * 10) / 10 : Math.round(v)) + 'k';
    }
    function relTime(ts) {
      const t = Date.parse(ts);
      if (!isFinite(t)) return '';
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 45) return 'just now';
      const min = Math.round(s / 60);
      if (min < 60) return min + 'm ago';
      const h = Math.round(min / 60);
      if (h < 24) return h + 'h ago';
      return Math.round(h / 24) + 'd ago';
    }

    // Two pickers per agent, built from the same rule: model and effort. Both
    // arrive as {current, options} and both go null the moment the bridge is
    // not running, which is what disables them.
    const modelCur = a => (D.models.current && D.models.current[a]) || '';
    const modelList = a => (D.models.options && D.models.options[a]) || null;
    const effortCur = a => (D.models.effort && D.models.effort.current && D.models.effort.current[a]) || '';
    const effortList = a => (D.models.effort && D.models.effort.options && D.models.effort.options[a]) || null;
    // Which auth an agent will run on. Unlike model and effort this is the
    // COMPANION's setting, not the bridge's, so it never goes null and never
    // greys out with a sleeping agent — the same reasoning as verbosity below.
    //
    // The companion stores THREE modes: 'auto' (a saved key is used, else the
    // subscription — Claude Code's own rule), 'subscription' and 'key'. The
    // drawer shows TWO, because 'auto' is not a thing a reader can be billed
    // for: it is whichever of the other two the saved keys resolve it to, and
    // that resolution is the only answer worth putting on screen. Moving the
    // switch stores the explicit mode; nothing here ever writes 'auto' back.
    const keyStatus = a => (D.models.keys && D.models.keys[a]) || 'unset';
    const authCur = a => (D.models.keys && D.models.keys.modes && D.models.keys.modes[a]) || 'auto';
    const BILL_POS = ['subscription', 'key'];
    const BILL_LABEL = { subscription: 'subscription', key: 'API key' };
    function effAuth(agent) {
      const mode = authCur(agent);
      return mode === 'auto' ? (keyStatus(agent) === 'set' ? 'key' : 'subscription') : mode;
    }
    // one entry per kind of picker, so a third kind costs a row here and
    // nothing anywhere else
    const PICKERS = {
      model: { cur: modelCur, list: modelList, attr: 'data-agent', row: '.pop-modelrow' },
      effort: { cur: effortCur, list: effortList, attr: 'data-effort', row: '.pop-effort' },
    };
    const pickerCur = (agent, kind) => PICKERS[kind].cur(agent);
    const pickerList = (agent, kind) => PICKERS[kind].list(agent);

    // '—' is not a level: it is "the bridge has not said". The companion
    // reports effort.current.codex as null until it has been set even once,
    // and preselecting `low` there would be the drawer inventing an answer.
    const NOPICK = '—';
    function optionsFor(cur, list) {
      if (!list || !list.length) return [cur || NOPICK];
      if (!cur) return [NOPICK].concat(list);
      // a value the bridge no longer offers is still what is running: show it
      return list.indexOf(cur) === -1 ? [cur].concat(list) : list.slice();
    }
    const optionList = agent => optionsFor(modelCur(agent), modelList(agent));

    function buildSelect(agent, kind) {
      const sel = mk('select');
      sel.setAttribute(PICKERS[kind].attr, agent);
      const cur = pickerCur(agent, kind);
      const list = pickerList(agent, kind);
      for (const o of optionsFor(cur, list)) {
        const opt = mk('option');
        opt.value = o;
        opt.textContent = o;
        if (o === cur) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.disabled = !(list && list.length);
      return sel;
    }
    function relayButton(agent, label, title) {
      const b = mk('button', agent === 'both' ? 'relay both' : 'relay');
      b.type = 'button';
      b.setAttribute('data-act', 'relay');
      b.setAttribute('data-agent', agent);
      b.title = title;
      b.textContent = label;
      return b;
    }

    const RELAY_TIP = 'hand off to a fresh session (context reset)';
    const VERB_TIP = 'how the bots talk: short = 2-3 crisp sentences; long = at most 4-5';
    const VERB_LEVELS = ['short', 'long'];

    // The popover's switch idiom, in one place: two positions, a middle dot,
    // one of them on. Two states are a switch and not a menu — and the reply
    // length and each agent's billing are both exactly two states, so they had
    // better look like the same kind of control rather than two inventions.
    //   o = {cls, seg, act, attr, positions:[{value,label}], label, title, attrs}
    function segSwitch(o) {
      const seg = mk('span', o.cls);
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', o.label);
      if (o.title) seg.title = o.title;
      o.positions.forEach((p, i) => {
        if (i) {
          const sep = mk('span', 'vsep');
          sep.setAttribute('aria-hidden', 'true');
          sep.textContent = '·';
          seg.appendChild(sep);
        }
        const b = mk('button', o.seg);
        b.type = 'button';
        b.setAttribute('data-act', o.act);
        b.setAttribute(o.attr, p.value);
        for (const k in (o.attrs || {})) b.setAttribute(k, o.attrs[k]);
        if (o.title) b.title = o.title;
        b.textContent = p.label;
        seg.appendChild(b);
      });
      return seg;
    }

    // Which auth this agent bills, as a switch the reader can act on. The
    // labels are the two answers; there is no third position for 'auto',
    // because "whatever the keys resolve to" is not something anyone chooses.
    const BILL_TIP = 'what this agent bills: your CLI login, or the API key saved in the extension’s settings';
    function billSwitch(agent) {
      return segSwitch({
        cls: 'pop-bill', seg: 'bseg', act: 'bill', attr: 'data-bill',
        label: agent + ' billing', title: BILL_TIP,
        attrs: { 'data-agent': agent },
        positions: BILL_POS.map(v => ({ value: v, label: BILL_LABEL[v] })),
      });
    }

    // The one preference in here that is not about an agent: how long an answer
    // in a 420px column is allowed to be. Two states, so it is a switch and not
    // a menu — segmented, 12px, and it says what each end means on hover.
    function verbosityRow() {
      const row = mk('div', 'pop-verbrow');
      const label = mk('span', 'pop-verblabel');
      label.textContent = 'replies';
      row.appendChild(label);
      row.appendChild(segSwitch({
        cls: 'pop-verb', seg: 'vseg', act: 'verb', attr: 'data-level',
        label: 'reply length', title: VERB_TIP,
        positions: VERB_LEVELS.map(v => ({ value: v, label: v })),
      }));
      return row;
    }

    // A quiet way to the only place a key is ever typed. The drawer renders
    // inside whatever page you are reading — its DOM is that page's DOM — so
    // the extension's own options page takes the key and this is a link to it,
    // never a field.
    function keysRow() {
      const row = mk('div', 'pop-keysrow');
      const b = mk('button', 'pop-keyslink');
      b.type = 'button';
      b.setAttribute('data-act', 'keys');
      b.title = 'add or remove the keys these switches bill to — opens the extension’s settings, '
        + 'the only place a key is ever typed';
      b.textContent = 'API keys…';
      row.appendChild(b);
      return row;
    }

    function paintModels() {
      const pop = D.el.pop;
      if (!pop) return;
      pop.textContent = '';
      const head = mk('div', 'pop-head');
      head.textContent = 'Agents';
      pop.appendChild(head);

      for (const agent of AGENT_ORDER) {
        const group = mk('div', 'pop-agentrow');
        group.setAttribute('data-agent', agent);
        group.style.setProperty('--author', authorColor(agent));

        // one grid for the whole agent: [name | picker | relay], two rows deep.
        // The <label>s inside it are display:contents (drawer.css), so clicking
        // a name still focuses its select while both selects share a column.
        const line = mk('div', 'pop-line');
        const row = mk('label', 'pop-row pop-modelrow');
        const name = mk('span', 'pop-agent');
        const mark = mk('span', 'pop-mark');
        mark.innerHTML = MARKS[agent] || '';       // authored SVG, never data
        name.appendChild(mark);
        name.appendChild(document.createTextNode(agent));
        row.appendChild(name);
        row.appendChild(buildSelect(agent, 'model'));
        line.appendChild(row);
        // outside the <label>: a click on a label is forwarded to its control,
        // which would drop the select open every time you asked for a relay
        line.appendChild(relayButton(agent, 'relay', agent + ' — ' + RELAY_TIP));

        // how hard that model thinks, on the row under the model it belongs to
        const eff = mk('label', 'pop-row pop-effort');
        const effName = mk('span', 'pop-sub');
        effName.textContent = 'effort';
        eff.appendChild(effName);
        eff.appendChild(buildSelect(agent, 'effort'));
        line.appendChild(eff);

        // and what it bills: the subscription it is logged into, or a key.
        // A <div> and not a <label> like the rows above it — a label forwards
        // its clicks to one control, and this one has two.
        const auth = mk('div', 'pop-row pop-auth');
        auth.hidden = true;                    // until the companion reports keys
        const authName = mk('span', 'pop-sub');
        authName.textContent = 'billing';
        auth.appendChild(authName);
        auth.appendChild(billSwitch(agent));
        line.appendChild(auth);
        group.appendChild(line);

        const g = mk('div', 'gauge');
        g.hidden = true;
        const bar = mk('span', 'gauge-bar');
        bar.appendChild(mk('span', 'gauge-fill'));
        const tick = mk('span', 'gauge-tick');
        tick.title = 'auto-relay at 50%';
        bar.appendChild(tick);
        g.appendChild(bar);
        g.appendChild(mk('span', 'gauge-label'));
        group.appendChild(g);

        const reset = mk('div', 'pop-reset');
        reset.hidden = true;
        group.appendChild(reset);
        pop.appendChild(group);
      }

      const sleep = mk('div', 'pop-sleep');
      sleep.hidden = true;
      pop.appendChild(sleep);

      const foot = mk('div', 'pop-foot');
      foot.appendChild(mk('span', 'pop-auto'));
      foot.appendChild(relayButton('both', 'relay both', 'both agents — ' + RELAY_TIP));
      pop.appendChild(foot);
      pop.appendChild(verbosityRow());
      pop.appendChild(keysRow());

      pop.appendChild(mk('div', 'pop-hint'));
      syncModels();
    }

    // Everything the companion can change under an open popover is repainted
    // in place — no rebuild, so a `models` broadcast never yanks the select the
    // user is mid-way through using.
    function syncModels() {
      const pop = D.el.pop;
      if (!pop || !pop.querySelector('.pop-agentrow')) return;
      const m = D.models;
      const mode = popMode();
      const st = m.status || {};

      for (const agent of AGENT_ORDER) {
        const group = pop.querySelector('.pop-agentrow[data-agent="' + agent + '"]');
        if (!group) continue;
        group.classList.toggle('asleep', mode !== 'live');

        syncPicker(group, agent, 'model');
        syncPicker(group, agent, 'effort');
        syncAuth(group, agent);
        paintGauge(group, agent, st[agent]);
      }
      syncVerbosity();

      const sleep = pop.querySelector('.pop-sleep');
      sleep.textContent = SLEEP_TEXT[mode] || '';
      sleep.hidden = !SLEEP_TEXT[mode];

      const auto = pop.querySelector('.pop-auto');
      const ar = m.status ? m.status.auto_relay : null;
      auto.textContent = ar == null ? '' : (ar ? 'auto-relay at 50%' : 'auto-relay off');

      // one bridge, one queue: while any relay is in flight every relay button
      // waits, including the one in the footer
      pop.querySelectorAll('button.relay').forEach(b => { b.disabled = D.relaying || mode === 'off'; });
      paintModelHint();
    }

    // One picker, repainted in place. The option list is rebuilt only when it
    // actually differs — replacing a <select> the user has open would close it
    // under their finger every time a `models` broadcast arrived.
    function syncPicker(group, agent, kind) {
      const row = group.querySelector(PICKERS[kind].row);
      const sel = group.querySelector('select[' + PICKERS[kind].attr + ']');
      if (!row || !sel) return;
      const cur = pickerCur(agent, kind);
      const list = pickerList(agent, kind);
      const want = optionsFor(cur, list);
      const have = [].map.call(sel.options, o => o.value);
      if (have.join('\u0000') !== want.join('\u0000')) {
        row.replaceChild(buildSelect(agent, kind), sel);
      } else {
        if (cur && sel.value !== cur) sel.value = cur;
        sel.disabled = !(list && list.length);
      }
    }

    // Verbosity is the companion's own preference, not the bridge's, so it
    // survives a sleeping agent — but a companion too old to report one has
    // nothing to switch, and the row simply is not there.
    function syncVerbosity() {
      const row = D.el.pop && D.el.pop.querySelector('.pop-verbrow');
      if (!row) return;
      const v = D.models.verbosity || '';
      row.hidden = !v;
      row.querySelectorAll('.vseg').forEach(b => {
        const on = b.getAttribute('data-level') === v;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    // pct is whatever the companion reported and is never recomputed from
    // tokens/window — a pushed event's token count may be newer than its pct.
    function paintGauge(group, agent, s) {
      const g = group.querySelector('.gauge');
      const reset = group.querySelector('.pop-reset');
      const pct = s && s.pct != null && isFinite(s.pct)
        ? Math.max(0, Math.min(100, Math.round(s.pct))) : null;
      if (pct == null) {
        g.hidden = true;
      } else {
        const tk = compactK(s.tokens), win = compactK(s.window);
        g.querySelector('.gauge-fill').style.width = pct + '%';
        g.querySelector('.gauge-label').textContent =
          tk && win ? pct + '% · ' + tk + ' / ' + win : pct + '%';
        g.title = agent + (s.model ? ' · ' + s.model : '') + ' · ' + pct + '% of the context window used';
        g.hidden = false;
      }
      const rel = s && s.last_relay_at ? relTime(s.last_relay_at) : '';
      reset.textContent = rel ? 'memory reset ' + rel : '';
      reset.title = rel && s.last_relay_tier ? 'last relay: ' + s.last_relay_tier : '';
      reset.hidden = !rel;
    }

    function paintModelHint() {
      const el = D.el.pop && D.el.pop.querySelector('.pop-hint');
      if (!el) return;
      const m = D.models;
      el.classList.toggle('err', !!m.err);
      // when the agents are asleep the sleep line has already said so; a second
      // line of small print under it would only repeat itself
      const text = m.loading ? 'loading…'
        : m.note ? m.note
        : popMode() === 'live' ? 'takes effect on the next turn'
        : '';
      el.textContent = text;
      el.hidden = !text;
    }

    async function openModels() {
      if (!D.mounted) return;
      D.modelsOpen = true;
      D.el.pop.hidden = false;
      D.models.loading = true;
      D.models.note = '';
      D.models.err = false;
      paintModels();
      if (typeof document !== 'undefined') document.addEventListener('mousedown', onDocDown, true);
      const r = await cb('onModels')();
      D.models.loading = false;
      if (r && r.ok !== false) {
        D.models.current = r.current || {};
        D.models.options = r.options || null;
        // a companion that never heard of `status` simply has no gauges
        D.models.status = r.status || null;
        // …and one that never heard of effort/verbosity gets no pickers and no
        // reply-length switch, rather than empty ones
        D.models.effort = r.effort || null;
        D.models.verbosity = r.verbosity || '';
        D.models.bridge = r.bridge || '';
        // …and one too old to have keys at all leaves the billing row out
        ingestKeys(r.keys);
        D.models.err = false;
      } else {
        D.models.options = null;
        D.models.status = null;
        D.models.effort = null;
        D.models.note = (r && r.error) || 'could not reach the companion';
        D.models.err = true;
      }
      if (D.modelsOpen) paintModels();
    }

    // The same GET, without the repaint: used when the only thing that can
    // have moved is the companion's own answer about the keys.
    async function refreshModels() {
      let r;
      try { r = await cb('onModels')(); }
      catch { return; }
      if (!r || r.ok === false) return;
      ingestKeys(r.keys);
      if (D.modelsOpen) syncModels();
    }

    function closeModels() {
      D.modelsOpen = false;
      if (D.el.pop) D.el.pop.hidden = true;
      if (typeof document !== 'undefined') document.removeEventListener('mousedown', onDocDown, true);
    }
    // page-side clicks: everything inside the shadow root retargets to the host,
    // so this only ever fires for clicks on the page itself
    const onDocDown = e => { if (!D.host || !D.host.contains(e.target)) closeModels(); };

    async function pickModel(agent, model) {
      D.models.note = 'switching ' + agent + '…';
      D.models.err = false;
      paintModelHint();
      const r = await cb('onSetModel')(agent, model);
      if (r && r.ok === false) {
        D.models.note = r.error || 'could not switch model';
        D.models.err = true;
      } else {
        D.models.current = Object.assign({}, D.models.current, { [agent]: model });
        D.models.note = agent + ' → ' + model + whenApplied(r);
        D.models.err = false;
      }
      paintModelHint();
    }

    // Model and effort are stored preferences now, so they can be set with the
    // agents asleep. Saying only "claude → opus" there would read as a switch
    // that had happened; this is the half-sentence that keeps it honest.
    const whenApplied = r => (r && r.applies === 'at-wake' ? ' — applies when the agents wake' : '');

    // Effort rides the same road as the model switch: queued as a control turn,
    // reported inline, and never a dialog. The companion's refusal text (an
    // agent that has no effort levels, a bridge that died between the GET and
    // the POST) is the message.
    async function pickEffort(agent, level) {
      D.models.note = agent + ' effort → ' + level + '…';
      D.models.err = false;
      paintModelHint();
      let r;
      try { r = await cb('onSetEffort')(agent, level); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || r.ok === false) {
        D.models.note = (r && r.error) || 'could not change effort';
        D.models.err = true;
      } else {
        const eff = D.models.effort || (D.models.effort = { current: {}, options: null });
        eff.current = Object.assign({}, eff.current, { [agent]: level });
        D.models.note = agent + ' effort → ' + level + whenApplied(r);
        D.models.err = false;
      }
      syncModels();
    }

    // The switch was moved. A companion setting, not a bridge one, so it
    // applies without a control turn — the companion restarts an idle bridge
    // itself and says so when a running turn means the change has to wait.
    //
    // "API key" with no key saved is not a setting that could work, so it is
    // not sent: the switch is held mid-flight and the options page — the only
    // place a key is ever typed — is opened at that agent's field. What settles
    // it is the companion's own answer about the keys, never this click.
    async function doBill(agent, pos) {
      if (!agent || BILL_POS.indexOf(pos) === -1) return;
      if (pos === 'key' && keyStatus(agent) !== 'set') {
        D.models.keyPending = agent;
        D.models.note = 'no ' + agent + ' key saved — opening settings…';
        D.models.err = false;
        syncModels();
        cb('onOpenOptions')(agent);
        return;
      }
      if (effAuth(agent) === pos && !D.models.keyPending) return;
      D.models.keyPending = null;
      const k = D.models.keys || (D.models.keys = {});
      const prev = (k.modes && k.modes[agent]) || 'auto';
      // optimistic, like every other switch in here: it has to move under the
      // finger, and it goes back if the companion says no
      k.modes = Object.assign({}, k.modes, { [agent]: pos });
      D.models.note = agent + ' billing → ' + BILL_LABEL[pos] + '…';
      D.models.err = false;
      syncModels();
      let r;
      try { r = await cb('onSetKeyMode')(agent, pos); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || r.ok === false) {
        k.modes = Object.assign({}, k.modes, { [agent]: prev });
        D.models.note = (r && r.error) || 'could not change billing';
        D.models.err = true;
      } else {
        D.models.note = agent + ' billing → ' + BILL_LABEL[pos]
          + (r.applies === 'next-restart' ? ' (from the next turn)' : '');
        D.models.err = false;
      }
      syncModels();
    }

    // Everything the companion says about keys arrives here, and nowhere else
    // writes D.models.keys except the optimistic half of doBill. A pending
    // switch is settled by this and only by this: either the key turned up (and
    // `auto` now resolves to it, so the switch lands on "API key" by itself) or
    // it did not, and the switch goes back where it was. No key, no key mode.
    function ingestKeys(k) {
      if (k === undefined) return;     // a companion too old to mention them
      D.models.keys = k || null;
      const pending = D.models.keyPending;
      if (!pending) return;
      D.models.keyPending = null;
      if (!(k && k[pending] === 'set')) {
        D.models.note = 'no ' + pending + ' key saved — ' + pending + ' stays on the subscription';
        D.models.err = false;
      }
    }

    // A switch with two positions and a third thing that is not a position:
    // "asked for a key, waiting to hear whether there is one".
    function syncAuth(group, agent) {
      const seg = group.querySelector('.pop-bill');
      const row = group.querySelector('.pop-auth');
      if (!seg || !row) return;
      // a companion too old to report its key status has nothing to switch
      row.hidden = !(D.models.keys && D.models.keys.modes);
      if (row.hidden) return;
      const pending = D.models.keyPending === agent;
      const cur = pending ? '' : effAuth(agent);
      // the companion still says "key" but there is no key left to bill: the
      // CLIs would quietly fall back, so the row says so instead
      const missing = !pending && authCur(agent) === 'key' && keyStatus(agent) !== 'set';
      // codex is the honest exception: its stored ChatGPT login beats a key in
      // the environment, so a key there is a fallback, not an override
      const codexCaveat = agent === 'codex' && cur === 'key' && keyStatus(agent) === 'set'
        ? 'codex uses a key only when it is not logged in with ChatGPT'
        : '';
      const tip = missing
        ? 'no ' + agent + ' key saved — add one in the extension’s settings, or this stays on the subscription'
        : codexCaveat || BILL_TIP;
      seg.title = tip;
      seg.querySelectorAll('.bseg').forEach(b => {
        const pos = b.getAttribute('data-bill');
        const on = pos === cur;
        const mid = pending && pos === 'key';
        b.classList.toggle('on', on);
        b.classList.toggle('pending', mid);
        b.setAttribute('aria-pressed', mid ? 'mixed' : on ? 'true' : 'false');
        b.title = tip;
      });
      row.classList.toggle('warn', !!missing);
    }

    // How long the answers are. Optimistic — the switch has to move under the
    // finger — and put back if the companion says no.
    async function setVerbosity(level) {
      if (!level || D.models.verbosity === level) return;
      const prev = D.models.verbosity;
      D.models.verbosity = level;
      D.models.note = 'replies: ' + level;
      D.models.err = false;
      syncModels();
      let r;
      try { r = await cb('onSetVerbosity')(level); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || r.ok === false) {
        D.models.verbosity = prev;
        D.models.note = (r && r.error) || 'could not change how the bots talk';
        D.models.err = true;
      }
      syncModels();
    }

    // Relay = hand the agent a fresh session carrying a summary of this one.
    // The companion refuses it when there is nothing to relay ("agents are
    // idle"); that refusal is normal traffic, so it lands inline in the
    // popover, not in a thrown error.
    async function doRelay(agent) {
      if (D.relaying) return;
      D.relaying = true;
      D.models.note = agent === 'both' ? 'relaying both…' : 'relaying ' + agent + '…';
      D.models.err = false;
      syncModels();                       // disables every relay button first
      let r;
      try { r = await cb('onRelay')(agent); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      D.relaying = false;
      if (!r || r.ok === false) {
        D.models.note = (r && r.error) || 'could not reach the companion';
        D.models.err = true;
      } else {
        D.models.note = agent === 'both' ? 'both agents relayed' : agent + ' relayed';
        D.models.err = false;
      }
      syncModels();
    }

    // ---- events ---------------------------------------------------------
    function wireEvents() {
      D.el.selbtn.addEventListener('mousedown', e => e.preventDefault());
      D.el.selbtn.addEventListener('click', e => { e.preventDefault(); cb('onSelect')(); });

      // resize handle
      D.el.grip.addEventListener('mousedown', beginDrag);
      D.el.grip.addEventListener('dblclick', e => { e.preventDefault(); applyWidth(W_DEFAULT); rememberWidth(); });
      window.addEventListener('resize', onWinResize);

      // popover: any in-drawer click outside it dismisses it (the gear's own
      // click is the toggle and must not be eaten here)
      D.shadow.addEventListener('mousedown', e => {
        if (!D.modelsOpen || !e.target.closest) return;
        if (e.target.closest('.popover') || e.target.closest('[data-act="models"]')) return;
        closeModels();
      }, true);
      D.el.pop.addEventListener('change', e => {
        const sel = e.target;
        if (!sel || sel.tagName !== 'SELECT' || sel.disabled) return;
        if (sel.value === NOPICK) return;      // the placeholder is not a choice
        // two selects per agent, told apart by which attribute carries the name
        // (billing is a switch, not a select — it goes through the click path)
        const eff = sel.getAttribute('data-effort');
        if (eff) { pickEffort(eff, sel.value); return; }
        pickModel(sel.getAttribute('data-agent'), sel.value);
      });

      // Coming back from the options page is the moment a key may have been
      // saved, and nothing about saving one produces an event of its own. So a
      // billing switch left waiting asks again the moment this window is
      // focused — the answer that settles it is always the companion's.
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', () => {
          if (D.modelsOpen && D.models.keyPending) refreshModels();
        });
      }

      // a checkbox in a bot's checklist. `change` and not `click`, so keyboard
      // toggles count too — and the box has already moved by the time we get
      // here, which is exactly the optimistic state we want to keep or undo.
      D.shadow.addEventListener('change', e => {
        const box = e.target;
        if (!box || !box.classList || !box.classList.contains('md-tick')) return;
        doTick(box);
      });

      D.shadow.addEventListener('click', e => {
        // a figure from a code-block run: the thumbnail is a link to the size
        // the plot was actually drawn at
        const fig = e.target.closest && e.target.closest('img.runfig');
        if (fig && fig.getAttribute('src')) { openLight(fig.getAttribute('src'), fig.alt); return; }
        if (D.el.light && !D.el.light.hidden && e.target.closest &&
            e.target.closest('.lightbox')) { closeLight(); return; }
        const btn = e.target.closest && e.target.closest('[data-act]');
        // any click that is not the @-menu (a row of it included, once it has
        // been handled below) dismisses it — clicking away is a decision too
        if (D.mention && !(btn && btn.dataset.act === 'mention')) {
          const inBox = e.target.closest && e.target.closest('.composer textarea');
          if (inBox) syncMention(inBox); else closeMention();
        }
        // …and so does anything that is not the export chooser or its button
        if (D.exportOpen && !(btn && /^export(-run)?$/.test(btn.dataset.act || ''))) closeExportPick();
        if (!btn) {
          const card = e.target.closest && e.target.closest('.card[data-thread]');
          if (card && card.dataset.thread !== PAGE_TARGET) focus(card.dataset.thread);
          // blank space in the comments pane un-focuses: the dim lifts and no
          // card is "the" card until the reader points at one again
          else if (D.focused && e.target.closest && e.target.closest('.pane[data-pane="comments"]')) {
            D.focused = null;
            D.el.comments.classList.remove('dim-others');
            D.shadow.querySelectorAll('.card.focused').forEach(c => c.classList.remove('focused'));
          }
          return;
        }
        const act = btn.dataset.act;
        if (act === 'mention') { insertMention(btn.dataset.handle); return; }
        const target = btn.dataset.target;
        if (act === 'close') { close(); return; }
        if (act === 'models') { if (D.modelsOpen) closeModels(); else openModels(); return; }
        if (act === 'relay') { if (!btn.disabled) doRelay(btn.dataset.agent); return; }
        if (act === 'verb') { setVerbosity(btn.dataset.level); return; }
        if (act === 'bill') { doBill(btn.dataset.agent, btn.dataset.bill); return; }
        if (act === 'keys') { cb('onOpenOptions')(null); return; }
        // "use the page's own commenting" / "let Discuss comment here":
        // content.js persists the answer per page, swaps which selection pill
        // is live, and hands the new state back through setReviewHost
        if (act === 'page-comments') { cb('onPageComments')(btn.dataset.want === '1'); return; }
        if (act === 'track-changes') {
          // optimistic, like every other one-click switch here: content.js
          // repaints the page and hands the same answer straight back
          TC.on = btn.dataset.want === '1';
          render();
          cb('onTrackChanges')(TC.on);
          return;
        }
        if (act === 'export') { if (D.exportOpen) closeExportPick(); else openExportPick(); return; }
        if (act === 'export-run') { pickExport(btn.dataset.mode); return; }
        if (act === 'pages') { if (D.view === 'pages') showThreads(); else showPages(); return; }
        if (act === 'pages-back') { showThreads(); return; }
        if (act === 'lib-export') { doLibraryExport(); return; }
        if (act === 'lib-clear') { D.library.confirm = true; D.library.note = ''; renderLibrary(); return; }
        if (act === 'lib-clear-no') { D.library.confirm = false; renderLibrary(); return; }
        if (act === 'lib-clear-yes') { doLibraryClear(); return; }
        if (act === 'page-open') { openPageRow(btn.dataset.url); return; }
        if (act === 'page-export') { doExportPage(btn.dataset.url); return; }
        if (act === 'filter-kind') { setKindFilter(btn.dataset.kind || ''); return; }
        if (act === 'filter-tag') { toggleTagFilter(btn.dataset.tag || ''); return; }
        if (act === 'filter-clear') { setFilter('', ''); return; }
        if (act === 'page-rename') { openRowEditor('renaming', btn.dataset.url); return; }
        if (act === 'page-tag') { openRowEditor('tagging', btn.dataset.url); return; }
        if (act === 'rename-no' || act === 'tag-no') { closeRowEditors(); return; }
        if (act === 'rename-save') { saveRename(btn.dataset.url); return; }
        if (act === 'tag-save') { saveTags(btn.dataset.url); return; }
        if (act === 'tag-pick') { completeTag(btn.dataset.tag); return; }
        if (act === 'page-del') { D.pages.confirm = btn.dataset.url; D.pages.rowErr = null; renderPages(); return; }
        if (act === 'page-del-no') { D.pages.confirm = null; renderPages(); return; }
        if (act === 'page-del-yes') { doDeletePage(btn.dataset.url); return; }
        // the round strip: its quote is a place on the page, so it behaves
        // like the quote on a card — scroll there and focus it. Unlike a
        // card's quote there is no orphan/pending guard, because the thread
        // named here is one a bot is answering right now.
        if (act === 'round-jump') {
          focus(target);
          cb('onJump')(target);
          return;
        }
        if (act === 'round-dismiss') { D.round = null; paintRound(); return; }
        if (act === 'jump') {
          const card = btn.closest('.card');
          if (card && !card.classList.contains('orphaned') && !card.classList.contains('pending')) {
            focus(target); cb('onJump')(target);
          }
          return;
        }
        if (act === 'route') { pickRoute(target, btn.dataset.route); return; }
        if (act === 'send') { doSend(target); return; }
        if (act === 'send-retry') { retrySend(target, btn.dataset.out); return; }
        if (act === 'send-discard') { discardSend(target, btn.dataset.out); return; }
        if (act === 'cancel-new') { cancelNew(); return; }
        if (act === 'tools') { const k = btn.dataset.key; D.toolsOpen[k] = !D.toolsOpen[k]; render(); return; }
        // both ways, unlike the thread fold: a reader who opened the long half
        // of one answer is reading it, not committing to it
        if (act === 'more') { const k = btn.dataset.key; D.moreOpen[k] = !D.moreOpen[k]; render(); return; }
        if (act === 'run') { doRun(btn); return; }
        if (act === 'run-stop') { doRunStop(btn); return; }
        if (act === 'run-more') {
          const a = runAddr(btn);
          if (a) { D.runOpen[a.key] = true; render(); }
          return;
        }
        // one way only: a thread the reader has opened stays open for the
        // session. Re-folding it under them while they read is not a feature.
        // both directions are the reader's own decision about this thread, and
        // both stick for the session — a new reply never undoes either
        if (act === 'expand') { D.expanded[target] = FOLD_OPEN; render(); return; }
        if (act === 'fold') { D.expanded[target] = FOLD_SHUT; render(); return; }
        // the tasks card: its fold is a reading position (session only, like
        // every other one here), and ↑ source is the way back to the message
        if (act === 'tasks-fold') { D.tasksOpen = !D.tasksOpen; render(); return; }
        if (act === 'tasks-jump') { jumpToTasks(); return; }
        if (act === 'interrupt') { doInterrupt(btn); return; }
        if (act === 'retry') { cb('onReconnect')(); return; }
        if (act === 'warn-dismiss') { setWarning(''); return; }
        if (act === 'copy') { doCopy(btn); return; }
        if (act === 'edit') { startEdit(btn); return; }
        if (act === 'del-msg') { doDelete(target, btn.dataset.ts); return; }
        if (act === 'resolve') { doResolve(target, true); return; }
        if (act === 'reopen') { doResolve(target, false); return; }
        if (act === 'not-done') { doNotDone(target); return; }
        if (act === 'resolved-toggle') { D.resolvedOpen = !D.resolvedOpen; render(); return; }
        if (act === 'ready-toggle') { D.readyOpen = !D.readyOpen; render(); return; }
        if (act === 'resolved-card') { D.resolvedCards[target] = !D.resolvedCards[target]; render(); return; }
        if (act === 'summarize') { doSummarize(target); return; }
        if (act === 'root-yes') { answerRoot(true); return; }
        if (act === 'root-no') { answerRoot(false); return; }
        if (act === 'arch-list') {
          D.picking = !D.picking;
          if (D.picking && !D.archive.list && !D.archive.loading) { loadArchive(); return; }
          render();
          return;
        }
        // one step, inline, like del-thread: the count is the whole of the
        // warning, because "send" here spends real agent time on a message
        // nobody typed
        if (act === 'send-review') { D.review.confirm = true; D.review.err = ''; D.review.note = ''; render(); return; }
        if (act === 'review-no') { D.review.confirm = false; render(); return; }
        if (act === 'review-yes') { sendReview(); return; }
        if (act === 'arch-new') { openSession(null); return; }
        if (act === 'arch-open' && btn.dataset.sid) { openSession(btn.dataset.sid); return; }
        if (act === 'del-thread') { D.confirm = target; render(); return; }
        if (act === 'del-thread-no') { D.confirm = null; render(); return; }
        if (act === 'del-thread-yes') { D.confirm = null; doDelete(target, null); return; }
      });

      D.el.tabs.addEventListener('click', e => {
        const t = e.target.closest && e.target.closest('.tab');
        if (!t || t.disabled) return;
        D.tab = t.dataset.tab;
        paintTabs();
        rememberTab();
      });

      D.el.conn.addEventListener('click', () => { if (!D.connected) cb('onReconnect')(); });

      // the caret moved or the text changed: the @-menu follows both
      D.shadow.addEventListener('input', e => {
        const ta = e.target;
        if (ta && ta.tagName === 'TEXTAREA' && ta.closest && ta.closest('.composer')) {
          // a draft holds its composer open (the Send row) even after blur
          ta.closest('.composer').classList.toggle('has-draft', !!ta.value.trim());
          syncMention(ta);
          syncRoutes(ta);
        }
        // …and the tag menu follows the box it belongs to, the same way
        if (ta && ta.dataset && ta.dataset.act === 'tag-input') { D.pages.pick = 0; paintTagMenu(ta); }
      });
      // Clicking back into the tag box reopens the menu without a keystroke:
      // with the token under the caret empty it offers EVERY tag in use, as
      // colored chips — pick-from-existing, so reusing a tag never depends on
      // remembering it. (The render path already does this via focusRowEditor;
      // this covers a focus the reader gives back by hand, e.g. after Esc.)
      D.shadow.addEventListener('focusin', e => {
        const el = e.target;
        if (el && el.dataset && el.dataset.act === 'tag-input') { D.pages.pick = 0; paintTagMenu(el); }
      });
      D.shadow.addEventListener('keyup', e => {
        if (!/^(Arrow|Home|End|PageUp|PageDown)/.test(e.key || '')) return;
        const ta = e.target;
        if (ta && ta.tagName === 'TEXTAREA' && ta.closest && ta.closest('.composer')) syncMention(ta);
      });

      // ⌘/Ctrl+Enter sends; plain Enter stays a newline (comments run long)
      D.shadow.addEventListener('keydown', e => {
        // While the @-menu is open it owns the arrows, Enter, Tab and Esc —
        // and nothing else. ⌘↩ still sends: finishing a mention is not a
        // reason to hold a finished message back.
        if (D.mention && e.target && e.target.closest && e.target.closest('.composer')) {
          const m = D.mention;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : m.items.length - 1;
            m.index = (m.index + step) % m.items.length;
            paintMention();
            return;
          }
          if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
            e.preventDefault();
            insertMention(m.items[m.index]);
            return;
          }
          if (e.key === 'Escape') {
            // one layer at a time: the menu, and the drawer stays open
            e.preventDefault();
            e.stopPropagation();
            closeMention();
            return;
          }
        }
        // A row's rename / tag box: Enter saves, Esc closes the editor and not
        // the drawer, and while the completion menu is up it owns the arrows,
        // Tab and Enter — exactly as the @-menu does in a composer.
        const pedit = e.target && e.target.dataset && /^(rename|tag)-input$/.test(e.target.dataset.act || '')
          ? e.target : null;
        if (pedit) {
          const tagging = pedit.dataset.act === 'tag-input';
          const items = tagging ? tagMatches(pedit) : [];
          const menuOpen = tagging && items.length
            && !(pedit.parentNode.querySelector('.tagmenu') || {}).hidden;
          if (menuOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            const step = e.key === 'ArrowDown' ? 1 : items.length - 1;
            D.pages.pick = (D.pages.pick + step) % items.length;
            paintTagMenu(pedit);
            return;
          }
          if (menuOpen && e.key === 'Tab') { e.preventDefault(); completeTag(items[D.pages.pick]); return; }
          if (e.key === 'Enter') {
            e.preventDefault();
            const { word } = tagging ? tagToken(pedit) : { word: '' };
            // Enter completes the highlighted suggestion when one is being
            // typed at, and otherwise saves — a menu row is never the whole
            // point of pressing Enter in a box you have finished filling in
            if (menuOpen && word) completeTag(items[D.pages.pick]);
            else if (tagging) saveTags(pedit.dataset.url);
            else saveRename(pedit.dataset.url);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (menuOpen) { const m = pedit.parentNode.querySelector('.tagmenu'); m.hidden = true; m.innerHTML = ''; }
            else closeRowEditors();
            return;
          }
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          // Esc peels one layer at a time: whichever popover is open, then the
          // drawer itself
          if (D.pages.renaming || D.pages.tagging) { closeRowEditors(); return; }
          if (D.light) closeLight();
          else if (D.exportOpen) closeExportPick();
          else if (D.modelsOpen) closeModels();
          else close();
          return;
        }
        if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
        const c = e.target.closest && e.target.closest('.composer');
        if (!c) return;
        e.preventDefault();
        const target = c.getAttribute('data-target');
        // the inline edit composer has its own save handler; ⌘↩ must hit that,
        // not post a fresh reply to a thread called "__edit__"
        if (target === '__edit__') { const b = c.querySelector('.send'); if (b) b.click(); return; }
        doSend(target);
      });
    }

    // Focusing a thread must always RESULT IN A CARD ON SCREEN. Clicking a
    // green highlight on the page is the case that forces it: content.js does
    // open → focus → scrollToThread, and a filed thread lives inside a section
    // that is collapsed by default, so without this the click would open the
    // drawer onto nothing. So a focus that names a resolved thread opens the
    // archive and unfolds that card — the reader arrives at the thread itself,
    // with its Reopen button, exactly as they would on a yellow highlight.
    function focus(id) {
      const revealed = reveal(id);
      if (D.focused === id) { if (revealed) render(); return; }
      D.focused = id;
      if (revealed) render();
      else D.shadow.querySelectorAll('.card').forEach(c => c.classList.toggle('focused', c.dataset.thread === id));
      D.el.comments.classList.toggle('dim-others', !!D.focused);
      cb('onFocus')(id);
    }
    // Arriving at a thread means its TOP is at the top of the pane: the
    // blockquote and the first comment are what a highlight click promises,
    // and a card taller than the pane has no useful "center". The jump is
    // instant, not smooth — render() saves and restores scrollTop around every
    // rebuild, so a scroll still animating when a stream event lands would be
    // frozen wherever the animation happened to be.
    function scrollToThread(id) {
      if (!D.mounted || !id) return;
      const card = D.shadow.querySelector('.card[data-thread="' + String(id).replace(/"/g, '\\"') + '"]');
      if (!card) return;
      const box = D.el.comments;
      const top = card.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      box.scrollTop = Math.max(0, top - 8);
    }
    // …whatever it takes to make `id` visible. Returns whether anything had to
    // change, so the caller knows a full render is needed rather than a class
    // toggle over the cards already drawn.
    function reveal(id) {
      const t = id ? threadById(id) : null;
      if (!t || !t.resolved) return false;
      let changed = false;
      if (!D.resolvedOpen) { D.resolvedOpen = true; changed = true; }
      if (!D.resolvedCards[id]) { D.resolvedCards[id] = true; changed = true; }
      if (D.tab !== 'comments') { D.tab = 'comments'; paintTabs(); changed = true; }
      return changed;
    }

    function note(target, text, err, transient) {
      const key = target == null ? PAGE_TARGET : target;
      // a wait remembers how many bot messages this target had when it was
      // written, which is what lets a later refetch decide it is over
      if (text) D.notes[key] = { text, err: !!err, transient: !!transient,
                                 ...(transient ? { bots: botsIn(key) } : {}) };
      else delete D.notes[key];
      render();
    }

    // A waiting line lives and dies with the wait. Removal is SILENT: the reply
    // that arrives is the only "ready" anyone needs, so nothing takes its place.
    function clearWaiting(target) {
      const n = D.notes[target];
      if (!n || !n.transient) return false;
      delete D.notes[target];
      return true;
    }
    // True only inside the window the word "queued" describes: this target has
    // no turn running and none has begun or ended since the send left.
    const queueWindowOpen = (key, epoch) =>
      key != null && !D.running[key] && D.turnSeq[key] === epoch;

    // What the wait actually says. The companion knows WHY the turn has not
    // started — the bridge is being woken (ten or twenty seconds, cold), or
    // another page has the floor — and saying which is the difference between
    // a wait that looks alive and one that looks broken. An older companion
    // sends no `wait` field and gets the word it always used.
    function waitText(res) {
      if (res.wait === 'bridge_starting') return 'waking the agents…';
      if (res.position > 1) return `queued (#${res.position})`;
      // Two different waits, since turns run several at a time. 'busy' is THIS
      // conversation still talking — a page's chat is one session and its turns
      // are serial on purpose. 'pool_busy' is every agent in the building taken
      // by somebody else's page, which is the wait the old single queue used to
      // give for both and could not tell apart.
      if (res.wait === 'busy') return 'queued behind this conversation…';
      if (res.wait === 'pool_busy') return 'queued behind another chat…';
      return 'queued…';
    }
    const bumpTurn = target => { D.turnSeq[target] = (D.turnSeq[target] || 0) + 1; };

    const composerBox = target =>
      D.mounted && D.shadow.querySelector('.composer[data-target="' + cssq(target) + '"] textarea');

    // OPTIMISTIC SEND. Everything the user can see happens before the first
    // `await`: the message is appended to its thread, the composer empties, and
    // the render lands. Only then does the slow half run — content.js re-reads
    // the page and may fetch a .docx before the POST even starts, which is what
    // made a send feel broken and made people click Send twice.
    //
    // Which is the other half of the fix: a second click has nothing to send
    // (the box is empty) and the same-tick latch catches the pathological case
    // where two events fire off one gesture. One gesture, one POST.
    function doSend(target) {
      if (!target || target === '__edit__') return;
      if (D.sendLock[target]) return;
      // a brand-new thread must not be created twice while its id is in flight
      if (target === '__new__' && inFlight(target)) return;
      D.sendLock[target] = true;
      try {
        harvestDrafts();
        const text = (D.drafts[target] || '').trim();
        if (!text) return;
        const btn = D.mounted && D.shadow.querySelector('.composer[data-target="' + cssq(target) + '"] .send');
        if (btn) btn.disabled = true;          // released by the render below
        // Where this one goes, decided while the words are still here: a tag in
        // the text, else the pill, else the thread's sticky address. Sending
        // also SETTLES the row — a message that typed "@codex" leaves Codex lit,
        // so the next untagged reply goes where the reader can see it will.
        const route = routeNow(target);
        D.routes[target] = route;
        deliver(target, queueSend(target, text, route));
      } finally {
        delete D.sendLock[target];
      }
    }

    // The synchronous half: the message becomes a pending message, the composer
    // is emptied, the last error line goes.
    function queueSend(target, text, route) {
      const list = D.outbox[target] || (D.outbox[target] = []);
      const twins = list.filter(e => e.text === text).length;
      // `route` rides the entry rather than being recomputed on delivery: a
      // retry minutes later must go where the message was addressed when it was
      // written, not where the pill happens to point by then.
      const entry = { id: 'o-' + (++outSeq), text, route: route || '', state: 'sending', error: '',
                      seen: countSame(target, text) + twins };
      list.push(entry);
      closeMention();   // the message has gone; there is nothing left to complete
      delete D.drafts[target];
      delete D.notes[target];
      const box = composerBox(target);
      if (box) box.value = '';
      render();
      return entry;
    }

    function dropOutbox(target, entry) {
      const list = D.outbox[target];
      if (!list) return;
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) delete D.outbox[target];
    }

    // The asynchronous half. Retry re-enters here with the same entry, so this
    // is also the whole retry path.
    async function deliver(target, entry) {
      entry.state = 'sending';
      entry.error = '';
      // Which turn generation this send belongs to, sampled BEFORE the await:
      // anything that moves this target's counter while the POST is out means
      // the bots started (or finished) first and "queued…" is already false. A
      // brand-new thread has no id and no history yet, so its window is open
      // exactly while its minted id has never been named by a turn event.
      const epoch = target === '__new__' ? undefined : D.turnSeq[target];
      let res;
      try {
        res = target === '__new__'
          ? await cb('onSave')({ ...D.pending, text: entry.text, route: entry.route })
          // the library is a page chat on a page nobody is standing on, so the
          // send says WHICH page rather than letting content.js assume this one
          : target === LIBRARY_TARGET
            ? await cb('onLibraryReply')(entry.text)
            : await cb('onReply')(target, entry.text, entry.route);
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }
      if (!res || res.ok === false) {
        // the text stays exactly where the user can see it, with a way to send
        // it again — never silently back in a box they have stopped looking at
        entry.state = 'failed';
        entry.error = (res && res.error) || SEND_FAIL;
        render();
        return;
      }
      // Success. The record now holds the server's own copy (content.js pushed
      // it, idempotently — a {deduped:true} answer echoes the message that was
      // already there, and pushing it twice is what that guard is for), so the
      // pending copy simply goes.
      dropOutbox(target, entry);
      // a fresh thread's status chip has to land on the id the SERVER minted
      // (content.js normalises /thread's {ok, thread} into thread_id; accept
      // the raw {thread:{id}} shape too so neither side can drift silently)
      const newId = (res.thread_id || (res.thread && res.thread.id)) || null;
      if (target === '__new__') {
        D.pending = null;
        // the spotlight follows the thread the composer just became
        if (D.focused === '__new__') D.focused = newId;
        // …and so does the pill row: the address the reader picked for the
        // first comment is this thread's address now
        if (newId && D.routes.__new__) D.routes[newId] = D.routes.__new__;
        delete D.routes.__new__;
      }
      const key = target === '__new__' ? newId : target;
      // The companion took the message but will not summon the bots for this
      // sender (a guest with no bot access, or a companion started
      // --no-agents). That is not a failed send — the message is saved — so it
      // is said next to the composer and nothing is rolled back.
      // A refusal is a message about this send and outranks any wait: it says
      // why the bots are not coming, and must never be dressed up as "queued".
      if (res.reason) note(key == null ? null : key, res.reason, true);
      else if (!res.queued) note(target === '__new__' ? null : target, null);
      else if (queueWindowOpen(key, epoch)) {
        note(key, waitText(res), false, true);
      } else render();   // the turn is already under way, or already over: say nothing
    }

    const findOut = (target, id) => outboxFor(target).find(e => e.id === id) || null;

    function retrySend(target, id) {
      const e = findOut(target, id);
      if (!e || e.state === 'sending') return;
      // its baseline may have moved while it sat there failed
      e.seen = countSame(target, e.text) +
        outboxFor(target).filter(x => x !== e && x.text === e.text && x.state === 'sending').length;
      e.state = 'sending';
      e.error = '';
      render();
      deliver(target, e);
    }

    // Discard = "I will deal with this myself": the text goes back into the
    // composer rather than into the bin, on top of whatever is already there.
    function discardSend(target, id) {
      const e = findOut(target, id);
      if (!e) return;
      dropOutbox(target, e);
      harvestDrafts();
      const cur = D.drafts[target] || '';
      const text = cur ? e.text + '\n\n' + cur : e.text;
      D.drafts[target] = text;
      // the LIVE textarea too, not just the draft: render() harvests the DOM
      // before it rebuilds it, and an empty box would delete the draft again
      const live = composerBox(target);
      if (live) live.value = text;
      render();
      const box = composerBox(target);
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }

    // ── copying a message out ──────────────────────────────────────────────
    // Two flavours, always: the RENDERED html, so a paste into a document keeps
    // the links live and the lists lists; and the raw markdown the author
    // actually wrote, so a paste into a text field is what was typed rather
    // than a flattened rendering of it. (The council does the same —
    // frontends/council/assets/app.js copyMessage.)
    //
    // The drawer runs inside arbitrary pages, plenty of them plain http, where
    // navigator.clipboard does not exist at all — so there is a second path
    // that puts BOTH flavours on the clipboard through a `copy` event on a
    // textarea of the drawer's own, inside the shadow root. The host page's
    // DOM is never touched, and neither is its clipboard handling.
    function copyFlavours(reply) {
      // Usually one block; a folded "▸ more" answer is TWO halves of the same
      // message, and copy hands back the message — folded or not, head and
      // tail, in the order they were written.
      const cts = [...reply.querySelectorAll('.ctext.md')];
      if (!cts.length) return null;
      const html = [], text = [];
      for (const ct of cts) {
        // the Run bar and whatever the last run printed are chrome the drawer
        // drew, not words anybody wrote: they do not travel
        const clone = ct.cloneNode(true);
        clone.querySelectorAll('.runbox').forEach(n => n.remove());
        const raw = ct.getAttribute('data-raw');
        html.push(clone.innerHTML);
        text.push(raw == null ? clone.textContent : raw);
      }
      return { html: html.join(''), text: text.join('\n\n') };
    }
    function legacyCopy(html, text) {
      if (!D.el.panel || typeof document.execCommand !== 'function') return false;
      const ta = mk('textarea');
      ta.value = text;
      ta.setAttribute('style', 'position:fixed;top:-9999px;left:-9999px;opacity:0');
      ta.addEventListener('copy', e => {
        if (!e.clipboardData) return;
        e.preventDefault();
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
      });
      const prev = D.shadow.activeElement;
      D.el.panel.appendChild(ta);
      let ok = false;
      try {
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
      } catch { ok = false; }
      ta.remove();
      // whatever the reader was typing in stays what they were typing in
      if (prev && typeof prev.focus === 'function') prev.focus();
      return ok;
    }
    let copyTimer = null;
    // Said on the button itself, in the drawer's own grammar: this UI renders
    // inside somebody else's page and has nowhere to put a toast.
    //
    // Painted on the live node AND remembered in D.copied, because the two
    // failure modes are opposite ones: a full render() during the window would
    // throw a DOM-only confirmation away (a stream landing in another thread
    // rebuilds both panes, and that is exactly when somebody is copying), and
    // a state-only one would cost a render per click. So: paint now, and let
    // replyHtml re-emit it if the pane is rebuilt under us.
    // a quoted attribute-selector value only has to escape " and \
    const cssEsc = s => String(s == null ? '' : s).replace(/["\\]/g, '\\$&');
    function paintCopied(btn, ok) {
      if (!btn) return;
      btn.textContent = ok == null ? COPY_GLYPH : (ok ? '✓' : '✕');
      btn.classList.toggle('done', ok === true);
      btn.title = ok == null ? COPY_TIP : (ok ? 'copied' : COPY_FAIL);
    }
    // whichever button is live NOW: the clipboard settles a beat after the
    // click, and a render() in that beat replaces the node that was pressed
    const liveCopyBtn = key => (key && D.mounted
      ? D.shadow.querySelector(`[data-copykey="${cssEsc(key)}"]`) : null);
    function markCopied(btn, ok) {
      const key = btn.getAttribute('data-copykey');
      D.copied = key ? { key, ok: !!ok } : null;
      paintCopied(liveCopyBtn(key) || btn, !!ok);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        D.copied = null;
        paintCopied(liveCopyBtn(key), null);
      }, COPY_HOLD);
    }
    function doCopy(btn) {
      const reply = btn.closest('.reply');
      const f = reply && copyFlavours(reply);
      if (!f) return;
      const nav = navigator;
      const rich = nav.clipboard && typeof nav.clipboard.write === 'function' &&
        typeof root.ClipboardItem === 'function' && typeof root.Blob === 'function';
      if (rich) {
        let item = null;
        try {
          item = new root.ClipboardItem({
            'text/html': new root.Blob([f.html], { type: 'text/html' }),
            'text/plain': new root.Blob([f.text], { type: 'text/plain' }),
          });
        } catch { item = null; }
        if (item) {
          nav.clipboard.write([item]).then(
            () => markCopied(btn, true),
            () => markCopied(btn, legacyCopy(f.html, f.text)));
          return;
        }
      }
      markCopied(btn, legacyCopy(f.html, f.text));
    }

    function startEdit(btn) {
      const reply = btn.closest('.reply');
      const target = btn.dataset.target, ts = btn.dataset.ts;
      if (!reply || reply.querySelector('textarea')) return;
      const body = reply.querySelector('.ctext');
      // The RAW stored text, never the rendered DOM. Messages are markdown on
      // screen now, so reading textContent back would hand the user their own
      // sentence with the syntax stripped out — and then save that as the
      // message. The record is the only source of truth for an editor.
      const msg = findMsg(target, ts, reply.getAttribute('data-author'));
      const old = msg && msg.text != null ? String(msg.text)
        : (body ? body.textContent : '');
      body.innerHTML = `<div class="composer" data-target="__edit__">
        <textarea rows="2">${esc(old)}</textarea>
        <div class="crow"><span class="hint"></span><button class="cancel" type="button">Cancel</button><button class="send" type="button">Save</button></div></div>`;
      const ta = body.querySelector('textarea');
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      body.querySelector('.cancel').addEventListener('click', ev => { ev.stopPropagation(); render(); });
      body.querySelector('.send').addEventListener('click', async ev => {
        ev.stopPropagation();
        const v = ta.value.trim();
        if (!v) return;
        const r = await cb('onEdit')(target, ts, v);
        if (r && r.ok === false) note(target, r.error || 'edit failed', true); else render();
      });
    }

    // ---- checklists -------------------------------------------------------
    // A tick is a message edit the companion performs: it rewrites the Nth
    // "- [ ]" in that message and hands the whole new body back, which is what
    // gets rendered. So the truth is always the message text — a refetch, a
    // second tab and a reload all show the same ticks with no client state.
    //
    // Optimistic in between: the box has already moved (this runs on `change`),
    // the label greys immediately, and a refusal puts both back.
    //
    // A timestamp is how a message is addressed, but it is NOT an identity: the
    // companion stamps in whole milliseconds and two messages regularly share
    // one — a bot's tool summary and the answer it belongs to always do, and a
    // reply can land in the same tick as the message before it. So the row's
    // own author (and the fact that a rendered answer is never the tools row
    // beside it) breaks the tie; otherwise the editor would open on somebody
    // else's sentence and the checklist would tick in the wrong message.
    function findMsg(target, ts, author) {
      // msgListFor knows about the library as well as this page's threads —
      // a code block in the library chat is addressed exactly like any other
      const list = msgListFor(target) || [];
      const hits = list.filter(m => m && m.ts === ts);
      if (hits.length < 2) return hits[0] || null;
      const same = a => String(a || '').toLowerCase() === String(author || '').toLowerCase();
      const named = author == null ? hits : hits.filter(m => same(m.author));
      return named.find(m => m.kind !== 'tools') || named[0] || hits[0] || null;
    }

    // ---- running a code block ---------------------------------------------
    // A fenced ```python block in ANY message — the reader's own or a bot's —
    // gets a quiet Run button, and pressing it runs that code on this Mac with
    // this user's privileges. There is no sandbox and the tooltip says so.
    //
    // Nothing executable travels: the click sends an ADDRESS (thread, ts,
    // author, block ordinal) and the companion takes the code out of the stored
    // message itself. The result comes back and is written onto the record, so
    // it survives a refetch, a re-render and a second tab without any state
    // here — the same trick the checklists use.
    const RUN_TIP = 'Runs this code on this Mac as you';
    const isPy = lang => /^(py|python|python3)$/i.test(String(lang || '').trim());
    const STDOUT_FOLD = 30;      // lines of stdout before it folds away
    const runKeyOf = (target, ts, i) => target + '|' + ts + '|' + i;

    // A block's Run button, its spinner while it runs, and whatever the last
    // run of it printed — built as DOM (never an HTML string), like the
    // markdown around it.
    function decorateRuns(scope) {
      if (!scope) return;
      scope.querySelectorAll('.ctext.md').forEach(el => {
        const pres = el.querySelectorAll('pre.md-code[data-block]');
        if (!pres.length) return;
        // An unsent message has no timestamp, so it has no address — and a
        // block cannot be run before the companion has the message it is in.
        const reply = el.closest('.reply[data-ts]');
        const card = el.closest('.card[data-thread]');
        if (!reply || !card) return;
        const target = card.getAttribute('data-thread');
        const ts = reply.getAttribute('data-ts');
        const author = reply.getAttribute('data-author');
        const msg = findMsg(target, ts, author);
        const runs = (msg && msg.runs) || {};
        pres.forEach(pre => {
          if (pre.nextSibling && pre.nextSibling.classList &&
              pre.nextSibling.classList.contains('runbox')) return;   // already drawn
          const i = pre.getAttribute('data-block');
          const runnable = D.canRun && isPy(pre.getAttribute('data-lang'));
          const result = runs[i];
          const key = runKeyOf(target, ts, i);
          if (!runnable && !result && !D.runErr[key]) return;
          const box = mk('div', 'runbox');
          box.setAttribute('data-block', i);
          box.appendChild(runBar(key, runnable, result));
          if (D.runErr[key]) {
            const e = mk('div', 'runstat bad');
            e.textContent = D.runErr[key];
            box.appendChild(e);
          }
          if (result) box.appendChild(runResult(key, result));
          pre.parentNode.insertBefore(box, pre.nextSibling);
        });
      });
      loadFigures(scope);
    }

    function runBar(key, runnable, result) {
      const bar = mk('div', 'runbar');
      const running = D.runState[key] === 'running';
      if (running) {
        const s = mk('span', 'runwait');
        s.appendChild(mk('span', 'spin')).textContent = '◐';
        s.appendChild(document.createTextNode('running…'));
        bar.appendChild(s);
        // cancelling is one kill on the child's process group, so it is cheap
        // and it is offered; the timeout stays the backstop underneath it
        const stop = mk('button', 'runbtn stop');
        stop.type = 'button';
        stop.setAttribute('data-act', 'run-stop');
        stop.title = 'Stop this run';
        stop.textContent = '✕ stop';
        bar.appendChild(stop);
      } else if (runnable) {
        const b = mk('button', 'runbtn');
        b.type = 'button';
        b.setAttribute('data-act', 'run');
        b.title = RUN_TIP;
        b.textContent = result ? '▷ Run again' : '▷ Run';
        bar.appendChild(b);
      }
      // which interpreter answered, and nothing else: how long it took belongs
      // to the status line under the block, where it is read WITH the result
      if (result && !running && result.python) {
        const meta = mk('span', 'runmeta');
        meta.textContent = 'python ' + result.python;
        bar.appendChild(meta);
      }
      return bar;
    }

    // Exit status is shown ONLY when there is something wrong with it: a clean
    // run says what it printed, and says it ran.
    const RUN_BAD = {
      error: r => 'exit ' + r.exit,
      timeout: () => 'timed out',
      cancelled: () => 'stopped',
      failed: () => 'python could not start',
    };

    // ms while a run is a fraction of a second (which most of them are), and
    // seconds once it is worth counting them
    function runDur(ms) {
      const n = Math.max(0, Number(ms) || 0);
      if (n < 1000) return Math.round(n) + ' ms';
      const s = n / 1000;
      return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + ' s';
    }

    function runResult(key, r) {
      const out = mk('div', 'runout');
      const stdoutText = String(r.stdout == null ? '' : r.stdout);
      const stderrText = String(r.stderr == null ? '' : r.stderr);
      const figs = Array.isArray(r.figures) ? r.figures : [];
      // THE INVARIANT: a run that has happened never looks like a run that has
      // not. `doubling_time = log(2)/0.61` exits 0 in 79ms and prints nothing,
      // and for a while that rendered as absolutely nothing — a button you had
      // pressed and a page that had not moved, indistinguishable from a dead
      // control. So every completed run says so in one quiet line, and a run
      // that printed nothing says THAT out loud too.
      const silent = !stdoutText.trim() && !stderrText.trim() && !figs.length;
      const bad = RUN_BAD[r.status];
      const line = mk('div', 'runstat ' + (bad ? 'bad' : 'ok'));
      line.textContent = (bad ? bad(r) : '✓ ran') + ' · ' + runDur(r.ms)
        + (!bad && silent ? ' · no output' : '');
      out.appendChild(line);
      const stdout = stdoutText;
      if (stdout.trim()) {
        // one trailing newline is how printing works, not a 43rd line
        const lines = stdout.replace(/\n$/, '').split('\n');
        const open = !!D.runOpen[key] || lines.length <= STDOUT_FOLD;
        if (!open) {
          const more = mk('button', 'showmore');
          more.type = 'button';
          more.setAttribute('data-act', 'run-more');
          more.setAttribute('aria-expanded', 'false');
          more.textContent = 'Show all ' + lines.length + ' lines';
          out.appendChild(more);
        }
        const pre = mk('pre', 'runstdout');
        pre.textContent = open ? stdout : lines.slice(0, STDOUT_FOLD).join('\n');
        out.appendChild(pre);
      }
      const stderr = stderrText;
      if (stderr.trim()) {
        const pre = mk('pre', 'runstderr');
        pre.textContent = stderr;
        out.appendChild(pre);
      }
      const figures = figs;
      if (figures.length) {
        const wrap = mk('div', 'runfigs');
        figures.forEach((name, n) => {
          const img = mk('img', 'runfig');
          img.alt = 'figure ' + (n + 1);
          img.title = 'Click to enlarge';
          img.setAttribute('data-run', r.run_id || '');
          img.setAttribute('data-fig', name);
          wrap.appendChild(img);
        });
        out.appendChild(wrap);
      }
      return out;
    }

    // A figure is a file on the companion behind an owner-only route, so it
    // cannot simply be an <img src>: the bytes come back through the extension's
    // background worker (which has the credentials) as a data: url, cached here
    // so a re-render never refetches. A page whose own CSP forbids data: images
    // shows the caption instead of the plot — the run is unaffected.
    function loadFigures(scope) {
      scope.querySelectorAll('img.runfig[data-fig]').forEach(img => {
        const run = img.getAttribute('data-run');
        const name = img.getAttribute('data-fig');
        const k = run + '|' + name;
        img.addEventListener('error', () => {
          if (!img.getAttribute('src')) return;
          const note = mk('div', 'runstat');
          note.textContent = img.alt + ' — this page will not display it';
          if (img.parentNode) img.parentNode.replaceChild(note, img);
        });
        if (D.figs[k]) { img.src = D.figs[k]; return; }
        if (D.figLoading[k]) return;
        D.figLoading[k] = true;
        Promise.resolve(cb('onRunFigure')(targetOfEl(img), run, name))
          .then(r => {
            delete D.figLoading[k];
            if (!r || r.ok === false || !r.data_url) return;
            D.figs[k] = r.data_url;
            if (!D.mounted) return;
            D.shadow.querySelectorAll('img.runfig[data-fig="' + cssq(name) + '"][data-run="' + cssq(run) + '"]')
              .forEach(el => { el.src = r.data_url; });
          })
          .catch(() => { delete D.figLoading[k]; });
      });
    }
    // The library's messages belong to another url entirely; everything else
    // belongs to the page we are standing on. content.js turns the target into
    // the real address — the drawer only says which conversation it is.
    const targetOfEl = el => {
      const card = el.closest && el.closest('.card[data-thread]');
      return card ? card.getAttribute('data-thread') : PAGE_TARGET;
    };

    // Where a block's address comes from at click time: the ancestors, exactly
    // as a tick's does. Nothing about a run is held in a data attribute that
    // the record could not answer for.
    function runAddr(el) {
      const box = el.closest('.runbox[data-block]');
      const reply = el.closest('.reply[data-ts]');
      const card = el.closest('.card[data-thread]');
      if (!box || !reply || !card) return null;
      const index = Number(box.getAttribute('data-block'));
      if (!isFinite(index)) return null;
      const target = card.getAttribute('data-thread');
      const ts = reply.getAttribute('data-ts');
      return { target, ts, author: reply.getAttribute('data-author'), index,
               key: runKeyOf(target, ts, index) };
    }

    async function doRun(btn) {
      const a = runAddr(btn);
      if (!a) return;
      if (D.runState[a.key] === 'running') return;
      D.runState[a.key] = 'running';
      delete D.runErr[a.key];
      render();
      let r;
      try { r = await cb('onRun')(a.target, a.ts, a.author, a.index); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      delete D.runState[a.key];
      if (!r || r.ok === false) D.runErr[a.key] = (r && r.error) || 'could not run that block';
      else if (r.run) {
        const msg = findMsg(a.target, a.ts, a.author);
        if (msg) {
          if (!msg.runs) msg.runs = {};
          msg.runs[String(a.index)] = r.run;
        }
      }
      render();
    }

    async function doRunStop(btn) {
      const a = runAddr(btn);
      if (!a) return;
      try { await cb('onRunCancel')(a.target, a.ts, a.author, a.index); }
      catch { /* the run answers for itself either way */ }
    }

    // ---- the lightbox -------------------------------------------------------
    // A plot drawn to the width of a 420px drawer is a picture of a plot. One
    // click fills the window with it; Esc, or a click anywhere on the scrim,
    // puts it back.
    function openLight(src, alt) {
      if (!D.mounted || !D.el.light || !src) return;
      D.light = src;
      D.el.light.innerHTML = '';
      const img = mk('img');
      img.src = src;
      img.alt = alt || 'figure';
      D.el.light.appendChild(img);
      D.el.light.hidden = false;
      D.el.light.classList.add('on');
    }
    function closeLight() {
      D.light = null;
      if (!D.mounted || !D.el.light) return;
      D.el.light.classList.remove('on');
      D.el.light.hidden = true;
      D.el.light.innerHTML = '';
    }

    // A restored council message is not this companion's to rewrite: its ts is
    // an address into a session file, and /tick would have nothing to edit. It
    // is offered no ✎ and no ✕ for the same reason, so its checkboxes are
    // locked here rather than left to fail at the server.
    function lockRestored(scope) {
      if (!scope) return;
      scope.querySelectorAll('.reply[data-restored] .md-tick').forEach(b => {
        b.disabled = true;
        b.title = READONLY_TIP;
      });
    }

    async function doTick(box) {
      const li = box.closest('li');
      const reply = box.closest('.reply');
      const card = box.closest('.card[data-thread]');
      // A box in the TASKS CARD is a box in the message the card is showing:
      // the address travels on the card rather than on a rendered reply, and
      // everything after this point is identical — the same POST, the same
      // optimistic flip, the same authoritative body coming back. That is the
      // whole reason the card holds no state of its own.
      const sec = box.closest('.tasks[data-taskfor]');
      const target = sec ? sec.getAttribute('data-taskfor') : (card && card.getAttribute('data-thread'));
      const ts = sec ? sec.getAttribute('data-taskts') : (reply && reply.getAttribute('data-ts'));
      const author = sec ? sec.getAttribute('data-taskauthor')
        : (reply && reply.getAttribute('data-author'));
      const readonly = sec ? sec.classList.contains('ro') : !!(reply && reply.hasAttribute('data-restored'));
      const index = Number(box.getAttribute('data-tick'));
      const checked = !!box.checked;
      if (!target || !ts || !isFinite(index) || readonly) { box.checked = !checked; return; }
      if (li) li.classList.toggle('done', checked);
      box.disabled = true;
      let r;
      try { r = await cb('onTick')(target, ts, index, checked); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || r.ok === false) {
        box.checked = !checked;
        box.disabled = false;
        if (li) li.classList.toggle('done', !checked);
        note(target, (r && r.error) || 'could not save that tick', true);   // renders
        return;
      }
      // reconcile from the authoritative body, then let render() rebuild the
      // list from it — the checkbox states come back out of the text, in the
      // transcript and in the tasks card alike
      const msg = findMsg(target, ts, author);
      if (msg && typeof r.text === 'string' && r.text) msg.text = r.text;
      box.disabled = false;
      render();
    }

    // Stopping a turn is the owner's privilege on a shared companion (403), and
    // a stop that did not stop anything must say so — in the thread whose chip
    // was clicked, or in the footbar's case the page chat.
    async function doInterrupt(btn) {
      const card = btn && btn.closest && btn.closest('.card[data-thread]');
      const target = card ? card.getAttribute('data-thread') : null;
      note(target, 'stopping…', false, true);   // a wait, not a message: the turn's end takes it away
      let r;
      try { r = await cb('onInterrupt')(); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (r && r.ok === false) note(target, r.error || 'could not stop that turn', true);
    }

    async function doDelete(target, ts) {
      const r = await cb('onDelete')(target, ts || null);
      if (r && r.ok === false) note(target, r.error || 'delete failed', true);
      else render();
    }

    // Resolve / reopen, OPTIMISTICALLY. The record is the authority and the
    // round trip settles it, but the card moves on the click: a reader sweeping
    // a long list must never be waiting on a server to know whether their last
    // click landed, and a list that shrinks a beat late reads as a list that
    // ignored you.
    //
    // The instant digest is written locally too, by the same rule the companion
    // applies (store.threadDigest), so the card that appears under "Resolved"
    // is never blank for the frame before the answer comes back.
    async function doResolve(target, on) {
      const t = threadById(target);
      if (!t || D.resolving[target]) return;
      const was = !!t.resolved;
      const wasSummary = t.summary;
      if (on) {
        t.resolved = true;
        if (!t.summary) t.summary = localDigest(t);
        // opening the archive on the first resolve is the one time the reader
        // is shown where their thread went; after that it stays as they left it
        D.resolvedCards[target] = false;
      } else {
        // reopening is the undo: the card leaves the archive and rejoins the
        // list it came from, in its page order. `summary` is left where it is —
        // it is still a true account of what the thread said last time, and
        // keeping it is what lets a late summary job land harmlessly.
        delete t.resolved;
      }
      D.resolving[target] = true;
      render();
      let r;
      try { r = await cb('onResolve')(target, !!on); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      delete D.resolving[target];
      if (!r || r.ok === false) {
        // put it back exactly as it was — including a summary we invented
        const now = threadById(target);
        if (now) {
          if (was) now.resolved = true; else delete now.resolved;
          if (wasSummary == null) delete now.summary; else now.summary = wasSummary;
        }
        note(target, (r && r.error) || (on ? 'could not resolve that thread' : 'could not reopen that thread'), true);
        return;   // note() renders
      }
      // the companion's own copy of the thread wins over our guess at it
      const fresh = r.thread;
      const mine = threadById(target);
      if (fresh && mine) Object.assign(mine, fresh);
      render();
    }

    // "not done": the reader disagreeing with a bot's claim that a thread is
    // handled. It rejoins the open list — in page order, where it was — and
    // becomes a candidate for the next send-review again, which is the whole
    // reason the button exists rather than leaving the reader to reply "no"
    // and hope. Optimistic on the same reasoning as resolve, and one click,
    // with reply-or-resolve as the two ways back out of it.
    async function doNotDone(target) {
      const t = threadById(target);
      if (!t || D.addressing[target]) return;
      const was = t.addressed, wasBy = t.addressed_by, wasAt = t.addressed_at;
      delete t.addressed; delete t.addressed_by; delete t.addressed_at;
      D.addressing[target] = true;
      render();
      let r;
      try { r = await cb('onNotDone')(target); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      delete D.addressing[target];
      if (!r || r.ok === false) {
        const now = threadById(target);
        if (now && was) { now.addressed = was; if (wasBy) now.addressed_by = wasBy; if (wasAt) now.addressed_at = wasAt; }
        note(target, (r && r.error) || 'could not put that thread back', true);
        return;   // note() renders
      }
      const fresh = r.thread, mine = threadById(target);
      if (fresh && mine) Object.assign(mine, fresh);
      render();
    }

    async function doSummarize(target) {
      let r;
      try { r = await cb('onSummarize')(target); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (r && r.ok === false) { note(target, r.error || 'could not ask for a summary', true); return; }
      const t = threadById(target);
      // back to the provisional look until the job drains — otherwise nothing
      // at all happens on screen and the click looks lost
      if (t) delete t.summary_by;
      render();
    }

    const threadById = id => ((D.page && D.page.threads) || []).find(t => t.id === id) || null;

    // The drawer's copy of store.threadDigest, for the optimistic card only.
    // Deliberately the same rule, deliberately not shared code: this runs in a
    // content script that cannot import the companion's modules, and the
    // authoritative digest is always the one that comes back in `thread`.
    function localDigest(t) {
      const said = ((t && t.msgs) || []).filter(m => m && m.kind !== 'tools');
      const tally = said.map(m => {
        const all = String(m.text || '').match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/gm) || [];
        return all.length ? { done: all.filter(x => /\[[xX]\]$/.test(x)).length, total: all.length } : null;
      }).filter(Boolean).pop();
      const lastBot = [...said].reverse().find(m => isBot(m.author));
      const src = (lastBot || said[said.length - 1] || {}).text;
      const s = String(src || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
      const m = /^(.{20,220}?[.!?])(\s|$)/.exec(s);
      const body = (m ? m[1] : s.slice(0, 220)).trim();
      return [tally ? `Checklist: ${tally.done}/${tally.total} done.` : '', body].filter(Boolean).join(' ') || 'Resolved.';
    }

    // One export feedback path, whichever crystal was clicked: the header's
    // (this page) or a row's in the pages list (that page).
    async function exportFlow(run) {
      D.foot = 'exporting…'; D.footErr = false; paintFoot();
      const r = await run();
      if (r && r.ok === false) { D.foot = r.error || 'export failed'; D.footErr = true; }
      else D.foot = 'exported → ' + ((r && r.path) || 'Obsidian');
      paintFoot();
      setTimeout(() => { if (String(D.foot).startsWith('exported')) { D.foot = ''; paintFoot(); } }, 6000);
    }
    const doExport = mode => exportFlow(() => cb('onExport')(mode));
    // A row in the pages list exports SILENTLY, in whichever mode was last
    // chosen: those rows are one-click controls in a list, and a popover per
    // row would turn tidying up into a dialogue. The mode is the same setting
    // the chooser writes, and the row's tooltip says which one it will use.
    const doExportPage = url => exportFlow(() => cb('onExportPage')(url, D.exportMode));

    // ---- which export ------------------------------------------------------
    // Two modes, one click each: the whole conversation, or the reading
    // without it. The last choice is remembered (content.js persists it) and
    // preselected, so the second export of a session is one click on the same
    // row it was last time.
    const EXPORT_PICK = [
      ['comments', 'Comments only', 'highlights and your own notes'],
      ['all', 'Everything', 'including the bot conversation'],
    ];
    function paintExportPick() {
      if (!D.mounted || !D.el.exportpick) return;
      D.el.exportpick.innerHTML =
        `<div class="pop-head">Export to Obsidian</div>` +
        EXPORT_PICK.map(([mode, name, why]) =>
          `<button class="xrow${mode === D.exportMode ? ' on' : ''}" type="button" role="menuitem"
             data-act="export-run" data-mode="${esc(mode)}"${mode === D.exportMode ? ' aria-current="true"' : ''}>
             <span class="xname">${esc(name)}</span><span class="xwhy">${esc(why)}</span></button>`).join('');
      D.el.exportpick.hidden = false;
    }
    function openExportPick() {
      if (!D.mounted) return;
      closeModels();
      D.exportOpen = true;
      paintExportPick();
      if (typeof document !== 'undefined') document.addEventListener('mousedown', onExportDown, true);
    }
    function closeExportPick() {
      D.exportOpen = false;
      if (D.mounted && D.el.exportpick) { D.el.exportpick.hidden = true; D.el.exportpick.innerHTML = ''; }
      if (typeof document !== 'undefined') document.removeEventListener('mousedown', onExportDown, true);
    }
    const onExportDown = e => { if (!D.host || !D.host.contains(e.target)) closeExportPick(); };
    // Choosing is also remembering: the next export, here or from a row in the
    // pages list, uses this until it is changed again.
    function pickExport(mode) {
      D.exportMode = mode === 'comments' ? 'comments' : 'all';
      closeExportPick();
      rememberExportMode();
      if (D.view === 'pages') renderPages();   // the rows' tooltips name the mode
      doExport(D.exportMode);
    }

    // Deleting a page from the library takes its bot session with it. The
    // companion may refuse (a turn is running for that page); that refusal is
    // ordinary traffic and lands under the row it is about, never in a dialog.
    //
    // Deleting the page you are STANDING ON is the case worth being careful
    // with: content.js unpaints its highlights and hands back an empty record,
    // and everything this drawer was holding about the old conversation —
    // streams, status notes, an open confirm — has to go with it, or the next
    // render draws the ghost of a page that no longer exists.
    async function doDeletePage(url) {
      if (!url) return;
      D.pages.confirm = null;
      D.pages.rowErr = null;
      renderPages();
      let r;
      try { r = await cb('onDeletePage')(url); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || r.ok === false) {
        D.pages.rowErr = { url, text: (r && r.error) || 'could not delete that page' };
        renderPages();
        return;
      }
      if (D.pages.list) D.pages.list = D.pages.list.filter(p => !sameUrl(p.url, url));
      if (r.current) {
        D.streams = {}; D.running = {}; D.turnAgents = {}; D.liveAgents = {};
        D.speaker = {}; D.notes = {}; D.toolsOpen = {}; D.outbox = {}; D.expanded = {};
        D.turnSeq = {};   // a send still in flight for the dead page can no longer claim a queue slot
        D.confirm = null; D.focused = null; D.pending = null;
        D.foot = ''; D.footErr = false;
      }
      renderPages();
      render();
    }

    // A row click on the page you are already on has nothing to open: it is
    // just the way back to this page's comments.
    async function openPageRow(url) {
      if (!url) return;
      if (isCurrentUrl(url)) {
        D.tab = CAPS.highlights ? 'comments' : 'chat';
        showThreads();
        rememberTab();
        return;
      }
      const r = await cb('onOpenPage')(url);
      if (r && r.ok === false) { D.foot = r.error || 'could not open that page'; D.footErr = true; paintFoot(); }
    }

    // ---- filtering, renaming, tagging -------------------------------------
    // All three are edits to the LIST, not to any conversation, so they repaint
    // the pages pane and nothing else.
    function setFilter(kind, tag) {
      D.pages.kind = KIND_NAME[kind] ? kind : '';
      D.pages.tag = String(tag || '').slice(0, TAG_MAX);
      closeRowEditors(true);
      rememberFilter();
      renderPages();
    }
    const setKindFilter = kind => setFilter(kind === D.pages.kind ? '' : kind, D.pages.tag);
    // clicking the tag you are already filtered to is how you stop filtering by
    // it — the chip is a toggle, in the rail and in a row alike
    const toggleTagFilter = tag =>
      setFilter(D.pages.kind, tag.toLowerCase() === D.pages.tag.toLowerCase() ? '' : tag);

    function openRowEditor(which, url) {
      if (!D.owner || !url) return;
      D.pages.renaming = which === 'renaming' ? url : null;
      D.pages.tagging = which === 'tagging' ? url : null;
      D.pages.pick = 0;
      D.pages.rowErr = null;
      renderPages();
    }
    function closeRowEditors(quiet) {
      const had = D.pages.renaming || D.pages.tagging;
      D.pages.renaming = null;
      D.pages.tagging = null;
      D.pages.pick = 0;
      if (had && !quiet) renderPages();
    }
    const rowInput = () => D.el.pages && D.el.pages.querySelector('.pedit .pinput');
    // the list is refreshed from the companion on every `page` event, so a row
    // that was just renamed is corrected here immediately rather than waiting
    const patchRow = (url, patch) => {
      for (const p of D.pages.list || []) if (sameUrl(p.url, url)) Object.assign(p, patch);
    };

    async function saveRename(url) {
      const el = rowInput();
      if (!el || !url) return;
      const title = el.value.trim();
      closeRowEditors(true);
      const r = await cb('onRenamePage')(url, title);
      if (!r || r.ok === false) {
        D.pages.rowErr = { url, text: (r && r.error) || 'could not rename that page' };
      // the companion answers with the name the row is now shown under —
      // which, when the reader emptied the box, is the page's own name and not
      // the empty string they typed
      } else if (r.title) patchRow(url, { title: r.title });
      renderPages();
      loadPages(true);
    }

    async function saveTags(url) {
      const el = rowInput();
      if (!el || !url) return;
      const tags = el.value.split(',').map(s => s.trim()).filter(Boolean).slice(0, TAGS_MAX);
      closeRowEditors(true);
      const r = await cb('onTagPage')(url, tags);
      if (!r || r.ok === false) {
        D.pages.rowErr = { url, text: (r && r.error) || 'could not tag that page' };
      } else patchRow(url, { tags: (r && r.tags) || tags });
      renderPages();
      loadPages(true);
    }

    // ---- completing a tag --------------------------------------------------
    // The token under the caret is what is completed, against every tag already
    // in use anywhere in the archive — the same shape as the @-menu, over a
    // different vocabulary. Nothing is invented: a tag you have never used is
    // simply typed out, and the menu closes when nothing matches.
    function tagToken(el) {
      const value = String(el.value || '');
      const caret = typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
      const start = value.lastIndexOf(',', caret - 1) + 1;
      let end = value.indexOf(',', caret);
      if (end < 0) end = value.length;
      return { start, end, word: value.slice(start, end).trim() };
    }
    function tagMatches(el) {
      const { word } = tagToken(el);
      const chosen = new Set(el.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
      const w = word.toLowerCase();
      return knownTags(D.pages.list)
        .filter(t => !chosen.has(t.toLowerCase()) || t.toLowerCase() === w)
        .filter(t => !w || t.toLowerCase().startsWith(w))
        .slice(0, 8);
    }
    function paintTagMenu(el) {
      const menu = el && el.parentNode && el.parentNode.querySelector('.tagmenu');
      if (!menu) return;
      const items = tagMatches(el);
      if (!items.length) { menu.hidden = true; menu.innerHTML = ''; return; }
      if (D.pages.pick >= items.length) D.pages.pick = 0;
      // the options are the tags themselves, so they wear their colors —
      // chips, not menu rows: with an empty token this IS the pick-from-
      // existing palette, and it should look like what clicking it applies
      menu.innerHTML = items.map((t, i) =>
        `<button class="tagopt${i === D.pages.pick ? ' on' : ''}" type="button"
           data-act="tag-pick" data-tag="${esc(t)}" style="--th:${tagHue(t)}">${esc(t)}</button>`).join('');
      menu.hidden = false;
    }
    function completeTag(tag) {
      const el = rowInput();
      if (!el || !tag) return;
      const { start, end } = tagToken(el);
      const before = el.value.slice(0, start).replace(/\s*$/, '');
      const rest = el.value.slice(end).replace(/^\s*,?\s*/, '');
      el.value = (before ? before + (before.endsWith(',') ? ' ' : ', ') : '') + tag + (rest ? ', ' + rest : ', ');
      const caret = el.value.length - (rest ? rest.length + 2 : 0);
      el.focus();
      try { el.setSelectionRange(caret, caret); } catch { /* ignore */ }
      D.pages.pick = 0;
      paintTagMenu(el);
    }

    function showPages() {
      mount();
      D.view = 'pages';
      paintView();
      if (!D.pages.list) renderPages();
      loadPages(!!D.pages.list);
      loadLibrary();
      return D;
    }

    // The library record, fetched like any page's. `{page:null}` is not an
    // error — it is a library nobody has said anything into yet, and the
    // companion creates it on the first message rather than before.
    async function loadLibrary() {
      if (D.library.loading) return;
      D.library.loading = true;
      const r = await cb('onLibrary')();
      D.library.loading = false;
      if (r && r.ok !== false) {
        D.library.page = (r.page && r.page.url) ? r.page : null;
        D.library.err = '';
      } else {
        D.library.err = (r && r.error) || 'could not reach the companion';
        D.library.note = D.library.err;
      }
      if (D.view === 'pages') renderLibrary();
    }

    async function doLibraryExport() {
      D.library.note = 'writing the note…';
      D.library.err = false;
      renderLibrary();
      const r = await cb('onExportPage')(LIBRARY_URL, 'all');
      D.library.err = !(r && r.ok !== false);
      D.library.note = D.library.err
        ? ((r && r.error) || 'export failed')
        : 'exported → ' + ((r && r.path) || 'your vault');
      renderLibrary();
    }

    // Clearing the library IS deleting its page — record, session and all — so
    // it goes through the same confirm and the same endpoint every page row
    // uses. What comes back is an empty library, not a missing one.
    async function doLibraryClear() {
      D.library.confirm = false;
      D.library.note = 'clearing…';
      D.library.err = false;
      renderLibrary();
      const r = await cb('onDeletePage')(LIBRARY_URL);
      if (!r || r.ok === false) {
        D.library.err = true;
        D.library.note = (r && r.error) || 'could not clear the library';
        renderLibrary();
        return;
      }
      D.library.page = null;
      D.library.note = '';
      D.library.err = false;
      delete D.outbox[LIBRARY_TARGET];
      delete D.notes[LIBRARY_TARGET];
      delete D.running[LIBRARY_TARGET];
      delete D.expanded[LIBRARY_TARGET];
      renderLibrary();
    }
    function showThreads() { mount(); D.view = 'threads'; paintTabs(); return D; }
    // live: `page` events land here while the list is up, and nowhere else
    function refreshPages() { if (D.view === 'pages') loadPages(true); return D; }

    const cssq = s => String(s).replace(/["\\]/g, '\\$&');

    // ---- public surface -------------------------------------------------
    function open(tab) {
      mount();
      // a caller that asks for Comments on a page that cannot have any (the
      // boot path asks for the remembered tab, which may be stale) gets chat
      if (tab === 'comments' && !CAPS.highlights) tab = 'chat';
      // being asked for a specific tab (a highlight click, a new comment) is
      // always about THIS page — leave the pages library if it is up
      if (tab) { D.tab = tab; D.view = 'threads'; paintTabs(); rememberTab(); }
      D.opened = true;
      // one frame so the CSS transition actually runs on first open
      requestAnimationFrame(() => { D.el.panel.classList.add('open'); pushPage(true); });
      pushPage(true);
      return D;
    }
    function close() {
      if (!D.mounted) return D;
      D.opened = false;
      D.el.panel.classList.remove('open');
      pushPage(false);
      closeModels();
      if (D.pending) cancelNew();
      focus(null);
      cb('onClose')();
      return D;
    }
    function toggle() { return D.opened ? close() : open(); }

    function cancelNew() {
      D.pending = null;
      if (D.focused === '__new__') D.focused = null;   // spotlight lifts with the card
      delete D.drafts['__new__'];
      delete D.notes['__new__'];
      // a comment that failed to save goes with the card it was written on —
      // there is no anchor left to retry it against
      delete D.outbox['__new__'];
      cb('onCancelNew')();
      render();
    }

    function beginNew(anchor) {
      mount();
      if (!CAPS.highlights) return D;   // nothing can be anchored here
      if (standDown()) return D;        // …and no new threads on a review page
      D.pending = anchor;
      // the composer arrives already under the spotlight: the box being
      // filled in is "the" card, everything else recedes until send or cancel
      D.focused = '__new__';
      D.tab = 'comments';
      paintTabs();
      open('comments');
      render();
      const ta = D.shadow.querySelector('.card.pending textarea');
      if (ta) { ta.focus(); D.el.comments.scrollTop = 0; }
      return D;
    }

    // A refetch is the other way a wait can end. The events that would have
    // taken "queued…" down (turn-start, reply, turn-end) can be lost outright —
    // an extension service worker dies and the tab is never told another thing
    // until content.js resyncs — so the RECORD gets the same authority they
    // have: if the bots have answered since the wait was written, the wait is
    // over, whatever we did or did not hear.
    function botsIn(target) {
      return realMsgs(target).filter(m => m && isBot(m.author)).length;
    }
    function clearAnsweredWaits() {
      let changed = false;
      for (const key of Object.keys(D.notes)) {
        const n = D.notes[key];
        if (!n || !n.transient || n.bots == null) continue;
        if (botsIn(key) > n.bots) { delete D.notes[key]; changed = true; }
      }
      return changed;
    }

    function setPage(page) {
      D.page = page || null;
      clearAnsweredWaits();
      if (D.mounted) {
        const title = (page && page.title) || document.title || '—';
        D.el.title.textContent = title;
        D.el.title.title = title;
        D.el.site.textContent = (page && page.site) || opts.hostname || '';
        paintProject();
      }
      render();
      return D;
    }

    // ---- the council project behind this page ---------------------------
    // The header's second line, and the only thing about a project artifact
    // that is visible before the reader touches anything: this file is not
    // loose on the disk, it belongs to a project, and the drawer says which.
    function paintProject() {
      if (!D.mounted || !D.el.proj) return;
      const p = D.project;
      D.el.proj.hidden = !p;
      if (!p) return;
      const name = p.project_title || p.project_id || '';
      D.el.proj.textContent = 'part of project ' + name;
      D.el.proj.title = p.path || p.rel || '';
      D.el.proj.classList.toggle('unconfirmed', !p.confirmed);
    }

    // content.js learned about the project after the drawer was made, or
    // another tab answered the confirmation and the broadcast landed here.
    function setProject(project) {
      D.project = project || null;
      paintProject();
      render();
      return D;
    }

    function setOrphans(map) { D.orphans = map || {}; render(); return D; }
    // content.js asked /round on wake (or after a socket came back) and this
    // is the answer — the same payload the broadcast carries, so a tab that
    // opened mid-round paints the strip right on its FIRST paint instead of
    // staying blank until the next turn boundary.
    function setRound(round) { D.round = round || null; paintRound(); return D; }
    // The export mode this browser used last (content.js reads it out of
    // extension storage on wake). Only preselects a row and labels the pages
    // list's own crystals — nothing exports because of it.
    function setExportMode(mode) {
      const m = mode === 'comments' ? 'comments' : 'all';
      if (m === D.exportMode) return D;
      D.exportMode = m;
      if (D.exportOpen) paintExportPick();
      if (D.view === 'pages') renderPages();
      return D;
    }
    // Whether this browser is the OWNER of this companion — the companion's own
    // answer (GET /whoami), asked once by content.js. It gates the archive's
    // editing affordances: renaming a page and tagging it are the owner's, and
    // a guest never sees either control (nor could they use it — the routes are
    // owner-only). False until the answer arrives, which is the safe direction.
    function setOwner(on) {
      const v = !!on;
      if (v === D.owner) return D;
      D.owner = v;
      if (!v) closeRowEditors(true);
      if (D.view === 'pages') renderPages();
      return D;
    }
    // Who this browser is on this companion. Arrives asynchronously (the
    // background asks storage, and /health on a local companion), so it can
    // land after the first render — hence a setter and a re-render rather than
    // a constructor option. It decides which messages offer the ✎ and what
    // colour the composer's own card is.
    function setAuthor(name) {
      const n = String(name == null ? '' : name).trim();
      if (!n || n === D.author) return D;
      D.author = n;
      render();
      return D;
    }
    // '' clears it — a later turn that DID read the page must not leave the
    // warning standing behind it
    function setWarning(text) {
      const t = String(text == null ? '' : text);
      if (D.warn === t) return D;
      D.warn = t;
      render();
      return D;
    }
    function setConn(on) {
      const changed = D.connected !== !!on || !D.connKnown;
      D.connected = !!on; D.connKnown = true;
      paintConn();
      if (changed) render();   // the offline notice lives in the panes
      return D;
    }
    function setTheme(t) { if (D.host) { if (t) D.host.setAttribute('data-theme', t); else D.host.removeAttribute('data-theme'); } return D; }

    function showSel(x, y) {
      mount();
      if (!CAPS.highlights) return D;   // no pill where nothing can be marked
      if (standDown()) return D;        // …nor beside the page's own pill
      const b = D.el.selbtn;
      b.style.left = Math.max(8, Math.min(x, window.innerWidth - 110)) + 'px';
      b.style.top = Math.max(8, Math.min(y, window.innerHeight - 40)) + 'px';
      b.classList.add('on');
      return D;
    }
    function hideSel() { if (D.mounted) D.el.selbtn.classList.remove('on'); return D; }

    // ---- companion events -----------------------------------------------
    // One event must never be able to take the drawer down with it. Everything
    // live — the working chip, the streaming text, the answer itself — arrives
    // through here, so an exception thrown on one event used to end the
    // conversation: the listener died, every later event went unhandled, and
    // the reader was left looking at a stale pane with no error and no clue.
    // Whatever the malformed thing was, it is logged and the next event is
    // handled normally; content.js turns the failure into a refetch, so the
    // record still wins.
    function onEvent(ev) {
      try { return applyEvent(ev); }
      catch (e) {
        // nothing of the event is touched again in here: reading it is what
        // threw in the first place
        console.warn('[botference] event ignored:', (e && e.message) || e);
        D.badEvents = (D.badEvents || 0) + 1;
        return undefined;
      }
    }
    function applyEvent(ev) {
      if (!ev) return;
      if (ev.type === 'bridge') { D.bridge = ev.error ? (ev.state + ' — ' + ev.error) : ev.state; paintFoot(); return; }
      // Model switches, context gauges and relays are broadcast to every tab;
      // this is the push channel that keeps an open popover honest. It fires on
      // meaningful change only (pct/model/relay/auto_relay — not token creep),
      // so it is cheap to render straight into the live DOM.
      if (ev.type === 'models') {
        if (ev.current) D.models.current = Object.assign({}, D.models.current, ev.current);
        if (ev.options !== undefined) D.models.options = ev.options;
        if (ev.status !== undefined) D.models.status = ev.status;
        // effort travels with the models broadcast (same null-until-the-bridge
        // -speaks rule); verbosity is a plain string the companion owns
        if (ev.effort !== undefined) D.models.effort = ev.effort;
        if (ev.verbosity) D.models.verbosity = ev.verbosity;
        if (ev.bridge) D.models.bridge = ev.bridge;
        // which auth each agent bills, and whether there is a key to bill —
        // the companion's own setting, and the only thing that can settle a
        // billing switch waiting on a key
        ingestKeys(ev.keys);
        if (D.modelsOpen) syncModels();
        return;
      }
      // the round the reader started, as the companion sees it (server.mjs
      // roundTurn). Straight into the strip: it is state, not history, and
      // nothing here recomputes any of it.
      if (ev.type === 'round') { D.round = ev; paintRound(); return; }
      if (ev.type !== 'chat') return;
      // A library event is a page chat on the reserved url; give it its own
      // target here and everything downstream — chips, streams, folding,
      // outbox reconciliation — works on it without knowing what it is.
      const target = isLibraryUrl(ev.url) ? LIBRARY_TARGET : (ev.target || PAGE_TARGET);
      D.heard[target] = Date.now();   // this turn is demonstrably still being reported
      switch (ev.kind) {
        case 'turn-start':
          D.running[target] = true;
          bumpTurn(target);   // closes the "queued…" window for any send still in flight
          // an older companion sends no `agents`; the chip then stays generic
          D.turnAgents[target] = Array.isArray(ev.agents) ? ev.agents.filter(Boolean) : [];
          D.liveAgents[target] = [];
          delete D.speaker[target];
          delete D.notes[target];
          render();
          break;
        case 'stream': {
          // text is arriving, so whatever we were waiting for has begun — even
          // if the turn-start that should have said so never reached us
          if (clearWaiting(target)) render();
          const key = ev.stream_id || (ev.model + ':' + target);
          const s = D.streams[key] || (D.streams[key] = { who: ev.model || 'claude', target, text: '' });
          s.text += (ev.text || '');
          // the floor has moved: redraw so the spinning ring follows it
          if (ev.model) {
            const live = D.liveAgents[target] || (D.liveAgents[target] = []);
            if (live.indexOf(ev.model) === -1) live.push(ev.model);
            if (D.speaker[target] !== ev.model) { D.speaker[target] = ev.model; render(); }
          }
          // fast path: patch the live <pre> instead of rebuilding the pane
          const pre = D.mounted && D.shadow.querySelector('.reply[data-stream="' + cssq(key) + '"] .stream-text');
          if (pre) {
            pre.textContent = s.text;
            const box = pre.closest('.pane');
            if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
          } else render();
          break;
        }
        case 'stream-done':
          // keep the text on screen; the authoritative `reply` clears it
          break;
        case 'reply':
          // a tool summary is not the authoritative answer — it must not tear
          // down the live stream block the real reply is still filling
          if (!(ev.msg && ev.msg.kind === 'tools')) {
            for (const k of Object.keys(D.streams)) {
              if (D.streams[k].target === target && D.streams[k].who === (ev.msg && ev.msg.author)) delete D.streams[k];
            }
          }
          appendMsg(target, ev.msg);
          clearWaiting(target);   // the answer is here; nothing is waiting on anything
          render();
          break;
        case 'turn-end':
          delete D.running[target];
          bumpTurn(target);
          clearWaiting(target);   // never leave "queued…" (or "stopping…") behind a finished turn
          delete D.turnAgents[target];
          delete D.liveAgents[target];
          delete D.speaker[target];
          for (const k of Object.keys(D.streams)) if (D.streams[k].target === target) delete D.streams[k];
          render();
          break;
        case 'error':
          // A turn that is still running keeps its chip: the companion reports
          // a refused file-write (and anything else it survives) as an error
          // event mid-turn and then ends the turn normally. Only an error that
          // arrives with no turn in flight IS the end of one.
          if (!D.running[target]) {
            delete D.turnAgents[target];
            delete D.liveAgents[target];
            delete D.speaker[target];
            bumpTurn(target);   // no turn in flight: this error IS the end of one
          }
          // overwrites any "queued…" outright — the reason replaces the wait
          note(target, ev.error || 'the bots hit an error', true);
          break;
      }
    }

    // A turn ENDS with an event, so a turn that is still "running" long after
    // the last thing anyone heard about it is a turn whose end never arrived —
    // the worker died mid-answer, and the chip would otherwise spin for ever.
    // The record cannot say (it holds messages, not turns), so silence is the
    // only evidence there is; content.js supplies the patience.
    function quietTurns(ms) {
      const now = Date.now();
      return Object.keys(D.running).filter(t => now - (D.heard[t] || 0) >= (ms || 0));
    }
    // Exactly what a `turn-end` does, for a turn-end that never came.
    function endTurn(target) {
      if (!D.running[target]) return false;
      delete D.running[target];
      bumpTurn(target);
      clearWaiting(target);
      delete D.turnAgents[target];
      delete D.liveAgents[target];
      delete D.speaker[target];
      for (const k of Object.keys(D.streams)) if (D.streams[k].target === target) delete D.streams[k];
      render();
      return true;
    }

    // Optimistic local append so the thread moves the instant the event lands;
    // content.js still refetches /page on `page` events for the truth.
    function appendMsg(target, msg) {
      if (!msg) return;
      const list = msgListFor(target, true);
      if (!list) return;
      if (list.some(m => m.ts === msg.ts && m.author === msg.author)) return;
      list.push(msg);
    }

    Object.assign(D, {
      mount, open, close, toggle, render, setPage, setOrphans, setConn, setTheme, setWarning, setAuthor,
      setExportMode, setOwner, setProject, setRound,
      // {hosts, pageOwns} — the page's own review UI, and which margin the
      // reader has given this page to. Re-rendered, never remounted: the
      // switch flips in place.
      // {on, threads} — the reader's switch for the on-page track changes and
      // the threads it applies to. Re-rendered in place, like setReviewHost.
      setTrackChanges: tc => {
        const before = TC.on + '|' + TC.threads.join(',');
        Object.assign(TC, tc || {});
        TC.threads = (TC.threads || []).slice();
        if (before !== TC.on + '|' + TC.threads.join(',')) render();
        return D;
      },
      trackChangesOn: () => !!TC.on,
      setReviewHost: rh => {
        Object.assign(RH, rh || {});
        if (standDown() && D.pending) cancelNew();   // takes render() with it
        else render();
        return D;
      },
      // observable for the harness: is Discuss's margin off on this page?
      standingDown: () => standDown(),
      beginNew, cancelNew, showSel, hideSel, onEvent, focus, scrollToThread, note,
      openModels, closeModels, setWidth: w => applyWidth(w),
      showPages, showThreads, refreshPages, quietTurns, endTurn,
      // Whether a ```python block may be run from here: the companion's answer
      // to GET /run (owner, and not switched off). False until it has said so,
      // and false for ever for a guest — the button is not drawn at all.
      // (a METHOD named canRun would clobber the flag itself — see `opened`)
      setCanRun: on => { D.canRun = !!on; render(); return D; },
      // One Esc, one layer. content.js's document-level handler asks this
      // first, so a lightbox closes instead of the whole drawer.
      escape: () => { if (!D.light) return false; closeLight(); return true; },
      // the library's record, handed in the way setPage hands the page's
      setLibrary: page => { D.library.page = page || null; if (D.view === 'pages') renderLibrary(); },
      refreshLibrary: () => { if (D.view === 'pages') loadLibrary(); },
      libraryTarget: () => LIBRARY_TARGET,
      isOpen: () => D.opened,
      isPagesOpen: () => D.view === 'pages',
      // Is anything on this page waiting on the bots? content.js polls the
      // record while this is true — a wait is exactly the state a lost event
      // strands, and the only one worth spending requests on.
      // how many events were thrown out because handling them threw — 0 in a
      // healthy session, and the harness asserts on it
      eventErrors: () => D.badEvents || 0,
      isWaiting: () => Object.keys(D.notes).some(k => D.notes[k] && D.notes[k].transient)
        || Object.keys(D.running).length > 0
        || Object.keys(D.outbox).some(k => (D.outbox[k] || []).some(e => e.state === 'sending')),
    });
    return D;
  }

  const api = {
    create, authorColor, isBot, HINT, PAGE_TARGET,
    renderMarkdown, clampWidth, W_DEFAULT, W_MIN, W_MAX,
    // pure, for the node tests — no DOM, no KaTeX
    scanMath, protectMath,                                  // test/math.test.mjs
    msgUnits, collapsePlan, moreLabel, foldable,             // test/collapse.test.mjs
    COLLAPSE_AT, KEEP_HEAD, KEEP_TAIL, KEEP_TAIL_SHUT, FOLD_OPEN, FOLD_SHUT,
    mentionToken, mentionCandidates,                        // test/mentions.test.mjs
    tagHue,                                                 // test/tags.test.mjs
    splitEnvelopes, agentOf,                                // test/envelope.test.mjs
    splitMore, stripMore, MORE_MARK,                        // test/more.test.mjs
  };
  root.BFPDrawer = api;
  // classic script everywhere it matters; the require() is only so the math
  // tokenizer can be unit-tested in node, as adapters.js already is
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
