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
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, POST, request } from './harness.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';
import { ROUTES } from '../following.mjs';

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
const bad = web.add(H, { title: '<script>alert("blyg")</script>\u202eevil', author: '"><img src=x onerror=alert(1)>' });
const HID = idOf(9);
bad.put(makeDoc({ id: HID, origin: H, title: '&lt;script&gt;alert(1)&lt;/script&gt;\u202e',
  body: '&lt;img src=x onerror=alert(1)&gt; &lt;a href="javascript:alert(1)"&gt;click&lt;/a&gt; \u202etxet', author: '"><svg onload=alert(2)>' }));

// the owner's mentions inbox: answers only to the right bearer token, and notes what it was sent
const INBOX_TOKEN = 'tok_INVENTED_server_test_0123456789';
const inboxSeen = [];
const FIXTURE = fs.readFileSync(path.join(TEST, 'fixtures', 'following', 'inbox-invented.json'), 'utf8');
const fakeWebServer = http.createServer(async (req, res) => {
  if (req.url === '/inbox/mentions.json') {
    inboxSeen.push(req.headers.authorization || '');
    if (req.headers.authorization !== `Bearer ${INBOX_TOKEN}`) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"no"}');
    return res.writeHead(200, { 'content-type': 'application/json' }).end(FIXTURE);
  }
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
const tokenDir = tmp('token');
const tokenFile = path.join(tokenDir, 'inbox-token');
fs.writeFileSync(tokenFile, `${INBOX_TOKEN}\n`);
process.env.BOTFERENCE_PROJECT_ROOT = root;
const store = await import('../store.mjs');
store.saveConfig({ vault_path: vault, export_folder: 'Web Clippings', author: 'reader' });
const WEB_ENV = { NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(path.join(TEST, 'fake-web.mjs'))}`.trim(), FAKE_WEB_PORT_FILE: portFile };

const srv = await startServer({ root, args: ['--no-agents'], env: { PLUGIN_BLYG_CHECKS: 'on', ...WEB_ENV } });
const B = srv.base;
// a request with NO Host header at all (node's own client always adds one), as HTTP/1.0 allows
const withoutHost = (base, pathName, extra = '') => new Promise((resolve, reject) => {
  const u = new URL(base);
  const sock = net.connect(Number(u.port), u.hostname, () => sock.write(`GET ${pathName} HTTP/1.0\r\n${extra}\r\n`));
  let out = '';
  sock.on('data', c => { out += c; });
  sock.on('end', () => resolve(Number(/^HTTP\/1\.\d (\d+)/.exec(out)[1])));
  sock.on('error', reject);
});
const dataOf = async (q = '') => (await GET(B, '/following/data' + q)).json;
const keyOfPost = async id => {
  const d = await dataOf('?view=background');
  const all = [...(await dataOf()).entries.flatMap(e => [e.head, ...e.members]), ...d.background.filter(b => b.post).map(b => b.post)];
  const hit = all.find(i => i.id === id);
  return hit && hit.key;
};
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.botference', 'plugin', 'following.json'), 'utf8')).items[`${A}\n${ID1}`].version, 2);
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

await test('Open (a POST): marks the post opened and answers with the ORIGINAL page; with the page\'s own links agreeing, Discuss is told which post it is, with no request', async () => {
  const key = await keyOfPost(ID1);
  assert.match(key, /^[0-9a-f]{24}$/, 'a random key, not one computed from the post');
  assert.equal((await GET(B, '/following/open?key=' + key)).status, 404, 'there is no GET that changes state');
  const r = await POST(B, '/following/open', { key });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.url, PAGE1, 'the original page, not a copy');
  assert.equal((await dataOf()).entries.find(e => e.head.id === ID1).head.read, 'opened');
  assert.equal((await POST(B, '/following/open', { key: 'nope' })).status, 400);
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
  assert.equal(th.blyg.version_state, 'current-unpinned', 'the stamp says which kind of version was read');
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

await test('with no links from the page (the extension sends empty ones for a page without them) the list is NOT used: the post\'s site is asked', async () => {
  const before = web.requests.length;
  const PAGE2 = `${A}f/${ID2}/`;
  const q = await POST(B, '/blyg', { url: PAGE2, hints: { blyg: '', json: '' } });
  assert.ok(web.requests.length > before, 'detection ran');
  const th = (await POST(B, '/thread', { url: PAGE2, quote: 'short invented', msg: { text: 'again' }, blyg_hints: { blyg: '', json: '' } })).json.thread;
  assert.ok(web.requests.length > before);
  assert.ok(th.blyg === undefined || th.blyg.status !== 'blyg' || 'passage' in th.blyg, 'not stamped from the list');
});

await test('exporting a note for a followed post sets it responded', async () => {
  const EID = idOf(12);
  site.put(makeDoc({ id: EID, origin: A, title: 'A post to answer', body: 'A short invented answerable post.', created: '2026-11-07T09:00:00Z' }));
  await POST(B, '/following/refresh', {});
  const key = await keyOfPost(EID);
  const PAGE2 = `${A}f/${EID}/`;
  const hints = { blyg: `${A}blyg.json`, json: `${A}items/${EID}.json` };
  await POST(B, '/page', { url: PAGE2, title: 'A made-up fragment', blyg_hints: hints });
  await POST(B, '/thread', { url: PAGE2, quote: 'short invented', msg: { text: 'my reply' }, blyg_hints: hints });
  assert.equal((await dataOf()).entries.find(e => e.head.id === EID).head.read, 'new');
  const before = web.requests.length;
  const r = await POST(B, '/export', { url: PAGE2, mode: 'all', blyg_hints: hints });
  assert.equal(r.status, 200, r.body);
  assert.ok(web.requests.slice(before).some(u => u.endsWith(`items/${EID}.json`)),
    'the export asks the post\'s own site for its words even though the list knows the post (the list keeps only an excerpt)');
  assert.equal((await dataOf()).entries.find(e => e.head.id === EID).head.read, 'responded');
  // and an opened-then-responded post is not dragged back by Open
  assert.equal((await POST(B, '/following/open', { key })).status, 200);
  assert.equal((await dataOf()).entries.find(e => e.head.id === EID).head.read, 'responded');
});

await test('read: see, see-all; illegal moves are refused', async () => {
  const key = await keyOfPost(ID1);
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
  const body = html.replace(/<script nonce="[^"]*">[\s\S]*?<\/script>/, '[our script]');
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the hostile post title is there, as escaped text');
  assert.ok(body.includes('&lt;script&gt;alert(&quot;blyg&quot;)'), 'and so is the hostile blyg title');
  assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'), 'and the excerpt');
  assert.ok(!/<script>alert/i.test(body) && !/<img\b/i.test(body) && !/<svg\b/i.test(body), 'no remote markup became an element');
  assert.ok(!/<[^>]*\son(error|load)\s*=/i.test(body), 'no event-handler attribute on any element');
  assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(html), 'no bidi override characters reach the page');
  // real attributes of real tags only: the page's own links, or (inside a post's sanitised text) an http(s) or mailto link
  for (const m of body.matchAll(/<[a-zA-Z][^>]*?\shref="([^"]*)"/g)) assert.match(m[1], /^(\/(hub|pages)|#e-|https?:\/\/|mailto:)/, `href ${m[1]}`);
  assert.ok(!/<[a-zA-Z][^>]*\s(?:href|src)="\s*(?:javascript|data|vbscript):/i.test(body), 'no script or data link in any tag');
  assert.equal((html.match(/<script/g) || []).length, 1, 'one script: ours');
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

await test('with Blygger checks off, Following fetches nothing and its timer stays disarmed, whichever route is used', async () => {
  const offRoot = tmp('off');
  const off = await startServer({ root: offRoot, args: ['--no-agents'], env: { PLUGIN_BLYG_CHECKS: 'off', ...WEB_ENV } });
  const seen = web.requests.length;
  assert.equal((await POST(off.base, '/following/follow', { url: PAGE1 })).status, 400);
  assert.equal((await POST(off.base, '/following/import-preview', { url: 'https://roll.web.test/x.opml' })).status, 400);
  const r = await POST(off.base, '/following/refresh', {});
  assert.equal(r.json.started, false);
  assert.match(r.json.reason, /off/);
  // routes that would arm the timer do not
  assert.equal((await POST(off.base, '/following/import-confirm', { entries: [{ origin: A }] })).status, 200);
  assert.equal((await dataOf.call(null, '')).blygs.length >= 0, true);
  const d = (await GET(off.base, '/following/data')).json;
  assert.equal(d.blygs.length, 1);
  assert.equal(d.schedule.mode, 'off', 'following something does not arm the timer while checks are off');
  assert.equal((await POST(off.base, '/following/settings', { following_refresh_minutes: 10, inbox_api_url: 'https://fol.web.test/inbox/mentions.json' })).status, 200);
  assert.equal((await GET(off.base, '/following/data')).json.schedule.mode, 'off');
  assert.equal((await POST(off.base, '/following/unfollow', { origin: A })).status, 200);
  assert.equal(web.requests.length, seen);
  assert.equal(inboxSeen.length, 0);
  off.proc.kill();
});

await test('Following is never framed, and its one script and style carry a fresh nonce under a Content-Security-Policy', async () => {
  const get = () => GET(B, '/following', { accept: 'text/html' });
  const a = await get(), b = await get();
  for (const r of [a, b]) {
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.ok(r.body.includes(`<script nonce="${nonce}">`) && r.body.includes(`<style nonce="${nonce}">`));
    assert.equal((r.body.match(/<script/g) || []).length, 1);
    assert.equal(r.headers['x-frame-options'], 'DENY');
  }
  assert.notEqual(/nonce-([^']+)'/.exec(a.headers['content-security-policy'])[1], /nonce-([^']+)'/.exec(b.headers['content-security-policy'])[1], 'a new nonce each time');
});

await test('a request that a browser says came from another site is refused on every route, even with a trusted Origin', async () => {
  for (const rt of ROUTES) {
    for (const site of ['cross-site', 'same-site']) {
      const r = await request(B, rt.method, rt.path, rt.method === 'POST' ? { key: 'x' } : undefined, { 'sec-fetch-site': site });
      assert.equal(r.status, 403, `${rt.method} ${rt.path} (${site})`);
    }
    if (rt.method === 'POST') {
      const none = await request(B, 'POST', rt.path, { key: 'x' }, { 'sec-fetch-site': 'none' });
      assert.equal(none.status, 403, `a change is never made by "none": ${rt.path}`);
    }
  }
  assert.equal((await request(B, 'GET', '/following', undefined, { 'sec-fetch-site': 'none', accept: 'text/html' })).status, 200, 'typing the address is fine');
  assert.equal((await request(B, 'POST', '/following/open', { key: 'x' }, { 'sec-fetch-site': 'same-origin' })).status, 400, 'the page\'s own requests are answered');
});

await test('Open refuses a withdrawn post', async () => {
  const wid = idOf(11);
  site.put(makeDoc({ id: wid, origin: A, title: 'To be withdrawn', created: '2026-11-07T10:00:00Z' }));
  await POST(B, '/following/refresh', {});
  const key = await keyOfPost(wid);
  assert.ok(key);
  site.put(makeDoc({ id: wid, origin: A, kind: 'withdrawn', title: '', version: 2, created: '2026-11-07T10:00:00Z', updated: '2026-11-08T10:00:00Z' }));
  await POST(B, '/following/refresh', {});
  const r = await POST(B, '/following/open', { key });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /no such post/);
  assert.equal((await POST(B, '/following/read', { key, move: 'see' })).status, 400);
  const bg = await dataOf('?view=background');
  assert.equal(bg.background.find(b => b.post && b.post.id === wid).reason, 'withdrawn');
});

await test('Mentions end to end: the inbox is asked with the token over netguard; responses in Mentions, notices in Background; the token is nowhere', async () => {
  let r = await POST(B, '/following/settings', { inbox_api_url: 'https://fol.web.test/inbox/mentions.json', inbox_token_file: path.join(root, 'token') });
  assert.equal(r.status, 400, 'a token file inside the companion\'s own folder is refused');
  r = await POST(B, '/following/settings', { inbox_api_url: 'https://fol.web.test/inbox/mentions.json', inbox_token_file: path.join(TEST, 'token') });
  assert.equal(r.status, 400, 'and so is one inside the repository');
  r = await POST(B, '/following/settings', { inbox_api_url: 'http://fol.web.test/inbox/mentions.json' });
  assert.equal(r.status, 400, 'https only');
  r = await POST(B, '/following/settings', { inbox_api_url: 'https://fol.web.test/inbox/mentions.json', inbox_token_file: tokenFile });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.settings.inbox_token_file, tokenFile);
  await POST(B, '/following/refresh', {});
  assert.deepEqual(inboxSeen, [`Bearer ${INBOX_TOKEN}`]);
  const m = await dataOf('?view=mentions');
  assert.equal(m.inbox.state, 'ok');
  assert.deepEqual(m.mentions.map(x => x.reason).sort(), ['class unknown', 'plain mention (lower class)', 'response', 'response', 'response']);
  assert.equal(m.tabs.mentions_unseen, 5);
  const bg = await dataOf('?view=background');
  assert.deepEqual(bg.background.filter(b => b.type === 'mention').map(b => b.reason).sort(), ['linked from', 'reposted by']);
  // opening a mention: the same Open path, and it is seen
  const first = m.mentions.find(x => x.ident === 'id:m1');
  const o = await POST(B, '/following/open', { key: first.key });
  assert.equal(o.json.url, 'https://ada.example.test/a/t/00000000000000000000000001/');
  assert.equal((await dataOf()).tabs.mentions_unseen, 4);
  assert.equal((await POST(B, '/following/mention-read', { all: true })).status, 200);
  assert.equal((await dataOf()).tabs.mentions_unseen, 0);
  // the page
  const html = (await GET(B, '/following?view=mentions', { accept: 'text/html' })).body;
  assert.match(html, /On gardens/);
  assert.match(html, /2 accepted, never verified/);
  // the token is in no response and no file the companion keeps
  for (const text of [html, JSON.stringify(await dataOf('?view=mentions')), JSON.stringify(await dataOf('?view=background')),
    fs.readFileSync(path.join(root, '.botference', 'plugin', 'following.json'), 'utf8'), fs.readFileSync(path.join(root, '.botference', 'plugin', 'config.json'), 'utf8'), srv.out()]) {
    assert.ok(!text.includes(INBOX_TOKEN));
  }
  // a wrong token: unauthorised, shown as such
  fs.writeFileSync(tokenFile, 'tok_wrong_one\n');
  await POST(B, '/following/refresh', {});
  assert.equal((await dataOf('?view=mentions')).inbox.state, 'unauthorised');
  fs.writeFileSync(tokenFile, `${INBOX_TOKEN}\n`);
});

await test('DNS rebinding: a request under a rebound name is refused (421) on every kind of route, even with a same-origin Origin and Sec-Fetch-Site', async () => {
  const port = new URL(B).port;
  const rebound = { host: `attacker.example:${port}`, origin: `http://attacker.example:${port}`, 'sec-fetch-site': 'same-origin' };
  const routes = [['GET', '/following/data'], ['GET', '/hub'], ['POST', '/following/settings', { inbox_api_url: 'https://attacker.example/steal', inbox_token_file: '/etc/hosts' }],
    ['GET', '/index'], ['POST', '/export', { url: 'https://x.example/' }], ['GET', '/health'], ['GET', '/'], ['GET', '/pages'], ['GET', '/events']];
  for (const [m, p, body] of routes) {
    const r = await request(B, m, p, body, rebound);
    assert.equal(r.status, 421, `${m} ${p}`);
    assert.ok(!/inbox|steal|token|following/i.test(r.body), 'and nothing about why');
  }
  const d = (await GET(B, '/following/data')).json;
  assert.equal(d.settings.inbox_api_url.includes('attacker'), false, 'nothing the rebound page asked was done');
  // this machine's own names, on the right port, are served
  for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) assert.equal((await request(B, 'GET', '/health', undefined, { host: h })).status, 200, h);
  // another port, or no name at all, is refused
  assert.equal((await request(B, 'GET', '/health', undefined, { host: `127.0.0.1:${Number(port) + 1}` })).status, 421);
  assert.equal((await request(B, 'GET', '/health', undefined, { host: `localhost` })).status, 421);
  assert.equal(await withoutHost(B, '/health'), 421, 'no Host header at all');
});

