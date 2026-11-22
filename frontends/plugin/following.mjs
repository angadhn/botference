// following.mjs — "Following": a private reading feed of blyg posts inside Discuss.
//
// The reader follows blygs (https://blygger.org/spec/0.4/); the companion keeps,
// per followed blyg, what its archive index says it holds, and shows one list
// of what is new. This is the READING half of a Blygger client: it publishes
// nothing, mentions nothing, and tells no blyg what it is read by whom.
//
// THE ONE WAY TO THE WEB. Every request here is made by netguard.mjs's
// guardedGet (or a test's stand-in for it, injected as `get`); this file never
// calls fetch, http or https itself (test/following.test.mjs reads the source
// to make sure). So the guard's rules (no private addresses, redirects judged
// hop by hop, time and size limits) hold for every request Following makes.
//
// WHAT IS NAMED, each as ONE list with ONE field and ONE function that moves
// it and refuses a move that is not in the table:
//   BLYG_STATES    a followed blyg's standing:        moveBlyg
//   READ_STATES    a post's read state:               moveRead
//   RUN_STATES     whether a reconciliation is going: moveRun
//   BREAKER_STATES a host's circuit breaker:          moveBreaker
//   SCHEDULE_MODES whether the refresh timer is armed: moveSchedule
//   IDENTITY_STATES whether the page a reader opened agreed with what the
//                   list knew about it:                setIdentity
//
// WHAT IS KEPT, per post (never the whole HTML): origin, id, kind, current
// version, created, updated, title (first heading) or excerpt, stub_of, how
// many transclusions and links, withdrawn or not, and the sanitised plain text
// the list needs (clipped). One record per post, at its newest version (the
// rollup, §13.1); a withdrawn post is kept only as a bare marker so it is not
// fetched again (§13.4), and leaves every list.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { guardedGet as netGet, FetchTrouble, urlRefusal } from './netguard.mjs';
import { readJsonState, writeJson, refuseIfUnreadable, warnUnreadable } from './fsjson.mjs';
import { session, findManifest, identityOf, isManifest, ID_RE, clip, textContent, isWebUrl, samePage,
  docRefusal, cleanHints, candidateBase, pageLinks, LIMITS as BLYG_LIMITS } from './blyg.mjs';

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

// A post's read state. `responded` is set when a note for the post is exported.
export const READ_STATES = Object.freeze(['new', 'seen', 'opened', 'responded']);
export const READ_MOVES = Object.freeze({
  see: { new: 'seen' },
  open: { new: 'opened', seen: 'opened', opened: 'opened' },
  respond: { new: 'responded', seen: 'responded', opened: 'responded', responded: 'responded' },
  // an edit that changes the words (not a maintenance version) puts a read post back
  resurface: { seen: 'new', opened: 'new' },
});
const readMachine = machine('read state', READ_STATES, READ_MOVES);
export const canMoveRead = (rec, ev) => readMachine.can(rec.read, ev);
export function moveRead(rec, ev) { rec.read = readMachine.to(rec.read, ev); return rec.read; }

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

// Whether the refresh timer is armed. It is armed exactly while something is followed.
export const SCHEDULE_MODES = Object.freeze(['off', 'scheduled']);
export const SCHEDULE_MOVES = Object.freeze({
  arm: { off: 'scheduled', scheduled: 'scheduled' },
  disarm: { scheduled: 'off' },
});
const scheduleMachine = machine('schedule', SCHEDULE_MODES, SCHEDULE_MOVES);
export function moveSchedule(s, ev) { s.mode = scheduleMachine.to(s.mode, ev); return s.mode; }

// Whether the page a reader opened from the list was the post the list said.
//   unverified — nothing to compare yet (no hints from the page)
//   agrees     — the page's own links name the same blyg and post
//   disagrees  — they name something else: the list's word is NOT used for it
export const IDENTITY_STATES = Object.freeze(['unverified', 'agrees', 'disagrees']);
export const IDENTITY_MOVES = Object.freeze({
  agree: { unverified: 'agrees', agrees: 'agrees', disagrees: 'agrees' },
  disagree: { unverified: 'disagrees', agrees: 'disagrees', disagrees: 'disagrees' },
});
const identityMachine = machine('identity', IDENTITY_STATES, IDENTITY_MOVES);
export function setIdentity(rec, ev) { rec.identity = identityMachine.to(rec.identity, ev); return rec.identity; }

