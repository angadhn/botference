// hosted-people.test.mjs — a hosted companion for its owner alone (PLUGIN_GUESTS=off: hosted.mjs HOSTED_PEOPLE 'owner-only').
//
//   node test/hosted-people.test.mjs
//
// Real companions started with --hosted. A request "through the tunnel" has a public Host and no loopback claim. The route table
// is WALKED (every route in server.mjs and following.mjs) as a holder of the guest password (Bearer and ?auth=) and as a holder of a
// guest cookie signed before guests were turned off: nothing but the sign-in gate. The owner still signs in and works (the form,
// a Bearer from the extension, SSE, WebSocket). Startup validation, and Access with owner-only (collaborators ignored).
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness, request, GET, FORM } from './harness.mjs';
import { makeKey, mint, keyServer, TEAM, AUD, OWNER, ADA, EXT_ID } from './access-fake.mjs';
import { ROUTES as FOLLOWING_ROUTES } from '../following.mjs';
import { hostedPeopleOf, HOSTED_PEOPLE } from '../hosted.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const REMOTE = { host: 'annotations.example' };
const PW = 'guest-pw', OPW = 'owner-pw';
const h = createHarness({ server: SERVER, tag: 'ppl', waitMs: 20000, env: { SSE_HEARTBEAT_MS: '150', PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PUBLIC_HOSTNAMES: 'annotations.example' } });
const key = makeKey('k1');
const keys = await keyServer([key]);

