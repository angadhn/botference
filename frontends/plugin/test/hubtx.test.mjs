// hubtx.test.mjs — the Hub engine under overlapping invocations (following.mjs, "the storage seam"): two engines over ONE store that
// enforces versions, interleaved step by step (one is held before a chosen read or write of the store while the other runs), and a
// process that dies between any two writes of a commit. After every interleaving the same properties are checked:
//   P1 no owner move is lost (tick, untick, mark read, star, unfollow, pause);
//   P2 no read post is unread without a real edit;
//   P3 no archive record and no ledger id is lost or duplicated (a post is in its feed or its archive, never both, at rest; every
//      archive record's id is in its ledger);
//   P4 no body is deleted while its record is unread;
//   P5 the per-day edit-return count is not undercounted (every return of the last 24 hours is in the ledger's `returns`).
//
//   node --test test/hubtx.test.mjs
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
const N = o => F.ledgerName(o);

/**
 * One versioned store, seen by several engines through views that name them. `hold(tag, when)` stops that engine before its next
 * store operation for which `when(op, kind, name)` is true; `reached(tag)` resolves when it is stopped there; `release(tag)` lets it go.
 */
function world({ settings = {} } = {}) {
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const store = F.memoryStore({ now: () => clock.t });
  const web = makeWeb();
  const holds = new Map();
  const view = tag => {
    const step = async (op, kind, name) => {
      const h = holds.get(tag);
      if (h && !h.hit && h.when(op, kind, name)) { h.hit = true; h.at = `${op} ${kind}:${name}`; await new Promise(res => { h.go = res; h.arrived(); }); }
    };
    return {
      kind: 'memory',
      get: async (k, n) => { await step('get', k, n); return store.get(k, n); },
      put: async (k, n, v, o) => { await step('put', k, n); return store.put(k, n, v, o); },
      delete: async (k, n, o) => { await step('delete', k, n); return store.delete(k, n, o); },
      list: async k => { await step('list', k, ''); return store.list(k); },
    };
  };
  const w = {
    clock, store, web,
    engine(tag, extra = {}) {
      return F.createFollowing({ store: view(tag), get: async (u, o) => { clock.t += 10; return web.get(u, o); }, now: () => clock.t,
        getSettings: () => CFG.followingSettingsOf({ following_unread_target: 500, ...settings, ...extra }).settings, timers: { set: () => ({}), clear: () => {} } });
    },
    /** Hold the next web request whose address ends in `suffix` (whichever engine makes it). */
    holdWeb(suffix) {
      let arrived, go;
      const reached = new Promise(res => { arrived = res; });
      const real = web.get;
      web.get = async (u, o) => { if (String(u).endsWith(suffix)) { web.get = real; arrived(); await new Promise(res => { go = res; }); } return real(u, o); };
      return { reached, release: () => go() };
    },
    hold(tag, when) { let arrived; const reached = new Promise(res => { arrived = res; }); holds.set(tag, { when, arrived, reached, hit: false, go: null }); return reached; },
    release(tag) { const h = holds.get(tag); holds.delete(tag); if (h && h.go) h.go(); },
    at: tag => holds.get(tag)?.at,
  };
  return w;
}
const publish = (site, n) => { for (let k = 1; k <= n; k++) site.put(makeDoc({ id: idOf(k), origin: site.origin, title: `Post ${k}`, body: `Words of post ${k}, and some more words to read.`, created: day(k) })); };
const editPost = (site, k, { words = true, v = 2 } = {}) => site.put(makeDoc({ id: idOf(k), origin: site.origin, title: `Post ${k}`,
  body: words ? `Entirely rewritten words of post ${k}, version ${v}, nothing like before at all.` : `Words of post ${k}, and some more words to read.`, version: v, created: day(k), updated: day(100 + v) }));
async function setup({ n = 4, settings } = {}) {
  const w = world({ settings });
  const site = w.web.add(A);
  publish(site, n);
  const one = w.engine('one');
  await one.confirmImport([{ origin: A }]);
  await one.refresh();
  return { w, site, one, two: w.engine('two') };
}

