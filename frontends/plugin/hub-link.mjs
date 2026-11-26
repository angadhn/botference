// hub-link.mjs — THE HUB LINK: the owner's hosted Blygger Hub (a server function on their blog) asks this companion, server to
// server, to file a reply the owner wrote in the Hub on a phone, to fill its `/tk` gaps with an agent on the owner's subscription,
// and to publish it through the publish queue. SPEC.md "The hub link" is the contract; this file is all of it but the HTTP wiring
// (server.mjs, one dispatch block) and the CLI (hub-link-cli.mjs).
//
// THE LINK IS ITS OWN PRINCIPAL. It is never the owner (hosted.isOwner), never a guest, and its credentials (the four x-hub-link-*
// headers) are read by nothing but `/hub-link/*`. It can do exactly HUB_LINK_ROUTES and nothing else: it cannot read pages, threads
// or settings, and it never reaches `/blyg-publish/*`.
//
// THE KEY. `hub-link.json` in the secrets folder (shared/secrets.mjs), mode 0600: { key_id (8 hex), secret (32 random bytes,
// base64url), hub_origin (an https origin), publish (HUB_LINK_PUBLISH), created_at }. Made on the machine (`botference hub-link
// pair`), replaced (`rotate`: the old key is refused at once) or deleted (`off`: every /hub-link/* route is then 404). Read at every
// request, so each takes effect without a restart. The secret is printed once, at pair or rotate, and is never in a response or a log.
//
// A SIGNED REQUEST. POST, application/json, at most HUB_LINK_LIMITS.bodyBytes, no Origin header (a page in a browser always sends
// one; the Hub's server never does), no query string, and these headers:
//   x-hub-link-key    the key id
//   x-hub-link-ts     unix seconds; within HUB_LINK_LIMITS.skewSec of this machine's clock
//   x-hub-link-nonce  16 random bytes, 32 lowercase hex; never seen in the last HUB_LINK_LIMITS.nonceMs
//   x-hub-link-sig    64 lowercase hex: HMAC-SHA256, keyed with the secret's 32 bytes (base64url-decoded), of
//                     "v1\nPOST\n<path>\n<ts>\n<nonce>\n<lowercase hex sha256 of the exact body bytes>"
// Every failure of the signature is the same answer, 401 {"ok":false,"error":"refused"}; the log says only which check failed.
//
// IDEMPOTENT BY `rid`. The Hub names each reply with its own id and sends it again (a held reply, a double tap, a retry after a
// timeout) with the same id. The companion keeps rid → its record in `hub-link-replies.json` (the companion's data folder, 0600,
// written atomically, an unreadable file never written over): a repeated reply, publish or cancel answers the state as it is and
// does nothing a second time, across restarts. The nonce cache is in memory only: a restart forgets it, which is harmless because
// every write is idempotent by rid and a replay is still bounded by the timestamp window.
//
// LOGS: the rid's first 8 characters, a state, a reason code. Never a text, a quote, the secret, a signature or a body.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJson, readJsonState, warnUnreadable } from './fsjson.mjs';
import { createRequire } from 'node:module';
import { ENTRY_STATES, OPEN_STATES } from './blyg-queue.mjs';
import { isPublishableMsg } from './blyg-note.mjs';
import { audioTypeOf, sniffAudio, SPEECH_LIMITS } from './hub-speech.mjs';
// the /tk grammar, shared with the drawer (where each gap sits in the reply's text)
const Grammar = createRequire(import.meta.url)('./extension/tkgrammar.js');

export const HUB_LINK_FILE = 'hub-link.json';
export const HUB_LINK_REPLIES_FILE = 'hub-link-replies.json';
export const HUB_LINK_VERSION = 'v1';
/** What the Hub may do about publishing, one value in the key file (`publish`), changed only on the machine (never over HTTP):
 *    drafts-only  a reply is filed (and its gaps filled) and stops there: `saved`; the owner publishes it from the drawer
 *    one-click    a reply sent with "Publish now", or a saved one the Hub asks to publish, is pressed into the publish queue */
export const HUB_LINK_PUBLISH = Object.freeze(['drafts-only', 'one-click']);
/** Whether the link is there, one value derived from the key file at each request (linkGateOf):
 *    off     no key file: every /hub-link/* route is 404
 *    on      a well-formed key: the routes answer signed requests
 *    broken  a key file that is not readable or not the shape `pair` writes: 404 like off, said once in the log; never written over */
export const HUB_LINK_GATES = Object.freeze(['off', 'on', 'broken']);
export const HUB_LINK_LIMITS = Object.freeze({
  bodyBytes: 16 * 1024,
  skewSec: 120,
  nonceMs: 10 * 60 * 1000,
  nonceMax: 5000,
  requestsPerMinute: 30,
  repliesPerHour: 20,
  publishesPerDay: 10,
  statusRids: 20,
  // (the ONE length limit is bodyBytes, the encoded body: no separate character counts, so no script passes one and fails the other)
  withdrawnMax: 500,
  // a reply's text read back (`status {text:true}`): for at most this many rids at once, and the agent passages of one reply cut at
  // this many bytes in all (its own words are already bounded by bodyBytes)
  textRids: 5,
  // …and ONE size for one reply's blocks, own words and agent passages together, measured after JSON encoding (the owner may have
  // made the message far longer on the computer); the whole answer of a status with text is then bounded too
  blocksJsonBytes: 48 * 1024,
  textResponseBytes: 256 * 1024,
  // how long a status waits for a rid still being filed before answering 503 (inside the Hub's 8 s fetch timeout)
  statusWaitMs: 5000,
  // a recording's body is read before its signature can be checked: at most this many at once, each within this time
  audioReading: 2,
  audioReadMs: 20000,
});
/** HOW A PUBLISH GOES, one value on `publish` (`as`; absent: as-asked):
 *    as-asked  as the reply asked: added to its earlier post when it was sent with `add_to`, else a new post
 *    new       a new post, whatever `add_to` said (the owner's answer when the earlier post can no longer take it) */
export const HUB_LINK_PUBLISH_AS = Object.freeze(['as-asked', 'new']);
/** WHETHER A REPLY SENT WITH `add_to` CAN GO INTO THAT POST NOW, one value derived at each view from the plugin's own answer
 *  (blyg-run earlierOf: the newest post published from that page, its note unchanged, every comment still there, the same target):
 *    ready       that post is the one a comment on this page would be added to now
 *    cannot-add  it is not (gone, changed outside, another post since, or the add commands are not set up) */
export const HUB_LINK_ADD_STATES = Object.freeze(['ready', 'cannot-add']);
const POST_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
/** The reply's intent, from the Hub's two buttons. */
export const HUB_LINK_INTENTS = Object.freeze(['publish', 'draft']);
/** Every route, one table: the handler is looked up here and nowhere else (an unknown name is 404). */
export const HUB_LINK_ROUTES = Object.freeze({
  ping: Object.freeze({ path: '/hub-link/ping', does: 'answers the link version and the publish setting' }),
  reply: Object.freeze({ path: '/hub-link/reply', does: 'files a reply as a thread on the post\'s page record; presses it when asked and allowed' }),
  status: Object.freeze({ path: '/hub-link/status', does: 'the state of up to 20 replies by rid' }),
  publish: Object.freeze({ path: '/hub-link/publish', does: 'presses a saved reply into the publish queue' }),
  cancel: Object.freeze({ path: '/hub-link/cancel', does: 'takes a reply out of the queue while it has not started, or throws a saved draft away' }),
  redo: Object.freeze({ path: '/hub-link/redo', does: 'asks the agent again for one passage of a saved draft' }),
  // speech (hub-speech.mjs): the body of `transcribe` is the recording itself, not JSON, and its type and length are signed too
  earlier: Object.freeze({ path: '/hub-link/earlier', does: 'the owner\'s published reply to a blyg post that a new reply can be added to' }),
  transcribe: Object.freeze({ path: '/hub-link/transcribe', does: 'starts turning a recording into text: a job', body: 'audio' }),
  transcript: Object.freeze({ path: '/hub-link/transcript', does: 'a speech job: pending, done with its text, or failed' }),
});
const ROUTE_BY_PATH = new Map(Object.entries(HUB_LINK_ROUTES).map(([name, r]) => [r.path, name]));

