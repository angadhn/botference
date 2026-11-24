// hubburst.test.mjs — bursts in the Hub (§13.7; finding 4 of the gate review): a thread is fetched before the parts published with
// it, a part fetched first waits for its thread in Background, a tick of the thread takes the parts shown with it, and a part edited
// later stands on its own.
//
//   node --test test/hubburst.test.mjs
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
const T = m => new Date(Date.parse('2026-11-05T10:00:00Z') + m * 60e3).toISOString();

async function rig(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubburst-'));
  const web = makeWeb();
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const get = async (u, o) => { clock.t += 10; return web.get(u, o); };
  const f = F.createFollowing({ file: path.join(dir, 'following.json'), get, now: () => clock.t,
    getSettings: () => CFG.followingSettingsOf(settings).settings, timers: { set: () => ({}), clear: () => {} } });
  const site = web.add(A);
  const r = { f, web, site, clock,
    feed: async () => (await f.view({ limit: 1000 })).entries,
    where: async () => {
      const v = await f.view({ view: 'background' });
      const entries = (await f.view({ limit: 1000 })).entries;
      return { feed: entries.length, feedParts: entries.filter(e => /^Part/.test(e.head.title)).length, folded: entries.reduce((n, e) => n + e.members.length, 0),
        bg: v.background.length, tabFeed: v.tabs.feed };
    },
    done: () => fs.rmSync(dir, { recursive: true, force: true }) };
  await f.confirmImport([{ origin: A }]);
  return r;
}
/** Old plain posts, then one burst: a thread and `n` fragments it names, created within a few minutes. */
function build(site, { n = 30, old = 20, thread = { created: T(4) } } = {}) {
  for (let k = 1; k <= old; k++) site.put(makeDoc({ id: idOf(k), origin: A, title: `Old ${k}`, created: T(-10000 + k * 60) }));
  const parts = [];
  for (let k = 1; k <= n; k++) { const id = idOf(100 + k); parts.push({ origin: A, id, version: 1 }); site.put(makeDoc({ id, origin: A, title: `Part ${k}`, created: T((thread.partsAt || 0) + k / 10) })); }
  site.put(makeDoc({ id: idOf(99), origin: A, kind: 'thread', title: 'Thread', ...thread, transclusions: parts }));
  return parts;
}

test('burstOrder: a thread comes before every fragment created within burstMs of its created or updated, whatever the index order', () => {
  const e = (id, kind, created, updated = created) => ({ id, kind, created, updated });
  const list = [e('p3', 'fragment', T(11.3)), e('p2', 'fragment', T(11.2)), e('x', 'fragment', T(500)), e('t', 'thread', T(0), T(9)), e('p1', 'fragment', T(11.1)), e('o', 'fragment', T(-100))];
  assert.deepEqual(F.burstOrder(list).map(x => x.id), ['t', 'p3', 'p2', 'x', 'p1', 'o']);
  assert.deepEqual(F.burstOrder([e('a', 'fragment', T(0)), e('b', 'fragment', T(1))]).map(x => x.id), ['a', 'b'], 'no thread: unchanged');
  assert.deepEqual(F.burstOrder([e('a', 'fragment', 'not a date'), e('t', 'thread', T(0))]).map(x => x.id), ['a', 't']);
});

test('a fresh burst with a large target: the thread is in the Feed with its parts folded, none of them on its own', async () => {
  const r = await rig({ following_unread_target: 500 });
  build(r.site);
  await r.f.refresh();
  await r.f.refresh(); // (51 documents: 50 a blyg a run)
  assert.deepEqual(await r.where(), { feed: 21, feedParts: 0, folded: 30, bg: 30, tabFeed: 21 });
  r.done();
});

test('backfill with a small target: the thread is fetched first, so its parts never stand in the Feed on their own (targets 1, 5, 10)', async () => {
  for (const target of [1, 5, 10]) {
    const r = await rig({ following_unread_target: target });
    build(r.site);
    await r.f.refresh();
    const w = await r.where();
    assert.equal(w.feedParts, 0, `target ${target}`);
    assert.ok((await r.feed()).some(e => e.head.title === 'Thread'), `target ${target}: the thread is there`);
    assert.equal(w.tabFeed, target, `target ${target}: parts folded under it do not count toward the target`);
    r.done();
  }
});