/** P2..P5 on what is stored, and P1 for the moves named in `want`: { read: { key: state }, star: { key: bool }, followed: bool }. */
async function check(w, want = {}, label = '') {
  const s = w.store;
  const followed = !!(s.peek('state', 'following')?.blygs || {})[A];
  if ('followed' in want) assert.equal(followed, want.followed, `${label} P1: follow state`);
  if (!followed) return;
  const feed = s.peek('feed', N(A))?.items || {};
  const arch = s.peek('archive', N(A))?.items || {};
  const led = s.peek('ledger', N(A)) || { ids: [], returns: [] };
  const both = Object.keys(feed).filter(id => arch[id]);
  assert.deepEqual(both, [], `${label} P3: a post in its feed and its archive at once`);
  const ids = led.ids.map(p => p[0]);
  assert.equal(new Set(ids).size, ids.length, `${label} P3: a ledger id twice`);
  for (const id of Object.keys(arch)) assert.ok(ids.includes(id), `${label} P3: archive record ${id} without its ledger id`);
  for (const [id, r] of Object.entries(feed)) {
    if (r.kind === 'withdrawn') continue;
    assert.ok(s.peek('body', r.body || r.key) !== null, `${label} P4: the body of unread ${id} was deleted`);
    if (ids.includes(id)) assert.equal(r.read, 'edited', `${label} P2: read post ${id} is unread as ${r.read} without an edit`);
  }
  const returned = Object.values(feed).filter(r => r.read === 'edited' && r.returned_at && w.clock.t - r.returned_at < 24 * 3600e3).length;
  assert.ok((led.returns || []).length >= returned, `${label} P5: ${returned} returns, ${(led.returns || []).length} counted`);
  const all = { ...arch, ...feed };
  for (const [key, st] of Object.entries(want.read || {})) {
    const rec = Object.values(all).find(r => r.key === key);
    assert.equal(rec ? rec.read : 'absent', st, `${label} P1: read state of ${key}`);
  }
  const stars = s.peek('state', 'stars')?.stars || {};
  for (const [key, on] of Object.entries(want.star || {})) assert.equal(Object.values(stars).some(e => e.key === key), on, `${label} P1: star of ${key}`);
}
const isPut = kind => (op, k) => op === 'put' && k === kind;

// ---- tick vs refresh --------------------------------------------------------------------------------------------------------
for (const words of [false, true]) {
  const what = words ? 'a real edit' : 'a maintenance version';
  test(`tick vs refresh (${what}): the tick lands while the refresh is fetching; the refresh's apply sees it and leaves it archived`, async () => {
    const { w, site, one, two } = await setup();
    const k = await one.keyFor(A, idOf(2));
    editPost(site, 2, { words });
    // the refresh is held while it fetches the post's document: its snapshot said "unread"
    const h = w.holdWeb(`items/${idOf(2)}.json`);
    const run = one.refresh();
    await h.reached;
    assert.equal(await two.readMove(k, 'tick'), 'archived');
    h.release();
    const s = await run;
    assert.equal(s.raced + s.deferred >= 1, true, 'the refresh saw the record had changed');
    await check(w, { read: { [k]: 'archived' } }, what);
    // the next refresh deals with the new version by the edit rule
    await two.refresh();
    await check(w, { read: { [k]: words ? 'edited' : 'archived' } }, `${what}, next refresh`);
  });

  test(`tick vs refresh (${what}): the refresh is held between two writes of its commit; the tick commits; the refresh re-runs, the tick stands`, async () => {
    const { w, site, one, two } = await setup();
    const k = await one.keyFor(A, idOf(2));
    editPost(site, 2, { words });
    editPost(site, 3, { words: true }); // so the refresh has its own change to commit
    const held = w.hold('one', isPut('feed'));
    const run = one.refresh();
    await held;
    assert.equal(await two.readMove(k, 'tick'), 'archived');
    w.release('one');
    await run;
    await check(w, { read: { [k]: 'archived', [await one.keyFor(A, idOf(3))]: 'new' } }, what);
  });
}

test('tick vs refresh, the other order: the tick is held between its archive write and its feed write while a refresh commits', async () => {
  const { w, site, one, two } = await setup();
  const k = await one.keyFor(A, idOf(2));
  editPost(site, 3);
  const held = w.hold('two', isPut('feed')); // after its archive write
  const tick = two.readMove(k, 'tick');
  await held;
  await one.refresh();
  w.release('two');
  assert.equal(await tick, 'archived');
  await check(w, { read: { [k]: 'archived' } });
});

// ---- two ticks, tick vs untick ----------------------------------------------------------------------------------------------
test('two ticks of different posts of one blyg at once: both stand (the second re-runs on the first\'s documents)', async () => {
  const { w, one, two } = await setup();
  const [k1, k2] = [await one.keyFor(A, idOf(1)), await one.keyFor(A, idOf(2))];
  const held = w.hold('one', isPut('feed'));
  const t1 = one.readMove(k1, 'tick');
  await held;
  await two.readMove(k2, 'tick');
  w.release('one');
  await t1;
  await check(w, { read: { [k1]: 'archived', [k2]: 'archived' } });
  assert.deepEqual(w.store.peek('ledger', N(A)).ids.map(p => p[0]).sort(), [idOf(1), idOf(2)]);
});

