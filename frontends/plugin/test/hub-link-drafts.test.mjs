// hub-link-drafts.test.mjs — drafts collected on the Hub (hub-link.mjs): a draft's fill progress (HUB_LINK_FILLS, fillOf), its own
// text read back as blocks (blocksOf, `status {text:true}`), `redo` of one agent passage, `cancel` discarding a saved draft, and
// several Publish calls in a row under the day limit. The routes run in this process with stand-ins for the companion: no server,
// no web, no model.
//
//   node --test test/hub-link-drafts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as L from '../hub-link.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubdrafts-'));
const URL_X = 'https://blyg.example.com/t/x/';
const gap = (id, mode, extra = {}) => ({ id, kind: 'ask', agent: 'claude', instruction: `do ${id}`, mode, ...extra });

// a companion stand-in: pages in a Map, threads made by fileReply, a queue of entries, the hourly passage budget
async function linkWith({ publish = 'one-click', text = 'My own words.', gaps = [], budget = 30, entries = [] } = {}) {
  const dir = tmp();
  const key = L.newKey({ hub_origin: 'https://blog.example.com', publish });
  L.writeLinkKey(dir, key);
  const pages = new Map([[URL_X, { url: URL_X, threads: [] }]]);
  const seen = { presses: [], redos: [], discards: [] };
  const q = { entries };
  const link = L.createHubLink({ keyDir: dir, repliesFile: path.join(dir, L.HUB_LINK_REPLIES_FILE), log: () => {}, perMinute: 10000,
    bind: async () => ({ verdict: 'verified', url: URL_X, origin: 'https://blyg.example.com/', id: 'x', version: 1 }),
    fileReply: () => { const p = pages.get(URL_X); const id = `t${p.threads.length + 1}`; p.threads.push({ id, msgs: [{ text, gaps: JSON.parse(JSON.stringify(gaps)) }] }); return { url: URL_X, thread_id: id }; },
    press: async ({ thread_id }) => { const id = `e${seen.presses.length + 1}`; seen.presses.push(thread_id); q.entries.push({ id, state: 'queued', page_url: URL_X, thread_id, ahead: q.entries.length }); return { ok: true, queued: { id } }; },
    cancel: () => ({ ok: true }), queue: () => ({ entries: q.entries, run: null }), readPage: url => pages.get(url) || null,
    gapBudget: () => budget,
    redoGap: ({ thread_id, gap_id }) => { seen.redos.push(gap_id); const g = pages.get(URL_X).threads.find(t => t.id === thread_id).msgs[0].gaps.find(x => x.id === gap_id); g.mode = 'pending'; delete g.text; return { ok: true }; },
    discard: ({ thread_id }) => { seen.discards.push(thread_id); const p = pages.get(URL_X); p.threads = p.threads.filter(t => t.id !== thread_id); return { ok: true }; } });
  const srv = http.createServer((qq, s) => link.handle(qq, s, qq.url.split('?')[0]));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const send = async (route, obj) => {
    const body = JSON.stringify(obj);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/hub-link/${route}`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', ...L.signedHeaders(key, `/hub-link/${route}`, body) } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const draft = rid => send('reply', { rid, post: { page: URL_X, origin: 'https://blyg.example.com/', id: 'x' }, quote: 'a passage of words here', comment: 'c', intent: 'draft' });
  return { send, draft, seen, pages, q, dir, close: () => new Promise(r => srv.close(r)) };
}

test('fillOf: one named value from the gaps (HUB_LINK_FILLS)', () => {
  assert.deepEqual(L.HUB_LINK_FILLS, ['writing', 'ready', 'failed']);
  assert.equal(L.fillOf([]), 'ready', 'no passages: ready');
  assert.equal(L.fillOf([gap('a', 'pending'), gap('b', 'failed')]), 'writing', 'still writing wins');
  assert.equal(L.fillOf([gap('a', 'filled-by-agent'), gap('b', 'failed')]), 'failed');
  assert.equal(L.fillOf([gap('a', 'filled-by-agent'), gap('b', 'removed'), gap('c', 'edited-by-reader'), gap('d', 'pasted-by-reader')]), 'ready');
});

test('blocksOf: the reply\'s own words and its agent passages, in order; a removed passage is not there; agent text capped', () => {
  const msg = { text: 'Before.\n/tk first thing\nMiddle /tk(second) end.\n/tk third', gaps: [
    gap('g1', 'filled-by-agent', { instruction: 'first thing', text: 'ONE', model: 'm1', at: '2026-11-26T10:00:00Z' }),
    gap('g2', 'failed', { instruction: 'second', reason: 'the hourly limit is reached' }),
    gap('g3', 'removed', { instruction: 'third' })] };
  assert.deepEqual(L.blocksOf(msg), [
    { kind: 'own', text: 'Before.\n' },
    { kind: 'agent', id: 'g1', instruction: 'first thing', state: 'filled-by-agent', text: 'ONE', model: 'm1', at: '2026-11-26T10:00:00Z' },
    { kind: 'own', text: '\nMiddle ' },
    { kind: 'agent', id: 'g2', instruction: 'second', state: 'failed', text: '', model: '', at: '', reason: 'the hourly limit is reached' },
    { kind: 'own', text: ' end.\n' }]);
  const big = { text: '/tk a\n/tk b', gaps: [gap('a', 'filled-by-agent', { instruction: 'a', text: 'x'.repeat(L.HUB_LINK_LIMITS.agentTextBytes - 10) }), gap('b', 'filled-by-agent', { instruction: 'b', text: 'y'.repeat(100) })] };
  const agent = L.blocksOf(big).filter(b => b.kind === 'agent');
  assert.equal(Buffer.byteLength(agent.map(b => b.text).join('')), L.HUB_LINK_LIMITS.agentTextBytes, 'the agent text is cut at the cap');
  assert.equal(agent[1].text, 'y'.repeat(10));
});

test('A DRAFT reports its fill progress, and its text only when asked, only for its own rid', async () => {
  const k = await linkWith({ text: 'Mine.\n/tk explain', gaps: [gap('g1', 'pending', { instruction: 'explain' })] });
  try {
    const r = await k.draft('rid-draft-0001');
    assert.deepEqual([r.json.state, r.json.fill], ['saved', 'writing']);
    assert.equal(r.json.blocks, undefined, 'no text unless asked');
    Object.assign(k.pages.get(URL_X).threads[0].msgs[0].gaps[0], { mode: 'filled-by-agent', text: 'AGENT', model: 'm', at: 'now' });
    const s = await k.send('status', { rids: ['rid-draft-0001', 'rid-never-0001'], text: true });
    const [mine, other] = s.json.replies;
    assert.deepEqual([mine.state, mine.fill], ['saved', 'ready']);
    assert.deepEqual(mine.blocks.map(b => [b.kind, b.text]), [['own', 'Mine.\n'], ['agent', 'AGENT']]);
    assert.deepEqual(other, { rid: 'rid-never-0001', state: 'unknown' }, 'nothing for a rid this link did not file');
    k.pages.get(URL_X).threads[0].msgs[0].gaps[0].mode = 'failed';
    k.pages.get(URL_X).threads[0].msgs[0].gaps[0].reason = 'the agent could not be reached at /Users/someone/x/y';
    const f = (await k.send('status', { rids: ['rid-draft-0001'] })).json.replies[0];
    assert.deepEqual([f.fill, f.fill_why], ['failed', 'the agent could not be reached at <path>']);
    assert.equal((await k.send('status', { rids: Array.from({ length: 6 }, (_, i) => `rid-many-000${i}`), text: true })).status, 400, 'text for at most 5 at once');
  } finally { await k.close(); }
});

test('REDO one agent passage of a saved draft: asked again, counted against the hourly limit; refused while pending, published or over the limit', async () => {
  const k = await linkWith({ text: '/tk explain', gaps: [gap('g1', 'filled-by-agent', { instruction: 'explain', text: 'OLD' })] });
  try {
    await k.draft('rid-redo-00001');
    const r = await k.send('redo', { rid: 'rid-redo-00001', gap: 'g1' });
    assert.deepEqual([r.status, r.json.state, r.json.fill], [200, 'saved', 'writing']);
    assert.deepEqual(k.seen.redos, ['g1']);
    assert.equal((await k.send('redo', { rid: 'rid-redo-00001', gap: 'g1' })).status, 409, 'already being written');
    assert.equal((await k.send('redo', { rid: 'rid-redo-00001', gap: 'nope' })).status, 404);
    assert.equal((await k.send('redo', { rid: 'rid-none-00001', gap: 'g1' })).status, 404);
  } finally { await k.close(); }
  const z = await linkWith({ budget: 0, text: '/tk explain', gaps: [gap('g1', 'failed', { instruction: 'explain' })] });
  try {
    await z.draft('rid-redo-00002');
    const r = await z.send('redo', { rid: 'rid-redo-00002', gap: 'g1' });
    assert.deepEqual([r.status, r.json.limit], [429, 'passages-per-hour']);
    assert.deepEqual(z.seen.redos, []);
  } finally { await z.close(); }
  const p = await linkWith({ text: '/tk explain', gaps: [gap('g1', 'filled-by-agent', { instruction: 'explain', text: 'OLD' })] });
  try {
    await p.draft('rid-redo-00003');
    await p.send('publish', { rid: 'rid-redo-00003' });
    assert.equal((await p.send('redo', { rid: 'rid-redo-00003', gap: 'g1' })).status, 409, 'not once it is pressed');
  } finally { await p.close(); }
});

test('CANCEL A SAVED DRAFT throws it away: the thread is deleted, the state is cancelled, again is the same, publish is refused', async () => {
  const k = await linkWith();
  try {
    await k.draft('rid-discard-001');
    const c = await k.send('cancel', { rid: 'rid-discard-001' });
    assert.deepEqual([c.status, c.json.state], [200, 'cancelled']);
    assert.deepEqual(k.seen.discards, ['t1']);
    assert.equal(k.pages.get(URL_X).threads.length, 0);
    const again = await k.send('cancel', { rid: 'rid-discard-001' });
    assert.deepEqual([again.status, again.json.state, again.json.repeated], [200, 'cancelled', true]);
    assert.deepEqual(k.seen.discards, ['t1'], 'deleted once');
    assert.equal((await k.send('publish', { rid: 'rid-discard-001' })).status, 409);
    assert.equal(L.createReplyStore({ file: path.join(k.dir, L.HUB_LINK_REPLIES_FILE) }).get('rid-discard-001').step, 'discarded');
    // a draft the owner pressed in the drawer is not thrown away from the Hub
    await k.draft('rid-discard-002');
    k.q.entries.push({ id: 'own', state: 'queued', page_url: URL_X, thread_id: 't1' });
    const own = await k.send('cancel', { rid: 'rid-discard-002' });
    assert.deepEqual([own.status, own.json.state], [409, 'queued']);
    assert.deepEqual(k.seen.discards, ['t1']);
  } finally { await k.close(); }
});

test('record steps: saved → pressed | discarded; discarded and withdrawn are final', () => {
  assert.deepEqual(L.RECORD_MOVES.saved, ['pressed', 'discarded']);
  assert.throws(() => L.moveRecord({ step: 'discarded' }, 'pressed'), L.IllegalRecordMove);
  assert.throws(() => L.moveRecord({ step: 'pressed' }, 'discarded'), L.IllegalRecordMove);
  assert.equal(L.linkStateOf({ rid: 'rid-x-000001', step: 'discarded', page_url: URL_X, thread_id: 't1' }, { threads: [] }, { entries: [] }), 'cancelled');
});

test('PUBLISH SEVERAL IN A ROW: each a press in order, and the day limit still holds', async () => {
  const k = await linkWith();
  try {
    for (let i = 0; i < 12; i++) await k.draft(`rid-row-${String(i).padStart(5, '0')}`);
    const got = [];
    for (let i = 0; i < 12; i++) got.push((await k.send('publish', { rid: `rid-row-${String(i).padStart(5, '0')}` })).json);
    assert.deepEqual(k.seen.presses, ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'], 'in the order asked');
    assert.deepEqual(got.slice(0, 3).map(g => g.state), ['queued', 'queued', 'queued']);
    assert.deepEqual(got.slice(10).map(g => [g.state, g.press.refused]), [['saved', 'publishes-per-day'], ['saved', 'publishes-per-day']]);
  } finally { await k.close(); }
});