/** A reply's state as the Hub is told it, DERIVED by linkStateOf from the record, the page and the queue (never stored):
 *    refused        the reply was not filed (answered by `reply` only: nothing is kept)
 *    saved          filed as a thread, not pressed (a draft, drafts-only, or a press that was refused)
 *    filling        pressed; its turn came while an agent's passage was still being written
 *    queued         pressed; waiting for the runner
 *    awaiting_look  pressed; waiting for the owner to look at it on the computer (a forced look, or confirm 'always')
 *    publishing     the runner has it
 *    published      live
 *    failed         not published (the entry failed, or it was set aside and is gone)
 *    cancelled      cancelled (from the Hub or the drawer), or the owner deleted the thread
 *  A status for a rid the companion has no record of answers `unknown` (not a state: there is nothing to be in). */
export const HUB_LINK_STATES = Object.freeze(['refused', 'saved', 'filling', 'queued', 'awaiting_look', 'publishing', 'published', 'failed', 'cancelled']);
export const HUB_LINK_TERMINAL = Object.freeze(['refused', 'published', 'failed', 'cancelled']);
/** The ONE mapping from a queue entry's state (blyg-queue ENTRY_STATES) to the Hub's. `running` is refined by the run (at a look). */
export const ENTRY_TO_LINK = Object.freeze({ queued: 'queued', filling: 'filling', needs_look: 'awaiting_look', running: 'publishing',
  giving_up: 'publishing', published: 'published', failed: 'failed', cancelled: 'cancelled' });
for (const s of ENTRY_STATES) if (!ENTRY_TO_LINK[s]) throw new Error(`hub-link: no Hub state for the queue's ${s}`);

/** A DRAFT'S AGENT PASSAGES, one value derived by fillOf from its gaps (never stored; the gaps' own modes are tkgaps GAP_MODES):
 *    writing  a passage is still being written (pending)
 *    ready    every passage asked for is written (or there is none): Publish will not ask again for what is written
 *    failed   a passage could not be written (`fill_why`: the first reason); Redo asks again */
export const HUB_LINK_FILLS = Object.freeze(['writing', 'ready', 'failed']);
export function fillOf(gaps) {
  const live = (gaps || []).filter(g => g && g.mode !== 'removed');
  if (live.some(g => g.mode === 'pending')) return 'writing';
  if (live.some(g => g.mode === 'failed')) return 'failed';
  return 'ready';
}
/**
 * THE REPLY'S OWN TEXT as blocks, in order: { kind: 'own', text } for the owner's words between passages, and { kind: 'agent', id,
 * instruction, state (its gap's mode), text, model, at, reason? } for each passage (a removed one is left out with its mark). Only the
 * message the link filed (filedMsgOf), never another. → { blocks, cut }: the blocks' JSON is at most `jsonBytes` (UTF-8, after
 * encoding); a block that does not fit has its text cut to fit and the rest are left out (`cut: true`).
 */
export function blocksOf(msg, { jsonBytes = HUB_LINK_LIMITS.blocksJsonBytes } = {}) {
  const text = String((msg && msg.text) || '');
  const gaps = Array.isArray(msg && msg.gaps) ? msg.gaps : [];
  const marks = Grammar.parseGaps(text);
  const all = [];
  let at = 0;
  const own = t => { if (t) all.push({ kind: 'own', text: t }); };
  marks.forEach((m, i) => {
    own(text.slice(at, m.start));
    at = m.end;
    const g = gaps[i];
    if (!g || g.mode === 'removed') return;
    all.push({ kind: 'agent', id: String(g.id), instruction: String(g.instruction || '').slice(0, 1000), state: String(g.mode), text: String(g.text || ''),
      model: String(g.model || '').slice(0, 100), at: String(g.at || '').slice(0, 40), ...(g.mode === 'failed' ? { reason: scrubPaths(g.reason).slice(0, 300) } : {}) });
  });
  own(text.slice(at));
  const size = v => Buffer.byteLength(JSON.stringify(v));
  const blocks = [];
  let used = 2;   // the brackets
  for (const b of all) {
    const sep = blocks.length ? 1 : 0;
    if (used + sep + size(b) <= jsonBytes) { blocks.push(b); used += sep + size(b); continue; }
    // the largest cut of its text that fits (characters, so a cut never splits a character)
    let lo = 0, hi = Math.min(b.text.length, jsonBytes);
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (used + sep + size({ ...b, text: b.text.slice(0, mid) }) <= jsonBytes) lo = mid; else hi = mid - 1; }
    const c = { ...b, text: b.text.slice(0, lo) };
    if (used + sep + size(c) <= jsonBytes) blocks.push(c);
    return { blocks, cut: true };
  }
  return { blocks, cut: false };
}
/** THE MESSAGE THE LINK FILED in a thread: the one with the record's `msg_ts` (the record is what says the link filed it: an owner's
 *  edit on the computer re-stamps the message's channel, and it is still this reply). A record from before `msg_ts` was kept: the
 *  first message, whatever its channel now. Gone (deleted on the computer) → null: the reply has ended. */
export function filedMsgOf(record, thread) {
  if (!record || !thread) return null;
  const msgs = Array.isArray(thread.msgs) ? thread.msgs : [];
  // (a record from before `msg_ts`: the thread's first message, whatever its channel now; the thread was the link's from the start)
  const m = record.msg_ts ? msgs.find(x => x && x.ts === record.msg_ts) : msgs[0];
  return m || null;
}
/** THE FILED TEXT NOW, one value derived by textStateOf from the record's `text_hash` and the message's text (never stored):
 *    as-filed            the words are those the Hub sent
 *    edited-on-computer  the owner changed them on the computer (Publish sends them as they are now) */
export const HUB_LINK_TEXT_STATES = Object.freeze(['as-filed', 'edited-on-computer']);
export const textStateOf = (record, msg) => (!record || !record.text_hash || !msg ? ''
  : textHashOf(msg.text) === record.text_hash ? 'as-filed' : 'edited-on-computer');
export const textHashOf = t => crypto.createHash('sha256').update(String(t == null ? '' : t)).digest('hex').slice(0, 16);
/** What Publish would send for the filed message, as a short hash: its text and every passage's id, mode and text. */
export const textRevOf = msg => crypto.createHash('sha256').update(JSON.stringify([String(msg.text || ''),
  (Array.isArray(msg.gaps) ? msg.gaps : []).map(g => [String(g && g.id), String(g && g.mode), String((g && g.text) || '')])])).digest('hex').slice(0, 12);
/** A saved draft the Hub may still throw away: its thread holds only the filed message, its text as filed (record `text_hash`), and no
 *  passage the owner changed by hand (edited, adopted, removed). */
export function untouchedSinceFiling(record, thread) {
  const m = filedMsgOf(record, thread);
  if (!m || !record.text_hash || thread.msgs.length !== 1 || textHashOf(m.text) !== record.text_hash) return false;
  return !(m.gaps || []).some(g => g && ['edited-by-reader', 'adopted-by-reader', 'removed'].includes(g.mode));
}

/** A record's step, one field (`record.step`), moved only by moveRecord:
 *    saved      the thread is filed; nothing pressed (yet)
 *    discarded  a saved draft the Hub threw away (`cancel`): its thread is deleted; final
 *    pressed    a press was accepted by the queue (`entry_id`); never pressed again for this rid
 *    withdrawn  the Hub cancelled a rid this companion had never seen (the reply may still be on its way): born so, final; a reply
 *               with that rid is refused as cancelled. At most HUB_LINK_LIMITS.withdrawnMax kept (the oldest forgotten first), and
 *               like every record forgotten after 30 days */
export const RECORD_STEPS = Object.freeze(['saved', 'pressed', 'withdrawn', 'discarded']);
// (pressed → saved: only an addition the queue took out because its earlier post could no longer take it: nothing was published)
export const RECORD_MOVES = Object.freeze({ saved: Object.freeze(['pressed', 'discarded']), pressed: Object.freeze(['saved']), withdrawn: Object.freeze([]),
  discarded: Object.freeze([]) });
