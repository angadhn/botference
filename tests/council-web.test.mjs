// Council-web end-to-end tests: server boot, SSE relay + history replay,
// verbatim input delivery to the bridge, the hosted password gate, --no-auth,
// the shared tunnel helper, and a happy-dom smoke of the chat UI.
// The bridge is stubbed (tests/fixtures/fake-council-bridge.mjs) for CI
// determinism — no python, no agent CLIs.
//
// Run:  node --test tests/council-web.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER = path.join(HOME, 'frontends', 'council', 'server.mjs');
const FAKE = path.join(HOME, 'tests', 'fixtures', 'fake-council-bridge.mjs');

function freePort() {
  // ephemeral OS port; never the conventional deployment ports (4177/4180/4187)
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => [4177, 4180, 4187].includes(port) ? resolve(freePort()) : resolve(port));
    });
  });
}

// Every variable frontends/shared/keys.mjs takes authority over. Stripped from
// the base environment of every test server so a developer's REAL key can
// never reach a fixture file or an assertion — tests put their own
// (obviously fake) values back through `env`.
const AUTH_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
];
function cleanEnv() {
  const e = { ...process.env };
  for (const v of AUTH_VARS) delete e[v];
  return e;
}

async function startServer({ hosted = false, noauth = false, env = {} } = {}) {
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-'));
  const rx = path.join(root, 'rx.txt');
  // keys are written to a THROWAWAY secrets dir: no test ever reads or writes
  // the real ~/.botference/discuss-keys.json
  const secrets = path.join(root, 'secrets');
  const args = [SERVER];
  if (hosted) args.push('--hosted');
  if (noauth) args.push('--no-auth');
  const proc = spawn(process.execPath, args, {
    env: {
      ...cleanEnv(),
      PORT: String(port),
      BOTFERENCE_PROJECT_ROOT: root,
      BOTFERENCE_HOME: HOME,
      BOTFERENCE_SECRETS_DIR: secrets,
      COUNCIL_BRIDGE_CMD: JSON.stringify([process.execPath, FAKE, rx]),
      COUNCIL_PASSWORD: hosted && !noauth ? 'test-pw' : '',
      ...env,
    },
  });
  let out = '';
  proc.stdout.on('data', c => { out += c; });
  proc.stderr.on('data', c => { out += c; });
  const deadline = Date.now() + 15000;
  while (!/Council live at/.test(out)) {
    if (Date.now() > deadline) { proc.kill(); throw new Error(`server did not start:\n${out}`); }
    await new Promise(r => setTimeout(r, 50));
  }
  // the boot bridge records the auth environment it was handed a beat after
  // the listen log; wait for that line so the billing tests can count spawns
  const envDeadline = Date.now() + 5000;
  while (!fs.existsSync(`${rx}.env`) && Date.now() < envDeadline) {
    await new Promise(r => setTimeout(r, 25));
  }
  return {
    proc, port, root, rx, secrets, base: `http://127.0.0.1:${port}`,
    keysFile: path.join(secrets, 'discuss-keys.json'),
    modesFile: path.join(root, '.botference', 'council', 'key-modes.json'),
    // one JSON object per bridge spawn: the auth variables that process was
    // actually handed (fake-council-bridge.mjs writes it)
    spawnEnvs: () => (fs.existsSync(`${rx}.env`)
      ? fs.readFileSync(`${rx}.env`, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : []),
    // a bridge child that is still exiting can write into the workspace while
    // it is being removed; the temp dir is not the assertion, so retry a
    // couple of times and never fail a test over housekeeping
    stop: () => {
      proc.kill();
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(root, { recursive: true, force: true }); return; } catch { }
      }
    },
  };
}

// read SSE events from /events until pred(events) or timeout
async function sseUntil(base, pred, { headers = {}, timeout = 8000 } = {}) {
  const ac = new AbortController();
  const r = await fetch(`${base}/events`, { headers, signal: ac.signal });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  const events = [];
  let buf = '';
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise(res => setTimeout(() => res({ value: null, done: false }), 200)),
      ]);
      if (done) break;
      if (value) {
        buf += Buffer.from(value).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(chunk);
          if (m) { try { events.push(JSON.parse(m[1])); } catch { } }
        }
      }
      if (pred(events)) return events;
    }
  } finally { ac.abort(); }
  throw new Error(`SSE predicate not met; got: ${events.map(e => e.type).join(',')}`);
}

const post = (base, url, body, headers = {}) =>
  fetch(base + url, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });

// ---------------------------------------------------------------- server

test('GET /project-contents lists a project folder, shallow, and refuses to leave it', async t => {
  const s = await startServer();
  t.after(s.stop);
  const dir = path.join(s.root, 'projects', 'demo');
  fs.mkdirSync(path.join(dir, 'figures'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'figures', 'raw'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), '# Demo\n');
  fs.writeFileSync(path.join(dir, 'figures', 'fig1.png'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(dir, '.secret'), 'no');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });

  const r = await fetch(`${s.base}/project-contents?id=demo`);
  assert.equal(r.status, 200);
  const d = await r.json();
  const names = d.files.map(f => f.path);
  assert.ok(names.includes('PROJECT.md'));
  assert.ok(names.includes('figures'));
  assert.ok(names.includes('figures/fig1.png'), 'one level inside a folder');
  assert.ok(!names.includes('figures/raw/'), 'and no further — the walk is shallow');
  assert.ok(!names.some(n => n.startsWith('.')), 'dotfiles are never listed');
  assert.ok(!names.includes('node_modules'), 'nor the noise directories');
  const fig = d.files.find(f => f.path === 'figures/fig1.png');
  assert.equal(fig.size, 2048);
  assert.equal(fig.depth, 1);
  const raw = d.files.find(f => f.path === 'figures/raw');
  assert.equal(raw.truncated, true, 'a folder it did not walk says so');

  // it can only ever name a project folder — the id is not a path
  for (const bad of ['', '..', '.hidden', 'a/b']) {
    const bad_r = await fetch(`${s.base}/project-contents?id=${encodeURIComponent(bad)}`);
    assert.ok(bad_r.status >= 400, `${JSON.stringify(bad)} is refused (${bad_r.status})`);
  }
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/project-contents?id=%2e%2e%2fwork' },
      res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.ok(status >= 400, 'an encoded escape is refused too');
});

