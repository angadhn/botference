#!/usr/bin/env node
// Companion server for the Botference Web Annotator browser extension.
// Holds the annotations (store.mjs), drives the bots (chat.mjs), exports to
// Obsidian (export.mjs) and streams live turn events to the extension's
// background service worker over WS (SSE as fallback).
//
// Loopback only by default, no auth, no CORS headers: every request comes from
// the extension's background worker, which bypasses CORS and is the only thing
// that can reach 127.0.0.1:4189 in the first place.
//
// --hosted opens the same server to other people over a tunnel (see
// hosted.mjs): password gate + HMAC cookie for browsers, bearer token for the
// remote extension, CORS answered, and a server-rendered reading room at
// /pages and /p/<pageKey> for collaborators with no extension at all.
// Localhost stays the owner and stays unauthenticated.
//
// Run:    node frontends/plugin/server.mjs
// Flags:  --no-agents   never spawn the bridge (annotations still work)
//         --hosted      shared-URL mode; requires PLUGIN_PASSWORD
// Env:    PORT, BOTFERENCE_PROJECT_ROOT, BOTFERENCE_HOME,
//         PLUGIN_PASSWORD (hosted: the shared password),
//         PLUGIN_OWNER_PASSWORD (hosted, optional: signs the owner in remotely),
//         PLUGIN_BRIDGE_CMD (tests: JSON argv array replacing the python bridge)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWs } from '../review/ws.mjs';
import * as store from './store.mjs';
import { createChat, hasMention, priorMsgs, commentsDigest } from './chat.mjs';
import { exportPage, exportMode } from './export.mjs';
import { createHosted, CORS_HEADERS } from './hosted.mjs';
import { pageView, pagesView, articleView } from './views.mjs';
import { sanitizeArticle } from './sanitize.mjs';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
// The article view's scripts. anchor.js is the extension's own file, served
// unchanged: the phone must anchor by exactly the code the Mac anchors by, or
// a highlight made in one place would not be found in the other.
const ASSETS = {
  'anchor.js': path.join(PLUGIN, 'extension', 'anchor.js'),
  'reader.js': path.join(PLUGIN, 'reader.js'),
};
const PORT = Number(process.env.PORT || 4189);
const NO_AGENTS = process.argv.includes('--no-agents');
const HOSTED = process.argv.includes('--hosted');
if (HOSTED && !process.env.PLUGIN_PASSWORD) {
  console.error('--hosted requires PLUGIN_PASSWORD to be set, e.g.  PLUGIN_PASSWORD=… botference plugin --hosted');
  console.error("(or use 'botference plugin --share', which generates one and opens a tunnel for you)");
  process.exit(1);
}
// identity, auth and the guest-agent budget all live in one place
const hosted = createHosted({
  hosted: HOSTED,
  dir: store.DIR,
  ownerHandle: () => store.readConfig().author,
  password: process.env.PLUGIN_PASSWORD || '',
  ownerPassword: process.env.PLUGIN_OWNER_PASSWORD || '',
});
const NO_GRANT_REASON = "the owner hasn't granted you bot access";
const AGENTS_OFF_REASON = 'agents are off on this companion';
const AGENTS_OFF_ERROR = "agents are off — restart 'botference plugin' with claude/codex CLIs available";
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS) || 15000;
const JSON_HEAD = { 'content-type': 'application/json', 'cache-control': 'no-store' };
// article_text rides along with mentions, and a .docx may ride with them too —
// base64 of an 8MB document is ~11MB of request body, so the wire limit sits
// above the document limit, not at it
const DOCX_MAX = 8 * 1024 * 1024;
const BODY_MAX = 12 * 1024 * 1024;

