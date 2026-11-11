#!/usr/bin/env node
// Generic live review server: serves site/, per-user state mirroring, merged /data, SSE /events.
// Run:  node review/server.mjs   then open http://localhost:<port from review.config.json>
// Flags: --chat (spawn the bot bridge)  --hosted (shared-URL mode: REVIEW_PASSWORD
// basic auth, per-browser handle picker, rate-limited writes, owner-gated bots/apply)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { ApplyEngine, readJsonState, writeJsonAtomic, writeFileAtomic, unreadableMessage,
  execFailure, GIT_TIMEOUT_MS } from './apply.mjs';
import { projectNotebook } from './notebook.mjs';
import { attachWs } from './ws.mjs';
import { createDiscuss, baseOf, mergeThreads } from './discuss.mjs';

const REVIEW = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(REVIEW, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(REVIEW, 'review.config.json'), 'utf8'));
const SITE = path.join(REVIEW, 'site');
const STATE = path.join(REVIEW, 'state');
const USERS = path.join(STATE, 'users');
// figure dirs: figures_dirs (array) with legacy figures_dir (string) still honored;
// longest prefix first so nested dirs (tex/Figures vs Figures) match correctly
const FIG_DIRS = [...new Set([].concat(CFG.figures_dirs ?? CFG.figures_dir ?? 'Figures')
  .map(d => String(d).replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean))]
  .sort((a, b) => b.length - a.length);
fs.mkdirSync(USERS, { recursive: true });
const PORT = process.env.PORT || CFG.port || 4177;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf' };

// --- identity: git-based handle, computed once at boot ---
function gitConfig(key) {
  try { return execFileSync('git', ['config', key], { cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim(); }
  catch { return ''; }
}
const HANDLE = gitConfig('github.user') ||
  (gitConfig('user.name') || 'anonymous').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const userFile = h => path.join(USERS, h.replace(/[^\w-]/g, '_') + '.json');

// --- hosted mode: shared password + per-browser handles + owner token ---
const HOSTED = process.argv.includes('--hosted');
const PASSWORD = process.env.REVIEW_PASSWORD || '';
// optional second password that signs the OWNER in from any device: the gate
// accepts the owner's handle with it and forwards through ?owner=<token>, so
// the browser picks up owner standing exactly as the printed owner link does.
// The guest password keeps working unchanged; without this env var, owner
// access stays localhost + token-link only.
const OWNER_PASSWORD = process.env.REVIEW_OWNER_PASSWORD || '';
if (HOSTED && !PASSWORD) {
  console.error('--hosted requires REVIEW_PASSWORD to be set, e.g.  REVIEW_PASSWORD=… node review/server.mjs --hosted');
  process.exit(1);
}
// the owner token gates bot summons and apply/commit/revert on a shared URL;
// runtime file (gitignored), stable across restarts so the owner's browser stays owner
const tokenFile = path.join(STATE, '.owner-token');
// a secret file that exists but cannot be read is NEVER replaced: a new one
// would silently sign everybody out (or lock the owner out). Missing or empty
// is created; unreadable stops the server with the file named.
function persistedSecretFile(file, bytes, what) {
  let s = '';
  try { s = fs.readFileSync(file, 'utf8').trim(); } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      console.error(`The ${what} file (${path.relative(ROOT, file)}) exists but could not be read (${e && e.code || e}). `
        + 'It was left untouched and the server did not start. Fix its permissions or move it, then start again.');
      process.exit(1);
    }
  }
  if (s) return s;
  s = crypto.randomBytes(bytes).toString('hex');
  writeFileAtomic(file, s, { mode: 0o600 });
  return s;
}
let OWNER_TOKEN = '';
if (HOSTED) OWNER_TOKEN = persistedSecretFile(tokenFile, 12, 'owner link');
// hosted auth cookie: HMAC-signed expiry, keyed by a per-deployment secret
// (runtime file, gitignored) — stateless to validate, survives server restarts
const AUTH_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const secretFile = path.join(STATE, '.auth-secret');
let AUTH_SECRET = '';
if (HOSTED) AUTH_SECRET = persistedSecretFile(secretFile, 24, 'sign-in key');
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
// A request that reached us directly on the loopback interface — NOT through
// the cloudflared tunnel. The tunnel's local hop also originates from
// 127.0.0.1, but it always carries the tunnel hostname in Host plus Cf-* /
// forwarding headers, so requiring a localhost Host AND the absence of those
// headers AND a loopback socket separates the two. Anyone who can reach the
// bare loopback port already owns this filesystem, so the password gate and
// the owner token add nothing there: localhost IS the owner.
function isLocalDirect(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']) return false;
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}
// browsers authenticate through the /auth password gate (cookie below); curl
// and other tools may keep sending Authorization: Basic with ANY username
function authorized(req) {
  if (!HOSTED || isLocalDirect(req)) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (m) {
    const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
    return safeEqual(pass, PASSWORD);
  }
  return validAuthCookie(req);
}
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(/; */)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return '';
}
function validAuthCookie(req) {
  const [exp, mac] = cookieOf(req, 'review_auth').split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  return safeEqual(mac, crypto.createHmac('sha256', AUTH_SECRET).update(exp).digest('hex'));
}
const escHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// gate title: explicit config title wins (as in build.mjs); else parse \title{}
// from the master, cleaned of TeX; else a neutral fallback. Computed at boot.
function paperTitle() {
  if (CFG.title) return CFG.title;
  try {
    const m = /\\title\s*\{([^}]*)\}/.exec(fs.readFileSync(path.join(ROOT, CFG.main), 'utf8'));
    if (m) {
      const t = m[1].replace(/\\\\/g, ' ').replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}~]/g, ' ')
        .replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
  } catch { }
  const folder = path.basename(ROOT).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return folder || 'Document review';
}
const GATE_TITLE = HOSTED ? paperTitle() : '';
// minimal password gate, theme-consistent with assets/style.css in both schemes.
// The gate asks for name AND password together: on a phone the sidebar (where
// the handle picker used to live) is a drawer, so a guest who authenticated
// first and picked a handle later had nowhere to pick it — and everything they
// wrote was dropped by `who()`. The handle is NOT a credential (the password
// is); it only names the file the guest writes.
function gatePage(next, bad, handle) {
  const title = escHtml(GATE_TITLE);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root { --bg:#faf7f0; --fg:#2a2419; --muted:#8a7f6d; --card:#ffffff; --line:#e7dfd1;
  --accent:#d97757; --accent-hover:#c05f3f }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1a1712; --fg:#e8dfd1; --muted:#9c917e; --card:#241f18;
    --line:rgba(217,119,87,.24); --accent-hover:#e8896d }
}
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
<h1>${title}</h1>
<p>This review is password-protected.</p>
<label for="g-handle">your name</label>
<input id="g-handle" name="handle" value="${escHtml(handle || '')}" placeholder="e.g. ada" maxlength="40"
  autofocus autocapitalize="none" autocorrect="off" autocomplete="nickname" aria-label="your name">
<p class="hint">names your comments — not a password. Change it later in the sidebar.</p>
<label for="g-pass">password</label>
<input id="g-pass" type="password" name="password" placeholder="password" autocomplete="current-password" aria-label="password">
<input type="hidden" name="next" value="${escHtml(next)}">
<button>enter the review</button>
${bad ? `<div class="err">${escHtml(bad === true ? 'wrong password — try again' : bad)}</div>` : ''}
</form></body></html>`;
}
const safeNext = n => (n && n.startsWith('/') && !n.startsWith('//')) ? n : '/';
const GATE_HEAD = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
// POST /auth: the gate form. Correct password -> signed cookie + redirect to the
// requested page; wrong -> the gate again with a calm error. Rate-limited with
// the shared per-IP POST window (checked before this in the handler).
function authEndpoint(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
  req.on('end', () => {
    const form = new URLSearchParams(body);
    const next = safeNext(form.get('next'));
    const raw = form.get('handle') || '';
    const handle = sanitizeHandle(raw);
    // handle validation happens BEFORE the password check gives nothing away:
    // both failures re-render the same gate. Claiming the owner's handle is
    // refused here as it is in who() — the owner token, not the gate, is what
    // makes someone the owner, so an unclaimable name must be said plainly.
    // the owner password (when configured) outranks everything: whatever name
    // was typed, this login IS the owner — cookie under their real handle plus
    // the ?owner= token hop the client already knows how to bank. Checked
    // before the handle rules so the owner's own handle is not refused.
    if (OWNER_PASSWORD && safeEqual(form.get('password') || '', OWNER_PASSWORD)) {
      const exp = String(Date.now() + AUTH_TTL_MS);
      const mac = crypto.createHmac('sha256', AUTH_SECRET).update(exp).digest('hex');
      const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      res.writeHead(303, {
        'set-cookie': [
          `review_auth=${exp}.${mac}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure}`,
          `review_handle=${encodeURIComponent(HANDLE)}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; Path=/; SameSite=Lax${secure}`,
        ],
        location: `${next}${next.includes('?') ? '&' : '?'}owner=${OWNER_TOKEN}`,
      }).end();
      return;
    }
    if (!handle) {
      res.writeHead(401, GATE_HEAD).end(gatePage(next, 'enter a name so your comments can be saved', raw));
      return;
    }
    if (!safeEqual(form.get('password') || '', PASSWORD)) {
      res.writeHead(401, GATE_HEAD).end(gatePage(next, true, raw));
      return;
    }
    if (handle === HANDLE) {
      res.writeHead(401, GATE_HEAD).end(gatePage(next,
        `“${handle}” is the document owner's name here — please pick another`, ''));
      return;
    }
    const exp = String(Date.now() + AUTH_TTL_MS);
    const mac = crypto.createHmac('sha256', AUTH_SECRET).update(exp).digest('hex');
    // Secure when the browser reached us over https (the tunnel forwards the proto)
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    // review_auth is the credential (HttpOnly). review_handle is a NAME, not a
    // credential: readable by the page so review.js can seed its handle slot,
    // and never trusted by the server for anything but "which file is yours".
    res.writeHead(303, {
      'set-cookie': [
        `review_auth=${exp}.${mac}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure}`,
        `review_handle=${encodeURIComponent(handle)}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; Path=/; SameSite=Lax${secure}`,
      ],
      location: next,
    }).end();
  });
}
// unauthenticated: document/HTML requests get the gate form; everything a
// script fetches (JSON endpoints, SSE, assets) gets plain 401 JSON. No
// WWW-Authenticate header anywhere — that's what popped the browser dialog.
function denied(req, res) {
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
    res.writeHead(401, GATE_HEAD).end(gatePage(safeNext(req.url), false));
    return;
  }
  res.writeHead(401, JSON_HEAD).end('{"ok":false,"error":"auth required"}');
}
// identity: local mode = the machine's git handle; hosted = the handle the
// browser picked once (header), never trusted to be the owner's without the token
const sanitizeHandle = h => String(h || '').toLowerCase().replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const isOwner = req => !HOSTED || isLocalDirect(req)
  || (!!req.headers['x-review-owner'] && safeEqual(req.headers['x-review-owner'], OWNER_TOKEN));
