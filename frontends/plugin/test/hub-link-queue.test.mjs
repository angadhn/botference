// hub-link-queue.test.mjs — a press from the owner's Hub (blyg-queue PRESSED_BY 'hub-link'): the owner is away, so it is always
// queued (never run at once in a dialog nobody is at), its presence is `away` (`promised_look` under confirm always; with `away` a
// forced look sets it aside exactly as for any queued press, blyg-queue.test.mjs), it never lifts a pause, it cannot ask for a look,
// and not set up is refused before anything runs.
// The fake command set in a throwaway git tree; no network.
//
//   node --test test/hub-link-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as R from '../blyg-run.mjs';
import * as Q from '../blyg-queue.mjs';
import { makeRig, until, mine } from './blyg-rig.mjs';

const pageOf = (n, threads) => ({ url: `https://news.example.com/p${n}`, title: `Page ${n}`, threads });
const typed = (id, text) => ({ id, quote: `A passage ${id}.`, msgs: [mine(text, { ts: `${id}-1`, channel: 'hub-link' })] });
function boot(rig, { pages = [], confirm = 'never', confirmNow } = {}) {
  const home = { ...rig.home, confirm, ...(confirm === 'never' ? { plan_guard: ['--only-note'] } : {}) };
  const store = new Map(pages.map(p => [p.url, p]));
  let q = null;
  const pub = R.createPublisher({ file: path.join(rig.out, 'run.json'), broadcast: () => {}, readConfig: () => ({ blyg_home: home }),
    readPage: url => store.get(url), savePage: p => store.set(p.url, p), onMove: (run, from) => { if (q) q.onMove(run, from); } });
  q = Q.createQueue({ file: path.join(rig.out, 'queue.json'), publisher: pub, readPage: url => store.get(url), confirmNow: confirmNow || (() => home.confirm), log: () => {},
    broadcast: () => {}, fillCheckMs: 20 });
  const press = (url, threadId, extra = {}) => q.press({ page: store.get(url), threadId, scope: 'one', shown: home.confirm, by: 'hub-link', ...extra });
  return { pub, q, store, press, entry: id => q.view().entries.find(e => e.id === id) };
}

test('a Hub press with the runner free is QUEUED (the queue starts it, presence away) and goes live', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const b = boot(rig, { pages: [pageOf(1, [typed('a', 'From the Hub, to publish.')])] });
  const r = await b.press('https://news.example.com/p1', 'a');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.queued, 'an entry, never a run view');
  assert.deepEqual([r.queued.pressed_by, r.queued.presence], ['hub-link', 'away']);
  await until(() => b.entry(r.queued.id).state === 'published', 'published');
  assert.equal(b.entry(r.queued.id).started_by, 'queue');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan', 'apply', 'publish']);
  const log = fs.readFileSync(b.pub.log.pathOf(b.pub.book.run.id), 'utf8');
  assert.match(log, /pressed from the owner's Hub \(hub link\)/, 'the troubleshooting log of the run says where the press came from');
  b.q.stop();
});

test('under confirm always a Hub press is a promised look: it stops at planned for the owner', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const b = boot(rig, { confirm: 'always', pages: [pageOf(1, [typed('a', 'Look first.')])] });
  const r = await b.press('https://news.example.com/p1', 'a');
  assert.equal(r.queued.presence, 'promised_look');
  await until(() => b.pub.book.mode === 'planned', 'planned');
  assert.equal(b.entry(r.queued.id).state, 'running');
  assert.equal(b.pub.book.run.confirm, 'always');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan']);
  b.q.stop();
});

test('a Hub press cannot ask for a look, is refused when publishing is not set up, and an unknown presser is refused', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const b = boot(rig, { pages: [pageOf(1, [typed('a', 'x words here.')])] });
  assert.equal((await b.press('https://news.example.com/p1', 'a', { look: true })).status, 400);
  assert.equal((await b.press('https://news.example.com/p1', 'a', { by: 'someone' })).status, 400);
  const off = boot(rig, { pages: [pageOf(1, [typed('a', 'x words here.')])], confirmNow: () => '' });
  const r = await off.q.press({ page: off.store.get('https://news.example.com/p1'), threadId: 'a', scope: 'one', shown: '', by: 'hub-link' });
  assert.deepEqual([r.ok, r.status], [false, 409]);
  assert.match(r.error, /not set up/);
  assert.equal(off.pub.book.mode, 'idle', 'nothing started');
  assert.deepEqual(rig.calls(), []);
  b.q.stop(); off.q.stop();
});

test('a Hub press never lifts a pause the owner lifts: it waits, queued', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const b = boot(rig, { pages: [pageOf(1, [typed('a', 'First one here.'), typed('c', 'Second one here.')])] });
  b.q.moveQueue('paused_for_site', { say: 'the site said no' });
  const r = await b.press('https://news.example.com/p1', 'a');
  assert.equal(r.ok, true);
  assert.equal(b.q.view().state, 'paused_for_site');
  assert.equal(b.entry(r.queued.id).state, 'queued');
  assert.deepEqual(rig.calls(), [], 'nothing ran');
  b.q.stop();
});

test('A HUB PRESS OF A REPLY WHOSE PASSAGE READ THE OWNER\'S NOTES waits for a look on the computer (needs_look, why notes-read; the Hub sees awaiting_look); a web-only passage goes straight out', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const withGap = (id, used) => ({ id, quote: `A passage ${id}.`, msgs: [mine('From the Hub. /tk(say it)', { ts: `${id}-1`, channel: 'hub-link',
    gaps: [{ id: 'g0', kind: 'ask', agent: 'claude', instruction: 'say it', mode: 'filled-by-agent', text: 'Said.', model: 'claude-x', at: '2026-11-24T10:00:00Z', from: 'hub-link', used }] })] });
  const b = boot(rig, { pages: [pageOf(1, [withGap('a', 'both')]), pageOf(2, [withGap('c', 'web')])] });
  const r = await b.press('https://news.example.com/p1', 'a');
  assert.equal(r.ok, true, JSON.stringify(r));
  await until(() => b.entry(r.queued.id).state === 'needs_look', 'set aside');
  assert.equal(b.entry(r.queued.id).why, 'notes-read');
  assert.deepEqual(rig.calls(), [], 'nothing written or published');
  assert.ok(Q.NEEDS_LOOK_WHY.includes('notes-read'));
  const w = await b.press('https://news.example.com/p2', 'c');
  await until(() => b.entry(w.queued.id).state === 'published', 'the web-only one published');
  b.q.stop();
});
