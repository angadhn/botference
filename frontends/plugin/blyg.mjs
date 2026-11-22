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
// http and https only; never this computer, the private network or any other
// special-purpose address; the name is resolved ONCE, every address it
// resolves to is checked, and the connection is made to exactly the address
// that was checked (so a name that answers a public address to the check and
// a private one to the connection — "DNS rebinding" — gets nowhere); the same
// at every redirect hop; a time limit, a size limit.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { FetchTrouble, urlRefusal, systemResolve, vetHost, fetchRefusal, guardedGet as netGet, DNS_MS } from './netguard.mjs';

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
  // a name that takes longer than this to resolve is not waited for
  dnsMs: DNS_MS,
  // …and the whole check, however many requests it makes, stops asking after
  // this long (an answer by then is 'check-failed', never a guess)
  checkMs: 20000,
  redirects: 5,
  // a manifest is a few hundred bytes; an item document carries a whole post
  // twice (markdown and HTML); a page is read only for its <link> elements
  manifestBytes: 256 * 1024,
  itemBytes: 4 * 1024 * 1024,
  pageBytes: 2 * 1024 * 1024,
});
export const UA = 'Mozilla/5.0 (compatible; botference-discuss/1.0; +https://botference.com)';

// ---- the guard --------------------------------------------------------------