test('a thread last edited after its parts were drafted, read in small budgets across runs: no part is ever in the Feed on its own', async () => {
  for (const requests of [6, 8]) {
    const r = await rig({ following_unread_target: 500, following_run_requests: requests });
    build(r.site, { n: 12, old: 0, thread: { created: T(0), updated: T(9), version: 2, partsAt: 10 } });
    for (let run = 1; run <= 5; run++) {
      await r.f.refresh();
      assert.equal((await r.where()).feedParts, 0, `budget ${requests}, run ${run}`);
    }
    assert.deepEqual(await r.where(), { feed: 1, feedParts: 0, folded: 12, bg: 12, tabFeed: 1 }, `budget ${requests}`);
    r.done();
  }
});

test('a target reached mid-burst, parts newer than their thread: the thread first, the parts folded, the target counts the thread only', async () => {
  const r = await rig({ following_unread_target: 4 });
  build(r.site, { n: 12, old: 10, thread: { created: T(5), partsAt: 10 } });
  for (let run = 1; run <= 3; run++) { await r.f.refresh(); assert.equal((await r.where()).feedParts, 0, `run ${run}`); }
  assert.equal((await r.where()).tabFeed, 4);
  r.done();
});

test('a part fetched while its thread cannot be: Background, "waiting for its thread", not counted toward the target; after 24 hours it stands alone', async () => {
  const r = await rig({ following_unread_target: 3 });
  build(r.site, { n: 4, old: 0 });
  const real = r.web.get;
  let threadDown = true;
  r.web.get = async (u, o) => (threadDown && String(u).endsWith(`${idOf(99)}.json`) ? { status: 404, url: String(u), text: 'not yet' } : real(u, o));
  await r.f.refresh();
  const bg = (await r.f.view({ view: 'background' })).background;
  assert.equal(bg.length, 4);
  assert.ok(bg.every(b => b.reason === 'waiting for its thread'));
  assert.equal(await r.f.unreadCount(), 0, 'they do not count toward the target');
  // the thread comes: they fold under it
  threadDown = false;
  r.clock.t += 2 * 3600e3;
  await r.f.refresh();
  assert.deepEqual(await r.where(), { feed: 1, feedParts: 0, folded: 4, bg: 4, tabFeed: 1 });
  assert.ok(Object.values((await r.f.view({ view: 'background' })).background).every(b => b.post.part === 'folded'));
  // and if it never had: after burstWaitMs they stand on their own
  const q = await rig({ following_unread_target: 3 });
  build(q.site, { n: 2, old: 0 });
  const real2 = q.web.get;
  q.web.get = async (u, o) => (String(u).endsWith(`${idOf(99)}.json`) ? { status: 404, url: String(u), text: 'never' } : real2(u, o));
  await q.f.refresh();
  assert.equal((await q.where()).tabFeed, 0);
  q.clock.t += F.LIMITS.burstWaitMs - 1000;
  await q.f.refresh();
  assert.equal((await q.where()).feedParts, 0, 'still awaiting just before the bound');
  q.clock.t += 2000;
  await q.f.refresh();
  assert.equal((await q.where()).feedParts, 2, 'the wait is bounded: at the next refresh after it, they stand alone');
  assert.ok((await q.feed()).every(e => e.head.part === 'standalone'));
  assert.deepEqual(F.PART_STATES, ['awaiting', 'folded', 'standalone']);
  assert.throws(() => F.movePart({ part: 'awaiting', awaits_until: 100 }, 'wait_over', 50), /before awaits_until/);
  assert.throws(() => F.movePart({ part: 'folded' }, 'thread_held'), /cannot/);
  q.done(); r.done();
});