// the x-review-handle header wins (the sidebar picker can change it mid-session);
// the review_handle cookie set by the password gate is the fallback, so a guest
// is identified from their very first request — including on a phone, where the
// sidebar picker sits inside a drawer. Neither is a credential: the password
// cookie is, and the owner's handle still requires the owner token.
function who(req) {
  if (!HOSTED) return HANDLE;
  // localhost IS the owner — unconditionally. Whatever handle the browser
  // believes it has (stale localStorage from gate testing, a drifted cookie),
  // requests on the bare loopback port are the owner's: labeled as them,
  // written to their file. This closes the clone loop server-side instead of
  // trusting every open tab to have picked up the client-side repair.
  if (isLocalDirect(req)) return HANDLE;
  const h = sanitizeHandle(req.headers['x-review-handle'])
    || sanitizeHandle(decodeURIComponent(cookieOf(req, 'review_handle') || ''));
  if (!h) return null;
  if (h === HANDLE && !isOwner(req)) return null; // nobody impersonates the owner's handle
  return h;
}
// rate-limited writes (hosted only): per-IP sliding minute window
const RATE = new Map();
function rateLimited(req) {
  if (!HOSTED) return false;
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const r = RATE.get(ip) || { n: 0, t: now };
  if (now - r.t > 60000) { r.n = 0; r.t = now; }
  r.n++; RATE.set(ip, r);
  return r.n > 40;
}

// one-time migration: single-user decisions-live.json -> users/<handle>.json
const legacy = path.join(STATE, 'decisions-live.json');
if (fs.existsSync(legacy) && !fs.existsSync(userFile(HANDLE))) {
  try {
    const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    fs.writeFileSync(userFile(HANDLE), JSON.stringify(
      { handle: HANDLE, updated: new Date().toISOString(), decisions: old.decisions || {} }, null, 1));
    console.log(`migrated decisions-live.json -> state/users/${HANDLE}.json`);
  } catch { }
}

