// hubbounds.test.mjs — the Hub engine's smaller guards and bounds, each tested on its own (the mutants a review found alive):
// the re-reads around awaits, the ledger's conditional write, the back-off lists and their bounds, the top-up's checks and caps,
// the burst order on both fetch paths, the clamp on the newest date seen, a paused backfill, and the inbox's late answer.
//
//   node --test test/hubbounds.test.mjs
//
// No network: invented blygs held in memory (test/following-fake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as F from '../following.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';

const CFG = createRequire(import.meta.url)('../extension/config.js');
const A = 'https://alpha.web.test/notes/';
const day = n => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3600e3).toISOString();
const T = m => new Date(Date.parse('2026-11-05T10:00:00Z') + m * 60e3).toISOString();

/** An engine over a memory store; `gate(suffix)` holds the next request ending in suffix until released. */
function engine({ store = F.memoryStore(), web = makeWeb(), clock = { t: Date.parse('2026-11-10T12:00:00Z') }, settings = {}, getSettings } = {}) {
  const gate = { suffix: null, release: null, reached: null };
  const get = async (u, o) => {
    clock.t += 10;
    if (gate.suffix && String(u).endsWith(gate.suffix)) {
      gate.suffix = null;
      await new Promise(res => { gate.release = res; if (gate.reached) gate.reached(); });
    }
    return web.get(u, o);
  };
  const f = F.createFollowing({ store, get, now: () => clock.t, getSettings: getSettings || (() => CFG.followingSettingsOf({ following_unread_target: 500, ...settings }).settings),
    timers: { set: () => ({}), clear: () => {} } });
  const holdAt = suffix => { gate.suffix = suffix; return new Promise(res => { gate.reached = res; }); };
  return { f, web, clock, store, holdAt, release: () => gate.release(), led: o => (store.get('ledger', F.ledgerName(o)) || {}).value,
    feed: () => f.view({ limit: 1000 }).entries.map(e => e.head) };
}
const publish = (site, n, { base = 0, created = k => day(base + k) } = {}) => {
  for (let k = 1; k <= n; k++) site.put(makeDoc({ id: idOf(base + k), origin: site.origin, title: `Post ${k}`, body: `Words of post ${k}.`, created: created(k) }));
};
const docAsked = (web, n) => web.requests.filter(u => u.endsWith(`/items/${idOf(n)}.json`)).length;

test('ingest checks the record BEFORE the request too: a post unticked while the refresh was busy elsewhere is not asked for again', async () => {
  const E = engine();
  const site = E.web.add(A);
  publish(site, 2);
  E.f.confirmImport([{ origin: A }]);
  await E.f.refresh();
  E.f.tickMany([E.f.keyFor(A, idOf(1)), E.f.keyFor(A, idOf(2))]);
  for (const n of [1, 2]) site.put(makeDoc({ id: idOf(n), origin: A, title: `Post ${n}`, body: `Words of post ${n}.`, version: 2, created: day(n), updated: day(50 + n) }));
  const reached = E.holdAt(`items/${idOf(2)}.json`); // post 2 is fetched first (newest); post 1 waits behind it in the same refresh
  const run = E.f.refresh();
  await reached;
  const before = docAsked(E.web, 1);
  assert.equal(await E.f.untick(E.f.keyFor(A, idOf(1))), 'new');
  E.release();
  await run;
  assert.equal(docAsked(E.web, 1), before + 1, 'only the untick asked for it: the refresh saw it had changed and did not');
});

test('a top-up checks the blyg is still followed after each request: one unfollowed meanwhile gets nothing written', async () => {
  const E = engine({ settings: { following_unread_target: 3 } });
  publish(E.web.add(A), 30);
  E.f.confirmImport([{ origin: A }]);
  await E.f.refresh();
  E.f.tickMany(E.feed().map(h => h.key));
  const next = E.led(A).queue[0].id;
  const reached = E.holdAt(`items/${next}.json`);
  const t = E.f.topUp();
  await reached;
  E.f.unfollow(A, { forget: true });
  E.release();
  const out = await t;
  assert.equal(out.new, 0);
  assert.equal(E.f.keyFor(A, next), '');
});

test('the ledger is written conditionally: two engines ticking different posts of one blyg both end up in its ids', async () => {
  const store = F.memoryStore(), web = makeWeb(), clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  publish(web.add(A), 3);
  const one = engine({ store, web, clock });
  one.f.confirmImport([{ origin: A }]);
  await one.f.refresh();
  const two = engine({ store, web, clock });
  one.f.listBlygs(); two.f.listBlygs(); // both have read the ledger
  one.f.readMove(one.f.keyFor(A, idOf(1)), 'tick');
  two.f.readMove(two.f.keyFor(A, idOf(2)), 'tick');
  assert.deepEqual(one.led(A).ids.map(p => p[0]).sort(), [idOf(1), idOf(2)].sort());
});

