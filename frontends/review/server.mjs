#!/usr/bin/env node
// Generic live review server: serves site/, per-user state mirroring, merged /data, SSE /events.
// Run:  node review/server.mjs   then open http://localhost:<port from review.config.json>
// Flags: --chat (spawn the bot bridge)  --hosted (shared-URL mode: REVIEW_PASSWORD
// basic auth, per-browser handle picker, rate-limited writes, owner-gated bots/apply)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ApplyEngine } from './apply.mjs';

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
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function authorized(req) {
  if (!HOSTED) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  return safeEqual(pass, PASSWORD);
}
// identity: local mode = the machine's git handle; hosted = the handle the
// browser picked once (header), never trusted to be the owner's without the token
const sanitizeHandle = h => String(h || '').toLowerCase().replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const isOwner = req => !HOSTED || (!!req.headers['x-review-owner'] && safeEqual(req.headers['x-review-owner'], OWNER_TOKEN));
function who(req) {
  if (!HOSTED) return HANDLE;
  const h = sanitizeHandle(req.headers['x-review-handle']);
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
  return {
    me: who(req),
    hosted: HOSTED,
    owner,
    users,
    threads: readJSON(path.join(STATE, 'threads.json'), {}),
    suggestions: readJSON(path.join(REVIEW, 'suggestions.json'), []),
    apply: applyEngine.publicLedger(),
    pending_mentions: owner ? readJSON(PENDING, []) : undefined,
    // additive fields (2026-07): chat-mode advertisement + out-of-band source dirt;
    // clients guard for their absence, so a pre-field server keeps working
    chat: !!(chat && chat.available),
    source_dirty: dirtySources(),
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
// accepted = the owner's own decisions (apply is an owner act on their accepts)
function acceptedIds() {
  const dec = readJSON(userFile(HANDLE), {}).decisions || {};
  return Object.keys(dec).filter(id => dec[id].status === 'accepted');
}

// collaborator mentions in hosted mode queue here until the owner releases them
const PENDING = path.join(STATE, 'pending-mentions.json');

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
function broadcast(type) {
  for (const res of clients) res.write(`data: ${JSON.stringify({ type })}\n\n`);
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
    onEvent: obj => { for (const res of clients) res.write(`data: ${JSON.stringify({ type: 'chat', ...obj })}\n\n`); },
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
          // collaborators cannot summon bots directly: queue for the owner to release
          const m = { mention_id: data.mention_id, target_id: data.target_id, author: who(req) || 'collaborator', text: data.text };
          const pending = readJSON(PENDING, []);
          if (!pending.find(x => x.mention_id === m.mention_id)) { pending.push(m); fs.writeFileSync(PENDING, JSON.stringify(pending, null, 1)); }
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
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="review"', 'content-type': 'text/plain' }).end('auth required');
    return;
  }
  if (req.method === 'POST' && rateLimited(req)) {
    res.writeHead(429, JSON_HEAD).end('{"ok":false,"error":"rate limited — slow down"}');
    return;
  }
  if (req.method === 'GET' && url === '/whoami') {
    res.writeHead(200, JSON_HEAD).end(JSON.stringify({ handle: who(req), slug: CFG.slug, hosted: HOSTED, owner: isOwner(req) }));
    return;
  }
  if (req.method === 'GET' && url === '/data') {
    res.writeHead(200, JSON_HEAD).end(JSON.stringify(mergedData(req)));
    return;
  }
  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('data: {"type":"hello"}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    if (!pingTimer) pingTimer = setInterval(() => broadcast('ping'), 30000).unref();
    return;
  }
  // legacy single-user endpoint: serve own user file so old clients keep working
  if (req.method === 'GET' && url === '/state') {
    res.writeHead(200, JSON_HEAD).end(JSON.stringify(readJSON(userFile(HANDLE), {})));
    return;
  }
  if (req.method === 'POST' && (url === '/mention' || url === '/chatbox' || url === '/permission' || url === '/choice')) {
    chatEndpoint(req, res, url);
    return;
  }
  if (req.method === 'POST' && (url === '/state' || url === '/summon')) {
    const handle = who(req);
    if (!handle) { res.writeHead(400, JSON_HEAD).end('{"ok":false,"error":"pick a handle first"}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // the browser only ever writes the server-identified caller's own file
        const file = url === '/state' ? userFile(handle) : path.join(STATE, 'summon.json');
        const prev = url === '/state' ? (readJSON(file, {}).decisions || {}) : null;
        const payload = url === '/state'
          ? { handle, updated: new Date().toISOString(), decisions: stampEdits(prev, data.decisions || {}), build: data.build || null }
          : { received: new Date().toISOString(), handle, ...data };
        fs.writeFileSync(file, JSON.stringify(payload, null, 1));
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
  http.createServer(handler).listen(PORT, '127.0.0.1', () => {
    console.log(`Review live at http://localhost:${PORT} — you are "${HANDLE}"; state in review/state/users/`);
    if (HOSTED) {
      console.log(`hosted mode: share the URL + password. Tunnel it with:\n  cloudflared tunnel --url http://localhost:${PORT}`);
      console.log(`owner access (keep private): http://localhost:${PORT}/?owner=${OWNER_TOKEN}`);
    }
  });
  if (process.argv.includes('--chat')) startChat().catch(e => console.error('chat mode failed:', e.message));
}
