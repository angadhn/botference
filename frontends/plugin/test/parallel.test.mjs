#!/usr/bin/env node
// PARALLEL TURNS — the dispatcher, and what it must never let happen.
//
// Two halves:
//   1. pool.mjs against a fake bridge, driven turn by turn. Every dispatch
//      rule is asserted directly, with no timing in it at all.
//   2. a real companion with several mock bridge children under it: two pages
//      overlapping, one page serial, a project's pages serial, a send-review
//      round staying ordered and counting straight while an unrelated page's
//      turn runs beside it, and a child dying without taking the others down.
//
//   node frontends/plugin/test/parallel.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

// --- tiny runner ---------------------------------------------------------
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// ==========================================================================
// PART ONE — the dispatcher, on a fake bridge
// ==========================================================================
// The fake speaks exactly the surface pool.mjs consumes and nothing else, and
// every turn boundary is a method call rather than a timer: a concurrency test
// that has to sleep is a concurrency test that will lie to somebody eventually.
const { createPool, DEFAULT_POOL } = await import(path.join(PLUGIN, 'pool.mjs'));

function fakeFactory() {
  const made = [];
  const make = ({ onEvent }) => {
    const queue = [];
    let current = null;
    let up = false;        // a child process exists
    let booted = false;    // its startup `ready` has landed
    let ready = false;     // it is between turns
    let stopped = 0;
    const emit = ev => onEvent(ev);
    function pump() {
      if (current || !queue.length || !up || !ready) return;
      current = queue.shift();
      ready = false;
      emit({ type: 'chat', url: current.url, kind: 'turn-start', agents: ['claude'] });
    }
    const api = {
      submit(job) {
        // chat.mjs samples this BEFORE it starts the child, and the wording the
        // reader sees turns on it
        const cold = !up || !booted;
        queue.push(job);
        if (!up) { up = true; emit({ type: 'bridge', state: 'starting' }); }
        pump();
        const started = current === job;
        return { queued: true, position: queue.length + (current ? 1 : 0),
          wait: started ? null : (cold ? 'bridge_starting' : 'busy') };
      },
      control(text) { queue.push({ control: text, url: null }); if (!up) up = true; pump(); },
      models: () => ({ current: null, options: null, status: null, effort: null }),
      interrupt: u => !!(current && current.url === u),
      state: () => (up ? 'running' : 'stopped'),
      queueLength: () => queue.length + (current ? 1 : 0),
      busyFor: u => !!u && ((current && current.url === u) || queue.some(j => j.url === u)),
      jobs: () => [
        ...(current ? [{ url: current.url, control: !!current.control, running: true }] : []),
        ...queue.map(j => ({ url: j.url, control: !!j.control, running: false })),
      ],
      root: () => '', writeRoot: () => '',
      stop() { stopped++; up = false; booted = false; ready = false; current = null; queue.length = 0; },
      // --- fixture controls, not part of the surface ---
      boot() { booted = true; ready = true; emit({ type: 'bridge', state: 'running' }); pump(); },
      finish() {
        if (!current) return;
        const job = current; current = null; ready = true;
        emit({ type: 'chat', url: job.url, kind: 'turn-end', agents: ['claude'] });
        pump();
      },
      die() {
        const stranded = current ? [current, ...queue] : [...queue];
        current = null; queue.length = 0; up = false; booted = false; ready = false;
        emit({ type: 'bridge', state: 'exited', error: 'boom' });
        for (const j of stranded) emit({ type: 'chat', url: j.url, kind: 'turn-end', agents: ['claude'] });
      },
      running: () => (current ? current.url : null),
      stops: () => stopped,
    };
    made.push(api);
    return api;
  };
  return { make, made };
}

// a pool with the clock in the test's hand
function poolOn(opts = {}) {
  const f = fakeFactory();
  const events = [];
  let clock = 0;
  const pool = createPool({
    onEvent: ev => events.push(ev),
    make: f.make,
    now: () => clock,
    ...opts,
  });
  return { pool, made: f.made, events, tick: ms => { clock += ms; }, at: () => clock };
}

