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
// ONE RUN AT A TIME for the whole companion: while any run is not finished a second start
// is refused here; the owner's presses meanwhile wait in the publish QUEUE (blyg-queue.mjs), which
// feeds this runner one entry at a time. A run survives a drawer reload (it lives here and
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
import { renderShortNote, PROMPT_MODES, DEFAULT_PROMPTS, promptsFactsOf, ownText, includedMsgs, linkTargetsOf, blygItemOf, LINK_STUB_MAX, eligibleThread, isPublishedThread, isPublishableMsg, slugOf, dayOf, newBlygId, isBlygId, showsLiquid, readingOf, changelogLine, stubOfPage, stubTargetOf, isStandAlonePage, hashOf, postTextOf, changelogPrompt, changelogAnswerOk, SCOPES, LIMITS } from './blyg-note.mjs';
import { createRunLog, LOG_DIR_NAME } from './blyg-log.mjs';
import { samePage } from './blyg.mjs';
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
  // the pre-flight passed (the note is written: drafted), or it refused / the start stopped before writing: back to where it was
  // (idle, or the finished run the owner last saw, as it was)
  checking: Object.freeze(['drafted', 'idle', 'published', 'cancelled', 'abandoned']),
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
/** The modes in which the site certainly published nothing: before apply, apply itself failed or was interrupted (it works in a
 *  temporary copy, and only publish pushes), or apply was done and the companion stopped before publish began (`applied` moves to
 *  `publishing` before the publish command is started). A failed or interrupted PUBLISH may have pushed, so it is not one of these;
 *  nor is interrupted_unknown (its step is not known). */
export const NOTHING_PUBLISHED_MODES = Object.freeze([...PRE_APPLY_MODES, 'failed_apply', I.applying, I.applied]);
/** The modes in which the publish may or may not have reached the site (a push may have happened): for a new VERSION the note is
 *  then left as it is, the owner is told in one sentence what to do (EDIT_UNSURE_SAY), and Forget is offered beside abandon. */
export const PUBLISH_UNSURE_MODES = Object.freeze(['failed_publish', I.publishing, 'interrupted_unknown']);
export const EDIT_UNSURE_SAY = 'Your site may already have published the new version, so your note was left as it is: look at the post on your site, and if the new version is not there, publish it from your site.';
/** What abandoning, cancelling or forgetting a run did to the note, one named outcome (`cleanup.outcome`):
 *    undone     the draft was taken away (a new post) or the published text was put back (a new version)
 *    left       nothing was undone: the note is as the run left it (the site may hold it, or the record could not be trusted)
 *    forgotten  the run was ended here only: nothing was run on the site and nothing was removed */
export const CLEANUP_OUTCOMES = Object.freeze(['undone', 'left', 'forgotten']);
const cleanupOf = (outcome, said) => {
  if (!CLEANUP_OUTCOMES.includes(outcome)) throw new Error(`cleanup: no such outcome ${outcome}`);
  return { outcome, said: String(said || '') };
};
/** The modes in which no prepare or plan has begun (so a `discard` has nothing to undo). */
export const NOTHING_BEGUN_MODES = Object.freeze(['drafted', I.drafted]);
export class IllegalMove extends Error {}

// ---- what kind of run, and whether the owner looks first ------------------------------------------------------------
/** A run publishes a NEW post, or a new VERSION of one already published from here (the same note file, id and address, rewritten,
 *  and the site's commands in their edit form: blyg-home COMMAND_FOR). One field, `run.kind`, set when the run is drafted. */
export const RUN_KINDS = Object.freeze(['new', 'edit']);
/** WHERE A NEW COMMENT GOES when another thread of the owner's on the same page is already a post published from here (the owner's
 *  one choice in the dialog, sent with the start as `join`; '' when no choice was offered):
 *    add   the comment is added to that post (the most recent one from this page): a new VERSION of it, kind 'edit'
 *    new   the comment becomes a post of its own, as when there is no earlier post */
export const JOINS = Object.freeze(['add', 'new']);
/** WHERE A NEW VERSION'S CHANGELOG LINE CAME FROM (both are a program's: the site marks either `"generated": true`), one value on the
 *  run (`changelog_from`), moved only by changelogFromMove:
 *    program-fixed  the fixed line written from the difference (changelogLine): always there first
 *    program-model  a model's one line about the two texts, used when changelogAnswerOk accepted it within CHANGELOG_ASK_MS */
export const CHANGELOG_FROM = Object.freeze(['program-fixed', 'program-model']);
export const CHANGELOG_FROM_MOVES = Object.freeze({ 'program-fixed': Object.freeze(['program-model']), 'program-model': Object.freeze([]) });
export function changelogFromMove(from, to) {
  if (!CHANGELOG_FROM.includes(to) || !(CHANGELOG_FROM_MOVES[from] || []).includes(to)) throw new IllegalMove(`changelog line: cannot go from ${from} to ${to}`);
  return to;
}
export const CHANGELOG_ASK_MS = 15000;
export const ADD_CHANGED_SAY = 'Your earlier post from this page has changed since this was shown. Nothing was started. Close this and open it again.';
// A POST CHANGED OUTSIDE THE PLUGIN: its note on disk is still that post (same id, same place, a plain file) but not the text the
// plugin last wrote (its hash differs: the owner, or an agent for them, edited it and may have published it with the site's own
// command). A new version, or adding a comment, rebuilds the whole note from the page's comments, so it would undo that edit. The
// owner is ALWAYS asked first (whatever `confirm` says), before anything is written, with two named answers (OUTSIDE_ANSWERS):
//   keep     "Keep the post as it is": the drawer sends nothing more; nothing is written
//   replace  "Replace it with this thread's text": the start is sent again with `outside: 'replace'` and goes ahead; the post's
//            record then holds the new note's hash, so the next version is an ordinary one
// A start that meets such a note without `outside: 'replace'` is answered 409 with `outside: { say, lost }` (`lost`: how many lines
// of the note on disk the new text would not keep; a count, never the text) and nothing is written.
export const OUTSIDE_ANSWERS = Object.freeze(['keep', 'replace']);
export const OUTSIDE_SAY = 'Your post was changed outside the plugin since it was last published from here. Publishing from here rebuilds the whole post from this page\'s comments, so the changes made outside the plugin would be lost.';
const linesLost = (onDisk, next) => {
  const keep = new Set(String(next).split('\n').map(l => l.trim()));
  return String(onDisk).replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').map(l => l.trim()).filter(l => l && !keep.has(l)).length;
};
// HOW MUCH OF THE THREAD a post takes, named once (`run.extent`, from the start's `extent`):
//   whole  the thread's every message of the owner's (the header's plane)
//   upto   up to and including one message (`upto`: its time stamp; that message's own plane); later ones stay private
// The post's record keeps the point per thread (`points: { [thread id]: ts }`; a thread not named is whole), so a later version
// keeps it unless the owner moves it. A point only moves FORWARD: choosing an earlier message than the one a published post
// already reaches is refused (UPTO_BACK_SAY); words come out of a post by deleting the message. A whole-thread republish of a post
// whose point is not the end says how many further messages it now includes (`run.further`).
export const EXTENTS = Object.freeze(['whole', 'upto']);
// how long the checks of a new post's links may take, all together (a lone link to a blyg post); past it no target is set
export const LINK_CHECK_MS = 15000;
export const UPTO_BACK_SAY = 'Your post already includes later messages of this thread, so it cannot be published only up to this one. To take words out of your post, delete the message.';
export const UPTO_GONE_SAY = 'That message is not one of yours in this thread any more, so nothing was started.';
export const ADD_GONE_SAY = 'Your earlier post from this page can no longer be added to from here. Nothing was started. Close this and choose “Publish as a new post”.';
/** WHY A RUN STOPS AT `planned` FOR THE OWNER'S LOOK, or why it does not. The facts a post can carry (each recorded on the run as
 *  `reasons`, so the dialog and the log say why a look was or was not asked):
 *    agent-text   a passage an agent wrote, or the owner pasted from an agent's tool (published in its marked box)
 *    link-stub    a new post made a response to the one blyg post it links to
 *    further      a whole-thread republish now includes messages a post "up to here" held back
 *    left-out     a new version would leave out a comment the post had (its thread is gone from the page)
 *    outside      a new version would replace a note changed outside the plugin (asked before anything is written: OUTSIDE_SAY)
 *    notes-read   a passage's agent read the owner's notes (tkgaps `used` notes or both; blyg-note generatedEntry `notes_read`)
 *  THE POLICY (the owner, 2026-11-25): with confirm 'never' a look is forced ONLY when something already published would be lost
 *  without the owner having asked for it: LOOK_FORCED (left-out, outside). The other facts publish straight. A passage whose agent
 *  read the owner's notes is RECORDED (the fact notes-read) and forces nothing: for some hours on 2026-11-27 it forced a look, which
 *  held every such post pressed from a phone until the owner reached a computer; the owner ended that the same day ("Please do not
 *  do these pauses … please let them go from my phone"). With confirm
 *  'always' every post is looked at, as before. `run.review` is the one reason the run stopped, one of REVIEW_REASONS:
 *    setting      the owner's setting is confirm 'always'
 *    left-out     (forced, above)
 *    notes-read   (a record written on 2026-11-27 may name it: it forced a look then; it forces none now)
 *    asked        the owner asked to look at a post the queue had set aside (blyg-queue)
 *    none         confirm 'never' and nothing forces a look: the run goes straight through
 *  (agent-text, further and link-stub stay in the list: a record written before 2026-11-25 may name them.) */
