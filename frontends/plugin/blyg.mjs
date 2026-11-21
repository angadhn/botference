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
