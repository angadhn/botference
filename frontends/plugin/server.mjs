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
import { createHosted, CORS_HEADERS, isLocalDirect } from './hosted.mjs';
import { pageView, pagesView, articleView } from './views.mjs';
import { sanitizeArticle } from './sanitize.mjs';
import * as run from './run.mjs';
import * as keys from '../shared/keys.mjs';
import * as beacon from './beacon.mjs';
import * as workspace from './workspace.mjs';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
// The article view's scripts. anchor.js is the extension's own file, served
// unchanged: the phone must anchor by exactly the code the Mac anchors by, or
// a highlight made in one place would not be found in the other.
const ASSETS = {
  'anchor.js': path.join(PLUGIN, 'extension', 'anchor.js'),
  'reader.js': path.join(PLUGIN, 'reader.js'),
};
// The braid, which is already the extension's toolbar icon: the hosted views
// wear the same mark as the drawer they are the other half of. 128px because a
// favicon is asked for once and then cached, and a bookmark bar wants it sharp.
const FAVICON = path.join(PLUGIN, 'extension', 'icons', 'icon128.png');
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
const UNCONFIRMED_REASON = 'this page is in a council folder you have not confirmed yet';
const UNCONFIRMED_ERROR = 'confirm the council folder in the drawer before the bots can join this page';
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

// --- the workspace bridges ------------------------------------------------
// A project-artifact page (workspace.mjs) is not filed under "Plugin pages":
// its chat belongs to the council project that produced the file, in that
// council's own state. So it gets its own bridge — same adapter, a different
// working root — created the first time such a page has something to say and
// kept for as long as the companion lives. One per council root, because a
// bridge's workspace is fixed when the child starts.
//
// One per (council root, PROJECT), since Phase 2. It was one per root while
// the bots could only read: the project inside a child moved with the page,
// because `/project open <id>` costs a turn and nothing else depended on it.
// Now something does — the child is spawned with exactly one writable
// directory (`projects/<id>/`), and an environment is fixed when a process
// starts. A second project in the same council therefore gets a second child
// with its own folder, rather than a `/project open` that would leave the
// first project's directory writable under the second project's page.
const workspaceChats = new Map();   // "<root>\0<project id>" → chat
const wsKey = (root, projectId) => `${root}\u0000${projectId}`;

// Which artifact a url is, cached for a moment. Every /thread, /reply,
// /interrupt and page load asks, and the answer costs half a dozen stat()s —
// worth memoizing, not worth remembering: a project deleted while the
// companion runs must stop being one within seconds, not at the next restart.
const ART_TTL = 4000;
const artCache = new Map();
function artifactOf(url) {
  const key = String(url || '');
  if (!key) return null;
  const now = Date.now();
  const hit = artCache.get(key);
  if (hit && now - hit.at < ART_TTL) return hit.art;
  const art = workspace.artifactState(key);
  if (artCache.size > 200) artCache.clear();
  artCache.set(key, { at: now, art });
  return art;
}
// a root the reader just answered for must be believed immediately
const forgetArtifacts = () => artCache.clear();

function workspaceChatFor(root, projectId, projectDir) {
  const key = wsKey(root, projectId);
  let c = workspaceChats.get(key);
  if (c) return c;
  c = createChat({
    onEvent: onChatEvent,
    root,
    // The one directory this child may write in. Absolute, and exactly this
    // project's folder: chat.mjs hands it to the CLIs as their write root, so
    // the enforcement is the CLIs' own and not a promise made in a prompt.
    writeRoot: projectDir || '',
    // which project THIS page's chat is filed under. Still asked per turn —
    // the child is per project now, so the answer never changes, but a page
    // from ANOTHER project reaching this child would be a routing bug and the
    // null keeps it out of this project's chats rather than papering over it.
    projectOf: (u) => {
      const a = artifactOf(u);
      if (!a || a.root !== root || a.project_id !== projectId) return null;
      return { id: a.project_id, title: a.project_title, path: a.path };
    },
  });
  workspaceChats.set(key, c);
  return c;
}

// The bridge that owns a page's chat. Everything that submits a turn, asks
// what is queued or interrupts one goes through here — a project-artifact
// page must never reach the "Plugin pages" bridge, and an ordinary page must
// never reach a council's.
//
// An UNCONFIRMED root falls back to no bridge at all: the reader has not yet
// said that directory is theirs, and spawning a child against it is precisely
// what the confirmation exists to gate.
function chatFor(url) {
  if (!chat) return null;
  const art = artifactOf(url);
  if (!art) return chat;
  if (!art.confirmed) return null;
  return workspaceChatFor(art.root, art.project_id, art.project_dir);
}
const allChats = () => (chat ? [chat, ...workspaceChats.values()] : []);
// Does THIS page have a turn in flight or waiting anywhere? The mirror refill
// below asks before it rewrites a page chat: a turn owns that conversation
// until it ends, and refilling underneath one would race the reply about to
// land in it. Asked across every bridge, because a page's bridge can change
// (an unconfirmed root routes to none, a confirmed one to its own child).
const pageBusy = url => allChats().some(c => c.busyFor && c.busyFor(url));
const anyRunning = () => allChats().some(c => c.state() === 'running');
const totalQueue = () => allChats().reduce((n, c) => n + c.queueLength(), 0);
// a setting is process-wide inside a child, so it is imposed on every child
// that is awake; the asleep ones read the same config.json when they spawn
const controlAll = text => { for (const c of allChats()) c.control(text); };
// what the agents panel renders: the bridge's own model/effort/occupancy, plus
// the one setting the companion owns (verbosity). Assembled in one place so
// GET /models and every `models` broadcast agree field for field.
const EMPTY_MODELS = { current: null, options: null, status: null, effort: null };
function modelsPayload() {
  const m = chat ? chat.models() : EMPTY_MODELS;
  return {
    current: m.current, options: m.options, status: m.status, effort: m.effort,
    verbosity: store.readConfig().verbosity,
    // which auth each agent will spawn with — status only, never the key
    keys: keys.status(),
  };
}

// A key or a mode only reaches the CLIs at the next bridge spawn, because an
// environment is fixed when a process starts. Rather than kill a turn to apply
// it, take the cheap opportunity: a bridge sitting idle is stopped here and
// respawns on the next mention, already carrying the new answer. A busy one is
// left alone and the caller is told the change waits.
function applyKeyChange() {
  if (NO_AGENTS || !chat) return { applies: 'now' };
  if (!anyRunning()) return { applies: 'now' };
  if (totalQueue() > 0) return { applies: 'next-restart' };
  for (const c of allChats()) c.stop();
  return { applies: 'now' };
}
// --- what the bots changed, and telling the tab -----------------------------
// Phase 2's other half. The bots may now rewrite the artifact the reader is
// looking at, and a browser has no idea a local file moved underneath it. So
// the companion takes a census of the project folder when a turn starts and
// another when it ends (workspace.scanProject), and the difference is
// broadcast as one `project-files` event.
//
// Turn-boundary, not a watcher: nothing runs while the reader is reading —
// no polling at rest, no fs.watch handles, and no event at all unless a turn
// happened AND something under the project actually moved. `sessions/` is not
// counted (botference writes the chat there during every turn, which would
// make every turn a change) — see workspace.scanProject.
//
// A reload cannot loop: reloading a tab starts no turn, and the event is only
// ever emitted from a turn-end.
const turnScans = new Map();     // page url → {dir, before}
// The last change set per page, for a tab that reconnected across it
// (GET /project-changes). Bounded, and the newest wins.
const lastChanges = new Map();   // page url → the event payload
const CHANGES_KEEP = 50;