test('local mode: boots, serves the app shell + assets, replays bridge history over SSE', async t => {
  const s = await startServer();
  t.after(s.stop);
  const page = await fetch(`${s.base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /botference/);
  assert.match(html, /Let a chat begin/);
  for (const a of ['/assets/app.js', '/assets/style.css']) {
    assert.equal((await fetch(s.base + a)).status, 200, `${a} serves`);
  }
  // asset path traversal stays blocked (raw request — fetch/URL would
  // normalize the encoded dot segments away client-side)
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/assets/%2e%2e/server.mjs' },
      r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
  // events the fake bridge emitted BEFORE we connected arrive via history replay
  const events = await sseUntil(s.base, evs =>
    evs.some(e => e.type === 'hello') &&
    evs.some(e => e.type === 'completion_context') &&
    evs.some(e => e.type === 'projects') &&
    evs.some(e => e.type === 'ready'));
  const ctx = events.find(e => e.type === 'completion_context');
  assert.ok(ctx.global.includes('/status'));
  const projects = events.find(e => e.type === 'projects');
  assert.equal(projects.projects[0].title, 'Demo project');
  const hello = events.find(e => e.type === 'hello');
  assert.equal(hello.noauth, false);
});

test('POST /input reaches the bridge verbatim; SSE relays echo, stream, and final room', async t => {
  const s = await startServer();
  t.after(s.stop);
  const r = await post(s.base, '/input', { text: '/status' });
  assert.deepEqual(await r.json(), { ok: true });
  const events = await sseUntil(s.base, evs =>
    evs.some(e => e.type === 'user_echo') &&
    evs.some(e => e.type === 'stream' && e.kind === 'text_delta') &&
    evs.some(e => e.type === 'room' && e.speaker === 'claude'));
  assert.equal(events.find(e => e.type === 'user_echo').text, '/status');
  assert.equal(fs.readFileSync(s.rx, 'utf8'), '/status\n', 'slash command delivered verbatim');
  const room = events.find(e => e.type === 'room' && e.speaker === 'claude');
  assert.equal(room.text, 'echo: /status');
  assert.equal(room.stream_id, 's1');
  // the replayed history coalesces consecutive deltas of one stream; a client
  // connecting mid-turn may still see the tail delta live, so assert on the
  // combined text rather than an exact event count
  const deltas = events.filter(e => e.type === 'stream' && e.kind === 'text_delta');
  assert.ok(deltas.length <= 2, 'history replay coalesced the deltas');
  assert.equal(deltas.map(d => d.text).join(''), 'thinking about your message');
});

test('completion_context is pinned: replayed to clients that connect after a clear_panes history wipe', async t => {
  const s = await startServer();
  t.after(s.stop);
  // let the bridge's startup burst land, then wipe the history (resume shape)
  await sseUntil(s.base, evs => evs.some(e => e.type === 'ready'));
  await post(s.base, '/input', { text: '/trigger-clear' });
  const events = await sseUntil(s.base, evs =>
    evs.some(e => e.type === 'room' && /fresh chat/.test(e.text)));
  // a client connecting AFTER the wipe still gets the completion context
  // (pinned outside history), so slash autocomplete survives chat switches
  const ctx = events.find(e => e.type === 'completion_context');
  assert.ok(ctx, 'completion_context replayed post-wipe');
  assert.ok(ctx.global.includes('/status'));
});

test('choice and permission requests round-trip through /choice and /permission', async t => {
  const s = await startServer();
  t.after(s.stop);
  await post(s.base, '/input', { text: '/trigger-choice' });
  await sseUntil(s.base, evs => evs.some(e => e.type === 'choice_request'));
  await post(s.base, '/choice', { index: 1 });
  await sseUntil(s.base, evs => evs.some(e => e.type === 'room' && /choice answered: 1/.test(e.text)));
  await post(s.base, '/input', { text: '/trigger-permission' });
  await sseUntil(s.base, evs => evs.some(e => e.type === 'permission_request'));
  await post(s.base, '/permission', { allow: false });
  await sseUntil(s.base, evs => evs.some(e => e.type === 'room' && /permission: false/.test(e.text)));
});

test('hosted mode: password gate + HMAC cookie; ungated requests are denied', async t => {
  const s = await startServer({ hosted: true });
  t.after(s.stop);
  // document request without auth -> the gate page, not the app
  const gate = await fetch(`${s.base}/`, { headers: { accept: 'text/html' } });
  assert.equal(gate.status, 401);
  assert.match(await gate.text(), /password-protected/);
  // JSON/POST without auth -> plain 401 JSON (no basic-auth popup header)
  const inp = await post(s.base, '/input', { text: 'hi' });
  assert.equal(inp.status, 401);
  assert.equal(inp.headers.get('www-authenticate'), null);
  // wrong password -> gate again
  const bad = await fetch(`${s.base}/auth`, {
    method: 'POST', body: 'password=nope&next=%2F',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(bad.status, 401);
  // right password -> cookie + redirect; cookie unlocks the app and POSTs
  const good = await fetch(`${s.base}/auth`, {
    method: 'POST', body: 'password=test-pw&next=%2F', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(good.status, 303);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^council_auth=/);
  assert.equal((await fetch(`${s.base}/`, { headers: { cookie } })).status, 200);
  const ok = await post(s.base, '/input', { text: '/status' }, { cookie });
  assert.deepEqual(await ok.json(), { ok: true });
});

test('--hosted --no-auth: no gate, hello advertises noauth for the warning banner', async t => {
  const s = await startServer({ hosted: true, noauth: true });
  t.after(s.stop);
  assert.equal((await fetch(`${s.base}/`, { headers: { accept: 'text/html' } })).status, 200);
  const events = await sseUntil(s.base, evs => evs.some(e => e.type === 'hello'));
  assert.equal(events.find(e => e.type === 'hello').noauth, true);
});

test('second server on the same workspace is refused (council-web.lock)', async t => {
  const s = await startServer();
  t.after(s.stop);
  const port = await freePort();
  // a second full server against the same workspace root must refuse the lock
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, PORT: String(port), BOTFERENCE_PROJECT_ROOT: s.root,
      BOTFERENCE_HOME: HOME, COUNCIL_BRIDGE_CMD: JSON.stringify([process.execPath, FAKE]),
    },
  });
  let err = '';
  proc.stderr.on('data', c => { err += c; });
  const code = await new Promise(res => proc.on('exit', res));
  assert.equal(code, 1);
  assert.match(err, /another council web server/);
});

test('SSE transport hygiene: padded flushed first chunk, proxy headers, comment heartbeat', async t => {
  // proxies/CDN edges (cloudflared quick tunnels included) buffer small first
  // chunks and idle streams: /events must open with an ~2KB comment pad,
  // anti-buffering headers, and a periodic comment heartbeat
  const s = await startServer({ env: { SSE_HEARTBEAT_MS: '120' } });
  t.after(s.stop);
  const http = await import('node:http');
  const { headers, firstChunk, body } = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/events' }, r => {
      let first = null, all = '';
      r.on('data', c => { const str = c.toString('utf8'); if (first === null) first = str; all += str; });
      setTimeout(() => { req.destroy(); resolve({ headers: r.headers, firstChunk: first, body: all }); }, 600);
    });
    req.on('error', reject);
  });
  assert.equal(headers['content-type'], 'text/event-stream');
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-accel-buffering'], 'no');
  assert.match(headers.connection || '', /keep-alive/i);
  // first bytes are an SSE comment pad of >= 2KB, ahead of any data event
  assert.equal(firstChunk[0], ':', 'stream opens with a comment pad');
  const padEnd = body.indexOf('\n\n');
  assert.ok(padEnd >= 2048, `pad is >= 2KB (got ${padEnd})`);
  assert.ok(body.indexOf(':') < body.indexOf('data:'), 'pad precedes the first event');
  assert.match(body, /data: \{"type":"hello"/, 'hello arrives after the pad');
  // >= 2 heartbeats in 600ms at a 120ms interval
  const beats = (body.match(/: ping\n\n/g) || []).length;
  assert.ok(beats >= 2, `comment heartbeats flow (got ${beats})`);
});

test('WebSocket transport: hello + history replay + live events; gate enforced when hosted', async t => {
  // WS is the primary browser transport because cloudflared buffers streamed
  // HTTP bodies (SSE stalls through tunnels); it must carry the same events
  const { wsConnect } = await import('./fixtures/ws-client.mjs');
  const s = await startServer();
  t.after(s.stop);
  const c = await wsConnect({ host: '127.0.0.1', port: s.port });
  t.after(() => c.close());
  const hello = await c.next(e => e.type === 'hello');
  assert.equal(hello.noauth, false);
  await c.next(e => e.type === 'projects');           // history replayed over WS
  await c.next(e => e.type === 'completion_context');
  await c.next(e => e.type === 'replay_done');        // explicit replay boundary
  await post(s.base, '/input', { text: '/status' });  // live events flow over WS
  await c.next(e => e.type === 'user_echo' && e.text === '/status');
  await c.next(e => e.type === 'room' && e.speaker === 'claude' && e.text === 'echo: /status');

  // hosted: the upgrade request passes the same gate as every HTTP request
  const h = await startServer({ hosted: true });
  t.after(h.stop);
  await assert.rejects(wsConnect({ host: '127.0.0.1', port: h.port }), /401/);
  const auth = await fetch(`${h.base}/auth`, {
    method: 'POST', body: 'password=test-pw&next=%2F', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const gated = await wsConnect({ host: '127.0.0.1', port: h.port, headers: { cookie } });
  t.after(() => gated.close());
  await gated.next(e => e.type === 'hello');
});

// ------------------------------------------------------------ bridge pool

test('bridge pool: ?chat=<sid> runs a second concurrent bridge; POSTs route by bridge id; streams stay isolated', async t => {
  const { wsConnect } = await import('./fixtures/ws-client.mjs');
  const s = await startServer();
  t.after(s.stop);
  // tab A: default attach — the primary bridge
  const a = await wsConnect({ host: '127.0.0.1', port: s.port });
  t.after(() => a.close());
  const helloA = await a.next(e => e.type === 'hello');
  assert.ok(helloA.bridge_id, 'hello names the bridge this tab is attached to');
  await a.next(e => e.type === 'replay_done');
  // tab B: asks for a different chat — a second bridge spawns and is told to
  // /resume it (no sessions dir in the test root, so the check is permissive)
  const b = await wsConnect({ host: '127.0.0.1', port: s.port, path: '/ws?chat=sidB0001' });
  t.after(() => b.close());
  const helloB = await b.next(e => e.type === 'hello');
  assert.ok(helloB.bridge_id, 'second tab gets a bridge');
  assert.notEqual(helloB.bridge_id, helloA.bridge_id, 'a DIFFERENT bridge than tab A');
  assert.equal(helloB.chat, 'sidB0001', 'hello names the chat the tab asked for');
  assert.equal(helloB.resuming, true, 'a fresh bridge advertises its in-flight /resume');
  await b.next(e => e.type === 'replay_done');
  // the fake bridge answers the queued /resume with an echo turn — that turn
  // completing proves the spawn-time /resume reached bridge B
  await b.next(e => e.type === 'room' && e.text === 'echo: /resume sidB0001', 8000);
  assert.match(fs.readFileSync(s.rx, 'utf8'), /^\/resume sidB0001$/m, 'the spawn-time /resume reached bridge B');
  // input named for bridge B lands in B's chat and streams ONLY to tab B
  await post(s.base, '/input', { text: 'hello-B', bridge: helloB.bridge_id });
  await b.next(e => e.type === 'user_echo' && e.text === 'hello-B');
  await b.next(e => e.type === 'room' && e.text === 'echo: hello-B');
  // input named for bridge A lands in A's chat and streams ONLY to tab A
  await post(s.base, '/input', { text: 'hello-A', bridge: helloA.bridge_id });
  await a.next(e => e.type === 'user_echo' && e.text === 'hello-A');
  await a.next(e => e.type === 'room' && e.text === 'echo: hello-A');
  assert.ok(!a.events.some(e => e.type === 'user_echo' && e.text === 'hello-B'),
    "tab A never sees tab B's traffic");
  assert.ok(!b.events.some(e => e.type === 'user_echo' && e.text === 'hello-A'),
    "tab B never sees tab A's traffic");
  // a typed /resume of a chat another bridge drives is not forwarded (it
  // would fork the session) — the tab is told to reattach instead. The fake
  // bridges both report active session abc12345; bridge A owns it first.
  const r = await post(s.base, '/input', { text: '/resume abc12345', bridge: helloB.bridge_id });
  assert.deepEqual(await r.json(), { ok: true, switch: 'abc12345' });
  assert.ok(!b.events.some(e => e.type === 'user_echo' && e.text === '/resume abc12345'),
    'the intercepted /resume was not echoed or forwarded');
});

test('bridge pool: a projects snapshot from one bridge fans out to every tab, re-marked per chat', async t => {
  const { wsConnect } = await import('./fixtures/ws-client.mjs');
  const s = await startServer();
  t.after(s.stop);
  // tab A on the primary bridge (its chat: abc12345, per the fake's startup)
  const a = await wsConnect({ host: '127.0.0.1', port: s.port });
  t.after(() => a.close());
  await a.next(e => e.type === 'hello');
  await a.next(e => e.type === 'replay_done');
  // tab B spawns a second bridge that resumes sidB0001; its post-resume
  // snapshot (listing sidB0001 + abc12345) is workspace state
  const b = await wsConnect({ host: '127.0.0.1', port: s.port, path: '/ws?chat=sidB0001' });
  t.after(() => b.close());
  await b.next(e => e.type === 'hello');
  await b.next(e => e.type === 'replay_done');
  // the snapshot reaches TAB A (cross-bridge fanout), re-marked so tab A's
  // own chat stays the active one
  const pA = await a.next(e => e.type === 'projects' &&
    ((e.projects[0] || {}).sessions || []).some(x => x.session_id === 'sidB0001'), 8000);
  const rowsA = Object.fromEntries(pA.projects[0].sessions.map(x => [x.session_id, x.active]));
  assert.equal(rowsA.abc12345, true, "tab A keeps its own chat flagged active");
  assert.equal(rowsA.sidB0001, false, "the other tab's chat is not active for tab A");
  // and tab B's copy of the same snapshot marks sidB0001 active instead
  const pB = await b.next(e => e.type === 'projects' &&
    ((e.projects[0] || {}).sessions || []).some(x => x.session_id === 'sidB0001'), 8000);
  const rowsB = Object.fromEntries(pB.projects[0].sessions.map(x => [x.session_id, x.active]));
  assert.equal(rowsB.sidB0001, true, "tab B sees its own chat active");
  assert.equal(rowsB.abc12345, false);
  // a LATER tab connecting to the primary replays the freshest snapshot —
  // not the primary's own stale startup listing
  const c2 = await wsConnect({ host: '127.0.0.1', port: s.port });
  t.after(() => c2.close());
  const pC = await c2.next(e => e.type === 'projects');
  assert.ok((pC.projects[0].sessions || []).some(x => x.session_id === 'sidB0001'),
    'replay serves the globally freshest snapshot');
  await c2.next(e => e.type === 'replay_done');
});

test('bridge pool: an unknown chat id falls back to the primary bridge with a route_error', async t => {
  const { wsConnect } = await import('./fixtures/ws-client.mjs');
  const s = await startServer();
  t.after(s.stop);
  // a real sessions dir exists -> the server can (and does) validate ids
  fs.mkdirSync(path.join(s.root, 'work', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'work', 'sessions', 'realsid01.json'), '{}');
  const c = await wsConnect({ host: '127.0.0.1', port: s.port, path: '/ws?chat=nope9999' });
  t.after(() => c.close());
  const err = await c.next(e => e.type === 'route_error');
  assert.match(err.error, /chat not found/);
  const hello = await c.next(e => e.type === 'hello');
  assert.ok(hello.bridge_id, 'still attached (to the primary bridge)');
  assert.equal(hello.resuming, false);
  // a KNOWN id passes validation and gets its own bridge
  const d = await wsConnect({ host: '127.0.0.1', port: s.port, path: '/ws?chat=realsid01' });
  t.after(() => d.close());
  const helloD = await d.next(e => e.type === 'hello');
  assert.equal(helloD.chat, 'realsid01');
  assert.notEqual(helloD.bridge_id, hello.bridge_id);
  assert.ok(!d.events.some(e => e.type === 'route_error'));
});

// ---------------------------------------------------------------- tunnel

test('tunnel helper: named tunnel uses `cloudflared tunnel run` with the configured name', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const argvFile = path.join(dir, 'argv.txt');
  // fake cloudflared on PATH: records argv, then sleeps like a real tunnel
  fs.writeFileSync(path.join(dir, 'cloudflared'),
    `#!/bin/bash\necho "$@" > "${argvFile}"\nsleep 5\n`, { mode: 0o755 });
  const out = execFileSync('bash', ['-c', `
    set -euo pipefail
    export PATH="${dir}:$PATH"
    export BOTFERENCE_TUNNEL=my-tunnel
    export BOTFERENCE_TUNNEL_URL=https://council.example.com
    source "${HOME}/lib/tunnel.sh"
    start_share_tunnel 4321 "${dir}/log"
    echo "kind=$TUNNEL_KIND url=$SHARE_URL"
    print_share_line "pw123" 4321 "${dir}/log"
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "${argvFile}" ] && break; sleep 0.2; done
    stop_share_tunnel
  `], { encoding: 'utf8' });
  assert.match(out, /kind=named url=https:\/\/council\.example\.com/);
  assert.match(out, /using named cloudflared tunnel 'my-tunnel'/);
  assert.match(out, /share this: https:\/\/council\.example\.com\s+password: pw123/);
  assert.equal(fs.readFileSync(argvFile, 'utf8').trim(),
    'tunnel run --url http://localhost:4321 my-tunnel');
});

test('tunnel helper: cloudflared missing -> start_share_tunnel returns 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-none-'));
  const out = execFileSync('bash', ['-c', `
    export PATH="${dir}"
    export BOTFERENCE_TUNNEL=my-tunnel
    source "${HOME}/lib/tunnel.sh"
    if start_share_tunnel 4321 "${dir}/log"; then echo started; else echo "missing rc=$?"; fi
  `], { encoding: 'utf8' });
  assert.match(out, /missing rc=1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- UI smoke

let HAPPY = false;
try { await import('happy-dom'); HAPPY = true; } catch { }

test('UI smoke: transcript, sidebar, completions, slash input verbatim (happy-dom)',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { GlobalWindow } = await import('happy-dom');
  const vm = await import('node:vm');
  const w = new GlobalWindow({ url: 'http://localhost/', width: 1280, height: 900 });
  t.after(() => w.happyDOM.close());
  const doc = w.document;
  const html = fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'index.html'), 'utf8');
  doc.write(html.replace(/<script[^>]*src=[^>]*><\/script>/g, ''));
  // stubs: no network in the harness
  const posts = [];
  w.fetch = async (url, opts) => {
    posts.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  w.EventSource = class { constructor() { } close() { } };
  // recording socket stub: never opens, never errors (deterministic), and
  // captures the attach URL so tests can assert which chat a (re)connect
  // asked for (?chat=<sid>)
  const wsUrls = [];
  w.WebSocket = class { constructor(url) { wsUrls.push(url); } close() { } send() { } };
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'app.js'), 'utf8'), w);
  const C = w.__council;
  assert.ok(C, 'app exposes the harness handle');

  // empty state shows before any content
  assert.equal(doc.getElementById('empty').hasAttribute('hidden'), false);

  // projects event renders the sidebar (project + chat + inbox count), plus a
  // flat Recent shortlist with a project chip per row (Inbox chats included,
  // ordered by updated_at desc — the loose thought is older, so it lists second)
  C.handle({
    type: 'projects', active_project_id: 'p1', inbox_session_count: 3,
    inbox_sessions: [{ session_id: 'inb00001', title: 'Loose thought', updated_at: '2026-01-01T00:00:00Z', active: false }],
    projects: [{
      id: 'p1', title: 'Demo project', active: true, session_count: 1,
      sessions: [{ session_id: 'abc12345', title: 'First chat', updated_at: new Date().toISOString(), active: false }],
    }],
  });
  assert.match(doc.getElementById('projects').textContent, /Demo project/);
  assert.match(doc.getElementById('projects').textContent, /First chat/);
  assert.match(doc.getElementById('projects').textContent, /Inbox/);
  assert.match(doc.getElementById('projects').textContent, /Recent/);
  assert.match(doc.getElementById('projects').textContent, /Loose thought/);
  const recentRows = [...doc.querySelectorAll('.sess.recent')];
  assert.equal(recentRows.length, 2, 'recent lists both chats');
  assert.equal(recentRows[0].dataset.sid, 'abc12345', 'newest first');
  assert.match(recentRows[0].querySelector('.chip').textContent, /Demo project/);
  assert.match(recentRows[1].querySelector('.chip').textContent, /Inbox/);

  // clicking a chat re-attaches this tab's stream to that chat's bridge
  doc.querySelector('.sess[data-act="resume"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=abc12345$/, 'switch reconnects to the target chat');
  // settle the in-flight switch (attach hello + replay boundary) for the rest
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done', count: 0 });

  // before any completion_context arrives, the seeded fallback still
  // completes slash commands (a client can otherwise boot with an empty ctx
  // when the server's history no longer holds the bridge's startup event)
  assert.equal(JSON.stringify(C.computeCompletions('/agent')), JSON.stringify(['/agents']));
  assert.equal(JSON.stringify(C.computeCompletions('/effort @claude xh')), JSON.stringify(['/effort @claude xhigh']));

  // completion popover: entries from a fake completion_context
  C.handle({ type: 'completion_context', global: ['/status', '/new', '/style-nope'], scoped: { '/model @claude ': ['claude-fable-5'] } });
  // JSON-compare: arrays from the vm realm are never reference-equal
  assert.equal(JSON.stringify(C.computeCompletions('/st')), JSON.stringify(['/status', '/style-nope']));
  assert.equal(JSON.stringify(C.computeCompletions('/model @claude fab')), JSON.stringify(['/model @claude claude-fable-5']));
  const input = doc.getElementById('input');
  input.value = '/st';
  input.dispatchEvent(new w.Event('input'));
  const pop = doc.getElementById('complete');
  assert.equal(pop.hasAttribute('hidden'), false, 'popover opens for a slash prefix');
  assert.match(pop.textContent, /\/status/);

  // typing /status and pressing Enter sends it verbatim (popover hides on
  // exact match, so Enter submits rather than completing)
  input.value = '/status';
  input.dispatchEvent(new w.Event('input'));
  assert.equal(pop.hasAttribute('hidden'), true, 'no popover on an exact command');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: 'b1', text: '/status', attachments: [] } });

  // transcript: user echo, streaming delta, final room replaces the stream
  C.handle({ type: 'user_echo', text: 'hello council' });
  assert.equal(doc.getElementById('empty').hasAttribute('hidden'), true, 'empty state yields to content');
  assert.match(doc.querySelector('.msg.user .body').textContent, /hello council/);
  C.handle({ type: 'stream', kind: 'text_delta', stream_id: 's9', model: 'claude', text: 'partial ' });
  // a delta puts the text IN HAND; the typewriter drain is what puts it on
  // screen (see the typewriter tests at the foot of this file). Stepping it by
  // hand keeps this assertion about the transcript rather than about timing.
  for (let i = 0; i < 40 && !/partial/.test(doc.querySelector('.msg.claude.streaming .body').textContent); i++) C.typeDrain();
  const streaming = doc.querySelector('.msg.claude.streaming .body');
  assert.match(streaming.textContent, /partial/);
  // the tool-run entry lands AFTER the text started streaming but must render
  // BEFORE it, as a collapsed expandable card — the reply stays last
  C.handle({ type: 'room', speaker: 'claude', stream_id: 's9:tools', text: 'Explored\n├ Read notes.md\n└ Shell ls' });
  const toolsCard = doc.querySelector('.msg.tools-msg');
  assert.ok(toolsCard, 'tool run renders as its own card');
  assert.match(toolsCard.querySelector('summary').textContent, /claude explored · 2 steps/);
  assert.match(toolsCard.querySelector('.tool-steps').textContent, /Read notes\.md/);
  assert.ok(toolsCard.nextElementSibling.classList.contains('streaming'),
    'tools card is inserted before the streaming reply');
  C.handle({ type: 'room', speaker: 'claude', stream_id: 's9', text: 'final text' });
  assert.equal(doc.querySelector('.msg.claude.streaming'), null, 'stream finalized');
  const claudeMsgs = [...doc.querySelectorAll('.msg.claude')];
  assert.match(claudeMsgs[claudeMsgs.length - 1].querySelector('.body').textContent, /final text/,
    'the reply, not the tool run, is the last thing in the turn');

  // multi-line system output (/help shape) renders as a legible block
  C.handle({ type: 'room', speaker: 'system', text: 'Chat lifecycle:\n  /new — start fresh\n  /resume — switch' });
  const sys = [...doc.querySelectorAll('.msg.system')].pop();
  assert.ok(sys.classList.contains('block'), 'multi-line system entry gets block styling');
  assert.match(sys.textContent, /\/resume — switch/);

  // choice card: options render; clicking posts the index
  C.handle({ type: 'choice_request', prompt: 'Where should this chat live?', options: ['Stay in inbox', 'Demo project'] });
  const card = doc.querySelector('.msg.card:not(.answered)');
  assert.match(card.textContent, /Where should this chat live\?/);
  card.querySelector('button[data-i="1"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(posts.pop(), { url: '/choice', body: { bridge: 'b1', index: 1 } });
  assert.ok(card.classList.contains('answered'));

  // permission card: deny posts allow:false
  C.handle({ type: 'permission_request', model: 'codex', path: '/somewhere/file.md', reason: 'draft plan' });
  const perm = doc.querySelector('.msg.card.perm:not(.answered)');
  assert.match(perm.textContent, /file\.md/);
  perm.querySelector('button.deny').click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(posts.pop(), { url: '/permission', body: { bridge: 'b1', allow: false } });

  // no-auth hello shows the warning banner; dismiss persists
  C.handle({ type: 'hello', noauth: true });
  assert.equal(doc.getElementById('noauth-banner').hasAttribute('hidden'), false);
  doc.getElementById('noauth-x').click();
  assert.equal(doc.getElementById('noauth-banner').hasAttribute('hidden'), true);
  assert.equal(w.localStorage.getItem('council-noauth-dismissed'), '1');

  // theme control stamps data-theme both ways
  const seg = doc.querySelector('#theme-toggle .seg-btn[data-theme-opt="dark"]');
  seg.click();
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  doc.querySelector('#theme-toggle .seg-btn[data-theme-opt="system"]').click();
  assert.equal(doc.documentElement.getAttribute('data-theme'), null);
});

// ---------------------------------------------------------------- uploads

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('council-upload-test-bytes'),
]);
const postRaw = (base, url, body, headers = {}) =>
  fetch(base + url, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...headers } });

