// Named modes in the web council: each thing that has modes keeps them in one
// list, one field, and one setter that refuses an illegal move.
// In-process only: no listening server, no bot processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function council(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-modes-'));
  const saved = { ...process.env };
  const args = [...process.argv];
  Object.assign(process.env, {
    COUNCIL_NO_LISTEN: '1', BOTFERENCE_PROJECT_ROOT: root, COUNCIL_PASSWORD: 'modes-test',
  });
  process.argv.push('--hosted');
  t.after(() => {
    process.argv.splice(0, process.argv.length, ...args);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return import(`../frontends/council/server.mjs?modes=${encodeURIComponent(root)}`);
}

// ── 1. the bridge: "can be written to" and "closed" are read from its phase ──
test('a bridge ends in the closed phase; available and closed are read from the phase', async t => {
  const { Bridge, BRIDGE_PHASES, BRIDGE_MOVES } = await council(t);
  assert.ok(BRIDGE_PHASES.includes('closed'));
  // closed is reached from every other phase, and never left
  for (const from of BRIDGE_PHASES) {
    assert.equal(BRIDGE_MOVES.has(from + '>closed'), from !== 'closed', `${from} > closed`);
    for (const to of BRIDGE_PHASES) if (from === 'closed') assert.equal(BRIDGE_MOVES.has('closed>' + to), false);
  }
  const written = [];
  const b = new Bridge();
  assert.equal(b.available, false, 'not started: nothing to write to');
  assert.equal(b.send({ type: 'input', text: 'early' }), false);
  b.proc = { stdin: { write: l => written.push(JSON.parse(l)) }, kill() { } };
  assert.equal(b.available, true);
  assert.equal(b.closed, false);
  // there is no separate flag to set: the phase is the one field
  assert.throws(() => { b.available = false; }, TypeError);
  assert.throws(() => { b.closed = true; }, TypeError);
  b.handle({ type: 'ready' });
  assert.equal(b.send({ type: 'input', text: 'hi' }), true);
  assert.equal(b.phase, 'working');
  assert.equal(b.close(), true);
  assert.equal(b.phase, 'closed');
  assert.equal(b.available, false);
  assert.equal(b.closed, true);
  assert.equal(b.midTurn(), false, 'a closed bridge is not mid-turn');
  assert.equal(b.close(), false, 'closing twice is refused');
  for (const to of BRIDGE_PHASES) if (to !== 'closed') assert.equal(b.setPhase(to), false, `closed > ${to}`);
  // a closed process's late output is ignored, and nothing more is sent to it
  b.handle({ type: 'ready' });
  assert.equal(b.phase, 'closed');
  assert.equal(b.send({ type: 'input', text: 'late' }), false);
  assert.deepEqual(written.map(w => w.text), ['hi']);
});

test('a bridge whose process says exit, or whose stream is lost, is closed', async t => {
  const { Bridge } = await council(t);
  const wire = b => { b.proc = { stdin: { write() { } }, kill() { } }; return b; };
  const lost = wire(new Bridge());
  lost.handle({ type: 'ready' });
  lost.disconnect({ reason: 'bridge_stream_closed' });
  assert.equal(lost.phase, 'closed');
  assert.equal(lost.available, false);
  // a saved chat still opening can be lost too
  const opening = wire(new Bridge('saved'));
  assert.equal(opening.phase, 'opening');
  opening.disconnect({ code: 1 });
  assert.equal(opening.phase, 'closed');
});

// ── the page (happy-dom) ──
const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let HAPPY = true;
try { await import('happy-dom'); } catch { HAPPY = false; }
const needsDom = { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' };

async function page(t) {
  const { GlobalWindow } = await import('happy-dom');
  const vm = await import('node:vm');
  const w = new GlobalWindow({ url: 'http://localhost/', width: 1280, height: 900 });
  t.after(() => w.happyDOM.close());
  const doc = w.document;
  const html = fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'index.html'), 'utf8');
  doc.write(html.replace(/<script[^>]*src=[^>]*><\/script>/g, ''));
  const posts = [];
  w.fetch = async (url, opts) => {
    posts.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  w.EventSource = class { constructor() { } close() { } };
  const wsUrls = [];
  w.WebSocket = class { constructor(url) { wsUrls.push(url); } close() { } send() { } };
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'app.js'), 'utf8'), w);
  return { w, doc, C: w.__council, posts, wsUrls };
}

// ── 2. what the tab's stream waits on: one mode, not pendingSwitch + resuming ──
test('attach modes: the pure move rule refuses illegal moves, and a move into a switch must name its chat', needsDom, async t => {
  const { C } = await page(t);
  assert.deepEqual([...C.ATTACH_MODES], ['open', 'switching', 'resuming', 'switching_resuming']);
  assert.equal('pendingSwitch' in C.state, false, 'the old switch flag is gone');
  assert.equal('resuming' in C.state, false, 'the old resuming flag is gone');
  assert.equal(C.attachMove('open', 'switching', 'sidB'), true);
  assert.equal(C.attachMove('open', 'switching', null), false, 'a switch names the chat it goes to');
  assert.equal(C.attachMove('open', 'switching_resuming', 'sidB'), false, 'resuming is the server\'s word, never assumed');
  assert.equal(C.attachMove('resuming', 'switching_resuming', 'sidB'), false);
  assert.equal(C.attachMove('switching', 'switching_resuming', null), true, 'keeps the chat it has');
  assert.equal(C.attachMove('switching_resuming', 'resuming', null), true);
  assert.equal(C.attachMove('open', 'bogus', null), false);
  assert.equal(C.attachMove('bogus', 'open', null), false);
  // the setter keeps the target exactly in the switching modes
  assert.equal(C.state.attachMode, 'open');
  assert.equal(C.setAttachMode('switching'), false);
  assert.equal(C.state.attachMode, 'open');
  assert.equal(C.switchTarget(), null);
  assert.equal(C.setAttachMode('resuming'), true);
  assert.equal(C.switchTarget(), null);
  assert.equal(C.setAttachMode('switching', 'sidX'), true);
  assert.equal(C.switchTarget(), 'sidX');
  assert.equal(C.setAttachMode('switching_resuming'), true);
  assert.equal(C.switchTarget(), 'sidX', 'the target survives the server\'s word');
  assert.equal(C.setAttachMode('resuming'), true);
  assert.equal(C.switchTarget(), null, 'leaving the switch drops the target');
  assert.equal(C.setAttachMode('open'), true);
});

