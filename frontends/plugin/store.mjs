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
  // Which directories on this machine the reader has said are their council
  // (workspace.mjs). Absolute path → true (yes, treat it as mine) or false
  // (asked once, told no, never ask again). A `project.json` beside a `work/`
  // and a `projects/` is a strong hint and not a permission: what hangs off
  // this map is a bridge spawned with that directory as its workspace.
  council_roots: {},
  // Which WEB origins serve those councils — the addresses at which a project
  // artifact reached through the council's own UI (`/files/<rel>`) is still
  // that project's artifact and not an ordinary web page (workspace.mjs).
  // `council_web` and `http://localhost:4187` are trusted without being
  // listed; this is for a council reached over a tunnel under its own
  // hostname, e.g. ["https://council.example.com"]. An origin that is not on
  // the list is an ordinary web page whatever path it serves — that allowlist
  // is the entire trust boundary, so it stays a list of exact origins with no
  // wildcards in it.
  council_web_origins: [],
  // HOW MANY BOT TURNS MAY RUN AT ONCE on ordinary pages (pool.mjs). Each of
  // these is a python bridge with a claude and a codex CLI under it, so the
  // number is a resource decision and not a taste one. `1` is exactly the
  // behaviour that shipped before the pool existed: one queue, one turn, every
  // page waiting on every other. Project-artifact pages are unaffected — their
  // child is per project, and always has been.
  bridge_pool: 3,
  // How long a child beyond the first may sit idle before it is retired. 0
  // never retires one.
  bridge_idle_ms: 15 * 60 * 1000,
};
export const BRIDGE_POOL_MAX = 8;
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
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
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
  // First run writes the defaults out — and then reads them back through the
  // SAME normalization as any other config. Returning the raw defaults here
  // (as this used to) meant an environment override was honoured on every run
  // but the first, which is the run a test's throwaway root always is.
  if (!cfg) writeJson(CONFIG_FILE, DEFAULT_CONFIG);
  const merged = { ...DEFAULT_CONFIG, ...(cfg || {}) };
  // a hand-edited config must never make the envelope say something strange
  if (!VERBOSITY_LEVELS.includes(merged.verbosity)) merged.verbosity = DEFAULT_CONFIG.verbosity;
  merged.agents = normalizeAgents(merged.agents);
  // …and a hand-edited one must never ask for forty bridge children, or for
  // half of one. The env vars are the test escape hatch (PLUGIN_BRIDGE_CMD's
  // precedent) and win, because a test's tmp root has no config to edit.
  merged.bridge_pool = clampInt(process.env.PLUGIN_BRIDGE_POOL ?? merged.bridge_pool,
    1, BRIDGE_POOL_MAX, DEFAULT_CONFIG.bridge_pool);
  merged.bridge_idle_ms = clampInt(process.env.PLUGIN_BRIDGE_IDLE_MS ?? merged.bridge_idle_ms,
    0, 24 * 60 * 60 * 1000, DEFAULT_CONFIG.bridge_idle_ms);
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

// ---- the durable identity of a local PDF: its words -----------------------
// `bfp-pdf://text/<sha256 of the extracted, normalized text>` — the identity
// that survives Adobe Acrobat rewriting the file's bytes on every save. The
// extension computes it (adapters.pdfNormalizedText over the text-layer
// lines); the companion can RECOMPUTE it from a stored snapshot, because the
// snapshot was built from exactly those lines — which is what lets a record
// filed under the old byte-hash identity be adopted even though the file's
// current bytes match nothing the companion ever saw.
export const PDF_TEXT_SCHEME = 'bfp-pdf://text/';
const PDF_TEXT_RE = /^bfp-pdf:\/\/text\/[0-9a-f]{64}$/;
export const isPdfTextUrl = u => PDF_TEXT_RE.test(String(u == null ? '' : u).trim());
const PDF_BYTES_RE = /^bfp-pdf:\/\/sha256\/[0-9a-f]{64}$/;

