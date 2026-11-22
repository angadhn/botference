// following-server.test.mjs — Following through the companion, end to end.
//
//   node test/following-server.test.mjs
//
// The "web" is a loopback server behind test/fake-web.mjs (hosts ending
// .web.test get a public address), serving invented blygs from memory
// (test/following-fake.mjs). Bots are off. Nothing leaves this machine.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, POST, request } from './harness.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';
import { ROUTES, keyOf } from '../following.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const { test, waitFor, tmp, startServer, cleanup, passed, failures } =
  createHarness({ server: SERVER, tag: 'following', waitMs: 15000 });

const HOST = 'https://fol.web.test';
const A = `${HOST}/a/`;
const H = `${HOST}/h/`;
const web = makeWeb();
const site = web.add(A, { title: 'Invented Notes', author: 'Invented Author' });
const ID1 = idOf(1), ID2 = idOf(2);
site.put(makeDoc({ id: ID1, origin: A, kind: 'thread', title: 'A made-up thread', body: 'Some invented words for the thread.', version: 2,
  created: '2026-11-05T10:00:00Z', updated: '2026-11-05T10:00:00Z', transclusions: [] }));
site.put(makeDoc({ id: ID2, origin: A, title: 'A made-up fragment', body: 'A short invented fragment.', created: '2026-11-04T10:00:00Z' }));
// a hostile blyg: markup and override characters in every field a reader might see
const bad = web.add(H, { title: '<script>alert("blyg")</script>‮evil', author: '"><img src=x onerror=alert(1)>' });
const HID = idOf(9);
bad.put(makeDoc({ id: HID, origin: H, title: '&lt;script&gt;alert(1)&lt;/script&gt;‮',
  body: '&lt;img src=x onerror=alert(1)&gt; &lt;a href="javascript:alert(1)"&gt;click&lt;/a&gt; ‮txet', author: '"><svg onload=alert(2)>' }));

const fakeWebServer = http.createServer(async (req, res) => {
  try {
    const r = await web.get(HOST + req.url);
    res.writeHead(r.status, { 'content-type': r.contentType || 'application/json' }).end(r.text);
  } catch { res.writeHead(502).end('down'); }
});
await new Promise(r => fakeWebServer.listen(0, '127.0.0.1', r));

