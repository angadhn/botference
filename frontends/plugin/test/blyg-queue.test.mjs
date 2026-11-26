// blyg-queue.test.mjs — the publish queue: every press accepted at once, published in order by the one runner, a forced look set
// aside without blocking, failures given up or pausing, a restart, two entries for one post, the limit, cancel, and confirm always.
// The fake command set (test/fixtures/blyg-fake-cmd.mjs) in a throwaway git work tree; no network, no real site.
//
//   node --test test/blyg-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as R from '../blyg-run.mjs';
import * as Q from '../blyg-queue.mjs';
import { makeRig, until, sleep, mine, FAKE } from './blyg-rig.mjs';

const EDIT = rig => Object.fromEntries(['plan_edit', 'apply_edit', 'publish_edit'].map(k => [k, [process.execPath, FAKE, rig.log, rig.ctl, k, '{note}', '{changelog}']]));
const pageOf = (n, threads) => ({ url: `https://news.example.test/p${n}`, title: `Page ${n}`, threads });
const drawn = (id, text, extra = {}) => ({ id, quote: `A passage ${id}.`, msgs: [mine(text, { ts: `${id}-1`, channel: 'drawer' })], ...extra });

function boot(rig, { pages = [], confirm = 'never', dir = rig.out, home: given, queueExtra = {}, pubExtra = {}, confirmNow } = {}) {
  const home = given || { ...rig.home, confirm, ...(confirm === 'never' ? { plan_guard: ['--only-note'] } : {}), commands: { ...rig.home.commands, ...EDIT(rig) } };
  const store = new Map(pages.map(p => [p.url, p]));
  const events = [];
  const hear = { on: true };
  let q = null;
  const pub = R.createPublisher({ file: path.join(dir, 'run.json'), broadcast: ev => events.push(ev), readConfig: () => ({ blyg_home: home }),
    readPage: url => store.get(url), savePage: p => store.set(p.url, p), onMove: (run, from) => { if (hear.on && q) q.onMove(run, from); }, ...pubExtra });
  q = Q.createQueue({ file: path.join(dir, 'queue.json'), publisher: pub, readPage: url => store.get(url), confirmNow: confirmNow || (() => home.confirm), log: () => {},
    broadcast: ev => events.push(ev), fillCheckMs: 20, ...queueExtra });
  const press = (url, threadId, extra = {}) => q.press({ page: store.get(url), threadId, scope: 'one', shown: home.confirm, ...extra });
  const entries = () => q.view().entries;
  const stateOf = id => entries().find(e => e.id === id).state;
  return { pub, q, store, events, hear, press, entries, stateOf, home };
}
const steps = rig => rig.calls().map(c => c.step);
const noteText = (rig, b, id) => { const e = b.q.record.entries.find(x => x.id === id); const run = b.pub.book.run; void run; return e; };
void noteText;

test('the tables: every entry and queue move is listed or refused, and the one functions refuse an illegal move', () => {
  for (const from of Q.ENTRY_STATES) for (const to of Q.ENTRY_STATES) {
    const listed = Q.ENTRY_MOVES[from].includes(to);
    assert.equal(typeof listed, 'boolean');
  }
  const rig = makeRig({ confirm: 'never' });
  try {
    const b = boot(rig, { pages: [pageOf(1, [drawn('a', 'Hello.')])] });
    const e = { id: 'x', seq: 1, state: 'published' };
    assert.throws(() => b.q.moveEntry(e, 'queued'), R.IllegalMove);
    assert.throws(() => b.q.moveEntry(e, 'nonsense'), /no such state/);
    assert.throws(() => b.q.moveQueue('running'), R.IllegalMove, 'running → running is no move');
    assert.deepEqual(Q.QUEUE_STATES, ['running', 'paused_for_run', 'paused_for_site', 'paused_for_error']);
    assert.deepEqual(Q.PRESENCES, ['away', 'promised_look', 'asked_to_look']);
    assert.deepEqual(R.PRESENCES, ['here', 'away', 'asked_to_look'], 'the runner takes one presence, never two flags');
    b.q.stop();
  } finally { rig.done(); }
});

test('THREE PRESSES IN A ROW with one click: all accepted at once, published in order, each after the one before', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2, 3].map(n => pageOf(n, [drawn(`t${n}`, `Thought number ${n} about this page.`)]));
  const b = boot(rig, { pages }); t.after(() => b.q.stop());
  rig.control({ apply: 'hold' });
  const t0 = Date.now();
  const r1 = await b.press(pages[0].url, 't1');
  assert.ok(r1.ok && r1.view, 'the first runs at once, as before the queue');
  const r2 = await b.press(pages[1].url, 't2');
  const r3 = await b.press(pages[2].url, 't3');
  assert.ok(r2.ok && r2.queued && r3.ok && r3.queued, 'the others are accepted at once');
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual([r2.queued.state, r2.queued.ahead, r3.queued.ahead], ['queued', 1, 2], 'queued · 1 ahead, queued · 2 ahead');
  rig.control({});
  await until(() => b.entries().every(e => e.state === 'published'), 'all published', 20000);
  const pubs = rig.calls().filter(c => c.step === 'publish').map(c => path.basename(c.argv[3]));
  assert.equal(pubs.length, 3);
  assert.deepEqual(pubs.map(n => /thought-number-(\d)/.exec(n)[1]), ['1', '2', '3'], 'in the order pressed');
  // the runner ran one at a time: each plan came after the previous publish
  const order = steps(rig);
  assert.deepEqual(order, ['plan', 'apply', 'publish', 'plan', 'apply', 'publish', 'plan', 'apply', 'publish']);
  for (const n of [1, 2, 3]) assert.ok(b.store.get(pages[n - 1].url).threads[0].blyg_published, `page ${n} marked published`);
  assert.deepEqual(b.entries().map(e => e.result && e.result.version), [1, 1, 1]);
});