const A = 'https://a.test/one';
const B = 'https://b.test/two';
const C = 'https://c.test/three';
const D = 'https://d.test/four';
const turn = url => ({ url, target: '__page__', text: '@claude hi' });

console.log('\nparallel — the dispatcher');

await test('the primary child exists before anything is asked of it, and is the only one', () => {
  const { pool, made } = poolOn({ max: 3 });
  assert.equal(made.length, 1, 'one chat object, lazily backed by no process');
  assert.equal(pool.size(), 1);
  assert.equal(pool.cap(), 3);
  assert.equal(pool.state(), 'stopped', 'no child has started');
});

await test('a second page gets a second child; a third gets a third', () => {
  const { pool, made } = poolOn({ max: 3 });
  pool.submit(turn(A)); made[0].boot();
  pool.submit(turn(B)); made[1].boot();
  pool.submit(turn(C)); made[2].boot();
  assert.equal(pool.size(), 3);
  assert.deepEqual([made[0].running(), made[1].running(), made[2].running()], [A, B, C],
    'three turns in flight at once, one per page');
});

await test('two turns on ONE page are strictly serial, on one child', () => {
  const { pool, made } = poolOn({ max: 3 });
  pool.submit(turn(A)); made[0].boot();
  const second = pool.submit(turn(A));
  assert.equal(pool.size(), 1, 'the same lane never opens a second child');
  assert.equal(second.wait, 'busy', "the reader's own conversation still has the floor");
  assert.equal(made[0].running(), A);
  made[0].finish();
  assert.equal(made[0].running(), A, 'the second turn follows the first, in order');
});

await test('a bound lane never moves, even when a child sits idle beside it', () => {
  // Two children, three pages: C has to share, and it shares with the primary.
  const { pool, made } = poolOn({ max: 2 });
  pool.submit(turn(A)); made[0].boot(); made[0].finish();
  pool.submit(turn(B)); made[1].boot(); made[1].finish();
  pool.submit(turn(C)); made[0].finish();
  assert.equal(pool.size(), 2, 'the cap holds');
  assert.equal(pool.laneMap().get('pg:' + C), 0, 'C shares the primary with A');

  // Now A takes the floor and C wants to speak. Child 1 is IDLE — there is
  // capacity right there — and the dispatcher must refuse to use it: moving C
  // would put two children on one session id, and the session file is rewritten
  // whole with no lock. C waits instead.
  pool.submit(turn(A));
  assert.equal(made[0].running(), A);
  const held = pool.submit(turn(C));
  assert.equal(pool.laneMap().get('pg:' + C), 0, 'no migration');
  assert.equal(made[1].running(), null, 'the idle child was not handed the lane');
  assert.equal(held.wait, 'pool_busy', 'and the reader is told it is somebody else in the way');
});

await test('at the cap, a new lane joins the least encumbered child', () => {
  const { pool, made } = poolOn({ max: 2 });
  pool.submit(turn(A)); made[0].boot();
  pool.submit(turn(B)); made[1].boot();
  assert.equal(pool.size(), 2);
  pool.submit(turn(A));                 // primary now holds 1 lane, 2 turns
  const late = pool.submit(turn(C));    // C is new and the pool is full
  assert.equal(pool.size(), 2, 'the cap holds');
  assert.equal(pool.laneMap().get('pg:' + C), 1, 'the child with the shorter queue');
  assert.equal(late.wait, 'pool_busy', 'nothing of the reader’s is in the way — the building is');
});

