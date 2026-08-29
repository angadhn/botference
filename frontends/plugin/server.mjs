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
import { createChat, hasMention, priorMsgs, commentsDigest, routePrefix, stickyRoute } from './chat.mjs';
import { createPool } from './pool.mjs';
import { exportPage, exportMode } from './export.mjs';
import { createHosted, CORS_HEADERS, isLocalDirect, sanitizeHandle } from './hosted.mjs';
import { pageView, pagesView, articleView, quizView } from './views.mjs';
import * as questions from './questions.mjs';
import { sanitizeArticle } from './sanitize.mjs';
import * as run from './run.mjs';
import * as keys from '../shared/keys.mjs';
import * as beacon from './beacon.mjs';
import * as workspace from './workspace.mjs';
import * as blog from './blog.mjs';
import * as suggest from './suggest.mjs';
import * as collateral from './collateral.mjs';

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
const BLOG_UNCONFIRMED_REASON = 'this page is served from a repo you have not confirmed yet';
const BLOG_UNCONFIRMED_ERROR = 'confirm the blog repo in the drawer before the bots can edit this draft';
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS) || 15000;
const JSON_HEAD = { 'content-type': 'application/json', 'cache-control': 'no-store' };
// article_text rides along with mentions, and a .docx may ride with them too —
// base64 of an 8MB document is ~11MB of request body, so the wire limit sits
// above the document limit, not at it
const DOCX_MAX = 8 * 1024 * 1024;
const BODY_MAX = 12 * 1024 * 1024;
// One rendered page, PNG or JPEG. A text page at 1700px is a few hundred KB
// and a page of photographs is a couple of megabytes; 4 MB is well clear of
// both and well under the wire limit, which base64 inflates by a third.
const PAGE_IMAGE_MAX = 4 * 1024 * 1024;
const pngLike = b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const jpegLike = b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

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
// --- the review's decision log, kept in step ------------------------------
//
// A decision was just made on this page — a thread filed, a thread deleted, a
// strikeout minted, renoted or adopted, a suggestion accepted or turned down —
// so the log the bots read (store.writeDecisionLog) is now one line out of
// date. Regenerated WHOLE rather than patched, because it is nothing but a
// serialization of the record and a patch would be a second implementation of
// the same truth.
//
// DEBOUNCED, and the reason is Accept all: one click applies a stack of cards
// and would otherwise rewrite the same file once per card. A trailing timer
// per page collapses a burst into one write, and the record is re-read when it
// fires so what lands is the state as it finally settled, never a stale copy
// captured at the first event. The write is skipped entirely when the content
// has not moved, so a burst that changed nothing costs nothing.
//
// This is belt and braces: the log is ALSO written at the front of the turn
// queue (chat.mjs planSteps), which is what guarantees a turn never names a
// stale file. What this adds is freshness for a bot reading the file DURING a
// long turn of its own, and a file on disk that matches the drawer.
const DECISION_DEBOUNCE_MS = Number(process.env.PLUGIN_DECISION_DEBOUNCE_MS || 100);
const decisionTimers = new Map();
function noteDecisions(page) {
  const url = page && page.url;
  if (!url) return;
  const key = store.pageKey(url);
  if (decisionTimers.has(key)) return;      // a burst writes once, at its end
  const t = setTimeout(() => {
    decisionTimers.delete(key);
    try {
      const now = store.readPage(url);
      if (now) store.writeDecisionLog(now);
    } catch { /* the log is a convenience; it never fails a request */ }
  }, DECISION_DEBOUNCE_MS);
  if (typeof t.unref === 'function') t.unref();
  decisionTimers.set(key, t);
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
//
// …and it is a POOL, not a child. Ordinary pages used to share one bridge and
// therefore one queue: a question on a blog post waited out a review round on a
// paper. pool.mjs dispatches them — one lane per page, several lanes at once,
// strictly serial inside a lane — and presents exactly the surface a single
// bridge presented, so everything below this line reads as it always did.
// `bridge_pool: 1` is the old behaviour, unchanged, on purpose.
const chat = NO_AGENTS ? null : createPool({
  onEvent: onChatEvent,
  max: store.readConfig().bridge_pool,
  idleMs: store.readConfig().bridge_idle_ms,
});

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

// --- the blog bridges -------------------------------------------------------
// A page of the reader's own site, served locally by `jekyll serve`, whose
// SOURCE is a markdown file in a repo they have vouched for (blog.mjs). Same
// shape as a workspace bridge and for the same reason: the writable directory
// is baked into a child's environment when it spawns, so a scope means a
// child. One child per REPO — the repo is the write root, so it is also the
// lock, exactly as a project folder is (SPEC: "a lane = the child").
//
// Unlike a workspace bridge the working root stays the companion's own: a blog
// chat is an ordinary page chat filed under "Plugin pages". The reader's blog
// repo is somewhere the bots may EDIT; it is not somewhere this companion
// files conversations, and writing session records into a website's git repo
// would be a surprise nobody asked for.
const blogChats = new Map();        // repo root → chat

function blogChatFor(root, kind = 'jekyll') {
  let c = blogChats.get(root);
  if (c) return c;
  c = createChat({
    onEvent: onChatEvent,
    // …and the commands this child may not run, which for every kind of blog
    // root is git and gh. The reader publishes their own website; Discuss has
    // no publish code and its bots are given no way to improvise one. See
    // blog.mjs — the rule belongs to the KIND and lives in code, so a config
    // restored onto another machine cannot arrive with it switched off.
    denyBash: blog.deniedCommands(kind),
    // the ONE directory this child may write in. chat.mjs hands it to the CLIs
    // (BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS), so the boundary is theirs to enforce
    // and not a promise made in a prompt. It is the REPO, because a directory
    // is the only thing an OS sandbox understands — that the bots touch one
    // post inside it is the envelope's instruction plus the turn-end census,
    // and blog.mjs says so out loud.
    writeRoot: root,
  });
  blogChats.set(root, c);
  return c;
}

// Which blog page a url is, cached for a moment exactly as artifactOf is: the
// answer costs a config read plus (on a first hit) a scan of the repo's front
// matter, and every /reply and page load asks.
const blogCache = new Map();
function blogOf(url) {
  const key = String(url || '');
  if (!key) return null;
  const now = Date.now();
  const hit = blogCache.get(key);
  if (hit && now - hit.at < ART_TTL) return hit.page;
  const page = blog.blogPageFor(key);
  if (blogCache.size > 200) blogCache.clear();
  blogCache.set(key, { at: now, page });
  return page;
}
const forgetBlogPages = () => blogCache.clear();

// The bridge that owns a page's chat. Everything that submits a turn, asks
// what is queued or interrupts one goes through here — a project-artifact
// page must never reach the "Plugin pages" bridge, and an ordinary page must
// never reach a council's.
//
// ── THE LOCK TAXONOMY, IN ONE PLACE ───────────────────────────────────────
// This function IS the dispatcher's outer rule, and there are exactly two
// answers to it:
//
//   an ordinary page   → the pool (pool.mjs). Lane = the page. Turns on one
//                        page are serial; turns on different pages run at the
//                        same time, up to `bridge_pool`.
//   a project artifact → that project's own child. Lane = the PROJECT, because
//                        the lane and the child are the same thing here: one
//                        (root, project) → one process → one FIFO. That is the
//                        per-project WRITE LOCK, and it was already load-bearing
//                        before parallelism existed (Phase 2 bakes the writable
//                        directory into the child's environment at spawn).
//
// Everything that has to be attributed to a turn hangs off that second rule.
// The collateral census (`noteTurnStart` → `reportProjectChanges`) snapshots a
// PROJECT DIRECTORY and diffs it at turn-end; the send-review round ticker
// counts turn boundaries on ONE PAGE. Both are safe under parallelism for the
// same reason and by construction rather than by care: nothing that shares a
// project directory can run concurrently, because a project is one child, and
// nothing that shares a page can either, because a page is one lane.
//
// An UNCONFIRMED root falls back to no bridge at all: the reader has not yet
// said that directory is theirs, and spawning a child against it is precisely
// what the confirmation exists to gate.
//
// …and a THIRD answer since blog source pages: a page of the reader's own
// site, served locally out of a repo they have confirmed, whose source file
// this companion can name. Lane = the REPO, for the same reason a project's
// lane is the project: one repo, one child, one writable directory, one FIFO.
// A page under a registered origin that maps to NO source file is an ordinary
// web page on the ordinary pool — it can be discussed, and nothing is
// writable, which is the honest answer to "I do not know which file this is".
function chatFor(url) {
  if (!chat) return null;
  const art = artifactOf(url);
  if (art) {
    if (!art.confirmed) return null;
    return workspaceChatFor(art.root, art.project_id, art.project_dir);
  }
  const bg = blogOf(url);
  // …and a repo the reader has DECLINED is not a blog page at all any more:
  // "leave this page alone" is about the files, so the page goes back to being
  // the ordinary web page it looks like — discussable, with nothing writable —
  // rather than refusing every turn forever over a question already answered.
  if (bg && bg.source_path && !bg.declined) {
    if (!bg.confirmed) return null;
    return blogChatFor(bg.root, bg.kind);
  }
  return chat;
}
const allChats = () => (chat ? [chat, ...workspaceChats.values(), ...blogChats.values()] : []);
// Does THIS page have a turn in flight or waiting anywhere? The mirror refill
// below asks before it rewrites a page chat: a turn owns that conversation
// until it ends, and refilling underneath one would race the reply about to
// land in it. Asked across every bridge, because a page's bridge can change
// (an unconfirmed root routes to none, a confirmed one to its own child).
const pageBusy = url => allChats().some(c => c.busyFor && c.busyFor(url));
const anyRunning = () => allChats().some(c => c.state() === 'running');
const totalQueue = () => allChats().reduce((n, c) => n + c.queueLength(), 0);
// Every turn the companion is holding, grouped by the page it is for — across
// the pool and every council child. `running` is the turn that has the floor;
// `queued` is what is behind it in that page's lane. See GET /health.
function queueRows() {
  const by = new Map();
  for (const c of allChats()) {
    for (const j of (c.jobs ? c.jobs() : [])) {
      if (j.control || !j.url) continue;
      const row = by.get(j.url) || { url: j.url, running: false, queued: 0 };
      if (j.running) row.running = true; else row.queued++;
      by.set(j.url, row);
    }
  }
  return [...by.values()];
}
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

// The artifact's own bytes, or '' — capped, and a read that fails is simply no
// snapshot, which costs the turn its collateral threads and nothing else.
function artifactSnapshot(art) {
  try {
    const st = fs.statSync(art.path);
    if (!st.isFile() || st.size > collateral.SNAPSHOT_MAX) return '';
    return fs.readFileSync(art.path, 'utf8');
  } catch { return ''; }
}

function noteTurnStart(url) {
  const art = url ? artifactOf(url) : null;
  if (!art) return noteBlogTurnStart(url);
  if (!art.confirmed || !art.project_dir) return;
  turnScans.set(url, {
    dir: art.project_dir,
    before: workspace.scanProject(art.project_dir),
    // …and the document itself, which is the half the census cannot give:
    // mtime and size say THAT the page moved, never what moved in it
    // (collateral.mjs)
    text: artifactSnapshot(art),
    at: new Date().toISOString(),
  });
}

// The same census, over a blog repo. Two differences, both of them about what
// a Jekyll repo IS:
//
//   · the scan skips `_site/` and the caches (blog.SKIP_DIRS). Those are the
//     RENDERED copy, and they all move a second after the bots save the
//     source — because jekyll rebuilt, which is the thing we are waiting for.
//     Counting them would make every turn "42 files changed" and the reload
//     would be reporting the build, not the edit.
//   · the document whose bytes are snapshotted for the collateral diff is the
//     MARKDOWN SOURCE, not the page the reader is looking at. The rendered
//     page is a photocopy; diffing it would attribute jekyll's own layout
//     churn to the bots.
function noteBlogTurnStart(url) {
  const bg = url ? blogOf(url) : null;
  if (!bg || !bg.confirmed || !bg.source_path) return;
  turnScans.set(url, {
    blog: true,
    dir: bg.root,
    source: bg.source_path,
    before: blog.scanSite(bg.root),
    // markdown, presented to the diff as one block per paragraph — see
    // blog.mdDoc: collateral.mjs finds its blocks in HTML tags, and raw
    // markdown has none, so an unblocked file diffs as one enormous region
    text: blog.mdDoc(sourceSnapshot(bg.source_path)),
    // …and, in suggest mode, the instruction NOT to diff it. Collateral threads
    // exist to catch edits nobody commented on — a change that landed silently
    // because no thread stood where it landed. In suggest mode no change lands
    // during a turn at all: the bots propose, the file is untouched until the
    // reader accepts, and every proposal is already a card in front of them. A
    // diff here could therefore only report the reader's OWN accepted edits
    // back to them as if a bot had slipped them in, and the >6-region collapse
    // would fold a sweep the reader is mid-way through into one summary note.
    // The census itself stays: a picture placed under assets/ is still a real
    // write and the tab still has to reload for it.
    noCollateral: !!bg.suggest_mode,
    at: new Date().toISOString(),
  });
}

// One source file's bytes, capped — the same read artifactSnapshot makes, and
// the same tolerance: a read that fails costs the turn its collateral threads
// and nothing else.
function sourceSnapshot(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > collateral.SNAPSHOT_MAX) return '';
    return fs.readFileSync(file, 'utf8');
  } catch { return ''; }
}

