#!/usr/bin/env node
// THE WORKER'S PUBLISH PATH (extension/background.js), with no browser: the worker runs in a vm with a stand-in `chrome`
// and a recording `fetch`.
//
// What this pins down: the general `api` message refuses every /blyg-publish and /blyg-home path (the settings are the
// companion's own page, never the extension's, and a publish goes only through the named operations); the named operations
// forward exactly the routes and fields config.js says; confirm and retry go through only while the TAB holds a one-use
// offer that a start or a resume from that tab opened (and a second confirm needs a second offer); another tab never holds
// it; an unknown operation or scope goes nowhere.
//
//   node frontends/plugin/test/blygpublish-background.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
let pass = 0; const fails = [];
async function test(name, fn) { try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } }

function boot({ refuse = 0 } = {}) {
  let live = null;
  const listeners = [];
  const fetched = [];
  const make = (p) => new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (p === 'chrome.runtime.onMessage' && k === 'addListener') return fn => { listeners.push(fn); };
      if (p === 'chrome.tabs' && k === 'sendMessage') return () => Promise.resolve();
      if (p === 'chrome.tabs' && k === 'query') return () => Promise.resolve([]);
      if (/^chrome\.storage\.\w+$/.test(p) && k === 'get') return (_k, cb) => { if (typeof cb === 'function') cb({}); return Promise.resolve({}); };
      return make(`${p}.${String(k)}`);
    },
    apply(_t, _this, args) { const cb = args[args.length - 1]; if (typeof cb === 'function' && !/addListener$/.test(p)) { try { cb(); } catch { } } return Promise.resolve(undefined); },
  });
  class FakeWS { constructor() { this.closed = false; } close() { } send() { } }
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Promise, Map, Set, JSON, Math, Date, TextEncoder, TextDecoder, btoa, atob, AbortController,
    WebSocket: FakeWS,
    fetch: async (url, init) => {
      fetched.push({ url, method: init && init.method, body: init && init.body ? JSON.parse(init.body) : undefined });
      if (live) { const r = live(url, init && init.method, init && init.body ? JSON.parse(init.body) : undefined); return { ok: r.ok, status: r.ok ? 200 : r.status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(r) }; }
      const run = { id: 'r1', token: 't1', mode: 'planned', can: ['confirm', 'cancel'] };
      if (refuse) return { ok: false, status: refuse, text: async () => JSON.stringify({ ok: false, error: 'a publish run is already under way (planning); finish or abandon it first' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, run }) };
    },
    chrome: make('chrome'),
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f }); };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  const send = (msg, tabId = 1) => new Promise(resolve => { listeners[0](msg, { tab: { id: tabId } }, resolve); });
  return { send, fetched, ours: () => fetched.filter(f => /blyg-(publish|home)/.test(f.url)), ctxFetch: f => { live = f; } };
}
const pub = (W, op, extra = {}, tab = 1) => W.send({ t: 'blyg-publish', op, url: 'https://example.com/a', ...extra }, tab);

await test('the general api door is shut on every publish route and on the settings', async () => {
  const W = boot();
  for (const p of ['/blyg-publish/confirm', '/blyg-publish/start', '/blyg-publish/run?x=1', '/blyg-home', '/blyg-home/page', '/blyg-publish/']) {
    for (const method of ['GET', 'POST']) {
      const r = await W.send({ t: 'api', method, path: p, body: { run: 'r1', token: 't1' } });
      assert.equal(r.ok, false, `${method} ${p}`);
    }
  }
  assert.deepEqual(W.ours(), [], 'nothing reached the companion');
  const fine = await W.send({ t: 'api', method: 'GET', path: '/blyg-something-else-entirely' });
  assert.equal(fine.ok, true, 'other routes are untouched by the rule');
});

await test('the api door is shut on every SPELLING of a blyg route (the fetch\'s own URL parser decides), and still open for ordinary paths', async () => {
  const W = boot();
  for (const p of ['/blyg-home#x', '/./blyg-home', '\\blyg-home', '/x/../blyg-home', '/%2e/blyg-home', '/blyg-home/../blyg-home', '//blyg-publish/start', '/BLYG-HOME', '/blyg-publish%2Fconfirm', '/a/%2e%2e/blyg-publish/run', '/blyg-home?x=1#y', '%5cblyg-home']) {
    const r = await W.send({ t: 'api', method: 'POST', path: p, body: {} });
    assert.equal(r.ok, false, p);
  }
  assert.deepEqual(W.ours(), [], 'nothing reached the companion');
  for (const p of ['/page?url=https%3A%2F%2Fa.test%2Fblyg-home', '/index', '/files/a%20b.png']) assert.equal((await W.send({ t: 'api', method: 'GET', path: p })).ok, true, p);
});