await test('bridge_pool 1 is yesterday: one child, one queue, every page waiting', () => {
  const { pool, made } = poolOn({ max: 1 });
  const first = pool.submit(turn(A)); made[0].boot();
  const second = pool.submit(turn(B));
  assert.equal(pool.size(), 1);
  assert.equal(first.wait, 'bridge_starting');
  assert.equal(second.wait, 'pool_busy', 'another page has the floor — and now we can say so');
  assert.equal(made[0].running(), A);
});

await test('waking a cold child still reads as waking, not as a queue', () => {
  const { pool } = poolOn({ max: 3 });
  assert.equal(pool.submit(turn(A)).wait, 'bridge_starting');
});

await test('a dead child strands only its own lanes, and the others keep working', () => {
  const { pool, made, events } = poolOn({ max: 3 });
  pool.submit(turn(A)); made[0].boot();
  pool.submit(turn(B)); made[1].boot();
  const before = events.length;
  made[0].die();
  // B is untouched
  assert.equal(made[1].running(), B, "the other child never noticed");
  const ends = events.slice(before).filter(e => e.kind === 'turn-end').map(e => e.url);
  assert.deepEqual(ends, [A], 'only the dead child’s turn was stranded');
  // …and A is free to bind again. chat.mjs leaves a dead child restartable
  // (the next submit respawns it), so the corpse is a candidate like any other
  // — what matters is that the binding was RELEASED and re-decided rather than
  // pointing at a process that can no longer answer.
  pool.submit(turn(A));
  assert.equal(pool.laneMap().has('pg:' + A), true);
  assert.equal(pool.size(), 2, 'a restartable child is capacity, not a corpse');
});

await test('an idle child beyond the first is reaped, and gives its lanes back', () => {
  const { pool, made, tick } = poolOn({ max: 3, idleMs: 1000 });
  pool.submit(turn(A)); made[0].boot(); made[0].finish();
  pool.submit(turn(B)); made[1].boot(); made[1].finish();
  assert.equal(pool.size(), 2);
  tick(2000);
  pool.reapNow();
  assert.equal(pool.size(), 1, 'the extra child is gone');
  assert.equal(made[1].stops(), 1, 'and it was actually stopped');
  assert.equal(pool.laneMap().has('pg:' + B), false, 'its lane is free to bind again');
  assert.equal(made[0].stops(), 0, 'the primary is never reaped');
});

await test('a busy child is never reaped however long the pool has been up', () => {
  const { pool, made, tick } = poolOn({ max: 3, idleMs: 1000 });
  pool.submit(turn(A)); made[0].boot();
  pool.submit(turn(B)); made[1].boot();     // in flight, not finished
  tick(60000);
  pool.reapNow();
  assert.equal(pool.size(), 2);
  assert.equal(made[1].running(), B);
});

await test('idleMs 0 never reaps anything', () => {
  const { pool, made, tick } = poolOn({ max: 3, idleMs: 0 });
  pool.submit(turn(A)); made[0].boot(); made[0].finish();
  pool.submit(turn(B)); made[1].boot(); made[1].finish();
  tick(999999);
  pool.reapNow();
  assert.equal(pool.size(), 2);
});

await test('controlFor reaches the child holding that page, and nobody else', () => {
  const { pool, made } = poolOn({ max: 3 });
  pool.submit(turn(A)); made[0].boot(); made[0].finish();
  pool.submit(turn(B)); made[1].boot(); made[1].finish();
  assert.equal(pool.controlFor(B, '/delete sess-9'), true);
  assert.deepEqual(made[1].jobs().map(j => j.control), [true]);
  assert.deepEqual(made[0].jobs(), [], 'the other child was told nothing');
  assert.equal(pool.controlFor(D, '/delete sess-9'), false,
    'no child holds that page — its session file is nobody’s to protect');
});

await test('a process-wide setting reaches every child that exists', () => {
  const { pool, made } = poolOn({ max: 3 });
  pool.submit(turn(A)); made[0].boot();
  pool.submit(turn(B)); made[1].boot();
  pool.control('/model @claude claude-opus-5');
  for (const m of made) assert.ok(m.jobs().some(j => j.control), 'every child got it');
});