export class IllegalRecordMove extends Error {}
export function moveRecord(rec, to, facts = {}) {
  if (!RECORD_STEPS.includes(to)) throw new Error(`hub link record: no such step ${String(to).slice(0, 20)}`);
  if (!RECORD_MOVES[rec.step] || !RECORD_MOVES[rec.step].includes(to)) throw new IllegalRecordMove(`hub link record: cannot go from ${rec.step} to ${to}`);
  Object.assign(rec, facts, { step: to });
  return rec;
}

// ---- the key ---------------------------------------------------------------------------------------------------------------------
const KEY_ID_RE = /^[0-9a-f]{8}$/;
const B64URL_RE = /^[A-Za-z0-9_-]{43}$/;
export const keyFileOf = dir => path.join(dir, HUB_LINK_FILE);
export const fingerprintOf = secret => crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);
/** The Hub's origin, as an https origin, or '' (http, a path, a query, credentials or nonsense are all refused). */
export function hubOriginOf(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return '';
  if (!u.hostname || /\s/.test(String(raw).trim())) return '';
  return u.origin;
}
const keyShapeOk = k => !!k && typeof k === 'object' && KEY_ID_RE.test(String(k.key_id)) && B64URL_RE.test(String(k.secret))
  && Buffer.from(String(k.secret), 'base64url').length === 32 && HUB_LINK_PUBLISH.includes(k.publish) && hubOriginOf(k.hub_origin) === k.hub_origin;
/** → { gate (HUB_LINK_GATES), key } — `key` only when the gate is on. */
export function readLinkKey(dir) {
  const file = keyFileOf(dir);
  const got = readJsonState(file);
  if (got.state === 'missing') return { gate: 'off', key: null };
  if (got.state === 'unreadable') { warnUnreadable(file, got.error); return { gate: 'broken', key: null }; }
  if (!keyShapeOk(got.value)) { warnUnreadable(file, new Error('not the shape botference hub-link pair writes')); return { gate: 'broken', key: null }; }
  return { gate: 'on', key: got.value };
}
export const linkGateOf = dir => readLinkKey(dir).gate;
export function newKey({ hub_origin, publish, now = () => new Date() }) {
  return { key_id: crypto.randomBytes(4).toString('hex'), secret: crypto.randomBytes(32).toString('base64url'), hub_origin, publish,
    created_at: now().toISOString() };
}
export const writeLinkKey = (dir, key) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); writeJson(keyFileOf(dir), key, { mode: 0o600 }); };
export function deleteLinkKey(dir) { try { fs.unlinkSync(keyFileOf(dir)); return true; } catch (e) { if (e && e.code === 'ENOENT') return false; throw e; } }

// ---- signing ---------------------------------------------------------------------------------------------------------------------
export const SIG_HEADERS = Object.freeze({ key: 'x-hub-link-key', ts: 'x-hub-link-ts', nonce: 'x-hub-link-nonce', sig: 'x-hub-link-sig' });
/** (audio only) the body's sha256, lowercase hex, as signed: the signature is checked with it BEFORE the body is read, then the body
 *  read is checked against it */
export const BODY_HASH_HEADER = 'x-hub-link-body-sha256';
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
export const bodyHashOf = body => crypto.createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')).digest('hex');
// (`extra`: the lines a route signs besides the body's hash: `transcribe` signs its content type, exactly as sent, and the body's length)
export const stringToSign = (urlPath, ts, nonce, bodyHash, extra = []) => `${HUB_LINK_VERSION}\nPOST\n${urlPath}\n${ts}\n${nonce}\n${bodyHash}`
  + (extra.length ? `\n${extra.join('\n')}` : '');
/** The signature the Hub sends (here for the tests and for anyone writing the other side). */
export function signRequest(secret, urlPath, ts, nonce, body, extra = []) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'base64url')).update(stringToSign(urlPath, String(ts), nonce, bodyHashOf(body), extra)).digest('hex');
}
/** Every header of a signed request (tests; the Hub's link-client.mjs does the same). */
export function signedHeaders({ key_id, secret }, urlPath, body, { ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(16).toString('hex'), extra = [] } = {}) {
  return { [SIG_HEADERS.key]: key_id, [SIG_HEADERS.ts]: String(ts), [SIG_HEADERS.nonce]: nonce, [SIG_HEADERS.sig]: signRequest(secret, urlPath, ts, nonce, body, extra) };
}
const hexEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
/** The nonces seen in the last ttlMs. A full cache refuses (a flood is not let through by forgetting). */
export function createNonceCache({ ttlMs = HUB_LINK_LIMITS.nonceMs, max = HUB_LINK_LIMITS.nonceMax, now = Date.now } = {}) {
  const seen = new Map();
  const sweep = () => { const t = now(); for (const [n, exp] of seen) if (exp <= t) seen.delete(n); };
  return {
    /** → 'fresh' (now remembered) | 'replayed' | 'full' */
    take(nonce) {
      sweep();
      if (seen.has(nonce)) return 'replayed';
      if (seen.size >= max) return 'full';
      seen.set(nonce, now() + ttlMs);
      return 'fresh';
    },
    get size() { sweep(); return seen.size; },
  };
}
/** → { ok: true } | { ok: false, why } — `why` is a reason code for the log, never for the answer. The nonce is taken last, only
 *  for a request whose signature is good (so a forger cannot burn the Hub's nonces). */
/** The checks that need no body: the four headers present and of their form, the current key id, the time within the window. Made
 *  BEFORE a large body is read (the audio route), so an unsigned caller costs no read. → { ok } | { ok: false, why } */
export function preCheck({ headers, key, nowSec }) {
  const h = headers || {};
  const kid = String(h[SIG_HEADERS.key] || ''), tsRaw = String(h[SIG_HEADERS.ts] || ''), nonce = String(h[SIG_HEADERS.nonce] || ''), sig = String(h[SIG_HEADERS.sig] || '');
  if (!kid || !tsRaw || !nonce || !sig) return { ok: false, why: 'missing-header' };
  // (compared in constant time: hashed first, so the lengths are equal)
  if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(kid).digest(), crypto.createHash('sha256').update(String(key.key_id)).digest())) return { ok: false, why: 'wrong-key' };
  if (!/^\d{1,12}$/.test(tsRaw)) return { ok: false, why: 'bad-ts' };
  if (Math.abs(Number(tsRaw) - nowSec) > HUB_LINK_LIMITS.skewSec) return { ok: false, why: 'stale-ts' };
  if (!NONCE_RE.test(nonce)) return { ok: false, why: 'bad-nonce' };
  if (!SIG_RE.test(sig)) return { ok: false, why: 'bad-sig' };
  return { ok: true };
}
export function verifySigned({ headers, urlPath, body, key, nowSec, nonces, extra = [] }) {
  // (the key id is not a secret: it names which key, so a rotated one is told apart in the log)
  const pre = preCheck({ headers, key, nowSec });
  if (!pre.ok) return pre;
  const h = headers || {};
  const tsRaw = String(h[SIG_HEADERS.ts]), nonce = String(h[SIG_HEADERS.nonce]), sig = String(h[SIG_HEADERS.sig]);
  const want = signRequest(key.secret, urlPath, tsRaw, nonce, body, extra);
  if (!hexEqual(want, sig)) return { ok: false, why: 'bad-sig' };
  const n = nonces.take(nonce);
  if (n !== 'fresh') return { ok: false, why: n === 'full' ? 'nonce-cache-full' : 'replayed-nonce' };
  return { ok: true };
}

// ---- limits ------------------------------------------------------------------------------------------------------------------------
/** Times in a sliding window (memory only: the per-minute request limit). Replies per hour and publishes per day are counted from the
 *  records themselves (repliesSince, pressesSince), so a restart does not reset them. */
export function createWindow({ ms, max, now = Date.now }) {
  let times = [];
  return { take() { const t = now(); times = times.filter(x => t - x < ms); if (times.length >= max) return false; times.push(t); return true; } };
}

