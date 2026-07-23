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

async function startServer({ hosted = false, noauth = false, env = {} } = {}) {
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-'));
  const rx = path.join(root, 'rx.txt');
  const args = [SERVER];
  if (hosted) args.push('--hosted');
  if (noauth) args.push('--no-auth');
  const proc = spawn(process.execPath, args, {
    env: {
      ...process.env,
      PORT: String(port),
      BOTFERENCE_PROJECT_ROOT: root,
      BOTFERENCE_HOME: HOME,
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
  return {
    proc, port, root, rx, base: `http://127.0.0.1:${port}`,
    stop: () => { proc.kill(); fs.rmSync(root, { recursive: true, force: true }); },
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
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'app.js'), 'utf8'), w);
  const C = w.__council;
  assert.ok(C, 'app exposes the harness handle');

  // empty state shows before any content
  assert.equal(doc.getElementById('empty').hasAttribute('hidden'), false);

  // projects event renders the sidebar (project + chat + inbox count)
  C.handle({
    type: 'projects', active_project_id: 'p1', inbox_session_count: 3,
    projects: [{
      id: 'p1', title: 'Demo project', active: true, session_count: 1,
      sessions: [{ session_id: 'abc12345', title: 'First chat', updated_at: new Date().toISOString(), active: false }],
    }],
  });
  assert.match(doc.getElementById('projects').textContent, /Demo project/);
  assert.match(doc.getElementById('projects').textContent, /First chat/);
  assert.match(doc.getElementById('projects').textContent, /Inbox/);

  // clicking a chat sends the equivalent slash command — one code path
  doc.querySelector('.sess[data-act="resume"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/resume abc12345', attachments: [] } });
  C.state.pendingSwitch = null; // settle the in-flight switch for the rest of the smoke

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
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/status', attachments: [] } });

  // transcript: user echo, streaming delta, final room replaces the stream
  C.handle({ type: 'user_echo', text: 'hello council' });
  assert.equal(doc.getElementById('empty').hasAttribute('hidden'), true, 'empty state yields to content');
  assert.match(doc.querySelector('.msg.user .body').textContent, /hello council/);
  C.handle({ type: 'stream', kind: 'text_delta', stream_id: 's9', model: 'claude', text: 'partial ' });
  const streaming = doc.querySelector('.msg.claude.streaming .body');
  assert.match(streaming.textContent, /partial/);
  C.handle({ type: 'room', speaker: 'claude', stream_id: 's9', text: 'final text' });
  assert.equal(doc.querySelector('.msg.claude.streaming'), null, 'stream finalized');
  assert.match(doc.querySelector('.msg.claude .body').textContent, /final text/);

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
  assert.deepEqual(posts.pop(), { url: '/choice', body: { index: 1 } });
  assert.ok(card.classList.contains('answered'));

  // permission card: deny posts allow:false
  C.handle({ type: 'permission_request', model: 'codex', path: '/somewhere/file.md', reason: 'draft plan' });
  const perm = doc.querySelector('.msg.card.perm:not(.answered)');
  assert.match(perm.textContent, /file\.md/);
  perm.querySelector('button.deny').click();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(posts.pop(), { url: '/permission', body: { allow: false } });

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
  // would fire the app's reconnect resetView() mid-test and wipe the DOM
  w.WebSocket = class { constructor() { } close() { } send() { } };
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
  return { w, doc, C, chat, transcript, geo, posts };
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

