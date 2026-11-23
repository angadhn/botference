#!/usr/bin/env node
// THE EXTENSION BEHIND CLOUDFLARE ACCESS (config.js replyKind/requestInit, background.js, drawer.js, options.js).
//
// A companion behind Access is reached with the browser's own sign-in cookie: remote requests say credentials 'include' and
// never follow a redirect. An answer that is Cloudflare's (a redirect, its page, or the companion's own "sign-in required")
// is never data: the connection mode becomes 'signin', the drawer shows one line and a button, and the socket comes back
// once the person has signed in. A password companion behaves exactly as before.
//
//   node frontends/plugin/test/access-extension.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, '..', 'extension');
const require = createRequire(import.meta.url);
const OPT = require(path.join(EXT, 'options.js')); // before any document exists: it only wires a page when there is one
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection', 'ResizeObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const CFG = require(path.join(EXT, 'config.js'));
const DR = require(path.join(EXT, 'drawer.js'));

let pass = 0; const fails = [];
async function test(name, fn) { try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); } }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const BASE = 'https://hub.example.test';
const json = (status, obj) => ({ ok: status < 400, status, type: 'basic', headers: { get: k => (k.toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => JSON.stringify(obj) });
const html = (status, body = '<!doctype html><html><body>Sign in</body></html>') => ({ ok: status < 400, status, type: 'basic', headers: { get: k => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) }, text: async () => body });
const redirect = () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: { get: () => null }, text: async () => '' });

// ---- config.js: what an answer IS -------------------------------------------------------------------------------------
await test('replyKind: the companion\'s answers are data; Cloudflare\'s are not', () => {
  const k = (res, text) => CFG.replyKind(res, text);
  assert.deepEqual(CFG.REPLY_KINDS, ['data', 'signin', 'refused']);
  assert.equal(k({ type: 'opaqueredirect', status: 0 }, ''), 'signin');
  assert.equal(k({ type: 'basic', status: 302, contentType: '' }, ''), 'signin');
  assert.equal(k({ status: 200, contentType: 'text/html; charset=utf-8' }, '<!doctype html><html>'), 'signin', 'a login page with a 200');
  assert.equal(k({ status: 401, contentType: 'text/html' }, '<html>'), 'signin');
  assert.equal(k({ status: 200, contentType: '' }, '<!DOCTYPE html><title>x'), 'signin', 'HTML without a type');
  assert.equal(k({ status: 403, contentType: 'text/html' }, '<html>Forbidden'), 'refused', 'signed in but not allowed');
  assert.equal(k({ status: 401, contentType: 'application/json' }, '{"ok":false,"error":"sign-in required","signin":true}'), 'signin');
  assert.equal(k({ status: 401, contentType: 'application/json' }, '{"ok":false,"error":"auth required"}'), 'data', 'a password companion\'s refusal is its own');
  assert.equal(k({ status: 403, contentType: 'application/json' }, '{"ok":false,"error":"owner only"}'), 'data');
  assert.equal(k({ status: 200, contentType: 'application/json' }, '{"ok":true}'), 'data');
  assert.equal(k({ status: 200, contentType: 'text/plain' }, 'plain bytes'), 'data');
  assert.equal(k({ status: 500, contentType: 'application/json' }, 'x'), 'data');
});
await test('requestInit: a remote companion gets the browser\'s cookies and no redirects; this machine gets nothing extra', () => {
  assert.deepEqual(CFG.requestInit(BASE), { credentials: 'include', redirect: 'manual' });
  for (const b of ['http://127.0.0.1:4189', 'http://localhost:4189', '']) assert.deepEqual(CFG.requestInit(b), {});
});
await test('authModeOf and the password box', () => {
  const m = (res, text) => CFG.authModeOf(res, text);
  for (const a of ['password', 'access', 'either']) assert.equal(m({ status: 200, contentType: 'application/json' }, JSON.stringify({ ok: true, auth: a })), a);
  assert.equal(m({ type: 'opaqueredirect', status: 0 }, ''), 'access', 'Cloudflare\'s page means Access is in front');
  assert.equal(m({ status: 200, contentType: 'application/json' }, '{"auth":"banana"}'), '');
  assert.equal(m({ status: 404, contentType: 'application/json' }, '{"ok":false}'), '', 'an older companion: unknown');
  assert.equal(CFG.showPasswordField('access'), false);
  for (const a of ['password', 'either', '']) assert.equal(CFG.showPasswordField(a), true);
});
await test('the connection modes: signin is named, entered by deny, left by retry or reach, and survives a dropped socket', () => {
  assert.deepEqual(CFG.CONN_MODES, ['connecting', 'connected', 'offline', 'reload', 'signin']);
  assert.ok(CFG.CONN_WORDS.signin && CFG.CONN_NOTICE.signin);
  for (const m of ['connecting', 'connected', 'offline', 'signin']) assert.equal(CFG.connMove(m, 'deny'), 'signin');
  assert.equal(CFG.connMove('signin', 'reach'), 'connected');
  assert.equal(CFG.connMove('signin', 'retry'), 'connecting');
  assert.equal(CFG.canConnMove('signin', 'fail'), false);
  assert.equal(CFG.canConnMove('reload', 'deny'), false, 'reload is final');
  assert.equal(CFG.connMove('signin', 'unload'), 'reload');
});
await test('the options verdict says sign-in, not outage and not wrong password', () => {
  const v = OPT.healthVerdict({ ok: false, signin: true, status: 0 });
  assert.equal(v.mode, 'signin'); assert.match(v.text, /sign-in needed/);
  assert.match(OPT.healthVerdict({ ok: false, status: 401 }).text, /password was rejected/, 'password mode unchanged');
});

