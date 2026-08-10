// background.js — MV3 service worker for the Botference Web Annotator.
//
// Content scripts never touch the COMPANION's network. A local companion
// serves no CORS headers, so every fetch to it and the WS both live here,
// where host_permissions grant cross-origin access. (The one exception is a
// site adapter reading its own origin with the user's session — see
// adapters.js — and even that falls back to {t:'gdocs-export'} below.)
// This worker owns:
//
//   • the WebSocket to the companion's /ws (exponential backoff reconnect,
//     chrome.alarms keepalive so an idle worker still reconnects)
//   • the /index cache — the "which pages have annotations" list a content
//     script consults to decide whether to wake up at all
//   • all HTTP to the companion, proxied for content scripts
//   • rebroadcast of chat/page events to the tabs whose normUrl matches
//   • the toolbar badge = thread count for the active tab's page
//
// ─────────────────────────────────────────────────────────────────────────
// MESSAGE CONTRACT  (content script ⇄ background)
//
// content → background   (chrome.runtime.sendMessage, all replies async)
//
//   every message also carries {page_url} — the sender's own location, which
//   re-registers the tab in the routing table. A worker respawn empties that
//   table, and a tab it has forgotten receives nothing at all.
//
//   {t:'hello',  url}                 register this tab's page + wake check
//        → {ok:true, known:bool,      known = this normUrl appears in /index
//           connected:bool,           WS currently open?
//           threads:N|0,              cached thread count for this page
//           index:{…}}
//   {t:'get-index'}
//        → {ok:true, index:{…}, connected:bool}
//   {t:'api', method:'GET'|'POST', path:'/page?url=…', body?:{…}}
//        → {ok:true, status:200, data:{…}}          companion answered
//        → {ok:false, error:'…', status?:N, data?:…} transport or 4xx/5xx
//   {t:'gdocs-export', url, want?}    FALLBACK transport for the Google Docs
//                                     adapter's export — the plain text, or
//                                     (want:'bytes', format=docx) the same
//                                     document as a zip, which is the only
//                                     export that carries the doc's own
//                                     comment threads. The content
//                                     script fetches it itself first (with
//                                     credentials:'same-origin' — adapters.js
//                                     explains why that mode and not
//                                     'include'); this exists for a page whose
//                                     CSP blocks the request outright, since a
//                                     content script's fetch rides the PAGE's
//                                     connect-src in Chromium.
//                                     `url` is NOT a general fetch target: it
//                                     is validated to https + host exactly
//                                     docs.google.com + the document export
//                                     route, format=txt|docx, and nothing else
//                                     is ever requested. This is not a proxy.
//        → {ok:true, status:200, contentType:'…', text:'…'}
//        → {ok:true, status:200, contentType:'…', b64:'…'}   (want:'bytes')
//        → {ok:false, status?:N, error:'…', peek?:'…'}
//   {t:'pdf-bypass', url}            pdf/viewer.js asking for ONE navigation to
//                                    this exact PDF to skip the redirect that
//                                    put the reader in our viewer ("open it in
//                                    the browser instead"). A dynamic `allow`
//                                    rule at a higher priority, scoped to that
//                                    url, withdrawn after a minute.
//        → {ok:true, bypassed:bool}
//   {t:'identity'}                    who this browser is to the companion, as
//                                     the COMPANION sees it (GET /whoami, then
//                                     /health, then the configured handle).
//                                     Drives the drawer's "is this MY message"
//                                     test and the composer's author colour.
//        → {ok:true, handle:'…'|'', owner:'…', is_owner:bool, hosted:bool,
//           base:'…', remote:bool, auth:bool}
//                                     `is_owner` is the standing, not the name:
//                                     it gates the pages list's rename and tag
//                                     controls (both owner-only routes)
//   {t:'badge', count:N}              set this tab's badge (N=0 clears it)
//        → {ok:true}
//   {t:'reconnect'}                   user-visible "retry" affordance
//        → {ok:true}
//   {t:'open-page', url}              a row in the drawer's pages list was
//                                     clicked: focus the tab already showing
//                                     that normUrl, else open a new one. Also
//                                     arms a one-shot
//                                     `bfp-autoopen:<normUrl>` flag in
//                                     chrome.storage.local so the drawer opens
//                                     itself on arrival (content.js consumes
//                                     and deletes it on load).
//        → {ok:true, focused:true, tabId:N}   an existing tab was raised
//        → {ok:true, created:true, tabId:N}   a new tab was opened
//   {t:'open-options', agent?}       the drawer's billing switch (or its "API
//                                    keys…" link) asking for the extension's
//                                    OWN options page — the only place an API
//                                    key is ever typed, because the drawer
//                                    renders inside whatever page you are
//                                    reading and its DOM is that page's.
//                                    `agent` ('claude'|'codex') arms a one-shot
//                                    `bfp:focus-key` hint in
//                                    chrome.storage.local; options.js focuses
//                                    that key field and deletes the hint.
//        → {ok:true, focus:'claude'|'codex'|''}
//
// background → content   (chrome.tabs.sendMessage to matching tabs only)
//
//   {t:'ws',   ev:{…}}                a companion event, verbatim, as
//                                     specified in SPEC.md's event stream
//                                     (page / chat / bridge / hello / ping)
//   {t:'conn', connected:bool,        WS opened or dropped. `resumed` marks a
//              resumed?:bool}         socket that has just (re)opened: nobody
//                                     can say what was missed while it was
//                                     down, so the drawer refetches its page
//   {t:'whereami'}                    a freshly started worker asking an
//                                     already-open tab which page it is on
//        → {ok:true, url:'…'}         (no content script there: the send throws)
//
// content ⇄ background   (chrome.runtime.connect, port name 'bfp')
//
//   A long-lived port per tab. The content script posts {t:'ping', url} on it
//   and gets {t:'pong', connected} back; the worker registers the tab from
//   that url and delivers {t:'ws'}/{t:'conn'} through the port when it is
//   there. The point is the DISCONNECT: when Chrome retires the worker the
//   port dies, and that is the content script's cue to reconnect (which starts
//   a new worker) and resync the page.
//   {t:'toggle'}                      the toolbar action was clicked on this
//                                     tab — activate (or toggle) the drawer
//   {t:'autoopen'}                    open-page raised a tab that was ALREADY
//                                     loaded, so no page load will read the
//                                     storage flag — open the drawer now
//
// Fire-and-forget in both directions; nothing here is request/response beyond
// the sendResponse callbacks listed above.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

