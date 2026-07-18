// botference service — managed long-lived processes (lib/service.sh).
// Run: node --test tests/service.test.mjs
//
// The critical test simulates the agent-death scenario: a service started
// from inside a child bash must survive both that bash exiting AND a
// SIGKILL of the child's entire process group (the way an agent turn's
// process tree is torn down). No network ports are bound anywhere here —
// services under test are sleep/sh commands only.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(HOME, 'botference');
const ENV = { ...process.env, BOTFERENCE_HOME: HOME };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function svc(cwd, args) {
  return spawnSync(LAUNCHER, ['service', ...args], {
    cwd,
    env: ENV,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function ledger(cwd) {
  const p = path.join(cwd, '.botference', 'services.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')).services ?? [];
}

function entry(cwd, name) {
  return ledger(cwd).find((e) => e.name === name);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(fn, { timeout = 10000, step = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(step);
  }
  return fn();
}

function makeProjectDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'botference-service-'));
  t.after(() => {
    // belt-and-braces: never leave test services running
    try { svc(dir, ['stop', '--all']); } catch { /* ignore */ }
    for (const e of ledger(dir)) {
      try { process.kill(-e.pgid, 'SIGKILL'); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('service survives its starter shell AND a SIGKILL of that shell\'s whole process group', async (t) => {
  const dir = makeProjectDir(t);

  // Child bash in its own process group starts the service, reports READY,
  // then lingers so we can slaughter its group while it is still alive —
  // exactly what happens to an agent's process tree when its turn ends.
  const child = spawn(
    'bash',
    ['-c', `"${LAUNCHER}" service start surv -- sleep 300 && echo READY && sleep 60`],
    { cwd: dir, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  assert.ok(await eventually(() => out.includes('READY')), `starter never got READY:\n${out}`);

  const e = entry(dir, 'surv');
  assert.ok(e, 'ledger entry recorded');
  assert.ok(pidAlive(e.pid), 'service alive after start');
  assert.strictEqual(e.pgid, e.pid, 'service is its own process-group leader');
  assert.ok(e.log && e.command.includes('sleep 300') && e.started && e.cwd, 'ledger fields present');

  // Kill the starter's ENTIRE process group, hard.
  process.kill(-child.pid, 'SIGKILL');
  await eventually(() => child.exitCode !== null || child.signalCode !== null);
  await sleep(500);

  assert.ok(pidAlive(e.pid), 'service must survive the starter process-group SIGKILL');

  // …and service stop must actually kill it.
  const stop = svc(dir, ['stop', 'surv']);
  assert.strictEqual(stop.status, 0, stop.stderr);
  assert.ok(await eventually(() => !pidAlive(e.pid)), 'service dead after stop');
  assert.strictEqual(entry(dir, 'surv'), undefined, 'ledger entry removed');
});

test('duplicate running names are refused', async (t) => {
  const dir = makeProjectDir(t);
  const first = svc(dir, ['start', 'dup', '--', 'sleep', '300']);
  assert.strictEqual(first.status, 0, first.stderr);
  const second = svc(dir, ['start', 'dup', '--', 'sleep', '5']);
  assert.notStrictEqual(second.status, 0);
  assert.match(second.stderr, /already running/);
  assert.strictEqual(ledger(dir).length, 1, 'no second ledger entry');
  svc(dir, ['stop', 'dup']);
});

test('stale entries (dead pids) are reaped; the name becomes reusable', async (t) => {
  const dir = makeProjectDir(t);
  const start = svc(dir, ['start', 'stale', '--', 'sleep', '300']);
  assert.strictEqual(start.status, 0, start.stderr);
  const e = entry(dir, 'stale');
  process.kill(-e.pgid, 'SIGKILL'); // die without botference knowing
  await eventually(() => !pidAlive(e.pid));

  const list = svc(dir, ['list']);
  assert.match(list.stdout, /stale\s+\d+\s+-\s+dead/);
  assert.match(list.stdout, /reaped from the ledger/);
  assert.strictEqual(ledger(dir).length, 0, 'dead entry reaped');

  // reuse the name — the start path reaps too, so this must succeed
  const again = svc(dir, ['start', 'stale', '--', 'sleep', '300']);
  assert.strictEqual(again.status, 0, again.stderr);
  svc(dir, ['stop', 'stale']);
});

test('logs tails the service log; -n limits lines', async (t) => {
  const dir = makeProjectDir(t);
  const start = svc(dir, ['start', 'echoer', '--', 'sh', '-c',
    'echo line-one; echo line-two; echo line-three; sleep 300']);
  assert.strictEqual(start.status, 0, start.stderr);
  await eventually(() => {
    const r = svc(dir, ['logs', 'echoer']);
    return r.stdout.includes('line-three');
  });
  const all = svc(dir, ['logs', 'echoer']);
  assert.strictEqual(all.status, 0, all.stderr);
  assert.ok(all.stdout.includes('line-one') && all.stdout.includes('line-three'));
  const one = svc(dir, ['logs', 'echoer', '-n', '1']);
  assert.strictEqual(one.stdout.trim(), 'line-three');
  svc(dir, ['stop', 'echoer']);
});

test('stop --all stops everything and empties the ledger', async (t) => {
  const dir = makeProjectDir(t);
  assert.strictEqual(svc(dir, ['start', 'one', '--', 'sleep', '300']).status, 0);
  assert.strictEqual(svc(dir, ['start', 'two', '--', 'sleep', '300']).status, 0);
  const pids = ledger(dir).map((e) => e.pid);
  assert.strictEqual(pids.length, 2);

  const stop = svc(dir, ['stop', '--all']);
  assert.strictEqual(stop.status, 0, stop.stderr);
  for (const pid of pids) {
    assert.ok(await eventually(() => !pidAlive(pid)), `pid ${pid} still alive after stop --all`);
  }
  assert.strictEqual(ledger(dir).length, 0);
  assert.match(svc(dir, ['list']).stdout, /no services running/);
});

test('stop escalates to KILL when TERM is ignored', async (t) => {
  const dir = makeProjectDir(t);
  const start = svc(dir, ['start', 'stubborn', '--', 'sh', '-c',
    "trap '' TERM; sleep 300 & wait"]);
  assert.strictEqual(start.status, 0, start.stderr);
  const e = entry(dir, 'stubborn');
  const stop = svc(dir, ['stop', 'stubborn']);
  assert.strictEqual(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /escalated to KILL/);
  assert.ok(await eventually(() => !pidAlive(e.pid)));
});

test('input validation: bad names, missing --, missing command', (t) => {
  const dir = makeProjectDir(t);
  const bad = svc(dir, ['start', 'Bad_Name', '--', 'sleep', '1']);
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid service name/);

  const noSep = svc(dir, ['start', 'ok-name', 'sleep', '1']);
  assert.notStrictEqual(noSep.status, 0);
  assert.match(noSep.stderr, /expected '--'/);

  const noCmd = svc(dir, ['start', 'ok-name', '--']);
  assert.notStrictEqual(noCmd.status, 0);
  assert.match(noCmd.stderr, /no command given/);

  const tooLong = svc(dir, ['start', 'a'.repeat(33), '--', 'sleep', '1']);
  assert.notStrictEqual(tooLong.status, 0);

  assert.strictEqual(ledger(dir).length, 0, 'nothing recorded for invalid starts');
});

test('a command that dies instantly is reported and not left in the ledger', async (t) => {
  const dir = makeProjectDir(t);
  const r = svc(dir, ['start', 'flash', '--', 'sh', '-c', 'echo boom; exit 3']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /exited immediately/);
  assert.strictEqual(entry(dir, 'flash'), undefined);
});

test('share-as-service: prints the share line from the log, then returns; idempotent re-run', async (t) => {
  const dir = makeProjectDir(t);
  // Drive run_share_as_service directly with a stub "share" (no ports).
  const harness = (cmd) => spawnSync('bash', ['-c', `
    set -euo pipefail
    export BOTFERENCE_PROJECT_ROOT="$PWD"
    source "${HOME}/lib/service.sh"
    ${cmd}
  `], { cwd: dir, env: ENV, encoding: 'utf8', timeout: 60000 });

  const first = harness(
    `run_share_as_service fake-share sh -c 'sleep 1; printf "  share this: https://x.example   password: pw123\\n"; sleep 300'`,
  );
  assert.strictEqual(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /share this: https:\/\/x\.example {3}password: pw123/);
  assert.match(first.stdout, /running as service 'fake-share'/);

  // second run: service already up — reprint the last share line, exit 0
  const second = harness(`run_share_as_service fake-share sh -c 'echo never; sleep 300'`);
  assert.strictEqual(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /already running; its last share line/);
  assert.match(second.stdout, /share this: https:\/\/x\.example/);

  const stop = svc(dir, ['stop', 'fake-share']);
  assert.strictEqual(stop.status, 0, stop.stderr);
});
