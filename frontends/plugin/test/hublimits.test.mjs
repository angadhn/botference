// hublimits.test.mjs — the unread limits turned the right way round (following.mjs, THE LIMITS): a new post always comes in, and
// at a limit the OLDEST unread posts step aside (read state `older`): kept in the list, their text released, never deleted or
// marked read; never a starred, responded or edited one. What still waits is said, one line a blyg. The Feed pages back through
// what it holds ("Older posts"), with no counts anywhere. A store of layout 3 keeps working (moved to 4 on its first read).
//
//   node --test test/hublimits.test.mjs
//
// No network: invented blygs in memory (following-fake.mjs). The numbers are the hosted Hub's (blog netlify/blyg-hub/config.mjs:
// 40 unread per blyg, 300 in all, a sweep of 60 requests and 18 seconds, a target of 50).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { world, publish, A, B, F, N, makeDoc, idOf, day, invariants } from './hub-world.mjs';
import { followingPage } from '../following-view.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOSTED = { following_unread_target: 50, following_max_items_per_blyg: 40, following_max_items_total: 300, following_run_requests: 60, following_run_seconds: 18 };
function hosted(w, extra = {}) {
  return F.createFollowing({ store: w.store, get: (u, o) => { w.clock.t += 10; return w.web.get(u, o); }, now: () => w.clock.t,
    getSettings: () => ({ ...F.followingSettingsOf({ following_unread_target: 50 }).settings, ...HOSTED, ...extra }),
    ceilings: { itemsPerBlyg: 40, itemsTotal: 300 }, timers: { set: () => ({}), clear: () => {} } });
}
const sweep = async (w, e) => { w.clock.t += 1800e3; return e.refresh({ reason: 'timer' }); };
const titlesOf = v => v.entries.map(x => x.head.title);
const num = t => Number(String(t).split(' ')[1]);
const feedDoc = (w, o = A) => w.store.peek('feed', N(o));

test('the stuck sweep of 26 Nov: a blyg of 375 posts filled to its limit of 40, then five new posts: all five come in, the five oldest step aside', async () => {
  const w = world();
  const site = w.web.add(A, { title: 'Alpha' });
  publish(site, 375);
  const e = hosted(w);
  await e.follow(A);
  const first = await sweep(w, e);
  assert.equal(first.new, 40);
  // the initial fill is the newest posts only, up to the limit
  assert.deepEqual(titlesOf(await e.view({ limit: 100 })).map(num).sort((a, b) => b - a), Array.from({ length: 40 }, (_, i) => 375 - i));
  const idle = await sweep(w, e);
  assert.deepEqual([idle.new, idle.requests, idle.errors], [0, 2, 0], 'at rest: the manifest and the index, nothing else (the line the live log showed)');
  publish(site, 380, 376);
  const r = await sweep(w, e);
  // (before the change this answered { new: 0, requests: 2, errors: 0 } for ever, with `capped: 340` unprinted: 335 posts not read
  // back, and the five new ones held back. Now `capped` counts only what the reading back leaves: 335)
  assert.deepEqual([r.new, r.stepped_aside, r.capped, r.waiting, r.errors], [5, 5, 335, 0, 0]);
  const v = await e.view({ limit: 100 });
  assert.equal(v.entries.length, 40, 'still 40 unread with text');
  assert.equal(v.entries[0].head.title, 'Post 380', 'the newest is present');
  for (const k of [376, 377, 378, 379, 380]) assert.ok(titlesOf(v).includes(`Post ${k}`));
  assert.deepEqual(v.older.map(l => l.title), ['Post 340', 'Post 339', 'Post 338', 'Post 337', 'Post 336'], 'the five oldest stepped aside, listed newest first');
  // stepped aside: a slim record in the feed document, no text, not in the ledger (never marked read), its body released
  const fd = feedDoc(w);
  const older = Object.values(fd.items).filter(i => i.read === 'older');
  assert.equal(older.length, 5);
  for (const i of older) {
    assert.ok(!('text' in i) && !('excerpt' in i) && !('body' in i), 'no text kept');
    assert.ok(i.title && i.created && i.kind && i.key && i.version, 'what the list needs');
    assert.ok(JSON.stringify(i).length < 600, `slim: ${JSON.stringify(i).length} bytes`);
  }
  assert.ok(!w.store.peek('ledger', N(A)).ids.some(p => older.some(i => i.id === p[0])), 'not marked read');
  assert.equal(fd.summary.unread, 40);
  assert.deepEqual(invariants(w, A), []);
  // and quiet again after
  const again = await sweep(w, e);
  assert.deepEqual([again.new, again.stepped_aside, again.requests], [0, 0, 2]);
});

