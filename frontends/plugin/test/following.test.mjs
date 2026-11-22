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
const inBackground = r => r.f.view({ view: 'background' }).background;

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
    { origin: A, title: 'Alpha\u202eevil', feed: `${A}feed.xml` }, { origin: Bo, title: 'Beta', feed: `${Bo}feed.xml` },
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
  const key = id => r.f.keyFor(A, id);
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
  assert.ok(!(i2 in got), 'a maintenance version (same content_hash) does not put it back on top of the feed: it is in Background');
  const m2 = inBackground(r).find(b => b.type === 'post' && b.post.id === i2);
  assert.equal(m2.reason, 'no new words');
  assert.equal(m2.post.read, 'seen', 'and it is not resurfaced as new');
  assert.equal(m2.post.version, 2);
  assert.equal(m2.post.maintenance, 1);
  assert.ok(!(i3 in got), 'a withdrawn post leaves the list');
  assert.ok(!(i4 in got), 'a post gone from the index leaves the list');
  assert.equal(got[i5].read, 'new');
  assert.equal(r.web.itemRequests().length, 3, 'only the changed, non-withdrawn documents were fetched (the withdrawal is read off the index)');
  // the withdrawn one is a bare marker: not asked about again, no words kept
  const tomb = r.f.itemByKey(key(i3));
  assert.equal(tomb.kind, 'withdrawn');
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
  assert.equal(t.kind, 'thread');
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
    { key: 'z', kind: 'fragment', origin: A, id: f1, created: '2026-11-05T10:00:00Z' }]).length, 2);
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
  r.f.readMove(r.f.keyFor(A, plain), 'see');
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
  const b = r.f.breakerSnapshot('alpha.web.test');
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
  assert.equal(r.f.breakerSnapshot('alpha.web.test').state === 'closed' || r.f.breakerSnapshot('alpha.web.test').state === 'open', true);
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
  assert.equal(r.f.runState(), 'running');
  const [second, third] = await Promise.all([r.f.refresh(), r.f.refresh()]);
  assert.equal(second.started, false);
  assert.equal(third.started, false);
  const done = await first;
  assert.equal(done.started, true);
  assert.equal(r.web.maxInFlight, 1, 'one request at a time, one run at a time');
  assert.equal(r.web.requests.length, 5, 'one run\'s requests only (manifest, index, three documents)');
  assert.equal(r.f.runState(), 'idle');
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
  assert.equal(r.f.scheduleMode(), 'scheduled');
  assert.equal(r.timers.set.at(-1).ms, 45 * 60 * 1000);
  r.timers.set.at(-1).fn();
  await new Promise(res => setTimeout(res, 50));
  assert.equal(items(r).length, 1, 'the timer ran a refresh');
  r.f.unfollow(A);
  assert.equal(r.f.scheduleMode(), 'off');
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
  const key = r.f.keyFor(A, idOf(1));
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
  const site = r.web.add(A, { title: 'Evil <script>alert(1)</script>\u202e' });
  const evil = '<img src=x onerror=alert(1)> \u202eevil\u202c javascript:alert(1) \u0000\u0007 ' + 'x'.repeat(5000);
  site.put(makeDoc({ id: idOf(1), origin: A, title: '<b>t</b>\u202e\u2066bad', body: evil, author: 'Mallory\u202e<script>' }));
  await follow(r, A);
  await r.f.refresh();
  const i = items(r)[0];
  for (const f of ['title', 'excerpt', 'text', 'author']) {
    assert.ok(!/[\u202a-\u202e\u2066-\u2069\u0000-\u001f]/.test(i[f]), `${f} has no control or override characters`);
    assert.ok(i[f].length <= F.LIMITS.textChars, f);
  }
  assert.ok(!/[\u202a-\u202e]/.test(r.f.listBlygs()[0].title));
  // §5.8: a post's page may be on another host (kept, as an outbound link); one that is not a web address is not kept
  site.put(makeDoc({ id: idOf(2), origin: A, page: 'https://elsewhere.web.test/steal/' }));
  site.put(makeDoc({ id: idOf(3), origin: A, page: 'javascript:alert(1)' }));
  const s = await r.f.refresh();
  assert.equal(s.invalid, 1);
  assert.equal(items(r).length, 2);
  assert.equal(items(r).find(i => i.id === idOf(2)).opens_on, 'elsewhere.web.test', 'labelled as opening elsewhere');
  r.done();
});

test('identityFor: the list alone never supplies identity; the page\'s own links must agree', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const id = idOf(1);
  site.put(makeDoc({ id, origin: A, version: 2, updated: '2026-11-02T10:00:00Z' }));
  await follow(r, A);
  await r.f.refresh();
  const page = `${A}f/${id}/`;
  const hints = { blyg: `${A}blyg.json`, json: `${A}items/${id}.json` };
  assert.equal(r.f.identityFor('https://other.web.test/x', hints).verdict, 'none');
  // no links at all: the list is NOT used, detection runs
  const bare = r.f.identityFor(page, null);
  assert.equal(bare.verdict, 'unconfirmed');
  assert.equal(bare.result, undefined);
  assert.equal(r.f.identityFor(page, { blyg: '', json: '' }).result, undefined, 'the extension sends empty links for a page with none');
  // one of the two links is not enough, though nothing contradicts it
  assert.equal(r.f.identityFor(page, { blyg: hints.blyg, json: '' }).verdict, 'unconfirmed');
  assert.equal(r.f.identityFor(page, { blyg: '', json: hints.json }).verdict, 'unconfirmed');
  // both agree: the list's origin, id and version are used, and the answer says where it came from
  const ok = r.f.identityFor(page, hints);
  assert.equal(ok.verdict, 'agrees');
  assert.deepEqual([ok.result.status, ok.result.source, ok.result.item.origin, ok.result.item.id, ok.result.item.version], ['blyg', 'from-list', A, id, 2]);
  assert.equal(r.f.itemByKey(r.f.keyFor(A, id)).identity, 'agrees');
  // a link naming another post, or another blyg: not used, and the entry says so
  const bad = r.f.identityFor(page, { blyg: hints.blyg, json: `${A}items/${idOf(2)}.json` });
  assert.equal(bad.verdict, 'disagrees');
  assert.equal(bad.result, undefined, 'a disagreeing page gets no result from the list');
  assert.match(bad.reason, /names post/);
  assert.equal(r.f.itemByKey(r.f.keyFor(A, id)).identity, 'disagrees');
  assert.equal(r.f.view().entries[0].head.identity, 'disagrees');
  assert.equal(r.f.identityFor(page, { blyg: 'https://evil.web.test/blyg.json', json: hints.json }).verdict, 'disagrees');
  // what comes back cannot be used to change the list
  const copy = r.f.identityFor(page, hints).item;
  copy.version = 99;
  assert.equal(r.f.itemByKey(r.f.keyFor(A, id)).version, 2);
  r.done();
});

