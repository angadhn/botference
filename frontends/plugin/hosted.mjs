// Hosted mode for the web-annotator companion: several humans, one workspace.
//
// The local companion is single-user by construction — whoever can reach
// 127.0.0.1:4189 owns the filesystem it writes to. `--hosted` puts the same
// server behind a shared URL (a cloudflared tunnel, usually) so collaborators
// can read the annotations, reply in threads, and — if the owner grants it —
// summon the bots. Everything here is about telling those two populations
// apart: the OWNER (this machine, or the owner password) and GUESTS.
//
// Two credentials, deliberately different in kind:
//   · browsers get a password gate and an HMAC cookie (7-day, stateless);
//   · the remote extension sends `Authorization: Bearer <PLUGIN_PASSWORD>`
//     with an `x-plugin-handle` header, and never a cookie — which is what
//     makes `Access-Control-Allow-Origin: *` safe here. A wildcard origin
//     cannot carry credentials, so a hostile page cannot ride a guest's
//     cookie; it would have to already know the password.
// WS/SSE cannot set headers from a browser, so they take `?auth=&handle=`.
//
// A simplified port of frontends/review/server.mjs's hosted machinery: same
// gate, same grants ledger, no per-user state mirroring and no owner token
// file (the role rides inside the signed cookie instead).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deviceSession, ownerPassword as sharedOwnerPassword } from './identity.mjs';
// the tunnel test itself now lives in ../shared/local.mjs: the council web
// server needs the identical boundary before it will accept a key, and a
// second copy of a security test is a second thing to get wrong. Re-exported
// so every call site here (and in server.mjs) reads exactly as it did.
import { isLocalDirect, PROXY_HEADERS } from '../shared/local.mjs';
// how a hosted companion knows who is asking: HOSTED_AUTH (password | access | either), access.mjs
import { verdictOfRequest } from './access.mjs';
// the atomic write and the constant-time compare, one copy each for the tree
import { writeJson, safeEqual, readJsonState, warnUnreadable, UnreadableJsonError } from './fsjson.mjs';
export { isLocalDirect, PROXY_HEADERS };

export const AUTH_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days, renewed as you go
export const DEFAULT_CAP = 5;                    // guest mentions per day
const JSON_HEAD = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const HTML_HEAD = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

// The remote extension is an installed browser extension talking to a public
// hostname: its requests are cross-origin, so preflights have to be answered.
// Wildcard origin + bearer auth (never cookies) is the whole safety argument.
export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-plugin-handle',
  'access-control-max-age': '600',
};

