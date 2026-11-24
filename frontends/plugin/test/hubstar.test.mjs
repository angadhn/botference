// hubstar.test.mjs — the owner's private star (following.mjs STAR_STATES): its table, its independence from where a post is (READ_STATES)
// through tick, untick, an edit's return, unfollow (keep or forget); its bound; and that nothing about it leaves the Hub.
//
//   node --test test/hubstar.test.mjs
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

async function rig({ n = 4, settings = {} } = {}) {
  const web = makeWeb();
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const store = F.memoryStore({ now: () => clock.t });
  const site = web.add(A);
  for (let k = 1; k <= n; k++) site.put(makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: `Words of post ${k}.`, created: day(k) }));
  const f = F.createFollowing({ store, get: async (u, o) => { clock.t += 10; return web.get(u, o); }, now: () => clock.t,
    getSettings: () => CFG.followingSettingsOf({ following_unread_target: 500, following_max_items_per_blyg: 2000, ...settings }).settings, timers: { set: () => ({}), clear: () => {} } });
  await f.confirmImport([{ origin: A }]);
  await f.refresh();
  const key = k => f.keyFor(A, idOf(k));
  const starOf = async k => { const v = await f.view({ view: 'starred' }); return v.starred.some(l => l.key === k) ? 'starred' : 'plain'; };
  const readOf = async k => (await f.itemByKey(k)).read;
  return { f, web, site, store, clock, key, starOf, readOf };
}
const star = (r, k) => r.f.readRequest({ key: k, move: 'star' });
const unstar = (r, k) => r.f.readRequest({ key: k, move: 'unstar' });

test('the star is one named list, one field, one function: star plain → starred, unstar starred → plain; nothing else', () => {
  assert.deepEqual(F.STAR_STATES, ['plain', 'starred']);
  const legal = new Set(['star plain', 'unstar starred']);
  for (const ev of Object.keys(F.STAR_MOVES)) for (const from of F.STAR_STATES) assert.equal(Object.prototype.hasOwnProperty.call(F.STAR_MOVES[ev], from), legal.has(`${ev} ${from}`), `${ev} ${from}`);
  assert.throws(() => F.moveStar({ star: 'starred' }, 'star'), /cannot star while starred/);
  assert.throws(() => F.moveStar({ star: 'plain' }, 'unstar'), /cannot unstar while plain/);
  assert.throws(() => F.moveStar({ star: 'plain' }, 'toggle'), /no such move/);
  assert.equal(F.moveStar({ star: 'plain' }, 'star'), 'starred');
});

test('independent of where the post is, in every combination: a star never marks read, a tick or untick never touches the star', async () => {
  const r = await rig();
  const k = await r.key(1);
  for (const [first, second] of [['star', 'tick'], ['tick', 'star']]) {
    if (first === 'star') await star(r, k); else await r.f.readMove(k, 'tick');
    if (second === 'star') await star(r, k); else await r.f.readMove(k, 'tick');
    assert.deepEqual([await r.readOf(k), await r.starOf(k)], ['archived', 'starred'], `${first} then ${second}`);
    await r.f.untick(k);
    assert.deepEqual([await r.readOf(k), await r.starOf(k)], ['new', 'starred'], 'untick leaves the star');
    await unstar(r, k);
    assert.deepEqual([await r.readOf(k), await r.starOf(k)], ['new', 'plain'], 'unstar leaves the read state');
  }
  // opened, then starred, then unstarred: still opened
  await r.f.open(k);
  await star(r, k);
  assert.equal(await r.readOf(k), 'opened');
  await unstar(r, k);
  assert.equal(await r.readOf(k), 'opened');
  await assert.rejects(unstar(r, k), /not starred/);
  await star(r, k);
  await assert.rejects(star(r, k), /cannot star while starred/, 'starring twice is refused by the table');
});

test('an edit to a starred archived post follows the edit rule like any other, and the star stays', async () => {
  const r = await rig();
  const k = await r.key(2);
  await star(r, k);
  await r.f.readMove(k, 'tick');
  r.site.put(makeDoc({ id: idOf(2), origin: A, title: 'Post 2', body: 'Completely new words of post 2, rewritten.', version: 2, created: day(2), updated: day(90) }));
  const s = await r.f.refresh();
  assert.equal(s.edited, 1);
  assert.deepEqual([await r.readOf(k), await r.starOf(k)], ['edited', 'starred']);
});