test('upload roundtrip: sniffed, stored 0600 under .botference/uploads, served back, bridge gets the exact Ink attachment schema', async t => {
  const s = await startServer();
  t.after(s.stop);
  const up = await postRaw(s.base, '/upload', PNG);
  assert.equal(up.status, 200);
  const { ok, attachment } = await up.json();
  assert.equal(ok, true);
  assert.match(attachment.url, /^\/uploads\/\d{4}-\d{2}\/[0-9a-f]{16}\.png$/);
  assert.equal(attachment.type, 'image');
  // stored inside the workspace's .botference/uploads/<yyyy-mm>/, mode 0600
  const rel = path.relative(path.join(s.root, '.botference', 'uploads'), attachment.path);
  assert.ok(!rel.startsWith('..') && /^\d{4}-\d{2}\//.test(rel), `stored in uploads tree (got ${rel})`);
  assert.equal(fs.statSync(attachment.path).mode & 0o777, 0o600);
  // served back byte-identical with an image mime
  const got = await fetch(s.base + attachment.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
  // traversal out of the uploads tree stays blocked
  const http = await import('node:http');
  const trav = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/uploads/%2e%2e/council/.auth-secret' },
      r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(trav, 403);
  // /input forwards the attachment to the bridge in the EXACT schema the
  // Ink TUI sends: [{id, path, type:'image'}]
  const inp = await post(s.base, '/input', {
    text: 'what is this?',
    attachments: [{ id: attachment.id, path: attachment.path, type: 'image' }],
  });
  assert.deepEqual(await inp.json(), { ok: true });
  // wait for the bridge to have PROCESSED the input (its echo turn), not
  // just the server-side user_echo which is broadcast before the send
  await sseUntil(s.base, evs => evs.some(e => e.type === 'room' && e.speaker === 'claude'));
  const lines = fs.readFileSync(s.rx, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'what is this?');
  const att = JSON.parse(lines[1].replace(/^ATT /, ''));
  assert.deepEqual(att, [{ id: attachment.id, path: attachment.path, type: 'image' }]);
  assert.deepEqual(Object.keys(att[0]).sort(), ['id', 'path', 'type']);
  // the echo carries display URLs so reloads re-render the thumbnails
  const evs = await sseUntil(s.base, e => e.some(x => x.type === 'user_echo'));
  const echo = evs.find(e => e.type === 'user_echo');
  assert.equal(echo.attachments[0].url, attachment.url);
  // attachment-only message (no text) is allowed
  const only = await post(s.base, '/input', {
    text: '', attachments: [{ id: attachment.id, path: attachment.path, type: 'image' }],
  });
  assert.deepEqual(await only.json(), { ok: true });
});

test('PDF upload roundtrip: sniffed by %PDF magic, typed "file", served as application/pdf, bridge schema keeps the type', async t => {
  const s = await startServer();
  t.after(s.stop);
  const PDF = Buffer.from('%PDF-1.4\ncouncil-pdf-upload-test');
  const up = await postRaw(s.base, '/upload', PDF);
  assert.equal(up.status, 200);
  const { ok, attachment } = await up.json();
  assert.equal(ok, true);
  assert.match(attachment.url, /^\/uploads\/\d{4}-\d{2}\/[0-9a-f]{16}\.pdf$/);
  assert.equal(attachment.type, 'file');
  const got = await fetch(s.base + attachment.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PDF);
  // /input forwards it typed 'file' — and the type is re-derived from the
  // stored file, so a browser claiming 'image' cannot mislabel it
  const inp = await post(s.base, '/input', {
    text: 'read this',
    attachments: [{ id: attachment.id, path: attachment.path, type: 'image' }],
  });
  assert.deepEqual(await inp.json(), { ok: true });
  await sseUntil(s.base, evs => evs.some(e => e.type === 'room' && e.speaker === 'claude'));
  const lines = fs.readFileSync(s.rx, 'utf8').trim().split('\n');
  const att = JSON.parse(lines[1].replace(/^ATT /, ''));
  assert.deepEqual(att, [{ id: attachment.id, path: attachment.path, type: 'file' }]);
});

test('xlsx upload roundtrip: sniffed as a zip with xl/ entries, typed "file", served with the sheet mime', async t => {
  const s = await startServer();
  t.after(s.stop);
  const XLSX = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('xl/workbook.xml council-xlsx-upload-test'),
  ]);
  const up = await postRaw(s.base, '/upload', XLSX);
  assert.equal(up.status, 200);
  const { ok, attachment } = await up.json();
  assert.equal(ok, true);
  assert.match(attachment.url, /\.xlsx$/);
  assert.equal(attachment.type, 'file');
  const got = await fetch(s.base + attachment.url);
  assert.equal(got.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const inp = await post(s.base, '/input', {
    text: 'read this sheet',
    attachments: [{ id: attachment.id, path: attachment.path, type: 'image' }],
  });
  assert.deepEqual(await inp.json(), { ok: true });
  await sseUntil(s.base, evs => evs.some(e => e.type === 'room' && e.speaker === 'claude'));
  const lines = fs.readFileSync(s.rx, 'utf8').trim().split('\n');
  const att = JSON.parse(lines[1].replace(/^ATT /, ''));
  assert.equal(att[0].type, 'file');
});

test('markdown upload: no magic bytes, so the filename (x-filename) names the kind; UTF-8 text is typed "file" and served as text', async t => {
  const s = await startServer();
  t.after(s.stop);
  const MD = Buffer.from('# notes\n\nsome *markdown* for the council\n');
  const up = await postRaw(s.base, '/upload', MD, { 'content-type': 'text/markdown', 'x-filename': encodeURIComponent('My notes.md') });
  const body = await up.json();
  assert.equal(up.status, 200, JSON.stringify(body));
  const { ok, attachment } = body;
  assert.equal(ok, true);
  assert.match(attachment.url, /\.md$/);
  assert.equal(attachment.type, 'file');
  const back = await fetch(s.base + attachment.url);
  assert.match(back.headers.get('content-type'), /^text\/plain/);
  assert.equal(await back.text(), MD.toString());
  // a bare .txt by name alone, no declared type
  const txt = await postRaw(s.base, '/upload', Buffer.from('plain words'), { 'x-filename': 'a.txt' });
  assert.equal(txt.status, 200);
  assert.match((await txt.json()).attachment.url, /\.txt$/);
  // binary junk that CLAIMS to be markdown is refused: text must be honest UTF-8 with no NUL
  const junk = await postRaw(s.base, '/upload', Buffer.from([0x00, 0xff, 0xfe, 0x41]), { 'content-type': 'text/markdown', 'x-filename': 'x.md' });
  assert.equal(junk.status, 400);
  // and unnamed, untyped bytes are still refused as before
  const anon = await postRaw(s.base, '/upload', Buffer.from('hello'));
  assert.equal(anon.status, 400);
});

test('Word uploads: a word/ zip is a docx, an OLE2 with a WordDocument stream is a doc (not an xls)', async t => {
  const s = await startServer();
  try {
    const DOCX = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('word/document.xml council-docx-upload-test'),
    ]);
    const up = await (await postRaw(s.base, '/upload', DOCX)).json();
    assert.equal(up.ok, true);
    assert.match(up.attachment.url, /\.docx$/);
    assert.equal(up.attachment.type, 'file');
    const got = await fetch(s.base + up.attachment.url);
    assert.equal(got.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    // legacy .doc: OLE2 header + the UTF-16LE "WordDocument" stream name
    const DOC = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
      Buffer.from('WordDocument', 'utf16le'),
    ]);
    const up2 = await (await postRaw(s.base, '/upload', DOC)).json();
    assert.equal(up2.ok, true);
    assert.match(up2.attachment.url, /\.doc$/);
    assert.equal(up2.attachment.type, 'file');
  } finally { s.stop(); }
});

test('upload rejects: oversize, non-image bytes, forged attachment paths, too many attachments', async t => {
  const s = await startServer();
  t.after(s.stop);
  // > 10MB -> 413 (and nothing stored)
  const big = Buffer.alloc(11 * 1024 * 1024);
  PNG.copy(big);
  const over = await postRaw(s.base, '/upload', big);
  assert.equal(over.status, 413);
  assert.equal((await over.json()).ok, false);
  // magic-byte sniffing, not extension trust: text is refused
  const txt = await postRaw(s.base, '/upload', Buffer.from('#!/bin/sh\necho pwned'), { 'x-filename': 'x.png' });
  assert.equal(txt.status, 400);
  assert.match((await txt.json()).error, /not an image/);
  // a zip that is neither an xlsx nor a docx (no xl/ or word/ entries) is refused
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('some/archive.txt')]);
  assert.equal((await postRaw(s.base, '/upload', zip)).status, 400);
  assert.ok(!fs.existsSync(path.join(s.root, '.botference', 'uploads'))
    || fs.readdirSync(path.join(s.root, '.botference', 'uploads')).length === 0, 'nothing stored');
  // /input refuses paths outside the uploads tree — the browser cannot make
  // the bridge read arbitrary files
  const forged = await post(s.base, '/input', {
    text: 'hi', attachments: [{ id: 'x', path: '/etc/passwd', type: 'image' }],
  });
  assert.equal(forged.status, 400);
  assert.match((await forged.json()).error, /bad attachments/);
  // max 4 per message
  const up = await (await postRaw(s.base, '/upload', PNG)).json();
  const five = Array(5).fill({ id: up.attachment.id, path: up.attachment.path, type: 'image' });
  const many = await post(s.base, '/input', { text: 'hi', attachments: five });
  assert.equal(many.status, 400);
});

test('hosted mode: /upload and /uploads/ are behind the same gate as everything else', async t => {
  const s = await startServer({ hosted: true });
  t.after(s.stop);
  assert.equal((await postRaw(s.base, '/upload', PNG)).status, 401);
  const auth = await fetch(`${s.base}/auth`, {
    method: 'POST', body: 'password=test-pw&next=%2F', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const up = await postRaw(s.base, '/upload', PNG, { cookie });
  assert.equal(up.status, 200);
  const { attachment } = await up.json();
  assert.equal((await fetch(s.base + attachment.url)).status, 401, 'uploaded image is not public');
  assert.equal((await fetch(s.base + attachment.url, { headers: { cookie } })).status, 200);
});

test('SSE replay ends with an explicit replay_done boundary, after the whole history batch', async t => {
  const s = await startServer();
  t.after(s.stop);
  await post(s.base, '/input', { text: '/status' });
  await sseUntil(s.base, evs => evs.some(e => e.type === 'room' && e.speaker === 'claude'));
  // a FRESH client connecting now gets: hello, history..., replay_done
  const events = await sseUntil(s.base, evs => evs.some(e => e.type === 'replay_done'));
  const iDone = events.findIndex(e => e.type === 'replay_done');
  assert.ok(iDone > 0, 'replay_done arrives');
  assert.ok(events.findIndex(e => e.type === 'user_echo') < iDone, 'history precedes the boundary');
  assert.ok(events.filter(e => e.type === 'replay_done').length === 1);
  assert.equal(typeof events[iDone].count, 'number');
});

// ------------------------------------------------- UI: scroll + cache + copy

// fresh happy-dom app instance with stubbed network + controllable scroll
// geometry (happy-dom does no layout, so the chat pane's metrics are driven
// by the test: content height grows per appended message)
async function mkHarness(t) {
  const { GlobalWindow } = await import('happy-dom');
  const vm = await import('node:vm');
  const w = new GlobalWindow({ url: 'http://localhost/', width: 390, height: 844 });
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
  // inert socket: happy-dom's real WebSocket fails ASYNCHRONOUSLY, which
  // would fire the app's reconnect resetView() mid-test and wipe the DOM.
  // Records attach URLs so tests can assert which chat a reconnect targeted.
  const wsUrls = [];
  w.WebSocket = class { constructor(url) { wsUrls.push(url); } close() { } send() { } };
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'app.js'), 'utf8'), w);
  const C = w.__council;
  const chat = doc.getElementById('chat');
  const transcript = doc.getElementById('transcript');
  // synchronous geometry, like real layout on a scrollHeight read: every
  // transcript child is ~perMsg px tall, plus `extra` for late layout shifts
  const geo = { top: 0, client: 600, perMsg: 200, extra: 0 };
  const height = () => transcript.children.length * geo.perMsg + geo.extra;
  Object.defineProperty(chat, 'scrollHeight', { configurable: true, get: height });
  Object.defineProperty(chat, 'clientHeight', { configurable: true, get: () => geo.client });
  Object.defineProperty(chat, 'scrollTop', {
    configurable: true,
    get: () => geo.top,
    set: v => { geo.top = Math.max(0, Math.min(v, height())); },
  });
  return { w, doc, C, chat, transcript, geo, posts, wsUrls };
}

test('replay lands pinned at the bottom — heuristics suppressed mid-replay, late layout shift re-asserted',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, chat, geo } = await mkHarness(t);
  assert.equal(C.state.inServerReplay, true, 'boots in server-replay mode');
  // history replay: many messages, arriving in bursts with "paints" between
  C.handle({ type: 'hello' });
  for (let i = 0; i < 10; i++) C.handle({ type: 'room', speaker: i % 2 ? 'claude' : 'codex', text: `long replayed message ${i}` });
  // simulate the real-world misfire: between two bursts the viewport/layout
  // shifted and scrollTop is now parked far above the bottom (>90px gap)
  geo.top = 120;
  C.handle({ type: 'room', speaker: 'claude', text: 'next burst' });
  assert.equal(chat.scrollTop, chat.scrollHeight, 'mid-replay append still pins — no scrolled-up misfire');
  // a HISTORICAL ready (replayed from server history) must not end replay mode
  C.handle({ type: 'ready' });
  assert.equal(C.state.inServerReplay, true, 'historical ready does not end the replay');
  geo.top = 120;
  C.handle({ type: 'room', speaker: 'codex', text: 'after historical ready' });
  assert.equal(chat.scrollTop, chat.scrollHeight, 'still pinned after a replayed ready');
  // the server boundary ends the replay: pinned at the very bottom
  C.handle({ type: 'replay_done' });
  assert.equal(C.state.inServerReplay, false);
  assert.equal(chat.scrollTop, chat.scrollHeight, 'replay_done pins to bottom');
  assert.equal(doc.getElementById('jump').hasAttribute('hidden'), true, 'no jump pill after landing');
  // late layout shift (fonts/images settling) after the boundary: the
  // double-rAF settle re-asserts the bottom
  geo.extra += 700;
  await new Promise(r => setTimeout(r, 120)); // let both rAF callbacks run
  assert.equal(chat.scrollTop, chat.scrollHeight, 'late layout shift is re-anchored to the bottom');
  // live streaming afterwards respects a deliberate scroll-up
  geo.top = 100; // user scrolled up
  C.handle({ type: 'room', speaker: 'claude', text: 'live message' });
  assert.equal(chat.scrollTop, 100, 'live events never yank a scrolled-up reader');
  assert.equal(doc.getElementById('jump').hasAttribute('hidden'), false, 'jump pill offers the way down');
});

test('chat switch: reattach to the target bridge, optimistic cached render, offscreen reconcile, never a blank transcript',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, transcript, wsUrls } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  const projects = active => ({
    type: 'projects', active_project_id: 'p1', inbox_session_count: 0,
    projects: [{
      id: 'p1', title: 'P', active: true, session_count: 2,
      sessions: [
        { session_id: 'sidA', title: 'Chat A', updated_at: new Date().toISOString(), active: active === 'sidA' },
        { session_id: 'sidB', title: 'Chat B', updated_at: new Date().toISOString(), active: active === 'sidB' },
      ],
    }],
  });
  C.handle(projects('sidA'));
  assert.equal(C.state.currentSid, 'sidA');
  C.handle({ type: 'user_echo', text: 'hello from A' });
  C.handle({ type: 'room', speaker: 'claude', text: 'A says hi' });
  // switch to B (first visit, no live bridge for it yet): the tab reconnects
  // with ?chat=sidB; the old transcript stays on screen + syncing pill
  C.switchTo('sidB');
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=sidB$/, 'reattaches to the target chat');
  assert.match(transcript.textContent, /hello from A/, 'no blank state while the switch is in flight');
  assert.equal(doc.getElementById('sync').hasAttribute('hidden'), false, 'syncing pill shows');
  // a freshly spawned bridge answers with resuming:true and replays its
  // interstitial startup burst — none of which may blank or paint the pane
  C.handle({ type: 'hello', bridge_id: 'b2', resuming: true });
  C.handle({ type: 'room', speaker: 'system', text: 'Council room ready.' });
  C.handle({ type: 'replay_done', count: 1 });
  assert.match(transcript.textContent, /hello from A/, 'startup replay of a resuming bridge stays offscreen');
  // the live /resume lands: clear_panes must NOT blank the visible pane
  C.handle({ type: 'clear_panes' });
  assert.ok(transcript.children.length > 0, 'clear_panes during a switch keeps content on screen');
  C.handle({ type: 'restore', entries: [{ speaker: 'user', text: 'hello from B' }, { speaker: 'codex', text: 'B replies' }] });
  assert.match(transcript.textContent, /hello from A/, 'replay builds offscreen');
  C.handle(projects('sidB'));
  C.handle({ type: 'ready' });
  assert.match(transcript.textContent, /B replies/, 'ready swaps the fresh transcript in');
  assert.doesNotMatch(transcript.textContent, /hello from A/);
  assert.doesNotMatch(transcript.textContent, /Council room ready/, 'interstitial startup events are dropped');
  assert.equal(doc.getElementById('sync').hasAttribute('hidden'), true);
  // switch BACK to A: instant render from the cache, before any server event
  C.switchTo('sidA');
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=sidA$/);
  assert.match(transcript.textContent, /hello from A/, 'cached transcript paints instantly');
  assert.match(transcript.textContent, /A says hi/);
  assert.ok(C.sessionCache.has('sidB'), 'outgoing chat was snapshotted');
  // A's bridge is still alive: its history replay reconciles at replay_done
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'user_echo', text: 'hello from A' });
  C.handle({ type: 'room', speaker: 'claude', text: 'A says hi' });
  C.handle(projects('sidA'));
  C.handle({ type: 'replay_done', count: 3 });
  assert.match(transcript.textContent, /A says hi/);
  assert.equal(doc.getElementById('sync').hasAttribute('hidden'), true);
  // tapping the already-live chat is a no-op, not a redundant reattach
  const n = wsUrls.length;
  C.switchTo('sidA');
  assert.equal(wsUrls.length, n, 'no reconnect for the active chat');
});