//    outside-replaced  the owner answered Replace (or asked to look at a post set aside for it): recorded, never forcing a look
//    drawer-text       another comment of the post is taken as it is in the drawer now (its published text could not be known): recorded
export const REVIEW_FACTS = Object.freeze(['agent-text', 'link-stub', 'further', 'left-out', 'outside', 'outside-replaced', 'drawer-text', 'notes-read']);
export const LOOK_FORCED = Object.freeze(['left-out', 'outside']);
export const REVIEW_REASONS = Object.freeze(['setting', 'agent-text', 'left-out', 'further', 'link-stub', 'outside', 'notes-read', 'asked', 'none']);
export function reviewFor(setting, { agentText = false, leftOut = false, further = false, linkStub = false, outside = false, outsideReplaced = false, drawerText = false, notesRead = false, asked = false } = {}) {
  const has = { 'agent-text': agentText, 'link-stub': linkStub, further, 'left-out': leftOut, outside, 'outside-replaced': outsideReplaced, 'drawer-text': drawerText, 'notes-read': notesRead };
  const reasons = REVIEW_FACTS.filter(k => has[k]);
  const forced = LOOK_FORCED.find(k => has[k]);
  if (forced) return { confirm: 'always', review: forced, reasons };
  if (setting !== 'never') return { confirm: 'always', review: 'setting', reasons };
  if (asked) return { confirm: 'always', review: 'asked', reasons };
  return { confirm: 'never', review: 'none', reasons };
}
/** Did any passage of the post come from an agent that read the owner's notes (blyg-note generatedEntry `notes_read`)? */
export const notesReadIn = generated => (generated || []).some(e => e && e.notes_read === true);
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
/** How many times, and how far apart, the draft's page is asked for before it is called unavailable. The owner's local preview site
 *  regenerates twice after a note is staged (the note, then the link-card cache), about 11 s each, so the wait is bounded at about
 *  45 s in all (15 more asks, 3 s apart, after the first). */
export const PREVIEW_TRIES = Object.freeze({ times: 15, apartMs: 3000 });
export const DEFAULT_PREVIEW_SELECTOR = 'article';

