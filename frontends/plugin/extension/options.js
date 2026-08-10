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
  // the fetch so every branch is testable without a network:
  //   {ok:false}              → unreachable / wrong address
  //   401                     → the password is the problem, and only that
  //   403                     → reached it, signed in, not the owner (fine)
  //   200 + bridge/queue      → the whole truth in one line
  function healthVerdict(r) {
    if (!r || r.ok === false) {
      if (r && r.status === 401) {
        return { cls: 'err', text: 'reached the companion, but the password was rejected' };
      }
      if (r && r.status === 403) {
        return { cls: 'ok', text: 'connected — this companion knows you, but you are not its owner' };
      }
      if (r && r.status) {
        return { cls: 'err', text: 'the companion answered HTTP ' + r.status +
          ((r.error && r.error !== 'HTTP ' + r.status) ? ' — ' + r.error : '') };
      }
      return { cls: 'err', text: (r && r.error) || 'no answer — is the companion running at that address?' };
    }
    const d = r.data || {};
    const bridge = d.bridge ? 'agents ' + d.bridge : '';
    const queue = d.queue ? 'queue ' + d.queue : '';
    const who = d.handle || d.author || d.you || '';
    const bits = ['connected', bridge, queue, who ? 'you are “' + who + '”' : ''].filter(Boolean);
    return { cls: 'ok', text: bits.join(' · ') };
  }

  // ---- local PDFs: the one toggle that is not ours -----------------------
  // "Allow access to file URLs" is Chrome's own per-extension switch and no
  // extension can set it, ask for it in a prompt, or even see it change. What
  // it CAN do is say plainly that it is off and exactly where the switch is —
  // one sentence, the same one the viewer shows, because a reader who meets
  // this twice should meet the same words both times.
  const FILE_ACCESS_HELP =
    'Local PDFs need “Allow access to file URLs” — brave://extensions → ' +
    'Botference Discuss → Details → toggle it on.';
  function fileAccessLine(allowed) {
    if (allowed === true) {
      return { cls: 'on', text: 'On — a PDF on your disk opens in Discuss, ' +
        'and stays the same page if you move or rename it.' };
    }
    if (allowed === false) return { cls: 'off', text: FILE_ACCESS_HELP };
    return { cls: '', text: 'This browser cannot say whether file access is on. ' + FILE_ACCESS_HELP };
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
  });
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
    const headers = CFG.authHeaders(cfg.password, cfg.handle);
    let res;
    try {
      res = await fetch(CFG.httpUrl(cfg.base, '/health'),
        { cache: 'no-store', headers: Object.keys(headers).length ? headers : undefined });
    } catch (e) {
      return { ok: false, error: 'could not reach ' + (CFG.normalizeBase(cfg.base) || CFG.DEFAULT_BASE) +
        ' (' + ((e && e.message) || e) + ')' };
    }
    let data = null;
    const text = await res.text().catch(() => '');
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) return { ok: false, status: res.status, data, error: (data && data.error) || '' };
    return { ok: true, status: res.status, data };
  }

  async function load() {
    const cfg = await CFG.readConfig();
    el('base').value = cfg.base;
    el('password').value = cfg.password;
    el('handle').value = cfg.handle;
    el('pdf').checked = cfg.pdf !== false;
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
    const cfg = fields();
    el('save').disabled = true;
    const stored = await CFG.writeConfig(cfg);
    await load();
    el('save').disabled = false;
    say({ cls: 'ok', text: describeSaved({ base: stored[CFG.KEYS.base],
      password: stored[CFG.KEYS.password], handle: stored[CFG.KEYS.handle] }) });
  });

  el('test').addEventListener('click', async () => {
    el('test').disabled = true;
    say({ cls: '', text: 'testing…' });
    say(healthVerdict(await health(fields())));
    el('test').disabled = false;
  });

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
    const headers = CFG.authHeaders(cfg.password, cfg.handle);
    const init = { method, cache: 'no-store' };
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
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el('save').click(); }
  });

  load();
  paintFileAccess();
  // the hint is read only once the key status is on screen: loadKeys clears the
  // status line when it succeeds, and would wipe the pointer with it
  loadKeys().then(focusRequestedKey);
})(typeof window !== 'undefined' ? window : globalThis);
