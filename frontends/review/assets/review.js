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
    // self-repair: an OWNER browser whose stored handle has drifted to some
    // other name (e.g. after testing the gate as a guest) would mirror the
    // owner's whole local store up under that name — cloning every comment to
    // a phantom user file. The server already vouches this browser is the
    // owner, so snap the stored handle back before the next push.
    if (HOSTED_MODE && IS_OWNER && OWNER_HANDLE && localStorage.getItem(HKEY)
        && localStorage.getItem(HKEY) !== OWNER_HANDLE) {
      localStorage.setItem(HKEY, OWNER_HANDLE);
      ME = OWNER_HANDLE;
    }
    if (j.apply) APPLY = j.apply;
    PENDING_M = j.pending_mentions || [];
    // additive server fields; a server predating them simply doesn't send them —
    // chat detection falls back to SSE events / 409s, and the out-of-band line hides
    if (typeof j.chat === 'boolean') PRESENCE.chat = j.chat;
    SRC_DIRTY = Array.isArray(j.source_dirty) ? j.source_dirty : SRC_DIRTY;
    // presence / roster / grants (additive: older servers omit them)
    if (Array.isArray(j.presence)) PEOPLE = j.presence;
    if (Array.isArray(j.people)) ROSTER = j.people;
    if (j.grants) GRANTS = j.grants;
    if (j.grant_usage) GRANT_USE = j.grant_usage;
    MY_GRANT = j.my_grant || null;
    if (j.models) applyModelState(j.models); // model-switcher seed (additive field)
    else renderModelSwitcher();              // reflect chat on/off even without a seed
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
  const otherAgent = a => (a === 'claude' ? 'codex' : 'claude');
  const cap = a => a[0].toUpperCase() + a.slice(1);
  const VERBS = ['crystallizing', 'architecting', 'mulling', 'drafting', 'responding', 'pondering', 'sketching', 'weighing'];
  const PRESENCE = {
    chat: null, // null = unknown (a server predating the /data "chat" field); true/false once known
    tid: null,  // target of the in-flight anchored turn, for click-to-jump
    agents: Object.fromEntries(AGENTS.map(a => [a, { active: false, verb: '', exhausted: null }])),
  };

  // ── credit-exhaustion detection + model-switcher state ──
  // An agent's turn output carrying one of these is treated as "out of credits"
  // until it produces a normal turn again. Claude's string is observed verbatim;
  // the OpenAI/Codex variants are a best-guess to refine against a real error.
  const EXHAUST_PATTERNS = {
    claude: [/monthly spend limit/i, /\/usage-credits/i, /out of credits/i,
      /credit balance (?:is )?too low/i, /insufficient credits?/i, /purchase credits/i],
    codex: [/insufficient_quota/i, /exceeded your current quota/i,
      /usage limit reached/i, /out of credits/i, /quota/i],
  };
  function exhaustReason(agent, text) {
    const t = String(text || '');
    return (EXHAUST_PATTERNS[agent] || []).some(re => re.test(t))
      ? t.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
  }
  const FALLBACK_MODELS = {
    claude: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    codex: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'],
  };
  // scoped model lists + current per-agent model, seeded from /data and kept
  // live by forwarded status/completion_context chat events
  const MODELS = { scoped: {}, current: { claude: null, codex: null } };
  const modelsFor = agent => {
    const list = MODELS.scoped[`/model @${agent} `];
    return (Array.isArray(list) && list.length) ? list : FALLBACK_MODELS[agent];
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
  // ---- human presence (item 5) --------------------------------------------
  // Computed from REAL interaction, not from having a socket open: a parked tab
  // is idle, not "active". In-memory on the server, never written to disk, and
  // symmetric — everyone sees everyone at the same coarse granularity (state +
  // section). DESKTOP ONLY: phones send no beats and simply don't appear.
  const IDLE_MS = 60000, BEAT_MS = 15000;
  const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;
  let lastTouch = Date.now();
  let PEOPLE = []; // [{handle, state, section, section_title, owner}]
  const initials = h => String(h || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  function myPresenceState() {
    if (document.visibilityState !== 'visible') return 'idle';
    return Date.now() - lastTouch < IDLE_MS ? 'active' : 'idle';
  }
  const sectionTitle = () => {
    const a = document.querySelector(`nav.toc a[data-slug="${CSS.escape(slug)}"]`);
    return a ? a.textContent.trim() : slug;
  };
  let beatTimer = null;
  function sendBeat() {
    if (!LIVE || !isDesktop()) return;
    api('/beat', { method: 'POST', body: JSON.stringify({
      state: myPresenceState(), section: slug, section_title: sectionTitle(), focused_id: FOCUSED || '',
    }) }).then(r => r.json()).then(j => { if (j && j.people) { PEOPLE = j.people; renderPresence(); } }).catch(() => { });
  }
  function startHeartbeat() {
    if (!LIVE || !isDesktop() || beatTimer) return;
    const touch = () => { lastTouch = Date.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'selectionchange'])
      document.addEventListener(ev, touch, { passive: true });
    // a hidden tab is idle IMMEDIATELY — not 60s later
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') touch(); sendBeat(); });
    beatTimer = setInterval(sendBeat, BEAT_MS);
    sendBeat();
  }
  function humanAvatarHtml(p) {
    const me = ME && p.handle === ME;
    const where = p.section_title ? ` — ${p.state === 'active' ? 'reading' : 'idle on'} §${p.section_title}` : '';
    const tip = `${p.handle}${me ? ' (you)' : ''}${where}`;
    return `<div class="avatar-ring human ${esc(p.state)}" data-handle="${esc(p.handle)}" style="--author:${authorColor(p.handle)}" title="${esc(tip)}"><span class="avatar initials">${esc(initials(p.handle))}</span></div>`;
  }
  function renderPresence() {
    renderServerGone();
    const el = document.getElementById('presence');
    if (el) {
      const [cls, txt] = connState();
      const chatTxt = PRESENCE.chat === null ? 'agents: —' : `agents: ${PRESENCE.chat ? 'on' : 'off'}`;
      el.innerHTML = `<div class="conn ${cls}">${esc(txt)}</div>
        <div class="chatmode" title="agent chat (server started with --chat)">${chatTxt}</div>${budgetHtml()}`;
    }
    const av = document.getElementById('avatars');
    if (!av) return;
    // humans first (initials disc in the handle's hashed colour — the SAME
    // colour as their comments and chips), then a hairline, then the agents
    // (brand glyph + rotating working ring). Two different visual grammars so
    // a person is never mistaken for a bot.
    const humans = PEOPLE.map(humanAvatarHtml).join('');
    const agents = AGENTS.map(a => {
      const s = PRESENCE.agents[a];
      const name = cap(a);
      const tip = s.exhausted ? `${name} is out of credits — ${s.exhausted}`
        : s.active ? `${name} is ${s.verb}… — click to jump to the thread` : `${name} — idle`;
      // white brand glyph (currentColor) on the agent's accent circle: reads
      // identically in both themes
      return `<div class="avatar-ring${s.active ? ' working' : ''}${s.exhausted ? ' exhausted' : ''}" data-agent="${a}" style="--author:var(--${a})" title="${esc(tip)}"><span class="avatar">${MARKS[a] || ''}</span>${s.exhausted ? '<span class="warn-badge" aria-hidden="true">⚠</span>' : ''}</div>`;
    }).join('');
    av.innerHTML = humans + (humans ? '<span class="av-div" aria-hidden="true"></span>' : '') + agents
      + `<button class="av-btn" id="people-btn" title="People">👥</button>`
      + (IS_OWNER ? '<button class="av-btn" id="gear-btn" title="Settings" aria-label="Settings">⚙</button>' : '');
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

  // ── model switcher (sidebar) + credit-exhaustion affordances ──
  const shortModel = m => String(m || '').replace(/^claude-/, '').replace(/^gpt-/, '');
  function modelRow(a) {
    const cur = MODELS.current[a] || '';
    const ex = PRESENCE.agents[a].exhausted;
    const opts = modelsFor(a).map(m =>
      `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('');
    return `<div class="ms-row${ex ? ' exhausted' : ''}" data-agent="${a}">
      <span class="ms-mark" style="--author:${a === 'claude' ? 'var(--claude)' : 'var(--codex)'}"><span class="avatar">${MARKS[a] || ''}</span></span>
      <div class="ms-body">
        <div class="ms-name">${cap(a)}${ex ? '<span class="warn-badge" title="out of credits">⚠</span>' : ''}</div>
        <select class="ms-select" data-agent="${a}" aria-label="${cap(a)} model">${opts}</select>
      </div></div>`;
  }
  // the switcher lives in the Settings slide-over (owner-only, desktop-only);
  // this is a no-op whenever that panel isn't open
  function renderModelSwitcher() {
    const el = document.getElementById('settings-models');
    if (!el) return;
    el.innerHTML = PRESENCE.chat === true ? AGENTS.map(modelRow).join('')
      : '<div class="so-empty">agents are not attached (start the server with --chat)</div>';
  }
  // optimistic switch: clear the exhausted flag now, post the control command;
  // the authoritative current model lands on the next status event
  function switchModel(agent, model) {
    if (!model || !AGENTS.includes(agent)) return;
    clearExhausted(agent);
    if (!LIVE) return;
    api('/model', { method: 'POST', body: JSON.stringify({ text: `/model @${agent} ${model}` }) })
      .then(async r => {
        if (r.status === 409) { toast('Restart the server as: node review/server.mjs --chat', true); return; }
        const j = await r.json().catch(() => ({}));
        if (!j.ok) toast(`Model switch failed${j.error ? ': ' + j.error : ''}`, true);
        else toast(`Switching ${cap(agent)} → ${shortModel(model)}…`);
      })
      .catch(() => toast('Model switch failed — server unreachable', true));
  }
  function applyModelState(models) {
    if (!models) return;
    if (models.scoped) MODELS.scoped = models.scoped;
    const st = models.status;
    if (st) {
      if ('claude_model' in st) MODELS.current.claude = st.claude_model || null;
      if ('codex_model' in st) MODELS.current.codex = st.codex_model || null;
    }
    renderModelSwitcher();
  }
  function flagExhausted(agent, reason, tid) {
    if (!AGENTS.includes(agent)) return;
    const was = PRESENCE.agents[agent].exhausted;
    PRESENCE.agents[agent].exhausted = reason;
    renderPresence();
    renderModelSwitcher();
    if (!was) exhaustNotice(agent, reason, tid); // one notice per episode
  }
  function clearExhausted(agent) {
    if (!AGENTS.includes(agent) || !PRESENCE.agents[agent].exhausted) return;
    PRESENCE.agents[agent].exhausted = null;
    // drop any in-thread notices raised for this agent
    for (const [id, a] of Object.entries(ACTIVITY)) {
      if (a.notice && a.notice.agent === agent) { delete a.notice; syncActivity(id); }
    }
    // and any unanchored sidebar-toast notice for this agent
    for (const el of document.querySelectorAll(`#toasts .exhaust-notice[data-agent="${agent}"]`)) {
      const box = el.closest('.toast') || el; box.remove();
    }
    renderPresence();
    renderModelSwitcher();
  }
  // an agent's finished turn: exhaustion message → flag; normal output → clear
  function noteAgentTurn(agent, text, tid) {
    if (!AGENTS.includes(agent)) return;
    const reason = exhaustReason(agent, text);
    if (reason) flagExhausted(agent, reason, tid);
    else if (String(text || '').trim()) clearExhausted(agent);
  }

  let LAST_USER_TEXT = ''; // most recent human turn, for "retry with @other"
  // notice markup (shared by the in-thread activity render + the sidebar toast):
  // switch this agent's model right here, or retry the turn with the other agent
  function noticeHtml(agent, reason) {
    const o = otherAgent(agent);
    const opts = modelsFor(agent).map(m =>
      `<option value="${esc(m)}"${m === MODELS.current[agent] ? ' selected' : ''}>${esc(m)}</option>`).join('');
    return `<div class="exhaust-notice" data-agent="${esc(agent)}">
      <div class="en-head"><span class="badge bad-badge">⚠ out of credits</span>
        <span>${esc(cap(agent))} is out of credits — switch its model or tag @${esc(o)}</span></div>
      ${reason ? `<div class="en-why">${esc(reason)}</div>` : ''}
      <div class="en-acts">
        <label class="notice-switch">switch <select class="ms-select" data-agent="${esc(agent)}" aria-label="${esc(cap(agent))} model">${opts}</select></label>
        <button class="rebtn en-retry" data-retry="${esc(o)}">↻ retry with @${esc(o)}</button>
      </div></div>`;
  }
  function exhaustNotice(agent, reason, tid) {
    if (hasSurface(tid)) {
      activityOf(tid).notice = { agent, reason };
      syncActivity(tid);
    } else {
      interruptToast(noticeHtml(agent, reason)); // unanchored: sidebar toast
    }
  }
  // delegated handlers for notice + sidebar-switcher controls (their markup is
  // re-injected on every render, so listeners live on the document)
  document.addEventListener('change', e => {
    const sel = e.target.closest('select.ms-select');
    if (sel) { switchModel(sel.dataset.agent, sel.value); refreshComposerWarns(); }
  });
  document.addEventListener('click', e => {
    const rt = e.target.closest('.exhaust-notice [data-retry]');
    if (!rt) return;
    e.stopPropagation();
    const o = rt.dataset.retry;
    const th = rt.closest('.thread');
    const tid = th && th.dataset.thread;
    const body = String(LAST_USER_TEXT || '').replace(/@(claude|codex|all)\b/gi, '').trim() || 'please take this turn';
    if (tid) maybeMention(tid, `@${o} ${body}`, `retry:${tid}:${o}:${Date.now()}`);
    else toast(`Open the thread and tag @${o} to retry.`);
  });

  // ── pre-send guard: warn BEFORE a mention is confirmed if it targets an
  // out-of-credits agent, with the switch control right there. Never silent. ──
  function presendExhaustedFor(text) {
    const t = String(text || '');
    const explicit = AGENTS.find(a => new RegExp('@' + a + '\\b', 'i').test(t) && PRESENCE.agents[a].exhausted);
    if (explicit) return explicit;
    if (/@all\b/i.test(t) && AGENTS.every(a => PRESENCE.agents[a].exhausted)) {
      return AGENTS.find(a => PRESENCE.agents[a].exhausted);
    }
    return null;
  }
  function updateComposerWarn(container, ta) {
    if (!container || !ta) return;
    const agent = presendExhaustedFor(ta.value);
    let warn = container.querySelector(':scope > .presend-warn');
    if (!agent) { if (warn) warn.remove(); return; }
    const o = otherAgent(agent);
    if (!warn) {
      warn = document.createElement('div');
      warn.className = 'presend-warn';
      const acts = container.querySelector(':scope > .acts');
      if (acts) container.insertBefore(warn, acts); else container.appendChild(warn);
    }
    const opts = modelsFor(agent).map(m =>
      `<option value="${esc(m)}"${m === MODELS.current[agent] ? ' selected' : ''}>${esc(m)}</option>`).join('');
    warn.innerHTML = `<span class="pw-msg">⚠ ${esc(cap(agent))} is out of credits — it won't reply. Switch its model or tag @${esc(o)}.</span>
      <span class="pw-acts"><label class="notice-switch">switch <select class="ms-select" data-agent="${esc(agent)}" aria-label="${esc(cap(agent))} model">${opts}</select></label>
      <button type="button" class="rebtn pw-tag" data-pw-tag="${esc(o)}">tag @${esc(o)}</button></span>`;
    warn.querySelector('[data-pw-tag]').addEventListener('click', () => {
      ta.value = ta.value.replace(new RegExp('@' + agent + '\\b', 'gi'), '@' + o);
      if (!new RegExp('@' + o + '\\b', 'i').test(ta.value)) ta.value = `@${o} ` + ta.value.trim();
      updateComposerWarn(container, ta); ta.focus();
    });
  }
  function refreshComposerWarns() {
    for (const box of document.querySelectorAll('.card.composing, .reply.composing')) {
      updateComposerWarn(box, box.querySelector('textarea'));
    }
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
    if (!tid || tid === '__console__') return; // console turns are already on screen
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

  // ---- stable ids on blocks ------------------------------------------------
  // MIGRATION-CRITICAL: `blk-N` is a POSITIONAL index over the matched element
  // list. Every existing comment in every live paper is anchored to one. So the
  // `#paper p, #paper figure` → `${slug}-blk-${i}` pass below must stay exactly
  // as it has always been — adding a selector to it would renumber every block
  // after the first newly-matched element and silently re-anchor every comment.
  //
  // Newly commentable element types therefore get their OWN independent
  // counters in their own namespaces (`-hd-N` for headings, `-misc-N` for list
  // items, block quotes, captions and table cells). Nothing that exists today
  // moves; new anchors can only ever be created, never reassigned.
  function anchorBlocks(sel, prefix) {
    const out = [];
    document.querySelectorAll(sel).forEach((el, i) => {
      if (el.dataset.cid) return;          // never overwrite an assigned anchor
      el.dataset.cid = `${slug}-${prefix}-${i}`;
      out.push(el);
    });
    return out;
  }
  const anchored = [
    ...anchorBlocks('#paper p, #paper figure', 'blk'),        // ← byte-identical to the original pass
    ...anchorBlocks('#paper h1, #paper h2, #paper h3, #paper h4, #paper h5, #paper h6', 'hd'),
    ...anchorBlocks('#paper li, #paper blockquote, #paper figcaption, #paper td, #paper th, #paper dt, #paper dd', 'misc'),
  ];
  // the masthead carries data-cid="paper-title" from build.mjs and lives OUTSIDE
  // #paper, so it must be added explicitly wherever blocks are collected
  const masthead = document.querySelector('header.masthead[data-cid]');
  // every anchored element (in #paper or the masthead) — the one collection all
  // block-scoped code uses, so the masthead is never half-wired again
  const blockEls = () => [...document.querySelectorAll('#paper [data-cid]'), ...(masthead ? [masthead] : [])];
  // LEAF blocks only: a <li> wrapping a <p>, or a <figure> wrapping a
  // <figcaption>, would otherwise let one span match twice and suppress its own
  // inline rendering as "ambiguous".
  const leafBlocks = () => blockEls().filter(b => !b.querySelector('[data-cid]'));
  for (const el of [...anchored, ...(masthead ? [masthead] : [])]) {
    el.addEventListener('click', e => {
      if (e.target.closest('a,abbr,button,textarea,del.tc-del,ins.tc-ins')) return; // tc-* opens the change popover

      const mk = e.target.closest('mark.user-hl');
      if (mk) { activateCard(mk.dataset.cardId); return; }
      if (window.getSelection() && !window.getSelection().isCollapsed) return;
      if (e.altKey) { openComposer({ anchor: el.dataset.cid, excerpt: el.textContent.slice(0, 100) }); return; }
      if (el.dataset.cardId) activateCard(el.dataset.cardId);
    });
  }

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
  // ---- human suggestions ---------------------------------------------------
  // A human's suggestion is an entry in their OWN state/users/<handle>.json
  // (file ownership is absolute: suggestions.json stays bot-owned). It carries
  // the same span fields a bot card does, so every downstream path — inline
  // del/ins rendering, the margin card, accept → Apply → Commit — treats it
  // identically. Only the storage location differs.
  function ownSuggestions() {
    return Object.entries(store())
      .filter(([, v]) => v.status === 'user-suggestion')
      .map(([id, v]) => ({ id, type: 'user-suggestion', mine: true, author: ME || 'you', ...v }));
  }
  function otherSuggestions() {
    const out = [];
    for (const [h, dec] of Object.entries(OTHERS)) {
      for (const [id, v] of Object.entries(dec)) {
        if (v.status === 'user-suggestion') out.push({ id, type: 'user-suggestion', mine: false, author: h, ...v });
      }
    }
    return out;
  }
  const humanSuggestions = () => [...ownSuggestions(), ...otherSuggestions()];
  // every suggestion on the page, whoever wrote it — the list wrapTracked walks
  const allSuggestions = () => [...SUGG.filter(c => !c.reply_to), ...humanSuggestions()];
  // A decision (accept/reject) is the VIEWER's, stored in the viewer's own file.
  // Bot cards keep using `status`. A human suggestion already occupies `status`
  // with its entry type, so its decision lives in `decision` — read both.
  function decisionOf(id) {
    const v = store()[id] || {};
    if (v.decision) return v.decision;
    return String(v.status || '').startsWith('user-') ? undefined : v.status;
  }
  function setDecision(id, val) {
    const d = store();
    d[id] = d[id] || {};
    if (String(d[id].status || '').startsWith('user-')) d[id].decision = val || undefined;
    else d[id].status = val || undefined;
    save(d);
  }

  function allCards(resolved) {
    const sugg = SUGG.filter(c => c.section === slug && !c.reply_to);
    const all = [...sugg, ...humanSuggestions().filter(c => c.section === slug),
      ...ownComments(), ...otherComments()];
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
    const st = (c.type === 'user-suggestion' ? decisionOf(c.id) : dec.status) || 'pending';
    let body;
    if (c.type === 'user-suggestion') {
      // the human counterpart of a bot suggestion card: same diff, same
      // accept/apply row below, plus the author's own edit/resolve controls
      const acts = c.mine
        ? `<div class="acts"><button data-act="edit-sugg" data-target="${esc(c.id)}">✎ edit</button><button data-act="resolve" data-target="${esc(c.id)}">${c.resolved ? '↩ reopen' : '✓ resolve'}</button></div>`
        : (c.resolved && IS_OWNER
          ? `<div class="acts"><button data-act="reopen-other" data-target="${esc(c.id)}" data-handle="${esc(c.author)}">↩ reopen</button></div>`
          : '');
      body = `<div class="who"><span class="author">${esc(c.author)}</span><span class="badge type-badge">suggestion</span>${c.mine ? '' : ' <span class="badge">read-only</span>'}</div>
        <div class="diff"><del>${esc(c.display_text || c.current_text)}</del> <ins>${esc(c.display_proposed != null ? c.display_proposed : c.proposed_text)}</ins></div>
        ${c.comment ? `<div class="ctext">${esc(c.comment)}</div>` : ''}
        <div class="why">in ${esc(c.source_json ? `${c.source_json.file} → "${c.source_json.key}"` : c.source_file || 'the source')}</div>
        ${acts}`;
    } else if (c.type === 'old-todo') {
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
    const applyBtn = IS_OWNER && !ap && st === 'accepted' && (c.current_text || c.source_json)
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

  // ---- source resolution for human suggestions ----------------------------
  // A suggestion is only worth saving if Apply can find its span. So the whole
  // resolution happens HERE, at compose time, against the real source file:
  // fetch the source, locate the selection, widen it until it is unique, and
  // show the user exactly what it locked onto. Failing here with a clear
  // message is fine; failing silently at Apply time is not.
  const SECMAP = Object.fromEntries((META.sections || []).map(s => [s.slug, s.file]));
  const srcCache = {};
  function fetchSource(file) {
    if (!LIVE || !file) return Promise.resolve(null);
    if (srcCache[file]) return srcCache[file];
    return (srcCache[file] = api('/source?file=' + encodeURIComponent(file))
      .then(r => r.ok ? r.json() : null).then(j => (j && j.ok) ? j.text : null)
      .catch(() => null));
  }
  const HEAD_MACROS = ['section', 'subsection', 'subsubsection', 'paragraph', 'chapter', 'part'];
  // the LaTeX macro call enclosing `title` — `\section{Introduction}`, not the
  // bare word "Introduction", which is ambiguous everywhere it also appears in
  // prose. Returns {current, proposedFor(newText)} or null.
  function headingMacro(src, title) {
    const want = String(title).replace(/\s+/g, ' ').trim();
    for (const name of HEAD_MACROS) {
      const re = new RegExp('\\\\' + name + '\\*?(?:\\[[^\\]]*\\])?\\s*\\{', 'g');
      let m;
      while ((m = re.exec(src))) {
        // brace-balanced argument scan (titles may contain \emph{…})
        let depth = 0, start = -1, end = -1;
        for (let i = m.index + m[0].length - 1; i < src.length; i++) {
          if (src[i] === '{') { if (depth === 0) start = i + 1; depth++; }
          else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (start < 0 || end < 0) continue;
        const arg = src.slice(start, end);
        if (arg.replace(/\s+/g, ' ').trim() !== want) continue;
        const current = src.slice(m.index, end + 1);
        return { current, head: src.slice(m.index, start), tail: '}' };
      }
    }
    return null;
  }
  // widen `quote` with its surrounding block text, word by word on alternating
  // sides, until it matches the source exactly once
  function widenToUnique(src, quote, context) {
    const S = window.SpanMatch;
    const hits = q => S.findSpans(src, q, 3).length;
    if (!hits(quote)) return { ok: false, reason: 'this text is not in the source file — the page may be out of date (rebuild), or the selection spans generated text' };
    if (hits(quote) === 1) return { ok: true, current: quote, widened: false };
    const norm = String(context || '').replace(/\s+/g, ' ');
    const q = String(quote).replace(/\s+/g, ' ').trim();
    const at = norm.indexOf(q);
    if (at < 0) return { ok: false, reason: 'the selection is ambiguous and could not be widened (it spans more than one block)' };
    let lo = at, hi = at + q.length;
    for (let step = 0; step < 60; step++) {
      const grew = step % 2 === 0
        ? (() => { const p = norm.lastIndexOf(' ', Math.max(lo - 2, 0)); if (lo === 0) return false; lo = p < 0 ? 0 : p + 1; return true; })()
        : (() => { const p = norm.indexOf(' ', hi + 1); if (hi >= norm.length) return false; hi = p < 0 ? norm.length : p; return true; })();
      if (!grew && lo === 0 && hi === norm.length) break;
      const cand = norm.slice(lo, hi).trim();
      const n = hits(cand);
      if (n === 1) return { ok: true, current: cand, widened: cand !== q };
      if (n === 0) return { ok: false, reason: 'widening the selection lost the match — the source and the rendered page disagree here (rebuild?)' };
    }
    return { ok: false, reason: 'this text occurs more than once in the source and could not be made unique — select a longer, distinctive passage' };
  }
  // full resolution for one selection: returns the card's source fields.
  // Three shapes: masthead title (macro or JSON config key), heading (macro),
  // ordinary prose (unique span, widened if needed).
  async function resolveSuggestion(info) {
    const el = document.querySelector(`[data-cid="${CSS.escape(info.anchor)}"]`);
    const isTitle = info.anchor === 'paper-title';
    const isHeading = !!(el && /^H[1-6]$/.test(el.tagName));
    const quote = String(info.quote || '').replace(/\s+/g, ' ').trim();
    if (!quote) return { ok: false, reason: 'select some text first' };
    if (isTitle) {
      const ts = META.title_source;
      if (!ts) return { ok: false, reason: 'this build does not record where the title comes from — rebuild the site (node review/build.mjs)' };
      if (ts.kind === 'config') {
        // JSON-aware: apply edits the key, never string-replaces the file
        return { ok: true, kind: 'title-config', source_json: { file: ts.file, key: ts.key },
          current_text: ts.raw || el.textContent.trim(), display_text: el.textContent.trim(),
          locked: `${ts.file} → "${ts.key}"` };
      }
      return { ok: true, kind: 'title-latex', source_file: ts.file, current_text: ts.macro,
        display_text: el.textContent.trim(), head: ts.macro.slice(0, ts.macro.indexOf(ts.arg)), tail: '}',
        locked: ts.macro };
    }
    const file = SECMAP[slug];
    if (!file) return { ok: false, reason: 'this build does not record which source file this page came from — rebuild the site (node review/build.mjs)' };
    const src = await fetchSource(file);
    if (src == null) return { ok: false, reason: `could not read ${file} from the server` };
    if (isHeading) {
      const h = headingMacro(src, el.textContent.trim());
      if (!h) return { ok: false, reason: `could not find the \\section{…} macro for this heading in ${file}` };
      return { ok: true, kind: 'heading', source_file: file, current_text: h.current,
        display_text: el.textContent.trim(), head: h.head, tail: h.tail, locked: h.current };
    }
    const w = widenToUnique(src, quote, el ? el.textContent : quote);
    if (!w.ok) return w;
    return { ok: true, kind: 'prose', source_file: file, current_text: w.current,
      display_text: w.current, widened: w.widened, locked: w.current };
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
    // mode switch: Comment (unchanged) · Suggest (proposes replacement text).
    // Suggest needs a selection to replace and a live server to resolve the
    // span against the source, so it is offered only when both hold.
    const canSuggest = LIVE && !!anchorInfo.quote && !existingId;
    const modes = canSuggest
      ? `<div class="seg cmp-mode" role="group" aria-label="composer mode">
           <button class="seg-btn on" data-mode="comment">💬 Comment</button>
           <button class="seg-btn" data-mode="suggest">✎ Suggest</button>
         </div>` : '';
    div.innerHTML = `<div class="who"><span class="author">${esc(ME || 'you')}</span></div>${modes}${quoteLine}
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
      updateComposerWarn(div, ta); // warn before a mention to an exhausted agent
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
      const mode = e.target.closest('[data-mode]');
      if (mode && mode.dataset.mode === 'suggest') {
        // switching to Suggest discards the (unsent) comment draft and opens
        // the suggestion composer on the same selection
        clearTimeout(saveTimer);
        const d = store(); delete d[id]; save(d);
        div.remove();
        openSuggestComposer(anchorInfo, openedSheet);
        return;
      }
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'done') close(false);
      if (act === 'discard') close(true);
    });
    ta.focus({ preventScroll: true });
    composerCount++;
  }

  // ---- Suggest composer ----------------------------------------------------
  // Prefills current_text from the exact selection, resolves it to a UNIQUE
  // source span before anything is saved, and shows what it locked onto. The
  // saved entry is a `user-suggestion` in the author's own file.
  function openSuggestComposer(anchorInfo, openedSheetAlready, existing) {
    if (document.querySelector('.card.composing')) return;
    const id = (existing && existing.id) || `usugg-${anchorInfo.anchor}-${Date.now()}`;
    const div = document.createElement('div');
    div.className = 'card composing t-suggestion suggesting';
    div.dataset.id = id;
    div.style.setProperty('--author', authorColor(ME || 'you'));
    div.innerHTML = `<div class="who"><span class="author">${esc(ME || 'you')}</span><span class="badge type-badge">suggestion</span></div>
      <div class="sg-resolve">resolving the source span…</div>
      <div class="sg-body" hidden>
        <div class="sg-cur"></div>
        <label class="sg-label" for="sg-prop-${esc(id)}">replace with</label>
        <textarea id="sg-prop-${esc(id)}" class="sg-prop" placeholder="Proposed text… (empty = delete)"></textarea>
        <label class="sg-label" for="sg-why-${esc(id)}">why (optional)</label>
        <textarea id="sg-why-${esc(id)}" class="sg-why" placeholder="Rationale… (esc closes)"></textarea>
        <div class="acts"><button data-sg="save">save suggestion</button><button data-sg="discard">discard</button></div>
      </div>`;
    margin.appendChild(div);
    const openedSheet = openedSheetAlready || (isNarrow() && !margin.classList.contains('sheet-open'));
    if (isNarrow()) setSheet(true);
    const anchorEl = document.querySelector(`[data-cid="${CSS.escape(anchorInfo.anchor)}"]`);
    if (anchorEl) div.style.top = Math.max(anchorEl.getBoundingClientRect().top + window.scrollY - 60, 0) + 'px';

    const finish = () => { if (openedSheet) setSheet(false); div.remove(); pendingRender = false; rerender(); };
    div.addEventListener('click', e => {
      if (e.target.closest('[data-sg="discard"]')) { e.stopPropagation(); finish(); }
    });
    div.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); finish(); } });

    const fail = reason => {
      div.querySelector('.sg-resolve').innerHTML =
        `<span class="sg-bad">✗ ${esc(reason)}</span><div class="acts"><button data-sg="discard">close</button></div>`;
    };
    (existing ? Promise.resolve(existing.resolved) : resolveSuggestion(anchorInfo)).then(r => {
      if (!r || !r.ok) { fail((r && r.reason) || 'could not resolve this selection'); return; }
      // show EXACTLY what the suggestion locked onto — a widened span or an
      // enclosing macro is never applied behind the user's back
      div.querySelector('.sg-resolve').innerHTML =
        `<span class="sg-ok">✓ anchored on</span> <code class="sg-lock">${esc(String(r.locked).slice(0, 200))}</code>`
        + (r.widened ? '<div class="sg-note">widened past your selection to make it unique in the source</div>' : '')
        + (r.kind === 'heading' || r.kind === 'title-latex' ? '<div class="sg-note">headings anchor on the enclosing LaTeX macro, so the change is unambiguous</div>' : '')
        + (r.kind === 'title-config' ? '<div class="sg-note">this title lives in the config — Apply will edit that JSON key, not the text</div>' : '');
      const body = div.querySelector('.sg-body');
      body.hidden = false;
      const shownCur = r.display_text || r.current_text;
      div.querySelector('.sg-cur').innerHTML = `<div class="sg-label">current</div><del>${esc(shownCur)}</del>`;
      const prop = div.querySelector('.sg-prop'), why = div.querySelector('.sg-why');
      prop.value = existing ? (existing.display_proposed != null ? existing.display_proposed : existing.proposed_text) : shownCur;
      if (existing) why.value = existing.comment || '';
      prop.focus({ preventScroll: true });
      prop.setSelectionRange?.(0, prop.value.length);
      div.querySelector('[data-sg="save"]').addEventListener('click', ev => {
        ev.stopPropagation();
        const shown = prop.value;
        // macro-anchored cards keep the SOURCE proposal (`\section{New}`) for
        // apply and the rendered words for the inline del/ins
        const macro = r.head != null;
        const d = store();
        d[id] = {
          ...(d[id] || {}), status: 'user-suggestion', section: slug, anchor: anchorInfo.anchor,
          quote: anchorInfo.quote, comment: why.value,
          current_text: r.current_text,
          proposed_text: macro ? `${r.head}${shown}${r.tail}` : shown,
          display_text: r.display_text || r.current_text,
          display_proposed: shown,
          source_file: r.source_file, source_json: r.source_json,
          head: r.head, tail: r.tail, // macro wrapper, so an edit can rebuild it
        };
        save(d);
        // a suggestion is a conversational act too: an @tag in the rationale routes
        if (why.value.trim()) confirmMention(id, id, why.value.trim());
        finish();
      });
    });
  }
  // edit one of my own suggestions: same composer, prefilled, same anchor
  function openSuggestEditor(c) {
    openSuggestComposer({ anchor: c.anchor, quote: c.quote, excerpt: c.excerpt }, false, {
      id: c.id, comment: c.comment, proposed_text: c.proposed_text, display_proposed: c.display_proposed,
      resolved: { ok: true, kind: c.source_json ? 'title-config' : 'prose', locked: c.current_text,
        current_text: c.current_text, display_text: c.display_text || c.current_text,
        source_file: c.source_file, source_json: c.source_json,
        head: c.head, tail: c.tail },
    });
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
      updateComposerWarn(box, ta); // warn before a mention to an exhausted agent
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
    ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(persist, 500); updateComposerWarn(box, ta); });
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
      const sc = c.type === 'user-comment' ? (c.mine ? 'mine' : 'theirs')
        : (c.type === 'user-suggestion' ? (decisionOf(c.id) || 'pending') : (dec.status || 'pending'));
      div.className = `card t-${kind} s-${sc} ${focused ? 'focused' : 'collapsed'}`;
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
        if (act === 'edit-sugg') {
          if (c.mine) { div.remove(); openSuggestEditor(c); }
          return;
        }
        if (act === 'resolve') {
          if (!c.mine) return;
          const d = store(); d[c.id].resolved = !d[c.id].resolved; save(d); rerender(); return;
        }
        if (act === 'reopen-other') { reopenOther(target, e.target.dataset.handle); return; }
        setDecision(target, act === 'pending' ? undefined : act);
        rerender();
      });
    });
    unwrapTracked();   // restore pristine text before quote-wrapping scans it
    markCommented();
    wrapTracked();     // no-op when the sidebar toggle is off
    renderChips();
    renderProgress();
    renderConsole();   // builds #apply-bar (the Changes widget lives in the console)
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
    document.querySelectorAll('#paper ins.tc-ins, header.masthead ins.tc-ins').forEach(x => x.remove()); // generated text, not source
    document.querySelectorAll('#paper del.tc-del, header.masthead del.tc-del').forEach(m => {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      m.remove(); p.normalize();
    });
  }
  function wrapTracked() {
    // matching is whitespace-tolerant (assets/span-match.js): cards carry
    // single-spaced current_text while rendered paragraphs wrap lines.
    // HUMAN suggestions render through this exact path, in their author's
    // colour — a suggestion is a suggestion whoever wrote it.
    if (!inlineChanges || !window.SpanMatch) return;
    const blocks = leafBlocks();
    for (const c of allSuggestions()) {
      if (c.section !== slug || !c.current_text || APPLY.applied[c.id]) continue;
      const st = decisionOf(c.id);
      if (st === 'rejected') continue; // margin card only
      let host = null, span = null, count = 0;
      for (const blk of blocks) {
        const spans = window.SpanMatch.findSpans(blk.textContent, c.current_text, 2);
        count += spans.length;
        if (spans.length && !host) { host = blk; span = spans[0]; }
        if (count > 1) break;
      }
      // A title/heading suggestion anchors on the enclosing LaTeX macro, whose
      // braces never appear in the rendered text. Fall back to the rendered
      // display text — but ONLY inside the card's own anchor block. Page-wide
      // it would be ambiguous the moment two headings share a prefix
      // ("Alpha" vs "Alpha Sub"), and the anchor already pins the block
      // exactly, so this is more precise, not looser.
      if (count !== 1 && c.display_text && c.anchor) {
        const own = document.querySelector(`[data-cid="${CSS.escape(c.anchor)}"]`);
        const spans = own ? window.SpanMatch.findSpans(own.textContent, c.display_text, 2) : [];
        if (spans.length === 1) { host = own; span = spans[0]; count = 1; }
        else { host = null; count = spans.length; }
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
    // display_proposed exists on macro-anchored cards (heading/title): the
    // source proposal is `\section{New Title}`, but the body must show the
    // rendered words, not the LaTeX
    const shown = c.display_proposed != null ? c.display_proposed : c.proposed_text;
    if (shown) { // empty proposal = pure deletion, del alone suffices
      const ins = document.createElement('ins');
      ins.className = 'tc-ins' + (accepted ? ' tc-accepted' : '') + (c.id === FOCUSED ? ' focused' : '');
      ins.dataset.tc = c.id;
      ins.style.setProperty('--author', color);
      ins.title = tip;
      ins.textContent = shown;
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
  // The "Changes" widget (owner only) lives inside the task console: committing
  // IS a document-level task, so the accept → ⚡ Apply → ✓ Commit / ↩ Revert
  // flow belongs next to "apply all" and "verify every citation", not in a
  // separate sidebar box. Active states carry an accent edge (.attention).
  function renderApplyBar() {
    const bar = document.getElementById('apply-bar');
    if (!bar || !IS_OWNER) return;
    const d = store();
    // a suggestion is applyable whoever wrote it — bot card or human suggestion
    const byId = new Map(allSuggestions().map(c => [c.id, c]));
    const applyable = Object.keys(d).filter(id => {
      const c = byId.get(id);
      return c && !APPLY.applied[id] && decisionOf(id) === 'accepted' && (c.current_text || c.source_json);
    });
    const round = APPLY.round;
    const roundFiles = new Set((round || {}).files || []);
    // source files dirty in git but not part of the open round: surfaced so
    // invisible working-tree state can't exist (needs the server-side field)
    const outOfBand = (SRC_DIRTY || []).filter(f => !roundFiles.has(f));
    bar.classList.toggle('attention', !!(applyable.length || round));
    let html = '';
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
  // desktop: floating popover near the selection. Two actions now — Comment
  // (unchanged) and Suggest — so a human can propose text, not only ask a bot to.
  const pop = document.createElement('div');
  pop.id = 'sel-pop'; pop.hidden = true;
  pop.innerHTML = '<button data-sel="comment">💬 Comment</button><button data-sel="suggest">✎ Suggest</button>';
  document.body.appendChild(pop);
  document.addEventListener('mouseup', e => {
    if (pop.contains(e.target)) return;
    setTimeout(() => {
      if (isNarrow()) return; // narrow viewports use the bottom pill below
      const info = currentSelection();
      if (!info) { pop.hidden = true; return; }
      pending = { anchor: info.anchor, quote: info.quote, excerpt: info.excerpt };
      const r = info.range.getBoundingClientRect();
      pop.style.left = Math.max(r.left + r.width / 2 - 90, 8) + 'px';
      pop.style.top = (r.top - 38) + 'px';
      pop.hidden = false;
    }, 0);
  });
  pop.addEventListener('mousedown', e => e.preventDefault());
  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-sel]');
    if (!b) return;
    pop.hidden = true;
    if (pending) (b.dataset.sel === 'suggest' ? openSuggestComposer : openComposer)(pending);
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
    const c = allSuggestions().find(s => s.id === id);
    if (!c) return;
    const st = decisionOf(id);
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
        setDecision(id, btn.dataset.tcact);
        rerender();
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
    if (e.target.closest('#margin, mark.user-hl, nav.toc, #sel-pop, #sel-pill, #tc-pop, #mob-drawer, #mob-fab, #backdrop, #avatars, #toasts, .perm-card, #task-console, .slideover')) return;
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

  // (the model switcher used to live here. It is a rarely-touched control that
  // held permanent sidebar space, so it moved into the Settings slide-over —
  // renderModelSwitcher() now targets #settings-models and no-ops when the
  // panel is closed. Its credit-exhaustion warnings are unchanged.)

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

  // GDocs-style collaborator cluster: pill-chromed, top-right on every page —
  // humans (initials disc in their own colour) | agents (brand glyph) — plus
  // the People and (owner) Settings entry points
  const av = document.createElement('div');
  av.id = 'avatars';
  document.body.appendChild(av);
  av.addEventListener('click', e => {
    if (e.target.closest('#people-btn')) { togglePanel(peoplePanel, renderPeople); return; }
    if (e.target.closest('#gear-btn')) { togglePanel(settingsPanel, renderSettings); return; }
    if (e.target.closest('.avatar-ring.working')) jumpToActive();
  });

  // ---- slide-over panels (desktop only, CSS-gated) ------------------------
  const peoplePanel = document.createElement('aside');
  peoplePanel.id = 'people-panel'; peoplePanel.className = 'slideover'; peoplePanel.hidden = true;
  const settingsPanel = document.createElement('aside');
  settingsPanel.id = 'settings-panel'; settingsPanel.className = 'slideover'; settingsPanel.hidden = true;
  document.body.append(peoplePanel, settingsPanel);
  function togglePanel(panel, render) {
    const opening = panel.hidden;
    peoplePanel.hidden = true; settingsPanel.hidden = true;
    if (!opening) return;
    render();
    panel.hidden = false;
  }
  document.addEventListener('click', e => {
    if (e.target.closest('.slideover, #avatars')) return;
    peoplePanel.hidden = true; settingsPanel.hidden = true;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { peoplePanel.hidden = true; settingsPanel.hidden = true; }
  });

  // ---- People panel (item 7): who has joined + per-handle agent grants -----
  // The owner may let a named collaborator summon agents directly, within a
  // DAILY CAP. Apply, Commit, Revert, model switching and permission/choice
  // answers are owner-only forever — a grant never confers them.
  let GRANTS = {}, GRANT_USE = {}, MY_GRANT = null, ROSTER = [];
  function renderPeople() {
    if (peoplePanel.hidden && !peoplePanel.dataset.forceRender) { /* still safe to build */ }
    const online = new Map(PEOPLE.map(p => [p.handle, p]));
    const names = [...new Set([...ROSTER, ...PEOPLE.map(p => p.handle), ...(ME ? [ME] : [])])].sort();
    const rows = names.map(h => {
      const p = online.get(h);
      const isOwnerRow = h === OWNER_HANDLE;
      const g = GRANTS[h] || null;
      const used = GRANT_USE[h] || 0;
      const state = p ? p.state : 'offline';
      const where = p && p.section_title ? `${p.state === 'active' ? 'reading' : 'idle on'} §${p.section_title}` : 'not here right now';
      const grant = (IS_OWNER && !isOwnerRow)
        ? `<div class="pp-grant">
             <label class="pp-toggle"><input type="checkbox" data-grant="${esc(h)}"${g ? ' checked' : ''}> let ${esc(h)} summon agents</label>
             ${g ? `<label class="pp-cap">daily cap <input type="number" min="1" max="500" value="${Number(g.daily_cap) || 5}" data-cap="${esc(h)}"></label>
                    <span class="pp-used">${used} used today</span>` : ''}
           </div>`
        : (isOwnerRow ? '<div class="pp-note">document owner — full control</div>' : '');
      return `<div class="pp-row" style="--author:${authorColor(h)}">
        <span class="avatar-ring human ${esc(state)}"><span class="avatar initials">${esc(initials(h))}</span></span>
        <div class="pp-body"><div class="pp-name">${esc(h)}${h === ME ? ' <span class="badge">you</span>' : ''}</div>
        <div class="pp-where">${esc(where)}</div>${grant}</div></div>`;
    }).join('');
    peoplePanel.innerHTML = `<div class="so-head">People<button class="so-x" title="close">✕</button></div>
      <div class="so-note">presence is in-memory only — nothing about who read what is ever written to disk.</div>
      ${rows || '<div class="so-empty">nobody has joined yet</div>'}
      ${IS_OWNER ? '<div class="so-note">Apply, Commit, Revert, model switching and permission answers stay owner-only — a grant never confers them.</div>' : ''}`;
  }
  peoplePanel.addEventListener('click', e => {
    if (e.target.closest('.so-x')) { peoplePanel.hidden = true; return; }
    const cb = e.target.closest('[data-grant]');
    if (cb) {
      const h = cb.dataset.grant;
      const cap = Number((peoplePanel.querySelector(`[data-cap="${CSS.escape(h)}"]`) || {}).value) || 5;
      postGrant(h, cb.checked, cap);
    }
  });
  peoplePanel.addEventListener('change', e => {
    const num = e.target.closest('[data-cap]');
    if (num) postGrant(num.dataset.cap, true, Number(num.value) || 5);
  });
  function postGrant(handle, agents, daily_cap) {
    api('/grants', { method: 'POST', body: JSON.stringify({ handle, agents, daily_cap }) })
      .then(r => r.json()).then(j => {
        if (!j.ok) { toast('Could not change that grant' + (j.error ? ': ' + j.error : ''), true); return; }
        GRANTS = j.grants || {};
        renderPeople();
        toast(agents ? `${handle} can summon agents (${daily_cap}/day)` : `${handle} can no longer summon agents`);
      }).catch(() => toast('Grant change failed — server unreachable', true));
  }
  // the granted guest's OWN budget, in their sidebar: a budget you can see is a
  // budget that teaches judgement; a silent throttle only teaches confusion
  function budgetHtml() {
    if (!MY_GRANT) return '';
    const left = Math.max(0, (MY_GRANT.daily_cap || 0) - (MY_GRANT.used_today || 0));
    return `<div class="budget${left ? '' : ' spent'}">${left} of ${esc(MY_GRANT.daily_cap)} agent call${MY_GRANT.daily_cap === 1 ? '' : 's'} left today</div>`;
  }

  // ---- Settings panel (item 8): occupancy, honest usage, model switcher ----
  let USAGE = null;
  function renderSettings() {
    const fmt = n => n == null ? '—' : Number(n).toLocaleString();
    const money = n => '$' + (Math.round((Number(n) || 0) * 1e4) / 1e4).toFixed(4);
    const u = USAGE || {};
    const s = u.session;
    const occ = AGENTS.map(a => {
      const st = (u.models && u.models.status) || {};
      const tok = st[`${a}_tokens`], win = st[`${a}_window`], pct = st[`${a}_pct`];
      const w = pct == null ? 0 : Math.max(0, Math.min(100, Number(pct)));
      return `<div class="set-occ" style="--author:var(--${a})">
        <div class="set-occ-head"><span class="ms-mark" style="--author:var(--${a})"><span class="avatar">${MARKS[a] || ''}</span></span>
          <span class="set-name">${cap(a)}</span><span class="set-num">${pct == null ? 'no data yet' : w + '%'}</span></div>
        <div class="meter"><span style="width:${w}%"></span></div>
        <div class="set-sub">${fmt(tok)} / ${fmt(win)} tokens in context</div></div>`;
    }).join('');
    const sessionRows = s ? AGENTS.map(a => {
      const x = s.agents[a] || {};
      return `<tr><td>${cap(a)}</td><td>${fmt(x.turns)}</td><td>${fmt(x.prompt_tokens)}</td></tr>`;
    }).join('') : '';
    const handleRows = s ? Object.entries(s.by_handle || {}).sort((a, b) => b[1].turns - a[1].turns).map(([h, v]) =>
      `<tr><td><span class="dot" style="background:${authorColor(h)}"></span>${esc(h)}</td><td>${fmt(v.turns)}</td><td>${fmt(v.prompt_tokens)}</td><td>${money(v.est_cost_usd)}</td></tr>`).join('') : '';
    const roll = u.rollup;
    settingsPanel.innerHTML = `<div class="so-head">Settings<button class="so-x" title="close">✕</button></div>
      <div class="so-sec">context occupancy — live</div>${occ}
      <div class="so-sec">this review session</div>
      ${s ? `<table class="set-tbl"><tr><th>agent</th><th>turns</th><th>prompt tokens</th></tr>${sessionRows}</table>
             <div class="set-est">estimated spend this session: <strong>${money(s.est_cost_usd)}</strong></div>
             <div class="so-note">${esc(s.basis)}</div>
             ${handleRows ? `<div class="so-sec">by who asked</div><table class="set-tbl"><tr><th>handle</th><th>turns</th><th>prompt tokens</th><th>est.</th></tr>${handleRows}</table>` : ''}`
        : '<div class="so-empty">no agent turns yet in this session</div>'}
      <div class="so-sec">local rollup — billed</div>
      ${roll ? `<table class="set-tbl"><tr><th></th><th>runs</th><th>cost</th></tr>
          <tr><td>today</td><td>${fmt(roll.today.runs)}</td><td>${money(roll.today.cost)}</td></tr>
          <tr><td>this week</td><td>${fmt(roll.week.runs)}</td><td>${money(roll.week.cost)}</td></tr></table>
          <div class="so-note">real billed cost, from botference's ${esc(roll.source)} — covers recorded runs on this machine, not this browser session.</div>`
        : '<div class="so-empty">no local run records on this machine (botference logs/usage.jsonl)</div>'}
      <div class="so-sec">subscription quota</div>
      <div class="so-note">${esc(u.quota_note || 'Weekly subscription quota — not exposed by either provider. Run /usage in Claude Code.')}</div>
      <div class="so-sec">agent models</div><div id="settings-models"></div>`;
    const ms = settingsPanel.querySelector('#settings-models');
    if (ms) ms.innerHTML = PRESENCE.chat === true ? AGENTS.map(modelRow).join('')
      : '<div class="so-empty">agents are not attached (start the server with --chat)</div>';
    if (LIVE) api('/usage').then(r => r.ok ? r.json() : null).then(j => {
      if (!j || settingsPanel.hidden) return;
      if (JSON.stringify(j) === JSON.stringify(USAGE)) return;
      USAGE = j; renderSettings();
    }).catch(() => { });
  }
  settingsPanel.addEventListener('click', e => { if (e.target.closest('.so-x')) settingsPanel.hidden = true; });

  // ---- Task console (item 6): document-level instructions -----------------
  // NOT a chat-about-the-paper — that was rejected and stays rejected. Content
  // discussion lives in margin comments, always anchored to text. This bar is
  // for instructions that have NO anchor: "apply all", "commit", "restructure
  // section 3", "verify every citation resolves". Owner-only, desktop-only.
  // Routing is as strict as everywhere else: nothing reaches an agent without
  // an explicit @claude / @codex / @all.
  const CONSOLE_ID = '__console__';
  const CONKEY = KEY + '-console-open';
  const console_ = document.createElement('div');
  console_.id = 'task-console'; console_.hidden = true;
  document.body.appendChild(console_);
  let consoleOpen = localStorage.getItem(CONKEY) === '1';
  function renderConsole() {
    if (!IS_OWNER || !LIVE) { console_.hidden = true; return; }
    console_.hidden = false;
    console_.classList.toggle('open', consoleOpen);
    if (!console_.dataset.built) {
      console_.innerHTML = `<button id="tc-toggle-btn" class="tc-bar"><span class="tc-title">⌘ Tasks &amp; changes</span><span class="tc-hint" id="tc-summary"></span><span class="tc-caret">▾</span></button>
        <div class="tc-panel">
          <div class="tc-col">
            <div class="chip-label">changes</div>
            <div id="apply-bar"></div>
          </div>
          <div class="tc-col tc-ask">
            <div class="chip-label">document-level task</div>
            <textarea id="tc-input" rows="2" placeholder="@claude verify every citation resolves… (⌘⏎ to send; needs an @tag)"></textarea>
            <div class="tc-acts"><button id="tc-send">send task</button>
              <span class="tc-note">anchored discussion belongs in comments — this is for the document as a whole.</span></div>
            <div id="tc-activity"></div>
          </div>
        </div>`;
      console_.dataset.built = '1';
      console_.querySelector('#tc-toggle-btn').addEventListener('click', () => {
        consoleOpen = !consoleOpen;
        localStorage.setItem(CONKEY, consoleOpen ? '1' : '0');
        renderConsole(); renderApplyBar();
      });
      const ta = console_.querySelector('#tc-input');
      const send = () => {
        const text = ta.value.trim();
        if (!text) return;
        if (!MENTION_RE.test(text)) { taskChip('add @claude, @codex or @all — nothing reaches an agent without an explicit tag', true); return; }
        ta.value = '';
        taskChip('<span class="spin">◐</span> sending…');
        api('/task', { method: 'POST', body: JSON.stringify({ mention_id: `task:${Date.now()}:${djb2(text)}`, text }) })
          .then(async r => {
            const j = await r.json().catch(() => ({}));
            if (r.status === 409) { setChatMode(false); taskChip('server not started with --chat', true); return; }
            if (!r.ok || j.queued === false) { taskChip(`task rejected${j.reason ? ': ' + j.reason : ''}`, true); return; }
            taskChip('queued — waiting for agents');
          }).catch(() => taskChip('server unreachable', true));
      };
      console_.querySelector('#tc-send').addEventListener('click', send);
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); }
      });
      ta.addEventListener('input', () => updateComposerWarn(console_.querySelector('.tc-ask'), ta));
    }
    // collapsed summary: the one line that says whether anything needs you
    const d = store();
    const byId = new Map(allSuggestions().map(c => [c.id, c]));
    const n = Object.keys(d).filter(id => byId.has(id) && !APPLY.applied[id] && decisionOf(id) === 'accepted').length;
    const sum = console_.querySelector('#tc-summary');
    if (sum) sum.textContent = APPLY.round ? 'applied, uncommitted' : n ? `${n} accepted, ready to apply` : '';
    syncTaskActivity();
  }
  function taskChip(html, err) {
    const a = activityOf(CONSOLE_ID);
    a.msg = html; a.err = !!err;
    a.working = !err && /queued|working|sending|landing|writing/i.test(html || '');
    syncTaskActivity();
  }
  function syncTaskActivity() {
    const el = console_.querySelector('#tc-activity');
    if (el) el.innerHTML = activityHtml(CONSOLE_ID);
  }

  renderPresence();

  if (LIVE) {
    // (the 🚩 "Flag for agents" button is gone: agents only ever engage via an
    // explicit @tag, so a second mechanism that merely wrote a file — while
    // looking like it summoned someone — was a lie in the UI.)
    const strip = document.createElement('div');
    strip.id = 'presence';
    foot.appendChild(strip);
    renderPresence();
    startHeartbeat();

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
      if (type === 'presence') { PEOPLE = msg.people || []; renderPresence(); renderPeople(); return; }
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
    if (a.notice) h += noticeHtml(a.notice.agent, a.notice.reason);
    if (a.msg) h += `<div class="status-chip${a.err ? ' err' : ''}">${a.msg}</div>`;
    return h;
  }
  function syncActivity(id) {
    // document-level task turns have no margin card — their activity (queue
    // chips, streaming reply, interrupts) renders inside the task console
    if (id === '__console__') { syncTaskActivity(); return; }
    const th = document.querySelector(threadSel(id));
    if (!th) return;
    th.querySelectorAll(':scope > .streaming, :scope > .status-chip, :scope > .perm-card, :scope > .exhaust-notice').forEach(x => x.remove());
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
    if (!text && !Object.keys(a.streams).length && !a.perm && !a.choice && !a.notice) delete ACTIVITY[cardId];
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
  // where a turn's live output renders: its margin thread, or — for a
  // document-level task console turn — the console's activity area
  const surfaceSel = tid => tid === '__console__' ? '#tc-activity' : threadSel(tid);
  const hasSurface = tid => !!(tid && document.querySelector(surfaceSel(tid)));
  const inlineStreamEl = (tid, key) =>
    document.querySelector(`${surfaceSel(tid)} [data-stream-key="${CSS.escape(key)}"] .stream-text`);
  // the bridge wraps every user turn in a protocol envelope (chat.mjs compose());
  // envelope echoes are never rendered anywhere
  const ENV_RE = /^\s*(?:\(→[^)\n]*\)\s*)?(?:@(?:claude|codex)\s+)?\[review chat/;
  function chatEvent(m) {
    const tid = m.target_id || null;
    setChatMode(m.kind !== 'bridge-exit'); // any chat event proves --chat; a dead bridge means agents are off
    if (m.kind === 'completion_context') {
      applyModelState({ scoped: (m.ev || {}).scoped });
      return;
    } else if (m.kind === 'status') {
      applyModelState({ status: m.ev || {} });
      return;
    }
    if (m.kind === 'turn-start') {
      if (m.user_text) LAST_USER_TEXT = m.user_text;
      presenceTurnStart(tid, m.user_text);
      if (tid) { activityOf(tid).streams = {}; chip(tid, '<span class="spin">◐</span> agents are working…'); }
      // unanchored turns (e.g. server transcript notes): presence strip only
    } else if (m.kind === 'turn-end') {
      presenceIdle();
      if (tid) chip(tid, 'reply landing…');
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
          // a finalized agent turn is the credit-exhaustion signal (or proof
          // it recovered): flag/clear the agent and raise/drop the notice
          const agent = who.toLowerCase().includes('codex') ? 'codex' : who.toLowerCase().includes('claude') ? 'claude' : null;
          if (agent) noteAgentTurn(agent, entry.text, tid);
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
      if (hasSurface(tid)) {
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
      if (hasSurface(tid)) { activityOf(tid).perm = m.ev; syncActivity(tid); }
      else interruptToast(permHtml(m.ev));
    } else if (m.kind === 'choice') {
      clearInterrupts('choice');
      if (m.ev.type !== 'choice_request') return;
      if (hasSurface(tid)) { activityOf(tid).choice = m.ev; syncActivity(tid); }
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

  // exposed for the DOM test harness
  window.__review = {
    chatEvent, applyModelState, renderModelSwitcher, switchModel,
    noteAgentTurn, exhaustReason, presendExhaustedFor, updateComposerWarn,
    openComposer, setChatMode, PRESENCE, MODELS,
  };
})();