await test('a public hostname is accepted only when configured; unconfigured, a hosted companion leaves a foreign name to its password', async () => {
  const pubRoot = tmp('pub');
  const pub = await startServer({ root: pubRoot, args: ['--no-agents'], env: { PLUGIN_BLYG_CHECKS: 'off', PLUGIN_PUBLIC_HOSTNAMES: 'hub.example.test' } });
  assert.equal((await request(pub.base, 'GET', '/health', undefined, { host: 'hub.example.test' })).status, 200);
  assert.equal((await request(pub.base, 'GET', '/health', undefined, { host: 'other.example.test' })).status, 421);
  pub.proc.kill();
  assert.equal((await request(hosted.base, 'GET', '/health', undefined, { host: 'discuss.botference.com' })).status, 401, 'hosted: the gate, not a refusal of the name');
  assert.equal((await request(hosted.base, 'GET', '/health', undefined, { host: 'discuss.botference.com', authorization: 'Bearer owner-pw' })).status, 200);
  assert.equal(await withoutHost(hosted.base, '/health'), 421);
  assert.equal((await request(hosted.base, 'GET', '/health', undefined, { host: 'localhost', 'cf-ray': 'x' })).status, 401, 'Host rewritten to localhost by a tunnel: the password gate, not a refusal');
  // a rebound name on a hosted companion, claiming to be local, still has no way in: the gate answers
  const sneaky = await request(hosted.base, 'GET', '/following/data', undefined, { host: 'attacker.example', 'x-forwarded-for': '1.2.3.4' });
  assert.equal(sneaky.status, 401);
});

