// blyg-server.test.mjs — the companion, end to end, on a page that is a
// Blygger post and on one that is not.
//
//   node frontends/plugin/test/blyg-server.test.mjs
//
// The "web" is a loopback server behind test/fake-web.mjs, which gives hosts
// ending .web.test a public address, so the companion's guard passes for the
// reason it would in real life. The blyg on it is made up here (the hash
// rules hold), mounted at /notes/ so the conventional /blyg/ probes of the
// OTHER pages find nothing; only its pages' rel="blyg" lead to it. A second
// blyg at /slow/ answers its manifest late, to show a record made while the
// check is still running being filled in when the answer lands. Bots are off.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, POST } from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const { test, waitFor, tmp, startServer, cleanup, passed, failures } =
  createHarness({ server: SERVER, tag: 'blyg', waitMs: 15000 });

const sha = s => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ID = '0123456789abcdefghjkmnpqrs';
const SLOW_ID = 'zyxwvtsrqpnmkjhgfedcba9876';
const ID2 = 'abcdefghjkmnpqrstvwxyz0123';
const HOST = 'https://blyg.web.test';
const ORIGIN = `${HOST}/notes/`;
const PAGE = `${ORIGIN}t/${ID}/`;
const SLOW_ORIGIN = `${HOST}/slow/`;
const SLOW_PAGE = `${SLOW_ORIGIN}t/${SLOW_ID}/`;
const PLAIN = `${HOST}/plain/post`;
const PASSAGE = 'A sentence that the post really says.';
const item = (id, origin, version) => {
  const md = `# A made-up post\n\n${PASSAGE} And then some more.`;
  return {
    blyg: '0.4', id, kind: 'thread', origin, page: `t/${id}/`, author: { name: 'Test Author' },
    created: '2026-11-01T00:00:00Z', updated: '2026-11-02T00:00:00Z', version,
    content_md: md, content_html: `<h1>A made-up post</h1>\n<p>${PASSAGE} And then some more.</p>`,
    content_hash: sha(md), media: [], transclusions: [],
    changelog: Array.from({ length: version }, (_, i) => ({ version: i + 1, at: '2026-11-02T00:00:00Z', note: null })),
  };
};
let version = 2;
let slowRelease = null;
// every request the pretend web receives, by path: what a guest must never cause
const webSeen = [];
const web = http.createServer((req, res) => {
  webSeen.push(req.url);
  const json = v => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  const p = req.url;
  if (p === '/notes/blyg.json') return json({ blyg: '0.4', title: 'Made-up Notes', author: { name: 'Test Author' }, updated: '2026-11-02T00:00:00Z' });
  if (p === `/notes/items/${ID}.json`) return json(item(ID, ORIGIN, version));
  if (p === `/notes/items/${ID2}.json`) return json(item(ID2, ORIGIN, 1));
  // a post's own page, for a companion that has to read the links itself
  if (p === `/notes/t/${ID2}/`) {
    return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><head><title>A made-up post</title>'
      + `<link rel="blyg" href="${ORIGIN}blyg.json"><link rel="alternate" type="application/json" href="${ORIGIN}items/${ID2}.json">`
      + `</head><body><p>${PASSAGE}</p></body>`);
  }
  if (p === '/slow/blyg.json') {
    // held until the test lets it go
    slowRelease = () => json({ blyg: '0.4', title: 'Slow Notes', updated: '2026-11-02T00:00:00Z' });
    return;
  }
  if (p === `/slow/items/${SLOW_ID}.json`) return json(item(SLOW_ID, SLOW_ORIGIN, 1));
  res.writeHead(404).end('not found');
});
await new Promise(r => web.listen(0, '127.0.0.1', r));

