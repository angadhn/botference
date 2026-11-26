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
import { ENTRY_STATES } from './blyg-queue.mjs';

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
});
/** The reply's intent, from the Hub's two buttons. */
export const HUB_LINK_INTENTS = Object.freeze(['publish', 'draft']);
/** Every route, one table: the handler is looked up here and nowhere else (an unknown name is 404). */
export const HUB_LINK_ROUTES = Object.freeze({
  ping: Object.freeze({ path: '/hub-link/ping', does: 'answers the link version and the publish setting' }),
  reply: Object.freeze({ path: '/hub-link/reply', does: 'files a reply as a thread on the post\'s page record; presses it when asked and allowed' }),
  status: Object.freeze({ path: '/hub-link/status', does: 'the state of up to 20 replies by rid' }),
  publish: Object.freeze({ path: '/hub-link/publish', does: 'presses a saved reply into the publish queue' }),
  cancel: Object.freeze({ path: '/hub-link/cancel', does: 'takes a reply out of the queue while it has not started' }),
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

/** A record's step, one field (`record.step`), moved only by moveRecord:
 *    saved      the thread is filed; nothing pressed (yet)
 *    pressed    a press was accepted by the queue (`entry_id`); never pressed again for this rid
 *    withdrawn  the Hub cancelled a rid this companion had never seen (the reply may still be on its way): born so, final; a reply
 *               with that rid is refused as cancelled. At most HUB_LINK_LIMITS.withdrawnMax kept (the oldest forgotten first), and
 *               like every record forgotten after 30 days */
export const RECORD_STEPS = Object.freeze(['saved', 'pressed', 'withdrawn']);
export const RECORD_MOVES = Object.freeze({ saved: Object.freeze(['pressed']), pressed: Object.freeze([]), withdrawn: Object.freeze([]) });
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
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
export const bodyHashOf = body => crypto.createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')).digest('hex');
export const stringToSign = (urlPath, ts, nonce, bodyHash) => `${HUB_LINK_VERSION}\nPOST\n${urlPath}\n${ts}\n${nonce}\n${bodyHash}`;
/** The signature the Hub sends (here for the tests and for anyone writing the other side). */
export function signRequest(secret, urlPath, ts, nonce, body) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'base64url')).update(stringToSign(urlPath, String(ts), nonce, bodyHashOf(body))).digest('hex');
}
/** Every header of a signed request (tests; the Hub's link-client.mjs does the same). */
export function signedHeaders({ key_id, secret }, urlPath, body, { ts = Math.floor(Date.now() / 1000), nonce = crypto.randomBytes(16).toString('hex') } = {}) {
  return { [SIG_HEADERS.key]: key_id, [SIG_HEADERS.ts]: String(ts), [SIG_HEADERS.nonce]: nonce, [SIG_HEADERS.sig]: signRequest(secret, urlPath, ts, nonce, body) };
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
export function verifySigned({ headers, urlPath, body, key, nowSec, nonces }) {
  const h = headers || {};
  const kid = String(h[SIG_HEADERS.key] || ''), tsRaw = String(h[SIG_HEADERS.ts] || ''), nonce = String(h[SIG_HEADERS.nonce] || ''), sig = String(h[SIG_HEADERS.sig] || '');
  if (!kid || !tsRaw || !nonce || !sig) return { ok: false, why: 'missing-header' };
  // (the key id is not a secret: it names which key, so a rotated one is told apart in the log)
  if (kid !== key.key_id) return { ok: false, why: 'wrong-key' };
  if (!/^\d{1,12}$/.test(tsRaw)) return { ok: false, why: 'bad-ts' };
  if (Math.abs(Number(tsRaw) - nowSec) > HUB_LINK_LIMITS.skewSec) return { ok: false, why: 'stale-ts' };
  if (!NONCE_RE.test(nonce)) return { ok: false, why: 'bad-nonce' };
  if (!SIG_RE.test(sig)) return { ok: false, why: 'bad-sig' };
  const want = signRequest(key.secret, urlPath, tsRaw, nonce, body);
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
export function linkStateOf(record, page, queue) {
  if (!record) return 'unknown';
  if (record.step === 'withdrawn') return 'cancelled';
  const thread = page && Array.isArray(page.threads) ? page.threads.find(t => t && t.id === record.thread_id) : null;
  const published = !!(thread && thread.blyg_published && thread.blyg_published.at);
  if (record.step === 'saved') return !thread ? 'cancelled' : published ? 'published' : 'saved';
  const e = entryOf(record, queue && queue.entries);
  if (!e) return published ? 'published' : !thread ? 'cancelled' : 'failed';
  const run = queue && queue.run;
  if (e.state === 'running' && run && run.id && run.id === e.run && run.mode === 'planned' && run.confirm === 'always') return 'awaiting_look';
  return ENTRY_TO_LINK[e.state];
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
    withdraw(rid) {
      if (recs.has(rid)) throw new Error('hub link record: rid already kept');
      const old = [...recs.values()].filter(r => r.step === 'withdrawn');
      for (const r of old.slice(0, Math.max(0, old.length - HUB_LINK_LIMITS.withdrawnMax + 1))) recs.delete(r.rid);
      recs.set(rid, { rid, step: 'withdrawn', at: now().toISOString() });
      persist();
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
});

/**
 * deps: {
 *   keyDir, repliesFile, now() → Date,
 *   bind({ post, quote }) → Promise<{ verdict: 'verified', url } | { verdict: 'unverified', code, reason }>   (verifyShown, source hub)
 *   fileReply({ bound, quote, comment }) → { url, thread_id } | { code }   (a thread on the verified page, owner-typed on channel hub-link)
 *   press({ url, thread_id }) → Promise<blyg-queue press answer>   (by 'hub-link')
 *   cancel(entry_id) → blyg-queue cancel answer
 *   queue() → { entries, run }        readPage(url) → page | null
 *   log(line), perMinute (tests only: the request limit a minute)
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
  const holdReply = () => { let held = true; holding.replies++; return { give() { if (held) { held = false; holding.replies--; } } }; };

  const stateFor = (rec, q) => {
    const page = rec ? deps.readPage(rec.page_url) : null;
    return { page, state: linkStateOf(rec, page, q) };
  };
  /** What the Hub is told about one rid: its state, and what it shows with it. Nothing else of the page is ever in it. */
  function viewOf(rid, q = deps.queue()) {
    const rec = store.get(rid);
    const { page, state } = stateFor(rec, q);
    const v = { rid, state };
    if (!rec) return v;
    const thread = page && (page.threads || []).find(t => t && t.id === rec.thread_id);
    const first = thread && (thread.msgs || [])[0];
    const gaps = first && Array.isArray(first.gaps) ? first.gaps.filter(g => g && g.mode !== 'removed') : [];
    if (gaps.length) v.gaps = { total: gaps.length, written: gaps.filter(g => g.mode !== 'pending').length, failed: gaps.filter(g => g.mode === 'failed').length };
    const e = entryOf(rec, q.entries);
    if (state === 'queued' && e) v.ahead = Number(e.ahead) || 0;
    if (state === 'published') {
      const p = (thread && thread.blyg_published) || {};
      const r = (e && e.result) || {};
      v.address = String(r.address || p.permalink || '');
      v.version = Number(r.version || p.version) || 1;
    }
    if (state === 'failed' && e && e.failure && e.failure.say) v.say = scrubPaths(e.failure.say).slice(0, 400);
    if (state === 'saved' && rec.press_refused) v.press = { refused: rec.press_refused, say: HUB_LINK_SAY[rec.press_refused] || '' };
    return v;
  }
  const logState = (rid, what, extra = '') => say(`${ridTag(rid)} ${what}${extra ? ` ${extra}` : ''}`);

  /** A press for a saved record: the publish setting, the day's limit, then the queue. Writes the record's step on success. */
  async function pressRecord(rec, key) {
    const refuse = code => { store.note(rec.rid, { press_refused: code }); logState(rec.rid, 'press-refused', code); return code; };
    if (key.publish !== 'one-click') return refuse('drafts-only');
    if (store.pressesSince(86400 * 1000) + holding.presses >= HUB_LINK_LIMITS.publishesPerDay) return refuse('publishes-per-day');
    holding.presses++;
    let r;
    try { r = await deps.press({ url: rec.page_url, thread_id: rec.thread_id }); } finally { holding.presses--; }
    if (!r || !r.ok || !r.queued) return refuse(r && /not set up/i.test(String(r.error || '')) ? 'not-set-up' : 'queue-refused');
    store.move(rec.rid, 'pressed', { entry_id: String(r.queued.id), pressed_at: clock().toISOString(), press_refused: '' });
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
      post: { origin: String(b.origin || ''), id: String(b.id || ''), version: Number(b.version) || 0 } });
    slot.give();   // (the record counts itself from here)
    logState(rid, 'saved');
    if (data.intent === 'publish') await pressRecord(store.get(rid), key);
    return { status: 200, body: { ok: true, ...viewOf(rid) } };
  }

  // (each answers { status, body }; a rid in flight is waited for, so two copies of one request do the work once)
  const routes = {
    async ping(_data, key) { return { status: 200, body: { ok: true, version: HUB_LINK_VERSION, publish: key.publish, key_id: key.key_id } }; },

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
      const q = deps.queue();
      return { status: 200, body: { ok: true, replies: [...new Set(rids)].map(rid => viewOf(rid, q)) } };
    },

    async publish(data, key) {
      const rid = data.rid;
      if (!ridOk(rid)) return { status: 400, body: { ok: false, error: 'rid required' } };
      const rec = store.get(rid);
      if (!rec) return { status: 404, body: { ok: false, error: 'unknown rid', rid, state: 'unknown' } };
      if (rec.step === 'pressed') return { status: 200, body: { ok: true, ...viewOf(rid), repeated: true } };
      const now = viewOf(rid);
      if (now.state !== 'saved') return { status: 409, body: { ok: false, error: 'not a saved reply', ...now } };
      await pressRecord(rec, key);
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
      const e = entryOf(rec, deps.queue().entries);
      if (rec.step !== 'pressed' || !e) return { status: 409, body: { ok: false, error: 'not in the queue', ...v } };
      const r = deps.cancel(e.id);
      if (!r || !r.ok) return { status: 409, body: { ok: false, error: 'it can no longer be cancelled', ...viewOf(rid) } };
      logState(rid, 'cancelled');
      return { status: 200, body: { ok: true, ...viewOf(rid) } };
    },
  };

  function readRaw(req, cap) {
    return new Promise(resolve => {
      const chunks = [];
      let size = 0, over = false;
      req.on('data', c => { if (over) return; size += c.length; if (size > cap) { over = true; resolve({ over: true }); return; } chunks.push(c); });
      req.on('end', () => { if (!over) resolve({ body: Buffer.concat(chunks) }); });
      req.on('error', () => { if (!over) { over = true; resolve({ over: true }); } });
    });
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
    // (status too: with the records unreadable nothing true can be said about any rid, and `unknown` would be read as "not published")
    if (name !== 'ping' && store.state !== 'ok') { say('refused records-unreadable'); return answer(res, 503, { ok: false, error: 'the hub link records on the computer are unreadable' }); }
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
