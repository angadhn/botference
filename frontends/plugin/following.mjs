// following.mjs — "Following": a private reading feed of blyg posts inside Discuss.
//
// The reader follows blygs (https://blygger.org/spec/0.4/); the companion keeps,
// per followed blyg, what its archive index says it holds, and shows one console:
// the Feed (what is new), Mentions (responses to the owner's posts, from the
// owner's own inbox) and Background (what should not interrupt reading). This is
// the READING half of a Blygger client: it publishes nothing and mentions nothing,
// and tells no blyg what it is read by whom.
//
// THE ONE WAY TO THE WEB. Every request here is made by netguard.mjs's guardedGet
// (or a test's stand-in for it, injected as `get`), through ONE function (`getter`)
// that counts it against the run's budget, refuses it when the host's breaker is
// open or when fetching is off, and is the only caller of `get`. This file never
// calls fetch, http or https itself (test/following.test.mjs reads the source AND
// runs the engine with every outbound primitive of the process made to throw).
// A blyg's manifest may not send the companion anywhere else: the index and every
// item document must be inside the blyg's own origin (`within`), after redirects too.
//
// WHAT IS NAMED, each as ONE list with ONE field and ONE function that moves it
// and refuses a move that is not in the table:
//   BLYG_STATES     a followed blyg's standing:           moveBlyg
//   READ_STATES     where a post is: in the Feed (new, opened, responded,
//                   edited), stepped aside to make room (older), or in the
//                   Archive (archived, archived_changed): moveRead
//   HOLD_STATES     whether a blyg's last refresh left new posts of it waiting: moveHold
//   BACKFILL_MODES  how far back one blyg has been read, a fault named
//                   in the mode (paused_bad_documents):    moveBackfill
//   RUN_STATES      the run lease (in the store): whether a refresh or a top-up is going, in all invocations: moveRun
//   BREAKER_STATES  a host's circuit breaker:             moveBreaker
//   SCHEDULE_MODES  whether the refresh timer is armed:   moveSchedule
//   IDENTITY_STATES whether a post's page agreed with the list: setIdentity
//   INBOX_STATES    the mentions inbox's standing:        moveInbox
//   MENTION_READ    a mention's read state:               moveMention
//   FRESH_MODES     whether a blyg's new posts are fetched or wait (failing): moveFresh
//   FOLLOW_STATES   followed, kept (unfollowed, read ids kept), forgotten: moveFollow
//   PART_STATES     a burst part fetched before its thread: movePart
//   STAR_STATES     the owner's private star on a post (independent of where it is): moveStar
// and, as values a function works out rather than states that move:
//   PLACEMENTS (placementOf: which view an entry belongs to, and why), IDENTITY_VERDICTS (identityFor), ANSWER_SOURCES, LAST_CHANGES.
//
// WHAT IS KEPT goes through ONE asynchronous store with a real compare-and-swap (following-store.mjs; fileStore by default), and
// every operation is a transaction over it (see "the storage seam"): a small main document (the follow list), a run document (the
// lease, the top-up gap, the breakers), per followed blyg a FEED (its unread posts and a summary of its numbers), an ARCHIVE (its
// archive records) and a LEDGER, the inbox, the stars, and one body per held post. Per post (never the whole HTML): origin, id, kind, current version, created, updated, title (first
// heading) or an excerpt, stub_of, its transclusions (with the versions named) and links, and the sanitised plain text the list
// needs (clipped). One record per post at its newest version (the rollup, §13.1). A withdrawn post (kind 'withdrawn') is a bare
// marker, so it is not fetched again (§13.4).
//
// THE ARCHIVE. The owner's own tick moves a post from the Feed to the Archive (read state `archived`): its body is deleted (after
// the save) and a small record stays (key, origin, id, kind, version read, index version, created, updated, fetched_at, the whole
// page address, content_hash, a title or first words of at most 120 characters, archived_at, and `returned_at` if an edit ever
// brought it back: about half a kilobyte; at most 1000 per blyg are kept, the oldest ticked dropped first, never a starred one).
// Each blyg has a LEDGER, a
// document of its own: the ids of the posts read, each with its post's `created` (5,000; then the oldest go and a FLOOR date
// rises: anything created at or before it counts as read), the ids whose documents could not be used (`bad`: 100 per blyg, 2,000
// in all, each for 7 days), the ids a host could not give (`later`, a back-off), its backfill mode, the newest date the Hub has
// seen from it (`seen_until`), the edit-returns of the last 24 hours, and the queue a top-up reads. The ledger is what keeps a
// post read after its record is gone, and an unfollow keeps its read ids and its GONE filter (unless asked to forget). The caps
// (`following_max_items_*`) count unread held posts only.
//
// THE LIMITS, TURNED THE RIGHT WAY ROUND. A NEW post always comes in. When a blyg then holds more unread posts than
// `following_max_items_per_blyg` (or all blygs together more than `following_max_items_total`), its OLDEST unread posts step
// aside (read state `older`, oldest across all blygs first for the total): the record stays in its blyg's feed document, slim and
// without text (its text is released), and the Feed's "Older posts" pages back through it; reading one fetches its text again.
// Never stepped aside: a starred post, one responded to (a note was exported), an edited one (it was read before). Nothing is held
// back at the limit any more. What may still wait (a run's time or requests, a blyg's fair share of them, a failing back-off) is
// said: the blyg's HOLD_STATES (`held`) puts one plain line on the page for that blyg. When there is room again (the owner reads),
// the reading back brings the newest older posts back first, with their text, before it reads any further back.
//
// THE EDIT RULE. A real edit (a new content_hash) of a post the owner read returns it to the Feed as `edited` at most once in 7
// days, at most 3 per blyg per refresh and 10 a day, within the unread cap; otherwise it waits in the Archive as
// archived_changed ("edited again"). At most 5 documents of read posts are fetched per blyg per refresh. A maintenance version
// (the same hash) moves nothing.
//
// THE BACKFILL. A refresh reads each blyg's index (hostile input: at most 20,000 entries, well-formed string ids, an id listed
// twice is one post at its highest version; none of it is stored but a 20-entry queue) and fetches, within the run's one budget:
// (1) documents of posts already held whose version moved; (2) FRESH posts, created after the newest date the Hub itself has
// seen from that blyg (never decided by the index's order), oldest first, up to the caps; (3) BACKFILL, only while the Feed holds
// fewer unread posts than `following_unread_target`: round-robin over the blygs, one post per blyg per round, a blyg's newest
// unfetched post first, a burst's thread before its parts; (4) documents of read posts, by the edit rule. What is left is
// deferred, never an error. After a tick a TOP-UP fetches only from the saved queues: no index, ten requests, once in 30 s.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { guardedGet as netGet, FetchTrouble, urlRefusal } from './netguard.mjs';
import { warnUnreadable } from './fsjson.mjs';
import { STORE_KINDS, StoreConflict, ledgerName, fileStore, memoryStore } from './following-store.mjs';
import { session, findManifest, identityOf, isManifest, ID_RE, clip, textContent, isWebUrl, samePage,
  docRefusal, cleanHints, candidateBase, pageLinks, LIMITS as BLYG_LIMITS } from './blyg.mjs';
import { sanitizeArticle, sanitizeStable } from './sanitize.mjs';
import { parseInbox, readTokenFile, redactor, scrubDeep, tokenFileWarning, REPOST_RE } from './following-inbox.mjs';

const CFG = createRequire(import.meta.url)('./extension/config.js');
export const { followingSettingsOf, originOf, FOLLOWING_NUMBERS } = CFG;

// ---- the named machines ----------------------------------------------------
function machine(name, states, moves) {
  for (const [ev, table] of Object.entries(moves)) {
    for (const [from, to] of Object.entries(table)) {
      if (!states.includes(from) || !states.includes(to)) throw new Error(`${name}: move ${ev} names a state that is not listed`);
    }
  }
  return {
    states, moves,
    can: (from, ev) => !!moves[ev] && Object.prototype.hasOwnProperty.call(moves[ev], from),
    to(from, ev) {
      if (!moves[ev]) throw new Error(`${name}: no such move ${ev}`);
      if (!states.includes(from)) throw new Error(`${name}: no such state ${from}`);
      if (!Object.prototype.hasOwnProperty.call(moves[ev], from)) throw new Error(`${name}: cannot ${ev} while ${from}`);
      return moves[ev][from];
    },
  };
}

// A followed blyg.
//   active      — refreshed on every run
//   paused      — the reader's choice: never fetched until resumed
//   unreachable — could not be asked (network, timeout, refused, too big);
//                 asked again after a back-off that doubles with each failure
//   gone        — it answered, repeatedly, and has no manifest or index any
//                 more; not asked again until the reader resumes it
export const BLYG_STATES = Object.freeze(['active', 'paused', 'unreachable', 'gone']);
export const BLYG_MOVES = Object.freeze({
  pause: { active: 'paused', unreachable: 'paused' },
  resume: { paused: 'active', unreachable: 'active', gone: 'active' },
  fail: { active: 'unreachable', unreachable: 'unreachable' },
  recover: { unreachable: 'active' },
  vanish: { active: 'gone', unreachable: 'gone' },
});
const blygMachine = machine('blyg state', BLYG_STATES, BLYG_MOVES);
export const canMoveBlyg = (b, ev) => blygMachine.can(b.state, ev);

// Whether a blyg is followed, ONE list and ONE function (the engine's moveFollow) for its moves. Where it is held says which:
// `blygs` (followed) or `kept` (unfollowed, its read ids kept), never both (moveFollow is the only writer of either map's
// membership; a hand-edited document with both is repaired on load).
//   followed  — in the follow list: refreshed, its posts held
//   kept      — unfollowed with "Stop following": its ledger (read ids and gone filter) is kept, so a refollow shows none again
//   forgotten — nothing kept (never followed, unfollowed with "forget", or a kept ledger expired: keptMax, keptMs)
//   follow           forgotten → followed
//   refollow         kept → followed (its ledger is used as it is, under the new follow's EPOCH: written again with it)
//   unfollow_keep    followed → kept
//   unfollow_forget  followed → forgotten
//   expire           kept → forgotten
// A burst part fetched before its thread (§13.7, finding 4a), ONE field `part` on its record, moved by movePart:
//   awaiting   — in Background, "waiting for its thread", until the thread is held or `awaits_until` (data: fetched + burstWaitMs)
//   folded     — the thread it waited for is held: from now on foldBursts alone decides whether it folds under it
//   standalone — the wait is over and the thread never came: it is an ordinary post
//   thread_held  awaiting → folded
//   wait_over    awaiting → standalone (refused before awaits_until: the time is data that gates the move)
// A post that never waited has no `part`.
export const PART_STATES = Object.freeze(['awaiting', 'folded', 'standalone']);
export const PART_MOVES = Object.freeze({ thread_held: { awaiting: 'folded' }, wait_over: { awaiting: 'standalone' } });
const partMachine = machine('burst part', PART_STATES, PART_MOVES);
export function movePart(rec, ev, at = Date.now()) {
  if (ev === 'wait_over' && at < (rec.awaits_until || 0)) throw new Error('burst part: cannot wait_over before awaits_until');
  rec.part = partMachine.to(rec.part, ev); return rec.part;
}
export const FOLLOW_STATES = Object.freeze(['followed', 'kept', 'forgotten']);
export const FOLLOW_MOVES = Object.freeze({
  follow: { forgotten: 'followed' }, refollow: { kept: 'followed' },
  unfollow_keep: { followed: 'kept' }, unfollow_forget: { followed: 'forgotten' }, expire: { kept: 'forgotten' },
});
const followMachine = machine('follow', FOLLOW_STATES, FOLLOW_MOVES);
/** The one way a followed blyg's state changes. Throws for a move the table does not allow. */
export function moveBlyg(b, ev) { b.state = blygMachine.to(b.state, ev); return b.state; }

// Where a post is, in ONE field. The Feed holds the unread posts (new, opened, responded, edited), the Archive the ones the
// owner ticked (archived, archived_changed); `older` ones stepped aside at a limit. There is no separate "archived" flag and no
// "edited" marker beside this field.
//   new              — in the Feed, not opened
//   opened           — in the Feed; its original (or its text here) was opened. Opening never archives it.
//   responded        — in the Feed; a note for it was exported
//   edited           — in the Feed again: the owner had ticked it, and a real edit (a new content_hash) brought it back
//                      ("edited since you read it")
//   archived         — ticked by the owner (and only by the owner's own tick); it keeps a small record and no text
//   archived_changed — still in the Archive, but a newer wording exists that the owner has not read: it could not come back
//                      yet (its window, or its blyg's quota, see LIMITS.edit*); the Archive says "edited again"
//   older            — unread, but stepped aside when its blyg (or the Hub) was over its limit and newer posts came in: a slim
//                      record in its blyg's feed document, no text (released), listed under the Feed's "Older posts". Never
//                      archived by this, never counted against the limits.
// There used to be a `seen` state (the dot only) and an `edited_after_read` marker beside `new`: a stored `seen` loads as `new`, a
// stored `edited_after_read` as `edited`.
//
//   tick      the owner's tick: Feed → Archive, or the owner's "Mark read" on an archived_changed line (the text is deleted)
//   untick    the owner's untick: Archive → Feed, as `new` (the post is fetched again: its text is gone)
//   edit      a fetched document of an archived post whose content_hash differs from the one read, when its bounds allow it
//             to return (archived → edited); a further real edit of an `edited` post keeps it edited
//   hold      the same, when they do not (archived → archived_changed; and a further version while held is recorded)
//   release   at a refresh, an archived_changed post whose window has passed, when its blyg's quota is free (→ edited)
//   revert    a held post whose current document is again the wording the owner read (→ archived): the newer one is gone
//   open      the original was opened (an edited post stays edited)
//   respond   a note for the post was exported (a post in the Archive is not moved by one)
//   resurface a real edit to a post that was opened (and is still unread) → new
//   renew     the owner's own "mark new" on an opened post
//   step_aside  over a limit, an unread post that is neither starred, responded to nor edited: Feed → older (stepAside)
//   restore     the reading back fetched an older post's text again, when its blyg has room: older → new
// (`tick` also takes an older post to the Archive: the owner read it from "Older posts".)
// Anything else is refused. A MAINTENANCE version (the same content_hash, §13.2) moves nothing, in any state: its version is
// recorded and it never counts as an edit.
export const READ_STATES = Object.freeze(['new', 'opened', 'responded', 'edited', 'older', 'archived', 'archived_changed']);
/** The read states that are in the Archive. */
export const ARCHIVE_STATES = Object.freeze(['archived', 'archived_changed']);
/** The read states whose record holds no text (a slim record only): the Archive's and `older`. Every other held post (not
 * withdrawn) is unread and has its text: that is what the limits count. */
export const TEXTLESS_STATES = Object.freeze([...ARCHIVE_STATES, 'older']);
export const READ_MOVES = Object.freeze({
  open: { new: 'opened', edited: 'edited' },
  respond: { new: 'responded', opened: 'responded', edited: 'responded' },
  resurface: { opened: 'new' },
  renew: { opened: 'new' },
  tick: { new: 'archived', opened: 'archived', responded: 'archived', edited: 'archived', older: 'archived', archived_changed: 'archived' },
  untick: { archived: 'new', archived_changed: 'new' },
  edit: { archived: 'edited', edited: 'edited' },
  hold: { archived: 'archived_changed', archived_changed: 'archived_changed' },
  release: { archived_changed: 'edited' },
  revert: { archived_changed: 'archived' },
  step_aside: { new: 'older', opened: 'older' },
  restore: { older: 'new' },
});
const readMachine = machine('read state', READ_STATES, READ_MOVES);
export const canMoveRead = (rec, ev) => readMachine.can(rec.read, ev);
export function moveRead(rec, ev) { rec.read = readMachine.to(rec.read, ev); return rec.read; }

// How far back one blyg has been read into the Feed (the backfill's own progress, kept in its ledger). ONE field; a fault is
// named in the mode itself, and every mode has a way out.
//   unknown              — its index has not been read since it was followed (or since a Retry, or a refollow)
//   more                 — its index lists posts that are neither held, read nor withdrawn: more to fetch (deferred: not an error)
//   caught_up            — nothing in its index is left to fetch: everything is held (unread), read, withdrawn, or waiting for a
//                          retry after the host could not answer
//   paused_bad_documents — reading BACK is paused for this blyg only: it served `badPerBlyg` documents that could not be used
//                          (or all blygs together served `badTotal`). New posts are still fetched. Out by the owner's Retry
//                          (the list is cleared) or by itself, when entries expire (`badExpiryMs`) and the list is below the bound.
// (Before this list there was a `stopped` mode with no way out but unfollowing: a stored `stopped` loads as `unknown`.)
//   remain / finish  after a refresh: more to read, or nothing left
//   pause_bad        the list of unusable documents is full
//   retry            the owner's Retry: the list is cleared and the index read afresh
//   recover          entries expired and the list is below its bounds again
//   forget           the blyg was unfollowed (its read ids and gone filter are kept, the rest starts again on a refollow)
export const BACKFILL_MODES = Object.freeze(['unknown', 'more', 'caught_up', 'paused_bad_documents']);
export const BACKFILL_MOVES = Object.freeze({
  remain: { unknown: 'more', more: 'more', caught_up: 'more' },
  finish: { unknown: 'caught_up', more: 'caught_up', caught_up: 'caught_up' },
  pause_bad: { unknown: 'paused_bad_documents', more: 'paused_bad_documents', caught_up: 'paused_bad_documents' },
  retry: { paused_bad_documents: 'unknown' },
  recover: { paused_bad_documents: 'more' },
  forget: { unknown: 'unknown', more: 'unknown', caught_up: 'unknown', paused_bad_documents: 'unknown' },
});
const backfillMachine = machine('backfill', BACKFILL_MODES, BACKFILL_MOVES);
// Whether a blyg's FRESH posts are being fetched (kept in its ledger, with two data fields that gate it: `fresh_failures`, how
// many runs in a row ended with freshFailuresPerRun failed fresh fetches, and `fresh_after`, when to try again).
//   reading — its fresh posts are fetched each run, within its fair share of the run
//   failing — a run's fresh fetches failed (404, 410, 403, an unusable document, a host that could not answer) freshFailuresPerRun
//             times: its fresh posts wait for a back-off that doubles each failing run (backoffMs), then are tried again. This
//             counts every failing fresh entry, however many: a blyg cannot list thousands of fresh ids that 404 and take a run's
//             budget for ever.
//   fail     a run's fresh fetches failed: reading → failing, failing → failing (the back-off doubles)
//   recover  a fresh fetch worked: failing → reading
export const FRESH_MODES = Object.freeze(['reading', 'failing']);
export const FRESH_MOVES = Object.freeze({ fail: { reading: 'failing', failing: 'failing' }, recover: { failing: 'reading' } });
const freshMachine = machine('fresh', FRESH_MODES, FRESH_MOVES);
export function moveFresh(led, ev) { led.fresh = freshMachine.to(led.fresh, ev); return led.fresh; }
// Whether a blyg's last refresh left NEW posts of it waiting (kept in its ledger, copied to its feed's summary, which the page
// reads). A new post is never held back by a limit (see THE LIMITS above); it can still wait for the run's time or requests, the
// blyg's fair share of them, or its failing back-off (FRESH_MODES). The page then says so in one line for that blyg.
//   clear — every new post the last refresh of this blyg found is in
//   held  — some wait for the next refresh
//   hold   a refresh of the blyg ended with new posts not fetched: clear → held, held → held
//   clear  a refresh of the blyg fetched every new post it found:  held → clear, clear → clear
export const HOLD_STATES = Object.freeze(['clear', 'held']);
export const HOLD_MOVES = Object.freeze({ hold: { clear: 'held', held: 'held' }, clear: { held: 'clear', clear: 'clear' } });
const holdMachine = machine('hold', HOLD_STATES, HOLD_MOVES);
export function moveHold(led, ev) { led.holding = holdMachine.to(led.holding, ev); return led.holding; }
export const canMoveBackfill = (led, ev) => backfillMachine.can(led.backfill, ev);
export function moveBackfill(led, ev) { led.backfill = backfillMachine.to(led.backfill, ev); return led.backfill; }

// THE RUN LEASE: whether a refresh or a top-up is going, in ALL invocations (a serverless host runs several at once). It is the
// `lease` of the store's run document: ONE field, moved only here, with its holder and `until` (data that gates `lapse`).
//   idle        — nothing is being fetched
//   running     — a refresh: manifests, indexes, documents (refresh)
//   topping_up  — a top-up after a tick: documents from the ledgers' saved queues only, no manifest or index (topUp)
//   begin / topup  idle → running / topping_up (taken in a transaction: two invocations cannot both take it)
//   renew          running → running, topping_up → topping_up: its holder moves `until` on
//   end            back to idle, by its holder
//   lapse          back to idle when its holder died: refused before `until` (a crashed invocation blocks at most that long)
// `topup` is also refused (by topUp, before the move) until `topup_after`, a time kept beside it in the run document: at most one
// top-up every topupGapMs, however fast the owner ticks and however many invocations there are.
export const RUN_STATES = Object.freeze(['idle', 'running', 'topping_up']);
export const RUN_MOVES = Object.freeze({ begin: { idle: 'running' }, topup: { idle: 'topping_up' }, end: { running: 'idle', topping_up: 'idle' },
  renew: { running: 'running', topping_up: 'topping_up' }, lapse: { running: 'idle', topping_up: 'idle' } });
const runMachine = machine('run state', RUN_STATES, RUN_MOVES);
export function moveRun(run, ev, at = Date.now()) {
  if (ev === 'lapse' && at < (run.until || 0)) throw new Error('run state: cannot lapse before until');
  run.state = runMachine.to(run.state, ev); return run.state;
}
// THE STAR: the owner's private mark on a post, to come back to it (on a laptop, to write a reply). Independent of where the post
// is (READ_STATES): starring never marks it read, a tick never removes it. ONE field, `star`, on the post's star record (in the
// store's stars document; a plain record is not kept), moved only by moveStar.
//   plain    — not starred
//   starred  — starred: listed in the Starred tab, newest starred first; its archive record is never trimmed
//   star     plain → starred (refused beyond LIMITS.starsMax)
//   unstar   starred → plain
export const STAR_STATES = Object.freeze(['plain', 'starred']);
export const STAR_MOVES = Object.freeze({ star: { plain: 'starred' }, unstar: { starred: 'plain' } });
const starMachine = machine('star', STAR_STATES, STAR_MOVES);
export const canMoveStar = (e, ev) => starMachine.can(e.star, ev);
export function moveStar(e, ev) { e.star = starMachine.to(e.star, ev); return e.star; }

// THE CONVERSION of a store of an older layout into this one. ONE field, `migration.state` of the main document (none stored:
// not_started), moved only by moveMigration. See "the conversion" below for what each step writes and why nothing is lost.
//   not_started   — no main document of this layout: nothing stored yet, or a document of an older layout (where the older
//                   code keeps it: the main document itself on the companion, 'legacy' on the hosted Hub)
//   converting    — this layout's main document is written, carrying the copy of the document converted (`copy`, `from`):
//                   every invocation that reads it first finishes the conversion (each step keeps what is already there)
//   keeping_copy  — converted; the copy is kept in 'pre-shard' (and the older bodies where they were) until `copy_until`, the
//                   QUIET PERIOD (LIMITS.migrationQuietMs): an invocation of the older code may still be running
//   done          — the copy and the older bodies are deleted (by a sweep after `copy_until`), or there was nothing to convert
//   begin      not_started → converting   (one conditional write claims it: two invocations cannot both)
//   converted  converting → keeping_copy  (after every blyg's documents, the inbox and the unread posts' text are in place)
//   finish     keeping_copy → done        (refused before copy_until: data that gates the move)
//   fresh      not_started → done         (a Hub with nothing to convert)
export const MIGRATION_STATES = Object.freeze(['not_started', 'converting', 'keeping_copy', 'done']);
export const MIGRATION_MOVES = Object.freeze({ begin: { not_started: 'converting' }, converted: { converting: 'keeping_copy' },
  finish: { keeping_copy: 'done' }, fresh: { not_started: 'done' } });
const migrationMachine = machine('migration', MIGRATION_STATES, MIGRATION_MOVES);
export function moveMigration(m, ev, at = Date.now()) {
  if (ev === 'finish' && at < (m.copy_until || 0)) throw new Error('migration: cannot finish before the quiet period is over');
  m.state = migrationMachine.to(m.state, ev); return m.state;
}
// HOW AN ATTEMPT OF A TRANSACTION RUNS (see "the storage seam"). ONE field, the attempt's `rerun`, moved only by moveRerun.
//   first        — the first attempt
//   again        — a re-run after a conflict, on what is stored now
//   again_mine   — a re-run that found a document whose last FINAL write was this operation's own earlier attempt: its move may
//                  be applied already, and is then done, not refused (a re-run of a tick that finds the post archived)
//   conflict     any → again           (a write lost the race, or a read met a conversion in progress)
//   found_mine   again → again_mine     (decided from the documents read, before the operation runs)
export const RERUN_MODES = Object.freeze(['first', 'again', 'again_mine']);
export const RERUN_MOVES = Object.freeze({ conflict: { first: 'again', again: 'again', again_mine: 'again' }, found_mine: { again: 'again_mine' } });
const rerunMachine = machine('re-run', RERUN_MODES, RERUN_MOVES);
export function moveRerun(a, ev) { a.rerun = rerunMachine.to(a.rerun, ev); return a.rerun; }
// A document or a body that NOTHING names (a sweep found it), in the run document's `marks`: ONE value per name, moved only by
// moveSweepMark (a name not marked is `unmarked`).
//   unmarked  — named, or not seen unnamed yet
//   marked    — seen unnamed by sweep number `seq`, at `at` (by the sweeper's clock)
//   mark      unmarked → marked
//   sweep     marked → (deleted)        only by a LATER sweep AND when its own written-at is older than LIMITS.bodySweepAgeMs:
//                                       a body is written before the record that names it, so a young one may be another
//                                       invocation's not committed yet. Two sweeps apart is a count, not a clock (see TIMED RULES).
//   named     marked → unmarked         (a record names it again)
export const SWEEP_MARKS = Object.freeze(['unmarked', 'marked']);
export const SWEEP_MOVES = Object.freeze({ mark: { unmarked: 'marked' }, sweep: { marked: 'unmarked' }, named: { marked: 'unmarked' } });
const sweepMachine = machine('sweep mark', SWEEP_MARKS, SWEEP_MOVES);
export function moveSweepMark(m, ev) { m.state = sweepMachine.to(m.state, ev); return m.state; }

// A host's circuit breaker: closed (asked), open (not asked until it cools),
// half-open (one probe decides).
export const BREAKER_STATES = Object.freeze(['closed', 'open', 'half-open']);
export const BREAKER_MOVES = Object.freeze({
  trip: { closed: 'open', 'half-open': 'open' },
  ok: { closed: 'closed', 'half-open': 'closed' },
  cool: { open: 'half-open' },
});
const breakerMachine = machine('breaker', BREAKER_STATES, BREAKER_MOVES);
export function moveBreaker(b, ev) { b.state = breakerMachine.to(b.state, ev); return b.state; }
export const BREAKER = Object.freeze({ threshold: 3, cooldownMs: 15 * 60 * 1000 });

// Whether the refresh timer is armed. It is armed exactly while something is
// followed (or an inbox is set) AND fetching is allowed. The timer's handle is kept
// beside this field and means something only while the mode is 'scheduled'.
export const SCHEDULE_MODES = Object.freeze(['off', 'scheduled']);
export const SCHEDULE_MOVES = Object.freeze({
  arm: { off: 'scheduled', scheduled: 'scheduled' },
  disarm: { scheduled: 'off' },
});
const scheduleMachine = machine('schedule', SCHEDULE_MODES, SCHEDULE_MOVES);
export function moveSchedule(s, ev) { s.mode = scheduleMachine.to(s.mode, ev); return s.mode; }

// Whether the page a reader opened from the list was the post the list said.
//   unverified — the page has not been compared yet
//   agrees     — the page's own links named the same blyg and post
//   disagrees  — they named something else: the list's word was NOT used for it
export const IDENTITY_STATES = Object.freeze(['unverified', 'agrees', 'disagrees']);
export const IDENTITY_MOVES = Object.freeze({
  agree: { unverified: 'agrees', agrees: 'agrees', disagrees: 'agrees' },
  disagree: { unverified: 'disagrees', agrees: 'disagrees', disagrees: 'disagrees' },
});
const identityMachine = machine('identity', IDENTITY_STATES, IDENTITY_MOVES);
export function setIdentity(rec, ev) { rec.identity = identityMachine.to(rec.identity, ev); return rec.identity; }

// The mentions inbox.
//   off          — no inbox_api_url is set
//   pending      — set, not asked yet
//   ok           — the last answer was a JSON document
//   unauthorised — the inbox said 401 or 403, or there is no usable token file
//   paused       — set, but fetching is off (blyg_checks), so it is not asked
//   unreachable  — it could not be asked, or answered something other than 2xx, or from another origin
//   unreadable   — it answered, but not with a JSON object this code can read (or nested too deeply)
export const INBOX_STATES = Object.freeze(['off', 'pending', 'paused', 'ok', 'unauthorised', 'unreachable', 'unreadable']);
const ASKED_STATES = ['pending', 'ok', 'unauthorised', 'unreachable', 'unreadable'];
const everyAsked = to => Object.fromEntries(ASKED_STATES.map(s => [s, to]));
export const INBOX_MOVES = Object.freeze({
  set: { off: 'pending', paused: 'pending' },
  unset: { ...everyAsked('off'), paused: 'off' },
  pause: everyAsked('paused'),
  succeed: everyAsked('ok'),
  deny: everyAsked('unauthorised'),
  fail: everyAsked('unreachable'),
  garble: everyAsked('unreadable'),
});
const inboxMachine = machine('inbox', INBOX_STATES, INBOX_MOVES);
export function moveInbox(box, ev) { box.state = inboxMachine.to(box.state, ev); return box.state; }

// A mention's read state (the Mentions tab's unseen count).
export const MENTION_READ = Object.freeze(['unseen', 'seen']);
export const MENTION_MOVES = Object.freeze({ see: { unseen: 'seen' } });
const mentionMachine = machine('mention read state', MENTION_READ, MENTION_MOVES);
export const canMoveMention = (m, ev) => mentionMachine.can(m.read, ev);
export function moveMention(m, ev) { m.read = mentionMachine.to(m.read, ev); return m.read; }