test('THE SAME THREAD pressed twice while queued: one entry, the latest text goes out; pressed while running: a new version behind it', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const p0 = pageOf(0, [drawn('busy', 'Something else first.')]);
  const p1 = pageOf(1, [drawn('t1', 'First words.')]);
  const b = boot(rig, { pages: [p0, p1] }); t.after(() => b.q.stop());
  rig.control({ apply: 'hold' });
  await b.press(p0.url, 'busy');
  const a = await b.press(p1.url, 't1');
  b.store.get(p1.url).threads[0].msgs[0].text = 'Second words, the latest.';
  const again = await b.press(p1.url, 't1');
  assert.ok(again.replaced, 'said: it replaced the earlier press');
  assert.equal(again.queued.id, a.queued.id, 'one entry, not two');
  assert.equal(b.entries().filter(e => e.thread_id === 't1').length, 1);
  rig.control({});
  await until(() => b.stateOf(a.queued.id) === 'published', 't1 published', 15000);
  const note = fs.readdirSync(rig.folder).find(n => /second-words/.test(n));
  assert.ok(note, 'the latest text went out');
  assert.match(fs.readFileSync(path.join(rig.folder, note), 'utf8'), /Second words, the latest\./);
  // now pressed while its own entry runs: queued once behind it, and it goes out as version 2
  rig.control({ apply: 'hold' });
  b.store.get(p1.url).threads[0].msgs.push(mine('A further thought.', { ts: 't1-2', channel: 'drawer' }));
  const v2 = await b.press(p1.url, 't1');
  assert.ok(v2.view, 'the runner was free: it runs at once');
  b.store.get(p1.url).threads[0].msgs.push(mine('And another.', { ts: 't1-3', channel: 'drawer' }));
  const v3 = await b.press(p1.url, 't1');
  assert.ok(v3.queued, 'pressed while its own run is under way: queued behind it');
  rig.control({});
  await until(() => b.stateOf(v3.queued.id) === 'published', 'v3', 15000);
  assert.deepEqual(b.entries().filter(e => e.thread_id === 't1').map(e => e.result.version), [1, 2, 3], 'each saw the one before: versions 1, 2, 3');
});

test('A FORCED LOOK (a comment the post had would be left out) is set aside with nothing written, and the next post publishes', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pa = pageOf(1, [drawn('x1', 'Part one of a post.'), drawn('x2', 'Part two of a post.')]);
  const pb = pageOf(2, [drawn('b', 'A plain post.')]);
  const pc = pageOf(3, [drawn('c', 'Another plain post.')]);
  const b = boot(rig, { pages: [pa, pb, pc] }); t.after(() => b.q.stop());
  await b.press(pa.url, 'x2', { scope: 'above' });
  await until(() => b.pub.book.mode === 'published', 'the two-comment post');
  // its first comment is deleted from the page, the second edited: a new version would leave a comment out
  const live = b.store.get(pa.url);
  live.threads = live.threads.filter(x => x.id !== 'x1');
  live.threads[0].msgs[0].text = 'Part two, edited.';
  rig.control({ apply: 'hold' });
  await b.press(pb.url, 'b');
  const callsBefore = rig.calls().length;
  const look = await b.press(pa.url, 'x2');
  const plain = await b.press(pc.url, 'c');
  rig.control({});
  await until(() => b.stateOf(plain.queued.id) === 'published', 'the plain one after it', 15000);
  const e = b.entries().find(x => x.id === look.queued.id);
  assert.deepEqual([e.state, e.why], ['needs_look', 'left-out']);
  assert.ok(!rig.calls().slice(callsBefore).some(c => /part-one|part-two/.test(c.argv[3] || '') && c.step === 'plan_edit'), 'nothing of it was run');
  // the owner opens it: it runs (the runner is free) and stops at the look
  const opened = await b.press(pa.url, 'x2', { look: true });
  assert.ok(opened.ok && opened.view, opened.error);
  await until(() => b.pub.book.mode === 'planned', 'planned for the look');
  assert.equal(b.pub.current().review, 'left-out');
  assert.equal(b.stateOf(look.queued.id), 'running');
  await b.pub.confirm({ id: b.pub.book.run.id, token: b.pub.book.run.token });
  await until(() => b.stateOf(look.queued.id) === 'published', 'published after the look');
});

test('AN AGENT PASSAGE publishes straight with one click; one still being written waits for the fill (the queue goes on), a failed fill fails', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const gap = mode => ({ id: 'g0', kind: 'ask', agent: 'claude', instruction: 'say it', mode, ...(mode === 'pending' ? {} : { text: 'Said by the agent.' }) });
  const filled = pageOf(1, [{ id: 'f', quote: 'q', msgs: [mine('Mine. /tk(say it)', { ts: 'f1', channel: 'drawer', gaps: [gap('filled-by-agent')] })] }]);
  const pending = pageOf(2, [{ id: 'p', quote: 'q', msgs: [mine('Mine too. /tk(say it)', { ts: 'p1', channel: 'drawer', gaps: [gap('pending')] })] }]);
  const plain = pageOf(3, [drawn('c', 'A plain one behind it.')]);
  const broken = pageOf(4, [{ id: 'k', quote: 'q', msgs: [mine('And this. /tk(say it)', { ts: 'k1', channel: 'drawer', gaps: [gap('pending')] })] }]);
  const b = boot(rig, { pages: [filled, pending, plain, broken] }); t.after(() => b.q.stop());
  rig.control({ apply: 'hold' });
  await b.press(filled.url, 'f');
  const wp = await b.press(pending.url, 'p');
  const wc = await b.press(plain.url, 'c');
  const wk = await b.press(broken.url, 'k');
  rig.control({});
  await until(() => b.stateOf(wc.queued.id) === 'published', 'the plain one went on past the filling one', 15000);
  assert.equal(b.stateOf(wp.queued.id), 'filling');
  assert.equal(b.entries()[0].state, 'published', 'the agent passage went out without a look');
  // the fill lands on the page: the entry goes out (the snapshot takes the fill)
  b.store.get(pending.url).threads[0].msgs[0].gaps = [gap('filled-by-agent')];
  await until(() => b.stateOf(wp.queued.id) === 'published', 'published after the fill', 15000);
  // a fill that fails: the entry fails, with a plain sentence, and nothing is published with a hole
  b.store.get(broken.url).threads[0].msgs[0].gaps = [{ ...gap('failed') }];
  await until(() => b.stateOf(wk.queued.id) === 'failed', 'failed fill');
  assert.equal(b.entries().find(e => e.id === wk.queued.id).failure.say, Q.FILL_FAILED_SAY);
  assert.ok(!fs.readdirSync(rig.folder).some(n => /and-this/.test(n)), 'nothing was written');
});

test('A FILL THAT NEVER COMES: bounded, then failed', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pending = pageOf(1, [{ id: 'p', quote: 'q', msgs: [mine('Waiting. /tk(say it)', { ts: 'p1', channel: 'drawer', gaps: [{ id: 'g', instruction: 'say it', mode: 'pending' }] })] }]);
  const busy = pageOf(2, [drawn('z', 'Busy first.')]);
  const b = boot(rig, { pages: [busy, pending], queueExtra: { fillWaitMs: 150 } }); t.after(() => b.q.stop());
  rig.control({ apply: 'hold' });
  await b.press(busy.url, 'z');
  const e = await b.press(pending.url, 'p');
  rig.control({});
  await until(() => b.stateOf(e.queued.id) === 'failed', 'too late', 10000);
  assert.equal(b.entries().find(x => x.id === e.queued.id).failure.say, Q.FILL_LATE_SAY);
});

