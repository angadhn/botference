// access-server.test.mjs — a hosted companion in each of its three sign-in modes (password | access | either).
//
//   node test/access-server.test.mjs
//
// Real companions, started with --hosted, against a stand-in for Cloudflare Access (access-fake.mjs: a key list on
// a local port, and tokens signed with it). A request "through the tunnel" is one with a public Host and no loopback
// claim. The route table is WALKED: every route found in server.mjs and in following.mjs is asked in each mode with no
// token, a bad token, a service token, an unlisted person's token, a collaborator's token and the owner's, and the answers
// are compared with what the password companion says to the same standing (so "owner only" refuses exactly as before).
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness, request, GET, POST, FORM, sleep } from './harness.mjs';
import { makeKey, mint, keyServer, TEAM, AUD, OWNER, ADA, NOBODY } from './access-fake.mjs';
import { ROUTES as FOLLOWING_ROUTES } from '../following.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const H = () => createHarness({ server: SERVER, tag: 'acc', waitMs: 20000, env: { SSE_HEARTBEAT_MS: '150' } });
const key = makeKey('k1');
const keys = await keyServer([key]);
const REMOTE = { host: 'annotations.example' };
const PW = 'guest-pw', OPW = 'owner-pw';

const tokenFor = (email, over = {}) => mint(key, { email, ...over });
const T = {
  owner: () => ({ 'cf-access-jwt-assertion': tokenFor(OWNER) }),
  guest: () => ({ 'cf-access-jwt-assertion': tokenFor(ADA) }),
  unlisted: () => ({ 'cf-access-jwt-assertion': tokenFor(NOBODY) }),
  service: () => ({ 'cf-access-jwt-assertion': tokenFor(undefined, { email: undefined, common_name: 'svc', identity_nonce: undefined }) }),
  bad: () => ({ 'cf-access-jwt-assertion': tokenFor(OWNER, { exp: 5 }) }),
  forged: () => ({ 'cf-access-jwt-assertion': mint(makeKey('k1'), { email: OWNER }) }),
};
const BEARER = { guest: { authorization: `Bearer ${PW}`, 'x-plugin-handle': 'ada' }, owner: { authorization: `Bearer ${OPW}` }, wrong: { authorization: 'Bearer nope', 'x-plugin-handle': 'ada' } };

// ---- the route table, from the source --------------------------------------------------------------------------
const src = fs.readFileSync(SERVER, 'latin1');
const found = new Set([...src.matchAll(/req\.method === '(GET|POST)' && url === '(\/[^']*)'/g)].map(m => `${m[1]} ${m[2]}`));
for (const r of FOLLOWING_ROUTES) found.add(`${r.method} ${r.path}`);
// streams and the password machinery have their own tests below
const SKIP = new Set(['GET /events', 'GET /auth-mode', 'POST /auth']);
const ROUTE_LIST = [...found].filter(r => !SKIP.has(r)).sort().map(r => r.split(' '));

const writeSettings = (h, obj) => fs.writeFileSync(path.join(h.SECRETS, 'plugin-access.json'), JSON.stringify(obj));
const ACCESS_SETTINGS = { team: TEAM, aud: AUD, owner_email: OWNER, collaborators: [ADA], certs_url_for_tests: keys.url };
async function boot(mode) {
  const h = H();
  const root = h.tmp('root');
  if (mode !== 'password') writeSettings(h, { hosted_auth: mode, ...ACCESS_SETTINGS });
  const env = mode === 'access' ? { PLUGIN_PASSWORD: PW, PLUGIN_OWNER_PASSWORD: OPW } : { PLUGIN_PASSWORD: PW, PLUGIN_OWNER_PASSWORD: OPW };
  const srv = await h.startServer({ root, args: ['--hosted', '--no-agents'], env });
  return { h, srv, base: srv.base, root };
}
const ask = (base, [m, p], headers) => (m === 'GET' ? request(base, 'GET', p, undefined, { ...REMOTE, ...headers }) : request(base, 'POST', p, {}, { ...REMOTE, ...headers }));
const sweep = async (base, headers) => { const out = {}; for (const r of ROUTE_LIST) { const a = await ask(base, r, headers()); out[r.join(' ')] = a.status; } return out; };

const P = await boot('password');
const A = await boot('access');
const E = await boot('either');
const rigs = [P, A, E];
let passed = 0; const failed = [];
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); } };

