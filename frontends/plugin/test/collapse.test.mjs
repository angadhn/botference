// collapse.test.mjs — unit tests for how a long conversation is drawn in
// frontends/plugin/extension/drawer.js: how a message list is grouped into the
// units the drawer draws (msgUnits), and the window on its newest messages
// (msgWindowPlan / msgWindowMove) that every chat and every comment thread
// uses. (The name is historical: until 2026-11-11 comment threads folded
// their middle, and this file tested that fold. Nothing folds any more.)
//
//   node frontends/plugin/test/collapse.test.mjs
//
// These functions are pure — no DOM, no drawer instance — which is the point of
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
const codex = t => ({ author: 'codex', ts: t, text: t });
// the companion's own line (server.mjs store.appendMsg author 'botference')
const notice = t => ({ author: 'botference', ts: t, text: 'Updated a file' });
const ids = units => units.map(u => u.map(m => m.ts));

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

// ---- 9. a summoned build agent's cards nest under the summoner ---------------
// core/botference.py _run_summon: a bot's reply ends with `summon:`, the
// controller runs an agent, and the agent's cards carry `parent_ts` (the
// summoner's message). The drawer groups them under that message however
// many replies land after them, and never counts them as messages of their own.
{
  const agent = (t, parent, extra = {}) => ({
    author: 'agent', ts: t, parent_ts: parent, text: 'report',
    agent: { id: 'sess:agent:1', card: 'report', summoned_by: 'claude', status: 'done',
      elapsed_s: 75, label: 'Claude Opus 5.5 (high)', ...extra },
  });
  const list = [you('a'), bot('b1'), agent('g1', 'b1'), bot('b2'), you('c'), bot('b3')];
  const { top, kids } = D.nestMsgs(list);
  eq('the card leaves the top-level flow', top.map(m => m.ts), ['a', 'b1', 'b2', 'c', 'b3']);
  eq('…and is filed under the message it summoned from',
    kids.get(list[1]).map(m => m.ts), ['g1']);
  eq('the units are built from the flow, not the cards',
    ids(D.msgUnits(list)), [['a'], ['b1', 'b2'], ['c'], ['b3']]);
  // two messages in one millisecond: the summoner's own is the parent
  const same = [you('a'), { ...bot('x'), author: 'codex' }, bot('x'), agent('g', 'x')];
  const n2 = D.nestMsgs(same);
  eq('the summoner\'s message wins a shared ts', n2.kids.get(same[2]).map(m => m.ts), ['g']);
  ok('…and the other bot gets nothing', !n2.kids.has(same[1]));
  // a card whose parent is gone stays visible, in the bots' span
  const orphan = [you('a'), agent('g', 'gone'), bot('b')];
  eq('an orphan card stays in the flow', ids(D.msgUnits(orphan)), [['a'], ['g', 'b']]);
  ok('isAgentCard needs both the author and the meta',
    D.isAgentCard(agent('g', 'x')) && !D.isAgentCard(bot('b')) && !D.isAgentCard({ author: 'agent', ts: 'z' }));
  // the status line, from the controller's own elapsed_s
  eq('working', D.agentStatus({ status: 'working' }), 'working…');
  eq('done', D.agentStatus({ status: 'done', elapsed_s: 75 }), 'done in 1:15');
  eq('failed', D.agentStatus({ status: 'failed', elapsed_s: 9 }), 'failed after 0:09');
  eq('timed out', D.agentStatus({ status: 'timeout', elapsed_s: 900 }), 'timed out after 15:00');
  // hidden counts never include a nested card
  const long = [];
  for (let i = 0; i < 20; i++) { long.push(you('u' + i)); long.push(bot('b' + i)); long.push(agent('g' + i, 'b' + i)); }
  const p = D.msgWindowPlan(D.msgUnits(long), null);
  const flat = D.msgWindowPlan(D.msgUnits(long.filter(m => !D.isAgentCard(m))), null);
  ok('a nested card is not counted as an earlier message',
    p.start > 0 && p.hidden === flat.hidden && p.hidden === p.start,
    JSON.stringify(p) + ' vs ' + JSON.stringify(flat));
}