// config.js is a plain classic script (window/self-global, no imports) exactly
// so this worker and the options page can share it verbatim.
importScripts('config.js', 'pdfrules.js');
const CFG = self.BFPConfig;
// the web-PDF decisions, pure and node-tested (test/pdfrules.test.mjs)
const PR = self.BFPPdfRules;
const KEEPALIVE = 'bfp-keepalive';

// ---- where the companion is, and who we are to it ------------------------
// Round 5: the companion may be remote and password-protected. Nothing else in
// this file knows that — it asks CONF for a url and CFG for the headers. A
// remote https companion needs no new host permission: it answers the CORS
// preflight itself, and that is what grants this fetch.
let CONF = { base: CFG.DEFAULT_BASE, password: '', handle: '' };
let identityCache = null;      // {handle, base} once /health has been asked

// Every request waits for the first storage read — a fetch fired against the
// default while a remote companion is configured would look like "companion
// offline" for no reason.
let configReady = loadConfig();
async function loadConfig() {
  CONF = await CFG.readConfig();
  return CONF;
}

// The options page writes straight to chrome.storage.local, so this is the
// whole "apply the new settings" path: re-read, drop what the old companion
// told us, and reconnect the socket to the new address.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.values(CFG.KEYS);
  if (!Object.keys(changes).some(k => keys.indexOf(k) !== -1)) return;
  configReady = (async () => {
    const before = CONF;
    CONF = await CFG.readConfig();
    // the PDF switch is not about the wire, so it is applied on its own and
    // never drags the socket down with it
    if (before.pdf !== CONF.pdf) applyPdfRules(CONF.pdf !== false);
    if (before.base === CONF.base && before.password === CONF.password &&
        before.handle === CONF.handle) return CONF;
    identityCache = null;
    indexCache = {};
    indexAt = 0;
    forceReconnect();
    refreshIndex(true);
    return CONF;
  })();
});

// The library's reserved identity — the companion's store.mjs owns the
// definition; this is the same literal, duplicated exactly as normUrl is.
// normUrl leaves it byte-identical, so comparing either way is the same test.
const LIBRARY_URL = 'bfp://library';
const isLibraryUrl = u => String(u || '') === LIBRARY_URL;

// ---- normUrl (duplicated in content.js and in the companion's store.mjs;
// the three must agree exactly — SPEC.md defines it) ----------------------
const STRIP_PARAM = /^(utm_[^=]*|fbclid|gclid)$/i;
function normUrl(u) {
  try {
    const url = new URL(String(u));
    url.hash = '';
    const keep = [];
    for (const [k, v] of url.searchParams) if (!STRIP_PARAM.test(k)) keep.push([k, v]);
    url.search = '';
    for (const [k, v] of keep) url.searchParams.append(k, v);
    let s = url.toString();
    s = s.replace(/\?$/, '');
    if (s.endsWith('/') && !/^[a-z]+:\/\/[^/]+\/$/i.test(s)) s = s.slice(0, -1);
    return s;
  } catch {
    return String(u || '').split('#')[0];
  }
}

// ---- state ---------------------------------------------------------------
let ws = null;
let wsState = 'closed';      // closed | connecting | open
let backoff = 1000;          // ms, doubles to 30s, resets on open
let retryTimer = null;
let indexCache = {};         // pageKey -> {url,title,threads,updated_at}
let indexAt = 0;
let indexPending = null;
// Which tab is showing which page. THIS TABLE IS THE WHOLE DELIVERY PATH: an
// event with a url is routed by looking a tab up in here, and a tab that is
// missing simply never hears from the companion again.
//
// It lives in worker memory, and an MV3 worker is a temporary thing — Chrome
// kills it and respawns it whenever it likes. The worker that comes back
// reconnects the socket perfectly and then routes every event into an EMPTY
// table, while the tab it forgot sits there with "queued…" on screen until the
// user reloads. That is why registration is no longer a one-shot `hello`:
//   • every message from a content script carries `page_url` and re-registers
//   • a long-lived port (see onConnect) registers on connect, and its death is
//     the signal content.js uses to notice the worker went away
//   • a worker that has just started asks the open tabs where they are
const tabUrls = new Map();   // tabId -> normUrl
const tabCounts = new Map(); // tabId -> thread count (for the badge)
const ports = new Map();     // tabId -> the content script's live port
const PORT_NAME = 'bfp';

