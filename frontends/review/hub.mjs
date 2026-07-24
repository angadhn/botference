#!/usr/bin/env node
// ── botference review hub ────────────────────────────────────────────
// One stable front door for every hosted paper review on this machine:
//   https://review.<domain>/        gated portal listing the papers the
//                                   visitor is on (owner on localhost
//                                   sees everything, no login)
//   https://<paper>.<domain>/       transparent reverse proxy to that
//                                   paper's own review server — its gate,
//                                   cookies, SSE and rate limits apply
//                                   unchanged; when the paper server is
//                                   down, a friendly "work from the git
//                                   repo" page instead of a 502
//
// Run it behind ONE named cloudflared tunnel whose DNS routes (the hub
// hostname plus one per paper) all point at this port; adding a paper is
// a config entry + a `cloudflared tunnel route dns` — no restarts.
//
// Config (JSON, re-read on every request so edits apply live):
//   $REVIEW_HUB_CONFIG or ~/.botference/review-hub.json
//   { "port": 4180, "host": "review.example.com", "name": "Review portal",
//     "papers": [ { "slug": "acta", "host": "acta.example.com",
//                   "port": 4181, "title": "…", "repo": "https://…",
//                   "collaborators": ["ada"] } ] }
// A collaborator sees a paper when their login password validates against
// it (forwarded to the paper's own /auth — the hub stores no passwords)
// or their handle is declared in that paper's `collaborators` list (so a
// paper whose server is down still shows, marked offline).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const CONFIG_FILE = process.env.REVIEW_HUB_CONFIG
  || path.join(os.homedir(), '.botference', 'review-hub.json');

function config() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    c.papers = Array.isArray(c.papers) ? c.papers : [];
    return c;
  } catch (e) {
    return { papers: [], _error: String(e && e.message || e) };
  }
}

const BOOT = config();
const PORT = Number(process.env.PORT || BOOT.port || 4180);

// hub sessions: HMAC-signed, stateless (same shape as the paper servers'
// auth cookie), secret persisted beside the config so restarts keep guests in
const AUTH_TTL_MS = 7 * 24 * 3600 * 1000;
const secretFile = CONFIG_FILE.replace(/[^/\\]+$/, '.review-hub-secret');
let SECRET = '';
try { SECRET = fs.readFileSync(secretFile, 'utf8').trim(); } catch { }
if (!SECRET) {
  SECRET = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
}

// optional owner login: with REVIEW_HUB_PASSWORD set, that password (any
// name) opens the full owner view from any device — the phone case, where
// localhost-is-owner can't apply
const OWNER_PW = process.env.REVIEW_HUB_PASSWORD || '';

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const sanitizeHandle = h => String(h || '').toLowerCase().replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// same test as server.mjs isLocalDirect: a bare loopback request that did NOT
// come through the tunnel (the tunnel's local hop carries its hostname + Cf-*)
function isLocalDirect(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']) return false;
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(/; */)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return '';
}
// hub_auth = exp.handle.slug,slug….mac — which papers this login validated on
function session(req) {
  const raw = decodeURIComponent(cookieOf(req, 'hub_auth') || '');
  const m = /^(\d+)\.([\w-]*)\.([\w,*-]*)\.([0-9a-f]+)$/.exec(raw);
  if (!m || Date.now() > Number(m[1])) return null;
  const mac = crypto.createHmac('sha256', SECRET).update(`${m[1]}.${m[2]}.${m[3]}`).digest('hex');
  if (!safeEqual(mac, m[4])) return null;
  return { handle: m[2], slugs: m[3] ? m[3].split(',') : [] };
}
function sessionCookie(handle, slugs, req) {
  const exp = String(Date.now() + AUTH_TTL_MS);
  const body = `${exp}.${handle}.${slugs.join(',')}`;
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `hub_auth=${encodeURIComponent(`${body}.${mac}`)}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

// per-IP limit on login attempts (each one fans out to every paper server)
const RATE = new Map();
function rateLimited(req) {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
  const now = Date.now();
  const r = RATE.get(ip) || { n: 0, t: now };
  if (now - r.t > 60000) { r.n = 0; r.t = now; }
  r.n++; RATE.set(ip, r);
  return r.n > 15;
}

// ── talking to the paper servers (always 127.0.0.1:<port>) ──────────
// liveness: request /, count the status line as alive, never read the body
function probe(port) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, res => {
      res.destroy(); resolve(true);
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve(false));
  });
}
// does this name+password pass that paper's own gate? Forward the attempt to
// its /auth with the caller's tunnel headers so the paper sees a remote guest
// (never a localhost owner) and rate-limits the real client. 303 = yes.
function gateCheck(paper, handle, password, req) {
  return new Promise(resolve => {
    const body = new URLSearchParams({ handle, password, next: '/' }).toString();
    const r = http.request({
      host: '127.0.0.1', port: paper.port, path: '/auth', method: 'POST', timeout: 4000,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        host: paper.host || 'review-hub',
        'cf-connecting-ip': req.headers['cf-connecting-ip'] || '',
        'x-forwarded-for': req.headers['x-forwarded-for'] || '',
      },
    }, res => { res.destroy(); resolve(res.statusCode === 303); });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve(false));
    r.end(body);
  });
}

// ── pages (palette matches the paper gate in server.mjs) ────────────
const PAGE_CSS = `
:root { --bg:#faf7f0; --fg:#2a2419; --muted:#8a7f6d; --card:#ffffff; --line:#e7dfd1;
  --accent:#d97757; --accent-hover:#c05f3f; --ok:#4a7c59 }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1a1712; --fg:#e8dfd1; --muted:#9c917e; --card:#241f18;
    --line:rgba(217,119,87,.24); --accent-hover:#e8896d; --ok:#7fb08d }
}
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
  background:var(--bg); color:var(--fg); padding:1rem; box-sizing:border-box;
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif }
main, form { background:var(--card); border:1px solid var(--line); border-radius:12px;
  padding:2rem 2.2rem; width:min(26rem,92vw); box-shadow:0 2px 14px rgba(0,0,0,.1) }