test('identityFor: a page outside the blyg\'s mount (§5.8) is identified when ITS links agree, and only then', async () => {
  const r = rig();
  const MOUNT = 'https://site.web.test/blyg/';
  const site = r.web.add(MOUNT, { title: 'Site Notes' });
  const id = idOf(4);
  // the owner's own kind of site: permalinks at /some-post, the blyg mounted at /blyg/
  site.put(makeDoc({ id, origin: MOUNT, page: 'https://site.web.test/some-post' }));
  await follow(r, MOUNT);
  await r.f.refresh();
  assert.equal(items(r).length, 1);
  const hints = { blyg: `${MOUNT}blyg.json`, json: `${MOUNT}items/${id}.json` };
  const ok = r.f.identityFor('https://site.web.test/some-post', hints);
  assert.equal(ok.verdict, 'agrees', 'the page is outside the mount, its own links agree: identity used');
  assert.equal(ok.result.item.id, id);
  const bare = r.f.identityFor('https://site.web.test/some-post', { blyg: '', json: '' });
  assert.equal(bare.verdict, 'unconfirmed', 'the same page with no links: detection');
  assert.equal(bare.result, undefined);
  // and a post whose page is on ANOTHER host is an outbound link, labelled, with the same rule
  const far = makeDoc({ id: idOf(5), origin: MOUNT, page: 'https://other.web.test/p/5' });
  site.put(far);
  await r.f.refresh();
  const e = items(r).find(i => i.id === idOf(5));
  assert.equal(e.opens_on, 'other.web.test');
  assert.equal(r.f.identityFor('https://other.web.test/p/5', { blyg: '', json: '' }).result, undefined);
  assert.equal(r.f.identityFor('https://other.web.test/p/5', { blyg: `${MOUNT}blyg.json`, json: `${MOUNT}items/${idOf(5)}.json` }).verdict, 'agrees');
  r.done();
});

test('identityFor: a blyg cannot claim another blyg\'s page, on a shared host or with a reused id', async () => {
  const r = rig();
  const EVIL = 'https://shared.web.test/evil/', VICTIM = 'https://shared.web.test/victim/';
  const evil = r.web.add(EVIL, { title: 'Evil' });
  const victimSite = r.web.add(VICTIM, { title: 'Victim' });
  const vid = idOf(5), eid = idOf(7);
  const victimPage = `${VICTIM}t/${vid}/`;
  victimSite.put(makeDoc({ id: vid, origin: VICTIM, kind: 'thread', page: `t/${vid}/`, transclusions: [] }));
  evil.put(makeDoc({ id: eid, origin: EVIL, page: victimPage }));
  await follow(r, EVIL);
  await r.f.refresh();
  assert.equal(items(r).length, 1, 'the claim is held (as an address to open)…');
  // …but never supplies identity: the victim page's own links name the victim
  const victimHints = { blyg: `${VICTIM}blyg.json`, json: `${VICTIM}items/${vid}.json` };
  const a = r.f.identityFor(victimPage, victimHints);
  assert.equal(a.verdict, 'disagrees');
  assert.equal(a.result, undefined);
  assert.equal(r.f.identityFor(victimPage, { blyg: '', json: '' }).result, undefined, 'no links: detection');
  // a json-only link with the SAME id on another origin is not used either
  r.web.add('https://reuse.web.test/b/').put(makeDoc({ id: eid, origin: 'https://reuse.web.test/b/' }));
  const reused = r.f.identityFor(victimPage, { blyg: '', json: `https://reuse.web.test/b/items/${eid}.json` });
  assert.equal(reused.verdict, 'disagrees');
  assert.equal(reused.result, undefined);
  // the evil blyg's own links on the victim page (a page that really did link it) are the only way, and then it IS that blyg's
  assert.equal(r.f.identityFor(victimPage, { blyg: `${EVIL}blyg.json`, json: `${EVIL}items/${eid}.json` }).verdict, 'agrees');
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
    // (the page's own script, a constant that runs in the reader's browser against the companion, is the one place `fetch` appears)
    assert.ok(!/\bfetch\s*\(|node:(http|https|net)/.test(c.replace(/const SCRIPT = `[\s\S]*?`;/, '')), `${f} makes no request`);
  }
});

test('the default transport really is netguard.guardedGet', async () => {
  const guard = await import('../netguard.mjs');
  // a private address is refused by the guard before any request: proof the default path goes through it
  const f = F.createFollowing({ file: path.join(os.tmpdir(), `bfp-fg-${process.pid}.json`) });
  await assert.rejects(() => f.follow('http://127.0.0.1:9/'), /could not ask|refused|no Blygger|not asked/);
  assert.equal(typeof guard.guardedGet, 'function');
});

