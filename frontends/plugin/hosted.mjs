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
// the atomic write and the constant-time compare, one copy each for the tree
import { readJson, writeJson, safeEqual } from './fsjson.mjs';
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
export function createHosted({ hosted, dir, ownerHandle, password = '', ownerPassword = '' }) {
  const grantsFile = path.join(dir, 'grants.json');
  const usageFile = path.join(dir, 'grant-usage.json');
  const secretFile = path.join(dir, '.auth-secret');
  let secret = '';
  if (hosted) {
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
  const ownerPwMemo = (hosted && !ownerPassword) ? (sharedOwnerPassword() || '') : '';
  const ownerPw = () => ownerPassword || ownerPwMemo;

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
    if (!hosted) return null;
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

  function isOwner(req) {
    if (!hosted || isLocalDirect(req)) return true;
    if (approvedDevice(req)) return true;
    const t = tokenOf(req);
    const opw = ownerPw();
    if (t && opw && safeEqual(t, opw)) return true;
    const s = cookieSession(req);
    return !!s && s.role === 'owner';
  }
  function authorized(req) {
    if (!hosted || isLocalDirect(req)) return true;
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
    const h = handleOf(req);
    if (!h) return { handle: null, owner: false, error: 'a name is required — send x-plugin-handle', code: 400 };
    if (h === sanitizeHandle(owner())) {
      return { handle: null, owner: false, error: "that name is the owner's here — pick another", code: 403 };
    }
    // A cookie-borne name is signed, so it cannot be swapped; a header-borne
    // one is only as good as the bearer token beside it, which is the shared
    // guest password. Both land here as the same kind of guest.
    return { handle: h, owner: false };
  }

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
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      const form = new URLSearchParams(body);
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
      res.writeHead(303, { 'set-cookie': setCookies(req, 'guest', handle), location: next }).end();
    });
  }

  // Unauthenticated: a browser asking for a document gets the gate; anything a
  // script fetches gets flat 401 JSON. No WWW-Authenticate anywhere — that is
  // what pops the browser's own basic-auth dialog.
  function denied(req, res) {
    if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
      res.writeHead(401, HTML_HEAD).end(gatePage(safeNext(String(req.url || '').split('?')[0]), false));
      return;
    }
    res.writeHead(401, { ...JSON_HEAD, ...(hosted ? CORS_HEADERS : {}) })
      .end('{"ok":false,"error":"auth required"}');
  }

  // --- grants: who may spend the owner's agents, and how much ------------
  // Hand-edited JSON for v1, re-read whenever its mtime moves — the owner
  // grants access with a text editor and it takes effect on the next mention,
  // with no restart and nothing to click.
  let grantsCache = { mtime: -1, size: -1, data: {} };
  function readGrants() {
    let st = null;
    try { st = fs.statSync(grantsFile); } catch { grantsCache = { mtime: -1, size: -1, data: {} }; return {}; }
    const mtime = st.mtimeMs;
    if (mtime !== grantsCache.mtime || st.size !== grantsCache.size) {
      grantsCache = { mtime, size: st.size, data: readJson(grantsFile, {}) || {} };
    }
    return grantsCache.data;
  }
  const today = () => new Date().toISOString().slice(0, 10);
  function grantFor(handle) {
    const g = readGrants()[handle];
    return g && g.agents ? { agents: true, daily_cap: Number(g.daily_cap) || DEFAULT_CAP } : null;
  }
  function grantUsed(handle) {
    const u = readJson(usageFile, {}) || {};
    return u.date === today() ? Number((u.counts || {})[handle]) || 0 : 0;
  }
  function grantSpend(handle) {
    let u = readJson(usageFile, {}) || {};
    if (u.date !== today()) u = { date: today(), counts: {} };
    u.counts = u.counts || {};
    u.counts[handle] = (u.counts[handle] || 0) + 1;
    writeJson(usageFile, u);
    return u.counts[handle];
  }

  return {
    hosted, grantsFile, usageFile,
    authorized, isOwner, identity, denied, authEndpoint, gatePage,
    grantFor, grantUsed, grantSpend,
    refreshCookies, signOutCookies, ownerPassword: ownerPw,
  };
}
