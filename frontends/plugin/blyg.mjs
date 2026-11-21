// blyg.mjs — is the page being read a Blygger post, and which one?
//
// Blygger (https://blygger.org/spec/0.4/) is a small protocol for blogs whose
// posts are versioned JSON documents. A post ("item") has a permanent 26-char
// id, a version that goes up by one per edit, and a home ("identity origin")
// that its manifest, blyg.json, says where everything lives under. Discuss uses
// that to record WHICH post, at WHICH version, a highlight quoted, so an export
// can quote it by reference in Blygger's own syntax.
//
// WHERE THE FETCHES HAPPEN, and why here. The companion (this process) does
// every fetch; the content script only reads two <link> elements out of the
// page it is already on and passes their addresses along as hints. A content
// script's fetch is made on behalf of the page's origin: it is subject to CORS
// (permissive CORS is only a SHOULD in the spec, §4) and, on some browsers, to
// the page's own Content-Security-Policy. The companion is subject to neither,
// it already fetches the web for other features under one guard, and it is
// where the records and the export live. The cost is that a fetch the browser
// could make (a page behind the reader's login) the companion cannot; a blyg is
// public by definition (§4: what an origin serves does not depend on who asks),
// so nothing is lost.
//
// WHAT IS NEVER TRUSTED. Every byte fetched is somebody else's: it is parsed as
// JSON or scanned as text, never executed, never followed as an instruction,
// and every string kept from it is clipped and stripped of control characters
// (the drawer escapes it again when it draws it). The fetches are guarded:
// http and https only, never this computer or the private network (unless the
// page being read is itself local — then only that same host), a time limit, a
// size limit, redirects followed by hand and each hop checked like the first.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { webAddressRefusal, privateAddress } from './lasso.mjs';

// The one list of what a page's blyg status can be. It lives in config.js
// because the drawer (a browser script) keeps the same field; see the comment
// there for what each word means.
const { BLYG_MODES } = createRequire(import.meta.url)('./extension/config.js');
export { BLYG_MODES };

export const LIMITS = Object.freeze({
  // one check of one page makes at most this many requests (§12.1 caps a
  // resolution at six; the item document and a pinned version add two)
  fetches: 8,
  timeoutMs: 8000,
  redirects: 5,
  // a manifest is a few hundred bytes; an item document carries a whole post
  // twice (markdown and HTML); a page is read only for its <link> elements
  manifestBytes: 256 * 1024,
  itemBytes: 4 * 1024 * 1024,
  pageBytes: 2 * 1024 * 1024,
});
export const UA = 'Mozilla/5.0 (compatible; botference-discuss/1.0; +https://botference.com)';

// ---- the guard --------------------------------------------------------------

const isLocalHost = host => {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  return /^[\d.]+$/.test(h) || h.includes(':') ? privateAddress(h) : false;
};

/**
 * Why this address will not be fetched for a page at `pageUrl`, or '' if it
 * will. Public pages get exactly the companion's existing web guard
 * (lasso.webAddressRefusal: http/https, every resolved address public). A page
 * that is itself on this computer or the private network — someone previewing
 * their own blyg — may have its OWN host fetched, and nothing else private.
 */
export async function fetchRefusal(target, pageUrl) {
  let t;
  try { t = new URL(String(target)); } catch { return 'that is not a web address'; }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') return 'that is not a web address';
  let p = null;
  try { p = new URL(String(pageUrl)); } catch { p = null; }
  if (p && (p.protocol === 'http:' || p.protocol === 'https:') && isLocalHost(p.hostname)
      && t.host === p.host && t.protocol === p.protocol) return '';
  return webAddressRefusal(t.href);
}

