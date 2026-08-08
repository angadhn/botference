// config.js — WHERE the companion is, and WHO we are to it.
//
// Round 5: the companion may be somewhere other than this machine. Three
// settings decide everything about the wire, all of them in
// chrome.storage.local and all of them editable on the options page:
//
//   bfp:companion   base url of the companion   (default http://127.0.0.1:4189)
//   bfp:password    shared password; '' = a local companion with no auth
//   bfp:handle      display name/handle this browser signs its messages with
//
// Loaded by background.js (importScripts) and by options.html (a plain script
// tag). Nothing in here touches the network or the DOM, and nothing in here
// reads chrome.* except the two explicit storage helpers at the bottom — so
// the whole file runs in node, which is where test/adapters.test.mjs unit-tests
// it (normalizeBase · wsUrlFor · authHeaders · sanitizeHandle · isLocal).
//
// The single rule the rest of the extension relies on: a password turns the
// companion into a MULTI-USER one. Then, and only then, every request carries
// `Authorization: Bearer <password>` + `x-plugin-handle: <handle>`, and the WS
// carries the same two as query params (a WebSocket cannot send headers).
// No cookies are involved in either direction, and no new host permission is
// needed for a remote https companion — the hosted companion answers the CORS
// preflight itself, which is what grants the background worker's fetch.
(function (root) {
  'use strict';

  const DEFAULT_BASE = 'http://127.0.0.1:4189';
  const KEYS = { base: 'bfp:companion', password: 'bfp:password', handle: 'bfp:handle' };

  // Control characters are stripped everywhere rather than escaped: these
  // values end up in HTTP headers and in a WS query string, and a stray \r\n
  // in a password field must never be able to write a header of its own.
  const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();

  // EXACTLY the companion's own rule (server: lowercase, [^\\w-] -> '-', <=40).
  // It has to be exact, because the name the SERVER stamps on a message is what
  // the drawer compares against to decide whether that message is the reader's
  // own: "Mira K" typed on the options page must become the same "mira-k" the
  // server stores, or the edit affordance would vanish from your own comments.
  // It also happens to make the handle header-safe (latin-1, no control
  // characters, no line breaks, nothing to inject with).
  const HANDLE_MAX = 40;
  function sanitizeHandle(raw) {
    return clean(raw).toLowerCase().replace(/[^\w-]/g, '-').slice(0, HANDLE_MAX);
  }

  const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];

  // '  companion.example.com/plugin/  ' → 'https://companion.example.com/plugin'
  // A bare host:port that IS this machine keeps http (nobody runs TLS on
  // 127.0.0.1); anything else is assumed to be a real host and gets https,
  // because a password typed into a cleartext field is the one mistake this
  // function can prevent. Junk (a file: url, an empty box) comes back '' and
  // callers fall back to the default.
  function normalizeBase(raw) {
    let s = clean(raw);
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) {
      const host = s.split('/')[0].split(':')[0].toLowerCase();
      s = (LOCAL_HOSTS.indexOf(host) !== -1 ? 'http://' : 'https://') + s;
    }
    let u;
    try { u = new URL(s); } catch { return ''; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname) return '';
    // query and hash are not part of a base; a trailing slash is not either,
    // because every path in the API already starts with one
    const path = u.pathname.replace(/\/+$/, '');
    return u.protocol + '//' + u.host + path;
  }

  function isLocal(base) {
    const b = normalizeBase(base) || DEFAULT_BASE;
    let u;
    try { u = new URL(b); } catch { return false; }
    return LOCAL_HOSTS.indexOf(u.hostname.toLowerCase()) !== -1;
  }

  // http→ws, https→wss, same host, same path prefix, `/ws` on the end. The
  // credentials ride as query params because the WebSocket constructor cannot
  // set headers — the same two values the fetches send as headers.
  function wsUrlFor(base, password, handle) {
    const b = normalizeBase(base) || DEFAULT_BASE;
    let u;
    try { u = new URL(b + '/ws'); } catch { return ''; }
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const pw = clean(password);
    if (pw) {
      u.searchParams.set('auth', pw);
      const h = sanitizeHandle(handle);
      if (h) u.searchParams.set('handle', h);
    }
    return u.toString();
  }

  // No password ⇒ a local single-user companion that wants no headers at all.
  function authHeaders(password, handle) {
    const pw = clean(password);
    if (!pw) return {};
    const out = { Authorization: 'Bearer ' + pw };
    const h = sanitizeHandle(handle);
    if (h) out['x-plugin-handle'] = h;
    return out;
  }

  const httpUrl = (base, path) =>
    (normalizeBase(base) || DEFAULT_BASE) + String(path == null ? '' : path);

  // ---- storage (the only chrome.* in this file) ---------------------------
  function readConfig(area) {
    const store = area || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
    const fallback = { base: DEFAULT_BASE, password: '', handle: '' };
    if (!store) return Promise.resolve(fallback);
    return new Promise(resolve => {
      try {
        store.get([KEYS.base, KEYS.password, KEYS.handle], r => {
          const got = r || {};
          resolve({
            base: normalizeBase(got[KEYS.base]) || DEFAULT_BASE,
            password: clean(got[KEYS.password]),
            handle: sanitizeHandle(got[KEYS.handle]),
          });
        });
      } catch { resolve(fallback); }
    });
  }

  function writeConfig(cfg, area) {
    const store = area || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
    const out = {
      [KEYS.base]: normalizeBase(cfg && cfg.base) || DEFAULT_BASE,
      [KEYS.password]: clean(cfg && cfg.password),
      [KEYS.handle]: sanitizeHandle(cfg && cfg.handle),
    };
    if (!store) return Promise.resolve(out);
    return new Promise(resolve => {
      try { store.set(out, () => resolve(out)); } catch { resolve(out); }
    });
  }

  const api = {
    DEFAULT_BASE, KEYS, HANDLE_MAX,
    normalizeBase, wsUrlFor, authHeaders, sanitizeHandle, isLocal, httpUrl,
    readConfig, writeConfig,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPConfig = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