// ---- thread status: the rules the drawer and the page share ------------------
// (drawer.js isResolvedThread / isInsertionThread — content.js reads the same
// two through window.BFPDrawer, so a card and the page cannot disagree)
eq('resolved: only the reader\'s flag closes a thread',
  [{ resolved: true }, { resolved: false }, { addressed: true }, null].map(D.isResolvedThread),
  [true, false, false, false]);
eq('insertion: a diff insertion, or an auto-thread that replaced nothing',
  [
    { inserted: true },
    { auto: true },
    { auto: true, prior_quote: 'old words' },
    { auto: true, auto_summary: 'a summary' },
    { auto: true, deleted_passage: true },
    { prior_quote: 'old' },
    null,
  ].map(D.isInsertionThread),
  [true, true, false, false, false, false, false]);

// ---- a long conversation: the window on its newest messages ----------------
// msgWindowPlan / msgWindowMove: no conversation folds — the page chat, the
// library chat and every comment thread draw their newest stretch and grow
// upward. Pure arithmetic here; the same function serves every target.
{
  const P = D.msgWindowPlan, M = D.msgWindowMove;
  const T = i => `2026-11-11T09:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
  // n messages, the reader and a bot taking turns: one unit per message
  const chat = n => Array.from({ length: n }, (_, i) => (i % 2 ? bot : you)(T(i)));
  const U = list => D.msgUnits(list);
  const unitsMsgs = us => us.flat().filter(m => m.kind !== 'tools').length;

  eq('message window: the two modes, named', D.MSG_WINDOW_MODES, ['newest', 'from']);
  eq('message window: the four moves, named', D.MSG_WINDOW_MOVES, ['pin', 'reveal', 'widen', 'reset']);
  eq('message window: about twenty messages, twenty more per reveal', [D.MSG_WINDOW, D.MSG_STEP], [20, 20]);

  // a short chat shows everything, and pinning it changes nothing drawn
  {
    const u = U(chat(6));
    eq('short chat: everything shows', P(u, null), { start: 0, hidden: 0, mode: 'newest' });
    const w = M(u, null, 'pin');
    eq('short chat: pinned at its first message', [w.key, w.at], [T(0) + '|angadh', 0]);
    eq('…and still everything shows', P(u, w).start, 0);
  }
  // an empty chat has nothing to pin
  eq('empty chat: pin leaves it newest', M([], null, 'pin'), null);

  // the default window: fifty one-message units → the last twenty
  const u50 = U(chat(50));
  eq('default window: the newest twenty of fifty', P(u50, null), { start: 30, hidden: 30, mode: 'newest' });

  // whole units: a bot turn of fourteen answers and a tool row straddles the
  // twentieth message from the end, and is drawn whole, not cut
  {
    const list = [];
    for (let i = 0; i < 5; i++) list.push((i % 2 ? bot : you)(T(i)));
    list.push(you(T(5)));
    list.push(tools(T(6)));
    for (let i = 7; i < 21; i++) list.push(bot(T(i)));
    for (let i = 21; i < 31; i++) list.push((i % 2 ? you : codex)(T(i)));
    const u = U(list);
    const big = u.findIndex(x => x.length === 15);
    ok('whole units: the long bot turn is one unit of fifteen rows', big === 6, 'index ' + big);
    // from the end: ten singles (10), then the big turn (24) — the window
    // starts AT the big turn, not inside it; its tool row is not a message
    eq('whole units: the window starts at the turn, not inside it', P(u, null).start, big);
    eq('…and counts the messages above it (tool rows are not messages)', P(u, null).hidden, 6);
  }

  // reveal steps up by about twenty, then to the top, then stops
  {
    let w = M(u50, null, 'pin');
    eq('pinned: same as the default', P(u50, w).start, 30);
    w = M(u50, w, 'reveal');
    eq('reveal: twenty more above', [P(u50, w).start, P(u50, w).hidden], [10, 10]);
    w = M(u50, w, 'reveal');
    eq('reveal: the rest, when fewer than twenty remain', [P(u50, w).start, P(u50, w).hidden], [0, 0]);
    const again = M(u50, w, 'reveal');
    ok('reveal at the top: nothing older, the value is unchanged', again === w);
    // a reveal from the 'newest' mode starts from the default stretch
    eq('reveal from newest: twenty above the default stretch', P(u50, M(u50, null, 'reveal')).start, 10);
  }

  // new messages arriving at the bottom do not move the top
  {
    const w = M(u50, null, 'pin');
    const u60 = U(chat(60));
    eq('arrivals: the anchored top stays where it was', P(u60, w), { start: 30, hidden: 30, mode: 'from' });
    eq('…where an unanchored window would have moved down', P(u60, null).start, 40);
    const r = M(u50, w, 'reveal');
    eq('…and nothing revealed is hidden by them', P(u60, r).start, 10);
  }

  // widening to include a message
  {
    const w = M(u50, null, 'pin');
    const to7 = M(u50, w, 'widen', m => m.ts === T(7));
    eq('widen: the window grows up to the message', P(u50, to7).start, 7);
    ok('widen: a message already shown changes nothing', M(u50, w, 'widen', m => m.ts === T(40)) === w);
    ok('widen: a message that is not there changes nothing', M(u50, w, 'widen', m => m.ts === 'nope') === w);
    eq('widen from newest: pins and grows', P(u50, M(u50, null, 'widen', m => m.ts === T(3))).start, 3);
  }

  // reset, and a value the list no longer matches
  {
    const w = M(u50, M(u50, null, 'pin'), 'reveal');
    eq('reset: back to newest', M(u50, w, 'reset'), null);
    eq('…which draws the default stretch again', P(u50, M(u50, w, 'reset')).start, 30);
    // the anchor message deleted: the remembered index stands in for it
    const gone = U(chat(50).filter(m => m.ts !== T(10)));
    eq('anchor deleted: the window keeps its place', P(gone, w).start, 10);
    // a different, shorter chat: never less than the default stretch
    const other = U(chat(25).map(m => ({ ...m, ts: 'x' + m.ts })));
    eq('a different chat: never less than its newest stretch', P(other, { key: 'gone|x', at: 40 }).start, 5);
  }

  // a comment thread's shape — a root, tool rows, two bots, notices — is cut
  // the same way: nothing in the middle is ever skipped, a short thread shows
  // whole, and a new reply never hides anything already drawn
  {
    const thr = [you('root')];
    for (let i = 0; i < 14; i++) thr.push(you('q' + i), tools('t' + i), bot('c' + i), codex('x' + i), notice('n' + i));
    const u = U(thr);
    const w = M(u, null, 'pin');
    const drawn = u.slice(P(u, w).start).flat().map(m => m.ts);
    const idx = thr.map(m => m.ts);
    ok('thread: what is drawn is one unbroken run ending at the newest message',
      JSON.stringify(drawn) === JSON.stringify(idx.slice(idx.length - drawn.length)), JSON.stringify(drawn));
    ok('…about twenty messages of it, whole turns', unitsMsgs(u.slice(P(u, w).start)) >= 20
      && unitsMsgs(u.slice(P(u, w).start)) < 20 + 4, String(unitsMsgs(u.slice(P(u, w).start))));
    const grown = U(thr.concat([you('new-q'), bot('new-a')]));
    eq('thread: a new reply leaves the top where it was', P(grown, w).start, P(u, w).start);
    const short = U([you('a'), bot('b'), you('c'), bot('d'), you('e')]);
    eq('thread: a short one shows whole, with nothing above it', P(short, M(short, null, 'pin')), { start: 0, hidden: 0, mode: 'from' });
  }

  // illegal moves are refused
  {
    let threw = false;
    try { M(u50, M(u50, null, 'pin'), 'pin'); } catch { threw = true; }
    ok('pin on a pinned window is refused', threw);
    threw = false;
    try { M(u50, null, 'slide'); } catch { threw = true; }
    ok('an unknown move is refused', threw);
  }
}

// ---- report -----------------------------------------------------------------
console.log(`\ncollapse: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail);