function registerTab(tabId, rawUrl) {
  if (tabId == null || !rawUrl) return;
  const nu = normUrl(rawUrl);
  if (tabUrls.get(tabId) === nu) return;
  tabUrls.set(tabId, nu);
  if (!tabCounts.has(tabId)) {
    const e = indexEntryFor(nu);
    setBadge(tabId, e ? (e.threads || 0) : 0);
  }
}

// A worker that has just been respawned knows nothing. Ask every ordinary tab
// which page it is on; the ones with our content script answer, the rest throw
// and are ignored. Silent either way.
async function restoreTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }); } catch { return; }
  for (const t of tabs) {
    if (!t || t.id == null) continue;
    chrome.tabs.sendMessage(t.id, { t: 'whereami' })
      .then(r => { if (r && r.ok && r.url) registerTab(t.id, r.url); })
      .catch(() => { /* no content script there */ });
  }
}

const indexEntryFor = nu => Object.values(indexCache).find(v => v && normUrl(v.url) === nu) || null;

// ---- HTTP ----------------------------------------------------------------
// A 401 ("auth required") is the one failure the user can only fix somewhere
// else, so it says where. Every other status keeps the companion's own words —
// "owner only — ask the owner to do that", "not your message", "a name is
// required — send x-plugin-handle" — because those are sentences meant to be
// read, and the drawer shows them where they happened.
const AUTH_FAIL = 'auth required — check the password on the extension’s options page';

async function api(method, path, body) {
  await configReady;
  const init = { method: method || 'GET', cache: 'no-store' };
  const headers = CFG.authHeaders(CONF.password, CONF.handle);
  if (body !== undefined && body !== null) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (Object.keys(headers).length) init.headers = headers;
  let res;
  try {
    res = await fetch(CFG.httpUrl(CONF.base, path), init);
  } catch (e) {
    return { ok: false, error: 'companion unreachable (' + (e && e.message ? e.message : e) + ')' };
  }
  let data = null;
  const text = await res.text().catch(() => '');
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = res.status === 401 ? AUTH_FAIL : ((data && data.error) || ('HTTP ' + res.status));
    return { ok: false, status: res.status, data, error: err };
  }
  return { ok: true, status: res.status, data };
}

// Who this browser is to the companion — the name the drawer compares message
// authors against to decide which ones are the reader's own.
//
// The companion is the authority, not this side: GET /whoami answers
// {hosted, owner, handle}, and on a hosted companion the handle it reports is
// the sanitised one it will actually STAMP on messages (the header we send is
// only a request). Local mode has no handle, so the owner's name is the answer.
// An older companion has no /whoami; /health, then the configured handle, then
// nothing, and the drawer keeps its own default.
async function identity() {
  await configReady;
  if (identityCache && identityCache.base === CONF.base &&
      identityCache.handle_conf === CONF.handle) return identityCache.value;
  const pick = d => CFG.sanitizeHandle(d.handle || d.owner || d.author || '');
  let handle = '', hosted = false, owner = '';
  // …and whether this browser is the owner AS A FACT rather than as a name:
  // /whoami answers `owner` as a boolean, which the line above turns into a
  // label. The two things are different questions and the drawer asks the
  // second one (may I rename and tag pages here).
  let isOwner = null;
  let r = await api('GET', '/whoami');
  if (r.ok && r.data && r.data.ok !== false) {
    hosted = !!r.data.hosted;
    owner = String(r.data.owner || '');
    isOwner = r.data.owner === true || r.data.owner === 'true';
    handle = pick(r.data);
  } else {
    r = await api('GET', '/health');
    const d = (r.ok && r.data) || {};
    hosted = !!d.hosted;
    owner = String(d.owner || '');
    if (d.owner !== undefined) isOwner = d.owner === true || d.owner === 'true';
    handle = pick(d);
  }
  if (!handle) handle = CFG.sanitizeHandle(CONF.handle);
  // An older companion says nothing about ownership at all. A local companion
  // has no guests — the port is the boundary — so it is the owner's; a remote
  // one is only the owner's once it says so.
  if (isOwner === null) isOwner = !CFG.isLocal(CONF.base) ? false : true;
  const value = { ok: true, handle, owner, is_owner: isOwner, hosted, base: CONF.base,
                  remote: !CFG.isLocal(CONF.base), auth: !!CONF.password };
  identityCache = { base: CONF.base, handle_conf: CONF.handle, value };
  return value;
}

async function refreshIndex(force) {
  if (!force && Date.now() - indexAt < 2000) return indexCache;
  if (indexPending) return indexPending;
  indexPending = (async () => {
    const r = await api('GET', '/index');
    if (r.ok && r.data && typeof r.data === 'object') {
      indexCache = r.data.ok === false ? indexCache : r.data;
      indexAt = Date.now();
      refreshAllBadges();
    }
    indexPending = null;
    return indexCache;
  })();
  return indexPending;
}

let indexDebounce = null;
function refreshIndexSoon() {
  if (indexDebounce) return;
  indexDebounce = setTimeout(() => { indexDebounce = null; refreshIndex(true); }, 400);
}

