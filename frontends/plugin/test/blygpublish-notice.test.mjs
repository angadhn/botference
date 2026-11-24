#!/usr/bin/env node
// PUBLISHING IN THE BACKGROUND, the worker's half (extension/background.js) and the notice itself (extension/pubtoast.js).
//
// The worker runs in a vm with a stand-in `chrome` (storage that survives a "restart", tabs, the toolbar badge) and a scripted
// companion. What is pinned down: the watch is one named state (config.js PUB_WATCH_STATES) moved by one function; a Publish
// press starts it, the run's end (an owner-only event, or the bounded poll) ends it ONCE: a badge mark on every tab and a toast
// sent to the tab the owner is looking at, which need not be the tab that started the run; a worker restarted mid-run still tells,
// once, never twice; a live notice is spent when shown, one needing attention when dismissed. The toast: its words, its link (the
// companion's address only), and its buttons, which act only on a trusted click that lands on it.
//
//   node frontends/plugin/test/blygpublish-notice.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, '..', 'extension');
const require = createRequire(import.meta.url);
const CFG = require(path.join(EXT, 'config.js'));
let pass = 0; const fails = [];
async function test(name, fn) { try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); } }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// one browser: storage and tabs outlive a worker "restart" (a new vm reading the same storage)
function browser() {
  return { storage: {}, badges: [], toTabs: [], active: 7, tabsKnown: [3, 7] };
}
function boot(B, companion) {
  const listeners = [];
  const chromeObj = {
    runtime: { onMessage: { addListener: fn => listeners.push(fn) }, onConnect: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      getURL: p => `chrome-extension://x/${p}`, id: 'x', lastError: null, sendMessage: () => Promise.resolve() },
    storage: {
      local: { get: (k, cb) => { const v = typeof k === 'string' ? (k in B.storage ? { [k]: B.storage[k] } : {}) : {}; if (typeof cb === 'function') cb(v); return Promise.resolve(v); },
        set: (o, cb) => { Object.assign(B.storage, JSON.parse(JSON.stringify(o))); if (typeof cb === 'function') cb(); return Promise.resolve(); }, remove: (k, cb) => { if (typeof cb === 'function') cb(); return Promise.resolve(); } },
      session: { get: (k, cb) => { if (typeof cb === 'function') cb({}); return Promise.resolve({}); }, set: (o, cb) => { if (typeof cb === 'function') cb(); return Promise.resolve(); }, remove: (k, cb) => { if (typeof cb === 'function') cb(); return Promise.resolve(); } },
      onChanged: { addListener() {} },
    },
    tabs: { query: async () => [{ id: B.active }], sendMessage: (id, msg) => { B.toTabs.push({ id, msg }); return Promise.resolve(); }, onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      onActivated: { addListener() {} }, get: async id => ({ id }), create: async () => ({}), update: async () => ({}) },
    action: { setBadgeText: o => { B.badges.push(o); return Promise.resolve(); }, setBadgeBackgroundColor: () => Promise.resolve(), setBadgeTextColor: () => Promise.resolve(), onClicked: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    declarativeNetRequest: { updateSessionRules: async () => {}, getSessionRules: async () => [] },
    scripting: { executeScript: async () => [] },
    webNavigation: { onCommitted: { addListener() {} } },
    windows: { onFocusChanged: { addListener() {} } },
  };
  const make = (obj, p) => new Proxy(obj, { get(t, k) { if (k in t) return t[k]; if (k === 'then') return undefined; return make(function () {}, `${p}.${String(k)}`); }, apply() { return Promise.resolve(undefined); } });
  const deep = o => { for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') o[k] = deep(o[k]); return make(o, 'chrome'); };
  class FakeWS { close() {} send() {} }
  const ctx = {
    console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Promise, Map, Set, JSON, Math, Date, TextEncoder, TextDecoder, btoa, atob, AbortController,
    WebSocket: FakeWS,
    fetch: async (url, init) => {
      const r = companion(String(url).replace(/^https?:\/\/[^/]+/, ''), init && init.method, init && init.body ? JSON.parse(init.body) : undefined);
      return { ok: r.ok !== false, status: r.ok === false ? 409 : 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(r) };
    },
    chrome: deep(chromeObj),
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f }); };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  const send = (msg, tabId = 3) => new Promise(resolve => { listeners[0](msg, { tab: { id: tabId } }, resolve); });
  const event = ev => vm.runInContext(`routeEvent(${JSON.stringify(ev)})`, ctx);
  const alarm = () => vm.runInContext('pubWatchCheck()', ctx);
  return { send, event, alarm, ctx };
}
// a scripted companion with one run
function companion() {
  const S = { run: { id: 'r1', token: 'tok', mode: 'planned', confirm: 'always', can: ['confirm', 'cancel'], thread_ids: ['t1'] }, runReads: 0 };
  S.fn = (p, method) => {
    if (p.startsWith('/blyg-publish/run')) { S.runReads++; return { ok: true, run: S.run, confirm: 'always' }; }
    if (p.startsWith('/blyg-publish/arm')) return { ok: true, run: S.run };
    if (p.startsWith('/blyg-publish/confirm')) { S.run = { ...S.run, mode: 'applying', can: [] }; return { ok: true, run: S.run }; }
    if (p.startsWith('/blyg-publish/retry')) { S.run = { ...S.run, mode: 'applying', can: [] }; return { ok: true, run: S.run }; }
    return { ok: true };
  };
  return S;
}
const notices = B => B.toTabs.filter(t => t.msg && t.msg.t === 'pub-notice');
const lastBadge = B => (B.badges.length ? B.badges[B.badges.length - 1].text : '');
const press = async (W, act, tab = 3) => { await W.send({ t: 'blyg-publish', op: 'arm', act, url: 'https://e.test/a' }, tab); return W.send({ t: 'blyg-publish', op: act, run: 'r1', token: 'tok', url: 'https://e.test/a' }, tab); };

