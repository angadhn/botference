// hubgate.test.mjs — the findings of the hosted-Archive gate review, each as the interleaving (or crash) that showed it.
//   1 the conversion of an older layout: an older writer during it or after it, two converters at once, a crash anywhere, the
//     hosted shape ('legacy' and 'oldbody'), the copy kept through the quiet period
//   2 an unfollow's late deletes never delete a refollow's documents
//   3 a refresh's snapshot never puts back the id of a post unticked meanwhile (a repair is written only from what is current)
//   4 a split archive write (additions, then removals) re-run after a conflict writes its second half
//   5 a refresh writes the main document every LIMITS.mainEvery blygs and at its end, and what a crash costs
//   6 the repairs need no clock; the re-run mode is named; no process-local copy of the follow state
//   7 a clock running ahead never deletes a body in use nor drops a tick in flight
//   8 a store of a newer layout is never written
//   node --test test/hubgate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { F, world, publish, editPost, invariants, readStateOf, A, B, C, N, idOf, CFG, day } from './hub-world.mjs';

const quiet = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };
const engineOn = (store, clock) => F.createFollowing({ store, now: () => clock.t, get: async () => { throw Object.assign(new Error('no network here'), { kind: 'network' }); },
  getSettings: () => CFG.followingSettingsOf({}).settings, timers: { set: () => ({}), clear: () => {} } });

// ---- 1: the conversion ---------------------------------------------------------------------------------------------------------
/** A document of the older layout (the hosted engine before the Archive: every post inside it, read new/seen/opened/responded). */
const itemOf = (o, n, read, key) => ({ origin: o, id: idOf(n), kind: 'fragment', version: 1, title: `Post ${n}`, excerpt: 'x', created: '2026-11-01T00:00:00Z',
  updated: '2026-11-01T00:00:00Z', read, key, fetched_at: Date.parse('2026-11-10T12:00:00Z'), first_seen: '2026-11-01T00:00:00Z', identity: 'unverified', last_change: 'new-words', body_state: 'whole' });
const olderDoc = (base, origins = [A, B]) => ({
  blygs: Object.fromEntries(origins.map(o => [o, { origin: o, title: o, state: 'active', added: '2026-10-01T00:00:00Z', via: 'url', failures: 0 }])),
  items: Object.fromEntries(origins.flatMap((o, j) => [1, 2, 3].map(n => [`${o}\n${idOf(n)}`, itemOf(o, n, ['seen', 'opened', 'new'][n - 1], `${base}${j}${n}`.padEnd(24, '0'))]))),
  last_run: null, inbox: { state: 'off', mentions: [] } });
async function seedOlder(store, doc, { where = 'following', bodies = 'body' } = {}) {
  await store.put('state', where, doc);
  for (const it of Object.values(doc.items)) await store.put(bodies, it.key, `<p>text of ${it.id}</p>`);
}
const feedTexts = v => v.entries.filter(e => /text of/.test(e.head.body_head || '')).length;

test('1: an older writer that rewrites the main document after the conversion: converted again, the documents there KEPT, nothing throws', async () => {
  for (const tick of [false, true]) {
    const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
    const store = F.memoryStore({ now: () => clock.t });
    await seedOlder(store, olderDoc('aaaa'));
    const one = engineOn(store, clock);
    const v1 = await one.view();
    assert.deepEqual([v1.entries.length, feedTexts(v1)], [6, 6]);
    const ticked = v1.entries.find(e => e.head.origin === A).head;
    if (tick) await one.readRequest({ key: ticked.key, move: 'tick' });
    await one.readRequest({ key: v1.entries.find(e => e.head.origin === B).head.key, move: 'tick' }); // (B has a ledger: a read id)
    // the older code writes its document back: what it knows only (no layout, no kept), its posts fetched again under new keys,
    // and it followed C and stopped following B meanwhile
    const again = olderDoc('bbbb', [A, C]);
    await store.put('state', 'following', again);
    const two = engineOn(store, clock);
    const v2 = await two.view();
    const main = store.peek('state', 'following');
    assert.equal(main.layout, F.LAYOUT);
    assert.deepEqual(Object.keys(main.blygs).sort(), [A, C].sort(), 'the older writer\'s follow of C and unfollow of B are taken');
    assert.ok(main.kept[B], 'B, unfollowed by the older code, is KEPT: its read ids stay');
    assert.equal(store.peek('ledger', N(B)).ids.length, 1);
    assert.equal(v2.entries.filter(e => e.head.origin === A).length, tick ? 2 : 3, `${tick ? 'the tick stands' : 'A\'s posts as they were'}: A's documents were kept`);
    assert.ok(v2.entries.filter(e => e.head.origin === A).every(e => /text of/.test(e.head.body_head)), 'and their text');
    assert.equal(v2.entries.filter(e => e.head.origin === C).length, 3, 'C converted from the older document');
    if (tick) assert.deepEqual(readStateOf({ store }, A, ticked.id), { feed: null, archive: 'archived', ledger: true });
    await two.view(); await two.view({ view: 'archive' });
    await assert.rejects(two.readRequest({ key: 'x'.repeat(24), move: 'tick' }), /no such post/, 'a move is refused for what it is, not for a conversion');
  }
});

