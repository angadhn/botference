// hubstore.test.mjs — the Hub's storage seam (following-store.mjs, and following.mjs's transactions): one asynchronous store with a
// real compare-and-swap; what each operation reads and writes, in which order; the layout on disk; the conversion of the older
// layout (one main document holding every post) with nothing lost if it stops half way.
//
//   node --test test/hubstore.test.mjs
//
// No network: invented blygs held in memory (test/following-fake.mjs). The interleavings of two engines are in hubtx.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as F from '../following.mjs';
import { makeWeb, makeDoc, idOf } from './following-fake.mjs';
import { readLayout } from './hub-layout.mjs';

const CFG = createRequire(import.meta.url)('../extension/config.js');
const A = 'https://alpha.web.test/notes/';
const B = 'https://beta.web.test/';
const day = n => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 3600e3).toISOString();
const publish = (site, origin, n, { base = 0 } = {}) => {
  for (let k = 1; k <= n; k++) site.put(makeDoc({ id: idOf(base + k), origin, title: `Post ${k}`, body: `Words of post ${k}.`, created: day(base + k) }));
};
const NAME = o => F.ledgerName(o);

/** An engine over `store` (a memory store unless given), or over a file; `web` and the clock may be shared by two engines. */
function engine({ store, file, web = makeWeb(), clock = { t: Date.parse('2026-11-10T12:00:00Z') }, settings = {} } = {}) {
  if (!file && !store) store = F.memoryStore({ now: () => clock.t });
  const get = async (u, o) => { clock.t += 10; return web.get(u, o); };
  const f = F.createFollowing({ file, store, get, now: () => clock.t, getSettings: () => CFG.followingSettingsOf({ following_unread_target: 500, ...settings }).settings,
    timers: { set: () => ({}), clear: () => {} } });
  return { f, web, clock, store };
}
const feed = async f => (await f.view({ limit: 1000 })).entries.map(e => e.head);
const writesOf = (store, from) => store.log.slice(from).filter(x => x.startsWith('put ') || x.startsWith('delete '));