// ---- WebSocket -----------------------------------------------------------
// A WebSocket cannot carry headers, so the password and handle ride as query
// params on the /ws url (CFG.wsUrlFor). The reconnect/backoff logic below is
// exactly as it was — only the address is now a function of the settings.
async function ensureSocket() {
  if (wsState === 'open' || wsState === 'connecting') return;
  wsState = 'connecting';
  await configReady;
  // a second caller may have won the race while we awaited the config
  if (wsState !== 'connecting') return;
  try {
    ws = new WebSocket(CFG.wsUrlFor(CONF.base, CONF.password, CONF.handle));
  } catch {
    wsState = 'closed';
    scheduleRetry();
    return;
  }
  ws.onopen = () => {
    wsState = 'open';
    backoff = 1000;
    // `resumed` is a standing instruction, not news: a socket that has just
    // opened cannot say what happened while it was shut, so every drawer
    // refetches its page instead of trusting the events it may have missed.
    broadcastAll({ t: 'conn', connected: true, resumed: true });
    refreshIndex(true);
  };
  ws.onmessage = e => {
    let ev = null;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (!ev || ev.type === 'ping') return;
    if (ev.type === 'page') refreshIndexSoon();
    if (ev.type === 'chat' && ev.kind === 'reply') refreshIndexSoon();
    routeEvent(ev);
  };
  ws.onclose = () => {
    if (wsState !== 'closed') broadcastAll({ t: 'conn', connected: false });
    wsState = 'closed';
    ws = null;
    scheduleRetry();
  };
  ws.onerror = () => { try { ws && ws.close(); } catch { /* onclose handles it */ } };
}

function scheduleRetry() {
  if (retryTimer) return;
  const wait = backoff;
  backoff = Math.min(backoff * 2, 30000);
  retryTimer = setTimeout(() => { retryTimer = null; ensureSocket(); }, wait);
}

function forceReconnect() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  backoff = 1000;
  try { ws && ws.close(); } catch { /* ignore */ }
  wsState = 'closed';
  ws = null;
  ensureSocket();
}

// Events carrying a url go only to the tabs showing that page; everything
// else (bridge state, hello) goes everywhere.
//
// The library is the exception that proves the rule: it carries a url, but it
// is a conversation about the whole archive and belongs to no tab — every
// drawer can have it open, so it goes to all of them. (`bfp://library` is a
// scheme no tab can ever be showing, so the match loop would find nobody.)
function routeEvent(ev) {
  if (ev.url && !isLibraryUrl(ev.url)) {
    const nu = normUrl(ev.url);
    for (const [tabId, tabUrl] of tabUrls) {
      if (tabUrl === nu) send(tabId, { t: 'ws', ev });
    }
  } else {
    broadcastAll({ t: 'ws', ev });
  }
}

function send(tabId, msg) {
  const port = ports.get(tabId);
  if (port) { try { port.postMessage(msg); return; } catch { ports.delete(tabId); } }
  chrome.tabs.sendMessage(tabId, msg).catch(() => { tabUrls.delete(tabId); tabCounts.delete(tabId); });
}
function broadcastAll(msg) {
  for (const tabId of [...tabUrls.keys()]) send(tabId, msg);
}

// ---- badge ---------------------------------------------------------------
function setBadge(tabId, count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#d97757' }).catch(() => {});
    chrome.action.setBadgeTextColor && chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(() => {});
  }
}
function refreshAllBadges() {
  for (const [tabId, nu] of tabUrls) {
    if (tabCounts.has(tabId)) { setBadge(tabId, tabCounts.get(tabId)); continue; }
    const e = indexEntryFor(nu);
    setBadge(tabId, e ? (e.threads || 0) : 0);
  }
}

// ---- the Google Docs export (fallback transport, see the contract) -------
// The ONLY non-companion url this worker will ever fetch, and it is pinned to
// one route: https, host exactly docs.google.com, the document export path,
// format=txt, and at most an authuser rider. A content script cannot turn this
// into a general-purpose proxy by asking nicely.
//
// The response is not served by docs.google.com itself: /export 302s to
// doc-XX-XX-docstext.googleusercontent.com with a `dat=` auth token in the
// query, which is why manifest.json's host_permissions list that host too —
// without it this fetch dies on the redirect exactly as the page's did.
// Credentials are 'include' HERE (and only here): the worker's own origin is
// the extension, so 'same-origin' would send no cookies at all, and CORS is
// satisfied by the host permission rather than by response headers.
//
// format=docx is the same route asking for the same document as a zip — the
// one export that carries the doc's own comment threads. It is fetched as
// bytes and handed back base64-encoded, because a Uint8Array does not survive
// sendMessage intact.
const GDOCS_EXPORT_URL =
  /^https:\/\/docs\.google\.com\/(?:u\/\d{1,3}\/)?document\/(?:u\/\d{1,3}\/)?d\/[A-Za-z0-9_-]{8,}\/export\?format=(?:txt|docx)(?:&authuser=\d{1,3})?$/;
const GDOCS_TEXT_MAX = 300000;   // the adapter keeps 12000; this is the wire cap
const GDOCS_BYTES_MAX = 6 * 1024 * 1024;   // matches adapters.js's DOCX_MAX
const peek = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 80);

