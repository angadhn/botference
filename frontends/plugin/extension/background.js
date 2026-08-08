// background.js — MV3 service worker for the Botference Web Annotator.
//
// Content scripts NEVER touch the network. The companion serves no CORS
// headers, so every fetch and the WS both live here, where host_permissions
// grant cross-origin access. This worker owns:
//
//   • the WebSocket to ws://127.0.0.1:4189/ws (exponential backoff reconnect,
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
//
// background → content   (chrome.tabs.sendMessage to matching tabs only)
//
//   {t:'ws',   ev:{…}}                a companion event, verbatim, as
//                                     specified in SPEC.md's event stream
//                                     (page / chat / bridge / hello / ping)
//   {t:'conn', connected:bool}        WS opened or dropped
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

const HOST = 'http://127.0.0.1:4189';
const WS_URL = 'ws://127.0.0.1:4189/ws';
const KEEPALIVE = 'bfp-keepalive';

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
const tabUrls = new Map();   // tabId -> normUrl
const tabCounts = new Map(); // tabId -> thread count (for the badge)

const indexEntryFor = nu => Object.values(indexCache).find(v => v && normUrl(v.url) === nu) || null;

// ---- HTTP ----------------------------------------------------------------
async function api(method, path, body) {
  const init = { method: method || 'GET', cache: 'no-store' };
  if (body !== undefined && body !== null) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(HOST + path, init);
  } catch (e) {
    return { ok: false, error: 'companion unreachable (' + (e && e.message ? e.message : e) + ')' };
  }
  let data = null;
  const text = await res.text().catch(() => '');
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    return { ok: false, status: res.status, data, error: (data && data.error) || ('HTTP ' + res.status) };
  }
  return { ok: true, status: res.status, data };
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
function ensureSocket() {
  if (wsState === 'open' || wsState === 'connecting') return;
  wsState = 'connecting';
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    wsState = 'closed';
    scheduleRetry();
    return;
  }
  ws.onopen = () => {
    wsState = 'open';
    backoff = 1000;
    broadcastAll({ t: 'conn', connected: true });
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
function routeEvent(ev) {
  if (ev.url) {
    const nu = normUrl(ev.url);
    for (const [tabId, tabUrl] of tabUrls) {
      if (tabUrl === nu) send(tabId, { t: 'ws', ev });
    }
  } else {
    broadcastAll({ t: 'ws', ev });
  }
}

function send(tabId, msg) {
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

// ---- opening a page from the drawer's pages list -------------------------
// Tab work can only happen here. Matching is on normUrl, not the raw string,
// so a link with a tracking query or a trailing slash still finds the tab the
// user already has open instead of duplicating it. The auto-open flag is set
// BEFORE the tab is created — a fast local page could otherwise finish loading
// and read storage before the write landed.
const AUTOOPEN = 'bfp-autoopen:';

async function openPage(rawUrl) {
  const target = String(rawUrl || '');
  if (!/^https?:/i.test(target)) return { ok: false, error: 'open-page needs an http(s) url' };
  const nu = normUrl(target);
  const key = AUTOOPEN + nu;
  try { await chrome.storage.local.set({ [key]: Date.now() }); } catch { /* the tab still opens */ }

  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { tabs = []; }
  const hit = tabs.find(t => t && t.url && normUrl(t.url) === nu);
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

// ---- message router ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender && sender.tab ? sender.tab.id : null;
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
        if (r.ok && /^\/(thread|reply|delete|edit|orphan|page)$/.test(String(msg.path).split('?')[0])) {
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
      case 'open-page': return openPage(msg.url);
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
      files: ['anchor.js', 'drawer.js', 'content.js'],
    }).then(() => chrome.tabs.sendMessage(tab.id, { t: 'toggle' })).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener(tabId => { tabUrls.delete(tabId); tabCounts.delete(tabId); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') { tabUrls.delete(tabId); tabCounts.delete(tabId); }
});

chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== KEEPALIVE) return;
  ensureSocket();
  if (wsState === 'open') refreshIndex(true);
});

chrome.runtime.onInstalled.addListener(() => { ensureSocket(); refreshIndex(true); });
chrome.runtime.onStartup.addListener(() => { ensureSocket(); refreshIndex(true); });

ensureSocket();
refreshIndex(true);