await test('start forwards exactly url, thread_id and scope; an odd scope or operation goes nowhere', async () => {
  const W = boot();
  const r = await pub(W, 'start', { thread_id: 't9', scope: 'above', extra_field: 'ignored', run: 'x' });
  assert.equal(r.ok, true);
  assert.deepEqual(W.ours().map(f => [f.method, f.url.replace(/^https?:\/\/[^/]+/, ''), f.body]), [['POST', '/blyg-publish/start', { url: 'https://example.com/a', thread_id: 't9', scope: 'above', confirm: '' }]]);
  for (const bad of [{ op: 'start', scope: 'everything' }, { op: 'nope' }, { op: '__proto__' }, { op: 'constructor' }, { op: undefined }]) {
    assert.equal((await pub(W, bad.op, { scope: bad.scope, thread_id: 't' })).ok, false, JSON.stringify(bad));
  }
  assert.equal(W.ours().length, 1);
});

await test('confirm, retry and continue need the tab\'s one-use offer FOR THAT ACT, opened by an `arm` from that tab; it is spent by use; another tab or act never has it; start and run open nothing', async () => {
  const W = boot();
  const no = await pub(W, 'confirm', { run: 'r1', token: 't1' });
  assert.deepEqual([no.ok, no.code], [false, 'offer-lapsed']);
  assert.deepEqual(W.ours(), [], 'refused in the worker: nothing was sent');
  await pub(W, 'start', { thread_id: 't', scope: 'one' }, 1);
  assert.equal((await pub(W, 'confirm', { run: 'r1', token: 't1' }, 1)).ok, false, 'a start opens nothing');
  assert.equal((await pub(W, 'arm', { act: 'publish-everything' }, 1)).ok, false, 'an arm names one of the acts');
  await pub(W, 'arm', { act: 'confirm' }, 1);
  assert.equal((await pub(W, 'confirm', { run: 'r1', token: 't1' }, 2)).ok, false, 'tab 2 has no offer');
  assert.equal((await pub(W, 'retry', { run: 'r1', token: 't1' }, 1)).ok, false, 'an offer for confirm is not one for retry');
  const yes = await pub(W, 'confirm', { run: 'r1', token: 't1' }, 1);
  assert.equal(yes.ok, true);
  assert.deepEqual(W.ours().at(-1).body, { run: 'r1', token: 't1' }, 'only the run and its token');
  assert.equal((await pub(W, 'confirm', { run: 'r1', token: 't1' }, 1)).ok, false, 'spent: a second confirm needs a second arm');
  await pub(W, 'arm', { act: 'retry' }, 1);
  assert.equal((await pub(W, 'retry', { run: 'r1', token: 't1' }, 1)).ok, true, 'an arm for retry opens one for retry');
  assert.equal(W.ours().filter(f => /confirm/.test(f.url)).length, 1, 'the companion saw exactly one confirm');
  const V = boot();
  await pub(V, 'run', {}, 1);
  assert.equal((await pub(V, 'confirm', { run: 'r', token: 't' }, 1)).ok, false, 'a plain look opens nothing');
});

