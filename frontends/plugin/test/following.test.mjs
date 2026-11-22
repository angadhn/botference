// following.test.mjs — Following (following.mjs): the follow list, imports,
// reconciliation by index diff, the named states, caps and breakers.
//
//   node --test test/following.test.mjs
//
// No network: every fetch is a fake `get` over an invented blyg held in memory
// (test/following-fake.mjs). Origins are invented, as are all the words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as F from '../following.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = createRequire(import.meta.url)('../extension/config.js');
const A = 'https://alpha.web.test/notes/';
const Bo = 'https://beta.web.test/';
const SETTINGS = (over = {}) => CFG.followingSettingsOf(over).settings;

function rig({ settings = {}, clock = { t: Date.parse('2026-11-10T12:00:00Z') } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-following-'));
  const web = makeWeb();
  const timers = { set: [], cleared: [], set_: (fn, ms) => { const h = { fn, ms }; timers.set.push(h); return h; }, clear_: h => timers.cleared.push(h) };
  const f = F.createFollowing({ file: path.join(dir, 'following.json'), get: web.get, now: () => clock.t,
    getSettings: () => SETTINGS(settings), timers: { set: timers.set_, clear: timers.clear_ } });
  return { f, web, clock, dir, timers, file: path.join(dir, 'following.json'),
    reload: () => F.createFollowing({ file: path.join(dir, 'following.json'), get: web.get, now: () => clock.t, getSettings: () => SETTINGS(settings),
      timers: { set: timers.set_, clear: timers.clear_ } }),
    done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const follow = async (r, origin) => r.f.confirmImport([{ origin, title: 'x' }]);
const items = r => r.f.view({ filter: 'all' }).entries.flatMap(e => [e.head, ...e.members]);

test('follow by any URL on a blyg resolves its origin; unfollow forgets it and its posts; list', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  site.put(makeDoc({ id: idOf(1), origin: A }));
  // a post's own address, deep inside the blyg, is enough
  const got = await r.f.follow(`${A}t/${idOf(1)}/?utm=1`);
  assert.equal(got.origin, A);
  assert.equal(got.title, 'Alpha Notes');
  assert.equal(got.added, true);
  assert.equal((await r.f.follow(A)).added, false, 'following it twice is one follow');
  const list = r.f.listBlygs();
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'active');
  await r.f.refresh();
  assert.equal(items(r).length, 1);
  assert.equal(r.f.unfollow(A), true);
  assert.equal(r.f.listBlygs().length, 0);
  assert.equal(items(r).length, 0, 'its posts go with it');
  assert.equal(r.f.unfollow(A), false);
  await assert.rejects(() => r.f.follow('https://nothing.web.test/x'), /could not ask|no Blygger/);
  await assert.rejects(() => r.f.follow('ftp://x'), /not a web address/);
  r.done();
});

test('the follow list survives a restart (stored in the file it is given)', async () => {
  const r = rig();
  r.web.add(A).put(makeDoc({ id: idOf(1), origin: A }));
  await follow(r, A);
  await r.f.refresh();
  const again = r.reload();
  assert.equal(again.listBlygs().length, 1);
  assert.equal(again.view().entries.length, 1);
  r.done();
});

const OPML = `<?xml version="1.0"?><opml version="2.0"><head><title>Roll</title></head><body>
<outline text="Alpha &amp; Co" type="rss" xmlUrl="${A}feed.xml" htmlUrl="${A}"/>
<outline text="Beta" xmlUrl="${Bo}feed.xml"/>
<outline text="Plain blog" xmlUrl="https://plain.web.test/rss"/>
<outline text="Bad" xmlUrl="javascript:alert(1)"/>
</body></opml>`;

test('OPML: parse, preview what would be added (nothing added yet), confirm only what was chosen', async () => {
  const entries = F.parseOpml(OPML);
  assert.deepEqual(entries.map(e => e.url), [A, `${Bo}feed.xml`, 'https://plain.web.test/rss']);
  assert.equal(entries[0].title, 'Alpha & Co');
  const r = rig();
  r.web.add(A, { title: 'Alpha Notes' });
  r.web.add(Bo, { title: 'Beta Notes' });
  const pv = await r.f.previewImport({ text: OPML });
  assert.equal(pv.kind, 'opml');
  assert.deepEqual(pv.add.map(a => a.origin), [A, Bo]);
  assert.equal(pv.skipped.length, 1, 'the one that is not a blyg is said, not added');
  assert.match(pv.skipped[0].reason, /not a blyg|could not ask/);
  assert.equal(r.f.listBlygs().length, 0, 'a preview adds nothing');
  const done = r.f.confirmImport([pv.add[1]]);
  assert.deepEqual(done.added, [Bo]);
  assert.deepEqual(r.f.listBlygs().map(b => b.origin), [Bo], 'only what the reader confirmed');
  const again = await r.f.previewImport({ text: OPML });
  assert.deepEqual(again.already.map(a => a.origin), [Bo]);
  assert.deepEqual(again.add.map(a => a.origin), [A]);
  r.done();
});

test('OPML by URL goes through the injected (guarded) getter', async () => {
  const r = rig();
  r.web.add(A);
  const host = r.web.add('https://roll.web.test/');
  const orig = r.web.get;
  const f = F.createFollowing({ file: path.join(r.dir, 'x.json'), getSettings: () => SETTINGS(),
    get: async (url, o) => (url === 'https://roll.web.test/blogroll.opml' ? { status: 200, url, text: OPML } : orig(url, o)) });
  const pv = await f.previewImport({ url: 'https://roll.web.test/blogroll.opml' });
  assert.deepEqual(pv.add.map(a => a.origin), [A]);
  await assert.rejects(() => f.previewImport({ url: 'ftp://x/y' }), /web address/);
  r.done();
});

test('directory JSON (an object or a list; origin, title, feed): preview, confirm', async () => {
  const doc = { generated: 'x', blygs: [
    { origin: A, title: 'Alpha‮evil', feed: `${A}feed.xml` }, { origin: Bo, title: 'Beta', feed: `${Bo}feed.xml` },
    { origin: 'javascript:alert(1)', title: 'no' }, { title: 'no origin' }, 7] };
  for (const text of [JSON.stringify(doc), JSON.stringify(doc.blygs)]) {
    const r = rig();
    const pv = await r.f.previewImport({ text });
    assert.equal(pv.kind, 'directory');
    assert.deepEqual(pv.add.map(a => a.origin), [A, Bo]);
    assert.equal(pv.add[0].title, 'Alphaevil', 'bidi override stripped');
    assert.equal(r.f.listBlygs().length, 0);
    assert.deepEqual(r.f.confirmImport([pv.add[0], { origin: 'http://127.0.0.1:9/' }, { origin: 'ftp://x/' }]).added, [A], 'a private or odd origin cannot be confirmed in');
    assert.deepEqual(r.f.listBlygs().map(b => b.origin), [A]);
    r.done();
  }
  assert.deepEqual(F.parseDirectory('not json'), []);
});

test('index diff: new, edited, maintenance, withdrawn, removed from the index; only changed documents are fetched', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const [i1, i2, i3, i4] = [1, 2, 3, 4].map(idOf);
  site.put(makeDoc({ id: i1, origin: A, title: 'One', body: 'first words', updated: '2026-11-01T10:00:00Z' }));
  site.put(makeDoc({ id: i2, origin: A, title: 'Two', body: 'second words', created: '2026-11-02T10:00:00Z' }));
  site.put(makeDoc({ id: i3, origin: A, title: 'Three', body: 'third words', created: '2026-11-03T10:00:00Z' }));
  site.put(makeDoc({ id: i4, origin: A, title: 'Four', body: 'fourth words', created: '2026-11-04T10:00:00Z' }));
  await follow(r, A);
  let s = await r.f.refresh();
  assert.equal(s.new, 4);
  assert.equal(r.web.itemRequests().length, 4);
  const key = id => F.keyOf(A, id);
  for (const id of [i1, i2, i3, i4]) r.f.readMove(key(id), 'see');
  r.web.requests.length = 0;
  s = await r.f.refresh();
  assert.equal(r.web.itemRequests().length, 0, 'nothing changed: no document is fetched');
  assert.equal(s.new + s.edited + s.maintenance, 0);

  // edited: new words; maintenance: same words, version 2; withdrawn; removed from the index; a new one
  site.put(makeDoc({ id: i1, origin: A, title: 'One', body: 'first words, rewritten', version: 2, updated: '2026-11-05T10:00:00Z' }));
  site.put(makeDoc({ id: i2, origin: A, title: 'Two', body: 'second words', version: 2, created: '2026-11-02T10:00:00Z', updated: '2026-11-05T11:00:00Z' }));
  site.put(makeDoc({ id: i3, origin: A, kind: 'withdrawn', title: '', version: 2, created: '2026-11-03T10:00:00Z', updated: '2026-11-05T12:00:00Z' }));
  site.drop(i4);
  const i5 = idOf(5);
  site.put(makeDoc({ id: i5, origin: A, title: 'Five', body: 'fifth words', created: '2026-11-06T10:00:00Z' }));
  r.web.requests.length = 0;
  s = await r.f.refresh();
  assert.deepEqual([s.new, s.edited, s.maintenance, s.withdrawn, s.removed], [1, 1, 1, 1, 1]);
  const got = Object.fromEntries(items(r).map(i => [i.id, i]));
  assert.equal(got[i1].read, 'new', 'new words resurface a read post');
  assert.equal(got[i1].version, 2);
  assert.equal(got[i2].read, 'seen', 'a maintenance version (same content_hash) does not resurface it');
  assert.equal(got[i2].version, 2);
  assert.equal(got[i2].maintenance, 1);
  assert.ok(!(i3 in got), 'a withdrawn post leaves the list');
  assert.ok(!(i4 in got), 'a post gone from the index leaves the list');
  assert.equal(got[i5].read, 'new');
  assert.equal(r.web.itemRequests().length, 3, 'only the changed, non-withdrawn documents were fetched (the withdrawal is read off the index)');
  // the withdrawn one is a bare marker: not asked about again, no words kept
  const tomb = r.f.itemByKey(key(i3));
  assert.equal(tomb.withdrawn, true);
  assert.equal(tomb.text, '');
  r.web.requests.length = 0;
  await r.f.refresh();
  assert.equal(r.web.itemRequests().length, 0);
  r.done();
});

