// hubarchive.test.mjs — the Hub's Archive and its unread target (following.mjs): ticking, unticking, the archive record,
// the ids that keep a post read, the backfill (order, fairness, budget), the caps, "caught up", migration from a document
// written before the Archive, and a hostile index.
//
//   node --test test/hubarchive.test.mjs
//
// No network: every fetch is a fake `get` over invented blygs held in memory (test/following-fake.mjs); every origin is
// example-style (.web.test).
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
const B = 'https://beta.web.test/';
const C = 'https://gamma.web.test/';
const day = n => `2026-10-${String(1 + Math.floor(n / 24)).padStart(2, '0')}T${String(n % 24).padStart(2, '0')}:00:00Z`;

function rig({ settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-archive-'));
  const web = makeWeb();
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const file = path.join(dir, 'following.json');
  const SETTINGS = () => CFG.followingSettingsOf(settings).settings;
  // every request takes 10 ms of the fake clock, so "the blyg backfilled longest ago" means something
  const get = async (u, o) => { clock.t += 10; return web.get(u, o); };
  const make = () => F.createFollowing({ file, get, now: () => clock.t, getSettings: SETTINGS, timers: { set: () => ({}), clear: () => {} } });
  const r = { f: make(), web, clock, dir, file, make, SETTINGS,
    json: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    // a blyg's ledger is a document of its own (following-ledgers/<digest of the origin>.json)
    ledgerFile: o => path.join(dir, 'following-ledgers', `${F.ledgerName(o)}.json`),
    ledger: o => { try { return JSON.parse(fs.readFileSync(r.ledgerFile(o), 'utf8')); } catch { return undefined; } },
    ledgerIds: o => (r.ledger(o) || { ids: [] }).ids.map(p => p[0]),
    setLedger: (o, fn) => { const l = r.ledger(o); fn(l); fs.writeFileSync(r.ledgerFile(o), JSON.stringify(l)); },
    bodyFiles: () => { try { return fs.readdirSync(path.join(dir, 'following-bodies')); } catch { return []; } },
    done: () => fs.rmSync(dir, { recursive: true, force: true }) };
  return r;
}
/** n posts on a blyg; post k is the k-th oldest (k = n is the newest). */
const publish = (site, origin, n, { from = 1, base = 0 } = {}) => {
  for (let k = from; k <= n; k++) site.put(makeDoc({ id: idOf(base + k), origin, title: `Post ${k}`, body: `Words of post ${k} on ${new URL(origin).host}.`, created: day(k) }));
};
const follow = (r, ...origins) => r.f.confirmImport(origins.map(origin => ({ origin, title: 'x' })));
const feed = r => r.f.view({ limit: 1000 }).entries.map(e => e.head);
const titles = r => feed(r).map(h => h.title);
const keyOf = (r, origin, n, base = 0) => r.f.keyFor(origin, idOf(base + n));
const archive = (r, extra = {}) => r.f.view({ view: 'archive', ...extra });

// ---- the state list and the moves -----------------------------------------------------------------------------------------

test('where a post is: one list, one field; the backfill modes are one list, one field, one function, and every mode has a way out', () => {
  assert.ok(F.READ_STATES.includes('archived'));
  assert.ok(!('archived' in { ...F.READ_STATES }), 'no separate flag');
  assert.deepEqual(F.BACKFILL_MODES, ['unknown', 'more', 'caught_up', 'paused_bad_documents']);
  const led = { backfill: 'unknown' };
  assert.equal(F.moveBackfill(led, 'remain'), 'more');
  assert.equal(F.moveBackfill(led, 'finish'), 'caught_up');
  assert.equal(F.moveBackfill(led, 'remain'), 'more');
  assert.equal(F.moveBackfill(led, 'pause_bad'), 'paused_bad_documents');
  for (const ev of ['remain', 'finish', 'pause_bad']) assert.throws(() => F.moveBackfill({ ...led }, ev), /cannot/, `paused is left only by retry, recover or forget: ${ev}`);
  assert.equal(F.moveBackfill({ ...led }, 'retry'), 'unknown');
  assert.equal(F.moveBackfill({ ...led }, 'recover'), 'more');
  assert.equal(F.moveBackfill({ ...led }, 'forget'), 'unknown');
  assert.throws(() => F.moveBackfill({ backfill: 'weird' }, 'finish'), /no such state/);
  assert.throws(() => F.moveBackfill(led, 'sleep'), /no such move/);
  assert.throws(() => F.moveBackfill({ backfill: 'stopped' }, 'remain'), /no such state/, 'there is no stopped mode any more');
  // the table is the whole truth: every (state, move) not named is refused
  for (const from of F.BACKFILL_MODES) for (const ev of Object.keys(F.BACKFILL_MOVES)) {
    const legal = Object.prototype.hasOwnProperty.call(F.BACKFILL_MOVES[ev], from);
    if (legal) F.moveBackfill({ backfill: from }, ev); else assert.throws(() => F.moveBackfill({ backfill: from }, ev), /cannot/);
  }
  // and every mode has a way out to one that reads
  for (const from of F.BACKFILL_MODES) assert.ok(Object.values(F.BACKFILL_MOVES).some(t => t[from] && t[from] !== from) || from === 'unknown', from);
});

// ---- ticking ---------------------------------------------------------------------------------------------------------------

test('tick: the post leaves the Feed, its text is deleted, a small record stays; the unread count and the Archive follow', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  publish(site, A, 6);
  follow(r, A);
  await r.f.refresh();
  assert.equal(feed(r).length, 6);
  assert.equal(r.bodyFiles().length, 6);
  const key = keyOf(r, A, 3);
  assert.equal(r.f.readMove(key, 'tick'), 'archived');
  assert.equal(feed(r).length, 5);
  assert.ok(!titles(r).includes('Post 3'));
  assert.equal(r.f.view().tabs.feed, 5);
  assert.equal(r.f.view().tabs.archive, 1);
  assert.equal(r.bodyFiles().length, 5, 'the body file is deleted when ticked');
  assert.equal(r.f.bodyHtml(key), '', 'and nothing reads it back');
  // the record: exactly these fields, small, no text
  const rec = r.json().items[`${A}\n${idOf(3)}`];
  assert.deepEqual(Object.keys(rec).sort(), ['archived_at', 'content_hash', 'created', 'fetched_at', 'fp', 'id', 'index_version', 'key', 'kind', 'origin',
    'page', 'read', 'text', 'text_chars', 'title', 'updated', 'version']);
  assert.ok(JSON.stringify(rec.fp).length <= 60, 'a fingerprint of the words read, about 30 bytes');
  assert.equal(rec.read, 'archived');
  assert.equal(rec.text, '');
  assert.equal(rec.title, 'Post 3');
  assert.ok(JSON.stringify(rec).length < 700, `a record is about half a kilobyte (${JSON.stringify(rec).length} bytes)`);
  assert.ok(!JSON.stringify(rec).includes('Words of post'), 'none of the post\'s words is kept');
  assert.deepEqual(r.ledgerIds(A), [idOf(3)], 'its id is remembered in its blyg\'s ledger');
  // ticking twice is refused, and the engine says so
  assert.throws(() => r.f.readMove(key, 'tick'), /cannot tick while archived/);
  r.done();
});

test('a record keeps at most 120 characters of title; a post with no heading keeps its first words', async () => {
  const r = rig();
  const site = r.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'T'.repeat(400), body: 'x', created: day(1) }));
  site.put(makeDoc({ id: idOf(2), origin: A, title: '', body: 'first words of a fragment with no heading '.repeat(10), created: day(2) }));
  follow(r, A);
  await r.f.refresh();
  r.f.tickMany([keyOf(r, A, 1), keyOf(r, A, 2)]);
  const lines = archive(r).archive;
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.title.length <= F.LIMITS.archiveTitleChars);
  assert.ok(lines.find(l => /^first words of a fragment/.test(l.title)));
  r.done();
});

test('the Archive lists the newest ticked first, in pages; a line is light (no text); the search filters by title and blyg', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  publish(site, A, 8);
  follow(r, A);
  await r.f.refresh();
  for (const n of [2, 7, 4]) { r.clock.t += 1000; r.f.readMove(keyOf(r, A, n), 'tick'); }
  let a = archive(r);
  assert.deepEqual(a.archive.map(l => l.title), ['Post 4', 'Post 7', 'Post 2'], 'newest ticked first');
  assert.equal(a.archive_total, 3);
  assert.deepEqual(Object.keys(a.archive[0]).sort(), ['archived_at', 'blyg_label', 'blyg_title', 'created', 'key', 'kind', 'newer_version', 'opens_on', 'origin', 'page', 'read', 'title', 'updated', 'version']);
  assert.deepEqual(a.entries, [], 'the Feed list is not carried on the Archive tab');
  assert.equal(archive(r, { limit: 2 }).archive.length, 2);
  assert.equal(archive(r, { limit: 2 }).archive_total, 3);
  assert.deepEqual(archive(r, { q: 'post 7' }).archive.map(l => l.title), ['Post 7']);
  assert.deepEqual(archive(r, { q: 'alpha notes' }).archive.length, 3, 'by blyg');
  assert.deepEqual(archive(r, { q: 'nothing like this' }).archive, []);
  assert.ok(!JSON.stringify(a).includes('Words of post'), 'no body text on the tab');
  // the Archive never holds the Feed's other views' posts
  assert.equal(r.f.view({ view: 'background' }).background.length, 0);
  r.done();
});

test('opening the original, or reading a post here, never archives it; only the owner\'s tick does', async () => {
  const r = rig();
  const site = r.web.add(A);
  publish(site, A, 3);
  follow(r, A);
  await r.f.refresh();
  const key = keyOf(r, A, 2);
  r.f.open(key);
  assert.equal(r.f.itemByKey(key).read, 'opened');
  r.f.openedHere(key);
  r.f.markResponded(A, idOf(2));
  assert.equal(r.f.itemByKey(key).read, 'responded');
  assert.equal(feed(r).length, 3, 'still in the Feed');
  // and once archived, opening the original moves nothing
  r.f.readMove(key, 'tick');
  const out = r.f.open(key);
  assert.equal(out.url, r.f.itemByKey(key).page, 'the original opens');
  assert.equal(r.f.itemByKey(key).read, 'archived');
  assert.equal(r.f.markResponded(A, idOf(2)), false, 'a note exported for an archived post does not move it');
  assert.equal(r.f.itemByKey(key).read, 'archived');
  r.done();
});

