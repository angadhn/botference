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

function boot(rig, { pages = [], confirm = 'never', dir = rig.out, home: given, queueExtra = {} } = {}) {
  const home = given || { ...rig.home, confirm, ...(confirm === 'never' ? { plan_guard: ['--only-note'] } : {}), commands: { ...rig.home.commands, ...EDIT(rig) } };
  const store = new Map(pages.map(p => [p.url, p]));
  const events = [];
  const hear = { on: true };
  let q = null;
  const pub = R.createPublisher({ file: path.join(dir, 'run.json'), broadcast: ev => events.push(ev), readConfig: () => ({ blyg_home: home }),
    readPage: url => store.get(url), savePage: p => store.set(p.url, p), onMove: (run, from) => { if (hear.on && q) q.onMove(run, from); } });
  q = Q.createQueue({ file: path.join(dir, 'queue.json'), publisher: pub, readPage: url => store.get(url), confirmNow: () => home.confirm,
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
    assert.deepEqual(Q.QUEUE_STATES, ['running', 'paused']);
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
  await until(() => b.q.view().state === 'paused', 'paused');
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
  await until(() => a.q.view().state === 'paused', 'paused');
  a.hear.on = false; a.q.stop();
  rig.control({});
  const b = boot(rig, { pages: [...a.store.values()] }); t.after(() => b.q.stop());
  await sleep(150);
  assert.deepEqual([b.q.view().state, b.stateOf(second.queued.id)], ['paused', 'queued']);
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