h1 { font-size:1.05rem; margin:0 0 .3rem }
p { margin:.2rem 0 1.1rem; color:var(--muted); font-size:.85rem }
label { display:block; font-size:.72rem; text-transform:uppercase; letter-spacing:.06em;
  color:var(--muted); margin:.9rem 0 .25rem }
input { width:100%; box-sizing:border-box; padding:.55rem .7rem; font-size:1rem;
  border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg) }
button { margin-top:1.1rem; width:100%; padding:.55rem; font-size:1rem; border:none;
  border-radius:8px; background:var(--accent); color:#fff; cursor:pointer }
button:hover { background:var(--accent-hover) }
.err { color:var(--accent); font-size:.85rem; margin:.7rem 0 0 }
ul.papers { list-style:none; margin:1rem 0 0; padding:0 }
ul.papers li { border-top:1px solid var(--line); padding:.8rem 0 }
ul.papers a { color:var(--fg); text-decoration:none; font-weight:600 }
ul.papers a:hover { color:var(--accent) }
.meta { font-size:.78rem; color:var(--muted); margin-top:.15rem }
.dot { display:inline-block; width:.55em; height:.55em; border-radius:50%; margin-right:.4em }
.live { background:var(--ok) } .down { background:var(--muted) }
.local { font-size:.78rem } .signout { margin-top:1.4rem; font-size:.78rem }
a { color:var(--accent) }`;
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;
const HTML_HEAD = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

function gatePage(name, bad, handle) {
  return page(name, `<form method="POST" action="/auth">
<h1>${escHtml(name)}</h1>
<p>Sign in to see the reviews you collaborate on.</p>
<label for="g-handle">your name</label>
<input id="g-handle" name="handle" value="${escHtml(handle || '')}" placeholder="e.g. ada" maxlength="40"
  autofocus autocapitalize="none" autocorrect="off" autocomplete="nickname">
<label for="g-pass">password</label>
<input id="g-pass" type="password" name="password" placeholder="your review password" autocomplete="current-password">
<button>see my reviews</button>
${bad ? `<div class="err">${escHtml(bad)}</div>` : ''}
</form>`);
}

// the offline stand-in served on a paper's own hostname when its server is down
function offlinePage(paper) {
  const title = paper.title || paper.slug;
  return page(title, `<main>
<h1>${escHtml(title)}</h1>
<p>The live review server for this paper is offline right now.</p>
<p>You can keep working from the git repository${paper.repo
    ? ` — <a href="${escHtml(paper.repo)}">${escHtml(paper.repo)}</a>` : ''}:
clone it and run the review locally (see the README), and push your comments
with <code>node review/submit.mjs --push</code>. Your work merges when the
live review returns.</p>
</main>`);
}

async function listPage(cfg, papers, viewer, res, remote = false) {
  const status = await Promise.all(papers.map(p => probe(p.port)));
  const localLinks = viewer === 'owner' && !remote; // dead weight on a phone
  const items = papers.map((p, i) => {
    const live = status[i];
    const href = `https://${p.host}/`;
    return `<li><span class="dot ${live ? 'live' : 'down'}"></span><a href="${escHtml(href)}">${escHtml(p.title || p.slug)}</a>
<div class="meta">${escHtml(p.host)}${live ? '' : ' — offline (work from the git repo; it merges when the share returns)'}${localLinks ? ` · <a class="local" href="http://localhost:${p.port}/">localhost:${p.port}</a>` : ''}</div></li>`;
  }).join('');
  const who = viewer === 'owner' ? 'owner view — every configured paper'
    : `signed in as <b>${escHtml(viewer)}</b>`;
  res.writeHead(200, HTML_HEAD).end(page(cfg.name || 'Review portal', `<main>
<h1>${escHtml(cfg.name || 'Review portal')}</h1>
<p>${who}</p>
${papers.length ? `<ul class="papers">${items}</ul>` : '<p>No reviews here for this login.</p>'}
${remote ? '<div class="signout"><a href="/signout">sign out</a></div>' : ''}
</main>`));
}