test('rollup by version: one entry per post, the newest version, "N versions" noted', async () => {
  const r = rig();
  const site = r.web.add(A);
  const id = idOf(1);
  site.put(makeDoc({ id, origin: A, body: 'v1 words' }));
  await follow(r, A);
  await r.f.refresh();
  assert.equal(items(r)[0].versions_note, '');
  site.put(makeDoc({ id, origin: A, body: 'v2 words', version: 2, updated: '2026-11-02T10:00:00Z' }));
  await r.f.refresh();
  site.put(makeDoc({ id, origin: A, body: 'v3 words', version: 3, updated: '2026-11-03T10:00:00Z' }));
  await r.f.refresh();
  const list = items(r);
  assert.equal(list.length, 1);
  assert.equal(list[0].version, 3);
  assert.equal(list[0].versions_note, '3 versions');
  assert.match(list[0].excerpt, /v3 words/);
  // a lower version in the index is never adopted (§13.3)
  site.put(makeDoc({ id, origin: A, body: 'old words', version: 2, updated: '2026-11-04T10:00:00Z' }));
  const s = await r.f.refresh();
  assert.equal(s.regressions, 1);
  assert.equal(items(r)[0].version, 3);
  r.done();
});

test('what is kept: title from the first heading, else an excerpt; stub_of; counts; no whole HTML', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes', author: 'Blyg Author' });
  const stubId = idOf(1), noTitle = idOf(2);
  const long = 'word '.repeat(2000);
  site.put(makeDoc({ id: stubId, origin: A, kind: 'thread', title: 'A reply', body: long, author: 'Ann',
    stub_of: { origin: Bo, id: idOf(77) }, transclusions: [{ origin: A, id: idOf(2), version: 1 }, { origin: Bo, id: idOf(9), version: 1 }],
    links: [{ id: idOf(3) }] }));
  site.put(makeDoc({ id: noTitle, origin: A, title: '', body: 'just a short thought', author: null }));
  await follow(r, A);
  await r.f.refresh();
  const by = Object.fromEntries(items(r).map(i => [i.id, i]));
  const t = by[stubId];
  assert.equal(t.title, 'A reply');
  assert.equal(t.kind, 'thread');
  assert.equal(t.author, 'Ann');
  assert.deepEqual(t.stub_of, { origin: Bo, id: idOf(77) });
  assert.equal(t.transclusions, 2);
  assert.equal(t.links, 1);
  assert.equal(t.withdrawn, false);
  assert.ok(t.text.length <= F.LIMITS.textChars && t.excerpt.length <= F.LIMITS.excerptChars);
  assert.ok(!('content_html' in t) && !('content_md' in t) && !t.text.includes('<'));
  assert.equal(by[noTitle].title, '');
  assert.equal(by[noTitle].excerpt, 'just a short thought');
  assert.equal(by[noTitle].author, 'Blyg Author', 'the blyg\'s author when the post names none');
  for (const k of ['origin', 'id', 'kind', 'version', 'created', 'updated']) assert.ok(t[k], k);
  r.done();
});