test('1: two invocations converting at once, one stopped before each of its store calls: both answer, one conversion, nothing lost', async () => {
  let points = 0;
  for (let i = 1; ; i++) {
    const w = world();
    await seedOlder(w.store, olderDoc('aaaa'));
    const one = w.engine('one'), two = w.engine('two');
    const c = w.arm('one', { holdAt: i });
    let r1, e1;
    const p = one.view().then(v => { r1 = v; }, e => { e1 = e; });
    const what = await Promise.race([c.reached.then(() => 'held'), p.then(() => 'done')]);
    if (what === 'done') break;
    points++;
    const v2 = await two.view();
    w.release('one'); await p;
    assert.equal(e1, undefined, `held at ${c.ops[i - 1]}: ${e1 && e1.message}`);
    assert.deepEqual([r1.entries.length, v2.entries.length, feedTexts(v2)], [6, 6, 6], `held at ${c.ops[i - 1]}`);
    const main = w.store.peek('state', 'following');
    assert.equal(main.migration.state, 'keeping_copy');
    assert.equal(Object.keys(w.store.peek('state', 'pre-shard').doc.items).length, 6, 'the copy is the document converted');
  }
  assert.ok(points > 10, `${points} points`);
});

test('1: a crash at every store call of a conversion: the next reader finishes it; nothing lost; the copy kept until the quiet period is over', async () => {
  for (let n = 1; ; n++) {
    const w = world();
    await seedOlder(w.store, olderDoc('aaaa'));
    const one = w.engine('one'); w.arm('one', { crashAt: n });
    let died = false;
    try { await one.view(); } catch (e) { if (e.code !== 'ECRASH') throw e; died = true; }
    const main = w.store.peek('state', 'following');
    if (main.layout === F.LAYOUT && main.migration.state !== 'converting') assert.ok(w.store.peek('state', 'pre-shard'), `crash ${n}: the copy is there once the main document is converted`);
    const v = await w.engine('two').view();
    assert.deepEqual([v.entries.length, feedTexts(v)], [6, 6], `crash at ${n}`);
    assert.equal(w.store.peek('state', 'following').migration.state, 'keeping_copy');
    if (!died) break;
  }
});