test('attach modes through a real switch: picked, the process still opening, then settled', needsDom, async t => {
  const { C, wsUrls } = await page(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  assert.equal(C.state.attachMode, 'open');
  C.handle({ type: 'replay_done' });
  C.switchTo('sidB');
  assert.equal(C.state.attachMode, 'switching');
  assert.equal(C.switchTarget(), 'sidB');
  assert.match(wsUrls[wsUrls.length - 1], /\?chat=sidB$/);
  C.handle({ type: 'hello', bridge_id: 'b2', resuming: true });
  assert.equal(C.state.attachMode, 'switching_resuming');
  C.handle({ type: 'replay_done' });
  assert.equal(C.state.attachMode, 'switching_resuming', 'the opening chat still waits for its live ready');
  C.handle({ type: 'clear_panes' });
  C.handle({ type: 'ready' });
  assert.equal(C.state.attachMode, 'open', 'the live ready settles it');
  assert.equal(C.switchTarget(), null);
  // a reload onto a process still opening: resuming without a switch
  C.handle({ type: 'hello', bridge_id: 'b2', resuming: true });
  assert.equal(C.state.attachMode, 'resuming');
  C.handle({ type: 'hello', bridge_id: 'b2', resuming: false });
  assert.equal(C.state.attachMode, 'open');
  // a refused chat lets everything go
  C.switchTo('nope');
  C.handle({ type: 'hello', bridge_id: 'b2', resuming: true });
  C.handle({ type: 'route_error', error: 'chat not found' });
  assert.equal(C.state.attachMode, 'open');
  assert.equal(C.switchTarget(), null);
});

// ── 3. the room's turn and the pre-send guard: two named modes, not two flags ──
test('room turn: one of ROOM_TURNS, moved only by setRoomTurn; the stop button follows it', needsDom, async t => {
  const { C, doc } = await page(t);
  assert.deepEqual([...C.ROOM_TURNS], ['idle', 'working']);
  assert.equal('busy' in C.state, false, 'the old busy flag is gone');
  assert.equal(C.state.roomTurn, 'idle');
  const stop = doc.getElementById('stop');
  assert.equal(C.setRoomTurn('bogus'), false);
  assert.equal(C.state.roomTurn, 'idle');
  C.handle({ type: 'user_echo', text: 'hi' });
  assert.equal(C.state.roomTurn, 'working');
  assert.equal(stop.hidden, false);
  assert.equal(C.setRoomTurn('working'), false, 'saying it again is no move');
  C.handle({ type: 'stream', model: 'claude', kind: 'start', stream_id: 's1' });
  assert.equal(C.state.agentMode.claude, 'working');
  C.handle({ type: 'ready' });
  assert.equal(C.state.roomTurn, 'idle');
  assert.equal(stop.hidden, true);
  assert.equal(C.state.agentMode.claude, 'idle', 'the room going idle settles every bot');
});

test('pre-send guard: send anyway lets ONE message through, then guards again; editing guards too', needsDom, async t => {
  const { C, posts } = await page(t);
  assert.deepEqual([...C.PRESEND_MODES], ['guarded', 'send_anyway']);
  assert.equal('sendOverride' in C.state, false, 'the old override flag is gone');
  assert.equal(C.setPresend('guarded'), false, 'already guarded: no move');
  assert.equal(C.setPresend('bogus'), false);
  C.state.exhausted.claude = 'out of credits';
  C.state.exhausted.codex = 'out of credits';
  const inputs = () => posts.filter(p => p.url === '/input');
  C.els.input.value = 'anyone there?';
  C.submit();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(inputs().length, 0, 'held: every bot it would reach is out of credits');
  assert.equal(C.els.presendWarn.hidden, false);
  // "send anyway" then an edit: the edit takes the permission back
  assert.equal(C.state.presend, 'guarded');
  assert.equal(C.setPresend('send_anyway'), true);
  C.els.input.dispatchEvent(new C.els.input.ownerDocument.defaultView.Event('input'));
  assert.equal(C.state.presend, 'guarded');
  // the button: one message through, and guarded again after it
  C.els.presendWarn.querySelector('.pw-send').click();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(inputs().length, 1);
  assert.equal(inputs()[0].body.text, 'anyone there?');
  assert.equal(C.state.presend, 'guarded');
  C.els.input.value = 'and again?';
  C.submit();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(inputs().length, 1, 'the next message is held again');
});
