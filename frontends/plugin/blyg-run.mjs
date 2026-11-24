// blyg-run.mjs — one "Publish as blyg" run, from the owner's comment to a live post.
//
// THE MODES, named once, held in ONE field (`run.mode`), changed by ONE function
// (RunBook#move) that refuses a move RUN_MOVES does not list. Nothing else in
// this file, the routes or the drawer sets a mode, and no flag or timer stands in
// for one: what is in flight is the mode (`planning`, `applying`, `publishing`), and
// WHICH step failed or was interrupted is part of the mode's name (one field says it all).
//
//   idle                 no run (the field's value when nothing has been started)
//   checking             a start is running the owner's pre-flight `check` (asynchronously); NOTHING is written yet. It holds the
//                        companion's one run, so a second start is refused meanwhile; a refused check, or a restart, goes back to idle
//   drafted              the note file is written (and nothing else has happened)
//   preparing            the optional `prepare` command is running (stage the note, fetch what it quotes)
//   planning             the `plan` command is running
//   planned              the plan is in: with confirm 'always' the owner is looking at the note and the plan; with 'never' (the
//                        default) the run moves on to applying at once
//   applying             the `apply` command is running
//   applied              apply is done; `publish` is next (a moment, not a place to wait)
//   publishing           the `publish` command is running (this is the one that goes live)
//   published            done: recorded on the thread(s)
//   failed_prepare | failed_plan | failed_apply | failed_publish
//                        that step failed; nothing is retried by itself (the owner may retry THAT step, or abandon)
//   cancelled            the owner cancelled at the confirmation; the draft was taken away
//   abandoned            the owner gave the run up (or, when the site's own abandon could not, told the companion to forget it)
//   interrupted_<mode>   the companion stopped while the run was in <mode> (drafted, preparing, planning, planned, applying,
//                        applied, publishing); an interrupted apply or publish may be continued, any may be abandoned
//   interrupted_unknown  a record from an older companion whose interrupted step is not known: only abandon (as after apply)
//   abandon_failed       the owner abandoned a run past apply and the SITE's own abandon command failed (for example: its run was
//                        already ended by hand). The owner may try abandon again, or FORGET the run here: a move to `abandoned`
//                        that runs nothing on the site and says plainly what the site may still hold.
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
import { validateHome, fingerprint, minimalEnv, expandArgv, filenameFor, runCommand, runCheck, TIME_LIMITS_MS, STEPS } from './blyg-home.mjs';
import { renderShortNote, eligibleThread, isPublishedThread, slugOf, dayOf, newBlygId, showsLiquid, SCOPES, LIMITS } from './blyg-note.mjs';

// ---- the modes ---------------------------------------------------------------------
/** The modes in which a command of ours is running right now, and the step each one runs. */
export const STEP_OF = Object.freeze({ preparing: 'prepare', planning: 'plan', applying: 'apply', publishing: 'publish' });
export const RUNNING_MODES = Object.freeze(Object.keys(STEP_OF));
/** A failed step's mode, by step. */
export const FAILED_OF = Object.freeze({ prepare: 'failed_prepare', plan: 'failed_plan', apply: 'failed_apply', publish: 'failed_publish' });
export const FAILED_MODES = Object.freeze(Object.values(FAILED_OF));
/** The modes a companion restart interrupts, and the mode each becomes. */
export const INTERRUPTED_OF = Object.freeze({ drafted: 'interrupted_drafted', preparing: 'interrupted_preparing', planning: 'interrupted_planning',
  planned: 'interrupted_planned', applying: 'interrupted_applying', applied: 'interrupted_applied', publishing: 'interrupted_publishing' });
export const INTERRUPTED_MODES = Object.freeze([...Object.values(INTERRUPTED_OF), 'interrupted_unknown']);
export const RUN_MODES = Object.freeze(['idle', 'checking', 'drafted', 'preparing', 'planning', 'planned', 'applying', 'applied', 'publishing',
  'published', ...FAILED_MODES, 'cancelled', 'abandoned', ...INTERRUPTED_MODES, 'abandon_failed']);