function noteTurnStart(url) {
  const art = url ? artifactOf(url) : null;
  if (!art || !art.confirmed || !art.project_dir) return;
  turnScans.set(url, { dir: art.project_dir, before: workspace.scanProject(art.project_dir) });
}

function reportProjectChanges(url) {
  const seen = url ? turnScans.get(url) : null;
  if (!seen) return;
  turnScans.delete(url);
  const art = artifactOf(url);
  // the project was deleted, or the root un-confirmed, while the turn ran
  if (!art || !art.confirmed || art.project_dir !== seen.dir) return;
  const changed = workspace.diffScans(seen.before, workspace.scanProject(seen.dir));
  if (!changed.length) return;
  // the artifact's own path inside its project — the difference between
  // "reload, you are looking at the old one" and "they changed something else"
  const own = path.relative(seen.dir, art.path).split(path.sep).join('/');
  const payload = {
    type: 'project-files',
    url,
    root: art.root,
    project_id: art.project_id,
    project_title: art.project_title,
    count: changed.length,
    // whether THIS page is one of them
    page_changed: changed.includes(own),
    files: changed.slice(0, workspace.CHANGED_LIST_MAX),
    at: new Date().toISOString(),
  };
  lastChanges.set(url, payload);
  if (lastChanges.size > CHANGES_KEEP) lastChanges.delete(lastChanges.keys().next().value);
  broadcast(payload);
}

// --- the mirror, kept level with the council ------------------------------
// A project artifact page standing in a council session shows a MIRROR of that
// session: `page_chat` is the tail `sessionTail` read off disk when the chat
// was opened, plus whatever the drawer has appended since. The same session is
// also open in the TUI and in the council's own web UI — a different bridge,
// the same file — and turns made THERE never touch this companion. Without
// what follows, the reader chats in the council, comes back to the artifact
// tab, and sees a conversation that stopped hours ago.
//
// The whole of the freshness test is one number: `page.session_sync`, the
// session file's mtime as of the last refill. Disagreement means the council
// has written since, and the answer is to read the tail again.
//
// ── THE HONESTY RULE ───────────────────────────────────────────────────────
// After a refill the session file is the truth. A message the drawer authored
// becomes a `restored:true` entry like every other, offered no edit and no
// delete — because that is now what it is: a line in somebody else's record.
// The one exception is a message the file CANNOT have seen yet: anything this
// companion stamped after the file's own mtime (a note typed while the agents
// were off, a guest's comment that summoned nobody). Deleting those would be
// losing words no other copy holds, so they are kept under the refilled tail.
const MIRROR_KEEP = 20;

function refillMirror(page, art) {
  if (!page || !page.session_id || !art || !art.confirmed) return false;
  const mtime = workspace.sessionMtime(art.root, art.project_id, page.session_id);
  if (!mtime || Number(page.session_sync) === mtime) return false;
  // a turn owns this conversation until it ends — try again on the next quiet read
  if (pageBusy(page.url)) return false;
  const session = workspace.sessionTail(art.root, art.project_id, page.session_id);
  // a half-written file parses as nothing; saying "no change" is the harmless
  // direction to fail in, and the next event or read will find it whole
  if (!session) return false;
  const unseen = (page.page_chat || [])
    .filter(m => m && !m.restored && Date.parse(m.ts) > mtime)
    .slice(-MIRROR_KEEP);
  page.page_chat = unseen.length ? [...session.msgs, ...unseen] : session.msgs;
  page.session_total = session.total;
  page.session_title = session.title;
  page.session_sync = mtime;
  store.savePage(page);
  return true;
}

// The read path. Every drawer asks GET /page on load and after every `page`
// broadcast, so this is where a tab returning to a stale mirror catches up —
// no watcher required and nothing running while nobody is looking.
function freshenMirror(page) {
  if (!page || !page.session_id) return page;
  const art = artifactOf(page.url);
  if (!art || !art.confirmed) return page;
  noteStanding(page.url, art, page.session_id);
  refillMirror(page, art);
  return page;
}

// --- watching, but only while somebody is looking --------------------------
// The read path alone leaves an OPEN drawer stale until something else makes
// it refetch. So a session a connected tab is standing in is watched.
//
// ── WHY fs.watch AND NOT A HEARTBEAT STAT ──────────────────────────────────
// The SSE heartbeat is 15s, and "your council reply appears within fifteen
// seconds" is not a live mirror — the reader flips tabs in one. fs.watch is
// event-driven, costs one handle per sessions DIRECTORY (not per session), and
// still does zero work at rest. The DIRECTORY is watched rather than the file
// because botference saves a session by writing a temp file and renaming it
// over the old one: a watch on the file itself follows the replaced inode and
// goes deaf after the first save. Events are filtered to the one basename,
// debounced, and answered with a stat — a spurious event costs one syscall.
//
// ── NOTHING RUNS AT REST ───────────────────────────────────────────────────
// Watchers exist only while (a) at least one client is connected and (b) at
// least one page a client has recently read is standing in a council session.
// The last tab closing closes them; `persistent:false` means one can never
// hold the process open.
//
// ── AND NEVER FROM OUR OWN WRITES ──────────────────────────────────────────
// The bridge this companion spawns is botference, and it saves the same file
// on every turn. `refillMirror` refuses while a turn for that page is in
// flight or queued (`pageBusy`), so a turn's own saves never rewrite the chat
// it is answering into; the save that lands after turn-end is picked up on the
// next event or read, when it is simply the truth like any other.
const SESSION_DEBOUNCE_MS = 300;
// How long a page stays "a tab is standing here" after its record was last
// read. Every drawer re-reads on load and on every `page` broadcast, so this
// is generous; a tab idle past it goes stale until its next read, which
// refills. Bounded so a long session cannot accumulate watchers.
const STANDING_TTL_MS = 10 * 60 * 1000;
const STANDING_MAX = 40;
const standing = new Map();          // page url → {file, at}
const sessionWatchers = new Map();   // sessions dir → fs.FSWatcher
let touchTimer = null;
const touched = new Set();

function noteStanding(url, art, sid) {
  const file = workspace.sessionFile(art.root, art.project_id, sid);
  if (!file) return;
  standing.delete(url);
  standing.set(url, { file, at: Date.now() });
  while (standing.size > STANDING_MAX) standing.delete(standing.keys().next().value);
  syncWatchers();
}

