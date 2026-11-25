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
      const r = await companion(String(url).replace(/^https?:\/\/[^/]+/, ''), init && init.method, init && init.body ? JSON.parse(init.body) : undefined);
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
// the companion's queue entry for a run (blyg-queue.mjs viewOf), as the run's mode makes it
const entryOf = (run, extra = {}) => {
  const failedMode = /^(failed_|interrupted_|abandon_failed)/.test(run.mode);
  const state = run.mode === 'published' ? 'published' : failedMode ? 'failed' : run.mode === 'cancelled' ? 'cancelled' : 'running';
  return { id: 'e-' + run.id, state, run: run.id, started_by: 'owner', at: '2026-11-25T10:00:00Z', ahead: 0,
    result: run.mode === 'published' ? { address: (run.published || {}).address || '', version: 1 } : null,
    failure: failedMode ? { step: run.failed_step || '', line: run.failure || '', mode: run.mode } : null, ...extra };
};
// a scripted companion with one run (and the queue entry that carries it; `S.more`: other entries)
function companion() {
  const S = { run: { id: 'r1', token: 'tok', mode: 'planned', confirm: 'always', can: ['confirm', 'cancel'], thread_ids: ['t1'] }, runReads: 0, more: [] };
  S.queue = () => ({ state: 'running', entries: [entryOf(S.run), ...S.more] });
  S.fn = (p, method) => {
    if (p.startsWith('/blyg-publish/run')) { S.runReads++; return { ok: true, run: S.run, confirm: 'always', queue: S.queue() }; }
    if (p.startsWith('/blyg-publish/arm')) return { ok: true, run: S.run };
    if (p.startsWith('/blyg-publish/confirm')) { S.run = { ...S.run, mode: 'applying', can: [] }; return { ok: true, run: S.run, queue: S.queue() }; }
    if (p.startsWith('/blyg-publish/retry')) { S.run = { ...S.run, mode: 'applying', can: [] }; return { ok: true, run: S.run, queue: S.queue() }; }
    return { ok: true };
  };
  return S;
}
const notices = B => B.toTabs.filter(t => t.msg && t.msg.t === 'pub-notice');
const lastBadge = B => (B.badges.length ? B.badges[B.badges.length - 1].text : '');
const press = async (W, act, tab = 3) => { await W.send({ t: 'blyg-publish', op: 'arm', act, url: 'https://e.test/a' }, tab); return W.send({ t: 'blyg-publish', op: act, run: 'r1', token: 'tok', url: 'https://e.test/a' }, tab); };