// ---- limits ----------------------------------------------------------------
export const LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  indexBytes: 4 * 1024 * 1024,
  itemBytes: 4 * 1024 * 1024,
  importBytes: 1024 * 1024,
  timeoutMs: 8000,
  indexEntries: 20000,        // more entries than this in one index are not read
  docsPerBlygRun: 50,         // item documents fetched for one blyg in one run
  followMax: 500,             // blygs followed
  importMax: 100,             // entries of a blogroll resolved in one preview
  importRequests: 300,        // requests one preview may make
  followRequests: 12,          // requests following one URL may make (§12.1: six, plus slack)
  textChars: 1200, excerptChars: 240, titleChars: 160, refsKept: 50, refOriginsKept: 20,
  burstMs: 10 * 60 * 1000,    // items created this close to their thread's publish are one burst
  backoffFirstMs: 10 * 60 * 1000, backoffMaxMs: 6 * 60 * 60 * 1000,
  goneAfter: 3,               // consecutive "no manifest here" answers before a blyg is gone
});
const KINDS = ['fragment', 'thread', 'withdrawn'];

// ---- clean strings out of remote documents ----------------------------------
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
/** A string out of somebody else's document, made safe to keep AND to show: no control or bidirectional-override characters, one line, bounded. */
export const cleanText = (v, n = 300) => clip(String(typeof v === 'string' ? v : '').replace(/[\u0080-\u009f]/g, ' ').replace(BIDI, ''), n);

export const keyOf = (origin, id) => crypto.createHash('sha1').update(`${origin}\n${id}`).digest('hex').slice(0, 20);
const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

