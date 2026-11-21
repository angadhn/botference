// netguard.mjs — the one way the companion fetches a page off the web.
//
// Two features fetch what a page or a message names: the Blygger check
// (blyg.mjs) and a link a reader lassos (lasso.mjs). Both go through here, so
// both keep the same rules:
//   · only http and https, never the companion's own port;
//   · never an address on this computer or its private network, or any other
//     special-purpose range (the tables below), judged by ADDRESS: the name is
//     resolved once and EVERY address it answers is checked;
//   · the connection is made to that checked address and nowhere else (the
//     request's own lookup can only answer it), with a fresh agent and no
//     proxy from the environment, so a name that answers differently a moment
//     later (DNS rebinding) changes nothing;
//   · redirects are followed by hand, each hop judged like the first;
//   · a time limit on the whole fetch and a size limit on what is read.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

/** How long a name may take to resolve before the fetch gives up on it. */
export const DNS_MS = 3000;
const DEFAULT_UA = 'Mozilla/5.0 (compatible; botference-discuss/1.0; +https://botference.com)';
/** What a response bigger than the limit gets (readCapped). */
export const TOO_BIG = Object.freeze(['refuse', 'cut']);

// ---- never this machine, never the private network -----------------------
//
// A link in a message is the reader's text, but it may have been pasted from
// anywhere, and the companion fetches it with the reader's own network
// position: a link to 127.0.0.1, the router's admin page or a box on the LAN
// would be read out and handed to the bots. So those are refused, by address,
// before any request — the name is resolved and EVERY address it resolves to
// is checked — and again at each redirect, which is followed by hand for
// exactly that reason. No exceptions, the reader's own local preview included.
// WHICH ADDRESSES ARE NOT THE PUBLIC INTERNET'S, as one table per family.
// Everything special-purpose is refused, not only "private": loopback, the
// private ranges, shared address space (100.64/10: carrier NAT, and Tailscale's
// 100.100.100.100), link-local (169.254/16, the cloud metadata address
// included), benchmarking, documentation, multicast, reserved and broadcast.
// IPv6 forms that CARRY an IPv4 address — mapped (::ffff:a.b.c.d),
// translated (SIIT, ::ffff:0:a.b.c.d),
// v4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) — are
// unwrapped and the IPv4 inside is checked by the same table; Teredo
// (2001::/32) hides its address and is refused whole.
const V4_SPECIAL = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // shared address space (carrier NAT, Tailscale)
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, cloud metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, and 255.255.255.255
];
const V6_SPECIAL = [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['100::', 64],         // discard
  ['2001::', 32],        // Teredo (the address inside is obfuscated)
  ['2001:db8::', 32],    // documentation
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // site-local (deprecated)
  ['ff00::', 8],         // multicast
];
// [prefix, bits, which 32 bits hold the IPv4 address (bit offset from the left)]
const V6_CARRIES_V4 = [
  ['::ffff:0:0', 96, 96],  // IPv4-mapped
  ['::ffff:0:0:0', 96, 96], // IPv4-translated (SIIT, ::ffff:0:a.b.c.d)
  ['64:ff9b::', 96, 96],   // NAT64
  ['2002::', 16, 16],      // 6to4
  ['::', 96, 96],          // IPv4-compatible (deprecated)
];
const v4Big = ip => ip.split('.').reduce((n, o) => (n << 8n) | BigInt(Number(o)), 0n);
function v6Big(ip) {
  let s = ip;
  // a trailing dotted IPv4 is two groups
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4Big(dotted[1]);
    s = s.slice(0, -dotted[1].length) + `${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail === null ? [] : (tail ? tail.split(':') : []);
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}
const inRange = (n, prefix, bits, width) => (bits === 0 ? true : (n >> BigInt(width - bits)) === (prefix >> BigInt(width - bits)));
const v4Special = n => V4_SPECIAL.some(([p, b]) => inRange(n, v4Big(p), b, 32));
/** Any address that is not the public internet's (tables above). Not an address at all: refused. */
export function privateAddress(ip) {
  const a = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(a)) return v4Special(v4Big(a));
  if (!net.isIPv6(a)) return true; // not an address at all: refuse rather than guess
  const n = v6Big(a);
  if (V6_SPECIAL.some(([p, b]) => inRange(n, v6Big(p), b, 128))) return true;
  for (const [p, b, at] of V6_CARRIES_V4) {
    if (inRange(n, v6Big(p), b, 128)) return v4Special((n >> BigInt(128 - at - 32)) & 0xffffffffn);
  }
  return false;
}

// ---- the guard --------------------------------------------------------------

// A failed fetch, named. `kind` says what went wrong in one word, so a check
// can tell "this is not here" (404, not JSON: the answer is no) from "could
// not ask" (refused, timeout, too big, network: the answer is unknown).
export class FetchTrouble extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// The companion's own port is never fetched, whatever address it is on.
export const COMPANION_PORTS = new Set(['4189', ...(Number(process.env.PORT) > 0 ? [String(Number(process.env.PORT))] : [])]);
const bareHost = u => u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/**
 * Why this URL is not fetched, judged before any name is resolved, or ''.
 * A page on this computer or its private network is never checked either:
 * the URL a check starts from is whatever the caller says it is, so no
 * address is ever trusted because of it.
 */
export function urlRefusal(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return 'that is not a web address'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'that is not a web address';
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (COMPANION_PORTS.has(port)) return "that is the companion's own port, which it never fetches";
  const host = bareHost(u);
  const local = 'that address is on this computer or its private network, which the companion never fetches';
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return local;
  if (net.isIP(host)) return privateAddress(host) ? local : '';
  return '';
}

// The default resolver: every address the name has, given DNS_MS.
export async function systemResolve(host) {
  let timer;
  try {
    return await Promise.race([
      dns.promises.lookup(host, { all: true, verbatim: true }),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error('dns timeout')), DNS_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Resolve `host` once and check EVERY address it answers; → the one address
 * the connection will be made to. A name with any special-purpose address
 * among its answers is refused outright (a name that answers one public and
 * one private address is not "probably fine").
 */
export async function vetHost(host, resolve = systemResolve) {
  if (net.isIP(host)) {
    if (privateAddress(host)) throw new FetchTrouble('refused', `${host} is on this computer or its private network`);
    return { address: host, family: net.isIP(host) };
  }
  let addrs;
  try { addrs = await resolve(host); }
  catch (e) {
    throw /timeout/i.test(String(e && e.message)) ? new FetchTrouble('timeout', `${host} did not resolve in time`)
      : new FetchTrouble('network', `could not find ${host}`);
  }
  if (!Array.isArray(addrs) || !addrs.length) throw new FetchTrouble('network', `could not find ${host}`);
  if (addrs.some(a => !a || privateAddress(a.address))) {
    throw new FetchTrouble('refused', `${host} resolves to an address on this computer or a private network`);
  }
  const a = addrs[0];
  return { address: a.address, family: a.family || net.isIP(a.address) };
}

/** '' if `raw` may be fetched (the URL and every address its name resolves to), else why not. */
export async function fetchRefusal(raw, resolve = systemResolve) {
  const why = urlRefusal(raw);
  if (why) return why;
  try { await vetHost(bareHost(new URL(String(raw))), resolve); return ''; }
  catch (e) { return String(e.message); }
}

/**
 * The default transport: GET `url`, follow at most LIMITS.redirects redirects
 * by hand, stop reading at `maxBytes`, give up after `timeoutMs`.
 * → { status, url (final), contentType, text }. Throws a FetchTrouble for
 * refused / timeout / too-big / network.
 *
 * Every hop: the URL is judged (urlRefusal), its name resolved ONCE and every
 * address checked (vetHost), and the request is made with a lookup that can
 * only answer that checked address, so the connection goes nowhere else. A
 * fresh agent per request and no proxy. `resolve`
 * and `transport` ({ http, https }) are injectable for the tests.
 */
export async function guardedGet(url, { maxBytes, timeoutMs, accept = '*/*', ua = DEFAULT_UA, redirects = 5,
  tooBig = 'refuse', resolve = systemResolve, transport = { http, https } } = {}) {
  if (TOO_BIG.indexOf(tooBig) === -1) throw new Error('guardedGet: tooBig must be one of ' + TOO_BIG.join(', '));
  const deadline = Date.now() + timeoutMs;
  const late = () => new FetchTrouble('timeout', `no answer from ${url} in ${Math.round(timeoutMs / 1000)}s`);
  let at = String(url);
  for (let hop = 0; ; hop++) {
    // a hop after the first is named as the redirect it is
    const refuse = why => new FetchTrouble('refused', hop
      ? `it redirects to an address it will not fetch (${why})` : `will not fetch ${at}: ${why}`);
    const why = urlRefusal(at);
    if (why) throw refuse(why);
    const u = new URL(at);
    const host = bareHost(u);
    let vetted;
    try {
      vetted = await Promise.race([vetHost(host, resolve),
        new Promise((_, no) => setTimeout(() => no(late()), Math.max(0, deadline - Date.now())).unref?.())]);
    } catch (e) { throw (e && e.kind === 'refused') ? refuse(e.message) : e; }
    const res = await requestOnce(transport, u, host, vetted, accept, ua, deadline, late);
    const loc = res.statusCode >= 300 && res.statusCode < 400 ? res.headers.location : null;
    if (loc) {
      res.resume();
      if (hop >= redirects) throw new FetchTrouble('network', `too many redirects from ${url}`);
      try { at = new URL(String(loc), at).href; } catch { throw new FetchTrouble('network', `a bad redirect from ${at}`); }
      continue; // judged and vetted at the top of the loop, scheme included
    }
    const body = await readCapped(res, maxBytes, at, deadline, late, tooBig);
    return { status: res.statusCode, url: at, contentType: String(res.headers['content-type'] || ''),
      body, text: body.toString('utf8') };
  }
}

function requestOnce(transport, u, host, vetted, accept, ua, deadline, late) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? transport.https : transport.http;
    const req = mod.request({
      protocol: u.protocol, hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`,
      method: 'GET',
      // a fresh agent per request, and explicitly no proxy from the
      // environment (proxyEnv: {}), so nothing between here and the checked
      // address decides where the connection goes
      agent: new (u.protocol === 'https:' ? https.Agent : http.Agent)({ keepAlive: false, proxyEnv: {} }),
      headers: { 'user-agent': ua, accept, 'accept-encoding': 'identity' },
      // the connection may go to the checked address and nowhere else
      lookup: (_h, opts, cb) => (opts && opts.all
        ? cb(null, [{ address: vetted.address, family: vetted.family }])
        : cb(null, vetted.address, vetted.family)),
      ...(net.isIP(host) ? {} : { servername: host }),
    }, resolve);
    const timer = setTimeout(() => req.destroy(late()), Math.max(0, deadline - Date.now()));
    req.on('close', () => clearTimeout(timer));
    req.on('error', e => reject(e instanceof FetchTrouble ? e : new FetchTrouble('network', `could not reach ${u.href}`)));
    req.end();
  });
}

