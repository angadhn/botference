// blyg-run.test.mjs — one Publish-as-blyg run: its named modes (every legal move, every illegal one refused), the steps
// against a fake command in a throwaway git work tree, failure at each step, recovery after a crash, and the safety of the
// note file. Nothing here touches the network or any real site.
//
//   node --test test/blyg-run.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as R from '../blyg-run.mjs';
import * as H from '../blyg-home.mjs';
import { makeRig, until, sleep, thread, blygPage, stamp, mine, ID, FAKE } from './blyg-rig.mjs';

const NOW = new Date('2026-11-23T12:00:00Z');
function boot(rig, { page, config } = {}) {
  const pages = new Map();
  const events = [];
  const pg = page || blygPage([thread('t1', 'A sentence.', 'First thought about liveness.', { blyg: stamp() })]);
  pages.set(pg.url, pg);
  const file = path.join(rig.out, 'run.json');
  const pub = R.createPublisher({
    file, now: () => NOW, broadcast: ev => events.push(ev),
    readConfig: () => ({ blyg_home: config === undefined ? rig.home : config }),
    readPage: url => pages.get(url), savePage: p => pages.set(p.url, p),
  });
  return { pub, pages, events, file, page: pg, start: (threadId = 't1', scope = 'one') => pub.start({ page: pages.get(pg.url), threadId, scope }),
    mode: () => pub.current().mode };
}
const noteOf = (rig, v) => path.join(rig.top, v.note_rel);

// ---- the mode table -------------------------------------------------------------------
test('the mode table: every move is either listed or refused, the retry is guarded, and RunBook.move is the only door', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blygtable-'));
  let legal = 0, illegal = 0;
  for (const from of R.RUN_MODES) {
    for (const to of R.RUN_MODES) {
      const run = { mode: from, id: 'x', token: 'y', failed_step: 'publish', steps: [] };
      const want = R.RUN_MOVES[from].includes(to) && !(from === 'failed' && ['preparing', 'planning', 'applying'].includes(to));
      assert.equal(R.canMove(from, to, run), want, `${from} → ${to}`);
      const file = path.join(dir, `${from}-${to}.json`);
      fs.writeFileSync(file, JSON.stringify(run));
      const book = new R.RunBook({ file: path.join(dir, 'none.json') });
      book.run = { ...run };
      if (want) { book.move(to); assert.equal(book.mode, to); legal++; }
      else { assert.throws(() => book.move(to), R.IllegalMove, `${from} → ${to} refused`); assert.equal(book.mode, from, 'and the mode did not change'); illegal++; }
    }
  }
  assert.ok(legal >= 28 && illegal >= 110, `${legal} legal, ${illegal} illegal`);
  assert.throws(() => new R.RunBook({}).move('nonsense'), /no such mode/);
  for (const step of ['prepare', 'plan', 'apply', 'publish']) {
    const to = R.RETRY_FOR[step];
    assert.ok(R.canMove('failed', to, { failed_step: step }));
    for (const other of ['preparing', 'planning', 'applying', 'publishing'].filter(x => x !== to)) assert.equal(R.canMove('failed', other, { failed_step: step }), false, `${step} fails → ${other}`);
  }
  assert.deepEqual(R.RUN_MODES.filter(m => !R.RUN_FINISHED.includes(m) && m !== 'idle' || false).sort(), [...R.RUN_LIVE].sort());
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
  const r = b.start();
  assert.ok(r.ok, r.error);
  await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  assert.deepEqual(rig.calls().map(c => c.step), ['plan'], 'only plan has run');
  assert.ok(fs.existsSync(noteOf(rig, v)), 'the note is written');
  assert.equal(v.note_rel, 'my notes/first-thought-about-liveness.md');
  assert.match(v.note_text, /^---\ntitle: "First thought about liveness"\ncreated: 2026-11-23\nreleased: "2026-11-23"\nblyg: true\npermalink: \/b\/first-thought-about-liveness\n/);
  assert.match(v.steps[0].output, /plan: ok for my notes\/first-thought-about-liveness\.md\nWould notify: nobody/);
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
  assert.deepEqual(done.steps.map(s => [s.step, s.exit]), [['plan', 0], ['apply', 0], ['publish', 0]]);
  assert.equal(done.published.address, 'https://site.example.test/b/first-thought-about-liveness');
  assert.equal(done.published.permalink, '/b/first-thought-about-liveness');
  const marked = b.pages.get(b.page.url).threads[0].blyg_published;
  assert.deepEqual(Object.keys(marked).sort(), ['address', 'at', 'permalink', 'title'], 'only what a reader of the page may know');
  assert.equal(marked.address, done.published.address);
  assert.ok(b.events.some(e => e.type === 'page'), 'the page is announced');
  assert.ok(b.events.filter(e => e.type === 'blyg-publish').length >= 6, 'every move is announced');
  // …and the same comment is not offered again
  const again = b.start();
  assert.equal(again.ok, false);
  assert.match(again.error, /already published.*as an edit is not available/);
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
  const r = b.start('t2', 'above');
  assert.ok(r.ok, r.error);
  await until(() => b.mode() === 'planned', 'planned');
  const v = b.pub.current();
  assert.deepEqual(v.thread_ids, ['t0', 't1', 't2'], 'the guest\'s and the agent-addressed ones are not the owner\'s to publish');
  assert.ok(v.note_text.indexOf('Nothing to do with it.') < v.note_text.indexOf('First thought.') && v.note_text.indexOf('First thought.') < v.note_text.indexOf('Second thought.'));
  assert.ok(!v.note_text.includes('a guest') && !v.note_text.includes('explain this'));
  await b.pub.confirm({ id: v.id, token: v.token });
  await until(() => b.mode() === 'published', 'published');
  assert.deepEqual(page.threads.filter(x => x.blyg_published).map(x => x.id), ['t0', 't1', 't2']);
  // a later comment: chained to the post above (the most recent), one comment only
  page.threads.push(thread('t3', 'Three passage.', 'Third thought.', { blyg: stamp() }));
  const next = b.start('t3', 'one');
  assert.ok(next.ok, next.error);
  await until(() => b.mode() === 'planned', 'planned again');
  assert.match(b.pub.current().note_text, /\n\nEarlier: \[Nothing to do with it\]\(https:\/\/site\.example\.test\/b\/nothing-to-do-with-it\)\n$/);
  assert.equal(b.pub.current().chained_to.title, 'Nothing to do with it');
});