test('tick all shown: exactly the keys named are archived; a key that is withdrawn, archived or unknown is skipped', async () => {
  const r = rig();
  const site = r.web.add(A);
  publish(site, A, 5);
  follow(r, A);
  await r.f.refresh();
  const keys = [1, 2, 3].map(n => keyOf(r, A, n));
  r.f.readMove(keys[0], 'tick');
  assert.equal(r.f.tickMany([...keys, 'nope', 42, null]), 2);
  assert.deepEqual(titles(r).sort(), ['Post 4', 'Post 5']);
  assert.equal(r.f.tickMany([]), 0);
  assert.equal(r.f.tickMany('not a list'), 0);
  r.done();
});

// ---- unticking ---------------------------------------------------------------------------------------------------------------

test('untick: the post is fetched again and goes back to the Feed as new; its id leaves the ledger; if it cannot be fetched it stays archived', async () => {
  const r = rig();
  const site = r.web.add(A);
  publish(site, A, 3);
  follow(r, A);
  await r.f.refresh();
  const key = keyOf(r, A, 2);
  r.f.readMove(key, 'tick');
  assert.equal(r.bodyFiles().length, 2);
  // not reachable: it stays archived, with the reason
  site.down = 'connection reset';
  await assert.rejects(() => r.f.untick(key), /could not fetch the post/);
  assert.equal(r.f.itemByKey(key).read, 'archived');
  assert.deepEqual(r.ledgerIds(A), [idOf(2)]);
  site.down = null;
  const before = r.web.itemRequests().length;
  assert.equal(await r.f.untick(key), 'new');
  assert.equal(r.web.itemRequests().length, before + 1, 'one request');
  assert.equal(r.f.itemByKey(key).read, 'new');
  assert.equal(r.f.itemByKey(key).key, key, 'the same key');
  assert.deepEqual(r.ledgerIds(A), []);
  assert.equal(r.bodyFiles().length, 3, 'its text is back');
  assert.match(r.f.bodyHtml(key), /Words of post 2/);
  assert.equal(feed(r).length, 3);
  await assert.rejects(() => r.f.untick(key), /not in the Archive/);
  await assert.rejects(() => r.f.untick('nope'), /no such post/);
  r.done();
});

test('untick refuses when the post was withdrawn meanwhile, or when fetching is off; and the checks are the same as any document\'s', async () => {
  const r = rig();
  const site = r.web.add(A);
  publish(site, A, 3);
  follow(r, A);
  await r.f.refresh();
  const key = keyOf(r, A, 1), key3 = keyOf(r, A, 3);
  r.f.tickMany([key, key3]);
  site.put(makeDoc({ id: idOf(1), origin: A, kind: 'withdrawn', title: '', version: 2, created: day(1), updated: day(40) }));
  await assert.rejects(() => r.f.untick(key), /withdrawn/);
  assert.equal(r.f.itemByKey(key).read, 'archived');
  // a document that names another id is not accepted
  site.put(makeDoc({ id: idOf(77), origin: A, title: 'Liar', created: day(3) }));
  site.docs.set(idOf(3), { ...site.docs.get(idOf(77)) });
  await assert.rejects(() => r.f.untick(key3), /stays in the Archive/);
  assert.equal(r.f.itemByKey(key3).read, 'archived');
  let on = true;
  const off = F.createFollowing({ file: r.file, get: r.web.get, now: () => r.clock.t, getSettings: r.SETTINGS, mayFetch: () => on, timers: { set: () => ({}), clear: () => {} } });
  on = false;
  await assert.rejects(() => off.untick(key3), /fetching is off/);
  r.done();
});

// ---- editing an archived post --------------------------------------------------------------------------------------------------

test('an edit to an archived post: the same words stay archived (version recorded); changed words bring it back as edited, at most once a week', async () => {
  const r = rig();
  const site = r.web.add(A);
  publish(site, A, 4);
  follow(r, A);
  await r.f.refresh();
  r.f.tickMany([keyOf(r, A, 2), keyOf(r, A, 3)]);
  // post 2: version 2 with the SAME words (maintenance); post 3: version 2 with new words
  site.put(makeDoc({ id: idOf(2), origin: A, title: 'Post 2', body: 'Words of post 2 on alpha.web.test.', version: 2, created: day(2), updated: day(60) }));
  site.put(makeDoc({ id: idOf(3), origin: A, title: 'Post 3', body: 'Entirely different words now, rewritten.', version: 2, created: day(3), updated: day(61) }));
  const s = await r.f.refresh();
  assert.equal(r.f.itemByKey(keyOf(r, A, 2)).read, 'archived', 'a maintenance version stays archived');
  assert.equal(r.f.itemByKey(keyOf(r, A, 2)).version, 2, 'and its record knows the version');
  assert.equal(r.f.itemByKey(keyOf(r, A, 3)).read, 'edited', 'changed words: back in the Feed, as edited');
  assert.equal(s.edited, 1);
  const h = feed(r).find(x => x.title === 'Post 3');
  assert.equal(h.version, 2);
  assert.equal(h.read_version, 1, 'it remembers which version was read');
  assert.ok(!('edited_after_read' in h), 'no marker beside the read state');
  assert.match(r.f.bodyHtml(h.key), /Entirely different/);
  assert.deepEqual(r.ledgerIds(A).sort(), [idOf(2), idOf(3)].sort(), 'its id stays in the ledger: it was read');
  assert.equal(r.f.readMove(h.key, 'open'), 'edited', 'opening an edited post leaves it edited');
  // a further real edit within the week: it does NOT come back; it is held in the Archive as "edited again"
  r.f.readMove(h.key, 'tick');
  site.put(makeDoc({ id: idOf(3), origin: A, title: 'Post 3', body: 'Entirely different words now, rewritten!', version: 3, created: day(3), updated: day(70) }));
  const s2 = await r.f.refresh();
  assert.equal(s2.held, 1);
  let rec = r.f.itemByKey(h.key);
  assert.equal(rec.read, 'archived_changed');
  assert.equal(rec.version, 2, 'the record is still the version read');
  assert.deepEqual([rec.newer.version, typeof rec.newer.hash], [3, 'string'], 'the newer version is recorded');
  assert.equal(archive(r).archive[0].read, 'archived_changed');
  // within its window it is not fetched again, even for a further version: only what the index said is updated
  site.put(makeDoc({ id: idOf(3), origin: A, title: 'Post 3', body: 'Yet more words.', version: 4, created: day(3), updated: day(71) }));
  let n = r.web.itemRequests().length;
  await r.f.refresh();
  assert.equal(r.web.itemRequests().length, n, 'not fetched within its window');
  assert.equal(r.f.itemByKey(h.key).index_version, 4);
  // once the week has passed, a refresh releases it to the Feed (fetched once, with the newest words)
  r.clock.t += F.LIMITS.editReturnGapMs;
  const s3 = await r.f.refresh();
  assert.equal(s3.released, 1);
  rec = r.f.itemByKey(h.key);
  assert.deepEqual([rec.read, rec.version], ['edited', 4]);
  assert.match(r.f.bodyHtml(h.key), /Yet more words/);
  // an archived post that the index now lists as withdrawn stays in the Archive, and is not fetched
  r.f.readMove(h.key, 'tick');
  site.put(makeDoc({ id: idOf(3), origin: A, kind: 'withdrawn', title: '', version: 5, created: day(3), updated: day(80) }));
  n = r.web.itemRequests().length;
  await r.f.refresh();
  assert.equal(r.web.itemRequests().length, n);
  assert.equal(r.f.itemByKey(h.key).read, 'archived');
  r.done();
});

test('"edited again" in the Archive: Mark read keeps it read at the newer wording; untick brings the newest back; a revert to the read wording ends it', async () => {
  const r = rig();
  const site = r.web.add(A);
  publish(site, A, 3);
  follow(r, A);
  await r.f.refresh();
  const k1 = keyOf(r, A, 1), k2 = keyOf(r, A, 2), k3 = keyOf(r, A, 3);
  r.f.tickMany([k1, k2, k3]);
  // all three edited; each first comes back, then is ticked and edited again within the week: held
  for (const n of [1, 2, 3]) site.put(makeDoc({ id: idOf(n), origin: A, title: `Post ${n}`, body: `Second words ${n}.`, version: 2, created: day(n), updated: day(100) }));
  await r.f.refresh();
  r.f.tickMany([k1, k2, k3]);
  for (const n of [1, 2, 3]) site.put(makeDoc({ id: idOf(n), origin: A, title: `Post ${n}`, body: `Third words ${n}.`, version: 3, created: day(n), updated: day(101) }));
  await r.f.refresh();
  assert.deepEqual([k1, k2, k3].map(k => r.f.itemByKey(k).read), ['archived_changed', 'archived_changed', 'archived_changed']);
  // Mark read (the tick, from the Archive line): read at version 3, so the same version later is not an edit
  assert.equal((await r.f.readRequest({ key: k1, move: 'tick' })).read, 'archived');
  assert.equal(r.f.itemByKey(k1).version, 3);
  // untick: fetched again, the newest words, in the Feed as new
  assert.equal(await r.f.untick(k2), 'new');
  assert.match(r.f.bodyHtml(k2), /Third words 2/);
  // opening the original from the line moves nothing
  r.f.open(k3);
  assert.equal(r.f.itemByKey(k3).read, 'archived_changed');
  // the blyg goes back to the wording that was read (version 4, same hash as version 2): nothing newer remains
  site.put(makeDoc({ id: idOf(3), origin: A, title: 'Post 3', body: 'Second words 3.', version: 4, created: day(3), updated: day(102) }));
  r.clock.t += F.LIMITS.editReturnGapMs;
  await r.f.refresh();
  assert.deepEqual([r.f.itemByKey(k3).read, r.f.itemByKey(k3).version], ['archived', 4]);
  assert.ok(!('newer' in r.f.itemByKey(k3)));
  r.done();
});