test('never stepped aside: a starred post, one responded to, one that came back edited; and never the newest: a new post always comes in', async () => {
  const w = world();
  const site = w.web.add(A, { title: 'Alpha' });
  publish(site, 5);
  const e = hosted(w, { following_max_items_per_blyg: 3 });
  await e.follow(A);
  await sweep(w, e); // posts 3, 4, 5
  const key = async k => e.keyFor(A, idOf(k));
  await e.readRequest({ key: await key(4), move: 'star' });
  publish(site, 7, 6);
  await sweep(w, e); // 6 and 7 in: 3 steps aside (the oldest), 4 is starred and stays
  let v = await e.view({ limit: 100 });
  assert.deepEqual(titlesOf(v).map(num).sort(), [4, 5, 6, 7]);
  assert.deepEqual(v.older.map(l => l.title), ['Post 3'], 'the oldest that may move');
  // a post responded to stays too; and with nothing older left to move, the new post comes in anyway, over the limit (by the
  // protected ones only: the newest three are always there)
  await e.markResponded(A, idOf(5));
  publish(site, 8, 8);
  const r = await sweep(w, e);
  assert.equal(r.new, 1);
  v = await e.view({ limit: 100 });
  assert.deepEqual(titlesOf(v).map(num).sort(), [4, 5, 6, 7, 8], 'a new post is never held back');
  assert.equal(v.older.length, 1);
  publish(site, 9, 9);
  await sweep(w, e); // now 6 is the oldest that may move
  v = await e.view({ limit: 100 });
  assert.deepEqual(titlesOf(v).map(num).sort(), [4, 5, 7, 8, 9]);
  // an edited post (read before, back with an edit) does not step aside either; the table is the judge
  assert.ok(!F.canMoveRead({ read: 'edited' }, 'step_aside'));
  assert.ok(!F.canMoveRead({ read: 'responded' }, 'step_aside'));
  assert.throws(() => F.moveRead({ read: 'archived' }, 'step_aside'), /cannot step_aside while archived/);
  assert.deepEqual(invariants(w, A), []);
});

test('the total limit: the oldest unread across all blygs step aside first', async () => {
  const w = world();
  const a = w.web.add(A, { title: 'Alpha' });
  const b = w.web.add(B, { title: 'Beta' });
  publish(a, 4); // days 1..4
  for (let k = 1; k <= 4; k++) b.put(makeDoc({ id: idOf(100 + k), origin: B, title: `Beta ${k}`, body: `Beta words ${k}.`, created: day(10 + k) }));
  const e = hosted(w, { following_max_items_total: 6 });
  await e.follow(A); await e.follow(B);
  await sweep(w, e);
  const held = titlesOf(await e.view({ limit: 100 }));
  assert.equal(held.length, 6);
  b.put(makeDoc({ id: idOf(105), origin: B, title: 'Beta 5', body: 'Beta words 5.', created: day(20) }));
  w.clock.t = Math.max(w.clock.t, Date.parse(day(20)) + 1);
  const r = await sweep(w, e);
  assert.equal(r.new, 1);
  const v = await e.view({ limit: 100 });
  assert.equal(v.entries.length, 6);
  assert.ok(titlesOf(v).includes('Beta 5'));
  assert.equal(v.older.length, 1);
  const allHeld = [...held, 'Beta 5'];
  const oldestHeld = allHeld.filter(t => t.startsWith('Post')).sort((x, y) => num(x) - num(y))[0];
  assert.equal(v.older[0].title, oldestHeld, 'the oldest of all (Alpha\'s, older than any of Beta\'s) stepped aside, not one of the blyg that grew');
  assert.deepEqual([...invariants(w, A), ...invariants(w, B)], []);
});