// Whether one version in a post's changelog is pinned (§8: a pinned version has a permanent document at
// items/<id>/v<n>.json and a page). Read from the changelog of the document already fetched; the pinned
// documents themselves are never fetched here.
export const VERSION_PINS = Object.freeze(['unpinned', 'pinned']);
// What a version of a post changed (worked out when it is fetched, by changeOf):
//   new-words   — it is new to the list, or its words really changed
//   minor       — its words changed by no more than the reader's threshold (§13.2, "barely changed")
//   maintenance — same content_hash as the version before (§13.2)
export const LAST_CHANGES = Object.freeze(['new-words', 'minor', 'maintenance']);
// Where an answer about a page came from: asked of the post's site, or built from the list.
// ...and 'item-document': the text of the page record came from the post's own item document, so the identity on it
// (origin, id, version) is the document's, not a page's say-so.
export const ANSWER_SOURCES = Object.freeze(['detected', 'from-list', 'item-document']);
// What is held of a post's body (the sanitised content, in a file of its own): all of it, the first part of it (the
// stored cap was reached, so "Read here" has the rest), or none (a withdrawn post, or one kept before bodies were).
export const BODY_STATES = Object.freeze(['whole', 'truncated', 'none']);
// What identityFor says about a page.
//   none        the list holds no post with that page
//   agrees      the page's OWN links name the blyg and the item the list holds: the list's identity is used
//   unconfirmed the page sent no links, or only one of the two: nothing to compare, normal detection runs
//   disagrees   the page's own links name something else: the list is not used, detection runs, the entry says so
export const IDENTITY_VERDICTS = Object.freeze(['none', 'agrees', 'unconfirmed', 'disagrees']);


// ---- limits ----------------------------------------------------------------
export const LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  indexBytes: 4 * 1024 * 1024,
  itemBytes: 4 * 1024 * 1024,
  importBytes: 1024 * 1024,
  inboxBytes: 4 * 1024 * 1024,
  timeoutMs: 8000,
  indexEntries: 20000,        // more entries than this in one index are not read
  docsPerBlygRun: 50,         // item documents fetched for one blyg in one run
  freshShareMin: 5,           // fresh documents per blyg per run: min(docsPerBlygRun, max(freshShareMin, run requests / blygs due))
  freshFailuresPerRun: 3,     // failed fresh fetches (missing, unusable, host trouble) after which a blyg's fresh loop stops for the
                              // run, and its fresh posts wait (FRESH_MODES failing, back-off backoffMs doubling up to backoffMaxMs)
  followMax: 500,             // blygs followed
  importMax: 100,             // entries of a blogroll resolved in one preview
  importRequests: 300,        // requests one preview may make
  followRequests: 12,         // requests following one URL may make
  mentionsKept: 500, noteChars: 200,
  versionsKept: 10,           // versions of a post kept on its record (changelog lines, with their notes): its history shows these
                              // (the record is rewritten with every move in its blyg's feed: 100 notes made it ~27 KB)
  bodyBytes: 40 * 1024,       // sanitised HTML kept per post, in a file of its own
  feedEntries: 100,           // entries (with their text) one page of the Feed carries
  archivePage: 50,            // lines one page of the Archive shows ("show more" adds this many, up to archiveShownMax)
  archiveShownMax: 1000,
  archiveRecordsPerBlyg: 500, // archive records kept per blyg for display (~0.45 KB each, in its archive document, which a tick in that
                              // blyg rewrites: ~225 KB at the bound with ordinary addresses); beyond it the
                              // oldest-ticked are dropped (never a starred one). Their ids stay in the ledger: that keeps them read.
  starsMax: 500,
  bodySweepAgeMs: 3600e3,     // a body (or a blyg's document) nothing names is deleted only when older than this AND found unnamed by
                              // an earlier sweep too (it may belong to a transaction not yet committed: SWEEP_MARKS, TIMED RULES)
  sweepMarksKept: 2000,       // names a sweep remembers as unnamed (the rest are looked at again by the next sweep)
  migrationQuietMs: 24 * 3600e3, // the conversion's quiet period: its copy and the older bodies are kept this long (MIGRATION_STATES)
  mainEvery: 10,              // a refresh writes what it learned about each blyg (last tried, failures, title) to the main document
                              // once every this many blygs and at its end: a crash loses at most that many blygs' bookkeeping
  leaseMarginMs: 30 * 1000,   // a run lease lasts the run's seconds and this much more (then another invocation may take it back)
  txAttempts: 6,              // a transaction that keeps meeting another's write is run this many times, then refused plainly
  opsKept: 8,                 // operation ids a document keeps (so a re-run never writes it twice)
  breakersKept: 200,          // hosts whose breaker the run document keeps (closed, unfailed ones are not kept)
  archiveTitleChars: 120,     // a record's title, or the first words of the post
  archiveIdsPerBlyg: 5000,    // read ids remembered per blyg, each with its post's `created` (~46 bytes each: ~0.23 MB at the
                              // bound). At the bound the oldest `ledgerTrim` go into the blyg's GONE filter (a Bloom filter of
                              // ids, never of dates: a blyg that re-dates its posts cannot bring one back). A blyg is never stopped.
  goneBits: 479232,           // the gone filter's size in bits (59,904 bytes; 79,872 characters of base64 in the ledger) ...
  goneHashes: 7,              // ... and hashes: 1% false positives at 50,000 ids (a false positive hides one post of that blyg),
                              // about 8% at 100,000
  ledgerTrim: 500,            // ids dropped at once when a ledger is full (so it is not trimmed on every tick)
  badPerBlyg: 100,            // ids whose document could not be used (a 2xx answer that failed its checks), per blyg, with the
                              // version the index gave and when: at the bound reading back pauses for that blyg (fresh posts go on)
  badTotal: 2000,             // ... and in all blygs together (the blyg that reaches it pauses the same way)
  badExpiryMs: 7 * 24 * 3600e3, // an unusable document is asked for again after this long (or at once when the index names a new version)
  laterPerBlyg: 200,          // ids whose document a host could not give (404, 410, 403), asked again after a doubling back-off
  keptMax: 50,                // ledgers kept for blygs unfollowed without "forget" (their read ids and gone filter only) ...
  keptMs: 365 * 24 * 3600e3,  // ... for at most this long; beyond either bound the oldest is forgotten
  pageChars: 2048,            // a post's page address (refused beyond it, never cut: a cut address opens something else)
  textChars: 1200, excerptChars: 240, titleChars: 160,
  refsKept: 50,               // a thread's references to posts of ITS OWN blyg (what a burst folds), each { id, version } (the origin is
                              // the post's own, not repeated): so a burst of 50 parts still folds under its thread
  refOriginsKept: 20, refOriginChars: 200, // the other blygs it references (for "Responses to me"); a longer origin is not kept
  burstMs: 10 * 60 * 1000,    // items created this close to their thread's publish are one burst
  burstWaitMs: 24 * 3600e3,   // a fragment of a burst whose thread is not held yet waits in Background this long, then stands alone
  backoffFirstMs: 10 * 60 * 1000, backoffMaxMs: 6 * 60 * 60 * 1000,
  tickBatch: 100,             // posts one "Tick all shown" request may tick (the page sends the rest in further requests)
  burstMembersMax: 100,       // member keys one tick of a thread may name (a fold has at most refsKept members anyway)
  backfillShare: 1 / 3,       // of a refresh's requests, kept for reading back while the Feed is short of its target
  queuePerBlyg: 20,           // the next unfetched index entries a refresh saves per blyg (validated), for the top-up
  topupRequests: 10,          // requests one top-up may make (documents only: a top-up reads no manifest and no index)
  topupSeconds: 15,           // ... and seconds
  topupGapMs: 30 * 1000,      // at least this long between two top-ups
  goneAfter: 3,               // consecutive "no manifest here" answers before a blyg is gone
  skewMs: 5 * 60 * 1000,      // a `created` further in the future than this is a lie: it never makes a post fresh
  // AN EDIT OF A POST THE OWNER HAD READ (a fetched document of an archived post whose content_hash differs from the one read).
  // The owner wants edits, but not often: it returns to the Feed (`edited`) only within all of these; otherwise it stays in the
  // Archive as archived_changed ("edited again") and is released at a later refresh when they allow it.
  editReturnGapMs: 7 * 24 * 3600e3, // a post returns to the Feed at most once in this long (`returned_at` on its record)
  editReturnsPerRun: 3,       // edit-returns per blyg per refresh
  editReturnsPerDay: 10,      // ... and per blyg in any 24 hours (the ledger's `returns`)
  archivedDocsPerRun: 5,      // documents of archived posts fetched per blyg per refresh (only while a return is possible)
  editedPerBlyg: 3,           // edited posts of one blyg unread at once (more wait in the Archive, released as the owner ticks)
  massEditPerDay: 5,          // more read posts of one blyg than this changing in 24 hours is a MASS EDIT: none returns, the Archive
                              // says so in one line for the blyg (and a below-threshold change, judged by the fingerprint, is none)
  // (an edit-return is never held back by the unread limits: at a limit the oldest unread posts step aside, as for a new post)
  olderPerBlyg: 1000,         // `older` records (stepped aside, ~0.35 KB each, no text) kept per blyg in its feed document: beyond it
                              // the oldest leave the list (never marked read: the reading back fetches them again, in order, when
                              // the owner has read down to them)
});
const KINDS = ['fragment', 'thread', 'withdrawn'];
export const isWithdrawn = rec => rec.kind === 'withdrawn';
// why a request or document was refused, in the words the page shows
export const REFUSALS = Object.freeze({
  index: 'its manifest points its items index outside the blyg\'s own origin, which Discuss will not fetch',
  item: 'its manifest points its item documents outside the blyg\'s own origin, which Discuss will not fetch',
  redirect: 'a document was served from outside the blyg\'s own origin, which Discuss will not accept',
});

// ---- clean strings out of remote documents ----------------------------------
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A string out of somebody else's document, made safe to keep AND to show: no control or bidirectional-override characters, one line, bounded. */
export const cleanText = (v, n = 300) => clip(String(typeof v === 'string' ? v : '').replace(/[\u0080-\u009f]/g, ' ').replace(BIDI, ''), n);

/** The internal identity of a post: its blyg and its id. (The key a page's buttons carry is a separate, random one.) */
export const identOf = (origin, id) => `${origin}\n${id}`;
const randomKey = () => crypto.randomBytes(12).toString('hex');
const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
/** Is `url` inside `origin` (same scheme, host and port, and a path under its path)? */
export function within(origin, url) {
  try {
    const o = new URL(origin), u = new URL(String(url));
    return u.protocol === o.protocol && u.host === o.host && u.pathname.startsWith(o.pathname.endsWith('/') ? o.pathname : o.pathname + '/');
  } catch { return false; }
}

// ---- reading what the reader gives us (pure) --------------------------------
const xmlDecode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
  const l = e.toLowerCase();
  if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'amp') return '&';
  if (l === 'quot') return '"'; if (l === 'apos') return "'";
  const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
});
const originOfUrl = v => { try { const u = new URL(String(v || '').trim()); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
/** OPML → [{ title, url, feed }] (a regex over outline tags: no entity expansion, no DOCTYPE, nothing executed). */
export function parseOpml(text) {
  const out = [];
  for (const m of String(text || '').slice(0, LIMITS.importBytes).matchAll(/<outline\b([^>]*?)\/?>/gi)) {
    const a = {};
    for (const x of m[1].matchAll(/([A-Za-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[x[1].toLowerCase()] = xmlDecode(x[2] ?? x[3] ?? '');
    const html = originOfUrl(a.htmlurl), feed = originOfUrl(a.xmlurl);
    const url = html || feed;
    if (!url) continue;
    out.push({ title: cleanText(a.title || a.text, 160), url, feed: feed || '' });
    if (out.length >= 5000) break;
  }
  return out;
}
/** A directory document (blygger.com's /blygs.json: an object holding a list, or a list) → [{ origin, title, feed }]. */
export function parseDirectory(text) {
  let j;
  try { j = JSON.parse(String(text || '').slice(0, LIMITS.importBytes)); } catch { return []; }
  const list = Array.isArray(j) ? j
    : j && typeof j === 'object' ? (['blygs', 'entries', 'items', 'blyg'].map(k => j[k]).find(Array.isArray) || []) : [];
  const out = [];
  for (const e of list.slice(0, 5000)) {
    if (!e || typeof e !== 'object') continue;
    const origin = originOf(e.origin);
    if (!origin) continue;
    out.push({ origin, title: cleanText(e.title, 160), feed: originOfUrl(e.feed) });
  }
  return out;
}

// ---- plain text, dates, reading time, bodies ----------------------------------
/** Markdown and directive syntax out of a line of text, leaving the words: links keep their text, images, `![[..]]` directives, `[[id]]` links, headings, quote markers and emphasis marks go. */
export function plainText(v) {
  let s = String(v == null ? '' : v);
  s = s.replace(/^[ \t]*!\[\[[^\]]*\]\][ \t]*$/gm, ' ').replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/^[ \t]*>+[ \t]?/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]+(?=\S)/g, '$1').replace(/(\S)[*_]+(?=\s|$|[.,;:!?)])/g, '$1');
  return s;
}
const wordsIn = s => (String(s).match(/\S+/g) || []).length;
/** "< 1 min", "2 min": 220 words a minute. */
export const readingLabel = words => { const m = Number(words) / 220; return m < 1 ? '< 1 min' : `${Math.round(m)} min`; };
/** The first language tag of an Accept-Language header that Intl knows, else en-US. */
export function localeOf(header) {
  for (const part of String(header || '').split(',')) {
    const tag = part.split(';')[0].trim();
    if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) {
      try { if (Intl.DateTimeFormat.supportedLocalesOf([tag]).length) return tag; } catch { /* next */ }
    }
  }
  return 'en-US';
}
/** "Nov 22, 2026" (en-US) or "22 Nov 2026" (en-GB); with time, ", 09:45". Stored values are never changed; '' for a date that is not one. */
export function formatDate(iso, locale = 'en-US', withTime = false) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}) }).format(new Date(t));
  } catch { return ''; }
}
/** A post's sanitised body (the SAME sanitiser the article view uses), capped; and how many words it has. → { html, state, words } */
export function bodyOf(doc) {
  const src = typeof doc.content_html === 'string' && doc.content_html.trim() ? doc.content_html : mdFallbackHtml(doc.content_md);
  const r = sanitizeStable(src, { max: LIMITS.bodyBytes, truncate: true, landmarks: false });
  return { html: r.html, state: !r.html.trim() ? 'none' : r.tooBig ? 'truncated' : 'whole', words: wordsIn(textContent(src)) };
}
/** Markdown with nothing rendered: paragraphs of escaped text (the fallback when a document has no HTML). */
export function mdFallbackHtml(md) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(md == null ? '' : md).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}
const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'col']);
/** Top-level blocks of sanitised HTML (an element and everything in it, or a run of top-level text): so a clip is never inside a quote, list or paragraph. */
export function splitBlocks(html) {
  const out = [];
  let depth = 0, start = 0;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const name = m[2].toLowerCase();
    if (m[1]) depth = Math.max(0, depth - 1);
    else if (!VOID_TAGS.has(name)) depth++;
    if (depth === 0) { out.push(html.slice(start, re.lastIndex)); start = re.lastIndex; }
  }
  if (start < html.length && html.slice(start).trim()) out.push(html.slice(start));
  return out;
}
/** The body to show: { head, rest, words }. A fragment, and any post of at most `clipWords` words, is all head. Otherwise the head runs to the first block boundary at or past clipWords. */
export function clipBody(html, kind, clipWords) {
  const blocks = splitBlocks(html);
  const counts = blocks.map(b => wordsIn(b.replace(/<[^>]*>/g, ' ')));
  const total = counts.reduce((a, b) => a + b, 0);
  if (kind === 'fragment' || total <= clipWords) return { head: html, rest: '', words: total };
  let n = 0, i = 0;
  while (i < blocks.length) { n += counts[i]; i++; if (n >= clipWords) break; }
  return { head: blocks.slice(0, i).join(''), rest: blocks.slice(i).join(''), words: total };
}

// ---- turning a fetched item document into the record we keep ----------------
function firstHeading(html) {
  const m = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i.exec(String(html || ''));
  return m ? cleanText(textContent(m[1]).replace(/\n+/g, ' '), LIMITS.titleChars) : '';
}
// A transclusion as kept: origin and id, and the version the thread named (§13.7: a fold covers the versions published in the burst)
const refOf = (r, dflt) => {
  if (!r || typeof r !== 'object' || !ID_RE.test(String(r.id || ''))) return null;
  const origin = originOf(r.origin || dflt);
  return origin ? { origin, id: r.id, ...(Number.isInteger(r.version) && r.version >= 1 ? { version: r.version } : {}) } : null;
};
/**
 * → the record to keep for a verified item document, or { invalid: why }. `page` is
 * where the post lives (§5.8: it may be absolute and outside the blyg's mount, even on
 * another host). It is only an address to OPEN: it never supplies the post's identity.
 */
export function recordFromDoc(doc, origin, blyg = {}) {
  if (!KINDS.includes(doc.kind)) return { invalid: 'a kind this version does not know' };
  let page = '';
  try { page = new URL(typeof doc.page === 'string' && doc.page ? doc.page : `${doc.kind === 'fragment' ? 'f' : 't'}/${doc.id}/`, origin).href; } catch { page = ''; }
  if (!isWebUrl(page)) return { invalid: 'its page is not a web address' };
  if (page.length > LIMITS.pageChars) return { invalid: `its page address is longer than ${LIMITS.pageChars} characters` };
  const base = { origin, id: doc.id, kind: doc.kind, version: doc.version,
    created: cleanText(doc.created, 40), updated: cleanText(doc.updated, 40), page, content_hash: doc.content_hash,
    stub_of: null, transclusions: 0, links: 0, refs: [], ref_origins: [], title: '', excerpt: '', text: '', text_chars: 0, author: '', versions: [], words: 0, body_state: 'none' };
  if (doc.kind === 'withdrawn') return base;
  const lines = textContent(doc.content_html).split('\n').map(l => cleanText(plainText(l), 2000)).filter(Boolean);
  const title = firstHeading(doc.content_html);
  if (title && lines.length && lines[0] === title) lines.shift();
  const body = lines.join(' ');
  const refsAll = (Array.isArray(doc.transclusions) ? doc.transclusions : []).map(r => refOf(r, origin)).filter(Boolean);
  const stub = doc.stub_of && typeof doc.stub_of === 'object' ? doc.stub_of : null;
  const stubOrigin = stub ? originOf(stub.origin) : '';
  return {
    ...base, versions: versionsOf(doc), words: wordsIn(textContent(doc.content_html)), title, excerpt: cleanText(body, LIMITS.excerptChars), text: cleanText(body, LIMITS.textChars), text_chars: body.length,
    author: cleanText(doc.author && typeof doc.author === 'object' ? doc.author.name : '', 200) || blyg.author || '',
    stub_of: stubOrigin ? { origin: stubOrigin, id: ID_RE.test(String(stub.id || '')) ? stub.id : '' } : null,
    transclusions: Array.isArray(doc.transclusions) ? doc.transclusions.length : 0,
    links: Array.isArray(doc.links) ? doc.links.length : 0,
    refs: refsAll.filter(r => r.origin === origin).slice(0, LIMITS.refsKept).map(({ origin: _o, ...r }) => r),
    ref_origins: [...new Set(refsAll.map(r => r.origin))].filter(o => o.length <= LIMITS.refOriginChars).slice(0, LIMITS.refOriginsKept),
  };
}

/** A post's versions from its changelog (§5.2): version, date, note, and whether it is pinned. Every string is cleaned. */
export function versionsOf(doc) {
  const log = Array.isArray(doc.changelog) ? doc.changelog : [];
  const seen = new Set();
  const out = [];
  for (const e of log) {
    if (!e || typeof e !== 'object' || !Number.isInteger(e.version) || e.version < 1 || e.version > doc.version || seen.has(e.version)) continue;
    seen.add(e.version);
    out.push({ version: e.version, at: cleanText(e.at, 40), note: cleanText(e.note, LIMITS.noteChars), pin: e.pinned === true ? 'pinned' : 'unpinned' });
  }
  return out.sort((a, b) => a.version - b.version).slice(-LIMITS.versionsKept);
}
export const pinnedOf = rec => (rec.versions || []).filter(v => v.pin === 'pinned').map(v => v.version);
/** The address of a pinned version's page (§8.4: the post's page, then v<n>/), when it can be told from what is held: the version is pinned and the page is a directory-style address. Else ''. */
export function pinPageOf(rec, n) {
  if (!(rec.versions || []).some(v => v.version === n && v.pin === 'pinned')) return '';
  try {
    const u = new URL(rec.page);
    if (!/^https?:$/.test(u.protocol) || !u.pathname.endsWith('/')) return '';
    return new URL(`v${n}/`, u).href;
  } catch { return ''; }
}

/**
 * Is `next` barely changed from `prev` (§13.2: "a barely changed version may be queued low;
 * the threshold is reader-local")? Measured ONLY when it can be measured honestly from what
 * is stored: both versions' whole text is held (not clipped), their headings are equal, and
 * the one contiguous stretch between their common beginning and common ending is at most
 * `percent` of the longer text. Anything else is NOT barely changed. percent 0 = never.
 */
export function barelyChanged(prev, next, percent) {
  if (!(percent > 0)) return false;
  const whole = r => r.text_chars > 0 && r.text_chars <= r.text.length;
  if (!whole(prev) || !whole(next) || prev.title !== next.title) return false;
  const a = prev.text, b = next.text;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const changed = Math.max(a.length - i - j, b.length - i - j);
  return (changed * 100) / Math.max(a.length, b.length, 1) <= percent;
}
/** What a fetched version changed: one of LAST_CHANGES. `held` is the record before (or null). */
export function changeOf(held, rec, percent) {
  if (!held || isWithdrawn(held)) return 'new-words';
  if (held.content_hash === rec.content_hash) return 'maintenance';
  return barelyChanged(held, rec, percent) ? 'minor' : 'new-words';
}

// ---- a fingerprint of a post's words, kept when its text is not --------------------
// An archive record keeps no text, so "barely changed" (§13.2) could not be judged for a post the owner had read: a typo fix
// brought it back to the Feed. The record keeps instead a 64-bit SIMHASH of the post's normalised text (lower case, words
// separated by single spaces; shingles of two consecutive words; each hashed with 64-bit FNV-1a) and the text's length: about
// 30 bytes, computed from the held body at the tick, deterministic, no dependencies.
const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, MASK64 = (1n << 64n) - 1n;
function fnv64(str) {
  let h = FNV_OFFSET;
  for (const ch of String(str)) { h ^= BigInt(ch.codePointAt(0)); h = (h * FNV_PRIME) & MASK64; }
  return h;
}
const wordsOf = text => String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
/** → { fp: 16 hex digits, chars } for a text: a simhash over its two-word shingles, and the length of its normalised text. */
export function fingerprintOf(text) {
  const w = wordsOf(text);
  const shingles = w.length < 2 ? w : w.slice(1).map((x, i) => `${w[i]} ${x}`);
  const acc = new Array(64).fill(0);
  for (const sh of shingles) { const h = fnv64(sh); for (let b = 0; b < 64; b++) acc[b] += (h >> BigInt(b)) & 1n ? 1 : -1; }
  let v = 0n;
  for (let b = 0; b < 64; b++) if (acc[b] > 0) v |= 1n << BigInt(b);
  return { fp: v.toString(16).padStart(16, '0'), chars: w.join(' ').length, words: w.length };
}
/**
 * How much of a text changed, in percent, judged from two fingerprints: the larger of the change the simhashes' distance
 * estimates (d differing bits of 64: 1 - cos(pi d / 64), the cosine distance of the two shingle sets) and the change in length.
 * Compared with the same reader-local threshold the Feed uses (following_barely_changed_percent). A text too short for one word to
 * be within the threshold (fewer than 100 / percent words) is never barely changed: in six words, one is 17%.
 */
export function barelyByFingerprint(a, b, percent) {
  if (!(percent > 0) || Math.min(a.words, b.words) < Math.ceil(100 / percent)) return false;
  return fingerprintChange(a, b) < percent;
}
export function fingerprintChange(a, b) {
  let x = BigInt(`0x${a.fp}`) ^ BigInt(`0x${b.fp}`), d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  const words = (1 - Math.cos(Math.PI * d / 64)) * 100;
  const length = (Math.abs(a.chars - b.chars) * 100) / Math.max(a.chars, b.chars, 1);
  return Math.max(words, length);
}
// The GONE filter of a ledger: a Bloom filter of read ids (goneBits bits, goneHashes hashes by double hashing the two halves of
// one mixed 64-bit hash). Never a false negative; a false positive hides one post of that blyg.
// (FNV-1a alone is too regular for ids that differ in a character or two: its value is mixed by MurmurHash3's 64-bit finaliser)
const fmix64 = h => {
  h ^= h >> 33n; h = (h * 0xff51afd7ed558ccdn) & MASK64; h ^= h >> 33n; h = (h * 0xc4ceb9fe1a85ec53n) & MASK64; h ^= h >> 33n;
  return h;
};
const goneIndexes = id => {
  const h = fmix64(fnv64(id));
  const h1 = Number(h & 0xffffffffn), h2 = (Number(h >> 32n) | 1) >>> 0;
  return Array.from({ length: LIMITS.goneHashes }, (_, i) => (h1 + i * h2) % LIMITS.goneBits);
};
export function addGone(gone, ids) {
  const bits = gone ? Buffer.from(gone.bits, 'base64') : Buffer.alloc(LIMITS.goneBits / 8);
  for (const id of ids) for (const x of goneIndexes(id)) bits[x >> 3] |= 1 << (x & 7);
  return { n: (gone ? gone.n : 0) + ids.length, bits: bits.toString('base64') };
}
/** → a test (id → true if it is in the gone filter), decoding the filter once. */
export function goneTest(led) {
  if (!led.gone) return () => false;
  const bits = Buffer.from(led.gone.bits, 'base64');
  return id => goneIndexes(id).every(x => (bits[x >> 3] >> (x & 7)) & 1);
}
function joinGone(a, b) {
  if (!a || !b) return a || b || null;
  const x = Buffer.from(a.bits, 'base64'), y = Buffer.from(b.bits, 'base64');
  for (let i = 0; i < x.length; i++) x[i] |= y[i];
  return { n: Math.max(a.n, b.n), bits: x.toString('base64') };
}
const isFingerprint = v => !!v && typeof v === 'object' && /^[0-9a-f]{16}$/.test(v.fp) && Number.isInteger(v.chars) && v.chars >= 0 && Number.isInteger(v.words) && v.words >= 0;

// ---- placement: which view an entry belongs to, and why ----------------------------
// ONE function decides it, for a post and for a mention, and names the reason shown on
// the entry. An entry moves between views only because this function says so.
export const PLACEMENTS = Object.freeze(['feed', 'older', 'mentions', 'background', 'archive', 'hidden']);
export const REASONS = Object.freeze({
  waiting: 'waiting for its thread',
  notFollowed: 'not followed', older: 'stepped aside for newer posts', archived: 'ticked as read', archivedChanged: 'edited again since you read it', withdrawn: 'withdrawn', withdrawnOwn: 'withdrawn (your own)', paused: 'paused blyg',
  burst: 'part of a burst', maintenance: 'no new words', minor: 'barely changed',
  response: 'response', unknown: 'class unknown', plain: 'plain mention (lower class)',
  linked: 'linked from', reposted: 'reposted by',
});
/**
 * entry: { type: 'post', post, blyg (its record or null), burstHead (the head post of the burst this
 * post is a member of, or null), mine: [origins] } or { type: 'mention', mention }.
 * → { placement, reason }.
 */
export function placementOf(entry) {
  if (entry.type === 'mention') {
    const m = entry.mention;
    if (m.class === 'notice') return { placement: 'background', reason: REPOST_RE.test(m.action) ? REASONS.reposted : REASONS.linked };
    if (m.class === 'plain') return { placement: 'mentions', reason: REASONS.plain };
    if (m.class === 'unknown') return { placement: 'mentions', reason: REASONS.unknown };
    return { placement: 'mentions', reason: REASONS.response };
  }
  const p = entry.post;
  if (!entry.blyg) return { placement: 'hidden', reason: REASONS.notFollowed };
  if (p.read === 'older') return { placement: 'older', reason: REASONS.older };
  if (ARCHIVE_STATES.includes(p.read)) return { placement: 'archive', reason: p.read === 'archived_changed' ? REASONS.archivedChanged : REASONS.archived };
  if (isWithdrawn(p)) return { placement: 'background', reason: (entry.mine || []).includes(p.origin) ? REASONS.withdrawnOwn : REASONS.withdrawn };
  if (entry.blyg.state === 'paused') return { placement: 'background', reason: REASONS.paused };
  if (entry.burstHead) return { placement: 'background', reason: REASONS.burst };
  // a fragment fetched before the thread of its burst (by its index dates): Background while its part status is `awaiting`
  if (p.part === 'awaiting') return { placement: 'background', reason: REASONS.waiting };
  const unopened = p.read === 'new' || p.read === 'edited';
  if (!unopened && p.last_change === 'maintenance') return { placement: 'background', reason: REASONS.maintenance };
  if (!unopened && p.last_change === 'minor') return { placement: 'background', reason: REASONS.minor };
  return { placement: 'feed', reason: '' };
}

// ---- the view (pure) ----------------------------------------------------------
export const VIEWS = Object.freeze(['feed', 'mentions', 'background', 'starred', 'archive']);
export const viewOf = v => (VIEWS.includes(v) ? v : 'feed');
export const FILTERS = Object.freeze(['all', 'new', 'threads', 'fragments', 'responses']);
export const FILTER_LABELS = Object.freeze({ all: 'All', new: 'New', threads: 'Threads', fragments: 'Fragments', responses: 'Responses to me' });
export const filterOf = v => (FILTERS.includes(v) ? v : 'all');

const isResponseToMe = (it, mine) => !mine.includes(it.origin)
  && ((it.stub_of && mine.includes(it.stub_of.origin)) || (it.ref_origins || []).some(o => mine.includes(o)));
// A post's time for ordering and display: what it says, but never later than when this
// companion fetched that version (§13.7: a future-dated post cannot sit on top).
const stamp = (iso, at) => { const t = Date.parse(iso); const f = Number.isFinite(at) ? at : Infinity; return Number.isFinite(t) ? Math.min(t, f) : (f === Infinity ? 0 : f); };
export const sortTime = it => Math.max(stamp(it.updated, it.fetched_at), stamp(it.created, it.fetched_at));

// The times at which each thread of a list was published (its created and updated), sorted: for finding a burst's thread.
export function threadMarks(threads) {
  const marks = [];
  for (const t of threads) for (const v of new Set([t.created, t.updated])) { const x = Date.parse(v); if (Number.isFinite(x)) marks.push([x, t]); }
  return marks.sort((a, b) => a[0] - b[0]);
}
/** The threads (from threadMarks) published within burstMs of time `c`, nearest first; [] when `c` is not a date. */
export function nearThreads(marks, c) {
  if (!Number.isFinite(c) || !marks.length) return [];
  let lo = 0, hi = marks.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (marks[mid][0] < c - LIMITS.burstMs) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < marks.length && marks[i][0] <= c + LIMITS.burstMs; i++) out.push(marks[i]);
  return [...new Map(out.sort((a, b) => Math.abs(a[0] - c) - Math.abs(b[0] - c)).map(([, t]) => [t.id, t])).values()];
}
/**
 * A fetch order (newest first) in which every thread comes before any fragment of the list created within burstMs of the
 * thread's created or updated (§13.7, finding 4a): so a burst's parts are never fetched, and shown, before their thread.
 */