const B64_CHUNK = 0x8000;
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}

async function gdocsExport(rawUrl, want) {
  const url = String(rawUrl == null ? '' : rawUrl);
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'gdocs-export: not a url' }; }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !GDOCS_EXPORT_URL.test(url)) {
    return { ok: false, error: 'gdocs-export: refused — this is not a Google Docs export url' };
  }
  let res;
  try {
    res = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  } catch (e) {
    return { ok: false, error: 'fetch threw: ' + peek((e && e.message) || e) };
  }
  const contentType = (res.headers && res.headers.get('content-type')) || '';
  if (want === 'bytes') {
    let buf;
    try { buf = await res.arrayBuffer(); }
    catch (e) { return { ok: false, status: res.status, contentType, error: 'the body did not read: ' + peek((e && e.message) || e) }; }
    if (!res.ok) return { ok: false, status: res.status, contentType, error: 'HTTP ' + res.status };
    const bytes = new Uint8Array(buf || 0);
    if (bytes.length > GDOCS_BYTES_MAX) {
      return { ok: false, status: res.status, contentType, error: 'the export is over the ' +
        Math.round(GDOCS_BYTES_MAX / 1048576) + 'MB cap (' + bytes.length + ' bytes)' };
    }
    return { ok: true, status: res.status, contentType, b64: bytesToBase64(bytes) };
  }
  let text = '';
  try { text = await res.text(); } catch (e) { text = ''; }
  if (!res.ok) {
    return { ok: false, status: res.status, contentType, error: 'HTTP ' + res.status, peek: peek(text) };
  }
  return { ok: true, status: res.status, contentType, text: text.slice(0, GDOCS_TEXT_MAX) };
}

// ---- web PDFs: getting the navigation into our own viewer ----------------
//
// A PDF on the web is handed to Chrome's BUILT-IN viewer, which is another
// extension's document. Content scripts do not run there, `scripting` cannot
// reach it, and there is no DOM of ours to select, wrap or anchor in. The only
// way to annotate a web PDF is to be the viewer, so the navigation is
// redirected into pdf/viewer.html before it ever gets there.
//
// WHY declarativeNetRequest, honestly:
//   • MV3 has no blocking webRequest, so nothing can look at a response's
//     Content-Type and decide. DNR decides before the request is sent, from
//     the URL alone.
//   • which is the limit, stated plainly: **a PDF whose url does not end in
//     .pdf is not caught**. Content-Disposition PDFs, /download?id=… endpoints
//     and viewer shells are all invisible to this rule. The toolbar is the
//     answer there — clicking the action on a tab whose content script never
//     answered opens that url in the viewer (see the action handler), and the
//     viewer says so plainly if it turns out not to be a PDF.
//   • webNavigation.onCommitted was considered and refused: by the time it
//     fires the built-in viewer already has the document, and re-navigating
//     costs a second fetch and a wrong entry in the back stack anyway. If the
//     redirect is going to happen it should happen first.
//
// The substitution is `#raw=<url>` rather than `?src=<encoded url>` because DNR
// writes the matched text VERBATIM — it has no encoder — and a PDF url with an
// `&` in its query would be cut in half by any `?src=` parse. Nothing follows
// the hash, so nothing is ambiguous. (adapters.js reads both spellings.)
const PDF_RULE_ID = PR.PDF_RULE_ID;
const PDF_BYPASS_ID = PR.PDF_BYPASS_ID;
const PDF_BYPASS_MS = PR.PDF_BYPASS_MS;
const PDF_VIEWER_PATH = PR.PDF_VIEWER_PATH;
const viewerBase = () => chrome.runtime.getURL(PDF_VIEWER_PATH);
const viewerUrlFor = u => PR.viewerUrlFor(viewerBase(), u);

const hasDNR = () => !!(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules);

const pdfRedirectRule = () => PR.redirectRule(viewerBase());

// The rule is DYNAMIC, not a static ruleset, for one plain reason: the redirect
// target contains the extension's own id, which does not exist until the
// extension is installed. Dynamic rules PERSIST and are enforced with the
// worker asleep, so after the first install this should never need writing
// again — and now it does not: the store is READ first and left alone when it
// already says the right thing. A worker wakes for every hello and every event,
// and rewriting a rule on each of those is churn at best; the write is also the
// only moment the rule could conceivably be absent, so the cheapest way to
// close that window is to stop opening it.
async function applyPdfRules(on) {
  if (!hasDNR()) return null;
  const want = pdfRedirectRule();
  let existing = [];
  try { existing = await chrome.declarativeNetRequest.getDynamicRules(); } catch { existing = []; }
  const plan = PR.pdfRulePlan(existing, on, want);
  if (!plan) return null;                            // the common case, every wake
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: plan.remove,
      addRules: plan.add,
    });
  } catch (e) {
    console.warn('[botference] the PDF redirect could not be installed:', (e && e.message) || e);
  }
  return plan;
}