// A failed fetch, named. `kind` says what went wrong in one word, so a check
// can tell "this is not here" (404, not JSON: the answer is no) from "could
// not ask" (refused, timeout, too big, network: the answer is unknown).
export class FetchTrouble extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/**
 * The default transport: GET `url`, follow at most LIMITS.redirects redirects
 * by hand (each hop guarded), stop reading at `maxBytes`, give up after
 * `timeoutMs`. → { status, url (final), contentType, text }. Throws a
 * FetchTrouble for refused / timeout / too-big / network.
 */
export async function guardedGet(url, { pageUrl = '', maxBytes = LIMITS.itemBytes,
  timeoutMs = LIMITS.timeoutMs, accept = 'application/json' } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let at = String(url);
  for (let hop = 0; ; hop++) {
    const why = await fetchRefusal(at, pageUrl);
    if (why) throw new FetchTrouble('refused', `will not fetch ${at}: ${why}`);
    let res;
    try {
      res = await fetch(at, { redirect: 'manual', signal,
        headers: { 'user-agent': UA, accept } });
    } catch (e) {
      const name = String((e && (e.name || e.message)) || '');
      throw /abort|timeout/i.test(name)
        ? new FetchTrouble('timeout', `no answer from ${at} in ${Math.round(timeoutMs / 1000)}s`)
        : new FetchTrouble('network', `could not reach ${at}`);
    }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) {
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      if (hop >= LIMITS.redirects) throw new FetchTrouble('network', `too many redirects from ${url}`);
      let next;
      try { next = new URL(loc, at).href; } catch { throw new FetchTrouble('network', `a bad redirect from ${at}`); }
      at = next; // guarded at the top of the loop, scheme included
      continue;
    }
    const text = await readCapped(res, maxBytes, signal, at, timeoutMs);
    return { status: res.status, url: at, contentType: res.headers.get('content-type') || '', text };
  }
}

// Read a body without ever holding more than `maxBytes` of it: a response that
// says it is bigger, or turns out to be, is abandoned and named too-big.
async function readCapped(res, maxBytes, signal, at, timeoutMs) {
  const said = Number(res.headers.get('content-length'));
  if (said > maxBytes) {
    try { await res.body?.cancel(); } catch { /* fine */ }
    throw new FetchTrouble('too-big', `${at} is larger than ${maxBytes} bytes`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* fine */ }
        throw new FetchTrouble('too-big', `${at} is larger than ${maxBytes} bytes`);
      }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof FetchTrouble) throw e;
    if (signal.aborted) throw new FetchTrouble('timeout', `no answer from ${at} in ${Math.round(timeoutMs / 1000)}s`);
    throw new FetchTrouble('network', `the answer from ${at} broke off`);
  }
  return Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf8');
}