export function burstOrder(list) {
  const marks = threadMarks(list.filter(e => e.kind === 'thread'));
  if (!marks.length) return list;
  const out = [], placed = new Set();
  for (const e of list) {
    if (placed.has(e.id)) continue;
    if (e.kind === 'fragment') for (const t of nearThreads(marks, Date.parse(e.created))) if (!placed.has(t.id)) { out.push(t); placed.add(t.id); }
    out.push(e); placed.add(e.id);
  }
  return out;
}

/**
 * Burst folding (§13.7), display only. A thread and the posts of the SAME blyg its
 * transclusions name, whose `created` is within burstMs of the thread's created or
 * updated (the publish that first named them), are one burst under the thread. A post is
 * in at most one burst. Nothing is left out. → [{ head, members }].
 */
export function foldBursts(items) {
  const byIdent = new Map(items.map(i => [identOf(i.origin, i.id), i]));
  const claimed = new Set();
  const heads = new Map(items.map(i => [identOf(i.origin, i.id), { head: i, members: [] }]));
  const threads = items.filter(i => i.kind === 'thread').sort((a, b) => (Date.parse(a.created) || 0) - (Date.parse(b.created) || 0));
  for (const t of threads) {
    const near = [Date.parse(t.created), Date.parse(t.updated)].filter(Number.isFinite);
    for (const r of t.refs || []) {
      const ro = r.origin || t.origin; // (a reference to the thread's own blyg keeps no origin; one of an older record does)
      if (ro !== t.origin) continue;
      const k = identOf(ro, r.id);
      const m = byIdent.get(k);
      if (!m || k === identOf(t.origin, t.id) || m.kind === 'thread' || claimed.has(k)) continue;
      const c = Date.parse(m.created);
      if (!Number.isFinite(c) || !near.some(n => Math.abs(n - c) <= LIMITS.burstMs)) continue;
      // §13.7, "a fold covers the versions published in the burst, not the item": folded only while its words are those of the
      // version the thread named (a later maintenance version keeps them), or while its `updated` lies within the burst itself.
      // A part edited later is its own arrival (an ordinary update; for a post already read, the edit rule).
      const wordsAt = Number.isInteger(m.words_version) ? m.words_version : m.version;
      const named = Number.isInteger(r.version) && wordsAt <= r.version;
      const u = Date.parse(m.updated);
      if (!named && !(Number.isFinite(u) && near.some(n => Math.abs(n - u) <= LIMITS.burstMs))) continue;
      claimed.add(k);
      heads.get(identOf(t.origin, t.id)).members.push(m);
    }
  }
  return [...heads.values()].filter(h => !claimed.has(identOf(h.head.origin, h.head.id)));
}

/**
 * Everything the console shows, from what is held. Pure. → {
 *   feed: { entries: [{ head, members }], counts, filter }, background: [{ type, post|mention, reason }],
 *   mentions: [mention + reason], archive: [post], older: [post], tabs: { feed (the unread count), mentions, mentions_unseen, background, archive } }
 * (The counts are for the engine: the limits, the target, a top-up. The page shows none of them but Mentions' unseen.)
 */
export function buildView({ items, blygs, mentions = [], mine = [], filter = 'all', now = Date.now() }) {
  const posts = items.filter(i => blygs[i.origin]);
  // an archived (or older) post is never folded into (or under) a burst: it is listed on its own
  const live = posts.filter(i => !isWithdrawn(i) && !TEXTLESS_STATES.includes(i.read));
  // A burst folds its members only under a head that is itself in the Feed. A head that goes elsewhere (a barely
  // changed thread you have read) must not take an unread post with it: each member then stands on its own.
  const alone = p => placementOf({ type: 'post', post: p, blyg: blygs[p.origin] || null, mine, burstHead: null });
  const folded = foldBursts(live).flatMap(e => (alone(e.head).placement === 'feed' ? [e]
    : [{ head: e.head, members: [] }, ...e.members.map(m => ({ head: m, members: [] }))]));
  const memberOf = new Map(); // ident → head
  for (const e of folded) for (const m of e.members) memberOf.set(identOf(m.origin, m.id), e.head);
  const place = p => placementOf({ type: 'post', post: p, blyg: blygs[p.origin] || null, mine,
    burstHead: memberOf.get(identOf(p.origin, p.id)) || null });
  const placed = new Map(posts.map(p => [p, place(p)]));
  const at = view => posts.filter(p => placed.get(p).placement === view);
  // the feed: heads (bursts folded) placed in the feed, with their members counted
  const feedHeads = folded.filter(e => placed.get(e.head) && placed.get(e.head).placement === 'feed');
  // the flat filters list every post of that sort that the feed or a burst holds
  const flat = posts.filter(p => ['feed'].includes(placed.get(p).placement) || placed.get(p).reason === REASONS.burst);
  const pick = {
    all: () => feedHeads,
    new: () => feedHeads.filter(e => ['new', 'edited'].includes(e.head.read) || e.members.some(m => ['new', 'edited'].includes(m.read))),
    threads: () => flat.filter(i => i.kind === 'thread').map(head => ({ head, members: [] })),
    fragments: () => flat.filter(i => i.kind === 'fragment').map(head => ({ head, members: [] })),
    responses: () => flat.filter(i => isResponseToMe(i, mine)).map(head => ({ head, members: [] })),
  };
  const counts = {};
  for (const f of FILTERS) counts[f] = pick[f]().length;
  const entries = pick[filterOf(filter)]().map(e => ({ head: e.head, members: [...e.members].sort((a, b) => sortTime(b) - sortTime(a)) }))
    .sort((a, b) => Math.max(sortTime(b.head), ...b.members.map(sortTime)) - Math.max(sortTime(a.head), ...a.members.map(sortTime)));
  const withReason = mentions.map(m => ({ ...m, ...placementOf({ type: 'mention', mention: m }) }));
  const background = [
    ...at('background').map(p => ({ type: 'post', post: p, reason: placed.get(p).reason, burst_head: memberOf.get(identOf(p.origin, p.id)) || null })),
    ...withReason.filter(m => m.placement === 'background').map(m => ({ type: 'mention', mention: m, reason: m.reason })),
  ].sort((a, b) => (b.post ? sortTime(b.post) : Date.parse(b.mention.at) || 0) - (a.post ? sortTime(a.post) : Date.parse(a.mention.at) || 0));
  const inMentions = withReason.filter(m => m.placement === 'mentions').sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  // the Archive: newest ticked first
  const archive = at('archive').sort((a, b) => (Date.parse(b.archived_at) || 0) - (Date.parse(a.archived_at) || 0) || (a.key < b.key ? -1 : 1));
  // the posts stepped aside ("Older posts", after the Feed's own): newest first
  const older = at('older').sort((a, b) => sortTime(b) - sortTime(a) || (a.key < b.key ? -1 : 1));
  return { feed: { entries, counts, filter: filterOf(filter) }, background, mentions: inMentions, archive, older,
    tabs: { feed: counts.all, mentions: inMentions.length, mentions_unseen: inMentions.filter(m => m.read === 'unseen').length, background: background.length, archive: archive.length } };
}

// ---- budget, breaker, getter -----------------------------------------------------
function newBudget(settings, now) {
  const start = now();
  return { requests: 0, cap: settings.following_run_requests, deadline: start + settings.following_run_seconds * 1000, now,
    left() { return this.deadline - this.now(); },
    spent() { return this.requests >= this.cap || this.left() <= 0; },
    take() {
      if (this.requests >= this.cap) throw new FetchTrouble('limit', `this run's ${this.cap} requests are spent`);
      if (this.left() <= 0) throw new FetchTrouble('limit', 'this run\'s time is spent');
      this.requests++;
    } };
}

// ---- the storage seam -------------------------------------------------------------------
// EVERYTHING the engine keeps goes through ONE asynchronous store with a real compare-and-swap (following-store.mjs says what
// is kept, by kind, and the interface). A host that keeps it elsewhere supplies its own store and this file does not change.
//
// THE TRANSACTION. Every operation of the engine (the owner's moves, a refresh's apply, a view) is ONE call of `tx`:
//   1. read the documents it needs: the main document and the run document always; the feeds, archives and ledgers of the
//      blygs it touches, and bodies by name. What it needs is declared, or found out as it goes: an operation that reaches a
//      document not read yet throws NeedMore (need()), the document is read, and the operation is run again from the start.
//   2. run the operation as a PURE, synchronous mutation of copies of what was read (the code below, unchanged in spirit:
//      load() is the copy);
//   3. commit: each document whose content changed is written with the version that was read (ifVersion), in a fixed order
//      that leaves a legal state after any prefix of the writes (a crash between two writes; see COMMIT ORDER), and the
//      bodies it no longer needs are deleted after the last write.
//   4. on a StoreConflict (another invocation wrote one of them meanwhile, or a read met a conversion in progress) the
//      documents are read again and the operation is RE-RUN on what is stored now (bounded: LIMITS.txAttempts, then a plain
//      "try again"; RERUN_MODES names how an attempt runs). So an owner's move is never merged away: it is applied again on the
//      fresh state, and refused there only if the table of its state machine refuses it. Each written document carries the
//      ids of the last operations that wrote it (`ops`): a re-run does not write again a document whose LAST FINAL writer is
//      its own earlier attempt (so nothing is applied twice); one written since by another is written again with the change
//      re-applied on it. The first half of an archive written in two (additions, then removals: COMMIT ORDER 2 and 4) is
//      stamped `<op>:add`, never the op itself: it is not a final write, so a re-run always writes the second half.
// A refresh does its network work OUTSIDE any transaction (it reads a snapshot, fetches, writes bodies) and then applies what
// it fetched in a short transaction per blyg, re-checking each post's record against the snapshot: a conflict costs a
// re-apply, never a re-fetch. What it learned about each blyg's record (last tried, failures, title) is put in the main
// document every LIMITS.mainEvery blygs and at its end, re-applied on the main document as stored then.
//
// COMMIT ORDER (and the repairs a reader makes, so that every prefix is a legal state):
//   1. ledgers                (a read id is removed only here, before the archive record goes: a crash leaves the record,
//                              and R3 below puts the id back: the untick did not happen)
//   2. archives, additions    (the archive with what is added and nothing removed yet)
//   3. feeds
//   4. archives, removals     (a post leaves the Archive only after the feed holds it again)
//   5. stars, inbox, main document, run document; then ledgers whose only change is read ids ADDED (a crash before: R3)
//   6. documents deleted (an unfollowed blyg's feed and archive; a forgotten blyg's ledger), each only if it is still the
//      version this transaction read (a refollow's documents written meanwhile are never deleted); then bodies deleted.
// THE REPAIRS, made by whoever reads both documents (and written only by an operation that writes anyway; a view shows them):
//   R1 a post found unread in its blyg's feed and also in its archive (a crash between 2 and 3, or 3 and 4; or another
//      invocation's move between its writes): the feed's copy wins, the archive's copy goes. A tick stopped before its feed
//      write is not done (the post is unread, as the owner last saw it); an untick or an edit-return stopped after its feed
//      write is done.
//   R2 a post in the feed whose state is archived (a document of the older layout) moves to the archive.
//   R3 every archive record's id is in its blyg's ledger (added when both are read; a tick writes its ledger last).
// WHY A REPAIR NEEDS NO CLOCK. A repair cannot tell a move another invocation is making right now (between two of its writes)
// from one whose invocation died there: the store holds the same thing. So it does not try: an operation whose commit carries
// a repair ALSO writes, conditionally, every document of that blyg it read (its feed, archive and ledger, rewritten as read
// if nothing else changed them). A move in flight writes at least one of them after the repair (see the order above), and that
// write then meets a changed version: the move is RE-RUN on the repaired state and applied again whole (a tick ticks again; an
// untick whose feed write landed is finished). And the repair itself was worked out from documents whose versions its
// commit checks: one changed since it was read (another invocation's whole untick between two of this one's reads) makes the
// repair re-run on what is stored then, never writes a ledger worked out from a stale archive. The same holds for every other
// place that writes one document from what another said (all of them, each with the documents it writes as well):
//   R1, R2  the archive (and feed) from the feed                      → the blyg's feed, archive and ledger are written
//   R3      the ledger from the archive                               → the blyg's feed (if read), archive and ledger
//   trimArchive  the archive from the stars (a starred record stays)  → the stars document is written too
//   summaryOf    a feed's summary from its ledger and archive (counts) → not checked: a count only; the next write corrects it
// A document of a blyg whose EPOCH (a random id given when it is followed, kept while it is kept) is not the blyg's is read as
// absent: what a slow invocation wrote for a blyg unfollowed meanwhile is never taken for the blyg followed again.
//
// TIMED RULES: every place a clock decides something, its bound, and whether a clock that is wrong can cost more than work.
//   the run lease's `until`          a holder that died blocks refreshes this long. A clock running ahead lapses a live lease
//                                    early: two refreshes overlap, which costs requests only (every apply is a transaction)
//   the top-up gap (topup_after)     at most one top-up every topupGapMs: cost only, same reason
//   the sweep (bodySweepAgeMs, 1 h)  a body or blyg document nothing names may be another invocation's not committed yet. It is
//                                    deleted only when found unnamed by TWO sweeps (a count: SWEEP_MARKS) and when its
//                                    written-at is an hour old: a wrong clock alone cannot delete a body in use; it takes
//                                    that AND a whole refresh starting and ending inside one commit of another invocation
//   the quiet period (24 h)          the conversion's copy is kept this long after it is done (MIGRATION_STATES): an older
//                                    invocation lives seconds; a clock wrong by hours ends the copy early, nothing else
//   the edit rule, back-offs, bursts dates the Hub stored itself, compared with now: a wrong clock moves a post's return or a
//                                    retry by that much; nothing is lost
// (The repairs used to wait 10 minutes before removing an archive copy: a clock running 10 minutes ahead could then remove
// a tick's record in flight. They need no clock now: see WHY A REPAIR NEEDS NO CLOCK.)
//
// THE CONVERSION (MIGRATION_STATES). A store of an older layout is converted on first read. On the hosted Hub the older
// document is in 'legacy' and the older bodies in 'oldbody', and DURING A DEPLOY an invocation of the older code may still run
// against them; on the companion the older document is the main document itself and its bodies are where they stay.
//   1. (hosted) 'legacy' is replaced, conditionally on the version read, by a MARKER: the older engine cannot load it, so an
//      old page view, "Refresh now", follow or sweep fails with an error and writes nothing; and it keeps the old document's
//      posts, so an old sweep that read it before its refresh finished still finds every old body named and deletes none. The
//      marker carries the old document (its copy). An old write that got in first makes this write fail: converted again.
//   2. this layout's main document is written, `converting`, carrying the copy: conditionally (nothing stored, or the older
//      document's version on the companion). From here every reader finishes the conversion first.
//   3. each followed blyg's ledger, archive and feed, the inbox, and each unread post's text (copied from 'oldbody'; the
//      older one is left where it is). A document already there is KEPT as it is (written by an earlier attempt, or since);
//      so is the epoch it carries. A ledger of another epoch is converted with its read ids, and a post read there (its id
//      in that ledger or its gone filter) is not put in the feed unless its record says a real edit brought it back.
//   4. the copy goes to 'pre-shard'; the main document moves to `keeping_copy` (copy_until = now + the quiet period).
//   5. every sweep while `keeping_copy` copies into 'body' any text an unread post names that only 'oldbody' has (a post the
//      older code saved during the deploy); the first after copy_until with none missing deletes 'pre-shard' and every
//      'oldbody', empties the marker (MARKER_STATES) and moves to `done`. Nothing of the older layout is deleted before that.
// A conflict anywhere is retried like any other (step 4 of the transaction), and a crash anywhere is finished by the next
// reader: no step can leave a state that throws for ever. A conversion that finds this layout's documents already there
// (a companion whose older code wrote its document back after a conversion) merges: the blygs the older document follows are
// followed, each with the documents already there (its unread posts, archive and ledger stand; the older document's posts of
// that blyg are not taken: the next refresh fetches what is new); a blyg it does not follow any more but that has a ledger is
// KEPT (its read ids stay, as after an unfollow without forget); a blyg it follows that has no documents is converted from its
// posts. An older invocation's follow or unfollow is therefore never lost silently: before step 1 it is in the document
// converted; after it, the older code refuses it with an error (and writes nothing), and the owner does it again.
export { STORE_KINDS, StoreConflict, ledgerName, fileStore, memoryStore };
class NeedMore extends Error { constructor(wants) { super('the operation needs documents it has not read'); this.wants = wants; } }
// The layout of what is kept. 1 (no number): one main document holding every post. 2: per-blyg documents (the companion only,
// before the conversion was named). 3: the main document carries `migration`; on the hosted Hub the main document and the
// bodies are kept apart from where the older code keeps its own. 4: this one, the same documents as 3, whose feeds may hold
// `older` records (READ_STATES) and whose ledgers a `holding` (HOLD_STATES). An engine of layout 3 would read an `older` record
// as a NEW post with no text and write it back so: the number goes up so that it refuses to write instead. A store of layout
// 3 is moved to 4 by one conditional write of its main document (nothing else changes: an older record appears only after),
// on the first read (readMain); a store of layout 2 straight to 4. A store of a HIGHER layout was written by a newer engine:
// this one refuses to write to it (HubNewer), so an older invocation during a deploy can never corrupt it.
export const LAYOUT = 4;
export class HubNewer extends Error {
  constructor() { super('the Hub is being updated; try again in a minute'); this.name = 'HubNewer'; this.code = 'EHUBNEWER'; }
}
/** The older document a host keeps apart ('legacy'), once converted: a marker the older engine cannot load (a blyg record that is
 * not an object stops it at once, before it writes anything), still naming every post of the old document (an older sweep that
 * reads it keeps every older body), and carrying the rest of the old document (the copy). */
const MARKER = 'moved';
const isMarker = v => !!v && typeof v === 'object' && v.layout === MARKER;
// The marker's own state: ONE field, `marker`, moved only by moveMarker (a marker that does not say is `emptied`: never read as a copy).
//   carrying_copy  — it carries the old document (its copy) and names every old post: until the conversion's quiet period is over
//   emptied        — the copy and the old posts are gone from it (it still stops the older engine)
//   empty          carrying_copy → emptied   (by the sweep that ends the quiet period)
export const MARKER_STATES = Object.freeze(['carrying_copy', 'emptied']);
export const MARKER_MOVES = Object.freeze({ empty: { carrying_copy: 'emptied' } });
const markerMachine = machine('marker', MARKER_STATES, MARKER_MOVES);
export function moveMarker(m, ev) { m.marker = markerMachine.to(m.marker, ev); return m.marker; }
const markerStateOf = m => (MARKER_STATES.includes(m.marker) ? m.marker : 'emptied');
const markerOf = (doc, tag) => ({ layout: MARKER, marker: 'carrying_copy', note: 'converted to a newer layout of the Hub: this document is no longer read',
  from: tag, blygs: { [MARKER]: null }, items: doc.items && typeof doc.items === 'object' ? doc.items : {},
  doc: Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'items')) });
/** The marker, emptied: no copy, no old post (moveMarker refuses one that is emptied already). */
const emptiedMarker = m => { const { doc, items, ...rest } = m; void doc; void items; const out = { ...rest, items: {} }; moveMarker(out, 'empty'); return out; };
const copyOfMarker = m => ({ ...(m.doc && typeof m.doc === 'object' ? m.doc : {}), items: m.items && typeof m.items === 'object' ? m.items : {} });
const migrationOf = v => {
  const m = v && v.migration && typeof v.migration === 'object' ? v.migration : null;
  if (!v || (Number.isInteger(v.layout) ? v.layout : 1) < LAYOUT) return { state: 'not_started' };
  if (!m || !MIGRATION_STATES.includes(m.state) || m.state === 'not_started') return { state: 'done' };
  return m;
};
const sortKeys = v => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  return v;
};
const canon = v => (v === null || v === undefined ? '' : JSON.stringify(sortKeys(v)));
const BOOK = ['ops', 'migrated_from'];
const content = v => { if (!v || typeof v !== 'object') return v; const o = { ...v }; for (const k of BOOK) delete o[k]; return o; };
const docKey = (kind, name) => `${kind}/${name}`;
async function pool(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } }));
  return out;
}

