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
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/resume abc12345' } });

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
  assert.deepEqual(posts.pop(), { url: '/input', body: { text: '/status' } });

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