test('two ticks of the SAME post at once: one archives it, the other is refused plainly; one record, one id', async () => {
  const { w, one, two } = await setup();
  const k = await one.keyFor(A, idOf(2));
  const held = w.hold('one', isPut('feed'));
  const t1 = one.readMove(k, 'tick');
  await held;
  await two.readMove(k, 'tick');
  w.release('one');
  await assert.rejects(t1, /cannot tick while archived/);
  await check(w, { read: { [k]: 'archived' } });
});

test('tick vs untick of one post: whichever commits last decides, and nothing is left half-way', async () => {
  for (const order of ['untick waits', 'tick waits']) {
    const { w, one, two } = await setup();
    const k = await one.keyFor(A, idOf(2));
    await one.readMove(k, 'tick');
    if (order === 'untick waits') {
      // the untick has fetched the post and is about to apply; meanwhile Mark read (a tick of an archived post is refused) and
      // a star land: the untick still applies, on the fresh documents
      const held = w.hold('one', isPut('ledger'));
      const un = one.untick(k);
      await held;
      await two.readRequest({ key: k, move: 'star' });
      w.release('one');
      assert.equal(await un, 'new');
      await check(w, { read: { [k]: 'new' }, star: { [k]: true } }, order);
    } else {
      await one.untick(k);
      const held = w.hold('one', isPut('feed'));
      const t = one.readMove(k, 'tick');
      await held;
      await two.readRequest({ key: k, move: 'star' });
      w.release('one');
      assert.equal(await t, 'archived');
      await check(w, { read: { [k]: 'archived' }, star: { [k]: true } }, order);
    }
  }
});

test('an untick whose post was ticked again meanwhile (by another tab) is refused, never applied over it', async () => {
  const { w, one, two } = await setup();
  const k = await one.keyFor(A, idOf(2));
  await one.readMove(k, 'tick');
  const held = w.hold('one', (op, kind) => op === 'put' && kind === 'body'); // fetched, about to keep its text
  const un = one.untick(k);
  await held;
  assert.equal(await two.untick(k), 'new');
  await two.readMove(k, 'tick');
  w.release('one');
  await assert.rejects(un, /changed meanwhile/);
  await check(w, { read: { [k]: 'archived' } });
});

// ---- unfollow vs refresh; pause vs refresh ------------------------------------------------------------------------------------
test('unfollow vs refresh, both orders: what the owner chose stands, and nothing of the blyg is left behind to come back', async () => {
  for (const order of ['unfollow while the refresh fetches', 'unfollow while the refresh commits']) {
    const { w, site, one, two } = await setup();
    editPost(site, 3);
    const held = order.endsWith('fetches') ? w.hold('one', (op, kind) => op === 'get' && kind === 'feed') : w.hold('one', isPut('feed'));
    const run = one.refresh();
    await held;
    assert.equal(await two.unfollow(A), true);
    w.release('one');
    await run;
    await check(w, { followed: false }, order);
    // followed again: a fresh epoch, nothing written by the late refresh is taken for it; what was read stays read
    await two.confirmImport([{ origin: A }]);
    const v = await two.view();
    assert.equal(v.entries.length, 0, `${order}: nothing comes back from the old follow before a refresh`);
  }
});

test('pause vs refresh: a refresh that read the blyg as active and commits after the owner paused it does not undo the pause', async () => {
  const { w, site, one, two } = await setup();
  editPost(site, 3);
  const held = w.hold('one', (op, kind, name) => op === 'put' && kind === 'state' && name === 'following');
  const run = one.refresh();
  await held;
  assert.equal(await two.setBlygState(A, 'pause'), 'paused');
  w.release('one');
  await run;
  assert.equal(w.store.peek('state', 'following').blygs[A].state, 'paused', 'P1: the pause stands (the refresh re-ran its bookkeeping on it)');
  await check(w);
});

// ---- edit-return vs tick; star vs refresh and tick ---------------------------------------------------------------------------
test('edit-return vs tick: an edit brings one read post back while the owner ticks another; both stand, the return is counted', async () => {
  const { w, site, one, two } = await setup();
  const [k1, k2] = [await one.keyFor(A, idOf(1)), await one.keyFor(A, idOf(2))];
  await one.readMove(k1, 'tick');
  editPost(site, 1);
  const held = w.hold('one', isPut('feed'));
  const run = one.refresh();
  await held;
  await two.readMove(k2, 'tick');
  w.release('one');
  await run;
  await check(w, { read: { [k1]: 'edited', [k2]: 'archived' } });
  assert.deepEqual(w.store.peek('ledger', N(A)).returns.map(x => x[1]), [idOf(1)], 'P5: counted once (a re-run did not count it twice, nor lose it)');
});