// For READING ONLY: a broken file reads as the fallback. Anything that writes
// a file back goes through readForWrite() instead, which refuses to treat an
// unreadable file as empty (see readJsonState in apply.mjs).
function readJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
// {ok, value} — value is the fallback when the file is missing; {ok:false,
// error} with a plain sentence when it exists but cannot be read.
function readForWrite(f, fallback, what) {
  const r = readJsonState(f);
  if (r.state === 'ok') return { ok: true, value: r.value ?? fallback };
  if (r.state === 'missing') return { ok: true, value: fallback };
  const error = unreadableMessage(path.relative(ROOT, f), what);
  console.error(`review: ${error} (${(r.error && r.error.message) || r.error})`);
  return { ok: false, error };
}
// the document's configured source files (paper-agnostic: whatever the config lists)
function sourceFiles() {
  return [CFG.main, ...(CFG.sections || []).map(s => s.file), ...[].concat(CFG.bib || []), CFG.abbreviations]
    .filter(Boolean);
}
// repo-root-relative paths of source files with uncommitted changes, for the
// sidebar "Changes" widget (additive /data field; older clients ignore it)
function dirtySources() {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', ...sourceFiles()], { cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })
      .split('\n').filter(Boolean).map(l => l.slice(3).trim()).filter(Boolean);
  } catch { return []; }
}
// every participant's decisions, keyed by handle — the merged view of the
// review, and the thing the Discuss mirror projects from
function allUsers() {
  const users = {};
  for (const f of fs.existsSync(USERS) ? fs.readdirSync(USERS) : []) {
    if (!f.endsWith('.json')) continue;
    const u = readJSON(path.join(USERS, f), null);
    if (u) users[u.handle || f.replace(/\.json$/, '')] = u.decisions || {};
  }
  return users;
}
function mergedData(req) {
  const users = allUsers();
  const owner = isOwner(req);
  const me = who(req);
  // grants: the owner sees the whole table (People panel); a guest sees ONLY
  // their own budget, because the cap is a budget they must be able to read —
  // "4 of 5 agent calls left today", never a silent throttle
  const myGrant = me && grantFor(me);
  // files can change under us (a collaborator's file pulled from git, a bot
  // writing): the card modes are brought in line before they are shown
  syncCardModes();
  return {
    me,
    grants: owner ? readJSON(GRANTS, {}) : undefined,
    grant_usage: owner
      ? (readJSON(GRANT_USE, {}).date === today() ? readJSON(GRANT_USE, {}).counts || {} : {})
      : undefined,
    my_grant: myGrant ? { ...myGrant, used_today: grantUsed(me) } : null,
    // everyone who has ever joined this review (their user file exists) —
    // the People panel's roster, independent of who is online right now
    people: Object.keys(users).sort(),
    presence: presenceList(),
    hosted: HOSTED,
    owner,
    owner_handle: HANDLE, // additive (2026-07): honest guest queue labels
    users,
    // The margin's thread entries: this paper's own bots, plus — when the
    // comments have been unified into a botference companion (discuss.mjs) —
    // whatever was said back over there, in the same shape and under the same
    // comment id, so the page draws them without knowing the difference.
    threads: mergeThreads(readJSON(path.join(STATE, 'threads.json'), {}), discuss.replies()),
    suggestions: readJSON(path.join(REVIEW, 'suggestions.json'), []),
    apply: applyEngine.publicLedger(),
    pending_mentions: owner ? waitingRequests() : undefined,
    // additive fields (2026-07): chat-mode advertisement + out-of-band source dirt;
    // clients guard for their absence, so a pre-field server keeps working
    chat: !!(chat && chat.available),
    source_dirty: dirtySources(),
    // additive (2026-07): model-switcher seed for a late-connecting client —
    // scoped model lists + the current per-agent model. The review SSE stream
    // doesn't replay bridge history, so this is how the picker boots.
    models: chat ? chat.modelState() : null,
  };
}

// --- the unified comment store (opt-in: review.config.json's `discuss`) ---
// Without that block this object is inert in every direction: `enabled` is
// false, `replies()` is an empty map, `mirror()` returns null and no timer is
// ever armed. The silo a paper has always had is what a paper without it
// keeps. See discuss.mjs for the whole argument.
const discuss = createDiscuss({
  reviewDir: REVIEW, cfg: CFG,
  // an answer landing in the companion is news the margin should hear about
  // without a reload, and `state` is the event the page already redraws on
  onChange: () => fire('state'),
});
if (discuss.enabled) {
  console.log(`unified comments: mirroring the margin into ${discuss.companion}`
    + ` (${discuss.from === 'env' ? 'from the environment' : 'from review.config.json'}`
    + `${discuss.base ? `, as ${discuss.base}` : ''})`);
}
// The comments that were already here. Projection used to happen only on the
// way out of `POST /state`, so a paper whose conversation predated the
// unification — every comment already written, nobody typing — projected
// NOTHING, and the owner's drawer said "no comments yet" beside a margin full
// of them. This is the back-fill: one pass over every existing user file,
// idempotent because the companion files by `origin` id and this side keeps a
// digest, so a restart with nothing new re-posts nothing.
//
// It needs a base, and there is no request to take one from at boot — which
// is exactly why `base` has to be able to come from the config or the
// environment. Without one it is a no-op and the first `POST /state` (which
// does have a request) does the work instead.
// slug → the name that page should carry into the companion's pages library.
// The build already wrote them (`BUILD_META.sections` in site/suggestions.js);
// this reads them back rather than asking the owner to say it twice.
function sectionTitles() {
  try {
    const js = fs.readFileSync(path.join(REVIEW, 'site', 'suggestions.js'), 'utf8');
    const m = js.match(/window\.BUILD_META=(\{[\s\S]*?\});?\s*$/);
    const meta = m ? JSON.parse(m[1]) : null;
    // the paper's own name rides along, because a library listing
    // "Introduction" next to "Method" tells nobody which paper they are from
    const paper = String(paperTitle() || '').trim();
    const out = {};
    for (const s of (meta && meta.sections) || []) {
      if (!s || !s.slug) continue;
      const t = String(s.title || s.slug);
      out[s.slug] = paper && t !== paper ? `${t} — ${paper}` : t;
    }
    return out;
  } catch { return null; }
}
let backfilled = false;
function backfill(why) {
  if (!discuss.enabled || backfilled) return;
  if (!discuss.base && !discuss._state().base) return;  // no address to file under yet
  backfilled = true;
  discuss.mirror(allUsers(), { summon: !chat, titles: sectionTitles() })
    .then(r => {
      if (r && r.sent.length) {
        console.log(`unified comments: back-filled ${r.sent.length} page(s) into the companion (${why})`);
        fire('state');
      }
    })
    .catch(() => { backfilled = false; });
}

