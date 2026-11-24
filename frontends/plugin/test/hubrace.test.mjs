// hubrace.test.mjs — what the owner does while a refresh is waiting for a document (following.mjs, finding 1 of the gate
// review): a tick, an untick, an open or a note made while that post's document is being fetched is never undone.
//
//   node --test test/hubrace.test.mjs
//
// The fake `get` holds one chosen request open until the test lets it go, so the owner's move lands exactly between the
// request and the answer. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as F from '../following.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';

const CFG = createRequire(import.meta.url)('../extension/config.js');
const A = 'https://alpha.web.test/notes/';
const day = n => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3600e3).toISOString();

async function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubrace-'));
  const web = makeWeb();
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const gate = { suffix: null, release: null, reached: null };
  const get = async (u, o) => {
    clock.t += 10;
    if (gate.suffix && String(u).endsWith(gate.suffix)) {
      gate.suffix = null;
      await new Promise(res => { gate.release = res; if (gate.reached) gate.reached(); });
    }
    return web.get(u, o);
  };
  const file = path.join(dir, 'following.json');
  const f = F.createFollowing({ file, get, now: () => clock.t, getSettings: () => CFG.followingSettingsOf({ following_unread_target: 500 }).settings,
    timers: { set: () => ({}), clear: () => {} } });
  const site = web.add(A);
  for (let k = 1; k <= 3; k++) site.put(makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: `Words of post ${k}.`, created: day(k) }));
  await f.confirmImport([{ origin: A }]);
  const r = { f, web, site, dir, file, clock,
    /** Start a refresh that stops at the request for post n's document; resolves once it is held there. */
    holdAt: async n => {
      gate.suffix = `items/${idOf(n)}.json`;
      const reached = new Promise(res => { gate.reached = res; });
      const run = f.refresh();
      await reached;
      return { run, release: async () => { gate.release(); return run; } };
    },
    ledgerIds: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'following-ledgers', `${F.ledgerName(A)}.json`), 'utf8')).ids.map(p => p[0]); } catch { return []; } },
    bodies: () => { try { return fs.readdirSync(path.join(dir, 'following-bodies')).filter(x => x.endsWith('.html')); } catch { return []; } },
    feed: async () => (await f.view({ limit: 1000 })).entries.map(e => e.head),
    done: () => fs.rmSync(dir, { recursive: true, force: true }) };
  return r;
}
const edit = (r, n, { words = true } = {}) => r.site.put(makeDoc({ id: idOf(n), origin: A, title: `Post ${n}`,
  body: words ? `Words of post ${n}, with a fix.` : `Words of post ${n}.`, version: 2, created: day(n), updated: day(500) }));

for (const words of [true, false]) {
  test(`a tick made while the refresh is fetching that post's ${words ? 'edited' : 'maintenance'} version is not undone`, async () => {
    const r = await rig();
    await r.f.refresh();
    const key = await r.f.keyFor(A, idOf(2));
    edit(r, 2, { words });
    const held = await r.holdAt(2);
    assert.equal(await r.f.readMove(key, 'tick'), 'archived');
    const s = await held.release();
    assert.equal(s.raced, 1, 'the refresh saw that the record had changed, and wrote nothing for it');
    const rec = await r.f.itemByKey(key);
    assert.equal(rec.read, 'archived', 'still archived');
    assert.equal(rec.version, 1, 'the archive record is what the owner ticked');
    assert.ok(!(await r.feed()).some(h => h.key === key));
    assert.deepEqual(r.ledgerIds(), [idOf(2)], 'the ledger agrees with the record');
    assert.equal(r.bodies().length, 2, 'no body was written for it again');
    // the next refresh deals with the new version by the rules for an archived post
    const s2 = await r.f.refresh();
    assert.equal((await r.f.itemByKey(key)).version, 2, 'the version is recorded at the next refresh');
    if (!words) assert.equal((await r.f.itemByKey(key)).read, 'archived', 'a maintenance version moves nothing');
    assert.equal(s2.raced, 0);
    r.done();
  });
}

test('an untick made while the refresh is fetching that archived post\'s new version stands: back in the Feed with its text, its id out of the ledger', async () => {
  const r = await rig();
  await r.f.refresh();
  const key = await r.f.keyFor(A, idOf(2));
  await r.f.readMove(key, 'tick');
  edit(r, 2, { words: false });
  const held = await r.holdAt(2);
  const un = await r.f.untick(key); // its own request is not held: it completes first
  assert.equal(un, 'new');
  const s = await held.release();
  assert.equal(s.raced, 1);
  const rec = await r.f.itemByKey(key);
  assert.equal(rec.read, 'new');
  assert.match(await r.f.bodyHtml(key), /Words of post 2/);
  assert.deepEqual(r.ledgerIds(), []);
  r.done();
});

test('an open or a note made while the refresh fetches that post keeps its mark (a change made in place is carried into the new version)', async () => {
  for (const move of ['open', 'respond']) {
    const r = await rig();
    await r.f.refresh();
    const key = await r.f.keyFor(A, idOf(3));
    edit(r, 3, { words: false });
    const held = await r.holdAt(3);
    if (move === 'open') await r.f.open(key); else assert.equal(await r.f.markResponded(A, idOf(3)), true);
    const s = await held.release();
    assert.equal(s.raced, 0, 'the record is the same object: the refresh carries on');
    const rec = await r.f.itemByKey(key);
    assert.equal(rec.read, move === 'open' ? 'opened' : 'responded', move);
    assert.equal(rec.version, 2, 'and the maintenance version is recorded');
    r.done();
  }
});

test('two unticks of one post at once: the second is refused plainly, nothing is fetched into a record that changed', async () => {
  const r = await rig();
  await r.f.refresh();
  const key = await r.f.keyFor(A, idOf(1));
  await r.f.readMove(key, 'tick');
  const [a, b] = await Promise.allSettled([r.f.untick(key), r.f.untick(key)]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.match(b.reason.message, /changed meanwhile|not in the Archive/);
  assert.equal((await r.f.itemByKey(key)).read, 'new');
  r.done();
});

test('the inbox: an answer that arrives after the inbox was unset is not written into it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubrace-'));
  let settings = { inbox_api_url: 'https://inbox.web.test/api', inbox_token_file: '/nonexistent/token' };
  let release;
  const get = async u => { await new Promise(res => { release = res; }); return { status: 200, url: String(u), text: JSON.stringify({ mentions: [] }) }; };
  const f = F.createFollowing({ file: path.join(dir, 'f.json'), get, getSettings: () => CFG.followingSettingsOf(settings).settings, readToken: () => 'tok-123456789',
    timers: { set: () => ({}), clear: () => {} } });
  const run = f.refresh();
  while (!release) await new Promise(res => setImmediate(res));
  settings = {};
  await f.view(); // the page asks: the inbox is now unset
  release();
  await run;
  assert.equal(await f.inboxState(), 'off', 'the late answer did not move it');
  fs.rmSync(dir, { recursive: true, force: true });
});
