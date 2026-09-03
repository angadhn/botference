#!/usr/bin/env node
// Council web server: a browser frontend for botference PLAN mode.
// Spawns core/botference_ink_bridge.py children (same JSONL protocol the
// Ink TUI speaks), relays their events over WS/SSE, and turns browser POSTs
// into bridge input. Single-user by design: in hosted mode the password IS
// the identity (no handles, no multi-user).
//
// One bridge per OPEN CHAT (not one per server): a tab that connects with
// ?chat=<session-id> is attached to the bridge driving that chat, spawned on
// demand with an automatic /resume. Tabs on different chats run concurrent,
// independent sessions behind the same tunnel; tabs on the same chat share
// one bridge and see the same live stream.
//
// Run:    node frontends/council/server.mjs            (local, no gate)
// Flags:  --hosted   password gate (COUNCIL_PASSWORD) + rate-limited POSTs
//         --no-auth  explicitly skip the gate even when hosted (open tunnel;
//                    the UI shows a dismissible warning banner)
// Env:    PORT, BOTFERENCE_PROJECT_ROOT, BOTFERENCE_HOME, BOTFERENCE_PYTHON_BIN,
//         COUNCIL_CLAUDE_MODEL/EFFORT, COUNCIL_OPENAI_MODEL/EFFORT,
//         BOTFERENCE_COUNCIL_SYSTEM_FILE/TASK_FILE,
//         COUNCIL_MAX_CHATS (bridge-pool cap, default 4),
//         COUNCIL_BRIDGE_CMD (tests: JSON argv array replacing the python bridge)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
// WS transport shared with the review engine: cloudflared buffers streamed
// HTTP bodies (SSE arrives header-only through tunnels), WebSockets don't
import { attachWs } from '../review/ws.mjs';
// per-agent billing: the same module Discuss uses, so one pasted key serves
// both. Only the MODE is the council's own (see COUNCIL_MODES below).
import * as keys from '../shared/keys.mjs';
import { isLocalDirect } from '../shared/local.mjs';

const COUNCIL = path.dirname(new URL(import.meta.url).pathname);
const ASSETS = path.join(COUNCIL, 'assets');
const HOME = process.env.BOTFERENCE_HOME || path.resolve(COUNCIL, '..', '..');
const ROOT = process.env.BOTFERENCE_PROJECT_ROOT || process.cwd();
const HOSTED = process.argv.includes('--hosted');
const NO_AUTH = process.argv.includes('--no-auth');
const PORT = process.env.PORT || 4187; // never the review ports (4177/4180)
const STATE = path.join(ROOT, '.botference', 'council');
fs.mkdirSync(STATE, { recursive: true });
// image uploads land under the workspace's .botference (gitignored by
// workspace convention); served back only through the auth-gated /uploads/
const UPLOADS = path.join(ROOT, '.botference', 'uploads');
const UPLOAD_MAX = 10 * 1024 * 1024; // per image
const UPLOAD_MAX_PER_MSG = 4;

// --- billing: which auth each agent's CLI runs on ------------------------
// The KEYS are shared with Discuss (~/.botference/discuss-keys.json, 0600,
// write-only over any API) — a key pasted once works everywhere on this
// machine. The MODE is this server's own preference and lives in the
// workspace's council state, so putting the council on the subscription does
// not quietly retune the browser plugin. See frontends/shared/keys.mjs.
const COUNCIL_MODES = keys.modeStore(path.join(STATE, 'key-modes.json'));

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

// --- the bridge pool ----------------------------------------------------
// One bridge child per open chat. Each bridge keeps its own event history
// (replayed to clients attaching to that chat, so a reload keeps the
// transcript) and its own subscriber sets. Consecutive text deltas of one
// stream are coalesced in the history, so replay stays small after long turns.
const HISTORY_MAX = 4000;
const MAX_BRIDGES = Math.max(1, Number(process.env.COUNCIL_MAX_CHATS) || 4);
const bridges = new Map(); // bridge id -> Bridge
let nextBridgeSeq = 1;
let primaryId = null;      // the bridge sid-less connections attach to