// --- P4: apply / commit / revert (owner-only) ---
const applyEngine = new ApplyEngine({ reviewDir: REVIEW, cfg: CFG });
// the LaTeX/pandoc build gets a long leash; a hung one is stopped and said so
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
function rebuild() {
  try {
    execFileSync(process.execPath, [path.join(REVIEW, 'build.mjs')], { cwd: REVIEW, stdio: 'pipe', timeout: BUILD_TIMEOUT_MS });
    return null;
  } catch (e) { return execFailure(e, 'the page rebuild', BUILD_TIMEOUT_MS).slice(0, 500); }
}
// every apply/commit/revert is recorded in the chat transcript (skill P4);
// best-effort — the action itself never depends on the bridge being up
function transcriptNote(text) {
  if (chat && chat.available) {
    chat.submit({ mention_id: `apply-${Date.now()}`, target_id: null, author: HANDLE, text: `${text}\nThis is a transcript record of a review-page action — acknowledge in one short line; no action needed.` });
  }
}
// accepted = EVERY participant's accepts, with the owner's explicit decision
// winning any conflict ("I don't need to micromanage her decisions — the
// ledger is there"): a card the owner explicitly accepted or rejected follows
// the owner; otherwise any participant's accept counts. Apply/Commit remain
// owner-only ACTS — this only widens whose accepts they gather up. Per-user
// files are the audit ledger of who decided what.
// `status` carries the decision on bot cards; a HUMAN suggestion occupies
// `status` with its own entry type, so its accept/reject lands in `decision`.
function effectiveDecisions() {
  const decOf = e => (e.status === 'accepted' || e.decision === 'accepted') ? 'accepted'
    : (e.status === 'rejected' || e.decision === 'rejected') ? 'rejected' : null;
  const out = {};
  const ownerSaid = {};
  const own = readJSON(userFile(HANDLE), {}).decisions || {};
  for (const [id, e] of Object.entries(own)) {
    const d = e && decOf(e);
    if (d) { ownerSaid[id] = d; out[id] = d; }
  }
  for (const f of fs.existsSync(USERS) ? fs.readdirSync(USERS) : []) {
    const dec = readJSON(path.join(USERS, f), {}).decisions || {};
    for (const [id, e] of Object.entries(dec)) {
      if (ownerSaid[id] || !e) continue; // the owner's explicit call always wins
      const d = decOf(e);
      if (d === 'accepted') out[id] = 'accepted';
      else if (d === 'rejected' && !out[id]) out[id] = 'rejected';
    }
  }
  return out;
}
// Each suggestion card has ONE mode, kept in state/apply.json (see
// assets/card-modes.js). People's accept/reject live in their own files —
// the record of who decided what — and this folds them into the card modes.
// A move the table refuses (rejecting an edit already in the source) is left
// alone and logged once; Commit re-checks the decisions anyway.
const refusedOnce = new Set();
function syncCardModes() {
  let r;
  try { r = applyEngine.syncDecisions(effectiveDecisions()); }
  catch (e) { console.error(`review: could not update the card record: ${(e && e.stack) || e}`); return { ok: false, reason: 'the card record could not be saved' }; }
  for (const x of (r && r.refused) || []) {
    if (refusedOnce.has(x.id)) continue;
    refusedOnce.add(x.id);
    console.error(`review: ${x.reason}`);
  }
  return r;
}

// collaborator mentions in hosted mode queue here until the owner releases them
const PENDING = path.join(STATE, 'pending-mentions.json');
// per-handle agent grants (owner-written) + the daily budget ledger those caps
// are measured against. The ledger is a BUDGET counter, not an attendance log:
// it holds a date and a count per handle and nothing else.
const GRANTS = path.join(STATE, 'grants.json');
const GRANT_USE = path.join(STATE, 'grant-usage.json');
const DEFAULT_CAP = 5;
const today = () => new Date().toISOString().slice(0, 10);
function grantFor(handle) {
  const g = readJSON(GRANTS, {})[handle];
  return g && g.agents ? { agents: true, daily_cap: Number(g.daily_cap) || DEFAULT_CAP } : null;
}
function grantUsed(handle) {
  const u = readJSON(GRANT_USE, {});
  return u.date === today() ? (u.counts || {})[handle] || 0 : 0;
}
// null when the usage record cannot be read: nothing is spent and the
// request goes to the owner's queue instead of being let through uncounted
function grantSpend(handle) {
  const r = readForWrite(GRANT_USE, {}, 'The daily agent-use record');
  if (!r.ok) return null;
  let u = r.value && typeof r.value === 'object' ? r.value : {};
  if (u.date !== today()) u = { date: today(), counts: {} };
  u.counts = u.counts || {};
  u.counts[handle] = (u.counts[handle] || 0) + 1;
  writeJsonAtomic(GRANT_USE, u);
  return u.counts[handle];
}
// --- requests waiting for the owner -----------------------------------------
// A collaborator's @-mention that needs the owner's say-so waits in
// state/pending-mentions.json. Each request is in one of:
const REQUEST_STATES = Object.freeze(['waiting', 'released', 'refused']);
//   waiting   — in the file, shown to the owner with a Release button
//   released  — the agents accepted it; it leaves the file
//   refused   — the agents already had it (a duplicate); it leaves the file
// A request leaves `waiting` only on the agents' answer, so a release while
// the agents are not running keeps every request where it was.
const requestState = m => (REQUEST_STATES.includes(m && m.state) ? m.state : 'waiting');
function waitingRequests() {
  const r = readJsonState(PENDING);
  return r.state === 'ok' && Array.isArray(r.value) ? r.value.filter(m => requestState(m) === 'waiting') : [];
}
// add one request to the queue; {ok:false, error} when the file is unreadable
function queueRequest(m) {
  const r = readForWrite(PENDING, [], 'The list of requests waiting for the owner');
  if (!r.ok) return r;
  const list = Array.isArray(r.value) ? r.value : [];
  if (list.find(x => x.mention_id === m.mention_id)) return { ok: true, added: false };
  list.push({ ...m, state: 'waiting' });
  writeJsonAtomic(PENDING, list);
  return { ok: true, added: true };
}
// the owner's Release: each waiting request is offered to the agents; only
// the ones they take leave the file
function releaseRequests() {
  const r = readForWrite(PENDING, [], 'The list of requests waiting for the owner');
  if (!r.ok) return { ok: false, error: r.error };
  const list = Array.isArray(r.value) ? r.value : [];
  const results = [];
  const keep = [];
  for (const m of list) {
    if (requestState(m) !== 'waiting') continue;
    const sub = chat ? chat.submit(m) : { queued: false, reason: 'the agents are not running — restart the review with --chat' };
    const state = sub && sub.queued ? 'released' : (sub && sub.reason === 'duplicate' ? 'refused' : 'waiting');
    results.push({ mention_id: m.mention_id, author: m.author, state, reason: (sub && sub.reason) || '' });
    if (state === 'waiting') keep.push({ ...m, state, last_error: (sub && sub.reason) || '' });
  }
  writeJsonAtomic(PENDING, keep);
  const count = st => results.filter(x => x.state === st).length;
  return { ok: true, released: count('released'), refused: count('refused'), waiting: count('waiting'), results };
}

// --- presence (item 5) --------------------------------------------------
// In-memory ONLY. Never written to disk — there is no attendance log, by
// design. Symmetric (everyone sees everyone at the same granularity) and
// coarse (state + section; no keystroke, dwell or duration is recorded).
// Desktop clients beat every ~15s; mobile clients never beat and simply do
// not appear. A handle with no beat for OFFLINE_MS is dropped entirely.
const OFFLINE_MS = 45000;
const PRESENT = new Map(); // handle -> {state, section, section_title, focused_id, owner, ts}
let presenceTimer = null;
function presenceList() {
  const now = Date.now();
  const out = [];
  for (const [handle, p] of PRESENT) {
    if (now - p.ts > OFFLINE_MS) { PRESENT.delete(handle); continue; }
    out.push({ handle, state: p.state, section: p.section, section_title: p.section_title, owner: p.owner });
  }
  return out.sort((a, b) => a.handle.localeCompare(b.handle));
}
function firePresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => pushAll({ type: 'presence', people: presenceList() }), 250);
}
function beat(handle, d, owner) {
  const state = d.state === 'active' ? 'active' : 'idle';
  PRESENT.set(handle, {
    state, owner: !!owner, ts: Date.now(),
    section: String(d.section || '').slice(0, 80),
    section_title: String(d.section_title || '').slice(0, 80),
    focused_id: String(d.focused_id || '').slice(0, 120),
  });
  firePresence();
}
// sweep offline handles even when nobody is beating, so the cluster empties
setInterval(() => { const n = PRESENT.size; presenceList(); if (PRESENT.size !== n) firePresence(); }, 15000).unref();