// "Open it in the browser instead". Navigating straight back to the PDF would
// be caught by the very rule that brought the reader here, so a one-shot
// `allow` is parked in front of it at a higher priority and taken away again a
// minute later. Scoped to that exact url.
//
// ── A DEADLINE MAY NOT LIVE IN A setTimeout ────────────────────────────────
// That was the whole of the "PDFs don't open consistently" bug. The allow rule
// is a DYNAMIC rule: it persists, on disk, and is enforced with no worker
// running at all. Its removal, though, was a `setTimeout` inside the MV3
// worker — and this worker is retired and respawned constantly (it holds a
// 30-second alarm). Whenever Chrome reclaimed it inside that minute the timer
// went with it and the allow rule stayed. For ever. That one document then
// opened in the browser's own viewer every time, while every other PDF worked
// — which is exactly what "sometimes it doesn't open in Discuss" looks like
// from the outside.
//
// So the deadline is WRITTEN DOWN, and swept from three directions: at every
// worker start, on every keepalive alarm (twice a minute, whoever is running),
// and the moment the navigation it was created for actually commits. The timer
// remains as the fast path and is no longer the mechanism.
let bypassTimer = null;
const reEscape = PR.reEscape;

const BYPASS_KEY = 'bfp:pdf-bypass';
// session storage is the right shape (gone when the browser goes, never on
// disk), with local as the fallback for a Chrome too old to have it
const sessionArea = () =>
  (chrome.storage && chrome.storage.session) || (chrome.storage && chrome.storage.local) || null;

async function readBypass() {
  const area = sessionArea();
  if (!area) return null;
  try {
    const got = await area.get(BYPASS_KEY);
    const v = got && got[BYPASS_KEY];
    return v && v.url ? v : null;
  } catch { return null; }
}
async function writeBypass(v) {
  const area = sessionArea();
  if (!area) return;
  try { v ? await area.set({ [BYPASS_KEY]: v }) : await area.remove(BYPASS_KEY); }
  catch { /* the sweep still runs */ }
}

// Take the allow rule down and forget it. Safe at any time, including when
// there is nothing to take down.
async function clearBypass() {
  if (bypassTimer) { clearTimeout(bypassTimer); bypassTimer = null; }
  await writeBypass(null);
  if (!hasDNR()) return;
  try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PDF_BYPASS_ID] }); }
  catch { /* it will be swept again shortly */ }
}

async function sweepBypass() {
  if (!hasDNR()) return;
  const v = await readBypass();
  if (!PR.bypassExpired(v, Date.now())) return;      // still within its minute
  let rules = [];
  try { rules = await chrome.declarativeNetRequest.getDynamicRules(); } catch { rules = []; }
  if (v || rules.some(r => r && r.id === PDF_BYPASS_ID)) await clearBypass();
}

// WHICH PAGE a tab is showing, when the tab is showing our viewer. The address
// bar says chrome-extension://…/pdf/viewer.html and the page is a PDF, so a
// "focus the tab already on this page" search that compared raw urls would
// never find one and would open a second tab on every click in the Pages list.
// (adapters.js has the canonical parser; this is the same two rules, because a
// service worker cannot import a content script.)
const tabPageUrl = raw => PR.tabPageUrl(raw, viewerBase());

async function pdfBypass(rawUrl) {
  const url = String(rawUrl || '');
  if (!/^https?:/i.test(url)) return { ok: false, error: 'pdf-bypass needs an http(s) url' };
  if (!hasDNR()) return { ok: true, bypassed: false };
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PDF_BYPASS_ID],
      addRules: [PR.allowRule(url)],
    });
  } catch (e) {
    return { ok: false, error: 'the bypass rule was refused: ' + ((e && e.message) || e) };
  }
  await writeBypass({ url, until: Date.now() + PDF_BYPASS_MS });
  if (bypassTimer) clearTimeout(bypassTimer);
  bypassTimer = setTimeout(() => { bypassTimer = null; sweepBypass(); }, PDF_BYPASS_MS);
  return { ok: true, bypassed: true };
}

// ---- the belt: a PDF that got past the rule anyway -----------------------
//
// The redirect is a url-shaped rule and there are honest ways past it — the
// first navigation after an install (the rule is written by a worker that is
// still starting), a url with no `.pdf` in it, a bypass that has just been
// used. Rather than enumerate them, watch for the OUTCOME: a tab sitting on a
// main-frame `.pdf` that is not our viewer is a PDF that went to the browser's
// own, and the browser's own is a document no extension can reach into.
//
// `tabs.onUpdated` rather than `webNavigation` deliberately: the `tabs`
// permission is already held, and asking for "read your browsing history" to
// re-open a file the reader just asked for would be a poor trade.
//
// Once per tab per url, so a reopen that fails (or a reader who deliberately
// went back) is never fought with a second time.
const reopened = new Map();     // tabId -> the url we already reopened there

function rememberReopen(tabId, url) {
  if (reopened.get(tabId) === url) return false;
  reopened.set(tabId, url);
  return true;
}

// ── AND THE SAME BELT FOR A FILE ON THIS DISK ──────────────────────────────
// A local PDF has no redirect in front of it at all: declarativeNetRequest acts
// on network requests and a file: navigation is not one. So for `file:///…pdf`
// this listener is not a belt, it is the ONLY automatic way in — the toolbar
// button being the other, deliberate one.
//
// It is gated on the reader having granted "Allow access to file URLs",
// because without that the viewer can read nothing and reopening a PDF that
// the browser was showing perfectly well would be pure vandalism. Only an
// extension PAGE can ask (chrome.extension does not exist in a worker), so the
// viewer and the options page write the answer down and this reads it.
// UNKNOWN means "nobody has asked yet" and is treated as yes exactly once per
// tab per url: the viewer then either works, or explains which toggle to turn
// on and records the answer so this never fires again.
const FILE_ACCESS_KEY = 'bfp:file-access';
async function fileAccessKnown() {
  try {
    const got = await chrome.storage.local.get(FILE_ACCESS_KEY);
    const v = got && got[FILE_ACCESS_KEY];
    return v === undefined ? null : !!v;
  } catch { return null; }
}