const anyClients = () => sseClients.size > 0 || wsClients.size > 0;

function wantedDirs() {
  const dirs = new Set();
  const now = Date.now();
  for (const [url, s] of [...standing]) {
    if (now - s.at > STANDING_TTL_MS) { standing.delete(url); continue; }
    dirs.add(path.dirname(s.file));
  }
  return dirs;
}

function syncWatchers() {
  const wanted = anyClients() ? wantedDirs() : new Set();
  for (const [dir, w] of [...sessionWatchers]) {
    if (wanted.has(dir)) continue;
    try { w.close(); } catch { /* already gone */ }
    sessionWatchers.delete(dir);
  }
  for (const dir of wanted) {
    if (sessionWatchers.has(dir)) continue;
    let w = null;
    try {
      w = fs.watch(dir, { persistent: false }, (_ev, name) => onSessionTouch(dir, name));
    } catch { continue; }   // an unreadable directory simply is not watched
    w.on('error', () => { try { w.close(); } catch { } sessionWatchers.delete(dir); });
    sessionWatchers.set(dir, w);
  }
}

function onSessionTouch(dir, name) {
  // no filename (some platforms) means "something in here" — take the whole
  // directory as touched and let the mtime comparison decide
  touched.add(name ? path.join(dir, String(name)) : dir);
  if (touchTimer) return;
  touchTimer = setTimeout(() => {
    touchTimer = null;
    const hits = new Set(touched);
    touched.clear();
    for (const [url, s] of [...standing]) {
      if (!hits.has(s.file) && !hits.has(path.dirname(s.file))) continue;
      const page = store.readPage(url);
      if (!page || !page.session_id) { standing.delete(url); continue; }
      const art = artifactOf(url);
      if (!art || !art.confirmed) continue;
      // `page` is the existing re-render signal: every drawer refetches the
      // record and draws the new tail, keeping its drafts and its scroll
      if (refillMirror(page, art)) broadcast({ type: 'page', url: page.url });
    }
    syncWatchers();
  }, SESSION_DEBOUNCE_MS);
  if (typeof touchTimer.unref === 'function') touchTimer.unref();
}

function onChatEvent(ev) {
  // chat.mjs knows nothing about config.json; the verbosity a tab renders
  // rides the same event as everything else in that panel
  if (ev.type === 'models') {
    return broadcast({ ...ev, verbosity: store.readConfig().verbosity, keys: keys.status() });
  }
  // the turn boundary is where the census is taken; a summary job (silent by
  // construction) emits neither of these, so filing a thread never counts
  if (ev.type === 'chat' && ev.kind === 'turn-start') noteTurnStart(ev.url);
  if (ev.type === 'chat' && ev.kind === 'turn-end') {
    broadcast(ev);
    // after the turn-end, always: the drawer stops spinning first and only
    // then hears that the file moved
    reportProjectChanges(ev.url);
    return;
  }
  if (ev.type === 'chat' && ev.kind === 'reply') {
    const page = store.readPage(ev.url);
    if (page) {
      // appendMsg also REOPENS a resolved thread: a bot answering into it is
      // new activity, and new activity is the end of resolved
      store.appendMsg(page, ev.target, ev.msg);
      store.savePage(page);
    }
    broadcast(ev);
    broadcast({ type: 'page', url: ev.url });
    return;
  }
  // A filing job came back (chat.mjs). Its words are the thread's `summary`
  // and are never appended to it — so this must not go anywhere near
  // appendMsg, which would reopen the thread it has just described.
  //
  // It lands wherever the thread is now. If the reader reopened it while the
  // job was still in the queue, the field is simply written and left unused —
  // that is the whole cancellation story, and it means re-resolving later
  // shows the paragraph instantly instead of queueing a second job.
  if (ev.type === 'summary') {
    const page = store.readPage(ev.url);
    const thread = page && store.findThread(page, ev.target);
    if (thread && store.setSummary(thread, ev.msg && ev.msg.text, ev.msg && ev.msg.author)) {
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
    }
    return;
  }
  broadcast(ev);
}

