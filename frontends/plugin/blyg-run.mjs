// blyg-run.mjs — one "Publish as blyg" run, from the owner's comment to a live post.
//
// THE MODES, named once, held in ONE field (`run.mode`), changed by ONE function
// (RunBook#move) that refuses a move RUN_MOVES does not list. Nothing else in
// this file, the routes or the drawer sets a mode, and no flag or timer stands in
// for one: what is in flight is the mode (`planning`, `applying`, `publishing`).
//
//   idle         no run (the field's value when nothing has been started)
//   drafted      the note file is written (and nothing else has happened)
//   preparing    the optional `prepare` command is running (stage the note, fetch what it quotes)
//   planning     the `plan` command is running
//   planned      the plan is in: with confirm 'always' the owner is looking at the note and the plan; with 'never' (the
//                default) the run moves on to applying at once
//   applying     the `apply` command is running (the owner clicked Publish)
//   applied      apply is done; `publish` is next (a moment, not a place to wait)
//   publishing   the `publish` command is running (this is the one that goes live)
//   published    done: recorded on the thread(s)
//   failed       a step failed (`failed_step` says which: prepare, plan, apply or publish); nothing is retried by itself
//   cancelled    the owner cancelled at the confirmation; the draft was taken away
//   abandoned    the owner gave the run up
//   interrupted  the companion stopped mid-run; the record offers "continue" (an interrupted apply or publish) and "abandon"
//
// ONE RUN AT A TIME for the whole companion: while any run is not finished a second
// request is REFUSED (never queued). A run survives a drawer reload (it lives here and
// in a file, not in the page) and a companion restart turns every unfinished run into
// `interrupted`, except a `failed` one (nothing of it was running; it keeps its retry and abandon).
//
// WHAT RUNS WHEN. Step A (start): write the note file inside the notes folder, run `plan`.
// No other file is touched and nothing leaves this machine. Step B: the owner sees the
// note and the plan. Step C (confirm, an explicit click carrying this run's token): `apply`,
// then `publish`, each reported with its captured output; a failure names the step, shows
// the output and stops; "try this step again" is another explicit click, never automatic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeJson, readJsonState } from './fsjson.mjs';
import { validateHome, fingerprint, minimalEnv, expandArgv, filenameFor, runCommand, runCheckSync, TIME_LIMITS_MS, STEPS } from './blyg-home.mjs';
import { renderShortNote, eligibleThread, isPublishedThread, slugOf, dayOf, newBlygId, SCOPES, LIMITS } from './blyg-note.mjs';

// ---- the modes ---------------------------------------------------------------------
export const RUN_MODES = Object.freeze(['idle', 'drafted', 'preparing', 'planning', 'planned', 'applying', 'applied', 'publishing',
  'published', 'failed', 'cancelled', 'abandoned', 'interrupted']);