// --- usage / settings panel (item 8) ------------------------------------
// Honest by construction. Three tiers, each labeled for what it is:
//  · occupancy   — live, exact: the bridge's own status snapshot.
//  · session     — real turn counts and prompt-occupancy tokens per agent and
//                  per handle; the cost figure is an ESTIMATE (see chat.mjs).
//  · rollup      — real billed cost, but only for runs recorded in botference's
//                  usage log; absent when this machine has none.
// There is deliberately NO subscription-quota meter: neither provider exposes
// Pro/Max or ChatGPT plan quota to anything but their interactive CLIs.
function usageRollup() {
  const log = process.env.BOTFERENCE_USAGE_LOG ||
    (process.env.BOTFERENCE_HOME ? path.join(process.env.BOTFERENCE_HOME, 'logs', 'usage.jsonl') : null);
  if (!log || !fs.existsSync(log)) return null;
  const dayMs = 86400000;
  const now = Date.now();
  // `unpriced`: runs whose cost_usd is null (price not known) — counted as
  // runs but not added to the dollar total, and shown as such
  const acc = { today: { cost: 0, runs: 0, unpriced: 0 }, week: { cost: 0, runs: 0, unpriced: 0 }, source: path.basename(log) };
  let text = '';
  try { text = fs.readFileSync(log, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.timestamp || '');
    if (!t || e.error) continue;
    const priced = typeof e.cost_usd === 'number' && Number.isFinite(e.cost_usd);
    const c = priced ? e.cost_usd : 0;
    if (now - t < dayMs) { acc.today.cost += c; acc.today.runs++; if (!priced) acc.today.unpriced++; }
    if (now - t < 7 * dayMs) { acc.week.cost += c; acc.week.runs++; if (!priced) acc.week.unpriced++; }
  }
  acc.today.cost = Math.round(acc.today.cost * 1e4) / 1e4;
  acc.week.cost = Math.round(acc.week.cost * 1e4) / 1e4;
  return acc;
}
function usageReport() {
  return {
    chat: !!(chat && chat.available),
    models: chat ? chat.modelState() : null,
    session: chat ? chat.usageState() : null,
    rollup: usageRollup(),
    // stated, not measured: no provider API reports subscription-plan quota
    quota_note: 'Weekly subscription quota — not exposed by either provider. Run /usage in Claude Code.',
  };
}
// the synthetic thread id document-level task-console turns are anchored to,
// so their streams land in the console instead of an (absent) margin card
const CONSOLE_ID = '__console__';

// section a card lives on, for human-readable notification text
function cardSection(id) {
  const sc = readJSON(path.join(REVIEW, 'suggestions.json'), []).find(c => c.id === id);
  if (sc && sc.section) return sc.section;
  for (const f of fs.existsSync(USERS) ? fs.readdirSync(USERS) : []) {
    const v = (readJSON(path.join(USERS, f), {}).decisions || {})[id];
    if (v && v.section) return v.section;
  }
  return id || 'the review';
}
// owner nudge: a guest summons entered the pending queue. macOS only (osascript);
// best-effort — a missing/failing osascript must never crash the server.
function notifyOwner(text) {
  if (process.platform !== 'darwin') return;
  try {
    const safe = String(text).slice(0, 200).replace(/[\\"]/g, ' ');
    execFile('osascript', ['-e', `display notification "${safe}" with title "botference review"`], () => { });
  } catch { }
}

// server-side edited:true stamping — the user file is what bots read, so the
// stamps live here, not in the browser. Comments: ts refresh + edited on text
// change. Thread entries: ts is the entry's identity between browser and file,
// so edits keep ts and gain {edited, edited_ts} instead. A change within 2min
// of the entry's ts is the same composition session, not an edit.
const GRACE = 120000;
function stampEdits(prev, next) {
  const now = new Date().toISOString();
  for (const [id, v] of Object.entries(next)) {
    const p = prev[id];
    if (!p) { v.ts = now; continue; }
    v.ts = p.ts || now;
    if (p.edited) v.edited = true;
    const textChanged = (v.comment ?? '') !== (p.comment ?? '');
    if (textChanged || (v.status ?? '') !== (p.status ?? '') || !!v.resolved !== !!p.resolved) {
      const composing = p.ts && Date.now() - Date.parse(p.ts) < GRACE && !p.edited;
      v.ts = now;
      if (textChanged && !composing) v.edited = true;
    }
    const pth = new Map((p.thread || []).map(t => [t.ts, t]));
    for (const t of v.thread || []) {
      const pt = pth.get(t.ts);
      if (!pt) continue;
      if (pt.edited) { t.edited = true; t.edited_ts = pt.edited_ts; }
      if (pt.text !== t.text && Date.now() - Date.parse(t.ts) >= GRACE) {
        t.edited = true; t.edited_ts = now;
      }
    }
  }
  return next;
}

// --- SSE ---
const clients = new Set();
let pingTimer = null;
// SSE through proxies/CDN edges (the --share cloudflared tunnel included):
// flush headers at once, disable Nagle, and pad the first chunk past typical
// edge buffering thresholds with an SSE comment (EventSource ignores comment
// lines) — otherwise the edge holds the response and the browser sees zero
// events (the "sidebar stuck at loading through the tunnel" failure).
const SSE_HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS) || 15000;
const SSE_PAD = ':' + ' '.repeat(2048) + '\n\n';
function sseOpen(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
  res.write(SSE_PAD);
}
const wsClients = new Set(); // WebSocket connections (primary through tunnels)
// every live event goes to both transports; WS clients get the bare JSON
function pushAll(obj) {
  const json = JSON.stringify(obj);
  for (const res of clients) res.write(`data: ${json}\n\n`);
  for (const ws of wsClients) ws.send(json);
}
function broadcast(type) { pushAll({ type }); }
// The Discuss reply poll runs only while somebody is connected: a review page
// nobody has open is a review page with nothing to refresh, and the companion
// should not be asked about it every five seconds forever.
function watchersChanged() {
  const n = clients.size + wsClients.size;
  // a reader arriving is the second chance at the back-fill: at boot the
  // companion may simply not have been up yet, and this costs one no-op pass
  // (the digest suppresses the posts) when it already ran.
  if (n) backfill('a reader connected');
  discuss.watch(n);
}
// heartbeat: keeps tunnel/proxy connections warm and lets dead clients
// surface — an SSE comment (EventSource ignores it) and a WS ping event
function ensureHeartbeat() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
    for (const ws of wsClients) ws.send('{"type":"ping"}');
  }, SSE_HEARTBEAT_MS).unref();
}
let debounce = {};
function fire(type) {
  clearTimeout(debounce[type]);
  debounce[type] = setTimeout(() => broadcast(type), 250);
}
// mtime signature of a file, or of a dir + its direct children
function signature(target) {
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return String(st.mtimeMs);
    let sig = String(st.mtimeMs);
    for (const f of fs.readdirSync(target)) {
      try { sig += ':' + f + '=' + fs.statSync(path.join(target, f)).mtimeMs; } catch { }
    }
    return sig;
  } catch { return 'missing'; }
}
const polled = [];
function watch(target, type) {
  if (!fs.existsSync(target)) return;
  const fallBack = why => {
    console.error(`watch ${path.relative(REVIEW, target)}: ${why} — falling back to 2s polling`);
    if (!polled.find(p => p.target === target)) polled.push({ target, type, sig: signature(target) });
  };
  try {
    const w = fs.watch(target, () => fire(type));
    w.on('error', e => { try { w.close(); } catch { } fallBack(e.code || e.message); });
  } catch (e) { fallBack(e.code || e.message); }
}
function startWatchers() {
  // bounded, non-recursive set — recursive watch exhausts fds (EMFILE) on macOS;
  // any watcher that still fails degrades to the shared 2s mtime poll below
  watch(STATE, 'state');
  watch(USERS, 'state');
  watch(path.join(REVIEW, 'suggestions.json'), 'state');
  watch(SITE, 'site');
  watch(path.join(SITE, 'assets'), 'site');
  setInterval(() => {
    for (const p of polled) {
      const sig = signature(p.target);
      if (sig !== p.sig) { p.sig = sig; fire(p.type); }
    }
  }, 2000).unref();
}

