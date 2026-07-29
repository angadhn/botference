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
//                                   repo" page instead of a 502 (or, for
//                                   the owner, a wake-on-request start)
//
// Run it behind ONE named cloudflared tunnel whose DNS routes (the hub
// hostname plus one per paper) all point at this port; adding a paper is
// a toggle in the owner portal — no restarts, no hand-edited config.
//
// Config (JSON, re-read on every request so edits apply live):
//   $REVIEW_HUB_CONFIG or ~/.botference/review-hub.json
//   { "port": 4180, "host": "review.example.com", "name": "Review portal",
//     "workspace": "~/MySiteFromObsidianVault/botference",
//     "portRange": [4181, 4279],
//     "deviceApproval": "ask",
//     "papers": [ { "slug": "acta", "host": "acta.example.com",
//                   "port": 4181, "dir": "/…/acta", "title": "…",
//                   "repo": "https://…", "collaborators": ["ada"] } ] }
//
// "workspace" turns on auto-discovery: every directory under
// <workspace>/projects/ is a review candidate — "scaffolded" once it has
// review/review.config.json, "not set up yet" otherwise — and the owner
// portal lists all of them merged with the explicit `papers` entries
// (explicit entries win on conflicts). The owner toggles a paper on and
// the hub scaffolds it if needed, picks a free port, routes its DNS
// through the tunnel and starts it as a managed service; off stops that
// service by its ledger entry (never by pattern-kill).
//
// A collaborator sees a paper when their login password validates against
// it (forwarded to the paper's own /auth — the hub stores no passwords)
// or their handle is declared in that paper's `collaborators` list (so a
// paper whose server is down still shows, marked offline). Papers the hub
// enables start with a generated guest password and NO collaborators, so
// they are invisible to everyone but the owner until the owner says
// otherwise.
//
// Secrets never live in the config: ~/.botference/.review-hub-secret
// (guest sessions), .review-hub-device-secret (approved owner devices)
// and review-paper-secrets.json (per-paper guest password + the shared
// owner password), all mode 0600.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// config edits are read-modify-write against the file (it is the single
// source of truth and re-read per request), atomically replaced
function writeConfig(mutate) {
  const cfg = config();
  delete cfg._error;
  mutate(cfg);
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_FILE);
  return cfg;
}

const BOOT = config();
const PORT = Number(process.env.PORT || BOOT.port || 4180);

// ── secrets (files beside the config, never the config itself) ───────
const sibling = name => CONFIG_FILE.replace(/[^/\\]+$/, name);
function persistedSecret(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s) return s;
  } catch { }
  const s = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s, { mode: 0o600 });
  } catch (e) {  // unwritable home: still usable, just not across restarts
    console.error(`review hub: could not persist ${file} (${e && e.message})`);
  }
  return s;
}

// hub sessions: HMAC-signed, stateless (same shape as the paper servers'
// auth cookie), secret persisted beside the config so restarts keep guests in
const AUTH_TTL_MS = 7 * 24 * 3600 * 1000;
const SECRET = persistedSecret(sibling('.review-hub-secret'));
// approved owner devices get their own long-lived signing key: rotating
// (deleting) this file revokes every approved device at once
const DEVICE_TTL_MS = 365 * 24 * 3600 * 1000;
const DEVICE_SECRET = persistedSecret(sibling('.review-hub-device-secret'));