/** Finished: a new run may start. `idle` is "nothing yet". */
export const RUN_FINISHED = Object.freeze(['idle', 'published', 'cancelled', 'abandoned']);
/** Not finished: a second run is refused. */
export const RUN_LIVE = Object.freeze(RUN_MODES.filter(m => !RUN_FINISHED.includes(m)));
export const RUN_MOVES = Object.freeze({
  idle: Object.freeze(['drafted']),
  // `prepare` is optional: a run with none goes straight from drafted to planning
  drafted: Object.freeze(['preparing', 'planning', 'cancelled', 'failed', 'interrupted']),
  preparing: Object.freeze(['planning', 'failed', 'interrupted']),
  planning: Object.freeze(['planned', 'failed', 'interrupted']),
  planned: Object.freeze(['applying', 'cancelled', 'interrupted']),
  applying: Object.freeze(['applied', 'failed', 'interrupted']),
  applied: Object.freeze(['publishing', 'failed', 'interrupted']),
  publishing: Object.freeze(['published', 'failed', 'interrupted']),
  // a failed step is tried again only by the owner's click, and only that step
  // (a restart leaves a failed run as it is: no step of it is running, and `failed_step` must survive for retry and for abandon)
  failed: Object.freeze(['preparing', 'planning', 'applying', 'publishing', 'abandoned']),
  // an interrupted apply or publish may be CONTINUED (the site's own command resumes by running the same step again): see CONTINUE_FOR
  interrupted: Object.freeze(['applying', 'publishing', 'abandoned']),
  published: Object.freeze(['drafted']),
  cancelled: Object.freeze(['drafted']),
  abandoned: Object.freeze(['drafted']),
});
/** Which move re-runs which failed step. */
export const RETRY_FOR = Object.freeze({ prepare: 'preparing', plan: 'planning', apply: 'applying', publish: 'publishing' });
/** Which move carries on an interrupted step (by the mode it was interrupted in): only apply and publish, which the site's command resumes. */
export const CONTINUE_FOR = Object.freeze({ applying: 'applying', applied: 'publishing', publishing: 'publishing' });
/** The modes before apply: nothing here has touched the site's published state. */
export const PRE_APPLY_MODES = Object.freeze(['drafted', 'preparing', 'planning', 'planned']);
/** The modes in which a command of ours is running right now. */
export const RUNNING_MODES = Object.freeze(['preparing', 'planning', 'applying', 'publishing']);
/** Unfinished modes a companion restart does NOT turn into `interrupted`: nothing of the run is in flight and the owner acts next. */
export const RESTART_KEEPS = Object.freeze(['failed', 'interrupted']);
export class IllegalMove extends Error {}
// has this run not reached apply? (derived from the one mode field and the step that failed or was interrupted)
export const beforeApply = run => (run.mode === 'failed' ? ['prepare', 'plan'].includes(run.failed_step)
  : run.mode === 'interrupted' ? PRE_APPLY_MODES.includes(run.interrupted_from) : PRE_APPLY_MODES.includes(run.mode));
// have prepare or plan begun (so a `discard` has something to undo)? never in `drafted`
const workBegun = run => !(run.mode === 'drafted' || (run.mode === 'interrupted' && run.interrupted_from === 'drafted'));
/** Is this move allowed for this record? (the table, plus the one guard on a retry) */
export function canMove(from, to, run = {}) {
  if (!RUN_MOVES[from] || !RUN_MOVES[from].includes(to)) return false;
  if (from === 'failed' && to !== 'abandoned') return RETRY_FOR[run.failed_step] === to;
  if (from === 'interrupted' && to !== 'abandoned') return CONTINUE_FOR[run.interrupted_from] === to;
  return true;
}

/** What the owner may do in a mode (the drawer draws buttons from this; the routes enforce it by the table). */
export const actionsOf = run => (run.mode === 'planned' ? ['confirm', 'cancel'] : run.mode === 'failed' ? ['retry', 'abandon']
  : run.mode === 'interrupted' ? (CONTINUE_FOR[run.interrupted_from] ? ['continue', 'abandon'] : ['abandon']) : []);

const nowIso = () => new Date().toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The one holder of the mode. `file` is where the record is kept (so a restart finds it).
 * `onChange(record)` is called after every move.
 */
export class RunBook {
  constructor({ file, onChange = () => {}, now = nowIso } = {}) {
    this.file = file;
    this.onChange = onChange;
    this.now = now;
    this.run = { mode: 'idle' };
    this.load();
  }
  get mode() { return this.run.mode; }
  /** Read the record; a run that was unfinished when the companion stopped becomes `interrupted` (unless RESTART_KEEPS its mode). */
  load() {
    const got = this.file ? readJsonState(this.file) : { state: 'missing' };
    if (got.state !== 'ok' || !got.value || !RUN_MODES.includes(got.value.mode)) return;
    this.run = got.value;
    if (RUN_LIVE.includes(this.run.mode) && !RESTART_KEEPS.includes(this.run.mode)) {
      this.move('interrupted', { interrupted_from: this.run.mode, interrupted_why: 'the companion stopped while this run was under way' });
    }
  }
  /** THE ONE FUNCTION THAT CHANGES THE MODE. */
  move(to, facts = {}) {
    if (!RUN_MODES.includes(to)) throw new Error(`publish run: no such mode ${String(to).slice(0, 30)}`);
    const from = this.run.mode;
    if (!canMove(from, to, this.run)) throw new IllegalMove(`publish run: cannot go from ${from} to ${to}`);
    const base = RUN_FINISHED.includes(from) ? {} : this.run;
    this.run = { ...base, ...facts, mode: to, at: this.now() };
    if (to !== 'failed') { delete this.run.failed_step; delete this.run.failed_reason; }
    this.persist();
    this.onChange(this.run);
    return this.run;
  }
  /** Write the record as it is (facts about a running step: not a change of mode). */
  persist() { if (this.file) writeJson(this.file, this.run, { mode: 0o600 }); }
}