// ---- the edits nobody commented on ---------------------------------------
// The backstop. A bot asked to fix one passage often has to follow the change
// out into the rest of the draft — a cross-reference, a paragraph that now
// contradicts itself — and that is wanted. What is not wanted is it landing
// SILENTLY: there is no thread at that spot, so nothing narrates it, and the
// reloaded tab shows the new sentence looking exactly like prose nobody
// touched.
//
// So the turn's before/after text is diffed (collateral.regionsFrom) and every
// changed region no thread already covers becomes a thread of its own, written
// with the same three fields the track-changes machinery already runs on:
// `quote` = what stands there now, `prior_quote` = what it replaced,
// `addressed` = the amber "ready for review" state. The extension needs no
// change at all — content.js paints from those three and asks no questions
// about who wrote them.
//
// `auto: true` is the only new field, and it exists for the dedupe to read: it
// is what tells a later turn "this thread is the machine's, not the reader's",
// which is the difference between suppressing a second change to the same
// passage and reporting it. Nothing renders differently on it.
//
// Send review is already right about these and needs no rule: an auto-thread is
// `addressed`, and `workspace.openThreads` excludes addressed threads because a
// bot has had its go and it is the reader's turn to look — which is exactly
// what this is.
// `after` is the document's bytes as the turn ended — the artifact's own HTML,
// or (on a blog page) the MARKDOWN SOURCE the page was rendered from. The diff
// basis is deliberately the file the bots edited rather than the page the
// reader is looking at: the rendered copy is regenerated wholesale by jekyll
// and diffing it would attribute the build to the bots.
function reportCollateral(page, seen, after, ev) {
  if (!page || !seen || !seen.text) return 0;
  if (!after) return 0;
  // …and never on a turn that proposed instead of writing (noteBlogTurnStart
  // says why at length). Suggestions are cards by construction; they are not
  // regions discovered in a diff, and they must not be summary-collapsed.
  if (seen.noCollateral) return 0;
  const agents = (ev && Array.isArray(ev.agents) && ev.agents.length) ? ev.agents : [];
  const who = agents.length === 1 ? `@${agents[0]}` : 'the bots';
  const author = store.isAgentAuthor(agents[0]) ? agents[0] : 'claude';
  let made = 0;
  try {
    const plan = collateral.collateral(seen.text, after, page, { since: seen.at, who });
    // …and FIRST, the repairs. A region whose old text was a reader's own
    // quoted passage does not become a new thread announcing the change — it
    // goes back into the thread that was about to orphan, which is where the
    // reader is already looking. `collateral()` has already made sure a region
    // cannot do both, so this loop and the next never cover the same change.
    for (const h of plan.heals) {
      const thread = (page.threads || []).find(t => t && t.id === h.thread_id);
      if (!thread) continue;
      const done = store.healThread(thread, {
        quote: h.quote, prefix: h.prefix, suffix: h.suffix, deleted: h.deleted,
      });
      if (!done.ok || !done.changed) continue;
      // the narration the bot never wrote, in the reader's own thread — and it
      // is what flips the thread amber (appendMsg sets `addressed` for an
      // agent author), so it sorts into "ready for review" like any answer
      store.appendMsg(page, thread.id, { author, text: h.text });
      made++;
    }
    for (const t of plan.threads) {
      const thread = store.addThread(page, {
        quote: t.quote, prefix: t.prefix, suffix: t.suffix, text: t.text, author,
      });
      thread.auto = true;
      if (t.summary) thread.auto_summary = true;
      if (t.prior_quote) thread.prior_quote = t.prior_quote;
      // the amber middle state, straight away: a bot has been here and it is the
      // reader's turn to look, which is what this thread IS
      store.setAddressed(thread, true, author);
      made++;
    }
  } catch { return 0; }   // a diff that throws must never cost the turn its reload
  return made;
}



function reportProjectChanges(ev) {
  const url = ev && ev.url;
  const seen = url ? turnScans.get(url) : null;
  if (!seen) return;
  turnScans.delete(url);
  if (seen.blog) return reportBlogChanges(url, seen, ev);
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
  // …and, where the page ITSELF moved, what moved in it that nobody had left a
  // comment on. Before the reload event, so the tab that comes back is already
  // carrying the threads (the record is saved here; `project-files` makes the
  // tab refetch it).
  if (payload.page_changed) {
    const page = store.readPage(url);
    if (page && reportCollateral(page, seen, artifactSnapshot(art), ev)) {
      store.savePage(page);
      payload.collateral = true;
      broadcast({ type: 'page', url });
    }
  }
  lastChanges.set(url, payload);
  if (lastChanges.size > CHANGES_KEEP) lastChanges.delete(lastChanges.keys().next().value);
  broadcast(payload);
}