test('the edit storm: 400 read posts all changed: per refresh at most 5 fetched and 3 returned, at most 3 in the Feed at once, a mass edit is one Archive notice', async () => {
  const r = rig({ settings: { following_unread_target: 50 } });
  const site = r.web.add(A);
  const at = n => new Date(Date.parse('2026-06-01T00:00:00Z') + n * 3600e3).toISOString();
  for (let k = 1; k <= 400; k++) site.put(makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: `Words of post ${k}.`, created: at(k) }));
  follow(r, A);
  for (let round = 0; round < 12; round++) { await r.f.refresh(); r.f.tickMany(feed(r).map(h => h.key)); }
  assert.equal(archive(r).archive_total, 400);
  assert.equal(feed(r).length, 0);
  for (let k = 1; k <= 400; k++) site.put(makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: `Words of post ${k}!`, created: at(k), updated: at(5000), version: 2 }));
  for (let dayN = 0; dayN < 3; dayN++) {
    let returned = 0;
    for (let run = 0; run < 24; run++) { // a day of refreshes, one an hour; the owner ticks what came back every six hours
      const n0 = r.web.itemRequests().length;
      const s = await r.f.refresh();
      assert.ok(r.web.itemRequests().length - n0 <= F.LIMITS.archivedDocsPerRun);
      assert.ok(s.edited <= F.LIMITS.editReturnsPerRun);
      assert.ok(feed(r).length <= F.LIMITS.editedPerBlyg, `at most ${F.LIMITS.editedPerBlyg} in the Feed at once (${feed(r).length})`);
      returned += s.edited;
      if (run % 6 === 5) r.f.tickMany(feed(r).map(h => h.key));
      r.clock.t += 3600e3 - 1000;
    }
    assert.ok(returned <= F.LIMITS.editReturnsPerDay, `day ${dayN}: ${returned} returned`);
    if (dayN === 0) assert.ok(returned <= F.LIMITS.massEditPerDay, `the first day of a mass edit: ${returned} returned before it was seen as one`);
  }
  const v = archive(r, { limit: 1000 });
  assert.equal(v.archive_notices.length, 1, 'ONE notice for the blyg');
  assert.ok(v.archive_notices[0].held > F.LIMITS.massEditPerDay);
  r.done();
});

test('a one-character change to a long post you read keeps it read (judged by its fingerprint); a real rewrite still comes back', async () => {
  const r = rig();
  const site = r.web.add(A);
  const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'Long', body: words, created: day(1) }));
  site.put(makeDoc({ id: idOf(2), origin: A, title: 'Short', body: 'Six words in this short post.', created: day(2) }));
  follow(r, A);
  await r.f.refresh();
  r.f.tickMany([keyOf(r, A, 1), keyOf(r, A, 2)]);
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'Long', body: words.replace('word150', 'word15O'), version: 2, created: day(1), updated: day(9) }));
  site.put(makeDoc({ id: idOf(2), origin: A, title: 'Short', body: 'Six words in this short post!', version: 2, created: day(2), updated: day(9) }));
  const s = await r.f.refresh();
  assert.deepEqual([r.f.itemByKey(keyOf(r, A, 1)).read, r.f.itemByKey(keyOf(r, A, 1)).version], ['archived', 2], 'a typo: recorded, still read, no "edited again"');
  assert.equal(r.f.itemByKey(keyOf(r, A, 2)).read, 'edited', 'in a six-word post one word is not "barely": it comes back');
  assert.equal(s.minor, 1);
  // a rewrite of the long one comes back
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'Long', body: words.split(' ').map((w, i) => (i % 5 ? w : 'new')).join(' '), version: 3, created: day(1), updated: day(10) }));
  await r.f.refresh();
  assert.equal(r.f.itemByKey(keyOf(r, A, 1)).read, 'edited');
  // a record ticked before fingerprints (none kept): any edit counts, as before
  r.f.readMove(keyOf(r, A, 1), 'tick');
  const j = r.json(); delete j.items[`${A}\n${idOf(1)}`].fp; fs.writeFileSync(r.file, JSON.stringify(j));
  const f2 = r.make();
  r.clock.t += F.LIMITS.editReturnGapMs;
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'Long', body: words.split(' ').map((w, i) => (i % 5 ? w : 'new')).join(' ').replace('word151', 'word15l'), version: 4, created: day(1), updated: day(11) }));
  await f2.refresh();
  assert.equal(f2.itemByKey(keyOf(r, A, 1)).read, 'edited');
  r.done();
});

test('an edit-return counts against the per-blyg unread cap: at the cap the post is held, not returned', async () => {
  const r = rig({ settings: { following_unread_target: 500, following_max_items_per_blyg: 10 } });
  const site = r.web.add(A);
  publish(site, A, 12);
  follow(r, A);
  await r.f.refresh();
  assert.equal(feed(r).length, 10);
  r.f.readMove(keyOf(r, A, 12), 'tick');
  await r.f.refresh(); // the eleventh comes in: at the cap again
  assert.equal(feed(r).length, 10);
  site.put(makeDoc({ id: idOf(12), origin: A, title: 'Post 12', body: 'New words.', version: 2, created: day(12), updated: day(200) }));
  const s = await r.f.refresh();
  assert.equal(s.edited, 0);
  assert.equal(feed(r).length, 10);
  r.done();
});

test('a post known only by id (its record trimmed past 2,000) is never fetched again: an edit of it leaves it read', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  publish(site, A, 3);
  follow(r, A);
  await r.f.refresh();
  r.f.readMove(keyOf(r, A, 2), 'tick');
  const j = r.json();
  delete j.items[`${A}\n${idOf(2)}`]; // as trimArchive drops the oldest-ticked past archiveRecords
  fs.writeFileSync(r.file, JSON.stringify(j));
  const f2 = r.make();
  site.put(makeDoc({ id: idOf(2), origin: A, title: 'Post 2', body: 'Rewritten entirely.', version: 2, created: day(2), updated: day(300) }));
  r.web.requests.length = 0;
  const s = await f2.refresh();
  assert.equal(r.web.itemRequests().length, 0, 'its document is not asked for');
  assert.equal(s.edited, 0);
  assert.ok(!f2.view().entries.some(e => e.head.id === idOf(2)));
  r.done();
});

test('trimArchive: at most 2,000 records, the oldest ticked dropped first; their ids stay in the ledgers', async () => {
  const r = rig({ settings: { following_unread_target: 500, following_max_items_per_blyg: 2000, following_run_requests: 2000, following_run_seconds: 600 } });
  const site = r.web.add(A);
  const at = n => new Date(Date.parse('2026-06-01T00:00:00Z') + n * 3600e3).toISOString();
  for (let k = 1; k <= 2005; k++) site.put(makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: 'w', created: at(k) }));
  follow(r, A);
  // read in the order the backfill brings them (newest first), ticking everything shown each time
  for (let i = 0; i < 50 && r.ledgerIds(A).length < 2005; i++) {
    await r.f.refresh();
    const keys = feed(r).map(h => h.key);
    for (let j = 0; j < keys.length; j += 100) { r.f.tickMany(keys.slice(j, j + 100)); r.clock.t += 1000; }
  }
  assert.equal(feed(r).length, 0);
  assert.equal(archive(r).archive_total, F.LIMITS.archiveRecords);
  assert.equal(F.LIMITS.archiveRecords, 2000);
  assert.equal(r.ledgerIds(A).length, 2005, 'every id is remembered');
  assert.equal(r.f.keyFor(A, idOf(2005)), '', 'the first ticked (the newest post) was dropped from the list');
  r.done();
});

test('an unread post edited in the Feed is handled as before (resurface from opened); an archived post is never edited in place by a lower version', async () => {
  const r = rig();
  const site = r.web.add(A);
  publish(site, A, 2);
  follow(r, A);
  await r.f.refresh();
  r.f.readMove(keyOf(r, A, 1), 'tick');
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'Post 1', body: 'older', version: 1, created: day(1), updated: day(90) }));
  await r.f.refresh();
  assert.equal(r.f.itemByKey(keyOf(r, A, 1)).read, 'archived');
  r.done();
});

// ---- the backfill ------------------------------------------------------------------------------------------------------------

test('backfill order: the newest unfetched first, so a blyg is read backwards in time; ticks make room for the next older ones', async () => {
  const r = rig({ settings: { following_unread_target: 5 } });
  const site = r.web.add(A);
  publish(site, A, 30);
  follow(r, A);
  let s = await r.f.refresh();
  assert.equal(s.backfilled, 5);
  assert.deepEqual(titles(r), ['Post 30', 'Post 29', 'Post 28', 'Post 27', 'Post 26']);
  assert.equal(r.ledger(A).backfill, 'more');
  // nothing to do while the Feed holds the target: only manifest and index are asked
  r.web.requests.length = 0;
  s = await r.f.refresh();
  assert.equal(r.web.itemRequests().length, 0);
  // tick the two newest, then the next two older ones come
  r.f.tickMany([keyOf(r, A, 30), keyOf(r, A, 29)]);
  r.web.requests.length = 0;
  s = await r.f.refresh();
  assert.deepEqual(r.web.itemRequests().map(u => idOf(0) && u.split('/').pop()), [`${idOf(25)}.json`, `${idOf(24)}.json`]);
  assert.deepEqual(titles(r), ['Post 28', 'Post 27', 'Post 26', 'Post 25', 'Post 24']);
  // a post published since is FRESH: fetched at once, though the Feed is full, and it goes to the top
  site.put(makeDoc({ id: idOf(31), origin: A, title: 'Post 31', body: 'brand new', created: day(31) }));
  r.web.requests.length = 0;
  s = await r.f.refresh();
  assert.deepEqual(r.web.itemRequests().map(u => u.split('/').pop()), [`${idOf(31)}.json`]);
  assert.equal(titles(r)[0], 'Post 31');
  assert.equal(feed(r).length, 6, 'fresh posts are not held back by the target');
  r.done();
});

test('backfill fairness: round-robin, one per blyg per round; the blyg backfilled longest ago starts, so the odd post alternates', async () => {
  const r = rig({ settings: { following_unread_target: 3 } });
  for (const [o, base] of [[A, 0], [B, 100]]) { const s = r.web.add(o); publish(s, o, 20, { base }); }
  follow(r, A, B);
  await r.f.refresh();
  const heldOf = o => feed(r).filter(h => h.origin === o).length;
  const first = [heldOf(A), heldOf(B)];
  assert.deepEqual(first.slice().sort(), [1, 2], 'three posts over two blyg: 2 and 1');
  const richer = first[0] === 2 ? A : B, poorer = richer === A ? B : A;
  // empty the Feed; the one that had the extra post goes second this time
  r.f.tickMany(feed(r).map(h => h.key));
  await r.f.refresh();
  assert.equal(heldOf(poorer), 2, 'the other one starts and gets the odd post');
  assert.equal(heldOf(richer), 1);
  r.done();
});

test('backfill with 3 blygs, target 50, a budget of 60 requests: manifest and index per blyg (6), then 50 documents, shared 17/17/16; nothing is an error', async () => {
  const r = rig({ settings: { following_unread_target: 50, following_run_requests: 60 } });
  for (const [o, base] of [[A, 0], [B, 1000], [C, 2000]]) { const s = r.web.add(o); publish(s, o, 100, { base }); }
  follow(r, A, B, C);
  const s = await r.f.refresh();
  assert.equal(s.requests, 56, '3 × 2 + 50');
  assert.equal(r.web.itemRequests().length, 50);
  assert.equal(feed(r).length, 50, 'the target is met exactly');
  assert.deepEqual([A, B, C].map(o => feed(r).filter(h => h.origin === o).length).sort(), [16, 17, 17]);
  assert.equal(s.errors, 0);
  assert.equal(s.deferred, 0, 'stopped because the target was met, not because anything was cut');
  assert.ok(r.f.listBlygs().every(b => b.state === 'active' && b.failures === 0));
  assert.ok(r.f.listBlygs().every(b => b.backfill === 'more'));
  r.done();
});

