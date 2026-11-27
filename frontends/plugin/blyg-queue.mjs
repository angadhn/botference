// blyg-queue.mjs — the PUBLISH QUEUE: every press of "Publish as blyg" is accepted at once and published in order, in the
// background, by the one runner (blyg-run.mjs). The queue never runs anything itself: it hands the runner one entry at a time
// and starts the next when the run ends. It lives in a file beside the run record (0600), so a restart finds it.
//
// AN ENTRY'S STATE, named once, held in ONE field (`entry.state`), changed by ONE function (moveEntry) that refuses a move
// ENTRY_MOVES does not list:
//   queued      waiting for the runner (in press order; one the owner asked to look at goes first)
//   filling     its turn came while an agent's passage in it was still being written: it waits for the fill (bounded, FILL_WAIT_MS)
//               and the queue goes on with the next entry; filled → queued again (it is then next), failed or too late → failed
//   needs_look  set aside before anything was written, because the policy forces a look (blyg-run LOOK_FORCED: a comment the post
//               had would be left out, a note changed outside the plugin would be replaced), because the text another thread of the
//               post was last published with cannot be known, or because an earlier post from the same page did not go out
//   running     the runner has it (from the pre-flight until the run ends; with a look promised, that includes waiting at the look)
//   giving_up   its run failed where the site certainly published nothing, and the run is being given up (Start over) by the queue:
//               a recorded step, so a stop in the middle is finished (or the queue paused) after a restart
//   published   its run went live
//   failed      its run, or its start, failed (`failure`: what the owner reads)
//   cancelled   the owner cancelled it before it ran (nothing written), or cancelled its run at the look
//
// WHERE THE OWNER IS for an entry, one value set at the press (`entry.presence`, PRESENCES below), never a pair of flags:
//   away           pressed with one click and moved on: a forced look sets it aside before anything is written
//   promised_look  pressed while "see it first" (confirm always) was the setting: it is ALWAYS looked at, whatever the setting says later
//   asked_to_look  the owner opened a post set aside for their look: looked at, and ahead of the others
//
// THE QUEUE'S OWN STATE, one field (`state`), moved only by moveQueue:
//   running           entries are handed to the runner as it becomes free
//   paused_for_run    a run failed where the site may have published (failed or interrupted publish, interrupted_unknown, the site's
//                     abandon failed), or a run the owner is watching failed: nothing more starts until the owner resolves THAT run
//                     (Try again, Forget, Start over); its end resumes the queue
//   paused_for_site   a start was refused for a reason about the site or this machine (a failed pre-flight, a broken setting): the
//                     posts stay queued; the owner's "Try the queue again" (resume) or their next press resumes it
//   paused_for_error  something unexpected went wrong in the queue itself: said to the owner, resumed the same way
//
// WHAT GOES OUT. An entry keeps ONLY the thread(s) it was pressed for, as they were at the press (a later press of the same thread
// replaces it and moves it to the back). When its turn comes it is given the page as it is THEN, with the pressed threads as pressed
// and every other thread of a post taken from what that post was LAST PUBLISHED with (its record), never from the drawer (which may
// hold edits not pressed) nor from an older press. So no entry publishes an older text of a thread than one already published or
// pressed later. An agent's passage still being written is taken from the page when it lands.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJson, readJsonState, warnUnreadable } from './fsjson.mjs';
import { RUN_LIVE, RUN_FINISHED, FAILED_MODES, INTERRUPTED_MODES, publishedNothing, stepNamed, IllegalMove, EXTENTS, JOINS, settingChangedSay } from './blyg-run.mjs';
import { eligibleThread, isStandAlonePage, isPublishedThread, includedMsgs, SCOPES, PROMPT_MODES, withoutQuoteMarks } from './blyg-note.mjs';

export const ENTRY_STATES = Object.freeze(['queued', 'filling', 'needs_look', 'running', 'giving_up', 'published', 'failed', 'cancelled']);
export const ENTRY_MOVES = Object.freeze({
  queued: Object.freeze(['running', 'filling', 'needs_look', 'cancelled', 'failed']),
  filling: Object.freeze(['queued', 'failed', 'cancelled']),
  needs_look: Object.freeze(['queued', 'running', 'cancelled']),
  // (running → needs_look: a forced look found before anything was written; → queued: the companion stopped before anything was
  // written, or the start was refused for a reason about the site, not the post)
  running: Object.freeze(['published', 'failed', 'giving_up', 'cancelled', 'needs_look', 'queued']),
  giving_up: Object.freeze(['failed']),
  // (the owner's Try again on a run that paused the queue went live after all)
  failed: Object.freeze(['published']),
  published: Object.freeze([]),
  cancelled: Object.freeze([]),
});
/** The states an entry is in while it still counts against the limit (it has not finished). */
export const OPEN_STATES = Object.freeze(['queued', 'filling', 'needs_look', 'running', 'giving_up']);
/** …and while the owner can still cancel it (nothing of it has been written). */
export const CANCELLABLE = Object.freeze(['queued', 'filling', 'needs_look']);
export const PRESENCES = Object.freeze(['away', 'promised_look', 'asked_to_look']);
export const QUEUE_STATES = Object.freeze(['running', 'paused_for_run', 'paused_for_site', 'paused_for_error']);
export const QUEUE_MOVES = Object.freeze({
  running: Object.freeze(['paused_for_run', 'paused_for_site', 'paused_for_error']),
  paused_for_run: Object.freeze(['running', 'paused_for_error']),
  paused_for_site: Object.freeze(['running', 'paused_for_error']),
  paused_for_error: Object.freeze(['running']),
});
/** The pauses the owner lifts with "Try the queue again" (or a press); a run's pause is lifted by resolving that run. */
export const OWNER_RESUMES = Object.freeze(['paused_for_site', 'paused_for_error']);
/** Why an entry needs the owner's look. */
// (notes-read: a passage's agent read the owner's notes, blyg-run LOOK_FORCED: seen on the computer before it is public)
export const NEEDS_LOOK_WHY = Object.freeze(['left-out', 'outside', 'unknown-text', 'earlier-failed', 'notes-read']);
/** How an entry came to the runner, one value set once: `owner` (the press found the runner free and ran it at once, as before the
 *  queue) or `queue` (the queue started it later). */
