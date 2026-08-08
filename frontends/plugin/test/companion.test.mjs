#!/usr/bin/env node
// Endpoint + choreography tests for the web-annotator companion.
// No framework: sequential async checks, non-zero exit on the first failure
// class. The bridge is always the mock (test/mock-bridge.mjs) — the real
// python bridge is never spawned, and one server here runs with no mock at
// all to prove the bridge really is lazy.
//
//   node frontends/plugin/test/companion.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

// --- tiny runner --------------------------------------------------------
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, what, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred(); // predicates may be async (a fetch, a file read)
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// --- server harness -----------------------------------------------------
const spawned = [];
function tmpRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-${tag}-`));
  return d;
}
function startServer({ root, args = [], env = {} }) {
  const proc = spawn(process.execPath, [SERVER, ...args], {
    env: { ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: root, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(proc);
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  return waitFor(() => {
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    return m ? `http://127.0.0.1:${m[1]}` : null;
  }, `server on ${root} to listen (got: ${out.slice(0, 300)})`).then(base => ({ proc, base, out: () => out }));
}
function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + urlPath, {
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { }
        resolve({ status: res.statusCode, json, body: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const GET = (b, p) => request(b, 'GET', p);
const POST = (b, p, body) => request(b, 'POST', p, body || {});

// SSE client: every event lands in `events`, tests wait on predicates
function openEvents(base) {
  const events = [];
  const req = http.get(base + '/events', res => {
    let buf = '';
    res.on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { }
        }
      }
    });
  });
  req.end();
  return { events, close: () => req.destroy() };
}
// minimal WS client: handshake + read one unmasked server text frame
function wsHello(base) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(port), hostname, () => {
      sock.write(`GET /ws HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\n`
        + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      const head = buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const status = buf.slice(0, head).toString();
      const frames = buf.slice(head + 4);
      if (frames.length < 2) return;
      const len = frames[1] & 0x7f; // server frames are unmasked and small
      if (frames.length < 2 + len) return;
      sock.destroy();
      resolve({ status: status.split('\r\n')[0], payload: frames.slice(2, 2 + len).toString() });
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('ws timeout')); }, 4000);
  });
}
const inputs = logFile => fs.readFileSync(logFile, 'utf8').trim().split('\n')
  .filter(Boolean).map(l => JSON.parse(l)).filter(e => e.type === 'input').map(e => e.text);
const allLines = logFile => fs.readFileSync(logFile, 'utf8').trim().split('\n')
  .filter(Boolean).map(l => JSON.parse(l));

// --- fixtures -----------------------------------------------------------
const PAGE1 = 'https://ledger.test/2026/night-trains';
const PAGE2 = 'https://ledger.test/2026/track-charges';
const TITLE1 = 'The Quiet Return of the Night Train';
const QUOTE1 = 'The math only works if the trains run full.';
const ARTICLE = 'For most of the last two decades the night train was treated as a museum piece with a timetable.';