test('1: the hosted shape: the older document in "legacy" and its bodies in "oldbody"; a marker the older engine cannot load; bodies copied, not moved', async () => {
  const w = world();
  const doc = olderDoc('aaaa');
  await seedOlder(w.store, doc, { where: 'legacy', bodies: 'oldbody' });
  const v = await w.engine('one').view();
  assert.deepEqual([v.entries.length, feedTexts(v)], [6, 6], 'converted, with the text copied');
  const marker = w.store.peek('state', 'legacy');
  assert.equal(marker.layout, 'moved');
  assert.ok(Object.values(marker.blygs).some(b => b === null), 'a blyg record that is not an object: the older engine stops at once when it loads it');
  assert.deepEqual(Object.values(marker.items).map(i => i.key).sort(), Object.values(doc.items).map(i => i.key).sort(),
    'and it still names every old post (an older sweep that reads it deletes no old body)');
  assert.equal(w.store.names('oldbody').length, 6, 'the old bodies are left where they were');
  assert.equal(w.store.names('body').length, 6, 'and copied');
  // an older invocation's write that lands after the marker cannot happen (it is conditional); one that got in BEFORE it wins:
  const w2 = world();
  await seedOlder(w2.store, doc, { where: 'legacy', bodies: 'oldbody' });
  const one = w2.engine('one');
  const c = w2.arm('one', { holdAt: 3 }); // (1 get main, 2 get legacy) stopped before the marker
  const p = one.view();
  await c.reached;
  assert.equal(c.ops[2], 'put state:legacy');
  await w2.store.put('state', 'legacy', olderDoc('aaaa', [A, B, C])); // the older code followed C
  for (const it of Object.values(olderDoc('aaaa', [A, B, C]).items)) if (it.origin === C) await w2.store.put('oldbody', it.key, `<p>text of ${it.id}</p>`);
  w2.release('one');
  const v2 = await p;
  assert.equal(v2.entries.length, 9, 'converted from the newer document: the older code\'s follow is not lost');
  // the quiet period
  const sweeper = w.engine('s');
  await sweeper.sweep();
  assert.equal(w.store.names('oldbody').length, 6, 'before the quiet period is over, the old bodies stay');
  assert.ok(w.store.peek('state', 'pre-shard'));
  w.clock.t += F.LIMITS.migrationQuietMs + 1;
  await sweeper.sweep();
  assert.equal(w.store.names('oldbody').length, 0, 'after it, they go');
  assert.equal(w.store.peek('state', 'pre-shard'), null);
  assert.deepEqual(w.store.peek('state', 'legacy').items, {}, 'the marker keeps no old post');
  assert.equal(w.store.peek('state', 'following').migration.state, 'done');
  assert.deepEqual([(await w.engine('t').view()).entries.length], [6]);
});

test('1: the hosted shape, a crash at every store call of its conversion: the next reader finishes it, with every text, the old ones untouched', async () => {
  for (let n = 1; ; n++) {
    const w = world();
    const doc = olderDoc('aaaa');
    await seedOlder(w.store, doc, { where: 'legacy', bodies: 'oldbody' });
    const one = w.engine('one'); w.arm('one', { crashAt: n });
    let died = false;
    try { await one.view(); } catch (e) { if (e.code !== 'ECRASH') throw e; died = true; }
    const v = await w.engine('two').view();
    assert.deepEqual([v.entries.length, feedTexts(v)], [6, 6], `crash at ${n}`);
    assert.equal(w.store.names('oldbody').length, 6, `crash at ${n}: the old bodies stay`);
    assert.equal(w.store.peek('state', 'legacy').layout, 'moved');
    assert.equal(Object.keys(w.store.peek('state', 'legacy').items).length, 6);
    if (!died) break;
  }
});

test('1: the migration is ONE field moved by one function that refuses an illegal move; the copy is never deleted before its time', () => {
  assert.deepEqual(F.MIGRATION_STATES, ['not_started', 'converting', 'keeping_copy', 'done']);
  const m = { state: 'not_started' };
  assert.throws(() => F.moveMigration(m, 'finish'), /cannot finish/);
  F.moveMigration(m, 'begin'); F.moveMigration(m, 'converted');
  m.copy_until = 1000;
  assert.throws(() => F.moveMigration(m, 'finish', 999), /quiet period/);
  assert.equal(F.moveMigration(m, 'finish', 1000), 'done');
  assert.throws(() => F.moveMigration(m, 'begin'));
});

