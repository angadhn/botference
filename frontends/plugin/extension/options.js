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

  // ⌘/Ctrl+Enter anywhere on the page saves, like every other composer here
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el('save').click(); }
  });

  load();
})(typeof window !== 'undefined' ? window : globalThis);