// --- P3: --chat spawns the botference bridge; browser mentions become turns ---
let chat = null;
async function startChat() {
  const { BridgeChat } = await import('./chat.mjs');
  chat = new BridgeChat({
    reviewDir: REVIEW, cfg: CFG,
    onEvent: obj => pushAll({ type: 'chat', ...obj }),
  });
  chat.start();
  console.log('chat mode: bridge spawned; @claude/@codex/@all comments become turns');
}
function chatEndpoint(req, res, url) {
  if (!chat) { res.writeHead(409, JSON_HEAD).end('{"ok":false,"error":"server not started with --chat"}'); return true; }
  const owner = isOwner(req);
  // hosted: permissions/choices/free chat are owner-only; non-owner mentions queue below
  if (!owner && url !== '/mention') {
    res.writeHead(403, JSON_HEAD).end('{"ok":false,"error":"owner only"}');
    return true;
  }
  let body = '';
  req.on('data', c => { body += c; if (body.length > (CFG.bridge?.mention_max_chars || 4000) * 4) req.destroy(); });
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      if ((data.text || '').length > (CFG.bridge?.mention_max_chars || 4000)) throw new Error('too long');
      // an answer to a question that is no longer open (timed out, withdrawn,
      // already answered) is refused, in plain words, rather than sent on
      if (url === '/permission') { res.writeHead(200, JSON_HEAD).end(JSON.stringify(chat.answerPermission(data))); return; }
      if (url === '/choice') { res.writeHead(200, JSON_HEAD).end(JSON.stringify(chat.answerChoice(data))); return; }
      if (url === '/model') {
        // owner-only (gated above): a model switch is a control turn, not a
        // mention. Strictly validate the shape so only /model @agent <model>
        // ever reaches the bridge stdin.
        if (!/^\/model @(claude|codex) [\w.-]+$/.test(String(data.text || '').trim())) {
          res.writeHead(400, JSON_HEAD).end('{"ok":false,"error":"bad model command"}'); return;
        }
        res.writeHead(200, JSON_HEAD).end(JSON.stringify(chat.control(String(data.text).trim())));
        return;
      }
      if (url === '/mention') {
        if (!/@(claude|codex|all)\b/i.test(data.text || '')) {
          res.writeHead(200, JSON_HEAD).end('{"queued":false,"reason":"no @claude/@codex/@all tag"}'); return;
        }
        const known = new Set(readJSON(path.join(REVIEW, 'suggestions.json'), []).map(c => c.id));
        for (const f of fs.existsSync(USERS) ? fs.readdirSync(USERS) : []) {
          for (const id of Object.keys(readJSON(path.join(USERS, f), {}).decisions || {})) known.add(id);
        }
        if (!data.target_id || !known.has(data.target_id)) {
          res.writeHead(200, JSON_HEAD).end('{"queued":false,"reason":"unknown target"}'); return;
        }
        if (!owner) {
          // Three tiers (item 7): owner → straight through; a GRANTED handle
          // within its daily cap → straight through, one budget unit spent;
          // everyone else (and anyone over cap) → the owner's release queue.
          // Revocation and cap changes are read here, so they take effect on
          // the very next request.
          const m = { mention_id: data.mention_id, target_id: data.target_id, author: who(req) || 'collaborator', text: data.text };
          const grant = m.author && grantFor(m.author);
          if (grant) {
            const used = grantUsed(m.author);
            const spent = used < grant.daily_cap ? grantSpend(m.author) : null;
            if (spent != null) {
              const left = grant.daily_cap - spent;
              const r = chat.submit(m);
              res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ...r, granted: true, calls_left: left, daily_cap: grant.daily_cap }));
              return;
            }
            // over cap (or the usage record is unreadable): honest message,
            // and the turn still reaches the owner
            const q = queueRequest(m);
            if (!q.ok) { res.writeHead(200, JSON_HEAD).end(JSON.stringify({ queued: false, reason: q.error })); return; }
            if (q.added) notifyOwner(`review: ${m.author} hit their daily agent cap on ${cardSection(m.target_id)}`);
            res.writeHead(200, JSON_HEAD).end(JSON.stringify({ queued: false, pending: true, capped: true,
              calls_left: 0, daily_cap: grant.daily_cap,
              reason: `daily cap reached (${grant.daily_cap}/${grant.daily_cap}) — queued for the owner to release` }));
            return;
          }
          const q = queueRequest(m);
          if (!q.ok) { res.writeHead(200, JSON_HEAD).end(JSON.stringify({ queued: false, reason: q.error })); return; }
          if (q.added) notifyOwner(`review: ${m.author} requested agents on ${cardSection(m.target_id)}`);
          res.writeHead(200, JSON_HEAD).end('{"queued":false,"pending":true,"reason":"queued for the owner to release"}');
          return;
        }
      }
      const r = chat.submit({ mention_id: data.mention_id, target_id: data.target_id, author: who(req) || HANDLE, text: data.text });
      res.writeHead(200, JSON_HEAD).end(JSON.stringify(r));
    } catch { res.writeHead(400, JSON_HEAD).end('{"ok":false}'); }
  });
  return true;
}

