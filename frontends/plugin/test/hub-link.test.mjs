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
// (the message the link filed: a record without `msg_ts` finds it as the first message, while it is still the link's)
const page = (extra = {}) => ({ url: 'https://blyg.example.com/t/x/', threads: [{ id: 't1', msgs: [{ channel: 'hub-link' }], ...extra }] });

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
  assert.deepEqual(Object.keys(L.HUB_LINK_ROUTES).sort(), ['cancel', 'ping', 'publish', 'redo', 'reply', 'status']);
  for (const [name, r] of Object.entries(L.HUB_LINK_ROUTES)) assert.equal(r.path, `/hub-link/${name}`);
});

// ---- the routes in this process, with stand-ins for the companion (no server, no web) ----
import http from 'node:http';
async function linkWith({ bind, press, publish = 'one-click', readPage = () => null, queue = () => ({ entries: [], run: null }), statusWaitMs } = {}) {
  const dir = tmp();
  const key = L.newKey({ hub_origin: 'https://blog.example.com', publish });
  L.writeLinkKey(dir, key);
  const seen = { threads: 0, presses: 0, binds: 0 };
  const link = L.createHubLink({ keyDir: dir, repliesFile: path.join(dir, L.HUB_LINK_REPLIES_FILE), log: () => {}, perMinute: 10000,
    bind: async a => { seen.binds++; return bind ? bind(a) : { verdict: 'verified', url: 'https://blyg.example.com/t/x/', origin: 'https://blyg.example.com/', id: 'x', version: 1 }; },
    fileReply: () => ({ url: 'https://blyg.example.com/t/x/', thread_id: `t${++seen.threads}` }),
    press: async () => { if (press) await press(); return { ok: true, queued: { id: `e${++seen.presses}` } }; },
    cancel: () => ({ ok: true }), queue, readPage, ...(statusWaitMs ? { statusWaitMs } : {}) });
  const srv = http.createServer((q, s) => link.handle(q, s, q.url.split('?')[0]));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const send = async (route, obj, raw) => {
    const body = raw !== undefined ? raw : JSON.stringify(obj);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/hub-link/${route}`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', ...L.signedHeaders(key, `/hub-link/${route}`, body) } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { send, seen, dir, close: () => new Promise(r => srv.close(r)) };
}
const slow = ms => new Promise(r => setTimeout(r, ms));
const replyOf = (rid, extra = {}) => ({ rid, post: { page: 'https://blyg.example.com/t/x/', origin: 'https://blyg.example.com/', id: 'x' }, quote: 'a passage of words here', comment: 'x', intent: 'publish', ...extra });

test('LIMITS HOLD UNDER CONCURRENCY: 30 replies at once file at most 20 and press at most 10; the rest are 429 or refused presses', async () => {
  const k = await linkWith({ bind: async () => { await slow(150); return { verdict: 'verified', url: 'https://blyg.example.com/t/x/', origin: 'https://blyg.example.com/', id: 'x', version: 1 }; }, press: () => slow(100) });
  try {
    const got = await Promise.all(Array.from({ length: 30 }, (_, i) => k.send('reply', replyOf(`rid-race-${String(i).padStart(4, '0')}`))));
    assert.equal(k.seen.threads, 20, 'filed');
    assert.equal(got.filter(g => g.status === 429).length, 10);
    assert.equal(k.seen.presses, 10, 'pressed');
    const recs = JSON.parse(fs.readFileSync(path.join(k.dir, L.HUB_LINK_REPLIES_FILE), 'utf8')).records;
    assert.deepEqual([recs.filter(r => r.step === 'pressed').length, recs.filter(r => r.press_refused === 'publishes-per-day').length], [10, 10]);
  } finally { await k.close(); }
});

test('a refused reply gives its slot back: 20 refused at once (a 21st meanwhile is 429: the slots are held), then 20 good ones are all filed', async () => {
  let refuse = true;
  const k = await linkWith({ publish: 'drafts-only', bind: async () => { await slow(50); return refuse ? { verdict: 'unverified', code: 'not-verified', reason: 'no' } : { verdict: 'verified', url: 'https://blyg.example.com/t/x/', origin: 'https://blyg.example.com/', id: 'x', version: 1 }; } });
  try {
    const bad = await Promise.all(Array.from({ length: 21 }, (_, i) => k.send('reply', replyOf(`rid-bad-${String(i).padStart(4, '0')}`))));
    assert.deepEqual([bad.filter(b => b.status === 422).length, bad.filter(b => b.status === 429).length], [20, 1]);
    refuse = false;
    for (let i = 0; i < 20; i++) assert.equal((await k.send('reply', replyOf(`rid-good-${String(i).padStart(4, '0')}`))).status, 200, `good ${i}`);
    assert.equal((await k.send('reply', replyOf('rid-good-over'))).status, 429);
  } finally { await k.close(); }
});

test('ONE LENGTH LIMIT, the encoded body: a long reply in a few bytes is filed; one over 16 KiB in any script is 413 with a fixed sentence', async () => {
  const k = await linkWith({ publish: 'drafts-only' });
  try {
    const long = await k.send('reply', replyOf('rid-long-0001', { comment: 'a'.repeat(12000) }));
    assert.equal(long.status, 200, JSON.stringify(long.json));
    const wide = await k.send('reply', replyOf('rid-wide-0001', { comment: '語'.repeat(6000) }));
    assert.equal(wide.status, 413);
    assert.deepEqual(wide.json, { ok: false, error: 'too-large', say: L.HUB_LINK_SAY['too-large'] });
    assert.match(wide.json.say, /16 KB/);
    assert.equal(k.seen.threads, 1);
  } finally { await k.close(); }
});

test('A CANCEL BEFORE THE REPLY is remembered: the reply arriving later is refused as cancelled, and nothing is filed, across a restart', async () => {
  const k = await linkWith();
  try {
    const c = await k.send('cancel', { rid: 'rid-early-0001' });
    assert.deepEqual([c.status, c.json.state], [200, 'cancelled']);
    const again = await k.send('cancel', { rid: 'rid-early-0001' });
    assert.deepEqual([again.status, again.json.state, again.json.repeated], [200, 'cancelled', true]);
    const r = await k.send('reply', replyOf('rid-early-0001'));
    assert.deepEqual([r.status, r.json.state, r.json.error], [409, 'cancelled', 'cancelled']);
    assert.deepEqual([k.seen.binds, k.seen.threads, k.seen.presses], [0, 0, 0], 'never verified, filed or pressed');
    assert.equal((await k.send('status', { rids: ['rid-early-0001'] })).json.replies[0].state, 'cancelled');
    assert.equal((await k.send('publish', { rid: 'rid-early-0001' })).json.state, 'cancelled');
    const back = L.createReplyStore({ file: path.join(k.dir, L.HUB_LINK_REPLIES_FILE) });
    assert.equal(back.get('rid-early-0001').step, 'withdrawn', 'kept on disk');
    assert.equal(back.repliesSince(3600e3), 0, 'a withdrawn rid is not a reply');
  } finally { await k.close(); }
});

test('withdrawn rids are bounded: past the cap the oldest is forgotten; filed records are never dropped for one', () => {
  const dir = tmp();
  let n = 0;
  const s = L.createReplyStore({ file: path.join(dir, 'r.json'), now: () => new Date(Date.UTC(2026, 10, 26, 0, 0, n++)) });
  s.add({ rid: 'rid-filed-001', at: new Date(Date.UTC(2026, 10, 25)).toISOString(), intent: 'draft', page_url: 'https://x.example.com/', thread_id: 't' });
  for (let i = 0; i <= L.HUB_LINK_LIMITS.withdrawnMax; i++) s.withdraw(`rid-w-${String(i).padStart(5, '0')}`);
  assert.equal(s.get('rid-w-00000'), null, 'the oldest withdrawn one is forgotten');
  assert.equal(s.get(`rid-w-${String(L.HUB_LINK_LIMITS.withdrawnMax).padStart(5, '0')}`).step, 'withdrawn');
  assert.equal(s.get('rid-filed-001').step, 'saved');
  assert.throws(() => L.moveRecord({ step: 'withdrawn' }, 'pressed'), L.IllegalRecordMove, 'withdrawn is final');
  assert.equal(L.linkStateOf({ rid: 'rid-w-00001', step: 'withdrawn' }, null, { entries: [] }), 'cancelled');
});

test('A RECORD WRITE THAT FAILS after the queue accepted the press: the answer and a later status say the real state, never unknown', async () => {
  let dir = '';
  const page = { url: 'https://blyg.example.com/t/x/', threads: [{ id: 't1', msgs: [] }] };
  const k = await linkWith({ readPage: () => page, queue: () => ({ entries: [{ id: 'e1', state: 'queued', ahead: 0 }], run: null }),
    // the queue accepts, and then the folder the records are written in cannot be written
    press: async () => { fs.chmodSync(dir, 0o500); } });
  dir = k.dir;
  try {
    const r = await k.send('reply', replyOf('rid-diskfull-01'));
    assert.equal(r.status, 500);
    assert.equal(r.json.state, 'queued', 'the 500 carries the truth');
    const s = await k.send('status', { rids: ['rid-diskfull-01'] });
    assert.ok(s.status === 503 || s.json.replies[0].state === 'queued', JSON.stringify(s.json));
    assert.notEqual(s.status === 200 && s.json.replies[0].state, 'unknown');
    assert.equal(k.seen.presses, 1);
    const again = await k.send('publish', { rid: 'rid-diskfull-01' });
    assert.equal(k.seen.presses, 1, `never pressed twice (${again.status})`);
  } finally { fs.chmodSync(dir, 0o700); await k.close(); }
});

test('A SAVED DRAFT AGED OUT after 30 days: status answers unknown; the store touched nothing but its own file', async () => {
  const dir = tmp();
  const file = path.join(dir, L.HUB_LINK_REPLIES_FILE);
  let t = new Date('2026-11-01T10:00:00Z');
  const s = L.createReplyStore({ file, now: () => t });
  s.add({ rid: 'rid-old-draft1', at: t.toISOString(), intent: 'draft', page_url: 'https://blyg.example.com/t/x/', thread_id: 't1', entry_id: '', pressed_at: '' });
  fs.writeFileSync(path.join(dir, 'page.json'), '{"threads":[{"id":"t1"}]}');
  t = new Date('2026-12-02T10:00:01Z');
  s.withdraw('rid-other-0001');   // any later write forgets the old record
  assert.equal(s.get('rid-old-draft1'), null);
  assert.equal(L.linkStateOf(s.get('rid-old-draft1'), { threads: [{ id: 't1' }] }, { entries: [] }), 'unknown');
  assert.deepEqual(fs.readdirSync(dir).sort(), [L.HUB_LINK_REPLIES_FILE, 'page.json'].sort());
  assert.equal(fs.readFileSync(path.join(dir, 'page.json'), 'utf8'), '{"threads":[{"id":"t1"}]}', 'the draft thread is the page store\'s, untouched');
});

const PAGE_X = { url: 'https://blyg.example.com/t/x/', threads: [{ id: 't1', msgs: [{ channel: 'hub-link' }] }] };
const verifiedSlowly = ms => async () => { await slow(ms); return { verdict: 'verified', url: 'https://blyg.example.com/t/x/', origin: 'https://blyg.example.com/', id: 'x', version: 1 }; };

test('D1 STATUS WAITS for a reply still being filed: never unknown for a rid in flight', async () => {
  const k = await linkWith({ publish: 'drafts-only', readPage: () => PAGE_X, bind: verifiedSlowly(300) });
  try {
    const filing = k.send('reply', replyOf('rid-inflight-01', { intent: 'draft' }));
    await slow(50);
    const s = await k.send('status', { rids: ['rid-inflight-01', 'rid-nothere-01'] });
    assert.equal(s.status, 200);
    assert.deepEqual(s.json.replies.map(r => r.state), ['saved', 'unknown']);
    assert.equal((await filing).status, 200);
  } finally { await k.close(); }
});

test('D1 …bounded: a filing slower than the wait is 503 "still being filed", never unknown', async () => {
  const k = await linkWith({ publish: 'drafts-only', readPage: () => PAGE_X, bind: verifiedSlowly(400), statusWaitMs: 100 });
  try {
    const filing = k.send('reply', replyOf('rid-inflight-02', { intent: 'draft' }));
    await slow(30);
    const s = await k.send('status', { rids: ['rid-inflight-02'] });
    assert.deepEqual([s.status, s.json], [503, { ok: false, error: 'a reply is still being filed; ask again' }]);
    await filing;
  } finally { await k.close(); }
});

test('D2 A HUB DRAFT THE OWNER PRESSED IN THE DRAWER shows the queue\'s state, and the Hub cannot press it again', async () => {
  let entries = [];
  const k = await linkWith({ readPage: () => PAGE_X, queue: () => ({ entries, run: null }) });
  try {
    assert.equal((await k.send('reply', replyOf('rid-drawer-001', { intent: 'draft' }))).json.state, 'saved');
    entries = [{ id: 'own1', state: 'queued', ahead: 2, page_url: PAGE_X.url, thread_id: 't1', pressed_by: 'owner' }];
    const s = (await k.send('status', { rids: ['rid-drawer-001'] })).json.replies[0];
    assert.deepEqual([s.state, s.ahead], ['queued', 2]);
    const p = await k.send('publish', { rid: 'rid-drawer-001' });
    assert.deepEqual([p.status, p.json.state], [409, 'queued']);
    assert.equal(k.seen.presses, 0, 'the owner\'s entry is not pressed over');
    entries = [{ id: 'own1', state: 'running', run: 'r1', page_url: PAGE_X.url, thread_id: 't1' }];
    assert.equal((await k.send('status', { rids: ['rid-drawer-001'] })).json.replies[0].state, 'publishing');
    entries = [{ id: 'own1', state: 'cancelled', page_url: PAGE_X.url, thread_id: 't1' }];
    assert.equal((await k.send('status', { rids: ['rid-drawer-001'] })).json.replies[0].state, 'saved', 'a finished entry is not open');
  } finally { await k.close(); }
});

test('D2 linkStateOf: a saved record with an open entry for its thread takes that entry\'s state', () => {
  const r = rec({ step: 'saved', entry_id: '' });
  for (const [st, want] of [['queued', 'queued'], ['filling', 'filling'], ['needs_look', 'awaiting_look'], ['running', 'publishing'], ['giving_up', 'publishing']])
    assert.equal(L.linkStateOf(r, page(), { entries: [{ id: 'o', state: st, page_url: r.page_url, thread_id: 't1' }] }), want, st);
  assert.equal(L.linkStateOf(r, page(), { entries: [{ id: 'o', state: 'queued', page_url: r.page_url, thread_id: 'other' }] }), 'saved');
});

test('D3 A CANCEL WHOSE WITHDRAWAL CANNOT BE WRITTEN is a 500 with no state, and nothing is remembered', async () => {
  const k = await linkWith();
  try {
    fs.chmodSync(k.dir, 0o500);
    const c = await k.send('cancel', { rid: 'rid-nodisk-0001' });
    fs.chmodSync(k.dir, 0o700);
    assert.deepEqual([c.status, c.json], [500, { ok: false, error: 'internal error' }]);
    assert.equal((await k.send('status', { rids: ['rid-nodisk-0001'] })).json.replies[0].state, 'unknown');
  } finally { fs.chmodSync(k.dir, 0o700); await k.close(); }
});