// --- WHO IS ASKING, by the Origin header -------------------------------
// Being on the loopback says the request came from this machine; it does not
// say which PAGE sent it. Any website open in the owner's browser can fire a
// request at 127.0.0.1:4189, and before this check the companion treated it as
// the owner. Browsers stamp every cross-origin request (and every POST) with
// an Origin they will not let a page forge, so it is the test:
//
//   'absent'  — no Origin at all: curl, the Python side, the review mirror and
//               council server (node fetch sends none), a page's own top-level
//               navigation. Trusted, as it always was.
//   'trusted' — a browser extension (chrome-extension://…, optionally pinned
//               to PLUGIN_EXTENSION_IDS), the companion's own pages (Origin
//               host = the Host it was asked on, or 127.0.0.1/localhost/[::1]
//               on the port it is listening on), or a configured public
//               hostname (the reading room, the memorizer, PLUGIN_PUBLIC_HOSTNAMES).
//   'foreign' — anything else, including the literal "null". On the loopback
//               that is refused outright (server.mjs); over the tunnel the
//               request still has to pass the password like any other, and
//               it never gets a CORS header, so the page cannot read the answer.
//
// These three are the only answers; nothing else decides it.
export const ORIGIN_VERDICTS = Object.freeze(['absent', 'trusted', 'foreign']);
const csv = v => String(v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
export function originVerdict(req, { publicHosts = [], extensionIds = null, strict = false } = {}) {
  const raw = req.headers.origin;
  if (raw === undefined || raw === '') return 'absent';
  const o = String(raw).trim().toLowerCase();
  if (o.startsWith('chrome-extension://')) {
    // the companion usually does not know the extension's id (an unpacked
    // install gets a fresh one), so any extension passes unless the owner
    // pins the list — extensions are software the owner installed, not pages
    // (with Access in front the ids are configured, never 'any': extensionIds comes from the access settings)
    const pinned = extensionIds ? extensionIds.map(x => String(x).toLowerCase()) : csv(process.env.PLUGIN_EXTENSION_IDS);
    if (!pinned.length) return 'trusted';
    return pinned.includes(o.slice('chrome-extension://'.length).replace(/\/+$/, '')) ? 'trusted' : 'foreign';
  }
  let u;
  try { u = new URL(o); } catch { return 'foreign'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'foreign';
  // the companion's own page, on whatever name it was asked by
  const host = String(req.headers.host || '').toLowerCase();
  // strict (a request that came through the tunnel, with Access in front): ONLY a configured public name, over https, is "our own page".
  // Not the name the request happened to ask for (a tunnel may rewrite Host to localhost), and not a page on this machine's loopback.
  if (strict) {
    const names = new Set([...publicHosts.map(h => String(h).toLowerCase()), ...csv(process.env.PLUGIN_PUBLIC_HOSTNAMES)]);
    return u.protocol === 'https:' && names.has(u.hostname) ? 'trusted' : 'foreign';
  }
  if (host && u.host === host) return 'trusted';
  const lp = req.socket && req.socket.localPort;
  if (lp && u.protocol === 'http:' && String(u.port || '80') === String(lp)
    && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) return 'trusted';
  const pub = new Set([...publicHosts.map(h => String(h).toLowerCase()), ...csv(process.env.PLUGIN_PUBLIC_HOSTNAMES)]);
  if (u.protocol === 'https:' && pub.has(u.hostname)) return 'trusted';
  return 'foreign';
}
// --- WHICH NAME WAS ASKED, by the Host header ---------------------------
// A page on the open web can make the browser send requests to this machine under ITS OWN name: the
// name is "rebound" to 127.0.0.1 after the page loads ("DNS rebinding"). Such a request carries
// Host and Origin of the attacker's name, so the Origin check above (an Origin equal to the Host
// it was asked on is "our own page") is satisfied, and a companion that is not hosted treats
// everyone who reaches it as its owner. So every request is judged by the NAME it asked for, once,
// by this one function, before anything is routed:
//   'loopback'  — 127.0.0.1, localhost or [::1], on the port this server listens on
//   'allowed'   — a public hostname the owner configured (publicHosts: the reading room's and the
//                 memorizer's names, PLUGIN_PUBLIC_HOSTNAMES)
//   'wrong-port'— a loopback name on some other port
//   'foreign'   — any other name
//   'missing'   — no Host header
export const HOST_VERDICTS = Object.freeze(['loopback', 'allowed', 'wrong-port', 'foreign', 'missing']);
export function hostVerdict(req, { publicHosts = [] } = {}) {
  const raw = String(req.headers.host || '').trim().toLowerCase();
  if (!raw) return 'missing';
  const m = /^(\[[0-9a-f:.]+\]|[^:\[\]]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m) return 'foreign';
  const [, name, port] = m;
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]') {
    const lp = req.socket && req.socket.localPort;
    return !lp || String(port || '80') === String(lp) ? 'loopback' : 'wrong-port';
  }
  const pub = new Set([...publicHosts.map(h => String(h).toLowerCase()), ...csv(process.env.PLUGIN_PUBLIC_HOSTNAMES)]);
  return pub.has(name) ? 'allowed' : 'foreign';
}
/**
 * Is a request refused because of the name it asked for? A missing Host always is. A foreign name, or a
 * loopback name on the wrong port, is refused when this companion is not hosted (everyone who reaches it is
 * its owner, so a name that is not this machine's is a rebinding attempt). When it is hosted, the password
 * gate answers for them instead: its tunnel carries the public name (or, behind cloudflared's
 * httpHostHeader, "localhost" with no port), and a request that merely claims to be local-direct with such
 * a name already is not (isLocalDirect).
 */
export function hostRefused(verdict, hosted) {
  if (verdict === 'loopback' || verdict === 'allowed') return false;
  if (verdict === 'missing') return true;
  return !hosted; // 'foreign' and 'wrong-port'
}