test('1: the marker is ONE field moved by one function: it carries its copy until the quiet period ends, then is emptied, and is never read as a copy again', async () => {
  assert.deepEqual(F.MARKER_STATES, ['carrying_copy', 'emptied']);
  const m = { marker: 'emptied' };
  assert.throws(() => F.moveMarker(m, 'empty'), /cannot empty while emptied/);
  const w = world();
  await seedOlder(w.store, olderDoc('aaaa'), { where: 'legacy', bodies: 'oldbody' });
  await w.engine('one').view();
  assert.equal(w.store.peek('state', 'legacy').marker, 'carrying_copy');
  w.clock.t += F.LIMITS.migrationQuietMs + 1;
  await w.engine('s').sweep();
  const after = w.store.peek('state', 'legacy');
  assert.deepEqual([after.marker, after.items, 'doc' in after], ['emptied', {}, false]);
  // an emptied marker with no main document is never converted from: nothing is written, the operator restores
  await w.store.delete('state', 'following');
  const before = w.store.log.length;
  await assert.rejects(w.engine('t').view(), /main document is missing/);
  assert.deepEqual(w.store.log.slice(before), []);
});
test('1: a re-conversion after a rollback never puts back in the Feed a post read in a KEPT ledger (hosted and companion shapes)', async () => {
  for (const where of ['legacy', 'following']) {
    const w = world();
    const doc = olderDoc('aaaa');
    await seedOlder(w.store, doc, where === 'legacy' ? { where: 'legacy', bodies: 'oldbody' } : {});
    const one = w.engine('one');
    const v = await one.view();
    const read = v.entries.find(e => e.head.origin === A).head;
    await one.readRequest({ key: read.key, move: 'tick' });
    await one.unfollow(A); // keeping what was read
    // the rollback: the older document as it was (A followed, the post unread in it), this layout's main document gone
    if (where === 'legacy') { await w.store.put('state', 'legacy', doc); await w.store.delete('state', 'following'); }
    else { await w.store.put('state', 'following', doc); for (const it of Object.values(doc.items)) await w.store.put('body', it.key, `<p>text of ${it.id}</p>`); }
    const v2 = await w.engine('two').view();
    assert.ok(!v2.entries.some(e => e.head.origin === A && e.head.id === read.id), `${where}: the read post is not unread again`);
    assert.equal(v2.entries.filter(e => e.head.origin === A).length, 2, `${where}: the others are`);
    assert.equal(readStateOf(w, A, read.id).ledger, true, `${where}: still read`);
    assert.deepEqual(invariants(w), [], where);
  }
});
// ---- 2: an unfollow's late deletes ---------------------------------------------------------------------------------------------
test('2: an unfollow stopped before each of its deletes while the owner follows again, refreshes and ticks: nothing of the refollow is deleted', async () => {
  for (const forget of [false, true]) {
    let n = 0;
    for (let i = 1; ; i++) {
      const w = world(); const site = w.web.add(A); publish(site, 6);
      const z = w.engine('z'); await z.confirmImport([{ origin: A }]); await z.refresh();
      await z.readRequest({ key: await z.keyFor(A, idOf(1)), move: 'tick' });
      const one = w.engine('one'), two = w.engine('two');
      const c = w.arm('one', { holdAt: i });
      const p = one.unfollow(A, { forget });
      const what = await Promise.race([c.reached.then(() => 'held'), p.then(() => 'done')]);
      if (what === 'done') break;
      if (!c.ops[i - 1].startsWith('delete')) { w.release('one'); await p; continue; }
      n++;
      await two.confirmImport([{ origin: A }]); await two.refresh();
      await two.readRequest({ key: await two.keyFor(A, idOf(2)), move: 'tick' });
      w.release('one'); await p;
      const label = `forget=${forget}, held at ${c.ops[i - 1]}`;
      assert.deepEqual(readStateOf(w, A, idOf(2)), { feed: null, archive: 'archived', ledger: true }, `${label}: the refollow's tick stands`);
      assert.deepEqual(readStateOf(w, A, idOf(1)).ledger, !forget, `${label}: what was read before stays read unless forgotten`);
      assert.equal((await w.engine('v').view()).entries.length, forget ? 5 : 4, label);
      assert.deepEqual(invariants(w), [], label);
    }
    assert.ok(n >= 2, `forget=${forget}: ${n} delete points`);
  }
});

