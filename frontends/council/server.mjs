#!/usr/bin/env node
// Council web server: a browser frontend for botference PLAN mode.
// Spawns core/botference_ink_bridge.py as a child (same JSONL protocol the
// Ink TUI speaks), relays its events over SSE, and turns browser POSTs into
// bridge input. Single-user by design: in hosted mode the password IS the
// identity (no handles, no multi-user).
//
// Run:    node frontends/council/server.mjs            (local, no gate)
// Flags:  --hosted   password gate (COUNCIL_PASSWORD) + rate-limited POSTs
//         --no-auth  explicitly skip the gate even when hosted (open tunnel;
//                    the UI shows a dismissible warning banner)
// Env:    PORT, BOTFERENCE_PROJECT_ROOT, BOTFERENCE_HOME, BOTFERENCE_PYTHON_BIN,
//         COUNCIL_CLAUDE_MODEL/EFFORT, COUNCIL_OPENAI_MODEL/EFFORT,
//         BOTFERENCE_COUNCIL_SYSTEM_FILE/TASK_FILE,
//         COUNCIL_BRIDGE_CMD (tests: JSON argv array replacing the python bridge)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const COUNCIL = path.dirname(new URL(import.meta.url).pathname);
const ASSETS = path.join(COUNCIL, 'assets');
const HOME = process.env.BOTFERENCE_HOME || path.resolve(COUNCIL, '..', '..');
const ROOT = process.env.BOTFERENCE_PROJECT_ROOT || process.cwd();
const HOSTED = process.argv.includes('--hosted');
const NO_AUTH = process.argv.includes('--no-auth');
const PORT = process.env.PORT || 4187; // never the review ports (4177/4180)
const STATE = path.join(ROOT, '.botference', 'council');
fs.mkdirSync(STATE, { recursive: true });

const PASSWORD = process.env.COUNCIL_PASSWORD || '';
if (HOSTED && !NO_AUTH && !PASSWORD) {
  console.error('--hosted requires COUNCIL_PASSWORD (or pass --no-auth to run an open, ungated server — not recommended)');
  process.exit(1);
}

// --- hosted auth: in-page password gate + HMAC cookie (same machinery as the
// review frontend: stateless to validate, survives restarts, no basic-auth popup)
const GATED = HOSTED && !NO_AUTH;
const AUTH_TTL_MS = 7 * 24 * 3600 * 1000;
const secretFile = path.join(STATE, '.auth-secret');
let AUTH_SECRET = '';
if (GATED) {
  try { AUTH_SECRET = fs.readFileSync(secretFile, 'utf8').trim(); } catch { }
  if (!AUTH_SECRET) { AUTH_SECRET = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(secretFile, AUTH_SECRET); }
}
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(/; */)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return '';
}
function validAuthCookie(req) {
  const [exp, mac] = cookieOf(req, 'council_auth').split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  return safeEqual(mac, crypto.createHmac('sha256', AUTH_SECRET).update(exp).digest('hex'));
}
function authorized(req) {
  if (!GATED) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (m) {
    const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
    return safeEqual(pass, PASSWORD);
  }
  return validAuthCookie(req);
}
const escHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function gatePage(next, bad) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>botference council</title>
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
input[type=password] { width:100%; box-sizing:border-box; padding:.55rem .7rem; font-size:16px;
  border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg) }
button { margin-top:.85rem; width:100%; padding:.55rem; font-size:1rem; border:none;
  border-radius:8px; background:var(--accent); color:#fff; cursor:pointer }
button:hover { background:var(--accent-hover) }
.err { color:var(--accent); font-size:.85rem; margin:.7rem 0 0 }
</style></head><body>
<form method="POST" action="/auth">
<h1>Botference council</h1>
<p>This planning room is password-protected.</p>
<input type="password" name="password" placeholder="password" autofocus autocomplete="current-password" aria-label="password">
<input type="hidden" name="next" value="${escHtml(next)}">
<button>enter</button>
${bad ? '<div class="err">wrong password — try again</div>' : ''}
</form></body></html>`;
}
const safeNext = n => (n && n.startsWith('/') && !n.startsWith('//')) ? n : '/';
const GATE_HEAD = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const JSON_HEAD = { 'content-type': 'application/json', 'cache-control': 'no-store' };
function authEndpoint(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
  req.on('end', () => {
    const form = new URLSearchParams(body);
    const next = safeNext(form.get('next'));
    if (!safeEqual(form.get('password') || '', PASSWORD)) {
      res.writeHead(401, GATE_HEAD).end(gatePage(next, true));
      return;
    }
    const exp = String(Date.now() + AUTH_TTL_MS);
    const mac = crypto.createHmac('sha256', AUTH_SECRET).update(exp).digest('hex');
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    res.writeHead(303, {
      'set-cookie': `council_auth=${exp}.${mac}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      location: next,
    }).end();
  });
}
function denied(req, res) {
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
    res.writeHead(401, GATE_HEAD).end(gatePage(safeNext(req.url), false));
    return;
  }
  res.writeHead(401, JSON_HEAD).end('{"ok":false,"error":"auth required"}');
}
// rate-limited writes (gated hosted mode only): per-IP sliding minute window
const RATE = new Map();
function rateLimited(req) {
  if (!GATED) return false;
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  const r = RATE.get(ip) || { n: 0, t: now };
  if (now - r.t > 60000) { r.n = 0; r.t = now; }
  r.n++; RATE.set(ip, r);
  return r.n > 60;
}

