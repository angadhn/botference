#!/usr/bin/env node
// THE BRIDGE CHILD'S LIFECYCLE (chat.mjs createChat), against the mock bridge.
//
// What this pins down: a child that goes away — because it died, or because
// we stopped it (an idle bridge after a key change, a reaped pool member) —
// leaves nothing of itself behind. The next child starts from 'starting',
// waits for its own startup `ready`, and does the whole setup again: the
// project bootstrap and the /resume of the page's chat. And the OLD child's
// late `exit` cannot reach in and tear the new one down.
//
//   node frontends/plugin/test/lifecycle.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-lifecycle-'));
const logs = path.join(root, 'mock-logs');
process.env.BOTFERENCE_PROJECT_ROOT = root;
process.env.MOCK_LOG_DIR = logs;
process.env.PLUGIN_BRIDGE_CMD = JSON.stringify([process.execPath, path.join(TEST, 'mock-bridge.mjs')]);
const { createChat } = await import('../chat.mjs');
const store = await import('../store.mjs');

let pass = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error(`timed out waiting for ${what}`);
}
// one log per child (named by pid): every input each child was sent, in order
const perChild = () => (fs.existsSync(logs) ? fs.readdirSync(logs) : [])
  .map(f => ({ f, at: fs.statSync(path.join(logs, f)).birthtimeMs }))
  .sort((a, b) => a.at - b.at)
  .map(({ f }) => fs.readFileSync(path.join(logs, f), 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(e => e.type === 'input').map(e => String(e.text)));

const events = [];
const chat = createChat({ onEvent: ev => events.push(ev) });
const URL1 = 'https://life.test/one';
store.upsertPage({ url: URL1, title: 'Lifecycle one', site: 'life.test' });
const turn = text => chat.submit({ url: URL1, target: '__page__', text, title: 'Lifecycle one' });
const turnEnds = () => events.filter(e => e.type === 'chat' && e.kind === 'turn-end' && e.url === URL1).length;

await test('a fresh chat is stopped, and says so in both vocabularies', () => {
  assert.equal(chat.lifecycle(), 'stopped');
  assert.equal(chat.state(), 'stopped');
});

await test('the first turn boots the child, bootstraps the project, and ends idle', async () => {
  turn('@claude first');
  assert.equal(chat.lifecycle(), 'starting', 'spawned but not booted yet');
  assert.equal(chat.state(), 'running', 'state() keeps its old meaning: a child exists');
  await waitFor(() => turnEnds() === 1, 'the first turn to end');
  assert.equal(chat.lifecycle(), 'idle');
  const [first] = perChild();
  assert.deepEqual(first.slice(0, 3), ['/project create Plugin pages', '/project open plugin-pages', '/new']);
  assert.ok(store.readPage(URL1).session_id, 'the page learned its session');
});

await test('after stop(), the next turn waits for the NEW child to boot and sets it up again', async () => {
  chat.stop();
  assert.equal(chat.lifecycle(), 'stopped');
  assert.equal(chat.project(), '', 'nothing remembered about the old child');
  turn('@claude second');
  assert.equal(chat.lifecycle(), 'starting', 'a stopped child is never mistaken for a ready one');
  await waitFor(() => turnEnds() === 2, 'the second turn to end');
  const kids = perChild();
  assert.equal(kids.length, 2, 'a second child was spawned');
  const sid = store.readPage(URL1).session_id;
  assert.deepEqual(kids[1].slice(0, 3),
    ['/project create Plugin pages', '/project open plugin-pages', `/resume ${sid}`],
    'bootstrap and /resume both go to the new child before the turn itself');
  assert.match(kids[1][kids[1].length - 1], /second/);
});

await test("the old child's late exit cannot tear down the child that replaced it", async () => {
  const before = events.filter(e => e.type === 'bridge' && e.state === 'exited').length;
  chat.stop();
  turn('@claude third');           // respawned before the old child's exit lands
  await waitFor(() => turnEnds() === 3, 'the third turn to end');
  const errs = events.filter(e => e.type === 'chat' && e.kind === 'error' && e.url === URL1);
  assert.equal(errs.length, 0, 'the turn was not stranded by the old exit');
  assert.equal(events.filter(e => e.type === 'bridge' && e.state === 'exited').length, before,
    'no exited event for a child we stopped ourselves');
  assert.equal(chat.lifecycle(), 'idle');
});

await test('a stop with a turn still waiting tells that turn, instead of replaying it later', async () => {
  const n = turnEnds();
  turn('@claude fourth [mock:sleep:400]');
  turn('@claude fifth');
  await waitFor(() => chat.lifecycle() === 'busy', 'the fourth turn to be in flight');
  chat.stop();
  assert.equal(chat.queueLength(), 0);
  assert.equal(turnEnds(), n + 2, 'both turns ended');
  const errs = events.filter(e => e.type === 'chat' && e.kind === 'error' && e.url === URL1);
  assert.deepEqual(errs.map(e => e.error), ['bridge stopped', 'bridge stopped']);
});

// A QUESTION-VAULT CARD JOB (questions.mjs) is silent by construction: its
// answer leaves as a `card` event. A turn that ends with no reply at all must
// still settle the card — as failed — or the row stays 'pending' for ever.
await test('a card turn that ends with no reply is reported as a failed card, once', async () => {
  const cards = () => events.filter(e => e.type === 'card' && e.card_id === 'q-silent');
  // (a card job builds its own prompt from the quote — chat.mjs cardPrompt —
  // so the mock's directive rides there, not in `text`)
  chat.submit({ url: URL1, target: '__page__', text: '@claude ', quote: 'a passage [mock:silent]',
    card: true, card_id: 'q-silent', title: 'Lifecycle one' });
  await waitFor(() => cards().length, 'the card to be settled');
  await waitFor(() => chat.lifecycle() === 'idle', 'the turn to finish');
  assert.equal(cards().length, 1, 'one answer, not two');
  assert.equal(cards()[0].error, 'the turn ended without a reply', JSON.stringify(cards()[0]));
});

await test('a card turn that DOES reply is settled by its reply and nothing else', async () => {
  const cards = () => events.filter(e => e.type === 'card' && e.card_id === 'q-said');
  chat.submit({ url: URL1, target: '__page__', text: '@claude ', quote: 'a passage',
    card: true, card_id: 'q-said', title: 'Lifecycle one' });
  await waitFor(() => chat.lifecycle() === 'idle' && cards().length, 'the card turn to finish');
  await sleep(50);
  assert.equal(cards().length, 1);
  assert.ok(cards()[0].msg, 'it carries the reply');
  assert.equal(cards()[0].error, undefined);
});

// EVERY TURN HAS AN ID, and a waiting turn dropped by "+ new chat" ends under
// its own kind. A turn-end is what closes the RUNNING turn's watch on the page
// (server.mjs setCensus); a dropped turn that said turn-end used to close it.
await test('a dropped waiting turn says turn-dropped with its own id; the running turn keeps its own', async () => {
  const from = events.length;
  turn('@claude running one [mock:sleep:300]');
  turn('@claude waiting one');
  await waitFor(() => chat.lifecycle() === 'busy', 'the first turn in flight');
  assert.equal(chat.dropQueued(URL1), 1);
  await waitFor(() => chat.lifecycle() === 'idle', 'the running turn to finish');
  const mine = events.slice(from).filter(e => e.type === 'chat' && e.url === URL1);
  const start = mine.find(e => e.kind === 'turn-start');
  const ends = mine.filter(e => e.kind === 'turn-end');
  const dropped = mine.filter(e => e.kind === 'turn-dropped');
  assert.ok(start && start.turn_id, 'turn-start carries an id');
  assert.equal(ends.length, 1, 'one turn-end: the running turn\'s');
  assert.equal(ends[0].turn_id, start.turn_id, 'and it is that turn\'s id');
  assert.equal(dropped.length, 1, 'the waiting turn is reported as dropped');
  assert.ok(dropped[0].turn_id && dropped[0].turn_id !== start.turn_id, 'under an id of its own');
});

// A HANDLER THAT THROWS (saving a bot reply, say) is logged with the chat and
// the event kind, the reader is told in that chat, and the bot process lives.
await test('a reply that cannot be saved is logged and said in the chat; the bot process carries on', async () => {
  const seen = [];
  const said = [];
  const realError = console.error;
  console.error = (...a) => { said.push(a.join(' ')); };
  const c2 = createChat({ onEvent: ev => {
    seen.push(ev);
    if (ev.type === 'chat' && ev.kind === 'reply' && ev.msg && ev.msg.author === 'claude') throw new Error('disk full');
  } });
  try {
    c2.submit({ url: URL1, target: '__page__', text: '@claude hello', title: 'Lifecycle one' });
    await waitFor(() => seen.some(e => e.kind === 'turn-end'), 'the turn to end');
    const err = seen.find(e => e.type === 'chat' && e.kind === 'error');
    assert.ok(err, 'an error reached the chat');
    assert.equal(err.url, URL1);
    assert.equal(err.target, '__page__');
    assert.match(err.error, /reply arrived but could not be saved/);
    assert.ok(said.some(l => /chat\/reply/.test(l) && l.includes(URL1) && /disk full/.test(l)), said.join('\n'));
    assert.equal(c2.lifecycle(), 'idle', 'the child is still up');
    const n = seen.filter(e => e.kind === 'turn-end').length;
    c2.submit({ url: URL1, target: '__page__', text: '@codex again', title: 'Lifecycle one' });
    await waitFor(() => seen.filter(e => e.kind === 'turn-end').length === n + 1, 'a second turn on the same child');
  } finally { console.error = realError; c2.stop(); }
});

await test('the pool does not swallow a handler\'s throw before chat.mjs can report it', async () => {
  const { createPool } = await import('../pool.mjs');
  let childOnEvent = null;
  const fake = { queueLength: () => 0, lifecycle: () => 'stopped', state: () => 'stopped', stop() {} };
  const pool = createPool({ onEvent: () => { throw new Error('boom'); }, make: o => { childOnEvent = o.onEvent; return fake; } });
  assert.throws(() => childOnEvent({ type: 'chat', kind: 'reply', url: URL1 }), /boom/);
  pool.stop && pool.stop();
});

// A TURN THAT CANNOT BE PLANNED is not lost in silence, and does not block the
// lane: it leaves the queue with a plain error and the next turn goes ahead.
await test('a turn whose plan throws is reported and dropped, and the next one runs', async () => {
  const seen = [];
  const said = [];
  const realError = console.error;
  console.error = (...a) => { said.push(a.join(' ')); };
  const BAD = 'https://life.test/bad';
  const c3 = createChat({ onEvent: ev => seen.push(ev),
    projectOf: u => { if (u === BAD) throw new Error('cannot read the project'); return null; } });
  try {
    c3.submit({ url: BAD, target: '__page__', text: '@claude this one', title: 'Bad' });
    c3.submit({ url: URL1, target: '__page__', text: '@claude next one', title: 'Lifecycle one' });
    await waitFor(() => seen.some(e => e.kind === 'turn-end' && e.url === URL1), 'the next turn to run');
    const bad = seen.filter(e => e.url === BAD);
    assert.ok(bad.some(e => e.kind === 'error' && /could not be sent to the bots/.test(e.error)), JSON.stringify(bad));
    assert.ok(bad.some(e => e.kind === 'turn-dropped'), 'ended as a turn that never started');
    assert.ok(!bad.some(e => e.kind === 'turn-start'));
    assert.ok(said.some(l => /cannot read the project/.test(l)), 'and logged');
  } finally { console.error = realError; c3.stop(); }
});

// A STEP THAT THROWS AFTER A `ready` (here: recording a renamed chat's title,
// with the record folder made read-only) used to be an unhandled rejection —
// enough to stop the whole companion. Now the turn ends, the reader is told,
// and the child stays up for the next turn.
await test('a step that throws after ready ends that turn with an error, and the child carries on', async () => {
  const seen = [];
  const realError = console.error;
  const said = [];
  console.error = (...a) => { said.push(a.join(' ')); };
  const rejected = [];
  const onRej = e => rejected.push(e);
  process.on('unhandledRejection', onRej);
  const c4 = createChat({ onEvent: ev => seen.push(ev) });
  const URL2 = 'https://life.test/two';
  store.upsertPage({ url: URL2, title: 'Two', site: 'life.test' });
  const dir = path.dirname(store.pageFile(URL2));
  try {
    c4.submit({ url: URL2, target: '__page__', text: '@claude first', title: 'Two' });
    await waitFor(() => seen.some(e => e.kind === 'turn-end' && e.url === URL2), 'the first turn');
    const page = store.readPage(URL2);
    assert.ok(page.session_id, 'the page has a chat to rename');
    page.title = 'Two, renamed';
    store.savePage(page);
    fs.chmodSync(dir, 0o555);
    c4.submit({ url: URL2, target: '__page__', text: '@claude second', title: 'Two, renamed' });
    await waitFor(() => seen.filter(e => e.kind === 'turn-end' && e.url === URL2).length === 2, 'the second turn to end');
    fs.chmodSync(dir, 0o755);
    assert.ok(seen.some(e => e.kind === 'error' && e.url === URL2 && /stopped because of a problem/.test(e.error)),
      JSON.stringify(seen.filter(e => e.kind === 'error')));
    assert.equal(rejected.length, 0, 'no unhandled rejection');
    assert.equal(c4.lifecycle(), 'idle', 'the child is still up');
  } finally {
    try { fs.chmodSync(dir, 0o755); } catch { }
    process.off('unhandledRejection', onRej);
    console.error = realError;
    c4.stop();
  }
});

// A CHILD THAT STOPS READING its input (it is dying, or wedged) makes the next
// write fail with EPIPE, as an `error` event on its stdin. With no listener
// that event is thrown out of the event loop and takes the companion with it.
await test('a write to a child that stopped reading is logged, not thrown', async () => {
  const realCmd = process.env.PLUGIN_BRIDGE_CMD;
  const realError = console.error;
  const said = [];
  console.error = (...a) => { said.push(a.join(' ')); };
  const thrown = [];
  const onExc = e => thrown.push(e);
  process.on('uncaughtException', onExc);
  // closes its input at once, says it is ready, and lingers
  process.env.PLUGIN_BRIDGE_CMD = JSON.stringify([process.execPath, '-e',
    "require('fs').closeSync(0); process.stdout.write(JSON.stringify({type:'ready'})+'\\n'); setTimeout(()=>{}, 1500)"]);
  const c5 = createChat({ onEvent: () => {} });
  try {
    c5.submit({ url: URL1, target: '__page__', text: '@claude anyone there?', title: 'Lifecycle one' });
    await waitFor(() => said.some(l => /stopped reading|could not write/.test(l)), 'the failed write to be logged', 4000);
    await sleep(50);
    assert.equal(thrown.length, 0, thrown.map(e => e.message).join('; '));
  } finally {
    process.env.PLUGIN_BRIDGE_CMD = realCmd;
    process.off('uncaughtException', onExc);
    console.error = realError;
    c5.stop();
  }
});

chat.stop();
await sleep(100);
fs.rmSync(root, { recursive: true, force: true });
console.log(`\nlifecycle: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