test('a missing document (404) goes on the `later` list with a back-off that doubles; the list is bounded at laterPerBlyg', async () => {
  const E = engine({ settings: { following_unread_target: 500 } });
  const site = E.web.add(A);
  publish(site, 2);
  const real = E.web.get;
  E.web.get = async (u, o) => (String(u).endsWith(`${idOf(1)}.json`) ? (E.web.requests.push(String(u)), { status: 404, url: String(u), text: 'gone' }) : real(u, o));
  E.f.confirmImport([{ origin: A }]);
  await E.f.refresh();
  const [until1, n1] = E.led(A).later[idOf(1)];
  assert.equal(n1, 1);
  const first = until1 - E.clock.t;
  await E.f.refresh();
  assert.equal(docAsked(E.web, 1), 1, 'not asked again within its back-off');
  E.clock.t = until1 + 1;
  await E.f.refresh();
  const [until2, n2] = E.led(A).later[idOf(1)];
  assert.equal(n2, 2);
  assert.ok(Math.abs((until2 - E.clock.t) - 2 * first) < 5000, 'the back-off doubled');
  assert.deepEqual(E.led(A).bad, {}, 'and it is not marked bad');
  // bounded: with laterPerBlyg ids already waiting, a new missing one is not added (it is simply asked again next run)
  const full = engine({ settings: { following_unread_target: 500 } });
  const fs2 = full.web.add(A);
  publish(fs2, 1);
  publish(fs2, F.LIMITS.laterPerBlyg, { base: 5000 }); // listed, and waiting on their back-off
  full.store.put('ledger', F.ledgerName(A), { origin: A, ids: [], later: Object.fromEntries(Array.from({ length: F.LIMITS.laterPerBlyg }, (_, i) => [idOf(5001 + i), [full.clock.t + 3600e3, 1]])) });
  const realF = full.web.get;
  full.web.get = async (u, o) => (String(u).endsWith(`${idOf(1)}.json`) ? { status: 404, url: String(u), text: 'gone' } : realF(u, o));
  full.f.confirmImport([{ origin: A }]);
  await full.f.refresh();
  assert.equal(Object.keys(full.led(A).later).length, F.LIMITS.laterPerBlyg);
  assert.ok(!(idOf(1) in full.led(A).later));
});

test('badTotal: when all blygs together remember 2,000 unusable documents, the blyg that serves one more pauses its reading back', async () => {
  const E = engine({ settings: { following_unread_target: 500 } });
  const others = Array.from({ length: 20 }, (_, i) => `https://other${i}.web.test/`); // not reachable: their ledgers stay as they are
  for (const [j, o] of others.entries()) E.store.put('ledger', F.ledgerName(o), { origin: o, ids: [], bad: Object.fromEntries(Array.from({ length: 100 }, (_, k) => [idOf(1e6 + j * 1000 + k), [1, E.clock.t]])), backfill: 'more' });
  assert.equal(20 * 100, F.LIMITS.badTotal);
  const site = E.web.add(A);
  publish(site, 5);
  const real = E.web.get;
  E.web.get = async (u, o) => (String(u).endsWith(`${idOf(3)}.json`) ? { status: 200, url: String(u), text: '{"no": "document"}' } : real(u, o));
  E.f.confirmImport([{ origin: A }, ...others.map(origin => ({ origin }))]);
  await E.f.refresh();
  assert.equal(E.led(A).backfill, 'paused_bad_documents', 'only 1 of its own, but 2,001 in all');
});

test('a top-up skips an entry in the gone filter, takes at most topupRequests requests, and a queue is cut to queuePerBlyg on load', async () => {
  const E = engine({ settings: { following_unread_target: 500 } });
  publish(E.web.add(A), 100);
  E.f.confirmImport([{ origin: A }]);
  await E.f.refresh(); // 51..100 read
  E.f.tickMany(E.feed().map(h => h.key).slice(0, 50));
  const queue = Array.from({ length: 50 }, (_, i) => ({ id: idOf(50 - i), kind: 'fragment', version: 1, created: day(50 - i), updated: day(50 - i) }));
  const l = E.led(A);
  E.store.put('ledger', F.ledgerName(A), { ...l, queue: [{ id: idOf(999), kind: 'fragment', version: 1, created: day(1), updated: day(1) }, ...queue], gone: F.addGone(null, [idOf(999)]) });
  const fresh = engine({ store: E.store, web: E.web, clock: E.clock, settings: { following_unread_target: 500 } });
  E.web.requests.length = 0;
  const out = await fresh.f.topUp();
  assert.equal(out.requests, F.LIMITS.topupRequests, 'the request cap');
  assert.equal(docAsked(E.web, 999), 0, 'the one in the gone filter is not asked for');
  assert.ok(fresh.led(A).queue.length <= F.LIMITS.queuePerBlyg - F.LIMITS.topupRequests, `the queue was cut to ${F.LIMITS.queuePerBlyg} on load`);
});