// ---- the worker ---------------------------------------------------------------------------------------------------------
function boot({ stored = {}, fetchImpl }) {
  const sockets = [], sent = [], calls = [], listeners = { message: [], removed: [] }, created = [];
  class FakeWS {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
    close() { if (this.closed) return; this.closed = true; setTimeout(() => this.onclose && this.onclose(), 0); }
    send() { }
  }
  const make = (pathName) => new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (pathName === 'chrome.tabs' && k === 'sendMessage') return (_id, msg) => { sent.push(msg); return Promise.resolve(); };
      if (pathName === 'chrome.tabs' && k === 'query') return () => Promise.resolve([{ id: 1 }]);
      if (pathName === 'chrome.tabs' && k === 'create') return o => { created.push(o); return Promise.resolve({ id: 77 }); };
      if (pathName === 'chrome.tabs.onRemoved' && k === 'addListener') return f => listeners.removed.push(f);
      if (pathName === 'chrome.runtime.onMessage' && k === 'addListener') return f => listeners.message.push(f);
      if (/^chrome\.storage\.\w+$/.test(pathName) && k === 'get') return (_keys, cb) => { if (typeof cb === 'function') cb(stored); return Promise.resolve(stored); };
      return make(`${pathName}.${String(k)}`);
    },
    apply(_t, _this, args) {
      const cb = args[args.length - 1];
      if (typeof cb === 'function' && !/addListener$/.test(pathName)) { try { cb(); } catch { } }
      return Promise.resolve(undefined);
    },
  });
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Promise, Map, Set, JSON, Math, Date, TextEncoder, TextDecoder, btoa, atob, AbortController,
    WebSocket: FakeWS, chrome: make('chrome'),
    fetch: async (url, init) => { calls.push({ url: String(url), init: init || {} }); return fetchImpl(String(url), init || {}); },
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f }); };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  const run = code => vm.runInContext(code, ctx);
  const message = msg => new Promise(resolve => { listeners.message[0](msg, { tab: { id: 1 } }, resolve); });
  run("tabUrls.set(1, 'https://example.com/article')");   // one open tab to be told
  return { sockets, sent, calls, created, listeners, run, message };
}
const REMOTE = { 'bfp:companion': BASE };

await test('requests to a remote companion carry the browser\'s cookies and never follow a redirect; a local one is unchanged', async () => {
  const W = boot({ stored: REMOTE, fetchImpl: async () => json(200, { ok: true }) });
  await W.run("api('GET', '/health')");
  assert.equal(W.calls[0].init.credentials, 'include'); assert.equal(W.calls[0].init.redirect, 'manual');
  assert.equal(W.calls[0].init.headers, undefined, 'no password, no header');
  const L = boot({ stored: {}, fetchImpl: async () => json(200, { ok: true }) });
  await L.run("api('GET', '/health')");
  assert.equal(L.calls[0].init.credentials, undefined); assert.equal(L.calls[0].init.redirect, undefined);
});