// ---- 3: a refresh's stale snapshot vs an untick ---------------------------------------------------------------------------------
test('3: an untick made while a refresh is stopped at each of its store calls: the post stays unticked, its id never comes back', async () => {
  for (const edit of [true, false]) {
    for (let i = 1; ; i++) {
      const w = world(); const site = w.web.add(A); publish(site, 6);
      const z = w.engine('z'); await z.confirmImport([{ origin: A }]); await z.refresh();
      const k1 = await z.keyFor(A, idOf(1));
      await z.readRequest({ key: k1, move: 'tick' }); w.clock.t += 60e3;
      if (edit) { editPost(site, 1); editPost(site, 2, { words: false }); }
      const one = w.engine('one'), two = w.engine('two');
      const c = w.arm('one', { holdAt: i });
      const p = one.refresh().catch(e => e);
      const what = await Promise.race([c.reached.then(() => 'held'), p.then(() => 'done')]);
      if (what === 'done') break;
      let r;
      try { r = await two.untick(k1); } catch (e) { r = e.message; }
      w.release('one'); await p;
      const label = `edit=${edit}, refresh held at ${c.ops[i - 1]}`;
      assert.deepEqual(invariants(w), [], label);
      if (r === 'new') assert.equal(readStateOf(w, A, idOf(1)).ledger, false, `${label}: the id is not put back`);
      // (or the refresh's edit had brought it back to the Feed first: then there was nothing to untick)
      else assert.ok(edit && /not in the Archive/.test(r) && readStateOf(w, A, idOf(1)).feed === 'edited', `${label}: ${r}`);
    }
  }
});

// ---- 4: a split archive write ------------------------------------------------------------------------------------------------
test('4: an untick stopped at each of its store calls while another tab ticks a post of the same blyg: both stand, nothing half-way', async () => {
  for (let i = 1; ; i++) {
    const w = world(); const site = w.web.add(A); publish(site, 6);
    const z = w.engine('z'); await z.confirmImport([{ origin: A }]); await z.refresh();
    const k = {}; for (const n of [1, 2]) k[n] = await z.keyFor(A, idOf(n));
    await z.readRequest({ key: k[1], move: 'tick' }); w.clock.t += 60e3;
    const one = w.engine('one'), two = w.engine('two');
    const c = w.arm('one', { holdAt: i });
    let r1;
    const p = one.untick(k[1]).then(r => { r1 = r; }, e => { r1 = e; });
    const what = await Promise.race([c.reached.then(() => 'held'), p.then(() => 'done')]);
    if (what === 'done') break;
    await two.readRequest({ key: k[2], move: 'tick' });
    w.release('one'); await p;
    const label = `untick held at ${c.ops[i - 1]}`;
    assert.equal(r1, 'new', label);
    assert.deepEqual(invariants(w), [], label);
    assert.deepEqual(readStateOf(w, A, idOf(1)), { feed: 'new', archive: null, ledger: false }, label);
    assert.deepEqual(readStateOf(w, A, idOf(2)), { feed: null, archive: 'archived', ledger: true }, label);
  }
});

// ---- 5: the main document every mainEvery blygs --------------------------------------------------------------------------------
async function many(n) {
  const w = world({ settings: { following_run_requests: 1000, following_run_seconds: 600, following_unread_target: 50 } });
  const origins = [];
  for (let i = 0; i < n; i++) { const o = `https://b${i}.web.test/`; origins.push(o); publish(w.web.add(o), 3); }
  const e = w.engine('e');
  await e.confirmImport(origins.map(origin => ({ origin })));
  await e.refresh();
  return { w, e, origins };
}
test('5: a steady refresh writes the main document once every 10 blygs and at its end, and nothing else it did not change', async () => {
  const { w, e } = await many(25);
  w.clock.t += 3600e3;
  const before = w.store.log.length;
  const r = await e.refresh();
  assert.equal(r.blygs, 25);
  const writes = w.store.log.slice(before).filter(x => x.startsWith('put'));
  const mains = writes.filter(x => x === 'put state:following').length;
  assert.ok(mains <= Math.ceil(25 / F.LIMITS.mainEvery) + 1, `${mains} writes of the main document: ${writes.join(', ')}`);
  assert.ok(writes.every(x => x === 'put state:following' || x === 'put state:run'), `only the main and run documents: ${writes.join(', ')}`);
  for (const o of Object.keys(w.store.peek('state', 'following').blygs)) assert.equal(w.store.peek('state', 'following').blygs[o].last_try, w.store.peek('state', 'following').blygs[o].last_ok, 'every blyg\'s record says when it was tried');
});

