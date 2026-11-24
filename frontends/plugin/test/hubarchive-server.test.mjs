// hubarchive-server.test.mjs — the Archive through the companion: the routes, who may use them, and what the page serves.
//
//   node test/hubarchive-server.test.mjs
//
// Same arrangement as following-server.test.mjs: a loopback "web" behind test/fake-web.mjs serves invented blygs from memory.
// Nothing leaves this machine.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, POST, request } from './harness.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const { test, tmp, startServer, cleanup, passed, failures } = createHarness({ server: SERVER, tag: 'hubarchive', waitMs: 15000 });

const HOST = 'https://arc.web.test';
const A = `${HOST}/a/`;
const web = makeWeb();
const site = web.add(A, { title: 'Invented Notes' });
const N = 6;
for (let k = 1; k <= N; k++) site.put(makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: `Distinctive words of post ${k}.`, created: `2026-10-${String(k).padStart(2, '0')}T10:00:00Z` }));
const fakeWebServer = http.createServer(async (req, res) => {
  try { const r = await web.get(HOST + req.url); res.writeHead(r.status, { 'content-type': r.contentType || 'application/json' }).end(r.text); }
  catch { res.writeHead(502).end('down'); }
});
await new Promise(r => fakeWebServer.listen(0, '127.0.0.1', r));
const root = tmp('root');
const portFile = path.join(root, 'fake-web-port');
fs.writeFileSync(portFile, String(fakeWebServer.address().port));
const WEB_ENV = { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(path.join(TEST, 'fake-web.mjs'))}`.trim(), FAKE_WEB_PORT_FILE: portFile };
process.env.BOTFERENCE_PROJECT_ROOT = root;
const store = await import('../store.mjs');
store.saveConfig({ vault_path: tmp('vault'), export_folder: 'Web Clippings', author: 'reader' });

const srv = await startServer({ root, args: ['--no-agents'], env: { PLUGIN_BLYG_CHECKS: 'on', ...WEB_ENV } });
const B = srv.base;
const dataOf = async (q = '') => (await GET(B, '/following/data' + q)).json;
const keyOf = async n => (await dataOf()).entries.map(e => e.head).find(h => h.id === idOf(n))?.key;
const titles = async () => (await dataOf()).entries.map(e => e.head.title);

await test('the owner follows, refreshes, ticks one post: it leaves the Feed and the answer says what the page needs', async () => {
  assert.equal((await POST(B, '/following/follow', { url: `${A}f/${idOf(1)}/` })).status, 200);
  const r0 = await POST(B, '/following/refresh', {});
  assert.equal(r0.json.new, N, r0.body);
  assert.equal(r0.json.backfilled, N, 'the first sight of a blyg is a backfill, up to the target');
  const key = await keyOf(3);
  const r = await POST(B, '/following/read', { key, move: 'tick' });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual([r.json.read, r.json.unread, r.json.target, r.json.topup], ['archived', N - 1, 50, false], 'every blyg is caught up: nothing to top up from');
  assert.ok(!(await titles()).includes('Post 3'));
  const d = await dataOf('?view=archive');
  assert.equal(d.tabs.archive, 1);
  assert.equal(d.tabs.feed, N - 1);
  assert.deepEqual(d.archive.map(l => l.title), ['Post 3']);
  assert.deepEqual(d.entries, []);
  assert.equal((await POST(B, '/following/read', { key, move: 'tick' })).status, 400, 'ticking twice is refused');
});

await test('the pages: /hub shows a Read button per post, /hub?view=archive the Archive lines with no text of the post, and ?q= searches all of them', async () => {
  const feed = (await GET(B, '/hub', { accept: 'text/html' })).body;
  assert.equal((feed.match(/class="tick"/g) || []).length, N - 1);
  assert.match(feed, /aria-label="Mark as read: move to Archive">\u2713 Read<\/button>/);
  const arc = (await GET(B, '/hub?view=archive', { accept: 'text/html' })).body;
  assert.match(arc, /hub-archive-line/);
  assert.match(arc, /Post 3/);
  assert.ok(!/Distinctive words/.test(arc), 'no body text on the Archive');
  assert.match(arc, /Archive \(<span data-n="archive">1<\/span>\)/);
  const none = (await GET(B, '/hub?view=archive&q=nothing', { accept: 'text/html' })).body;
  assert.match(none, /Nothing in the Archive matches that/);
  const hit = (await GET(B, '/hub?view=archive&q=post%203', { accept: 'text/html' })).body;
  assert.match(hit, /hub-archive-line/);
});

await test('untick through the route fetches the post again (one request); tick-all-shown archives exactly the keys sent', async () => {
  const key = (await dataOf('?view=archive')).archive[0].key;
  const before = web.itemRequests().length;
  const r = await POST(B, '/following/read', { key, move: 'untick' });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.read, 'new');
  assert.equal(web.itemRequests().length, before + 1);
  assert.ok((await titles()).includes('Post 3'));
  const keys = [];
  for (const n of [1, 2]) keys.push(await keyOf(n));
  const all = await POST(B, '/following/read', { keys });
  assert.equal(all.json.archived, 2);
  assert.deepEqual((await dataOf('?view=archive')).archive.map(l => l.title).sort(), ['Post 1', 'Post 2']);
  // a thousand keys fit in one request (the engine takes the first 100 of them)
  const big = await POST(B, '/following/read', { keys: Array.from({ length: 1000 }, (_, i) => String(i).padStart(24, '0')) });
  assert.equal(big.status, 200);
  assert.equal(big.json.archived, 0);
});

await test('another website cannot tick, untick or tick-all, even with a real key: refused, and nothing changed (the request-source rule covers the new moves)', async () => {
  const key = await keyOf(4);
  const arcKey = (await dataOf('?view=archive')).archive[0].key;
  const before = JSON.stringify([(await dataOf()).tabs, (await dataOf('?view=archive')).archive.map(l => l.key)]);
  for (const hdr of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' }]) {
    for (const body of [{ key, move: 'tick' }, { key: arcKey, move: 'untick' }, { keys: [key] }, { key, move: 'renew' }]) {
      const r = await request(B, 'POST', '/following/read', body, hdr);
      assert.equal(r.status, 403, `${JSON.stringify(hdr)} ${JSON.stringify(body)}`);
    }
  }
  assert.equal(JSON.stringify([(await dataOf()).tabs, (await dataOf('?view=archive')).archive.map(l => l.key)]), before);
  // the page's own request (same-origin) is answered
  assert.equal((await request(B, 'POST', '/following/read', { key, move: 'renew' }, { 'sec-fetch-site': 'same-origin' })).status, 400, 'answered (an unopened post cannot be marked new)');
});

await test('settings: the unread target is 1 to 500; 0, 501, text and fractions are refused and the stored value is not changed', async () => {
  for (const bad of [0, -3, 501, 1.5, '50', null]) {
    const r = await POST(B, '/following/settings', { following_unread_target: bad });
    if (bad === null) { assert.equal(r.status, 200, 'null clears it to the default'); continue; }
    assert.equal(r.status, 400, `${bad}`);
    assert.match(r.json.error, /following_unread_target/);
  }
  const ok = await POST(B, '/following/settings', { following_unread_target: 20 });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(ok.json.settings.following_unread_target, 20);
  assert.equal((await dataOf()).target, 20);
  assert.equal((await POST(B, '/following/settings', { following_unread_target: 500 })).status, 200);
  assert.equal((await POST(B, '/following/settings', { following_unread_target: 1 })).status, 200);
  await POST(B, '/following/settings', { following_unread_target: 50 });
});

await test('the new routes: /following/topup (no index read), Retry on /following/state, unfollow keeping or forgetting what was read', async () => {
  const t = await POST(B, '/following/topup', {});
  assert.equal(t.status, 200, t.body);
  assert.equal(typeof t.json.started, 'boolean');
  const again = await POST(B, '/following/topup', {});
  assert.equal(again.json.started, false, 'not twice within 30 seconds');
  const retry = await POST(B, '/following/state', { origin: A, move: 'retry' });
  assert.equal(retry.status, 400);
  assert.match(retry.json.error, /not paused/);
  assert.equal((await POST(B, '/following/state', { origin: A, move: 'stop' })).status, 400);
  for (const hdr of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await request(B, 'POST', '/following/topup', {}, hdr)).status, 403);
  }
  const archived = (await dataOf('?view=archive')).tabs.archive;
  assert.ok(archived > 0);
  assert.equal((await POST(B, '/following/unfollow', { origin: A })).status, 200);
  assert.equal((await POST(B, '/following/follow', { url: `${A}f/${idOf(1)}/` })).status, 200);
  await POST(B, '/following/refresh', {});
  const back = await dataOf();
  assert.equal(back.tabs.feed, N - archived, 'a refollow does not bring back what was read');
  assert.equal((await POST(B, '/following/unfollow', { origin: A, forget: true })).status, 200);
  assert.equal((await POST(B, '/following/follow', { url: `${A}f/${idOf(1)}/` })).status, 200);
  await POST(B, '/following/refresh', {});
  assert.equal((await dataOf()).tabs.feed, N, 'forgotten: everything is unread again');
});

const hosted = await startServer({ root: tmp('hosted'), args: ['--hosted', '--no-agents'],
  env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_BLYG_CHECKS: 'on', ...WEB_ENV } });
const H = 'discuss.botference.com';
const GUEST = { host: H, authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
const OWNER = { host: H, authorization: 'Bearer owner-pw' };

await test('hosted: the owner can tick and untick; a guest, a wrong password and no password cannot, and the post is unchanged', async () => {
  assert.equal((await request(hosted.base, 'POST', '/following/follow', { url: `${A}f/${idOf(1)}/` }, OWNER)).status, 200);
  await request(hosted.base, 'POST', '/following/refresh', {}, OWNER);
  const d = (await request(hosted.base, 'GET', '/following/data', undefined, OWNER)).json;
  const key = d.entries[0].head.key;
  for (const [who, hdr, status] of [['no password', { host: H }, 401], ['wrong password', { host: H, authorization: 'Bearer nope' }, 401], ['a guest', GUEST, 403]]) {
    for (const body of [{ key, move: 'tick' }, { keys: [key] }, { key, move: 'untick' }]) {
      const r = await request(hosted.base, 'POST', '/following/read', body, hdr);
      assert.equal(r.status, status, `${who} ${JSON.stringify(body)}`);
    }
    const g = await request(hosted.base, 'GET', '/hub?view=archive', undefined, { ...hdr, accept: 'text/html' });
    assert.ok([401, 403].includes(g.status), `${who} cannot read the Archive page`);
  }
  const still = (await request(hosted.base, 'GET', '/following/data', undefined, OWNER)).json;
  assert.equal(still.tabs.archive, 0, 'nothing was archived by them');
  const r = await request(hosted.base, 'POST', '/following/read', { key, move: 'tick' }, OWNER);
  assert.equal(r.status, 200, r.body);
  assert.equal((await request(hosted.base, 'GET', '/following/data?view=archive', undefined, OWNER)).json.archive.length, 1);
});

cleanup();
fakeWebServer.close();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
