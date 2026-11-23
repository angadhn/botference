// access-mutants.test.mjs — behaviours a review showed nothing was holding in place (each was a change that no test noticed).
//
//   node test/access-mutants.test.mjs
//   1. the WebSocket transport: a socket destroyed while its token was being checked is not opened; a REJECTED check is a refusal
//   2. the options page's Sign-in button acts on a trusted click only
//   3. in access mode the password machinery is off (no secret file, no owner password, no cookie, no bearer)
//   4. a request that merely says it is local, but carries a proxy header, is not the owner
//   5. an event is not delivered to a stream whose token has expired, even before the heartbeat has closed it
//   6. a caller who hung up while its token was being checked is not served
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHarness, request, GET, sleep } from './harness.mjs';
import { attachWs } from '../../review/ws.mjs';
import { isLocalDirect, PROXY_HEADERS } from '../../shared/local.mjs';
import { createHosted } from '../hosted.mjs';
import { makeKey, mint, keyServer, TEAM, AUD, OWNER, ADA, EXT_ID } from './access-fake.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
let passed = 0; const failed = [];
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); } };

// ---- 1. the socket transport ---------------------------------------------------------------------------------------------
function upgradeWith(authorize) {
  const server = new EventEmitter();
  const opened = [];
  attachWs(server, { authorize, onOpen: (ws) => opened.push(ws) });
  const sock = new EventEmitter();
  sock.written = ''; sock.destroyed = false;
  sock.write = c => { sock.written += String(c); return true; };
  sock.destroy = () => { sock.destroyed = true; };
  sock.end = () => { sock.destroyed = true; };
  sock.setNoDelay = () => { };
  server.emit('upgrade', { url: '/ws', headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', upgrade: 'websocket' } }, sock);
  return { sock, opened };
}
await test('a socket that was destroyed while its check was running is not opened', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const { sock, opened } = upgradeWith(() => gate);
  sock.destroyed = true;      // the caller hung up
  release(true);
  await sleep(20);
  assert.equal(opened.length, 0); assert.ok(!/101/.test(sock.written), 'no handshake was written to a dead socket');
});
await test('an authorize that REJECTS is a refusal, never an acceptance; one that says false is too; true opens', async () => {
  for (const [name, auth] of [['rejects', () => Promise.reject(new Error('x'))], ['false', () => Promise.resolve(false)], ['sync false', () => false]]) {
    const { sock, opened } = upgradeWith(auth);
    await sleep(20);
    assert.equal(opened.length, 0, name); assert.match(sock.written, /^HTTP\/1.1 401/, name); assert.ok(sock.destroyed, name);
  }
  const ok = upgradeWith(() => Promise.resolve(true)); await sleep(20);
  assert.equal(ok.opened.length, 1); assert.match(ok.sock.written, /^HTTP\/1.1 101/);
});

// ---- 2. the options page's Sign-in button ---------------------------------------------------------------------------------
await test('the options page\'s Sign-in button acts on a trusted click only', async () => {
  const handlers = {}; const opened = [];
  const stub = id => {
    const el = new Proxy({ value: id === 'base' ? 'https://hub.example.test' : '', checked: true, hidden: false, style: {}, classList: { toggle() {}, add() {}, remove() {} }, dataset: {},
      addEventListener(type, fn) { (handlers[id] ||= {})[type] = fn; }, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, remove() {} },
    { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => { } : undefined)), set: (t, k, v) => { t[k] = v; return true; } });
    return el;
  };
  const els = {};
  const ctx = {
    console, Promise, JSON, URL, setTimeout, clearTimeout, Map, Set,
    document: { getElementById: id => (els[id] ||= stub(id)), addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, createElement: () => stub('x'), body: stub('body') },
    open: (...a) => opened.push(a),
    chrome: { storage: { local: { get: (_k, cb) => cb({ 'bfp:companion': 'https://hub.example.test' }), set: (_o, cb) => cb && cb() }, onChanged: { addListener() {} } }, extension: {}, runtime: {} },
    fetch: async () => ({ ok: true, status: 200, type: 'basic', headers: { get: () => 'application/json' }, text: async () => '{"ok":true,"auth":"access"}' }),
    navigator: {},
  };
  ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  const EXT = path.join(TEST, '..', 'extension');
  vm.runInContext(fs.readFileSync(path.join(EXT, 'config.js'), 'utf8'), ctx, { filename: 'config.js' });
  vm.runInContext(fs.readFileSync(path.join(EXT, 'options.js'), 'utf8'), ctx, { filename: 'options.js' });
  await sleep(20);
  const click = handlers['signin-open'] && handlers['signin-open'].click;
  assert.equal(typeof click, 'function', 'the button is wired');
  click({ isTrusted: false }); click({}); click({ isTrusted: 'true' });
  assert.equal(opened.length, 0, 'a click a page made up does nothing');
  click({ isTrusted: true });
  assert.equal(opened.length, 1); assert.equal(opened[0][0], 'https://hub.example.test/');
});

