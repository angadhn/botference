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
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeJson, readJsonState } from './fsjson.mjs';
import { validateHome, fingerprint, minimalEnv, expandArgv, filenameFor, runCommand, runCheck, TIME_LIMITS_MS, STEPS, COMMAND_FOR, EDIT_STEPS, previewUrlFor } from './blyg-home.mjs';
import { renderShortNote, eligibleThread, isPublishedThread, isPublishableMsg, slugOf, dayOf, newBlygId, isBlygId, showsLiquid, readingOf, changelogLine, SCOPES, LIMITS } from './blyg-note.mjs';
import { createRunLog, LOG_DIR_NAME } from './blyg-log.mjs';
import { renderPreview as realRender, findChrome } from './preview-render.mjs';

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

// ---- what kind of run, and whether the owner looks first ------------------------------------------------------------
/** A run publishes a NEW post, or a new VERSION of one already published from here (the same note file, id and address, rewritten,
 *  and the site's commands in their edit form: blyg-home COMMAND_FOR). One field, `run.kind`, set when the run is drafted. */
export const RUN_KINDS = Object.freeze(['new', 'edit']);
/** Why a run stops at `planned` for the owner's look (`run.review`), one of:
 *    setting      the owner's setting is confirm 'always'
 *    agent-text   the post holds a passage an agent wrote or the owner pasted from an agent's tool: it is ALWAYS shown first,
 *                 whatever the setting (THE AGENT-TEXT RULE)
 *    none         confirm 'never' and nothing calls for a look: the run goes straight through */
export const REVIEW_REASONS = Object.freeze(['setting', 'agent-text', 'none']);
export function reviewFor(setting, { agentText = false } = {}) {
  if (agentText) return { confirm: 'always', review: 'agent-text' };
  return setting === 'never' ? { confirm: 'never', review: 'none' } : { confirm: 'always', review: 'setting' };
}
/** How long the build-and-check step is: `quick` when the guard carries the site's quick flag, else `full`. */
export const PACES = Object.freeze(['quick', 'full']);
export const QUICK_FLAG = '--quick';
export const paceOf = guard => ((guard || []).includes(QUICK_FLAG) ? 'quick' : 'full');

// ---- the picture of the draft (preview_url): its state, one named list in one field, moved by previewMove -----------------
//   off          no picture is asked for (no preview_url, no run waiting on the owner, or the run moved on)
//   waiting      the companion is rendering it (or waiting a little for the preview site to show the draft)
//   ready        a picture is held
//   unavailable  no picture (no headless browser, the preview site not answering, the page not there after the bounded wait):
//                the drawer says so in one line and shows the note's text; publishing is never blocked by it
export const PREVIEW_STATES = Object.freeze(['off', 'waiting', 'ready', 'unavailable']);
export const PREVIEW_MOVES = Object.freeze({ off: Object.freeze(['waiting']), waiting: Object.freeze(['ready', 'unavailable', 'off']),
  ready: Object.freeze(['waiting', 'off']), unavailable: Object.freeze(['waiting', 'off']) });
export function previewMove(p, to) {
  if (!PREVIEW_STATES.includes(to)) throw new Error(`preview: no such state ${String(to).slice(0, 20)}`);
  if (!PREVIEW_MOVES[p.state].includes(to)) throw new Error(`preview: cannot go from ${p.state} to ${to}`);
  p.state = to;
  return p;
}
/** How many times, and how far apart, the draft's page is asked for before it is called unavailable (the preview site may need a few
 *  seconds after prepare to show a new draft). */
export const PREVIEW_TRIES = Object.freeze({ times: 4, apartMs: 3000 });
export const DEFAULT_PREVIEW_SELECTOR = 'article';

