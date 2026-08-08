// drawer.js — the right-side annotation drawer, entirely inside a shadow root.
//
// Nothing in here talks to the network or the DOM of the page; content.js owns
// both and hands this file (a) page records to render and (b) callbacks to call.
// Everything visual lives in drawer.css, linked into the shadow root — so page
// CSS cannot reach in and drawer CSS cannot leak out.
//
// Exposed as window.BFPDrawer (classic script, isolated content-script world).
//
//   const d = BFPDrawer.create({ hostname, cssUrl, theme, capabilities, on… });
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
// Callbacks (all optional, all may return a Promise):
// Sending is OPTIMISTIC: the message appears in its thread and the composer
// empties before onSave/onReply is even called (they are slow — they re-read
// the page and may attach a document). Both may answer:
//   {ok:true, queued, position}   normal; the bots were summoned or not
//   {ok:true, reason:'…'}         saved, but the bots will NOT run for this
//                                 sender (a guest, or --no-agents) — shown at
//                                 the composer, nothing rolled back
//   {ok:true, deduped:true}       the companion already had this message; the
//                                 caller must have reconciled it idempotently
//   {ok:false, error:'…'}         the pending message stays on screen with a
//                                 retry and a discard
//
//   onSave({quote,prefix,suffix,text})  new anchored thread committed
//   onCancelNew()                       the pending new-thread card dismissed
//   onReply(threadId, text)             threadId '__page__' = page chat
//   onEdit(threadId, ts, text)
//   onDelete(threadId, ts|null)         null ts = delete the whole thread
//   onTick(threadId, ts, index, checked) a checkbox in a bot's markdown
//                                        checklist was clicked; index is its
//                                        0-based ordinal in that message
//                                        → {ok, text}   (POST /tick) — `text`
//                                        is the message's authoritative new
//                                        body and replaces the optimistic tick
//   onExport()                          → {ok, path} to show in the footbar
//   onPages()                           → {ok, index:{pageKey:{url,title,threads,
//                                         has_session,updated_at}}}   (GET /index)
//   onOpenPage(url)                     → {ok}  open/focus a tab at that page
//   onExportPage(url)                   → {ok, path}          (POST /export {url})
//   onDeletePage(url)                   → {ok, session_deleted, current}
//                                         (POST /delete-page) — `current` says
//                                         the deleted page is the one we are on
//   onInterrupt()
//   onJump(threadId)                    quote clicked: scroll page to highlight
//   onFocus(threadId|null)              card focused/blurred: tint the highlight
//   onModels()                          → {ok, current, options, status, bridge,
//                                            effort, verbosity}          (GET /models)
//   onSetModel(agent, model)            → {ok, queued}                    (POST /model)
//   onSetEffort(agent, level)           → {ok, queued} | {ok:false,error} (POST /effort)
//   onSetVerbosity(level)               → {ok, queued} | {ok:false,error} (POST /verbosity)
//                                         level: 'short'|'long'
//   onRelay(agent)                      → {ok, queued} | {ok:false,error} (POST /relay)
//                                         agent: 'claude'|'codex'|'both'
//   onClose() / onReconnect() / onSelect()
(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const isBot = a => /^(claude|codex)/i.test(String(a || '').trim());
  // per-author identity, same rule as the review UI: bots get theme colors,
  // humans a deterministic muted hue from their handle
  function authorColor(name) {
    const a = String(name || '').toLowerCase().trim();
    if (a.startsWith('claude')) return 'var(--claude)';
    if (a.startsWith('codex')) return 'var(--codex)';
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
  const PAGE_TARGET = '__page__';
  const TAB_KEY = 'bfp:lastTab';
  const WIDTH_KEY = 'bfp:width';
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

  // ── markdown, for bot replies only ─────────────────────────────────────
  // Bot output is untrusted text. Every node below is built with createElement
  // and textContent — there is no HTML string anywhere on this path, so markup
  // inside a reply can never become markup on the page. Deliberately tiny:
  // fenced code, `- `/`1. ` lists, #-headings, blank-line paragraphs,
  // [text](http…), **bold**, *italic*, `code`. Anything else stays literal.
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
  // `**not bold**` inside backticks stays literal
  const INLINE = /(`+)([\s\S]*?)\1|\[([^\]\n]*)\]\(\s*([^()\s]+)\s*\)|\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*/;

  const mk = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };

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
      s = s.slice(m.index + m[0].length);
    }
    if (s) out.appendChild(document.createTextNode(s));
    return out;
  }

  const isBlockStart = l =>
    FENCE.test(l) || BULLET.test(l) || NUMBER.test(l) || HEADING.test(l) || !l.trim();

  // The tick index a click reports back to the companion: the 0-based ordinal
  // of the checkbox WITHIN ITS MESSAGE, counted in document order. Reset per
  // renderMarkdown() call, which is once per message.
  let taskSeq = 0;

  function renderMarkdown(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    taskSeq = 0;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      const fence = FENCE.exec(line);
      if (fence) {
        const close = fence[1][0] === '`' ? /^\s{0,3}```/ : /^\s{0,3}~~~/;
        const buf = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
        i++;                                     // the closing fence, if there is one
        const pre = mk('pre', 'md-code');
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
    return frag;
  }

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
  function fillMarkdown(scope) {
    scope.querySelectorAll('.ctext[data-md]').forEach(el => {
      const text = mdSlots.get(el.getAttribute('data-md'));
      if (text == null) return;
      el.textContent = '';
      el.appendChild(renderMarkdown(text));
    });
    mdSlots.clear();
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

  const PAGES_SVG =
    '<svg class="pico" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" ' +
    'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="2.3" y="1.8" width="8.2" height="10.4" rx="1.5"/>' +
    '<path d="M5.5 14.2h6a1.7 1.7 0 0 0 1.7-1.7V4.7"/></svg>';

  function create(opts) {
    opts = opts || {};
    const cb = name => (...args) => (typeof opts[name] === 'function' ? opts[name](...args) : undefined);

    // Site capabilities (content.js's adapter). Only `highlights` so far, and
    // everything that reads it is one branch — the shape is here so the next
    // adapter can turn something else off without a redesign.
    const CAPS = Object.assign({ highlights: true }, opts.capabilities || {});
    const NOHL = 'highlights aren’t supported on this site — use Page chat';

    const D = {
      page: null,          // the page record from /page
      orphans: {},         // threadId -> bool (content.js's live anchoring verdict)
      streams: {},         // stream_id -> {who, target, text}
      running: {},         // target -> true while a turn is in flight
      turnAgents: {},      // target -> ['claude'|'codex'] as announced by turn-start
      liveAgents: {},      // target -> agents actually seen streaming this turn
      speaker: {},         // target -> the agent whose stream arrived most recently
      notes: {},           // target -> transient status line {text, err}
      warn: '',            // page-chat warning banner (setWarning), '' = none
      drafts: {},          // target -> composer text, preserved across renders
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
      toolsOpen: {},       // tool-activity disclosure key -> expanded
      // who WE are on this companion (setAuthor); '' until the background says
      author: opts.author || '',
      focused: null,
      // a page with no highlights has no Comments to open on
      tab: CAPS.highlights ? 'comments' : 'chat',
      // 'threads' = the Comments/Page-chat tabs; 'pages' = the library of every
      // annotated page, which takes over the whole body and hides the tab bar
      view: 'threads',
      // `confirm` = the url whose inline "delete page + its chat?" is showing;
      // `rowErr` = a refusal from the companion, shown under the row it is about
      pages: { list: null, loading: false, err: '', confirm: null, rowErr: null },
      connected: false,
      connKnown: false,    // false until the background has told us either way
      bridge: '',
      foot: '',
      // effort mirrors models ({current, options}, null until the bridge has
      // spoken); verbosity is a companion-level preference, so it is a string
      models: { current: {}, options: null, status: null, bridge: '', note: '', loading: false,
                effort: null, verbosity: '' },
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
        conn: shadow.querySelector('.hdr .conn'),
        tabs: shadow.querySelector('.tabs'),
        cCount: shadow.querySelector('.tab[data-tab="comments"] .count'),
        comments: shadow.querySelector('.pane[data-pane="comments"]'),
        chat: shadow.querySelector('.pane[data-pane="chat"]'),
        pages: shadow.querySelector('.pane[data-pane="pages"]'),
        foot: shadow.querySelector('.footbar'),
        selbtn: shadow.querySelector('.selbtn'),
        pop: shadow.querySelector('.popover.models'),
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
      paintTabs();
      restoreTab();
      restoreWidth();
      return D;
    }

    function shell() {
      return `
<button class="selbtn" type="button" title="Comment on this selection"><span class="glyph">💬</span>comment</button>
<aside class="panel" role="complementary" aria-label="Botference annotations">
  <div class="grip" title="Drag to resize · double-click to reset" role="separator" aria-orientation="vertical"></div>
  <div class="hdr">
    <div class="title">—</div>
    <div class="meta"><span class="site"></span><span class="conn" title="companion connection"><span class="dot"></span><span class="ctext">connecting…</span></span></div>
    <div class="acts">
      <button class="iconbtn pages" data-act="pages" type="button" title="All annotated pages" aria-label="All annotated pages" aria-pressed="false">${PAGES_SVG}</button>
      <button class="iconbtn" data-act="models" type="button" title="Models" aria-label="Models">⚙</button>
      <button class="iconbtn obsidian" data-act="export" type="button" title="Export to Obsidian" aria-label="Export to Obsidian">${OBSIDIAN_SVG}</button>
      <button class="iconbtn" data-act="close" type="button" title="Close (Esc)">✕</button>
    </div>
  </div>
  <div class="popover models" role="dialog" aria-label="Models" hidden></div>
  <nav class="tabs">
    <button class="tab on" data-tab="comments" type="button">Comments<span class="count">0</span></button>
    <button class="tab" data-tab="chat" type="button">Page chat</button>
  </nav>
  <div class="pane" data-pane="comments"></div>
  <div class="pane" data-pane="chat" hidden></div>
  <div class="pane pages" data-pane="pages" hidden></div>
  <div class="footbar"></div>
</aside>`;
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
      // rest); delete is allowed on anything, so a bad bot answer can be pruned
      const acts = `<div class="acts">` +
        (mine ? `<button class="rebtn" data-act="edit" data-target="${esc(target)}" data-ts="${esc(r.ts)}" title="edit this message" aria-label="edit">✎</button>` : '') +
        `<button class="rebtn" data-act="del-msg" data-target="${esc(target)}" data-ts="${esc(r.ts)}" title="delete this message" aria-label="delete">✕</button></div>`;
      // Bot text is markdown; the user's own text is exactly what they typed and
      // stays literal (nobody wants their *asterisks* eaten). The markdown body
      // is filled in from the DOM side by fillMarkdown() — never as a string.
      const body = bot
        ? `<div class="ctext md" data-md="${esc(mdSlot(r.text))}"></div>`
        : `<div class="ctext">${esc(r.text)}</div>`;
      return `<div class="reply${bot ? ' bot' : ''}${mine ? ' mine' : ''}" data-ts="${esc(r.ts)}" style="--author:${authorColor(r.author)}">
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
    function msgsHtml(target, list) {
      const msgs = (list || []).filter(Boolean);
      const out = [];
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].kind !== 'tools' && !isBot(msgs[i].author)) {
          out.push(replyHtml(target, msgs[i], sameAuthor(msgs[i].author)));
          continue;
        }
        const span = [];
        while (i < msgs.length && (msgs[i].kind === 'tools' || isBot(msgs[i].author))) span.push(msgs[i++]);
        i--;
        const tools = span.filter(x => x.kind === 'tools');
        if (tools.length) out.push(toolsHtml(target, tools));
        for (const r of span) {
          if (r.kind === 'tools') continue;
          out.push(replyHtml(target, r, !isBot(r.author) && sameAuthor(r.author)));
        }
      }
      return out.join('');
    }

    function streamsHtml(target) {
      return Object.keys(D.streams).filter(k => D.streams[k].target === target).map(k => {
        const s = D.streams[k];
        return `<div class="reply bot streaming" data-stream="${esc(k)}" style="--author:${authorColor(s.who)}">
          <span class="who"><span class="author">${esc(s.who)}</span><span class="badge bot-badge">writing…</span></span>
          <pre class="stream-text">${esc(s.text)}</pre></div>`;
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
    function statusHtml(target) {
      const note = D.notes[target];
      const noteHtml = note
        ? `<div class="status-chip${note.err ? ' err' : ''}">${esc(note.text)}</div>` : '';
      if (D.running[target]) {
        return `<div class="status-chip" aria-label="${esc(workingLabel([target]))}">${chipBody([target])}<button class="stop" data-act="interrupt" type="button" title="stop this turn">✕ stop</button></div>` + noteHtml;
      }
      return noteHtml;
    }

    // The composer is NEVER frozen by a send in flight: the message has already
    // left it (see D.outbox) and the next one can be typed straight away. The
    // one exception is a brand-new thread, where a second send before the
    // server has minted an id would create a second thread for the same
    // passage — that button waits.
    function composerHtml(target, label, extra) {
      const draft = D.drafts[target] || '';
      const busy = target === '__new__' && inFlight(target) ? ' disabled' : '';
      return `<div class="composer" data-target="${esc(target)}">
        <textarea rows="2" placeholder="${esc(label)}">${esc(draft)}</textarea>
        <div class="crow"><span class="hint">${esc(HINT)}</span>${extra || ''}<button class="send" data-act="send" data-target="${esc(target)}" type="button"${busy}>Send</button></div>
      </div>`;
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
    function realMsgs(target) {
      if (!D.page) return [];
      if (target === PAGE_TARGET) return D.page.page_chat || [];
      const t = (D.page.threads || []).find(x => x.id === target);
      return (t && t.msgs) || [];
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
        return `<div class="reply mine sending${failed ? ' failed' : ''}" data-out="${esc(e.id)}" style="--author:${authorColor(author)}">
          <span class="who"><span class="author">${esc(author)}</span><span class="when">now</span></span>
          <div class="ctext">${esc(e.text)}</div>${state}</div>`;
      }).join('');
    }

    function cardHtml(t) {
      const orph = D.orphans[t.id] != null ? D.orphans[t.id] : !!t.orphaned;
      const author = threadAuthor(t);
      const cls = ['card', orph ? 'orphaned' : '', D.focused === t.id ? 'focused' : '', D.running[t.id] ? 'working' : ''].filter(Boolean).join(' ');
      const msgs = msgsHtml(t.id, t.msgs);
      // one-step inline confirm — never a browser confirm() dialog, which the
      // page's own modals and focus traps would fight with
      const head = D.confirm === t.id
        ? `<div class="confirm">delete thread?
             <button class="rebtn yes" data-act="del-thread-yes" data-target="${esc(t.id)}" type="button">yes</button>
             <button class="rebtn" data-act="del-thread-no" type="button">no</button></div>`
        : `<button class="rebtn thr-del" data-act="del-thread" data-target="${esc(t.id)}" type="button" title="delete this thread" aria-label="delete thread">✕</button>`;
      return `<div class="${cls}" data-thread="${esc(t.id)}" style="--author:${authorColor(author)}">
        <div class="chead">
          <div class="quote" data-act="jump" data-target="${esc(t.id)}" title="${orph ? 'the anchor text is gone from this page' : 'scroll to this highlight'}">“${esc(t.quote)}”${orph ? '<span class="badge orphan-badge">orphaned</span>' : ''}</div>
          ${head}
        </div>
        <div class="thread">${msgs}${outboxHtml(t.id)}${streamsHtml(t.id)}</div>
        ${statusHtml(t.id)}
        ${composerHtml(t.id, 'Reply…')}
      </div>`;
    }

    function pendingHtml() {
      const p = D.pending;
      const out = outboxHtml('__new__');
      return `<div class="card pending" data-thread="__new__" style="--author:${authorColor(D.author || opts.author || 'you')}">
        <div class="quote" title="the passage you selected">“${esc(p.quote)}”</div>
        ${out ? `<div class="thread">${out}</div>` : ''}
        ${composerHtml('__new__', 'Comment on this passage…',
          '<button class="cancel" data-act="cancel-new" type="button">Cancel</button>')}
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

    function renderComments() {
      const threads = (D.page && D.page.threads) || [];
      let html = offlineHtml() + nohlHtml();
      html += D.pending ? pendingHtml() : '';
      // "select any text and hit 💬" is a lie where selection does nothing —
      // the note above has already said what to do instead
      if (!threads.length && !D.pending && CAPS.highlights) {
        html += `<div class="empty"><b>No comments yet</b>Select any text on the page and hit 💬.</div>`;
      }
      html += threads.map(cardHtml).join('');
      D.el.comments.innerHTML = html;
      D.el.cCount.textContent = String(threads.length);
    }

    function renderChat() {
      const msgs = (D.page && D.page.page_chat) || [];
      const body = msgsHtml(PAGE_TARGET, msgs) + outboxHtml(PAGE_TARGET) + streamsHtml(PAGE_TARGET);
      D.el.chat.innerHTML = offlineHtml() + warnHtml() + `<div class="card chatpane" data-thread="${PAGE_TARGET}" style="--author:${authorColor(D.author || opts.author || 'you')}">
        ${body ? `<div class="thread">${body}</div>` : `<div class="empty"><b>Ask about this page</b>Anything at all — mention a bot to get an answer.</div>`}
        ${statusHtml(PAGE_TARGET)}
        ${composerHtml(PAGE_TARGET, 'Ask about this page…')}
      </div>`;
    }

    // ---- the Pages view -------------------------------------------------
    // The plugin's own history: every page the companion has a record for,
    // browsable from inside the drawer instead of from the council. It is not
    // a third tab — it replaces the whole body (tabs included) and comes back
    // with the ← Back button, because it is about OTHER pages while the tabs
    // are about this one.
    function hostOf(u) {
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
      const acts = confirming
        ? `<span class="pconfirm">delete page + its chat?
             <button class="rebtn yes" data-act="page-del-yes" data-url="${esc(p.url)}" type="button">yes</button>
             <button class="rebtn" data-act="page-del-no" type="button">no</button></span>`
        : `<button class="rebtn pexport" data-act="page-export" data-url="${esc(p.url)}" type="button"
             title="Export this page to Obsidian" aria-label="Export this page to Obsidian">${OBSIDIAN_SVG}</button>
           <button class="rebtn pdel" data-act="page-del" data-url="${esc(p.url)}" type="button"
             title="Delete this page and its chat" aria-label="Delete this page and its chat">✕</button>`;
      return `<div class="prow${cur ? ' current' : ''}" data-url="${esc(p.url)}">
        <button class="prow-main" data-act="page-open" data-url="${esc(p.url)}" type="button"
          title="${esc(cur ? 'back to this page’s comments' : p.url)}">
          <span class="ptitle">${esc(p.title || p.url)}</span>
          <span class="pmeta"><span class="psite">${esc(hostOf(p.url))}</span> · <span class="pcount">${n} thread${n === 1 ? '' : 's'}</span> · <span class="pwhen">${esc(relTime(p.updated_at))}</span>${cur ? '<span class="pcur"> · this page</span>' : ''}${chat}</span>
        </button>
        ${acts}${err}
      </div>`;
    }

    function renderPages() {
      if (!D.mounted || !D.el.pages) return;
      const list = D.pages.list;
      let body;
      if (!list && D.pages.loading) body = `<div class="empty">loading…</div>`;
      else if (D.pages.err && !(list && list.length)) {
        body = `<div class="empty"><b>Could not load your pages</b>${esc(D.pages.err)}</div>`;
      } else if (!list || !list.length) {
        body = `<div class="empty">nothing annotated yet — highlight some text to start</div>`;
      } else {
        body = list.map(pageRowHtml).join('');
      }
      D.el.pages.innerHTML = `<div class="pages-head">
          <button class="backbtn" data-act="pages-back" type="button" title="Back to this page">← Back</button>
          <span class="pages-title">All annotated pages</span>
        </div>${body}`;
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
      renderComments();
      renderChat();
      fillMarkdown(D.shadow);
      D.el.comments.scrollTop = cTop;
      D.el.chat.scrollTop = chTop;
      paintFoot();
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
    const pickerCur = (agent, kind) => (kind === 'effort' ? effortCur : modelCur)(agent);
    const pickerList = (agent, kind) => (kind === 'effort' ? effortList : modelList)(agent);

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
      sel.setAttribute(kind === 'effort' ? 'data-effort' : 'data-agent', agent);
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

    // The one preference in here that is not about an agent: how long an answer
    // in a 420px column is allowed to be. Two states, so it is a switch and not
    // a menu — segmented, 12px, and it says what each end means on hover.
    function verbosityRow() {
      const row = mk('div', 'pop-verbrow');
      const label = mk('span', 'pop-verblabel');
      label.textContent = 'replies';
      const seg = mk('span', 'pop-verb');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'reply length');
      seg.title = VERB_TIP;
      VERB_LEVELS.forEach((level, i) => {
        if (i) {
          const sep = mk('span', 'vsep');
          sep.setAttribute('aria-hidden', 'true');
          sep.textContent = '·';
          seg.appendChild(sep);
        }
        const b = mk('button', 'vseg');
        b.type = 'button';
        b.setAttribute('data-act', 'verb');
        b.setAttribute('data-level', level);
        b.title = VERB_TIP;
        b.textContent = level;
        seg.appendChild(b);
      });
      row.appendChild(label);
      row.appendChild(seg);
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
      const effort = kind === 'effort';
      const row = group.querySelector(effort ? '.pop-effort' : '.pop-modelrow');
      const sel = group.querySelector('select[' + (effort ? 'data-effort' : 'data-agent') + ']');
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
        D.models.note = agent + ' → ' + model;
        D.models.err = false;
      }
      paintModelHint();
    }

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
        D.models.note = agent + ' effort → ' + level;
        D.models.err = false;
      }
      syncModels();
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
        const eff = sel.getAttribute('data-effort');
        if (eff) { pickEffort(eff, sel.value); return; }
        pickModel(sel.getAttribute('data-agent'), sel.value);
      });

      // a checkbox in a bot's checklist. `change` and not `click`, so keyboard
      // toggles count too — and the box has already moved by the time we get
      // here, which is exactly the optimistic state we want to keep or undo.
      D.shadow.addEventListener('change', e => {
        const box = e.target;
        if (!box || !box.classList || !box.classList.contains('md-tick')) return;
        doTick(box);
      });

      D.shadow.addEventListener('click', e => {
        const btn = e.target.closest && e.target.closest('[data-act]');
        if (!btn) {
          const card = e.target.closest && e.target.closest('.card[data-thread]');
          if (card && card.dataset.thread !== PAGE_TARGET) focus(card.dataset.thread);
          return;
        }
        const act = btn.dataset.act;
        const target = btn.dataset.target;
        if (act === 'close') { close(); return; }
        if (act === 'models') { if (D.modelsOpen) closeModels(); else openModels(); return; }
        if (act === 'relay') { if (!btn.disabled) doRelay(btn.dataset.agent); return; }
        if (act === 'verb') { setVerbosity(btn.dataset.level); return; }
        if (act === 'export') { doExport(); return; }
        if (act === 'pages') { if (D.view === 'pages') showThreads(); else showPages(); return; }
        if (act === 'pages-back') { showThreads(); return; }
        if (act === 'page-open') { openPageRow(btn.dataset.url); return; }
        if (act === 'page-export') { doExportPage(btn.dataset.url); return; }
        if (act === 'page-del') { D.pages.confirm = btn.dataset.url; D.pages.rowErr = null; renderPages(); return; }
        if (act === 'page-del-no') { D.pages.confirm = null; renderPages(); return; }
        if (act === 'page-del-yes') { doDeletePage(btn.dataset.url); return; }
        if (act === 'jump') {
          const card = btn.closest('.card');
          if (card && !card.classList.contains('orphaned') && !card.classList.contains('pending')) {
            focus(target); cb('onJump')(target);
          }
          return;
        }
        if (act === 'send') { doSend(target); return; }
        if (act === 'send-retry') { retrySend(target, btn.dataset.out); return; }
        if (act === 'send-discard') { discardSend(target, btn.dataset.out); return; }
        if (act === 'cancel-new') { cancelNew(); return; }
        if (act === 'tools') { const k = btn.dataset.key; D.toolsOpen[k] = !D.toolsOpen[k]; render(); return; }
        if (act === 'interrupt') { doInterrupt(btn); return; }
        if (act === 'retry') { cb('onReconnect')(); return; }
        if (act === 'warn-dismiss') { setWarning(''); return; }
        if (act === 'edit') { startEdit(btn); return; }
        if (act === 'del-msg') { doDelete(target, btn.dataset.ts); return; }
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

      // ⌘/Ctrl+Enter sends; plain Enter stays a newline (comments run long)
      D.shadow.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          // Esc peels one layer at a time: popover first, then the drawer
          if (D.modelsOpen) closeModels(); else close();
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

    function focus(id) {
      if (D.focused === id) return;
      D.focused = id;
      D.shadow.querySelectorAll('.card').forEach(c => c.classList.toggle('focused', c.dataset.thread === id));
      cb('onFocus')(id);
    }

    function note(target, text, err) {
      const key = target == null ? PAGE_TARGET : target;
      if (text) D.notes[key] = { text, err: !!err }; else delete D.notes[key];
      render();
    }

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
        deliver(target, queueSend(target, text));
      } finally {
        delete D.sendLock[target];
      }
    }

    // The synchronous half: the message becomes a pending message, the composer
    // is emptied, the last error line goes.
    function queueSend(target, text) {
      const list = D.outbox[target] || (D.outbox[target] = []);
      const twins = list.filter(e => e.text === text).length;
      const entry = { id: 'o-' + (++outSeq), text, state: 'sending', error: '',
                      seen: countSame(target, text) + twins };
      list.push(entry);
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
      let res;
      try {
        res = target === '__new__'
          ? await cb('onSave')({ ...D.pending, text: entry.text })
          : await cb('onReply')(target, entry.text);
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
      if (target === '__new__') D.pending = null;
      const key = target === '__new__' ? newId : target;
      // The companion took the message but will not summon the bots for this
      // sender (a guest with no bot access, or a companion started
      // --no-agents). That is not a failed send — the message is saved — so it
      // is said next to the composer and nothing is rolled back.
      if (res.reason) note(key == null ? null : key, res.reason, true);
      else if (res.queued) note(key, res.position > 1 ? `queued (#${res.position})` : 'queued…');
      else note(target === '__new__' ? null : target, null);
      render();
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

    function startEdit(btn) {
      const reply = btn.closest('.reply');
      const target = btn.dataset.target, ts = btn.dataset.ts;
      if (!reply || reply.querySelector('textarea')) return;
      const body = reply.querySelector('.ctext');
      const old = body ? body.textContent : '';
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
    function findMsg(target, ts) {
      if (!D.page) return null;
      const list = target === PAGE_TARGET
        ? (D.page.page_chat || [])
        : (((D.page.threads || []).find(t => t.id === target) || {}).msgs || []);
      return list.find(m => m && m.ts === ts) || null;
    }

    async function doTick(box) {
      const li = box.closest('li');
      const reply = box.closest('.reply');
      const card = box.closest('.card[data-thread]');
      const target = card && card.getAttribute('data-thread');
      const ts = reply && reply.getAttribute('data-ts');
      const index = Number(box.getAttribute('data-tick'));
      const checked = !!box.checked;
      if (!target || !ts || !isFinite(index)) { box.checked = !checked; return; }
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
      // list from it — the checkbox states come back out of the text
      const msg = findMsg(target, ts);
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
      note(target, 'stopping…');
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
    const doExport = () => exportFlow(() => cb('onExport')());
    const doExportPage = url => exportFlow(() => cb('onExportPage')(url));

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
        D.speaker = {}; D.notes = {}; D.toolsOpen = {}; D.outbox = {};
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

    function showPages() {
      mount();
      D.view = 'pages';
      paintView();
      if (!D.pages.list) renderPages();
      loadPages(!!D.pages.list);
      return D;
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
      D.pending = anchor;
      D.tab = 'comments';
      paintTabs();
      open('comments');
      render();
      const ta = D.shadow.querySelector('.card.pending textarea');
      if (ta) { ta.focus(); D.el.comments.scrollTop = 0; }
      return D;
    }

    function setPage(page) {
      D.page = page || null;
      if (D.mounted) {
        const title = (page && page.title) || document.title || '—';
        D.el.title.textContent = title;
        D.el.title.title = title;
        D.el.site.textContent = (page && page.site) || opts.hostname || '';
      }
      render();
      return D;
    }

    function setOrphans(map) { D.orphans = map || {}; render(); return D; }
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
      const b = D.el.selbtn;
      b.style.left = Math.max(8, Math.min(x, window.innerWidth - 110)) + 'px';
      b.style.top = Math.max(8, Math.min(y, window.innerHeight - 40)) + 'px';
      b.classList.add('on');
      return D;
    }
    function hideSel() { if (D.mounted) D.el.selbtn.classList.remove('on'); return D; }

    // ---- companion events -----------------------------------------------
    function onEvent(ev) {
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
        if (D.modelsOpen) syncModels();
        return;
      }
      if (ev.type !== 'chat') return;
      const target = ev.target || PAGE_TARGET;
      switch (ev.kind) {
        case 'turn-start':
          D.running[target] = true;
          // an older companion sends no `agents`; the chip then stays generic
          D.turnAgents[target] = Array.isArray(ev.agents) ? ev.agents.filter(Boolean) : [];
          D.liveAgents[target] = [];
          delete D.speaker[target];
          delete D.notes[target];
          render();
          break;
        case 'stream': {
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
          render();
          break;
        case 'turn-end':
          delete D.running[target];
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
          }
          note(target, ev.error || 'the bots hit an error', true);
          break;
      }
    }

    // Optimistic local append so the thread moves the instant the event lands;
    // content.js still refetches /page on `page` events for the truth.
    function appendMsg(target, msg) {
      if (!msg || !D.page) return;
      const list = target === PAGE_TARGET
        ? (D.page.page_chat || (D.page.page_chat = []))
        : ((D.page.threads || []).find(t => t.id === target) || {}).msgs;
      if (!list) return;
      if (list.some(m => m.ts === msg.ts && m.author === msg.author)) return;
      list.push(msg);
    }

    Object.assign(D, {
      mount, open, close, toggle, render, setPage, setOrphans, setConn, setTheme, setWarning, setAuthor,
      beginNew, cancelNew, showSel, hideSel, onEvent, focus, note,
      openModels, closeModels, setWidth: w => applyWidth(w),
      showPages, showThreads, refreshPages,
      isOpen: () => D.opened,
      isPagesOpen: () => D.view === 'pages',
    });
    return D;
  }

  root.BFPDrawer = {
    create, authorColor, isBot, HINT, PAGE_TARGET,
    renderMarkdown, clampWidth, W_DEFAULT, W_MIN, W_MAX,
  };
})(typeof window !== 'undefined' ? window : globalThis);