await test('the watch: one named state, one move function, illegal moves refused; the badge counts the queue, then ✓ or !', () => {
  assert.deepEqual(CFG.PUB_WATCH_STATES, ['idle', 'watching', 'notice']);
  let w = { state: 'idle' };
  assert.throws(() => CFG.pubWatchMove(w, 'end'), /cannot end from idle/);
  assert.throws(() => CFG.pubWatchMove(w, 'seen'), /cannot seen from idle/);
  assert.throws(() => CFG.pubWatchMove(w, 'tell'), /cannot tell from idle/);
  w = CFG.pubWatchMove(w, 'watch', { count: 3 });
  assert.deepEqual([w.state, CFG.pubBadgeMark(w)], ['watching', '3'], 'the count while the queue is not empty');
  const n = CFG.pubEntryNotice({ id: 'e1', state: 'published', result: { address: 'https://site.test/b/x' } });
  const told = CFG.pubWatchAdd(w, n, 1000);
  w = CFG.pubWatchMove(w, 'end', { count: 0, notices: told.notices, fold: told.fold });
  assert.deepEqual([w.state, CFG.pubBadgeMark(w)], ['notice', '✓']);
  assert.throws(() => CFG.pubWatchMove(w, 'end'), /cannot end from notice/, 'an end is told once');
  assert.equal(CFG.pubWatchMove(w, 'seen').state, 'idle');
  // folding: live posts within a minute are one toast; later ones start a new one; a problem has its own
  let f = { notices: [], fold: null };
  for (const at of [0, 20000, 50000]) f = CFG.pubWatchAdd(f, { key: 'k' + at, kind: 'live', link: 'https://site.test/b/' + at }, at);
  assert.deepEqual(f.notices.map(x => [x.kind, x.sentence, x.link]), [['live', '3 posts are live.', 'https://site.test/b/50000']]);
  f = CFG.pubWatchAdd(f, { key: 'bad', kind: 'attention', sentence: 'Something went wrong while publishing.' }, 55000);
  f = CFG.pubWatchAdd(f, { key: 'k2', kind: 'live', link: '' }, 70000);
  assert.deepEqual(f.notices.map(x => x.sentence), ['3 posts are live.', 'Something went wrong while publishing.', 'Your post is live.']);
  assert.equal(CFG.pubBadgeMark({ state: 'notice', notices: f.notices }), '!');
  // what is told about a queued post, in words
  assert.equal(CFG.pubEntryNotice({ id: 'e', state: 'needs_look', why: 'left-out', at: 't' }).sentence, 'One post needs your look before it is published. ' + CFG.PUB_LOOK_WHY['left-out']);
  assert.equal(CFG.pubEntryNotice({ id: 'e', state: 'failed', failure: { step: 'publish', mode: 'failed_publish' }, paused_by: true }).sentence, 'Something went wrong while publishing. Your other posts wait until you deal with it.');
  assert.equal(CFG.pubEntryNotice({ id: 'e', state: 'queued' }), null);
  assert.equal(CFG.pubEntryNotice({ id: 'e', state: 'running', started_by: 'queue', run: 'r' }, { id: 'r', mode: 'planned', confirm: 'always' }).sentence, 'Your post is ready for your look before it is published.');
  assert.equal(CFG.pubEntryNotice({ id: 'e', state: 'running', started_by: 'owner', run: 'r' }, { id: 'r', mode: 'planned', confirm: 'always' }), null, 'the owner is looking at it in the dialog');
  assert.deepEqual([CFG.pubEntryLine({ state: 'queued', ahead: 2 }), CFG.pubEntryLine({ state: 'queued', ahead: 0 }), CFG.pubEntryLine({ state: 'queued', ahead: 1 }, { state: 'paused_for_run' })],
    ['queued · 2 ahead', 'queued · next', 'queued · waits until the post that went wrong is dealt with']);
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'published', published: { address: 'javascript:alert(1)' } }).link, '', 'the link is http(s) only');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'applying' }), null, 'still going: nothing to tell');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'abandoned' }), null, 'ended with nothing to tell');
  // each way of needing attention: ONE fixed sentence
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'failed_apply', failed_step: 'apply', failure: 'Your site’s main branch is not in step with GitHub. Bring it up to date, then try again.' }).sentence, 'Your site’s main branch is not in step with GitHub. Bring it up to date, then try again.');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'failed_publish', failed_step: 'publish', failure: '' }).sentence, 'Something went wrong while publishing.');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'interrupted_publishing' }).sentence, 'The companion stopped while your post was being published.');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'abandon_failed' }).sentence, 'Your site could not give this publish up.');
  assert.equal(CFG.pubNoticeOf({ id: 'r', mode: 'planned', confirm: 'always', review: 'agent-text' }).sentence, 'Your post is ready for your look before it is published.');
  assert.equal(CFG.pubBadgeMark({ state: 'notice', notices: [{ kind: 'attention' }] }), '!');
});