// --- one web council per workspace: pid lock (same pattern as review-chat).
// The TUI and this server each drive their OWN bridge session, so a live TUI
// only warrants a note in the console, never a refusal.
const lockFile = path.join(ROOT, '.botference', 'council-web.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
function acquireLock() {
  if (fs.existsSync(lockFile)) {
    let l = null;
    try { l = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { }
    if (l && l.pid !== process.pid && alive(l.pid)) {
      console.error(`another council web server is attached to this workspace (pid ${l.pid}) — close it first`);
      process.exit(1);
    }
  }
  fs.writeFileSync(lockFile, JSON.stringify({ frontend: 'council-web', pid: process.pid, started: new Date().toISOString() }));
  process.on('exit', () => { try { fs.unlinkSync(lockFile); } catch { } });
}

// --- SSE clients + event history (replayed to newly connected clients so a
// page reload keeps the transcript). Consecutive text deltas of one stream are
// coalesced in the history, so replay stays small even after long turns.
const clients = new Set();
const history = [];
const HISTORY_MAX = 4000;
function pushHistory(ev) {
  if (ev.type === 'stream' && ev.kind === 'text_delta') {
    const last = history[history.length - 1];
    if (last && last.type === 'stream' && last.kind === 'text_delta'
      && last.stream_id === ev.stream_id && last.model === ev.model && last.pane === ev.pane) {
      last.text = String(last.text || '') + String(ev.text || '');
      return;
    }
  }
  history.push(ev);
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
}
function broadcast(ev) {
  pushHistory(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}

// --- the bridge child ---------------------------------------------------
let bridge = null;
class Bridge {
  constructor() {
    this.proc = null;
    this.available = false;
    this.permTimer = null;
    this.choiceTimer = null;
  }
  cmd() {
    if (process.env.COUNCIL_BRIDGE_CMD) return JSON.parse(process.env.COUNCIL_BRIDGE_CMD);
    const py = process.env.BOTFERENCE_PYTHON_BIN || 'python3';
    const sys = process.env.BOTFERENCE_COUNCIL_SYSTEM_FILE || this.tempFile('system.md', '');
    const task = process.env.BOTFERENCE_COUNCIL_TASK_FILE || this.tempFile('task.md', '');
    const args = [path.join(HOME, 'core', 'botference_ink_bridge.py'),
      '--system-prompt-file', sys, '--task-file', task];
    if (process.env.COUNCIL_CLAUDE_MODEL) args.push('--anthropic-model', process.env.COUNCIL_CLAUDE_MODEL);
    if (process.env.COUNCIL_CLAUDE_EFFORT) args.push('--claude-effort', process.env.COUNCIL_CLAUDE_EFFORT);
    if (process.env.COUNCIL_OPENAI_MODEL) args.push('--openai-model', process.env.COUNCIL_OPENAI_MODEL);
    if (process.env.COUNCIL_OPENAI_EFFORT) args.push('--openai-effort', process.env.COUNCIL_OPENAI_EFFORT);
    return [py, ...args];
  }
  tempFile(name, content) {
    const p = path.join(STATE, name);
    fs.writeFileSync(p, content);
    return p;
  }
  start() {
    acquireLock();
    const [cmd, ...args] = this.cmd();
    this.proc = spawn(cmd, args, {
      cwd: HOME,
      env: {
        ...process.env,
        BOTFERENCE_HOME: HOME,
        BOTFERENCE_PROJECT_ROOT: ROOT,
        BOTFERENCE_CLAUDE_TRANSPORT: 'programmatic', // the web frontend has no tmux to mirror
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        this.handle(ev);
      }
    });
    this.available = true;
    this.proc.stderr.on('data', d => broadcast({ type: 'bridge_log', text: String(d).slice(0, 500) }));
    this.proc.on('error', err => {
      this.available = false;
      broadcast({ type: 'bridge_exit', code: -1, error: err.message });
    });
    this.proc.on('exit', code => {
      this.available = false;
      broadcast({ type: 'bridge_exit', code });
    });
  }
  handle(ev) {
    // default-deny/dismiss timers: an unanswered permission is denied and an
    // unanswered choice dismissed after 120s, so a walked-away browser can
    // never jam the turn queue (mirrors the review frontend's behavior)
    if (ev.type === 'permission_request') {
      clearTimeout(this.permTimer);
      this.permTimer = setTimeout(() => {
        this.send({ type: 'permission_response', allow: false });
        broadcast({ type: 'permission_timeout' });
      }, 120000);
    }
    if (ev.type === 'permission_cleared') clearTimeout(this.permTimer);
    if (ev.type === 'choice_request') {
      clearTimeout(this.choiceTimer);
      this.choiceTimer = setTimeout(() => {
        this.send({ type: 'choice_response', index: null });
        broadcast({ type: 'choice_timeout' });
      }, 120000);
    }
    if (ev.type === 'choice_cleared') clearTimeout(this.choiceTimer);
    if (ev.type === 'clear_panes') {
      // a resume/new-chat wipes the transcript: drop stale history so a
      // reload doesn't replay the previous chat's events over the new one
      history.length = 0;
    }
    if (ev.type === 'exit') {
      broadcast(ev);
      setTimeout(() => process.exit(0), 200); // /quit in the browser stops the server
      return;
    }
    broadcast(ev);
  }
  send(obj) {
    if (!this.proc || !this.available) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }
}

// --- HTTP ---------------------------------------------------------------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(buf);
  });
}
function readBody(req, res, cap, fn) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > cap) req.destroy(); });
  req.on('end', () => {
    try { fn(JSON.parse(body || '{}')); }
    catch { res.writeHead(400, JSON_HEAD).end('{"ok":false}'); }
  });
}

