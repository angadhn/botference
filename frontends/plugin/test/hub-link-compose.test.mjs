// hub-link-compose.test.mjs — the hub link's third reply target, a STAND-ALONE POST (`compose: true`): exactly one target kind a
// request, no quote, no add_to; filed through the same thread, record, press and limits as the others, on one fixed private page
// record the companion makes (bindCompose), which the Hub's origin names. In this process, with stand-ins for the companion's parts.
//
//   node --test test/hub-link-compose.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as L from '../hub-link.mjs';

const ORIGIN = 'https://blog.example.com';
const PAGE = `${ORIGIN}${L.HUB_COMPOSE_PATH}`;
async function linkWith({ publish = 'one-click', queue = () => ({ entries: [], run: null }), readPage = () => null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubcompose-'));
  const key = L.newKey({ hub_origin: ORIGIN, publish });
  L.writeLinkKey(dir, key);
  const seen = { binds: 0, composeBinds: [], filed: [], presses: [], threads: 0 };
  const link = L.createHubLink({ keyDir: dir, repliesFile: path.join(dir, L.HUB_LINK_REPLIES_FILE), log: () => {}, perMinute: 10000,
    bind: async () => { seen.binds++; return { verdict: 'verified', url: 'https://blyg.example.com/t/x/', origin: 'https://blyg.example.com/', id: 'x', version: 1 }; },
    bindCompose: ({ origin }) => { seen.composeBinds.push(origin); return { verdict: 'verified', url: PAGE, compose: true }; },
    fileReply: a => { seen.filed.push(a); return { url: a.bound.url, thread_id: `t${++seen.threads}` }; },
    press: async a => { seen.presses.push(a); return { ok: true, queued: { id: `e${seen.presses.length}` } }; },
    cancel: () => ({ ok: true }), discard: () => ({ ok: true }), queue, readPage, earlierFor: () => null });
  const srv = http.createServer((q, s) => link.handle(q, s, q.url.split('?')[0]));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const send = async (route, obj) => {
    const body = JSON.stringify(obj);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/hub-link/${route}`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', ...L.signedHeaders(key, `/hub-link/${route}`, body) } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { send, seen, dir, close: () => new Promise(r => srv.close(r)) };
}
const compose = (rid, extra = {}) => ({ rid, compose: true, comment: 'A thought of my own.', intent: 'draft', ...extra });

test('the target kinds are one list: post, clipping, compose; the synthetic page is a constant under the Hub\'s own origin', () => {
  assert.deepEqual([...L.HUB_LINK_TARGETS], ['post', 'clipping', 'compose']);
  assert.equal(L.HUB_COMPOSE_PATH.startsWith('/'), true);
  assert.equal(L.composeUrlOf(ORIGIN), PAGE);
  assert.equal(L.composeUrlOf('https://blog.example.com/'), PAGE);
});

test('exactly one target kind a request, and compose must be true with no quote and no add_to', async () => {
  const k = await linkWith();
  try {
    const bad = async (extra, why) => { const r = await k.send('reply', { rid: `rid-bad-${Math.random().toString(36).slice(2, 10)}`, comment: 'x', intent: 'draft', ...extra }); assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.json)}`); };
    await bad({}, 'no target');
    await bad({ compose: true, post: { page: 'https://p.example/', origin: 'https://p.example/', id: 'x' }, quote: undefined }, 'compose and post');
    await bad({ compose: true, clipping: '0123456789abcdef' }, 'compose and clipping');
    await bad({ compose: false }, 'compose false');
    await bad({ compose: 'yes' }, 'compose not true');
    await bad({ compose: true, quote: 'a passage of words' }, 'a quote');
    await bad({ compose: true, add_to: 'abc123' }, 'add_to');
    assert.deepEqual([k.seen.binds, k.seen.composeBinds.length, k.seen.threads], [0, 0, 0], 'nothing was verified or filed');
  } finally { await k.close(); }
});