// ---- the site's own plain words ------------------------------------------------------------------------------------
// A failed step is told to the owner in ONE sentence (the drawer's wording table): "Something went wrong while <step>." unless the
// site's command printed a line this list recognises as a plain refusal, which is then shown instead, cleaned (no script name, no
// file path, no command-line flag). Everything it printed is in the run's log for an agent.
export const PLAIN_LINES = Object.freeze([
  /is already staged/i,
  /main is behind|not the same commit as origin\/main|lacks \d+ commit|commits? on main that are not on GitHub/i,
  /--only-note: this plan is for more than/i,
  /uncommitted change/i,
  /another run is under way|a lock file is present|the lock/i,
  /is recorded at \w+: finish it|stopped at \w+; finish it first|was pushed to GitHub \(it is published\) but/i,
  /your checkout is on \S+, not wip|switch to wip/i,
  /release date .* is in the future|no release date/i,
  /not imported|importing the note's sources failed|^Failed:/i,
  /already belongs to the published|its address .* belongs to the published|is not the id it was published under/i,
  /Ruby .* is the one on PATH|bundler is not installed|BLYG_CHECKER|netlify command is not on PATH|node command is not on PATH/i,
  /locale/i,
  /nothing was published \(State:/i,
  /Refused:/,
]);
/** One line of a site's command made fit for the owner's screen: no script name, no path, no flag. */
export function plainSentence(line) {
  let t = String(line || '').replace(/^\s*(?:-\s+|Refused:\s*)?/, '').replace(/^blyg-publish(?: preflight)?:\s*/i, '').trim();
  t = t.replace(/\(?(?:ruby\s+)?scripts\/\S+(?:\s+(?:"[^"]*"|--?[\w-]+|_notes\/\S+))*\)?/g, '')
    .replace(/\b_notes\/[^\s,;:)]+\.md\b/g, 'the note')
    .replace(/(?<![\w:])\/(?:[^\s/"'<>()]+\/)+[^\s/"'<>(),;]*/g, 'a file on your site')
    .replace(/\s*\((?:--[\w-]+[^)]*)\)/g, '').replace(/\s+--[\w-]+(?:\s+"[^"]*")?/g, '')
    .replace(/\s{2,}/g, ' ').replace(/\s+([,;.:])/g, '$1').trim();
  if (!t) return '';
  t = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(t) ? t.slice(0, 300) : (t.slice(0, 299) + '.');
}
/** The recognised plain line in a step's output, cleaned, or ''. The LAST recognised line wins (the command's final word). */
export function plainLineOf(output) {
  const lines = String(output || '').split('\n').map(l => l.trim()).filter(l => l && l !== '[stderr]' && !/^\s*(from|at) \S+:\d+/.test(l) && !/\.rb:\d+:in /.test(l));
  for (let i = lines.length - 1; i >= 0; i--) if (PLAIN_LINES.some(re => re.test(lines[i]))) return plainSentence(lines[i]);
  return '';
}
/** While `publish` runs: the part of it the owner is waiting on, from the lines it has printed (a fact shown, not a mode). */
export const PUBLISH_PHASES = Object.freeze(['publish', 'wait']);
export const phaseOfLine = line => (/^Pushed main\b|waiting for the Netlify deploy|^Live and verified/i.test(String(line || '')) ? 'wait' : '');
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
    this.onChange(this.run, from);
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
// What an owner client may see. PLAIN: no command output, no file path, no script name (all of that is in the run's log, for an
// agent: blyg-log.mjs). The steps are the CURRENT attempt only (the last record of each step), with `tries` saying how many times
// the step that failed or was retried has run; a failure is one recognised plain line of the site's (or '': the drawer then says
// "Something went wrong while <step>.").
const stepOk = s => s.exit === 0 && !s.timed_out && !s.spawn_error && !s.signal && !s.unfinished;
export function viewOf(run) {
  if (!run || run.mode === 'idle') return { mode: 'idle', can: [] };
  const records = run.steps || [];
  const last = new Map();
  const count = new Map();
  for (const r of records) { last.set(r.step, r); count.set(r.step, (count.get(r.step) || 0) + 1); }
  const failedStep = FAILED_MODES.includes(run.mode) ? stepNamed(run.mode) : '';
  const v = {
    id: run.id, token: run.token, mode: run.mode, kind: RUN_KINDS.includes(run.kind) ? run.kind : 'new', version: run.version || 1,
    confirm: run.confirm || 'always', review: REVIEW_REASONS.includes(run.review) ? run.review : (run.confirm === 'never' ? 'none' : 'setting'),
    at: run.at, scope: run.scope, title: run.title, permalink: run.permalink, thread_ids: run.thread_ids, page_url: run.page_url,
    reading: run.reading || [], changelog: run.changelog || '', notify: run.notify || '', quotes: !!run.quotes, pace: PACES.includes(run.pace) ? run.pace : 'full',
    full_minutes: Number.isFinite(run.full_minutes) ? run.full_minutes : null,
    steps: [...last.values()].map(r => ({ step: r.step, ok: stepOk(r), ms: r.ms || 0 })),
    tries: failedStep ? (count.get(failedStep) || 0) : Math.max(0, ...[...count.values()]),
    failed_step: failedStep, failure: failedStep ? String(run.failure_line || '') : '',
    interrupted_from: INTERRUPTED_MODES.includes(run.mode) ? stepNamed(run.mode) : '', interrupted_why: run.interrupted_why || '',
    published: run.published || null, cleanup: run.cleanup ? { said: String(run.cleanup.said || ''), removed: !!run.cleanup.removed, forgotten: !!run.cleanup.forgotten } : null,
    chained_to: run.chained_to || null,
    abandon_failure: run.mode === 'abandon_failed' ? String(run.abandon_failure_line || '') : '',
    preview_url: run.preview_url || '',
    log: { id: run.id || '' },
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
function frontOf(text) {
  const head = String(text || '');
  if (!head.startsWith('---')) return '';
  return head.split(/\n---\s*\n/)[0];
}
const fmValue = (fm, key) => { const m = new RegExp(`^${key}:\\s*["']?([^\\s"']+)["']?\\s*$`, 'm').exec(fm); return m ? m[1] : ''; };
function headOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const k = fs.readSync(fd, buf, 0, 8192, 0); fs.closeSync(fd);
    return buf.slice(0, k).toString('utf8');
  } catch { return ''; }
}
function permalinksIn(folder) {
  const seen = new Set();
  for (const n of notesIn(folder)) {
    const fm = frontOf(headOf(path.join(folder, n)));
    if (!fm) continue;
    const p = fmValue(fm, 'permalink');
    if (p) seen.add(p.replace(/\/+$/, ''));
    const bid = fmValue(fm, 'blyg_id');
    if (bid) seen.add(`id:${bid}`);   // an id another note already declares
  }
  return seen;
}
/** The note in `folder` that declares `blyg_id: id` (for a post published before the thread kept its note's name), or ''. */
function noteWithId(folder, id) {
  if (!isBlygId(id)) return '';
  const hits = notesIn(folder).filter(n => fmValue(frontOf(headOf(path.join(folder, n))), 'blyg_id') === id);
  return hits.length === 1 ? hits[0] : '';
}

/**
 * `deps`: { file (run record), readConfig(), readPage(url), savePage(page), broadcast(ev), now(), hook ({beforeWrite, beforeUnlink}: tests only),
 *           exec (default runCommand), env (default process.env), logDir (default <dir of file>/blyg-publish-logs),
 *           durations (file; default <dir of file>/blyg-publish-durations.json), render (default preview-render.mjs), chrome (path) }
 */
export function createPublisher(deps) {
  const log = createRunLog(deps.logDir || path.join(path.dirname(deps.file || os.tmpdir()), LOG_DIR_NAME));
  const book = new RunBook({
    file: deps.file, now: deps.now ? () => deps.now().toISOString() : nowIso,
    onChange: (run, from) => {
      log.write(run.id, { ev: 'move', from, to: run.mode });
      try { deps.broadcast({ type: 'blyg-publish', run: { id: run.id, mode: run.mode } }); } catch { /* nobody listening */ }
    },
  });
  const exec = deps.exec || runCommand;
  const lstart = deps.lstartOf || lstartOf;
  const durationsFile = deps.durations || path.join(path.dirname(deps.file || os.tmpdir()), 'blyg-publish-durations.json');
  // WHAT WAS PUBLISHED FROM HERE, per post (by its address): its id, its note, the note's hash, its version, and the snapshot (hashes of
  // the comments as published) a new version is compared with. Kept on the companion, owner only (0600), NEVER on the page record that a
  // guest of a hosted companion can read; the thread carries only the public facts (when, title, address, version).
  const postsFile = deps.posts || path.join(path.dirname(deps.file || os.tmpdir()), 'blyg-publish-posts.json');
  const readPosts = () => { try { const d = JSON.parse(fs.readFileSync(postsFile, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
  const postOf = permalink => { const d = readPosts()[String(permalink || '').replace(/\/+$/, '')]; return d && typeof d === 'object' ? d : null; };
  const recordPost = (permalink, fact) => { const d = readPosts(); d[String(permalink).replace(/\/+$/, '')] = fact; writeJson(postsFile, d, { mode: 0o600 }); };
  // the recorded step process, as last observed: `ps` runs once per record (a poll reads this), and again on an explicit action
  let childSeen = { key: '', state: 'none' };
  const childNow = (fresh = false) => {
    const key = JSON.stringify([book.run.id, book.run.at, book.run.child || null]);
    if (fresh || childSeen.key !== key) childSeen = { key, state: childState(book.run.child, lstart) };
    return childSeen.state;
  };
  const env = deps.env || process.env;
  const clock = () => (deps.now ? deps.now() : new Date());
  // facts about the command running right now (when it started, the last line it printed, the publish phase): not a mode. WHICH step
  // is running is the mode (STEP_OF[book.mode]); these are shown only while the mode is one of RUNNING_MODES.
  let progress = null;
  let stopHandle = null;   // how to stop the command that is running (meaningful only in RUNNING_MODES)
  // the picture of the draft: { state (PREVIEW_STATES, moved only by previewMove), run, theme, png }
  let preview = { state: 'off', run: '', theme: 'light', png: null };

  const settingsNow = () => validateHome(deps.readConfig().blyg_home, { env });
  const fail = (status, error) => ({ ok: false, status, error });
  const logNote = text => log.write(book.run.id, { ev: 'note', text: String(text).slice(0, 4000) });

  // how long the last FULL build-and-check took on this site (for "This takes about N minutes"); never a guess when none is recorded
  const readDurations = () => { try { const d = JSON.parse(fs.readFileSync(durationsFile, 'utf8')); return d && typeof d === 'object' ? d : {}; } catch { return {}; } };
  const fullMinutesFor = top => { const d = readDurations()[top]; return d && Number.isFinite(d.apply_ms) ? Math.max(1, Math.round(d.apply_ms / 60000)) : null; };
  const recordFull = (top, ms) => { const d = readDurations(); d[top] = { apply_ms: ms, at: nowIso() }; try { writeJson(durationsFile, d, { mode: 0o600 }); } catch { /* a guess is never needed */ } };

  // THE RECORD ON DISK IS NOT TRUSTED. A live run's note must still be a file INSIDE the configured notes folder (real path) with the
  // hash this run wrote it with; otherwise nothing runs with its path and nothing deletes it: the run offers only "abandon".
  function taintOf(run) {
    if (!run || RUN_FINISHED.includes(run.mode)) return '';
    const home = settingsNow();
    if (!home.ok) return '';
    const rel = run.note_rel;
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return 'This run\'s record names a note that is not inside your notes folder, so nothing will be run or removed with it.';
    let real = '';
    try { real = fs.realpathSync(path.join(home.settings.top, rel)); } catch { return 'The note this run was started with is gone, so it cannot be carried on.'; }
    if (!(real === home.settings.folder || real.startsWith(home.settings.folder + path.sep))) return 'This run\'s record names a note outside your notes folder, so nothing will be run or removed with it.';
    let text = '';
    try { text = fs.readFileSync(real, 'utf8'); } catch { return 'The note this run was started with cannot be read, so it cannot be carried on.'; }
    if (sha(text) !== run.note_sha) return 'The note has changed since this run wrote it, so what you were shown is not what would be published.';
    return '';
  }

  /** Run one step; record it (in the run and, with its whole output, in the log); → the step record. Re-checks the settings first and
   *  refuses if they changed. `name` is the step (plan, apply, publish, prepare, discard, abandon); the command it runs follows the run's
   *  kind (an edit runs plan_edit, apply_edit, publish_edit). */
  async function step(name, extra = {}) {
    const run = book.run;
    const home = settingsNow();
    const tainted = taintOf(run);
    const refusal = (code, why) => { log.write(run.id, { ev: 'step', step: name, refused: code, output: why }); return { ok: false, record: { step: name, exit: null, spawn_error: code, at: nowIso() }, reason: why }; };
    if (tainted) return refusal('TAINTED', tainted);
    if (!home.ok) return refusal('SETTINGS', `the settings no longer pass: ${home.errors[0]}`);
    if (fingerprint(home.settings) !== run.settings_fp) return refusal('SETTINGS', 'the settings changed after this run started');
    const kind = RUN_KINDS.includes(run.kind) ? run.kind : 'new';
    const command = STEPS.includes(name) ? COMMAND_FOR[kind][name] : name;
    const argvRaw = home.settings.commands[command];
    if (!argvRaw) return kind === 'edit' && STEPS.includes(name) ? refusal('SETTINGS', `the ${command} command is not set`) : { ok: true, record: null, skipped: true };
    const abs = path.join(home.settings.top, run.note_rel);
    // the guard rides on plan, apply and publish (both forms), every time they run (retries and resumes too)
    const guard = STEPS.includes(name) ? home.settings.plan_guard : [];
    const argv = [...expandArgv(argvRaw, { rel: run.note_rel, abs, changelog: run.changelog || '' }), ...guard];
    const at = nowIso();
    progress = { started: Date.now(), last: '', phase: name === 'publish' ? 'publish' : '' };
    const r = await exec({ argv, cwd: home.settings.top, env: minimalEnv(home.settings.env_pass, env), limitMs: TIME_LIMITS_MS[command],
      onLine: l => { if (progress) { progress.last = l; if (name === 'publish' && phaseOfLine(l)) progress.phase = phaseOfLine(l); } },
      onChild: (stop, pid) => { stopHandle = stop; if (pid) { book.run.child = { pgid: pid, lstart: lstart(pid), at: nowIso() }; book.persist(); } }, ...extra });
    progress = null;
    if (book.run.child) { delete book.run.child; book.persist(); }
    let ok = r.exit === 0 && !r.timedOut && !r.signal && !r.spawnError;
    // a publish that exits 0 is a publish only when its LAST `State:` line is the site command's done marker (when one is set)
    let unfinished = '';
    if (ok && name === 'publish' && home.settings.published_marker) {
      const lastState = (String(r.output).split('\n').filter(l => /^State:/.test(l)).pop() || '').trim();
      if (lastState !== home.settings.published_marker) { ok = false; unfinished = lastState || 'no State line'; }
    }
    const record = { step: name, exit: r.exit, signal: r.signal || '', timed_out: !!r.timedOut, spawn_error: r.spawnError || '', ms: r.ms, truncated: !!r.truncated,
      ...(unfinished ? { unfinished } : {}), output: r.output, at };
    log.write(run.id, { ev: 'step', step: name, command, argv, exit: r.exit, signal: r.signal || '', timed_out: !!r.timedOut, spawn_error: r.spawnError || '', ms: r.ms, truncated: !!r.truncated, output: r.output });
    const reason = unfinished ? `publish exited 0 but did not finish (it ended at “${unfinished}”, not “${home.settings.published_marker}”): nothing was published` : r.timedOut ? `${name} did not finish within ${Math.round(TIME_LIMITS_MS[command] / 1000)} seconds and was stopped`
      : r.spawnError ? `${name} could not be started (${r.spawnError})` : r.signal ? `${name} was stopped by ${r.signal}` : `${name} exited with code ${r.exit}`;
    if (ok && name === 'apply' && paceOf(home.settings.plan_guard) === 'full') recordFull(home.settings.top, r.ms);
    return { ok, record, reason, plain: ok ? '' : (r.timedOut ? '' : plainLineOf(r.output)) };
  }
  const pushStep = rec => { if (rec) book.run.steps = [...(book.run.steps || []), rec]; };
  const failWith = (mode, s) => book.move(mode, { failed_reason: s.reason, failure_line: s.plain || '', steps: book.run.steps });

  // ---- the picture of the draft (preview_url + headless render) ----------------------------------------------------------
  function previewTo(to) { previewMove(preview, to); }
  async function renderDraft(runId, theme) {
    const home = settingsNow();
    const url = home.ok ? previewUrlFor(home.settings.preview_url, { permalink: book.run.permalink, slug: book.run.slug, id: (book.run.permalink || '').split('/').filter(Boolean).pop() || '' }) : '';
    const render = deps.render || realRender;
    const chrome = deps.chrome !== undefined ? deps.chrome : findChrome(env);
    let r = { state: 'unavailable', why: url ? 'not rendered' : 'no preview address' };
    for (let i = 0; url && i < PREVIEW_TRIES.times; i++) {
      if (preview.run !== runId || preview.state !== 'waiting') return;
      r = await render({ chrome, url, selector: (home.settings.preview_selector || DEFAULT_PREVIEW_SELECTOR), theme, themeAttribute: home.settings.preview_theme_attribute || '' });
      if (r.state !== 'missing') break;
      await new Promise(res => setTimeout(res, deps.previewApartMs !== undefined ? deps.previewApartMs : PREVIEW_TRIES.apartMs));
    }
    if (preview.run !== runId || preview.state !== 'waiting') return;
    log.write(runId, { ev: 'note', text: `preview render (${theme}): ${r.state}${r.why ? ` (${r.why})` : ''}` });
    if (r.state === 'ready') { preview.png = r.png; previewTo('ready'); } else { preview.png = null; previewTo('unavailable'); }
    try { deps.broadcast({ type: 'blyg-publish', run: { id: runId, mode: book.mode } }); } catch { /* nobody listening */ }
  }
  /** The owner's dialog asks for the picture (and `fresh` asks again): → { state, png? }. Rendered only for a run waiting on the
   *  owner (planned) whose settings name a preview address; never more than one render at a time. */
  function previewOf({ id, token, theme = 'light', fresh = false }) {
    const bad = owned(id, token); if (bad) return bad;
    const home = settingsNow();
    const want = book.mode === 'planned' && home.ok && !!home.settings.preview_url;
    if (!want) { if (preview.state !== 'off') previewTo('off'); preview = { state: 'off', run: '', theme: 'light', png: null }; return { ok: true, state: 'off' }; }
    const th = theme === 'dark' ? 'dark' : 'light';
    if (preview.run !== book.run.id) preview = { state: 'off', run: book.run.id, theme: th, png: null };
    const again = fresh || preview.theme !== th;
    if (preview.state === 'off' || (again && preview.state !== 'waiting')) {
      preview.theme = th; preview.png = null; previewTo('waiting');
      renderDraft(book.run.id, th).catch(() => { if (preview.state === 'waiting') previewTo('unavailable'); });
    }
    return { ok: true, state: preview.state, ...(preview.state === 'ready' && preview.png ? { png: preview.png } : {}) };
  }

  // ---- Step A --------------------------------------------------------------------
  // Step A: the optional prepare, then plan. Each is a step with its own mode; a failure stops there (failed_prepare, failed_plan).
  async function runPlan() {
    const home = settingsNow();
    // prepare runs when the run has just been drafted or when prepare itself is what failed; a retried plan does not repeat it
    if (home.ok && home.settings.commands.prepare && (book.mode === 'drafted' || book.mode === 'failed_prepare')) {
      book.move('preparing');
      const p = await step('prepare');
      pushStep(p.record);
      if (!p.ok) return failWith('failed_prepare', p);
    }
    book.move('planning');
    const s = await step('plan');
    pushStep(s.record);
    if (!s.ok) return failWith('failed_plan', s);
    book.move('planned', { steps: book.run.steps });
    // no look asked for (reviewFor: confirm 'never' and no agent text): choosing Publish as blyg was the publish: carry straight on
    if (book.run.confirm === 'never') return runFrom('apply');
    return book.run;
  }

  /** Start a run (async: the pre-flight runs without holding the companion). A refusal after `checking` began goes back to idle. */
  async function start(args) {
    if (RUN_LIVE.includes(book.mode)) return fail(409, `A publish is already under way (${book.mode.replace(/_/g, ' ')}). Finish it or give it up first.`);
    // the last run's step process, looked at afresh: a run forgotten while its step was still going must not get a second one beside it
    if (book.run.child && childNow(true) === 'alive') return fail(409, 'The earlier step is still running: stop it first.');
    let r;
    const id = crypto.randomBytes(8).toString('hex');
    try { r = await startChecked({ ...args, id }); } catch (e) { r = fail(500, `could not start: ${String((e && e.message) || e).slice(0, 200)}`); }
    if (book.mode === 'checking') book.move('idle');
    if (!r.ok) log.write(id, { ev: 'note', text: `start refused (${r.status}): ${r.error}` });
    return r;
  }
  async function startChecked({ page, threadId, scope, shown, id }) {
    if (!SCOPES.includes(scope)) return fail(400, `scope must be one of ${SCOPES.join(', ')}`);
    const home = settingsNow();
    if (!home.ok) { log.write(id, { ev: 'note', text: `settings: ${home.errors.join(' | ')}` }); return fail(409, 'Publish as blyg is not set up correctly on the companion: its “Where my blyg lives” setting does not pass its check. Open that setting on the companion to see why.'); }
    const S = home.settings;
    const threads = page.threads || [];
    const at = threads.findIndex(t => t && t.id === threadId);
    if (at < 0) return fail(404, 'That comment is not on this page any more.');
    const here = threads[at];
    const editing = isPublishedThread(here);
    if (editing && !EDIT_STEPS.every(k => S.commands[k])) return fail(409, 'Publishing a new version is not set up on the companion yet (its edit commands are missing).');
    // THE PRE-FLIGHT, before anything is written: a broken environment fails here, in about a second, with the check's own sentence
    if (S.commands.check) {
      book.move('checking');
      const c = await (deps.check || runCheck)({ argv: S.commands.check, cwd: S.top, env: minimalEnv(S.env_pass, env) });
      log.write(id, { ev: 'check', argv: S.commands.check, ok: !!(c && c.ok), message: (c && c.message) || '' });
      if (!c || !c.ok) {
        // the check's own plain sentences (the example site lists its problems as "  - …" lines under a heading)
        const lines = String((c && c.message) || '').split('\n').map(l => l.trim()).filter(Boolean);
        const listed = lines.filter(l => /^-\s/.test(l));
        const said = (listed.length ? listed : lines.slice(-8)).map(plainSentence).filter(Boolean);
        return fail(409, `Your site cannot publish right now: ${said.length ? said.join(' ') : 'its check did not answer.'}`);
      }
      // the settings may not change while the check ran (they are read again, and must be the ones checked)
      const again = settingsNow();
      if (!again.ok || fingerprint(again.settings) !== fingerprint(S)) return fail(409, 'The “Where my blyg lives” settings changed while the check ran. Nothing was started.');
    }
    // the owner was shown one setting's wording; if the one in force is another, nothing starts (a stale drawer must not promise a look
    // first when one click publishes, or the reverse)
    if (shown !== S.confirm) return fail(409, `The setting changed: your drawer showed “${String(shown || 'nothing').slice(0, 12)}” but “${S.confirm}” is in force (${S.confirm === 'never' ? 'one click publishes' : 'you will see the note first'}). Nothing was started. Open the menu again.`);
    return editing ? startEdit({ page, here, S, shown, id }) : startNew({ page, threads, at, here, scope, S, id });
  }

  // which threads "this and the ones above" takes: the owner's earlier unpublished eligible threads (with confirm 'never', only those
  // typed in the drawer: a thread written through another door is never published by one click)
  const aboveOf = (threads, at, S) => threads.slice(0, at).filter(t => eligibleThread(t).ok && !isPublishedThread(t)
    && (S.confirm !== 'never' || drawerTyped(t)));
  const drawerTyped = t => { const first = (t.msgs || []).find(m => m && m.kind !== 'tools'); return !!first && first.channel === 'drawer'; };

  async function startNew({ page, threads, at, here, scope, S, id }) {
    const el = eligibleThread(here);
    if (!el.ok) return fail(409, el.why);
    const picked = scope === 'one' ? [here] : [...aboveOf(threads, at, S), here];
    if (picked.length > LIMITS.comments) return fail(409, `At most ${LIMITS.comments} comments can go in one post.`);
    // the chain: only for one comment, and only when an earlier post from this page is on the record
    let earlier = null;
    if (scope === 'one') {
      const prev = threads.filter(t => isPublishedThread(t) && t !== here).map(t => t.blyg_published)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
      if (prev && prev.title && (prev.address || prev.permalink)) earlier = { title: prev.title, link: prev.address || prev.permalink };
    }
    const now = clock();
    const date = dayOf(now, S.timezone);
    const taken = permalinksIn(S.folder);
    const first = renderShortNote({ page, threads: picked, home: S, now, slug: 'x', earlier });
    if (!first.ok) return fail(409, first.error);
    if (S.escape === 'liquid' && showsLiquid(first.text)) return fail(409, LIQUID_SAY);
    const base = slugOf(first.title, { date });
    let rendered = null;
    let name = '';
    let slug = base;
    for (let n = 0; n < 60 && !rendered; n++) {
      const trySlug = n ? `${base.slice(0, LIMITS.slugChars - 4)}-${n + 1}` : base;
      const bid = newBlygId();   // the address is made of it; the FILE keeps the first-words slug
      const r = renderShortNote({ page, threads: picked, home: S, now, slug: trySlug, id: bid, earlier });
      if (!r.ok) return fail(409, r.error);
      let fileName;
      try { fileName = filenameFor(S.filename, { slug: trySlug, date }); } catch (e) { return fail(409, e.message); }
      let exists = false;
      try { fs.lstatSync(path.join(S.folder, fileName)); exists = true; } catch { /* free */ }
      const clash = exists || taken.has(`id:${bid}`) || (r.permalink && taken.has(r.permalink.replace(/\/+$/, '')));
      if (!clash) { rendered = r; name = fileName; slug = trySlug; }
    }
    if (!rendered) return fail(409, 'Could not find a free name for this note.');
    const target = path.join(S.folder, name);
    if (deps.hook && deps.hook.beforeWrite) deps.hook.beforeWrite(target);   // (tests only: a race between the name being chosen and the file being written)
    const realParent = fs.realpathSync(path.dirname(target));
    if (realParent !== S.folder || path.dirname(target) !== S.folder) return fail(409, 'The note would land outside your notes folder.');
    const rel = path.relative(S.top, target).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || rel.startsWith('-') || path.isAbsolute(rel)) return fail(409, 'The note’s name is not one your site’s commands can be given.');
    try {
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o644);
      try { fs.writeSync(fd, rendered.text); } finally { fs.closeSync(fd); }
    } catch (e) { return fail(409, e && e.code === 'EEXIST' ? 'A note of that name appeared meanwhile; try again.' : 'Could not write the note.'); }
    return drafted({ id, page, picked, scope, rendered, slug, rel, S, date, kind: 'new', version: 1, extra: { chained_to: earlier ? { title: earlier.title } : null } });
  }

  // A NEW VERSION of a post published from here: the same note file, rewritten with the same id and address (created and released
  // kept), the changelog line written from the difference (no model), and the site's commands in their edit form.
  async function startEdit({ page, here, S, id }) {
    const pub = { ...here.blyg_published, ...(postOf(here.blyg_published.permalink) || {}) };
    const threads = page.threads || [];
    // the threads that went into that post (in page order)
    const mates = threads.filter(t => isPublishedThread(t) && t.blyg_published.permalink === pub.permalink);
    const picked = mates.length ? mates : [here];
    if (!picked.some(t => (t.msgs || []).some(m => isPublishableMsg(m) && String(m.text || '').trim()))) return fail(409, 'Withdrawing a post is done on your site, not from here.');
    for (const t of picked) { const el = eligibleThread(t); if (!el.ok) return fail(409, el.why === 'that comment has no words' ? 'Withdrawing a post is done on your site, not from here.' : el.why); }
    // the note: as recorded on the thread, or (a post published before the thread kept it) the one note that declares the post's id
    const bid = String(pub.blyg_id || (pub.permalink || '').split('/').filter(Boolean).pop() || '');
    let rel = String(pub.note_rel || '');
    if (!rel) { const n = noteWithId(S.folder, bid); if (n) rel = path.relative(S.top, path.join(S.folder, n)).split(path.sep).join('/'); }
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return fail(409, 'The note of this post cannot be found in your notes folder, so a new version cannot be written from here.');
    const target = path.join(S.top, rel);
    let st;
    try { st = fs.lstatSync(target); } catch { return fail(409, 'The note of this post is no longer in your notes folder, so a new version cannot be written from here.'); }
    if (!st.isFile() || st.isSymbolicLink()) return fail(409, 'The note of this post is not a plain file, so it is not rewritten from here.');
    if (fs.realpathSync(path.dirname(target)) !== S.folder) return fail(409, 'The note of this post is not in your notes folder, so it is not rewritten from here.');
    const before = fs.readFileSync(target, 'utf8');
    if (pub.note_sha && sha(before) !== pub.note_sha) return fail(409, 'The note of this post was changed on your site since it was published from here, so it is not rewritten from here. Publish that change on your site.');
    const fm = frontOf(before);
    if (fmValue(fm, 'blyg_id') !== bid || !isBlygId(bid)) return fail(409, 'The note of this post does not carry the post\'s id, so it is not rewritten from here.');
    const now = clock();
    const slug = String(pub.slug || path.basename(rel, '.md').replace(/[^a-z0-9-]/g, '').slice(0, LIMITS.slugChars) || 'note');
    const rendered = renderShortNote({ page, threads: picked, home: S, now, slug, id: bid, keep: { created: fmValue(fm, 'created'), released: fmValue(fm, 'released') } });
    if (!rendered.ok) return fail(409, rendered.error);
    if (rendered.permalink.replace(/\/+$/, '') !== String(pub.permalink || '').replace(/\/+$/, '')) return fail(409, 'The post\'s address would change, so a new version is not written from here.');
    if (S.escape === 'liquid' && showsLiquid(rendered.text)) return fail(409, LIQUID_SAY);
    const changelog = pub.snapshot ? changelogLine(pub.snapshot, rendered.snapshot) : (rendered.text === before ? '' : 'Edited the post.');
    if (!changelog || rendered.text === before) return fail(409, 'Nothing has changed since you published this.');
    try {
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0));
      try { fs.writeSync(fd, rendered.text); } finally { fs.closeSync(fd); }
    } catch { return fail(409, 'Could not rewrite the note.'); }
    // who is told: only a post this version newly quotes or answers (the site sends a mention for a NEW relation only)
    const newly = (rendered.snapshot.sources || []).some(u => !((pub.snapshot && pub.snapshot.sources) || []).includes(u))
      || (rendered.snapshot.stub && rendered.snapshot.stub !== ((pub.snapshot && pub.snapshot.stub) || ''));
    return drafted({ id, page, picked, scope: 'one', rendered: { ...rendered, notify: newly ? rendered.notify : '' }, slug, rel, S, date: dayOf(now, S.timezone), kind: 'edit',
      version: (Number(pub.version) || 1) + 1, extra: { changelog, prev_text: before, prev_sha: sha(before), chained_to: null } });
  }

  function drafted({ id, page, picked, scope, rendered, slug, rel, S, date, kind, version, extra }) {
    const agentText = (rendered.generated || []).length > 0;
    const look = reviewFor(S.confirm, { agentText });
    log.write(id, { ev: 'run', id, kind, version, settings_fp: fingerprint(S), page_url: page.url, scope, note_rel: rel, permalink: rendered.permalink,
      confirm: look.confirm, review: look.review, changelog: (extra && extra.changelog) || '' });
    const run = book.move('drafted', {
      id, token: crypto.randomBytes(16).toString('hex'), kind, version,
      page_url: page.url, thread_ids: picked.map(t => t.id), scope, title: rendered.title, slug, permalink: rendered.permalink,
      note_rel: rel, note_text: rendered.text, note_sha: sha(rendered.text), settings_fp: fingerprint(S), confirm: look.confirm, review: look.review, steps: [],
      reading: readingOf(rendered.text, rendered.generated), notify: rendered.notify || '', quotes: (rendered.sources || []).length > 0,
      snapshot: rendered.snapshot, pace: paceOf(S.plan_guard), full_minutes: fullMinutesFor(S.top),
      preview_url: previewUrlFor(S.preview_url, { permalink: rendered.permalink, slug, id: (rendered.permalink || '').split('/').filter(Boolean).pop() || '' }),
      day: date, ...extra,
    });
    // Step A's second half runs in the background; its end is announced by the mode
    runPlan().catch(e => { try { book.move(book.mode === 'preparing' ? 'failed_prepare' : 'failed_plan', { failed_reason: String((e && e.message) || e).slice(0, 200), failure_line: '' }); } catch { /* already moved */ } });
    return { ok: true, view: viewOf(run) };
  }

  // ---- Step C --------------------------------------------------------------------
  async function runFrom(first) {
    try {
      if (first === 'apply') {
        book.move('applying');
        const a = await step('apply');
        pushStep(a.record);
        if (!a.ok) return failWith('failed_apply', a);
        book.move('applied', { steps: book.run.steps });
      }
      book.move('publishing');
      const p = await step('publish');
      pushStep(p.record);
      if (!p.ok) return failWith('failed_publish', p);
      return finish(p.record ? p.record.output : '');
    } catch (e) {
      if (RUNNING_MODES.includes(book.mode) || book.mode === 'applied') {
        try { book.move(book.mode === 'applying' ? 'failed_apply' : 'failed_publish', { failed_reason: String((e && e.message) || e).slice(0, 200), failure_line: '' }); } catch { /* moved already */ }
      }
      return book.run;
    }
  }
  /** published: record it on every thread that went in (its id, note, address, version and what was published, as hashes), so
   *  publishing it again is a new VERSION of the same post. */
  function finish(output) {
    const run = book.run;
    const address = addressFrom(output, run.permalink);
    const bid = (run.permalink || '').split('/').filter(Boolean).pop() || '';
    const published = { at: clock().toISOString(), title: run.title, permalink: run.permalink || '', ...(address ? { address } : {}), version: run.version || 1 };
    try {
      recordPost(run.permalink, { version: run.version || 1, note_rel: run.note_rel, note_sha: run.note_sha, slug: run.slug, ...(isBlygId(bid) ? { blyg_id: bid } : {}),
        snapshot: run.snapshot || null, at: published.at });
    } catch { published.record_error = 'The post is live, but the companion could not keep what it needs to publish a new version of it.'; }
    try {
      const page = deps.readPage(run.page_url);
      if (page) {
        for (const t of page.threads || []) {
          if (!run.thread_ids.includes(t.id)) continue;
          const before = t.blyg_published || {};
          t.blyg_published = { ...published, ...(before.address && !published.address ? { address: before.address } : {}), ...(before.at && run.kind === 'edit' ? { first_at: before.first_at || before.at } : {}) };
        }
        deps.savePage(page);
        deps.broadcast({ type: 'page', url: page.url });
      }
    } catch (e) { published.record_error = 'The post is live, but this page could not be marked as published.'; }
    return book.move('published', { published, steps: book.run.steps });
  }

  function owned(id, token) {
    const r = book.run;
    if (!r.id || r.id !== id || !token || typeof token !== 'string' || !r.token || token.length !== r.token.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.token))) return fail(404, 'no such publish run');
    return null;
  }

  /** The owner's "Publish": Step C. */
  function confirm({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    { const t = taintOf(book.run); if (t) return fail(409, t); }
    if (book.mode !== 'planned') return fail(409, `This publish is ${book.mode.replace(/_/g, ' ')}; only one waiting for your look can be published.`);
    if (preview.state !== 'off') previewTo('off');
    runFrom('apply');
    return { ok: true, view: viewOf(book.run) };
  }
  /** Carry on an interrupted apply or publish (the owner's click): the same step again, which is how the site's command resumes. */
  async function carryOn({ id, token, stop = false }) {
    const bad = owned(id, token); if (bad) return bad;
    { const t = taintOf(book.run); if (t) return fail(409, t); }
    const to = CONTINUE_FOR[book.mode] || '';
    if (!to || !canMove(book.mode, to)) return fail(409, 'Only an interrupted build or publish can be carried on; give this run up instead.');
    const earlier = await earlierStep(stop);
    if (earlier) return earlier;
    if (!canMove(book.mode, to)) return fail(409, 'The run moved on meanwhile.');
    runFrom(to === 'applying' ? 'apply' : 'publish');
    return { ok: true, view: viewOf(book.run) };
  }
  // THE EARLIER STEP, looked at afresh (an explicit action): never two copies of a step, never a run given up under a step still going.
  //   alive    refused ("stop it first"), unless the owner chose to stop it (`stop`), which stops that group and only that group
  //   unknown  refused: it is neither signalled nor run again (Forget, after a second confirmation, is what is left)
  async function earlierStep(stop) {
    const earlier = childNow(true);
    if (earlier === 'unknown') return { ...fail(409, 'The earlier step may still be running and cannot be identified safely, so nothing is started or given up over it. You can forget this run here instead.'), view: current() };
    if (earlier === 'alive') {
      if (!stop) return { ...fail(409, 'The earlier step is still running: stop it first.'), view: current() };
      if (!await stopGroup(book.run.child, lstart)) return fail(409, 'The earlier step would not stop; nothing was done.');
      logNote(`stopped the earlier step's process group ${book.run.child.pgid}`);
      delete book.run.child; book.persist();
    }
    return null;
  }
  /** Try the failed step again (the owner's click). */
  function retry({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    { const t = taintOf(book.run); if (t) return fail(409, t); }
    const to = RETRY_FOR[book.mode] || '';
    if (!to || !canMove(book.mode, to)) return fail(409, 'There is no failed step to try again.');
    if (to === 'planning' || to === 'preparing') runPlan().catch(() => {});
    else runFrom(to === 'applying' ? 'apply' : 'publish');
    return { ok: true, view: viewOf(book.run) };
  }

  /** Take the draft away, but only the file this run made (or, for a new version, put the published text back) and only if it is as
   *  it was written. → the cleanup record ({ removed, said } for the owner; the details go to the log). */
  async function undraft() {
    const run = book.run;
    const out = { removed: false, said: '' };
    const edit = run.kind === 'edit';
    const keepSay = 'Your note was left as it is on your site.';
    { const t = taintOf(run); if (t) { out.said = `${t} ${keepSay}`; return out; } }
    const home = settingsNow();
    if (!home.ok || fingerprint(home.settings) !== run.settings_fp) { out.said = `The settings changed, so nothing was undone. ${keepSay}`; return out; }
    const S = home.settings;
    const abs = path.join(S.top, run.note_rel);
    let text = null;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { out.said = 'The note was already gone.'; return out; }
    if (sha(text) !== run.note_sha) { out.said = `The note was changed after it was written. ${keepSay}`; return out; }
    if (S.commands.discard && workBegun(run)) {
      const d = await step('discard');
      if (!d.ok) { out.said = `Your site could not take the draft back. ${keepSay}`; logNote(`discard failed: ${d.reason}`); return out; }
    }
    if (deps.hook && deps.hook.beforeUnlink) deps.hook.beforeUnlink(abs);   // (tests only: the note changes after the first check)
    try {
      if (fs.existsSync(abs)) {
        if (fs.lstatSync(abs).isSymbolicLink() || sha(fs.readFileSync(abs, 'utf8')) !== run.note_sha) { out.said = `The note was changed. ${keepSay}`; return out; }
        if (edit) {
          // a new version: the published text goes back, exactly as it was
          const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0));
          try { fs.writeSync(fd, String(run.prev_text || '')); } finally { fs.closeSync(fd); }
          out.said = 'Your post is as it was: the new version was not published.';
        } else { fs.unlinkSync(abs); out.said = 'The draft was taken away.'; }
      }
      out.removed = true;
    } catch (e) { out.said = `The note could not be ${edit ? 'put back' : 'removed'}.`; logNote(`undraft: ${e && e.message}`); }
    return out;
  }

  /** Cancel at the confirmation: the draft goes (if it is this run's and unchanged); the run ends. */
  async function cancel({ id, token }) {
    const bad = owned(id, token); if (bad) return bad;
    if (!canMove(book.mode, 'cancelled')) return fail(409, `This publish is ${book.mode.replace(/_/g, ' ')}; it can be cancelled only while it waits for you.`);
    if (preview.state !== 'off') previewTo('off');
    const cleanup = await undraft();
    if (!canMove(book.mode, 'cancelled')) return fail(409, 'The run moved on meanwhile.');
    book.move('cancelled', { cleanup });
    return { ok: true, view: viewOf(book.run) };
  }
  /** Give the run up. Before apply started, the draft is taken away too. After apply the site's own `abandon` command (when set) ends its
   *  record of the run; then, if apply itself is what failed (nothing was published), the draft is taken away as well (discard, then the
   *  note), so the next run is not refused by a note still staged. After a publish that failed or was interrupted the note is left.
   *  The earlier step's process is looked at afresh first (earlierStep): alive → stop it first (`stop`), unknown → only Forget. */
  async function abandon({ id, token, stop = false }) {
    const bad = owned(id, token); if (bad) return bad;
    if (!canMove(book.mode, 'abandoned')) return fail(409, `This publish is ${book.mode.replace(/_/g, ' ')}; only a failed or interrupted one can be given up.`);
    const earlier = await earlierStep(stop);
    if (earlier) return earlier;
    let cleanup;
    const tainted = taintOf(book.run);
    if (tainted) cleanup = { removed: false, said: `${tainted} Nothing was run or removed.` };
    else if (beforeApply(book.run)) cleanup = await undraft();
    else {
      cleanup = { removed: false, said: 'Your note was left on your site: your site keeps its own record of this publish.' };
      const home = settingsNow();
      if (home.ok && home.settings.commands.abandon && fingerprint(home.settings) === book.run.settings_fp) {
        const a = await step('abandon');
        if (!a.ok) {
          if (canMove(book.mode, 'abandon_failed')) book.move('abandon_failed', { abandon_failure: a.reason, abandon_failure_line: a.plain || '' });
          return { ...fail(409, `Your site could not give this publish up${a.plain ? `: ${a.plain}` : '.'} You can try again, or forget it here (nothing is run on your site).`), view: viewOf(book.run) };
        }
        cleanup = { removed: false, said: 'Your site gave the publish up; your note was left on your site.' };
      }
      if (publishedNothing(book.run)) {
        const u = await undraft();
        cleanup = { removed: u.removed, said: u.removed ? `Nothing was published. ${u.said}` : u.said };
      }
    }
    if (!canMove(book.mode, 'abandoned')) return fail(409, 'The run moved on meanwhile.');
    book.move('abandoned', { cleanup });
    return { ok: true, view: viewOf(book.run) };
  }
  /** FORGET the run here: the run ends on this companion and NOTHING is run on the site or removed. Offered after the site's own
   *  abandon failed, and when the earlier step's process cannot be identified (then only with `sure`: the owner's second
   *  confirmation). Refused while that process is certainly still running (stop it first). */
  async function forget({ id, token, sure = false, stop = false }) {
    const bad = owned(id, token); if (bad) return bad;
    if (!canMove(book.mode, 'abandoned')) return fail(409, `This publish is ${book.mode.replace(/_/g, ' ')}; it cannot be forgotten.`);
    const state = childNow(true);
    if (state === 'alive') {
      if (!stop) return { ...fail(409, 'The earlier step is still running: stop it first.'), view: current() };
      if (!await stopGroup(book.run.child, lstart)) return fail(409, 'The earlier step would not stop; nothing was done.');
      delete book.run.child; book.persist();
    }
    const unknown = state === 'unknown';
    if (book.mode !== 'abandon_failed' && !unknown) return fail(409, 'Forget is offered only when your site could not give the publish up, or its step cannot be identified.');
    if (unknown && !sure) return { ...fail(409, 'Forgetting runs nothing and stops nothing: the earlier step may still be running on the companion\'s machine. Press Forget again to confirm.'), view: current() };
    const note = String(book.run.note_rel || '').replace(/[^\w ./-]/g, '');
    logNote(`forgotten here (child ${state}); to end it on the example site by hand: scripts/blyg-publish --abandon ${note || '<note>'}, then scripts/blyg-publish ${note || '<note>'} --unstage-note`);
    book.move('abandoned', { cleanup: { removed: false, forgotten: true,
      said: 'Forgotten here only: nothing was run on your site and nothing was removed. Your site may still hold this publish or the note; the troubleshooting details say how to end it there.' } });
    return { ok: true, view: viewOf(book.run) };
  }
  /** The owner client resumes: the current run (a client that reloaded asks this). */
  function current() {
    const v = viewOf(book.run);
    // while a step runs: which one, how long, and which part of a publish (owner only, like everything here)
    if (progress && RUNNING_MODES.includes(book.mode)) v.running = { step: STEP_OF[book.mode], elapsed_ms: Date.now() - progress.started, ...(progress.phase ? { phase: progress.phase } : {}) };
    const taint = taintOf(book.run);
    if (taint) { v.can = ['abandon']; v.tainted = taint; }
    if (RUN_LIVE.includes(book.mode) && !RUNNING_MODES.includes(book.mode) && book.run.child) {
      const earlier = childNow();
      if (earlier === 'alive') { v.can = [...new Set(v.can.map(a => (a === 'continue' ? 'stop-and-continue' : a === 'abandon' ? 'stop-and-abandon' : a)))]; v.earlier_step = 'alive'; }
      else if (earlier === 'unknown') { v.can = ['forget']; v.earlier_step = 'unknown'; }
    }
    v.preview = PREVIEW_STATES.includes(preview.state) && preview.run === book.run.id ? preview.state : 'off';
    if (!v.confirm || v.mode === 'idle') { const h = settingsNow(); v.confirm = h.ok ? h.settings.confirm : 'always'; }   // an idle view says which setting is in force
    return v;
  }
  /** Stop whatever is running (the companion is shutting down). */
  function stopAll() { if (RUNNING_MODES.includes(book.mode) && stopHandle) { try { stopHandle(); } catch { /* gone */ } } }

  return { book, log, start, confirm, retry, carryOn, cancel, abandon, forget, current, previewOf, stopAll, STEPS };
}
const LIQUID_SAY = 'This comment, or the passage it quotes, shows “{{” or “{%”. Your site keeps Liquid-looking text out of what it publishes, so it would refuse this post at the end of its checks. Nothing was written. Change the comment (for example write “{ {”), or quote a different passage.';