// projects/<id>/ as a list a person reads: top level, plus one level inside
// each folder, and no further. The cap and the depth are the same defensive
// bounds core/project_store.py's contents() uses, and for the same reason —
// a project folder is somewhere files get dropped, so it may hold a checked-out
// repo or a thousand PDFs, and neither may be allowed to stall a panel.
const CONTENTS_MAX_DEPTH = 1;
const CONTENTS_MAX_ENTRIES = 400;
const CONTENTS_SKIP = new Set(['__pycache__', 'node_modules']);

function projectContents(dir, { root = dir, depth = 0, out = [] } = {}) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? 0 : a.isDirectory() ? -1 : 1)
    || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || CONTENTS_SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    const isDir = e.isDirectory();
    const deeper = depth < CONTENTS_MAX_DEPTH;
    out.push({
      path: path.relative(root, abs).split(path.sep).join('/'),
      name: e.name,
      dir: isDir,
      size: isDir ? 0 : st.size,
      modified: st.mtimeMs,
      depth,
      truncated: isDir && !deeper,
    });
    if (out.length >= CONTENTS_MAX_ENTRIES) return out.slice(0, CONTENTS_MAX_ENTRIES);
    if (isDir && deeper) {
      projectContents(abs, { root, depth: depth + 1, out });
      if (out.length >= CONTENTS_MAX_ENTRIES) return out.slice(0, CONTENTS_MAX_ENTRIES);
    }
  }
  return out;
}

// The projects snapshot is WORKSPACE state, not per-chat state: every bridge
// derives it from the same session files on disk, so the freshest snapshot
// from ANY bridge supersedes what every tab shows. It is pinned globally
// (never per-bridge history — replaying an old snapshot made the sidebar
// time-travel backwards on chat switches) and re-marked per receiving bridge
// so each tab still sees its OWN chat flagged active.
let latestProjects = null;
let latestProjectsFrom = null;  // bridge id that produced latestProjects
const emptySnapshot = ev =>
  !(ev.projects || []).length && !(ev.inbox_sessions || []).length && !ev.inbox_session_count;
function remarkProjects(ev, bridge, isSource = false) {
  // the emitting bridge's own tabs get the snapshot verbatim — its
  // controller's active flags and active_project_id are already theirs
  // (a project can be active while the open chat is still unfiled)
  if (isSource) return ev;
  const sid = bridge.sid || bridge.claimedSid || null;
  let activePid = '';
  const projects = (ev.projects || []).map(pr => {
    const sessions = (pr.sessions || []).map(s => ({ ...s, active: s.session_id === sid }));
    if (sessions.some(s => s.active)) activePid = pr.id;
    return { ...pr, sessions };
  });
  for (const pr of projects) pr.active = pr.id === activePid;
  return {
    ...ev,
    projects,
    inbox_sessions: (ev.inbox_sessions || []).map(s => ({ ...s, active: s.session_id === sid })),
    active_project_id: activePid,
  };
}
function publishProjects(ev, source) {
  // a fresh bridge's empty startup placeholder (emitted before its first
  // 'ready', ahead of panel hydration) must not wipe a populated sidebar in
  // every tab; post-ready empty snapshots are real (workspace emptied out)
  if (latestProjects && emptySnapshot(ev) && source && !source.readySeen) return;
  latestProjects = ev;
  latestProjectsFrom = source ? source.id : null;
  for (const b of bridges.values()) b.broadcast(remarkProjects(ev, b, b === source), false);
}

const helloEvent = b => ({
  type: 'hello', hosted: HOSTED, noauth: NO_AUTH,
  bridge: !!(b && b.available),
  bridge_id: b ? b.id : null,
  chat: b ? (b.sid || b.claimedSid) : null,
  resuming: !!(b && b.resuming),
});

