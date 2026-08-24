// workspace.mjs — project artifact pages: the council behind a local file.
//
// A council chat writes HTML into its project folder
// (`<root>/projects/spaceship-engineering/index.html`) and the reader opens it
// as a `file://` page. Everywhere else in this companion a page is a page and
// the chat behind it lives under the plugin's own project "Plugin pages"; here
// it must not, because the chat behind THIS page already exists — it is the
// council chat that produced the file, filed under the real project in the
// real council state. This module is the part that knows that: which directory
// on this machine is a council root, whether a file sits inside one of its
// projects, and what chats that project already has.
//
// ── IDENTITY IS THE PATH, DELIBERATELY ────────────────────────────────────
// content.js says at length that a path is not an identity, and files a local
// PDF under the hash of its bytes for exactly that reason. A project artifact
// is the opposite case and gets the opposite rule. These files are REGENERATED
// in place — that is what the project is for; the bots rewrite index.html and
// the reader reloads the tab. Under a content hash every rebuild would be a
// new page and every annotation would be stranded by the next build, which is
// the failure the hash exists to prevent, arriving from the other direction.
// The path is what is stable here: `projects/<id>/index.html` is the artifact,
// whatever it currently says.
//
// ── NOTHING IS WRITTEN INTO A COUNCIL ROOT BY THIS FILE ───────────────────
// Every function here reads. The plugin's own state (page records, config,
// the bridge's task file) stays under the companion's own ROOT; the only
// thing that ever writes inside a council root is botference itself, saving
// the session the bridge is driving — and, since Phase 2, the BOTS, inside
// `projects/<id>/` and nowhere else (chat.mjs spawns the workspace bridge
// with that one directory as its write root). This file still only reads;
// `scanProject` below reads mtimes so the companion can tell what the bots
// changed, which is the other half of Phase 2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig, saveConfig } from './store.mjs';
// the routing rules, borrowed rather than copied: a per-thread review turn is
// addressed by exactly the tags every other turn is addressed by (chat.routeOf),
// and two copies of that rule could disagree about who a thread belongs to
import { routePrefix, isBotAuthor } from './chat.mjs';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readJson = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

// How far up from a file we are willing to look for a council root. Deep
// enough for `projects/<id>/book/chapters/three.html`, shallow enough that a
// file at the top of a huge volume does not walk the whole disk.
const WALK_MAX = 24;
// A sid addresses a file on disk; it may not address a directory above it.
export const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// How much of a chat's past the drawer is handed. The drawer folds it (head +
// tail + "Show N earlier replies"), so this is the depth of the history, not
// the height of the pane.
export const TAIL_MAX = 60;
// The archive list. Long enough to be the project's chat history, short enough
// to render in a 380px column without a scroll marathon.
export const SESSIONS_MAX = 60;
// Which files count as a project artifact page. A browser showing anything
// else at a file: url is either the PDF viewer (which has its own identity
// rules and must not be disturbed) or not a page at all.
const ARTIFACT_RE = /\.x?html?$/i;

// ---- paths ---------------------------------------------------------------

