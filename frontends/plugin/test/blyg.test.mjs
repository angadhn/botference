// blyg.test.mjs — Discuss and Blygger: is this page a blyg post, which one,
// and what is recorded about it.
//
//   node frontends/plugin/test/blyg.test.mjs
//
// Nothing here touches the network. Detection runs against the saved public
// documents in fixtures/blyg/ (sources.json says where each came from) through
// an injected transport; the guard runs against a loopback server of its own.
// No framework. Exit code is the number of failures.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// store.mjs (reached through lasso.mjs and export.mjs) reads its root once, at
// import: a throwaway one, so nothing here touches a real workspace or vault
const ROOT = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'bfp-blyg-'));
process.env.BOTFERENCE_PROJECT_ROOT = ROOT;
const require = createRequire(import.meta.url);
const CFG = require(path.join(here, '..', 'extension', 'config.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + String(detail).slice(0, 800) : ''));
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const throws = fn => { try { fn(); return false; } catch { return true; } };

// ---- the status modes and their one move function -------------------------
{
  eq('modes: one named list', CFG.BLYG_MODES,
    ['unknown', 'checking', 'blyg', 'blyg-site', 'not-a-blyg', 'check-failed']);
  ok('move: unknown → checking', CFG.blygMove('unknown', 'checking') === 'checking');
  for (const s of CFG.BLYG_SETTLED) {
    ok(`move: checking → ${s}`, CFG.blygMove('checking', s) === s);
    ok(`move: unknown → ${s} (the companion already knew)`, CFG.blygMove('unknown', s) === s);
    ok(`move: ${s} → checking (ask again)`, CFG.blygMove(s, 'checking') === 'checking');
    ok(`move: ${s} → unknown (the tab moved on)`, CFG.blygMove(s, 'unknown') === 'unknown');
  }
  ok('refused: an answer out of nowhere replacing another', throws(() => CFG.blygMove('not-a-blyg', 'blyg')));
  ok('refused: blyg → check-failed without asking again', throws(() => CFG.blygMove('blyg', 'check-failed')));
  ok('refused: checking → checking', throws(() => CFG.blygMove('checking', 'checking')));
  ok('refused: a mode that is not named', throws(() => CFG.blygMove('unknown', 'maybe')));
  ok('refused: from a mode that is not named', throws(() => CFG.blygMove('maybe', 'checking')));
  ok('canBlygMove says no without throwing', CFG.canBlygMove('blyg', 'not-a-blyg') === false);
}

// ---- the fetch guard ----------------------------------------------------------
// A loopback server stands in for misbehaving sites. The page "being read" is
// on that same host, which is the one case where a private address may be
// fetched at all; every other private address is refused.
const B = await import('../blyg.mjs');
{
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    if (req.url === '/ok.json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"blyg":"0.4"}');
    if (req.url === '/says-big') return res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) }).end();
    if (req.url === '/is-big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(64 * 1024);
      let n = 0;
      const more = () => { if (n++ < 40 && !res.destroyed) { res.write(chunk); setImmediate(more); } else res.end(); };
      return more();
    }
    if (req.url === '/slow') return; // never answers
    if (req.url === '/to-file') return res.writeHead(302, { location: 'file:///etc/hosts' }).end();
    if (req.url === '/to-private') return res.writeHead(302, { location: 'http://10.1.2.3/blyg.json' }).end();
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    res.writeHead(404).end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const page = `${base}/article`;
  const kindOf = async (url, opts) => {
    try { await B.guardedGet(url, { pageUrl: page, ...opts }); return 'fetched'; }
    catch (e) { return e.kind || ('threw ' + e.message); }
  };

  ok('guard: the local page\'s own host may be fetched', await kindOf(`${base}/ok.json`) === 'fetched');
  ok('guard: a public page may not reach this computer',
    (await B.fetchRefusal(`${base}/ok.json`, 'https://example.com/post')) !== '');
  ok('guard: …nor the private network', (await B.fetchRefusal('http://10.0.0.1/blyg.json', 'https://example.com/')) !== '');
  ok('guard: …nor link-local', (await B.fetchRefusal('http://169.254.169.254/latest', 'https://example.com/')) !== '');
  ok('guard: a local page reaches only its own host',
    (await B.fetchRefusal('http://192.168.1.1/blyg.json', page)) !== '');
  ok('guard: file: is not a web address', (await B.fetchRefusal('file:///etc/hosts', page)) !== '');
  ok('guard: neither is ftp:', (await B.fetchRefusal('ftp://example.com/blyg.json', 'https://example.com/')) !== '');
  eq('guard: a body that says it is too big is not read', await kindOf(`${base}/says-big`, { maxBytes: 1024 }), 'too-big');
  eq('guard: a body that turns out too big is abandoned', await kindOf(`${base}/is-big`, { maxBytes: 256 * 1024 }), 'too-big');
  const t0 = Date.now();
  eq('guard: a site that never answers times out', await kindOf(`${base}/slow`, { timeoutMs: 300 }), 'timeout');
  ok('guard: …and promptly', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  eq('guard: a redirect to file: is refused', await kindOf(`${base}/to-file`), 'refused');
  eq('guard: a redirect to the private network is refused', await kindOf(`${base}/to-private`), 'refused');
  eq('guard: a redirect loop ends', await kindOf(`${base}/loop`), 'network');
  srv.closeAllConnections?.();
  srv.close();
}