test('the extension reaches the Hub: a drawer button, the worker\'s open-here at /hub, and an options link', () => {
  const ext = f => fs.readFileSync(path.join(HERE, '..', 'extension', f), 'utf8');
  assert.match(ext('drawer.js'), /data-act="following"/);
  assert.match(ext('drawer.js'), /'following': \(\) => cb\('onOpenFollowing'\)\(\)/);
  assert.match(ext('content.js'), /onOpenFollowing: \(\) => \{ bg\(\{ t: 'open-here', path: '\/hub' \}\); \}/);
  // the worker only opens paths of this shape at the companion
  assert.match('/hub', /^\/[A-Za-z0-9/_-]*$/);
  assert.match(ext('options.js'), /'\/hub'/);
  assert.match(ext('options.html'), /id="following-link"/);
  assert.match(ext('options.js'), /following-link/);
});

test('the user docs name every state and every setting', () => {
  const doc = fs.readFileSync(path.join(HERE, '..', '..', '..', 'docs', 'blygger.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## The Hub: a private reading feed'), doc.indexOf('## What is fetched, and when')).replace(/\s+/g, ' ');
  assert.ok(section.length > 500, 'the section exists');
  for (const s of [...F.BLYG_STATES, ...F.READ_STATES, ...F.INBOX_STATES]) assert.ok(section.includes(`*${s}*`), `state ${s}`);
  for (const w of ['Hub', 'Feed', 'Mentions', 'Background', 'Following', '/hub', 'chmod 600', 'PLUGIN_PUBLIC_HOSTNAMES', 'older-pinned', 'pinned: v1, v4', 'linked from', 'reposted by', 'class unknown', 'MENTION_FIELDS', 'unverified']) assert.ok(section.includes(w), w);
  for (const k of [...Object.keys(F.FOLLOWING_NUMBERS), 'my_origins', 'inbox_api_url', 'inbox_token_file']) assert.ok(section.includes(k), `setting ${k}`);
});

// ---- the review's fixes ---------------------------------------------------------------

test('fetch scope: a manifest cannot send the companion to another host for its index or its documents (named reason, nothing fetched)', async () => {
  for (const [what, manifest] of [['index', { items: 'https://third.web.test/items/index.json' }], ['item', { item: 'https://third.web.test/items/{id}.json' }],
    ['index on the same host but another mount', { items: '/other/items/index.json' }], ['http downgrade', { items: 'http://alpha.web.test/notes/items/index.json' }]]) {
    const r = rig();
    const site = r.web.add(A);
    r.web.add('https://third.web.test/');
    r.web.add('https://alpha.web.test/other/');
    for (let n = 1; n <= 5; n++) site.put(makeDoc({ id: idOf(n), origin: A }));
    const orig = r.web.get;
    const f = F.createFollowing({ file: path.join(r.dir, 'scope.json'), getSettings: () => SETTINGS(), timers: { set: () => 1, clear: () => {} },
      get: async (u, o) => (u === `${A}blyg.json` ? { status: 200, url: u, text: JSON.stringify({ blyg: '0.4', title: 't', ...manifest }) } : orig(u, o)) });
    f.confirmImport([{ origin: A }]);
    const s = await f.refresh();
    assert.ok(s.refused >= 1, `${what}: refused`);
    assert.equal(r.web.requests.filter(u => !u.startsWith(A) || /\/other\//.test(u)).length, 0, `${what}: nothing outside the blyg was requested`);
    assert.match(f.listBlygs()[0].last_error, /outside the blyg's own origin/, `${what}: the reason is named`);
    r.done();
  }
  // a document that arrives from somewhere else after a redirect is not accepted
  const r = rig();
  const site = r.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A }));
  const orig = r.web.get;
  const f = F.createFollowing({ file: path.join(r.dir, 'redir.json'), getSettings: () => SETTINGS(), timers: { set: () => 1, clear: () => {} },
    get: async (u, o) => { const x = await orig(u, o); return /items\/0/.test(u) ? { ...x, url: 'https://third.web.test/items/x.json' } : x; } });
  f.confirmImport([{ origin: A }]);
  const s = await f.refresh();
  assert.equal(s.refused, 1);
  assert.equal(f.view().entries.length, 0);
  assert.match(f.listBlygs()[0].last_error, /served from outside/);
  r.done();
});

test('an index that lies about versions is not chased: one fetch, not one per run, until its entry changes', async () => {
  const r = rig();
  const site = r.web.add(A);
  const id = idOf(1);
  site.put(makeDoc({ id, origin: A, version: 3, updated: '2026-11-02T10:00:00Z' }));
  const orig = r.web.get;
  const f = F.createFollowing({ file: path.join(r.dir, 'lie.json'), getSettings: () => SETTINGS(), timers: { set: () => 1, clear: () => {} },
    get: async (u, o) => {
      const x = await orig(u, o);
      if (!u.endsWith('items/index.json')) return x;
      const j = JSON.parse(x.text); j.items[0].version = 1; return { ...x, text: JSON.stringify(j) };
    } });
  f.confirmImport([{ origin: A }]);
  let s = await f.refresh();
  assert.equal(s.mismatched, 1);
  assert.equal(r.web.itemRequests().length, 1);
  for (let n = 0; n < 3; n++) s = await f.refresh();
  assert.equal(r.web.itemRequests().length, 1, 'the lie is not refetched every run');
  assert.equal(f.view().entries[0].head.version, 3, 'the document is the ground truth (§13.1)');
  assert.deepEqual(f.itemByKey(f.keyFor(A, id)).index_mismatch, { index: 1, document: 3 });
  r.done();
});