await test('Publish pressed on tab 3, the owner reading on tab 7: the badge shows a dot, then a tick, and the toast goes to tab 7, once', async () => {
  const B = browser(); const S = companion();
  const W = boot(B, S.fn);
  await tick(10);
  const r = await press(W, 'confirm', 3);
  assert.equal(r.ok, true, JSON.stringify(r));
  await tick(10);
  assert.deepEqual([B.storage['bfp:pub-watch'].state, B.storage['bfp:pub-watch'].count], ['watching', 1], 'the watch is kept in storage');
  assert.equal(lastBadge(B), '1');
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
  await W.send({ t: 'pub-notice-shown', run: told[0].msg.notice.run }, 7); await tick(5);
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
  const key = notices(B)[0].msg.notice.run;
  await W.send({ t: 'pub-notice-shown', run: key }, 7); await tick(5);
  assert.equal(B.storage['bfp:pub-watch'].state, 'notice', 'shown is not seen: it waits to be dismissed');
  // the owner moves to another page before dismissing: that page shows it
  await W.send({ t: 'hello', url: 'https://other.test/p' }, 9); await tick(500);
  assert.ok(notices(B).some(t => t.id === 9), 'the next page shows it');
  await W.send({ t: 'pub-notice-done', run: key }, 9); await tick(5);
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

await test('THE QUEUE: three presses in a row are counted on the badge; three going live within a minute are ONE toast ("3 posts are live"); a problem has its own; the look the dialog shows is not told', async () => {
  const B = browser(); const S = companion();
  S.run = { id: 'r1', token: 'tok', mode: 'planned', confirm: 'always', thread_ids: ['t1'] };   // the owner is looking at it in the dialog
  const entry = (id, state, extra = {}) => ({ id, state, run: '', started_by: 'queue', at: '2026-11-25T10:00:0' + id.slice(-1) + 'Z', ahead: 1, result: null, failure: null, ...extra });
  S.more = [entry('e2', 'queued'), entry('e3', 'queued'), entry('e4', 'queued')];
  S.fn = ((orig) => (p, m, b) => (p.startsWith('/blyg-publish/start') ? { ok: true, queued: S.more[2], queue: S.queue() } : orig(p, m, b)))(S.fn);
  const W = boot(B, S.fn);
  await tick(10);
  await W.send({ t: 'blyg-publish', op: 'start', thread_id: 't4', scope: 'one', url: 'https://e.test/a' }, 3); await tick(30);
  assert.deepEqual([B.storage['bfp:pub-watch'].state, lastBadge(B)], ['watching', '4']);
  assert.equal(notices(B).length, 0, 'the run waiting at the owner\'s own dialog is not told');
  const live = n => ({ state: 'published', result: { address: 'https://site.test/b/' + n, version: 1 } });
  S.run = { ...S.run, mode: 'published', published: { address: 'https://site.test/b/1' } };
  W.event({ type: 'blyg-publish', run: { id: 'r1', mode: 'published' } }); await tick(30);
  Object.assign(S.more[0], live(2)); W.event({ type: 'blyg-publish', queue: {} }); await tick(30);
  Object.assign(S.more[1], { state: 'failed', failure: { step: 'apply', line: '', mode: 'failed_apply' } }); W.event({ type: 'blyg-publish', queue: {} }); await tick(30);
  assert.equal(lastBadge(B), '1');
  Object.assign(S.more[2], live(4)); W.event({ type: 'blyg-publish', queue: {} }); await tick(30);
  const said = notices(B).map(t => t.msg.notice);
  const lives = said.filter(n => n.kind === 'live');
  assert.deepEqual(lives.map(n => n.sentence), ['Your post is live.', '2 posts are live.', '2 posts are live.', '3 posts are live.'], 'one folded toast, its count going up');
  assert.equal(new Set(lives.map(n => n.run)).size, 1, 'the same toast each time (it replaces itself)');
  assert.equal(lives.at(-1).link, 'https://site.test/b/4', 'the link is the newest post');
  assert.ok(said.some(n => n.kind === 'attention' && n.sentence === 'Something went wrong while building and checking your site.'), 'the problem has its own toast');
  assert.deepEqual([B.storage['bfp:pub-watch'].state, lastBadge(B)], ['notice', '!']);
});

await test('the end arrives while a look at the run is still under way: it gets a look of its own, and the owner is told (no poll needed)', async () => {
  const B = browser(); const S = companion();
  let slow = null;
  const fn = (p, m, body) => {
    if (p.startsWith('/blyg-publish/run') && slow) { const run = S.run; const queue = S.queue(); return new Promise(res => setTimeout(() => res({ ok: true, run, confirm: 'always', queue }), slow)); }
    return S.fn(p, m, body);
  };
  const W = boot(B, fn);
  await tick(10);
  await press(W, 'confirm', 3); await tick(10);
  S.run = { ...S.run, mode: 'publishing', kind: 'edit', version: 2 };
  slow = 80;
  W.event({ type: 'blyg-publish', run: { id: 'r1', mode: 'publishing' } });   // a look starts, and will read "publishing"
  await tick(20);
  S.run = { ...S.run, mode: 'published', published: { address: 'https://site.test/b/abc' } };
  W.event({ type: 'blyg-publish', run: { id: 'r1', mode: 'published' } });    // the end, while that look is still under way
  await tick(300);
  assert.equal(notices(B).length, 1, 'told, without waiting for the poll');
  assert.equal(notices(B)[0].msg.notice.kind, 'live');
});

await test('THE RACE: a run that fails and is given up before the start\'s answer comes back is still told (the act is never taken for old news)', async () => {
  const B = browser(); const S = companion();
  S.run = { id: 'r9', token: 'tok', mode: 'abandoned', thread_ids: ['t1'] };
  const failedEntry = { id: 'e9', state: 'failed', run: 'r9', started_by: 'owner', at: '2026-11-25T10:00:00Z', ahead: 0, result: null, failure: { step: 'plan', line: '', mode: 'failed_plan' } };
  S.queue = () => ({ state: 'running', entries: [failedEntry] });
  S.fn = ((orig) => (p, m, b) => (p.startsWith('/blyg-publish/start') ? { ok: true, run: { id: 'r9', mode: 'abandoned', token: 'tok' }, queue: S.queue() } : orig(p, m, b)))(S.fn);
  const W = boot(B, S.fn);
  await tick(10);
  await W.send({ t: 'blyg-publish', op: 'start', thread_id: 't1', scope: 'one', url: 'https://e.test/a' }, 3); await tick(40);
  const said = notices(B).map(t => t.msg.notice);
  assert.deepEqual(said.map(n => [n.kind, n.sentence]), [['attention', 'Something went wrong while checking that only this note changes.']]);
  assert.equal(lastBadge(B), '!');
});

await test('the queue\'s own notices: a pause for the site says what is wrong and what to press; an unreadable queue file says where it was kept', () => {
  const site = CFG.pubQueueNotices({ state: 'paused_for_site', paused: { say: 'Your site cannot publish right now. The node command is not on the companion’s PATH.', at: 't' }, entries: [] });
  assert.equal(site[0].sentence, 'Your site cannot publish right now. The node command is not on the companion’s PATH. Your queued posts are waiting: press “Try the queue again” in the drawer when it is fixed.');
  assert.equal(CFG.pubQueueNotices({ state: 'paused_for_run', paused: { say: '', at: 't' }, entries: [] }).length, 0, 'a run\'s pause is told by its entry');
  const un = CFG.pubQueueNotices({ state: 'running', unreadable: { say: 'Your queued posts could not be read when the companion started, so they were not published. The file was kept as it was: /x/q.json', at: 't' }, entries: [] });
  assert.match(un[0].sentence, /kept as it was: \/x\/q\.json$/);
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

await test('a toast drawn on a tab that is not showing waits there: it is spent, and its time starts, only when the tab is shown', async () => {
  let state = 'hidden';
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => state });
  const seen = [];
  const t = T.show({ kind: 'live', run: 'r9', sentence: 'Your post is live.', link: 'https://site.test/b/abc' }, { doc, isTrusted, liveMs: 40, onShown: n => seen.push(['shown', n.run]), onDone: n => seen.push(['done', n.run]) });
  await tick(100);
  assert.deepEqual(seen, [], 'not spent, not timed out, while nobody can see it');
  assert.ok(t.host.isConnected);
  assert.equal(t.mode(), 'waiting', 'a named mode, not a listener standing in for one');
  doc.dispatchEvent(new win.Event('visibilitychange'));
  assert.equal(t.mode(), 'waiting', 'still hidden: still waiting');
  state = 'visible';
  doc.dispatchEvent(new win.Event('visibilitychange'));
  assert.deepEqual(seen, [['shown', 'r9']]);
  await tick(500);
  assert.deepEqual(seen, [['shown', 'r9'], ['done', 'r9']], 'then it goes by itself as usual');
  assert.equal(t.mode(), 'closing');
  // dismissed while still waiting: closing, and the tab being shown later does nothing (the listener is gone)
  state = 'hidden';
  const seen2 = [];
  const t2 = T.show({ kind: 'live', run: 'r10', sentence: 'Your post is live.', link: '' }, { doc, isTrusted, liveMs: 40, onShown: n => seen2.push(['shown', n.run]), onDone: n => seen2.push(['done', n.run]) });
  t2.close();
  assert.equal(t2.mode(), 'closing');
  state = 'visible';
  doc.dispatchEvent(new win.Event('visibilitychange'));
  await tick(100);
  assert.deepEqual(seen2, [['done', 'r10']], 'never shown after it was closed');
  delete doc.visibilityState;
});

console.log(`${fails.length ? '✗' : '✓'} blygpublish-notice — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  · ' + f);
process.exit(fails.length ? 1 : 0);
