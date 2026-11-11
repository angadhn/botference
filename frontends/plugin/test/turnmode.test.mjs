#!/usr/bin/env node
// IS A BOT WORKING? — one chat's turn as ONE named mode (drawer.js TURN_MODES).
//
// The fault this exists for: after 45 silent seconds (a long tool run) the
// working chip and the stop button vanished while the bot was still working,
// because "is a bot working?" was answered by about eleven separate fields and
// a silence timer. Now each chat has one value — idle / waiting / working /
// stopping / lost — changed only through turnMove, and the truth comes from the
// companion: its turn events, and its own record of what is running (GET /page
// `turns`), which is what a reload, a second tab or a lost event comes back to.
//
//   1. the pure parts: the moves each mode allows, and the record → moves plan
//   2. the drawer: what the chip, the stop button and the footbar draw
//   3. the companion: GET /page `turns` while a turn runs, waits, and ends
//
//   node frontends/plugin/test/turnmode.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHarness, GET, POST, listen } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection', 'ResizeObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const DR = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---- 1. the pure parts -------------------------------------------------------
const { turnMove, turnMode, turnPlan, canTurnMove, TURN_MODES } = DR;

await test('the modes are named in one list', () => {
  assert.deepEqual(TURN_MODES, ['idle', 'waiting', 'working', 'stopping', 'lost']);
  assert.equal(turnMode(null), 'idle', 'no value is idle');
  assert.equal(turnMode({ mode: 'nonsense' }), 'idle');
});

await test('each move starts only from the modes it names, and refuses the rest', () => {
  const idle = null;
  const waiting = turnMove(idle, 'wait', { text: 'waking the agents…' }, 1);
  assert.equal(turnMode(waiting), 'waiting');
  assert.equal(waiting.text, 'waking the agents…');
  const working = turnMove(waiting, 'start', { agents: ['claude'] }, 2);
  assert.equal(turnMode(working), 'working');
  assert.deepEqual(working.agents, ['claude']);
  assert.throws(() => turnMove(working, 'wait', {}, 3), /cannot wait while working/);
  assert.throws(() => turnMove(idle, 'stop', {}, 3), /cannot stop while idle/);
  assert.throws(() => turnMove(waiting, 'stop', {}, 3), /cannot stop while waiting/);
  assert.throws(() => turnMove(idle, 'lose', {}, 3), /cannot lose while idle/);
  assert.throws(() => turnMove(working, 'unstop', {}, 3), /cannot unstop while working/);
  assert.throws(() => turnMove(idle, 'hear', { speaker: 'claude' }), /cannot hear while idle/);
  assert.throws(() => turnMove(working, 'vanish', {}, 3), /no such move/);
  const stopping = turnMove(working, 'stop', {}, 4);
  assert.equal(turnMode(stopping), 'stopping');
  assert.deepEqual(stopping.agents, ['claude'], 'stopping keeps who is on it');
  assert.equal(turnMode(turnMove(stopping, 'unstop', {}, 5)), 'working');
  const lost = turnMove(stopping, 'lose', {}, 6);
  assert.equal(turnMode(lost), 'lost');
  assert.equal(turnMode(turnMove(lost, 'start', {}, 7)), 'working', 'a lost turn the companion says is running');
  assert.equal(turnMode(turnMove(lost, 'wait', {}, 7)), 'waiting');
  for (const m of TURN_MODES) {
    const v = m === 'idle' ? null : { mode: m, at: 1 };
    assert.equal(turnMode(turnMove(v, 'end', {}, 9)), 'idle', 'end is never refused, from ' + m);
    assert.equal(canTurnMove(v, 'start'), true, 'start is never refused, from ' + m);
  }
});

await test('a boundary takes the stamp it is given; hearing who speaks does not', () => {
  const working = turnMove(null, 'start', { agents: [] }, 7);
  assert.equal(working.at, 7);
  const heard = turnMove(working, 'hear', { speaker: 'codex' });
  assert.equal(heard.at, 7, 'a stream is not a boundary');
  assert.equal(heard.speaker, 'codex');
  assert.deepEqual(heard.live, ['codex']);
  assert.deepEqual(working.live, [], 'pure: the old value is untouched');
  assert.equal(turnMove(heard, 'hear', { watching: 'https://youtu.be/x' }).watching, 'https://youtu.be/x');
});