// ---- a step's process, across a companion restart ----------------------------------------------------------------
// The record keeps the process group of the step that is running (`child: { pgid, lstart }`), so that after a restart the owner is never
// offered a second copy of a step whose first copy is still going. `lstart` is the process's start time as `ps` says (when ps can be run).
const lstartOf = pid => { try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
export function childAlive(child) {
  if (!child || !Number.isInteger(child.pgid) || child.pgid <= 1) return false;
  try { process.kill(-child.pgid, 0); } catch (e) { if (!(e && e.code === 'EPERM')) return false; }
  if (child.lstart) { const now = lstartOf(child.pgid); if (now && now !== child.lstart) return false; }   // the number now belongs to another process
  return true;
}
const stopGroup = async child => {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pgid, sig); } catch { return true; }
    for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); if (!childAlive(child)) return true; }
  }
  return !childAlive(child);
};

// ---- the owner's view of a run -----------------------------------------------------
/** What an owner client may see: the record with the work tree's absolute path kept out, plus what it may do. */
export function viewOf(run) {
  if (!run || run.mode === 'idle') return { mode: 'idle', can: [] };
  const v = {
    id: run.id, token: run.token, mode: run.mode, confirm: run.confirm || 'always', at: run.at, scope: run.scope, title: run.title, permalink: run.permalink,
    note_rel: run.note_rel, note_text: run.note_text, thread_ids: run.thread_ids, page_url: run.page_url,
    steps: (run.steps || []).map(s => ({ step: s.step, exit: s.exit, signal: s.signal, timed_out: s.timed_out, spawn_error: s.spawn_error, ms: s.ms, truncated: s.truncated, output: s.output, at: s.at })),
    failed_step: run.failed_step || '', failed_reason: run.failed_reason || '',
    interrupted_from: run.interrupted_from || '', interrupted_why: run.interrupted_why || '',
    published: run.published || null, cleanup: run.cleanup || null, chained_to: run.chained_to || null,
    can: actionsOf(run),
  };
  return v;
}

/** The address a publish command printed for this post: a URL whose path is the post's permalink. */
export function addressFrom(output, permalink) {
  if (!permalink || !permalink.startsWith('/')) return '';
  const want = permalink.replace(/\/+$/, '');
  for (const m of String(output || '').matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    try {
      const u = new URL(m[0].replace(/[.,;:]+$/, ''));
      if (u.username || u.password) continue;
      if (u.pathname.replace(/\/+$/, '') === want) { u.hash = ''; u.search = ''; return u.href.slice(0, 500); }
    } catch { /* not a url */ }
  }
  return '';
}

// ---- the publisher -------------------------------------------------------------------
const notesIn = folder => { try { return fs.readdirSync(folder).filter(n => n.endsWith('.md')).slice(0, 5000); } catch { return []; } };
function permalinksIn(folder) {
  const seen = new Set();
  for (const n of notesIn(folder)) {
    try {
      const fd = fs.openSync(path.join(folder, n), 'r');
      const buf = Buffer.alloc(8192);
      const k = fs.readSync(fd, buf, 0, 8192, 0); fs.closeSync(fd);
      const head = buf.slice(0, k).toString('utf8');
      if (!head.startsWith('---')) continue;
      const fm = head.split(/\n---\s*\n/)[0];
      const m = /^permalink:\s*["']?([^\s"']+)["']?\s*$/m.exec(fm);
      if (m) seen.add(m[1].replace(/\/+$/, ''));
      const bid = /^blyg_id:\s*["']?([^\s"']+)["']?\s*$/m.exec(fm);
      if (bid) seen.add(`id:${bid[1]}`);   // an id another note already declares
    } catch { /* unreadable: not a note we can compare */ }
  }
  return seen;
}