test('a refresh fetching an unread post\'s edit vs a tick of it: the tick lands first, the refresh\'s update is not applied over it', async () => {
  const { w, site, one, two } = await setup();
  const k = await one.keyFor(A, idOf(1));
  editPost(site, 1, { v: 2 });
  const h = w.holdWeb(`items/${idOf(1)}.json`);
  const run = one.refresh();
  await h.reached;
  await two.readMove(k, 'tick');
  h.release();
  const s = await run;
  assert.ok(s.raced >= 1);
  await check(w, { read: { [k]: 'archived' } });
  assert.equal(w.store.peek('archive', N(A)).items[idOf(1)].version, 1, 'the record is what the owner ticked');
  // the next refresh sees an archived post with new words: the edit rule returns it, once, counted (P5)
  await two.refresh();
  await check(w, { read: { [k]: 'edited' } });
  assert.deepEqual(w.store.peek('ledger', N(A)).returns.map(x => x[1]), [idOf(1)]);
});

test('star vs refresh and star vs tick, both orders: the star is never merged away', async () => {
  for (const order of ['star during refresh commit', 'refresh after star', 'star during tick', 'tick during star']) {
    const { w, site, one, two } = await setup();
    const k = await one.keyFor(A, idOf(2));
    editPost(site, 2);
    if (order === 'star during refresh commit') {
      const held = w.hold('one', isPut('feed')); const run = one.refresh(); await held;
      await two.readRequest({ key: k, move: 'star' }); w.release('one'); await run;
      await check(w, { star: { [k]: true } }, order);
    } else if (order === 'refresh after star') {
      await two.readRequest({ key: k, move: 'star' }); await one.refresh();
      await check(w, { star: { [k]: true } }, order);
    } else if (order === 'star during tick') {
      const held = w.hold('one', isPut('feed')); const t = one.readMove(k, 'tick'); await held;
      await two.readRequest({ key: k, move: 'star' }); w.release('one'); await t;
      await check(w, { star: { [k]: true }, read: { [k]: 'archived' } }, order);
    } else {
      const held = w.hold('one', (op, kind, name) => op === 'put' && name === 'stars'); const st = one.readRequest({ key: k, move: 'star' }); await held;
      await two.readMove(k, 'tick'); w.release('one'); await st;
      await check(w, { star: { [k]: true }, read: { [k]: 'archived' } }, order);
    }
  }
});

// ---- the lease: two refreshes; top-up vs refresh; a holder that died ---------------------------------------------------------
test('two refreshes at once: one runs, the other is refused by the lease in the store (not by memory); a dead holder\'s lease lapses', async () => {
  const { w, one, two } = await setup();
  const held = w.hold('one', (op, kind) => op === 'get' && kind === 'feed');
  const run = one.refresh();
  await held;
  const second = await two.refresh();
  assert.deepEqual([second.started, second.reason], [false, 'a refresh is already running']);
  assert.match((await two.topUp()).reason, /refresh is running/);
  w.release('one');
  assert.equal((await run).started, true);
  assert.equal(w.store.peek('state', 'run').lease.state, 'idle', 'given back');
  // a holder that died: its lease stays until `until`, then lapses
  const dead = world();
  publish(dead.web.add(A), 2);
  const e1 = dead.engine('x');
  await e1.confirmImport([{ origin: A }]);
  dead.hold('x', (op, kind) => op === 'get' && kind === 'feed');
  void e1.refresh(); // never released: the invocation "died" holding the lease
  await new Promise(res => setTimeout(res, 20));
  const e2 = dead.engine('y');
  assert.equal((await e2.refresh()).started, false, 'refused while the lease is held');
  dead.clock.t = dead.store.peek('state', 'run').lease.until;
  assert.equal((await e2.refresh()).started, true, 'taken back once it lapsed');
});

test('top-up vs refresh: one at a time across invocations; the top-up gap is in the store, so a second engine cannot skip it', async () => {
  const { w, one, two } = await setup({ n: 60, settings: { following_unread_target: 10 } });
  for (const h of (await one.view({ limit: 1000 })).entries.slice(0, 8)) await one.readMove(h.head.key, 'tick');
  const held = w.hold('one', (op, kind) => op === 'get' && kind === 'ledger');
  const t = one.topUp();
  await held;
  assert.match((await two.refresh()).reason, /topped up/);
  assert.match((await two.topUp()).reason, /top-up is already running/);
  w.release('one');
  assert.equal((await t).started, true);
  assert.match((await two.topUp()).reason, /topped up a moment ago/, 'the gap, read from the store by another engine');
  w.clock.t += F.LIMITS.topupGapMs;
  assert.equal((await two.topUp()).started, true);
  await check(w);
});

