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
