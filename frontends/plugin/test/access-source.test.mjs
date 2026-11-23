// access-source.test.mjs — a page on another website must not be able to act as the signed-in person.
//
//   node test/access-source.test.mjs
//
// With Cloudflare Access the browser's own cookie is the credential and Cloudflare turns it into the assertion header for ANY
// request that carries it. So every way a hostile page can make the browser send a request (a fetch with a foreign Origin, a
// no-cors blob, a form post, a null Origin, an image or script include, a socket, a stream) is tried against EVERY changing
// route in the route table, in `access` and `either`, as the owner and as a collaborator. Nothing may be changed or run.
// What must keep working: the extension that is configured, the companion's own pages over https, a link followed.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, request, GET, sleep } from './harness.mjs';
import { makeKey, mint, keyServer, TEAM, AUD, OWNER, ADA, EXT_ID } from './access-fake.mjs';
import { SOURCE_VERDICTS, sourceVerdict, sourceRefusal } from '../hosted.mjs';
import { ROUTES as FOLLOWING_ROUTES } from '../following.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const MARK = path.join(TEST, `pwned-${process.pid}.txt`);
const key = makeKey('k1');
const keys = await keyServer([key]);
const HOST = 'annotations.example';
const REMOTE = { host: HOST };
const EVIL = 'https://evil.example.test';
const tok = email => ({ 'cf-access-jwt-assertion': mint(key, { email }) });
const WHO = { owner: () => tok(OWNER), guest: () => tok(ADA) };

let passed = 0; const failed = [];
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n       ') : e}`); } };