// The CORS answer for one request, from its verdict. Hosted mode only (the
// local companion never sent any, and its extension's worker needs none):
// an origin that passed is echoed back; no Origin at all keeps the wildcard
// (bearer, never cookies — the argument at the top of this file still holds,
// since a wildcard cannot carry credentials); a foreign one gets nothing.
export function corsFor(req, verdict, { credentials = false } = {}) {
  if (verdict === 'trusted') {
    // with Access the browser's cookie IS the credential, so the answer must name the origin (never `*`)
    // and say credentials are allowed
    return { ...CORS_HEADERS, 'access-control-allow-origin': String(req.headers.origin), vary: 'Origin',
      ...(credentials ? { 'access-control-allow-credentials': 'true' } : {}) };
  }
  // no Origin is no browser page: the wildcard is meaningless there, and with Access it is not offered at all
  if (verdict === 'absent') return credentials ? {} : CORS_HEADERS;
  return {};
}

// --- WHERE A REQUEST CAME FROM, decided once ---------------------------------
// Origin says which page sent a request; Sec-Fetch-Site/Mode/Dest say how the browser sent it. With Cloudflare Access the
// browser's own cookie is the credential and Cloudflare turns it into the assertion header for ANY request that carries it,
// so a page on another website could act as the person unless the request's source is judged first. One list, one function:
//   'trusted'  the Origin is ours (the companion's own page over https, a configured extension, a configured public name)
//   'unmarked' no Origin and nothing saying it came from another site: curl, node, the python side, a typed address, a bookmark,
//              or a top-level navigation (a link followed) to a page
//   'foreign'  an Origin that is not ours (including "null"), or a browser saying cross-site/same-site with no trusted Origin
//              (an image, script or frame include; anything but a followed link)
export const SOURCE_VERDICTS = Object.freeze(['trusted', 'unmarked', 'foreign']);
export function sourceVerdict(req, origin) {
  if (origin === 'foreign') return 'foreign';
  if (origin === 'trusted') return 'trusted';
  const h = req.headers || {};
  const site = String(h['sec-fetch-site'] || '');
  if (site !== 'cross-site' && site !== 'same-site') return 'unmarked';
  const nav = (req.method === 'GET' || req.method === 'HEAD') && h['sec-fetch-mode'] === 'navigate' && h['sec-fetch-dest'] === 'document';
  return nav ? 'unmarked' : 'foreign';
}
const isJsonCt = ct => /^application\/(?:[\w.+-]*\+)?json\b/i.test(String(ct || ''));
/**
 * Whether a request is refused for where it came from: null, or the words. `origin` is originVerdict's answer.
 *   foreign: every change, socket and stream refused; plain reads too unless strictReads is off (password mode).
 *   token-authenticated (the Access cookie is what let it in) and changing something: it must come from a TRUSTED origin, or be
 *     a non-browser caller that says application/json (a cross-site page cannot send that without a preflight).
 */
export function sourceRefusal(req, origin, { tokenAuth = false, strictReads = true } = {}) {
  const v = sourceVerdict(req, origin);
  const reads = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  // the companion answers GET, HEAD, OPTIONS and POST; any other method (PUT, PATCH, DELETE, ...) is not a read and is refused here
  if (!reads && req.method !== 'POST') return 'refused: unsupported method';
  if (v === 'foreign') {
    // A browser that says "cross-site" or "same-site" with no Origin (an image, a script, a frame include, a sibling subdomain's
    // subresource) is refused in every mode: nothing that is meant sends that. A foreign ORIGIN on a plain read is refused when
    // strictReads (always with Access); in password mode that one stays as it was (a bearer is not ambient and the page cannot read the answer).
    if (origin !== 'foreign' || strictReads || !reads) return 'refused: requests from other websites cannot use the companion';
  }
  if (tokenAuth && !reads && v === 'unmarked' && !isJsonCt((req.headers || {})['content-type'])) {
    return 'refused: a change must be sent as application/json';
  }
  return null;
}

// a handle names messages; it is not a credential (the password is)
export const sanitizeHandle = h => String(h || '').toLowerCase()
  .replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const escHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { escHtml };

const queryOf = req => new URLSearchParams(String(req.url || '').split('?')[1] || '');
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(/; */)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return '';
}
const safeNext = n => (n && n.startsWith('/') && !n.startsWith('//')) ? n : '/pages';

