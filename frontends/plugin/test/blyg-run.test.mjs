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
function boot(rig, { page, config, hook, lstartOf } = {}) {
  const pages = new Map();
  const events = [];
  const pg = page || blygPage([thread('t1', 'A sentence.', 'First thought about liveness.', { blyg: stamp() })]);
  pages.set(pg.url, pg);
  const file = path.join(rig.out, 'run.json');
  const pub = R.createPublisher({
    file, now: () => NOW, broadcast: ev => events.push(ev), hook, ...(lstartOf ? { lstartOf } : {}),
    readConfig: () => ({ blyg_home: config === undefined ? rig.home : config }),
    readPage: url => pages.get(url), savePage: p => pages.set(p.url, p),
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
  assert.deepEqual(Object.keys(kept).sort(), ['at', 'blyg_id', 'note_rel', 'note_sha', 'slug', 'snapshot', 'version'], 'what a new version needs is kept on the companion, not on the page');
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
  assert.equal(c.view.cleanup.removed, true);
  // changed since it was written: kept
  const b2 = boot(rig);
  (await b2.start()); await until(() => b2.mode() === 'planned', 'planned 2');
  v = b2.pub.current();
  fs.appendFileSync(noteOf(rig, v), '\nI edited this.\n');
  const c2 = await b2.pub.cancel({ id: v.id, token: v.token });
  assert.ok(c2.ok);
  assert.equal(fs.existsSync(noteOf(rig, v)), true, 'the owner\'s edit is not thrown away');
  assert.match(c2.view.cleanup.said, /changed since this run wrote it.*left as it is/);
  assert.equal(c2.view.cleanup.removed, false);
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
  assert.deepEqual(modes, ['drafted', 'preparing', 'planning', 'planned']);
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
  assert.deepEqual(modes, ['drafted', 'planning', 'planned']);
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
  assert.equal(a.view.cleanup.removed, true, 'the draft is removed: the run never reached apply');
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
    assert.equal(a.view.cleanup.removed, true, `the draft is taken away (${withAbandon})`);
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
  assert.deepEqual(modes, ['drafted', 'preparing', 'planning', 'planned', 'applying', 'applied', 'publishing', 'published']);
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
  const bad = [process.execPath, '-e', 'console.log("ruby 2.6.10 is on PATH, 3.2 needed");console.log("BLYG_CHECKER is not set");process.exit(1)'];
  const b = boot(rig, { config: { ...rig.home, commands: { ...rig.home.commands, check: bad } } });
  const r = (await b.start());
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  assert.match(r.error, /^Your site cannot publish right now: Ruby 2\.6\.10 is on PATH, 3\.2 needed\. BLYG_CHECKER is not set\.$/);
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
  assert.deepEqual([f.view.mode, f.view.cleanup.forgotten, f.view.cleanup.removed], ['abandoned', true, false]);
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
  const no = boot(rig2, { config: { ...rig2.home, commands: { ...rig2.home.commands, check: [process.execPath, '-e', 'console.log("BLYG_CHECKER is not set"); process.exit(1)'] } } });
  const refused = await no.start();
  assert.deepEqual([refused.status, no.mode()], [409, 'idle']);
  assert.match(refused.error, /BLYG_CHECKER is not set/);
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
  assert.equal(v.failure, 'The note is already staged by this checkout; unstage it before staging another note.', 'the site\'s plain line, without its script name, path or flag');
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
  assert.equal(R.plainLineOf('x\nRefused: release date 2027-01-01 is in the future\nState: planned'), 'Release date 2027-01-01 is in the future.');
  assert.equal(R.plainSentence('blyg-publish: main moved from abc to def after apply; run again to apply'), 'Main moved from abc to def after apply; run again to apply.');
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

test('THE AGENT-TEXT RULE: a post with any agent-written or pasted passage is always shown first, even with confirm never', async t => {
  const rig = makeRig({ confirm: 'never', extra: { plan_guard: ['--only-note', '--quick'] } }); t.after(rig.done);
  const withGap = { id: 't1', quote: 'q', blyg: stamp(), msgs: [mine('Mine. /tk(say it)', { gaps: [{ id: 'g0', kind: 'ask', agent: 'claude', instruction: 'say it', mode: 'filled-by-agent', text: 'Said.', model: 'claude-x', at: '2026-11-24T10:00:00Z' }] })] };
  const b = boot(rig, { page: blygPage([withGap]) });
  const r = await b.start('t1', 'one', 'never');
  assert.ok(r.ok, r.error);
  assert.deepEqual([r.view.confirm, r.view.review], ['always', 'agent-text']);
  await until(() => b.mode() === 'planned', 'planned');
  await sleep(200);
  assert.equal(b.mode(), 'planned', 'it waits for the owner');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan']);
  assert.deepEqual(b.pub.current().reading.map(p => p.kind), ['words', 'agent', 'quote'], 'the box is in the preview');
  assert.equal(b.pub.current().reading[1].label, 'Claude');
  assert.deepEqual([R.reviewFor('never'), R.reviewFor('always'), R.reviewFor('never', { agentText: true })], [{ confirm: 'never', review: 'none' }, { confirm: 'always', review: 'setting' }, { confirm: 'always', review: 'agent-text' }]);
  assert.deepEqual([b.pub.current().pace, R.paceOf(['--only-note']), b.pub.current().full_minutes], ['quick', 'full', null], 'quick with the site\'s quick flag; no guess at minutes when none is recorded');
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
  // the note changed on the site by hand: not rewritten from here
  th.msgs = [mine('First comment, edited.', { ts: '1' })];
  fs.appendFileSync(path.join(rig.top, rel), '\nedited by hand\n');
  const hand = await b.start();
  assert.match(hand.error, /changed on your site since it was published from here/);
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