test('A FAILURE BEFORE APPLY is given up through the abandon path, the entry fails, and the queue carries on', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2, 3].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const b = boot(rig, { pages }); t.after(() => b.q.stop());
  rig.control({ plan: 'fail', only: 'post-2' });
  await b.press(pages[0].url, 't1');
  const bad = await b.press(pages[1].url, 't2');
  const good = await b.press(pages[2].url, 't3');
  await until(() => b.stateOf(good.queued.id) === 'published', 'the third went on', 15000);
  const e = b.entries().find(x => x.id === bad.queued.id);
  assert.deepEqual([e.failure.step, e.failure.mode], ['plan', 'failed_plan']);
  assert.equal(b.q.view().state, 'running', 'never paused');
  assert.ok(!fs.readdirSync(rig.folder).some(n => /post-2/.test(n)), 'the draft was taken away');
});

test('A FAILURE AFTER PUSH PAUSES the queue; the owner\'s Try again resolves it, the entry goes live, and the queue resumes', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const b = boot(rig, { pages }); t.after(() => b.q.stop());
  rig.control({ publish: 'fail' });
  const first = await b.press(pages[0].url, 't1');
  const second = await b.press(pages[1].url, 't2');
  assert.ok(second.queued);
  await until(() => b.q.view().state === 'paused_for_run', 'paused');
  const fe = b.entries().find(e => e.run === first.view.id);
  assert.deepEqual([fe.state, fe.paused_by, fe.failure.mode], ['failed', true, 'failed_publish']);
  await sleep(150);
  assert.equal(b.stateOf(second.queued.id), 'queued', 'nothing more started while paused');
  // a press meanwhile is still accepted
  const p3 = pageOf(3, [drawn('t3', 'Post 3 words.')]); b.store.set(p3.url, p3);
  const third = await b.press(p3.url, 't3');
  assert.ok(third.queued);
  rig.control({});
  await b.pub.retry({ id: b.pub.book.run.id, token: b.pub.book.run.token });
  await until(() => b.stateOf(third.queued.id) === 'published', 'all out', 15000);
  assert.deepEqual(b.entries().map(e => e.state), ['published', 'published', 'published']);
  assert.equal(b.q.view().state, 'running');
});

test('A RESTART with a queue on disk: the interrupted run is handled first (given up: nothing was published), then the queue resumes', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const a = boot(rig, { pages });
  rig.control({ apply: 'hold' });
  await a.press(pages[0].url, 't1');
  const waiting = await a.press(pages[1].url, 't2');
  await until(() => a.pub.book.mode === 'applying' && a.pub.book.run.child, 'applying');
  // the companion "stops" here: the files as they are at this moment are what the next one finds
  const dir = fs.mkdtempSync(path.join(rig.out, 'restart-'));
  const run = JSON.parse(fs.readFileSync(path.join(rig.out, 'run.json'), 'utf8')); delete run.child;
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run));
  fs.copyFileSync(path.join(rig.out, 'queue.json'), path.join(dir, 'queue.json'));
  a.hear.on = false; a.q.stop(); a.pub.stopAll();
  await until(() => !R.RUN_LIVE.includes(a.pub.book.mode) || R.FAILED_MODES.includes(a.pub.book.mode), 'the old one stopped');
  rig.control({});
  const b = boot(rig, { pages: [...a.store.values()], dir }); t.after(() => b.q.stop());
  await until(() => b.stateOf(waiting.queued.id) === 'published', 'the queue resumed', 15000);
  const first = b.entries()[0];
  assert.deepEqual([first.state, first.failure.mode], ['failed', 'interrupted_applying']);
  assert.equal(b.pub.book.run.id === first.run, false, 'a later run');
});

test('A RESTART while paused stays paused until the owner resolves that run', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const a = boot(rig, { pages }); t.after(() => a.q.stop());
  rig.control({ publish: 'fail' });
  await a.press(pages[0].url, 't1');
  const second = await a.press(pages[1].url, 't2');
  await until(() => a.q.view().state === 'paused_for_run', 'paused');
  a.hear.on = false; a.q.stop();
  rig.control({});
  const b = boot(rig, { pages: [...a.store.values()] }); t.after(() => b.q.stop());
  await sleep(150);
  assert.deepEqual([b.q.view().state, b.stateOf(second.queued.id)], ['paused_for_run', 'queued']);
  await b.pub.abandon({ id: b.pub.book.run.id, token: b.pub.book.run.token });
  await until(() => b.stateOf(second.queued.id) === 'published', 'resumed after Start over', 15000);
});

test('TWO ENTRIES FOR ONE POST run in order; when the earlier one fails, the later one waits for the owner rather than overtaking', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const p = pageOf(1, [drawn('t1', 'The first version.')]);
  const other = pageOf(2, [drawn('o', 'An unrelated post.')]);
  const b = boot(rig, { pages: [p, other] }); t.after(() => b.q.stop());
  rig.control({ plan: 'hold' });
  const v1 = await b.press(p.url, 't1');
  b.store.get(p.url).threads[0].msgs.push(mine('More.', { ts: 't1-2', channel: 'drawer' }));
  const later = await b.press(p.url, 't1');
  const unrelated = await b.press(other.url, 'o');
  rig.control({ plan: 'fail' });
  await until(() => b.entries().find(e => e.run === v1.view.id).state === 'failed', 'the first failed');
  rig.control({});
  await until(() => b.stateOf(unrelated.queued.id) === 'published', 'the unrelated one went on', 15000);
  const l = b.entries().find(e => e.id === later.queued.id);
  assert.deepEqual([l.state, l.why], ['needs_look', 'earlier-failed']);
});

test('THE LIMIT: twenty posts may wait; the twenty-first press is refused with a plain sentence', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const p = pageOf(1, Array.from({ length: 21 }, (_, i) => drawn(`t${i}`, `Comment ${i} here.`)));
  const b = boot(rig, { pages: [p] }); t.after(() => b.q.stop());
  rig.control({ apply: 'hold' });
  for (let i = 0; i < 20; i++) assert.ok((await b.press(p.url, `t${i}`)).ok, `press ${i}`);
  const r = await b.press(p.url, 't20');
  assert.deepEqual([r.ok, r.status, r.error], [false, 409, Q.FULL_SAY]);
  for (const e of b.entries().filter(x => x.state === 'queued')) b.q.cancel({ entry: e.id });
  rig.control({});
  await until(() => !R.RUN_LIVE.includes(b.pub.book.mode), 'the first ends');
});