// per-paper guest passwords + the one owner password handed to every paper
// as REVIEW_OWNER_PASSWORD, so the owner signs into any paper from any device
const PAPER_SECRETS_FILE = sibling('review-paper-secrets.json');
function paperSecrets() {
  try {
    const s = JSON.parse(fs.readFileSync(PAPER_SECRETS_FILE, 'utf8'));
    return (s && typeof s === 'object') ? s : {};
  } catch { return {}; }
}
function writePaperSecrets(mutate) {
  const s = paperSecrets();
  mutate(s);
  try {
    fs.mkdirSync(path.dirname(PAPER_SECRETS_FILE), { recursive: true });
    const tmp = `${PAPER_SECRETS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, PAPER_SECRETS_FILE);
  } catch (e) {
    console.error(`review hub: could not persist ${PAPER_SECRETS_FILE} (${e && e.message})`);
  }
  return s;
}
// the generated guest password for a paper — created on first enable and
// kept forever after, so restarts don't invalidate what collaborators hold
const MEMO = new Map();
function guestPassword(slug) {
  const s = paperSecrets();
  if (s.papers && s.papers[slug]) return s.papers[slug];
  if (MEMO.has(slug)) return MEMO.get(slug);
  const pw = crypto.randomBytes(8).toString('hex');
  MEMO.set(slug, pw);
  writePaperSecrets(x => {
    x.papers = x.papers || {};
    x.papers[slug] = pw;
  });
  return pw;
}
// optional owner login: with REVIEW_HUB_PASSWORD set, that password (any
// name) opens the full owner view from any device — the phone case, where
// localhost-is-owner can't apply. It doubles as REVIEW_OWNER_PASSWORD for
// every paper the hub starts; without it a persisted one is generated.
const OWNER_PW = process.env.REVIEW_HUB_PASSWORD || '';
function ownerPassword() {
  if (OWNER_PW) return OWNER_PW;
  const s = paperSecrets();
  if (s.owner) return s.owner;
  if (MEMO.has('*owner')) return MEMO.get('*owner');
  const pw = crypto.randomBytes(12).toString('hex');
  MEMO.set('*owner', pw);
  writePaperSecrets(x => { x.owner = pw; });
  return pw;
}

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const sanitizeHandle = h => String(h || '').toLowerCase().replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n = 72) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const expandHome = p => {
  const s = String(p || '');
  if (!s) return '';
  return s.startsWith('~') ? path.join(os.homedir(), s.slice(1)) : s;
};

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
// cookies for the hub hostname have to be readable on the paper subdomains
// too (wake-on-request runs on <paper>.<domain>), so they are scoped to the
// parent domain whenever the hub host has one
function cookieDomain(cfg) {
  const host = String(cfg.host || '').toLowerCase().replace(/:\d+$/, '');
  const labels = host.split('.').filter(Boolean);
  return labels.length >= 3 ? `; Domain=${labels.slice(1).join('.')}` : '';
}
// scoped to the parent domain like hub_device: an owner-password session has
// to be recognisable on <paper>.<domain> for wake-on-request to fire there
function sessionCookie(handle, slugs, req, cfg) {
  const exp = String(Date.now() + AUTH_TTL_MS);
  const body = `${exp}.${handle}.${slugs.join(',')}`;
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `hub_auth=${encodeURIComponent(`${body}.${mac}`)}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${cookieDomain(cfg)}${secure}`;
}
// hub_device = exp.deviceId.mac — an approved browser IS the owner, no password
function deviceSession(req) {
  const raw = decodeURIComponent(cookieOf(req, 'hub_device') || '');
  const m = /^(\d+)\.([0-9a-f]+)\.([0-9a-f]+)$/.exec(raw);
  if (!m || Date.now() > Number(m[1])) return null;
  const mac = crypto.createHmac('sha256', DEVICE_SECRET).update(`${m[1]}.${m[2]}`).digest('hex');
  if (!safeEqual(mac, m[3])) return null;
  return { id: m[2] };
}
function deviceCookie(id, req, cfg) {
  const exp = String(Date.now() + DEVICE_TTL_MS);
  const body = `${exp}.${id}`;
  const mac = crypto.createHmac('sha256', DEVICE_SECRET).update(body).digest('hex');
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `hub_device=${encodeURIComponent(`${body}.${mac}`)}; Max-Age=${Math.floor(DEVICE_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax${cookieDomain(cfg)}${secure}`;
}

// who is asking, on any hostname: localhost and approved devices are the
// owner outright; an owner-password login carries '*'
function viewer(cfg, req) {
  if (isLocalDirect(req)) return { owner: true, local: true, handle: 'owner' };
  if (deviceSession(req)) return { owner: true, device: true, handle: 'owner' };
  const s = session(req);
  if (!s) return null;
  if (s.slugs.includes('*')) return { owner: true, handle: s.handle };
  return { owner: false, handle: s.handle, slugs: s.slugs };
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
    if (!Number(port)) return resolve(false);
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

// ── auto-discovery: the workspace's projects are review candidates ──
const HERE = path.dirname(fileURLToPath(import.meta.url));
function readReviewConfig(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'review', 'review.config.json'), 'utf8')); }
  catch { return null; }
}
function scanWorkspace(cfg) {
  const ws = expandHome(cfg.workspace);
  if (!ws) return [];
  const projects = path.join(ws, 'projects');
  try {
    return fs.readdirSync(projects, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => path.join(projects, d.name))
      .sort();
  } catch { return []; }
}
// every paper the owner can act on: the explicit config entries first (they
// win any slug/dir collision), then whatever the workspace scan turns up
function discover(cfg) {
  const explicit = cfg.papers.map(p => ({ ...p, dir: expandHome(p.dir), explicit: true }));
  const bySlug = new Map(explicit.map(e => [e.slug, e]));
  const byDir = new Map(explicit.filter(e => e.dir).map(e => [e.dir, e]));
  const extra = [];
  for (const dir of scanWorkspace(cfg)) {
    const rcfg = readReviewConfig(dir);
    const slug = sanitizeHandle((rcfg && rcfg.slug) || path.basename(dir));
    const hit = byDir.get(dir) || bySlug.get(slug);
    if (hit) {  // config entry wins, but the scan can fill in what it omitted
      if (!hit.dir) { hit.dir = dir; byDir.set(dir, hit); }
      if (!hit.title && rcfg && rcfg.title) hit.title = rcfg.title;
      continue;
    }
    if (!slug) continue;
    extra.push({
      slug, dir, title: (rcfg && rcfg.title) || path.basename(dir),
      port: 0, host: '', discovered: true,
    });
  }
  for (const e of [...explicit, ...extra]) {
    e.scaffolded = e.dir ? !!readReviewConfig(e.dir) : true;
    e.enabled = !!(Number(e.port) && e.host);
  }
  return [...explicit, ...extra];
}
function findEntry(cfg, key) {
  if (!key) return null;
  const all = discover(cfg);
  return all.find(e => e.slug === key) || all.find(e => e.dir === key) || null;
}

// ── starting and stopping papers ────────────────────────────────────
// Every external command is an overridable binary so the whole lifecycle
// can be exercised against fakes in tests — and so an operator can point
// the hub at a different launcher or cloudflared without editing code.
const BOTFERENCE_BIN = process.env.REVIEW_HUB_BOTFERENCE
  || path.resolve(HERE, '..', '..', 'botference');
const CLOUDFLARED_BIN = process.env.REVIEW_HUB_CLOUDFLARED || 'cloudflared';
const OSASCRIPT_BIN = process.env.REVIEW_HUB_OSASCRIPT || 'osascript';
const TUNNEL_NAME = process.env.REVIEW_HUB_TUNNEL || 'review';

function run(bin, args, opts = {}) {
  return new Promise(resolve => {
    execFile(bin, args, {
      cwd: opts.cwd, timeout: opts.timeout || 180000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...(opts.env || {}) },
    }, (err, stdout, stderr) => resolve({
      ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''),
      error: err ? String(err.message || err) : '',
    }));
  });
}
const shq = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const cmdLine = (bin, args) => [bin, ...args].map(shq).join(' ');
const serviceName = slug => `review-${slug}`.replace(/[^a-z0-9-]/g, '-').slice(0, 32);

// a free port for a newly enabled paper: outside the configured set, the
// hub's own port, and actually bindable right now
function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function assignPort(cfg) {
  const range = Array.isArray(cfg.portRange) && cfg.portRange.length === 2
    ? cfg.portRange.map(Number) : [4181, 4279];
  const taken = new Set(cfg.papers.map(p => Number(p.port)).filter(Boolean));
  taken.add(PORT);
  for (let p = range[0]; p <= range[1]; p++) {
    if (taken.has(p)) continue;
    if (await portFree(p)) return p;
  }
  return 0;
}
// <slug>.<parent domain of the hub host>
function hostFor(cfg, slug) {
  const labels = String(cfg.host || '').toLowerCase().split('.').filter(Boolean);
  const base = cfg.domain || (labels.length >= 3 ? labels.slice(1).join('.') : labels.join('.'));
  return base ? `${slug}.${base}` : '';
}

// in-flight enable/disable jobs, surfaced on the portal and in status.json
const JOBS = new Map();
function job(slug) { return JOBS.get(slug) || null; }

async function enablePaper(cfg, entry) {
  const running = JOBS.get(entry.slug);
  if (running && !running.done) return running;
  const j = { slug: entry.slug, action: 'on', at: Date.now(), done: false, error: '', notes: [], steps: [] };
  JOBS.set(entry.slug, j);
  try { await enableSteps(cfg, entry, j); }
  catch (e) { j.error = String((e && e.message) || e); }
  j.done = true;
  j.finished = Date.now();
  return j;
}

async function enableSteps(cfg, entry, j) {
  const dir = entry.dir;
  if (!dir || !fs.existsSync(dir)) {
    j.error = `no directory on record for '${entry.slug}' — add "dir" to its config entry`;
    return;
  }
  // 1. scaffold when this project has never been set up for review
  if (!readReviewConfig(dir)) {
    j.steps.push('scaffold');
    const r = await run(BOTFERENCE_BIN, ['review', dir, '--setup']);
    if (!r.ok || !readReviewConfig(dir)) {
      j.error = `scaffold failed: ${(r.stderr || r.stdout || r.error).trim().split('\n').pop()}`;
      j.notes.push(cmdLine(BOTFERENCE_BIN, ['review', dir, '--setup']));
      return;
    }
  }
  // 2. port + hostname, reused when this paper already had them
  const existing = cfg.papers.find(p => p.slug === entry.slug) || null;
  const port = Number(existing && existing.port) || Number(entry.port) || await assignPort(cfg);
  if (!port) { j.error = 'no free port in the configured range'; return; }
  const host = (existing && existing.host) || entry.host || hostFor(cfg, entry.slug);
  const isNew = !existing || !existing.host;
  j.port = port; j.host = host;

  // 3. DNS through the named tunnel, once per new hostname. A failure here
  // is not fatal: the paper still serves locally and the owner gets the
  // exact command to run by hand.
  if (isNew && host) {
    j.steps.push('dns');
    const dnsArgs = ['tunnel', 'route', 'dns', TUNNEL_NAME, host];
    const r = await run(CLOUDFLARED_BIN, dnsArgs, { timeout: 60000 });
    if (!r.ok) {
      j.notes.push(`DNS route not created — run this yourself: ${cmdLine(CLOUDFLARED_BIN, dnsArgs)}`);
    }
  }

  // 4. start it hosted, as a managed service, with its own generated guest
  // password and the hub's owner password. New papers get NO collaborators:
  // nobody but the owner can see or reach them until the owner says so.
  j.steps.push('start');
  const args = ['review', dir, '--hosted', '--service', '--port', String(port),
    '--service-name', serviceName(entry.slug)];
  const r = await run(BOTFERENCE_BIN, args, {
    cwd: dir,
    env: {
      REVIEW_PASSWORD: guestPassword(entry.slug),
      REVIEW_OWNER_PASSWORD: ownerPassword(),
      BOTFERENCE_PROJECT_ROOT: dir,
    },
  });
  const already = /already running/i.test(r.stdout + r.stderr);
  if (!r.ok && !already) {
    j.error = `could not start the review service: ${(r.stderr || r.stdout || r.error).trim().split('\n').pop()}`;
    j.notes.push(cmdLine(BOTFERENCE_BIN, args));
    return;
  }
  // 5. record it only once it is actually up: slug, host, port and dir
  writeConfig(c => {
    const p = c.papers.find(x => x.slug === entry.slug);
    if (p) {
      p.host = p.host || host;
      p.port = port;
      p.dir = p.dir || dir;
      if (!Array.isArray(p.collaborators)) p.collaborators = [];
    } else {
      c.papers.push({
        slug: entry.slug, host, port, dir,
        title: entry.title || entry.slug,
        collaborators: [],   // default privacy: owner only until declared
      });
    }
  });
}

async function disablePaper(cfg, entry) {
  const running = JOBS.get(entry.slug);
  if (running && !running.done) return running;
  const j = { slug: entry.slug, action: 'off', at: Date.now(), done: false, error: '', notes: [], steps: ['stop'] };
  JOBS.set(entry.slug, j);
  const dir = entry.dir;
  if (!dir) {
    j.error = `no directory on record for '${entry.slug}' — stop it by hand from its own directory`;
  } else {
    // the service ledger is per-directory: stop from the paper's own dir, by
    // its recorded pid. Never a pattern kill.
    const args = ['service', 'stop', serviceName(entry.slug)];
    const r = await run(BOTFERENCE_BIN, args, {
      cwd: dir, timeout: 60000, env: { BOTFERENCE_PROJECT_ROOT: dir },
    });
    if (!r.ok) {
      j.error = (r.stderr || r.stdout || r.error).trim().split('\n').pop() || 'stop failed';
      j.notes.push(`run this in ${dir}: ${cmdLine(BOTFERENCE_BIN, args)}`);
    }
  }
  j.done = true;
  j.finished = Date.now();
  return j;
}

// ── owner device approval (passwordless) ────────────────────────────
const PENDING = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;
function sweepPending() {
  const now = Date.now();
  for (const [id, p] of PENDING) if (now - p.at > PENDING_TTL_MS) PENDING.delete(id);
}
function askOwner(p) {
  // a notification so it is noticed, then a dialog that IS the decision.
  // Fire and forget: the answer lands on the pending record, which the
  // waiting browser is polling. Owner can also decide from the portal on
  // localhost, which is the fallback when osascript is unavailable.
  const detail = `IP ${p.ip}\n${clip(p.ua, 60)}`;
  const script = `display notification ${JSON.stringify(detail)} with title "Review hub" `
    + `subtitle "A new device wants owner access"\n`
    + `display dialog ${JSON.stringify(`Approve this device for the review portal?\n\n${detail}`)} `
    + `with title "Review hub" buttons {"Deny", "Approve"} default button "Approve" `
    + `giving up after ${Math.floor(PENDING_TTL_MS / 1000)}`;
  run(OSASCRIPT_BIN, ['-e', script], { timeout: PENDING_TTL_MS + 5000 }).then(r => {
    const cur = PENDING.get(p.id);
    if (!cur || cur.state !== 'pending') return;
    if (/button returned:\s*Approve/i.test(r.stdout)) cur.state = 'approved';
    else if (/button returned:\s*Deny/i.test(r.stdout)) cur.state = 'denied';
    else if (!r.ok) cur.prompt = `could not ask on this machine (${OSASCRIPT_BIN})`;
  });
}
function newPending(req) {
  sweepPending();
  const p = {
    id: crypto.randomBytes(16).toString('hex'),
    at: Date.now(), state: 'pending',
    ip: String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?'),
    ua: String(req.headers['user-agent'] || 'unknown browser'),
  };
  PENDING.set(p.id, p);
  askOwner(p);
  return p;
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
main.wide { width:min(44rem,94vw) }
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
.blank { background:transparent; box-shadow:inset 0 0 0 1px var(--muted) }
.local { font-size:.78rem } .signout { margin-top:1.4rem; font-size:.78rem }
.row { display:flex; align-items:flex-start; gap:.8rem }
.row .grow { flex:1; min-width:0 }
form.toggle { all:unset; display:inline }
form.toggle button { margin:0; width:auto; padding:.25rem .8rem; font-size:.78rem;
  border-radius:999px; background:transparent; color:var(--accent);
  border:1px solid var(--line); cursor:pointer }
form.toggle button:hover { background:var(--accent); color:#fff }
.pw { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.75rem }
.note { font-size:.75rem; color:var(--accent); margin-top:.3rem; word-break:break-all }
a { color:var(--accent) }`;
const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${head}
<title>${escHtml(title)}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;
const HTML_HEAD = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const JSON_HEAD = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const refresh = secs => `<meta http-equiv="refresh" content="${secs}">`;

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
<div class="signout"><a href="/device/request">this is my own machine — ask the owner to approve it</a></div>
</form>`);
}

// the offline stand-in served on a paper's own hostname when its server is down
function offlinePage(paper) {
  const title = paper.title || paper.slug;
  return page(title, `<main>
<h1>${escHtml(clip(title))}</h1>
<p>The live review server for this paper is offline right now.</p>
<p>You can keep working from the git repository${paper.repo
    ? ` — <a href="${escHtml(paper.repo)}">${escHtml(paper.repo)}</a>` : ''}:
clone it and run the review locally (see the README), and push your comments
with <code>node review/submit.mjs --push</code>. Your work merges when the
live review returns.</p>
</main>`);
}

// wake-on-request: the owner asked for a paper whose server is down, so it
// is coming up behind this page
function startingPage(paper, j) {
  const title = paper.title || paper.slug;
  const note = j && j.error ? `<div class="note">${escHtml(j.error)}</div>` : '';
  const notes = j && j.notes && j.notes.length
    ? j.notes.map(n => `<div class="note">${escHtml(n)}</div>`).join('') : '';
  return page(`Starting ${title}`, `<main>
<h1>${escHtml(clip(title))}</h1>
<p>Starting this review — first run also builds the site, so give it a few
seconds. This page refreshes itself.</p>
${note}${notes}
</main>`, refresh(5));
}

function waitingPage(p) {
  if (!p) {
    return page('Approval expired', `<main><h1>Approval expired</h1>
<p>That approval request timed out. <a href="/">Try again</a> — the owner has
a few minutes to answer.</p></main>`);
  }
  if (p.state === 'denied') {
    return page('Not approved', `<main><h1>Not approved</h1>
<p>The owner denied this device. <a href="/">Sign in with a password</a> instead.</p></main>`);
  }
  return page('Waiting for approval', `<main>
<h1>Waiting for approval</h1>
<p>Asking the owner's machine to approve this browser. Leave this page open —
once approved, this device stays the owner for a year.</p>
${p.prompt ? `<div class="note">${escHtml(p.prompt)} — approve it from the portal on the machine itself.</div>` : ''}
</main>`, `<meta http-equiv="refresh" content="3;url=/device/wait?id=${encodeURIComponent(p.id)}">`);
}

// guest list: only the enabled papers this login opens
async function listPage(cfg, papers, who, res, remote = false) {
  const status = await Promise.all(papers.map(p => probe(p.port)));
  const items = papers.map((p, i) => {
    const live = status[i];
    return `<li><span class="dot ${live ? 'live' : 'down'}"></span><a href="${escHtml(`https://${p.host}/`)}">${escHtml(clip(p.title || p.slug))}</a>
<div class="meta">${escHtml(p.host)}${live ? '' : ' — offline (work from the git repo; it merges when the share returns)'}</div></li>`;
  }).join('');
  res.writeHead(200, HTML_HEAD).end(page(cfg.name || 'Review portal', `<main>
<h1>${escHtml(cfg.name || 'Review portal')}</h1>
<p>signed in as <b>${escHtml(who)}</b></p>
${papers.length ? `<ul class="papers">${items}</ul>` : '<p>No reviews here for this login.</p>'}
${remote ? '<div class="signout"><a href="/signout">sign out</a></div>' : ''}
</main>`));
}

// owner list: everything on this machine — running, stopped, and the
// projects that were never set up — each with its on/off toggle
async function ownerPage(cfg, req, res, remote) {
  const entries = discover(cfg);
  const status = await Promise.all(entries.map(e => probe(e.port)));
  const secrets = paperSecrets().papers || {};
  const localLinks = !remote;  // dead weight on a phone
  const items = entries.map((e, i) => {
    const live = status[i];
    const j = job(e.slug);
    const busy = j && !j.done;
    const state = !e.scaffolded ? 'not set up yet'
      : live ? 'running' : e.enabled ? 'stopped' : 'scaffolded — not published';
    const dot = live ? 'live' : e.scaffolded ? 'down' : 'blank';
    const name = escHtml(clip(e.title || e.slug));
    const title = e.enabled ? `<a href="${escHtml(`https://${e.host}/`)}">${name}</a>` : `<b>${name}</b>`;
    const bits = [escHtml(e.host || e.slug), state];
    if (live && localLinks) bits.push(`<a class="local" href="http://localhost:${e.port}/">localhost:${e.port}</a>`);
    if (e.dir) bits.push(`<span class="pw">${escHtml(clip(e.dir, 46))}</span>`);
    const pw = secrets[e.slug]
      ? `<div class="meta">guest password <span class="pw">${escHtml(secrets[e.slug])}</span> · collaborators: ${(e.collaborators || []).length
        ? escHtml((e.collaborators || []).join(', ')) : 'none — private to you'}</div>` : '';
    const notes = j && j.done && (j.error || j.notes.length)
      ? [j.error, ...j.notes].filter(Boolean).map(n => `<div class="note">${escHtml(n)}</div>`).join('') : '';
    const action = live ? 'off' : 'on';
    const label = busy ? (j.action === 'on' ? 'starting…' : 'stopping…') : (live ? 'turn off' : 'turn on');
    const toggle = busy ? `<span class="meta">${label}</span>`
      : `<form class="toggle" method="POST" action="/toggle"><input type="hidden" name="slug" value="${escHtml(e.slug)}"><input type="hidden" name="action" value="${action}"><button>${label}</button></form>`;
    return `<li><div class="row"><div class="grow">
<span class="dot ${dot}"></span>${title}
<div class="meta">${bits.join(' · ')}</div>${pw}${notes}
</div>${toggle}</div></li>`;
  }).join('');
  const head = cfg._error ? `<div class="note">config error: ${escHtml(cfg._error)}</div>` : '';
  const pend = [...PENDING.values()].filter(p => p.state === 'pending');
  const approvals = (!remote && pend.length) ? `<ul class="papers">${pend.map(p => `<li><div class="row"><div class="grow">
<b>A device wants owner access</b><div class="meta">${escHtml(p.ip)} · ${escHtml(clip(p.ua, 50))}</div></div>
<form class="toggle" method="POST" action="/device/decide"><input type="hidden" name="id" value="${escHtml(p.id)}"><input type="hidden" name="decision" value="approve"><button>approve</button></form>
<form class="toggle" method="POST" action="/device/decide"><input type="hidden" name="id" value="${escHtml(p.id)}"><input type="hidden" name="decision" value="deny"><button>deny</button></form>
</div></li>`).join('')}</ul>` : '';
  res.writeHead(200, HTML_HEAD).end(page(cfg.name || 'Review portal', `<main class="wide">
<h1>${escHtml(cfg.name || 'Review portal')}</h1>
<p>owner view — every configured paper${cfg.workspace ? ' and every project in the workspace' : ''}</p>
${head}${approvals}
${entries.length ? `<ul class="papers">${items}</ul>` : '<p>No papers configured and nothing discovered.</p>'}
${remote ? '<div class="signout"><a href="/signout">sign out</a></div>' : ''}
</main>`, JOBS.size && [...JOBS.values()].some(j => !j.done) ? refresh(4) : ''));
}

// ── transparent reverse proxy for a paper hostname ──────────────────
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
function proxy(cfg, paper, req, res) {
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
    if (res.headersSent) return res.destroy();
    // wake-on-request: the owner gets it started, everyone else gets the
    // friendly offline page (starting a paper is never a guest's decision)
    const v = viewer(cfg, req);
    if (v && v.owner) {
      const entry = findEntry(cfg, paper.slug);
      const j = job(paper.slug);
      // don't stampede: one job at a time, and give a just-finished start a
      // few seconds to bind before the refreshing page asks again
      const busy = j && (!j.done
        || (j.action === 'on' && Date.now() - j.finished < 8000));
      if (entry && !busy) enablePaper(cfg, entry);
      return res.writeHead(503, HTML_HEAD).end(startingPage(paper, job(paper.slug)));
    }
    res.writeHead(503, HTML_HEAD).end(offlinePage(paper));
  });
  req.pipe(up);
  res.on('close', () => up.destroy());
}

// ── portal (hub hostname or localhost) ──────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(body)));
  });
}

async function portal(cfg, req, res) {
  const url = (req.url || '/').split('?')[0];
  const query = new URLSearchParams((req.url || '').split('?')[1] || '');
  const v = viewer(cfg, req);
  const remote = !isLocalDirect(req);

  // owner-only: the on/off toggles and the machine-readable state behind them
  if (url === '/toggle' && req.method === 'POST') {
    if (!v || !v.owner) { res.writeHead(403, HTML_HEAD).end(page('Not allowed', '<main><h1>Not allowed</h1></main>')); return; }
    const form = await readBody(req);
    const entry = findEntry(cfg, sanitizeHandle(form.get('slug') || ''));
    if (entry) {
      // fire and forget — scaffolding and building take far longer than a
      // browser will wait; the portal polls the job
      if (form.get('action') === 'off') disablePaper(cfg, entry);
      else enablePaper(cfg, entry);
    }
    res.writeHead(303, { location: '/' }).end();
    return;
  }
  if (url === '/status.json') {
    if (!v || !v.owner) { res.writeHead(403, JSON_HEAD).end(JSON.stringify({ error: 'owner only' })); return; }
    const entries = discover(cfg);
    const status = await Promise.all(entries.map(e => probe(e.port)));
    res.writeHead(200, JSON_HEAD).end(JSON.stringify({
      name: cfg.name || 'Review portal', workspace: cfg.workspace || '',
      papers: entries.map((e, i) => ({
        slug: e.slug, title: e.title || e.slug, host: e.host || '', port: Number(e.port) || 0,
        dir: e.dir || '', scaffolded: !!e.scaffolded, enabled: !!e.enabled, running: status[i],
        explicit: !!e.explicit, discovered: !!e.discovered, collaborators: e.collaborators || [],
        job: job(e.slug) || null,
      })),
    }, null, 2));
    return;
  }

  // ── device approval ────────────────────────────────────────────
  if (url === '/device/request') {
    if (!remote) { res.writeHead(303, { location: '/' }).end(); return; }
    if (rateLimited(req)) {
      res.writeHead(429, HTML_HEAD).end(page('Slow down', '<main><h1>Slow down</h1><p>Too many attempts — wait a minute.</p></main>'));
      return;
    }
    const p = newPending(req);
    res.writeHead(200, HTML_HEAD).end(waitingPage(p));
    return;
  }
  if (url === '/device/wait') {
    sweepPending();
    const p = PENDING.get(query.get('id') || '');
    if (p && p.state === 'approved') {
      PENDING.delete(p.id);
      res.writeHead(303, { 'set-cookie': deviceCookie(p.id, req, cfg), location: '/' }).end();
      return;
    }
    res.writeHead(p ? 200 : 403, HTML_HEAD).end(waitingPage(p || null));
    return;
  }
  if (url === '/device/decide' && req.method === 'POST') {
    // the fallback path: the owner decides from the portal on the machine
    // itself (or from an already-approved device) when no dialog appeared
    if (!v || !v.owner) { res.writeHead(403, HTML_HEAD).end(page('Not allowed', '<main><h1>Not allowed</h1></main>')); return; }
    const form = await readBody(req);
    const p = PENDING.get(form.get('id') || '');
    if (p) p.state = form.get('decision') === 'approve' ? 'approved' : 'denied';
    res.writeHead(303, { location: '/' }).end();
    return;
  }

  if (isLocalDirect(req)) {  // the owner's machine: no login, everything shown
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return ownerPage(cfg, req, res, false);
    }
    res.writeHead(404, HTML_HEAD).end(page('Not found', '<main><h1>Not found</h1></main>'));
    return;
  }
  if (req.method === 'POST' && url === '/auth') {
    if (rateLimited(req)) {
      res.writeHead(429, HTML_HEAD).end(gatePage(cfg.name || 'Review portal', 'too many attempts — wait a minute', ''));
      return;
    }
    const form = await readBody(req);
    const handle = sanitizeHandle(form.get('handle') || '');
    const password = form.get('password') || '';
    if (!handle) {
      res.writeHead(401, HTML_HEAD).end(gatePage(cfg.name || 'Review portal', 'enter your name', form.get('handle')));
      return;
    }
    // the hub owner password (env or generated) outranks the per-paper
    // checks: full list, from any device
    if (safeEqual(password, ownerPassword())) {
      res.writeHead(303, { 'set-cookie': sessionCookie(handle, ['*'], req, cfg), location: '/' }).end();
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
    res.writeHead(303, { 'set-cookie': sessionCookie(handle, slugs, req, cfg), location: '/' }).end();
    return;
  }
  if (url === '/signout') {
    res.writeHead(303, {
      'set-cookie': [`hub_auth=; Max-Age=0; Path=/${cookieDomain(cfg)}`,
        `hub_device=; Max-Age=0; Path=/${cookieDomain(cfg)}`],
      location: '/',
    }).end();
    return;
  }
  if (!v) {
    res.writeHead(401, HTML_HEAD).end(gatePage(cfg.name || 'Review portal', false, ''));
    return;
  }
  if (v.owner) return ownerPage(cfg, req, res, true);
  // their papers: password-validated at login, plus any they are declared on
  const mine = cfg.papers.filter(p =>
    v.slugs.includes(p.slug) || (p.collaborators || []).includes(v.handle));
  return listPage(cfg, mine, v.handle, res, true);
}

const server = http.createServer((req, res) => {
  const cfg = config();
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const paper = cfg.papers.find(p => (p.host || '').toLowerCase() === host);
  if (paper) return proxy(cfg, paper, req, res);
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
  const found = discover(cfg).length - cfg.papers.length;
  console.log(`review hub on http://localhost:${PORT}/ — ${cfg.papers.length} paper(s)` +
    (found > 0 ? `, ${found} more discovered` : '') +
    (cfg._error ? `  [config error: ${cfg._error}]` : ''));
});
