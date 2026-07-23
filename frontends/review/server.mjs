#!/usr/bin/env node
// Generic live review server: serves site/, per-user state mirroring, merged /data, SSE /events.
// Run:  node review/server.mjs   then open http://localhost:<port from review.config.json>
// Flags: --chat (spawn the bot bridge)  --hosted (shared-URL mode: REVIEW_PASSWORD
// basic auth, per-browser handle picker, rate-limited writes, owner-gated bots/apply)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { ApplyEngine } from './apply.mjs';
import { attachWs } from './ws.mjs';

const REVIEW = path.dirname(new URL(import.meta.url).pathname);
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
  try { return execFileSync('git', ['config', key], { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
const HANDLE = gitConfig('github.user') ||
  (gitConfig('user.name') || 'anonymous').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const userFile = h => path.join(USERS, h.replace(/[^\w-]/g, '_') + '.json');

// --- hosted mode: shared password + per-browser handles + owner token ---
const HOSTED = process.argv.includes('--hosted');
const PASSWORD = process.env.REVIEW_PASSWORD || '';
if (HOSTED && !PASSWORD) {
  console.error('--hosted requires REVIEW_PASSWORD to be set, e.g.  REVIEW_PASSWORD=… node review/server.mjs --hosted');
  process.exit(1);
}
// the owner token gates bot summons and apply/commit/revert on a shared URL;
// runtime file (gitignored), stable across restarts so the owner's browser stays owner
const tokenFile = path.join(STATE, '.owner-token');
let OWNER_TOKEN = '';
if (HOSTED) {
  try { OWNER_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { }
  if (!OWNER_TOKEN) { OWNER_TOKEN = crypto.randomBytes(12).toString('hex'); fs.writeFileSync(tokenFile, OWNER_TOKEN); }
}
// hosted auth cookie: HMAC-signed expiry, keyed by a per-deployment secret
// (runtime file, gitignored) — stateless to validate, survives server restarts
const AUTH_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const secretFile = path.join(STATE, '.auth-secret');
let AUTH_SECRET = '';
if (HOSTED) {
  try { AUTH_SECRET = fs.readFileSync(secretFile, 'utf8').trim(); } catch { }
  if (!AUTH_SECRET) { AUTH_SECRET = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(secretFile, AUTH_SECRET); }
}
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
// browsers authenticate through the /auth password gate (cookie below); curl
// and other tools may keep sending Authorization: Basic with ANY username
function authorized(req) {
  if (!HOSTED) return true;
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
const isOwner = req => !HOSTED || (!!req.headers['x-review-owner'] && safeEqual(req.headers['x-review-owner'], OWNER_TOKEN));
// the x-review-handle header wins (the sidebar picker can change it mid-session);
// the review_handle cookie set by the password gate is the fallback, so a guest
// is identified from their very first request — including on a phone, where the
// sidebar picker sits inside a drawer. Neither is a credential: the password
// cookie is, and the owner's handle still requires the owner token.
function who(req) {
  if (!HOSTED) return HANDLE;
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

function readJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
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
    return execFileSync('git', ['status', '--porcelain', '--', ...sourceFiles()], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).map(l => l.slice(3).trim()).filter(Boolean);
  } catch { return []; }
}
function mergedData(req) {
  const users = {};
  for (const f of fs.existsSync(USERS) ? fs.readdirSync(USERS) : []) {
    if (!f.endsWith('.json')) continue;
    const u = readJSON(path.join(USERS, f), null);
    if (u) users[u.handle || f.replace(/\.json$/, '')] = u.decisions || {};
  }
  const owner = isOwner(req);
  const me = who(req);
  // grants: the owner sees the whole table (People panel); a guest sees ONLY
  // their own budget, because the cap is a budget they must be able to read —
  // "4 of 5 agent calls left today", never a silent throttle
  const myGrant = me && grantFor(me);
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
    threads: readJSON(path.join(STATE, 'threads.json'), {}),
    suggestions: readJSON(path.join(REVIEW, 'suggestions.json'), []),
    apply: applyEngine.publicLedger(),
    pending_mentions: owner ? readJSON(PENDING, []) : undefined,
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

// --- P4: apply / commit / revert (owner-only) ---
const applyEngine = new ApplyEngine({ reviewDir: REVIEW, cfg: CFG });
function rebuild() {
  try { execFileSync(process.execPath, [path.join(REVIEW, 'build.mjs')], { cwd: REVIEW, stdio: 'pipe' }); return null; }
  catch (e) { return String(e.stderr || e.message).slice(0, 500); }
}
// every apply/commit/revert is recorded in the chat transcript (skill P4);
// best-effort — the action itself never depends on the bridge being up
function transcriptNote(text) {
  if (chat && chat.available) {
    chat.submit({ mention_id: `apply-${Date.now()}`, target_id: null, author: HANDLE, text: `${text}\nThis is a transcript record of a review-page action — acknowledge in one short line; no action needed.` });
  }
}
// accepted = the owner's own decisions (apply is an owner act on their accepts).
// `status` carries the decision on bot cards; a HUMAN suggestion occupies
// `status` with its own entry type, so its accept/reject lands in `decision`.
function acceptedIds() {
  const dec = readJSON(userFile(HANDLE), {}).decisions || {};
  return Object.keys(dec).filter(id => dec[id].status === 'accepted' || dec[id].decision === 'accepted');
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
function grantSpend(handle) {
  let u = readJSON(GRANT_USE, {});
  if (u.date !== today()) u = { date: today(), counts: {} };
  u.counts[handle] = (u.counts[handle] || 0) + 1;
  fs.writeFileSync(GRANT_USE, JSON.stringify(u, null, 1));
  return u.counts[handle];
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
  const acc = { today: { cost: 0, runs: 0 }, week: { cost: 0, runs: 0 }, source: path.basename(log) };
  let text = '';
  try { text = fs.readFileSync(log, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.timestamp || '');
    if (!t || e.error) continue;
    const c = Number(e.cost_usd) || 0;
    if (now - t < dayMs) { acc.today.cost += c; acc.today.runs++; }
    if (now - t < 7 * dayMs) { acc.week.cost += c; acc.week.runs++; }
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
      if (url === '/permission') { chat.answerPermission(data); res.writeHead(200, JSON_HEAD).end('{"ok":true}'); return; }
      if (url === '/choice') { chat.answerChoice(data); res.writeHead(200, JSON_HEAD).end('{"ok":true}'); return; }
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
            if (used < grant.daily_cap) {
              const left = grant.daily_cap - grantSpend(m.author);
              const r = chat.submit(m);
              res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ...r, granted: true, calls_left: left, daily_cap: grant.daily_cap }));
              return;
            }
            // over cap: honest message, and the turn still reaches the owner
            const pendingCap = readJSON(PENDING, []);
            if (!pendingCap.find(x => x.mention_id === m.mention_id)) {
              pendingCap.push(m); fs.writeFileSync(PENDING, JSON.stringify(pendingCap, null, 1));
              notifyOwner(`review: ${m.author} hit their daily agent cap on ${cardSection(m.target_id)}`);
            }
            res.writeHead(200, JSON_HEAD).end(JSON.stringify({ queued: false, pending: true, capped: true,
              calls_left: 0, daily_cap: grant.daily_cap,
              reason: `daily cap reached (${grant.daily_cap}/${grant.daily_cap}) — queued for the owner to release` }));
            return;
          }
          const pending = readJSON(PENDING, []);
          if (!pending.find(x => x.mention_id === m.mention_id)) {
            pending.push(m); fs.writeFileSync(PENDING, JSON.stringify(pending, null, 1));
            notifyOwner(`review: ${m.author} requested agents on ${cardSection(m.target_id)}`);
          }
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
    req.on('close', () => clients.delete(res));
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
        const prev = readJSON(file, {}).decisions || {};
        fs.writeFileSync(file, JSON.stringify(
          { handle, updated: new Date().toISOString(), decisions: stampEdits(prev, data.decisions || {}), build: data.build || null }, null, 1));
        res.writeHead(200, JSON_HEAD).end('{"ok":true}');
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
        const g = readJSON(GRANTS, {});
        if (d.agents) {
          const cap = Math.max(0, Math.min(500, Math.floor(Number(d.daily_cap)) || 0)) || DEFAULT_CAP;
          g[h] = { agents: true, daily_cap: cap };
        } else delete g[h];
        fs.writeFileSync(GRANTS, JSON.stringify(g, null, 1));
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
  // --- P4 (owner-only): apply / commit / revert; acceptance enforced here ---
  if (req.method === 'POST' && (url === '/apply' || url === '/commit' || url === '/revert' || url === '/release' || url === '/reopen')) {
    if (!isOwner(req)) { res.writeHead(403, JSON_HEAD).end('{"ok":false,"error":"owner only"}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        if (url === '/apply') {
          const accepted = new Set(acceptedIds());
          const wanted = data.all_accepted ? [...accepted] : [].concat(data.ids || []).filter(id => accepted.has(id));
          if (!wanted.length) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"error":"no accepted cards to apply"}'); return; }
          const r = applyEngine.apply(wanted);
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
          try { execFileSync('git', ['commit', '-m', 'Out-of-band source edits (committed from review site)', '--', ...files], { cwd: ROOT, encoding: 'utf8' }); }
          catch (e) { res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: false, reason: `git commit failed: ${String(e.stderr || e.message).slice(0, 300)}` })); return; }
          const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
          transcriptNote(`[commit] out-of-band ${sha}: ${files.join(', ')}`);
          res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, sha, files, apply: applyEngine.publicLedger() }));
          return;
        }
        if (url === '/commit') {
          const r = applyEngine.commit();
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
          fs.writeFileSync(f, JSON.stringify(u, null, 1));
          res.writeHead(200, JSON_HEAD).end('{"ok":true}');
          return;
        }
        if (url === '/revert') {
          const r = applyEngine.revert();
          const buildErr = r.ok ? rebuild() : null;
          if (r.ok) transcriptNote(`[revert] round dropped: ${r.ids.join(', ')}`);
          res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ...r, build_error: buildErr, apply: applyEngine.publicLedger() }));
          return;
        }
        // /release: owner drains queued collaborator mentions into the bridge
        const pending = readJSON(PENDING, []);
        const results = pending.map(m => chat ? chat.submit(m) : { queued: false, reason: 'chat not running' });
        fs.writeFileSync(PENDING, '[]');
        res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, released: pending.length, results }));
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
      ws.onclose = () => wsClients.delete(ws);
      ensureHeartbeat();
    },
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Review live at http://localhost:${PORT} — you are "${HANDLE}"; state in review/state/users/`);
    if (HOSTED) {
      console.log(`hosted mode: share the URL + password. Tunnel it with:\n  cloudflared tunnel --url http://localhost:${PORT}`);
      console.log(`owner access (keep private): http://localhost:${PORT}/?owner=${OWNER_TOKEN}`);
    }
  });
  if (process.argv.includes('--chat')) startChat().catch(e => console.error('chat mode failed:', e.message));
}