class Bridge {
  constructor(claimedSid = null) {
    this.id = 'b' + nextBridgeSeq++;
    this.proc = null;
    this.available = false;
    this.permTimer = null;
    this.choiceTimer = null;
    // which chat this bridge drives: claimedSid is the attach target while a
    // spawn-time /resume is in flight; sid is authoritative, learned from the
    // bridge's own 'projects' events (the session flagged active)
    this.sid = null;
    this.claimedSid = claimedSid;
    this.resuming = !!claimedSid;
    this.busy = false;             // between an input send and the next ready
    this.readySeen = false;        // the startup ready has arrived
    this.lastUsed = Date.now();
    // completion_context is pinned outside history: the bridge emits it once
    // at startup, so leaving it in a buffer that gets wiped on chat switches
    // and front-trimmed in long chats means late-connecting clients lose
    // slash-command autocomplete. It is replayed to every client on connect.
    this.pinnedCtx = null;
    this.history = [];
    this.clients = new Set();     // SSE responses attached to this chat
    this.wsClients = new Set();   // WebSocket connections (primary transport)
  }
  subscriberCount() { return this.clients.size + this.wsClients.size; }
  pushHistory(ev) {
    const history = this.history;
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
  broadcast(ev, record = true) {
    if (record) this.pushHistory(ev);
    const json = JSON.stringify(ev);
    const line = `data: ${json}\n\n`;
    for (const res of this.clients) res.write(line);
    for (const ws of this.wsClients) ws.send(json);
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
    const [cmd, ...args] = this.cmd();
    this.proc = spawn(cmd, args, {
      cwd: HOME,
      // API keys, per agent, decided fresh at every spawn (shared/keys.mjs):
      // a stored key is added, and every path that means "no key" DELETES the
      // variable rather than emptying it — including one this server inherited
      // from the shell or LaunchAgent that started it. The mode is the only
      // authority; nothing left over in our own environment gets a vote.
      env: keys.applyEnv({
        ...process.env,
        BOTFERENCE_HOME: HOME,
        BOTFERENCE_PROJECT_ROOT: ROOT,
        BOTFERENCE_CLAUDE_TRANSPORT: 'programmatic', // the web frontend has no tmux to mirror
      }, COUNCIL_MODES),
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
    this.proc.stderr.on('data', d => this.broadcast({ type: 'bridge_log', text: String(d).slice(0, 500) }));
    this.proc.on('error', err => {
      this.available = false;
      this.broadcast({ type: 'bridge_exit', code: -1, error: err.message });
      despawnBridge(this);
    });
    this.proc.on('exit', code => {
      if (!this.available) return; // already handled (clean 'exit' event or error)
      this.available = false;
      this.broadcast({ type: 'bridge_exit', code });
      despawnBridge(this);
    });
  }
  handle(ev) {
    if (ev.type === 'completion_context') {
      this.pinnedCtx = ev;
      this.broadcast(ev, false); // pinned + replayed on connect, never in history
      return;
    }
    if (ev.type === 'projects') {
      // learn which chat this bridge actually drives (the active session)
      let active = null;
      for (const pr of ev.projects || []) {
        for (const s of pr.sessions || []) if (s.active) active = s.session_id;
      }
      for (const s of ev.inbox_sessions || []) if (s.active) active = s.session_id;
      if (active) {
        this.sid = active;
        if (active === this.claimedSid) { this.claimedSid = null; this.resuming = false; }
      }
      // workspace state: pinned globally + fanned out to every tab, never
      // recorded in this bridge's history (see publishProjects)
      publishProjects(ev, this);
      return;
    }
    if (ev.type === 'ready') {
      this.busy = false;
      // a spawn-time /resume is done at the ready that ENDS its turn — the
      // bridge's startup ready arrives first and must not clear the claim
      if (this.resuming && this.readySeen) { this.resuming = false; this.claimedSid = null; }
      this.readySeen = true;
    }
    // default-deny/dismiss timers: an unanswered permission is denied and an
    // unanswered choice dismissed after 120s, so a walked-away browser can
    // never jam the turn queue (mirrors the review frontend's behavior)
    if (ev.type === 'permission_request') {
      clearTimeout(this.permTimer);
      this.permTimer = setTimeout(() => {
        this.send({ type: 'permission_response', allow: false });
        this.broadcast({ type: 'permission_timeout' });
      }, 120000);
    }
    if (ev.type === 'permission_cleared') clearTimeout(this.permTimer);
    if (ev.type === 'choice_request') {
      clearTimeout(this.choiceTimer);
      this.choiceTimer = setTimeout(() => {
        this.send({ type: 'choice_response', index: null });
        this.broadcast({ type: 'choice_timeout' });
      }, 120000);
    }
    if (ev.type === 'choice_cleared') clearTimeout(this.choiceTimer);
    if (ev.type === 'clear_panes') {
      // a resume/new-chat wipes the transcript: drop stale history so a
      // reload doesn't replay the previous chat's events over the new one
      this.history.length = 0;
    }
    if (ev.type === 'exit') {
      this.available = false;
      this.broadcast(ev);
      despawnBridge(this);
      // /quit closes THIS chat's bridge; the server stops with the last one
      if (bridges.size === 0) setTimeout(() => process.exit(0), 200);
      return;
    }
    this.broadcast(ev);
  }
  send(obj) {
    if (!this.proc || !this.available) return false;
    if (obj && obj.type === 'input') this.busy = true;
    this.lastUsed = Date.now();
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }
}

// --- pool management ----------------------------------------------------
function spawnBridge(claimedSid = null) {
  const b = new Bridge(claimedSid);
  bridges.set(b.id, b);
  if (primaryId === null) primaryId = b.id;
  b.start();
  if (claimedSid) b.send({ type: 'input', text: `/resume ${claimedSid}` });
  return b;
}
function despawnBridge(b) {
  clearTimeout(b.permTimer);
  clearTimeout(b.choiceTimer);
  bridges.delete(b.id);
  if (b.proc) { try { b.proc.kill(); } catch { } }
  if (primaryId === b.id) {
    const first = bridges.values().next();
    primaryId = first.done ? null : first.value.id;
  }
}
function ensurePrimary() {
  const cur = primaryId !== null ? bridges.get(primaryId) : null;
  if (cur) return cur;
  return spawnBridge();
}
function findBySid(sid) {
  for (const b of bridges.values()) {
    if (b.available && (b.sid === sid || b.claimedSid === sid)) return b;
  }
  return null;
}
// Mirror of paths.py work-dir resolution, just enough to answer "does a
// session file for this id exist?". When no sessions dir can be found at all
// the check stays permissive — the bridge itself is the authority then.
function sessionKnownMissing(sid) {
  if (!/^[\w-]+$/.test(sid)) return true;
  const candidates = [];
  if (process.env.BOTFERENCE_WORK_DIR) candidates.push(path.join(process.env.BOTFERENCE_WORK_DIR, 'sessions'));
  candidates.push(
    path.join(ROOT, 'botference', 'sessions'),
    path.join(ROOT, 'work', 'sessions'),
    path.join(ROOT, 'sessions'),
  );
  const dirs = candidates.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!dirs.length) return false;
  return !dirs.some(d => fs.existsSync(path.join(d, `${sid}.json`)));
}
// Evict the least-recently-used bridge that is idle and has no attached
// tabs. Never evicts a bridge mid-turn or one someone is looking at.
function reapIdleBridge() {
  let victim = null;
  for (const b of bridges.values()) {
    if (b.busy || b.subscriberCount() > 0) continue;
    if (!victim || b.lastUsed < victim.lastUsed) victim = b;
  }
  if (victim) despawnBridge(victim);
  return !!victim;
}
// Resolve the bridge a connection with ?chat=<sid> should attach to,
// spawning one when that chat has no live bridge yet. On refusal (unknown
// chat, pool full) the connection falls back to the primary bridge and the
// client is told why via a route_error event.
function attachTarget(sid) {
  if (!sid) return { bridge: ensurePrimary() };
  const live = findBySid(sid);
  if (live) return { bridge: live };
  if (sessionKnownMissing(sid)) return { bridge: ensurePrimary(), error: 'chat not found' };
  if (bridges.size >= MAX_BRIDGES && !reapIdleBridge()) {
    return { bridge: ensurePrimary(), error: `open-chat limit reached (${MAX_BRIDGES}) — close another chat tab first` };
  }
  return { bridge: spawnBridge(sid) };
}
// Resolve which bridge a POST addresses: explicit bridge id first (what the
// client learned from its hello), then a chat sid, then the primary. A POST
// naming a bridge that no longer exists is REFUSED, never rerouted — landing
// a message in a different chat than the tab shows is the failure mode this
// whole pool exists to prevent.
function bridgeForPost(data) {
  if (data && typeof data.bridge === 'string' && data.bridge) {
    return bridges.get(data.bridge) || null;
  }
  if (data && typeof data.chat === 'string') { const b = findBySid(data.chat); if (b) return b; }
  return primaryId !== null ? bridges.get(primaryId) : null;
}

// --- HTTP ---------------------------------------------------------------
// SSE through proxies/CDN edges (cloudflared included): flush headers at
// once, disable Nagle, and pad the first chunk past typical edge buffering
// thresholds with an SSE comment (EventSource ignores comment lines) —
// otherwise the edge holds the response and the browser sees zero events.
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
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv',
  '.markdown': 'text/plain; charset=utf-8',
};
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

// --- file uploads (images + PDFs) ---------------------------------------
// Content decides, not the filename: sniff magic bytes and derive the
// extension from what the file actually is.
function sniffImage(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // xlsx/docx are zips telling their kind by their entry paths (xl/ vs
  // word/); a legacy Office file is an OLE2 compound document whose stream
  // directory names the app — "WordDocument" (UTF-16LE) marks a .doc, and
  // anything else OLE2 keeps the old answer, xls.
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    if (buf.includes('xl/')) return 'xlsx';
    if (buf.includes('word/')) return 'docx';
  }
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) {
    return buf.includes(Buffer.from('WordDocument', 'utf16le')) ? 'doc' : 'xls';
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
    && /^(heic|heix|hevc|mif1|msf1)/.test(buf.subarray(8, 12).toString('latin1'))) return 'heic';
  return null;
}
// Text files have no magic bytes, so content alone cannot tell a .md from a
// .txt — the browser's declared type and filename (x-filename) name the kind,
// and the bytes only have to be honest UTF-8 text with no NUL in them.
const TEXT_EXT = /\.(md|markdown|txt|csv|json)$/i;
const TEXT_MIME = /^(text\/(markdown|plain|csv|x-markdown)|application\/json)\b/i;
function sniffText(buf, contentType, filename) {
  const byName = (TEXT_EXT.exec(String(filename || '')) || [])[1];
  const byType = TEXT_MIME.test(String(contentType || ''));
  if (!byName && !byType) return null;
  if (buf.includes(0)) return null;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
  const ext = (byName || '').toLowerCase();
  if (ext === 'markdown') return 'md';
  if (ext) return ext;
  const ct = String(contentType || '').toLowerCase();
  return /markdown/.test(ct) ? 'md' : /csv/.test(ct) ? 'csv' : /json/.test(ct) ? 'json' : 'txt';
}
const FILE_EXT = /\.(pdf|xlsx?|docx?|md|txt|csv|json)$/i;
const uploadUrl = abs => '/uploads/' + path.relative(UPLOADS, abs).split(path.sep).map(encodeURIComponent).join('/');
function uploadEndpoint(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    // over the cap: stop retaining (memory stays bounded), answer 413 at end
    if (size <= UPLOAD_MAX) chunks.push(c);
  });
  req.on('end', () => {
    if (size > UPLOAD_MAX) {
      res.writeHead(413, JSON_HEAD).end(JSON.stringify({ ok: false, error: 'file too large (10MB max)' }));
      return;
    }
    const buf = Buffer.concat(chunks);
    const ext = sniffImage(buf) || sniffText(buf, req.headers['content-type'], req.headers['x-filename']);
    if (!ext) {
      res.writeHead(400, JSON_HEAD).end(JSON.stringify({ ok: false, error: 'not an image, PDF, spreadsheet, Word or text file (png/jpeg/gif/webp/heic · pdf · xlsx/xls · docx/doc · md/txt/csv/json)' }));
      return;
    }
    const month = new Date().toISOString().slice(0, 7); // yyyy-mm
    const dir = path.join(UPLOADS, month);
    const id = crypto.randomBytes(8).toString('hex');
    const abs = path.join(dir, `${id}.${ext}`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(abs, buf, { mode: 0o600 });
    } catch {
      res.writeHead(500, JSON_HEAD).end(JSON.stringify({ ok: false, error: 'could not store upload' }));
      return;
    }
    res.writeHead(200, JSON_HEAD).end(JSON.stringify({
      ok: true,
      attachment: { id, path: abs, type: FILE_EXT.test('.' + ext) ? 'file' : 'image', url: uploadUrl(abs) },
    }));
  });
}
// /input attachments must point at files THIS server stored — never an
// arbitrary path the browser names. Returns the bridge-schema list
// ({id, path, type:'image'|'file'} — exactly what the Ink TUI sends) or
// null. The type is re-derived from the stored file, never trusted.
function cleanAttachments(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > UPLOAD_MAX_PER_MSG) return null;
  const out = [];
  for (const a of raw) {
    const p = path.resolve(String((a && a.path) || ''));
    const rel = path.relative(UPLOADS, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(p)) return null;
    const type = FILE_EXT.test(p) ? 'file' : 'image';
    out.push({ id: String((a && a.id) || path.basename(p)), path: p, type });
  }
  return out;
}