test('an index that lies the other way (a version the document does not have) is not chased either', async () => {
  const r = rig();
  const site = r.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A, version: 3, updated: '2026-11-02T10:00:00Z' }));
  const orig = r.web.get;
  const f = F.createFollowing({ file: path.join(r.dir, 'lie2.json'), getSettings: () => SETTINGS(), timers: { set: () => 1, clear: () => {} },
    get: async (u, o) => {
      const x = await orig(u, o);
      if (!u.endsWith('items/index.json')) return x;
      const j = JSON.parse(x.text); j.items[0].version = 5; return { ...x, text: JSON.stringify(j) };
    } });
  f.confirmImport([{ origin: A }]);
  for (let n = 0; n < 4; n++) await f.refresh();
  assert.equal(r.web.itemRequests().length, 1, 'fetched once, not on every run');
  assert.equal(f.itemByKey(f.keyFor(A, idOf(1))).index_version, 5);
  r.done();
});

test('fetching off: refresh makes no request, the timer disarms, every route that re-arms it obeys', async () => {
  let on = true;
  const clock = { t: 1 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-following-'));
  const web = makeWeb();
  web.add(A).put(makeDoc({ id: idOf(1), origin: A }));
  const timers = { set: [], cleared: 0 };
  const f = F.createFollowing({ file: path.join(dir, 'f.json'), get: web.get, now: () => clock.t, mayFetch: () => on,
    getSettings: () => SETTINGS(), timers: { set: (fn, ms) => { const h = { fn, ms }; timers.set.push(h); return h; }, clear: () => { timers.cleared++; } } });
  f.confirmImport([{ origin: A }]);
  assert.equal(f.scheduleMode(), 'scheduled');
  on = false;
  web.requests.length = 0;
  const off = await f.refresh();
  assert.equal(off.started, false);
  assert.match(off.reason, /off/);
  await assert.rejects(() => f.follow(A), /could not ask|off/);
  await assert.rejects(() => f.previewImport({ url: 'https://roll.web.test/x.opml' }), /off|fetch/);
  assert.equal(web.requests.length, 0, 'not one request');
  // the timer fires once more, finds fetching off, and disarms itself
  timers.set.at(-1).fn();
  assert.equal(f.scheduleMode(), 'off');
  // actions that re-arm the timer do not while fetching is off
  f.confirmImport([{ origin: Bo }]);
  f.setBlygState(Bo, 'pause');
  assert.equal(f.unfollow(Bo), true);
  assert.equal(f.reschedule(), 'off');
  assert.equal(web.requests.length, 0);
  on = true;
  assert.equal(f.reschedule(), 'scheduled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unfollow during a refresh leaves no orphan posts, and orphans are pruned on load', async () => {
  const r = rig();
  const site = r.web.add(A);
  for (let n = 1; n <= 6; n++) site.put(makeDoc({ id: idOf(n), origin: A }));
  await follow(r, A);
  r.web.delayMs = 15;
  const run = r.f.refresh();
  await new Promise(res => setTimeout(res, 50));
  assert.equal(r.f.unfollow(A), true);
  const atUnfollow = r.web.requests.length;
  const s = await run;
  assert.equal(s.started, true);
  assert.ok(r.web.requests.length - atUnfollow <= 1, 'once unfollowed, the blyg is not asked for more (at most the request already in flight)');
  assert.ok(s.aborted >= 1);
  assert.equal(r.f.view().entries.length, 0);
  assert.equal(r.f.view({ view: 'background' }).background.length, 0);
  const onDisk = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.items), [], 'nothing of an unfollowed blyg is on disk');
  // an orphan left by an older version is dropped when the file is loaded
  onDisk.items['x\ny'] = { key: 'k', origin: 'https://gone.web.test/', id: 'y', kind: 'fragment', version: 1, read: 'new' };
  fs.writeFileSync(r.file, JSON.stringify(onDisk));
  const again = r.reload();
  again.listBlygs();
  await again.refresh();
  assert.ok(!('x\ny' in JSON.parse(fs.readFileSync(r.file, 'utf8')).items));
  r.done();
});

test('the key a page carries is random per record (not computable from the post) and the engine returns copies, not live records', async () => {
  const r = rig();
  r.web.add(A).put(makeDoc({ id: idOf(1), origin: A }));
  await follow(r, A);
  await r.f.refresh();
  const key = r.f.keyFor(A, idOf(1));
  assert.match(key, /^[0-9a-f]{24}$/);
  const crypto = await import('node:crypto');
  assert.notEqual(key, crypto.createHash('sha1').update(`${A}\n${idOf(1)}`).digest('hex').slice(0, 20));
  assert.equal(r.f.itemByKey(F.identOf(A, idOf(1))), null, 'the post\'s own identity is not a key');
  r.f.unfollow(A);
  await follow(r, A);
  await r.f.refresh();
  assert.notEqual(r.f.keyFor(A, idOf(1)), key, 'a new record, a new key');
  const rec = r.f.itemByKey(r.f.keyFor(A, idOf(1)));
  rec.read = 'responded'; rec.title = 'tampered';
  assert.equal(r.f.itemByKey(r.f.keyFor(A, idOf(1))).read, 'new');
  const snap = r.f.breakerSnapshot('alpha.web.test');
  assert.throws(() => { 'use strict'; snap.state = 'open'; }, TypeError);
  assert.equal(r.f.runState(), 'idle');
  r.done();
});

test('open: a post becomes opened and the answer is its ORIGINAL address; withdrawn and unknown keys are refused; a mention-free key cannot open anything', async () => {
  const r = rig();
  const site = r.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A }));
  site.put(makeDoc({ id: idOf(2), origin: A, created: '2026-11-02T10:00:00Z' }));
  await follow(r, A);
  await r.f.refresh();
  const k1 = r.f.keyFor(A, idOf(1)), k2 = r.f.keyFor(A, idOf(2));
  assert.deepEqual(r.f.open(k1), { url: `${A}f/${idOf(1)}/`, opens_on: '' });
  assert.equal(r.f.itemByKey(k1).read, 'opened');
  site.put(makeDoc({ id: idOf(2), origin: A, kind: 'withdrawn', title: '', version: 2, created: '2026-11-02T10:00:00Z', updated: '2026-11-05T10:00:00Z' }));
  await r.f.refresh();
  assert.throws(() => r.f.open(k2), /no such post/);
  assert.throws(() => r.f.open('nope'), /no such post or mention/);
  assert.throws(() => r.f.readMove(k2, 'see'), /no such post/);
  r.done();
});