/** Finished: a new run may start. `idle` is "nothing yet". */
export const RUN_FINISHED = Object.freeze(['idle', 'published', 'cancelled', 'abandoned']);
/** Not finished: a second run is refused. */
export const RUN_LIVE = Object.freeze(RUN_MODES.filter(m => !RUN_FINISHED.includes(m)));
/** Which move re-runs a failed step (the owner's click). */
export const RETRY_FOR = Object.freeze({ failed_prepare: 'preparing', failed_plan: 'planning', failed_apply: 'applying', failed_publish: 'publishing' });
/** Which move carries on an interrupted step: only apply and publish, which the site's command resumes by running the same step again. */
export const CONTINUE_FOR = Object.freeze({ interrupted_applying: 'applying', interrupted_applied: 'publishing', interrupted_publishing: 'publishing' });
const I = INTERRUPTED_OF;
export const RUN_MOVES = Object.freeze({
  idle: Object.freeze(['checking', 'drafted']),
  // the pre-flight passed (the note is written: drafted), or it refused / the start stopped before writing (idle)
  checking: Object.freeze(['drafted', 'idle']),
  // `prepare` is optional: a run with none goes straight from drafted to planning
  drafted: Object.freeze(['preparing', 'planning', 'cancelled', 'failed_plan', I.drafted]),
  preparing: Object.freeze(['planning', 'failed_prepare', I.preparing]),
  planning: Object.freeze(['planned', 'failed_plan', I.planning]),
  planned: Object.freeze(['applying', 'cancelled', I.planned]),
  applying: Object.freeze(['applied', 'failed_apply', I.applying]),
  applied: Object.freeze(['publishing', 'failed_publish', I.applied]),
  publishing: Object.freeze(['published', 'failed_publish', I.publishing]),
  // a failed step is tried again only by the owner's click, and only that step (a restart leaves a failed run as it is)
  // (… → abandon_failed only from a mode past apply: before apply abandon runs no site command)
  failed_prepare: Object.freeze(['preparing', 'abandoned']),
  failed_plan: Object.freeze(['planning', 'abandoned']),
  failed_apply: Object.freeze(['applying', 'abandoned', 'abandon_failed']),
  failed_publish: Object.freeze(['publishing', 'abandoned', 'abandon_failed']),
  interrupted_drafted: Object.freeze(['abandoned']),
  interrupted_preparing: Object.freeze(['abandoned']),
  interrupted_planning: Object.freeze(['abandoned']),
  interrupted_planned: Object.freeze(['abandoned']),
  interrupted_applying: Object.freeze(['applying', 'abandoned', 'abandon_failed']),
  interrupted_applied: Object.freeze(['publishing', 'abandoned', 'abandon_failed']),
  interrupted_publishing: Object.freeze(['publishing', 'abandoned', 'abandon_failed']),
  interrupted_unknown: Object.freeze(['abandoned', 'abandon_failed']),
  // the site's abandon failed: try it again (abandoned, or abandon_failed again) or FORGET here (abandoned)
  abandon_failed: Object.freeze(['abandoned', 'abandon_failed']),
  published: Object.freeze(['checking', 'drafted']),
  cancelled: Object.freeze(['checking', 'drafted']),
  abandoned: Object.freeze(['checking', 'drafted']),
});
/** The modes in which nothing has touched the site's published state yet (abandon takes the draft away). */
export const PRE_APPLY_MODES = Object.freeze(['drafted', 'preparing', 'planning', 'planned', 'failed_prepare', 'failed_plan',
  I.drafted, I.preparing, I.planning, I.planned]);
/** The modes in which the site certainly published nothing: before apply, or apply itself failed (it works in a temporary copy, and
 *  only publish pushes). A failed or interrupted PUBLISH may have pushed, so it is not one of these. */
export const NOTHING_PUBLISHED_MODES = Object.freeze([...PRE_APPLY_MODES, 'failed_apply']);
/** The modes in which no prepare or plan has begun (so a `discard` has nothing to undo). */
export const NOTHING_BEGUN_MODES = Object.freeze(['drafted', I.drafted]);
export class IllegalMove extends Error {}
export const beforeApply = run => PRE_APPLY_MODES.includes(run.mode);
export const publishedNothing = run => NOTHING_PUBLISHED_MODES.includes(run.mode);
const workBegun = run => !NOTHING_BEGUN_MODES.includes(run.mode);
/** Is this move allowed? The table alone decides. */
export const canMove = (from, to) => !!RUN_MOVES[from] && RUN_MOVES[from].includes(to);
/** The step a failed or interrupted mode names ('' for the others): for the owner's view only, derived from the one field. */
export const stepNamed = mode => (FAILED_MODES.includes(mode) ? mode.slice('failed_'.length)
  : INTERRUPTED_MODES.includes(mode) ? mode.slice('interrupted_'.length) : '');