// ---- crashes between writes --------------------------------------------------------------------------------------------------
/**
 * A process that dies at its n-th store write of an operation, for every n: what is stored is legal (P2..P4), and the next
 * invocation finishes or undoes the operation as COMMIT ORDER says: a tick that died before its feed write did not happen (the
 * post is unread, R1); one that died after it happened (R3 puts its id in the ledger); an untick that died before its feed write
 * did not happen (R3 puts the id back), after it it happened (R1).
 */
async function crashEach(label, prepare, op, { done, undone }) {
  for (let n = 1; n <= 6; n++) {
    const { w, one, two, site } = await setup();
    const ctx = await prepare({ w, one, two, site });
    const before = w.store.log.length;
    w.store.crashAfter(n);
    let died = false;
    try { await op(one, ctx); } catch (e) { if (e.code !== 'ECRASH') throw e; died = true; }
    w.store.crashAfter(0);
    const wrote = w.store.log.slice(before).filter(x => x.startsWith('put') || x.startsWith('delete'));
    // the next invocation reads what is there; a refresh once the half-made move is older than repairAgeMs repairs it (R1)
    w.clock.t += F.LIMITS.repairAgeMs + 1;
    const three = w.engine('three');
    await three.view();
    await three.refresh();
    const rec = await three.itemByKey(ctx.key);
    const state = rec ? rec.read : 'absent';
    assert.ok([done, undone].includes(state), `${label}: died at write ${n} (${wrote.join(', ')}): ${state}`);
    await check(w, {}, `${label} n=${n}`);
    if (!died) break;
  }
}

test('a crash between any two writes of a tick: the post is unread (the tick did not happen) or archived; nothing half-way', async () => {
  await crashEach('tick', async ({ one }) => ({ key: await one.keyFor(A, idOf(2)) }), (e, c) => e.readMove(c.key, 'tick'), { done: 'archived', undone: 'new' });
});

test('a crash between any two writes of an untick: the post is archived (the untick did not happen) or back in the Feed', async () => {
  await crashEach('untick', async ({ one }) => { const key = await one.keyFor(A, idOf(2)); await one.readMove(key, 'tick'); return { key }; },
    (e, c) => e.untick(c.key), { done: 'new', undone: 'archived' });
});

test('a crash between any two writes of a refresh\'s apply (an edit coming back): archived or edited, counted if it came back', async () => {
  await crashEach('edit-return', async ({ one, site }) => { const key = await one.keyFor(A, idOf(2)); await one.readMove(key, 'tick'); editPost(site, 2); return { key }; },
    e => e.refresh(), { done: 'edited', undone: 'archived' });
});

// ---- bodies across invocations -----------------------------------------------------------------------------------------------
test('a body written by one invocation and read by another mid-run: never swept while young, shown once its record is committed', async () => {
  const { w, site, one, two } = await setup();
  site.put(makeDoc({ id: idOf(9), origin: A, title: 'Post 9', body: 'Fresh words of post 9.', created: new Date(w.clock.t + 1000).toISOString() }));
  w.clock.t += 5000;
  const held = w.hold('one', isPut('feed')); // its body is written; its record is not yet
  const run = one.refresh();
  await held;
  const orphan = w.store.names('body').find(nm => !Object.values(w.store.peek('feed', N(A)).items).some(r => (r.body || r.key) === nm));
  assert.ok(orphan, 'the new post\'s body is in the store, named by no record yet');
  await two.sweep();
  assert.ok(w.store.names('body').includes(orphan), 'another invocation\'s sweep leaves a young body alone');
  assert.ok(!(await two.view()).entries.some(e => e.head.id === idOf(9)), 'and its view does not show the post before its record is committed');
  w.release('one');
  await run;
  const v = await two.view();
  assert.match(v.entries.find(e => e.head.id === idOf(9)).head.body_head, /Fresh words of post 9/);
  await check(w);
});

test('loading never sweeps: a view or a move by one invocation deletes no body another wrote', async () => {
  const { w, one, two } = await setup();
  await w.store.put('body', 'ffffffff00000000aaaaaaaa', '<p>another invocation\'s, not committed yet</p>');
  await two.view();
  await two.readMove(await two.keyFor(A, idOf(1)), 'tick');
  await one.view();
  assert.ok(w.store.names('body').includes('ffffffff00000000aaaaaaaa'));
});