async function maybeReopenPdf(tabId, url) {
  if (tabId == null || !PR.looksAnyPdfUrl(url)) return false;
  await configReady;
  if (CONF.pdf === false) return false;                 // the reader turned it off
  if (PR.looksLocalPdfUrl(url)) {
    if (await fileAccessKnown() === false) return false;
    if (!rememberReopen(tabId, url)) return false;
    try { await chrome.tabs.update(tabId, { url: viewerUrlFor(url) }); return true; }
    catch { return false; }
  }
  const b = await readBypass();
  if (b && b.url === url && !PR.bypassExpired(b, Date.now())) {
    // this is the "open it in the browser instead" they just asked for, and it
    // has now happened — the allow rule has done its one job
    await clearBypass();
    reopened.set(tabId, url);
    return false;
  }
  if (!rememberReopen(tabId, url)) return false;
  try { await chrome.tabs.update(tabId, { url: viewerUrlFor(url) }); return true; }
  catch { return false; }
}

// ---- opening a page from the drawer's pages list -------------------------
// Tab work can only happen here. Matching is on normUrl, not the raw string,
// so a link with a tracking query or a trailing slash still finds the tab the
// user already has open instead of duplicating it. The auto-open flag is set
// BEFORE the tab is created — a fast local page could otherwise finish loading
// and read storage before the write landed.
const AUTOOPEN = 'bfp-autoopen:';

async function openPage(rawUrl) {
  const target = String(rawUrl || '');
  // A local PDF is identified by its BYTES (bfp-pdf://sha256/…), which is what
  // makes it survive being moved and renamed — and is also why the browser
  // cannot be asked to go there. Say so, rather than failing without a word.
  if (/^bfp-pdf:/i.test(target)) {
    return { ok: false, error: 'this is a PDF on your disk — open the file itself and Discuss will find it' };
  }
  if (!/^https?:/i.test(target)) return { ok: false, error: 'open-page needs an http(s) url' };
  const nu = normUrl(target);
  const key = AUTOOPEN + nu;
  try { await chrome.storage.local.set({ [key]: Date.now() }); } catch { /* the tab still opens */ }

  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { tabs = []; }
  const hit = tabs.find(t => t && t.url && normUrl(tabPageUrl(t.url)) === nu);
  if (hit) {
    try { await chrome.tabs.update(hit.id, { active: true }); } catch { /* tab died */ }
    if (hit.windowId != null) { try { await chrome.windows.update(hit.windowId, { focused: true }); } catch {} }
    // that tab has already loaded, so nothing there will ever read the flag:
    // tell its content script directly and take the flag back down again
    try {
      await chrome.tabs.sendMessage(hit.id, { t: 'autoopen' });
      await chrome.storage.local.remove(key);
    } catch { /* no content script (yet) — the flag covers the next load */ }
    return { ok: true, focused: true, tabId: hit.id };
  }
  const tab = await chrome.tabs.create({ url: target, active: true });
  return { ok: true, created: true, tabId: tab && tab.id };
}

// ---- the extension's own settings page -----------------------------------
// Opening it is a chrome.runtime call, so only this worker can do it. The
// `agent` hint is stored rather than passed in a url: options_ui pages are
// opened by Chrome itself, with no query string of ours on them.
const FOCUS_KEY = 'bfp:focus-key';
async function openOptions(agent) {
  const want = agent === 'claude' || agent === 'codex' ? agent : '';
  try {
    if (want) await chrome.storage.local.set({ [FOCUS_KEY]: want });
    else await chrome.storage.local.remove(FOCUS_KEY);
  } catch { /* the page is still worth opening */ }
  await chrome.runtime.openOptionsPage();
  return { ok: true, focus: want };
}

// ---- the content script's port -------------------------------------------
// Two jobs, both about survival rather than data: it re-registers the tab the
// moment a new worker starts, and its `onDisconnect` in the content script is
// the only reliable notice a page gets that the worker it was talking to has
// died. Messages still travel by sendMessage/tabs.sendMessage; nothing here is
// a second protocol.
chrome.runtime.onConnect.addListener(port => {
  if (!port || port.name !== PORT_NAME) return;
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  if (tabId != null) ports.set(tabId, port);
  ensureSocket();
  port.onMessage.addListener(msg => {
    if (!msg) return;
    if (msg.url) registerTab(tabId, msg.url);
    ensureSocket();
    // the answer doubles as the liveness receipt the page is asking for
    try { port.postMessage({ t: 'pong', connected: wsState === 'open' }); } catch { /* gone */ }
  });
  port.onDisconnect.addListener(() => {
    if (tabId != null && ports.get(tabId) === port) ports.delete(tabId);
  });
});

