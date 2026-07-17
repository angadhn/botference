// botference council — browser client for the plan-mode bridge.
// One SSE stream in (/events, bridge events relayed verbatim plus a few
// server events), three POSTs out (/input, /permission, /choice, /interrupt).
// Slash commands pass through verbatim: the controller parses them exactly
// as it does for the TUI.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const els = {
    side: $('side'), backdrop: $('backdrop'), burger: $('burger'), sideClose: $('side-close'),
    newChat: $('new-chat'), projects: $('projects'), theme: $('theme-toggle'),
    conn: $('st-conn'), stProject: $('st-project'), stRoute: $('st-route'), stCtx: $('st-ctx'),
    avatars: $('avatars'), banner: $('noauth-banner'), bannerX: $('noauth-x'),
    chat: $('chat'), transcript: $('transcript'), empty: $('empty'), jump: $('jump'),
    input: $('input'), send: $('send'), stop: $('stop'), complete: $('complete'),
    queueNote: $('queue-note'),
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
  const avatarHtml = a =>
    `<span class="avatar" style="--author:var(--${a})" aria-hidden="true">${MARKS[a] || ''}</span>`;
  // empty state gets the two participant marks side by side
  const emptyMarks = document.querySelector('.empty-marks');
  if (emptyMarks) emptyMarks.innerHTML = AGENTS.map(avatarHtml).join('');

  // ── state ──
  const state = {
    busy: false, queued: 0, agents: { claude: false, codex: false },
    streams: {},           // key "model:stream_id" -> {el, text}
    ctx: { global: [], scoped: {} },
    projects: null,
    openProjects: new Set(),
  };

  function renderAvatars() {
    els.avatars.innerHTML = AGENTS.map(a => {
      const name = a[0].toUpperCase() + a.slice(1);
      const on = state.agents[a];
      return `<span class="avatar-ring${on ? ' working' : ''}" style="--author:var(--${a})" title="${name}${on ? ' is working…' : ' — idle'}">${avatarHtml(a)}</span>`;
    }).join('');
  }
  renderAvatars();

  function setBusy(b) {
    state.busy = b;
    els.stop.hidden = !b;
    if (!b) { for (const a of AGENTS) state.agents[a] = false; renderAvatars(); }
  }

  // ── transcript ──
  // the JSON room footer drives bot-to-bot routing and is stripped by the
  // controller before 'room' events; live stream deltas can still carry it
  // (or a partially streamed fence), so strip it from display here too
  const FOOTER_FENCED = /```(?:json)?\s*\{[^`]*\}\s*```\s*$/;
  const FOOTER_RAW = /\{[^{]*"status"[^}]*\}\s*$/;
  const FOOTER_PARTIAL = /```(?:json)?\s*\{[^`]*$/;
  const stripFooter = t => String(t)
    .replace(FOOTER_FENCED, '').replace(FOOTER_RAW, '').replace(FOOTER_PARTIAL, '').trimEnd();

  function fmt(text) {
    // fences first (on raw text), then inline formatting on the prose parts
    const parts = String(text).split(/```([\s\S]*?)```/);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        const body = parts[i].replace(/^[a-zA-Z0-9_-]*\n/, '');
        html += `<pre><code>${esc(body)}</code></pre>`;
      } else {
        html += esc(parts[i])
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      }
    }
    return html;
  }

  function updateEmpty() {
    els.empty.hidden = els.transcript.children.length > 0;
  }
  const pinned = () => els.chat.scrollTop + els.chat.clientHeight >= els.chat.scrollHeight - 90;
  function follow(wasPinned) {
    if (wasPinned) { els.chat.scrollTop = els.chat.scrollHeight; els.jump.hidden = true; }
    else els.jump.hidden = false;
  }
  els.chat.addEventListener('scroll', () => { if (pinned()) els.jump.hidden = true; });
  els.jump.addEventListener('click', () => {
    els.chat.scrollTop = els.chat.scrollHeight; els.jump.hidden = true;
  });

  function addMsg(speaker, text, { streaming = false } = {}) {
    const wasPinned = pinned();
    const div = document.createElement('div');
    const who = String(speaker || 'system').toLowerCase();
    if (who === 'user') {
      div.className = 'msg user';
      div.innerHTML = `<div class="body">${fmt(text)}</div>`;
    } else if (who === 'claude' || who === 'codex') {
      div.className = `msg ${who}${streaming ? ' streaming' : ''}`;
      div.innerHTML = `<div class="who">${avatarHtml(who)}<span>${who}</span></div><div class="body">${fmt(text)}</div>`;
    } else {
      // multi-line system output (/help, /status, resume lists) reads better
      // as a left-aligned block than a centered whisper
      div.className = `msg system${/\n/.test(text) ? ' block' : ''}`;
      div.innerHTML = `<div class="body">${esc(text)}</div>`;
    }
    els.transcript.appendChild(div);
    updateEmpty();
    follow(wasPinned);
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
    s.el.querySelector('.body').innerHTML = fmt(stripFooter(s.text));
    follow(wasPinned);
  }
  function finalizeStream(ev) {
    const key = `${ev.speaker}:${ev.stream_id}`;
    const s = state.streams[key];
    if (s) {
      const wasPinned = pinned();
      s.el.classList.remove('streaming');
      s.el.querySelector('.body').innerHTML = fmt(ev.text);
      delete state.streams[key];
      follow(wasPinned);
      return true;
    }
    return false;
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
    els.transcript.appendChild(div);
    liveCard = div;
    updateEmpty();
    follow(wasPinned);
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
    els.transcript.appendChild(div);
    liveCard = div;
    updateEmpty();
    follow(wasPinned);
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
  function renderProjects() {
    const p = state.projects;
    if (!p) { els.projects.innerHTML = '<div class="empty-note">loading…</div>'; return; }
    let html = '';
    html += '<h2>Chats</h2>';
    html += `<div class="proj"><button class="proj-head" data-act="inbox">
      <span class="chev">•</span><span class="name">Inbox</span>
      <span class="count">${p.inbox_session_count || 0}</span></button></div>`;
    if ((p.projects || []).length) {
      html += '<h2>Projects</h2>';
      for (const pr of p.projects) {
        const open = state.openProjects.has(pr.id) || pr.active;
        html += `<div class="proj${open ? ' open' : ''}" data-pid="${esc(pr.id)}">
          <button class="proj-head${pr.active ? ' active' : ''}" data-act="toggle" data-pid="${esc(pr.id)}" aria-expanded="${open}">
            <span class="chev">▶</span><span class="name">${esc(pr.title || pr.id)}</span>
            <span class="count">${pr.session_count ?? (pr.sessions || []).length}</span></button>
          <div class="proj-sessions">`;
        if (!pr.active) html += `<button class="sess" data-act="activate" data-pid="${esc(pr.id)}">→ make active project</button>`;
        for (const s of pr.sessions || []) {
          html += `<button class="sess${s.active ? ' active' : ''}" data-act="resume" data-sid="${esc(s.session_id)}">
            ${esc(s.title || s.session_id.slice(0, 8))}<span class="when">${relTime(s.updated_at)}</span></button>`;
        }
        if (!(pr.sessions || []).length) html += '<div class="empty-note">no chats yet</div>';
        html += '</div></div>';
      }
    }
    els.projects.innerHTML = html;
  }
  els.projects.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'toggle') {
      const pid = b.dataset.pid;
      if (state.openProjects.has(pid)) state.openProjects.delete(pid);
      else state.openProjects.add(pid);
      renderProjects();
      return;
    }
    // sidebar affordances send the equivalent slash command — one code path
    if (act === 'inbox') sendInput('/resume');
    if (act === 'resume') sendInput('/resume ' + b.dataset.sid);
    if (act === 'activate') sendInput('/project open ' + b.dataset.pid);
    closeSide();
  });
  els.newChat.addEventListener('click', () => { sendInput('/new'); closeSide(); });

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
    els.complete.innerHTML = compItems.map((c, i) =>
      `<div class="opt${i === compSel ? ' sel' : ''}" role="option" aria-selected="${i === compSel}" data-i="${i}"><code>${esc(c)}</code></div>`).join('');
    els.complete.hidden = false;
  }
  function refreshCompletions() {
    compItems = computeCompletions(els.input.value);
    compSel = compItems.length ? 0 : -1;
    renderCompletions();
  }
  function acceptCompletion(i) {
    if (i < 0 || i >= compItems.length) return;
    els.input.value = compItems[i];
    els.input.focus();
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
  function syncSend() { els.send.disabled = !els.input.value.trim(); }
  els.input.addEventListener('input', () => { autosize(); refreshCompletions(); syncSend(); });
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
    if (!text) return;
    els.input.value = '';
    autosize();
    refreshCompletions();
    syncSend();
    sendInput(text);
  }
  els.send.addEventListener('click', submit);
  els.stop.addEventListener('click', () => post('/interrupt', {}));

  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 401) { location.reload(); return null; }
      return await r.json();
    } catch { return null; }
  }
  async function sendInput(text) {
    const r = await post('/input', { text });
    if (r && r.ok === false && r.error) addMsg('system', `not sent: ${r.error}`);
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
        if (ev.noauth && !localStorage.getItem('council-noauth-dismissed')) els.banner.hidden = false;
        break;
      case 'room':
        if (String(ev.speaker).toLowerCase() === 'user' && !ev.restored) break; // we echo user input ourselves
        if (ev.stream_id && finalizeStream(ev)) break;
        addMsg(ev.speaker, ev.text);
        break;
      case 'restore':
        for (const e of ev.entries || []) addMsg(e.speaker, e.text);
        break;
      case 'stream':
        setBusy(true);
        if (ev.kind === 'text_delta') streamDelta(ev);
        else if (ev.model && AGENTS.includes(String(ev.model).toLowerCase())) {
          const m = String(ev.model).toLowerCase();
          if (!state.agents[m]) { state.agents[m] = true; renderAvatars(); }
        }
        break;
      case 'user_echo':
        addMsg('user', ev.text);
        setBusy(true);
        break;
      case 'status':
        els.stProject.textContent = ev.project ? `⌘ ${ev.project}` : '';
        els.stRoute.textContent = ev.route ? `→ ${ev.route}` : '';
        {
          const bits = [];
          if (ev.claude_pct != null) bits.push(`C ${ev.claude_pct}%`);
          if (ev.codex_pct != null) bits.push(`X ${ev.codex_pct}%`);
          els.stCtx.textContent = bits.join(' · ');
        }
        break;
      case 'projects':
        state.projects = ev;
        renderProjects();
        break;
      case 'completion_context':
        state.ctx = { global: ev.global || [], scoped: ev.scoped || {} };
        break;
      case 'ready':
        setBusy(false);
        settleCard();
        state.streams = {};
        for (const el of els.transcript.querySelectorAll('.msg.streaming')) el.classList.remove('streaming');
        break;
      case 'queue':
        state.queued = ev.pending || 0;
        els.queueNote.hidden = !state.queued;
        els.queueNote.textContent = state.queued ? `${state.queued} message${state.queued > 1 ? 's' : ''} queued` : '';
        break;
      case 'clear_panes':
        els.transcript.innerHTML = '';
        state.streams = {};
        liveCard = null;
        updateEmpty();
        break;
      case 'permission_request': permissionCard(ev); break;
      case 'permission_cleared': settleCard(); break;
      case 'choice_request': choiceCard(ev); break;
      case 'choice_cleared': settleCard(); break;
      case 'permission_timeout': settleCard('timed out — denied by default'); break;
      case 'choice_timeout': settleCard('timed out — dismissed'); break;
      case 'bridge_exit':
        addMsg('system', `agent bridge exited (code ${ev.code})${ev.error ? ` — ${ev.error}` : ''}. Restart the server to continue.`);
        setBusy(false);
        break;
      case 'exit':
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
  function setConn(cls, txt) { els.conn.className = `conn ${cls}`; els.conn.textContent = txt; }
  function resetView() {
    // reconnect replays server history from scratch: start clean
    els.transcript.innerHTML = '';
    state.streams = {};
    updateEmpty();
  }
  function onLine(data) {
    let ev; try { ev = JSON.parse(data); } catch { return; }
    if (ev.type !== 'ping') handle(ev);
  }
  function scheduleReconnect() {
    setConn('err', '○ reconnecting…');
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  }
  function connect() {
    resetView();
    let sock;
    try {
      sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    } catch { connectSSE(); return; }
    let opened = false;
    sock.onopen = () => { opened = true; retryMs = 1000; setConn('ok', '● live'); };
    sock.onmessage = e => onLine(e.data);
    sock.onerror = () => { };
    sock.onclose = () => {
      // never got open: something between us and the server blocks WS — use SSE
      if (!opened) { connectSSE(); return; }
      scheduleReconnect();
    };
  }
  function connectSSE() {
    resetView();
    const es = new EventSource('/events');
    es.onopen = () => { retryMs = 1000; setConn('ok', '● live'); };
    es.onmessage = e => onLine(e.data);
    es.onerror = () => {
      es.close();
      scheduleReconnect();
    };
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('side-open')) closeSide();
  });

  updateEmpty();
  syncSend();
  renderProjects();
  connect();

  // exposed for the DOM test harness
  window.__council = { handle, sendInput, computeCompletions, state, els };
})();
