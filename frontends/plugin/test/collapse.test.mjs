// collapse.test.mjs — unit tests for the long-thread fold in
// frontends/plugin/extension/drawer.js: how a message list is grouped into the
// units the drawer draws (msgUnits) and which of those units a long thread
// hides (collapsePlan).
//
//   node frontends/plugin/test/collapse.test.mjs
//
// Both functions are pure — no DOM, no drawer instance — which is the point of
// keeping them at module scope. No framework.
//
// Exit code is the number of failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, 'got  ' + g + '\n      want ' + w);
}

// message builders — `t` is the id the assertions read back
const you = t => ({ author: 'angadh', ts: t, text: t });
const bot = t => ({ author: 'claude', ts: t, text: t });
const tools = t => ({ author: 'claude', ts: t, kind: 'tools', text: 'Explored\n└ Read' });
const ids = units => units.map(u => u.map(m => m.ts));

const plan = (msgs, expanded) => D.collapsePlan(D.msgUnits(msgs), !!expanded);
// what a reader would actually see, in order
function visible(msgs, expanded) {
  const units = D.msgUnits(msgs);
  const p = D.collapsePlan(units, !!expanded);
  const out = [];
  for (let i = 0; i < units.length; i++) {
    if (p.collapsed && i === p.from) out.push('⋯' + p.hidden);
    if (p.collapsed && i >= p.from && i < p.to) continue;
    for (const m of units[i]) out.push(m.ts);
  }
  return out;
}

// ---- 1. grouping into units -------------------------------------------------
{
  eq('a person\'s message is a unit of its own',
    ids(D.msgUnits([you('a'), you('b')])), [['a'], ['b']]);
  eq('a bot turn is one unit, tool rows and all',
    ids(D.msgUnits([you('a'), tools('t1'), bot('b1')])), [['a'], ['t1', 'b1']]);
  eq('two answers in one turn stay in one unit',
    ids(D.msgUnits([you('a'), tools('t1'), bot('b1'), bot('b2')])), [['a'], ['t1', 'b1', 'b2']]);
  eq('a tool row that arrives after its answer is still the same unit',
    ids(D.msgUnits([you('a'), bot('b1'), tools('t1')])), [['a'], ['b1', 't1']]);
  eq('a new person message starts a new unit',
    ids(D.msgUnits([you('a'), bot('b1'), you('c'), bot('b2')])),
    [['a'], ['b1'], ['c'], ['b2']]);
  eq('empty list', ids(D.msgUnits([])), []);
  eq('null list', ids(D.msgUnits(null)), []);
  eq('nulls in the list are dropped', ids(D.msgUnits([you('a'), null, you('b')])), [['a'], ['b']]);
}

// ---- 2. short threads are never folded --------------------------------------
{
  // COLLAPSE_AT units on screen is still short enough to read straight through
  for (let n = 0; n <= D.COLLAPSE_AT; n++) {
    const msgs = [];
    for (let i = 0; i < n; i++) msgs.push(i % 2 ? bot('b' + i) : you('u' + i));
    ok(n + ' units stay whole', plan(msgs).collapsed === false, JSON.stringify(plan(msgs)));
  }
}

// ---- 3. a long thread keeps the root and the live tail ----------------------
{
  // 12 alternating messages = 12 units
  const msgs = [];
  for (let i = 0; i < 12; i++) msgs.push(i % 2 ? bot('b' + i) : you('u' + i));
  const p = plan(msgs);
  ok('12 units fold', p.collapsed === true, JSON.stringify(p));
  eq('the fold starts after the thread root', p.from, D.KEEP_HEAD);
  eq('…and ends KEEP_TAIL from the end', p.to, 12 - D.KEEP_TAIL);
  eq('the count is what is hidden', p.hidden, 12 - D.KEEP_HEAD - D.KEEP_TAIL);

  eq('the root and the last three are what is left',
    visible(msgs), ['u0', '⋯8', 'b9', 'u10', 'b11']);

  // the expander sits between the root and the tail, exactly once
  eq('exactly one expander', visible(msgs).filter(x => String(x)[0] === '⋯').length, 1);

  // opening it gives the whole thread back, in order
  eq('expanding restores every message in order',
    visible(msgs, true), msgs.map(m => m.ts));
  eq('…and reports nothing hidden', plan(msgs, true).collapsed, false);
}