test('5: a crash at any store call of a refresh loses at most LIMITS.mainEvery blygs\' bookkeeping (and nothing of their posts)', async () => {
  for (let n = 1; ; n += 7) {
    const { w } = await many(25);
    w.clock.t += 3600e3;
    const t0 = w.clock.t;
    const one = w.engine('one'); w.arm('one', { crashAt: n });
    let died = false;
    const back = quiet();
    try { await one.refresh(); } catch (e) { if (e.code !== 'ECRASH') throw e; died = true; } finally { back(); }
    const blygs = Object.values(w.store.peek('state', 'following').blygs);
    const tried = blygs.filter(b => b.last_try >= t0).length;
    const reached = w.ctl.get('one').ops.slice(0, n - 1).filter(x => x.startsWith('get ledger')).length; // (a blyg's snapshot reads its ledger; every call from the n-th on dies)
    assert.ok(tried >= Math.max(0, Math.min(25, reached - 1) - F.LIMITS.mainEvery), `crash at ${n}: ${tried} recorded of ~${reached} reached`);
    for (const o of Object.keys(w.store.peek('state', 'following').blygs)) assert.deepEqual(invariants(w, o), [], `crash at ${n}`);
    if (!died) break;
  }
});

// ---- 6: no clock in the repairs; the re-run mode; no process-local follow state --------------------------------------------------
test('6: the repairs need no clock: a tick that died between its archive and feed writes is undone by the next write at once', async () => {
  const w = world(); const site = w.web.add(A); publish(site, 6);
  const z = w.engine('z'); await z.confirmImport([{ origin: A }]); await z.refresh();
  const k2 = await z.keyFor(A, idOf(2)), k3 = await z.keyFor(A, idOf(3));
  const one = w.engine('one');
  const c = w.arm('one');
  void c;
  // find the tick's feed write, and die there
  { const w2 = world(); publish(w2.web.add(A), 6); const z2 = w2.engine('z'); await z2.confirmImport([{ origin: A }]); await z2.refresh();
    const o2 = w2.engine('one'); const c2 = w2.arm('one'); await o2.readRequest({ key: await z2.keyFor(A, idOf(2)), move: 'tick' });
    w.arm('one', { crashAt: c2.ops.indexOf(`put feed:${N(A)}`) + 1 }); }
  await assert.rejects(one.readRequest({ key: k2, move: 'tick' }), /died/);
  assert.deepEqual(readStateOf(w, A, idOf(2)), { feed: 'new', archive: 'archived', ledger: false }, 'half-made: in both');
  await w.engine('two').readRequest({ key: k3, move: 'tick' }); // the same clock: no ten minutes waited
  assert.deepEqual(readStateOf(w, A, idOf(2)), { feed: 'new', archive: null, ledger: false }, 'R1 at once: the tick did not happen');
  assert.deepEqual(invariants(w), []);
});

test('6: the re-run mode is one field moved by one function; there is no process-local copy of the follow state and no repair age', () => {
  assert.deepEqual(F.RERUN_MODES, ['first', 'again', 'again_mine']);
  const a = { rerun: 'first' };
  assert.throws(() => F.moveRerun(a, 'found_mine'), /cannot found_mine while first/);
  F.moveRerun(a, 'conflict'); F.moveRerun(a, 'found_mine');
  assert.equal(a.rerun, 'again_mine');
  const src = fs.readFileSync(new URL('../following.mjs', import.meta.url), 'utf8');
  assert.ok(!/unfollowedHere/.test(src), 'no process-local set of unfollowed blygs');
  assert.ok(!/S\.mine\b/.test(src), 'no boolean for "re-run after my own write"');
  assert.ok(!/repairAgeMs/.test(src) && !('repairAgeMs' in F.LIMITS), 'no repair decided by age');
});

