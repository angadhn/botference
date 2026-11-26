// hub-link.test.mjs — the hub link's parts on their own (hub-link.mjs): the key file, signing and verification, the nonce cache,
// the limits, the state the Hub is told (every queue state), and the rid record store. A fake clock throughout; no server, no network.
//
//   node --test test/hub-link.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as L from '../hub-link.mjs';
import { ENTRY_STATES } from '../blyg-queue.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hublink-'));
const KEY = { key_id: '0a1b2c3d', secret: crypto.randomBytes(32).toString('base64url'), hub_origin: 'https://blog.example.com', publish: 'one-click', created_at: '2026-11-26T10:00:00.000Z' };
const NOW = 1_800_000_000;
const verify = (headers, { body = '{"a":1}', urlPath = '/hub-link/ping', key = KEY, nowSec = NOW, nonces = L.createNonceCache({ now: () => nowSec * 1000 }) } = {}) =>
  L.verifySigned({ headers, urlPath, body: Buffer.from(body), key, nowSec, nonces });
const signed = (o = {}) => L.signedHeaders(o.key || KEY, o.urlPath || '/hub-link/ping', o.body || '{"a":1}', { ts: o.ts || NOW, nonce: o.nonce });

test('the string to sign is exactly the documented one, and the signature is HMAC-SHA256 keyed with the secret\'s 32 bytes', () => {
  const body = '{"rid":"abcdefgh"}';
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(L.stringToSign('/hub-link/reply', '1800000000', 'ab'.repeat(16), hash), `v1\nPOST\n/hub-link/reply\n1800000000\n${'ab'.repeat(16)}\n${hash}`);
  const want = crypto.createHmac('sha256', Buffer.from(KEY.secret, 'base64url')).update(`v1\nPOST\n/hub-link/reply\n1800000000\n${'ab'.repeat(16)}\n${hash}`).digest('hex');
  assert.equal(L.signRequest(KEY.secret, '/hub-link/reply', 1800000000, 'ab'.repeat(16), body), want);
});

test('a good signature passes; the same nonce again is a replay', () => {
  const nonces = L.createNonceCache({ now: () => NOW * 1000 });
  const h = signed();
  assert.deepEqual(verify(h, { nonces }), { ok: true });
  assert.deepEqual(verify(h, { nonces }), { ok: false, why: 'replayed-nonce' });
});

test('every bad signature is refused, with a reason code only', () => {
  const other = { ...KEY, secret: crypto.randomBytes(32).toString('base64url') };
  assert.equal(verify(signed({ key: other })).why, 'bad-sig', 'the right key id with another secret');
  assert.equal(verify(signed({ key: { ...KEY, key_id: 'ffffffff' } })).why, 'wrong-key');
  assert.equal(verify(signed({ ts: NOW - 121 })).why, 'stale-ts');
  assert.equal(verify(signed({ ts: NOW + 121 })).why, 'stale-ts', 'from the future too');
  assert.deepEqual(verify(signed({ ts: NOW - 120 })), { ok: true }, 'the window is ±120 s');
  assert.equal(verify(signed(), { body: '{"a":2}' }).why, 'bad-sig', 'a body that is not the one signed');
  assert.equal(verify(signed(), { urlPath: '/hub-link/reply' }).why, 'bad-sig', 'another route');
  const h = signed();
  for (const k of Object.values(L.SIG_HEADERS)) { const x = { ...h }; delete x[k]; assert.equal(verify(x).why, 'missing-header', k); }
  assert.equal(verify({ ...h, 'x-hub-link-nonce': 'not-hex' }).why, 'bad-nonce');
  assert.equal(verify({ ...h, 'x-hub-link-sig': 'zz' }).why, 'bad-sig');
  assert.equal(verify({ ...h, 'x-hub-link-ts': '1e9' }).why, 'bad-ts');
});

test('a forged request does not burn the nonce the Hub will use', () => {
  const nonces = L.createNonceCache({ now: () => NOW * 1000 });
  const nonce = 'cd'.repeat(16);
  const forged = signed({ key: { ...KEY, secret: crypto.randomBytes(32).toString('base64url') }, nonce });
  assert.equal(verify(forged, { nonces }).why, 'bad-sig');
  assert.deepEqual(verify(signed({ nonce }), { nonces }), { ok: true });
});

test('the nonce cache forgets after ten minutes and refuses when full', () => {
  let t = 0;
  const c = L.createNonceCache({ now: () => t, max: 2 });
  assert.equal(c.take('a'), 'fresh'); assert.equal(c.take('b'), 'fresh');
  assert.equal(c.take('c'), 'full');
  assert.equal(c.take('a'), 'replayed');
  t = L.HUB_LINK_LIMITS.nonceMs;
  assert.equal(c.take('a'), 'fresh', 'forgotten after the window');
});