test('chat switch: optimistic cached render, offscreen reconcile, never a blank transcript',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { doc, C, transcript, posts } = await mkHarness(t);
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
  // switch to B (first visit, uncached): old transcript stays + syncing pill
  C.switchTo('sidB');
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/resume sidB', attachments: [] } });
  assert.match(transcript.textContent, /hello from A/, 'no blank state while the switch is in flight');
  assert.equal(doc.getElementById('sync').hasAttribute('hidden'), false, 'syncing pill shows');
  // the authoritative replay: clear_panes must NOT blank the visible pane
  C.handle({ type: 'clear_panes' });
  assert.ok(transcript.children.length > 0, 'clear_panes during a switch keeps content on screen');
  C.handle({ type: 'restore', entries: [{ speaker: 'user', text: 'hello from B' }, { speaker: 'codex', text: 'B replies' }] });
  assert.match(transcript.textContent, /hello from A/, 'replay builds offscreen');
  C.handle(projects('sidB'));
  C.handle({ type: 'ready' });
  assert.match(transcript.textContent, /B replies/, 'ready swaps the fresh transcript in');
  assert.doesNotMatch(transcript.textContent, /hello from A/);
  assert.equal(doc.getElementById('sync').hasAttribute('hidden'), true);
  // switch BACK to A: instant render from the cache, before any server event
  C.switchTo('sidA');
  assert.match(transcript.textContent, /hello from A/, 'cached transcript paints instantly');
  assert.match(transcript.textContent, /A says hi/);
  assert.ok(C.sessionCache.has('sidB'), 'outgoing chat was snapshotted');
  // reconcile completes without ever blanking
  C.handle({ type: 'clear_panes' });
  assert.ok(transcript.children.length > 0);
  C.handle({ type: 'restore', entries: [{ speaker: 'user', text: 'hello from A' }, { speaker: 'claude', text: 'A says hi' }] });
  C.handle(projects('sidA'));
  C.handle({ type: 'ready' });
  assert.match(transcript.textContent, /A says hi/);
  // tapping the already-live chat is a no-op, not a redundant /resume
  const n = posts.length;
  C.switchTo('sidA');
  assert.equal(posts.length, n, 'no round trip for the active chat');
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
  // nothing in the stylesheet blocks selection on message text (the only
  // user-select:none allowed is the decorative avatar mark), and the
  // transcript explicitly opts into selection for iOS long-press
  const css = fs.readFileSync(path.join(HOME, 'frontends', 'council', 'assets', 'style.css'), 'utf8');
  for (const m of css.matchAll(/([^{}]+)\{[^{}]*user-select:\s*none[^{}]*\}/g)) {
    assert.match(m[1].trim(), /\.avatar/, `only avatars may block selection: ${m[1].trim()}`);
  }
  assert.match(css, /#transcript\s*\{[^}]*user-select:\s*text/, 'transcript opts into selection');
  // the attach affordance is phone-real: image picker that lets iOS offer
  // camera + library (accept=image/*, no capture attr), plus multiple
  const file = doc.getElementById('file');
  assert.equal(file.getAttribute('accept'), 'image/*');
  assert.equal(file.hasAttribute('capture'), false, 'no capture attr — keeps the library option on iOS');
  assert.ok(file.hasAttribute('multiple'));
  assert.ok(doc.getElementById('attach'), 'attach button present');
  assert.match(css, /#input\s*\{[^}]*font:\s*16px/, '16px input font (no iOS zoom-on-focus)');
});

// ------------------------------------------- UI: model switcher + exhaustion

test('model switcher renders from completion_context; selecting sends /model verbatim',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, doc, C, posts } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  // scoped model lists seed the picker; status carries the current per-agent model
  C.handle({ type: 'completion_context', global: ['/status'], scoped: {
    '/model @claude ': ['claude-fable-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
    '/model @codex ': ['gpt-5.6-sol', 'gpt-5.5'],
  } });
  C.handle({ type: 'status', route: '@all', project: 'p', claude_pct: 10, codex_pct: 5,
    claude_model: 'claude-fable-5', codex_model: 'gpt-5.6-sol' });
  const sw = doc.getElementById('model-switcher');
  assert.match(sw.textContent, /Claude/);
  assert.match(sw.textContent, /Codex/);
  const claudeSel = sw.querySelector('select.ms-select[data-agent="claude"]');
  assert.ok(claudeSel, 'claude model <select> renders');
  assert.equal(claudeSel.value, 'claude-fable-5', 'current model is preselected');
  assert.equal(claudeSel.querySelectorAll('option').length, 3, 'all scoped claude models offered');
  assert.match(doc.getElementById('st-model').textContent, /fable-5/, 'current model visible near the status strip');

  // selecting a model sends the exact bridge command through the input path
  claudeSel.value = 'claude-opus-4-8';
  claudeSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/model @claude claude-opus-4-8', attachments: [] } });
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
  const { w, C, posts } = await mkHarness(t);
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
  await new Promise(r => setTimeout(r, 5));
  assert.equal(w.location.hash, '#/chat/sidB', 'switching updates the URL');
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/resume sidB', attachments: [] } });
  C.state.pendingSwitch = null;
  C.handle(projects('sidB')); // server reconciles the switch
  assert.equal(C.state.currentSid, 'sidB');
  assert.equal(w.location.hash, '#/chat/sidB');

  // a hashchange to a known id (pasted link / back button) navigates to it
  w.location.hash = '#/chat/sidA';
  w.dispatchEvent(new w.Event('hashchange'));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/resume sidA', attachments: [] } },
    'a known hashed id resumes that chat');
  C.state.pendingSwitch = null;
  C.handle(projects('sidA'));

  // an unknown id falls back to the current chat with a notice, no navigation
  const n = posts.length;
  w.location.hash = '#/chat/does-not-exist';
  w.dispatchEvent(new w.Event('hashchange'));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(posts.length, n, 'an unknown id triggers no /resume');
  assert.equal(w.location.hash, '#/chat/sidA', 'the URL falls back to the current chat');
});

test('hash routing: a link opened straight to #/chat/<id> restores that chat once the session list arrives',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const { w, C, posts } = await mkHarness(t);
  C.handle({ type: 'replay_done' });
  // the hash is present before any 'projects' event (deep link / reload): the
  // server's default-active chat is sidA, but the URL asks for sidB
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
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/resume sidB', attachments: [] } },
    'the hashed chat is resumed, not the default-active one');
  assert.equal(w.location.hash, '#/chat/sidB', 'the requested hash is preserved, not overwritten');
});