test('the same, with a budget of 30 requests: 6 for manifests and indexes, 24 documents; the rest is deferred, with no error and no mark against any blyg', async () => {
  const r = rig({ settings: { following_unread_target: 50, following_run_requests: 30 } });
  for (const [o, base] of [[A, 0], [B, 1000], [C, 2000]]) { const s = r.web.add(o); publish(s, o, 100, { base }); }
  follow(r, A, B, C);
  let s = await r.f.refresh();
  assert.equal(s.requests, 30);
  assert.equal(feed(r).length, 24);
  assert.equal(s.errors, 0);
  assert.ok(s.deferred > 0, 'what is left is counted as deferred');
  assert.ok(r.f.listBlygs().every(b => b.state === 'active' && b.failures === 0 && !b.last_error));
  s = await r.f.refresh();
  assert.equal(feed(r).length, 48, 'the next refresh carries on');
  s = await r.f.refresh();
  assert.equal(feed(r).length, 50, 'and stops exactly at the target');
  r.done();
});

test('many blygs: with 40 followed and a target of 50, every one is asked first and gets its turn; the run stays inside its budget', async () => {
  const r = rig({ settings: { following_unread_target: 50, following_run_requests: 200 } });
  const origins = Array.from({ length: 40 }, (_, i) => `https://b${i}.web.test/`);
  origins.forEach((o, i) => publish(r.web.add(o), o, 10, { base: i * 100 }));
  follow(r, ...origins);
  const s = await r.f.refresh();
  assert.equal(feed(r).length, 50);
  assert.equal(s.requests, 80 + 50);
  const per = origins.map(o => feed(r).filter(h => h.origin === o).length);
  assert.ok(Math.max(...per) <= 2 && Math.min(...per) >= 1, `spread over the blygs: ${per.join(',')}`);
  assert.equal(s.errors, 0);
  r.done();
});

test('one huge blyg (a 100,000-entry index): the Hub reads at most 20,000 entries of it, fetches within its budget, and stores almost nothing of the index', async () => {
  const r = rig({ settings: { following_unread_target: 50, following_run_requests: 200 } });
  const site = r.web.add(A);
  const small = r.web.add(B);
  publish(small, B, 10, { base: 500000 });
  // an index of 100,000 entries: the fake serves it without 100,000 documents behind it
  const realGet = r.web.get;
  r.web.get = async (url, o) => {
    if (String(url) === `${A}items/index.json`) {
      const items = Array.from({ length: 100000 }, (_, i) => ({ id: idOf(i + 1), kind: 'fragment', created: day(i % 700), updated: day(i % 700), version: 1 }));
      return { status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify({ items }) };
    }
    const m = /\/items\/([^/]+)\.json$/.exec(String(url));
    if (String(url).startsWith(A) && m) return { status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify(makeDoc({ id: m[1], origin: A, title: `Doc ${m[1]}`, created: day(1) })) };
    return realGet(url, o);
  };
  void site;
  follow(r, A, B);
  const s = await r.f.refresh();
  assert.ok(s.requests <= 200, `requests ${s.requests} within the 200 allowed`);
  assert.equal(feed(r).length, 50);
  assert.ok(feed(r).filter(h => h.origin === B).length >= 10, 'the small blyg is not starved: all of its ten are there');
  assert.ok(fs.statSync(r.file).size < 300 * 1024, `state stays small (${fs.statSync(r.file).size} bytes)`);
  assert.deepEqual(Object.keys(r.json()).sort(), ['blygs', 'inbox', 'items', 'kept', 'last_run'], 'the ledgers are documents of their own');
  assert.ok(fs.statSync(r.ledgerFile(A)).size < 64 * 1024, 'and the big blyg\'s ledger is small too');
  r.done();
});

test('an index that changes on every fetch cannot make a run exceed its budget or the holding caps, and cannot grow what is stored', async () => {
  const r = rig({ settings: { following_unread_target: 500, following_run_requests: 40, following_max_items_per_blyg: 12, following_max_items_total: 50 } });
  r.web.add(A);
  let calls = 0;
  const realGet = r.web.get;
  r.web.get = async (url, o) => {
    if (String(url) === `${A}items/index.json`) {
      calls++;
      const items = Array.from({ length: 5000 }, (_, i) => ({ id: idOf(calls * 100000 + i + 1), kind: 'fragment', created: day(i % 500), updated: day(i % 500), version: 1 }));
      return { status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify({ items }) };
    }
    const m = /\/items\/([^/]+)\.json$/.exec(String(url));
    if (String(url).startsWith(A) && m) return { status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify(makeDoc({ id: m[1], origin: A, title: 'x', created: day(1) })) };
    return realGet(url, o);
  };
  follow(r, A);
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    const s = await r.f.refresh();
    assert.ok(s.requests <= 40);
    assert.ok(feed(r).length <= 12, 'per-blyg cap of unread held posts');
    sizes.push(fs.statSync(r.file).size);
  }
  assert.ok(Math.max(...sizes) < sizes[0] * 1.5 + 2000, `the stored state does not grow with the index: ${sizes.join(' ')}`);
  assert.deepEqual(r.ledgerIds(A), []);
  assert.ok(feed(r).length <= 12);
  r.done();
});

test('a target of 0, or out of bounds, or not a number is refused (the default stays); the bounds are 1 to 500', () => {
  assert.equal(CFG.FOLLOWING_NUMBERS.following_unread_target.dflt, 50);
  for (const bad of [0, -1, 501, 1.5, '50', NaN, null === 0]) {
    const { settings, refused } = CFG.followingSettingsOf({ following_unread_target: bad });
    assert.equal(settings.following_unread_target, 50, `${bad}`);
    assert.ok(refused.includes('following_unread_target'), `${bad}`);
  }
  for (const ok of [1, 50, 500]) assert.equal(CFG.followingSettingsOf({ following_unread_target: ok }).settings.following_unread_target, ok);
});

// ---- the caps count unread posts only ------------------------------------------------------------------------------------------

test('the holding caps count UNREAD posts only: archived records do not count, so ticking makes room', async () => {
  const r = rig({ settings: { following_unread_target: 500, following_max_items_per_blyg: 10, following_max_items_total: 50 } });
  const site = r.web.add(A);
  publish(site, A, 40);
  follow(r, A);
  let s = await r.f.refresh();
  assert.equal(feed(r).length, 10, 'the per-blyg cap');
  assert.equal(s.capped, 30, 'the rest waits, counted as capped');
  r.f.tickMany(feed(r).slice(0, 4).map(h => h.key));
  assert.equal(r.f.listBlygs()[0].items, 6, 'unread held');
  assert.equal(r.f.listBlygs()[0].archived, 4);
  s = await r.f.refresh();
  assert.equal(feed(r).length, 10, 'four archived posts took no room: four more were read back');
  assert.deepEqual(titles(r).slice(-4), ['Post 30', 'Post 29', 'Post 28', 'Post 27'], 'the next older ones, newest first');
  // the total cap, across blygs
  const t = rig({ settings: { following_unread_target: 500, following_max_items_per_blyg: 100, following_max_items_total: 50 } });
  for (const [o, base] of [[A, 0], [B, 1000]]) publish(t.web.add(o), o, 40, { base });
  follow(t, A, B);
  s = await t.f.refresh();
  assert.equal(feed(t).length, 50);
  t.f.tickMany(feed(t).slice(0, 5).map(h => h.key));
  await t.f.refresh();
  assert.equal(feed(t).length, 50);
  assert.equal(t.json().items && Object.values(t.json().items).filter(i => i.read === 'archived').length, 5);
  t.done(); r.done();
});

// ---- ids are never resurrected -----------------------------------------------------------------------------------------------

test('a ticked post never comes back as unread: not when its record is gone from the file, not when the index lists it twice or reorders', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  publish(site, A, 6);
  follow(r, A);
  await r.f.refresh();
  const key = keyOf(r, A, 4);
  r.f.readMove(key, 'tick');
  // the record is dropped (as the oldest-ticked are, past the cap)
  const doc = r.json();
  delete doc.items[`${A}\n${idOf(4)}`];
  fs.writeFileSync(r.file, JSON.stringify(doc));
  const f2 = r.make();
  r.web.requests.length = 0;
  await f2.refresh();
  assert.ok(!r.web.itemRequests().some(u => u.endsWith(`${idOf(4)}.json`)), 'its document is not fetched');
  assert.ok(!f2.view().entries.some(e => e.head.id === idOf(4)));
  // an index that lists it twice, at two versions, is still one read post
  const real = r.web.get;
  r.web.get = async (url, o) => {
    const got = await real(url, o);
    if (String(url) === `${A}items/index.json`) {
      const j = JSON.parse(got.text);
      j.items.unshift({ ...j.items.find(i => i.id === idOf(4)), version: 1 }, { ...j.items.find(i => i.id === idOf(4)), version: 1 });
      return { ...got, text: JSON.stringify(j) };
    }
    return got;
  };
  r.web.requests.length = 0;
  await f2.refresh();
  assert.ok(!r.web.itemRequests().some(u => u.endsWith(`${idOf(4)}.json`)));
  assert.ok(!f2.view().entries.some(e => e.head.id === idOf(4)));
  r.done();
});