// ---- one check's fetches --------------------------------------------------------
// Every request one check makes goes through a session: it fetches each URL at
// most once (a probe already made answers again from memory), stops at
// LIMITS.fetches, and turns every answer into one of three words:
//   ok      — a 2xx whose body parsed as a JSON object
//   absent  — the site answered, and there is nothing usable there (404, a 2xx
//             that is not a JSON object): evidence for "no"
//   trouble — the question could not be asked (refused, timeout, too big,
//             network, the fetch budget spent): evidence for nothing
// `get` is the transport (guardedGet, or a test's stand-in with its shape).
export function parseJsonObject(text) {
  try {
    const v = JSON.parse(String(text));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

export function session(pageUrl, get = guardedGet) {
  const seen = new Map();
  const s = { fetched: [], troubles: [] };
  s.raw = async (url, { maxBytes = LIMITS.itemBytes, accept = 'application/json' } = {}) => {
    const key = String(url);
    if (seen.has(key)) return seen.get(key);
    const run = (async () => {
      if (s.fetched.length >= LIMITS.fetches) {
        return { status: 'trouble', kind: 'limit', message: `gave up after ${LIMITS.fetches} requests` };
      }
      s.fetched.push(key);
      try {
        const r = await get(key, { pageUrl, maxBytes, accept });
        return { status: 'answered', code: Number(r.status) || 0, url: String(r.url || key), text: String(r.text ?? '') };
      } catch (e) {
        return { status: 'trouble', kind: (e && e.kind) || 'network', message: String((e && e.message) || 'could not fetch') };
      }
    })();
    seen.set(key, run);
    return run;
  };
  s.json = async (url, opts) => {
    const r = await s.raw(url, opts);
    if (r.status === 'trouble') { s.troubles.push(r); return r; }
    if (r.code < 200 || r.code >= 300) return { status: 'absent', code: r.code, url: r.url };
    const json = parseJsonObject(r.text);
    return json ? { status: 'ok', json, url: r.url } : { status: 'absent', code: r.code, url: r.url };
  };
  return s;
}

// ---- finding the manifest (§12.1) ----------------------------------------------
// The spec's resolution order, minus the two steps that are about feeds and
// subscriptions (step 3, the feed upgrade; step 6, the RSS fallback) and plus
// nothing: the direct probe at the page's own path, the page's
// <link rel="blyg">, then the two conventional mounts at the host root.

// §12.1 step 1: strip query and fragment, end the path with '/'
export function candidateBase(url) {
  const u = new URL(String(url));
  u.search = ''; u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}
// §12.2: the identity origin is where the manifest actually came from, minus
// its last path segment, after redirects; a WHATWG serialization is the one
// spelling the spec asks for
export function identityOf(manifestUrl) {
  const u = new URL(String(manifestUrl));
  u.search = ''; u.hash = '';
  u.pathname = u.pathname.replace(/[^/]*$/, '');
  return u.href;
}
// §12.1 step 2: "a JSON object with a blyg version key"; parse-success is the
// test, Content-Type is not
export const isManifest = j => !!j && typeof j.blyg === 'string' && j.blyg.length > 0 && j.blyg.length < 20;

// The two <link> elements discovery reads, out of a page's HTML, resolved
// against the page. Used only when the extension did not send them (an export
// from the pages list of a page recorded before this existed). A regex is
// enough: these are attributes of void elements in the <head>, and anything
// odd simply yields nothing.
export function pageLinks(html, baseUrl) {
  const out = { blyg: '', json: '' };
  const head = String(html || '').slice(0, LIMITS.pageBytes);
  for (const m of head.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    const rel = String(attrs.rel || '').toLowerCase().split(/\s+/);
    let href = '';
    try { href = attrs.href ? new URL(attrs.href.replace(/&amp;/g, '&'), baseUrl).href : ''; } catch { href = ''; }
    if (!/^https?:/i.test(href)) continue;
    if (rel.includes('blyg') && !out.blyg) out.blyg = href;
    if (rel.includes('alternate') && String(attrs.type || '').toLowerCase() === 'application/json' && !out.json) out.json = href;
  }
  return out;
}

// Hints as the extension sends them: two absolute http(s) URLs or ''. Anything
// else is dropped rather than believed.
export function cleanHints(h) {
  if (!h || typeof h !== 'object') return null;
  const one = v => {
    const s = String(v || '').trim().slice(0, 2000);
    try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
  };
  return { blyg: one(h.blyg), json: one(h.json) };
}

/**
 * → { status: 'found', manifest, origin, url } | { status: 'none' } | { status: 'trouble' }
 * `none` means every probe was answered and none was a manifest; `trouble`
 * that at least one could not be asked, so "no" cannot honestly be said.
 */
export async function findManifest(s, pageUrl, hints) {
  const tried = new Set();
  const probe = async url => {
    if (!url || tried.has(url)) return null;
    tried.add(url);
    const r = await s.json(url, { maxBytes: LIMITS.manifestBytes });
    return r.status === 'ok' && isManifest(r.json)
      ? { status: 'found', manifest: r.json, url: r.url, origin: identityOf(r.url) } : null;
  };
  const found = await probe(new URL('blyg.json', candidateBase(pageUrl)).href);
  if (found) return found;
  if (hints && hints.blyg) {
    // the rel names the manifest itself, or (as at 0.3) an origin base URL
    const named = await probe(hints.blyg);
    if (named) return named;
    const asBase = await probe(new URL('blyg.json', candidateBase(hints.blyg)).href);
    if (asBase) return asBase;
  }
  const root = new URL('/', pageUrl).href;
  for (const p of ['blyg/blyg.json', 'blyg.json']) {
    const hit = await probe(new URL(p, root).href);
    if (hit) return hit;
  }
  return { status: s.troubles.length ? 'trouble' : 'none' };
}

// ---- which post, verified (§5, §5.8, §6.1, §8) ------------------------------------

// §5.1: 128 random bits as 26 characters of lowercase Crockford base32
export const ID_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const KINDS = ['fragment', 'thread', 'withdrawn'];
// a string out of somebody else's JSON, made safe to keep: control characters
// gone, length bounded. (The drawer escapes it again when it draws it.)
export const clip = (v, n = 300) => (typeof v === 'string' ? v : '')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const sha256 = s => 'sha256:' + crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// §6.1: the manifest's item and pin templates (RFC 6570 level 1), or their
// defaults, expanded and resolved against the identity origin
export function expandTemplate(template, vars, origin) {
  const filled = String(template).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(vars[k] ?? '')));
  return new URL(filled, origin).href;
}
const itemTemplate = m => (typeof m.item === 'string' && m.item ? m.item : 'items/{id}.json');
const pinTemplate = m => (typeof m.pin === 'string' && m.pin ? m.pin : 'items/{id}/v{n}.json');
export const itemUrlOf = (manifest, origin, id) => expandTemplate(itemTemplate(manifest), { id }, origin);
export const pinUrlOf = (manifest, origin, id, n) => expandTemplate(pinTemplate(manifest), { id, n }, origin);