for (const [name, reply] of [['a redirect to the login page', redirect], ['Cloudflare\'s HTML with a 200', () => html(200)], ['Cloudflare\'s HTML with a 401', () => html(401)],
  ['the companion\'s own sign-in required', () => json(401, { ok: false, error: 'sign-in required', signin: true })]]) {
  await test(`${name} moves to sign-in needed and never reaches the drawer as data`, async () => {
    const W = boot({ stored: REMOTE, fetchImpl: async () => reply() });
    const r = await W.run("api('GET', '/page?url=https%3A%2F%2Fexample.com%2Fa')");
    assert.equal(r.ok, false); assert.equal(r.signin, true);
    assert.equal(r.data, undefined, 'no data'); assert.equal(r.raw, undefined);
    assert.equal(r.error, CFG.CONN_NOTICE.signin);
    assert.equal(W.run('wsState'), 'signin');
    assert.ok(W.sent.some(m => m.t === 'conn' && m.socket === 'signin'), 'every tab is told');
  });
}
await test('a signed-in but refused person is told so, and the mode does not say sign-in', async () => {
  const W = boot({ stored: REMOTE, fetchImpl: async () => html(403, '<html>Forbidden') });
  const r = await W.run("api('GET', '/health')");
  assert.equal(r.ok, false); assert.equal(r.signin, undefined); assert.match(r.error, /not allowed/);
  assert.notEqual(W.run('wsState'), 'signin');
});
await test('the companion\'s own words (an owner-only refusal) are still its own', async () => {
  const W = boot({ stored: REMOTE, fetchImpl: async () => json(403, { ok: false, error: 'owner only — ask the owner to do that' }) });
  const r = await W.run("api('POST', '/snapshot', {})");
  assert.equal(r.error, 'owner only — ask the owner to do that');
});
const authModeReply = auth => () => json(200, { ok: true, auth });
const route = (table, dflt = () => json(200, { ok: true })) => async (url, init) => { const k = Object.keys(table).find(p => url.endsWith(p)); return (k ? table[k] : dflt)(url, init); };
await test('password mode is unchanged: a bearer header, the old words for a refusal, and no sign-in mode', async () => {
  const W = boot({ stored: { ...REMOTE, 'bfp:password': 'pw', 'bfp:handle': 'ada' }, fetchImpl: route({ '/auth-mode': authModeReply('password'), '/health': () => json(401, { ok: false, error: 'auth required' }) }) });
  const r = await W.run("api('GET', '/health')");
  const h = W.calls.find(c => /\/health$/.test(c.url));
  assert.equal(h.init.headers.Authorization, 'Bearer pw'); assert.equal(h.init.headers['x-plugin-handle'], 'ada');
  assert.match(r.error, /check the password/); assert.equal(r.signin, undefined);
  assert.notEqual(W.run('wsState'), 'signin');
  const probe = W.calls.find(c => /auth-mode$/.test(c.url));
  assert.ok(!probe.init.headers || !probe.init.headers.Authorization, 'the question about the mode carries no password');
  W.run('ensureSocket()'); await tick(10);
  assert.match(W.sockets[0].url, /auth=pw/, 'and the socket carries it, as before');
});
await test('a password saved for a companion that says "access" is never sent to it: not in a header, not on the socket', async () => {
  for (const [name, table] of [['by /auth-mode', { '/auth-mode': authModeReply('access') }], ['by the sign-in shape', { '/auth-mode': redirect }]]) {
    const W = boot({ stored: { ...REMOTE, 'bfp:password': 'pw', 'bfp:handle': 'ada' }, fetchImpl: route(table) });
    await W.run("api('GET', '/health')");
    W.run('ensureSocket()'); await tick(10);
    for (const c of W.calls) assert.ok(!(c.init.headers && c.init.headers.Authorization), `${name}: no bearer to ${c.url}`);
    for (const k of W.sockets) assert.ok(!/auth=|pw/.test(k.url), `${name}: no password on the socket address ${k.url}`);
    assert.equal(W.run('CONF.auth_learned'), 'access');
  }
});
await test('what a host said once cannot be lowered by a later answer: still no password until the person changes the setting by hand', async () => {
  let says = 'access';
  const stored = { ...REMOTE, 'bfp:password': 'pw' };
  const W = boot({ stored, fetchImpl: route({ '/auth-mode': () => authModeReply(says)(), '/health': () => json(200, { ok: true }) }) });
  await W.run("api('GET', '/health')");
  says = 'password';
  W.run('modeProbe = null');             // even asked again, and answered "password"
  await W.run("api('GET', '/health')"); await W.run("api('GET', '/health')");
  W.run('ensureSocket()'); await tick(10);
  assert.ok(W.calls.filter(c => /health$/.test(c.url)).every(c => !(c.init.headers && c.init.headers.Authorization)));
  assert.ok(W.sockets.every(k => !/auth=/.test(k.url)));
  // the remembered answer is written down for THAT address, and applies to no other
  assert.equal(CFG.learnedOf({ base: BASE, mode: 'access' }, BASE), 'access');
  assert.equal(CFG.learnedOf({ base: BASE, mode: 'access' }, 'https://other.example.test'), '');
  assert.equal(CFG.learnedOf({ base: BASE, mode: 'password' }, BASE), '', 'only "access" is ever remembered');
  assert.equal(CFG.passwordFor({ password: 'pw', auth_learned: 'access' }), ''); assert.equal(CFG.passwordFor({ password: 'pw', auth_learned: '' }), 'pw');
  // the person's own save forgets it
  const store = { v: { 'bfp:learned-auth': { base: BASE, mode: 'access' } }, remove(k, cb) { delete this.v[k]; cb(); }, set(o, cb) { Object.assign(this.v, o); cb(); } };
  await CFG.forgetAccess(store); assert.deepEqual(store.v, {});
  await CFG.rememberAccess(BASE + '/', store); assert.deepEqual(store.v['bfp:learned-auth'], { base: BASE, mode: 'access' });
});
await test('a local companion is never asked, and a companion with no password saved is not asked either', async () => {
  const L = boot({ stored: { 'bfp:password': 'pw' }, fetchImpl: async () => json(200, {}) });
  await L.run("api('GET', '/health')");
  assert.ok(!L.calls.some(c => /auth-mode/.test(c.url)));
  const N = boot({ stored: REMOTE, fetchImpl: async () => json(200, {}) });
  await N.run("api('GET', '/health')");
  assert.ok(!N.calls.some(c => /auth-mode/.test(c.url)));
});