test('ticking a thread archives the parts the page showed with it; "and its N parts"; a link-only post and a part shown alone stay', async () => {
  const r = await rig({ following_unread_target: 500 });
  const parts = build(r.site, { n: 5, old: 2 });
  // a fragment the thread only LINKS to, published in the same act: never folded (§13.7 links rule), so never taken with it
  r.site.put(makeDoc({ id: idOf(200), origin: A, title: 'Linked', created: T(3) }));
  r.site.put(makeDoc({ id: idOf(99), origin: A, kind: 'thread', title: 'Thread', created: T(4), transclusions: parts, links: [{ id: idOf(200) }] }));
  await r.f.refresh();
  const head = (await r.feed()).find(e => e.head.title === 'Thread');
  assert.equal(head.members.length, 5);
  const linked = await r.f.keyFor(A, idOf(200));
  const shown = head.members.map(m => m.key);
  // the page sends the five it showed, and (forged, or stale) the linked one too
  const out = await r.f.readRequest({ key: head.head.key, move: 'tick', members: [...shown, linked] });
  assert.deepEqual([out.read, out.parts], ['archived', 5]);
  assert.ok(shown.every(async k => (await r.f.itemByKey(k)).read === 'archived'));
  assert.equal((await r.f.itemByKey(linked)).read, 'new', 'the link-only post stays where it is');
  assert.equal((await r.where()).feedParts, 0, 'nothing spilled into the Feed');
  // the page's own rendering carries the member keys on the thread's entry
  r.done();
});

test('"Tick all shown" archives each head with its shown parts, 100 entries a request', async () => {
  const r = await rig({ following_unread_target: 500 });
  build(r.site, { n: 6, old: 3 });
  await r.f.refresh();
  const ticks = (await r.feed()).map(e => ({ key: e.head.key, members: e.members.map(m => m.key) }));
  const out = await r.f.readRequest({ ticks });
  assert.deepEqual([out.archived, out.parts], [4, 6]);
  assert.equal((await r.where()).feed, 0);
  assert.equal((await r.f.view()).tabs.archive, 10);
  r.done();
});

test('§13.7: a fold covers the versions published in the burst: a part edited a week later is its own arrival; a maintenance version stays folded', async () => {
  const r = await rig({ following_unread_target: 500 });
  build(r.site, { n: 3, old: 0, thread: { created: T(1) } });
  await r.f.refresh();
  assert.equal((await r.where()).folded, 3);
  // part 1: new words a week later; part 2: a maintenance version (same words) a week later
  r.site.put(makeDoc({ id: idOf(101), origin: A, title: 'Part 1', body: 'Rewritten a week later with many new words.', version: 2, created: T(0.1), updated: T(10080) }));
  r.site.put(makeDoc({ id: idOf(102), origin: A, title: 'Part 2', version: 2, created: T(0.2), updated: T(10081) }));
  const s = await r.f.refresh();
  assert.equal(s.edited, 1);
  assert.ok((await r.feed()).some(e => e.head.title === 'Part 1'), 'the edited part surfaces in the Feed');
  const thread = (await r.feed()).find(e => e.head.title === 'Thread');
  assert.deepEqual(thread.members.map(m => m.title).sort(), ['Part 2', 'Part 3'], 'the maintenance version stays folded');
  // an archived part edited later follows the edit rule: it comes back as edited
  const k3 = await r.f.keyFor(A, idOf(103));
  await r.f.readMove(k3, 'tick');
  r.site.put(makeDoc({ id: idOf(103), origin: A, title: 'Part 3', body: 'New words for part three.', version: 2, created: T(0.3), updated: T(10082) }));
  await r.f.refresh();
  assert.equal((await r.f.itemByKey(k3)).read, 'edited');
  assert.ok((await r.feed()).some(e => e.head.key === k3));
  r.done();
});

test('a member key named twice is one part, counted once; more than burstMembersMax members are not taken', async () => {
  const r = await rig({ following_unread_target: 500 });
  build(r.site, { n: 3, old: 0 });
  await r.f.refresh();
  const head = (await r.feed()).find(e => e.head.title === 'Thread');
  const keys = head.members.map(m => m.key);
  const out = await r.f.readRequest({ key: head.head.key, move: 'tick', members: [...keys, ...keys, keys[0]] });
  assert.equal(out.parts, 3);
  assert.equal((await r.f.view()).tabs.archive, 4);
  r.done();
  // a page naming 100,000 keys: the list is cut first, the answer is the same and quick
  const q = await rig({ following_unread_target: 500 });
  build(q.site, { n: 3, old: 0 });
  await q.f.refresh();
  const h2 = (await q.feed()).find(e => e.head.title === 'Thread');
  const t0 = performance.now();
  const o2 = await q.f.readRequest({ key: h2.head.key, move: 'tick', members: [...h2.members.map(m => m.key), ...Array.from({ length: 100000 }, (_, i) => String(i))] });
  assert.equal(o2.parts, 3);
  assert.ok(performance.now() - t0 < 1000);
  q.done();
});