test('at its bound a ledger drops its oldest ids and raises its floor: nothing created at or before the floor is fetched as unread; the blyg is never stopped', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  const other = r.web.add(B);
  publish(site, A, 12);
  publish(other, B, 5, { base: 9000 });
  follow(r, A, B);
  await r.f.refresh();
  // the blyg already remembers as many ids as it may (invented ids, not in its index, all created before post 1)
  const old = Date.parse(day(0)) - 1000;
  r.setLedger(A, l => { l.ids = Array.from({ length: F.LIMITS.archiveIdsPerBlyg }, (_, i) => [idOf(7000000 + i), old - i]); });
  const f2 = r.make();
  f2.readMove(f2.keyFor(A, idOf(5)), 'tick');
  const led = r.ledger(A);
  assert.equal(led.ids.length, F.LIMITS.archiveIdsPerBlyg + 1 - F.LIMITS.ledgerTrim, 'the oldest were dropped');
  assert.ok(led.ids.some(p => p[0] === idOf(5)), 'the new one is remembered');
  assert.equal(led.floor, old - (F.LIMITS.archiveIdsPerBlyg - F.LIMITS.ledgerTrim), 'the floor is the newest date among those dropped');
  assert.notEqual(f2.listBlygs().find(b => b.origin === A).backfill, 'stopped');
  // the floor counts as read: entries created at or before it are never fetched; a brand-new post still is
  r.setLedger(A, l => { l.floor = Date.parse(day(6)); });
  const j = r.json();
  for (const k of Object.keys(j.items)) if (k.startsWith(A)) delete j.items[k]; // and nothing of it is held any more
  fs.writeFileSync(r.file, JSON.stringify(j));
  site.put(makeDoc({ id: idOf(50), origin: A, title: 'Brand new', created: day(400) }));
  const f3 = r.make();
  r.web.requests.length = 0;
  await f3.refresh();
  const asked = r.web.itemRequests().filter(u => u.startsWith(A)).map(u => u.slice(-31, -5));
  assert.ok(!asked.some(id => [1, 2, 3, 4, 5, 6].map(n => idOf(n)).includes(id)), 'nothing at or below the floor');
  assert.ok(asked.includes(idOf(50)) && asked.includes(idOf(7)), 'above it, old and new are read');
  assert.equal(f3.listBlygs().find(b => b.origin === A).backfill, 'caught_up');
  r.done();
});

test('ticking a post of one blyg never touches another blyg\'s reading, however many ids the others remember', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const origins = Array.from({ length: 6 }, (_, i) => `https://t${i}.web.test/`);
  origins.forEach((o, i) => publish(r.web.add(o), o, 3, { base: i * 100 }));
  follow(r, ...origins);
  await r.f.refresh();
  origins.slice(0, 5).forEach((o, i) => { r.setLedger(o, l => { l.ids = Array.from({ length: F.LIMITS.archiveIdsPerBlyg }, (_, k) => [idOf(10000000 + i * 20000 + k), 1]); }); });
  assert.equal(F.LIMITS.archiveIdsTotal, undefined, 'there is no total bound any more: a per-blyg bound and at most followMax blygs');
  const f = r.make();
  f.readMove(f.keyFor(origins[5], idOf(500 + 1)), 'tick');
  assert.deepEqual(r.ledgerIds(origins[5]), [idOf(501)], 'remembered');
  assert.ok(f.listBlygs().every(b => b.backfill === 'caught_up'), 'no blyg is stopped or paused by it');
  r.done();
});

test('documents that cannot be used are remembered with the index\'s version and not asked for again; at 100 of them reading BACK pauses for that blyg, with a Retry', async () => {
  const r = rig({ settings: { following_unread_target: 500, following_run_requests: 2000 } });
  const site = r.web.add(A);
  publish(site, A, 5);
  // 120 entries whose documents answer 200 with something that is not a usable document
  const real = r.web.get;
  const index = [...site.docs.values()].map(d => ({ id: d.id, kind: d.kind, created: d.created, updated: d.updated, version: d.version }));
  for (let i = 0; i < 120; i++) index.push({ id: idOf(60000 + i), kind: 'fragment', created: day(0), updated: day(0), version: 1 });
  const badIds = new Set(index.slice(5).map(e => e.id));
  r.web.get = async (url, o) => {
    if (String(url) === `${A}items/index.json`) return { status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify({ items: index }) };
    if (badIds.has(String(url).slice(-31, -5))) return { status: 200, url: String(url), text: '{"not": "a document"}' };
    return real(url, o);
  };
  follow(r, A);
  const s = await r.f.refresh();
  assert.equal(feed(r).length, 5, 'the five real ones are read');
  assert.equal(r.ledger(A).backfill, 'more', 'at 50 documents a run, the unusable ones are still being counted');
  assert.equal(s.invalid, 45, 'the first run: 5 real documents and 45 unusable ones make its 50 (the per-blyg document cap)');
  for (let i = 0; i < 4; i++) await r.f.refresh();
  let led = r.ledger(A);
  assert.equal(Object.keys(led.bad).length, 100);
  assert.ok(Object.values(led.bad).every(([v, at]) => v === 1 && at > 0), 'each with the version the index gave, and when');
  assert.equal(led.backfill, 'paused_bad_documents', 'the bound is reached: reading back pauses, and says why');
  assert.equal(r.f.listBlygs()[0].bad_documents, 100);
  // fresh posts still come in while it is paused
  site.put(makeDoc({ id: idOf(70000), origin: A, title: 'Brand new', created: day(200) }));
  index.push({ id: idOf(70000), kind: 'fragment', created: day(200), updated: day(200), version: 1 });
  await r.f.refresh();
  assert.ok(feed(r).some(h => h.title === 'Brand new'), 'a paused blyg still fetches FRESH posts');
  assert.equal(r.ledger(A).backfill, 'paused_bad_documents');
  // the owner's Retry clears the list and reads afresh
  assert.equal(r.f.stateRequest({ origin: A, move: 'retry' }), 'unknown');
  assert.deepEqual(r.ledger(A).bad, {});
  assert.throws(() => r.f.stateRequest({ origin: A, move: 'retry' }), /not paused/);
  // and, left alone, entries expire after badExpiryMs: the blyg recovers by itself
  for (let i = 0; i < 4; i++) await r.f.refresh();
  assert.equal(r.ledger(A).backfill, 'paused_bad_documents');
  r.clock.t += F.LIMITS.badExpiryMs + 1000;
  await r.f.refresh();
  led = r.ledger(A);
  assert.ok(Object.keys(led.bad).length <= 50, `expired and asked again, ${Object.keys(led.bad).length} remembered anew this run`);
  assert.equal(led.backfill, 'more', 'below the bound again: it recovers');
  // below the bound, an unusable document is asked for once, and again only when the index names a new version
  const q = rig({ settings: { following_unread_target: 500 } });
  const s2 = q.web.add(A);
  publish(s2, A, 3);
  const real2 = q.web.get;
  let version = 1;
  q.web.get = async (url, o) => {
    if (String(url) === `${A}items/index.json`) return { status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify({ items: [...[...s2.docs.values()].map(d => ({ id: d.id, kind: d.kind, created: d.created, updated: d.updated, version: d.version })),
      { id: idOf(900), kind: 'fragment', created: day(0), updated: day(0), version }] }) };
    if (String(url).endsWith(`${idOf(900)}.json`)) { q.web.requests.push(String(url)); return { status: 200, url: String(url), text: 'not json at all' }; }
    return real2(url, o);
  };
  follow(q, A);
  await q.f.refresh();
  assert.equal(q.web.itemRequests().filter(u => u.endsWith(`${idOf(900)}.json`)).length, 1);
  q.web.requests.length = 0;
  await q.f.refresh();
  assert.equal(q.web.itemRequests().length, 0, 'not asked again');
  assert.equal(q.ledger(A).backfill, 'caught_up', 'an unusable document does not keep a blyg from being caught up');
  version = 2;
  await q.f.refresh();
  assert.equal(q.web.itemRequests().filter(u => u.endsWith(`${idOf(900)}.json`)).length, 1, 'a new version in the index is asked for once more');
  q.done(); r.done();
});

test('fetch TROUBLE is never marked against a document: 429, 404, 410, 403, 503 and timeouts are asked again later; a host that recovers is read in full', async () => {
  for (const status of [429, 404, 410, 403, 503, 'timeout']) {
    const r = rig({ settings: { following_unread_target: 500, following_run_requests: 2000, following_max_items_per_blyg: 2000 } });
    const site = r.web.add(A);
    publish(site, A, 300);
    follow(r, A);
    let trouble = true;
    const real = r.web.get;
    r.web.get = async (u, o) => {
      if (trouble && /items\/(?!index)/.test(String(u))) {
        if (status === 'timeout') { const e = new Error('timed out'); e.kind = 'timeout'; throw e; }
        return { status, url: String(u), text: 'slow down' };
      }
      return real(u, o);
    };
    for (let i = 0; i < 3; i++) { await r.f.refresh(); r.clock.t += 20 * 60 * 1000; }
    const led = r.ledger(A);
    assert.deepEqual(led.bad, {}, `${status}: nothing is remembered as unusable`);
    assert.notEqual(led.backfill, 'paused_bad_documents', `${status}`);
    trouble = false;
    for (let i = 0; i < 8; i++) { r.clock.t += 7 * 3600e3; await r.f.refresh(); }
    assert.equal(feed(r).length, 300, `${status}: once the host answers again, everything is read`);
    assert.equal(r.ledger(A).backfill, 'caught_up');
    r.done();
  }
});

// ---- hostile index entries ----------------------------------------------------------------------------------------------------

test('hostile index entries: malformed ids, an id that is not a string, a document that names another id or origin, duplicate ids', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  publish(site, A, 3);
  const evil = r.web.add('https://evil.web.test/');
  evil.put(makeDoc({ id: idOf(55), origin: 'https://evil.web.test/', title: 'From elsewhere' }));
  const real = r.web.get;
  const good = [...site.docs.values()].map(d => ({ id: d.id, kind: d.kind, created: d.created, updated: d.updated, version: d.version }));
  const junk = [
    { id: 'short', kind: 'fragment', version: 1 }, { id: idOf(13).toUpperCase(), kind: 'fragment', version: 1 }, { id: [idOf(6)], kind: 'fragment', version: 1 },
    { id: `${idOf(7)}/../x`, kind: 'fragment', version: 1 }, { id: idOf(8), kind: 'sprocket', version: 1 }, { id: idOf(9), kind: 'fragment', version: 'one' },
    { id: idOf(10), kind: 'fragment', version: 0 }, null, 7, 'text', { id: idOf(11), kind: 'fragment', version: 1.5 },
    { id: idOf(12), kind: 'fragment', version: 1, created: day(2), updated: day(2) },   // a real-looking id whose document names another id
  ];
  site.docs.set(idOf(12), makeDoc({ id: idOf(55), origin: A, title: 'Names another id', created: day(4) }));
  r.web.get = async (url, o) => (String(url) === `${A}items/index.json`
    ? { status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify({ items: [...junk, ...good, good[0], { ...good[0], version: 1 }] }) } : real(url, o));
  follow(r, A);
  const s = await r.f.refresh();
  assert.deepEqual(titles(r).sort(), ['Post 1', 'Post 2', 'Post 3']);
  assert.equal(s.invalid, 1, 'only the document that named another id was fetched and refused');
  assert.deepEqual(Object.keys(r.ledger(A).bad), [idOf(12)]);
  const asked = r.web.itemRequests().map(u => u.split('/').pop());
  for (const n of [6, 7, 8, 9, 10, 11, 13]) assert.ok(!asked.includes(`${idOf(n)}.json`), `entry ${n} was never fetched`);
  assert.equal(asked.filter(a => a === `${idOf(1)}.json`).length, 1, 'a duplicate id is one fetch');
  r.web.requests.length = 0;
  await r.f.refresh();
  assert.equal(r.web.itemRequests().length, 0);
  r.done();
});