await test('the aggregates answer for the whole pool', () => {
  const { pool, made } = poolOn({ max: 3 });
  pool.submit(turn(A)); made[0].boot();
  pool.submit(turn(B)); made[1].boot();
  pool.submit(turn(B));
  assert.equal(pool.queueLength(), 3);
  assert.equal(pool.busyFor(B), true);
  assert.equal(pool.busyFor(D), false);
  assert.equal(pool.state(), 'running');
  assert.equal(pool.interrupt(B), true, 'the interrupt finds the right child');
  assert.equal(pool.interrupt(D), false);
  const urls = pool.jobs().filter(j => j.running).map(j => j.url).sort();
  assert.deepEqual(urls, [A, B].sort());
});

await test('the default cap is three', () => {
  assert.equal(DEFAULT_POOL, 3);
  const { pool } = poolOn({});
  assert.equal(pool.cap(), 3);
});

await test('a nonsense cap is clamped rather than obeyed', () => {
  assert.equal(poolOn({ max: 0 }).pool.cap(), 1);
  assert.equal(poolOn({ max: 999 }).pool.cap(), 8);
  assert.equal(poolOn({ max: 'two' }).pool.cap(), 1);
});

// ==========================================================================
// PART TWO — a real companion, several children
// ==========================================================================
const spawned = [];
const tmps = [];
function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-par-${tag}-`));
  tmps.push(d);
  return fs.realpathSync(d);
}
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-par-secrets-'));

function startServer({ root, logDir, pool = '3', env = {} }) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: root,
      BOTFERENCE_SECRETS_DIR: SECRETS, PLUGIN_OWNER_PASSWORD: '', REVIEW_HUB_PASSWORD: '',
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      PLUGIN_BRIDGE_POOL: pool,
      PLUGIN_BRIDGE_IDLE_MS: '0',
      MOCK_LOG_DIR: logDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(proc);
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  return waitFor(() => {
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    return m ? `http://127.0.0.1:${m[1]}` : null;
  }, `server to listen (got: ${out.slice(0, 300)})`).then(base => ({ proc, base, out: () => out }));
}

function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + urlPath, {
      method,
      headers: data === null ? {}
        : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { }
        resolve({ status: res.statusCode, json, body: buf });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const GET = (b, p) => request(b, 'GET', p, undefined);
const POST = (b, p, body) => request(b, 'POST', p, body || {});
const enc = encodeURIComponent;

// every event, stamped with when it arrived — overlap is a claim about order
function openEvents(base) {
  const events = [];
  const req = http.get(base + '/events', res => {
    let buf = '';
    res.on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        try { events.push({ ...JSON.parse(line.slice(6)), at: Date.now() }); } catch { }
      }
    });
  });
  return { events, close: () => req.destroy() };
}
const children = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) : []);
const inputsIn = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map(l => JSON.parse(l)).filter(e => e.type === 'input').map(e => String(e.text));

const P1 = 'https://ledger.test/2026/night-trains';
const P2 = 'https://ledger.test/2026/small-hours';
const P3 = 'https://ledger.test/2026/sleeper-math';

// A comment that summons the bots and takes `ms` to answer.
const slowThread = (url, ms, extra = '') => ({
  url, quote: 'the binding constraint', prefix: '', suffix: '',
  msg: { text: `@claude [mock:sleep:${ms}] what about this?${extra}` },
});

console.log('\nparallel — a real companion, several children');

