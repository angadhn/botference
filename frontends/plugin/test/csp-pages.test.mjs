// csp-pages.test.mjs — every HTML page of the companion's own origin carries a CSP, and no stored or request-supplied value becomes a
// script there (review item 1: a stored XSS on this origin would act as the owner's own page).
//
//   node test/csp-pages.test.mjs
//
// The reviewer's two probes, as tests (a page whose ADDRESS tries to break out of the live-reload script, made by the owner locally
// and by a hosted guest; the owner's /p/, /pages and /a/ must contain no executable injected script and carry the CSP), and a walk
// over every HTML route: a CSP with frame-ancestors 'none' and base-uri 'none'; every <script> carries that response's nonce (or is a
// same-origin file the CSP names); no inline event handler and no style attribute in any real tag.
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, POST, request } from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const { test, tmp, startServer, cleanup, passed, failures } = createHarness({ server: path.join(TEST, '..', 'server.mjs'), tag: 'csp', waitMs: 15000 });
const HOSTILE = ['javascript:</script><script>alert(1)</script>', 'x</script><script>alert(2)</script>', 'data:text/html,</script><script>alert(3)</script>',
  'https://e.example/"><img src=x onerror=alert(4)>', 'https://e.example/ </script><script>alert(5)</script>'];
const keyOf = u => crypto.createHash('sha1').update(u).digest('hex');
const HTML = { accept: 'text/html' };

// the checks every HTML response must pass
const checked = new Set();
function checkPage(r, label) {
  checked.add(label.split(' ')[0]);
  assert.match(String(r.headers['content-type'] || ''), /text\/html/, `${label}: html`);
  const csp = String(r.headers['content-security-policy'] || '');
  assert.ok(csp, `${label}: carries a CSP`);
  for (const d of ["frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"].filter(d => !csp.includes("default-src 'none'") || d !== "object-src 'none'")) assert.ok(csp.includes(d), `${label}: ${d} (${csp})`);
  const script = (/script-src ([^;]*)/.exec(csp) || [])[1] || (csp.includes("default-src 'none'") ? "'none'" : '');
  assert.ok(script && !/unsafe-inline|unsafe-eval|\*|https?:/.test(script), `${label}: script-src is a nonce, 'self' or 'none' (${script})`);
  const nonce = (/'nonce-([^']+)'/.exec(script) || [])[1] || '';
  for (const m of r.body.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1];
    const ok = (nonce && attrs.includes(`nonce="${nonce}"`)) || (/'self'/.test(script) && /\bsrc="\/[^/]/.test(attrs));
    assert.ok(ok, `${label}: a script without this response's nonce: <script${attrs}>`);
  }
  assert.ok(!/<[a-zA-Z][^<>]*\son[a-z]+\s*=/i.test(r.body), `${label}: no inline event handler in a real tag`);
  assert.ok(!/<[a-zA-Z][^<>]*\sstyle\s*=/i.test(r.body), `${label}: no style attribute in a real tag`);
  assert.ok(!/<script>alert|<img src=x onerror/i.test(r.body), `${label}: nothing injected became markup`);
}

// ---- local: the owner's own companion --------------------------------------------------------------
const local = await startServer({ root: tmp('local'), args: ['--no-agents'] });
const B = local.base;

await test('the reviewer\'s probe: a page whose address breaks out of the reload script is text in /p/, /pages and /a/, and every one carries the CSP', async () => {
  for (const u of HOSTILE) {
    const r = await POST(B, '/page', { url: u, title: '<img src=x onerror=alert(9)>' });
    if (r.status !== 200) continue;   // an address the companion refuses outright is fine too
    const url = r.json.url || u;
    await POST(B, '/thread', { url, quote: '</script><script>alert(6)</script>', msg: { text: '<script>alert(7)</script> <img src=x onerror=alert(8)>' } });
    for (const p of [`/p/${keyOf(url)}`, '/pages', `/a/${keyOf(url)}`]) checkPage(await request(B, 'GET', p, undefined, HTML), `${p} for ${JSON.stringify(u).slice(0, 40)}`);
  }
});