// --- one companion per workspace: pid lock (same pattern as the council) ---
const lockFile = path.join(store.ROOT, '.botference', 'plugin-web.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
function acquireLock() {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (fs.existsSync(lockFile)) {
    let l = null;
    try { l = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { }
    if (l && l.pid !== process.pid && alive(l.pid)) {
      console.error(`another Discuss companion is attached to this workspace (pid ${l.pid}) — close it first`);
      process.exit(1);
    }
  }
  fs.writeFileSync(lockFile, JSON.stringify({ frontend: 'plugin-web', pid: process.pid, started: new Date().toISOString() }));
  process.on('exit', () => { try { fs.unlinkSync(lockFile); } catch { } });
}

// --- live events --------------------------------------------------------
const sseClients = new Set();
const wsClients = new Set();
function broadcast(ev) {
  const json = JSON.stringify(ev);
  for (const res of sseClients) res.write(`data: ${json}\n\n`);
  for (const ws of wsClients) ws.send(json);
}
function sseOpen(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
}

// --- the bridge ---------------------------------------------------------
// A bot reply reaches the drawer only after it is on disk: the server owns
// persistence, chat.mjs only reports what the bots said. So a /page refetch
// after turn-end always agrees with what streamed.
const chat = NO_AGENTS ? null : createChat({ onEvent: onChatEvent });
// what the agents panel renders: the bridge's own model/effort/occupancy, plus
// the one setting the companion owns (verbosity). Assembled in one place so
// GET /models and every `models` broadcast agree field for field.
const EMPTY_MODELS = { current: null, options: null, status: null, effort: null };
function modelsPayload() {
  const m = chat ? chat.models() : EMPTY_MODELS;
  return {
    current: m.current, options: m.options, status: m.status, effort: m.effort,
    verbosity: store.readConfig().verbosity,
  };
}
function onChatEvent(ev) {
  // chat.mjs knows nothing about config.json; the verbosity a tab renders
  // rides the same event as everything else in that panel
  if (ev.type === 'models') return broadcast({ ...ev, verbosity: store.readConfig().verbosity });
  if (ev.type === 'chat' && ev.kind === 'reply') {
    const page = store.readPage(ev.url);
    if (page) {
      store.appendMsg(page, ev.target, ev.msg);
      store.savePage(page);
    }
    broadcast(ev);
    broadcast({ type: 'page', url: ev.url });
    return;
  }
  broadcast(ev);
}

// A guest's mention spends the OWNER's agents on the owner's machine, so it is
// off by default and metered when on: grants.json is hand-edited, re-read on
// every mention, and the daily counter is a budget, not an attendance log.
// The message itself is always kept — a refusal loses the comment nowhere.
function guestRefusal(me) {
  if (!HOSTED || me.owner) return null;
  const grant = hosted.grantFor(me.handle);
  if (!grant) return NO_GRANT_REASON;
  const used = hosted.grantUsed(me.handle);
  if (used >= grant.daily_cap) return `you have used today's agent budget (${used} of ${grant.daily_cap})`;
  hosted.grantSpend(me.handle);
  return null;
}

// an @-mention in any message — first comment or tenth reply — is the only
// thing that summons the bots
function summon(page, target, text, extras = {}, me = { owner: true }) {
  if (!hasMention(text)) return {};
  if (NO_AGENTS) {
    broadcast({ type: 'chat', url: page.url, target, kind: 'error', error: AGENTS_OFF_ERROR });
    return { queued: false, reason: AGENTS_OFF_REASON };
  }
  const refused = guestRefusal(me);
  if (refused) {
    broadcast({ type: 'chat', url: page.url, target, kind: 'error', error: refused });
    return { queued: false, reason: refused };
  }
  const { position, wait } = chat.submit({
    url: page.url, target, text, title: page.title,
    // on a shared page the bots are answering a room, not one reader: name
    // whoever is asking, unless it is the owner (whose annotator never did)
    asker: me.owner ? '' : me.handle,
    quote: target === store.PAGE_CHAT ? '' : (store.findThread(page, target) || {}).quote,
    history: priorMsgs(page, target),
    ...extras,
  });
  // `wait` is what the drawer says while it waits: bridge_starting (the agents
  // are being woken) or busy (another chat has the floor). Absent = the turn is
  // already running and turn-start is about to say so.
  return { queued: true, position, ...(wait ? { wait } : {}) };
}

// A .docx may ride along with any mention (the reader is annotating a doc and
// wants the bots to see what everyone else already said in its margins). It is
// read for this turn only: the digest goes in the envelope and nowhere else.
// Returns null when the request has already been refused.
function docxDigestOf(res, data, text) {
  if (!data.docx_b64) return '';
  const buf = Buffer.from(String(data.docx_b64), 'base64');
  if (buf.length > DOCX_MAX) { fail(res, 413, 'document too large — 8MB max'); return null; }
  return hasMention(text) ? commentsDigest(buf) : '';
}
const contextExtras = (data, docxDigest) => ({
  articleText: data.article_text,
  articleChanged: !!data.article_changed,
  docxDigest,
});

// --- the double-click guard ---------------------------------------------
// A send over a tunnel can take a second, the button gives no receipt, and
// hands are fast: the same comment arrives twice. The second copy is not a
// second thought — same author, same words, same thread, seconds apart — so it
// is swallowed and the first message is echoed back. Crucially it also queues
// NO second bot turn: the expensive half of a double-click is the agent run.
// Memory only: a repeat after a restart is a repeat the reader meant.
const DEDUPE_MS = 10000;
const recentSends = new Map();
function dedupeCheck(parts) {
  const key = parts.map(p => String(p ?? '')).join('\0');
  const now = Date.now();
  for (const [k, v] of recentSends) if (now - v.at > DEDUPE_MS) recentSends.delete(k);
  const hit = recentSends.get(key);
  return {
    hit: hit ? hit.value : null,
    remember(value) { recentSends.set(key, { at: now, value }); },
  };
}

// --- HTTP helpers -------------------------------------------------------
const ok = (res, obj) => res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, ...obj }));
const fail = (res, code, error) => res.writeHead(code, JSON_HEAD).end(JSON.stringify({ ok: false, error }));
// /edit, /tick and /delete address a message by timestamp, and a timestamp is
// not an identity: whole milliseconds, and a bot's tools summary and its answer
// always share one. So those bodies may carry `author` and `kind` beside the
// `ts` (see store.resolveMsg), and where a client sends no author the endpoints
// that only ever touch your own message fall back to yours.
const pick = (data, fallbackAuthor = null) => ({
  ts: data.ts,
  author: data.author != null && data.author !== '' ? data.author : fallbackAuthor,
  kind: data.kind,
});
// The reading room posts plain HTML forms to the same endpoints the drawer
// calls with JSON. One write path, two encodings: `_form` marks which, so the
// answer can be a redirect back to the page instead of a wall of JSON.
const isForm = req => /^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '');
function readBody(req, res, fn) {
  let body = '';
  let over = false;
  const form = isForm(req);
  req.on('data', c => {
    if (over) return;
    body += c;
    // answer before hanging up: a dropped socket reads as "the companion is
    // down" in the extension, which is the wrong thing to tell the user
    if (body.length > BODY_MAX) { over = true; fail(res, 413, 'request too large'); req.destroy(); }
  });
  req.on('end', () => {
    if (over) return;
    let data;
    if (form) {
      data = Object.fromEntries(new URLSearchParams(body));
      data._form = true;
    } else {
      try { data = JSON.parse(body || '{}'); } catch { return fail(res, 400, 'bad json'); }
    }
    fn(data);
  });
}
// a form post lands back on the page it came from, with any refusal to show
const backTo = (data, page, hash, notice) => {
  const to = String(data.redirect || '');
  const base = /^\/p\/[0-9a-f]{40}$/.test(to) ? to : `/p/${store.pageKey(page.url)}`;
  return base + (notice ? `?notice=${encodeURIComponent(notice)}` : '') + (hash ? `#${hash}` : '');
};
const seeOther = (res, location) => res.writeHead(303, { location, 'cache-control': 'no-store' }).end();
const queryUrl = reqUrl => {
  const q = String(reqUrl || '').split('?')[1] || '';
  const m = /(?:^|&)url=([^&]*)/.exec(q);
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
};
// every mutation route needs "the page, or a 404" — except the ones that may
// legitimately create it
function pageOf(res, data) {
  if (!data.url) { fail(res, 400, 'url required'); return null; }
  const page = store.readPage(data.url);
  if (!page) { fail(res, 404, 'unknown page'); return null; }
  return page;
}