// The absolute path a file: url names, or '' for anything else. Percent
// escapes and the fragment are the url's business, not the filesystem's.
export function pathFromFileUrl(u) {
  const s = String(u || '');
  if (!/^file:\/\//i.test(s)) return '';
  try {
    const url = new URL(s);
    url.hash = '';
    url.search = '';
    // a file url with a host is somebody else's machine
    if (url.hostname && url.hostname !== 'localhost') return '';
    url.hostname = '';
    return fileURLToPath(url);
  } catch { return ''; }
}

// The same path with every symlink taken out of it. macOS hands out temp
// directories under /var/folders that are really /private/var/folders, so a
// root recorded one way and a page arriving the other way would never match.
// Resolved on BOTH sides of every comparison, or on neither.
export function realish(p) {
  if (!p) return '';
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch { return path.resolve(p); }
}

const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// ---- what a council root looks like --------------------------------------

// The three markers, together: a `project.json` beside a `work/` and a
// `projects/`. Any one of them alone is an ordinary directory somebody named
// after a word botference also uses.
export function isCouncilRoot(dir) {
  return !!dir && isFile(path.join(dir, 'project.json'))
    && isDir(path.join(dir, 'work')) && isDir(path.join(dir, 'projects'));
}

// Walk up from a file until the markers appear. The NEAREST root wins: a
// council checked out inside another council is its own council.
export function councilRootOf(absPath) {
  let dir = path.dirname(path.resolve(absPath));
  for (let i = 0; i < WALK_MAX; i++) {
    if (isCouncilRoot(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '';
}

// portfolio.json is where a project's human title lives. Absent, malformed or
// silent about this id, the folder name is the name — it is what the council
// itself falls back to.
export function projectTitle(root, id) {
  const pf = readJson(path.join(root, 'projects', 'portfolio.json'), null);
  const rows = (pf && Array.isArray(pf.projects)) ? pf.projects : [];
  for (const p of rows) if (p && String(p.id) === id && p.title) return String(p.title);
  return id;
}

// Which project a path is in, by the rule the brief fixes: directly under
// `<root>/projects/<id>/`, and that folder still exists. A project deleted out
// from under an old artifact is not a project any more, and the page goes back
// to being an ordinary local file the extension has no business on.
export function projectOf(root, absPath) {
  const projects = path.join(root, 'projects');
  if (!within(projects, absPath)) return null;
  const id = path.relative(projects, absPath).split(path.sep)[0];
  if (!id || id === '.' || id === '..' || id.startsWith('.')) return null;
  const dir = path.join(projects, id);
  if (!isDir(dir)) return null;
  return { id, title: projectTitle(root, id), dir };
}

// The rules, applied to one absolute path: an existing .html file, inside a
// council root, inside one of that root's `projects/<id>/`. Every caller goes
// through here, whatever url brought the path in — a file: address or the
// council's own web server (below) — so there is exactly one definition of
// what a project artifact is.
function artifactAt(absPath) {
  if (!absPath || !ARTIFACT_RE.test(absPath)) return null;
  if (!isFile(absPath)) return null;
  const p = realish(absPath);
  const root = councilRootOf(p);
  if (!root) return null;
  const proj = projectOf(realish(root), p);
  if (!proj) return null;
  return {
    root: realish(root),
    project_id: proj.id,
    project_title: proj.title,
    project_dir: proj.dir,
    path: p,
    rel: path.relative(realish(root), p),
  };
}

// ---- the same artifact, read through the council's web UI -----------------
// The council web server (frontends/council/server.mjs) serves anything under
// its root at `/files/<path relative to the root>`, which is how a bot links
// the artifact it just wrote into the chat. Click that link and the reader is
// looking at the SAME FILE as the file:// tab — so it must be the same Discuss
// page: same project, same archive, same threads, one record. Anything else
// gives the reader two chats about one document and blames the address bar.
//
// ── WHY AN ORIGIN ALLOWLIST, AND NOTHING WEAKER ─────────────────────────
// The only thing a url tells us here is who served the bytes. A page at
// `https://evil.com/files/projects/spaceship-engineering/index.html` maps to
// exactly the same relative path as the real one, and what is on the screen is
// whatever evil.com decided to send. Believing the path would hand an
// attacker-controlled page the reader's project trust: the council header and
// project name, the project's whole chat archive (titles and transcripts of
// the reader's own council sessions), the identity of a real artifact record —
// and, since Phase 2, a bridge whose child is spawned WRITE-ENABLED inside
// `projects/<id>/`, driven by comments on a page the attacker wrote. So the
// origin must be one the reader has already named as their own council, and an
// unlisted origin is an ordinary web page, full stop. There is deliberately no
// pattern, no wildcard and no "any localhost port".
//
// Which origins those are: the companion's `council_web` config value (the one
// the drawer already links "the full chat" to), its default, and the optional
// `council_web_origins` list — which exists for the reader whose council is
// reachable over a tunnel under a real hostname. One line of config:
//   "council_web_origins": ["https://council.example.com"]
const COUNCIL_WEB_DEFAULT = 'http://localhost:4187';
// The council server's route, exactly (frontends/council/server.mjs).
export const FILES_ROUTE = '/files/';

// The origin of a configured value, or '' — http(s) only, lowercased, and
// nothing but scheme+host+port survives (a `council_web` with a path on it
// still names one origin).
const originOf = v => {
  try {
    const u = new URL(String(v || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin.toLowerCase();
  } catch { return ''; }
};

export function councilWebOrigins() {
  const cfg = readConfig();
  const list = Array.isArray(cfg.council_web_origins) ? cfg.council_web_origins : [];
  const out = new Set();
  for (const v of [COUNCIL_WEB_DEFAULT, cfg.council_web, ...list]) {
    const o = originOf(v);
    if (o) out.add(o);
  }
  return out;
}

// Which roots a `/files/` path may be resolved against. A file: url carries an
// absolute path and the root is found by walking UP from it; an http url
// carries neither, so the roots have to come from somewhere — and the only
// honest source is the set the reader has already been asked about
// (`council_roots`). Confirmed roots are tried first; a declined one is still
// resolved, so the answer stays "that root, declined" rather than silently
// becoming an ordinary web page for a different reason than the reader chose.
// Consequence, documented in SPEC: a council the companion has never seen at a
// file: address cannot be recognised through its web UI until it has been
// asked about once.
export function knownCouncilRoots() {
  const m = rootsMap();
  return Object.keys(m)
    .filter(k => path.isAbsolute(k) && isCouncilRoot(realish(k)))
    .sort((a, b) => (m[b] ? 1 : 0) - (m[a] ? 1 : 0) || a.localeCompare(b))
    .map(realish);
}

// Every existing file a trusted `/files/` url could name, confirmed roots
// first. Returns [] for an untrusted origin, another route, or a remainder
// that is not a plain descending path.
export function councilWebPaths(u) {
  const s = String(u || '');
  if (!/^https?:\/\//i.test(s)) return [];
  let url = null;
  try { url = new URL(s); } catch { return []; }
  if (!councilWebOrigins().has(url.origin.toLowerCase())) return [];
  if (!url.pathname.startsWith(FILES_ROUTE)) return [];
  let rel = '';
  // decoded the way the council server decodes it, so the two agree about
  // which file a url names
  try { rel = decodeURIComponent(url.pathname.slice(FILES_ROUTE.length)); } catch { return []; }
  if (!rel || rel.includes('\0')) return [];
  // Checked AFTER decoding, because `%2e%2e%2f` is the same traversal as `../`
  // and a url may spell it either way. Empty, `.`, `..` and dot-anything are
  // all refused — the same refusal the council server makes, so a path it
  // would answer 403 to never gets treated as a project artifact here.
  const segs = rel.split('/');
  if (segs.some(seg => !seg || seg.startsWith('.'))) return [];
  const out = [];
  for (const root of knownCouncilRoots()) {
    const abs = path.resolve(root, ...segs);
    // belt and braces: the segment check already makes escaping impossible
    if (!within(root, abs)) continue;
    if (isFile(abs)) out.push(abs);
  }
  return out;
}

// The whole question in one call: is this url a project artifact page, and if
// so whose? Returns null for everything else — an ordinary http page, a local
// PDF, a stray .html in Downloads, an artifact whose project has been deleted.
//
// A trusted council-web url answers with the same shape PLUS `ident_href`: the
// file: url of the same file, which is the identity BOTH views of it are filed
// under. (The file: view leaves `ident_href` unset — its address already IS
// its identity, and rewriting it would be a chance to disagree with a record
// that already exists.)
export function artifactFor(url) {
  const s = String(url || '');
  if (/^https?:/i.test(s)) {
    for (const abs of councilWebPaths(s)) {
      const art = artifactAt(abs);
      if (art) return { ...art, via: 'council-web', ident_href: pathToFileURL(abs).href };
    }
    return null;
  }
  const art = artifactAt(pathFromFileUrl(s));
  return art ? { ...art, via: 'file' } : null;
}

// ---- what the bots changed -----------------------------------------------
// Phase 2's second half. After a turn ends on a project artifact page the
// reader should be looking at the file the bots just rewrote, not the one
// they opened — so the companion takes a cheap census of the project folder
// on turn-START and another on turn-END, and the difference is the answer.
//
// A CENSUS, not a watcher: nothing here runs while the reader is merely
// reading. There is no polling at rest, no fs.watch handle to leak, and no
// event unless a turn actually happened and something actually moved.
//
// What is deliberately NOT counted:
//   · `sessions/` — botference itself writes the project's session records
//     while the turn runs. Counting them would make every turn "a change".
//   · dotfiles and dot-directories (.git, .DS_Store, .obsidian) — churn the
//     reader did not ask about and cannot see on the page.
//   · node_modules — a build directory is not an artifact.

// Depth and breadth caps. A project folder is a handful of documents; a
// project folder that is a checked-out monorepo is somebody else's problem
// and must not cost a turn-end several seconds of stat().
const SCAN_MAX_FILES = 4000;
const SCAN_MAX_DEPTH = 12;
const SCAN_SKIP_DIRS = new Set(['sessions', 'node_modules']);
// How many changed paths ride the event. The drawer says "N files"; the list
// is for the log and for a future "what changed" panel, and an unbounded one
// would put a whole build output on the wire.
export const CHANGED_LIST_MAX = 20;

// rel path → "<mtimeMs>:<size>", for every ordinary file under `dir`.
// Unreadable directories are skipped, not thrown over: a census that fails
// half way is a census that reports no change, which is the harmless
// direction to fail in.
export function scanProject(dir) {
  const out = new Map();
  if (!dir || !isDir(dir)) return out;
  const stack = [{ abs: dir, rel: '', depth: 0 }];
  while (stack.length && out.size < SCAN_MAX_FILES) {
    const { abs, rel, depth } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith('.')) continue;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (e.isDirectory()) {
        if (depth + 1 > SCAN_MAX_DEPTH) continue;
        if (SCAN_SKIP_DIRS.has(name)) continue;
        stack.push({ abs: childAbs, rel: childRel, depth: depth + 1 });
        continue;
      }
      // a symlink is not followed: its target may be anywhere, and the census
      // is about this folder
      if (!e.isFile()) continue;
      let st = null;
      try { st = fs.statSync(childAbs); } catch { continue; }
      out.set(childRel, `${Math.round(st.mtimeMs)}:${st.size}`);
      if (out.size >= SCAN_MAX_FILES) break;
    }
  }
  return out;
}

// Which paths differ between two censuses, as one sorted list. Created,
// modified and deleted are all "changed" here: the reader is told a number
// and shown the file, and three shades of that number would say nothing more.
export function diffScans(before, after) {
  const a = before instanceof Map ? before : new Map();
  const b = after instanceof Map ? after : new Map();
  const changed = [];
  for (const [rel, sig] of b) if (a.get(rel) !== sig) changed.push(rel);
  for (const rel of a.keys()) if (!b.has(rel)) changed.push(rel);
  changed.sort();
  return changed;
}

// ---- which roots the reader has vouched for ------------------------------
// A directory with three ordinary names in it is not proof of anything, and
// the consequence of believing it is a bridge spawned against a stranger's
// folder. So the first time a root turns up the drawer asks, once, and the
// answer is kept: `council_roots` in the plugin's own config.json, an absolute
// path to true (yes, that is my council) or false (leave it alone).

const rootsMap = () => {
  const cfg = readConfig();
  const m = cfg.council_roots;
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
};

// 'yes' | 'no' | '' (never asked)
export function rootState(root) {
  const key = realish(root);
  const m = rootsMap();
  if (!Object.prototype.hasOwnProperty.call(m, key)) return '';
  return m[key] ? 'yes' : 'no';
}

export function setRootState(root, confirmed) {
  const key = realish(root);
  if (!key || !path.isAbsolute(key)) return rootState(root);
  saveConfig({ council_roots: { ...rootsMap(), [key]: !!confirmed } });
  return rootState(root);
}

// The artifact plus the reader's standing answer about its root, which is what
// every caller actually wants: the extension attaches on the artifact and the
// drawer asks on the state.
export function artifactState(url) {
  const art = artifactFor(url);
  if (!art) return null;
  return { ...art, confirmed: rootState(art.root) === 'yes', declined: rootState(art.root) === 'no' };
}

// ---- the project's chats -------------------------------------------------

// The council stores sessions under <root>/work/sessions (project-local
// layout) or <root>/sessions (the legacy self-hosted layout the original
// vault runs). Read BOTH — a root that migrated between layouts keeps every
// chat listed; work/sessions wins when a sid appears in each.
const sessionDirs = root => [
  path.join(root, 'work', 'sessions'),
  path.join(root, 'sessions'),
].filter(isDir);

const metaIndex = root => {
  const entries = Object.create(null);
  for (const dir of sessionDirs(root)) {
    const d = readJson(path.join(dir, '.metadata-index.json'), null);
    if (!(d && d.entries && typeof d.entries === 'object')) continue;
    for (const [sid, e] of Object.entries(d.entries)) {
      if (!(sid in entries)) entries[sid] = e;
    }
  }
  return entries;
};

// projects/session-index.json backfills sessions written before payloads
// carried a project_id. Same precedence botference.py uses: the payload wins,
// the index fills the silence.
const indexMap = root => {
  const d = readJson(path.join(root, 'projects', 'session-index.json'), null);
  const rows = (d && Array.isArray(d.sessions)) ? d.sessions : [];
  const m = Object.create(null);
  for (const r of rows) if (r && r.session_id) m[String(r.session_id)] = String(r.project || '');
  return m;
};

const displayTitleOf = payload => String(
  (payload && (payload.custom_title || payload.title)) || '',
).trim();

// Newest first, deduped by sid: every chat this project has, as the drawer's
// archive list wants them. Read from the metadata index botference maintains
// (.metadata-index.json in either sessions layout) — the same cache the
// council's own project panel is built from, so the list agrees with the TUI
// without this companion parsing a single transcript. Chats with no turns in
// them are left out, exactly as the panel leaves them out.
export function listSessions(root, projectId, limit = SESSIONS_MAX) {
  const id = String(projectId || '');
  if (!id) return [];
  const rows = [];
  const seen = new Set();
  const idx = indexMap(root);
  for (const [sid, e] of Object.entries(metaIndex(root))) {
    if (!e || (e.entry_count || 0) < 1) continue;
    const belongs = e.project_id || idx[sid] || '';
    if (belongs !== id) continue;
    if (seen.has(sid)) continue;
    seen.add(sid);
    rows.push({
      session_id: sid,
      title: String(e.title || '').trim() || 'untitled chat',
      updated_at: String(e.updated_at || ''),
      created_at: String(e.created_at || ''),
      entry_count: e.entry_count || 0,
      mtime: Number(e.mtime) || 0,
    });
  }
  // A project may keep its own sessions/ dir; those are tiny and outside the
  // global index, so they are read the way botference.py reads them.
  const localDir = path.join(root, 'projects', id, 'sessions');
  if (isDir(localDir)) {
    let names = [];
    try { names = fs.readdirSync(localDir); } catch { names = []; }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const p = path.join(localDir, name);
      const payload = readJson(p, null);
      if (!payload) continue;
      const sid = String(payload.session_id || name.replace(/\.json$/, ''));
      if (seen.has(sid)) continue;
      const t = payload.transcript;
      if (!(Array.isArray(t) && t.length)) continue;
      seen.add(sid);
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs / 1000; } catch { /* 0 sorts last */ }
      rows.push({
        session_id: sid,
        title: displayTitleOf(payload) || 'untitled chat',
        updated_at: String(payload.updated_at || ''),
        created_at: String(payload.created_at || ''),
        entry_count: t.length,
        mtime,
      });
    }
  }
  rows.sort((a, b) => (b.mtime - a.mtime) || String(b.updated_at).localeCompare(String(a.updated_at)));
  return rows.slice(0, limit).map(({ mtime, ...row }) => row);
}

// Where a session payload may be, and nowhere else. The sid is checked against
// SID_RE first: it arrives from the browser, and a `../../` in it would be a
// path, not an id.
function sessionPath(root, projectId, sid) {
  if (!SID_RE.test(String(sid || ''))) return '';
  const candidates = [
    ...sessionDirs(root).map(dir => path.join(dir, `${sid}.json`)),
    path.join(root, 'projects', String(projectId || ''), 'sessions', `${sid}.json`),
  ];
  for (const p of candidates) if (isFile(p)) return p;
  return '';
}

// The session record's own file, for a caller that needs to WATCH it rather
// than read it (server.mjs keeps the drawer's mirror level with the council).
// '' when there is no such session — the same silence sessionTail answers with.
export function sessionFile(root, projectId, sid) {
  return sessionPath(root, projectId, sid);
}

// When that file was last written, in whole milliseconds, or 0. This is the
// whole of the freshness test: the council (TUI or council-web) saves the
// session it is driving, and a page record whose sync mark disagrees with this
// number is a mirror of a conversation that has moved on.
export function sessionMtime(root, projectId, sid) {
  const file = sessionPath(root, projectId, sid);
  if (!file) return 0;
  try { return Math.round(fs.statSync(file).mtimeMs); } catch { return 0; }
}

// The envelope chat.mjs wraps a page-chat question in, taken back off. A chat
// started from the drawer stores what the BOTS were sent — page banner,
// instructions, verbosity line — and replaying that to the reader as their own
// words would be a lie about what they typed. A council chat typed in the TUI
// has no envelope and passes through untouched.
export function stripEnvelope(text) {
  const original = String(text || '').trim();
  let s = original;
  // the route prefix the companion stamps on
  s = s.replace(/^@(?:claude|codex|all)\s+/i, '');
  // the page banner and everything handed over with it, up to its `---` rule
  s = s.replace(
    /^\[(?:web page|project artifact|the page content has been updated)[\s\S]*?\n---\n/,
    '',
  );
  // page chat, then an anchored thread — both end at the instruction line
  const m = /^.*asked about this page:\n([\s\S]*?)\n\nReply in this turn\./.exec(s)
    || /\nand (?:\S+ )?wrote:\n([\s\S]*?)\n\nYour reply text is posted directly/.exec(s);
  if (m) s = m[1];
  // the thread history the envelope carried above the new message
  s = s.replace(/^Earlier in this (?:thread|conversation):\n[\s\S]*?\n\n/, '');
  return s.trim() || original;
}

const SPEAKER_AUTHOR = { claude: 'claude', codex: 'codex' };

// The recent tail of one chat, as drawer messages. `restored:true` marks every
// one of them: they came out of a session file, not out of this companion's
// page record, so they carry no honest timestamp and nothing may offer to edit
// or delete them. Their `ts` is an ADDRESS (`<sid>#<n>`) and deliberately not a
// date — the drawer's `when()` renders nothing for it rather than inventing a
// time the transcript never recorded.
export function sessionTail(root, projectId, sid, limit = TAIL_MAX) {
  const file = sessionPath(root, projectId, sid);
  if (!file) return null;
  const payload = readJson(file, null);
  if (!payload) return null;
  const belongs = String(payload.project_id || '') || indexMap(root)[String(sid)] || '';
  if (String(projectId || '') && belongs !== String(projectId)) return null;
  const entries = Array.isArray(payload.transcript) && payload.transcript.length
    ? payload.transcript
    : (Array.isArray(payload.room_history) ? payload.room_history : []);
  // `user` in a council transcript is whoever runs this companion — the same
  // handle the drawer already puts the reader's own colour on
  const me = String(readConfig().author || 'you');
  const msgs = [];
  entries.forEach((e, i) => {
    if (!e) return;
    const speaker = String(e.speaker || '').toLowerCase().replace(/^@/, '');
    const author = SPEAKER_AUTHOR[speaker.split(/[^a-z]/)[0]]
      || (speaker === 'user' ? me : '');
    if (!author) return;                       // system lines are not messages
    const raw = String(e.text || '');
    if (!raw.trim()) return;
    const text = author === me ? stripEnvelope(raw) : raw.trim();
    if (!text) return;
    msgs.push({ author, ts: `${sid}#${i}`, text, restored: true });
  });
  return {
    session_id: String(payload.session_id || sid),
    title: displayTitleOf(payload) || 'untitled chat',
    updated_at: String(payload.updated_at || ''),
    project_id: belongs,
    msgs: msgs.slice(-limit),
    truncated: msgs.length > limit,
    // renderable messages in the WHOLE chat — what "the last N of TOTAL"
    // honestly means (system lines never counted, before or after the slice)
    total: msgs.length,
  };
}

// --- send review: the fan-out --------------------------------------------
// The reader has been through the draft leaving comments in the margins, the
// way they would in Google Docs or Word. Retyping any of that into the chat is
// work the machine can do, so one button hands the WHOLE review over
// (server.mjs POST /send-review).
//
// It used to go as ONE page-chat turn carrying a digest of every thread, and
// the answer therefore landed in page chat — one lump of prose about twenty
// comments, with nothing connecting any sentence of it to the thread it
// answered. The reason was structural and is documented in SPEC.md: the bridge
// fixes a turn's target when the job is QUEUED (chat.mjs, job.target), so a bot
// cannot choose which thread to reply into and an instruction to "reply in each
// comment's own thread" was an instruction it could not obey.
//
// So the companion chooses instead. A round is now a PREAMBLE turn into page
// chat (so the council's own chat records that a round happened, and any
// cross-comment context rides it) followed by ONE JOB PER OPEN THREAD, each
// queued against THAT THREAD exactly as a directly-tagged thread reply is
// queued today. Everything downstream then falls out of machinery that already
// existed: the reply lands in the thread → store.appendMsg marks it addressed →
// "ready for review" → the "now reads" sentence → re-anchor and track-changes.
//
// A pure function of the page record, deliberately: everything it decides —
// which threads, which order, what gets cut — is testable without a server, a
// bridge or a browser, and there is exactly one copy of the rules.
//
// What goes in:
//   · OPEN threads only. A resolved one is a decision the reader already
//     closed; sending it back would ask the bots to reopen an argument that is
//     over. (Resolution stays the reader's click, in both directions: this
//     turn resolves NOTHING — the bots answer in page chat and the reader
//     files what they are satisfied with, exactly as before.)
//   · in page order as far as page order is knowable. On a paged document
//     (a PDF) each thread stores the page its highlight sits on, so that is
//     the sort key; ties, and every thread on an unpaged HTML artifact, keep
//     RECORD order — which is the order the Comments tab lists them in and the
//     order they were made. The companion has no DOM and cannot know where on
//     an HTML page a highlight really falls, so it does not pretend to.
//   · the quote, then every message in the thread, attributed by author —
//     the bots' own replies included, because a thread where a bot already
//     answered and the reader pushed back is precisely the thread that needs
//     the push-back read.
// The thread cap stays: twenty jobs is already a long round, and past that the
// honest answer is "send review again after these" rather than a queue nobody
// can read the end of. The old 8000-character cap on the WHOLE review is gone —
// it was the size of one turn's digest, and there is no such turn any more; a
// per-thread turn carries one quote and one conversation, which the per-thread
// caps below keep small on their own.
export const REVIEW_THREADS_MAX = 20;
export const REVIEW_QUOTE_MAX = 300;
export const REVIEW_MSG_MAX = 800;
export const REVIEW_MSGS_PER_THREAD = 12;

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};

// What a review sends: the threads that are still WAITING on somebody.
//
// Not resolved (the reader has filed it) and not `addressed` (a bot has
// already replied into it since the reader last wrote there, and it is sitting
// in the drawer's "Ready for review" section waiting to be looked at). Sending
// an addressed thread back would ask the bots to redo work they have already
// reported — and re-sending after a round is exactly what this state is for.
export const openThreads = page => ((page && page.threads) || [])
  .filter(t => t && !t.resolved && !t.addressed && (t.msgs || []).length)
  // a stable sort by page number: Array#sort is stable in every JS engine
  // this runs on, so equal pages keep record order without an index dance
  .slice()
  .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));

// Who a per-thread turn is addressed to.
//
// @all by default: a review of a draft is the room's business. The one exception
// is a thread whose LAST HUMAN message tags exactly one bot — there the reader
// has already chosen who they are talking to in this thread, and a round that
// broadened it back out to the room would overrule them and spend a second
// agent's turn doing it. Bot messages are not read for this (a bot answering
// "@codex, over to you" is not the reader's address) and neither is a `tools`
// line, which is narration.
export function reviewRoute(t) {
  const said = ((t && t.msgs) || []).filter(m => m && m.kind !== 'tools' && !isBotAuthor(m.author));
  const last = said[said.length - 1];
  const p = routePrefix(last && last.text);
  return p === '@claude ' || p === '@codex ' ? p.trim() : '@all';
}

// The round's opening turn, into page chat. Short on purpose: the comments
// themselves are not in it — each one is its own turn — so this says only what
// is about to happen, and what the round expects of a bot. It is what makes the
// council's own chat record that a round took place, and it is where any
// cross-comment context lives (a bot reading comment 7 has the round's terms in
// the session, not just the one comment in front of it).
export function reviewPreamble(sent, omitted = 0) {
  const more = omitted
    ? ` (…and ${omitted} more open comment thread${omitted === 1 ? '' : 's'} did not fit in this `
      + `round — send review again after these.)`
    : '';
  return `Review round: I have been down this draft leaving comments in the margins. `
    + `${sent} comment${sent === 1 ? '' : 's'} follow${sent === 1 ? 's' : ''} this message, `
    + `in page order, one turn each${more}\n\n`
    + `For each one: make the change it calls for (the write rules on this turn say where you may `
    + `write) and say what you changed; where it calls for no change, answer it. Each of those `
    + `turns is posted into that comment's own thread, so reply to the comment in front of you and `
    + `nothing else. Where a change rewrites the passage a comment quotes, quote the new wording `
    + `back verbatim — "done — this passage now reads: “…”" — and where it also changed the draft `
    + `SOMEWHERE ELSE (a cross-reference, a paragraph that now contradicts itself: follow the change `
    + `out, that is wanted), add one line per place: "also changed — this passage now reads: “…”". `
    + `A comment thread is opened at each of those passages so I can review it like any other.\n\n`
    + `Nothing is resolved by any of this — I file the threads myself once I am satisfied.`;
}

// One turn per thread. The thread's own envelope (chat.envelope, target = the
// thread) already carries the quote, the page number and the conversation, and
// already ends with "Your reply text is posted directly into the comment
// thread" — so all this text adds is the one line of round context, and the
// route tag that decides who answers.
function reviewTurn(t, n, total) {
  const msgs = (t.msgs || []).filter(m => m && m.kind !== 'tools');
  const shown = msgs.slice(-REVIEW_MSGS_PER_THREAD);
  const dropped = msgs.length - shown.length;
  const orph = t.orphaned
    ? ` The passage has since been edited out of the page, so quote whatever stands in its place.` : '';
  const cut = dropped > 0
    ? ` (${dropped} earlier message${dropped === 1 ? '' : 's'} in this thread are not shown.)` : '';
  return {
    thread_id: t.id,
    page: Number(t.page) || 0,
    route: reviewRoute(t),
    // clipped here rather than in the envelope: a per-thread turn is small and
    // must stay small, and a reader who pasted four thousand characters into
    // one comment is not asking for four thousand to ride every turn of a round
    quote: clip(t.quote, REVIEW_QUOTE_MAX),
    history: shown.map(m => ({ author: m.author, text: clip(m.text, REVIEW_MSG_MAX) })),
    text: `${reviewRoute(t)} [review round · comment ${n} of ${total}] `
      + `This is part of the review round I just opened in the chat, and this turn is this one `
      + `comment. Work this point through: where it calls for a change, MAKE the change (the `
      + `draft's files are yours to edit — the write rules on this turn say where) and say what `
      + `you changed; where it does not, answer it. If your change rewrites the passage quoted `
      + `above, quote the new wording back verbatim — "done — this passage now reads: “…”"; if it `
      + `also touched the draft elsewhere, add one line per place — "also changed — this passage `
      + `now reads: “…”".`
      + `${orph}${cut}`,
  };
}

// Returns {preamble, turns, sent, omitted, total} — or null when there is
// nothing open to send, which the endpoint turns into a friendly 400 rather
// than an empty round. Pure, so every rule about which threads go, in what
// order, addressed to whom and clipped how is testable without a server, a
// bridge or a browser, and lives in exactly one place.
export function reviewFanout(page, { threadsMax = REVIEW_THREADS_MAX } = {}) {
  const threads = openThreads(page);
  if (!threads.length) return null;
  const total = threads.length;
  const taken = threads.slice(0, threadsMax);
  const omitted = total - taken.length;
  return {
    // …and never a silent truncation: the preamble says how many did not fit,
    // because the reader is looking at the same threads in the Comments tab and
    // would otherwise have no way to know which the bots were never shown.
    preamble: reviewPreamble(taken.length, omitted),
    turns: taken.map((t, i) => reviewTurn(t, i + 1, taken.length)),
    sent: taken.length,
    omitted,
    total,
  };
}