// ---- one at a time, cancel -----------------------------------------------------------------
test('one run at a time for the whole companion: a second start is refused, not queued, at every unfinished mode', async t => {
  const rig = makeRig(); t.after(rig.done);
  rig.control({ plan: 'sleep' });
  const b = boot(rig);
  assert.ok(b.start().ok);
  await until(() => rig.calls().length === 1, 'plan started');
  assert.equal(b.mode(), 'planning');
  for (const id of ['t1']) { const r = b.start(id); assert.equal(r.ok, false); assert.equal(r.status, 409); assert.match(r.error, /already under way \(planning\)/); }
  assert.equal(rig.calls().length, 1, 'nothing was queued');
  b.pub.stopAll();
  await until(() => b.mode() === 'failed', 'killed plan fails');
  assert.equal(b.pub.current().failed_step, 'plan');
  assert.equal(b.start().status, 409, 'a failed run still blocks');
  assert.equal(fs.readdirSync(rig.folder).length, 1, 'and no second note was written');
});

test('cancel at the confirmation removes the draft only if this run made it and it is unchanged, and calls discard when one is set', async t => {
  const rig = makeRig({ discard: true }); t.after(rig.done);
  const b = boot(rig);
  b.start(); await until(() => b.mode() === 'planned', 'planned');
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
  b2.start(); await until(() => b2.mode() === 'planned', 'planned 2');
  v = b2.pub.current();
  fs.appendFileSync(noteOf(rig, v), '\nI edited this.\n');
  const c2 = await b2.pub.cancel({ id: v.id, token: v.token });
  assert.ok(c2.ok);
  assert.equal(fs.existsSync(noteOf(rig, v)), true, 'the owner\'s edit is not thrown away');
  assert.match(c2.view.cleanup.note, /changed after it was written/);
  assert.equal(c2.view.cleanup.removed, false);
});