// ---- 7: clocks ---------------------------------------------------------------------------------------------------------------
test('7: a sweeper whose clock runs hours ahead does not delete the text of an untick not committed yet (two sweeps are needed, a count)', async () => {
  const w = world(); const site = w.web.add(A); publish(site, 6);
  const z = w.engine('z'); await z.confirmImport([{ origin: A }]); await z.refresh();
  const k1 = await z.keyFor(A, idOf(1));
  await z.readRequest({ key: k1, move: 'tick' });
  editPost(site, 1);
  const one = w.engine('one');
  const c = w.arm('one');
  void c;
  // stop the untick after it wrote the post's text, before its commit
  { const w2 = world(); publish(w2.web.add(A), 6); const z2 = w2.engine('z'); await z2.confirmImport([{ origin: A }]); await z2.refresh();
    const kk = await z2.keyFor(A, idOf(1)); await z2.readRequest({ key: kk, move: 'tick' });
    const o2 = w2.engine('one'); const c2 = w2.arm('one'); await o2.untick(kk);
    w.arm('one', { holdAt: c2.ops.findIndex(x => x.startsWith('put body')) + 2 }); }
  const p = one.untick(k1);
  await w.ctl.get('one').reached;
  const ahead = w.engine('ahead', { skew: 5 * 3600e3 });
  await ahead.sweep();
  const body = w.store.names('body').filter(n => !Object.values(w.store.peek('feed', N(A)).items).some(r => (r.body || r.key) === n));
  assert.equal(body.length, 1, 'the untick\'s text is there, named by nothing yet');
  w.release('one');
  assert.equal(await p, 'new');
  assert.deepEqual(invariants(w), [], 'its text is kept');
});

test('7: a tick in flight while a refresh whose clock runs 15 minutes ahead writes that blyg\'s archive: the tick\'s record is not dropped', async () => {
  let points = 0;
  for (let i = 1; ; i++) {
    const w = world(); const site = w.web.add(A); publish(site, 6);
    const z = w.engine('z'); await z.confirmImport([{ origin: A }]); await z.refresh();
    const k1 = await z.keyFor(A, idOf(1)), k2 = await z.keyFor(A, idOf(2));
    await z.readRequest({ key: k1, move: 'tick' });
    editPost(site, 1, { words: false }); // a maintenance version of a read post: the refresh writes the archive, not the feed
    const one = w.engine('one'), ahead = w.engine('ahead', { skew: 15 * 60e3 });
    const c = w.arm('one', { holdAt: i });
    let r1;
    const p = one.readRequest({ key: k2, move: 'tick' }).then(r => { r1 = r.read; }, e => { r1 = e.message; });
    const what = await Promise.race([c.reached.then(() => 'held'), p.then(() => 'done')]);
    if (what === 'done') break;
    points++;
    await ahead.refresh();
    w.release('one'); await p;
    const label = `tick held at ${c.ops[i - 1]}`;
    assert.equal(r1, 'archived', label);
    assert.deepEqual(readStateOf(w, A, idOf(2)), { feed: null, archive: 'archived', ledger: true }, label);
    assert.deepEqual(invariants(w), [], label);
  }
  assert.ok(points > 5);
});

// ---- 8: a newer layout -----------------------------------------------------------------------------------------------------
test('8: a store of a NEWER layout is never written: every write path refuses plainly, a view still reads, a sweep does nothing', async () => {
  const w = world(); const site = w.web.add(A); publish(site, 3);
  const z = w.engine('z'); await z.confirmImport([{ origin: A }]); await z.refresh();
  const k = await z.keyFor(A, idOf(1));
  const main = w.store.peek('state', 'following');
  await w.store.put('state', 'following', { ...main, layout: F.LAYOUT + 1 });
  const before = w.store.log.length;
  const old = w.engine('old');
  for (const [what, run] of [['tick', () => old.readRequest({ key: k, move: 'tick' })], ['refresh', () => old.refresh()], ['sweep', () => old.sweep()],
    ['unfollow', () => old.unfollow(A)], ['follow', () => old.confirmImport([{ origin: B }])], ['untick', () => old.untick(k)], ['star', () => old.readRequest({ key: k, move: 'star' })],
    ['pause', () => old.setBlygState(A, 'pause')], ['top-up', () => old.topUp()], ['open', () => old.open(k)], ['check', () => old.checkLayout()]]) {
    await assert.rejects(run(), e => e instanceof F.HubNewer && /being updated; try again in a minute/.test(e.message), what);
  }
  assert.deepEqual(w.store.log.slice(before), [], 'nothing was written');
  assert.equal((await old.view()).entries.length, 3, 'a view still reads');
});

void B; void day;
