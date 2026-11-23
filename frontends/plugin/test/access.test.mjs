// access.test.mjs — Cloudflare Access token checking, the settings, and the verdicts (access.mjs).
//
//   node --test test/access.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOSTED_AUTH, ACCESS_VERDICTS, KEY_CACHE_STATES, parseHostedAuth, buildAccessConfig, loadHostedAuth, AccessConfigError,
  checkAccessToken, verifyAccessToken, verdictFor, newKeyCache, keyCacheState, createAccess, verdictOfRequest, connectionRecord, connectionLive,
  JWKS_TTL_MS, JWKS_REFETCH_MIN_MS, JWKS_STALE_OK_MS,
} from '../access.mjs';
import { makeKey, mint, TEAM, AUD, OWNER, ADA, NOBODY, EXT_ID } from './access-fake.mjs';

const RAW = { hosted_auth: 'access', team: TEAM, aud: AUD, owner_email: OWNER, collaborators: [ADA], extension_ids: [EXT_ID] };
const cfg = () => buildAccessConfig(RAW);
const key = makeKey('k1');
// a fetch that answers from memory and counts
function fakeGet(keys) {
  const f = async () => { f.hits++; if (f.fail) throw new Error('down'); if (f.delay) await new Promise(r => setTimeout(r, f.delay)); return { status: 200, text: JSON.stringify({ keys: f.keys.map(k => k.jwk) }) }; };
  f.hits = 0; f.keys = keys;
  return f;
}
const rig = (t0 = 1_800_000_000_000) => {
  const clock = { t: t0 };
  return { clock, now: () => clock.t, cache: newKeyCache(), get: fakeGet([key]) };
};
const ok = async (token, r = rig()) => verifyAccessToken(token, cfg(), r);
const mintAt = (r, over, o) => mint(key, over, { now: r.now(), ...o });

test('the modes and verdicts are named lists', () => {
  assert.deepEqual(HOSTED_AUTH, ['password', 'access', 'either']);
  assert.deepEqual(ACCESS_VERDICTS, ['absent', 'invalid', 'service', 'unlisted', 'owner', 'guest']);
  assert.deepEqual(KEY_CACHE_STATES, ['empty', 'fresh', 'stale', 'expired']);
  assert.equal(parseHostedAuth(undefined), 'password');
  for (const m of HOSTED_AUTH) assert.equal(parseHostedAuth(m), m);
  for (const bad of ['Access', 'oauth', 'both', 1, true]) assert.throws(() => parseHostedAuth(bad), AccessConfigError);
});

test('a valid token verifies', async () => {
  const r = rig();
  const claims = await ok(mintAt(r), r);
  assert.equal(claims.email, OWNER);
});

test('wrong algorithms are refused: none, HS256 signed with the public key, a swapped alg', async () => {
  const r = rig();
  assert.equal(await ok(mintAt(r, {}, { alg: 'none' }), r), null);
  assert.equal(await ok(mintAt(r, {}, { alg: 'HS256' }), r), null);
  assert.equal(await ok(mintAt(r, {}, { alg: 'RS512' }), r), null);
  const [h, b, s] = mintAt(r).split('.');
  const hs = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
  assert.equal(await ok(`${hs}.${b}.${s}`, r), null);
});

test('the key id: unknown, wrong key, and header fields that point elsewhere', async () => {
  const r = rig();
  assert.equal(await ok(mintAt(r, {}, { kid: 'nope' }), r), null);
  const other = makeKey('k1');
  assert.equal(await ok(mint(other, {}, { now: r.now() }), r), null, 'right kid, wrong key');
  for (const h of [{ jku: 'http://x.example.test/k' }, { jwk: {} }, { x5u: 'x' }, { crit: ['exp'] }, { typ: 'at+jwt' }]) {
    assert.equal(await ok(mintAt(r, {}, { header: h }), r), null, JSON.stringify(h));
  }
});

test('time: expired, exactly now, not yet valid, issued in the future', async () => {
  const r = rig();
  const s = Math.floor(r.now() / 1000);
  assert.equal(await ok(mintAt(r, { exp: s - 5 }), r), null);
  assert.equal(await ok(mintAt(r, { exp: s }), r), null, 'exp is strict');
  assert.ok(await ok(mintAt(r, { exp: s + 1 }), r));
  assert.equal(await ok(mintAt(r, { nbf: s + 300 }), r), null);
  assert.ok(await ok(mintAt(r, { nbf: s + 30 }), r), 'small skew');
  assert.equal(await ok(mintAt(r, { iat: s + 300 }), r), null);
  assert.equal(await ok(mintAt(r, { exp: 'soon' }), r), null);
  assert.equal(await ok(mintAt(r, { exp: undefined }), r), null);
});