const chatParamOf = reqUrl => {
  const q = String(reqUrl || '').split('?')[1] || '';
  const m = /(?:^|&)chat=([^&]*)/.exec(q);
  return m ? decodeURIComponent(m[1]) : '';
};
// shared connect sequence for /events and /ws: route_error (if the requested
// chat could not be attached), hello, pinned context, history, replay_done
function replayTo(send, b, routeError) {
  if (routeError) send({ type: 'route_error', error: routeError });
  send(helloEvent(b));
  if (b.pinnedCtx) send(b.pinnedCtx);
  // freshest workspace sidebar regardless of which bridge computed it —
  // per-bridge history no longer carries projects events
  if (latestProjects) send(remarkProjects(latestProjects, b, b.id === latestProjectsFrom));
  for (const ev of b.history) send(ev);
  // explicit replay boundary: the client pins the transcript to the bottom
  // here instead of trusting per-event scroll heuristics during replay
  send({ type: 'replay_done', count: b.history.length });
}
const anyBridgeAvailable = () => {
  for (const b of bridges.values()) if (b.available) return true;
  return false;
};
// When a billing change actually bites. A process's environment is fixed at
// exec: a bridge that is already running keeps the auth it was spawned with,
// and there is no honest way around that short of killing a live turn — which
// this server will not do to answer a settings click. So the answer is either
// "now" (nothing is running, the next spawn reads the new mode) or
// "next-bridge", and the UI says so in those words.
const appliesWhen = () => (anyBridgeAvailable() ? 'next-bridge' : 'now');

