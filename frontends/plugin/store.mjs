// Page/thread persistence for the web-annotator companion.
// One JSON file per annotated page under <ROOT>/.botference/plugin/pages/,
// plus a small index the extension polls to know which pages have annotations.
// Every write is atomic (tmp + rename), same as the rest of the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sanitizeHandle } from './hosted.mjs';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(PLUGIN, '..', '..');
export const HOME = process.env.BOTFERENCE_HOME || REPO;
export const ROOT = process.env.BOTFERENCE_PROJECT_ROOT || REPO;
export const DIR = path.join(ROOT, '.botference', 'plugin');
const PAGES = path.join(DIR, 'pages');
const SNAPS = path.join(DIR, 'snapshots');
const RUNS = path.join(DIR, 'runs');
const INDEX_FILE = path.join(DIR, 'index.json');
const CONFIG_FILE = path.join(DIR, 'config.json');

// Default vault: the nearest ancestor of the workspace that is an Obsidian
// vault (has .obsidian/), else the home directory — the export folder is
// created inside it either way. Only used to seed config.json on first run;
// an existing config always wins.
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function detectVault() {
  let dir = ROOT;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.obsidian'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return os.homedir();
}

export const DEFAULT_CONFIG = {
  vault_path: detectVault(),
  export_folder: 'Web Clippings',
  author: os.userInfo().username,
  // how long the bots' replies should run; the envelope carries the matching
  // instruction on every turn
  verbosity: 'short',
  // Whether a ```python block in a message may be RUN, here, as this user
  // (run.mjs). One line to switch the whole thing off: no Run button, and
  // POST /run refuses. Default on, and absent in an older config, which
  // therefore reads as on.
  run_python: true,
  // Which model and how hard it thinks, per agent — the reader's standing
  // PREFERENCE, not a report of the live bridge. The bridge is a lazily-spawned
  // child that dies whenever it likes, so a setting that only ever lived inside
  // it could not be chosen before the first message (which is exactly when
  // anyone wants to choose it). These are applied at every wake, and relayed
  // immediately when there is something to relay to.
  //   *_options = the lists the bridge last advertised, cached so the pickers
  //   still work while it sleeps. A cache, never an authority: the bridge
  //   refuses anything it no longer offers.
  agents: {
    model: { claude: null, codex: null },
    effort: { claude: null, codex: null },
    model_options: { claude: [], codex: [] },
    effort_options: { claude: [], codex: [] },
  },
};
export const VERBOSITY_LEVELS = ['short', 'long'];
export const AGENTS = ['claude', 'codex'];

// Every one of these values is interpolated into a slash command written to the
// bridge's stdin (`/model @claude <value>`), and config.json is a file a human
// can edit. So the charset is the security boundary, not a formality: a value
// carrying a newline would post a second command of its own choosing.
const MODEL_RE = /^[\w.-]{1,64}$/;
const EFFORT_RE = /^[\w-]{1,32}$/;
const OPTIONS_MAX = 64;
const cleanPref = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
const cleanList = (v, re) => (Array.isArray(v)
  ? [...new Set(v.filter(x => cleanPref(x, re)))].slice(0, OPTIONS_MAX) : []);

// A hand-edited (or older, or half-written) config must never reach the bridge
// as a command, and must never leave a picker with half a shape to read.
export function normalizeAgents(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  const per = (obj, fn) => {
    const src = (obj && typeof obj === 'object') ? obj : {};
    return Object.fromEntries(AGENTS.map(x => [x, fn(src[x])]));
  };
  return {
    model: per(a.model, v => cleanPref(v, MODEL_RE)),
    effort: per(a.effort, v => cleanPref(v, EFFORT_RE)),
    model_options: per(a.model_options, v => cleanList(v, MODEL_RE)),
    effort_options: per(a.effort_options, v => cleanList(v, EFFORT_RE)),
  };
}

// The controller's session files, resolved exactly as core/paths.py resolves
// work_dir — we delete chats out of that directory when the bridge isn't
// running to be told about it, so guessing wrong would delete nothing (or,
// worse, something else).
export function workDir() {
  if (process.env.BOTFERENCE_WORK_DIR) return process.env.BOTFERENCE_WORK_DIR;
  if (process.env.BOTFERENCE_PROJECT_DIR) return process.env.BOTFERENCE_PROJECT_DIR;
  const projectDir = path.join(ROOT, 'botference');
  if (isDir(projectDir)) return projectDir;
  // ROOT is itself a botference state dir: its sessions/ is the real store
  if (isFile(path.join(ROOT, 'project.json'))) return ROOT;
  const work = path.join(ROOT, 'work');
  return isDir(work) ? work : ROOT;
}
export const sessionFile = sid => path.join(workDir(), 'sessions', `${String(sid)}.json`);