test('CANCEL: a queued entry is taken out and nothing of it is written; a running one is not; an unknown one is not found', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const b = boot(rig, { pages }); t.after(() => b.q.stop());
  rig.control({ apply: 'hold' });
  const first = await b.press(pages[0].url, 't1');
  const second = await b.press(pages[1].url, 't2');
  assert.ok(b.q.cancel({ entry: second.queued.id }).ok);
  assert.equal(b.stateOf(second.queued.id), 'cancelled');
  const running = b.entries().find(e => e.run === first.view.id);
  assert.equal(b.q.cancel({ entry: running.id }).status, 409);
  assert.equal(b.q.cancel({ entry: 'nope' }).status, 404);
  rig.control({});
  await until(() => b.pub.book.mode === 'published', 'first out');
  await sleep(100);
  assert.ok(!rig.calls().some(c => /post-2/.test(c.argv[3] || '')), 'nothing ran for the cancelled one');
  assert.ok(!fs.readdirSync(rig.folder).some(n => /post-2/.test(n)), 'nothing written');
});

test('CONFIRM ALWAYS: the first press is today\'s dialog; a press meanwhile waits, then stops at the look, and the queue waits for the owner there', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const pages = [1, 2, 3].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const b = boot(rig, { pages, confirm: 'always' }); t.after(() => b.q.stop());
  const first = await b.press(pages[0].url, 't1');
  assert.ok(first.view);
  await until(() => b.pub.book.mode === 'planned', 'the dialog');
  const second = await b.press(pages[1].url, 't2');
  const third = await b.press(pages[2].url, 't3');
  assert.deepEqual([second.queued.state, third.queued.state], ['queued', 'queued']);
  await b.pub.confirm({ id: b.pub.book.run.id, token: b.pub.book.run.token });
  await until(() => b.pub.book.mode === 'planned' && b.pub.book.run.id !== first.view.id, 'the second waits at the look');
  const se = b.entries().find(e => e.id === second.queued.id);
  assert.deepEqual([se.state, se.started_by], ['running', 'queue'], 'a notice tells the owner it is ready for their look');
  await sleep(150);
  assert.equal(b.stateOf(third.queued.id), 'queued', 'the queue waits for the owner at that entry');
  await b.pub.cancel({ id: b.pub.book.run.id, token: b.pub.book.run.token });
  await until(() => b.stateOf(second.queued.id) === 'cancelled', 'cancelled at the look');
  await until(() => b.pub.book.mode === 'planned' && b.pub.book.run.thread_ids[0] === 't3', 'the third at its look');
  await b.pub.cancel({ id: b.pub.book.run.id, token: b.pub.book.run.token });
});

// ---- review fixes (2026-11-25) --------------------------------------------------------------------------------------------------------
// a post made of two threads, published from here (x1, x2), on a page; its record keeps what each said
async function twoThreadPost(rig, b) {
  const pg = b.store.get('https://news.example.test/p1');
  await b.press(pg.url, 'x2', { scope: 'above' });
  await until(() => b.pub.book.mode === 'published', 'the post');
  return pg;
}
const noteOfPost = (rig) => { const n = fs.readdirSync(rig.folder).find(f => /part-one/.test(f)); return fs.readFileSync(path.join(rig.folder, n), 'utf8'); };
const text = (b, url, id, words) => { const t = b.store.get(url).threads.find(x => x.id === id); t.msgs[0].text = words; };

test('THE WRONG TEXT NEVER GOES LIVE: press x1, edit and press x2, edit and press x1 again: the last press of each thread is what the post ends with', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const other = pageOf(9, [drawn('z', 'Something else keeps the runner busy.')]);
  const b = boot(rig, { pages: [pageOf(1, [drawn('x1', 'Part one of a post.'), drawn('x2', 'Part two of a post.')]), other] }); t.after(() => b.q.stop());
  const pg = await twoThreadPost(rig, b);
  rig.control({ apply: 'hold' });
  await b.press(other.url, 'z');
  text(b, pg.url, 'x1', 'Part one, first edit.'); const e1 = await b.press(pg.url, 'x1');
  text(b, pg.url, 'x2', 'Part two, edited.'); const e2 = await b.press(pg.url, 'x2');
  text(b, pg.url, 'x1', 'Part one, LAST edit.'); const again = await b.press(pg.url, 'x1');
  assert.ok(again.replaced && again.queued.id === e1.queued.id);
  assert.deepEqual(b.q.view().entries.filter(e => e.state === 'queued').sort((m, n) => m.ahead - n.ahead).map(e => e.thread_id), ['x2', 'x1'], 'the replaced press moved to the back');
  // an edit the owner did not press must never go out either
  text(b, pg.url, 'x2', 'Part two, NOT PRESSED.');
  rig.control({});
  await until(() => b.stateOf(e1.queued.id) === 'published' && b.stateOf(e2.queued.id) === 'published', 'both out', 20000);
  const note = noteOfPost(rig);
  assert.match(note, /Part one, LAST edit\./, 'the last press of x1');
  assert.match(note, /Part two, edited\./, 'the last press of x2');
  assert.ok(!/first edit|NOT PRESSED|Part one of a post/.test(note), note);
});

test('…and its mirror: x2 pressed last wins, an earlier press of x1 keeps its text, nothing older returns', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const other = pageOf(9, [drawn('z', 'Something else keeps the runner busy.')]);
  const b = boot(rig, { pages: [pageOf(1, [drawn('x1', 'Part one of a post.'), drawn('x2', 'Part two of a post.')]), other] }); t.after(() => b.q.stop());
  const pg = await twoThreadPost(rig, b);
  rig.control({ apply: 'hold' });
  await b.press(other.url, 'z');
  text(b, pg.url, 'x2', 'Part two, first edit.'); const e2 = await b.press(pg.url, 'x2');
  text(b, pg.url, 'x1', 'Part one, edited.'); const e1 = await b.press(pg.url, 'x1');
  text(b, pg.url, 'x2', 'Part two, LAST edit.'); await b.press(pg.url, 'x2');
  text(b, pg.url, 'x1', 'Part one, NOT PRESSED.');
  rig.control({});
  await until(() => b.stateOf(e1.queued.id) === 'published' && b.stateOf(e2.queued.id) === 'published', 'both out', 20000);
  const note = noteOfPost(rig);
  assert.match(note, /Part one, edited\./);
  assert.match(note, /Part two, LAST edit\./);
  assert.ok(!/first edit|NOT PRESSED|Part two of a post/.test(note), note);
});