try {
  await test('the route table was found (and is not trivially small)', () => {
    assert.ok(ROUTE_LIST.length > 90, `found ${ROUTE_LIST.length}`);
    assert.ok(ROUTE_LIST.some(r => r.join(' ') === 'POST /snapshot') && ROUTE_LIST.some(r => r.join(' ') === 'POST /following/follow'));
  });

  // what the password companion says to each standing is the reference
  const ref = { guest: await sweep(P.base, () => BEARER.guest), owner: await sweep(P.base, () => BEARER.owner), none: await sweep(P.base, () => ({})) };

  await test('password mode: today\'s behaviour (no token header matters; the login page is served)', async () => {
    assert.ok(Object.values(ref.none).every(s => s === 401), 'every route asks for a password');
    assert.ok(Object.values(ref.owner).some(s => s === 200) && Object.values(ref.guest).some(s => s === 403), 'owner-only routes refuse a guest');
    const withToken = await sweep(P.base, () => T.owner());
    assert.deepEqual(withToken, ref.none, 'an Access token means nothing in password mode');
    const page = await request(P.base, 'GET', '/pages', undefined, { ...REMOTE, accept: 'text/html' });
    assert.equal(page.status, 401); assert.match(page.body, /<form/);
    assert.equal((await request(P.base, 'GET', '/auth-mode', undefined, REMOTE)).json.auth, 'password');
  });

  await test('access mode: no token, a bad token, a forged token, a service token, an unlisted person: refused on every route', async () => {
    const none = await sweep(A.base, () => ({}));
    assert.ok(Object.values(none).every(s => s === 401), JSON.stringify(Object.entries(none).filter(([, s]) => s !== 401)));
    for (const k of ['bad', 'forged']) assert.ok(Object.values(await sweep(A.base, T[k])).every(s => s === 401), k);
    assert.ok(Object.values(await sweep(A.base, T.service)).every(s => s === 403), 'service');
    assert.ok(Object.values(await sweep(A.base, T.unlisted)).every(s => s === 403), 'unlisted');
  });

  await test('access mode: a collaborator is a guest and the owner is the owner, route by route, exactly as the password companion says', async () => {
    assert.deepEqual(await sweep(A.base, T.guest), ref.guest);
    assert.deepEqual(await sweep(A.base, T.owner), ref.owner);
  });

  await test('access mode: a password in any form is ignored; the login page, /auth and /signout are off', async () => {
    for (const h of [BEARER.owner, BEARER.guest]) assert.equal((await GET(A.base, '/health', { ...REMOTE, ...h })).status, 401);
    assert.equal((await GET(A.base, `/health?auth=${PW}&handle=ada`, REMOTE)).status, 401);
    assert.equal((await GET(A.base, `/health?auth=${OPW}`, REMOTE)).status, 401);
    const login = await FORM(A.base, '/auth', { password: OPW, handle: 'x', next: '/pages' }, REMOTE);
    assert.equal(login.status, 404); assert.ok(!(login.headers['set-cookie'] || []).length);
    assert.equal((await request(A.base, 'GET', '/signout', undefined, REMOTE)).status, 404);
    const page = await request(A.base, 'GET', '/pages', undefined, { ...REMOTE, accept: 'text/html' });
    assert.equal(page.status, 401);
    assert.ok(!/<form|<input|password/i.test(page.body), 'no login form is served');
    // a cookie that password mode would have honoured is not one here
    const cookie = (await FORM(P.base, '/auth', { password: OPW, next: '/pages' }, REMOTE)).headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    assert.equal((await GET(A.base, '/health', { ...REMOTE, cookie })).status, 401);
    assert.equal((await request(A.base, 'GET', '/auth-mode', undefined, REMOTE)).json.auth, 'access');
  });

  await test('the refusals say what they must and nothing more', async () => {
    const un = await GET(A.base, '/health', { ...REMOTE, ...T.unlisted() });
    assert.equal(un.json.error, "this account is not on this companion's list");
    const page = await request(A.base, 'GET', '/pages', undefined, { ...REMOTE, ...T.unlisted(), accept: 'text/html' });
    assert.equal(page.status, 403); assert.match(page.body, /not on this companion&#39;s list/);
    for (const r of [un, page, await GET(A.base, '/health', REMOTE)]) assert.ok(!r.body.includes('example.test') && !r.body.includes(AUD), 'no address, team or tag');
    const noTok = await GET(A.base, '/health', REMOTE);
    assert.equal(noTok.json.signin, true, 'a 401 says it is a sign-in matter');
    assert.equal(un.json.signin, undefined);
    assert.equal((await GET(P.base, '/health', REMOTE)).json.signin, undefined, 'a password refusal is as it was');
    assert.equal((await GET(A.base, '/health', { ...REMOTE, ...T.service() })).json.error, 'service tokens are not accepted here');
  });

  await test('standing and name come from the token, never from what the request asks for', async () => {
    const g = await GET(A.base, '/whoami', { ...REMOTE, ...T.guest(), 'x-plugin-handle': 'someone-else' });
    assert.deepEqual([g.json.owner, g.json.handle], [false, 'ada']);
    const g2 = await GET(A.base, '/whoami?handle=mira', { ...REMOTE, ...T.guest() });
    assert.equal(g2.json.handle, 'ada');
    const o = await GET(A.base, '/whoami', { ...REMOTE, ...T.owner() });
    assert.equal(o.json.owner, true);
    assert.ok(!JSON.stringify([g.json, o.json]).includes('example.test'));
  });

  await test('either: a token decides alone; with none, the password path applies; both together never mix', async () => {
    assert.deepEqual(await sweep(E.base, T.guest), ref.guest);
    assert.deepEqual(await sweep(E.base, T.owner), ref.owner);
    assert.deepEqual(await sweep(E.base, () => BEARER.guest), ref.guest, 'the password path is as it was');
    assert.deepEqual(await sweep(E.base, () => BEARER.owner), ref.owner);
    assert.ok(Object.values(await sweep(E.base, () => BEARER.wrong)).every(s => s === 401));
    // a guest token WITH the owner password: the token's standing
    assert.deepEqual(await sweep(E.base, () => ({ ...T.guest(), ...BEARER.owner })), ref.guest);
    // an owner token with a guest password stays the owner (the token decides)
    assert.deepEqual(await sweep(E.base, () => ({ ...T.owner(), ...BEARER.guest })), ref.owner);
    // a token that is present and refused is not rescued by a password
    for (const k of ['bad', 'forged', 'unlisted', 'service']) {
      assert.ok(Object.values(await sweep(E.base, () => ({ ...T[k](), ...BEARER.owner }))).every(s => s === 401 || s === 403), k);
    }
    assert.equal((await GET(E.base, '/health', { ...REMOTE, ...T.bad(), ...BEARER.owner })).status, 401);
    assert.equal((await request(E.base, 'GET', '/auth-mode', undefined, REMOTE)).json.auth, 'either');
  });

  await test('either: the login page works, and its cookie never raises a guest token', async () => {
    const login = await FORM(E.base, '/auth', { password: OPW, next: '/pages' }, REMOTE);
    assert.equal(login.status, 303);
    const cookie = login.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    assert.equal((await GET(E.base, '/whoami', { ...REMOTE, cookie })).json.owner, true);
    assert.equal((await GET(E.base, '/whoami', { ...REMOTE, cookie, ...T.guest() })).json.owner, false);
    assert.equal((await GET(E.base, '/whoami', { ...REMOTE, cookie, ...T.guest() })).json.handle, 'ada');
  });

  await test('local requests on the loopback stay the owner in every mode and never ask for a token', async () => {
    for (const r of rigs) assert.equal((await GET(r.base, '/whoami')).json.owner, true);
  });

  await test('the Host allow-list and Origin rules are as they were', async () => {
    // a foreign Origin on the loopback is refused; a trusted extension origin gets credentials-aware CORS in access mode
    assert.equal((await request(A.base, 'GET', '/whoami', undefined, { origin: 'https://evil.example.test' })).status, 403);
    const pre = await request(A.base, 'OPTIONS', '/thread', undefined, { ...REMOTE, origin: 'chrome-extension://abcdefghijklmnop', 'access-control-request-method': 'POST' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop');
    assert.equal(pre.headers['access-control-allow-credentials'], 'true');
    const noOrigin = await request(A.base, 'OPTIONS', '/thread', undefined, REMOTE);
    assert.equal(noOrigin.headers['access-control-allow-origin'], undefined, 'no wildcard beside credentials');
    const foreign = await request(A.base, 'OPTIONS', '/thread', undefined, { ...REMOTE, origin: 'https://evil.example.test' });
    assert.equal(foreign.status, 403); assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    const pw = await request(P.base, 'OPTIONS', '/thread', undefined, { ...REMOTE, origin: 'chrome-extension://abcdefghijklmnop' });
    assert.equal(pw.headers['access-control-allow-credentials'], undefined, 'password mode is as it was');
    assert.equal((await request(P.base, 'OPTIONS', '/thread', undefined, REMOTE)).headers['access-control-allow-origin'], '*');
    // an answer to an extension's authenticated GET carries the CORS headers too
    const get = await request(A.base, 'GET', '/whoami', undefined, { ...REMOTE, ...T.owner(), origin: 'chrome-extension://abcdefghijklmnop' });
    assert.equal(get.headers['access-control-allow-credentials'], 'true');
  });

  // ---- streams -------------------------------------------------------------------------------------------------
  const sse = (base, headers) => new Promise((resolve, reject) => {
    const frames = []; let ended = false; let status = 0;
    const req = http.request(base + '/events', { headers: { ...REMOTE, ...headers } }, res => {
      status = res.statusCode;
      res.on('data', c => { for (const m of String(c).matchAll(/data: (.*)/g)) frames.push(JSON.parse(m[1])); });
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
    });
    req.on('error', () => { ended = true; });
    req.end();
    const st = { frames, status: () => status, ended: () => ended, close: () => req.destroy() };
    setTimeout(() => resolve(st), 250);
  });
  function ws(base, headers = {}) {
    const U = new URL(base);
    return new Promise(resolve => {
      const s = net.connect(Number(U.port), U.hostname, () => {
        s.write(['GET /ws HTTP/1.1', `Host: ${REMOTE.host}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n'));
      });
      let out = Buffer.alloc(0); let closed = false;
      s.on('data', c => { out = Buffer.concat([out, c]); });
      s.on('close', () => { closed = true; });
      s.on('error', () => { closed = true; });
      setTimeout(() => resolve({ text: () => out.toString('latin1'), closed: () => closed, destroy: () => s.destroy() }), 300);
    });
  }

  await test('SSE and WebSocket: connect in each standing; refused with no token, a bad token, an unlisted one', async () => {
    for (const rig of [A, E]) {
      for (const who of ['owner', 'guest']) {
        const s = await sse(rig.base, T[who]()); assert.equal(s.status(), 200, `sse ${who}`); assert.equal(s.frames[0].type, 'hello'); s.close();
        const w = await ws(rig.base, T[who]()); assert.match(w.text(), /^HTTP\/1.1 101/, `ws ${who}`); w.destroy();
      }
      for (const who of ['bad', 'forged', 'unlisted', 'service']) {
        assert.ok([401, 403].includes((await sse(rig.base, T[who]())).status()), `sse ${who}`);
        assert.match((await ws(rig.base, T[who]())).text(), /^HTTP\/1.1 401/, `ws ${who}`);
      }
      assert.equal((await sse(rig.base, {})).status(), 401);
      assert.match((await ws(rig.base, {})).text(), /^HTTP\/1.1 401/);
    }
    // a password rides ?auth on a socket in password mode and either; in access it is nothing
    assert.match((await ws(A.base, BEARER.owner)).text(), /^HTTP\/1.1 401/);
    const sock = await ws(E.base, BEARER.owner); assert.match(sock.text(), /^HTTP\/1.1 101/); sock.destroy();
  });

  await test('a stream or socket closes when its token expires, and the same token is then refused', async () => {
    const soon = () => ({ 'cf-access-jwt-assertion': tokenFor(ADA, { exp: Math.floor(Date.now() / 1000) + 2 }) });
    const tok = soon();
    const s = await sse(A.base, tok);
    const w = await ws(A.base, tok);
    assert.equal(s.status(), 200); assert.match(w.text(), /^HTTP\/1.1 101/);
    assert.ok(!s.ended() && !w.closed());
    await sleep(3500);
    assert.ok(s.ended(), 'the stream was closed at the token\'s expiry');
    assert.ok(w.closed(), 'the socket was closed at the token\'s expiry');
    assert.equal((await sse(A.base, tok)).status(), 401, 'and a reconnect with the old token is refused');
    // a stream that stays inside its token lives on
    const long = await sse(A.base, T.guest()); await sleep(600); assert.ok(!long.ended()); long.close();
  });

  await test('nothing about the settings or the emails reaches another client, or any answer', async () => {
    const owner = await sse(A.base, T.owner());
    const G = T.guest();
    const url = 'https://leak.web.test/page';
    await POST(A.base, '/page', { url, title: 'T' });                       // the owner, on the loopback
    const thread = await POST(A.base, '/thread', { url, quote: 'q', prefix: '', suffix: '', msg: { text: 'hello from a guest' } }, { ...REMOTE, ...G });
    assert.equal(thread.status, 200, thread.body);
    await POST(A.base, '/reply', { url, thread_id: thread.json.thread.id, text: 'again' }, { ...REMOTE, ...G });
    await sleep(300);
    const heard = JSON.stringify(owner.frames); owner.close();
    assert.ok(heard.includes('leak.web.test'), 'the owner heard the guest\'s activity');
    assert.ok(thread.body.includes('"ada"') && !thread.body.includes('@'), 'the guest is stored by handle, never by email');
    for (const bad of ['example.test', AUD, TEAM, 'ada@', OWNER]) assert.ok(!heard.includes(bad), `broadcast mentions ${bad}`);
    const bodies = [];
    for (const [m, p] of [['GET', '/health'], ['GET', '/whoami'], ['GET', '/index'], ['GET', '/pages'], ['GET', `/page?url=${encodeURIComponent(url)}`]]) {
      bodies.push((await ask(A.base, [m, p], G)).body, (await ask(A.base, [m, p], T.owner())).body);
    }
    for (const b of bodies) for (const bad of ['example.test', AUD, TEAM]) assert.ok(!b.includes(bad), `an answer mentions ${bad}`);
  });

  await test('the access file is never written into by the companion, and no password machinery is created in access mode', () => {
    assert.ok(!fs.existsSync(path.join(A.h.SECRETS, 'review-paper-secrets.json')), 'no owner password was generated');
    assert.ok(!A.srv.out().includes('example.test') && !A.srv.out().includes(AUD), 'the log carries no settings');
  });

  await test('start-up refuses bad settings with a plain message that names what is missing and no value', () => {
    const run = (settings, extraEnv = {}) => {
      const h = H(); const root = h.tmp('r');
      if (settings !== null) fs.writeFileSync(path.join(h.SECRETS, 'plugin-access.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
      const r = spawnSync(process.execPath, [SERVER, '--hosted', '--no-agents'], { encoding: 'utf8', timeout: 15000,
        env: { ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: root, BOTFERENCE_SECRETS_DIR: h.SECRETS, PLUGIN_PASSWORD: '', PLUGIN_OWNER_PASSWORD: '', ...extraEnv } });
      h.cleanup();
      return r;
    };
    for (const [bad, want] of [
      [{ hosted_auth: 'access' }, /team.*aud.*owner_email/s],
      [{ hosted_auth: 'access', team: TEAM, aud: AUD }, /owner_email/],
      [{ hosted_auth: 'either', team: TEAM, owner_email: OWNER }, /aud/],
      [{ hosted_auth: 'sso', team: TEAM, aud: AUD, owner_email: OWNER }, /hosted_auth must be one of password, access, either/],
      ['{ not json', /could not be read/],
      [{ hosted_auth: 'access', team: 'https://x.example.test/', aud: AUD, owner_email: OWNER }, /team must be a plain host name/],
    ]) {
      const r = run(bad);
      assert.equal(r.status, 1, JSON.stringify(bad));
      assert.match(r.stderr, want);
      assert.ok(!r.stderr.includes(OWNER) && !r.stderr.includes(AUD), 'no value is echoed');
    }
    // password mode still needs its password; access mode needs none
    assert.equal(run(null).status, 1);
    assert.match(run({ hosted_auth: 'either', ...ACCESS_SETTINGS }).stderr, /PLUGIN_PASSWORD/);
  });
} finally {
  for (const r of rigs) r.h.cleanup();
  await keys.close();
}
console.log(`${failed.length ? '✗' : '✓'} access-server — ${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
process.exit(0);
