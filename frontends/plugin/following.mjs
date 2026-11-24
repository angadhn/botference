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
//   READ_STATES     where a post is: in the Feed (new,
//                   opened, responded) or in the Archive:  moveRead
//   BACKFILL_MODES  how far back one blyg has been read:   moveBackfill
//   RUN_STATES      whether a reconciliation is going:    moveRun
//   BREAKER_STATES  a host's circuit breaker:             moveBreaker
//   SCHEDULE_MODES  whether the refresh timer is armed:   moveSchedule
//   IDENTITY_STATES whether a post's page agreed with the list: setIdentity
//   INBOX_STATES    the mentions inbox's standing:        moveInbox
//   MENTION_READ    a mention's read state:               moveMention
// and, as values a function works out rather than states that move:
//   PLACEMENTS (placementOf: which view an entry belongs to, and why),
//   IDENTITY_VERDICTS (identityFor), ANSWER_SOURCES, LAST_CHANGES.
//
// WHAT IS KEPT, per post (never the whole HTML): origin, id, kind, current version,
// created, updated, title (first heading) or an excerpt, stub_of, how many
// transclusions and links, and the sanitised plain text the list needs (clipped). One
// record per post at its newest version (the rollup, §13.1). A withdrawn post
// (kind 'withdrawn') is a bare marker, so it is not fetched again (§13.4).
//
// THE ARCHIVE. The owner's own tick moves a post from the Feed to the Archive (read state `archived`): its text and body file
// are deleted and a small record stays (key, origin, id, kind, version read, index version, created, updated, fetched_at, page,
// content_hash, a title or first words of at most 120 characters, archived_at: about half a kilobyte; at most 2000 are kept,
// the oldest ticked dropped first). Beside the records, each blyg has a LEDGER: the ids of the posts ticked (10,000 per blyg,
// 50,000 in all), the ids whose documents could not be used (100, each with the index's version), and its backfill mode. The
// ledger is what keeps a post read after its record is gone. The caps (`following_max_items_*`) count unread held posts only.
//
// THE BACKFILL. A refresh reads each blyg's index (hostile input: at most 20,000 entries, well-formed string ids, an id listed
// twice is one post at its highest version; none of it is stored) and fetches, within the run's one budget: (1) documents of
// posts already held whose version moved; (2) FRESH posts, those newer than the newest post already known, up to the caps;
// (3) BACKFILL, only while the Feed holds fewer unread posts than `following_unread_target`: round-robin over the blygs, one
// post per blyg per round, a blyg's newest unfetched post first. What is left is deferred, never an error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { guardedGet as netGet, FetchTrouble, urlRefusal } from './netguard.mjs';
import { readJsonState, refuseIfUnreadable, warnUnreadable } from './fsjson.mjs';
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
/** The one way a followed blyg's state changes. Throws for a move the table does not allow. */
export function moveBlyg(b, ev) { b.state = blygMachine.to(b.state, ev); return b.state; }

// Where a post is, in ONE field: the Feed holds the unread posts (new, opened, responded), the Archive the ones the
// owner ticked. There is no separate "archived" flag.
//   new        — in the Feed, not opened
//   opened     — in the Feed; its original (or its text here) was opened. Opening never archives it.
//   responded  — in the Feed; a note for it was exported
//   archived   — ticked by the owner (and only by the owner's own tick); it keeps a small record and no text
// There used to be a `seen` state (the dot only; the post stayed in the Feed). A Feed of unread posts has no use for it:
// the tick is the one mark that a post is read. A stored `seen` is loaded as `new`.
//
//   tick      the owner's tick: Feed → Archive                       (the text is deleted, a small record stays)
//   untick    the owner's untick: Archive → Feed, as `new`            (the post is fetched again: its text is gone)
//   reopen    a new version of an archived post whose words may have changed (see changeOf) → Feed, as `new`
//   open      the original was opened
//   respond   a note for the post was exported (an archived post is not moved by one: only a tick or an untick moves it)
//   resurface a real edit to a post that was opened → new
//   renew     the owner's own "mark new" on an opened post
export const READ_STATES = Object.freeze(['new', 'opened', 'responded', 'archived']);
export const READ_MOVES = Object.freeze({
  open: { new: 'opened', opened: 'opened' },
  respond: { new: 'responded', opened: 'responded', responded: 'responded' },
  resurface: { opened: 'new' },
  renew: { opened: 'new' },
  tick: { new: 'archived', opened: 'archived', responded: 'archived' },
  untick: { archived: 'new' },
  reopen: { archived: 'new' },
});
const readMachine = machine('read state', READ_STATES, READ_MOVES);
export const canMoveRead = (rec, ev) => readMachine.can(rec.read, ev);
export function moveRead(rec, ev) { rec.read = readMachine.to(rec.read, ev); return rec.read; }

// How far back one blyg has been read into the Feed (the backfill's own progress, kept per blyg beside its archived ids).
//   unknown   — its index has not been read since it was followed
//   more      — its index lists posts that are neither held, archived nor withdrawn: more to fetch (deferred: not an error)
//   caught_up — nothing in its index is left to fetch: everything is held (unread), archived or withdrawn
//   stopped   — a bound was reached (the archived ids of this blyg, or the documents it served that cannot be used): nothing new
//               is fetched from it any more, so a post whose id could not be remembered can never come back as unread.
//               It ends only when the blyg is unfollowed.
export const BACKFILL_MODES = Object.freeze(['unknown', 'more', 'caught_up', 'stopped']);
export const BACKFILL_MOVES = Object.freeze({
  remain: { unknown: 'more', more: 'more', caught_up: 'more' },
  finish: { unknown: 'caught_up', more: 'caught_up', caught_up: 'caught_up' },
  stop: { unknown: 'stopped', more: 'stopped', caught_up: 'stopped', stopped: 'stopped' },
});
const backfillMachine = machine('backfill', BACKFILL_MODES, BACKFILL_MOVES);
export function moveBackfill(led, ev) { led.backfill = backfillMachine.to(led.backfill, ev); return led.backfill; }

// Whether a reconciliation is in flight. Never more than one.
export const RUN_STATES = Object.freeze(['idle', 'running']);
export const RUN_MOVES = Object.freeze({ begin: { idle: 'running' }, end: { running: 'idle' } });
const runMachine = machine('run state', RUN_STATES, RUN_MOVES);
export function moveRun(run, ev) { run.state = runMachine.to(run.state, ev); return run.state; }

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
  followMax: 500,             // blygs followed
  importMax: 100,             // entries of a blogroll resolved in one preview
  importRequests: 300,        // requests one preview may make
  followRequests: 12,         // requests following one URL may make
  mentionsKept: 500, versionsKept: 100, noteChars: 200,
  bodyBytes: 40 * 1024,       // sanitised HTML kept per post, in a file of its own
  feedEntries: 100,           // entries (with their text) one page of the Feed carries
  archivePage: 50,            // lines one page of the Archive shows ("show more" adds this many, up to archiveShownMax)
  archiveShownMax: 1000,
  archiveRecords: 2000,       // archive records kept for display (~0.5 KB each); beyond it the oldest-ticked are dropped
  archiveTitleChars: 120,     // a record's title, or the first words of the post
  archiveIdsPerBlyg: 10000,   // archived ids remembered per blyg (26 characters each, ~0.3 MB at the bound)
  archiveIdsTotal: 50000,     // ... and in all blygs together
  badPerBlyg: 100,            // ids whose document could not be used, remembered per blyg (with the version the index gave)
  textChars: 1200, excerptChars: 240, titleChars: 160, refsKept: 50, refOriginsKept: 20,
  burstMs: 10 * 60 * 1000,    // items created this close to their thread's publish are one burst
  backoffFirstMs: 10 * 60 * 1000, backoffMaxMs: 6 * 60 * 60 * 1000,
  saveEveryBlygs: 10,         // a refresh saves the main document after this many blygs, and at its end
  tickBatch: 100,             // posts one "Tick all shown" request may tick (the page sends the rest in further requests)
  goneAfter: 3,               // consecutive "no manifest here" answers before a blyg is gone
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
const refOf = (r, dflt) => {
  if (!r || typeof r !== 'object' || !ID_RE.test(String(r.id || ''))) return null;
  const origin = originOf(r.origin || dflt);
  return origin ? { origin, id: r.id } : null;
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
    refs: refsAll.slice(0, LIMITS.refsKept),
    ref_origins: [...new Set(refsAll.map(r => r.origin))].slice(0, LIMITS.refOriginsKept),
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

// ---- placement: which view an entry belongs to, and why ----------------------------
// ONE function decides it, for a post and for a mention, and names the reason shown on
// the entry. An entry moves between views only because this function says so.
export const PLACEMENTS = Object.freeze(['feed', 'mentions', 'background', 'archive', 'hidden']);
export const REASONS = Object.freeze({
  notFollowed: 'not followed', archived: 'ticked as read', withdrawn: 'withdrawn', withdrawnOwn: 'withdrawn (your own)', paused: 'paused blyg',
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
  if (p.read === 'archived') return { placement: 'archive', reason: REASONS.archived };
  if (isWithdrawn(p)) return { placement: 'background', reason: (entry.mine || []).includes(p.origin) ? REASONS.withdrawnOwn : REASONS.withdrawn };
  if (entry.blyg.state === 'paused') return { placement: 'background', reason: REASONS.paused };
  if (entry.burstHead) return { placement: 'background', reason: REASONS.burst };
  if (p.read !== 'new' && p.last_change === 'maintenance') return { placement: 'background', reason: REASONS.maintenance };
  if (p.read !== 'new' && p.last_change === 'minor') return { placement: 'background', reason: REASONS.minor };
  return { placement: 'feed', reason: '' };
}

// ---- the view (pure) ----------------------------------------------------------
export const VIEWS = Object.freeze(['feed', 'mentions', 'background', 'archive']);
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
      if (r.origin !== t.origin) continue;
      const k = identOf(r.origin, r.id);
      const m = byIdent.get(k);
      if (!m || k === identOf(t.origin, t.id) || m.kind === 'thread' || claimed.has(k)) continue;
      const c = Date.parse(m.created);
      if (!Number.isFinite(c) || !near.some(n => Math.abs(n - c) <= LIMITS.burstMs)) continue;
      claimed.add(k);
      heads.get(identOf(t.origin, t.id)).members.push(m);
    }
  }
  return [...heads.values()].filter(h => !claimed.has(identOf(h.head.origin, h.head.id)));
}