const src = fs.readFileSync(SERVER, 'latin1');
const found = new Set([...src.matchAll(/req\.method === '(GET|POST)' && url === '(\/[^']*)'/g)].map(m => `${m[1]} ${m[2]}`));
for (const r of FOLLOWING_ROUTES) found.add(`${r.method} ${r.path}`);
// public by design: the mode's name, the sign-in form, the tab icon (asked for separately below)
const PUBLIC = new Set(['GET /auth-mode', 'POST /auth', 'GET /favicon.ico', 'GET /favicon.png', 'GET /signout', 'POST /signout']);
const ROUTES = [...found].filter(r => !PUBLIC.has(r)).sort().map(r => r.split(' '));
const ask = (base, [m, p], headers, q = '') => request(base, m, p + q, m === 'GET' ? undefined : {}, { ...REMOTE, ...headers });

const sse = (base, headers, q = '') => new Promise(resolve => {
  const frames = []; let status = 0;
  const req = http.request(base + '/events' + q, { headers: { ...REMOTE, ...headers } }, res => {
    status = res.statusCode;
    res.on('data', c => { for (const m of String(c).matchAll(/data: (.*)/g)) { try { frames.push(JSON.parse(m[1])); } catch { /* partial */ } } });
  });
  req.on('error', () => {});
  req.end();
  setTimeout(() => resolve({ frames, status: () => status, close: () => req.destroy() }), 250);
});
const ws = (base, headers = {}, q = '') => {
  const U = new URL(base);
  return new Promise(resolve => {
    const s = net.connect(Number(U.port), U.hostname, () => {
      s.write([`GET /ws${q} HTTP/1.1`, `Host: ${REMOTE.host}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n'));
    });
    let out = Buffer.alloc(0);
    s.on('data', c => { out = Buffer.concat([out, c]); });
    s.on('error', () => {});
    setTimeout(() => resolve({ text: () => out.toString('latin1'), destroy: () => s.destroy() }), 300);
  });
};
const cookieOf = r => (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

let passed = 0; const failed = [];
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); } };

try {
  await test('the setting: one named list; PLUGIN_GUESTS on | off | unset; anything else is a plain refusal', () => {
    assert.deepEqual(HOSTED_PEOPLE, ['owner-and-guests', 'owner-only']);
    assert.deepEqual(hostedPeopleOf({}), { people: 'owner-and-guests' });
    assert.deepEqual(hostedPeopleOf({ PLUGIN_GUESTS: 'on' }), { people: 'owner-and-guests' });
    assert.deepEqual(hostedPeopleOf({ PLUGIN_GUESTS: 'off' }), { people: 'owner-only' });
    assert.match(hostedPeopleOf({ PLUGIN_GUESTS: 'no' }).error, /PLUGIN_GUESTS must be "on" or "off"/);
    assert.ok(hostedPeopleOf({ PLUGIN_GUESTS: 'OFF' }).error, 'exact words only');
  });

  // one root, two lives: guests on (a guest signs in and keeps the cookie), then guests off with the same signing secret
  const root = h.tmp('root');
  const before = await h.startServer({ root, args: ['--hosted', '--no-agents'], env: { PLUGIN_PASSWORD: PW, PLUGIN_OWNER_PASSWORD: OPW } });
  const guestLogin = await FORM(before.base, '/auth', { password: PW, handle: 'visitor', next: '/pages' }, REMOTE);
  assert.equal(guestLogin.status, 303, 'guests on: the guest signs in');
  const OLD_GUEST_COOKIE = cookieOf(guestLogin);
  assert.equal((await GET(before.base, '/pages', { ...REMOTE, cookie: OLD_GUEST_COOKIE })).status, 200, 'and the cookie works while guests are on');
  before.proc.kill();
  await new Promise(r => before.proc.once('exit', r));

  const S = await h.startServer({ root, args: ['--hosted', '--no-agents'], env: { PLUGIN_PASSWORD: PW, PLUGIN_OWNER_PASSWORD: OPW, PLUGIN_GUESTS: 'off' } });

  await test('the start line says who may sign in ("people: owner only"); /auth-mode says nothing new', async () => {
    assert.match(S.out(), /people: owner only/);
    const m = await GET(S.base, '/auth-mode', REMOTE);
    assert.deepEqual(m.json, { ok: true, auth: 'password' });
  });

  await test('every route: the guest password (Bearer, ?auth=) and an old guest cookie get only the sign-in gate (401)', async () => {
    assert.ok(ROUTES.length > 90, `found ${ROUTES.length}`);
    const holders = {
      bearer: [{ authorization: `Bearer ${PW}`, 'x-plugin-handle': 'visitor' }, ''],
      query: [{}, `?auth=${PW}&handle=visitor`],
      cookie: [{ cookie: OLD_GUEST_COOKIE }, ''],
    };
    for (const [who, [hd, q]] of Object.entries(holders)) {
      const wrong = [];
      for (const r of ROUTES) { const a = await ask(S.base, r, hd, q); if (a.status !== 401) wrong.push(`${r.join(' ')}=${a.status}`); }
      assert.deepEqual(wrong, [], `${who}: ${wrong.join(', ')}`);
    }
    // a browser asking for a page is shown the gate itself
    const page = await GET(S.base, '/pages', { ...REMOTE, cookie: OLD_GUEST_COOKIE, accept: 'text/html' });
    assert.equal(page.status, 401); assert.match(page.body, /<form method="POST" action="\/auth">/);
  });

  await test('the sign-in form: the guest password says only "wrong password", and no cookie is issued', async () => {
    for (const handle of ['visitor', '', 'ada']) {
      const r = await FORM(S.base, '/auth', { password: PW, handle, next: '/pages' }, REMOTE);
      assert.equal(r.status, 401); assert.match(r.body, /wrong password — try again/);
      assert.ok(!(r.headers['set-cookie'] || []).length, 'no cookie');
    }
    const old = await FORM(S.base, '/auth', { password: 'whatever', handle: 'visitor', next: '/pages' }, { ...REMOTE, cookie: OLD_GUEST_COOKIE });
    assert.ok(!(old.headers['set-cookie'] || []).length, 'an old guest cookie is not refreshed either');
  });

  await test('streams: a guest\'s SSE and WebSocket cannot (re)connect, by password or by the old cookie', async () => {
    for (const [hd, q] of [[{}, `?auth=${PW}&handle=visitor`], [{ cookie: OLD_GUEST_COOKIE }, ''], [{ authorization: `Bearer ${PW}` }, '']]) {
      const s = await sse(S.base, hd, q); assert.equal(s.status(), 401); s.close();
      const w = await ws(S.base, hd, q); assert.match(w.text(), /^HTTP\/1.1 401/); w.destroy();
    }
  });

  await test('the owner still signs in and works: the form, a Bearer from the extension, SSE, WebSocket', async () => {
    const login = await FORM(S.base, '/auth', { password: OPW, next: '/pages' }, REMOTE);
    assert.equal(login.status, 303);
    const oc = cookieOf(login);
    assert.equal((await GET(S.base, '/pages', { ...REMOTE, cookie: oc })).status, 200);
    assert.equal((await GET(S.base, '/whoami', { ...REMOTE, authorization: `Bearer ${OPW}` })).status, 200);
    const pg = await request(S.base, 'POST', '/page', { url: 'https://example.org/x', title: 'x' }, { ...REMOTE, authorization: `Bearer ${OPW}`, 'content-type': 'application/json' });
    assert.equal(pg.status, 200, pg.body);
    const s = await sse(S.base, {}, `?auth=${OPW}`); assert.equal(s.status(), 200); assert.equal(s.frames[0].type, 'hello'); s.close();
    const w = await ws(S.base, {}, `?auth=${OPW}`); assert.match(w.text(), /^HTTP\/1.1 101/); w.destroy();
    const sc = await sse(S.base, { cookie: oc }); assert.equal(sc.status(), 200); sc.close();
  });

  await test('the loopback is the owner, as always', async () => {
    assert.equal((await GET(S.base, '/whoami')).status, 200);
  });

  await test('startup: an unknown PLUGIN_GUESTS refuses to start; owner-only needs no PLUGIN_PASSWORD, only an owner password', async () => {
    const run = (env) => {
      const r = spawnSync(process.execPath, [SERVER, '--hosted', '--no-agents'], { encoding: 'utf8', timeout: 8000,
        env: { ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: h.tmp('s'), BOTFERENCE_SECRETS_DIR: h.SECRETS, PLUGIN_PASSWORD: '', PLUGIN_OWNER_PASSWORD: '', REVIEW_HUB_PASSWORD: '', ...env } });
      return r;
    };
    const bad = run({ PLUGIN_GUESTS: 'nope', PLUGIN_PASSWORD: PW, PLUGIN_OWNER_PASSWORD: OPW });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /PLUGIN_GUESTS must be "on" or "off"/);
    assert.match(run({ PLUGIN_OWNER_PASSWORD: OPW }).stderr, /requires PLUGIN_PASSWORD/, 'guests on still needs the shared password');
    // guests off, no shared password: it starts (and is killed by the time limit, which is a start)
    const off = run({ PLUGIN_GUESTS: 'off', PLUGIN_OWNER_PASSWORD: OPW });
    assert.ok(!/requires PLUGIN_PASSWORD/.test(off.stderr) && /people: owner only/.test(off.stdout), off.stderr + off.stdout);
  });

  await test('Access with owner-only: the collaborators list is ignored; a verified non-owner is refused "for its owner only"', async () => {
    const A = createHarness({ server: SERVER, tag: 'ppla', waitMs: 20000, env: { SSE_HEARTBEAT_MS: '150', PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PUBLIC_HOSTNAMES: 'annotations.example' } });
    try {
      fs.writeFileSync(path.join(A.SECRETS, 'plugin-access.json'), JSON.stringify({ hosted_auth: 'access', team: TEAM, aud: AUD, owner_email: OWNER,
        collaborators: [ADA], extension_ids: [EXT_ID], certs_url_for_tests: keys.url }));
      const srv = await A.startServer({ root: A.tmp('r'), args: ['--hosted', '--no-agents'], env: { PLUGIN_GUESTS: 'off' } });
      const ada = { 'cf-access-jwt-assertion': mint(key, { email: ADA }) };
      const own = { 'cf-access-jwt-assertion': mint(key, { email: OWNER }) };
      const r = await GET(srv.base, '/pages', { ...REMOTE, ...ada });
      assert.equal(r.status, 403); assert.equal(r.json.error, 'this companion is for its owner only');
      const page = await GET(srv.base, '/pages', { ...REMOTE, ...ada, accept: 'text/html' });
      assert.equal(page.status, 403); assert.match(page.body, /this companion is for its owner only/);
      assert.equal((await sse(srv.base, ada)).status(), 403);
      assert.match((await ws(srv.base, ada)).text(), /^HTTP\/1.1 401/);
      assert.equal((await GET(srv.base, '/whoami', { ...REMOTE, ...own })).status, 200, 'the owner is in');
      const s = await sse(srv.base, own); assert.equal(s.status(), 200); s.close();
    } finally { A.cleanup(); }
  });
} finally {
  h.cleanup();
  await keys.close();
}
console.log(`${failed.length ? '✗' : '✓'} hosted-people — ${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
process.exit(0);