const root = tmp('root');
const portFile = path.join(root, 'fake-web-port');
fs.writeFileSync(portFile, String(web.address().port));
const vault = tmp('vault');
// a page the reader annotated before Discuss knew about Blygger: written
// straight into the store, with no blyg fields at all
process.env.BOTFERENCE_PROJECT_ROOT = root;
const store = await import('../store.mjs');
store.saveConfig({ vault_path: vault, export_folder: 'Web Clippings', author: 'reader' });
const OLD_PAGE = `${ORIGIN}t/${ID}/`;
{
  const p = store.upsertPage({ url: OLD_PAGE, title: 'A made-up post' });
  store.addThread(p, { quote: PASSAGE, text: 'noted long ago', author: 'reader' });
  store.savePage(p);
}
// …and one never opened again before it is exported (from the pages list,
// say): one highlight and a page chat
const EXPORT_PAGE = `${ORIGIN}t/${ID2}/`;
{
  const p = store.upsertPage({ url: EXPORT_PAGE, title: 'Another made-up post' });
  store.addThread(p, { quote: PASSAGE, text: 'from before', author: 'reader' });
  store.appendMsg(p, store.PAGE_CHAT, { author: 'reader', text: 'an old question' });
  store.savePage(p);
}

const srv = await startServer({
  root, args: ['--no-agents'],
  env: {
    PLUGIN_BLYG_CHECKS: 'on', PLUGIN_BLYG_RECORD_WAIT_MS: '1500',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(path.join(TEST, 'fake-web.mjs'))}`.trim(),
    FAKE_WEB_PORT_FILE: portFile,
  },
});
const B = srv.base;
const HINTS = { blyg: `${ORIGIN}blyg.json`, json: `${ORIGIN}items/${ID}.json` };
const page = async url => (await GET(B, '/page?url=' + encodeURIComponent(url))).json;

await test('a record made before this existed is labelled when the page is first checked, as of the check', async () => {
  const r = await POST(B, '/blyg', { url: OLD_PAGE, hints: HINTS });
  assert.equal(r.json.status, 'blyg');
  assert.equal(r.json.item.id, ID);
  const p = await waitFor(async () => { const x = await page(OLD_PAGE); return x.blyg ? x : null; }, 'the page record');
  assert.equal(p.blyg.status, 'blyg');
  assert.equal(p.blyg.item.version, 2);
  const t = p.threads[0];
  assert.deepEqual([t.blyg.status, t.blyg.version, t.blyg.as_of, t.blyg.passage.match], ['blyg', 2, 'check', true]);
});

await test('the first highlight on a blyg post already carries the post and version', async () => {
  const url = `${PAGE}?utm_source=x`;
  const r = await POST(B, '/thread', { url, title: 'A made-up post', quote: PASSAGE, msg: { text: 'first!' }, blyg_hints: HINTS });
  assert.equal(r.status, 200, r.body);
  const b = r.json.thread.blyg;
  assert.deepEqual([b.status, b.origin, b.id, b.version, b.as_of, b.passage.match], ['blyg', ORIGIN, ID, 2, 'record', true]);
});

await test('a highlight that is not an exact passage says so, with the nearest exact text', async () => {
  const r = await POST(B, '/thread', { url: PAGE, quote: `Share ${PASSAGE} 4`, msg: { text: 'hm' }, blyg_hints: HINTS });
  assert.deepEqual(r.json.thread.blyg.passage, { match: false, nearest: PASSAGE });
});

await test('the first page-chat message carries the post too', async () => {
  // (the drawer names the page chat by its id, as every client does)
  const r = await POST(B, '/reply', { url: PAGE, thread_id: '__page__', text: 'what is this post about?', blyg_hints: HINTS });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual([r.json.msg.blyg.status, r.json.msg.blyg.id, r.json.msg.blyg.version], ['blyg', ID, 2]);
  assert.ok(!('passage' in r.json.msg.blyg));
});

await test('an old highlight keeps the version it quoted after the post changes', async () => {
  version = 3;
  // the companion holds its answer for a while; a page record made now still
  // says v2 until it asks again, and the stamp never changes either way
  const p = await page(PAGE);
  assert.ok(p.threads.every(t => t.blyg.version === 2));
});

await test('an ordinary page: no stamp on its records, and the page record says why', async () => {
  const r = await POST(B, '/thread', { url: PLAIN, quote: 'Anything at all', msg: { text: 'a note' } });
  assert.equal(r.status, 200, r.body);
  assert.ok(!('blyg' in r.json.thread));
  const p = await waitFor(async () => { const x = await page(PLAIN); return x.blyg ? x : null; }, 'the page record');
  assert.equal(p.blyg.status, 'not-a-blyg');
});

await test('a highlight made while the check is still running is stamped "checking", then filled in once', async () => {
  const hints = { blyg: `${SLOW_ORIGIN}blyg.json`, json: `${SLOW_ORIGIN}items/${SLOW_ID}.json` };
  const r = await POST(B, '/thread', { url: SLOW_PAGE, quote: PASSAGE, msg: { text: 'quick' }, blyg_hints: hints });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json.thread.blyg, { status: 'checking' });
  await waitFor(() => slowRelease, 'the slow manifest request');
  slowRelease();
  const p = await waitFor(async () => {
    const x = await page(SLOW_PAGE);
    return x.threads[0].blyg && x.threads[0].blyg.status === 'blyg' ? x : null;
  }, 'the stamp to be filled in');
  assert.deepEqual([p.threads[0].blyg.id, p.threads[0].blyg.version, p.threads[0].blyg.as_of], [SLOW_ID, 1, 'record']);
  assert.equal(p.blyg.status, 'blyg');
});

await test('marking the note as a response: one named field, anything else refused', async () => {
  let r = await POST(B, '/export-response', { url: PLAIN, response: 'yes please' });
  assert.equal(r.status, 400);
  r = await POST(B, '/export-response', { url: PLAIN, response: 'response' });
  assert.equal(r.status, 200, r.body);
  assert.equal((await page(PLAIN)).export_response, 'response');
  await POST(B, '/export-response', { url: PLAIN, response: 'not-a-response' });
  assert.ok(!('export_response' in await page(PLAIN)));
  // on a post, the version current as it is marked is kept beside it
  await POST(B, '/export-response', { url: PAGE, response: 'response' });
  const marked = await page(PAGE);
  assert.deepEqual([marked.export_response, marked.export_response_version], ['response', marked.blyg.item.version]);
  await POST(B, '/export-response', { url: PAGE, response: 'not-a-response' });
  assert.ok(!('export_response_version' in await page(PAGE)));
});

await test('a page never checked is checked at export, before the note is written', async () => {
  const r = await POST(B, '/export', { url: EXPORT_PAGE, mode: 'all' });
  assert.equal(r.status, 200, r.body);
  const note = fs.readFileSync(r.json.path, 'utf8');
  assert.equal(note, '---\nurl: https://blyg.web.test/notes/t/abcdefghjkmnpqrstvwxyz0123\nsite: blyg.web.test\n'
    + `saved: ${new Date().toISOString().slice(0, 10)}\ntags: [botference-discuss]\n`
    + `blyg_sources:\n  - ${EXPORT_PAGE}\n---\n\n# Another made-up post\n\n`
    + `from before\n\n![[${ID2} | Another made-up post]]\n> ${PASSAGE}\n\n`
    + '*Version 1 is the version current when Discuss first checked this page, which was after this highlight was made.*\n\n'
    + '## Page chat\n\nan old question\n');
  const p = await page(EXPORT_PAGE);
  assert.deepEqual([p.blyg.status, p.threads[0].blyg.as_of], ['blyg', 'check']);
});