test('clock skew: a post dated in the future cannot sit on top (ordering uses at most the time it was fetched)', async () => {
  const r = rig();
  const site = r.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'Honest', created: '2026-11-09T10:00:00Z' }));
  site.put(makeDoc({ id: idOf(2), origin: A, title: 'From the future', created: '2099-01-01T00:00:00Z', updated: '2099-01-01T00:00:00Z' }));
  await follow(r, A);
  r.clock.t = Date.parse('2026-11-10T12:00:00Z');
  await r.f.refresh();
  const titles = r.f.view().entries.map(e => e.head.title);
  assert.deepEqual(titles, ['From the future', 'Honest'], 'newest fetched is first, but not by claiming 2099');
  assert.ok(Date.parse(r.f.view().entries[0].head.shown_at) <= r.clock.t, 'and its shown date is not in the future');
  r.clock.t += 5 * 3600 * 1000;
  site.put(makeDoc({ id: idOf(3), origin: A, title: 'Later honest', created: '2026-11-10T14:00:00Z' }));
  await r.f.refresh();
  assert.equal(r.f.view().entries[0].head.title, 'Later honest', 'a later real post goes above the forged one');
  r.done();
});

test('the per-blyg document cap per run: at most docsPerBlygRun documents, the rest next run', async () => {
  const r = rig({ settings: { following_run_requests: 2000, following_max_items_per_blyg: 2000, following_max_items_total: 20000 } });
  const site = r.web.add(A);
  const N = F.LIMITS.docsPerBlygRun + 10;
  for (let n = 1; n <= N; n++) site.put(makeDoc({ id: idOf(n), origin: A, created: `2026-10-${String(1 + (n % 28)).padStart(2, '0')}T10:00:00Z` }));
  await follow(r, A);
  const s = await r.f.refresh();
  assert.equal(r.web.itemRequests().length, F.LIMITS.docsPerBlygRun);
  assert.equal(s.new, F.LIMITS.docsPerBlygRun);
  assert.equal(s.deferred, 10);
  await r.f.refresh();
  assert.equal(r.web.itemRequests().length, N);
  r.done();
});

test('placement: one function says which view a post or mention belongs to, with a named reason', () => {
  const blyg = { state: 'active' };
  const post = o => ({ kind: 'fragment', origin: A, read: 'new', last_change: 'new-words', ...o });
  const at = (p, extra = {}) => F.placementOf({ type: 'post', post: p, blyg, mine: [], burstHead: null, ...extra });
  assert.deepEqual(at(post({})), { placement: 'feed', reason: '' });
  assert.deepEqual(at(post({ kind: 'withdrawn' })), { placement: 'background', reason: 'withdrawn' });
  assert.deepEqual(at(post({ kind: 'withdrawn' }), { mine: [A] }), { placement: 'background', reason: 'withdrawn (your own)' });
  assert.deepEqual(at(post({}), { blyg: { state: 'paused' } }), { placement: 'background', reason: 'paused blyg' });
  assert.deepEqual(at(post({}), { burstHead: post({ kind: 'thread' }) }), { placement: 'background', reason: 'part of a burst' });
  assert.deepEqual(at(post({ read: 'seen', last_change: 'maintenance' })), { placement: 'background', reason: 'no new words' });
  assert.deepEqual(at(post({ read: 'seen', last_change: 'minor' })), { placement: 'background', reason: 'barely changed' });
  assert.deepEqual(at(post({ read: 'new', last_change: 'maintenance' })), { placement: 'feed', reason: '' }, 'a post never read is still new to the reader');
  assert.deepEqual(at(post({}), { blyg: null }), { placement: 'hidden', reason: 'not followed' });
  const m = (klass, action = '') => F.placementOf({ type: 'mention', mention: { class: klass, action } });
  assert.deepEqual(m('response', 'replied'), { placement: 'mentions', reason: 'response' });
  assert.deepEqual(m('notice', 'linked'), { placement: 'background', reason: 'linked from' });
  assert.deepEqual(m('notice', 'reposted'), { placement: 'background', reason: 'reposted by' });
  assert.deepEqual(m('plain', 'webmention'), { placement: 'mentions', reason: 'plain mention (lower class)' });
  assert.deepEqual(m('unknown'), { placement: 'mentions', reason: 'class unknown' });
  for (const v of [at(post({})), m('notice')]) assert.ok(F.PLACEMENTS.includes(v.placement));
});