const src = fs.readFileSync(SERVER, 'latin1');
const found = new Set([...src.matchAll(/req\.method === 'POST' && url === '(\/[^']*)'/g)].map(m => m[1]));
for (const r of FOLLOWING_ROUTES) if (r.method === 'POST') found.add(r.path);
const POSTS = [...found].filter(p => p !== '/auth').sort();

async function boot(mode) {
  const h = createHarness({ server: SERVER, tag: 'src', waitMs: 20000, env: { PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PUBLIC_HOSTNAMES: HOST, PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw' } });
  if (mode !== 'password') fs.writeFileSync(path.join(h.SECRETS, 'plugin-access.json'), JSON.stringify({ hosted_auth: mode, team: TEAM, aud: AUD, owner_email: OWNER, collaborators: [ADA], extension_ids: [EXT_ID], certs_url_for_tests: keys.url }));
  const srv = await h.startServer({ root: h.tmp('root'), args: ['--hosted', '--no-agents'], env: {} });
  return { h, base: srv.base, mode };
}
const send = (base, method, p, headers, body) => new Promise((resolve, reject) => {
  const q = http.request(base + p, { method, headers }, r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { } resolve({ status: r.statusCode, headers: r.headers, body: b, json }); }); });
  q.on('error', reject); q.end(body);
});
const FORM_CT = 'application/x-www-form-urlencoded';
const ATTACKS = {
  'foreign Origin, no content-type (a no-cors blob)': { headers: { origin: EVIL, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }, body: '{}' },
  'foreign Origin, text/plain': { headers: { origin: EVIL, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: '{}' },
  'null Origin (a sandboxed frame, a no-referrer form)': { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' }, body: '{}' },
  'a form post from another site': { headers: { origin: EVIL, 'sec-fetch-site': 'cross-site', 'content-type': FORM_CT }, body: 'url=https%3A%2F%2Fvictim.test%2Fa&text=x' },
  'a form post with no Origin at all': { headers: { 'content-type': FORM_CT }, body: 'url=https%3A%2F%2Fvictim.test%2Fa&text=x' },
  'cross-site fetch metadata, no Origin': { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'content-type': 'application/json' }, body: '{}' },
  'a sibling subdomain (same-site)': { headers: { origin: `https://evil.${HOST}`, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, body: '{}' },
  'our own name over plain http': { headers: { origin: `http://${HOST}`, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' },
  'an extension that is not the configured one': { headers: { origin: 'chrome-extension://' + 'b'.repeat(32), 'content-type': 'application/json' }, body: '{}' },
  'no Origin, no metadata, no content-type (a blind caller)': { headers: {}, body: '{}' },
};

const B = { access: await boot('access'), either: await boot('either'), password: await boot('password') };
const before = async b => JSON.stringify((await request(b.base, 'GET', '/index')).json);

try {
  await test('the verdicts are one named list, and the function says why', () => {
    assert.deepEqual(SOURCE_VERDICTS, ['trusted', 'unmarked', 'foreign']);
    const v = (headers, origin, method = 'POST') => sourceVerdict({ method, headers }, origin);
    assert.equal(v({}, 'trusted'), 'trusted'); assert.equal(v({}, 'foreign'), 'foreign'); assert.equal(v({}, 'absent'), 'unmarked');
    assert.equal(v({ 'sec-fetch-site': 'none' }, 'absent', 'GET'), 'unmarked');
    assert.equal(v({ 'sec-fetch-site': 'cross-site' }, 'absent'), 'foreign');
    assert.equal(v({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'absent', 'GET'), 'unmarked', 'a followed link');
    assert.equal(v({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'absent', 'POST'), 'foreign', 'a form post is not a followed link');
    assert.equal(v({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, 'absent', 'GET'), 'foreign');
    assert.equal(sourceRefusal({ method: 'POST', headers: {} }, 'absent', { tokenAuth: true }) !== null, true);
    assert.equal(sourceRefusal({ method: 'POST', headers: { 'content-type': 'application/json' } }, 'absent', { tokenAuth: true }), null);
    assert.equal(sourceRefusal({ method: 'GET', headers: {} }, 'foreign', { strictReads: false }), null, 'password mode: a plain foreign read is as before');
    assert.notEqual(sourceRefusal({ method: 'POST', headers: {} }, 'foreign', { strictReads: false }), null);
  });

  for (const mode of ['access', 'either']) {
    for (const who of ['owner', 'guest']) {
      await test(`${mode}/${who}: every changing route, under every cross-site trick, is refused and nothing is changed or run`, async () => {
        const b = B[mode];
        assert.ok(POSTS.length > 75, 'found the route table: ' + POSTS.length);
        const state = await before(b);
        const bad = [];
        for (const [name, a] of Object.entries(ATTACKS)) {
          for (const p of POSTS) {
            const r = await send(b.base, 'POST', p, { ...REMOTE, ...WHO[who](), ...a.headers }, a.body);
            if (r.status !== 403 || !/^refused: /.test((r.json && r.json.error) || '')) bad.push(`${name} ${p} -> ${r.status} ${r.body.slice(0, 50)}`);
          }
        }
        assert.deepEqual(bad.slice(0, 5), [], `${bad.length} routes were not refused`);
        assert.equal(await before(b), state, 'nothing changed');
        assert.ok(!fs.existsSync(MARK));
      });
    }
    await test(`${mode}: the chain (a page, a python block, a run, over a socket the page opened) goes nowhere`, async () => {
      const b = B[mode]; const url = 'https://victim.test/a';
      const X = { ...REMOTE, ...WHO.owner(), origin: EVIL, 'sec-fetch-site': 'cross-site' };
      let heard = '';
      const s = net.connect(Number(new URL(b.base).port), '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${EVIL}\r\ncf-access-jwt-assertion: ${WHO.owner()['cf-access-jwt-assertion']}\r\n\r\n`));
      s.on('data', d => { heard += d.toString('latin1'); }); s.on('error', () => { });
      await sleep(300);
      assert.match(heard, /^HTTP\/1.1 401/, 'the socket the page opened was refused'); assert.ok(!/101/.test(heard));
      assert.equal((await send(b.base, 'POST', '/page', X, JSON.stringify({ url, title: 't' }))).status, 403);
      const code = '```python\nopen(' + JSON.stringify(MARK) + ",'w').write('ran')\n```";
      assert.equal((await send(b.base, 'POST', '/reply', X, JSON.stringify({ url, thread_id: '__page__', text: code }))).status, 403);
      assert.equal((await send(b.base, 'POST', '/run', X, JSON.stringify({ url, thread_id: '__page__', ts: new Date().toISOString(), block_index: 0 }))).status, 403);
      await sleep(300);
      assert.ok(!fs.existsSync(MARK)); assert.ok(!(await before(b)).includes('victim.test'));
      s.destroy();
    });
    await test(`${mode}: reads and streams from another site are refused too (an image, a script, a stream, a foreign fetch)`, async () => {
      const b = B[mode];
      for (const h of [{ origin: EVIL, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
        { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' }, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, { origin: 'null' }]) {
        for (const p of ['/health', '/index', '/whoami', '/events', '/pages']) {
          const r = await send(b.base, 'GET', p, { ...REMOTE, ...WHO.owner(), ...h });
          assert.equal(r.status, 403, `${p} ${JSON.stringify(h)}`);
        }
      }
    });
    await test(`${mode}: what must keep working does: the configured extension, our own pages over https, a link followed, a caller with no browser`, async () => {
      const b = B[mode];
      const ext = { ...REMOTE, ...WHO.owner(), origin: 'chrome-extension://' + EXT_ID, 'content-type': 'application/json' };
      assert.equal((await send(b.base, 'POST', '/page', ext, JSON.stringify({ url: 'https://ok.web.test/a', title: 'a' }))).status, 200);
      assert.equal((await send(b.base, 'GET', '/whoami', ext)).json.owner, true);
      const own = { ...REMOTE, ...WHO.owner(), origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
      assert.equal((await send(b.base, 'POST', '/page', own, JSON.stringify({ url: 'https://ok.web.test/b', title: 'b' }))).status, 200);
      const form = await send(b.base, 'POST', '/rename-page', { ...own, 'content-type': FORM_CT }, 'url=' + encodeURIComponent('https://ok.web.test/b') + '&title=renamed');
      assert.notEqual(form.status, 403, 'the reading room\'s own form still posts');
      const link = await send(b.base, 'GET', '/pages', { ...REMOTE, ...WHO.owner(), accept: 'text/html', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
      assert.equal(link.status, 200, 'a link followed from another site');
      const nb = await send(b.base, 'POST', '/page', { ...REMOTE, ...WHO.owner(), 'content-type': 'application/json' }, JSON.stringify({ url: 'https://ok.web.test/c', title: 'c' }));
      assert.equal(nb.status, 200, 'a caller with no browser that says it is sending JSON');
      // a collaborator: same gate
      assert.equal((await send(b.base, 'POST', '/thread', { ...REMOTE, ...WHO.guest(), origin: EVIL, 'content-type': 'application/json' }, '{}')).status, 403);
    });
    await test(`${mode}: a socket and a stream from the configured extension are accepted; from another site are not`, async () => {
      const b = B[mode];
      const ws = origin => new Promise(resolve => {
        const s = net.connect(Number(new URL(b.base).port), '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\ncf-access-jwt-assertion: ${WHO.guest()['cf-access-jwt-assertion']}\r\n\r\n`));
        let out = ''; s.on('data', d => { out += d.toString('latin1'); }); s.on('error', () => { });
        setTimeout(() => { s.destroy(); resolve(out); }, 300);
      });
      assert.match(await ws('chrome-extension://' + EXT_ID), /^HTTP\/1.1 101/);
      for (const o of [EVIL, 'null', `http://${HOST}`, 'chrome-extension://' + 'c'.repeat(32)]) assert.match(await ws(o), /^HTTP\/1.1 401/, o);
      const sse = origin => new Promise(resolve => { const q = http.request(b.base + '/events', { headers: { ...REMOTE, ...WHO.guest(), origin } }, r => { resolve(r.statusCode); q.destroy(); }); q.on('error', () => { }); q.end(); });
      assert.equal(await sse('chrome-extension://' + EXT_ID), 200); assert.equal(await sse(EVIL), 403);
    });
  }

  await test('password mode: only what is plainly safe changed: a foreign page\'s change, stream or socket is refused; a plain foreign read is as before', async () => {
    const b = B.password; const bearer = { authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
    const post = await send(b.base, 'POST', '/thread', { ...REMOTE, ...bearer, origin: EVIL, 'content-type': 'application/json' }, '{}');
    assert.equal(post.status, 403); assert.match(post.json.error, /other websites/);
    assert.equal((await send(b.base, 'POST', '/thread', { ...REMOTE, ...bearer, 'content-type': 'application/json' }, '{}')).status, 400, 'the same request with no foreign Origin reaches the route');
    const read = await send(b.base, 'GET', '/index', { ...REMOTE, ...bearer, origin: EVIL });
    assert.equal(read.status, 200); assert.equal(read.headers['access-control-allow-origin'], undefined);
    const sse = await new Promise(resolve => { const q = http.request(b.base + '/events', { headers: { ...REMOTE, ...bearer, origin: EVIL } }, r => { resolve(r.statusCode); q.destroy(); }); q.on('error', () => { }); q.end(); });
    assert.equal(sse, 403);
    // an extension, any id, still works in password mode (nothing is pinned there)
    assert.equal((await send(b.base, 'GET', '/index', { ...REMOTE, ...bearer, origin: 'chrome-extension://' + 'd'.repeat(32) })).status, 200);
  });
} finally {
  for (const b of Object.values(B)) b.h.cleanup();
  await keys.close();
  try { fs.unlinkSync(MARK); } catch { }
}
console.log(`${failed.length ? '✗' : '✓'} access-source — ${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
process.exit(0);