const root = tmp('root');
const portFile = path.join(root, 'fake-web-port');
fs.writeFileSync(portFile, String(fakeWebServer.address().port));
const vault = tmp('vault');
process.env.BOTFERENCE_PROJECT_ROOT = root;
const store = await import('../store.mjs');
store.saveConfig({ vault_path: vault, export_folder: 'Web Clippings', author: 'reader' });
const WEB_ENV = { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(path.join(TEST, 'fake-web.mjs'))}`.trim(), FAKE_WEB_PORT_FILE: portFile };

const srv = await startServer({ root, args: ['--no-agents'], env: { PLUGIN_BLYG_CHECKS: 'on', ...WEB_ENV } });
const B = srv.base;
const dataOf = async (q = '') => (await GET(B, '/following/data' + q)).json;
const PAGE1 = `${A}t/${ID1}/`;
const HINTS = { blyg: `${A}blyg.json`, json: `${A}items/${ID1}.json` };

await test('follow by a post URL, refresh, and the data route lists it newest first', async () => {
  let r = await POST(B, '/following/follow', { url: PAGE1 });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.origin, A);
  r = await POST(B, '/following/refresh', {});
  assert.equal(r.json.new, 2, r.body);
  const d = await dataOf();
  assert.deepEqual(d.entries.map(e => e.head.id), [ID1, ID2]);
  assert.equal(d.entries[0].head.versions_note, '2 versions');
  assert.equal(d.entries[0].head.blyg_title, 'Invented Notes');
  assert.equal(d.counts.new, 2);
  assert.equal(d.run.state, 'idle');
  const page = await GET(B, '/following', { accept: 'text/html' });
  assert.equal(page.status, 200);
  assert.match(page.body, /A made-up thread/);
  assert.match(page.body, /2 versions/);
  // stored in the profile's data folder, in a file of its own
  assert.ok(fs.existsSync(path.join(root, '.botference', 'plugin', 'following.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.botference', 'plugin', 'following.json'), 'utf8')).items[keyOf(A, ID1)].version, 2);
});

await test('a second refresh while one runs is refused, not run alongside', async () => {
  web.delayMs = 60;
  const first = POST(B, '/following/refresh', {});
  await new Promise(r => setTimeout(r, 30));
  const second = await POST(B, '/following/refresh', {});
  assert.equal(second.json.started, false);
  assert.equal((await first).json.started, true);
  web.delayMs = 0;
});

await test('Open: marks the post opened, sends the reader to the ORIGINAL page, and Discuss is told which post it is', async () => {
  const key = keyOf(A, ID1);
  const r = await GET(B, '/following/open?key=' + key);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, PAGE1, 'the original page, not a copy');
  assert.equal((await dataOf()).entries.find(e => e.head.id === ID1).head.read, 'opened');
  assert.equal((await GET(B, '/following/open?key=nope')).status, 404);
  // the page loads: the extension asks about it with the page's own two links; detection is skipped
  const before = web.requests.length;
  const q = await POST(B, '/blyg', { url: PAGE1, hints: HINTS });
  assert.equal(q.json.status, 'blyg', q.body);
  assert.deepEqual([q.json.item.origin, q.json.item.id, q.json.item.version], [A, ID1, 2]);
  assert.equal(web.requests.length, before, 'no request was made to find out');
  // …and a highlight is stamped with that identity, again with no request
  await POST(B, '/page', { url: PAGE1, title: 'A made-up thread', blyg_hints: HINTS });
  const th = (await POST(B, '/thread', { url: PAGE1, quote: 'invented words', msg: { text: 'a note' }, blyg_hints: HINTS })).json.thread;
  assert.deepEqual([th.blyg.status, th.blyg.origin, th.blyg.id, th.blyg.version], ['blyg', A, ID1, 2]);
  assert.ok(!('passage' in th.blyg), 'a passage is not judged against an excerpt');
  assert.equal(web.requests.length, before);
});

await test('Open: when the page disagrees with the list, the list is not used, detection runs, and the disagreement is shown', async () => {
  const before = web.requests.length;
  const q = await POST(B, '/blyg', { url: PAGE1, hints: { blyg: `${A}blyg.json`, json: `${A}items/${ID2}.json` } });
  assert.ok(web.requests.length > before, 'the check ran');
  assert.notEqual(q.json.status, 'blyg', 'the list\'s word was not used for a page that contradicts it');
  const d = await dataOf();
  const head = d.entries.find(e => e.head.id === ID1).head;
  assert.equal(head.identity, 'disagrees');
  const html = (await GET(B, '/following', { accept: 'text/html' })).body;
  assert.match(html, /its page disagreed with this list/);
  assert.match(html, /names post/);
});

await test('exporting a note for a followed post sets it responded', async () => {
  const key = keyOf(A, ID2);
  const PAGE2 = `${A}f/${ID2}/`;
  const hints = { blyg: `${A}blyg.json`, json: `${A}items/${ID2}.json` };
  await POST(B, '/page', { url: PAGE2, title: 'A made-up fragment', blyg_hints: hints });
  await POST(B, '/thread', { url: PAGE2, quote: 'short invented', msg: { text: 'my reply' }, blyg_hints: hints });
  assert.equal((await dataOf()).entries.find(e => e.head.id === ID2).head.read, 'new');
  const before = web.requests.length;
  const r = await POST(B, '/export', { url: PAGE2, mode: 'all', blyg_hints: hints });
  assert.equal(r.status, 200, r.body);
  assert.ok(web.requests.slice(before).some(u => u.endsWith(`items/${ID2}.json`)),
    'the export asks the post\'s own site for its words even though the list knows the post (the list keeps only an excerpt)');
  assert.equal((await dataOf()).entries.find(e => e.head.id === ID2).head.read, 'responded');
  // and an opened-then-responded post is not dragged back by Open
  assert.equal((await GET(B, '/following/open?key=' + key)).status, 302);
  assert.equal((await dataOf()).entries.find(e => e.head.id === ID2).head.read, 'responded');
});

await test('read: see, see-all; illegal moves are refused', async () => {
  const key = keyOf(A, ID1);
  let r = await POST(B, '/following/read', { key, move: 'see' });
  assert.equal(r.status, 400, 'an opened post cannot be "seen"');
  assert.match(r.json.error, /cannot see while opened/);
  r = await POST(B, '/following/read', { key, move: 'respond' });
  assert.equal(r.status, 400, 'responded is set by the export alone');
  r = await POST(B, '/following/read', { all: true });
  assert.equal(r.status, 200);
});

await test('settings are validated; my_origins drives "Responses to me"', async () => {
  let r = await POST(B, '/following/settings', { following_refresh_minutes: 1 });
  assert.equal(r.status, 400);
  r = await POST(B, '/following/settings', { my_origins: ['javascript:alert(1)'] });
  assert.equal(r.status, 400);
  r = await POST(B, '/following/settings', { following_refresh_minutes: 45, my_origins: [`${HOST}/mine`] });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.settings.following_refresh_minutes, 45);
  assert.deepEqual(r.json.settings.my_origins, [`${HOST}/mine/`]);
  assert.deepEqual((await dataOf('?filter=responses')).entries, []);
  site.put(makeDoc({ id: idOf(3), origin: A, kind: 'thread', title: 'Answering you', stub_of: { origin: `${HOST}/mine/`, id: idOf(50) },
    created: '2026-11-06T10:00:00Z', updated: '2026-11-06T10:00:00Z', transclusions: [] }));
  await POST(B, '/following/refresh', {});
  assert.deepEqual((await dataOf('?filter=responses')).entries.map(e => e.head.id), [idOf(3)]);
});

await test('pause, resume, unfollow through the routes', async () => {
  assert.equal((await POST(B, '/following/state', { origin: A, move: 'pause' })).json.state, 'paused');
  assert.equal((await POST(B, '/following/state', { origin: A, move: 'pause' })).status, 400, 'paused cannot be paused');
  assert.equal((await POST(B, '/following/state', { origin: A, move: 'explode' })).status, 400);
  assert.equal((await POST(B, '/following/state', { origin: A, move: 'resume' })).json.state, 'active');
});

await test('import: preview adds nothing, confirm adds what was ticked', async () => {
  const pasted = JSON.stringify({ blygs: [{ origin: H, title: 'Hostile', feed: `${H}feed.xml` }] });
  let r = await POST(B, '/following/import-preview', { text: pasted });
  assert.deepEqual(r.json.preview.add.map(a => a.origin), [H]);
  assert.equal((await dataOf()).blygs.length, 1);
  r = await POST(B, '/following/import-confirm', { entries: r.json.preview.add });
  assert.deepEqual(r.json.added, [H]);
  assert.equal((await dataOf()).blygs.length, 2);
});

await test('hostile titles, excerpts, authors and addresses are text: nothing is markup, nothing is a link, no override characters', async () => {
  await POST(B, '/following/refresh', {});
  const html = (await GET(B, '/following', { accept: 'text/html' })).body;
  const body = html.replace(/<script>[\s\S]*?<\/script>/, '[our script]');
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the hostile post title is there, as escaped text');
  assert.ok(body.includes('&lt;script&gt;alert(&quot;blyg&quot;)'), 'and so is the hostile blyg title');
  assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'), 'and the excerpt');
  assert.ok(!/<script>alert/i.test(body) && !/<img\b/i.test(body) && !/<svg\b/i.test(body), 'no remote markup became an element');
  assert.ok(!/<[^>]*\son(error|load)\s*=/i.test(body), 'no event-handler attribute on any element');
  assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(html), 'no bidi override characters reach the page');
  for (const m of body.matchAll(/\shref="([^"]*)"/g)) assert.match(m[1], /^\/(following|pages)/, `href ${m[1]}`);
  assert.equal((html.match(/<script>/g) || []).length, 1, 'one script: ours');
});

// ---- every route is behind the same gate ------------------------------------
await test('every new route refuses a request from another website on the loopback', async () => {
  for (const rt of ROUTES) {
    const r = await request(B, rt.method, rt.path + (rt.path === '/following/open' ? '?key=x' : ''), rt.method === 'POST' ? {} : undefined,
      { origin: 'https://evil.example' });
    assert.equal(r.status, 403, `${rt.method} ${rt.path}`);
  }
});

const hostedRoot = tmp('hosted');
const hosted = await startServer({ root: hostedRoot, args: ['--hosted', '--no-agents'],
  env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_BLYG_CHECKS: 'on', ...WEB_ENV } });
const GUEST = { host: 'discuss.botference.com', authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
const OWNER = { host: 'discuss.botference.com', authorization: 'Bearer owner-pw' };

await test('hosted: every new route refuses an unauthenticated request (and a wrong password), and a guest', async () => {
  const seen = web.requests.length;
  for (const rt of ROUTES) {
    const path = rt.path + (rt.path === '/following/open' ? '?key=x' : '');
    const body = rt.method === 'POST' ? { url: PAGE1, origin: A, text: '{}', entries: [], key: 'x' } : undefined;
    const anon = await request(hosted.base, rt.method, path, body, { host: 'discuss.botference.com' });
    assert.equal(anon.status, 401, `unauthenticated ${rt.method} ${rt.path}`);
    const wrong = await request(hosted.base, rt.method, path, body, { host: 'discuss.botference.com', authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401, `wrong password ${rt.method} ${rt.path}`);
    const guest = await request(hosted.base, rt.method, path, body, GUEST);
    assert.equal(guest.status, 403, `a guest ${rt.method} ${rt.path}`);
  }
  assert.equal(web.requests.length, seen, 'none of them made the companion fetch anything');
  const owner = await request(hosted.base, 'GET', '/following/data', undefined, OWNER);
  assert.equal(owner.status, 200);
  const html = await request(hosted.base, 'GET', '/following', undefined, { host: 'discuss.botference.com', accept: 'text/html' });
  assert.equal(html.status, 401);
  assert.ok(!/data-act="refresh"/.test(html.body), 'the gate page shows no list');
});

await test('with Blygger checks off, Following fetches nothing', async () => {
  const offRoot = tmp('off');
  const off = await startServer({ root: offRoot, args: ['--no-agents'], env: { PLUGIN_BLYG_CHECKS: 'off', ...WEB_ENV } });
  const seen = web.requests.length;
  assert.equal((await POST(off.base, '/following/follow', { url: PAGE1 })).status, 400);
  assert.equal((await POST(off.base, '/following/refresh', {})).status, 400);
  assert.equal(web.requests.length, seen);
  assert.equal((await GET(off.base, '/following/data')).status, 200);
  off.proc.kill();
});

cleanup();
fakeWebServer.close();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
