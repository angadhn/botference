// hubpairs.test.mjs — EVERY interleaving of two operations of the Hub engine, and a crash at EVERY store call of one.
//
// Pairs: operation X is stopped before its i-th store call (for every i), operation Y runs whole meanwhile, then X goes on; then
// a later invocation reads and refreshes. Crashes: operation X dies at its n-th store call (for every n), then another
// invocation reads, refreshes, ticks and refreshes. After each, the properties of hub-world.mjs (P2..P4) hold, and every
// owner's move that was told "done" stands (P1). Both lists must stay at zero violations.
//
//   node --test test/hubpairs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, publish, editPost, invariants, readStateOf, A, B, idOf } from './hub-world.mjs';

async function setup({ withB = false } = {}) {
  const w = world();
  const site = w.web.add(A); publish(site, 6);
  if (withB) publish(w.web.add(B), 3);
  const z = w.engine('z');
  await z.confirmImport(withB ? [{ origin: A }, { origin: B }] : [{ origin: A }]);
  await z.refresh();
  const k = {};
  for (let i = 1; i <= 6; i++) k[i] = await z.keyFor(A, idOf(i));
  await z.readRequest({ key: k[1], move: 'tick' });
  await z.readRequest({ key: k[3], move: 'star' });
  await z.readRequest({ key: k[5], move: 'tick' });
  w.clock.t += 60e3;
  return { w, site, k, one: w.engine('one'), two: w.engine('two') };
}
const starOn = (w, c, i) => Object.values(w.store.peek('state', 'stars')?.stars || {}).some(e => e.key === c.k[i]);
/** The owner's moves that must stand once told done: [what, post, allowed] */
function verify(w, c, list, label) {
  const out = [];
  const main = w.store.peek('state', 'following');
  const followed = !!main.blygs[A];
  for (const [what, i, want] of list) {
    if (what === 'followed') { if (followed !== i) out.push(`${label}: followed ${followed}`); continue; }
    if (what === 'paused') { if (followed && main.blygs[A].state !== 'paused') out.push(`${label}: not paused`); continue; }
    if (what === 'star') { if (starOn(w, c, i) !== want) out.push(`${label}: star ${i} ${!want}`); continue; }
    if (!followed) continue;
    const st = readStateOf(w, A, idOf(i));
    if (what === 'led') { if (st.ledger !== want) out.push(`${label}: ledger has ${i}: ${st.ledger}`); continue; }
    const r = st.feed || st.archive || 'absent';
    if (!want.includes(r)) out.push(`${label}: post ${i} is ${r} ${JSON.stringify(st)}`);
  }
  return out;
}

const PAIR_OPS = {
  tick2: { run: (e, c) => e.readRequest({ key: c.k[2], move: 'tick' }), ok: () => [['read', 2, ['archived', 'archived_changed']]] },
  batch24: { run: (e, c) => e.readRequest({ ticks: [c.k[2], c.k[4]] }), ok: () => [['read', 2, ['archived', 'archived_changed']], ['read', 4, ['archived', 'archived_changed']]] },
  untick1: { run: (e, c) => e.untick(c.k[1]), ok: () => [['read', 1, ['new', 'edited']]] },
  star2: { run: (e, c) => e.readRequest({ key: c.k[2], move: 'star' }), ok: () => [['star', 2, true]] },
  unstar3: { run: (e, c) => e.readRequest({ key: c.k[3], move: 'unstar' }), ok: () => [['star', 3, false]] },
  refresh: { run: e => e.refresh(), pre: c => { editPost(c.site, 1); editPost(c.site, 2, { words: false }); editPost(c.site, 5, { words: false }); }, ok: () => [] },
  unkeep: { run: e => e.unfollow(A), ok: () => [['followed', false]] },
  unforget: { run: e => e.unfollow(A, { forget: true }), ok: () => [['followed', false], ['star', 3, false]] },
  pause: { run: e => e.setBlygState(A, 'pause'), ok: () => [['paused']] },
  sweep: { run: e => e.sweep(), ok: () => [] },
  view: { run: e => e.view(), ok: () => [] },
};
// pairs whose outcome is the later move's (an unfollow overrides; an untick and a refresh that brings an edit may each win)
const overrides = (a, b) => { const s = new Set([a, b]); return s.has('unkeep') || s.has('unforget') || (s.has('untick1') && s.has('refresh')); };

