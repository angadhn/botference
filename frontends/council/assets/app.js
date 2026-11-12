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
    newChat: $('new-chat'), newChatLabel: $('new-chat-label'),
    search: $('panel-search'), searchX: $('panel-search-x'), pills: $('panel-pills'),
    note: $('panel-note'), settings: $('panel-settings'), settingsPop: $('settings-pop'),
    projects: $('projects'), theme: $('theme-toggle'), typing: $('typing-toggle'),
    conn: $('st-conn'), stCtx: $('st-ctx'), stTitle: $('st-title'),
    agentCards: $('agent-cards'), agentsBody: $('agents-body'),
    agentsPanel: $('agents-panel'), agentsToggle: $('agents-toggle'),
    apFacts: $('ap-facts'), relayBoth: $('relay-both'), autoRelay: $('autorelay-toggle'),
    billing: $('billing'),
    tasksSec: $('tasks-sec'), tasksBody: $('tasks-body'),
    tasksMeta: $('tasks-meta'), tasksFold: $('tasks-fold'), tasksJump: $('tasks-jump'),
    ptasksSec: $('ptasks-sec'), ptasksBody: $('ptasks-body'),
    ptasksMeta: $('ptasks-meta'), ptasksFold: $('ptasks-fold'),
    presendWarn: $('presend-warn'),
    avatars: $('avatars'), banner: $('noauth-banner'), bannerX: $('noauth-x'),
    chat: $('chat'), transcript: $('transcript'), empty: $('empty'), jump: $('jump'),
    input: $('input'), send: $('send'), stop: $('stop'), complete: $('complete'),
    queueNote: $('queue-note'),
    attach: $('attach'), file: $('file'), attStrip: $('att-strip'),
    mic: $('mic'),
    lassoStrip: $('lasso-strip'),
    routeRow: $('route-row'),
    toast: $('toast'), sync: $('sync'), helpBtn: $('help-btn'),
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

  // ── typewriter: how a live answer arrives ──────────────────────────────
  // WHAT THIS IS NOT: artificial slowness. The bridge hands us text in chunks
  // whose size is an accident of the model's tokenizer and the network — a
  // sentence, then eleven characters, then nothing for a second, then a
  // paragraph. Painted the instant each lands, an answer arrives in visible
  // lurches. The drain smooths only what has ALREADY ARRIVED: a stream's
  // `text` is everything received, `shown` is how much of it is on screen, and
  // a timer walks the second toward the first.
  //
  // The rate is proportional to the backlog — a fraction of what is waiting,
  // every frame — and two things fall out of that for free. A slow stream
  // settles at a lag of a dozen characters (the backlog can only grow until a
  // fraction of it equals the arrival rate), which reads as typing. A burst —
  // a whole paragraph at once — drains in a few frames rather than being typed
  // out at leisure. And the authoritative `room` event paints the final text
  // whole (finalizeStream), so a finished answer is never held hostage.
  const TYPING_KEY = 'council-typing';
  const TYPE_TICK_MS = 16, TYPE_DIV = 8, TYPE_MIN = 1;
  let typeTimer = null;
  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch { return false; }
  }
  // A reader who has asked their OS for less motion has already answered this
  // question; their setting is remembered but not obeyed while that holds.
  function typingPref() {
    try { return localStorage.getItem(TYPING_KEY) === 'instant' ? 'instant' : 'type'; }
    catch { return 'type'; }
  }
  function typewriterOn() { return typingPref() === 'type' && !reducedMotion(); }
  function shownText(s) {
    if (!typewriterOn()) return s.text;
    return s.text.slice(0, Math.min(s.shown == null ? s.text.length : s.shown, s.text.length));
  }
  function typeStep(s) {
    const have = s.text.length, seen = Math.min(s.shown || 0, have);
    if (seen >= have) return false;
    s.shown = Math.min(have, seen + Math.max(TYPE_MIN, Math.ceil((have - seen) / TYPE_DIV)));
    return true;
  }
  function typeDrain() {
    const wasPinned = pinned();
    let moved = false, behind = false;
    for (const k of Object.keys(state.streams)) {
      const s = state.streams[k];
      if (!typeStep(s)) continue;
      moved = true;
      paint(s.el, shownText(s));
      if (s.text.length > s.shown) behind = true;
    }
    if (moved) follow(wasPinned);
    if (!behind) stopTyping();
  }
  function startTyping() {
    if (typeTimer || !typewriterOn()) return;
    typeTimer = setInterval(typeDrain, TYPE_TICK_MS);
  }
  function stopTyping() { if (typeTimer) { clearInterval(typeTimer); typeTimer = null; } }

  const TYPE_LABEL = { type: 'typed', instant: 'instant' };
  function renderTyping() {
    if (!els.typing) return;
    const forced = reducedMotion();
    const cur = forced ? 'instant' : typingPref();
    const tip = forced
      ? 'your system asks for reduced motion — answers arrive instantly'
      : 'how a live answer arrives: typed = revealed as it is written; instant = the moment it lands';
    els.typing.innerHTML = '<div class="chip-label">typing</div>'
      + `<div class="seg" role="group" aria-label="how answers arrive"${forced ? ' data-forced="1"' : ''}>`
      + ['type', 'instant'].map(m =>
        `<button class="seg-btn${m === cur ? ' on' : ''}" data-typing-opt="${m}" title="${esc(tip)}"`
        + ` aria-label="${TYPE_LABEL[m]}" aria-pressed="${m === cur}"${forced ? ' disabled' : ''}>`
        + `${TYPE_LABEL[m]}</button>`).join('')
      + '</div>';
  }
  function setTyping(mode) {
    const want = mode === 'instant' ? 'instant' : 'type';
    try { localStorage.setItem(TYPING_KEY, want); } catch { /* private window: this session only */ }
    // whatever is mid-answer catches up rather than rewinding or freezing
    for (const k of Object.keys(state.streams)) {
      const s = state.streams[k];
      if (want === 'instant') { s.shown = s.text.length; paint(s.el, s.text); }
      else if (s.shown == null) s.shown = s.text.length;
    }
    if (want === 'instant') stopTyping(); else startTyping();
    renderTyping();
  }
  if (els.typing) {
    els.typing.addEventListener('click', e => {
      const b = e.target.closest('[data-typing-opt]');
      if (b && !b.disabled) setTyping(b.dataset.typingOpt);
    });
    renderTyping();
  }

  // ── participant brand marks (Simple Icons path data, inlined; same
  // constant the review frontend ships) ──
  const MARKS = {
    claude: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
    codex: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
    // Gemini's four-point sparkle, drawn rather than fetched (no external
    // image ever reaches this page). Only the video watcher uses it.
    gemini: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 0c0 6.627 5.373 12 12 12-6.627 0-12 5.373-12 12 0-6.627-5.373-12-12-12C6.627 12 12 6.627 12 0Z"/></svg>',
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
  // every built-in model in core/model_catalog.py must appear here
  // (tests/test_model_catalog.py checks); the live list from the bridge
  // replaces this, and also carries models the CLIs list
  const FALLBACK_MODELS = {
    claude: ['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    codex: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5-latest', 'gpt-5.4', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  };
  // The command table the /help popup and the autocomplete hints read: a
  // mirror of core/botference.py COMMAND_HELP (the council rows), used until
  // the bridge's completion_context carries the live one as `commands`.
  const FALLBACK_COMMANDS = [
    {"cmd": "@claude", "args": "<msg>", "hint": "Send to Claude only", "group": "Talking to the bots", "scope": ["tui", "council", "plugin"]},
    {"cmd": "@codex", "args": "<msg>", "hint": "Send to Codex only", "group": "Talking to the bots", "scope": ["tui", "council", "plugin"]},
    {"cmd": "@all", "args": "<msg>", "hint": "Send to both bots", "group": "Talking to the bots", "scope": ["tui", "council", "plugin"]},
    {"cmd": "/parallel", "args": "<prompt>", "hint": "Both answer at once, neither seeing the other's reply", "group": "Talking to the bots", "scope": ["tui", "council", "plugin"]},
    {"cmd": "/watch", "args": "<url> [question]", "hint": "Gemini watches a YouTube video and reports back", "group": "Talking to the bots", "scope": ["tui", "council"]},
    {"cmd": "/lasso", "args": "<words|path|link>", "hint": "Find your pages, chats and files — or paste a link", "group": "Talking to the bots", "scope": ["tui", "council", "plugin"]},
    {"cmd": "/lead", "args": "@claude|@codex", "hint": "Choose who writes the plan", "group": "Planning", "scope": ["tui", "council"]},
    {"cmd": "/draft", "args": "[rounds]", "hint": "Write implementation-plan.md, with review rounds (default 2)", "group": "Planning", "scope": ["tui", "council"]},
    {"cmd": "/finalize", "args": "", "hint": "Answer review comments, write the final plan", "group": "Planning", "scope": ["tui", "council"]},
    {"cmd": "/model", "args": "[@claude|@codex <id>]", "hint": "Show or change a bot's model", "group": "Models", "scope": ["tui", "council"]},
    {"cmd": "/effort", "args": "[@claude|@codex <level>]", "hint": "Show or change how hard a bot thinks", "group": "Models", "scope": ["tui", "council"]},
    {"cmd": "/current-model", "args": "", "hint": "Show both models and effort levels", "group": "Models", "aliases": ["/current"], "scope": ["tui", "council"]},
    {"cmd": "/status", "args": "", "hint": "How full each bot's memory is, who leads, sessions", "group": "Models", "scope": ["tui", "council"]},
    {"cmd": "/relay", "args": "@claude|@codex|@both", "hint": "Restart a bot fresh, with a summary of the chat so far", "group": "Models", "aliases": ["/tag", "/relay-claude", "/relay-codex", "/relay-both"], "scope": ["tui", "council"]},
    {"cmd": "/fresh", "args": "@claude|@codex|@both", "hint": "Restart a bot with no memory of this chat", "group": "Models", "scope": ["tui", "council"]},
    {"cmd": "/autorelay", "args": "[on|off]", "hint": "Restart a bot by itself at 50% memory (on by default)", "group": "Models", "scope": ["tui", "council"]},
    {"cmd": "/compact", "args": "@claude [instructions]", "hint": "Claude Code's own /compact (needs --claude-interactive)", "group": "Models", "scope": ["tui", "council"]},
    {"cmd": "/goal", "args": "@claude <objective>", "hint": "Claude Code's own /goal (needs --claude-interactive)", "group": "Models", "scope": ["tui", "council"]},
    {"cmd": "/auth", "args": "[claude|codex|all]", "hint": "Check the bots are signed in", "group": "Models", "scope": ["tui", "council"]},
    {"cmd": "/new", "args": "[title]", "hint": "Start a fresh chat (this one is saved)", "group": "Chat", "scope": ["tui", "council"]},
    {"cmd": "/resume", "args": "[latest|number|title|id]", "hint": "Switch to a saved chat, in any project", "group": "Chat", "scope": ["tui", "council"]},
    {"cmd": "/rename", "args": "<name>|auto", "hint": "Name this chat (auto: a short title from the model)", "group": "Chat", "scope": ["tui", "council"]},
    {"cmd": "/adopt", "args": "[<id-prefix>]", "hint": "Carry on a Claude Code chat from outside here", "group": "Chat", "scope": ["tui", "council"]},
    {"cmd": "/file", "args": "[<project-id>]", "hint": "File this chat under a project", "group": "Chat", "aliases": ["/add-to-project"], "scope": ["tui", "council"]},
    {"cmd": "/delete", "args": "[<id-prefix>]", "hint": "Delete a saved chat (asks first)", "group": "Chat", "scope": ["tui", "council"]},
    {"cmd": "/archive", "args": "[<id-prefix>|list]", "hint": "Put a saved chat away (can be undone)", "group": "Chat", "scope": ["tui", "council"]},
    {"cmd": "/unarchive", "args": "[<id-prefix>]", "hint": "Bring an archived chat back", "group": "Chat", "scope": ["tui", "council"]},
    {"cmd": "/projects", "args": "", "hint": "List your projects", "group": "Projects", "scope": ["tui", "council"]},
    {"cmd": "/new-project", "args": "<title>", "hint": "Create a project and file this chat under it", "group": "Projects", "scope": ["tui", "council"]},
    {"cmd": "/open-project", "args": "<id or title>", "hint": "Make an existing project current", "group": "Projects", "scope": ["tui", "council"]},
    {"cmd": "/project", "args": "[open <id>|clear|create <title>|…]", "hint": "Open, show, create or tidy projects", "group": "Projects", "aliases": ["/assign-project", "/unfile-project", "/clear-project", "/current-project", "/project-contents", "/project-github", "/archive-project", "/unarchive-project", "/project-from-chat", "/activate-build"], "scope": ["tui", "council"]},
    {"cmd": "/delete-project", "args": "<id>", "hint": "Delete a project and every chat in it (asks first)", "group": "Projects", "scope": ["tui", "council"]},
    {"cmd": "/verify", "args": "[on|off]", "hint": "When they agree, the other bot checks the sources", "group": "Settings", "scope": ["tui", "council"]},
    {"cmd": "/agents", "args": "[on|off]", "hint": "Let Claude use helper agents (off by default)", "group": "Settings", "scope": ["tui", "council"]},
    {"cmd": "/notify", "args": "[on|off]", "hint": "Desktop notice when the bots finish", "group": "Settings", "scope": ["tui", "council"]},
    {"cmd": "/allow-host", "args": "[<domain>|remove <domain>]", "hint": "Only for allowlist mode: let the bots reach a site", "group": "Settings", "scope": ["tui", "council"]},
    {"cmd": "/permissions", "args": "", "hint": "Where the bots may write files", "group": "Settings", "scope": ["tui", "council"]},
    {"cmd": "/help", "args": "", "hint": "This list", "group": "Help", "scope": ["tui", "council", "plugin"]},
  ];
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
      '/fresh @claude', '/fresh @codex', '/fresh @both',
      '/model @claude', '/model @codex',
      '/effort @claude', '/effort @codex', '/compact @claude', '/compact @codex',
      '/goal @claude', '/goal @codex',
      '/projects', '/project', '/new-project', '/open-project', '/assign-project',
      '/unfile-project', '/clear-project', '/current-project', '/project-contents',
      '/project-github', '/archive-project', '/unarchive-project', '/delete-project',
      '/project-from-chat',
      '/activate-build', '/adopt', '/new', '/file', '/add-to-project',
      '/delete', '/archive', '/unarchive',
      '/draft', '/finalize', '/resume', '/rename', '/permissions',
      '/status', '/notify', '/autorelay', '/agents', '/auth', '/current-model', '/current',
      '/allow-host', '/watch', '/parallel',
      '/help', '/quit', '/exit', '@claude ', '@codex ', '@all ',
    ],
    scoped: {
      '/project ': ['open', 'clear', 'current', 'create', 'create-from-chat',
        'assign', 'archive', 'unarchive', 'delete', 'activate-build'],
      '/model @claude ': FALLBACK_MODELS.claude,
      '/model @codex ': FALLBACK_MODELS.codex,
      '/effort @claude ': ['low', 'medium', 'high', 'xhigh', 'max'],
      '/effort @codex ': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    commands: FALLBACK_COMMANDS,
  };
  const FALLBACK_EFFORT = {
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
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
    roomTurn: 'idle',      // one of ROOM_TURNS; moved only by setRoomTurn
    queued: 0,
    agentMode: { claude: 'idle', codex: 'idle' }, // one of AGENT_MODES per bot; moved only by setAgentMode
    streams: {},           // key "model:stream_id" -> {el, text}
    summonTimer: null,     // the live clock on summoned agents' working cards
    ctx: FALLBACK_CTX,
    models: { claude: null, codex: null },     // current model per agent (from status)
    effort: { claude: null, codex: null },     // current reasoning effort (from status)
    exhausted: { claude: null, codex: null },  // credit-exhaustion reason string or null
    autoRelay: true,                           // auto-relay at 50% context (from status)
    ctxStat: { claude: null, codex: null },    // {pct, tokens, window} per agent (from status)
    relay: { claude: null, codex: null },      // {at, tier} last-relay provenance (from status)
    activity: { claude: null, codex: null },   // latest tool label while an agent works
    // The video watcher, which is NOT a participant: the mark exists only
    // while a watch is in flight, plus a moment afterwards so the outcome is
    // seen. `phase` is 'watching' | 'done' | 'error' | null (no mark at all).
    gemini: { phase: null, url: '', timer: null },
    facts: { mode: '', lead: '', route: '', project: '' },  // session facts (from status)
    lastUserText: '',                          // last human turn, for "retry with @other"
    // ── who this chat is talking to ──
    // `routePick` is the pill the reader clicked, per chat (a choice about THIS
    // chat, dropped when they leave it). `routeSticky` is the memory: the tag
    // on the last thing the reader actually sent here, rebuilt from the replay
    // on every attach, so a reload does not forget the conversation.
    routePick: new Map(),                      // sid -> 'claude'|'codex'|'all'
    routeSticky: '',                           // derived from the transcript
    presend: 'guarded',                        // one of PRESEND_MODES; moved only by setPresend
    projects: null,
    // The left panel. Three named modes, each moved only by its own setter
    // (the lists and the rules are at "left panel" below):
    panel: Object.freeze({ view: 'chats' }),            // what the list shows: one of PANEL_VIEWS — setPanelView
    row: Object.freeze({ mode: 'resting', key: '' }),   // what ONE row is doing: one of ROW_MODES — setRowMode
    slideOut: 'closed',                                 // the panel itself: one of SLIDE_MODES — setSlideOut
    panelNote: null,           // "Moved to X. Undo": null or {text, undo, open} — setPanelNote
    homedSid: null,            // the chat the panel last opened itself onto
    // a project's file list, read once per tab: pid -> {load, files}, where
    // load is one of CONTENTS_LOADS — setContentsLoad
    contents: {},
    // the web-page chats (the browser plugin's): load is one of
    // PAGE_CHATS_LOADS — setPageChatsLoad
    pageChats: Object.freeze({ load: 'idle', rows: [], total: 0, base: '' }),
    // what the transcript pane is doing: one of TRANSCRIPT_MODES, moved only
    // by setTranscriptMode. A page boots catching up on the server's replay.
    transcriptMode: 'catching_up',
    // what this tab's stream is waiting on: one of ATTACH_MODES, moved only
    // by setAttachMode. The chat a switch is going to is switchTarget().
    attachMode: 'open',
    currentSid: null,      // active session id (from 'projects' events)
    routeErrorSid: null,   // chat id the server just refused (route_error)
    bridgeId: null,        // this tab's bridge (from 'hello'); named in every POST
    atts: [],              // composer attachments: {id, path, url, thumb, status}
    // what has been LASSOED into this chat (controller-side; the strip
    // above the composer). Not the composer's own attachments: these are
    // files the bots read on every turn until the ✕ takes one off.
    lassoOn: [],
    lanes: {},             // subagent progress lane: tool_use_id -> lane record
    laneCard: null,        // the in-progress turn's lane card element (null between turns)
    laneTimer: null,       // interval ticking the running lanes' elapsed clocks
  };
  // The transcript pane's modes (what each means: at setTranscriptMode) and
  // the one pure rule for moving between them. freshPane: the move brings a
  // new hidden pane (a switch's or a redraw's offscreen build).
  const TRANSCRIPT_MODES = ['live', 'catching_up', 'redrawing',
    'offscreen_catching_up', 'offscreen_redrawing', 'offscreen_waiting'];
  const OFFSCREEN_MODES = ['offscreen_catching_up', 'offscreen_redrawing', 'offscreen_waiting'];
  // what each offscreen mode becomes when its hidden pane is swapped in
  const SWAPS_TO = { offscreen_catching_up: 'catching_up', offscreen_redrawing: 'redrawing', offscreen_waiting: 'live' };
  const TRANSCRIPT_MOVES = new Set([
    // the server's replay is over (replay_done), or a redraw ends (ready)
    'catching_up>live', 'redrawing>live',
    'offscreen_catching_up>offscreen_waiting', 'offscreen_redrawing>offscreen_waiting',
    // the chat is cleared with no switch under way
    'live>redrawing', 'offscreen_waiting>offscreen_redrawing',
    // the hidden pane is swapped in
    ...Object.entries(SWAPS_TO).map(([a, b]) => a + '>' + b),
    // a (re)connect with no switch starts a clean catch-up from anywhere
    ...TRANSCRIPT_MODES.map(m => m + '>catching_up'),
  ]);
  const TRANSCRIPT_MOVES_WITH_PANE = new Set([
    // a (re)connect for a switch, or a clear during the server's replay
    ...TRANSCRIPT_MODES.map(m => m + '>offscreen_catching_up'),
    // a clear while switching or opening, once the server's replay is over
    ...['live', 'redrawing', 'offscreen_redrawing', 'offscreen_waiting'].map(m => m + '>offscreen_redrawing'),
  ]);
  function transcriptMove(from, to, freshPane) {
    if (!TRANSCRIPT_MODES.includes(from) || !TRANSCRIPT_MODES.includes(to)) return false;
    return (freshPane ? TRANSCRIPT_MOVES_WITH_PANE : TRANSCRIPT_MOVES).has(from + '>' + to);
  }
  // What this tab's stream is waiting on. One of ATTACH_MODES, kept in
  // state.attachMode and moved only by setAttachMode, which refuses a move
  // attachMove does not allow:
  //   open               — the chat on screen is the one the stream is on;
  //                        nothing is waited for;
  //   switching          — the reader picked another chat (switchTarget());
  //                        the stream is moving to it;
  //   resuming           — the attached bot process is still opening its
  //                        saved chat (the server's hello said so); its live
  //                        ready ends the wait;
  //   switching_resuming — both: the picked chat's process is still opening.
  // Two facts, one field: the switch is the reader's, the resuming is the
  // server's, and every pairing of them happens, so each pairing is named.
  // The switch target exists exactly in the switching modes; only
  // setAttachMode sets or drops it.
  const ATTACH_MODES = ['open', 'switching', 'resuming', 'switching_resuming'];
  const SWITCHING_MODES = ['switching', 'switching_resuming'];
  const ATTACH_MOVES = new Set([
    // a chat is picked (another one, even mid-switch): the stream moves
    ...ATTACH_MODES.map(m => m + '>switching'),
    // the server says the process is (still) opening its saved chat…
    'open>resuming', 'resuming>resuming',
    'switching>switching_resuming', 'switching_resuming>switching_resuming',
    // …or that it is open (switching_resuming>switching is above)
    'resuming>open',
    // the switch is let go while the process still opens
    'switching_resuming>resuming',
    // all settled: the switch landed, was refused, or the stream ended
    ...ATTACH_MODES.map(m => m + '>open'),
  ]);
  // a move INTO switching names the chat it goes to; a move within the
  // switching modes may keep the one it has
  function attachMove(from, to, target) {
    if (!ATTACH_MODES.includes(from) || !ATTACH_MODES.includes(to)) return false;
    if (!ATTACH_MOVES.has(from + '>' + to)) return false;
    if (SWITCHING_MODES.includes(to) && !SWITCHING_MODES.includes(from) && !target) return false;
    return true;
  }
  let switchSid = null;
  function setAttachMode(to, target = null) {
    if (!attachMove(state.attachMode, to, target)) return false;
    state.attachMode = to;
    if (!SWITCHING_MODES.includes(to)) switchSid = null;
    else if (target) switchSid = target;
    return true;
  }
  // the chat a switch is going to, or null when none is under way
  const switchTarget = () => switchSid;
  // the attached process is still opening its saved chat
  const bridgeResuming = () => state.attachMode === 'resuming' || state.attachMode === 'switching_resuming';
  // what the server says about the process (hello, bots_stopped)
  function noteResuming(on) {
    const switching = SWITCHING_MODES.includes(state.attachMode);
    return setAttachMode(on ? (switching ? 'switching_resuming' : 'resuming') : (switching ? 'switching' : 'open'));
  }
  // let the switch go, keeping what the server said about the process
  function dropSwitch() {
    if (state.attachMode === 'switching') return setAttachMode('open');
    if (state.attachMode === 'switching_resuming') return setAttachMode('resuming');
    return false;
  }
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
      const on = state.agentMode[a] === 'working';
      const ex = state.exhausted[a];
      const tip = ex ? `${name} is out of credits — ${ex}` : `${name}${on ? ' is working…' : ' — idle'}`;
      return `<span class="avatar-ring${on ? ' working' : ''}${ex ? ' exhausted' : ''}" style="--author:var(--${a})" title="${esc(tip)}">${avatarHtml(a)}${ex ? '<span class="warn-badge" aria-hidden="true">⚠</span>' : ''}</span>`;
    }).join('') + geminiMarkHtml();
  }

  const geminiAvatarHtml = () =>
    `<span class="avatar" style="--author:var(--gemini)" aria-hidden="true">${MARKS.gemini}</span>`;

  // The video watcher's mark — present only while it is working, plus a beat
  // afterwards so the reader sees how it went. Gemini is a tool the room used,
  // not a third participant, so nothing lingers in the header once it is done.
  const GEMINI_HOLD = { done: 1500, error: 4000 };  // ms the outcome stays up
  function geminiMarkHtml() {
    const g = state.gemini;
    if (!g.phase) return '';
    const tip = g.phase === 'watching' ? `Gemini is watching ${g.url}`
      : g.phase === 'error' ? `Gemini could not watch ${g.url}`
        : `Gemini watched ${g.url}`;
    const cls = g.phase === 'watching' ? ' working'
      : g.phase === 'error' ? ' warn' : ' done';
    const badge = g.phase === 'error' ? '<span class="warn-badge" aria-hidden="true">⚠</span>'
      : g.phase === 'done' ? '<span class="tick-badge" aria-hidden="true">✓</span>' : '';
    return `<span class="avatar-ring gemini${cls}" style="--author:var(--gemini)" title="${esc(tip)}" data-mark="gemini">`
      + `<span class="avatar" style="--author:var(--gemini)" aria-hidden="true">${MARKS.gemini}</span>`
      + badge + '</span>';
  }
  // Move the mark to a phase, and (for the two settled phases) arrange its
  // disappearance. A watch is an act with an end, not a member of the room.
  function geminiPhase(phase, url) {
    const g = state.gemini;
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
    g.phase = phase;
    if (url) g.url = url;
    if (phase && phase !== 'watching') {
      g.timer = setTimeout(() => { g.timer = null; g.phase = null; renderAvatars(); },
        GEMINI_HOLD[phase] || 1500);
    }
    renderAvatars();
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
    // the bridge reports the model as the CLI names it — "claude-fable-5[1m]"
    // for a 1M-context run — while the picker lists plain ids. Match on the
    // plain id, or a live Fable 5 shows as whatever option comes first.
    const cur = String(state.models[a] || '').replace(/\[1m\]$/, '');
    const ex = state.exhausted[a];
    const st = state.ctxStat[a];
    const pct = st && st.pct != null ? Math.max(0, Math.min(100, st.pct)) : null;
    const working = state.agentMode[a] === 'working';
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
    setAgentMode(agent, 'idle');  // its turn ended
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
    if (!offscreen()) { updateEmpty(); follow(wasPinned); }
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
    // an untagged message is not necessarily the room's any more: the pill row
    // may be aiming it at one bot, and that is the one it would reach
    const aimed = routeWordOf(t) ? '' : routeNow();
    const reach = (aimed && aimed !== 'all') ? [aimed] : mentionedAgents(t);
    return reach.every(a => state.exhausted[a]) ? reach.filter(a => state.exhausted[a]) : [];
  }
  function refreshPresendWarn() {
    if (!els.presendWarn) return;
    if (state.presend === 'send_anyway') { els.presendWarn.hidden = true; els.presendWarn.innerHTML = ''; return; }
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
      setPresend('send_anyway'); refreshPresendWarn(); submit();
    });
  }

  // "N messages queued" counts the messages waiting in ONE chat's bot process
  function showQueued(n) {
    state.queued = n;
    els.queueNote.hidden = !n;
    els.queueNote.textContent = n ? `${n} message${n > 1 ? 's' : ''} queued` : '';
  }
  // Whose turn it is, per bot. Each bot is in one of AGENT_MODES, kept in
  // state.agentMode[bot] and moved only here:
  //   idle    — not answering (its ring is still, its card says "idle");
  //   working — its turn is under way (ring spins, card says "working…").
  // A bot goes to work when its stream starts and back to idle the moment ITS
  // turn ends (the stream's 'done', or its finished message) — not when the
  // whole room goes quiet, which left the first bot "working" all through the
  // second bot's turn and the panel never showed the turn passing over.
  const AGENT_MODES = ['idle', 'working'];
  function setAgentMode(a, to) {
    if (!AGENTS.includes(a) || !AGENT_MODES.includes(to) || state.agentMode[a] === to) return false;
    state.agentMode[a] = to;
    if (to === 'idle') state.activity[a] = null;
    renderAvatars();
    renderAgentsPanel();
    return true;
  }
  // Whose turn the ROOM is in. One of ROOM_TURNS, kept in state.roomTurn and
  // moved only by setRoomTurn:
  //   idle    — nothing is being answered; the stop button is hidden;
  //   working — a message is being answered (from its echo or first stream
  //             event to the next ready); the stop button shows.
  // Either may follow either; saying the same again is no move, but going
  // idle always settles every bot's own mode (a lost 'done' cannot leave a
  // ring spinning past the room's ready).
  const ROOM_TURNS = ['idle', 'working'];
  function setRoomTurn(to) {
    if (!ROOM_TURNS.includes(to)) return false;
    const moved = state.roomTurn !== to;
    state.roomTurn = to;
    els.stop.hidden = to !== 'working';
    if (to === 'idle') {
      for (const a of AGENTS) setAgentMode(a, 'idle');
    }
    return moved;
  }
  // The pre-send guard (an out-of-credits bot would get this message). One of
  // PRESEND_MODES, kept in state.presend and moved only by setPresend:
  //   guarded     — a message that would reach only out-of-credits bots is
  //                 held and the warning shows;
  //   send_anyway — the reader pressed "send anyway": the next send goes
  //                 through, once. Sending or editing the text guards again.
  const PRESEND_MODES = ['guarded', 'send_anyway'];
  const PRESEND_MOVES = new Set(['guarded>send_anyway', 'send_anyway>guarded']);
  function setPresend(to) {
    if (!PRESEND_MODES.includes(to) || !PRESEND_MOVES.has(state.presend + '>' + to)) return false;
    state.presend = to;
    return true;
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
  // The old-school copy: select a hidden textarea and ask the browser to
  // copy it. It is what still works when the clipboard API refuses — which
  // on a phone it does more often than not (Safari wants the call inside the
  // tap, and a page behind a tunnel is not always "secure" to it).
  function copyLegacy(t) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      ta.setSelectionRange(0, t.length);  // iOS ignores select() alone
      const ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch { return false; }
  }
  // Every copy goes through here, so a failure is SAID rather than swallowed:
  // the old version caught the clipboard's rejection and showed nothing, and
  // on a phone that read as "the button does nothing".
  async function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(t); toast('copied ✓'); return true; }
      catch { /* fall through */ }
    }
    if (copyLegacy(t)) { toast('copied ✓'); return true; }
    toast('copy failed — long-press the text to select it');
    return false;
  }
  // whole-message copy: rich HTML *and* plain markdown on the clipboard, so a
  // paste into a doc keeps the links and headings while a paste into a text
  // field gets the markdown the agent actually wrote. Older browsers (and any
  // context where ClipboardItem is missing) fall back to the plain text.
  // The rich write is attempted SYNCHRONOUSLY, before any await: Safari only
  // honours a clipboard write while the tap that caused it is still live, and
  // an await in between is what lost it on the phone.
  function copyMessage(msg) {
    const text = msg.getAttribute('data-raw') || (msg.querySelector('.body') || msg).textContent || '';
    const body = msg.querySelector('.body');
    const nav = navigator;
    if (body && nav.clipboard && nav.clipboard.write &&
        typeof window.ClipboardItem === 'function' && typeof window.Blob === 'function') {
      try {
        const p = nav.clipboard.write([new window.ClipboardItem({
          'text/html': new window.Blob([body.innerHTML], { type: 'text/html' }),
          'text/plain': new window.Blob([text], { type: 'text/plain' }),
        })]);
        p.then(() => toast('copied ✓')).catch(() => copyText(text));
        return;
      } catch { /* fall through to plain text */ }
    }
    copyText(text);
  }
  els.chat.addEventListener('click', e => {
    const copyBtn = e.target.closest('.msg-copy');
    if (copyBtn) { copyMessage(copyBtn.closest('.msg')); return; }
    // a folded video report: delegated, so it survives a cached re-render
    const moreBtn = e.target.closest('[data-act="gemini-more"]');
    if (moreBtn) {
      // Unfolding grows the transcript, and the bottom-follower would read
      // that growth as "new content" and pin the view to the bottom — so the
      // reader who pressed "show more" lands past the report they opened.
      // Hold the button where it is on screen and tell the follower to sit out.
      const body = moreBtn.parentNode.querySelector('.body');
      const before = moreBtn.getBoundingClientRect().top;
      holdFollowUntil = Date.now() + 800;
      const open = body.classList.toggle('clipped');
      moreBtn.textContent = open ? 'show more' : 'show less';
      const after = moreBtn.getBoundingClientRect().top;
      if (open) els.chat.scrollTop += after - before;   // folding: keep the button under the finger
      else els.chat.scrollTop = Math.max(0, els.chat.scrollTop - 0); // unfolding: view stays where it was
      return;
    }
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
    renderTasks(); // the panel's copy is the same state — keep it honest
    // …and the tick reaches the bots: the controller flips the item in the
    // shared transcript and leaves them a note (Botference.record_tick)
    post('/tick', { text: box.getAttribute('aria-label') || '', checked: !!box.checked });
  });

  function updateEmpty() {
    els.empty.hidden = els.transcript.children.length > 0;
  }
  // ── what the transcript pane is doing ──
  // One of TRANSCRIPT_MODES, kept in state.transcriptMode and moved only by
  // setTranscriptMode, which refuses a move transcriptMove does not allow:
  //   live                  — showing the open chat; events land on screen;
  //   catching_up           — the server is replaying this chat's history
  //                           onto the screen ((re)connect → replay_done);
  //   redrawing             — the chat was cleared (resume / new chat) and is
  //                           being drawn again on screen, until the next ready;
  //   offscreen_catching_up — a switched-to chat's history is being built in
  //                           a hidden pane while the old view stays on screen
  //                           (no blank flash);
  //   offscreen_redrawing   — a cleared chat is being drawn in a hidden pane;
  //   offscreen_waiting     — the hidden pane has the history; it swaps in at
  //                           the opening chat's first live ready.
  // The hidden pane (replayBuffer) exists exactly in the offscreen_ modes;
  // only setTranscriptMode sets or drops it. Swapping it in moves each
  // offscreen_ mode to its on-screen twin (SWAPS_TO).
  let replayBuffer = null;
  const container = () => replayBuffer || els.transcript;
  function offscreen() { return OFFSCREEN_MODES.includes(state.transcriptMode); }
  function serverReplay() { return state.transcriptMode === 'catching_up' || state.transcriptMode === 'offscreen_catching_up'; }
  function setTranscriptMode(to, freshPane = null) {
    if (!transcriptMove(state.transcriptMode, to, !!freshPane)) return false;
    state.transcriptMode = to;
    if (!OFFSCREEN_MODES.includes(to)) replayBuffer = null;
    else if (freshPane) replayBuffer = freshPane;
    return true;
  }
  const raf = typeof window.requestAnimationFrame === 'function'
    ? cb => window.requestAnimationFrame(cb) : cb => setTimeout(cb, 16);
  const atBottom = () => els.chat.scrollTop + els.chat.clientHeight >= els.chat.scrollHeight - 90;
  // While a replay streams in, the "did the user scroll up?" heuristic is
  // meaningless (the user did nothing — the layout is moving under them),
  // so it is suppressed entirely and the view stays pinned.
  const replayActive = () => state.transcriptMode !== 'live' && state.transcriptMode !== 'offscreen_waiting';
  const pinned = () => replayActive() || atBottom();
  function pinBottom() { els.chat.scrollTop = els.chat.scrollHeight; els.jump.hidden = true; }
  // pin now AND after layout settles (fonts, images, status strip): a late
  // reflow after the last scroll write is exactly what used to leave the
  // transcript parked at a weird mid-scroll anchor
  function settleBottom() {
    pinBottom();
    raf(() => raf(pinBottom));
  }
  let holdFollowUntil = 0;   // a deliberate layout change (unfolding a report) is not new content
  function follow(wasPinned) {
    if (offscreen()) return; // offscreen render: nothing to scroll
    if (Date.now() < holdFollowUntil) return;
    if (wasPinned) pinBottom();
    else els.jump.hidden = false;
  }
  els.chat.addEventListener('scroll', () => { if (atBottom()) els.jump.hidden = true; rememberScroll(); });
  // ── where you were, across a reload ────────────────────────────────
  // A phone evicts a background tab and reloads it on return; the replay
  // would land at the bottom, wherever you had been reading. So the place is
  // written to sessionStorage (this tab only) as you scroll and when the tab
  // hides, and put back once the same chat's replay has landed — unless you
  // were at the bottom, where "the bottom" is the right answer anyway.
  const SCROLL_KEY = 'council-scroll';
  let scrollMemoTimer = null;
  function rememberScroll() {
    if (!state.currentSid || offscreen() || serverReplay()) return;
    if (scrollMemoTimer) return;
    scrollMemoTimer = setTimeout(() => {
      scrollMemoTimer = null;
      try {
        sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
          sid: state.currentSid, top: els.chat.scrollTop, atBottom: atBottom(),
          n: els.transcript.children.length, at: Date.now(),
        }));
      } catch { }
    }, 250);
  }
  function recallScroll() {
    let memo = null;
    try { memo = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null'); } catch { }
    if (!memo || memo.sid !== state.currentSid || memo.atBottom) return false;
    // the same transcript, give or take a few live messages — otherwise the
    // offsets mean nothing and the bottom is the honest landing
    if (Math.abs((memo.n || 0) - els.transcript.children.length) > 3) return false;
    els.chat.scrollTop = memo.top;
    els.jump.hidden = atBottom();
    return true;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { scrollMemoTimer = null; rememberScroll(); } });
  window.addEventListener('pagehide', () => { if (scrollMemoTimer) { clearTimeout(scrollMemoTimer); scrollMemoTimer = null; } rememberScroll(); });
  els.jump.addEventListener('click', () => pinBottom());
  // late layout shifts (image loads, font swaps) re-assert the bottom as
  // long as the user hasn't deliberately scrolled up (jump pill hidden)
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (Date.now() < holdFollowUntil) return;
      if (replayActive() || els.jump.hidden) {
        if (!atBottom()) pinBottom();
      }
    }).observe(els.transcript);
  }

  // ── tasks panel: the current checklist, always in view ───────────────────
  // The bots re-issue their task list as the plan moves, and the reader loses
  // the live one as the transcript scrolls. This panel shows the checklist from
  // the NEWEST message that carries one, whoever wrote it — derived from the
  // transcript, never stored: no server state, no protocol change. A revised
  // list REPLACES what is here, so there is only ever one, and it is current.
  //
  // Tracking is incremental: every paint() offers its message as the candidate
  // (the newest paint wins), and a full rescan happens only at the boundaries
  // where the transcript is rebuilt wholesale — replay swap, chat switch,
  // clear. No polling, no per-message walk of the whole transcript.
  //
  // Honest limit: ticks are keyed by message hash (see the tick store), so a
  // revised list starts from what its own [x] marks say. The bots re-issue with
  // the completed items already ticked, which is the right source of truth
  // anyway — nothing here guesses which old item became which new one.
  const TASK_FOLD_KEY = 'council-tasks-fold';
  let taskSrc = null;   // the message element the panel is showing
  let taskAt = 0;       // when we first saw it live (0 = replayed, age unknown)
  const taskLists = body =>
    body ? body.querySelectorAll('ul.md-tasklist, ol.md-tasklist') : [];
  // is `a` the same as, or later than, `b` in the transcript? A repaint of an
  // OLDER message (an edit, a late finalize) must not steal the panel.
  function atOrAfter(a, b) {
    if (!b || !b.parentNode) return true;
    if (a === b) return true;
    if (a.parentNode !== b.parentNode) return true; // different containers: can't tell, take it
    const kids = a.parentNode.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] === a) return false;              // a comes first: it is older
      if (kids[i] === b) return true;
    }
    return true;
  }
  // offered by paint() for every markdown message, live and replayed alike
  function noteTasks(div, body) {
    if (offscreen()) return;                // offscreen build: the flush rescans
    if (taskLists(body).length) {
      if (!atOrAfter(div, taskSrc)) return;
      if (div !== taskSrc) { taskSrc = div; taskAt = replayActive() ? 0 : Date.now(); }
      renderTasks();
    } else if (div === taskSrc) {
      rescanTasks();                        // a rewrite dropped the list
    }
  }
  // boundary rescan: newest message with a checklist wins, backwards from the end
  function rescanTasks() {
    taskSrc = null;
    taskAt = 0;
    const msgs = els.transcript.children;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.querySelector && taskLists(m.querySelector('.body')).length) { taskSrc = m; break; }
    }
    renderTasks();
  }
  const taskAge = at => {
    const d = (Date.now() - at) / 1000;
    if (d < 45) return 'just now';
    if (d < 3600) return `${Math.round(d / 60)}m ago`;
    if (d < 86400) return `${Math.round(d / 3600)}h ago`;
    return `${Math.round(d / 86400)}d ago`;
  };
  function taskAuthor() {
    if (!taskSrc || !taskSrc.classList) return '';
    if (taskSrc.classList.contains('user')) return 'you';
    return AGENTS.find(a => taskSrc.classList.contains(a)) || '';
  }
  function updateTasksMeta() {
    if (!els.tasksMeta) return;
    const boxes = els.tasksBody.querySelectorAll('input.md-tick');
    const done = [...boxes].filter(b => b.checked).length;
    const who = taskAuthor();
    els.tasksMeta.textContent = [
      who ? 'from ' + who : '', `${done}/${boxes.length} done`, taskAt ? taskAge(taskAt) : '',
    ].filter(Boolean).join(' · ');
  }
  function applyTaskFold() {
    if (!els.tasksFold) return;
    const open = localStorage.getItem(TASK_FOLD_KEY) !== 'closed';
    els.tasksSec.classList.toggle('folded', !open);
    els.tasksFold.setAttribute('aria-expanded', String(open));
    els.tasksFold.title = open ? 'collapse the task list' : 'expand the task list';
    els.tasksBody.hidden = !open;
    els.tasksMeta.hidden = !open;
  }
  // clone the source lists into the panel. The clone keeps the data-tick
  // ordinals, so the panel's boxes address exactly the same tick records; the
  // checked state is copied from the (already tick-applied) source and then the
  // store is laid over it, so both agree by construction.
  // ── the project's own list: projects/<id>/TASKS.md ───────────────────────
  // Everything above this line is derived from the transcript and belongs to
  // ONE chat. This is the other kind of list: a file on disk that outlives
  // every chat in the project, which the bots extend, tick and prune (and are
  // told never to rewrite wholesale, because another chat's items live in it).
  // It arrives on the `projects` event as `tasks: [{text, done}]`, already
  // parsed by the controller — the panel never parses markdown for it.
  //
  // READ-ONLY, deliberately: the browser does not own that file, and a tick
  // here would have to round-trip a rewrite of somebody else's markdown. The
  // boxes are disabled and the meta line says where the list lives.
  const PTASK_FOLD_KEY = 'council-ptasks-fold';
  let ptasks = { title: '', items: [] };
  function applyPTaskFold() {
    if (!els.ptasksFold) return;
    let open = true;
    try { open = localStorage.getItem(PTASK_FOLD_KEY) !== 'closed'; } catch { }
    els.ptasksSec.classList.toggle('folded', !open);
    els.ptasksFold.setAttribute('aria-expanded', String(open));
    els.ptasksFold.title = open ? 'collapse the project list' : 'expand the project list';
    els.ptasksBody.hidden = !open;
    els.ptasksMeta.hidden = !open;
  }
  // Defensive by contract: TASKS.md is bot-written, so anything that is not a
  // usable {text} object is dropped rather than painted as an empty row.
  function noteProjectTasks(ev) {
    let found = { title: '', items: [] };
    for (const pr of (ev && ev.projects) || []) {
      if (!pr || !pr.active) continue;
      const items = Array.isArray(pr.tasks) ? pr.tasks : [];
      found = {
        title: String(pr.title || pr.id || ''),
        items: items
          .filter(t => t && typeof t === 'object' && String(t.text || '').trim())
          .map(t => ({ text: String(t.text).trim(), done: !!t.done })),
      };
      break;
    }
    ptasks = found;
    renderProjectTasks();
  }
  function renderProjectTasks() {
    if (!els.ptasksSec) return;
    if (!ptasks.items.length) {
      els.ptasksSec.hidden = true;
      els.ptasksBody.textContent = '';
      els.ptasksMeta.textContent = '';
      syncApView();
      return;
    }
    const done = ptasks.items.filter(t => t.done).length;
    els.ptasksBody.innerHTML =
      `<ul class="md-tasklist ptasklist">${ptasks.items.map(t =>
        `<li class="md-task${t.done ? ' done' : ''}">` +
        `<input type="checkbox" class="md-tick" disabled${t.done ? ' checked' : ''}` +
        ` aria-label="${t.done ? 'done' : 'not done'}">` +
        `<span class="md-tasktext">${esc(t.text)}</span></li>`).join('')}</ul>`;
    els.ptasksMeta.textContent =
      [ptasks.title, `${done}/${ptasks.items.length} done`, 'TASKS.md · read-only']
        .filter(Boolean).join(' · ');
    els.ptasksSec.hidden = false;
    applyPTaskFold();
    syncApView();
  }
  if (els.ptasksFold) {
    els.ptasksFold.addEventListener('click', () => {
      let open = true;
      try { open = localStorage.getItem(PTASK_FOLD_KEY) !== 'closed'; } catch { }
      try { localStorage.setItem(PTASK_FOLD_KEY, open ? 'closed' : 'open'); } catch { }
      applyPTaskFold();
    });
  }

  // ── panel views: one pill, two contents (tasks | agents) ─────────────────
  // Both lived in one long scroll and neither read well for it. The choice is
  // remembered; the tasks view owns its own empty state ("no task list yet")
  // so switching to it is never a blank pane.
  const AP_VIEW_KEY = 'council-ap-view';
  function syncApView() {
    const body = document.getElementById('agents-body');
    if (!body) return;
    let v = 'agents';
    try { v = localStorage.getItem(AP_VIEW_KEY) || 'agents'; } catch { }
    body.setAttribute('data-view', v);
    for (const b of body.querySelectorAll('.ap-viewpill [data-apview]')) {
      const on = b.dataset.apview === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    // the empty state belongs to the whole tasks view: a project list with
    // no chat list of its own is still a tasks view with something in it.
    const none = document.getElementById('tasks-none');
    const bare = (!els.tasksSec || els.tasksSec.hidden)
      && (!els.ptasksSec || els.ptasksSec.hidden);
    if (none) none.hidden = !(v === 'tasks' && bare);
  }
  document.querySelectorAll('.ap-viewpill [data-apview]').forEach(b =>
    b.addEventListener('click', () => {
      try { localStorage.setItem(AP_VIEW_KEY, b.dataset.apview); } catch { }
      syncApView();
    }));
  syncApView();

  function renderTasks() {
    if (!els.tasksSec) return;
    const body = taskSrc && taskSrc.parentNode ? taskSrc.querySelector('.body') : null;
    const lists = taskLists(body);
    if (!lists.length) {
      taskSrc = null;
      els.tasksSec.hidden = true;
      els.tasksBody.textContent = '';
      els.tasksBody.removeAttribute('data-ticks');
      syncApView();
      return;
    }
    els.tasksBody.textContent = '';
    for (const l of lists) els.tasksBody.appendChild(l.cloneNode(true));
    const state0 = new Map([...body.querySelectorAll('input.md-tick')]
      .map(b => [b.getAttribute('data-tick'), b.checked]));
    for (const box of els.tasksBody.querySelectorAll('input.md-tick')) {
      const on = !!state0.get(box.getAttribute('data-tick'));
      box.checked = on;
      if (box.parentNode && box.parentNode.classList) box.parentNode.classList.toggle('done', on);
    }
    const key = body.getAttribute('data-ticks') || hashText(taskSrc.getAttribute('data-raw') || '');
    els.tasksBody.setAttribute('data-ticks', key);
    applyTicks(els.tasksBody, key);
    els.tasksSec.hidden = false;
    updateTasksMeta();
    applyTaskFold();
    syncApView();
  }
  // a tick in the panel is a tick in the message: record it against the same
  // key, then push the store back over the transcript's copy
  if (els.tasksBody) {
    els.tasksBody.addEventListener('change', e => {
      const box = e.target.closest('input.md-tick');
      if (!box) return;
      const key = els.tasksBody.getAttribute('data-ticks');
      if (!key) return;
      if (box.parentNode && box.parentNode.classList) {
        box.parentNode.classList.toggle('done', box.checked);
      }
      recordTicks(key, els.tasksBody);
      const body = taskSrc && taskSrc.querySelector('.body');
      if (body) applyTicks(body, key);
      updateTasksMeta();
    });
  }
  if (els.tasksFold) {
    els.tasksFold.addEventListener('click', () => {
      const open = localStorage.getItem(TASK_FOLD_KEY) !== 'closed';
      try { localStorage.setItem(TASK_FOLD_KEY, open ? 'closed' : 'open'); } catch { }
      applyTaskFold();
    });
  }
  // jump: bring the source message into view (and mark it, so the eye finds it
  // among neighbours) without yanking anything else about the scroll state
  function jumpToTaskSrc() {
    const src = taskSrc;
    if (!src || !src.parentNode) return;
    closeAgents();
    if (typeof src.scrollIntoView === 'function') {
      src.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else {
      els.chat.scrollTop = Math.max(0, (src.offsetTop || 0) - 12);
    }
    els.jump.hidden = atBottom();
    src.classList.add('task-src');
    setTimeout(() => src.classList.remove('task-src'), 1600);
  }
  if (els.tasksJump) els.tasksJump.addEventListener('click', jumpToTaskSrc);

  // Anything that is not an image is a chip: its kind in capitals and the
  // name the reader gave it (the stored id only when no name survived), a
  // link to the file. Drawing a .md as an <img> gave a broken picture with
  // "attached image" under it.
  const attThumbs = atts => (atts && atts.length)
    ? `<div class="att-row">${atts.map(a => {
      const m = /\.(pdf|xlsx?|docx?|md|markdown|txt|csv|json)(\?|$)/i.exec(a.url || '');
      const isFile = a.type === 'file' || !!m;
      if (isFile) {
        const name = a.name || (a.url || '').split('/').pop().split('?')[0];
        const kind = (m ? m[1] : ((/\.(\w+)$/.exec(name) || [])[1] || 'file')).toUpperCase();
        return `<a class="att-doc-link" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(name)}">${esc(kind)} · ${esc(name)}</a>`;
      }
      return `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${esc(a.url)}" alt="attached image" loading="lazy"></a>`;
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
    // THE VERIFICATION BADGE. When the room converges the controller runs one
    // more turn, addressed to the bot that did NOT write the last claim, with
    // an envelope carrying the claims and the sources and NOT the discussion
    // (core/botference.py `_run_verification_turn`). That reply opens with a
    // line of its own — `[verification — …]` — and the line is the badge: it
    // comes off the words and goes into the header, so a reader can tell a
    // CHECK from another opinion at a glance, which is the whole point of
    // spending the turn.
    //
    // Done HERE rather than in addMsg because a streamed answer is painted
    // dozens of times and the first paint has no text in it at all.
    const v = verifyBadge(text);
    if (v) {
      text = v.rest;
      div.classList.add('verified');
      const who = div.querySelector('.who');
      if (who && !who.querySelector('.vbadge')) {
        who.insertAdjacentHTML('beforeend',
          `<span class="vbadge" title="${esc(v.title)}">verification</span>`);
      }
    }
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
    // newest checklist in the room → the tasks panel. A first paint happens
    // BEFORE the message is in the transcript; addMsg offers it again once it
    // is there, so only re-paints (streaming, finalize) are handled here.
    if (div.parentNode) noteTasks(div, body);
    return div;
  }
  const copyBtnHtml =
    '<div class="msg-acts"><button class="msg-copy" title="copy this message" ' +
    'aria-label="copy this message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>' +
    '<span>copy</span></button></div>';

  // `[verification — …]` on the FIRST line of a bot's message, and nowhere
  // else: a bot quoting the marker mid-reply is talking about it, not being it.
  // Returns {title, rest} with the line taken off the words, or null.
  const VERIFY_RE = /^\s*\[verification\b[^\]\n]*\]\s*(?:\n|$)/i;
  function verifyBadge(text) {
    const s = String(text == null ? '' : text);
    const m = VERIFY_RE.exec(s);
    if (!m) return null;
    return { title: m[0].trim().replace(/^\[|\]$/g, ''), rest: s.slice(m[0].length) };
  }

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
    } else if (who === 'gemini') {
      // The video watcher's own report. Its own bubble, because a reader who
      // sees it inside their own message (or as a system whisper) concludes
      // Claude watched the video — and long reports are folded, because a
      // 600-word transcript of a video is not what the eye wants next.
      const head = String(text || '').split('\n')[0];
      const body = String(text || '').split('\n').slice(1).join('\n').replace(/^\n+/, '');
      div.className = 'msg gemini';
      div.innerHTML = `<div class="who">${geminiAvatarHtml()}<span>${esc(head)}</span></div>`
        + '<div class="body clipped"></div>'
        + '<button class="more" type="button" data-act="gemini-more">show more</button>'
        + copyBtnHtml;
      paint(div, body);
    } else {
      // multi-line system output (/help, /status, resume lists) reads better
      // as a left-aligned block than a centered whisper
      div.className = `msg system${/\n/.test(text) ? ' block' : ''}`;
      div.innerHTML = `<div class="body">${sysFmt(text)}</div>`;
    }
    container().appendChild(div);
    noteTasks(div, div.querySelector('.body'));
    if (!offscreen()) {
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
    if (!offscreen()) { updateEmpty(); follow(wasPinned); }
    return div;
  }

  function streamKey(ev) { return `${ev.model || ev.speaker || 'agent'}:${ev.stream_id || 0}`; }
  function streamDelta(ev) {
    const model = String(ev.model || 'claude').toLowerCase();
    setAgentMode(model, 'working');
    const key = streamKey(ev);
    let s = state.streams[key];
    if (!s) {
      s = state.streams[key] = { text: '', shown: 0, el: addMsg(model, '', { streaming: true }) };
      // a summoned agent's card points back at this id (its parent_stream_id)
      if (ev.stream_id) s.el.dataset.streamId = String(ev.stream_id);
    }
    const wasPinned = pinned();
    s.text += String(ev.text || '');
    // in instant mode `shown` is simply kept at the end, so a reader who flips
    // the switch mid-answer does not watch the text rewind
    if (!typewriterOn()) s.shown = s.text.length;
    paint(s.el, shownText(s));
    follow(wasPinned);
    startTyping();
  }
  function finalizeStream(ev) {
    const key = `${ev.speaker}:${ev.stream_id}`;
    const s = state.streams[key];
    if (s) {
      const wasPinned = pinned();
      s.el.classList.remove('streaming');
      // the whole authoritative text, at once: the answer is finished and the
      // drain has no business holding any of it back
      paint(s.el, ev.text);
      // (the drain stops itself on the first tick with nothing behind — never
      // from here, where another agent may still be mid-answer)
      delete state.streams[key];
      follow(wasPinned);
      return true;
    }
    return false;
  }

  // ── summoned build agents: nested cards ──
  // A bot can "summon" a build agent (core/botference.py `_run_summon`). The
  // controller emits the agent's life as room entries with speaker "agent"
  // and an `agent` metadata object: first a WORKING card (status "working"),
  // then live text deltas as `stream` events tagged with the same `agent`
  // meta, optionally a folded tool-log card (card "tools"), and finally the
  // report card (card "report", status done/failed/timeout) which REPLACES
  // the working one. Everything is keyed by `agent.id`, never by stream id:
  // the card's stream id (`<id>:card`) and the live stream's id differ.
  //
  // The card nests under the bot message that summoned it — Reddit-style —
  // inside a `.replies` box appended to that message, so it stays with its
  // parent when later messages arrive. The parent is found by
  // `parent_stream_id` (bot messages carry data-stream-id); when that is
  // missing (restored history has none) the nearest PRECEDING message by
  // the summoner is used. Same rule live and on restore.
  const fmtClock = secs => {
    const s = Math.max(0, Math.round(Number(secs) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const attrQuote = v => String(v).replace(/["\\]/g, '\\$&');
  const capital = s => { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };
  function findSummonParent(meta) {
    const root = container();
    const pid = meta && meta.parent_stream_id;
    if (pid) {
      const el = root.querySelector(`.msg[data-stream-id="${attrQuote(pid)}"]`);
      if (el && !el.classList.contains('agent')) return el;
    }
    const who = String((meta && meta.summoned_by) || '').toLowerCase();
    if (!AGENTS.includes(who)) return null;
    // top-level children only: a card nested in `.replies` is never a parent
    for (let i = root.children.length - 1; i >= 0; i--) {
      const el = root.children[i];
      if (el.classList.contains('msg') && el.classList.contains(who) &&
          !el.classList.contains('tools-msg') && !el.classList.contains('agent')) return el;
    }
    return null;
  }
  function summonCard(id) {
    return container().querySelector(`.msg.agent[data-agent-id="${attrQuote(id)}"]`);
  }
  function agentStatusText(meta, startMs) {
    const st = String(meta.status || 'working');
    if (st === 'working') {
      const secs = startMs ? (Date.now() - startMs) / 1000 : 0;
      return `working… ⏱ ${fmtClock(secs)}`;
    }
    const t = fmtClock(meta.elapsed_s);
    if (st === 'done') return `done in ${t}`;
    if (st === 'timeout') return `timed out after ${t}`;
    if (st === 'cancelled') return `cancelled after ${t}`;
    return `failed after ${t}`;
  }
  // A build agent's card is in one of AGENT_CARD_STATUSES, kept in
  // card.dataset.status and moved only by setAgentCardStatus:
  //   working   — the agent is building (the clock runs);
  //   done, failed, timeout — it reported;
  //   cancelled — it was stopped (Esc) before it reported.
  // A card moves from working to any end, or repaints where it is; it never
  // goes from one end to another, nor back to working (a late or replayed
  // "working" entry cannot revive a finished card).
  const AGENT_CARD_STATUSES = ['working', 'done', 'failed', 'timeout', 'cancelled'];
  function setAgentCardStatus(card, to, elapsedS) {
    const from = card.dataset.status || '';
    if (!AGENT_CARD_STATUSES.includes(to)) return false;
    if (from && from !== 'working' && from !== to) return false;
    card.dataset.status = to;
    card.classList.toggle('working', to === 'working');
    if (to !== 'working') card.dataset.elapsed = String(Number(elapsedS) || 0);
    const el = card.querySelector('.agent-status');
    if (el) {
      el.className = `agent-status ${to}`;
      el.textContent = agentStatusText({ status: to, elapsed_s: card.dataset.elapsed },
        Number(card.dataset.start) || 0);
    }
    if (to !== 'working') { const act = card.querySelector('.agent-act'); if (act) act.remove(); }
    return true;
  }
  // A card RESTORED from a saved chat (a /resume) still saying "working" can
  // only have been stopped: the process that ran it is gone, and a build
  // agent never outlives the turn it runs in. Saved chats from before the
  // controller wrote "cancelled" have such cards; at the ready after the
  // restore they end as cancelled. A card drawn live is left alone — its end
  // comes from the controller (done, failed, timeout or cancelled).
  function endWorkingAgentCards() {
    for (const card of container().querySelectorAll('.msg.agent[data-status="working"][data-restored]')) {
      const start = Number(card.dataset.start) || Date.now();
      setAgentCardStatus(card, 'cancelled', (Date.now() - start) / 1000);
      card.classList.remove('streaming');
      endAgentStreams(card);
    }
  }
  function paintAgentHead(card, meta) {
    const st = String(meta.status || 'working');
    if (!setAgentCardStatus(card, st, meta.elapsed_s)) return false;
    const head = card.querySelector('.agent-head');
    if (!head) return true;
    const start = Number(card.dataset.start) || 0;
    head.innerHTML =
      '<span class="agent-arrow" aria-hidden="true">↳</span>' +
      '<span class="agent-kind">agent</span>' +
      `<span class="agent-sep">·</span><span class="agent-label">${esc(meta.label || meta.model || 'build agent')}</span>` +
      `<span class="agent-sep">·</span><span class="agent-by">summoned by ${esc(capital(meta.summoned_by))}</span>` +
      `<span class="agent-sep">·</span><span class="agent-status ${esc(st)}">${esc(agentStatusText(meta, start))}</span>` +
      (st === 'working' ? '<span class="agent-act"></span>' : '');
    const brief = card.querySelector('.agent-brief');
    if (brief) {
      const b = String(meta.brief || '').replace(/\s+/g, ' ').trim();
      brief.hidden = !b;
      brief.textContent = b ? `brief: ${b}` : '';
      brief.title = b;
    }
    return true;
  }
  // the live clock on every working card; stops itself when none is working
  function tickAgentClocks() {
    let any = false;
    for (const card of container().querySelectorAll('.msg.agent.working')) {
      any = true;
      const el = card.querySelector('.agent-status');
      if (el) el.textContent = agentStatusText({ status: 'working' }, Number(card.dataset.start) || 0);
    }
    if (!any && state.summonTimer) { clearInterval(state.summonTimer); state.summonTimer = null; }
  }
  function startAgentClocks() {
    if (state.summonTimer) return;
    state.summonTimer = setInterval(tickAgentClocks, 1000);
  }
  // find-or-create the card for this summon, nested under its parent
  function ensureAgentCard(meta) {
    let card = summonCard(meta.id);
    if (card) return card;
    const wasPinned = pinned();
    card = document.createElement('div');
    card.className = 'msg agent';
    card.dataset.agentId = String(meta.id);
    // the controller's own start time when it has one (a reload must not
    // reset a 40-minute build to 0:00); this page's clock only as a fallback
    card.dataset.start = String(Number(meta.started_at) > 0 ? Math.round(Number(meta.started_at) * 1000) : Date.now());
    card.innerHTML = '<div class="agent-head"></div><div class="agent-brief" hidden></div>' +
      '<div class="agent-tools"></div><div class="body"></div>' + copyBtnHtml;
    const parent = findSummonParent(meta);
    if (parent) {
      let box = [...parent.children].find(c => c.classList.contains('replies')) || null;
      if (!box) { box = document.createElement('div'); box.className = 'replies'; parent.appendChild(box); }
      box.appendChild(card);
    } else {
      container().appendChild(card);   // no summoner on screen: stand alone
    }
    paintAgentHead(card, meta);
    if (!offscreen()) { updateEmpty(); follow(wasPinned); }
    return card;
  }
  // drop every live stream that was painting into this card
  function endAgentStreams(card) {
    for (const k of Object.keys(state.streams)) {
      if (state.streams[k].el === card) delete state.streams[k];
    }
  }
  // a `room` (or restored) entry with speaker "agent"
  function handleAgentRoom(ev) {
    const meta = ev.agent;
    if (!meta || !meta.id) { addMsg('system', ev.text); return; }
    const card = ensureAgentCard(meta);
    if (meta.card === 'tools') {
      const lines = String(ev.text || '').split('\n');
      const steps = lines[0] === 'Explored' ? lines.slice(1) : lines;
      const slot = card.querySelector('.agent-tools');
      if (slot) {
        slot.innerHTML = `<details class="tools"><summary>full output · ${steps.length} line${steps.length === 1 ? '' : 's'}</summary>` +
          `<div class="tool-steps">${steps.map(esc).join('\n')}</div></details>`;
      }
      return;
    }
    const wasPinned = pinned();
    // a finished card refuses to be painted back to working, or to another end
    if (!paintAgentHead(card, meta)) return;
    if (String(meta.status || 'working') === 'working') {
      // the working card: the header says it all, the body waits for the stream
      card.classList.add('streaming');
      startAgentClocks();
    } else {
      // the report replaces whatever streamed in
      endAgentStreams(card);
      card.classList.remove('streaming');
      paint(card, ev.text);
      tickAgentClocks();
    }
    if (!offscreen()) follow(wasPinned);
  }
  // `stream` events tagged with agent meta: deltas paint the card's body
  function handleAgentStream(ev) {
    const meta = ev.agent;
    const card = ensureAgentCard(meta);
    const key = streamKey(ev);
    if (ev.kind === 'text_delta') {
      let s = state.streams[key];
      if (!s) s = state.streams[key] = { text: '', shown: 0, el: card };
      const wasPinned = pinned();
      card.classList.add('streaming');
      s.text += String(ev.text || '');
      if (!typewriterOn()) s.shown = s.text.length;
      paint(card, shownText(s));
      follow(wasPinned);
      startTyping();
    } else if (ev.kind === 'tool_start') {
      const act = card.querySelector('.agent-act');
      if (act) act.textContent = laneActivity(ev);
    } else if (ev.kind === 'done') {
      const s = state.streams[key];
      if (s) { paint(card, s.text); delete state.streams[key]; }
      const act = card.querySelector('.agent-act');
      if (act) act.textContent = '';
    }
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
    if (!offscreen()) { updateEmpty(); follow(wasPinned); }
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
  // An interrupt card is in one of CARD_MODES, kept in card.dataset.mode and
  // moved only by setCardMode:
  //   open      — waiting for the reader's answer;
  //   sending   — an answer is on its way to the server;
  //   answered  — the server took an answer, or the question went away.
  // The card shows the reader's decision only once the server has taken it;
  // an answer that did not get through goes back to open and says so.
  const CARD_MODES = ['open', 'sending', 'answered'];
  const CARD_MOVES = new Set(['open>sending', 'sending>open', 'sending>answered', 'open>answered']);
  let liveCard = null;
  function setCardMode(card, to) {
    const from = card.dataset.mode || 'open';
    if (!CARD_MODES.includes(to) || !CARD_MOVES.has(from + '>' + to)) return false;
    card.dataset.mode = to;
    card.classList.toggle('answered', to === 'answered');
    for (const b of card.querySelectorAll('button')) b.disabled = to !== 'open';
    return true;
  }
  function cardNote(card, text, cls = '') {
    const n = document.createElement('div');
    n.className = 'card-note' + (cls ? ' ' + cls : '');
    n.textContent = text;
    card.appendChild(n);
    return n;
  }
  function settleCard(note) {
    if (!liveCard) return;
    const card = liveCard;
    liveCard = null;
    setCardMode(card, 'answered');
    const failed = card.querySelector('.card-note.not-sent');
    if (failed) failed.remove();
    if (note) cardNote(card, note);
  }
  // the reader answered: post it, and settle the card only once it is taken
  async function answerCard(card, url, body, note) {
    if (!setCardMode(card, 'sending')) return;
    const old = card.querySelector('.card-note.not-sent');
    if (old) old.remove();
    const r = await post(url, body);
    if (r && r.ok) {
      if (setCardMode(card, 'answered')) {
        if (liveCard === card) liveCard = null;
      }
      cardNote(card, note);
      return;
    }
    // still unanswered as far as the bots know: keep it answerable
    if (setCardMode(card, 'open')) {
      cardNote(card, 'not sent: your answer did not reach the server. Try again.', 'not-sent');
    }
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
      // names the question it answers: a later question waiting behind this
      // one can never be answered by a stale click
      answerCard(div, '/choice', { index: i >= 0 ? i : null, request_id: ev.request_id },
        i >= 0 ? `you picked: ${ev.options[i]}` : 'dismissed');
    });
    container().appendChild(div);
    liveCard = div;
    if (!offscreen()) { updateEmpty(); follow(wasPinned); }
  }
  // ── the lasso card ──
  // What a `/lasso <words>` (or a bot's `lasso:` line) turned up: past
  // discussions, pages read in the browser, papers in the reader's own
  // folders. OFFERS, nothing more — every button sends `/lasso attach <n>`,
  // which is the same command a person can type, so the browser gets no
  // private door into the controller and there is one code path to be right.
  //
  // Deliberately NOT settleCard's kind of card: an interrupt card is one
  // question with one answer and dies on the next event. This one can be
  // acted on several times (attach two of five matches) and stays readable
  // afterwards, like the filing card does.
  function lassoCard(ev) {
    const rows = Array.isArray(ev.results) ? ev.results : [];
    const wasPinned = pinned();
    const div = document.createElement('div');
    div.className = 'msg card lasso';
    const scope = ev.source === 'companion' ? ''
      : '<div class="card-note">the browser companion is not running, so this searched '
        + 'this council&rsquo;s own chats only</div>';
    div.innerHTML = `<div class="card-title">${rows.length
      ? `${rows.length} match${rows.length === 1 ? '' : 'es'} for “${esc(ev.query)}”`
      : `nothing of yours matches “${esc(ev.query)}”`}</div>
      ${scope}
      ${rows.map((r, i) => `<div class="lassorow">
        <span class="lassow"><b>${esc(r.title || r.id || '')}</b>
          <span class="lassokind">${esc(r.kind || '')}</span>
          <span class="lassohit">${esc(r.hit || '')}</span></span>
        <button data-n="${i + 1}">attach</button></div>`).join('')}
      ${rows.length ? `<div class="opts"><button data-n="all">Attach all</button>
        <button data-act="lasso-no">Dismiss</button></div>` : ''}`;
    div.addEventListener('click', async e => {
      if (e.target.closest('[data-act="lasso-no"]')) {
        div.classList.add('answered');
        for (const b of div.querySelectorAll('button')) b.disabled = true;
        return;
      }
      const b = e.target.closest('button[data-n]');
      if (!b || b.disabled) return;
      b.disabled = true;
      b.textContent = b.dataset.n === 'all' ? 'attaching…' : 'attached';
      await sendInput('/lasso attach ' + b.dataset.n);
    });
    container().appendChild(div);
    if (!offscreen()) { updateEmpty(); follow(wasPinned); }
  }

  // …and what the chat is CARRYING, above the composer, until the ✕ takes it
  // off. State rather than a menu, which is why it is a strip and not a card:
  // these files ride every turn from now on.
  function renderLassoStrip() {
    const el = els.lassoStrip;
    if (!el) return;
    const rows = state.lassoOn || [];
    el.hidden = !rows.length;
    el.innerHTML = rows.map((a, i) =>
      `<span class="lassochip" title="${esc(a.summary || a.path || '')}">
        <span class="lassokind">${esc(a.kind || '')}</span>${esc(a.title || '')}
        <button class="att-x" data-lasso-x="${i + 1}" aria-label="detach ${esc(a.title || '')}">✕</button>
      </span>`).join('');
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
      answerCard(div, '/permission', { allow: true, request_id: ev.request_id }, 'allowed');
    });
    div.querySelector('.deny').addEventListener('click', () => {
      answerCard(div, '/permission', { allow: false, request_id: ev.request_id }, 'denied');
    });
    container().appendChild(div);
    liveCard = div;
    if (!offscreen()) { updateEmpty(); follow(wasPinned); }
  }

  // ── left panel: two pills (Chats / Projects), flat lists, one "more" per row ──
  //
  // Three things can be "open" here and each is ONE named mode in ONE field,
  // moved by ONE setter that refuses a move its pure rule does not allow:
  //
  //   what the list shows      PANEL_VIEWS   state.panel     setPanelView
  //   what one row is doing    ROW_MODES     state.row       setRowMode
  //   the panel itself         SLIDE_MODES   state.slideOut  setSlideOut
  //
  // state.row is one field for the WHOLE panel, so only one row can ever be
  // busy: opening a second menu is a move, not a second flag.
  const relTime = iso => {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const d = (Date.now() - t) / 1000;
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    if (d < 7 * 86400) return `${Math.round(d / 86400)}d`;
    if (d < 30 * 86400) return `${Math.round(d / (7 * 86400))}w`;
    if (d < 365 * 86400) return `${Math.max(1, Math.round(d / (30 * 86400)))}mo`;
    return `${Math.max(1, Math.round(d / (365 * 86400)))}y`;
  };
  const lpSvg = (body, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const LP_ICON = {
    more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></svg>',
    go: lpSvg('<path d="M9.5 5.5L16 12l-6.5 6.5"/>'),
    back: lpSvg('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
    out: lpSvg('<path d="M8 16L16.5 7.5M9.5 7.5h7v7"/>'),
    plus: lpSvg('<path d="M12 5v14M5 12h14"/>', 2),
  };

  // ---- what the page knows about chats and projects ----------------------
  const allProjects = () => (state.projects && state.projects.projects) || [];
  const isLive = pr => (pr.status || 'active') === 'active';
  const projectById = pid => allProjects().find(pr => pr.id === pid) || null;
  const chatTitle = s => s.title || String(s.session_id).slice(0, 8);
  // every chat in the last list from the controller, with where it is filed
  function allChats() {
    const p = state.projects;
    const out = [];
    if (!p) return out;
    for (const s of p.inbox_sessions || []) out.push({ s, pid: '', project: '' });
    for (const pr of p.projects || []) {
      for (const s of pr.sessions || []) out.push({ s, pid: pr.id, project: pr.title || pr.id });
    }
    return out;
  }
  const findChat = sid => allChats().find(c => c.s.session_id === sid) || null;
  // where the panel should open for a chat: inside its project, else Chats
  function homeView(snapshot, sid) {
    if (sid) {
      for (const pr of (snapshot && snapshot.projects) || []) {
        if ((pr.sessions || []).some(s => s.session_id === sid)) return { view: 'inside-project', pid: pr.id };
      }
    }
    return { view: 'chats' };
  }

  // ---- what the list shows ------------------------------------------------
  //   chats           the chats filed nowhere (and, below them, web-page chats)
  //   projects        the list of projects
  //   inside-project  one project's chats (which one: state.panel.pid)
  //   search          chat titles from everywhere (state.panel.query); `back`
  //                   is the view to return to when the search is closed
  const PANEL_VIEWS = Object.freeze(['chats', 'projects', 'inside-project', 'search']);
  function panelViewMove(from, to) {
    if (!from || !to || !PANEL_VIEWS.includes(from.view) || !PANEL_VIEWS.includes(to.view)) return false;
    if (to.view === 'inside-project') {
      return !!to.pid && (from.view !== 'inside-project' || from.pid !== to.pid);
    }
    if (to.view === 'search') {
      return typeof to.query === 'string' && (from.view !== 'search' || from.query !== to.query);
    }
    return from.view !== to.view;
  }
  function setPanelView(view, detail = {}) {
    const from = state.panel;
    let to = { view };
    if (view === 'inside-project') to = { view, pid: detail.pid || '' };
    if (view === 'search') {
      to = { view, query: typeof detail.query === 'string' ? detail.query : '',
        back: from.view === 'search' ? from.back : from };
    }
    if (!panelViewMove(from, to)) return false;
    if (view === 'inside-project' && !projectById(to.pid)) return false;
    state.panel = Object.freeze(to);
    if (state.row.mode !== 'resting') setRowMode('resting');
    if (view === 'inside-project') loadContents(to.pid);
    renderPanel();
    return true;
  }
  function goHome() {
    const h = homeView(state.projects, state.currentSid);
    return setPanelView(h.view, h);
  }
  function leaveSearch() {
    if (state.panel.view !== 'search') return;
    const back = state.panel.back || { view: 'chats' };
    if (!setPanelView(back.view, back)) setPanelView('chats');
    if (typeof els.search.blur === 'function') els.search.blur();
  }

  // ---- what one row is doing ----------------------------------------------
  //   resting             nothing is open
  //   menu                the row's "more" menu is open (Settings is a row too)
  //   moving              the row shows the list of projects to move into
  //   renaming            the row's title is a text box
  //   confirming-delete   the row asks "delete?" in place
  //   naming-new-project  a text box for a new project's name: in the Projects
  //                       list (key 'new-project'), or in a chat's move list
  //                       (the chat's own key — the chat goes into it)
  // `key` says whose row: 'chat:<id>', 'project:<id>', 'page:<id>',
  // 'new-project' or 'settings'.
  const ROW_MODES = Object.freeze(['resting', 'menu', 'moving', 'renaming', 'confirming-delete', 'naming-new-project']);
  const ROW_MOVES = new Set([
    'resting>menu', 'resting>naming-new-project',
    'menu>menu', 'menu>moving', 'menu>renaming', 'menu>confirming-delete',
    'moving>naming-new-project',
    ...ROW_MODES.filter(m => m !== 'resting').map(m => m + '>resting'),
  ]);
  function rowMove(from, to) {
    if (!from || !to || !ROW_MODES.includes(from.mode) || !ROW_MODES.includes(to.mode)) return false;
    if (!ROW_MOVES.has(from.mode + '>' + to.mode)) return false;
    if (to.mode === 'resting') return !to.key;          // nobody's row
    if (!to.key) return false;                           // a busy row is somebody's
    if (from.mode === 'resting') return true;
    // another row's menu may open over this one; a step ON from a menu or a
    // move list stays with the row it was opened on
    return from.mode === 'menu' && to.mode === 'menu' ? from.key !== to.key : from.key === to.key;
  }
  function setRowMode(mode, key = '') {
    const to = Object.freeze({ mode, key: mode === 'resting' ? '' : String(key || '') });
    if (!rowMove(state.row, to)) return false;
    state.row = to;
    renderPanel();
    return true;
  }
  function rowKeyExists(key) {
    if (key === 'settings' || key === 'new-project') return true;
    if (key.startsWith('chat:')) return !!findChat(key.slice(5));
    if (key.startsWith('project:')) return !!projectById(key.slice(8));
    if (key.startsWith('page:')) return state.pageChats.rows.some(r => r.id === key.slice(5));
    return false;
  }

  // ---- web-page chats (the browser plugin's), read-only --------------------
  // A chat about a web page lives in the plugin's records, not the council's,
  // so it does not come with the list from the controller: the page asks the
  // server (name, address and date only). Where that read stands is one of
  // PAGE_CHATS_LOADS. The rows last read stay on screen while it is read
  // again, and after a read that failed.
  //   idle     not asked yet
  //   loading  asked, no answer yet
  //   ready    the rows are the server's last answer
  //   failed   the last ask got no answer
  const PAGE_CHATS_LOADS = Object.freeze(['idle', 'loading', 'ready', 'failed']);
  function pageChatsMove(from, to) {
    if (!PAGE_CHATS_LOADS.includes(from) || !PAGE_CHATS_LOADS.includes(to)) return false;
    if (to === 'loading') return from !== 'loading';
    return (to === 'ready' || to === 'failed') && from === 'loading';
  }
  function setPageChatsLoad(to, got = null) {
    const cur = state.pageChats;
    if (!pageChatsMove(cur.load, to)) return false;
    state.pageChats = Object.freeze(to === 'ready' && got
      ? { load: to, rows: got.rows, total: got.total, base: got.base }
      : { ...cur, load: to });
    return true;
  }
  const PAGE_ID = /^[0-9a-f]{40}$/;
  async function loadPageChats() {
    if (!setPageChatsLoad('loading')) return;
    let got = null;
    try {
      const r = await fetch('/page-chats', { credentials: 'same-origin' });
      const d = r.ok ? await r.json() : null;
      if (d && d.ok !== false) {
        const rows = (Array.isArray(d.pages) ? d.pages : [])
          .filter(p => p && PAGE_ID.test(String(p.id)))
          .map(p => Object.freeze({ id: p.id, title: String(p.title || p.url || ''), url: String(p.url || ''),
            updated_at: String(p.updated_at || '') }));
        got = { rows, total: Math.max(Number(d.total) || 0, rows.length),
          base: /^https?:\/\//.test(String(d.base || '')) ? String(d.base) : '' };
      }
    } catch { /* drawn as before; asked again the next time the list is opened */ }
    setPageChatsLoad(got ? 'ready' : 'failed', got);
    if (state.row.mode !== 'resting' && !rowKeyExists(state.row.key)) setRowMode('resting');
    renderPanel();
  }

  // ---- the panel itself: shown or tucked away -----------------------------
  // One field for both widths: on a phone 'open' slides the panel over the
  // chat; on a wide screen 'closed' folds it away (and that choice is kept).
  const SLIDE_MODES = Object.freeze(['open', 'closed']);
  function slideMove(from, to) {
    return SLIDE_MODES.includes(from) && SLIDE_MODES.includes(to) && from !== to;
  }
  const narrow = () => window.matchMedia('(max-width: 900px)').matches;
  const SIDE_KEY = 'council-side';
  function sidePref() {
    try { return localStorage.getItem(SIDE_KEY) === 'collapsed' ? 'closed' : 'open'; } catch { return 'open'; }
  }
  function applySlide() {
    const open = state.slideOut === 'open';
    const n = narrow();
    document.body.classList.toggle('side-open', n && open);
    document.body.classList.toggle('side-collapsed', !n && !open);
    els.backdrop.hidden = !((n && open) || document.body.classList.contains('agents-open'));
    els.burger.setAttribute('aria-expanded', String(open));
  }
  function setSlideOut(to) {
    if (!slideMove(state.slideOut, to)) return false;
    state.slideOut = to;
    if (!narrow()) {
      try { localStorage.setItem(SIDE_KEY, to === 'closed' ? 'collapsed' : ''); } catch { /* this visit only */ }
    }
    if (to === 'closed' && state.row.mode !== 'resting') setRowMode('resting');
    // on a phone the panel always opens where the open chat lives
    if (to === 'open' && narrow()) { goHome(); loadPageChats(); }
    applySlide();
    return true;
  }
  // only a phone's slide-out is closed by picking something
  function closeSide() { if (narrow()) setSlideOut('closed'); }
  els.burger.addEventListener('click', () => setSlideOut(state.slideOut === 'open' ? 'closed' : 'open'));
  els.sideClose.addEventListener('click', closeSide);
  els.backdrop.addEventListener('click', closeSide);
  {
    const mq = window.matchMedia('(max-width: 900px)');
    // crossing between phone and wide: a phone starts tucked away, a wide
    // screen goes back to what was last chosen there
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', () => { setSlideOut(narrow() ? 'closed' : sidePref()); applySlide(); });
    }
  }
  // a wide screen starts with the panel shown, unless it was folded away
  if (!narrow() && sidePref() === 'open') setSlideOut('open'); else applySlide();

  // ---- the note that says what just happened, with a way back -------------
  // null, or { text, undo, open } where undo is { action, args } for panelAct
  // and open is the id of a chat the note offers to open. The timer only
  // schedules the note's own move back to null.
  const NOTE_MS = 7000;
  let noteTimer = null;
  function setPanelNote(note) {
    clearTimeout(noteTimer);
    noteTimer = null;
    state.panelNote = note && note.text
      ? Object.freeze({ text: String(note.text), undo: note.undo || null, open: note.open || '' }) : null;
    if (state.panelNote) noteTimer = setTimeout(() => setPanelNote(null), NOTE_MS);
    drawNote();
  }
  function drawNote() {
    const n = state.panelNote;
    els.note.hidden = !n;
    els.note.innerHTML = !n ? '' : `<span>${esc(n.text)}</span>${
      n.undo ? '<button type="button" data-act="undo">Undo</button>' : ''}${
      n.open ? `<button type="button" data-act="note-open" data-sid="${esc(n.open)}">Open</button>` : ''}`;
  }

  // ---- a project's files, read-only ---------------------------------------
  // The chats come with every list from the controller; the FILES do not (that
  // list is rebuilt after every turn and pushed to every tab). So the folder
  // is read once per tab, the first time the project is opened in the panel.
  // Where that read stands is one of CONTENTS_LOADS per project.
  const CONTENTS_LOADS = Object.freeze(['loading', 'ready', 'failed']);
  function contentsMove(from, to) {
    if (to === 'loading') return from == null || from === 'failed';
    return (to === 'ready' || to === 'failed') && from === 'loading';
  }
  function setContentsLoad(pid, to, files = []) {
    const cur = state.contents[pid];
    if (!CONTENTS_LOADS.includes(to) || !contentsMove(cur ? cur.load : null, to)) return false;
    state.contents[pid] = Object.freeze({ load: to, files: to === 'ready' ? files : [] });
    return true;
  }
  const KB = 1024;
  function humanBytes(n) {
    const v = Number(n) || 0;
    if (v < KB) return `${v} B`;
    if (v < KB * KB) return `${(v / KB).toFixed(1)} KB`;
    if (v < KB * KB * KB) return `${(v / (KB * KB)).toFixed(1)} MB`;
    return `${(v / (KB * KB * KB)).toFixed(1)} GB`;
  }
  async function loadContents(pid) {
    if (!setContentsLoad(pid, 'loading')) return;
    let files = null;
    try {
      const r = await fetch('/project-contents?id=' + encodeURIComponent(pid),
        { credentials: 'same-origin' });
      if (r.ok) {
        const d = await r.json();
        files = Array.isArray(d.files) ? d.files : [];
      }
    } catch { /* shown as "could not read" below */ }
    setContentsLoad(pid, files ? 'ready' : 'failed', files || []);
    renderPanel();
  }
  function filesHtml(pr) {
    const c = state.contents[pr.id];
    let html = '<div class="lp-label">Files</div>';
    if (!c || c.load === 'loading') html += '<div class="lp-empty">Reading the folder…</div>';
    else if (c.load === 'failed') html += '<div class="lp-empty">Could not read the folder.</div>';
    else if (!c.files.length) html += '<div class="lp-empty">No files yet.</div>';
    else {
      html += c.files.map(f => `<div class="lp-file" style="--d:${Number(f.depth) || 0}">
        <span class="fn${f.dir ? ' dir' : ''}">${esc(f.name)}${f.dir ? (f.truncated ? '/…' : '/') : ''}</span>
        <span class="when">${f.dir ? '' : humanBytes(f.size)}</span></div>`).join('');
    }
    if (pr.github) {
      html += `<div class="lp-label">On GitHub</div>
        <div class="lp-file"><a class="fn link" href="${esc(pr.github)}" target="_blank" rel="noopener">${esc(pr.github)}</a></div>`;
    }
    return html;
  }

  // ---- drawing -------------------------------------------------------------
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const rowModeOf = key => (state.row.key === key ? state.row.mode : 'resting');
  function chatMenu(s) {
    const sid = esc(s.session_id);
    return `<div class="row-menu lp-menu" role="menu">
      <button type="button" role="menuitem" data-act="rename" data-sid="${sid}">Rename</button>
      <button type="button" role="menuitem" data-act="move" data-sid="${sid}">Move to project…</button>
      <button type="button" role="menuitem" data-act="archive" data-sid="${sid}">Archive</button>
      <button type="button" role="menuitem" class="danger" data-act="delete" data-sid="${sid}">Delete…</button>
    </div>`;
  }
  function moveMenu(s, pid) {
    const sid = esc(s.session_id);
    const rows = allProjects().filter(isLive).map(pr =>
      `<button type="button" role="menuitem"${pr.id === pid ? ' class="here"' : ''} data-act="move-to" data-sid="${sid}" data-pid="${esc(pr.id)}">${esc(pr.title || pr.id)}</button>`
    ).join('');
    return `<div class="row-menu lp-menu" role="menu">
      <div class="lp-menu-label">Move to</div>${rows}
      <button type="button" role="menuitem" class="plain${pid ? '' : ' here'}" data-act="move-to" data-sid="${sid}" data-pid="">No project</button>
      <button type="button" role="menuitem" class="quiet" data-act="move-new" data-sid="${sid}">${LP_ICON.plus}New project…</button>
    </div>`;
  }
  // "are you sure", asked in the row itself: what goes, a red Delete, a Keep
  const askHtml = (cls, key, question, yes) => `<div class="${cls} asking" data-key="${esc(key)}" role="group">
      <span class="t" title="${esc(question)}"><span>${esc(question)}</span></span>
      <button class="lp-btn danger" type="button" ${yes}>Delete</button>
      <button class="lp-btn" type="button" data-act="cancel">Keep</button></div>`;
  // one chat row. *pid* is the project it is filed in ('' for none); *tag* is
  // the project's name, shown only where chats from everywhere are mixed.
  function chatRow(s, pid, { tag = '' } = {}) {
    const sid = esc(s.session_id);
    const key = 'chat:' + s.session_id;
    const title = chatTitle(s);
    const mode = rowModeOf(key);
    if (mode === 'renaming') {
      return `<div class="lp-row editing" data-key="${esc(key)}">
        <input class="lp-input" type="text" data-key="${esc(key)}" data-commit="rename" value="${esc(title)}"
          maxlength="120" autocomplete="off" enterkeyhint="done" aria-label="new name for this chat"></div>`;
    }
    if (mode === 'naming-new-project') {
      return `<div class="lp-row editing" data-key="${esc(key)}">
        <input class="lp-input" type="text" data-key="${esc(key)}" data-commit="new-project-for-chat" value=""
          maxlength="80" autocomplete="off" enterkeyhint="done" placeholder="New project for “${esc(title)}”"
          aria-label="name for the new project this chat goes into"></div>`;
    }
    if (mode === 'confirming-delete') {
      return askHtml('lp-row', key, `Delete “${title}”?`, `data-act="delete-yes" data-sid="${sid}"`);
    }
    let html = `<div class="lp-row${s.active ? ' active' : ''}${mode !== 'resting' ? ' has-menu' : ''}" data-key="${esc(key)}">
      <button class="t" type="button" data-act="open" data-sid="${sid}" title="${esc(title)}">${esc(title)}</button>${
        tag ? `<span class="lp-tag">${esc(tag)}</span>` : ''}<span class="when">${relTime(s.updated_at)}</span>
      <button class="more" type="button" data-act="more" data-key="${esc(key)}" aria-haspopup="true"
        aria-expanded="${mode !== 'resting'}" aria-label="more for ${esc(title)}">${LP_ICON.more}</button>`;
    if (mode === 'menu') html += chatMenu(s);
    if (mode === 'moving') html += moveMenu(s, pid);
    return html + '</div>';
  }
  const olderNote = (total, shown) => (total > shown
    ? `<div class="lp-empty">${plural(total - shown, 'older chat')} not shown.</div>` : '');
  // one web-page chat. It is a link, not a chat of the council's: it opens
  // where it lives (the plugin's own page for it), in a new tab. Its menu has
  // the one thing the council can do with it.
  function pageRow(r) {
    const key = 'page:' + r.id;
    const mode = rowModeOf(key);
    // a page with no name of its own shows its address, without the "https://"
    const title = r.title && r.title !== r.url ? r.title : r.url.replace(/^https?:\/\/(www\.)?/, '');
    const base = state.pageChats.base;
    let html = `<div class="lp-row page${mode !== 'resting' ? ' has-menu' : ''}" data-key="${esc(key)}">
      <a class="t" ${base ? `href="${esc(base)}/p/${esc(r.id)}" ` : ''}target="_blank" rel="noopener" title="${esc(title)}\n${esc(r.url)}"><span>${esc(title)}</span><span class="lp-out">${LP_ICON.out}</span></a>
      <span class="when">${relTime(r.updated_at)}</span>
      <button class="more" type="button" data-act="more" data-key="${esc(key)}" aria-haspopup="true"
        aria-expanded="${mode !== 'resting'}" aria-label="more for the web page ${esc(title)}">${LP_ICON.more}</button>`;
    if (mode === 'menu') {
      html += `<div class="row-menu lp-menu" role="menu">
      <button type="button" role="menuitem" data-act="page-copy" data-id="${esc(r.id)}">Copy into the council</button>
    </div>`;
    }
    return html + '</div>';
  }
  // under the loose chats, under their own label: there can be many, and they
  // behave differently, so they are not mixed in by date
  const PAGE_CHATS_SHOWN = 20;
  function pageChatsHtml() {
    const pc = state.pageChats;
    if (!pc.rows.length) return '';
    const shown = pc.rows.slice(0, PAGE_CHATS_SHOWN);
    const more = pc.total - shown.length;
    return '<div class="lp-label">On web pages</div>' + shown.map(pageRow).join('')
      + (more > 0 ? `<div class="lp-empty">${more} more. Search finds them by name.</div>` : '');
  }
  function chatsHtml(p) {
    const rows = p.inbox_sessions || [];
    let html = rows.length
      ? rows.map(s => chatRow(s, '')).join('')
      : '<div class="lp-empty">No chats here yet. Chats in a project are under Projects.</div>';
    html += olderNote(p.inbox_session_count || 0, rows.length);
    return html + pageChatsHtml();
  }
  function projRow(pr) {
    const n = pr.session_count ?? (pr.sessions || []).length;
    const last = (pr.sessions || [])[0];
    const when = last ? relTime(last.updated_at) : '';
    return `<button class="lp-proj${isLive(pr) ? '' : ' muted'}" type="button" data-act="enter" data-pid="${esc(pr.id)}">
      <span class="pn"><b>${esc(pr.title || pr.id)}</b><i>${plural(n, 'chat')}${when ? ` · ${when} ago` : ''}</i></span>${LP_ICON.go}</button>`;
  }
  function projectsHtml() {
    const all = allProjects();
    const live = all.filter(isLive);
    const archived = all.filter(pr => !isLive(pr));
    let html = live.map(projRow).join('');
    if (!live.length) html += '<div class="lp-empty">No projects yet.</div>';
    html += rowModeOf('new-project') === 'naming-new-project'
      ? `<div class="lp-row editing" data-key="new-project">
          <input class="lp-input" type="text" data-key="new-project" data-commit="new-project" value=""
            maxlength="80" autocomplete="off" enterkeyhint="done" placeholder="Project name" aria-label="name for the new project"></div>`
      : `<button class="lp-quiet" type="button" data-act="new-project">${LP_ICON.plus}New project</button>`;
    if (archived.length) html += '<div class="lp-label">Archived</div>' + archived.map(projRow).join('');
    return html;
  }
  function projMenu(pr) {
    const pid = esc(pr.id);
    const live = isLive(pr);
    return `<div class="row-menu lp-menu" role="menu">
      ${live ? `<button type="button" role="menuitem" data-act="proj-github" data-pid="${pid}">${
        pr.github ? 'Push to GitHub' : 'Publish to GitHub…'}</button>` : ''}
      <button type="button" role="menuitem" data-act="${live ? 'proj-archive' : 'proj-unarchive'}" data-pid="${pid}">${
        live ? 'Archive project' : 'Unarchive project'}</button>
      <button type="button" role="menuitem" class="danger" data-act="proj-delete" data-pid="${pid}">Delete project…</button>
    </div>`;
  }
  function insideHtml(pr) {
    const key = 'project:' + pr.id;
    const mode = rowModeOf(key);
    const title = pr.title || pr.id;
    const rows = pr.sessions || [];
    const n = pr.session_count ?? rows.length;
    let html = `<div class="lp-crumb"><button class="lp-back" type="button" data-act="pill" data-pill="projects">${LP_ICON.back}Projects</button></div>`;
    html += mode === 'confirming-delete'
      // a project takes its chats and its folder with it, so the question says so
      ? askHtml('lp-ptitle', key, `Delete “${title}”, its ${plural(n, 'chat')} and its files?`,
        `data-act="proj-delete-yes" data-pid="${esc(pr.id)}"`)
      : `<div class="lp-ptitle${mode !== 'resting' ? ' has-menu' : ''}" data-key="${esc(key)}">
        <b title="${esc(title)}">${esc(title)}</b>${isLive(pr) ? '' : '<span class="lp-tag">archived</span>'}
        <button class="more" type="button" data-act="more" data-key="${esc(key)}" aria-haspopup="true"
          aria-expanded="${mode !== 'resting'}" aria-label="more for the project ${esc(title)}">${LP_ICON.more}</button>${
          mode === 'menu' ? projMenu(pr) : ''}</div>`;
    html += rows.length
      ? rows.map(s => chatRow(s, pr.id)).join('')
      : '<div class="lp-empty">No chats yet.</div>';
    html += olderNote(pr.session_count ?? rows.length, rows.length);
    return html + filesHtml(pr);
  }
  // Search looks at chat TITLES, from everywhere. Before anything is typed it
  // shows the latest chats, so "the one from this morning" is two taps away.
  const SEARCH_LATEST = 12;
  const SEARCH_MOST = 60;
  function searchRows(query) {
    const needle = String(query || '').trim().toLowerCase();
    const rows = allChats().sort((a, b) =>
      String(b.s.updated_at || '').localeCompare(String(a.s.updated_at || '')));
    if (!needle) return rows.slice(0, SEARCH_LATEST);
    return rows.filter(c => chatTitle(c.s).toLowerCase().includes(needle)).slice(0, SEARCH_MOST);
  }
  // web-page chats are found by name or by address, once something is typed
  function searchPages(query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    return state.pageChats.rows.filter(r => `${r.title} ${r.url}`.toLowerCase().includes(needle))
      .slice(0, SEARCH_MOST);
  }
  function searchHtml(query) {
    const rows = searchRows(query);
    const pages = searchPages(query);
    const typed = String(query || '').trim();
    if (!rows.length && !pages.length) {
      return `<div class="lp-empty">${typed ? `No chat is called anything like “${esc(typed)}”.` : 'No chats yet.'}</div>`;
    }
    let html = !rows.length ? ''
      : `<div class="lp-label">${typed ? plural(rows.length, 'chat') + ' found' : 'Latest chats'}</div>`
        + rows.map(c => chatRow(c.s, c.pid, { tag: c.project })).join('');
    if (pages.length) html += '<div class="lp-label">On web pages</div>' + pages.map(pageRow).join('');
    return html;
  }
  function renderPanel() {
    const p = state.projects;
    const v = state.panel;
    const here = v.view === 'inside-project' ? projectById(v.pid) : null;
    // the one way to start a chat says where the chat will go
    const label = here && isLive(here) ? `New chat in ${here.title || here.id}` : 'New chat';
    els.newChatLabel.textContent = label;
    els.newChat.title = label;
    for (const b of els.pills.querySelectorAll('[data-pill]')) {
      const on = v.view !== 'search' && (b.dataset.pill === 'chats') === (v.view === 'chats');
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    els.searchX.hidden = v.view !== 'search';
    if (v.view !== 'search' && els.search.value) els.search.value = '';
    const settingsOpen = state.row.mode === 'menu' && state.row.key === 'settings';
    els.settingsPop.hidden = !settingsOpen;
    els.settings.setAttribute('aria-expanded', String(settingsOpen));
    drawNote();
    // a text box being typed in survives the redraw: lists arrive at any time
    const old = els.projects.querySelector('.lp-input');
    const kept = old ? { key: old.dataset.key, value: old.value, focused: document.activeElement === old,
      a: old.selectionStart, b: old.selectionEnd } : null;
    els.projects.innerHTML = !p ? '<div class="lp-empty">Loading…</div>'
      : v.view === 'chats' ? chatsHtml(p)
      : v.view === 'projects' ? projectsHtml()
      : v.view === 'search' ? searchHtml(v.query)
      : here ? insideHtml(here) : '';
    const inp = els.projects.querySelector('.lp-input');
    if (inp) {
      if (kept && kept.key === inp.dataset.key) {
        inp.value = kept.value;
        if (kept.focused) {
          inp.focus();
          try { inp.setSelectionRange(kept.a, kept.b); } catch { /* not a text box */ }
        }
      } else {
        inp.focus();
        if (typeof inp.select === 'function') inp.select();
      }
    }
    const popup = els.projects.querySelector('.lp-menu');
    if (popup && typeof popup.scrollIntoView === 'function') popup.scrollIntoView({ block: 'nearest' });
  }
  // a list from the controller just landed (state.projects, state.currentSid)
  function panelOnSnapshot() {
    if (state.panel.view === 'inside-project' && !projectById(state.panel.pid)) setPanelView('projects');
    if (state.row.mode !== 'resting' && !rowKeyExists(state.row.key)) setRowMode('resting');
    if (state.pageChats.load === 'idle') loadPageChats();
    // the panel opens where the open chat lives — once per chat, so browsing
    // the lists afterwards is never undone by the next list that arrives
    if (state.currentSid && state.currentSid !== state.homedSid) {
      state.homedSid = state.currentSid;
      if (state.panel.view !== 'search') goHome();
    }
    renderPanel();
  }

  // ---- doing things --------------------------------------------------------
  // A row action is not a message: it must not add a line to the chat that is
  // open, and it must not wait behind a bot turn. So it does not go in as a
  // typed command. Every one goes through panelAct to the server's /panel,
  // which answers { ok: true } or { ok: false, error: <plain words> }.
  // panelAct resolves with the answer when it worked and with null when it
  // did not (the note at the foot of the list then says why).
  const PANEL_ACTIONS = Object.freeze(['rename', 'move', 'archive', 'unarchive', 'delete',
    'new-project', 'project-archive', 'project-unarchive', 'project-delete']);
  async function panelAct(action, args = {}) {
    if (!PANEL_ACTIONS.includes(action)) return null;
    const r = await post('/panel', { action, sid: args.sid, title: args.title, project: args.pid });
    if (r && r.ok) return r;
    setPanelNote({ text: (r && r.error) || 'Could not reach the council. Try again.' });
    return null;
  }
  async function moveChat(sid, pid) {
    const c = findChat(sid);
    setRowMode('resting');
    if (!c || c.pid === pid) return;
    const to = pid ? projectById(pid) : null;
    if (pid && !to) return;
    if (!await panelAct('move', { sid, pid })) return;
    setPanelNote({ text: to ? `Moved to ${to.title || to.id}.` : 'Moved to Chats.',
      undo: { action: 'move', args: { sid, pid: c.pid } } });
  }
  // "New project…" at the end of a chat's move list: make it, then file the chat
  async function moveToNewProject(c, name) {
    const sid = c.s.session_id;
    const made = await panelAct('new-project', { title: name });
    if (!made || !made.project) return;
    if (!await panelAct('move', { sid, pid: made.project })) return;
    setPanelNote({ text: `Moved to ${name}.`, undo: { action: 'move', args: { sid, pid: c.pid } } });
  }
  async function archiveChat(sid) {
    setRowMode('resting');
    if (!await panelAct('archive', { sid })) return;
    setPanelNote({ text: 'Archived.', undo: { action: 'unarchive', args: { sid } } });
  }
  // the row has already asked "delete?" (row mode 'confirming-delete')
  async function deleteChat(sid) {
    setRowMode('resting');
    if (!await panelAct('delete', { sid })) return;
    sessionCache.delete(sid);
    setPanelNote({ text: 'Deleted.' });
  }
  async function projectAct(action, pid) {
    const pr = projectById(pid);
    setRowMode('resting');
    if (!pr) return;
    const name = pr.title || pr.id;
    if (action === 'project-github') {
      // publishing is work for the bots: it is asked for in the chat, and the
      // bots ask "sure?" there before anything leaves this machine
      if (!await sendInput('/project github ' + pid)) return;
      setPanelNote({ text: 'Say yes in the chat to go ahead.' });
      closeSide();
      return;
    }
    if (!await panelAct(action, { pid })) return;
    if (action === 'project-archive') {
      setPanelNote({ text: `Archived ${name}.`, undo: { action: 'project-unarchive', args: { pid } } });
    } else if (action === 'project-unarchive') {
      setPanelNote({ text: `${name} is back.` });
    } else {
      setPanelNote({ text: `Deleted ${name}.` });
    }
  }
  // "Copy into the council" on a web-page chat: the council gets a chat of
  // its own with the page's conversation in it; the page keeps its chat
  async function copyPageChat(id) {
    setRowMode('resting');
    setPanelNote({ text: 'Copying…' });
    const r = await post('/page-chats/copy', { id });
    if (!r || !r.ok) {
      setPanelNote({ text: (r && r.error) || 'Could not reach the council. Try again.' });
      return;
    }
    const pr = r.project ? projectById(r.project) : null;
    const where = pr ? (pr.title || pr.id) : r.project ? 'its project' : 'Chats';
    setPanelNote({ text: r.reused ? `Already in ${where}.` : `Copied into ${where}.`, open: r.sid || '' });
    loadPageChats();
  }
  async function undoNote() {
    const u = state.panelNote && state.panelNote.undo;
    setPanelNote(null);
    if (u && await panelAct(u.action, u.args)) setPanelNote({ text: 'Undone.' });
  }
  // Enter in a row's text box: a new name for a chat, or a new project
  function commitInput(inp) {
    const text = inp.value.trim().replace(/\s+/g, ' ');
    const what = inp.dataset.commit;
    const key = state.row.key;
    setRowMode('resting');
    if (!text) return;
    if (what === 'new-project') {
      panelAct('new-project', { title: text }).then(r => { if (r) setPanelNote({ text: `Made the project ${text}.` }); });
    } else if (what === 'new-project-for-chat') {
      const c = findChat(key.slice(5));
      if (c) moveToNewProject(c, text);
    } else if (what === 'rename') {
      const c = findChat(key.slice(5));
      if (!c || text === chatTitle(c.s)) return;
      const sid = c.s.session_id;
      const before = chatTitle(c.s);
      panelAct('rename', { sid, title: text }).then(r => {
        if (r) setPanelNote({ text: 'Renamed.', undo: { action: 'rename', args: { sid, title: before } } });
      });
    }
  }
  // a tap somewhere else puts the busy row to rest; words typed into a text
  // box are kept (as if Enter had been pressed), never thrown away
  function restRow() {
    if (state.row.mode === 'resting') return;
    const inp = els.projects.querySelector('.lp-input');
    if (inp && inp.value.trim() && inp.value !== inp.defaultValue) { commitInput(inp); return; }
    setRowMode('resting');
  }
  function toggleMenu(key) {
    if (state.row.key === key) { setRowMode('resting'); return; }
    if (state.row.mode !== 'resting' && state.row.mode !== 'menu') restRow();
    setRowMode('menu', key);
  }
  function openChat(sid) {
    if (state.row.mode !== 'resting') setRowMode('resting');
    if (state.panel.view === 'search') {
      const h = homeView(state.projects, sid);
      if (!setPanelView(h.view, h)) setPanelView('chats');
    }
    switchTo(sid);
    closeSide();
  }
  function panelClick(act, b) {
    const d = b.dataset;
    if (act === 'more') return toggleMenu(d.key);
    if (act === 'settings') return toggleMenu('settings');
    if (act === 'rename') return setRowMode('renaming', state.row.key);
    if (act === 'move') return setRowMode('moving', state.row.key);
    if (act === 'cancel') return setRowMode('resting');
    if (act === 'new-project') {
      restRow();
      return setRowMode('naming-new-project', 'new-project');
    }
    if (act === 'move-to') return moveChat(d.sid, d.pid || '');
    if (act === 'move-new') return setRowMode('naming-new-project', state.row.key);
    if (act === 'archive') return archiveChat(d.sid);
    // Delete asks first, in the row; only its red button deletes
    if (act === 'delete' || act === 'proj-delete') return setRowMode('confirming-delete', state.row.key);
    if (act === 'delete-yes') return deleteChat(d.sid);
    if (act === 'proj-delete-yes') return projectAct('project-delete', d.pid);
    if (act === 'proj-github') return projectAct('project-github', d.pid);
    if (act === 'proj-archive') return projectAct('project-archive', d.pid);
    if (act === 'proj-unarchive') return projectAct('project-unarchive', d.pid);
    if (act === 'undo') return undoNote();
    if (act === 'page-copy') return copyPageChat(d.id);
    if (act === 'note-open') { setPanelNote(null); return openChat(d.sid); }
    // the rest move between lists, so a busy row rests first
    restRow();
    if (act === 'pill') {
      if (state.panel.view === 'search' && typeof els.search.blur === 'function') els.search.blur();
      // a tap on Chats also asks for the web-page chats again
      if (d.pill !== 'projects') loadPageChats();
      return setPanelView(d.pill === 'projects' ? 'projects' : 'chats');
    }
    if (act === 'enter') return setPanelView('inside-project', { pid: d.pid });
    if (act === 'search-x') return leaveSearch();
    if (act === 'open') return openChat(d.sid);
    return false;
  }
  // ONE click handler for the whole panel. The list is redrawn by most
  // clicks, so the page-wide "tap elsewhere" handler below cannot ask the
  // clicked node where it was; it asks whether the panel already saw it.
  const panelSaw = new WeakSet();
  els.side.addEventListener('click', e => {
    panelSaw.add(e);
    const b = e.target.closest('[data-act]');
    if (b) { panelClick(b.dataset.act, b); return; }
    // inside the open menu, text box or Settings box: leave it be
    if (e.target.closest('.lp-menu, .lp-input, .asking, .lp-settings-pop, .seg, .chip-label')) return;
    restRow();
  });
  document.addEventListener('click', e => { if (!panelSaw.has(e)) restRow(); });
  document.addEventListener('keydown', e => {
    const inp = e.target && typeof e.target.closest === 'function' ? e.target.closest('.lp-input') : null;
    if (inp && e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      commitInput(inp);
      return;
    }
    if (e.key !== 'Escape') return;
    // Escape closes the innermost thing first: a busy row, then the search
    if (state.row.mode !== 'resting') { e.stopImmediatePropagation(); setRowMode('resting'); return; }
    if (state.panel.view === 'search' && document.activeElement === els.search) {
      e.stopImmediatePropagation();
      leaveSearch();
    }
  });
  els.search.addEventListener('focus', () => setPanelView('search', { query: els.search.value }));
  els.search.addEventListener('input', () => setPanelView('search', { query: els.search.value }));
  els.newChat.addEventListener('click', () => {
    const v = state.panel;
    const here = v.view === 'inside-project' ? projectById(v.pid) : null;
    restRow();
    leaveSearch();
    snapshotCurrent();
    sendInput(here && isLive(here) ? '/new --project ' + here.id : '/new --inbox');
    closeSide();
  });

  // ── chat switching: optimistic render from cache, reconcile on replay ──
  // A switch re-attaches this tab's event stream to the target chat's bridge
  // (?chat=<sid>; the server spawns one on demand). What we make instant is
  // the paint: snapshot the outgoing transcript, restore the cached one (if
  // we have it) immediately, and let the authoritative replay land in an
  // offscreen buffer that swaps in when it completes. First visits keep the
  // old chat + a syncing pill — never a blank flash.
  function snapshotCurrent() {
    if (!state.currentSid || offscreen() || !els.transcript.children.length) return;
    cachePut(state.currentSid, {
      html: els.transcript.innerHTML,
      scrollTop: els.chat.scrollTop,
      atBottom: atBottom(),
    });
  }
  function setSyncing(on) { if (els.sync) els.sync.hidden = !on; }
  function switchTo(sid) {
    if (!sid) return;
    if (sid === state.currentSid && !switchTarget()) return; // already live: nothing to do
    snapshotCurrent();
    showQueued(0);               // the old chat's waiting messages stay with it
    setAttachMode('switching', sid);
    // …and a different conversation: the pill belongs to the chat it was
    // clicked in and the memory is rebuilt from the incoming replay, so
    // neither of them travels across the switch
    state.routeSticky = '';
    renderRoutes();
    syncHash(sid);                          // reflect the target chat in the URL now
    const cached = cacheGet(sid);
    if (cached) {
      els.transcript.innerHTML = cached.html;
      updateEmpty();
      if (cached.atBottom) pinBottom();
      else { els.chat.scrollTop = cached.scrollTop; els.jump.hidden = atBottom(); }
    }
    // the panel always describes what is ON SCREEN: the cached paint if we had
    // one, the outgoing chat until its replay lands if we didn't
    rescanTasks();
    setSyncing(true);
    reattach();
  }
  // replay-buffer completion: swap the freshly replayed transcript in and
  // decide the landing scroll — same content as the cached paint keeps the
  // user's place, anything else lands pinned at the bottom
  function flushReplayBuffer() {
    if (!offscreen()) return;
    const sid = switchTarget();
    const cached = sid ? sessionCache.get(sid) : null;
    const buf = replayBuffer;
    setTranscriptMode(SWAPS_TO[state.transcriptMode]);
    const sameAsCached = !!cached && cached.html === buf.innerHTML;
    els.transcript.innerHTML = '';
    while (buf.firstChild) els.transcript.appendChild(buf.firstChild);
    updateEmpty();
    rescanTasks(); // whole transcript replaced: re-derive the current list
    if (sameAsCached && !cached.atBottom) els.jump.hidden = atBottom();
    else settleBottom();
  }
  function endSwitch() {
    flushReplayBuffer();
    setAttachMode('open');
    setSyncing(false);
  }

  // ── hash routing: #/chat/<session-id> keeps the open chat in the URL, so a
  // link (or a reload) reopens the same chat. history.replaceState keeps it
  // out of the back-button history — switching chats isn't page navigation. ──
  function hashSid() {
    const m = /^#\/chat\/([\w-]+)$/.exec(location.hash || '');
    return m ? m[1] : '';
  }
  // `/?chat=<sid>` is the other spelling of a deep link — the one Discuss's
  // "Open the full chat" link has always used. Fold it into the hash form once,
  // at load, so there is still exactly one place the open chat is named (and a
  // stale query string can never fight the hash after the reader moves on).
  (function adoptChatQuery() {
    let sid = '';
    try { sid = new URLSearchParams(location.search).get('chat') || ''; } catch { sid = ''; }
    if (!/^[\w-]+$/.test(sid) || hashSid()) return;
    const params = new URLSearchParams(location.search);
    params.delete('chat');
    const q = params.toString();
    try { history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + `#/chat/${sid}`); }
    catch { location.hash = `#/chat/${sid}`; }
  })();
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
    if (!sid || sid === state.currentSid || sid === switchTarget()) return;
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
        : `<div ${sel}><code>${esc(c)}</code>${hintFor(c) ? `<span class="chint">${esc(hintFor(c))}</span>` : ''}</div>`;
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

  // ── the /help popup ──────────────────────────────────────────────────────
  // Typing /help (or just "help") opens a short list of what can be typed
  // here — command and one line each — instead of sending anything. The rows
  // are the controller's own table (COMMAND_HELP, carried in
  // completion_context as `commands`), the council's share of it; the same
  // rows give the autocomplete menu its one-line hints.
  const HELP_RE = /^\/?help$/i;
  const helpRows = () => ((state.ctx && Array.isArray(state.ctx.commands) && state.ctx.commands.length)
    ? state.ctx.commands : FALLBACK_COMMANDS)
    .filter(r => r && r.cmd && (!Array.isArray(r.scope) || r.scope.includes('council')));
  // the one-line hint for a completion ("/model @claude" → /model's row)
  function hintFor(text) {
    const first = String(text || '').trim().split(/\s+/)[0].toLowerCase();
    if (!first) return '';
    const row = helpRows().find(r => r.cmd === first || (r.aliases || []).includes(first))
      || (/^\/relay-/.test(first) ? helpRows().find(r => r.cmd === '/relay') : null);
    return row ? row.hint : '';
  }
  let helpEl = null, helpReturn = null;
  const helpOpen = () => !!(helpEl && !helpEl.hidden);
  function renderHelp() {
    if (!helpEl) return;
    const groups = [];
    for (const r of helpRows()) {
      let g = groups.find(x => x.name === (r.group || ''));
      if (!g) groups.push(g = { name: r.group || '', rows: [] });
      g.rows.push(r);
    }
    helpEl.querySelector('.help-body').innerHTML = groups.map(g =>
      `<section class="help-group">${g.name ? `<h3>${esc(g.name)}</h3>` : ''}` +
      g.rows.map(r => `<div class="help-row"><code>${esc(r.cmd)}${r.args ? ` <span class="help-args">${esc(r.args)}</span>` : ''}</code>` +
        `<span class="help-hint">${esc(r.hint)}</span></div>`).join('') +
      `</section>`).join('');
  }
  function openHelp() {
    if (!helpEl) {
      helpEl = document.createElement('div');
      helpEl.id = 'help-pop';
      helpEl.hidden = true;
      helpEl.innerHTML = `<div class="help-card" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div class="help-head"><b id="help-title">Commands</b>
          <button type="button" class="help-x" aria-label="close">×</button></div>
        <div class="help-body"></div>
        <div class="help-foot">Type / or @ in the box for suggestions · Esc closes</div></div>`;
      // a click on the dimmed backdrop (not the card) closes it
      helpEl.addEventListener('mousedown', e => { if (e.target === helpEl) closeHelp(); });
      helpEl.querySelector('.help-x').addEventListener('click', closeHelp);
      helpEl.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHelp(); }
      });
      document.body.appendChild(helpEl);
    }
    helpReturn = document.activeElement;
    renderHelp();
    helpEl.hidden = false;
    helpEl.querySelector('.help-x').focus();
  }
  function closeHelp() {
    if (!helpOpen()) return;
    helpEl.hidden = true;
    const back = helpReturn && helpReturn.isConnected ? helpReturn : els.input;
    helpReturn = null;
    if (back && back.focus) back.focus();
  }
  if (els.helpBtn) els.helpBtn.addEventListener('click', () => (helpOpen() ? closeHelp() : openHelp()));

  // ── the pill row: who the next message is for ────────────────────────────
  //
  // The council routes by tag: "@claude …" is claude's alone, "@codex …" is
  // codex's, and anything else is the room's (`Route: @all`, as /status says).
  // That rule was invisible and unremembered — the box looked identical
  // whoever the sentence was about to reach, and a reader talking to one bot
  // had to retype the tag on every single turn or watch the answer come back
  // from both. "I can't tag every time — there should be some memory of who we
  // are talking to."
  //
  // So: a row of pills above the box, lit at the address the next message will
  // actually carry, and a memory behind it. Clicking one types NOTHING (the
  // draft and the caret are the reader's); the tag is added to the text on
  // send, and only when the words carry none of their own — so the controller
  // sees exactly what it always saw and no protocol moved.
  const ROUTE_PILLS = () => AGENTS.concat(['all']);
  const routeLabel = h => (h === 'all' ? 'All' : cap(h));
  const routeTip = h => (h === 'all'
    ? 'both bots answer — the room'
    : `@${h} answers this one, and the messages after it`);
  // the tag a message's own words carry, as a pill name ('' = none). Two bots
  // named, or @all, is the room — the same reading `mentionedAgents` does.
  function routeWordOf(text) {
    const t = String(text || '');
    if (/@all\b/i.test(t)) return 'all';
    const hit = AGENTS.filter(a => new RegExp('@' + a + '\\b', 'i').test(t));
    if (!hit.length) return '';
    return hit.length > 1 ? 'all' : hit[0];
  }
  // the ROOM's own default, as the status snapshot reports it ("@all", "all",
  // "@claude" — /lead can move it). Anything unrecognised is the room.
  function defaultRoute() {
    const r = String((state.facts && state.facts.route) || '').trim().toLowerCase().replace(/^@/, '');
    return (r === 'all' || AGENTS.includes(r)) ? r : 'all';
  }
  // a pill choice belongs to the chat it was made in, and the chat being
  // switched TO is the one a click during a switch is about
  const routeKey = () => switchTarget() || state.currentSid || '';
  // Where the next message goes: a tag actually typed in the box (that is the
  // sentence about to be sent, and the row must not claim otherwise while it
  // is being written), else the pill this chat clicked, else who this chat was
  // last talking to, else the room's default.
  function routeNow() {
    const typed = routeWordOf(els.input ? els.input.value : '');
    if (typed) return typed;
    return state.routePick.get(routeKey()) || state.routeSticky || defaultRoute();
  }
  function renderRoutes() {
    if (!els.routeRow) return;
    const now = routeNow();
    els.routeRow.innerHTML = ROUTE_PILLS().map(h =>
      `<button type="button" class="rpill${h === now ? ' on' : ''}" data-route="${esc(h)}"` +
      ` aria-pressed="${h === now}" title="${esc(routeTip(h))}">${esc(routeLabel(h))}</button>`).join('');
  }
  if (els.routeRow) {
    els.routeRow.addEventListener('click', e => {
      const b = e.target.closest('[data-route]');
      if (!b) return;
      state.routePick.set(routeKey(), b.dataset.route);
      renderRoutes();
      els.input.focus();
    });
  }
  renderRoutes();

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
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/markdown', 'text/x-markdown', 'text/plain', 'text/csv', 'application/json'];
  const DOC_EXT = /\.(pdf|xlsx?|docx?|md|markdown|txt|csv|json)$/i;
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
          // the filename rides along: a text file has no magic bytes, so the
          // server needs the name to tell a .md from a .csv
          headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name || '') },
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
    if (els.lassoStrip) {
      els.lassoStrip.addEventListener('click', e => {
        const b = e.target.closest('button[data-lasso-x]');
        if (!b || b.disabled) return;
        b.disabled = true;
        sendInput('/lasso detach ' + b.dataset.lassoX);
      });
    }
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
    setPresend('guarded'); // editing invalidates a prior "send anyway"
    autosize(); refreshCompletions(); syncSend(); refreshPresendWarn(); renderRoutes();
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
  // A real keyboard is present when a fine pointer that can hover is (a mouse
  // or trackpad): laptop or desktop. Phones and tablets have neither.
  const FINE_KB = (() => {
    try { return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches); }
    catch { return false; }
  })();
  els.input.addEventListener('keydown', e => {
    if (!els.complete.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); compSel = (compSel + 1) % compItems.length; renderCompletions(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); compSel = (compSel - 1 + compItems.length) % compItems.length; renderCompletions(); return; }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acceptCompletion(compSel); return; }
      if (e.key === 'Escape') { compItems = []; renderCompletions(); return; }
    }
    // A council message is often long, and on a phone Enter is the only way to
    // a new line — so on a device without a real keyboard Enter is a newline
    // and sending is deliberate: Shift+Enter or ⌘/Ctrl+Enter (and the button).
    // With a mouse or trackpad present (a laptop or desktop) it is the
    // convention of every chat tool instead: Enter sends, Shift+Enter is the
    // new line. Decided once per page load (FINE_KB).
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (FINE_KB ? !e.shiftKey : e.shiftKey))) {
      e.preventDefault();
      submit();
    }
  });
  // the hint under the box says which rule this device got
  {
    const hintEl = document.querySelector('.composer-hint');
    if (hintEl) hintEl.textContent = FINE_KB
      ? 'Enter to send · Shift+Enter for a new line'
      : 'Enter for a new line · Shift+Enter or ⌘Enter to send';
  }
  function submit() {
    const text = els.input.value.trim();
    // "/help" is for the reader, not the bots: it opens the popup and is
    // never sent. Anything attached stays attached for the next message.
    if (HELP_RE.test(text)) {
      els.input.value = '';
      autosize();
      refreshCompletions();
      syncSend();
      openHelp();
      return;
    }
    const ready = state.atts.filter(a => a.status === 'ok');
    if (!text && !ready.length) return;
    if (state.atts.some(a => a.status === 'up')) { toast('still uploading…'); return; }
    // never send into a void: if this turn targets an out-of-credits agent,
    // surface the warning + switch affordance and hold the message (a slash
    // command like /model is control traffic, never gated)
    if (state.presend !== 'send_anyway' && !text.startsWith('/') && presendExhausted(text).length) {
      refreshPresendWarn();
      return;
    }
    setPresend('guarded');
    // WHERE THIS ONE GOES. The row has been promising an address; this is
    // where the promise is kept. A slash command is control traffic and is
    // never touched, words that already name a bot are the reader's own last
    // word, and an address that IS the room's default needs no tag at all —
    // the controller does that by itself. Everything else gets the tag the row
    // was lit with, prefixed to the text the controller already knows how to
    // read. The choice then sticks to this chat.
    let outText = text;
    if (text && !text.startsWith('/')) {
      const route = routeNow();
      if (!routeWordOf(text) && route !== defaultRoute()) outText = `@${route} ` + text;
      state.routePick.set(routeKey(), route);
    }
    if (text && !text.startsWith('/')) state.lastUserText = text;
    els.input.value = '';
    autosize();
    refreshCompletions();
    refreshPresendWarn();
    // exact bridge attachment schema — what the Ink TUI sends: {id, path, type:'image'}
    // the original filename rides along so the echoed message can name the
    // file the way the reader knows it, not by the stored id
    // the files leave the strip now, but are only let go once the server has
    // the message: a send that fails puts the words AND the files back
    const sent = state.atts.filter(a => a.status === 'ok');
    for (const a of state.atts) if (a.status !== 'ok') URL.revokeObjectURL(a.thumb);
    state.atts = [];
    renderAtts();
    sendInput(outText, ready.map(a => ({ id: a.id, path: a.path, type: a.kind === 'doc' ? 'file' : 'image', name: a.name || '' })))
      .then(ok => {
        if (ok) { for (const a of sent) URL.revokeObjectURL(a.thumb); return; }
        const now = els.input.value;
        els.input.value = now.trim() ? text + '\n' + now : text;
        state.atts = sent.concat(state.atts);
        renderAtts(); autosize(); refreshCompletions(); syncSend();
      });
    syncSend();
    renderRoutes();
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
  // resolves true when the server took the message, false when it did not
  // (then a "not sent" line says why, and the room is not marked busy)
  async function sendInput(text, attachments = []) {
    const r = await post('/input', { text, attachments });
    if (!r) {
      addMsg('system', 'not sent: the server could not be reached. Check the connection and try again.');
      return false;
    }
    if (r.ok === false) {
      addMsg('system', `not sent: ${r.error || 'the server did not take it'}`);
      return false;
    }
    // a typed /resume of a chat already open elsewhere: the server refuses to
    // fork the session and asks this tab to re-attach to the live bridge
    if (r.switch) switchTo(r.switch);
    else setRoomTurn('working');
    return true;
  }

  // ── dictation: tap the mic to record, tap again to stop. The clip goes to
  // POST /transcribe (whisper, on the machine running the server) and the
  // words land at the caret for editing — never sent on their own. Tap/tap,
  // not hold-to-talk: holding is unreliable in iOS Safari. ──
  const DICT_MAX_MS = 15 * 60 * 1000;
  // Dictation is in one of DICT_MODES, kept in dict.mode and moved only by
  // setDictMode, which refuses a move not in DICT_MOVES:
  //   idle         — nothing happening; a tap starts;
  //   asking       — waiting for the browser's microphone permission;
  //   recording    — a tap stops and transcribes, Esc throws it away;
  //   stopping     — the recorder is handing over the clip;
  //   transcribing — the clip is with the server.
  // A tap acts only in idle and recording. dict.timer is the 15-minute cap of
  // a recording, cleared whenever the mode leaves recording.
  const DICT_MODES = ['idle', 'asking', 'recording', 'stopping', 'transcribing'];
  const DICT_MOVES = new Set([
    'idle>asking', 'asking>recording', 'asking>idle',
    'recording>stopping', 'recording>idle',
    'stopping>transcribing', 'stopping>idle', 'transcribing>idle',
  ]);
  const dict = { mode: 'idle', rec: null, stream: null, chunks: [], timer: null, hint: '' };
  function dictMime() {
    const MR = window.MediaRecorder;
    if (!MR || typeof MR.isTypeSupported !== 'function') return '';
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
      try { if (MR.isTypeSupported(m)) return m; } catch { }
    }
    return ''; // let the browser choose
  }
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = () => reject(fr.error || new Error('could not read the recording'));
      fr.readAsDataURL(blob);
    });
  }
  function insertAtCaret(el, text) {
    text = String(text || '').trim();
    if (!text) return;
    const v = el.value;
    const a = typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
    const b = typeof el.selectionEnd === 'number' ? el.selectionEnd : a;
    const before = v.slice(0, a), after = v.slice(b);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after && !/^\s/.test(after) ? ' ' : '';
    el.value = before + pre + text + post + after;
    const at = (before + pre + text).length;
    try { el.setSelectionRange(at, at); } catch { }
  }
  function dictHint(text) {
    const h = document.querySelector('.composer-hint');
    if (!h) return;
    if (text) { if (!h.classList.contains('live')) dict.hint = h.textContent; h.textContent = text; h.classList.add('live'); }
    else { h.textContent = dict.hint || h.textContent; h.classList.remove('live'); }
  }
  function dictUi(mode) { // '' | 'recording' | 'transcribing'
    if (!els.mic) return;
    els.mic.classList.toggle('recording', mode === 'recording');
    els.mic.classList.toggle('transcribing', mode === 'transcribing');
    els.mic.setAttribute('aria-pressed', mode === 'recording' ? 'true' : 'false');
    els.mic.title = mode === 'recording' ? 'tap to stop and transcribe'
      : mode === 'transcribing' ? 'transcribing…' : 'tap to dictate — tap again to stop';
    dictHint(mode === 'recording' ? 'recording… tap to stop' : mode === 'transcribing' ? 'transcribing…' : '');
  }
  function setDictMode(to) {
    if (!DICT_MODES.includes(to) || !DICT_MOVES.has(dict.mode + '>' + to)) return false;
    dict.mode = to;
    if (to !== 'recording') { clearTimeout(dict.timer); dict.timer = null; }
    dictUi(to === 'recording' ? 'recording' : to === 'stopping' || to === 'transcribing' ? 'transcribing' : '');
    return true;
  }
  function stopTracks(stream) {
    if (stream) for (const tr of stream.getTracks()) { try { tr.stop(); } catch { } }
  }
  function dictRelease() {
    stopTracks(dict.stream);
    dict.stream = null; dict.rec = null; dict.chunks = [];
  }
  async function dictStart() {
    if (!setDictMode('asking')) return;
    let stream;
    try {
      // must run inside the tap itself: iOS only grants the mic to a gesture
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (!setDictMode('idle')) return; // already given up on (Esc)
      const n = e && e.name;
      toast(n === 'NotAllowedError' || n === 'SecurityError' ? 'microphone permission was refused'
        : n === 'NotFoundError' ? 'no microphone found' : 'could not start the microphone');
      return;
    }
    // given up on while the browser was asking: let the microphone go at once
    if (dict.mode !== 'asking') { stopTracks(stream); return; }
    const mime = dictMime();
    let rec;
    try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch { stopTracks(stream); setDictMode('idle'); toast('this browser cannot record audio'); return; }
    Object.assign(dict, { rec, stream, chunks: [] });
    rec.addEventListener('dataavailable', e => { if (dict.rec === rec && e.data && e.data.size) dict.chunks.push(e.data); });
    rec.addEventListener('stop', () => dictFinish(rec, mime));
    rec.start();
    setDictMode('recording');
    dict.timer = setTimeout(() => dictStop(), DICT_MAX_MS);
  }
  // tap while recording: keep the clip and transcribe it
  function dictStop() {
    if (!setDictMode('stopping')) return;
    try { dict.rec.stop(); } catch { dictRelease(); setDictMode('idle'); }
  }
  // Esc: throw the recording away (or stop waiting for permission)
  function dictCancel() {
    if (dict.mode === 'asking') return setDictMode('idle');
    if (dict.mode !== 'recording') return false;
    const rec = dict.rec;
    dictRelease();
    setDictMode('idle');
    try { rec.stop(); } catch { }
    return true;
  }
  async function dictFinish(rec, mime) {
    if (dict.mode !== 'stopping' || dict.rec !== rec) return; // thrown away
    const chunks = dict.chunks;
    dictRelease();
    const type = (chunks[0] && chunks[0].type) || rec.mimeType || mime || 'audio/webm';
    const blob = new Blob(chunks, { type });
    if (!blob.size) { setDictMode('idle'); toast('nothing was recorded'); return; }
    setDictMode('transcribing');
    try {
      const r = await post('/transcribe', { audio_b64: await blobToB64(blob), mime: blob.type || type, lang: 'en' });
      if (!r) toast('transcription failed: no reply from the server');
      else if (!r.ok) toast(r.error || 'transcription failed');
      else if (!String(r.text || '').trim()) toast('no speech was heard');
      else {
        insertAtCaret(els.input, r.text);
        autosize(); syncSend(); refreshCompletions();
        els.input.focus();
      }
    } catch (e) { toast((e && e.message) || 'transcription failed'); }
    finally { setDictMode('idle'); }
  }
  async function dictInit() {
    if (!els.mic) return;
    els.mic.hidden = true;
    // no mic API: an http page that is not localhost, or an old browser
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function'
      || typeof window.MediaRecorder !== 'function') return;
    try {
      const r = await fetch('/transcribe', { method: 'GET' });
      const j = r && r.status === 200 ? await r.json() : null;
      if (j && j.ok) els.mic.hidden = false;
    } catch { }
  }
  if (els.mic) {
    els.mic.addEventListener('click', () => {
      // a tap means something only in idle and recording: a second tap while
      // the browser is still asking for permission must not start a second
      // recorder
      if (dict.mode === 'idle') dictStart();
      else if (dict.mode === 'recording') dictStop();
    });
    dictInit();
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
        if (Number(ev.heartbeat_ms) > 0) conn.heartbeatMs = Number(ev.heartbeat_ms);
        // a freshly spawned bridge is still executing its /resume: its replay
        // shows the interstitial startup chat, so the offscreen buffer must
        // stay up past replay_done until the live 'ready' lands
        noteResuming(!!ev.resuming);
        if (ev.noauth && !localStorage.getItem('council-noauth-dismissed')) els.banner.hidden = false;
        break;
      case 'route_error':
        // the chat this tab asked for could not be attached (unknown id):
        // we are on the fallback bridge — say so and let
        // the next 'projects' event correct the URL. Remember the refused id
        // so routeHash doesn't immediately re-ask for it (toast loop).
        state.routeErrorSid = switchTarget() || hashSid() || null;
        // put the URL back now: switchTo already wrote the refused id into
        // it, and a hash naming one chat over a header and transcript of
        // another is exactly the mismatch this toast is apologising for
        if (state.currentSid) syncHash(state.currentSid);
        toast(ev.error || 'chat not found — showing the current chat');
        setAttachMode('open');
        setSyncing(false);
        break;
      case 'room': {
        const sp = String(ev.speaker).toLowerCase();
        if (sp === 'user' && !ev.restored) break; // we echo user input ourselves
        // a summoned build agent's card: nested under the bot that summoned it
        if (sp === 'agent' && ev.agent) { handleAgentRoom(ev); break; }
        // tool-run entries get the collapsible card, placed before the reply
        if (AGENTS.includes(sp) &&
            (/:tools$/.test(ev.stream_id || '') || /^Explored\n/.test(ev.text || ''))) {
          addToolsCard(ev.speaker, ev.text, ev.stream_id || '');
          break;
        }
        // a finalized agent turn is the exhaustion signal (or proof it recovered)
        if (AGENTS.includes(sp)) noteAgentTurn(sp, ev.text);
        if (ev.stream_id && finalizeStream(ev)) break;
        {
          const el = addMsg(ev.speaker, ev.text);
          // a bot's turn keeps its stream id so a summoned agent's card can
          // find its parent (parent_stream_id) after the stream is over
          if (ev.stream_id && AGENTS.includes(sp)) el.dataset.streamId = String(ev.stream_id);
        }
        break;
      }
      case 'restore':
        for (const e of ev.entries || []) {
          if (String(e.speaker).toLowerCase() === 'agent' && e.agent) {
            handleAgentRoom(e);
            const card = summonCard(e.agent.id);
            if (card) card.dataset.restored = '1';
          } else addMsg(e.speaker, e.text);
        }
        break;
      case 'video_watch':
        // start / done / error for one Gemini video watch (core/botference.py
        // _watch_one_video). The report itself arrives as a `gemini` room
        // entry; this is only the header's working light.
        geminiPhase(
          ev.state === 'start' ? 'watching' : ev.state === 'error' ? 'error' : 'done',
          ev.url || 'a video',
        );
        break;
      case 'stream':
        setRoomTurn('working');
        // a summoned build agent's live output goes into its nested card, not
        // the transcript proper (and never into the subagents lane)
        if (ev.agent && ev.agent.id && String(ev.model || '').toLowerCase() === 'agent') {
          handleAgentStream(ev); break;
        }
        if (ev.kind === 'text_delta') { streamDelta(ev); break; }
        if (ev.model && AGENTS.includes(String(ev.model).toLowerCase())) {
          const m = String(ev.model).toLowerCase();
          // 'done' closes this bot's turn (whatever its outcome); anything
          // else on its stream means it is answering
          if (ev.kind === 'done') setAgentMode(m, 'idle');
          else {
            setAgentMode(m, 'working');
            // live activity for the agents panel: latest tool + target
            if (ev.kind === 'tool_start') { state.activity[m] = laneActivity(ev); renderAgentsPanel(); }
          }
        }
        if (ev.kind === 'tool_start' || ev.kind === 'tool_done') laneEvent(ev);
        break;
      case 'user_echo':
        // The memory, and it is derived rather than remembered: every human
        // turn in this chat passes through here, on a live send AND on the
        // replay a reload or a chat switch brings, so who the chat is talking
        // to survives both. An untagged turn is the room's by the controller's
        // own rule, and clears it back to the default.
        if (ev.text && !String(ev.text).startsWith('/')) {
          state.lastUserText = ev.text;
          // a message that has actually been sent settles the row: the pill
          // clicked before it was a promise about THIS message, and this is it
          state.routePick.delete(routeKey());
          state.routeSticky = routeWordOf(ev.text);
          renderRoutes();
        }
        addMsg('user', ev.text, { attachments: ev.attachments || [] });
        setRoomTurn('working');
        break;
      case 'status':
        state.facts = {
          mode: ev.mode || '', lead: ev.lead || '',
          route: ev.route || '', project: ev.project || '',
        };
        renderRoutes();   // /lead can move the room's default under the row
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
        // the chat's name, in the header and on the browser tab — the one
        // thing that tells five open tabs apart on a phone
        if ('title' in ev) {
          const t = String(ev.title || '').trim();
          if (els.stTitle) els.stTitle.textContent = t;
          document.title = t ? `${t} · council` : 'council';
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
        noteProjectTasks(ev);
        panelOnSnapshot();
        // honor a deep-linked #/chat/<id> once, when the session list first
        // arrives; after that the hash mirrors the active chat instead
        if (!hashRestored) { hashRestored = true; routeHash(); }
        // reflect the actually-open chat — but never clobber a hash
        // routeHash is mid-way through opening
        if (!switchTarget() && active) syncHash(active);
        break;
      }
      case 'completion_context':
        state.ctx = { global: ev.global || [], scoped: ev.scoped || {},
          commands: (Array.isArray(ev.commands) && ev.commands.length) ? ev.commands : FALLBACK_COMMANDS };
        if (helpOpen()) renderHelp();
        renderModelSwitcher();
        break;
      case 'ready':
        // a buffered switch replay ends at the bridge's LIVE idle boundary —
        // 'ready' events replayed from server history don't count (the
        // connect replay ends at replay_done instead)
        if (!serverReplay()) {
          if (offscreen()) endSwitch();
          else if (switchTarget()) { dropSwitch(); setSyncing(false); }
          if (state.transcriptMode === 'redrawing') { setTranscriptMode('live'); settleBottom(); }
        }
        // a watch always ends inside the turn it started in; if its 'done'
        // was lost (history trimmed, tab joined mid-watch) the idle boundary
        // settles the mark rather than leaving it spinning forever
        if (state.gemini.phase === 'watching') geminiPhase(null);
        setRoomTurn('idle');
        settleCard();
        freezeLanes();
        endWorkingAgentCards();
        state.streams = {};
        for (const el of els.transcript.querySelectorAll('.msg.streaming')) el.classList.remove('streaming');
        break;
      case 'queue':
        showQueued(ev.pending || 0);
        break;
      case 'clear_panes':
        state.streams = {};
        liveCard = null;
        resetLanes();
        // a restore replay follows: pin, no heuristics (redrawing). Inside
        // the server's own replay it is all one catch-up, ended by replay_done
        if (state.attachMode !== 'open') {
          // in-flight switch: keep the optimistic (or outgoing) transcript on
          // screen and build the authoritative one offscreen — never blank.
          // A fresh buffer also drops a resuming bridge's interstitial
          // startup events, which are plumbing, not this chat's transcript.
          setTranscriptMode(serverReplay() ? 'offscreen_catching_up' : 'offscreen_redrawing',
            document.createElement('div'));
        } else {
          els.transcript.innerHTML = '';
          updateEmpty();
          rescanTasks();
          const to = { live: 'redrawing', offscreen_waiting: 'offscreen_redrawing' }[state.transcriptMode];
          if (to) setTranscriptMode(to);
        }
        break;
      case 'replay_done': {
        // server-side history replay boundary (connect/reconnect/reattach):
        // the catch-up (or redraw) is over; a hidden pane waits to swap in
        const over = offscreen() ? 'offscreen_waiting' : 'live';
        if (state.transcriptMode !== over) setTranscriptMode(over);
        if (offscreen() && !bridgeResuming()) {
          // attached to a live chat: its replayed history IS the transcript
          endSwitch();
          break;
        }
        // a resuming bridge keeps buffering until its live 'ready';
        // otherwise land where the reader was before the reload, or pinned
        // at the very bottom, re-asserted after layout settles
        if (!offscreen()) { if (!recallScroll()) settleBottom(); }
        break;
      }
      case 'permission_request': permissionCard(ev); break;
      case 'permission_cleared': settleCard(); break;
      case 'choice_request': choiceCard(ev); break;
      case 'lasso':
        // one event, two things: a SEARCH (a card of offers) and the
        // standing list of what is attached (the strip)
        if (Array.isArray(ev.attachments)) { state.lassoOn = ev.attachments; renderLassoStrip(); }
        else lassoCard(ev);
        break;
      case 'choice_cleared': settleCard(); break;
      case 'permission_timeout': settleCard('timed out — denied by default'); break;
      case 'choice_timeout': settleCard('timed out — dismissed'); break;
      case 'bots_stopped':
        // a billing change stopped this chat's bots; the server is opening
        // the chat again under the new billing and this tab now follows that
        // bridge. The chat is redrawn offscreen (clear_panes, above) and
        // swapped in at its ready, so the reader sees no blank moment.
        state.bridgeId = ev.bridge_id || null;
        noteResuming(!!ev.resuming);
        addMsg('system', ev.text || 'The bots were stopped. They start again with your next message.');
        setRoomTurn('idle');
        break;
      case 'not_sent': {
        // messages that waited for a chat that never opened: one line, and
        // the words back in the box (ahead of anything typed since)
        if (offscreen() || switchTarget()) endSwitch();
        addMsg('system', ev.text || 'Not sent: this chat could not be opened.');
        const back = (ev.texts || []).join('\n');
        if (back) {
          const now = els.input.value;
          els.input.value = now.trim() ? back + '\n' + now : back;
          autosize(); refreshCompletions(); syncSend();
        }
        break;
      }
      case 'bridge_exit':
        if (offscreen() || switchTarget()) endSwitch(); // don't hang on a stale optimistic view
        addMsg('system', `agent bridge exited (code ${ev.code})${ev.error ? ` — ${ev.error}` : ''}. Restart the server to continue.`);
        setRoomTurn('idle');
        break;
      case 'exit':
        if (offscreen() || switchTarget()) endSwitch();
        addMsg('system', 'session ended.');
        setRoomTurn('idle');
        break;
      // mode, notify, bridge_log, ping, permission/choice bookkeeping we
      // don't visualize: ignore quietly
    }
  }

  // ── live transport: WebSocket first, SSE fallback ──
  // WS is primary because proxies/CDN edges (the --share cloudflared tunnel
  // included) buffer streamed HTTP bodies — SSE headers arrive but no events
  // ever do — while WebSocket upgrades are proxied unbuffered.
  // The connection is in one of CONN_MODES, kept in conn.mode and moved
  // only by setConnMode, which refuses a move not in CONN_MOVES:
  //   connecting — a stream is being opened (the status line is left as is);
  //   live       — a stream is open and delivering events;
  //   retrying   — the stream dropped; conn.retryTimer will open a new one.
  // conn.transport says which kind of stream: 'ws', or 'sse' once WebSocket
  // has proved unusable here (it stays on SSE for reattaches too). Opening a
  // stream always closes the old one first and cancels a pending retry, so
  // there is never more than one live stream (two meant every message twice).
  const CONN_MODES = ['connecting', 'live', 'retrying'];
  const CONN_MOVES = new Set([
    'connecting>connecting', 'connecting>live', 'connecting>retrying',
    'live>connecting', 'live>retrying', 'retrying>connecting',
  ]);
  //
  // A phone that sleeps, backgrounds the tab, or hops from wifi to mobile
  // data can leave the stream open at this end and dead at the other: no
  // close, no error, only silence — the page went on saying "live" over the
  // first bot's half-written answer and never showed the second bot's turn.
  // The server says something at least once a heartbeat (conn.heartbeatMs,
  // from its hello), so conn.heardAt — the last time the stream delivered
  // anything, a ping included — tells a quiet room from a dead stream. A
  // stream silent for too long is reopened, and the reopen replays the chat
  // from the server, so whatever was missed is caught up (reviveIfSilent).
  const conn = {
    mode: 'connecting', transport: 'ws', sock: null, es: null, retryTimer: null, retryMs: 1000,
    heardAt: Date.now(), heartbeatMs: 15000,
  };
  function setConn(cls, txt) { els.conn.className = `conn ${cls}`; els.conn.textContent = txt; }
  function setConnMode(to) {
    if (!CONN_MODES.includes(to) || !CONN_MOVES.has(conn.mode + '>' + to)) return false;
    clearTimeout(conn.retryTimer);
    conn.retryTimer = null;
    conn.mode = to;
    if (to === 'live') { conn.retryMs = 1000; setConn('ok', '● live'); }
    if (to === 'retrying') {
      setConn('err', '○ reconnecting…');
      conn.retryTimer = setTimeout(openStream, conn.retryMs);
      conn.retryMs = Math.min(conn.retryMs * 2, 15000);
    }
    return true;
  }
  // which chat this tab wants its stream attached to: an in-flight switch
  // wins, then the open chat (reconnects stay on it), then a deep link
  function chatParam() {
    const sid = switchTarget() || state.currentSid || hashSid();
    return sid ? '?chat=' + encodeURIComponent(sid) : '';
  }
  function resetView() {
    // reconnect replays server history from scratch: start clean, keep the
    // scroll pinned until the server's replay_done boundary
    els.transcript.innerHTML = '';
    state.streams = {};
    setTranscriptMode('catching_up');
    dropSwitch();
    resetLanes();
    setSyncing(false);
    updateEmpty();
    rescanTasks();
  }
  // connect-time view prep: a deliberate chat switch keeps the visible
  // transcript (cached paint or the outgoing chat) and builds the replayed
  // one offscreen; anything else starts clean
  function prepView() {
    if (switchTarget()) {
      setTranscriptMode('offscreen_catching_up', document.createElement('div'));
      state.streams = {};
      liveCard = null;
      resetLanes();
    } else {
      resetView();
    }
  }
  function dropTransport() {
    if (conn.sock) {
      const s = conn.sock; conn.sock = null;
      s.onopen = null; s.onmessage = null; s.onclose = null; s.onerror = null;
      try { s.close(); } catch { }
    }
    if (conn.es) {
      const es = conn.es; conn.es = null;
      es.onopen = null; es.onmessage = null; es.onerror = null;
      try { es.close(); } catch { }
    }
  }
  // the one way a stream is opened: first, initial connect, retry, and the
  // deliberate re-attach of a chat switch alike
  function openStream() {
    dropTransport();
    conn.heardAt = Date.now(); // the new stream gets a full allowance to speak
    setConnMode('connecting');
    if (conn.transport === 'sse') connectSSE(); else connectWS();
  }
  function reattach() { openStream(); }
  // the stream (live, or still opening) has been silent for longer than
  // limitMs: it is dead whatever the browser says — open a fresh one
  function reviveIfSilent(limitMs) {
    if (conn.mode === 'retrying' || Date.now() - conn.heardAt <= limitMs) return false;
    openStream();
    return true;
  }
  // the reader is back (tab shown again, phone woken, network back): a
  // stream that missed even one heartbeat is presumed dead, and a pending
  // retry runs now rather than at the end of its back-off
  function onWake() {
    if (conn.mode === 'retrying') { openStream(); return; }
    reviveIfSilent(conn.heartbeatMs + 3000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onWake(); });
  window.addEventListener('pageshow', onWake);
  window.addEventListener('online', onWake);
  // and while the page stays open: two missed heartbeats and the stream is dead
  setInterval(() => reviveIfSilent(conn.heartbeatMs * 2 + 5000), 5000);
  function onLine(data) {
    conn.heardAt = Date.now();
    let ev; try { ev = JSON.parse(data); } catch { return; }
    if (ev.type !== 'ping') handle(ev);
  }
  function connectWS() {
    prepView();
    let sock;
    try {
      sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + chatParam());
    } catch { conn.transport = 'sse'; connectSSE(); return; }
    conn.sock = sock;
    let opened = false;
    sock.onopen = () => { if (conn.sock !== sock) return; opened = true; setConnMode('live'); };
    sock.onmessage = e => { if (conn.sock === sock) onLine(e.data); };
    sock.onerror = () => { };
    sock.onclose = () => {
      if (conn.sock !== sock) return; // superseded by a newer stream
      conn.sock = null;
      // never got open: something between us and the server blocks WS — use SSE
      if (!opened) { conn.transport = 'sse'; connectSSE(); return; }
      setConnMode('retrying');
    };
  }
  function connectSSE() {
    prepView(); // idempotent right after connectWS()'s prep — no events between
    const es = new EventSource('/events' + chatParam());
    conn.es = es;
    es.onopen = () => { if (conn.es === es) setConnMode('live'); };
    es.onmessage = e => { if (conn.es === es) onLine(e.data); };
    es.onerror = () => {
      if (conn.es !== es) { try { es.close(); } catch { } return; }
      conn.es = null;
      es.close();
      setConnMode('retrying');
    };
  }

  document.addEventListener('keydown', e => {
    // Esc while dictating throws the recording away (no request is made)
    if (e.key === 'Escape' && (dict.mode === 'recording' || dict.mode === 'asking')) { e.preventDefault(); dictCancel(); toast('dictation cancelled'); return; }
    if (e.key === 'Escape' && helpOpen()) { closeHelp(); return; }
    if (e.key === 'Escape' && document.body.classList.contains('side-open')) closeSide();
    if (e.key === 'Escape') closeAgents();
  });
  // a pasted link or a back/forward navigation between #/chat/<id> hashes
  window.addEventListener('hashchange', routeHash);

  updateEmpty();
  syncSend();
  renderPanel();
  openStream();

  // exposed for the DOM test harness
  window.__council = {
    handle, sendInput, computeCompletions, state, els,
    fmt, sysFmt, switchTo, addFiles, submit, sessionCache,
    renderMarkdown, splitEnvelopes, hashText, ticks,
    renderModelSwitcher, refreshPresendWarn, presendExhausted,
    noteAgentTurn, exhaustReason, modelsFor, effortsFor,
    laneEvent, hashSid, syncHash, routeHash, chatParam,
    renderTasks, rescanTasks, taskSrc: () => taskSrc,
    // the transcript pane's modes: the pure move rule and the one setter
    TRANSCRIPT_MODES, transcriptMove, setTranscriptMode,
    // the left panel: each list, its pure move rule and its one setter
    PANEL_VIEWS, panelViewMove, setPanelView, ROW_MODES, rowMove, setRowMode,
    SLIDE_MODES, slideMove, setSlideOut, CONTENTS_LOADS, contentsMove, setContentsLoad,
    setPanelNote, homeView, searchRows, relTime, renderPanel, panelAct, PANEL_ACTIONS,
    PAGE_CHATS_LOADS, pageChatsMove, setPageChatsLoad, loadPageChats, searchPages,
    // the room's turn and the pre-send guard: each list and its one setter
    ROOM_TURNS, setRoomTurn, PRESEND_MODES, setPresend,
    // what the stream waits on: the pure move rule, the one setter, the target
    ATTACH_MODES, attachMove, setAttachMode, switchTarget,
    renderRoutes, routeNow, routeWordOf, defaultRoute,
    projectTasks: () => ptasks,
    renderBilling, loadBilling, setKeyInfo: k => { keyInfo = k; renderBilling(); },
    // the typewriter: the setting, the switch, and the drain's own clock —
    // exposed so a test can step it rather than wait on wall time
    typingPref, setTyping, renderTyping, typeDrain, shownText,
    // the /help popup and the hints the autocomplete shows
    openHelp, closeHelp, helpOpen, helpRows, hintFor,
    // dictation
    dict, dictMime, insertAtCaret, dictInit, setDictMode,
    // the live connection
    conn, setConnMode, reviveIfSilent, onWake, setAgentMode,
  };
})();
