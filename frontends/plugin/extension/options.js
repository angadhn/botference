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

  const api = { healthVerdict, describeSaved };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPOptions = api;

  // ---- the page ----------------------------------------------------------
  if (typeof document === 'undefined' || !CFG) return;

  const el = id => document.getElementById(id);
  const fields = () => ({
    base: el('base').value,
    password: el('password').value,
    handle: el('handle').value,
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
  }

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

  // ⌘/Ctrl+Enter anywhere on the page saves, like every other composer here
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el('save').click(); }
  });

  load();
  loadKeys();
})(typeof window !== 'undefined' ? window : globalThis);