test('issuer and audience, string and array forms', async () => {
  const r = rig();
  assert.equal(await ok(mintAt(r, { iss: 'https://other.example.test' }), r), null);
  assert.equal(await ok(mintAt(r, { iss: TEAM }), r), null);
  assert.ok(await ok(mintAt(r, { aud: AUD }), r), 'string form');
  assert.ok(await ok(mintAt(r, { aud: ['x', AUD] }), r), 'array form');
  assert.equal(await ok(mintAt(r, { aud: 'other-aud' }), r), null);
  assert.equal(await ok(mintAt(r, { aud: ['a', 'b'] }), r), null);
  assert.equal(await ok(mintAt(r, { aud: [] }), r), null);
  assert.equal(await ok(mintAt(r, { aud: undefined }), r), null);
  assert.equal(await ok(mintAt(r, { aud: [AUD + 'x'] }), r), null);
});

test('type, common_name, identity_nonce, and the email as sent', async () => {
  const r = rig();
  assert.equal(await ok(mintAt(r, { type: 'service' }), r), null);
  assert.equal(await ok(mintAt(r, { type: undefined }), r), null);
  assert.equal(await ok(mintAt(r, { identity_nonce: '' }), r), null);
  assert.equal(await ok(mintAt(r, { identity_nonce: undefined }), r), null);
  assert.equal(await ok(mintAt(r, { common_name: 'a.access' }), r), null);
  // emails that are not plain: space, newline, zero-width, look-alike (Cyrillic a), missing
  for (const e of [' ' + OWNER, OWNER + ' ', OWNER + '\n', 'o​wner@example.test', 'owner@exаmple.test', undefined, 7]) {
    assert.equal(await ok(mintAt(r, { email: e }), r), null, JSON.stringify(e));
  }
});

test('a token that is not three base64url parts, or is huge, is refused', async () => {
  const r = rig();
  for (const t of ['', 'a.b', 'a.b.c.d', 'a b.c.d', undefined, null, 5, 'x'.repeat(9000)]) assert.equal(await ok(t, r), null);
});

test('verdicts: owner, guest, unlisted, service, invalid, absent; case folds only A-Z; the owner and guests are by exact email', async () => {
  const r = rig(); const c = cfg();
  const v = async over => verdictFor(await checkAccessToken(mintAt(r, over), c, r), c);
  assert.equal((await v({ email: OWNER })).verdict, 'owner');
  assert.equal((await v({ email: OWNER.toUpperCase() })).verdict, 'owner');
  const g = await v({ email: ADA });
  assert.equal(g.verdict, 'guest'); assert.equal(g.handle, 'ada');
  assert.equal(g.expiresAt, (Math.floor(r.now() / 1000) + 3600) * 1000);
  assert.equal((await v({ email: NOBODY })).verdict, 'unlisted');
  assert.equal((await v({ email: 'ada@example.test.evil' })).verdict, 'unlisted');
  assert.equal((await v({ common_name: 'svc', email: undefined, identity_nonce: undefined })).verdict, 'service');
  assert.equal((await v({ exp: 1 })).verdict, 'invalid');
  assert.equal(verdictFor(null, c).verdict, 'absent');
});

test('the key list: cached, shared by a crowd, bounded, and failing closed', async () => {
  const r = rig(); const c = cfg();
  const tok = () => mintAt(r);
  // a crowd with an empty cache makes ONE fetch
  r.get.delay = 30;
  const all = await Promise.all(Array.from({ length: 40 }, () => verifyAccessToken(tok(), c, r)));
  assert.ok(all.every(Boolean)); assert.equal(r.get.hits, 1);
  assert.equal(keyCacheState(r.cache, r.now()), 'fresh');
  // fresh: no more fetches
  await verifyAccessToken(tok(), c, r); assert.equal(r.get.hits, 1);
});

test('an unknown key id fetches at most once per gap', async () => {
  const r = rig(); const c = cfg();
  await verifyAccessToken(mintAt(r), c, r); assert.equal(r.get.hits, 1);
  r.clock.t += JWKS_REFETCH_MIN_MS + 1;
  const junk = () => mintAt(r, {}, { kid: 'unknown' });
  for (let i = 0; i < 20; i++) assert.equal(await verifyAccessToken(junk(), c, r), null);
  assert.equal(r.get.hits, 2, 'twenty made-up tokens cost one fetch');
  r.clock.t += JWKS_REFETCH_MIN_MS + 1;
  await verifyAccessToken(junk(), c, r); assert.equal(r.get.hits, 3);
});