test('A MALFORMED ENTRY on disk is marked failed with a plain sentence and the queue goes on; an unexpected error pauses the queue and says so', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const a = boot(rig, { pages });
  rig.control({ apply: 'hold' });
  await a.press(pages[0].url, 't1');
  const ok2 = await a.press(pages[1].url, 't2');
  a.hear.on = false; a.q.stop(); a.pub.stopAll();
  await until(() => !['applying', 'checking', 'planning', 'preparing'].includes(a.pub.book.mode), 'stopped');
  rig.control({});
  const file = path.join(rig.out, 'queue.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.entries.push({ id: 'abcdef012345', seq: 99, state: 'queued', page_url: pages[0].url, thread_id: 't1', presence: 'away', args: { scope: 'everything' }, snapshot: 'no' });
  fs.writeFileSync(file, JSON.stringify(disk));
  const b = boot(rig, { pages: [...a.store.values()] }); t.after(() => b.q.stop());
  const bad = b.q.view().entries.find(e => e.id === 'abcdef012345');
  assert.deepEqual([bad.state, bad.failure.say], ['failed', Q.ENTRY_UNREADABLE_SAY]);
  await until(() => b.stateOf(ok2.queued.id) === 'published', 'the good one went on', 15000);
  // something unexpected (here: the page store breaks while a post waits for its fill): paused for an error, said, resumed by the owner
  const p3 = pageOf(3, [{ id: 'p', quote: 'q', msgs: [mine('Waiting. /tk(say it)', { ts: 'p1', channel: 'drawer', gaps: [{ id: 'g', instruction: 'say it', mode: 'pending' }] })] }]);
  b.store.set(p3.url, p3);
  rig.control({ apply: 'hold' });
  const busy = pageOf(4, [drawn('y', 'Busy.')]); b.store.set(busy.url, busy);
  await b.press(busy.url, 'y');
  const w = await b.press(p3.url, 'p');
  rig.control({});
  await until(() => b.stateOf(w.queued.id) === 'filling', 'filling');
  const real = b.store.get.bind(b.store);
  b.store.get = url => { if (url === p3.url) throw new Error('the store broke'); return real(url); };
  await until(() => b.q.view().state === 'paused_for_error', 'paused for the error');
  assert.equal(b.q.view().paused.say, Q.QUEUE_BROKE_SAY);
  b.store.get = real;
  assert.ok(b.q.resume().ok, 'Try the queue again');
  assert.equal(b.q.view().state, 'running');
});

test('AN UNREADABLE QUEUE FILE is kept (moved aside, never written over), the queue starts empty, and the owner is told where it is', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const file = path.join(rig.out, 'queue.json');
  fs.writeFileSync(file, '{"state": "running", "entries": [ {"id": "trunc');
  const b = boot(rig, { pages: [pageOf(1, [drawn('t1', 'Post words.')])] }); t.after(() => b.q.stop());
  const v = b.q.view();
  assert.deepEqual([v.entries.length, v.state], [0, 'running']);
  assert.ok(v.unreadable && v.unreadable.file && v.unreadable.file !== file, 'moved aside');
  assert.match(v.unreadable.say, /could not be read/);
  assert.equal(fs.readFileSync(v.unreadable.file, 'utf8'), '{"state": "running", "entries": [ {"id": "trunc', 'kept exactly');
  assert.match(path.basename(v.unreadable.file), /^blyg-publish-queue\.unreadable-\d{4}-\d\d-\d\dT/, 'a dated name');
  await b.press(pageOf(1, []).url, 't1');
  assert.equal(fs.readFileSync(v.unreadable.file, 'utf8'), '{"state": "running", "entries": [ {"id": "trunc', 'still kept after the queue wrote');
});

test('A LOOK PROMISED AT THE PRESS is kept: pressed under "see it first", the setting switched to one click later, it still stops for the look', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const gap = mode => ({ id: 'g', instruction: 'say it', mode, ...(mode === 'pending' ? {} : { agent: 'claude', text: 'Said.' }) });
  const pages = [pageOf(1, [drawn('t1', 'Post 1 words.')]), pageOf(2, [{ id: 't2', quote: 'q', msgs: [mine('Post 2 words. /tk(say it)', { ts: 'p1', channel: 'drawer', gaps: [gap('pending')] })] }])];
  const home = { ...rig.home, confirm: 'always', commands: { ...rig.home.commands, ...EDIT(rig) } };
  const b = boot(rig, { pages, home }); t.after(() => b.q.stop());
  const first = await b.press(pages[0].url, 't1');
  await until(() => b.pub.book.mode === 'planned', 'the dialog');
  const second = await b.press(pages[1].url, 't2');
  assert.equal(second.queued.presence, 'promised_look');
  await b.pub.confirm({ id: first.view.id, token: b.pub.book.run.token });
  await until(() => b.stateOf(second.queued.id) === 'filling', 'its turn came (it waits for its passage)');
  // the owner switches to one click on the machine meanwhile; then the passage lands and its turn comes
  Object.assign(home, { confirm: 'never', plan_guard: ['--only-note'] });
  b.store.get(pages[1].url).threads[0].msgs[0].gaps = [gap('filled-by-agent')];
  await until(() => b.pub.book.mode === 'planned' && b.pub.book.run.id !== first.view.id, 'the second at its look');
  assert.equal(b.pub.current().review, 'asked', 'looked at, as promised');
  await sleep(150);
  assert.ok(!rig.calls().some(c => c.step === 'apply' && /post-2/.test(c.argv[3])), 'nothing of it went out unseen');
  await b.pub.cancel({ id: b.pub.book.run.id, token: b.pub.book.run.token });
});

test('A REFUSAL ABOUT THE SITE (a failed pre-flight) pauses the queue and keeps every post queued; Try the queue again, or the next press, resumes it', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2, 3].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const home = { ...rig.home, confirm: 'never', plan_guard: ['--only-note'], commands: { ...rig.home.commands, ...EDIT(rig), check: [process.execPath, FAKE, rig.log, rig.ctl, 'check'] } };
  let siteOk = true;
  const check = async () => (siteOk ? { ok: true } : { ok: false, message: 'blyg-publish preflight: this environment cannot publish yet:\n  - the node command is not on PATH (the conformance checker runs on it)' });
  const b = boot(rig, { pages, home, pubExtra: { check } }); t.after(() => b.q.stop());
  rig.control({ apply: 'hold' });
  await b.press(pages[0].url, 't1');
  const two = await b.press(pages[1].url, 't2');
  const three = await b.press(pages[2].url, 't3');
  siteOk = false;
  rig.control({});
  await until(() => b.q.view().state === 'paused_for_site', 'paused for the site');
  assert.deepEqual([b.stateOf(two.queued.id), b.stateOf(three.queued.id)], ['queued', 'queued'], 'no post was failed');
  assert.match(b.q.view().paused.say, /^Your site cannot publish right now\. The node command is not on the companion’s PATH\./);
  siteOk = true;
  assert.ok(b.q.resume().ok);
  await until(() => b.stateOf(three.queued.id) === 'published', 'all out after Try the queue again', 15000);
  // …and a press resumes it too
  siteOk = false;
  const p4 = pageOf(4, [drawn('t4', 'Post 4 words.')]); b.store.set(p4.url, p4);
  const p5 = pageOf(5, [drawn('t5', 'Post 5 words.')]); b.store.set(p5.url, p5);
  const four = await b.press(p4.url, 't4');
  assert.equal(four.ok, false, 'run at once (nothing waited): refused in the dialog, as before');
  rig.control({ apply: 'hold' }); siteOk = true;
  await b.press(p4.url, 't4');
  siteOk = false;
  const five = await b.press(p5.url, 't5');
  rig.control({});
  await until(() => b.q.view().state === 'paused_for_site', 'paused again');
  siteOk = true;
  const p6 = pageOf(6, [drawn('t6', 'Post 6 words.')]); b.store.set(p6.url, p6);
  await b.press(p6.url, 't6');
  await until(() => b.stateOf(five.queued.id) === 'published', 'the press resumed it', 15000);
});