await test("the companion's record decides, chat by chat", () => {
  const all = () => true;
  const turns = {
    a: { mode: 'working', at: 3, agents: ['claude'] },     // record: nothing → its end was lost
    b: { mode: 'idle', at: 2 },                             // record: running → a reload mid-turn
    c: { mode: 'working', at: 3 },                          // record: still running → stays
    d: { mode: 'waiting', at: 3, text: 'queued…' },         // record: waiting → stays as it is
    e: { mode: 'working', at: 3 },                          // record: waiting → that turn ended
    f: { mode: 'lost', at: 3 },                             // record: running → working again
  };
  const record = [
    { target: 'b', state: 'running', agents: ['codex'] },
    { target: 'c', state: 'running', agents: ['claude'] },
    { target: 'd', state: 'waiting' },
    { target: 'e', state: 'waiting' },
    { target: 'f', state: 'running', agents: [] },
    { target: 'g', state: 'waiting' },                      // never heard of → waiting
  ];
  assert.deepEqual(turnPlan(turns, record, all, 5), [
    ['a', 'end'],
    ['b', 'start', { agents: ['codex'] }],
    ['e', 'end'], ['e', 'wait', {}],
    ['f', 'start', { agents: [] }],
    ['g', 'wait', {}],
  ]);
});

await test('a chat that moved after the record was asked for keeps what it knows', () => {
  const turns = { a: { mode: 'waiting', at: 9, text: 'queued…' } };
  assert.deepEqual(turnPlan(turns, [], () => true, 8), [], 'the send landed after the question');
  assert.deepEqual(turnPlan(turns, [], () => true, 9), [['a', 'end']]);
});

await test('a running turn outranks one queued behind it in the same chat', () => {
  const record = [{ target: 'a', state: 'waiting' }, { target: 'a', state: 'running', agents: ['claude'] }];
  assert.deepEqual(turnPlan({}, record, () => true, 0), [['a', 'start', { agents: ['claude'] }]]);
});

await test('only the chats in scope are touched', () => {
  const turns = { __library__: { mode: 'working', at: 1 }, __page__: { mode: 'working', at: 1 } };
  assert.deepEqual(turnPlan(turns, [], k => k !== '__library__', 5), [['__page__', 'end']]);
});

// ---- 2. the drawer -----------------------------------------------------------
const THR = 'thr-1';
const PAGE = {
  url: 'https://example.com/article', title: 'Article',
  page_chat: [{ ts: '2026-11-11T09:00:00.000Z', author: 'reader', text: 'what does it say?' }],
  threads: [{ id: THR, quote: 'a passage', msgs: [{ ts: '2026-11-11T09:00:01.000Z', author: 'reader', text: '@codex why?' }] }],
};
let interrupt = { ok: true };
let stops = 0;
const drawer = DR.create({ cssText: '.panel{}', onInterrupt: async () => { stops++; return interrupt; } });
drawer.setConn(true);
drawer.open('chat');
drawer.setPage(PAGE);
await tick(20);
const S = drawer.shadow;
const ev = e => drawer.onEvent(Object.assign({ type: 'chat', url: PAGE.url, target: '__page__' }, e));
const chatChip = () => S.querySelector('.pane[data-pane="chat"] .status-chip');
const chatStop = () => S.querySelector('.pane[data-pane="chat"] .status-chip .stop');
const foot = () => S.querySelector('.footbar');

await test('nothing is drawn while idle', () => {
  assert.equal(drawer.turnMode(), 'idle');
  assert.equal(chatChip(), null);
  assert.equal(drawer.isWaiting(), false);
});