// A billing change only reaches a NEWLY spawned bridge — so retire every idle
// one the moment the user flips a switch or changes a key. Their chats lose
// nothing: the next turn respawns with /resume from the session file, now
// under the new billing. Only a bridge that is mid-turn keeps its old env,
// and only until that turn ends; appliesWhen() then answers 'now' in the
// common case instead of leaving the reader to guess they needed a restart.
function retireIdleBridges() {
  for (const b of [...bridges.values()]) {
    if (!b.busy) despawnBridge(b);
  }
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
    const { bridge: b, error } = attachTarget(chatParamOf(req.url));
    sseOpen(res);
    replayTo(ev => res.write(`data: ${JSON.stringify(ev)}\n\n`), b, error);
    b.clients.add(res);
    req.on('close', () => { b.clients.delete(res); b.lastUsed = Date.now(); });
    return;
  }
  if (req.method === 'POST' && url === '/upload') {
    if (!anyBridgeAvailable()) { res.writeHead(409, JSON_HEAD).end('{"ok":false,"error":"bridge is not running"}'); return; }
    uploadEndpoint(req, res);
    return;
  }
  // Project deliverables: bots save rendered artifacts (plots, reports,
  // HTML pages) into the workspace and link them in chat as /files/<relpath>.
  // Auth-gated like everything else; any dot-segment (.botference secrets,
  // .git, hidden files) is refused so only real content is reachable.
  if (req.method === 'GET' && url.startsWith('/files/')) {
    const file = path.resolve(ROOT, decodeURIComponent(url.slice('/files/'.length)));
    const rel = path.relative(ROOT, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) ||
        rel.split(path.sep).some(seg => seg.startsWith('.'))) { res.writeHead(403).end(); return; }
    serveFile(res, file);
    return;
  }
  // What is actually IN a project: its folder, read-only, shallow.
  //
  // Deliberately NOT part of the projects snapshot. That snapshot is
  // recomputed after every turn and broadcast to every attached tab, so
  // everything in it is paid for by every turn of every chat; a directory
  // listing nobody has asked to see is exactly the wrong thing to put there.
  // This is a request, made when a reader opens the contents panel.
  //
  // Same refusals as /files/: a dot-segment or an escape is 403, so the
  // listing can never name .botference, .git, or anything outside the
  // project folder it was asked about.
  if (req.method === 'GET' && url === '/project-contents') {
    // `url` is the path alone (the query was split off at the top of handler)
    const id = String(new URL(req.url, 'http://x').searchParams.get('id') || '');
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes('..')) {
      res.writeHead(400).end(); return;
    }
    const dir = path.resolve(ROOT, 'projects', id);
    const rel = path.relative(path.join(ROOT, 'projects'), dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end(); return; }
    res.writeHead(200, JSON_HEAD)
      .end(JSON.stringify({ ok: true, id, files: projectContents(dir) }));
    return;
  }
  if (req.method === 'GET' && url.startsWith('/uploads/')) {
    const file = path.resolve(UPLOADS, decodeURIComponent(url.slice('/uploads/'.length)));
    const rel = path.relative(UPLOADS, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end(); return; }
    serveFile(res, file);
    return;
  }
  if (req.method === 'POST' && url === '/input') {
    readBody(req, res, 64000, data => {
      const text = String(data.text || '');
      const attachments = cleanAttachments(data.attachments);
      if (attachments === null) { res.writeHead(400, JSON_HEAD).end('{"ok":false,"error":"bad attachments"}'); return; }
      if (!text.trim() && !attachments.length) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"error":"empty"}'); return; }
      if (text.length > 16000) { res.writeHead(200, JSON_HEAD).end('{"ok":false,"error":"too long"}'); return; }
      const bridge = bridgeForPost(data);
      if (!bridge || !bridge.available) { res.writeHead(409, JSON_HEAD).end('{"ok":false,"error":"bridge is not running"}'); return; }
      // a typed /resume targeting a chat another bridge already drives must
      // not fork the session into two processes — tell the tab to reattach
      // to the live bridge instead
      const rm = /^\/resume\s+([\w-]+)\s*$/.exec(text.trim());
      if (rm) {
        const owner = findBySid(rm[1]);
        if (owner && owner !== bridge) {
          res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, switch: rm[1] }));
          return;
        }
      }
      // echo before send: the transcript shows the user's words immediately
      // (and after a reload — the bridge does not echo input back); echoed
      // attachments carry the display URL for inline thumbnails
      bridge.broadcast({
        type: 'user_echo', text, ts: new Date().toISOString(),
        attachments: attachments.map(a => ({ ...a, url: uploadUrl(a.path) })),
      });
      bridge.send({ type: 'input', text, attachments });
      res.writeHead(200, JSON_HEAD).end('{"ok":true}');
    });
    return;
  }
  if (req.method === 'POST' && url === '/interrupt') {
    readBody(req, res, 1000, data => {
      const bridge = bridgeForPost(data);
      const ok = bridge && bridge.send({ type: 'interrupt' });
      res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: !!ok }));
    });
    return;
  }
  if (req.method === 'POST' && url === '/permission') {
    readBody(req, res, 1000, data => {
      const bridge = bridgeForPost(data);
      clearTimeout(bridge && bridge.permTimer);
      const ok = bridge && bridge.send({ type: 'permission_response', allow: !!data.allow });
      res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: !!ok }));
    });
    return;
  }
  if (req.method === 'POST' && url === '/choice') {
    readBody(req, res, 1000, data => {
      const bridge = bridgeForPost(data);
      clearTimeout(bridge && bridge.choiceTimer);
      const index = Number.isInteger(data.index) && data.index >= 0 ? data.index : null;
      const ok = bridge && bridge.send({ type: 'choice_response', index });
      res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: !!ok }));
    });
    return;
  }
  // --- billing: which auth each agent runs on ----------------------------
  // Status and the MODE switch are open to anyone the gate already trusts —
  // they are preferences, and changing one from a phone is the whole point of
  // a hosted council. A KEY is different: it may only be written from this
  // machine, exactly as in Discuss. cloudflared's hop arrives on loopback too,
  // so isLocalDirect is the three-part test (Host + no proxy headers + loopback
  // peer), not a socket check.
  //
  // Nothing here ever answers with a key. Every response is built from
  // keys.status(), which knows only "set" or "unset".
  if (url === '/keys' || url === '/keys/remove' || url === '/key-mode') {
    const local = isLocalDirect(req);
    const snapshot = () => ({
      ok: true, ...keys.status(COUNCIL_MODES),
      overrides_login: keys.KEY_OVERRIDES_LOGIN, local,
    });
    if (req.method === 'GET' && url === '/keys') {
      res.writeHead(200, JSON_HEAD).end(JSON.stringify(snapshot()));
      return;
    }
    if (req.method === 'POST' && url === '/key-mode') {
      readBody(req, res, 2000, data => {
        // refusing 'key' with nothing stored is not pedantry: the CLIs would
        // quietly fall back to the login and the switch would be a lie
        if (String(data.mode) === 'key' && !keys.keyIsSet(data.agent)) {
          res.writeHead(400, JSON_HEAD).end(JSON.stringify({
            ok: false, error: `no ${data.agent} key saved — add one from the machine this server runs on`,
          }));
          return;
        }
        const r = COUNCIL_MODES.setMode(data.agent, data.mode);
        if (!r.ok) { res.writeHead(400, JSON_HEAD).end(JSON.stringify(r)); return; }
        retireIdleBridges();
        res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ...snapshot(), applies: appliesWhen() }));
      });
      return;
    }
    if (req.method === 'POST' && (url === '/keys' || url === '/keys/remove')) {
      if (!local) {
        req.resume();
        res.writeHead(403, JSON_HEAD).end(JSON.stringify({
          ok: false, error: 'API keys can only be set from the machine this server runs on',
        }));
        return;
      }
      readBody(req, res, 4000, data => {
        const r = url === '/keys' ? keys.setKey(data.agent, data.key) : keys.removeKey(data.agent);
        if (!r.ok) { res.writeHead(400, JSON_HEAD).end(JSON.stringify(r)); return; }
        // a removed key can strand a mode on 'key': fall back to 'auto', which
        // is the same answer ("subscription") without the false promise
        if (url === '/keys/remove' && COUNCIL_MODES.modeOf(data.agent) === 'key') {
          COUNCIL_MODES.setMode(data.agent, 'auto');
        }
        retireIdleBridges();
        res.writeHead(200, JSON_HEAD).end(JSON.stringify({
          ...snapshot(), ...(r.removed === undefined ? {} : { removed: r.removed }),
          applies: appliesWhen(),
        }));
      });
      return;
    }
    res.writeHead(404, JSON_HEAD).end('{"ok":false,"error":"not found"}');
    return;
  }
  res.writeHead(404, JSON_HEAD).end('{"ok":false,"error":"not found"}');
}