/** What the owner may do in a mode (the drawer draws buttons from this; the routes enforce it by the table). */
export const actionsOf = run => (run.mode === 'planned' ? ['confirm', 'cancel'] : FAILED_MODES.includes(run.mode) ? ['retry', 'abandon']
  : run.mode === 'abandon_failed' ? ['abandon', 'forget']
  : INTERRUPTED_MODES.includes(run.mode) ? (CONTINUE_FOR[run.mode] ? ['continue', 'abandon'] : ['abandon']) : []);

/** A record written by an older companion (mode 'failed' + failed_step, or 'interrupted' + interrupted_from) in today's one field. */
export function migrateRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  if (rec.mode !== 'failed' && rec.mode !== 'interrupted' && !('failed_step' in rec) && !('interrupted_from' in rec)) return rec;
  const { failed_step: step, interrupted_from: from, ...rest } = rec;
  const now = rec.mode === 'failed' ? (FAILED_OF[step] || 'failed_publish') : rec.mode === 'interrupted' ? (INTERRUPTED_OF[from] || 'interrupted_unknown') : rec.mode;
  return { ...rest, mode: now };
}

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
  /** Read the record (an older companion's is migrated); a run that was in a mode INTERRUPTED_OF names becomes that interrupted mode
   *  (a failed or already interrupted run stays as it is: nothing of it was running). */
  load() {
    const got = this.file ? readJsonState(this.file) : { state: 'missing' };
    if (got.state !== 'ok' || !got.value) return;
    const rec = migrateRecord(got.value);
    if (!RUN_MODES.includes(rec.mode)) return;
    this.run = rec;
    if (INTERRUPTED_OF[this.run.mode]) this.move(INTERRUPTED_OF[this.run.mode], { interrupted_why: 'the companion stopped while this run was under way' });
    else if (this.run.mode === 'checking') this.move('idle');   // a start that had written nothing
    else if (rec !== got.value) this.persist();
  }
  /** THE ONE FUNCTION THAT CHANGES THE MODE. */
  move(to, facts = {}) {
    if (!RUN_MODES.includes(to)) throw new Error(`publish run: no such mode ${String(to).slice(0, 30)}`);
    const from = this.run.mode;
    if (!canMove(from, to)) throw new IllegalMove(`publish run: cannot go from ${from} to ${to}`);
    const base = RUN_FINISHED.includes(from) ? {} : this.run;
    this.run = { ...base, ...facts, mode: to, at: this.now() };
    if (!FAILED_MODES.includes(to)) delete this.run.failed_reason;
    if (!INTERRUPTED_MODES.includes(to)) delete this.run.interrupted_why;
    if (to !== 'abandon_failed') delete this.run.abandon_failure;
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
export const lstartOf = pid => { try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
/** What we know about a recorded step process, named in one list:
 *    none     no step process is recorded
 *    gone     it no longer exists, or its number now belongs to another process (a different start time)
 *    alive    it exists AND its start time is the recorded one: the same process
 *    unknown  it may exist but cannot be identified (ps failed when it was recorded, or fails now): it is NEVER signalled and never
 *             run a second time; the owner is offered abandon */
export const CHILD_STATES = Object.freeze(['none', 'gone', 'alive', 'unknown']);
export function childState(child, lstart = lstartOf) {
  if (!child) return 'none';
  if (!Number.isInteger(child.pgid) || child.pgid <= 1) return 'gone';
  try { process.kill(-child.pgid, 0); } catch (e) { if (!(e && e.code === 'EPERM')) return 'gone'; }
  if (!child.lstart) return 'unknown';
  const now = lstart(child.pgid);
  if (!now) return 'unknown';
  return now === child.lstart ? 'alive' : 'gone';
}
/** (kept for callers that only ask "is it certainly running?") */
export const childAlive = (child, lstart = lstartOf) => childState(child, lstart) === 'alive';
// stop a group we positively identified, and only that
const stopGroup = async (child, lstart) => {
  if (childState(child, lstart) !== 'alive') return childState(child, lstart) === 'gone';
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pgid, sig); } catch { return true; }
    for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); if (childState(child, lstart) === 'gone') return true; }
  }
  return childState(child, lstart) === 'gone';
};