test('GIVING UP is one recorded step: a companion stopped in the middle finishes it after the restart, and the queue goes on', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pages = [1, 2].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const a = boot(rig, { pages });
  rig.control({ plan: 'fail', only: 'post-1' });
  a.hear.on = false;   // the queue hears nothing more: as if the companion stopped right after it recorded `giving_up`
  const first = await a.press(pages[0].url, 't1');
  const second = await a.press(pages[1].url, 't2');
  await until(() => a.pub.book.mode === 'failed_plan', 'the plan failed');
  a.q.stop();
  const file = path.join(rig.out, 'queue.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const e = disk.entries.find(x => x.run_id === first.view.id);
  Object.assign(e, { state: 'giving_up', failure: { step: 'plan', line: '', mode: 'failed_plan' } });
  fs.writeFileSync(file, JSON.stringify(disk));
  rig.control({});
  const b = boot(rig, { pages: [...a.store.values()] }); t.after(() => b.q.stop());
  await until(() => b.stateOf(second.queued.id) === 'published', 'the queue went on', 15000);
  assert.equal(b.stateOf(e.id), 'failed');
  assert.equal(b.pub.book.run.id === first.view.id, false);
  assert.ok(!fs.readdirSync(rig.folder).some(n => /post-1/.test(n)), 'the draft was taken away');
});

test('A RUN THE OWNER IS WATCHING (confirm always, the dialog) is not given up by itself: Try again is still theirs, and the queue waits, saying why', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const pages = [1, 2].map(n => pageOf(n, [drawn(`t${n}`, `Post ${n} words.`)]));
  const b = boot(rig, { pages, confirm: 'always' }); t.after(() => b.q.stop());
  const first = await b.press(pages[0].url, 't1');
  await until(() => b.pub.book.mode === 'planned', 'the dialog');
  const second = await b.press(pages[1].url, 't2');
  rig.control({ apply: 'fail' });
  await b.pub.confirm({ id: first.view.id, token: b.pub.book.run.token });
  await until(() => b.q.view().state === 'paused_for_run', 'paused on the run');
  await sleep(100);
  assert.equal(b.pub.book.mode, 'failed_apply', 'not given up');
  assert.ok(b.pub.current().can.includes('retry'));
  rig.control({});
  await b.pub.retry({ id: first.view.id, token: b.pub.book.run.token });
  await until(() => b.pub.book.run.id !== first.view.id && b.pub.book.mode === 'planned', 'resumed: the second at its look');
  assert.equal(b.entries().find(e => e.run === first.view.id).state, 'published');
  assert.equal(b.stateOf(second.queued.id), 'running');
  await b.pub.cancel({ id: b.pub.book.run.id, token: b.pub.book.run.token });
});

test('A POST THE OWNER ASKED TO LOOK AT waits for its agent\'s passage like any other (never failed as "not written yet")', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const busy = pageOf(1, [drawn('b', 'Busy first.')]);
  const pending = pageOf(2, [{ id: 'p', quote: 'q', msgs: [mine('Mine. /tk(say it)', { ts: 'p1', channel: 'drawer', gaps: [{ id: 'g', instruction: 'say it', mode: 'pending' }] })] }]);
  const b = boot(rig, { pages: [busy, pending], confirm: 'always' }); t.after(() => b.q.stop());
  await b.press(busy.url, 'b');
  await until(() => b.pub.book.mode === 'planned', 'the dialog');
  const e = await b.press(pending.url, 'p');
  await b.pub.cancel({ id: b.pub.book.run.id, token: b.pub.book.run.token });
  await until(() => b.stateOf(e.queued.id) === 'filling', 'waiting for the fill');
  b.store.get(pending.url).threads[0].msgs[0].gaps = [{ id: 'g', instruction: 'say it', mode: 'filled-by-agent', agent: 'claude', text: 'Said.' }];
  await until(() => b.stateOf(e.queued.id) === 'running' && b.pub.book.mode === 'planned', 'then at its look');
  await b.pub.cancel({ id: b.pub.book.run.id, token: b.pub.book.run.token });
});

test('THE RUNNER TAKES ONE PRESENCE: an unknown one is refused, nothing written', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const p = pageOf(1, [drawn('t1', 'Post words.')]);
  const b = boot(rig, { pages: [p] }); t.after(() => b.q.stop());
  const r = await b.pub.start({ page: p, threadId: 't1', scope: 'one', shown: 'never', presence: 'both' });
  assert.deepEqual([r.ok, r.status], [false, 400]);
  assert.deepEqual(fs.readdirSync(rig.folder), []);
});

// ---- confirmation review (2026-11-25): posts published before the texts were kept (hashes-only records), and a way out of every park --
const stripTexts = rig => { const f = path.join(rig.out, 'blyg-publish-posts.json'); const d = JSON.parse(fs.readFileSync(f, 'utf8')); for (const k in d) delete d[k].texts; fs.writeFileSync(f, JSON.stringify(d)); };
const recordOf = rig => Object.values(JSON.parse(fs.readFileSync(path.join(rig.out, 'blyg-publish-posts.json'), 'utf8')));
const noteWith = (rig, re) => { const n = fs.readdirSync(rig.folder).find(f => re.test(f)); return n ? fs.readFileSync(path.join(rig.folder, n), 'utf8') : ''; };

test('HASHES-ONLY RECORD (P1): an old post on the same page, edited in the drawer and not pressed, does not stop a NEW post from going out', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pg = pageOf(1, [drawn('q', 'Old post words here.'), drawn('n', 'A brand new thought.')]);
  const other = pageOf(9, [drawn('z', 'Something else keeps the runner busy.')]);
  const b = boot(rig, { pages: [pg, other] }); t.after(() => b.q.stop());
  await b.press(pg.url, 'q'); await until(() => b.pub.book.mode === 'published', 'q');
  stripTexts(rig);
  text(b, pg.url, 'q', 'Old post words, edited in the drawer, not pressed.');
  rig.control({ apply: 'hold' });
  await b.press(other.url, 'z');
  const r = await b.press(pg.url, 'n');
  rig.control({});
  await until(() => b.stateOf(r.queued.id) === 'published', 'n published', 20000);
  assert.ok(!/edited in the drawer/.test(noteWith(rig, /old-post-words/)), 'the old post was not touched');
});