test('as the owner reads, the posts that stepped aside come back first, newest first, with their text; nothing older is read back before them', async () => {
  const w = world();
  const site = w.web.add(A, { title: 'Alpha' });
  publish(site, 60);
  const e = hosted(w);
  await e.follow(A);
  await sweep(w, e); // 21..60
  publish(site, 63, 61);
  await sweep(w, e); // 61..63 in; 21, 22, 23 aside
  assert.deepEqual((await e.view({ limit: 100 })).older.map(l => l.title), ['Post 23', 'Post 22', 'Post 21']);
  const top = (await e.view()).entries[0].head;
  const t = await e.readRequest({ key: top.key, move: 'tick' });
  assert.equal(t.topup, true, 'the Feed is below its target and a blyg has more lined up');
  w.clock.t += 60e3;
  const tu = await e.topUp();
  assert.equal(tu.new, 1, 'the top-up brought one back (the page reloads on it)');
  const v = await e.view({ limit: 100 });
  assert.ok(titlesOf(v).includes('Post 23'), 'the newest older post is back in the Feed');
  assert.ok(!titlesOf(v).includes('Post 20'), 'nothing never-fetched came before it');
  assert.deepEqual(v.older.map(l => l.title), ['Post 22', 'Post 21']);
  const back = v.entries.find(x => x.head.title === 'Post 23').head;
  assert.equal(back.read, 'new');
  assert.match(back.body_head, /Words of post 23/, 'with its text again');
  assert.deepEqual(invariants(w, A), []);
});

test('the Feed pages back through what it holds: its unread posts, then the ones that stepped aside; no counts; an older post is read here, ticked or starred', async () => {
  const w = world();
  const site = w.web.add(A, { title: 'Alpha' });
  publish(site, 40);
  const e = hosted(w);
  await e.follow(A);
  await sweep(w, e);
  publish(site, 45, 41);
  await sweep(w, e); // 6..45 unread, 1..5 aside
  const p1 = await e.view({ limit: 30 });
  assert.deepEqual([p1.entries.length, p1.older.length, p1.page.start, p1.page.newer, p1.page.older], [30, 0, 0, null, 30]);
  const p2 = await e.view({ limit: 30, start: 30 });
  assert.deepEqual([p2.entries.length, p2.older.length, p2.page.newer, p2.page.older], [10, 5, 0, null]);
  assert.deepEqual(p2.older.map(l => l.title), ['Post 5', 'Post 4', 'Post 3', 'Post 2', 'Post 1']);
  const settings = F.followingSettingsOf({}).settings;
  const h1 = followingPage({ data: { ...p1, schedule: { mode: 'off' } }, settings, nonce: 'N' });
  const h2 = followingPage({ data: { ...p2, schedule: { mode: 'off' } }, settings, nonce: 'N' });
  assert.match(h1, /<a href="\/hub\?start=30&amp;n=30" class="hub-older-link">Older posts<\/a>/);
  assert.match(h2, /<a href="\/hub\?start=0&amp;n=30" class="hub-newer">Newer posts<\/a>/);
  assert.ok(!/hub-older-link/.test(h2), 'the last page has no Older posts');
  assert.match(h2, /<h2 class="hub-older-head">Older posts<\/h2>/);
  const olderRows = h2.match(/<article class="entry hub-older read-older"/g) || [];
  assert.equal(olderRows.length, 5);
  assert.match(h2, /data-act="read" data-key="[0-9a-f]+">Read it here<\/button>/);
  // NO UNREAD COUNTERS: no number of posts on the page (tabs, filters, pages, the last refresh, the blygs)
  for (const h of [h1, h2]) {
    const visible = h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<form id="settings-form"[\s\S]*?<\/form>/g, '').replace(/<[^>]*>/g, ' ');
    assert.ok(!/\b\d+ (new|unread|posts?|shown|archived|in Background|parts?)\b/.test(visible), `no count: ${(/.{30}\b\d+ (new|unread|posts?|shown|archived|in Background|parts?)\b.{10}/.exec(visible) || [''])[0]}`);
    assert.ok(!/(Feed|Background|Starred|Archive|All|New|Threads|Fragments) \(\d+\)/.test(visible), 'no count on a tab or a filter');
  }
  // an older post: Read it here fetches its text again from its blyg (nothing kept, it stays older)
  const old = p2.older[0];
  const post = await e.fetchPost(old.key);
  assert.match(post.html, /Words of post 5/);
  await e.openedHere(old.key);
  assert.equal((await e.itemByKey(old.key)).read, 'older', 'reading it here does not move it');
  // ... and if its blyg cannot give it, the reader is told why
  site.down = 'connection refused';
  await assert.rejects(() => e.fetchPost(p2.older[1].key), /could not fetch the post/);
  site.down = null;
  // ✓ Read moves it to the Archive (read); a star works as anywhere
  await e.readRequest({ key: p2.older[1].key, move: 'star' });
  await e.readRequest({ key: p2.older[1].key, move: 'tick' });
  assert.equal((await e.itemByKey(p2.older[1].key)).read, 'archived');
  const starred = await e.view({ view: 'starred' });
  assert.equal(starred.starred[0].where, 'archive');
  await e.readRequest({ key: p2.older[2].key, move: 'star' });
  assert.equal((await e.view({ view: 'starred' })).starred.find(l => l.key === p2.older[2].key).where, 'older', 'the Starred tab says where it is: under Older posts');
  assert.deepEqual(invariants(w, A), []);
});