test('the request window: 30 a minute, then refused until the minute has passed', () => {
  let t = 0;
  const w = L.createWindow({ ms: 60000, max: L.HUB_LINK_LIMITS.requestsPerMinute, now: () => t });
  for (let i = 0; i < 30; i++) assert.equal(w.take(), true);
  assert.equal(w.take(), false);
  t = 59999; assert.equal(w.take(), false);
  t = 60000; assert.equal(w.take(), true);
  assert.deepEqual([L.HUB_LINK_LIMITS.repliesPerHour, L.HUB_LINK_LIMITS.publishesPerDay, L.HUB_LINK_LIMITS.bodyBytes], [20, 10, 16384]);
});

test('an https origin only: the Hub\'s address is refused when it is http, has a path, a query or credentials', () => {
  assert.equal(L.hubOriginOf('https://blog.example.com'), 'https://blog.example.com');
  assert.equal(L.hubOriginOf('https://blog.example.com/'), 'https://blog.example.com');
  for (const bad of ['http://blog.example.com', 'https://blog.example.com/hub', 'https://blog.example.com/?x=1', 'https://u:p@blog.example.com', 'blog.example.com', '', 'javascript:alert(1)', 'https://blog.example.com#x'])
    assert.equal(L.hubOriginOf(bad), '', bad);
});

test('the key file: 0600, read back, a broken one is the gate `broken` and is never written over by a read', () => {
  const dir = tmp();
  assert.equal(L.readLinkKey(dir).gate, 'off');
  const k = L.newKey({ hub_origin: 'https://blog.example.com', publish: 'drafts-only' });
  assert.match(k.key_id, /^[0-9a-f]{8}$/);
  assert.equal(Buffer.from(k.secret, 'base64url').length, 32);
  L.writeLinkKey(dir, k);
  assert.equal(fs.statSync(L.keyFileOf(dir)).mode & 0o777, 0o600);
  assert.deepEqual(L.readLinkKey(dir), { gate: 'on', key: k });
  fs.writeFileSync(L.keyFileOf(dir), '{"key_id": "zz"');
  assert.equal(L.readLinkKey(dir).gate, 'broken');
  fs.writeFileSync(L.keyFileOf(dir), JSON.stringify({ ...k, publish: 'everything' }));
  assert.equal(L.readLinkKey(dir).gate, 'broken', 'a publish value not in the list');
  assert.equal(fs.readFileSync(L.keyFileOf(dir), 'utf8'), JSON.stringify({ ...k, publish: 'everything' }));
  assert.equal(L.deleteLinkKey(dir), true);
  assert.equal(L.readLinkKey(dir).gate, 'off');
  assert.equal(L.fingerprintOf('x'), crypto.createHash('sha256').update('x').digest('hex').slice(0, 8));
});

// ---- the state the Hub is told ----
const rec = (extra = {}) => ({ rid: 'rid-00000001', step: 'pressed', page_url: 'https://blyg.example.com/t/x/', thread_id: 't1', intent: 'publish', at: '2026-11-26T10:00:00Z', entry_id: 'e1', ...extra });
const page = (extra = {}) => ({ url: 'https://blyg.example.com/t/x/', threads: [{ id: 't1', msgs: [], ...extra }] });

test('linkStateOf: every queue state has its Hub state', () => {
  const want = { queued: 'queued', filling: 'filling', needs_look: 'awaiting_look', running: 'publishing', giving_up: 'publishing', published: 'published', failed: 'failed', cancelled: 'cancelled' };
  assert.deepEqual(Object.keys(want).sort(), [...ENTRY_STATES].sort(), 'the table covers ENTRY_STATES exactly');
  for (const s of ENTRY_STATES) {
    const got = L.linkStateOf(rec(), page(), { entries: [{ id: 'e1', state: s, run: 'r1' }], run: { id: 'r1', mode: 'applying', confirm: 'never' } });
    assert.equal(got, want[s], s);
    assert.ok(L.HUB_LINK_STATES.includes(got));
  }
});

test('linkStateOf: a running entry whose run waits at a look is awaiting_look; another run\'s look is not its', () => {
  const q = run => ({ entries: [{ id: 'e1', state: 'running', run: 'r1' }], run });
  assert.equal(L.linkStateOf(rec(), page(), q({ id: 'r1', mode: 'planned', confirm: 'always' })), 'awaiting_look');
  assert.equal(L.linkStateOf(rec(), page(), q({ id: 'r1', mode: 'planned', confirm: 'never' })), 'publishing', 'planned on its way through');
  assert.equal(L.linkStateOf(rec(), page(), q({ id: 'r2', mode: 'planned', confirm: 'always' })), 'publishing');
});