// ---- 4. tool rows never straddle the fold ----------------------------------
{
  // eight turns, each with its own tool row: the fold must cut between units,
  // never between a turn's "Explored" row and the answer it belongs to
  const msgs = [];
  for (let i = 0; i < 8; i++) { msgs.push(you('u' + i)); msgs.push(tools('t' + i)); msgs.push(bot('b' + i)); }
  const seen = visible(msgs);
  for (let i = 0; i < 8; i++) {
    const hasTool = seen.indexOf('t' + i) !== -1, hasBot = seen.indexOf('b' + i) !== -1;
    ok('turn ' + i + ': its tool row and its answer are shown or hidden together',
      hasTool === hasBot, JSON.stringify(seen));
  }
  // …and the tool rows are not counted as messages in the expander's claim
  const p = plan(msgs);
  const hiddenIds = msgs.map(m => m.ts).filter(id => seen.indexOf(id) === -1);
  eq('the count ignores tool rows',
    p.hidden, hiddenIds.filter(id => id[0] !== 't').length);
  ok('…so the count is smaller than the number of records hidden',
    p.hidden < hiddenIds.length, p.hidden + ' vs ' + hiddenIds.length);
}

// ---- 5. a fold has to be worth the click ------------------------------------
{
  // a bot turn carrying several answers is ONE unit but several messages: the
  // unit count can pass the threshold while barely any message is hidden
  const msgs = [you('u0')];
  for (let i = 1; i <= 6; i++) msgs.push(i % 2 ? bot('b' + i) : you('u' + i));
  const p = plan(msgs);
  ok('7 units fold', p.collapsed === true, JSON.stringify(p));
  ok('…and hide at least two messages', p.hidden >= 2, JSON.stringify(p));

  // the degenerate shape the guard exists for: units, but almost no messages
  // in the middle of them
  const tiny = D.collapsePlan(
    [[you('a')], [tools('t')], [tools('t')], [tools('t')], [you('b')], [bot('c')], [bot('d')]], false);
  eq('a middle made only of tool rows is not worth folding', tiny.collapsed, false);
}

// ---- 6. a new reply lands in the visible tail, unfolded ----------------------
{
  // the live case: a collapsed thread the bots are still answering. The reply
  // must appear without the reader having to open anything, and without the
  // hidden middle springing open under them.
  const msgs = [];
  for (let i = 0; i < 12; i++) msgs.push(i % 2 ? bot('b' + i) : you('u' + i));
  const before = plan(msgs);
  // a second answer in the turn already at the tail: same unit, nothing moves
  msgs.push(bot('fresh'));
  ok('the new reply is on screen',
    visible(msgs).indexOf('fresh') !== -1, JSON.stringify(visible(msgs)));
  ok('the thread is still collapsed', plan(msgs).collapsed === true);
  eq('a second answer in the same turn folds nothing away', plan(msgs).hidden, before.hidden);

  // a fresh exchange: two new units at the tail, so two old ones roll into the
  // fold — and still nothing springs open
  msgs.push(you('ask'), bot('answer'));
  const after = plan(msgs);
  const seen = visible(msgs);
  ok('a fresh exchange is on screen',
    seen.indexOf('ask') !== -1 && seen.indexOf('answer') !== -1, JSON.stringify(seen));
  ok('the thread is still collapsed', after.collapsed === true);
  eq('…and the two units it displaced rolled into the fold',
    after.hidden, before.hidden + 2);
  ok('the root is still on screen', seen[0] === 'u0');
}

// ---- 7. degenerate input ----------------------------------------------------
{
  eq('no units', D.collapsePlan([], false).collapsed, false);
  eq('null units', D.collapsePlan(null, false).collapsed, false);
  eq('undefined units', D.collapsePlan(undefined, false).collapsed, false);
  // an already-open thread never folds, however long it is
  const many = [];
  for (let i = 0; i < 40; i++) many.push([you('u' + i)]);
  eq('an expanded thread never folds', D.collapsePlan(many, true).collapsed, false);
  eq('…while the same thread folded would hide 36',
    D.collapsePlan(many, false).hidden, 40 - D.KEEP_HEAD - D.KEEP_TAIL);
}

// ---- report -----------------------------------------------------------------
console.log(`\ncollapse: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail);