test('burst folding: a thread and the posts it names, published together, are one entry; folding is display only', async () => {
  const r = rig();
  const site = r.web.add(A);
  const [th, f1, f2, late, other] = [1, 2, 3, 4, 5].map(idOf);
  site.put(makeDoc({ id: f1, origin: A, title: 'Frag one', created: '2026-11-05T10:00:00Z' }));
  site.put(makeDoc({ id: f2, origin: A, title: 'Frag two', created: '2026-11-05T10:01:00Z' }));
  site.put(makeDoc({ id: late, origin: A, title: 'Old frag', created: '2026-10-01T10:00:00Z' }));
  site.put(makeDoc({ id: other, origin: A, title: 'Unrelated', created: '2026-11-05T10:02:00Z' }));
  site.put(makeDoc({ id: th, origin: A, kind: 'thread', title: 'The thread', created: '2026-11-05T10:03:00Z',
    transclusions: [f1, f2, late].map(id => ({ origin: A, id, version: 1 })) }));
  await follow(r, A);
  await r.f.refresh();
  const v = r.f.view({ filter: 'all' });
  assert.equal(v.entries.length, 3, 'thread (with two) + the old fragment + the unrelated one');
  const burst = v.entries.find(e => e.head.id === th);
  assert.deepEqual(burst.members.map(m => m.id).sort(), [f1, f2].sort(), 'a post created long before the publish is not in the burst');
  assert.equal(v.counts.all, 3);
  // display only: every post is still held, and the Fragments filter lists them flat
  assert.equal(r.f.view({ filter: 'fragments' }).entries.length, 4);
  assert.equal(r.f.view({ filter: 'threads' }).entries.length, 1);
  // a thread of another blyg never folds this blyg's posts
  assert.equal(F.foldBursts([{ key: 'a', kind: 'thread', origin: Bo, created: '2026-11-05T10:03:00Z', updated: '2026-11-05T10:03:00Z', refs: [{ origin: A, id: f1 }] },
    { key: F.keyOf(A, f1), kind: 'fragment', origin: A, id: f1, created: '2026-11-05T10:00:00Z' }]).length, 2);
  r.done();
});