// ---- the site's own refusals, in PREPARED words --------------------------------------------------------------------------
// A failed step is told to the owner in ONE sentence (the drawer's wording table): "Something went wrong while <step>." unless the
// site's command printed one of ITS OWN refusals, which is then told in the fixed sentence of SITE_REFUSALS (never the printed line,
// cleaned: the owner reads wording prepared here). A line counts only when
//   · it STARTS with one of the publisher's own prefixes: `blyg-publish: ` (its refusals), `Nothing to abandon for ` (its abandon),
//     or `- ` directly under its own list headings (`Refused:` in a plan, `blyg-publish preflight: this environment cannot publish
//     yet:` in the pre-flight), with any `_notes/<name>.md: ` that names the note taken off;
//   · it holds no quoted segment (a `"`, `“` or `”`: a quotation is where page-derived text would be) and is not a line of the
//     note itself (the build may echo the note's text, which a page shaped);
//   · and the rest matches one entry, from its first character.
// The last such line wins (the command's final word). Everything printed is in the run's log for an agent.
// The refusals listed are the example site's (scripts/blyg-publish and scripts/blyg_publish.rb, read at the blog's publish-next-blog).
export const SITE_REFUSALS = Object.freeze([
  ['staged-other', /^\S+ is already staged by this checkout\b/, 'Another note is already staged in your site’s checkout. Finish or undo that publish first.'],
  ['not-wip', /^your checkout is on \S+(?:, not wip|; (?:staging a note commits on wip|switch to wip first|publishing reads the notes from wip))/, 'Your site’s checkout is not on its wip branch. Switch it to wip, then try again.'],
  ['note-uncommitted', /^\S+ is already on wip and has uncommitted changes/, 'The note has changes in your site’s checkout that are not committed. Commit them there, then try again.'],
  ['checkout-dirty', /^(?:your checkout has other uncommitted changes|the working tree has (?:\d+ )?uncommitted change)/, 'Your blog folder has unsaved changes in {what}; save or discard them, then try again.'],
  ['import-failed', /^importing the note's sources failed/, 'Your site could not fetch the post you quoted. Try again later.'],
  ['not-imported', /^quotes or answers \S+, which is not imported/, 'The post you quoted has not been fetched into your site yet. Start over to fetch it.'],
  ['not-staged', /^\S+ was not staged by --stage-note/, 'Your site has no record of staging this note. Start over.'],
  ['record-damaged', /^the (?:draft )?record is damaged/, 'Your site’s record of this publish is damaged, so nothing was changed. It needs fixing on your site.'],
  ['wip-moved', /^wip has moved on from the staging commit/, 'Your site’s wip branch moved on after the note was staged. Start over.'],
  ['staging-commit', /^the staging commit\b/, 'The commit that staged this note is not as this publish left it, so nothing was changed. Start over.'],
  ['changed-after-staged', /^\S+ was changed after it was staged/, 'The note was changed after it was staged. Start over.'],
  ['run-for-note', /^a run for this note is at \w+; abandon it first/, 'Your site has an unfinished publish of this note. Start over to give it up.'],
  ['lock', /^(?:another run is under way|the lock was taken by a run|the lock's process|a lock file is present|\S+ exists but does not say which run)/, 'Another publish is under way on your site. Wait for it to finish, then try again.'],
  ['nothing-to-abandon', /^(?:there is no unfinished run to abandon|Nothing to abandon for \S+: no unfinished run is recorded)/, 'Your site has no unfinished publish to give up.'],
  ['other-note-run', /^the recorded run \(\w+\) is for /, 'Your site’s unfinished publish is for another note, so it was not touched.'],
  ['unfinished-run', /^(?:a [\w ]+ stopped at \w+; finish it first|the last run stopped at \w+|a run for \S+(?:, \S+)* is recorded at \w+: finish it)/, 'Your site has an unfinished publish. Carry it on or give it up there first.'],
  ['pushed-unrecorded', /^(?:a [\w ]+ was pushed to GitHub \(it is published\)|this run's push of [0-9a-f]+ reached GitHub)/, 'An earlier publish reached your site but was not recorded. It needs finishing on your site.'],
  ['plan-refused', /^refused \(see above\)/, 'Your site’s check refused this publish, so nothing was changed.'],
  ['only-note', /^--only-note: this plan is for more than the note/, 'Publishing this would change more on your site than this note, so it was not done in one click. Publish it from your site.'],
  ['quick-needs-only-note', /^--quick needs --only-note/, 'Your one-click setting is not one your site accepts: its quick check needs the note-only check.'],
  ['main-behind', /^(?:GitHub main is at the pushed commit|main is behind origin\/main|local main is not the same commit as origin\/main|there is no origin\/main|could not fetch origin)/, 'Your site’s main branch is not in step with GitHub. Bring it up to date, then try again.'],
  ['changed-after-apply', /^(?:files changed after apply checked them|the temporary worktree is no longer at the commit apply checked|main moved from [0-9a-f]+ to [0-9a-f]+ after apply)/, 'Your site changed after it was built and checked. Try again to build it again.'],
  ['live-mismatch', /^the live site does not match the plan/, 'Your site went live but does not look as planned. Look at your site.'],
  ['worktree-lost', /^could not make the temporary worktree again/, 'Your site cannot carry this publish on. Start over to give it up.'],
  ['merge-conflict', /^merging main into wip conflicts/, 'Your site’s main and wip branches conflict. Resolve that on your site, then try again.'],
  ['not-a-note', /^(?:\S+ is not a file in this checkout|\S+ resolves outside _notes\/|not a note on wip)/, 'The note is not where your site expects it.'],
  ['release-date', /^(?:no release date|release date \S+ is (?:in the future|not a date))/, 'The note’s release date is missing or in the future.'],
  ['already-published', /^already on main; use --edit/, 'This post is already published. Publish a new version of it instead.'],
  ['not-published', /^not on main; publish it as a new post/, 'This post is not published yet. Publish it as a new post.'],
  ['nothing-changes', /^nothing would change on main/, 'Nothing would change on your site.'],
  ['address-taken', /^its address \S+ belongs to the published /, 'The post’s address already belongs to another published post.'],
  ['id-clash', /^blyg_id \S+ (?:already belongs to the published|is not the id it was published under|is also written in)/, 'The post’s id clashes with another post on your site.'],
  ['embed', /^an Obsidian embed /, 'The note holds an Obsidian embed, which your site does not publish.'],
  ['missing-file', /^refers to \S+, which is not in the repository/, 'The note refers to a file your site does not have.'],
  ['sitemap', /^could not read \S+\/sitemap\.xml/, 'Your site could not read its own live pages to check them. Try again later.'],
  ['git-failed', /^git [\w-]+/, 'A git command failed on your site.'],
  ['not-pushed', /^nothing was published \(State: \w+\)/, 'Nothing was published yet. Try again to carry on.'],
  ['ruby', /^Ruby \S+ is the one on PATH, but this site needs /, 'The companion starts a Ruby your site does not use. Put the site’s Ruby first on the companion’s PATH.'],
  ['bundler', /^bundler is not installed/, 'Bundler is not installed for your site’s Ruby.'],
  ['checker', /^BLYG_CHECKER (?:is not set|names \S+, which is not a folder|\(\S+\) does not load)/, 'The conformance checker (BLYG_CHECKER) is not available to the companion.'],
  ['node', /^the node command is not on PATH/, 'The node command is not on the companion’s PATH.'],
  ['netlify', /^(?:there is no \.netlify\/state\.json|the netlify command is not on PATH)/, 'Your site’s Netlify setup (the netlify command or its site id) is missing.'],
  ['locale', /^the locale is \w+=\S+, which is not UTF-8/, 'The companion runs with a locale that is not UTF-8.'],
  ['shell-vars', /^[A-Z_][A-Z0-9_]*(?:, [A-Z_][A-Z0-9_]*)* is set in your shell; blyg-publish sets these itself/, 'The companion passes your site a setting that the site sets itself.'],
].map(([key, re, say]) => Object.freeze({ key, re, say })));
// WHICH KIND OF FILE has unsaved changes, in plain words (the dirty-tree sentence's {what}): a fixed description per kind, from the
// file names the publisher lists (they are the owner's own folder's, and only the KIND is ever shown).
export const DIRTY_KINDS = Object.freeze([
  [/^_data\/link_cards\.yml$/, 'the link-card cache'],
  [/^_notes\//, 'your notes'],
  [/^_blyg\//, 'the site’s publication records'],
  [/^_config\.yml$/, 'the site’s settings'],
  [/^(?:_layouts|_includes|_sass|assets|styles\.scss|_pages)\b/, 'the site’s design files'],
  [/^(?:_plugins|scripts|tests|netlify)\//, 'the site’s code'],
  [/^_data\//, 'the site’s data files'],
].map(([re, say]) => Object.freeze({ re, say })));
export function dirtyWhat(files) {
  const kinds = [];
  for (const f of files) { const k = DIRTY_KINDS.find(d => d.re.test(f)); const w = k ? k.say : 'other files'; if (!kinds.includes(w)) kinds.push(w); }
  if (!kinds.length) return 'some files';
  return kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;
}
// the files a dirty-tree refusal names: `git status --porcelain` lines under it, or the "(a, b)" list in the staging refusal
const PORCELAIN = /^ ?[MADRCU?]{1,2} +(\S.*)$/;
const SITE_PREFIX = 'blyg-publish: ';
const LIST_HEADINGS = Object.freeze(['Refused:', 'blyg-publish preflight: this environment cannot publish yet:']);
const NOTE_NAMED = /^_notes\/[\w.-]+\.md: /;
const QUOTED = /["“”]/;
/** The SITE_REFUSALS entry for one line of a step's output, or null. `ctx.listed`: the line sits under one of the publisher's own list
 *  headings; `ctx.note`: the note's text (a line of it is never the site's word). */
export function refusalOf(raw, { listed = false, note = '' } = {}) {
  const line = String(raw || '').replace(/\s+$/, '');
  let body = '';
  if (line.startsWith(SITE_PREFIX)) body = line.slice(SITE_PREFIX.length);
  else if (line.startsWith('Nothing to abandon for ')) body = line;
  else if (listed && /^\s+- /.test(line)) body = line.replace(/^\s+- /, '');
  else return null;
  if (!body || QUOTED.test(body)) return null;
  const t = body.trim();
  if (note && t.length >= 8 && String(note).includes(t)) return null;
  const rest = t.replace(NOTE_NAMED, '');
  return SITE_REFUSALS.find(r => r.re.test(rest)) || null;
}
/** The fixed sentence for the site's last recognised refusal in a step's output, or '' (the drawer then says "Something went wrong
 *  while <step>."). */
export function plainLineOf(output, { note = '' } = {}) {
  let listed = false;
  let said = '';
  const lines = String(output || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const r = refusalOf(line, { listed, note });
    if (r && r.key === 'checkout-dirty') {
      const files = [];
      const inline = /uncommitted changes \(([^)]*)\)/.exec(line);
      if (inline) files.push(...inline[1].split(', '));
      for (let j = i + 1; j < lines.length; j++) { const m = PORCELAIN.exec(lines[j]); if (!m) break; files.push(m[1]); }
      said = r.say.replace('{what}', dirtyWhat(files));
    } else if (r) said = r.say;
    if (LIST_HEADINGS.includes(line.trim())) listed = true;
    else if (!/^\s+- /.test(line)) listed = false;
  }
  return said;
}
/** The pre-flight's problems, each in its fixed sentence (unrecognised ones left out), in the order printed. */
export function checkSentences(message, { note = '' } = {}) {
  let listed = false;
  const out = [];
  for (const line of String(message || '').split('\n')) {
    const r = refusalOf(line, { listed, note });
    const say = r ? r.say.replace('{what}', 'some files') : '';
    if (r && !out.includes(say)) out.push(say);
    if (LIST_HEADINGS.includes(line.trim())) listed = true;
    else if (!/^\s+- /.test(line)) listed = false;
  }
  return out;
}
/** While `publish` runs: the part of it the owner is waiting on, from the lines it has printed (a fact shown, not a mode). */
export const PUBLISH_PHASES = Object.freeze(['publish', 'wait']);
export const phaseOfLine = line => (/^Pushed main\b|waiting for the Netlify deploy|^Live and verified/i.test(String(line || '')) ? 'wait' : '');
export const beforeApply = run => PRE_APPLY_MODES.includes(run.mode);
// (abandon_failed keeps the mode it was abandoned from, `abandoned_from`, so "abandon again" knows whether anything was published)
export const publishedNothing = run => NOTHING_PUBLISHED_MODES.includes(run.mode)
  || (run.mode === 'abandon_failed' && NOTHING_PUBLISHED_MODES.includes(run.abandoned_from));
export const publishUnsure = run => run.kind === 'edit' && (PUBLISH_UNSURE_MODES.includes(run.mode)
  || (run.mode === 'abandon_failed' && PUBLISH_UNSURE_MODES.includes(run.abandoned_from)));
const workBegun = run => !NOTHING_BEGUN_MODES.includes(run.mode);
/** Is this move allowed? The table alone decides. */
export const canMove = (from, to) => !!RUN_MOVES[from] && RUN_MOVES[from].includes(to);
/** The step a failed or interrupted mode names ('' for the others): for the owner's view only, derived from the one field. */
export const stepNamed = mode => (FAILED_MODES.includes(mode) ? mode.slice('failed_'.length)
  : INTERRUPTED_MODES.includes(mode) ? mode.slice('interrupted_'.length) : '');

/** What the owner may do in a mode (the drawer draws buttons from this; the routes enforce it by the table). */
export const actionsOf = run => {
  const can = run.mode === 'planned' ? ['confirm', 'cancel'] : FAILED_MODES.includes(run.mode) ? ['retry', 'abandon']
    : run.mode === 'abandon_failed' ? ['abandon', 'forget']
    : INTERRUPTED_MODES.includes(run.mode) ? (CONTINUE_FOR[run.mode] ? ['continue', 'abandon'] : ['abandon']) : [];
  // a new version whose publish may have reached the site: Forget too (nothing is run or undone)
  return publishUnsure(run) && !can.includes('forget') ? [...can, 'forget'] : can;
};

/** A record written by an older companion (mode 'failed' + failed_step, or 'interrupted' + interrupted_from) in today's one field. */
export function migrateRecord(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  // an older companion's cleanup said it with two booleans (removed, forgotten): today it is one named outcome
  if (rec.cleanup && typeof rec.cleanup === 'object' && !CLEANUP_OUTCOMES.includes(rec.cleanup.outcome)) {
    const { removed, forgotten, ...c } = rec.cleanup;
    rec = { ...rec, cleanup: { ...c, outcome: forgotten ? 'forgotten' : removed ? 'undone' : 'left' } };
  }
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
    reasons: Array.isArray(run.reasons) ? run.reasons.filter(k => REVIEW_FACTS.includes(k)) : [],
    at: run.at, scope: run.scope, title: run.title, permalink: run.permalink, thread_ids: run.thread_ids, page_url: run.page_url,
    reading: run.reading || [], changelog: run.changelog || '', notify: run.notify || '', quotes: !!run.quotes, pace: PACES.includes(run.pace) ? run.pace : 'full',
    full_minutes: Number.isFinite(run.full_minutes) ? run.full_minutes : null,
    steps: [...last.values()].map(r => ({ step: r.step, ok: stepOk(r), ms: r.ms || 0 })),
    tries: failedStep ? (count.get(failedStep) || 0) : Math.max(0, ...[...count.values()]),
    failed_step: failedStep, failure: failedStep ? String(run.failure_line || '') : '',
    interrupted_from: INTERRUPTED_MODES.includes(run.mode) ? stepNamed(run.mode) : '', interrupted_why: run.interrupted_why || '',
    published: run.published || null,
    cleanup: run.cleanup ? { said: String(run.cleanup.said || ''), outcome: CLEANUP_OUTCOMES.includes(run.cleanup.outcome) ? run.cleanup.outcome : 'left' } : null,
    unsure: publishUnsure(run) ? EDIT_UNSURE_SAY : '',
    chained_to: run.chained_to || null,
    left_out: Number(run.left_out) || 0,
    // this new version moves the post's older agent passages to the markdown form (blyg-note.mjs FORMS_MOVED_SAY)
    forms_moved: run.forms_moved === true,
    extent: EXTENTS.includes(run.extent) ? run.extent : 'whole', further: Number(run.further) || 0,
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
// A published note's `blyg_generated`, read by a REAL YAML parser: Ruby's Psych, the one the site reads it with (every YAML shape of
// the list, comments and flow maps included). It runs in the SITE's folder (`cwd`: S.top), so a version manager's shim picks the
// site's own Ruby (its .ruby-version); the script also runs on the oldest Ruby a Mac carries (2.6, Psych 3.1: `safe_load` with
// `permitted_classes:`, no newer keyword). → { generated } (an absent key: no entries, every passage legacy, as the site reads it);
// { unreadable } when the YAML itself cannot be read (the new version is then refused with FORMS_UNKNOWN_SAY); { refusal:
// RUBY_NEEDED_SAY } when Ruby is missing or fails for any other reason. Nothing is ever guessed.
export const RUBY_NEEDED_SAY = 'Ruby is needed to read this post\'s agent passages, and it could not be run here (is ruby on the PATH of the companion?), so a new version is not written from here. Nothing was written.';
const GENERATED_RB = [
  'begin',
  '  d = YAML.safe_load($stdin.read, permitted_classes: [Date, Time])',
  'rescue Psych::Exception',
  '  puts JSON.generate("yaml_error" => true)',
  '  exit 0',
  'end',
  'puts JSON.generate(d.is_a?(Hash) ? { "present" => d.key?("blyg_generated"), "list" => d["blyg_generated"] } : { "present" => false })',
].join('\n');
export function generatedOf(noteText, { ruby = 'ruby', cwd = undefined, env = undefined } = {}) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(String(noteText || ''));
  if (!m) return { unreadable: 'the note has no front matter' };
  let out;
  try {
    out = execFileSync(ruby, ['-ryaml', '-rjson', '-rdate', '-e', GENERATED_RB],
      { input: m[1], encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'ignore'], ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) });
  } catch { return { refusal: RUBY_NEEDED_SAY }; }
  let r;
  try { r = JSON.parse(out); } catch { return { refusal: RUBY_NEEDED_SAY }; }
  if (r && r.yaml_error) return { unreadable: 'its front matter could not be read as YAML' };
  return { generated: r && r.present ? r.list : [] };
}
// Two texts of a note that differ in nothing but the prompts choice (`blyg_prompts`; absent is the default, locked): a new version of only
// that choice. The same choice written out where it was absent is no change at all.
export const promptsOnlyChange = (a, b) => {
  const w = t => String(t).replace(/^blyg_prompts:.*\n/m, '');
  const mode = t => { const m = /^blyg_prompts:\s*(\S+)\s*$/m.exec(String(t)); return m && PROMPT_MODES.includes(m[1]) ? m[1] : DEFAULT_PROMPTS; };
  return w(a) === w(b) && mode(a) !== mode(b);
};
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
      // the publish queue (blyg-queue.mjs) hears every move: it starts the next entry when a run ends
      if (typeof deps.onMove === 'function') { try { deps.onMove(run, from); } catch { /* the queue says so itself */ } }
      // (a run held while a start looks has no id yet: '')
      try { deps.broadcast({ type: 'blyg-publish', run: { id: run.id || '', mode: run.mode } }); } catch { /* nobody listening */ }
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
  const fail = (status, error) => ({ ok: false, status, error, about: 'entry' });
  // a refusal about the site or this machine, not about the post asked for (the publish queue pauses on it and keeps the post)
  const siteFail = (status, error) => ({ ok: false, status, error, about: 'site' });
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
    return { ok, record, reason, plain: ok ? '' : (r.timedOut ? '' : plainLineOf(r.output, { note: run.note_text || '' })) };
  }
  const pushStep = rec => { if (rec) book.run.steps = [...(book.run.steps || []), rec]; };
  const failWith = (mode, s) => book.move(mode, { failed_reason: s.reason, failure_line: s.plain || '', steps: book.run.steps });

  // ---- the picture of the draft (preview_url + headless render) ----------------------------------------------------------
  function previewTo(to) { previewMove(preview, to); }
  // the picture now belongs to another run (or none): its state goes to off by a move, then the facts about it are reset
  function previewFor(runId, theme) { if (preview.state !== 'off') previewTo('off'); preview.run = runId; preview.theme = theme; preview.png = null; }
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
    if (!want) { previewFor('', 'light'); return { ok: true, state: 'off' }; }
    const th = theme === 'dark' ? 'dark' : 'light';
    if (preview.run !== book.run.id) previewFor(book.run.id, th);
    const again = fresh || preview.theme !== th;
    if (preview.state === 'off' || (again && preview.state !== 'waiting')) {
      preview.theme = th; preview.png = null; previewTo('waiting');
      renderDraft(book.run.id, th).catch(() => { if (preview.state === 'waiting') previewTo('unavailable'); });
    }
    return { ok: true, state: preview.state, ...(preview.state === 'ready' && preview.png ? { png: preview.png } : {}) };
  }

  // ---- Step A --------------------------------------------------------------------
  // Step A: the optional prepare, then plan. Each is a step with its own mode; a failure stops there (failed_prepare, failed_plan).
  // A NEW VERSION'S LINE, asked of a model when the companion can (deps.askChangelog: the Claude one-shot, no tools, the
  // changelog_model setting). Only the two texts of the post as they read go in; the answer is used only when changelogAnswerOk
  // accepts it; a refusal, a failure or no answer within CHANGELOG_ASK_MS keeps the fixed line. Publishing never waits longer and never
  // fails because of it. Runs while the run is `drafted` (one run at a time holds), before prepare and plan, which carry the line.
  async function modelChangelog() {
    const run = book.run;
    if (run.kind !== 'edit' || run.changelog_from !== 'program-fixed' || typeof deps.askChangelog !== 'function') return;
    const home = settingsNow();
    const before = postTextOf(run.prev_text || '');
    const after = postTextOf(run.note_text || '');
    let answer = null;
    let timer = null;
    try {
      answer = await Promise.race([
        Promise.resolve(deps.askChangelog({ prompt: changelogPrompt(before, after), model: home.ok ? home.settings.changelog_model : '', timeoutMs: CHANGELOG_ASK_MS })).catch(() => null),
        new Promise(res => { timer = setTimeout(() => res(null), deps.changelogAskMs !== undefined ? deps.changelogAskMs : CHANGELOG_ASK_MS); }),
      ]);
    } finally { clearTimeout(timer); }
    const line = answer && answer.ok ? changelogAnswerOk(answer.text, { before, after }) : '';
    logNote(`changelog line: ${line ? 'the model\'s' : `the fixed one (${!answer ? 'no answer in time' : !answer.ok ? 'the model failed' : 'the answer was refused'})`}`);
    if (!line || book.run.id !== run.id || book.mode !== 'drafted') return;
    book.run.changelog_from = changelogFromMove(book.run.changelog_from, 'program-model');
    book.run.changelog = line;
    book.persist();
  }
  async function runPlan() {
    if (book.mode === 'drafted') await modelChangelog();
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
    // no look asked for (reviewFor: confirm 'never' and nothing LOOK_FORCED names): choosing Publish as blyg was the publish: carry straight on
    if (book.run.confirm === 'never') return runFrom('apply');
    return book.run;
  }

  /** Start a run (async: the pre-flight runs without holding the companion). A refusal after `checking` began goes back to idle. */
  // `id`: the run's id, when the queue chose it (so its entry names the run before the first move is announced). `presence`: where the
  // owner is for this run, one of PRESENCES (below).
  async function start(args) {
    if (RUN_LIVE.includes(book.mode)) return fail(409, `A publish is already under way (${book.mode.replace(/_/g, ' ')}). Finish it or give it up first.`);
    // the last run's step process, looked at afresh: a run forgotten while its step was still going must not get a second one beside it
    if (book.run.child && childNow(true) === 'alive') return siteFail(409, 'The earlier step is still running: stop it first.');
    let r;
    const id = typeof args.id === 'string' && /^[0-9a-f]{16}$/.test(args.id) ? args.id : crypto.randomBytes(8).toString('hex');
    // THE RUN IS HELD from here, before the first await (the pre-flight, the link checks): a second start meanwhile is refused
    if (!canMove(book.mode, 'checking')) return fail(409, `A publish is already under way (${book.mode.replace(/_/g, ' ')}). Finish it or give it up first.`);
    const before = book.run;
    book.move('checking');
    if (args.presence !== undefined && !PRESENCES.includes(args.presence)) r = fail(400, 'no such presence');
    else { try { r = await startChecked({ ...args, id }); } catch (e) { log.write(id, { ev: 'note', text: `could not start: ${String((e && e.message) || e).slice(0, 400)}` }); r = fail(500, START_BROKE_SAY); } }
    // a start that stopped before writing anything: the run is as it was before it (a finished run's record kept for the owner)
    if (book.mode === 'checking') {
      if (before && before.mode !== 'idle' && canMove('checking', before.mode)) book.move(before.mode, before);
      else book.move('idle');
    }
    if (!r.ok) log.write(id, { ev: 'note', text: `start refused (${r.status}): ${r.error}` });
    return r;
  }
  // (`drawerText`: the caller gives another comment of the post as it is in the drawer, its published text unknown: recorded as a reason)
  // `prompts`: the post's prompts choice from the press (blyg-note.mjs PROMPT_MODES); '' is the default for a new post and, for a new
  // version, the choice the post already has.
  async function startChecked({ page, threadId, scope, shown, id, join = '', post = '', postVersion = '', outside = '', extent = 'whole', upto = '', presence = 'here', drawerText = false, prompts = '' }) {
    if (!SCOPES.includes(scope)) return fail(400, `scope must be one of ${SCOPES.join(', ')}`);
    if (prompts && !PROMPT_MODES.includes(prompts)) return fail(400, `prompts must be one of ${PROMPT_MODES.join(', ')}`);
    if (!EXTENTS.includes(extent)) return fail(400, `extent must be one of ${EXTENTS.join(', ')}`);
    if (extent === 'upto' ? !upto : !!upto) return fail(400, 'upto is the message a post goes up to, and only with extent upto');
    if (join && !JOINS.includes(join)) return fail(400, `join must be one of ${JOINS.join(', ')}`);
    // (only `replace` is ever sent: `keep` sends nothing at all)
    if (outside && outside !== 'replace') return fail(400, 'outside must be replace or absent');
    const home = settingsNow();
    if (!home.ok) { log.write(id, { ev: 'note', text: `settings: ${home.errors.join(' | ')}` }); return siteFail(409, 'Publish as blyg is not set up correctly on the companion: its “Where my blyg lives” setting does not pass its check. Open that setting on the companion to see why.'); }
    const S = home.settings;
    const threads = page.threads || [];
    const at = threads.findIndex(t => t && t.id === threadId);
    if (at < 0) return fail(404, 'That thread is not on this page any more.');
    const here = threads[at];
    // the point, when one was chosen: one of the owner's publishable messages in this thread
    if (extent === 'upto' && !(here.msgs || []).some(m => isPublishableMsg(m) && String(m.ts) === String(upto))) return fail(409, UPTO_GONE_SAY);
    const cut = { extent, upto: extent === 'upto' ? String(upto) : '' };
    const editing = isPublishedThread(here);
    // adding this comment to the earlier post from this page (the owner's choice): that post's new version, through the edit path
    const adding = !editing && join === 'add';
    if (adding && scope !== 'one') return fail(400, 'Only this one comment can be added to your earlier post.');
    if ((editing || adding) && !EDIT_STEPS.every(k => S.commands[k])) return fail(409, 'Publishing a new version is not set up on the companion yet (its edit commands are missing).');
    // THE PRE-FLIGHT, before anything is written: a broken environment fails here, in about a second, with the check's own sentence
    if (S.commands.check) {
      const c = await (deps.check || runCheck)({ argv: S.commands.check, cwd: S.top, env: minimalEnv(S.env_pass, env) });
      log.write(id, { ev: 'check', argv: S.commands.check, ok: !!(c && c.ok), message: (c && c.message) || '' });
      if (!c || !c.ok) {
        // the check's own plain sentences (the example site lists its problems as "  - …" lines under a heading)
        const msg = String((c && c.message) || '');
        const said = checkSentences(msg);
        // (the companion's own words about the check itself: it timed out, could not start, or failed without a word)
        const own = /^The check (?:did not answer|could not be started|failed \(exit)/.test(msg) ? msg : '';
        return siteFail(409, `Your site cannot publish right now. ${said.length ? said.join(' ') : own || 'Its check did not pass; the troubleshooting details say why.'}`);
      }
      // the settings may not change while the check ran (they are read again, and must be the ones checked)
      const again = settingsNow();
      if (!again.ok || fingerprint(again.settings) !== fingerprint(S)) return siteFail(409, 'The “Where my blyg lives” settings changed while the check ran. Nothing was started.');
    }
    // the owner was shown one setting's wording; if the one in force is another, nothing starts (a stale drawer must not promise a look
    // first when one click publishes, or the reverse)
    if (shown !== S.confirm) return fail(409, settingChangedSay(shown, S.confirm));
    if (adding) {
      const earlier = earlierPostFor(page, here, S);
      if (!earlier) return fail(409, ADD_GONE_SAY);
      // THE POST SHOWN IS THE POST ADDED TO: the start carries the id and the version the dialog named
      if (String(post) !== earlier.post || Number(postVersion) !== earlier.version) return fail(409, ADD_CHANGED_SAY);
      return startEdit({ page, here: earlier.thread, S, id, adding: here, outside, cut, chosen: here, presence, drawerText, prompts });
    }
    return editing ? startEdit({ page, here, S, shown, id, outside, cut, chosen: here, presence, drawerText, prompts }) : startNew({ page, threads, at, here, scope, S, id, cut, presence, prompts: prompts || DEFAULT_PROMPTS });
  }

  // THE THREADS OF A POST published from here, in the order they went into it: the order recorded when it was last published (a
  // comment added later comes after the ones it was added to), else page order.
  function matesOf(threads, pub) {
    const key = String(pub.permalink || '').replace(/\/+$/, '');
    const order = Array.isArray(pub.thread_ids) ? pub.thread_ids.map(String) : [];
    const rank = (t, i) => { const k = order.indexOf(String(t.id)); return k < 0 ? order.length + i : k; };
    return threads.map((t, i) => ({ t, r: rank(t, i) }))
      .filter(({ t }) => isPublishedThread(t) && String(t.blyg_published.permalink || '').replace(/\/+$/, '') === key)
      .sort((a, b) => a.r - b.r).map(({ t }) => t);
  }
  // THE THREADS A POST WAS PUBLISHED FROM, as its record has them (a record from before the list was kept: its snapshot's threads)
  const recordedIdsOf = pub => (Array.isArray(pub.thread_ids) && pub.thread_ids.length ? pub.thread_ids.map(String)
    : (pub.snapshot && Array.isArray(pub.snapshot.threads) ? pub.snapshot.threads.map(t => String(t.thread || '')).filter(Boolean) : []));
  // THE NOTE OF A POST published from here, found and checked: inside the notes folder, a plain file, unchanged since it was
  // published from here (when its hash was kept) and carrying the post's id. → { ok, rel, target, before, fm, bid } or a refusal.
  function publishedNoteOf(pub, S) {
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
    const fm = frontOf(before);
    if (fmValue(fm, 'blyg_id') !== bid || !isBlygId(bid)) return fail(409, 'The note of this post does not carry the post\'s id, so it is not rewritten from here.');
    // still that post, but not the text written from here: changed outside the plugin (the owner is asked: OUTSIDE_ANSWERS)
    const outside = !!pub.note_sha && sha(before) !== pub.note_sha;
    return { ok: true, rel, target, before, fm, bid, outside };
  }
  // Does the page still answer what the post answered (its ONE `blyg_stub_of` target, or none)? A post recorded before the target
  // was kept is compared by its whole stub (as it was written then: a web page's stub had no title).
  function sameTarget(snapshot, page) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const now = stubOfPage(page);
    if (typeof snapshot.target === 'string') return snapshot.target === hashOf(stubTargetOf(now));
    if (!snapshot.stub) return !now;
    return !!now && snapshot.stub === hashOf(JSON.stringify(now.url ? { url: now.url } : now));
  }
  /** THE EARLIER POST a comment may be added to: of the posts published from this page by another of the owner's threads, the most
   *  recent (by when it was first published), and only when its note can be found in the notes folder (a plain file carrying the
   *  post's id, recorded from here with its hash), all its threads are still here and publishable, one more fits, and the page still
   *  answers the same target. A note CHANGED OUTSIDE THE PLUGIN since (its hash differs) is offered to the drawer, whose run then asks
   *  the outside question before anything is written, and refused to the hub link (`outside: 'refuse'`).
   *  → { thread, permalink, title, version, address, date } or null. */
  // (`here` null: a comment not written yet — the hub link asks before the owner replies; otherwise the comment must be publishable)
  // (`why`: told `reason: 'outside'` when the one candidate was refused because its note was changed outside the plugin. The DRAWER is
  // offered such a post (`outside: 'offer'`: the owner is there and the run asks the outside question before anything is written);
  // the HUB LINK is not (`outside: 'refuse'`: nobody could answer that question from the phone))
  function earlierPostFor(page, here, S, why = {}, { outside = 'offer' } = {}) {
    if (!page || isStandAlonePage(page) || (here && (isPublishedThread(here) || !eligibleThread(here).ok))) return null;
    if (!EDIT_STEPS.every(k => S.commands[k])) return null;
    const threads = page.threads || [];
    const posts = new Map();
    for (const t of threads) {
      if (t === here || !isPublishedThread(t)) continue;
      const key = String(t.blyg_published.permalink || '').replace(/\/+$/, '');
      if (!key) continue;
      const when = String(t.blyg_published.first_at || t.blyg_published.at);
      const p = posts.get(key);
      if (!p) posts.set(key, { thread: t, first: when }); else if (when < p.first) p.first = when;
    }
    const newest = [...posts.entries()].sort((a, b) => b[1].first.localeCompare(a[1].first))[0];
    if (!newest) return null;
    const [permalink, { thread }] = newest;
    const rec = postOf(permalink);
    if (!rec || !rec.note_sha || !rec.snapshot) return null;
    const pub = { ...thread.blyg_published, ...rec };
    const note = publishedNoteOf(pub, S);
    if (!note.ok) return null;
    // A NOTE CHANGED OUTSIDE THE PLUGIN is not offered to the hub link: its addition would wait at a look nobody can answer there
    if (note.outside && outside === 'refuse') { why.reason = 'outside'; return null; }
    const mates = matesOf(threads, pub);
    if (mates.length + 1 > LIMITS.comments || !mates.every(t => eligibleThread(t).ok)) return null;
    // every comment the post holds is still here: adding never drops one silently
    const ids = recordedIdsOf(rec);
    if (!ids.length || !ids.every(i => mates.some(t => String(t.id) === i))) return null;
    if (!sameTarget(rec.snapshot, page)) return null;
    const post = String(pub.permalink || '').split('/').filter(Boolean).pop() || '';
    return { thread, permalink: pub.permalink, post, title: String(thread.blyg_published.title || ''), version: Number(rec.version) || 1,
      address: String(thread.blyg_published.address || ''), date: String(thread.blyg_published.first_at || thread.blyg_published.at || ''),
      facts: promptsFactsOf(note.before) };
  }
  /** WHAT A PUBLISHED THREAD SAID in its post as last published from here (the post's record): its included messages, or null when
   *  that cannot be known (no record; a record from before the texts were kept whose message hashes the thread's messages no longer
   *  match: the thread was changed and not pressed again). */
  function publishedMsgsOf(t) {
    if (!isPublishedThread(t)) return null;
    const rec = postOf(t.blyg_published.permalink);
    if (!rec) return null;
    // a record NOT TRUSTED for this (marked so when a version may have gone out without it: a Forget, a give-up after a publish that may
    // have pushed), or one older than the version the thread says went out (the record could not be written at the end): unknown
    if (rec.untrusted || (Number(t.blyg_published.version) || 1) > (Number(rec.version) || 1)) return null;
    if (rec.texts && Array.isArray(rec.texts[t.id])) return JSON.parse(JSON.stringify(rec.texts[t.id]));
    const snap = rec.snapshot && Array.isArray(rec.snapshot.threads) ? rec.snapshot.threads.find(x => String(x.thread) === String(t.id)) : null;
    if (!snap || !Array.isArray(snap.msgs)) return null;
    const home = settingsNow();
    const escape = home.ok ? home.settings.escape : 'liquid';
    const own = (t.msgs || []).filter(isPublishableMsg);
    const out = [];
    for (const m of snap.msgs) {
      const live = own.find(x => String(x.ts) === String(m.ts));
      if (!live || hashOf(ownText(live, { escape, imageUrl: home.ok ? home.settings.image_url : '' }).text) !== m.sha) return null;
      out.push(live);
    }
    return out;
  }
  // a version of this post may have gone out without its record being written: the record is no longer used to rebuild its comments
  function distrust(run) {
    try { const rec = run && run.permalink ? postOf(run.permalink) : null; if (rec) { recordPost(run.permalink, { ...rec, untrusted: true }); logNote('the post\'s record is no longer trusted to rebuild its comments (a version may have gone out without it)'); } } catch { /* the version check still catches a stale record */ }
  }
  /** For the dialog: may this comment be added to an earlier post from its page? → { ok, earlier: { title, version, post, prompts,
   *  agent_text } | null, own: { prompts, agent_text } | null }. `prompts` and `agent_text` are the post's own, read from its NOTE
   *  (promptsFactsOf): the publish box draws its prompts choice for the post that will result and starts from that post's own choice.
   *  `own`: for a thread already published, its own post's (a new version). */
  function earlierOf({ page, threadId }) {
    const home = settingsNow();
    if (!home.ok || !page) return { ok: true, earlier: null, own: null };
    const here = (page.threads || []).find(t => t && t.id === threadId);
    if (!here) return fail(404, 'That thread is not on this page any more.');
    const e = earlierPostFor(page, here, home.settings);
    return { ok: true, earlier: e ? { title: e.title, version: e.version, post: e.post, ...e.facts } : null, own: ownFactsOf(here, home.settings) };
  }
  // a published thread's own post, as its note says (null: not published, or its note cannot be found)
  function ownFactsOf(here, S) {
    if (!isPublishedThread(here)) return null;
    const rec = postOf(here.blyg_published.permalink);
    const note = publishedNoteOf({ ...here.blyg_published, ...(rec || {}) }, S);
    return note.ok ? promptsFactsOf(note.before) : null;
  }
  /** THE SAME QUESTION FOR THE HUB LINK (earlierPostFor, the one answer): for a comment of the page (`threadId`), or for one not written
   *  yet (no `threadId`: asked before the owner replies). → the post's public facts { post, title, version, address, permalink, date },
   *  or null. */
  // (`outside`: 'refuse' (the default), or 'offer' while the caller knows a publish of this page is queued or running: the note then
  // differs from its record because OUR run is rewriting it, and the queue asks again, with 'refuse', when the addition's turn comes)
  function earlierPublicOf({ page, threadId = '', outside = 'refuse' }) {
    const home = settingsNow();
    if (!home.ok || !page) return null;
    const here = threadId ? (page.threads || []).find(t => t && t.id === threadId) : null;
    if (threadId && !here) return null;
    const why = {};
    const e = earlierPostFor(page, here, home.settings, why, { outside: outside === 'offer' ? 'offer' : 'refuse' });
    // (no post: null, or `{ refused: 'outside' }` when the one candidate's note was changed by hand)
    return e ? { post: e.post, title: e.title, version: e.version, address: e.address, permalink: e.permalink, date: e.date } : why.reason ? { refused: why.reason } : null;
  }

  // which threads "this and the ones above" takes: the owner's earlier unpublished eligible threads (with confirm 'never', only those
  // typed in the drawer: a thread written through another door is never published by one click)
  const aboveOf = (threads, at, S) => threads.slice(0, at).filter(t => eligibleThread(t).ok && !isPublishedThread(t)
    && (S.confirm !== 'never' || drawerTyped(t)));
  const drawerTyped = t => { const first = (t.msgs || []).find(m => m && m.kind !== 'tools'); return !!first && first.channel === 'drawer'; };

  // WHICH ONE BLYG POST the links name, verified as any source is (the companion's checker: the guarded fetch, the manifest, the
  // item document, the post's own page; then the note's strict checks, blygItemOf). → { origin, id, version, page, author } or null.
  // null unless EXACTLY ONE other blyg's post is linked and every link could be checked (a link that could not be asked might be a
  // second post); the owner's own blygs (`my_origins`) are not "other". At most LINK_STUB_MAX links are asked about.
  async function lonePostLink(urls, runId) {
    if (!urls.length || typeof deps.detectLink !== 'function') return null;
    if (urls.length > LINK_STUB_MAX) return null;
    const mine = (() => { try { const c = deps.readConfig(); return Array.isArray(c.my_origins) ? c.my_origins.map(String) : []; } catch { return []; } })();
    const found = new Map();
    // all at once, with ONE bound for the lot (LINK_CHECK_MS): a link not answered by then counts as one that could not be checked
    let timer = null;
    const late = new Promise(res => { timer = setTimeout(() => res('late'), deps.linkCheckMs !== undefined ? deps.linkCheckMs : LINK_CHECK_MS); });
    const answers = await Promise.race([Promise.all(urls.map(u => Promise.resolve().then(() => deps.detectLink(u)).catch(() => null))), late]);
    clearTimeout(timer);
    if (answers === 'late') { log.write(runId, { ev: 'note', text: 'the links could not all be checked in time, so the post is not made a response to a linked post' }); return null; }
    for (const [k, url] of urls.entries()) {
      const r = answers[k];
      if (!r || r.status === 'check-failed') { log.write(runId, { ev: 'note', text: 'a link could not be checked, so the post is not made a response to a linked post' }); return null; }
      if (r.status !== 'blyg' || !r.item) continue;
      const item = blygItemOf({ blyg: { status: 'blyg', item: r.item } });
      // the link must be the post's own page (a page that merely names a post is not the post)
      if (!item || !samePage(url, item.page) || mine.includes(item.origin)) continue;
      found.set(`${item.origin}${item.id}`, { origin: item.origin, id: item.id, version: item.version, page: item.page,
        author: String(r.item.author || '').slice(0, 200) });
    }
    return found.size === 1 ? [...found.values()][0] : null;
  }
  async function startNew({ page, threads, at, here, scope, S, id, cut = { extent: 'whole', upto: '' }, presence = 'here', prompts = DEFAULT_PROMPTS }) {
    const points = cut.extent === 'upto' ? { [here.id]: cut.upto } : {};
    const el = eligibleThread(here);
    if (!el.ok) return fail(409, el.why);
    const alone = isStandAlonePage(page);
    const picked = scope === 'one' || alone ? [here] : [...aboveOf(threads, at, S), here];
    if (picked.length > LIMITS.comments) return fail(409, `At most ${LIMITS.comments} threads can go in one post.`);
    // the chain: only for one comment, and only when an earlier post from this page is on the record
    let earlier = null;
    if (scope === 'one' && !alone) {
      const prev = threads.filter(t => isPublishedThread(t) && t !== here).map(t => t.blyg_published)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
      if (prev && prev.title && (prev.address || prev.permalink)) earlier = { title: prev.title, link: prev.address || prev.permalink };
    }
    const now = clock();
    const date = dayOf(now, S.timezone);
    const taken = permalinksIn(S.folder);
    let first = renderShortNote({ page, threads: picked, home: S, now, slug: 'x', earlier, points, prompts });
    if (!first.ok) return fail(409, first.error);
    // A LONE LINK: a new post that quotes no blyg post and answers nothing, whose words link to exactly one other blyg's post, is a
    // response to that post (only a new post: a published one never gains a target on a later edit)
    const linkStub = !stubOfPage(page) && !(first.sources || []).length ? await lonePostLink(linkTargetsOf(picked, points), id) : null;
    if (linkStub) first = renderShortNote({ page, threads: picked, home: S, now, slug: 'x', earlier, points, linkStub, prompts });
    if (S.escape === 'liquid' && showsLiquid(first.text)) return fail(409, LIQUID_SAY);
    // EVERY REASON TO LOOK IS KNOWN HERE, before the note is written: a queued press whose look is forced writes nothing and is set
    // aside (a new post has none of LOOK_FORCED; the check stays so the one policy is read in one place)
    { const ahead = reviewFor(S.confirm, { agentText: (first.generated || []).length > 0, notesRead: notesReadIn(first.generated), linkStub: !!linkStub, asked: presence === 'asked_to_look' });
      if (presence === 'away' && LOOK_FORCED.includes(ahead.review)) return parked(ahead.review); }
    const base = slugOf(first.title, { date });
    let rendered = null;
    let name = '';
    let slug = base;
    for (let n = 0; n < 60 && !rendered; n++) {
      const trySlug = n ? `${base.slice(0, LIMITS.slugChars - 4)}-${n + 1}` : base;
      const bid = newBlygId();   // the address is made of it; the FILE keeps the first-words slug
      const r = renderShortNote({ page, threads: picked, home: S, now, slug: trySlug, id: bid, earlier, points, linkStub, prompts });
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
    return drafted({ id, page, picked, scope, rendered, slug, rel, S, date, kind: 'new', version: 1, presence, extra: { chained_to: earlier ? { title: earlier.title } : null, extent: cut.extent, points, further: 0, prompts,
      ...(linkStub ? { link_stub: linkStub } : {}) } });
  }

  // A NEW VERSION of a post published from here: the same note file, rewritten with the same id and address (created and released
  // kept), the changelog line written from the difference (no model), and the site's commands in their edit form.
  async function startEdit({ page, here, S, id, adding = null, outside = '', cut = { extent: 'whole', upto: '' }, chosen = null, presence = 'here', drawerText = false, prompts = '' }) {
    const pub = { ...here.blyg_published, ...(postOf(here.blyg_published.permalink) || {}) };
    // THE POINTS: as recorded, with the chosen thread's moved (only forward) or, from the header, taken to the end
    const points = { ...(pub.points && typeof pub.points === 'object' ? pub.points : {}) };
    let further = 0;
    if (chosen && !adding) {
      const own = (chosen.msgs || []).filter(isPublishableMsg);
      const pos = ts => own.findIndex(m => String(m.ts) === String(ts));
      // where the published post reaches in this thread: its point, else the last message it was published with
      const snapMsgs = ((pub.snapshot && pub.snapshot.threads) || []).find(x => String(x.thread) === String(chosen.id));
      const lastTs = snapMsgs && snapMsgs.msgs && snapMsgs.msgs.length ? snapMsgs.msgs[snapMsgs.msgs.length - 1].ts : '';
      const reachedTs = points[chosen.id] || lastTs;
      const reached = reachedTs ? includedMsgs(chosen, reachedTs).length - 1 : own.length - 1;
      if (cut.extent === 'upto') {
        if (pos(cut.upto) < reached) return fail(409, UPTO_BACK_SAY);
        points[chosen.id] = cut.upto;
      } else {
        if (points[chosen.id]) further = Math.max(0, own.length - 1 - reached);
        delete points[chosen.id];
      }
    }
    if (adding && cut.extent === 'upto') points[adding.id] = cut.upto;
    const threads = page.threads || [];
    // the threads that went into that post (in the order they went in), and the comment being added to it, last
    const mates = matesOf(threads, pub);
    const picked = [...(mates.length ? mates : [here]), ...(adding ? [adding] : [])];
    if (!picked.some(t => (t.msgs || []).some(m => isPublishableMsg(m) && String(m.text || '').trim()))) return fail(409, 'Withdrawing a post is done on your site, not from here.');
    for (const t of picked) { const el = eligibleThread(t); if (!el.ok) return fail(409, el.why === 'that comment has no words' ? 'Withdrawing a post is done on your site, not from here.' : el.why); }
    if (picked.length > LIMITS.comments) return fail(409, `At most ${LIMITS.comments} threads can go in one post.`);
    // a comment the post holds whose thread is no longer on this page is LEFT OUT of this version: said in the dialog, never unseen
    const leftOut = recordedIdsOf(pub).filter(i => !picked.some(t => String(t.id) === i)).length;
    if (adding && leftOut) return fail(409, ADD_GONE_SAY);
    // the note: as recorded on the thread, or (a post published before the thread kept it) the one note that declares the post's id
    const note = publishedNoteOf(pub, S);
    if (!note.ok) return note;
    const { rel, target, before, fm, bid } = note;
    const now = clock();
    const slug = String(pub.slug || path.basename(rel, '.md').replace(/[^a-z0-9-]/g, '').slice(0, LIMITS.slugChars) || 'note');
    // a post that answered the one blyg post it linked to keeps that target (never gained or lost on an edit); each agent passage keeps
    // its form (`before`: the note on disk; its blyg_generated read by a real YAML parser, generatedOf)
    const linkStub = pub.link_stub && typeof pub.link_stub === 'object' ? pub.link_stub : null;
    // the post's prompts: as pressed, else as the post has them (a new version from the Hub keeps them)
    const had = PROMPT_MODES.includes(fmValue(fm, 'blyg_prompts')) ? fmValue(fm, 'blyg_prompts') : DEFAULT_PROMPTS;
    const choice = prompts || had;
    const rendered = renderShortNote({ page, threads: picked, home: S, now, slug, id: bid,
      keep: { created: fmValue(fm, 'created'), released: fmValue(fm, 'released'), before, ...(deps.generatedOf || generatedOf)(before, { cwd: S.top }) }, points, linkStub, prompts: choice });
    if (!rendered.ok) return fail(409, rendered.error);
    if (rendered.permalink.replace(/\/+$/, '') !== String(pub.permalink || '').replace(/\/+$/, '')) return fail(409, 'The post\'s address would change, so a new version is not written from here.');
    if (S.escape === 'liquid' && showsLiquid(rendered.text)) return fail(409, LIQUID_SAY);
    if (rendered.text === before || (rendered.text.replace(/^blyg_prompts:.*\n/m, '') === before.replace(/^blyg_prompts:.*\n/m, '') && !promptsOnlyChange(before, rendered.text))) {
      return fail(409, 'Nothing has changed since you published this.');
    }
    // CHANGED OUTSIDE THE PLUGIN: asked first, always; nothing is written until the owner answers `replace`
    // (the policy says so: `outside` is one of LOOK_FORCED; a queued press is set aside with nothing written)
    if (note.outside && outside !== 'replace' && presence === 'away' && reviewFor(S.confirm, { outside: true }).review === 'outside') return parked('outside');
    if (note.outside && outside !== 'replace') {
      log.write(id, { ev: 'note', text: 'the note was changed outside the plugin since it was last published from here: the owner is asked' });
      return { ...fail(409, OUTSIDE_SAY), outside: { say: OUTSIDE_SAY, lost: linesLost(before, rendered.text) } };
    }
    let changelog = pub.snapshot ? changelogLine(pub.snapshot, rendered.snapshot) : 'Edited the post.';
    // (replacing an outside edit is a change even when the comments are as they were published)
    if (!changelog && note.outside) changelog = 'Edited the post.';
    // ONLY THE PROMPTS CHOICE CHANGED: the site's page changes and its item does not (an item never carries a prompt), so this is
    // published as an edit that makes NO new version (the site's rule for a change that leaves the item as it was)
    const promptsOnly = promptsOnlyChange(before, rendered.text);
    if (promptsOnly) changelog = choice === 'shown' ? 'Prompts shown.' : 'Prompts locked.';
    if (!changelog) return fail(409, 'Nothing has changed since you published this.');
    { const ahead = reviewFor(S.confirm, { agentText: (rendered.generated || []).length > 0, notesRead: notesReadIn(rendered.generated), leftOut: leftOut > 0, further: further > 0, linkStub: !!linkStub, asked: presence === 'asked_to_look' });
      if (presence === 'away' && LOOK_FORCED.includes(ahead.review)) return parked(ahead.review); }
    try {
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0));
      try { fs.writeSync(fd, rendered.text); } finally { fs.closeSync(fd); }
    } catch { return fail(409, 'Could not rewrite the note.'); }
    // who is told: only a post this version newly quotes or answers (the site sends a mention for a NEW relation only)
    const newly = (rendered.snapshot.sources || []).some(u => !((pub.snapshot && pub.snapshot.sources) || []).includes(u))
      || (rendered.snapshot.stub && rendered.snapshot.stub !== ((pub.snapshot && pub.snapshot.stub) || ''));
    return drafted({ id, page, picked, scope: 'one', rendered: { ...rendered, notify: newly ? rendered.notify : '' }, slug, rel, S, date: dayOf(now, S.timezone), kind: 'edit', presence,
      version: (Number(pub.version) || 1) + (promptsOnly ? 0 : 1), extra: { changelog, changelog_from: 'program-fixed', prev_text: before, prev_sha: sha(before), chained_to: null, left_out: leftOut,
        prompts: choice,
        forms_moved: !!rendered.formsMoved, outside_replaced: !!note.outside, drawer_text: !!drawerText, extent: cut.extent, points, further, ...(linkStub ? { link_stub: linkStub } : {}) } });
  }

  function drafted({ id, page, picked, scope, rendered, slug, rel, S, date, kind, version, extra, presence = 'here' }) {
    const agentText = (rendered.generated || []).length > 0;
    const look = reviewFor(S.confirm, { agentText, notesRead: notesReadIn(rendered.generated), leftOut: !!(extra && extra.left_out), further: Number(extra && extra.further) > 0, linkStub: !!(extra && extra.link_stub),
      outsideReplaced: !!(extra && extra.outside_replaced), drawerText: !!(extra && extra.drawer_text), asked: presence === 'asked_to_look' });
    // WHAT EACH THREAD SAID in this version (the owner's included messages), kept in the post's record once published: a later queued
    // press of another thread of the post takes this thread's text from there, never from an older press or unpressed drawer text
    const texts = Object.fromEntries(picked.map(t => [String(t.id), includedMsgs(t, (extra && extra.points && extra.points[t.id]) || '').map(m => JSON.parse(JSON.stringify(m)))]));
    log.write(id, { ev: 'run', id, kind, version, settings_fp: fingerprint(S), page_url: page.url, scope, note_rel: rel, permalink: rendered.permalink,
      confirm: look.confirm, review: look.review, reasons: look.reasons, changelog: (extra && extra.changelog) || '' });
    const run = book.move('drafted', {
      id, token: crypto.randomBytes(16).toString('hex'), kind, version,
      page_url: page.url, thread_ids: picked.map(t => t.id), scope, title: rendered.title, slug, permalink: rendered.permalink,
      note_rel: rel, note_text: rendered.text, note_sha: sha(rendered.text), settings_fp: fingerprint(S), confirm: look.confirm, review: look.review, reasons: look.reasons, steps: [],
      reading: readingOf(rendered.text, rendered.generated), notify: rendered.notify || '', quotes: (rendered.sources || []).length > 0,
      snapshot: rendered.snapshot, pace: paceOf(S.plan_guard), full_minutes: fullMinutesFor(S.top),
      preview_url: previewUrlFor(S.preview_url, { permalink: rendered.permalink, slug, id: (rendered.permalink || '').split('/').filter(Boolean).pop() || '' }),
      day: date, presence, texts, ...extra,
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
        snapshot: run.snapshot || null, thread_ids: run.thread_ids || [], points: run.points && typeof run.points === 'object' ? run.points : {},
        ...(run.link_stub ? { link_stub: run.link_stub } : {}), ...(run.texts ? { texts: run.texts } : {}), at: published.at });
    } catch { published.record_error = 'The post is live, but the companion could not keep what it needs to publish a new version of it.'; }
    try {
      const page = deps.readPage(run.page_url);
      if (page) {
        for (const t of page.threads || []) {
          if (!run.thread_ids.includes(t.id)) continue;
          const before = t.blyg_published || {};
          t.blyg_published = { ...published, ...(before.address && !published.address ? { address: before.address } : {}), ...(before.at && run.kind === 'edit' ? { first_at: before.first_at || before.at } : {}),
            // the message this thread's part of the post ends at, when it does not go to the end (the drawer marks it; a public fact)
            ...(run.points && run.points[t.id] ? { upto: String(run.points[t.id]) } : {}) };
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
    // a press that arrives while the step is already being tried again (a second press, a late one): said plainly, nothing done
    if (RUNNING_MODES.includes(book.mode) || book.mode === 'applied') return { ...fail(409, 'It is already trying again.'), view: current() };
    const to = RETRY_FOR[book.mode] || '';
    if (!to || !canMove(book.mode, to)) return fail(409, 'There is no failed step to try again.');
    if (to === 'planning' || to === 'preparing') runPlan().catch(() => {});
    else runFrom(to === 'applying' ? 'apply' : 'publish');
    return { ok: true, view: viewOf(book.run) };
  }

  /** Take the draft away, but only the file this run made (or, for a new version, put the published text back) and only if it is as
   *  it was written. → the cleanup record ({ outcome, said } for the owner; the details go to the log). */
  async function undraft() {
    const run = book.run;
    const out = { outcome: 'left', said: '' };
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
      out.outcome = 'undone';
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
    if (tainted) cleanup = cleanupOf('left', `${tainted} Nothing was run or removed.`);
    else if (beforeApply(book.run)) cleanup = await undraft();
    else {
      cleanup = cleanupOf('left', publishUnsure(book.run) ? EDIT_UNSURE_SAY : 'Your note was left on your site: your site keeps its own record of this publish.');
      const home = settingsNow();
      if (home.ok && home.settings.commands.abandon && fingerprint(home.settings) === book.run.settings_fp) {
        const a = await step('abandon');
        if (!a.ok) {
          if (canMove(book.mode, 'abandon_failed')) book.move('abandon_failed', { abandon_failure: a.reason, abandon_failure_line: a.plain || '',
            abandoned_from: book.mode === 'abandon_failed' ? book.run.abandoned_from : book.mode });
          return { ...fail(409, `Your site could not give this publish up${a.plain ? `: ${a.plain}` : '.'} You can try again, or forget it here (nothing is run on your site).`), view: viewOf(book.run) };
        }
        cleanup = cleanupOf('left', publishUnsure(book.run) ? `Your site gave the publish up. ${EDIT_UNSURE_SAY}` : 'Your site gave the publish up; your note was left on your site.');
      }
      if (publishedNothing(book.run)) {
        const u = await undraft();
        cleanup = cleanupOf(u.outcome, u.outcome === 'undone' ? `Nothing was published. ${u.said}` : u.said);
      }
    }
    if (!canMove(book.mode, 'abandoned')) return fail(409, 'The run moved on meanwhile.');
    if (!beforeApply(book.run) && !publishedNothing(book.run)) distrust(book.run);
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
    if (book.mode !== 'abandon_failed' && !unknown && !publishUnsure(book.run)) return fail(409, 'Forget is offered only when your site could not give the publish up, when a new version may already be published, or when its step cannot be identified.');
    if (unknown && !sure) return { ...fail(409, 'Forgetting runs nothing and stops nothing: the earlier step may still be running on the companion\'s machine. Press Forget again to confirm.'), view: current() };
    if (!publishedNothing(book.run)) distrust(book.run);
    const note = String(book.run.note_rel || '').replace(/[^\w ./-]/g, '');
    logNote(`forgotten here (child ${state}); to end it on the example site by hand: scripts/blyg-publish --abandon ${note || '<note>'}, then scripts/blyg-publish ${note || '<note>'} --unstage-note`);
    book.move('abandoned', { cleanup: cleanupOf('forgotten', publishUnsure(book.run)
      ? `Forgotten here only: nothing was run on your site. ${EDIT_UNSURE_SAY}`
      : 'Forgotten here only: nothing was run on your site and nothing was removed. Your site may still hold this publish or the note; the troubleshooting details say how to end it there.') });
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

  return { book, log, start, earlierOf, earlierPublicOf, publishedMsgsOf, confirm, retry, carryOn, cancel, abandon, forget, current, previewOf, stopAll, STEPS };
}
// A QUEUED PRESS WHOSE LOOK IS FORCED (LOOK_FORCED) is answered with the reason and nothing written (blyg-queue sets it aside).
const parked = reason => ({ ok: false, status: 409, park: reason, about: 'entry', error: 'This post needs your look before it is published.' });
/** WHERE THE OWNER IS for a run, one value (`presence`, recorded on the run):
 *    here           at the dialog (a press run at once): a forced look stops at `planned`, the outside question is asked, as ever
 *    away           pressed and moved on (the publish queue started it): a forced look (LOOK_FORCED) is answered `park` BEFORE anything
 *                   is written, so the queue sets the post aside and goes on
 *    asked_to_look  the owner asked to see it first (a post the queue set aside, or one pressed while "see it first" was the setting):
 *                   it stops at `planned` (review `asked` when nothing else calls for a look) */
export const PRESENCES = Object.freeze(['here', 'away', 'asked_to_look']);
/** Who a start's refusal is about (`about`): the post itself, or the site or this machine (a failed pre-flight, a broken setting, a
 *  step still running): the queue fails the post for the first, and pauses, keeping the post, for the second. */
export const REFUSAL_ABOUT = Object.freeze(['entry', 'site']);
// (an exception while starting ONE post is about that post: it fails, the detail is in the run's log, and a queue goes on)
const START_BROKE_SAY = 'Something went wrong on the companion while starting this post, so it was not published; the troubleshooting details say what.';
export const settingChangedSay = (shown, inForce) => `The setting changed: your drawer showed “${String(shown || 'nothing').slice(0, 12)}” but “${inForce}” is in force (${inForce === 'never' ? 'one click publishes' : 'you will see the note first'}). Nothing was started. Open the menu again.`;
const LIQUID_SAY = 'This thread, or the passage it quotes, shows “{{” or “{%”. Your site keeps Liquid-looking text out of what it publishes, so it would refuse this post at the end of its checks. Nothing was written. Change the message (for example write “{ {”), or quote a different passage.';