// Hosted-mode gatekeepers. In local mode every one of these is a no-op: the
// owner is the only person who can reach the port.
// owner-only: the acts that spend the owner's machine (bots, relays) or write
// outside .botference (the Obsidian vault), plus destroying other people's work
function notOwner(req, res) {
  if (hosted.isOwner(req)) return false;
  req.resume(); // the body is never read: drain it so the client sees the 403
  fail(res, 403, 'owner only — ask the owner to do that');
  return true;
}
// who is writing. A guest with no name (or one that would impersonate the
// owner) is refused before anything is stored.
function authorOf(req, res) {
  const me = hosted.identity(req);
  if (me.error) { fail(res, me.code, me.error); return null; }
  return me;
}

export function handler(req, res) {
  const url = req.url.split('?')[0];
  // CORS, hosted only: the remote extension is cross-origin against a public
  // hostname. Wildcard origin is safe precisely because API auth is a bearer
  // header — a wildcard can never carry the cookie the browsers use.
  if (HOSTED) for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') {
    if (!HOSTED) return fail(res, 404, 'not found');
    return res.writeHead(204, { 'content-length': '0' }).end();
  }
  if (HOSTED && req.method === 'POST' && url === '/auth') return hosted.authEndpoint(req, res);
  // A session in daily use never expires: past half its life it is re-issued
  // on the way past. setHeader (not writeHead) so every route below still
  // writes its own headers normally.
  if (HOSTED) {
    const fresh = hosted.refreshCookies(req);
    if (fresh) res.setHeader('set-cookie', fresh);
  }
  if (HOSTED && url === '/signout') {
    return res.writeHead(303, { 'set-cookie': hosted.signOutCookies(), location: '/pages' }).end();
  }
  if (!hosted.authorized(req)) return hosted.denied(req, res);

  // --- the reading room: collaborators without the extension -------------
  if (req.method === 'GET' && (url === '/' || url === '/pages')) {
    if (url === '/') return res.writeHead(302, { location: '/pages' }).end();
    const index = store.readIndex();
    const snapshots = new Set(Object.keys(index).filter(k => store.hasSnapshot(k)));
    const html = pagesView({ index, me: hosted.identity(req), snapshots });
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  }
  if (req.method === 'GET' && url.startsWith('/p/')) {
    const key = url.slice(3);
    const page = store.readPageByKey(key);
    if (!page) return fail(res, 404, 'unknown page');
    const notice = new URLSearchParams(req.url.split('?')[1] || '').get('notice') || '';
    const html = pageView({
      page, key, me: hosted.identity(req), notice, snapshot: store.hasSnapshot(key),
    });
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  }

  if (req.method === 'GET' && url === '/health') {
    const me = hosted.identity(req);
    return ok(res, {
      bridge: NO_AGENTS ? 'disabled' : chat.state(),
      queue: chat ? chat.queueLength() : 0,
      // hosted only: a remote extension has to know its own standing before it
      // can render (or gray out) the owner's controls
      ...(HOSTED ? { hosted: true, owner: me.owner, handle: me.handle } : {}),
    });
  }
  // the same standing on its own, for a client that only wants to ask "who am I"
  if (req.method === 'GET' && url === '/whoami') {
    const me = hosted.identity(req);
    return ok(res, { hosted: HOSTED, owner: me.owner, handle: me.handle, error: me.error });
  }
  // model picker: what the bots are running on, and what they could run on.
  // Both are null until the bridge has started and spoken — the extension
  // renders that as "unknown yet", never as an empty list.
  if (req.method === 'GET' && url === '/models') {
    return ok(res, { ...modelsPayload(), bridge: NO_AGENTS ? 'disabled' : chat.state() });
  }
  if (req.method === 'GET' && url === '/index') {
    return res.writeHead(200, JSON_HEAD).end(JSON.stringify(store.readIndex()));
  }
  if (req.method === 'GET' && url === '/page') {
    const u = queryUrl(req.url);
    if (!u) return fail(res, 400, 'url required');
    const page = store.readPage(u);
    return page
      ? res.writeHead(200, JSON_HEAD).end(JSON.stringify(page))
      : ok(res, { page: null });
  }
  if (req.method === 'GET' && url === '/events') {
    sseOpen(res);
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  // --- the article itself, for a reader who never visited the page -------
  // The extension posts a snapshot of the prose; the companion sanitizes it
  // (sanitize.mjs) and keeps the latest one. Owner-only: a snapshot is what
  // everyone else then READS, so a guest must not be able to rewrite the
  // article under the owner's highlights.
  if (req.method === 'POST' && url === '/snapshot') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      if (!data.url) return fail(res, 400, 'url required');
      const page = store.readPage(data.url);
      if (!page) return fail(res, 404, 'unknown page');
      const { html, dropped, tooBig } = sanitizeArticle(String(data.html || ''));
      if (tooBig) return ok(res, { stored: false, reason: 'article too large to snapshot' });
      if (!html.trim()) return ok(res, { stored: false, reason: 'nothing readable to snapshot' });
      store.saveSnapshot(data.url, html);
      broadcast({ type: 'page', url: page.url });
      return ok(res, { stored: true, bytes: Buffer.byteLength(html), dropped });
    });
  }
  // the article view's two scripts: the extension's own anchoring code (so the
  // phone anchors exactly as the Mac does) and the reader UI
  if (req.method === 'GET' && url.startsWith('/assets/')) {
    const name = url.slice('/assets/'.length);
    const file = ASSETS[name];
    if (!file) return fail(res, 404, 'not found');
    return fs.readFile(file, (err, buf) => {
      if (err) return fail(res, 404, 'not found');
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      }).end(buf);
    });
  }
  if (req.method === 'GET' && url.startsWith('/a/')) {
    const key = url.slice(3);
    const page = store.readPageByKey(key);
    if (!page) return fail(res, 404, 'unknown page');
    const me = hosted.identity(req);
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = articleView({
      page, key, me, snapshot: store.readSnapshot(key), info: store.snapshotInfo(key), nonce,
    });
    // Belt and braces over the sanitizer: even if something got through, this
    // page can run no script it did not itself nonce, load no stylesheet, and
    // reach no other origin. Images are the one remote thing allowed — an
    // article without them reads poorly — and only over https.
    return res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "img-src https: data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      'referrer-policy': 'no-referrer',
    }).end(html);
  }

  if (req.method === 'GET' && url === '/test-page') {
    return fs.readFile(path.join(PLUGIN, 'test', 'fixtures', 'article.html'), (err, buf) => {
      if (err) return fail(res, 404, 'fixture missing');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(buf);
    });
  }

  if (req.method === 'POST' && url === '/page') {
    return readBody(req, res, data => {
      if (!data.url) return fail(res, 400, 'url required');
      const page = store.upsertPage(data);
      broadcast({ type: 'page', url: page.url });
      res.writeHead(200, JSON_HEAD).end(JSON.stringify(page));
    });
  }
  if (req.method === 'POST' && url === '/thread') {
    return readBody(req, res, data => {
      const text = String((data.msg && data.msg.text) || '');
      if (!data.url) return fail(res, 400, 'url required');
      if (!data.quote) return fail(res, 400, 'quote required');
      if (!text.trim()) return fail(res, 400, 'empty comment');
      const me = authorOf(req, res);
      if (!me) return;
      const docxDigest = docxDigestOf(res, data, text);
      if (docxDigest === null) return; // 413: nothing is saved, nothing is queued
      // a highlight can arrive before any /page upsert (fresh tab, fast hands)
      const page = store.readPage(data.url) || store.upsertPage(data);
      // same person, same words, same highlight, seconds apart: one comment
      const dedupe = dedupeCheck([store.pageKey(page.url), 'thread', me.handle, data.quote, text.trim()]);
      if (dedupe.hit) return ok(res, { thread: dedupe.hit, deduped: true });
      const thread = store.addThread(page, {
        quote: data.quote, prefix: data.prefix, suffix: data.suffix,
        text, author: me.handle, index: data.index,
      });
      dedupe.remember(thread);
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { thread, ...summon(page, thread.id, text, contextExtras(data, docxDigest), me) });
    });
  }
  if (req.method === 'POST' && url === '/reply') {
    return readBody(req, res, data => {
      const text = String(data.text || '');
      if (!text.trim()) return fail(res, 400, 'empty reply');
      const me = authorOf(req, res);
      if (!me) return;
      const docxDigest = docxDigestOf(res, data, text);
      if (docxDigest === null) return;
      const page = pageOf(res, data);
      if (!page) return;
      const target = data.thread_id || store.PAGE_CHAT;
      const dedupe = dedupeCheck([store.pageKey(page.url), target, me.handle, text.trim()]);
      const anchor = target === store.PAGE_CHAT ? '' : target;
      if (dedupe.hit) {
        return data._form
          ? seeOther(res, backTo(data, page, anchor))
          : ok(res, { msg: dedupe.hit, deduped: true });
      }
      const msg = store.appendMsg(page, target, { author: me.handle, text });
      if (!msg) return fail(res, 404, 'unknown thread');
      dedupe.remember(msg);
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      const summoned = summon(page, target, text, contextExtras(data, docxDigest), me);
      // the reading room posted a form: back to the page, carrying any refusal
      if (data._form) return seeOther(res, backTo(data, page, anchor, summoned.reason));
      ok(res, { msg, ...summoned });
    });
  }
  if (req.method === 'POST' && url === '/edit') {
    return readBody(req, res, data => {
      const me = authorOf(req, res);
      if (!me) return;
      const page = pageOf(res, data);
      if (!page) return;
      const msgs = store.msgsOf(page, data.thread_id || store.PAGE_CHAT);
      if (!msgs) return fail(res, 404, 'unknown thread');
      // no author on the wire? this endpoint only ever rewrites your own
      // message, so yours is the right tie-breaker for a shared timestamp
      const found = store.resolveMsg(msgs, pick(data, me.handle));
      if (!found) return fail(res, 404, 'unknown message');
      const msg = found.msg;
      // the bots' words are theirs, and so is every other human's: you may
      // only rewrite what you wrote
      if (msg.author !== me.handle) return fail(res, 403, 'not your message');
      msg.text = String(data.text || '');
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { msg, ...(found.ambiguous ? { ambiguous: true } : {}) });
    });
  }
  // Ticking a checkbox in a message — usually a BOT's message, which is the
  // whole point: a bot proposes a checklist and the reader works through it in
  // the drawer. So unlike /edit there is no author check; only the box
  // character changes, so nothing a bot said can be rewritten this way.
  if (req.method === 'POST' && url === '/tick') {
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const msgs = store.msgsOf(page, data.thread_id || store.PAGE_CHAT);
      if (!msgs) return fail(res, 404, 'unknown thread');
      // a checklist lives in the answer, never in the tools summary stamped
      // the same millisecond — resolveMsg knows that, given no kind
      const found = store.resolveMsg(msgs, pick(data));
      if (!found) return fail(res, 404, 'unknown message');
      const msg = found.msg;
      const text = Number.isInteger(data.index) && data.index >= 0
        ? store.setCheckbox(msg.text, data.index, !!data.checked) : null;
      if (text === null) return fail(res, 400, 'index out of range');
      msg.text = text;
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { text, ...(found.ambiguous ? { ambiguous: true } : {}) });
    });
  }
  if (req.method === 'POST' && url === '/delete') {
    return readBody(req, res, data => {
      const me = authorOf(req, res);
      if (!me) return;
      const page = pageOf(res, data);
      if (!page) return;
      const target = data.thread_id || store.PAGE_CHAT;
      // one resolution for the permission check AND the delete itself, so the
      // two can never disagree about which of two same-millisecond messages
      // this is. A guest who names nobody means themselves.
      const found = data.ts
        ? store.resolveMsg(store.msgsOf(page, target), pick(data, me.owner ? null : me.handle))
        : null;
      // A guest may retract what they wrote and nothing else: sweeping a whole
      // thread (or the page chat) away takes other people's words with it, so
      // that stays the owner's call.
      if (!me.owner) {
        if (!data.ts) return fail(res, 403, 'owner only — you can delete your own messages');
        if (found && found.msg.author !== me.handle) return fail(res, 403, 'not your message');
      }
      let gone = false; // the whole thread went, not just a message
      if (!data.ts) {
        if (target === store.PAGE_CHAT) page.page_chat = [];
        else {
          const i = page.threads.findIndex(t => t.id === target);
          if (i < 0) return fail(res, 404, 'unknown thread');
          page.threads.splice(i, 1);
          gone = true;
        }
      } else {
        const msgs = store.msgsOf(page, target);
        if (!msgs) return fail(res, 404, 'unknown thread');
        if (!found) return fail(res, 404, 'unknown message');
        msgs.splice(found.index, 1);
        // deleting the last message of a thread deletes the thread: an empty
        // one is a highlight on the page that opens onto nothing
        if (target !== store.PAGE_CHAT && !msgs.length) {
          page.threads.splice(page.threads.findIndex(t => t.id === target), 1);
          gone = true;
        }
      }
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { thread_deleted: gone, ...(found && found.ambiguous ? { ambiguous: true } : {}) });
    });
  }
  // Forget a page entirely — record, index row and, if asked, the botference
  // chat behind it. Hard delete on both sides: nothing is archived, because a
  // page the reader deleted from the drawer should not resurface in /resume.
  if (req.method === 'POST' && url === '/delete-page') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const sid = page.session_id || null;
      const wanted = !!data.delete_session && !!sid;
      // a session two pages point at is the inheritance bug, not a shared
      // chat: deleting it would take the other page's conversation with it
      if (wanted) {
        const other = store.pageWithSession(sid, page.url);
        if (other) return fail(res, 409, `that chat is also claimed by ${other} — its session was left alone`);
      }
      let session_deleted = false;
      if (wanted) {
        // a live bridge owns the session store (it holds the chat in memory
        // and would rewrite the file on its next save): ask it to delete.
        // Stopped, nobody owns the file and we can remove it ourselves.
        if (chat && chat.state() === 'running') { chat.control(`/delete ${sid}`); session_deleted = true; }
        else session_deleted = store.deleteSessionFile(sid);
      }
      store.deletePage(page.url);
      broadcast({ type: 'page', url: page.url });
      ok(res, { session_deleted });
    });
  }
  if (req.method === 'POST' && url === '/orphan') {
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const thread = store.findThread(page, data.thread_id);
      if (!thread) return fail(res, 404, 'unknown thread');
      thread.orphaned = !!data.orphaned;
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { thread });
    });
  }
  // the export writes into the OWNER's Obsidian vault, on the owner's disk:
  // never something a guest can trigger
  if (req.method === 'POST' && url === '/export') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      // `mode` decides what goes in the note: "comments" is the reading
      // without the conversation (see export.mjs). Anything unrecognised —
      // including an older extension that sends nothing — means everything,
      // which is what /export has always done.
      const mode = exportMode(data.mode);
      try { ok(res, { path: exportPage(page, store.readConfig(), new Date(), mode), mode }); }
      catch (e) { fail(res, 500, `export failed: ${e.message}`); }
    });
  }
  if (req.method === 'POST' && url === '/model') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const agent = String(data.agent || '');
      const model = String(data.model || '');
      if (agent !== 'claude' && agent !== 'codex') return fail(res, 400, 'agent must be claude or codex');
      if (!/^[\w.-]+$/.test(model)) return fail(res, 400, 'bad model id');
      if (NO_AGENTS) return fail(res, 409, AGENTS_OFF_REASON);
      // when the bridge has published its lists, the model must be on them;
      // before that we forward blind and let the bridge refuse
      const options = (chat.models().options || {})[agent];
      if (options && options.length && !options.includes(model)) return fail(res, 400, `unknown model for ${agent}`);
      chat.control(`/model @${agent} ${model}`);
      ok(res, { queued: true });
    });
  }
  // reasoning effort: the same picker shape as /model, but the bridge never
  // reports the live level, so the companion is the one keeping score
  if (req.method === 'POST' && url === '/effort') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const agent = String(data.agent || '');
      const level = String(data.level || '');
      if (agent !== 'claude' && agent !== 'codex') return fail(res, 400, 'agent must be claude or codex');
      if (!/^[\w-]+$/.test(level)) return fail(res, 400, 'bad effort level');
      if (NO_AGENTS) return fail(res, 409, AGENTS_OFF_REASON);
      const options = (chat.models().effort.options || {})[agent];
      if (options && options.length && !options.includes(level)) return fail(res, 400, `unknown effort level for ${agent}`);
      chat.control(`/effort @${agent} ${level}`);
      ok(res, { queued: true });
    });
  }
  // how long the bots' replies should be. A companion setting, not a bridge
  // one: it lives in config.json and is enforced in the envelope, so it holds
  // across restarts and applies to the very next turn.
  if (req.method === 'POST' && url === '/verbosity') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const level = String(data.level || '');
      if (!store.VERBOSITY_LEVELS.includes(level)) return fail(res, 400, 'level must be short or long');
      const cfg = store.saveConfig({ verbosity: level });
      broadcast({ type: 'models', ...modelsPayload() });
      ok(res, { verbosity: cfg.verbosity });
    });
  }
  // hand an agent's own context back to it (compaction/handoff). Never worth
  // starting the bridge for: with nothing running there is no context to relay.
  if (req.method === 'POST' && url === '/relay') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const agent = String(data.agent || '');
      if (!['claude', 'codex', 'both'].includes(agent)) return fail(res, 400, 'agent must be claude, codex or both');
      if (NO_AGENTS) return fail(res, 409, AGENTS_OFF_REASON);
      if (chat.state() !== 'running') return fail(res, 409, 'agents are idle — nothing to relay');
      chat.control(`/relay @${agent}`);
      ok(res, { queued: true });
    });
  }
  // stopping a turn stops it for everyone in the room
  if (req.method === 'POST' && url === '/interrupt') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      if (!data.url) return fail(res, 400, 'url required');
      ok(res, { interrupted: !!(chat && chat.interrupt(store.normUrl(data.url))) });
    });
  }
  return fail(res, 404, 'not found');
}