await test('the watch: one named state, one move function, illegal moves refused; the notice and the badge from the run', () => {
  assert.deepEqual(CFG.PUB_WATCH_STATES, ['idle', 'watching', 'notice']);
  let w = { state: 'idle' };
  assert.throws(() => CFG.pubWatchMove(w, 'end'), /cannot end from idle/);
  assert.throws(() => CFG.pubWatchMove(w, 'seen'), /cannot seen from idle/);
  w = CFG.pubWatchMove(w, 'watch', { run: 'r1' });
  assert.deepEqual([w.state, CFG.pubBadgeMark(w)], ['watching', '•']);
  const n = CFG.pubNoticeOf({ id: 'r1', mode: 'published', published: { address: 'https://site.test/b/x' } });
  w = CFG.pubWatchMove(w, 'end', { notice: n });
  assert.deepEqual([w.state, CFG.pubBadgeMark(w)], ['notice', '✓']);
  assert.throws(() => CFG.pubWatchMove(w, 'end', { notice: n }), /cannot end from notice/, 'an end is told once');
  assert.equal(CFG.pubWatchMove(w, 'seen').state, 'idle');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'published', published: { address: 'javascript:alert(1)' } }).link, '', 'the link is http(s) only');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'applying' }), null, 'still going: nothing to tell');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'abandoned' }), null, 'ended with nothing to tell');
  // each way of needing attention: ONE fixed sentence
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'failed_apply', failed_step: 'apply', failure: 'Your site’s main branch is not in step with GitHub. Bring it up to date, then try again.' }).sentence, 'Your site’s main branch is not in step with GitHub. Bring it up to date, then try again.');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'failed_publish', failed_step: 'publish', failure: '' }).sentence, 'Something went wrong while publishing.');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'interrupted_publishing' }).sentence, 'The companion stopped while your post was being published.');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'abandon_failed' }).sentence, 'Your site could not give this publish up.');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'planned', confirm: 'always', review: 'agent-text' }).sentence, 'Your post is ready for your look before it is published.');
  assert.equal(CFG.pubBadgeMark({ state: 'notice', notice: { kind: 'attention' } }), '!');
});