test('key rotation: a new key id is found; the retired key stops verifying after the list moves on', async () => {
  const r = rig(); const c = cfg();
  const k2 = makeKey('k2');
  assert.ok(await verifyAccessToken(mintAt(r), c, r));
  r.get.keys = [k2];
  r.clock.t += JWKS_REFETCH_MIN_MS + 1;
  assert.ok(await verifyAccessToken(mint(k2, {}, { now: r.now() }), c, r), 'new kid triggers a refetch and verifies');
  assert.equal(await verifyAccessToken(mintAt(r), c, r), null, 'the retired key is gone');
});

test('the key list failing: a slow or dead list refuses new keys, keeps serving a held key for a day, then fails closed', async () => {
  const c = cfg();
  const cold = rig(); cold.get.fail = true;
  assert.equal(await verifyAccessToken(mintAt(cold), c, cold), null, 'nothing held: closed');
  const slow = rig(); slow.get = async (u, o) => { await new Promise(r => setTimeout(r, 20)); throw new Error('timeout'); };
  assert.equal(await verifyAccessToken(mintAt(slow), c, slow), null);
  const r = rig();
  assert.ok(await verifyAccessToken(mintAt(r), c, r));
  r.get.fail = true;
  r.clock.t += JWKS_TTL_MS + JWKS_REFETCH_MIN_MS;
  assert.equal(keyCacheState(r.cache, r.now()), 'stale');
  assert.ok(await verifyAccessToken(mintAt(r), c, r), 'stale keys still verify while the list is down');
  r.clock.t += JWKS_STALE_OK_MS;
  assert.equal(keyCacheState(r.cache, r.now()), 'expired');
  assert.equal(await verifyAccessToken(mintAt(r), c, r), null, 'a day without the list: closed');
  r.clock.t -= 10 * JWKS_STALE_OK_MS;
  assert.equal(keyCacheState(r.cache, r.now()), 'expired', 'a clock that went backwards trusts nothing');
});

test('createAccess keeps a verdict beside the request; a request with no token is absent', async () => {
  const r = rig();
  const a = createAccess(cfg(), { now: r.now, get: r.get });
  const withTok = { headers: { 'cf-access-jwt-assertion': mintAt(r, { email: ADA }) } };
  const without = { headers: {} };
  assert.equal((await a.resolve(withTok)).verdict, 'guest');
  assert.equal((await a.resolve(without)).verdict, 'absent');
  assert.equal(verdictOfRequest(withTok).handle, 'ada');
  assert.equal(verdictOfRequest({ headers: {} }).verdict, 'absent', 'never resolved: absent');
  assert.equal((await a.resolve({ headers: { 'cf-access-jwt-assertion': 'junk' } })).verdict, 'invalid');
});

test('a connection record is live until its token expires', () => {
  const rec = connectionRecord('guest', 5000);
  assert.ok(connectionLive(rec, 4999)); assert.ok(!connectionLive(rec, 5000)); assert.ok(!connectionLive(undefined));
  assert.ok(connectionLive(connectionRecord('owner'), 9e15));
});

test('the key list address is the team\'s; a different one is refused outside tests', () => {
  const was = process.env.PLUGIN_ACCESS_TEST_CERTS;
  try {
    delete process.env.PLUGIN_ACCESS_TEST_CERTS;
    assert.equal(buildAccessConfig(RAW).certsUrl, `https://${TEAM}/cdn-cgi/access/certs`);
    for (const u of ['http://127.0.0.1:9/certs', 'https://keys.example.test/certs']) {
      assert.throws(() => buildAccessConfig({ ...RAW, certs_url_for_tests: u }), e => e instanceof AccessConfigError && /outside tests/.test(e.message));
    }
    process.env.PLUGIN_ACCESS_TEST_CERTS = '1';
    assert.equal(buildAccessConfig({ ...RAW, certs_url_for_tests: 'http://127.0.0.1:9/certs' }).certsUrl, 'http://127.0.0.1:9/certs');
    assert.throws(() => buildAccessConfig({ ...RAW, certs_url_for_tests: 'ftp://x' }), AccessConfigError);
  } finally { if (was === undefined) delete process.env.PLUGIN_ACCESS_TEST_CERTS; else process.env.PLUGIN_ACCESS_TEST_CERTS = was; }
});