// The same report for a blog page, and the loop it closes.
//
// The reader commented on a rendered page; the bots edited the markdown behind
// it; jekyll noticed the save and rebuilt (that is what `jekyll serve` does,
// with or without --livereload). What is left is telling the TAB, because a
// browser has no idea a file three directories away has changed: `blog-files`
// with `page_changed` true means "the post you are reading was rewritten —
// reload", and the reader sees the regenerated page.
//
// A repo with --livereload gets there twice, harmlessly: livereload's own
// socket reloads the tab, this event reloads it again if it beat the rebuild,
// and neither can loop because a reload starts no turn.
//
// The BUILD IS NOT WAITED FOR, deliberately. A companion that polled for
// `_site/` to settle would be guessing at somebody else's watcher; the tab is
// told as soon as the source moved, and a reload that lands a moment early
// shows the previous render for one keystroke of time and is reloaded again by
// livereload where it is on. The alternative — hold the reader's page back
// while we watch a directory — is worse and less honest.
function reportBlogChanges(url, seen, ev) {
  const bg = blogOf(url);
  if (!bg || !bg.confirmed || bg.root !== seen.dir) return;   // un-confirmed mid-turn
  const changed = workspace.diffScans(seen.before, blog.scanSite(seen.dir));
  if (!changed.length) return;
  const own = path.relative(seen.dir, seen.source).split(path.sep).join('/');
  const payload = {
    type: 'blog-files',
    url,
    root: bg.root,
    serve_origin: bg.serve_origin,
    source: own,
    count: changed.length,
    // whether the post the reader is reading is one of them
    page_changed: changed.includes(own),
    // …and whether anything under assets/ moved, which is the other half of
    // "the page looks different now": a picture was placed or replaced
    assets_changed: changed.some(rel => (bg.assets || []).some(a => rel.startsWith(`${a}/`))),
    files: changed.slice(0, workspace.CHANGED_LIST_MAX),
    at: new Date().toISOString(),
  };
  // an image placed in the post is a change to the page as surely as a
  // rewritten paragraph is, and the reader wants to look at it
  if (payload.assets_changed) payload.page_changed = true;
  if (changed.includes(own)) {
    const page = store.readPage(url);
    // …and the edits nobody commented on, diffed on the SOURCE. The threads it
    // opens carry markdown wording, which anchors on the rendered page for
    // ordinary prose and does not for a passage that is mostly markup — an
    // orphaned thread the reader can still read, which is better than a silent
    // rewrite. (SPEC amendment: the anchoring caveat.)
    if (page && reportCollateral(page, seen, blog.mdDoc(sourceSnapshot(seen.source)), ev)) {
      store.savePage(page);
      payload.collateral = true;
      broadcast({ type: 'page', url });
    }
  }
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

// ---- the review round, as one visible thing ------------------------------
//
// A round fans out into one turn per open comment (see /send-review). Each of
// those turns spins its own card, and the cards are scattered down a rail the
// reader has to scroll. So the round — the thing the reader actually started —
// had no representation anywhere: no count, no position in it, no end. Twenty
// comments in, "is this still going?" was a question the UI could not answer.
//
// So the companion keeps the round, because the companion is what HAS it: it
// built the queue, it names the threads, and it sees every turn boundary. The
// tab renders a broadcast, and holds no round state of its own — which is what
// makes the strip survive a refresh, a reopened drawer, and a second tab.
//
// The state is deliberately thin: which threads are still to come, which one is
// in flight, how many are answered. Everything else the strip shows (the quote,
// the link) is a lookup into the record the tab already has.
const rounds = new Map();          // page url → round
// A finished round's "round done — N answered" note is kept this long so a tab
// that was closed for the last turn still comes back to the outcome rather than
// to silence. Past that it is history, and the thread cards are the record.
const ROUND_KEEP_MS = 5 * 60 * 1000;

function roundPayload(url, r) {
  return {
    type: 'round', url,
    running: !r.done_at,
    total: r.total,
    answered: r.answered,
    // the thread a bot is answering RIGHT NOW, or null between turns
    current: r.current,
    // …and its words, so the strip can name it without a record lookup that
    // may not have arrived yet
    current_quote: r.current ? (r.quotes[r.current] || '') : '',
    started_at: r.started_at,
    done_at: r.done_at || null,
  };
}

function broadcastRound(url) {
  const r = rounds.get(url);
  if (r) broadcast(roundPayload(url, r));
}

function startRound(url, page, threadIds) {
  const quotes = {};
  for (const id of threadIds) {
    const t = store.findThread(page, id);
    quotes[id] = t ? String(t.quote || '').slice(0, 160) : '';
  }
  rounds.set(url, {
    pending: new Set(threadIds),
    quotes,
    total: threadIds.length,
    answered: 0,
    current: null,
    started_at: new Date().toISOString(),
    done_at: '',
  });
  // bounded, newest wins — one page's round is not a reason to hold another's
  if (rounds.size > 20) rounds.delete(rounds.keys().next().value);
  broadcastRound(url);
}

// A turn boundary that belongs to a live round. The preamble turn (target =
// page chat) is deliberately NOT one of these: it is the round announcing
// itself, and the strip already says "starting" while nothing is in flight.
function roundTurn(ev, phase) {
  const r = ev && ev.url ? rounds.get(ev.url) : null;
  if (!r || r.done_at) return;
  const id = ev.target;
  if (!id || !r.pending.has(id)) return;
  if (phase === 'start') { r.current = id; broadcastRound(ev.url); return; }
  r.pending.delete(id);
  r.answered++;
  r.current = null;
  // The round is over when nothing is left to answer. Note this counts a turn
  // the bridge STRANDED (chat.mjs emits turn-end for every job it drops), which
  // is right: the strip must not spin forever because a bridge died.
  if (!r.pending.size) {
    r.done_at = new Date().toISOString();
    setTimeout(() => {
      const still = rounds.get(ev.url);
      if (still === r) rounds.delete(ev.url);
    }, ROUND_KEEP_MS).unref?.();
  }
  broadcastRound(ev.url);
}

function onChatEvent(ev) {
  // chat.mjs knows nothing about config.json; the verbosity a tab renders
  // rides the same event as everything else in that panel
  if (ev.type === 'models') {
    return broadcast({ ...ev, verbosity: store.readConfig().verbosity, keys: keys.status() });
  }
  // the turn boundary is where the census is taken; a summary job (silent by
  // construction) emits neither of these, so filing a thread never counts
  if (ev.type === 'chat' && ev.kind === 'turn-start') { noteTurnStart(ev.url); roundTurn(ev, 'start'); }
  if (ev.type === 'chat' && ev.kind === 'turn-end') {
    broadcast(ev);
    roundTurn(ev, 'end');
    // after the turn-end, always: the drawer stops spinning first and only
    // then hears that the file moved
    reportProjectChanges(ev);
    return;
  }
  if (ev.type === 'chat' && ev.kind === 'reply') {
    const page = store.readPage(ev.url);
    if (page) {
      // Did the bot say where this page belongs? Only on a page filed
      // nowhere, only against a project the roster actually offered, and only
      // ever as a BUTTON: the suggestion is lifted off the reply's last line
      // into `msg.file_in`, the line itself is taken out of the words (it is
      // machinery, not prose), and the reader clicks or does not. Bots never
      // file anything — the same rule the confirmation card holds for council
      // roots, for the same reason.
      if (ev.msg && !store.projectsOf(page).length) {
        const hit = workspace.parseSuggestion(
          ev.msg.text, workspace.projectRoster({ peek: false }),
        );
        if (hit) {
          ev.msg = {
            ...ev.msg,
            text: String(ev.msg.text).split(/\r?\n/)
              .filter(l => l !== hit.line).join('\n').trimEnd(),
            file_in: { root: hit.root, id: hit.id, title: hit.title, why: hit.why },
          };
        }
      }
      // …and did the bot conclude the passage should come out? Same idiom,
      // same three rules: only where the offer was actually made (strikeable —
      // a PDF, an unstruck thread, an open one), only as a standalone line, and
      // only ever as a BUTTON. The line is lifted off the reply's words into
      // `msg.strike` because it is machinery and not prose, and the reader
      // clicks or does not. Confirming it does not touch THIS thread at all: it
      // mints a strike of the reader's own (POST /strike-from).
      if (ev.msg && ev.target !== store.PAGE_CHAT) {
        const th = store.findThread(page, ev.target);
        if (strikeable(page, th)) {
          // ALL of them, now. One discussion routinely concludes that two or
          // three separate places have to change, and a thread can only ever
          // mint one card for its own quote — so a reply may carry up to
          // STRIKE_PER_REPLY_MAX suggestions, each about a different passage,
          // each becoming its own chip and its own card.
          const hits = store.parseStrikeSuggestions(ev.msg.text);
          const machinery = hits.flatMap(h => h.lines || [h.line])
            .concat(hits.orphanLines || []);
          if (hits.length) {
            // the page's own text, for the `passage:` check below — read ONCE
            // for the whole reply however many suggestions it carries
            const html = store.readSnapshot(store.pageKey(page.url));
            const strikes = hits.slice(0, store.STRIKE_ENTRY_MAX).map((hit, i) => {
              const clipped = hit.why.slice(0, 400);
              // past the cap: a visible refusal rather than a silent drop, for
              // the reason every other refusal here is visible — a suggestion
              // that vanished is indistinguishable from one never made.
              if (i >= store.STRIKE_PER_REPLY_MAX) {
                return { why: clipped, rejected: 'capped' };
              }
              const { fault, phrase } = store.strikeNoteFault(hit.why);
              if (fault) {
                return { why: clipped, rejected: fault, ...(phrase ? { phrase } : {}) };
              }
              // …and did it name its own passage? Checked HERE, against the
              // page's real text, so a wording that cannot be located never
              // becomes a button. The reader's partial highlight is corrected
              // by the bot, never by being sent back to re-highlight it.
              if (hit.passage) {
                const r = store.resolvePassage(page, th, hit.passage, html);
                if (r.fault) {
                  return { why: clipped, passage: hit.passage, rejected: r.fault,
                    ...(r.phrase ? { phrase: r.phrase } : {}) };
                }
                return { why: hit.why, passage: r.anchor.quote };
              }
              return { why: hit.why };
            });
            ev.msg = {
              ...ev.msg,
              text: String(ev.msg.text).split(/\r?\n/)
                .filter(l => machinery.indexOf(l) < 0).join('\n').trimEnd(),
              strikes,
            };
          } else if (machinery.length) {
            // a `passage:` line that named nothing is machinery too
            ev.msg = {
              ...ev.msg,
              text: String(ev.msg.text).split(/\r?\n/)
                .filter(l => machinery.indexOf(l) < 0).join('\n').trimEnd(),
            };
          }
        }
      }
      // …and did the bot notice the reader had not GOT something? Third use of
      // the same idiom, same three rules (only where the offer was made, only
      // as a standalone line, only ever as a button). Confirming it does not
      // touch this thread either: it files a card in the vault, made from this
      // passage and aimed at the gap the line names.
      if (ev.msg && ev.target !== store.PAGE_CHAT) {
        const th = store.findThread(page, ev.target);
        if (questionable(page, th)) {
          // …or to CORRECT one this discussion has already filed. A revision
          // is a whole card rather than a one-line offer, so it is the fenced
          // block with a `revises: <card-id>` line in it, and it is checked
          // HERE — at the lift — against the vault the reader actually has.
          //
          // The two ways it can be wrong are the two ways a pointer is ever
          // wrong: the card is not there, or it is somebody else's. Neither is
          // ever allowed to fall through into minting a new card — that is
          // precisely the failure this exists to stop, and a silent second
          // card is worse than no button at all. So the block still comes off
          // the words (it is machinery), the chip appears with no button and
          // says which of the two it was, and the bot is told on its next turn
          // in this thread (questions.reviseRefusedBlock).
          const rev = questions.parseCardRevision(ev.msg.text);
          const hit = rev ? null : questions.parseQuestionSuggestion(ev.msg.text);
          if (rev) {
            const vault = questions.readVault();
            const card = questions.findCard(vault, rev.id);
            const fault = !card ? 'unknown'
              : (card.source || {}).page_key !== store.pageKey(page.url) ? 'elsewhere'
                : (rev.ok ? '' : 'unparsed');
            ev.msg = {
              ...ev.msg,
              text: String(ev.msg.text).split(rev.block).join('').replace(/\n{3,}/g, '\n\n').trim(),
              question: fault
                ? { revises: rev.id, rejected: fault, ...(rev.error ? { why: rev.error } : {}) }
                : { revises: rev.id, why: rev.card.question, card: rev.card },
            };
          } else if (hit) {
            ev.msg = {
              ...ev.msg,
              text: String(ev.msg.text).split(/\r?\n/)
                .filter(l => l !== hit.line).join('\n').trimEnd(),
              question: { why: hit.why },
            };
          }
        }
      }
      // …and, on a page of the reader's own site, did the bot PROPOSE a change
      // to the markdown? Fourth use of the idiom, and the first that is a
      // stack: a typo sweep is ten small proposals and they are all meant, so
      // every ```suggest block in the reply is lifted (suggest.liftSuggestions),
      // the blocks come off the words because they are machinery, and each
      // becomes a card the reader accepts or refuses.
      //
      // The gate is the page's KIND (blog.suggestMode), never the message: a
      // reply on a PDF or a project artifact carries no cards however it is
      // written, because the accept path has nowhere to write and the
      // convention was never taught there. Page chat counts — "spell-check the
      // whole page" is asked there and its answer is a stack of cards.
      if (ev.msg && ev.msg.kind !== 'tools') {
        const bg = blogOf(page.url);
        if (bg && bg.confirmed && bg.source_path && bg.suggest_mode) {
          const lifted = suggest.liftSuggestions(ev.msg.text);
          if (lifted.cards.length) {
            ev.msg = { ...ev.msg, text: lifted.text, suggestions: lifted.cards };
          }
        }
      }
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
  // A card job came back (chat.mjs). Its words are a fenced block and are
  // never appended to anything: they fill in the pending row in the vault, or
  // — when the block will not parse — mark that row FAILED with the reason on
  // it. A malformed reply can therefore cost one visible bad row and can never
  // corrupt the vault, which is the whole of the parsing contract.
  if (ev.type === 'card') {
    const vault = questions.readVault();
    const card = ev.error
      ? questions.failCard(vault, ev.card_id, ev.error)
      : questions.settle(vault, ev.card_id, ev.msg && ev.msg.text, ev.msg && ev.msg.author);
    if (card) {
      questions.saveVault(vault);
      broadcast({ type: 'question', url: ev.url, card_id: card.id, state: card.state,
        ...(card.error ? { error: card.error } : {}) });
    }
    return;
  }
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

// ---- the question vault ---------------------------------------------------
//
// "This is interesting — make a question of it." One click, and a card is
// written by a bot and filed in the vault (questions.mjs) to be asked back
// weeks later. The reader's ONLY decision is which passage: not the format,
// not the difficulty, not when it comes back. That is the whole product
// argument for this feature, and it is why there is no editor, no review
// queue and no settings anywhere in this path.
//
// The turn is `summarizeThread`'s twin in every structural respect — queued
// like any other turn on the page's own lane, silent, its answer landing in a
// RECORD rather than in the thread — with one difference: the row exists
// BEFORE the turn is queued. A generation that never comes back is then a
// pending card the reader can see and delete, rather than a click that did
// nothing.
function makeCard(page, { thread, quote, page_number, from_msg, hint, model }) {
  const text = String(quote || (thread && thread.quote) || '').trim();
  if (!text) return { ok: false, error: 'a question needs a passage to be about' };
  const agent = String(model || '').toLowerCase() === 'codex' ? 'codex' : 'claude';
  const vault = questions.readVault();
  const card = questions.addPending(vault, {
    model: agent,
    source: {
      url: page.url, page_key: store.pageKey(page.url), title: store.displayTitle(page),
      site: page.site || '', quote: text,
      thread_id: (thread && thread.id) || null,
      page: Number(page_number || (thread && thread.page) || 0) || 0,
      // provenance, for the quiz's filter chips — one bank, looked at from
      // angles (questions.facets)
      projects: store.projectsOf(page).map(p => p.id),
      tags: store.tagsOf(page),
      from_msg: from_msg || '',
      hint: hint || '',
    },
  });
  questions.saveVault(vault);
  const done = st => {
    broadcast({ type: 'question', url: page.url, card_id: card.id, state: st.state,
      ...(st.error ? { error: st.error } : {}) });
    return card;
  };
  if (NO_AGENTS || !chat) {
    const v = questions.readVault();
    const failed = questions.failCard(v, card.id, AGENTS_OFF_REASON);
    questions.saveVault(v);
    return { ok: true, card: failed || card, queued: false, reason: AGENTS_OFF_REASON };
  }
  const c = chatFor(page.url);
  if (!c) {
    const v = questions.readVault();
    const failed = questions.failCard(v, card.id, UNCONFIRMED_REASON);
    questions.saveVault(v);
    return { ok: true, card: failed || card, queued: false, reason: UNCONFIRMED_REASON };
  }
  const { position } = c.submit({
    url: page.url, target: (thread && thread.id) || store.PAGE_CHAT, title: page.title,
    // the whole of the routing, exactly as a summary job does it: `text` is
    // read for its @-mention and by nothing else, because a card job builds
    // its own envelope (chat.mjs cardPrompt)
    text: `@${agent} `,
    card: true,
    card_id: card.id,
    cardHint: hint || '',
    quote: text,
    pageNumber: Number(page_number || (thread && thread.page) || 0) || 0,
    // the conversation, where there was one: a card written off a thread that
    // argued its way to the point is a better card than one written off the
    // sentence alone, and this is where the reader's own confusion is on record
    history: (thread && thread.msgs) || [],
  });
  done({ state: 'pending' });
  return { ok: true, card, queued: true, position };
}

// ---- one sitting at the quiz ---------------------------------------------
//
// The ORDER of a sitting, and the one thing the schedule on disk cannot
// express: a card answered wrong must come back BEFORE the reader stands up.
// SM-2 makes it due this instant, which is necessary and not sufficient —
// without a session the reader would have to start another one to meet it.
//
// Memory only, and deliberately. Every consequence of an answer (the interval,
// the ease, the lapse count) is written to the vault the moment it is given, so
// a restart costs the ORDER of the sitting in progress and nothing else: the
// next GET simply starts a new one over the same due cards.
const quizzes = new Map();          // who → session
const QUIZ_TTL_MS = 6 * 60 * 60 * 1000;
const scopeKey = s => `${s.project || ''} ${s.tag || ''}`;
const quizWho = req => (hosted.identity(req).handle || 'owner');
function quizSession(req) {
  const who = quizWho(req);
  const s = quizzes.get(who);
  if (!s) return null;
  if (Date.now() - s.at > QUIZ_TTL_MS) { quizzes.delete(who); return null; }
  return s;
}
// ---- memorizer.botference.com: the vault, at an address of its own -------
//
// One companion, two doors. The reading room is discuss.botference.com and
// stays there; the quiz is a PRODUCT — a thing opened on a phone at the end of
// a day, with nothing else on it — and a product wants a home page, not a path
// inside somebody else's site. So the same tunnel carries a second hostname to
// this same process (lib/plugin.sh's ingress list, exactly as the legacy
// plugin.botference.com door is carried) and on THAT hostname `/` is the quiz.
//
// Nothing about auth changes, which is the point of doing it this way: the
// gate, the owner-only checks and the hub's device cookie (scoped to the
// PARENT domain, so an approved phone arrives already the owner) know nothing
// about hostnames and are not asked to learn.
const MEMORY_HOSTS = new Set(String(process.env.PLUGIN_MEMORY_HOSTNAME ?? 'memorizer.botference.com')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
const hostOf = req => String((req && req.headers && req.headers.host) || '').split(':')[0].toLowerCase();
export const isMemoryHost = req => MEMORY_HOSTS.has(hostOf(req));
// What is served on the vault's hostname, and nothing else is. Everything here
// is either the quiz, the session (so the sign-in the reading room uses works
// unchanged on this host too) or an answer a script asks for.
const MEMORY_PATHS = new Set(['/quiz', '/quiz-answer', '/quiz-flag', '/quiz-delete', '/quiz-keep',
  '/questions', '/question', '/auth', '/signout', '/whoami', '/health']);
// The reading room's origin AS SEEN FROM the vault's hostname — empty (and so
// every link relative) everywhere else. A card's source lives in the reading
// room, which is a different address from here, so those links have to be
// absolute; the sibling label on the same domain is the answer, and is
// overridable for anyone whose two doors are named differently.
export function readingRoomOrigin(req) {
  if (!isMemoryHost(req)) return '';
  const here = hostOf(req);
  const sib = String(process.env.PLUGIN_READING_HOSTNAME || here.replace(/^[^.]+\./, 'discuss.'));
  return (sib && sib !== here) ? `https://${sib}` : '';
}

// THE QUIET WAY BACK from a card to what made it, resolved against the live
// store at the moment the page is drawn — three states and no fourth:
//   · the discussion that produced the card, if that thread is still there;
//   · the page, plain, if the thread is gone but the record is not;
//   · nothing at all, if the page itself has gone.
// A card's `thread_id` is a soft link by design (the same design `from_thread`
// has on a strikeout): the reader deletes threads, and a dangling id must read
// as "this question stands alone", never as a broken link.
function traceOf(card, home = '') {
  const s = (card && card.source) || {};
  const key = String(s.page_key || '');
  if (!key) return null;
  const page = store.readPageByKey(key);
  if (!page) return null;
  const thread = s.thread_id ? store.findThread(page, s.thread_id) : null;
  const title = store.displayTitle(page);
  return thread
    ? { href: `${home}/p/${key}#${thread.id}`, thread: true, title }
    : { href: `${home}${store.hasSnapshot(key) ? '/a/' : '/p/'}${key}`, thread: false, title };
}

// THE DUPLICATE HINT, attached to a card on its way out. A hint and not a
// verdict: the pair, why they look alike, and nothing else — every decision
// about it belongs to the reader, who is the only one who can tell two similar
// questions about one passage from one question asked twice.
function withDuplicate(vault, card) {
  const dup = questions.duplicateOf(vault, card);
  if (!dup) return card;
  return { ...card, dup: { id: dup.card.id, question: dup.card.question, why: dup.why } };
}

// where a quiz form post lands afterwards. Deliberately NOT `backTo` — that
// one's allowlist is `/p/<key>` and widening it would widen an anti-open-
// redirect guard for a page that needs no redirect from anywhere else.
function quizBack(data, reveal, gone) {
  const q = new URLSearchParams();
  if (data.project) q.set('project', String(data.project).slice(0, 80));
  if (data.tag) q.set('tag', String(data.tag).slice(0, 80));
  if (reveal) q.set('reveal', '1');
  // what happened to the card the reader just took out of the rotation. It is
  // one word on the next page, and it is not optional: parking a card and
  // discarding it are different acts with different consequences, and a click
  // that answers with a blank next question tells the reader neither.
  if (gone) q.set('gone', gone);
  const s = q.toString();
  return `/quiz${s ? `?${s}` : ''}`;
}

// May this thread offer to make a question of itself? Any page — a question is
// about an IDEA, and ideas are not a PDF feature — but not a thread the reader
// has already filed, and not page chat (which sits on no passage, so a card
// made from it would have no source to link back to).
const questionable = (page, thread) => !!thread && !thread.resolved;

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

// WHO THIS MESSAGE IS FOR — the whole of it, in one place, in precedence order.
//
//   1. an @-mention in the words          the sentence the reader just wrote
//   2. the composer pill on the wire      what they clicked instead of typing
//   3. the thread's sticky address        who they were already talking to
//   4. nobody                             a note, exactly as Discuss began
//
// A tag beats a pill because the tag is in the message and the pill is beside
// it: if the two disagree the reader changed their mind mid-sentence, and the
// sentence is the later word. The pill beats the sticky address for the same
// reason — it is a choice made for THIS message — and `none` is a real choice,
// not an absent one, which is how a reader steps out of a conversation and
// writes a plain note under a passage they had been discussing.
//
// COMMENT THREADS ONLY. Page chat is untouched by any of this: its untagged
// rule is the one `untaggedGoesToAll` states (the room on a project artifact,
// nobody anywhere else) and a sticky address there would quietly rewrite it.
const PILL_ROUTE = { claude: '@claude ', codex: '@codex ', all: '@all ', none: '' };
function addressOf(target, text, pill, msgs) {
  if (target === store.PAGE_CHAT) return '';
  const tagged = routePrefix(text);
  if (tagged) return tagged;
  const p = String(pill || '').trim().toLowerCase().replace(/^@/, '');
  if (p && Object.prototype.hasOwnProperty.call(PILL_ROUTE, p)) return PILL_ROUTE[p];
  return stickyRoute(msgs);
}

// an @-mention in any message — first comment or tenth reply — summons the
// bots, and so does a thread's sticky address or a composer pill (addressOf),
// and so does a project artifact's page chat (untaggedGoesToAll)
// `extras.forceAll` is the send-review turn saying "this one is the room's,
// whatever the text looks like": its body quotes the reader's own margin
// comments, and an "@claude" typed at one thread weeks ago is not the address
// of a review of the whole draft. Nothing else sets it, and it is stripped
// out here rather than travelling on as a job field.
// ---- who may be struck through, and where ---------------------------------
//
// A strikeout is a PDF markup. It exists because the file can carry one — an
// /StrikeOut annotation every viewer on earth already draws — and on an ordinary
// web page there is nothing to write it into and nothing to hand anybody. The
// EXTENSION says the same thing from its own side (the adapter's `strike`
// capability, which is what puts the second tool on the selection pill); this is
// the server's own honest twin of that answer, because a door must never take a
// client's word for what it is allowed to do. `store.kindOf` is the record's
// own account of what the page is: what the adapter declared on the last visit,
// or what the url says for a record written before adapters declared anything.
//
// Beyond the document: a thread ALREADY struck has nothing to convert, and a
// RESOLVED thread is an argument that is over — the reader filed it, the summary
// is written, and re-marking the passage under it would reopen a decision by
// changing the document instead of the conversation. Reopen it first.
const strikeable = (page, thread) => !!thread
  && store.kindOf(page) === 'pdf'
  && store.markOf(thread) !== 'strike'
  && !thread.resolved;

// A MINTED STRIKE IS INERT, and this is where that is enforced: `markOf(thread)
// === 'strike'` above means the offer never rides a turn in the card the
// discussion produced, the lift therefore never fires there, and no chip can
// ever appear on it. The reader deletes the discussion precisely so that no bot
// chatter travels to the co-author; letting the machinery run on the one thread
// that must stay clean would put it straight back. Corrections come from the
// discussion, through /strike-from, which rewrites the note in place.

// The last suggestion in this thread, if it was refused at the lift and nothing
// has been suggested since. Only the LAST one: a bot that was refused, wrote a
// good line afterwards and had it taken does not want to be lectured about the
// first attempt for the rest of the thread.
// A reply may now carry several, so the answer is about the LAST REPLY that
// suggested anything: if every suggestion in it was taken as an offer, nothing
// is said; if any was refused, the first refusal in it is the one named, because
// telling a bot three things at once about three lines is how a turn stops being
// read at all.
function refusedStrikeNote(thread) {
  for (let i = ((thread && thread.msgs) || []).length - 1; i >= 0; i--) {
    const list = store.strikesOf(thread.msgs[i]);
    if (!list.length) continue;
    const bad = list.find(s => s.rejected);
    return bad ? store.strikeRefusedBlock(bad.rejected, bad.phrase || '') : '';
  }
  return '';
}

// What this discussion has put in the vault, for the offer block to list, and
// the refusal for a `revises:` that pointed nowhere. Both read the LIVE record
// (the vault, and the last question suggestion in the thread) at envelope time,
// exactly as the strike pair does.
const mintedHere = (page, thread) => (thread
  ? questions.mintedIn(questions.readVault(), thread.id, store.pageKey(page.url))
  : []);
// What became of the LAST stack of suggestions in this conversation — the
// third use of the pattern refusedStrikeNote and refusedRevision are, written
// the same way and for the same reason. Only the last message that carried
// cards is looked at: a bot whose next stack was taken whole should not be
// read the verdicts of three turns ago for the rest of the thread, and the
// cards themselves are the record if anyone wants the history.
//
// It reads the LIVE record at envelope time, so a card accepted a second ago —
// after the reply was written, which is when every acceptance happens — is
// reported with the state it has now.
function suggestVerdict(page, target) {
  const msgs = store.msgsOf(page, target) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const cards = msgs[i] && msgs[i].suggestions;
    if (!Array.isArray(cards) || !cards.length) continue;
    return suggest.verdictBlock(cards);
  }
  return '';
}

function refusedRevision(page, thread) {
  for (let i = ((thread && thread.msgs) || []).length - 1; i >= 0; i--) {
    const q = thread.msgs[i] && thread.msgs[i].question;
    if (!q) continue;
    // the LAST suggestion only: a bot that has since got it right is not
    // lectured about the attempt before it
    return q.rejected
      ? questions.reviseRefusedBlock(q.rejected, q.revises || '', mintedHere(page, thread))
      : '';
  }
  return '';
}

function summon(page, target, text, extras = {}, me = { owner: true }) {
  const { forceAll, ...rest } = extras;
  extras = rest;
  const untaggedAll = !!forceAll || untaggedGoesToAll(page, target, text);
  // the thread's own address, resolved by the caller and carried through
  // `extras` into the job, where chat.routeOf turns it into the envelope's
  // prefix for a message that never typed one
  const routeHint = String(extras.routeHint || '');
  if (!hasMention(text) && !untaggedAll && !routeHint) return {};
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
    // …or a blog page whose repo has not been vouched for, which is the same
    // refusal about a different folder and must say which one
    const isBlog = !artifactOf(page.url);
    const error = isBlog ? BLOG_UNCONFIRMED_ERROR : UNCONFIRMED_ERROR;
    broadcast({ type: 'chat', url: page.url, target, kind: 'error', error });
    return { queued: false, reason: isBlog ? BLOG_UNCONFIRMED_REASON : UNCONFIRMED_REASON };
  }
  const thread = target === store.PAGE_CHAT ? null : store.findThread(page, target);
  // ── the council projects this page is filed under ────────────────────
  // Two mutually exclusive blocks, computed once per turn here because this
  // is the one funnel every bot turn on a page goes through.
  //
  // FILED: a digest of what those projects already know (chat titles, the
  // tail of the two most recent conversations, TASKS.md, the file list),
  // capped at workspace.DIGEST_TOTAL_CHARS. This is why the feature exists:
  // the second draft of a manuscript arrives knowing what was said about the
  // first. It does NOT move the page's lane or open a write scope — see
  // store.filePageInProject.
  //
  // UNFILED: the roster, so a bot can SUGGEST where the page belongs. Never
  // on a project artifact page (it is already in a project, by definition of
  // where it lives) and never on a library turn.
  const attached = store.projectsOf(page);
  const filedContext = attached.length ? workspace.attachedContext(attached) : '';
  const suggestContext = (!attached.length && !artifactOf(page.url))
    ? workspace.suggestBlock(workspace.projectRoster({ peek: false })) : '';
  // ── the draft behind this page ────────────────────────────────────────
  // A page of the reader's own site, served locally, whose markdown source
  // this companion has resolved (blog.mjs). Composed on the same funnel as
  // everything else here, and for the same reason: the server is what knows.
  // It rides EVERY turn on that page, like the project write rule and for the
  // same reason — a resumed session's replayed history is uneven, and the only
  // thing a turn can rely on carrying is the turn.
  const bg = blogOf(page.url);
  // …and, on a page whose kind proposes rather than edits (blog.suggestMode —
  // every blog root there is), the convention for writing a proposal, plus
  // what the reader did with the last stack. Composed here on the same funnel
  // and for the same three reasons the strike offer and the question offer
  // are: the server holds the record, a model never shown the convention
  // cannot use it, and a bot told nothing about its last suggestions assumes
  // they landed and says so.
  const blogContext = (bg && bg.confirmed && bg.source_path)
    ? blog.blogBlock(bg)
      + (bg.suggest_mode ? suggest.suggestBlock() + suggestVerdict(page, target) : '')
    : '';
  // ── may this thread be struck through? ────────────────────────────────
  // The offer a bot needs before it can suggest a deletion (store.mjs
  // strikeOfferBlock). Composed here, once, on the same funnel and for the same
  // reason the roster is: the server holds the page record, and the answer is a
  // fact about the DOCUMENT (only a PDF carries an /StrikeOut) and about THIS
  // thread (one already struck has nothing to suggest, and one already filed is
  // an argument that is over). A model that is never shown this block has no
  // way of learning the convention, which is the point.
  //
  // …plus, where the last suggestion in this thread was THROWN AWAY at the lift
  // (a note that pointed back at the conversation, or one too long to file
  // without cutting), the sentence saying so. A model that is not told simply
  // sees its line vanish and tells the reader the deletion was made — which is
  // exactly what happened on the session this came from.
  const strikeContext = strikeable(page, thread)
    ? store.strikeOfferBlock() + refusedStrikeNote(thread)
    : '';
  // ── and may this thread offer to be remembered? ───────────────────────
  // The bot's own trigger for the question vault. Composed on the same funnel
  // and for the same reason as the two above: the server holds the record, and
  // a model never shown the convention cannot use it. Unlike the strike offer
  // this is not a PDF affair — a gap in understanding is not a property of the
  // file format — so every page's thread turn carries it.
  //
  // …carrying what this discussion has ALREADY filed, so that a bot asked to
  // reword a question can name the card instead of writing a second one — and,
  // where the last block it wrote was refused at the lift, the sentence saying
  // so. A model with no news assumes the correction landed and tells the
  // reader it did, which is the failure this pair of blocks exists to prevent.
  const questionContext = questionable(page, thread)
    ? questions.questionOfferBlock(mintedHere(page, thread)) + refusedRevision(page, thread)
    : '';
  // ── what ELSE is marked up on this passage? ───────────────────────────
  // The other threads whose quotes sit on or beside this one — the two
  // strikeouts already in the sentence this comment is about. Composed here for
  // the third time on the same funnel and for the same reason: the server holds
  // the page record AND the snapshot, and neither the thread nor the bot can
  // see past its own quote. Without it a bot answering the third mark in a
  // sentence rewrites the whole sentence, because the whole sentence is the
  // only thing it was ever shown (store.nearbyMarksBlock).
  //
  // PDFs only, like the strike offer: an /StrikeOut is what makes a neighbour a
  // decision rather than a conversation, and only a PDF carries one. The
  // snapshot is read per turn (one file, once) and only the thread's own page
  // of it is measured in.
  const nearbyContext = (thread && store.kindOf(page) === 'pdf')
    ? store.nearbyMarksBlock(page, thread,
      store.snapshotPageText(store.readSnapshot(store.pageKey(page.url)), thread.page))
    : '';
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
    // …and whether that highlight is a strikethrough — the reader's red line
    // through the passage, a suggested deletion. Context for the turn, never
    // a request (chat.mjs `struck`). Absent on every ordinary highlight, so
    // an article's turn is byte-for-byte the one it always was.
    mark: store.markOf(thread) === 'strike' ? 'strike' : '',
    history: priorMsgs(page, target),
    ...(filedContext ? { filedContext } : {}),
    ...(suggestContext ? { suggestContext } : {}),
    ...(blogContext ? { blogContext } : {}),
    ...(strikeContext ? { strikeContext } : {}),
    ...(questionContext ? { questionContext } : {}),
    ...(nearbyContext ? { nearbyContext } : {}),
    ...extras,
  });
  // `wait` is what the drawer says while it waits: bridge_starting (the agents
  // are being woken), busy (this page's own previous turn still has the floor —
  // a lane is serial by design) or pool_busy (every child is on somebody else's
  // lane). Absent = the turn is already running and turn-start is about to say
  // so.
  return { queued: true, position, ...(wait ? { wait } : {}) };
}

// A .docx may ride along with any mention (the reader is annotating a doc and
// wants the bots to see what everyone else already said in its margins). It is
// read for this turn only: the digest goes in the envelope and nowhere else.
// Returns null when the request has already been refused.
function docxDigestOf(res, data, text, route = '') {
  if (!data.docx_b64) return '';
  const buf = Buffer.from(String(data.docx_b64), 'base64');
  if (buf.length > DOCX_MAX) { fail(res, 413, 'document too large — 8MB max'); return null; }
  // a message that summons nobody has nobody to hand the margins to — and a
  // sticky-addressed message summons somebody without saying so in its words
  return (hasMention(text) || route) ? commentsDigest(buf) : '';
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

// --- answering a suggestion card -------------------------------------------
//
// The three /suggest-* routes all begin the same way: the page, the message
// carrying the stack, and the blog record that says which file the cards are
// about. Resolved once here so that all three refuse the same things in the
// same words — and so that the SOURCE OF TRUTH for "which file may this write"
// is the companion's own mapping (blog.blogPageFor) rather than anything the
// request body says. A card never carries a path, and no request can name one:
// the reader accepting a proposal on this page can only ever change the file
// this page renders from.
function suggestTargetOf(res, data) {
  const page = pageOf(res, data);
  if (!page) return null;
  const target = data.thread_id || store.PAGE_CHAT;
  const msgs = store.msgsOf(page, target);
  if (!msgs) { fail(res, 404, 'unknown thread'); return null; }
  const found = store.resolveMsg(msgs, pick(data));
  if (!found) { fail(res, 404, 'unknown message'); return null; }
  const bg = blogOf(page.url);
  if (!bg || !bg.confirmed || !bg.source_path) {
    fail(res, 409, 'this page has no confirmed markdown source to change');
    return null;
  }
  if (!bg.suggest_mode) { fail(res, 409, 'this page is not in suggest mode'); return null; }
  return { page, target, msg: found.msg, bg };
}

// The loop the turn-end census closes, closed for an ACCEPT instead.
//
// An accepted card writes the source file outside any turn — no bridge ran, so
// no turn-end fires — and the tab would otherwise sit on the old rendering
// forever. So the same census is taken around the write and the same
// `blog-files` event is broadcast, which content.js already knows how to
// answer: `page_changed` true → reload, and the reader watches their post come
// back with the change in it. Track changes on the page then comes free,
// because the file really did move.
//
// `collateral` is deliberately absent from this payload: nothing here was
// discovered by a diff. The change is the card the reader just pressed.
function announceBlogWrite(url, bg, before) {
  const changed = workspace.diffScans(before, blog.scanSite(bg.root));
  if (!changed.length) return;
  const own = path.relative(bg.root, bg.source_path).split(path.sep).join('/');
  const payload = {
    type: 'blog-files',
    url,
    root: bg.root,
    serve_origin: bg.serve_origin,
    source: own,
    count: changed.length,
    page_changed: changed.includes(own),
    assets_changed: false,
    accepted: true,          // this one is the reader's own press, not a turn's edit
    files: changed.slice(0, workspace.CHANGED_LIST_MAX),
    at: new Date().toISOString(),
  };
  lastChanges.set(url, payload);
  if (lastChanges.size > CHANGES_KEEP) lastChanges.delete(lastChanges.keys().next().value);
  broadcast(payload);
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
  let url = req.url.split('?')[0];
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

  // --- the vault's own hostname ------------------------------------------
  // On memory.botference.com the quiz IS the site: `/` is the page itself
  // rather than a redirect to somebody else's index, and everything that is
  // not the quiz or the session goes home rather than serving the reading
  // room at a second address (two homes for one archive is the confusion this
  // whole split exists to avoid). AFTER the gate, so the vault's new door is
  // exactly as shut as the old one.
  if (isMemoryHost(req)) {
    if (url === '/' && (req.method === 'GET' || req.method === 'HEAD')) url = '/quiz';
    else if (!MEMORY_PATHS.has(url)) {
      if (req.method === 'GET' || req.method === 'HEAD') return res.writeHead(302, { location: '/' }).end();
      return fail(res, 404, 'not found');
    }
  }

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
      kind: q.get('kind') || '', tag: q.get('tag') || '',
      // how many questions are waiting, for the owner's own link to the quiz
      due: hosted.isOwner(req) ? questions.counts(questions.readVault()).due : 0 });
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  }
  if (req.method === 'GET' && url.startsWith('/p/')) {
    const key = url.slice(3);
    const page = store.readPageByKey(key);
    if (!page) return fail(res, 404, 'unknown page');
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const notice = q.get('notice') || '';
    const html = pageView({
      page, key, me: hosted.identity(req), notice, snapshot: store.hasSnapshot(key),
      // whose threads to show — the reading room has no client state, so a
      // margin narrowed to one commenter is a LINK, exactly as a filtered
      // archive is
      by: q.get('by') || '',
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
      // …and, since turns run several at a time, WHOSE. A single number could
      // answer "is the companion idle?" and never "is MY page's turn the one
      // running or the one waiting?" — which is the question a reader about to
      // restart the companion is actually asking. One row per page with
      // anything in flight or queued, newest state, control turns folded out
      // (they belong to no page).
      queues: chat ? queueRows() : [],
      bridges: NO_AGENTS ? null
        : { live: chat.size(), max: chat.cap(), workspace: workspaceChats.size, blog: blogChats.size },
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
        // projects/<id>/TASKS.md: the project's own standing list, parsed
        // here so the drawer never parses markdown for it. Omitted when the
        // project keeps none — a missing key, not an empty section. Only on
        // a CONFIRMED root: an unconfirmed one is a folder the reader has
        // not yet said belongs to them, and reading its files into the
        // drawer would answer that question for them.
        ...(art.confirmed
          ? (t => (t.length ? { tasks: t } : {}))(
              workspace.projectTasks(art.root, art.project_id))
          : {}),
      },
    });
  }
  // --- filing an ordinary page under council projects -------------------
  //
  // The picker's roster, and the act of filing. Owner-only for the same
  // reason /project-page is: the answer names this reader's projects and the
  // absolute paths of their council, which is nobody's business over a
  // tunnel.
  //
  // GET /projects?url= — every project in every CONFIRMED council root, with
  // a peek (recent chat titles, top-level file names) so the reader can tell
  // two similarly-named projects apart without opening either. `filed` names
  // the ones this page is already attached to, so the picker draws ticks
  // rather than having to ask a second question.
  if (req.method === 'GET' && url === '/projects') {
    if (notOwner(req, res)) return;
    const u = queryUrl(req.url);
    const page = u ? store.readPage(u) : null;
    return ok(res, {
      projects: workspace.projectRoster(),
      filed: page ? store.projectsOf(page) : [],
    });
  }
  // POST /page-projects {url, root, id, attach} — attach or detach one
  // project. Attaching is a READ: it changes what the envelope carries and
  // nothing else. The page keeps its lane, its bridge and its (absent) write
  // scope, so nothing here can strand a session on a child that still holds
  // it (SPEC, "a lane never moves off a live child").
  if (req.method === 'POST' && url === '/page-projects') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const target = String(data.url || '');
      const page = target ? store.readPage(target) : null;
      if (!page) return fail(res, 404, 'no such page');
      const root = workspace.realish(String(data.root || ''));
      const id = String(data.id || '');
      const attach = data.attach !== false;
      // A root the reader has not vouched for is not somewhere anything gets
      // filed — the same rule that decides whether an artifact gets a bridge.
      if (attach && (workspace.rootState(root) !== 'yes'
        || !workspace.listProjects(root).some(p => p.id === id))) {
        return fail(res, 400, 'no such project in a confirmed council');
      }
      const saved = store.filePageInProject(page.url, { root, id, attach });
      broadcast({ type: 'page', url: saved.url });
      return ok(res, { url: saved.url, filed: store.projectsOf(saved) });
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
  // --- blog source pages -------------------------------------------------
  // The reader's own site, served locally by `jekyll serve`, and the markdown
  // it was rendered from. Owner-only, all of it: the answers are absolute
  // paths on this machine, the contents of this reader's drafts folder, and —
  // at the end — a git push. None of that is a guest's business, and a tunnel
  // is exactly where it must not be.
  //
  // GET /blog-page?url= — is this url a page of a registered local site, which
  // source file is it from, and has the repo been confirmed? `null` for every
  // other address in the world, which is nearly all of them.
  if (req.method === 'GET' && url === '/blog-page') {
    if (notOwner(req, res)) return;
    const u = queryUrl(req.url);
    const bg = u ? blogOf(store.normUrl(u)) : null;
    if (!bg) return ok(res, { blog: null });
    return ok(res, { blog: bg });
  }
  // GET /blog-sites — every site the owner has declared, and whether each
  // repo has been vouched for. What the drawer's registration card lists.
  if (req.method === 'GET' && url === '/blog-sites') {
    if (notOwner(req, res)) return;
    return ok(res, {
      sites: blog.listSites().map(s => ({ ...s, state: blog.rootState(s.root) })),
    });
  }
  // POST /blog-site {serve_origin, root, kind} — declare one. `{remove:true}`
  // undeclares it. THE OWNER'S ACT, never a bot's and never a page's: this is
  // the sentence "the site at this address is built from this folder of mine",
  // and nothing else in the companion is in a position to say it. Declaring is
  // not confirming — the repo still has to be vouched for (POST /blog-root)
  // before a write-enabled child is spawned against it.
  if (req.method === 'POST' && url === '/blog-site') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      if (data.remove) {
        const gone = blog.removeSite(String(data.serve_origin || ''));
        if (!gone.ok) return fail(res, 400, gone.error);
        forgetBlogPages();
        broadcast({ type: 'blog-sites' });
        return ok(res, { sites: gone.sites });
      }
      const added = blog.addSite({
        serve_origin: String(data.serve_origin || ''),
        root: String(data.root || ''),
        kind: String(data.kind || 'jekyll'),
      });
      if (!added.ok) return fail(res, 400, added.error);
      forgetBlogPages();
      broadcast({ type: 'blog-sites' });
      return ok(res, { site: added.site, state: blog.rootState(added.site.root) });
    });
  }
  // POST /blog-root {root, confirm} — the one-time answer to "may the bots
  // edit this repo?". Kept in the plugin's own config.json, asked once per
  // repo, and a NO is kept as firmly as a YES. Exactly the council-root
  // contract, because exactly the same thing hangs off it: a bridge child
  // spawned with that directory writable.
  if (req.method === 'POST' && url === '/blog-root') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const root = blog.realish(String(data.root || ''));
      if (!root || !blog.listSites().some(s => s.root === root)) {
        return fail(res, 400, 'that folder is not a declared blog site');
      }
      const state = blog.setRootState(root, !!data.confirm);
      forgetBlogPages();
      // every tab on a page of this site has to stop asking, or start working
      broadcast({ type: 'blog-root', root, state });
      return ok(res, { root, state });
    });
  }
  // --- suggestion cards on a blog page -----------------------------------
  // The reader's answer to a proposal. Owner-only, all three, for the same
  // reason every route above is: the act at the end of them is a WRITE into a
  // folder on this machine that only the owner has vouched for, and a tunnel
  // is exactly where that must not be reachable.
  //
  // POST /suggest-accept {url, thread_id, ts, author, id} — accept one card.
  // The span is replaced in the markdown source (suggest.applyCard, which is
  // frontends/review's unique-span rule imported whole), jekyll rebuilds, and
  // the tab is told to reload the way a turn's own edit tells it. A span that
  // has drifted or occurs more than once is REFUSED: the card goes to
  // needs-manual with the reason on it and the file is not touched. Nothing
  // here ever guesses at a span.
  if (req.method === 'POST' && url === '/suggest-accept') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const at = suggestTargetOf(res, data);
      if (!at) return;
      const { page, bg, msg } = at;
      const card = store.findCardIn(msg, data.id);
      if (!card) return fail(res, 404, 'unknown suggestion');
      if (card.state !== 'open') return fail(res, 409, `that suggestion is already ${card.state}`);
      const before = blog.scanSite(bg.root);
      const r = suggest.applyCard(bg.source_path, card);
      if (!r.ok) {
        store.setCardState(card, 'needs-manual', { reason: r.reason, detail: r.detail });
        store.savePage(page);
        broadcast({ type: 'page', url: page.url });
        noteDecisions(page);
        // 200, not an error: the request was answered, and the answer is on
        // the card. A 4xx would leave the drawer showing a failed fetch and
        // the reader with no idea the card had changed state.
        return ok(res, { card, applied: false });
      }
      store.setCardState(card, 'applied');
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      noteDecisions(page);
      announceBlogWrite(page.url, bg, before);
      return ok(res, { card, applied: true });
    });
  }
  // POST /suggest-reject {…, id} — turn one down. The file is not touched (it
  // never was), the card keeps the refusal so the reader can see what they
  // said no to, and the bot is told on its next turn in this conversation
  // (suggest.verdictBlock) rather than being left to assume it landed.
  if (req.method === 'POST' && url === '/suggest-reject') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const at = suggestTargetOf(res, data);
      if (!at) return;
      const card = store.findCardIn(at.msg, data.id);
      if (!card) return fail(res, 404, 'unknown suggestion');
      if (card.state === 'applied') return fail(res, 409, 'that suggestion has already been applied');
      store.setCardState(card, 'rejected');
      store.savePage(at.page);
      broadcast({ type: 'page', url: at.page.url });
      noteDecisions(at.page);
      return ok(res, { card });
    });
  }
  // POST /suggest-accept-all {url, thread_id, ts, author} — a sweep's whole
  // stack, in document order, stopping LOUDLY at the first card that cannot be
  // placed (suggest.applyStack says why at length). The answer names what
  // landed, what stopped it and what was left untouched, and every card's own
  // state says the same thing where the reader is looking.
  if (req.method === 'POST' && url === '/suggest-accept-all') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const at = suggestTargetOf(res, data);
      if (!at) return;
      const { page, bg, msg } = at;
      const open = (msg.suggestions || []).filter(c => c.state === 'open');
      if (!open.length) return fail(res, 409, 'there is nothing left to accept here');
      const before = blog.scanSite(bg.root);
      const out = suggest.applyStack(bg.source_path, open);
      for (const id of out.applied) store.setCardState(store.findCardIn(msg, id), 'applied');
      if (out.stopped) {
        store.setCardState(store.findCardIn(msg, out.stopped.id), 'needs-manual',
          { reason: out.stopped.reason, detail: out.stopped.detail });
      }
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      // the debounce earns its keep here: one click, a stack of cards, ONE log
      noteDecisions(page);
      if (out.applied.length) announceBlogWrite(page.url, bg, before);
      return ok(res, {
        applied: out.applied.length,
        left: out.left.length,
        stopped: out.stopped ? { id: out.stopped.id, detail: out.stopped.detail } : null,
        cards: msg.suggestions,
      });
    });
  }
  // …and there is NO publish route here, deliberately. The reader's website
  // repository is theirs: nothing in this companion stages, commits, pushes,
  // branches or tags anything in a blog root, and the blog child is spawned
  // with git and gh denied outright (blog.deniedCommands). They put the site
  // live by their own hand, by their own route. See SPEC, "the site’s
  // repository is the reader’s alone", and blog.mjs’s header for why this is a
  // property of the KIND held in code rather than a setting that could travel.
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
  // The review round in flight on this page, if there is one. The broadcast is
  // the live channel; this is what a tab that opened (or refreshed, or was
  // asleep) mid-round asks so the strip is already right on its first paint
  // instead of appearing at the next turn boundary. Same owner gate as the rest
  // of the round machinery — a round is the owner's agents being spent.
  if (req.method === 'GET' && url === '/round') {
    if (notOwner(req, res)) return;
    const u = queryUrl(req.url);
    const key = u ? store.normUrl(u) : '';
    const r = key ? rounds.get(key) : null;
    return ok(res, { round: r ? roundPayload(key, r) : null });
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
  // is the one button that gives all of it to the bots at once — and it FANS
  // OUT: one preamble turn into page chat saying a round is starting, then one
  // turn per OPEN thread, each queued AGAINST THAT THREAD, in page order
  // (workspace.reviewFanout owns the wording, the order, the routing and the
  // caps).
  //
  // Why fan-out rather than one digest turn: the bridge fixes a turn's target
  // when the job is QUEUED (chat.mjs, job.target) and posts the whole answer
  // back into that target, so a bot cannot choose a thread. Telling twenty
  // bots-worth of prose to "reply in each comment's thread" was therefore an
  // instruction nothing could obey, and the answers all landed in one page-chat
  // lump. Queueing the jobs against the threads is the only way the answers get
  // to the comments — and the companion, which does the queueing, is the only
  // thing that can decide it.
  //
  // Everything else is the ordinary path, deliberately. The preamble is
  // appended as a REAL user message in page chat (visible, editable, deletable,
  // in the session file), each per-thread turn goes through the same `summon`
  // as a tagged thread reply, and NOTHING here is a special case downstream:
  // the reply lands in the thread, store.appendMsg marks it addressed, the
  // drawer's "ready for review" section and the track-changes machinery take it
  // from there.
  //
  // What it does NOT do: resolve anything. The reader files the threads they
  // are satisfied with, one click each, the same as every other day.
  //
  // If the companion dies mid-round, whatever was still queued is lost exactly
  // as any queued turn is lost — there is no resume, and the reader's remedy is
  // the button they already have: the threads a bot never reached are still
  // open, so send review again sends precisely those.
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
      const fan = page ? workspace.reviewFanout(page) : null;
      if (!fan) {
        return fail(res, 400, 'no open comments to send — highlight something and comment first, or reopen a filed thread');
      }
      const counts = { sent: fan.sent, omitted: fan.omitted, total: fan.total };
      // the same guard a typed message gets: over a tunnel the button has no
      // receipt for a second, and the expensive half of a double-click is a
      // whole round of agent time, not the message
      const dedupe = dedupeCheck([store.pageKey(page.url), store.PAGE_CHAT, me.handle, fan.preamble]);
      if (dedupe.hit) return ok(res, { msg: dedupe.hit, deduped: true, ...counts, queued: 0, threads: [] });
      const msg = store.appendMsg(page, store.PAGE_CHAT, { author: me.handle, text: fan.preamble });
      dedupe.remember(msg);
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      // The preamble is routed @all whatever the comments say (summon's
      // forceAll) and carries this page's text; the per-thread turns do not
      // need to carry it again — the artifact banner, the snapshot path and the
      // write rules ride EVERY turn on these pages already (chat.envelope).
      const head = summon(page, store.PAGE_CHAT, fan.preamble,
        { forceAll: true, articleText: data.article_text, articleChanged: !!data.article_changed }, me);
      // Refused (agents off, a guest's budget, an unconfirmed root): the review
      // is kept and NOTHING is queued. Queueing twenty per-thread turns behind a
      // refusal would be twenty identical error lines in twenty threads.
      if (!head.queued) return ok(res, { msg, ...counts, ...head, queued: 0, threads: [] });
      const threads = [];
      for (const t of fan.turns) {
        // exactly the queueing a tagged reply in that thread gets — the target
        // IS the thread — with the thread's own quote and conversation clipped
        // to round size (workspace.reviewFanout) rather than rebuilt here
        const s = summon(page, t.thread_id, t.text, { quote: t.quote, history: t.history }, me);
        if (s.queued) threads.push(t.thread_id);
      }
      // …and the round itself, as a thing with a length and a position in it.
      // Started here rather than on the first turn boundary because THIS is
      // where the queue is known: the strip can say "0 of 12" while the
      // preamble is still going out.
      if (threads.length) startRound(page.url, page, threads);
      // `queued` is the number of TURNS this round put in the queue — the
      // preamble plus one per thread — and `threads` names the threads they are
      // addressed to, which is what lets the drawer spin the right cards.
      ok(res, { msg, ...counts, queued: threads.length + 1, threads });
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
  // --- a picture of one page, for the half of a document that is not text ---
  // The snapshot carries the WORDS of a page and a figure is not words: a
  // reader who highlights a caption and asks what the plot shows was, until
  // now, asking the one question nothing on this machine could answer. The
  // viewer renders the page it is already drawing and posts the picture here;
  // the envelope names the file and both CLIs open it (chat.mjs `figure`).
  //
  // Owner-only, for the same reason the snapshot is: this writes into the
  // reader's own archive, under the reader's own page. Capped, and content
  // keyed in the store — the same page rendered twice writes nothing.
  if (req.method === 'POST' && url === '/page-image') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      if (!data.url) return fail(res, 400, 'url required');
      const n = Math.floor(Number(data.page) || 0);
      if (!(n > 0)) return fail(res, 400, 'page required');
      const page = store.readPage(data.url);
      if (!page) return fail(res, 404, 'unknown page');
      // a data: url or bare base64, whichever the caller found easier —
      // canvas.toDataURL gives the first
      const raw = String(data.data || '').replace(/^data:image\/(?:png|jpe?g);base64,/, '');
      let buf;
      try { buf = Buffer.from(raw, 'base64'); } catch { buf = Buffer.alloc(0); }
      if (!buf.length) return fail(res, 400, 'image data required');
      if (buf.length > PAGE_IMAGE_MAX) {
        return ok(res, { stored: false, page: n, reason: 'page image too large' });
      }
      // it must BE an image: this file is handed to an agent to look at, and a
      // name ending in .png is not evidence of anything
      const ext = pngLike(buf) ? 'png' : (jpegLike(buf) ? 'jpg' : '');
      if (!ext) return fail(res, 400, 'not a PNG or JPEG');
      const r = store.savePageImage(data.url, n, buf, ext);
      return ok(res, {
        stored: r.stored, unchanged: r.unchanged, page: n,
        bytes: buf.length, path: r.file,
      });
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
      // A STRUCK PASSAGE IS ALREADY A STATEMENT. Adobe's strikeout with no
      // popup means "delete this", and requiring a sentence to say so again
      // would make the quicker of the two tools the slower one. Every other
      // thread still needs words: an empty highlight says nothing at all.
      const mark = store.cleanMark(data.mark);
      if (!text.trim() && mark !== 'strike') return fail(res, 400, 'empty comment');
      const me = authorOf(req, res);
      if (!me) return;
      // a brand-new thread has no history to be sticky about: its address is
      // whatever this first comment tagged, or the pill the composer sent
      const route = addressOf('new', text, data.route, []);
      const docxDigest = docxDigestOf(res, data, text, route);
      if (docxDigest === null) return; // 413: nothing is saved, nothing is queued
      // a highlight can arrive before any /page upsert (fresh tab, fast hands)
      const page = store.readPage(data.url) || store.upsertPage(data);
      // same person, same words, same highlight, seconds apart: one comment
      // …and the mark is part of what makes it the same comment: striking a
      // passage you had already highlighted is a second, different act
      const dedupe = dedupeCheck([store.pageKey(page.url), 'thread', me.handle, data.quote, text.trim(), mark]);
      if (dedupe.hit) return ok(res, { thread: dedupe.hit, deduped: true });
      const thread = store.addThread(page, {
        quote: data.quote, prefix: data.prefix, suffix: data.suffix, mark,
        // documents with pages (a web PDF) say which one the passage came off;
        // everything else omits it and nothing downstream requires it
        text, author: me.handle, index: data.index, page_number: data.page,
        // stamped so the next untagged reply here knows who is being talked to
        route,
      });
      dedupe.remember(thread);
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      // a new mark on the document is a new line in the log — and the SECOND
      // one on a page is what brings the log into being at all
      noteDecisions(page);
      ok(res, { thread, ...summon(page, thread.id, text, { ...contextExtras(data, docxDigest), routeHint: route }, me) });
    });
  }
  // --- the unified comment store ----------------------------------------
  // A review page has its own margin, and a visitor without the extension
  // writes into it. Those comments used to stop there: a line in a JSON file
  // beside the document, invisible to the owner's drawer, to the bots, to send
  // review and to the export. This is the door they come through instead.
  //
  // WHO MAY KNOCK. The loopback, and only the loopback — the same three-part
  // test the API keys stand behind. This endpoint names its own author, which
  // is exactly the power a guest must never have; a caller on this machine
  // already owns the files these threads live in, so naming one is no
  // privilege it did not already hold. Over the tunnel it is a flat 403.
  //
  // WHAT IT IS. A projection, not a second write path: one POST carries every
  // review comment on one page, the companion files each under its `origin`
  // and does nothing at all for the ones it has already seen. Idempotent by
  // construction, so the mirror may run as often as it likes.
  if (req.method === 'POST' && url === '/review-comments') {
    if (!isLocalDirect(req)) {
      req.resume();
      return fail(res, 403, 'the review mirror speaks to the companion on the loopback only');
    }
    return readBody(req, res, data => {
      if (!data.url) return fail(res, 400, 'url required');
      const list = Array.isArray(data.comments) ? data.comments : [];
      if (!list.length) return fail(res, 400, 'comments required');
      const page = store.readPage(data.url)
        || store.upsertPage({ url: data.url, title: data.title, site: data.site });
      const threads = {};
      const refusals = [];
      let created = 0;
      let appended = 0;
      let skipped = 0;
      let changed = false;
      for (const c of list) {
        const origin = store.cleanOrigin({ system: 'review', id: c && c.id });
        const author = sanitizeHandle(c && c.author);
        const text = String((c && c.text) || '');
        if (!origin || !author || !text.trim()) { skipped++; continue; }
        const quote = String((c && c.quote) || '').trim();
        let target = null;
        let fresh = false;
        if (!quote) {
          // A comment on the document AS A WHOLE — the review engine's
          // block-level comment, which has no selection to anchor to. Discuss
          // already has the surface for exactly that thought, and it is page
          // chat; inventing an anchorless thread would only mint an orphan.
          target = store.PAGE_CHAT;
          const seen = (page.page_chat || []).some(m => {
            const o = store.originOf(m);
            return o && o.id === origin.id;
          });
          if (!seen) {
            const msg = store.appendMsg(page, target, { author, text, ts: c.ts, origin });
            if (msg) { created++; fresh = true; changed = true; }
          }
        } else {
          let thread = store.findOrigin(page, 'review', origin.id);
          if (!thread) {
            thread = store.addThread(page, {
              quote, prefix: c.prefix, suffix: c.suffix, text, author,
              ts: c.ts, origin,
            });
            created++;
            fresh = true;
            changed = true;
          }
          target = thread.id;
          // the visitor's own replies over there, in order, each one landing
          // once: a reply is its author and its timestamp, and the mirror may
          // resend the lot on every keystroke
          for (const r of (Array.isArray(c.replies) ? c.replies : [])) {
            const rAuthor = sanitizeHandle(r && r.author) || author;
            const rText = String((r && r.text) || '');
            const rTs = String((r && r.ts) || '');
            if (!rText.trim() || !rTs) continue;
            if ((thread.msgs || []).some(m => m.ts === rTs && sanitizeHandle(m.author) === rAuthor)) continue;
            store.appendMsg(page, target, { author: rAuthor, text: rText, ts: rTs, origin });
            appended++;
            changed = true;
          }
          // RESOLVING TRAVELS ONE WAY, AND ONCE. Filed over there is filed
          // here — the person who wrote the comment has said they are done
          // with it. But it is the FILING that crosses, not the state: a
          // reader who reopens the thread here has disagreed, and a mirror
          // that re-applied a months-old `resolved: true` on its next pass
          // would close it again behind them, forever. `origin_filed` is the
          // one bit that remembers we already acted, and it is cleared the
          // moment the review record says the comment is open again — so a
          // genuine re-file over there does file it again.
          if (c.resolved) {
            if (!thread.origin_filed) {
              thread.origin_filed = true;
              if (!store.isResolved(thread)) store.setResolved(thread, true, author);
              changed = true;
            }
          } else if (thread.origin_filed) {
            delete thread.origin_filed;
            changed = true;
          }
        }
        if (target) threads[origin.id] = target;
        // The bots, when this paper has none of its own. A paper served with
        // `--chat` already answers its margin mentions through its own bridge
        // and its answers already land in the review record; summoning here as
        // well would spend two agents to say one thing twice. Without that
        // bridge the mention would reach nobody at all, so it reaches these.
        // Guests are governed by grants.json exactly as they are everywhere.
        if (fresh && data.summon && target) {
          const me = { handle: author, owner: false };
          const routeHint = target === store.PAGE_CHAT
            ? '' : addressOf(target, text, '', []);
          const r = summon(page, target, text, { routeHint }, me);
          if (r && r.reason) refusals.push({ id: origin.id, reason: r.reason });
        }
      }
      if (changed) {
        store.savePage(page);
        broadcast({ type: 'page', url: page.url });
      }
      ok(res, { url: page.url, threads, created, appended, skipped, refusals });
    });
  }
  // --- the comments that were already in the PDF -------------------------
  // Same door, other system. A manuscript that has been round a supervisor
  // arrives with Acrobat highlights and Preview sticky notes in it: real
  // comments, by real people, with dates — and Discuss used to render that
  // paper and say "No comments yet", which was a lie about the document on
  // screen. The VIEWER reads them (only the viewer has the parsed document and
  // the text layer that says which words a quad covers) and offers them to the
  // reader; accepting posts them here.
  //
  // OWNER-ONLY, and for the same reason /review-comments is loopback-only:
  // this endpoint NAMES ITS OWN AUTHORS. "adril" on an imported thread is the
  // /T field of an annotation, not anybody who signed in, and minting comments
  // under other people's names is exactly the power a guest must never hold.
  //
  // A projection, not a second write path: every annotation is filed under
  // `origin: {system:'pdf-annot', id}` and one already there is left alone, so
  // re-opening the paper (which the reader will do, often) offers nothing and
  // costs nothing. Nothing here summons a bot: an imported comment is somebody
  // else's remark, and the reader decides which of them is worth an agent —
  // the thread is ordinary in every other way, so @claude in a reply works.
  if (req.method === 'POST' && url === '/pdf-annotations') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      if (!data.url) return fail(res, 400, 'url required');
      const list = Array.isArray(data.annots) ? data.annots : [];
      if (!list.length) return fail(res, 400, 'annots required');
      const page = store.readPage(data.url) || store.upsertPage(data);
      const threads = {};
      let created = 0;
      let appended = 0;
      let skipped = 0;
      let changed = false;
      for (const a of list) {
        const origin = store.cleanOrigin({ system: 'pdf-annot', id: a && a.id });
        // an annotation's /T is a person's name as they typed it into
        // Acrobat's preferences ("Angadh Nanjangud"), so it goes through the
        // same handle sanitizer every other author does; an anonymous
        // annotation is filed under the file itself rather than under nobody
        const author = sanitizeHandle((a && a.author) || '') || 'pdf';
        const text = String((a && a.text) || '');
        if (!origin || !text.trim()) { skipped++; continue; }
        const quote = String((a && a.quote) || '').trim();
        let target = null;
        if (!quote) {
          // a sticky note with no words anywhere near it — a note on a blank
          // page, or in a margin beside a figure. Page chat is the surface for
          // a remark about the document; an anchorless thread would be an
          // orphan the moment it was made.
          target = store.PAGE_CHAT;
          const seen = (page.page_chat || []).some(m => {
            const o = store.originOf(m);
            return o && o.id === origin.id;
          });
          if (!seen) {
            if (store.appendMsg(page, target, { author, text, ts: a.ts, origin })) {
              created++;
              changed = true;
            }
          }
        } else {
          let thread = store.findOrigin(page, 'pdf-annot', origin.id);
          if (!thread) {
            thread = store.addThread(page, {
              quote, prefix: a.prefix, suffix: a.suffix, text, author,
              ts: a.ts, origin, index: a.index, page_number: a.page,
              // the file already said what was done to the passage: a
              // StrikeOut (or a Squiggly) comes in struck, and stays struck
              // when the discussion is written back out
              mark: store.markForAnnotKind(a && a.kind),
            });
            created++;
            changed = true;
          }
          target = thread.id;
          // Acrobat's own reply chain (/IRT): each reply is a message under
          // the comment it answers, landing once — its own origin id is what
          // says so, exactly as the review mirror's replies do.
          for (const r of (Array.isArray(a.replies) ? a.replies : [])) {
            const rOrigin = store.cleanOrigin({ system: 'pdf-annot', id: r && r.id });
            const rText = String((r && r.text) || '');
            if (!rOrigin || !rText.trim()) { skipped++; continue; }
            const seen = (thread.msgs || []).some(m => {
              const o = store.originOf(m);
              return o && o.id === rOrigin.id;
            });
            if (seen) continue;
            store.appendMsg(page, target, {
              author: sanitizeHandle((r && r.author) || '') || author,
              text: rText, ts: r.ts, origin: rOrigin,
            });
            appended++;
            changed = true;
          }
        }
        if (target) threads[origin.id] = target;
      }
      if (changed) {
        store.savePage(page);
        broadcast({ type: 'page', url: page.url });
      }
      ok(res, { url: page.url, threads, created, appended, skipped });
    });
  }
  if (req.method === 'POST' && url === '/reply') {
    return readBody(req, res, data => {
      const text = String(data.text || '');
      if (!text.trim()) return fail(res, 400, 'empty reply');
      const me = authorOf(req, res);
      if (!me) return;
      const page = pageOf(res, data);
      if (!page) return;
      const target = data.thread_id || store.PAGE_CHAT;
      // read the thread BEFORE this message joins it: the sticky address is who
      // the reader was talking to up to now, and appendMsg is one line below
      const route = addressOf(target, text, data.route, store.msgsOf(page, target));
      const docxDigest = docxDigestOf(res, data, text, route);
      if (docxDigest === null) return;
      const dedupe = dedupeCheck([store.pageKey(page.url), target, me.handle, text.trim()]);
      const anchor = target === store.PAGE_CHAT ? '' : target;
      if (dedupe.hit) {
        return data._form
          ? seeOther(res, backTo(data, page, anchor))
          : ok(res, { msg: dedupe.hit, deduped: true });
      }
      const msg = store.appendMsg(page, target, { author: me.handle, text, route });
      if (!msg) return fail(res, 404, 'unknown thread');
      dedupe.remember(msg);
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      const summoned = summon(page, target, text, { ...contextExtras(data, docxDigest), routeHint: route }, me);
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
      // a deleted thread is a decision leaving the review, exactly as a filed
      // one is a decision entering it
      noteDecisions(page);
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
        // …and with a POOL it must be the child holding THIS page's lane, not
        // any running child: only the one that drove this session has it in
        // memory, and only that one would rewrite the file. `controlFor`
        // answers false when no child holds the lane, which means nobody owns
        // the file and we may remove it ourselves — a sharper answer than
        // "some bridge is up", not a looser one.
        const owner = chatFor(page.url);
        if (owner && owner !== chat) session_deleted = false;
        else if (chat && chat.controlFor(page.url, `/delete ${sid}`)) session_deleted = true;
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
      noteDecisions(page);
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
        // the passage a decision was about has been rewritten: the log quotes
        // passages, so it is now quoting one that is no longer there
        noteDecisions(page);
      }
      ok(res, { thread: r.thread, changed: !!r.changed });
    });
  }
  // ---- the mark, changed after the fact --------------------------------
  //
  // THE REPORT. The reader highlighted "Long-term simulations" on a manuscript,
  // discussed it with the bots, and between them decided the passage should go.
  // The thread stayed an amber highlight, because the two tools were a choice
  // made at the moment of selection and never again — so the only route to the
  // red line was to delete the thread and draw the strikeout over the passage a
  // second time, losing the conversation that reached the decision.
  //
  // The mark is a FIELD, so this is a one-key write and every thread ever
  // recorded is convertible — including the ones made before the mark existed,
  // which have no `mark` key at all. Nothing else on the record is touched:
  // `quote`, `prefix`, `suffix`, `prior_quote` and the whole message chain are
  // exactly what they were, which is why the export still signs the annotation
  // with whoever OPENED the thread and why track changes carries straight over.
  //
  // OWNER-ONLY, like /reanchor and unlike /resolve: this edits what the document
  // SAYS about a passage, in the file that goes to somebody else, under the
  // owner's name. A guest may hold an opinion about a thread; they may not draw
  // on the manuscript.
  //
  // IDEMPOTENT: setting the mark it already has is a 200 with `changed: false`
  // and no write and no broadcast. Refused on a document that cannot carry a
  // strikeout, and refused on a FILED thread — see `strikeable`.
  if (req.method === 'POST' && url === '/mark') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const thread = store.findThread(page, data.thread_id);
      if (!thread) return fail(res, 404, 'unknown thread');
      const want = store.cleanMark(data.mark);
      // the REVERSE — back to an ordinary highlight — is not gated on the
      // document: undoing a mark that is already on the record must always be
      // possible, whatever the page has since been decided to be
      if (want === 'strike') {
        if (store.kindOf(page) !== 'pdf') {
          return fail(res, 409, 'a strikethrough is a PDF markup — this page cannot carry one');
        }
        if (thread.resolved) {
          return fail(res, 409, 'this thread is filed — reopen it to change its markup');
        }
      }
      const changed = store.setThreadMark(thread, want);
      if (changed) {
        store.savePage(page);
        broadcast({ type: 'page', url: page.url });
        noteDecisions(page);
      }
      ok(res, { thread, changed });
    });
  }
  // ---- …and the strike a DISCUSSION concluded --------------------------
  //
  // The other half, and deliberately NOT the same act. A bot suggested the
  // passage should come out (`strike:` — store.parseStrikeSuggestion) and the
  // reader agreed. Converting the discussion in place would put the whole
  // conversation — the bot's name, its reasoning, the reader's questions — into
  // the popup of the annotation that goes to the co-author. What the reader
  // wants to hand over is a strikeout with their name on it and a sentence under
  // it, and what they want to do with the discussion is delete it.
  //
  // So this MINTS a second thread: same passage, same anchor, same page number,
  // the strike mark, authored by the OWNER, carrying at most the one short
  // reason the suggestion named and NOT ONE WORD of the conversation. It is a
  // wholly independent record — the discussion may be deleted the second after
  // and this one is untouched — and the only thing connecting them is
  // `from_thread`, which this drawer reads for a "view" link and which nothing
  // in the export has ever heard of.
  //
  // Owner-only for the same reason /mark is, and it summons nobody: a decision
  // the conversation already reached does not need another turn spent on it.
  if (req.method === 'POST' && url === '/strike-from') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const me = authorOf(req, res);
      if (!me) return;
      const page = pageOf(res, data);
      if (!page) return;
      const from = store.findThread(page, data.thread_id);
      if (!from) return fail(res, 404, 'unknown thread');
      if (store.kindOf(page) !== 'pdf') {
        return fail(res, 409, 'a strikethrough is a PDF markup — this page cannot carry one');
      }
      // Already struck. A second confirm — a double tap, a chip in another tab,
      // the reader taking the OTHER bot's suggestion, or (the case this was
      // rebuilt for) the bot REISSUING its suggestion because the first note
      // was wrong — must not put a second red line over one passage.
      //
      // The test is the QUOTE, not the thread: two suggestions inside one thread
      // are two opinions about the SAME passage and can only ever produce one
      // strikeout, while a suggestion about a genuinely different passage is a
      // different anchor and mints its own.
      //
      // WHAT CHANGED (2026-08-27). It used to hand the existing thread straight
      // back and do nothing, which was right for a double tap and wrong for
      // everything else: a reader whose first note came out deictic or truncated
      // had NO WAY to correct it — the bot reissued, the chip was confirmed, and
      // the door quietly kept the bad note while the bots told the reader it was
      // fixed. A confirm is the owner's explicit choice of wording, so a DIFFERENT
      // note now REWRITES the note on the strike that is already there.
      //
      // Owner identity and time: untouched and recorded respectively. The card
      // keeps the hand that signed it and the moment it was created (`msgs[0].ts`
      // is the annotation's date and the export's), gains `edited` so the drawer
      // says so, and the thread gains `updated` — a plain ISO stamp, absent on
      // every strike that has never been renoted, so nothing needs migrating.
      // The card and the exported /Contents read the new note because both read
      // `msgs[0].text`, which is the whole of the change.
      //
      // TWO WAYS TO FIND IT, and the LINK comes first. `from_thread` is what
      // this discussion actually minted; the quote is only a guess that it is
      // the same passage, and a guess that goes wrong the moment the anchor
      // drifts — the passage gets rewritten, the thread re-anchors onto the new
      // wording, and a correction from the very discussion that produced the
      // mark would suddenly mint a SECOND red line beside the first. So a
      // confirm coming out of a discussion updates the strike that discussion
      // minted, whatever either of them now quotes; the quote match stays as
      // the fallback for a suggestion that arose somewhere else (a second
      // discussion on the same sentence, another tab, an older record with no
      // link on it at all).
      //
      // WHAT CHANGED AGAIN (2026-08-29). A discussion may now mint SEVERAL
      // cards, so "the strike this thread minted" is no longer a single thing
      // and the link alone cannot say which one a confirm is about. The link
      // match is therefore the CHIP's link — thread, reply and position in that
      // reply — which is exactly "the card this very chip made", and still beats
      // the quote after an anchor has drifted. The quote match then does the
      // work it always did, one rung out: a different chip, a different bot, a
      // different discussion, all landing on the same span.
      //
      // …and the passage that span is measured on may be the BOT's rather than
      // the reader's, where the suggestion named its own (`passage:`). Checked
      // again here and not merely at the lift, because a door must not take a
      // client's word for where a mark may be made.
      const passage = String(data.passage || '').trim();
      let anchor = { quote: from.quote, prefix: from.prefix, suffix: from.suffix, page: from.page };
      if (passage) {
        const r = store.resolvePassage(page, from, passage,
          store.readSnapshot(store.pageKey(page.url)));
        if (r.fault) {
          return fail(res, 400,
            `that passage cannot be marked — ${store.strikeFaultWhy(r.fault, r.phrase)}`);
        }
        anchor = r.anchor;
      }
      const fromMsg = String(data.from_msg || '');
      const fromIdx = Number(data.from_idx) > 0 ? Number(data.from_idx) : 0;
      const mine = t => ((t.msgs || [])[0] || {}).author === me.handle;
      const struck = (page.threads || []).filter(t => store.markOf(t) === 'strike' && mine(t));
      const already = struck.find(t => t.from_thread === from.id
          && String(t.from_msg || '') === fromMsg
          && (Number(t.from_idx) || 0) === fromIdx)
        || struck.find(t => t.quote === anchor.quote);
      // The note, whichever path takes it: NEVER CUT. A note past the cap is
      // refused at the door in the same breath the lift refuses it, because
      // half a replacement sentence on a document is worse than none — the
      // reader who hit this got a strikeout whose note stopped mid-word and was
      // then asked by the bot to paste the rest in by hand.
      const note = String(data.note || '').trim();
      if (note.length > store.STRIKE_NOTE_MAX) {
        return fail(res, 400,
          `that note is longer than ${store.STRIKE_NOTE_MAX} characters — it would have to be cut to fit, and a note is never cut`);
      }
      if (already) {
        const head = (already.msgs || [])[0];
        // RE-ADOPTION. The card has exactly one parent — the discussion standing
        // behind the note it now carries — and this confirm came out of a
        // discussion that may not be the one it had. Editing a long draft
        // surfaces inconsistencies late, and a conversation on page 9 legitimately
        // takes over a mark decided on page 3. `from_thread` moves, the old
        // brood drops it, the new brood gains it, and `prior_threads` keeps the
        // trace so the move is a record rather than an erasure.
        const adopted = store.adoptStrike(already, from.id);
        const renoted = !!(note && head && head.text !== note);
        const remsg = fromMsg && (String(already.from_msg || '') !== fromMsg
          || (Number(already.from_idx) || 0) !== fromIdx);
        // nothing to say, nothing moved: this IS that strike, handed back with
        // no write and no broadcast (the double tap)
        if (!adopted && !renoted && !remsg) {
          return ok(res, { thread: already, deduped: true });
        }
        if (renoted) {
          head.text = note;
          head.edited = true;
          already.updated = new Date().toISOString();
        }
        // …and which reply won, now: the drawer reads `from_msg`/`from_idx` to
        // tell the chosen chip from the ones that were not chosen, and the
        // chosen one may have just changed.
        if (fromMsg) {
          already.from_msg = fromMsg;
          if (fromIdx) already.from_idx = fromIdx; else delete already.from_idx;
        }
        store.savePage(page);
        broadcast({ type: 'page', url: page.url });
        noteDecisions(page);
        return ok(res, { thread: already, updated: renoted, ...(adopted ? { adopted: true } : {}) });
      }
      const thread = store.addThread(page, {
        // the anchor, which is the reader's highlight unless the suggestion
        // corrected it with a `passage:` line of its own
        quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix,
        page_number: anchor.page, mark: 'strike',
        passage_named: !!passage,
        // The note, and the whole of it: the reason the suggestion gave, or
        // nothing at all — in which case the strikeout speaks for itself,
        // exactly as one drawn by hand with an empty composer does (the popup
        // reads "(no note)" and the card reads "the passage was struck through,
        // with no note"). The reader may edit or delete it afterwards like any
        // comment of their own, because it IS one — POST /edit takes it, being
        // the owner's own message, and the card and the export both read
        // `msgs[0].text`, so a hand-edit lands everywhere the confirm does.
        text: note,
        author: me.handle,
        // it lands immediately after the discussion it came out of, so the
        // reader's eye finds it where they are already looking — and page order
        // survives the discussion being deleted, because the index is spent at
        // insertion and never consulted again
        // …and after the ones it already minted, so a brood of three reads in
        // the order the reader confirmed them rather than backwards
        index: Math.max(
          (page.threads || []).indexOf(from),
          ...store.broodOf(page, from.id).map(t => (page.threads || []).indexOf(t)),
        ) + 1,
        from_thread: from.id,
        // …and WHICH suggestion was taken. Both bots may propose a deletion in
        // one thread — the reader asks each in turn and picks the wording they
        // prefer — so the record has to say which reply's chip was the one that
        // was clicked, or the drawer cannot tell the chosen one from the ones
        // that were merely not chosen.
        // …and WHICH suggestion IN that reply, because one reply may now carry
        // up to STRIKE_PER_REPLY_MAX of them and each mints its own card.
        from_msg: fromMsg,
        from_idx: fromIdx,
      });
      store.savePage(page);
      broadcast({ type: 'page', url: page.url });
      noteDecisions(page);
      ok(res, { thread });
    });
  }
  // ---- the question vault ------------------------------------------------
  //
  // OWNER-ONLY, all of it, for the reason /project-page is: these are the
  // reader's own memory and the record of what they keep getting wrong, which
  // is nobody's business over a tunnel. It also spends the owner's agents.
  //
  // "Make a question of this." The passage is either a thread's (the card-head
  // button, and the bot-suggestion chip) or a bare selection's (the pill's
  // third tool, on a page with no thread on that passage at all).
  if (req.method === 'POST' && url === '/question') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const thread = data.thread_id ? store.findThread(page, data.thread_id) : null;
      if (data.thread_id && !thread) return fail(res, 404, 'unknown thread');
      const made = makeCard(page, {
        thread,
        quote: data.quote,
        page_number: data.page,
        from_msg: data.from_msg,
        hint: data.hint,
        model: data.model,
      });
      if (!made.ok) return fail(res, 400, made.error);
      ok(res, { card: made.card, queued: !!made.queued,
        ...(made.reason ? { reason: made.reason } : {}) });
    });
  }
  // "Revise the card." The other half of the offer above, and the only route
  // in this product that CHANGES a question rather than adding one.
  //
  // The corrected card is read off the RECORD — the message the bot wrote,
  // where the lift already parsed and checked it — and never off the request.
  // The chip therefore carries pointers only (which thread, which reply), the
  // guards that ran at the lift run again here against the vault as it is NOW
  // (a card the reader discarded in between is gone, and this must say so
  // rather than resurrect it), and a client cannot post a card of its own
  // invention into somebody's bank.
  if (req.method === 'POST' && url === '/question-revise') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const page = pageOf(res, data);
      if (!page) return;
      const thread = store.findThread(page, data.thread_id);
      if (!thread) return fail(res, 404, 'unknown thread');
      const ts = String(data.from_msg || '');
      const msg = (thread.msgs || []).find(m => m && String(m.ts || '') === ts);
      const q = (msg && msg.question) || null;
      // …the refusal FIRST: a revision thrown away at the lift kept its
      // `revises` and no card, and the honest answer to a click on it is what
      // happened, not "there is nothing here"
      if (q && q.rejected) return fail(res, 400, 'that revision was refused when it was written');
      if (!q || !q.revises || !q.card) return fail(res, 404, 'no revision on that reply');
      const vault = questions.readVault();
      const card = questions.findCard(vault, q.revises);
      if (!card) return fail(res, 404, 'that card is no longer in the vault');
      if ((card.source || {}).page_key !== store.pageKey(page.url)) {
        return fail(res, 400, 'that card belongs to another page');
      }
      const revised = questions.reviseCard(vault, q.revises, q.card,
        { model: msg.author, from_msg: ts });
      questions.saveVault(vault);
      broadcast({ type: 'question', url: page.url, card_id: revised.id,
        state: revised.state, revised: true });
      ok(res, { card: revised, revised: true });
    });
  }
  // "They are not the same question." The reader's veto on the duplicate hint,
  // pinned on both cards so it is never offered again. The other two answers to
  // the hint need no door of their own: dropping one of the pair is
  // /quiz-delete, and ignoring it costs a line.
  if (req.method === 'POST' && url === '/quiz-keep') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const vault = questions.readVault();
      if (!questions.keepBoth(vault, data.id, data.other)) return fail(res, 404, 'unknown card');
      questions.saveVault(vault);
      // from the scriptless page: back to the reveal the reader was reading,
      // which now simply has no hint on it
      if (data._form) return seeOther(res, quizBack(data, true));
      ok(res, { ok: true });
    });
  }
  // The vault itself, as JSON: the drawer reads it for its due count, and the
  // tests read it for everything.
  if (req.method === 'GET' && url === '/questions') {
    if (notOwner(req, res)) return;
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const vault = questions.readVault();
    const scope = { project: q.get('project') || '', tag: q.get('tag') || '', key: q.get('key') || '' };
    // ?page=<url> asks a SECOND question of the same request: which threads on
    // that page have minted a memory. Deliberately not the `key` scope — the
    // drawer wants the door's count over the WHOLE bank (one bank, every page)
    // and the thread marks for the page it is open on, and folding the two
    // into one filter would make the door say "3 due" when it means "3 due
    // here". The drawer holds a url, not a sha1; either spelling is accepted.
    const key = q.get('page') ? store.pageKey(q.get('page')) : scope.key;
    return ok(res, {
      counts: questions.counts(vault, scope),
      facets: questions.facets(vault),
      due: questions.dueCards(vault, { ...scope, limit: questions.SESSION_MAX }),
      // WHICH THREADS ON THIS PAGE HAVE MINTED ONE, when a page was named:
      // the drawer's own affordance, answered in the request it was already
      // making rather than one per card on the screen.
      threads: key ? questions.threadCounts(vault, key) : undefined,
      // …and what THIS page has due, which is the Memorize tab's own badge.
      // Separate from `counts` on purpose: the header door counts the whole
      // bank, the tab counts where the reader is standing, and the two
      // numbers are different questions with different answers.
      page_counts: key ? questions.counts(vault, { key }) : undefined,
      cards: q.get('all') === '1' ? vault.cards : undefined,
    });
  }
  // THE DRAWER'S OWN VIEW OF THE VAULT, scoped to where the reader IS.
  //
  // The quiz at memory.botference.com is the everything-bank: you go there to
  // revise concepts, on a phone, away from all of this. This is the other half
  // of the same thought — revising the page you are standing on, in the column
  // beside it, while the argument that produced the questions is still open.
  // Same vault, same endpoints, same SM-2: the drawer answers through
  // /quiz-answer like the scriptless page does, and there is exactly one
  // schedule on disk. What this route adds is the SCOPE the drawer needs and
  // the reading room does not: this page, or one of the council projects the
  // page is filed in ("what did I take away from this book").
  if (req.method === 'GET' && url === '/memory') {
    if (notOwner(req, res)) return;
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const page = store.readPage(q.get('url') || '');
    if (!page) return fail(res, 404, 'unknown page');
    const key = store.pageKey(page.url);
    const vault = questions.readVault();
    // WHERE THE READER MAY LOOK FROM, and nothing else: this page, and the
    // projects this page is filed in. Never the whole bank — that is the
    // quiz's job, at its own address, and a drawer offering it too would be
    // two homes for one archive.
    const projects = store.projectsOf(page).map(p => ({
      id: `project:${p.id}`, label: p.id,
      ...questions.counts(vault, { project: p.id }),
    }));
    const scopes = [{ id: 'page', label: 'this page', ...questions.counts(vault, { key }) }, ...projects];
    const asked = String(q.get('scope') || 'page');
    const chosen = scopes.some(s => s.id === asked) ? asked : 'page';
    const scope = chosen === 'page' ? { key } : { project: chosen.slice('project:'.length) };
    return ok(res, {
      scope: chosen,
      scopes,
      counts: questions.counts(vault, scope),
      // …each with the sibling that looks like the same question, where there
      // is one (questions.duplicateOf). It rides the card rather than being a
      // request of its own because the tab draws the hint beside the card and
      // a second round trip per card on screen would be absurd for a line the
      // reader may ignore.
      cards: questions.dueCards(vault, { ...scope, limit: questions.SESSION_MAX })
        .map(c => withDuplicate(vault, c)),
    });
  }
  // Answering one. The grade is the whole of the reader's input — right or
  // wrong, one tap — and everything else (the interval, the ease, when it
  // comes back) is SM-2's (questions.grade).
  if (req.method === 'POST' && url === '/quiz-answer') {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const vault = questions.readVault();
      const card = questions.findCard(vault, data.id);
      if (!card) return fail(res, 404, 'unknown card');
      const choice = Number(data.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= (card.options || []).length) {
        return fail(res, 400, 'that is not one of the options');
      }
      const correct = choice === card.answer;
      questions.grade(card, correct);
      questions.saveVault(vault);
      const s = quizSession(req);
      if (s) { questions.advance(s, card.id, correct); s.last = { id: card.id, choice, correct }; }
      if (data._form) return seeOther(res, quizBack(data, true));
      ok(res, { card, correct });
    });
  }
  // "This card seems wrong." It leaves the rotation at once — a card the
  // reader does not trust must not go on being asked — and keeps everything it
  // had, because the whole point of the source link beside it is that a bot
  // wrote this and bots are wrong sometimes.
  if (req.method === 'POST' && (url === '/quiz-flag' || url === '/quiz-delete')) {
    if (notOwner(req, res)) return;
    return readBody(req, res, data => {
      const vault = questions.readVault();
      const done = url === '/quiz-delete'
        ? questions.deleteCard(vault, data.id)
        : questions.flagCard(vault, data.id, data.note);
      if (!done) return fail(res, 404, 'unknown card');
      questions.saveVault(vault);
      const s = quizSession(req);
      if (s && s.last && s.last.id === data.id) s.last = null;
      if (data._form) {
        return seeOther(res, quizBack(data, false, url === '/quiz-delete' ? 'discarded' : 'flagged'));
      }
      ok(res, { ok: true });
    });
  }
  // THE QUIZ. It lives in the reading room and not in the drawer, and that is
  // the point: the reader reviews on a phone, on a train, away from the Mac the
  // extension is installed on. Scriptless, like every other page here — one
  // card, option buttons that are form posts, and the query string for state —
  // so it works with JavaScript off and cannot get out of step with itself.
  if (req.method === 'GET' && url === '/quiz') {
    const me = hosted.identity(req);
    if (notOwner(req, res)) return;
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const scope = { project: q.get('project') || '', tag: q.get('tag') || '' };
    const vault = questions.readVault();
    let s = quizSession(req);
    // A filter change is a new sitting, not a re-ordering of this one.
    if (!s || s.scopeKey !== scopeKey(scope) || (!s.last && !questions.sessionCard(vault, s))) {
      s = questions.startSession(vault, scope);
      s.scopeKey = scopeKey(scope);
      quizzes.set(quizWho(req), s);
    }
    // ?reveal=1 paints the answer the reader just gave; anything else is the
    // next card, and asking for the next card is what clears the reveal.
    const reveal = q.get('reveal') === '1' ? s.last : null;
    if (!reveal) s.last = null;
    const shown = reveal ? questions.findCard(vault, reveal.id) : questions.sessionCard(vault, s);
    // where the reading room is, from here: relative on its own hostname,
    // absolute on the vault's own (they are two addresses for one companion)
    const home = readingRoomOrigin(req);
    const html = quizView({
      me,
      card: shown,
      home,
      // the quiet way back, on every card and in every state — resolved now,
      // against the live record, so a deleted thread or a deleted page drops
      // the affordance instead of offering a link to nothing
      trace: shown ? traceOf(shown, home) : null,
      // does the source page have a readable copy on this machine? then "the
      // page" is the article view and the quote is a tap from being in context
      read: !!(shown && store.hasSnapshot(String((shown.source || {}).page_key || ''))),
      reveal,
      // …and the sibling that looks like the same question, if there is one.
      // Offered on the reveal only: the reader is deciding what to keep, and
      // the moment to decide that is after the card has been asked, never
      // while they are trying to answer it.
      dup: (reveal && shown) ? (questions.duplicateOf(vault, shown) || null) : null,
      session: { asked: s.asked, right: s.right, wrong: s.wrong, left: Math.max(0, s.queue.length - s.i) },
      counts: questions.counts(vault, scope),
      facets: questions.facets(vault),
      scope,
      // the one-line receipt for a card just taken out of the rotation
      gone: ['discarded', 'flagged'].includes(q.get('gone')) ? q.get('gone') : '',
    });
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
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