await test('an ordinary page exports its comment, then its quote closed by its URL (the defaults)', async () => {
  const r = await POST(B, '/export', { url: PLAIN, mode: 'all' });
  const note = fs.readFileSync(r.json.path, 'utf8');
  assert.ok(note.includes(`a note\n\n> Anything at all\n>\n> ${PLAIN}\n`), note);
  assert.ok(!note.includes('blyg_sources'), note);
});

await test('the reader\'s setting blyg_checks: "off" asks about no page at all', async () => {
  store.saveConfig({ blyg_checks: 'off' });
  try {
    const before = webSeen.length;
    const url = `${ORIGIN}t/${SLOW_ID}/?fresh=1`;
    const r = await POST(B, '/thread', { url, quote: PASSAGE, msg: { text: 'checks are off' }, blyg_hints: HINTS });
    assert.equal(r.status, 200, r.body);
    assert.ok(!('blyg' in r.json.thread));
    assert.deepEqual(webSeen.slice(before), []);
  } finally { store.saveConfig({ blyg_checks: 'on' }); }
});

// ---- a guest over the tunnel never makes the companion fetch anything ------
// A second companion in hosted mode on the same pretend web. Requests carry
// the shared guest password and a tunnel Host, as a remote guest's do.
const hostedRoot = tmp('hosted');
const hostedSrv = await startServer({
  root: hostedRoot, args: ['--hosted', '--no-agents'],
  env: {
    PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_BLYG_CHECKS: 'on',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(path.join(TEST, 'fake-web.mjs'))}`.trim(),
    FAKE_WEB_PORT_FILE: portFile,
  },
});
const HB = hostedSrv.base;
const GUEST = { host: 'discuss.botference.com', authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
const OWNER = { host: 'discuss.botference.com', authorization: 'Bearer owner-pw' };
const GUEST_PAGE = `${ORIGIN}t/${ID}/`;

await test('a guest\'s /page, /thread and page-chat /reply start no check and fetch nothing', async () => {
  const before = webSeen.length;
  const local = `http://127.0.0.1:${web.address().port}/x`;
  let r = await POST(HB, '/page', { url: local, title: 'x',
    blyg_hints: { blyg: `http://127.0.0.1:${web.address().port}/api/anything?do=1`, json: '' } }, GUEST);
  assert.equal(r.status, 200, r.body);
  r = await POST(HB, '/page', { url: GUEST_PAGE, title: 'A made-up post', blyg_hints: HINTS }, GUEST);
  assert.equal(r.status, 200, r.body);
  r = await POST(HB, '/thread', { url: GUEST_PAGE, quote: PASSAGE, msg: { text: 'a guest note' }, blyg_hints: HINTS }, GUEST);
  assert.equal(r.status, 200, r.body);
  assert.ok(!('blyg' in r.json.thread), 'a guest\'s highlight is not stamped');
  r = await POST(HB, '/reply', { url: GUEST_PAGE, thread_id: '__page__', text: 'a guest question', blyg_hints: HINTS }, GUEST);
  assert.equal(r.status, 200, r.body);
  assert.ok(!('blyg' in r.json.msg), 'nor is a guest\'s page-chat message');
  await new Promise(res => setTimeout(res, 300));
  assert.deepEqual(webSeen.slice(before), [], 'the pretend web heard nothing at all');
  const p = (await GET(HB, '/page?url=' + encodeURIComponent(GUEST_PAGE), GUEST)).json;
  assert.ok(!p.blyg, 'and the page record learned nothing');
  assert.equal((await POST(HB, '/blyg', { url: GUEST_PAGE, hints: HINTS }, GUEST)).status, 403, '/blyg stays owner-only');
});

await test('the owner over the tunnel still checks, and a local page is never fetched even for the owner', async () => {
  const before = webSeen.length;
  const r = await POST(HB, '/blyg', { url: GUEST_PAGE, hints: HINTS }, OWNER);
  assert.equal(r.json.status, 'blyg', r.body);
  const local = await POST(HB, '/blyg', { url: `http://127.0.0.1:${web.address().port}/x`,
    hints: { blyg: `http://127.0.0.1:${web.address().port}/api/anything?do=1`, json: '' } }, OWNER);
  assert.equal(local.json.status, 'not-a-blyg');
  assert.ok(!webSeen.slice(before).some(u => u.startsWith('/api/') || u === '/x'), JSON.stringify(webSeen.slice(before)));
});

await test('the library and local files are never asked about', async () => {
  const r = await POST(B, '/blyg', { url: 'bfp-pdf://sha256/abc' });
  assert.equal(r.json.status, 'not-a-blyg');
});

cleanup();
web.close();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