// ---- a pretend web made of the saved fixtures -------------------------------
// `routes` maps an exact URL to a fixture file name, a { status, text } answer,
// or a FetchTrouble kind ('timeout', 'refused', 'too-big'). Anything else is a
// 404, as on a real site. Every request is written down in `calls`.
const FIX = path.join(here, 'fixtures', 'blyg');
const fx = name => fs.readFileSync(path.join(FIX, name), 'utf8');
function fakeWeb(routes) {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return { status: 404, url, text: 'not found' };
    if (typeof r === 'string' && ['timeout', 'refused', 'too-big', 'network'].includes(r)) {
      throw new B.FetchTrouble(r, `${r}: ${url}`);
    }
    if (typeof r === 'string') return { status: 200, url, text: fx(r) };
    return { status: r.status || 200, url: r.url || url, text: r.text };
  };
  return { get, calls };
}
const VR = 'https://venkateshrao.com/blyg/';
const VR_ID = '27x0ewgc6yqq0h9e2n9g16me8n';
const VR_PAGE = `${VR}t/${VR_ID}/`;
const VR_JSON = `${VR}items/${VR_ID}.json`;
const PIN_ID = '3vzq82afn6rmyvk6vsq8abnkqh';
const AN = 'https://angadh.com/blyg/';
const AN_ID = '2a1v0zsryykw9srnzt4xd5z0hj';
const AN_PAGE = 'https://angadh.com/rockets-1';
const AN_JSON = `${AN}items/${AN_ID}.json`;
const BB = 'https://blyg.blygger.org/';