export const STARTED_BY = Object.freeze(['owner', 'queue']);
/** WHO PRESSED, one value set at the press (`entry.pressed_by`; absent on entries made before it existed: the owner):
 *    owner     the owner's drawer (POST /blyg-publish/start)
 *    hub-link  the owner's hosted Hub, through the signed hub link (hub-link.mjs): the owner is away from this machine, so the press
 *              is ALWAYS queued (never run at once in a dialog nobody is at), its presence is `away` (or `promised_look` under
 *              confirm 'always'), it never lifts a pause, and it may never ask for a look */
export const PRESSED_BY = Object.freeze(['owner', 'hub-link']);
/** Why the QUEUE took an entry out (`entry.cancelled_for`; absent: the owner cancelled it, or a later press replaced it):
 *    cannot-add  a Hub addition whose earlier post, when its turn came, was no longer the post a comment there is added to (gone,
 *                changed by hand, another post since): nothing was written; the hub link gives the reply back as a saved draft */
export const ENTRY_CANCEL_REASONS = Object.freeze(['cannot-add']);
export const QUEUE_MAX = 20;
export const FINISHED_KEPT = 20;
export const FILL_WAIT_MS = 5 * 60 * 1000;
export const FILL_CHECK_MS = 2000;
export const FULL_SAY = `${QUEUE_MAX} posts are already waiting to go out. Wait for one to go out, or cancel one, then press again.`;
export const GONE_SAY = 'That page is no longer kept on the companion, so this post was not published.';
export const FILL_FAILED_SAY = 'An agent’s passage in this post could not be written, so it was not published. Fill it, write it yourself or remove it, then press again.';
export const FILL_LATE_SAY = 'An agent’s passage in this post was still being written after five minutes, so it was not published. Press again once it is filled.';
export const ENTRY_UNREADABLE_SAY = 'This queued post could not be read back after the companion restarted, so it was not published. Press it again.';
export const ENTRY_BROKE_SAY = 'Something went wrong on the companion with this queued post, so it was not published. Press it again.';
export const QUEUE_BROKE_SAY = 'Something went wrong in your publish queue, so it stopped. Your queued posts are kept: press “Try the queue again”.';
export const UNREADABLE_SAY = 'Your queued posts could not be read when the companion started, so they were not published. The file was kept as it was';
/** Where an unreadable queue file was kept, one value (`unreadable.kept`):
 *    moved_aside    renamed to a dated name beside it; the queue writes a fresh file
 *    left_in_place  it could not be moved: it is never written over, so the queue lives in memory only until the companion restarts */
export const UNREADABLE_KEPT = Object.freeze(['moved_aside', 'left_in_place']);
const LEFT_IN_PLACE_SAY = 'It could not be moved aside, so it was left where it is and the queue is kept in memory only until the companion restarts';