test('Publish is refused out of order: confirm only from planned, with the right id and token, once', async t => {
  const rig = makeRig(); t.after(rig.done);
  const b = boot(rig);
  assert.equal((await b.pub.confirm({ id: 'x', token: 'y' })).status, 404, 'no run at all');
  b.start();
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
    b.start();
    if (stepName !== 'plan') { await until(() => b.mode() === 'planned', 'planned'); const v = b.pub.current(); await b.pub.confirm({ id: v.id, token: v.token }); }
    await until(() => b.mode() === 'failed', 'failed');
    const v = b.pub.current();
    assert.equal(v.failed_step, stepName);
    assert.match(v.failed_reason, new RegExp(`${stepName} exited with code 1`));
    const last = v.steps[v.steps.length - 1];
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
  b.start(); await until(() => b.mode() === 'failed', 'failed');
  let v = b.pub.current();
  assert.ok(fs.existsSync(noteOf(rig, v)));
  const a = await b.pub.abandon({ id: v.id, token: v.token });
  assert.ok(a.ok); assert.equal(b.mode(), 'abandoned');
  assert.equal(fs.existsSync(noteOf(rig, v)), false, 'a failed plan\'s draft is cleaned up');
  rig.control({ publish: 'fail' });
  const b2 = boot(rig);
  b2.start(); await until(() => b2.mode() === 'planned', 'planned');
  v = b2.pub.current();
  await b2.pub.confirm({ id: v.id, token: v.token });
  await until(() => b2.mode() === 'failed', 'failed at publish');
  v = b2.pub.current();
  const a2 = await b2.pub.abandon({ id: v.id, token: v.token });
  assert.ok(a2.ok);
  assert.ok(fs.existsSync(noteOf(rig, v)), 'after apply the note is left alone');
  assert.match(a2.view.cleanup.note, /publish command keeps its own record/);
  assert.match(a2.view.steps.at(-1).output, /--abandon/);
  assert.equal((await b2.pub.abandon({ id: v.id, token: v.token })).status, 409, 'once');
});