test('filters: New, Threads, Fragments, Responses to me (stub_of or a transclusion at a my_origins origin)', async () => {
  const r = rig();
  const site = r.web.add(A);
  const me = 'https://me.web.test/';
  const [stub, quoter, plain, mine] = [1, 2, 3, 4].map(idOf);
  site.put(makeDoc({ id: stub, origin: A, kind: 'thread', title: 'Replying', stub_of: { origin: me, id: idOf(50) }, created: '2026-11-01T10:00:00Z', transclusions: [] }));
  site.put(makeDoc({ id: quoter, origin: A, kind: 'thread', title: 'Quoting', created: '2026-11-02T10:00:00Z', transclusions: [{ origin: me, id: idOf(51), version: 1 }] }));
  site.put(makeDoc({ id: plain, origin: A, title: 'Plain', created: '2026-11-03T10:00:00Z' }));
  await follow(r, A);
  await r.f.refresh();
  const names = f => r.f.view({ filter: f, mine: [me] }).entries.map(e => e.head.id);
  assert.deepEqual(names('responses').sort(), [stub, quoter].sort());
  assert.deepEqual(r.f.view({ filter: 'responses', mine: [] }).entries, [], 'with my_origins empty nothing is a response to me');
  assert.deepEqual(names('threads').sort(), [stub, quoter].sort());
  assert.deepEqual(names('fragments'), [plain]);
  r.f.readMove(F.keyOf(A, plain), 'see');
  assert.equal(names('new').includes(plain), false);
  assert.equal(names('new').length, 2);
  // the response entry says what it answers
  const e = r.f.view({ filter: 'responses', mine: [me] }).entries.find(x => x.head.id === stub).head;
  assert.equal(e.in_response_to.origin, me);
  assert.equal(F.filterOf('nonsense'), 'all');
  r.done();
});