test('unfollow keeps the starred lines (keep or not); "forget" removes them; a refollow does not bring a star back', async () => {
  const r = await rig();
  const [k1, k2] = [await r.key(1), await r.key(2)];
  await star(r, k1); await star(r, k2);
  await r.f.readMove(k2, 'tick');
  await r.f.unfollow(A);
  let v = await r.f.view({ view: 'starred' });
  assert.equal(v.starred.length, 2, 'kept with "Stop following"');
  assert.ok(v.starred.every(l => l.where === 'unfollowed'));
  assert.equal(v.tabs.starred, 2);
  await r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  v = await r.f.view({ view: 'starred' });
  assert.deepEqual(v.starred.map(l => l.where).sort(), ['feed', 'gone'], 'followed again: the unread one is back in the Feed; the read one stays read (not held)');
  await r.f.unfollow(A, { forget: true });
  assert.equal((await r.f.view({ view: 'starred' })).starred.length, 0, '"forget" removes them');
});

test('at most 500 starred: the next star is refused with a plain message naming the limit; a star record is small', async () => {
  const r = await rig({ n: 1 });
  const stars = {};
  for (let i = 0; i < F.LIMITS.starsMax; i++) {
    const o = `https://s${i}.web.test/`;
    stars[`${o}\n${idOf(i + 1)}`] = { key: `${'0'.repeat(8)}${String(i).padStart(16, '0')}`, origin: o, id: idOf(i + 1), kind: 'fragment', version: 1, created: day(1), updated: day(1),
      page: `${o}f/${idOf(i + 1)}/`, title: 'A starred post with an ordinary title', star: 'starred', starred_at: day(i) };
  }
  await r.store.put('state', 'stars', { stars });
  assert.equal(F.LIMITS.starsMax, 500);
  await assert.rejects(star(r, await r.key(1)), /at most 500 posts can be starred: remove a star first/);
  const bytes = JSON.stringify(r.store.peek('state', 'stars')).length;
  assert.ok(bytes / 500 < 600, `about ${Math.round(bytes / 500)} bytes a star`);
  assert.ok(bytes < 256 * 1024, `the stars document at its bound, with ordinary addresses: ${bytes} bytes`);
});

test('a starred archive record is never trimmed; the others are, oldest ticked first', async () => {
  const r = await rig({ n: 1 });
  const at = n => new Date(Date.parse('2026-06-01T00:00:00Z') + n * 3600e3).toISOString();
  const N = F.LIMITS.archiveRecordsPerBlyg + 3;
  for (let k = 2; k <= N; k++) r.site.put(makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: 'w', created: at(k) }));
  const k1 = await r.key(1);
  await star(r, k1);
  await r.f.readMove(k1, 'tick'); // the oldest ticked of all
  for (let i = 0; i < 40; i++) {
    await r.f.refresh();
    const keys = (await r.f.view({ limit: 1000 })).entries.map(e => e.head.key);
    if (!keys.length) break;
    for (let j = 0; j < keys.length; j += 100) { r.clock.t += 1000; await r.f.tickMany(keys.slice(j, j + 100)); }
  }
  const a = await r.f.view({ view: 'archive', limit: 1000 });
  assert.equal(a.archive_total, F.LIMITS.archiveRecordsPerBlyg, 'the cap holds');
  assert.equal((await r.f.itemByKey(k1)).read, 'archived', 'the starred record, the oldest ticked of all, stays');
  assert.equal(await r.f.itemByKey(await r.f.keyFor(A, idOf(N))), null, 'the oldest ticked unstarred one went in its place');
});

test('nothing about a star leaves the Hub: starring makes no request at all', async () => {
  const r = await rig();
  const n0 = r.web.requests.length;
  await star(r, await r.key(3));
  await unstar(r, await r.key(3));
  assert.equal(r.web.requests.length, n0);
});