// ---- crash and restart ---------------------------------------------------------------------
test('a companion restart mid-run leaves a record that offers only "show what happened" and "abandon"', async t => {
  const rig = makeRig(); t.after(rig.done);
  for (const mode of ['planning', 'planned', 'applying', 'applied', 'publishing', 'failed']) {
    const file = path.join(rig.out, `crash-${mode}.json`);
    fs.writeFileSync(file, JSON.stringify({ mode, id: 'abc', token: 'tok', note_rel: '_notes/x.md', note_text: 'T', steps: [{ step: 'plan', exit: 0, output: 'seen' }], failed_step: 'apply', page_url: 'u', thread_ids: ['t1'] }));
    const pub = R.createPublisher({ file, readConfig: () => ({ blyg_home: rig.home }), readPage: () => null, savePage: () => {}, broadcast: () => {} });
    const v = pub.current();
    assert.equal(v.mode, 'interrupted', mode);
    assert.equal(v.interrupted_from, mode);
    assert.deepEqual(v.can, ['abandon']);
    assert.equal(v.steps[0].output, 'seen', 'what happened is still shown');
    assert.equal((await pub.confirm({ id: 'abc', token: 'tok' })).status, 409);
    assert.equal((await pub.retry({ id: 'abc', token: 'tok' })).status, 409);
    assert.equal((await pub.cancel({ id: 'abc', token: 'tok' })).status, 409);
    assert.equal(pub.start({ page: blygPage([thread('t1', 'q', 'w')]), threadId: 't1', scope: 'one' }).status, 409, 'and it blocks a new run');
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
    const r = b.start();
    assert.equal(r.ok, false, name); assert.equal(r.status, 409, name);
    assert.match(r.error, /not set up/, name);
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
  assert.ok(pub.start({ page, threadId: 't1', scope: 'one' }).ok);
  await until(() => pub.current().mode === 'planned', 'planned');
  const v = pub.current();
  cfg = { ...rig.home, commands: { ...rig.home.commands, publish: [process.execPath, FAKE, rig.log, rig.ctl, 'evil', '{note}'] } };
  await pub.confirm({ id: v.id, token: v.token });
  await until(() => pub.current().mode === 'failed', 'failed');
  assert.match(pub.current().failed_reason, /settings changed/);
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
  const r = b.start();
  assert.ok(r.ok, r.error);
  const v = r.view;
  assert.equal(v.note_rel, '_notes/first-thought-about-liveness-4.md', 'past a file, a symlink and a taken permalink');
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
    const r = b.start();
    assert.ok(r.ok, `${text}: ${r.error}`);
    assert.match(r.view.note_rel, /^_notes\/[a-z0-9]+(-[a-z0-9]+)*\.md$/, text);
    assert.equal(path.dirname(path.join(rig.top, r.view.note_rel)), rig.folder);
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
  assert.ok(b.start().ok);
  await until(() => b.mode() === 'planned', 'planned');
  assert.deepEqual(modes, ['drafted', 'preparing', 'planning', 'planned']);
  assert.deepEqual(rig.calls().map(c => c.step), ['prepare', 'plan']);
  const v = b.pub.current();
  assert.deepEqual(v.steps.map(s => [s.step, s.exit]), [['prepare', 0], ['plan', 0]]);
  assert.equal(rig.calls()[0].argv[3], v.note_rel, 'prepare gets {note} as one argument too');
  // Cancel: discard runs because prepare ran, and it is the owner's one undo for both
  const c = await b.pub.cancel({ id: v.id, token: v.token });
  assert.ok(c.ok);
  assert.deepEqual(rig.calls().map(x => x.step), ['prepare', 'plan', 'discard']);
  assert.equal(fs.existsSync(path.join(rig.top, v.note_rel)), false);
});

test('without a prepare command the run goes straight from drafted to planning, as before', async t => {
  const rig = makeRig(); t.after(rig.done);
  const b = boot(rig);
  const modes = [];
  b.events.push = e => { if (e.type === 'blyg-publish') modes.push(e.run.mode); return 0; };
  b.start(); await until(() => b.mode() === 'planned', 'planned');
  assert.deepEqual(modes, ['drafted', 'planning', 'planned']);
  assert.deepEqual(rig.calls().map(c => c.step), ['plan']);
});

test('prepare fails: failed(prepare) with its output, plan never runs, nothing retries by itself; the owner\'s click retries prepare only, then plan', async t => {
  const rig = makeRig({ prepare: true, discard: true }); t.after(rig.done);
  rig.control({ prepare: 'fail' });
  const b = boot(rig);
  b.start(); await until(() => b.mode() === 'failed', 'failed');
  let v = b.pub.current();
  assert.equal(v.failed_step, 'prepare');
  assert.match(v.failed_reason, /prepare exited with code 1/);
  assert.match(v.steps[0].output, /something broke/);
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
  b2.start(); await until(() => b2.mode() === 'failed', 'plan failed');
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
  b.start(); await until(() => b.mode() === 'failed', 'failed');
  const v = b.pub.current();
  const a = await b.pub.abandon({ id: v.id, token: v.token });
  assert.ok(a.ok);
  assert.deepEqual(rig.calls().map(c => c.step), ['prepare', 'discard']);
  assert.equal(fs.existsSync(path.join(rig.top, v.note_rel)), false);
});

test('a restart while preparing is interrupted like any other live mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-prep-'));
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, JSON.stringify({ mode: 'preparing', id: 'a', token: 't' }));
  assert.equal(new R.RunBook({ file }).mode, 'interrupted');
  fs.rmSync(dir, { recursive: true, force: true });
});