// Ask the agents what a thread settled, for the resolved card to carry. Queued
// like any other turn and answered into the record, never into the thread; a
// companion with the agents switched off simply keeps the heuristic digest.
//
// Whoever last spoke in the thread writes it — they have the context and, on a
// two-agent thread, arguing about the minutes is not worth a turn. A thread the
// bots never touched is summarized too (the reader's own comment is a question
// with an outcome as often as not); claude takes those.
function summarizeThread(page, thread) {
  if (NO_AGENTS || !chat || !thread) return false;
  const bot = [...(thread.msgs || [])].reverse()
    .find(m => m && m.kind !== 'tools' && /^(claude|codex)\b/i.test(String(m.author || '')));
  const agent = bot ? String(bot.author).toLowerCase().replace(/[^a-z]/g, '') : 'claude';
  const c = chatFor(page.url);
  if (!c) return false;
  c.submit({
    url: page.url, target: thread.id, title: page.title,
    // the whole of the routing: `text` is read for its @-mention and by nothing
    // else, because a summary job builds its own envelope (chat.mjs)
    text: `@${agent === 'codex' ? 'codex' : 'claude'} `,
    summary: true,
    quote: thread.quote,
    pageNumber: thread.page || 0,
    // every message, including the last: unlike a reply turn, no message here
    // is "the one being answered"
    history: thread.msgs || [],
  });
  return true;
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

// Page chat on a CONFIRMED project artifact page is not "a chat about a web
// page" — it is a council chat, the same session the TUI is driving, and the
// council's rule for plain text is that it goes to the room. So an untagged
// message here is routed @all, decided in the one place that knows the page is
// an artifact at all.
//
// Deliberately narrow. Comment THREADS keep the Discuss rule everywhere,
// artifact pages included: a highlight with an untagged note under it is a
// note to yourself and summons nobody. So does page chat on every ordinary
// page. And an UNCONFIRMED root is excluded — the reader has not yet said the
// folder is theirs, and an untagged sentence must not be the thing that first
// asks them to.
function untaggedGoesToAll(page, target, text) {
  if (target !== store.PAGE_CHAT || hasMention(text)) return false;
  const art = artifactOf(page.url);
  return !!(art && art.confirmed);
}

// an @-mention in any message — first comment or tenth reply — is the only
// thing that summons the bots, except on a project artifact's page chat
// (untaggedGoesToAll)
// `extras.forceAll` is the send-review turn saying "this one is the room's,
// whatever the text looks like": its body quotes the reader's own margin
// comments, and an "@claude" typed at one thread weeks ago is not the address
// of a review of the whole draft. Nothing else sets it, and it is stripped
// out here rather than travelling on as a job field.
function summon(page, target, text, extras = {}, me = { owner: true }) {
  const { forceAll, ...rest } = extras;
  extras = rest;
  const untaggedAll = !!forceAll || untaggedGoesToAll(page, target, text);
  if (!hasMention(text) && !untaggedAll) return {};
  if (NO_AGENTS) {
    broadcast({ type: 'chat', url: page.url, target, kind: 'error', error: AGENTS_OFF_ERROR });
    return { queued: false, reason: AGENTS_OFF_REASON };
  }
  const refused = guestRefusal(me);
  if (refused) {
    broadcast({ type: 'chat', url: page.url, target, kind: 'error', error: refused });
    return { queued: false, reason: refused };
  }
  // A project-artifact page whose council root the reader has not vouched for
  // yet: the comment is kept, the bots are not summoned, and the drawer says
  // why — the confirmation card is already on screen asking.
  const c = chatFor(page.url);
  if (!c) {
    broadcast({ type: 'chat', url: page.url, target, kind: 'error', error: UNCONFIRMED_ERROR });
    return { queued: false, reason: UNCONFIRMED_REASON };
  }
  const thread = target === store.PAGE_CHAT ? null : store.findThread(page, target);
  const { position, wait } = c.submit({
    url: page.url, target, text, title: page.title,
    // no tag on an artifact's page chat: the envelope gets the @all prefix the
    // reader did not have to type (chat.mjs routeOf)
    ...(untaggedAll ? { untaggedAll: true } : {}),
    // on a shared page the bots are answering a room, not one reader: name
    // whoever is asking, unless it is the owner (whose annotator never did)
    asker: me.owner ? '' : me.handle,
    quote: thread ? thread.quote : '',
    // a comment on a paged document (a PDF) already knows its page — the
    // thread stores it — so the envelope can say where the reader is standing
    pageNumber: (thread && thread.page) || 0,
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
  const page = store.readPage(data.url) || ensureLibrary(data.url);
  if (!page) { fail(res, 404, 'unknown page'); return null; }
  return page;
}

// The library has no page to visit and nothing to POST /page it into being, so
// it is created by the first message written into it — exactly when a real
// page's session is created, and for the same reason: an empty record nobody
// has spoken into is not worth keeping.
function ensureLibrary(url) {
  if (!store.isLibrary(url)) return null;
  return store.upsertPage({ url: store.LIBRARY_URL, title: store.LIBRARY_TITLE, site: '' });
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

// --- running a python block ------------------------------------------------
// The code that runs is the code that is STORED: a request names a message and
// a block ordinal, and the companion takes the block out of that message's own
// text. Nothing executable ever arrives on the wire.
const RUN_OFF = 'running code is switched off on this companion (run_python in config.json)';
const runEnabled = () => store.readConfig().run_python !== false;
const runKey = (page, target, ts, i) => `${store.pageKey(page.url)}|${target}|${ts}|${i}`;

// the message a /run or /run-cancel body is pointing at, or a refusal already
// written to the response
function addressedMsg(res, data) {
  const page = pageOf(res, data);
  if (!page) return null;
  const target = data.thread_id || store.PAGE_CHAT;
  const msgs = store.msgsOf(page, target);
  if (!msgs) { fail(res, 404, 'unknown thread'); return null; }
  const found = store.resolveMsg(msgs, pick(data));
  if (!found) { fail(res, 404, 'unknown message'); return null; }
  return { page, target, found };
}

function startRun(req, res) {
  return readBody(req, res, async data => {
    if (!runEnabled()) return fail(res, 409, RUN_OFF);
    const at = addressedMsg(res, data);
    if (!at) return;
    const { page, target, found } = at;
    const index = Number(data.block_index);
    const picked = run.blockAt(found.msg.text, index);
    if (picked.error) return fail(res, 400, picked.error);
    const key = store.pageKey(page.url);
    const cancelKey = runKey(page, target, found.msg.ts, index);
    if (run.isRunning(cancelKey)) return fail(res, 409, 'that block is already running');
    // a re-run REPLACES: the previous run's directory (figures and all) goes
    // before the new one is made, so a block never accumulates output
    const prev = (found.msg.runs || {})[String(index)];
    if (prev && prev.run_id) store.deleteRunDir(key, prev.run_id);

    const runId = run.newRunId();
    let result;
    // runPython answers rather than throws (a missing python3 is a result), so
    // anything caught here is the filesystem — and a request that dies silently
    // leaves the drawer spinning for ever
    try {
      result = await run.runPython({
        dir: store.runDir(key, runId), code: picked.block.code, runId, key: cancelKey,
      });
    } catch (e) {
      store.deleteRunDir(key, runId);
      return fail(res, 500, `could not run that block: ${(e && e.message) || e}`);
    }
    // The record may have moved while python was running — the message could
    // have been edited, deleted, or answered into. Re-resolve against what is
    // on disk NOW and store the result there; if the message is gone, so is the
    // reason to keep its output.
    const fresh = store.readPage(page.url);
    const msgs = fresh && store.msgsOf(fresh, target);
    const again = msgs && store.resolveMsg(msgs, pick(data));
    if (!again) {
      store.deleteRunDir(key, runId);
      return ok(res, { run: { ...result, figures: [] }, block_index: index, stored: false });
    }
    store.setRun(again.msg, index, result);
    store.savePage(fresh);
    broadcast({ type: 'page', url: fresh.url });
    ok(res, { run: result, block_index: index, stored: true,
      ...(found.ambiguous ? { ambiguous: true } : {}) });
  });
}

// Stopping a run is killing its process group — the snippet and anything it
// started. The timeout is still the backstop; this is the reader saying so
// sooner. A run that had already finished answers honestly rather than 404ing:
// "there was nothing to stop" is a true and unalarming thing to say.
function cancelRun(req, res) {
  return readBody(req, res, data => {
    const at = addressedMsg(res, data);
    if (!at) return;
    const index = Number(data.block_index);
    if (!Number.isInteger(index) || index < 0) return fail(res, 400, 'block_index required');
    const key = runKey(at.page, at.target, at.found.msg.ts, index);
    ok(res, { cancelled: run.cancelRun(key) });
  });
}

// A figure is a file inside one run's directory and is served from there, under
// the same owner-only gate as the run that made it — never a web-accessible
// path and never unauthenticated. `key`, `run` and `name` are each validated
// into a shape that cannot leave the directory (40 hex, the run-id form, a bare
// png/svg basename), which is why this can be a path join at all.
// `as=json` answers with a data: URL instead of bytes: the drawer lives inside
// somebody else's page, and fetching through the extension's background worker
// is the only way it gets the owner's credentials onto the request.
function runFigure(req, res) {
  const q = new URLSearchParams(String(req.url || '').split('?')[1] || '');
  // `key` is what the server-rendered views already hold; `url` is what the
  // extension holds (a content script has no sha1 to hand). Same address.
  const key = q.get('url') ? store.pageKey(q.get('url')) : (q.get('key') || '');
  const id = q.get('run') || '';
  const name = q.get('name') || '';
  if (!/^[0-9a-f]{40}$/.test(key) || !run.isRunId(id) || !run.isFigureName(name)) {
    return fail(res, 400, 'bad figure address');
  }
  const file = path.join(store.runDir(key, id), name);
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'no such figure');
    const mime = /\.svg$/i.test(name) ? 'image/svg+xml' : 'image/png';
    if (q.get('as') === 'json') {
      return ok(res, { mime, name, data_url: `data:${mime};base64,${buf.toString('base64')}` });
    }
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' }).end(buf);
  });
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
  // The tab icon, AHEAD of the gate on purpose. Browsers ask for /favicon.ico
  // whether or not a page linked one, and a gated one is a 401 in the network
  // log of every view plus a broken icon on the sign-in page itself. An
  // extension's own logo is not a secret, and this route reads exactly one
  // fixed file — there is no name to smuggle past the gate through it.
  if (req.method === 'GET' && (url === '/favicon.ico' || url === '/favicon.png')) {
    return fs.readFile(FAVICON, (err, buf) => {
      if (err) return fail(res, 404, 'not found');
      // png at /favicon.ico is what every browser since IE has accepted, and
      // it saves carrying a second copy of the same picture
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400',
      }).end(buf);
    });
  }
  if (!hosted.authorized(req)) return hosted.denied(req, res);

  // --- the reading room: collaborators without the extension -------------
  if (req.method === 'GET' && (url === '/' || url === '/pages')) {
    if (url === '/') return res.writeHead(302, { location: '/pages' }).end();
    const index = store.readIndex();
    const snapshots = new Set(Object.keys(index).filter(k => store.hasSnapshot(k)));
    // the same two filters the drawer's list has, as the query string: the
    // reading room has no client state, so a filtered archive is a LINK
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    // the library rides at the top of this view rather than as a row in it —
    // one conversation about the whole list underneath
    const html = pagesView({ index, me: hosted.identity(req), snapshots,
      library: store.readPage(store.LIBRARY_URL),
      libraryKey: store.pageKey(store.LIBRARY_URL),
      kind: q.get('kind') || '', tag: q.get('tag') || '' });
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
      // the WHOLE stable: 'running' the moment any bridge is up (the plugin's
      // own or a council's), and one queue depth across all of them
      bridge: NO_AGENTS ? 'disabled' : (anyRunning() ? 'running' : chat.state()),
      queue: chat ? totalQueue() : 0,
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
  // --- project artifact pages -------------------------------------------
  // A local file the council wrote, opened as a file:// page. Owner-only, all
  // four of them: the answers are absolute paths on this machine and the names
  // of this reader's projects, which is nobody's business over a tunnel.
  //
  // GET /project-page is the question content.js asks before it will attach to
  // a file: document at all — no artifact, no extension on that page.
  if (req.method === 'GET' && url === '/project-page') {
    if (notOwner(req, res)) return;
    const u = queryUrl(req.url);
    const art = u ? artifactOf(store.normUrl(u)) : null;
    if (!art) return ok(res, { artifact: null });
    return ok(res, {
      artifact: {
        root: art.root,
        project_id: art.project_id,
        project_title: art.project_title,
        rel: art.rel,
        path: art.path,
        // How this url reached the artifact: its own file: address, or the
        // council's web UI at `/files/…` from an origin the reader has named
        // as their council (workspace.mjs says why that allowlist is the whole
        // of the trust). `ident_href` is set only in the second case — the
        // file: url of the same file, which is the identity BOTH views file
        // under, so the two are one Discuss page rather than twins.
        via: art.via || 'file',
        ...(art.ident_href ? { ident_href: art.ident_href } : {}),
        // where the full chats live on the web — the drawer's "open the full
        // chat" link. Owner-machine address by default; config can point it
        // at a hosted council instead.
        council_web: String(store.readConfig().council_web || 'http://localhost:4187'),
        confirmed: art.confirmed,
        declined: art.declined,
      },
    });
  }
  // The one-time answer to "treat <root> as your council?". Kept in the
  // plugin's own config.json, so it survives the companion and is asked once
  // per council rather than once per page.
  if (req.method === 'POST' && url === '/council-root') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const root = String(data.root || '');
      if (!root || !workspace.isCouncilRoot(workspace.realish(root))) {
        return fail(res, 400, 'not a council root');
      }
      const state = workspace.setRootState(root, !!data.confirm);
      forgetArtifacts();
      // every tab on a page under this root has to stop asking, or start working
      broadcast({ type: 'council-root', root: workspace.realish(root), state });
      ok(res, { root: workspace.realish(root), state });
    });
  }
  // The project's chat archive: every council session filed under it, newest
  // first, plus which one this page is currently bound to.
  if (req.method === 'GET' && url === '/project-sessions') {
    if (notOwner(req, res)) return;
    const u = queryUrl(req.url);
    const art = u ? artifactOf(store.normUrl(u)) : null;
    if (!art) return fail(res, 404, 'not a project artifact page');
    if (!art.confirmed) return fail(res, 409, UNCONFIRMED_REASON);
    const page = store.readPage(store.normUrl(u));
    return ok(res, {
      project_id: art.project_id,
      project_title: art.project_title,
      root: art.root,
      current: (page && page.session_id) || null,
      sessions: workspace.listSessions(art.root, art.project_id),
    });
  }
  // One past chat's recent tail, read from the session record on disk. Never
  // from the bridge: replaying a conversation is not a turn, and a companion
  // whose bridge is asleep still has to be able to show it.
  if (req.method === 'GET' && url === '/project-session') {
    if (notOwner(req, res)) return;
    const q = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const u = q.get('url') || '';
    const art = u ? artifactOf(store.normUrl(u)) : null;
    if (!art) return fail(res, 404, 'not a project artifact page');
    if (!art.confirmed) return fail(res, 409, UNCONFIRMED_REASON);
    const session = workspace.sessionTail(art.root, art.project_id, q.get('sid') || '');
    if (!session) return fail(res, 404, 'unknown session');
    return ok(res, { session });
  }
  // What the bots last changed under this project, if anything, since the
  // companion started. A tab whose socket was down across the turn (or that
  // has just reloaded because of it) asks here rather than missing it.
  // Owner-only like every other /project-* route: the answer is a list of
  // paths on the owner's machine.
  if (req.method === 'GET' && url === '/project-changes') {
    if (notOwner(req, res)) return;
    const u = queryUrl(req.url);
    const art = u ? artifactOf(store.normUrl(u)) : null;
    if (!art) return fail(res, 404, 'not a project artifact page');
    if (!art.confirmed) return fail(res, 409, UNCONFIRMED_REASON);
    return ok(res, { changes: lastChanges.get(store.normUrl(u)) || null });
  }
  // Which chat this page is standing in. `{sid}` opens a past one, `{new:true}`
  // starts a fresh one — and both work by moving `session_id` on the page
  // record, because that field is ALREADY the whole of the resume machinery
  // (chat.mjs plans /resume when it is set and /new when it is not). Nothing
  // new had to be invented for this; the page simply points somewhere else.
  //
  // The page's own `page_chat` is the drawer's mirror of the chat it is
  // standing in, so it is replaced by the tail of the newly opened session —
  // a mirror of one conversation must never be shown under another.
  if (req.method === 'POST' && url === '/project-chat') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const u = store.normUrl(String(data.url || ''));
      const art = u ? artifactOf(u) : null;
      if (!art) return fail(res, 404, 'not a project artifact page');
      if (!art.confirmed) return fail(res, 409, UNCONFIRMED_REASON);
      const page = store.readPage(u)
        || store.upsertPage({ url: u, title: String(data.title || art.rel), site: art.project_id });
      if (data.sid) {
        const session = workspace.sessionTail(art.root, art.project_id, String(data.sid));
        if (!session) return fail(res, 404, 'unknown session');
        page.session_id = session.session_id;
        page.session_title = session.title;
        page.page_chat = session.msgs;
        // so the drawer can say "the last N of TOTAL messages" over the tail
        page.session_total = session.total;
        // where the mirror now stands: the session file's mtime. Everything
        // that reads this page afterwards compares against it and refills when
        // the council has written since (refillMirror).
        page.session_sync = workspace.sessionMtime(art.root, art.project_id, session.session_id);
        noteStanding(page.url, art, session.session_id);
      } else {
        page.session_id = null;
        page.session_title = '';
        page.page_chat = [];
        page.session_total = 0;
        page.session_sync = 0;
        standing.delete(page.url);
      }
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      ok(res, { session_id: page.session_id, session_title: page.session_title, page });
    });
  }

  // --- handing the whole margin review over ------------------------------
  // The reader has been down the draft leaving comments in the margins. This
  // is the one button that gives all of it to the bots at once: every OPEN
  // thread — the passage and the conversation under it — composed into a
  // single page-chat turn (workspace.reviewDigest owns the format and the
  // caps) and submitted through the ordinary path.
  //
  // Ordinary is the whole design. The digest is appended as a REAL user
  // message in page chat, so the reader can see exactly what was sent, edit or
  // delete it like anything else they wrote, and find it in the session file
  // afterwards; and `summon` does the queueing, the streaming, the mirror and
  // the persistence with no special case of its own. The only thing this route
  // adds to a typed message is the text.
  //
  // What it does NOT do: resolve anything. The bots answer in page chat and
  // the reader files the threads they are satisfied with, one click each, the
  // same as every other day. A button that closed twenty threads on the
  // strength of an answer nobody has read yet would be filing the reader's
  // decisions for them.
  if (req.method === 'POST' && url === '/send-review') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const me = authorOf(req, res);
      if (!me) return;
      const u = store.normUrl(String(data.url || ''));
      const art = u ? artifactOf(u) : null;
      if (!art) return fail(res, 404, 'not a project artifact page');
      if (!art.confirmed) return fail(res, 409, UNCONFIRMED_REASON);
      const page = store.readPage(u);
      const digest = page ? workspace.reviewDigest(page) : null;
      if (!digest) {
        return fail(res, 400, 'no open comments to send — highlight something and comment first, or reopen a filed thread');
      }
      // the same guard a typed message gets: over a tunnel the button has no
      // receipt for a second, and the expensive half of a double-click is the
      // agent run, not the message
      const dedupe = dedupeCheck([store.pageKey(page.url), store.PAGE_CHAT, me.handle, digest.text]);
      if (dedupe.hit) return ok(res, { msg: dedupe.hit, deduped: true, sent: digest.sent, omitted: digest.omitted, total: digest.total });
      const msg = store.appendMsg(page, store.PAGE_CHAT, { author: me.handle, text: digest.text });
      dedupe.remember(msg);
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      // routed @all whatever the quoted comments say (summon's forceAll), and
      // carrying no page context of its own: the artifact banner and the write
      // rules ride every turn on these pages already (chat.envelope), and the
      // digest is the message.
      const summoned = summon(page, store.PAGE_CHAT, digest.text,
        { forceAll: true, articleText: data.article_text, articleChanged: !!data.article_changed }, me);
      ok(res, { msg, sent: digest.sent, omitted: digest.omitted, total: digest.total, ...summoned });
    });
  }

  // model picker: what the bots are running on, and what they could run on.
  // Both are null until the bridge has started and spoken — the extension
  // renders that as "unknown yet", never as an empty list.
  if (req.method === 'GET' && url === '/models') {
    return ok(res, { ...modelsPayload(), bridge: NO_AGENTS ? 'disabled' : (anyRunning() ? 'running' : chat.state()) });
  }

  // --- API keys: written from this machine, never read back --------------
  // Stricter than owner-only. The remote owner is still the owner, but a key
  // typed into a phone would cross the tunnel, and there is no reason for it
  // ever to: keys are configured where the CLIs they pay for actually run.
  // isLocalDirect is the same three-part test the whole owner model rests on.
  if (url === '/keys' || url === '/keys/remove' || url === '/key-mode') {
    if (!isLocalDirect(req)) {
      req.resume();
      return fail(res, 403, 'API keys can only be set from this machine');
    }
    if (req.method === 'GET' && url === '/keys') return ok(res, keys.status());
    if (req.method === 'POST' && url === '/keys') {
      return readBody(req, res, data => {
        const r = keys.setKey(data.agent, data.key);
        if (!r.ok) return fail(res, 400, r.error);
        return ok(res, { ...keys.status(), ...applyKeyChange() });
      });
    }
    if (req.method === 'POST' && url === '/keys/remove') {
      return readBody(req, res, data => {
        const r = keys.removeKey(data.agent);
        if (!r.ok) return fail(res, 400, r.error);
        return ok(res, { removed: r.removed, ...keys.status(), ...applyKeyChange() });
      });
    }
    if (req.method === 'POST' && url === '/key-mode') {
      return readBody(req, res, data => {
        const r = keys.setMode(data.agent, data.mode);
        if (!r.ok) return fail(res, 400, r.error);
        return ok(res, { ...keys.status(), ...applyKeyChange() });
      });
    }
    return fail(res, 404, 'not found');
  }
  // --- running a code block ----------------------------------------------
  // A ```python block in any message can be RUN, here, with the reader's own
  // privileges (run.mjs says everything else about that). All three routes are
  // OWNER-only: on a hosted companion the button never renders for a guest and
  // the endpoint refuses them, because this is not "code execution in a shared
  // workspace" — it is the owner's terminal, reached through their own drawer.
  if (url === '/run' || url === '/run-cancel' || url === '/run-figure') {
    if (notOwner(req, res)) return;
    // what the drawer asks before it draws anything: whether the button exists
    // at all on this companion, and how long a run may take
    if (req.method === 'GET' && url === '/run') {
      return ok(res, {
        enabled: runEnabled(), timeout_ms: run.timeoutMs(), python: run.pythonBin(),
      });
    }
    if (req.method === 'GET' && url === '/run-figure') return runFigure(req, res);
    if (req.method === 'POST' && url === '/run') return startRun(req, res);
    if (req.method === 'POST' && url === '/run-cancel') return cancelRun(req, res);
    return fail(res, 404, 'not found');
  }

  if (req.method === 'GET' && url === '/index') {
    return res.writeHead(200, JSON_HEAD).end(JSON.stringify(store.readIndex()));
  }
  if (req.method === 'GET' && url === '/page') {
    const u = queryUrl(req.url);
    if (!u) return fail(res, 400, 'url required');
    // a project artifact's mirror of a council chat is brought level with the
    // session file first, if the council has written since it was last read
    const page = freshenMirror(store.readPage(u));
    return page
      ? res.writeHead(200, JSON_HEAD).end(JSON.stringify(page))
      : ok(res, { page: null });
  }
  if (req.method === 'GET' && url === '/events') {
    sseOpen(res);
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    sseClients.add(res);
    // a connected tab is what buys a session watcher; the last one to leave
    // closes them (syncWatchers)
    syncWatchers();
    req.on('close', () => { sseClients.delete(res); syncWatchers(); });
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
        // 'self' is the companion's own /run-figure — a plot made by a code
        // block, served from this origin under the same owner-only gate
        "img-src 'self' https: data:",
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
        // documents with pages (a web PDF) say which one the passage came off;
        // everything else omits it and nothing downstream requires it
        text, author: me.handle, index: data.index, page_number: data.page,
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
      // The code has moved, so what it once printed is a claim about a message
      // that no longer exists. Results (and their directories) go with the
      // edit rather than hanging under a block they were never run from.
      store.deleteRuns(store.pageKey(page.url), store.clearRuns(msg));
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
      // whatever is about to be deleted may be holding run output on disk;
      // collect the ids while the messages are still here to ask
      const pkey = store.pageKey(page.url);
      if (!data.ts) {
        if (target === store.PAGE_CHAT) {
          store.deleteRuns(pkey, store.runIdsOf(page.page_chat));
          page.page_chat = [];
        } else {
          const i = page.threads.findIndex(t => t.id === target);
          if (i < 0) return fail(res, 404, 'unknown thread');
          store.deleteRuns(pkey, store.runIdsOf(page.threads[i].msgs));
          page.threads.splice(i, 1);
          gone = true;
        }
      } else {
        const msgs = store.msgsOf(page, target);
        if (!msgs) return fail(res, 404, 'unknown thread');
        if (!found) return fail(res, 404, 'unknown message');
        store.deleteRuns(pkey, store.runIdsOf([found.msg]));
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
        // …and it must be THIS page's bridge: a council session is not the
        // plugin bridge's to delete, and the file is not in this workspace
        // …and NEVER a council's. A project-artifact page's chat lives in the
        // reader's own workspace beside everything else that project has ever
        // said; forgetting the PAGE must not destroy it. Phase 1 leaves it
        // exactly where it is.
        const owner = chatFor(page.url);
        if (owner && owner !== chat) session_deleted = false;
        else if (chat && chat.state() === 'running') { chat.control(`/delete ${sid}`); session_deleted = true; }
        else session_deleted = store.deleteSessionFile(sid);
      }
      store.deletePage(page.url);
      broadcast({ type: 'page', url: page.url });
      ok(res, { session_deleted });
    });
  }
  // --- what the reader calls it, and what they filed it under ------------
  // Two small edits to a record's metadata, both the OWNER's: a page's name is
  // what everyone else reads, and its tags are how the archive is searched, so
  // neither is a guest's to change. Both accept a form POST as well as JSON —
  // the reading room edits them from a phone.
  if (req.method === 'POST' && url === '/rename-page') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      // the library is one conversation with a name of its own, and the
      // choreography renames the chat after it: it is not a row to relabel
      if (store.isLibrary(page.url)) return fail(res, 400, 'the library is not a page you can rename');
      // an empty title is the way back to the page's own name, never an error
      const saved = store.renamePage(page.url, data.title);
      broadcast({ type: 'page', url: saved.url });
      if (data._form) return seeOther(res, backTo(data, saved));
      ok(res, { title: store.displayTitle(saved), custom_title: saved.custom_title || null });
    });
  }
  if (req.method === 'POST' && url === '/tag-page') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      if (store.isLibrary(page.url)) return fail(res, 400, 'the library is not a page you can tag');
      // a form sends one comma-separated field; the drawer sends an array.
      // store.normalizeTags takes either and is the only place tags are shaped
      const saved = store.tagPage(page.url, data.tags);
      broadcast({ type: 'page', url: saved.url });
      if (data._form) return seeOther(res, backTo(data, saved));
      ok(res, { tags: store.tagsOf(saved) });
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
  // Resolving a thread — the reader saying "handled". Server-side state, like
  // every other thing about a thread, so it survives a reload and shows up on
  // the phone and the other machine.
  //
  // Not owner-only: on a shared companion the people reading the page are the
  // people working through its comments, and the act is free to undo (reopen,
  // or simply reply). It is attributed all the same — `resolved_by` is the one
  // thing a reopen cannot recover.
  //
  // NO CONFIRMATION ANYWHERE IN THIS PATH. Resolving is triage: a dozen clicks
  // in a few seconds down a page that has accumulated too many threads. One
  // request, one write, one broadcast, and the answer is the thread itself so
  // the drawer can reconcile its optimistic redraw without a refetch.
  if (req.method === 'POST' && url === '/resolve') {
    return readBody(req, res, data => {
      const me = authorOf(req, res);
      if (!me) return;
      const page = pageOf(res, data);
      if (!page) return;
      const thread = store.findThread(page, data.thread_id);
      if (!thread) return fail(res, 404, 'unknown thread');
      // a form has no booleans: absent/"" from the reading room's reopen
      // button means reopen, and only an explicit truthy value resolves
      const on = data.resolved === undefined ? true
        : !(data.resolved === false || data.resolved === 'false' || data.resolved === '' || data.resolved === '0');
      const { changed } = store.setResolved(thread, on, me.handle);
      // the placeholder goes in the same write as the flag, so the card is
      // never blank for even one frame; the agents' paragraph replaces it
      // whenever the job behind it drains
      let queued = false;
      if (on && changed) {
        store.setSummary(thread, store.threadDigest(thread), '');
        queued = summarizeThread(page, thread);
      }
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      if (data._form) return seeOther(res, backTo(data, page, on ? '' : thread.id));
      ok(res, { thread, ...(queued ? { summarizing: true } : {}) });
    });
  }
  // "not done" — the reader's answer to a thread the bots claimed handled.
  //
  // Marking a thread ADDRESSED is automatic and needs no endpoint: a bot's
  // reply landing in it does that, in store.appendMsg, which every write path
  // already goes through. UNMARKING is the one thing only a person can mean,
  // so it is the one thing that needs a door. It is the same class of act as
  // reopening — free, undoable, attributable — so it takes the same gate as
  // /resolve (an author, not ownership): on a shared companion the people
  // reading the page are the people working through its comments.
  //
  // The `addressed:true` direction is accepted too, for symmetry and so a
  // second reader can hand a thread back without replying into it, but it is
  // not the path the bots use and nothing in the drawer offers it.
  if (req.method === 'POST' && url === '/addressed') {
    return readBody(req, res, data => {
      const me = authorOf(req, res);
      if (!me) return;
      const page = pageOf(res, data);
      if (!page) return;
      const thread = store.findThread(page, data.thread_id);
      if (!thread) return fail(res, 404, 'unknown thread');
      // a form has no booleans: absent/""/"0"/"false" all mean "not done"
      const on = data.addressed === undefined ? false
        : !(data.addressed === false || data.addressed === 'false' || data.addressed === '' || data.addressed === '0');
      store.setAddressed(thread, on, on ? me.handle : '');
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      if (data._form) return seeOther(res, backTo(data, page, thread.id));
      ok(res, { thread });
    });
  }
  // The passage moved under the thread, and the page found it again.
  //
  // A bot's change rewrites the quoted passage; the highlight orphans; the
  // bot's reply says what it now reads. The EXTENSION locates that wording on
  // the live page (the companion has no DOM and must never rewrite an anchor
  // on a claim alone), and this is where a successful locate is made durable —
  // so the highlight is on the new wording on the next visit, on the phone,
  // and in every other tab, and not only in the tab that happened to look.
  //
  // OWNER-ONLY, unlike /resolve and /addressed. Those are opinions about a
  // thread and are free to undo; this EDITS the record's own anchor, and
  // `prior_quote` is the one thing a wrong write here would cost — the "was"
  // half of the before→after, which nothing can recover once it is gone.
  //
  // store.reanchorThread refuses anything but the wording the thread's own
  // last bot message quoted back, so the door cannot be used to set a quote to
  // whatever a client likes.
  if (req.method === 'POST' && url === '/reanchor') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const thread = store.findThread(page, data.thread_id);
      if (!thread) return fail(res, 404, 'unknown thread');
      const r = store.reanchorThread(thread, {
        quote: data.quote, prefix: data.prefix, suffix: data.suffix,
      });
      if (!r.ok) return fail(res, 409, r.reason);
      if (r.changed) {
        store.savePage(page);
        broadcast({ type: 'page', url: page.url });
      }
      ok(res, { thread: r.thread, changed: !!r.changed });
    });
  }
  // Ask for the paragraph again — the same job /resolve queues, on demand, for
  // a thread whose summary landed while the bridge was down or which has moved
  // on since it was filed.
  if (req.method === 'POST' && url === '/summarize') {
    return readBody(req, res, data => {
      const me = authorOf(req, res);
      if (!me) return;
      const page = pageOf(res, data);
      if (!page) return;
      const thread = store.findThread(page, data.thread_id);
      if (!thread) return fail(res, 404, 'unknown thread');
      if (!summarizeThread(page, thread)) return fail(res, 409, 'the agents are off on this companion');
      ok(res, { summarizing: true });
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
      // …except in the library, where the conversation is the whole note:
      // "comments only" would write an empty file, so it is not on offer there
      // (the drawer does not show the chooser for it either).
      const mode = store.isLibrary(page.url) ? 'all' : exportMode(data.mode);
      try { ok(res, { path: exportPage(page, store.readConfig(), new Date(), mode), mode }); }
      catch (e) { fail(res, 500, `export failed: ${e.message}`); }
    });
  }
  // Model and effort are the reader's standing PREFERENCES, stored in
  // config.json and imposed on the bridge at every wake — so they can be chosen
  // before the agents have ever run, which is when anybody actually wants to
  // choose them. A running bridge is told at once as well; a sleeping one is
  // NOT woken for a setting (waking costs twenty seconds and an idle child).
  // `applies` says which of those happened, and the drawer says so in words.
  const setAgentPref = (res, kind, agent, value, control) => {
    store.saveAgents({ [kind]: { [agent]: value } });
    const live = anyRunning();
    if (live) controlAll(control);
    // a preference the bridge has not been told about yet still moved: every
    // other tab's picker has to follow it now, not at the next wake
    broadcast({ type: 'models', ...modelsPayload() });
    ok(res, { queued: live, applies: live ? 'now' : 'at-wake' });
  };
  if (req.method === 'POST' && url === '/model') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const agent = String(data.agent || '');
      const model = String(data.model || '');
      if (agent !== 'claude' && agent !== 'codex') return fail(res, 400, 'agent must be claude or codex');
      if (!/^[\w.-]+$/.test(model)) return fail(res, 400, 'bad model id');
      if (NO_AGENTS) return fail(res, 409, AGENTS_OFF_REASON);
      // when the bridge has published its lists — or the cache remembers the
      // ones it published last time — the model must be on them; before that we
      // store blind and let the bridge refuse at wake
      const options = (chat.models().options || {})[agent];
      if (options && options.length && !options.includes(model)) return fail(res, 400, `unknown model for ${agent}`);
      setAgentPref(res, 'model', agent, model, `/model @${agent} ${model}`);
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
      setAgentPref(res, 'effort', agent, level, `/effort @${agent} ${level}`);
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
      if (!anyRunning()) return fail(res, 409, 'agents are idle — nothing to relay');
      controlAll(`/relay @${agent}`);
      ok(res, { queued: true });
    });
  }
  // stopping a turn stops it for everyone in the room
  if (req.method === 'POST' && url === '/interrupt') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      if (!data.url) return fail(res, 400, 'url required');
      const nu = store.normUrl(data.url);
      const c = chatFor(nu);
      ok(res, { interrupted: !!(c && c.interrupt(nu)) });
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
      syncWatchers();
      ws.onclose = () => { wsClients.delete(ws); syncWatchers(); };
    },
  });
  // Ctrl-C / launcher stop: run the exit hooks (lock file) and take the
  // bridge child with us instead of orphaning it
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { for (const c of allChats()) c.stop(); process.exit(0); });
  }
  server.listen(PORT, '127.0.0.1', () => {
    const p = server.address().port;
    console.log(`Web annotator companion live at http://127.0.0.1:${p} — workspace: ${store.ROOT}`);
    if (NO_AGENTS) console.log('--no-agents: bots are off; annotations and export still work');
    if (HOSTED) {
      console.log('--hosted: remote visitors need the password; localhost stays the owner');
      console.log(`  reading room: /pages   agent grants: ${hosted.grantsFile}`);
    }
    // One anonymous "someone started this today", at most once a day, and only
    // if this build was given an api secret at all (beacon.mjs). Deliberately
    // after listen(): nothing about serving waits on it, and it cannot fail
    // in a way anybody notices.
    beacon.ping({ dir: store.DIR, config: store.readConfig() })
      .then(r => { if (r.sent) console.log('· anonymous usage ping sent (BOTFERENCE_NO_TELEMETRY=1 to opt out)'); })
      .catch(() => { });
  });
  // heartbeat: dead extension workers surface, live ones stay warm
  setInterval(() => {
    for (const res of sseClients) res.write('data: {"type":"ping"}\n\n');
    for (const ws of wsClients) ws.send('{"type":"ping"}');
  }, HEARTBEAT_MS).unref();
}