await test('two pages answer at the same time; one page never does', async () => {
  const root = tmp('two-pages');
  const logDir = path.join(root, 'mocklogs');
  const { base } = await startServer({ root, logDir });
  const stream = openEvents(base);
  await sleep(120);
  for (const u of [P1, P2]) await POST(base, '/page', { url: u, title: u, site: 'ledger.test' });

  // page 1 gets a slow turn; page 2 speaks while it is still going
  await POST(base, '/thread', slowThread(P1, 1200));
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === P1), 'P1 running');
  const r2 = await POST(base, '/thread', slowThread(P2, 50));
  assert.equal(r2.json.queued, true);

  // THE CLAIM: page 2 both starts and ends before page 1 is finished.
  await waitFor(() => stream.events.some(e => e.kind === 'turn-end' && e.url === P2), 'P2 answered');
  const p1end = stream.events.find(e => e.kind === 'turn-end' && e.url === P1);
  assert.equal(p1end, undefined, 'page 2 was answered while page 1 was still thinking');
  await waitFor(() => stream.events.some(e => e.kind === 'turn-end' && e.url === P1), 'P1 answered');

  // …and two children were actually spawned, one per page
  assert.equal(children(logDir).length, 2, 'one child per page');

  // Now the other half: a second turn on page 1 waits for the first.
  const before = stream.events.length;
  await POST(base, '/reply', { url: P1, thread_id: '__page__', text: '@claude [mock:sleep:400] first' });
  await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-start' && e.url === P1), 'P1 turn A');
  const same = await POST(base, '/reply', { url: P1, thread_id: '__page__', text: '@claude second' });
  assert.equal(same.json.wait, 'busy', "the page's own conversation has the floor");
  await waitFor(() => stream.events.slice(before).filter(e => e.kind === 'turn-end' && e.url === P1).length === 2,
    'both page-1 turns done');
  const seq = stream.events.slice(before).filter(e => e.url === P1 && /^turn-/.test(e.kind || '')).map(e => e.kind);
  assert.deepEqual(seq, ['turn-start', 'turn-end', 'turn-start', 'turn-end'],
    'a page never has two turns open at once');
  stream.close();
});

await test('/health names whose turn is running and whose is waiting', async () => {
  const root = tmp('health');
  const logDir = path.join(root, 'mocklogs');
  const { base } = await startServer({ root, logDir });
  const stream = openEvents(base);
  await sleep(120);
  for (const u of [P1, P2]) await POST(base, '/page', { url: u, title: u, site: 'ledger.test' });
  await POST(base, '/thread', slowThread(P1, 1500));
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === P1), 'P1 running');
  await POST(base, '/reply', { url: P1, thread_id: '__page__', text: '@claude behind it' });
  await POST(base, '/thread', slowThread(P2, 1500));
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === P2), 'P2 running');

  const h = (await GET(base, '/health')).json;
  assert.equal(h.bridge, 'running');
  assert.equal(h.queue, 3, 'the old single number still totals everything');
  const rows = Object.fromEntries(h.queues.map(r => [r.url, r]));
  assert.deepEqual(rows[P1], { url: P1, running: true, queued: 1 });
  assert.deepEqual(rows[P2], { url: P2, running: true, queued: 0 });
  assert.equal(h.bridges.max, 3);
  assert.ok(h.bridges.live >= 2, 'two children are up');
  stream.close();
});

await test('a cap of one is the old world exactly: one child, strictly serial', async () => {
  const root = tmp('cap1');
  const logDir = path.join(root, 'mocklogs');
  const { base } = await startServer({ root, logDir, pool: '1' });
  const stream = openEvents(base);
  await sleep(120);
  for (const u of [P1, P2, P3]) await POST(base, '/page', { url: u, title: u, site: 'ledger.test' });
  await POST(base, '/thread', slowThread(P1, 500));
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === P1), 'P1 running');
  const r2 = await POST(base, '/thread', slowThread(P2, 50));
  const r3 = await POST(base, '/thread', slowThread(P3, 50));
  assert.equal(r2.json.wait, 'pool_busy', 'somebody else has the floor');
  assert.equal(r3.json.wait, 'pool_busy');
  await waitFor(() => stream.events.filter(e => e.kind === 'turn-end').length === 3, 'all three answered');
  assert.equal(children(logDir).length, 1, 'one child, as before the pool existed');
  const order = stream.events.filter(e => /^turn-/.test(e.kind || '')).map(e => e.kind);
  assert.deepEqual(order, ['turn-start', 'turn-end', 'turn-start', 'turn-end', 'turn-start', 'turn-end'],
    'never two turns open at once');
  stream.close();
});