test('sidebar: every project expands and opens its own chats — no "make active project" step',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, wsUrls } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  const now = new Date().toISOString();
  const projects = activePid => ({
    type: 'projects', active_project_id: activePid, inbox_session_count: 2,
    projects: [
      {
        id: 'p1', title: 'Active P', active: activePid === 'p1', session_count: 1,
        sessions: [{ session_id: 'sidA', title: 'Chat A', updated_at: now, active: activePid === 'p1' }],
      },
      {
        // the controller now ships chats for EVERY project, not just the active one
        id: 'p2', title: 'Other P', active: activePid === 'p2', session_count: 2,
        sessions: [
          { session_id: 'sidB', title: 'Chat B', updated_at: now, active: false },
          { session_id: 'sidC', title: 'Chat C', updated_at: now, active: activePid === 'p2' },
        ],
      },
      // archived projects list their chats too — the Archived section is a
      // place to find old work, not a place where it disappears
      {
        id: 'p3', title: 'Done P', status: 'archived', active: false, session_count: 1,
        sessions: [{ session_id: 'sidD', title: 'Chat D', updated_at: now, active: false }],
      },
    ],
  });
  C.handle(projects('p1'));
  const side = doc.getElementById('projects');
  // the activation affordance is gone for good
  assert.equal(side.querySelector('[data-act="activate"]'), null, 'no activate button');
  assert.doesNotMatch(side.textContent, /make active project/);
  // the active project auto-opens; the other is collapsed but fully populated
  assert.ok(side.querySelector('.proj[data-pid="p1"]').classList.contains('open'));
  assert.equal(side.querySelector('.proj[data-pid="p2"]').classList.contains('open'), false);
  assert.match(side.querySelector('.proj[data-pid="p2"]').textContent, /Chat B/);
  assert.match(side.querySelector('.proj[data-pid="p2"]').textContent, /Chat C/);
  // any project header toggles — non-active opens…
  doc.querySelector('.proj[data-pid="p2"] .proj-head').click();
  assert.ok(doc.querySelector('.proj[data-pid="p2"]').classList.contains('open'), 'non-active project expands');
  // …and the active one can be collapsed (auto-open never fights the user)
  doc.querySelector('.proj[data-pid="p1"] .proj-head').click();
  assert.equal(doc.querySelector('.proj[data-pid="p1"]').classList.contains('open'), false, 'active project collapses');
  // per-chat ⋯ menus and the project-level commands survive in every block
  assert.ok(doc.querySelector('.proj[data-pid="p2"] .row-more[data-sid="sidC"]'), 'chat rows keep their ⋯ menu');
  assert.ok(doc.querySelector('.proj[data-pid="p2"] [data-act="proj-archive"]'), 'archive project stays');
  // tapping a chat in the NON-active project just opens it — the tab
  // re-attaches to that chat's bridge, no /resume through this one
  doc.querySelector('.proj[data-pid="p2"] .sess[data-sid="sidC"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=sidC$/, 'opens the chat in its own bridge');
  // the controller confirms: the chat's project is now the active one, and it
  // auto-expands — while the project the user collapsed stays collapsed
  C.state.pendingSwitch = null;
  C.handle(projects('p2'));
  assert.equal(C.state.currentSid, 'sidC');
  assert.ok(doc.querySelector('.proj[data-pid="p2"]').classList.contains('open'));
  assert.equal(doc.querySelector('.proj[data-pid="p1"]').classList.contains('open'), false);
  // the archived project keeps its chats, in the Archived section, collapsed
  doc.querySelector('[data-act="toggle-arch"]').click();
  const arch = doc.querySelector('.arch .proj[data-pid="p3"]');
  assert.ok(arch, 'archived project renders in the Archived section');
  assert.equal(arch.classList.contains('open'), false, 'archived projects start collapsed');
  assert.match(arch.textContent, /Chat D/, 'archived project still lists its chats');
  doc.querySelector('.arch .proj[data-pid="p3"] .proj-head').click();
  assert.ok(doc.querySelector('.arch .proj[data-pid="p3"]').classList.contains('open'), 'and expands on tap');
  doc.querySelector('.arch .proj[data-pid="p3"] .sess[data-sid="sidD"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=sidD$/, 'an archived project s chat opens too');
});

test('links are clickable, text stays selectable, passwords get a copy chip',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  // bot message: URL becomes an anchor; escaping still holds
  C.handle({
    type: 'room', speaker: 'claude',
    text: 'see https://tunnel.trycloudflare.com/x?a=1&b=2. also <script>alert(1)</script>',
  });
  const body = doc.querySelector('.msg.claude .body');
  const a = body.querySelector('a');
  assert.ok(a, 'URL rendered as an anchor');
  assert.equal(a.getAttribute('href'), 'https://tunnel.trycloudflare.com/x?a=1&b=2');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.match(a.getAttribute('rel'), /noopener/);
  assert.equal(body.querySelector('script'), null, 'markup stays escaped');
  assert.match(body.textContent, /<script>alert\(1\)<\/script>/);
  // trailing punctuation is prose, not URL
  assert.doesNotMatch(a.getAttribute('href'), /\.$/);
  // share line: URL is a link, password is a tap-to-copy chip
  C.handle({ type: 'room', speaker: 'system', text: 'share this: https://council.example.com   password: ab12cd34ef' });
  const sys = [...doc.querySelectorAll('.msg.system')].pop();
  assert.ok(sys.querySelector('a[href="https://council.example.com"]'), 'share URL is clickable');
  const chip = sys.querySelector('.copy-chip');
  assert.ok(chip, 'password renders as a copy chip');
  assert.equal(chip.getAttribute('data-copy'), 'ab12cd34ef');
  // tapping the chip copies via the clipboard API
  let copied = null;
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: txt => { copied = txt; return Promise.resolve(); } },
  });
  chip.click();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(copied, 'ab12cd34ef');
  // user echo with attachments renders inline thumbnails
  C.handle({ type: 'user_echo', text: 'look', attachments: [{ id: 'x', path: '/tmp/x.png', type: 'image', url: '/uploads/2026-07/x.png' }] });
  const img = doc.querySelector('.msg.user .att-img');
  assert.ok(img, 'sent message shows the image');
  assert.equal(img.getAttribute('src'), '/uploads/2026-07/x.png');
  // a text file is a named chip, never a broken <img>: kind in capitals and
  // the reader's own filename, linking to the stored file
  C.handle({ type: 'user_echo', text: 'read this', attachments: [{ id: 'y', path: '/tmp/y.md', type: 'file', name: 'My notes.md', url: '/uploads/2026-07/y.md' }] });
  const chips = doc.querySelectorAll('.msg.user .att-doc-link');
  const last = chips[chips.length - 1];
  assert.ok(last, 'sent message shows a file chip');
  assert.equal(last.textContent, 'MD · My notes.md');
  assert.equal(last.getAttribute('href'), '/uploads/2026-07/y.md');
  assert.equal(doc.querySelectorAll('.msg.user .att-img').length, 1, 'the .md did not become an image');
  // nothing in the stylesheet blocks selection on message text (the only
  // user-select:none allowed is the decorative avatar mark), and the
  // transcript explicitly opts into selection for iOS long-press
  const css = fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'style.css'), 'utf8');
  // decorative marks and the per-message button row are the only things
  // allowed to opt out — everything a speaker actually said stays selectable
  for (const m of css.matchAll(/([^{}]+)\{[^{}]*user-select:\s*none[^{}]*\}/g)) {
    assert.match(m[1].trim(), /\.avatar|\.msg-acts/,
      `only avatars and the message action row may block selection: ${m[1].trim()}`);
  }
  assert.match(css, /#transcript\s*\{[^}]*user-select:\s*text/, 'transcript opts into selection');
  // the attach affordance is phone-real: picker that lets iOS offer
  // camera + library + Files (accept includes image/* and PDFs, no
  // capture attr), plus multiple
  const file = doc.getElementById('file');
  assert.equal(file.getAttribute('accept'), 'image/*,application/pdf,.xlsx,.xls,.docx,.doc,.md,.markdown,.txt,.csv,.json,text/markdown,text/plain');
  assert.equal(file.hasAttribute('capture'), false, 'no capture attr — keeps the library option on iOS');
  assert.ok(file.hasAttribute('multiple'));
  assert.ok(doc.getElementById('attach'), 'attach button present');
  assert.match(css, /#input\s*\{[^}]*font:\s*16px/, '16px input font (no iOS zoom-on-focus)');
});

test('markdown "> " lines render as a blockquote draft box with its own copy button',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'room', speaker: 'claude', text: [
    'Suggested reply:',
    '',
    '> Hi Andrew,',
    '> Thanks — £31,450 looks sensible to me.',
    '>',
    '> Best,',
    '> Angadh',
    '',
    'I will check the plan next.',
  ].join('\n') });
  const body = doc.querySelector('.msg.claude .body');
  const bq = body.querySelector('blockquote');
  assert.ok(bq, '"> " lines become a real <blockquote>');
  assert.ok(!bq.textContent.includes('>'), 'no literal angle brackets survive');
  assert.equal(bq.querySelectorAll('p').length, 2, 'a blank "> " splits paragraphs');
  assert.match(bq.querySelectorAll('p')[0].textContent, /Hi Andrew,\nThanks/,
    'quoted line breaks survive inside a paragraph');
  assert.ok(bq.querySelector('.bq-copy'), 'the draft box carries its own copy button');
  assert.ok(!body.textContent.startsWith('>'), 'prose around the quote is untouched');
});

test('markdown tables render as real tables; cells escaped; bare pipes stay prose',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'room', speaker: 'claude', text: [
    'Sign-off sheet:',
    '',
    '| Step | Owner | Status |',
    '| --- | :---: | ---: |',
    '| Schema | Claude | **done** |',
    '| Cutover | <script>x</script> | pending |',
    '',
    'Ping me when signed.',
  ].join('\n') });
  const body = doc.querySelector('.msg.claude .body');
  const table = body.querySelector('.tbl-wrap table');
  assert.ok(table, 'markdown table renders as a real <table>');
  assert.equal(table.querySelectorAll('thead th').length, 3);
  assert.equal(table.querySelectorAll('tbody tr').length, 2);
  assert.match(table.querySelectorAll('thead th')[1].getAttribute('style') || '', /center/);
  assert.match(table.querySelectorAll('thead th')[2].getAttribute('style') || '', /right/);
  assert.ok(table.querySelector('tbody strong'), 'inline formatting works inside cells');
  assert.equal(table.querySelector('script'), null, 'cell markup stays escaped');
  assert.match(table.textContent, /<script>x<\/script>/);
  assert.match(body.textContent, /Sign-off sheet:/);
  assert.match(body.textContent, /Ping me when signed\./);
  // a lone piped line with no delimiter row is prose, not a table
  C.handle({ type: 'room', speaker: 'codex', text: 'either A | B works\nyour call' });
  const cx = [...doc.querySelectorAll('.msg.codex .body')].pop();
  assert.equal(cx.querySelector('table'), null);
  assert.match(cx.textContent, /A \| B/);
});

test('user messages render markdown too — links, bold and lists, same renderer as the bots',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'user_echo', text:
    'Another study by Damon Binder derives a similarly ' +
    '[explosive economic growth rate](https://defensesindepth.bio/2026/growth) from the ' +
    'same **premises**.\n\n- check the elasticity\n- check the [replication](https://example.org/r)' });
  const body = doc.querySelector('.msg.user .body');
  const a = body.querySelector('a');
  assert.ok(a, 'a markdown link in the human turn becomes a real anchor');
  assert.equal(a.getAttribute('href'), 'https://defensesindepth.bio/2026/growth');
  assert.equal(a.textContent, 'explosive economic growth rate');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.match(a.getAttribute('rel'), /noopener/);
  assert.ok(body.querySelector('strong'), '**bold** renders');
  assert.equal(body.querySelectorAll('.md-list li').length, 2, 'the list is a real list');
  assert.equal(body.querySelectorAll('.md-list li a').length, 1, 'links inside list items too');
  assert.doesNotMatch(body.textContent, /\[explosive/, 'no raw markdown left in the text');
  // …and the same for a bot turn: one renderer, one result
  C.handle({ type: 'room', speaker: 'claude', text: 'see [the note](https://example.org/n)' });
  assert.equal(doc.querySelector('.msg.claude .body a').textContent, 'the note');
  // a javascript: url is never linkified
  C.handle({ type: 'room', speaker: 'codex', text: 'careful: [x](javascript:alert(1))' });
  const cx = doc.querySelector('.msg.codex .body');
  assert.equal(cx.querySelector('a'), null);
  assert.match(cx.textContent, /\[x\]\(javascript:alert\(1\)\)/);
  // a root-relative path is a real link (files the council serves itself)…
  C.handle({ type: 'room', speaker: 'claude', text:
    '[Open the final timeline](/files/projects/plan-a-timeline.html)' });
  const msgs = doc.querySelectorAll('.msg.claude .body');
  const rel = msgs[msgs.length - 1].querySelector('a');
  assert.ok(rel, 'root-relative markdown link becomes an anchor');
  assert.equal(rel.getAttribute('href'), '/files/projects/plan-a-timeline.html');
  assert.equal(rel.textContent, 'Open the final timeline');
  // …but a protocol-relative "//host" is cross-origin in disguise: literal
  C.handle({ type: 'room', speaker: 'codex', text: '[x](//evil.example/p)' });
  const cxs = doc.querySelectorAll('.msg.codex .body');
  assert.equal(cxs[cxs.length - 1].querySelector('a'), null);
});