// FetchTrouble, urlRefusal, systemResolve, vetHost, fetchRefusal and the
// guarded transport live in netguard.mjs (shared with lasso's link fetch);
// guardedGet here is that transport with the check's own limits.
export { FetchTrouble, urlRefusal, systemResolve, vetHost, fetchRefusal };
export function guardedGet(url, { maxBytes = LIMITS.itemBytes, timeoutMs = LIMITS.timeoutMs,
  accept = 'application/json', resolve = systemResolve, transport } = {}) {
  return netGet(url, { maxBytes, timeoutMs, accept, resolve, transport, ua: UA, redirects: LIMITS.redirects });
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
  const s = { fetched: [], troubles: [], started: Date.now() };
  s.raw = async (url, { maxBytes = LIMITS.itemBytes, accept = 'application/json' } = {}) => {
    const key = String(url);
    if (seen.has(key)) return seen.get(key);
    const run = (async () => {
      if (s.fetched.length >= LIMITS.fetches) {
        return { status: 'trouble', kind: 'limit', message: `gave up after ${LIMITS.fetches} requests` };
      }
      const left = LIMITS.checkMs - (Date.now() - s.started);
      if (left <= 0) return { status: 'trouble', kind: 'timeout', message: `gave up after ${LIMITS.checkMs / 1000}s` };
      s.fetched.push(key);
      try {
        const r = await get(key, { pageUrl, maxBytes, accept, timeoutMs: Math.min(LIMITS.timeoutMs, left) });
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

// http(s) and nothing else, for every URL that comes out of a remote document
export const isWebUrl = v => { try { return /^https?:$/.test(new URL(String(v)).protocol); } catch { return false; } };

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
  // the address a check starts from is the caller's word, so a page on this
  // computer or its private network is not checked at all (and is not a blyg
  // for Discuss's purposes): nothing about it could be fetched anyway
  if (urlRefusal(u.href)) return { status: 'not-a-blyg', reason: 'a page on this computer or its private network is not checked', fetched: [] };
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
  // A page that is not one post is 'blyg-site' when it is on the blyg's own
  // host (a front page, a collection), and 'not-a-blyg' when it is anywhere
  // else: any page may LINK to a blyg's manifest or to a post's document
  // (§12.1's rel probe exists for exactly that), and a link proves nothing
  // about the page that carries it.
  const onOriginHost = u.host === new URL(origin).host;
  const notItem = reason => done({ status: onOriginHost ? 'blyg-site' : 'not-a-blyg', site, reason });

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
  if (!isWebUrl(docUrl)) return failed(`the blyg's item template does not give a web address (${clip(docUrl, 120)})`);
  const r = await s.json(docUrl);
  if (r.status === 'trouble') return failed(r.message);
  if (malformed(r)) return failed(`${docUrl} is not a JSON document`);
  if (r.status !== 'ok') {
    return fromLink && onOriginHost ? failed(`the page names post ${id}, which its blyg does not serve`) : notItem('this page is not one post');
  }
  const doc = r.json;
  const why = docRefusal(doc, { id, origin });
  if (why) return failed(`post ${id} did not verify: ${why}`);
  if (!KINDS.includes(doc.kind)) return notItem(`post ${id} is of a kind this version does not know`);

  // §5.8: page, relative to the origin or absolute; else the reference
  // client's convention, which is good enough for a reader's own display.
  // Every URL taken from a remote document must be a web address: a page of
  // `javascript:…` would otherwise reach a note's front matter and quotes.
  let page = '';
  try { page = new URL(typeof doc.page === 'string' && doc.page ? doc.page : `${doc.kind === 'fragment' ? 'f' : 't'}/${id}/`, origin).href; }
  catch { page = ''; }
  if (!isWebUrl(page)) return failed(`post ${id} did not verify: its page is not a web address`);
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
      if (!isWebUrl(pinUrl)) return failed(`the blyg's pin template does not give a web address (${clip(pinUrl, 120)})`);
      const p = await s.json(pinUrl);
      if (p.status === 'trouble') return failed(p.message);
      if (p.status !== 'ok') return failed(`pinned version ${n} of post ${id} is not served`);
      const pwhy = docRefusal(p.json, { id, origin, version: n });
      if (pwhy) return failed(`pinned version ${n} of post ${id} did not verify: ${pwhy}`);
      content = p.json; json = pinUrl;
    }
    version = n; pinnedPage = u.href;
  } else if (!samePage(u.href, page)) {
    // THE PAGE MUST BE THE POST'S OWN PAGE. Its document's page field (§5.8)
    // says where the post lives; a page anywhere else that links the document
    // (a copy, a quotation, a page pretending to be the post) is not the post,
    // and its words are not the post's words.
    return notItem(fromLink ? `this page is not post ${id}'s own page (${page})` : 'this page is not one post');
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
// script and style are dropped. Character references are decoded after the
// tags are gone, in ONE pass (so &amp;lt; is the text "&lt;"), as HTML does:
// every numeric reference (decimal and hex, with or without the semicolon;
// 0, surrogates and out-of-range numbers become U+FFFD, and 0x80–0x9F are read
// as windows-1252, as the HTML spec says), and the named references below
// (HTML 4's full set, which is what published HTML uses in practice). The
// reference client decodes only a handful of names; where a post's HTML uses
// any other reference, a highlight this check passes may still fail that
// client's own check, and the note cannot know which reading its site uses.
const BLOCK_END = /<\/(?:p|h[1-6]|li|blockquote|pre|div|tr|section|article)\s*>|<br\s*\/?>/gi;
const SEP = '\u0000'; // a C0 control, which content may not contain (§5.1)
const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 '
  + 'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring '
  + 'AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times '
  + 'Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave '
  + 'eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute '
  + 'ucirc uuml yacute thorn yuml';
const NAMED = Object.assign(Object.create(null),
  Object.fromEntries(LATIN1.split(' ').map((n, i) => [n, String.fromCodePoint(160 + i)])),
  { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', OElig: 'Œ', oelig: 'œ', Scaron: 'Š',
    scaron: 'š', Yuml: 'Ÿ', circ: 'ˆ', tilde: '˜', ensp: ' ', emsp: ' ',
    thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', ndash: '–',
    mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”',
    bdquo: '„', dagger: '†', Dagger: '‡', permil: '‰', lsaquo: '‹', rsaquo: '›',
    euro: '€', fnof: 'ƒ', bull: '•', hellip: '…', prime: '′', Prime: '″',
    oline: '‾', frasl: '⁄', weierp: '℘', image: 'ℑ', real: 'ℜ', trade: '™',
    alefsym: 'ℵ', larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
    crarr: '↵', lArr: '⇐', uArr: '⇑', rArr: '⇒', dArr: '⇓', hArr: '⇔',
    forall: '∀', part: '∂', exist: '∃', empty: '∅', nabla: '∇', isin: '∈',
    notin: '∉', ni: '∋', prod: '∏', sum: '∑', minus: '−', lowast: '∗',
    radic: '√', prop: '∝', infin: '∞', ang: '∠', and: '∧', or: '∨',
    cap: '∩', cup: '∪', int: '∫', there4: '∴', sim: '∼', cong: '≅',
    asymp: '≈', ne: '≠', equiv: '≡', le: '≤', ge: '≥', sub: '⊂', sup: '⊃',
    nsub: '⊄', sube: '⊆', supe: '⊇', oplus: '⊕', otimes: '⊗', perp: '⊥',
    sdot: '⋅', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', lang: '〈',
    rang: '〉', loz: '◊', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦' },
  Object.fromEntries('Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho'
    .split(' ').map((n, i) => [n, String.fromCodePoint(0x391 + i)])),
  Object.fromEntries('Sigma Tau Upsilon Phi Chi Psi Omega'.split(' ').map((n, i) => [n, String.fromCodePoint(0x3a3 + i)])),
  Object.fromEntries('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega'
    .split(' ').map((n, i) => [n, String.fromCodePoint(0x3b1 + i)])),
  { thetasym: 'ϑ', upsih: 'ϒ', piv: 'ϖ' });
// the HTML spec's replacements for numeric references to 0x80–0x9F
const C1 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161,
  0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
function numericRef(n) {
  if (!Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  return String.fromCodePoint(C1[n] || n);
}
export function decodeReferences(text) {
  return String(text).replace(/&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([A-Za-z][A-Za-z0-9]{1,31});)/g,
    (m, dec, hex, name) => {
      if (dec !== undefined) return numericRef(parseInt(dec, 10));
      if (hex !== undefined) return numericRef(parseInt(hex, 16));
      return name in NAMED ? NAMED[name] : m;
    });
}
export function textContent(html) {
  const s = decodeReferences(String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(BLOCK_END, SEP)
    .replace(/<[^>]+>/g, ''));
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
// so not for ever).
//
// A FAILED check backs off per host. A site that could not be asked (offline,
// behind a firewall, too slow) is not asked again until its back-off ends:
// one minute after the first failure, doubling with each further failure up
// to six hours, and forgotten at the first success. Until then every page on
// that host answers 'check-failed' at once, without a request, so a highlight
// or an export never waits on that host again.
export const ANSWER_MS = 10 * 60 * 1000;
export const BACKOFF = Object.freeze({ firstMs: 60 * 1000, maxMs: 6 * 60 * 60 * 1000 });
const keyOf = url => String(url || '').split('#')[0];
const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };
export function createChecker({ get = guardedGet, now = Date.now } = {}) {
  const answers = new Map(); // page key → { at, result }
  const asking = new Map();  // page key → Promise<result>
  const failing = new Map(); // host → { failures, until }: the back-off schedule
  const backedOff = host => { const f = failing.get(host); return f && now() < f.until ? f : null; };
  const fresh = key => {
    const a = answers.get(key);
    if (!a) return null;
    if (a.result.status === 'check-failed') return backedOff(hostOf(key)) ? a.result : null;
    return now() - a.at < ANSWER_MS ? a.result : null;
  };
  const settle = (key, result) => {
    const host = hostOf(key);
    if (result.status === 'check-failed') {
      const failures = ((failing.get(host) || {}).failures || 0) + 1;
      failing.set(host, { failures, until: now() + Math.min(BACKOFF.firstMs * 2 ** (failures - 1), BACKOFF.maxMs) });
    } else failing.delete(host);
    answers.set(key, { at: now(), result });
  };
  return {
    // the answer already held for this page, or null
    peek: url => fresh(keyOf(url)),
    // when this page's host may next be asked (0 = now)
    backoffUntil: url => { const f = backedOff(hostOf(keyOf(url))); return f ? f.until : 0; },
    // the answer, asking the site if nothing fresh is held
    check(url, hints, { kind = '' } = {}) {
      const key = keyOf(url);
      const held = fresh(key);
      if (held) return Promise.resolve(held);
      if (asking.has(key)) return asking.get(key);
      const off = backedOff(hostOf(key));
      if (off) {
        return Promise.resolve({ status: 'check-failed', fetched: [],
          reason: `${hostOf(key)} could not be checked recently; not asking again before ${new Date(off.until).toISOString()}` });
      }
      const run = detect(key, hints, { get, kind })
        .catch(e => ({ status: 'check-failed', reason: String((e && e.message) || 'the check broke'), fetched: [] }))
        .then(result => {
          // the words are what passage checks read; worked out once per answer
          result.source = 'detected';
          if (result.status === 'blyg') result.text = textContent(result.html);
          settle(key, result);
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
// ON THE PAGE RECORD, `page.blyg`: the last VERIFIED answer, without the
// post's words.
//   { status, checked, reason? , site?, item? }
// `checked` is when that answer was last confirmed. Absent on every record
// made before this existed, which reads as 'unknown'.
//
// Its status is one of the BLYG_MODES words, kept in this one field and
// changed only by recordMove, under RECORD_MOVES: a settled answer (blyg,
// blyg-site, not-a-blyg) is replaced only by another settled answer — a
// newer version, or a site that now says something else — and NEVER by a
// check that failed. A failed re-check (offline, timed out) therefore leaves
// a verified post a post: the export keeps quoting it and the bots keep
// being told. 'check-failed' is stored only where nothing better is known.
const SETTLED = Object.freeze(['blyg', 'blyg-site', 'not-a-blyg']);
export const RECORD_MOVES = Object.freeze({
  none: Object.freeze([...SETTLED, 'check-failed']),
  'check-failed': Object.freeze([...SETTLED, 'check-failed']),
  blyg: SETTLED,
  'blyg-site': SETTLED,
  'not-a-blyg': SETTLED,
});
export const recordStatus = page => (page && page.blyg && RECORD_MOVES[page.blyg.status] ? page.blyg.status : 'none');
/** Put `result`'s answer on the page record if RECORD_MOVES allows it. → 'moved' | 'same' | 'refused'. */
export function recordMove(page, result, at = new Date()) {
  const from = recordStatus(page);
  const to = result && result.status;
  if (!RECORD_MOVES[from].includes(to)) return 'refused';
  const rec = pageRecordOf(result, at);
  // the moment of asking is not news: only a different answer is (though a
  // confirmation moves `checked`, the answer's own date)
  const was = page.blyg ? JSON.stringify({ ...page.blyg, checked: rec.checked }) : '';
  page.blyg = rec;
  return was === JSON.stringify(rec) ? 'same' : 'moved';
}
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
// Which version of the post a highlight was made on, relative to the post: the live version, unpinned or pinned
// (§8: a pinned version has a permanent document and page), or an older version that is pinned (a pinned
// version's own page). One list; versionStateOf says which.
export const VERSION_STATES = Object.freeze(['current-unpinned', 'current-pinned', 'older-pinned']);
export const versionStateOf = i => (i.latest !== undefined && i.version !== i.latest ? 'older-pinned' : (i.pinned ? 'current-pinned' : 'current-unpinned'));
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
  // `page` is the post's live page, which is what a reader (or a site's
  // importer) can always open; a highlight made on a pinned version's own
  // page also keeps that page's address
  const st = { status: 'blyg', origin: i.origin, id: i.id, version: i.version, pinned: !!i.pinned,
    version_state: versionStateOf(i), page: i.page, ...(i.pinned_page ? { pinned_page: i.pinned_page } : {}), as_of: asOf === 'check' ? 'check' : 'record' };
  // (an answer built from the Following list, source 'from-list', holds an excerpt, not the post: no verdict is better than a wrong one)
  if (quote !== null && result.source !== 'from-list') st.passage = checkPassage(quote, result.text || textContent(result.html));
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
  const move = recordMove(page, result, at);
  let changed = move === 'moved';
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

// ---- what the bots are told ---------------------------------------------------
// One standing line on a turn about a page that is a Blygger post, so a reply
// can name the post correctly: which post, which version, whose, and how a
// Blygger author refers to it. `stamp` is the record the turn is about (a
// highlight's), when it has one. Everything quoted from the post's site is
// data in quotation marks; a page that is not a post gets nothing.
export function blygContextBlock(page, stamp = null) {
  const b = page && page.blyg;
  if (!b || b.status !== 'blyg' || !b.item || !ID_RE.test(String(b.item.id || ''))) return '';
  const i = b.item;
  const q = v => JSON.stringify(clip(v, 200));
  let out = `This page is a Blygger post (a versioned post on a blyg; spec https://blygger.org/spec/0.4/): `
    + `post id ${i.id}, version ${Number(i.version)}${i.pinned ? ' (pinned)' : ''}, on the blyg at ${clip(i.origin, 300)}`
    + (i.source ? ` titled ${q(i.source)}` : '') + (i.author ? `, by ${q(i.author)}` : '') + '. '
    + `In Blygger markdown it is referred to as [[${i.id}]] inline or ![[${i.id}]] on a line of its own; `
    + 'use that id and no other, and never put a version inside the brackets.';
  if (stamp && stamp.status === 'blyg' && stamp.id === i.id) {
    out += ` The passage under discussion was highlighted in version ${Number(stamp.version)}`
      + (stamp.passage && stamp.passage.match === false ? ' and is not word for word in the post (it ran past the post\'s own text)' : '')
      + '.';
  }
  return out + '\n';
}