await test('a child that dies strands only its own page', async () => {
  const root = tmp('death');
  const logDir = path.join(root, 'mocklogs');
  const { base } = await startServer({ root, logDir });
  const stream = openEvents(base);
  await sleep(120);
  for (const u of [P1, P2]) await POST(base, '/page', { url: u, title: u, site: 'ledger.test' });
  // page 1 on one child, page 2 on another, both mid-turn
  await POST(base, '/thread', slowThread(P1, 4000));
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === P1), 'P1 running');
  await POST(base, '/thread', slowThread(P2, 4000));
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === P2), 'P2 running');
  const logs = children(logDir);
  assert.equal(logs.length, 2);
  // whichever child is holding page 1, kill it
  const p1log = logs.find(f => inputsIn(path.join(logDir, f)).some(t => t.includes('binding constraint')
    && inputsIn(path.join(logDir, f)).length > 0 && t.includes('mock:sleep:4000')));
  const owner = Number(path.basename(p1log, '.jsonl'));
  const which = inputsIn(path.join(logDir, p1log)).some(t => t.includes('night-trains')) ? P1 : P2;
  const other = which === P1 ? P2 : P1;
  process.kill(owner, 'SIGKILL');
  const err = await waitFor(() => stream.events.find(e => e.kind === 'error' && e.url === which),
    'the stranded page is told');
  assert.match(String(err.error), /bridge/i);
  await waitFor(() => stream.events.some(e => e.kind === 'turn-end' && e.url === which), 'stranded turn ends');
  // the other page's turn completes normally, with an answer
  const done = await waitFor(() => stream.events.find(e => e.kind === 'reply' && e.url === other),
    'the surviving page still gets its answer');
  assert.match(String(done.msg.text), /MOCK claude reply/);
  assert.equal(stream.events.some(e => e.kind === 'error' && e.url === other), false,
    'the survivor was never told anything went wrong');
  stream.close();
});