test('HASHES-ONLY RECORD (P2): a queued press of x1 rebuilds x2 from the record\'s hashes when x2 is unchanged, and publishes', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pg = pageOf(1, [drawn('x1', 'Part one of a post.'), drawn('x2', 'Part two of a post.')]);
  const other = pageOf(9, [drawn('z', 'Something else keeps the runner busy.')]);
  const b = boot(rig, { pages: [pg, other] }); t.after(() => b.q.stop());
  await b.press(pg.url, 'x2', { scope: 'above' }); await until(() => b.pub.book.mode === 'published', 'post');
  stripTexts(rig);
  rig.control({ apply: 'hold' });
  await b.press(other.url, 'z');
  text(b, pg.url, 'x1', 'Part one edited.');
  const r = await b.press(pg.url, 'x1');
  rig.control({});
  await until(() => b.stateOf(r.queued.id) === 'published', 'published', 20000);
  const note = noteWith(rig, /part-one/);
  assert.match(note, /Part one edited\./); assert.match(note, /Part two of a post\./);
  assert.ok(recordOf(rig)[0].texts, 'the record keeps the texts from now on');
});

test('UNKNOWN-TEXT (P3): x2 changed in the drawer and not pressed parks a queued press of x1; "look at it" while the queue is busy runs it first and stops at the look with the drawer\'s text, said; the others wait, then go', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pg = pageOf(1, [drawn('x1', 'Part one of a post.'), drawn('x2', 'Part two of a post.')]);
  const o1 = pageOf(8, [drawn('y', 'Busy one.')]);
  const o2 = pageOf(9, [drawn('z', 'Busy two.')]);
  const b = boot(rig, { pages: [pg, o1, o2] }); t.after(() => b.q.stop());
  await b.press(pg.url, 'x2', { scope: 'above' }); await until(() => b.pub.book.mode === 'published', 'post');
  stripTexts(rig);
  rig.control({ apply: 'hold' });
  await b.press(o1.url, 'y');
  text(b, pg.url, 'x1', 'Part one edited.'); text(b, pg.url, 'x2', 'Part two edited, not pressed.');
  const r = await b.press(pg.url, 'x1');
  const z = await b.press(o2.url, 'z');
  rig.control({ only: 'busy-two', apply: 'hold' });
  await until(() => b.stateOf(r.queued.id) === 'needs_look', 'parked');
  assert.equal(b.entries().find(e => e.id === r.queued.id).why, 'unknown-text');
  await until(() => R.RUN_LIVE.includes(b.pub.book.mode) && /busy-two/.test(b.pub.book.run.note_rel || ''), 'z running');
  // the owner opens it while the queue is busy: it goes first, and is not set aside again
  const o = await b.press(pg.url, 'x1', { look: true });
  assert.deepEqual([o.ok, o.queued && o.queued.state, o.queued && o.queued.presence], [true, 'queued', 'asked_to_look']);
  const after = pageOf(7, [drawn('w', 'Pressed after the look.')]); b.store.set(after.url, after);
  const w = await b.press(after.url, 'w');
  rig.control({});
  await until(() => b.pub.book.mode === 'planned' && b.pub.book.run.thread_ids.includes('x1'), 'at its look');
  const v = b.pub.current();
  assert.deepEqual([v.review, v.reasons.includes('drawer-text')], ['asked', true], 'said: x2 goes out as it is in the drawer');
  assert.equal(b.stateOf(w.queued.id), 'queued', 'the post pressed after waits behind the look');
  assert.equal(b.stateOf(z.queued.id), 'published');
  await b.pub.confirm({ id: v.id, token: b.pub.book.run.token });
  await until(() => b.stateOf(r.queued.id) === 'published' && b.stateOf(w.queued.id) === 'published', 'both out', 20000);
  const note = noteWith(rig, /part-one/);
  assert.match(note, /Part one edited\./); assert.match(note, /Part two edited, not pressed\./, 'the owner\'s choice at the look');
});

test('OUTSIDE (a note edited outside the plugin) parks a queued press; "look at it" while busy runs it first, stops at the look, and Cancel there keeps the post exactly; the others go on', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pg = pageOf(1, [drawn('x1', 'Part one of a post.')]);
  const o1 = pageOf(8, [drawn('y', 'Busy one.')]);
  const o2 = pageOf(9, [drawn('z', 'Busy two.')]);
  const b = boot(rig, { pages: [pg, o1, o2] }); t.after(() => b.q.stop());
  await b.press(pg.url, 'x1'); await until(() => b.pub.book.mode === 'published', 'post');
  const file = path.join(rig.folder, fs.readdirSync(rig.folder).find(f => /part-one/.test(f)));
  const outside = fs.readFileSync(file, 'utf8') + '\nA line added on the site by hand.\n';
  fs.writeFileSync(file, outside);
  rig.control({ apply: 'hold' });
  await b.press(o1.url, 'y');
  text(b, pg.url, 'x1', 'Part one edited.');
  const r = await b.press(pg.url, 'x1');
  const z = await b.press(o2.url, 'z');
  rig.control({ only: 'busy-two', apply: 'hold' });
  await until(() => b.stateOf(r.queued.id) === 'needs_look', 'parked');
  assert.equal(b.entries().find(e => e.id === r.queued.id).why, 'outside');
  assert.equal(fs.readFileSync(file, 'utf8'), outside, 'nothing written');
  await until(() => R.RUN_LIVE.includes(b.pub.book.mode) && /busy-two/.test(b.pub.book.run.note_rel || ''), 'z running');
  assert.ok((await b.press(pg.url, 'x1', { look: true })).queued);
  rig.control({});
  await until(() => b.pub.book.mode === 'planned' && b.pub.book.run.thread_ids.includes('x1'), 'at its look');
  assert.ok(b.pub.current().reasons.includes('outside-replaced'), 'said: it replaces the changes made outside');
  await b.pub.cancel({ id: b.pub.book.run.id, token: b.pub.book.run.token });
  await until(() => b.stateOf(r.queued.id) === 'cancelled', 'cancelled at the look');
  assert.equal(fs.readFileSync(file, 'utf8'), outside, 'Cancel kept the post exactly as it was');
  assert.equal(b.stateOf(z.queued.id), 'published');
  // …and a look when the runner is free goes straight to the dialog, with the outside question as ever
  text(b, pg.url, 'x1', 'Part one edited again.');
  const again = await b.press(pg.url, 'x1', { look: true });
  assert.deepEqual([again.ok, !!again.outside], [false, true], 'the dialog asks: keep or replace');
});