if (process.env.COUNCIL_NO_LISTEN !== '1') {
  acquireLock();
  ensurePrimary();
  const server = http.createServer(handler);
  // WS is the browser's primary live-event transport (SSE is the fallback):
  // same auth gate as every request, same hello + history replay as /events
  attachWs(server, {
    path: '/ws',
    authorize: authorized,
    onOpen(ws, req) {
      const { bridge: b, error } = attachTarget(chatParamOf(req && req.url));
      replayTo(ev => ws.send(JSON.stringify(ev)), b, error);
      b.wsClients.add(ws);
      ws.onclose = () => { b.wsClients.delete(ws); b.lastUsed = Date.now(); };
    },
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Council live at http://localhost:${PORT} — workspace: ${ROOT}`);
    if (GATED) console.log('hosted mode: password-gated (COUNCIL_PASSWORD)');
    if (NO_AUTH && HOSTED) console.log('WARNING: --no-auth — this server answers ANYONE who reaches it');
  });
  // heartbeat: keeps tunnel/proxy connections warm and lets dead clients
  // surface — an SSE comment (EventSource ignores it) and a WS ping event
  setInterval(() => {
    for (const b of bridges.values()) {
      for (const res of b.clients) res.write(': ping\n\n');
      for (const ws of b.wsClients) ws.send('{"type":"ping"}');
    }
  }, SSE_HEARTBEAT_MS).unref();
}