await test('the Hub and its older address serve the same page', async () => {
  const a = await GET(B, '/hub', { accept: 'text/html' }), b = await GET(B, '/following', { accept: 'text/html' });
  assert.equal(a.status, 200);
  assert.match(a.body, /<title>Hub /);
  assert.match(a.body, /<h1>Hub<\/h1>/);
  assert.match(a.body, /<h2>Following<\/h2>/);
  for (const w of ['Feed', 'Mentions', 'Background']) assert.match(a.body, new RegExp(`>${w} \\(`));
  assert.equal(a.body.replace(/nonce="[^"]*"/g, ''), b.body.replace(/nonce="[^"]*"/g, ''));
});

await test('Read here: the post becomes an annotatable page (same record as the original page), identity from the document, no network for highlights; a newer version is offered, loaded on request, highlights kept or orphaned', async () => {
  const RID = idOf(21);
  const body = n => `<p>The opening paragraph stays exactly as it was.</p><p>${n}</p><p>The closing paragraph stays too.</p>`;
  const d1 = makeDoc({ id: RID, origin: A, kind: 'thread', title: 'Read here post', version: 1, created: '2026-11-09T09:00:00Z', transclusions: [] });
  d1.content_html = body('A middle sentence that will be rewritten.');
  site.put(d1);
  await POST(B, '/following/refresh', {});
  const key = await keyOfPost(RID);
  const before = web.requests.length;
  let r = await POST(B, '/following/read-here', { key });
  assert.equal(r.status, 200, r.body);
  assert.match(r.json.url, /^\/a\/[0-9a-f]{40}$/);
  assert.equal(web.requests.length, before + 1, 'one request: the post\'s own item document');
  assert.ok(web.requests.at(-1).endsWith(`items/${RID}.json`));
  assert.equal((await dataOf()).entries.find(e => e.head.id === RID).head.read, 'opened', 'reading here is opening');
  let art = await GET(B, r.json.url, { accept: 'text/html' });
  assert.equal(art.status, 200);
  assert.match(art.body, /The opening paragraph stays exactly/);
  assert.match(art.body, /<header class="hubhead hub-entry-meta">/);
  assert.match(art.body, /Invented Notes/);
  assert.match(art.headers['content-security-policy'], /img-src 'self' https: data:/);
  assert.match(art.headers['content-security-policy'], /default-src 'none'/);
  // the second press is the record already held: no request
  const n2 = web.requests.length;
  r = await POST(B, '/following/read-here', { key });
  assert.equal(r.json.kept, true);
  assert.equal(web.requests.length, n2);
  // a highlight made there (no hints: the Hub's own page), stamped from the document, no request
  const PAGE = `${A}t/${RID}/`;
  for (const q of ['opening paragraph stays exactly', 'middle sentence that will be rewritten']) {
    const t = (await POST(B, '/thread', { url: PAGE, quote: q, msg: { text: 'note on ' + q } })).json.thread;
    assert.deepEqual([t.blyg.status, t.blyg.origin, t.blyg.id, t.blyg.version, t.blyg.version_state], ['blyg', A, RID, 1, 'current-unpinned']);
    assert.deepEqual(t.blyg.passage, { match: true }, 'the passage is checked against the document\'s own text');
  }
  assert.equal(web.requests.length, n2, 'highlighting on the Hub copy asks nobody');
  assert.equal((await GET(B, '/page?url=' + encodeURIComponent(PAGE))).json.blyg.source, 'item-document');
  // the blyg publishes version 2; the Hub sees it; the page says so, and nothing under the highlights has changed
  const d2 = makeDoc({ id: RID, origin: A, kind: 'thread', title: 'Read here post', version: 2, created: '2026-11-09T09:00:00Z', updated: '2026-11-10T09:00:00Z', transclusions: [] });
  d2.content_html = body('A completely different middle.');
  d2.content_md = 'v2 markdown'; d2.content_hash = 'sha256:' + (await import('node:crypto')).createHash('sha256').update('v2 markdown').digest('hex');
  site.put(d2);
  await POST(B, '/following/refresh', {});
  art = await GET(B, r.json.url, { accept: 'text/html' });
  assert.match(art.body, /A newer version \(v2\) exists/);
  assert.match(art.body, /<form class="hubnewer" method="post" action="\/following\/read-here">/);
  assert.match(art.body, /A middle sentence that will be rewritten/, 'not swapped silently');
  // loading it: a plain form post, as the page's button does
  const load = await request(B, 'POST', '/following/read-here', undefined, { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    new URLSearchParams({ key, replace: '1' }).toString());
  assert.equal(load.status, 303);
  assert.equal(load.headers.location, r.json.url);
  const after = (await GET(B, '/page?url=' + encodeURIComponent(PAGE))).json;
  assert.deepEqual(Object.fromEntries(after.threads.map(t => [t.quote.slice(0, 10), !!t.orphaned])), { 'opening pa': false, 'middle sen': true });
  assert.equal(after.blyg.item.version, 2);
  art = await GET(B, r.json.url, { accept: 'text/html' });
  assert.match(art.body, /A completely different middle/);
  assert.ok(!/A newer version/.test(art.body));
  // export: a note for this post marks the SAME post responded
  const hints = { blyg: `${A}blyg.json`, json: `${A}items/${RID}.json` };
  const ex = await POST(B, '/export', { url: PAGE, mode: 'all', blyg_hints: hints });
  assert.equal(ex.status, 200, ex.body);
  assert.equal((await dataOf()).entries.find(e => e.head.id === RID).head.read, 'responded');
  // the Feed page: images over https allowed, nothing else remote
  const feed = await GET(B, '/hub', { accept: 'text/html' });
  assert.match(feed.headers['content-security-policy'], /default-src 'none'; script-src 'nonce-[^']+'; style-src 'nonce-[^']+'; img-src https:; connect-src 'self'/);
});

await test('the theme: served only from the owner\'s folder, behind the gate; linked after the built-in style; the CSP gains exactly style-src \'self\' and font-src \'self\'; a broken theme leaves the built-in look', async () => {
  const themeRoot = tmp('theme');
  const dir = path.join(themeRoot, 'folder'), outside = path.join(themeRoot, 'outside');
  fs.mkdirSync(dir); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(dir, 'hub.css'), "@import url('https://evil.example.test/x.css');\n.hub-main{font-family:'Invented Serif',serif;max-width:34em}\n@font-face{font-family:'Invented Serif';src:url(/hub/theme/Serif.woff2)}\n");
  fs.writeFileSync(path.join(dir, 'Serif.woff2'), 'woff2-bytes');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not served');
  fs.writeFileSync(path.join(outside, 'secret.css'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.css'), path.join(dir, 'leak.css'));
  const csp = r => r.headers['content-security-policy'];
  // before: no theme, the strict policy, no link
  let feed = await GET(B, '/hub', { accept: 'text/html' });
  assert.ok(!/font-src/.test(csp(feed)) && !/style-src 'nonce-[^']+' 'self'/.test(csp(feed)));
  assert.ok(!/hub\/theme/.test(feed.body));
  assert.match(feed.body, /Theme: none/);
  assert.equal((await GET(B, '/hub/theme/hub.css')).status, 404);
  // a theme inside the companion's own data folders is refused
  assert.equal((await POST(B, '/following/settings', { hub_theme_dir: path.join(root, '.botference', 'plugin') })).status, 400);
  assert.equal((await POST(B, '/following/settings', { hub_theme_dir: 'relative/dir' })).status, 400);
  // set
  assert.equal((await POST(B, '/following/settings', { hub_theme_dir: dir })).status, 200);
  const css = await GET(B, '/hub/theme/hub.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.match(css.headers['cache-control'], /private/);
  assert.equal(css.headers['x-content-type-options'], 'nosniff');
  assert.equal((await GET(B, '/hub/theme/Serif.woff2')).headers['content-type'], 'font/woff2');
  for (const bad of ['', 'notes.txt', 'leak.css', '..%2Foutside%2Fsecret.css', '%2e%2e/outside/secret.css', 'nothere.css', 'sub/x.css']) {
    assert.equal((await GET(B, '/hub/theme/' + bad)).status, 404, bad);
  }
  feed = await GET(B, '/hub', { accept: 'text/html' });
  const head = feed.body.slice(0, feed.body.indexOf('</head>'));
  assert.ok(head.indexOf('<style') < head.indexOf('<link rel="stylesheet" href="/hub/theme/hub.css">'), 'linked AFTER the built-in stylesheet');
  assert.match(feed.body, /Theme: ok/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp(feed))[1];
  assert.equal(csp(feed), `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' 'self'; font-src 'self'; img-src https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  assert.ok(!/unsafe|https:\/\/evil|\*/.test(csp(feed).replace('img-src https:', '')), 'no remote style, font or script is allowed, an @import of one cannot load');
  // the Hub's article view wears it too (a post read here); another article does not
  const key = await keyOfPost(idOf(21));
  const read = await POST(B, '/following/read-here', { key });
  const art = await GET(B, read.json.url, { accept: 'text/html' });
  assert.match(art.body, /<link rel="stylesheet" href="\/hub\/theme\/hub\.css">/);
  assert.match(art.body, /<body class="hub">/);
  assert.match(art.body, /<article id="bfp-article" class="hub-main hub-entry-body">/);
  assert.match(csp(art), /style-src 'nonce-[^']+' 'self'; font-src 'self'; img-src 'self' https: data:/);
  assert.match(csp(art), /default-src 'none'/);
  await POST(B, '/page', { url: 'https://plain.web.test/x', title: 'a plain page' });
  await POST(B, '/snapshot', { url: 'https://plain.web.test/x', html: '<p>plain article words</p>' });
  const plain = await GET(B, '/a/' + (await import('../store.mjs')).pageKey('https://plain.web.test/x'), { accept: 'text/html' });
  assert.equal(plain.status, 200);
  assert.ok(!/hub\/theme/.test(plain.body) && !/font-src/.test(csp(plain)), 'an ordinary article is not themed');
  // a broken theme: the built-in look is intact
  fs.rmSync(path.join(dir, 'hub.css'));
  feed = await GET(B, '/hub', { accept: 'text/html' });
  assert.match(feed.body, /Theme: unreadable \(the folder has no hub\.css\)/);
  assert.ok(!/hub\/theme/.test(feed.body.replace(/Theme folder[\s\S]*?<\/label>/, '')), 'no link to a theme that cannot be served');
  assert.ok(!/font-src/.test(csp(feed)));
  assert.match(feed.body, /<style nonce="[^"]+">\n:root\{color-scheme/, 'the built-in stylesheet is still there');
  assert.equal((await POST(B, '/following/settings', { hub_theme_dir: '' })).status, 200);
  // the markup hooks a theme restyles
  feed = await GET(B, '/hub', { accept: 'text/html' });
  assert.match(feed.body, /<body class="hub"><main class="hub-main">/);
  for (const hook of ['hub-tabs', 'hub-settings', 'hub-entry', 'hub-entry-meta', 'hub-entry-title', 'hub-entry-body', 'hub-entry-actions', 'hub-quote']) {
    assert.ok(feed.body.includes(hook), `hook ${hook}`);
  }
});

await test('theme files are behind the gate: unauthenticated, hosted, they are refused', async () => {
  assert.equal((await request(hosted.base, 'GET', '/hub/theme/hub.css', undefined, { host: 'discuss.botference.com' })).status, 401);
  assert.equal((await request(hosted.base, 'GET', '/hub/theme/hub.css', undefined, { host: 'discuss.botference.com', authorization: 'Bearer nope' })).status, 401);
  assert.equal((await request(hosted.base, 'GET', '/hub/theme/hub.css', undefined, GUEST)).status, 404, 'a guest who passes the gate gets the file if there is one (here none is set)');
});

cleanup();
fakeWebServer.close();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