test('P4: a thread deleted before its turn fails with a plain sentence; adding to an earlier post and pressing its first thread again go out in order, each with the other\'s text', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pg = pageOf(1, [drawn('a', 'Alpha thread words.'), drawn('c', 'Charlie thread words.'), drawn('d', 'Delta thread words.')]);
  const other = pageOf(9, [drawn('z', 'Busy.')]);
  const b = boot(rig, { pages: [pg, other] }); t.after(() => b.q.stop());
  await b.press(pg.url, 'a'); await until(() => b.pub.book.mode === 'published', 'a');
  rig.control({ apply: 'hold' });
  await b.press(other.url, 'z');
  const e1 = b.pub.earlierOf({ page: b.store.get(pg.url), threadId: 'c' }).earlier;
  const add = await b.press(pg.url, 'c', { join: 'add', post: e1.post, postVersion: String(e1.version) });
  text(b, pg.url, 'a', 'Alpha edited and pressed.');
  const ra = await b.press(pg.url, 'a');
  const rd = await b.press(pg.url, 'd');
  const live = b.store.get(pg.url); live.threads = live.threads.filter(x => x.id !== 'd');
  rig.control({});
  await until(() => [add, ra, rd].every(r => !['queued', 'running'].includes(b.stateOf(r.queued.id))), 'settled', 30000);
  assert.deepEqual([b.stateOf(add.queued.id), b.stateOf(ra.queued.id), b.stateOf(rd.queued.id)], ['published', 'published', 'failed']);
  assert.equal(b.entries().find(e => e.id === rd.queued.id).failure.say, 'That thread is not on this page any more.');
  const note = noteWith(rig, /alpha/);
  assert.match(note, /Alpha edited and pressed\./); assert.match(note, /Charlie thread words\./);
  assert.deepEqual([b.entries().find(e => e.id === add.queued.id).result.version, b.entries().find(e => e.id === ra.queued.id).result.version], [2, 3]);
});

test('AN EXCEPTION WHILE STARTING ONE POST fails that post (a fixed sentence, the detail in the log) and the queue goes on, never paused', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const bad = pageOf(1, [drawn('t1', 'A post with a broken page record.')]);
  const good = pageOf(2, [drawn('t2', 'A good post.')]);
  const busy = pageOf(3, [drawn('t3', 'Busy.')]);
  const b = boot(rig, { pages: [busy, bad, good] }); t.after(() => b.q.stop());
  rig.control({ apply: 'hold' });
  await b.press(busy.url, 't3');
  const rb = await b.press(bad.url, 't1');
  const rg = await b.press(good.url, 't2');
  Object.defineProperty(b.store.get(bad.url), 'blyg', { get() { throw new Error('a broken page record'); }, enumerable: true });
  rig.control({});
  await until(() => b.stateOf(rg.queued.id) === 'published', 'the good one went on', 20000);
  const e = b.entries().find(x => x.id === rb.queued.id);
  assert.equal(e.state, 'failed');
  assert.ok(/so it was not published/.test(e.failure.say) && !/broken page record/.test(e.failure.say), e.failure.say);
  assert.equal(b.q.view().state, 'running');
});

test('AN UNREADABLE QUEUE FILE THAT CANNOT BE MOVED is left in place, never written over, and the notice says the queue is in memory only', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const dir = fs.mkdtempSync(path.join(rig.out, 'ro-'));
  fs.writeFileSync(path.join(dir, 'queue.json'), 'not json');
  fs.chmodSync(dir, 0o500);
  try {
  const home = { ...rig.home, confirm: 'never', plan_guard: ['--only-note'] };
  const pub = R.createPublisher({ file: path.join(rig.out, 'run.json'), broadcast: () => {}, readConfig: () => ({ blyg_home: home }), readPage: () => null, savePage: () => {} });
  const q = Q.createQueue({ file: path.join(dir, 'queue.json'), publisher: pub, readPage: () => null, confirmNow: () => 'never', broadcast: () => {}, log: () => {} });
  t.after(() => q.stop());
  const v = q.view();
  assert.deepEqual([Q.UNREADABLE_KEPT.includes('left_in_place'), v.unreadable.file], [true, path.join(dir, 'queue.json')]);
  assert.match(v.unreadable.say, /kept in memory only until the companion restarts/);
  assert.equal(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'), 'not json');
  } finally { fs.chmodSync(dir, 0o700); }
});

test('A RECORD NOT TRUSTED to rebuild a post: one older than the version the thread says went out, or one whose version may have gone out (Forget): the next queued press of another thread of it parks for the look', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const pg = pageOf(1, [drawn('x1', 'Part one of a post.'), drawn('x2', 'Part two of a post.')]);
  const other = pageOf(9, [drawn('z', 'Busy.')]);
  const b = boot(rig, { pages: [pg, other] }); t.after(() => b.q.stop());
  await b.press(pg.url, 'x2', { scope: 'above' }); await until(() => b.pub.book.mode === 'published', 'post');
  // (1) the thread says v2 went out, the record still says v1 (its write failed at the end)
  for (const th of b.store.get(pg.url).threads) th.blyg_published.version = 2;
  rig.control({ apply: 'hold' });
  await b.press(other.url, 'z');
  text(b, pg.url, 'x1', 'Part one edited.');
  const r = await b.press(pg.url, 'x1');
  rig.control({});
  await until(() => b.stateOf(r.queued.id) === 'needs_look', 'parked');
  assert.equal(b.entries().find(e => e.id === r.queued.id).why, 'unknown-text');
  for (const th of b.store.get(pg.url).threads) th.blyg_published.version = 1;
  b.q.cancel({ entry: r.queued.id });
  // (2) a new version fails at publish (it may have gone out) and the owner Forgets it: the record is marked not trusted
  rig.control({ publish_edit: 'fail' });
  await b.press(pg.url, 'x1');
  await until(() => b.q.view().state === 'paused_for_run', 'paused on the run');
  await b.pub.forget({ id: b.pub.book.run.id, token: b.pub.book.run.token });
  assert.equal(recordOf(rig)[0].untrusted, true);
  rig.control({ apply: 'hold' });
  const busy2 = pageOf(8, [drawn('y', 'Busy again.')]); b.store.set(busy2.url, busy2);
  await b.press(busy2.url, 'y');
  text(b, pg.url, 'x2', 'Part two edited.');
  const r2 = await b.press(pg.url, 'x2');
  rig.control({});
  await until(() => b.stateOf(r2.queued.id) === 'needs_look', 'parked after the Forget');
  assert.equal(b.entries().find(e => e.id === r2.queued.id).why, 'unknown-text');
});