test('linkStateOf: a draft is saved; no record is unknown; a deleted thread is cancelled; an entry taken over by the drawer is followed', () => {
  assert.equal(L.linkStateOf(rec({ step: 'saved', entry_id: '' }), page(), { entries: [] }), 'saved');
  assert.equal(L.linkStateOf(null, null, { entries: [] }), 'unknown');
  assert.equal(L.linkStateOf(rec({ step: 'saved', entry_id: '' }), { threads: [] }, { entries: [] }), 'cancelled');
  assert.equal(L.linkStateOf(rec({ step: 'saved', entry_id: '' }), page({ blyg_published: { at: 'x' } }), { entries: [] }), 'published', 'published from the drawer');
  const entries = [{ id: 'e1', state: 'cancelled', replaced_by: 'e2' }, { id: 'e2', state: 'running', run: 'r9' }];
  assert.equal(L.linkStateOf(rec(), page(), { entries, run: { id: 'r9', mode: 'publishing' } }), 'publishing');
  assert.equal(L.linkStateOf(rec(), page(), { entries: [{ id: 'e1', state: 'cancelled' }] }), 'cancelled');
  // the entry is no longer kept (the queue keeps the newest 20 finished): the thread says
  assert.equal(L.linkStateOf(rec(), page({ blyg_published: { at: 'x' } }), { entries: [] }), 'published');
  assert.equal(L.linkStateOf(rec(), page(), { entries: [] }), 'failed');
});

test('a record\'s step moves only saved → pressed', () => {
  const r = { step: 'saved' };
  L.moveRecord(r, 'pressed', { entry_id: 'e1' });
  assert.deepEqual(r, { step: 'pressed', entry_id: 'e1' });
  assert.throws(() => L.moveRecord(r, 'saved'), L.IllegalRecordMove);
  assert.throws(() => L.moveRecord(r, 'pressed'), L.IllegalRecordMove);
  assert.throws(() => L.moveRecord({ step: 'saved' }, 'gone'), /no such step/);
});

test('the record store: 0600, atomic, read back after a restart, counts by time, an unreadable file never written over', () => {
  const dir = tmp();
  const file = path.join(dir, L.HUB_LINK_REPLIES_FILE);
  let t = new Date('2026-11-26T10:00:00Z');
  const s = L.createReplyStore({ file, now: () => t });
  s.add({ rid: 'rid-aaaaaaaa', at: t.toISOString(), intent: 'publish', page_url: 'https://x.example.com/', thread_id: 't1', entry_id: '', pressed_at: '' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), [L.HUB_LINK_REPLIES_FILE], 'no temp file left beside it');
  assert.throws(() => s.add({ rid: 'rid-aaaaaaaa', at: t.toISOString(), intent: 'draft', page_url: '', thread_id: 't2' }), /already/);
  s.move('rid-aaaaaaaa', 'pressed', { entry_id: 'e1', pressed_at: t.toISOString() });
  const again = L.createReplyStore({ file, now: () => t });
  assert.deepEqual([again.get('rid-aaaaaaaa').step, again.get('rid-aaaaaaaa').entry_id], ['pressed', 'e1']);
  assert.deepEqual([again.repliesSince(3600e3), again.pressesSince(86400e3)], [1, 1]);
  t = new Date('2026-11-27T10:00:01Z');
  assert.deepEqual([again.repliesSince(3600e3), again.pressesSince(86400e3)], [0, 0]);
  fs.writeFileSync(file, '{ not json');
  const broken = L.createReplyStore({ file, now: () => t });
  assert.equal(broken.state, 'unreadable');
  assert.equal(broken.get('rid-aaaaaaaa'), null);
  assert.throws(() => broken.add({ rid: 'rid-bbbbbbbb', at: t.toISOString(), intent: 'draft', page_url: '', thread_id: 't' }), /unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'kept as it was');
});

test('rid: 8 to 64 of letters, digits, - and _; a log tag is its first 8', () => {
  for (const ok of ['abcdefgh', 'A'.repeat(64), 'r_1-2345']) assert.equal(L.ridOk(ok), true, ok);
  for (const bad of ['short', 'A'.repeat(65), 'has space1', 'semi;colon', 12345678, null]) assert.equal(L.ridOk(bad), false, String(bad));
  assert.equal(L.ridTag('abcdefghijkl'), 'abcdefgh');
});

test('every route is in one table, under /hub-link/', () => {
  assert.deepEqual(Object.keys(L.HUB_LINK_ROUTES).sort(), ['cancel', 'ping', 'publish', 'reply', 'status']);
  for (const [name, r] of Object.entries(L.HUB_LINK_ROUTES)) assert.equal(r.path, `/hub-link/${name}`);
});