export function handler(req, res) {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && rateLimited(req)) {
    res.writeHead(429, JSON_HEAD).end('{"ok":false,"error":"rate limited — slow down"}');
    return;
  }
  if (GATED && req.method === 'POST' && url === '/auth') { authEndpoint(req, res); return; }
  if (!authorized(req)) { denied(req, res); return; }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    serveFile(res, path.join(ASSETS, 'index.html'));
    return;
  }
  if (req.method === 'GET' && url.startsWith('/assets/')) {
    const file = path.resolve(ASSETS, decodeURIComponent(url.slice('/assets/'.length)));
    const rel = path.relative(ASSETS, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end(); return; }
    serveFile(res, file);
    return;
  }
  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', hosted: HOSTED, noauth: NO_AUTH, bridge: !!(bridge && bridge.available) })}\n\n`);
    for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && url === '/input') {
    readBody(req, res, 64000, data => {
      const text = String(data.text || '');
      if (!text.trim()) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"error":"empty"}'); return; }
      if (text.length > 16000) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"error":"too long"}'); return; }
      if (!bridge || !bridge.available) { res.writeHead(409, JSON_HEAD).end('{"ok":false,"error":"bridge is not running"}'); return; }
      // echo before send: the transcript shows the user's words immediately
      // (and after a reload — the bridge does not echo input back)
      broadcast({ type: 'user_echo', text, ts: new Date().toISOString() });
      bridge.send({ type: 'input', text, attachments: [] });
      res.writeHead(200, JSON_HEAD).end('{"ok":true}');
    });
    return;
  }
  if (req.method === 'POST' && url === '/interrupt') {
    readBody(req, res, 1000, () => {
      const ok = bridge && bridge.send({ type: 'interrupt' });
      res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: !!ok }));
    });
    return;
  }
  if (req.method === 'POST' && url === '/permission') {
    readBody(req, res, 1000, data => {
      clearTimeout(bridge && bridge.permTimer);
      const ok = bridge && bridge.send({ type: 'permission_response', allow: !!data.allow });
      res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: !!ok }));
    });
    return;
  }
  if (req.method === 'POST' && url === '/choice') {
    readBody(req, res, 1000, data => {
      clearTimeout(bridge && bridge.choiceTimer);
      const index = Number.isInteger(data.index) && data.index >= 0 ? data.index : null;
      const ok = bridge && bridge.send({ type: 'choice_response', index });
      res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: !!ok }));
    });
    return;
  }
  res.writeHead(404, JSON_HEAD).end('{"ok":false,"error":"not found"}');
}

if (process.env.COUNCIL_NO_LISTEN !== '1') {
  bridge = new Bridge();
  bridge.start();
  http.createServer(handler).listen(PORT, '127.0.0.1', () => {
    console.log(`Council live at http://localhost:${PORT} — workspace: ${ROOT}`);
    if (GATED) console.log('hosted mode: password-gated (COUNCIL_PASSWORD)');
    if (NO_AUTH && HOSTED) console.log('WARNING: --no-auth — this server answers ANYONE who reaches it');
  });
  setInterval(() => { for (const res of clients) res.write('data: {"type":"ping"}\n\n'); }, 30000).unref();
}