test('room-protocol envelopes never reach the prose — they render as a metadata chip',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  // the reported shape: prose, then the envelope on its own line, then a list
  C.handle({ type: 'room', speaker: 'claude', text: [
    'I read the draft end to end.',
    '',
    '{"status":"continuing","next":"@codex","writer":"@codex","summary":"Checking the draft\'s few high-impact factual claims"}',
    '',
    '- the growth figure traces to [a note](https://example.org/n)',
    '- the survey is stale',
  ].join('\n') });
  const msg = doc.querySelector('.msg.claude');
  const body = msg.querySelector('.body');
  assert.doesNotMatch(body.textContent, /"status"|continuing|@codex/, 'no JSON in the prose');
  assert.match(body.textContent, /I read the draft end to end\./);
  assert.equal(body.querySelectorAll('.md-list li').length, 2, 'the list after the envelope survives');
  assert.ok(body.querySelector('.md-list li a'), 'and keeps its links');
  const env = msg.querySelector('.env-row .env');
  assert.ok(env, 'the envelope renders as its own chip');
  assert.match(env.textContent, /continuing/);
  assert.match(env.textContent, /Checking the draft's few high-impact factual claims/);
  assert.match(env.textContent, /over to @codex/);
  assert.ok(!body.contains(env), 'the chip is metadata, outside the message body');

  // pretty-printed, fenced, at the very end: the fence goes with it
  C.handle({ type: 'room', speaker: 'codex', text: [
    'Agreed on all four.',
    '',
    '```json',
    '{',
    '  "status": "converged",',
    '  "next": "@user",',
    '  "summary": "both of us agree"',
    '}',
    '```',
  ].join('\n') });
  const cx = [...doc.querySelectorAll('.msg.codex')].pop();
  assert.equal(cx.querySelector('.body pre'), null, 'no orphan code block left behind');
  assert.doesNotMatch(cx.querySelector('.body').textContent, /```|status/);
  assert.match(cx.querySelector('.env').textContent, /converged/);
  assert.match(cx.querySelector('.env').textContent, /back to you/);

  // …and at the START of a message, which the old trailing-only strip missed
  C.handle({ type: 'room', speaker: 'claude', text:
    '{"status":"blocked","next":"@user","summary":"need a decision"}\nI cannot go further without you.' });
  const first = [...doc.querySelectorAll('.msg.claude')].pop();
  assert.equal(first.querySelector('.body').textContent.trim(), 'I cannot go further without you.');
  assert.match(first.querySelector('.env').className, /env-blocked/);

  // a half-streamed envelope is hidden while it arrives, never shown mid-JSON
  C.handle({ type: 'stream', kind: 'text_delta', model: 'claude', stream_id: 9, text: 'Done.\n\n{"status":"cont' });
  // drained onto the screen first — the typewriter holds back what has not
  // been revealed yet, and this assertion is about the ENVELOPE being held
  // back, which is a different thing and has to be seen on its own
  for (let i = 0; i < 40 && !/Done/.test(doc.querySelector('.msg.claude.streaming .body').textContent); i++) C.typeDrain();
  const live = doc.querySelector('.msg.claude.streaming .body');
  assert.equal(live.textContent.trim(), 'Done.');
  // JSON that is NOT the room footer stays exactly where the bot put it
  C.handle({ type: 'room', speaker: 'codex', text: 'the API replied {"status":"ok","code":200,"body":null}' });
  assert.match([...doc.querySelectorAll('.msg.codex .body')].pop().textContent, /"code":200/);
});

test('task lists are real checkboxes and the ticks survive a re-render',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  const RECS = 'Recommended fixes:\n\n- [ ] Replace the growth citation\n- [x] Re-pull the dataset\n- [ ] Fix the deflator';
  C.handle({ type: 'room', speaker: 'claude', text: RECS });
  const body = doc.querySelector('.msg.claude .body');
  const boxes = [...body.querySelectorAll('input.md-tick')];
  assert.equal(boxes.length, 3, 'three real checkboxes');
  assert.deepEqual(boxes.map(b => b.checked), [false, true, false], 'source state is honoured');
  assert.ok(body.querySelector('li.md-task.done'), 'a ticked item reads as done');
  assert.ok(body.querySelector('ul.md-tasklist'), 'the list drops its bullets for the ticks');

  // ticking the first one persists it
  boxes[0].checked = true;
  boxes[0].dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.ok(boxes[0].parentNode.classList.contains('done'), 'the item strikes through immediately');
  // the record is the whole state of the message, not just the click
  assert.match(w.localStorage.getItem('council-ticks') || '', /"on":\[0,1\]/);

  // the same message rendered again (a replay, a chat switch back) keeps it
  C.handle({ type: 'clear_panes' });
  C.handle({ type: 'room', speaker: 'claude', text: RECS });
  const again = [...doc.querySelectorAll('.msg.claude .body input.md-tick')];
  assert.deepEqual(again.map(b => b.checked), [true, true, false], 'the tick came back with the message');
  // a DIFFERENT list starts clean — the key is the message, not the ordinal
  C.handle({ type: 'room', speaker: 'codex', text: '- [ ] Something else entirely' });
  assert.equal(doc.querySelector('.msg.codex input.md-tick').checked, false);
});

test('every message carries a copy button that puts rich HTML and plain markdown on the clipboard',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  const written = [];
  w.ClipboardItem = class { constructor(items) { this.items = items; } };
  w.Blob = class { constructor(parts, opts) { this.text = String(parts[0]); this.type = (opts || {}).type; } };
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: { write: items => { written.push(items[0]); return Promise.resolve(); }, writeText: () => Promise.resolve() },
  });
  C.handle({ type: 'room', speaker: 'claude', text:
    'Try [the note](https://example.org/n).\n\n{"status":"continuing","next":"@user","summary":"done"}' });
  const msg = doc.querySelector('.msg.claude');
  const btn = msg.querySelector('.msg-copy');
  assert.ok(btn, 'agent messages get a copy button');
  btn.click();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(written.length, 1, 'one clipboard write');
  const item = written[0].items;
  assert.match(item['text/html'].text, /<a href="https:\/\/example\.org\/n"/, 'HTML flavour keeps the anchor');
  assert.match(item['text/plain'].text, /\[the note\]\(https:\/\/example\.org\/n\)/, 'plain flavour is the markdown');
  assert.doesNotMatch(item['text/plain'].text, /"status"/, 'the protocol footer is not part of the message');
  // the human's own turn is copyable too
  C.handle({ type: 'user_echo', text: 'my **turn**' });
  assert.ok(doc.querySelector('.msg.user .msg-copy'), 'so is the user bubble');
  // no clipboard API at all: the button must not throw
  delete w.ClipboardItem;
  doc.querySelector('.msg.user .msg-copy').click();
  await new Promise(r => setTimeout(r, 5));
});

test('speakers are tellable apart: a colour AND a typeface each, and the user bubble is its own thing',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async () => {
  const css = fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'style.css'), 'utf8');
  assert.match(css, /--font-claude:/);
  assert.match(css, /--font-codex:/);
  assert.match(css, /\.msg\.claude \.body \{[^}]*font-family:\s*var\(--font-claude\)/);
  assert.match(css, /\.msg\.codex \.body \{[^}]*font-family:\s*var\(--font-codex\)/);
  assert.match(css, /\.msg\.user \{[^}]*--author:\s*var\(--you\)/, 'the user bubble has its own accent');
  // every speaker colour is defined in BOTH themes, so neither mode inherits
  // a value picked for the other one
  for (const tok of ['--claude', '--codex', '--you']) {
    const light = css.match(new RegExp(':root\\[data-theme="light"\\][^}]*' + tok + ':'));
    const dark = css.match(new RegExp(':root\\[data-theme="dark"\\][^}]*' + tok + ':'));
    assert.ok(light, `${tok} defined for the light theme`);
    assert.ok(dark, `${tok} defined for the dark theme`);
  }
});

// ------------------------------------------- UI: model switcher + exhaustion

test('agents panel: per-agent model select, rounded gauge, relay provenance, relay buttons',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  // scoped model lists seed the picker; status carries the current per-agent model
  C.handle({ type: 'completion_context', global: ['/status'], scoped: {
    '/model @claude ': ['claude-fable-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
    '/model @codex ': ['gpt-5.6-sol', 'gpt-5.5'],
  } });
  C.handle({ type: 'status', mode: 'public', lead: 'auto', route: '@all', project: 'p',
    claude_pct: 43.21739130434783, codex_pct: 5.4,
    claude_tokens: 86435, claude_window: 200000, codex_tokens: 10800, codex_window: 200000,
    claude_model: 'claude-fable-5', codex_model: 'gpt-5.6-sol',
    claude_last_relay_at: new Date(Date.now() - 12.5 * 60000).toISOString(),
    claude_last_relay_tier: 'self' });
  const cards = doc.getElementById('agent-cards');
  assert.match(cards.textContent, /Claude/);
  assert.match(cards.textContent, /Codex/);
  const claudeSel = cards.querySelector('select.ms-select[data-agent="claude"]');
  assert.ok(claudeSel, 'claude model <select> renders');
  assert.equal(claudeSel.value, 'claude-fable-5', 'current model is preselected');
  assert.equal(claudeSel.querySelectorAll('option').length, 3, 'all scoped claude models offered');

  // gauge + meta: whole percents and compact tokens — no float spew anywhere
  const cc = cards.querySelector('.agent-card[data-agent="claude"]');
  assert.equal(cc.querySelector('.ac-pct').textContent, '43%');
  assert.equal(cc.querySelector('.ac-tok').textContent, '86k / 200k');
  assert.ok(cc.querySelector('.ac-tick'), 'auto-relay threshold tick present');
  // relay provenance ("is its memory fresh?")
  assert.match(cc.querySelector('.ac-fresh').textContent, /memory reset 12m ago · self handoff/);
  const cx = cards.querySelector('.agent-card[data-agent="codex"]');
  assert.match(cx.querySelector('.ac-fresh').textContent, /no relay yet/);
  // ambient top-strip summary is rounded too
  assert.equal(doc.getElementById('st-ctx').textContent, 'C 43% · X 5%');
  // session facts render in the panel
  assert.match(doc.getElementById('ap-facts').textContent, /public/);
  assert.match(doc.getElementById('ap-facts').textContent, /@all/);

  // selecting a model sends the exact bridge command through the input path
  claudeSel.value = 'claude-opus-4-8';
  claudeSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: 'b1', text: '/model @claude claude-opus-4-8', attachments: [] } });

  // per-agent relay and relay-both send plain slash commands
  cards.querySelector('.agent-card[data-agent="codex"] .ac-relay').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: 'b1', text: '/relay @codex', attachments: [] } });
  doc.getElementById('relay-both').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: 'b1', text: '/relay @both', attachments: [] } });
});

test('agents panel: per-agent effort picker, seeded from the scoped levels and the status snapshot',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'completion_context', global: ['/status'], scoped: {
    '/effort @claude ': ['low', 'medium', 'high', 'xhigh'],
    '/effort @codex ': ['minimal', 'low', 'medium', 'high', 'max'],
  } });
  C.handle({ type: 'status', mode: 'public', lead: 'auto', route: '@all', project: 'p',
    claude_model: 'claude-fable-5', codex_model: 'gpt-5.6-sol',
    claude_effort: 'high', codex_effort: 'medium' });
  const cards = doc.getElementById('agent-cards');
  const ce = cards.querySelector('select[data-effort="claude"]');
  assert.ok(ce, 'claude effort <select> renders');
  // asserted through the `selected` attribute, not select.value: happy-dom
  // mis-resolves selectedIndex for a selected option past the second one
  assert.equal(ce.querySelector('option[selected]').value, 'high',
    'the level the bridge reports is preselected');
  assert.deepEqual([...ce.querySelectorAll('option')].map(o => o.value).filter(Boolean),
    ['low', 'medium', 'high', 'xhigh'], 'exactly the levels the controller accepts');
  assert.equal(cards.querySelector('select[data-effort="codex"] option[selected]').value, 'medium');
  // …and picking one sends the plain slash command, like every other control
  ce.value = 'xhigh';
  ce.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: 'b1', text: '/effort @claude xhigh', attachments: [] } });
  // a bridge too old to report effort still offers the levels (fallback list)
  const { doc: d2, C: C2 } = await mkHarness(t);
  C2.handle({ type: 'status', mode: 'public', lead: 'auto', route: '@all', project: 'p' });
  assert.ok(d2.querySelector('select[data-effort="codex"] option[value="max"]'),
    'fallback effort levels without a completion_context');
});

test('credit exhaustion flags the agent (avatar + notice), clears on a normal turn, and warns before send',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'completion_context', global: [], scoped: {
    '/model @claude ': ['claude-fable-5', 'claude-opus-4-8'], '/model @codex ': ['gpt-5.6-sol'],
  } });
  C.handle({ type: 'status', claude_model: 'claude-fable-5', codex_model: 'gpt-5.6-sol' });

  // an exhaustion turn from Claude (observed string) flags it out-of-credits
  C.handle({ type: 'room', speaker: 'claude',
    text: "You've hit your monthly spend limit. Run /usage-credits to manage your limit and keep using Fable 5 or switch models to continue this chat." });
  assert.ok(C.state.exhausted.claude, 'claude flagged exhausted');
  const ring = doc.querySelector('#avatars .avatar-ring.exhausted');
  assert.ok(ring, 'avatar shows the out-of-credits state');
  assert.ok(ring.querySelector('.warn-badge'), 'avatar carries a ⚠ badge');
  const notice = doc.querySelector('.msg.notice.exhaust[data-agent="claude"]');
  assert.ok(notice, 'an inline exhaustion notice appears at the point of use');
  assert.match(notice.textContent, /out of credits/);
  assert.ok(notice.querySelector('select.ms-select[data-agent="claude"]'), 'notice offers a one-tap model switch');
  assert.ok(notice.querySelector('.notice-retry[data-retry="codex"]'), 'notice offers retry with @codex');

  // a subsequent normal turn from Claude clears the flag
  C.handle({ type: 'room', speaker: 'claude', text: 'Here is my normal reply, all good.' });
  assert.equal(C.state.exhausted.claude, null, 'normal output clears the exhausted flag');
  assert.equal(doc.querySelector('#avatars .avatar-ring.exhausted'), null, 'avatar recovers');

  // re-flag, then composing a mention to the flagged agent warns BEFORE sending
  C.handle({ type: 'room', speaker: 'claude', text: 'insufficient credits — out of credits' });
  assert.ok(C.state.exhausted.claude);
  const input = doc.getElementById('input');
  input.value = '@claude please take a look';
  input.dispatchEvent(new w.Event('input'));
  const warn = doc.getElementById('presend-warn');
  assert.equal(warn.hasAttribute('hidden'), false, 'pre-send warning shows for a mention to an exhausted agent');
  assert.match(warn.textContent, /out of credits/);
  // pressing Enter holds the message rather than sending into a void
  const n = posts.length;
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(posts.length, n, 'message is held, not sent');
  assert.equal(input.value, '@claude please take a look', 'the composed text is preserved');
  // the "tag @codex" affordance rewrites the mention; then it sends cleanly
  warn.querySelector('.pw-tag').click();
  assert.match(input.value, /@codex/);
  assert.equal(warn.hasAttribute('hidden'), true, 'warning clears once the mention no longer targets the exhausted agent');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter' }));
  await new Promise(r => setTimeout(r, 5));
  assert.match(posts.pop().body.text, /@codex/, 'retagged message sends to the healthy agent');
});

// ------------------------------------------------ UI: subagent progress lane

test('subagent lane: a Task opens a running row, nested tools tick it, the Task result collapses it to a summary, turn end freezes',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  // a Task/Agent tool_use (carrying agent_label) opens a named, running row
  C.handle({ type: 'stream', kind: 'tool_start', model: 'claude', tool_id: 'ag1', name: 'Task', agent_label: 'research the codebase' });
  const card = doc.querySelector('.msg.lane');
  assert.ok(card, 'a lane card appears inline in the transcript');
  let row = card.querySelector('.lane-row');
  assert.ok(row.classList.contains('running'), 'the row is running');
  assert.ok(row.querySelector('.lane-dot.running'), 'a running status dot');
  assert.match(row.textContent, /research the codebase/, 'the Task description names the row');
  assert.equal(C.state.lanes.ag1.status, 'running');

  // a tool nested under the subagent (parent_tool_use_id === the Task id)
  // updates the row's latest activity and bumps the tool count; a long path
  // is middle-truncated so both ends stay legible
  C.handle({ type: 'stream', kind: 'tool_start', model: 'claude', tool_id: 't1', name: 'Read',
    parent_tool_use_id: 'ag1', input_preview: JSON.stringify({ file_path: '/a/very/long/path/to/some/deeply/nested/module/directory/file.py' }) });
  assert.equal(C.state.lanes.ag1.tools, 1);
  const act = doc.querySelector('.msg.lane .lane-act');
  assert.match(act.textContent, /Read ·/, 'activity shows ToolName · target');
  assert.match(act.textContent, /file\.py/, 'the target tail survives truncation');
  assert.match(act.textContent, /…/, 'the long path is middle-truncated');
  C.handle({ type: 'stream', kind: 'tool_start', model: 'claude', tool_id: 't2', name: 'Grep',
    parent_tool_use_id: 'ag1', input_preview: JSON.stringify({ pattern: 'foo' }) });
  assert.equal(C.state.lanes.ag1.tools, 2);
  // a nested tool_done doesn't close the lane (only the Task's own result does)
  C.handle({ type: 'stream', kind: 'tool_done', model: 'claude', tool_id: 't1', name: 'Read', parent_tool_use_id: 'ag1' });
  assert.equal(C.state.lanes.ag1.status, 'running');

  // the Task's OWN result (tool_id === the lane id) collapses it to a summary
  C.handle({ type: 'stream', kind: 'tool_done', model: 'claude', tool_id: 'ag1', name: 'Task' });
  assert.equal(C.state.lanes.ag1.status, 'done');
  row = doc.querySelector('.msg.lane .lane-row');
  assert.ok(row.classList.contains('done'), 'the row collapses to done');
  assert.ok(row.querySelector('.lane-dot.done'), 'a done status dot');
  assert.match(row.textContent, /2 tools/, 'the summary shows the tool-call count');

  // turn end freezes the lane state and detaches the card; the frozen card
  // stays in the transcript so the past turn still shows what its agent did
  C.handle({ type: 'ready' });
  assert.equal(Object.keys(C.state.lanes).length, 0, 'lane state is cleared for the next turn');
  assert.equal(C.state.laneCard, null, 'the next turn opens a fresh card');
  assert.ok(doc.querySelector('.msg.lane'), 'the frozen lane persists in the transcript');
  assert.equal(C.state.laneTimer, null, 'the elapsed-clock timer is stopped');
});

test('subagent lane: a turn still running at ready freezes its row to done (never a stuck spinner)',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'stream', kind: 'tool_start', model: 'claude', tool_id: 'ag1', name: 'Agent', agent_label: 'draft the plan' });
  assert.equal(C.state.lanes.ag1.status, 'running');
  // the turn ends without a Task result event (interrupt, error): the row is
  // frozen to done rather than left spinning forever
  C.handle({ type: 'ready' });
  const row = doc.querySelector('.msg.lane .lane-row');
  assert.ok(row.classList.contains('done'), 'the row is frozen to done at turn end');
  assert.equal(C.state.laneTimer, null);
});

// -------------------------------------------------- UI: chat id in the URL

test('hash routing: opening/switching a chat writes #/chat/<id>; a hashed link restores it; unknown ids fall back',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, C, wsUrls } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  const projects = active => ({
    type: 'projects', active_project_id: 'p1', inbox_session_count: 0,
    projects: [{
      id: 'p1', title: 'P', active: true, session_count: 2,
      sessions: [
        { session_id: 'sidA', title: 'Chat A', updated_at: new Date().toISOString(), active: active === 'sidA' },
        { session_id: 'sidB', title: 'Chat B', updated_at: new Date().toISOString(), active: active === 'sidB' },
      ],
    }],
  });
  // the open chat is reflected in the URL as soon as it is known
  C.handle(projects('sidA'));
  assert.equal(C.state.currentSid, 'sidA');
  assert.equal(w.location.hash, '#/chat/sidA', 'the open chat is written to the URL');
  // switching writes the target id immediately (before the server reconciles)
  C.switchTo('sidB');
  assert.equal(w.location.hash, '#/chat/sidB', 'switching updates the URL');
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=sidB$/, 'switching reattaches to the target chat');
  // B's bridge answers: attach hello + history replay ending at replay_done
  C.handle({ type: 'hello', bridge_id: 'b2' });
  C.handle(projects('sidB'));
  C.handle({ type: 'replay_done' });
  assert.equal(C.state.currentSid, 'sidB');
  assert.equal(w.location.hash, '#/chat/sidB');

  // a hashchange to a known id (pasted link / back button) navigates to it
  w.location.hash = '#/chat/sidA';
  w.dispatchEvent(new w.Event('hashchange'));
  await new Promise(r => setTimeout(r, 5));
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=sidA$/, 'a known hashed id reattaches to that chat');
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle(projects('sidA'));
  C.handle({ type: 'replay_done' });

  // an unknown id is ASKED OF THE SERVER (the sidebar lists only recent
  // chats, so the client no longer pre-judges): the server refuses with
  // route_error, and the next projects event corrects the URL — without the
  // client re-asking for the refused id (no toast loop)
  const n = wsUrls.length;
  w.location.hash = '#/chat/does-not-exist';
  w.dispatchEvent(new w.Event('hashchange'));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(wsUrls.length, n + 1, 'the unknown id is attempted against the server');
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=does-not-exist$/);
  C.handle({ type: 'route_error', error: 'chat not found' });
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle(projects('sidA'));
  C.handle({ type: 'replay_done' });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(w.location.hash, '#/chat/sidA', 'the URL falls back to the current chat');
  assert.equal(wsUrls.length, n + 1, 'the refused id is not re-asked');
});

test('hash routing: a link opened straight to #/chat/<id> restores that chat once the session list arrives',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, C, wsUrls } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  // the hash is present before any 'projects' event (deep link that raced the
  // boot connect): the attached bridge's chat is sidA, but the URL asks for
  // sidB — the first session list must route to the hashed chat
  w.location.hash = '#/chat/sidB';
  C.handle({
    type: 'projects', active_project_id: 'p1', inbox_session_count: 0,
    projects: [{
      id: 'p1', title: 'P', active: true, session_count: 2,
      sessions: [
        { session_id: 'sidA', title: 'Chat A', updated_at: new Date().toISOString(), active: true },
        { session_id: 'sidB', title: 'Chat B', updated_at: new Date().toISOString(), active: false },
      ],
    }],
  });
  await new Promise(r => setTimeout(r, 5));
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=sidB$/,
    'the hashed chat is attached, not the default-active one');
  assert.equal(w.location.hash, '#/chat/sidB', 'the requested hash is preserved, not overwritten');
});

test('hash routing: a server-side switch (/new, /delete) wins over the stale hash — no snap-back to the old chat',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, wsUrls } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  const projects = sessions => ({
    type: 'projects', active_project_id: 'p1', inbox_session_count: 0,
    projects: [{
      id: 'p1', title: 'P', active: true, session_count: sessions.length,
      sessions: sessions.map(([sid, active]) =>
        ({ session_id: sid, title: sid, updated_at: new Date().toISOString(), active })),
    }],
  });
  C.handle(projects([['sidA', true]]));
  assert.equal(w.location.hash, '#/chat/sidA');

  // the user runs /new: this tab's bridge activates a fresh session while the
  // URL still names the old one — the stale hash must NOT switch back
  const n = wsUrls.length;
  C.handle(projects([['sidA', false], ['sidNEW', true]]));
  assert.equal(wsUrls.length, n, 'the stale hash triggers no reattach back to the old chat');
  assert.equal(C.state.currentSid, 'sidNEW', 'the new chat stays current');
  assert.equal(w.location.hash, '#/chat/sidNEW', 'the URL follows the server-side switch');

  // the user runs /delete on a chat the URL once named: its id vanishing from
  // the list is not a broken deep link — no "chat not found" toast
  w.location.hash = '#/chat/sidNEW';
  C.handle(projects([['sidNEW', false], ['sidNEXT', true]]));
  assert.equal(w.location.hash, '#/chat/sidNEXT');
  const toastEl = doc.getElementById('toast');
  assert.ok(!toastEl || !/chat not found/.test(toastEl.textContent || ''),
    'no not-found toast for a server-side switch');
});

// ------------------------------------------- sidebar: archive / delete / new

test('sidebar chat row: ⋯ opens archive + delete, both send the plain slash command',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, posts, wsUrls } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({
    type: 'projects', active_project_id: 'p1', inbox_session_count: 0,
    projects: [{
      id: 'p1', title: 'P', active: true, status: 'active', session_count: 2,
      sessions: [
        { session_id: 'sidA', title: 'Chat A', updated_at: new Date().toISOString(), active: true },
        { session_id: 'sidB', title: 'Chat B', updated_at: new Date().toISOString(), active: false },
      ],
    }],
  });
  // the menu is closed until asked for — the row stays a plain chat row
  assert.equal(doc.querySelector('.row-menu'), null);
  doc.querySelector('.row-more[data-sid="sidB"]').click();
  const menu = doc.querySelector('.sess-row.menu-open .row-menu');
  assert.ok(menu, 'the ⋯ button opens the row menu');
  assert.equal(doc.querySelectorAll('.row-menu').length, 1, 'only one row menu at a time');

  // archive: one slash command, no client-side confirm (it is reversible)
  menu.querySelector('[data-act="archive"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: null, text: '/archive sidB', attachments: [] } });
  assert.equal(doc.querySelector('.row-menu'), null, 'acting closes the menu');

  // delete: the same path, and the controller's confirm card does the asking
  doc.querySelector('.row-more[data-sid="sidB"]').click();
  doc.querySelector('.row-menu [data-act="delete"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: null, text: '/delete sidB', attachments: [] } });

  // tapping the row itself still opens the chat (re-attach, not a POST)
  doc.querySelector('.sess[data-sid="sidB"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.match(wsUrls[wsUrls.length - 1], /\/ws\?chat=sidB$/, 'row tap reattaches to that chat');
});

test('sidebar projects: archived ones collapse into their own section; archive/unarchive send /project commands',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({
    type: 'projects', active_project_id: 'live', inbox_session_count: 0,
    projects: [
      { id: 'live', title: 'Live project', active: true, status: 'active', session_count: 0, sessions: [] },
      { id: 'old', title: 'Old project', active: false, status: 'archived', session_count: 4, sessions: [] },
    ],
  });
  const side = doc.getElementById('projects');
  // the archived project is present but tucked away: collapsed, out of the
  // active Projects list, and counted
  const arch = side.querySelector('.arch');
  assert.ok(arch, 'archived section exists');
  assert.equal(arch.classList.contains('open'), false, 'collapsed by default');
  assert.match(arch.querySelector('.arch-head').textContent, /Archived\s*1/,
    'the header counts archived projects');
  assert.ok(arch.textContent.includes('Old project'));
  assert.equal(side.querySelector('.proj[data-pid="old"]').closest('.arch'), arch,
    'the archived project renders only inside the archived section');

  // expanding it offers unarchive
  arch.querySelector('.arch-head').click();
  assert.ok(doc.querySelector('.arch.open'), 'the section expands');
  doc.querySelector('[data-act="proj-unarchive"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: null, text: '/project unarchive old', attachments: [] } });

  // and the live project can be archived from its own body
  doc.querySelector('[data-act="proj-archive"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: null, text: '/project archive live', attachments: [] } });
});

test('sidebar New split button: chat starts a chat, project takes a title inline',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  const form = doc.getElementById('new-project-form');
  const title = doc.getElementById('new-project-title');
  assert.equal(form.hasAttribute('hidden'), true, 'the title field stays out of the way');

  doc.getElementById('new-chat').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { bridge: null, text: '/new', attachments: [] } });

  doc.getElementById('new-project').click();
  assert.equal(form.hasAttribute('hidden'), false, 'the title field opens');
  title.value = '  Spaceship Engineering  ';
  title.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(),
    { url: '/input', body: { bridge: null, text: '/project create Spaceship Engineering', attachments: [] } });
  assert.equal(form.hasAttribute('hidden'), true, 'the field closes after submitting');

  // Escape backs out without sending anything
  doc.getElementById('new-project').click();
  title.value = 'nope';
  const n = posts.length;
  title.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(form.hasAttribute('hidden'), true);
  assert.equal(posts.length, n, 'nothing sent on escape');
});

test('/files serves workspace artifacts auth-gated, refuses dot-segments and traversal', async () => {
  const s = await startServer();
  try {
    fs.mkdirSync(path.join(s.root, 'projects', 'demo', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'projects', 'demo', 'artifacts', 'plot.html'), '<h1>plot</h1>');
    fs.mkdirSync(path.join(s.root, '.botference'), { recursive: true });
    fs.writeFileSync(path.join(s.root, '.botference', 'secret.txt'), 'nope');

    const ok = await fetch(`${s.base}/files/projects/demo/artifacts/plot.html`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/html/);
    assert.equal(await ok.text(), '<h1>plot</h1>');

    // hidden dirs (secrets, .git) are never reachable
    assert.equal((await fetch(`${s.base}/files/.botference/secret.txt`)).status, 403);
    // encoded traversal cannot escape the workspace root (fetch normalizes
    // the path before sending, so this arrives as a non-/files route — either
    // way nothing outside the root may ever be served)
    fs.writeFileSync(path.join(s.root, '..', 'council-outside.txt'), 'outside');
    const trav = await fetch(`${s.base}/files/%2e%2e/council-outside.txt`);
    assert.notEqual(trav.status, 200, 'traversal must not serve content');
    fs.rmSync(path.join(s.root, '..', 'council-outside.txt'), { force: true });
    // missing files are a plain 404
    assert.equal((await fetch(`${s.base}/files/projects/none.html`)).status, 404);
  } finally { s.stop(); }
});

test('/files requires auth on a hosted server', async () => {
  const s = await startServer({ hosted: true });
  try {
    fs.writeFileSync(path.join(s.root, 'note.md'), 'private');
    const r = await fetch(`${s.base}/files/note.md`, { redirect: 'manual' });
    assert.notEqual(r.status, 200, 'unauthenticated /files must not serve content');
  } finally { s.stop(); }
});

// ------------------------------------------------------- billing (API keys)
// Per-agent auth for the CLIs the bridges spawn: the modes are this server's
// own (workspace state), the KEYS are the ones Discuss stores (one paste, both
// products). What a mode DOES is only ever visible in the environment a bridge
// child was handed, so that is what these assert — the fake bridge appends the
// auth variables it was given to <rx>.env, one JSON object per spawn.
//
// Every key here is an obvious fixture; startServer strips the real ones out
// of the environment it passes on, and points BOTFERENCE_SECRETS_DIR at a
// throwaway directory, so no real credential is ever read, written or logged.
const CLAUDE_KEY = 'sk-ant-api-TEST';
const CODEX_KEY = 'sk-openai-TEST';
const PROXY = { 'x-forwarded-for': '203.0.113.9' };   // what a tunnel stamps

// Attach a tab to a chat nothing is driving yet: that spawns a NEW bridge,
// which is the only moment a billing change can take effect. Returns the auth
// environment that child was handed.
async function newBridgeEnv(s, sid) {
  const { wsConnect } = await import('./fixtures/ws-client.mjs');
  const before = s.spawnEnvs().length;
  const c = await wsConnect({ host: '127.0.0.1', port: s.port, path: `/ws?chat=${sid}` });
  try {
    await c.next(e => e.type === 'hello');
    const deadline = Date.now() + 5000;
    while (s.spawnEnvs().length <= before) {
      if (Date.now() > deadline) throw new Error('no new bridge env recorded');
      await new Promise(r => setTimeout(r, 25));
    }
  } finally { c.close(); }
  return s.spawnEnvs()[before];
}

test('billing: a fresh council holds no key, defaults both agents to auto, and reports the codex asymmetry', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`${s.base}/keys`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.claude, 'unset');
    assert.equal(j.codex, 'unset');
    assert.deepEqual(j.modes, { claude: 'auto', codex: 'auto' });
    // documented, never enforced: claude's env key beats its login, codex's
    // stored ChatGPT login beats the env key (forcing it would mean
    // `codex login --with-api-key`, which is the user's call)
    assert.deepEqual(j.overrides_login, { claude: true, codex: false });
    assert.equal(j.local, true, 'a direct loopback request is the local machine');
    // the boot bridge got no auth variables at all — not even an empty one
    const first = s.spawnEnvs()[0];
    assert.deepEqual(first, {}, 'auto with no stored key hands the bridge nothing');
  } finally { s.stop(); }
});

test('billing: a stored key reaches the next bridge and is never handed back — 0600 storage, "set" is all the API says', async () => {
  const s = await startServer();
  try {
    const w = await post(s.base, '/keys', { agent: 'claude', key: CLAUDE_KEY });
    assert.equal(w.status, 200);
    const body = await w.text();
    assert.ok(!body.includes(CLAUDE_KEY), 'the response never echoes the key back');
    assert.match(body, /"claude":"set"/);
    // a billing change retires idle bridges on the spot (their chats resume
    // on the next turn), so the answer is 'now' unless one is mid-turn
    assert.equal(JSON.parse(body).applies, 'now');

    const st = await (await fetch(`${s.base}/keys`)).json();
    assert.equal(st.claude, 'set');
    assert.equal(st.codex, 'unset');
    assert.ok(!JSON.stringify(st).includes(CLAUDE_KEY), 'status carries no key material');

    // stored on disk, readable by nobody else
    assert.equal(fs.statSync(s.keysFile).mode & 0o777, 0o600);

    // auto + a stored key: the next bridge bills the key
    const env = await newBridgeEnv(s, 'keysid01');
    assert.deepEqual(env, { ANTHROPIC_API_KEY: CLAUDE_KEY },
      'the key, and nothing else that could answer the same question');
  } finally { s.stop(); }
});

test('billing: a pasted key is stripped of invisible freight, and a double-paste is refused', async () => {
  const s = await startServer();
  try {
    // zero-width space + BOM + a line wrap — what a copy off a web console
    // actually delivers ("Invalid X-Api-Key header value … U+200B at
    // character 12" is the API error this prevents)
    const dirty = ` ${CLAUDE_KEY.slice(0, 12)}​${CLAUDE_KEY.slice(12)}﻿\n`;
    const w = await post(s.base, '/keys', { agent: 'claude', key: dirty });
    assert.equal(w.status, 200);
    const env = await newBridgeEnv(s, 'cleanpaste1');
    assert.deepEqual(env, { ANTHROPIC_API_KEY: CLAUDE_KEY },
      'the bridge gets the clean key, not the paste');

    // the same key pasted twice concatenates into one long string — refused
    const twice = await post(s.base, '/keys', { agent: 'claude', key: CLAUDE_KEY + CLAUDE_KEY });
    assert.equal(twice.status, 400);
    assert.match(await twice.text(), /two keys/);
  } finally { s.stop(); }
});

test('billing: subscription mode wins over a key AND over what the server itself inherited', async () => {
  // the server is started the way a LaunchAgent or a login shell would start
  // it — with auth variables already in its environment
  const s = await startServer({
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-api-TEST-INHERITED',
      ANTHROPIC_AUTH_TOKEN: 'TEST-INHERITED-TOKEN',
      CLAUDE_CODE_USE_BEDROCK: '1',
      OPENAI_API_KEY: 'sk-openai-TEST-INHERITED',
      CODEX_API_KEY: 'sk-codex-TEST-INHERITED',
    },
  });
  try {
    // auto, nothing stored: an inherited key is not an answer the user chose
    assert.deepEqual(s.spawnEnvs()[0], {},
      'auto with no stored key deletes the inherited key and its siblings');

    // store both keys, then put both agents on the subscription
    await post(s.base, '/keys', { agent: 'claude', key: CLAUDE_KEY });
    await post(s.base, '/keys', { agent: 'codex', key: CODEX_KEY });
    for (const agent of ['claude', 'codex']) {
      const r = await post(s.base, '/key-mode', { agent, mode: 'subscription' });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.modes[agent], 'subscription');
      assert.ok(!JSON.stringify(j).includes(CLAUDE_KEY) && !JSON.stringify(j).includes(CODEX_KEY));
    }
    const env = await newBridgeEnv(s, 'subsid01');
    assert.deepEqual(env, {},
      'subscription clears the key and every sibling — absent, never empty');
    // the mode is the council's own state, not the shared secrets file
    assert.deepEqual(JSON.parse(fs.readFileSync(s.modesFile, 'utf8')).modes,
      { claude: 'subscription', codex: 'subscription' });
    assert.ok(!fs.readFileSync(s.modesFile, 'utf8').includes(CLAUDE_KEY),
      'no key material in the mode file');
  } finally { s.stop(); }
});

test('billing: "key" mode with nothing stored is refused; codex mode "key" hands the key over without forcing a login', async () => {
  const s = await startServer();
  try {
    const bad = await post(s.base, '/key-mode', { agent: 'claude', mode: 'key' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /no claude key saved/);
    assert.equal((await (await fetch(`${s.base}/keys`)).json()).modes.claude, 'auto',
      'the refused switch left the mode alone');
    // an unknown agent or mode is refused the same way
    assert.equal((await post(s.base, '/key-mode', { agent: 'gemini', mode: 'auto' })).status, 400);
    assert.equal((await post(s.base, '/key-mode', { agent: 'claude', mode: 'always' })).status, 400);
    assert.equal((await post(s.base, '/keys', { agent: 'claude', key: '   ' })).status, 400);

    await post(s.base, '/keys', { agent: 'codex', key: CODEX_KEY });
    assert.equal((await post(s.base, '/key-mode', { agent: 'codex', mode: 'key' })).status, 200);
    const env = await newBridgeEnv(s, 'codexsid1');
    // OPENAI_API_KEY is offered and CODEX_* siblings are cleared; nothing here
    // ever writes forced_login_method or runs `codex login` — a stored ChatGPT
    // login still wins, which is why the UI calls the key a fallback
    assert.deepEqual(env, { OPENAI_API_KEY: CODEX_KEY });
  } finally { s.stop(); }
});

test('billing: removing a key unsets it and releases a mode stranded on "key"', async () => {
  const s = await startServer();
  try {
    await post(s.base, '/keys', { agent: 'claude', key: CLAUDE_KEY });
    await post(s.base, '/key-mode', { agent: 'claude', mode: 'key' });
    const r = await post(s.base, '/keys/remove', { agent: 'claude' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.removed, true);
    assert.equal(j.claude, 'unset');
    assert.equal(j.modes.claude, 'auto', '"key" with no key would be a lie — back to auto');
    // the key really left the file, and a second removal is honest about it
    assert.ok(!fs.readFileSync(s.keysFile, 'utf8').includes(CLAUDE_KEY));
    assert.equal((await (await post(s.base, '/keys/remove', { agent: 'claude' })).json()).removed, false);
    assert.deepEqual(await newBridgeEnv(s, 'gonesid01'), {});
  } finally { s.stop(); }
});

test('billing: flipping a switch retires idle bridges — the next turn already bills the new mode', async () => {
  const s = await startServer({ env: { ANTHROPIC_API_KEY: 'sk-ant-api-INHERITED' } });
  try {
    await post(s.base, '/keys', { agent: 'claude', key: CLAUDE_KEY });
    await post(s.base, '/key-mode', { agent: 'claude', mode: 'key' });
    const env1 = await newBridgeEnv(s, 'retire001');
    assert.equal(env1.ANTHROPIC_API_KEY, CLAUDE_KEY);
    // the key "wears out"; the reader flips to subscription — no remove, no
    // restart, no new tab. The bridge may still be mid-boot (busy) for a
    // moment, so retry the flip until it lands on an idle bridge.
    let r = null;
    const deadline = Date.now() + 5000;
    do {
      r = await (await post(s.base, '/key-mode', { agent: 'claude', mode: 'subscription' })).json();
      if (r.applies === 'now') break;
      await new Promise(x => setTimeout(x, 50));
    } while (Date.now() < deadline);
    assert.equal(r.applies, 'now', 'the idle bridge was retired by the flip');
    const env2 = await newBridgeEnv(s, 'retire001');
    assert.equal(env2.ANTHROPIC_API_KEY, undefined,
      'the respawned bridge bills the subscription — the dead key is gone');
  } finally { s.stop(); }
});

test('billing: keys never cross the tunnel — a proxied write is refused, the switch and the status are not', async () => {
  const s = await startServer();
  try {
    for (const url of ['/keys', '/keys/remove']) {
      const r = await post(s.base, url, { agent: 'claude', key: CLAUDE_KEY }, PROXY);
      assert.equal(r.status, 403, `${url} refuses a forwarded request`);
      assert.match((await r.json()).error, /can only be set from the machine/);
    }
    assert.equal((await (await fetch(`${s.base}/keys`)).json()).claude, 'unset',
      'the refused write stored nothing');
    // status still answers a remote reader — and tells the UI to hide the
    // fields and say where keys can be added instead
    const remote = await fetch(`${s.base}/keys`, { headers: PROXY });
    assert.equal(remote.status, 200);
    assert.equal((await remote.json()).local, false);
    // a MODE is a preference, not a secret: switchable from the phone
    const m = await post(s.base, '/key-mode', { agent: 'claude', mode: 'subscription' }, PROXY);
    assert.equal(m.status, 200);
    assert.equal((await m.json()).modes.claude, 'subscription');
  } finally { s.stop(); }
});

test('billing: keys are gated like everything else on a hosted server', async () => {
  const s = await startServer({ hosted: true });
  try {
    assert.equal((await fetch(`${s.base}/keys`)).status, 401);
    const w = await post(s.base, '/keys', { agent: 'claude', key: CLAUDE_KEY });
    assert.equal(w.status, 401);
    const auth = { authorization: 'Basic ' + Buffer.from('x:test-pw').toString('base64') };
    assert.equal((await fetch(`${s.base}/keys`, { headers: auth })).status, 200);
  } finally { s.stop(); }
});

test('composer @-menu: typing @cl mid-sentence offers @claude with its mark; accepting splices the handle in',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc } = await mkHarness(t);
  const input = doc.getElementById('input');
  const menu = doc.getElementById('complete');

  const typeTo = (text, caret = text.length) => {
    input.value = text;
    input.selectionStart = input.selectionEnd = caret;
    input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  };

  // mid-sentence fragment opens the menu with agent rows
  typeTo('route the spreadsheet work to @cl');
  assert.equal(menu.hidden, false, 'the menu opened mid-sentence');
  const row = menu.querySelector('.opt.mention');
  assert.ok(row, 'mention rows, not command completions');
  assert.match(row.textContent, /@claude/);
  assert.ok(row.querySelector('.avatar'), 'the agent wears its logomark');

  // accepting splices just the handle — the sentence survives
  row.dispatchEvent(new doc.defaultView.Event('mousedown', { bubbles: true }));
  assert.equal(input.value, 'route the spreadsheet work to @claude ');

  // a literal @ in prose is left alone (no start-of-word trigger)
  typeTo('mail me at angadh@qmul');
  assert.equal(menu.hidden, true, 'user@host never opens the menu');

  // bare @ offers the whole roster
  typeTo('hand this over: @');
  assert.equal(menu.querySelectorAll('.opt.mention').length, 3, '@claude, @codex, @all');
});

test('billing panel: per-agent switch, key fields only on the local machine, honest about when it applies',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, posts } = await mkHarness(t);
  const panel = doc.getElementById('billing');
  assert.ok(panel, 'the agents panel has a billing section');

  // on the machine the server runs on: the switch AND the key fields
  C.setKeyInfo({
    ok: true, claude: 'set', codex: 'unset',
    modes: { claude: 'auto', codex: 'auto' },
    overrides_login: { claude: true, codex: false }, local: true,
  });
  const claude = panel.querySelector('.bill-row[data-agent="claude"]');
  assert.match(claude.textContent, /key saved/);
  assert.match(claude.querySelector('.bill-eff').textContent, /bills the API key/,
    'auto with a saved key resolves to the key — the same rule Claude Code uses');
  assert.equal(claude.querySelector('[data-bill="claude"][data-mode="auto"]').getAttribute('aria-pressed'), 'true');
  assert.ok(claude.querySelector('input[data-key="claude"]'), 'a key field, because this is the local machine');
  assert.ok(claude.querySelector('[data-rm="claude"]'), 'a saved key can be removed');

  const codex = panel.querySelector('.bill-row[data-agent="codex"]');
  assert.match(codex.querySelector('.bill-eff').textContent, /bills the subscription/);
  assert.ok(codex.querySelector('[data-bill="codex"][data-mode="key"]').hasAttribute('disabled'),
    'no key saved, so "API key" is not a position you can pick');
  assert.ok(!codex.querySelector('[data-rm="codex"]'), 'nothing to remove');
  assert.match(panel.textContent, /Applies to agents started from now on/,
    'the panel says a running chat keeps the billing it started with');

  // switching mode posts the preference; typing a key posts it once and does
  // not leave it sitting in the DOM
  posts.length = 0;
  claude.querySelector('[data-bill="claude"][data-mode="subscription"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts[0], { url: '/key-mode', body: { agent: 'claude', mode: 'subscription' } });
  const input = panel.querySelector('input[data-key="claude"]');
  input.value = 'sk-ant-api-TEST';
  panel.querySelector('[data-save="claude"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts[1], { url: '/keys', body: { agent: 'claude', key: 'sk-ant-api-TEST' } });
  assert.equal(input.value, '', 'the field is cleared the moment it is sent');

  // codex asymmetry, said out loud where it applies
  C.setKeyInfo({
    ok: true, claude: 'unset', codex: 'set',
    modes: { claude: 'auto', codex: 'key' },
    overrides_login: { claude: true, codex: false }, local: true,
  });
  assert.match(panel.querySelector('.bill-row[data-agent="codex"] .bill-caveat').textContent,
    /only falls back to the key when it is not logged in/);

  // through the tunnel: the switch still works, the key fields are gone, and
  // the panel says where a key can be added instead
  C.setKeyInfo({
    ok: true, claude: 'set', codex: 'unset',
    modes: { claude: 'auto', codex: 'auto' },
    overrides_login: { claude: true, codex: false }, local: false,
  });
  assert.equal(panel.querySelectorAll('input[data-key]').length, 0, 'no key field over the tunnel');
  assert.ok(panel.querySelector('[data-bill="claude"]'), 'the mode switch is still there');
  assert.match(panel.textContent, /Add keys from the Mac the server runs on/);
});

// ------------------------------------------------------------- tasks panel

const TASKS_V1 = 'Plan:\n\n- [ ] Pull the dataset\n- [ ] Rebuild the deflator\n- [ ] Redraw figure 3';
const TASKS_V2 = 'Revised plan:\n\n- [x] Pull the dataset\n- [ ] Rebuild the deflator\n- [ ] Redraw figure 3\n- [ ] Re-run the regression';
const panelItems = doc => [...doc.querySelectorAll('#tasks-body li.md-task .md-tasktext')]
  .map(s => s.textContent.trim());

test('tasks panel: the newest checklist in the room, replaced in place when the bots revise it',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  const sec = doc.getElementById('tasks-sec');
  assert.equal(sec.hasAttribute('hidden'), true, 'no list in the chat: no section');
  // caught once by looking at a screenshot: the section's own `display: flex`
  // outranks the UA's [hidden] rule, so "hidden" rendered as an empty box
  assert.match(fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'style.css'), 'utf8'),
    /#tasks-sec\[hidden\][^{]*\{[^}]*display:\s*none/,
    'hidden must actually be invisible — [hidden] needs an explicit display:none here');

  C.handle({ type: 'room', speaker: 'claude', text: TASKS_V1 });
  assert.equal(sec.hasAttribute('hidden'), false, 'a checklist raises the panel');
  assert.deepEqual(panelItems(doc), ['Pull the dataset', 'Rebuild the deflator', 'Redraw figure 3']);
  assert.match(doc.getElementById('tasks-meta').textContent, /from claude/);
  assert.match(doc.getElementById('tasks-meta').textContent, /0\/3 done/);

  // prose in between must not disturb it
  C.handle({ type: 'room', speaker: 'codex', text: 'Agreed, starting on the deflator.' });
  assert.deepEqual(panelItems(doc), ['Pull the dataset', 'Rebuild the deflator', 'Redraw figure 3']);

  // the revision REPLACES: one list in the panel, never two
  C.handle({ type: 'room', speaker: 'codex', text: TASKS_V2 });
  assert.equal(doc.querySelectorAll('#tasks-body ul.md-tasklist').length, 1, 'no duplicate list');
  assert.deepEqual(panelItems(doc),
    ['Pull the dataset', 'Rebuild the deflator', 'Redraw figure 3', 'Re-run the regression']);
  assert.match(doc.getElementById('tasks-meta').textContent, /from codex · 1\/4 done/,
    'the [x] the bot baked in counts as done, and the author changed');
  assert.equal(C.taskSrc(), doc.querySelectorAll('.msg.codex')[1], 'the newest list is the source');

  // the panel is the same tick state as the message, not a copy of the text
  const panelBoxes = [...doc.querySelectorAll('#tasks-body input.md-tick')];
  assert.deepEqual(panelBoxes.map(b => b.checked), [true, false, false, false]);
});

test('tasks panel: ticking anywhere ticks everywhere — one store, panel and transcript',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'room', speaker: 'claude', text: TASKS_V1 });
  const msgBoxes = () => [...doc.querySelectorAll('.msg.claude .body input.md-tick')];
  const panelBoxes = () => [...doc.querySelectorAll('#tasks-body input.md-tick')];

  // tick in the PANEL: the transcript's copy follows, and it is written down
  const p = panelBoxes()[1];
  p.checked = true;
  p.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.deepEqual(msgBoxes().map(b => b.checked), [false, true, false],
    'the message in the transcript is ticked too');
  assert.ok(msgBoxes()[1].parentNode.classList.contains('done'), 'and strikes through');
  assert.match(doc.getElementById('tasks-meta').textContent, /1\/3 done/);
  assert.match(w.localStorage.getItem('council-ticks') || '', /"on":\[1\]/);

  // tick in the TRANSCRIPT: the panel follows
  const m = msgBoxes()[2];
  m.checked = true;
  m.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.deepEqual(panelBoxes().map(b => b.checked), [false, true, true]);
  assert.match(doc.getElementById('tasks-meta').textContent, /2\/3 done/);

  // and it is the SAME store the transcript already used: a replay of the same
  // message brings both back ticked
  C.handle({ type: 'clear_panes' });
  assert.equal(doc.getElementById('tasks-sec').hasAttribute('hidden'), true,
    'a cleared transcript empties the panel — it never shows a list that is gone');
  C.handle({ type: 'restore', entries: [{ speaker: 'claude', text: TASKS_V1 }] });
  assert.deepEqual(msgBoxes().map(b => b.checked), [false, true, true], 'ticks survive the replay');
  assert.deepEqual(panelBoxes().map(b => b.checked), [false, true, true], 'in the panel as well');
});

test('tasks panel: per chat — a chat with no list has no section, and switching back restores it',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  const sec = doc.getElementById('tasks-sec');
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done' });
  const projects = active => ({
    type: 'projects', active_project_id: 'p1', inbox_session_count: 0,
    projects: [{
      id: 'p1', title: 'P', active: true, session_count: 2,
      sessions: [
        { session_id: 'sidA', title: 'A', updated_at: new Date().toISOString(), active: active === 'sidA' },
        { session_id: 'sidB', title: 'B', updated_at: new Date().toISOString(), active: active === 'sidB' },
      ],
    }],
  });
  C.handle(projects('sidA'));
  C.handle({ type: 'room', speaker: 'claude', text: TASKS_V1 });
  assert.equal(sec.hasAttribute('hidden'), false);

  // switch to B, which has no checklist at all
  C.switchTo('sidB');
  C.handle({ type: 'hello', bridge_id: 'b2', resuming: true });
  C.handle({ type: 'replay_done', count: 0 });
  C.handle({ type: 'clear_panes' });
  C.handle({ type: 'restore', entries: [{ speaker: 'user', text: 'no lists here' }] });
  C.handle(projects('sidB'));
  C.handle({ type: 'ready' });
  assert.match(doc.getElementById('transcript').textContent, /no lists here/);
  assert.equal(sec.hasAttribute('hidden'), true, 'B has no list: the section is gone, not stale');
  assert.equal(doc.getElementById('tasks-body').textContent, '');

  // back to A: the cached paint alone restores the panel, before any event
  C.switchTo('sidA');
  assert.equal(sec.hasAttribute('hidden'), false, 'A brings its own list back');
  assert.deepEqual(panelItems(doc), ['Pull the dataset', 'Rebuild the deflator', 'Redraw figure 3']);
});

test('tasks panel: the source control brings the message that holds the list into view',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'room', speaker: 'claude', text: TASKS_V1 });
  for (let i = 0; i < 8; i++) C.handle({ type: 'room', speaker: 'codex', text: `filler ${i}` });
  const src = doc.querySelector('.msg.claude');
  const seen = [];
  src.scrollIntoView = opts => seen.push(opts);
  doc.getElementById('tasks-jump').click();
  assert.equal(seen.length, 1, 'the source message is scrolled to');
  assert.equal(seen[0].block, 'start', 'top-aligned, so the whole list reads');
  assert.ok(src.classList.contains('task-src'), 'and marked, so the eye finds it');
});

test('tasks panel: collapsing it is remembered',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle({ type: 'room', speaker: 'claude', text: TASKS_V1 });
  const fold = doc.getElementById('tasks-fold');
  assert.equal(fold.getAttribute('aria-expanded'), 'true');
  fold.click();
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.getElementById('tasks-body').hasAttribute('hidden'), true);
  assert.equal(w.localStorage.getItem('council-tasks-fold'), 'closed');
  // a later list respects the choice instead of springing open
  C.handle({ type: 'room', speaker: 'codex', text: TASKS_V2 });
  assert.equal(doc.getElementById('tasks-body').hasAttribute('hidden'), true);
  assert.equal(doc.getElementById('tasks-sec').hasAttribute('hidden'), false, 'the section itself stays');
});

// ------------------------------------------- project tasks panel (TASKS.md)

// The other kind of list: a file in the project that outlives every chat in
// it. The controller parses projects/<id>/TASKS.md and ships it on the
// `projects` event; the panel only paints it, read-only.

const PT = (tasks, extra = {}) => ({
  type: 'projects', active_project_id: 'p1', inbox_session_count: 0,
  inbox_sessions: [],
  projects: [
    { id: 'p1', title: 'Demo project', active: true, session_count: 0,
      sessions: [], ...(tasks === null ? {} : { tasks }), ...extra },
    { id: 'p2', title: 'Other project', active: false, session_count: 0,
      sessions: [], tasks: [{ text: 'Not this one', done: false }] },
  ],
});
const pItems = doc => [...doc.querySelectorAll('#ptasks-body li.md-task .md-tasktext')]
  .map(s => s.textContent.trim());

test('project tasks: the active project\'s TASKS.md, and only the active one\'s',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  const sec = doc.getElementById('ptasks-sec');
  assert.equal(sec.hasAttribute('hidden'), true, 'no projects event yet: no section');
  // same trap as #tasks-sec: display:flex outranks the UA's [hidden] rule
  assert.match(fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'style.css'), 'utf8'),
    /#ptasks-sec\[hidden\][^{]*\{[^}]*display:\s*none/,
    'hidden must actually be invisible');

  C.handle(PT([
    { text: 'Pull the dataset', done: true },
    { text: 'Rebuild the deflator', done: false },
    { text: 'Redraw figure 3', done: false },
  ]));
  assert.equal(sec.hasAttribute('hidden'), false, 'a project list raises the section');
  assert.deepEqual(pItems(doc),
    ['Pull the dataset', 'Rebuild the deflator', 'Redraw figure 3']);
  assert.ok(!pItems(doc).includes('Not this one'), 'another project\'s list stays out');
  assert.match(doc.getElementById('ptasks-meta').textContent,
    /Demo project · 1\/3 done · TASKS\.md · read-only/);
  const boxes = [...doc.querySelectorAll('#ptasks-body input.md-tick')];
  assert.deepEqual(boxes.map(b => b.checked), [true, false, false]);
  assert.ok(boxes.every(b => b.disabled), 'the panel does not own that file');
  assert.equal(doc.querySelector('#ptasks-body li.md-task').classList.contains('done'), true);
});

test('project tasks: a project with no list has no section, and losing it puts it away',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle(PT([{ text: 'Ship it', done: false }]));
  assert.equal(doc.getElementById('ptasks-sec').hasAttribute('hidden'), false);
  // the key is omitted entirely for a project that keeps no list
  C.handle(PT(null));
  assert.equal(doc.getElementById('ptasks-sec').hasAttribute('hidden'), true);
  assert.deepEqual(pItems(doc), []);
  // and an empty array is the same thing
  C.handle(PT([{ text: 'Back again', done: false }]));
  C.handle(PT([]));
  assert.equal(doc.getElementById('ptasks-sec').hasAttribute('hidden'), true);
});

test('project tasks: bot-written junk is dropped, never painted',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  C.handle(PT([
    null,
    'a bare string',
    { done: true },
    { text: '   ' },
    { text: 'The only real one' },
    { text: '<img src=x onerror=alert(1)>', done: 'yes' },
  ]));
  assert.deepEqual(pItems(doc), ['The only real one', '<img src=x onerror=alert(1)>']);
  assert.equal(doc.querySelectorAll('#ptasks-body img').length, 0, 'text, not markup');
  // `done: 'yes'` is truthy, and that is all the panel claims to know
  assert.match(doc.getElementById('ptasks-meta').textContent, /1\/2 done/);
  // a `tasks` that is not an array at all must not throw
  C.handle(PT('nonsense'));
  assert.equal(doc.getElementById('ptasks-sec').hasAttribute('hidden'), true);
});

test('project tasks: collapsing it is remembered, and the empty state knows about it',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  const none = doc.getElementById('tasks-none');
  w.localStorage.setItem('council-ap-view', 'tasks');
  C.handle(PT([{ text: 'Ship it', done: false }]));
  assert.equal(none.hasAttribute('hidden'), true,
    'a project list is something in the tasks view, so it is not empty');

  const fold = doc.getElementById('ptasks-fold');
  assert.equal(fold.getAttribute('aria-expanded'), 'true');
  fold.click();
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.getElementById('ptasks-body').hasAttribute('hidden'), true);
  assert.equal(w.localStorage.getItem('council-ptasks-fold'), 'closed');
  C.handle(PT([{ text: 'Ship it', done: true }]));
  assert.equal(doc.getElementById('ptasks-body').hasAttribute('hidden'), true,
    'a revised list respects the choice instead of springing open');
  assert.equal(doc.getElementById('ptasks-sec').hasAttribute('hidden'), false);

  C.handle(PT(null));
  assert.equal(none.hasAttribute('hidden'), false, 'nothing anywhere: the empty state');
});

// ------------------------------------------------- UI: filing a chat

// A chat's project used to be decided by whatever the sidebar happened to be
// pointing at when the chat next saved. Now every filing is something the
// user said out loud, and these three affordances are where they say it.

// only the room traffic: the harness records every fetch, and boot chatter
// (heartbeats, attachment probes) is not what these tests are about
const sent = posts => posts.filter(p => p.url === '/input').map(p => p.body.text);

const FILING_PROJECTS = {
  type: 'projects', active_project_id: 'p1', inbox_session_count: 0,
  inbox_sessions: [],
  projects: [
    { id: 'p1', title: 'Demo project', active: true, session_count: 1,
      sessions: [{ session_id: 'abc12345', title: 'First chat', updated_at: '2026-08-24T00:00:00Z', active: false }] },
    { id: 'p2', title: 'Other project', active: false, session_count: 0, sessions: [] },
  ],
};

test('filing: every project row carries its own "+ new chat", filed there from birth',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle(FILING_PROJECTS);
  // p1 is the active project, so it is the one expanded on arrival
  const row = doc.querySelector('.proj[data-pid="p1"] [data-act="proj-new-chat"]');
  assert.ok(row, 'the expanded project offers a new chat of its own');
  row.click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sent(posts), ['/new --project p1'],
    'the new chat names its project up front — no post-hoc filing');
  // archived projects are a resting place, not somewhere you start work
  C.handle({
    ...FILING_PROJECTS,
    projects: [{ id: 'p9', title: 'Done with', status: 'archived', sessions: [] }],
  });
  doc.querySelector('[data-act="toggle-arch"]').click();
  doc.querySelector('.proj[data-pid="p9"] [data-act="toggle"]').click();
  assert.equal(doc.querySelector('.proj[data-pid="p9"] [data-act="proj-new-chat"]'), null);
});

test('sidebar chat row: "remove from project" unfiles it — the safe way out of a list',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  // Three ways out of a project's chat list, and they cost different amounts:
  // unfile (reversible in one click), archive (reversible), delete (a confirm
  // card in the transcript). The commonest reason to want a chat out of a
  // project is that it was filed in the wrong one, and that must not cost the
  // chat — so the safe one is offered FIRST.
  const { doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle(FILING_PROJECTS);
  doc.querySelector('.proj[data-pid="p1"] .row-more[data-sid="abc12345"]').click();
  const items = [...doc.querySelectorAll('.row-menu button')].map(b => b.dataset.act);
  assert.deepEqual(items, ['unfile', 'archive', 'delete'],
    'safest first, destructive last');
  // the chat list scrolls, and a scroll box clips a popover: while a menu is
  // open the box stops scrolling, or the last item is cut in half
  assert.ok(doc.querySelector('.proj[data-pid="p1"] .proj-chats.menu-open'),
    'the scroller stands down while a row menu is open');
  doc.querySelector('.row-menu [data-act="unfile"]').click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(sent(posts), ['/project unfile abc12345'],
    'the filing goes; the chat does not');
  assert.equal(doc.querySelector('.proj[data-pid="p1"] .proj-chats.menu-open'), null,
    'and starts scrolling again once it is closed');
});

test('sidebar: a project’s contents are a request, never part of the per-turn payload',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, w, posts } = await mkHarness(t);
  const asked = [];
  const realFetch = w.fetch;
  w.fetch = async (url, init) => {
    if (String(url).startsWith('/project-contents')) {
      asked.push(String(url));
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, id: 'p1', files: [
          { path: 'figures', name: 'figures', dir: true, size: 0, depth: 0, truncated: false },
          { path: 'figures/fig1.png', name: 'fig1.png', dir: false, size: 2048, depth: 1 },
          { path: 'PROJECT.md', name: 'PROJECT.md', dir: false, size: 512, depth: 0 },
        ] }),
      };
    }
    return realFetch(url, init);
  };
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({
    ...FILING_PROJECTS,
    projects: [{ ...FILING_PROJECTS.projects[0], github: 'https://github.com/me/demo' },
               FILING_PROJECTS.projects[1]],
  });
  assert.equal(asked.length, 0, 'nothing is read until somebody opens the panel');
  assert.equal(doc.querySelector('.proj[data-pid="p1"] .pcon'), null);

  doc.querySelector('.proj[data-pid="p1"] [data-act="proj-contents"]').click();
  await new Promise(r => setTimeout(r, 20));
  const pcon = doc.querySelector('.proj[data-pid="p1"] .pcon');
  assert.ok(pcon, 'the panel opens');
  assert.deepEqual(asked, ['/project-contents?id=p1']);
  assert.match(pcon.textContent, /First chat/, 'the chats, off the panel payload');
  assert.match(pcon.textContent, /figures\//, 'the folder, off the request');
  assert.match(pcon.textContent, /fig1\.png/);
  assert.match(pcon.textContent, /2\.0 KB/, 'with sizes a person can read');
  assert.match(pcon.textContent, /github\.com\/me\/demo/, 'and where it was published');
  assert.equal(doc.querySelector('.proj[data-pid="p1"] .pcon a').getAttribute('href'),
    'https://github.com/me/demo');

  // closing and re-opening does not ask twice — the listing is kept
  doc.querySelector('.proj[data-pid="p1"] [data-act="proj-contents"]').click();
  await new Promise(r => setTimeout(r, 5));
  doc.querySelector('.proj[data-pid="p1"] [data-act="proj-contents"]').click();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(asked.length, 1);
  assert.equal(sent(posts).length, 0, 'and none of it spends a turn');
});

test('sidebar: publishing a project to GitHub is confirmed in the transcript, never in the sidebar',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle(FILING_PROJECTS);
  const b = doc.querySelector('.proj[data-pid="p1"] [data-act="proj-github"]');
  assert.ok(b, 'an unpublished project offers to publish');
  assert.match(b.textContent, /publish to GitHub…/, 'the ellipsis says it will ask');
  b.click();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(sent(posts), ['/project github p1'],
    'the controller preflights gh and asks — the sidebar confirms nothing itself');

  // already published: the same button, saying the true thing
  C.handle({
    ...FILING_PROJECTS,
    projects: [{ ...FILING_PROJECTS.projects[0], github: 'https://github.com/me/demo' }],
  });
  assert.match(doc.querySelector('.proj[data-pid="p1"] [data-act="proj-github"]').textContent,
    /push to GitHub/);
});

test('filing: the top New/chat button asks "file in?" before the chat exists',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle(FILING_PROJECTS);
  const menu = doc.getElementById('new-chat-menu');
  assert.equal(menu.hasAttribute('hidden'), true, 'closed until asked for');

  doc.getElementById('new-chat').click();
  assert.equal(menu.hasAttribute('hidden'), false, 'one click opens the choice');
  assert.deepEqual(sent(posts), [], 'and starts nothing yet');
  assert.match(menu.textContent, /File in:/);
  assert.match(menu.textContent, /Demo project/);
  assert.match(menu.textContent, /Other project/);
  assert.match(menu.textContent, /just a chat/);

  menu.querySelector('[data-act="new-in"][data-pid="p2"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sent(posts), ['/new --project p2']);
  assert.equal(menu.hasAttribute('hidden'), true, 'the menu closes behind the choice');

  // "just a chat" has to survive being clicked while a project is open —
  // that is the case the old inherit-the-lens behaviour got wrong
  doc.getElementById('new-chat').click();
  menu.querySelector('[data-act="new-inbox"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sent(posts), ['/new --project p2', '/new --inbox']);
});

test('filing: with no projects at all, New/chat is still just one click',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'projects', projects: [], inbox_sessions: [], inbox_session_count: 0 });
  doc.getElementById('new-chat').click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(doc.getElementById('new-chat-menu').hasAttribute('hidden'), true);
  assert.deepEqual(sent(posts), ['/new']);
});

test('filing: an unfiled chat is asked where it goes BEFORE the first message',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done', count: 0 });
  C.handle({ ...FILING_PROJECTS, projects: FILING_PROJECTS.projects, inbox_sessions: [] });
  const input = doc.getElementById('input');
  input.value = 'plot me a rocket';
  input.dispatchEvent(new w.Event('input'));
  doc.getElementById('send').click();
  await new Promise(r => setTimeout(r, 10));

  const card = doc.querySelector('.msg.card.filing');
  assert.ok(card, 'the question arrives with the message still unsent');
  assert.deepEqual(sent(posts), [], 'nothing went out yet');
  assert.equal(input.value, 'plot me a rocket', 'the message is held, not eaten');
  assert.match(card.textContent, /Demo project/);
  assert.match(card.textContent, /Just a chat/);

  card.querySelector('button[data-pid="p1"]').click();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent(posts), ['/file p1', 'plot me a rocket'],
    'filed first, then the message it was holding');
  assert.equal(input.value, '', 'and the composer is clear');
});

test('filing: "just a chat" sends the message and the room stops asking',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done', count: 0 });
  C.handle(FILING_PROJECTS);
  const input = doc.getElementById('input');
  const send = text => {
    input.value = text;
    input.dispatchEvent(new w.Event('input'));
    doc.getElementById('send').click();
  };
  send('a loose thought');
  await new Promise(r => setTimeout(r, 10));
  doc.querySelector('.msg.card.filing button[data-pid=""]').click();
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent(posts), ['/project clear', 'a loose thought'],
    'Inbox said out loud, so the controller does not ask again after the message');

  // asked once per chat, never again mid-conversation
  C.handle({ type: 'user_echo', text: 'a loose thought' });
  posts.length = 0;
  send('and another');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(doc.querySelectorAll('.msg.card.filing').length, 1, 'no second interrogation');
  assert.deepEqual(sent(posts), ['and another']);
});

test('filing: a chat that already lives in a project is never asked',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'hello', bridge_id: 'b1' });
  C.handle({ type: 'replay_done', count: 0 });
  C.handle({
    ...FILING_PROJECTS,
    projects: [{
      id: 'p1', title: 'Demo project', active: true, session_count: 1,
      sessions: [{ session_id: 'abc12345', title: 'First chat', updated_at: '2026-08-24T00:00:00Z', active: true }],
    }],
  });
  const input = doc.getElementById('input');
  input.value = 'carry on';
  input.dispatchEvent(new w.Event('input'));
  doc.getElementById('send').click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(doc.querySelector('.msg.card.filing'), null);
  assert.deepEqual(sent(posts), ['carry on']);
});

// ── the typewriter ───────────────────────────────────────────────────────
// The claim is not that the chat is slower. It is that text already in hand
// is revealed at a readable pace instead of landing in lurches the size of
// whatever the bridge happened to buffer — and that the pace is a FRACTION OF
// THE BACKLOG, so a burst catches up in a few frames and the authoritative
// final text is never held back at all.
test('typewriter: a burst is paced, the drain catches up, and the final text lands whole',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C } = await mkHarness(t);
  C.handle({ type: 'hello' });
  C.handle({ type: 'replay_done' });
  C.setTyping('type');
  const burst = 'x'.repeat(400);
  C.handle({ type: 'stream', kind: 'text_delta', stream_id: 's1', model: 'claude', text: burst });
  const s = C.state.streams['claude:s1'];
  const body = () => doc.querySelector('.msg.claude.streaming .body').textContent;
  assert.equal(s.text.length, 400, 'all 400 characters are in hand');
  assert.ok(body().length < 400, 'but the whole burst is not dumped on screen');
  // step the drain by hand rather than waiting on wall time
  let ticks = 0;
  while (s.shown < 400 && ticks < 200) { C.typeDrain(); ticks++; }
  assert.ok(ticks < 60, `the drain catches up in a few frames, not hundreds (took ${ticks})`);
  assert.equal(body(), burst, 'and every character arrived, in order');
  // …and the room event paints the authoritative text whole, streaming class gone
  C.handle({ type: 'room', speaker: 'claude', stream_id: 's1', text: 'the settled answer' });
  assert.equal(doc.querySelector('.msg.claude.streaming'), null, 'stream finalized');
  assert.match(doc.querySelectorAll('.msg.claude .body')[0].textContent, /the settled answer/);
});

test('typewriter: instant is the way back, and it is remembered',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C } = await mkHarness(t);
  C.handle({ type: 'hello' });
  C.handle({ type: 'replay_done' });
  C.setTyping('instant');
  assert.equal(C.typingPref(), 'instant');
  assert.equal(w.localStorage.getItem('council-typing'), 'instant', 'the choice outlives the tab');
  const burst = 'y'.repeat(400);
  C.handle({ type: 'stream', kind: 'text_delta', stream_id: 's2', model: 'claude', text: burst });
  assert.equal(doc.querySelector('.msg.claude.streaming .body').textContent, burst,
    'instant mode shows the whole chunk the moment it lands');
  // the switch in the sidebar footer says which half is on
  const on = doc.querySelector('#typing-toggle .seg-btn.on');
  assert.equal(on.dataset.typingOpt, 'instant');
  assert.equal(on.getAttribute('aria-pressed'), 'true');
  // …and clicking the other half moves it back
  doc.querySelector('#typing-toggle [data-typing-opt="type"]').click();
  assert.equal(C.typingPref(), 'type');
  assert.equal(doc.querySelector('#typing-toggle .seg-btn.on').dataset.typingOpt, 'type');
});

test('typewriter: a reader who asked for less motion gets instant, whatever the switch says',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C } = await mkHarness(t);
  C.handle({ type: 'hello' });
  C.handle({ type: 'replay_done' });
  w.matchMedia = q => ({ matches: /prefers-reduced-motion:\s*reduce/.test(q), media: q,
    addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
  C.setTyping('type');            // the reader's setting stands…
  assert.equal(C.typingPref(), 'type');
  const burst = 'z'.repeat(400);
  C.handle({ type: 'stream', kind: 'text_delta', stream_id: 's3', model: 'claude', text: burst });
  assert.equal(doc.querySelector('.msg.claude.streaming .body').textContent, burst,
    '…but nothing is paced while the OS asks for reduced motion');
  C.renderTyping();
  const seg = doc.querySelector('#typing-toggle .seg');
  assert.equal(seg.getAttribute('data-forced'), '1', 'the switch says the choice is not live');
  assert.equal(doc.querySelector('#typing-toggle .seg-btn.on').dataset.typingOpt, 'instant');
  assert.ok([...seg.querySelectorAll('.seg-btn')].every(b => b.disabled), 'and stops offering it');
});