// Two page addresses are the same page when they differ only in query,
// fragment or a trailing slash.
export function samePage(a, b) {
  try {
    const x = new URL(String(a)); const y = new URL(String(b));
    const p = u => u.pathname.replace(/\/+$/, '');
    return x.protocol === y.protocol && x.host === y.host && p(x) === p(y);
  } catch { return false; }
}

// Why this document is not the item it claims to be, or ''. The id and origin
// are compared byte for byte (§5.9, §12.2); content_hash is checked because the
// spec defines it exactly (§5.1: sha256 over content_md's UTF-8 bytes).
export function docRefusal(j, { id, origin, version = 0 }) {
  if (!j || typeof j.blyg !== 'string') return 'it is not an item document';
  if (j.id !== id) return `it names a different id (${clip(j.id, 40) || 'none'})`;
  if (j.origin !== origin) return `its origin (${clip(j.origin, 200) || 'none'}) is not where its manifest is (${origin})`;
  if (!Number.isInteger(j.version) || j.version < 1) return 'it has no version number';
  if (version && j.version !== version) return `it is version ${j.version}, not ${version}`;
  if (typeof j.content_md !== 'string' || typeof j.content_html !== 'string') return 'it has no content';
  if (typeof j.content_hash !== 'string' || sha256(j.content_md) !== j.content_hash) return 'its content_hash does not match its content';
  return '';
}

/**
 * Is `pageUrl` a Blygger post? → one of
 *   { status: 'blyg', site, item, html }   html: the content_html of the version read
 *   { status: 'blyg-site', site, reason }
 *   { status: 'not-a-blyg', reason }
 *   { status: 'check-failed', reason }
 * plus `fetched`, every URL requested. `hints` are the page's own two links
 * (cleanHints), or null to read them from the page itself (one more request).
 * `kind` is the page record's kind: a PDF is never a blyg.
 */