test('a stand-alone draft is filed on the synthetic page, never verified as a post; its record names its target and the status reads back', async () => {
  const k = await linkWith({ publish: 'drafts-only', readPage: () => ({ url: PAGE, threads: [{ id: 't1', msgs: [{ ts: 'x1', text: 'A thought of my own.', channel: 'hub-link' }] }] }) });
  try {
    const r = await k.send('reply', compose('rid-compose-0001'));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.state, 'saved');
    assert.deepEqual(k.seen.composeBinds, [ORIGIN]);
    assert.equal(k.seen.binds, 0);
    assert.equal(k.seen.filed[0].bound.compose, true);
    assert.equal(k.seen.filed[0].quote, '');
    const rec = JSON.parse(fs.readFileSync(path.join(k.dir, L.HUB_LINK_REPLIES_FILE), 'utf8')).records[0];
    assert.equal(rec.target, 'compose');
    assert.equal(rec.post, undefined);
    assert.equal(rec.clipping, undefined);
    assert.equal(rec.add_to, '');
    const s = await k.send('status', { rids: ['rid-compose-0001'], text: true });
    assert.equal(s.json.replies[0].state, 'saved');
    assert.deepEqual(s.json.replies[0].blocks.map(b => b.text), ['A thought of my own.']);
  } finally { await k.close(); }
});

test('exactly once by rid: the same request again files and presses nothing more', async () => {
  const k = await linkWith();
  try {
    const a = await k.send('reply', compose('rid-compose-0002', { intent: 'publish' }));
    const b = await k.send('reply', compose('rid-compose-0002', { intent: 'publish' }));
    assert.equal(a.status, 200);
    assert.deepEqual([b.status, b.json.repeated], [200, true]);
    assert.deepEqual([k.seen.threads, k.seen.presses.length, k.seen.composeBinds.length], [1, 1, 1]);
    assert.equal(k.seen.presses[0].join, undefined, 'a new post: never an addition');
  } finally { await k.close(); }
});

test('a stand-alone publish counts as one of the day\'s 10, and the 11th is kept as a draft, refused for the limit', async () => {
  const many = { url: PAGE, threads: Array.from({ length: 30 }, (_, i) => ({ id: `t${i + 1}`, msgs: [{ ts: 'x', text: 'A thought of my own.', channel: 'hub-link' }] })) };
  const k = await linkWith({ readPage: () => many });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await k.send('reply', compose(`rid-compose-d${String(i).padStart(3, '0')}`, { intent: 'publish' }))).status, 200);
    assert.equal(k.seen.presses.length, 10);
    const over = await k.send('reply', compose('rid-compose-d999', { intent: 'publish' }));
    assert.equal(over.status, 200);
    assert.equal(over.json.state, 'saved');
    assert.equal(over.json.press.refused, 'publishes-per-day');
    assert.equal(k.seen.presses.length, 10);
    assert.equal(JSON.parse(fs.readFileSync(path.join(k.dir, L.HUB_LINK_REPLIES_FILE), 'utf8')).records.filter(r => r.step === 'pressed').length, 10);
  } finally { await k.close(); }
});

test('the replies-per-hour limit counts stand-alone posts too', async () => {
  const k = await linkWith({ publish: 'drafts-only' });
  try {
    for (let i = 0; i < L.HUB_LINK_LIMITS.repliesPerHour; i++) assert.equal((await k.send('reply', compose(`rid-compose-h${String(i).padStart(3, '0')}`))).status, 200);
    const over = await k.send('reply', compose('rid-compose-h999'));
    assert.deepEqual([over.status, over.json.limit], [429, 'replies-per-hour']);
  } finally { await k.close(); }
});

test('a stand-alone draft is discarded (cancel) like any other, and a cancel before it arrives is remembered', async () => {
  const page = { url: PAGE, threads: [{ id: 't1', msgs: [{ ts: 'x1', text: 'A thought of my own.', channel: 'hub-link' }] }] };
  const k = await linkWith({ publish: 'drafts-only', readPage: () => page });
  try {
    // the stand-in file reply gives no ts, so the record has none: the thread's first message is the filed one
    await k.send('reply', compose('rid-compose-0003'));
    const c = await k.send('cancel', { rid: 'rid-compose-0003' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.state, 'cancelled');
    const early = await k.send('cancel', { rid: 'rid-compose-0004' });
    assert.equal(early.json.state, 'cancelled');
    const late = await k.send('reply', compose('rid-compose-0004'));
    assert.deepEqual([late.status, late.json.error], [409, 'cancelled']);
    assert.equal(k.seen.threads, 1);
  } finally { await k.close(); }
});