// Hard delete, no archive: the chat ceases to exist. A missing file is a
// success — the caller wanted it gone and it is.
export function deleteSessionFile(sid) {
  if (!sid || /[/\\]/.test(String(sid))) return false;
  try { fs.unlinkSync(sessionFile(sid)); return true; } catch { return false; }
}

const nowIso = () => new Date().toISOString();

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// url identity: no hash, no campaign params, no trailing slash. Two tabs on
// the same article — one arriving from a newsletter link — must land on one
// page file, or half the annotations vanish.
//
// This function is duplicated in the extension (background.js, content.js):
// the content script can't import server code, and the three copies must
// agree exactly or events address pages nobody is looking at. Keep them in
// lockstep — SPEC.md defines the rule.
const STRIP_PARAM = /^(utm_[^=]*|fbclid|gclid)$/i;
export function normUrl(raw) {
  try {
    const url = new URL(String(raw));
    url.hash = '';
    const keep = [];
    for (const [k, v] of url.searchParams) if (!STRIP_PARAM.test(k)) keep.push([k, v]);
    url.search = '';
    for (const [k, v] of keep) url.searchParams.append(k, v);
    let s = url.toString();
    s = s.replace(/\?$/, '');
    if (s.endsWith('/') && !/^[a-z]+:\/\/[^/]+\/$/i.test(s)) s = s.slice(0, -1);
    return s;
  } catch {
    return String(raw || '').split('#')[0];
  }
}
export const pageKey = url => crypto.createHash('sha1').update(normUrl(url)).digest('hex');
export const pageFile = url => path.join(PAGES, `${pageKey(url)}.json`);
export const siteOf = url => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const newThreadId = () =>
  `t-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;

export function readConfig() {
  const cfg = readJson(CONFIG_FILE, null);
  if (!cfg) { writeJson(CONFIG_FILE, DEFAULT_CONFIG); return { ...DEFAULT_CONFIG }; }
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  // a hand-edited config must never make the envelope say something strange
  if (!VERBOSITY_LEVELS.includes(merged.verbosity)) merged.verbosity = DEFAULT_CONFIG.verbosity;
  merged.agents = normalizeAgents(merged.agents);
  return merged;
}

// settings the drawer can change (verbosity, today): merged over what is on
// disk and written atomically like everything else
export function saveConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  writeJson(CONFIG_FILE, cfg);
  return readConfig();
}

// The agents block is two levels deep, and saveConfig's merge is one: patching
// {model:{claude}} through saveConfig would drop codex's preference and both
// cached lists. Everything that touches a preference or a cached list comes
// through here instead.
export function saveAgents(patch) {
  const cur = readConfig().agents;
  const next = { ...cur };
  for (const k of Object.keys(patch || {})) next[k] = { ...cur[k], ...patch[k] };
  return saveConfig({ agents: normalizeAgents(next) }).agents;
}

// --- what kind of document a record is -----------------------------------
// An article, a PDF or a Google Doc. The ADAPTER declares it (content.js sends
// `kind` with every POST /page), because the adapter is the only thing that
// actually knows — a PDF opened in the extension's own viewer is a `pdf`
// whatever its url looks like.
//
// For every record written before this existed there is no adapter to ask, so
// the url answers as best it can: a `.pdf` path is a PDF, a docs.google.com
// document url is a Doc, and everything else is an article — which is the
// honest default rather than a guess, and is corrected the next time the page
// is actually visited (upsertPage stores what the adapter says).
export const PAGE_KINDS = ['article', 'pdf', 'gdocs'];
export const cleanKind = k => (PAGE_KINDS.includes(String(k || '')) ? String(k) : '');
export function inferKind(url) {
  const u = String(url || '');
  if (/^https?:\/\/docs\.google\.com\/(?:u\/\d+\/)?document\//i.test(u)) return 'gdocs';
  if (/\.pdf$/i.test(u.split('#')[0].split('?')[0])) return 'pdf';
  // a local PDF, identified by the hash of its bytes rather than by a path
  // (the extension's `bfp-pdf://sha256/<hex>`) — the adapter always says so on
  // a visit, and this is what answers for a record read without one
  if (/^bfp-pdf:\/\//i.test(u)) return 'pdf';
  return 'article';
}
export const kindOf = page => cleanKind(page && page.kind) || inferKind(page && page.url);