// --- project artifact pages: the write lock -------------------------------
function council(tag, { projects = ['alpha'] } = {}) {
  const root = tmp(tag);
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ version: 1 }));
  fs.mkdirSync(path.join(root, 'work', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  for (const id of projects) fs.mkdirSync(path.join(root, 'projects', id), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'portfolio.json'), JSON.stringify({
    version: 1,
    projects: projects.map((id, i) => ({ id, title: id, status: 'active', priority: i + 1, root: `projects/${id}` })),
  }));
  fs.writeFileSync(path.join(root, 'work', 'sessions', '.metadata-index.json'),
    JSON.stringify({ version: 1, entries: {} }));
  return root;
}
function artifact(root, project, name, body) {
  const p = path.join(root, 'projects', project, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return { path: p, url: pathToFileURL(p).href };
}

await test('two pages in ONE project are serial; two projects run at once', async () => {
  const root = tmp('locks');
  const logDir = path.join(root, 'mocklogs');
  const { base } = await startServer({ root, logDir });
  const stream = openEvents(base);
  await sleep(120);
  const cr = council('lockcouncil', { projects: ['alpha', 'beta'] });
  const a1 = artifact(cr, 'alpha', 'one.html', '<!doctype html><title>A1</title><p>alpha one</p>');
  const a2 = artifact(cr, 'alpha', 'two.html', '<!doctype html><title>A2</title><p>alpha two</p>');
  const b1 = artifact(cr, 'beta', 'one.html', '<!doctype html><title>B1</title><p>beta one</p>');
  await POST(base, '/council-root', { root: cr, confirm: true });
  for (const a of [a1, a2, b1]) {
    await POST(base, '/page', { url: a.url, title: path.basename(a.path), site: 'x' });
  }
  // alpha/one starts a long turn
  await POST(base, '/reply', { url: a1.url, thread_id: '__page__', text: '@claude [mock:sleep:1200] hello' });
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === a1.url), 'alpha one running');
  // beta/one runs beside it — a different project, a different child
  const rb = await POST(base, '/reply', { url: b1.url, thread_id: '__page__', text: '@claude [mock:sleep:50] hi' });
  assert.equal(rb.json.queued, true);
  await waitFor(() => stream.events.some(e => e.kind === 'turn-end' && e.url === b1.url), 'beta answered');
  assert.equal(stream.events.some(e => e.kind === 'turn-end' && e.url === a1.url), false,
    'beta finished while alpha was still going — different projects do not block each other');
  // alpha/two must WAIT for alpha/one: same project, same writable directory
  const ra = await POST(base, '/reply', { url: a2.url, thread_id: '__page__', text: '@claude [mock:sleep:50] hi' });
  assert.equal(ra.json.wait, 'busy', 'the project already has the floor');
  assert.equal(stream.events.some(e => e.kind === 'turn-start' && e.url === a2.url), false);
  await waitFor(() => stream.events.some(e => e.kind === 'turn-end' && e.url === a2.url), 'alpha two answered');
  const alpha = stream.events.filter(e => /^turn-/.test(e.kind || '') && (e.url === a1.url || e.url === a2.url));
  assert.deepEqual(alpha.map(e => e.kind), ['turn-start', 'turn-end', 'turn-start', 'turn-end'],
    'one project, one turn at a time — the write lock');
  stream.close();
});

await test('a review round stays ordered and counts straight beside an unrelated page', async () => {
  const root = tmp('round');
  const logDir = path.join(root, 'mocklogs');
  const { base } = await startServer({ root, logDir });
  const stream = openEvents(base);
  await sleep(120);
  const cr = council('roundcouncil', { projects: ['alpha'] });
  const doc = artifact(cr, 'alpha', 'draft.html',
    '<!doctype html><title>Draft</title><p>The first passage stands here.</p>'
    + '<p>The second passage stands here.</p><p>The third passage stands here.</p>');
  await POST(base, '/council-root', { root: cr, confirm: true });
  await POST(base, '/page', { url: doc.url, title: 'Draft', site: 'alpha' });
  await POST(base, '/page', { url: P1, title: 'Night Trains', site: 'ledger.test' });
  // three open comments in the margin
  for (const q of ['The first passage', 'The second passage', 'The third passage']) {
    const r = await POST(base, '/thread', { url: doc.url, quote: q, prefix: '', suffix: '', msg: { text: `what about "${q}"?` } });
    assert.equal(r.status, 200, r.body);
  }
  const sent = await POST(base, '/send-review', { url: doc.url });
  assert.equal(sent.json.ok, true, sent.body);
  assert.equal(sent.json.threads.length, 3);
  assert.equal(sent.json.queued, 4, 'a preamble plus one turn per comment');
  // an unrelated article page speaks in the middle of the round
  await POST(base, '/thread', slowThread(P1, 60));
  await waitFor(() => stream.events.some(e => e.kind === 'turn-end' && e.url === P1), 'the article answered');

  const done = await waitFor(() => stream.events.filter(e => e.type === 'round' && !e.running).pop(),
    'the round finishes', 25000);
  assert.equal(done.total, 3);
  assert.equal(done.answered, 3, 'every comment counted once');
  assert.equal(done.current, null);
  // the ticker never claimed two comments were being answered at once, and
  // never went backwards
  const ticks = stream.events.filter(e => e.type === 'round' && e.url === doc.url);
  let last = -1;
  for (const t of ticks) {
    assert.ok(t.answered >= last, 'the count never goes backwards');
    last = t.answered;
  }
  // the doc's turns are strictly one at a time — that is what makes the ticker
  // truthful — while P1's turn happened somewhere in the middle
  const docTurns = stream.events.filter(e => /^turn-/.test(e.kind || '') && e.url === doc.url).map(e => e.kind);
  assert.equal(docTurns.length, 8, 'preamble + three comments, start and end each');
  for (let i = 0; i < docTurns.length; i += 2) {
    assert.equal(docTurns[i], 'turn-start');
    assert.equal(docTurns[i + 1], 'turn-end');
  }
  // every answer landed in ITS OWN thread
  const page = (await GET(base, `/page?url=${enc(doc.url)}`)).json;
  for (const t of page.threads) {
    assert.ok((t.msgs || []).some(m => m.author === 'claude' || m.author === 'codex'),
      `thread "${t.quote}" got no answer`);
  }
  stream.close();
});