// ---- the state the Hub is told -----------------------------------------------------------------------------------------------------
const MAX_HOPS = 10;
/** The queue entry a record's press became: followed through `replaced_by` (the owner's drawer press of the same thread took it over). */
export function entryOf(record, entries) {
  let id = record && record.entry_id;
  for (let hop = 0; id && hop < MAX_HOPS; hop++) {
    const e = (entries || []).find(x => x && x.id === id);
    if (!e) return null;
    if (e.state !== 'cancelled' || !e.replaced_by) return e;
    id = e.replaced_by;
  }
  return null;
}
/**
 * THE ONE FUNCTION that says what state a reply is in. record: a stored record (or null); page: the page record its thread is on (or
 * null); queue: { entries (blyg-queue view entries), run (the runner's current run: {id, mode, confirm}) }. → a HUB_LINK_STATES value,
 * or 'unknown' when there is no record.
 */
/** An OPEN queue entry for a record's thread, whoever pressed it (the owner may press a Hub-filed draft in the drawer), or null. */
export const openEntryFor = (record, entries) => (record && (entries || []).find(e => e && OPEN_STATES.includes(e.state)
  && e.page_url === record.page_url && e.thread_id === record.thread_id)) || null;
const entryState = (e, run) => (e.state === 'running' && run && run.id && run.id === e.run && run.mode === 'planned' && run.confirm === 'always'
  ? 'awaiting_look' : ENTRY_TO_LINK[e.state]);
export function linkStateOf(record, page, queue) {
  if (!record) return 'unknown';
  if (record.step === 'withdrawn' || record.step === 'discarded') return 'cancelled';
  const thread = page && Array.isArray(page.threads) ? page.threads.find(t => t && t.id === record.thread_id) : null;
  const published = !!(thread && thread.blyg_published && thread.blyg_published.at);
  const run = queue && queue.run;
  if (record.step === 'saved') {
    // (a draft pressed elsewhere, in the drawer, or by the Hub before a record write was lost: that entry is its state)
    const open = openEntryFor(record, queue && queue.entries);
    if (open) return entryState(open, run);
    // (its filed message gone, or the owner's now: the computer ended it)
    return published ? 'published' : !filedMsgOf(record, thread) ? 'cancelled' : 'saved';
  }
  const e = entryOf(record, queue && queue.entries);
  if (!e) return published ? 'published' : !thread ? 'cancelled' : 'failed';
  return entryState(e, run);
}

// ---- the records --------------------------------------------------------------------------------------------------------------------
const RID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const ridOk = rid => typeof rid === 'string' && RID_RE.test(rid);
export const ridTag = rid => String(rid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8);
/** The records' file, one value (`store.file`):
 *    ok          read (or missing: a fresh store), written on every change
 *    unreadable  there but not readable JSON or not this shape: kept as it was, never written over; writes are refused (503) so no
 *                rid is ever acted on twice, and status answers `unknown` */
export const RECORD_FILE_STATES = Object.freeze(['ok', 'unreadable']);
const recShapeOk = r => r && typeof r === 'object' && ridOk(r.rid) && RECORD_STEPS.includes(r.step) && typeof r.at === 'string'
  && (r.step === 'withdrawn' || (typeof r.page_url === 'string' && typeof r.thread_id === 'string' && HUB_LINK_INTENTS.includes(r.intent)));
export function createReplyStore({ file, now = () => new Date(), keepDays = 30 }) {
  let file_state = 'ok';
  let recs = new Map();
  const got = readJsonState(file);
  if (got.state === 'unreadable' || (got.state === 'ok' && !(got.value && Array.isArray(got.value.records)))) {
    if (got.state === 'unreadable') warnUnreadable(file, got.error);
    else warnUnreadable(file, new Error('not the shape the hub link writes'));
    file_state = 'unreadable';
  } else if (got.state === 'ok') {
    for (const r of got.value.records) if (recShapeOk(r)) recs.set(r.rid, r);
  }
  const persist = () => {
    if (file_state !== 'ok') throw new Error('hub link records are unreadable: not written');
    // a record older than keepDays is forgotten (the Hub deletes finished replies after 7 days)
    const cut = now().getTime() - keepDays * 86400 * 1000;
    for (const [k, r] of recs) if (new Date(r.at).getTime() < cut) recs.delete(k);
    writeJson(file, { version: 1, records: [...recs.values()] }, { mode: 0o600 });
  };
  // (a withdrawn rid is not a reply: it never counts against a limit)
  const since = (field, ms) => { const t = now().getTime(); return [...recs.values()].filter(r => r.step !== 'withdrawn' && r[field] && t - new Date(r[field]).getTime() < ms).length; };
  return {
    get state() { return file_state; },
    get: rid => recs.get(rid) || null,
    /** a new record (step saved), written at once */
    add(rec) { if (recs.has(rec.rid)) throw new Error('hub link record: rid already kept'); recs.set(rec.rid, { ...rec, step: 'saved' }); persist(); return recs.get(rec.rid); },
    /** a rid cancelled before its reply arrived: remembered as withdrawn (bounded: the oldest withdrawn is forgotten past the cap) */
    // (all or nothing: a withdrawal that cannot be written is not kept, so nothing ever answers `cancelled` for it)
    withdraw(rid) {
      if (recs.has(rid)) throw new Error('hub link record: rid already kept');
      const before = new Map(recs);
      const old = [...recs.values()].filter(r => r.step === 'withdrawn');
      for (const r of old.slice(0, Math.max(0, old.length - HUB_LINK_LIMITS.withdrawnMax + 1))) recs.delete(r.rid);
      recs.set(rid, { rid, step: 'withdrawn', at: now().toISOString() });
      try { persist(); } catch (e) { recs = before; throw e; }
      return recs.get(rid);
    },
    move(rid, to, facts) { const r = recs.get(rid); moveRecord(r, to, facts); persist(); return r; },
    note(rid, facts) { const r = recs.get(rid); Object.assign(r, facts); persist(); return r; },
    repliesSince: ms => since('at', ms),
    pressesSince: ms => since('pressed_at', ms),
  };
}