// Read a body without ever holding more than `maxBytes` of it. What happens to
// a response that is bigger is one of TOO_BIG: 'refuse' abandons it and names
// it too-big (the Blygger check: a document cut short is not that document);
// 'cut' keeps its first `maxBytes` and stops reading (a linked web page: the
// start of a long page is still worth reading).
function readCapped(res, maxBytes, at, deadline, late, mode) {
  return new Promise((resolve, reject) => {
    const said = Number(res.headers['content-length']);
    const tooBig = () => new FetchTrouble('too-big', `${at} is larger than ${maxBytes} bytes`);
    if (said > maxBytes && mode === 'refuse') { reject(tooBig()); res.destroy(); return; }
    const parts = [];
    let size = 0;
    const timer = setTimeout(() => { reject(late()); res.destroy(); }, Math.max(0, deadline - Date.now()));
    res.on('data', c => {
      if (size + c.length > maxBytes) {
        clearTimeout(timer);
        if (mode === 'cut') { parts.push(c.subarray(0, maxBytes - size)); resolve(Buffer.concat(parts)); }
        else reject(tooBig());
        res.destroy();
        return;
      }
      size += c.length;
      parts.push(c);
    });
    res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(parts)); });
    res.on('error', () => { clearTimeout(timer); reject(new FetchTrouble('network', `the answer from ${at} broke off`)); });
    res.on('aborted', () => { clearTimeout(timer); reject(new FetchTrouble('network', `the answer from ${at} broke off`)); });
  });
}