// ── transparent reverse proxy for a paper hostname ──────────────────
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
function proxy(paper, req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const up = http.request({
    host: '127.0.0.1', port: paper.port, path: req.url, method: req.method, headers,
  }, ures => {
    const out = { ...ures.headers };
    for (const k of HOP) delete out[k];
    res.writeHead(ures.statusCode, out);
    ures.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(503, HTML_HEAD).end(offlinePage(paper));
    else res.destroy();
  });
  req.pipe(up);
  res.on('close', () => up.destroy());
}

// ── portal (hub hostname or localhost) ──────────────────────────────
function portal(cfg, req, res) {
  const url = (req.url || '/').split('?')[0];
  if (isLocalDirect(req)) {  // the owner's machine: no login, everything shown
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return listPage(cfg, cfg.papers, 'owner', res);
    }
    res.writeHead(404, HTML_HEAD).end(page('Not found', '<main><h1>Not found</h1></main>'));
    return;
  }
  if (req.method === 'POST' && url === '/auth') {
    if (rateLimited(req)) {
      res.writeHead(429, HTML_HEAD).end(gatePage(cfg.name || 'Review portal', 'too many attempts — wait a minute', ''));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', async () => {
      const form = new URLSearchParams(body);
      const handle = sanitizeHandle(form.get('handle') || '');
      const password = form.get('password') || '';
      if (!handle) {
        res.writeHead(401, HTML_HEAD).end(gatePage(cfg.name || 'Review portal', 'enter your name', form.get('handle')));
        return;
      }
      // the hub owner password (env) outranks the per-paper checks: full list
      if (OWNER_PW && safeEqual(password, OWNER_PW)) {
        res.writeHead(303, { 'set-cookie': sessionCookie(handle, ['*'], req), location: '/' }).end();
        return;
      }
      // ask each paper's own gate; the hub never stores or compares passwords
      const oks = await Promise.all(cfg.papers.map(p => gateCheck(p, handle, password, req)));
      const slugs = cfg.papers.filter((p, i) => oks[i]).map(p => p.slug);
      const declared = cfg.papers.some(p => (p.collaborators || []).includes(handle));
      if (!slugs.length && !declared) {
        res.writeHead(401, HTML_HEAD).end(gatePage(cfg.name || 'Review portal',
          'no review here matches that name and password', handle));
        return;
      }
      res.writeHead(303, { 'set-cookie': sessionCookie(handle, slugs, req), location: '/' }).end();
    });
    return;
  }
  if (url === '/signout') {
    res.writeHead(303, { 'set-cookie': 'hub_auth=; Max-Age=0; Path=/', location: '/' }).end();
    return;
  }
  const s = session(req);
  if (!s) {
    res.writeHead(401, HTML_HEAD).end(gatePage(cfg.name || 'Review portal', false, ''));
    return;
  }
  // '*' marks an owner-password login: everything, from any device
  if (s.slugs.includes('*')) return listPage(cfg, cfg.papers, 'owner', res, true);
  // their papers: password-validated at login, plus any they are declared on
  const mine = cfg.papers.filter(p =>
    s.slugs.includes(p.slug) || (p.collaborators || []).includes(s.handle));
  return listPage(cfg, mine, s.handle, res, true);
}

const server = http.createServer((req, res) => {
  const cfg = config();
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const paper = cfg.papers.find(p => (p.host || '').toLowerCase() === host);
  if (paper) return proxy(paper, req, res);
  const hubHost = (cfg.host || '').toLowerCase();
  if (host === hubHost || host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return portal(cfg, req, res);
  }
  res.writeHead(404, HTML_HEAD).end(page('No review here',
    '<main><h1>No review here</h1><p>Nothing is published at this address.</p></main>'));
});
// SSE streams ride through the proxy: never time a request out hub-side
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.listen(PORT, '127.0.0.1', () => {
  const cfg = config();
  console.log(`review hub on http://localhost:${PORT}/ — ${cfg.papers.length} paper(s)` +
    (cfg._error ? `  [config error: ${cfg._error}]` : ''));
});