// --- the name the reader gave it -----------------------------------------
// `title` is what the page called itself; `custom_title` is what the reader
// decided to call it, and it wins EVERYWHERE a title is shown or written (the
// rows, the phone, the Obsidian note's H1 and its file name). A revisit still
// refreshes `title` underneath — the scraped name is not wrong, it is just not
// the one being used.
const TITLE_MAX = 200;
export const cleanTitle = t => String(t == null ? '' : t)
  .replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
export const displayTitle = page =>
  (page && (page.custom_title || page.title || page.url)) || '';

// --- tags -----------------------------------------------------------------
// Short free-form strings the reader puts on a page by hand, so an archive can
// be searched the way a person actually remembers things. Normalised once,
// here, on the way in: trimmed, whitespace collapsed, a leading # dropped
// (Obsidian's spelling, not ours), deduped case-insensitively keeping the
// casing of the first one written, and capped in both count and length so a
// page record can never become a tag dump.
export const TAGS_MAX = 12;
export const TAG_MAX = 40;
export function normalizeTags(raw) {
  const list = Array.isArray(raw) ? raw
    : (typeof raw === 'string' ? raw.split(',') : []);
  const out = [];
  const seen = new Set();
  for (const t of list) {
    if (typeof t !== 'string' && typeof t !== 'number') continue;
    const s = String(t).replace(/[\u0000-\u001f]/g, ' ').replace(/^#+/, '')
      .replace(/\s+/g, ' ').trim().slice(0, TAG_MAX).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}
export const tagsOf = page => (Array.isArray(page && page.tags) ? page.tags : []);

// The index is what every list is drawn from, and it is derived state: rows
// written before kinds existed get theirs inferred on the way out, in memory,
// so the filter is right immediately and nothing is rewritten just because
// somebody opened a list. The next save persists it.
export function readIndex() {
  const idx = readJson(INDEX_FILE, {});
  for (const key of Object.keys(idx)) {
    const row = idx[key];
    if (row && typeof row === 'object' && !cleanKind(row.kind)) row.kind = inferKind(row.url);
  }
  return idx;
}

// Reading heals: a thread whose last message was deleted is a highlight that
// opens onto nothing. Records damaged before deletes pruned at the source are
// repaired (and re-indexed) the first time anything touches them.
export function readPage(url) {
  const page = readJson(pageFile(url), null);
  if (!page) return null;
  // a record written before kinds existed answers for itself, in memory: the
  // next save persists it, and a revisit replaces the inference with what the
  // adapter actually says
  if (!cleanKind(page.kind)) page.kind = inferKind(page.url);
  const kept = (page.threads || []).filter(t => (t.msgs || []).length);
  if (kept.length !== (page.threads || []).length) {
    page.threads = kept;
    savePage(page);
  }
  return page;
}

// The guest web view addresses pages by their key (the url is in the record,
// not in the link), so it needs the one lookup the extension never does.
// Goes through readPage so the same healing applies.
export function readPageByKey(key) {
  if (!/^[0-9a-f]{40}$/.test(String(key || ''))) return null;
  const raw = readJson(path.join(PAGES, `${key}.json`), null);
  return raw && raw.url ? readPage(raw.url) : null;
}

// the index is derived state: rewritten from the page record on every save,
// so a hand-deleted page file can never leave a phantom row behind
export function savePage(page) {
  page.updated_at = nowIso();
  writeJson(pageFile(page.url), page);
  const idx = readIndex();
  const tags = tagsOf(page);
  idx[pageKey(page.url)] = {
    url: page.url,
    // the NAME of the page, which is the reader's if they gave it one: every
    // list is drawn from the index alone, so the rename has to be here
    title: displayTitle(page),
    threads: (page.threads || []).length,
    // the pages list badges the ones the bots have a chat about, and only the
    // index is loaded to draw it
    has_session: !!page.session_id,
    // article | pdf | gdocs — what the lists filter by
    kind: kindOf(page),
    // omitted rather than empty: most pages have none, and the index is read
    // on every list draw
    ...(tags.length ? { tags } : {}),
    updated_at: page.updated_at,
  };
  writeJson(INDEX_FILE, idx);
  return page;
}

// --- code-block runs -----------------------------------------------------
// The output of running a ```python block lives in the message that holds the
// block (msg.runs, keyed by the block's ordinal) and its files live in a
// directory of their own. The record points at the directory by run_id, so the
// two are deleted together: replacing a run, deleting the message, deleting the
// thread and deleting the page all come through here.
const safeKey = k => String(k || '').replace(/[^0-9a-f]/gi, '').slice(0, 40);
export const runsDir = key => path.join(RUNS, safeKey(key));
export function runDir(key, runId) {
  if (!/^r-[0-9a-z]{1,16}-[0-9a-f]{6}$/.test(String(runId || ''))) return '';
  return path.join(runsDir(key), String(runId));
}
export function deleteRunDir(key, runId) {
  const dir = runDir(key, runId);
  if (!dir) return false;
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}
// every run_id a list of messages is holding onto — what has to be deleted
// when those messages go
export function runIdsOf(msgs) {
  const ids = [];
  for (const m of (Array.isArray(msgs) ? msgs : [])) {
    for (const r of Object.values((m && m.runs) || {})) if (r && r.run_id) ids.push(r.run_id);
  }
  return ids;
}
export const deleteRuns = (key, ids) => { for (const id of ids || []) deleteRunDir(key, id); };

// A result is written onto the message it belongs to, addressed by block
// ordinal, and REPLACES whatever that block held before (the old directory is
// the caller's to delete). `kind` stays "msg": this is a field, not a new kind
// of message, and a client that has never heard of it sees the message it
// always saw.
export function setRun(msg, blockIndex, result) {
  if (!msg) return null;
  if (!msg.runs || typeof msg.runs !== 'object') msg.runs = {};
  msg.runs[String(blockIndex)] = result;
  return result;
}
export function clearRuns(msg) {
  const ids = msg && msg.runs ? Object.values(msg.runs).map(r => r && r.run_id).filter(Boolean) : [];
  if (msg) delete msg.runs;
  return ids;
}

// The page is gone: its record, its snapshot, every run it holds and its index
// row go together, or the pages list keeps offering a row that opens onto
// nothing.
export function deletePage(url) {
  try { fs.unlinkSync(pageFile(url)); } catch { }
  try { fs.unlinkSync(snapshotFile(pageKey(url))); } catch { }
  try { fs.rmSync(runsDir(pageKey(url)), { recursive: true, force: true }); } catch { }
  const idx = readIndex();
  delete idx[pageKey(url)];
  writeJson(INDEX_FILE, idx);
}

// --- article snapshots ---------------------------------------------------
// A readable copy of the article itself, so the page can be READ (and marked
// up) from a phone that never visited it. One file per page, replaced whole on
// every refresh: this is a cache of someone else's writing, not a version
// history, and the only copy worth keeping is the current one.
export const snapshotFile = key => path.join(SNAPS, `${String(key).replace(/[^0-9a-f]/gi, '')}.html`);

export function saveSnapshot(url, html) {
  fs.mkdirSync(SNAPS, { recursive: true });
  const file = snapshotFile(pageKey(url));
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, String(html));
  fs.renameSync(tmp, file);
  return file;
}

export function readSnapshot(key) {
  try { return fs.readFileSync(snapshotFile(key), 'utf8'); } catch { return ''; }
}

export function snapshotInfo(key) {
  try {
    const st = fs.statSync(snapshotFile(key));
    return { bytes: st.size, captured_at: new Date(st.mtimeMs).toISOString() };
  } catch { return null; }
}

export const hasSnapshot = key => !!snapshotInfo(key);

// The file a PDF on somebody's disk came out of. Only the NAME: a local PDF is
// identified by the hash of its bytes precisely so that its location does not
// matter, and a path would be both wrong tomorrow and nobody else's business.
// It exists because "which of my PDFs is this" is a question a 64-character
// hash cannot answer, and the Obsidian note is where it gets asked.
const FILE_NAME_MAX = 200;
export const cleanFileName = n => String(n == null ? '' : n)
  .replace(/[\u0000-\u001f]/g, ' ')
  // a NAME, never a path: anything shaped like one keeps only its last part
  .split(/[\\/]/).pop()
  .replace(/\s+/g, ' ').trim().slice(0, FILE_NAME_MAX).trim();

export function blankPage({ url, title, site, kind, file_name }) {
  const ts = nowIso();
  const file = cleanFileName(file_name);
  return {
    version: 1,
    url: normUrl(url),
    title: String(title || url || '').trim() || normUrl(url),
    site: site || siteOf(url),
    // what kind of document this is, as the adapter reported it — inferred
    // from the url where nothing said
    kind: cleanKind(kind) || inferKind(url),
    ...(file ? { file_name: file } : {}),
    created_at: ts, updated_at: ts,
    session_id: null,
    threads: [],
    page_chat: [],
  };
}

// POST /page: create the shell or refresh title/site/kind/file_name. Never
// touches threads, page_chat, session_id, the reader's own title or their tags
// — a re-visit must not disturb the conversation, or undo a rename.
export function upsertPage({ url, title, site, kind, file_name }) {
  const page = readPage(url) || blankPage({ url, title, site, kind, file_name });
  if (title) page.title = String(title).trim();
  if (site) page.site = String(site);
  if (!page.site) page.site = siteOf(url);
  // the same bytes opened from a second copy of the file: the same page, and
  // the name it was last opened under is the useful one
  const file = cleanFileName(file_name);
  if (file) page.file_name = file;
  // the adapter is the authority and says so on every visit; an older
  // extension sends nothing and leaves whatever was inferred in place
  const k = cleanKind(kind);
  if (k) page.kind = k;
  else if (!cleanKind(page.kind)) page.kind = inferKind(page.url);
  return savePage(page);
}

// --- rename, and tag ------------------------------------------------------
// Both are the OWNER's edits to a record's metadata (the routes enforce that),
// and both are the whole of what they do: nothing about the conversation, the
// session or the snapshot moves.
//
// An empty title is not an error — it is the way back: the reader's name is
// dropped and the page goes back to calling itself whatever it calls itself.
export function renamePage(url, title) {
  const page = readPage(url);
  if (!page) return null;
  const want = cleanTitle(title);
  page.custom_title = want || null;
  // the session the bots hold for this page is now named something else; the
  // next turn on it renames the chat too (chat.mjs planSteps), and nothing is
  // woken for it here
  return savePage(page);
}

export function tagPage(url, tags) {
  const page = readPage(url);
  if (!page) return null;
  page.tags = normalizeTags(tags);
  return savePage(page);
}

// Every tag in use anywhere, for a picker to complete against. Read off the
// index (one file), never by opening every page record.
export function allTags(idx) {
  const index = idx || readIndex();
  const seen = new Map();
  for (const row of Object.values(index || {})) {
    for (const t of (Array.isArray(row && row.tags) ? row.tags : [])) {
      const k = String(t).toLowerCase();
      if (!seen.has(k)) seen.set(k, String(t));
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// Two pages sharing one botference session is proof of the sid-inheritance
// bug, never a legitimate state: every page gets its own /new chat.
export function pageWithSession(sid, exceptUrl) {
  if (!sid) return null;
  const skip = exceptUrl ? pageKey(exceptUrl) : null;
  for (const key of Object.keys(readIndex())) {
    if (key === skip) continue;
    const p = readJson(path.join(PAGES, `${key}.json`), null);
    if (p && p.session_id === sid) return p.url;
  }
  return null;
}

// ---- the library --------------------------------------------------------
// One conversation about EVERYTHING the reader has annotated, as opposed to
// one page. It is not a special kind of record: it is an ordinary page record
// under a reserved identity, so the index, the event stream, /reply, export
// and delete-page all work on it without knowing it exists.
//
// `bfp:` is a scheme no browser will ever hand a content script, so this can
// never collide with a page somebody actually reads — and normUrl leaves it
// byte-identical (no hash, no query, no trailing slash to strip), which is why
// it is a constant and not a change to normUrl. The extension carries the same
// literal, duplicated exactly as normUrl is and for the same reason.
export const LIBRARY_URL = 'bfp://library';
export const LIBRARY_TITLE = 'Library';
export const isLibrary = u => String(u || '') === LIBRARY_URL || normUrl(u) === LIBRARY_URL;

export const PAGE_CHAT = '__page__';
export const findThread = (page, id) => (page.threads || []).find(t => t.id === id) || null;
// both comment threads and the page chat are "a list of msgs" to every caller
// that appends, edits or deletes — resolve once, here
export function msgsOf(page, threadId) {
  if (threadId === PAGE_CHAT) return page.page_chat;
  const t = findThread(page, threadId);
  return t ? t.msgs : null;
}

// Addressing a message by its timestamp alone is a bug waiting to happen: the
// companion stamps whole milliseconds, and two messages legitimately share one
// — a bot's kind:"tools" summary and the answer it belongs to always do, and
// two quick replies can land in the same tick. So /edit, /tick and /delete may
// send discriminators alongside the ts, and this is the one place they are
// honored:
//   author  narrows to that person's message (sanitized on both sides: a guest
//           handle is stored sanitized, and a client may echo back the raw one)
//   kind    "tools" asks FOR the tool summary; anything else, or nothing at
//           all, prefers the answer beside it — which is the message a reader
//           ever means to edit or tick
// Each filter is a preference, not a requirement: one that would leave nothing
// is skipped, so an older payload that sends neither field resolves exactly as
// it always did. A tie nothing can break goes to the FIRST match and says so
// (ambiguous), leaving the caller free to warn instead of silently guessing.
export function resolveMsg(msgs, { ts, author, kind } = {}) {
  const list = Array.isArray(msgs) ? msgs : [];
  let hits = list.filter(m => m && m.ts === ts);
  if (!hits.length) return null;
  if (hits.length > 1 && author != null && String(author) !== '') {
    const want = sanitizeHandle(author);
    const named = hits.filter(m => sanitizeHandle(m.author) === want);
    if (named.length) hits = named;
  }
  if (hits.length > 1) {
    const wantTools = String(kind || '') === 'tools';
    const byKind = hits.filter(m => (m.kind === 'tools') === wantTools);
    if (byKind.length) hits = byKind;
  }
  return { msg: hits[0], index: list.indexOf(hits[0]), ambiguous: hits.length > 1 };
}

// A page number is part of an anchor, and is not part of finding it.
//
// It exists because a document with pages has them: "p. 12" is half of what a
// quote from a PDF MEANS, in the export and in the reading room alike. It is
// therefore stored beside quote/prefix/suffix and never consulted by locate() —
// re-anchoring is the same whitespace-tolerant text search it has always been,
// and a thread saved before this existed (or made on an ordinary article, which
// has no pages) simply has no `page` field and behaves exactly as before.
const pageNumber = n => {
  // a number, or the string a form POST has no other way to send one as —
  // never an object or an array, which Number() would happily coerce
  if (typeof n !== 'number' && typeof n !== 'string') return 0;
  const v = Number(n);
  return Number.isInteger(v) && v > 0 && v < 1e6 ? v : 0;
};

export function addThread(page, { quote, prefix, suffix, text, author, index, page_number }) {
  const thread = {
    id: newThreadId(),
    quote: String(quote || ''),
    prefix: String(prefix || '').slice(-32),
    suffix: String(suffix || '').slice(0, 32),
    orphaned: false,
    msgs: [{ author, ts: nowIso(), text: String(text || '') }],
  };
  const p = pageNumber(page_number);
  if (p) thread.page = p;
  // the extension knows the page order of its highlights; when it tells us
  // where the new one sits we honor it, otherwise the thread appends
  const at = Number.isInteger(index) && index >= 0 && index <= page.threads.length
    ? index : page.threads.length;
  page.threads.splice(at, 0, thread);
  return thread;
}

// Markdown task-list items, in every marker style a bot might reach for:
// "- [ ]", "* [ ]", "+ [ ]", "1. [ ]", "2) [ ]". Only the box character is ever
// rewritten — indentation, marker, spacing and the item's words come back
// byte-for-byte, because the message being ticked is usually a bot's own reply.
const CHECKBOX_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm;

// index-th checkbox of the message → checked/unchecked. null = no such box.
export function setCheckbox(text, index, checked) {
  const src = String(text || '');
  let n = 0;
  let hit = false;
  const out = src.replace(CHECKBOX_RE, (m, head, box, tail) => {
    if (n++ !== index) return m;
    hit = true;
    return head + (checked ? 'x' : ' ') + tail;
  });
  return hit ? out : null;
}

export function appendMsg(page, threadId, { author, text, ts, kind }) {
  const msgs = msgsOf(page, threadId);
  if (!msgs) return null;
  const msg = { author, ts: ts || nowIso(), text: String(text || '') };
  if (kind) msg.kind = String(kind); // "tools" — a bot's tool-activity summary
  msgs.push(msg);
  return msg;
}