// ---- message router ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  // every message re-registers its tab: a worker that restarted between two
  // API calls must not have to wait for a page reload to learn who is out there
  if (msg && msg.page_url) registerTab(tabId, msg.page_url);
  ensureSocket();
  (async () => {
    switch (msg && msg.t) {
      case 'hello': {
        const nu = normUrl(msg.url);
        if (tabId != null) { tabUrls.set(tabId, nu); tabCounts.delete(tabId); }
        await refreshIndex(false);
        const entry = indexEntryFor(nu);
        if (tabId != null) setBadge(tabId, entry ? (entry.threads || 0) : 0);
        return { ok: true, known: !!entry, threads: entry ? (entry.threads || 0) : 0,
                 connected: wsState === 'open', index: indexCache };
      }
      case 'get-index': {
        await refreshIndex(false);
        return { ok: true, index: indexCache, connected: wsState === 'open' };
      }
      case 'api': {
        const r = await api(msg.method, msg.path, msg.body);
        if (r.ok && /^\/(thread|reply|delete|delete-page|edit|orphan|page|tick)$/.test(String(msg.path).split('?')[0])) {
          refreshIndexSoon();
        }
        return r;
      }
      case 'badge': {
        if (tabId != null) { tabCounts.set(tabId, msg.count | 0); setBadge(tabId, msg.count | 0); }
        return { ok: true };
      }
      case 'reconnect': {
        forceReconnect();
        return { ok: true };
      }
      case 'identity': return identity();
      case 'gdocs-export': return gdocsExport(msg.url, msg.want);
      case 'pdf-bypass': return pdfBypass(msg.url);
      case 'open-page': return openPage(msg.url);
      case 'open-options': return openOptions(msg.agent);
      default:
        return { ok: false, error: 'unknown message ' + JSON.stringify(msg && msg.t) };
    }
  })().then(sendResponse, e => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // async sendResponse
});

// ---- lifecycle -----------------------------------------------------------
chrome.action.onClicked.addListener(tab => {
  if (!tab || tab.id == null) return;
  ensureSocket();
  chrome.tabs.sendMessage(tab.id, { t: 'toggle' }).catch(() => {
    // content script not present (chrome:// page, or injected before install)
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['anchor.js', 'adapters.js', 'drawer.js', 'content.js'],
    }).then(() => chrome.tabs.sendMessage(tab.id, { t: 'toggle' })).catch(() => openInPdfViewer(tab));
  });
});

// The last resort, and the answer to everything the .pdf rule cannot see.
//
// If neither the content script nor an injection could reach an http(s) tab,
// the overwhelmingly likely reason is that it is showing Chrome's own PDF
// viewer — that document belongs to another extension and is closed to both.
// So the click is taken as "annotate this", and the url is opened in ours.
// A tab that turns out not to be a PDF is not left guessing: the viewer says
// so and offers the way back.
//
// A `file://` tab reaches here for the same reason and by the same route (no
// content script answered), and is the ONLY deliberate way into the viewer for
// a PDF on this disk. It is held to a stricter test — the address must end in
// `.pdf` — because a local file that is not a PDF has no viewer to be opened
// in, whereas a web address that lies about its extension at least has an
// origin that might serve one.
function openInPdfViewer(tab) {
  if (!tab || tab.id == null) return;
  const url = String(tab.url || '');
  if (url.startsWith(chrome.runtime.getURL(''))) return;
  const web = /^https?:/i.test(url);
  if (!web && !PR.looksLocalPdfUrl(url)) return;      // chrome://, the store, a local file that is not a PDF
  chrome.tabs.update(tab.id, { url: viewerUrlFor(url) }).catch(() => {});
}

chrome.tabs.onRemoved.addListener(tabId => {
  tabUrls.delete(tabId); tabCounts.delete(tabId); reopened.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading') { tabUrls.delete(tabId); tabCounts.delete(tabId); }
  // a tab that has just LANDED somewhere new is allowed to be reopened again
  if (info.url && reopened.get(tabId) !== info.url) reopened.delete(tabId);
  // …and a tab that landed on a PDF the redirect did not catch — or on a local
  // one, which no redirect could ever catch — is one we can still rescue
  // (see maybeReopenPdf)
  const here = info.url || (tab && tab.url) || '';
  if (here && PR.looksAnyPdfUrl(here)) maybeReopenPdf(tabId, here);
});

chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== KEEPALIVE) return;
  ensureSocket();
  // twice a minute, whatever else happens: no allow rule outlives its deadline
  // by more than one tick, whoever's worker wrote it
  sweepBypass();
  if (wsState === 'open') refreshIndex(true);
});

chrome.runtime.onInstalled.addListener(() => { ensureSocket(); refreshIndex(true); });
chrome.runtime.onStartup.addListener(() => { ensureSocket(); refreshIndex(true); });

ensureSocket();
refreshIndex(true);
// Every worker start CHECKS the PDF redirect and writes only if it is wrong
// (applyPdfRules reads the store first), and sweeps any allow rule whose
// deadline passed while nobody was running — the two halves of "a PDF opens in
// Discuss every time, not most times".
configReady.then(c => applyPdfRules(!c || c.pdf !== false)).catch(() => {});
sweepBypass().catch(() => {});
// This line runs on EVERY worker start, including the respawn after Chrome
// killed the last one mid-conversation: it is how the tabs that were already
// open get their delivery address back.
restoreTabs();
