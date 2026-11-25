// blyg-queue.mjs — the PUBLISH QUEUE: every press of "Publish as blyg" is accepted at once and published in order, in the
// background, by the one runner (blyg-run.mjs). The queue never runs anything itself: it hands the runner one entry at a time
// and starts the next when the run ends. It lives in a file beside the run record (0600), so a restart finds it.
//
// AN ENTRY'S STATE, named once, held in ONE field (`entry.state`), changed by ONE function (moveEntry) that refuses a move
// ENTRY_MOVES does not list:
//   queued      waiting for the runner (the owner pressed and moved on)
//   looking     waiting for the runner, ahead of the queued ones: the owner asked to look at a post set aside for them; its run
//               stops at `planned` for that look
//   filling     its turn came while an agent's passage in it was still being written: it waits for the fill (bounded, FILL_WAIT_MS)
//               and the queue goes on with the next entry; filled → queued again (it is then next), failed or too late → failed
//   needs_look  set aside before anything was written, because the policy forces a look (blyg-run LOOK_FORCED: a comment the post
//               had would be left out, or a note changed outside the plugin would be replaced), or because an earlier post from the
//               same page did not go out; the queue goes on without it
//   running     the runner has it (from the pre-flight until the run ends; with confirm 'always' that includes waiting at the look)
//   published   its run went live
//   failed      its run, or its start, failed (`failure`: what the owner reads); a run that may have reached the site PAUSES the queue
//   cancelled   the owner cancelled it before it ran (nothing written), or cancelled its run at the look
//
// THE QUEUE'S OWN STATE, one field (`state`), moved only by moveQueue:
//   running     entries are handed to the runner as it becomes free
//   paused      a run failed where the site may have published (failed or interrupted publish, interrupted_unknown, the site's
//               abandon failed): nothing more is started until the owner resolves THAT run (Try again, Forget, Start over); its
//               end (published or abandoned) resumes the queue
//
// WHAT GOES OUT is what was pressed: the entry keeps the messages of the page's publishable threads as they were at the press (a
// later press of the same thread replaces it while it waits). When its turn comes it is given the page as it is THEN (what has been
// published since, so each entry sees the one before), with those threads' messages as pressed; an agent's passage still being
// written is taken from the page when it lands. A post set aside for a look is looked at as the thread is when the owner opens it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeJson, readJsonState } from './fsjson.mjs';
import { RUN_LIVE, RUN_FINISHED, FAILED_MODES, INTERRUPTED_MODES, publishedNothing, stepNamed, IllegalMove, EXTENTS, JOINS, settingChangedSay } from './blyg-run.mjs';
import { eligibleThread, isPublishedThread, includedMsgs, SCOPES } from './blyg-note.mjs';

export const ENTRY_STATES = Object.freeze(['queued', 'looking', 'filling', 'needs_look', 'running', 'published', 'failed', 'cancelled']);
export const ENTRY_MOVES = Object.freeze({
  queued: Object.freeze(['running', 'filling', 'needs_look', 'cancelled']),
  looking: Object.freeze(['running', 'cancelled']),
  filling: Object.freeze(['queued', 'failed', 'cancelled']),
  needs_look: Object.freeze(['looking', 'queued', 'running', 'cancelled']),
  // (running → needs_look: the start found a forced look and wrote nothing; → queued: the companion stopped before anything was written)
  running: Object.freeze(['published', 'failed', 'cancelled', 'needs_look', 'queued']),
  // (the owner's Try again on a run that failed and paused the queue went live after all)
  failed: Object.freeze(['published']),
  published: Object.freeze([]),
  cancelled: Object.freeze([]),
});
/** The states an entry is in while it still counts against the limit (it has not finished). */
export const OPEN_STATES = Object.freeze(['queued', 'looking', 'filling', 'needs_look', 'running']);
/** …and while the owner can still cancel it (nothing of it has been written). */
export const CANCELLABLE = Object.freeze(['queued', 'looking', 'filling', 'needs_look']);
export const QUEUE_STATES = Object.freeze(['running', 'paused']);
export const QUEUE_MOVES = Object.freeze({ running: Object.freeze(['paused']), paused: Object.freeze(['running']) });
/** Why an entry needs the owner's look: the policy's forced reasons (blyg-run LOOK_FORCED), or an earlier post from the same page
 *  that did not go out. */