await test('a collateral edit is attributed to the turn that made it, with a page turn running beside it', async () => {
  const root = tmp('collateral');
  const logDir = path.join(root, 'mocklogs');
  const { base } = await startServer({ root, logDir });
  const stream = openEvents(base);
  await sleep(120);
  const cr = council('colcouncil', { projects: ['alpha'] });
  const doc = artifact(cr, 'alpha', 'draft.html',
    '<!doctype html><title>Draft</title>\n<p>The tunnel was dug in 1994.</p>\n<p>Nobody has counted the sleepers since.</p>\n');
  await POST(base, '/council-root', { root: cr, confirm: true });
  await POST(base, '/page', { url: doc.url, title: 'Draft', site: 'alpha' });
  await POST(base, '/page', { url: P1, title: 'Night Trains', site: 'ledger.test' });
  // an unrelated article turn runs for the whole of the document's turn
  await POST(base, '/thread', slowThread(P1, 1500));
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === P1), 'the article is running');
  // …and now the bots rewrite a passage nobody commented on
  const rewritten = '<!doctype html><title>Draft</title>\n<p>The tunnel was dug in 1994.</p>\n'
    + '<p>Nobody has counted the sleepers since the survey of 2011.</p>\n';
  await POST(base, '/reply', {
    url: doc.url, thread_id: '__page__',
    text: `@claude [mock:write:${doc.path}] please fix it`,
  });
  // the mock writes a placeholder; write the real rewrite ourselves at the same
  // moment so the diff has something meaningful to find
  await waitFor(() => stream.events.some(e => e.kind === 'turn-start' && e.url === doc.url), 'doc turn running');
  fs.writeFileSync(doc.path, rewritten);
  await waitFor(() => stream.events.some(e => e.kind === 'turn-end' && e.url === doc.url), 'doc turn ends');
  const files = await waitFor(() => stream.events.find(e => e.type === 'project-files' && e.url === doc.url),
    'the change census reports');
  assert.equal(files.page_changed, true);
  assert.equal(files.collateral, true, 'the rewrite got a thread of its own');
  const page = (await GET(base, `/page?url=${enc(doc.url)}`)).json;
  const auto = (page.threads || []).filter(t => t.auto);
  assert.equal(auto.length >= 1, true, 'an auto thread exists');
  assert.ok(auto.some(t => /survey of 2011/.test(String(t.quote || ''))),
    'and it quotes what stands there NOW');
  // the article page's own turn produced no census at all — it has no project
  assert.equal(stream.events.some(e => e.type === 'project-files' && e.url === P1), false,
    'an ordinary page is never diffed against a project it does not have');
  await waitFor(() => stream.events.some(e => e.kind === 'turn-end' && e.url === P1), 'the article finishes too');
  stream.close();
});

// --- done ----------------------------------------------------------------
for (const p of spawned) { try { p.kill(); } catch { } }
await sleep(120);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('failed: ' + failures.join(', ')); process.exit(1); }