/**
 * `deps`: { file (run record), readConfig(), readPage(url), savePage(page), broadcast(ev), now(), hook ({beforeWrite, beforeUnlink}: tests only),
 *           exec (default runCommand), env (default process.env) }
 */
export function createPublisher(deps) {
  const book = new RunBook({
    file: deps.file, now: deps.now ? () => deps.now().toISOString() : nowIso,
    onChange: run => { try { deps.broadcast({ type: 'blyg-publish', run: { id: run.id, mode: run.mode } }); } catch { /* nobody listening */ } },
  });
  const exec = deps.exec || runCommand;
  const env = deps.env || process.env;
  const clock = () => (deps.now ? deps.now() : new Date());
  let live = null;         // the running step as far as a client needs to see it: { step, started, last }
  let stopHandle = null;   // how to stop the command that is running (meaningful only in RUNNING_MODES)

  const settingsNow = () => validateHome(deps.readConfig().blyg_home, { env });
  const fail = (status, error) => ({ ok: false, status, error });

  // THE RECORD ON DISK IS NOT TRUSTED. A live run's note must still be a file INSIDE the configured notes folder (real path) with the
  // hash this run wrote it with; otherwise nothing runs with its path and nothing deletes it: the run offers only "abandon".
  function taintOf(run) {
    if (!run || RUN_FINISHED.includes(run.mode)) return '';
    const home = settingsNow();
    if (!home.ok) return '';
    const rel = run.note_rel;
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return 'This run\'s record names a note path that is not a path inside the notes folder, so nothing will be run or removed with it.';
    let real = '';
    try { real = fs.realpathSync(path.join(home.settings.top, rel)); } catch { return 'The note this run was started with is gone, so it cannot be carried on.'; }
    if (!(real === home.settings.folder || real.startsWith(home.settings.folder + path.sep))) return 'This run\'s record names a note outside the notes folder, so nothing will be run or removed with it.';
    let text = '';
    try { text = fs.readFileSync(real, 'utf8'); } catch { return 'The note this run was started with cannot be read, so it cannot be carried on.'; }
    if (sha(text) !== run.note_sha) return 'The note has changed since this run wrote it, so what you were shown is not what would be published.';
    return '';
  }

  /** Run one step; record it; → the step record. Re-checks the settings first and refuses if they changed. */
  async function step(name, extra = {}) {
    const run = book.run;
    const home = settingsNow();
    const tainted = taintOf(run);
    if (tainted) return { ok: false, record: { step: name, exit: null, spawn_error: 'TAINTED', output: tainted, at: nowIso() }, reason: tainted };
    if (!home.ok) return { ok: false, record: { step: name, exit: null, spawn_error: 'SETTINGS', output: home.errors.join('\n'), at: nowIso() }, reason: `the settings no longer pass: ${home.errors[0]}` };
    if (fingerprint(home.settings) !== run.settings_fp) {
      return { ok: false, record: { step: name, exit: null, spawn_error: 'SETTINGS', output: 'The “Where my blyg lives” settings changed after this run started.', at: nowIso() }, reason: 'the settings changed after this run started' };
    }
    const argvRaw = home.settings.commands[name];
    if (!argvRaw) return { ok: true, record: null, skipped: true };
    const abs = path.join(home.settings.top, run.note_rel);
    // the guard rides on plan, apply and publish, every time they run (retries and resumes too), when nobody is looking
    const guard = ['plan', 'apply', 'publish'].includes(name) && home.settings.confirm === 'never' ? home.settings.plan_guard : [];
    const argv = [...expandArgv(argvRaw, { rel: run.note_rel, abs }), ...guard];
    const at = nowIso();
    live = { step: name, started: Date.now(), last: '' };
    const r = await exec({ argv, cwd: home.settings.top, env: minimalEnv(home.settings.env_pass, env), limitMs: TIME_LIMITS_MS[name], onLine: l => { if (live) live.last = l; }, onChild: (stop, pid) => { stopHandle = stop; if (pid) { book.run.child = { pgid: pid, lstart: lstartOf(pid), at: nowIso() }; book.persist(); } }, ...extra });
    live = null;
    if (book.run.child) { delete book.run.child; book.persist(); }
    const record = { step: name, exit: r.exit, signal: r.signal || '', timed_out: !!r.timedOut, spawn_error: r.spawnError || '', ms: r.ms, truncated: !!r.truncated, output: r.output, at };
    let ok = r.exit === 0 && !r.timedOut && !r.signal && !r.spawnError;
    // a publish that exits 0 is a publish only when its LAST `State:` line is the site command's done marker (when one is set)
    let unfinished = '';
    if (ok && name === 'publish' && home.settings.published_marker) {
      const last = (r.output.split('\n').filter(l => /^State:/.test(l)).pop() || '').trim();
      if (last !== home.settings.published_marker) { ok = false; unfinished = last || 'no State line'; }
    }
    const reason = unfinished ? `publish exited 0 but did not finish (it ended at “${unfinished}”, not “${home.settings.published_marker}”): nothing was published` : r.timedOut ? `${name} did not finish within ${Math.round(TIME_LIMITS_MS[name] / 1000)} seconds and was stopped`
      : r.spawnError ? `${name} could not be started (${r.spawnError})` : r.signal ? `${name} was stopped by ${r.signal}` : `${name} exited with code ${r.exit}`;
    return { ok, record, reason };
  }
  const pushStep = rec => { if (rec) book.run.steps = [...(book.run.steps || []), rec]; };

  // ---- Step A --------------------------------------------------------------------
  // Step A: the optional prepare, then plan. Each is a step with its own mode; a failure stops there (failed_step names it).
  async function runPlan() {
    const home = settingsNow();
    // prepare runs when the run has just been drafted or when prepare itself is what failed; a retried plan does not repeat it
    if (home.ok && home.settings.commands.prepare && (book.mode === 'drafted' || book.run.failed_step === 'prepare')) {
      book.move('preparing');
      const p = await step('prepare');
      pushStep(p.record);
      if (!p.ok) return book.move('failed', { failed_step: 'prepare', failed_reason: p.reason, steps: book.run.steps });
    }
    book.move('planning');
    const s = await step('plan');
    pushStep(s.record);
    if (!s.ok) return book.move('failed', { failed_step: 'plan', failed_reason: s.reason, steps: book.run.steps });
    book.move('planned', { steps: book.run.steps });
    // confirm: 'never' — choosing Publish as blyg was the publish: carry straight on (apply, then publish)
    if (book.run.confirm === 'never') return runFrom('apply');
    return book.run;
  }

  /**
   * Start a run: → { ok, view } | { ok: false, status, error }. Writes the note file (the one side effect
   * outside the run's own record) and begins `plan` in the background.
   */
  function start({ page, threadId, scope, shown }) {
    if (RUN_LIVE.includes(book.mode)) return fail(409, `a publish run is already under way (${book.mode}); finish or abandon it first`);
    if (!SCOPES.includes(scope)) return fail(400, `scope must be one of ${SCOPES.join(', ')}`);
    const home = settingsNow();
    if (!home.ok) return fail(409, `Publish as blyg is not set up: ${home.errors[0]}. Set “Where my blyg lives” on the companion first.`);
    const S = home.settings;
    // THE PRE-FLIGHT, before anything is written: a broken environment fails here, in about a second, with the check's own sentence
    if (S.commands.check) {
      const c = (deps.check || runCheckSync)({ argv: S.commands.check, cwd: S.top, env: minimalEnv(S.env_pass, env) });
      if (!c.ok) return fail(409, `Publish as blyg cannot start: ${c.message}`);
    }
    // the owner was shown one setting's wording; if the one in force is another, nothing starts (a stale drawer must not promise a look
    // first when one click publishes, or the reverse)
    if (shown !== S.confirm) return fail(409, `The setting changed: your drawer showed “${String(shown || 'nothing').slice(0, 12)}” but “${S.confirm}” is in force (${S.confirm === 'never' ? 'one click publishes' : 'you will see the note first'}). Nothing was started. Open the menu again.`);
    const threads = page.threads || [];
    const at = threads.findIndex(t => t && t.id === threadId);
    if (at < 0) return fail(404, 'unknown comment');
    const here = threads[at];
    const el = eligibleThread(here);
    if (!el.ok) return fail(409, el.why);
    if (isPublishedThread(here)) return fail(409, 'that comment is already published as a blyg; publishing it again as an edit is not available yet');
    const picked = scope === 'one' ? [here]
      : [...threads.slice(0, at).filter(t => eligibleThread(t).ok && !isPublishedThread(t)), here];
    if (picked.length > LIMITS.comments) return fail(409, `at most ${LIMITS.comments} comments can go in one post`);
    // the chain: only for one comment, and only when an earlier post from this page is on the record
    let earlier = null;
    if (scope === 'one') {
      const prev = threads.filter(t => isPublishedThread(t) && t !== here).map(t => t.blyg_published)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
      if (prev && prev.title && (prev.address || prev.permalink)) earlier = { title: prev.title, link: prev.address || prev.permalink };
    }
    const now = clock();
    const date = dayOf(now, S.timezone);
    // a name nobody else has: no file of that name, no note with that permalink
    const taken = permalinksIn(S.folder);
    const first = renderShortNote({ page, threads: picked, home: S, now, slug: 'x', earlier });
    if (!first.ok) return fail(409, first.error);
    const base = slugOf(first.title, { date });
    let rendered = null;
    let name = '';
    let slug = base;
    for (let n = 0; n < 60 && !rendered; n++) {
      const trySlug = n ? `${base.slice(0, LIMITS.slugChars - 4)}-${n + 1}` : base;
      const id = newBlygId();   // the address is made of it; the FILE keeps the first-words slug
      const r = renderShortNote({ page, threads: picked, home: S, now, slug: trySlug, id, earlier });
      if (!r.ok) return fail(409, r.error);
      let fileName;
      try { fileName = filenameFor(S.filename, { slug: trySlug, date }); } catch (e) { return fail(409, e.message); }
      let exists = false;
      try { fs.lstatSync(path.join(S.folder, fileName)); exists = true; } catch { /* free */ }
      const clash = exists || taken.has(`id:${id}`) || (r.permalink && taken.has(r.permalink.replace(/\/+$/, '')));
      if (!clash) { rendered = r; name = fileName; slug = trySlug; }
    }
    if (!rendered) return fail(409, 'could not find a free name for this note');
    // the file: inside the folder (real path), never over anything, never through a link
    const target = path.join(S.folder, name);
    if (deps.hook && deps.hook.beforeWrite) deps.hook.beforeWrite(target);   // (tests only: a race between the name being chosen and the file being written)
    const realParent = fs.realpathSync(path.dirname(target));
    if (realParent !== S.folder || path.dirname(target) !== S.folder) return fail(409, 'the note would land outside the notes folder');
    const rel = path.relative(S.top, target).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || rel.startsWith('-') || path.isAbsolute(rel)) return fail(409, 'the note’s path is not one a command can be given');
    try {
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644);
      try { fs.writeSync(fd, rendered.text); } finally { fs.closeSync(fd); }
    } catch (e) { return fail(409, e && e.code === 'EEXIST' ? 'a note of that name appeared meanwhile; try again' : `could not write the note: ${e && e.message}`); }
    const run = book.move('drafted', {
      id: crypto.randomBytes(8).toString('hex'), token: crypto.randomBytes(16).toString('hex'),
      page_url: page.url, thread_ids: picked.map(t => t.id), scope, title: rendered.title, slug, permalink: rendered.permalink,
      note_rel: rel, note_text: rendered.text, note_sha: sha(rendered.text), settings_fp: fingerprint(S), confirm: S.confirm, steps: [],
      chained_to: earlier ? { title: earlier.title } : null, day: date,
    });
    // Step A's second half runs in the background; its end is announced by the mode
    runPlan().catch(e => { try { book.move('failed', { failed_step: book.mode === 'preparing' ? 'prepare' : 'plan', failed_reason: String((e && e.message) || e).slice(0, 200) }); } catch { /* already moved */ } });
    return { ok: true, view: viewOf(run) };
  }

  // ---- Step C --------------------------------------------------------------------
  async function runFrom(first) {
    try {
      if (first === 'apply') {
        book.move('applying');
        const a = await step('apply');
        pushStep(a.record);
        if (!a.ok) return book.move('failed', { failed_step: 'apply', failed_reason: a.reason, steps: book.run.steps });
        book.move('applied', { steps: book.run.steps });
      }
      book.move('publishing');
      const p = await step('publish');
      pushStep(p.record);
      if (!p.ok) return book.move('failed', { failed_step: 'publish', failed_reason: p.reason, steps: book.run.steps });
      return finish(p.record ? p.record.output : '');
    } catch (e) {
      if (!RUN_FINISHED.includes(book.mode) && book.mode !== 'interrupted') {
        try { book.move('failed', { failed_step: book.mode === 'applying' ? 'apply' : 'publish', failed_reason: String((e && e.message) || e).slice(0, 200) }); } catch { /* moved already */ }
      }
      return book.run;
    }
  }
  /** published: record it on every thread that went in, so it is never offered again. */
  function finish(output) {
    const run = book.run;
    const address = addressFrom(output, run.permalink);
    const published = { at: clock().toISOString(), title: run.title, permalink: run.permalink || '', ...(address ? { address } : {}) };
    try {
      const page = deps.readPage(run.page_url);
      if (page) {
        for (const t of page.threads || []) if (run.thread_ids.includes(t.id)) t.blyg_published = { ...published };
        deps.savePage(page);
        deps.broadcast({ type: 'page', url: page.url });
      }
    } catch (e) { published.record_error = 'the post is live but this page could not be marked as published'; }
    return book.move('published', { published, steps: book.run.steps });
  }

  function owned(id, token) {
    const r = book.run;
    if (!r.id || r.id !== id || !token || typeof token !== 'string' || token.length !== r.token.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.token))) return fail(404, 'no such publish run');
    return null;
  }

  /** The owner's "Publish": Step C. */
  function confirm({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    { const t = taintOf(book.run); if (t) return fail(409, t); }
    if (book.mode !== 'planned') return fail(409, `this run is ${book.mode}; only a run waiting on the plan can be published`);
    runFrom('apply');
    return { ok: true, view: viewOf(book.run) };
  }
  /** Carry on an interrupted apply or publish (the owner's click): the same step again, which is how the site's command resumes. */
  async function carryOn({ id, token, stop = false }) {
    const bad = owned(id, token); if (bad) return bad;
    { const t = taintOf(book.run); if (t) return fail(409, t); }
    const to = book.mode === 'interrupted' ? CONTINUE_FOR[book.run.interrupted_from] : '';
    if (!to || !canMove('interrupted', to, book.run)) return fail(409, 'only an interrupted apply or publish can be carried on; abandon this run instead');
    // never two copies of a step: the earlier one may have outlived the companion
    if (childAlive(book.run.child)) {
      if (!stop) return fail(409, 'The earlier step is still running (process group ' + book.run.child.pgid + '). Wait for it, or choose to stop it and carry on.');
      if (!await stopGroup(book.run.child)) return fail(409, 'The earlier step would not stop; nothing was started.');
      delete book.run.child; book.persist();
    }
    if (!canMove(book.mode, to, book.run)) return fail(409, 'the run moved on meanwhile');
    runFrom(to === 'applying' ? 'apply' : 'publish');
    return { ok: true, view: viewOf(book.run) };
  }
  /** Try the failed step again (the owner's click). */
  function retry({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    { const t = taintOf(book.run); if (t) return fail(409, t); }
    const to = book.mode === 'failed' ? RETRY_FOR[book.run.failed_step] : '';
    if (!to || !canMove('failed', to, book.run)) return fail(409, 'there is no failed step to try again');
    if (to === 'planning' || to === 'preparing') runPlan().catch(() => {});
    else runFrom(to === 'applying' ? 'apply' : 'publish');
    return { ok: true, view: viewOf(book.run) };
  }

  /** Take the draft away, but only the file this run made and only if it is as it was written. → the cleanup record. */
  async function undraft() {
    const run = book.run;
    const out = { removed: false, discard: '', note: '' };
    { const t = taintOf(run); if (t) { out.note = t + ' The note was left where it is.'; return out; } }
    const home = settingsNow();
    if (!home.ok || fingerprint(home.settings) !== run.settings_fp) { out.note = 'the settings changed, so the draft was left where it is'; return out; }
    const S = home.settings;
    const abs = path.join(S.top, run.note_rel);
    let text = null;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { out.note = 'the note file is already gone'; return out; }
    if (sha(text) !== run.note_sha) { out.note = 'the note was changed after it was written, so it was left where it is'; return out; }
    if (S.commands.discard && workBegun(run)) {
      const d = await step('discard');
      out.discard = d.record ? d.record.output : '';
      if (!d.ok) { out.note = `the discard command failed (${d.reason}); the note was left where it is`; return out; }
    }
    if (deps.hook && deps.hook.beforeUnlink) deps.hook.beforeUnlink(abs);   // (tests only: the note changes after the first check)
    try {
      if (fs.existsSync(abs)) {
        if (fs.lstatSync(abs).isSymbolicLink() || sha(fs.readFileSync(abs, 'utf8')) !== run.note_sha) { out.note = 'the note was changed, so it was left where it is'; return out; }
        fs.unlinkSync(abs);
      }
      out.removed = true;
    } catch (e) { out.note = `could not remove the note: ${e && e.message}`; }
    return out;
  }

  /** Cancel at the confirmation: the draft goes (if it is this run's and unchanged); the run ends. */
  async function cancel({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    if (!canMove(book.mode, 'cancelled', book.run)) return fail(409, `this run is ${book.mode}; it can be cancelled only while it waits for your answer`);
    const cleanup = await undraft();
    if (!canMove(book.mode, 'cancelled', book.run)) return fail(409, 'the run moved on meanwhile');
    book.move('cancelled', { cleanup });
    return { ok: true, view: viewOf(book.run) };
  }
  /** Give the run up. Before apply started, the draft is taken away too; after, nothing is touched. */
  async function abandon({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    if (!canMove(book.mode, 'abandoned', book.run)) return fail(409, `this run is ${book.mode}; only a failed or interrupted run can be abandoned`);
    let cleanup;
    const tainted = taintOf(book.run);
    if (tainted) cleanup = { removed: false, discard: '', note: tainted + ' Nothing was run or removed.' };
    else if (beforeApply(book.run)) cleanup = await undraft();
    else {
      // after apply the site's command has its own record of this run: the owner's `abandon` command (when set) ends it, so no state needs editing by hand
      cleanup = { removed: false, discard: '', note: 'the note was left where it is: the publish command keeps its own record of this run, and its output on this page says how to finish it or give it up' };
      const home = settingsNow();
      if (home.ok && home.settings.commands.abandon && fingerprint(home.settings) === book.run.settings_fp) {
        const a = await step('abandon');
        if (!a.ok) return fail(409, `the abandon command failed (${a.reason}): ${String(a.record && a.record.output || '').slice(-400)}`);
        cleanup = { ...cleanup, abandon: a.record ? a.record.output : '', note: 'the publish command\'s own abandon was run; the note was left where it is' };
      }
    }
    if (!canMove(book.mode, 'abandoned', book.run)) return fail(409, 'the run moved on meanwhile');
    book.move('abandoned', { cleanup });
    return { ok: true, view: viewOf(book.run) };
  }
  /** The owner client resumes: the current run (a client that reloaded asks this). */
  function current() {
    const v = viewOf(book.run);
    // while a step runs: which one, how long, and the last line it printed (owner only, like everything here)
    if (live && RUNNING_MODES.includes(book.mode)) v.running = { step: live.step, elapsed_ms: Date.now() - live.started, last_line: live.last };
    const taint = taintOf(book.run);
    if (taint) { v.can = ['abandon']; v.tainted = taint; }
    else if (book.mode === 'interrupted' && childAlive(book.run.child)) { v.can = v.can.map(a => (a === 'continue' ? 'stop-and-continue' : a)); v.earlier_step_running = true; }
    if (!v.confirm || v.mode === 'idle') { const h = settingsNow(); v.confirm = h.ok ? h.settings.confirm : 'always'; }   // an idle view says which setting is in force
    return v;
  }
  /** Stop whatever is running (the companion is shutting down). */
  function stopAll() { if (RUNNING_MODES.includes(book.mode) && stopHandle) { try { stopHandle(); } catch { /* gone */ } } }

  return { book, start, confirm, retry, carryOn, cancel, abandon, current, stopAll, STEPS };
}
