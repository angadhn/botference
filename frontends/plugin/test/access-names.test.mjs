// access-names.test.mjs — which names are trusted: only the ones configured, never a built-in one.
//
//   node test/access-names.test.mjs
//
// With Access in front: the companion refuses to start without at least one public name (PLUGIN_PUBLIC_HOSTNAMES, PLUGIN_READING_HOSTNAME
// or PLUGIN_MEMORY_HOSTNAME); a request that came through the tunnel must ask for one of them (else 421, the existing rebinding answer);
// "our own page" is an https page at one of them, not whatever name the request happened to ask for, and not a page on the machine's
// loopback. Password mode keeps its reach; an install that already sets these names behaves as before (placeholder names here).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHarness, request, GET } from './harness.mjs';
import { makeKey, mint, keyServer, TEAM, AUD, OWNER, EXT_ID } from './access-fake.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const key = makeKey('k1'); const keys = await keyServer([key]);
let passed = 0; const failed = [];
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); } };
const SETTINGS = mode => ({ hosted_auth: mode, team: TEAM, aud: AUD, owner_email: OWNER, extension_ids: [EXT_ID], certs_url_for_tests: keys.url });
const tok = () => ({ 'cf-access-jwt-assertion': mint(key, { email: OWNER }) });
const tunnel = host => ({ host, 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-proto': 'https' });
async function boot(mode, env) {
  const h = createHarness({ server: SERVER, tag: 'nam', waitMs: 20000, env: { PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_PUBLIC_HOSTNAMES: '', PLUGIN_READING_HOSTNAME: '', PLUGIN_MEMORY_HOSTNAME: '', ...env } });
  if (mode !== 'password') fs.writeFileSync(path.join(h.SECRETS, 'plugin-access.json'), JSON.stringify(SETTINGS(mode)));
  const srv = await h.startServer({ root: h.tmp('root'), args: ['--hosted', '--no-agents'], env: {} });
  return { h, base: srv.base, port: new URL(srv.base).port, out: srv.out };
}
const started = (mode, env) => {
  const h = createHarness({ server: SERVER, tag: 'nam' });
  fs.writeFileSync(path.join(h.SECRETS, 'plugin-access.json'), JSON.stringify(SETTINGS(mode)));
  const r = spawnSync(process.execPath, [SERVER, '--hosted', '--no-agents'], { encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: h.tmp('r'), BOTFERENCE_SECRETS_DIR: h.SECRETS, PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PASSWORD: 'pw', PLUGIN_OWNER_PASSWORD: '', PLUGIN_PUBLIC_HOSTNAMES: '', PLUGIN_READING_HOSTNAME: '', PLUGIN_MEMORY_HOSTNAME: '', ...env } });
  h.cleanup(); return r;
};

try {
  await test('access and either refuse to start with no configured name, and say which setting; any one of the three settings is enough', () => {
    for (const mode of ['access', 'either']) {
      const r = started(mode, {});
      assert.equal(r.status, 1, mode); assert.match(r.stderr, /PLUGIN_PUBLIC_HOSTNAMES/);
    }
  });
  const A = await boot('access', { PLUGIN_PUBLIC_HOSTNAMES: 'annotations.example.test' });
  const E = await boot('either', { PLUGIN_READING_HOSTNAME: 'annotations.example.test' });
  const P = await boot('password', {});
  await test('a request through the tunnel must ask for a configured name: another name, or localhost (a tunnel that rewrites Host), is 421', async () => {
    for (const b of [A, E]) {
      assert.equal((await GET(b.base, '/health', { ...tunnel('annotations.example.test'), ...tok() })).status, 200);
      for (const h of ['other.example.test', 'localhost', `localhost:${b.port}`, `127.0.0.1:${b.port}`, '[::1]', 'annotations.example.test.evil.example']) {
        const r = await GET(b.base, '/health', { ...tunnel(h), ...tok() });
        assert.equal(r.status, 421, h); assert.equal(r.json.error, 'misdirected request');
      }
      assert.equal((await GET(b.base, '/whoami')).json.owner, true, 'the loopback, asked for directly, is as it was');
    }
  });
  await test('"our own page" is an https page at a configured name: not Host, not http, not a page on the loopback', async () => {
    const h = { ...tunnel('annotations.example.test'), ...tok(), 'content-type': 'application/json' };
    const post = origin => request(A.base, 'POST', '/page', { url: 'https://n.web.test/a', title: 'x' }, { ...h, origin });
    assert.equal((await post('https://annotations.example.test')).status, 200);
    for (const o of ['http://annotations.example.test', `http://localhost:${A.port}`, `http://127.0.0.1:${A.port}`, 'http://localhost', 'https://other.example.test', 'https://annotations.example.test.evil.example', 'null']) {
      assert.equal((await post(o)).status, 403, o);
    }
    const pre = await request(A.base, 'OPTIONS', '/thread', undefined, { ...tunnel('annotations.example.test'), origin: `http://localhost:${A.port}` });
    assert.equal(pre.status, 403); assert.equal(pre.headers['access-control-allow-origin'], undefined);
  });
  await test('the owner on the loopback still works with its own pages (a local request is not judged strictly)', async () => {
    const port = A.port;
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'chrome-extension://' + EXT_ID]) {
      assert.equal((await GET(A.base, '/index', { origin })).status, 200, origin);
    }
    assert.equal((await GET(A.base, '/index', { origin: 'https://evil.example.test' })).status, 403);
  });
  await test('no built-in names: an unconfigured name is just a foreign one, and the old derived names (discuss., plugin.) are gone', async () => {
    const M = await boot('password', { PLUGIN_MEMORY_HOSTNAME: 'memo.example.test' });
    const pre = o => request(M.base, 'OPTIONS', '/thread', undefined, { host: 'memo.example.test', origin: o });
    assert.equal((await pre('https://memo.example.test')).headers['access-control-allow-origin'], 'https://memo.example.test');
    for (const o of ['https://discuss.example.test', 'https://plugin.example.test', 'https://memorizer.example.test']) {
      assert.equal((await pre(o)).status, 403, o + ' is not derived from the memory name any more');
    }
    M.h.cleanup();
  });
  await test('a configured name over plain http is not trusted, in password mode as well (and one configured name is not another\'s own page)', async () => {
    const I = await boot('password', { PLUGIN_PUBLIC_HOSTNAMES: 'pub.example.test,other.example.test' });
    const pre = (host, origin) => request(I.base, 'OPTIONS', '/thread', undefined, { ...tunnel(host), origin });
    assert.equal((await pre('pub.example.test', 'https://other.example.test')).headers['access-control-allow-origin'], 'https://other.example.test', 'https: trusted');
    assert.equal((await pre('pub.example.test', 'http://other.example.test')).status, 403, 'http: not');
    const trustedHttpName = await pre('other.example.test', 'http://pub.example.test');
    assert.equal(trustedHttpName.status, 403, 'a configured name over http is not a trusted origin');
    I.h.cleanup();
  });
  await test('an install that already sets its names behaves as before: the quiz door, the reading room\'s calls, Host/Origin (password mode)', async () => {
    const I = await boot('password', { PLUGIN_MEMORY_HOSTNAME: 'memo.example.test', PLUGIN_READING_HOSTNAME: 'read.example.test', PLUGIN_PUBLIC_HOSTNAMES: 'pub.example.test' });
    const bearer = { authorization: 'Bearer guest-pw', 'x-plugin-handle': 'visitor' };
    // the quiz door: on the memory name `/` is the vault's front door (a guest is told to sign in, not that the name is foreign)
    const door = await request(I.base, 'GET', '/', undefined, { ...tunnel('memo.example.test'), accept: 'text/html' });
    assert.notEqual(door.status, 421);
    for (const host of ['memo.example.test', 'read.example.test', 'pub.example.test']) {
      assert.equal((await GET(I.base, '/index', { ...tunnel(host), ...bearer })).status, host === 'memo.example.test' ? 302 : 200, host + (host === 'memo.example.test' ? ' (its door sends other paths home)' : ''));
      for (const origin of ['memo.example.test', 'read.example.test', 'pub.example.test']) {
        const pre = await request(I.base, 'OPTIONS', '/thread', undefined, { ...tunnel(host), origin: `https://${origin}` });
        assert.equal(pre.status, 204, `${origin} -> ${host}`); assert.equal(pre.headers['access-control-allow-origin'], `https://${origin}`);
      }
    }
    // a name nobody configured still meets the password gate, as it always did (a tunnel's random name, a rewritten Host)
    assert.equal((await GET(I.base, '/index', { ...tunnel('quick-tunnel.example.test'), ...bearer })).status, 200);
    assert.equal((await GET(I.base, '/index', { ...tunnel('quick-tunnel.example.test') })).status, 401);
    I.h.cleanup();
  });
  await test('at start, in hosted mode, the companion says its sign-in mode, the names it trusts and its memorizer name (and nothing secret)', async () => {
    const M = await boot('either', { PLUGIN_PUBLIC_HOSTNAMES: 'pub.example.test', PLUGIN_MEMORY_HOSTNAME: 'memo.example.test' });
    const log = M.out();
    assert.match(log, /sign-in: either +people: owner and guests +trusted names: memo\.example\.test, pub\.example\.test +memorizer: memo\.example\.test/);
    for (const bad of [OWNER, AUD, 'guest-pw', 'owner-pw', TEAM]) assert.ok(!log.includes(bad), 'the log carries no ' + bad);
    assert.match(A.out(), /sign-in: access +people: owner and guests +trusted names: annotations\.example\.test +memorizer: \(none\)/);
    assert.match(P.out(), /sign-in: password +people: owner and guests +trusted names: \(none\) +memorizer: \(none\)/);
    M.h.cleanup();
  });
  await test('the launcher exports the public names and the memorizer name from the names it routes the tunnel to (its snippet, run with placeholder names)', () => {
    const src = fs.readFileSync(path.join(TEST, '..', '..', '..', 'lib', 'plugin.sh'), 'utf8');
    const start = src.indexOf('# --- the names the companion trusts');
    const end = src.indexOf('export PLUGIN_MEMORY_HOSTNAME=', start);
    assert.ok(start > 0 && end > start, 'the snippet is in lib/plugin.sh');
    const snippet = src.slice(start, src.indexOf('\n', end));
    const run = (vars, unset = []) => spawnSync('bash', ['-c', `${unset.map(u => `unset ${u};`).join('')} f() { ${snippet}
      printf '%s|%s' "$PLUGIN_PUBLIC_HOSTNAMES" "\${PLUGIN_MEMORY_HOSTNAME-UNSET}"; }; f`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...vars } }).stdout;
    const T = { PLUGIN_TUNNEL_HOSTNAME: 'room.example.test', PLUGIN_TUNNEL_LEGACY_HOSTNAME: 'old.example.test', PLUGIN_TUNNEL_MEMORY_HOSTNAME: 'memo.example.test' };
    assert.equal(run(T), 'room.example.test,old.example.test,memo.example.test|memo.example.test');
    assert.equal(run({ ...T, PLUGIN_TUNNEL_LEGACY_HOSTNAME: '' }), 'room.example.test,memo.example.test|memo.example.test', 'a dropped legacy name is not trusted');
    assert.equal(run({ ...T, PLUGIN_TUNNEL_MEMORY_HOSTNAME: '' }), 'room.example.test,old.example.test|', 'a dropped memorizer name is dropped');
    assert.equal(run({ ...T, PLUGIN_PUBLIC_HOSTNAMES: 'mine.example.test' }), 'mine.example.test|memo.example.test', 'names already set are kept');
    assert.equal(run({ ...T, PLUGIN_MEMORY_HOSTNAME: '' }), 'room.example.test,old.example.test,memo.example.test|', 'a memorizer name set empty stays empty');
    assert.equal(run({ ...T, PLUGIN_MEMORY_HOSTNAME: 'other.example.test' }), 'room.example.test,old.example.test,memo.example.test|other.example.test');
  });
  A.h.cleanup(); E.h.cleanup(); P.h.cleanup();
} finally { await keys.close(); }
console.log(`${failed.length ? '✗' : '✓'} access-names — ${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
process.exit(0);
