#!/usr/bin/env node
// Companion server for the Botference Web Annotator browser extension.
// Holds the annotations (store.mjs), drives the bots (chat.mjs), exports to
// Obsidian (export.mjs) and streams live turn events to the extension's
// background service worker over WS (SSE as fallback).
//
// Loopback only, no auth, no CORS headers: every request comes from the
// extension's background worker, which bypasses CORS and is the only thing
// that can reach 127.0.0.1:4189 in the first place.
//
// Run:    node frontends/plugin/server.mjs
// Flags:  --no-agents   never spawn the bridge (annotations still work)
// Env:    PORT, BOTFERENCE_PROJECT_ROOT, BOTFERENCE_HOME,
//         PLUGIN_BRIDGE_CMD (tests: JSON argv array replacing the python bridge)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWs } from '../review/ws.mjs';
import * as store from './store.mjs';
import { createChat, hasMention, priorMsgs } from './chat.mjs';
import { exportPage } from './export.mjs';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4189);
const NO_AGENTS = process.argv.includes('--no-agents');
const AGENTS_OFF_REASON = 'agents are off on this companion';
const AGENTS_OFF_ERROR = "agents are off — restart 'botference plugin' with claude/codex CLIs available";
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS) || 15000;
const JSON_HEAD = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const BODY_MAX = 200000; // article_text rides along on first mentions

// --- one companion per workspace: pid lock (same pattern as the council) ---
const lockFile = path.join(store.ROOT, '.botference', 'plugin-web.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
function acquireLock() {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (fs.existsSync(lockFile)) {
    let l = null;
    try { l = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { }
    if (l && l.pid !== process.pid && alive(l.pid)) {
      console.error(`another web-annotator companion is attached to this workspace (pid ${l.pid}) — close it first`);
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
function onChatEvent(ev) {
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

// an @-mention in any message — first comment or tenth reply — is the only
// thing that summons the bots
function summon(page, target, text, articleText) {
  if (!hasMention(text)) return {};
  if (NO_AGENTS) {
    broadcast({ type: 'chat', url: page.url, target, kind: 'error', error: AGENTS_OFF_ERROR });
    return { queued: false, reason: AGENTS_OFF_REASON };
  }
  const { position } = chat.submit({
    url: page.url, target, text, title: page.title,
    quote: target === store.PAGE_CHAT ? '' : (store.findThread(page, target) || {}).quote,
    history: priorMsgs(page, target),
    articleText,
  });
  return { queued: true, position };
}

// --- HTTP helpers -------------------------------------------------------
const ok = (res, obj) => res.writeHead(200, JSON_HEAD).end(JSON.stringify({ ok: true, ...obj }));
const fail = (res, code, error) => res.writeHead(code, JSON_HEAD).end(JSON.stringify({ ok: false, error }));
function readBody(req, res, fn) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > BODY_MAX) req.destroy(); });
  req.on('end', () => {
    let data; try { data = JSON.parse(body || '{}'); } catch { return fail(res, 400, 'bad json'); }
    fn(data);
  });
}
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

export function handler(req, res) {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return ok(res, {
      bridge: NO_AGENTS ? 'disabled' : chat.state(),
      queue: chat ? chat.queueLength() : 0,
    });
  }
  // model picker: what the bots are running on, and what they could run on.
  // Both are null until the bridge has started and spoken — the extension
  // renders that as "unknown yet", never as an empty list.
  if (req.method === 'GET' && url === '/models') {
    const m = chat ? chat.models() : { current: null, options: null, status: null };
    return ok(res, {
      current: m.current, options: m.options, status: m.status,
      bridge: NO_AGENTS ? 'disabled' : chat.state(),
    });
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
      // a highlight can arrive before any /page upsert (fresh tab, fast hands)
      const page = store.readPage(data.url) || store.upsertPage(data);
      const thread = store.addThread(page, {
        quote: data.quote, prefix: data.prefix, suffix: data.suffix,
        text, author: store.readConfig().author, index: data.index,
      });
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { thread, ...summon(page, thread.id, text, data.article_text) });
    });
  }
  if (req.method === 'POST' && url === '/reply') {
    return readBody(req, res, data => {
      const text = String(data.text || '');
      if (!text.trim()) return fail(res, 400, 'empty reply');
      const page = pageOf(res, data);
      if (!page) return;
      const target = data.thread_id || store.PAGE_CHAT;
      const msg = store.appendMsg(page, target, { author: store.readConfig().author, text });
      if (!msg) return fail(res, 404, 'unknown thread');
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { msg, ...summon(page, target, text, data.article_text) });
    });
  }
  if (req.method === 'POST' && url === '/edit') {
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const msgs = store.msgsOf(page, data.thread_id || store.PAGE_CHAT);
      if (!msgs) return fail(res, 404, 'unknown thread');
      const msg = msgs.find(m => m.ts === data.ts);
      if (!msg) return fail(res, 404, 'unknown message');
      // the bots' words are theirs: only your own messages are editable
      if (msg.author !== store.readConfig().author) return fail(res, 403, 'not your message');
      msg.text = String(data.text || '');
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { msg });
    });
  }
  if (req.method === 'POST' && url === '/delete') {
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const target = data.thread_id || store.PAGE_CHAT;
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
        const i = msgs.findIndex(m => m.ts === data.ts);
        if (i < 0) return fail(res, 404, 'unknown message');
        msgs.splice(i, 1);
        // deleting the last message of a thread deletes the thread: an empty
        // one is a highlight on the page that opens onto nothing
        if (target !== store.PAGE_CHAT && !msgs.length) {
          page.threads.splice(page.threads.findIndex(t => t.id === target), 1);
          gone = true;
        }
      }
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { thread_deleted: gone });
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
  if (req.method === 'POST' && url === '/export') {
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      try { ok(res, { path: exportPage(page, store.readConfig()) }); }
      catch (e) { fail(res, 500, `export failed: ${e.message}`); }
    });
  }
  if (req.method === 'POST' && url === '/model') {
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
  // hand an agent's own context back to it (compaction/handoff). Never worth
  // starting the bridge for: with nothing running there is no context to relay.
  if (req.method === 'POST' && url === '/relay') {
    return readBody(req, res, data => {
      const agent = String(data.agent || '');
      if (!['claude', 'codex', 'both'].includes(agent)) return fail(res, 400, 'agent must be claude, codex or both');
      if (NO_AGENTS) return fail(res, 409, AGENTS_OFF_REASON);
      if (chat.state() !== 'running') return fail(res, 409, 'agents are idle — nothing to relay');
      chat.control(`/relay @${agent}`);
      ok(res, { queued: true });
    });
  }
  if (req.method === 'POST' && url === '/interrupt') {
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
  });
  // heartbeat: dead extension workers surface, live ones stay warm
  setInterval(() => {
    for (const res of sseClients) res.write('data: {"type":"ping"}\n\n');
    for (const ws of wsClients) ws.send('{"type":"ping"}');
  }, HEARTBEAT_MS).unref();
}