// hosted = false gives a no-op object: every call answers "owner, always" so
// the local companion keeps behaving exactly as it did before this file existed.
export function createHosted({ hosted, dir, ownerHandle, password = '', ownerPassword = '', authMode = 'password', reservedHandles = () => [] }) {
  // `access`: only a Cloudflare Access token counts; the password routes, login page and cookie are off.
  // `either`: a token when one is present, otherwise the password path. See access.mjs.
  const grantsFile = path.join(dir, 'grants.json');
  const usageFile = path.join(dir, 'grant-usage.json');
  const secretFile = path.join(dir, '.auth-secret');
  let secret = '';
  if (hosted && authMode !== 'access') {
    fs.mkdirSync(dir, { recursive: true });
    try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { }
    if (!secret) {
      secret = crypto.randomBytes(24).toString('hex');
      fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    }
  }
  const owner = () => String(ownerHandle() || '');
  // The owner's credential is the one the review hub already hands to every
  // paper server, so there is one password for everything (identity.mjs). An
  // explicit ownerPassword argument still wins, for tests and for anyone
  // running the companion on its own.
  // Resolved once, at startup rather than on the first remote request: this is
  // the credential the owner will type, so a hosted companion should establish
  // it (and persist a new one, if the hub never has) before it serves anything.
  const ownerPwMemo = (hosted && authMode !== 'access' && !ownerPassword) ? (sharedOwnerPassword() || '') : '';
  const ownerPw = () => authMode !== 'access' ? (ownerPassword || ownerPwMemo) : '';

  // --- the cookie: exp + role + HANDLE, signed. Stateless, survives restarts.
  // The handle is inside the signature, not beside it: a guest cookie used to
  // carry the role only, with the name in a separate unsigned `plugin_handle`
  // cookie that identity() then trusted — so any signed-in guest could rename
  // themselves to any other guest and write under their name. Signing the
  // triple makes the name as unforgeable as the role.
  const mac = (exp, role, handle) =>
    crypto.createHmac('sha256', secret).update(`${exp}.${role}.${handle}`).digest('hex');
  function cookieSession(req) {
    const parts = String(cookieOf(req, 'plugin_auth')).split('.');
    if (parts.length !== 4) return null; // 3-part cookies predate signed handles
    const [exp, role, handle, sig] = parts;
    if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return null;
    if (role !== 'owner' && role !== 'guest') return null;
    if (!/^[\w-]{1,40}$/.test(handle)) return null;
    return safeEqual(sig, mac(exp, role, handle)) ? { role, handle } : null;
  }
  function setCookies(req, role, handle) {
    const exp = String(Date.now() + AUTH_TTL_MS);
    const age = Math.floor(AUTH_TTL_MS / 1000);
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    return [
      // the credential — role and name both under the signature
      `plugin_auth=${exp}.${role}.${handle}.${mac(exp, role, handle)}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      // a NAME the page may read for labeling; never trusted for anything
      `plugin_handle=${encodeURIComponent(handle)}; Max-Age=${age}; Path=/; SameSite=Lax${secure}`,
    ];
  }
  // A phone that visits every few days should never meet the gate again. The
  // cookie is re-issued once it is past half its life, so continued use
  // extends it indefinitely while an abandoned session still expires.
  function refreshCookies(req) {
    if (!hosted || authMode === 'access' || tokenVerdict(req)) return null;
    const s = cookieSession(req);
    if (!s) return null;
    const [exp] = String(cookieOf(req, 'plugin_auth')).split('.');
    if (Number(exp) - Date.now() > AUTH_TTL_MS / 2) return null;
    return setCookies(req, s.role, s.handle);
  }
  const signOutCookies = () => [
    'plugin_auth=; Max-Age=0; Path=/',
    'plugin_handle=; Max-Age=0; Path=/',
  ];

  // An approved device is the owner outright, with nothing typed. This is the
  // review hub's own cookie, verified with the hub's own secret: a browser the
  // owner approved for review.botference.com arrives at discuss.botference.com
  // already carrying it, because the hub scopes it to the parent domain.
  const approvedDevice = req => !!deviceSession(cookieOf(req, 'hub_device'));

  // the extension's credential: a bearer token on the header, or — for WS and
  // SSE, which cannot set headers from a browser — the same value in the query
  function tokenOf(req) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (m) return m[1].trim();
    return queryOf(req).get('auth') || '';
  }

  // What the request's Access token came to (access.mjs ACCESS_VERDICTS), or null when this request is
  // judged by the password path: always in `password`; in `either`, when it carries no token. A token that
  // is present decides alone, whatever else rides with it (a password never raises a guest token's standing).
  function tokenVerdict(req) {
    if (authMode === 'password') return null;
    const v = verdictOfRequest(req);
    return (authMode === 'either' && v.verdict === 'absent') ? null : v;
  }
  function isOwner(req) {
    if (!hosted || isLocalDirect(req)) return true;
    const tv = tokenVerdict(req);
    if (tv) return tv.verdict === 'owner';
    if (approvedDevice(req)) return true;
    const t = tokenOf(req);
    const opw = ownerPw();
    if (t && opw && safeEqual(t, opw)) return true;
    const s = cookieSession(req);
    return !!s && s.role === 'owner';
  }
  function authorized(req) {
    if (!hosted || isLocalDirect(req)) return true;
    const tv = tokenVerdict(req);
    if (tv) return tv.verdict === 'owner' || tv.verdict === 'guest';
    if (approvedDevice(req)) return true;
    const t = tokenOf(req);
    if (t) {
      const opw = ownerPw();
      return safeEqual(t, password) || (!!opw && safeEqual(t, opw));
    }
    return !!cookieSession(req);
  }
  // A guest's name: from the extension's header (or the WS/SSE query), else
  // from the SIGNED cookie. The unsigned `plugin_handle` cookie is never
  // consulted — it exists so the page can print a name, not to prove one.
  const handleOf = (req) => {
    const s = cookieSession(req);
    // A signed-in browser IS its signed name. Letting a header override it
    // would hand the impersonation back: the cookie is the credential there,
    // so the name inside it is the answer, full stop.
    if (s && !tokenOf(req)) return s.handle;
    return sanitizeHandle(req.headers['x-plugin-handle'])
      || sanitizeHandle(queryOf(req).get('handle') || '')
      || (s ? s.handle : '');
  };

  // Who is writing this message. The owner is always the config author — on
  // localhost, from an approved device, through the owner password, from any
  // device — so their annotations stay one person across every way in. A guest
  // is their handle and nothing else: unauthenticated names are refused
  // rather than guessed.
  function identity(req) {
    if (!hosted || isLocalDirect(req)) return { handle: owner(), owner: true };
    if (isOwner(req)) return { handle: owner(), owner: true };
    // a verified collaborator is their configured name, never one the request asks for (and never the owner's, if the owner has since
    // taken it: then the name made for that case)
    const tv = tokenVerdict(req);
    if (tv) return tv.verdict === 'guest' ? { handle: tv.handle === sanitizeHandle(owner()) ? tv.alt : tv.handle, owner: false } : { handle: null, owner: false, error: 'not signed in', code: 401 };
    const h = handleOf(req);
    if (!h) return { handle: null, owner: false, error: 'a name is required — send x-plugin-handle', code: 400 };
    if (h === sanitizeHandle(owner())) {
      return { handle: null, owner: false, error: "that name is the owner's here — pick another", code: 403 };
    }
    // …nor the name of a collaborator signed in with Access (case does not matter: handles are lower-cased), which would let a password
    // guest write as them. Asked at every request, so a rename of the owner or a new collaborator is felt at once.
    if (reservedNames().has(h)) {
      return { handle: null, owner: false, error: 'that name belongs to someone else here — pick another', code: 403 };
    }
    // A cookie-borne name is signed, so it cannot be swapped; a header-borne
    // one is only as good as the bearer token beside it, which is the shared
    // guest password. Both land here as the same kind of guest.
    return { handle: h, owner: false };
  }

  // every name an Access collaborator can appear under, and the owner's: none of them may be taken by a password guest
  const reservedNames = () => new Set([sanitizeHandle(owner()), ...reservedHandles().map(sanitizeHandle)]);

  // --- the gate ---------------------------------------------------------
  function gatePage(next, bad, handle) {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Botference Discuss</title>
<link rel="icon" type="image/png" href="/favicon.ico">
<style>
:root { --bg:#faf7f0; --fg:#2a2419; --muted:#8a7f6d; --card:#fff; --line:#e7dfd1;
  --accent:#d97757; --accent-hover:#c05f3f }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1a1712; --fg:#e8dfd1; --muted:#9c917e; --card:#241f18;
    --line:rgba(217,119,87,.24); --accent-hover:#e8896d }
}
* { box-sizing:border-box }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
  background:var(--bg); color:var(--fg);
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif }
form { background:var(--card); border:1px solid var(--line); border-radius:12px;
  padding:2rem 2.2rem; width:min(22rem,88vw); box-shadow:0 2px 14px rgba(0,0,0,.1) }
h1 { font-size:1.05rem; margin:0 0 .3rem }
p { margin:.2rem 0 1.1rem; color:var(--muted); font-size:.85rem }
label { display:block; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em;
  color:var(--muted); margin:.9rem 0 .25rem }
input { width:100%; box-sizing:border-box; padding:.55rem .7rem; font-size:1rem;
  border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg) }
.hint { margin:.35rem 0 0; font-size:.72rem }
button { margin-top:1.1rem; width:100%; padding:.55rem; font-size:1rem; border:none;
  border-radius:8px; background:var(--accent); color:#fff; cursor:pointer }
button:hover { background:var(--accent-hover) }
.err { color:var(--accent); font-size:.85rem; margin:.7rem 0 0 }
</style></head><body>
<form method="POST" action="/auth">
<h1>Botference Discuss</h1>
<p>The annotated pages are password-protected.</p>
<label for="g-handle">your name</label>
<input id="g-handle" name="handle" value="${escHtml(handle || '')}" placeholder="e.g. ada" maxlength="40"
  autofocus autocapitalize="none" autocorrect="off" autocomplete="nickname" aria-label="your name">
<p class="hint">names your comments — not a password.</p>
<label for="g-pass">password</label>
<input id="g-pass" type="password" name="password" placeholder="password" autocomplete="current-password" aria-label="password">
<input type="hidden" name="next" value="${escHtml(next)}">
<button>open the annotations</button>
${bad ? `<div class="err">${escHtml(bad === true ? 'wrong password — try again' : bad)}</div>` : ''}
</form></body></html>`;
  }

  // POST /auth: name + password together (a phone has nowhere else to put the
  // name). Right password -> signed cookie + back to where they were headed.
  function authEndpoint(req, res) {
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 1e4) req.destroy(); });
    req.on('end', () => {
      // decoded once, whole: a name in any script survives a chunk boundary
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const next = safeNext(form.get('next'));
      const raw = form.get('handle') || '';
      const handle = sanitizeHandle(raw);
      const given = form.get('password') || '';
      // the owner password outranks the name rules: whatever was typed, this
      // login is the owner, cookied under the owner's configured author. It is
      // the same password the review hub hands to every paper, so the phone
      // that opens a review opens the annotations with the same thing typed.
      const opw = ownerPw();
      if (opw && safeEqual(given, opw)) {
        res.writeHead(303, {
          'set-cookie': setCookies(req, 'owner', sanitizeHandle(owner()) || 'owner'),
          location: next,
        }).end();
        return;
      }
      if (!handle) {
        res.writeHead(401, HTML_HEAD).end(gatePage(next, 'enter a name so your comments can be saved', raw));
        return;
      }
      if (!safeEqual(given, password)) {
        res.writeHead(401, HTML_HEAD).end(gatePage(next, true, raw));
        return;
      }
      if (handle === sanitizeHandle(owner())) {
        res.writeHead(401, HTML_HEAD).end(gatePage(next,
          `“${handle}” is the owner's name here — please pick another`, ''));
        return;
      }
      if (reservedNames().has(handle)) {
        res.writeHead(401, HTML_HEAD).end(gatePage(next, `“${handle}” belongs to someone else here — please pick another`, ''));
        return;
      }
      res.writeHead(303, { 'set-cookie': setCookies(req, 'guest', handle), location: next }).end();
    });
  }

  // Unauthenticated: a browser asking for a document gets the gate; anything a
  // script fetches gets flat 401 JSON. No WWW-Authenticate anywhere — that is
  // what pops the browser's own basic-auth dialog.
  const NOTICE_PAGE = (title, line) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><style>body{font:16px/1.6 -apple-system,Helvetica,Arial,sans-serif;max-width:30rem;margin:4rem auto;padding:0 1rem;color:#2a2419;background:#faf7f0}
@media (prefers-color-scheme:dark){body{color:#e8dfd1;background:#1a1712}}</style></head><body><h1>${escHtml(title)}</h1><p>${escHtml(line)}</p></body></html>`;
  // The refusal for a request judged by its Access token. A person who is not on this companion's list is
  // told so plainly (nothing else: no address, no list); no token is a 401; a service token is refused.
  function deniedByToken(req, res, tv) {
    const wantsPage = req.method === 'GET' && /text\/html/.test(req.headers.accept || '');
    const [code, line] = tv.verdict === 'unlisted' ? [403, "this account is not on this companion's list"]
      : tv.verdict === 'service' ? [403, 'service tokens are not accepted here']
      : [401, 'sign-in required: open this address in a browser and sign in with Cloudflare Access'];
    if (wantsPage) { res.writeHead(code, HTML_HEAD).end(NOTICE_PAGE(code === 401 ? 'Sign-in required' : 'Not allowed', line)); return; }
    // `signin` tells the extension this is a sign-in matter (not a wrong password, not an outage)
    res.writeHead(code, JSON_HEAD).end(JSON.stringify(code === 401 ? { ok: false, error: line, signin: true } : { ok: false, error: line }));
  }
  function denied(req, res) {
    const tv = tokenVerdict(req);
    if (tv || authMode === 'access') return deniedByToken(req, res, tv || { verdict: 'absent' });
    if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
      res.writeHead(401, HTML_HEAD).end(gatePage(safeNext(String(req.url || '').split('?')[0]), false));
      return;
    }
    // the CORS headers, when this request earned any, were set by the
    // caller (server.mjs, from the Origin verdict) and ride along from there
    res.writeHead(401, JSON_HEAD).end('{"ok":false,"error":"auth required"}');
  }

  // --- grants: who may spend the owner's agents, and how much ------------
  // Hand-edited JSON for v1, re-read whenever its mtime moves — the owner
  // grants access with a text editor and it takes effect on the next mention,
  // with no restart and nothing to click.
  //
  // Both files have three read results (fsjson.mjs): missing, ok, unreadable.
  // A grants file the owner broke with a stray comma is NOT "no grants" — it
  // is "cannot tell", and the answer to a guest is a plain "bot access is
  // paused" rather than a misleading "you were never granted it". The usage
  // counter is the one that is WRITTEN, so an unreadable one is never written
  // over: rewriting it from empty would also hand every guest a fresh budget.
  // Each throws UnreadableJsonError; server.mjs guestRefusal turns that into
  // the guest's answer.
  let grantsCache = { mtime: -1, size: -1, got: { state: 'missing', value: undefined, error: null } };
  function readGrants() {
    let st = null;
    try { st = fs.statSync(grantsFile); } catch { grantsCache = { mtime: -1, size: -1, got: { state: 'missing' } }; return {}; }
    const mtime = st.mtimeMs;
    if (mtime !== grantsCache.mtime || st.size !== grantsCache.size) {
      grantsCache = { mtime, size: st.size, got: readJsonState(grantsFile) };
    }
    const { got } = grantsCache;
    if (got.state === 'unreadable') {
      warnUnreadable(grantsFile, got.error);
      throw new UnreadableJsonError(grantsFile, got.error);
    }
    return (got.state === 'ok' && got.value && typeof got.value === 'object') ? got.value : {};
  }
  function readUsage() {
    const got = readJsonState(usageFile);
    if (got.state === 'unreadable') {
      warnUnreadable(usageFile, got.error);
      throw new UnreadableJsonError(usageFile, got.error);
    }
    return (got.state === 'ok' && got.value && typeof got.value === 'object') ? got.value : {};
  }
  const today = () => new Date().toISOString().slice(0, 10);
  function grantFor(handle) {
    const g = readGrants()[handle];
    return g && g.agents ? { agents: true, daily_cap: Number(g.daily_cap) || DEFAULT_CAP } : null;
  }
  function grantUsed(handle) {
    const u = readUsage();
    return u.date === today() ? Number((u.counts || {})[handle]) || 0 : 0;
  }
  function grantSpend(handle) {
    let u = readUsage();
    if (u.date !== today()) u = { date: today(), counts: {} };
    u.counts = u.counts || {};
    u.counts[handle] = (u.counts[handle] || 0) + 1;
    writeJson(usageFile, u);
    return u.counts[handle];
  }

  return {
    hosted, authMode, grantsFile, usageFile,
    // did an Access token (not a password, not the loopback) let this request in?
    tokenAuthenticated: req => { const tv = hosted && !isLocalDirect(req) ? tokenVerdict(req) : null; return !!tv && (tv.verdict === 'owner' || tv.verdict === 'guest'); },
    authorized, isOwner, identity, denied, authEndpoint, gatePage,
    grantFor, grantUsed, grantSpend,
    refreshCookies, signOutCookies, ownerPassword: ownerPw,
  };
}
