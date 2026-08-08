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
import zlib from 'node:zlib';
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
const ARTICLE2 = 'REWRITTEN: the sleeper order book has doubled since the draft you saw.';

// A real .docx, built here rather than checked in as a binary: the companion's
// zip reader has to walk a genuine central directory, so the test writes one
// (stored AND deflated entries, so both branches are exercised).
const crc32 = zlib.crc32 ? d => zlib.crc32(d) : () => 0;
function zipFile(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const method = e.store ? 0 : 8;
    const comp = method ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += head.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, eocd]);
}
const COMMENTS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:comment w:id="1" w:author="Priya Raman" w:date="2026-08-01T09:00:00Z" w:initials="PR">'
  + '<w:p><w:r><w:t xml:space="preserve">The load-factor claim needs a </w:t></w:r>'
  + '<w:r><w:t>source.</w:t></w:r></w:p></w:comment>'
  + '<w:comment w:id="2" w:author="Tom &amp; Co" w:date="2026-08-02T11:30:00Z" w:initials="TC">'
  + '<w:p><w:r><w:t>Agreed &amp; noted.</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Second paragraph of the same comment.</w:t></w:r></w:p></w:comment>'
  + '<w:comment w:id="3" w:author="Empty" w:date="2026-08-02T11:31:00Z"><w:p/></w:comment>'
  + '</w:comments>';