test('every pairwise interleaving of the owner\'s moves, a refresh, an unfollow, a pause, a sweep and a view: zero violations', async t => {
  const bad = [];
  let runs = 0;
  for (const xn of Object.keys(PAIR_OPS)) for (const yn of Object.keys(PAIR_OPS)) {
    let total;
    { const c = await setup(); PAIR_OPS[xn].pre?.(c); PAIR_OPS[yn].pre?.(c); const ctl = c.w.arm('one'); try { await PAIR_OPS[xn].run(c.one, c); } catch { /* refused */ } total = ctl.count; }
    for (let i = 1; i <= total; i++) {
      const c = await setup(); PAIR_OPS[xn].pre?.(c); PAIR_OPS[yn].pre?.(c);
      const ctl = c.w.arm('one', { holdAt: i }); c.w.arm('two');
      let ex, ey;
      const px = PAIR_OPS[xn].run(c.one, c).then(() => {}, e => { ex = e; });
      await Promise.race([ctl.reached, px]);
      try { await PAIR_OPS[yn].run(c.two, c); } catch (e) { ey = e; }
      c.w.release('one'); await px;
      runs++;
      const label = `${xn}@${i}(${ctl.ops[i - 1] || '-'}) vs ${yn}`;
      const found = invariants(c.w).map(x => `${label}: ${x}`);
      const conf = overrides(xn, yn);
      if (!ex && !conf) found.push(...verify(c.w, c, PAIR_OPS[xn].ok(c), `${label} [X done]`));
      if (!ey && !conf) found.push(...verify(c.w, c, PAIR_OPS[yn].ok(c), `${label} [Y done]`));
      // later: another invocation reads and refreshes; nothing read comes back, nothing done is undone
      c.w.clock.t += 11 * 60e3;
      const three = c.w.engine('three');
      try { await three.view(); await three.refresh(); } catch (e) { found.push(`${label}: a later refresh threw ${e.message}`); }
      found.push(...invariants(c.w).map(x => `${label} [after]: ${x}`));
      if (!ex && !conf) found.push(...verify(c.w, c, PAIR_OPS[xn].ok(c), `${label} [after, X]`));
      if (!ey && !conf) found.push(...verify(c.w, c, PAIR_OPS[yn].ok(c), `${label} [after, Y]`));
      bad.push(...found);
    }
  }
  t.diagnostic(`${runs} interleavings, ${bad.length} violations`);
  assert.ok(runs >= 1300, `${runs} interleavings`);
  assert.deepEqual(bad, [], `${bad.length} violations in ${runs} interleavings`);
});

const CRASH_OPS = {
  tick2: { run: (e, c) => e.readRequest({ key: c.k[2], move: 'tick' }), ok: () => [['read', 2, ['archived']]], no: () => [['read', 2, ['new', 'archived']]] },
  batch: { run: (e, c) => e.readRequest({ ticks: [c.k[2], c.k[4]] }), ok: () => [['read', 2, ['archived']], ['read', 4, ['archived']]], no: () => [] },
  untick1: { run: (e, c) => e.untick(c.k[1]), ok: () => [['read', 1, ['new']], ['led', 1, false]], no: () => [['read', 1, ['archived', 'new']]] },
  untick1edit: { pre: c => editPost(c.site, 1), run: (e, c) => e.untick(c.k[1]), ok: () => [['read', 1, ['new']], ['led', 1, false]], no: () => [['read', 1, ['archived', 'new', 'edited']]] },
  star2: { run: (e, c) => e.readRequest({ key: c.k[2], move: 'star' }), ok: () => [['star', 2, true]], no: () => [] },
  starArchived1: { run: (e, c) => e.readRequest({ key: c.k[1], move: 'star' }), ok: () => [['star', 1, true]], no: () => [] },
  refreshEdit: { pre: c => { editPost(c.site, 1); editPost(c.site, 5); editPost(c.site, 2, { words: false }); publish(c.site, 9, 7); }, run: e => e.refresh(), ok: () => [], no: () => [] },
  unkeep: { run: e => e.unfollow(A), ok: () => [['followed', false]], no: () => [] },
  unforget: { run: e => e.unfollow(A, { forget: true }), ok: () => [['followed', false]], no: () => [] },
  refollowAfterKeep: { pre: async c => { await c.w.engine('p').unfollow(A); }, run: e => e.confirmImport([{ origin: A }]), ok: () => [['followed', true], ['led', 1, true]], no: () => [] },
  sweep: { pre: c => { c.w.clock.t += 2 * 3600e3; }, run: e => e.sweep(), ok: () => [], no: () => [] },
};

test('a crash at every store call of every operation: zero violations, and the next invocation finishes or undoes it', async t => {
  const bad = [];
  let points = 0;
  for (const [name, op] of Object.entries(CRASH_OPS)) {
    for (let n = 1; n < 200; n++) {
      const c = await setup({ withB: true }); await op.pre?.(c);
      const ctl = c.w.arm('one', { crashAt: n });
      let err = null;
      const warn = console.warn; console.warn = () => {};
      try { await op.run(c.one, c); } catch (e) { err = e; } finally { console.warn = warn; }
      const died = ctl.count >= n;
      const label = `${name} died at #${n} (${ctl.ops[n - 1]})`;
      const found = [];
      const v = c.w.engine('v');
      try { await v.view(); await v.view({ view: 'archive' }); await v.view({ view: 'starred' }); } catch (e) { found.push(`${label}: a view threw ${e.message}`); }
      found.push(...invariants(c.w, A, { atRest: false }).map(x => `${label} now: ${x}`));
      if (!died && !err) found.push(...verify(c.w, c, op.ok(c), `${label} completed`));
      c.w.clock.t += 11 * 60e3;
      const t = c.w.engine('t');
      try { await t.view(); await t.refresh(); await t.readRequest({ key: c.k[6], move: 'tick' }).catch(() => {}); await t.refresh(); } catch (e) { found.push(`${label}: recovery threw ${e.message}`); }
      found.push(...invariants(c.w, A).map(x => `${label} after: ${x}`), ...invariants(c.w, B).map(x => `${label} after (B): ${x}`));
      found.push(...verify(c.w, c, !died && !err ? op.ok(c) : op.no(c), `${label} after`));
      bad.push(...found);
      points++;
      if (!died) break;
    }
  }
  t.diagnostic(`${points} crash points, ${bad.length} violations`);
  assert.ok(points >= 160, `${points} crash points`);
  assert.deepEqual(bad, [], `${bad.length} violations at ${points} crash points`);
});
