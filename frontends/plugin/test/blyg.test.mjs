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

// ---- report -----------------------------------------------------------------
for (const f of failures) console.log('  FAIL ' + f);
console.log(`blyg: ${pass} passed, ${fail} failed`);
process.exit(fail);