await test('every HTML route of the local companion carries the CSP: /p/, /pages (filtered), /a/, /quiz, /, /project-network/view, /test-page, /blyg-home/page, /hub', async () => {
  await POST(B, '/page', { url: 'https://n.example.test/a', title: 'A page' });
  const routes = [`/p/${keyOf('https://n.example.test/a')}`, '/pages', '/pages?tag=x&kind=pdf', `/a/${keyOf('https://n.example.test/a')}`, '/quiz', '/',
    '/project-network/view', '/test-page', '/blyg-home/page', '/hub', '/following'];
  for (const p of routes) {
    const r = await request(B, 'GET', p, undefined, HTML);
    if (r.status === 404) continue;
    assert.ok(r.status < 500, `${p}: ${r.status}`);
    if (!/text\/html/.test(String(r.headers['content-type'] || ''))) continue;
    checkPage(r, p);
  }
  for (const must of ['/pages', '/a/', '/quiz', '/project-network/view', '/test-page', '/blyg-home/page'].map(x => x)) {
    assert.ok([...checked].some(c => c === must || (must === '/a/' && c.startsWith('/a/'))), `${must} was actually checked (${[...checked].join(' ')})`);
  }
  assert.ok([...checked].some(c => c.startsWith('/p/')) && ([...checked].includes('/hub') || [...checked].includes('/following')), [...checked].join(' '));
});

// ---- hosted: a guest makes the page, the owner looks at it -------------------------------------------------
const hosted = await startServer({ root: tmp('hosted'), args: ['--hosted', '--no-agents'], env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_PUBLIC_HOSTNAMES: 'discuss.example.test' } });
const H = hosted.base;
const GUEST = { host: 'discuss.example.test', authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
const OWNER = { host: 'discuss.example.test', authorization: 'Bearer owner-pw' };

await test('the reviewer\'s hosted probe: a guest\'s page with a breaking-out address is inert in the owner\'s /p/ and /pages, with the CSP', async () => {
  const u = 'x</script><script>alert(7)</script>';
  const r = await request(H, 'POST', '/page', { url: u, title: 'T' }, GUEST);
  const url = (r.json && r.json.url) || u;
  await request(H, 'POST', '/thread', { url, quote: 'q', msg: { text: 'hi </script><script>alert(8)</script>' } }, GUEST);
  for (const p of [`/p/${keyOf(url)}`, '/pages']) {
    const page = await request(H, 'GET', p, undefined, { ...OWNER, ...HTML });
    if (page.status === 404) continue;
    checkPage(page, `owner ${p}`);
  }
});

await test('every HTML page of the hosted companion carries the CSP too: the sign-in gate, a notice, sign out, the owner\'s views', async () => {
  const gate = await request(H, 'GET', '/pages', undefined, { host: 'discuss.example.test', ...HTML });
  assert.equal(gate.status, 401);
  checkPage(gate, 'the sign-in gate');
  const bad = await request(H, 'GET', '/pages?next=%22%3E%3Cscript%3Ealert(1)%3C/script%3E', undefined, { host: 'discuss.example.test', ...HTML });
  checkPage(bad, 'the gate with a hostile next');
  for (const p of ['/signout', '/pages', '/quiz']) {
    const r = await request(H, 'GET', p, undefined, { ...OWNER, ...HTML });
    if (r.status === 404 || !/text\/html/.test(String(r.headers['content-type'] || ''))) continue;
    checkPage(r, `hosted ${p}`);
  }
  for (const must of ['the', 'hosted']) assert.ok([...checked].includes(must), `${must}: ${[...checked].join(' ')}`);
  const guestOwnerPage = await request(H, 'GET', '/quiz', undefined, { ...GUEST, ...HTML });
  if (/text\/html/.test(String(guestOwnerPage.headers['content-type'] || ''))) checkPage(guestOwnerPage, 'a notice for a guest');
});

console.log('  pages checked: ' + [...checked].join(' '));
cleanup();
console.log(`\n${passed()} passed, ${failures().length} failed`);
process.exit(failures().length ? 1 : 0);