export const NEEDS_LOOK_WHY = Object.freeze(['left-out', 'outside', 'earlier-failed']);
/** How an entry came to the runner, one value set once: `owner` (the press found the runner free and the dialog ran it at once, as
 *  before the queue) or `queue` (the queue started it later: a run that then waits at the look is told to the owner by a notice). */
export const STARTED_BY = Object.freeze(['owner', 'queue']);
export const QUEUE_MAX = 20;
export const FINISHED_KEPT = 20;
export const FILL_WAIT_MS = 5 * 60 * 1000;
export const FILL_CHECK_MS = 2000;
export const FULL_SAY = `${QUEUE_MAX} posts are already waiting to go out. Wait for one to go out, or cancel one, then press again.`;
export const GONE_SAY = 'That page is no longer kept on the companion, so this post was not published.';
export const FILL_FAILED_SAY = 'An agent’s passage in this post could not be written, so it was not published. Fill it, write it yourself or remove it, then press again.';
export const FILL_LATE_SAY = 'An agent’s passage in this post was still being written after five minutes, so it was not published. Press again once it is filled.';
export const STOPPED_SAY = 'The companion stopped before this post went out.';

const nowIso = () => new Date().toISOString();
const clone = v => JSON.parse(JSON.stringify(v));
const words = (s, n = 10) => String(s || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ').slice(0, 90);

/**
 * deps: { file, publisher (createPublisher's), readPage(url), confirmNow() → 'never' | 'always' | '' (the setting in force, '' when
 *         not set up), broadcast(ev), now() → Date (tests), fillCheckMs, fillWaitMs, max }
 */
export function createQueue(deps) {
  const pub = deps.publisher;
  const clock = () => (deps.now ? deps.now() : new Date());
  const max = deps.max || QUEUE_MAX;
  const fillWait = deps.fillWaitMs !== undefined ? deps.fillWaitMs : FILL_WAIT_MS;
  let rec = { state: 'running', paused_by: null, seq: 0, entries: [] };
  {
    const got = deps.file ? readJsonState(deps.file) : { state: 'missing' };
    const v = got.state === 'ok' ? got.value : null;
    if (v && QUEUE_STATES.includes(v.state) && Array.isArray(v.entries)) {
      rec = { state: v.state, paused_by: v.paused_by || null, seq: Number(v.seq) || 0,
        entries: v.entries.filter(e => e && ENTRY_STATES.includes(e.state) && typeof e.id === 'string') };
    }
  }
  const persist = () => {
    // finished entries are kept for the owner's list (the newest FINISHED_KEPT), open ones always
    const done = rec.entries.filter(e => !OPEN_STATES.includes(e.state));
    if (done.length > FINISHED_KEPT) { const drop = new Set(done.slice(0, done.length - FINISHED_KEPT)); rec.entries = rec.entries.filter(e => !drop.has(e)); }
    if (deps.file) writeJson(deps.file, rec, { mode: 0o600 });
  };
  const announce = () => { try { deps.broadcast({ type: 'blyg-publish', queue: { state: rec.state, open: rec.entries.filter(e => OPEN_STATES.includes(e.state)).length } }); } catch { /* nobody listening */ } };

  /** THE ONE FUNCTION THAT CHANGES AN ENTRY'S STATE. */
  function moveEntry(e, to, facts = {}) {
    if (!ENTRY_STATES.includes(to)) throw new Error(`queue entry: no such state ${String(to).slice(0, 20)}`);
    if (!ENTRY_MOVES[e.state].includes(to)) throw new IllegalMove(`queue entry: cannot go from ${e.state} to ${to}`);
    Object.assign(e, facts, { state: to, at: clock().toISOString() });
    if (to !== 'needs_look') delete e.why;
    if (to !== 'filling') delete e.fill_since;
    persist(); announce();
    if (to === 'filling') fillWatch();
    return e;
  }
  /** THE ONE FUNCTION THAT CHANGES THE QUEUE'S STATE. */
  function moveQueue(to, facts = {}) {
    if (!QUEUE_STATES.includes(to)) throw new Error(`queue: no such state ${String(to).slice(0, 20)}`);
    if (!QUEUE_MOVES[rec.state].includes(to)) throw new IllegalMove(`queue: cannot go from ${rec.state} to ${to}`);
    rec.state = to;
    rec.paused_by = to === 'paused' ? facts.paused_by : null;
    persist(); announce();
  }

  const open = () => rec.entries.filter(e => OPEN_STATES.includes(e.state));
  const runnerBusy = () => RUN_LIVE.includes(pub.book.mode);
  const sameThread = (e, url, threadId) => e.page_url === url && e.thread_id === threadId;
  // the order the runner takes them in: looking first, then queued; each by when it was pressed
  const order = () => [...rec.entries.filter(e => e.state === 'looking'), ...rec.entries.filter(e => e.state === 'queued')].sort((a, b) => (a.state === b.state ? a.seq - b.seq : a.state === 'looking' ? -1 : 1));
  // an entry never overtakes an earlier one from the same page that is set aside or waiting for a fill (two entries for one post
  // run in order, each seeing the one before)
  const heldBack = e => rec.entries.some(x => x.seq < e.seq && x.page_url === e.page_url && (x.state === 'needs_look' || x.state === 'filling'));
  const next = () => order().find(e => !heldBack(e)) || null;

  // ---- what was pressed ---------------------------------------------------------------------------------------------------------
  // the messages of the page's publishable threads as they are now (that is all a post can be made of)
  const snapshotOf = page => (page.threads || []).filter(t => t && eligibleThread(t).ok).map(t => ({ id: t.id, msgs: clone(t.msgs || []) }));
  const labelOf = t => words(((t.msgs || []).find(m => m && m.kind !== 'tools') || {}).text);
  // the page as it is now, with the pressed threads' messages as pressed; an agent's passage still pending in what was pressed takes
  // its state from the page (the fill lands there), matched by message and instruction
  function pageFor(e) {
    const live = deps.readPage(e.page_url);
    if (!live) return null;
    const snap = new Map((e.snapshot || []).map(t => [t.id, t]));
    for (const s of snap.values()) {
      const lt = (live.threads || []).find(t => t && t.id === s.id);
      if (!lt) continue;
      for (const m of s.msgs) {
        if (!Array.isArray(m.gaps) || !m.gaps.some(g => g && g.mode === 'pending')) continue;
        const lm = (lt.msgs || []).find(x => x && String(x.ts) === String(m.ts) && x.author === m.author);
        if (!lm || !Array.isArray(lm.gaps)) continue;
        m.gaps = m.gaps.map(g => (g && g.mode === 'pending' ? (lm.gaps.find(x => x && x.instruction === g.instruction && x.mode !== 'pending') || g) : g));
      }
    }
    return { ...live, threads: (live.threads || []).filter(t => t && snap.has(t.id)).map(t => ({ ...t, msgs: snap.get(t.id).msgs })) };
  }
  // the threads an entry's post can be made of: its own (up to its point), those above it for `above`, and every published one
  // (a new version, or adding to an earlier post)
  function gapsOf(e, page) {
    const threads = page.threads || [];
    const at = threads.findIndex(t => t.id === e.thread_id);
    if (at < 0) return [];
    const here = threads[at];
    const pick = [here, ...(e.args.scope === 'above' ? threads.slice(0, at) : []), ...((isPublishedThread(here) || e.args.join === 'add') ? threads.filter(isPublishedThread) : [])];
    return pick.flatMap(t => includedMsgs(t, t === here && e.args.extent === 'upto' ? e.args.upto : '').flatMap(m => (Array.isArray(m.gaps) ? m.gaps : []).filter(g => g && g.mode !== 'removed')));
  }

  // ---- the runner, fed one entry at a time ----------------------------------------------------------------------------------------
  async function startEntry(e) {
    const looked = e.state === 'looking';
    const id = crypto.randomBytes(8).toString('hex');
    moveEntry(e, 'running', { run_id: id, started_by: 'queue' });
    const p = pageFor(e);
    if (!p) { moveEntry(e, 'failed', { failure: { say: GONE_SAY } }); return { ok: false, status: 404, error: GONE_SAY }; }
    const a = e.args;
    const r = await pub.start({ page: p, threadId: e.thread_id, scope: a.scope, shown: deps.confirmNow(), join: a.join, post: a.post, postVersion: a.post_version,
      outside: a.outside, extent: a.extent, upto: a.upto, id, unattended: !looked, look: looked });
    if (r.ok) { if (e.state === 'running' && pub.book.run.id === id) reconcile(e); return r; }
    if (e.state !== 'running') return r;
    // (a forced look found before anything was written: set aside; a post the owner asked to look at that met the outside question
    // is set aside again, and the owner answers it in the dialog when they open it)
    if (r.park || r.outside) moveEntry(e, 'needs_look', { why: NEEDS_LOOK_WHY.includes(r.park) ? r.park : 'outside' });
    else moveEntry(e, 'failed', { failure: { say: String(r.error || '').slice(0, 400) } });
    return r;
  }
  let pumping = Promise.resolve();
  /** Hand the runner the next entry while it is free and the queue is not paused. One pump at a time, in turn. */
  function pump() { pumping = pumping.then(pumpOnce).catch(() => {}); return pumping; }
  async function pumpOnce() {
    for (let guard = 0; guard < 1000; guard++) {
      if (rec.state === 'paused' || runnerBusy()) return;
      const e = next();
      if (!e) return;
      // an agent's passage still being written: the entry waits for the fill, and the queue goes on
      if (e.state === 'queued') {
        const p = pageFor(e);
        if (p && gapsOf(e, p).some(g => g.mode === 'pending')) { moveEntry(e, 'filling', { fill_since: clock().toISOString() }); continue; }
      }
      await startEntry(e);
    }
  }
  const soon = () => { setImmediate(() => pump()); };

  // ---- an entry waiting for an agent's fill ---------------------------------------------------------------------------------------
  let fillTimer = null;
  function fillWatch() {
    if (fillTimer || !rec.entries.some(e => e.state === 'filling')) return;
    fillTimer = setInterval(fillCheck, deps.fillCheckMs || FILL_CHECK_MS);
    if (fillTimer.unref) fillTimer.unref();
  }
  function fillCheck() {
    let any = false;
    for (const e of rec.entries.filter(x => x.state === 'filling')) {
      const p = pageFor(e);
      if (!p) { moveEntry(e, 'failed', { failure: { say: GONE_SAY } }); continue; }
      const gaps = gapsOf(e, p);
      if (gaps.some(g => g.mode === 'failed')) { moveEntry(e, 'failed', { failure: { say: FILL_FAILED_SAY } }); continue; }
      if (!gaps.some(g => g.mode === 'pending')) { persist(); moveEntry(e, 'queued'); any = true; continue; }
      if (clock() - new Date(e.fill_since) > fillWait) moveEntry(e, 'failed', { failure: { say: FILL_LATE_SAY } });
    }
    if (!rec.entries.some(e => e.state === 'filling')) { clearInterval(fillTimer); fillTimer = null; }
    if (any) soon();
  }

  // ---- how a run ended, for its entry -----------------------------------------------------------------------------------------------
  const pauseFor = (run, e) => { if (rec.state === 'running') moveQueue('paused', { paused_by: { run: run.id, entry: e ? e.id : '' } }); };
  // later entries from the same page wait for the owner when an earlier one did not go out (never overtaking it)
  const holdSamePage = e => { for (const x of rec.entries) if (x.seq > e.seq && x.page_url === e.page_url && x.state === 'queued') moveEntry(x, 'needs_look', { why: 'earlier-failed' }); };
  function failed(e, run) {
    moveEntry(e, 'failed', { failure: { step: stepNamed(run.mode), line: String(run.failure_line || ''), quotes: !!run.quotes, mode: run.mode } });
    holdSamePage(e);
    if (!publishedNothing(run)) { pauseFor(run, e); return; }
    // the site certainly published nothing: give the run up through the owner's own path (Start over), then go on
    setImmediate(async () => {
      let r = null;
      try { r = await pub.abandon({ id: run.id, token: run.token }); } catch { r = null; }
      if ((!r || !r.ok) && pub.book.run.id === run.id && RUN_LIVE.includes(pub.book.mode)) pauseFor(pub.book.run, e);
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
    else if (run.mode === 'abandoned' && e.state === 'running') moveEntry(e, 'failed', { failure: { say: String((run.cleanup && run.cleanup.said) || 'This publish was given up.') } });
    else if ((FAILED_MODES.includes(run.mode) || INTERRUPTED_MODES.includes(run.mode) || run.mode === 'abandon_failed') && e.state === 'running') failed(e, run);
    else if (run.mode === 'abandon_failed' && e.state === 'failed') pauseFor(run, e);
  }
  /** Every move of the run (blyg-run deps.onMove). */
  function onMove(run) {
    const e = rec.entries.find(x => x.run_id && x.run_id === run.id);
    if (e) reconcile(e);
    if (RUN_FINISHED.includes(run.mode)) {
      if (rec.state === 'paused' && rec.paused_by && rec.paused_by.run === run.id) moveQueue('running');
      soon();
    }
  }

  // ---- the owner's press ------------------------------------------------------------------------------------------------------------
  /**
   * A press of the plane (or Publish version N, Add to earlier post, publish up to here). → today's answer `{ ok, view }` when the
   * runner was free and nothing waited (the dialog runs it at once, as before the queue); else `{ ok, queued: entry view, replaced }`
   * (accepted at once); or a refusal. `look`: the owner opened a post set aside for their look.
   */
  async function press({ page, threadId, scope, shown, join = '', post = '', postVersion = '', outside = '', extent = 'whole', upto = '', look = false }) {
    const inForce = deps.confirmNow();
    if (!SCOPES.includes(scope)) return { ok: false, status: 400, error: 'scope must be one or above' };
    if (!EXTENTS.includes(extent) || (extent === 'upto' ? !upto : !!upto)) return { ok: false, status: 400, error: 'no such extent' };
    if (join && !JOINS.includes(join)) return { ok: false, status: 400, error: 'no such choice' };
    if (outside && outside !== 'replace') return { ok: false, status: 400, error: 'outside must be replace or absent' };
    // not set up (or broken): the runner says why, in its own words, and nothing is queued
    if (!inForce) return pub.start({ page, threadId, scope, shown, join, post, postVersion, outside, extent, upto });
    const here = (page.threads || []).find(t => t && t.id === threadId);
    if (!here) return { ok: false, status: 404, error: 'That comment is not on this page any more.' };
    const mineOpen = open().filter(e => sameThread(e, page.url, threadId));
    const args = { scope, join, post, post_version: String(postVersion || ''), outside, extent, upto: extent === 'upto' ? String(upto) : '' };
    const parkedOne = mineOpen.find(e => e.state === 'needs_look');
    const waiting = rec.entries.some(e => e.state === 'queued' || e.state === 'looking');
    // THE RUNNER IS FREE AND NOTHING WAITS: run it at once, as before the queue (the dialog shows what it does, the look included)
    // (…unless an earlier post from this page is set aside or waiting for a fill: this one then waits behind it, never overtaking)
    const behind = rec.entries.some(x => x.page_url === page.url && x.thread_id !== threadId && (x.state === 'needs_look' || x.state === 'filling'));
    if (inForce && !runnerBusy() && rec.state === 'running' && !waiting && !behind) {
      const r = await pub.start({ page, threadId, scope, shown, join, post, postVersion, outside, extent, upto, look });
      if (!r.ok) return r;
      // (a post of this thread set aside for a look is the one now run; anything else of this thread still waiting is replaced by it)
      const e = parkedOne || birth({ page, here, args, state: 'running' });
      for (const x of mineOpen) if (x !== e && CANCELLABLE.includes(x.state)) moveEntry(x, 'cancelled', { replaced_by: e.id });
      if (e.state !== 'running') moveEntry(e, 'running', { args, snapshot: snapshotOf(page), run_id: r.view.id, started_by: 'owner' });
      else Object.assign(e, { run_id: r.view.id, started_by: 'owner' });
      persist(); reconcile(e); announce();
      return r;
    }
    if (shown !== inForce) return { ok: false, status: 409, error: inForce ? settingChangedSay(shown, inForce) : 'Publish as blyg is not set up on the companion.' };
    // THE SAME THREAD, still waiting: its entry takes the latest text (latest wins); pressed while its own entry runs, a new entry
    // goes behind it (a new version)
    const same = mineOpen.find(e => CANCELLABLE.includes(e.state));
    const to = look ? 'looking' : 'queued';
    if (same) {
      Object.assign(same, { args, snapshot: snapshotOf(page), label: labelOf(here), pressed_at: clock().toISOString(), replaced: (same.replaced || 0) + 1 });
      if (same.state !== to && ENTRY_MOVES[same.state].includes(to)) moveEntry(same, to);
      else { persist(); announce(); }
      soon();
      return { ok: true, queued: viewOf(same), replaced: true };
    }
    if (open().length >= max) return { ok: false, status: 409, error: FULL_SAY };
    const e = birth({ page, here, args, state: to });
    soon();
    return { ok: true, queued: viewOf(e), replaced: false };
  }
  function birth({ page, here, args, state }) {
    const e = { id: crypto.randomBytes(6).toString('hex'), seq: ++rec.seq, state, at: clock().toISOString(), pressed_at: clock().toISOString(),
      page_url: page.url, page_title: words(page.title, 12), thread_id: here.id, label: labelOf(here), kind: isPublishedThread(here) || args.join === 'add' ? 'edit' : 'new',
      post: isPublishedThread(here) ? String(here.blyg_published.permalink || '') : args.join === 'add' ? String(args.post || '') : '', args, snapshot: snapshotOf(page), replaced: 0 };
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
    const ord = order();
    const at = ord.indexOf(e);
    const ahead = at < 0 ? 0 : at + (runnerBusy() ? 1 : 0);
    return { id: e.id, state: e.state, page_url: e.page_url, page_title: e.page_title || '', thread_id: e.thread_id, label: e.label || '', kind: e.kind,
      pressed_at: e.pressed_at, at: e.at, ahead, run: e.run_id || '', started_by: e.started_by || '', why: e.why || '', replaced: e.replaced || 0,
      result: e.result || null, failure: e.failure || null, paused_by: !!(rec.paused_by && rec.paused_by.entry === e.id) };
  }
  function view() { return { state: rec.state, max, entries: rec.entries.map(viewOf) }; }

  // ---- a companion restart: the run record was read first (an unfinished run is interrupted); bring each entry in line ------------
  for (const e of rec.entries.filter(x => x.state === 'running')) {
    if (pub.book.run && pub.book.run.id === e.run_id) reconcile(e);
    // its run never got past the pre-flight (nothing was written): it waits again
    else moveEntry(e, 'queued');
  }
  if (rec.state === 'paused' && !(rec.paused_by && pub.book.run.id === rec.paused_by.run && RUN_LIVE.includes(pub.book.mode))) moveQueue('running');
  fillWatch();
  soon();

  return { press, cancel, view, onMove, pump, moveEntry, moveQueue, get record() { return rec; }, stop() { if (fillTimer) clearInterval(fillTimer); fillTimer = null; } };
}