test('caps: per-blyg and total', async () => {
  const r = rig({ settings: { following_max_items_per_blyg: 10, following_max_items_total: 50 } });
  const site = r.web.add(A);
  for (let n = 1; n <= 15; n++) site.put(makeDoc({ id: idOf(n), origin: A, title: `P${n}`, created: `2026-11-${String(n).padStart(2, '0')}T10:00:00Z` }));
  await follow(r, A);
  await r.f.refresh();
  assert.equal(items(r).length, 10, 'per-blyg cap: the newest ten');
  assert.ok(items(r).every(i => Number(i.title.slice(1)) > 5));
  // the cap is not chased every run: nothing is refetched
  r.web.requests.length = 0;
  await r.f.refresh();
  assert.equal(r.web.itemRequests().length, 0);
  r.done();
  const t = rig({ settings: { following_max_items_per_blyg: 50, following_max_items_total: 50 } });
  for (const [o, n0] of [[A, 0], [Bo, 100]]) {
    const s = t.web.add(o);
    for (let n = 1; n <= 30; n++) s.put(makeDoc({ id: idOf(n0 + n), origin: o, title: `P${n}`, created: `2026-11-${String(n).padStart(2, '0')}T10:00:00Z` }));
    await follow(t, o);
  }
  const s = await t.f.refresh();
  assert.equal(items(t).length, 50, 'total cap: 50 of 60');
  assert.equal(s.capped, 10);
  t.done();
});

test('per-run request cap and time budget stop the run (and carry on next time)', async () => {
  const r = rig({ settings: { following_run_requests: 8 } });
  const site = r.web.add(A);
  for (let n = 1; n <= 20; n++) site.put(makeDoc({ id: idOf(n), origin: A, created: `2026-11-${String(n).padStart(2, '0')}T10:00:00Z` }));
  await follow(r, A);
  r.web.requests.length = 0;
  const s = await r.f.refresh();
  assert.equal(r.web.requests.length, 8, 'never more requests than the cap');
  assert.equal(s.requests, 8);
  assert.ok(s.deferred > 0);
  assert.equal(items(r).length, 6, 'manifest + index + six documents');
  assert.equal(r.f.listBlygs()[0].state, 'active', 'running out of budget is not the blyg\'s fault');
  await r.f.refresh();
  assert.equal(items(r).length, 12, 'the next run carries on');
  r.done();

  // time: the clock moves with every request; the budget is five seconds
  const clock = { t: 0 };
  const t = rig({ clock, settings: { following_run_seconds: 5 } });
  const s2 = t.web.add(A);
  for (let n = 1; n <= 20; n++) s2.put(makeDoc({ id: idOf(n), origin: A, created: `2026-11-${String(n).padStart(2, '0')}T10:00:00Z` }));
  await follow(t, A);
  const orig = t.web.get;
  const g = F.createFollowing({ file: path.join(t.dir, 'slow.json'), now: () => clock.t, getSettings: () => SETTINGS({ following_run_seconds: 5 }),
    get: async (u, o) => { clock.t += 2000; return orig(u, o); } });
  g.confirmImport([{ origin: A }]);
  const s3 = await g.refresh();
  assert.ok(s3.requests <= 3, `stopped by the time budget (${s3.requests} requests)`);
  assert.ok(s3.deferred > 0);
  t.done();
});

test('per-host breaker opens after repeated failures and refuses that host until it cools', async () => {
  const r = rig();
  const hosts = [A, 'https://alpha.web.test/other/', 'https://alpha.web.test/third/', 'https://alpha.web.test/fourth/'];
  for (const o of hosts) r.web.add(o).down = 'timeout';
  for (const o of hosts) r.f.confirmImport([{ origin: o }]);
  r.web.requests.length = 0;
  const s = await r.f.refresh();
  const b = r.f.breakers.get('alpha.web.test');
  assert.equal(b.state, 'open');
  assert.equal(r.web.requests.length, F.BREAKER.threshold, 'after three failures the host is not asked again this run');
  assert.ok(s.deferred >= 1);
  r.clock.t += F.BREAKER.cooldownMs + 1;
  r.web.sites.get(A).down = null;
  r.web.sites.get(A).put(makeDoc({ id: idOf(1), origin: A }));
  // the others are still "unreachable" with back-off pending; A's own back-off has run out too
  r.clock.t += F.LIMITS.backoffMaxMs;
  r.web.requests.length = 0;
  await r.f.refresh();
  assert.ok(r.web.requests.length > 0, 'half-open: a probe is let through');
  assert.equal(r.f.breakers.get('alpha.web.test').state === 'closed' || r.f.breakers.get('alpha.web.test').state === 'open', true);
  // a different host is unaffected
  const x = rig();
  x.web.add(A).down = 'timeout';
  x.web.add(Bo).put(makeDoc({ id: idOf(1), origin: Bo }));
  x.f.confirmImport([{ origin: A }, { origin: Bo }]);
  await x.f.refresh();
  assert.equal(items(x).length, 1);
  r.done(); x.done();
  assert.throws(() => F.moveBreaker({ state: 'open' }, 'ok'), /cannot ok while open/);
});

