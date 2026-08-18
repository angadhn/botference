// botference council — browser client for the plan-mode bridge.
// One live event stream in (WS primary, SSE fallback; bridge events relayed
// verbatim plus a few server events), POSTs out (/input, /permission,
// /choice, /interrupt). Slash commands pass through verbatim: the controller
// parses them exactly as it does for the TUI.
//
// The server runs one bridge per OPEN CHAT. This tab attaches its stream to
// the bridge for the chat in the URL (#/chat/<id> -> ?chat=<id>), so two
// tabs on two chats are two concurrent sessions. Switching chats means
// RE-ATTACHING the stream, not asking a shared bridge to /resume.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const els = {
    side: $('side'), backdrop: $('backdrop'), burger: $('burger'), sideClose: $('side-close'),
    newChat: $('new-chat'), newProject: $('new-project'),
    newProjForm: $('new-project-form'), newProjTitle: $('new-project-title'),
    projects: $('projects'), theme: $('theme-toggle'),
    conn: $('st-conn'), stCtx: $('st-ctx'),
    agentCards: $('agent-cards'), agentsBody: $('agents-body'),
    agentsPanel: $('agents-panel'), agentsToggle: $('agents-toggle'),
    apFacts: $('ap-facts'), relayBoth: $('relay-both'), autoRelay: $('autorelay-toggle'),
    billing: $('billing'),
    presendWarn: $('presend-warn'),
    avatars: $('avatars'), banner: $('noauth-banner'), bannerX: $('noauth-x'),
    chat: $('chat'), transcript: $('transcript'), empty: $('empty'), jump: $('jump'),
    input: $('input'), send: $('send'), stop: $('stop'), complete: $('complete'),
    queueNote: $('queue-note'),
    attach: $('attach'), file: $('file'), attStrip: $('att-strip'),
    toast: $('toast'), sync: $('sync'),
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── theme: segmented sun/system/moon control (same pattern as review) ──
  const THEME_KEY = 'council-theme';
  const THEME_ICONS = {
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8"/></svg>',
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a7 7 0 0 0 10 10Z"/></svg>',
  };
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
  }
  function renderTheme() {
    const cur = localStorage.getItem(THEME_KEY) || 'system';
    els.theme.innerHTML = '<div class="chip-label">theme</div><div class="seg" role="group" aria-label="theme">' +
      ['light', 'system', 'dark'].map(m =>
        `<button class="seg-btn${m === cur ? ' on' : ''}" data-theme-opt="${m}" title="${m} theme" aria-label="${m} theme" aria-pressed="${m === cur}">${THEME_ICONS[m]}</button>`).join('') +
      '</div>';
  }
  els.theme.addEventListener('click', e => {
    const b = e.target.closest('[data-theme-opt]');
    if (!b) return;
    localStorage.setItem(THEME_KEY, b.dataset.themeOpt);
    applyTheme(b.dataset.themeOpt);
    renderTheme();
  });
  applyTheme(localStorage.getItem(THEME_KEY) || 'system');
  renderTheme();

  // ── participant brand marks (Simple Icons path data, inlined; same
  // constant the review frontend ships) ──
  const MARKS = {
    claude: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
    codex: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  };
  const AGENTS = ['claude', 'codex'];
  const other = a => (a === 'claude' ? 'codex' : 'claude');
  const cap = a => a[0].toUpperCase() + a.slice(1);
  const avatarHtml = a =>
    `<span class="avatar" style="--author:var(--${a})" aria-hidden="true">${MARKS[a] || ''}</span>`;

  // ── credit-exhaustion detection ──
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
  // fallback model lists if completion_context never arrived (offline-ish boot)
  const FALLBACK_MODELS = {
    claude: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    codex: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'],
  };
  // fallback completion context: the bridge emits completion_context exactly
  // once at startup, so a client that connects after the server's history was
  // wiped (chat switch) or front-trimmed (long chat) never receives it — and
  // without one, slash-command autocomplete goes dark. Seed the mirror of
  // core/botference.py get_completion_context(); the live event replaces it
  // wholesale whenever it does arrive.
  const FALLBACK_CTX = {
    global: [
      '/lead @claude', '/lead @codex', '/relay @claude', '/relay @codex',
      '/relay @both', '/tag @claude', '/tag @codex', '/tag @both',
      '/model @claude', '/model @codex',
      '/effort @claude', '/effort @codex', '/compact @claude', '/compact @codex',
      '/goal @claude', '/goal @codex',
      '/projects', '/project', '/adopt', '/new', '/file', '/add-to-project',
      '/delete', '/archive', '/unarchive',
      '/draft', '/finalize', '/resume', '/rename', '/permissions',
      '/status', '/notify', '/autorelay', '/agents', '/auth', '/current-model', '/current',
      '/help', '/quit', '/exit', '@claude ', '@codex ', '@all ',
    ],
    scoped: {
      '/project ': ['open', 'clear', 'current', 'create', 'create-from-chat',
        'assign', 'archive', 'unarchive', 'activate-build'],
      '/model @claude ': FALLBACK_MODELS.claude,
      '/model @codex ': FALLBACK_MODELS.codex,
      '/effort @claude ': ['low', 'medium', 'high', 'xhigh'],
      '/effort @codex ': ['minimal', 'low', 'medium', 'high', 'max'],
    },
  };
  const FALLBACK_EFFORT = {
    claude: ['low', 'medium', 'high', 'xhigh'],
    codex: ['minimal', 'low', 'medium', 'high', 'max'],
  };
  const modelsFor = agent => {
    const scoped = state.ctx.scoped || {};
    const list = scoped[`/model @${agent} `];
    return (Array.isArray(list) && list.length) ? list : FALLBACK_MODELS[agent];
  };
  // reasoning effort, the second half of "how hard does this agent think" —
  // the same list the controller validates against (/effort @<agent> <level>)
  const effortsFor = agent => {
    const scoped = state.ctx.scoped || {};
    const list = scoped[`/effort @${agent} `];
    return (Array.isArray(list) && list.length) ? list : FALLBACK_EFFORT[agent];
  };
  // which agents a composed message actually addresses (explicit @mentions;
  // @all — or plain text with no tag — reaches both)
  function mentionedAgents(text) {
    const t = String(text || '');
    if (/@all\b/i.test(t)) return AGENTS.slice();
    const hit = AGENTS.filter(a => new RegExp('@' + a + '\\b', 'i').test(t));
    return hit.length ? hit : AGENTS.slice();
  }
  // empty state gets the two participant marks side by side
  const emptyMarks = document.querySelector('.empty-marks');
  if (emptyMarks) emptyMarks.innerHTML = AGENTS.map(avatarHtml).join('');

  // ── state ──
  const state = {
    busy: false, queued: 0, agents: { claude: false, codex: false },
    streams: {},           // key "model:stream_id" -> {el, text}
    ctx: FALLBACK_CTX,
    models: { claude: null, codex: null },     // current model per agent (from status)
    effort: { claude: null, codex: null },     // current reasoning effort (from status)
    exhausted: { claude: null, codex: null },  // credit-exhaustion reason string or null
    autoRelay: true,                           // auto-relay at 50% context (from status)
    ctxStat: { claude: null, codex: null },    // {pct, tokens, window} per agent (from status)
    relay: { claude: null, codex: null },      // {at, tier} last-relay provenance (from status)
    activity: { claude: null, codex: null },   // latest tool label while an agent works
    facts: { mode: '', lead: '', route: '', project: '' },  // session facts (from status)
    lastUserText: '',                          // last human turn, for "retry with @other"
    sendOverride: false,                       // one-shot "send anyway" past the pre-send warning
    projects: null,
    openProjects: new Set(),   // expanded projects (any project, active or not)
    lastActivePid: null,       // active project at the last 'projects' event
    menuSid: null,         // chat row whose ⋯ actions menu is open
    archOpen: false,       // "Archived" projects section expanded?
    inServerReplay: true,  // between (re)connect and the server's replay_done boundary
    replaying: false,      // between clear_panes (resume/new) and the bridge's next ready
    pendingSwitch: null,   // session id of an in-flight sidebar chat switch
    currentSid: null,      // active session id (from 'projects' events)
    routeErrorSid: null,   // chat id the server just refused (route_error)
    bridgeId: null,        // this tab's bridge (from 'hello'); named in every POST
    resuming: false,       // the attached bridge is still executing its spawn-time /resume
    atts: [],              // composer attachments: {id, path, url, thumb, status}
    lanes: {},             // subagent progress lane: tool_use_id -> lane record
    laneCard: null,        // the in-progress turn's lane card element (null between turns)
    laneTimer: null,       // interval ticking the running lanes' elapsed clocks
  };
  // switching chats re-attaches this tab's stream to another bridge, and the
  // authoritative transcript arrives as that bridge's history replay. This is
  // an honest client-side cache of the last few rendered transcripts —
  // instant optimistic paint on switch, reconciled when the replay lands.
  // Bounded LRU.
  const CACHE_MAX = 5;
  const sessionCache = new Map(); // sid -> {html, scrollTop, atBottom}
  function cachePut(sid, entry) {
    if (!sid) return;
    sessionCache.delete(sid);
    sessionCache.set(sid, entry);
    while (sessionCache.size > CACHE_MAX) sessionCache.delete(sessionCache.keys().next().value);
  }
  function cacheGet(sid) {
    const e = sessionCache.get(sid);
    if (e) { sessionCache.delete(sid); sessionCache.set(sid, e); } // LRU touch
    return e || null;
  }

  function renderAvatars() {
    els.avatars.innerHTML = AGENTS.map(a => {
      const name = cap(a);
      const on = state.agents[a];
      const ex = state.exhausted[a];
      const tip = ex ? `${name} is out of credits — ${ex}` : `${name}${on ? ' is working…' : ' — idle'}`;
      return `<span class="avatar-ring${on ? ' working' : ''}${ex ? ' exhausted' : ''}" style="--author:var(--${a})" title="${esc(tip)}">${avatarHtml(a)}${ex ? '<span class="warn-badge" aria-hidden="true">⚠</span>' : ''}</span>`;
    }).join('');
  }
  renderAvatars();

  // ── agents panel: per-agent condition dashboard + controls ──
  // Right rail on wide desktop; reparents into the sidebar drawer below the
  // breakpoint so the hamburger carries it on mobile. Each card: activity,
  // model <select>, context gauge (rounded % + compact tokens, auto-relay
  // threshold tick), relay button, and relay provenance ("memory freshness").
  const AUTORELAY_PCT = 50;  // mirrors AUTO_RELAY_THRESHOLD_PCT in the controller
  function fmtTok(n) {
    if (n == null) return '—';
    if (n >= 1e6) return String(Math.round(n / 1e5) / 10).replace(/\.0$/, '') + 'm';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }
  function relAgo(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!isFinite(ms) || ms < 0) return null;
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  }
  function agentCard(a) {
    const cur = state.models[a] || '';
    const ex = state.exhausted[a];
    const st = state.ctxStat[a];
    const pct = st && st.pct != null ? Math.max(0, Math.min(100, st.pct)) : null;
    const working = state.agents[a];
    const activity = ex ? '⚠ out of credits'
      : working ? (state.activity[a] || 'working…') : 'idle';
    const opts = modelsFor(a).map(m =>
      `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('');
    // effort: the level the model thinks at, on the row under the model it
    // belongs to (same pairing the plugin's agent panel uses). A bridge that
    // never reports one still offers the levels — the controller validates.
    const eff = state.effort[a] || '';
    // the "(default)" row only exists while the bridge has not told us a level
    // — once it has, every option in the list is a real one you can pick
    const effOpts = (eff ? '' : '<option value="" selected>(default)</option>') +
      effortsFor(a).map(l =>
        `<option value="${esc(l)}"${l === eff ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const rl = state.relay[a];
    const ago = rl && rl.at ? relAgo(rl.at) : null;
    const fresh = ago ? `memory reset ${ago}${rl.tier ? ` · ${rl.tier} handoff` : ''}`
      : 'no relay yet this session';
    const level = pct == null ? '' : pct >= 75 ? ' hot' : pct >= AUTORELAY_PCT ? ' warm' : '';
    return `<div class="agent-card${ex ? ' exhausted' : ''}" data-agent="${a}">
      <div class="ac-head">
        <span class="ms-mark" style="--author:var(--${a})">${avatarHtml(a)}</span>
        <span class="ac-name">${cap(a)}${ex ? '<span class="warn-badge" title="out of credits">⚠</span>' : ''}</span>
        <span class="ac-activity${working ? ' on' : ''}" title="${esc(activity)}">${esc(activity)}</span>
      </div>
      <label class="ac-pick"><span>model</span>
        <select class="ms-select" data-agent="${a}" aria-label="${cap(a)} model">${opts}</select></label>
      <label class="ac-pick"><span>effort</span>
        <select class="ms-select ef-select" data-effort="${a}" aria-label="${cap(a)} reasoning effort">${effOpts}</select></label>
      <div class="ac-gauge${level}" role="img"
        aria-label="${cap(a)} context ${pct == null ? 'unknown' : Math.round(pct) + '%'}">
        <div class="ac-fill" style="width:${pct == null ? 0 : pct}%"></div>
        <span class="ac-tick" title="auto-relay at ${AUTORELAY_PCT}%"></span>
      </div>
      <div class="ac-meta">
        <span class="ac-pct">${pct == null ? '—' : Math.round(pct) + '%'}</span>
        <span class="ac-tok">${st && st.tokens != null ? `${fmtTok(st.tokens)} / ${fmtTok(st.window)}` : ''}</span>
        <button class="ac-relay" data-relay="${a}"
          title="Reset ${cap(a)}'s session with a structured handoff">↻ relay</button>
      </div>
      <div class="ac-fresh" title="when this agent's session memory last restarted, and which handoff tier wrote it">${esc(fresh)}</div>
    </div>`;
  }
  function renderAgentsPanel() {
    if (els.agentCards) els.agentCards.innerHTML = AGENTS.map(agentCard).join('');
    if (els.apFacts) {
      const f = state.facts;
      const bits = [];
      if (f.project) bits.push(['project', f.project]);
      if (f.mode) bits.push(['mode', f.mode]);
      if (f.lead) bits.push(['lead', f.lead]);
      if (f.route) bits.push(['route', f.route]);
      els.apFacts.innerHTML = bits.map(([k, v]) =>
        `<span class="fact"><b>${k}</b>${esc(v)}</span>`).join('');
    }
  }
  // kept name: exhaustion/ctx call sites re-render the panel through this
  const renderModelSwitcher = renderAgentsPanel;
  function switchModel(agent, model) {
    if (!model) return;
    // optimistic: clear the exhausted flag now, re-flag if the next turn recurs.
    // The authoritative current model lands on the next status event.
    clearExhausted(agent);
    sendInput(`/model @${agent} ${model}`);
  }
  // effort rides the same road as the model switch: a plain slash command
  // through the input path, reconciled by the next status event
  function switchEffort(agent, level) {
    if (!agent || !level) return;
    state.effort[agent] = level;   // optimistic; status is the authority
    sendInput(`/effort @${agent} ${level}`);
  }
  if (els.agentCards) {
    els.agentCards.addEventListener('change', e => {
      const ef = e.target.closest('select[data-effort]');
      if (ef) { switchEffort(ef.dataset.effort, ef.value); return; }
      const sel = e.target.closest('select.ms-select');
      if (sel) switchModel(sel.dataset.agent, sel.value);
    });
    els.agentCards.addEventListener('click', e => {
      const b = e.target.closest('[data-relay]');
      if (b) sendInput(`/relay @${b.dataset.relay}`);
    });
  }
  if (els.relayBoth) els.relayBoth.addEventListener('click', () => sendInput('/relay @both'));
  // narrow screens: the panel is a RIGHT-side drawer with its own toggle —
  // the left drawer stays purely projects and chats. Wide desktop shows the
  // panel as a static right rail and hides the toggle (CSS).
  function openAgents() {
    document.body.classList.add('agents-open');
    els.backdrop.hidden = false;
    if (els.agentsToggle) els.agentsToggle.setAttribute('aria-expanded', 'true');
  }
  function closeAgents() {
    if (!document.body.classList.contains('agents-open')) return;
    document.body.classList.remove('agents-open');
    if (!document.body.classList.contains('side-open')) els.backdrop.hidden = true;
    if (els.agentsToggle) els.agentsToggle.setAttribute('aria-expanded', 'false');
  }
  if (els.agentsToggle) {
    els.agentsToggle.addEventListener('click', () => {
      document.body.classList.contains('agents-open') ? closeAgents() : openAgents();
    });
  }
  els.backdrop.addEventListener('click', closeAgents);
  setInterval(renderAgentsPanel, 60000);  // keep "memory reset Xm ago" honest
  renderAgentsPanel();

  // ── auto-relay toggle (sidebar) ──
  // Segmented on/off; sends "/autorelay on|off" through the normal input path.
  // The authoritative state lands on the next status event (state.autoRelay).
  function renderAutoRelay() {
    if (!els.autoRelay) return;
    const on = state.autoRelay;
    els.autoRelay.innerHTML =
      '<div class="chip-label">auto-relay</div>' +
      '<div class="seg" role="group" aria-label="auto-relay at 50% context">' +
      [['on', on], ['off', !on]].map(([v, sel]) =>
        `<button class="seg-btn${sel ? ' on' : ''}" data-ar="${v}" ` +
        `aria-pressed="${sel}" title="auto-relay ${v}">${v}</button>`).join('') +
      '</div>';
  }
  if (els.autoRelay) {
    els.autoRelay.addEventListener('click', e => {
      const b = e.target.closest('[data-ar]');
      if (!b) return;
      state.autoRelay = b.dataset.ar === 'on';  // optimistic; status reconciles
      renderAutoRelay();
      sendInput(`/autorelay ${b.dataset.ar}`);
    });
  }
  renderAutoRelay();

  // ── billing (agents panel) ──
  // What each agent's CLI bills: the subscription it is logged into, or an API
  // key stored on the server's machine. Three modes, the default being Claude
  // Code's own rule — `auto` uses a stored key and falls back to the
  // subscription when there is none.
  //
  // The switch is a preference and works from anywhere the password does. A
  // KEY is not: the server refuses to store one that arrived through the
  // tunnel, so the fields only exist when this page is open on the machine the
  // server runs on, and the panel says so when it is not. Keys are never sent
  // back here — /keys answers "set" or "unset", nothing more.
  const BILL_MODES = [
    ['auto', 'auto', 'a saved key if there is one, otherwise the subscription'],
    ['subscription', 'subscription', 'never a key, even when one is saved'],
    ['key', 'API key', 'always the saved key'],
  ];
  let keyInfo = null;   // last /keys snapshot: {claude,codex,modes,local,overrides_login}
  function billResolve(agent) {
    const mode = (keyInfo.modes && keyInfo.modes[agent]) || 'auto';
    const set = keyInfo[agent] === 'set';
    return { mode, set, eff: mode === 'auto' ? (set ? 'key' : 'subscription') : mode };
  }
  function renderBilling() {
    if (!els.billing) return;
    if (!keyInfo) { els.billing.innerHTML = ''; return; }
    const local = !!keyInfo.local;
    const rows = AGENTS.map(a => {
      const { mode, set, eff } = billResolve(a);
      // codex is the honest exception: its stored ChatGPT login beats a key in
      // the environment, so a key there is a fallback, not an override
      const overrides = !keyInfo.overrides_login || keyInfo.overrides_login[a] !== false;
      const caveat = eff === 'key' && set && !overrides
        ? `${cap(a)} only falls back to the key when it is not logged in — the login wins otherwise`
        : '';
      const seg = BILL_MODES.map(([v, label, tip]) => {
        const on = v === mode;
        const off = v === 'key' && !set;
        return `<button class="seg-btn${on ? ' on' : ''}" data-bill="${a}" data-mode="${v}"` +
          ` aria-pressed="${on}"${off ? ' disabled' : ''}` +
          ` title="${esc(off ? `no ${a} key saved yet` : tip)}">${esc(label)}</button>`;
      }).join('');
      const keyRow = local ? `<div class="bill-key">
        <input type="password" class="bill-input" data-key="${a}" autocomplete="off"
          spellcheck="false" placeholder="${a === 'claude' ? 'sk-ant-…' : 'sk-…'}"
          aria-label="${cap(a)} API key">
        <button class="bill-btn" data-save="${a}">save</button>
        ${set ? `<button class="bill-btn" data-rm="${a}">remove</button>` : ''}
      </div>` : '';
      return `<div class="bill-row" data-agent="${a}">
        <div class="bill-head">
          <span class="ms-mark" style="--author:var(--${a})">${avatarHtml(a)}</span>
          <span class="bill-name">${cap(a)}</span>
          <span class="bill-state">${set ? 'key saved' : 'no key'}</span>
        </div>
        <div class="seg" role="group" aria-label="${cap(a)} billing">${seg}</div>
        <div class="bill-eff">bills ${eff === 'key' ? 'the API key' : 'the subscription'}</div>
        ${caveat ? `<div class="bill-caveat">${esc(caveat)}</div>` : ''}
        ${keyRow}</div>`;
    }).join('');
    const where = local
      ? 'Keys live in a 0600 file on this machine, shared with Discuss, and are never sent back to this page.'
      : 'Add keys from the Mac the server runs on — a key typed here would cross the tunnel, so the server refuses it.';
    els.billing.innerHTML = rows +
      `<div class="bill-note">${esc(where)}</div>` +
      '<div class="bill-note">Applies to agents started from now on — a chat already running keeps the billing it started with.</div>';
  }
  async function billFetch(url, opts) {
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch { }
    if (r.status >= 400 || !j || j.ok === false) return { err: (j && j.error) || 'that did not work' };
    return { j };
  }
  async function loadBilling() {
    if (typeof fetch !== 'function') return;
    try {
      const { j } = await billFetch('/keys');
      // a boot snapshot never overwrites an answer from a change the reader
      // has already made — the write's own response is the fresher truth
      if (!j || keyInfo) return;
      keyInfo = j;
      renderBilling();
    } catch { /* offline: the section simply stays empty */ }
  }
  async function billPost(url, body, note) {
    const { j, err } = await billFetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!j) { toast(err); return null; }
    keyInfo = { ...keyInfo, ...j };
    renderBilling();
    // honest about when it bites: the env of a running process cannot change
    if (note) toast(j.applies === 'now' ? note : `${note} — from the next agent start`);
    return j;
  }
  if (els.billing) {
    els.billing.addEventListener('click', e => {
      const seg = e.target.closest('[data-bill]');
      if (seg) {
        const { bill: agent, mode } = seg.dataset;
        if (billResolve(agent).mode === mode) return;
        billPost('/key-mode', { agent, mode }, `${cap(agent)}: ${mode}`);
        return;
      }
      const save = e.target.closest('[data-save]');
      if (save) {
        const a = save.dataset.save;
        const input = els.billing.querySelector(`input[data-key="${a}"]`);
        const key = input ? input.value.trim() : '';
        if (!key) { toast('paste a key first'); return; }
        if (input) input.value = '';   // never leave a key sitting in the DOM
        billPost('/keys', { agent: a, key }, `${cap(a)} key saved`);
        return;
      }
      const rm = e.target.closest('[data-rm]');
      if (rm) billPost('/keys/remove', { agent: rm.dataset.rm }, `${cap(rm.dataset.rm)} key removed`);
    });
  }
  loadBilling();

  // flag/clear an agent as out-of-credits, updating avatars + switcher + notice
  function flagExhausted(agent, reason) {
    const was = state.exhausted[agent];
    state.exhausted[agent] = reason;
    renderAvatars();
    renderModelSwitcher();
    refreshPresendWarn();
    if (!was) exhaustNotice(agent, reason); // one notice per exhaustion episode
  }
  function clearExhausted(agent) {
    if (!state.exhausted[agent]) return;
    state.exhausted[agent] = null;
    renderAvatars();
    renderModelSwitcher();
    refreshPresendWarn();
  }
  // an agent's finished turn: exhaustion message → flag; any other normal
  // output → the agent is answering again, so clear.
  function noteAgentTurn(agent, text) {
    if (!AGENTS.includes(agent)) return;
    state.activity[agent] = null;  // its turn ended
    const reason = exhaustReason(agent, text);
    if (reason) flagExhausted(agent, reason);
    else if (String(text || '').trim()) clearExhausted(agent);
    renderAgentsPanel();
  }

  // message-level notice at the point of use: switch the model right here, or
  // retry the last turn with the other agent. Dismissible; never blocks.
  function exhaustNotice(agent, reason) {
    const o = other(agent);
    const opts = modelsFor(agent).map(m =>
      `<option value="${esc(m)}"${m === state.models[agent] ? ' selected' : ''}>${esc(m)}</option>`).join('');
    const div = document.createElement('div');
    div.className = 'msg notice exhaust';
    div.dataset.agent = agent;
    div.innerHTML = `<div class="notice-head">${avatarHtml(agent)}
      <span>⚠ ${cap(agent)} is out of credits — switch its model or tag @${o}</span>
      <button class="notice-x" title="dismiss" aria-label="dismiss">✕</button></div>
      <div class="notice-why">${esc(reason)}</div>
      <div class="notice-acts">
        <label class="notice-switch">switch <select class="ms-select" data-agent="${agent}" aria-label="${cap(agent)} model">${opts}</select></label>
        <button class="notice-retry" data-retry="${o}">↻ retry with @${o}</button>
      </div>`;
    div.querySelector('.notice-x').addEventListener('click', () => div.remove());
    div.querySelector('.ms-select').addEventListener('change', e => switchModel(agent, e.target.value));
    div.querySelector('.notice-retry').addEventListener('click', () => {
      const body = state.lastUserText.replace(/@(claude|codex|all)\b/gi, '').trim();
      sendInput(`@${o} ${body}`.trim());
    });
    const wasPinned = pinned();
    container().appendChild(div);
    if (!replayBuffer) { updateEmpty(); follow(wasPinned); }
  }

  // ── pre-send exhaustion guard ──
  // agents this text would reach that are currently out of credits: an explicit
  // @mention of one, or (for @all / untagged text) only when EVERY reachable
  // agent is exhausted — i.e. the message would truly go into a void.
  function presendExhausted(text) {
    const t = String(text || '');
    const explicit = AGENTS.filter(a =>
      new RegExp('@' + a + '\\b', 'i').test(t) && state.exhausted[a]);
    if (explicit.length) return explicit;
    const reach = mentionedAgents(t);
    return reach.every(a => state.exhausted[a]) ? reach.filter(a => state.exhausted[a]) : [];
  }
  function refreshPresendWarn() {
    if (!els.presendWarn) return;
    if (state.sendOverride) { els.presendWarn.hidden = true; els.presendWarn.innerHTML = ''; return; }
    const flagged = presendExhausted(els.input.value);
    if (!flagged.length) { els.presendWarn.hidden = true; els.presendWarn.innerHTML = ''; return; }
    const a = flagged[0], o = other(a);
    const opts = modelsFor(a).map(m =>
      `<option value="${esc(m)}"${m === state.models[a] ? ' selected' : ''}>${esc(m)}</option>`).join('');
    els.presendWarn.innerHTML = `<div class="pw-msg">⚠ ${cap(a)} is out of credits — it won't reply. Switch its model or tag @${o} instead.</div>
      <div class="pw-acts">
        <label class="notice-switch">switch <select class="ms-select" data-agent="${a}" aria-label="${cap(a)} model">${opts}</select></label>
        <button class="pw-tag" data-tag="${o}">tag @${o}</button>
        <button class="pw-send">send anyway</button>
      </div>`;
    els.presendWarn.hidden = false;
    els.presendWarn.querySelector('.ms-select').addEventListener('change', e => switchModel(a, e.target.value));
    els.presendWarn.querySelector('.pw-tag').addEventListener('click', () => {
      els.input.value = els.input.value.replace(new RegExp('@' + a + '\\b', 'gi'), '@' + o);
      if (!new RegExp('@' + o + '\\b', 'i').test(els.input.value)) els.input.value = `@${o} ` + els.input.value.trim();
      autosize(); refreshPresendWarn(); syncSend(); els.input.focus();
    });
    els.presendWarn.querySelector('.pw-send').addEventListener('click', () => {
      state.sendOverride = true; refreshPresendWarn(); submit();
    });
  }

  function setBusy(b) {
    state.busy = b;
    els.stop.hidden = !b;
    if (!b) {
      for (const a of AGENTS) { state.agents[a] = false; state.activity[a] = null; }
      renderAvatars();
      renderAgentsPanel();
    }
  }

  // ── transcript ──
  // ── room-protocol envelopes ──────────────────────────────────────────────
  // Free-form mode tells each bot to end its turn with a JSON footer
  // {"status","next","writer","summary"} (core/room_prompts.py). The
  // controller strips a well-formed TRAILING one before it emits 'room', but
  // live stream deltas still carry it, and a bot that pretty-prints it, fences
  // it, or drops it mid-message slips straight through into the prose. So lift
  // every envelope out of the text wherever it sits — start, middle or end —
  // and render it as a subdued status line instead of leaking raw JSON.
  const ENV_KEYS = new Set(['status', 'next', 'writer', 'summary']);
  const isEnvelope = v =>
    v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.status === 'string' &&
    ('next' in v || 'summary' in v) &&
    Object.keys(v).every(k => ENV_KEYS.has(k));
  // brace-balanced read of the JSON object starting at s[at] ('{'), honouring
  // strings and escapes so a "}" inside a summary can't end it early
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
    return null;   // unterminated (mid-stream, or not JSON at all)
  }
  // a half-streamed envelope at the very end: "{"status": "cont…" with no
  // closing brace yet, optionally under a ```json fence that hasn't closed
  const PARTIAL_ENV = /(?:```(?:json)?[ \t]*\r?\n)?[ \t]*\{[ \t\r\n]*"(?:status|next|writer|summary)"[ \t]*:[^{}]*$/;
  // how far past a '{' the "status" key may sit before we stop believing this
  // is an envelope — also what keeps a message full of JSON from costing a
  // balanced-brace scan per opening brace on every streamed delta
  const ENV_LOOKAHEAD = 600;
  // text -> {text, envs}: prose with every envelope lifted out, in order
  function splitEnvelopes(raw) {
    const s = String(raw ?? '');
    const envs = [];
    let out = '', i = 0;
    for (;;) {
      const j = s.indexOf('{', i);
      if (j < 0) { out += s.slice(i); break; }
      if (!/"status"[ \t]*:/.test(s.slice(j, j + ENV_LOOKAHEAD))) {
        out += s.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      const got = readObject(s, j);
      if (got && isEnvelope(got.value)) {
        let start = j, end = got.end;
        // swallow a ```json fence wrapped tightly around it, and the blank
        // line the footer sat on, so no orphan fence or gap is left behind
        const open = /```(?:json)?[ \t]*\r?\n[ \t]*$/.exec(s.slice(0, start));
        if (open) start = open.index;
        const close = /^[ \t]*(?:\r?\n[ \t]*)?```[ \t]*/.exec(s.slice(end));
        if (open && close) end += close[0].length;
        out += s.slice(i, start);
        envs.push(got.value);
        i = end;
        continue;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
    }
    out = out.replace(PARTIAL_ENV, '');
    // an envelope on its own line leaves a blank line behind it: close the gap
    // so the prose doesn't grow a hole where the JSON used to be. Only when
    // something was actually removed — a message with no footer keeps its own
    // blank lines exactly as written, fenced code included.
    if (envs.length) out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return { text: out.trim(), envs };
  }

  // ── markdown → DOM ───────────────────────────────────────────────────────
  // Ported from the plugin drawer's renderer (frontends/plugin/extension/
  // drawer.js): every node is built with createElement + textContent, so no
  // HTML string ever carries message content and markup inside a message can
  // never become markup on the page. Council additions: GFM tables (kept from
  // the string renderer this replaced) and checkbox state persistence.
  // Deliberately small: fenced code, `- `/`1. ` lists, `- [ ]` checkboxes,
  // #-headings, tables, blank-line paragraphs, [text](http…), bare http(s)
  // urls, **bold**, *italic*, `code`. Anything else stays literal.
  // http(s), plus root-relative paths ("/files/…") served by this origin —
  // but not protocol-relative "//host", which is a cross-origin url in disguise
  const SAFE_URL = /^(https?:\/\/|\/(?!\/))/i;
  const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
  const BULLET = /^[ \t]*[-*+]\s+(.*)$/;
  const NUMBER = /^[ \t]*(\d{1,9})[.)]\s+(.*)$/;
  const TASK = /^\[([ xX])\]\s+(.*)$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const QUOTE = /^\s{0,3}>\s?/;
  // one alternation, tried left to right: code spans win over emphasis, so
  // `**not bold**` in backticks stays literal, and the bare url comes LAST so
  // a [text](url) link is never autolinked twice
  const INLINE = /(`+)([\s\S]*?)\1|\[([^\]\n]*)\]\(\s*([^()\s]+)\s*\)|\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*|(https?:\/\/[^\s`<>*]+)/;
  const URL_TAIL = /[.,;:!?'"\)\]\}]+$/;
  const mk = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  function anchor(href, label) {
    const a = mk('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    a.textContent = label;
    return a;
  }
  function mdInline(text, out) {
    let s = String(text == null ? '' : text);
    for (let guard = 0; guard < 2000; guard++) {
      const m = INLINE.exec(s);
      if (!m) break;
      if (m.index) out.appendChild(document.createTextNode(s.slice(0, m.index)));
      if (m[2] !== undefined) {
        const c = mk('code');
        c.textContent = m[2].replace(/^ (.*) $/, '$1');
        out.appendChild(c);
      } else if (m[3] !== undefined) {
        // anything that is not plain http(s) — javascript:, data:, mailto: —
        // is never linkified; the source text shows as it was written
        if (SAFE_URL.test(m[4])) out.appendChild(anchor(m[4], m[3] || m[4]));
        else out.appendChild(document.createTextNode(m[0]));
      } else if (m[5] !== undefined) mdInline(m[5], out.appendChild(mk('strong')));
      else if (m[6] !== undefined) mdInline(m[6], out.appendChild(mk('em')));
      else if (m[7] !== undefined) {
        // a pasted url: same rules as a markdown link, minus the sentence
        // punctuation that trails it ("see https://x.example/a.")
        let url = m[7], tail = '';
        const t = URL_TAIL.exec(url);
        if (t) { tail = t[0]; url = url.slice(0, -tail.length); }
        if (SAFE_URL.test(url) && url.length > 'https://'.length) out.appendChild(anchor(url, url));
        else out.appendChild(document.createTextNode(url));
        if (tail) out.appendChild(document.createTextNode(tail));
      }
      s = s.slice(m.index + m[0].length);
    }
    if (s) out.appendChild(document.createTextNode(s));
    return out;
  }
  // GFM tables: a header row with |, a delimiter row of ---, then body rows
  const splitRow = line => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
  };
  const isDelimRow = line =>
    /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|') &&
    splitRow(line).every(c => /^:?-+:?$/.test(c));
  const isTableStart = (lines, i) =>
    lines[i].includes('|') && i + 1 < lines.length && isDelimRow(lines[i + 1]);
  const isBlockStart = (lines, i) => {
    const l = lines[i];
    return FENCE.test(l) || BULLET.test(l) || NUMBER.test(l) || HEADING.test(l) ||
      QUOTE.test(l) || !l.trim() || isTableStart(lines, i);
  };
  // checkbox ordinal within its message, counted in document order — the key
  // the tick store persists against. Reset per renderMarkdown() call.
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
        i++;                                   // the closing fence, if there is one
        const pre = mk('pre');
        if (fence[2]) pre.setAttribute('data-lang', fence[2]);
        const code = mk('code');
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      const head = HEADING.exec(line);
      if (head) {
        const h = mk('div', 'md-h md-h' + head[1].length);
        mdInline(head[2], h);
        frag.appendChild(h);
        i++;
        continue;
      }

      if (isTableStart(lines, i)) {
        const align = splitRow(lines[i + 1]).map(c =>
          /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : '');
        const wrap = mk('div', 'tbl-wrap');
        const table = wrap.appendChild(mk('table'));
        const row = (parent, tag, cells) => {
          const tr = parent.appendChild(mk('tr'));
          cells.forEach((c, k) => {
            const cell = tr.appendChild(mk(tag));
            if (align[k]) cell.setAttribute('style', `text-align:${align[k]}`);
            mdInline(c, cell);
          });
        };
        row(table.appendChild(mk('thead')), 'th', splitRow(line));
        const tbody = table.appendChild(mk('tbody'));
        let j = i + 2;
        while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
          row(tbody, 'td', splitRow(lines[j])); j++;
        }
        frag.appendChild(wrap);
        i = j;
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
          while (i < lines.length && !isBlockStart(lines, i)) txt += ' ' + lines[i++].trim();
          const task = TASK.exec(txt);
          const li = list.appendChild(mk('li'));
          if (!task) { mdInline(txt, li); continue; }
          tasks++;
          const box = mk('input', 'md-tick');
          box.type = 'checkbox';
          box.checked = task[1] !== ' ';
          box.setAttribute('data-tick', String(taskSeq++));
          box.setAttribute('aria-label', task[2]);
          li.className = 'md-task' + (box.checked ? ' done' : '');
          li.appendChild(box);
          mdInline(task[2], li.appendChild(mk('span', 'md-tasktext')));
        }
        // a list of checkboxes carries its own markers; the bullets would be
        // a second, quieter bullet in front of every one of them
        if (tasks) list.classList.add('md-tasklist');
        frag.appendChild(list);
        continue;
      }

      // "> " lines are a handed-over draft ("Suggested reply:") — a real
      // blockquote, not literal angle brackets. Consecutive quoted lines are
      // one quote; a blank quoted line ("> ") splits paragraphs inside it.
      // paint() dresses the box and gives it its own copy button.
      if (QUOTE.test(line)) {
        const bq = mk('blockquote');
        let para = [];
        const flush = () => {
          if (para.length) mdInline(para.join('\n'), bq.appendChild(mk('p', 'md-p')));
          para = [];
        };
        while (i < lines.length && QUOTE.test(lines[i])) {
          const l = lines[i++].replace(QUOTE, '');
          if (!l.trim()) flush(); else para.push(l);
        }
        flush();
        frag.appendChild(bq);
        continue;
      }

      const buf = [];
      while (i < lines.length && !isBlockStart(lines, i)) buf.push(lines[i++]);
      mdInline(buf.join('\n'), frag.appendChild(mk('p', 'md-p')));
    }
    return frag;
  }
  // string form, for the DOM test harness and anything that still wants HTML
  function fmt(text) {
    const d = document.createElement('div');
    d.appendChild(renderMarkdown(text));
    return d.innerHTML;
  }

  // ── checklist state ──────────────────────────────────────────────────────
  // The council has no server-side per-message store (the plugin's companion
  // rewrites the brackets in the message text; nothing here can), so a tick
  // lives in localStorage keyed by a hash of the message it belongs to. That
  // key is stable across replays, reloads and chat switches — the same text
  // renders the same ticks — and a message the agent later rewrites simply
  // hashes differently and starts clean.
  const TICK_KEY = 'council-ticks';
  const TICK_MAX = 400;
  let tickStore = null;
  function ticks() {
    if (!tickStore) {
      try { tickStore = JSON.parse(localStorage.getItem(TICK_KEY)) || {}; } catch { tickStore = {}; }
    }
    return tickStore;
  }
  function saveTicks() {
    const st = ticks();
    const keys = Object.keys(st);
    if (keys.length > TICK_MAX) {
      keys.sort((a, b) => (st[a].at || 0) - (st[b].at || 0));
      for (const k of keys.slice(0, keys.length - TICK_MAX)) delete st[k];
    }
    try { localStorage.setItem(TICK_KEY, JSON.stringify(st)); } catch { }
  }
  // FNV-1a, base36 — short, stable, and nothing depends on it being secure
  function hashText(s) {
    let h = 0x811c9dc5;
    const t = String(s);
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }
  // the record is the WHOLE tick state of the message, not a delta — an item
  // the agent already wrote as `- [x]` is checked in the DOM and must stay
  // checked in the store, or the next render would un-tick it
  function recordTicks(key, body) {
    const on = [...body.querySelectorAll('input.md-tick')]
      .filter(b => b.checked).map(b => Number(b.getAttribute('data-tick')));
    ticks()[key] = { at: Date.now(), on };
    saveTicks();
  }
  // apply the stored ticks over what the message text says, then remember the
  // key on the body so a click knows which record it is editing
  function applyTicks(body, key) {
    const boxes = body.querySelectorAll('input.md-tick');
    if (!boxes.length) return;
    body.setAttribute('data-ticks', key);
    const rec = ticks()[key];
    if (!rec) return;
    const on = new Set(rec.on || []);
    for (const box of boxes) {
      const done = on.has(Number(box.getAttribute('data-tick')));
      box.checked = done;
      const li = box.parentNode;
      if (li && li.classList) li.classList.toggle('done', done);
    }
  }

  // escape + autolink raw prose (no fences, no inline code): URLs become
  // real anchors so nobody has to screenshot a tunnel link off a phone.
  // Linkifying happens on the RAW text with each piece escaped separately,
  // so escaping can never be bypassed and code spans are never touched.
  function linkedEsc(raw) {
    const s = String(raw);
    let out = '', last = 0, m;
    const re = /https?:\/\/[^\s<>"']+/g;
    while ((m = re.exec(s))) {
      const url = m[0].replace(/[.,;:!?)\]}]+$/, ''); // trailing punctuation is prose
      out += esc(s.slice(last, m.index));
      out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
      last = m.index + url.length;
    }
    return out + esc(s.slice(last));
  }
  // system lines (tunnel share lines included): linkify, and give
  // "password: <token>" a tap-to-copy chip — phones can't select from
  // a transcript comfortably, so copying must be one tap
  function sysFmt(raw) {
    return linkedEsc(raw).replace(/(password:\s*)(\S+)/gi, (all, label, pw) =>
      `${label}<button class="copy-chip" data-copy="${pw}" title="copy password">${pw}<span class="chip-ic" aria-hidden="true">⧉</span></button>`);
  }

  // ── copy affordances: chips + inline code are tap-to-copy ──
  let toastTimer = null;
  function toast(msg) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.hidden = false;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.classList.remove('show'); els.toast.hidden = true; }, 1600);
  }
  function copyText(t) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return; // no API: selection still works
    navigator.clipboard.writeText(t).then(() => toast('copied ✓')).catch(() => { });
  }
  // whole-message copy: rich HTML *and* plain markdown on the clipboard, so a
  // paste into a doc keeps the links and headings while a paste into a text
  // field gets the markdown the agent actually wrote. Older browsers (and any
  // context where ClipboardItem is missing) fall back to the plain text.
  async function copyMessage(msg) {
    const text = msg.getAttribute('data-raw') || (msg.querySelector('.body') || msg).textContent || '';
    const body = msg.querySelector('.body');
    const nav = navigator;
    if (body && nav.clipboard && nav.clipboard.write &&
        typeof window.ClipboardItem === 'function' && typeof window.Blob === 'function') {
      try {
        await nav.clipboard.write([new window.ClipboardItem({
          'text/html': new window.Blob([body.innerHTML], { type: 'text/html' }),
          'text/plain': new window.Blob([text], { type: 'text/plain' }),
        })]);
        toast('copied ✓');
        return;
      } catch { /* fall through to plain text */ }
    }
    copyText(text);
  }
  els.chat.addEventListener('click', e => {
    const copyBtn = e.target.closest('.msg-copy');
    if (copyBtn) { copyMessage(copyBtn.closest('.msg')); return; }
    // The draft box's own copy: the blockquote's text alone, button excluded.
    // Read innerText from the LIVE node (a detached clone loses the line
    // breaks between paragraphs) with the button display:none'd for the read.
    const bqBtn = e.target.closest('.bq-copy');
    if (bqBtn) {
      const q = bqBtn.closest('blockquote');
      if (q) {
        const btns = [...q.querySelectorAll('.bq-copy')];
        for (const b of btns) b.style.display = 'none';
        const draft = q.innerText.trim();
        for (const b of btns) b.style.display = '';
        copyText(draft);
      }
      return;
    }
    if (e.target.closest('.md-tick, .env-row')) return; // their own controls
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return; // user is selecting, not tapping
    const chip = e.target.closest('.copy-chip');
    if (chip) { copyText(chip.dataset.copy); return; }
    const code = e.target.closest('.msg .body code');
    if (code && !code.closest('pre')) copyText(code.textContent);
  });
  // checklist ticks: delegated, so a transcript restored from the cache (raw
  // innerHTML, no listeners) keeps working
  els.chat.addEventListener('change', e => {
    const box = e.target.closest('input.md-tick');
    if (!box) return;
    const body = box.closest('[data-ticks]');
    if (!body) return;
    const li = box.parentNode;
    if (li && li.classList) li.classList.toggle('done', box.checked);
    recordTicks(body.getAttribute('data-ticks'), body);
  });

  function updateEmpty() {
    els.empty.hidden = els.transcript.children.length > 0;
  }
  // During a chat switch the authoritative replay renders into an offscreen
  // buffer (the previous/cached transcript stays visible — no blank flash)
  // and is swapped in when the replay completes.
  let replayBuffer = null;
  const container = () => replayBuffer || els.transcript;
  const raf = typeof window.requestAnimationFrame === 'function'
    ? cb => window.requestAnimationFrame(cb) : cb => setTimeout(cb, 16);
  const atBottom = () => els.chat.scrollTop + els.chat.clientHeight >= els.chat.scrollHeight - 90;
  // While a replay streams in, the "did the user scroll up?" heuristic is
  // meaningless (the user did nothing — the layout is moving under them),
  // so it is suppressed entirely and the view stays pinned.
  const replayActive = () => state.inServerReplay || state.replaying;
  const pinned = () => replayActive() || atBottom();
  function pinBottom() { els.chat.scrollTop = els.chat.scrollHeight; els.jump.hidden = true; }
  // pin now AND after layout settles (fonts, images, status strip): a late
  // reflow after the last scroll write is exactly what used to leave the
  // transcript parked at a weird mid-scroll anchor
  function settleBottom() {
    pinBottom();
    raf(() => raf(pinBottom));
  }
  function follow(wasPinned) {
    if (replayBuffer) return; // offscreen render: nothing to scroll
    if (wasPinned) pinBottom();
    else els.jump.hidden = false;
  }
  els.chat.addEventListener('scroll', () => { if (atBottom()) els.jump.hidden = true; });
  els.jump.addEventListener('click', () => pinBottom());
  // late layout shifts (image loads, font swaps) re-assert the bottom as
  // long as the user hasn't deliberately scrolled up (jump pill hidden)
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (replayActive() || els.jump.hidden) {
        if (!atBottom()) pinBottom();
      }
    }).observe(els.transcript);
  }

  const attThumbs = atts => (atts && atts.length)
    ? `<div class="att-row">${atts.map(a => {
      const m = /\.(pdf|xlsx?)(\?|$)/i.exec(a.url || '');
      return m
        ? `<a class="att-doc-link" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(m[1].toUpperCase())} · ${esc((a.url || '').split('/').pop())}</a>`
        : `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${esc(a.url)}" alt="attached image" loading="lazy"></a>`;
    }).join('')}</div>`
    : '';

  // ── one paint path for every markdown message (user and agent alike) ──────
  // The envelope comes out first, the prose becomes real nodes, the stored
  // ticks go back over the checkboxes, and the raw markdown is parked on the
  // element so the copy button can hand it back verbatim (it survives the
  // innerHTML round-trip the chat-switch cache does).
  const ENV_NEXT = { '@user': 'back to you', '@claude': 'over to @claude', '@codex': 'over to @codex' };
  function envRow(envs) {
    const row = mk('div', 'env-row');
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
  // fill a message element's .body (+ .env-row) from raw agent/user markdown
  function paint(div, text) {
    const { text: prose, envs } = splitEnvelopes(text);
    const body = div.querySelector('.body');
    body.textContent = '';
    body.appendChild(renderMarkdown(prose));
    // A blockquote in a council message is a handed-over draft ("Suggested
    // reply: > Hi Andrew, …") — render it as its own box with its own copy,
    // like a code block in the native chat apps: one tap takes the draft,
    // never the analysis around it. The button is real markup (not a
    // listener), so a transcript restored from the innerHTML cache keeps it;
    // the click is handled by the transcript's delegated handler.
    for (const bq of body.querySelectorAll('blockquote')) {
      bq.insertAdjacentHTML('afterbegin',
        '<button class="bq-copy" title="copy this draft" aria-label="copy this draft">⧉ copy</button>');
    }
    applyTicks(body, hashText(prose));
    div.setAttribute('data-raw', prose);
    const old = div.querySelector('.env-row');
    if (old) old.remove();
    if (envs.length) body.insertAdjacentElement('afterend', envRow(envs));
    return div;
  }
  const copyBtnHtml =
    '<div class="msg-acts"><button class="msg-copy" title="copy this message" ' +
    'aria-label="copy this message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>' +
    '<span>copy</span></button></div>';

  function addMsg(speaker, text, { streaming = false, attachments = [] } = {}) {
    const wasPinned = pinned();
    const div = document.createElement('div');
    const who = String(speaker || 'system').toLowerCase();
    if (who === 'user') {
      div.className = 'msg user';
      div.innerHTML = `${attThumbs(attachments)}<div class="body"></div>${copyBtnHtml}`;
      paint(div, text);
    } else if (who === 'claude' || who === 'codex') {
      div.className = `msg ${who}${streaming ? ' streaming' : ''}`;
      div.innerHTML = `<div class="who">${avatarHtml(who)}<span>${who}</span></div>` +
        `<div class="body"></div>${copyBtnHtml}`;
      paint(div, text);
    } else {
      // multi-line system output (/help, /status, resume lists) reads better
      // as a left-aligned block than a centered whisper
      div.className = `msg system${/\n/.test(text) ? ' block' : ''}`;
      div.innerHTML = `<div class="body">${sysFmt(text)}</div>`;
    }
    container().appendChild(div);
    if (!replayBuffer) {
      updateEmpty();
      follow(wasPinned);
    }
    return div;
  }

  // A turn's tool run arrives as its own room entry (stream_id "<base>:tools",
  // text "Explored\n├ …"). It lands at turn end — after the agent's text has
  // already streamed into the transcript — so rendering it in arrival order
  // would leave tool calls as the LAST thing in every turn, which reads like
  // the turn never finished. Render it as a compact collapsible card and slot
  // it BEFORE the agent's streaming message, so the reply is always last.
  function addToolsCard(speaker, text, streamId) {
    const who = String(speaker || 'system').toLowerCase();
    const lines = String(text || '').split('\n');
    const steps = lines[0] === 'Explored' ? lines.slice(1) : lines;
    const wasPinned = pinned();
    const div = document.createElement('div');
    div.className = `msg ${who} tools-msg`;
    div.innerHTML = `<details class="tools"><summary>${esc(who)} explored · ` +
      `${steps.length} step${steps.length === 1 ? '' : 's'}</summary>` +
      `<div class="tool-steps">${steps.map(esc).join('\n')}</div></details>`;
    const base = streamId ? `${who}:${streamId.replace(/:tools$/, '')}` : '';
    const live = base && state.streams[base];
    if (live && live.el && live.el.parentNode) live.el.parentNode.insertBefore(div, live.el);
    else container().appendChild(div);
    if (!replayBuffer) { updateEmpty(); follow(wasPinned); }
    return div;
  }

  function streamKey(ev) { return `${ev.model || ev.speaker || 'agent'}:${ev.stream_id || 0}`; }
  function streamDelta(ev) {
    const model = String(ev.model || 'claude').toLowerCase();
    if (AGENTS.includes(model) && !state.agents[model]) { state.agents[model] = true; renderAvatars(); }
    const key = streamKey(ev);
    let s = state.streams[key];
    if (!s) {
      s = state.streams[key] = { text: '', el: addMsg(model, '', { streaming: true }) };
    }
    const wasPinned = pinned();
    s.text += String(ev.text || '');
    paint(s.el, s.text);
    follow(wasPinned);
  }
  function finalizeStream(ev) {
    const key = `${ev.speaker}:${ev.stream_id}`;
    const s = state.streams[key];
    if (s) {
      const wasPinned = pinned();
      s.el.classList.remove('streaming');
      paint(s.el, ev.text);
      delete state.streams[key];
      follow(wasPinned);
      return true;
    }
    return false;
  }

  // ── subagent progress lane ──
  // When the Claude bot spawns Claude Code subagents (the Task/Agent tool),
  // the bridge streams tool events tagged with a parent_tool_use_id, and the
  // Task tool_use itself carries an agent_label. We render one card per turn
  // with a row per subagent: a status dot, the label, a live elapsed clock,
  // and the latest tool activity — collapsing to a compact summary when done.
  // The card is left in the transcript at turn end, so past turns show what
  // their agents did (and it rebuilds from the replayed stream events).
  const fmtDur = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };
  // middle-truncate so both ends of a long path/command stay legible
  function midTruncate(s, max) {
    s = String(s);
    if (s.length <= max) return s;
    const head = Math.ceil((max - 1) / 2), tail = Math.floor((max - 1) / 2);
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }
  // "ToolName · target": the target is the most identifying field of the tool
  // input (path, command, pattern…), best-effort from the truncated preview
  function laneActivity(ev) {
    let inp = null;
    try { inp = JSON.parse(ev.input_preview); } catch { }
    let target = '';
    if (inp && typeof inp === 'object') {
      target = inp.file_path || inp.path || inp.pattern || inp.command
        || inp.url || inp.query || inp.description || inp.prompt || '';
    }
    target = midTruncate(String(target).replace(/\s+/g, ' ').trim(), 46);
    return target ? `${ev.name} · ${target}` : String(ev.name || '');
  }
  function ensureLaneCard() {
    if (state.laneCard) return state.laneCard;
    const wasPinned = pinned();
    const div = document.createElement('div');
    div.className = 'msg lane';
    div.innerHTML = `<div class="lane-head">${avatarHtml('claude')}<span>subagents</span></div>
      <div class="lane-rows"></div>`;
    container().appendChild(div);
    state.laneCard = div;
    if (!replayBuffer) { updateEmpty(); follow(wasPinned); }
    return div;
  }
  function paintLane(lane) {
    if (lane.status === 'running') {
      lane.el.className = 'lane-row running';
      lane.el.innerHTML =
        `<span class="lane-dot running" aria-hidden="true"></span>` +
        `<span class="lane-label">${esc(lane.label)}</span>` +
        `<span class="lane-elapsed">${fmtDur(Date.now() - lane.start)}</span>` +
        `<span class="lane-act">${lane.latest ? esc(lane.latest) : '…'}</span>`;
    } else {
      // collapsed summary: label + total duration + tool-call count
      lane.el.className = `lane-row ${lane.status}`;
      lane.el.innerHTML =
        `<span class="lane-dot ${lane.status}" aria-hidden="true"></span>` +
        `<span class="lane-label">${esc(lane.label)}</span>` +
        `<span class="lane-meta">${fmtDur(lane.dur)} · ${lane.tools} tool${lane.tools === 1 ? '' : 's'}</span>`;
    }
  }
  const anyLaneRunning = () => Object.values(state.lanes).some(l => l.status === 'running');
  function startLaneTimer() {
    if (state.laneTimer) return;
    state.laneTimer = setInterval(() => {
      if (!anyLaneRunning()) { stopLaneTimer(); return; }
      for (const l of Object.values(state.lanes)) if (l.status === 'running') paintLane(l);
    }, 1000);
  }
  function stopLaneTimer() {
    if (state.laneTimer) { clearInterval(state.laneTimer); state.laneTimer = null; }
  }
  function openLane(id, label) {
    if (state.lanes[id]) return;
    const card = ensureLaneCard();
    const row = document.createElement('div');
    const lane = state.lanes[id] = {
      id, label: label || 'subagent', start: Date.now(),
      tools: 0, latest: '', status: 'running', el: row,
    };
    card.querySelector('.lane-rows').appendChild(row);
    paintLane(lane);
    startLaneTimer();
  }
  function closeLane(id, status = 'done') {
    const lane = state.lanes[id];
    if (!lane || lane.status !== 'running') return;
    lane.status = status;
    lane.dur = Date.now() - lane.start;
    paintLane(lane);
    if (!anyLaneRunning()) stopLaneTimer();
  }
  function laneEvent(ev) {
    // a Task/Agent tool_use opens (and names) a subagent row
    if (ev.kind === 'tool_start' && 'agent_label' in ev) { openLane(ev.tool_id, ev.agent_label); return; }
    // the Task's own result closes its lane (running -> collapsed summary)
    if (ev.kind === 'tool_done' && state.lanes[ev.tool_id]) { closeLane(ev.tool_id); return; }
    // a tool nested under a subagent updates that lane's latest activity
    const lane = ev.parent_tool_use_id && state.lanes[ev.parent_tool_use_id];
    if (lane && ev.kind === 'tool_start') {
      lane.tools++;
      lane.latest = laneActivity(ev);
      paintLane(lane);
    }
  }
  // turn end: freeze every running lane in its final state and detach the
  // card so the next turn starts a fresh one (the frozen card stays on screen)
  function freezeLanes() {
    for (const id of Object.keys(state.lanes)) closeLane(id, 'done');
    stopLaneTimer();
    state.lanes = {};
    state.laneCard = null;
  }
  // hard reset (reconnect / chat switch): drop lane state without freezing —
  // the transcript itself is being rebuilt
  function resetLanes() {
    stopLaneTimer();
    state.lanes = {};
    state.laneCard = null;
  }

  // ── interrupt cards ──
  let liveCard = null;
  function settleCard(note) {
    if (!liveCard) return;
    liveCard.classList.add('answered');
    for (const b of liveCard.querySelectorAll('button')) b.disabled = true;
    if (note) {
      const n = document.createElement('div');
      n.className = 'card-note';
      n.textContent = note;
      liveCard.appendChild(n);
    }
    liveCard = null;
  }
  function choiceCard(ev) {
    settleCard();
    const wasPinned = pinned();
    const div = document.createElement('div');
    div.className = 'msg card';
    div.innerHTML = `<div class="card-title">choose one</div>
      <div class="card-prompt">${esc(ev.prompt)}</div>
      <div class="opts">${(ev.options || []).map((o, i) =>
        `<button data-i="${i}">${esc(o)}</button>`).join('')}
      <button data-i="-1">Dismiss</button></div>
      <div class="card-note">auto-dismissed after 2 minutes if unanswered</div>`;
    div.addEventListener('click', e => {
      const b = e.target.closest('button[data-i]');
      if (!b || div.classList.contains('answered')) return;
      const i = Number(b.dataset.i);
      post('/choice', { index: i >= 0 ? i : null });
      liveCard = div;
      settleCard(i >= 0 ? `you picked: ${ev.options[i]}` : 'dismissed');
    });
    container().appendChild(div);
    liveCard = div;
    if (!replayBuffer) { updateEmpty(); follow(wasPinned); }
  }
  function permissionCard(ev) {
    settleCard();
    const wasPinned = pinned();
    const div = document.createElement('div');
    div.className = 'msg card perm';
    div.innerHTML = `<div class="card-title">write permission</div>
      <div class="card-prompt">@${esc(ev.model)} wants to write
      <span class="path">${esc(ev.path)}</span>${ev.reason ? `<br>${esc(ev.reason)}` : ''}</div>
      <div class="acts"><button class="allow">Allow</button><button class="deny">Deny</button></div>
      <div class="card-note">auto-denied after 2 minutes if unanswered</div>`;
    div.querySelector('.allow').addEventListener('click', () => {
      post('/permission', { allow: true }); liveCard = div; settleCard('allowed');
    });
    div.querySelector('.deny').addEventListener('click', () => {
      post('/permission', { allow: false }); liveCard = div; settleCard('denied');
    });
    container().appendChild(div);
    liveCard = div;
    if (!replayBuffer) { updateEmpty(); follow(wasPinned); }
  }

  // ── sidebar ──
  const relTime = iso => {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const d = (Date.now() - t) / 1000;
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    return `${Math.round(d / 86400)}d`;
  };
  // Every project expands on tap and lists its own chats — opening a chat IS
  // how you enter a project (the controller makes the chat's project active
  // on resume), so there is no "make active project" step to click first.
  function autoOpenActiveProject(p) {
    // Expand the project you just landed in (first load, or when opening a
    // chat moves you into another project). A manual collapse sticks until
    // the active project changes again. Archived projects stay tucked away.
    const pid = (p && p.active_project_id) || '';
    const pr = (p && p.projects || []).find(x => x.id === pid);
    if (pid && pid !== state.lastActivePid && (!pr || (pr.status || 'active') === 'active')) {
      state.openProjects.add(pid);
    }
    state.lastActivePid = pid;
  }
  // one chat row: the row itself resumes; ⋯ opens archive/delete, both of
  // which are plain slash commands (the controller owns the confirm step)
  function chatRow(s) {
    const sid = esc(s.session_id);
    const open = state.menuSid === s.session_id;
    return `<div class="sess-row${open ? ' menu-open' : ''}">
      <button class="sess${s.active ? ' active' : ''}" data-act="resume" data-sid="${sid}">
        ${esc(s.title || s.session_id.slice(0, 8))}<span class="when">${relTime(s.updated_at)}</span></button>
      <button class="row-more" data-act="menu" data-sid="${sid}" aria-haspopup="true"
        aria-expanded="${open}" aria-label="actions for ${esc(s.title || s.session_id.slice(0, 8))}">⋯</button>
      ${open ? `<div class="row-menu" role="menu">
        <button role="menuitem" data-act="archive" data-sid="${sid}">Archive</button>
        <button role="menuitem" class="danger" data-act="delete" data-sid="${sid}">Delete…</button>
      </div>` : ''}
    </div>`;
  }
  function projectBlock(pr, { archived = false } = {}) {
    // Purely user-driven: autoOpenActiveProject() seeds openProjects when you
    // land in a project, so the active one can still be collapsed by hand.
    const open = state.openProjects.has(pr.id);
    const pid = esc(pr.id);
    let html = `<div class="proj${open ? ' open' : ''}" data-pid="${pid}">
      <button class="proj-head${pr.active ? ' active' : ''}" data-act="toggle" data-pid="${pid}" aria-expanded="${open}">
        <span class="chev">▶</span><span class="name">${esc(pr.title || pr.id)}</span>
        <span class="count">${pr.session_count ?? (pr.sessions || []).length}</span></button>
      <div class="proj-sessions">`;
    // No "make active project" row: opening any chat here does that for you.
    // chats first, project-level commands under them
    for (const s of pr.sessions || []) html += chatRow(s);
    if (!archived && !(pr.sessions || []).length) html += '<div class="empty-note">no chats yet</div>';
    html += archived
      ? `<button class="sess sess-cmd" data-act="proj-unarchive" data-pid="${pid}">↩ unarchive project</button>`
      : `<button class="sess sess-cmd" data-act="proj-archive" data-pid="${pid}">⊘ archive project</button>`;
    return html + '</div></div>';
  }
  // Flat newest-first shortlist across Inbox + every project, so finding a
  // chat never requires remembering which project it lives in. Rows carry a
  // small project chip; no ⋯ menu here — manage a chat from its project block.
  function recentRows(p) {
    const rows = [];
    for (const s of p.inbox_sessions || []) rows.push({ s, chip: 'Inbox' });
    for (const pr of p.projects || []) {
      if ((pr.status || 'active') !== 'active') continue;
      for (const s of pr.sessions || []) rows.push({ s, chip: pr.title || pr.id });
    }
    rows.sort((a, b) => String(b.s.updated_at || '').localeCompare(String(a.s.updated_at || '')));
    return rows.slice(0, 8).map(({ s, chip }) => `
      <button class="sess recent${s.active ? ' active' : ''}" data-act="resume" data-sid="${esc(s.session_id)}">
        ${esc(s.title || s.session_id.slice(0, 8))}<span class="chip">${esc(chip)}</span>
        <span class="when">${relTime(s.updated_at)}</span></button>`).join('');
  }
  function renderProjects() {
    const p = state.projects;
    if (!p) { els.projects.innerHTML = '<div class="empty-note">loading…</div>'; return; }
    const all = p.projects || [];
    const live = all.filter(pr => (pr.status || 'active') === 'active');
    const archived = all.filter(pr => (pr.status || 'active') !== 'active');
    let html = '';
    const recent = recentRows(p);
    if (recent) html += '<h2>Recent</h2>' + recent;
    html += '<h2>Chats</h2>';
    html += `<div class="proj"><button class="proj-head" data-act="inbox">
      <span class="chev">•</span><span class="name">Inbox</span>
      <span class="count">${p.inbox_session_count || 0}</span></button></div>`;
    if (live.length) {
      html += '<h2>Projects</h2>';
      for (const pr of live) html += projectBlock(pr);
    }
    // archived projects live at the bottom, collapsed — present, out of the way
    if (archived.length) {
      html += `<div class="arch${state.archOpen ? ' open' : ''}">
        <button class="arch-head" data-act="toggle-arch" aria-expanded="${state.archOpen}">
          <span class="chev">▶</span>Archived<span class="count">${archived.length}</span></button>
        <div class="arch-body">`;
      for (const pr of archived) html += projectBlock(pr, { archived: true });
      html += '</div></div>';
    }
    els.projects.innerHTML = html;
  }
  els.projects.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act !== 'menu' && state.menuSid) { state.menuSid = null; renderProjects(); }
    if (act === 'toggle') {
      const pid = b.dataset.pid;
      if (state.openProjects.has(pid)) state.openProjects.delete(pid);
      else state.openProjects.add(pid);
      renderProjects();
      return;
    }
    if (act === 'toggle-arch') { state.archOpen = !state.archOpen; renderProjects(); return; }
    if (act === 'menu') {
      state.menuSid = state.menuSid === b.dataset.sid ? null : b.dataset.sid;
      renderProjects();
      return;
    }
    // sidebar affordances send the equivalent slash command — one code path
    if (act === 'inbox') sendInput('/resume');
    if (act === 'resume') switchTo(b.dataset.sid);
    if (act === 'proj-archive') sendInput('/project archive ' + b.dataset.pid);
    if (act === 'proj-unarchive') sendInput('/project unarchive ' + b.dataset.pid);
    if (act === 'archive') {
      sendInput('/archive ' + b.dataset.sid);
      toast('archiving — /unarchive brings it back');
    }
    if (act === 'delete') {
      // the controller answers with a confirm card in the transcript, so the
      // sidebar gets out of the way instead of confirming twice
      sendInput('/delete ' + b.dataset.sid);
      toast('confirm the delete in the chat');
    }
    closeSide();
  });
  // a tap anywhere else dismisses an open row menu
  document.addEventListener('click', e => {
    if (state.menuSid && !e.target.closest('.sess-row')) { state.menuSid = null; renderProjects(); }
  });
  els.newChat.addEventListener('click', () => { snapshotCurrent(); sendInput('/new'); closeSide(); });

  // new project: an inline title field (no modal, no prompt()) that sends
  // the same /project create the TUI takes
  function showNewProject(on) {
    // never silently eat a typed title: dismissing with text still in the
    // field says so, instead of pretending the form was never opened
    if (!on && !els.newProjForm.hidden && els.newProjTitle.value.trim()) {
      toast('project name discarded');
    }
    els.newProjForm.hidden = !on;
    if (on) { els.newProjTitle.value = ''; els.newProjTitle.focus(); }
  }
  function submitNewProject() {
    const title = els.newProjTitle.value.trim();
    if (!title) { showNewProject(false); return; }
    sendInput('/project create ' + title);
    els.newProjTitle.value = '';
    showNewProject(false);
    closeSide();
  }
  els.newProject.addEventListener('click', () => showNewProject(els.newProjForm.hidden));
  els.newProjForm.addEventListener('submit', e => { e.preventDefault(); submitNewProject(); });
  els.newProjTitle.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); showNewProject(false); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitNewProject(); }
  });

  // ── chat switching: optimistic render from cache, reconcile on replay ──
  // A switch re-attaches this tab's event stream to the target chat's bridge
  // (?chat=<sid>; the server spawns one on demand). What we make instant is
  // the paint: snapshot the outgoing transcript, restore the cached one (if
  // we have it) immediately, and let the authoritative replay land in an
  // offscreen buffer that swaps in when it completes. First visits keep the
  // old chat + a syncing pill — never a blank flash.
  function snapshotCurrent() {
    if (!state.currentSid || replayBuffer || !els.transcript.children.length) return;
    cachePut(state.currentSid, {
      html: els.transcript.innerHTML,
      scrollTop: els.chat.scrollTop,
      atBottom: atBottom(),
    });
  }
  function setSyncing(on) { if (els.sync) els.sync.hidden = !on; }
  function switchTo(sid) {
    if (!sid) return;
    if (sid === state.currentSid && !state.pendingSwitch) return; // already live: nothing to do
    snapshotCurrent();
    state.pendingSwitch = sid;
    syncHash(sid);                          // reflect the target chat in the URL now
    const cached = cacheGet(sid);
    if (cached) {
      els.transcript.innerHTML = cached.html;
      updateEmpty();
      if (cached.atBottom) pinBottom();
      else { els.chat.scrollTop = cached.scrollTop; els.jump.hidden = atBottom(); }
    }
    setSyncing(true);
    reattach();
  }
  // replay-buffer completion: swap the freshly replayed transcript in and
  // decide the landing scroll — same content as the cached paint keeps the
  // user's place, anything else lands pinned at the bottom
  function flushReplayBuffer() {
    if (!replayBuffer) return;
    const sid = state.pendingSwitch;
    const cached = sid ? sessionCache.get(sid) : null;
    const buf = replayBuffer;
    replayBuffer = null;
    const sameAsCached = !!cached && cached.html === buf.innerHTML;
    els.transcript.innerHTML = '';
    while (buf.firstChild) els.transcript.appendChild(buf.firstChild);
    updateEmpty();
    if (sameAsCached && !cached.atBottom) els.jump.hidden = atBottom();
    else settleBottom();
  }
  function endSwitch() {
    flushReplayBuffer();
    state.pendingSwitch = null;
    state.resuming = false;
    setSyncing(false);
  }

  // ── hash routing: #/chat/<session-id> keeps the open chat in the URL, so a
  // link (or a reload) reopens the same chat. history.replaceState keeps it
  // out of the back-button history — switching chats isn't page navigation. ──
  function hashSid() {
    const m = /^#\/chat\/([\w-]+)$/.exec(location.hash || '');
    return m ? m[1] : '';
  }
  function syncHash(sid) {
    const want = sid ? `#/chat/${sid}` : '';
    if (location.hash === want) return;
    const url = location.pathname + location.search + want;
    try { history.replaceState(null, '', url); } catch { location.hash = want; }
  }
  // The hash drives navigation only on initial load (deep link / reload) and
  // on real hashchange events. On later 'projects' events the server's active
  // chat is the truth and the hash follows it — otherwise a stale hash would
  // undo server-initiated switches (/new, /delete, a typed /resume).
  let hashRestored = false;
  // open the chat the URL names if it isn't already open/opening. The SERVER
  // is the authority on which ids exist (it checks the session files on
  // disk): the sidebar lists only each project's recent chats, so gating on
  // it here made valid deep links toast "chat not found". A genuinely
  // unknown id comes back as route_error — the fallback bridge answers, the
  // toast shows, and the next 'projects' event corrects the URL.
  function routeHash() {
    const sid = hashSid();
    if (!sid || sid === state.currentSid || sid === state.pendingSwitch) return;
    if (!state.projects) return;
    // one-shot guard: the id the server just refused isn't re-asked in the
    // same breath, but a later deliberate navigation may retry it
    if (sid === state.routeErrorSid) {
      state.routeErrorSid = null;
      syncHash(state.currentSid);
      return;
    }
    switchTo(sid);
  }

  // mobile slide-over / desktop collapse
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;
  function openSide() {
    if (narrow()) { document.body.classList.add('side-open'); els.backdrop.hidden = false; }
    else document.body.classList.remove('side-collapsed');
    els.burger.setAttribute('aria-expanded', 'true');
  }
  function closeSide() {
    if (narrow()) { document.body.classList.remove('side-open'); els.backdrop.hidden = true; }
    els.burger.setAttribute('aria-expanded', 'false');
  }
  els.burger.addEventListener('click', () => {
    if (narrow()) {
      document.body.classList.contains('side-open') ? closeSide() : openSide();
    } else {
      const collapsed = document.body.classList.toggle('side-collapsed');
      localStorage.setItem('council-side', collapsed ? 'collapsed' : '');
    }
  });
  els.sideClose.addEventListener('click', closeSide);
  els.backdrop.addEventListener('click', closeSide);
  if (localStorage.getItem('council-side') === 'collapsed') document.body.classList.add('side-collapsed');

  // ── slash-command autocomplete (driven by the bridge's completion_context:
  // global entries prefix-match the whole input; scoped entries kick in when
  // the input starts with a scoped prefix and substring-match the rest) ──
  let compItems = [], compSel = -1;
  // 'line' = the old whole-input command completions; 'mention' = an "@" under
  // the caret ANYWHERE in the message — the plugin's behavior, ported: typing
  // @cl mid-sentence offers @claude with its logomark, accepting splices just
  // the handle in, and a literal @ in prose (user@host) is left alone because
  // the trigger requires start-of-word.
  let compMode = 'line', mentionCtx = null;
  const MENTION_HANDLES = ['claude', 'codex', 'all'];
  function mentionAtCaret() {
    const pos = els.input.selectionStart;
    if (pos == null || pos !== els.input.selectionEnd) return null;
    const before = els.input.value.slice(0, pos);
    const m = /(^|[\s([{"'])@([a-zA-Z]*)$/.exec(before);
    if (!m) return null;
    // caret must be at the fragment's end-of-word, not inside a longer token
    if (/^[\w@]/.test(els.input.value.slice(pos))) return null;
    const frag = m[2].toLowerCase();
    const items = MENTION_HANDLES.filter(h => h.startsWith(frag) && h !== frag);
    if (!items.length) return null;
    return { start: pos - m[2].length - 1, end: pos, items };
  }
  function computeCompletions(text) {
    if (!text || /\n/.test(text)) return [];
    const out = [];
    for (const [prefix, options] of Object.entries(state.ctx.scoped || {})) {
      if (text.startsWith(prefix)) {
        const rest = text.slice(prefix.length).toLowerCase();
        for (const o of options) {
          if (String(o).toLowerCase().includes(rest)) out.push(prefix + o);
        }
        return out.slice(0, 8);
      }
    }
    if (!text.startsWith('/') && !text.startsWith('@')) return [];
    for (const g of state.ctx.global || []) {
      if (g.startsWith(text) && g !== text) out.push(g);
    }
    return out.slice(0, 8);
  }
  function renderCompletions() {
    if (!compItems.length) { els.complete.hidden = true; return; }
    els.complete.innerHTML = compItems.map((c, i) => {
      const sel = `class="opt${compMode === 'mention' ? ' mention' : ''}${i === compSel ? ' sel' : ''}" role="option" aria-selected="${i === compSel}" data-i="${i}"`;
      return compMode === 'mention'
        ? `<div ${sel}>${MARKS[c] ? avatarHtml(c) : '<span class="avatar" aria-hidden="true">@</span>'}<span class="mname">@${esc(c)}</span></div>`
        : `<div ${sel}><code>${esc(c)}</code></div>`;
    }).join('');
    els.complete.hidden = false;
  }
  function refreshCompletions() {
    mentionCtx = mentionAtCaret();
    if (mentionCtx) {
      compMode = 'mention';
      compItems = mentionCtx.items;
    } else {
      compMode = 'line';
      compItems = computeCompletions(els.input.value);
    }
    compSel = compItems.length ? 0 : -1;
    renderCompletions();
  }
  function acceptCompletion(i) {
    if (i < 0 || i >= compItems.length) return;
    if (compMode === 'mention' && mentionCtx) {
      // splice the handle in at the fragment, never touch the rest
      const v = els.input.value;
      els.input.value = v.slice(0, mentionCtx.start) + '@' + compItems[i] + ' ' + v.slice(mentionCtx.end);
      const p = mentionCtx.start + compItems[i].length + 2;
      els.input.focus();
      els.input.setSelectionRange(p, p);
    } else {
      els.input.value = compItems[i];
      els.input.focus();
    }
    autosize();
    refreshCompletions();
    syncSend();
  }
  els.complete.addEventListener('mousedown', e => {
    const o = e.target.closest('[data-i]');
    if (o) { e.preventDefault(); acceptCompletion(Number(o.dataset.i)); }
  });

  // ── composer ──
  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 157) + 'px';
  }
  function syncSend() { els.send.disabled = !els.input.value.trim() && !state.atts.length; }

  // ── attachments (images + PDFs): picker (camera+library on iOS),
  // clipboard paste, drag-drop. Uploaded eagerly so send is instant and the
  // server validates early; thumbnails (a name chip for PDFs) with ✕ until
  // sent. ──
  const IMG_LIMIT = 4, IMG_MAX_BYTES = 10 * 1024 * 1024;
  const DOC_MIMES = ['application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'];
  const DOC_EXT = /\.(pdf|xlsx?)$/i;
  const isDocFile = f => DOC_MIMES.includes(f.type) || DOC_EXT.test(f.name || '');
  const docLabel = name => ((/\.(\w+)$/.exec(name || '') || [])[1] || 'file').toUpperCase();
  function renderAtts() {
    if (!els.attStrip) return;
    els.attStrip.hidden = !state.atts.length;
    els.attStrip.innerHTML = state.atts.map((a, i) =>
      `<div class="att${a.kind === 'doc' ? ' att-doc' : ''}${a.status === 'up' ? ' uploading' : ''}">
        ${a.kind === 'doc'
          ? `<span class="att-doc-chip" title="${esc(a.name)}">${esc(docLabel(a.name))} · ${esc(a.name)}</span>`
          : `<img src="${esc(a.thumb)}" alt="">`}
        <button class="att-x" data-x="${i}" aria-label="remove attachment">✕</button></div>`).join('');
  }
  async function addFiles(files) {
    for (const f of Array.from(files || [])) {
      const doc = f && isDocFile(f);
      if (!(f && (doc || /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|heic)$/i.test(f.name || '')))) continue;
      if (state.atts.length >= IMG_LIMIT) { toast(`${IMG_LIMIT} attachments max per message`); break; }
      if (f.size > IMG_MAX_BYTES) { toast('file too large (10MB max)'); continue; }
      const item = {
        id: '', path: '', url: '', status: 'up',
        kind: doc ? 'doc' : 'img', name: f.name || 'document',
        thumb: doc ? '' : URL.createObjectURL(f),
      };
      state.atts.push(item);
      renderAtts(); syncSend();
      let r = null;
      try {
        const resp = await fetch('/upload', {
          method: 'POST',
          headers: { 'content-type': f.type || 'application/octet-stream' },
          body: f,
        });
        if (resp.status === 401) { location.reload(); return; }
        r = await resp.json();
      } catch { }
      if (r && r.ok && r.attachment) Object.assign(item, r.attachment, { status: 'ok' });
      else {
        state.atts = state.atts.filter(x => x !== item);
        URL.revokeObjectURL(item.thumb);
        toast(r && r.error ? `upload failed: ${r.error}` : 'upload failed');
      }
      renderAtts(); syncSend();
    }
  }
  function clearAtts() {
    for (const a of state.atts) URL.revokeObjectURL(a.thumb);
    state.atts = [];
    renderAtts(); syncSend();
  }
  if (els.attach && els.file) {
    els.attach.addEventListener('click', () => els.file.click());
    els.file.addEventListener('change', () => { addFiles(els.file.files); els.file.value = ''; });
    els.attStrip.addEventListener('click', e => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      const [a] = state.atts.splice(Number(b.dataset.x), 1);
      if (a) URL.revokeObjectURL(a.thumb);
      renderAtts(); syncSend();
    });
    els.input.addEventListener('paste', e => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = Array.from(items)
        .filter(i => i.kind === 'file' && (/^image\//.test(i.type) || DOC_MIMES.includes(i.type)))
        .map(i => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    const box = document.querySelector('.composer-box');
    for (const t of ['dragenter', 'dragover']) {
      box.addEventListener(t, e => { e.preventDefault(); box.classList.add('drag'); });
    }
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', e => {
      e.preventDefault();
      box.classList.remove('drag');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
  }

  els.input.addEventListener('input', () => {
    state.sendOverride = false; // editing invalidates a prior "send anyway"
    autosize(); refreshCompletions(); syncSend(); refreshPresendWarn();
  });
  // the @-menu follows the caret, not just the text: moving into or out of a
  // fragment opens/closes it. While the menu is open the arrows are ITS
  // navigation (handled on keydown) — refreshing on their keyup would reset
  // the selection to the top.
  els.input.addEventListener('keyup', e => {
    if (!/^(Arrow|Home|End)/.test(e.key || '')) return;
    if (!els.complete.hidden && /^Arrow(Up|Down)/.test(e.key)) return;
    refreshCompletions();
  });
  els.input.addEventListener('click', () => refreshCompletions());
  els.input.addEventListener('keydown', e => {
    if (!els.complete.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); compSel = (compSel + 1) % compItems.length; renderCompletions(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); compSel = (compSel - 1 + compItems.length) % compItems.length; renderCompletions(); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acceptCompletion(compSel); return; }
      if (e.key === 'Escape') { compItems = []; renderCompletions(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  function submit() {
    const text = els.input.value.trim();
    const ready = state.atts.filter(a => a.status === 'ok');
    if (!text && !ready.length) return;
    if (state.atts.some(a => a.status === 'up')) { toast('still uploading…'); return; }
    // never send into a void: if this turn targets an out-of-credits agent,
    // surface the warning + switch affordance and hold the message (a slash
    // command like /model is control traffic, never gated)
    if (!state.sendOverride && !text.startsWith('/') && presendExhausted(text).length) {
      refreshPresendWarn();
      return;
    }
    state.sendOverride = false;
    if (text && !text.startsWith('/')) state.lastUserText = text;
    els.input.value = '';
    autosize();
    refreshCompletions();
    refreshPresendWarn();
    // exact bridge attachment schema — what the Ink TUI sends: {id, path, type:'image'}
    sendInput(text, ready.map(a => ({ id: a.id, path: a.path, type: 'image' })));
    clearAtts();
    syncSend();
  }
  els.send.addEventListener('click', submit);
  els.stop.addEventListener('click', () => post('/interrupt', {}));

  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // every POST names this tab's bridge so it lands in THIS chat, not
        // whichever chat another tab is driving
        body: JSON.stringify({ bridge: state.bridgeId, ...body }),
      });
      if (r.status === 401) { location.reload(); return null; }
      return await r.json();
    } catch { return null; }
  }
  async function sendInput(text, attachments = []) {
    const r = await post('/input', { text, attachments });
    if (r && r.ok === false && r.error) addMsg('system', `not sent: ${r.error}`);
    // a typed /resume of a chat already open elsewhere: the server refuses to
    // fork the session and asks this tab to re-attach to the live bridge
    else if (r && r.switch) switchTo(r.switch);
    else setBusy(true);
  }

  // ── no-auth warning banner (server started with --no-auth) ──
  els.bannerX.addEventListener('click', () => {
    els.banner.hidden = true;
    localStorage.setItem('council-noauth-dismissed', '1');
  });

  // ── event handling ──
  function handle(ev) {
    switch (ev.type) {
      case 'hello':
        state.bridgeId = ev.bridge_id || null;
        // a freshly spawned bridge is still executing its /resume: its replay
        // shows the interstitial startup chat, so the offscreen buffer must
        // stay up past replay_done until the live 'ready' lands
        state.resuming = !!ev.resuming;
        if (ev.noauth && !localStorage.getItem('council-noauth-dismissed')) els.banner.hidden = false;
        break;
      case 'route_error':
        // the chat this tab asked for could not be attached (unknown id,
        // open-chat limit): we are on the fallback bridge — say so and let
        // the next 'projects' event correct the URL. Remember the refused id
        // so routeHash doesn't immediately re-ask for it (toast loop).
        state.routeErrorSid = state.pendingSwitch || hashSid() || null;
        toast(ev.error || 'chat not found — showing the current chat');
        state.pendingSwitch = null;
        state.resuming = false;
        setSyncing(false);
        break;
      case 'room': {
        const sp = String(ev.speaker).toLowerCase();
        if (sp === 'user' && !ev.restored) break; // we echo user input ourselves
        // tool-run entries get the collapsible card, placed before the reply
        if (AGENTS.includes(sp) &&
            (/:tools$/.test(ev.stream_id || '') || /^Explored\n/.test(ev.text || ''))) {
          addToolsCard(ev.speaker, ev.text, ev.stream_id || '');
          break;
        }
        // a finalized agent turn is the exhaustion signal (or proof it recovered)
        if (AGENTS.includes(sp)) noteAgentTurn(sp, ev.text);
        if (ev.stream_id && finalizeStream(ev)) break;
        addMsg(ev.speaker, ev.text);
        break;
      }
      case 'restore':
        for (const e of ev.entries || []) addMsg(e.speaker, e.text);
        break;
      case 'stream':
        setBusy(true);
        if (ev.kind === 'text_delta') { streamDelta(ev); break; }
        if (ev.model && AGENTS.includes(String(ev.model).toLowerCase())) {
          const m = String(ev.model).toLowerCase();
          if (!state.agents[m]) { state.agents[m] = true; renderAvatars(); }
          // live activity for the agents panel: latest tool + target
          if (ev.kind === 'tool_start') { state.activity[m] = laneActivity(ev); renderAgentsPanel(); }
        }
        if (ev.kind === 'tool_start' || ev.kind === 'tool_done') laneEvent(ev);
        break;
      case 'user_echo':
        if (ev.text && !String(ev.text).startsWith('/')) state.lastUserText = ev.text;
        addMsg('user', ev.text, { attachments: ev.attachments || [] });
        setBusy(true);
        break;
      case 'status':
        state.facts = {
          mode: ev.mode || '', lead: ev.lead || '',
          route: ev.route || '', project: ev.project || '',
        };
        for (const a of AGENTS) {
          state.ctxStat[a] = {
            pct: ev[`${a}_pct`], tokens: ev[`${a}_tokens`], window: ev[`${a}_window`],
          };
          state.relay[a] = {
            at: ev[`${a}_last_relay_at`] || null,
            tier: ev[`${a}_last_relay_tier`] || null,
          };
        }
        {
          // ambient glance only — whole percents; the panel has the detail
          const bits = [];
          if (ev.claude_pct != null) bits.push(`C ${Math.round(ev.claude_pct)}%`);
          if (ev.codex_pct != null) bits.push(`X ${Math.round(ev.codex_pct)}%`);
          els.stCtx.textContent = bits.join(' · ');
        }
        // authoritative current model per agent (additive fields; older
        // bridges omit them and the switcher just shows "—")
        if ('claude_model' in ev) state.models.claude = ev.claude_model || null;
        if ('codex_model' in ev) state.models.codex = ev.codex_model || null;
        if ('claude_effort' in ev) state.effort.claude = ev.claude_effort || null;
        if ('codex_effort' in ev) state.effort.codex = ev.codex_effort || null;
        if ('auto_relay' in ev) { state.autoRelay = !!ev.auto_relay; renderAutoRelay(); }
        renderAgentsPanel();
        break;
      case 'projects': {
        state.projects = ev;
        let active = null;
        for (const pr of ev.projects || []) {
          for (const s of pr.sessions || []) if (s.active) active = s.session_id;
        }
        // Inbox chats carry the active flag too — missing them left
        // currentSid null for unfiled chats (phantom "chat not found")
        for (const s of ev.inbox_sessions || []) if (s.active) active = s.session_id;
        state.currentSid = active;
        autoOpenActiveProject(ev);
        renderProjects();
        // honor a deep-linked #/chat/<id> once, when the session list first
        // arrives; after that the hash mirrors the active chat instead
        if (!hashRestored) { hashRestored = true; routeHash(); }
        // reflect the actually-open chat — but never clobber a hash
        // routeHash is mid-way through opening
        if (!state.pendingSwitch && active) syncHash(active);
        break;
      }
      case 'completion_context':
        state.ctx = { global: ev.global || [], scoped: ev.scoped || {} };
        renderModelSwitcher();
        break;
      case 'ready':
        // a buffered switch replay ends at the bridge's LIVE idle boundary —
        // 'ready' events replayed from server history don't count (the
        // connect replay ends at replay_done instead)
        if (!state.inServerReplay) {
          if (replayBuffer) endSwitch();
          else if (state.pendingSwitch) { state.pendingSwitch = null; setSyncing(false); }
          if (state.replaying) { state.replaying = false; settleBottom(); }
        }
        setBusy(false);
        settleCard();
        freezeLanes();
        state.streams = {};
        for (const el of els.transcript.querySelectorAll('.msg.streaming')) el.classList.remove('streaming');
        break;
      case 'queue':
        state.queued = ev.pending || 0;
        els.queueNote.hidden = !state.queued;
        els.queueNote.textContent = state.queued ? `${state.queued} message${state.queued > 1 ? 's' : ''} queued` : '';
        break;
      case 'clear_panes':
        state.streams = {};
        liveCard = null;
        resetLanes();
        state.replaying = true; // a restore replay follows: pin, no heuristics
        if (state.pendingSwitch) {
          // in-flight switch: keep the optimistic (or outgoing) transcript on
          // screen and build the authoritative one offscreen — never blank.
          // A fresh buffer also drops a resuming bridge's interstitial
          // startup events, which are plumbing, not this chat's transcript.
          replayBuffer = document.createElement('div');
        } else {
          els.transcript.innerHTML = '';
          updateEmpty();
        }
        break;
      case 'replay_done':
        // server-side history replay boundary (connect/reconnect/reattach)
        state.inServerReplay = false;
        state.replaying = false;
        if (replayBuffer && !state.resuming) {
          // attached to a live chat: its replayed history IS the transcript
          endSwitch();
          break;
        }
        // a resuming bridge keeps buffering until its live 'ready';
        // otherwise land pinned at the very bottom and re-assert after
        // layout settles
        if (!replayBuffer) settleBottom();
        break;
      case 'permission_request': permissionCard(ev); break;
      case 'permission_cleared': settleCard(); break;
      case 'choice_request': choiceCard(ev); break;
      case 'choice_cleared': settleCard(); break;
      case 'permission_timeout': settleCard('timed out — denied by default'); break;
      case 'choice_timeout': settleCard('timed out — dismissed'); break;
      case 'bridge_exit':
        if (replayBuffer || state.pendingSwitch) endSwitch(); // don't hang on a stale optimistic view
        addMsg('system', `agent bridge exited (code ${ev.code})${ev.error ? ` — ${ev.error}` : ''}. Restart the server to continue.`);
        setBusy(false);
        break;
      case 'exit':
        if (replayBuffer || state.pendingSwitch) endSwitch();
        addMsg('system', 'session ended.');
        setBusy(false);
        break;
      // mode, notify, bridge_log, ping, permission/choice bookkeeping we
      // don't visualize: ignore quietly
    }
  }

  // ── live transport: WebSocket first, SSE fallback ──
  // WS is primary because proxies/CDN edges (the --share cloudflared tunnel
  // included) buffer streamed HTTP bodies — SSE headers arrive but no events
  // ever do — while WebSocket upgrades are proxied unbuffered.
  let retryMs = 1000;
  let liveSock = null;   // current WebSocket (null when on SSE / disconnected)
  let liveEs = null;     // current EventSource
  let sseMode = false;   // WS proved unusable: stay on SSE for reattaches too
  function setConn(cls, txt) { els.conn.className = `conn ${cls}`; els.conn.textContent = txt; }
  // which chat this tab wants its stream attached to: an in-flight switch
  // wins, then the open chat (reconnects stay on it), then a deep link
  function chatParam() {
    const sid = state.pendingSwitch || state.currentSid || hashSid();
    return sid ? '?chat=' + encodeURIComponent(sid) : '';
  }
  function resetView() {
    // reconnect replays server history from scratch: start clean, keep the
    // scroll pinned until the server's replay_done boundary
    els.transcript.innerHTML = '';
    state.streams = {};
    replayBuffer = null;
    state.inServerReplay = true;
    state.replaying = false;
    state.pendingSwitch = null;
    resetLanes();
    setSyncing(false);
    updateEmpty();
  }
  // connect-time view prep: a deliberate chat switch keeps the visible
  // transcript (cached paint or the outgoing chat) and builds the replayed
  // one offscreen; anything else starts clean
  function prepView() {
    if (state.pendingSwitch) {
      replayBuffer = document.createElement('div');
      state.streams = {};
      liveCard = null;
      resetLanes();
      state.inServerReplay = true;
      state.replaying = false;
    } else {
      resetView();
    }
  }
  function dropTransport() {
    if (liveSock) { const s = liveSock; liveSock = null; s.onclose = null; s.onerror = null; try { s.close(); } catch { } }
    if (liveEs) { try { liveEs.close(); } catch { } liveEs = null; }
  }
  // deliberate re-attach (chat switch): close the current stream without
  // triggering the reconnect path, and connect to the target chat's bridge
  function reattach() {
    dropTransport();
    if (sseMode) connectSSE(); else connect();
  }
  function onLine(data) {
    let ev; try { ev = JSON.parse(data); } catch { return; }
    if (ev.type !== 'ping') handle(ev);
  }
  function scheduleReconnect() {
    setConn('err', '○ reconnecting…');
    setTimeout(() => { if (sseMode) connectSSE(); else connect(); }, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  }
  function connect() {
    prepView();
    let sock;
    try {
      sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + chatParam());
    } catch { sseMode = true; connectSSE(); return; }
    liveSock = sock;
    let opened = false;
    sock.onopen = () => { opened = true; retryMs = 1000; setConn('ok', '● live'); };
    sock.onmessage = e => onLine(e.data);
    sock.onerror = () => { };
    sock.onclose = () => {
      if (liveSock !== sock) return; // superseded by a deliberate reattach
      liveSock = null;
      // never got open: something between us and the server blocks WS — use SSE
      if (!opened) { sseMode = true; connectSSE(); return; }
      scheduleReconnect();
    };
  }
  function connectSSE() {
    prepView(); // idempotent right after connect()'s prep — no events between
    const es = new EventSource('/events' + chatParam());
    liveEs = es;
    es.onopen = () => { retryMs = 1000; setConn('ok', '● live'); };
    es.onmessage = e => onLine(e.data);
    es.onerror = () => {
      if (liveEs !== es) { try { es.close(); } catch { } return; }
      liveEs = null;
      es.close();
      scheduleReconnect();
    };
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('side-open')) closeSide();
    if (e.key === 'Escape') closeAgents();
  });
  // a pasted link or a back/forward navigation between #/chat/<id> hashes
  window.addEventListener('hashchange', routeHash);

  updateEmpty();
  syncSend();
  renderProjects();
  connect();

  // exposed for the DOM test harness
  window.__council = {
    handle, sendInput, computeCompletions, state, els,
    fmt, sysFmt, switchTo, addFiles, submit, sessionCache,
    renderMarkdown, splitEnvelopes, hashText, ticks,
    renderModelSwitcher, refreshPresendWarn, presendExhausted,
    noteAgentTurn, exhaustReason, modelsFor, effortsFor,
    laneEvent, hashSid, syncHash, routeHash, chatParam,
    renderBilling, loadBilling, setKeyInfo: k => { keyInfo = k; renderBilling(); },
  };
})();