export async function detect(pageUrl, hints, { get = guardedGet, kind = '' } = {}) {
  let u;
  try { u = new URL(String(pageUrl)); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) return { status: 'not-a-blyg', reason: 'not a web page', fetched: [] };
  if (kind === 'pdf' || /\.pdf$/i.test(u.pathname)) return { status: 'not-a-blyg', reason: 'a PDF', fetched: [] };
  const s = session(u.href, get);
  const done = r => ({ ...r, fetched: s.fetched.slice() });
  const failed = reason => done({ status: 'check-failed', reason });

  let h = cleanHints(hints);
  if (!h) {
    const r = await s.raw(u.href, { maxBytes: LIMITS.pageBytes, accept: 'text/html' });
    h = r.status === 'answered' && r.code >= 200 && r.code < 300 ? pageLinks(r.text, r.url) : { blyg: '', json: '' };
  }
  const m = await findManifest(s, u.href, h);
  if (m.status === 'none') return done({ status: 'not-a-blyg', reason: 'no Blygger manifest was found' });
  if (m.status === 'trouble') return failed(s.troubles[0] ? s.troubles[0].message : 'the site could not be asked');
  const origin = m.origin;
  const site = { origin, title: clip(m.manifest.title, 200), author: clip(m.manifest.author && m.manifest.author.name, 200) };
  const notItem = reason => done({ status: 'blyg-site', site, reason });

  // WHICH ITEM. The page's own <link rel="alternate" type="application/json">
  // first (§5.8: "the way back from a page to the document"); else an id in
  // the page's own path, which is how the reference client spells permalinks
  // (t/{id}/, f/{id}/, and t/{id}/v{n}/ for a pinned version) — a guess, so
  // it is believed only when the document's own page field agrees.
  // A 2xx that is not a JSON object is a broken document, not an absent one.
  const malformed = r => r.status === 'absent' && r.code >= 200 && r.code < 300;
  let id = '';
  let fromLink = false;
  if (h.json) {
    const r = await s.json(h.json);
    if (r.status === 'trouble') return failed(r.message);
    if (malformed(r)) return failed(`${h.json} is not a JSON document`);
    if (r.status === 'ok' && ID_RE.test(String(r.json.id || ''))) {
      id = r.json.id; fromLink = true;
      // a link whose own address names one post and whose document names
      // another is contradicting itself; neither half is believed
      const named = new URL(h.json).pathname.split(/[/.]/).filter(seg => ID_RE.test(seg));
      if (named.length && !named.includes(id)) return failed(`${h.json} holds a document for a different post (${id})`);
    }
  }
  if (!id) id = u.pathname.split('/').filter(seg => ID_RE.test(seg)).pop() || '';
  if (!id) return notItem('this page is not one post');

  // …and the document is read from where the ORIGIN keeps it (its manifest's
  // item template), never only from where the page pointed: a page may name
  // any JSON it likes, and only the origin speaks for the origin (§12.2).
  const docUrl = itemUrlOf(m.manifest, origin, id);
  const r = await s.json(docUrl);
  if (r.status === 'trouble') return failed(r.message);
  if (malformed(r)) return failed(`${docUrl} is not a JSON document`);
  if (r.status !== 'ok') {
    return fromLink ? failed(`the page names post ${id}, which its blyg does not serve`) : notItem('this page is not one post');
  }
  const doc = r.json;
  const why = docRefusal(doc, { id, origin });
  if (why) return failed(`post ${id} did not verify: ${why}`);
  if (!KINDS.includes(doc.kind)) return notItem(`post ${id} is of a kind this version does not know`);

  // §5.8: page, relative to the origin or absolute; else the reference
  // client's convention, which is good enough for a reader's own display
  let page = '';
  try { page = new URL(typeof doc.page === 'string' && doc.page ? doc.page : `${doc.kind === 'fragment' ? 'f' : 't'}/${id}/`, origin).href; }
  catch { page = ''; }
  const pinned = (Array.isArray(doc.changelog) ? doc.changelog : [])
    .filter(e => e && e.pinned === true && Number.isInteger(e.version) && e.version > 0 && e.version <= doc.version)
    .map(e => e.version);

  // A pinned version's own page (§8.4: {page}v{n}/) shows THAT version's
  // words, so that is the version a highlight on it quotes.
  let content = doc;
  let version = doc.version;
  let pinnedPage = '';
  let json = docUrl;
  const vm = page ? /^v(\d{1,6})$/.exec(u.pathname.replace(/\/+$/, '').split('/').pop() || '') : null;
  const onVersionPage = vm && samePage(new URL('..', candidateBase(u.href)).href, page);
  if (onVersionPage) {
    const n = Number(vm[1]);
    if (!pinned.includes(n)) return notItem(`version ${n} of post ${id} is not pinned`);
    if (n !== doc.version) {
      const pinUrl = pinUrlOf(m.manifest, origin, id, n);
      const p = await s.json(pinUrl);
      if (p.status === 'trouble') return failed(p.message);
      if (p.status !== 'ok') return failed(`pinned version ${n} of post ${id} is not served`);
      const pwhy = docRefusal(p.json, { id, origin, version: n });
      if (pwhy) return failed(`pinned version ${n} of post ${id} did not verify: ${pwhy}`);
      content = p.json; json = pinUrl;
    }
    version = n; pinnedPage = u.href;
  } else if (!fromLink && !samePage(u.href, page)) {
    return notItem('this page is not one post');
  }

  const author = clip(doc.author && typeof doc.author === 'object' ? doc.author.name : '', 200) || site.author;
  return done({
    status: 'blyg', site, html: String(content.content_html || ''),
    item: { origin, id, kind: doc.kind, version, latest: doc.version, pinned: pinned.includes(version),
      pinned_versions: pinned, page, pinned_page: pinnedPage, json, source: site.title, author },
  });
}