await test('after sign-in the socket comes back by itself: the next answer from the companion reconnects it', async () => {
  let signedIn = false;
  const W = boot({ stored: REMOTE, fetchImpl: async () => (signedIn ? json(200, { ok: true }) : redirect()) });
  await W.run("api('GET', '/health')");
  assert.equal(W.run('wsState'), 'signin');
  signedIn = true;
  const r = await W.run("api('GET', '/health')");
  assert.equal(r.ok, true);
  await tick(5);
  assert.equal(W.sockets.length >= 1, true, 'a socket was opened');
  W.sockets[W.sockets.length - 1].onopen();
  assert.equal(W.run('wsState'), 'connected');
  assert.ok(W.sent.some(m => m.t === 'conn' && m.socket === 'connected'));
});
await test('a socket turned away by Cloudflare is read from the probe: sign-in needed, not offline; while it is, no socket is tried; a good answer opens one', async () => {
  let signedIn = false;
  const W = boot({ stored: REMOTE, fetchImpl: async () => (signedIn ? json(200, { ok: true, auth: 'access' }) : redirect()) });
  W.run('ensureSocket()'); await tick(5);
  W.sockets[0].onclose(); await tick(10);
  assert.equal(W.run('wsState'), 'signin');
  assert.ok(W.calls.some(c => c.url === BASE + '/auth-mode' && c.init.credentials === 'include'));
  // each try while sign-in is needed is a question, never a socket, and the mode does not move
  for (let i = 0; i < 3; i++) { W.run('forceReconnect()'); W.run('ensureSocket()'); await tick(10); }
  assert.equal(W.sockets.length, 1, 'no socket was tried while sign-in was needed');
  assert.equal(W.run('wsState'), 'signin'); assert.equal(W.run('ws'), null);
  assert.notEqual(W.run('retryTimer'), null, 'and it will ask again');
  // signed in: the next question is answered by the companion, which is the move that opens a socket
  signedIn = true;
  W.run('forceReconnect()'); W.run('ensureSocket()'); await tick(10);
  assert.equal(W.sockets.length, 2); assert.equal(W.run('wsState'), 'connecting');
  W.sockets[1].onopen();
  assert.equal(W.run('wsState'), 'connected');
});
await test('a local companion\'s closed socket is never probed for sign-in', async () => {
  const W = boot({ stored: {}, fetchImpl: async () => redirect() });
  W.run('ensureSocket()'); await tick(5); W.sockets[0].onclose(); await tick(10);
  assert.ok(!W.calls.some(c => /auth-mode/.test(c.url)), 'the probe was not asked'); assert.notEqual(W.run('wsState'), 'signin');
});
await test('the sign-in button opens the companion\'s own address only; closing that tab tries the socket again', async () => {
  let signedIn = false;
  const W = boot({ stored: REMOTE, fetchImpl: async () => (signedIn ? json(200, { ok: true }) : redirect()) });
  await W.run("api('GET', '/health')");
  const r = await W.message({ t: 'open-signin', url: 'https://evil.example.test/' });
  assert.equal(r.ok, true); assert.equal(W.created.length, 1); assert.equal(W.created[0].url, BASE + '/');
  const before = W.sockets.length;
  W.listeners.removed[0](12345); await tick(5);
  assert.equal(W.sockets.length, before, 'another tab closing means nothing');
  signedIn = true;
  W.listeners.removed[0](77); await tick(15);
  assert.equal(W.sockets.length, before + 1, 'the sign-in tab closing opens the socket again');
  const L = boot({ stored: {}, fetchImpl: async () => json(200, {}) });
  assert.equal((await L.message({ t: 'open-signin' })).ok, false, 'nothing to sign in to on this machine');
  assert.equal(L.created.length, 0);
});