test('an unreachable blyg is backed off (doubling), then recovers; a gone blyg is left alone', async () => {
  const r = rig();
  const site = r.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A }));
  await follow(r, A);
  site.down = 'network';
  await r.f.refresh();
  let b = r.f.listBlygs()[0];
  assert.equal(b.state, 'unreachable');
  assert.equal(b.failures, 1);
  const first = b.retry_after - r.clock.t;
  assert.equal(first, F.LIMITS.backoffFirstMs);
  r.web.requests.length = 0;
  const skipped = await r.f.refresh();
  assert.equal(r.web.requests.length, 0, 'inside the back-off it is not asked');
  assert.equal(skipped.skipped, 1);
  r.clock.t += first + 1;
  await r.f.refresh();
  b = r.f.listBlygs()[0];
  assert.equal(b.failures, 2);
  assert.equal(b.retry_after - r.clock.t, 2 * first, 'the wait doubles');
  site.down = null;
  r.clock.t += 2 * first + 1;
  await r.f.refresh();
  b = r.f.listBlygs()[0];
  assert.equal(b.state, 'active');
  assert.equal(b.failures, 0);
  assert.equal(items(r).length, 1);
  // answering, repeatedly, with no manifest: gone, and not asked again
  site.noManifest = true;
  for (let n = 0; n < F.LIMITS.goneAfter; n++) await r.f.refresh();
  assert.equal(r.f.listBlygs()[0].state, 'gone');
  r.web.requests.length = 0;
  await r.f.refresh();
  assert.equal(r.web.requests.length, 0);
  site.noManifest = false;
  r.f.setBlygState(A, 'resume');
  await r.f.refresh();
  assert.equal(r.f.listBlygs()[0].state, 'active');
  // paused is never fetched
  r.f.setBlygState(A, 'pause');
  r.web.requests.length = 0;
  await r.f.refresh();
  assert.equal(r.web.requests.length, 0);
  r.done();
});

test('never more than one reconciliation in flight: a second refresh is refused, not run alongside', async () => {
  const r = rig();
  const site = r.web.add(A);
  for (let n = 1; n <= 3; n++) site.put(makeDoc({ id: idOf(n), origin: A }));
  await follow(r, A);
  r.web.delayMs = 15;
  r.web.requests.length = 0;
  const first = r.f.refresh();
  assert.equal(r.f.run.state, 'running');
  const [second, third] = await Promise.all([r.f.refresh(), r.f.refresh()]);
  assert.equal(second.started, false);
  assert.equal(third.started, false);
  const done = await first;
  assert.equal(done.started, true);
  assert.equal(r.web.maxInFlight, 1, 'one request at a time, one run at a time');
  assert.equal(r.web.requests.length, 5, 'one run\'s requests only (manifest, index, three documents)');
  assert.equal(r.f.run.state, 'idle');
  const again = await r.f.refresh();
  assert.equal(again.started, true, 'idle again: a new run is allowed');
  r.done();
});

test('the timer: armed (at the configured interval) while something is followed, off when the list is empty, reaches refresh', async () => {
  const r = rig({ settings: { following_refresh_minutes: 45 } });
  assert.equal(r.f.start(), 'off');
  assert.equal(r.timers.set.length, 0, 'nothing followed: no timer');
  r.web.add(A).put(makeDoc({ id: idOf(1), origin: A }));
  await follow(r, A);
  assert.equal(r.f.schedule.mode, 'scheduled');
  assert.equal(r.timers.set.at(-1).ms, 45 * 60 * 1000);
  r.timers.set.at(-1).fn();
  await new Promise(res => setTimeout(res, 50));
  assert.equal(items(r).length, 1, 'the timer ran a refresh');
  r.f.unfollow(A);
  assert.equal(r.f.schedule.mode, 'off');
  assert.ok(r.timers.cleared.length >= 1);
  assert.equal(F.createFollowing({ file: path.join(r.dir, 'd.json') }) && CFG.followingSettingsOf({}).settings.following_refresh_minutes, 30, 'the default is thirty minutes');
  r.done();
});