test('id reuse: an archived id listed with a higher version is an edit (back as new) if its document differs, and the same post if it does not; it is never a new unread post', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  publish(site, A, 3);
  follow(r, A);
  await r.f.refresh();
  r.f.readMove(keyOf(r, A, 2), 'tick');
  // the index claims version 9 but the document is still version 1 with the same words: nothing comes back
  const real = r.web.get;
  r.web.get = async (url, o) => {
    const got = await real(url, o);
    if (String(url) === `${A}items/index.json`) { const j = JSON.parse(got.text); j.items.find(i => i.id === idOf(2)).version = 9; return { ...got, text: JSON.stringify(j) }; }
    return got;
  };
  const s = await r.f.refresh();
  assert.equal(r.f.itemByKey(keyOf(r, A, 2)).read, 'archived');
  assert.equal(s.mismatched, 1);
  r.web.requests.length = 0;
  await r.f.refresh();
  assert.equal(r.web.itemRequests().length, 0, 'an index that lies about versions is not chased');
  r.done();
});

test('withdrawn items are never fetched, backfilled or held', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  publish(site, A, 4);
  site.put(makeDoc({ id: idOf(70), origin: A, kind: 'withdrawn', title: '', created: day(2), updated: day(2) }));
  follow(r, A);
  await r.f.refresh();
  assert.ok(!r.web.itemRequests().some(u => u.endsWith(`${idOf(70)}.json`)));
  assert.equal(feed(r).length, 4);
  assert.equal(r.ledger(A).backfill, 'caught_up', 'a withdrawn item is not "more to fetch"');
  r.done();
});

// ---- caught up -------------------------------------------------------------------------------------------------------------------

test('caught up: per blyg, and overall only when every blyg that is not paused is caught up and the Feed is empty', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  publish(r.web.add(A), A, 3);
  publish(r.web.add(B), B, 2, { base: 100 });
  follow(r, A, B);
  assert.equal(r.f.view().read_all, false, 'nothing read yet: not "read everything"');
  assert.deepEqual(r.f.listBlygs().map(b => b.backfill), ['unknown', 'unknown']);
  await r.f.refresh();
  assert.deepEqual(r.f.listBlygs().map(b => b.backfill), ['caught_up', 'caught_up']);
  assert.equal(r.f.view().read_all, false, 'the Feed still holds five unread posts');
  r.f.tickMany(feed(r).map(h => h.key));
  let v = r.f.view();
  assert.equal(v.tabs.feed, 0);
  assert.equal(v.read_all, true);
  assert.equal(v.tabs.archive, 5);
  // a paused blyg does not stand in the way; an unreachable one does
  r.f.setBlygState(B, 'pause');
  assert.equal(r.f.view().read_all, true);
  r.f.setBlygState(B, 'resume');
  r.web.sites.get(B).down = 'reset';
  r.clock.t += 1000;
  await r.f.refresh();
  assert.equal(r.f.listBlygs().find(b => b.origin === B).state, 'unreachable');
  assert.equal(r.f.view().read_all, false, 'a blyg that could not be asked is not "read"');
  r.web.sites.get(B).down = null;
  r.f.setBlygState(B, 'resume');
  // a new post makes it "more" and unread
  r.web.sites.get(A).put(makeDoc({ id: idOf(40), origin: A, title: 'Newest', created: day(100) }));
  await r.f.refresh();
  v = r.f.view();
  assert.equal(v.read_all, false);
  assert.equal(v.tabs.feed, 1);
  r.done();
});

test('caught up is reached by reading backwards: with a target the blyg is "more" until the last old post is fetched or ticked', async () => {
  const r = rig({ settings: { following_unread_target: 4 } });
  publish(r.web.add(A), A, 6);
  follow(r, A);
  await r.f.refresh();
  assert.equal(r.ledger(A).backfill, 'more');
  for (let round = 0; round < 3; round++) { r.f.tickMany(feed(r).map(h => h.key)); await r.f.refresh(); }
  assert.equal(r.ledger(A).backfill, 'caught_up');
  r.f.tickMany(feed(r).map(h => h.key));
  assert.equal(feed(r).length, 0);
  assert.equal(r.f.view().read_all, true);
  assert.equal(r.f.view().tabs.archive, 6);
  r.done();
});

// ---- migration ---------------------------------------------------------------------------------------------------------------------

test('a document written before the Archive loads unchanged: nothing is archived, seen and opened posts stay in the Feed, no document is refetched', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A, { title: 'Alpha Notes' });
  publish(site, A, 8);
  // the OLD shape: items with read new/seen/opened/responded, no `ledgers`, an old last_run
  const rec = (n, read) => ({ key: `${String(n).repeat(24)}`.slice(0, 24).replace(/[^0-9a-f]/g, 'a'), origin: A, id: idOf(n), kind: 'fragment', version: 1, index_version: 1,
    created: day(n), updated: day(n), fetched_at: Date.parse('2026-11-09T00:00:00Z'), page: `${A}f/${idOf(n)}/`, content_hash: site.docs.get(idOf(n)).content_hash,
    stub_of: null, transclusions: 0, links: 0, refs: [], ref_origins: [], title: `Post ${n}`, excerpt: `Words of post ${n}`, text: `Words of post ${n}`, text_chars: 17,
    author: 'x', versions: [], words: 4, body_state: 'whole', read, identity: 'unverified', last_change: 'new-words', first_seen: '2026-11-09T00:00:00Z', maintenance: 0 });
  const old = {
    blygs: { [A]: { origin: A, title: 'Alpha Notes', author: '', state: 'active', added: '2026-11-01T00:00:00Z', via: 'url', failures: 0, absent_runs: 0, retry_after: 0, last_try: 0, last_ok: 0, last_error: '' } },
    items: Object.fromEntries([[1, 'new'], [2, 'seen'], [3, 'opened'], [4, 'responded'], [5, 'seen']].map(([n, read]) => [`${A}\n${idOf(n)}`, { ...rec(n, read), key: String(n).padStart(24, 'b') }])),
    last_run: { at: '2026-11-09T00:00:00Z', new: 5 }, inbox: { state: 'off', mentions: [] },
  };
  fs.writeFileSync(r.file, JSON.stringify(old));
  const f = r.make();
  assert.equal(f.view().tabs.archive, 0, 'nothing is archived by migration');
  assert.equal(f.view().tabs.feed, 5);
  const reads = Object.fromEntries(feed({ f }).map(h => [h.id, h.read]));
  assert.deepEqual(reads, { [idOf(1)]: 'new', [idOf(2)]: 'new', [idOf(3)]: 'opened', [idOf(4)]: 'responded', [idOf(5)]: 'new' }, 'seen loads as new; opened and responded are kept');
  // the engine behaves: a refresh keeps them, and reads the older posts the index lists (6..8) back
  const s = await f.refresh();
  assert.equal(r.web.itemRequests().filter(u => [1, 2, 3, 4, 5].some(n => u.endsWith(`${idOf(n)}.json`))).length, 0, 'what was held is not fetched again');
  assert.equal(s.new, 3);
  assert.equal(f.view().tabs.feed, 8);
  assert.equal(f.listBlygs()[0].backfill, 'caught_up');
  // and the first tick on migrated state works
  assert.equal(f.readMove(f.keyFor(A, idOf(2)), 'tick'), 'archived');
  assert.equal(r.ledger(A).ids.length, 1);
  assert.ok(!('ledgers' in r.json()), 'the ledgers live in their own documents');
  r.done();
});

test('a hand-edited ledger is cleaned on load: bad ids, duplicates and a made-up mode are dropped; the lists are cut to their bounds', () => {
  const r = rig();
  publish(r.web.add(A), A, 1);
  fs.writeFileSync(r.file, JSON.stringify({ blygs: { [A]: { origin: A, title: 't', state: 'active' } }, items: {}, ledgers: {
    [A]: { ids: [idOf(1), idOf(1), 'nope', 5, null, idOf(2)], bad: { [idOf(3)]: 2, nope: 1, [idOf(4)]: 'x', [idOf(5)]: 0 }, backfill: 'sleepy' },
    'https://gone.web.test/': { ids: [idOf(1)], bad: {}, backfill: 'more' } } }));
  r.f.listBlygs();
  r.f.confirmImport([]);
  const f = r.make();
  f.listBlygs();
  assert.deepEqual(f.listBlygs().map(b => b.backfill), ['unknown']);
  // saved on the next change: the ledger of a blyg that is not followed is dropped, the rest is clean
  // (a document written before the split carried its ledgers inside it: each becomes a document of its own, written on the next save)
  f.setBlygState(A, 'pause');
  assert.ok(!('ledgers' in r.json()));
  assert.deepEqual(fs.readdirSync(path.dirname(r.ledgerFile(A))), [path.basename(r.ledgerFile(A))], 'the ledger of a blyg that is not followed is not carried over');
  const led = r.ledger(A);
  assert.deepEqual({ origin: led.origin, ids: led.ids, bad: led.bad, later: led.later, backfill: led.backfill },
    { origin: A, ids: [[idOf(1), 0], [idOf(2), 0]], bad: { [idOf(3)]: [2, r.clock.t] }, later: {}, backfill: 'unknown' });
  r.done();
});

test('unfollow keeps what was read there (a refollow brings nothing read back as unread); unfollow-and-forget does not; kept ledgers are bounded', async () => {
  const r = rig({ settings: { following_unread_target: 500, following_run_requests: 2000, following_run_seconds: 600, following_max_items_per_blyg: 2000 } });
  publish(r.web.add(A), A, 120);
  follow(r, A);
  for (let i = 0; i < 3; i++) await r.f.refresh();
  const keys = feed(r).map(h => h.key);
  r.f.tickMany(keys.slice(0, 100)); r.f.tickMany(keys.slice(100));
  assert.equal(r.f.view().tabs.archive, 120);
  r.f.unfollow(A);
  assert.equal(r.f.view().tabs.archive, 0, 'its records go');
  assert.deepEqual(r.json().items, {});
  assert.equal(r.ledgerIds(A).length, 120, 'its read ids stay');
  assert.equal(typeof r.json().kept[A], 'number');
  follow(r, A);
  for (let i = 0; i < 3; i++) await r.f.refresh();
  assert.equal(feed(r).length, 0, 'unfollow + refollow: nothing read comes back as unread');
  assert.equal(r.f.listBlygs()[0].backfill, 'caught_up');
  assert.ok(!('kept' in r.json()) || !r.json().kept[A]);
  // forget: the ledger goes too, and a refollow reads everything again
  r.f.unfollow(A, { forget: true });
  assert.equal(r.ledger(A), undefined);
  follow(r, A);
  for (let i = 0; i < 3; i++) await r.f.refresh();
  assert.equal(feed(r).length, 120);
  // bounded: at most keptMax kept ledgers, none older than keptMs
  const many = Array.from({ length: F.LIMITS.keptMax + 3 }, (_, i) => `https://k${i}.web.test/`);
  many.forEach((o, i) => publish(r.web.add(o), o, 1, { base: 1000 + i }));
  follow(r, ...many);
  await r.f.refresh();
  for (const o of many) { r.f.readMove(feed(r).find(h => h.origin === o).key, 'tick'); r.clock.t += 1000; r.f.unfollow(o); }
  assert.equal(Object.keys(r.json().kept).length, F.LIMITS.keptMax);
  assert.equal(r.ledger(many[0]), undefined, 'the oldest kept ledger was forgotten');
  assert.ok(r.ledger(many.at(-1)));
  r.clock.t += F.LIMITS.keptMs + 1;
  r.f.setBlygState(A, 'pause');
  assert.deepEqual(r.json().kept, {}, 'and none outlives keptMs');
  r.done();
});