// ---- finding the manifest (§12.1) ------------------------------------------------
{
  eq('links: an item page names its JSON and no rel=blyg', B.pageLinks(fx('venkat-item-page.html'), VR_PAGE),
    { blyg: '', json: VR_JSON });
  eq('links: a root-level article names both', B.pageLinks(fx('angadh-article-page.html'), AN_PAGE),
    { blyg: `${AN}blyg.json`, json: AN_JSON });
  eq('links: a front page names neither', B.pageLinks(fx('blygger-front-page.html'), BB), { blyg: '', json: '' });
  eq('links: relative hrefs resolve, other schemes are dropped',
    B.pageLinks('<link rel="blyg" href="/b/blyg.json"><link rel="alternate" type="application/json" href="javascript:alert(1)">', 'https://x.example/a/p'),
    { blyg: 'https://x.example/b/blyg.json', json: '' });
  eq('hints: only absolute http(s) survive', B.cleanHints({ blyg: 'file:///etc/hosts', json: 'https://a.example/i.json' }),
    { blyg: '', json: 'https://a.example/i.json' });
  eq('identity: the manifest\'s folder', B.identityOf('https://Example.COM/blyg/blyg.json?x=1'), 'https://example.com/blyg/');

  const find = async (page, routes, hints = null) => {
    const w = fakeWeb(routes);
    const s = B.session(page, w.get);
    const r = await B.findManifest(s, page, hints);
    return { r, calls: w.calls };
  };
  let { r, calls } = await find(VR_PAGE, { [`${VR}blyg.json`]: 'venkat-manifest.json' });
  eq('item page under /blyg/: found by the conventional mount', [r.status, r.origin], ['found', VR]);
  eq('…after the direct probe at its own path', calls, [`${VR_PAGE}blyg.json`, `${VR}blyg.json`]);
  ({ r, calls } = await find(AN_PAGE, { [`${AN}blyg.json`]: 'angadh-manifest.json' }, { blyg: `${AN}blyg.json`, json: AN_JSON }));
  eq('root-level article: found through its rel=blyg', [r.status, r.origin], ['found', AN]);
  eq('…in two requests', calls, ['https://angadh.com/rockets-1/blyg.json', `${AN}blyg.json`]);
  ({ r } = await find(BB, { [`${BB}blyg.json`]: 'blygger-manifest.json' }));
  eq('front page at a domain root: the direct probe', [r.status, r.origin], ['found', BB]);
  ({ r, calls } = await find('https://example.com/2026/11/a-post', {}));
  eq('not a blyg: every probe answered, none a manifest', r.status, 'none');
  eq('…three requests and no more', calls.length, 3);
  ({ r } = await find(VR_PAGE, { [`${VR}blyg.json`]: { text: '{"blyg": "0.4", ' } }));
  eq('malformed manifest (not JSON) is not a manifest', r.status, 'none');
  ({ r } = await find(VR_PAGE, { [`${VR}blyg.json`]: { text: '["blyg"]' } }));
  eq('malformed manifest (not an object) is not a manifest', r.status, 'none');
  ({ r } = await find(VR_PAGE, { [`${VR}blyg.json`]: { text: '{"title":"no version key"}' } }));
  eq('malformed manifest (no blyg key) is not a manifest', r.status, 'none');
  ({ r } = await find(VR_PAGE, { [`${VR}blyg.json`]: 'timeout' }));
  eq('a probe that timed out makes "no" unsayable', r.status, 'trouble');
  ({ r } = await find(VR_PAGE, { [`${VR}blyg.json`]: 'too-big' }));
  eq('…so does an oversized answer', r.status, 'trouble');
}

// ---- which post, verified -------------------------------------------------------
const crypto = await import('node:crypto');
const sha = s => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const VR_WEB = { [`${VR}blyg.json`]: 'venkat-manifest.json', [VR_JSON]: 'venkat-item.json',
  [`${VR}items/${PIN_ID}.json`]: 'venkat-pinned-item.json', [`${VR}items/${PIN_ID}/v2.json`]: 'venkat-pinned-v2.json',
  [VR_PAGE]: 'venkat-item-page.html' };