await test('the options page asks which way a companion signs in BEFORE sending it the saved password (keys, profiles, test), and withholds it from Access', async () => {
  const run = async (answer, stored) => {
    const calls = [];
    const stub = id => new Proxy({ value: '', checked: true, hidden: false, style: {}, classList: { toggle() {}, add() {}, remove() {} }, dataset: {},
      addEventListener() {}, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, remove() {} },
    { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => { } : undefined)), set: (t, k, v) => { t[k] = v; return true; } });
    const els = {};
    const ctx = {
      console, Promise, JSON, URL, setTimeout, clearTimeout, Map, Set,
      document: { getElementById: id => (els[id] ||= stub(id)), addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, createElement: () => stub('x'), body: stub('body') },
      open() {}, navigator: {},
      chrome: { storage: { local: { get: (_k, cb) => cb(stored), set: (_o, cb) => cb && cb(), remove: (_k, cb) => cb && cb() }, onChanged: { addListener() {} } }, extension: {}, runtime: {} },
      fetch: async (url, init) => {
        calls.push({ url: String(url), headers: (init && init.headers) || {} });
        const body = /auth-mode$/.test(url) ? answer : '{"ok":true,"keys":{}}';
        return { ok: true, status: /auth-mode$/.test(url) && answer.signin ? 401 : 200, type: 'basic', headers: { get: () => 'application/json' }, text: async () => body };
      },
    };
    ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
    const EXT = path.join(TEST, '..', 'extension');
    vm.runInContext(fs.readFileSync(path.join(EXT, 'config.js'), 'utf8'), ctx, { filename: 'config.js' });
    vm.runInContext(fs.readFileSync(path.join(EXT, 'options.js'), 'utf8'), ctx, { filename: 'options.js' });
    await sleep(60);
    return calls;
  };
  const stored = { 'bfp:companion': 'https://hub.example.test', 'bfp:password': 'pw', 'bfp:handle': 'ada' };
  const access = await run('{"ok":true,"auth":"access"}', stored);
  const keysAt = access.findIndex(c => /\/keys$/.test(c.url));
  assert.ok(keysAt > 0, 'the keys request was made');
  assert.ok(access.slice(0, keysAt).some(c => /auth-mode$/.test(c.url)), 'the mode was asked first');
  for (const c of access) assert.ok(!c.headers.Authorization, `no password to an Access companion: ${c.url}`);
  const password = await run('{"ok":true,"auth":"password"}', stored);
  const k = password.find(c => /\/keys$/.test(c.url));
  assert.equal(k.headers.Authorization, 'Bearer pw', 'a password companion gets it');
  const portal = await run('', stored);   // not JSON: not the companion
  for (const c of portal) assert.ok(!c.headers.Authorization, `nothing that is not the companion's own answer unlocks the password: ${c.url}`);
  const local = await run('{"ok":true,"auth":"access"}', { 'bfp:password': 'pw' });
  assert.ok(local.find(c => /\/keys$/.test(c.url)).headers.Authorization === 'Bearer pw', 'this machine\'s companion is as before');
});

