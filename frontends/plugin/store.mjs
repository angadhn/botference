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
    const key = `${root} ${id}`;
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
// A message the projection wrote — a reply the visitor left over there. Read
// the other way it is the marker that says "we already know about this one",
// which is what keeps the companion from mirroring its own mirror back.
export const isMirrored = m => !!(m && cleanOrigin(m.origin));
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
export const THREAD_MARKS = ['highlight', 'strike'];
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

// ---- a bot SUGGESTING the strike -------------------------------------------
//
// The same idiom as `file-in:` (workspace.mjs SUGGEST_MARK), for the same
// reason: a bot cannot mark up a document, and should not be able to. It can
// only end a reply with a standalone line, which the companion lifts off the
// words into a field, which the drawer draws as a chip, which the READER
// clicks. Nothing happens on the bot's say-so.
//
// The line is `strike: <one short reason>`. It is offered ONLY on a document
// that can carry a strikeout (a PDF), only inside a comment thread, and only on
// a thread that is neither struck already nor filed — so a bot that has never
// been shown the offer has no way to learn the convention and no reason to.
export const STRIKE_MARK = 'strike:';
const STRIKE_WHY_MAX = 200;

// The invitation, as it rides the turn (server.mjs summon → chat.mjs envelope).
// The last sentence is doing the most work: an eager model will propose a
// deletion whenever it can think of one, and a chip on every reply is a chip
// nobody reads.
export const strikeOfferBlock = () =>
  'This document takes markup, and this comment is a highlight on it. If — and '
  + 'ONLY if — the discussion in this thread has genuinely concluded that the '
  + 'quoted passage should come out of the document, you may END your reply with '
  + `a line of its own reading \`${STRIKE_MARK} <one short reason>\`. The reader `
  + 'gets a button that strikes the passage through under their own name; you are '
  + 'not marking anything up. Use it rarely — a disagreement, a question, or a '
  + 'passage that merely needs rewording is NOT this. Say nothing at all if in '
  + 'doubt.\n';

// …and the line, back out of the reply. A line of its own, the LAST one counts,
// and a reason is required — a bare `strike:` is a model echoing the convention
// rather than concluding anything, and a chip with no sentence on it gives the
// reader nothing to agree with.
export function parseStrikeSuggestion(text) {
  const re = new RegExp(`^\\s*(?:[-*>]\\s*)?${STRIKE_MARK}\\s*(.+)$`, 'i');
  let found = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/[`*_]/g, '').trim();
    const m = re.exec(line);
    if (!m) continue;
    const why = String(m[1] || '').replace(/^[—:-]\s*/, '').trim().slice(0, STRIKE_WHY_MAX);
    if (!why) continue;
    found = { why, line: raw };
  }
  return found;
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

export function addThread(page, { quote, prefix, suffix, text, author, index, page_number, route, origin, ts, mark, from_thread, from_msg }) {
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
  if (from_thread) thread.from_thread = String(from_thread);
  if (from_msg) thread.from_msg = String(from_msg);
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
export const isAgentAuthor = a => /^(claude|codex)\b/i.test(String(a || ''));

export function appendMsg(page, threadId, {
  author, text, ts, kind, route, origin, file_in, strike, question,
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
  if (strike && strike.why) msg.strike = { why: String(strike.why) };
  // …and the third of the same shape: a bot noticing the reader has not GOT
  // something and offering to file a revision question about it
  // (questions.parseQuestionSuggestion). Offer, field, chip — the vault stays
  // empty until the reader presses the button.
  if (question && question.why) msg.question = { why: String(question.why) };
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
