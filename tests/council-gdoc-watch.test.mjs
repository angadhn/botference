// The hosted council starts the Doc-comment watcher as a child, starts it
// again after a pause when it dies, stops it on exit, and leaves it off with
// BOTFERENCE_GDOC_WATCH=0. The watcher is a fake (tests/fixtures/
// fake-gdoc-watch.mjs): no python, no Google, no bots.
//
// Run:  node --test tests/council-gdoc-watch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createGdocWatchKeeper, MODES } from '../frontends/council/gdoc-watch.mjs';

const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER = path.join(HOME, 'frontends', 'council', 'server.mjs');
const FAKE_BRIDGE = path.join(HOME, 'tests', 'fixtures', 'fake-council-bridge.mjs');
const FAKE_WATCH = path.join(HOME, 'tests', 'fixtures', 'fake-gdoc-watch.mjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gdoc-watch-'));
const pids = file => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await sleep(25);
  }
  return true;
}

function keeper(file, extra = {}) {
  return createGdocWatchKeeper({
    home: HOME,
    log: () => { },
    env: {
      ...process.env,
      COUNCIL_GDOC_WATCH_CMD: JSON.stringify([process.execPath, FAKE_WATCH, file, ...(extra.args || [])]),
      COUNCIL_GDOC_WATCH_RESTART_MS: '150',
      ...(extra.env || {}),
    },
  });
}

test('keeper: starts the watcher, and stopping it ends the process', async () => {
  const file = path.join(tmp(), 'pids');
  const k = keeper(file);
  assert.equal(k.mode, MODES.IDLE);
  k.start();
  assert.equal(k.mode, MODES.RUNNING);
  assert.ok(await until(() => pids(file).length === 1));
  const [pid] = pids(file);
  k.stop();
  assert.equal(k.mode, MODES.STOPPED);
  assert.ok(await until(() => !alive(pid)), 'the watcher process is gone');
});

test('keeper: a watcher that dies is started again after a pause, not in a tight loop', async () => {
  const file = path.join(tmp(), 'pids');
  const k = keeper(file, { args: ['exit'] });
  k.start();
  await sleep(700);
  k.stop();
  const starts = pids(file).length;
  assert.ok(starts >= 2, `restarted (${starts} starts)`);
  assert.ok(starts <= 6, `with a pause between starts (${starts} starts in 0.7 s)`);
  await sleep(400);
  assert.equal(pids(file).length, starts, 'never started again after stop');
});

test('keeper: BOTFERENCE_GDOC_WATCH=0 leaves it off', async () => {
  const file = path.join(tmp(), 'pids');
  const k = keeper(file, { env: { BOTFERENCE_GDOC_WATCH: '0' } });
  k.start();
  assert.equal(k.mode, MODES.OFF);
  await sleep(300);
  assert.deepEqual(pids(file), []);
  k.stop();
  assert.equal(k.mode, MODES.STOPPED);
});

test('keeper: an illegal move is refused', () => {
  const k = keeper(path.join(tmp(), 'pids'));
  k.stop();
  assert.throws(() => k.start(), /illegal move stopped -> running/);
});

// -- through the real council server ------------------------------------------------

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => [4177, 4180, 4187, 4189].includes(port) ? resolve(freePort()) : resolve(port));
    });
  });
}

async function council({ hosted, env = {} }) {
  const root = tmp();
  const file = path.join(root, 'watch-pids');
  const port = await freePort();
  const args = [SERVER];
  if (hosted) args.push('--hosted');
  const proc = spawn(process.execPath, args, {
    env: {
      ...process.env,
      PORT: String(port),
      BOTFERENCE_PROJECT_ROOT: root,
      BOTFERENCE_HOME: HOME,
      BOTFERENCE_SECRETS_DIR: path.join(root, 'secrets'),
      COUNCIL_BRIDGE_CMD: JSON.stringify([process.execPath, FAKE_BRIDGE, path.join(root, 'rx.txt')]),
      COUNCIL_PASSWORD: 'test-pw',
      COUNCIL_GDOC_WATCH_CMD: JSON.stringify([process.execPath, FAKE_WATCH, file]),
      ...env,
    },
  });
  let out = '';
  proc.stdout.on('data', c => { out += c; });
  proc.stderr.on('data', c => { out += c; });
  assert.ok(await until(() => /Council live at/.test(out), 15000), `server started:\n${out}`);
  return { proc, file, out: () => out };
}

test('server: a hosted council starts the watcher and stops it on exit', async () => {
  const c = await council({ hosted: true });
  assert.ok(await until(() => pids(c.file).length === 1), c.out());
  const [pid] = pids(c.file);
  assert.ok(alive(pid));
  c.proc.kill('SIGTERM');
  assert.ok(await until(() => !alive(pid)), 'the watcher stops with the server');
});

test('server: BOTFERENCE_GDOC_WATCH=0 keeps it off', async () => {
  const c = await council({ hosted: true, env: { BOTFERENCE_GDOC_WATCH: '0' } });
  await sleep(500);
  assert.deepEqual(pids(c.file), []);
  assert.match(c.out(), /Doc-comment watcher off/);
  c.proc.kill('SIGTERM');
});

test('server: a local (not hosted) council does not start it', async () => {
  const c = await council({ hosted: false });
  await sleep(500);
  assert.deepEqual(pids(c.file), []);
  c.proc.kill('SIGTERM');
});
