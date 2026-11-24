// hubstore.test.mjs — the Hub's storage seam (following.mjs): one store for the main document, the per-blyg ledgers and the
// bodies; conditional writes, and the merge made when the stored document moved meanwhile; how often a refresh and a tick write.
//
//   node --test test/hubstore.test.mjs
//
// No network: invented blygs held in memory (test/following-fake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as F from '../following.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';

const CFG = createRequire(import.meta.url)('../extension/config.js');
const A = 'https://alpha.web.test/notes/';
const B = 'https://beta.web.test/';
const day = n => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3600e3).toISOString();
const publish = (site, origin, n, { base = 0 } = {}) => {
  for (let k = 1; k <= n; k++) site.put(makeDoc({ id: idOf(base + k), origin, title: `Post ${k}`, body: `Words of post ${k}.`, created: day(base + k) }));
};

/** An engine over `store` (a memory store unless given), or over a file; `web` and the clock may be shared by two engines. */
function engine({ store, file, web = makeWeb(), clock = { t: Date.parse('2026-11-10T12:00:00Z') }, settings = {} } = {}) {
  if (!file && !store) store = F.memoryStore();
  const get = async (u, o) => { clock.t += 10; return web.get(u, o); };
  const f = F.createFollowing({ file, store, get, now: () => clock.t, getSettings: () => CFG.followingSettingsOf({ following_unread_target: 500, ...settings }).settings,
    timers: { set: () => ({}), clear: () => {} } });
  return { f, web, clock, store };
}
const feed = f => f.view({ limit: 1000 }).entries.map(e => e.head);
/** A memory store that records every write, by kind and name. */
function counted() {
  const s = F.memoryStore();
  const log = [];
  const put = s.put.bind(s);
  s.put = (kind, name, value, o) => { log.push(`${kind}:${name}`); return put(kind, name, value, o); };
  s.log = log;
  return s;
}

test('everything the engine keeps goes through the one store: with a memory store and no file, the whole life of a blyg works', async () => {
  const store = F.memoryStore();
  const { f, web } = engine({ store });
  publish(web.add(A), A, 5);
  f.confirmImport([{ origin: A }]);
  await f.refresh();
  assert.equal(feed(f).length, 5);
  const k = f.keyFor(A, idOf(3));
  assert.match(f.bodyHtml(k), /Words of post 3/, 'the body is a body in the store');
  f.readMove(k, 'tick');
  assert.equal(f.bodyHtml(k), '', 'and is deleted with the tick');
  assert.deepEqual(store.list('state'), ['following']);
  assert.deepEqual(store.list('ledger'), [F.ledgerName(A)]);
  assert.deepEqual(store.get('ledger', F.ledgerName(A)).value.ids.map(p => p[0]), [idOf(3)]);
  assert.equal(store.list('body').length, 4);
  assert.equal(await f.untick(k), 'new');
  assert.equal(store.list('body').length, 5);
  f.unfollow(A);
  assert.equal(store.list('body').length, 0);
  // and a second engine over the same store sees exactly what the first left
  const second = engine({ store, web });
  assert.deepEqual(second.f.listBlygs(), []);
});

test('the main document holds no ledger; a tick writes the main document and that blyg\'s ledger, no other', async () => {
  const store = counted();
  const { f, web } = engine({ store });
  publish(web.add(A), A, 3);
  publish(web.add(B), B, 3, { base: 100 });
  f.confirmImport([{ origin: A }, { origin: B }]);
  await f.refresh();
  assert.ok(!('ledgers' in store.get('state', 'following').value));
  store.log.length = 0;
  f.readMove(f.keyFor(A, idOf(2)), 'tick');
  assert.deepEqual(store.log, ['state:following', `ledger:${F.ledgerName(A)}`]);
  store.log.length = 0;
  f.open(f.keyFor(B, idOf(101)));
  assert.deepEqual(store.log, ['state:following'], 'opening writes no ledger at all');
});