// ---- the engine -----------------------------------------------------------------------
export function createFollowing({ file, store = fileStore(file), get = netGet, now = Date.now, getSettings = () => followingSettingsOf({}).settings,
  mayFetch = () => true, readToken = readTokenFile, tokenWarning = tokenFileWarning, tokenForbidden = [],
  timers = { set: (fn, ms) => setInterval(fn, ms), clear: h => clearInterval(h) }, onChange = () => {}, ceilings = {} } = {}) {
  let state = null; // the copy the operation running now works on: { blygs, kept, items (the posts of the feeds and archives read), last_run, inbox, stars }
  let S = null;     // what the operation running now has read: { docs, feeds, archives, prevSummary, bodies, run, deletes, bodiesToDelete }
  const ledgers = new Map(); // origin → the ledger read by the operation running now (a copy)
  let opCtx = null; // a refresh's or top-up's numbers about blygs it has not read (unread held, unusable documents), from the feeds' summaries
  const emptyInbox = () => ({ state: 'off', fetched_at: 0, generated_at: '', count: 0, error: '', never_verified: [], never_verified_count: 0, blocked_count: 0, mentions: [] });
  const need = wants => { throw new NeedMore(wants); };
  const load = () => { if (!state) throw new Error('following: the state was read outside an operation'); return state; };
  const newEpoch = () => crypto.randomBytes(8).toString('hex');
  const epochOf = origin => (state.blygs[origin] ? state.blygs[origin].epoch : state.kept[origin] ? state.kept[origin].epoch : '');
  // A post's key carries the first 8 hex of its blyg's document name, so a move that names a key reads that blyg only.
  const randomKey = origin => `${origin ? ledgerName(origin).slice(0, 8) : crypto.randomBytes(4).toString('hex')}${crypto.randomBytes(8).toString('hex')}`;
  const newBodyName = key => `${key}${crypto.randomBytes(4).toString('hex')}`;
  const bodyNameOf = rec => (typeof rec.body === 'string' && /^[0-9a-f]{8,64}$/.test(rec.body) ? rec.body : rec.key);

  // ---- reading what an operation needs ----
  function specOf(w = {}) {
    return { feeds: new Set(w.feeds || []), archives: new Set(w.archives || []), ledgers: new Set(w.ledgers || []), bodies: new Set(w.bodies || []),
      allFeeds: !!w.allFeeds, allArchives: !!w.allArchives, allLedgers: !!w.allLedgers, inbox: !!w.inbox, stars: !!w.stars };
  }
  function addWants(spec, w) {
    for (const k of ['feeds', 'archives', 'ledgers', 'bodies']) for (const x of w[k] || []) spec[k].add(x);
    for (const k of ['allFeeds', 'allArchives', 'allLedgers', 'inbox', 'stars']) if (w[k]) spec[k] = true;
  }
  async function getDoc(kind, name) {
    const g = await store.get(kind, name);
    if (!g) return { value: null, version: null, at: 0 };
    if (g.unreadable) { warnUnreadable(kind === 'state' && name === 'following' ? (file || 'the Hub state') : `the Hub's ${kind} ${name}`, g.unreadable); return { value: null, version: g.version, at: g.at || 0, unreadable: true }; }
    return { value: g.value, version: g.version, at: g.at || 0 };
  }
  const mainRaw = docs => { const d = docs.get('state/following'); return d && d.value && typeof d.value === 'object' && !Array.isArray(d.value) ? d.value : null; };
  const layoutOf = v => (Number.isInteger(v.layout) ? v.layout : 1);
  /**
   * The main document, of this layout: converting (or finishing a conversion of) an older one first. A conversion's write that
   * meets another's throws StoreConflict, and the transaction runs again (as for any conflict): nothing here throws for ever.
   */
  async function readMain(docs) {
    for (let round = 0; !docs.has('state/following'); round++) {
      if (round >= 6) throw new StoreConflict('state', 'following');
      const main = await getDoc('state', 'following');
      const m = main.value && typeof main.value === 'object' && !Array.isArray(main.value) ? main.value : null;
      if (main.unreadable || (m && layoutOf(m) > LAYOUT)) { docs.set('state/following', { ...main, newer: !main.unreadable }); break; }
      if (m && layoutOf(m) === LAYOUT) {
        if (migrationOf(m).state === 'converting') { await finishConversion(main); continue; }
        docs.set('state/following', main); break;
      }
      if (m && layoutOf(m) === 2) {
        // the companion's per-blyg layout before the conversion was named: the same documents; it says so now
        const mig = { state: 'not_started' }; moveMigration(mig, 'fresh');
        await store.put('state', 'following', { ...content(m), layout: LAYOUT, migration: mig }, { ifVersion: main.version });
        continue;
      }
      if (m && layoutOf(m) === 3) {
        // layout 3: the same documents (see LAYOUT); its conversion, whatever its state, goes on as it was (the `migration` kept)
        await store.put('state', 'following', { ...content(m), layout: LAYOUT }, { ifVersion: main.version });
        continue;
      }
      if (m) { await beginConversion({ doc: m, tag: String(main.version), ifMain: main.version }); continue; }
      // nothing of this layout: the older document where a host keeps it apart, or a new Hub
      const leg = await getDoc('state', 'legacy');
      const l = leg.value && typeof leg.value === 'object' && !Array.isArray(leg.value) ? leg.value : null;
      if (l && isMarker(l)) {
        // converted to a main document that is not there: a conversion that stopped between its steps 1 and 2 (its copy is in
        // the marker), or a main document deleted by hand after it (then nothing is written: the operator restores it)
        if (markerStateOf(l) !== 'carrying_copy') throw new Error('the Hub\'s main document is missing (its older document was converted): restore it from its copy');
        await beginConversion({ doc: copyOfMarker(l), tag: String(l.from), ifMain: null });
        continue;
      }
      if (l) {
        // step 1: the marker, conditionally on the version read (an older invocation's write that got in first: converted again)
        await store.put('state', 'legacy', markerOf(l, String(leg.version)), { ifVersion: leg.version });
        await beginConversion({ doc: l, tag: String(leg.version), ifMain: null });
        continue;
      }
      docs.set('state/following', main); // nothing stored: a new Hub
    }
  }
  async function readDocs(spec, docs) {
    await readMain(docs);
    const main = mainRaw(docs) || {};
    const followed = Object.keys(main.blygs && typeof main.blygs === 'object' ? main.blygs : {});
    const kept = Object.keys(main.kept && typeof main.kept === 'object' ? main.kept : {});
    const want = [['state', 'run']];
    if (spec.inbox) want.push(['state', 'inbox']);
    if (spec.stars) want.push(['state', 'stars']);
    for (const o of spec.allFeeds ? followed : spec.feeds) want.push(['feed', ledgerName(o)]);
    for (const o of spec.allArchives ? followed : spec.archives) want.push(['archive', ledgerName(o)]);
    for (const o of spec.allLedgers ? [...followed, ...kept] : spec.ledgers) want.push(['ledger', ledgerName(o)]);
    for (const n of spec.bodies) want.push(['body', n]);
    const todo = want.filter(([k, n]) => !docs.has(docKey(k, n)));
    await pool(todo, 16, async ([k, n]) => {
      if (k !== 'body') { docs.set(docKey(k, n), await getDoc(k, n)); return; }
      const g = await store.get('body', n);
      docs.set(docKey(k, n), { value: g && typeof g.value === 'string' ? g.value : '', version: g ? g.version : null, at: g ? g.at || 0 : 0 });
    });
  }
  const cleanRecord = (i, origin) => {
    i.origin = origin;
    if (typeof i.page !== 'string' && i.kind !== 'withdrawn') i.page = defaultPage(origin, i.kind, i.id);
    if (i.read === 'seen' || !READ_STATES.includes(i.read)) i.read = 'new'; // a document from before the Archive: `seen` posts stay in the Feed
    // the `edited_after_read` marker beside `read` (this branch's first version) is the read state `edited` now
    if ('edited_after_read' in i) {
      if (i.read === 'new' && Number.isInteger(i.edited_after_read)) { i.read = 'edited'; i.read_version = i.edited_after_read; i.returned_at = Date.parse(i.first_seen) || i.fetched_at || 0; }
      delete i.edited_after_read;
    }
    // (an archive record, or an older one, keeps neither: they are of the text, which it does not hold)
    if (!TEXTLESS_STATES.includes(i.read) && !IDENTITY_STATES.includes(i.identity)) i.identity = 'unverified';
    if (!TEXTLESS_STATES.includes(i.read) && !LAST_CHANGES.includes(i.last_change)) i.last_change = 'new-words';
    if (typeof i.key !== 'string' || !/^[0-9a-f]{8,64}$/.test(i.key)) i.key = keyFor0(origin, i.id);
    if (i.awaits && !('part' in i)) { i.part = 'awaiting'; i.awaits_until = (Date.parse(i.first_seen) || 0) + LIMITS.burstWaitMs; }
    if ('part' in i && !PART_STATES.includes(i.part)) i.part = 'standalone';
    if (i.read !== 'archived_changed') delete i.newer;
    else if (!i.newer || !Number.isInteger(i.newer.version) || typeof i.newer.hash !== 'string') { delete i.newer; moveRead(i, 'revert'); }
    return i;
  };
  // a key made for a record that had none: the same for every invocation that converts the same record (migration is repeatable)
  const keyFor0 = (origin, id) => `${ledgerName(origin).slice(0, 8)}${crypto.createHash('sha256').update(`key\n${origin}\n${id}`).digest('hex').slice(0, 16)}`;
  const cleanRun = raw => {
    const r = raw && typeof raw === 'object' ? raw : {};
    const l = r.lease && typeof r.lease === 'object' ? r.lease : {};
    const lease = { state: RUN_STATES.includes(l.state) ? l.state : 'idle', holder: typeof l.holder === 'string' ? l.holder : '', until: Number.isFinite(l.until) ? l.until : 0 };
    const breakers = {};
    for (const [h, b] of Object.entries(r.breakers && typeof r.breakers === 'object' ? r.breakers : {}).slice(0, LIMITS.breakersKept)) {
      if (b && BREAKER_STATES.includes(b.state)) breakers[h] = { state: b.state, failures: Number.isInteger(b.failures) ? b.failures : 0, until: Number.isFinite(b.until) ? b.until : 0 };
    }
    const sw = r.sweep && typeof r.sweep === 'object' ? r.sweep : {};
    const marks = {};
    for (const [k, m] of Object.entries(sw.marks && typeof sw.marks === 'object' ? sw.marks : {}).slice(0, LIMITS.sweepMarksKept)) {
      if (/^(body|feed|archive|ledger)\/[0-9a-f]{8,64}$/.test(k) && m && m.state === 'marked' && Number.isInteger(m.seq)) marks[k] = { state: 'marked', seq: m.seq };
    }
    return { lease, topup_after: Number.isFinite(r.topup_after) ? r.topup_after : 0, breakers, sweep: { seq: Number.isInteger(sw.seq) && sw.seq >= 0 ? sw.seq : 0, marks } };
  };
  const cleanStars = raw => {
    const out = {};
    for (const [k, e] of Object.entries(raw && raw.stars && typeof raw.stars === 'object' ? raw.stars : {})) {
      if (!e || typeof e !== 'object' || originOf(e.origin) !== e.origin || !ID_RE.test(String(e.id || '')) || k !== identOf(e.origin, e.id)) continue;
      if (e.star !== 'starred') continue; // a plain star is not kept
      out[k] = e;
      if (Object.keys(out).length >= LIMITS.starsMax) break;
    }
    return out;
  };
  /** Build the operation's copy from what was read (each attempt starts again from the stored documents). */
  function build(spec, docs) {
    const v = structuredClone(mainRaw(docs) || {});
    const blygs = {};
    for (const [o, b] of Object.entries(v.blygs && typeof v.blygs === 'object' ? v.blygs : {})) {
      if (originOf(o) !== o || !b || typeof b !== 'object') continue;
      // a hand-edited record never makes the engine fetch something the reader paused
      if (!BLYG_STATES.includes(b.state)) b.state = 'paused';
      blygs[o] = b;
    }
    const kept = {};
    for (const [o, k] of Object.entries(v.kept && typeof v.kept === 'object' ? v.kept : {})) {
      if (originOf(o) === o && k && Number.isFinite(k.at) && typeof k.epoch === 'string' && !blygs[o]) kept[o] = { at: k.at, epoch: k.epoch };
    }
    state = { blygs, kept, items: {}, last_run: v.last_run || null, inbox: null, stars: null, migration: structuredClone(migrationOf(mainRaw(docs))) };
    // touch: documents an operation that writes must write even if unchanged (conditionally), because a repair was worked out
    // from them (see WHY A REPAIR NEEDS NO CLOCK)
    S = { docs, spec, feeds: new Set(), archives: new Set(), prevSummary: new Map(), bodies: new Map(), deletes: [], bodiesToDelete: [], touch: new Set(),
      run: cleanRun(docs.get('state/run') && docs.get('state/run').value) };
    const r2 = new Set(); // R2: blygs whose feed holds a record in the Archive's state (moved out when the archive is read too)
    const touchBlyg = o => { for (const kind of ['feed', 'archive', 'ledger']) if (docs.has(docKey(kind, ledgerName(o)))) S.touch.add(docKey(kind, ledgerName(o))); };
    const doc = (kind, o) => { const d = docs.get(docKey(kind, ledgerName(o))); const val = d && d.value && typeof d.value === 'object' && d.value.origin === o ? d.value : null; return val && val.epoch === epochOf(o) ? structuredClone(val) : null; };
    if (spec.inbox) {
      const d = docs.get('state/inbox');
      state.inbox = { ...emptyInbox(), ...(d && d.value && typeof d.value === 'object' ? structuredClone(content(d.value)) : {}) };
      if (!INBOX_STATES.includes(state.inbox.state)) state.inbox.state = 'off';
      if (!Array.isArray(state.inbox.mentions)) state.inbox.mentions = [];
      for (const m of state.inbox.mentions) { if (!MENTION_READ.includes(m.read)) m.read = 'seen'; if (!m.key) m.key = randomKey(''); }
    }
    if (spec.stars) state.stars = cleanStars(docs.get('state/stars') && docs.get('state/stars').value);
    ledgers.clear();
    for (const o of spec.allLedgers ? [...Object.keys(blygs), ...Object.keys(kept)] : spec.ledgers) {
      if (!blygs[o] && !kept[o]) continue;
      const raw = doc('ledger', o);
      ledgers.set(o, cleanLedger(raw));
    }
    for (const o of spec.allFeeds ? Object.keys(blygs) : spec.feeds) {
      if (!blygs[o]) continue;
      S.feeds.add(o);
      const raw = doc('feed', o);
      S.prevSummary.set(o, raw && raw.summary && typeof raw.summary === 'object' ? raw.summary : {});
      for (const i of Object.values(raw && raw.items && typeof raw.items === 'object' ? raw.items : {})) {
        if (!i || typeof i !== 'object' || !ID_RE.test(String(i.id || ''))) continue;
        const rec = cleanRecord(i, o);
        state.items[identOf(o, i.id)] = rec;
        if (ARCHIVE_STATES.includes(rec.read)) r2.add(o);
      }
    }
    for (const o of spec.allArchives ? Object.keys(blygs) : spec.archives) {
      if (!blygs[o]) continue;
      S.archives.add(o);
      const raw = doc('archive', o);
      for (const i of Object.values(raw && raw.items && typeof raw.items === 'object' ? raw.items : {})) {
        if (!i || typeof i !== 'object' || !ID_RE.test(String(i.id || ''))) continue;
        const ident = identOf(o, i.id);
        const inFeed = state.items[ident];
        if (inFeed && S.feeds.has(o) && !ARCHIVE_STATES.includes(inFeed.read)) {
          // R1: the feed's copy is the later one; the archive's copy goes. Whatever move of another invocation this half-made
          // state belongs to is made to run again by the touch (no clock: see WHY A REPAIR NEEDS NO CLOCK)
          touchBlyg(o);
          continue;
        }
        const rec = cleanRecord(i, o);
        if (!ARCHIVE_STATES.includes(rec.read)) rec.read = 'archived'; // a record in the archive is in the Archive
        state.items[ident] = rec;
      }
    }
    for (const o of r2) if (S.archives.has(o)) touchBlyg(o);
    // R3: every archive record's id is in its blyg's ledger (when both were read)
    for (const [o, led] of ledgers) {
      if (!S.archives.has(o)) continue;
      const have = new Set(led.ids.map(p => p[0]));
      for (const i of itemsOf(o)) if (ARCHIVE_STATES.includes(i.read) && !have.has(i.id)) { led.ids.push([i.id, Math.max(0, stamp(i.created, i.fetched_at || now()))]); have.add(i.id); touchBlyg(o); }
      if (led.ids.length > LIMITS.archiveIdsPerBlyg) trimLedger(led);
    }
    for (const [k, d] of docs) if (k.startsWith('body/')) S.bodies.set(k.slice(5), d.value || '');
  }
  // ---- what a commit writes ----
  function summaryOf(o) {
    const prev = S.prevSummary.get(o) || {};
    const led = ledgers.get(o);
    const mine = itemsOf(o);
    return {
      unread: mine.filter(isUnreadHeld).length,
      archived: S.archives.has(o) ? mine.filter(i => ARCHIVE_STATES.includes(i.read)).length : (Number(prev.archived) || 0),
      backfill: led ? led.backfill : (BACKFILL_MODES.includes(prev.backfill) ? prev.backfill : 'unknown'),
      bad: led ? Object.keys(led.bad).length : (Number(prev.bad) || 0),
      queue: led ? led.queue.length : (Number(prev.queue) || 0),
      // what the page says of a blyg's new posts: whether some wait (HOLD_STATES), and whether its fresh fetches are failing
      holding: led ? led.holding : (HOLD_STATES.includes(prev.holding) ? prev.holding : 'clear'),
      fresh: led ? led.fresh : (FRESH_MODES.includes(prev.fresh) ? prev.fresh : 'reading'),
      changes: led ? led.changes.filter(x => now() - x[0] < 24 * 3600e3).map(x => x[0]) : (Array.isArray(prev.changes) ? prev.changes.filter(t => Number.isFinite(t) && now() - t < 24 * 3600e3).slice(-50) : []),
    };
  }
  // As stored in a blyg's document, a record leaves out what the document already says: its origin, and its page address when
  // it is the default one (f/<id>/ or t/<id>/ under the origin). cleanRecord puts both back.
  const defaultPage = (origin, kind, id) => { try { return new URL(`${kind === 'fragment' ? 'f' : 't'}/${id}/`, origin).href; } catch { return ''; } };
  const compact = r => { const { origin, ...rest } = r; if (r.kind !== 'withdrawn' && r.page && r.page === defaultPage(origin, r.kind, r.id)) delete rest.page; return rest; };
  const byIdOf = list => Object.fromEntries(list.map(i => [i.id, compact(i)]));
  function docsNow() {
    const out = new Map();
    let migration = state.migration;
    if (migration.state === 'not_started') { migration = { state: 'not_started' }; moveMigration(migration, 'fresh'); } // (a new Hub: nothing to convert)
    out.set('state/following', { layout: LAYOUT, blygs: state.blygs, kept: state.kept, last_run: state.last_run, migration });
    out.set('state/run', S.run);
    if (state.inbox) out.set('state/inbox', state.inbox);
    if (state.stars) out.set('state/stars', { stars: state.stars });
    for (const o of S.feeds) if (state.blygs[o]) out.set(docKey('feed', ledgerName(o)), { origin: o, epoch: epochOf(o), items: byIdOf(itemsOf(o).filter(i => !ARCHIVE_STATES.includes(i.read) || !S.archives.has(o))), summary: summaryOf(o) });
    for (const o of S.archives) {
      if (!state.blygs[o]) continue;
      const items = byIdOf(itemsOf(o).filter(i => ARCHIVE_STATES.includes(i.read) || !S.feeds.has(o)));
      out.set(docKey('archive', ledgerName(o)), { origin: o, epoch: epochOf(o), items });
    }
    for (const [o, led] of ledgers) if (state.blygs[o] || state.kept[o]) out.set(docKey('ledger', ledgerName(o)), { origin: o, epoch: epochOf(o), ...led });
    return out;
  }
  const isDefaultDoc = (k, v) => {
    if (k === 'state/run') return canon(v) === canon(cleanRun(null));
    if (k === 'state/inbox') return canon(v) === canon(emptyInbox());
    if (k === 'state/stars') return Object.keys(v.stars).length === 0;
    if (k.startsWith('feed/') || k.startsWith('archive/')) return Object.keys(v.items).length === 0 && (!v.summary || (v.summary.archived === 0 && v.summary.bad === 0 && v.summary.queue === 0 && v.summary.backfill === 'unknown' && !v.summary.changes.length
      && v.summary.holding === 'clear' && v.summary.fresh === 'reading'));
    if (k.startsWith('ledger/')) { const { origin, epoch, ...led } = v; void origin; void epoch; return canon(led) === canon(cleanLedger(null)); }
    return false;
  };
  const PHASE = { ledger: 1, archive: 2, feed: 3, state: 5 };
  async function commit(opId, attempt) {
    const docs = S.docs;
    const writes = [];
    const plan = (k, value, touched) => {
      const d = docs.get(k);
      const was = d && d.value && typeof d.value === 'object' ? d.value : null;
      if (!touched && canon(content(was)) === canon(value)) return;
      if (!touched && !was && isDefaultDoc(k, value)) return; // nothing stored, and nothing to store
      // this operation's earlier attempt wrote it (a FINAL write), and nobody has written it since: it stands as written (a re-run
      // would apply the same change twice). If another wrote it after, the change is applied again on what they wrote.
      if (attempt > 0 && was && Array.isArray(was.ops) && was.ops[was.ops.length - 1] === opId) return;
      const [kind, ...rest] = k.split('/');
      const name = rest.join('/');
      const ops = [...(was && Array.isArray(was.ops) ? was.ops : []).slice(-(LIMITS.opsKept - 1))];
      const stamped = { ...value, ops: [...ops, opId] };
      if (kind === 'archive' && was && was.items) {
        // additions first; removals only after the feeds are written. The first half is stamped `<op>:add`: it is never this
        // operation's final write, so a re-run after a conflict between the halves writes the second half
        const removed = Object.keys(was.items).filter(id => !value.items[id]);
        if (removed.length) {
          const first = { ...value, ops: [...ops, `${opId}:add`], items: { ...Object.fromEntries(Object.entries(was.items).filter(([id]) => removed.includes(id))), ...value.items } };
          if (Object.keys(first.items).length !== Object.keys(was.items).length || canon(first.items) !== canon(was.items)) writes.push({ k, kind, name, value: first, phase: 2 });
          writes.push({ k, kind, name, value: stamped, phase: 4 });
          return;
        }
      }
      // a ledger whose only change is read ids ADDED is written last (a crash before it: R3 adds them again); any other change
      // of a ledger (an id removed, a counter) is written first
      const onlyAdds = kind === 'ledger' && was && Array.isArray(was.ids) && canon({ ...value, ids: was.ids }) === canon(content(was))
        && was.ids.every(p => value.ids.some(q => q[0] === p[0]));
      const phase = kind === 'state' ? (name === 'following' ? 7 : name === 'run' ? 8 : 6) : onlyAdds ? 9 : PHASE[kind];
      writes.push({ k, kind, name, value: stamped, phase });
    };
    const all = docsNow();
    for (const [k, value] of all) plan(k, value, false);
    // the documents a repair was worked out from: written too, conditionally, when anything is written (WHY A REPAIR NEEDS NO CLOCK)
    if (writes.length) for (const k of S.touch) if (all.has(k) && !writes.some(w => w.k === k)) plan(k, all.get(k), true);
    writes.sort((a, b) => a.phase - b.phase);
    // ... and, before anything is written, those documents are still the versions the repair was worked out from (a refresh's
    // snapshot is seconds old; its reads were not made at one instant): one written since makes this attempt run again, so a
    // first write (a ledger, say) can never be one worked out from a stale archive and then stand, as its own, after a conflict
    if (writes.length && S.touch.size) {
      await pool([...S.touch].filter(k => docs.has(k)), 8, async k => {
        const [kind, ...rest] = k.split('/');
        const g = await store.get(kind, rest.join('/'));
        if ((g ? g.version : null) !== (docs.get(k).version ?? null)) throw new StoreConflict(kind, rest.join('/'));
      });
    }
    for (const w of writes) {
      const d = docs.get(w.k);
      if (d && d.unreadable) throw Object.assign(new Error(`the Hub's ${w.kind} ${w.name} is not readable, so it is not written over`), { code: 'EUNREADABLEJSON' });
      const r = await store.put(w.kind, w.name, w.value, { ifVersion: d ? d.version : null });
      docs.set(w.k, { value: w.value, version: r.version, at: now() });
    }
    // an unfollowed blyg's documents: each deleted only if it is still the version this operation read (or, not read, still of
    // the epoch unfollowed): a refollow's documents written meanwhile are never deleted, whatever its epoch
    for (const [kind, name, epoch] of S.deletes) {
      const k = docKey(kind, name);
      let d = docs.get(k);
      if (!d) { const g = await store.get(kind, name); d = g ? { value: g.value, version: g.version } : null; if (d && (!d.value || d.value.epoch !== epoch)) d = null; }
      if (d && d.version !== null && d.version !== undefined) {
        try { await store.delete(kind, name, { ifVersion: d.version }); } catch (e) { if (!(e instanceof StoreConflict)) throw e; /* written since: not ours to delete */ }
      }
      docs.delete(k);
    }
    return writes.length;
  }
  // One operation at a time in this process (the store's compare-and-swap is what orders operations of different processes).
  let chain = Promise.resolve();
  const locked = fn => { const p = chain.then(fn, fn); chain = p.then(() => {}, () => {}); return p; };
  const drop = () => { state = null; S = null; ledgers.clear(); };
  /**
   * Run `mutate` as ONE transaction (see the storage seam). `wants`: what to read first. `write: false` for a view (nothing is
   * written). `guard`: refuse (HubNewer) when the store is of a newer layout: every operation that writes, and every read that
   * leads to a write (default: as `write`). `docs`: a map of documents already read (a refresh hands each blyg's on from its
   * snapshot to its apply; a write updates it). → what `mutate` returned.
   */
  function tx(wants, mutate, { write = true, guard = write, docs: given = null } = {}) {
    return locked(async () => {
      const opId = crypto.randomBytes(6).toString('hex');
      const spec = specOf(wants);
      const docs = given || new Map();
      const how = { rerun: 'first' };
      for (let attempt = 0; ; attempt++) {
        let result;
        try {
          for (let rounds = 0; ; rounds++) {
            await readDocs(spec, docs);
            if (guard && docs.get('state/following').newer) throw new HubNewer();
            build(spec, docs);
            // a re-run that finds a document this operation's earlier attempt wrote last: its move may be done already
            if (how.rerun === 'again' && [...docs.values()].some(d => d && d.value && Array.isArray(d.value.ops) && d.value.ops.includes(opId))) moveRerun(how, 'found_mine');
            S.rerun = how.rerun;
            try { result = mutate(); break; }
            catch (e) { if (!(e instanceof NeedMore) || rounds >= 8) throw e; addWants(spec, e.wants); }
          }
          if (!write) { drop(); return result; }
          prune();
          await commit(opId, attempt);
        } catch (e) {
          drop();
          if (e instanceof StoreConflict && attempt + 1 < LIMITS.txAttempts) {
            // read again what is stored now (keeping nothing of this attempt), and run the operation again
            for (const k of [...docs.keys()]) docs.delete(k);
            moveRerun(how, 'conflict');
            continue;
          }
          if (e instanceof StoreConflict) throw new Error('the Hub was changed by something else at the same moment, several times: try again');
          throw e;
        }
        const del = S.bodiesToDelete;
        drop();
        for (const n of new Set(del)) { try { await store.delete('body', n); } catch { /* swept later */ } }
        return result;
      }
    });
  }

  // ---- the conversion of an older layout (see THE CONVERSION above; MIGRATION_STATES) ----
  // The older layouts: every post in one main document (`items`); before that, the ledgers inside it too; on a hosted Hub, the
  // engine before the Archive (posts new, seen, opened, responded and no ledgers). Nothing is archived by the conversion: a post
  // is where its read state says (`seen` is unread, as before).
  const objectOr = (v, d = {}) => (v && typeof v === 'object' && !Array.isArray(v) ? v : d);
  /** This layout's documents already there for `origins` (and every blyg a ledger names): origin → { feed, archive, ledger } as stored. */
  async function docsThere(origins) {
    const names = new Map([...origins].map(o => [ledgerName(o), o]));
    const out = new Map();
    for (const kind of ['ledger', 'feed', 'archive']) {
      const listed = await store.list(kind);
      await pool(listed.filter(n => kind === 'ledger' || names.has(n)), 16, async n => {
        const g = await store.get(kind, n);
        const v = g && objectOr(g.value, null);
        if (!v || typeof v.origin !== 'string' || ledgerName(v.origin) !== n) return;
        if (!out.has(v.origin)) out.set(v.origin, {});
        out.get(v.origin)[kind] = { value: v, version: g.version };
      });
    }
    return out;
  }
  const epochThere = d => { for (const k of ['feed', 'archive', 'ledger']) { const v = d && d[k] && d[k].value; if (v && typeof v.epoch === 'string' && v.epoch) return v.epoch; } return ''; };
  /**
   * Steps 2 (and the merge): this layout's main document, `converting`, carrying the copy of `doc` (the older document, tagged
   * by its version). Written only if nothing is there yet (`ifMain` null) or the older document is still the version read.
   */
  async function beginConversion({ doc, tag, ifMain }) {
    const epochFor = o => crypto.createHash('sha256').update(`epoch\n${o}\n${tag}`).digest('hex').slice(0, 16);
    const oldBlygs = objectOr(doc.blygs), oldKept = objectOr(doc.kept);
    const there = await docsThere(new Set([...Object.keys(oldBlygs), ...Object.keys(oldKept)]));
    const blygs = {}, kept = {};
    for (const [o, b] of Object.entries(oldBlygs)) {
      if (originOf(o) !== o || !b || typeof b !== 'object') continue;
      // the epoch of the documents already there (an earlier conversion's, or this layout's since): they are kept as they are
      blygs[o] = { ...b, epoch: epochThere(there.get(o)) || (typeof b.epoch === 'string' && b.epoch ? b.epoch : epochFor(o)) };
    }
    for (const [o, k] of Object.entries(oldKept)) {
      if (blygs[o] || originOf(o) !== o) continue;
      const e = epochThere(there.get(o)) || (k && typeof k.epoch === 'string' && k.epoch ? k.epoch : epochFor(o));
      kept[o] = { at: Number(k && typeof k === 'object' ? k.at : k) || now(), epoch: e };
    }
    // a blyg the older document does not follow any more (an older invocation unfollowed it after an earlier conversion) whose
    // ledger of this layout is there: kept, as an unfollow without forget keeps it
    for (const [o, d] of there) {
      if (blygs[o] || kept[o] || originOf(o) !== o || !d.ledger || typeof d.ledger.value.epoch !== 'string' || !d.ledger.value.epoch) continue;
      kept[o] = { at: now(), epoch: d.ledger.value.epoch };
    }
    const mig = { state: 'not_started' };
    moveMigration(mig, 'begin');
    Object.assign(mig, { from: tag, copy: doc });
    await store.put('state', 'following', { layout: LAYOUT, blygs, kept, last_run: doc.last_run || null, migration: mig }, { ifVersion: ifMain });
  }
  /** Steps 3 and 4: every blyg's documents (keeping those there), the inbox, the unread posts' text; the copy; keeping_copy. */
  async function finishConversion(main) {
    const m = main.value;
    const mig = migrationOf(m);
    const tag = String(mig.from || '');
    const doc = objectOr(mig.copy);
    const items = Object.values(objectOr(doc.items));
    const oldLedgers = objectOr(doc.ledgers);
    const blygs = objectOr(m.blygs), kept = objectOr(m.kept);
    const put = async (kind, o, cur, value) => {
      // a document of this layout already there for this epoch stands as it is (an earlier attempt's, or written since)
      if (cur && cur.value && cur.value.epoch === value.epoch) return cur.value;
      await store.put(kind, ledgerName(o), { ...value, migrated_from: tag }, { ifVersion: cur ? cur.version : null });
      return { ...value, migrated_from: tag };
    };
    const getCur = async (kind, o) => { const g = await store.get(kind, ledgerName(o)); const v = g && objectOr(g.value, null); return g ? { value: v && v.origin === o ? v : null, version: g.version } : null; };
    await pool([...Object.entries(blygs), ...Object.entries(kept)], 8, async ([o, b]) => {
      if (originOf(o) !== o || !b || typeof b.epoch !== 'string') return;
      const followedNow = !!blygs[o];
      const mine = items.filter(i => i && typeof i === 'object' && i.origin === o && ID_RE.test(String(i.id || ''))).map(i => cleanRecord(structuredClone(i), o));
      const arch = followedNow ? mine.filter(i => ARCHIVE_STATES.includes(i.read)) : [];
      const feedItems = followedNow ? mine.filter(i => !ARCHIVE_STATES.includes(i.read)) : [];
      // its ledger: the one stored by the layout before (no epoch), else the one inside the old document; and R3
      const curL = await getCur('ledger', o);
      // its ledger: one there of this epoch stands; else the one of the layout before (no epoch), the one inside the old
      // document, or one of another epoch (a kept blyg's, say): its read ids are never dropped
      const raw = (curL && curL.value) || oldLedgers[o] || null;
      let ledNow = null;
      if (raw || arch.length) {
        const led = cleanLedger(raw);
        const have = new Set(led.ids.map(p => p[0]));
        for (const i of arch) if (!have.has(i.id)) { led.ids.push([i.id, Math.max(0, stamp(i.created, i.fetched_at || now()))]); have.add(i.id); }
        if (led.ids.length > LIMITS.archiveIdsPerBlyg) trimLedger(led);
        ledNow = cleanLedger(await put('ledger', o, curL, { origin: o, epoch: b.epoch, ...led }));
      }
      if (!followedNow) return;
      // a post read before (its id in the ledger, or in its gone filter) is not put back in the Feed by the older document's
      // copy of it (after a rollback the older code fetched it again as new), unless the record says a real edit brought it back
      if (ledNow) {
        const readIds = new Set(ledNow.ids.map(p => p[0]));
        const gone = goneTest(ledNow);
        for (let j = feedItems.length - 1; j >= 0; j--) {
          const i = feedItems[j];
          if (!isWithdrawn(i) && i.read !== 'edited' && (readIds.has(i.id) || gone(i.id))) feedItems.splice(j, 1);
        }
      }
      const curA = await getCur('archive', o);
      if (arch.length || (curA && curA.value)) await put('archive', o, curA, { origin: o, epoch: b.epoch, items: Object.fromEntries(arch.map(i => [i.id, i])) });
      const curF = await getCur('feed', o);
      const feed = (feedItems.length || (curF && curF.value)) ? await put('feed', o, curF, { origin: o, epoch: b.epoch, items: Object.fromEntries(feedItems.map(i => [i.id, i])),
        summary: { unread: feedItems.filter(isUnreadHeld).length, archived: arch.length, backfill: BACKFILL_MODES.includes(raw && raw.backfill) ? raw.backfill : 'unknown',
          bad: raw && raw.bad && typeof raw.bad === 'object' ? Object.keys(raw.bad).length : 0, queue: raw && Array.isArray(raw.queue) ? raw.queue.length : 0, changes: [] } }) : null;
      // the text of each unread post this conversion put in the feed: COPIED from where the older layout kept it (left there)
      if (feed && feed.migrated_from === tag) {
        await pool(Object.values(objectOr(feed.items)).filter(i => i && i.kind !== 'withdrawn'), 8, async i => {
          const name = bodyNameOf(i);
          const g = await store.get('oldbody', name);
          if (!g || typeof g.value !== 'string' || !g.value) return;
          try { await store.put('body', name, g.value, { ifVersion: null }); } catch (e) { if (!(e instanceof StoreConflict)) throw e; /* there already */ }
        });
      }
    });
    if (doc.inbox && typeof doc.inbox === 'object' && !(await store.get('state', 'inbox'))) {
      try { await store.put('state', 'inbox', doc.inbox, { ifVersion: null }); } catch (e) { if (!(e instanceof StoreConflict)) throw e; }
    }
    // step 4: the copy, kept through the quiet period; then the main document says so (conditionally: one that changed meanwhile
    // was finished by another invocation, and this one reads it again)
    await store.put('state', 'pre-shard', { from: tag, doc });
    const next = { state: mig.state, from: tag };
    moveMigration(next, 'converted');
    next.copy_until = now() + LIMITS.migrationQuietMs;
    const { migration: _m, ...rest } = content(m);
    await store.put('state', 'following', { ...rest, migration: next }, { ifVersion: main.version });
  }
  /** The text every unread post names, copied from 'oldbody' where 'body' lacks it. → how many named texts could not be copied. */
  async function copyOlderTexts() {
    const named = await tx({ allFeeds: true }, () => [...new Set(Object.values(load().items).filter(isUnreadHeld).map(bodyNameOf))], { write: false });
    const have = new Set(await store.list('body'));
    const older = new Set(await store.list('oldbody'));
    let missing = 0;
    for (const n of named) {
      if (have.has(n) || !older.has(n)) continue;
      try {
        const g = await store.get('oldbody', n);
        if (g && typeof g.value === 'string' && g.value) await store.put('body', n, g.value, { ifVersion: null });
      } catch (e) { if (!(e instanceof StoreConflict)) missing++; }
    }
    return missing;
  }
  /** Step 5, by a sweep: after the quiet period, the copy and the older bodies go, the marker keeps no old post, and it is done. */
  async function finishQuietPeriod() {
    const main = await getDoc('state', 'following');
    const mig = migrationOf(main.value);
    if (!main.value || layoutOf(main.value) !== LAYOUT || mig.state !== 'keeping_copy') return false;
    // a post the older code saved during the deploy may have its text only where the older code keeps it (written after the
    // conversion copied): copied now, at every sweep of the quiet period; nothing older is deleted while a named text is missing
    const missing = await copyOlderTexts();
    if (missing || now() < (mig.copy_until || 0)) return false;
    await store.delete('state', 'pre-shard');
    for (const n of await store.list('oldbody')) await store.delete('oldbody', n);
    const leg = await store.get('state', 'legacy');
    if (leg && isMarker(leg.value) && markerStateOf(leg.value) === 'carrying_copy') {
      try { await store.put('state', 'legacy', emptiedMarker(leg.value), { ifVersion: leg.version }); } catch (e) { if (!(e instanceof StoreConflict)) throw e; }
    }
    await tx({}, () => { const m = load().migration; if (m.state === 'keeping_copy') moveMigration(m, 'finish', now()); });
    return true;
  }

  // A post whose blyg is not followed has no business being held; the ledgers kept for unfollowed blygs: at most keptMax,
  // none older than keptMs.
  const prune = () => {
    const st = state;
    for (const [k, i] of Object.entries(st.items)) if (!st.blygs[i.origin]) delete st.items[k];
    const kept = Object.entries(st.kept).sort((a, b) => b[1].at - a[1].at);
    for (const [i, [o, k]] of kept.entries()) if (i >= LIMITS.keptMax || now() - k.at > LIMITS.keptMs) moveFollow(st, o, 'expire');
  };
  const followStateOf = (st, origin) => (st.blygs[origin] ? 'followed' : st.kept[origin] !== undefined ? 'kept' : 'forgotten');
  /**
   * The ONE way a blyg's follow state changes (FOLLOW_STATES): refuses a move the table does not allow, then makes the maps say
   * the new state. `record` is the blyg's record for follow and refollow. → the new state.
   */
  function moveFollow(st, origin, ev, record = null) {
    const was = followStateOf(st, origin);
    const to = followMachine.to(was, ev);
    const name = ledgerName(origin);
    if (to === 'followed') {
      // every follow starts a new EPOCH, a refollow too: whatever a slow invocation wrote for the blyg as it was followed before
      // (a refresh's apply that read the follow list before the unfollow) is read as absent. The kept ledger is used as it is,
      // and written again under the new epoch (it was read: ledgerOf)
      if (was === 'kept') ledgerOf(origin);
      st.blygs[origin] = { ...record, epoch: newEpoch() };
      delete st.kept[origin];
    } else if (to === 'kept') {
      const epoch = st.blygs[origin].epoch;
      st.kept[origin] = { at: now(), epoch };
      delete st.blygs[origin];
      S.deletes.push(['feed', name, epoch], ['archive', name, epoch]);
    } else {
      const epoch = epochOf(origin);
      delete st.blygs[origin]; delete st.kept[origin];
      ledgers.delete(origin);
      S.deletes.push(['feed', name, epoch], ['archive', name, epoch], ['ledger', name, epoch]);
    }
    return to;
  }
  // A blyg's ledger, a document of its own: the ids of its posts the owner ticked, each with the post's `created`, the ids
  // whose document could not be used, the back-off list, its backfill mode, queue and counters. Read as untrusted.
  const cleanLedger = raw => {
    const r = raw && typeof raw === 'object' ? raw : {};
    const seenIds = new Set();
    const ids = [];
    for (const x of Array.isArray(r.ids) ? r.ids : []) {
      const [id, c] = typeof x === 'string' ? [x, 0] : Array.isArray(x) ? x : [null, 0];
      if (typeof id !== 'string' || !ID_RE.test(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push([id, Number.isFinite(c) && c > 0 ? Math.floor(c) : 0]);
      if (ids.length >= LIMITS.archiveIdsPerBlyg + LIMITS.ledgerTrim) break;
    }
    const bad = {};
    if (r.bad && typeof r.bad === 'object' && !Array.isArray(r.bad)) {
      for (const [id, v] of Object.entries(r.bad)) {
        if (Object.keys(bad).length >= LIMITS.badPerBlyg) break;
        const [ver, at] = Array.isArray(v) ? v : [v, now()];
        if (ID_RE.test(id) && Number.isInteger(ver) && ver >= 1 && Number.isFinite(at)) bad[id] = [ver, at];
      }
    }
    const later = {};
    if (r.later && typeof r.later === 'object' && !Array.isArray(r.later)) {
      for (const [id, v] of Object.entries(r.later)) {
        if (Object.keys(later).length >= LIMITS.laterPerBlyg) break;
        if (ID_RE.test(id) && Array.isArray(v) && Number.isFinite(v[0]) && Number.isInteger(v[1]) && v[1] >= 1 && v[1] < 64) later[id] = [v[0], v[1]];
      }
    }
    const gone = r.gone && typeof r.gone === 'object' && typeof r.gone.bits === 'string' && Buffer.from(r.gone.bits, 'base64').length === LIMITS.goneBits / 8
      && Number.isInteger(r.gone.n) && r.gone.n >= 0 ? { n: r.gone.n, bits: r.gone.bits } : null;
    const seenUntil = Number.isFinite(r.seen_until) && r.seen_until > 0 && r.seen_until <= now() ? r.seen_until : 0;
    const queue = [];
    for (const q of Array.isArray(r.queue) ? r.queue : []) {
      if (queue.length >= LIMITS.queuePerBlyg) break;
      if (!q || typeof q.id !== 'string' || !ID_RE.test(q.id) || !KINDS.includes(q.kind) || q.kind === 'withdrawn' || !Number.isInteger(q.version) || q.version < 1) continue;
      queue.push({ id: q.id, kind: q.kind, version: q.version, created: cleanText(q.created, 40), updated: cleanText(q.updated, 40),
        ...(typeof q.awaits === 'string' && ID_RE.test(q.awaits) ? { awaits: q.awaits } : {}) });
    }
    // when posts of this blyg returned to the Feed through an edit, in the last 24 hours (editReturnsPerDay): never fewer than
    // stored, so a count is never lost (each a time; at most editReturnsPerDay are needed to refuse the next)
    // each entry is [when, the post's id] (a bare time, from before entries named their post, is kept as one with no id): so an
    // operation that is run again after a conflict does not count the same post's return or change twice
    const timed = (list, max) => (Array.isArray(list) ? list : []).map(x => (Number.isFinite(x) ? [x, ''] : Array.isArray(x) && Number.isFinite(x[0]) ? [x[0], typeof x[1] === 'string' && ID_RE.test(x[1]) ? x[1] : ''] : null))
      .filter(x => x && now() - x[0] < 24 * 3600e3 && x[0] <= now()).slice(-max);
    const returns = timed(r.returns, LIMITS.editReturnsPerDay);
    const changes = timed(r.changes, 50);
    const fresh = FRESH_MODES.includes(r.fresh) ? r.fresh : 'reading';
    const freshFailures = Number.isInteger(r.fresh_failures) && r.fresh_failures > 0 && r.fresh_failures < 64 ? r.fresh_failures : 0;
    const freshAfter = Number.isFinite(r.fresh_after) && r.fresh_after > 0 ? r.fresh_after : 0;
    const holding = HOLD_STATES.includes(r.holding) ? r.holding : 'clear';
    return { ids, gone, bad, later, seen_until: seenUntil, returns, changes, queue, fresh, fresh_failures: freshFailures, fresh_after: freshAfter, holding,
      backfill: BACKFILL_MODES.includes(r.backfill) ? r.backfill : 'unknown' };
  };
  /** A blyg's ledger (read by this operation, or NeedMore). */
  const ledgerOf = origin => { load(); if (!ledgers.has(origin)) { if (!state.blygs[origin] && !state.kept[origin]) return cleanLedger(null); need({ ledgers: [origin] }); } return ledgers.get(origin); };
  const ledgerFor = ledgerOf;
  const needFeeds = origins => { const miss = origins.filter(o => state.blygs[o] && !S.feeds.has(o)); if (miss.length) need({ feeds: miss }); };
  const needArchives = origins => { const miss = origins.filter(o => state.blygs[o] && !S.archives.has(o)); if (miss.length) need({ archives: miss }); };
  const needLedgers = origins => { const miss = origins.filter(o => (state.blygs[o] || state.kept[o]) && !ledgers.has(o)); if (miss.length) need({ ledgers: miss }); };
  const needAllFeeds = () => { if (Object.keys(state.blygs).some(o => !S.feeds.has(o))) need({ allFeeds: true }); };
  const needStars = () => { if (!state.stars) need({ stars: true }); };
  const needBodies = names => { const miss = [...new Set(names)].filter(n => !S.bodies.has(n)); if (miss.length) need({ bodies: miss }); };

  // The oldest-ticked archive records beyond the per-blyg cap are dropped (never a starred one). Their ids stay in their ledgers
  // (R3 put them there when the ledger and the archive were read together; trimming is done only then).
  const trimArchive = origin => {
    if (!ledgers.has(origin) || !S.archives.has(origin)) return 0;
    const arch = itemsOf(origin).filter(i => ARCHIVE_STATES.includes(i.read));
    if (arch.length <= LIMITS.archiveRecordsPerBlyg) return 0;
    needStars();
    const starred = new Set(Object.keys(state.stars));
    const candidates = arch.filter(i => !starred.has(identOf(i.origin, i.id))).sort((a, b) => (Date.parse(a.archived_at) || 0) - (Date.parse(b.archived_at) || 0));
    const drop = candidates.slice(0, arch.length - LIMITS.archiveRecordsPerBlyg);
    for (const i of drop) delete state.items[identOf(i.origin, i.id)];
    if (drop.length) S.touch.add('state/stars'); // (worked out from the stars: written too, so a star made meanwhile re-runs this)
    return drop.length;
  };
  // ---- the limits: the oldest unread posts step aside (THE LIMITS, at the top) ----
  /** The slim record an older post keeps: what the Feed's "Older posts" lists and what is needed to fetch it again. No text. */
  const olderRecordOf = rec => ({
    key: rec.key, origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.version, index_version: rec.index_version ?? rec.version,
    created: rec.created, updated: rec.updated, fetched_at: rec.fetched_at, first_seen: rec.first_seen,
    page: typeof rec.page === 'string' && rec.page.length <= LIMITS.pageChars && isWebUrl(rec.page) ? rec.page : '', content_hash: rec.content_hash,
    title: cleanText(plainText(rec.title) || plainText(rec.excerpt), LIMITS.archiveTitleChars), author: cleanText(rec.author, 120), read: rec.read, older_at: iso(),
  });
  /** Step one unread post aside (READ_MOVES step_aside): its record slimmed, its text released after the commit. */
  function stepAside(rec) {
    const next = olderRecordOf(rec);
    moveRead(next, 'step_aside');
    touch(rec);
    load().items[identOf(rec.origin, rec.id)] = next;
    S.bodiesToDelete.push(bodyNameOf(rec));
  }
  const oldestFirst = (a, b) => stamp(a.created, a.fetched_at) - stamp(b.created, b.fetched_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  /**
   * After posts came into the Feed (a refresh's or a top-up's apply, an untick): while `origin` holds more unread posts than its
   * limit, its oldest step aside; then, while all blygs together hold more than theirs, the oldest of all (every feed is read).
   * The newest `limit` unread posts always stay (so a new post is never the one moved, whatever is protected), and so does
   * every post that is starred, responded to or edited (READ_MOVES step_aside), and `keep` (the post just put back by the owner):
   * with too many of those the limit is exceeded by them, never met by moving a newer post. The decision reads the stars: the
   * stars document is written too (conditionally), so a star made meanwhile re-runs it. → how many stepped aside.
   */
  function makeRoom(origin, cfg, { keep = '' } = {}) {
    let n = 0;
    const room = (list, limit) => {
      const over = list.length - limit;
      if (over <= 0) return;
      needStars();
      const starred = state.stars;
      const newest = new Set([...list].sort(oldestFirst).slice(-limit));
      const movable = list.filter(i => !newest.has(i) && canMoveRead(i, 'step_aside') && !starred[identOf(i.origin, i.id)] && i.key !== keep);
      for (const i of movable.sort(oldestFirst).slice(0, over)) { stepAside(i); n++; }
    };
    if (origin && load().blygs[origin]) { needFeeds([origin]); room(itemsOf(origin).filter(isUnreadHeld), cfg.following_max_items_per_blyg); }
    if (totalItems() > cfg.following_max_items_total) { needAllFeeds(); room(Object.values(load().items).filter(isUnreadHeld), cfg.following_max_items_total); }
    if (n) S.touch.add('state/stars');
    return n;
  }
  /** Beyond olderPerBlyg older records in a blyg, the oldest leave its list (never marked read: the reading back finds them again). */
  const trimOlder = origin => {
    const older = itemsOf(origin).filter(i => i.read === 'older');
    if (older.length <= LIMITS.olderPerBlyg) return 0;
    const drop = older.sort(oldestFirst).slice(0, older.length - LIMITS.olderPerBlyg);
    for (const i of drop) delete load().items[identOf(i.origin, i.id)];
    return drop.length;
  };

  // The sanitised body of each post is a 'body' of its own in the store, named in its record (`body`; a record of the older
  // layout: its key), written BEFORE the record that names it and deleted AFTER the record that named it is written.
  const readBodyHtml = rec => {
    const name = bodyNameOf(rec);
    needBodies([name]);
    const html = S.bodies.get(name) || '';
    return html ? sanitizeStable(html, { max: LIMITS.bodyBytes + 4096, truncate: true, landmarks: false }).html : '';
  };
  /** Write a body before any record names it. → its name. Throws when the store refused it. */
  async function putBody(key, html) {
    const name = newBodyName(key);
    await store.put('body', name, String(html));
    return name;
  }

  // ---- the run lease, the top-up gap and the breakers: in the store's run document ----
  // The lease is the run document's `lease`: ONE field, RUN_STATES, moved by moveRun (its `until` gates `lapse`: a lease whose
  // holder died is taken back only after it). The top-up gap is `topup_after` beside it. The breakers are the hosts' ones.
  const leaseOf = () => S.run.lease;
  const lapseIfDue = () => { const l = leaseOf(); if (l.state !== 'idle' && now() >= l.until) { moveRun(l, 'lapse', now()); l.holder = ''; l.until = 0; } };
  const takeLease = (kind, holder, ms) => tx({}, () => {
    lapseIfDue();
    const l = leaseOf();
    if (l.state === 'running') return { ok: false, reason: kind === 'refresh' ? 'a refresh is already running' : 'a refresh is running: it reads further back itself' };
    if (l.state === 'topping_up') return { ok: false, reason: kind === 'refresh' ? 'the Feed is being topped up; try again in a moment' : 'a top-up is already running' };
    if (kind === 'topup' && now() < S.run.topup_after) return { ok: false, reason: 'topped up a moment ago' };
    moveRun(l, kind === 'refresh' ? 'begin' : 'topup', now());
    l.holder = holder; l.until = now() + ms;
    if (kind === 'topup') S.run.topup_after = now() + LIMITS.topupGapMs;
    return { ok: true };
  });
  /** The lease again for `ms` (only by its holder). → false if it was lost (lapsed and taken by another meanwhile). */
  const renewLease = (holder, ms) => tx({}, () => {
    const l = leaseOf();
    if (l.state === 'idle' || l.holder !== holder) return false;
    moveRun(l, 'renew', now()); l.until = now() + ms;
    applyBreakerEvents();
    return true;
  });
  const releaseLease = (holder, kind) => tx({}, () => {
    const l = leaseOf();
    if (l.state !== 'idle' && l.holder === holder) { moveRun(l, 'end', now()); l.holder = ''; l.until = 0; }
    if (kind === 'topup') S.run.topup_after = Math.max(S.run.topup_after, now() + LIMITS.topupGapMs);
    applyBreakerEvents();
  });
  // A host's breaker: what this invocation saw (`breakers`, read from the run document when an operation began) and the events it
  // added (`breakerEvents`), applied again, in order, to the stored breakers when written (so another invocation's are kept).
  const breakers = new Map();
  let breakerEvents = [];
  const syncBreakers = () => { breakers.clear(); for (const [h, b] of Object.entries(S.run.breakers)) breakers.set(h, { ...b }); };
  const stepBreaker = (b, ev, at) => {
    if (ev === 'cool') { if (b.state === 'open' && at >= b.until) moveBreaker(b, 'cool'); return; }
    if (ev === 'ok') { if (b.state !== 'open') { moveBreaker(b, 'ok'); b.failures = 0; } return; }
    b.failures++;
    if (b.state === 'half-open' || b.failures >= BREAKER.threshold) { if (b.state !== 'open') moveBreaker(b, 'trip'); b.until = at + BREAKER.cooldownMs; }
  };
  function applyBreakerEvents() {
    const evs = breakerEvents; breakerEvents = [];
    const bs = S.run.breakers;
    for (const [h, ev, at] of evs) { if (!bs[h]) bs[h] = { state: 'closed', failures: 0, until: 0 }; stepBreaker(bs[h], ev, at); }
    for (const [h, b] of Object.entries(bs)) if (b.state === 'closed' && b.failures === 0) delete bs[h];
    const hosts = Object.keys(bs);
    if (hosts.length > LIMITS.breakersKept) for (const h of hosts.sort((a, c) => bs[a].until - bs[c].until).slice(0, hosts.length - LIMITS.breakersKept)) delete bs[h];
    syncBreakers();
  }
  const flushBreakers = () => (breakerEvents.length ? tx({}, () => { applyBreakerEvents(); }) : Promise.resolve());
  const breakerOf = host => { if (!breakers.has(host)) breakers.set(host, { state: 'closed', failures: 0, until: 0 }); return breakers.get(host); };
  const note = (host, ev) => { stepBreaker(breakerOf(host), ev, now()); breakerEvents.push([host, ev, now()]); };
  const breakerAllows = host => {
    const b = breakerOf(host);
    if (b.state === 'open' && now() >= b.until) note(host, 'cool');
    return b.state !== 'open';
  };
  const loadBreakers = () => tx({}, () => { syncBreakers(); }, { write: false });

  // The ONLY place a request is made: refused when fetching is off, counted against the
  // budget, refused by an open breaker, judged by the guard (get = netguard's guardedGet).
  const getter = budget => async (url, { maxBytes, accept = 'application/json', timeoutMs = LIMITS.timeoutMs, headers } = {}) => {
    if (!mayFetch()) throw new FetchTrouble('off', 'fetching is off (blyg_checks)');
    const host = hostOf(url);
    if (!breakerAllows(host)) throw new FetchTrouble('breaker', `${host} failed too often; not asked again for a while`);
    budget.take();
    let r;
    try { r = await get(String(url), { maxBytes, accept, timeoutMs: Math.max(1, Math.min(timeoutMs, budget.left())), ...(headers ? { headers } : {}) }); }
    catch (e) { if (!e || e.kind !== 'refused') note(host, 'fail'); throw e; }
    // a 5xx, or a 429 (the host asks to be asked less), counts against the host's breaker like a failure to connect
    if (Number(r.status) >= 500 || Number(r.status) === 429) note(host, 'fail'); else note(host, 'ok');
    return r;
  };
  // → { status: 'ok', json, url } | { status: 'garbled', code } (a 2xx that is not a JSON object) | { status: 'absent', code } (any other
  //   answer below 500 but 429) | { status: 'trouble', kind, message } (could not ask, out of budget, a 5xx or a 429)
  const fetchJson = async (g, url, maxBytes) => {
    let r;
    try { r = await g(url, { maxBytes }); }
    catch (e) { return { status: 'trouble', kind: (e && e.kind) || 'network', message: cleanText(String((e && e.message) || 'could not fetch'), 200) }; }
    const code = Number(r.status) || 0;
    if (code >= 500 || code === 429) return { status: 'trouble', kind: 'network', message: `HTTP ${code}` };
    if (code < 200 || code >= 300) return { status: 'absent', code };
    try { const j = JSON.parse(String(r.text ?? '')); return j && typeof j === 'object' ? { status: 'ok', json: j, url: String(r.url || url) } : { status: 'garbled', code }; }
    catch { return { status: 'garbled', code }; }
  };

  const settings = () => {
    const s = { ...getSettings() };
    if (Number.isFinite(ceilings.itemsTotal)) s.following_max_items_total = Math.min(s.following_max_items_total, ceilings.itemsTotal);
    if (Number.isFinite(ceilings.itemsPerBlyg)) s.following_max_items_per_blyg = Math.min(s.following_max_items_per_blyg, ceilings.itemsPerBlyg);
    return s;
  };
  const itemsOf = origin => Object.values(load().items).filter(i => i.origin === origin);
  const heldItem = (origin, id) => { needFeeds([origin]); needArchives([origin]); return load().items[identOf(origin, id)]; };
  /** The record a page's key names (reading its blyg's feed and archive, found by the key's first 8 hex; a key of the older layout: every blyg's). */
  const byKey = key => {
    const k = String(key || '');
    const hit = Object.values(load().items).find(i => i.key === k);
    if (hit) return hit;
    const cand = Object.keys(state.blygs).filter(o => ledgerName(o).slice(0, 8) === k.slice(0, 8));
    const miss = cand.filter(o => !S.feeds.has(o) || !S.archives.has(o));
    if (miss.length) need({ feeds: miss, archives: miss });
    const all = Object.keys(state.blygs).filter(o => !S.feeds.has(o) || !S.archives.has(o));
    if (all.length) need({ allFeeds: true, allArchives: true });
    return null;
  };
  const copy = v => (v === null || v === undefined ? v : structuredClone(v));
  // What the caps and the target count: UNREAD held posts. A withdrawn marker costs nothing; an archived or older record is not held text.
  const isUnreadHeld = i => !isWithdrawn(i) && !TEXTLESS_STATES.includes(i.read);
  const unreadOf = origin => { needFeeds([origin]); return itemsOf(origin).filter(isUnreadHeld).length; };
  /** The unread posts held in all: those read by this operation, and (a refresh or a top-up) the summaries of the others. */
  const totalItems = () => {
    const st = load();
    let n = Object.values(st.items).filter(isUnreadHeld).length;
    for (const o of Object.keys(st.blygs)) if (!S.feeds.has(o)) { if (opCtx) n += opCtx.unread.get(o) || 0; else needFeeds([o]); }
    return n;
  };
  /** The Feed's count: what the Feed tab shows (bursts folded, paused blygs and Background left out). Reads every feed. */
  const unreadCount = () => { needAllFeeds(); const st = load(); return buildView({ items: Object.values(st.items), blygs: st.blygs, now: now() }).tabs.feed; };

  // ---- the follow list ----
  async function resolve(url, g) {
    const s = session(url, (u, o) => g(u, o));
    let m = await findManifest(s, url, null);
    if (m.status !== 'found') {
      // not at the page's own path or a conventional mount: read the page's <link rel="blyg"> (§12.1 step 4)
      const page = await s.raw(url, { maxBytes: BLYG_LIMITS.pageBytes, accept: 'text/html' });
      if (page.status === 'answered' && page.code >= 200 && page.code < 300) {
        const h = pageLinks(page.text, page.url);
        if (h.blyg) m = await findManifest(s, url, { blyg: h.blyg, json: '' });
      } else if (page.status === 'trouble' && m.status === 'none') m = { status: 'trouble' };
    }
    if (m.status === 'found') {
      return { origin: m.origin, title: cleanText(m.manifest.title, 200),
        author: cleanText(m.manifest.author && m.manifest.author.name, 200) };
    }
    return m.status === 'trouble'
      ? { trouble: s.troubles[0] ? cleanText(s.troubles[0].message, 200) : 'the site could not be asked' }
      : { none: true };
  }
  function addBlyg({ origin, title = '', author = '', via }) {
    const st = load();
    if (st.blygs[origin]) return false;
    if (Object.keys(st.blygs).length >= LIMITS.followMax) throw new Error(`at most ${LIMITS.followMax} blygs can be followed`);
    // followed again after an unfollow that kept what was read: its ledger (read ids and gone filter) is used as it is
    moveFollow(st, origin, followStateOf(st, origin) === 'kept' ? 'refollow' : 'follow', { origin, title: cleanText(title, 200), author: cleanText(author, 200),
      state: 'active', added: new Date(now()).toISOString(), via, failures: 0, absent_runs: 0, retry_after: 0, last_try: 0, last_ok: 0, last_error: '' });
    return true;
  }
  async function follow(url) {
    if (!originOfUrl(url)) throw new Error('that is not a web address');
    await loadBreakers();
    const g = getter(newBudget({ following_run_requests: LIMITS.followRequests, following_run_seconds: 30 }, now));
    let r;
    try { r = await resolve(String(url), g); } finally { await flushBreakers(); }
    if (r.trouble) throw new Error(`could not ask that site: ${r.trouble}`);
    if (r.none) throw new Error('no Blygger manifest was found there');
    const added = await tx({}, () => addBlyg({ ...r, via: 'url' }));
    await reschedule(); onChange();
    return { ...r, added };
  }
  /**
   * Stop following. Its posts and archive records go either way, and its starred posts stay starred unless asked to forget.
   * `forget: false` (the page's "Stop following") KEEPS its ledger's read ids and gone filter (so following it again does not
   * bring back as unread what was read there); `forget: true` deletes the ledger and its stars too.
   */
  async function unfollow(origin, { forget = false } = {}) {
    const o = String(origin);
    const r = await tx({ feeds: [o], archives: [o], ledgers: [o], stars: forget }, () => {
      const st = load();
      if (!st.blygs[o]) return S.rerun === 'again_mine'; // (unfollowed by this operation's own earlier attempt: true)
      for (const i of itemsOf(o)) if (isUnreadHeld(i)) S.bodiesToDelete.push(bodyNameOf(i));
      if (forget) {
        needStars();
        for (const [k, e] of Object.entries(state.stars)) if (e.origin === o) { moveStar(e, 'unstar'); delete state.stars[k]; }
        moveFollow(st, o, 'unfollow_forget');
      } else {
        const led = ledgerFor(o); // (R3 has put every archive record's id in it)
        led.bad = {}; led.later = {};
        moveBackfill(led, 'forget');
        moveFollow(st, o, 'unfollow_keep');
        // the kept ledger is written even if nothing in it changed: a refresh's apply that read the follow list before this
        // unfollow then meets a changed ledger and runs again (and sees the unfollow), never writes into what is kept
        S.touch.add(docKey('ledger', ledgerName(o)));
      }
      for (const k of Object.keys(st.items)) if (st.items[k].origin === o) delete st.items[k];
      return true;
    });
    if (r) { await reschedule(); onChange(); }
    return r;
  }
  /** What /following/state may ask: pause or resume a blyg (BLYG_STATES), or Retry its reading back (BACKFILL_MODES). */
  async function stateRequest(data) {
    const d = data && typeof data === 'object' ? data : {};
    const origin = String(d.origin || '');
    if (d.move === 'retry') return retryBackfill(origin);
    if (!['pause', 'resume'].includes(d.move)) throw new Error('move must be pause, resume or retry');
    return setBlygState(origin, d.move);
  }
  /** The owner's Retry on a blyg whose reading back is paused: its list of unusable documents is cleared and its index read afresh. */
  async function retryBackfill(origin) {
    const r = await tx({ feeds: [origin], ledgers: [origin] }, () => {
      if (!load().blygs[origin]) throw new Error('not followed');
      const led = ledgerFor(origin);
      if (!canMoveBackfill(led, 'retry')) throw new Error('reading back is not paused for that blyg');
      moveBackfill(led, 'retry');
      led.bad = {}; led.later = {};
      return led.backfill;
    });
    onChange();
    return r;
  }
  async function setBlygState(origin, ev) {
    const r = await tx({}, () => {
      const b = load().blygs[origin];
      if (!b) throw new Error('not followed');
      if (S.rerun === 'again_mine' && !canMoveBlyg(b, ev) && Object.values(BLYG_MOVES[ev]).includes(b.state)) return b.state; // (its own earlier attempt)
      moveBlyg(b, ev);
      if (ev === 'resume') { b.failures = 0; b.absent_runs = 0; b.retry_after = 0; }
      return b.state;
    });
    onChange();
    return r;
  }
  // The table of blygs, from the main document and each blyg's feed summary: no ledger is read.
  const blygRows = () => {
    needAllFeeds();
    return Object.values(load().blygs).map(b => { const s = summaryOf(b.origin); return { ...copy(b), items: s.unread, archived: s.archived, backfill: s.backfill, bad_documents: s.bad }; });
  };
  const listBlygs = () => tx({ allFeeds: true }, blygRows, { write: false });

  // ---- importing a blogroll or directory ----
  /** What WOULD be added from OPML or a directory document (a URL, or pasted text). Adds nothing. */
  async function previewImport({ url = '', text = '' } = {}) {
    await loadBreakers();
    const budget = newBudget({ following_run_requests: LIMITS.importRequests, following_run_seconds: 120 }, now);
    const g = getter(budget);
    try {
      let body = String(text || '');
      if (!body.trim()) {
        if (!originOfUrl(url)) throw new Error('give a web address or paste the document');
        try { body = String((await g(String(url), { maxBytes: LIMITS.importBytes, accept: 'text/x-opml, application/xml, application/json, */*' })).text || ''); }
        catch (e) { throw new Error(`could not fetch that: ${cleanText(String(e && e.message), 200)}`); }
      }
      const head = body.trimStart()[0];
      const have = new Set(await tx({}, () => Object.keys(load().blygs), { write: false }));
      const out = { kind: head === '<' ? 'opml' : 'directory', add: [], already: [], skipped: [] };
      const seen = new Set();
      const offer = (e, why) => {
        if (why) return out.skipped.push({ title: e.title || '', url: e.url || e.origin || '', reason: why });
        if (seen.has(e.origin)) return;
        seen.add(e.origin);
        (have.has(e.origin) ? out.already : out.add).push({ origin: e.origin, title: e.title || '', author: e.author || '' });
      };
      if (head === '<') {
        let n = 0;
        for (const e of parseOpml(body)) {
          if (n++ >= LIMITS.importMax) { out.skipped.push({ title: '', url: '', reason: `only the first ${LIMITS.importMax} entries are looked at` }); break; }
          if (budget.spent()) { out.skipped.push({ title: e.title, url: e.url, reason: 'out of requests for this preview' }); continue; }
          const r = await resolve(e.url, g);
          if (r.origin) offer({ ...r, title: r.title || e.title });
          else offer(e, r.trouble ? `could not ask: ${r.trouble}` : 'not a blyg');
        }
      } else {
        for (const e of parseDirectory(body)) offer(e);
      }
      return out;
    } finally { await flushBreakers(); }
  }
  /** Add exactly the origins the reader confirmed. */
  async function confirmImport(entries) {
    const r = await tx({}, () => {
      const added = [], skipped = [];
      // (the ledgers of the kept blygs among them, read at once: a refollow writes its ledger again)
      needLedgers((Array.isArray(entries) ? entries.slice(0, LIMITS.followMax) : []).map(e => originOf(e && e.origin)).filter(o => o && load().kept[o]));
      for (const e of Array.isArray(entries) ? entries.slice(0, LIMITS.followMax) : []) {
        const origin = originOf(e && e.origin);
        if (!origin || urlRefusal(origin)) { skipped.push(String(e && e.origin || '').slice(0, 200)); continue; }
        try { if (addBlyg({ origin, title: e.title, author: e.author, via: 'import' })) added.push(origin); else skipped.push(origin); }
        catch { skipped.push(origin); }
      }
      return { added, skipped };
    });
    if (r.added.length) { await reschedule(); onChange(); }
    return r;
  }

  // ---- reconciliation ----
  const backoffMs = failures => Math.min(LIMITS.backoffFirstMs * 2 ** Math.max(0, failures - 1), LIMITS.backoffMaxMs);
  const due = b => b.state === 'active' || (b.state === 'unreachable' && now() >= (b.retry_after || 0));

  function noteFailure(b, kind, message) {
    b.last_error = cleanText(message, 200);
    if (kind === 'absent') {
      b.absent_runs = (b.absent_runs || 0) + 1;
      if (b.absent_runs >= LIMITS.goneAfter && canMoveBlyg(b, 'vanish')) moveBlyg(b, 'vanish');
      return;
    }
    b.failures = (b.failures || 0) + 1;
    if (canMoveBlyg(b, 'fail')) { moveBlyg(b, 'fail'); b.retry_after = now() + backoffMs(b.failures); } // (a blyg the owner paused meanwhile stays paused)
  }
  const tombstone = (held, e) => ({ key: held.key || randomKey(held.origin), origin: held.origin, id: held.id, kind: 'withdrawn', version: e.version, index_version: e.version,
    created: held.created, updated: e.updated || held.updated, fetched_at: now(), page: held.page, content_hash: held.content_hash, read: held.read && held.read !== 'older' ? held.read : 'new',
    identity: held.identity || 'unverified', last_change: 'new-words', stub_of: null, transclusions: 0, links: 0, refs: [], ref_origins: [],
    title: '', excerpt: '', text: '', text_chars: 0, author: '', versions: [], first_seen: held.first_seen, maintenance: 0 });
  const itemUrlFor = (manifest, origin, id) => {
    const t = typeof manifest.item === 'string' && manifest.item ? manifest.item : 'items/{id}.json';
    try { return new URL(t.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(k === 'id' ? id : '')), origin).href; } catch { return ''; }
  };
  const NOT_THE_BLYGS_FAULT = ['limit', 'breaker', 'off'];

  /**
   * Fetch ONE item document and check it as every document is checked: inside the blyg's own origin (also after redirects), its
   * id and origin the ones asked for, a kind and a page this code knows. Writes nothing. → { out: 'ok', doc, rec, body } or { out },
   * `out` being 'unusable' (answered, and cannot be used), 'missing' (404, 410, 403...), 'trouble' (out of budget, a breaker or
   * fetching off: asked again next run), 'host_trouble' (the host could not answer) or 'refused' (with `error`, for the blyg).
   */
  async function pull(b, id, g, tally) {
    const url = itemUrlFor({ item: b.item_template }, b.origin, id);
    if (!isWebUrl(url) || !within(b.origin, url)) { tally.refused++; return { out: 'refused', error: REFUSALS.item }; }
    const r = await fetchJson(g, url, LIMITS.itemBytes);
    if (r.status === 'trouble') {
      if (NOT_THE_BLYGS_FAULT.includes(r.kind)) { tally.deferred++; return { out: 'trouble', message: r.message }; }
      tally.errors++; return { out: 'host_trouble', message: r.message };
    }
    if (r.status === 'absent') { tally.missing++; return { out: 'missing', message: `HTTP ${r.code}` }; }
    if (!within(b.origin, r.url)) { tally.refused++; return { out: 'unusable', error: REFUSALS.redirect }; }
    const doc = r.json;
    if (r.status !== 'ok' || docRefusal(doc, { id, origin: b.origin })) { tally.invalid++; return { out: 'unusable' }; }
    const rec = recordFromDoc(doc, b.origin, b);
    if (rec.invalid) { tally.invalid++; return { out: 'unusable' }; }
    return { out: 'ok', doc, rec, body: bodyOf(doc) };
  }
  const iso = () => new Date(now()).toISOString();
  const dropArchivedId = (origin, id) => { const led = ledgerFor(origin); const i = led.ids.findIndex(p => p[0] === id); if (i >= 0) led.ids.splice(i, 1); };
  /** Unusable documents in all blygs: this operation's ledgers, and the summaries of the others. */
  const badTotal = () => {
    let n = 0;
    for (const o of Object.keys(load().blygs)) n += ledgers.has(o) ? Object.keys(ledgers.get(o).bad).length : opCtx ? opCtx.bad.get(o) || 0 : 0;
    return n;
  };
  const badFull = led => Object.keys(led.bad).length >= LIMITS.badPerBlyg || badTotal() >= LIMITS.badTotal;
  /** A document the host could not give (404, 410, 403): asked for again after a back-off that doubles each time (not a mark against it). */
  function later(led, id) {
    const n = led.later[id] ? led.later[id][1] + 1 : 1;
    if (!led.later[id] && Object.keys(led.later).length >= LIMITS.laterPerBlyg) return;
    led.later[id] = [now() + backoffMs(n), Math.min(n, 63)];
  }
  /** A document that was served (2xx) and cannot be used is remembered with the version the index gave and when; see BACKFILL_MODES. */
  function markBad(p, e) {
    const led = p.led;
    if (led.bad[e.id] === undefined && badFull(led)) later(led, e.id);
    else led.bad[e.id] = [e.version, now()];
    if (badFull(led) && canMoveBackfill(led, 'pause_bad')) moveBackfill(led, 'pause_bad');
  }
  /** What one fetch's outcome leaves in its blyg's ledger and plan: the same for a fresh post, the backfill and the top-up. */
  function outcome(p, e, out) {
    if (out === 'stored' || out === 'kept') { delete p.led.later[e.id]; delete p.led.bad[e.id]; return; }
    if (out === 'unusable') return markBad(p, e);
    if (out === 'missing') later(p.led, e.id);
    p.left++;
  }
  /**
   * Why an edit of a post the owner had read may NOT return it to the Feed now ('' when it may): its last return was less than
   * editReturnGapMs ago; a mass edit; its blyg has editedPerBlyg edited posts unread; editReturnsPerRun returns in this refresh or
   * editReturnsPerDay in 24 hours (the ledger's `returns`, read in the same transaction that would add one). Never the unread
   * limits: at a limit the oldest unread posts step aside (makeRoom), as for a new post.
   */
  function editBlock(origin, held, cfg, g) {
    if (!g.returns) g.returns = new Map();
    if (held.returned_at && now() - held.returned_at < LIMITS.editReturnGapMs) return 'window';
    const led = ledgerOf(origin);
    led.changes = led.changes.filter(x => now() - x[0] < 24 * 3600e3);
    if (led.changes.length > LIMITS.massEditPerDay) return 'mass';
    if (itemsOf(origin).filter(i => i.read === 'edited').length >= LIMITS.editedPerBlyg) return 'edited';
    if ((g.returns.get(origin) || 0) >= LIMITS.editReturnsPerRun) return 'run';
    led.returns = led.returns.filter(x => now() - x[0] < 24 * 3600e3);
    if (led.returns.length >= LIMITS.editReturnsPerDay) return 'day';
    void cfg;
    return '';
  }
  const windowEnd = rec => (rec.returned_at || 0) + LIMITS.editReturnGapMs;
  /** What a refresh compares to see whether a post's record changed between its snapshot and its apply (the lost-update check). */
  const sigOf = held => (held ? [held.key, ARCHIVE_STATES.includes(held.read) ? 'archive' : held.read === 'older' ? 'older' : isWithdrawn(held) ? 'withdrawn' : 'feed', held.version, held.content_hash, held.archived_at || ''].join('|') : '-');

  /**
   * Put one fetched document in the list (no request: `got` was fetched before, outside the transaction). `sig` is what the post's
   * record was when the fetch was planned. → 'stored' | 'kept' | 'deferred'.
   * RE-CHECK (finding 1 of the gate review, the lost-update fix): if the record held NOW is not the one the fetch was planned from
   * (the owner ticked or unticked it meanwhile, or it was replaced), nothing is written and the post is counted as deferred: the
   * next refresh looks at it again. A change of its read state within the Feed (opened, a note) does not count: it is kept,
   * because everything written is worked out from the record as it is now.
   */
  function ingest(b, e, sig, got, bodyName, cfg, g, tally) {
    const ident = identOf(b.origin, e.id);
    const st = load();
    const held = st.items[ident];
    if (sigOf(held) !== sig) {
      // this very fetch was applied already, by an earlier attempt of this transaction (its body's name is unique to the fetch)
      if (held && bodyName && held.body === bodyName) {
        if (sig === '-') tally.new++;
        return 'stored';
      }
      tally.raced++; tally.deferred++; return 'deferred';
    }
    const { doc, rec, body } = got;
    if (held && rec.version < held.version) { tally.regressions++; return 'kept'; }
    if (doc.version !== e.version) tally.mismatched++;
    rec.body_state = body.state;
    const common = { index_version: e.version, fetched_at: now() };
    const mismatch = doc.version === e.version ? {} : { index_mismatch: { index: e.version, document: doc.version } };
    const archived = held && ARCHIVE_STATES.includes(held.read);
    if (isWithdrawn(rec)) {
      if (archived) { held.index_version = e.version; return 'kept'; }
      if (held && !isWithdrawn(held)) S.bodiesToDelete.push(bodyNameOf(held));
      st.items[ident] = { ...tombstone(held || { ...rec, key: randomKey(b.origin) }, rec), index_version: e.version }; tally.withdrawn++; return 'stored';
    }
    const change = changeOf(held, rec, cfg.following_barely_changed_percent);
    if (!held || isWithdrawn(held)) {
      st.items[ident] = { ...rec, ...common, key: (held && held.key) || randomKey(b.origin), read: 'new', identity: 'unverified', first_seen: iso(), maintenance: 0, last_change: 'new-words',
        words_version: rec.version, ...(e.awaits && rec.kind === 'fragment' ? { awaits: e.awaits, part: 'awaiting', awaits_until: now() + LIMITS.burstWaitMs } : {}), ...mismatch };
      tally.new++;
    } else if (held.read === 'older') {
      // the reading back brought an older post's text again (its blyg has room now): it is unread in the Feed as before
      if (!bodyName) { tally.deferred++; return 'deferred'; } // (its text could not be kept: it stays older, asked again later)
      const back = { ...rec, ...common, key: held.key, read: held.read, identity: 'unverified', first_seen: held.first_seen || iso(), maintenance: 0,
        last_change: 'new-words', words_version: rec.version, ...mismatch };
      moveRead(back, 'restore');
      st.items[ident] = back;
      tally.restored++;
    } else if (archived) {
      // THE EDIT RULE for a post the owner had read (see LIMITS): maintenance moves nothing; a change below the reader's threshold,
      // judged by the fingerprint of the words read, moves nothing; a real edit returns it to the Feed only within its bounds.
      if (change === 'maintenance') {
        if (held.read === 'archived_changed') { moveRead(held, 'revert'); delete held.newer; }
        Object.assign(held, { version: rec.version, ...common }); tally.maintenance++; return 'stored';
      }
      const pct = cfg.following_barely_changed_percent;
      if (isFingerprint(held.fp) && barelyByFingerprint(held.fp, fingerprintOf(textContent(body.html)), pct)) {
        if (held.read === 'archived_changed') { moveRead(held, 'revert'); delete held.newer; }
        Object.assign(held, { version: rec.version, ...common }); tally.minor++; return 'stored';
      }
      if (held.read === 'archived') {
        const l = ledgerFor(b.origin);
        if (!l.changes.some(x => x[1] === e.id)) l.changes.push([now(), e.id]); // (a post counts once in the 24 hours)
        if (l.changes.length > 50) l.changes.splice(0, l.changes.length - 50);
      }
      const why = editBlock(b.origin, held, cfg, g);
      if (why) {
        moveRead(held, 'hold');
        held.newer = { version: rec.version, hash: rec.content_hash, at: now() };
        held.index_version = e.version;
        tally.held++;
        return 'stored';
      }
      if (!bodyName) { tally.deferred++; return 'deferred'; } // (its text could not be kept: it stays in the Archive, asked again next run)
      const back = { ...rec, ...common, key: held.key, body: bodyName, read: held.read, identity: 'unverified', first_seen: iso(), last_change: 'new-words', maintenance: 0, words_version: rec.version,
        read_version: held.version, returned_at: now(), ...mismatch };
      if (held.read === 'archived_changed') tally.released++;
      moveRead(back, held.read === 'archived' ? 'edit' : 'release');
      st.items[ident] = back;
      g.returns.set(b.origin, (g.returns.get(b.origin) || 0) + 1);
      // (once per post: a post returns at most once in editReturnGapMs, so a second entry for it would be this same return again)
      const lr = ledgerFor(b.origin).returns;
      if (!lr.some(x => x[1] === e.id)) lr.push([now(), e.id]);
      tally.edited++;
    } else {
      const next = { ...held, ...rec, ...common, key: held.key, read: held.read, identity: held.identity, first_seen: held.first_seen, last_change: change,
        words_version: change === 'maintenance' ? (held.words_version ?? held.version) : rec.version,
        maintenance: (held.maintenance || 0) + (change === 'maintenance' ? 1 : 0) };
      if (doc.version === e.version) delete next.index_mismatch; else next.index_mismatch = { index: e.version, document: doc.version };
      st.items[ident] = next;
      if (change === 'maintenance') tally.maintenance++;
      else if (change === 'minor') tally.minor++;
      else { if (canMoveRead(next, 'resurface')) moveRead(next, 'resurface'); else if (canMoveRead(next, 'edit')) moveRead(next, 'edit'); tally.edited++; }
    }
    // the newest date the Hub has seen from this blyg, clamped to now: what decides "fresh" next time
    const seen = stamp(st.items[ident].created, now());
    if (seen > 0) { const led = ledgerFor(b.origin); led.seen_until = Math.max(led.seen_until || 0, seen); }
    // the body: the one written before this transaction, when the words changed or none was held
    const cur = st.items[ident];
    const hadBody = held && !isWithdrawn(held) && !TEXTLESS_STATES.includes(held.read) && (held.body || held.key);
    if (bodyName && (change !== 'maintenance' || !hadBody || held.body_state === 'none')) {
      if (hadBody && bodyNameOf(held) !== bodyName) S.bodiesToDelete.push(bodyNameOf(held));
      cur.body = bodyName;
    } else if (held && held.body) cur.body = held.body;
    return 'stored';
  }

  // ---- a refresh, blyg by blyg: the network first, then a short transaction ----
  /** One blyg's manifest and index. Nothing is written. → the head: what the blyg's record and plan are made from. */
  async function fetchHead(b, g) {
    const man = await fetchJson(g, new URL('blyg.json', b.origin).href, LIMITS.manifestBytes);
    if (man.status === 'trouble') return { kind: 'trouble', r: man };
    if (man.status !== 'ok' || !isManifest(man.json) || identityOf(man.url) !== b.origin) return { kind: 'absent', message: 'it has no manifest at its origin' };
    const title = cleanText(man.json.title, 200);
    let templateRefused = false;
    const t0 = typeof man.json.item === 'string' ? cleanText(man.json.item, 300) : '';
    let template = t0;
    if (t0 && !within(b.origin, itemUrlFor({ item: t0 }, b.origin, '0'.repeat(26)))) { template = ''; templateRefused = true; }
    const author = cleanText(man.json.author && man.json.author.name, 200);
    let indexUrl;
    try { indexUrl = new URL(typeof man.json.items === 'string' && man.json.items ? man.json.items : 'items/index.json', b.origin).href; } catch { indexUrl = ''; }
    const base = { title, template, templateRefused, author };
    if (!isWebUrl(indexUrl)) return { kind: 'absent', message: 'its items index is not a web address', base };
    if (!within(b.origin, indexUrl)) return { kind: 'refused', error: REFUSALS.index, base };
    const idx = await fetchJson(g, indexUrl, LIMITS.indexBytes);
    if (idx.status === 'trouble') return { kind: 'trouble', r: idx, base };
    if (idx.status === 'ok' && !within(b.origin, idx.url)) return { kind: 'refused', error: REFUSALS.redirect, base };
    if (idx.status !== 'ok' || !Array.isArray(idx.json.items)) return { kind: 'absent', message: 'it has no items index', base };
    // What is read out of the index (hostile input): at most `indexEntries` entries, a well-formed id, a kind and a version this code
    // knows; an id listed twice is ONE post, at its highest version. Only these are kept, for the run.
    const raw = idx.json.items;
    const byId = new Map();
    for (const x of raw.slice(0, LIMITS.indexEntries)) {
      if (x && typeof x.id === 'string' && ID_RE.test(x.id) && KINDS.includes(x.kind) && Number.isInteger(x.version) && x.version >= 1) {
        const prev = byId.get(x.id);
        if (!prev || x.version > prev.version) byId.set(x.id, { id: x.id, kind: x.kind, version: x.version, created: cleanText(x.created, 40), updated: cleanText(x.updated, 40) });
      }
    }
    return { kind: 'ok', base, entries: [...byId.values()], whole: raw.length <= LIMITS.indexEntries, readAt: now() };
  }
  /** What a blyg's head says about its record (title, template, reachable or not), applied to the record held now. */
  function applyHead(b, head, tally, at = now()) {
    b.last_try = at;
    if (head.base && head.kind !== 'trouble') {
      b.title = head.base.title || b.title;
      b.item_template = head.base.template;
      if (head.base.templateRefused) tally.refused++;
      b.author = head.base.author || b.author;
    }
    if (head.kind === 'trouble') {
      if (NOT_THE_BLYGS_FAULT.includes(head.r.kind)) { tally.deferred++; return; }
      noteFailure(b, 'trouble', head.r.message); tally.unreachable++; return;
    }
    if (head.kind === 'absent') { noteFailure(b, 'absent', head.message); tally.absent++; return; }
    if (head.kind === 'refused') { b.last_error = head.error; tally.refused++; return; }
    if (canMoveBlyg(b, 'recover')) moveBlyg(b, 'recover');
    b.failures = 0; b.absent_runs = 0; b.retry_after = 0; b.last_error = head.base.templateRefused ? REFUSALS.item : ''; b.last_ok = at;
  }
  /**
   * What one refresh learned about a blyg's RECORD in the main document (its head, an item's refusal, when it was read back), kept
   * aside and put in the main document every LIMITS.mainEvery blygs and at the end of the refresh (flushRecords): re-applied on
   * the record as stored then (a pause the owner made meanwhile stands: applyHead moves the state only by its table).
   */
  const recordNote = (o, epoch, { head = null, error = '', last_backfill = 0 } = {}) => ({ o, epoch, head, error, last_backfill, at: now() });
  function replayRecord(b, n) {
    if (n.head) applyHead(b, n.head, newTally(), n.at);
    if (n.error) b.last_error = n.error;
    if (n.last_backfill) b.last_backfill = n.last_backfill;
  }
  const flushRecords = notes => (notes.length ? tx({}, () => {
    const st = load();
    for (const n of notes) { const b = st.blygs[n.o]; if (b && b.epoch === n.epoch) replayRecord(b, n); }
  }) : Promise.resolve())
  /**
   * The index against what is held (a pure step on the operation's copy, made on the snapshot to plan the fetches and again in
   * the apply on what is stored then): drops what the index no longer lists, marks withdrawals, and sorts every entry into what
   * to fetch. → { led, updates, fresh, archived, backfill, left, paused, waiting }.
   */
  function indexPass(b, head, cfg) {
    const st = load();
    const led = ledgerFor(b.origin);
    const readAt = head.readAt;
    const clampT = v => { const t = Date.parse(v); return Number.isFinite(t) && t > 0 ? Math.min(t, readAt) : 0; };
    const entries = head.entries.map(e => ({ ...e, t: Math.max(clampT(e.updated), clampT(e.created)) }))
      .sort((a, c) => c.t - a.t || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
    const inIndex = new Set(entries.map(e => e.id));
    const byId = new Map(entries.map(e => [e.id, e]));
    const archivedIds = new Set(led.ids.map(p => p[0]));
    if (head.whole) {
      for (const i of itemsOf(b.origin)) if (!ARCHIVE_STATES.includes(i.read) && !inIndex.has(i.id)) { if (isUnreadHeld(i)) S.bodiesToDelete.push(bodyNameOf(i)); delete st.items[identOf(i.origin, i.id)]; head.tally.removed++; }
      for (const k of ['bad', 'later']) for (const id of Object.keys(led[k])) if (!inIndex.has(id)) delete led[k][id];
    }
    for (const [id, [, at]] of Object.entries(led.bad)) if (now() - at >= LIMITS.badExpiryMs) delete led.bad[id];
    for (const p of led.ids) if (!p[1] && byId.has(p[0])) { const c = Date.parse(byId.get(p[0]).created); if (Number.isFinite(c) && c > 0 && c <= now()) p[1] = c; }
    const goneSet = goneTest(led);
    const paused = led.backfill === 'paused_bad_documents';
    // FRESH or BACKFILL is decided from dates the Hub stored itself (the blyg's seen-until), never from the index's order (finding 6)
    led.seen_until = Math.max(led.seen_until || 0, ...itemsOf(b.origin).map(i => stamp(i.created, i.fetched_at)).filter(t => t > 0), 0);
    const isFresh = e => { const c = Date.parse(e.created); return led.seen_until > 0 && Number.isFinite(c) && c > led.seen_until && c <= readAt + LIMITS.skewMs; };
    const plan = { b, led, updates: [], fresh: [], archived: [], backfill: [], restore: [], left: 0 };
    const marks = threadMarks(entries.filter(e => e.kind === 'thread' && !st.items[identOf(b.origin, e.id)] && !archivedIds.has(e.id)));
    const awaitsOf = e => { const t = nearThreads(marks, Date.parse(e.created))[0]; return t ? t.id : ''; };
    for (const e of entries) {
      const ident = identOf(b.origin, e.id);
      const held = st.items[ident];
      if (!held) {
        if (e.kind === 'withdrawn' || archivedIds.has(e.id) || goneSet(e.id) || (led.bad[e.id] && led.bad[e.id][0] === e.version)) continue;
        if (led.later[e.id] && led.later[e.id][0] > now()) { plan.left++; continue; }
        if (e.kind === 'fragment') { const t = awaitsOf(e); if (t) e.awaits = t; }
        if (!isFresh(e)) { if (paused) plan.left++; else plan.backfill.push(e); continue; }
        plan.fresh.push(e);
        continue;
      }
      const was = held.index_version ?? held.version;
      if (held.read === 'older' && e.kind !== 'withdrawn') {
        // stepped aside: never fetched as an update (it keeps no text); the reading back brings it again, before anything older
        if (e.version > was) held.index_version = e.version;
        plan.restore.push({ ...e, sig: sigOf(held) });
        continue;
      }
      if (held.read === 'archived_changed' && e.kind !== 'withdrawn') {
        if (now() < windowEnd(held)) { if (e.version > was) held.index_version = e.version; continue; }
        if (e.version >= was) { plan.archived.push({ e, sig: sigOf(held), read: held.read, hash: held.content_hash }); continue; }
      }
      if (e.version === was && (e.kind === 'withdrawn') === isWithdrawn(held)) continue;
      if (e.version < was) { head.tally.regressions++; continue; }
      if (e.kind === 'withdrawn') {
        if (ARCHIVE_STATES.includes(held.read)) { held.index_version = e.version; continue; }
        if (!isWithdrawn(held)) { S.bodiesToDelete.push(bodyNameOf(held)); head.tally.withdrawn++; }
        st.items[ident] = tombstone(held, e);
        continue;
      }
      if (ARCHIVE_STATES.includes(held.read)) { plan.archived.push({ e, sig: sigOf(held), read: held.read, hash: held.content_hash }); continue; }
      plan.updates.push({ e, sig: sigOf(held), hash: held.content_hash });
    }
    plan.fresh = burstOrder(plan.fresh.reverse());
    // reading back: the posts that stepped aside first (newest first), then what was never fetched (newest first)
    plan.backfill = [...plan.restore, ...burstOrder(plan.backfill)];
    plan.waiting = led.fresh === 'failing' && now() < (led.fresh_after || 0);
    void cfg;
    return plan;
  }
  // a cache: when the owner last moved each post in this process (tick, untick, mark read...), so a refresh running here does not
  // ask for (or keep the text of) a post it planned before that move. The transaction's re-check is what guarantees it everywhere.
  // (a sequence number, not a time: a tick and the next refresh may share a millisecond)
  const touchedHere = new Map();
  let touchSeq = 0;
  const touch = rec => { touchedHere.set(identOf(rec.origin, rec.id), ++touchSeq); if (touchedHere.size > 5000) touchedHere.delete(touchedHere.keys().next().value); };
  // (`capped`: posts the READING BACK did not fetch because a blyg, or the Hub, is at its unread limit; a new post is never counted
  // there: it is never held back by a limit. `waiting`: blygs whose new posts wait for the next refresh; `stepped_aside`: posts
  // stepped aside to make room; `restored`: older posts read back with their text.)
  const newTally = (reason = '') => ({ reason, new: 0, edited: 0, minor: 0, maintenance: 0, withdrawn: 0, removed: 0, regressions: 0, capped: 0, deferred: 0,
    errors: 0, invalid: 0, missing: 0, absent: 0, unreachable: 0, refused: 0, mismatched: 0, aborted: 0, raced: 0, held: 0, released: 0, fresh_failing: 0, blygs: 0, skipped: 0, requests: 0, backfilled: 0,
    stepped_aside: 0, restored: 0, waiting: 0 });
  const addTally = (into, from) => { for (const [k, v] of Object.entries(from)) if (typeof v === 'number') into[k] = (into[k] || 0) + v; };
  // (the stars too: making room at a limit reads them, and an apply that had to read them part-way would run again)
  const blygWants = o => ({ feeds: [o], archives: [o], ledgers: [o], stars: true });
  /** `mutate` run as a transaction's body with the run's edit-return counts as they were before it: an attempt run again (a
   * conflict, or a document it had to read first) counts each return once. */
  const onceReturns = (g, mutate) => { const before = new Map(g.returns || []); return () => { g.returns = new Map(before); return mutate(); }; };
  /** Fetch one post (budget and checks: pull) and keep its text in the store, before any record names it. → a result for ingest. */
  async function fetchOne(b, e, sig, phase, g, tally, heldHash = null, since = 0) {
    // (a blyg unfollowed meanwhile, here or anywhere, is seen by the apply, through its epoch: what was fetched is not kept)
    const moved = () => sig !== '-' && (touchedHere.get(identOf(b.origin, e.id)) || 0) > since;
    if (moved()) { tally.raced++; tally.deferred++; return { e, sig, got: { out: 'raced' }, bodyName: '', phase }; }
    const got = await pull(b, e.id, g, tally);
    if (moved()) { tally.raced++; tally.deferred++; return { e, sig, got: { out: 'raced' }, bodyName: '', phase }; }
    let bodyName = '';
    if (got.out === 'ok' && !isWithdrawn(got.rec) && !(heldHash && heldHash === got.rec.content_hash)) {
      // (a text the store refuses is not kept: a new post then shows its excerpt; an edit waits for the next refresh)
      try { bodyName = await putBody(randomKey(b.origin), got.body.html); } catch (e) { if (e && e.code === 'ECRASH') throw e; console.warn(`[following] a post's text was not kept: ${cleanText(String(e && e.message), 120)}`); }
    }
    return { e, sig, got, bodyName, phase };
  }
  /** Apply what was fetched for a blyg: what an index says, then each result, then (`finish`) its queue, backfill mode and parts. */
  function applyResults(o, epoch, head, results, cfg, g, t, { finish = null, last_backfill = 0, freshLeft = 0 } = {}) {
    const st = load();
    const held = st.blygs[o];
    if (!held || held.epoch !== epoch) { t.aborted += results.length || 1; return null; } // unfollowed (or followed again) meanwhile
    // the record as this apply sees it: what changes in it goes to the main document later (recordNote), not in this commit
    const b = { ...held };
    const note = recordNote(o, epoch, { head: finish ? null : head, last_backfill });
    head.tally = t;
    if (!finish) applyHead(b, head, t, note.at);
    if (head.kind !== 'ok') return { left: 0, note };
    const plan = finish ? { b, led: ledgerFor(o), left: 0 } : indexPass(b, head, cfg);
    let freshOk = false, freshFails = 0;
    for (const r of results) {
      const out = r.got.out !== 'ok' ? (r.got.error && (b.last_error = note.error = r.got.error), r.got.out)
        : ingest(b, r.e, r.sig, r.got, r.bodyName, cfg, g, t);
      if (r.phase === 'fresh' || r.phase === 'backfill' || r.phase === 'topup') outcome(plan, r.e, out);
      if (r.phase === 'fresh') { if (['missing', 'unusable', 'host_trouble'].includes(out)) freshFails++; if (out === 'stored') freshOk = true; }
      if (r.phase === 'backfill' && out === 'stored') t.backfilled++;
    }
    if (!finish) {
      const led = plan.led;
      if (freshOk && led.fresh === 'failing') { moveFresh(led, 'recover'); led.fresh_failures = 0; led.fresh_after = 0; }
      else if (!freshOk && freshFails >= LIMITS.freshFailuresPerRun) {
        moveFresh(led, 'fail');
        led.fresh_failures = Math.min((led.fresh_failures || 0) + 1, 63);
        led.fresh_after = now() + backoffMs(led.fresh_failures);
        t.fresh_failing++;
      }
      // new posts this refresh found and did not fetch (its time, requests, this blyg's share, a failing back-off): said on the page
      moveHold(led, freshLeft > 0 ? 'hold' : 'clear');
      if (freshLeft > 0) t.waiting++;
      t.stepped_aside += makeRoom(o, cfg);
      trimOlder(o);
      return { left: plan.left, note };
    }
    // the end of a refresh for this blyg: what is left of its backfill, in order, is the queue a top-up reads until the next refresh
    const led = plan.led;
    // (its posts that stepped aside are first, newest first, as they are NOW: this very refresh may have moved some after its plan)
    const olderNow = itemsOf(o).filter(i => i.read === 'older').sort((a, c) => oldestFirst(c, a))
      .map(i => ({ id: i.id, kind: i.kind, version: i.index_version ?? i.version, created: i.created, updated: i.updated }));
    const ahead = new Set(olderNow.map(e => e.id));
    const rest = [...olderNow, ...finish.rest.filter(e => !ahead.has(e.id) && !(load().items[identOf(o, e.id)] && load().items[identOf(o, e.id)].read !== 'older'))];
    led.queue = rest.slice(0, LIMITS.queuePerBlyg).map(e => ({ id: e.id, kind: e.kind, version: e.version, created: e.created, updated: e.updated, ...(e.awaits ? { awaits: e.awaits } : {}) }));
    if (led.backfill === 'paused_bad_documents') { if (!badFull(led)) moveBackfill(led, 'recover'); }
    else moveBackfill(led, rest.length + finish.left + plan.left > 0 ? 'remain' : 'finish');
    settleParts(o);
    trimArchive(o);
    t.stepped_aside += makeRoom(o, cfg);
    trimOlder(o);
    return { left: plan.left, note };
  }
  /** One blyg of a refresh: its head, a snapshot plan, the fetches, one apply. → what the backfill needs, or null. */
  async function refreshBlyg(o, run) {
    const { g, cfg, tally } = run;
    const docs = run.docs; // (one map for the whole refresh: what one blyg's apply wrote, the next one's starts from)
    const b0 = await tx({}, () => copy(load().blygs[o]), { write: false, docs });
    if (!b0 || !due(b0)) return null;
    const head = await fetchHead(b0, g);
    // the plan, on a snapshot (nothing written): what to fetch
    const snapT = newTally();
    head.tally = snapT;
    const snap = await tx(blygWants(o), () => {
      const b = load().blygs[o];
      if (!b || b.epoch !== b0.epoch) return null;
      applyHead(b, head, snapT);
      if (head.kind !== 'ok') return { b: copy(b), plan: null };
      const plan = indexPass(b, head, cfg);
      return { b: copy(b), plan, block: editBlock(o, {}, cfg, g), unread: unreadOf(o), total: totalItems(), mode: plan.led.backfill };
    }, { write: false, docs });
    if (!snap) { tally.aborted++; return null; }
    const results = [];
    let left = 0;
    const b = snap.b;
    if (snap.plan) {
      const p = snap.plan;
      let docsN = 0, added = 0;
      for (const u of p.updates) {
        if (docsN >= LIMITS.docsPerBlygRun || g.budget.spent()) { tally.deferred++; continue; }
        docsN++;
        results.push(await fetchOne(b, u.e, u.sig, 'update', g, tally, u.hash, run.started));
      }
      const share = Math.min(LIMITS.docsPerBlygRun, Math.max(LIMITS.freshShareMin, Math.floor(g.budget.cap / Math.max(1, g.due || 1))));
      let freshDocs = 0, freshFails = 0;
      // A NEW post is never held back by the limits: at a limit the oldest unread posts step aside (makeRoom, in the apply). What
      // waits here (the run's time or requests, this blyg's share, its failing back-off) is counted in `left` and said on the page.
      for (const e of p.fresh) {
        if (p.waiting || freshDocs >= share || freshFails >= LIMITS.freshFailuresPerRun) { tally.deferred++; left++; continue; }
        if (docsN >= LIMITS.docsPerBlygRun || g.budget.spent()) { tally.deferred++; left++; continue; }
        docsN++; freshDocs++;
        const r = await fetchOne(b, e, '-', 'fresh', g, tally);
        results.push(r);
        if (['missing', 'unusable', 'host_trouble'].includes(r.got.out)) freshFails++;
        if (r.got.out === 'ok') added++;
      }
      // the documents of posts the owner had read whose index entry moved: at most archivedDocsPerRun, and none while no edit of this
      // blyg could return now (still fetched during a mass edit or with editedPerBlyg edited unread, to be held as "edited again")
      let archivedDocs = 0;
      const holdOnly = snap.block === 'mass' || snap.block === 'edited';
      for (const a of p.archived) {
        if (archivedDocs >= LIMITS.archivedDocsPerRun || (snap.block && !holdOnly) || (snap.block && a.read === 'archived_changed') || docsN >= LIMITS.docsPerBlygRun || g.budget.spent()) { tally.deferred++; continue; }
        archivedDocs++; docsN++;
        results.push(await fetchOne(b, a.e, a.sig, 'archived', g, tally, a.hash, run.started));
      }
      run.backfillPlans.push({ o, epoch: b0.epoch, b, head, backfill: p.backfill, mode: snap.mode, docs: docsN, unread: snap.unread + added, results: [], left: 0, last_backfill: b.last_backfill || 0, lastBackfill: 0 });
      run.total += added;
    }
    const t = newTally();
    const applied = await tx(blygWants(o), onceReturns(g, () => {
      const x = newTally(); const r = applyResults(o, b0.epoch, head, results, cfg, g, x, { freshLeft: left }); Object.assign(t, x);
      return r && { ...r, mine: copy(itemsOf(o).filter(i => !ARCHIVE_STATES.includes(i.read))) };
    }), { docs });
    if (applied && applied.mine) {
      run.items = [...run.items.filter(i => i.origin !== o), ...applied.mine]; run.unread = feedCountOf(run);
      // (what this blyg holds unread now, for the next applies' total: a post stepped aside here is not counted there)
      if (opCtx) opCtx.unread.set(o, applied.mine.filter(isUnreadHeld).length);
    }
    if (applied && applied.note) run.notes.push(applied.note);
    addTally(tally, t);
    const bp = run.backfillPlans.find(x => x.o === o);
    if (bp) bp.left = (applied ? applied.left : 0) + left;
    return applied;
  }
  /**
   * The backfill: while the Feed holds fewer than `following_unread_target` unread posts, fetch the posts the blygs' indexes list
   * that are neither held, read, withdrawn nor unusable (and, first, a blyg's posts that stepped aside: their text again). Round-robin over the blygs (the one backfilled longest ago first), ONE post
   * per blyg per round, each blyg newest first, a burst's thread before its parts. Network only: what is fetched is applied per blyg
   * after (finishBlyg).
   */
  async function backfillRun(run) {
    const { g, cfg, tally } = run;
    const turn = run.backfillPlans.filter(p => p.mode !== 'paused_bad_documents' && p.backfill.length).sort((a, c) => (a.last_backfill || 0) - (c.last_backfill || 0));
    let moved = true;
    rounds: while (moved && run.unread < cfg.following_unread_target && !g.budget.spent()) {
      moved = false;
      for (const p of turn) {
        if (run.unread >= cfg.following_unread_target || g.budget.spent()) break rounds;
        if (!p.backfill.length || p.docs >= LIMITS.docsPerBlygRun) continue;
        if (run.total >= cfg.following_max_items_total) break rounds;
        if (p.unread >= cfg.following_max_items_per_blyg) continue;
        const e = p.backfill.shift();
        p.lastBackfill = now();
        p.docs++;
        moved = true;
        const r = await fetchOne(p.b, e, e.sig || '-', 'backfill', g, tally, null, run.started);
        p.results.push(r);
        if (r.got.out === 'ok' && !isWithdrawn(r.got.rec)) {
          run.total++; p.unread++;
          // what the Feed will count: as ingest will hold it (a part whose thread is not held yet waits in Background)
          run.items.push({ ...r.got.rec, key: `est${run.items.length}`, read: 'new', fetched_at: now(), last_change: 'new-words',
            ...(e.awaits && r.got.rec.kind === 'fragment' ? { awaits: e.awaits, part: 'awaiting' } : {}) });
          run.unread = feedCountOf(run);
        }
      }
    }
    for (const p of turn) {
      if (!p.backfill.length) continue;
      if (p.unread >= cfg.following_max_items_per_blyg || run.total >= cfg.following_max_items_total) tally.capped += p.backfill.length;
      else if (run.unread < cfg.following_unread_target) tally.deferred += p.backfill.length;
    }
  }
  /** The Feed's count (as its tab says: bursts folded, Background left out) of a refresh's picture of every blyg's posts. */
  const feedCountOf = run => {
    const items = run.items.map(i => (i.part === 'awaiting' && run.items.some(t => t.origin === i.origin && t.id === i.awaits) ? { ...i, part: 'folded' } : i));
    return buildView({ items, blygs: run.blygs, now: now() }).tabs.feed;
  };
  /** Each burst part of `origin` still awaiting its thread: folded once the thread is held, standing alone once its wait is over. */
  function settleParts(origin) {
    const st = load();
    for (const i of itemsOf(origin)) {
      if (i.part !== 'awaiting') continue;
      if (st.items[identOf(i.origin, i.awaits)]) movePart(i, 'thread_held');
      else if (now() >= (i.awaits_until || 0)) movePart(i, 'wait_over', now());
    }
  }

  // ---- the mentions inbox ----
  function syncInbox(cfg) {
    const box = load().inbox;
    if (!cfg.inbox_api_url) { if (box.state !== 'off') moveInbox(box, 'unset'); return box; }
    if (box.state === 'off') moveInbox(box, 'set');
    if (!mayFetch()) { if (box.state !== 'paused') moveInbox(box, 'pause'); }
    else if (box.state === 'paused') moveInbox(box, 'set');
    return box;
  }
  /** Ask the inbox (network), then put what it said in the inbox document (one transaction; nothing written if it changed meanwhile). */
  async function refreshInbox(g, cfg) {
    const url = cfg.inbox_api_url;
    const pre = await tx({ inbox: true }, () => { const box = syncInbox(cfg); if (!url) box.mentions = []; return box.state; });
    if (!url || pre === 'paused') return;
    let token, denied = null;
    try { token = readToken(cfg.inbox_token_file, tokenForbidden); } catch (e) { denied = e; }
    let r, thrown = null;
    if (!denied) { try { r = await g(url, { maxBytes: LIMITS.inboxBytes, accept: 'application/json', headers: { authorization: `Bearer ${token}` } }); } catch (e) { thrown = e; } }
    const redact = token ? redactor(token) : x => x;
    let parsed = null, verdict = null;
    if (denied) verdict = ['deny', cleanText(String(denied && denied.message), 200)];
    else if (thrown) {
      if (thrown && (thrown.kind === 'limit' || thrown.kind === 'breaker' || thrown.kind === 'off')) verdict = ['none'];
      else verdict = ['fail', cleanText(redact(String((thrown && thrown.message) || 'could not fetch')), 200)];
    } else {
      let sameOrigin = false;
      try { sameOrigin = new URL(String(r.url || url)).origin === new URL(url).origin; } catch { sameOrigin = false; }
      const code = Number(r.status) || 0;
      if (!sameOrigin) verdict = ['fail', 'the inbox answered from another origin than the one set'];
      else if (code === 401 || code === 403) verdict = ['deny', `the inbox answered ${code}`];
      else if (code < 200 || code >= 300) verdict = ['fail', `the inbox answered ${code}`];
      else {
        try {
          const json = JSON.parse(String(r.text ?? ''));
          if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
          parsed = parseInbox(scrubDeep(json, token), redact, LIMITS.mentionsKept);
          verdict = ['succeed'];
        } catch { verdict = ['garble', 'the inbox did not answer with a JSON object this code can read']; }
      }
    }
    await tx({ inbox: true }, () => {
      // the inbox as the settings say NOW: unset, paused or set to another address meanwhile, this answer is about another inbox
      // and nothing of it is written (the inbox's own state follows the settings)
      const box = syncInbox(settings());
      if (box.state === 'off' || box.state === 'paused' || settings().inbox_api_url !== url) return;
      box.fetched_at = now();
      if (verdict[0] === 'none') return;
      if (verdict[0] !== 'succeed') { moveInbox(box, verdict[0]); box.error = verdict[1]; return; }
      const old = new Map(box.mentions.map(m => [m.ident, m]));
      box.mentions = parsed.mentions.map(m => { const o = old.get(m.ident); return { ...m, key: o ? o.key : randomKey(''), read: o ? o.read : 'unseen' }; });
      Object.assign(box, { generated_at: parsed.generated_at, count: parsed.count, never_verified: parsed.never_verified,
        never_verified_count: parsed.never_verified_count, blocked_count: parsed.blocked_count, error: '' });
      moveInbox(box, 'succeed');
    });
  }

  /**
   * Refresh every blyg that is due, and the inbox. At most ONE refresh or top-up at a time in all invocations: the run lease in the
   * store (RUN_STATES). A second ask while one is going is refused, not queued.
   */
  async function refresh({ reason = 'demand' } = {}) {
    if (!mayFetch()) { await tx({ inbox: true }, () => { syncInbox(settings()); }); return { started: false, reason: 'fetching is off (blyg_checks), so nothing was asked' }; }
    const cfg = settings();
    const holder = crypto.randomBytes(8).toString('hex');
    const leaseMs = cfg.following_run_seconds * 1000 + LIMITS.leaseMarginMs;
    const took = await takeLease('refresh', holder, leaseMs);
    if (!took.ok) return { started: false, reason: took.reason };
    const budget = newBudget(cfg, now);
    const g = getter(budget); g.budget = budget; g.returns = new Map(); // (edit-returns per blyg in this refresh)
    const tally = newTally(reason);
    const run = { g, cfg, tally, backfillPlans: [], unread: 0, total: 0, docs: new Map(), started: touchSeq, items: [], blygs: {}, notes: [] };
    // what the refresh learned about the blygs' records: into the main document every LIMITS.mainEvery blygs (a crash loses at most
    // that many blygs' last-tried times and failure counts: they are tried again first), and at the end
    const flush = async (all = false) => {
      if (!all && run.notes.length < LIMITS.mainEvery) return;
      const notes = run.notes.splice(0);
      try { await flushRecords(notes); } catch (e) { tally.errors++; console.warn(`[following] ${cleanText(String(e && e.message), 200)}`); }
    };
    try {
      // what is followed, and how much each blyg holds: the main document and every feed (no ledger, no archive)
      const snap0 = await tx({ allFeeds: true }, () => {
        syncBreakers();
        const st = load();
        const todo = Object.values(st.blygs).filter(due).sort((a, b) => (a.last_try || 0) - (b.last_try || 0)).map(b => b.origin);
        return { todo, items: copy(Object.values(st.items)), blygs: copy(st.blygs), followed: Object.keys(st.blygs).length, unread: Object.keys(st.blygs).map(o => [o, unreadOf(o)]), bad: Object.keys(st.blygs).map(o => [o, summaryOf(o).bad]),
          feed: unreadCount(), total: totalItems() };
      }, { write: false, docs: run.docs });
      g.due = snap0.todo.length;
      tally.skipped = snap0.followed - snap0.todo.length;
      opCtx = { unread: new Map(snap0.unread), bad: new Map(snap0.bad) };
      run.unread = snap0.feed; run.total = snap0.total; run.items = snap0.items; run.blygs = snap0.blygs;
      let renewAt = now() + leaseMs / 2;
      // While the Feed is short of its target, a share of the run's requests is kept for reading back: with many blygs the
      // manifests and indexes alone could take every request, every run, and nothing would ever be read back. The blygs not
      // reached this run are the first next time (they are taken longest-tried first).
      const reserve = run.unread < cfg.following_unread_target ? Math.floor(budget.cap * LIMITS.backfillShare) : 0;
      for (const o of snap0.todo) {
        if (budget.spent() || budget.requests + 2 > budget.cap - reserve) { tally.deferred++; continue; }
        try { await refreshBlyg(o, run); tally.blygs++; }
        catch (e) { tally.errors++; console.warn(`[following] ${cleanText(String(e && e.message), 200)}`); }
        await flush();
        if (now() >= renewAt) { if (!(await renewLease(holder, leaseMs))) break; renewAt = now() + leaseMs / 2; }
      }
      try { await backfillRun(run); } catch (e) { tally.errors++; console.warn(`[following] ${cleanText(String(e && e.message), 200)}`); }
      for (const p of run.backfillPlans) {
        try {
          const t = newTally();
          const r = await tx(blygWants(p.o), onceReturns(g, () => { const x = newTally(); const a = applyResults(p.o, p.epoch, p.head, p.results, cfg, g, x, { finish: { rest: p.backfill, left: p.left }, last_backfill: p.lastBackfill }); Object.assign(t, x); return a; }), { docs: run.docs });
          if (r && r.note && (r.note.error || r.note.last_backfill)) run.notes.push(r.note);
          addTally(tally, t);
        } catch (e) { tally.errors++; console.warn(`[following] ${cleanText(String(e && e.message), 200)}`); }
      }
      try { await refreshInbox(getter(newBudget({ following_run_requests: 3, following_run_seconds: 30 }, now)), cfg); } catch (e) { tally.errors++; console.warn(`[following] inbox: ${cleanText(String(e && e.message), 200)}`); }
      tally.requests = budget.requests;
      // the records' notes left, and the run's tally: one write of the main document
      const notes = run.notes.splice(0);
      await tx({}, () => { const st = load(); for (const n of notes) { const b = st.blygs[n.o]; if (b && b.epoch === n.epoch) replayRecord(b, n); } st.last_run = { ...tally, at: new Date(now()).toISOString() }; });
      try { await sweep(); } catch (e) { console.warn(`[following] sweep: ${cleanText(String(e && e.message), 200)}`); }
    } finally {
      opCtx = null;
      try { await releaseLease(holder, 'refresh'); } catch (e) { console.warn(`[following] the run lease: ${cleanText(String(e && e.message), 200)}`); }
    }
    onChange();
    return { started: true, ...tally };
  }

  // ---- the top-up ----
  /**
   * After a tick leaves the Feed below its target: fetch the next posts from the blygs' saved QUEUES (what the last refresh left of
   * each backfill), round-robin, one per blyg per round, until the target is met. No manifest and no index is read, at most
   * topupRequests requests, and at most one top-up every topupGapMs (the gap and the lease are in the store's run document). Each
   * entry is checked again before it is fetched (held, read, in the gone filter, unusable or waiting: skipped).
   */
  async function topUp() {
    if (!mayFetch()) return { started: false, reason: 'fetching is off (blyg_checks), so nothing was asked' };
    const holder = crypto.randomBytes(8).toString('hex');
    const took = await takeLease('topup', holder, LIMITS.topupSeconds * 1000 + LIMITS.leaseMarginMs);
    if (!took.ok) return { started: false, reason: took.reason };
    const cfg = settings();
    const budget = newBudget({ following_run_requests: LIMITS.topupRequests, following_run_seconds: LIMITS.topupSeconds }, now);
    const g = getter(budget); g.budget = budget; g.returns = new Map();
    const tally = newTally('topup');
    const started = touchSeq; // (a post the owner moved in this process after this point is not fetched for: fetchOne)
    try {
      const snap = await tx({ allFeeds: true }, () => {
        syncBreakers();
        const st = load();
        const turn = Object.values(st.blygs).filter(b => { const s = summaryOf(b.origin); return b.state === 'active' && ['unknown', 'more'].includes(s.backfill) && s.queue > 0; })
          .sort((a, c) => (a.last_backfill || 0) - (c.last_backfill || 0)).slice(0, LIMITS.topupRequests).map(b => ({ o: b.origin, epoch: b.epoch, b: copy(b) }));
        return { turn, unread: Object.keys(st.blygs).map(o => [o, unreadOf(o)]), bad: Object.keys(st.blygs).map(o => [o, summaryOf(o).bad]), feed: unreadCount(), total: totalItems() };
      }, { write: false });
      opCtx = { unread: new Map(snap.unread), bad: new Map(snap.bad) };
      let unread = snap.feed, total = snap.total;
      // each blyg's queue and what it holds, read once (its feed, archive and ledger)
      const docs = new Map();
      for (const p of snap.turn) {
        p.docs = docs;
        const q = await tx(blygWants(p.o), () => {
          const led = ledgerFor(p.o);
          return { queue: copy(led.queue), unread: unreadOf(p.o) };
        }, { write: false, docs: p.docs });
        Object.assign(p, q, { results: [], consumed: [] });
      }
      let moved = true;
      while (moved && unread < cfg.following_unread_target && !budget.spent()) {
        moved = false;
        for (const p of snap.turn) {
          if (unread >= cfg.following_unread_target || budget.spent()) break;
          if (!p.queue.length || p.unread >= cfg.following_max_items_per_blyg || total >= cfg.following_max_items_total) continue;
          const e = p.queue.shift();
          moved = true;
          p.consumed.push(e.id);
          // checked again against what is stored (held, read, gone, unusable or waiting: skipped, never fetched)
          // (a post that stepped aside is fetched again: its text, back in the Feed)
          const chk = await tx(blygWants(p.o), () => {
            const led = ledgerFor(p.o);
            const held = load().items[identOf(p.o, e.id)];
            const skip = !!((held && held.read !== 'older') || led.ids.some(x => x[0] === e.id) || goneTest(led)(e.id)
              || (led.bad[e.id] && led.bad[e.id][0] === e.version) || (led.later[e.id] && led.later[e.id][0] > now()));
            return { skip, sig: held ? sigOf(held) : '-' };
          }, { write: false, docs: p.docs });
          if (chk.skip) continue;
          p.lastBackfill = now();
          const r = await fetchOne(p.b, e, chk.sig, 'topup', g, tally, null, started);
          p.results.push(r);
          if (r.got.out === 'ok') { unread++; total++; p.unread++; }
        }
      }
      for (const p of snap.turn) {
        if (!p.consumed.length) continue;
        const t = newTally();
        await tx(blygWants(p.o), () => {
          const x = newTally();
          const st = load();
          const b = st.blygs[p.o];
          if (!b || b.epoch !== p.epoch) { x.aborted++; Object.assign(t, x); return; }
          const led = ledgerFor(p.o);
          const used = new Set(p.consumed);
          led.queue = led.queue.filter(q => !used.has(q.id));
          if (p.lastBackfill) b.last_backfill = p.lastBackfill;
          const plan = { b, led, left: 0 };
          for (const r of p.results) {
            const out = r.got.out !== 'ok' ? (r.got.error && (b.last_error = r.got.error), r.got.out) : ingest(b, r.e, r.sig, r.got, r.bodyName, cfg, g, x);
            outcome(plan, r.e, out);
          }
          settleParts(p.o);
          x.stepped_aside += makeRoom(p.o, cfg);
          Object.assign(t, x);
        }, { docs: p.docs });
        addTally(tally, t);
      }
    } finally {
      opCtx = null;
      try { await releaseLease(holder, 'topup'); } catch (e) { console.warn(`[following] the run lease: ${cleanText(String(e && e.message), 200)}`); }
    }
    onChange();
    // (`new` is what came into the Feed: new posts, and older ones read back with their text)
    return { started: true, new: tally.new + tally.restored, requests: budget.requests };
  }

  // ---- sweeping: what nothing names any more ----
  /**
   * Bodies no held record names, and documents of blygs neither followed nor kept: each deleted when it was found unnamed by an
   * EARLIER sweep too (SWEEP_MARKS, in the run document) and its written-at is older than LIMITS.bodySweepAgeMs (a body is written
   * BEFORE the record that names it, so a young one may belong to a transaction not yet committed: it is never deleted). Also
   * ends the conversion's quiet period when it is over (MIGRATION_STATES). → how many were deleted.
   */
  async function sweep() {
    try { await finishQuietPeriod(); } catch (e) { if (e instanceof HubNewer) throw e; console.warn(`[following] the conversion: ${cleanText(String(e && e.message), 200)}`); }
    const listed = {};
    for (const kind of ['body', 'feed', 'archive', 'ledger']) listed[kind] = await store.list(kind);
    const known = await tx({ allFeeds: true }, () => {
      const st = load();
      return { bodies: new Set(Object.values(st.items).filter(isUnreadHeld).map(bodyNameOf)),
        names: new Set([...Object.keys(st.blygs), ...Object.keys(st.kept)].map(ledgerName)), followed: new Set(Object.keys(st.blygs).map(ledgerName)) };
    }, { write: false, guard: true });
    const unnamed = new Set();
    for (const name of listed.body) if (!known.bodies.has(name)) unnamed.add(docKey('body', name));
    for (const kind of ['feed', 'archive', 'ledger']) for (const name of listed[kind]) if (!(kind === 'ledger' ? known.names : known.followed).has(name)) unnamed.add(docKey(kind, name));
    // the marks: what an earlier sweep found unnamed may go now; what is unnamed for the first time is marked; what is named again
    // is unmarked. (Nothing is written when nothing is unnamed and nothing was marked.)
    const ripe = await tx({}, () => {
      const sw = S.run.sweep;
      if (!unnamed.size && !Object.keys(sw.marks).length) return [];
      sw.seq++;
      for (const [key, m] of Object.entries(sw.marks)) if (!unnamed.has(key)) { moveSweepMark(m, 'named'); delete sw.marks[key]; }
      const out = [];
      for (const key of unnamed) {
        const m = sw.marks[key];
        if (m) { if (m.seq < sw.seq) out.push(key); continue; }
        if (Object.keys(sw.marks).length >= LIMITS.sweepMarksKept) continue;
        const fresh = { state: 'unmarked', seq: sw.seq };
        moveSweepMark(fresh, 'mark');
        sw.marks[key] = fresh;
      }
      return out;
    });
    const gone = [];
    for (const key of ripe) {
      const [kind, ...rest] = key.split('/');
      const name = rest.join('/');
      const got = await store.get(kind, name);
      if (!got) { gone.push(key); continue; }
      if (now() - (got.at || 0) < LIMITS.bodySweepAgeMs) continue;
      try { await store.delete(kind, name, { ifVersion: got.version }); gone.push(key); } catch (e) { if (!(e instanceof StoreConflict)) throw e; }
    }
    if (gone.length) await tx({}, () => { const sw = S.run.sweep; for (const key of gone) if (sw.marks[key]) { moveSweepMark(sw.marks[key], 'sweep'); delete sw.marks[key]; } });
    return gone.length;
  }

  // ---- the timer ----
  const schedule = { mode: 'off' };
  let handle; // the timer's handle: meaningful only while schedule.mode is 'scheduled'
  async function reschedule() {
    const n = await tx({}, () => Object.keys(load().blygs).length, { write: false });
    const want = mayFetch() && (n > 0 || !!settings().inbox_api_url);
    if (schedule.mode === 'scheduled') timers.clear(handle);
    handle = undefined;
    if (!want) { if (schedule.mode === 'scheduled') moveSchedule(schedule, 'disarm'); return schedule.mode; }
    moveSchedule(schedule, 'arm');
    handle = timers.set(() => {
      if (!mayFetch()) { reschedule().catch(() => {}); return; }
      refresh({ reason: 'timer' }).catch(e => console.warn(`[following] ${e.message}`));
    }, settings().following_refresh_minutes * 60 * 1000);
    if (handle && handle.unref) handle.unref();
    return schedule.mode;
  }

  // ---- reading state ----
  /** The small record an archived post keeps: no text, no body. ≤ ~0.5 KB. A post ticked from archived_changed is read at its newer wording. */
  const archiveRecordOf = rec => ({
    key: rec.key, origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.newer ? rec.newer.version : rec.version,
    index_version: Math.max(rec.index_version ?? rec.version, rec.newer ? rec.newer.version : 0),
    created: rec.created, updated: rec.updated, fetched_at: rec.fetched_at,
    page: typeof rec.page === 'string' && rec.page.length <= LIMITS.pageChars && isWebUrl(rec.page) ? rec.page : '', content_hash: rec.newer ? rec.newer.hash : rec.content_hash,
    title: cleanText(plainText(rec.title) || plainText(rec.excerpt), LIMITS.archiveTitleChars), read: rec.read, archived_at: iso(),
    ...(rec.returned_at ? { returned_at: rec.returned_at } : {}),
    // the fingerprint of the words read, from the body still held (deleted after the commit): what judges a later edit
    ...(() => { if (rec.newer || TEXTLESS_STATES.includes(rec.read)) return {}; const t = textContent(readBodyHtml(rec)); return t.trim() ? { fp: fingerprintOf(t) } : {}; })(),
  });
  /** A ledger at its bound moves its `ledgerTrim` oldest ids into its GONE filter (by id alone). → how many ids the filter holds. */
  function trimLedger(led) {
    const dropped = led.ids.map((p, i) => [p[1] > 0 ? p[1] : Infinity, i]).sort((a, b) => a[0] - b[0]).slice(0, LIMITS.ledgerTrim);
    led.gone = addGone(led.gone, dropped.map(([, i]) => led.ids[i][0]));
    const drop = new Set(dropped.map(x => x[1]));
    led.ids = led.ids.filter((_, i) => !drop.has(i));
    return led.gone.n;
  }
  /** The owner's tick: the post leaves the Feed (its text is deleted after the commit, a small record stays in its blyg's archive). */
  function tickRec(rec) {
    const st = load();
    needArchives([rec.origin]);
    ledgerFor(rec.origin);
    const next = archiveRecordOf(rec);
    moveRead(next, 'tick');
    touch(rec);
    st.items[identOf(rec.origin, rec.id)] = next;
    const led = ledgerFor(rec.origin);
    if (!led.ids.some(p => p[0] === rec.id)) {
      led.ids.push([rec.id, Math.max(0, stamp(rec.created, now()))]);
      if (led.ids.length > LIMITS.archiveIdsPerBlyg) trimLedger(led);
    }
    if (isUnreadHeld(rec)) S.bodiesToDelete.push(bodyNameOf(rec));
  }
  function readMoveNow(key, ev) {
    const rec = byKey(key);
    if (!rec || isWithdrawn(rec)) throw new Error('no such post');
    // (this operation's own earlier attempt moved it already, before another write made it run again: done, not refused)
    if (S.rerun === 'again_mine' && !canMoveRead(rec, ev) && READ_MOVES[ev] && Object.values(READ_MOVES[ev]).includes(rec.read)) return rec.read;
    if (ev === 'tick') { if (isUnreadHeld(rec)) needBodies([bodyNameOf(rec)]); tickRec(rec); trimArchive(rec.origin); } else moveRead(rec, ev);
    return load().items[identOf(rec.origin, rec.id)].read;
  }
  async function readMove(key, ev) { const r = await tx({}, () => readMoveNow(String(key), ev)); onChange(); return r; }
  /** The members the Feed folds under each head now (as the page shows it), among the blygs read: head key → Set of member keys. */
  const foldedNow = () => {
    const st = load();
    const v = buildView({ items: Object.values(st.items), blygs: st.blygs, now: now() });
    return new Map(v.feed.entries.filter(e => e.members.length).map(e => [e.head.key, new Set(e.members.map(m => m.key))]));
  };
  /**
   * Tick posts the page showed: each entry a key, or { key, members } (a burst's head and the member keys the page showed folded
   * under it). A head's members are ticked with it only if they are STILL folded under that head; at most `tickBatch` entries and
   * `burstMembersMax` members each; an entry that cannot be ticked is skipped. → { archived, parts }.
   */
  function tickBatchNow(entries) {
    const list = (Array.isArray(entries) ? entries : []).slice(0, LIMITS.tickBatch).map(x => ({ key: String(x && typeof x === 'object' ? x.key : x),
      members: x && typeof x === 'object' && Array.isArray(x.members) ? [...new Set(x.members.map(String))].slice(0, LIMITS.burstMembersMax) : [] }));
    // read every blyg the keys name (by their first 8 hex), their archives, and the bodies (for the fingerprints), in one go
    const st = load();
    const prefixes = new Set(list.flatMap(x => [x.key, ...x.members]).map(k => k.slice(0, 8)));
    const origins = Object.keys(st.blygs).filter(o => prefixes.has(ledgerName(o).slice(0, 8)));
    needFeeds(origins); needArchives(origins); needLedgers(origins);
    const index = new Map(Object.values(st.items).map(i => [i.key, i]));
    if (list.some(x => !index.has(x.key))) needFeeds(Object.keys(st.blygs)), needArchives(Object.keys(st.blygs));
    needLedgers([...new Set(list.map(x => index.get(x.key)).filter(Boolean).map(r => r.origin))]);
    needBodies([...index.values()].filter(i => list.some(x => x.key === i.key || x.members.includes(i.key)) && isUnreadHeld(i)).map(bodyNameOf));
    const folded = foldedNow();
    let archived = 0, parts = 0;
    for (const x of list) {
      const rec = index.get(x.key);
      if (!rec || isWithdrawn(rec) || !canMoveRead(rec, 'tick')) continue;
      const under = folded.get(x.key) || new Set();
      tickRec(rec); archived++;
      for (const mk of x.members) {
        const m = index.get(mk);
        if (!under.has(mk) || !m || !canMoveRead(m, 'tick')) continue;
        tickRec(m); parts++;
      }
    }
    for (const o of origins) trimArchive(o);
    return { archived, parts };
  }
  async function tickBatch(entries) { const r = await tx({}, () => tickBatchNow(entries)); if (r.archived) onChange(); return r; }
  const tickMany = async entries => (await tickBatch(entries)).archived;
  /** A blyg the owner paused, or one that is gone, is asked nothing until it is resumed: not even for one post. */
  function refuseIfNotAsked(b) {
    if (b.state === 'paused') throw new Error('that blyg is paused, so nothing is fetched from it: resume it first');
    if (b.state === 'gone') throw new Error('that blyg has no manifest any more, so nothing is fetched from it: resume it to try again');
  }
  /**
   * The owner's untick: the post goes back to the Feed as `new`. Its text was deleted when it was ticked, so it is fetched again (one
   * request); if that fails the post stays in the Archive and the error says why. The move is applied in a transaction that checks
   * the record is still the one fetched for.
   */
  async function untick(key) {
    const k = String(key);
    const pre = await tx({}, () => {
      const rec = byKey(k);
      if (!rec) throw new Error('no such post');
      if (!canMoveRead(rec, 'untick')) throw new Error('that post is not in the Archive');
      if (!mayFetch()) throw new Error('fetching is off (blyg_checks), so the post cannot be fetched again');
      const b = load().blygs[rec.origin];
      if (!b) throw new Error('that blyg is not followed');
      refuseIfNotAsked(b);
      syncBreakers();
      return { rec: copy(rec), b: copy(b), sig: sigOf(rec) };
    }, { write: false, guard: true });
    const tally = { deferred: 0, errors: 0, invalid: 0, missing: 0, refused: 0, aborted: 0 };
    const g = getter(newBudget({ following_run_requests: 3, following_run_seconds: 30 }, now));
    let got;
    try { got = await pull(pre.b, pre.rec.id, g, tally); } finally { await flushBreakers(); }
    if (['trouble', 'host_trouble', 'missing'].includes(got.out)) throw new Error(`could not fetch the post: ${got.message}`);
    if (got.out === 'refused') throw new Error(REFUSALS.item);
    if (got.out !== 'ok') throw new Error('the blyg does not serve that post as it was, so it stays in the Archive');
    if (isWithdrawn(got.rec)) throw new Error('that post has been withdrawn');
    const bodyName = await putBody(pre.rec.key, got.body.html);
    const r = await tx({}, () => {
      const rec = byKey(k);
      // this untick's own earlier attempt wrote the feed (its body is unique to it): finish it, the archive copy goes
      if (rec && bodyName && rec.body === bodyName && !ARCHIVE_STATES.includes(rec.read)) {
        dropArchivedId(rec.origin, rec.id);
        return rec.read;
      }
      // the record is no longer the one fetched for (ticked, unticked or refreshed meanwhile)
      if (!rec || sigOf(rec) !== pre.sig) throw new Error('that post changed meanwhile (it was ticked, unticked or refreshed): look again and retry');
      const next = { ...got.rec, body_state: got.body.state, index_version: got.rec.version, fetched_at: now(), key: rec.key, ...(bodyName ? { body: bodyName } : {}), read: rec.read,
        identity: 'unverified', first_seen: iso(), maintenance: 0, last_change: 'new-words', words_version: got.rec.version,
        ...(rec.returned_at ? { returned_at: rec.returned_at } : {}) };
      moveRead(next, 'untick');
      touch(rec);
      load().items[identOf(rec.origin, rec.id)] = next;
      dropArchivedId(rec.origin, rec.id);
      // over a limit now: the oldest OTHER unread posts step aside (the one the owner put back stays in the Feed)
      makeRoom(rec.origin, settings(), { keep: rec.key });
      return next.read;
    });
    onChange();
    return r;
  }
  /** Would a top-up do anything now: the Feed below its target, a blyg with a saved queue, the lease free and past its gap? */
  const wantsTopUpNow = () => {
    lapseIfDue();
    return mayFetch() && leaseOf().state === 'idle' && now() >= S.run.topup_after && unreadCount() < settings().following_unread_target
      && Object.values(load().blygs).some(b => { const s = summaryOf(b.origin); return b.state === 'active' && ['unknown', 'more'].includes(s.backfill) && s.queue > 0; });
  };
  const afterMove = () => tx({ allFeeds: true }, () => ({ unread: unreadCount(), target: settings().following_unread_target, topup: wantsTopUpNow() }), { write: false });

  // ---- the star: the owner's private mark on a post, to come back to it (nothing about it leaves the Hub) ----
  /** A star's record: the shape of an archive record and when it was starred; its state (STAR_STATES) in ONE field, `star`. */
  const starRecordOf = rec => ({ key: rec.key, origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.version, created: rec.created, updated: rec.updated,
    page: typeof rec.page === 'string' && rec.page.length <= LIMITS.pageChars && isWebUrl(rec.page) ? rec.page : '',
    title: cleanText(plainText(rec.title) || plainText(rec.excerpt), LIMITS.archiveTitleChars), star: 'plain' });
  function starMoveNow(key, ev) {
    needStars();
    const stars = load().stars;
    const k = String(key);
    const entry = Object.values(stars).find(e => e.key === k);
    if (ev === 'unstar') {
      if (!entry && S.rerun === 'again_mine') return 'plain'; // (unstarred by this operation's own earlier attempt)
      if (!entry) throw new Error('that post is not starred');
      moveStar(entry, 'unstar');
      delete stars[identOf(entry.origin, entry.id)];
      return entry.star;
    }
    if (entry && S.rerun === 'again_mine') return entry.star; // (starred by this operation's own earlier attempt)
    if (entry) { moveStar(entry, 'star'); return entry.star; } // refused: already starred
    const rec = byKey(k);
    if (!rec || isWithdrawn(rec)) throw new Error('no such post');
    if (Object.keys(stars).length >= LIMITS.starsMax) throw new Error(`at most ${LIMITS.starsMax} posts can be starred: remove a star first`);
    const e = starRecordOf(rec);
    moveStar(e, 'star');
    e.starred_at = iso();
    stars[identOf(rec.origin, rec.id)] = e;
    return e.star;
  }
  /** What the page may ask of /following/read: tick (one post, or the posts it shows), untick, "mark new", star or unstar. */
  async function readRequest(data) {
    const d = data && typeof data === 'object' ? data : {};
    if (Array.isArray(d.ticks) || Array.isArray(d.keys)) {
      const r = await tickBatch(Array.isArray(d.ticks) ? d.ticks : d.keys);
      return { ...r, ...(await afterMove()) };
    }
    const move = String(d.move || '');
    if (!['tick', 'untick', 'renew', 'star', 'unstar'].includes(move)) throw new Error('move must be tick, untick, renew, star or unstar');
    const key = String(d.key || '');
    if (move === 'star' || move === 'unstar') { const star = await tx({ stars: true }, () => starMoveNow(key, move)); onChange(); return { star }; }
    if (move === 'tick') {
      const r = await tx({}, () => {
        const rec = byKey(key);
        if (!rec || isWithdrawn(rec)) throw new Error('no such post');
        if (!canMoveRead(rec, 'tick') && S.rerun === 'again_mine' && ARCHIVE_STATES.includes(rec.read)) return { read: rec.read, parts: 0 }; // (done by its own earlier attempt)
        if (!canMoveRead(rec, 'tick')) throw new Error(`read state: cannot tick while ${rec.read}`);
        const t = tickBatchNow([{ key, members: Array.isArray(d.members) ? d.members : [] }]);
        return { read: load().items[identOf(rec.origin, rec.id)].read, parts: t.parts };
      });
      onChange();
      return { ...r, ...(await afterMove()) };
    }
    const read = move === 'untick' ? await untick(key) : await readMove(key, move);
    return { read, ...(await afterMove()) };
  }
  /** A note for this post was exported: its read state becomes `responded`. → false when the post is not held, or is archived. */
  async function markResponded(origin, id) {
    const r = await tx({}, () => {
      if (!load().blygs[String(origin)]) return false;
      const rec = heldItem(String(origin), String(id));
      if (!rec || isWithdrawn(rec) || !canMoveRead(rec, 'respond')) return false;
      moveRead(rec, 'respond');
      return true;
    });
    if (r) onChange();
    return r;
  }
  async function mentionSeen(key) {
    const r = await tx({ inbox: true }, () => {
      const m = load().inbox.mentions.find(x => x.key === key);
      if (!m) throw new Error('no such mention');
      if (canMoveMention(m, 'see')) moveMention(m, 'see');
      return m.read;
    });
    onChange();
    return r;
  }
  async function allMentionsSeen() {
    const n = await tx({ inbox: true }, () => {
      let c = 0;
      for (const m of load().inbox.mentions) if (canMoveMention(m, 'see')) { moveMention(m, 'see'); c++; }
      return c;
    });
    if (n) onChange();
    return n;
  }
  /** The post a mention's source address is, when it is on the list (every feed is read). */
  const feedItemFor = m => { if (!m.source_url) return null; needAllFeeds(); return Object.values(load().items).find(i => isUnreadHeld(i) && i.page && samePage(i.page, m.source_url)) || null; };
  /**
   * Open a post or a mention: the one path. A post becomes `opened` (never archived); a mention becomes `seen` (and the post of the
   * list its source is, if any, `opened`). → { url }, the ORIGINAL page.
   */
  async function open(key, version = 0) {
    const r = await tx({ inbox: true }, () => {
      const k = String(key);
      const m = load().inbox.mentions.find(x => x.key === k);
      if (m) {
        if (!m.source_url) throw new Error('that mention has no link to open');
        if (canMoveMention(m, 'see')) moveMention(m, 'see');
        const post = feedItemFor(m);
        if (post && canMoveRead(post, 'open')) moveRead(post, 'open');
        return { url: m.source_url, opens_on: '' };
      }
      const rec = byKey(k);
      if (!rec) throw new Error('no such post or mention');
      if (isWithdrawn(rec)) throw new Error('no such post');
      // opening a post opens its CURRENT version; a pinned older one only by asking for it, and only if its page can be told
      const pin = version ? pinPageOf(rec, Number(version)) : '';
      if (version && !pin) throw new Error('that version is not pinned, or its page cannot be told from what is held');
      if (canMoveRead(rec, 'open')) moveRead(rec, 'open');
      return { url: pin || rec.page, opens_on: hostOf(rec.page) !== hostOf(rec.origin) ? hostOf(rec.page) : '' };
    });
    onChange();
    return r;
  }

  // ---- reading a post here ----
  const recordUrlOf = rec => {
    if (within(rec.origin, rec.page)) return rec.page;
    const b = state ? load().blygs[rec.origin] : null;
    const u = itemUrlFor({ item: b && b.item_template }, rec.origin, rec.id);
    return u && within(rec.origin, u) ? u : '';
  };
  /**
   * The post's own item document, fetched again through the same guarded getter and the same origin rule, checked as the
   * reconciliation checks it, and its content sanitised by the article view's sanitiser. Nothing is written here.
   */
  async function fetchPost(key) {
    if (!mayFetch()) throw new Error('fetching is off (blyg_checks), so the post cannot be fetched');
    const pre = await tx({}, () => {
      const rec = byKey(String(key));
      if (!rec || isWithdrawn(rec)) throw new Error('no such post');
      const b = load().blygs[rec.origin];
      if (!b) throw new Error('that blyg is not followed');
      refuseIfNotAsked(b);
      syncBreakers();
      return { rec: copy(rec), b: copy(b) };
    }, { write: false });
    const { rec, b } = pre;
    const g = getter(newBudget({ following_run_requests: 3, following_run_seconds: 30 }, now));
    const url = itemUrlFor({ item: b.item_template }, rec.origin, rec.id);
    if (!isWebUrl(url)) throw new Error('the blyg\'s item address is not a web address');
    if (!within(rec.origin, url)) throw new Error(REFUSALS.item);
    let r;
    try { r = await fetchJson(g, url, LIMITS.itemBytes); } finally { await flushBreakers(); }
    if (r.status === 'trouble') throw new Error(`could not fetch the post: ${r.message}`);
    if (r.status !== 'ok') throw new Error('the blyg does not serve that post any more');
    if (!within(rec.origin, r.url)) throw new Error(REFUSALS.redirect);
    const doc = r.json;
    const why = docRefusal(doc, { id: rec.id, origin: rec.origin });
    if (why) throw new Error(`the post did not verify: ${why}`);
    if (doc.kind === 'withdrawn') throw new Error('that post has been withdrawn');
    const post = recordFromDoc(doc, rec.origin, b);
    if (post.invalid) throw new Error(`the post cannot be shown: ${post.invalid}`);
    const src = typeof doc.content_html === 'string' && doc.content_html.trim() ? doc.content_html : mdFallbackHtml(doc.content_md);
    const clean = sanitizeStable(src, { landmarks: false });
    if (clean.tooBig) throw new Error('the post is too large to keep a readable copy of');
    if (!clean.html.trim()) throw new Error('there is nothing readable in that post');
    const pinned = pinnedOf(post);
    return {
      key: rec.key, page_url: within(rec.origin, post.page) ? post.page : url, display_page: post.page, title: post.title || post.excerpt || 'A post', html: clean.html,
      result: { status: 'blyg', source: 'item-document', site: { origin: rec.origin, title: b.title, author: b.author },
        html: '', text: textContent(clean.html),
        item: { origin: rec.origin, id: rec.id, kind: post.kind, version: post.version, latest: post.version, pinned: pinned.includes(post.version),
          pinned_versions: pinned, page: post.page, pinned_page: '', json: url, source: b.title, author: post.author } },
      meta: { origin: rec.origin, id: rec.id, kind: post.kind, version: post.version, created: post.created, updated: post.updated,
        author: post.author, blyg_title: b.title, versions: post.versions, stub_of: post.stub_of, key: rec.key },
    };
  }
  /** The same shape as fetchPost's, made from what the Hub already holds, with NO request. `ref` is a key, or { origin, id }. */
  const heldPost = ref => tx({}, () => {
    const rec = typeof ref === 'string' ? byKey(ref) : (ref && load().blygs[String(ref.origin)] ? heldItem(String(ref.origin), String(ref.id)) : null);
    if (!rec || isWithdrawn(rec)) throw new Error('no such post');
    const b = load().blygs[rec.origin];
    if (!b) throw new Error('that blyg is not followed');
    const html = TEXTLESS_STATES.includes(rec.read) ? '' : readBodyHtml(rec);
    if (!html.trim()) throw new Error(ARCHIVE_STATES.includes(rec.read) ? 'that post is in the Archive, and no text is kept for it'
      : rec.read === 'older' ? 'that post stepped aside for newer ones, and no text is kept for it: use Read here' : 'no text is held for that post yet: use Read here');
    if (!recordUrlOf(rec)) throw new Error(REFUSALS.item);
    const pinned = pinnedOf(rec);
    return {
      key: rec.key, page_url: recordUrlOf(rec), display_page: rec.page, title: rec.title || rec.excerpt || 'A post', html, text_state: rec.body_state,
      result: { status: 'blyg', source: 'item-document', site: { origin: rec.origin, title: b.title, author: b.author }, html: '', text: textContent(html),
        item: { origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.version, latest: rec.version, pinned: pinned.includes(rec.version),
          pinned_versions: pinned, page: rec.page, pinned_page: '', json: '', source: b.title, author: rec.author } },
      meta: { origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.version, created: rec.created, updated: rec.updated, author: rec.author,
        blyg_title: b.title, versions: rec.versions, stub_of: rec.stub_of, key: rec.key },
    };
  }, { write: false });
  /** Reading a post here is opening it. */
  async function openedHere(key) {
    const r = await tx({}, () => {
      const rec = byKey(String(key));
      if (!rec || isWithdrawn(rec)) throw new Error('no such post');
      if (canMoveRead(rec, 'open')) moveRead(rec, 'open');
      return rec.read;
    });
    onChange();
    return r;
  }
  const heldVersion = (origin, id) => tx({}, () => { if (!load().blygs[String(origin)]) return 0; const r = heldItem(String(origin), String(id)); return r && !isWithdrawn(r) ? r.version : 0; }, { write: false });
  /** What a post answers, said as a person would: the target's title when it is a followed post held here, else its host. */
  function responseOfNow(stub) {
    if (!stub) return null;
    if (stub.id && load().blygs[stub.origin]) needFeeds([stub.origin]);
    const target = stub.id ? load().items[identOf(stub.origin, stub.id)] : null;
    return { origin: stub.origin, id: stub.id,
      label: (target && !isWithdrawn(target) && (plainText(target.title) || plainText(target.excerpt))) || hostOf(stub.origin) || stub.origin };
  }

  /**
   * The page at `url` is a post the list holds? → { verdict, item?, reason?, result? } (IDENTITY_VERDICTS). THE LIST ALONE NEVER
   * SUPPLIES IDENTITY: the list's origin, id and version are used for a page only when the page's OWN links agree.
   */
  const identityFor = (url, hints) => tx({ allFeeds: true }, () => {
    const claimants = Object.values(load().items).filter(i => isUnreadHeld(i) && i.page && samePage(i.page, url) && load().blygs[i.origin]);
    if (!claimants.length) return { verdict: 'none' };
    const h = cleanHints(hints) || { blyg: '', json: '' };
    const judge = rec => {
      let why = '';
      let jsonOk = false, blygOk = false;
      if (h.json) {
        const named = new URL(h.json).pathname.split(/[/.]/).filter(seg => ID_RE.test(seg));
        if (!within(rec.origin, h.json)) why = `the page's own item link is not inside the blyg the list says (${rec.origin})`;
        else if (!named.length || !named.includes(rec.id)) why = `the page's own link names post ${named[0] || '(none)'}, the list says ${rec.id}`;
        else jsonOk = true;
      }
      if (!why && h.blyg) {
        if (identityOf(h.blyg) !== rec.origin && candidateBase(h.blyg) !== rec.origin) why = `the page's own link names the blyg at ${cleanText(identityOf(h.blyg), 200)}, the list says ${rec.origin}`;
        else blygOk = true;
      }
      return why ? { rec, why } : { rec, agrees: jsonOk && blygOk };
    };
    const verdicts = claimants.map(judge);
    const yes = verdicts.find(v => v.agrees);
    if (yes) {
      const rec = yes.rec, blyg = load().blygs[rec.origin];
      if (rec.identity !== 'agrees') { setIdentity(rec, 'agree'); delete rec.identity_note; }
      return { verdict: 'agrees', item: copy(rec), result: {
        status: 'blyg', source: 'from-list', site: { origin: rec.origin, title: blyg.title, author: blyg.author },
        html: '', text: rec.text,
        item: { origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.version, latest: rec.version,
          pinned: pinnedOf(rec).includes(rec.version), pinned_versions: pinnedOf(rec), page: rec.page, pinned_page: '', json: '', source: blyg.title, author: rec.author },
      } };
    }
    const no = verdicts.filter(v => v.why);
    if (no.length) {
      for (const v of no) { setIdentity(v.rec, 'disagree'); v.rec.identity_note = cleanText(v.why, 300); }
      return { verdict: 'disagrees', item: copy(no[0].rec), reason: no[0].why };
    }
    return { verdict: 'unconfirmed', item: copy(claimants[0]) };
  });

  // ---- what the page shows ----
  /**
   * Everything a page shows, in ONE read-only transaction: the main document, the run document, every feed, the inbox and the
   * stars (the Archive tab: every archive too); the bodies of the posts it shows. No ledger is read.
   */
  const view = ({ view: tab = 'feed', filter = 'all', mine = [], limit = LIMITS.feedEntries, q = '', start = 0 } = {}) => tx({ allFeeds: true, inbox: true, stars: true, ...(viewOf(tab) === 'archive' ? { allArchives: true } : {}) }, () => {
    const st = load();
    const cfg = settings();
    const v = buildView({ items: Object.values(st.items), blygs: st.blygs, mentions: st.inbox.mentions, mine, filter, now: now() });
    const titleOf = o => (st.blygs[o] && st.blygs[o].title) || '';
    const starOf = i => (st.stars[identOf(i.origin, i.id)] ? 'starred' : 'plain');
    // PAGES: the list a tab shows is one list, paged by `start` (where the page begins) and `limit` (how many it shows). The Feed's
    // list is its unread entries, newest first, and then (filter "all") the posts that stepped aside, newest first: "Older posts"
    // pages back through both, and the page says nothing of how many there are.
    const pageOf = (total, lim) => {
      const n = Math.max(1, Math.min(Number(lim) || LIMITS.feedEntries, 1000));
      const at = Math.max(0, Math.min(Math.floor(Number(start) || 0), Math.max(0, total - 1)));
      return { start: at, limit: n, newer: at > 0 ? Math.max(0, at - n) : null, older: at + n < total ? at + n : null };
    };
    const olderAll = viewOf(tab) === 'feed' && filterOf(filter) === 'all' ? v.older : [];
    const page = viewOf(tab) === 'feed' ? pageOf(v.feed.entries.length + olderAll.length, limit) : null;
    const shownFeed = page ? v.feed.entries.slice(page.start, page.start + page.limit) : [];
    const shownOlder = page ? olderAll.slice(Math.max(0, page.start - v.feed.entries.length), Math.max(0, page.start + page.limit - v.feed.entries.length)) : [];
    needBodies(shownFeed.filter(e => e.head.body_state && e.head.body_state !== 'none').map(e => bodyNameOf(e.head)));
    const decorate = (i, withBody = false) => {
      const body = withBody && i.body_state && i.body_state !== 'none' ? clipBody(readBodyHtml(i), i.kind, cfg.following_feed_clip_words) : { head: '', rest: '' };
      return { ...copy(i), excerpt: cleanText(plainText(i.excerpt), LIMITS.excerptChars), title: cleanText(plainText(i.title), LIMITS.titleChars),
        blyg_title: titleOf(i.origin), blyg_label: mine.includes(i.origin) ? 'you' : titleOf(i.origin),
        record_url: isWithdrawn(i) ? '' : recordUrlOf(i), shown_at: new Date(sortTime(i)).toISOString(), reading: readingLabel(i.words || wordsIn(i.text || '')),
        body_head: body.head, body_rest: body.rest, star: starOf(i),
        versions_note: i.version > 1 ? `${i.version} versions` : '',
        history: [...(i.versions || [])].sort((a, b) => b.version - a.version)
          .map(x => ({ ...x, mark: x.pin === 'pinned' ? (pinPageOf(i, x.version) ? 'link' : 'plain') : '' })),
        pinned_list: pinnedOf(i),
        opens_on: i.page && hostOf(i.page) !== hostOf(i.origin) ? hostOf(i.page) : '',
        in_response_to: responseOfNow(i.stub_of) };
    };
    const mention = m => { const p = feedItemFor(m); return { ...copy(m), feed_key: p ? p.key : '' }; };
    const line = i => ({ key: i.key, read: i.read, newer_version: i.newer ? i.newer.version : 0, kind: i.kind, origin: i.origin, blyg_title: titleOf(i.origin), blyg_label: mine.includes(i.origin) ? 'you' : titleOf(i.origin),
      title: cleanText(plainText(i.title), LIMITS.archiveTitleChars), version: i.version, created: i.created, updated: i.updated, archived_at: i.archived_at,
      page: i.page, opens_on: i.page && hostOf(i.page) !== hostOf(i.origin) ? hostOf(i.page) : '', star: starOf(i) });
    const needle = cleanText(String(q || ''), 100).toLowerCase();
    const archiveAll = viewOf(tab) === 'archive' ? v.archive.map(line).filter(l => !needle || `${l.title} ${l.blyg_title} ${l.origin}`.toLowerCase().includes(needle)) : [];
    const archivePage = viewOf(tab) === 'archive' ? pageOf(archiveAll.length, Math.min(Number(limit) || LIMITS.archivePage, LIMITS.archiveShownMax)) : null;
    // the Starred tab: newest starred first; a post still unread and held says so (and links to it in the Feed). It reads the
    // archives of the blygs whose starred posts are not in their feeds (to say "read, in the Archive"), and no others.
    if (viewOf(tab) === 'starred') needArchives([...new Set(Object.values(st.stars).filter(e => st.blygs[e.origin] && !st.items[identOf(e.origin, e.id)]).map(e => e.origin))]);
    const starredAll = Object.values(st.stars).sort((a, b) => (Date.parse(b.starred_at) || 0) - (Date.parse(a.starred_at) || 0) || (a.key < b.key ? -1 : 1)).map(e => {
      const held = st.blygs[e.origin] ? st.items[identOf(e.origin, e.id)] : null;
      const where = !held ? (st.blygs[e.origin] ? 'gone' : 'unfollowed') : ARCHIVE_STATES.includes(held.read) ? 'archive' : isWithdrawn(held) ? 'withdrawn' : held.read === 'older' ? 'older' : 'feed';
      return { key: held && !isWithdrawn(held) ? held.key : e.key, star: 'starred', starred_at: e.starred_at, kind: e.kind, origin: e.origin,
        blyg_title: titleOf(e.origin) || hostOf(e.origin), blyg_label: mine.includes(e.origin) ? 'you' : (titleOf(e.origin) || hostOf(e.origin)),
        title: cleanText(plainText(held && held.title ? held.title : e.title) || plainText(held ? held.excerpt : ''), LIMITS.archiveTitleChars),
        created: e.created, updated: held ? held.updated : e.updated, page: (held && held.page) || e.page, where, read: held ? held.read : '' };
    });
    const starredPage = viewOf(tab) === 'starred' ? pageOf(starredAll.length, Number(limit) || LIMITS.archivePage) : null;
    const active = Object.values(st.blygs).filter(b => b.state !== 'paused');
    // what waits, one line a blyg (the page words it; no number): new posts not fetched yet (HOLD_STATES held), new posts failing
    // (FRESH_MODES failing), a mass edit (its read posts wait in the Archive). A paused blyg is asked nothing: it says nothing here.
    const waiting = active.map(b => { const sm = summaryOf(b.origin); return { origin: b.origin, blyg_title: titleOf(b.origin),
      why: [...(sm.holding === 'held' ? ['new_waiting'] : []), ...(sm.fresh === 'failing' ? ['new_failing'] : []), ...(sm.changes.length > LIMITS.massEditPerDay ? ['mass_edit'] : [])] }; })
      .filter(x => x.why.length);
    const box = syncInbox(cfg);
    const tabs = { ...v.tabs, starred: starredAll.length,
      // the Archive's count: from each blyg's archive when read (the Archive tab), else from its feed's summary
      archive: Object.keys(st.blygs).reduce((n, o) => n + (S.archives.has(o) ? itemsOf(o).filter(i => ARCHIVE_STATES.includes(i.read)).length : summaryOf(o).archived), 0) };
    return { view: viewOf(tab), filter: v.feed.filter, counts: v.feed.counts, tabs, target: cfg.following_unread_target,
      // Said only when it is true of every blyg that is not paused: reachable, and its index read to the end (from the summaries).
      read_all: v.tabs.feed === 0 && active.length > 0 && active.every(b => b.state === 'active' && summaryOf(b.origin).backfill === 'caught_up'),
      archive: archivePage ? archiveAll.slice(archivePage.start, archivePage.start + archivePage.limit) : [], archive_total: archiveAll.length, archive_query: needle,
      starred: starredPage ? starredAll.slice(starredPage.start, starredPage.start + starredPage.limit) : [], stars_max: LIMITS.starsMax,
      page: page || archivePage || starredPage || { start: 0, limit: Number(limit) || 0, newer: null, older: null },
      waiting,
      older: shownOlder.map(line),
      archive_notices: viewOf(tab) === 'archive' ? Object.keys(st.blygs).map(o => ({ origin: o, blyg_title: titleOf(o),
        held: itemsOf(o).filter(i => i.read === 'archived_changed').length, changes: summaryOf(o).changes.length }))
        .filter(n => n.held > 0 && (n.changes > LIMITS.massEditPerDay || n.held > LIMITS.massEditPerDay)).map(({ changes, ...n }) => n) : [],
      run: { state: leaseOf().state !== 'idle' && now() >= leaseOf().until ? 'idle' : leaseOf().state, topup_after: S.run.topup_after }, schedule: { ...schedule }, last_run: copy(st.last_run), blygs: blygRows(),
      entry_total: v.feed.entries.length, limit,
      entries: shownFeed.map(e => ({ head: decorate(e.head, true), members: e.members.map(m => decorate(m)) })),
      background: viewOf(tab) === 'background' ? v.background.map(b => (b.type === 'post'
        ? { type: 'post', reason: b.reason, post: decorate(b.post), burst_head_title: b.burst_head ? (b.burst_head.title || b.burst_head.excerpt) : '' }
        : { type: 'mention', reason: b.reason, mention: mention(b.mention) })) : [],
      mentions: viewOf(tab) === 'mentions' ? v.mentions.map(mention) : [],
      inbox: { state: box.state, fetched_at: box.fetched_at, generated_at: box.generated_at, count: box.count, error: box.error,
        never_verified: [...box.never_verified], never_verified_count: box.never_verified_count, blocked_count: box.blocked_count,
        token_warning: cfg.inbox_token_file ? tokenWarning(cfg.inbox_token_file) : '' } };
  }, { write: false });
  const itemByKey = key => tx({}, () => copy(byKey(String(key))), { write: false });
  const keyFor = (origin, id) => tx({}, () => { if (!load().blygs[String(origin)]) return ''; const r = heldItem(String(origin), String(id)); return r ? r.key : ''; }, { write: false });
  const bodyHtml = key => tx({}, () => { const r = byKey(String(key)); return r && isUnreadHeld(r) ? readBodyHtml(r) : ''; }, { write: false });
  const runState = () => tx({}, () => { lapseIfDue(); return leaseOf().state; }, { write: false });
  const breakerSnapshot = host => tx({}, () => { const b = S.run.breakers[host]; return b ? Object.freeze({ ...b }) : null; }, { write: false });

  return { follow, unfollow, setBlygState, stateRequest, retryBackfill, listBlygs, previewImport, confirmImport, refresh, reschedule, readMove,
    markResponded, tickMany, tickBatch, untick, readRequest, topUp, unreadCount: () => tx({ allFeeds: true }, unreadCount, { write: false }), mentionSeen, allMentionsSeen, open, identityFor, view, itemByKey, fetchPost, heldPost,
    recordUrlOf: rec => tx({}, () => recordUrlOf(rec), { write: false }), openedHere, heldVersion, responseOf: stub => tx({}, () => responseOfNow(stub), { write: false }), bodyHtml, sweep, sweepBodies: sweep,
    keyFor, runState, followCount: () => tx({}, () => Object.keys(load().blygs).length, { write: false }), scheduleMode: () => schedule.mode, inboxState: () => tx({ inbox: true }, () => load().inbox.state, { write: false }),
    breakerSnapshot, store,
    /** Refuses (HubNewer) when the store is of a newer layout than this engine: a host checks it before writing anything of its own. */
    checkLayout: () => tx({}, () => LAYOUT, { write: false, guard: true }),
    migrationState: () => tx({}, () => load().migration.state, { write: false }),
    start: () => reschedule(),
    stop: () => { if (schedule.mode === 'scheduled') { timers.clear(handle); handle = undefined; moveSchedule(schedule, 'disarm'); } } };
}


// ---- the routes -----------------------------------------------------------------------
// ONE table. server.mjs serves nothing under /following except through it, after the
// same gate every other route passes, with the owner check and the cross-site check
// applied to each entry (a reader's list is the owner's, not a guest's), and the auth
// test walks this table.
export const ROUTES = Object.freeze([
  { method: 'GET', path: '/hub', what: 'the page (the Hub: Feed, Mentions, Background, Archive, and the list of blygs followed)' },
  { method: 'GET', path: '/following', what: 'the same page, under its older address' },
  { method: 'GET', path: '/following/data', what: 'the console as JSON' },
  { method: 'POST', path: '/following/open', what: 'open a post or mention (marks it, answers with the original address)' },
  { method: 'POST', path: '/following/read-here', what: 'keep the post\'s text as an annotatable page and open it (or load its newer version)' },
  { method: 'POST', path: '/following/hold', what: 'make the held text of a post its annotatable page (no request), so a highlight can be made on it from the Feed' },
  { method: 'POST', path: '/following/follow', what: 'follow a blyg by any URL on it' },
  { method: 'POST', path: '/following/unfollow', what: 'stop following (keeping what was read there, or with forget: true forgetting it too)' },
  { method: 'POST', path: '/following/state', what: 'pause or resume one, or retry its paused reading back' },
  { method: 'POST', path: '/following/import-preview', what: 'what a blogroll or directory would add' },
  { method: 'POST', path: '/following/import-confirm', what: 'add what was confirmed' },
  { method: 'POST', path: '/following/refresh', what: 'refresh now' },
  { method: 'POST', path: '/following/topup', what: 'after a tick: fetch the next posts from the saved queues (no index is read; at most one every 30 seconds)' },
  { method: 'POST', path: '/following/read', what: 'tick a post (or the posts shown) into the Archive, untick one, or mark an opened one new' },
  { method: 'POST', path: '/following/mention-read', what: 'mark a mention (or all) seen' },
  { method: 'POST', path: '/following/settings', what: 'refresh interval, caps, my_origins, inbox' },
]);
export const routeOf = (method, path) => ROUTES.find(r => r.method === method && r.path === path) || null;