const AN_WEB = { [`${AN}blyg.json`]: 'angadh-manifest.json', [AN_JSON]: 'angadh-item.json', [AN_PAGE]: 'angadh-article-page.html' };
const detectOn = async (page, routes, hints, opts = {}) => {
  const w = fakeWeb(routes);
  const r = await B.detect(page, hints, { get: w.get, ...opts });
  return { r, calls: w.calls };
};
{
  let { r, calls } = await detectOn(VR_PAGE, VR_WEB, { json: VR_JSON });
  eq('item page: a blyg', r.status, 'blyg');
  eq('item page: its identity', { ...r.item }, {
    origin: VR, id: VR_ID, kind: 'thread', version: 2, latest: 2, pinned: false, pinned_versions: [],
    page: VR_PAGE, pinned_page: '', json: VR_JSON, source: "Venkatesh Rao's Blyg", author: 'Venkatesh Rao' });
  eq('item page: three requests, none twice', calls, [`${VR_PAGE}blyg.json`, `${VR}blyg.json`, VR_JSON]);
  ok('item page: the version\'s HTML is held for passage checks', r.html.startsWith('<h1>It’s the Liveness, Stupid</h1>'));

  ({ r, calls } = await detectOn(AN_PAGE, AN_WEB, B.pageLinks(fx('angadh-article-page.html'), AN_PAGE)));
  eq('root-level article of a blyg mounted at /blyg/: a blyg', [r.status, r.item && r.item.origin, r.item && r.item.id, r.item && r.item.page],
    ['blyg', AN, AN_ID, AN_PAGE]);
  eq('…its author from the item, its source from the manifest', [r.item.author, r.item.source], ['Angadh Nanjangud', 'angadh.com']);
  eq('…in three requests', calls.length, 3);

  ({ r, calls } = await detectOn(VR_PAGE, VR_WEB, null));
  eq('no hints from the extension: the companion reads the page\'s links itself', [r.status, r.item && r.item.id], ['blyg', VR_ID]);
  eq('…one request more', calls[0], VR_PAGE);

  ({ r } = await detectOn(BB, { [`${BB}blyg.json`]: 'blygger-manifest.json' }, { blyg: '', json: '' }));
  eq('a blyg\'s front page: part of a blyg, not a post', [r.status, r.site && r.site.title], ['blyg-site', 'Blygger']);
  ({ r } = await detectOn(`${VR}h/favorites/`, VR_WEB, { blyg: '', json: '' }));
  eq('a collection page: part of a blyg, not a post', r.status, 'blyg-site');
  ({ r } = await detectOn('https://example.com/2026/11/a-post', {}, { blyg: '', json: '' }));
  eq('an ordinary page: not a blyg', r.status, 'not-a-blyg');

  ({ r, calls } = await detectOn('https://example.com/paper.pdf', VR_WEB, null));
  eq('a PDF is never a blyg, and nothing is fetched', [r.status, calls.length], ['not-a-blyg', 0]);
  ({ r, calls } = await detectOn('bfp-pdf://sha256/abc', VR_WEB, null));
  eq('a local file is never a blyg, and nothing is fetched', [r.status, calls.length], ['not-a-blyg', 0]);
  ({ r, calls } = await detectOn('https://example.com/viewer', VR_WEB, null, { kind: 'pdf' }));
  eq('…nor is a page the record says is a PDF', [r.status, calls.length], ['not-a-blyg', 0]);

  // a pinned post, by the id in its own path (its page carries no hints we pass)
  const PIN_PAGE = `${VR}t/${PIN_ID}/`;
  ({ r } = await detectOn(PIN_PAGE, VR_WEB, { blyg: '', json: '' }));
  eq('pinned post, live page: version 2, pinned', [r.status, r.item.version, r.item.pinned, r.item.pinned_versions, r.item.pinned_page],
    ['blyg', 2, true, [2], '']);
  ({ r } = await detectOn(`${VR}search/${PIN_ID}/`, VR_WEB, { blyg: '', json: '' }));
  eq('an id-shaped path segment is believed only where the post says its page is', r.status, 'blyg-site');

  // the same post after a third, unpinned edit: its v2/ page quotes version 2
  const pin = JSON.parse(fx('venkat-pinned-item.json'));
  const v3 = { ...pin, version: 3, content_md: pin.content_md + '\n\nA third paragraph.',
    content_html: pin.content_html + '\n<p>A third paragraph.</p>',
    changelog: [...pin.changelog, { version: 3, at: '2026-11-20T00:00:00Z', note: null }] };
  v3.content_hash = sha(v3.content_md);
  const V3_WEB = { ...VR_WEB, [`${VR}items/${PIN_ID}.json`]: { text: JSON.stringify(v3) } };
  ({ r, calls } = await detectOn(`${PIN_PAGE}v2/`, V3_WEB, { blyg: '', json: '' }));
  eq('pinned version page: quotes the pinned version', [r.status, r.item.version, r.item.latest, r.item.pinned, r.item.pinned_page, r.item.json],
    ['blyg', 2, 3, true, `${PIN_PAGE}v2/`, `${VR}items/${PIN_ID}/v2.json`]);
  ok('…and holds that version\'s words', !r.html.includes('A third paragraph'));
  ({ r } = await detectOn(PIN_PAGE, V3_WEB, { blyg: '', json: '' }));
  eq('…while the live page is version 3, not pinned', [r.item.version, r.item.pinned], [3, false]);
  ({ r } = await detectOn(`${PIN_PAGE}v1/`, V3_WEB, { blyg: '', json: '' }));
  eq('an unpinned version page is not taken at its word', r.status, 'blyg-site');

  // verification refusals
  const item = JSON.parse(fx('venkat-item.json'));
  ({ r } = await detectOn(VR_PAGE, { ...VR_WEB, [VR_JSON]: { text: JSON.stringify({ ...item, origin: 'https://mirror.example/blyg/' }) } }, { json: VR_JSON }));
  eq('origin mismatch: the document claims another origin', [r.status, /origin/.test(r.reason)], ['check-failed', true]);
  ({ r } = await detectOn(VR_PAGE, { ...VR_WEB, [VR_JSON]: { text: JSON.stringify({ ...item, content_md: item.content_md + ' (edited)' }) } }, { json: VR_JSON }));
  eq('content_hash mismatch', [r.status, /content_hash/.test(r.reason)], ['check-failed', true]);
  ({ r } = await detectOn(VR_PAGE, { ...VR_WEB, [VR_JSON]: { text: JSON.stringify({ ...item, id: PIN_ID }) } }, { json: VR_JSON }));
  ok('a document whose id is not the one asked for is not believed', r.status === 'check-failed', JSON.stringify(r));
  const elsewhere = 'https://mirror.example/copy.json';
  ({ r, calls } = await detectOn(VR_PAGE, { ...VR_WEB, [VR_JSON]: undefined, [elsewhere]: 'venkat-item.json' }, { json: elsewhere }));
  eq('a JSON link to another host is read for its id, then checked at the origin', calls.slice(-1), [VR_JSON]);
  eq('…which does not serve it: not verified', r.status, 'check-failed');
  ({ r } = await detectOn(VR_PAGE, { ...VR_WEB, [VR_JSON]: { text: '{"blyg": "0.4", "id": ' } }, { json: VR_JSON }));
  eq('a malformed item document', r.status, 'check-failed');
  ({ r } = await detectOn(VR_PAGE, { ...VR_WEB, [VR_JSON]: 'timeout' }, { json: VR_JSON }));
  eq('a slow item document: could not check', r.status, 'check-failed');
  ({ r } = await detectOn(VR_PAGE, { ...VR_WEB, [VR_JSON]: 'too-big' }, { json: VR_JSON }));
  eq('an oversized item document: could not check', r.status, 'check-failed');

  // the guard is applied with the page that is being read: a public page whose
  // rel=blyg points into the private network gets nothing fetched from there
  const w = fakeWeb({});
  const guarded = async (url, o) => {
    const why = await B.fetchRefusal(url, o.pageUrl);
    if (why) throw new B.FetchTrouble('refused', why);
    return w.get(url, o);
  };
  const pr = await B.detect('https://example.com/post', { blyg: 'http://10.0.0.8/blyg.json', json: '' }, { get: guarded });
  ok('private address: refused, and the check says it could not be made', pr.status === 'check-failed' && !w.calls.includes('http://10.0.0.8/blyg.json'), JSON.stringify(pr));
}

// ---- report -----------------------------------------------------------------
for (const f of failures) console.log('  FAIL ' + f);
console.log(`blyg: ${pass} passed, ${fail} failed`);
process.exit(fail);