test('Background: maintenance and barely-changed versions, burst members, withdrawn and paused-blyg posts; a real new version brings a post back to the Feed', async () => {
  const r = rig({ settings: { following_barely_changed_percent: 5 } });
  const site = r.web.add(A);
  const [maint, minor, edited, frag, th, gone, other] = [1, 2, 3, 4, 5, 6, 7].map(idOf);
  const body = 'a sentence of invented words that goes on for a while. '.repeat(8);
  for (const [id, t] of [[maint, 'Maint'], [minor, 'Minor'], [edited, 'Edited']]) site.put(makeDoc({ id, origin: A, title: t, body, created: '2026-11-01T10:00:00Z' }));
  site.put(makeDoc({ id: frag, origin: A, title: 'Frag', created: '2026-11-05T10:00:00Z' }));
  site.put(makeDoc({ id: th, origin: A, kind: 'thread', title: 'Thread', created: '2026-11-05T10:01:00Z', transclusions: [{ origin: A, id: frag, version: 1 }] }));
  site.put(makeDoc({ id: gone, origin: A, title: 'Soon gone', created: '2026-11-02T10:00:00Z' }));
  await follow(r, A);
  await r.f.refresh();
  r.f.markAllSeen();
  site.put(makeDoc({ id: maint, origin: A, title: 'Maint', body, version: 2, created: '2026-11-01T10:00:00Z', updated: '2026-11-06T10:00:00Z' }));
  site.put(makeDoc({ id: minor, origin: A, title: 'Minor', body: body.replace('invented', 'imagined'), version: 2, created: '2026-11-01T10:00:00Z', updated: '2026-11-06T10:00:00Z' }));
  site.put(makeDoc({ id: edited, origin: A, title: 'Edited', body: 'something else entirely, rewritten from the ground up. '.repeat(8), version: 2, created: '2026-11-01T10:00:00Z', updated: '2026-11-06T10:00:00Z' }));
  site.put(makeDoc({ id: gone, origin: A, kind: 'withdrawn', title: '', version: 2, created: '2026-11-02T10:00:00Z', updated: '2026-11-06T10:00:00Z' }));
  const s = await r.f.refresh();
  assert.deepEqual([s.maintenance, s.minor, s.edited], [1, 1, 1]);
  const bg = Object.fromEntries(inBackground(r).map(b => [b.post.id, b.reason]));
  assert.deepEqual(bg, { [maint]: 'no new words', [minor]: 'barely changed', [frag]: 'part of a burst', [gone]: 'withdrawn' });
  const feed = r.f.view().entries.map(e => e.head.id);
  assert.ok(feed.includes(edited) && feed.includes(th) && !feed.includes(maint) && !feed.includes(minor) && !feed.includes(frag));
  assert.equal(r.f.view().entries.find(e => e.head.id === th).members.length, 1);
  assert.equal(r.f.view().tabs.background, 4);
  // a real new version brings a background post back
  site.put(makeDoc({ id: maint, origin: A, title: 'Maint', body: 'now actually different words, all of them. '.repeat(8), version: 3, created: '2026-11-01T10:00:00Z', updated: '2026-11-07T10:00:00Z' }));
  await r.f.refresh();
  assert.ok(r.f.view().entries.some(e => e.head.id === maint), 'back in the Feed');
  assert.ok(!inBackground(r).some(b => b.post && b.post.id === maint));
  // a paused blyg's posts are background
  r.f.setBlygState(A, 'pause');
  assert.equal(r.f.view().entries.length, 0);
  assert.ok(inBackground(r).every(b => b.reason === 'paused blyg' || b.reason === 'withdrawn'));
  r.done();
});

test('barely changed is measured only when it honestly can be: whole texts, same heading; 0 means identical words only', () => {
  const mk = (text, title = 'T', extra = {}) => ({ text, title, text_chars: text.length, ...extra });
  const base = 'x'.repeat(500);
  assert.equal(F.barelyChanged(mk(base), mk(base.slice(0, 250) + 'y' + base.slice(251)), 2), true);
  assert.equal(F.barelyChanged(mk(base), mk('z'.repeat(500)), 2), false);
  assert.equal(F.barelyChanged(mk(base), mk(base.slice(0, 250) + 'y' + base.slice(251)), 0), false, 'threshold 0: only the same hash');
  assert.equal(F.barelyChanged(mk(base), mk(base.slice(0, 250) + 'y' + base.slice(251), 'Other'), 2), false, 'a changed heading is not barely changed');
  const clipped = mk('x'.repeat(1200), 'T', { text_chars: 5000 });
  assert.equal(F.barelyChanged(clipped, mk('x'.repeat(1199) + 'y', 'T', { text_chars: 5000 }), 20), false, 'a clipped text cannot be measured, so it is not claimed');
  assert.equal(F.changeOf(null, { content_hash: 'a' }, 2), 'new-words');
  assert.equal(F.changeOf({ content_hash: 'a', kind: 'fragment' }, { content_hash: 'a' }, 2), 'maintenance');
});