async function main() {
  const root = tmpRoot('root');
  const vault = tmpRoot('vault');
  const logFile = path.join(root, 'bridge-log.jsonl');
  fs.mkdirSync(path.join(root, '.botference', 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.botference', 'plugin', 'config.json'),
    JSON.stringify({ vault_path: vault, export_folder: 'Web Clippings', author: 'angadh' }, null, 2));

  const srv = await startServer({
    root,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
      MOCK_TURN_DELAY_MS: '250',
      PLUGIN_SID_WAIT_MS: '600', // the sid-capture wait, shortened for tests
    },
  });
  const base = srv.base;
  const stream = openEvents(base);
  await waitFor(() => stream.events.some(e => e.type === 'hello'), 'sse hello');

  // --- health / lazy bridge --------------------------------------------
  await test('health reports a stopped bridge before any mention', async () => {
    const r = await GET(base, '/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, bridge: 'stopped', queue: 0 });
    assert.equal(fs.existsSync(logFile), false, 'bridge must not spawn before a bot turn');
  });

  await test('GET /models before the bridge has ever run reports the empty state', async () => {
    const r = await GET(base, '/models');
    assert.deepEqual(r.json, { ok: true, current: null, options: null, status: null, bridge: 'stopped' });
  });

  await test('ws /ws upgrades and sends hello', async () => {
    const { status, payload } = await wsHello(base);
    assert.match(status, /101/);
    assert.equal(JSON.parse(payload).type, 'hello');
  });

  // --- page CRUD --------------------------------------------------------
  await test('GET /page on an unknown url returns page:null', async () => {
    const r = await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`);
    assert.deepEqual(r.json, { ok: true, page: null });
  });

  await test('POST /page creates the shell record', async () => {
    const r = await POST(base, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 1);
    assert.equal(r.json.url, PAGE1);
    assert.equal(r.json.title, TITLE1);
    assert.equal(r.json.site, 'ledger.test');
    assert.equal(r.json.session_id, null);
    assert.deepEqual(r.json.threads, []);
    assert.deepEqual(r.json.page_chat, []);
    const key = crypto.createHash('sha1').update(PAGE1).digest('hex');
    assert.ok(fs.existsSync(path.join(root, '.botference', 'plugin', 'pages', `${key}.json`)));
  });

  await test('GET /index lists the page', async () => {
    const r = await GET(base, '/index');
    const key = crypto.createHash('sha1').update(PAGE1).digest('hex');
    assert.equal(r.json[key].url, PAGE1);
    assert.equal(r.json[key].threads, 0);
  });

  await test('url normalization folds utm params, hash and trailing slash', async () => {
    const messy = `${PAGE1}/?utm_source=newsletter&utm_medium=email#section-2`;
    const r = await GET(base, `/page?url=${encodeURIComponent(messy)}`);
    assert.equal(r.json.url, PAGE1, 'messy url must resolve to the same record');
  });

  // --- threads & replies ------------------------------------------------
  let t1 = null;
  await test('POST /thread creates a thread with the first message', async () => {
    const r = await POST(base, '/thread', {
      url: PAGE1, quote: QUOTE1, prefix: 'around and it costs. ', suffix: ' Operators talk about',
      msg: { text: 'This is the whole argument of the piece.' },
    });
    t1 = r.json.thread;
    assert.equal(r.json.ok, true);
    assert.match(t1.id, /^t-\d+-[0-9a-f]{4}$/);
    assert.equal(t1.orphaned, false);
    assert.equal(t1.msgs.length, 1);
    assert.equal(t1.msgs[0].author, 'angadh');
    assert.equal(r.json.queued, undefined, 'no mention → no bot turn');
  });

  await test('POST /reply appends to a thread and to the page chat', async () => {
    const a = await POST(base, '/reply', { url: PAGE1, thread_id: t1.id, text: 'Second thought.' });
    assert.equal(a.json.msg.text, 'Second thought.');
    const b = await POST(base, '/reply', { url: PAGE1, thread_id: '__page__', text: 'General note.' });
    assert.equal(b.json.ok, true);
    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(page.threads[0].msgs.length, 2);
    assert.equal(page.page_chat.length, 1);
    assert.equal(page.threads.length, 1);
  });

  await test('POST /reply to an unknown thread 404s', async () => {
    const r = await POST(base, '/reply', { url: PAGE1, thread_id: 't-nope', text: 'hi' });
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
  });

  await test('mutations broadcast page invalidation events', () => {
    assert.ok(stream.events.some(e => e.type === 'page' && e.url === PAGE1));
  });

  // --- the bot turn -----------------------------------------------------
  await test('a mention queues a turn, streams, and persists the reply', async () => {
    const before = stream.events.length;
    const r = await POST(base, '/reply', {
      url: PAGE1, thread_id: t1.id, text: '@claude does that hold outside peak season?',
      article_text: ARTICLE,
    });
    assert.equal(r.json.queued, true);
    assert.equal(r.json.position, 1);
    const since = () => stream.events.slice(before);
    const chat = kind => since().filter(e => e.type === 'chat' && e.kind === kind);
    await waitFor(() => chat('turn-start').length, 'turn-start');
    await waitFor(() => chat('turn-end').length, 'turn-end');
    assert.deepEqual(chat('turn-start')[0].agents, ['claude'], 'turn-start names the engaged agent');
    assert.deepEqual(chat('turn-end')[0].agents, ['claude'], 'turn-end echoes it');
    const reply = chat('reply')[0];
    assert.ok(reply, 'a reply event');
    assert.equal(reply.url, PAGE1);
    assert.equal(reply.target, t1.id);
    assert.equal(reply.msg.author, 'claude');
    assert.equal(reply.msg.text, 'MOCK claude reply.');
    const deltas = chat('stream').map(e => e.text).join('');
    assert.equal(deltas, 'MOCK claude reply.', 'streamed text accumulates to the final text');
    assert.equal(chat('stream')[0].model, 'claude');
    assert.ok(chat('stream-done').length, 'a stream-done event');
    assert.ok(since().some(e => e.type === 'bridge' && e.state === 'running'), 'bridge state event');
    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.deepEqual(Object.keys(page), ['version', 'url', 'title', 'site', 'created_at',
      'updated_at', 'session_id', 'threads', 'page_chat'], 'article_text is never persisted');
    const msgs = page.threads[0].msgs;
    assert.equal(msgs.length, 4);
    assert.equal(msgs[3].author, 'claude');
    assert.equal(msgs[3].text, 'MOCK claude reply.');
  });

  await test('the session choreography reached the bridge in order', () => {
    const sent = inputs(logFile);
    assert.deepEqual(sent.slice(0, 4), [
      '/project create Plugin pages',
      '/project open plugin-pages',
      '/new',
      `/rename ${TITLE1}`,
    ]);
    const turn = sent[4];
    assert.ok(turn.startsWith('@claude '), 'route prefix from the mention');
    assert.ok(turn.includes(`[web page: "${TITLE1}" · ${PAGE1}]`), 'first-turn page context');
    assert.ok(turn.includes(ARTICLE), 'article text rides the first turn');
    assert.ok(turn.includes(`> ${QUOTE1}`), 'the highlighted quote');
    assert.ok(turn.includes('Earlier in this thread:\nangadh: This is the whole argument of the piece.'),
      'thread history above the new message');
    assert.ok(turn.includes('and wrote:\n@claude does that hold outside peak season?'));
    assert.ok(turn.endsWith('comment thread.\nKeep it to a few sentences unless asked for more.'),
      'anchored turns carry the brevity reminder');
  });

  await test('the session id from the projects event is stored on the page', async () => {
    // the sid only becomes visible after the turn, so the capture is a wait
    const page = await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      return p.session_id ? p : null;
    }, 'sid capture');
    assert.equal(page.session_id, 'sess-1');
  });

  await test('a second page gets its own /new, not another /project create', async () => {
    await POST(base, '/page', { url: PAGE2, title: 'Who Pays for the Small Hours', site: 'ledger.test' });
    const before = stream.events.length;
    const sentBefore = inputs(logFile).length;
    const r = await POST(base, '/thread', {
      url: PAGE2, quote: 'four different infrastructure managers', prefix: 'pays ', suffix: ', on four',
      msg: { text: '@all is this actually the binding constraint?' },
    });
    assert.equal(r.json.queued, true);
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'turn-end on page 2');
    const sent = inputs(logFile).slice(sentBefore);
    assert.deepEqual(sent.slice(0, 2), ['/new', '/rename Who Pays for the Small Hours']);
    assert.equal(inputs(logFile).filter(t => t.startsWith('/project create')).length, 1);
    assert.ok(sent[2].startsWith('@all '), '@all routes to the room');
    const start = stream.events.slice(before).find(e => e.kind === 'turn-start');
    assert.deepEqual(start.agents, ['claude', 'codex'], '@all engages both agents');
    const page = await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(PAGE2)}`)).json;
      return p.session_id ? p : null;
    }, 'sid capture on page 2');
    // REGRESSION: the bridge's snapshot still says sess-1 while the new chat
    // is empty. Binding page 2 to sess-1 is the bug that put a new page in
    // another page's council chat.
    assert.equal(page.session_id, 'sess-2');
    assert.notEqual(page.session_id, 'sess-1', 'a new page never inherits the live session');
    const first = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(first.session_id, 'sess-1', 'and page 1 keeps its own');
    assert.deepEqual(page.threads[0].msgs.map(m => m.author), ['angadh', 'claude', 'codex']);
  });

  await test('a page whose session is never confirmed stays unbound and says so', async () => {
    const url = 'https://ledger.test/2026/no-session';
    await POST(base, '/page', { url, title: 'No Session', site: 'ledger.test' });
    const before = stream.events.length;
    await POST(base, '/thread', {
      url, quote: 'unconfirmed', prefix: '', suffix: '',
      msg: { text: '@claude hello [mock:nosid]' },
    });
    const err = await waitFor(() => stream.events.slice(before)
      .find(e => e.type === 'chat' && e.kind === 'error'), 'capture failure error');
    assert.match(err.error, /couldn't create a session for this page/);
    assert.ok(stream.events.slice(before).some(e => e.kind === 'turn-end'), 'the turn still ends');
    const page = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    assert.equal(page.session_id, null, 'better unbound than bound to a stranger');
    assert.equal(page.threads[0].msgs.length, 2, 'the reply is still kept');
  });

  await test('returning to the first page resumes its session', async () => {
    const before = stream.events.length;
    const sentBefore = inputs(logFile).length;
    await POST(base, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude one more thing' });
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'turn-end after resume');
    const sent = inputs(logFile).slice(sentBefore);
    assert.equal(sent[0], '/resume sess-1');
    assert.ok(!sent[1].includes('[web page:'), 'page context is a first-turn-only prefix');
    assert.ok(sent[1].includes('The user asked about this page:'), 'page-chat envelope');
    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    // the /resume replayed a `restored` room entry — it must not be persisted
    assert.deepEqual(page.page_chat.map(m => m.author), ['angadh', 'angadh', 'claude']);
  });

  await test('POST /interrupt reaches the bridge for the running page only', async () => {
    const before = stream.events.length;
    await POST(base, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude and another' });
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-start'), 'turn-start');
    const wrong = await POST(base, '/interrupt', { url: 'https://elsewhere.test/x' });
    assert.equal(wrong.json.interrupted, false);
    const right = await POST(base, '/interrupt', { url: PAGE1 });
    assert.equal(right.json.interrupted, true);
    await waitFor(() => allLines(logFile).some(e => e.type === 'interrupt'), 'interrupt at the bridge');
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'turn-end');
  });

  // --- edit / delete / orphan -------------------------------------------
  await test('POST /orphan flags an anchor as lost', async () => {
    const r = await POST(base, '/orphan', { url: PAGE1, thread_id: t1.id, orphaned: true });
    assert.equal(r.json.thread.orphaned, true);
    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(page.threads[0].orphaned, true);
    await POST(base, '/orphan', { url: PAGE1, thread_id: t1.id, orphaned: false });
  });

  await test('POST /edit rewrites your own message and refuses the bots\'', async () => {
    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    const mine = page.threads[0].msgs[1];
    const bot = page.threads[0].msgs[3];
    const okEdit = await POST(base, '/edit', { url: PAGE1, thread_id: t1.id, ts: mine.ts, text: 'Second thought, revised.' });
    assert.equal(okEdit.json.msg.text, 'Second thought, revised.');
    const denied = await POST(base, '/edit', { url: PAGE1, thread_id: t1.id, ts: bot.ts, text: 'nope' });
    assert.equal(denied.status, 403);
  });

  // --- model selection --------------------------------------------------
  await test('GET /models reports what the running bridge announced', async () => {
    const r = await GET(base, '/models');
    assert.equal(r.json.bridge, 'running');
    assert.deepEqual(r.json.current, { claude: 'claude-fable-5', codex: 'gpt-5.6-sol' });
    assert.ok(r.json.options.claude.includes('claude-opus-5'));
    assert.ok(r.json.options.codex.includes('gpt-5.5'));
    assert.deepEqual(r.json.status.claude, {
      pct: 4, tokens: r.json.status.claude.tokens, window: 1000000,
      model: 'claude-fable-5', last_relay_at: null, last_relay_tier: null,
    });
    assert.ok(r.json.status.claude.tokens >= 42000, 'occupancy passes through');
    assert.equal(r.json.status.codex.window, 1050000);
    assert.equal(r.json.status.auto_relay, true);
  });

  await test('the bridge status event broadcast a models event', () => {
    const ev = stream.events.filter(e => e.type === 'models').pop();
    assert.ok(ev, 'a models event');
    assert.equal(ev.current.claude, 'claude-fable-5');
    assert.equal(ev.status.claude.pct, 4);
    assert.equal(ev.status.auto_relay, true);
  });

  await test('POST /model queues the control turn verbatim and rebroadcasts', async () => {
    const before = stream.events.length;
    const sentBefore = inputs(logFile).length;
    const r = await POST(base, '/model', { agent: 'claude', model: 'claude-opus-5' });
    assert.deepEqual(r.json, { ok: true, queued: true });
    await waitFor(() => inputs(logFile).length > sentBefore, 'control turn at the bridge');
    assert.deepEqual(inputs(logFile).slice(sentBefore), ['/model @claude claude-opus-5']);
    const ev = await waitFor(() => stream.events.slice(before).find(e => e.type === 'models'), 'models event');
    assert.deepEqual(ev.current, { claude: 'claude-opus-5', codex: 'gpt-5.6-sol' });
    // a control turn is not a page turn: no thread ever hears about it
    assert.equal(stream.events.slice(before).filter(e => e.type === 'chat').length, 0);
    const models = (await GET(base, '/models')).json;
    assert.equal(models.current.claude, 'claude-opus-5');
  });

  await test('token creep is not broadcast; a pct change is', async () => {
    const quiet = stream.events.length;
    await POST(base, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude quick one' });
    await waitFor(() => stream.events.slice(quiet).some(e => e.kind === 'turn-end'), 'turn-end');
    assert.equal(stream.events.slice(quiet).filter(e => e.type === 'models').length, 0,
      'a heartbeat status that only moved tokens is not news');
    const before = stream.events.length;
    await POST(base, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude another [mock:pct]' });
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'turn-end');
    const ev = stream.events.slice(before).find(e => e.type === 'models');
    assert.ok(ev, 'an occupancy change reaches every tab');
    assert.equal(ev.status.claude.pct, 9);
    assert.equal(ev.status.codex.pct, 7);
    assert.ok(ev.status.claude.tokens > 42000, 'the payload still carries live tokens');
  });

  await test('POST /relay hands the control turn to the bridge verbatim', async () => {
    const before = stream.events.length;
    const sentBefore = inputs(logFile).length;
    const r = await POST(base, '/relay', { agent: 'both' });
    assert.deepEqual(r.json, { ok: true, queued: true });
    await waitFor(() => inputs(logFile).length > sentBefore, 'relay at the bridge');
    assert.deepEqual(inputs(logFile).slice(sentBefore), ['/relay @both']);
    assert.equal(stream.events.slice(before).filter(e => e.type === 'chat').length, 0,
      'a control turn is not a page turn');
    for (const agent of ['claude', 'codex']) {
      const n = inputs(logFile).length;
      assert.equal((await POST(base, '/relay', { agent })).json.ok, true);
      await waitFor(() => inputs(logFile).length > n, `relay @${agent}`);
      assert.deepEqual(inputs(logFile).slice(n), [`/relay @${agent}`]);
    }
    const bad = await POST(base, '/relay', { agent: 'everyone' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
  });

  await test('POST /model refuses a bad agent, a bad id, and an unlisted model', async () => {
    const bad = [
      { agent: 'gemini', model: 'claude-opus-5' },
      { agent: 'claude', model: 'claude opus 5; rm -rf /' },
      { agent: 'claude', model: 'gpt-5.5' },
    ];
    for (const body of bad) {
      const r = await POST(base, '/model', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.ok, false);
    }
  });

  await test('POST /delete removes a message, then the thread', async () => {
    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    const ts = page.threads[0].msgs[1].ts;
    await POST(base, '/delete', { url: PAGE1, thread_id: t1.id, ts });
    let after = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(after.threads[0].msgs.length, 3);
    await POST(base, '/delete', { url: PAGE1, thread_id: t1.id });
    after = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(after.threads.length, 0);
    const idx = (await GET(base, '/index')).json;
    assert.equal(idx[crypto.createHash('sha1').update(PAGE1).digest('hex')].threads, 0);
  });

  await test('deleting a thread\'s last message deletes the thread', async () => {
    const url = 'https://ledger.test/2026/solo-comment';
    await POST(base, '/page', { url, title: 'Solo Comment', site: 'ledger.test' });
    const t = (await POST(base, '/thread', {
      url, quote: 'one quote', prefix: '', suffix: '', msg: { text: 'only comment' },
    })).json.thread;
    const r = await POST(base, '/delete', { url, thread_id: t.id, ts: t.msgs[0].ts });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.thread_deleted, true, 'the caller learns the highlight is gone');
    const page = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    assert.deepEqual(page.threads, [], 'no empty thread left behind');
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const idx = (await GET(base, '/index')).json;
    assert.equal(idx[key].threads, 0, 'index count follows');
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.botference', 'plugin', 'pages', `${key}.json`), 'utf8'));
    assert.deepEqual(onDisk.threads, []);
  });

  await test('reading a page prunes empty threads left by older builds', async () => {
    process.env.BOTFERENCE_PROJECT_ROOT = root;
    const store = await import('../store.mjs');
    const url = 'https://ledger.test/2026/legacy-damage';
    const page = store.blankPage({ url, title: 'Legacy Damage', site: 'ledger.test' });
    page.threads = [
      { id: 't-1-aaaa', quote: 'gone', prefix: '', suffix: '', orphaned: false, msgs: [] },
      { id: 't-2-bbbb', quote: 'kept', prefix: '', suffix: '', orphaned: false,
        msgs: [{ author: 'angadh', ts: new Date().toISOString(), text: 'still here' }] },
    ];
    store.savePage(page);
    const key = crypto.createHash('sha1').update(url).digest('hex');
    assert.equal((await GET(base, '/index')).json[key].threads, 2, 'damaged record starts with two');
    const served = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    assert.deepEqual(served.threads.map(t => t.id), ['t-2-bbbb'], 'served record is healed');
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.botference', 'plugin', 'pages', `${key}.json`), 'utf8'));
    assert.deepEqual(onDisk.threads.map(t => t.id), ['t-2-bbbb'], 'and so is the file');
    assert.equal((await GET(base, '/index')).json[key].threads, 1, 'and the index');
  });

  await test('tool-activity room entries are kept but flagged kind:"tools"', async () => {
    const url = 'https://ledger.test/2026/tool-activity';
    const vaultFile = path.join(vault, 'Web Clippings', 'Tool Activity.md');
    await POST(base, '/page', { url, title: 'Tool Activity', site: 'ledger.test' });
    const before = stream.events.length;
    const t = (await POST(base, '/thread', {
      url, quote: 'a claim worth checking', prefix: '', suffix: '',
      msg: { text: '@claude verify this [mock:tools]' },
    })).json.thread;
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'turn-end');
    const replies = stream.events.slice(before).filter(e => e.kind === 'reply');
    assert.equal(replies.length, 3, 'two tool summaries and the answer');
    assert.equal(replies[0].msg.kind, 'tools', 'flagged by the :tools stream id');
    assert.equal(replies[1].msg.kind, 'tools', 'flagged by shape when unstreamed');
    assert.equal(replies[2].msg.kind, undefined, 'the answer stays unmarked');
    const page = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    const msgs = page.threads[0].msgs;
    assert.deepEqual(msgs.map(m => m.kind), [undefined, 'tools', 'tools', undefined]);
    assert.ok(msgs[1].text.startsWith('Explored'), 'the tool text is kept, not dropped');
    assert.equal(msgs[3].text, 'MOCK claude reply.');

    const r = await POST(base, '/export', { url });
    assert.equal(r.json.path, vaultFile);
    const note = fs.readFileSync(vaultFile, 'utf8');
    assert.ok(!note.includes('Explored'), 'the note omits tool activity');
    assert.ok(note.includes('**claude:** MOCK claude reply.'), 'but keeps the answer');
    assert.ok(note.includes('**angadh:** @claude verify this [mock:tools]'));
    assert.equal(t.msgs.length, 1);
  });

  // --- export -----------------------------------------------------------
  await test('POST /export writes the Obsidian note byte-for-byte', async () => {
    const url = 'https://example.test/export-fixture';
    await POST(base, '/page', { url, title: 'Export Fixture', site: 'example.test' });
    await POST(base, '/thread', {
      url, quote: 'Quote one goes here.', prefix: 'a ', suffix: ' b',
      msg: { text: 'A neat point.' },
    });
    const second = await POST(base, '/thread', {
      url, quote: 'Quote two — with an em dash.', prefix: 'c ', suffix: ' d',
      msg: { text: '@claude is this right?' },
    });
    await waitFor(() => fs.existsSync(path.join(root, '.botference', 'plugin', 'pages',
      `${crypto.createHash('sha1').update(url).digest('hex')}.json`)), 'page file');
    const seen = () => (JSON.parse(fs.readFileSync(path.join(root, '.botference', 'plugin', 'pages',
      `${crypto.createHash('sha1').update(url).digest('hex')}.json`), 'utf8')));
    await waitFor(() => seen().threads[1].msgs.length === 2, 'bot reply on thread two');
    await POST(base, '/reply', { url, thread_id: '__page__', text: '@claude what is this about?' });
    await waitFor(() => seen().page_chat.length === 2, 'bot reply in the page chat');
    assert.equal(second.json.thread.msgs[0].text, '@claude is this right?');

    const r = await POST(base, '/export', { url });
    assert.equal(r.json.ok, true);
    const expected = [
      '---',
      `url: ${url}`,
      'site: example.test',
      `saved: ${new Date().toISOString().slice(0, 10)}`,
      'tags: [web-annotation]',
      '---',
      '',
      '# Export Fixture',
      '',
      '> Quote one goes here.',
      '',
      'A neat point.',
      '',
      '> Quote two — with an em dash.',
      '',
      '**angadh:** @claude is this right?',
      '**claude:** MOCK claude reply.',
      '',
      '## Page chat',
      '',
      '**angadh:** @claude what is this about?',
      '**claude:** MOCK claude reply.',
      '',
    ].join('\n');
    assert.equal(r.json.path, path.join(vault, 'Web Clippings', 'Export Fixture.md'));
    assert.equal(fs.readFileSync(r.json.path, 'utf8'), expected);
  });

  await test('re-export overwrites in place; a different url gets " (2)"', async () => {
    const url = 'https://example.test/export-fixture';
    const again = await POST(base, '/export', { url });
    assert.equal(again.json.path, path.join(vault, 'Web Clippings', 'Export Fixture.md'));
    const other = 'https://other.test/same-headline';
    await POST(base, '/page', { url: other, title: 'Export Fixture', site: 'other.test' });
    const r = await POST(base, '/export', { url: other });
    assert.equal(r.json.path, path.join(vault, 'Web Clippings', 'Export Fixture (2).md'));
    assert.deepEqual(fs.readdirSync(path.join(vault, 'Web Clippings')).filter(f => f.startsWith('Export Fixture')).sort(),
      ['Export Fixture (2).md', 'Export Fixture.md']);
  });

  // --- --no-agents ------------------------------------------------------
  await test('--no-agents persists the comment but refuses the summon', async () => {
    const offRoot = tmpRoot('noagents');
    const off = await startServer({ root: offRoot, args: ['--no-agents'] });
    const es = openEvents(off.base);
    await waitFor(() => es.events.some(e => e.type === 'hello'), 'sse hello (no-agents)');
    await POST(off.base, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });
    const r = await POST(off.base, '/thread', {
      url: PAGE1, quote: QUOTE1, prefix: '', suffix: '', msg: { text: '@claude thoughts?' },
    });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.queued, false);
    assert.equal(r.json.reason, 'agents are off on this companion');
    const err = await waitFor(() => es.events.find(e => e.type === 'chat' && e.kind === 'error'), 'error event');
    assert.equal(err.url, PAGE1);
    assert.equal(err.target, r.json.thread.id);
    assert.match(err.error, /agents are off/);
    const health = await GET(off.base, '/health');
    assert.equal(health.json.bridge, 'disabled');
    const models = await GET(off.base, '/models');
    assert.deepEqual(models.json, { ok: true, current: null, options: null, status: null, bridge: 'disabled' });
    const setModel = await POST(off.base, '/model', { agent: 'claude', model: 'claude-opus-5' });
    assert.equal(setModel.status, 409);
    assert.deepEqual(setModel.json, { ok: false, error: 'agents are off on this companion' });
    const relay = await POST(off.base, '/relay', { agent: 'both' });
    assert.equal(relay.status, 409);
    assert.deepEqual(relay.json, { ok: false, error: 'agents are off on this companion' });
    const page = (await GET(off.base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(page.threads[0].msgs[0].text, '@claude thoughts?');
    es.close();
    off.proc.kill();
  });

  // --- real config, no mock: the bridge must stay lazy ------------------
  await test('a server with the real bridge config serves /health and /test-page without spawning it', async () => {
    const realRoot = tmpRoot('real');
    const real = await startServer({ root: realRoot });
    const health = await GET(real.base, '/health');
    assert.deepEqual(health.json, { ok: true, bridge: 'stopped', queue: 0 });
    // a relay with nothing running must refuse rather than spawn the bridge
    const relay = await POST(real.base, '/relay', { agent: 'claude' });
    assert.equal(relay.status, 409);
    assert.deepEqual(relay.json, { ok: false, error: 'agents are idle — nothing to relay' });
    assert.equal((await GET(real.base, '/health')).json.bridge, 'stopped', 'still no bridge');
    const page = await GET(real.base, '/test-page');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('<h1>The Quiet Return of the Night Train</h1>'));
    assert.ok(page.body.includes('og:title'));
    assert.ok(fs.existsSync(path.join(realRoot, '.botference', 'plugin', 'config.json')),
      'config.json is created with defaults on first run');
    assert.ok(!/bridge/i.test(real.out().replace(/[^\n]*companion live[^\n]*/g, '')), 'no bridge chatter');
    real.proc.kill();
  });

  stream.close();
  for (const p of spawned) { try { p.kill(); } catch { } }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(`failed: ${failures.join(', ')}`); process.exit(1); }
}

main().catch(e => {
  console.error(e);
  for (const p of spawned) { try { p.kill(); } catch { } }
  process.exit(1);
});