test('settings: named, validated, defaults kept for what is refused; my_origins normalised', () => {
  const d = CFG.followingSettingsOf({});
  assert.deepEqual(d.refused, []);
  assert.deepEqual(d.settings.my_origins, []);
  assert.equal(d.settings.following_refresh_minutes, 30);
  const bad = CFG.followingSettingsOf({ following_refresh_minutes: 1, following_max_items_total: 'many', following_run_seconds: 1.5,
    my_origins: ['https://me.web.test/blog', 'javascript:alert(1)', 'https://me.web.test/blog/', 'ftp://x'] });
  assert.deepEqual(bad.refused.sort(), ['following_max_items_total', 'following_refresh_minutes', 'following_run_seconds', 'my_origins']);
  assert.equal(bad.settings.following_refresh_minutes, 30);
  assert.deepEqual(bad.settings.my_origins, ['https://me.web.test/blog/']);
  assert.deepEqual(CFG.followingSettingsOf({ my_origins: 'x' }).refused, ['my_origins']);
  assert.equal(CFG.followingSettingsOf({ following_refresh_minutes: 5 }).settings.following_refresh_minutes, 5);
});

test('read state: one function moves it, and refuses a move the table does not allow', () => {
  assert.deepEqual(F.READ_STATES, ['new', 'seen', 'opened', 'responded']);
  const rec = read => ({ read });
  const go = (from, ev) => F.moveRead(rec(from), ev);
  assert.equal(go('new', 'see'), 'seen');
  assert.equal(go('new', 'open'), 'opened');
  assert.equal(go('seen', 'open'), 'opened');
  assert.equal(go('opened', 'open'), 'opened');
  for (const from of ['new', 'seen', 'opened', 'responded']) assert.equal(go(from, 'respond'), 'responded');
  assert.equal(go('seen', 'resurface'), 'new');
  assert.equal(go('opened', 'resurface'), 'new');
  for (const [from, ev] of [['seen', 'see'], ['opened', 'see'], ['responded', 'see'], ['responded', 'open'],
    ['new', 'resurface'], ['responded', 'resurface']]) assert.throws(() => go(from, ev), /cannot/, `${from} ${ev}`);
  assert.throws(() => go('new', 'bury'), /no such move/);
  assert.throws(() => go('read', 'see'), /no such state/);
  assert.equal(F.canMoveRead(rec('responded'), 'open'), false);
});

test('read state through the engine: see, open, markResponded; withdrawn and unknown posts refuse', async () => {
  const r = rig();
  const site = r.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A }));
  await follow(r, A);
  await r.f.refresh();
  const key = F.keyOf(A, idOf(1));
  assert.equal(r.f.readMove(key, 'see'), 'seen');
  assert.throws(() => r.f.readMove(key, 'see'), /cannot see while seen/);
  assert.equal(r.f.markResponded(A, idOf(1)), true);
  assert.equal(r.f.itemByKey(key).read, 'responded');
  assert.throws(() => r.f.readMove(key, 'open'), /cannot open while responded/);
  assert.equal(r.f.markResponded(A, idOf(99)), false, 'a post not on the list is not touched');
  assert.throws(() => r.f.readMove('nope', 'see'), /no such post/);
  // a responded post is not put back to new by a maintenance bump or an edit
  site.put(makeDoc({ id: idOf(1), origin: A, body: 'changed', version: 2, updated: '2026-11-09T10:00:00Z' }));
  await r.f.refresh();
  assert.equal(r.f.itemByKey(key).read, 'responded');
  assert.equal(r.f.markAllSeen(), 0);
  r.done();
});

test('blyg state: one list, one function, illegal moves refused', () => {
  assert.deepEqual(F.BLYG_STATES, ['active', 'paused', 'unreachable', 'gone']);
  const b = s => ({ state: s });
  assert.equal(F.moveBlyg(b('active'), 'pause'), 'paused');
  assert.equal(F.moveBlyg(b('paused'), 'resume'), 'active');
  assert.equal(F.moveBlyg(b('gone'), 'resume'), 'active');
  assert.equal(F.moveBlyg(b('active'), 'fail'), 'unreachable');
  assert.equal(F.moveBlyg(b('unreachable'), 'recover'), 'active');
  for (const [from, ev] of [['paused', 'fail'], ['paused', 'vanish'], ['gone', 'fail'], ['active', 'recover'], ['active', 'resume'], ['gone', 'pause']]) {
    assert.throws(() => F.moveBlyg(b(from), ev), /cannot/, `${from} ${ev}`);
  }
  assert.throws(() => F.moveBlyg(b('active'), 'explode'), /no such move/);
  assert.throws(() => F.moveRun({ state: 'running' }, 'begin'), /cannot begin while running/);
  assert.throws(() => F.moveRun({ state: 'idle' }, 'end'), /cannot end while idle/);
  assert.throws(() => F.moveSchedule({ mode: 'off' }, 'disarm'), /cannot disarm while off/);
  assert.throws(() => F.setIdentity({ identity: 'agrees' }, 'bless'), /no such move/);
});

