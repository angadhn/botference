// access-files.test.mjs — a file somebody put in the workspace must not be able to run as the companion's own page.
//
//   node test/access-files.test.mjs
//
// The companion's own origin is TRUSTED (a page there may POST). The workspace's files (work/, projects/, sites/), a run's figures and
// the owner's theme files are whatever a bot or a site's sources put there, so they are served inert: Content-Security-Policy: sandbox
// (no scripts; an opaque origin whose requests say Origin: null, which are foreign), X-Content-Type-Options: nosniff, and an unknown
// type as a download. Every route that answers the bytes of a stored file is walked here, in all three modes; the other file reads
// answer JSON. (A headless-browser run of the same page is in access-files-browser.test.mjs.)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, request } from './harness.mjs';
import { makeKey, mint, keyServer, TEAM, AUD, OWNER, ADA, EXT_ID } from './access-fake.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const key = makeKey('k1'); const keys = await keyServer([key]);
let passed = 0; const failed = [];
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); } };

const PAGE = 'https://files.web.test/a';
const pageKey = crypto.createHash('sha1').update(PAGE).digest('hex');
const RUN = 'r-abc-0123ab';
const EVIL_HTML = '<html><body>no</body><script>fetch("/page",{method:"POST",body:"{}"})</script></html>';
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/run",{method:"POST"})</script></svg>';
const FILES = { 'x.html': EVIL_HTML, 'x.htm': EVIL_HTML, 'x.svg': EVIL_SVG, 'x.pdf': '%PDF-1.4', 'x.txt': 'hello', 'x.json': '{}', 'x.csv': 'a,b', 'x.png': 'png', 'x.bin': '\u0001\u0002', 'x.xhtml': EVIL_HTML };

async function boot(mode) {
  const h = createHarness({ server: SERVER, tag: 'fil', waitMs: 20000, env: { PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PUBLIC_HOSTNAMES: 'annotations.example', PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw' } });
  if (mode !== 'password') fs.writeFileSync(path.join(h.SECRETS, 'plugin-access.json'), JSON.stringify({ hosted_auth: mode, team: TEAM, aud: AUD, owner_email: OWNER, collaborators: [ADA], extension_ids: [EXT_ID], certs_url_for_tests: keys.url }));
  const root = h.tmp('root');
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  for (const [n, c] of Object.entries(FILES)) fs.writeFileSync(path.join(root, 'work', n), c);
  const runDir = path.join(root, '.botference', 'plugin', 'runs', pageKey, RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'fig.svg'), EVIL_SVG); fs.writeFileSync(path.join(runDir, 'fig.png'), 'png');
  const srv = await h.startServer({ root, args: ['--hosted', '--no-agents'], env: {} });
  await request(srv.base, 'POST', '/page', { url: PAGE, title: 'files' });
  return { h, base: srv.base, mode };
}
const tok = () => ({ 'cf-access-jwt-assertion': mint(key, { email: OWNER }) });
// the owner two ways: on the loopback (no headers) and through the tunnel as a person signed in
const WAYS = { loopback: () => ({}), tunnel: () => ({ host: 'annotations.example', ...tok() }) };
const rigs = { password: await boot('password'), access: await boot('access'), either: await boot('either') };
const get = (b, p, h) => new Promise(r => http.get(b.base + p, { headers: h }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => r({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); }));

try {
  const ROUTES = [
    ...Object.keys(FILES).map(n => [`/files/work/${n}`, n]),
    [`/run-figure?url=${encodeURIComponent(PAGE)}&run=${RUN}&name=fig.svg`, 'fig.svg'], [`/run-figure?url=${encodeURIComponent(PAGE)}&run=${RUN}&name=fig.png`, 'fig.png'],
  ];
  for (const mode of ['password', 'access', 'either']) {
    for (const [way, hdr] of Object.entries(WAYS)) {
      if (mode === 'password' && way === 'tunnel') continue;
      await test(`${mode}/${way}: every stored file is served inert (sandbox, nosniff; a PDF is not sandboxed; unknown is a download)`, async () => {
        for (const [p, name] of ROUTES) {
          let r = await get(rigs[mode], p, hdr());
          // /run-figure names its page by key
          if (r.status === 400 || r.status === 404) r = await get(rigs[mode], p.replace(/url=[^&]*/, `key=${pageKey}`), hdr());
          assert.equal(r.status, 200, `${p} -> ${r.status} ${r.body.slice(0, 60)}`);
          assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
          if (/\.pdf$/.test(name)) assert.equal(r.headers['content-security-policy'], undefined, 'a PDF viewer does not run inside a sandbox');
          else assert.equal(r.headers['content-security-policy'], 'sandbox', p + ' has a sandbox with no allow-scripts and no allow-same-origin');
          if (/\.(bin|pdf|xhtml)$/.test(name)) assert.equal(r.headers['content-disposition'], 'attachment', p + ' is a download');
          else assert.equal(r.headers['content-disposition'], undefined, p);
          assert.ok(!/allow-/.test(r.headers['content-security-policy'] || ''), 'nothing is allowed back');
        }
      });
    }
  }
  await test('the JSON forms of the same files are JSON (never the bytes with a page type)', async () => {
    const r = await get(rigs.access, '/files/work/x.html?as=json', WAYS.tunnel());
    assert.match(r.headers['content-type'], /application\/json/); assert.ok(JSON.parse(r.body).data_url.startsWith('data:text/html'));
  });
  await test('the answer to a cross-site navigation with the owner\'s cookie is inert too (the stored-XSS-by-link case)', async () => {
    const r = await get(rigs.access, '/files/work/x.html', { ...WAYS.tunnel(), 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    assert.equal(r.status, 200); assert.equal(r.headers['content-security-policy'], 'sandbox');
    // …and a script that did run in an opaque origin could not act: its requests say Origin: null
    for (const b of [rigs.access, rigs.either]) {
      const post = await request(b.base, 'POST', '/page', { url: 'https://nope.web.test/a', title: 'x' }, { host: 'annotations.example', ...tok(), origin: 'null', 'sec-fetch-site': 'cross-site' });
      assert.equal(post.status, 403);
    }
  });
  await test('the other files the companion serves are its own: the extension\'s scripts, the favicon, the reading pages (not stored files)', async () => {
    for (const p of ['/assets/anchor.js', '/favicon.ico']) assert.equal((await get(rigs.access, p, WAYS.loopback())).status, 200, p);
    const art = await get(rigs.access, `/a/${pageKey}`, WAYS.loopback());
    assert.ok([200, 404].includes(art.status));
  });
} finally { for (const r of Object.values(rigs)) r.h.cleanup(); await keys.close(); }
console.log(`${failed.length ? '✗' : '✓'} access-files — ${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
process.exit(0);