// THE OWNER'S FIRST REAL USE (2026-11-24): a retry spent the tab's one offer, so the Publish that followed was refused ("Review the
// publish again to continue"). Now every act arms itself: start → plan fails → retry → planned → confirm → applying, and the same
// through continue, each act going through the worker to a companion that holds the run.
function bootLive() {
  const W = boot();
  const st = { mode: 'idle', seen: [] };
  const runOf = () => ({ id: 'r1', token: 't1', mode: st.mode, can: st.mode === 'planned' ? ['confirm', 'cancel'] : /^failed_/.test(st.mode) ? ['retry', 'abandon'] : /^interrupted_/.test(st.mode) ? ['continue', 'abandon'] : [] });
  W.ctxFetch((url, method, body) => {
    const p = url.replace(/^https?:\/\/[^/]+/, '');
    st.seen.push(p);
    const go = (from, to) => { if (!from.includes(st.mode)) return { ok: false, status: 409, error: `cannot ${p} from ${st.mode}` }; st.mode = to; return { ok: true, run: runOf() }; };
    if (p === '/blyg-publish/run') return { ok: true, run: runOf(), confirm: 'always' };
    if (p === '/blyg-publish/start') return go(['idle'], 'planning');
    if (p === '/blyg-publish/retry') return go(['failed_plan', 'failed_apply'], st.mode === 'failed_plan' ? 'planning' : 'applying');
    if (p === '/blyg-publish/confirm') return go(['planned'], 'applying');
    if (p === '/blyg-publish/continue') return go(['interrupted_applying'], 'applying');
    return { ok: false, status: 404, error: 'no' };
  });
  return { W, st };
}
await test('(b) start → plan fails → retry → planned → confirm → applying, every act through the worker; then interrupted → continue → applying → failed → retry', async () => {
  const { W, st } = bootLive();
  const act = async op => { const a = await pub(W, 'arm', { act: op }, 7); assert.equal(a.ok, true, 'arm ' + op); return pub(W, op, { run: 'r1', token: 't1' }, 7); };
  assert.equal((await pub(W, 'start', { thread_id: 't', scope: 'one', confirm: 'always' }, 7)).ok, true);
  st.mode = 'failed_plan';
  assert.equal((await act('retry')).run.mode, 'planning');
  st.mode = 'planned';
  const c = await act('confirm');
  assert.deepEqual([c.ok, c.run && c.run.mode], [true, 'applying'], 'the Publish after a retry goes through: ' + JSON.stringify(c));
  st.mode = 'interrupted_applying';
  assert.equal((await act('continue')).run.mode, 'applying');
  st.mode = 'failed_apply';
  assert.equal((await act('retry')).run.mode, 'applying', 'and the act after a continue goes through');
  assert.deepEqual(st.seen.filter(x => x.startsWith('/blyg-publish/') && x !== '/blyg-publish/run'), ['/blyg-publish/start', '/blyg-publish/retry', '/blyg-publish/confirm', '/blyg-publish/continue', '/blyg-publish/retry']);
  assert.equal((await pub(W, 'confirm', { run: 'r1', token: 't1' }, 7)).code, 'offer-lapsed', 'and no act without its own arm');
});

await test('cancel, abandon and run need no offer; each forwards the right route and nothing more', async () => {
  const W = boot();
  await pub(W, 'cancel', { run: 'r1', token: 't1', evil: 'x' });
  await pub(W, 'abandon', { run: 'r1', token: 't1' });
  await pub(W, 'run');
  assert.deepEqual(W.ours().map(f => [f.method, f.url.replace(/^https?:\/\/[^/]+/, ''), f.body]), [
    ['POST', '/blyg-publish/cancel', { run: 'r1', token: 't1' }], ['POST', '/blyg-publish/abandon', { run: 'r1', token: 't1', stop: '' }], ['GET', '/blyg-publish/run', undefined]]);
});

await test('a refusal from the companion comes back as its own words, and opens no offer', async () => {
  const W = boot({ refuse: 409 });
  const r = await pub(W, 'start', { thread_id: 't', scope: 'one' });
  assert.deepEqual([r.ok, r.status, /already under way/.test(r.error)], [false, 409, true]);
  assert.equal((await pub(W, 'confirm', { run: 'r', token: 't' })).code, 'offer-lapsed');
});

await test('continue (an interrupted step carried on) needs the tab\'s one-use offer like confirm and retry, and goes to its own route', async () => {
  const W = boot();
  assert.equal((await pub(W, 'continue', { run: 'r1', token: 't1' })).code, 'offer-lapsed');
  await pub(W, 'arm', { act: 'continue' }, 1);
  assert.equal((await pub(W, 'continue', { run: 'r1', token: 't1' }, 1)).ok, true);
  assert.deepEqual(W.ours().at(-1).url.replace(/^https?:\/\/[^/]+/, ''), '/blyg-publish/continue');
  assert.equal((await pub(W, 'continue', { run: 'r1', token: 't1' }, 1)).ok, false, 'spent');
});

console.log(`${fails.length ? '✗' : '✓'} blygpublish-background — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  · ' + f);
process.exit(fails.length ? 1 : 0);