const clone = v => JSON.parse(JSON.stringify(v));
const words = (s, n = 10) => String(s || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ').slice(0, 90);
const isStr = v => typeof v === 'string';
// AN ENTRY READ FROM DISK is trusted only after this: every field a run is started from has the shape a press gives it
function entryProblem(e) {
  if (!e || typeof e !== 'object' || !isStr(e.id) || !/^[0-9a-f]{8,32}$/.test(e.id)) return 'id';
  if (!Number.isInteger(e.seq) || !ENTRY_STATES.includes(e.state) || !isStr(e.page_url) || !isStr(e.thread_id)) return 'fields';
  if (!OPEN_STATES.includes(e.state)) return '';   // a finished entry is only shown
  if (!PRESENCES.includes(e.presence)) return 'presence';
  const a = e.args;
  if (!a || typeof a !== 'object' || !SCOPES.includes(a.scope) || !EXTENTS.includes(a.extent) || !isStr(a.upto) || (a.extent === 'upto') !== !!a.upto
    || !(a.join === '' || JOINS.includes(a.join)) || !(a.outside === '' || a.outside === 'replace') || !isStr(a.post) || !isStr(a.post_version)
    || !(a.prompts === undefined || a.prompts === '' || PROMPT_MODES.includes(a.prompts))) return 'args';
  if (!Array.isArray(e.snapshot) || !e.snapshot.length || !e.snapshot.every(t => t && isStr(t.id) && Array.isArray(t.msgs) && t.msgs.every(m => m && typeof m === 'object'))) return 'snapshot';
  if ((e.state === 'running' || e.state === 'giving_up') && !isStr(e.run_id)) return 'run';
  return '';
}

/**
 * deps: { file, publisher (createPublisher's), readPage(url), confirmNow() → 'never' | 'always' | '' (the setting in force, '' when
 *         not set up), broadcast(ev), log(text) (the companion's log), now() → Date (tests), fillCheckMs, fillWaitMs, max }
 */
export function createQueue(deps) {
  const pub = deps.publisher;
  const clock = () => (deps.now ? deps.now() : new Date());
  const max = deps.max || QUEUE_MAX;
  const fillWait = deps.fillWaitMs !== undefined ? deps.fillWaitMs : FILL_WAIT_MS;
  const say = text => { try { (deps.log || (t => process.stderr.write(`blyg-queue: ${t}\n`)))(text); } catch { /* nowhere to say it */ } };
  let rec = { state: 'running', paused: null, seq: 0, entries: [] };
  // an unreadable queue file is never written over: it is moved aside under a dated name, the queue starts empty, and the owner is told
  let unreadable = null;
  {
    const got = deps.file ? readJsonState(deps.file) : { state: 'missing' };
    const v = got.state === 'ok' ? got.value : null;
    const shaped = v && typeof v === 'object' && QUEUE_STATES.includes(v.state) && Array.isArray(v.entries) && Number.isInteger(v.seq);
    if (got.state === 'unreadable' || (got.state === 'ok' && !shaped)) {
      const aside = path.join(path.dirname(deps.file), `blyg-publish-queue.unreadable-${clock().toISOString().replace(/[:.]/g, '-')}.json`);
      let kept = 'moved_aside';
      try { fs.renameSync(deps.file, aside); } catch { kept = 'left_in_place'; }
      if (got.state === 'unreadable') warnUnreadable(deps.file, got.error);
      const file = kept === 'moved_aside' ? aside : deps.file;
      unreadable = { kept, file, at: clock().toISOString(), say: `${UNREADABLE_SAY}: ${file}.${kept === 'left_in_place' ? ` ${LEFT_IN_PLACE_SAY}.` : ''}` };
      say(unreadable.say);
    } else if (shaped) {
      rec = { state: v.state, paused: v.paused && typeof v.paused === 'object' ? v.paused : null, seq: v.seq, entries: [] };
      for (const e of v.entries) {
        const bad = entryProblem(e);
        if (!bad) { rec.entries.push(e); continue; }
        // an entry that is not what a press makes is never run: it is shown failed, with a plain sentence, and the queue goes on
        say(`a queued post could not be read back (${bad}): marked failed`);
        rec.entries.push({ id: isStr(e && e.id) && /^[0-9a-f]{8,32}$/.test(e.id) ? e.id : crypto.randomBytes(6).toString('hex'), seq: Number.isInteger(e && e.seq) ? e.seq : ++rec.seq,
          state: 'failed', at: clock().toISOString(), page_url: isStr(e && e.page_url) ? e.page_url : '', thread_id: isStr(e && e.thread_id) ? e.thread_id : '',
          label: isStr(e && e.label) ? e.label.slice(0, 90) : '', page_title: '', presence: 'away', failure: { say: ENTRY_UNREADABLE_SAY } });
      }
      if (rec.state !== 'running' && !(rec.paused && isStr(rec.paused.say))) rec.paused = { say: QUEUE_BROKE_SAY };
    }
  }
  const persist = () => {
    // finished entries are kept for the owner's list (the newest FINISHED_KEPT), open ones always
    const done = rec.entries.filter(e => !OPEN_STATES.includes(e.state));
    if (done.length > FINISHED_KEPT) { const drop = new Set(done.slice(0, done.length - FINISHED_KEPT)); rec.entries = rec.entries.filter(e => !drop.has(e)); }
    if (deps.file && !(unreadable && unreadable.kept === 'left_in_place')) writeJson(deps.file, rec, { mode: 0o600 });
  };
  const announce = () => { try { deps.broadcast({ type: 'blyg-publish', queue: { state: rec.state, open: rec.entries.filter(e => OPEN_STATES.includes(e.state)).length } }); } catch { /* nobody listening */ } };

  /** THE ONE FUNCTION THAT CHANGES AN ENTRY'S STATE. */
  function moveEntry(e, to, facts = {}) {
    if (!ENTRY_STATES.includes(to)) throw new Error(`queue entry: no such state ${String(to).slice(0, 20)}`);
    if (!ENTRY_MOVES[e.state] || !ENTRY_MOVES[e.state].includes(to)) throw new IllegalMove(`queue entry: cannot go from ${e.state} to ${to}`);
    Object.assign(e, facts, { state: to, at: clock().toISOString() });
    if (to !== 'needs_look') delete e.why;
    if (to !== 'filling') delete e.fill_since;
    persist(); announce();
    if (to === 'filling') fillWatch();
    return e;
  }
  /** THE ONE FUNCTION THAT CHANGES THE QUEUE'S STATE. `paused`: { say, run?, entry? } for a pause, what the owner reads and what lifts it. */
  function moveQueue(to, paused = null) {
    if (!QUEUE_STATES.includes(to)) throw new Error(`queue: no such state ${String(to).slice(0, 20)}`);
    if (!QUEUE_MOVES[rec.state].includes(to)) throw new IllegalMove(`queue: cannot go from ${rec.state} to ${to}`);
    rec.state = to;
    rec.paused = to === 'running' ? null : { say: String((paused && paused.say) || ''), run: (paused && paused.run) || '', entry: (paused && paused.entry) || '', at: clock().toISOString() };
    persist(); announce();
  }
  const pauseFor = (to, paused) => { if (rec.state === 'running' || (to === 'paused_for_error' && rec.state !== to)) moveQueue(to, paused); };

  const open = () => rec.entries.filter(e => OPEN_STATES.includes(e.state));
  const runnerBusy = () => RUN_LIVE.includes(pub.book.mode);
  const sameThread = (e, url, threadId) => e.page_url === url && e.thread_id === threadId;
  // the order the runner takes them in: one the owner asked to look at first, then the rest; each by press (a replaced press is pressed
  // again, so it goes to the back)
  const order = () => rec.entries.filter(e => e.state === 'queued').sort((a, b) => ((a.presence === 'asked_to_look') === (b.presence === 'asked_to_look') ? a.seq - b.seq : a.presence === 'asked_to_look' ? -1 : 1));
  // an entry never overtakes an earlier one from the same page that is set aside, waiting for a fill, or being given up
  const heldBack = e => rec.entries.some(x => x.seq < e.seq && x.page_url === e.page_url && ['needs_look', 'filling', 'giving_up'].includes(x.state));
  const next = () => order().find(e => !heldBack(e)) || null;

  // ---- what was pressed ---------------------------------------------------------------------------------------------------------
  // ONLY the thread(s) the press was for: this thread, and for "this and the ones above" the owner's unpublished threads above it
  function snapshotOf(page, here, scope) {
    const threads = page.threads || [];
    const at = threads.indexOf(here);
    const above = scope === 'above' && !isStandAlonePage(page) ? threads.slice(0, Math.max(0, at)).filter(t => t && eligibleThread(t).ok && !isPublishedThread(t)) : [];
    return [...above, here].map(t => ({ id: t.id, msgs: clone(t.msgs || []) }));
  }
  // the thread's first words, as the post is named by them: a /quote marker line is not a word (nor a message that is only one)
  const labelOf = t => words((t.msgs || []).filter(m => m && m.kind !== 'tools').map(m => withoutQuoteMarks(m.text)).find(x => x.trim()));
  // The page the run is given: as it is now, with the pressed threads as pressed (an agent's passage still pending there takes its state
  // from the page, matched by message and instruction), and the OTHER THREADS OF THE POST THIS ENTRY PUBLISHES (the pressed thread's
  // post, or the post it is added to) with what that post was last published with. Every other thread is passed through as it is on
  // the page (the runner reads no other thread's words: a new post takes only its own, a new version only its post's).
  // → { page } | { park } (a thread of this post whose published text cannot be known) | null (the page is gone)
  const postKey = p => String(p || '').replace(/\/+$/, '');
  function postOfEntry(e, live) {
    const here = (live.threads || []).find(t => t && t.id === e.thread_id);
    if (here && isPublishedThread(here)) return { permalink: postKey(here.blyg_published.permalink) };
    if (e.args.join === 'add' && e.args.post) return { id: String(e.args.post) };
    return null;
  }
  const inPost = (t, post) => !!post && isPublishedThread(t) && (post.permalink ? postKey(t.blyg_published.permalink) === post.permalink
    : postKey(t.blyg_published.permalink).split('/').pop() === post.id);
  function pageFor(e) {
    const live = deps.readPage(e.page_url);
    if (!live) return null;
    const post = postOfEntry(e, live);
    const pressed = new Map(e.snapshot.map(t => [t.id, t]));
    const threads = [];
    for (const t of live.threads || []) {
      if (!t) continue;
      const s = pressed.get(t.id);
      if (s) {
        for (const m of s.msgs) {
          if (!Array.isArray(m.gaps) || !m.gaps.some(g => g && g.mode === 'pending')) continue;
          const lm = (t.msgs || []).find(x => x && String(x.ts) === String(m.ts) && x.author === m.author);
          if (!lm || !Array.isArray(lm.gaps)) continue;
          m.gaps = m.gaps.map(g => (g && g.mode === 'pending' ? (lm.gaps.find(x => x && x.instruction === g.instruction && x.mode !== 'pending') || g) : g));
        }
        threads.push({ ...t, msgs: s.msgs });
      } else if (inPost(t, post)) {
        const msgs = pub.publishedMsgsOf(t);
        if (!msgs) return { park: 'unknown-text', live };
        threads.push({ ...t, msgs });
      } else threads.push(t);
    }
    return { page: { ...live, threads } };
  }
  // the agent's passages an entry's post may hold: in the pressed threads, as included
  function gapsOf(e, page) {
    const pressed = new Set(e.snapshot.map(t => t.id));
    return (page.threads || []).filter(t => pressed.has(t.id))
      .flatMap(t => includedMsgs(t, t.id === e.thread_id && e.args.extent === 'upto' ? e.args.upto : '').flatMap(m => (Array.isArray(m.gaps) ? m.gaps : []).filter(g => g && g.mode !== 'removed')));
  }

  // ---- the runner, fed one entry at a time ----------------------------------------------------------------------------------------
  // (the runner's presence for an entry: the owner moved on, or a look was promised or asked for)
  const presenceFor = e => (e.presence === 'away' ? 'away' : 'asked_to_look');
  async function startEntry(e, p, { drawerText = false } = {}) {
    const id = crypto.randomBytes(8).toString('hex');
    moveEntry(e, 'running', { run_id: id, started_by: 'queue' });
    const a = e.args;
    // (`shown` is the setting in force: the look promised at the press is carried by `presence`, the stricter of the two applying)
    const r = await pub.start({ page: p, threadId: e.thread_id, scope: a.scope, shown: deps.confirmNow(), join: a.join, post: a.post, postVersion: a.post_version,
      outside: e.presence === 'asked_to_look' ? 'replace' : a.outside, extent: a.extent, upto: a.upto, id, presence: presenceFor(e), drawerText, prompts: a.prompts || '' });
    if (r.ok && e.pressed_by === 'hub-link' && pub.log) pub.log.write(id, { ev: 'note', text: 'pressed from the owner\'s Hub (hub link)' });
    if (r.ok) { if (e.state === 'running' && pub.book.run.id === id) reconcile(e); return r; }
    if (e.state !== 'running') return r;
    // a refusal about the SITE or this machine (a failed pre-flight, a broken setting): the post goes back to its place and the queue
    // pauses with that sentence until the owner tries again; only a refusal about the post itself fails it
    if (r.about === 'site') { moveEntry(e, 'queued'); pauseFor('paused_for_site', { say: String(r.error || '') }); return r; }
    // (a forced look found before anything was written: set aside; a post the owner asked to look at that met the outside question
    // is set aside again, and the owner answers it in the dialog when they open it)
    if (r.park || r.outside) moveEntry(e, 'needs_look', { why: NEEDS_LOOK_WHY.includes(r.park) ? r.park : 'outside' });
    else moveEntry(e, 'failed', { failure: { say: String(r.error || '').slice(0, 400) } });
    return r;
  }
  // a post whose turn has come: given to the runner, or waiting for its agent's passage, or set aside, or failed (every way said)
  // A POST THE OWNER ASKED TO LOOK AT is never set aside again: it runs (first in the queue) and stops at the look, where the owner's
  // choice is what proceeds: a comment of the post whose published text is unknown is taken as it is in the drawer now (shown, said),
  // and a note changed outside the plugin is replaced (said; Cancel there puts it back exactly)
  async function turn(e) {
    const got = pageFor(e);
    if (!got) { moveEntry(e, 'failed', { failure: { say: GONE_SAY } }); return; }
    const asked = e.presence === 'asked_to_look';
    if (got.park && !asked) { moveEntry(e, 'needs_look', { why: got.park }); return; }
    const page = got.park ? got.live : got.page;
    if (gapsOf(e, page).some(g => g.mode === 'pending')) { moveEntry(e, 'filling', { fill_since: clock().toISOString() }); return; }
    // A HUB ADDITION is added to the earlier post AS IT STANDS NOW (an addition pressed while another to the same post was publishing
    // carries the version it saw): the same question the press asked, asked again; the post as it now is, or the entry is taken out
    if (e.pressed_by === 'hub-link' && e.args.join === 'add' && typeof pub.earlierPublicOf === 'function') {
      const now = pub.earlierPublicOf({ page, threadId: e.thread_id });
      if (!now || now.post !== e.args.post) { moveEntry(e, 'cancelled', { cancelled_for: 'cannot-add' }); return; }
      e.args.post_version = String(now.version);
    }
    await startEntry(e, page, { drawerText: !!got.park });
  }
  let pumping = Promise.resolve();
  /** Hand the runner the next entry while it is free and the queue runs. One pump at a time, in turn; an error is never swallowed. */
  function pump() {
    pumping = pumping.then(pumpOnce).catch(err => {
      say(`the queue stopped: ${String((err && err.stack) || err).slice(0, 600)}`);
      try { pauseFor('paused_for_error', { say: QUEUE_BROKE_SAY }); } catch { /* already paused */ }
    });
    return pumping;
  }
  async function pumpOnce() {
    for (let guard = 0; guard < 1000; guard++) {
      if (rec.state !== 'running' || runnerBusy()) return;
      const e = next();
      if (!e) return;
      try { await turn(e); } catch (err) {
        // one entry that throws when it comes up is failed with a plain sentence, and the queue goes on
        say(`a queued post broke when its turn came: ${String((err && err.stack) || err).slice(0, 600)}`);
        if (ENTRY_MOVES[e.state] && ENTRY_MOVES[e.state].includes('failed') && !(e.state === 'running' && RUN_LIVE.includes(pub.book.mode) && pub.book.run.id === e.run_id)) moveEntry(e, 'failed', { failure: { say: ENTRY_BROKE_SAY } });
        else throw err;
      }
    }
  }
  const soon = () => { setImmediate(() => pump()); };

  // ---- an entry waiting for an agent's fill ---------------------------------------------------------------------------------------
  let fillTimer = null;
  function fillWatch() {
    if (fillTimer || !rec.entries.some(e => e.state === 'filling')) return;
    fillTimer = setInterval(() => { try { fillCheck(); } catch (err) { say(`the fill check broke: ${err && err.message}`); pauseFor('paused_for_error', { say: QUEUE_BROKE_SAY }); } }, deps.fillCheckMs || FILL_CHECK_MS);
    if (fillTimer.unref) fillTimer.unref();
  }
  function fillCheck() {
    let any = false;
    for (const e of rec.entries.filter(x => x.state === 'filling')) {
      const got = pageFor(e);
      if (!got) { moveEntry(e, 'failed', { failure: { say: GONE_SAY } }); continue; }
      const gaps = got.page ? gapsOf(e, got.page) : [];
      if (gaps.some(g => g.mode === 'failed')) { moveEntry(e, 'failed', { failure: { say: FILL_FAILED_SAY } }); continue; }
      if (!gaps.some(g => g.mode === 'pending')) { moveEntry(e, 'queued'); any = true; continue; }
      if (clock() - new Date(e.fill_since) > fillWait) moveEntry(e, 'failed', { failure: { say: FILL_LATE_SAY } });
    }
    if (!rec.entries.some(e => e.state === 'filling')) { clearInterval(fillTimer); fillTimer = null; }
    if (any) soon();
  }

  // ---- how a run ended, for its entry -----------------------------------------------------------------------------------------------
  // later entries from the same page wait for the owner when an earlier one did not go out (never overtaking it)
  const holdSamePage = e => { for (const x of rec.entries) if (x.seq > e.seq && x.page_url === e.page_url && x.state === 'queued') moveEntry(x, 'needs_look', { why: 'earlier-failed' }); };
  const failureOf = run => ({ step: stepNamed(run.mode), line: String(run.failure_line || ''), quotes: !!run.quotes, mode: run.mode });
  // the owner is watching a run THEY started in the dialog that stops for their look: its failure is theirs to see (Try again offered)
  const watched = (e, run) => e.started_by === 'owner' && run.confirm === 'always';
  function failed(e, run) {
    holdSamePage(e);
    if (publishedNothing(run) && !watched(e, run)) {
      // the site certainly published nothing: the run is given up through the owner's own path (Start over), as ONE recorded step
      moveEntry(e, 'giving_up', { failure: failureOf(run) });
      giveUp(e, run);
      return;
    }
    moveEntry(e, 'failed', { failure: failureOf(run) });
    pauseFor('paused_for_run', { run: run.id, entry: e.id, say: '' });
  }
  function giveUp(e, run) {
    setImmediate(async () => {
      let r = null;
      try { r = await pub.abandon({ id: run.id, token: run.token }); } catch (err) { say(`giving a run up broke: ${err && err.message}`); r = null; }
      // (its end, `abandoned`, moves the entry on through onMove; a refusal or a failed abandon pauses the queue on that run)
      if (e.state === 'giving_up' && !(r && r.ok)) {
        moveEntry(e, 'failed');
        pauseFor('paused_for_run', { run: run.id, entry: e.id, say: '' });
      }
    });
  }
  /** Bring an entry in line with its run (a move was announced, or the companion restarted). */
  function reconcile(e) {
    const run = pub.book.run;
    if (!run || run.id !== e.run_id) return;
    if (run.mode === 'published' && (e.state === 'running' || e.state === 'failed')) {
      const p = run.published || {};
      moveEntry(e, 'published', { result: { title: String(p.title || run.title || ''), address: String(p.address || ''), version: Number(p.version || run.version) || 1 } });
    } else if (run.mode === 'cancelled' && e.state === 'running') moveEntry(e, 'cancelled');
    else if (run.mode === 'abandoned' && e.state === 'giving_up') moveEntry(e, 'failed');
    else if (run.mode === 'abandoned' && e.state === 'running') moveEntry(e, 'failed', { failure: { say: String((run.cleanup && run.cleanup.said) || 'This publish was given up.') } });
    else if ((FAILED_MODES.includes(run.mode) || INTERRUPTED_MODES.includes(run.mode) || run.mode === 'abandon_failed') && e.state === 'running') failed(e, run);
    else if (run.mode === 'abandon_failed' && (e.state === 'giving_up' || e.state === 'failed')) {
      if (e.state === 'giving_up') moveEntry(e, 'failed');
      pauseFor('paused_for_run', { run: run.id, entry: e.id, say: '' });
    }
  }
  /** Every move of the run (blyg-run deps.onMove). */
  function onMove(run) {
    const e = rec.entries.find(x => x.run_id && x.run_id === run.id);
    try { if (e) reconcile(e); } catch (err) { say(`following a run broke: ${String((err && err.stack) || err).slice(0, 600)}`); pauseFor('paused_for_error', { say: QUEUE_BROKE_SAY }); return; }
    if (RUN_FINISHED.includes(run.mode)) {
      if (rec.state === 'paused_for_run' && rec.paused && rec.paused.run === run.id) moveQueue('running');
      soon();
    }
  }

  // ---- the owner's press ------------------------------------------------------------------------------------------------------------
  /** "Try the queue again": a pause for the site or for an error is lifted (one named action, the owner's). */
  function resume() {
    if (!OWNER_RESUMES.includes(rec.state)) return { ok: false, status: 409, error: rec.state === 'running' ? 'Your publish queue is not paused.' : 'Your publish queue waits for the post that went wrong: open it to try again, start over or forget it.' };
    moveQueue('running');
    soon();
    return { ok: true };
  }
  /**
   * A press of the plane (or Publish version N, Add to earlier post, publish up to here). → today's answer `{ ok, view }` when the
   * runner was free and nothing waited (run at once, as before the queue); else `{ ok, queued: entry view, replaced }` (accepted at
   * once); or a refusal. `look`: the owner opened a post set aside for their look.
   */
  // `prompts`: the post's prompts choice (blyg-note.mjs PROMPT_MODES; '' the default or, for a new version, the post's own), carried
  // with the entry to the run (the drawer's checkbox; the Hub's reply box passes the same field through hub-link.mjs)
  async function press({ page, threadId, scope, shown, join = '', post = '', postVersion = '', outside = '', extent = 'whole', upto = '', look = false, by = 'owner', prompts = '' }) {
    if (prompts && !PROMPT_MODES.includes(prompts)) return { ok: false, status: 400, error: `prompts must be one of ${PROMPT_MODES.join(', ')}` };
    if (!PRESSED_BY.includes(by)) return { ok: false, status: 400, error: 'no such presser' };
    const away = by === 'hub-link';
    if (away && look) return { ok: false, status: 400, error: 'a look is asked for at the computer' };
    const inForce = deps.confirmNow();
    // (from the Hub, not set up: refused here; the runner's own refusal would start a run in a dialog nobody is at)
    if (!inForce && away) return { ok: false, status: 409, error: 'Publishing is not set up on your computer.' };
    // not set up (or broken): the runner says why, in its own words, and nothing is queued
    if (!inForce) return pub.start({ page, threadId, scope, shown, join, post, postVersion, outside, extent, upto, prompts });
    if (!SCOPES.includes(scope)) return { ok: false, status: 400, error: 'scope must be one or above' };
    if (!EXTENTS.includes(extent) || (extent === 'upto' ? !upto : !!upto)) return { ok: false, status: 400, error: 'no such extent' };
    if (join && !JOINS.includes(join)) return { ok: false, status: 400, error: 'no such choice' };
    if (outside && outside !== 'replace') return { ok: false, status: 400, error: 'outside must be replace or absent' };
    const here = (page.threads || []).find(t => t && t.id === threadId);
    if (!here) return { ok: false, status: 404, error: 'That thread is not on this page any more.' };
    if (shown !== inForce) return { ok: false, status: 409, error: settingChangedSay(shown, inForce) };
    // a pause the owner can lift is lifted by their next press (the site may be fixed by now; if not, it pauses again, said again)
    // (…by the owner at the computer: a press from the Hub never lifts one, the owner resolves it where they can see why)
    if (OWNER_RESUMES.includes(rec.state) && !away) moveQueue('running');
    const mineOpen = open().filter(e => sameThread(e, page.url, threadId));
    const args = { scope, join: join || '', post: String(post || ''), post_version: String(postVersion || ''), outside: outside || '', extent, upto: extent === 'upto' ? String(upto) : '', prompts: prompts || '' };
    const presence = look ? 'asked_to_look' : inForce === 'always' ? 'promised_look' : 'away';
    const parkedOne = mineOpen.find(e => e.state === 'needs_look');
    const waiting = rec.entries.some(e => e.state === 'queued');
    // (…unless an earlier post from this page is set aside, waiting for a fill or being given up: this one waits behind it)
    const behind = rec.entries.some(x => x.page_url === page.url && x.thread_id !== threadId && ['needs_look', 'filling', 'giving_up'].includes(x.state));
    // THE RUNNER IS FREE AND NOTHING WAITS: run it at once, as before the queue (the dialog shows what it does, the look included)
    // (a look the owner asked for runs at once whenever the runner is free: they are at the dialog now)
    if (!away && !runnerBusy() && rec.state === 'running' && (look || (!waiting && !behind))) {
      const r = await pub.start({ page, threadId, scope, shown, join, post, postVersion, outside, extent, upto, presence: look ? 'asked_to_look' : 'here', prompts });
      if (!r.ok) return r;
      // (a post of this thread set aside for a look is the one now run; anything else of this thread still waiting is replaced by it)
      const e = parkedOne || birth({ page, here, args, presence, state: 'running' });
      for (const x of mineOpen) if (x !== e && CANCELLABLE.includes(x.state)) moveEntry(x, 'cancelled', { replaced_by: e.id });
      if (e.state !== 'running') moveEntry(e, 'running', { args, presence, snapshot: snapshotOf(page, here, scope), run_id: r.view.id, started_by: 'owner' });
      else Object.assign(e, { run_id: r.view.id, started_by: 'owner' });
      persist(); reconcile(e); announce();
      return r;
    }
    // THE SAME THREAD, still waiting: its entry takes the latest press (latest wins) and goes to the BACK (a press is a press now);
    // pressed while its own entry runs, a new entry goes behind it (a new version)
    const same = mineOpen.find(e => CANCELLABLE.includes(e.state));
    if (same) {
      Object.assign(same, { args, presence, snapshot: snapshotOf(page, here, scope), label: labelOf(here), seq: ++rec.seq, pressed_at: clock().toISOString(), replaced: (same.replaced || 0) + 1, pressed_by: by });
      if (same.state !== 'queued') moveEntry(same, 'queued');
      else { persist(); announce(); }
      soon();
      return { ok: true, queued: viewOf(same), replaced: true };
    }
    if (open().length >= max) return { ok: false, status: 409, error: FULL_SAY };
    const e = birth({ page, here, args, presence, state: 'queued', by });
    soon();
    return { ok: true, queued: viewOf(e), replaced: false };
  }
  function birth({ page, here, args, presence, state, by = 'owner' }) {
    const e = { id: crypto.randomBytes(6).toString('hex'), seq: ++rec.seq, state, presence, pressed_by: by, at: clock().toISOString(), pressed_at: clock().toISOString(),
      page_url: page.url, page_title: words(page.title, 12), thread_id: here.id, label: labelOf(here), kind: isPublishedThread(here) || args.join === 'add' ? 'edit' : 'new',
      post: isPublishedThread(here) ? String(here.blyg_published.permalink || '') : args.join === 'add' ? String(args.post || '') : '', args, snapshot: snapshotOf(page, here, args.scope), replaced: 0 };
    rec.entries.push(e);
    persist(); announce();
    return e;
  }
  /** The owner's Cancel on an entry not yet running: nothing was written, nothing is. */
  function cancel({ entry }) {
    const e = rec.entries.find(x => x.id === String(entry || ''));
    if (!e) return { ok: false, status: 404, error: 'That post is not in the queue any more.' };
    if (!CANCELLABLE.includes(e.state)) return { ok: false, status: 409, error: e.state === 'running' ? 'This post is already being published; it can be stopped from its own steps.' : 'This post is no longer waiting.' };
    moveEntry(e, 'cancelled');
    soon();
    return { ok: true };
  }

  // ---- what the owner's client sees -----------------------------------------------------------------------------------------------
  function viewOf(e) {
    const at = order().indexOf(e);
    const ahead = at < 0 ? 0 : at + (runnerBusy() ? 1 : 0);
    return { id: e.id, state: e.state, presence: e.presence || 'away', page_url: e.page_url, page_title: e.page_title || '', thread_id: e.thread_id, label: e.label || '', kind: e.kind || 'new',
      pressed_at: e.pressed_at || '', at: e.at, ahead, run: e.run_id || '', started_by: e.started_by || '', why: e.why || '', replaced: e.replaced || 0,
      result: e.result || null, failure: e.failure || null, paused_by: !!(rec.paused && rec.paused.entry === e.id), pressed_by: PRESSED_BY.includes(e.pressed_by) ? e.pressed_by : 'owner',
      replaced_by: e.replaced_by || '', cancelled_for: ENTRY_CANCEL_REASONS.includes(e.cancelled_for) ? e.cancelled_for : '' };
  }
  function view() {
    return { state: rec.state, max, paused: rec.paused ? { say: rec.paused.say, at: rec.paused.at } : null, entries: rec.entries.map(viewOf),
      ...(unreadable ? { unreadable: { say: unreadable.say, file: unreadable.file, at: unreadable.at } } : {}) };
  }

  // ---- a companion restart: the run record was read first (an unfinished run is interrupted); bring each entry in line ------------
  try {
    for (const e of rec.entries.filter(x => x.state === 'running' || x.state === 'giving_up')) {
      const run = pub.book.run;
      if (run && run.id === e.run_id) {
        reconcile(e);
        // (stopped in the middle of giving a run up: finish it)
        if (e.state === 'giving_up' && RUN_LIVE.includes(pub.book.mode)) giveUp(e, run);
      } else if (e.state === 'running') moveEntry(e, 'queued');   // its run never got past the pre-flight: nothing was written
      else moveEntry(e, 'failed');
    }
    if (rec.state === 'paused_for_run' && !(rec.paused && pub.book.run.id === rec.paused.run && RUN_LIVE.includes(pub.book.mode))) moveQueue('running');
    if (rec.state === 'running' && RUN_LIVE.includes(pub.book.mode) && !rec.entries.some(x => x.run_id === pub.book.run.id && ['running', 'giving_up'].includes(x.state))) {
      // a failed run nobody in the queue is giving up: the queue waits for the owner on it, and says so
      if (FAILED_MODES.includes(pub.book.mode) || INTERRUPTED_MODES.includes(pub.book.mode) || pub.book.mode === 'abandon_failed') pauseFor('paused_for_run', { run: pub.book.run.id, say: '' });
    }
  } catch (err) {
    say(`bringing the queue in line after a restart broke: ${String((err && err.stack) || err).slice(0, 600)}`);
    try { pauseFor('paused_for_error', { say: QUEUE_BROKE_SAY }); } catch { /* already */ }
  }
  persist();
  fillWatch();
  soon();

  return { press, cancel, resume, view, onMove, pump, moveEntry, moveQueue, get record() { return rec; }, stop() { if (fillTimer) clearInterval(fillTimer); fillTimer = null; } };
}