// ---- reading what the reader gives us (pure) --------------------------------
const xmlDecode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
  const l = e.toLowerCase();
  if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'amp') return '&';
  if (l === 'quot') return '"'; if (l === 'apos') return "'";
  const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
});
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
const originOfUrl = v => { try { const u = new URL(String(v || '').trim()); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };
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
/** → the record to keep for a verified item document, or { invalid: why }. */
export function recordFromDoc(doc, origin, blyg = {}) {
  if (!KINDS.includes(doc.kind)) return { invalid: 'a kind this version does not know' };
  let page = '';
  try { page = new URL(typeof doc.page === 'string' && doc.page ? doc.page : `${doc.kind === 'fragment' ? 'f' : 't'}/${doc.id}/`, origin).href; } catch { page = ''; }
  // a post's page must be on the blyg's own host: the list vouches for the page's
  // identity (identityFor), and a blyg may not vouch for a page that is not its own
  if (!isWebUrl(page) || hostOf(page) !== hostOf(origin)) return { invalid: 'its page is not on the blyg\'s own host' };
  const withdrawn = doc.kind === 'withdrawn';
  const base = { key: keyOf(origin, doc.id), origin, id: doc.id, kind: doc.kind, version: doc.version,
    created: cleanText(doc.created, 40), updated: cleanText(doc.updated, 40), page, content_hash: doc.content_hash,
    withdrawn, stub_of: null, transclusions: 0, links: 0, refs: [], ref_origins: [], title: '', excerpt: '', text: '', author: '' };
  if (withdrawn) return base;
  const lines = textContent(doc.content_html).split('\n').map(l => cleanText(l, 2000)).filter(Boolean);
  const title = firstHeading(doc.content_html);
  if (title && lines.length && lines[0] === title) lines.shift();
  const body = lines.join(' ');
  const refsAll = (Array.isArray(doc.transclusions) ? doc.transclusions : []).map(r => refOf(r, origin)).filter(Boolean);
  const stub = doc.stub_of && typeof doc.stub_of === 'object' ? doc.stub_of : null;
  const stubOrigin = stub ? originOf(stub.origin) : '';
  return {
    ...base, title, excerpt: cleanText(body, LIMITS.excerptChars), text: cleanText(body, LIMITS.textChars),
    author: cleanText(doc.author && typeof doc.author === 'object' ? doc.author.name : '', 200) || blyg.author || '',
    stub_of: stubOrigin ? { origin: stubOrigin, id: ID_RE.test(String(stub.id || '')) ? stub.id : '' } : null,
    transclusions: Array.isArray(doc.transclusions) ? doc.transclusions.length : 0,
    links: Array.isArray(doc.links) ? doc.links.length : 0,
    refs: refsAll.slice(0, LIMITS.refsKept),
    ref_origins: [...new Set(refsAll.map(r => r.origin))].slice(0, LIMITS.refOriginsKept),
  };
}

// ---- the view (pure) ----------------------------------------------------------
export const FILTERS = Object.freeze(['all', 'new', 'threads', 'fragments', 'responses']);
export const FILTER_LABELS = Object.freeze({ all: 'All', new: 'New', threads: 'Threads', fragments: 'Fragments', responses: 'Responses to me' });
export const filterOf = v => (FILTERS.includes(v) ? v : 'all');

const isResponseToMe = (it, mine) => !mine.includes(it.origin)
  && ((it.stub_of && mine.includes(it.stub_of.origin)) || (it.ref_origins || []).some(o => mine.includes(o)));
const when = it => Date.parse(it.updated) || Date.parse(it.created) || 0;

/**
 * Burst folding (§13.7), display only. A thread and the posts of the SAME blyg
 * its transclusions name, whose `created` is within burstMs of the thread's
 * created or updated (the publish that first named them), are one burst under
 * the thread. A post is in at most one burst. Nothing is left out.
 * → [{ head, members }] in no particular order.
 */
export function foldBursts(items) {
  const byKey = new Map(items.map(i => [i.key, i]));
  const claimed = new Set();
  const heads = new Map(items.map(i => [i.key, { head: i, members: [] }]));
  const threads = items.filter(i => i.kind === 'thread').sort((a, b) => (Date.parse(a.created) || 0) - (Date.parse(b.created) || 0));
  for (const t of threads) {
    const near = [Date.parse(t.created), Date.parse(t.updated)].filter(Number.isFinite);
    for (const r of t.refs || []) {
      if (r.origin !== t.origin) continue;
      const k = keyOf(r.origin, r.id);
      const m = byKey.get(k);
      if (!m || m.key === t.key || m.kind === 'thread' || claimed.has(k)) continue;
      const c = Date.parse(m.created);
      if (!Number.isFinite(c) || !near.some(n => Math.abs(n - c) <= LIMITS.burstMs)) continue;
      claimed.add(k);
      heads.get(t.key).members.push(m);
    }
  }
  return [...heads.values()].filter(h => !claimed.has(h.head.key));
}

/** The list for one filter: [{ head, members }] newest first, plus the count behind every filter. */
export function listFor(allItems, filter, mine = []) {
  const live = allItems.filter(i => !i.withdrawn);
  const pick = {
    all: () => foldBursts(live),
    new: () => foldBursts(live).filter(e => e.head.read === 'new' || e.members.some(m => m.read === 'new')),
    threads: () => live.filter(i => i.kind === 'thread').map(head => ({ head, members: [] })),
    fragments: () => live.filter(i => i.kind === 'fragment').map(head => ({ head, members: [] })),
    responses: () => live.filter(i => isResponseToMe(i, mine)).map(head => ({ head, members: [] })),
  };
  const counts = {};
  for (const f of FILTERS) counts[f] = pick[f]().length;
  const entries = pick[filterOf(filter)]()
    .sort((a, b) => Math.max(when(b.head), ...b.members.map(when)) - Math.max(when(a.head), ...a.members.map(when)));
  for (const e of entries) e.members.sort((a, b) => when(b) - when(a));
  return { entries, counts };
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

// ---- the engine -----------------------------------------------------------------------
export function createFollowing({ file, get = netGet, now = Date.now, getSettings = () => followingSettingsOf({}).settings,
  timers = { set: (fn, ms) => setInterval(fn, ms), clear: h => clearInterval(h) }, onChange = () => {} } = {}) {
  let state = null; // { blygs, items, last_run }
  const load = () => {
    if (state) return state;
    const got = readJsonState(file);
    if (got.state === 'unreadable') warnUnreadable(file, got.error);
    const v = got.state === 'ok' && got.value && typeof got.value === 'object' ? got.value : {};
    state = { blygs: v.blygs && typeof v.blygs === 'object' ? v.blygs : {}, items: v.items && typeof v.items === 'object' ? v.items : {},
      last_run: v.last_run || null };
    // a hand-edited record never makes the engine fetch something the reader paused
    for (const b of Object.values(state.blygs)) if (!BLYG_STATES.includes(b.state)) b.state = 'paused';
    for (const i of Object.values(state.items)) if (!READ_STATES.includes(i.read)) i.read = 'seen';
    for (const i of Object.values(state.items)) if (!IDENTITY_STATES.includes(i.identity)) i.identity = 'unverified';
    return state;
  };
  const save = () => { refuseIfUnreadable(file); writeJson(file, load()); };
  const run = { state: 'idle' };
  const schedule = { mode: 'off' };
  let timer = null;
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

  // The ONLY place a request is made: counted against the budget, refused by an
  // open breaker, judged by the guard (get = netguard's guardedGet).
  const getter = budget => async (url, { maxBytes, accept = 'application/json', timeoutMs = LIMITS.timeoutMs } = {}) => {
    const host = hostOf(url);
    if (!breakerAllows(host)) throw new FetchTrouble('breaker', `${host} failed too often; not asked again for a while`);
    budget.take();
    let r;
    try { r = await get(String(url), { maxBytes, accept, timeoutMs: Math.max(1, Math.min(timeoutMs, budget.left())) }); }
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
    for (const [k, i] of Object.entries(st.items)) if (i.origin === origin) delete st.items[k];
    save(); reschedule(); onChange();
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
  const listBlygs = () => Object.values(load().blygs).map(b => ({ ...b, items: itemsOf(b.origin).filter(i => !i.withdrawn).length }));

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
      const entries = parseOpml(body);
      let n = 0;
      for (const e of entries) {
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
      if (!origin || urlRefusalOf(origin)) { skipped.push(String(e && e.origin || '').slice(0, 200)); continue; }
      try { if (addBlyg({ origin, title: e.title, author: e.author, via: 'import' })) added.push(origin); else skipped.push(origin); }
      catch { skipped.push(origin); }
    }
    if (added.length) { save(); reschedule(); onChange(); }
    return { added, skipped };
  }
  const urlRefusalOf = origin => urlRefusal(origin);

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

  /** One blyg: manifest, index, diff, changed documents. → counts. */
  async function reconcileBlyg(b, g, cfg, tally) {
    const st = load();
    b.last_try = now();
    const man = await fetchJson(g, new URL('blyg.json', b.origin).href, LIMITS.manifestBytes);
    if (man.status === 'trouble') return halt(b, man, tally);
    if (man.status !== 'ok' || !isManifest(man.json) || identityOf(man.url) !== b.origin) {
      noteFailure(b, 'absent', 'it has no manifest at its origin'); tally.absent++; return;
    }
    b.title = cleanText(man.json.title, 200) || b.title;
    b.author = cleanText(man.json.author && man.json.author.name, 200) || b.author;
    let indexUrl;
    try { indexUrl = new URL(typeof man.json.items === 'string' && man.json.items ? man.json.items : 'items/index.json', b.origin).href; } catch { indexUrl = ''; }
    if (!isWebUrl(indexUrl)) { noteFailure(b, 'absent', 'its items index is not a web address'); tally.absent++; return; }
    const idx = await fetchJson(g, indexUrl, LIMITS.indexBytes);
    if (idx.status === 'trouble') return halt(b, idx, tally);
    if (idx.status !== 'ok' || !Array.isArray(idx.json.items)) { noteFailure(b, 'absent', 'it has no items index'); tally.absent++; return; }
    // the manifest and the index answered: this blyg is reachable and present
    if (canMoveBlyg(b, 'recover')) moveBlyg(b, 'recover');
    b.failures = 0; b.absent_runs = 0; b.retry_after = 0; b.last_error = ''; b.last_ok = now();

    const entries = [];
    for (const e of idx.json.items.slice(0, LIMITS.indexEntries)) {
      if (e && ID_RE.test(String(e.id || '')) && KINDS.includes(e.kind) && Number.isInteger(e.version) && e.version >= 1) {
        entries.push({ id: e.id, kind: e.kind, version: e.version, created: cleanText(e.created, 40), updated: cleanText(e.updated, 40) });
      }
    }
    entries.sort((a, c) => (Date.parse(c.updated) || 0) - (Date.parse(a.updated) || 0));
    // the window: the newest `perBlyg` live posts; withdrawn ones cost nothing to hold
    let live = 0;
    const window = entries.filter(e => e.kind === 'withdrawn' || live++ < cfg.following_max_items_per_blyg);
    const inWindow = new Set(window.map(e => keyOf(b.origin, e.id)));
    // A held post that is not in the window is dropped: either it is gone from the index entirely
    // (the index lists every post ever published, §6.2) or it is older than the per-blyg cap.
    for (const i of itemsOf(b.origin)) if (!inWindow.has(i.key)) { delete st.items[i.key]; tally.removed++; }

    let docs = 0;
    for (const e of window) {
      const key = keyOf(b.origin, e.id);
      const held = st.items[key];
      if (held && e.version < held.version) { tally.regressions++; continue; } // §13.3: a lower version is not adopted
      if (e.kind === 'withdrawn') {
        if (held && !held.withdrawn) { st.items[key] = { ...tombstone(held), version: e.version }; tally.withdrawn++; }
        continue;
      }
      if (held && !held.withdrawn && e.version === held.version) continue;
      if (held && held.withdrawn && e.version <= held.version) continue;
      if (!held && totalItems() >= cfg.following_max_items_total) { tally.capped++; continue; }
      if (docs >= LIMITS.docsPerBlygRun || budgetSpent(g)) { tally.deferred++; continue; }
      docs++;
      const r = await fetchJson(g, itemUrlFor(man.json, b.origin, e.id), LIMITS.itemBytes);
      if (r.status === 'trouble') { tally.errors++; if (r.kind === 'limit') tally.deferred++; continue; }
      const doc = r.json;
      if (r.status !== 'ok' || docRefusal(doc, { id: e.id, origin: b.origin })) { tally.invalid++; continue; }
      const rec = recordFromDoc(doc, b.origin, b);
      if (rec.invalid) { tally.invalid++; continue; }
      if (held && rec.version < held.version) { tally.regressions++; continue; }
      if (rec.withdrawn) { st.items[key] = { ...tombstone(held || rec), version: rec.version }; tally.withdrawn++; continue; }
      if (!held || held.withdrawn) {
        st.items[key] = { ...rec, read: 'new', identity: 'unverified', first_seen: new Date(now()).toISOString(), maintenance: 0 };
        tally.new++;
      } else if (held.content_hash === rec.content_hash) {
        // §13.2: same words, new version: kept current, never resurfaced
        st.items[key] = { ...held, ...rec, read: held.read, identity: held.identity, first_seen: held.first_seen, maintenance: (held.maintenance || 0) + 1 };
        tally.maintenance++;
      } else {
        st.items[key] = { ...held, ...rec, read: held.read, identity: held.identity, first_seen: held.first_seen, maintenance: held.maintenance || 0 };
        if (canMoveRead(st.items[key], 'resurface')) moveRead(st.items[key], 'resurface');
        tally.edited++;
      }
    }
  }
  const budgetSpent = g => g.budget.spent();
  const totalItems = () => Object.values(load().items).filter(i => !i.withdrawn).length;
  const tombstone = i => ({ key: i.key, origin: i.origin, id: i.id, kind: 'withdrawn', version: i.version, created: i.created, updated: i.updated,
    page: i.page, content_hash: i.content_hash, withdrawn: true, read: i.read || 'seen', identity: i.identity || 'unverified',
    stub_of: null, transclusions: 0, links: 0, refs: [], ref_origins: [], title: '', excerpt: '', text: '', author: '', first_seen: i.first_seen, maintenance: 0 });
  const itemUrlFor = (manifest, origin, id) => {
    const t = typeof manifest.item === 'string' && manifest.item ? manifest.item : 'items/{id}.json';
    try { return new URL(t.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(k === 'id' ? id : '')), origin).href; } catch { return ''; }
  };
  function halt(b, r, tally) {
    // out of budget, or the host's breaker is open: not the blyg's fault, no mark against it
    if (r.kind === 'limit' || r.kind === 'breaker') { tally.deferred++; return; }
    noteFailure(b, 'trouble', r.message); tally.unreachable++;
  }

  /** Refresh every blyg that is due. At most one run at a time; a second ask while one is going is refused, not queued. */
  async function refresh({ reason = 'demand' } = {}) {
    if (run.state !== 'idle') return { started: false, reason: 'a refresh is already running' };
    moveRun(run, 'begin');
    const cfg = settings();
    const budget = newBudget(cfg, now);
    const g = getter(budget); g.budget = budget;
    const tally = { reason, new: 0, edited: 0, maintenance: 0, withdrawn: 0, removed: 0, regressions: 0, capped: 0, deferred: 0,
      errors: 0, invalid: 0, absent: 0, unreachable: 0, blygs: 0, skipped: 0, requests: 0 };
    try {
      const todo = Object.values(load().blygs).filter(due).sort((a, b) => (a.last_try || 0) - (b.last_try || 0));
      tally.skipped = Object.keys(load().blygs).length - todo.length;
      for (const b of todo) {
        if (budget.spent()) { tally.deferred++; continue; }
        try { await reconcileBlyg(b, g, cfg, tally); tally.blygs++; }
        catch (e) { tally.errors++; console.warn(`[following] ${cleanText(String(e && e.message), 200)}`); }
        save();
      }
      tally.requests = budget.requests;
      load().last_run = { ...tally, at: new Date(now()).toISOString() };
      save();
    } finally { moveRun(run, 'end'); }
    onChange();
    return { started: true, ...tally };
  }

  // ---- the timer ----
  function reschedule() {
    const want = Object.keys(load().blygs).length > 0;
    if (timer !== null) { timers.clear(timer); timer = null; }
    if (!want) { if (schedule.mode === 'scheduled') moveSchedule(schedule, 'disarm'); return schedule.mode; }
    moveSchedule(schedule, 'arm');
    const t = timers.set(() => { refresh({ reason: 'timer' }).catch(e => console.warn(`[following] ${e.message}`)); },
      settings().following_refresh_minutes * 60 * 1000);
    if (t && t.unref) t.unref();
    timer = t;
    return schedule.mode;
  }

  // ---- reading state, identity ----
  function readMove(key, ev) {
    const rec = load().items[key];
    if (!rec || rec.withdrawn) throw new Error('no such post');
    moveRead(rec, ev); save(); onChange();
    return rec.read;
  }
  function markAllSeen(origin = '') {
    let n = 0;
    for (const i of Object.values(load().items)) {
      if (i.withdrawn || (origin && i.origin !== origin) || !canMoveRead(i, 'see')) continue;
      moveRead(i, 'see'); n++;
    }
    if (n) { save(); onChange(); }
    return n;
  }
  /** A note for this post was exported: its read state becomes `responded`. → false when the post is not on the list. */
  function markResponded(origin, id) {
    const rec = load().items[keyOf(String(origin), String(id))];
    if (!rec || rec.withdrawn) return false;
    moveRead(rec, 'respond'); save(); onChange();
    return true;
  }
  /**
   * The page at `url` is a post the list holds? → { verdict, item?, result? }
   *   none        the list knows no such page
   *   agrees      the page's own links (`hints`, from blyg.cleanHints) name the same blyg and post
   *   unverified  the page sent no links to compare; the list's word is used
   *   disagrees   the page's links name another blyg or post; the list's word is NOT used
   * For agrees and unverified, `result` has the shape blyg.detect answers, built
   * from what the list holds, so detection is skipped.
   */
  function identityFor(url, hints) {
    const rec = Object.values(load().items).find(i => !i.withdrawn && i.page && samePage(i.page, url));
    if (!rec) return { verdict: 'none' };
    const blyg = load().blygs[rec.origin];
    if (!blyg) return { verdict: 'none' };
    const h = cleanHints(hints) || { blyg: '', json: '' };
    let why = '';
    if (h.json) {
      const named = new URL(h.json).pathname.split(/[/.]/).filter(seg => ID_RE.test(seg));
      if (named.length && !named.includes(rec.id)) why = `the page's own link names post ${named[0]}, the list says ${rec.id}`;
    }
    if (!why && h.blyg) {
      const asManifest = identityOf(h.blyg), asBase = candidateBase(h.blyg);
      if (asManifest !== rec.origin && asBase !== rec.origin) why = `the page's own link names the blyg at ${cleanText(asManifest, 200)}, the list says ${rec.origin}`;
    }
    if (why) {
      setIdentity(rec, 'disagree'); rec.identity_note = cleanText(why, 300); save(); onChange();
      return { verdict: 'disagrees', item: rec, reason: why };
    }
    const verdict = h.blyg || h.json ? 'agrees' : 'unverified';
    if (verdict === 'agrees' && rec.identity !== 'agrees') { setIdentity(rec, 'agree'); delete rec.identity_note; save(); }
    return { verdict, item: rec, result: {
      status: 'blyg', site: { origin: rec.origin, title: blyg.title, author: blyg.author },
      // the list holds an excerpt, not the post: a passage cannot be checked against it
      html: '', text: rec.text, text_partial: true, from_following: true,
      item: { origin: rec.origin, id: rec.id, kind: rec.kind, version: rec.version, latest: rec.version, pinned: false,
        pinned_versions: [], page: rec.page, pinned_page: '', json: '', source: blyg.title, author: rec.author },
    } };
  }

  // ---- what the page shows ----
  function view({ filter = 'all', mine = [] } = {}) {
    const st = load();
    const { entries, counts } = listFor(Object.values(st.items), filter, mine);
    const titleOf = o => (st.blygs[o] && st.blygs[o].title) || '';
    const decorate = i => {
      const target = i.stub_of && i.stub_of.id ? st.items[keyOf(i.stub_of.origin, i.stub_of.id)] : null;
      return { ...i, blyg_title: titleOf(i.origin),
        versions_note: i.version > 1 ? `${i.version} versions` : '',
        in_response_to: i.stub_of ? { origin: i.stub_of.origin, id: i.stub_of.id,
          label: (target && !target.withdrawn && (target.title || target.excerpt)) || titleOf(i.stub_of.origin) || i.stub_of.origin } : null };
    };
    return { filter: filterOf(filter), counts, run: { ...run }, schedule: { ...schedule }, last_run: st.last_run,
      blygs: listBlygs(), entries: entries.map(e => ({ head: decorate(e.head), members: e.members.map(decorate) })) };
  }
  const itemByKey = key => load().items[key] || null;

  return { follow, unfollow, setBlygState, listBlygs, previewImport, confirmImport, refresh, reschedule, readMove, markAllSeen,
    markResponded, identityFor, view, itemByKey, run, schedule, breakers,
    start: () => reschedule(), stop: () => { if (timer !== null) { timers.clear(timer); timer = null; } if (schedule.mode === 'scheduled') moveSchedule(schedule, 'disarm'); } };
}

// ---- the routes -----------------------------------------------------------------------
// ONE table. server.mjs serves nothing under /following except through it, after
// the same gate every other route passes and with the owner check applied to
// each entry (a reader's list is the owner's, not a guest's), and the auth test
// walks this table.
export const ROUTES = Object.freeze([
  { method: 'GET', path: '/following', what: 'the page' },
  { method: 'GET', path: '/following/data', what: 'the list as JSON' },
  { method: 'GET', path: '/following/open', what: 'open a post (marks it opened, redirects to its page)' },
  { method: 'POST', path: '/following/follow', what: 'follow a blyg by any URL on it' },
  { method: 'POST', path: '/following/unfollow', what: 'stop following' },
  { method: 'POST', path: '/following/state', what: 'pause or resume one' },
  { method: 'POST', path: '/following/import-preview', what: 'what a blogroll or directory would add' },
  { method: 'POST', path: '/following/import-confirm', what: 'add what was confirmed' },
  { method: 'POST', path: '/following/refresh', what: 'refresh now' },
  { method: 'POST', path: '/following/read', what: 'move a post\'s read state' },
  { method: 'POST', path: '/following/settings', what: 'refresh interval, caps, my_origins' },
]);
export const routeOf = (method, path) => ROUTES.find(r => r.method === method && r.path === path) || null;
