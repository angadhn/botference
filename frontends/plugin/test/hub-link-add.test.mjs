// hub-link-add.test.mjs — "Add to my earlier reply" from the Hub (hub-link.mjs): `earlier {post}` (what can be added to), `reply
// {…, add_to}`, a press through the plugin's own add-to-earlier path (join 'add', the post and its version), a refusal when the
// earlier post cannot take it (the reply stays a draft; `publish {rid, as:'new'}` publishes it as a new post), exactly once by rid,
// and the view saying where it goes. The routes run in this process with stand-ins for the companion.
//
//   node --test test/hub-link-add.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as L from '../hub-link.mjs';

const URL_X = 'https://blyg.example.com/t/x/';
const ORIGIN = 'https://blyg.example.com/';
const EARLIER = { post: '01knowntheearlierpostid0', address: 'https://me.example.com/b/01knowntheearlierpostid0/', permalink: '/b/01knowntheearlierpostid0/', title: 'My earlier reply about the river', version: 2, date: '2026-11-25T09:00:00Z' };

async function linkWith({ earlier = EARLIER } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubadd-'));
  const key = L.newKey({ hub_origin: 'https://blog.example.com', publish: 'one-click' });
  L.writeLinkKey(dir, key);
  const pages = new Map([[URL_X, { url: URL_X, threads: [] }]]);
  const state = { earlier, presses: [] };
  const link = L.createHubLink({ keyDir: dir, repliesFile: path.join(dir, L.HUB_LINK_REPLIES_FILE), log: () => {}, perMinute: 10000,
    bind: async () => ({ verdict: 'verified', url: URL_X, origin: ORIGIN, id: 'x', version: 1 }),
    fileReply: ({ comment }) => { const p = pages.get(URL_X); const id = `t${p.threads.length + 1}`; const ts = `2026-11-26T10:00:0${p.threads.length}.000Z`;
      p.threads.push({ id, via: 'hub-link', msgs: [{ ts, author: 'owner', provenance: 'owner-typed', channel: 'hub-link', text: comment }] }); return { url: URL_X, thread_id: id, ts }; },
    press: async a => { state.presses.push(a); return { ok: true, queued: { id: `e${state.presses.length}` } }; },
    cancel: () => ({ ok: true }), queue: () => ({ entries: [], run: null }), readPage: u => pages.get(u) || null,
    // the plugin's own add-to-earlier answer, for a page (no comment yet) or for one of its threads
    earlier: ({ page, origin, id }) => (page === URL_X && origin === ORIGIN && id === 'x' && state.earlier ? [state.earlier] : []),
    earlierFor: () => state.earlier });
  const srv = http.createServer((q, s) => link.handle(q, s, q.url.split('?')[0]));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const send = async (route, obj) => {
    const body = JSON.stringify(obj);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/hub-link/${route}`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', ...L.signedHeaders(key, `/hub-link/${route}`, body) } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const reply = (rid, extra = {}) => send('reply', { rid, post: { page: URL_X, origin: ORIGIN, id: 'x' }, quote: 'a passage of words here', comment: 'An addition.', intent: 'publish', ...extra });
  return { send, reply, state, pages, close: () => new Promise(r => srv.close(r)) };
}

test('EARLIER: the post the owner can add to, for that blyg post only: id, address, title, date, version; nothing else', async () => {
  const k = await linkWith();
  try {
    const r = await k.send('earlier', { post: { page: URL_X, origin: ORIGIN, id: 'x' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, earlier: [{ id: EARLIER.post, address: EARLIER.address, permalink: EARLIER.permalink, title: EARLIER.title, date: EARLIER.date, version: 2 }] });
    assert.deepEqual((await k.send('earlier', { post: { page: URL_X, origin: ORIGIN, id: 'y' } })).json.earlier, [], 'another post: nothing');
    assert.equal((await k.send('earlier', { post: { page: URL_X } })).status, 400);
  } finally { await k.close(); }
});

test('REPLY with add_to: pressed through the add-to-earlier path (join add, that post, its version); the view says where it goes', async () => {
  const k = await linkWith();
  try {
    const r = await k.reply('rid-add-000001', { add_to: EARLIER.post });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(k.state.presses.map(p => [p.join, p.post, p.postVersion]), [['add', EARLIER.post, 2]]);
    assert.deepEqual(r.json.adds_to, { id: EARLIER.post, title: EARLIER.title, address: EARLIER.address, state: 'ready' });
    const s = (await k.send('status', { rids: ['rid-add-000001'], text: true })).json.replies[0];
    assert.equal(s.adds_to.id, EARLIER.post, 'the read-back says which post it goes into');
  } finally { await k.close(); }
});

test('EXACTLY ONCE: the same addition sent three times, and published twice more, is pressed once', async () => {
  const k = await linkWith();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await k.reply('rid-add-000002', { add_to: EARLIER.post })).status, 200);
    for (let i = 0; i < 2; i++) await k.send('publish', { rid: 'rid-add-000002' });
    assert.equal(k.state.presses.length, 1);
  } finally { await k.close(); }
});

test('CANNOT ADD: the earlier post is no longer that one → nothing pressed, the reply stays saved with a named reason; publish as new presses a new post', async () => {
  const k = await linkWith();
  try {
    k.state.earlier = { ...EARLIER, post: '01someotherpostidentifie' };
    const r = await k.reply('rid-add-000003', { add_to: EARLIER.post });
    assert.deepEqual([r.json.state, r.json.press.refused, r.json.press.say], ['saved', 'cannot-add', L.HUB_LINK_SAY['cannot-add']]);
    assert.deepEqual(r.json.adds_to.state, 'cannot-add');
    assert.equal(k.state.presses.length, 0);
    assert.equal((await k.send('publish', { rid: 'rid-add-000003' })).json.press.refused, 'cannot-add', 'again: still refused');
    const n = await k.send('publish', { rid: 'rid-add-000003', as: 'new' });
    assert.equal(n.status, 200);
    assert.deepEqual(k.state.presses.map(p => p.join || ''), [''], 'a new post');
    assert.equal((await k.send('publish', { rid: 'rid-add-000004', as: 'sideways' })).status, 400);
    k.state.earlier = null;
    const gone = await k.reply('rid-add-000005', { add_to: EARLIER.post });
    assert.equal(gone.json.press.refused, 'cannot-add', 'no earlier post at all');
    assert.equal((await k.reply('rid-add-000006', { add_to: '../../etc' })).status, 400, 'not an id');
  } finally { await k.close(); }
});

test('the day limit counts an addition as one publish', async () => {
  const k = await linkWith();
  try {
    for (let i = 0; i < 11; i++) await k.reply(`rid-addday-${String(i).padStart(4, '0')}`, { add_to: EARLIER.post });
    assert.equal(k.state.presses.length, 10);
  } finally { await k.close(); }
});