test('burst order on the FRESH path: a thread is fetched before its parts even when they are older and the run has room for three', async () => {
  const E = engine({ settings: { following_unread_target: 1, following_run_requests: 5 } });
  const site = E.web.add(A);
  publish(site, 1, { created: () => T(-10000) });
  E.f.confirmImport([{ origin: A }]);
  await E.f.refresh();
  const parts = [];
  for (let k = 1; k <= 6; k++) { const id = idOf(100 + k); parts.push({ origin: A, id, version: 1 }); site.put(makeDoc({ id, origin: A, title: `Part ${k}`, created: new Date(E.clock.t + k * 1000).toISOString() })); }
  site.put(makeDoc({ id: idOf(99), origin: A, kind: 'thread', title: 'Thread', created: new Date(E.clock.t + 60e3).toISOString(), transclusions: parts }));
  E.clock.t += 120e3;
  await E.f.refresh();
  assert.equal(docAsked(E.web, 99), 1, 'the thread was among the three fetched');
  assert.ok(!E.feed().some(h => /^Part/.test(h.title)));
});

test('burst order on the BACKFILL path: newest first would fetch the parts; the thread comes first', async () => {
  const E = engine({ settings: { following_unread_target: 500, following_run_requests: 5 } });
  const site = E.web.add(A);
  const parts = [];
  for (let k = 1; k <= 6; k++) { const id = idOf(100 + k); parts.push({ origin: A, id, version: 1 }); site.put(makeDoc({ id, origin: A, title: `Part ${k}`, created: T(5 + k / 10) })); }
  site.put(makeDoc({ id: idOf(99), origin: A, kind: 'thread', title: 'Thread', created: T(0), transclusions: parts }));
  E.f.confirmImport([{ origin: A }]);
  await E.f.refresh();
  assert.equal(docAsked(E.web, 99), 1);
  assert.ok(!E.feed().some(h => /^Part/.test(h.title)));
});

test('the newest date seen from a blyg is clamped to the fetch time: a post dated in the future does not stop later posts being fresh', async () => {
  const E = engine({ settings: { following_unread_target: 1 } });
  const site = E.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'From the future', created: '2999-01-01T00:00:00Z' }));
  E.f.confirmImport([{ origin: A }]);
  await E.f.refresh();
  assert.ok(E.led(A).seen_until <= E.clock.t, 'clamped');
  E.clock.t += 60e3;
  site.put(makeDoc({ id: idOf(2), origin: A, title: 'Today', created: new Date(E.clock.t).toISOString() }));
  const s = await E.f.refresh();
  assert.equal(s.new, 1, 'fresh, though the Feed is at its target');
});

test('paused_bad_documents stops reading back: none of the blyg\'s older posts is fetched while it is paused', async () => {
  const E = engine({ settings: { following_unread_target: 500 } });
  publish(E.web.add(A), 30);
  E.store.put('ledger', F.ledgerName(A), { origin: A, ids: [], backfill: 'paused_bad_documents',
    bad: Object.fromEntries(Array.from({ length: F.LIMITS.badPerBlyg }, (_, k) => [idOf(1e6 + k), [1, E.clock.t]])) });
  E.f.confirmImport([{ origin: A }]);
  const s = await E.f.refresh();
  assert.equal(s.backfilled, 0);
  assert.equal(E.web.requests.filter(u => /items\/(?!index)/.test(u)).length, 0);
  assert.deepEqual(E.led(A).queue, [], 'and nothing is lined up for a top-up either');
});

test('the inbox: an answer that arrives after the inbox was set to another address is not written into it', async () => {
  let settings = { inbox_api_url: 'https://inbox.web.test/api', inbox_token_file: '/nonexistent/token' };
  let release;
  const store = F.memoryStore();
  const f = F.createFollowing({ store, get: async u => { await new Promise(res => { release = res; }); return { status: 200, url: String(u), text: JSON.stringify({ mentions: [] }) }; },
    getSettings: () => CFG.followingSettingsOf(settings).settings, readToken: () => 'tok-123456789', timers: { set: () => ({}), clear: () => {} } });
  const run = f.refresh();
  while (!release) await new Promise(res => setImmediate(res));
  settings = { ...settings, inbox_api_url: 'https://other-inbox.web.test/api' };
  release();
  await run;
  assert.notEqual(f.inboxState(), 'ok', 'the answer was for the address set before');
});