test('nothing waits in silence: a refresh that could not fetch every new post says so in one line for that blyg; the next one clears it', async () => {
  const w = world();
  const site = w.web.add(A, { title: 'Alpha' });
  publish(site, 10);
  const e = hosted(w);
  await e.follow(A);
  await sweep(w, e);
  publish(site, 30, 11); // 20 new posts
  const tight = hosted(w, { following_run_requests: 7 });
  const r = await sweep(w, tight);
  assert.ok(r.new > 0 && r.new < 20, `some came in (${r.new}), some wait`);
  assert.equal(r.waiting, 1);
  const v = await e.view();
  assert.deepEqual(v.waiting.map(x => [x.origin, x.why]), [[A, ['new_waiting']]]);
  const html = followingPage({ data: { ...v, schedule: { mode: 'off' } }, settings: F.followingSettingsOf({}).settings, nonce: 'N' });
  const line = /<p class="mut hub-waiting"[^>]*>([^<]*)<\/p>/.exec(html);
  assert.ok(line, 'one line on the page');
  assert.equal(line[1], 'Alpha: some of its newer posts are still to come: the last refresh ran out of time or requests before it reached them, and the next one brings them.');
  assert.ok(!/\d/.test(line[1]), 'no number in it');
  const r2 = await sweep(w, e);
  assert.equal(r2.waiting, 0);
  assert.deepEqual((await e.view()).waiting, [], 'all in: the line is gone');
  assert.equal(w.store.peek('ledger', N(A)).holding, 'clear');
  // the hold is ONE field, moved only by moveHold, which refuses a move it does not know
  assert.deepEqual(F.HOLD_STATES, ['clear', 'held']);
  assert.throws(() => F.moveHold({ holding: 'clear' }, 'release'), /no such move release/);
  assert.throws(() => F.moveHold({ holding: 'stuck' }, 'hold'), /no such state stuck/);
});