test('the store: asynchronous, a version per entry, and a real compare-and-swap (null: only if absent; a version: only if still it)', async () => {
  for (const kind of ['memory', 'files']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubstore-'));
    const s = kind === 'memory' ? F.memoryStore() : F.fileStore(path.join(dir, 'following.json'));
    assert.equal(await s.get('ledger', 'ab12'), null);
    const v1 = (await s.put('ledger', 'ab12', { a: 1 }, { ifVersion: null })).version;
    await assert.rejects(s.put('ledger', 'ab12', { a: 2 }, { ifVersion: null }), F.StoreConflict, `${kind}: not absent any more`);
    const v2 = (await s.put('ledger', 'ab12', { a: 2 }, { ifVersion: v1 })).version;
    await assert.rejects(s.put('ledger', 'ab12', { a: 3 }, { ifVersion: v1 }), F.StoreConflict, `${kind}: a stale version is refused`);
    const got = await s.get('ledger', 'ab12');
    assert.deepEqual([got.value, got.version], [{ a: 2 }, v2]);
    assert.ok(Number.isFinite(got.at), 'when it was written: what an age-gated sweep reads');
    await assert.rejects(s.delete('ledger', 'ab12', { ifVersion: v1 }), F.StoreConflict);
    assert.equal(await s.delete('ledger', 'ab12', { ifVersion: v2 }), true);
    assert.deepEqual(await s.list('ledger'), []);
    assert.deepEqual(F.STORE_KINDS, ['state', 'feed', 'archive', 'ledger', 'body']);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('everything the engine keeps goes through the one store: with a memory store and no file, the whole life of a blyg works', async () => {
  const { f, web, store } = engine();
  publish(web.add(A), A, 5);
  await f.confirmImport([{ origin: A }]);
  await f.refresh();
  assert.equal((await feed(f)).length, 5);
  const k = await f.keyFor(A, idOf(3));
  assert.match(await f.bodyHtml(k), /Words of post 3/, 'the body is a body in the store');
  await f.readMove(k, 'tick');
  assert.equal(await f.bodyHtml(k), '', 'and is deleted with the tick');
  assert.deepEqual(store.names('state').sort(), ['following', 'run']);
  assert.deepEqual(store.names('ledger'), [NAME(A)]);
  assert.deepEqual(store.peek('ledger', NAME(A)).ids.map(p => p[0]), [idOf(3)]);
  assert.deepEqual(Object.keys(store.peek('archive', NAME(A)).items), [idOf(3)]);
  assert.equal(Object.keys(store.peek('feed', NAME(A)).items).length, 4);
  assert.equal(store.names('body').length, 4);
  assert.equal(await f.untick(k), 'new');
  assert.equal(store.names('body').length, 5);
  await f.unfollow(A);
  assert.equal(store.names('body').length, 0);
  assert.deepEqual([store.names('feed'), store.names('archive')], [[], []], 'its feed and archive go; its ledger is kept');
  // and a second engine over the same store sees exactly what the first left
  const second = engine({ store, web });
  assert.deepEqual(await second.f.listBlygs(), []);
});

test('a tick writes ITS blyg\'s archive, then its feed, then its ledger (ids added last), and deletes the body after; nothing else', async () => {
  const { f, web, store } = engine();
  publish(web.add(A), A, 3);
  publish(web.add(B), B, 3, { base: 100 });
  await f.confirmImport([{ origin: A }, { origin: B }]);
  await f.refresh();
  const main = store.peek('state', 'following');
  assert.ok(!('items' in main) && !('ledgers' in main) && !('inbox' in main), 'the main document holds no post, no ledger, no inbox');
  const k = await f.keyFor(A, idOf(2));
  const body = (await f.itemByKey(k)).body;
  const n0 = store.log.length;
  await f.readMove(k, 'tick');
  assert.deepEqual(writesOf(store, n0), [`put archive:${NAME(A)}`, `put feed:${NAME(A)}`, `put ledger:${NAME(A)}`, `delete body:${body}`]);
  const n1 = store.log.length;
  await f.open(await f.keyFor(B, idOf(101)));
  assert.deepEqual(writesOf(store, n1), [`put feed:${NAME(B)}`], 'opening writes that blyg\'s feed and nothing else');
  const n2 = store.log.length;
  await f.view();
  assert.deepEqual(writesOf(store, n2), [], 'a view writes nothing');
});

test('a refresh writes per blyg (feed, ledger) and the main document; a ledger that did not change is not written', async () => {
  const { f, web, store } = engine({ settings: { following_run_requests: 2000, following_run_seconds: 600 } });
  const origins = Array.from({ length: 12 }, (_, i) => `https://s${i}.web.test/`);
  origins.forEach((o, i) => publish(web.add(o), o, 2, { base: i * 100 }));
  await f.confirmImport(origins.map(origin => ({ origin })));
  const n0 = store.log.length;
  const s = await f.refresh();
  assert.equal(s.blygs, 12);
  const w = writesOf(store, n0);
  assert.equal(w.filter(x => x.startsWith('put feed:')).length, 12, 'each feed once');
  assert.ok(w.filter(x => x.startsWith('put ledger:')).length <= 24, 'each ledger at most twice (its apply, and its queue and mode)');
  assert.equal(w.filter(x => x.startsWith('put archive:')).length, 0, 'nothing archived: no archive written');
  const n1 = store.log.length;
  await f.refresh();
  assert.equal(writesOf(store, n1).filter(x => x.startsWith('put ledger:') || x.startsWith('put feed:')).length, 0, 'nothing changed: no feed or ledger written');
});

test('a conditional write: what another engine saved meanwhile is applied again, never written over (a tick there survives a refresh here)', async () => {
  for (const kind of ['memory', 'files']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubstore-'));
    const web = makeWeb(), clock = { t: Date.parse('2026-11-10T12:00:00Z') };
    const opts = kind === 'memory' ? { store: F.memoryStore({ now: () => clock.t }) } : { file: path.join(dir, 'following.json') };
    const site = web.add(A);
    publish(site, A, 4);
    const one = engine({ ...opts, web, clock });
    await one.f.confirmImport([{ origin: A }]);
    await one.f.refresh();
    // a second process (or a second invocation of a serverless host) ticks post 2
    const two = engine({ ...opts, web, clock });
    assert.equal(await two.f.readMove(await two.f.keyFor(A, idOf(2)), 'tick'), 'archived');
    // the first, which never saw that tick, refreshes: post 3 has new words
    site.put(makeDoc({ id: idOf(3), origin: A, title: 'Post 3', body: 'New words of post 3.', version: 2, created: day(3), updated: day(50) }));
    const s = await one.f.refresh();
    assert.equal(s.edited, 1);
    const three = engine({ ...opts, web, clock });
    assert.deepEqual((await three.f.view({ view: 'archive' })).archive.map(l => l.title), ['Post 2'], kind);
    assert.ok(!(await feed(three.f)).some(h => h.id === idOf(2)), `${kind}: the tick was not undone`);
    assert.equal((await feed(three.f)).find(h => h.id === idOf(3)).version, 2, `${kind}: the refresh's own work was kept`);
    assert.equal((await one.f.itemByKey(await one.f.keyFor(A, idOf(2)))).read, 'archived', `${kind}: and the first engine reads it too`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the layout on disk: following.json (no post in it), following-feed/, following-archive/, following-ledgers/, following-bodies/', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubstore-'));
  const file = path.join(dir, 'following.json');
  const { f, web } = engine({ file });
  publish(web.add(A), A, 2);
  await f.confirmImport([{ origin: A }]);
  await f.refresh();
  await f.readMove(await f.keyFor(A, idOf(1)), 'tick');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(doc).sort(), ['blygs', 'kept', 'last_run', 'layout', 'ops']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['following-archive', 'following-bodies', 'following-feed', 'following-ledgers', 'following-run.json', 'following.json']);
  assert.equal(Object.keys(readLayout(file).items).length, 2);
  const stale = path.join(dir, 'following-bodies', 'abc.html.tmp.999');
  fs.writeFileSync(stale, 'x');
  const old = new Date(Date.now() - 2 * 3600e3);
  fs.utimesSync(stale, old, old);
  await f.sweep();
  assert.ok(!fs.existsSync(stale));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('"Tick all shown" is taken 100 at a time: a request naming more ticks the first 100 (the page sends the rest)', async () => {
  const { f, web } = engine({ settings: { following_max_items_per_blyg: 2000, following_run_requests: 2000, following_run_seconds: 600 } });
  publish(web.add(A), A, 150);
  await f.confirmImport([{ origin: A }]);
  for (let i = 0; i < 3; i++) await f.refresh();
  const keys = (await feed(f)).map(h => h.key);
  assert.equal(keys.length, 150);
  assert.equal(F.LIMITS.tickBatch, 100);
  const t0 = performance.now();
  assert.equal(await f.tickMany(keys), 100);
  assert.ok(performance.now() - t0 < 2000);
  assert.equal((await feed(f)).length, 50);
  assert.equal(await f.tickMany(keys.slice(100)), 50);
});

test('a body nothing names is swept only when older than bodySweepAgeMs (it may belong to a transaction not yet committed)', async () => {
  const { f, web, store, clock } = engine();
  publish(web.add(A), A, 2);
  await f.confirmImport([{ origin: A }]);
  await f.refresh();
  await store.put('body', 'abcdef0123456789abcdef01', '<p>written by an invocation that has not committed yet</p>');
  await f.sweep();
  assert.ok(store.names('body').includes('abcdef0123456789abcdef01'), 'young: kept');
  clock.t += F.LIMITS.bodySweepAgeMs + 1;
  await f.sweep();
  assert.ok(!store.names('body').includes('abcdef0123456789abcdef01'), 'old and named by nothing: gone');
  assert.equal(store.names('body').length, 2, 'the bodies the records name stay');
});

test('unfollow-and-forget deletes the feed, archive and ledger only after the main document is written', async () => {
  const { f, web, store } = engine();
  publish(web.add(A), A, 2);
  await f.confirmImport([{ origin: A }]);
  await f.refresh();
  await f.readMove(await f.keyFor(A, idOf(1)), 'tick');
  const n0 = store.log.length;
  await f.unfollow(A, { forget: true });
  const w = writesOf(store, n0);
  const main = w.indexOf('put state:following');
  assert.ok(main >= 0 && main < w.indexOf(`delete ledger:${NAME(A)}`) && main < w.indexOf(`delete feed:${NAME(A)}`), w.join(', '));
});

// ---- the conversion of the older layout ------------------------------------------------------------------------------
/** A main document of the layout before this one: every post inside it; its ledgers in their own documents. */
async function oldLayout(store, clock) {
  const items = {};
  for (let k = 1; k <= 6; k++) {
    const id = idOf(k);
    items[`${A}\n${id}`] = { key: `${'ab'.repeat(12)}`.slice(0, 20) + String(k).padStart(4, '0'), origin: A, id, kind: 'fragment', version: 1, created: day(k), updated: day(k),
      page: `${A}f/${id}/`, content_hash: `sha256:${k}`, read: k <= 2 ? 'archived' : k === 3 ? 'opened' : 'new', title: `Post ${k}`, excerpt: `Words of post ${k}.`, text: `Words of post ${k}.`,
      body_state: 'whole', fetched_at: clock.t, first_seen: day(k), ...(k <= 2 ? { archived_at: day(100 + k) } : {}) };
  }
  await store.put('state', 'following', { blygs: { [A]: { origin: A, title: 'Alpha', state: 'active', failures: 0 } }, items, kept: {}, last_run: null,
    inbox: { state: 'off', mentions: [] } });
  await store.put('ledger', NAME(A), { origin: A, ids: [[idOf(1), Date.parse(day(1))]], backfill: 'more', queue: [] });
  for (let k = 3; k <= 6; k++) await store.put('body', items[`${A}\n${idOf(k)}`].key, `<p>Words of post ${k}.</p>`);
  return items;
}

test('the older layout converts on first read: posts to their blyg\'s feed and archive, ids into the ledger, nothing archived by it', async () => {
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const store = F.memoryStore({ now: () => clock.t });
  await oldLayout(store, clock);
  const { f, web } = engine({ store, clock });
  publish(web.add(A), A, 6);
  const v = await f.view({ limit: 100 });
  assert.equal(v.tabs.feed, 4, 'opened and new stay in the Feed');
  assert.equal(v.tabs.archive, 2);
  assert.match(v.entries.find(e => e.head.id === idOf(4)).head.body_head, /Words of post 4/, 'a body of the older layout is read under its key');
  const main = store.peek('state', 'following');
  assert.equal(main.layout, 2);
  assert.ok(!('items' in main) && !('inbox' in main));
  assert.deepEqual(store.peek('ledger', NAME(A)).ids.map(p => p[0]).sort(), [idOf(1), idOf(2)], 'R3: every archive record\'s id is in the ledger');
  assert.equal(store.peek('state', 'pre-shard'), null, 'the copy is deleted once converted');
  const s = await f.refresh();
  assert.equal(s.new + s.edited, 0, 'nothing read comes back, nothing is fetched as new');
});

test('a conversion that stops half way (the process died at any write) loses nothing: the next read converts again', async () => {
  for (let die = 1; die <= 6; die++) {
    const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
    const store = F.memoryStore({ now: () => clock.t });
    await oldLayout(store, clock);
    const one = engine({ store, clock });
    store.crashAfter(die);
    await assert.rejects(one.f.view(), /died here/, `die at write ${die}`);
    store.crashAfter(0);
    const main = store.peek('state', 'following');
    if (main.layout !== 2) assert.ok(store.peek('state', 'pre-shard') || die === 1, `die ${die}: the old document is untouched, and its copy kept`);
    const two = engine({ store, clock });
    const v = await two.f.view({ view: 'archive' });
    assert.deepEqual([v.tabs.feed, v.tabs.archive], [4, 2], `die ${die}`);
    assert.deepEqual(store.peek('ledger', NAME(A)).ids.map(p => p[0]).sort(), [idOf(1), idOf(2)], `die ${die}`);
  }
});

test('a file of the older layout converts the same way, and its copy is kept until the main document is written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubstore-'));
  const file = path.join(dir, 'following.json');
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  await oldLayout(F.fileStore(file), clock);
  const before = fs.readFileSync(file, 'utf8');
  const { f } = engine({ file, clock });
  assert.equal((await f.view()).tabs.feed, 4);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).layout, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'following-pre-shard.json')), 'the copy goes once done');
  assert.ok(before.includes('"items"'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a record is bounded whatever a document says: 10 versions, its own blyg\'s references without their origin, no long origins', () => {
  const H = `https://h.web.test/${'p'.repeat(150)}/`;
  const doc = makeDoc({ id: idOf(1), origin: H, kind: 'thread', title: 'T'.repeat(400), body: 'word '.repeat(5000), author: 'a'.repeat(400),
    page: `${H}${'x'.repeat(F.LIMITS.pageChars - H.length - 2)}/`,
    transclusions: [...Array.from({ length: 300 }, (_, i) => ({ origin: H, id: idOf(10 + i), version: 99 })),
      ...Array.from({ length: 300 }, (_, i) => ({ origin: `https://${'o'.repeat(60)}${i}.web.test/${'q'.repeat(150)}/`, id: idOf(1000 + i), version: 9 }))],
    changelog: Array.from({ length: 200 }, (_, i) => ({ version: i + 1, at: day(i), note: 'n'.repeat(400), pinned: true })) });
  doc.version = 200;
  doc.stub_of = { origin: `https://${'s'.repeat(200)}.web.test/`, id: idOf(5) };
  const rec = F.recordFromDoc(doc, H, {});
  assert.equal(rec.versions.length, F.LIMITS.versionsKept);
  assert.equal(rec.refs.length, F.LIMITS.refsKept);
  assert.ok(rec.refs.every(r => !('origin' in r)), 'a reference to its own blyg does not repeat the origin');
  assert.ok(rec.ref_origins.every(o => o.length <= F.LIMITS.refOriginChars));
  const bytes = JSON.stringify(rec).length;
  assert.ok(bytes < 14 * 1024, `the worst record: ${bytes} bytes (was about 51 KB with 100 versions and 50 references of any origin)`);
  // a burst of 50 parts still folds under its thread from these references
  const parts = Array.from({ length: 50 }, (_, i) => ({ origin: H, id: idOf(10 + i), kind: 'fragment', created: doc.created, updated: doc.created, version: 1 }));
  const folded = F.foldBursts([{ ...rec, created: doc.created, updated: doc.created }, ...parts]);
  assert.equal(folded.find(e => e.head.id === idOf(1)).members.length, 50);
});
