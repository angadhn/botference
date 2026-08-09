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

export const AUTH_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
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

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
const escHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export { escHtml };

// Headers no browser on this machine ever sends, and that every reverse proxy
// in front of us does — cloudflared included. Their presence is proof the
// request was forwarded, whatever the socket or the Host line claims.
export const PROXY_HEADERS = [
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
];

// A request that arrived directly on the loopback interface — NOT through the
// tunnel. This is the whole owner/guest boundary, so it is deliberately three
// independent tests, ALL of which must pass:
//
//   1. Host names this machine. A named tunnel (plugin.botference.com) carries
//      its public hostname here, because cloudflared forwards Host unchanged.
//   2. No proxy headers. cloudflared's own hop to the companion also comes
//      from 127.0.0.1, so the socket alone cannot tell tunnel traffic apart —
//      but the Cloudflare edge stamps CF-Connecting-IP/CF-Ray and cloudflared
//      adds X-Forwarded-*, and neither can be suppressed by a visitor. This is
//      the test that still holds if the tunnel is ever configured with
//      httpHostHeader (which would rewrite Host to localhost).
//   3. The peer really is loopback, so a LAN client cannot claim to be local.
//
// It fails closed in both directions: no test can be satisfied from outside,
// and the worst a false negative does is ask the owner for their own password.
// Anyone on the bare port already owns this filesystem: localhost IS the owner.
export function isLocalDirect(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
  for (const h of PROXY_HEADERS) if (req.headers[h]) return false;
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

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

  // --- the cookie: exp + role, signed. Stateless, survives restarts. -----
  const mac = (exp, role) => crypto.createHmac('sha256', secret).update(`${exp}.${role}`).digest('hex');
  function cookieRole(req) {
    const [exp, role, sig] = String(cookieOf(req, 'plugin_auth')).split('.');
    if (!exp || !role || !sig || !/^\d+$/.test(exp) || Date.now() > Number(exp)) return null;
    if (role !== 'owner' && role !== 'guest') return null;
    return safeEqual(sig, mac(exp, role)) ? role : null;
  }
  function setCookies(req, role, handle) {
    const exp = String(Date.now() + AUTH_TTL_MS);
    const age = Math.floor(AUTH_TTL_MS / 1000);
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    return [
      // the credential
      `plugin_auth=${exp}.${role}.${mac(exp, role)}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      // a NAME, readable by the page; never trusted for anything but labeling
      `plugin_handle=${encodeURIComponent(handle)}; Max-Age=${age}; Path=/; SameSite=Lax${secure}`,
    ];
  }

  // the extension's credential: a bearer token on the header, or — for WS and
  // SSE, which cannot set headers from a browser — the same value in the query
  function tokenOf(req) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (m) return m[1].trim();
    return queryOf(req).get('auth') || '';
  }

  function isOwner(req) {
    if (!hosted || isLocalDirect(req)) return true;
    const t = tokenOf(req);
    if (t && ownerPassword && safeEqual(t, ownerPassword)) return true;
    return cookieRole(req) === 'owner';
  }
  function authorized(req) {
    if (!hosted || isLocalDirect(req)) return true;
    const t = tokenOf(req);
    if (t) return safeEqual(t, password) || (!!ownerPassword && safeEqual(t, ownerPassword));
    return !!cookieRole(req);
  }
  const handleOf = req => sanitizeHandle(req.headers['x-plugin-handle'])
    || sanitizeHandle(queryOf(req).get('handle') || '')
    || sanitizeHandle(decodeURIComponent(cookieOf(req, 'plugin_handle') || ''));

  // Who is writing this message. The owner is always the config author — on
  // localhost, through the owner password, from any device — so their
  // annotations stay one person across every way in. A guest is their handle
  // and nothing else: unauthenticated names are refused rather than guessed.
  function identity(req) {
    if (!hosted || isLocalDirect(req)) return { handle: owner(), owner: true };
    if (isOwner(req)) return { handle: owner(), owner: true };
    const h = handleOf(req);
    if (!h) return { handle: null, owner: false, error: 'a name is required — send x-plugin-handle', code: 400 };
    if (h === sanitizeHandle(owner())) {
      return { handle: null, owner: false, error: "that name is the owner's here — pick another", code: 403 };
    }
    return { handle: h, owner: false };
  }

  // --- the gate ---------------------------------------------------------
  function gatePage(next, bad, handle) {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web annotations</title>
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
<h1>Web annotations</h1>
<p>These pages are password-protected.</p>
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
      // login is the owner, cookied under the owner's configured author
      if (ownerPassword && safeEqual(given, ownerPassword)) {
        res.writeHead(303, { 'set-cookie': setCookies(req, 'owner', owner()), location: next }).end();
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
  };
}