function isInside(file, base) {
  const rel = path.relative(base, file);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
const JSON_HEAD = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export function handler(req, res) {
  const url = req.url.split('?')[0];
  // rate limit first: it must also cover unauthenticated /auth attempts
  if (req.method === 'POST' && rateLimited(req)) {
    res.writeHead(429, JSON_HEAD).end('{"ok":false,"error":"rate limited — slow down"}');
    return;
  }
  if (HOSTED && req.method === 'POST' && url === '/auth') {
    authEndpoint(req, res);
    return;
  }
  if (!authorized(req)) {
    denied(req, res);
    return;
  }
  if (req.method === 'GET' && url === '/whoami') {
    res.writeHead(200, JSON_HEAD).end(JSON.stringify({ handle: who(req), slug: CFG.slug, hosted: HOSTED, owner: isOwner(req) }));
    return;
  }
  // read-only view of a CONFIGURED source file, so the browser can resolve a
  // human suggestion to a UNIQUE span at COMPOSE time (and say what it locked
  // onto) instead of discovering the ambiguity at apply time. Strictly limited
  // to the files review.config.json lists, plus the config itself when the
  // masthead title lives in it.
  if (req.method === 'GET' && url === '/source') {
    const want = new URLSearchParams(req.url.split('?')[1] || '').get('file') || '';
    const allowed = new Set([...sourceFiles(), 'review/review.config.json']);
    if (!allowed.has(want)) { res.writeHead(404, JSON_HEAD).end('{"ok":false,"error":"not a configured source file"}'); return; }
    const f = path.resolve(ROOT, want);
    if (!isInside(f, ROOT)) { res.writeHead(403, JSON_HEAD).end('{"ok":false}'); return; }
    fs.readFile(f, 'utf8', (err, text) => {
      if (err) { res.writeHead(404, JSON_HEAD).end('{"ok":false,"error":"not found"}'); return; }
      // a notebook's text stand-in: the same projection apply.mjs edits
      if (want.endsWith('.ipynb')) {
        try { text = projectNotebook(JSON.parse(text)).text; }
        catch { res.writeHead(422, JSON_HEAD).end('{"ok":false,"error":"not valid notebook JSON"}'); return; }
      }
      res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, file: want, text }));
    });
    return;
  }
  if (req.method === 'GET' && url === '/data') {
    res.writeHead(200, JSON_HEAD).end(JSON.stringify(mergedData(req)));
    return;
  }
  if (req.method === 'GET' && url === '/events') {
    sseOpen(res);
    res.write('data: {"type":"hello"}\n\n');
    clients.add(res);
    req.on('close', () => { clients.delete(res); watchersChanged(); });
    watchersChanged();
    ensureHeartbeat();
    return;
  }
  // legacy single-user endpoint: serve own user file so old clients keep working
  if (req.method === 'GET' && url === '/state') {
    res.writeHead(200, JSON_HEAD).end(JSON.stringify(readJSON(userFile(HANDLE), {})));
    return;
  }
  if (req.method === 'POST' && (url === '/mention' || url === '/chatbox' || url === '/permission' || url === '/choice' || url === '/model')) {
    chatEndpoint(req, res, url);
    return;
  }
  if (req.method === 'POST' && url === '/state') {
    const handle = who(req);
    if (!handle) { res.writeHead(400, JSON_HEAD).end('{"ok":false,"error":"pick a handle first"}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // the browser only ever writes the server-identified caller's own file
        const file = userFile(handle);
        const cur = readForWrite(file, {}, 'Your saved comments file');
        if (!cur.ok) { res.writeHead(409, JSON_HEAD).end(JSON.stringify({ ok: false, error: cur.error })); return; }
        const prev = (cur.value && cur.value.decisions) || {};
        writeJsonAtomic(file,
          { handle, updated: new Date().toISOString(), decisions: stampEdits(prev, data.decisions || {}), build: data.build || null });
        syncCardModes();
        res.writeHead(200, JSON_HEAD).end('{"ok":true}');
        // …and, when the comments are unified, on into the companion's store.
        // AFTER the response, deliberately: the visitor's comment is saved the
        // moment it is saved here, and a companion that is asleep, slow or
        // simply not running must never be something they have to wait for.
        // `summon` only when this paper has no bridge of its own — otherwise
        // the same @claude would be answered twice, once on each surface.
        discuss.mirror(allUsers(), { base: baseOf(req), summon: !chat, titles: sectionTitles() })
          .then(r => { if (r && r.sent.length) fire('state'); })
          .catch(() => { });
      } catch { res.writeHead(400, JSON_HEAD).end('{"ok":false}'); }
    });
    return;
  }
  // --- presence (item 5): coarse, in-memory, symmetric. See PRESENCE below. ---
  if (req.method === 'POST' && url === '/beat') {
    const handle = who(req);
    if (!handle) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"error":"no handle"}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      try { beat(handle, JSON.parse(body || '{}'), isOwner(req)); } catch { }
      res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, people: presenceList() }));
    });
    return;
  }
  // --- per-handle agent grants (item 7): owner-written, read by /mention ---
  if (req.method === 'POST' && url === '/grants') {
    if (!isOwner(req)) { res.writeHead(403, JSON_HEAD).end('{"ok":false,"error":"owner only"}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const d = JSON.parse(body || '{}');
        const h = sanitizeHandle(d.handle);
        if (!h || h === HANDLE) { res.writeHead(400, JSON_HEAD).end('{"ok":false,"error":"bad handle"}'); return; }
        const gr = readForWrite(GRANTS, {}, 'The list of agent permissions');
        if (!gr.ok) { res.writeHead(409, JSON_HEAD).end(JSON.stringify({ ok: false, error: gr.error })); return; }
        const g = gr.value && typeof gr.value === 'object' ? gr.value : {};
        if (d.agents) {
          const cap = Math.max(0, Math.min(500, Math.floor(Number(d.daily_cap)) || 0)) || DEFAULT_CAP;
          g[h] = { agents: true, daily_cap: cap };
        } else delete g[h];
        writeJsonAtomic(GRANTS, g);
        res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, grants: g }));
      } catch { res.writeHead(400, JSON_HEAD).end('{"ok":false}'); }
    });
    return;
  }
  // --- settings panel data (item 8, owner-only): occupancy + honest usage ---
  if (req.method === 'GET' && url === '/usage') {
    if (!isOwner(req)) { res.writeHead(403, JSON_HEAD).end('{"ok":false,"error":"owner only"}'); return; }
    res.writeHead(200, JSON_HEAD).end(JSON.stringify(usageReport()));
    return;
  }
  // --- task console (item 6, owner-only): document-level instructions with no
  // anchor text. Same strict routing as a comment mention: nothing reaches an
  // agent without @claude/@codex/@all. ---
  if (req.method === 'POST' && url === '/task') {
    if (!isOwner(req)) { res.writeHead(403, JSON_HEAD).end('{"ok":false,"error":"owner only"}'); return; }
    if (!chat) { res.writeHead(409, JSON_HEAD).end('{"ok":false,"error":"server not started with --chat"}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > (CFG.bridge?.mention_max_chars || 4000) * 4) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const text = String(data.text || '');
        if (text.length > (CFG.bridge?.mention_max_chars || 4000)) throw new Error('too long');
        if (!/@(claude|codex|all)\b/i.test(text)) {
          res.writeHead(200, JSON_HEAD).end('{"queued":false,"reason":"no @claude/@codex/@all tag"}'); return;
        }
        const r = chat.submit({ mention_id: data.mention_id, target_id: CONSOLE_ID, doc_task: true,
          author: who(req) || HANDLE, text });
        res.writeHead(200, JSON_HEAD).end(JSON.stringify(r));
      } catch { res.writeHead(400, JSON_HEAD).end('{"ok":false}'); }
    });
    return;
  }
  // Anyone in the review may resolve or reopen ANY comment (GDocs parity —
  // "she fixed it, she closes it"), attributed. Server-mediated so the
  // author's file stays the single writer boundary; rate-limited like all
  // hosted writes; the owner can always reopen.
  if (req.method === 'POST' && url === '/thread-state') { // (per-IP POST rate limit already applied above)
    const actor = who(req);
    if (!actor) { res.writeHead(400, JSON_HEAD).end('{"ok":false,"error":"pick a handle first"}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const h = sanitizeHandle(data.handle);
        const f = h && userFile(h);
        const u = f && readJSON(f, null);
        if (!u || !u.decisions || !u.decisions[data.id]) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"reason":"unknown comment"}'); return; }
        // resolved_by = who last changed the state (either direction) — it's
        // the attribution AND the client's merge signal for adopting a
        // third-party change into the author's own local store
        u.decisions[data.id].resolved = !!data.resolved;
        u.decisions[data.id].resolved_by = actor;
        u.decisions[data.id].resolved_ts = new Date().toISOString();
        u.updated = new Date().toISOString();
        writeJsonAtomic(f, u);
        broadcast('state');
        res.writeHead(200, JSON_HEAD).end('{"ok":true}');
      } catch { res.writeHead(400, JSON_HEAD).end('{"ok":false}'); }
    });
    return;
  }
  // --- P4 (owner-only): apply / commit / revert; acceptance enforced here ---
  if (req.method === 'POST' && (url === '/apply' || url === '/commit' || url === '/revert' || url === '/release' || url === '/reopen')) {
    if (!isOwner(req)) { res.writeHead(403, JSON_HEAD).end('{"ok":false,"error":"owner only"}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        if (url === '/apply') {
          const synced = syncCardModes();
          if (synced && synced.ok === false) { res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: false, error: synced.reason, apply: applyEngine.publicLedger() })); return; }
          // applyable = accepted, or accepted-but-flagged (a retry), by the card's one mode
          const cards = applyEngine.publicLedger().cards;
          const ready = new Set(Object.keys(cards).filter(id => cards[id].mode === 'accepted' || cards[id].mode === 'flagged'));
          const asked = data.all_accepted ? [...ready] : [].concat(data.ids || []);
          const wanted = asked.filter(id => ready.has(id));
          // anything asked for that is not ready is reported back, never silently dropped
          const notReady = asked.filter(id => !ready.has(id)).map(id => ({ id,
            reason: cards[id] ? `it is ${cards[id].mode}, not accepted` : 'it has not been accepted' }));
          if (!wanted.length) { res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: false, error: 'no accepted cards to apply', skipped: notReady, apply: applyEngine.publicLedger() })); return; }
          const r = applyEngine.apply(wanted);
          r.skipped = [...r.skipped, ...notReady];
          const buildErr = r.applied.length ? rebuild() : null;
          transcriptNote(`[apply] applied=${r.applied.join(',') || 'none'} flagged=${r.flagged.map(f => f.id).join(',') || 'none'}${buildErr ? ' BUILD-ERROR' : ''}`);
          res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, ...r, build_error: buildErr, apply: applyEngine.publicLedger() }));
          return;
        }
        if (url === '/commit' && Array.isArray(data.files) && data.files.length) {
          // additive: out-of-band commit of already-edited source files (the
          // sidebar Changes widget's "changes outside rounds" action)
          const allowed = new Set(sourceFiles());
          const files = data.files.filter(f => allowed.has(f));
          if (!files.length) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"reason":"no committable source files"}'); return; }
          try { execFileSync('git', ['commit', '-m', 'Out-of-band source edits (committed from review site)', '--', ...files], { cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }); }
          catch (e) { res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: false, reason: execFailure(e, 'git commit', GIT_TIMEOUT_MS) })); return; }
          let sha = '';
          try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim(); } catch { }
          transcriptNote(`[commit] out-of-band ${sha}: ${files.join(', ')}`);
          res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, sha, files, apply: applyEngine.publicLedger() }));
          return;
        }
        if (url === '/commit') {
          syncCardModes();
          const r = applyEngine.commit({ decisions: effectiveDecisions() });
          if (r.ok) transcriptNote(`[commit] ${r.sha}: ${r.ids.join(', ')}`);
          res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ...r, apply: applyEngine.publicLedger() }));
          return;
        }
        if (url === '/reopen') {
          // additive: owner reopens any author's resolved comment. The author's
          // file stays the single source of truth — this flips resolved only.
          const h = sanitizeHandle(data.handle);
          const f = h && userFile(h);
          const u = f && readJSON(f, null);
          if (!u || !u.decisions || !u.decisions[data.id]) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"reason":"unknown comment"}'); return; }
          u.decisions[data.id].resolved = false;
          u.updated = new Date().toISOString();
          writeJsonAtomic(f, u);
          res.writeHead(200, JSON_HEAD).end('{"ok":true}');
          return;
        }
        if (url === '/revert') {
          const r = applyEngine.revert();
          if (r.ok) syncCardModes();   // a card rejected while applied can now be rejected
          const buildErr = r.ok ? rebuild() : null;
          if (r.ok) transcriptNote(`[revert] round dropped: ${r.ids.join(', ')}`);
          res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ...r, build_error: buildErr, apply: applyEngine.publicLedger() }));
          return;
        }
        // /release: owner offers the waiting collaborator requests to the agents
        const rel = releaseRequests();
        res.writeHead(200, JSON_HEAD).end(JSON.stringify(rel.ok ? rel : { ok: false, error: rel.error }));
      } catch (e) { res.writeHead(400, JSON_HEAD).end(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) })); }
    });
    return;
  }
  const p = url === '/' ? '/index.html' : decodeURIComponent(url);
  const figDir = FIG_DIRS.find(d => p.includes(`/${d}/`));
  const figBase = figDir && path.resolve(ROOT, figDir);
  const file = figDir
    ? path.resolve(figBase, p.split(`/${figDir}/`)[1])
    : path.resolve(SITE, p.replace(/^\/+/, ''));
  if (!isInside(file, figDir ? figBase : SITE)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(buf);
  });
}