test('NO OTHER WAY OUT: with every outbound primitive of the process made to throw, the engine\'s only traffic is its injected transport', async () => {
  const [http, https, net, dns, tls] = (await Promise.all(['node:http', 'node:https', 'node:net', 'node:dns', 'node:tls'].map(m => import(m)))).map(m => m.default);
  const trips = [];
  const saved = [];
  const stub = (obj, name, label) => { if (typeof obj[name] !== 'function') return; saved.push([obj, name, obj[name]]); obj[name] = function () { trips.push(label); throw new Error(`outbound ${label}`); }; };
  for (const [o, n] of [[globalThis, 'fetch'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect'], [net, 'createConnection'],
    [tls, 'connect'], [dns, 'lookup'], [dns, 'resolve']]) stub(o, n, n);
  try {
    const r = rig();
    const site = r.web.add(A);
    for (let n = 1; n <= 3; n++) site.put(makeDoc({ id: idOf(n), origin: A }));
    r.web.add(Bo).put(makeDoc({ id: idOf(9), origin: Bo }));
    await r.f.follow(`${A}f/${idOf(1)}/`);
    await r.f.previewImport({ text: JSON.stringify([{ origin: Bo, title: 'B' }]) });
    r.f.confirmImport([{ origin: Bo }]);
    const s = await r.f.refresh();
    assert.equal(s.new, 4);
    assert.ok(r.web.requests.length > 0, 'the injected transport carried everything');
    assert.deepEqual(trips, [], 'nothing else tried to go out');
    // and a call that tries, by any spelling, is caught by the stubs
    assert.throws(() => globalThis['fe' + 'tch']('http://x.invalid/'), /outbound/);
    assert.deepEqual(trips, ['fetch']);
    r.done();
  } finally { for (const [o, n, f] of saved) o[n] = f; }
});

test('an unread post is never hidden: a burst folds its members only under a head that is itself in the Feed', async () => {
  const r = rig({ settings: { following_barely_changed_percent: 5 } });
  const site = r.web.add(A);
  const [th, old, fresh] = [1, 2, 3].map(idOf);
  const body = 'a sentence of invented words that goes on for a while. '.repeat(8);
  site.put(makeDoc({ id: old, origin: A, title: 'Old fragment', created: '2026-11-05T10:00:00Z' }));
  site.put(makeDoc({ id: th, origin: A, kind: 'thread', title: 'Thread', body, created: '2026-11-05T10:01:00Z', transclusions: [{ origin: A, id: old, version: 1 }] }));
  await follow(r, A);
  await r.f.refresh();
  r.f.readMove(r.f.keyFor(A, th), 'open');          // the reader opened the thread...
  r.f.readMove(r.f.keyFor(A, old), 'see');
  // ...and it is republished barely changed, now transcluding a NEW fragment
  site.put(makeDoc({ id: fresh, origin: A, title: 'Fresh fragment', created: '2026-11-08T10:00:00Z' }));
  site.put(makeDoc({ id: th, origin: A, kind: 'thread', title: 'Thread', body: body.replace('invented', 'imagined'), version: 2, created: '2026-11-05T10:01:00Z',
    updated: '2026-11-08T10:01:00Z', transclusions: [{ origin: A, id: old, version: 1 }, { origin: A, id: fresh, version: 1 }] }));
  const s = await r.f.refresh();
  assert.equal(s.minor, 1);
  const feed = r.f.view().entries.map(e => e.head.id);
  assert.ok(feed.includes(fresh), 'the unread fragment is in the Feed');
  assert.ok(r.f.view({ filter: 'new' }).entries.some(e => e.head.id === fresh), 'and in New');
  assert.equal(r.f.view().tabs.feed, feed.length);
  assert.ok(!feed.includes(th), 'the barely changed, already opened thread went to Background');
  const bg = Object.fromEntries(inBackground(r).map(b => [b.post.id, b.reason]));
  assert.equal(bg[th], 'barely changed');
  assert.ok(!(fresh in bg));
  // when the head IS in the Feed, its members fold under it as before
  r.f.markAllSeen();
  const pure = F.buildView({ items: [{ origin: A, id: th, kind: 'thread', read: 'new', last_change: 'new-words', created: '2026-11-05T10:01:00Z', updated: '2026-11-05T10:01:00Z',
    refs: [{ origin: A, id: old }], key: 'h' }, { origin: A, id: old, kind: 'fragment', read: 'new', last_change: 'new-words', created: '2026-11-05T10:00:00Z', updated: '2026-11-05T10:00:00Z', refs: [], key: 'm' }],
    blygs: { [A]: { state: 'active' } } });
  assert.deepEqual(pure.feed.entries.map(e => [e.head.key, e.members.map(m => m.key)]), [['h', ['m']]]);
  r.done();
});

test('placement: a post that is still new to the reader never goes to Background for "barely changed" or "no new words"', () => {
  const post = { kind: 'fragment', origin: A, read: 'new', last_change: 'minor' };
  const at = p => F.placementOf({ type: 'post', post: p, blyg: { state: 'active' }, mine: [], burstHead: null });
  assert.deepEqual(at(post), { placement: 'feed', reason: '' });
  assert.deepEqual(at({ ...post, last_change: 'maintenance' }), { placement: 'feed', reason: '' });
  for (const read of ['seen', 'opened', 'responded']) {
    assert.equal(at({ ...post, read }).placement, 'background', `${read}: a minor change is background`);
  }
});

// ---- versions and pins (§5.2, §8) ------------------------------------------------------------

const BIDI_O = String.fromCharCode(0x202e), NUL = String.fromCharCode(0);
const log5 = [
  { version: 1, at: '2026-11-01T10:00:00Z', note: 'first publish', pinned: true },
  { version: 2, at: '2026-11-02T10:00:00Z', note: null },
  { version: 3, at: '2026-11-03T10:00:00Z', note: `<script>alert(1)</script>${BIDI_O}evil ${'n'.repeat(500)}` },
  { version: 4, at: '2026-11-04T10:00:00Z', note: 'tidied', pinned: true },
  { version: 5, at: '2026-11-05T10:00:00Z', note: `note${NUL} with control` },
  { version: 9, at: '2026-11-06T10:00:00Z', note: 'a version the post does not have' },
  { version: 4, at: '2026-11-04T11:00:00Z', note: 'a duplicate' },
  'not an entry', null, { version: 'x' },
];

test('versions and pins are read from the changelog of the document already fetched: cleaned, clipped, one per version; NO pinned document is fetched', async () => {
  const r = rig();
  const site = r.web.add(A);
  const id = idOf(1);
  site.put(makeDoc({ id, origin: A, version: 5, updated: '2026-11-05T10:00:00Z', changelog: log5 }));
  await follow(r, A);
  const before = r.web.requests.length;
  await r.f.refresh();
  const rec = r.f.itemByKey(r.f.keyFor(A, id));
  assert.deepEqual(rec.versions.map(v => [v.version, v.pin]), [[1, 'pinned'], [2, 'unpinned'], [3, 'unpinned'], [4, 'pinned'], [5, 'unpinned']]);
  assert.deepEqual(F.pinnedOf(rec), [1, 4]);
  assert.equal(rec.versions[1].note, '', 'a null note is empty');
  const hostile = rec.versions[2].note;
  assert.ok(hostile.length <= F.LIMITS.noteChars && !hostile.includes(BIDI_O));
  assert.ok(!/[\u0000-\u001f]/.test(rec.versions[4].note), 'control characters are gone');
  assert.deepEqual(F.VERSION_PINS, ['unpinned', 'pinned']);
  // the requests: manifest, index, the one document. Nothing for a pin.
  const asked = r.web.requests.slice(before);
  assert.equal(asked.length, 3, JSON.stringify(asked));
  assert.ok(!asked.some(u => /\/v\d+(\.json|\/)/.test(u)), 'no pinned document or page was requested');
  assert.ok(!r.web.requests.some(u => /\/v\d+(\.json|\/)/.test(u)));
  // the view's entry
  const head = r.f.view().entries[0].head;
  assert.equal(head.versions_note, '5 versions');
  assert.deepEqual(head.pinned_list, [1, 4]);
  assert.deepEqual(head.history.map(v => [v.version, v.mark]), [[5, ''], [4, 'link'], [3, ''], [2, ''], [1, 'link']], 'newest first; a pin of a directory-style page links');
  r.done();
});

test('a pinned version\'s page is linked only when it can be told from what is held; Open opens the current version unless a pin is asked for', async () => {
  const r = rig();
  const site = r.web.add(A);
  const withSlash = idOf(1), noSlash = idOf(2);
  const pins = [{ version: 1, at: '2026-11-01T10:00:00Z', note: 'a', pinned: true }, { version: 2, at: '2026-11-02T10:00:00Z', note: 'b' }];
  site.put(makeDoc({ id: withSlash, origin: A, version: 2, updated: '2026-11-02T10:00:00Z', changelog: pins }));
  site.put(makeDoc({ id: noSlash, origin: A, version: 2, updated: '2026-11-02T10:00:00Z', changelog: pins, page: 'https://alpha.web.test/some-post' }));
  await follow(r, A);
  await r.f.refresh();
  const k1 = r.f.keyFor(A, withSlash), k2 = r.f.keyFor(A, noSlash);
  const marks = id => r.f.view().entries.find(e => e.head.id === id).head.history.find(v => v.version === 1).mark;
  assert.equal(marks(withSlash), 'link');
  assert.equal(marks(noSlash), 'plain', 'a page that is not directory-style: the mark without a link');
  assert.equal(r.f.open(k1).url, `${A}f/${withSlash}/`, 'Open is the current version');
  assert.equal(r.f.open(k1, 1).url, `${A}f/${withSlash}/v1/`, 'a pin only when asked for');
  assert.throws(() => r.f.open(k1, 2), /not pinned/, 'an unpinned version has no page to open');
  assert.throws(() => r.f.open(k1, 7), /not pinned/);
  assert.throws(() => r.f.open(k2, 1), /not pinned|cannot be told/);
  assert.equal(F.pinPageOf({ versions: [{ version: 3, pin: 'pinned' }], page: 'javascript:alert(1)' }, 3), '');
  r.done();
});

test('the identity stamp says which version is read, as one named value: current-unpinned, current-pinned (older-pinned for a pinned version\'s own page)', async () => {
  const B = await import('../blyg.mjs');
  assert.deepEqual(B.VERSION_STATES, ['current-unpinned', 'current-pinned', 'older-pinned']);
  assert.equal(B.versionStateOf({ version: 2, latest: 2, pinned: false }), 'current-unpinned');
  assert.equal(B.versionStateOf({ version: 2, latest: 2, pinned: true }), 'current-pinned');
  assert.equal(B.versionStateOf({ version: 1, latest: 2, pinned: true }), 'older-pinned');
  assert.equal(B.stampFor({ status: 'blyg', item: { origin: A, id: 'x', version: 2, latest: 2, pinned: true, page: A } }).version_state, 'current-pinned');
  const r = rig();
  const site = r.web.add(A);
  const id = idOf(1);
  const hints = { blyg: `${A}blyg.json`, json: `${A}items/${id}.json` };
  site.put(makeDoc({ id, origin: A, version: 2, updated: '2026-11-02T10:00:00Z', changelog: [{ version: 1, at: 'a', note: '', pinned: true }, { version: 2, at: 'b', note: '' }] }));
  await follow(r, A);
  await r.f.refresh();
  let got = r.f.identityFor(`${A}f/${id}/`, hints);
  assert.equal(B.versionStateOf(got.result.item), 'current-unpinned', 'the current version is not the pinned one');
  assert.deepEqual(got.result.item.pinned_versions, [1]);
  assert.equal(B.stampFor(got.result).version_state, 'current-unpinned');
  site.put(makeDoc({ id, origin: A, version: 3, updated: '2026-11-03T10:00:00Z', changelog: [{ version: 1, at: 'a', note: '', pinned: true }, { version: 2, at: 'b', note: '' }, { version: 3, at: 'c', note: '', pinned: true }] }));
  await r.f.refresh();
  got = r.f.identityFor(`${A}f/${id}/`, hints);
  assert.equal(B.stampFor(got.result).version_state, 'current-pinned');
  assert.equal(got.result.item.pinned, true);
  r.done();
});