/**
 * Everything the console shows, from what is held. Pure. → {
 *   feed: { entries: [{ head, members }], counts, filter }, background: [{ type, post|mention, reason }],
 *   mentions: [mention + reason], archive: [post], tabs: { feed (the unread count), mentions, mentions_unseen, background, archive } }
 */
export function buildView({ items, blygs, mentions = [], mine = [], filter = 'all' }) {
  const posts = items.filter(i => blygs[i.origin]);
  // an archived post is never folded into (or under) a burst: the Archive lists it on its own
  const live = posts.filter(i => !isWithdrawn(i) && i.read !== 'archived');
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
    new: () => feedHeads.filter(e => e.head.read === 'new' || e.members.some(m => m.read === 'new')),
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
  return { feed: { entries, counts, filter: filterOf(filter) }, background, mentions: inMentions, archive,
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
// EVERYTHING the engine keeps goes through ONE store, so a host that keeps it elsewhere (a blob store with conditional
// writes, one blob per body) supplies its own and this file does not change. Three kinds of thing are kept:
//   'state'  — the one main document (the follow list, the held posts and archive records, the inbox, the last run);
//   'ledger' — one small document per blyg (its read ids and floor, its unusable documents, its backfill mode, its queue);
//   'body'   — one sanitised body per held post, named by the post's random key.
// The interface (every method synchronous; a host whose store is asynchronous wraps the engine's calls, not this file):
//   get(kind, name)                     → null (nothing stored) | { value, version } | { unreadable: Error, version }
//                                          value: parsed JSON for 'state' and 'ledger', a string for 'body'
//   put(kind, name, value, { ifVersion }) → { version }. ifVersion undefined: write whatever is stored; null: only if
//                                          nothing is stored; a string: only if the stored version is still that one.
//                                          Otherwise it throws StoreConflict and writes nothing.
//   delete(kind, name), list(kind)      → the names stored of that kind
// A version is opaque. The engine writes the state and a ledger with the version it read, and on a conflict merges what
// it changed into what is stored now (mergeState, mergeLedger) instead of writing over it.
export const STORE_KINDS = Object.freeze(['state', 'ledger', 'body']);
export class StoreConflict extends Error {
  constructor(kind, name) { super(`${kind} ${name} was changed by someone else meanwhile`); this.name = 'StoreConflict'; this.code = 'ESTORECONFLICT'; }
}
/** The name a blyg's ledger is kept under: a digest of its origin (an origin is not a safe file name). */
export const ledgerName = origin => crypto.createHash('sha256').update(String(origin)).digest('hex').slice(0, 32);
/**
 * The default store: files, laid out as before the seam existed (`file` is following.json; bodies in following-bodies/
 * beside it, `<key>.html`; ledgers in following-ledgers/, `<ledgerName>.json`). A version is the file's inode, size and
 * modification time in nanoseconds; a conditional put compares it just before its atomic rename (a check-then-rename on
 * one machine, so two processes can still race inside that instant: a host that needs better supplies a real
 * compare-and-swap). A state or ledger file that is not JSON is never written over (fsjson's rule).
 */
export function fileStore(file) {
  const dir = path.dirname(file);
  const dirs = { body: path.join(dir, 'following-bodies'), ledger: path.join(dir, 'following-ledgers') };
  const safe = name => String(name).replace(/[^0-9a-f]/g, '');
  const where = (kind, name) => {
    if (kind === 'state') return file;
    if (kind === 'ledger') return path.join(dirs.ledger, `${safe(name)}.json`);
    if (kind === 'body') return path.join(dirs.body, `${safe(name)}.html`);
    throw new Error(`store: no such kind ${kind}`);
  };
  const versionOf = f => {
    try { const s = fs.statSync(f, { bigint: true }); return `${s.ino}-${s.size}-${s.mtimeNs}`; }
    catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  };
  return {
    kind: 'files',
    get(kind, name) {
      const f = where(kind, name);
      const version = versionOf(f);
      if (version === null) return null;
      if (kind === 'body') { try { return { value: fs.readFileSync(f, 'utf8'), version }; } catch { return null; } }
      const got = readJsonState(f);
      if (got.state === 'missing') return null;
      if (got.state === 'unreadable') return { unreadable: got.error, version };
      return { value: got.value, version };
    },
    put(kind, name, value, { ifVersion } = {}) {
      const f = where(kind, name);
      if (kind !== 'body') refuseIfUnreadable(f);
      if (ifVersion !== undefined && versionOf(f) !== ifVersion) throw new StoreConflict(kind, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, kind === 'body' ? String(value) : (typeof value === 'string' ? value : JSON.stringify(value)));
      fs.renameSync(tmp, f);
      return { version: versionOf(f) };
    },
    delete(kind, name) { try { fs.unlinkSync(where(kind, name)); } catch { /* not there */ } },
    list(kind) {
      if (kind === 'state') return fs.existsSync(file) ? ['following'] : [];
      let names = [];
      try { names = fs.readdirSync(dirs[kind]); } catch { return []; }
      const ext = kind === 'body' ? '.html' : '.json';
      // a temp file a crash left behind (older than an hour, so never one being written now) goes
      for (const n of names) {
        if (!/\.tmp\.\d+$/.test(n)) continue;
        try { const p = path.join(dirs[kind], n); if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.unlinkSync(p); } catch { /* gone */ }
      }
      return names.filter(n => n.endsWith(ext)).map(n => n.slice(0, -ext.length));
    },
  };
}
/**
 * A store held in memory, with the same contract (and a real compare-and-swap): for tests, and as the shape a serverless host's
 * blob store takes (state and ledgers as JSON documents, bodies as text, a version per entry). `writes` counts puts per kind.
 */
export function memoryStore() {
  const m = new Map();
  let n = 0;
  const writes = { state: 0, ledger: 0, body: 0 };
  const k = (kind, name) => { if (!STORE_KINDS.includes(kind)) throw new Error(`store: no such kind ${kind}`); return `${kind}/${name}`; };
  return {
    kind: 'memory', writes, entries: m,
    get(kind, name) { const e = m.get(k(kind, name)); return e ? { value: kind === 'body' ? e.text : JSON.parse(e.text), version: e.version } : null; },
    put(kind, name, value, { ifVersion } = {}) {
      const e = m.get(k(kind, name));
      if (ifVersion !== undefined && (e ? e.version : null) !== ifVersion) throw new StoreConflict(kind, name);
      const version = `v${++n}`;
      m.set(k(kind, name), { text: kind === 'body' ? String(value) : (typeof value === 'string' ? value : JSON.stringify(value)), version });
      writes[kind]++;
      return { version };
    },
    delete(kind, name) { m.delete(k(kind, name)); },
    list(kind) { return [...m.keys()].filter(x => x.startsWith(`${kind}/`)).map(x => x.slice(kind.length + 1)); },
  };
}

// The main document, as units a merge can compare: each entry of these maps is one unit, every other top-level member one.
const UNIT_MAPS = ['items', 'blygs', 'kept'];
const SEP = '\u0000';
function unitsOf(doc) {
  const m = new Map();
  for (const [k, v] of Object.entries(doc)) {
    if (UNIT_MAPS.includes(k)) for (const [n, x] of Object.entries(v || {})) m.set(`${k}${SEP}${n}`, JSON.stringify(x));
    else if (v !== undefined) m.set(k, JSON.stringify(v));
  }
  return m;
}
/** The document's JSON, built from its units (so a save serialises each unit once). */
function textOfUnits(units, doc) {
  const parts = [];
  for (const k of Object.keys(doc)) {
    if (UNIT_MAPS.includes(k)) {
      const inner = [];
      for (const n of Object.keys(doc[k] || {})) inner.push(`${JSON.stringify(n)}:${units.get(`${k}${SEP}${n}`)}`);
      parts.push(`${JSON.stringify(k)}:{${inner.join(',')}}`);
    } else if (units.has(k)) parts.push(`${JSON.stringify(k)}:${units.get(k)}`);
  }
  return `{${parts.join(',')}}`;
}
/**
 * A three-way merge of the main document, made when the stored one moved since this engine read it (another process, or
 * another invocation of a serverless host, wrote it meanwhile). Unit by unit: a unit the other writer did not change keeps
 * ours; a unit the other writer changed takes theirs, EVEN IF we changed it too (so the owner's tick in another process is
 * never undone by a refresh here: the refresh's write to that post is dropped, as it is in one process, finding 1). `ours`
 * is changed in place. → how many units of ours were dropped.
 */
export function mergeState(ours, base, theirs) {
  const tu = unitsOf(theirs), ou = unitsOf(ours);
  let dropped = 0;
  for (const key of new Set([...tu.keys(), ...ou.keys(), ...base.keys()])) {
    const b = base.get(key), o = ou.get(key), t = tu.get(key);
    if (t === b) continue;
    if (o !== b && o !== t) dropped++;
    const [top, name] = key.includes(SEP) ? key.split(SEP) : [key, null];
    const v = t === undefined ? undefined : JSON.parse(t);
    if (name === null) { if (v === undefined) delete ours[top]; else ours[top] = v; continue; }
    if (!ours[top] || typeof ours[top] !== 'object') ours[top] = {};
    if (v === undefined) delete ours[top][name]; else ours[top][name] = v;
  }
  return dropped;
}
/**
 * A three-way merge of one ledger: the read ids and the unusable and later-again lists are SETS (what either side added
 * stays, what either side removed goes), the floor and the newest-seen date take the larger, and the rest (backfill mode,
 * queue, returns) takes ours where we changed it and theirs otherwise. `ours` is changed in place.
 */
export function mergeLedger(ours, base, theirs) {
  const setMerge = (o, b, t) => {
    const out = new Map(t);
    for (const [k, v] of o) if (!b.has(k)) out.set(k, v);
    for (const k of b.keys()) if (!o.has(k)) out.delete(k);
    return out;
  };
  const pairs = l => new Map((l.ids || []).map(p => [p[0], p]));
  ours.ids = [...setMerge(pairs(ours), pairs(base), pairs(theirs)).values()];
  for (const k of ['bad', 'later']) {
    ours[k] = Object.fromEntries(setMerge(new Map(Object.entries(ours[k] || {})), new Map(Object.entries(base[k] || {})), new Map(Object.entries(theirs[k] || {}))));
  }
  ours.floor = Math.max(ours.floor || 0, theirs.floor || 0);
  ours.seen_until = Math.max(ours.seen_until || 0, theirs.seen_until || 0);
  for (const k of ['backfill', 'queue', 'returns']) if (JSON.stringify(ours[k]) === JSON.stringify(base[k])) ours[k] = theirs[k];
  return ours;
}

// ---- the engine -----------------------------------------------------------------------
export function createFollowing({ file, store = fileStore(file), get = netGet, now = Date.now, getSettings = () => followingSettingsOf({}).settings,
  mayFetch = () => true, readToken = readTokenFile, tokenWarning = tokenFileWarning, tokenForbidden = [],
  timers = { set: (fn, ms) => setInterval(fn, ms), clear: h => clearInterval(h) }, onChange = () => {} } = {}) {
  let state = null; // { blygs, items (by identOf), last_run, inbox } — the ledgers are documents of their own (ledgerOf)
  let stateVersion = null; // the stored version this engine read or last wrote (StoreConflict when it moved)
  let base = new Map(); // the stored document's units as last read or written: what a merge compares against
  let unreadableState = null; // the stored state could not be read: it is never written over (the store refuses)
  const emptyInbox = () => ({ state: 'off', fetched_at: 0, generated_at: '', count: 0, error: '', never_verified: [], never_verified_count: 0, blocked_count: 0, mentions: [] });
  // A post whose blyg is not followed has no business being held: dropped whenever the state is loaded or saved
  const prune = st => {
    for (const [k, i] of Object.entries(st.items)) if (!st.blygs[i.origin]) delete st.items[k];
  };
  // A blyg's ledger, a document of its own (so a tick or an open does not rewrite every blyg's ids): the ids of its posts the
  // owner ticked, each with the post's `created` (so a post that left the Archive's list is never fetched again as unread),
  // the ids whose document could not be used (with the index's version, so they are not asked for again until it changes),
  // and its backfill mode. Read as untrusted: a hand-edited document is cleaned, bounded and de-duplicated.
  const cleanLedger = raw => {
    const r = raw && typeof raw === 'object' ? raw : {};
    const seenIds = new Set();
    const ids = [];
    for (const x of Array.isArray(r.ids) ? r.ids : []) {
      const [id, c] = typeof x === 'string' ? [x, 0] : Array.isArray(x) ? x : [null, 0];
      if (typeof id !== 'string' || !ID_RE.test(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push([id, Number.isFinite(c) && c > 0 ? Math.floor(c) : 0]);
      if (ids.length >= LIMITS.archiveIdsPerBlyg) break;
    }
    const bad = {};
    if (r.bad && typeof r.bad === 'object' && !Array.isArray(r.bad)) {
      for (const [id, v] of Object.entries(r.bad)) {
        if (Object.keys(bad).length >= LIMITS.badPerBlyg) break;
        const [ver, at] = Array.isArray(v) ? v : [v, now()]; // (a ledger written before bad entries expired kept the version alone)
        if (ID_RE.test(id) && Number.isInteger(ver) && ver >= 1 && Number.isFinite(at)) bad[id] = [ver, at];
      }
    }
    return { ids, bad, backfill: BACKFILL_MODES.includes(r.backfill) ? r.backfill : 'unknown' };
  };
  const ledgers = new Map(); // origin → { led, version, base (its JSON as stored), dirty }
  const ledgerEntry = origin => {
    let e = ledgers.get(origin);
    if (!e) {
      const got = store.get('ledger', ledgerName(origin));
      if (got && got.unreadable) warnUnreadable(`the Hub's ledger of ${origin}`, got.unreadable);
      const raw = got && !got.unreadable && got.value && got.value.origin === origin ? got.value : null;
      const led = cleanLedger(raw);
      e = { led, version: got ? got.version : null, base: JSON.stringify(led), dirty: false };
      ledgers.set(origin, e);
    }
    return e;
  };
  /** A blyg's ledger, to read. */
  const ledgerOf = origin => { load(); return ledgerEntry(origin).led; };
  /** A blyg's ledger, to change: it is written with the next save (and only the ledgers changed are). */
  const ledgerFor = origin => { load(); const e = ledgerEntry(origin); e.dirty = true; return e.led; };
  function writeLedger(origin, e) {
    const name = ledgerName(origin);
    for (let i = 0; ; i++) {
      try {
        e.version = store.put('ledger', name, { origin, ...e.led }, { ifVersion: e.version }).version;
        e.base = JSON.stringify(e.led); e.dirty = false;
        return;
      } catch (err) {
        if (!(err instanceof StoreConflict) || i >= 4) throw err;
        const got = store.get('ledger', name);
        mergeLedger(e.led, JSON.parse(e.base), cleanLedger(got && got.value && got.value.origin === origin ? got.value : null));
        e.version = got ? got.version : null;
      }
    }
  }
  function saveLedgers() {
    for (const [origin, e] of ledgers) {
      if (!e.dirty || !state.blygs[origin]) continue;
      try { writeLedger(origin, e); } catch (err) { if (err && err.code === 'EUNREADABLEJSON') { e.dirty = false; continue; } throw err; }
    }
  }
  const forgetLedger = origin => { ledgers.delete(origin); store.delete('ledger', ledgerName(origin)); };
  // The oldest-ticked archive records beyond the cap are dropped. Their ids stay in their ledgers: that is what keeps them read.
  const trimArchive = st => {
    const arch = Object.entries(st.items).filter(([, i]) => i.read === 'archived');
    if (arch.length <= LIMITS.archiveRecords) return 0;
    arch.sort((a, b) => (Date.parse(a[1].archived_at) || 0) - (Date.parse(b[1].archived_at) || 0));
    const drop = arch.slice(0, arch.length - LIMITS.archiveRecords);
    for (const [k] of drop) delete st.items[k];
    return drop.length;
  };
  const load = () => {
    if (state) return state;
    const got = store.get('state', 'following');
    if (got && got.unreadable) { unreadableState = got.unreadable; warnUnreadable(file || 'the Hub state', got.unreadable); }
    stateVersion = got ? got.version : null;
    const v = got && got.value && typeof got.value === 'object' && !Array.isArray(got.value) ? got.value : {};
    base = unitsOf(v);
    state = { blygs: v.blygs && typeof v.blygs === 'object' ? v.blygs : {}, items: v.items && typeof v.items === 'object' ? v.items : {},
      last_run: v.last_run || null, inbox: { ...emptyInbox(), ...(v.inbox && typeof v.inbox === 'object' ? v.inbox : {}) } };
    // a hand-edited record never makes the engine fetch something the reader paused
    for (const b of Object.values(state.blygs)) if (!BLYG_STATES.includes(b.state)) b.state = 'paused';
    for (const i of Object.values(state.items)) {
      if (i.read === 'seen' || !READ_STATES.includes(i.read)) i.read = 'new'; // a document from before the Archive: `seen` posts stay in the Feed
      if (!IDENTITY_STATES.includes(i.identity)) i.identity = 'unverified';
      if (!LAST_CHANGES.includes(i.last_change)) i.last_change = 'new-words';
      if (!i.key) i.key = randomKey();
    }
    // A document written before the ledgers were split out kept them inside it: each becomes a ledger document of its own
    // (written with the next save), unless one is already stored.
    const old = v.ledgers && typeof v.ledgers === 'object' ? v.ledgers : {};
    for (const [o, raw] of Object.entries(old)) {
      if (!state.blygs[o] || store.get('ledger', ledgerName(o))) continue;
      const led = cleanLedger(raw);
      ledgers.set(o, { led, version: null, base: JSON.stringify(led), dirty: true });
    }
    if (!INBOX_STATES.includes(state.inbox.state)) state.inbox.state = 'off';
    for (const m of state.inbox.mentions) { if (!MENTION_READ.includes(m.read)) m.read = 'seen'; if (!m.key) m.key = randomKey(); }
    prune(state);
    trimArchive(state);
    queueMicrotask(() => { try { sweepBodies(); } catch { /* nothing to sweep */ } });
    return state;
  };
  /** Write the main document (and the ledgers changed), conditionally on the version read; on a conflict, merge and write again. */
  const save = () => {
    const st = load();
    prune(st);
    for (let i = 0; ; i++) {
      const units = unitsOf(st);
      try {
        stateVersion = store.put('state', 'following', textOfUnits(units, st), { ifVersion: stateVersion }).version;
        base = units; unreadableState = null;
        break;
      } catch (err) {
        if (!(err instanceof StoreConflict) || i >= 4) throw err;
        const got = store.get('state', 'following');
        // deleted meanwhile (the owner removed the file): what this engine holds is written again, as before the seam
        if (!got) { stateVersion = null; base = new Map(); continue; }
        if (got.unreadable || !got.value || typeof got.value !== 'object') throw err;
        mergeState(st, base, got.value);
        base = unitsOf(got.value); stateVersion = got.version;
        prune(st);
      }
    }
    saveLedgers();
  };
  // The sanitised body of each post is a 'body' of its own in the store (so the main document stays small and each body is
  // written whole), named by the record's random key, and is swept away with its post.
  const hasBody = key => !!store.get('body', key);
  const deleteBody = key => store.delete('body', key);
  const writeBody = (key, html) => store.put('body', key, String(html));
  // read back through the sanitiser again: a file edited by hand is no more trusted than the web
  const readBodyHtml = key => {
    const got = store.get('body', key);
    if (!got || typeof got.value !== 'string') return '';
    return sanitizeStable(got.value, { max: LIMITS.bodyBytes + 4096, truncate: true, landmarks: false }).html;
  };
  function sweepBodies() {
    const keep = new Set(Object.values(load().items).filter(i => i.kind !== 'withdrawn' && i.read !== 'archived').map(i => i.key));
    let n = 0;
    for (const name of store.list('body')) if (!keep.has(name)) { deleteBody(name); n++; }
    return n;
  }
  const run = { state: 'idle' };
  const schedule = { mode: 'off' };
  let handle; // the timer's handle: meaningful only while schedule.mode is 'scheduled'
  const breakers = new Map(); // host → { state, failures, until }
  const breakerOf = host => { if (!breakers.has(host)) breakers.set(host, { state: 'closed', failures: 0, until: 0 }); return breakers.get(host); };
  const breakerAllows = host => {
    const b = breakerOf(host);
    if (b.state === 'open' && now() >= b.until) moveBreaker(b, 'cool');
    return b.state !== 'open';
  };
  const breakerOk = host => { const b = breakerOf(host); if (b.state !== 'open') { moveBreaker(b, 'ok'); b.failures = 0; } };
  const breakerFail = host => {
    const b = breakerOf(host);
    b.failures++;
    if (b.state === 'half-open' || b.failures >= BREAKER.threshold) { if (b.state !== 'open') moveBreaker(b, 'trip'); b.until = now() + BREAKER.cooldownMs; }
  };

  // The ONLY place a request is made: refused when fetching is off, counted against the
  // budget, refused by an open breaker, judged by the guard (get = netguard's guardedGet).
  const getter = budget => async (url, { maxBytes, accept = 'application/json', timeoutMs = LIMITS.timeoutMs, headers } = {}) => {
    if (!mayFetch()) throw new FetchTrouble('off', 'fetching is off (blyg_checks)');
    const host = hostOf(url);
    if (!breakerAllows(host)) throw new FetchTrouble('breaker', `${host} failed too often; not asked again for a while`);
    budget.take();
    let r;
    try { r = await get(String(url), { maxBytes, accept, timeoutMs: Math.max(1, Math.min(timeoutMs, budget.left())), ...(headers ? { headers } : {}) }); }
    catch (e) { if (!e || e.kind !== 'refused') breakerFail(host); throw e; }
    if (Number(r.status) >= 500) breakerFail(host); else breakerOk(host);
    return r;
  };
  // → { status: 'ok', json, url } | { status: 'absent', code } | { status: 'trouble', kind, message }
  const fetchJson = async (g, url, maxBytes) => {
    let r;
    try { r = await g(url, { maxBytes }); }
    catch (e) { return { status: 'trouble', kind: (e && e.kind) || 'network', message: cleanText(String((e && e.message) || 'could not fetch'), 200) }; }
    const code = Number(r.status) || 0;
    if (code >= 500) return { status: 'trouble', kind: 'network', message: `HTTP ${code}` };
    if (code < 200 || code >= 300) return { status: 'absent', code };
    try { const j = JSON.parse(String(r.text ?? '')); return j && typeof j === 'object' ? { status: 'ok', json: j, url: String(r.url || url) } : { status: 'absent', code }; }
    catch { return { status: 'absent', code }; }
  };

  const settings = () => getSettings();
  const itemsOf = origin => Object.values(load().items).filter(i => i.origin === origin);
  const heldItem = (origin, id) => load().items[identOf(origin, id)];
  const byKey = key => Object.values(load().items).find(i => i.key === key) || null;
  const copy = v => (v === null || v === undefined ? v : structuredClone(v));

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
    st.blygs[origin] = { origin, title: cleanText(title, 200), author: cleanText(author, 200), state: 'active', added: new Date(now()).toISOString(),
      via, failures: 0, absent_runs: 0, retry_after: 0, last_try: 0, last_ok: 0, last_error: '' };
    return true;
  }
  async function follow(url) {
    if (!originOfUrl(url)) throw new Error('that is not a web address');
    const g = getter(newBudget({ following_run_requests: LIMITS.followRequests, following_run_seconds: 30 }, now));
    const r = await resolve(String(url), g);
    if (r.trouble) throw new Error(`could not ask that site: ${r.trouble}`);
    if (r.none) throw new Error('no Blygger manifest was found there');
    const added = addBlyg({ ...r, via: 'url' });
    save(); reschedule(); onChange();
    return { ...r, added };
  }
  function unfollow(origin) {
    const st = load();
    if (!st.blygs[origin]) return false;
    delete st.blygs[origin];
    forgetLedger(origin);
    save(); sweepBodies(); reschedule(); onChange(); // save() prunes its posts
    return true;
  }
  function setBlygState(origin, ev) {
    const b = load().blygs[origin];
    if (!b) throw new Error('not followed');
    moveBlyg(b, ev);
    if (ev === 'resume') { b.failures = 0; b.absent_runs = 0; b.retry_after = 0; }
    save(); onChange();
    return b.state;
  }
  const listBlygs = () => Object.values(load().blygs).map(b => ({ ...b, items: unreadOf(b.origin),
    archived: itemsOf(b.origin).filter(i => i.read === 'archived').length, backfill: ledgerOf(b.origin).backfill }));

  // ---- importing a blogroll or directory ----
  /** What WOULD be added from OPML or a directory document (a URL, or pasted text). Adds nothing. */
  async function previewImport({ url = '', text = '' } = {}) {
    const budget = newBudget({ following_run_requests: LIMITS.importRequests, following_run_seconds: 120 }, now);
    const g = getter(budget);
    let body = String(text || '');
    if (!body.trim()) {
      if (!originOfUrl(url)) throw new Error('give a web address or paste the document');
      try { body = String((await g(String(url), { maxBytes: LIMITS.importBytes, accept: 'text/x-opml, application/xml, application/json, */*' })).text || ''); }
      catch (e) { throw new Error(`could not fetch that: ${cleanText(String(e && e.message), 200)}`); }
    }
    const head = body.trimStart()[0];
    const have = new Set(Object.keys(load().blygs));
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
  }
  /** Add exactly the origins the reader confirmed. */
  function confirmImport(entries) {
    const added = [], skipped = [];
    for (const e of Array.isArray(entries) ? entries.slice(0, LIMITS.followMax) : []) {
      const origin = originOf(e && e.origin);
      if (!origin || urlRefusal(origin)) { skipped.push(String(e && e.origin || '').slice(0, 200)); continue; }
      try { if (addBlyg({ origin, title: e.title, author: e.author, via: 'import' })) added.push(origin); else skipped.push(origin); }
      catch { skipped.push(origin); }
    }
    if (added.length) { save(); reschedule(); onChange(); }
    return { added, skipped };
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
    moveBlyg(b, 'fail');
    b.retry_after = now() + backoffMs(b.failures);
  }
  const tombstone = (held, e) => ({ key: held.key || randomKey(), origin: held.origin, id: held.id, kind: 'withdrawn', version: e.version, index_version: e.version,
    created: held.created, updated: e.updated || held.updated, fetched_at: now(), page: held.page, content_hash: held.content_hash, read: held.read || 'new',
    identity: held.identity || 'unverified', last_change: 'new-words', stub_of: null, transclusions: 0, links: 0, refs: [], ref_origins: [],
    title: '', excerpt: '', text: '', text_chars: 0, author: '', versions: [], first_seen: held.first_seen, maintenance: 0 });
  // What the caps and the target count: UNREAD held posts. A withdrawn marker costs nothing; an archived record is not held text.
  const isUnreadHeld = i => !isWithdrawn(i) && i.read !== 'archived';
  const totalItems = () => Object.values(load().items).filter(isUnreadHeld).length;
  const unreadOf = origin => itemsOf(origin).filter(isUnreadHeld).length;
  /** The Feed's count: what the Feed tab shows (bursts folded, paused blygs and Background left out). */
  const unreadCount = () => { const st = load(); return buildView({ items: Object.values(st.items), blygs: st.blygs }).tabs.feed; };
  const itemUrlFor = (manifest, origin, id) => {
    const t = typeof manifest.item === 'string' && manifest.item ? manifest.item : 'items/{id}.json';
    try { return new URL(t.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(k === 'id' ? id : '')), origin).href; } catch { return ''; }
  };
  function halt(b, r, tally) {
    // out of budget, fetching off, or the host's breaker is open: not the blyg's fault, no mark against it
    if (r.kind === 'limit' || r.kind === 'breaker' || r.kind === 'off') { tally.deferred++; return; }
    noteFailure(b, 'trouble', r.message); tally.unreachable++;
  }
  const NOT_THE_BLYGS_FAULT = ['limit', 'breaker', 'off'];

  /**
   * Fetch ONE item document and check it as every document is checked: inside the blyg's own origin (also after redirects), its
   * id and origin the ones asked for, a kind and a page this code knows. → { out: 'ok', doc, rec, body } or { out }, `out` being
   * 'unusable' (answered, and cannot be used), 'trouble' (could not be asked, or out of budget: try again later) or 'aborted'
   * (the reader unfollowed the blyg meanwhile).
   */
  async function pull(b, id, g, tally, alive) {
    const url = itemUrlFor({ item: b.item_template }, b.origin, id);
    if (!isWebUrl(url)) { tally.invalid++; return { out: 'unusable' }; }
    if (!within(b.origin, url)) { b.last_error = REFUSALS.item; tally.refused++; return { out: 'unusable' }; }
    const r = await fetchJson(g, url, LIMITS.itemBytes);
    if (!alive()) { tally.aborted++; return { out: 'aborted' }; }
    if (r.status === 'trouble') { if (NOT_THE_BLYGS_FAULT.includes(r.kind)) tally.deferred++; else tally.errors++; return { out: 'trouble', message: r.message }; }
    if (r.status === 'ok' && !within(b.origin, r.url)) { b.last_error = REFUSALS.redirect; tally.refused++; return { out: 'unusable' }; }
    const doc = r.json;
    if (r.status !== 'ok' || docRefusal(doc, { id, origin: b.origin })) { tally.invalid++; return { out: 'unusable' }; }
    const rec = recordFromDoc(doc, b.origin, b);
    if (rec.invalid) { tally.invalid++; return { out: 'unusable' }; }
    return { out: 'ok', doc, rec, body: bodyOf(doc) };
  }
  const iso = () => new Date(now()).toISOString();
  const dropArchivedId = (origin, id) => { const led = ledgerFor(origin); const i = led.ids.findIndex(p => p[0] === id); if (i >= 0) led.ids.splice(i, 1); };
  /** A document that cannot be used is remembered (with the version the index gave) so it is not asked for again until the index changes. At the bound the blyg is stopped. */
  function markBad(led, e) {
    if (led.bad[e.id] === undefined && Object.keys(led.bad).length >= LIMITS.badPerBlyg) { moveBackfill(led, 'stop'); return; }
    led.bad[e.id] = [e.version, now()];
  }
  /**
   * Fetch one post's document and put it in the list. `held` is what is held for it (a post in the Feed, an archive record, a
   * withdrawn marker) or undefined. → 'stored' | 'kept' | 'unusable' | 'trouble' | 'aborted' | 'deferred'
   *
   * RE-READ AFTER THE AWAIT (finding 1 of the gate review, and the rule for every async function here): the record this fetch
   * started from is compared with the one held when the answer comes back. If it is not the same object (the owner ticked,
   * unticked or otherwise replaced it meanwhile, or a merge brought in another process's change), nothing is written and the
   * post is counted as deferred: the next refresh looks at it again. A change made IN PLACE meanwhile (opening it, a note for
   * it) keeps the object, and is kept, because everything written is worked out from the record as it is after the await.
   */
  async function ingest(b, e, held, cfg, g, tally, alive) {
    const ident = identOf(b.origin, e.id);
    if (load().items[ident] !== held) { tally.deferred++; return 'deferred'; }
    const got = await pull(b, e.id, g, tally, alive);
    if (got.out !== 'ok') return got.out;
    const st = load();
    if (st.items[ident] !== held) { tally.raced++; tally.deferred++; return 'deferred'; }
    const { doc, rec, body } = got;
    if (held && rec.version < held.version) { tally.regressions++; return 'kept'; }
    if (doc.version !== e.version) tally.mismatched++;
    rec.body_state = body.state;
    const common = { index_version: e.version, fetched_at: now() };
    const mismatch = doc.version === e.version ? {} : { index_mismatch: { index: e.version, document: doc.version } };
    const archived = held && held.read === 'archived';
    if (isWithdrawn(rec)) {
      if (archived) { held.index_version = e.version; return 'kept'; } // read, and stays in the Archive
      st.items[ident] = { ...tombstone(held || { ...rec, key: randomKey() }, rec), index_version: e.version }; tally.withdrawn++; return 'stored';
    }
    const change = changeOf(held, rec, cfg.following_barely_changed_percent);
    if (!held || isWithdrawn(held)) {
      st.items[ident] = { ...rec, ...common, key: (held && held.key) || randomKey(), read: 'new', identity: 'unverified', first_seen: iso(), maintenance: 0, last_change: 'new-words', ...mismatch };
      tally.new++;
    } else if (archived) {
      if (change === 'maintenance') { // the same words: it stays read
        Object.assign(held, { version: rec.version, ...common }); tally.maintenance++; return 'stored';
      }
      // The words may have changed and no text is kept to measure by, so it is not "barely changed" (changeOf): back to the Feed.
      const back = { ...rec, ...common, key: held.key, read: held.read, identity: 'unverified', first_seen: iso(), last_change: 'new-words', maintenance: 0,
        edited_after_read: held.version, ...mismatch };
      moveRead(back, 'reopen');
      st.items[ident] = back; dropArchivedId(b.origin, e.id); tally.edited++;
    } else {
      const next = { ...held, ...rec, ...common, key: held.key, read: held.read, identity: held.identity, first_seen: held.first_seen, last_change: change,
        maintenance: (held.maintenance || 0) + (change === 'maintenance' ? 1 : 0) };
      if (doc.version === e.version) delete next.index_mismatch; else next.index_mismatch = { index: e.version, document: doc.version };
      st.items[ident] = next;
      if (change === 'maintenance') tally.maintenance++;
      else if (change === 'minor') tally.minor++;
      else { if (canMoveRead(next, 'resurface')) moveRead(next, 'resurface'); tally.edited++; }
    }
    // the body is kept with the post: rewritten when the words changed, or when it is not there
    const bk = st.items[ident].key;
    if (change !== 'maintenance' || !hasBody(bk)) writeBody(bk, body.html);
    return 'stored';
  }

  /** One blyg: manifest, index, diff, changed documents. Stops, leaving no trace, if the reader unfollows it meanwhile. */
  async function reconcileBlyg(b, g, cfg, tally) { // → the plan for the backfill, or undefined
    const st = load();
    const alive = () => load().blygs[b.origin] === b;
    b.last_try = now();
    const man = await fetchJson(g, new URL('blyg.json', b.origin).href, LIMITS.manifestBytes);
    if (!alive()) { tally.aborted++; return; }
    if (man.status === 'trouble') return halt(b, man, tally);
    if (man.status !== 'ok' || !isManifest(man.json) || identityOf(man.url) !== b.origin) {
      noteFailure(b, 'absent', 'it has no manifest at its origin'); tally.absent++; return;
    }
    b.title = cleanText(man.json.title, 200) || b.title;
    // the item template says where the blyg keeps its item documents, and a post's page record may be kept under that address:
    // a template that leads outside the blyg's own origin is refused (named), and the default is used instead
    let templateRefused = false;
    const template = typeof man.json.item === 'string' ? cleanText(man.json.item, 300) : '';
    if (template && !within(b.origin, itemUrlFor({ item: template }, b.origin, '0'.repeat(26)))) { b.item_template = ''; delete man.json.item; templateRefused = true; tally.refused++; }
    else b.item_template = template;
    b.author = cleanText(man.json.author && man.json.author.name, 200) || b.author;
    let indexUrl;
    try { indexUrl = new URL(typeof man.json.items === 'string' && man.json.items ? man.json.items : 'items/index.json', b.origin).href; } catch { indexUrl = ''; }
    if (!isWebUrl(indexUrl)) { noteFailure(b, 'absent', 'its items index is not a web address'); tally.absent++; return; }
    if (!within(b.origin, indexUrl)) { b.last_error = REFUSALS.index; tally.refused++; return; }
    const idx = await fetchJson(g, indexUrl, LIMITS.indexBytes);
    if (!alive()) { tally.aborted++; return; }
    if (idx.status === 'trouble') return halt(b, idx, tally);
    if (idx.status === 'ok' && !within(b.origin, idx.url)) { b.last_error = REFUSALS.redirect; tally.refused++; return; }
    if (idx.status !== 'ok' || !Array.isArray(idx.json.items)) { noteFailure(b, 'absent', 'it has no items index'); tally.absent++; return; }
    // the manifest and the index answered: this blyg is reachable and present
    if (canMoveBlyg(b, 'recover')) moveBlyg(b, 'recover');
    b.failures = 0; b.absent_runs = 0; b.retry_after = 0; b.last_error = templateRefused ? REFUSALS.item : ''; b.last_ok = now();

    // What is read out of the index (hostile input): at most `indexEntries` entries, a well-formed 26-character id (a string, not
    // something that prints as one), a kind and a version this code knows. An id listed twice is ONE post, at its highest version.
    // Nothing of the index is stored: only what is fetched from it, so what is kept per blyg is bounded by the caps below and by the ledger.
    const led = ledgerFor(b.origin);
    const raw = idx.json.items;
    const byId = new Map();
    for (const x of raw.slice(0, LIMITS.indexEntries)) {
      if (x && typeof x.id === 'string' && ID_RE.test(x.id) && KINDS.includes(x.kind) && Number.isInteger(x.version) && x.version >= 1) {
        const prev = byId.get(x.id);
        if (!prev || x.version > prev.version) byId.set(x.id, { id: x.id, kind: x.kind, version: x.version, created: cleanText(x.created, 40), updated: cleanText(x.updated, 40) });
      }
    }
    // newest first: a blyg is read backwards in time
    const entries = [...byId.values()].sort((a, c) => (Date.parse(c.updated) || 0) - (Date.parse(a.updated) || 0) || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
    const inIndex = new Set(entries.map(e => e.id));
    const archivedIds = new Set(led.ids.map(p => p[0]));
    // A held unread post the index no longer lists is dropped (the index lists every post ever published, §6.2), unless the index was
    // cut at `indexEntries`, when its absence proves nothing. An archive record stays: it is the owner's record of having read it.
    if (raw.length <= LIMITS.indexEntries) {
      for (const i of itemsOf(b.origin)) if (i.read !== 'archived' && !inIndex.has(i.id)) { delete st.items[identOf(i.origin, i.id)]; tally.removed++; }
    }
    // The newest entry that is already known (held, archived, or an unusable document) bounds what is FRESH (newer than it:
    // published since, fetched now, within the caps); what lies beyond it is BACKFILL, fetched only while the Feed is short.
    const known = e => !!st.items[identOf(b.origin, e.id)] || archivedIds.has(e.id) || led.bad[e.id] !== undefined;
    let edge = -1;
    entries.forEach((e, i) => { if (known(e)) edge = i; });
    const plan = { b, led, backfill: [], left: 0, docs: 0 };
    for (const [n, e] of entries.entries()) {
      const ident = identOf(b.origin, e.id);
      const held = st.items[ident];
      if (!held) {
        // withdrawn items are never fetched; ticked ones are read; an unusable one waits for the index to name a new version
        if (e.kind === 'withdrawn' || archivedIds.has(e.id) || (led.bad[e.id] && led.bad[e.id][0] === e.version) || led.backfill === 'stopped') continue;
        if (n > edge) { plan.backfill.push(e); continue; }
        if (unreadOf(b.origin) >= cfg.following_max_items_per_blyg || totalItems() >= cfg.following_max_items_total) { tally.capped++; plan.left++; continue; }
        if (plan.docs >= LIMITS.docsPerBlygRun || g.budget.spent()) { tally.deferred++; plan.left++; continue; }
        plan.docs++;
        const out = await ingest(b, e, undefined, cfg, g, tally, alive);
        if (out === 'aborted') return;
        if (out === 'unusable') markBad(led, e); else if (out === 'trouble' || out === 'deferred') plan.left++;
        continue;
      }
      // what the INDEX said last time we looked: a document that disagrees with its index entry
      // (an index that lies about versions) is not fetched again until the entry changes
      const was = held.index_version ?? held.version;
      if (e.version === was && (e.kind === 'withdrawn') === isWithdrawn(held)) continue;
      if (e.version < was) { tally.regressions++; continue; } // §13.3: a lower version is not adopted
      if (e.kind === 'withdrawn') {
        if (held.read === 'archived') { held.index_version = e.version; continue; } // read: it stays in the Archive
        st.items[ident] = tombstone(held, e); if (!isWithdrawn(held)) tally.withdrawn++;
        continue;
      }
      if (plan.docs >= LIMITS.docsPerBlygRun || g.budget.spent()) { tally.deferred++; continue; }
      plan.docs++;
      if (await ingest(b, e, held, cfg, g, tally, alive) === 'aborted') return;
    }
    return plan;
  }

  /**
   * The backfill: while the Feed holds fewer than `following_unread_target` unread posts, fetch the posts the blygs' indexes list that are
   * neither held, archived, withdrawn nor unusable. ORDER: round-robin over the blygs (the one backfilled longest ago goes first, so the
   * odd one out moves on from run to run), ONE post per blyg per round, and within a blyg its newest not yet fetched first, so each blyg
   * is read backwards in time. It stops when the target is met EXACTLY, when the run's budget is spent, or when the caps are reached;
   * what is left waits for the next refresh (no error, nothing marked against the blyg). All requests go through the run's one getter.
   */
  async function backfill(plans, g, cfg, tally) {
    const turn = plans.filter(p => load().blygs[p.b.origin] === p.b && p.led.backfill !== 'stopped' && p.backfill.length)
      .sort((a, c) => (a.b.last_backfill || 0) - (c.b.last_backfill || 0));
    let unread = unreadCount(), moved = true;
    rounds: while (moved && unread < cfg.following_unread_target && !g.budget.spent()) {
      moved = false;
      for (const p of turn) {
        if (unread >= cfg.following_unread_target || g.budget.spent()) break rounds;
        if (p.led.backfill === 'stopped' || !p.backfill.length || p.docs >= LIMITS.docsPerBlygRun) continue;
        if (totalItems() >= cfg.following_max_items_total) break rounds;
        if (unreadOf(p.b.origin) >= cfg.following_max_items_per_blyg) continue;
        const e = p.backfill.shift();
        p.b.last_backfill = now();
        p.docs++;
        moved = true;
        const out = await ingest(p.b, e, undefined, cfg, g, tally, () => load().blygs[p.b.origin] === p.b);
        if (out === 'aborted') p.backfill = [];
        else if (out === 'unusable') markBad(p.led, e);
        else if (out === 'trouble' || out === 'deferred') p.left++;
        else if (out === 'stored') tally.backfilled++;
        unread = unreadCount();
      }
    }
    // What is left is deferred, not failed: counted by why it was left (the run's budget or per-blyg document cap; or a holding cap).
    for (const p of turn) {
      if (!p.backfill.length || p.led.backfill === 'stopped') continue;
      if (unreadOf(p.b.origin) >= cfg.following_max_items_per_blyg || totalItems() >= cfg.following_max_items_total) tally.capped += p.backfill.length;
      else if (unread < cfg.following_unread_target) tally.deferred += p.backfill.length;
    }
  }
  /** A blyg's backfill mode after a run: more to fetch, or caught up. (A stopped blyg stays stopped.) */
  function settle(plan) {
    if (plan.led.backfill === 'stopped' || load().blygs[plan.b.origin] !== plan.b) return;
    moveBackfill(plan.led, plan.backfill.length + plan.left > 0 ? 'remain' : 'finish');
  }

  // ---- the mentions inbox ----
  // What the inbox's state should be given the settings and whether fetching is allowed: set, paused and unset are
  // decided here, once; asking it is refreshInbox's.
  function syncInbox(cfg) {
    const box = load().inbox;
    if (!cfg.inbox_api_url) { if (box.state !== 'off') moveInbox(box, 'unset'); return box; }
    if (box.state === 'off') moveInbox(box, 'set');
    if (!mayFetch()) { if (box.state !== 'paused') moveInbox(box, 'pause'); }
    else if (box.state === 'paused') moveInbox(box, 'set');
    return box;
  }
  async function refreshInbox(g, cfg) {
    const box = syncInbox(cfg);
    const url = cfg.inbox_api_url;
    if (!url) { box.mentions = []; return; }
    if (box.state === 'paused') return;
    box.fetched_at = now();
    let token;
    try { token = readToken(cfg.inbox_token_file, tokenForbidden); }
    catch (e) { moveInbox(box, 'deny'); box.error = cleanText(String(e && e.message), 200); return; }
    const redact = redactor(token);
    let r, thrown = null;
    try { r = await g(url, { maxBytes: LIMITS.inboxBytes, accept: 'application/json', headers: { authorization: `Bearer ${token}` } }); }
    catch (e) { thrown = e; }
    // re-read after the await: if the inbox was unset, paused or set to another address meanwhile (or replaced by a merge), this
    // answer is about an inbox that is no longer the one set, and nothing is written
    if (load().inbox !== box || box.state === 'off' || box.state === 'paused' || settings().inbox_api_url !== url) return;
    if (thrown) {
      const e = thrown;
      if (e && (e.kind === 'limit' || e.kind === 'breaker' || e.kind === 'off')) return; // not asked: the state stays what it was
      moveInbox(box, 'fail'); box.error = cleanText(redact(String((e && e.message) || 'could not fetch')), 200); return;
    }
    // the answer must come from the inbox's own origin, after any redirects
    let sameOrigin = false;
    try { sameOrigin = new URL(String(r.url || url)).origin === new URL(url).origin; } catch { sameOrigin = false; }
    if (!sameOrigin) { moveInbox(box, 'fail'); box.error = 'the inbox answered from another origin than the one set'; return; }
    const code = Number(r.status) || 0;
    if (code === 401 || code === 403) { moveInbox(box, 'deny'); box.error = `the inbox answered ${code}`; return; }
    if (code < 200 || code >= 300) { moveInbox(box, 'fail'); box.error = `the inbox answered ${code}`; return; }
    let parsed;
    try {
      const json = JSON.parse(String(r.text ?? ''));
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
      // the token is replaced everywhere in the document BEFORE anything is read out of it or clipped
      parsed = parseInbox(scrubDeep(json, token), redact, LIMITS.mentionsKept);
    } catch { moveInbox(box, 'garble'); box.error = 'the inbox did not answer with a JSON object this code can read'; return; }
    const old = new Map(box.mentions.map(m => [m.ident, m]));
    box.mentions = parsed.mentions.map(m => { const o = old.get(m.ident); return { ...m, key: o ? o.key : randomKey(), read: o ? o.read : 'unseen' }; });
    Object.assign(box, { generated_at: parsed.generated_at, count: parsed.count, never_verified: parsed.never_verified,
      never_verified_count: parsed.never_verified_count, blocked_count: parsed.blocked_count, error: '' });
    moveInbox(box, 'succeed');
  }

  /** Refresh every blyg that is due, and the inbox. At most one run at a time; a second ask while one is going is refused, not queued. */
  async function refresh({ reason = 'demand' } = {}) {
    if (!mayFetch()) { syncInbox(settings()); return { started: false, reason: 'fetching is off (blyg_checks), so nothing was asked' }; }
    if (run.state !== 'idle') return { started: false, reason: 'a refresh is already running' };
    moveRun(run, 'begin');
    const cfg = settings();
    const budget = newBudget(cfg, now);
    const g = getter(budget); g.budget = budget;
    const tally = { reason, new: 0, edited: 0, minor: 0, maintenance: 0, withdrawn: 0, removed: 0, regressions: 0, capped: 0, deferred: 0,
      errors: 0, invalid: 0, absent: 0, unreachable: 0, refused: 0, mismatched: 0, aborted: 0, raced: 0, blygs: 0, skipped: 0, requests: 0, backfilled: 0 };
    const plans = [];
    try {
      const todo = Object.values(load().blygs).filter(due).sort((a, b) => (a.last_try || 0) - (b.last_try || 0));
      tally.skipped = Object.keys(load().blygs).length - todo.length;
      for (const b of todo) {
        if (budget.spent()) { tally.deferred++; continue; }
        try { const plan = await reconcileBlyg(b, g, cfg, tally); if (plan) plans.push(plan); tally.blygs++; }
        catch (e) { tally.errors++; console.warn(`[following] ${cleanText(String(e && e.message), 200)}`); }
        // Saved every `saveEveryBlygs` blygs and at the end, not after each one. A crash mid-run loses at most the progress of
        // the blygs since the last save (their bodies, already written, are swept as orphans on the next load); nothing the
        // owner did is lost, since every move of the owner's saves at once.
        if (tally.blygs % LIMITS.saveEveryBlygs === 0) save();
      }
      try { await backfill(plans, g, cfg, tally); } catch (e) { tally.errors++; console.warn(`[following] ${cleanText(String(e && e.message), 200)}`); }
      for (const p of plans) settle(p);
      save();
      try { await refreshInbox(getter(newBudget({ following_run_requests: 3, following_run_seconds: 30 }, now)), cfg); } catch (e) { tally.errors++; console.warn(`[following] inbox: ${cleanText(String(e && e.message), 200)}`); }
      tally.requests = budget.requests;
      load().last_run = { ...tally, at: new Date(now()).toISOString() };
      save();
      sweepBodies();
    } finally { moveRun(run, 'end'); }
    onChange();
    return { started: true, ...tally };
  }

  // ---- the timer ----
  // Armed while there is something to refresh (a followed blyg, or an inbox set) and fetching is allowed.
  function reschedule() {
    const want = mayFetch() && (Object.keys(load().blygs).length > 0 || !!settings().inbox_api_url);
    if (schedule.mode === 'scheduled') timers.clear(handle);
    handle = undefined;
    if (!want) { if (schedule.mode === 'scheduled') moveSchedule(schedule, 'disarm'); return schedule.mode; }
    moveSchedule(schedule, 'arm');
    handle = timers.set(() => {
      // fetching turned off since: the timer disarms itself rather than ticking on
      if (!mayFetch()) { reschedule(); return; }
      refresh({ reason: 'timer' }).catch(e => console.warn(`[following] ${e.message}`));
    }, settings().following_refresh_minutes * 60 * 1000);
    if (handle && handle.unref) handle.unref();
    return schedule.mode;
  }

  // ---- reading state, identity ----
  /** The small record an archived post keeps: no text, no body. ≤ ~0.5 KB. */
  const archiveRecordOf = rec => ({
    key: rec.key, origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.version, index_version: rec.index_version ?? rec.version,
    created: rec.created, updated: rec.updated, fetched_at: rec.fetched_at, page: cleanText(rec.page, 500), content_hash: rec.content_hash,
    title: cleanText(plainText(rec.title) || plainText(rec.excerpt), LIMITS.archiveTitleChars), text: '', text_chars: 0, read: rec.read, archived_at: iso(),
  });
  /** The owner's tick: the post leaves the Feed (its text is deleted, a small record stays) and its id is remembered in its blyg's ledger. */
  function tickRec(rec) {
    const st = load();
    const next = archiveRecordOf(rec);
    moveRead(next, 'tick'); // refuses a post that is archived already
    st.items[identOf(rec.origin, rec.id)] = next;
    deleteBody(rec.key);
    const led = ledgerFor(rec.origin);
    if (!led.ids.some(p => p[0] === rec.id)) {
      const all = Object.keys(st.blygs).reduce((n, o) => n + ledgerOf(o).ids.length, 0);
      // At the bound the id cannot be remembered, so the blyg is STOPPED: nothing new is fetched from it, which is what keeps this post read.
      if (led.ids.length >= LIMITS.archiveIdsPerBlyg || all >= LIMITS.archiveIdsTotal) moveBackfill(led, 'stop');
      else led.ids.push([rec.id, Math.max(0, stamp(rec.created, now()))]);
    }
  }
  function readMove(key, ev) {
    const rec = byKey(key);
    if (!rec || isWithdrawn(rec)) throw new Error('no such post');
    if (ev === 'tick') { tickRec(rec); trimArchive(load()); } else moveRead(rec, ev);
    save(); onChange();
    return load().items[identOf(rec.origin, rec.id)].read;
  }
  /** Tick every post named (the page's "Tick all shown" names the keys it shows); a key that cannot be ticked is skipped. → how many were. */
  function tickMany(keys) {
    let n = 0;
    const st = load();
    const index = new Map(Object.values(st.items).map(i => [i.key, i]));
    for (const k of (Array.isArray(keys) ? keys : []).slice(0, LIMITS.tickBatch)) {
      const rec = index.get(String(k));
      if (!rec || isWithdrawn(rec) || !canMoveRead(rec, 'tick')) continue;
      tickRec(rec); n++;
    }
    if (n) { trimArchive(st); save(); onChange(); }
    return n;
  }
  /**
   * The owner's untick: the post goes back to the Feed as `new`. Its text was deleted when it was ticked, so it is fetched again (one
   * request, through the same guarded getter and the same checks); if that fails the post stays in the Archive and the error says why.
   */
  async function untick(key) {
    const rec = byKey(key);
    if (!rec) throw new Error('no such post');
    if (!canMoveRead(rec, 'untick')) throw new Error('that post is not in the Archive');
    if (!mayFetch()) throw new Error('fetching is off (blyg_checks), so the post cannot be fetched again');
    const b = load().blygs[rec.origin];
    if (!b) throw new Error('that blyg is not followed');
    const tally = { deferred: 0, errors: 0, invalid: 0, refused: 0, aborted: 0 };
    const g = getter(newBudget({ following_run_requests: 3, following_run_seconds: 30 }, now));
    const got = await pull(b, rec.id, g, tally, () => load().items[identOf(rec.origin, rec.id)] === rec);
    // re-read after the await (pull's own check runs before this function resumes, so it is checked here again)
    if (got.out === 'aborted' || load().items[identOf(rec.origin, rec.id)] !== rec) throw new Error('that post changed meanwhile (it was ticked, unticked or refreshed): look again and retry');
    if (got.out === 'trouble') throw new Error(`could not fetch the post: ${got.message}`);
    if (got.out !== 'ok') throw new Error('the blyg does not serve that post as it was, so it stays in the Archive');
    if (isWithdrawn(got.rec)) throw new Error('that post has been withdrawn');
    const next = { ...got.rec, body_state: got.body.state, index_version: got.rec.version, fetched_at: now(), key: rec.key, read: rec.read,
      identity: 'unverified', first_seen: iso(), maintenance: 0, last_change: 'new-words' };
    moveRead(next, 'untick');
    load().items[identOf(rec.origin, rec.id)] = next;
    dropArchivedId(rec.origin, rec.id);
    writeBody(next.key, got.body.html);
    save(); onChange();
    return next.read;
  }
  /** Is the Feed below its target while some blyg that is not paused has more to read (or has not been read yet)? Worked out, not stored. */
  const wantsTopUp = () => mayFetch() && unreadCount() < settings().following_unread_target
    && Object.values(load().blygs).some(b => b.state === 'active' && ['unknown', 'more'].includes(ledgerOf(b.origin).backfill));
  /** What the page may ask of /following/read: tick (one post, or the keys it shows), untick, or the owner's own "mark new". */
  async function readRequest(data) {
    const d = data && typeof data === 'object' ? data : {};
    if (Array.isArray(d.keys)) { const n = tickMany(d.keys); return { archived: n, unread: unreadCount(), target: settings().following_unread_target }; }
    const move = String(d.move || '');
    if (!['tick', 'untick', 'renew'].includes(move)) throw new Error('move must be tick, untick or renew');
    const read = move === 'untick' ? await untick(String(d.key || '')) : readMove(String(d.key || ''), move);
    return { read, unread: unreadCount(), target: settings().following_unread_target, topup: wantsTopUp() };
  }
  /** A note for this post was exported: its read state becomes `responded`. → false when the post is not on the list, or is archived (only a tick or an untick moves that). */
  function markResponded(origin, id) {
    const rec = heldItem(String(origin), String(id));
    if (!rec || isWithdrawn(rec) || !canMoveRead(rec, 'respond')) return false;
    moveRead(rec, 'respond'); save(); onChange();
    return true;
  }
  function mentionSeen(key) {
    const m = load().inbox.mentions.find(x => x.key === key);
    if (!m) throw new Error('no such mention');
    if (canMoveMention(m, 'see')) { moveMention(m, 'see'); save(); onChange(); }
    return m.read;
  }
  function allMentionsSeen() {
    let n = 0;
    for (const m of load().inbox.mentions) if (canMoveMention(m, 'see')) { moveMention(m, 'see'); n++; }
    if (n) { save(); onChange(); }
    return n;
  }
  /** The post a mention's source address is, when it is on the list. */
  const feedItemFor = m => (m.source_url ? Object.values(load().items).find(i => isUnreadHeld(i) && i.page && samePage(i.page, m.source_url)) || null : null);
  /**
   * Open a post or a mention: the one path. A post becomes `opened`; a mention becomes `seen` (and the post of
   * the list its source is, if any, `opened`). → { url }, the ORIGINAL page. The caller opens it, and Discuss
   * identifies it when the page asks (identityFor), from the list only if the page's own links agree.
   */
  function open(key, version = 0) {
    const rec = byKey(key);
    if (rec) {
      if (isWithdrawn(rec)) throw new Error('no such post');
      // opening a post opens its CURRENT version; a pinned older one only by asking for it, and only if its page can be told
      const pin = version ? pinPageOf(rec, Number(version)) : '';
      if (version && !pin) throw new Error('that version is not pinned, or its page cannot be told from what is held');
      if (canMoveRead(rec, 'open')) { moveRead(rec, 'open'); save(); onChange(); }
      return { url: pin || rec.page, opens_on: hostOf(rec.page) !== hostOf(rec.origin) ? hostOf(rec.page) : '' };
    }
    const m = load().inbox.mentions.find(x => x.key === key);
    if (!m) throw new Error('no such post or mention');
    if (!m.source_url) throw new Error('that mention has no link to open');
    if (canMoveMention(m, 'see')) moveMention(m, 'see');
    const post = feedItemFor(m);
    if (post && canMoveRead(post, 'open')) moveRead(post, 'open');
    save(); onChange();
    return { url: m.source_url, opens_on: '' };
  }

  // ---- reading a post here ----
  /**
   * The address a post's PAGE RECORD is kept under. A post's `page` may be anywhere (§5.8), so it is the key only when it lies inside
   * the blyg's own origin, which the blyg may speak for; otherwise the record is kept under the post's item document address (which is
   * inside the origin, by construction) and `page` stays what it is for a reader: a link to open. A blyg can thus never name the
   * address of a page that is not its own and have its text, identity or title put on that record.
   */
  const recordUrlOf = rec => {
    if (within(rec.origin, rec.page)) return rec.page;
    const b = load().blygs[rec.origin];
    // (re-checked here, not only when the manifest was read: what is stored is not trusted either) '' = no address a record may be kept under
    const u = itemUrlFor({ item: b && b.item_template }, rec.origin, rec.id);
    return u && within(rec.origin, u) ? u : '';
  };
  /**
   * The post's own item document, fetched again through the same guarded getter and the same origin rule (its URL and
   * its final URL must be inside the blyg's origin), checked as the reconciliation checks it, and its content
   * sanitised by the article view's sanitiser. → what the page record is made of; nothing is written here.
   * The identity in `result` is the DOCUMENT's (source 'item-document'): the text came from it, not from a page's say-so.
   */
  async function fetchPost(key) {
    if (!mayFetch()) throw new Error('fetching is off (blyg_checks), so the post cannot be fetched');
    const rec = byKey(key);
    if (!rec || isWithdrawn(rec)) throw new Error('no such post');
    const b = load().blygs[rec.origin];
    if (!b) throw new Error('that blyg is not followed');
    const g = getter(newBudget({ following_run_requests: 3, following_run_seconds: 30 }, now));
    const url = itemUrlFor({ item: b.item_template }, rec.origin, rec.id);
    if (!isWebUrl(url)) throw new Error('the blyg\'s item address is not a web address');
    if (!within(rec.origin, url)) throw new Error(REFUSALS.item);
    const r = await fetchJson(g, url, LIMITS.itemBytes);
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
    const clean = sanitizeStable(src, { landmarks: false }); // the article view's own cap (2 MB), refused rather than cut; run to a fixed point
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
  /**
   * The same shape as fetchPost's, made from what the Hub already holds (the stored body and the record, both from the post's
   * item document) with NO request: for a highlight made in the Feed, before anyone has pressed "Read here". `ref` is a record
   * key, or { origin, id }.
   */
  function heldPost(ref) {
    const rec = typeof ref === 'string' ? byKey(ref) : (ref && heldItem(String(ref.origin), String(ref.id)));
    if (!rec || isWithdrawn(rec)) throw new Error('no such post');
    const b = load().blygs[rec.origin];
    if (!b) throw new Error('that blyg is not followed');
    const html = rec.read === 'archived' ? '' : readBodyHtml(rec.key);
    if (!html.trim()) throw new Error(rec.read === 'archived' ? 'that post is in the Archive, and no text is kept for it' : 'no text is held for that post yet: use Read here');
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
  }
  /** Reading a post here is opening it. */
  function openedHere(key) {
    const rec = byKey(key);
    if (!rec || isWithdrawn(rec)) throw new Error('no such post');
    if (canMoveRead(rec, 'open')) { moveRead(rec, 'open'); save(); onChange(); }
    return rec.read;
  }
  const heldVersion = (origin, id) => { const r = heldItem(String(origin), String(id)); return r && !isWithdrawn(r) ? r.version : 0; };
  /** What a post answers, said as a person would: the target's title when it is a followed post held here, else its host. */
  function responseOf(stub) {
    if (!stub) return null;
    const target = stub.id ? heldItem(stub.origin, stub.id) : null;
    return { origin: stub.origin, id: stub.id,
      label: (target && !isWithdrawn(target) && (plainText(target.title) || plainText(target.excerpt))) || hostOf(stub.origin) || stub.origin };
  }

  /**
   * The page at `url` is a post the list holds? → { verdict, item?, reason?, result? } (IDENTITY_VERDICTS).
   * THE LIST ALONE NEVER SUPPLIES IDENTITY. A page's address, and the `page` a blyg claims for a post, prove nothing
   * (§5.8: a page may be anywhere, even on another host, and a blyg may name a page that is not its own). The list's
   * origin, id and version are used for a page only when the page's OWN links agree: a <link rel="blyg"> that
   * resolves to the same origin AND a JSON alternate for the item, inside that origin, whose id is the post's. No
   * links, or one of the two, is `unconfirmed`: normal detection runs. Links that name anything else are `disagrees`:
   * detection runs and the entry says so. `result`, for `agrees`, has the shape blyg.detect answers, source 'from-list'.
   */
  function identityFor(url, hints) {
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
      if (rec.identity !== 'agrees') { setIdentity(rec, 'agree'); delete rec.identity_note; save(); }
      return { verdict: 'agrees', item: copy(rec), result: {
        status: 'blyg', source: 'from-list', site: { origin: rec.origin, title: blyg.title, author: blyg.author },
        // the list holds an excerpt, not the post: a passage cannot be checked against it
        html: '', text: rec.text,
        item: { origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.version, latest: rec.version,
          pinned: pinnedOf(rec).includes(rec.version), pinned_versions: pinnedOf(rec), page: rec.page, pinned_page: '', json: '', source: blyg.title, author: rec.author },
      } };
    }
    const no = verdicts.filter(v => v.why);
    if (no.length) {
      for (const v of no) { setIdentity(v.rec, 'disagree'); v.rec.identity_note = cleanText(v.why, 300); }
      save(); onChange();
      return { verdict: 'disagrees', item: copy(no[0].rec), reason: no[0].why };
    }
    return { verdict: 'unconfirmed', item: copy(claimants[0]) };
  }

  // ---- what the page shows ----
  function view({ view: tab = 'feed', filter = 'all', mine = [], limit = LIMITS.feedEntries, q = '' } = {}) {
    const st = load();
    const v = buildView({ items: Object.values(st.items), blygs: st.blygs, mentions: st.inbox.mentions, mine, filter });
    const titleOf = o => (st.blygs[o] && st.blygs[o].title) || '';
    const cfg = settings();
    const decorate = (i, withBody = false) => {
      const body = withBody && i.body_state && i.body_state !== 'none' ? clipBody(readBodyHtml(i.key), i.kind, cfg.following_feed_clip_words) : { head: '', rest: '' };
      return { ...copy(i), excerpt: cleanText(plainText(i.excerpt), LIMITS.excerptChars), title: cleanText(plainText(i.title), LIMITS.titleChars),
        blyg_title: titleOf(i.origin), blyg_label: mine.includes(i.origin) ? 'you' : titleOf(i.origin),
        record_url: isWithdrawn(i) ? '' : recordUrlOf(i), shown_at: new Date(sortTime(i)).toISOString(), reading: readingLabel(i.words || wordsIn(i.text || '')),
        body_head: body.head, body_rest: body.rest,
        versions_note: i.version > 1 ? `${i.version} versions` : '',
        history: [...(i.versions || [])].sort((a, b) => b.version - a.version)
          .map(v => ({ ...v, mark: v.pin === 'pinned' ? (pinPageOf(i, v.version) ? 'link' : 'plain') : '' })),
        pinned_list: pinnedOf(i),
        opens_on: i.page && hostOf(i.page) !== hostOf(i.origin) ? hostOf(i.page) : '',
        in_response_to: responseOf(i.stub_of) };
    };
    const mention = m => { const p = feedItemFor(m); return { ...copy(m), feed_key: p ? p.key : '' }; };
    // An Archive line: a light record, never any text of the post.
    const line = i => ({ key: i.key, kind: i.kind, origin: i.origin, blyg_title: titleOf(i.origin), blyg_label: mine.includes(i.origin) ? 'you' : titleOf(i.origin),
      title: cleanText(plainText(i.title), LIMITS.archiveTitleChars), version: i.version, created: i.created, updated: i.updated, archived_at: i.archived_at,
      page: i.page, opens_on: i.page && hostOf(i.page) !== hostOf(i.origin) ? hostOf(i.page) : '' });
    const needle = cleanText(String(q || ''), 100).toLowerCase();
    const archiveAll = viewOf(tab) === 'archive' ? v.archive.map(line).filter(l => !needle || `${l.title} ${l.blyg_title} ${l.origin}`.toLowerCase().includes(needle)) : [];
    const archiveLimit = Math.max(1, Math.min(Number(limit) || LIMITS.archivePage, LIMITS.archiveShownMax));
    const active = Object.values(st.blygs).filter(b => b.state !== 'paused');
    const box = syncInbox(settings());
    return { view: viewOf(tab), filter: v.feed.filter, counts: v.feed.counts, tabs: v.tabs, target: cfg.following_unread_target,
      // Said only when it is true of every blyg that is not paused: reachable, and its index read to the end. A value worked out here, not a mode.
      read_all: v.tabs.feed === 0 && active.length > 0 && active.every(b => b.state === 'active' && ledgerOf(b.origin).backfill === 'caught_up'),
      archive: archiveAll.slice(0, archiveLimit), archive_total: archiveAll.length, archive_query: needle,
      run: { ...run }, schedule: { ...schedule }, last_run: copy(st.last_run), blygs: listBlygs(),
      // the Feed carries each entry's text, so at most `limit` entries at a time (the rest is `entry_total` minus that)
      entry_total: v.feed.entries.length, limit,
      entries: viewOf(tab) === 'feed' ? v.feed.entries.slice(0, Math.max(1, Math.min(Number(limit) || LIMITS.feedEntries, 1000)))
        .map(e => ({ head: decorate(e.head, true), members: e.members.map(m => decorate(m)) })) : [],
      background: viewOf(tab) === 'background' ? v.background.map(b => (b.type === 'post'
        ? { type: 'post', reason: b.reason, post: decorate(b.post), burst_head_title: b.burst_head ? (b.burst_head.title || b.burst_head.excerpt) : '' }
        : { type: 'mention', reason: b.reason, mention: mention(b.mention) })) : [],
      mentions: viewOf(tab) === 'mentions' ? v.mentions.map(mention) : [],
      inbox: { state: box.state, fetched_at: box.fetched_at, generated_at: box.generated_at, count: box.count, error: box.error,
        never_verified: [...box.never_verified], never_verified_count: box.never_verified_count, blocked_count: box.blocked_count,
        token_warning: settings().inbox_token_file ? tokenWarning(settings().inbox_token_file) : '' } };
  }
  const itemByKey = key => copy(byKey(key));

  return { follow, unfollow, setBlygState, listBlygs, previewImport, confirmImport, refresh, reschedule, readMove,
    markResponded, tickMany, untick, readRequest, unreadCount, mentionSeen, allMentionsSeen, open, identityFor, view, itemByKey, fetchPost, heldPost, recordUrlOf, openedHere, heldVersion, responseOf, bodyHtml: readBodyHtml, sweepBodies,
    keyFor: (origin, id) => { const r = heldItem(origin, id); return r ? r.key : ''; },
    runState: () => run.state, scheduleMode: () => schedule.mode, inboxState: () => load().inbox.state,
    breakerSnapshot: host => { const b = breakers.get(host); return b ? Object.freeze({ ...b }) : null; },
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
  { method: 'POST', path: '/following/unfollow', what: 'stop following' },
  { method: 'POST', path: '/following/state', what: 'pause or resume one' },
  { method: 'POST', path: '/following/import-preview', what: 'what a blogroll or directory would add' },
  { method: 'POST', path: '/following/import-confirm', what: 'add what was confirmed' },
  { method: 'POST', path: '/following/refresh', what: 'refresh now' },
  { method: 'POST', path: '/following/read', what: 'tick a post (or the posts shown) into the Archive, untick one, or mark an opened one new' },
  { method: 'POST', path: '/following/mention-read', what: 'mark a mention (or all) seen' },
  { method: 'POST', path: '/following/settings', what: 'refresh interval, caps, my_origins, inbox' },
]);
export const routeOf = (method, path) => ROUTES.find(r => r.method === method && r.path === path) || null;