// ---- a burst whose head is archived ------------------------------------------------------------------------------------------

test('ticking a thread WITHOUT the parts the page showed (an older page, or the engine called directly) leaves its parts in the Feed, standing alone', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  site.put(makeDoc({ id: idOf(1), origin: A, title: 'Frag', created: '2026-11-05T10:00:00Z' }));
  site.put(makeDoc({ id: idOf(2), origin: A, kind: 'thread', title: 'Thread', created: '2026-11-05T10:01:00Z', transclusions: [{ origin: A, id: idOf(1), version: 1 }] }));
  follow(r, A);
  await r.f.refresh();
  assert.equal(feed(r).length, 1, 'folded: one entry');
  r.f.readMove(keyOf(r, A, 2), 'tick');
  assert.deepEqual(titles(r), ['Frag'], 'nothing is archived that the owner did not see ticked (with the members: test/hubburst.test.mjs)');
  r.done();
});

// ---- the engine's request: what the page may ask -------------------------------------------------------------------------------

test('readRequest: tick, untick and renew only; a tick answers with the unread count and whether a top-up is worth asking for', async () => {
  const r = rig({ settings: { following_unread_target: 3 } });
  publish(r.web.add(A), A, 10);
  follow(r, A);
  await r.f.refresh();
  const key = feed(r)[0].key;
  let out = await r.f.readRequest({ key, move: 'tick' });
  assert.deepEqual([out.read, out.unread, out.target, out.topup], ['archived', 2, 3, true]);
  out = await r.f.readRequest({ keys: [feed(r)[0].key] });
  assert.equal(out.archived, 1);
  for (const bad of [{ key, move: 'see' }, { key, move: 'open' }, { key, move: 'respond' }, { key }, {}, { all: true }, { key, move: 'resurface' }, null]) {
    await assert.rejects(() => r.f.readRequest(bad), /tick, untick or renew/, JSON.stringify(bad));
  }
  await assert.rejects(() => r.f.readRequest({ key: 'nope', move: 'tick' }), /no such post/);
  // when every blyg is caught up there is nothing to top up from
  const q = rig({ settings: { following_unread_target: 50 } });
  publish(q.web.add(A), A, 4);
  follow(q, A);
  await q.f.refresh();
  out = await q.f.readRequest({ key: feed(q)[0].key, move: 'tick' });
  assert.equal(out.topup, false);
  q.done(); r.done();
});

// ---- fresh or backfill: from dates the Hub stored, never from the index's order (finding 6) --------------------------------

test('re-dating a held post (to 1970, or to no date at all) does not make every unfetched post "fresh": the target holds', async () => {
  for (const lie of ['1970-01-01T00:00:00Z', '', 'not a date']) {
    const r = rig({ settings: { following_unread_target: 5 } });
    const site = r.web.add(A);
    publish(site, A, 300);
    follow(r, A);
    await r.f.refresh();
    assert.equal(feed(r).length, 5);
    await r.f.refresh();
    assert.equal(feed(r).length, 5, 'an honest second run fetches nothing');
    const held = feed(r)[0];
    const d = site.docs.get(held.id);
    site.put({ ...d, updated: lie, created: lie || d.created });
    for (let i = 0; i < 3; i++) {
      const s = await r.f.refresh();
      assert.equal(s.new, 0, `"${lie}" run ${i + 1}: nothing new`);
      assert.equal(feed(r).length, 5, `"${lie}": the target holds`);
    }
    r.done();
  }
});

test('lying dates on unfetched posts cannot jump the queue: future, NaN, strings, negative, 1e308 are backfill, ordered as now or as 0', async () => {
  const r = rig({ settings: { following_unread_target: 3 } });
  const site = r.web.add(A);
  publish(site, A, 20);
  follow(r, A);
  await r.f.refresh();
  assert.deepEqual(titles(r), ['Post 20', 'Post 19', 'Post 18']);
  // the index now lies about five old unfetched posts; the documents themselves keep their own dates
  const lies = { 1: '2999-01-01T00:00:00Z', 2: 'NaN', 3: 'yesterday', 4: '-000001-01-01T00:00:00Z', 5: 1e308 };
  const real = r.web.get;
  r.web.get = async (url, o) => {
    const got = await real(url, o);
    if (String(url) !== `${A}items/index.json`) return got;
    const j = JSON.parse(got.text);
    for (const it of j.items) { const n = Object.keys(lies).find(k => it.id === idOf(Number(k))); if (n) { it.created = lies[n]; it.updated = lies[n]; } }
    return { ...got, text: JSON.stringify(j) };
  };
  const s = await r.f.refresh();
  assert.equal(s.new, 0, 'none of them is fresh: the Feed is at its target, so nothing is fetched');
  assert.equal(feed(r).length, 3);
  // a real new post (dated now) is still fresh
  r.clock.t += 60e3;
  site.put(makeDoc({ id: idOf(99), origin: A, title: 'Really new', created: new Date(r.clock.t).toISOString() }));
  const s2 = await r.f.refresh();
  assert.equal(s2.new, 1);
  assert.ok(titles(r).includes('Really new'));
  // and when the Feed is short, the future-dated one is read first (as "now"), the undated ones last
  r.f.tickMany(feed(r).map(h => h.key));
  await r.f.refresh();
  assert.ok(titles(r).includes('Post 1'), 'the future-dated entry sorts as now: first in the backfill');
  r.done();
});

// ---- the top-up (finding 5) --------------------------------------------------------------------------------------------------

test('30 ticks in 30 seconds over 20 blygs: at most two top-ups, no index read, a few documents each; never a refresh', async () => {
  const r = rig();
  const os = Array.from({ length: 20 }, (_, i) => `https://s${i}.web.test/`);
  for (const [i, o] of os.entries()) publish(r.web.add(o), o, 100, { base: i * 1000 });
  follow(r, ...os);
  await r.f.refresh();
  assert.equal(feed(r).length, 50);
  const n0 = r.web.requests.length;
  let topups = 0, started = 0;
  for (let i = 0; i < 30; i++) {
    const ans = await r.f.readRequest({ key: feed(r)[0].key, move: 'tick' });
    if (ans.topup) { topups++; const t = await r.f.topUp(); if (t.started) started++; }
    r.clock.t += 1000;
  }
  const asked = r.web.requests.slice(n0);
  assert.ok(started <= 2, `${started} top-ups`);
  assert.equal(asked.filter(u => /index\.json$|blyg\.json$/.test(u)).length, 0, 'no manifest and no index is read by a top-up');
  assert.ok(asked.length <= started * F.LIMITS.topupRequests, `${asked.length} requests`);
  assert.ok(feed(r).length >= 20, 'and the Feed did get topped up');
  // a refresh while a top-up runs is refused, and the other way round
  r.clock.t += F.LIMITS.topupGapMs;
  r.f.readRequest({ key: feed(r)[0].key, move: 'tick' });
  const t = r.f.topUp();
  assert.equal(r.f.runState(), 'topping_up');
  assert.match((await r.f.refresh()).reason, /topped up/);
  await t;
  const ref = r.f.refresh();
  assert.match((await r.f.topUp()).reason, /refresh is running/);
  await ref;
  assert.ok(F.RUN_STATES.includes('topping_up'));
  assert.throws(() => F.moveRun({ state: 'running' }, 'topup'), /cannot topup while running/);
  r.done();
});

test('the queue a top-up reads is validated, bounded, and every entry is checked again before it is fetched', async () => {
  const r = rig({ settings: { following_unread_target: 3 } });
  const site = r.web.add(A);
  publish(site, A, 40);
  follow(r, A);
  await r.f.refresh();
  const led = r.ledger(A);
  assert.equal(led.queue.length, F.LIMITS.queuePerBlyg);
  assert.deepEqual(led.queue.slice(0, 2).map(q => q.id), [idOf(37), idOf(36)], 'in fetch order, newest first');
  // hand-edited: junk is dropped on load, and an entry read meanwhile is skipped
  r.setLedger(A, l => { l.queue = [{ id: 'nope', kind: 'fragment', version: 1 }, { id: idOf(37), kind: 'thread?', version: 1 }, { id: idOf(36), kind: 'fragment', version: 0 }, { id: idOf(1), kind: 'withdrawn', version: 2 }, ...l.queue]; l.ids.push([idOf(37), 1]); });
  const f2 = r.make();
  f2.readMove(f2.keyFor(A, idOf(40)), 'tick');
  r.web.requests.length = 0;
  const t = await f2.topUp();
  assert.deepEqual(t, { started: true, new: 1, requests: 1 });
  assert.deepEqual(r.web.itemRequests().map(u => u.slice(-31, -5)), [idOf(36)], 'the junk and the read one were not asked for');
  r.done();
});

test('the archive record keeps a long page address whole; an address past pageChars is refused when the document is read, never cut', async () => {
  const r = rig();
  const site = r.web.add(A);
  const long = `${A}t/${'a'.repeat(600)}/`;
  const d1 = makeDoc({ id: idOf(1), origin: A, title: 'Long', created: day(1), page: long });
  const d2 = makeDoc({ id: idOf(2), origin: A, title: 'Too long', created: day(2), page: `${A}t/${'b'.repeat(F.LIMITS.pageChars)}/` });
  site.put(d1); site.put(d2);
  follow(r, A);
  const s = await r.f.refresh();
  assert.equal(s.invalid, 1, 'the one past the bound is refused');
  const k = keyOf(r, A, 1);
  r.f.readMove(k, 'tick');
  assert.equal(r.f.itemByKey(k).page, long, 'kept whole (it was clipped to 500 before)');
  assert.equal(r.f.open(k).url, long, 'so "Open original" opens the right address');
  r.done();
});