// ---- 3. no password machinery in access mode --------------------------------------------------------------------------------
await test('access mode: no secret file, no owner password, no cookie, no bearer; password and either keep theirs', () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-mut-s-')); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-mut-d-'));
  const was = process.env.BOTFERENCE_SECRETS_DIR; process.env.BOTFERENCE_SECRETS_DIR = secrets;
  try {
    fs.writeFileSync(path.join(secrets, 'review-paper-secrets.json'), JSON.stringify({ owner: 'hub-owner-pw' }));
    const mk = authMode => createHosted({ hosted: true, dir: path.join(dir, authMode), ownerHandle: () => 'mira', password: 'guest-pw', ownerPassword: 'owner-pw', authMode });
    const A = mk('access');
    assert.ok(!fs.existsSync(path.join(dir, 'access', '.auth-secret')), 'no cookie secret was made');
    assert.equal(A.ownerPassword(), '');
    const bearer = pw => ({ method: 'GET', url: '/x', headers: { host: 'annotations.example', authorization: `Bearer ${pw}`, 'x-plugin-handle': 'ada' }, socket: { remoteAddress: '203.0.113.9' } });
    for (const pw of ['owner-pw', 'guest-pw', 'hub-owner-pw']) { assert.equal(A.authorized(bearer(pw)), false, pw); assert.equal(A.isOwner(bearer(pw)), false, pw); }
    assert.equal(A.refreshCookies({ ...bearer('x'), headers: { host: 'annotations.example', cookie: 'plugin_auth=1.owner.x.y' } }), null);
    for (const m of ['password', 'either']) {
      const P = mk(m);
      assert.ok(fs.existsSync(path.join(dir, m, '.auth-secret')), m + ' keeps its cookie secret');
      assert.equal(P.ownerPassword(), 'owner-pw'); assert.equal(P.authorized(bearer('guest-pw')), true); assert.equal(P.isOwner(bearer('owner-pw')), true);
    }
  } finally { if (was === undefined) delete process.env.BOTFERENCE_SECRETS_DIR; else process.env.BOTFERENCE_SECRETS_DIR = was; fs.rmSync(secrets, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 4. a claim of being local ---------------------------------------------------------------------------------------------
await test('being local needs no proxy header: each one alone makes a "localhost" request not local', () => {
  const base = { headers: { host: '127.0.0.1:4189' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(isLocalDirect(base), true);
  for (const h of PROXY_HEADERS) assert.equal(isLocalDirect({ ...base, headers: { ...base.headers, [h]: '1' } }), false, h);
  assert.equal(isLocalDirect({ ...base, socket: { remoteAddress: '192.0.2.4' } }), false);
});

// ---- servers for 4 (over the wire), 5 and 6 ---------------------------------------------------------------------------------------
const key = makeKey('k1');
async function boot(keysState, env = {}) {
  const h = createHarness({ server: SERVER, tag: 'mut', waitMs: 20000, env: { PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PUBLIC_HOSTNAMES: 'annotations.example', ...env } });
  fs.writeFileSync(path.join(h.SECRETS, 'plugin-access.json'), JSON.stringify({ hosted_auth: 'access', team: TEAM, aud: AUD, owner_email: OWNER, collaborators: [ADA], extension_ids: [EXT_ID], certs_url_for_tests: keysState.url }));
  const srv = await h.startServer({ root: h.tmp('root'), args: ['--hosted', '--no-agents'], env: {} });
  return { h, base: srv.base };
}
const REMOTE = { host: 'annotations.example' };
const owner = () => ({ 'cf-access-jwt-assertion': mint(key, { email: OWNER }) });

const keysA = await keyServer([key]);
const A = await boot(keysA);
await test('a tunnelled request that names localhost is not the owner in access mode', async () => {
  const port = new URL(A.base).port;
  assert.equal((await GET(A.base, '/whoami', { host: `127.0.0.1:${port}` })).json.owner, true, 'the real loopback is');
  for (const h of PROXY_HEADERS) assert.equal((await GET(A.base, '/health', { host: `127.0.0.1:${port}`, [h]: '203.0.113.9' })).status, 421, h + ' (a tunnel that rewrites Host to localhost is not on the list of names)');
});
await keysA.close(); A.h.cleanup();

await test('an event is not delivered to a stream whose token has expired, even before the heartbeat closes it', async () => {
  const keys = await keyServer([key]);
  const S = await boot(keys, { SSE_HEARTBEAT_MS: '600000' });          // the heartbeat will not run in this test
  const frames = []; let ended = false;
  const req = http.request(S.base + '/events', { headers: { ...REMOTE, 'cf-access-jwt-assertion': mint(key, { email: ADA, exp: Math.floor(Date.now() / 1000) + 2 }) } }, res => {
    res.on('data', c => { for (const m of String(c).matchAll(/data: (.*)/g)) frames.push(JSON.parse(m[1])); });
    res.on('close', () => { ended = true; });
  });
  req.end();
  await sleep(300);
  await request(S.base, 'POST', '/page', { url: 'https://early.web.test/a', title: 'a' });
  await sleep(200);
  assert.ok(frames.some(f => f.type === 'page' && /early/.test(f.url)), 'while the token is good it hears');
  await sleep(2500);
  assert.equal(ended, false, 'the heartbeat has not run, so the stream is still open');
  await request(S.base, 'POST', '/page', { url: 'https://late.web.test/a', title: 'b' });
  await sleep(300);
  assert.ok(!frames.some(f => /late\.web/.test(JSON.stringify(f))), 'after expiry it hears nothing');
  req.destroy(); S.h.cleanup(); await keys.close();
});

await test('a caller who hung up while its token was being checked is not served', async () => {
  const keys = await keyServer([key]); keys.delayMs = 600;               // the first token has to wait for the key list
  const S = await boot(keys);
  const body = JSON.stringify({ url: 'https://hungup.web.test/a', title: 'gone' });
  await new Promise(resolve => {
    const req = http.request(S.base + '/page', { method: 'POST', headers: { ...REMOTE, ...owner(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    req.on('error', () => { });
    req.write(body);
    setTimeout(() => { req.destroy(); resolve(); }, 150);
  });
  await sleep(1200);
  const idx = await GET(S.base, '/index');
  assert.ok(!JSON.stringify(idx.json).includes('hungup.web.test'), 'the change was not made for a caller who had gone');
  // and one who stays is served, from the same cold start
  const stay = await request(S.base, 'POST', '/page', { url: 'https://stayed.web.test/a', title: 'here' }, { ...REMOTE, ...owner() });
  assert.equal(stay.status, 200);
  S.h.cleanup(); await keys.close();
});

await test('a request already hung up when its token check finishes reaches no route (in-process, so nothing hides it)', async () => {
  const keys = await keyServer([key]);
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-mut-ip-')); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-mut-ipr-'));
  fs.writeFileSync(path.join(secrets, 'plugin-access.json'), JSON.stringify({ hosted_auth: 'access', team: TEAM, aud: AUD, owner_email: OWNER, extension_ids: [EXT_ID], certs_url_for_tests: keys.url }));
  Object.assign(process.env, { PLUGIN_NO_LISTEN: '1', PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PUBLIC_HOSTNAMES: 'annotations.example', BOTFERENCE_SECRETS_DIR: secrets, BOTFERENCE_PROJECT_ROOT: root, PLUGIN_BRIDGE_CMD: '["true"]' });
  process.argv.push('--hosted', '--no-agents');
  const server = await import('../server.mjs');
  const fake = destroyed => ({ method: 'GET', url: '/health', destroyed, headers: { host: 'annotations.example', 'cf-access-jwt-assertion': mint(key, { email: OWNER }) }, socket: { remoteAddress: '203.0.113.9' }, resume() { }, on() { } });
  const res = () => ({ headersSent: false, wrote: 0, setHeader() { }, writeHead() { this.wrote++; return this; }, end() { return this; } });
  const gone = res(); server.safeHandler(fake(true), gone);
  const here = res(); server.safeHandler(fake(false), here);
  await sleep(400);
  assert.equal(gone.wrote, 0, 'nothing was written for a caller who had gone');
  assert.ok(here.wrote > 0, 'a caller who is there is served');
  fs.rmSync(secrets, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); await keys.close();
});

console.log(`${failed.length ? '✗' : '✓'} access-mutants — ${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
process.exit(0);