// ---- does a highlighted passage pass the publisher's check? (§10.2) ------------
// A Blygger partial quote is checked when the quoting post is published: the
// selection MUST be a substring of the target's "text content" — its
// content_html with tags stripped, whitespace collapsed within a block, block
// boundaries kept as line breaks (§2, §10.2). The spec leaves which elements
// are blocks to the implementation, so this follows the reference client
// (blygger-studio's selectionText): the closing tags of p, h1–h6, li,
// blockquote, pre, div, tr, section and article, and <br>, end a block;
// script and style are dropped; a short list of entities is decoded after the
// tags are gone, &amp; last. Anything a publisher might do differently is a
// reason this check can only ever say "will pass the reference client".
const BLOCK_END = /<\/(?:p|h[1-6]|li|blockquote|pre|div|tr|section|article)\s*>|<br\s*\/?>/gi;
const SEP = '\u0000'; // a C0 control, which content may not contain (§5.1)
const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export function textContent(html) {
  const s = String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(BLOCK_END, SEP)
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&([a-z]+);/g, (m, n) => (Object.hasOwn(ENTITIES, n) ? ENTITIES[n] : m))
    .replace(/&amp;/g, '&');
  return s.split(SEP).map(b => b.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// A highlight as the publisher will read it once exported: each line of the
// selection its own paragraph (the export separates them with an empty '>'
// line), whitespace collapsed, empty lines gone.
export const passageOf = quote => String(quote || '').split(/\r?\n/)
  .map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

const NEAREST_WORDS_MAX = 200;
const NEAREST_MIN_CHARS = 20;
/**
 * → { match: true } or { match: false, nearest } where `nearest` is the
 * longest run of the passage's own words, in order, that IS in the text (''
 * when nothing of at least a few words is). That is the usual repair: a
 * selection that ran into a caption, a footnote marker or a button keeps its
 * real words and loses the rest. Bounded: at most NEAREST_WORDS_MAX words are
 * tried, so a long selection costs a few thousand substring tests at most.
 */
export function checkPassage(quote, text) {
  const passage = passageOf(quote);
  const hay = String(text || '');
  if (passage && hay.includes(passage)) return { match: true };
  // tokens keep the separator that followed them, so a run that crosses a
  // paragraph break is tried with the line break the text has there
  const toks = [...passage.matchAll(/(\S+)(\s*)/g)].slice(0, NEAREST_WORDS_MAX).map(m => [m[1], m[2]]);
  const join = (i, j) => toks.slice(i, j).map((t, k) => t[0] + (k < j - i - 1 ? t[1] : '')).join('');
  let best = '';
  for (let i = 0; i < toks.length; i++) {
    if (join(i, toks.length).length <= best.length) break;
    let j = i;
    while (j < toks.length && hay.includes(join(i, j + 1))) j++;
    const run = join(i, j);
    if (run.length > best.length) best = run;
  }
  return { match: false, nearest: best.length >= NEAREST_MIN_CHARS ? best : '' };
}

// ---- once per page ------------------------------------------------------------------
// The companion asks about a page once and remembers the answer: the drawer
// opening, the first highlight, the page chat and the export all ask the
// same checker, and a second asker while the first is still waiting shares the
// first one's request. An answer is kept for ANSWER_MS (a post can be edited,
// so not for ever); a 'check-failed' only for FAILED_MS, so reopening the
// drawer after the network comes back asks again.
export const ANSWER_MS = 10 * 60 * 1000;
export const FAILED_MS = 60 * 1000;
const keyOf = url => String(url || '').split('#')[0];
export function createChecker({ get = guardedGet, now = Date.now } = {}) {
  const answers = new Map(); // key → { at, result }
  const asking = new Map();  // key → Promise<result>
  const fresh = key => {
    const a = answers.get(key);
    if (!a) return null;
    const life = a.result.status === 'check-failed' ? FAILED_MS : ANSWER_MS;
    return now() - a.at < life ? a.result : null;
  };
  return {
    // the answer already held for this page, or null
    peek: url => fresh(keyOf(url)),
    // the answer, asking the site if nothing fresh is held
    check(url, hints, { kind = '' } = {}) {
      const key = keyOf(url);
      const held = fresh(key);
      if (held) return Promise.resolve(held);
      if (asking.has(key)) return asking.get(key);
      const run = detect(key, hints, { get, kind })
        .catch(e => ({ status: 'check-failed', reason: String((e && e.message) || 'the check broke'), fetched: [] }))
        .then(result => {
          // the words are what passage checks read; worked out once per answer
          if (result.status === 'blyg') result.text = textContent(result.html);
          answers.set(key, { at: now(), result });
          asking.delete(key);
          return result;
        });
      asking.set(key, run);
      return run;
    },
    forget: url => { answers.delete(keyOf(url)); },
  };
}

// Wait for `promise` at most `ms`; null if it has not settled by then. (The
// promise itself carries on, and whoever is listening to it gets the answer.)
export function settleWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---- what is stored -------------------------------------------------------------------
// ON THE PAGE RECORD, `page.blyg`: the last answer, without the post's words.
//   { status, checked, reason? , site?, item? }
// Absent on every record made before this existed, which reads as 'unknown'.
export function pageRecordOf(result, at = new Date()) {
  const out = { status: result.status, checked: at.toISOString() };
  if (result.reason) out.reason = clip(result.reason, 300);
  if (result.site) out.site = { ...result.site };
  if (result.item) out.item = { ...result.item };
  return out;
}

// ON EACH HIGHLIGHT, COMMENT, STRIKE AND PAGE-CHAT MESSAGE, `.blyg`: a stamp.
// Its status is one of BLYG_STAMPS, or the stamp is absent:
//   absent         — not a blyg post when it was made, or made before Discuss
//                    knew about Blygger (the page record tells the two apart)
//   'checking'     — made while the first check of the page was still running
//   'check-failed' — made while the page could not be checked
//   'blyg'         — made on this post at this version: { origin, id, version,
//                    pinned, page } and `as_of`, which says how honest the
//                    version is: 'record' (it was current when this was made)
//                    or 'check' (it was current when Discuss first checked the
//                    page, which was after this was made). A highlight's stamp
//                    also carries `passage`, the §10.2 verdict on its words.
// A stamp moves only through restamp(), and only by STAMP_MOVES: a 'checking'
// or 'check-failed' stamp is filled in once the answer arrives; a 'blyg'
// stamp is final, so an old highlight goes on saying which version it quoted
// after the post changes.
export const BLYG_STAMPS = Object.freeze(['checking', 'blyg', 'check-failed']);
for (const s of BLYG_STAMPS) if (!BLYG_MODES.includes(s)) throw new Error(`blyg stamp ${s} is not a blyg mode`);
const STAMP_MOVES = Object.freeze({
  none: Object.freeze(['checking', 'blyg', 'check-failed']),
  checking: Object.freeze(['blyg', 'check-failed', 'none']),
  'check-failed': Object.freeze(['blyg', 'none']),
  blyg: Object.freeze([]),
});
export const stampStatus = rec => (rec && rec.blyg && BLYG_STAMPS.includes(rec.blyg.status) ? rec.blyg.status : 'none');

/** The stamp an answer gives a record (null = no stamp). */
export function stampFor(result, { asOf = 'record', quote = null } = {}) {
  if (!result) return { status: 'checking' };
  if (result.status === 'check-failed') return { status: 'check-failed' };
  if (result.status !== 'blyg' || !result.item) return null;
  const i = result.item;
  const st = { status: 'blyg', origin: i.origin, id: i.id, version: i.version, pinned: !!i.pinned,
    page: i.pinned_page || i.page, as_of: asOf === 'check' ? 'check' : 'record' };
  if (quote !== null) st.passage = checkPassage(quote, result.text || textContent(result.html));
  return st;
}

/** Move `rec`'s stamp to `next` (null = none). false, and nothing changed, for a move STAMP_MOVES does not allow. */
export function restamp(rec, next) {
  const from = stampStatus(rec);
  const to = next ? next.status : 'none';
  if (!STAMP_MOVES[from] || !STAMP_MOVES[from].includes(to)) return false;
  if (next) rec.blyg = next; else delete rec.blyg;
  return true;
}

/**
 * An answer has arrived for `page`: record it, and fill in ONLY the stamps it
 * is the answer to — once. Records stamped 'checking' were made while this very
 * answer was on its way, so their version is as of the record; 'check-failed'
 * ones, and (on the page's first ever answer) records made before Discuss
 * knew about Blygger, get the version as of this check and say so.
 * → true when anything on the page changed.
 */
export function applyAnswer(page, result, at = new Date()) {
  if (!page || !result) return false;
  const first = !page.blyg;
  const before = JSON.stringify(page.blyg || null);
  const rec = pageRecordOf(result, at);
  // the moment of asking is not news: only a different answer is
  const same = before !== 'null' && JSON.stringify({ ...JSON.parse(before), checked: rec.checked }) === JSON.stringify(rec);
  let changed = false;
  if (!same) { page.blyg = rec; changed = true; }
  const fill = (r, quote) => {
    const from = stampStatus(r);
    if (from === 'blyg') return;
    if (from === 'none' && !first) return;
    const asOf = from === 'checking' ? 'record' : 'check';
    if (restamp(r, stampFor(result, { asOf, quote }))) changed = true;
  };
  for (const t of page.threads || []) fill(t, String(t.quote || ''));
  // page chat: only stamps that were waiting; an old conversation is the
  // page's, and the page record already says what the page is
  for (const m of page.page_chat || []) if (stampStatus(m) !== 'none') fill(m, null);
  return changed;
}