test('settings: what is missing is named, never a value; handles; duplicates', () => {
  assert.throws(() => buildAccessConfig({}), e => e instanceof AccessConfigError && /team/.test(e.message) && /aud/.test(e.message) && /owner_email/.test(e.message) && /extension_ids/.test(e.message));
  const { extension_ids, ...noIds } = RAW;
  assert.throws(() => buildAccessConfig(noIds), e => e instanceof AccessConfigError && /extension_ids/.test(e.message), 'no list of extension ids: refused');
  assert.throws(() => buildAccessConfig({ ...RAW, extension_ids: [] }), AccessConfigError);
  assert.throws(() => buildAccessConfig({ ...RAW, extension_ids: ['short'] }), AccessConfigError);
  assert.deepEqual(buildAccessConfig({ ...RAW, extension_ids: [EXT_ID.toUpperCase(), EXT_ID] }).extensionIds, [EXT_ID]);
  assert.throws(() => buildAccessConfig({ ...RAW, team: 'https://team.example.test/' }), AccessConfigError);
  assert.throws(() => buildAccessConfig({ ...RAW, aud: 'short' }), AccessConfigError);
  assert.throws(() => buildAccessConfig({ ...RAW, owner_email: 'not an email' }), AccessConfigError);
  assert.throws(() => buildAccessConfig({ ...RAW, collaborators: ['bad'] }), AccessConfigError);
  assert.throws(() => buildAccessConfig({ ...RAW, collaborators: [ADA, ADA.toUpperCase()] }), AccessConfigError);
  assert.throws(() => buildAccessConfig({ ...RAW, collaborators: [OWNER] }), AccessConfigError, 'the owner is not also a collaborator');
  assert.throws(() => buildAccessConfig({ ...RAW, collaborators: 'x' }), AccessConfigError);
  try { buildAccessConfig({ ...RAW, aud: 'x' }); } catch (e) { assert.ok(!e.message.includes(OWNER) && !e.message.includes(TEAM)); }
  const c = buildAccessConfig({ ...RAW, collaborators: [ADA, { email: 'bo@example.test', handle: 'Bo Peep' }, 'ada@other.example.test', 'owner@elsewhere.example.test'] }, { ownerHandle: 'mira' });
  assert.equal(c.people.get(ADA).handle, 'ada');
  assert.equal(c.people.get('bo@example.test').handle, 'bo-peep');
  const h = [...c.people.values()].map(p => p.handle).filter(Boolean);
  assert.equal(new Set(h).size, h.length, 'handles are unique');
  assert.match(c.people.get('ada@other.example.test').handle, /^ada-[0-9a-f]{4}$/);
  assert.match(c.people.get('owner@elsewhere.example.test').handle, /^owner-[0-9a-f]{4}$/, 'the word owner is taken');
  const own = buildAccessConfig({ ...RAW, collaborators: ['mira@example.test'] }, { ownerHandle: 'mira' });
  assert.match(own.people.get('mira@example.test').handle, /^mira-[0-9a-f]{4}$/, "a collaborator cannot take the owner's name");
  assert.throws(() => buildAccessConfig({ ...RAW, collaborators: [{ email: ADA, handle: 'mira' }] }, { ownerHandle: 'mira' }), AccessConfigError);
});

test('loading: no file is password mode; a broken file or an unknown mode refuses; access needs everything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-acc-'));
  try {
    assert.equal(loadHostedAuth({ dir }).mode, 'password');
    const put = v => fs.writeFileSync(path.join(dir, 'plugin-access.json'), typeof v === 'string' ? v : JSON.stringify(v));
    put('{ nope'); assert.throws(() => loadHostedAuth({ dir }), AccessConfigError);
    put('[]'); assert.throws(() => loadHostedAuth({ dir }), AccessConfigError);
    put({ hosted_auth: 'sso' }); assert.throws(() => loadHostedAuth({ dir }), AccessConfigError);
    put({ hosted_auth: 'access' }); assert.throws(() => loadHostedAuth({ dir }), AccessConfigError);
    put({ hosted_auth: 'either', team: TEAM }); assert.throws(() => loadHostedAuth({ dir }), AccessConfigError);
    put({ hosted_auth: 'password' }); assert.deepEqual([loadHostedAuth({ dir }).mode, loadHostedAuth({ dir }).config], ['password', null]);
    put(RAW); assert.equal(loadHostedAuth({ dir }).config.owner, OWNER);
    put({ ...RAW, hosted_auth: 'either' }); assert.equal(loadHostedAuth({ dir }).mode, 'either');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
