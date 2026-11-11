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
// Loaded by background.js (importScripts), by options.html (a plain script
// tag), and as a content script ahead of drawer.js and content.js (for the
// connection's one list of modes and words, CONN_MODES). Nothing in here touches the network or the DOM, and nothing in here
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
  // A new client must never send a draft request as ordinary chat to an old
  // companion. Unknown dedicated routes fail visibly instead of summoning a
  // general-purpose artifact builder with the wrong output directory.
  function commandRoute(method, route, body) {
    if (String(method).toUpperCase() !== 'POST') return route;
    const text = route === '/thread' ? body?.msg?.text : body?.text;
    if (!/^\/draft-blog(?:\s|$)/i.test(String(text || '').trim())) return route;
    return route === '/reply' ? '/draft-blog' : route === '/thread' ? '/draft-blog/thread' : route;
  }
  function commandError(route, status) {
    return (route === '/draft-blog' || route === '/draft-blog/thread') && status === 404
      ? 'The running Discuss companion does not support this draft command. Restart or update the companion, then retry. Nothing was sent to the bots.'
      : '';
  }

  // ── is the extension in touch with the companion? ─────────────────────────
  // ONE list of modes, and ONE set of words for them, for every layer that
  // keeps or shows the connection: the worker's live socket (background.js
  // wsState), the drawer's header dot and its notices (drawer.js D.conn), and
  // what content.js relays between them. Nothing else names these states.
  //   'connecting' — not known yet, or trying again
  //   'connected'  — the companion answered
  //   'offline'    — it did not (after a couple of quick second chances, for
  //                  the drawer; the socket simply closed, for the worker)
  //   'reload'     — the extension was updated under this tab: nothing here
  //                  can reach the companion until the tab is reloaded. Final.
  const CONN_MODES = Object.freeze(['connecting', 'connected', 'offline', 'reload']);
  // …the words shown for each (the header dot), and the two notices built on them
  const CONN_WORDS = Object.freeze({
    connecting: 'connecting…', connected: 'connected', offline: 'companion offline', reload: 'reload this tab',
  });
  const CONN_NOTICE = Object.freeze({
    offline: 'Companion offline — the plugin needs its local server:',
    reload: 'Discuss was updated — reload this tab to reconnect.',
  });
  // …and every way it changes, with the modes each move may start from:
  //   retry  — connecting|connected|offline → connecting (a fresh try)
  //   reach  — connecting|connected|offline → connected
  //   fail   — connecting|connected → offline
  //   unload — any → reload
  const CONN_MOVES = Object.freeze({
    retry: ['connecting', 'connected', 'offline'],
    reach: ['connecting', 'connected', 'offline'],
    fail: ['connecting', 'connected'],
    unload: CONN_MODES,
  });
  const CONN_TO = { retry: 'connecting', reach: 'connected', fail: 'offline', unload: 'reload' };
  const canConnMove = (mode, move) => !!CONN_MOVES[move] && CONN_MOVES[move].indexOf(mode) !== -1;
  // Pure: (mode, move) → mode. An unknown move, or one from a mode it does not
  // start from, throws — callers that hear from the outside world ask
  // canConnMove first and drop the move (a late answer after a reload, say).
  function connMove(mode, move) {
    if (!CONN_MOVES[move]) throw new Error('connection: no such move ' + move);
    if (!canConnMove(mode, move)) throw new Error('connection: cannot ' + move + ' while ' + mode);
    return CONN_TO[move];
  }

  // ── how long a request to the companion may take ──────────────────────────
  // Every one-shot request has a limit; none may wait for ever. Most are a
  // read or a small write on this machine and answer in milliseconds, so 30s
  // is already a companion that is not answering. The few below do real work
  // before they answer (a recording to transcribe, a commit, an export, a
  // preview build, a search, a chat copied into the council …) and get three
  // minutes. The live event socket is not a request: it is checked by its
  // heartbeat instead (background.js SOCKET_SILENT_MS).
  const REQUEST_MS = 30000;
  const SLOW_REQUEST_MS = 180000;
  const SLOW_ROUTES = ['/transcribe', '/publish', '/export', '/suggest-preview', '/suggest-accept',
    '/suggest-accept-all', '/lasso', '/summarize', '/project-create', '/project-chat',
    '/continue-in-council', '/pdf-annotations', '/page-image', '/snapshot', '/send-review',
    '/make-artifact', '/run', '/fte-route', '/blog-page', '/blog-image', '/files', '/relay',
    '/fresh', '/delete-page', '/page-chat-new', '/page-chat-open', '/question', '/question-revise',
    '/model', '/effort', '/key-mode', '/draft-blog', '/draft-blog/thread'];
  const routeOf = p => String(p || '').split('?')[0];
  const requestLimitMs = (method, path) =>
    (SLOW_ROUTES.indexOf(routeOf(path)) !== -1 ? SLOW_REQUEST_MS : REQUEST_MS);
  // …and, when one runs out, what it was, in the reader's words: the line the
  // drawer shows says WHAT did not go through, and that it can be tried again
  const REQUEST_WHAT = {
    'POST /reply': 'your message', 'POST /thread': 'your comment', 'POST /draft-blog': 'your message',
    'POST /draft-blog/thread': 'your comment', 'POST /edit': 'your edit', 'POST /delete': 'the delete',
    'POST /interrupt': 'the stop', 'POST /resolve': 'resolving the comment', 'POST /tick': 'the tick',
    'POST /export': 'the export', 'POST /transcribe': 'the dictation', 'POST /run': 'running the code',
    'POST /publish': 'the publish', 'POST /send-review': 'sending the review', 'POST /page': 'saving this page',
    'POST /snapshot': 'saving the page text', 'POST /rename-page': 'the rename', 'POST /tag-page': 'the tag',
    'POST /delete-page': 'the delete', 'POST /model': 'the model change', 'POST /effort': 'the effort change',
    'GET /page': 'loading this page', 'GET /index': 'loading your pages', 'GET /lasso': 'the search',
  };
  function requestWhat(method, path) {
    const m = String(method || 'GET').toUpperCase();
    return REQUEST_WHAT[m + ' ' + routeOf(path)] || (m === 'GET' ? 'loading that' : 'that change');
  }
  // "Your message did not go through — the companion took too long. Try again."
  function timeoutLine(method, path) {
    const w = requestWhat(method, path);
    return w.charAt(0).toUpperCase() + w.slice(1) + ' did not go through — the companion took too long. Try again.';
  }

  // bfp:pdf is the one setting here that is not about the wire: whether a web
  // PDF is opened in Discuss's own viewer (so it can be annotated) or left to
  // the browser's. Stored the same way as the rest because it is read in the
  // same two places — the worker, which installs the redirect rule, and the
  // options page, which is where it is turned off.
  const KEYS = { base: 'bfp:companion', password: 'bfp:password', handle: 'bfp:handle',
                 pdf: 'bfp:pdf' };
  // absent means on: an extension installed before this existed should still
  // open PDFs in the viewer, because that is the feature
  const readBool = (v, dflt) => (v === undefined || v === null ? !!dflt : !!v);

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
    const fallback = { base: DEFAULT_BASE, password: '', handle: '', pdf: true };
    if (!store) return Promise.resolve(fallback);
    return new Promise(resolve => {
      try {
        store.get([KEYS.base, KEYS.password, KEYS.handle, KEYS.pdf], r => {
          const got = r || {};
          resolve({
            base: normalizeBase(got[KEYS.base]) || DEFAULT_BASE,
            password: clean(got[KEYS.password]),
            handle: sanitizeHandle(got[KEYS.handle]),
            pdf: readBool(got[KEYS.pdf], true),
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
      [KEYS.pdf]: readBool(cfg && cfg.pdf, true),
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
    commandRoute, commandError,
    CONN_MODES, CONN_WORDS, CONN_NOTICE, CONN_MOVES, connMove, canConnMove,
    REQUEST_MS, SLOW_REQUEST_MS, requestLimitMs, requestWhat, timeoutLine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPConfig = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
