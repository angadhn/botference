// drawer.js — the right-side annotation drawer, entirely inside a shadow root.
//
// Nothing in here talks to the network or the DOM of the page; content.js owns
// both and hands this file (a) page records to render and (b) callbacks to call.
// Everything visual lives in drawer.css, linked into the shadow root — so page
// CSS cannot reach in and drawer CSS cannot leak out.
//
// Exposed as window.BFPDrawer (classic script, isolated content-script world).
//
//   const d = BFPDrawer.create({ hostname, cssUrl, theme, on… });
//   d.mount(); d.setPage(record); d.open('comments');
//
// Callbacks (all optional, all may return a Promise):
//   onSave({quote,prefix,suffix,text})  new anchored thread committed
//   onCancelNew()                       the pending new-thread card dismissed
//   onReply(threadId, text)             threadId '__page__' = page chat
//   onEdit(threadId, ts, text)
//   onDelete(threadId, ts|null)         null ts = delete the whole thread
//   onExport()                          → {ok, path} to show in the footbar
//   onInterrupt()
//   onJump(threadId)                    quote clicked: scroll page to highlight
//   onFocus(threadId|null)              card focused/blurred: tint the highlight
//   onModels()                          → {ok, current, options, status, bridge}
//                                                                         (GET /models)
//   onSetModel(agent, model)            → {ok, queued}                    (POST /model)
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
  const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
  const NUMBER = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
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

  function renderMarkdown(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
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
        while (i < lines.length) {
          const m = (ordered ? NUMBER : BULLET).exec(lines[i]);
          if (!m) break;
          i++;
          let txt = ordered ? m[2] : m[1];
          // lazy continuation: a wrapped item keeps flowing into the same <li>
          while (i < lines.length && !isBlockStart(lines[i])) txt += ' ' + lines[i++].trim();
          mdInline(txt, list.appendChild(mk('li')));
        }
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

  function create(opts) {
    opts = opts || {};
    const cb = name => (...args) => (typeof opts[name] === 'function' ? opts[name](...args) : undefined);

    const D = {
      page: null,          // the page record from /page
      orphans: {},         // threadId -> bool (content.js's live anchoring verdict)
      streams: {},         // stream_id -> {who, target, text}
      running: {},         // target -> true while a turn is in flight
      turnAgents: {},      // target -> ['claude'|'codex'] as announced by turn-start
      liveAgents: {},      // target -> agents actually seen streaming this turn
      speaker: {},         // target -> the agent whose stream arrived most recently
      notes: {},           // target -> transient status line {text, err}
      drafts: {},          // target -> composer text, preserved across renders
      sending: {},         // target -> true while its POST is in flight
      pending: null,       // {quote, prefix, suffix} while composing a new thread
      confirm: null,       // threadId whose "delete thread?" confirm is showing
      toolsOpen: {},       // tool-activity disclosure key -> expanded
      focused: null,
      tab: 'comments',
      connected: false,
      connKnown: false,    // false until the background has told us either way
      bridge: '',
      foot: '',
      models: { current: {}, options: null, status: null, bridge: '', note: '', loading: false },
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
        foot: shadow.querySelector('.footbar'),
        selbtn: shadow.querySelector('.selbtn'),
        pop: shadow.querySelector('.popover.models'),
        grip: shadow.querySelector('.grip'),
      };
      applyWidth(D.width);
      wireEvents();
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
  <div class="footbar"></div>
</aside>`;
    }

    // ---- tab memory (per hostname) --------------------------------------
    function restoreTab() {
      const hn = opts.hostname || 'default';
      try {
        chrome.storage.local.get(TAB_KEY, r => {
          const m = (r && r[TAB_KEY]) || {};
          if (m[hn] === 'chat' || m[hn] === 'comments') { D.tab = m[hn]; paintTabs(); }
        });
      } catch { /* no storage (harness fallback) — keep the default */ }
    }
    function rememberTab() {
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

    function statusHtml(target) {
      const note = D.notes[target];
      if (D.running[target]) {
        return `<div class="status-chip" aria-label="${esc(workingLabel([target]))}">${chipBody([target])}<button class="stop" data-act="interrupt" type="button" title="stop this turn">✕ stop</button></div>`;
      }
      if (note) return `<div class="status-chip${note.err ? ' err' : ''}">${esc(note.text)}</div>`;
      return '';
    }

    function composerHtml(target, label, extra) {
      const draft = D.drafts[target] || '';
      const busy = D.sending[target] ? ' disabled' : '';
      return `<div class="composer" data-target="${esc(target)}">
        <textarea rows="2" placeholder="${esc(label)}"${busy}>${esc(draft)}</textarea>
        <div class="crow"><span class="hint">${esc(HINT)}</span>${extra || ''}<button class="send" data-act="send" data-target="${esc(target)}" type="button"${busy}>Send</button></div>
      </div>`;
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
        <div class="thread">${msgs}${streamsHtml(t.id)}</div>
        ${statusHtml(t.id)}
        ${composerHtml(t.id, 'Reply…')}
      </div>`;
    }

    function pendingHtml() {
      const p = D.pending;
      return `<div class="card pending" data-thread="__new__" style="--author:${authorColor(opts.author || 'you')}">
        <div class="quote" title="the passage you selected">“${esc(p.quote)}”</div>
        ${composerHtml('__new__', 'Comment on this passage…',
          '<button class="cancel" data-act="cancel-new" type="button">Cancel</button>')}
        ${statusHtml('__new__')}
      </div>`;
    }

    const sameAuthor = a => String(a || '').toLowerCase() === String(opts.author || 'angadh').toLowerCase();

    // The companion is a local process the user has to have started. When it
    // is down that is the single most important thing on screen — say so in
    // plain words, with the fix and a retry, not a 12px grey dot.
    const offlineHtml = () => (D.connKnown && !D.connected)
      ? `<div class="notice"><b>Companion not running</b>` +
        `<div>Nothing can be saved or answered until the companion is listening on ` +
        `<code>127.0.0.1:4189</code>. Start it with <code>botference plugin</code>, then retry.</div>` +
        `<button data-act="retry" type="button">↻ Retry connection</button></div>`
      : '';

    function renderComments() {
      const threads = (D.page && D.page.threads) || [];
      let html = offlineHtml();
      html += D.pending ? pendingHtml() : '';
      if (!threads.length && !D.pending) {
        html += `<div class="empty"><b>No comments yet</b>Select any text on the page and hit 💬.</div>`;
      }
      html += threads.map(cardHtml).join('');
      D.el.comments.innerHTML = html;
      D.el.cCount.textContent = String(threads.length);
    }

    function renderChat() {
      const msgs = (D.page && D.page.page_chat) || [];
      const body = msgsHtml(PAGE_TARGET, msgs) + streamsHtml(PAGE_TARGET);
      D.el.chat.innerHTML = offlineHtml() + `<div class="card chatpane" data-thread="${PAGE_TARGET}" style="--author:${authorColor(opts.author || 'you')}">
        ${body ? `<div class="thread">${body}</div>` : `<div class="empty"><b>Ask about this page</b>Anything at all — mention a bot to get an answer.</div>`}
        ${statusHtml(PAGE_TARGET)}
        ${composerHtml(PAGE_TARGET, 'Ask about this page…')}
      </div>`;
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
        // A send in flight owns its composer. Harvesting here would read the
        // just-sent text back out of the still-live textarea and undo the
        // clear — which is exactly why sent messages used to stay in the box.
        if (D.sending[target]) return;
        if (ta.value) D.drafts[target] = ta.value; else delete D.drafts[target];
      });
    }

    function paintTabs() {
      if (!D.mounted) return;
      D.el.tabs.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === D.tab));
      D.el.comments.hidden = D.tab !== 'comments';
      D.el.chat.hidden = D.tab !== 'chat';
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

    function optionList(agent) {
      const cur = (D.models.current && D.models.current[agent]) || '';
      const list = (D.models.options && D.models.options[agent]) || null;
      if (!list || !list.length) return [cur || '—'];
      // a model the bridge no longer offers is still what is running: show it
      return list.indexOf(cur) === -1 && cur ? [cur].concat(list) : list.slice();
    }
    function buildSelect(agent) {
      const sel = mk('select');
      sel.setAttribute('data-agent', agent);
      const cur = (D.models.current && D.models.current[agent]) || '';
      const list = (D.models.options && D.models.options[agent]) || null;
      for (const o of optionList(agent)) {
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

        const line = mk('div', 'pop-line');
        const row = mk('label', 'pop-row');
        const name = mk('span', 'pop-agent');
        const mark = mk('span', 'pop-mark');
        mark.innerHTML = MARKS[agent] || '';       // authored SVG, never data
        name.appendChild(mark);
        name.appendChild(document.createTextNode(agent));
        row.appendChild(name);
        row.appendChild(buildSelect(agent));
        line.appendChild(row);
        // outside the <label>: a click on a label is forwarded to its control,
        // which would drop the select open every time you asked for a relay
        line.appendChild(relayButton(agent, 'relay', agent + ' — ' + RELAY_TIP));
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

        const sel = group.querySelector('select');
        const cur = (m.current && m.current[agent]) || '';
        const want = optionList(agent);
        const have = [].map.call(sel.options, o => o.value);
        if (have.join(' ') !== want.join(' ')) {
          group.querySelector('.pop-row').replaceChild(buildSelect(agent), sel);
        } else {
          if (cur && sel.value !== cur) sel.value = cur;
          sel.disabled = !(m.options && m.options[agent] && m.options[agent].length);
        }
        paintGauge(group, agent, st[agent]);
      }

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
        D.models.bridge = r.bridge || '';
        D.models.err = false;
      } else {
        D.models.options = null;
        D.models.status = null;
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
        pickModel(sel.getAttribute('data-agent'), sel.value);
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
        if (act === 'export') { doExport(); return; }
        if (act === 'jump') {
          const card = btn.closest('.card');
          if (card && !card.classList.contains('orphaned') && !card.classList.contains('pending')) {
            focus(target); cb('onJump')(target);
          }
          return;
        }
        if (act === 'send') { doSend(target); return; }
        if (act === 'cancel-new') { cancelNew(); return; }
        if (act === 'tools') { const k = btn.dataset.key; D.toolsOpen[k] = !D.toolsOpen[k]; render(); return; }
        if (act === 'interrupt') { note(null, 'stopping…'); cb('onInterrupt')(); return; }
        if (act === 'retry') { cb('onReconnect')(); return; }
        if (act === 'edit') { startEdit(btn); return; }
        if (act === 'del-msg') { doDelete(target, btn.dataset.ts); return; }
        if (act === 'del-thread') { D.confirm = target; render(); return; }
        if (act === 'del-thread-no') { D.confirm = null; render(); return; }
        if (act === 'del-thread-yes') { D.confirm = null; doDelete(target, null); return; }
      });

      D.el.tabs.addEventListener('click', e => {
        const t = e.target.closest && e.target.closest('.tab');
        if (!t) return;
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

    async function doSend(target) {
      if (!target || target === '__edit__') return;
      harvestDrafts();
      const text = (D.drafts[target] || '').trim();
      if (!text) return;
      // in-flight: the composer is frozen and its text is no longer a draft.
      // On success the draft is dropped (the box comes back empty); on failure
      // it is left exactly as typed so nothing the user wrote is ever lost.
      D.sending[target] = true;
      const box = D.shadow.querySelector('.composer[data-target="' + cssq(target) + '"] textarea');
      if (box) box.disabled = true;
      try {
        let res;
        if (target === '__new__') {
          res = await cb('onSave')({ ...D.pending, text });
          if (res && res.ok !== false) { D.pending = null; delete D.drafts['__new__']; if (box) box.value = ''; }
        } else {
          res = await cb('onReply')(target, text);
          if (res && res.ok !== false) { delete D.drafts[target]; if (box) box.value = ''; }
        }
        // a fresh thread's status chip has to land on the id the SERVER minted
        // (content.js normalises /thread's {ok, thread} into thread_id; accept
        // the raw {thread:{id}} shape too so neither side can drift silently)
        const newId = res && (res.thread_id || (res.thread && res.thread.id)) || null;
        if (res && res.ok === false) note(target === '__new__' ? '__new__' : target, res.error || 'save failed', true);
        else if (res && res.queued) note(target === '__new__' ? newId : target, res.position > 1 ? `queued (#${res.position})` : 'queued…');
        else note(target === '__new__' ? null : target, null);
      } catch (e) {
        note(target, String(e && e.message || e), true);
      } finally {
        delete D.sending[target];
        render();
      }
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

    async function doDelete(target, ts) {
      const r = await cb('onDelete')(target, ts || null);
      if (r && r.ok === false) note(target, r.error || 'delete failed', true);
      else render();
    }

    async function doExport() {
      D.foot = 'exporting…'; D.footErr = false; paintFoot();
      const r = await cb('onExport')();
      if (r && r.ok === false) { D.foot = r.error || 'export failed'; D.footErr = true; }
      else D.foot = 'exported → ' + ((r && r.path) || 'Obsidian');
      paintFoot();
      setTimeout(() => { if (String(D.foot).startsWith('exported')) { D.foot = ''; paintFoot(); } }, 6000);
    }

    const cssq = s => String(s).replace(/["\\]/g, '\\$&');

    // ---- public surface -------------------------------------------------
    function open(tab) {
      mount();
      if (tab) { D.tab = tab; paintTabs(); rememberTab(); }
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
      cb('onCancelNew')();
      render();
    }

    function beginNew(anchor) {
      mount();
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
          delete D.running[target];
          delete D.turnAgents[target];
          delete D.liveAgents[target];
          delete D.speaker[target];
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
      mount, open, close, toggle, render, setPage, setOrphans, setConn, setTheme,
      beginNew, cancelNew, showSel, hideSel, onEvent, focus, note,
      openModels, closeModels, setWidth: w => applyWidth(w),
      isOpen: () => D.opened,
    });
    return D;
  }

  root.BFPDrawer = {
    create, authorColor, isBot, HINT, PAGE_TARGET,
    renderMarkdown, clampWidth, W_DEFAULT, W_MIN, W_MAX,
  };
})(typeof window !== 'undefined' ? window : globalThis);
