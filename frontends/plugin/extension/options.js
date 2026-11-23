// options.js — the settings page's wiring (see options.html).
//
// Two jobs: read/write the three settings through config.js, and answer
// "does this actually work?" with a real GET /health against whatever is in
// the boxes RIGHT NOW — not against what was last saved, because the first
// thing anybody does with a new password is test it before committing to it.
//
// The verdict-building is pure (`healthVerdict`, `describeSaved`) and exported
// for test/adapters.test.mjs; the DOM half only runs when there is a document.
(function (root) {
  'use strict';

  const CFG = (typeof module !== 'undefined' && module.exports)
    ? require('./config.js')
    : root.BFPConfig;

  // What a /health attempt MEANS, in the words the page shows. Split out from
  // the fetch so every branch is testable without a network. The connection
  // itself is named the way every other layer names it — config.js
  // CONN_MODES and CONN_WORDS, one list and one set of words — so this page
  // and the drawer's header dot never describe the same companion two ways.
  // `mode` is which of those modes the attempt found; what follows the word
  // is only this page's detail:
  //   {ok:false}              → offline: unreachable / wrong address
  //   401                     → connected, but the password is the problem
  //   403                     → connected, signed in, not the owner (fine)
  //   another status          → connected, but it said no
  //   200 + bridge/queue      → connected, and the whole truth in one line
  const W = CFG.CONN_WORDS;
  function healthVerdict(r) {
    // Cloudflare Access answered instead of the companion: not an outage, not a wrong password: this browser is not signed in
    if (r && r.signin) {
      return { mode: 'signin', cls: 'err', text: W.signin + ' — use “Sign in” to open the companion, then test again' };
    }
    if (!r || r.ok === false) {
      if (r && r.status === 401) {
        return { mode: 'connected', cls: 'err', text: W.connected + ' — but the password was rejected' };
      }
      if (r && r.status === 403) {
        return { mode: 'connected', cls: 'ok', text: W.connected + ' — this companion knows you, but you are not its owner' };
      }
      if (r && r.status) {
        return { mode: 'connected', cls: 'err', text: W.connected + ' — but it answered HTTP ' + r.status +
          ((r.error && r.error !== 'HTTP ' + r.status) ? ' — ' + r.error : '') };
      }
      return { mode: 'offline', cls: 'err',
        text: W.offline + ' — ' + ((r && r.error) || 'nothing answered at that address. Is it running?') };
    }
    const d = r.data || {};
    const bridge = d.bridge ? 'agents ' + d.bridge : '';
    const queue = d.queue ? 'queue ' + d.queue : '';
    const who = d.handle || d.author || d.you || '';
    const bits = [W.connected, bridge, queue, who ? 'you are “' + who + '”' : ''].filter(Boolean);
    return { mode: 'connected', cls: 'ok', text: bits.join(' · ') };
  }

  // ---- local PDFs: the one toggle that is not ours -----------------------
  // "Allow access to file URLs" is Chrome's own per-extension switch and no
  // extension can set it, ask for it in a prompt, or even see it change. What
  // it CAN do is say plainly that it is off and exactly where the switch is —
  // one sentence, the same one the viewer shows, because a reader who meets
  // this twice should meet the same words both times.
  //
  // It is the same switch a PROJECT ARTIFACT page needs — the HTML your own
  // council wrote into projects/<id>/ — and the STATE line says so. The help
  // sentence itself stays word-for-word the viewer's: it is shown where a
  // local PDF failed to open, and that is what it should talk about there.
  const FILE_ACCESS_HELP =
    'Local PDFs need “Allow access to file URLs” — brave://extensions → ' +
    'Botference Discuss → Details → toggle it on.';
  const FILE_ACCESS_ALSO = ' It is the same switch the pages your own council '
    + 'writes need (projects/<id>/….html).';
  function fileAccessLine(allowed) {
    if (allowed === true) {
      return { cls: 'on', text: 'On — a PDF on your disk opens in Discuss and stays '
        + 'the same page if you move or rename it, and a page your council wrote opens '
        + 'in the project that wrote it.' };
    }
    if (allowed === false) return { cls: 'off', text: FILE_ACCESS_HELP + FILE_ACCESS_ALSO };
    return { cls: '', text: 'This browser cannot say whether file access is on. '
      + FILE_ACCESS_HELP + FILE_ACCESS_ALSO };
  }

  // The line under the buttons after a save: what was actually stored, which
  // is not always what was typed (normalizeBase rewrites, sanitizeHandle trims).
  function describeSaved(cfg) {
    const base = CFG.normalizeBase(cfg && cfg.base) || CFG.DEFAULT_BASE;
    const pw = String((cfg && cfg.password) || '');
    const handle = CFG.sanitizeHandle(cfg && cfg.handle);
    const how = pw
      ? (handle ? 'as “' + handle + '”, with a password' : 'with a password, no name set')
      : 'local, no password';
    return 'saved → ' + base + ' · ' + how;
  }

  const api = { healthVerdict, describeSaved, fileAccessLine, FILE_ACCESS_HELP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPOptions = api;

  // ---- the page ----------------------------------------------------------
  if (typeof document === 'undefined' || !CFG) return;

  const el = id => document.getElementById(id);
  // Every setting the page holds, always all of them: writeConfig rewrites the
  // whole block, so a Save that left the PDF checkbox out would quietly turn
  // the viewer back on for someone who had turned it off.
  const fields = () => ({
    base: el('base').value,
    password: el('password').value,
    handle: el('handle').value,
    pdf: el('pdf').checked,
    // the reader the feed icon opens (config.js): kept as it was by every save that is not about it
    reader_url: readerNow.url,
    reader_onboarding: readerNow.onboarding,
  });
  let readerNow = { url: '', onboarding: 'unasked' };
  function say(v) {
    const s = el('status');
    s.className = (v && v.cls) || '';
    s.textContent = (v && v.text) || '';
  }

  // The test hits the companion straight from this page: an extension page's
  // fetch has the same host permission the worker does, and a hosted companion
  // answers the CORS preflight, so no proxy hop is needed — and testing the
  // UNSAVED values is the whole point.
  async function health(cfg) {
    // (a password typed for a companion that says "access" is not sent to it: the mode is asked first, without it)
    const { answer } = await paintAuthMode(CFG.normalizeBase(cfg.base) || CFG.DEFAULT_BASE);
    const headers = CFG.authHeaders(CFG.passwordToSend({ base: cfg.base, password: cfg.password }, answer === 'password' ? 'password' : answer), cfg.handle);
    let res;
    try {
      res = await fetch(CFG.httpUrl(cfg.base, '/health'),
        { cache: 'no-store', ...CFG.requestInit(cfg.base), headers: Object.keys(headers).length ? headers : undefined });
    } catch (e) {
      return { ok: false, error: 'could not reach ' + (CFG.normalizeBase(cfg.base) || CFG.DEFAULT_BASE) +
        ' (' + ((e && e.message) || e) + ')' };
    }
    let data = null;
    const text = await res.text().catch(() => '');
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    const kind = CFG.replyKind({ type: res.type, status: res.status, contentType: res.headers && res.headers.get('content-type') }, text);
    if (kind === 'signin') return { ok: false, signin: true, status: res.status, error: W.signin };
    if (!res.ok) return { ok: false, status: res.status, data, error: (data && data.error) || '' };
    return { ok: true, status: res.status, data };
  }

  // How this companion signs people in, from its one information-free route (GET /auth-mode answers the mode's NAME and nothing
  // else; Cloudflare's own sign-in answer means Access is in front). Access: there is no password to type, so the box is hidden.
  async function paintAuthMode(base) {
    let mode = '';
    let answer = 'unclear';
    try {
      const res = await fetch(CFG.httpUrl(base, '/auth-mode'), { cache: 'no-store', ...CFG.requestInit(base) });
      const text = await res.text().catch(() => '');
      const r = { type: res.type, status: res.status, contentType: res.headers && res.headers.get('content-type') };
      mode = CFG.authModeOf(r, text);                // a hint for what to show (a sign-in page counts as "access" here)
      answer = CFG.companionAnswer(r, text);          // what the companion itself said: the only thing that is remembered
    } catch { mode = ''; }
    const box = el('password-field');
    if (box) box.hidden = !CFG.showPasswordField(mode);
    // an Access companion is remembered, so the saved password is withheld from it (config.js passwordFor); the person may clear it
    if (answer === 'access' && !CFG.isLocal(base)) await CFG.rememberAccess(base);
    const stale = el('clear-password');
    if (stale) stale.hidden = !(mode === 'access' && el('password').value);
    const note = el('access-note');
    if (note) {
      note.hidden = mode !== 'access' && mode !== 'either';
      note.textContent = mode === 'either'
        ? 'This companion accepts Cloudflare Access sign-in or the password. Signing in with Access is the way forward: the password is a temporary way in.'
        : 'This companion signs you in with Cloudflare Access (an emailed code). There is no password: sign in once in a tab and this extension uses that sign-in.';
    }
    const so = el('signin-open');
    if (so) so.hidden = mode !== 'access' && mode !== 'either';
    return { mode, answer };
  }

  async function load() {
    const cfg = await CFG.readConfig();
    paintAuthMode(cfg.base);
    el('base').value = cfg.base;
    el('password').value = cfg.password;
    el('handle').value = cfg.handle;
    el('pdf').checked = cfg.pdf !== false;
    readerNow = { url: cfg.reader_url, onboarding: cfg.reader_onboarding };
    const rb = el('reader-url');
    if (rb) rb.value = cfg.reader_url;
    const target = CFG.readerTarget(cfg);
    const fl = el('following-link');
    if (fl) { fl.href = target.url; fl.textContent = target.mode === 'external' ? 'Open your reader' : 'Open the Hub'; }
  }

  // Asked here on every visit, and the answer written down for the service
  // worker — which cannot ask (chrome.extension does not exist in a worker)
  // and needs to know whether reopening a local PDF in our viewer could work.
  function paintFileAccess() {
    const line = allowed => {
      const v = fileAccessLine(allowed);
      const s = el('filehint');
      if (!s) return;
      s.className = 'hint ' + v.cls;
      s.textContent = v.text;
      if (allowed != null) {
        try { chrome.storage.local.set({ 'bfp:file-access': !!allowed }); } catch { /* a hint, not a state */ }
      }
    };
    try {
      if (chrome && chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(a => line(!!a));
        return;
      }
    } catch { /* fall through */ }
    line(null);
  }

  // No Save button on this one: a checkbox that needs confirming is a checkbox
  // people leave wrong. The worker is watching storage and installs (or
  // withdraws) the redirect rule the moment this lands.
  el('pdf').addEventListener('change', async () => {
    const on = el('pdf').checked;
    await CFG.writeConfig(fields());
    const s = el('pdfstatus');
    s.className = 'ok';
    s.textContent = on
      ? 'on — PDFs now open in Discuss'
      : 'off — PDFs go to the browser’s own viewer';
  });

  el('save').addEventListener('click', async () => {
    // the reader box first: an address that cannot be opened stops the save, and says so
    const rb = el('reader-url');
    if (rb) {
      const pick = CFG.readerChoiceFrom(rb.value, readerNow.onboarding);
      if (!pick.ok) { say({ cls: 'err', text: pick.error }); return; }
      readerNow = { url: pick.reader_url, onboarding: pick.reader_onboarding };
    }
    const cfg = fields();
    el('save').disabled = true;
    const stored = await CFG.writeConfig(cfg);
    await CFG.forgetAccess();   // saved by hand: what the companion uses is asked afresh (load -> paintAuthMode)
    await load();
    el('save').disabled = false;
    say({ cls: 'ok', text: describeSaved({ base: stored[CFG.KEYS.base],
      password: stored[CFG.KEYS.password], handle: stored[CFG.KEYS.handle] }) });
  });

  el('test').addEventListener('click', async () => {
    el('test').disabled = true;
    say({ cls: '', text: CFG.CONN_WORDS.connecting });
    const now = fields();
    say(healthVerdict(await health(now)));
    el('test').disabled = false;
  });
  const clearPw = el('clear-password');
  if (clearPw) clearPw.addEventListener('click', async e => {
    if (e.isTrusted !== true) return;
    el('password').value = '';
    await CFG.writeConfig(fields());
    clearPw.hidden = true;
    say({ cls: 'ok', text: 'the saved password is cleared' });
  });
  // the button opens the companion's own address (Cloudflare asks for the emailed code there); a click made by a page cannot press it
  const so = el('signin-open');
  if (so) so.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    try { window.open(CFG.httpUrl(CFG.normalizeBase(el('base').value) || CFG.DEFAULT_BASE, '/'), '_blank', 'noopener'); } catch { /* a popup blocker */ }
  });
  el('base').addEventListener('change', () => { paintAuthMode(CFG.normalizeBase(el('base').value) || CFG.DEFAULT_BASE); });

  // ---- API keys ----------------------------------------------------------
  // Write-only by design: this page can set a key and remove one, and the only
  // thing it can ever read back is "set" or "unset". So the input boxes are
  // never populated — there is nothing to populate them WITH — and the badge
  // beside each label is the whole state.
  const AGENTS = ['claude', 'codex'];
  function sayKeys(v) {
    const s = el('keystatus');
    s.className = (v && v.cls) || '';
    s.textContent = (v && v.text) || '';
  }
  function paintKeys(st) {
    for (const a of AGENTS) {
      const badge = el('st-' + a);
      const set = st && st[a] === 'set';
      badge.textContent = st ? (set ? 'set' : 'unset') : '—';
      badge.classList.toggle('set', !!set);
      el('rm-' + a).disabled = !set;
    }
  }
  // Keys are refused over a tunnel, so this only ever talks to the companion
  // as configured — a 403 here is the feature working, and says so.
  async function keysApi(method, path, body) {
    const cfg = await CFG.readConfig();
    // the mode is asked first, here too: a password goes only to a companion that has said it uses one (or to this machine's)
    const asked = CFG.isLocal(cfg.base) ? { answer: 'password' } : await paintAuthMode(CFG.normalizeBase(cfg.base) || CFG.DEFAULT_BASE);
    const headers = CFG.authHeaders(CFG.passwordToSend(cfg, asked.answer), cfg.handle);
    const init = { method, cache: 'no-store', ...CFG.requestInit(cfg.base) };
    if (body) {
      init.body = JSON.stringify(body);
      init.headers = { ...headers, 'content-type': 'application/json' };
    } else if (Object.keys(headers).length) {
      init.headers = headers;
    }
    let res;
    try {
      res = await fetch(CFG.httpUrl(cfg.base, path), init);
    } catch (e) {
      return { ok: false, error: 'could not reach the companion (' + ((e && e.message) || e) + ')' };
    }
    let data = null;
    const text = await res.text().catch(() => '');
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (CFG.replyKind({ type: res.type, status: res.status, contentType: res.headers && res.headers.get('content-type') }, text) === 'signin') {
      return { ok: false, signin: true, error: W.signin + ' — use “Sign in” above' };
    }
    if (!res.ok) {
      // a companion from before this feature has no such route at all, which
      // is worth saying plainly rather than reporting as "not found"
      const why = res.status === 404
        ? 'this companion is too old to store API keys — restart it from this checkout'
        : (data && data.error) || ('HTTP ' + res.status);
      return { ok: false, status: res.status, error: why };
    }
    return { ok: true, data };
  }
  async function loadKeys() {
    const r = await keysApi('GET', '/keys');
    if (!r.ok) {
      paintKeys(null);
      // 403 is this working as intended: keys are refused over a tunnel, and
      // a browser pointed at a hosted companion is exactly that case
      const remote = r.status === 403;
      sayKeys({ cls: remote ? '' : 'err',
        text: remote ? 'keys are set on the companion\'s own machine, not from here' : r.error });
      for (const a of AGENTS) {
        el('save-' + a).disabled = remote;
        el('key-' + a).disabled = remote;
      }
      return;
    }
    paintKeys(r.data);
    sayKeys({ cls: '', text: '' });
  }
  for (const a of AGENTS) {
    el('save-' + a).addEventListener('click', async () => {
      const input = el('key-' + a);
      const key = input.value.trim();
      if (!key) { sayKeys({ cls: 'err', text: 'paste a key first' }); return; }
      el('save-' + a).disabled = true;
      const r = await keysApi('POST', '/keys', { agent: a, key });
      el('save-' + a).disabled = false;
      // whatever happens, the key does not linger in the DOM
      input.value = '';
      if (!r.ok) { sayKeys({ cls: 'err', text: r.error }); return; }
      paintKeys(r.data);
      sayKeys({ cls: 'ok', text: a + ' key saved' +
        (r.data.applies === 'next-restart' ? ' — applies when the current turn finishes' : '') });
    });
    el('rm-' + a).addEventListener('click', async () => {
      el('rm-' + a).disabled = true;
      const r = await keysApi('POST', '/keys/remove', { agent: a });
      if (!r.ok) { el('rm-' + a).disabled = false; sayKeys({ cls: 'err', text: r.error }); return; }
      paintKeys(r.data);
      sayKeys({ cls: 'ok', text: r.data.removed
        ? a + ' key removed — back to the subscription'
        : 'there was no ' + a + ' key to remove' });
    });
  }

  // ---- Profiles ----------------------------------------------------------
  // Read from the companion, which reads each bot's signed-in email from files
  // on its own machine; no token ever reaches this page. Switching is
  // machine-wide and, like keys, only from that machine.
  function sayProfiles(v) {
    const s = el('profilestatus');
    s.className = (v && v.cls) || '';
    s.textContent = (v && v.text) || '';
  }
  function accountCell(a) {
    const td = document.createElement('td');
    td.className = 'who' + (a && a.signed_in ? '' : ' none');
    td.textContent = !a || !a.signed_in ? 'not signed in'
      : (a.email || (a.method === 'api-key' ? 'API key' : 'signed in'));
    return td;
  }
  function paintProfiles(data) {
    const body = el('profiles-body');
    body.textContent = '';
    const rows = (data && data.profiles) || [];
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4; td.className = 'hint';
      td.textContent = 'No profiles on this machine yet. `botference profile init <name>` adopts the current accounts as the first one.';
      tr.appendChild(td); body.appendChild(tr);
      return;
    }
    for (const p of rows) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = p.name;
      if (p.active) {
        const b = document.createElement('span');
        b.className = 'badge set'; b.textContent = 'active';
        name.appendChild(document.createTextNode(' ')); name.appendChild(b);
      }
      tr.appendChild(name);
      tr.appendChild(accountCell(p.claude));
      tr.appendChild(accountCell(p.codex));
      const act = document.createElement('td');
      if (!p.active) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = 'Switch';
        btn.addEventListener('click', () => switchProfile(p.name, btn));
        act.appendChild(btn);
      }
      tr.appendChild(act);
      body.appendChild(tr);
    }
  }
  async function loadProfiles() {
    const r = await keysApi('GET', '/profiles');
    if (!r.ok) {
      paintProfiles(null);
      const remote = r.status === 403;
      sayProfiles({ cls: remote ? '' : 'err',
        text: remote ? 'profiles are shown and switched on the companion\'s own machine, not from here'
          : (r.status === 404 ? 'this companion is too old for profiles — restart it from this checkout' : r.error) });
      return;
    }
    paintProfiles(r.data);
    sayProfiles({ cls: '', text: '' });
  }
  async function switchProfile(name, btn) {
    btn.disabled = true;
    const r = await keysApi('POST', '/profile', { name });
    if (!r.ok) { btn.disabled = false; sayProfiles({ cls: 'err', text: r.error }); return; }
    sayProfiles({ cls: 'ok', text: 'Switched to ' + name + '. The companion and council are restarting under it…' });
    // the companion comes back in a few seconds; then show the new state
    setTimeout(loadProfiles, 4000);
  }

  // ---- "the drawer sent me here" ----------------------------------------
  // The drawer's billing switch cannot take a key — it renders inside whatever
  // page you are reading — so it asks for this page instead and leaves the name
  // of the field it meant in chrome.storage.local. One shot: the hint is spent
  // on arrival whether or not a key ends up being typed, because a stale hint
  // would grab the focus of an options page opened for something else entirely.
  const FOCUS_KEY = 'bfp:focus-key';
  function focusRequestedKey() {
    const store = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
    if (!store) return;
    try {
      store.get([FOCUS_KEY], r => {
        const agent = r && r[FOCUS_KEY];
        if (AGENTS.indexOf(agent) === -1) return;
        try { store.remove(FOCUS_KEY); } catch { /* it was only a hint */ }
        const input = el('key-' + agent);
        const field = input && input.closest('.field');
        if (!field) return;
        // keys cannot be set from a browser pointed at a remote companion, and
        // loadKeys has already said so — pointing at a dead field would only
        // argue with it
        if (input.disabled) return;
        field.classList.add('called');
        if (field.scrollIntoView) field.scrollIntoView({ block: 'center' });
        input.focus();
        sayKeys({ cls: '', text: 'paste your ' + agent + ' key here — the drawer sent you' });
      });
    } catch { /* no storage: the page still works, it just does not point */ }
  }

  // ⌘/Ctrl+Enter anywhere on the page saves, like every other composer here
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;   // the input method's key, not ours
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el('save').click(); }
  });

  load();
  paintFileAccess();
  // the hint is read only once the key status is on screen: loadKeys clears the
  // status line when it succeeds, and would wipe the pointer with it
  loadKeys().then(focusRequestedKey);
  loadProfiles();
})(typeof window !== 'undefined' ? window : globalThis);