test('a Feed whose blyg has more than 1,000 posts aside keeps the newest 1,000: the oldest leave the list unread (read back again in their turn)', async () => {
  const w = world();
  const site = w.web.add(A, { title: 'Alpha' });
  publish(site, 3);
  const e = hosted(w, { following_unread_target: 1 }); // (no reading back: it would bring them in again)
  await e.follow(A);
  await sweep(w, e);
  // 1,005 older records, as years of stepping aside would leave them (each still listed by its blyg)
  const fd = feedDoc(w);
  for (let k = 1; k <= F.LIMITS.olderPerBlyg + 5; k++) {
    const id = idOf(5000 + k);
    site.put(makeDoc({ id, origin: A, title: `Old ${k}`, created: new Date(Date.parse('2020-01-01T00:00:00Z') + k * 3600e3).toISOString() }));
    fd.items[id] = { key: `${N(A).slice(0, 8)}${String(k).padStart(16, '0')}`, id, kind: 'fragment', version: 1, created: new Date(Date.parse('2020-01-01T00:00:00Z') + k * 3600e3).toISOString(),
      updated: '2020-01-01T00:00:00Z', fetched_at: 1, page: `${A}f/${id}/`, content_hash: 'sha256:x', title: `Old ${k}`, read: 'older', older_at: '2026-01-01T00:00:00Z' };
  }
  const v0 = w.store.entries.get(`feed/${N(A)}`).version;
  await w.store.put('feed', N(A), fd, { ifVersion: v0 });
  publish(site, 4, 4);
  await sweep(w, e);
  const older = Object.values(feedDoc(w).items).filter(i => i.read === 'older');
  assert.equal(older.length, F.LIMITS.olderPerBlyg);
  assert.ok(!older.some(i => ['Old 1', 'Old 2', 'Old 3', 'Old 4', 'Old 5'].includes(i.title)), 'the oldest five left the list');
  assert.ok(!w.store.peek('ledger', N(A)).ids.some(p => p[0] === idOf(5001)), 'and were not marked read');
});

test('a store of layout 3 (the engine before this change wrote it) keeps working: moved to 4 on its first read, once; nothing in it lost', async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'hub-layout3-store.json'), 'utf8'));
  const w = world();
  for (const [k, text] of fx.entries) w.store.entries.set(k, { text, version: `fx-${k}`, at: fx.clock });
  w.clock.t = fx.clock;
  assert.equal(w.store.peek('state', 'following').layout, 3);
  const before = { feedA: feedDoc(w), archA: w.store.peek('archive', N(A)), ledA: w.store.peek('ledger', N(A)), stars: w.store.peek('state', 'stars') };
  const site = w.web.add(A, { title: 'Alpha' }); publish(site, 60);
  const b = w.web.add(B, { title: 'Beta' }); for (let k = 1; k <= 3; k++) b.put(makeDoc({ id: idOf(500 + k), origin: B, title: `Beta ${k}`, body: `Beta words ${k}.`, created: day(k) }));
  // two invocations read it at once: one moves it to 4, the other reads it as 4; no conflict reaches either
  const e1 = hosted(w), e2 = hosted(w);
  const [v1, v2] = await Promise.all([e1.view({ limit: 100 }), e2.view({ limit: 100 })]);
  const main = w.store.peek('state', 'following');
  assert.equal(main.layout, 4);
  assert.deepEqual(main.blygs, (() => { const m = JSON.parse(fx.entries.find(([k]) => k === 'state/following')[1]); return m.blygs; })(), 'the follow list as it was');
  assert.equal(main.migration.state, 'done');
  assert.equal(v1.entries.length, v2.entries.length);
  assert.equal(v1.entries.length, Object.values(before.feedA.items).length + 3, 'every unread post (Alpha\'s and Beta\'s) still in the Feed');
  // the other documents are not rewritten by the move
  assert.deepEqual(feedDoc(w), before.feedA);
  assert.deepEqual(w.store.peek('archive', N(A)), before.archA);
  assert.deepEqual(w.store.peek('ledger', N(A)), before.ledA);
  assert.deepEqual(w.store.peek('state', 'stars'), before.stars);
  const writes = w.store.writes.state;
  await e1.view(); await hosted(w).view();
  assert.equal(w.store.writes.state, writes, 'idempotent: a store of layout 4 is not written again by a read');
  // the owner's states stand: two ticked, one starred, one opened, one responded; their text is still read from the store
  const reads = Object.values(feedDoc(w).items).map(i => i.read);
  assert.ok(reads.includes('opened') && reads.includes('responded'));
  assert.equal(Object.keys(w.store.peek('archive', N(A)).items).length, 2);
  assert.ok(v1.entries.every(x => x.head.body_head), 'each post\'s text is there');
  // and the first sweep after the deploy brings the posts it was holding back: the newest of Alpha's present, the oldest aside
  publish(site, 64, 61);
  const r = await sweep(w, e1);
  assert.equal(r.new, 4);
  const v = await e1.view({ limit: 100 });
  assert.equal(titlesOf(v)[0], 'Post 64');
  assert.ok(v.older.length >= 2);
  assert.deepEqual(invariants(w, A), []);
});