if (process.env.REVIEW_NO_LISTEN !== '1') {
  // one bad request or a broken pipe to the bot process must not take the
  // whole review down with no word: log the full stack, keep serving
  process.on('uncaughtException', e => {
    console.error(`review server: unexpected error, still serving:\n${(e && e.stack) || e}`);
  });
  process.on('unhandledRejection', e => {
    console.error(`review server: unexpected error in the background, still serving:\n${(e && e.stack) || e}`);
  });
  syncCardModes();
  startWatchers();
  const server = http.createServer(handler);
  // WS is the browser's primary live-event transport (SSE is the fallback):
  // same auth gate as every request, same hello as /events
  attachWs(server, {
    path: '/ws',
    authorize: authorized,
    onOpen(ws) {
      ws.send('{"type":"hello"}');
      wsClients.add(ws);
      watchersChanged();
      ws.onclose = () => { wsClients.delete(ws); watchersChanged(); };
      ensureHeartbeat();
    },
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Review live at http://localhost:${PORT} — you are "${HANDLE}"; state in review/state/users/`);
    backfill('server start');
    if (HOSTED) {
      console.log(`hosted mode: share the URL + password. Tunnel it with:\n  cloudflared tunnel --url http://localhost:${PORT}`);
      console.log(`owner access (keep private): http://localhost:${PORT}/?owner=${OWNER_TOKEN}`);
    }
  });
  if (process.argv.includes('--chat')) startChat().catch(e => console.error('chat mode failed:', e.message));
}