// ---- the routes --------------------------------------------------------------------------------------------------------------------
const JSON_HEAD = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const answer = (res, status, obj) => res.writeHead(status, JSON_HEAD).end(JSON.stringify(obj));
const isJson = ct => /^application\/json\s*(?:;|$)/i.test(String(ct || ''));
const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
const scrubPaths = t => String(t == null ? '' : t).replace(/(?<![\w:/.-])(?:\/[^\s/"'<>()[\]]+){2,}\/?/g, '<path>');
/** The owner's sentences for a refused reply or press (the Hub shows them as they are). */
export const HUB_LINK_SAY = Object.freeze({
  'not-verified': 'That passage isn’t in the post as published; it may have changed.',
  'checks-off': 'Your computer is set not to check blyg posts, so it could not confirm the passage.',
  'other-post': 'Your computer already keeps a different post at that address.',
  'not-writable': 'Your computer cannot file a reply on that page.',
  'drafts-only': 'Your computer is set to keep replies from the Hub as drafts. Publish it from your computer.',
  'publishes-per-day': `Today’s limit of ${HUB_LINK_LIMITS.publishesPerDay} replies published from the Hub is reached.`,
  'replies-per-hour': `This hour’s limit of ${HUB_LINK_LIMITS.repliesPerHour} replies from the Hub is reached.`,
  'not-set-up': 'Publishing is not set up on your computer.',
  'queue-refused': 'Your computer did not queue it.',
  'gone': 'The reply is no longer on your computer.',
  'too-large': `This reply is too long to send to your computer: at most ${HUB_LINK_LIMITS.bodyBytes / 1024} KB of text.`,
  'cancelled': 'This reply was cancelled.',
  'changed-on-computer': 'This draft was changed on your computer; discard it there.',
  'edited-on-computer': 'You changed this passage on your computer; write it again there.',
  'cannot-add': 'Your earlier reply can no longer be added to from here (it changed, or another reply went out since). Publish this one as a new post instead.',
  'cannot-add-outside': 'Your earlier reply was edited by hand on your computer, so this is not added to it from here. Publish it as a new post, or discard it.',
  'cannot-add-changed': 'Your earlier reply changed, so this was not added. Publish it as a new post, or discard it.',
  'audio-too-large': `The recording is too long to send: at most ${SPEECH_LIMITS.audioBytes} bytes (about 3 minutes).`,
  'not-audio': 'That is not a recording your computer can read (WebM, Ogg or MP4 audio).',
  'passages-per-hour': 'Your computer has written as many agent passages for this post as it will in an hour. Try again later.',
});

/**
 * deps: {
 *   keyDir, repliesFile, now() → Date,
 *   bind({ post, quote }) → Promise<{ verdict: 'verified', url } | { verdict: 'unverified', code, reason }>   (verifyShown, source hub)
 *   fileReply({ bound, quote, comment }) → { url, thread_id } | { code }   (a thread on the verified page, owner-typed on channel hub-link)
 *   press({ url, thread_id }) → Promise<blyg-queue press answer>   (by 'hub-link')
 *   cancel(entry_id) → blyg-queue cancel answer
 *   queue() → { entries, run }        readPage(url) → page | null
 *   log(line), perMinute (tests only: the request limit a minute), statusWaitMs, audioReadMs (tests only)
 * }
 */
export function createHubLink(deps) {
  const clock = () => (deps.now ? deps.now() : new Date());
  const ms = () => clock().getTime();
  const nonces = createNonceCache({ now: ms });
  // (deps.perMinute: the tests' server raises it, so polling a status is not limited; nothing else sets it)
  const perMinute = createWindow({ ms: 60 * 1000, max: Number.isInteger(deps.perMinute) && deps.perMinute > 0 ? deps.perMinute : HUB_LINK_LIMITS.requestsPerMinute, now: ms });
  const store = createReplyStore({ file: deps.repliesFile, now: clock });
  const say = line => { try { (deps.log || (l => process.stderr.write(`hub-link: ${l}\n`)))(line); } catch { /* nowhere */ } };
  const inflight = new Map(); // rid → the promise of the request already acting on it (a second one waits for it)
  // SLOTS HELD by requests still working (verifying a passage, or waiting for the queue): counted with the records, so requests at once
  // cannot all pass a limit that only the finished ones would have reached. Taken before the await, given back when it ends.
  const holding = { replies: 0, presses: 0 };
  // speech is offered when the tools are on this machine (hub-speech SPEECH_GATES); the routes are 404 otherwise
  const speechGate = () => (deps.speech ? deps.speech.gate() : 'off');
  // the audio bodies being read before their signature can be checked (HUB_LINK_LIMITS.audioReading at once), and how long each may take
  const reading = { n: 0 };
  const audioReadMs = Number.isInteger(deps.audioReadMs) && deps.audioReadMs > 0 ? deps.audioReadMs : HUB_LINK_LIMITS.audioReadMs;
  const statusWait = Number.isInteger(deps.statusWaitMs) && deps.statusWaitMs > 0 ? deps.statusWaitMs : HUB_LINK_LIMITS.statusWaitMs;
  // a passage left `pending` with no fill running (the companion restarted mid-fill) is failed "interrupted", through the gap's own move
  // function, on the computer's side (deps.settleStale), before a reply's state or text is read
  const settle = rid => {
    const rec = store.get(rid);
    if (!rec || typeof deps.settleStale !== 'function' || !(rec.step === 'saved' || rec.step === 'pressed')) return;
    const page = deps.readPage(rec.page_url);
    const m = filedMsgOf(rec, page && (page.threads || []).find(t => t && t.id === rec.thread_id));
    if (m && (m.gaps || []).some(g => g && g.mode === 'pending')) deps.settleStale({ url: rec.page_url, thread_id: rec.thread_id, ts: m.ts });
  };
  const holdReply = () => { let held = true; holding.replies++; return { give() { if (held) { held = false; holding.replies--; } } }; };

  const stateFor = (rec, q) => {
    const page = rec ? deps.readPage(rec.page_url) : null;
    return { page, state: linkStateOf(rec, page, q) };
  };
  /** What the Hub is told about one rid: its state, and what it shows with it. Nothing else of the page is ever in it. */
  function viewOf(rid, q = deps.queue(), { text = false } = {}) {
    giveBack(rid, q);
    const rec = store.get(rid);
    const { page, state } = stateFor(rec, q);
    const v = { rid, state };
    if (!rec) return v;
    const thread = page && (page.threads || []).find(t => t && t.id === rec.thread_id);
    const first = filedMsgOf(rec, thread);
    const gaps = first && Array.isArray(first.gaps) ? first.gaps.filter(g => g && g.mode !== 'removed') : [];
    if (gaps.length) v.gaps = { total: gaps.length, written: gaps.filter(g => g.mode !== 'pending').length, failed: gaps.filter(g => g.mode === 'failed').length };
    // the passages' progress, and (asked for) the reply's own text: only while its thread is there and is this record's
    if (first && (rec.step === 'saved' || rec.step === 'pressed')) {
      v.fill = fillOf(gaps);
      if (v.fill === 'failed') v.fill_why = scrubPaths((gaps.find(g => g.mode === 'failed') || {}).reason).slice(0, 300);
      v.text_rev = textRevOf(first);
      { const ts = textStateOf(rec, first); if (ts) v.text_state = ts; }
      // the thread's other messages Publish would include (the Hub shows only the filed one)
      v.extra_messages = (thread.msgs || []).filter(m => m && m !== first && isPublishableMsg(m)).length;
      if (text) { const b = blocksOf(first); v.blocks = b.blocks; if (b.cut) v.text_cut = true; }
    }
    const e = rec.step === 'saved' ? openEntryFor(rec, q.entries) : entryOf(rec, q.entries);
    if (state === 'queued' && e) v.ahead = Number(e.ahead) || 0;
    if (state === 'published') {
      const p = (thread && thread.blyg_published) || {};
      const r = (e && e.result) || {};
      v.address = String(r.address || p.permalink || '');
      v.version = Number(r.version || p.version) || 1;
    }
    if (state === 'failed' && e && e.failure && e.failure.say) v.say = scrubPaths(e.failure.say).slice(0, 400);
    // (a reply sent to be added to an earlier post: which post, and whether it can go there now; nothing else of that post)
    if (rec.add_to && thread && (rec.step === 'saved' || rec.step === 'pressed')) {
      const e = rec.step === 'saved' ? deps.earlierFor({ url: rec.page_url, thread_id: rec.thread_id }) : null;
      const ready = rec.step === 'pressed' || !!(e && e.post && e.post === rec.add_to);
      // (a refusal that no longer holds is cleared: the post can take it now)
      if (rec.step === 'saved' && ready && String(rec.press_refused || '').startsWith('cannot-add')) store.note(rid, { press_refused: '' });
      v.adds_to = { id: rec.add_to, title: e && ready ? String(e.title || '').slice(0, 120) : String(rec.add_title || ''), address: e && ready ? String(e.address || '') : String(rec.add_address || ''),
        state: ready ? 'ready' : 'cannot-add' };
    }
    if (state === 'saved' && rec.press_refused) v.press = { refused: rec.press_refused, say: HUB_LINK_SAY[rec.press_refused] || '' };
    return v;
  }
  const logState = (rid, what, extra = '') => say(`${ridTag(rid)} ${what}${extra ? ` ${extra}` : ''}`);

  /** AN ADDITION THE QUEUE TOOK OUT (its earlier post could no longer take it when its turn came: blyg-queue cancelled_for
   *  'cannot-add'): nothing was published, so the reply goes back to a saved draft, its day slot given back, said why; the Hub may then
   *  publish it as a new post. */
  function giveBack(rid, q) {
    const rec = store.get(rid);
    if (!rec || rec.step !== 'pressed' || !rec.add_to) return;
    const e = entryOf(rec, q.entries);
    if (!e || e.state !== 'cancelled' || e.cancelled_for !== 'cannot-add') return;
    store.move(rid, 'saved', { entry_id: '', pressed_at: '', press_refused: 'cannot-add-changed' });
    logState(rid, 'given-back', 'cannot-add');
  }
  /** A press for a saved record: the publish setting, the day's limit, then the queue. Writes the record's step on success. */
  async function pressRecord(rec, key, as = 'as-asked') {
    const refuse = code => { store.note(rec.rid, { press_refused: code }); logState(rec.rid, 'press-refused', code); return code; };
    if (key.publish !== 'one-click') return refuse('drafts-only');
    // an entry for this thread already open (the owner pressed it in the drawer): never pressed over (it would replace the owner's choices)
    if (openEntryFor(rec, deps.queue().entries)) { logState(rec.rid, 'press-skipped', 'open-entry'); return 'open-entry'; }
    if (store.pressesSince(86400 * 1000) + holding.presses >= HUB_LINK_LIMITS.publishesPerDay) return refuse('publishes-per-day');
    // ADDED TO THE EARLIER POST through the plugin's own path (join 'add'): only while that post is the one the plugin would add to now,
    // and pressed with its id and version, so the run refuses if it changed meanwhile (blyg-run ADD_CHANGED_SAY)
    let add = null;
    if (rec.add_to && as !== 'new') {
      const e = deps.earlierFor({ url: rec.page_url, thread_id: rec.thread_id });
      if (!e || e.post !== rec.add_to) return refuse(e && e.refused === 'outside' ? 'cannot-add-outside' : 'cannot-add');
      add = { join: 'add', post: e.post, postVersion: Number(e.version) || 1, title: String(e.title || '').slice(0, 120), address: String(e.address || '') };
    }
    holding.presses++;
    let r;
    try { r = await deps.press({ url: rec.page_url, thread_id: rec.thread_id, ...(add ? { join: add.join, post: add.post, postVersion: add.postVersion } : {}) }); } finally { holding.presses--; }
    if (!r || !r.ok || !r.queued) return refuse(r && /not set up/i.test(String(r.error || '')) ? 'not-set-up' : 'queue-refused');
    store.move(rec.rid, 'pressed', { entry_id: String(r.queued.id), pressed_at: clock().toISOString(), press_refused: '', ...(add ? { add_title: add.title, add_address: add.address } : { add_to: '' }) });
    logState(rec.rid, 'pressed');
    return '';
  }

  // a reply whose slot is held: verified, filed, recorded, pressed when asked (the caller gives the slot back)
  async function fileOne(rid, data, key, post, quote, comment, slot) {
    const b = await deps.bind({ post: { page: post.page.slice(0, 2048), origin: post.origin.slice(0, 2048), id: post.id.slice(0, 64) }, quote });
    // (another request for this rid may have finished while this one was verifying: it is in flight-locked, but be sure)
    if (store.get(rid)) return { status: 200, body: { ok: true, ...viewOf(rid), repeated: true } };
    if (b.verdict !== 'verified') {
      const code = HUB_LINK_SAY[b.code] ? b.code : 'not-verified';
      logState(rid, 'refused', code);
      return { status: 422, body: { ok: false, error: 'refused', rid, state: 'refused', reason: code, say: HUB_LINK_SAY[code] } };
    }
    const filed = deps.fileReply({ bound: b, quote, comment });
    if (!filed || !filed.thread_id) {
      const code = (filed && HUB_LINK_SAY[filed.code]) ? filed.code : 'not-writable';
      logState(rid, 'refused', code);
      return { status: 422, body: { ok: false, error: 'refused', rid, state: 'refused', reason: code, say: HUB_LINK_SAY[code] } };
    }
    store.add({ rid, at: clock().toISOString(), intent: data.intent, page_url: filed.url, thread_id: filed.thread_id, entry_id: '', pressed_at: '', press_refused: '',
      msg_ts: String(filed.ts || ''), text_hash: textHashOf(comment), add_to: typeof data.add_to === 'string' ? data.add_to : '',
      post: { origin: String(b.origin || ''), id: String(b.id || ''), version: Number(b.version) || 0 } });
    slot.give();   // (the record counts itself from here)
    logState(rid, 'saved');
    if (data.intent === 'publish') await pressRecord(store.get(rid), key);
    return { status: 200, body: { ok: true, ...viewOf(rid) } };
  }

  // (each answers { status, body }; a rid in flight is waited for, so two copies of one request do the work once)
  const routes = {
    async ping(_data, key) { return { status: 200, body: { ok: true, version: HUB_LINK_VERSION, publish: key.publish, key_id: key.key_id, speech: speechGate() } }; },

    // ---- speech: a job, answered at once; the recording is in the job only (hub-speech.mjs) ----
    async transcribe(audio, _key, container) {
      const r = deps.speech.submit({ audio, container });
      if (!r.ok) return { status: r.status, body: { ok: false, error: r.error, ...(r.limit ? { limit: r.limit } : {}) } };
      return { status: 200, body: { ok: true, job: r.job, state: 'pending' } };
    },
    // WHAT A NEW REPLY TO THIS BLYG POST CAN BE ADDED TO: the plugin's own answer (0 or 1 post: the newest published from the post's
    // page, while it can take a comment). Public facts only: its id, address, title, first date, version.
    async earlier(data) {
      const p = data.post && typeof data.post === 'object' ? data.post : null;
      if (!p || typeof p.page !== 'string' || typeof p.origin !== 'string' || typeof p.id !== 'string') return { status: 400, body: { ok: false, error: 'post {page, origin, id} required' } };
      const list = (deps.earlier({ page: p.page.slice(0, 2048), origin: p.origin.slice(0, 2048), id: p.id.slice(0, 64) }) || []).filter(e => e && e.post);
      return { status: 200, body: { ok: true, earlier: list.map(e => ({ id: String(e.post), address: String(e.address || ''), permalink: String(e.permalink || ''),
        title: String(e.title || '').slice(0, 120), date: String(e.date || ''), version: Number(e.version) || 1 })) } };
    },
    async transcript(data) {
      // (speech off: its routes do not exist; said only after the signature, like every route's answer)
      if (speechGate() !== 'on') return { status: 404, body: { ok: false, error: 'not found' } };
      const id = typeof data.job === 'string' && /^[0-9a-f]{24}$/.test(data.job) ? data.job : '';
      if (!id) return { status: 400, body: { ok: false, error: 'job required' } };
      const v = deps.speech.view(id);
      if (!v) return { status: 404, body: { ok: false, error: 'unknown job' } };
      return { status: 200, body: { ok: true, ...v } };
    },

    async reply(data, key) {
      const rid = data.rid;
      if (!ridOk(rid)) return { status: 400, body: { ok: false, error: 'rid must be 8 to 64 letters, digits, - or _' } };
      const kept = store.get(rid);
      if (kept && kept.step === 'withdrawn') return { status: 409, body: { ok: false, error: 'cancelled', ...viewOf(rid), say: HUB_LINK_SAY.cancelled, repeated: true } };
      if (kept) return { status: 200, body: { ok: true, ...viewOf(rid), repeated: true } };
      const post = data.post && typeof data.post === 'object' ? data.post : {};
      const quote = str(data.quote, HUB_LINK_LIMITS.bodyBytes), comment = str(data.comment, HUB_LINK_LIMITS.bodyBytes);
      if (!quote.trim()) return { status: 400, body: { ok: false, error: 'quote required' } };
      if (!comment.trim()) return { status: 400, body: { ok: false, error: 'comment required' } };
      if (!HUB_LINK_INTENTS.includes(data.intent)) return { status: 400, body: { ok: false, error: 'intent must be publish or draft' } };
      if (data.add_to !== undefined && !(typeof data.add_to === 'string' && POST_ID_RE.test(data.add_to))) return { status: 400, body: { ok: false, error: 'add_to must be a post id from earlier' } };
      if (typeof post.page !== 'string' || typeof post.origin !== 'string' || typeof post.id !== 'string') return { status: 400, body: { ok: false, error: 'post {page, origin, id, version} required' } };
      if (store.repliesSince(3600 * 1000) + holding.replies >= HUB_LINK_LIMITS.repliesPerHour) {
        logState(rid, 'limited', 'replies-per-hour');
        return { status: 429, body: { ok: false, error: 'limit', limit: 'replies-per-hour', say: HUB_LINK_SAY['replies-per-hour'] } };
      }
      const slot = holdReply();
      try { return await fileOne(rid, data, key, post, quote, comment, slot); } finally { slot.give(); }
    },

    async status(data) {
      const rids = Array.isArray(data.rids) ? data.rids : null;
      if (!rids || !rids.length || rids.length > HUB_LINK_LIMITS.statusRids || !rids.every(ridOk)) return { status: 400, body: { ok: false, error: `rids: 1 to ${HUB_LINK_LIMITS.statusRids} ids` } };
      const text = data.text === true;
      if (text && rids.length > HUB_LINK_LIMITS.textRids) return { status: 400, body: { ok: false, error: `text: for 1 to ${HUB_LINK_LIMITS.textRids} rids` } };
      // a rid still being filed is waited for (bounded): read now, it would be `unknown`, which the Hub takes for "never arrived"
      const busy = [...new Set(rids)].filter(rid => inflight.has(rid));
      if (busy.length) {
        let timer = null;
        const done = await Promise.race([Promise.allSettled(busy.map(rid => inflight.get(rid))).then(() => true),
          new Promise(r => { timer = setTimeout(() => r(false), statusWait); })]);
        clearTimeout(timer);
        if (!done) return { status: 503, body: { ok: false, error: 'a reply is still being filed; ask again' } };
      }
      for (const rid of new Set(rids)) settle(rid);
      const q = deps.queue();
      return { status: 200, body: { ok: true, replies: [...new Set(rids)].map(rid => viewOf(rid, q, { text })) } };
    },

    async publish(data, key) {
      const rid = data.rid;
      if (!ridOk(rid)) return { status: 400, body: { ok: false, error: 'rid required' } };
      const as = data.as === undefined ? 'as-asked' : data.as;
      if (!HUB_LINK_PUBLISH_AS.includes(as)) return { status: 400, body: { ok: false, error: `as must be one of ${HUB_LINK_PUBLISH_AS.join(', ')}` } };
      const rec = store.get(rid);
      if (!rec) return { status: 404, body: { ok: false, error: 'unknown rid', rid, state: 'unknown' } };
      if (rec.step === 'pressed') return { status: 200, body: { ok: true, ...viewOf(rid), repeated: true } };
      const now = viewOf(rid);
      if (now.state !== 'saved') return { status: 409, body: { ok: false, error: 'not a saved reply', ...now } };
      await pressRecord(rec, key, as);
      return { status: 200, body: { ok: true, ...viewOf(rid) } };
    },

    // ASK AGAIN for one agent passage of a saved draft (its gap: filled, edited or failed → pending), within the page's hourly limit
    async redo(data) {
      const rid = data.rid;
      if (!ridOk(rid) || typeof data.gap !== 'string' || !data.gap) return { status: 400, body: { ok: false, error: 'rid and gap required' } };
      const rec = store.get(rid);
      if (!rec) return { status: 404, body: { ok: false, error: 'unknown rid', rid, state: 'unknown' } };
      const v = viewOf(rid);
      if (rec.step !== 'saved' || v.state !== 'saved') return { status: 409, body: { ok: false, error: 'not a saved draft', ...v } };
      const page = deps.readPage(rec.page_url);
      const thread = page && (page.threads || []).find(t => t && t.id === rec.thread_id);
      settle(rid);
      const mine = filedMsgOf(rec, thread);
      const g = mine && (mine.gaps || []).find(x => x && x.id === data.gap && x.kind !== 'impyrt');
      if (!g) return { status: 404, body: { ok: false, error: 'no such passage', ...v } };
      // (the owner's own edit of a passage is theirs: asking again would throw it away)
      if (g.mode === 'edited-by-reader' || g.mode === 'adopted-by-reader') return { status: 409, body: { ok: false, error: 'edited-on-computer', say: HUB_LINK_SAY['edited-on-computer'], ...v } };
      if (!['filled-by-agent', 'failed'].includes(g.mode)) return { status: 409, body: { ok: false, error: 'that passage cannot be asked again now', ...v } };
      if (!(deps.gapBudget(rec.page_url) > 0)) { logState(rid, 'limited', 'passages-per-hour'); return { status: 429, body: { ok: false, error: 'limit', limit: 'passages-per-hour', say: HUB_LINK_SAY['passages-per-hour'], ...v } }; }
      const r = deps.redoGap({ url: rec.page_url, thread_id: rec.thread_id, ts: mine.ts, gap_id: g.id });
      if (!r || !r.ok) return { status: 409, body: { ok: false, error: 'that passage cannot be asked again now', ...viewOf(rid) } };
      logState(rid, 'redo');
      return { status: 200, body: { ok: true, ...viewOf(rid) } };
    },

    async cancel(data) {
      const rid = data.rid;
      if (!ridOk(rid)) return { status: 400, body: { ok: false, error: 'rid required' } };
      const rec = store.get(rid);
      // NEVER SEEN: the reply may still be on its way (the Hub cancels what it is not sure arrived). Remembered as withdrawn, so that
      // reply is refused as cancelled when it comes.
      if (!rec) { store.withdraw(rid); logState(rid, 'withdrawn'); return { status: 200, body: { ok: true, ...viewOf(rid) } }; }
      const v = viewOf(rid);
      if (v.state === 'cancelled') return { status: 200, body: { ok: true, ...v, repeated: true } };
      // A SAVED DRAFT is thrown away: its thread deleted (not one the owner pressed in the drawer: that is theirs, `v.state` says so)
      if (rec.step === 'saved' && v.state === 'saved') {
        const page = deps.readPage(rec.page_url);
        const thread = page && (page.threads || []).find(t => t && t.id === rec.thread_id);
        if (!untouchedSinceFiling(rec, thread)) return { status: 409, body: { ok: false, error: 'changed-on-computer', say: HUB_LINK_SAY['changed-on-computer'], ...v } };
        const d = deps.discard({ url: rec.page_url, thread_id: rec.thread_id, ts: filedMsgOf(rec, thread).ts });
        if (!d || !d.ok) return { status: 409, body: { ok: false, error: 'it could not be thrown away', ...viewOf(rid) } };
        store.move(rid, 'discarded', { discarded_at: clock().toISOString() });
        logState(rid, 'discarded');
        return { status: 200, body: { ok: true, ...viewOf(rid) } };
      }
      const e = entryOf(rec, deps.queue().entries);
      if (rec.step !== 'pressed' || !e) return { status: 409, body: { ok: false, error: 'not in the queue', ...v } };
      const r = deps.cancel(e.id);
      if (!r || !r.ok) return { status: 409, body: { ok: false, error: 'it can no longer be cancelled', ...viewOf(rid) } };
      logState(rid, 'cancelled');
      return { status: 200, body: { ok: true, ...viewOf(rid) } };
    },
  };

  // (`deadlineMs`: a body not all read by then is dropped: `late`)
  function readRaw(req, cap, deadlineMs = 0) {
    return new Promise(resolve => {
      const chunks = [];
      let size = 0, over = false;
      const timer = deadlineMs ? setTimeout(() => { if (!over) { over = true; resolve({ late: true }); } }, deadlineMs) : null;
      const done = v => { if (timer) clearTimeout(timer); resolve(v); };
      req.on('data', c => { if (over) return; size += c.length; if (size > cap) { over = true; done({ over: true }); return; } chunks.push(c); });
      req.on('end', () => { if (!over) { over = true; done({ body: Buffer.concat(chunks) }); } });
      req.on('error', () => { if (!over) { over = true; done({ over: true }); } });
    });
  }

  /** A recording: its type on the allow-list, its size under the cap, its type and length signed with its bytes, its first bytes the
   *  container its type names. The bytes go to the job and nowhere else. */
  async function handleAudio(req, res, url, name, key, refuse) {
    // BEFORE ANY BYTE IS READ: the headers' form, the key id and the time (the same 401 whether speech is on or off)
    const pre = preCheck({ headers: req.headers, key, nowSec: Math.floor(ms() / 1000) });
    if (!pre.ok) { req.resume(); say(`refused ${pre.why}`); res.writeHead(401, { ...JSON_HEAD, connection: 'close' }).end(JSON.stringify({ ok: false, error: 'refused' })); try { req.destroy(); } catch { /* gone */ } return; }
    const type = String(req.headers['content-type'] || '');
    const container = audioTypeOf(type);
    if (!container) return refuse(415, 'audio-type');
    const declared = Number(req.headers['content-length']);
    const tooLarge = (close = true) => { say('refused audio-too-large'); res.writeHead(413, { ...JSON_HEAD, ...(close ? { connection: 'close' } : {}) }).end(JSON.stringify({ ok: false, error: 'too-large', say: HUB_LINK_SAY['audio-too-large'] })); };
    // THE SIGNATURE BEFORE THE BODY: over the body hash and the length the request names (only a key holder reaches a read slot);
    // the body read must then be exactly that length with exactly that hash
    const named = String(req.headers[BODY_HASH_HEADER] || '');
    if (!/^[0-9a-f]{64}$/.test(named) || !Number.isFinite(declared) || declared < 1 || String(declared) !== String(req.headers['content-length']).trim()) {
      req.resume(); say('refused body-hash-header'); res.writeHead(401, { ...JSON_HEAD, connection: 'close' }).end(JSON.stringify({ ok: false, error: 'refused' })); try { req.destroy(); } catch { /* gone */ } return;
    }
    {
      const want = crypto.createHmac('sha256', Buffer.from(String(key.secret), 'base64url'))
        .update(stringToSign(url, String(req.headers[SIG_HEADERS.ts]), String(req.headers[SIG_HEADERS.nonce]), named, [type, String(declared)])).digest('hex');
      const sigOk = hexEqual(want, String(req.headers[SIG_HEADERS.sig]));
      const n = sigOk ? nonces.take(String(req.headers[SIG_HEADERS.nonce])) : '';
      if (!sigOk || n !== 'fresh') { req.resume(); say(`refused ${sigOk ? 'replayed-nonce' : 'bad-sig'}`); res.writeHead(401, { ...JSON_HEAD, connection: 'close' }).end(JSON.stringify({ ok: false, error: 'refused' })); try { req.destroy(); } catch { /* gone */ } return; }
    }
    // (a key holder's body declared too large but not absurdly: the body is drained and thrown away, so the Hub reads the 413 rather than a reset)
    if (Number.isFinite(declared) && declared > SPEECH_LIMITS.audioBytes) {
      if (declared > 2 * SPEECH_LIMITS.audioBytes) { tooLarge(); try { req.destroy(); } catch { /* gone */ } return; }
      req.resume(); return tooLarge(false);
    }
    // AT MOST 2 BODIES are read at once (each from a key holder), each within its deadline
    if (reading.n >= HUB_LINK_LIMITS.audioReading) { say('limited audio-reading'); res.writeHead(429, { ...JSON_HEAD, connection: 'close' }).end(JSON.stringify({ ok: false, error: 'limit', limit: 'audio-reading' })); try { req.destroy(); } catch { /* gone */ } return; }
    reading.n++;
    let got;
    try { got = await readRaw(req, SPEECH_LIMITS.audioBytes, audioReadMs); } finally { reading.n--; }
    if (got.late) { say('refused audio-late'); res.writeHead(408, { ...JSON_HEAD, connection: 'close' }).end(JSON.stringify({ ok: false, error: 'too-slow' })); try { req.destroy(); } catch { /* gone */ } return; }
    if (got.over) { tooLarge(); try { req.destroy(); } catch { /* gone */ } return; }
    if (got.body.length !== declared || bodyHashOf(got.body) !== named) { say('refused body-not-as-signed'); return answer(res, 401, { ok: false, error: 'refused' }); }
    // (speech off: said only to a caller that signed)
    if (speechGate() !== 'on') return answer(res, 404, { ok: false, error: 'not found' });
    if (!perMinute.take()) { say('limited requests-per-minute'); return answer(res, 429, { ok: false, error: 'limit', limit: 'requests-per-minute' }); }
    if (sniffAudio(got.body) !== container) { say('refused audio-bytes'); return answer(res, 415, { ok: false, error: 'not-audio', say: HUB_LINK_SAY['not-audio'] }); }
    try {
      const r = await routes[name](got.body, key, container);
      return answer(res, r.status, r.body);
    } catch { if (!res.headersSent) return answer(res, 500, { ok: false, error: 'internal error' }); }
  }

  /** The one entry point: server.mjs calls it for every URL under /hub-link/, before its own sign-in gate. */
  async function handle(req, res, url) {
    const { gate, key } = readLinkKey(deps.keyDir);
    // OFF (or a broken key file): the routes do not exist
    if (gate !== 'on') { req.resume(); return answer(res, 404, { ok: false, error: 'not found' }); }
    const name = ROUTE_BY_PATH.get(url);
    if (!name) { req.resume(); return answer(res, 404, { ok: false, error: 'not found' }); }
    const refuse = (status, why) => { req.resume(); say(`refused ${why}`); return answer(res, status, { ok: false, error: 'refused' }); };
    if (req.method !== 'POST') return refuse(405, 'method');
    // a browser page always sends an Origin on a POST; the Hub's server never does
    if (req.headers.origin !== undefined) return refuse(403, 'origin-header');
    if (String(req.url || '').includes('?')) return refuse(400, 'query');
    if (HUB_LINK_ROUTES[name].body === 'audio') return handleAudio(req, res, url, name, key, refuse);
    if (!isJson(req.headers['content-type'])) return refuse(415, 'content-type');
    const declared = Number(req.headers['content-length']);
    // THE one length limit: the encoded body. Said in a fixed sentence the Hub can show as it is.
    const tooLarge = () => { say('refused too-large'); res.writeHead(413, { ...JSON_HEAD, connection: 'close' }).end(JSON.stringify({ ok: false, error: 'too-large', say: HUB_LINK_SAY['too-large'] })); };
    if (Number.isFinite(declared) && declared > HUB_LINK_LIMITS.bodyBytes) { req.resume(); return tooLarge(); }
    const got = await readRaw(req, HUB_LINK_LIMITS.bodyBytes);
    if (got.over) { tooLarge(); try { req.destroy(); } catch { /* gone */ } return; }
    const v = verifySigned({ headers: req.headers, urlPath: url, body: got.body, key, nowSec: Math.floor(ms() / 1000), nonces });
    if (!v.ok) { say(`refused ${v.why}`); return answer(res, 401, { ok: false, error: 'refused' }); }
    if (!perMinute.take()) { say('limited requests-per-minute'); return answer(res, 429, { ok: false, error: 'limit', limit: 'requests-per-minute' }); }
    let data;
    try { data = JSON.parse(got.body.toString('utf8')); } catch { return answer(res, 400, { ok: false, error: 'not JSON' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return answer(res, 400, { ok: false, error: 'not a JSON object' });
    // (status too: with the records unreadable nothing true can be said about any rid, and `unknown` would be read as "not published";
    // speech touches no record)
    if (name !== 'ping' && name !== 'transcript' && name !== 'earlier' && store.state !== 'ok') { say('refused records-unreadable'); return answer(res, 503, { ok: false, error: 'the hub link records on the computer are unreadable' }); }
    const rid = ridOk(data.rid) ? data.rid : '';
    try {
      // one request per rid at a time: a copy arriving while the first works waits for it, then answers from the record
      while (rid && inflight.has(rid)) await inflight.get(rid).catch(() => {});
      const p = routes[name](data, key);
      if (rid) inflight.set(rid, p);
      const r = await p.finally(() => { if (rid && inflight.get(rid) === p) inflight.delete(rid); });
      return answer(res, r.status, r.body);
    } catch (e) {
      say(`${ridTag(rid)} error ${String((e && e.code) || 'internal').slice(0, 30)}`);
      // a rid already recorded (in memory, even when writing it to disk failed) answers its real state with the 500, never nothing
      let v = null;
      try { v = rid && store.get(rid) ? viewOf(rid) : null; } catch { v = null; }
      if (!res.headersSent) return answer(res, 500, { ok: false, error: 'internal error', ...(v || {}) });
    }
  }

  return { handle, viewOf, get records() { return store; } };
}