await test('Publish pressed on tab 3, the owner reading on tab 7: the badge shows a dot, then a tick, and the toast goes to tab 7, once', async () => {
  const B = browser(); const S = companion();
  const W = boot(B, S.fn);
  await tick(10);
  const r = await press(W, 'confirm', 3);
  assert.equal(r.ok, true, JSON.stringify(r));
  await tick(10);
  assert.deepEqual([B.storage['bfp:pub-watch'].state, B.storage['bfp:pub-watch'].run], ['watching', 'r1'], 'the watch is kept in storage with the run id');
  assert.equal(lastBadge(B), '•');
  S.run = { ...S.run, mode: 'published', published: { address: 'https://site.test/b/abc', title: 'T' } };
  W.event({ type: 'blyg-publish', run: { id: 'r1', mode: 'published' } });
  await tick(20);
  const told = notices(B);
  assert.equal(told.length, 1);
  assert.deepEqual([told[0].id, told[0].msg.notice.kind, told[0].msg.notice.sentence, told[0].msg.notice.link], [7, 'live', 'Your post is live.', 'https://site.test/b/abc']);
  assert.equal(lastBadge(B), '✓');
  W.event({ type: 'blyg-publish', run: { id: 'r1', mode: 'published' } });
  await W.alarm(); await tick(20);
  assert.equal(notices(B).length, 1, 'never twice');
  await W.send({ t: 'pub-notice-shown', run: 'r1' }, 7); await tick(5);
  assert.deepEqual([B.storage['bfp:pub-watch'].state, lastBadge(B)], ['idle', ''], 'seen: the badge is cleared');
});

await test('a run that ends needing attention: "!" on the badge, the fixed sentence, and the notice stays until dismissed; a new page shows it', async () => {
  const B = browser(); const S = companion();
  const W = boot(B, S.fn);
  await tick(10);
  await press(W, 'confirm', 3); await tick(10);
  S.run = { ...S.run, mode: 'failed_apply', failed_step: 'apply', failure: 'Your site changed after it was built and checked. Try again to build it again.', can: ['retry', 'abandon'] };
  await W.alarm(); await tick(20);
  assert.equal(lastBadge(B), '!');
  assert.equal(notices(B)[0].msg.notice.sentence, 'Your site changed after it was built and checked. Try again to build it again.');
  await W.send({ t: 'pub-notice-shown', run: 'r1' }, 7); await tick(5);
  assert.equal(B.storage['bfp:pub-watch'].state, 'notice', 'shown is not seen: it waits to be dismissed');
  // the owner moves to another page before dismissing: that page shows it
  await W.send({ t: 'hello', url: 'https://other.test/p' }, 9); await tick(500);
  assert.ok(notices(B).some(t => t.id === 9), 'the next page shows it');
  await W.send({ t: 'pub-notice-done', run: 'r1' }, 9); await tick(5);
  assert.deepEqual([B.storage['bfp:pub-watch'].state, lastBadge(B)], ['idle', '']);
});

await test('the worker is suspended mid-run and restarted: it still tells, once, never twice', async () => {
  const B = browser(); const S = companion();
  const W1 = boot(B, S.fn);
  await tick(10);
  await press(W1, 'confirm', 3); await tick(10);
  // the worker goes away; the run ends while it is away; a new worker starts from storage
  S.run = { ...S.run, mode: 'published', published: { address: 'https://site.test/b/abc' } };
  const W2 = boot(B, S.fn);
  await tick(50);
  assert.equal(notices(B).length, 1, 'told on start');
  const W3 = boot(B, S.fn);
  await tick(50); await W3.alarm(); await tick(20);
  assert.equal(notices(B).length, 1, 'a third worker (the notice not yet seen) does not tell again on its own');
  void W2;
});

await test('a start that stops for the owner\'s look in the dialog is not watched; a one-click start is', async () => {
  const B = browser(); const S = companion();
  S.fn = ((orig) => (p, m, b) => (p.startsWith('/blyg-publish/start') ? { ok: true, run: { ...S.run, mode: 'planning', confirm: S.confirm || 'always' } } : orig(p, m, b)))(S.fn);
  const W = boot(B, S.fn);
  await tick(10);
  await W.send({ t: 'blyg-publish', op: 'start', thread_id: 't1', scope: 'one', url: 'https://e.test/a' }, 3); await tick(10);
  assert.equal((B.storage['bfp:pub-watch'] || { state: 'idle' }).state, 'idle');
  S.confirm = 'never';
  await W.send({ t: 'blyg-publish', op: 'start', thread_id: 't1', scope: 'one', url: 'https://e.test/a' }, 3); await tick(10);
  assert.equal(B.storage['bfp:pub-watch'].state, 'watching');
});

