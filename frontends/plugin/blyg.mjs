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