// ---- the owner's view of a run -----------------------------------------------------
/** What an owner client may see: the record with the work tree's absolute path kept out, plus what it may do. */
export function viewOf(run) {
  if (!run || run.mode === 'idle') return { mode: 'idle', can: [] };
  const v = {
    id: run.id, token: run.token, mode: run.mode, confirm: run.confirm || 'always', at: run.at, scope: run.scope, title: run.title, permalink: run.permalink,
    note_rel: run.note_rel, note_text: run.note_text, thread_ids: run.thread_ids, page_url: run.page_url,
    steps: (run.steps || []).map(s => ({ step: s.step, exit: s.exit, signal: s.signal, timed_out: s.timed_out, spawn_error: s.spawn_error, ms: s.ms, truncated: s.truncated, output: s.output, at: s.at })),
    // (derived from the one field, for the owner's words: which step failed or was interrupted)
    failed_step: FAILED_MODES.includes(run.mode) ? stepNamed(run.mode) : '', failed_reason: run.failed_reason || '',
    interrupted_from: INTERRUPTED_MODES.includes(run.mode) ? stepNamed(run.mode) : '', interrupted_why: run.interrupted_why || '',
    published: run.published || null, cleanup: run.cleanup || null, chained_to: run.chained_to || null,
    abandon_failure: run.mode === 'abandon_failed' ? String(run.abandon_failure || '') : '',
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
  const lstart = deps.lstartOf || lstartOf;
  // the recorded step process, as last observed: `ps` runs once per record (a poll reads this), and again on an explicit action
  let childSeen = { key: '', state: 'none' };
  const childNow = (fresh = false) => {
    const key = JSON.stringify([book.run.id, book.run.at, book.run.child || null]);
    if (fresh || childSeen.key !== key) childSeen = { key, state: childState(book.run.child, lstart) };
    return childSeen.state;
  };
  const env = deps.env || process.env;
  const clock = () => (deps.now ? deps.now() : new Date());
  // facts about the command running right now (when it started, the last line it printed): not a mode. WHICH step is running is the
  // mode (STEP_OF[book.mode]); these are shown only while the mode is one of RUNNING_MODES.
  let progress = null;
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
    progress = { started: Date.now(), last: '' };
    const r = await exec({ argv, cwd: home.settings.top, env: minimalEnv(home.settings.env_pass, env), limitMs: TIME_LIMITS_MS[name], onLine: l => { if (progress) progress.last = l; }, onChild: (stop, pid) => { stopHandle = stop; if (pid) { book.run.child = { pgid: pid, lstart: lstart(pid), at: nowIso() }; book.persist(); } }, ...extra });
    progress = null;
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
  // Step A: the optional prepare, then plan. Each is a step with its own mode; a failure stops there (failed_prepare, failed_plan).
  async function runPlan() {
    const home = settingsNow();
    // prepare runs when the run has just been drafted or when prepare itself is what failed; a retried plan does not repeat it
    if (home.ok && home.settings.commands.prepare && (book.mode === 'drafted' || book.mode === 'failed_prepare')) {
      book.move('preparing');
      const p = await step('prepare');
      pushStep(p.record);
      if (!p.ok) return book.move('failed_prepare', { failed_reason: p.reason, steps: book.run.steps });
    }
    book.move('planning');
    const s = await step('plan');
    pushStep(s.record);
    if (!s.ok) return book.move('failed_plan', { failed_reason: s.reason, steps: book.run.steps });
    book.move('planned', { steps: book.run.steps });
    // confirm: 'never' — choosing Publish as blyg was the publish: carry straight on (apply, then publish)
    if (book.run.confirm === 'never') return runFrom('apply');
    return book.run;
  }

  /**
   * Start a run: → { ok, view } | { ok: false, status, error }. Writes the note file (the one side effect
   * outside the run's own record) and begins `plan` in the background.
   */
  /** Start a run (async: the pre-flight runs without holding the companion). A refusal after `checking` began goes back to idle. */
  async function start(args) {
    if (RUN_LIVE.includes(book.mode)) return fail(409, `a publish run is already under way (${book.mode}); finish or abandon it first`);
    let r;
    try { r = await startChecked(args); } catch (e) { r = fail(500, `could not start: ${String((e && e.message) || e).slice(0, 200)}`); }
    if (book.mode === 'checking') book.move('idle');
    return r;
  }
  async function startChecked({ page, threadId, scope, shown }) {
    if (!SCOPES.includes(scope)) return fail(400, `scope must be one of ${SCOPES.join(', ')}`);
    const home = settingsNow();
    if (!home.ok) return fail(409, `Publish as blyg is not set up: ${home.errors[0]}. Set “Where my blyg lives” on the companion first.`);
    const S = home.settings;
    // THE PRE-FLIGHT, before anything is written: a broken environment fails here, in about a second, with the check's own sentence
    if (S.commands.check) {
      book.move('checking');
      const c = await (deps.check || runCheck)({ argv: S.commands.check, cwd: S.top, env: minimalEnv(S.env_pass, env) });
      if (!c || !c.ok) return fail(409, `Publish as blyg cannot start: ${(c && c.message) || 'the check did not answer'}`);
      // the settings may not change while the check ran (they are read again, and must be the ones checked)
      const again = settingsNow();
      if (!again.ok || fingerprint(again.settings) !== fingerprint(S)) return fail(409, 'The “Where my blyg lives” settings changed while the check ran. Nothing was started.');
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
    // a Jekyll site ('liquid') may refuse a post that SHOWS `{{` or `{%` (inert or not): say so now, before anything is written, rather
    // than at the end of a long apply
    if (S.escape === 'liquid' && showsLiquid(first.text)) {
      return fail(409, 'This comment, or the passage it quotes, shows “{{” or “{%”. Your site keeps Liquid-looking text out of what it publishes, so it would refuse this post at the end of its checks. Nothing was written. Change the comment (for example write “{ {”), or quote a different passage.');
    }
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
    runPlan().catch(e => { try { book.move(book.mode === 'preparing' ? 'failed_prepare' : 'failed_plan', { failed_reason: String((e && e.message) || e).slice(0, 200) }); } catch { /* already moved */ } });
    return { ok: true, view: viewOf(run) };
  }

  // ---- Step C --------------------------------------------------------------------
  async function runFrom(first) {
    try {
      if (first === 'apply') {
        book.move('applying');
        const a = await step('apply');
        pushStep(a.record);
        if (!a.ok) return book.move('failed_apply', { failed_reason: a.reason, steps: book.run.steps });
        book.move('applied', { steps: book.run.steps });
      }
      book.move('publishing');
      const p = await step('publish');
      pushStep(p.record);
      if (!p.ok) return book.move('failed_publish', { failed_reason: p.reason, steps: book.run.steps });
      return finish(p.record ? p.record.output : '');
    } catch (e) {
      if (RUNNING_MODES.includes(book.mode) || book.mode === 'applied') {
        try { book.move(book.mode === 'applying' ? 'failed_apply' : 'failed_publish', { failed_reason: String((e && e.message) || e).slice(0, 200) }); } catch { /* moved already */ }
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
    const to = CONTINUE_FOR[book.mode] || '';
    if (!to || !canMove(book.mode, to)) return fail(409, 'only an interrupted apply or publish can be carried on; abandon this run instead');
    // never two copies of a step: the earlier one may have outlived the companion (looked at afresh: this is an explicit action)
    const earlier = childNow(true);
    if (earlier === 'unknown') return fail(409, 'The earlier step may still be running, and its process cannot be identified safely, so it is neither stopped nor run a second time. Abandon this run, or carry on later.');
    if (earlier === 'alive') {
      if (!stop) return fail(409, 'The earlier step is still running (process group ' + book.run.child.pgid + '). Wait for it, or choose to stop it and carry on.');
      if (!await stopGroup(book.run.child, lstart)) return fail(409, 'The earlier step would not stop; nothing was started.');
      delete book.run.child; book.persist();
    }
    if (!canMove(book.mode, to)) return fail(409, 'the run moved on meanwhile');
    runFrom(to === 'applying' ? 'apply' : 'publish');
    return { ok: true, view: viewOf(book.run) };
  }
  /** Try the failed step again (the owner's click). */
  function retry({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    { const t = taintOf(book.run); if (t) return fail(409, t); }
    const to = RETRY_FOR[book.mode] || '';
    if (!to || !canMove(book.mode, to)) return fail(409, 'there is no failed step to try again');
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
    if (!canMove(book.mode, 'cancelled')) return fail(409, `this run is ${book.mode}; it can be cancelled only while it waits for your answer`);
    const cleanup = await undraft();
    if (!canMove(book.mode, 'cancelled')) return fail(409, 'the run moved on meanwhile');
    book.move('cancelled', { cleanup });
    return { ok: true, view: viewOf(book.run) };
  }
  /** Give the run up. Before apply started, the draft is taken away too. After apply the site's own `abandon` command (when set) ends its
   *  record of the run; then, if apply itself is what failed (nothing was published), the draft is taken away as well (discard, then the
   *  note), so the next run is not refused by a note still staged. After a publish that failed or was interrupted the note is left. */
  async function abandon({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    if (!canMove(book.mode, 'abandoned')) return fail(409, `this run is ${book.mode}; only a failed or interrupted run can be abandoned`);
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
        if (!a.ok) {
          const why = `the abandon command failed (${a.reason}): ${String(a.record && a.record.output || '').slice(-400)}`;
          if (canMove(book.mode, 'abandon_failed')) book.move('abandon_failed', { abandon_failure: why });
          return { ...fail(409, `${why}. You can try Abandon again, or Forget this run here (nothing is run on your site).`), view: viewOf(book.run) };
        }
        cleanup = { ...cleanup, abandon: a.record ? a.record.output : '', note: 'the publish command\'s own abandon was run; the note was left where it is' };
      }
      if (publishedNothing(book.run)) {
        const u = await undraft();
        cleanup = { ...u, ...(cleanup.abandon !== undefined ? { abandon: cleanup.abandon } : {}),
          note: u.removed ? `apply failed, so nothing was published: ${cleanup.abandon !== undefined ? 'the site\'s own abandon was run and ' : ''}the draft was taken away` : u.note };
      }
    }
    if (!canMove(book.mode, 'abandoned')) return fail(409, 'the run moved on meanwhile');
    book.move('abandoned', { cleanup });
    return { ok: true, view: viewOf(book.run) };
  }
  /** FORGET the run here (only after the site's own abandon failed): the run ends on this companion and NOTHING is run on the site or
   *  removed. The owner is told plainly what the site may still hold. */
  function forget({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    if (book.mode !== 'abandon_failed') return fail(409, `this run is ${book.mode}; Forget is offered only after your site's own abandon failed`);
    const note = String(book.run.note_rel || '').replace(/[^\w ./-]/g, '');
    book.move('abandoned', { cleanup: { removed: false, discard: '', forgotten: true,
      note: `Forgotten here only: nothing was run on your site and nothing was removed. If your site still has this run or the note staged, end it there by hand (for the example blog: scripts/blyg-publish --abandon ${note || '<note>'}, then scripts/blyg-publish ${note || '<note>'} --unstage-note).` } });
    return { ok: true, view: viewOf(book.run) };
  }
  /** The owner client resumes: the current run (a client that reloaded asks this). */
  function current() {
    const v = viewOf(book.run);
    // while a step runs: which one, how long, and the last line it printed (owner only, like everything here)
    if (progress && RUNNING_MODES.includes(book.mode)) v.running = { step: STEP_OF[book.mode], elapsed_ms: Date.now() - progress.started, last_line: progress.last };
    const taint = taintOf(book.run);
    if (taint) { v.can = ['abandon']; v.tainted = taint; }
    else if (INTERRUPTED_MODES.includes(book.mode)) {
      const earlier = childNow();
      if (earlier === 'alive') { v.can = v.can.map(a => (a === 'continue' ? 'stop-and-continue' : a)); v.earlier_step_running = true; }
      else if (earlier === 'unknown') { v.can = v.can.filter(a => a !== 'continue'); v.earlier_step_unknown = true; }
    }
    if (!v.confirm || v.mode === 'idle') { const h = settingsNow(); v.confirm = h.ok ? h.settings.confirm : 'always'; }   // an idle view says which setting is in force
    return v;
  }
  /** Stop whatever is running (the companion is shutting down). */
  function stopAll() { if (RUNNING_MODES.includes(book.mode) && stopHandle) { try { stopHandle(); } catch { /* gone */ } } }

  return { book, start, confirm, retry, carryOn, cancel, abandon, forget, current, stopAll, STEPS };
}
