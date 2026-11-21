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
const web = http.createServer((req, res) => {
  const json = v => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  const p = req.url;
  if (p === '/notes/blyg.json') return json({ blyg: '0.4', title: 'Made-up Notes', author: { name: 'Test Author' }, updated: '2026-11-02T00:00:00Z' });
  if (p === `/notes/items/${ID}.json`) return json(item(ID, ORIGIN, version));
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

await test('the library and local files are never asked about', async () => {
  const r = await POST(B, '/blyg', { url: 'bfp-pdf://sha256/abc' });
  assert.equal(r.json.status, 'not-a-blyg');
});

cleanup();
web.close();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