const docxB64 = () => zipFile([
  { name: '[Content_Types].xml', data: '<Types/>', store: true },
  { name: 'word/document.xml', data: '<w:document><w:body/></w:document>' },
  { name: 'word/comments.xml', data: COMMENTS_XML },
]).toString('base64');

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
    assert.deepEqual(r.json, {
      ok: true, current: null, options: null, status: null,
      // effort is the exception: the child's argparse defaults are knowable
      // before it exists, and no bridge event ever reports the live level
      effort: { current: { claude: 'high', codex: null }, options: null },
      verbosity: 'short',
      bridge: 'stopped',
    });
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
    assert.ok(turn.endsWith('comment thread.\nReply like a human in a chat: '
      + '2-3 crisp sentences, no essay structure, no filler.'),
      'the turn ends with the reader\'s length instruction');
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
    // effort options come from the same completion_context the models do
    assert.deepEqual(r.json.effort.current, { claude: 'high', codex: null });
    assert.deepEqual(r.json.effort.options.claude, ['low', 'medium', 'high', 'xhigh']);
    assert.ok(r.json.effort.options.codex.includes('minimal'));
    assert.equal(r.json.verbosity, 'short');
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

  // --- page text that moves under the reader -----------------------------
  await test('a later turn re-sends the page text only when the extension says it changed', async () => {
    const url = 'https://ledger.test/2026/living-draft';
    await POST(base, '/page', { url, title: 'Living Draft', site: 'ledger.test' });
    // the envelope of the next turn to reach the bridge, whatever control
    // steps precede it
    const nextTurn = async from => waitFor(
      () => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the user turn');

    // first turn: article_changed is set, but a brand-new chat gets the
    // ordinary page-context block — there is no "earlier" to differ from
    let from = inputs(logFile).length;
    await POST(base, '/thread', {
      url, quote: 'the draft as it stood', prefix: '', suffix: '',
      msg: { text: '@claude first look' }, article_text: ARTICLE, article_changed: true,
    });
    const first = await nextTurn(from);
    assert.ok(first.includes(`[web page: "Living Draft" · ${url}]`), 'first-turn context');
    assert.ok(first.includes(ARTICLE));
    assert.ok(!first.includes('has been updated'), 'no refresh banner on turn one');
    await waitFor(async () => (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json.session_id,
      'sid capture on the living draft');

    // later turn, text moved: the refreshed article rides again, flagged
    from = inputs(logFile).length;
    await POST(base, '/reply', {
      url, thread_id: '__page__', text: '@claude and now?',
      article_text: ARTICLE2, article_changed: true,
    });
    const later = await nextTurn(from);
    assert.ok(later.startsWith('@claude [the page content has been updated since earlier in this chat]\n'),
      'the refresh banner leads the envelope');
    assert.ok(later.includes(ARTICLE2), 'with the new text');
    assert.ok(!later.includes(`[web page: "Living Draft"`), 'and not the first-turn header');

    // later turn, text unchanged: no context at all, however much the
    // extension sent along
    from = inputs(logFile).length;
    await POST(base, '/reply', {
      url, thread_id: '__page__', text: '@claude quietly', article_text: ARTICLE2,
    });
    const quiet = await nextTurn(from);
    assert.ok(!quiet.includes('has been updated'), 'unflagged text is not resent');
    assert.ok(!quiet.includes(ARTICLE2));
    const page = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    assert.ok(!JSON.stringify(page).includes('REWRITTEN'), 'page text is never persisted');
  });

  // --- .docx comments ----------------------------------------------------
  await test('a .docx rides a mention and its comments reach the envelope', async () => {
    const url = 'https://docs.google.test/document/d/abc/edit';
    await POST(base, '/page', { url, title: 'Reviewed Doc', site: 'docs.google.test' });
    const from = inputs(logFile).length;
    const r = await POST(base, '/reply', {
      url, thread_id: '__page__', text: '@claude what are people objecting to?',
      docx_b64: docxB64(),
    });
    assert.equal(r.json.queued, true);
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the turn');
    assert.ok(turn.includes('\n[comments on this document]\n'), 'the digest is appended');
    assert.ok(turn.includes('Priya Raman: The load-factor claim needs a source.'),
      'runs inside one comment are joined');
    assert.ok(turn.includes('Tom & Co: Agreed & noted. Second paragraph of the same comment.'),
      'entities decoded, paragraphs flattened');
    assert.ok(!turn.includes('Empty:'), 'a comment with no words is dropped');
    assert.ok(!turn.includes('<w:'), 'no xml survives');
    const page = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    assert.ok(!JSON.stringify(page).includes('Priya'), 'the document is never persisted');
  });

  await test('a corrupted .docx is ignored, not fatal', async () => {
    const url = 'https://docs.google.test/document/d/broken/edit';
    await POST(base, '/page', { url, title: 'Broken Doc', site: 'docs.google.test' });
    const from = inputs(logFile).length;
    const r = await POST(base, '/reply', {
      url, thread_id: '__page__', text: '@claude read this',
      docx_b64: Buffer.from('PK truncated upload, no directory here').toString('base64'),
    });
    assert.equal(r.json.queued, true, 'the comment is still sent');
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the turn');
    assert.ok(!turn.includes('[comments on this document]'), 'no digest, no crash');
  });

  await test('a .docx over 8MB is refused before anything is saved', async () => {
    const url = 'https://docs.google.test/document/d/huge/edit';
    await POST(base, '/page', { url, title: 'Huge Doc', site: 'docs.google.test' });
    const r = await POST(base, '/reply', {
      url, thread_id: '__page__', text: '@claude have a look',
      docx_b64: Buffer.alloc(8 * 1024 * 1024 + 1024).toString('base64'),
    });
    assert.equal(r.status, 413);
    assert.equal(r.json.ok, false);
    const page = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    assert.deepEqual(page.page_chat, [], 'a refused request leaves no message behind');
  });

  // --- ticking a checklist -----------------------------------------------
  const TICK_URL = 'https://ledger.test/2026/checklist';
  const TICK_TEXT = [
    'Three things worth doing:',
    '- [ ] check the load factor',
    '  * [ ] find a source for the 2019 figure',
    '1. [ ] email the operator',
    '',
    'Note: - [ ] mid-line boxes are prose, not items.',
  ].join('\n');
  let tickTs = '';
  await test('POST /tick toggles a bot checklist in every marker style', async () => {
    process.env.BOTFERENCE_PROJECT_ROOT = root;
    const store = await import('../store.mjs');
    const page = store.blankPage({ url: TICK_URL, title: 'Checklist', site: 'ledger.test' });
    tickTs = new Date().toISOString();
    // authored by a BOT: ticking someone else's checklist is the whole point
    page.page_chat = [{ author: 'claude', ts: tickTs, text: TICK_TEXT }];
    store.savePage(page);

    const tick = (index, checked) => POST(base, '/tick',
      { url: TICK_URL, thread_id: '__page__', ts: tickTs, index, checked });
    // the expected text, byte-for-byte, with the given LINES ticked
    const marked = (...lines) => TICK_TEXT.split('\n')
      .map((l, n) => (lines.includes(n) ? l.replace('[ ]', '[x]') : l)).join('\n');

    const a = await tick(0, true);
    assert.equal(a.json.ok, true);
    assert.equal(a.json.text, marked(1), 'the dash item, and nothing else');
    assert.equal((await tick(1, true)).json.text, marked(1, 2), 'the indented star item');
    const c = await tick(2, true);
    assert.equal(c.json.text, marked(1, 2, 3), 'the numbered item');
    assert.ok(c.json.text.includes('Note: - [ ] mid-line boxes are prose'),
      'a mid-line box is not a list item and is left alone');
    const back = await tick(0, false);
    assert.equal(back.json.text, marked(2, 3), 'and it unticks');
    const stored = (await GET(base, `/page?url=${encodeURIComponent(TICK_URL)}`)).json;
    assert.equal(stored.page_chat[0].text, back.json.text, 'the ticked text is on disk');
    assert.equal(stored.page_chat[0].author, 'claude', 'and it is still the bot\'s message');
  });

  await test('POST /tick refuses an unknown message and an index off the end', async () => {
    const bad = [
      [{ url: TICK_URL, thread_id: '__page__', ts: 'not-a-ts', index: 0, checked: true }, 404],
      [{ url: TICK_URL, thread_id: 't-nope', ts: tickTs, index: 0, checked: true }, 404],
      [{ url: 'https://ledger.test/2026/never-seen', ts: tickTs, index: 0, checked: true }, 404],
      [{ url: TICK_URL, thread_id: '__page__', ts: tickTs, index: 3, checked: true }, 400],
      [{ url: TICK_URL, thread_id: '__page__', ts: tickTs, index: -1, checked: true }, 400],
      [{ url: TICK_URL, thread_id: '__page__', ts: tickTs, checked: true }, 400],
    ];
    for (const [body, status] of bad) {
      const r = await POST(base, '/tick', body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal(r.json.ok, false);
    }
  });

  await test('POST /tick works in an anchored thread and broadcasts the page', async () => {
    const url = 'https://ledger.test/2026/thread-checklist';
    const t = (await POST(base, '/thread', {
      url, quote: 'a passage', prefix: '', suffix: '', msg: { text: 'plan:\n- [ ] one\n- [ ] two' },
    })).json.thread;
    const before = stream.events.length;
    const r = await POST(base, '/tick',
      { url, thread_id: t.id, ts: t.msgs[0].ts, index: 1, checked: true });
    assert.equal(r.json.text, 'plan:\n- [ ] one\n- [x] two');
    await waitFor(() => stream.events.slice(before).some(e => e.type === 'page' && e.url === url),
      'page invalidation after a tick');
  });

  // --- file writing is off ------------------------------------------------
  await test('a permission request is denied at once and reported in the thread', async () => {
    const url = 'https://ledger.test/2026/permission';
    await POST(base, '/page', { url, title: 'Permission', site: 'ledger.test' });
    const before = stream.events.length;
    const responsesBefore = allLines(logFile).filter(e => e.type === 'permission_response').length;
    const t = (await POST(base, '/thread', {
      url, quote: 'worth writing up', prefix: '', suffix: '',
      msg: { text: '@claude write this up for me [mock:perm]' },
    })).json.thread;
    // "at once": with the old 120s timer this wait would expire
    await waitFor(() => allLines(logFile).filter(e => e.type === 'permission_response').length > responsesBefore,
      'an immediate answer', 2000);
    const answer = allLines(logFile).filter(e => e.type === 'permission_response').pop();
    assert.equal(answer.allow, false, 'every permission request is denied');
    const err = await waitFor(() => stream.events.slice(before)
      .find(e => e.type === 'chat' && e.kind === 'error'), 'the thread is told');
    assert.equal(err.url, url);
    assert.equal(err.target, t.id);
    assert.equal(err.error, 'claude asked to write a file — file-writing is disabled in the annotator');
    await waitFor(() => stream.events.slice(before)
      .some(e => e.kind === 'turn-end' && e.url === url), 'the turn still ends');
    const page = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    assert.equal(page.threads[0].msgs.length, 2, 'and the reply still lands');
  });

  // --- reasoning effort ---------------------------------------------------
  await test('POST /effort queues the control turn and updates the picker', async () => {
    // the earlier tests left turns running; a control turn only proves it is
    // silent once nothing else is talking
    await waitFor(async () => (await GET(base, '/health')).json.queue === 0, 'the bridge to go idle');
    const before = stream.events.length;
    const sentBefore = inputs(logFile).length;
    const r = await POST(base, '/effort', { agent: 'claude', level: 'xhigh' });
    assert.deepEqual(r.json, { ok: true, queued: true });
    await waitFor(() => inputs(logFile).length > sentBefore, 'effort at the bridge');
    assert.deepEqual(inputs(logFile).slice(sentBefore), ['/effort @claude xhigh']);
    const ev = await waitFor(() => stream.events.slice(before)
      .find(e => e.type === 'models' && e.effort.current.claude === 'xhigh'), 'models event');
    assert.equal(ev.effort.current.codex, null, 'codex is untouched and still unknown');
    assert.equal(ev.verbosity, 'short', 'the panel event carries verbosity too');
    assert.equal(stream.events.slice(before).filter(e => e.type === 'chat').length, 0,
      'a control turn is not a page turn');
    assert.equal((await GET(base, '/models')).json.effort.current.claude, 'xhigh');
    const n = inputs(logFile).length;
    assert.equal((await POST(base, '/effort', { agent: 'codex', level: 'minimal' })).json.ok, true);
    await waitFor(() => inputs(logFile).length > n, 'codex effort');
    assert.deepEqual(inputs(logFile).slice(n), ['/effort @codex minimal']);
    await waitFor(async () => (await GET(base, '/models')).json.effort.current.codex === 'minimal',
      'codex effort recorded');
  });

  await test('POST /effort refuses a bad agent and a level the bridge never offered', async () => {
    const bad = [
      { agent: 'gemini', level: 'high' },
      { agent: 'claude', level: 'high; rm -rf /' },
      { agent: 'claude', level: 'minimal' }, // a codex level, not a claude one
      { agent: 'codex', level: 'xhigh' },
    ];
    for (const body of bad) {
      const r = await POST(base, '/effort', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.ok, false);
    }
  });

  // --- reply length -------------------------------------------------------
  await test('POST /verbosity persists, broadcasts, and changes the next envelope', async () => {
    const cfgFile = path.join(root, '.botference', 'plugin', 'config.json');
    const before = stream.events.length;
    const r = await POST(base, '/verbosity', { level: 'long' });
    assert.deepEqual(r.json, { ok: true, verbosity: 'long' });
    assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).verbosity, 'long', 'written to config.json');
    const ev = await waitFor(() => stream.events.slice(before)
      .find(e => e.type === 'models' && e.verbosity === 'long'), 'models broadcast');
    assert.ok(ev.effort, 'the broadcast carries the whole panel');
    assert.equal((await GET(base, '/models')).json.verbosity, 'long');

    let from = inputs(logFile).length;
    await POST(base, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude at length please' });
    const long = await waitFor(() => inputs(logFile).slice(from)
      .find(t => t.startsWith('@claude ')), 'the long turn');
    assert.ok(long.endsWith('Reply conversationally, at most 4-5 sentences.'));
    assert.ok(!long.includes('crisp sentences'), 'one length instruction, never two');

    assert.equal((await POST(base, '/verbosity', { level: 'short' })).json.verbosity, 'short');
    from = inputs(logFile).length;
    await POST(base, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude briefly then' });
    const short = await waitFor(() => inputs(logFile).slice(from)
      .find(t => t.startsWith('@claude ')), 'the short turn');
    assert.ok(short.endsWith('Reply like a human in a chat: 2-3 crisp sentences, no essay structure, no filler.'));
    const bad = await POST(base, '/verbosity', { level: 'epic' });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).verbosity, 'short', 'a refusal changes nothing');
  });

  // --- forgetting a page --------------------------------------------------
  await test('the index says which pages have a bot chat', async () => {
    const idx = (await GET(base, '/index')).json;
    assert.equal(idx[crypto.createHash('sha1').update(PAGE1).digest('hex')].has_session, true);
    assert.equal(idx[crypto.createHash('sha1').update(TICK_URL).digest('hex')].has_session, false);
  });

  await test('POST /delete-page forgets the page and asks a running bridge to delete the chat', async () => {
    const url = 'https://ledger.test/2026/regretted';
    await POST(base, '/page', { url, title: 'Regretted', site: 'ledger.test' });
    await POST(base, '/thread', {
      url, quote: 'a thing said', prefix: '', suffix: '', msg: { text: '@claude thoughts?' },
    });
    const sid = (await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
      return p.session_id ? p : null;
    }, 'sid capture on the regretted page')).session_id;

    const before = stream.events.length;
    const sentBefore = inputs(logFile).length;
    const r = await POST(base, '/delete-page', { url, delete_session: true });
    assert.deepEqual(r.json, { ok: true, session_deleted: true });
    await waitFor(() => inputs(logFile).slice(sentBefore).includes(`/delete ${sid}`), '/delete at the bridge');
    // the controller confirms deletions through a picker; nobody is at a
    // keyboard, so the companion must answer it
    const choice = await waitFor(() => allLines(logFile).filter(e => e.type === 'choice_response').pop(),
      'the confirm answered');
    assert.equal(choice.index, 0, 'confirmed, not cancelled');
    await waitFor(() => stream.events.slice(before).some(e => e.type === 'page' && e.url === url),
      'page invalidation');
    assert.equal((await GET(base, `/page?url=${encodeURIComponent(url)}`)).json.page, null);
    assert.equal((await GET(base, '/index')).json[crypto.createHash('sha1').update(url).digest('hex')], undefined);
    assert.equal(fs.existsSync(path.join(root, '.botference', 'plugin', 'pages',
      `${crypto.createHash('sha1').update(url).digest('hex')}.json`)), false, 'the record is gone from disk');
  });

  await test('with the bridge stopped the session file is deleted from the work dir', async () => {
    const stopRoot = tmpRoot('delstop');
    const sessions = path.join(stopRoot, 'work', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'sess-orphan.json'), '{"session_id":"sess-orphan"}');
    const stop = await startServer({
      root: stopRoot, env: { PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]) },
    });
    const url = 'https://ledger.test/2026/cold-delete';
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const file = path.join(stopRoot, '.botference', 'plugin', 'pages', `${key}.json`);
    await POST(stop.base, '/page', { url, title: 'Cold Delete', site: 'ledger.test' });
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.session_id = 'sess-orphan';
    fs.writeFileSync(file, JSON.stringify(rec));

    assert.equal((await GET(stop.base, '/health')).json.bridge, 'stopped', 'nothing has summoned it');
    const r = await POST(stop.base, '/delete-page', { url, delete_session: true });
    assert.deepEqual(r.json, { ok: true, session_deleted: true });
    assert.equal(fs.existsSync(path.join(sessions, 'sess-orphan.json')), false, 'the chat is gone');
    assert.equal(fs.existsSync(file), false);
    assert.equal((await GET(stop.base, '/health')).json.bridge, 'stopped', 'and no bridge was started for it');

    // a page with no session at all, and a session file that never existed
    await POST(stop.base, '/page', { url: `${url}-2`, title: 'Cold Delete 2', site: 'ledger.test' });
    const plain = await POST(stop.base, '/delete-page', { url: `${url}-2`, delete_session: true });
    assert.deepEqual(plain.json, { ok: true, session_deleted: false });
    assert.equal((await POST(stop.base, '/delete-page', { url })).status, 404, 'gone means gone');
    stop.proc.kill();
  });

  await test('a session two pages claim is never deleted', async () => {
    const sharedRoot = tmpRoot('shared');
    const shared = await startServer({ root: sharedRoot });
    const urls = ['https://ledger.test/2026/twin-a', 'https://ledger.test/2026/twin-b'];
    for (const u of urls) {
      await POST(shared.base, '/page', { url: u, title: `Twin ${u.slice(-1)}`, site: 'ledger.test' });
      const f = path.join(sharedRoot, '.botference', 'plugin', 'pages',
        `${crypto.createHash('sha1').update(u).digest('hex')}.json`);
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
      rec.session_id = 'sess-shared';
      fs.writeFileSync(f, JSON.stringify(rec));
    }
    const r = await POST(shared.base, '/delete-page', { url: urls[0], delete_session: true });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /also claimed by/);
    assert.ok((await GET(shared.base, `/page?url=${encodeURIComponent(urls[0])}`)).json.url,
      'the page survives a refused delete');
    // the page alone can still go; the chat behind it is what was protected
    const keep = await POST(shared.base, '/delete-page', { url: urls[0] });
    assert.deepEqual(keep.json, { ok: true, session_deleted: false });
    assert.equal((await GET(shared.base, `/page?url=${encodeURIComponent(urls[0])}`)).json.page, null);
    shared.proc.kill();
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
    assert.deepEqual(models.json, { ok: true, current: null, options: null, status: null,
      effort: null, verbosity: 'short', bridge: 'disabled' });
    const effort = await POST(off.base, '/effort', { agent: 'claude', level: 'high' });
    assert.equal(effort.status, 409);
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