// ---- the drawer -------------------------------------------------------------------------------------------------------------
function drawerWith(trusted) {
  const calls = { signin: 0, reconnect: 0 };
  const d = DR.create({ isTrusted: () => trusted.v, cssText: '.panel{}', onSignin: () => { calls.signin++; }, onReconnect: () => { calls.reconnect++; } });
  d.open('chat');
  d.setPage({ url: 'https://example.com/article', title: 'Article', page_chat: [], threads: [] });
  return { d, calls };
}
await test('the drawer shows one line and one button; only a trusted click acts; connecting again clears it', async () => {
  const trusted = { v: false };
  const { d, calls } = drawerWith(trusted);
  await tick(10);
  const S = d.shadow;
  assert.equal(d.setConn('deny'), true);
  assert.equal(d.conn, 'signin');
  assert.equal(S.querySelector('.conn .ctext').textContent, CFG.CONN_WORDS.signin);
  const notice = S.querySelector('.pane[data-pane="chat"] .notice');
  assert.match(notice.textContent, /Sign-in needed/);
  assert.equal(notice.querySelectorAll('button').length, 1, 'one button');
  assert.equal(notice.querySelector('[data-act="retry"]'), null, 'no outage steps');
  const btn = notice.querySelector('[data-act="signin"]');
  btn.click(); await tick(5);
  assert.equal(calls.signin, 0, 'a click a page made up does nothing');
  trusted.v = true;
  S.querySelector('.pane[data-pane="chat"] .notice [data-act="signin"]').click(); await tick(5);
  assert.equal(calls.signin, 1, 'a real click opens the sign-in');
  assert.equal(d.setConn('fail'), false, 'a dropped socket does not turn sign-in into an outage');
  assert.equal(d.conn, 'signin');
  assert.equal(d.setConn('reach'), true);
  assert.equal(S.querySelector('.pane[data-pane="chat"] .notice'), null, 'signed in: the line is gone');
});

console.log(`\naccess-extension: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
process.exit(0);
