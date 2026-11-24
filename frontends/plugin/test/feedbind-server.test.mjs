// feedbind-server.test.mjs — a passage on a blyg's HOME FEED, verified by the companion (POST /blyg/bind, blyg.verifyShown).
//
//   node frontends/plugin/test/feedbind-server.test.mjs
//
// The "web" is a loopback server behind test/fake-web.mjs (hosts ending .web.test). One blyg lives at https://blyg.web.test/notes/
// (its home feed lists two posts); another at https://other.web.test/notes/ (a post quoted on the first's feed); a third site,
// https://evil.web.test/, copies the first blyg's markup and claims its posts.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, POST } from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const { test, tmp, startServer, cleanup, passed, failures } = createHarness({ server: SERVER, tag: 'feedbind', waitMs: 15000 });

const sha = s => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const A = '0123456789abcdefghjkmnpqrs', B = 'abcdefghjkmnpqrstvwxyz0123', Q = '7c9wk2mhq0v3xj8tn5rzfd41bg';
const ORIGIN = 'https://blyg.web.test/notes/';
const OTHER = 'https://other.web.test/other/';
const HOME = ORIGIN;
const SAYS = { [A]: 'The first post says this exact sentence.', [B]: 'The second post says something else entirely.', [Q]: 'A quoted post from another blyg says this.' };
const item = (id, origin) => {
  const md = `${SAYS[id]} More words.`;
  return { blyg: '0.4', id, kind: 'thread', origin, page: `t/${id}/`, author: { name: id === Q ? 'Other Author' : 'Feed Author' },
    created: '2026-11-01T00:00:00Z', updated: '2026-11-02T00:00:00Z', version: 1, content_md: md, content_html: `<p>${SAYS[id]} More words.</p>`,
    content_hash: sha(md), media: [], transclusions: [], changelog: [{ version: 1, at: '2026-11-02T00:00:00Z', note: null }] };
};
const feed = `<!doctype html><head><title>Notes</title><link rel="blyg" href="${ORIGIN}blyg.json"></head><body>
<article class="fragment"><div class="item-content"><p>${SAYS[A]} More words.</p></div><a class="permalink" href="/notes/t/${A}/">#</a></article>
<article class="fragment"><div class="item-content"><p>${SAYS[B]} More words.</p></div><a class="permalink" href="/notes/t/${B}/">#</a></article></body>`;
// (the loopback server sees every pretend host alike, so each site has paths of its own)
const web = http.createServer((req, res) => {
  const json = v => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  const p = req.url;
  if (p === '/notes/' || p === '/notes') return res.writeHead(200, { 'content-type': 'text/html' }).end(feed);
  if (p === '/notes/blyg.json') return json({ blyg: '0.4', title: 'Feed Notes', author: { name: 'Feed Author' } });
  if (p === `/notes/items/${A}.json`) return json(item(A, ORIGIN));
  if (p === `/notes/items/${B}.json`) return json(item(B, ORIGIN));
  if (p === '/other/blyg.json') return json({ blyg: '0.4', title: 'Other Notes' });
  if (p === `/other/items/${Q}.json`) return json(item(Q, OTHER));
  if (p === '/feed') return res.writeHead(200, { 'content-type': 'text/html' }).end(feed);
  res.writeHead(404).end('not found');
});
await new Promise(r => web.listen(0, '127.0.0.1', r));
const root = tmp('root');
const portFile = path.join(root, 'fake-web-port');
fs.writeFileSync(portFile, String(web.address().port));
const srv = await startServer({ root, args: ['--no-agents'], env: { PLUGIN_BLYG_CHECKS: 'on',
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(path.join(TEST, 'fake-web.mjs'))}`.trim(), FAKE_WEB_PORT_FILE: portFile } });
const S = srv.base;
const page = async url => (await GET(S, '/page?url=' + encodeURIComponent(url))).json;
const HINTS = { blyg: `${ORIGIN}blyg.json`, json: '' };

await test('VERIFIED: a passage on the home feed is the post\'s own text; the post\'s page record holds the verified answer, and the thread goes there', async () => {
  const r = await POST(S, '/blyg/bind', { page_url: HOME, id: A, quote: SAYS[A], hints: HINTS });
  assert.equal(r.status, 200, r.body);
  // (the address the companion keeps the record under: its store's spelling of the post's page)
  assert.deepEqual([r.json.verdict, r.json.url.replace(/\/$/, ''), r.json.id, r.json.version], ['verified', `${ORIGIN}t/${A}`, A, 1]);
  const p = await page(`${ORIGIN}t/${A}/`);
  assert.deepEqual([p.blyg.status, p.blyg.item.id, p.blyg.item.origin], ['blyg', A, ORIGIN]);
  const t = await POST(S, '/thread', { url: r.json.url, quote: SAYS[A], msg: { text: 'A response from the feed.' } });
  assert.equal(t.status, 200, t.body);
  assert.deepEqual([t.json.thread.blyg.status, t.json.thread.blyg.id, t.json.thread.blyg.passage.match], ['blyg', A, true], 'stamped as on the post\'s own page');
  assert.equal((await page(HOME)).page, null, 'nothing is recorded under the home page\'s address');
});

await test('UNVERIFIED: the claimed post does not hold the passage (the markup lied, or the wrong link came first)', async () => {
  const r = await POST(S, '/blyg/bind', { page_url: HOME, id: B, quote: SAYS[A], hints: HINTS });
  assert.equal(r.json.verdict, 'unverified');
  assert.equal((await page(`${ORIGIN}t/${B}/`)).page, null, 'no record is made for it');
});

await test('UNVERIFIED: another site copying the feed cannot point the check at a blyg on a different origin', async () => {
  // (its own /blyg.json and /feed/blyg.json are absent; its rel=blyg leads to the real blyg, on another origin)
  const r = await POST(S, '/blyg/bind', { page_url: 'https://evil.web.test/feed', id: A, quote: SAYS[A], hints: HINTS });
  assert.equal(r.json.verdict, 'unverified');
  assert.match(r.json.reason, /not on this page's own site|no blyg/);
});

await test('A QUOTED POST: verified at its own origin (its manifest\'s identity), never at the page\'s', async () => {
  const r = await POST(S, '/blyg/bind', { page_url: HOME, id: Q, origin: OTHER, quote: SAYS[Q], hints: HINTS });
  assert.deepEqual([r.json.verdict, r.json.url.replace(/\/$/, '')], ['verified', `${OTHER}t/${Q}`]);
  assert.equal((await POST(S, '/blyg/bind', { page_url: HOME, id: Q, quote: SAYS[Q], hints: HINTS })).json.verdict, 'unverified', 'not the page\'s own blyg\'s post');
  assert.equal((await POST(S, '/blyg/bind', { page_url: HOME, id: Q, origin: 'https://other.web.test/elsewhere/', quote: SAYS[Q], hints: HINTS })).json.verdict, 'unverified', 'an origin whose manifest is not there');
  assert.equal((await POST(S, '/blyg/bind', { page_url: HOME, id: Q, origin: 'javascript:alert(1)//', quote: SAYS[Q] })).json.verdict, 'unverified');
});

await test('nonsense is unverified, and a page on this computer is never fetched', async () => {
  assert.equal((await POST(S, '/blyg/bind', { page_url: HOME, id: 'not-an-id', quote: SAYS[A] })).json.verdict, 'unverified');
  assert.equal((await POST(S, '/blyg/bind', { page_url: 'http://127.0.0.1:9/x', id: A, quote: SAYS[A] })).json.verdict, 'unverified');
  assert.equal((await POST(S, '/blyg/bind', { page_url: HOME, id: A, quote: '' })).json.verdict, 'unverified');
});

cleanup();
web.close();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
