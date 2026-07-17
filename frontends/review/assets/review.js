/* Review UI: margin cards, per-user comments, bot threads, live SSE updates.
   Own state lives in localStorage and mirrors (one-way) to the server, which
   writes only this user's state/users/<handle>.json. Other users are read-only. */
(function () {
  const slug = document.body.dataset.slug;
  const META = window.BUILD_META || {};
  const KEY = `review-${META.slug || 'doc'}`;

  // theme: light/dark/system, persisted per browser; data-theme on <html> beats
  // prefers-color-scheme in both directions (see style.css overrides)
  const THEME_KEY = 'review-theme';
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(localStorage.getItem(THEME_KEY) || 'system');
  // migrate any legacy localStorage keys declared in review.config.json
  for (const k of META.legacy_keys || []) {
    if (!localStorage.getItem(KEY) && localStorage.getItem(k)) localStorage.setItem(KEY, localStorage.getItem(k));
  }

  const LIVE = location.protocol.startsWith('http');
  let ME = null, OTHERS = {}, THREADS = {}, SUGG = window.SUGGESTIONS || [];
  let showResolved = false, pendingRender = false;
  // inline tracked changes (suggesting mode): viewer-local toggle, default on
  const TKEY = KEY + '-inline-changes';
  let inlineChanges = localStorage.getItem(TKEY) !== '0';
  // focus mode: every card renders as a collapsed one-liner; exactly ONE thread
  // is expanded at a time (accordion). Persisted so SSE re-renders and the
  // apply-flow page reload land back on the same focused thread.
  const FOKEY = KEY + '-focus';
  let FOCUSED = localStorage.getItem(FOKEY) || null;

  // author filter chips: viewer-local, never shared
  const FKEY = KEY + '-filter';
  let authorFilter = new Set(JSON.parse(localStorage.getItem(FKEY) || '["all"]'));
  const saveFilter = () => localStorage.setItem(FKEY, JSON.stringify([...authorFilter]));
  // a card may be jointly authored ("claude+codex"): it belongs to every listed author's chip
  const cardAuthors = c => String(c.author || 'bot').toLowerCase().split(/[+,]/).map(s => s.trim()).filter(Boolean);

  // per-author identity: a stable accent per participant, used on card borders,
  // author labels, thread entries and filter chips. Bots have fixed theme colors;
  // humans get a muted hue derived deterministically from their handle.
  const isBot = a => /^(claude|codex)/i.test(String(a || '').trim());
  function authorColor(name) {
    const a = String(name || '').toLowerCase().trim();
    if (a.startsWith('claude')) return 'var(--claude)';
    if (a.startsWith('codex')) return 'var(--codex)';
    let h = 5381;
    for (let i = 0; i < a.length; i++) h = ((h << 5) + h + a.charCodeAt(i)) >>> 0;
    return `oklch(var(--author-l, 0.52) 0.09 ${h % 360})`;
  }

  const store = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  const setStore = d => localStorage.setItem(KEY, JSON.stringify(d));
  const isNarrow = () => window.matchMedia('(max-width: 1100px)').matches;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // hosted identity: per-browser handle + (owner only) the ?owner=… token, sent
  // as headers on every request; the server never trusts a handle to be the owner
  const HKEY = KEY + '-handle', OKEY = KEY + '-owner';
  {
    const q = new URLSearchParams(location.search);
    if (q.get('owner')) {
      localStorage.setItem(OKEY, q.get('owner'));
      q.delete('owner');
      history.replaceState(null, '', location.pathname + ([...q].length ? '?' + q : ''));
    }
  }
  let HOSTED_MODE = false, IS_OWNER = true, OWNER_HANDLE = null, APPLY = { applied: {}, flagged: {}, round: null }, PENDING_M = [];
  let SRC_DIRTY = null, lastCommit = null; // null = server predates the source_dirty field
  const idHeaders = () => {
    const h = {};
    if (localStorage.getItem(HKEY)) h['x-review-handle'] = localStorage.getItem(HKEY);
    if (localStorage.getItem(OKEY)) h['x-review-owner'] = localStorage.getItem(OKEY);
    return h;
  };
  const api = (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...idHeaders() } });
  function adoptData(j) {
    ME = j.me; THREADS = j.threads || {}; SUGG = j.suggestions || SUGG;
    OTHERS = Object.fromEntries(Object.entries(j.users || {}).filter(([h]) => h !== j.me));
    HOSTED_MODE = !!j.hosted; IS_OWNER = j.owner !== false;
    OWNER_HANDLE = j.owner_handle || OWNER_HANDLE; // additive field; older servers omit it
    if (j.apply) APPLY = j.apply;
    PENDING_M = j.pending_mentions || [];
    // additive server fields; a server predating them simply doesn't send them —
    // chat detection falls back to SSE events / 409s, and the out-of-band line hides
    if (typeof j.chat === 'boolean') PRESENCE.chat = j.chat;
    SRC_DIRTY = Array.isArray(j.source_dirty) ? j.source_dirty : SRC_DIRTY;
  }

  // --- one-way mirror to server ---
  let syncTimer = null, syncState = 'off';
  function pushState() {
    if (!LIVE) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      api('/state', { method: 'POST', body: JSON.stringify({ build: META, decisions: store() }) })
        .then(r => { syncState = r.ok ? 'ok' : 'err'; if (r.ok) serverDead = false; renderPresence(); })
        .catch(() => { syncState = 'err'; renderPresence(); });
    }, 400);
  }
  const save = d => { setStore(d); pushState(); };

  // --- ambient presence strip: connection + chat mode + per-agent activity.
  // Lives in the sticky sidebar (replaces the old #sync-dot line), so agent
  // activity is visible from anywhere on the page even when the active thread
  // is off-screen or on another section page.
  const AGENTS = ['claude', 'codex'];
  const VERBS = ['crystallizing', 'architecting', 'mulling', 'drafting', 'responding', 'pondering', 'sketching', 'weighing'];
  const PRESENCE = {
    chat: null, // null = unknown (a server predating the /data "chat" field); true/false once known
    tid: null,  // target of the in-flight anchored turn, for click-to-jump
    agents: Object.fromEntries(AGENTS.map(a => [a, { active: false, verb: '' }])),
  };
  let sseDown = false, serverDead = false, probeTimer = null;
  function connState() {
    if (serverDead) return ['down', '✕ server down — node review/server.mjs'];
    if (syncState === 'err') return ['err', '○ sync failed — is the server running?'];
    if (sseDown) return ['err', '○ live updates lost — reconnecting…'];
    return ['ok', `● live — you are ${ME || '…'}`];
  }
  // official logomarks for the avatar cluster — path data from the Simple Icons
  // project (anthropic.svg / openai.svg, 24x24 single-path glyphs), fully
  // inlined here: the shipped asset makes zero runtime external fetches
  const MARKS = {
    claude: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
    codex: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  };
  // sidebar strip = connection + chat mode only; per-agent presence lives in the
  // fixed top-right avatar cluster (GDocs-style). Idle = dimmed static avatar;
  // working = ~1s rotating dashed ring in the agent's accent (ring space is
  // reserved, so no layout shift). The verb line is the hover tooltip.
  // guest-facing server-gone banner: when the SSE stream died AND the probe
  // failed, a NON-owner (hosted guest) gets a prominent-but-calm banner — the
  // sidebar strip alone is easy to miss when your host has walked away. The
  // owner keeps the presence-strip-only behavior (they know their own server).
  // Before /data ever succeeded, hosted/owner are unknown: a picked handle
  // without an owner token is the guest heuristic.
  function renderServerGone() {
    const guest = HOSTED_MODE ? !IS_OWNER
      : (!!localStorage.getItem(HKEY) && !localStorage.getItem(OKEY));
    let b = document.getElementById('server-gone');
    if (!(serverDead && guest)) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement('div');
    b.id = 'server-gone';
    b.textContent = 'server unreachable — your comments are saved in this browser and will sync if this URL comes back. You can also export them (sidebar) and email/commit them.';
    document.body.appendChild(b);
  }
  function renderPresence() {
    renderServerGone();
    const el = document.getElementById('presence');
    if (el) {
      const [cls, txt] = connState();
      const chatTxt = PRESENCE.chat === null ? 'agents: —' : `agents: ${PRESENCE.chat ? 'on' : 'off'}`;
      el.innerHTML = `<div class="conn ${cls}">${esc(txt)}</div>
        <div class="chatmode" title="agent chat (server started with --chat)">${chatTxt}</div>`;
    }
    const av = document.getElementById('avatars');
    if (av) av.innerHTML = AGENTS.map(a => {
      const s = PRESENCE.agents[a];
      const name = a[0].toUpperCase() + a.slice(1);
      const tip = s.active ? `${name} is ${s.verb}… — click to jump to the thread` : `${name} — idle`;
      // white brand glyph (currentColor) on the agent's accent circle: reads
      // identically in both themes
      return `<div class="avatar-ring${s.active ? ' working' : ''}" data-agent="${a}" style="--author:var(--${a})" title="${esc(tip)}"><span class="avatar">${MARKS[a] || ''}</span></div>`;
    }).join('');
  }
  const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)];
  // one verb per agent per turn, chosen at turn-start (or first stream sighting)
  function presenceTurnStart(tid, userText) {
    PRESENCE.tid = tid;
    const t = String(userText || '');
    let routed = AGENTS.filter(a => new RegExp('@' + a + '\\b', 'i').test(t));
    if (/@all\b/i.test(t) || !routed.length) routed = AGENTS.slice(); // @all (or unknown routing) shows both
    for (const a of AGENTS) {
      const s = PRESENCE.agents[a];
      s.active = routed.includes(a);
      if (s.active) s.verb = pickVerb();
    }
    renderPresence();
  }
  function presenceStream(who) {
    const s = PRESENCE.agents[String(who).toLowerCase().includes('codex') ? 'codex' : 'claude'];
    if (s && !s.active) { s.active = true; s.verb = pickVerb(); renderPresence(); }
  }
  function presenceIdle() {
    PRESENCE.tid = null;
    for (const a of AGENTS) PRESENCE.agents[a].active = false;
    renderPresence();
  }
  function setChatMode(on) {
    if (PRESENCE.chat === on) return;
    PRESENCE.chat = on;
    renderPresence();
  }
  function probeServer() { // SSE dropped: is the server gone, or just the stream?
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      api('/whoami').then(r => { serverDead = !r.ok; renderPresence(); })
        .catch(() => { serverDead = true; renderPresence(); });
    }, 800);
  }
  // clicking an active agent jumps to the live thread card if it's on this page,
  // else navigates to the section page the active thread lives on
  function sectionOf(id) {
    const sc = SUGG.find(c => c.id === id);
    if (sc) return sc.section;
    const v = store()[id] || Object.values(OTHERS).map(d => d[id]).find(Boolean);
    return v && v.section;
  }
  function jumpToActive() {
    const tid = PRESENCE.tid;
    if (!tid) return;
    if (document.querySelector(`.card[data-id="${CSS.escape(tid)}"]`)) {
      activateCard(tid); // focuses (rerenders), so re-query the fresh card node
      const card = document.querySelector(`.card[data-id="${CSS.escape(tid)}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const sec = sectionOf(tid);
    const a = sec && document.querySelector(`nav.toc a[data-slug="${CSS.escape(sec)}"]`);
    if (a) location.href = a.getAttribute('href');
  }

  document.querySelectorAll('nav.toc a').forEach(a => {
    if (a.dataset.slug === slug) a.setAttribute('data-current', '1');
  });

  // stable ids on blocks
  document.querySelectorAll('#paper p, #paper figure').forEach((el, i) => {
    el.dataset.cid = `${slug}-blk-${i}`;
    el.addEventListener('click', e => {
      if (e.target.closest('a,abbr,button,textarea,del.tc-del,ins.tc-ins')) return; // tc-* opens the change popover

      const mk = e.target.closest('mark.user-hl');
      if (mk) { activateCard(mk.dataset.cardId); return; }
      if (window.getSelection() && !window.getSelection().isCollapsed) return;
      if (e.altKey) { openComposer({ anchor: el.dataset.cid, excerpt: el.textContent.slice(0, 100) }); return; }
      if (el.dataset.cardId) activateCard(el.dataset.cardId);
    });
  });

  const margin = document.getElementById('margin');

  function ownComments() {
    const d = store();
    return Object.entries(d)
      .filter(([, v]) => v.status === 'user-comment' && v.section === slug)
      .map(([id, v]) => ({ id, type: 'user-comment', mine: true, author: ME || 'you', ...v }));
  }
  function otherComments() {
    const out = [];
    for (const [h, dec] of Object.entries(OTHERS)) {
      for (const [id, v] of Object.entries(dec)) {
        if (v.status === 'user-comment' && v.section === slug) out.push({ id, type: 'user-comment', mine: false, author: h, ...v });
      }
    }
    return out;
  }
  function allCards(resolved) {
    const sugg = SUGG.filter(c => c.section === slug && !c.reply_to);
    const all = [...sugg, ...ownComments(), ...otherComments()];
    return all.filter(c => !!c.resolved === !!resolved)
      .filter(c => authorFilter.has('all') || cardAuthors(c).some(a => authorFilter.has(a)));
  }
  const pageCards = () => allCards(showResolved);
  function participants() {
    const s = new Set();
    if (ME) s.add(String(ME).toLowerCase());
    Object.keys(OTHERS).forEach(h => s.add(String(h).toLowerCase()));
    SUGG.forEach(c => c.author && cardAuthors(c).forEach(a => s.add(a)));
    Object.values(THREADS).flat().forEach(r => r.author && s.add(String(r.author).toLowerCase()));
    return [...s].sort();
  }
  const replyCards = target => SUGG.filter(c => c.reply_to === target);

  // two-way threads: bot entries from threads.json + each user's decisions[id].thread,
  // merged chronologically; replies write only to the viewer's own file
  function mergedThread(id) {
    const out = [];
    for (const r of THREADS[id] || []) out.push({ author: r.author, ts: r.ts, text: r.text, edited: r.edited });
    for (const r of (store()[id] || {}).thread || []) out.push({ author: ME || 'you', ts: r.ts, text: r.text, mine: true, edited: r.edited });
    for (const [h, dec] of Object.entries(OTHERS)) {
      for (const r of (dec[id] || {}).thread || []) out.push({ author: h, ts: r.ts, text: r.text, edited: r.edited });
    }
    return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }
  const threadSel = id => `.thread[data-thread="${CSS.escape(id)}"]`;
  function threadHtml(id) {
    const replies = mergedThread(id);
    return '<div class="thread" data-thread="' + esc(id) + '">' + replies.map(r => {
      const bot = isBot(r.author);
      // own entries are editable/deletable in place; others' and bots' stay read-only
      const own = r.mine
        ? `<button class="rebtn" data-act="edit-reply" data-target="${esc(id)}" data-ts="${esc(r.ts)}" title="edit your reply">✎</button><button class="rebtn" data-act="del-reply" data-target="${esc(id)}" data-ts="${esc(r.ts)}" title="delete your reply">✕</button>`
        : '';
      return `<div class="reply${bot ? ' bot' : ''}${r.mine ? ' mine' : ''}" style="--author:${authorColor(r.author)}"><span class="who"><span class="author">${esc(r.author)}</span>${bot ? '<span class="badge bot-badge">bot reply</span>' : ''}${r.edited ? '<span class="edited">(edited)</span>' : ''}</span>${esc(r.text)}
       <button class="rebtn" data-act="reply" data-target="${esc(id)}">↩</button>${own}</div>`;
    }).join('') + activityHtml(id) +
      `<button class="rebtn thread-reply" data-act="reply" data-target="${esc(id)}">↩ reply</button></div>`;
  }
  function otherDecisionBadges(cardId) {
    let out = '';
    for (const [h, dec] of Object.entries(OTHERS)) {
      const v = dec[cardId];
      if (v && v.status && v.status !== 'user-comment') out += `<span class="badge">${esc(h)}: ${esc(v.status)}</span>`;
    }
    return out;
  }

  function cardHtml(c, dec) {
    const st = dec.status || 'pending';
    let body;
    if (c.type === 'old-todo') {
      body = `<div class="who"><span class="author">${esc(c.author)}</span><span class="badge type-badge">legacy note</span></div><div>${esc(c.text)}</div>`;
    } else if (c.type === 'user-comment') {
      // reopen semantics (GDocs resolved tab): the author always can; the paper
      // owner can reopen anyone's via the server (writes the author's file)
      const acts = c.mine
        ? `<div class="acts"><button data-act="edit" data-target="${esc(c.id)}">✎ edit</button><button data-act="resolve" data-target="${esc(c.id)}">${c.resolved ? '↩ reopen' : '✓ resolve'}</button></div>`
        : (c.resolved && IS_OWNER
          ? `<div class="acts"><button data-act="reopen-other" data-target="${esc(c.id)}" data-handle="${esc(c.author)}">↩ reopen</button></div>`
          : '');
      return `<div class="who"><span class="author">${esc(c.author)}</span><span class="badge type-badge">comment</span>${c.mine ? '' : ' <span class="badge">read-only</span>'}</div>
        ${c.quote || c.excerpt ? `<div class="why">on: “${esc(c.quote || c.excerpt)}”</div>` : ''}
        <div class="ctext">${esc(c.comment)}</div>${acts}${threadHtml(c.id)}
        ${replyCards(c.id).map(rc => `<div class="nested" style="--author:${authorColor(cardAuthors(rc)[0])}">${cardHtml(rc, store()[rc.id] || {})}</div>`).join('')}`;
    } else {
      const badges = [c.category, c.priority].filter(Boolean).map(esc).map(b => `<span class="badge">${b}</span>`).join('');
      body = `<div class="who"><span class="author">${esc(c.author || 'bot')}</span><span class="badge type-badge">${esc(c.type)}</span> ${badges}</div>
        ${c.anchor_text ? `<div class="why">at: “${esc(c.anchor_text)}”</div>` : ''}
        ${c.current_text ? `<div class="diff"><del>${esc(c.current_text)}</del> <ins>${esc(c.proposed_text)}</ins></div>` : `<div>${esc(c.text || c.proposed_text)}</div>`}
        ${c.rationale ? `<div class="why">${esc(c.rationale)}</div>` : ''}
        ${c.evidence ? `<div class="why">evidence: ${esc([].concat(c.evidence).join('; '))}</div>` : ''}
        ${c.bibtex_keys && c.bibtex_keys.length ? `<div class="keys">${c.bibtex_keys.map(esc).map(k => `<code>${k}</code>`).join(' ')}</div>` : ''}
        ${c.apply_notes ? `<div class="why">apply: ${esc(c.apply_notes)}</div>` : ''}`;
    }
    const t = esc(c.id);
    // P4 (owner-only): apply state + button for accepted span cards
    const ap = APPLY.applied[c.id], fl = APPLY.flagged[c.id];
    const applyBadge = ap ? `<span class="badge apply-badge">${ap.committed ? 'committed ' + esc(ap.committed) : 'applied, uncommitted'}</span>` : '';
    const applyBtn = IS_OWNER && !ap && st === 'accepted' && c.current_text
      ? `<button data-act="apply" data-target="${t}">⚡ apply</button>` : '';
    const flagged = fl ? `<div class="status-chip err">apply flagged: ${esc(fl.reason)}</div>` : '';
    return `${body}<div class="state">${st !== 'pending' ? st.toUpperCase() : ''}${applyBadge}</div>${otherDecisionBadges(c.id)}${flagged}
      <div class="acts">
        <button data-act="accepted" data-target="${t}">✓ accept</button>
        <button data-act="rejected" data-target="${t}">✗ reject</button>
        ${applyBtn}
        ${st !== 'pending' ? `<button data-act="pending" data-target="${t}">↺ reset</button>` : ''}
      </div>${threadHtml(c.id)}`;
  }

  // --- inline composer (no prompt/alert; save-as-you-type; never scrolls the page) ---
  let composerCount = 0;
  function openComposer(anchorInfo, existingId) {
    if (document.querySelector('.card.composing')) return;
    const id = existingId || `user-${anchorInfo.anchor}-${Date.now()}`;
    const div = document.createElement('div');
    div.className = 'card composing';
    div.dataset.id = id;
    const quoteLine = anchorInfo.quote ? `<div class="why">on: “${esc(anchorInfo.quote.slice(0, 120))}”</div>` : '';
    div.innerHTML = `<div class="who"><span class="author">${esc(ME || 'you')}</span></div>${quoteLine}
      <textarea placeholder="Comment… (saves as you type; esc to close)"></textarea>
      <div class="acts"><button data-act="done">done</button><button data-act="discard">discard</button></div>`;
    div.style.setProperty('--author', authorColor(ME || 'you'));
    margin.appendChild(div);
    // narrow viewport: the margin rail is a tap-to-open bottom sheet — open it
    // so the composer is actually visible (full-width, textarea + done in reach)
    const openedSheet = isNarrow() && !margin.classList.contains('sheet-open');
    if (isNarrow()) setSheet(true);
    const anchorEl = document.getElementById(id) || document.querySelector(`[data-cid="${anchorInfo.anchor}"]`);
    if (anchorEl) div.style.top = Math.max(anchorEl.getBoundingClientRect().top + window.scrollY - 60, 0) + 'px';
    const ta = div.querySelector('textarea');
    const existing = existingId ? store()[existingId] : null;
    if (existing) ta.value = existing.comment || '';
    let saveTimer = null;
    const persist = () => {
      const d = store();
      if (!ta.value.trim() && !existingId) return;
      d[id] = { ...(d[id] || {}), status: 'user-comment', comment: ta.value, section: slug, ...anchorInfo };
      save(d);
    };
    // save-as-you-type mirrors text only; @mentions fire exclusively on confirm (close below)
    ta.addEventListener('input', () => {
      clearTimeout(saveTimer); saveTimer = setTimeout(persist, 500);
    });
    const close = discard => {
      clearTimeout(saveTimer);
      if (discard) { const d = store(); delete d[id]; save(d); }
      else if (ta.value.trim()) { persist(); confirmMention(id, id, ta.value.trim()); }
      else if (!existingId) { const d = store(); delete d[id]; save(d); }
      if (openedSheet) setSheet(false);
      div.remove(); rerender();
    };
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(false); }
    });
    div.addEventListener('click', e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'done') close(false);
      if (act === 'discard') close(true);
    });
    ta.focus({ preventScroll: true });
    composerCount++;
  }

  // inline thread reply: appends {ts,text} to the viewer's own decisions[targetId].thread only
  function openReplyComposer(threadEl, targetId, afterEntry) {
    if (!threadEl || threadEl.querySelector('textarea')) return;
    const ts = new Date().toISOString();
    const box = document.createElement('div');
    box.className = 'reply mine composing';
    box.style.setProperty('--author', authorColor(ME || 'you'));
    box.innerHTML = `<span class="who"><span class="author">${esc(ME || 'you')}</span></span><textarea placeholder="Reply… (saves as you type; esc closes)"></textarea>
      <div class="acts"><button data-done="1">done</button></div>`;
    // per-entry ↩ inserts right under that entry; card-level reply goes to thread end
    if (afterEntry && afterEntry.parentNode === threadEl) afterEntry.after(box);
    else threadEl.appendChild(box);
    const ta = box.querySelector('textarea');
    let t = null;
    const persist = () => {
      const d = store(); d[targetId] = d[targetId] || {};
      const th = d[targetId].thread = d[targetId].thread || [];
      const cur = th.find(x => x.ts === ts);
      if (ta.value.trim()) { cur ? cur.text = ta.value : th.push({ ts, text: ta.value }); }
      else if (cur) th.splice(th.indexOf(cur), 1);
      save(d);
    };
    // save-as-you-type mirrors text only; @mentions fire exclusively on confirm (close below)
    ta.addEventListener('input', () => {
      clearTimeout(t); t = setTimeout(persist, 500);
    });
    const close = () => {
      clearTimeout(t); persist();
      const cur = ((store()[targetId] || {}).thread || []).find(x => x.ts === ts);
      if (cur && cur.text.trim()) confirmMention(targetId, `${targetId}:${ts}`, cur.text.trim());
      ta.blur(); box.remove(); // drop focus + composer first, or render()'s textarea guard skips the redraw
      pendingRender = false; rerender();
    };
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); close(); }
    });
    box.querySelector('[data-done]').addEventListener('click', ev => { ev.stopPropagation(); close(); });
    ta.focus({ preventScroll: true });
  }

  // edit one of the viewer's OWN thread entries in place. ts is the entry's
  // identity between browser and server file (the server's edited-stamping is
  // keyed on it), so edits keep ts and gain {edited, edited_ts}. Emptying the
  // text, or the delete button, removes the entry.
  function openReplyEditor(threadEl, targetId, ts, entryEl) {
    if (!threadEl || threadEl.querySelector('textarea')) return;
    const orig = (((store()[targetId] || {}).thread || []).find(x => x.ts === ts) || {}).text;
    if (orig == null) return;
    const box = document.createElement('div');
    box.className = 'reply mine composing';
    box.style.setProperty('--author', authorColor(ME || 'you'));
    box.innerHTML = `<span class="who"><span class="author">${esc(ME || 'you')}</span><span class="badge">editing</span></span>
      <textarea placeholder="Edit… (empty deletes; esc closes)"></textarea>
      <div class="acts"><button data-done="1">done</button><button data-del="1">delete</button></div>`;
    if (entryEl && entryEl.parentNode === threadEl) entryEl.replaceWith(box);
    else threadEl.appendChild(box);
    const ta = box.querySelector('textarea');
    ta.value = orig;
    let t = null;
    const persist = () => {
      const d = store();
      const cur = ((d[targetId] || {}).thread || []).find(x => x.ts === ts);
      if (!cur || !ta.value.trim() || ta.value === cur.text) return;
      cur.text = ta.value;
      if (ta.value !== orig) { cur.edited = true; cur.edited_ts = new Date().toISOString(); }
      save(d);
    };
    ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(persist, 500); });
    const close = del => {
      clearTimeout(t);
      if (del || !ta.value.trim()) {
        const d = store();
        const th = (d[targetId] || {}).thread || [];
        const i = th.findIndex(x => x.ts === ts);
        if (i >= 0) { th.splice(i, 1); save(d); }
      } else {
        persist();
        const cur = ((store()[targetId] || {}).thread || []).find(x => x.ts === ts);
        if (cur && cur.text.trim() !== String(orig).trim()) confirmMention(targetId, `${targetId}:${ts}`, cur.text.trim());
      }
      ta.blur(); box.remove();
      pendingRender = false; rerender();
    };
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(false); }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); close(false); }
    });
    box.querySelector('[data-done]').addEventListener('click', ev => { ev.stopPropagation(); close(false); });
    box.querySelector('[data-del]').addEventListener('click', ev => { ev.stopPropagation(); close(true); });
    ta.focus({ preventScroll: true });
  }

  // owner-only server write to the author's own file; resolved -> false,
  // status and thread untouched. The users/ watcher SSE refreshes peers.
  function reopenOther(id, handle) {
    api('/reopen', { method: 'POST', body: JSON.stringify({ id, handle }) })
      .then(r => r.json()).then(j => {
        if (!j.ok) { toast(`Reopen failed${j.reason ? ': ' + j.reason : ''} — the author can reopen it themselves.`, true); return; }
        return api('/data').then(r => r.json()).then(jj => { adoptData(jj); rerender(); });
      }).catch(() => toast('Reopen failed — is the server the current version? (restart it)', true));
  }

  // collapsed one-liner (focus mode default): author dot + name, status,
  // anchored-text excerpt, first words of the LATEST entry, and an explicit
  // "view thread ›" affordance — the rail reads as a scannable index
  function collapsedHtml(c, dec) {
    const th = mergedThread(c.id);
    const last = th[th.length - 1];
    const excerpt = String(c.quote || c.excerpt || c.anchor_text || c.current_text || '').slice(0, 60);
    const lastLine = String((last && last.text) || c.comment || c.text || c.proposed_text || '').split('\n')[0].slice(0, 70);
    const st = c.type === 'user-comment' ? (c.resolved ? 'resolved' : 'open') : (dec.status || 'pending');
    return `<div class="mini">
      <span class="dot"></span><span class="mini-author">${esc(cardAuthors(c)[0])}</span>
      <span class="badge st-${esc(st)}">${esc(st)}</span>${(ACTIVITY[c.id] || {}).working ? '<span class="spin">◐</span>' : ''}
      ${excerpt ? `<span class="mini-quote">“${esc(excerpt)}”</span>` : ''}
      ${lastLine ? `<span class="mini-last">${esc(lastLine)}</span>` : ''}
      <span class="mini-thread">view thread${th.length ? ` · ${th.length} repl${th.length === 1 ? 'y' : 'ies'}` : ''} ›</span>
    </div>`;
  }

  function render() {
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') { pendingRender = true; return; }
    // spotlight: while a thread is focused, everything else recedes (CSS)
    document.body.classList.toggle('spotlight', !!FOCUSED);
    // sheet chrome (narrow viewports): grab-handle + ✕, re-injected every render
    margin.innerHTML = '<div id="sheet-head"><span class="grab"></span><button id="sheet-close" title="close">✕</button></div>';
    const dcs = store();
    pageCards().forEach(c => {
      const dec = c.type === 'user-comment' ? {} : (dcs[c.id] || {});
      const div = document.createElement('div');
      const kind = c.type === 'user-comment' ? 'comment' : 'suggestion';
      const focused = c.id === FOCUSED;
      div.className = `card t-${kind} s-${c.type === 'user-comment' ? (c.mine ? 'mine' : 'theirs') : (dec.status || 'pending')} ${focused ? 'focused' : 'collapsed'}`;
      div.style.setProperty('--author', authorColor(cardAuthors(c)[0]));
      if ((ACTIVITY[c.id] || {}).working) div.classList.add('working');
      div.dataset.id = c.id;
      div.innerHTML = focused ? cardHtml(c, dec) : collapsedHtml(c, dec);
      margin.appendChild(div);
      div.addEventListener('click', e => {
        if (!focused) { e.stopPropagation(); activateCard(c.id); return; } // expand (accordion)
        const act = e.target.dataset && e.target.dataset.act;
        if (!act) { activateCard(c.id, true); return; }
        const target = e.target.dataset.target || c.id; // nested cards carry their own id
        if (act === 'reply') { openReplyComposer(e.target.closest('.thread'), target, e.target.closest('.reply')); return; }
        if (act === 'edit-reply') { openReplyEditor(e.target.closest('.thread'), target, e.target.dataset.ts, e.target.closest('.reply')); return; }
        if (act === 'del-reply') {
          const d = store(); const th = (d[target] || {}).thread || [];
          const i = th.findIndex(x => x.ts === e.target.dataset.ts);
          if (i >= 0) { th.splice(i, 1); save(d); rerender(); }
          return;
        }
        if (act === 'apply') { doApply([target]); return; }
        if (act === 'edit') {
          if (c.mine) { div.remove(); openComposer({ anchor: c.anchor, quote: c.quote, excerpt: c.excerpt }, c.id); }
          return;
        }
        if (act === 'resolve') {
          if (!c.mine) return;
          const d = store(); d[c.id].resolved = !d[c.id].resolved; save(d); rerender(); return;
        }
        if (act === 'reopen-other') { reopenOther(target, e.target.dataset.handle); return; }
        const d = store(); d[target] = d[target] || {};
        d[target].status = act === 'pending' ? undefined : act;
        save(d); rerender();
      });
    });
    unwrapTracked();   // restore pristine text before quote-wrapping scans it
    markCommented();
    wrapTracked();     // no-op when the sidebar toggle is off
    renderChips();
    renderProgress();
    renderApplyBar();
    renderMobile();
  }
  function rerender() { render(); position(); }

  // ---- inline tracked changes (GDocs suggesting mode): pending suggestion
  // cards whose current_text matches EXACTLY ONCE in this page's rendered text
  // render in the body as <del>(struck original)</del><ins>(proposal)</ins> in
  // the authoring agent's accent. Ambiguous or unlocatable spans stay margin-
  // only — placement is never guessed. Idempotent like markCommented: every
  // render unwraps and re-wraps.
  function unwrapTracked() {
    document.querySelectorAll('#paper ins.tc-ins').forEach(x => x.remove()); // generated text, not source
    document.querySelectorAll('#paper del.tc-del').forEach(m => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      m.remove(); p.normalize();
    });
  }
  function wrapTracked() {
    // matching is whitespace-tolerant (assets/span-match.js): cards carry
    // single-spaced current_text while rendered paragraphs wrap lines
    if (!inlineChanges || !window.SpanMatch) return;
    const d = store();
    const blocks = [...document.querySelectorAll('#paper [data-cid]')];
    for (const c of SUGG) {
      if (c.section !== slug || !c.current_text || APPLY.applied[c.id]) continue;
      const st = (d[c.id] || {}).status;
      if (st === 'rejected') continue; // margin card only
      let host = null, span = null, count = 0;
      for (const blk of blocks) {
        const spans = window.SpanMatch.findSpans(blk.textContent, c.current_text, 2);
        count += spans.length;
        if (spans.length && !host) { host = blk; span = spans[0]; }
        if (count > 1) break;
      }
      if (count !== 1 || !host) continue;
      wrapChange(host, c, span, st === 'accepted');
    }
  }
  function wrapChange(blockEl, c, span, accepted) {
    const idx = span.start, end = span.end;
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let pos = 0; const segs = [];
    while (walker.nextNode()) {
      const n = walker.currentNode, len = n.textContent.length;
      if (idx < pos + len && end > pos) {
        segs.push({ n, start: Math.max(idx - pos, 0), end: Math.min(end - pos, len) });
      }
      pos += len;
    }
    if (!segs.length) return;
    const color = authorColor(cardAuthors(c)[0]);
    const tip = accepted ? 'accepted — pending apply' : `suggested by ${c.author || 'bot'} — click to review`;
    let lastDel = null; // segs are wrapped in reverse, so the first wrapped is the final segment
    for (const { n, start, end } of segs.reverse()) {
      const r = document.createRange();
      r.setStart(n, start); r.setEnd(n, end);
      const del = document.createElement('del');
      del.className = 'tc-del' + (accepted ? ' tc-accepted' : '') + (c.id === FOCUSED ? ' focused' : '');
      del.dataset.tc = c.id;
      del.style.setProperty('--author', color);
      del.title = tip;
      try { r.surroundContents(del); } catch (e) { continue; }
      if (!lastDel) lastDel = del;
    }
    if (!lastDel) return;
    if (c.proposed_text) { // empty proposal = pure deletion, del alone suffices
      const ins = document.createElement('ins');
      ins.className = 'tc-ins' + (accepted ? ' tc-accepted' : '') + (c.id === FOCUSED ? ' focused' : '');
      ins.dataset.tc = c.id;
      ins.style.setProperty('--author', color);
      ins.title = tip;
      ins.textContent = c.proposed_text;
      lastDel.after(ins);
    }
  }

  // --- P4 sidebar: apply-all / commit / revert (owner) + hosted pending queue ---
  function doApply(ids, all) {
    (ids || []).forEach(id => chip(id, 'applying…'));
    api('/apply', { method: 'POST', body: JSON.stringify(all ? { all_accepted: true } : { ids }) })
      .then(r => r.json()).then(j => {
        if (j.apply) APPLY = j.apply;
        if (j.error) (ids || []).forEach(id => chip(id, j.error, true));
        (j.flagged || []).forEach(f => chip(f.id, 'apply flagged: ' + f.reason, true));
        (j.applied || []).forEach(id => chip(id, 'applied — rebuilding page…'));
        if (j.build_error) toast('Rebuild failed: ' + j.build_error, true);
        rerender(); // the rebuild's SSE 'site' event reloads the page with the new render
      }).catch(() => (ids || []).forEach(id => chip(id, 'apply failed — server unreachable', true)));
  }
  // persistent "Changes" widget (owner only): pinned at the TOP of the sidebar,
  // directly under the section list, so the accept → apply → commit/revert flow
  // is always in view; active states carry an accent edge (.attention)
  function renderApplyBar() {
    const foot = document.querySelector('.toc-foot');
    let bar = document.getElementById('apply-bar');
    if (!IS_OWNER) { bar?.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'apply-bar'; foot.parentNode.insertBefore(bar, foot); }
    const d = store();
    const applyable = Object.keys(d).filter(id => d[id].status === 'accepted' && !APPLY.applied[id] &&
      (SUGG.find(c => c.id === id) || {}).current_text);
    const round = APPLY.round;
    const roundFiles = new Set((round || {}).files || []);
    // source files dirty in git but not part of the open round: surfaced so
    // invisible working-tree state can't exist (needs the server-side field)
    const outOfBand = (SRC_DIRTY || []).filter(f => !roundFiles.has(f));
    bar.classList.toggle('attention', !!(applyable.length || round));
    let html = '<div class="chip-label">changes</div>';
    if (!round && !applyable.length) {
      html += lastCommit && Date.now() - lastCommit.t < 8000
        ? `<div class="chg-state ok fade">✓ committed ${esc(lastCommit.sha)}</div>`
        : `<div class="chg-state muted">none pending</div>
           <div class="chg-legend">accept → ⚡ apply → read → ✓ commit (or ↩ revert)</div>`;
    }
    if (applyable.length) html += `<div class="chg-state">${applyable.length} accepted, ready to apply</div>
        <button id="apply-all">⚡ Apply accepted (${applyable.length})</button>`;
    if (round) html += `<div class="chg-state">applied, uncommitted (${round.files.length} file${round.files.length === 1 ? '' : 's'})</div>
        <button id="commit-round">✓ Commit round (${round.ids.length} card${round.ids.length === 1 ? '' : 's'})</button>
        <button id="revert-round">↩ Revert round</button>`;
    if (outOfBand.length) html += `<div class="chg-oob">${outOfBand.length} uncommitted change${outOfBand.length === 1 ? '' : 's'} outside rounds: ${outOfBand.map(esc).join(', ')}
        <button id="commit-oob">✓ Commit ${outOfBand.length === 1 ? 'it' : 'them'}</button></div>`;
    html += HOSTED_MODE && PENDING_M.length ? `<button id="release-pending">▶ Release ${PENDING_M.length} queued mention${PENDING_M.length === 1 ? '' : 's'}</button>` : '';
    bar.innerHTML = html;
    bar.querySelector('#apply-all')?.addEventListener('click', () => doApply(applyable, true));
    bar.querySelector('#commit-round')?.addEventListener('click', () =>
      api('/commit', { method: 'POST', body: '{}' }).then(r => r.json()).then(j => {
        if (j.apply) APPLY = j.apply;
        if (j.ok) { lastCommit = { sha: j.sha, t: Date.now() }; setTimeout(rerender, 8500); }
        toast(j.ok ? `Committed ${j.sha}: ${j.ids.join(', ')}` : j.reason, !j.ok);
        rerender();
      }));
    bar.querySelector('#revert-round')?.addEventListener('click', () =>
      api('/revert', { method: 'POST', body: '{}' }).then(r => r.json()).then(j => {
        if (j.apply) APPLY = j.apply;
        toast(j.ok ? `Reverted: ${j.ids.join(', ')}` : j.reason, !j.ok);
        rerender();
      }));
    // out-of-band commit: only reachable when the server sent source_dirty,
    // i.e. a server new enough to understand /commit {files} (never a round commit)
    bar.querySelector('#commit-oob')?.addEventListener('click', () =>
      api('/commit', { method: 'POST', body: JSON.stringify({ files: outOfBand }) }).then(r => r.json()).then(j => {
        if (j.apply) APPLY = j.apply;
        if (j.ok) {
          lastCommit = { sha: j.sha, t: Date.now() }; setTimeout(rerender, 8500);
          SRC_DIRTY = (SRC_DIRTY || []).filter(f => !(j.files || outOfBand).includes(f));
        }
        toast(j.ok ? `Committed ${j.sha} (out-of-band): ${(j.files || outOfBand).join(', ')}` : (j.reason || 'commit failed'), !j.ok);
        rerender();
      }).catch(() => toast('Commit failed — server unreachable', true)));
    bar.querySelector('#release-pending')?.addEventListener('click', () =>
      api('/release', { method: 'POST', body: '{}' }).then(r => r.json()).then(j => {
        toast(`Released ${j.released} queued mention(s) to the agents.`);
        PENDING_M = []; rerender();
      }));
  }
  // hosted first visit: pick the handle this browser writes as (users/<handle>.json)
  function renderHandlePicker() {
    const foot = document.querySelector('.toc-foot');
    const box = document.createElement('div');
    box.id = 'handle-picker';
    box.innerHTML = `<div class="chip-label">who are you?</div>
      <input placeholder="your handle (e.g. ada)" maxlength="40">
      <button>join the review</button>`;
    foot.insertBefore(box, foot.firstChild);
    const inp = box.querySelector('input');
    box.querySelector('button').addEventListener('click', () => {
      const h = inp.value.toLowerCase().replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '');
      if (!h) { inp.focus(); return; }
      localStorage.setItem(HKEY, h);
      location.reload();
    });
    inp.focus({ preventScroll: true });
  }

  // author-filter chips render in the sidebar AND inside the mobile drawer;
  // both share the same markup + toggle so the filter stays one piece of state
  const chipsHtml = () => {
    const parts = ['all', ...participants()];
    return '<div class="chip-label">show authors</div>' +
      parts.map(p => `<button class="chip${authorFilter.has(p) ? ' on' : ''}" data-p="${esc(p)}" style="--author:${p === 'all' ? 'var(--accent)' : authorColor(p)}"><span class="dot"></span>${esc(p)}</button>`).join('');
  };
  function toggleAuthorChip(p) {
    if (p === 'all') authorFilter = new Set(['all']);
    else {
      authorFilter.delete('all');
      authorFilter.has(p) ? authorFilter.delete(p) : authorFilter.add(p);
      if (!authorFilter.size) authorFilter = new Set(['all']);
    }
    saveFilter(); rerender();
  }
  function renderChips() {
    const foot = document.querySelector('.toc-foot');
    let bar = document.getElementById('author-chips');
    if (!bar) { bar = document.createElement('div'); bar.id = 'author-chips'; foot.insertBefore(bar, foot.firstChild); }
    bar.innerHTML = chipsHtml();
    bar.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => toggleAuthorChip(b.dataset.p)));
  }

  function position() {
    let cursor = 72; // clear the avatar pill: no card starts under it at scroll-top
    pageCards().forEach(c => {
      const el = document.querySelector(`.card[data-id="${c.id}"]`);
      if (!el) return;
      const anchor = document.getElementById(c.id)
        || document.querySelector(`mark.user-hl[data-card-id="${c.id}"]`)
        || document.querySelector(`[data-cid="${c.anchor}"]`);
      const top = anchor ? anchor.getBoundingClientRect().top + window.scrollY - 60 : cursor;
      el.style.top = Math.max(top, cursor) + 'px';
      cursor = Math.max(top, cursor) + el.offsetHeight + 10;
    });
  }

  // focus a thread: expands its card (collapsing any other), highlights its
  // body anchor, and on narrow viewports opens the bottom sheet on it
  function setFocus(id) {
    FOCUSED = id || null;
    if (FOCUSED) localStorage.setItem(FOKEY, FOCUSED); else localStorage.removeItem(FOKEY);
    rerender();
  }
  function activateCard(id, fromCard) {
    if (FOCUSED !== id) setFocus(id); // rerenders: this card expanded, others collapsed
    if (isNarrow() && !fromCard) setSheet(true); // narrow rail: bottom-sheet on the thread
    if (fromCard) {
      // re-query AFTER the focus rerender — marks are rebuilt by markCommented
      const a = document.getElementById(id) || document.querySelector(`mark.user-hl[data-card-id="${CSS.escape(id)}"]`);
      if (a) a.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function wrapQuote(blockEl, quote, id) {
    const idx = blockEl.textContent.indexOf(quote);
    if (idx < 0) return false;
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let pos = 0; const segs = [];
    while (walker.nextNode()) {
      const n = walker.currentNode, len = n.textContent.length;
      if (idx < pos + len && idx + quote.length > pos) {
        segs.push({ n, start: Math.max(idx - pos, 0), end: Math.min(idx + quote.length - pos, len) });
      }
      pos += len;
    }
    for (const { n, start, end } of segs.reverse()) {
      const r = document.createRange();
      r.setStart(n, start); r.setEnd(n, end);
      const m = document.createElement('mark');
      m.className = 'user-hl'; m.dataset.cardId = id;
      try { r.surroundContents(m); } catch (e) { }
    }
    return segs.length > 0;
  }

  function markCommented() {
    document.querySelectorAll('mark.user-hl').forEach(m => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      m.remove(); p.normalize();
    });
    document.querySelectorAll('.has-comment, .has-card, .focused-anchor').forEach(el => el.classList.remove('has-comment', 'has-card', 'focused-anchor'));
    pageCards().forEach(c => {
      const focused = c.id === FOCUSED; // the focused thread's body anchor gets a stronger tint
      if (c.type === 'user-comment') {
        const el = document.querySelector(`[data-cid="${c.anchor}"]`);
        if (!el) return;
        if (c.quote && wrapQuote(el, c.quote, c.id)) {
          document.querySelectorAll(`mark.user-hl[data-card-id="${CSS.escape(c.id)}"]`).forEach(mk => {
            mk.style.setProperty('--author', authorColor(c.author));
            if (!c.mine) mk.classList.add('theirs');
            if (focused) mk.classList.add('focused');
          });
          el.dataset.cardId = el.dataset.cardId || c.id;
          return;
        }
        el.classList.add('has-comment'); el.dataset.cardId = c.id;
        if (focused) el.classList.add('focused-anchor');
      } else {
        const a = document.getElementById(c.id);
        const blk = a && a.closest('p, figure, li, h1, h2, h3');
        if (blk) {
          blk.classList.add('has-card');
          if (!blk.dataset.cardId) blk.dataset.cardId = c.id;
          if (focused) blk.classList.add('focused-anchor');
        }
      }
    });
  }

  // --- selection -> comment ---
  // shared: the current selection as anchor info, or null when it isn't a
  // usable in-paper selection
  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim() || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const blk = (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-cid]');
    if (!blk) return null;
    return { anchor: blk.dataset.cid, quote: sel.toString(), excerpt: sel.toString().slice(0, 100), range };
  }
  let pending = null;
  // desktop: floating popover near the selection (mouseup, unchanged behavior)
  const pop = document.createElement('button');
  pop.id = 'sel-pop'; pop.textContent = '💬 Comment'; pop.hidden = true;
  document.body.appendChild(pop);
  document.addEventListener('mouseup', e => {
    if (e.target === pop) return;
    setTimeout(() => {
      if (isNarrow()) return; // narrow viewports use the bottom pill below
      const info = currentSelection();
      if (!info) { pop.hidden = true; return; }
      pending = { anchor: info.anchor, quote: info.quote, excerpt: info.excerpt };
      const r = info.range.getBoundingClientRect();
      pop.style.left = Math.max(r.left + r.width / 2 - 45, 8) + 'px';
      pop.style.top = (r.top - 38) + 'px';
      pop.hidden = false;
    }, 0);
  });
  pop.addEventListener('mousedown', e => e.preventDefault());
  pop.addEventListener('click', () => {
    pop.hidden = true;
    if (pending) openComposer(pending);
    pending = null;
  });
  // touch: iOS/Android selection handles fire no mouseup, and the native
  // callout obscures floating buttons near the selection — so narrow viewports
  // get a fixed bottom pill instead, driven by selectionchange (debounced) +
  // touchend. It hides itself the moment the selection collapses.
  const selPill = document.createElement('button');
  selPill.id = 'sel-pill'; selPill.textContent = '💬 Comment on selection'; selPill.hidden = true;
  document.body.appendChild(selPill);
  let selTimer = null;
  function updateSelPill() {
    const info = isNarrow() ? currentSelection() : null;
    if (!info) { selPill.hidden = true; return; }
    pending = { anchor: info.anchor, quote: info.quote, excerpt: info.excerpt };
    selPill.hidden = false;
  }
  const selSoon = () => { clearTimeout(selTimer); selTimer = setTimeout(updateSelPill, 300); };
  document.addEventListener('selectionchange', selSoon);
  document.addEventListener('touchend', selSoon, { passive: true });
  selPill.addEventListener('click', () => {
    selPill.hidden = true;
    if (pending) openComposer(pending);
    pending = null;
  });

  // ---- tracked-change popover: click an inline del/ins -> author + rationale +
  // accept / reject / open card. Decisions write the SAME store entry as the
  // margin-card buttons (single source of truth). No dialogs.
  const tcPop = document.createElement('div');
  tcPop.id = 'tc-pop'; tcPop.hidden = true;
  document.body.appendChild(tcPop);
  function showTcPop(id, x, y) {
    const c = SUGG.find(s => s.id === id);
    if (!c) return;
    const st = (store()[id] || {}).status;
    const rat = String(c.rationale || '').split('\n')[0].slice(0, 140);
    tcPop.innerHTML = `<div class="who" style="--author:${authorColor(cardAuthors(c)[0])}"><span class="author">${esc(c.author || 'bot')}</span>${st ? `<span class="badge">${esc(st)}</span>` : ''}</div>
      ${rat ? `<div class="why">${esc(rat)}</div>` : ''}
      <div class="acts"><button data-tcact="accepted">✓ accept</button><button data-tcact="rejected">✗ reject</button><button data-tcact="card">open card</button></div>`;
    tcPop.dataset.id = id;
    tcPop.style.left = Math.max(Math.min(x, window.innerWidth - 280), 8) + 'px';
    tcPop.style.top = Math.min(y + 8, window.innerHeight - 120) + 'px';
    tcPop.hidden = false;
  }
  document.addEventListener('click', e => {
    const btn = e.target.closest('#tc-pop [data-tcact]');
    if (btn) {
      const id = tcPop.dataset.id;
      tcPop.hidden = true;
      if (btn.dataset.tcact === 'card') {
        activateCard(id); // focuses (rerenders); query the fresh card node after
        const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        const d = store(); d[id] = d[id] || {};
        d[id].status = btn.dataset.tcact;
        save(d); rerender();
      }
      return;
    }
    if (e.target.closest('#tc-pop')) return;
    const t = e.target.closest('del.tc-del, ins.tc-ins');
    if (t && t.dataset.tc) {
      const r = t.getBoundingClientRect();
      showTcPop(t.dataset.tc, r.left, r.bottom);
      return;
    }
    tcPop.hidden = true;
  });
  window.addEventListener('scroll', () => { pop.hidden = true; tcPop.hidden = true; }, { passive: true });

  // ---- mobile comments overview: a fixed "💬 N open" FAB (narrow viewports
  // only, CSS-gated) opening an 85vh bottom-sheet drawer that lists every
  // thread on this section — author accent, anchored-text excerpt, first line,
  // reply count, live working indicator — plus the author filter chips, a
  // resolved section (reopen works), and per-section open counts for
  // cross-section review. Tapping an entry closes the drawer and lands on the
  // highlight with its thread open (the existing tap-a-highlight flow).
  const fab = document.createElement('button');
  fab.id = 'mob-fab';
  const drawer = document.createElement('div');
  drawer.id = 'mob-drawer'; drawer.hidden = true;
  document.body.append(fab, drawer);
  fab.addEventListener('click', openDrawer);
  function sectionCounts() { // open items per section, across the whole paper
    const counts = {};
    const bump = s => { if (s) counts[s] = (counts[s] || 0) + 1; };
    SUGG.filter(c => !c.reply_to && !c.resolved).forEach(c => bump(c.section));
    Object.values(store()).forEach(v => { if (v.status === 'user-comment' && !v.resolved) bump(v.section); });
    Object.values(OTHERS).forEach(dec => Object.values(dec).forEach(v => { if (v.status === 'user-comment' && !v.resolved) bump(v.section); }));
    return counts;
  }
  function drawerEntry(c) {
    const th = mergedThread(c.id);
    const excerpt = String(c.quote || c.excerpt || c.anchor_text || c.current_text || '').slice(0, 80);
    const first = String(c.comment || c.text || c.proposed_text || '').split('\n')[0].slice(0, 100);
    const working = (ACTIVITY[c.id] || {}).working || PRESENCE.tid === c.id;
    const reopenBtn = c.resolved && (c.mine || IS_OWNER)
      ? `<button class="rebtn" data-mob-reopen="${esc(c.id)}" data-mine="${c.mine ? '1' : ''}" data-handle="${esc(c.author)}">↩ reopen</button>` : '';
    return `<div class="mob-entry" data-mob-id="${esc(c.id)}" style="--author:${authorColor(cardAuthors(c)[0])}">
      <span class="dot"></span>
      <div class="mob-body">
        <div class="mob-meta">${esc(c.author || 'bot')}${working ? ' · <span class="spin">◐</span> working' : ''}</div>
        ${excerpt ? `<div class="mob-quote">“${esc(excerpt)}”</div>` : ''}
        ${first ? `<div class="mob-first">${esc(first)}</div>` : ''}
        <div class="mob-thread-link">view thread${th.length ? ` · ${th.length} repl${th.length === 1 ? 'y' : 'ies'}` : ''} ›</div>
      </div>${reopenBtn}</div>`;
  }
  function renderDrawer() {
    const open = allCards(false), res = allCards(true);
    const counts = sectionCounts();
    const navLinks = [...document.querySelectorAll('nav.toc a[data-slug]')].map(a => {
      const s = a.dataset.slug, n = counts[s] || 0;
      return n ? `<a href="${esc(a.getAttribute('href'))}"${s === slug ? ' data-current="1"' : ''}>${esc(a.textContent.trim())} ${n}</a>` : '';
    }).filter(Boolean).join(' · ');
    drawer.innerHTML = `<div class="grab"></div><div class="mob-head">💬 ${open.length} open on this section<button id="mob-close" title="close">✕</button></div>
      ${navLinks ? `<div class="mob-nav">${navLinks}</div>` : ''}
      <div class="mob-chips">${chipsHtml()}</div>
      <div class="mob-list">${open.map(drawerEntry).join('') || '<div class="mob-empty">no open comments on this section</div>'}</div>
      ${res.length ? `<div class="mob-res-head">resolved (${res.length})</div><div class="mob-list">${res.map(drawerEntry).join('')}</div>` : ''}`;
  }
  drawer.addEventListener('click', e => {
    if (e.target.id === 'mob-close') { closeDrawer(); return; }
    const chipBtn = e.target.closest('.chip[data-p]');
    if (chipBtn) { toggleAuthorChip(chipBtn.dataset.p); renderDrawer(); return; }
    const ro = e.target.closest('[data-mob-reopen]');
    if (ro) {
      const id = ro.dataset.mobReopen;
      if (ro.dataset.mine) { const d = store(); if (d[id]) { d[id].resolved = false; save(d); rerender(); } }
      else reopenOther(id, ro.dataset.handle);
      renderDrawer(); return;
    }
    const entry = e.target.closest('[data-mob-id]');
    if (entry) {
      const id = entry.dataset.mobId;
      closeDrawer();
      activateCard(id); // focuses the thread; narrow: opens the bottom-sheet on it
      const c = [...allCards(false), ...allCards(true)].find(x => x.id === id) || {};
      const a = document.getElementById(id)
        || document.querySelector(`mark.user-hl[data-card-id="${CSS.escape(id)}"]`)
        || (c.anchor && document.querySelector(`[data-cid="${CSS.escape(c.anchor)}"]`));
      if (a) a.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  function renderMobile() {
    fab.textContent = `💬 ${allCards(false).length} open`;
    if (!drawer.hidden) renderDrawer();
  }

  // --- dismissal chrome: every sheet/drawer closes via ✕, dimmed-backdrop tap,
  // swipe-down on the grab handle, and Esc — the sheet-open state can never
  // trap the user. Esc (and outside-click) also collapses the focused thread.
  const backdrop = document.createElement('div');
  backdrop.id = 'backdrop'; backdrop.hidden = true;
  document.body.appendChild(backdrop);
  const syncBackdrop = () => { backdrop.hidden = !(margin.classList.contains('sheet-open') || !drawer.hidden); };
  function setSheet(open) { margin.classList.toggle('sheet-open', open); syncBackdrop(); }
  function openDrawer() { renderDrawer(); drawer.hidden = false; syncBackdrop(); }
  function closeDrawer() { drawer.hidden = true; syncBackdrop(); }
  backdrop.addEventListener('click', () => { setSheet(false); closeDrawer(); });
  margin.addEventListener('click', e => { if (e.target.id === 'sheet-close') { e.stopPropagation(); setSheet(false); } });
  function swipeDownClose(container, zoneSel, close) {
    let y0 = null;
    container.addEventListener('touchstart', e => {
      y0 = e.target.closest(zoneSel) ? e.touches[0].clientY : null;
    }, { passive: true });
    container.addEventListener('touchmove', e => {
      if (y0 != null && e.touches[0].clientY - y0 > 60) { y0 = null; close(); }
    }, { passive: true });
  }
  swipeDownClose(margin, '#sheet-head', () => setSheet(false));
  swipeDownClose(drawer, '.mob-head, .grab', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || (e.target && e.target.tagName === 'TEXTAREA')) return; // composers own their Esc
    if (!drawer.hidden) { closeDrawer(); return; }
    if (margin.classList.contains('sheet-open')) { setSheet(false); return; }
    if (FOCUSED) setFocus(null);
  });
  // clicking outside the rail (and outside the sidebar controls / overlays /
  // anchored blocks) collapses the focused thread back into the stack
  document.addEventListener('click', e => {
    if (!FOCUSED) return;
    if (e.target.closest('#margin, mark.user-hl, nav.toc, #sel-pop, #sel-pill, #tc-pop, #mob-drawer, #mob-fab, #backdrop, #avatars, #toasts, .perm-card')) return;
    const blk = e.target.closest('[data-cid]');
    if (blk && blk.dataset.cardId) return; // anchored block: its own handler re-focuses
    setFocus(null);
  });

  // --- progress + sidebar controls ---
  function renderProgress() {
    const d = store();
    const sugg = SUGG.filter(c => c.section === slug && !c.reply_to);
    const done = sugg.filter(c => d[c.id] && d[c.id].status).length;
    const resolved = ownComments().filter(c => c.resolved).length +
      otherComments().filter(c => c.resolved).length;
    const el = document.getElementById('progress');
    if (el) el.innerHTML = `${done}/${sugg.length} decided on this page` +
      `<br><a href="#" id="resolved-toggle">${showResolved ? '← back to open items' : `resolved (${resolved})`}</a>`;
    const t = document.getElementById('resolved-toggle');
    if (t) t.addEventListener('click', e => { e.preventDefault(); showResolved = !showResolved; rerender(); });
  }

  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), build: META, decisions: store() }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `decisions-${META.slug || 'doc'}.json`;
    a.click();
  });

  const foot = document.querySelector('.toc-foot');
  // import bridge (e.g. comments made in the file:// view)
  const imp = document.createElement('button');
  imp.id = 'import-btn'; imp.textContent = 'Import decisions';
  imp.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.addEventListener('change', () => {
      const f = inp.files[0];
      if (!f) return;
      f.text().then(t => {
        try {
          const j = JSON.parse(t);
          const d = store(); let added = 0;
          for (const [id, v] of Object.entries(j.decisions || {})) if (!(id in d)) { d[id] = v; added++; }
          save(d); rerender();
          imp.textContent = `✓ imported ${added}`;
          setTimeout(() => imp.textContent = 'Import decisions', 3000);
        } catch { imp.textContent = '✗ not a decisions file'; setTimeout(() => imp.textContent = 'Import decisions', 3000); }
      });
    });
    inp.click();
  });
  foot.appendChild(imp);

  // theme control: compact segmented icon control (sun / auto / moon), inline
  // SVG only — quiet, labeled for screen readers, persisted per browser
  const THEME_ICONS = {
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8"/></svg>',
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a7 7 0 0 0 10 10Z"/></svg>',
  };
  const themeBar = document.createElement('div');
  themeBar.id = 'theme-toggle';
  const renderTheme = () => {
    const cur = localStorage.getItem(THEME_KEY) || 'system';
    themeBar.innerHTML = '<div class="chip-label">theme</div><div class="seg" role="group" aria-label="theme">' +
      ['light', 'system', 'dark'].map(m =>
        `<button class="seg-btn${m === cur ? ' on' : ''}" data-theme-opt="${m}" title="${m} theme" aria-label="${m} theme" aria-pressed="${m === cur}">${THEME_ICONS[m]}</button>`).join('') +
      '</div>';
  };
  themeBar.addEventListener('click', e => {
    const b = e.target.closest('[data-theme-opt]');
    if (!b) return;
    localStorage.setItem(THEME_KEY, b.dataset.themeOpt);
    applyTheme(b.dataset.themeOpt);
    renderTheme();
  });
  renderTheme();
  foot.appendChild(themeBar);

  // inline tracked-changes toggle (viewer-local; heavy rounds can get noisy)
  const tcBar = document.createElement('div');
  tcBar.id = 'tc-toggle';
  const renderTcToggle = () => {
    tcBar.innerHTML = '<div class="chip-label">inline changes</div>' + ['on', 'off'].map(m =>
      `<button class="chip${(inlineChanges ? 'on' : 'off') === m ? ' on' : ''}" data-tc-opt="${m}">${m}</button>`).join('');
  };
  tcBar.addEventListener('click', e => {
    const b = e.target.closest('[data-tc-opt]');
    if (!b) return;
    inlineChanges = b.dataset.tcOpt === 'on';
    localStorage.setItem(TKEY, inlineChanges ? '1' : '0');
    renderTcToggle(); rerender();
  });
  renderTcToggle();
  foot.appendChild(tcBar);

  // GDocs-style collaborator cluster: pill-chromed, top-right on every page
  // (idle avatars offline too); container stays generic so human collaborators
  // can join it later
  const av = document.createElement('div');
  av.id = 'avatars';
  document.body.appendChild(av);
  av.addEventListener('click', e => { if (e.target.closest('.avatar-ring.working')) jumpToActive(); });
  renderPresence();

  if (LIVE) {
    const flag = document.createElement('button');
    flag.id = 'flag-btn'; flag.textContent = '🚩 Flag for agents';
    flag.title = 'Saves your comments to disk for Claude & Codex to read on their next turn';
    flag.addEventListener('click', () => {
      api('/summon', { method: 'POST', body: JSON.stringify({ section: slug, handle: ME }) })
        .then(() => { pushState(); flag.textContent = '✓ Saved for the agents’ next turn'; setTimeout(() => flag.textContent = '🚩 Flag for agents', 4000); })
        .catch(() => { flag.textContent = '✗ server unreachable'; setTimeout(() => flag.textContent = '🚩 Flag for agents', 3000); });
    });
    const strip = document.createElement('div');
    strip.id = 'presence';
    foot.appendChild(flag); foot.appendChild(strip);
    renderPresence();

    // boot: adopt own server-side state this browser lacks, load others/threads, then push
    api('/data').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(j => {
      adoptData(j);
      if (HOSTED_MODE && !ME) { renderHandlePicker(); return; }
      const d = store(); let added = 0;
      const mine = (j.users || {})[j.me] || {};
      for (const [id, v] of Object.entries(mine)) if (!(id in d)) { d[id] = v; added++; }
      if (added) setStore(d);
      syncState = 'ok'; serverDead = false; renderPresence();
      rerender(); pushState();
    }).catch(() => {
      syncState = 'err'; serverDead = true; renderPresence();
    });

    // live transport: WebSocket first, SSE fallback. WS is primary because
    // proxies/CDN edges (the --share cloudflared tunnel included) buffer
    // streamed HTTP bodies — SSE headers arrive but no events ever do —
    // while WebSocket upgrades are proxied unbuffered.
    let refetching = false;
    const liveUp = () => { if (sseDown || serverDead) { sseDown = false; serverDead = false; renderPresence(); } };
    const liveMsg = data => {
      liveUp();
      let msg; try { msg = JSON.parse(data); } catch { return; }
      const type = msg.type;
      if (type === 'ping') return;
      if (type === 'chat') { chatEvent(msg); return; }
      if (type === 'site') { location.reload(); return; }
      if (type !== 'state' || refetching) return;
      refetching = true;
      api('/data').then(r => r.json()).then(j => { adoptData(j); rerender(); })
        .finally(() => { refetching = false; });
    };
    const liveDown = () => { sseDown = true; renderPresence(); probeServer(); };
    let wsRetryMs = 2000;
    function connectSSE() {
      const es = new EventSource('/events'); // reconnects on its own
      es.onopen = liveUp;
      es.onerror = liveDown;
      es.onmessage = ev => liveMsg(ev.data);
    }
    function connectLive() {
      let sock;
      try {
        sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      } catch { connectSSE(); return; }
      let opened = false;
      sock.onopen = () => { opened = true; wsRetryMs = 2000; liveUp(); };
      sock.onmessage = ev => liveMsg(ev.data);
      sock.onerror = () => { };
      sock.onclose = () => {
        // never got open: something between us and the server blocks WS
        // (or an old server without /ws) — fall back to SSE for good
        if (!opened) { connectSSE(); return; }
        liveDown();
        setTimeout(connectLive, wsRetryMs);
        wsRetryMs = Math.min(wsRetryMs * 2, 15000);
      };
    }
    connectLive();
    // deferred re-render after typing finishes
    document.addEventListener('focusout', () => {
      if (pendingRender) { pendingRender = false; setTimeout(rerender, 100); }
    });
  }

  // ---- P3 chat: mentions -> turns, inline thread activity. Margin threads are
  // the only conversation surface (the standalone chat panel was removed) ----
  const MENTION_RE = /@(claude|codex|all)\b/i;
  // mentions fire ONLY on explicit confirm (done / ⌘⏎ / close-with-save), never on
  // input/change/paste while composing; an edit-then-reconfirm retriggers with a
  // new content hash, never a duplicate id
  const mentionSent = {};
  const djb2 = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
  function confirmMention(targetId, entryKey, text) {
    if (!text || !MENTION_RE.test(text) || mentionSent[entryKey] === text) return;
    mentionSent[entryKey] = text;
    // deterministic content hash: reload-stable, edits retrigger, resends dedupe server-side
    maybeMention(targetId, text, `${entryKey}:${djb2(text.trim())}`);
  }

  // per-card turn activity (queued / working / streaming text / interrupts) renders
  // INSIDE the thread under the user's comment — the margin thread is the primary
  // bot surface; activity survives rerenders because threadHtml re-injects it
  const ACTIVITY = {};
  const activityOf = id => (ACTIVITY[id] = ACTIVITY[id] || { streams: {} });
  let posTimer = null;
  const positionSoon = () => { clearTimeout(posTimer); posTimer = setTimeout(position, 120); };
  const permHtml = ev => `<div class="perm-card"><div class="who">permission request — ${esc(ev.model || 'agent')}</div>
      <div>${esc(ev.reason || '')}<br><code>${esc(ev.path || '')}</code></div>
      <button class="allow" data-perm="allow">allow</button><button data-perm="deny">deny</button></div>`;
  const choiceHtml = ev => `<div class="perm-card choice-card"><div class="who">agents ask — ${esc(ev.prompt || 'choose an option')}</div>` +
    (ev.options || []).map((o, i) => `<button data-choice="${i}">${esc(o)}</button>`).join('') +
    `<button class="deny" data-choice="-1">dismiss</button></div>`;
  function activityHtml(id) {
    const a = ACTIVITY[id];
    if (!a) return '';
    let h = '';
    for (const [key, s] of Object.entries(a.streams))
      h += `<div class="reply bot streaming" data-stream-key="${esc(key)}" style="--author:${authorColor(s.who)}"><span class="who"><span class="author">${esc(s.who)}</span><span class="badge bot-badge">writing…</span></span><pre class="stream-text">${esc(s.text)}</pre></div>`;
    if (a.perm) h += permHtml(a.perm);
    if (a.choice) h += choiceHtml(a.choice);
    if (a.msg) h += `<div class="status-chip${a.err ? ' err' : ''}">${a.msg}</div>`;
    return h;
  }
  function syncActivity(id) {
    const th = document.querySelector(threadSel(id));
    if (!th) return;
    th.querySelectorAll(':scope > .streaming, :scope > .status-chip, :scope > .perm-card').forEach(x => x.remove());
    const btn = th.querySelector(':scope > .thread-reply');
    if (btn) btn.insertAdjacentHTML('beforebegin', activityHtml(id));
    const card = th.closest('.card');
    if (card) card.classList.toggle('working', !!(ACTIVITY[id] || {}).working);
    positionSoon();
  }
  function chip(cardId, text, err) {
    const a = activityOf(cardId);
    a.msg = text; a.err = !!err;
    a.working = !err && /queued|working|sending|landing|writing/i.test(text || '');
    if (!text && !Object.keys(a.streams).length && !a.perm && !a.choice) delete ACTIVITY[cardId];
    syncActivity(cardId);
    // collapsed cards have no .thread for syncActivity to hit: toggle their glow directly
    const mini = document.querySelector(`.card.collapsed[data-id="${CSS.escape(cardId)}"]`);
    if (mini) { mini.classList.toggle('working', !!(ACTIVITY[cardId] || {}).working); positionSoon(); }
  }
  function maybeMention(targetId, text, mentionId) {
    if (!LIVE || !MENTION_RE.test(text)) return;
    chip(targetId, 'sending to agents…');
    api('/mention', { method: 'POST', body: JSON.stringify({ mention_id: mentionId, target_id: targetId, text }) })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (r.status === 409) { setChatMode(false); chip(targetId, 'server not started with --chat', true); toast('Restart the server as: node review/server.mjs --chat', true); return; }
        // hosted guest: the summons sits in the owner's approval queue — say so honestly
        if (j.pending) { chip(targetId, `queued — waiting for ${esc(OWNER_HANDLE || 'the owner')} to approve`); return; }
        if (!r.ok || j.queued === false) { chip(targetId, `mention rejected${j.reason ? ': ' + j.reason : ''}`, true); return; }
        chip(targetId, `queued${j.position > 1 ? ' (#' + j.position + ')' : ''} — waiting for agents`);
      })
      .catch(() => chip(targetId, 'server unreachable', true));
  }
  // NO chat panel: the margin threads + anchored mentions are the ONLY
  // conversation surface. System status and unanchored/off-page permission or
  // choice interrupts render as small dismissible cards pinned above the
  // presence strip in the sidebar.
  function toastBox() {
    let box = document.getElementById('toasts');
    if (!box) {
      const strip = document.getElementById('presence');
      if (!strip) return null;
      box = document.createElement('div');
      box.id = 'toasts';
      strip.before(box);
    }
    return box;
  }
  function toast(text, err) {
    const box = toastBox();
    if (!box) return;
    const d = document.createElement('div');
    d.className = 'toast' + (err ? ' err' : '');
    const span = document.createElement('span');
    span.textContent = text;
    const x = document.createElement('button');
    x.className = 'toast-x'; x.title = 'dismiss'; x.textContent = '✕';
    x.addEventListener('click', () => d.remove());
    d.append(span, x);
    box.appendChild(d);
    while (box.children.length > 4) box.firstChild.remove();
    if (!err) setTimeout(() => d.remove(), 12000);
  }
  const interruptToast = html => { const box = toastBox(); if (box) box.insertAdjacentHTML('beforeend', html); };
  // permission / choice answers, wherever the card rendered (thread or sidebar toast)
  document.addEventListener('click', e => {
    const pb = e.target.closest('[data-perm]');
    const cb = e.target.closest('[data-choice]');
    if (!pb && !cb) return;
    e.stopPropagation();
    if (pb) api('/permission', { method: 'POST', body: JSON.stringify({ type: 'permission_response', allow: pb.dataset.perm === 'allow' }) });
    if (cb) { const i = Number(cb.dataset.choice); api('/choice', { method: 'POST', body: JSON.stringify({ type: 'choice_response', index: i >= 0 ? i : null }) }); }
    clearInterrupts(pb ? 'perm' : 'choice');
  }, true);
  function clearInterrupts(kind) {
    const box = document.getElementById('toasts');
    if (box) box.querySelectorAll(kind === 'perm' ? '.perm-card:not(.choice-card)' : '.choice-card').forEach(x => x.remove());
    for (const [id, a] of Object.entries(ACTIVITY)) {
      if (a[kind]) { delete a[kind]; syncActivity(id); }
    }
  }
  const inlineStreamEl = (tid, key) =>
    document.querySelector(`${threadSel(tid)} [data-stream-key="${CSS.escape(key)}"] .stream-text`);
  // the bridge wraps every user turn in a protocol envelope (chat.mjs compose());
  // envelope echoes are never rendered anywhere
  const ENV_RE = /^\s*(?:\(→[^)\n]*\)\s*)?(?:@(?:claude|codex)\s+)?\[review chat/;
  function chatEvent(m) {
    const tid = m.target_id || null;
    setChatMode(m.kind !== 'bridge-exit'); // any chat event proves --chat; a dead bridge means agents are off
    if (m.kind === 'turn-start') {
      presenceTurnStart(tid, m.user_text);
      if (tid) { activityOf(tid).streams = {}; chip(tid, '<span class="spin">◐</span> agents are working…'); }
      // unanchored turns (e.g. server transcript notes): presence strip only
    } else if (m.kind === 'turn-end') {
      presenceIdle();
      if (tid) chip(tid, 'reply landing in thread…');
      // pull the canonical thread state before clearing activity, so the chip
      // never outlives the reply it announces
      api('/data').then(r => r.json()).then(j => {
        adoptData(j);
        if (tid && ACTIVITY[tid]) ACTIVITY[tid].streams = {};
        rerender();
        if (tid) { chip(tid, 'replied ✓'); setTimeout(() => chip(tid, ''), 4000); }
      }).catch(() => { if (tid) chip(tid, 'done — refresh to see the reply', true); });
    } else if (m.kind === 'permission-timeout') {
      toast('Permission request timed out — denied by default.', true);
      if (tid) chip(tid, 'permission timed out (denied)', true);
    } else if (m.kind === 'stream') {
      const e = m.ev || {};
      if (m.final) {
        // canonical 'room' text finalizes ONLY its own (speaker, stream_id) stream;
        // batch {entries:[…]} is the secondary form. Only anchored streams render;
        // an off-page or unanchored turn shows in the presence strip alone.
        const finals = Array.isArray(e.entries) ? e.entries : [e];
        for (const entry of finals) {
          const who = String(entry.speaker || entry.model || 'agent');
          const key = `${who}:${entry.stream_id ?? 0}`;
          if (!entry.text || ENV_RE.test(entry.text)) continue;
          presenceStream(who);
          if (tid && ACTIVITY[tid] && ACTIVITY[tid].streams[key]) {
            ACTIVITY[tid].streams[key].text = entry.text;
            const el = inlineStreamEl(tid, key);
            if (el) { el.textContent = entry.text; positionSoon(); }
          }
        }
        return;
      }
      const text = e.delta ?? e.text ?? '';
      if (!text) return;
      const who = String(e.model || e.speaker || 'agent');
      const key = `${who}:${e.stream_id ?? 0}`;
      presenceStream(who);
      if (tid && document.querySelector(threadSel(tid))) {
        // live streaming text inside the thread card, under the user's comment
        const a = activityOf(tid);
        const s = a.streams[key] = a.streams[key] || { who, text: '' };
        s.text += text;
        const el = inlineStreamEl(tid, key);
        if (el) { el.textContent = s.text; positionSoon(); } else syncActivity(tid);
      }
    } else if (m.kind === 'permission') {
      clearInterrupts('perm');
      if (m.ev.type !== 'permission_request') return;
      // anchored + on this page: in the thread card; otherwise: sidebar toast
      if (tid && document.querySelector(threadSel(tid))) { activityOf(tid).perm = m.ev; syncActivity(tid); }
      else interruptToast(permHtml(m.ev));
    } else if (m.kind === 'choice') {
      clearInterrupts('choice');
      if (m.ev.type !== 'choice_request') return;
      if (tid && document.querySelector(threadSel(tid))) { activityOf(tid).choice = m.ev; syncActivity(tid); }
      else interruptToast(choiceHtml(m.ev));
    } else if (m.kind === 'choice-auto') {
      toast(`Agents asked "${m.prompt || 'a setup question'}" — answered automatically: ${m.picked}.`);
    } else if (m.kind === 'choice-timeout') {
      toast('Choice request timed out — dismissed by default.', true);
      if (tid) chip(tid, 'choice timed out (dismissed)', true);
    } else if (m.kind === 'bridge-exit') {
      presenceIdle();
      toast(`Agent bridge exited (code ${m.code}). Restart the server with --chat.`, true);
      for (const id of Object.keys(ACTIVITY)) chip(id, 'agent bridge exited — restart the server with --chat', true);
    }
  }

  render();
  window.addEventListener('load', () => setTimeout(position, 300));
  window.addEventListener('resize', position);
})();
