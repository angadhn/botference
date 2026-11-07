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

chat.stop();
await sleep(100);
fs.rmSync(root, { recursive: true, force: true });
console.log(`\nlifecycle: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