if (process.env.PLUGIN_NO_LISTEN !== '1') {
  acquireLock();
  store.readConfig(); // materialize defaults on first run
  const server = http.createServer(handler);
  attachWs(server, {
    path: '/ws',
    // a browser cannot set headers on an upgrade, so the shared password may
    // ride the query string (?auth=…&handle=…); cookies work too
    authorize: req => hosted.authorized(req),
    onOpen(ws) {
      ws.send(JSON.stringify({ type: 'hello' }));
      wsClients.add(ws);
      ws.onclose = () => wsClients.delete(ws);
    },
  });
  // Ctrl-C / launcher stop: run the exit hooks (lock file) and take the
  // bridge child with us instead of orphaning it
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { if (chat) chat.stop(); process.exit(0); });
  }
  server.listen(PORT, '127.0.0.1', () => {
    const p = server.address().port;
    console.log(`Web annotator companion live at http://127.0.0.1:${p} — workspace: ${store.ROOT}`);
    if (NO_AGENTS) console.log('--no-agents: bots are off; annotations and export still work');
    if (HOSTED) {
      console.log('--hosted: remote visitors need the password; localhost stays the owner');
      console.log(`  reading room: /pages   agent grants: ${hosted.grantsFile}`);
    }
  });
  // heartbeat: dead extension workers surface, live ones stay warm
  setInterval(() => {
    for (const res of sseClients) res.write('data: {"type":"ping"}\n\n');
    for (const ws of wsClients) ws.send('{"type":"ping"}');
  }, HEARTBEAT_MS).unref();
}