test('hostile remote content is cleaned when it is kept: no control or bidi-override characters, bounded', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Evil <script>alert(1)</script>‮' });
  const evil = '<img src=x onerror=alert(1)> ‮evil‬ javascript:alert(1) \u0000\u0007 ' + 'x'.repeat(5000);
  site.put(makeDoc({ id: idOf(1), origin: A, title: '<b>t</b>‮⁦bad', body: evil, author: 'Mallory‮<script>' }));
  await follow(r, A);
  await r.f.refresh();
  const i = items(r)[0];
  for (const f of ['title', 'excerpt', 'text', 'author']) {
    assert.ok(!/[‪-‮⁦-⁩\u0000-\u001f]/.test(i[f]), `${f} has no control or override characters`);
    assert.ok(i[f].length <= F.LIMITS.textChars, f);
  }
  assert.ok(!/[‪-‮]/.test(r.f.listBlygs()[0].title));
  // a post whose page is on another host is not kept (the list vouches for pages)
  site.put(makeDoc({ id: idOf(2), origin: A, page: 'https://elsewhere.web.test/steal/' }));
  site.put(makeDoc({ id: idOf(3), origin: A, page: 'javascript:alert(1)' }));
  const s = await r.f.refresh();
  assert.equal(s.invalid, 2);
  assert.equal(items(r).length, 1);
  r.done();
});

test('identityFor: the list vouches for a page it holds; the page\'s own links can disagree', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const id = idOf(1);
  site.put(makeDoc({ id, origin: A, version: 2, updated: '2026-11-02T10:00:00Z' }));
  await follow(r, A);
  await r.f.refresh();
  const page = `${A}f/${id}/`;
  assert.equal(r.f.identityFor('https://other.web.test/x', null).verdict, 'none');
  const none = r.f.identityFor(page, null);
  assert.equal(none.verdict, 'unverified');
  assert.deepEqual([none.result.status, none.result.item.origin, none.result.item.id, none.result.item.version], ['blyg', A, id, 2]);
  assert.equal(none.result.text_partial, true);
  const ok = r.f.identityFor(page, { blyg: `${A}blyg.json`, json: `${A}items/${id}.json` });
  assert.equal(ok.verdict, 'agrees');
  assert.equal(r.f.itemByKey(F.keyOf(A, id)).identity, 'agrees');
  const bad = r.f.identityFor(page, { blyg: `${A}blyg.json`, json: `${A}items/${idOf(2)}.json` });
  assert.equal(bad.verdict, 'disagrees');
  assert.equal(bad.result, undefined, 'a disagreeing page gets no result from the list');
  assert.match(bad.reason, /names post/);
  assert.equal(r.f.itemByKey(F.keyOf(A, id)).identity, 'disagrees');
  assert.equal(r.f.view().entries[0].head.identity, 'disagrees');
  const otherBlyg = r.f.identityFor(page, { blyg: 'https://evil.web.test/blyg.json', json: '' });
  assert.equal(otherBlyg.verdict, 'disagrees');
  r.done();
});

test('netguard is the only way out: following.mjs never calls fetch, http, https or net itself', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'following.mjs'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/\bfetch\s*\(/.test(code), 'no fetch()');
  assert.ok(!/from\s+['"](node:)?(http|https|net|dns|tls)['"]/.test(code), 'no http/https/net/dns import');
  assert.ok(!/\brequire\(\s*['"](node:)?(http|https|net)['"]/.test(code));
  assert.ok(!/\b(XMLHttpRequest|WebSocket|undici|axios)\b/.test(code));
  assert.match(code, /from '\.\/netguard\.mjs'/, 'the default transport is netguard\'s');
  assert.match(code, /get = netGet/, 'and it is the default `get`');
  // the other new files too
  for (const f of ['following-view.mjs']) {
    const p = path.join(HERE, '..', f);
    if (!fs.existsSync(p)) continue;
    const c = fs.readFileSync(p, 'utf8');
    assert.ok(!/\bfetch\s*\(|node:(http|https|net)/.test(c.replace(/<script>[\s\S]*?<\/script>/g, '')), `${f} makes no request`);
  }
});

test('the default transport really is netguard.guardedGet', async () => {
  const guard = await import('../netguard.mjs');
  // a private address is refused by the guard before any request: proof the default path goes through it
  const f = F.createFollowing({ file: path.join(os.tmpdir(), `bfp-fg-${process.pid}.json`) });
  await assert.rejects(() => f.follow('http://127.0.0.1:9/'), /could not ask|refused|no Blygger|not asked/);
  assert.equal(typeof guard.guardedGet, 'function');
});
