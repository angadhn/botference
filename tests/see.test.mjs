// botference see: headless screenshots for agents. Verifies the URL and
// :port target forms, viewport control, and error paths. Skips wholesale
// when no Chrome/Chromium is installed (CI without a browser).
//
// The launcher is spawned ASYNCHRONOUSLY: the test's own HTTP server runs
// in this process, so a synchronous spawn would block the event loop and
// deadlock Chrome waiting on a page the server can never send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOTFERENCE = path.join(HOME, 'botference');

function chromePresent() {
  if (process.env.BOTFERENCE_CHROME && fs.existsSync(process.env.BOTFERENCE_CHROME)) return true;
  if (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) return true;
  for (const c of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    if (spawnSync('command', ['-v', c], { shell: true }).status === 0) return true;
  }
  return false;
}
const CHROME = chromePresent();

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// async spawn: resolves {status, stdout, stderr}, never rejects on rc≠0
function see(args, opts = {}) {
  return new Promise(resolve => {
    execFile(BOTFERENCE, ['see', ...args], { encoding: 'utf8', timeout: 90_000, ...opts },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

function serve(port, html) {
  return new Promise(resolve => {
    const srv = http.createServer((_q, rs) => {
      rs.writeHead(200, { 'content-type': 'text/html' }).end(html);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

test('see renders a URL at phone + desktop viewports by default',
  { skip: CHROME ? false : 'no Chrome/Chromium installed' }, async t => {
  const port = await freePort();
  const srv = await serve(port, '<body style="background:#d97757"><h1>seen</h1></body>');
  t.after(() => srv.close());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'see-'));

  const r = await see([`http://127.0.0.1:${port}/`, 'unit', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(out).sort();
  assert.equal(files.length, 2, 'one PNG per default viewport');
  assert.ok(files.some(f => f.includes('-unit-390x844.png')), 'phone shot named by label+viewport');
  assert.ok(files.some(f => f.includes('-unit-1440x900.png')), 'desktop shot');
  for (const f of files) {
    assert.ok(fs.statSync(path.join(out, f)).size > 1000, `${f} is a real render, not an empty file`);
  }
  // the paths are printed for the agent to read back
  assert.equal((r.stdout.match(/^wrote: /gm) || []).length, 2);
});

test('see accepts a bare :port and a single custom viewport',
  { skip: CHROME ? false : 'no Chrome/Chromium installed' }, async t => {
  const port = await freePort();
  const srv = await serve(port, '<h1>port form</h1>');
  t.after(() => srv.close());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'see-'));

  const r = await see([`:${port}`, 'portform', '--viewport', '500x500', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(out);
  assert.equal(files.length, 1, 'custom viewport replaces the defaults');
  assert.match(files[0], /-portform-500x500\.png$/);
});

test('sandboxed lane: requests are served by the see-broker with identical output', async t => {
  // No real Chrome anywhere in this test: a fake chrome script writes a
  // stub PNG, proving the spool protocol end-to-end deterministically.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'see-ws-'));
  fs.mkdirSync(path.join(ws, '.botference'), { recursive: true });
  const fake = path.join(ws, 'fake-chrome');
  fs.writeFileSync(fake, `#!/bin/bash
for a in "$@"; do case "$a" in --screenshot=*) f="\${a#--screenshot=}";; esac; done
head -c 2048 /dev/zero > "$f"
`, { mode: 0o755 });

  // broker in the workspace, with a private ledger index
  const index = path.join(ws, 'ledger-index');
  fs.writeFileSync(index, path.join(ws, '.botference', 'services.json') + '\n');
  const broker = (await import('node:child_process')).spawn(
    BOTFERENCE, ['see', '--serve'],
    { cwd: ws, env: { ...process.env, BOTFERENCE_CHROME: fake, BOTFERENCE_SERVICE_INDEX: index } });
  t.after(() => broker.kill());
  // register the broker in the ledger so clients consider it alive
  fs.writeFileSync(path.join(ws, '.botference', 'services.json'),
    JSON.stringify({ services: [{ name: 'see-broker', pid: broker.pid }] }));
  await new Promise(r => setTimeout(r, 1200));

  // the client is "sandboxed": forced onto the broker lane, no chrome env
  const r = await see([':1', 'brokered', '--viewport', '111x222'], {
    cwd: ws,
    env: { ...process.env, BOTFERENCE_SEE_FORCE_BROKER: '1', BOTFERENCE_SERVICE_INDEX: index },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^wrote: .*-brokered-111x222\.png$/m, 'broker output relayed verbatim');
  const shots = fs.readdirSync(path.join(ws, '.botference', 'shots'));
  assert.equal(shots.length, 1);
  assert.ok(fs.statSync(path.join(ws, '.botference', 'shots', shots[0])).size >= 2048);
  // spool drained: no request or result files left behind
  assert.deepEqual(fs.readdirSync(path.join(ws, '.botference', 'see')), []);
});

test('sandboxed lane: a clear error when no broker service is alive', async () => {
  const r = await see([':1', 'x'],
    { env: { ...process.env, BOTFERENCE_SEE_FORCE_BROKER: '1', BOTFERENCE_SERVICE_INDEX: '/dev/null' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no see-broker service is alive/);
  assert.match(r.stderr, /botference service start see-broker/);
});

test('see fails plainly on an unknown service name and a bad viewport', async () => {
  const r = await see(['no-such-service-xyz'],
    { env: { ...process.env, BOTFERENCE_SERVICE_INDEX: '/dev/null' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no running service by that name/);

  const r2 = await see(['http://127.0.0.1:1/', '--viewport', 'huge']);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /bad viewport/);
});