await test('turn-start draws the chip and the stop button, in the chat and the footbar', () => {
  ev({ kind: 'turn-start', agents: ['claude'] });
  assert.equal(drawer.turnMode(), 'working');
  assert.ok(chatChip(), 'a chip');
  assert.ok(chatStop(), 'a stop button');
  assert.ok(foot().querySelector('.stop'), 'the footbar has one too');
  assert.equal(drawer.isWaiting(), true, 'content.js keeps checking while it works');
});

await test('a long silence takes nothing down: there is no silence timer at all', async () => {
  assert.equal(drawer.quietTurns, undefined, 'the old silence check is gone');
  assert.equal(drawer.endTurn, undefined);
  await tick(60);
  // …and what the poll during that silence brings back: the companion's own
  // record saying the turn is still running
  drawer.setTurns([{ target: '__page__', state: 'running', agents: ['claude'] }], drawer.turnAsk(), 'page');
  assert.equal(drawer.turnMode(), 'working');
  assert.ok(chatStop(), 'the stop button is still there');
});

await test('stop: "stopping…" in place of the button until the turn really ends', async () => {
  interrupt = { ok: true };
  chatStop().click();
  await tick(5);
  assert.equal(stops, 1);
  assert.equal(drawer.turnMode(), 'stopping');
  assert.ok(chatChip(), 'the chip stays');
  assert.equal(chatStop(), null, 'no second stop to press');
  assert.match(chatChip().textContent, /stopping…/);
  assert.match(foot().textContent, /stopping…/);
  ev({ kind: 'turn-end' });
  assert.equal(drawer.turnMode(), 'idle');
  assert.equal(chatChip(), null, 'gone with the turn');
  assert.equal(foot().querySelector('.stop'), null);
});

await test('a stop that does not go through puts the button back and says why', async () => {
  ev({ kind: 'turn-start', agents: ['claude'] });
  interrupt = { ok: false, error: 'owner only — this companion belongs to someone else' };
  chatStop().click();
  await tick(5);
  assert.equal(drawer.turnMode(), 'working');
  assert.ok(chatStop(), 'stop is back');
  assert.match(S.querySelector('.pane[data-pane="chat"]').textContent, /owner only/);
  ev({ kind: 'turn-end' });
});

await test('an error mid-turn keeps the chip; one with no turn running ends the wait', () => {
  ev({ kind: 'turn-start', agents: ['claude'] });
  ev({ kind: 'error', error: 'a file write was refused' });
  assert.equal(drawer.turnMode(), 'working', 'the turn goes on');
  ev({ kind: 'turn-end' });
  drawer.setTurns([{ target: '__page__', state: 'waiting' }], drawer.turnAsk(), 'page');
  assert.equal(drawer.turnMode(), 'waiting');
  ev({ kind: 'error', error: 'the bots hit an error' });
  assert.equal(drawer.turnMode(), 'idle', 'the reason replaces the wait');
});

await test('waiting: a spinner and the reason, then the chip once the turn starts', () => {
  drawer.setTurns([{ target: '__page__', state: 'waiting' }], drawer.turnAsk(), 'page');
  assert.match(chatChip().textContent, /waiting to start…/);
  assert.ok(chatChip().querySelector('.spin'));
  assert.equal(chatStop(), null, 'nothing to stop yet');
  ev({ kind: 'turn-start', agents: ['claude'] });
  assert.equal(drawer.turnMode(), 'working');
  assert.doesNotMatch(S.querySelector('.pane[data-pane="chat"]').textContent, /waiting to start/);
});

await test('losing the companion mid-turn is its own state, in plain words — not idle', () => {
  drawer.setConn(false);
  assert.equal(drawer.turnMode(), 'lost');
  assert.equal(chatChip().textContent, DR.TURN_LOST_TEXT);
  assert.equal(chatStop(), null, 'a stop could not reach anyone');
  assert.match(foot().textContent, /can’t reach the companion/);
  assert.equal(drawer.isWaiting(), true, 'content.js keeps looking');
});

await test('back in touch, the record says what became of it', () => {
  drawer.setConn(true);
  assert.equal(drawer.turnMode(), 'lost', 'reaching it again proves nothing about the turn');
  drawer.setTurns([{ target: '__page__', state: 'running', agents: ['claude'] }], drawer.turnAsk(), 'page');
  assert.equal(drawer.turnMode(), 'working', 'still running');
  drawer.setTurns([], drawer.turnAsk(), 'page');
  assert.equal(drawer.turnMode(), 'idle', 'finished while we were away');
  assert.equal(chatChip(), null);
});