test('a refresh writes the main document every 10 blygs and at its end, not after each blyg', async () => {
  const store = counted();
  const { f, web } = engine({ store, settings: { following_run_requests: 2000, following_run_seconds: 600 } });
  const origins = Array.from({ length: 25 }, (_, i) => `https://s${i}.web.test/`);
  origins.forEach((o, i) => publish(web.add(o), o, 2, { base: i * 100 }));
  f.confirmImport(origins.map(origin => ({ origin })));
  store.log.length = 0;
  const s = await f.refresh();
  assert.equal(s.blygs, 25);
  const states = store.log.filter(x => x.startsWith('state:')).length;
  assert.ok(states <= 2 + 2, `${states} writes of the main document for 25 blygs (at 10, 20, after the backfill, and the last)`);
  const ledgerWrites = store.log.filter(x => x.startsWith('ledger:')).length;
  assert.ok(ledgerWrites >= 25 && ledgerWrites <= 50, `each ledger once, or twice when it changed again after a periodic save (${ledgerWrites})`);
  store.log.length = 0;
  await f.refresh();
  assert.ok(store.log.filter(x => x.startsWith('ledger:')).length < 25, 'a ledger that did not change is not written');
  assert.equal(F.LIMITS.saveEveryBlygs, 10);
});

test('a conditional write: what another engine saved meanwhile is merged, never written over (a tick there survives a refresh here)', async () => {
  for (const kind of ['memory', 'files']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubstore-'));
    const opts = kind === 'memory' ? { store: F.memoryStore() } : { file: path.join(dir, 'following.json') };
    const web = makeWeb(), clock = { t: Date.parse('2026-11-10T12:00:00Z') };
    const site = web.add(A);
    publish(site, A, 4);
    const one = engine({ ...opts, web, clock });
    one.f.confirmImport([{ origin: A }]);
    await one.f.refresh();
    // a second process (or a second invocation of a serverless host) reads the same store and ticks post 2
    const two = engine({ ...opts, web, clock });
    assert.equal(two.f.readMove(two.f.keyFor(A, idOf(2)), 'tick'), 'archived');
    // meanwhile the first, which never saw that tick, refreshes: post 3 has new words
    site.put(makeDoc({ id: idOf(3), origin: A, title: 'Post 3', body: 'New words of post 3.', version: 2, created: day(3), updated: day(50) }));
    const s = await one.f.refresh();
    assert.equal(s.edited, 1);
    // what is stored has both: the tick (theirs) and the edit (ours), and the ledger keeps the ticked id
    const three = engine({ ...opts, web, clock });
    const reads = Object.fromEntries(Object.values(three.f.view({ view: 'archive' }).archive).map(l => [l.title, 'archived']));
    assert.deepEqual(reads, { 'Post 2': 'archived' }, kind);
    assert.ok(!feed(three.f).some(h => h.id === idOf(2)), `${kind}: the tick was not undone`);
    assert.equal(feed(three.f).find(h => h.id === idOf(3)).version, 2, `${kind}: the refresh's own work was kept`);
    assert.equal(one.f.itemByKey(one.f.keyFor(A, idOf(2))).read, 'archived', `${kind}: and the first engine now holds it too`);
    const led = kind === 'memory' ? opts.store.get('ledger', F.ledgerName(A)).value
      : JSON.parse(fs.readFileSync(path.join(dir, 'following-ledgers', `${F.ledgerName(A)}.json`), 'utf8'));
    assert.deepEqual(led.ids.map(p => p[0]), [idOf(2)], `${kind}: the ledger merged too`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the merges, unit by unit: theirs wins where both changed, ours stands where only we did; ledger ids are a set', () => {
  const base = { items: { a: { read: 'new' }, b: { read: 'new' }, c: { read: 'new' } }, blygs: { x: { state: 'active' } }, last_run: null };
  const ours = structuredClone(base); ours.items.a.read = 'opened'; ours.items.b.read = 'opened'; ours.items.d = { read: 'new' }; ours.last_run = { at: 1 };
  const theirs = structuredClone(base); theirs.items.b = { read: 'archived' }; delete theirs.items.c; theirs.blygs.x.state = 'paused';
  const dropped = F.mergeState(ours, (() => { const m = new Map(); for (const [k, v] of Object.entries(base.items)) m.set(`items\u0000${k}`, JSON.stringify(v)); m.set('blygs\u0000x', JSON.stringify(base.blygs.x)); m.set('last_run', 'null'); return m; })(), theirs);
  assert.deepEqual(ours.items, { a: { read: 'opened' }, b: { read: 'archived' }, d: { read: 'new' } });
  assert.equal(ours.blygs.x.state, 'paused');
  assert.deepEqual(ours.last_run, { at: 1 });
  assert.equal(dropped, 1, 'our change to b was dropped');
  const lb = { ids: [['i1', 1], ['i2', 2]], bad: { b1: [1, 1] }, gone: null, backfill: 'more', queue: [] };
  const lo = { ids: [['i1', 1], ['i3', 3]], bad: {}, gone: F.addGone(null, ['g1']), backfill: 'caught_up', queue: [] };
  const lt = { ids: [['i1', 1], ['i2', 2], ['i4', 4]], bad: { b1: [1, 1], b2: [1, 2] }, gone: F.addGone(null, ['g2']), backfill: 'more', queue: [] };
  F.mergeLedger(lo, lb, lt);
  assert.deepEqual(lo.ids.map(p => p[0]).sort(), ['i1', 'i3', 'i4'], 'what either side added stays, what either removed goes');
  assert.deepEqual(Object.keys(lo.bad), ['b2']);
  assert.ok(['g1', 'g2'].every(F.goneTest(lo)), 'the gone filters are joined');
  assert.equal(lo.backfill, 'caught_up');
});

test('the layout on disk: following.json (readable as before), following-bodies/, following-ledgers/; a temp file a crash left is swept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubstore-'));
  const file = path.join(dir, 'following.json');
  const { f, web } = engine({ file });
  publish(web.add(A), A, 2);
  f.confirmImport([{ origin: A }]);
  await f.refresh();
  f.readMove(f.keyFor(A, idOf(1)), 'tick');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(doc).sort(), ['blygs', 'inbox', 'items', 'kept', 'last_run']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['following-bodies', 'following-ledgers', 'following.json']);
  const stale = path.join(dir, 'following-bodies', 'abc.html.tmp.999');
  fs.writeFileSync(stale, 'x');
  const old = new Date(Date.now() - 2 * 3600e3);
  fs.utimesSync(stale, old, old);
  f.sweepBodies();
  assert.ok(!fs.existsSync(stale));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('"Tick all shown" is taken 100 at a time: a request naming more ticks the first 100 (the page sends the rest)', async () => {
  const { f, web } = engine({ settings: { following_max_items_per_blyg: 2000, following_run_requests: 2000, following_run_seconds: 600 } });
  publish(web.add(A), A, 150);
  f.confirmImport([{ origin: A }]);
  for (let i = 0; i < 3; i++) await f.refresh();
  const keys = feed(f).map(h => h.key);
  assert.equal(keys.length, 150);
  assert.equal(F.LIMITS.tickBatch, 100);
  const t0 = performance.now();
  assert.equal(f.tickMany(keys), 100);
  assert.ok(performance.now() - t0 < 1000);
  assert.equal(feed(f).length, 50);
  assert.equal(f.tickMany(keys.slice(100)), 50);
});

test('a tick saves first and deletes the body after (a crash in between leaves a body that the sweep on load removes)', async () => {
  const store = counted();
  const del = store.delete.bind(store);
  store.delete = (kind, name) => { store.log.push(`delete ${kind}:${name}`); return del(kind, name); };
  const { f, web } = engine({ store });
  publish(web.add(A), A, 2);
  f.confirmImport([{ origin: A }]);
  await f.refresh();
  const k = f.keyFor(A, idOf(1));
  store.log.length = 0;
  f.readMove(k, 'tick');
  assert.deepEqual(store.log, ['state:following', `ledger:${F.ledgerName(A)}`, `delete body:${k}`]);
  // the crash case: a body left behind is swept when the state is next loaded
  store.put('body', 'abcdef0123456789abcdef01', '<p>left behind</p>');
  const again = engine({ store, web });
  again.f.view();
  await new Promise(res => setImmediate(res));
  assert.ok(!store.list('body').includes('abcdef0123456789abcdef01'));
});