// A PDF snapshot is `<section><h2>Page N</h2><p>line<br>line</p></section>`
// per page (sanitize.mjs keeps exactly that). Back to the normalized string
// the extension hashed: the h2 page labels are the viewer's chrome and go;
// every other tag is a separator; the three entities our own writers produce
// are unescaped (lt/gt first, amp last, so `&amp;lt;` comes back as the
// literal `&lt;` the document contained); whitespace collapses once, exactly
// as pdfNormalizedText collapses it.
export function snapshotPdfText(html) {
  return String(html || '')
    .replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
export const pdfTextHashOf = text =>
  crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

// hash of one page's snapshot, memoized by mtime: an adoption scan may ask the
// same few snapshots on every miss, and rehashing them each time is waste
const snapHashMemo = new Map();
function snapshotTextHash(key) {
  let st;
  try { st = fs.statSync(snapshotFile(key)); } catch { return ''; }
  const hit = snapHashMemo.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.hash;
  let hash = '';
  try { hash = pdfTextHashOf(snapshotPdfText(fs.readFileSync(snapshotFile(key), 'utf8'))); }
  catch { return ''; }
  snapHashMemo.set(key, { mtimeMs: st.mtimeMs, hash });
  return hash;
}

// A text-identity url with no record: does an old byte-hash record hold the
// same words? Newest first, because the reader's live paper is the one they
// keep touching; the first match is migrated, the rest are never merged (a
// merge is the reader's call, and this must never lose anybody's data). An old
// record WITHOUT a snapshot cannot be matched and is left exactly alone.
function adoptPdfTextRecord(url) {
  const nu = normUrl(url);
  if (!isPdfTextUrl(nu)) return null;
  const want = nu.slice(PDF_TEXT_SCHEME.length);
  const rows = Object.entries(readIndex())
    .filter(([, r]) => r && PDF_BYTES_RE.test(String(r.url || '')))
    .sort((a, b) => String(b[1].updated_at || '').localeCompare(String(a[1].updated_at || '')));
  for (const [key, row] of rows) {
    if (snapshotTextHash(key) !== want) continue;
    return migratePage(row.url, nu);
  }
  return null;
}

// One record moves to a new identity, whole: snapshot and runs first (content
// a half-moved record could still point at), the record and its index row
// next, the old page file and row last — so a crash mid-way leaves at worst a
// duplicate row, never a lost thread. The old identity is kept on
// `prior_urls`, which is what lets the Obsidian export REPLACE the note it
// wrote under the old name instead of minting a " (2)".
function migratePage(fromUrl, toUrl) {
  const page = readJson(pageFile(fromUrl), null);
  if (!page) return null;
  const oldKey = pageKey(fromUrl);
  const prior = Array.isArray(page.prior_urls) ? page.prior_urls : [];
  page.url = normUrl(toUrl);
  page.prior_urls = [...new Set([...prior, normUrl(fromUrl)])];
  try { fs.renameSync(snapshotFile(oldKey), snapshotFile(pageKey(page.url))); } catch { /* no snapshot */ }
  try { fs.renameSync(runsDir(oldKey), runsDir(pageKey(page.url))); } catch { /* no runs */ }
  savePage(page);
  try { fs.unlinkSync(pageFile(fromUrl)); } catch { /* already gone */ }
  const idx = readIndex();
  delete idx[oldKey];
  writeJson(INDEX_FILE, idx);
  return readPage(page.url);
}

// Reading heals: a thread whose last message was deleted is a highlight that
// opens onto nothing. Records damaged before deletes pruned at the source are
// repaired (and re-indexed) the first time anything touches them.
// Reading also ADOPTS: a text-identity local PDF whose record still lives
// under its old byte-hash identity is migrated the first time anything asks
// for it — one-time, automatic, and inside readPage so every caller (the
// endpoints, planSteps, the views, upsertPage) gets it without knowing.
export function readPage(url) {
  let page = readJson(pageFile(url), null);
  if (!page && isPdfTextUrl(url)) page = adoptPdfTextRecord(url);
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
    // the council projects this page is filed under, by id — omitted like
    // tags are, because most pages are filed under none
    ...(projectsOf(page).length
      ? { projects: projectsOf(page).map(p => p.id) } : {}),
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
  // …and the pictures of its pages, which are the same kind of thing the
  // snapshot is and go the same way
  try { deletePageImages(pageKey(url)); } catch { }
  // …and the review's decision log, which is the same kind of thing again: a
  // serialization of this record, worthless the moment the record is gone
  try { deleteDecisionLog(pageKey(url)); } catch { }
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

// --- page images: the half of a document that is not text -----------------
// A PDF reaches the bots as EXTRACTED TEXT, and a figure is not text: the
// reader who highlights a caption and asks what the plot actually shows is
// asking about the one part of the document nothing on this machine ever had.
// So the viewer renders the page — it is drawing that page anyway — and posts
// the picture, and the turn names the file. Both CLIs can open it (claude's
// Read, codex's view_image; both verified against a real image), and reads are
// already pre-allowed, so a named path costs no prompt and no new permission.
//
// One file per PAGE of a document, beside that page's snapshot, replaced whole
// like a snapshot is and deleted with the page. A page image is a CACHE of a
// rendering, never a second copy of the document: the local-PDF promise that
// the bytes are never uploaded is untouched — what crosses is a picture of one
// page, exactly as the snapshot is a copy of the words on it.
const PAGE_IMAGE_EXTS = ['png', 'jpg'];
export const pageImageFile = (key, n, ext = 'png') => path.join(SNAPS,
  `${safeKey(key)}-p${Math.max(1, Math.floor(Number(n) || 0))}.${ext === 'jpg' ? 'jpg' : 'png'}`);

// The path of the image this page HAS, whichever of the two encodings it is
// in, or '' — the one question the envelope asks.
export function findPageImage(key, n) {
  if (!(Number(n) > 0)) return '';
  for (const ext of PAGE_IMAGE_EXTS) {
    const f = pageImageFile(key, n, ext);
    if (isFile(f)) return f;
  }
  return '';
}

// Which pages of this document have a picture, ascending. Read off the
// directory rather than out of the record: an image is a file on disk and
// nothing else, so there is no second place for the truth to live and go stale.
export function pageImagesOf(key) {
  const k = safeKey(key);
  if (!k) return [];
  let names = [];
  try { names = fs.readdirSync(SNAPS); } catch { return []; }
  const re = new RegExp(`^${k}-p(\\d+)\\.(?:png|jpg)$`);
  const out = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Content-keyed, which is the whole of "a re-capture is free": the same page
// rendered again is byte-identical, so the write is skipped and the file keeps
// its mtime. A page that CHANGED (a live PDF re-rendered at a new scale, a
// figure that moved) writes over the old one — this is a cache of the current
// document, not a version history, exactly like a snapshot.
export function savePageImage(url, n, buf, ext = 'png') {
  fs.mkdirSync(SNAPS, { recursive: true });
  const key = pageKey(url);
  const file = pageImageFile(key, n, ext);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const existing = findPageImage(key, n);
  if (existing) {
    try {
      const had = crypto.createHash('sha256').update(fs.readFileSync(existing)).digest('hex');
      if (had === sha) return { file: existing, stored: false, unchanged: true, sha };
    } catch { }
    // the same page in the OTHER encoding is the same page: never leave two
    if (existing !== file) { try { fs.unlinkSync(existing); } catch { } }
  }
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return { file, stored: true, unchanged: false, sha };
}

export function deletePageImages(key) {
  for (const n of pageImagesOf(key)) {
    for (const ext of PAGE_IMAGE_EXTS) {
      try { fs.unlinkSync(pageImageFile(key, n, ext)); } catch { }
    }
  }
}

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

// --- filing a page under council projects ---------------------------------
//
// A page ATTACHED to a project is not the same thing as a project artifact
// page. An artifact LIVES in `projects/<id>/`: the path is its identity, the
// project is its lane, and the bots may write into that folder. A manuscript
// PDF sitting in the reader's Downloads lives nowhere near the council, and
// attaching it says one thing only: *when you talk about this page, you know
// what was said in this project.* Context, not custody.
//
// That is why the shape is a LIST and not a field. The motivating case is a
// second draft of a paper whose first draft was discussed elsewhere; the same
// PDF may sensibly belong to "Adriana's paper" and to "Journal submissions"
// at once, and there is no single project to hand a lane to even if we wanted
// to (see SPEC, "a lane never moves off a live child"). So the lane, the
// bridge and the write scope of an attached page are exactly what they were
// before it was attached, and only the envelope changes.
//
// Store convention (see `mark`, `tags`, `page`): the field is written only
// when it is not the default, so a page that was never filed costs nothing on
// disk and no record needs migrating.
export const ATTACH_MAX = 6;

const cleanRoot = r => String(r == null ? '' : r).trim();
const cleanProjectId = i => String(i == null ? '' : i).trim();

/** Every project this page is filed under, oldest attachment first. */
export function projectsOf(page) {
  const raw = page && page.projects;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const root = cleanRoot(entry.root);
    const id = cleanProjectId(entry.id);
    if (!root || !id) continue;
    const key = `${root}\0${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ root, id, at: String(entry.at || '') });
    if (out.length >= ATTACH_MAX) break;
  }
  return out;
}

/**
 * Attach or detach one project. Returns the saved page, or null if unknown.
 *
 * Idempotent in both directions: attaching twice keeps the first attachment
 * (and its date), detaching something that was never attached is a no-op that
 * still answers with the page, so the drawer can render one result either way.
 */
export function filePageInProject(url, { root, id, attach = true }) {
  const page = readPage(url);
  if (!page) return null;
  const wantRoot = cleanRoot(root);
  const wantId = cleanProjectId(id);
  if (!wantRoot || !wantId) return page;
  const current = projectsOf(page);
  const without = current.filter(p => !(p.root === wantRoot && p.id === wantId));
  let next;
  if (!attach) {
    next = without;
  } else if (without.length === current.length) {
    next = current.concat([{ root: wantRoot, id: wantId, at: nowIso() }]);
  } else {
    next = current;                       // already there; leave the date alone
  }
  if (next.length) page.projects = next.slice(0, ATTACH_MAX);
  else delete page.projects;              // back to costing nothing on disk
  return savePage(page);
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

// ---- comments that were written somewhere else ---------------------------
// ONE STORE OF TRUTH PER PAGE. A comment left in a review page's own margin by
// a visitor with no extension is PROJECTED into this record as an ordinary
// thread, so the owner, the bots, send review, the reading room and the export
// all see one conversation instead of two. `origin` is that comment's address
// in the system it came from — `{system, id}`, nothing else — and it is the
// whole of what makes the projection idempotent: the same review comment
// mirrored a hundred times is one thread.
//
// It is deliberately NOT an authorship field. The author is `msgs[0].author`,
// exactly as it is on a thread somebody dragged out in the drawer, because a
// mirrored comment is a real comment by a real person and not a footnote about
// one. Nothing in the drawer, the export or the digest asks whether a thread
// carries this, and every record written before it reads as native.
// `review` — a comment written in a review page's own margin by a visitor with
// no extension. `pdf-annot` — a comment that was already IN the PDF when the
// reader opened it: an Acrobat highlight, a Preview sticky note, written by
// somebody who has never heard of this companion. Both are the same shape of
// fact ("this comment exists somewhere else, under this id"), and both are
// idempotent for the same reason: the id is the whole of what stops one
// comment being projected twice.
export const ORIGIN_SYSTEMS = ['review', 'pdf-annot'];
export function cleanOrigin(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const system = String(raw.system || '');
  const id = String(raw.id == null ? '' : raw.id)
    .replace(/[^\w.-]/g, '').slice(0, 200);
  if (!ORIGIN_SYSTEMS.includes(system) || !id) return null;
  return { system, id };
}
export const originOf = t => cleanOrigin(t && t.origin);
export const findOrigin = (page, system, id) =>
  (page.threads || []).find(t => {
    const o = originOf(t);
    return o && o.system === system && o.id === id;
  }) || null;
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

// `route` is where the FIRST message of the thread was addressed — '@claude ',
// '@codex ', '@all ' or nothing at all. It is stamped here rather than derived
// from the words later because a reader may now address a message with a pill
// instead of an @-mention, and a pill leaves no trace in the text. See
// server.mjs stickyRoute: this field is what makes the next untagged reply in
// the thread still know who it is talking to.
// ---- a thread's MARK, which is not its state -------------------------------
//
// A thread says something ABOUT a passage; the mark says what was done TO it.
// Two, and only two: `highlight` (the yellow marker — "look at this") and
// `strike` (a thin line through the words — "this should go"). Adobe's pair,
// and the reason the pill on a PDF has two tools rather than one.
//
// ABSENT MEANS HIGHLIGHT. Nothing is written for the ordinary case, so every
// thread made before this existed — and every thread on an ordinary article,
// where there is no second tool — is untouched on disk and reads back exactly
// as it always did. `markOf` is the only thing that should ever ask.
export const cleanMark = m =>
  (String(m == null ? '' : m).trim().toLowerCase() === 'strike' ? 'strike' : '');
export const markOf = t => (t && t.mark === 'strike' ? 'strike' : 'highlight');
// The file's own four text markups, as marks. Acrobat's StrikeOut is the
// obvious one; a Squiggly is a wavy line through the words and means the same
// thing to a reader — "wrong, take it out". Highlight and Underline are both
// "look at this", which is what a highlight is.
export const markForAnnotKind = k => {
  const s = String(k == null ? '' : k).trim();
  return (s === 'StrikeOut' || s === 'Squiggly') ? 'strike' : '';
};

// ---- the mark, changed AFTER the fact --------------------------------------
//
// The reader highlighted a passage, argued about it in the thread, and decided
// it should come out. Nothing about that decision belongs in a NEW comment: the
// thread is already there, already signed, already anchored — the only thing
// that was wrong about it is which of Adobe's two tools it was drawn with.
//
// Because the mark is a plain FIELD and absent means highlight, this is a
// one-key write and every thread ever recorded — including every one made
// before the mark existed — is convertible with no migration at all. Setting it
// back to a highlight DELETES the key rather than writing "highlight", so a
// converted-and-reverted thread is byte-for-byte the record it was.
//
// Returns false when nothing moved, so a caller can skip the save and the
// broadcast: this is idempotent by construction and clicking twice is clicking
// once.
export function setThreadMark(thread, mark) {
  if (!thread) return false;
  const want = cleanMark(mark);           // '' = highlight, 'strike' = strike
  if (want === (thread.mark === 'strike' ? 'strike' : '')) return false;
  if (want) thread.mark = want; else delete thread.mark;
  return true;
}

// ---- a parent and its brood ------------------------------------------------
//
// One discussion, several strikeouts. A thread mints a card per confirmed chip
// and each card links back with `from_thread`, so the brood is DERIVED — there
// is no list on the parent to keep in step, nothing to repair when a card is
// deleted, and a card that changes parents is in the new brood and out of the
// old one by construction. In page order, which is the order the drawer's column
// is in and the order the reader will read them.
export const broodOf = (page, threadId) => (!threadId ? []
  : ((page && page.threads) || []).filter(t =>
    t && markOf(t) === 'strike' && t.from_thread === threadId && t.id !== threadId));

// …and a child CHANGING parents, which is a real thing and not a bug.
//
// Editing a long draft surfaces inconsistencies late: a discussion on page 9
// concludes that the passage struck out of a discussion on page 3 needs
// different wording, and the confirm there is now the reason that mark says what
// it says. The card has exactly ONE parent — the discussion standing behind the
// note it currently carries — so `from_thread` MOVES, the old brood drops it and
// the new one gains it.
//
// What must not be lost is the trace. `prior_threads` is a lineage list, oldest
// first, capped: where this mark has been. Soft, like `from_thread` itself —
// every id in it may dangle, nothing looks them up expecting an answer.
export const PRIOR_THREADS_MAX = 8;
export function adoptStrike(thread, parentId) {
  const want = String(parentId || '');
  const had = String((thread && thread.from_thread) || '');
  if (!thread || !want || had === want) return false;
  if (had) {
    const line = (Array.isArray(thread.prior_threads) ? thread.prior_threads : [])
      .filter(x => x && x !== had && x !== want);
    line.push(had);
    thread.prior_threads = line.slice(-PRIOR_THREADS_MAX);
  }
  thread.from_thread = want;
  return true;
}

// ---- a bot SUGGESTING the strike -------------------------------------------
//
// The same idiom as `file-in:` (workspace.mjs SUGGEST_MARK), for the same
// reason: a bot cannot mark up a document, and should not be able to. It can
// only end a reply with a standalone line, which the companion lifts off the
// words into a field, which the drawer draws as a chip, which the READER
// clicks. Nothing happens on the bot's say-so.
//
// The line is `strike: <the note>`. It is offered ONLY on a document that can
// carry a strikeout (a PDF), only inside a comment thread, and only on a thread
// that is neither struck already nor filed — so a bot that has never been shown
// the offer has no way to learn the convention and no reason to.
export const STRIKE_MARK = 'strike:';

// How long a note may be. Generous ON PURPOSE, and the reason is the bug it
// closes: the note is not always a reason, it is often the REPLACEMENT WORDING
// in full, and a replacement sentence with a citation in it runs to a couple of
// hundred characters before it has said anything. The old cap was 200 and it
// CUT, silently, mid-word — the reader minted a strikeout whose note ended
// "…which extends their stiff/flexibl" and was then told by the bot to paste
// the rest in by hand, which is the exact clerical work this feature exists to
// abolish. Nothing here truncates any more: over the cap the suggestion is
// REFUSED at the lift, loudly, so the bot writes a shorter one (see
// `strikeNoteFault`).
export const STRIKE_NOTE_MAX = 1200;

// How many suggestions ONE reply may carry.
//
// It was one, silently, because `parseStrikeSuggestion` took the last line and
// threw the rest away — and that was wrong for the ordinary shape of this work.
// A discussion about a paragraph concludes that three things have to change, in
// three places, and a thread can only ever mint one card for its own quote. So a
// reply may now end with up to three `strike:` lines, each self-contained, each
// about a DIFFERENT passage; each confirmed chip mints its own card and all of
// them hang off the same discussion.
//
// Three, because the reader chose three: enough for "the phrase, the citation
// and the sentence after it", few enough that a wall of chips is not what a
// reply looks like. Further replies may carry three more — the cap is per reply,
// not per conversation.
export const STRIKE_PER_REPLY_MAX = 3;

// …and how many entries one message keeps at all, refusals included. A model
// that ignores the cap gets its first three as buttons and the next few as
// visible refusals; past that the reply is not a suggestion any more.
export const STRIKE_ENTRY_MAX = 6;

// The line that names a suggestion's OWN passage, directly above its `strike:`.
//
// The failure, from the reader's manuscript: they highlighted "nflatable-arm" —
// missing the leading letter, and stopping short of the words either side — and
// the discussion concluded the whole phrase should read "The inflatable-arm
// literature". The bot REFUSED to suggest anything, telling the reader to go and
// re-highlight the full wording. That is the clerical work this feature exists
// to abolish, done to the one person who should never have to do it.
//
// A bot can see the page. If the highlight is short by a letter, or by a word at
// each end, it can say so exactly: `passage: <the full wording, copied>`. The
// companion locates it, checks it, and the confirmed chip mints a card anchored
// THERE rather than on the reader's partial selection.
export const PASSAGE_MARK = 'passage:';
export const PASSAGE_MIN = 4;          // shorter than this locates nothing useful

// …and WHICH PAGE that wording is on, when it is not this one.
//
// The failure, from the reader's manuscript again: a discussion on page 13
// concluded that the scope sentence belonged in Section 1, which is on page 2.
// The bot could not say so — a `passage:` had to sit on the thread's own page —
// so it refused, and told the reader to go and make the change on page 2
// themselves. That is the same clerical hand-off `passage:` exists to abolish,
// one page further out.
//
// A `page: <N>` line, directly above the `strike:` it belongs to and binding
// forward exactly as `passage:` does, moves the search to page N of THIS
// document. Nothing else moves: the wording must still locate on that page,
// exactly once, and outside every other mark on it. What the reader gets is
// still a button, and the card it mints is an ordinary strikeout anchored on
// page N. A `page:` with no `passage:` beside it names a page and no words, and
// is refused rather than guessed at.
export const PAGE_MARK = 'page:';

// The invitation, as it rides the turn (server.mjs summon → chat.mjs envelope).
//
// Two things it has to get across, and models will fight both:
//
//  · RARELY. An eager model proposes a deletion whenever it can think of one,
//    and a chip on every reply is a chip nobody reads.
//  · THE NOTE STANDS ALONE. This is the amendment of 2026-08-27 and it comes
//    from a real session: the bot put the whole replacement wording in its
//    reply and made the `strike:` line a POINTER to it — "replace with the
//    wording above naming Shan [X]". The note is copied onto the document and
//    read by someone who has only the struck passage and that one line; the
//    discussion it points at is the very thing the reader deletes next. So a
//    deictic note is a note that will be meaningless within the minute, and the
//    companion refuses it rather than minting it.
//
// Which is why the "one short reason" phrasing had to go: a full replacement
// sentence is not verbose, it is the payload. Length is bounded by the note
// cap, not by a request to be brief.
export const strikeOfferBlock = () =>
  'This document takes markup, and this comment is a highlight on it. If — and '
  + 'ONLY if — the discussion in this thread has genuinely concluded that the '
  + 'quoted passage should come out of the document, you may END your reply with '
  + `a line of its own reading \`${STRIKE_MARK} <the note>\`. The reader gets a `
  + 'button that strikes the passage through under their own name; you are not '
  + 'marking anything up.\n'
  + 'THE NOTE MUST STAND ON ITS OWN. It is copied onto the document, and the '
  + 'person who reads it — a co-author, weeks from now — sees ONLY the struck '
  + 'passage and that one line. They never see this conversation; the reader '
  + 'deletes it as soon as the mark is made. So the note may not point at '
  + 'anything here: not "the wording above", not "as discussed", not "my '
  + 'earlier suggestion". A note that does is REFUSED and no button appears.\n'
  + 'If you are proposing REPLACEMENT WORDING, the note carries that wording IN '
  + `FULL and in quotes — \`${STRIKE_MARK} replace with: "…the complete new `
  + 'sentence, citations and all…"` — however long that makes the line. '
  + 'Otherwise the note is the reason itself, in one sentence. Say the whole of '
  + `what you mean and nothing more; over ${STRIKE_NOTE_MAX} characters is `
  + 'refused rather than cut.\n'
  + `MORE THAN ONE CHANGE IS ALLOWED. If the discussion has concluded that `
  + `several separate places need changing, write up to ${STRIKE_PER_REPLY_MAX} `
  + `\`${STRIKE_MARK}\` lines in one reply — each about a DIFFERENT passage and `
  + 'each standing entirely on its own, because each becomes its own mark on the '
  + 'document. Two lines about the SAME passage are two opinions about one mark, '
  + 'not two changes, and only one of them can ever be taken. A later reply may '
  + 'carry more.\n'
  + 'IF THE HIGHLIGHT IS INCOMPLETE, NAME THE PASSAGE YOURSELF. Never ask the '
  + 'reader to go back and re-highlight: put a line reading '
  + `\`${PASSAGE_MARK} <the full exact wording as it appears on the page>\` `
  + `DIRECTLY ABOVE the \`${STRIKE_MARK}\` line it belongs to, and the mark is `
  + 'made there instead of on the partial selection. The same line is how you '
  + 'reach a second place on this page. Copy the wording character for character '
  + 'from the page, including the punctuation; it must occur exactly ONCE on this '
  + 'page and must not run across part of another mark already on it. If it '
  + 'cannot be found, or is found twice, the suggestion is refused and no button '
  + 'appears.\n'
  + 'THE MARK COVERS THE CHANGING WORDS, EXACTLY. A strikeout means "these '
  + 'words come out", so it must cover the words that are actually changing and '
  + 'not one word more. If only a spelling changes, strike the word: '
  + `\`${PASSAGE_MARK} stabilize\`, not the clause it sits in. Neighbouring words `
  + 'that SURVIVE the change must stay outside the mark — striking them tells '
  + 'the co-author they were deleted, and they were not. Widening is right only '
  + 'when the replacement genuinely rewrites those words too.\n'
  + 'DO NOT WIDEN TO BE UNAMBIGUOUS. If the changing words alone occur more than '
  + 'once on the page, that is not your problem to solve by taking in the words '
  + 'either side: this companion anchors the mark with the text around wherever '
  + 'it lands, and where a word occurs twice it takes the occurrence NEAREST the '
  + 'passage under discussion. Name the words that change, and no others.\n'
  + 'A CHANGE ON ANOTHER PAGE NAMES THAT PAGE. A discussion here may conclude '
  + 'that something has to change elsewhere in the document — the definition '
  + 'belongs in Section 1, the sentence duplicates one on page 2. Say so with a '
  + `\`${PAGE_MARK} <N>\` line beside the \`${PASSAGE_MARK}\` line, both directly `
  + `above their \`${STRIKE_MARK}\` line, and the mark is made on page N. NEVER `
  + 'tell the reader to go and highlight it themselves on the other page: that '
  + 'is the clerical work this exists to abolish, and a page number is all it '
  + 'takes to avoid it. The wording must still be copied exactly from page N, '
  + `occur once there, and sit clear of that page's other marks. A \`${PAGE_MARK}\` `
  + `line with no \`${PASSAGE_MARK}\` beside it names nowhere and is refused.\n`
  + 'Use it rarely — a disagreement or a question is NOT this. Say nothing at '
  + 'all if in doubt.\n';

// …and what the bot is told when a line of its own was thrown away, on the next
// turn of that thread (server.mjs summon). Without it the model has no way to
// know: the chip simply never appeared, and the reader — who watched it not
// appear — gets told the deletion was made. Silence here is how a bot ends up
// claiming a fix that never happened.
//
// Six faults now, in two families. The first two are about the NOTE (deictic,
// long); the other four are about the PASSAGE a suggestion named for itself —
// which the companion locates in the page's own text before it will let a mark
// be made there, because a mark that landed on the wrong words would be made in
// the reader's name on a file they hand to somebody else.
// `pageNo` is the page the suggestion NAMED for itself, where it named one: the
// refusal has to say which page was searched, or a bot told "it is not on this
// page" about a page it never meant learns nothing at all.
export const strikeFaultWhy = (fault, phrase, pageNo) => {
  const q = phrase ? ` (“${phrase}”)` : '';
  const n = Number(pageNo) > 0 ? Number(pageNo) : 0;
  const where = n ? `page ${n}` : 'this page';
  switch (fault) {
    case 'pageless':
      return `a \`${PAGE_MARK}\` line names where to look and nothing to look for — `
        + `it has to travel with a \`${PASSAGE_MARK}\` line carrying the exact wording `
        + `on that page`;
    case 'long':
      return `the note ran past ${STRIKE_NOTE_MAX} characters, and this companion `
        + 'will not cut a note in half and put half of it on a document';
    case 'capped':
      return `there were more than ${STRIKE_PER_REPLY_MAX} suggestions in one reply, `
        + 'and this one was past the limit';
    case 'unlocatable':
      return `the \`${PASSAGE_MARK}\` wording${q} is not on ${where} — it has to be `
        + 'copied from the page character for character';
    case 'offpage':
      return n
        ? `the \`${PASSAGE_MARK}\` wording${q} is somewhere in this document but not `
          + `on ${where}, which is the page your \`${PAGE_MARK}\` line named`
        : `the \`${PASSAGE_MARK}\` wording${q} is on a different page of this `
          + `document from the passage under discussion — say which with a `
          + `\`${PAGE_MARK}\` line if you meant it`;
    case 'ambiguous':
      return `the \`${PASSAGE_MARK}\` wording${q} occurs more than once on ${where} `
        + 'and the passage under discussion is no nearer one than the other, so '
        + 'there is no telling which you meant — name the changing words together '
        + 'with enough of what they change INTO, never a wider span of the page';
    case 'covered':
      return `the \`${PASSAGE_MARK}\` wording runs across part of another mark `
        + `already on ${where}${q}, whose text is not yours to re-cover`;
    default:
      return 'it pointed back at this discussion instead of standing on its own';
  }
};
export const strikeRefusedBlock = (fault, phrase = '', pageNo = 0) =>
  'YOUR LAST `strike:` LINE WAS REFUSED — the reader never saw a button for it, '
  + `because ${strikeFaultWhy(fault, phrase, pageNo)}. `
  + 'Nothing was marked up and nothing was filed. If you still mean it, write '
  + 'the line again with the whole of what you mean inside it — the complete '
  + 'replacement wording, in quotes — and say nothing that refers to this '
  + `conversation. Where the fault was the \`${PASSAGE_MARK}\` line, quote the `
  + 'wording again exactly as the page has it, once, and inside no other mark.\n';

// …and the line, back out of the reply. A line of its own, the LAST one counts,
// and a reason is required — a bare `strike:` is a model echoing the convention
// rather than concluding anything, and a chip with no sentence on it gives the
// reader nothing to agree with.
//
// The markdown a model wraps the line in is peeled off the ENDS only. It used
// to be stripped from the whole line, which was fine for "it repeats section 2"
// and quietly mangled a replacement sentence with an emphasised title or a
// snippet in it.
//
// EXPORTED, because two other parsers had grown their own copy of the whole-line
// strip and neither had heard about the fix: `workspace.parseSuggestion` and
// `questions.parseQuestionOffer` both peeled `` ` ``, `*` and `_` out of the
// middle of the line, so a `file-in:` or `question:` reason that quoted a
// filename in backticks or emphasised a title lost the markup before the reader
// ever saw it. One spelling now, here, beside the rule it implements.
//
// Three passes, in this order, because a model writes the two decorations in
// either order: `**strike: …**` wraps the bullet, `- \`strike: …\`` is wrapped
// by it. Unwrap what is paired, take the bullet off, unwrap what the bullet was
// hiding. (It used to be bullet-then-unwrap only, which left the closing `**`
// of a bold marker line stuck to the last word.)
const unpair = s => s.replace(/^([`*_]+)([\s\S]*?)\1$/, '$2').trim();
export const unwrapLine = raw =>
  unpair(unpair(String(raw).trim()).replace(/^[-*>\s]+/, '').trim());

// ALL of them, in the order the bot wrote them.
//
// A reply may carry several suggestions (STRIKE_PER_REPLY_MAX), because one
// discussion routinely concludes that two or three separate places have to
// change and a thread can only ever mint one card for its own quote. Each hit
// carries the lines it was made of, so the server can lift ALL the machinery
// off the reply's words and leave the prose.
//
// A `passage:` line binds FORWARD, to the next `strike:` line: it reads as a
// heading over the change it introduces ("in this wording — do this"), which is
// the order a model writes it in anyway, and forward binding means a stray
// `passage:` with nothing after it simply names nothing rather than silently
// re-aiming the suggestion above it. It still comes off the words: it is
// machinery either way.
// A `page:` line binds forward the same way and to the same `strike:`, and may
// stand on either side of the `passage:` it travels with — a model writes the
// two in whichever order reads best to it, and they mean one thing together.
export function parseStrikeSuggestions(text) {
  const re = new RegExp(`^${STRIKE_MARK}\\s*(.+)$`, 'i');
  const pre = new RegExp(`^${PASSAGE_MARK}\\s*(.+)$`, 'i');
  const pg = new RegExp(`^${PAGE_MARK}\\s*(.+)$`, 'i');
  const hits = [];
  let pending = null;
  const held = () => (pending || (pending = { passage: '', page: 0, lines: [] }));
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = unwrapLine(raw);
    const p = pre.exec(line);
    if (p) {
      const passage = String(p[1] || '').replace(/^[—:-]\s*/, '').trim()
        .replace(/^["“”«»„`]([\s\S]*)["“”«»„`]$/, '$1').trim();
      const h = held();
      h.passage = passage;
      h.lines.push(raw);
      continue;
    }
    const g = pg.exec(line);
    if (g) {
      // "p. 13", "13", "page 13 (Section 1)" — the number is what is meant, and
      // a line with no number in it names no page and is machinery all the same
      const n = Number((/(\d+)/.exec(String(g[1])) || [])[1]) || 0;
      const h = held();
      h.page = n > 0 ? n : 0;
      h.lines.push(raw);
      continue;
    }
    const m = re.exec(line);
    if (!m) continue;
    const why = String(m[1] || '').replace(/^[—:-]\s*/, '').trim();
    if (!why) { pending = null; continue; }
    hits.push({
      why,
      passage: (pending && pending.passage) || '',
      page: (pending && pending.page) || 0,
      line: raw,
      lines: pending ? [...pending.lines, raw] : [raw],
    });
    pending = null;
  }
  // a `passage:` or a `page:` that named nothing is still machinery and still
  // comes off the reply's words
  if (pending) hits.orphanLines = pending.lines;
  return hits;
}

// The LAST one, which is what everything wanted back when a reply could only
// carry one. Kept for the callers that genuinely want a single answer (and for
// the record's own back-compatibility); the lift reads them all.
export function parseStrikeSuggestion(text) {
  const hits = parseStrikeSuggestions(text);
  if (!hits.length) return null;
  const last = hits[hits.length - 1];
  return { why: last.why, line: last.line, ...(last.passage ? { passage: last.passage } : {}),
    ...(last.page ? { page: last.page } : {}) };
}

// Every strike suggestion a message carries, old records included. A reply
// written before this amendment has ONE, under `strike`; one written since has
// a list under `strikes`. Nothing on disk migrates — this is the only thing
// that should ever ask.
export const strikesOf = msg => (Array.isArray(msg && msg.strikes)
  ? msg.strikes.filter(s => s && s.why)
  : (msg && msg.strike && msg.strike.why ? [msg.strike] : []));

// ---- …and the two ways a note can be unusable ------------------------------
//
// DEICTIC: the note refers to something the reader of the DOCUMENT will never
// see — this thread, this reply, the paragraph the bot wrote above the line.
// The patterns are word-boundary and narrow on purpose. A false positive costs
// the reader a chip they wanted, so nothing here fires on a bare "above" or a
// bare "earlier": "the paragraph above already says this" is about the
// DOCUMENT, is perfectly readable beside the struck passage, and passes. What
// is caught is a referring noun (wording, version, suggestion, reply…) pointing
// somewhere — and only when the note carries no quoted span, because a note
// that contains the actual words is self-contained however it introduces them.
const STRIKE_REFERENT =
  '(?:wording|phrasing|text|version|sentence|rewrite|replacement|draft'
  + '|suggestion|proposal|edit|revision|note|answer|reply|comment|message)';
export const STRIKE_DEICTIC = [
  new RegExp(`\\b(?:the|my|our|that|this)\\s+(?:\\w+\\s+){0,2}${STRIKE_REFERENT}s?`
    + '\\s+(?:above|below|earlier|here|i\\s+(?:gave|wrote|sent|suggested|proposed))\\b', 'i'),
  new RegExp(`\\b(?:my|our)\\s+(?:earlier|previous|last|first|original|other)\\s+`
    + `${STRIKE_REFERENT}s?\\b`, 'i'),
  /\bas\s+(?:discussed|agreed|noted|said|stated|explained|described|mentioned|suggested|proposed|above|below)\b/i,
  /\bas\s+(?:i|we)\s+(?:said|noted|wrote|discussed|suggested|proposed|mentioned|explained)\b/i,
  /\b(?:see|per|use|follow|apply|take)\s+(?:my|the|this)\s+(?:\w+\s+){0,2}(?:above|below|suggestion|wording|reply|answer|comment|thread|proposal|rewrite)\b/i,
  /\b(?:this|the)\s+(?:thread|discussion|conversation|exchange)\b/i,
  /\breplace\s+(?:it|this|them|the\s+\w+)?\s*with\s+(?:the|my)\s+(?:\w+\s+){0,2}(?:above|below|suggested|suggestion)\b/i,
];
// The words themselves, in any of the quote marks a model actually reaches for.
// Eight characters is the floor: `"x"` is a scare quote, not a replacement.
const STRIKE_QUOTED = /["“”«»„`][^"“”«»„`]{8,}["“”«»„`]/;
export const strikeNoteQuotes = why => STRIKE_QUOTED.test(String(why || ''));

// The one answer both faults come back through: '' (usable), 'deictic' or
// 'long'. The offending phrase rides with the deictic one so the drawer can
// show the reader WHAT was refused and the bot can be told the same thing.
export function strikeNoteFault(why) {
  const s = String(why || '');
  if (s.length > STRIKE_NOTE_MAX) return { fault: 'long', phrase: '' };
  if (!strikeNoteQuotes(s)) {
    for (const re of STRIKE_DEICTIC) {
      const m = re.exec(s);
      if (m) return { fault: 'deictic', phrase: m[0].trim() };
    }
  }
  return { fault: '', phrase: '' };
}

// ---- the OTHER marks on the same passage -----------------------------------
//
// The bug this closes, reported on a real manuscript: a sentence carrying three
// marks — two struck, one still being discussed — and the bot answering the
// third one proposes a replacement that swallows the words the other two
// already cover. It is not disobedience. The turn it was given said what THIS
// thread quotes and nothing whatever about the rest of the sentence, so the
// model rewrote the sentence it could see, which is the only sentence it had.
//
// So the turn now carries the neighbours: the other threads whose quotes sit on
// or beside this one, each with its KIND (a strikeout is a suggested deletion
// already agreed; a highlight is a conversation) and its state (open or filed),
// nearest first. The bot is not asked to do anything about them — quite the
// opposite: knowing they exist is what lets it keep its hands off their text.
//
// NEAR, defined so that it can be computed here and tested without a browser:
//
//   · same anchor page (a PDF thread stores its page; 0 means unpaged), and
//   · in the page's snapshot text, the two spans OVERLAP or lie within
//     NEARBY_CHARS of each other — a couple of sentences, not a section.
//
// Where there is no snapshot, or a quote no longer matches the text under it (a
// rewritten passage, an orphan), the fallback is the anchors themselves: a
// neighbour counts when its quote falls inside this thread's prefix+quote+suffix
// window or vice versa. That is a 32-character horizon rather than 240, so it
// under-reports rather than inventing neighbours that are not there.
export const NEARBY_MAX = 6;             // neighbours listed on one turn
export const NEARBY_QUOTE_MAX = 160;     // chars of each neighbour's quote
export const NEARBY_LIST_MAX = 1200;     // chars of the list itself
export const NEARBY_CHARS = 240;         // how far away is still "beside it"

const fold = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// One page of a PDF snapshot as plain text (`snapshotPdfText` folds the whole
// document; a paged thread only wants its own page, or a quote that also occurs
// on page 4 would drag page 4's marks into a turn about page 7). Page 0 — an
// article, an unpaged thread — is the whole snapshot.
export function snapshotPageText(html, n) {
  const s = String(html || '');
  if (!(Number(n) > 0)) return snapshotPdfText(s);
  const re = /<section\b[^>]*>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = re.exec(s))) {
    const head = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(m[1]);
    const num = head ? Number((/(\d+)/.exec(head[1]) || [])[1]) : NaN;
    if (num === Number(n)) return snapshotPdfText(m[1]);
  }
  return '';
}

// Where a thread's quote sits in that text. Prefix first: a short quote ("the
// model") occurs a dozen times on a page, and the 32 characters before it are
// exactly what the anchor kept in order to tell those dozen apart.
function locateQuote(text, t) {
  const q = fold(t && t.quote);
  if (!q || !text) return -1;
  const pre = fold(t && t.prefix);
  if (pre) {
    const i = text.indexOf(pre + q);
    if (i >= 0) return i + pre.length;
    const j = text.indexOf(`${pre} ${q}`);
    if (j >= 0) return j + pre.length + 1;
  }
  return text.indexOf(q);
}

const nearbyKindOf = t => {
  const kind = markOf(t) === 'strike'
    ? (t && t.from_thread ? 'strikeout, minted from a discussion' : 'strikeout — a suggested deletion')
    : 'highlight';
  return `${kind}; ${t && t.resolved ? 'filed' : 'open'}`;
};

// [{ thread, dist }], nearest first. Pure: `text` is the page text to measure
// in, and '' is a perfectly good answer (the fallback takes over).
export function nearbyMarks(page, thread, text = '') {
  const mine = fold(thread && thread.quote);
  if (!mine) return [];
  const pageNo = Number(thread.page) || 0;
  const at = locateQuote(text, thread);
  const myEnd = at >= 0 ? at + mine.length : -1;
  const myWindow = fold(`${thread.prefix || ''} ${thread.quote} ${thread.suffix || ''}`);
  const out = [];
  for (const t of (page && page.threads) || []) {
    if (!t || t === thread || t.id === thread.id) continue;
    if ((Number(t.page) || 0) !== pageNo) continue;
    const q = fold(t.quote);
    if (!q) continue;
    let dist = null;
    if (at >= 0) {
      const i = locateQuote(text, t);
      if (i >= 0) {
        dist = i >= myEnd ? i - myEnd
          : (i + q.length <= at ? at - (i + q.length) : 0);   // 0 = they overlap
      }
    }
    if (dist === null) {
      const win = fold(`${t.prefix || ''} ${t.quote} ${t.suffix || ''}`);
      if (myWindow.includes(q) || win.includes(mine)) dist = 0; else continue;
    }
    if (dist > NEARBY_CHARS) continue;
    out.push({ thread: t, dist });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

// …and the block, as it rides the turn (server.mjs summon → chat.mjs envelope).
// The list is capped and the closing sentence is appended AFTER the cap, so the
// one line that matters most can never be the line that gets clipped off.
export function nearbyMarksBlock(page, thread, text = '') {
  const near = nearbyMarks(page, thread, text);
  if (!near.length) return '';
  const shown = near.slice(0, NEARBY_MAX);
  const list = shown
    .map(({ thread: t }) => `- ${nearbyKindOf(t)}: "${fold(t.quote).slice(0, NEARBY_QUOTE_MAX)}"`)
    .join('\n')
    .slice(0, NEARBY_LIST_MAX);
  const more = near.length - shown.length;
  return 'OTHER MARKS ON THIS SAME PASSAGE. Yours is not the only mark here — these '
    + 'other comment threads sit on or beside the passage you were given, nearest first, '
    + 'and the words each one quotes are already covered by its own mark:\n'
    + `${list}\n`
    + (more ? `(…and ${more} more nearby, not listed.)\n` : '')
    + 'Leave their text alone: do not restate it, re-cover it, or fold it into a wording '
    + 'of your own. A suggestion that swallowed one of them would apply the same edit twice.\n';
}

// ---- the passage a SUGGESTION named for itself -----------------------------
//
// `passage:` (PASSAGE_MARK) overrides the thread's own quote for the card a
// confirmed chip mints. It exists because of a real refusal: the reader
// highlighted "nflatable-arm", the discussion concluded the phrase should read
// "The inflatable-arm literature", and the bot told them to go and re-highlight
// it properly. The bot can see the page; it can say which words it means.
//
// This is the check, and it is strict, because the mark it authorises is made
// in the READER'S name on a file they send to a co-author:
//
//   · the wording must be found in the page's own snapshot text, on the SAME
//     PAGE as the thread (found elsewhere in the document → `offpage`, found
//     nowhere → `unlocatable`, no snapshot → `unlocatable`, because a span this
//     companion cannot locate is a span it must not anchor);
//   · exactly once (`ambiguous` otherwise — a phrase that occurs twice on a page
//     names neither of them);
//   · and it may not run across PART of another mark already on this page
//     (`covered`). That is the span-discipline rule of 2026-08-26 enforced
//     mechanically for the first time: a suggestion may not re-cover text
//     somebody else's mark owns. Landing on exactly the same span is not
//     covering it — that is the adoption path, and /strike-from handles it.
//
// DISJOINT IS ALLOWED, deliberately: the passage need not overlap the thread's
// quote, only sit on its page. The whole point of several suggestions in one
// reply is that one discussion concludes several separate places must change,
// and a rule that every passage must touch the highlight would leave that
// promise unkeepable. What makes it safe is not overlap but consent — the chip
// shows the reader the exact wording before they click, nothing is marked up
// until they do, and `covered` stops the one case consent cannot cover, which
// is a mark landing half-across somebody else's.
//
// Returns { fault, phrase, anchor }. `anchor` is the corrected quote with 32
// characters of context each side, cut from the page text itself — the same
// shape the extension computes for a hand-drawn highlight.
//
// WHERE IT LOOKS (2026-08-29). `wantPage`, when given, moves every one of those
// checks onto that page of this document instead of the thread's own. One
// discussion legitimately concludes changes on several pages — the reader's
// page-13 thread deciding that the scope sentence belongs in Section 1, on page
// 2 — and the old rule refused it and sent the reader off to make the change by
// hand. Nothing is relaxed: the wording must locate on the NAMED page, once,
// clear of that page's other marks, and the anchor is cut from that page's text
// so the card lands where the words actually are.
export function resolvePassage(page, thread, passage, html, wantPage) {
  const want = fold(passage);
  const named = Number(wantPage) > 0 ? Number(wantPage) : 0;
  if (!want) {
    // a page named with no wording is a pointer at a page and nothing else:
    // there is nothing on it to mark, and guessing is not on offer
    if (named) return { fault: 'pageless', phrase: String(named), anchor: null };
    return { fault: '', phrase: '', anchor: null };
  }
  if (want.length < PASSAGE_MIN) {
    return { fault: 'unlocatable', phrase: want, anchor: null, page: named };
  }
  const n = named || Number(thread && thread.page) || 0;
  const text = snapshotPageText(html, n);
  const hits = [];
  for (let i = text ? text.indexOf(want) : -1; i >= 0; i = text.indexOf(want, i + 1)) hits.push(i);
  if (!hits.length) {
    const whole = snapshotPdfText(html || '');
    return { fault: whole && whole.includes(want) ? 'offpage' : 'unlocatable',
      phrase: want.slice(0, 80), anchor: null, page: named };
  }
  // TWO MATCHES, AND THE DISCUSSION KNOWS WHICH (2026-08-29).
  //
  // The reported habit this exists to break: asked to change one word, a bot
  // proposes striking the whole clause round it — "can stabilize the" for a
  // change to "stabilise" — because a bare word occurs twice on the page and
  // widening was the only way it knew to be unambiguous. The reader was typing
  // "only suggest changes at the word level" into the chat by hand.
  //
  // It never needed to widen. A suggestion is made INSIDE a discussion, and the
  // discussion is anchored somewhere on this page; the occurrence the reader
  // means is the one beside the words they are talking about. So where the
  // wording occurs more than once, the thread's own anchor breaks the tie and
  // the NEAREST occurrence wins — and the prefix/suffix are then cut from that
  // occurrence's own neighbourhood, so the mark is unambiguous however short
  // the passage was.
  //
  // The tiebreak needs a locality, and refuses without one:
  //   · the thread must be on the page being searched (a `page:` line pointing
  //     at another page has no locality there, by definition), and
  //   · its quote must actually locate in that page's text, and
  //   · one occurrence must be strictly nearer than the rest — two equidistant
  //     matches name neither, exactly as two matches always did.
  let first = hits[0];
  if (hits.length > 1) {
    const here = n === (Number(thread && thread.page) || 0) ? locateQuote(text, thread) : -1;
    if (here < 0) {
      return { fault: 'ambiguous', phrase: want.slice(0, 80), anchor: null, page: named };
    }
    const scored = hits.map(i => ({ i, d: Math.abs(i - here) })).sort((a, b) => a.d - b.d);
    if (scored[1] && scored[1].d === scored[0].d) {
      return { fault: 'ambiguous', phrase: want.slice(0, 80), anchor: null, page: named };
    }
    first = scored[0].i;
  }
  const end = first + want.length;
  for (const t of (page && page.threads) || []) {
    if (!t || t === thread || (thread && t.id === thread.id)) continue;
    // the cards this discussion already minted are its own business
    if (thread && t.from_thread && t.from_thread === thread.id) continue;
    if ((Number(t.page) || 0) !== n) continue;
    const q = fold(t.quote);
    if (!q || q === want) continue;      // the same span exactly = adoption, not covering
    const i = locateQuote(text, t);
    if (i < 0) continue;
    if (i < end && first < i + q.length) {
      return { fault: 'covered', phrase: q.slice(0, 80), anchor: null, page: named };
    }
  }
  return {
    fault: '', phrase: '',
    anchor: {
      quote: want,
      prefix: text.slice(Math.max(0, first - 32), first),
      suffix: text.slice(end, end + 32),
      page: n,
    },
  };
}

export function addThread(page, { quote, prefix, suffix, text, author, index, page_number, route, origin, ts, mark, from_thread, from_msg, from_idx, passage_named }) {
  const thread = {
    id: newThreadId(),
    quote: String(quote || ''),
    prefix: String(prefix || '').slice(-32),
    suffix: String(suffix || '').slice(0, 32),
    orphaned: false,
    // `ts` is the projection's only concession: a mirrored comment keeps the
    // moment it was actually written, or the page's history would say every
    // visitor commented the second the companion first heard about them.
    // Everything written in Discuss itself passes nothing and is stamped now.
    msgs: [{ author, ts: ts || nowIso(), text: String(text || ''), ...(route ? { route: String(route) } : {}) }],
  };
  const o = cleanOrigin(origin);
  if (o) thread.origin = o;
  // written only when it is not the default, so an ordinary highlight costs
  // nothing on disk and an old record needs no migration
  const mk = cleanMark(mark);
  if (mk) thread.mark = mk;
  // WHERE THIS ONE CAME FROM, and nothing more. A strike minted out of a
  // discussion (server.mjs /strike-from) remembers the thread it was decided
  // in, so this drawer can say "struck — view" and, when the reader deletes
  // that discussion, know which card to fall through to.
  //
  // A SOFT field, deliberately: nothing looks the id up expecting to find it,
  // deleting the discussion leaves a dangling id and that is fine, and NOTHING
  // in the export reads it. The annotation the other side receives is signed by
  // the reader and says nothing whatever about a conversation.
  //
  // `from_msg` is the same note one rung finer: WHICH REPLY'S suggestion the
  // reader took. Both bots may suggest a deletion in one thread — the reader
  // asks each in turn and picks — so "this thread produced a strike" is not a
  // precise enough answer for the drawer to know which chip was the one that
  // was clicked and which were merely not chosen.
  //
  // …and `from_idx` is that note one rung finer again, because a single reply
  // may now carry up to STRIKE_PER_REPLY_MAX suggestions and "which reply" is no
  // longer a precise enough answer either. It is the suggestion's position in
  // that reply's list. Absent means the first, which is what every record
  // written before this amendment meant.
  //
  // `passage_named` records that the anchor came from the BOT's `passage:` line
  // rather than from the reader's own highlight — provenance for the card, and
  // the reason the chip shows the wording before it is clicked.
  if (from_thread) thread.from_thread = String(from_thread);
  if (from_msg) thread.from_msg = String(from_msg);
  if (Number(from_idx) > 0) thread.from_idx = Number(from_idx);
  if (passage_named) thread.passage_named = true;
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

// Who is a bot. The handles the bridge speaks under are `claude` and `codex`
// (sometimes suffixed — "claude (sonnet)"), and three places now need the same
// answer, so it is written once here rather than as a third copy of the regex.
// (anchor.js's `isBotAuthor` is the browser's copy of this one — it cannot
// import from here. The `.trim()` is on both so the two are the same predicate
// and anchor.test.mjs can pin them together.)
export const isAgentAuthor = a => /^(claude|codex)\b/i.test(String(a || '').trim());

// ---- suggestion cards, as the record keeps them ---------------------------
//
// A card is a bot's PROPOSED change to the markdown behind a blog page
// (suggest.mjs writes them, this file stores them, the drawer draws them).
// Five states and no sixth:
//
//   open          proposed, and the reader has not answered
//   applied       accepted; the span was replaced in the source file
//   rejected      turned down by the reader; the file was never touched
//   needs-manual  accepted, and REFUSED at the apply: the passage had drifted
//                 or occurred more than once, so there was no one place to put
//                 it. The apply rule never guesses, so this is where a card
//                 that cannot be placed stops — visibly, with the reason on it
//   unreadable    the block would not parse; there was never anything to apply
//
// The last two exist for the same reason the strike refusal chip does: a
// proposal that vanishes silently is indistinguishable from one that landed.
export const CARD_STATES = ['open', 'applied', 'rejected', 'needs-manual', 'unreadable'];
const CARD_TEXT_MAX = 8000;

// exactly the fields a card has, and nothing a restored or hand-edited record
// could add beside them
export function sanitizeCard(c) {
  if (!c || typeof c !== 'object' || !c.id) return null;
  const state = CARD_STATES.includes(String(c.state)) ? String(c.state) : 'open';
  const out = { id: String(c.id).slice(0, 64), state };
  if (c.current != null) out.current = String(c.current).slice(0, CARD_TEXT_MAX);
  if (c.proposed != null) out.proposed = String(c.proposed).slice(0, CARD_TEXT_MAX);
  if (c.why) out.why = String(c.why).slice(0, 400);
  if (c.deletes) out.deletes = true;
  if (c.error) out.error = String(c.error).slice(0, 400);
  if (c.detail) out.detail = String(c.detail).slice(0, 400);
  if (c.reason) out.reason = String(c.reason).slice(0, 40);
  if (c.at) out.at = String(c.at).slice(0, 40);
  return out;
}

/** The card with this id, anywhere in this message's stack. */
export const findCardIn = (msg, id) =>
  ((msg && msg.suggestions) || []).find(c => c && c.id === String(id)) || null;

/**
 * Answer a card, in place. The card is the whole record of what became of it —
 * there is no ledger beside it, because a blog root has no git and so no round
 * to commit or revert (see suggest.mjs on what was deliberately not ported).
 */
export function setCardState(card, state, extra = {}) {
  if (!card || !CARD_STATES.includes(state)) return null;
  card.state = state;
  card.at = nowIso();
  delete card.reason;
  delete card.detail;
  if (extra.reason) card.reason = String(extra.reason).slice(0, 40);
  if (extra.detail) card.detail = String(extra.detail).slice(0, 400);
  return card;
}

export function appendMsg(page, threadId, {
  author, text, ts, kind, route, origin, file_in, strike, strikes, question, suggestions,
}) {
  const msgs = msgsOf(page, threadId);
  if (!msgs) return null;
  const msg = { author, ts: ts || nowIso(), text: String(text || '') };
  // written over there and mirrored here (see cleanOrigin): the marker is what
  // stops the read-back sending it straight home again
  const o = cleanOrigin(origin);
  if (o) msg.origin = o;
  // who this message was addressed to, when the reader addressed it with a
  // composer pill rather than an @-mention (addThread says the same thing for
  // a thread's opening comment). Absent on everything a bot writes, and absent
  // on a note addressed to nobody — the field only ever records an address.
  if (route) msg.route = String(route);
  if (kind) msg.kind = String(kind); // "tools" — a bot's tool-activity summary
  // A bot's suggestion about where this PAGE belongs (server.mjs lifts it off
  // the reply's last line). A field, not a new kind of message: a client that
  // has never heard of it renders exactly the reply it always rendered. It is
  // an OFFER and nothing more — the page is not filed until the reader clicks
  // the button the drawer draws from it.
  if (file_in && file_in.id && file_in.root) {
    msg.file_in = {
      root: String(file_in.root), id: String(file_in.id),
      title: String(file_in.title || file_in.id), why: String(file_in.why || ''),
    };
  }
  // …and the same shape for a bot's suggestion that the QUOTED PASSAGE should
  // come out (parseStrikeSuggestion above). An offer, a field, a chip — the
  // document is not marked up until the reader clicks, and what the click makes
  // is a comment of THEIRS, not an edit to this conversation.
  //
  // …or the record that it was THROWN AWAY (`rejected`: 'deictic' — the note
  // pointed back at the conversation the co-author will never see; 'long' — it
  // could only have been filed by cutting it in half). That is a field too, and
  // for the same reason the offer is: the drawer draws a quiet buttonless chip
  // from it, and the bot is told on its next turn here. A refusal that left no
  // trace would be indistinguishable from a suggestion never made — which is
  // exactly how a reader ends up being told a deletion happened when it did not.
  //
  // …and there may be SEVERAL of them (STRIKE_PER_REPLY_MAX), because one
  // discussion routinely concludes that two or three separate places have to
  // change. The list lives under `strikes`; `strike` stays exactly what it was
  // for every record already written, and `strikesOf` is the only thing that
  // should ever ask which shape a message is in.
  const list = (Array.isArray(strikes) ? strikes : [])
    .filter(s => s && s.why)
    .slice(0, STRIKE_ENTRY_MAX)
    .map(s => ({
      why: String(s.why),
      ...(s.passage ? { passage: String(s.passage) } : {}),
      // the page the change lands on, when it is not this thread's own
      ...(Number(s.page) > 0 ? { page: Number(s.page) } : {}),
      ...(s.rejected ? { rejected: String(s.rejected) } : {}),
      ...(s.phrase ? { phrase: String(s.phrase) } : {}),
    }));
  if (list.length) msg.strikes = list;
  else if (strike && strike.why) {
    msg.strike = { why: String(strike.why) };
    if (strike.passage) msg.strike.passage = String(strike.passage);
    if (Number(strike.page) > 0) msg.strike.page = Number(strike.page);
    if (strike.rejected) msg.strike.rejected = String(strike.rejected);
    if (strike.phrase) msg.strike.phrase = String(strike.phrase);
  }
  // …and the third of the same shape: a bot noticing the reader has not GOT
  // something and offering to file a revision question about it
  // (questions.parseQuestionSuggestion). Offer, field, chip — the vault stays
  // empty until the reader presses the button.
  //
  // …and the same field carries the OTHER thing a bot can propose about the
  // vault: a rewrite of a card this discussion already filed
  // (`questions.parseCardRevision`). `revises` is the card it names, `card` is
  // the whole corrected question the confirm applies, and `rejected` is the
  // record that the id pointed nowhere ('unknown') or at another page's card
  // ('elsewhere') — refused at the lift, drawn as a buttonless chip, never
  // allowed to become a second card.
  if (question && (question.why || question.revises)) {
    msg.question = { why: String(question.why || '') };
    if (question.revises) msg.question.revises = String(question.revises);
    if (question.rejected) msg.question.rejected = String(question.rejected);
    if (question.card && typeof question.card === 'object') msg.question.card = question.card;
  }
  // …and the fourth, which is the same shape again and the biggest of them: on
  // a blog source page a bot does not edit the markdown, it PROPOSES — one
  // card per ```suggest block, lifted off the reply by the server
  // (suggest.liftSuggestions). Offer, field, card: the file does not move until
  // the reader presses Accept, and the card carries its own answer afterwards
  // (`state`), so nothing else has to remember what became of it.
  //
  // A LIST rather than a single field, unlike the three above, because a typo
  // sweep is genuinely several proposals in one reply and they are not
  // alternatives. `sanitizeCard` keeps exactly the fields a card has, so a
  // record restored from anywhere cannot smuggle a fifth one in.
  if (Array.isArray(suggestions) && suggestions.length) {
    const kept = suggestions.map(sanitizeCard).filter(Boolean);
    if (kept.length) msg.suggestions = kept;
  }
  msgs.push(msg);
  // NEW ACTIVITY IS THE END OF RESOLVED. A thread somebody has just written
  // into — the reader replying, or a bot's answer landing — is a live thread
  // again, whatever it was a second ago. This is the ONE place that has to
  // know it: /reply, the reading room's composer and the bridge's `reply`
  // event all append here, so none of them carries the rule separately.
  //
  // …AND IT IS ALSO WHERE "ADDRESSED" IS DECIDED, for the same reason: every
  // write into a thread comes through here, so the rule is stated once.
  //
  //   a BOT wrote into this thread   → addressed: the bots have had their go,
  //                                    and it is the reader's turn to look
  //   a HUMAN wrote into this thread → not addressed: the reader has just
  //                                    asked something new, so any earlier
  //                                    claim of "done" is stale
  //
  // A `tools` line is a bot narrating what it ran, not a bot answering, so it
  // MARKS NOTHING — otherwise a thread would go amber the moment an agent
  // opened a file in it — and it UNMARKS nothing either. That second half is
  // not symmetry for its own sake: a turn's tool summary can land after its
  // answer (codex does exactly this), and clearing the flag there would take
  // down the "ready for review" the answer had just earned. Since send review
  // fans out one turn per thread, that ordering is now ordinary rather than
  // exotic.
  if (threadId !== PAGE_CHAT) {
    const thread = findThread(page, threadId);
    // reopening ENDS a claim (setResolved says so, and is right about it), so a
    // narration passing through here has to put back the one it did not make
    const keep = kind === 'tools' && thread && thread.addressed
      ? { at: thread.addressed_at, by: thread.addressed_by } : null;
    setResolved(thread, false);
    if (kind !== 'tools') setAddressed(thread, isAgentAuthor(author), author);
    else if (keep) { setAddressed(thread, true, keep.by); thread.addressed_at = keep.at; }
  }
  return msg;
}

// ---- ready for review ---------------------------------------------------
// The middle state between "open" and "resolved", and the reason it exists:
// after the bots work through a page's margin review the reader has no way to
// see WHICH threads moved without re-reading all of them. `addressed` says a
// bot has replied into this thread since the reader last wrote in it.
//
// RESOLVING IS STILL THE READER'S CLICK ALONE. A bot can say "I did this"; it
// can never close the reader's question. Addressed is a flag on the way to
// that click, not a substitute for it.
//
// Same shape as `resolved`, deliberately: state, not history. Clearing REMOVES
// the three fields, so a thread that was never addressed is byte-identical to
// one that was addressed and then written into again, and every record written
// before this reads as not-addressed.
export const isAddressed = t => !!(t && t.addressed && !t.resolved);

export function setAddressed(thread, on, by) {
  if (!thread) return null;
  const was = !!thread.addressed;
  if (on) {
    thread.addressed = true;
    thread.addressed_at = nowIso();
    if (by) thread.addressed_by = sanitizeHandle(by); else delete thread.addressed_by;
  } else {
    delete thread.addressed;
    delete thread.addressed_at;
    delete thread.addressed_by;
  }
  return { thread, changed: was !== !!on };
}

// ---- re-anchoring onto the wording a change put there ---------------------
//
// The gap this closes: a bot's change REWRITES the quoted passage, so the
// thread's anchor no longer matches anything on the page and the highlight
// orphans. The reader is then left with a card that says what changed and a
// page that gives them no bearing at all on where it landed.
//
// The bot has already said what the passage now reads (bridge-system-prompt
// rule 5), so the wording is there to anchor to. WHO DOES THE ANCHORING is the
// design question, and the answer is: the page, not this file.
//
// The companion has no DOM. It cannot check that the new wording is really in
// the document, only that a bot claimed it — and acting on the claim alone
// would rewrite a thread's anchor on the strength of a sentence, possibly
// destroying an anchor that still matched perfectly. So the extension locates
// the new wording first (anchor.js, against the live page) and only a
// SUCCESSFUL, unambiguous locate is allowed to reach this file. A locate that
// fails changes nothing and the thread stays orphaned exactly as before.
//
// What this file is still the authority on is WHICH wording may be written:
// `newWording` re-parses the thread's own last bot message here, and a
// /reanchor that asks for anything else is refused. A client cannot use this
// door to rewrite a quote into whatever it likes.
//
// `prior_quote` is the original wording, kept forever — it is the "was" half
// of the drawer's before→after, and losing it would leave a diff with one end.
// It is written ONCE: a passage rewritten twice still has one original.
//
// (anchor.js carries the browser-side twin of this regex, `Anchor.newWording`.
// Keep the two in step.)
export const NEW_WORDING_RE =
  /\b(?:(?:now reads|reads now|now says|new wording(?: is)?)\b\s*[:—-]?|(?:reworded|rewritten|rewrote)\b[^"“\n]{0,80}[:—-]|(?:changed|updated)(?: it)? to\b\s*[:—-]?)\s*[“"']([\s\S]{4,400}?)[”"']/i;

export function newWording(thread) {
  const msgs = (thread && thread.msgs) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.kind === 'tools' || !isAgentAuthor(m.author)) continue;
    const hit = NEW_WORDING_RE.exec(String(m.text || ''));
    return hit ? hit[1].trim() : '';
  }
  return '';
}

// whitespace-insensitive equality, the same fold anchor.js matches under: the
// extension sends back what it FOUND on the page, which may be broken across
// tags and lines, not a byte copy of what the bot typed
const looseSame = (a, b) =>
  String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();

export function reanchorThread(thread, anchor) {
  if (!thread) return { ok: false, reason: 'unknown thread' };
  if (!isAddressed(thread)) return { ok: false, reason: 'not a thread the bots have answered' };
  const want = newWording(thread);
  if (!want) return { ok: false, reason: 'no bot in this thread quoted a new wording' };
  const quote = String((anchor && anchor.quote) || '').trim();
  if (!quote) return { ok: false, reason: 'no quote' };
  if (!looseSame(quote, want)) return { ok: false, reason: 'that is not the wording the bot quoted back' };
  // idempotent: a second tab locating the same passage is not a second rewrite
  if (looseSame(thread.quote, quote)) return { ok: true, thread, changed: false };
  if (!thread.prior_quote) thread.prior_quote = thread.quote;
  thread.quote = quote;
  // same shape addThread stores: 32 chars of context either side
  if (anchor && typeof anchor.prefix === 'string') thread.prefix = anchor.prefix.slice(-32);
  if (anchor && typeof anchor.suffix === 'string') thread.suffix = anchor.suffix.slice(0, 32);
  thread.reanchored_at = nowIso();
  // the anchor was just FOUND: whatever the record said about it is stale
  thread.orphaned = false;
  return { ok: true, thread, changed: true };
}

// ---- healing an orphan from the turn-end diff -----------------------------
//
// `reanchorThread` above is the PAGE's door: a bot claimed a new wording, the
// extension proved it is really in the document, and only then may the anchor
// move. That gate exists because a claim is not evidence.
//
// This is the FILE's door, and it is a different question. The turn-end diff
// (collateral.mjs) reads the artifact's own bytes before and after the turn. It
// does not claim the new wording is on the page — it is holding the page. So
// there is nothing left to prove, and the companion may write the anchor
// itself. That is what lets a SILENT rewrite (no `now reads` line anywhere, so
// nothing for the extension to locate) still be healed: the thread that would
// have orphaned re-anchors onto the wording that replaced its passage and
// paints struck-old-then-green-new like any other tracked change.
//
// Deletion has no replacement to anchor to, so the caller hands over the
// surviving block next door (the diff computes it) and sets `deleted` — the
// only new state here, and it exists so the card can say "this passage was
// deleted" instead of drawing a before→after that would read as a rewrite it
// was not.
//
// `prior_quote` follows the same rule it does everywhere: written ONCE. A
// passage rewritten twice still has one original, and it is the only thing in
// the record nothing can recover.
//
// Not exposed over HTTP. No client asks for this — it happens at turn-end, from
// bytes on disk, or not at all.
export function healThread(thread, { quote, prefix, suffix, deleted } = {}) {
  if (!thread) return { ok: false, reason: 'unknown thread' };
  // a filed thread is closed: dragging it back onto the page under a green
  // highlight is not a repair, it is an unasked-for reopening
  if (thread.resolved) return { ok: false, reason: 'thread is resolved' };
  const next = String(quote || '').trim();
  if (!next) return { ok: false, reason: 'no quote' };
  // idempotent, like reanchorThread: a re-run of the same turn-end is not a
  // second rewrite, and must not overwrite prior_quote with the new wording
  if (looseSame(thread.quote, next)) return { ok: true, thread, changed: false };
  if (!thread.prior_quote) thread.prior_quote = thread.quote;
  thread.quote = next;
  if (typeof prefix === 'string') thread.prefix = prefix.slice(-32);
  if (typeof suffix === 'string') thread.suffix = suffix.slice(0, 32);
  if (deleted) thread.deleted_passage = true; else delete thread.deleted_passage;
  thread.healed_at = nowIso();
  thread.reanchored_at = thread.healed_at;
  // the anchor came out of the file that IS the page: whatever the record said
  // about this thread being lost is stale
  thread.orphaned = false;
  return { ok: true, thread, changed: true };
}

// ---- resolving a thread -------------------------------------------------
// A page collects comments faster than anybody works through them, so a thread
// can be marked HANDLED: it leaves the drawer's main list for a collapsed
// archive at the bottom, and its highlight on the page turns from yellow to
// green. It is never hidden and never deleted — the passage stays marked,
// because "we dealt with this" is worth seeing on a re-read months later.
//
// State, not history: `resolved` is a plain flag beside `orphaned`, and
// reopening REMOVES the three fields rather than writing resolved:false, so a
// record that has never been resolved is byte-identical to one that has been
// resolved and reopened, and every record written before this reads as open.
//
// `summary` deliberately SURVIVES a reopen. It is what the thread settled last
// time, which is still true; keeping it means a re-resolve shows its digest
// instantly, and it is what lets a summary job that drains after a reopen land
// harmlessly instead of needing to be chased down and cancelled.
export const SUMMARY_MAX = 2000;
export const isResolved = t => !!(t && t.resolved);

export function setResolved(thread, on, by) {
  if (!thread) return null;
  const was = !!thread.resolved;
  // Either direction ends "ready for review". Resolving is the reader having
  // looked, so the flag has done its job; reopening is the reader saying "not
  // done", which is exactly the answer the amber badge was asking for. Leaving
  // it set through a reopen would put a thread straight back into the section
  // the reader had just taken it out of.
  setAddressed(thread, false);
  if (on) {
    thread.resolved = true;
    thread.resolved_at = nowIso();
    if (by) thread.resolved_by = sanitizeHandle(by); else delete thread.resolved_by;
  } else {
    delete thread.resolved;
    delete thread.resolved_at;
    delete thread.resolved_by;
  }
  return { thread, changed: was !== !!on };
}

// What the resolved card says the thread settled. Written twice over: the
// instant heuristic below the moment the reader clicks resolve, then the
// agent's own three-to-five sentences when that job drains (server.mjs). One
// field, so the card renders whatever is there and never has to know which.
export function setSummary(thread, text, by) {
  if (!thread) return null;
  const s = String(text || '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);
  if (!s) return null;
  thread.summary = s;
  thread.summary_at = nowIso();
  if (by) thread.summary_by = sanitizeHandle(by); else delete thread.summary_by;
  return thread;
}

// The placeholder — instant, deterministic, no agent. Resolving must stay a
// single click that costs nothing, so the card is never empty while the real
// summary is still in the queue behind whatever else the bots are doing.
//
// Preference order is "what would a reader most want to see in one line":
// the last thing a BOT concluded, else the last thing anyone said. A checklist
// in the thread is reported as a tally instead — "3/4 done" says more about
// where a task thread got to than any sentence of it does.
const boxes = text => {
  const all = String(text || '').match(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/gm) || [];
  const done = all.filter(m => /\[[xX]\]$/.test(m)).length;
  return all.length ? { done, total: all.length } : null;
};
const firstSentence = text => {
  const s = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = /^(.{20,220}?[.!?])(\s|$)/.exec(s);
  return (m ? m[1] : s.slice(0, 220)).trim();
};
export function threadDigest(thread) {
  const msgs = (thread && thread.msgs) || [];
  const said = msgs.filter(m => m && m.kind !== 'tools');
  const tally = said.map(m => boxes(m.text)).filter(Boolean).pop();
  const lastBot = [...said].reverse().find(m => isAgentAuthor(m.author));
  const last = said[said.length - 1];
  const head = tally ? `Checklist: ${tally.done}/${tally.total} done.` : '';
  const body = firstSentence((lastBot || last || {}).text);
  const out = [head, body].filter(Boolean).join(' ');
  return out || 'Resolved.';
}

// ---- the review's decision log ---------------------------------------------
//
// The gap this closes, in the reader's own words: editing a long manuscript,
// decisions accumulate across threads. A phrasing is settled on page 2, a
// deletion is agreed on page 5 — and a bot answering a comment on page 9 knows
// its own thread and the marks beside its own quote (`nearbyMarksBlock`) and
// NOTHING ELSE. So it proposes wording that contradicts something the reader
// and another bot settled an hour ago, and the reader is the only one in the
// room who can notice.
//
// WHY A FILE AND NOT THE ENVELOPE. The obvious fix — put every thread in every
// turn — is the one the reader themselves called unwieldy, and they were right:
// a manuscript carries fifty threads, each turn would carry all fifty, every
// turn of every round, and the one comment the bot was actually asked about
// would be three per cent of what it was handed. The idiom this companion
// already has is the answer, twice over: the page's full text is not inlined
// (the envelope names `snapshots/<key>.html` and the bot reads it) and neither
// are the figures (the envelope names the PNGs). So the decision log is a FILE
// too, named on the turn and read on demand. The nearby-marks block stays
// exactly as it is: it is the zero-effort view, the neighbours a bot must see
// without asking; this is the on-demand whole.
//
// MECHANICAL, ALWAYS. Not one line of this costs a bot turn. Every line is
// derived from the record — the mark, the note, the resolved flag, the summary
// the reader's own resolve already wrote, the last thing anyone said. A log
// that had to be written by the agents would be a log nobody could afford to
// regenerate, and regenerating it on every decision is the whole point.
export const DECISIONS_MIN = 2;          // 0-1 threads: nothing to be inconsistent WITH
export const DECISION_QUOTE_MAX = 80;    // chars of each thread's quote
export const DECISION_NOTE_MAX = 140;    // chars of a strikeout's note
export const DECISION_SAID_MAX = 160;    // chars of the last thing said, or the summary
export const DECISION_ROWS_MAX = 400;    // a 300-page book with a thread per page

export const decisionsFile = key => path.join(SNAPS, `${safeKey(key)}-decisions.md`);

const clipTo = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// Is this thread still waiting on the reader's click? Two shapes of pending,
// and both mean the same thing to a bot about to propose something: a change
// has been PROPOSED here and nobody has yet said yes or no.
const pendingCard = thread => ((thread && thread.msgs) || [])
  .some(m => ((m && m.suggestions) || []).some(c => c && c.state === 'open'));
const pendingStrike = (page, thread) => {
  if (!thread || markOf(thread) === 'strike') return false;
  const offered = (thread.msgs || [])
    .some(m => strikesOf(m).some(s => s && s.why && !s.rejected));
  return offered && !broodOf(page, thread.id).length;
};

// The one word this thread's state is, and the one clause that says what was
// decided in it. Order matters: a mark on the document outranks a flag on the
// record, because the mark is what the co-author will actually receive.
export function decisionStatus(page, thread) {
  if (markOf(thread) === 'strike') {
    return thread.from_thread ? 'struck (from a discussion)' : 'struck';
  }
  if (thread && thread.deleted_passage) return 'deleted-passage';
  if (thread && thread.resolved) return 'resolved';
  if (pendingCard(thread) || pendingStrike(page, thread)) return 'suggestion pending';
  return 'open';
}

// …and what was decided, mechanically. A struck thread's note IS the decision
// (it is the sentence copied onto the document); a resolved thread's summary is
// the one the reader's own click already wrote — `threadDigest` where the
// agents' paragraph has not landed; everything else falls back to the last
// thing anybody actually said, which is the best a machine can honestly do.
export function decisionSaid(thread) {
  const msgs = ((thread && thread.msgs) || []).filter(m => m && m.kind !== 'tools');
  if (markOf(thread) === 'strike') {
    const note = clipTo((msgs[0] || {}).text, DECISION_NOTE_MAX);
    return note ? `note: ${note}` : 'no note — the strikeout speaks for itself';
  }
  if (thread && thread.deleted_passage) {
    return 'the passage was deleted from the document';
  }
  if (thread && thread.resolved) {
    return clipTo(thread.summary || threadDigest(thread), DECISION_SAID_MAX);
  }
  const last = msgs[msgs.length - 1];
  return last ? `last — ${last.author}: ${clipTo(last.text, DECISION_SAID_MAX)}` : '';
}

// When this thread was last DECIDED, for the ordering. Newest first, because
// the newest decision is the one most likely to be the one nobody else has
// caught up with — and it is the ordering the reader themselves reads a review
// in. Every stamp is soft: a record missing all of them sorts last, never
// throws.
export function decisionAt(thread) {
  const msgs = (thread && thread.msgs) || [];
  const last = msgs.length ? msgs[msgs.length - 1].ts : '';
  return [thread && thread.resolved_at, thread && thread.updated,
    thread && thread.healed_at, thread && thread.reanchored_at, last]
    .map(s => String(s || '')).filter(Boolean).sort().pop() || '';
}

export function decisionRow(page, thread) {
  const where = Number(thread && thread.page) > 0 ? ` · p${Number(thread.page)}` : '';
  const said = decisionSaid(thread);
  return `- ${decisionStatus(page, thread)}${where} · "${clipTo(thread && thread.quote, DECISION_QUOTE_MAX)}"`
    + (said ? ` — ${said}` : '');
}

/**
 * The whole log, as it is written to disk. Pure: a page record in, markdown
 * out, no filesystem and no clock. Dense on purpose — this is read by a model,
 * one line per thread, and a paragraph per thread would defeat the reason it is
 * a file at all.
 */
export function decisionLog(page) {
  const threads = ((page && page.threads) || [])
    .filter(t => t && (t.msgs || []).length && String(t.quote || '').trim());
  const rows = threads
    .map(t => ({ t, at: decisionAt(t) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, DECISION_ROWS_MAX)
    .map(({ t }) => decisionRow(page, t));
  const more = threads.length - rows.length;
  return `# Decisions on "${displayTitle(page)}"\n\n`
    + `${threads.length} comment thread${threads.length === 1 ? '' : 's'} on this document, `
    + 'newest decision first. One line each: status · page · the passage · what was decided.\n'
    + 'Statuses: open (still being discussed) · suggestion pending (a change has been proposed '
    + 'and the reader has not answered) · struck (a strikeout is on the document, and its note is '
    + 'the wording that was agreed) · resolved (the reader filed it: settled) · deleted-passage '
    + '(the passage itself is gone from the document).\n\n'
    + `${rows.join('\n')}\n`
    + (more > 0 ? `\n(…and ${more} older thread${more === 1 ? '' : 's'}, not listed.)\n` : '');
}

/**
 * Write it, and return the path the envelope should name — or '' where there is
 * nothing worth naming. Cheap by construction: this is a SERIALIZATION of the
 * record, so it is regenerated whole on every decision rather than patched, and
 * an unchanged log is not written at all (so its mtime means what it says).
 * Atomic, like every other file this companion keeps: tmp then rename, so a bot
 * reading it mid-write reads the old one and never half of either.
 *
 * Under DECISIONS_MIN threads there is nothing to be inconsistent with, so the
 * file is REMOVED rather than left to go stale — a page whose threads were all
 * deleted must not still name a log listing them.
 */
export function writeDecisionLog(page) {
  const key = pageKey(page && page.url);
  const file = decisionsFile(key);
  const threads = ((page && page.threads) || [])
    .filter(t => t && (t.msgs || []).length && String(t.quote || '').trim());
  if (threads.length < DECISIONS_MIN) {
    try { fs.unlinkSync(file); } catch { }
    return '';
  }
  const next = decisionLog(page);
  try { if (fs.readFileSync(file, 'utf8') === next) return file; } catch { }
  fs.mkdirSync(SNAPS, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
  return file;
}

export function deleteDecisionLog(key) {
  try { fs.unlinkSync(decisionsFile(key)); } catch { }
}