// ---- the toast --------------------------------------------------------------------------------------------------------------
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const T = require(path.join(EXT, 'pubtoast.js'));
const win = new GlobalWindow({ url: 'https://example.com/article' });
const doc = win.document;
const inside = h => h.__shadow;   // (a closed root: the test keeps its own handle below)
const origAttach = win.HTMLElement.prototype.attachShadow;
win.HTMLElement.prototype.attachShadow = function (o) { const r = origAttach.call(this, o); this.__shadow = r; return r; };
const click = (el, { trusted = true, x = 10, y = 10 } = {}) => { const e = new win.MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: y }); e.__trusted = trusted; el.dispatchEvent(e); };
const isTrusted = e => e.__trusted === true;

await test('the live toast: the sentence, the companion\'s link, gone by itself after a while; keyboard and dismiss', async () => {
  const seen = [];
  const t = T.show({ kind: 'live', run: 'r1', sentence: 'Your post is live.', link: 'https://site.test/b/abc' }, { doc, isTrusted, liveMs: 60, onShown: n => seen.push(['shown', n.run]), onDone: n => seen.push(['done', n.run]) });
  const root = inside(t.host);
  assert.equal(root.querySelector('.say').textContent, 'Your post is live.');
  const a = root.querySelector('a[data-act="open-post"]');
  assert.deepEqual([a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')], ['https://site.test/b/abc', '_blank', 'noopener noreferrer']);
  assert.equal(root.querySelector('.box').getAttribute('role'), 'status');
  await tick(80);
  assert.deepEqual(seen, [['shown', 'r1'], ['done', 'r1']], 'shown, then gone after its time');
  const bad = T.show({ kind: 'live', run: 'r2', sentence: 'Your post is live.', link: 'javascript:alert(1)' }, { doc, isTrusted });
  assert.equal(inside(bad.host).querySelector('a'), null, 'no link that is not http(s)');
  bad.close();
});

await test('the attention toast stays; its buttons need a trusted click that lands on it (the page cannot press or cover them)', async () => {
  const seen = [];
  const t = T.show({ kind: 'attention', run: 'r1', sentence: 'Your site changed after it was built and checked. Try again to build it again.' },
    { doc, isTrusted, liveMs: 30, onOpen: n => seen.push(['open', n.run]), onDone: n => seen.push(['done', n.run]) });
  const root = inside(t.host);
  assert.equal(root.querySelector('.box').getAttribute('role'), 'alert');
  await tick(60);
  assert.ok(doc.querySelector('bfp-pub-notice'), 'it stays');
  const btn = root.querySelector('[data-act="open-steps"]');
  click(btn, { trusted: false });
  assert.deepEqual(seen, [], 'an untrusted click does nothing');
  doc.elementsFromPoint = () => [doc.body];
  click(btn);
  assert.deepEqual(seen, [], 'a click on something the page laid over it does nothing');
  doc.elementsFromPoint = () => [t.host];
  click(btn);
  assert.deepEqual(seen, [['open', 'r1'], ['done', 'r1']], 'the owner\'s click on it opens the steps');
  delete doc.elementsFromPoint;
  const t2 = T.show({ kind: 'attention', run: 'r3', sentence: 'x' }, { doc, isTrusted, onDone: n => seen.push(['done', n.run]) });
  click(inside(t2.host).querySelector('[data-act="dismiss"]'), { x: 0, y: 0 });
  assert.deepEqual(seen.at(-1), ['done', 'r3'], 'the keyboard (no pointer position) reaches the dismiss button');
});

console.log(`${fails.length ? '✗' : '✓'} blygpublish-notice — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  · ' + f);
process.exit(fails.length ? 1 : 0);