test('untick and Read here never fetch from a blyg the owner paused (or one that is gone); they say so plainly', async () => {
  const r = rig();
  const site = r.web.add(A);
  publish(site, A, 2);
  follow(r, A);
  await r.f.refresh();
  const k1 = keyOf(r, A, 1), k2 = keyOf(r, A, 2);
  r.f.readMove(k1, 'tick');
  r.f.setBlygState(A, 'pause');
  const n = r.web.requests.length;
  await assert.rejects(() => r.f.untick(k1), /that blyg is paused, so nothing is fetched from it: resume it first/);
  await assert.rejects(() => r.f.fetchPost(k2), /that blyg is paused/);
  assert.equal(r.web.requests.length, n, 'not one request');
  r.f.setBlygState(A, 'resume');
  assert.equal(await r.f.untick(k1), 'new');
  r.done();
});

// ---- the bounds the review's mutants slipped past (finding 10) ---------------------------------------------------------------

test('the index is read to its 20,000th entry and no further: a post listed after that is not seen, and a post missing then is not dropped', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  publish(site, A, 2);
  follow(r, A);
  await r.f.refresh();
  assert.equal(feed(r).length, 2);
  const real = r.web.get;
  r.web.get = async (url, o) => {
    if (String(url) !== `${A}items/index.json`) return real(url, o);
    // 20,000 withdrawn entries (never fetched) first, then a new post, and post 1 no longer listed in what is read
    const items = Array.from({ length: F.LIMITS.indexEntries }, (_, i) => ({ id: idOf(100000 + i), kind: 'withdrawn', version: 2, created: day(0), updated: day(0) }));
    items.push({ id: idOf(2), kind: 'fragment', version: 1, created: day(2), updated: day(2) });
    items.push({ id: idOf(9), kind: 'fragment', version: 1, created: '2026-11-10T11:00:00Z', updated: '2026-11-10T11:00:00Z' });
    return { status: 200, url: String(url), contentType: 'application/json', text: JSON.stringify({ items }) };
  };
  site.put(makeDoc({ id: idOf(9), origin: A, title: 'Past the cap', created: '2026-11-10T11:00:00Z' }));
  r.web.requests.length = 0;
  const s = await r.f.refresh();
  assert.equal(F.LIMITS.indexEntries, 20000);
  assert.equal(r.web.itemRequests().length, 0, 'the post past the 20,000th entry is not read');
  assert.equal(s.removed, 0, 'and the index was cut, so posts 1 and 2 missing from what was read proves nothing');
  assert.equal(feed(r).length, 2);
  r.done();
});

test('fresh posts are bounded by the per-blyg document cap too: 80 published at once are fetched 50 in one run and the rest in the next', async () => {
  const r = rig({ settings: { following_unread_target: 1, following_run_requests: 2000 } });
  const site = r.web.add(A);
  publish(site, A, 2);
  follow(r, A);
  await r.f.refresh();
  for (let k = 0; k < 80; k++) site.put(makeDoc({ id: idOf(500 + k), origin: A, title: `Fresh ${k}`, created: new Date(Date.parse('2026-11-10T11:00:00Z') + k * 1000).toISOString() }));
  const s = await r.f.refresh();
  assert.equal(s.new, F.LIMITS.docsPerBlygRun, 'fresh, so fetched past the target of 1, but no more than 50 a run');
  const s2 = await r.f.refresh();
  assert.equal(s2.new, 30);
  r.done();
});

test('a host that answers 429 is asked at most BREAKER.threshold times in a run, by the breaker (no flag of its own); nothing is marked', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  publish(site, A, 40);
  follow(r, A);
  const real = r.web.get;
  r.web.get = async (u, o) => (/items\/(?!index)/.test(String(u)) ? (r.web.requests.push(String(u)), { status: 429, url: String(u), text: 'slow down' }) : real(u, o));
  const s = await r.f.refresh();
  assert.equal(r.web.itemRequests().length, F.BREAKER.threshold);
  assert.ok(s.deferred > 0);
  assert.deepEqual(r.ledger(A).bad, {});
  assert.deepEqual(r.ledger(A).later, {}, '429 is the host\'s trouble, not a missing document');
  assert.equal(r.f.breakerSnapshot('alpha.web.test').state, 'open');
  r.done();
});

test('every mode in the engine is one named list: the ledger copy too (stored or taken), moved by one function', () => {
  assert.deepEqual(F.LEDGER_COPIES, ['stored', 'taken']);
  assert.deepEqual(F.RUN_STATES, ['idle', 'running', 'topping_up']);
  assert.deepEqual(F.ARCHIVE_STATES, ['archived', 'archived_changed']);
  assert.ok(F.ARCHIVE_STATES.every(s => F.READ_STATES.includes(s)));
});

test('at most 5 documents of read posts are fetched per blyg per refresh, even when every one is only a maintenance version', async () => {
  const r = rig({ settings: { following_unread_target: 500 } });
  const site = r.web.add(A);
  publish(site, A, 20);
  follow(r, A);
  await r.f.refresh();
  r.f.tickMany(feed(r).map(h => h.key));
  for (let k = 1; k <= 20; k++) site.put(makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: `Words of post ${k} on alpha.web.test.`, created: day(k), updated: day(100), version: 2 }));
  r.web.requests.length = 0;
  const s = await r.f.refresh();
  assert.equal(r.web.itemRequests().length, F.LIMITS.archivedDocsPerRun);
  assert.equal(s.maintenance, 5);
  assert.equal(s.edited, 0);
  for (let i = 0; i < 3; i++) await r.f.refresh();
  assert.ok(Object.values(r.json().items).every(i => i.version === 2 && i.read === 'archived'), 'all recorded, five a run, none moved');
  r.done();
});

test('a top-up is refused within topupGapMs of the last one, by the engine itself (not only by what the page is told)', async () => {
  const r = rig({ settings: { following_unread_target: 3 } });
  publish(r.web.add(A), A, 30);
  follow(r, A);
  await r.f.refresh();
  r.f.tickMany(feed(r).map(h => h.key));
  assert.equal((await r.f.topUp()).started, true);
  r.f.tickMany(feed(r).map(h => h.key));
  const second = await r.f.topUp();
  assert.deepEqual(second, { started: false, reason: 'topped up a moment ago' });
  r.clock.t += F.LIMITS.topupGapMs;
  assert.equal((await r.f.topUp()).started, true);
  r.done();
});

// ---- a blyg whose fresh entries fail (round 2, finding 1) ------------------------------------------------------------------

test('a blyg listing 2,000 "fresh" entries that 404 takes 3 requests of a run, then waits; the others are read back; its cost per day is small', async () => {
  const H = 'https://hostile.web.test/';
  const honest = Array.from({ length: 5 }, (_, i) => `https://h${i + 1}.web.test/`);
  const r = rig({ settings: { following_unread_target: 500, following_run_requests: 60, following_max_items_per_blyg: 2000, following_max_items_total: 20000 } });
  const dead = new Set();
  const real = r.web.get;
  r.web.get = async (u, o) => { const m = /items\/([^/]+)\.json$/.exec(String(u)); if (m && dead.has(m[1])) { r.web.requests.push(String(u)); return { status: 404, url: String(u), text: 'no' }; } return real(u, o); };
  const hs = r.web.add(H);
  hs.put(makeDoc({ id: idOf(1), origin: H, created: day(1) }));
  for (const o of honest) publish(r.web.add(o), o, 400);
  follow(r, H, ...honest);
  await r.f.refresh();
  const redate = () => { for (let k = 0; k < 2000; k++) { const id = idOf(100000 + k); dead.add(id); hs.put(makeDoc({ id, origin: H, created: new Date(r.clock.t + 60e3).toISOString() })); } };
  let hostile = 0;
  for (let run = 0; run < 48; run++) { // a day of refreshes, every 30 minutes, the entries re-dated to "now" each time
    r.clock.t += 30 * 60e3;
    redate();
    const n0 = r.web.requests.length;
    const s = await r.f.refresh();
    const asked = r.web.requests.slice(n0);
    hostile += asked.filter(u => u.startsWith(H)).length;
    assert.ok(asked.filter(u => u.startsWith(H) && /items\/(?!index)/.test(u)).length <= F.LIMITS.freshFailuresPerRun, `run ${run}`);
    if (run < 8) assert.ok(s.backfilled >= 40, `run ${run}: the honest blygs are read back (${s.backfilled})`);
  }
  // 2 requests a refresh for its manifest and index, and 3 document requests each time its back-off lets it try again
  assert.ok(hostile <= 2 * 48 + 3 * 12, `${hostile} requests to the hostile host in a day (was about 2,500)`);
  assert.equal(r.ledger(H).fresh, 'failing');
  assert.deepEqual(F.FRESH_MODES, ['reading', 'failing']);
  // when it serves its fresh posts again, it recovers
  dead.clear();
  r.clock.t += F.LIMITS.backoffMaxMs + 1;
  hs.put(makeDoc({ id: idOf(5), origin: H, title: 'Real again', created: new Date(r.clock.t).toISOString() }));
  await r.f.refresh();
  assert.equal(r.ledger(H).fresh, 'reading');
  r.done();
});

test('fresh posts take a fair share of a run: one blyg publishing 80 at once does not take the others\' backfill', async () => {
  const r = rig({ settings: { following_unread_target: 500, following_run_requests: 60 } });
  const os = Array.from({ length: 6 }, (_, i) => `https://f${i}.web.test/`);
  for (const [i, o] of os.entries()) publish(r.web.add(o), o, 30, { base: i * 1000 });
  follow(r, ...os);
  await r.f.refresh(); await r.f.refresh();
  for (let k = 0; k < 80; k++) r.web.sites.get(os[0]).put(makeDoc({ id: idOf(9000 + k), origin: os[0], title: `Spam ${k}`, created: new Date(r.clock.t + 1000).toISOString() }));
  r.clock.t += 5000;
  const n0 = r.web.requests.length;
  const s = await r.f.refresh();
  const spam = new Set(Array.from({ length: 80 }, (_, k) => idOf(9000 + k)));
  const docs = r.web.requests.slice(n0).filter(u => u.startsWith(os[0]) && spam.has(u.slice(-31, -5))).length;
  assert.equal(docs, Math.min(F.LIMITS.docsPerBlygRun, Math.max(F.LIMITS.freshShareMin, Math.floor(60 / 6))), 'its share: 10 of 60');
  assert.ok(s.backfilled > 0, 'and the others are still read back');
  r.done();
});