await test('a page reloaded (or a second tab) mid-turn comes back working', async () => {
  const fresh = DR.create({ cssText: '.panel{}' });
  fresh.setConn(true);
  fresh.open('comments');
  fresh.setPage(PAGE);
  await tick(10);
  fresh.setTurns([{ target: THR, state: 'running', agents: ['codex'] }], fresh.turnAsk(), 'page');
  assert.equal(fresh.turnMode(THR), 'working');
  const card = fresh.shadow.querySelector(`.card[data-thread="${THR}"]`);
  assert.ok(card && card.classList.contains('working'), 'the card is marked working');
  assert.ok(card.querySelector('.status-chip .stop'), 'with its stop button');
  assert.ok(card.querySelector('.avatar-ring[data-agent="codex"]'), 'naming who is on it');
  assert.equal(fresh.turnMode('__page__'), 'idle', 'the page chat is not');
});

await test('an older companion with no record changes nothing', () => {
  ev({ kind: 'turn-start', agents: ['claude'] });
  assert.equal(drawer.setTurns(undefined, drawer.turnAsk(), 'page'), false);
  assert.equal(drawer.turnMode(), 'working');
  ev({ kind: 'turn-end' });
});

// ---- 3. the companion's record -------------------------------------------------
const SERVER = path.join(here, '..', 'server.mjs');
const MOCK = path.join(here, 'mock-bridge.mjs');
const H = createHarness({ server: SERVER, tag: 'turns', waitMs: 10000, env: { PLUGIN_BRIDGE_POOL: '1' } });
const root = H.tmp('root');
const srv = await H.startServer({ root, env: {
  PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
  MOCK_BRIDGE_LOG: path.join(root, 'mock.jsonl'), PLUGIN_SID_WAIT_MS: '400',
} });
const base = srv.base;
const es = listen(base);
const U = 'https://turns.test/one';
await POST(base, '/page', { url: U, title: 'Turns', site: 'turns.test' });
const turnsNow = async () => (await GET(base, `/page?url=${encodeURIComponent(U)}`)).json.turns;
const ends = () => es.of('chat').filter(e => e.url === U && e.kind === 'turn-end').length;

await test('GET /page says which chat is running, and who is on it', async () => {
  assert.deepEqual(await turnsNow(), []);
  await POST(base, '/reply', { url: U, thread_id: '__page__', text: '@claude [mock:sleep:2500] think slowly' });
  const running = await H.waitFor(async () => {
    const t = await turnsNow();
    return t.length && t[0].state === 'running' ? t : null;
  }, 'the turn to be running');
  assert.deepEqual(running, [{ target: '__page__', state: 'running', agents: ['claude'] }]);
});

await test('…a second message is listed as waiting behind it', async () => {
  await POST(base, '/reply', { url: U, thread_id: '__page__', text: '@claude and then this' });
  const t = await turnsNow();
  assert.deepEqual(t.map(x => [x.target, x.state]), [['__page__', 'running'], ['__page__', 'waiting']]);
});

await test('…and nothing is listed once both have really finished', async () => {
  await H.waitFor(() => ends() >= 2, 'both turns to end', 15000);
  assert.deepEqual(await turnsNow(), []);
});

await test('another page never sees this page’s turns', async () => {
  await POST(base, '/reply', { url: U, thread_id: '__page__', text: '@claude [mock:sleep:1500] again' });
  await H.waitFor(async () => (await turnsNow()).length, 'the turn to be listed');
  const other = (await GET(base, `/page?url=${encodeURIComponent('https://turns.test/two')}`)).json;
  assert.deepEqual(other, { ok: true, page: null, turns: [] });
  await H.waitFor(() => ends() >= 3, 'the turn to end', 15000);
});

es.close();
H.cleanup();
console.log(`\nturnmode: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
process.exit(0);
