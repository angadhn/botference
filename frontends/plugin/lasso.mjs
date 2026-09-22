// lasso.mjs — bringing what the reader has already read and said into a chat.
//
// THE PROBLEM. The reader is three months into a body of work. The thing that
// would settle the question in front of them was said in a council chat in
// July, or is highlighted on a PDF they annotated in August, or is a paper
// sitting in ~/Downloads that nobody has opened yet. None of it is in this
// conversation, and the only way in was to remember the file path — which is
// exactly the thing a reader working in a browser never wants to know.
//
// So: SEARCH what the owner has, and let them attach what comes back.
//
// TWO RULES, and everything here follows from them.
//
//   1. The bots never get walls of text inline. An attachment is a FILE they
//      READ on demand. This is the pattern the page snapshot set (chat.mjs
//      `snap`, store.snapshotFile, SPEC "BOTS READ THE WHOLE DOCUMENT"): the
//      envelope carries a PATH and one sentence about what is at the end of
//      it, and the model opens it when it matters. A digest inlined into every
//      turn would bury the turn.
//   2. Nothing attaches without a click. The search is a search; the chips are
//      offers. A bot may ASK for a search (`lasso:` at the end of a reply,
//      exactly as `watch:` and `file-in:` ask for things) and still attaches
//      nothing — the reader gets the matches and decides.
//
// The index is built lazily and cached against mtimes. There is no daemon and
// no background scan: a `/lasso` with nothing to answer costs one directory
// listing, and a second `/lasso` a second later costs nothing at all.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DIR, ROOT, readIndex, readPage, readPageByKey, savePage,
  readConfig, readSnapshot, snapshotPdfText, hasSnapshot,
  pageKey, normUrl, displayTitle, isLibrary,
} from './store.mjs';
import { sanitizeArticle } from './sanitize.mjs';
import {
  knownCouncilRoots, rootState, projectTitle, stripEnvelope,
} from './workspace.mjs';

/**
 * The councils this search may read: the ones the reader has VOUCHED FOR.
 *
 * A root they were asked about and said no to is not indexed, for the same
 * reason nothing else in this tree reads it — the yes is what buys the read
 * (SPEC, "the one-time council confirmation").
 */
export const searchableRoots = () =>
  knownCouncilRoots().filter(r => rootState(r) === 'yes');

// ---- shapes and budgets ---------------------------------------------------

export const LASSO_LIMIT = 8;            // matches returned by default
export const HIT_MAX = 160;              // the matching line shown on a chip
/** First N characters of a watched-folder file that are indexed. */
export const FILE_HEAD_CHARS = 2000;
/** How many watched-folder files one folder contributes (a Downloads guard). */
export const FOLDER_FILES_MAX = 400;
/** How deep a watched folder is walked. 1 = the folder itself and nothing under it. */
export const FOLDER_DEPTH = 2;
/** How many attachments one chat may carry. */
export const ATTACHMENTS_MAX = 20;
/** The envelope block's whole budget; past it, the summaries go. */
export const ATTACH_BLOCK_MAX = 2500;
/** How much of a page's saved text goes into its digest. */
export const DIGEST_TEXT_MAX = 400000;
export const SUMMARY_MAX = 400;

export const ATTACH_DIR = path.join(DIR, 'attachments');

/** What a watched folder is allowed to be made of. */
export const FILE_EXTS = ['.pdf', '.md', '.markdown', '.txt', '.text',
  '.html', '.htm', '.csv', '.json', '.tex', '.rst', '.org'];

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const mtimeOf = p => { try { return Math.round(fs.statSync(p).mtimeMs); } catch { return 0; } };

/** `~/Downloads` → an absolute path. A relative path is resolved against ROOT. */
export function expandHome(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(ROOT, s);
}

/** The watched folders, from config.json. Absent (every config until now) is none. */
export function watchedFolders(cfg = readConfig()) {
  const raw = Array.isArray(cfg && cfg.lasso_folders) ? cfg.lasso_folders : [];
  const out = [];
  for (const entry of raw.slice(0, 12)) {
    const abs = expandHome(entry);
    if (abs && isDir(abs) && !out.includes(abs)) out.push(abs);
  }
  return out;
}

// ---- reading text out of a file ------------------------------------------
//
// THREE ROUTES, and the report says which one ran, because "the PDF was
// indexed by its filename only" and "the PDF was indexed by its words" are
// very different products and the difference must never be silent.
//
//   · a PAGE we already snapshotted → the snapshot's text (the extension did
//     the extraction, in the browser, months ago)
//   · a loose PDF → `pdftotext` when this machine has one
//   · anything else → the filename
//
// There is no server-side PDF extractor in this tree: the extension's pdf.js
// runs in the browser and the companion has never had a copy. So a machine
// without poppler indexes a loose PDF by its name, which is honest and still
// useful (`/lasso kalman` finds `kalman-1960.pdf`).
let pdftotextChecked = null;
export function pdftotextAvailable() {
  if (pdftotextChecked !== null) return pdftotextChecked;
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 4000 });
    pdftotextChecked = true;
  } catch { pdftotextChecked = false; }
  return pdftotextChecked;
}
/** For the suites: forget what we decided about poppler. */
export const resetPdftotext = () => { pdftotextChecked = null; };

export function pdfText(file, { chars = FILE_HEAD_CHARS } = {}) {
  if (!pdftotextAvailable()) return '';
  try {
    const out = execFileSync('pdftotext',
      ['-q', '-enc', 'UTF-8', '-l', '20', file, '-'],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    return String(out || '').replace(/\s+/g, ' ').trim().slice(0, chars);
  } catch { return ''; }
}

const htmlText = html => snapshotPdfText(html);

/** The head of one watched-folder file as plain text, and how we got it. */
export function fileHead(file, { chars = FILE_HEAD_CHARS } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    const t = pdfText(file, { chars });
    return { text: t, how: t ? 'pdftotext' : 'filename' };
  }
  let raw = '';
  try {
    const fd = fs.openSync(file, 'r');
    // 4× the character budget in bytes: enough for the head of any encoding
    // we index, and never the whole of a 200MB file.
    const buf = Buffer.alloc(chars * 4);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    raw = buf.slice(0, n).toString('utf8');
  } catch { return { text: '', how: 'filename' }; }
  const text = (ext === '.html' || ext === '.htm') ? htmlText(raw) : raw;
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, chars);
  return { text: clean, how: clean ? 'text' : 'filename' };
}

// ---- the index ------------------------------------------------------------
//
// One entry per thing the reader has. `title` / `marks` / `body` are the three
// weight classes: a term in the title is worth three, in a quote or a comment
// two, in the body one. That is the whole ranking, deliberately — a reader who
// cannot predict what a search will return stops using it.

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The words of a query, lowercased, de-duplicated, quotes honoured. */
export function terms(query) {
  const q = String(query == null ? '' : query).toLowerCase();
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    const t = (m[1] || m[2] || '').replace(/^[^\w]+|[^\w]+$/g, '').trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 12);
}

const countTerm = (hay, term) => {
  if (!hay || !term) return 0;
  let n = 0;
  let i = hay.indexOf(term);
  while (i >= 0 && n < 50) { n++; i = hay.indexOf(term, i + term.length); }
  return n;
};

/** The one line of an entry that best shows why it matched, ≤ HIT_MAX chars. */
export function hitLine(entry, words) {
  const fields = [entry.marks || '', entry.body || ''];
  for (const field of fields) {
    if (!field) continue;
    const low = field.toLowerCase();
    for (const w of words) {
      const i = low.indexOf(w);
      if (i < 0) continue;
      const from = Math.max(0, i - 60);
      const slice = field.slice(from, from + HIT_MAX + 20);
      return clip((from > 0 ? '…' : '') + slice, HIT_MAX);
    }
  }
  return clip(entry.marks || entry.body || entry.title || '', HIT_MAX);
}

/** Score one entry against the query's words. 0 = not a match at all. */
export function score(entry, words) {
  if (!words.length) return 0;
  const title = String(entry.title || '').toLowerCase();
  const marks = String(entry.marks || '').toLowerCase();
  const body = String(entry.body || '').toLowerCase();
  let total = 0;
  let matched = 0;
  for (const w of words) {
    const s = countTerm(title, w) * 3 + countTerm(marks, w) * 2 + countTerm(body, w);
    if (s) matched++;
    total += s;
  }
  if (!matched) return 0;
  // Every term found beats most terms found, whatever the counts say: a search
  // for two words means both, and a page that says one of them forty times is
  // not the answer.
  return total + (matched === words.length ? 1000 : matched * 10);
}

// --- source 1: the pages this companion holds ------------------------------

function pageEntries() {
  const index = readIndex();
  const out = [];
  for (const key of Object.keys(index)) {
    const row = index[key] || {};
    const page = readPageByKey(key);
    if (!page) continue;
    if (isLibrary(page.url)) continue;
    const marks = [];
    for (const t of page.threads || []) {
      if (t && t.quote) marks.push(String(t.quote));
      for (const m of (t && t.msgs) || []) if (m && m.text) marks.push(String(m.text));
    }
    for (const m of page.page_chat || []) if (m && m.text) marks.push(String(m.text));
    const body = hasSnapshot(key) ? htmlText(readSnapshot(key)) : '';
    out.push({
      kind: 'page',
      id: key,
      title: displayTitle(page) || row.title || page.url,
      url_or_path: page.url,
      when: String(page.updated_at || row.updated_at || ''),
      marks: marks.join('\n'),
      body,
    });
  }
  return out;
}

// --- source 2: the council's own chats -------------------------------------
//
// Both session layouts, exactly as workspace.mjs reads them: `<root>/sessions`
// (the original self-hosted vault) and `<root>/work/sessions` (project-local).
// A sid in both is one chat, and work/ wins.

export function sessionFilesIn(root) {
  const out = [];
  const seen = new Set();
  for (const dir of [path.join(root, 'work', 'sessions'), path.join(root, 'sessions')]) {
    if (!isDir(dir)) continue;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const sid = name.slice(0, -5);
      if (seen.has(sid)) continue;
      seen.add(sid);
      out.push({ sid, file: path.join(dir, name) });
    }
  }
  return out;
}

function chatEntries(roots) {
  const out = [];
  for (const root of roots) {
    for (const { sid, file } of sessionFilesIn(root)) {
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!payload) continue;
      const entries = Array.isArray(payload.transcript) && payload.transcript.length
        ? payload.transcript
        : (Array.isArray(payload.room_history) ? payload.room_history : []);
      const lines = [];
      for (const e of entries) {
        if (!e || !e.text) continue;
        const speaker = String(e.speaker || '').toLowerCase();
        if (speaker === 'system') continue;
        const text = speaker === 'user' ? stripEnvelope(String(e.text)) : String(e.text).trim();
        if (text) lines.push(`${speaker || 'someone'}: ${text}`);
      }
      if (!lines.length) continue;
      const pid = String(payload.project_id || '');
      out.push({
        kind: 'chat',
        id: sid,
        title: String(payload.custom_title || payload.title || '').trim() || 'untitled chat',
        url_or_path: file,
        when: String(payload.updated_at || payload.created_at || ''),
        root,
        project: pid ? (projectTitle(root, pid) || pid) : '',
        marks: '',
        body: lines.join('\n'),
      });
    }
  }
  return out;
}

// --- source 3: the folders the reader named --------------------------------

function walkFolder(dir, depth, budget, out) {
  if (depth <= 0 || out.length >= budget) return;
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    if (out.length >= budget) return;
    if (d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { walkFolder(p, depth - 1, budget, out); continue; }
    if (!d.isFile()) continue;
    if (!FILE_EXTS.includes(path.extname(d.name).toLowerCase())) continue;
    out.push(p);
  }
}

function fileEntries(folders) {
  const out = [];
  for (const dir of folders) {
    const files = [];
    walkFolder(dir, FOLDER_DEPTH, FOLDER_FILES_MAX, files);
    for (const file of files) {
      const { text } = fileHead(file);
      out.push({
        kind: 'file',
        id: file,
        title: path.basename(file),
        url_or_path: file,
        when: new Date(mtimeOf(file)).toISOString(),
        marks: '',
        body: text,
      });
    }
  }
  return out;
}

// ---- the cache ------------------------------------------------------------
//
// A signature over the mtimes of everything that could have changed. Cheap
// (one stat per session file, one per watched file, one for the page index),
// and exact enough: a page saved, a chat written, a paper dropped into
// Downloads all move it. No daemon, no watcher, no staleness window.

let cache = null;

function signature(roots, folders) {
  const parts = [`idx:${mtimeOf(path.join(DIR, 'index.json'))}`,
    `pages:${mtimeOf(path.join(DIR, 'pages'))}`,
    `snaps:${mtimeOf(path.join(DIR, 'snapshots'))}`];
  for (const root of roots) {
    for (const { file } of sessionFilesIn(root)) parts.push(`${file}:${mtimeOf(file)}`);
  }
  for (const dir of folders) {
    const files = [];
    walkFolder(dir, FOLDER_DEPTH, FOLDER_FILES_MAX, files);
    for (const f of files) parts.push(`${f}:${mtimeOf(f)}`);
  }
  return parts.join('|');
}

/** Everything the owner has, as index entries. Cached against mtimes. */
export function index({ fresh = false } = {}) {
  const cfg = readConfig();
  const roots = searchableRoots();
  const folders = watchedFolders(cfg);
  const sig = signature(roots, folders);
  if (!fresh && cache && cache.sig === sig) return cache.entries;
  const entries = [
    ...pageEntries(),
    ...chatEntries(roots),
    ...fileEntries(folders),
  ];
  cache = { sig, entries };
  return entries;
}

/** For the suites and for a companion that has just written a page. */
export const forget = () => { cache = null; };

/**
 * Search everything the owner has.
 *
 * Returns `{kind, id, title, url_or_path, hit, when}` rows, best first.
 * `hit` is the matching line, ≤160 characters — the whole of what a chip
 * shows, so a reader can tell a match from a coincidence without opening it.
 */
export function search(query, { limit = LASSO_LIMIT, fresh = false } = {}) {
  const words = terms(query);
  if (!words.length) return [];
  const rows = [];
  for (const e of index({ fresh })) {
    const s = score(e, words);
    if (!s) continue;
    rows.push({ entry: e, s, t: Date.parse(e.when || '') || 0 });
  }
  // score first, recency as the tiebreak — two chats that say the same thing
  // are ordered by which one said it more recently
  rows.sort((a, b) => (b.s - a.s) || (b.t - a.t));
  return rows.slice(0, Math.max(1, Math.min(50, limit))).map(({ entry }) => ({
    kind: entry.kind,
    id: entry.id,
    title: entry.title,
    url_or_path: entry.url_or_path,
    hit: hitLine(entry, words),
    when: entry.when,
    ...(entry.project ? { project: entry.project } : {}),
  }));
}

// ---- attaching ------------------------------------------------------------

export const slugify = s => String(s == null ? '' : s)
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'attachment';

/**
 * A path the owner named, resolved and checked.
 *
 * The owner may attach ANY readable file they can name — this runs on their
 * own machine, at their own request, and a "must be under $HOME" rule would
 * refuse the one paper on the external drive. What is refused is a path that
 * is not a file (a directory, a socket, a name for nothing) and one carrying
 * `..` — which is never how a person names a file they are looking at, and is
 * always how a browser tries to name one they are not.
 */
export function resolveOwnerPath(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { error: 'no path' };
  if (s.split(/[\\/]/).includes('..')) return { error: 'that path is not allowed' };
  if (!(s.startsWith('/') || s.startsWith('~'))) return { error: 'give an absolute path' };
  const abs = expandHome(s);
  if (!abs || !isFile(abs)) return { error: 'no such file' };
  return { path: abs };
}
/** Does this look like a path rather than words to search for? */
export const looksLikePath = s => /^\s*[~/]/.test(String(s == null ? '' : s));

// The digest, per kind. Everything here is written for a MODEL reading a file,
// not for a person reading a note: headings it can navigate, the whole text
// rather than an extract, and the conversation in the order it happened.

function pageDigest(page) {
  const key = pageKey(page.url);
  const lines = [`# ${displayTitle(page)}`, '', `- url: ${page.url}`];
  if (page.site) lines.push(`- site: ${page.site}`);
  if (page.updated_at) lines.push(`- last touched: ${page.updated_at}`);
  lines.push('');
  const body = hasSnapshot(key) ? htmlText(readSnapshot(key)) : '';
  if (body) {
    lines.push('## The page itself', '', body.slice(0, DIGEST_TEXT_MAX), '');
  } else {
    lines.push('## The page itself', '',
      '(no saved copy of this page — only the conversation below is on record)', '');
  }
  const threads = (page.threads || []).filter(t => (t.msgs || []).length);
  if (threads.length) {
    lines.push('## The margin', '');
    for (const t of threads) {
      lines.push(`### ${t.mark === 'strike' ? 'struck: ' : ''}“${clip(t.quote, 300)}”`
        + (Number(t.page) > 0 ? ` (p. ${Number(t.page)})` : ''));
      lines.push('');
      for (const m of t.msgs || []) {
        if (!m || !m.text) continue;
        lines.push(`**${m.author || 'someone'}:** ${String(m.text).trim()}`, '');
      }
    }
  }
  const chat = (page.page_chat || []).filter(m => m && m.text);
  if (chat.length) {
    lines.push('## Page chat', '');
    for (const m of chat) lines.push(`**${m.author || 'someone'}:** ${String(m.text).trim()}`, '');
  }
  const counts = [`${threads.length} thread${threads.length === 1 ? '' : 's'}`,
    `${chat.length} message${chat.length === 1 ? '' : 's'} of page chat`];
  return {
    text: lines.join('\n').trimEnd() + '\n',
    summary: clip(`A page the reader annotated: “${displayTitle(page)}” (${page.url}). `
      + `${counts.join(', ')}.${body ? ' The saved text of the page is in the file.' : ''}`,
    SUMMARY_MAX),
  };
}

function chatDigest(entry) {
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(entry.file, 'utf8')); } catch { return null; }
  if (!payload) return null;
  const title = String(payload.custom_title || payload.title || '').trim() || 'untitled chat';
  const pid = String(payload.project_id || '');
  const project = pid ? (projectTitle(entry.root, pid) || pid) : '';
  const lines = [`# ${title}`, ''];
  if (project) lines.push(`- project: ${project}`);
  lines.push(`- chat: ${payload.session_id || entry.sid}`);
  if (payload.updated_at) lines.push(`- last spoke: ${payload.updated_at}`);
  lines.push('', '## The conversation', '');
  const entries = Array.isArray(payload.transcript) && payload.transcript.length
    ? payload.transcript
    : (Array.isArray(payload.room_history) ? payload.room_history : []);
  let n = 0;
  for (const e of entries) {
    if (!e || !e.text) continue;
    const speaker = String(e.speaker || 'someone').toLowerCase();
    const text = speaker === 'user' ? stripEnvelope(String(e.text)) : String(e.text).trim();
    if (!text) continue;
    n++;
    lines.push(`**${speaker}:** ${text}`, '');
  }
  return {
    title,
    text: lines.join('\n').trimEnd() + '\n',
    summary: clip(`A council chat${project ? ` from the project “${project}”` : ''}: `
      + `“${title}”, ${n} message${n === 1 ? '' : 's'}.`, SUMMARY_MAX),
  };
}

/**
 * A file the reader named. The file itself is COPIED — a digest that merely
 * pointed at ~/Downloads would break the first time they tidied up — and, when
 * this machine can read a PDF's words, an extracted-text sidecar goes beside
 * it so a model that cannot open PDFs still gets the paper.
 */
function fileDigest(abs, dir, slug) {
  const ext = path.extname(abs).toLowerCase();
  const copy = path.join(dir, `${slug}${ext}`);
  fs.copyFileSync(abs, copy);
  let sidecar = '';
  if (ext === '.pdf') {
    const text = pdfText(abs, { chars: DIGEST_TEXT_MAX });
    if (text) {
      sidecar = path.join(dir, `${slug}.txt`);
      fs.writeFileSync(sidecar, text);
    }
  }
  let bytes = 0;
  try { bytes = fs.statSync(abs).size; } catch { /* 0 is honest enough */ }
  const kb = Math.max(1, Math.round(bytes / 1024));
  return {
    path: copy,
    sidecar,
    summary: clip(`A file of the reader's own: ${path.basename(abs)} (${kb} KB), copied from `
      + `${abs}.${sidecar ? ` Its extracted text is beside it at ${sidecar}.`
        : ext === '.pdf' ? ' Its text could not be extracted on this machine.' : ''}`,
    SUMMARY_MAX),
  };
}

/** Every attachment on a page record, in the order they were attached. */
export function attachmentsOf(page) {
  const raw = page && page.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.filter(a => a && typeof a === 'object' && a.path && a.title)
    .slice(0, ATTACHMENTS_MAX);
}

/**
 * BUILD one attachment's digest into `dir`, and describe it.
 *
 * The whole of what makes an attachment, with no record in sight — because
 * there are two records. A page's attachments live on the page (`attach`
 * below); the COUNCIL's live on the controller's own session record, in
 * Python, and it reaches this through `POST /attach {sid}` rather than
 * growing a second search index of its own (SPEC: do not duplicate the
 * index). Both get the same digest, written the same way.
 *
 * Answers `{kind, id, title, path, summary}` or `{error}`.
 */
export function buildAttachment(dir, { kind, id, notPage = '' }) {
  if (kind === 'page') {
    const src = readPageByKey(String(id || ''));
    if (!src) return { error: 'no such page' };
    if (notPage && pageKey(src.url) === notPage) {
      return { error: 'that page is the one you are reading — the bots already have it' };
    }
    const d = pageDigest(src);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slugify(`page-${displayTitle(src)}`)}.md`);
    fs.writeFileSync(file, d.text);
    return { kind: 'page', id: String(id), title: displayTitle(src), path: file, summary: d.summary };
  }
  if (kind === 'chat') {
    const sid = String(id || '');
    let found = null;
    for (const root of searchableRoots()) {
      const hit = sessionFilesIn(root).find(s => s.sid === sid);
      if (hit) { found = { ...hit, root }; break; }
    }
    if (!found) return { error: 'no such chat' };
    const d = chatDigest(found);
    if (!d) return { error: 'that chat could not be read' };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slugify(`chat-${d.title}`)}.md`);
    fs.writeFileSync(file, d.text);
    return { kind: 'chat', id: sid, title: d.title, path: file, summary: d.summary };
  }
  // A link the companion FETCHED for the reader (`/lasso https://…`). The
  // digest was written the moment the chip appeared — the fetch is the search
  // — so attaching it is a copy into this chat's own folder and no second
  // request over the network. A chip from a previous run of the companion (or
  // one whose digest has been tidied away) has to be lassoed again, and says
  // so rather than silently re-fetching a page the reader may not have meant.
  if (kind === 'web') {
    const held = heldWeb(id);
    if (!held) return { error: 'that link is no longer in hand — lasso it again' };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(held.path));
    if (path.resolve(file) !== path.resolve(held.path)) fs.copyFileSync(held.path, file);
    return { kind: 'web', id: held.id, title: held.title, path: file,
      summary: held.summary, url: held.url };
  }
  if (kind === 'file') {
    const r = resolveOwnerPath(id);
    if (r.error) return { error: r.error };
    const slug = slugify(`file-${path.basename(r.path, path.extname(r.path))}`);
    fs.mkdirSync(dir, { recursive: true });
    let d;
    try { d = fileDigest(r.path, dir, slug); }
    catch (e) { return { error: `that file could not be copied (${(e && e.code) || 'error'})` }; }
    return { kind: 'file', id: r.path, title: path.basename(r.path),
      path: d.path, summary: d.summary, ...(d.sidecar ? { text_path: d.sidecar } : {}) };
  }
  return { error: 'unknown kind' };
}

/** Where a council chat's digests are kept — the controller records the path. */
export const councilDir = sid =>
  path.join(ATTACH_DIR, `council-${String(sid).replace(/[^\w.-]/g, '')}`);

/**
 * Attach one thing to one page's chat.
 *
 * `{kind, id}` names what — a page key, a council sid, or (kind 'file') an
 * absolute path the owner typed. Answers `{ok:true, attachment}` or
 * `{error}`; attaching the same thing twice is a no-op that answers with what
 * is already there, so a double click costs nothing.
 */
export function attach(url, { kind, id }) {
  const page = readPage(url);
  if (!page) return { error: 'unknown page' };
  const key = pageKey(page.url);
  const dir = path.join(ATTACH_DIR, key);
  const existing = attachmentsOf(page);
  // already on this chat? then the click has already happened and nothing
  // needs writing — answer with what is there
  const same = a => a.kind === kind && (kind === 'file'
    ? a.id === (resolveOwnerPath(id).path || String(id)) : a.id === String(id));
  const already = existing.find(same);
  if (already) return { ok: true, attachment: already, page };
  if (existing.length >= ATTACHMENTS_MAX) {
    return { error: `this chat already carries ${ATTACHMENTS_MAX} attachments — detach one first` };
  }
  const built = buildAttachment(dir, { kind, id, notPage: key });
  if (built.error) return { error: built.error };
  built.at = new Date().toISOString();
  page.attachments = [...existing, built];
  savePage(page);
  return { ok: true, attachment: built, page };
}

/** Take one off. The digest file goes with it; the ORIGINAL is never touched. */
export function detach(url, filePath) {
  const page = readPage(url);
  if (!page) return { error: 'unknown page' };
  const want = String(filePath || '');
  const list = attachmentsOf(page);
  const hit = list.find(a => a.path === want);
  if (!hit) return { error: 'not attached' };
  const rest = list.filter(a => a !== hit);
  // Only ever inside our own attachments directory: the file we made is ours
  // to delete, and the reader's ~/Downloads copy is not.
  for (const p of [hit.path, hit.text_path]) {
    if (p && path.resolve(p).startsWith(path.resolve(ATTACH_DIR) + path.sep)) {
      try { fs.unlinkSync(p); } catch { /* already gone is the outcome we want */ }
    }
  }
  if (rest.length) page.attachments = rest;
  else delete page.attachments;
  savePage(page);
  return { ok: true, page, attachments: rest };
}

// ---- the envelope ---------------------------------------------------------
//
// The block that rides EVERY turn on a chat that has attachments — the same
// discipline as the snapshot path and the decision log, and for the same
// reason: a resumed session's replayed history is uneven, so the only thing a
// turn can rely on carrying is the turn.
//
// "never inline them back" is not politeness. Without it a model reads a
// 40-page digest and quotes half of it into a reply the reader has to scroll
// past — which is the failure the file-on-disk pattern exists to prevent.
export const ATTACH_HEADER =
  '[Attached for this chat — read with your file tool when relevant, never inline them back:]';

/** One line per attachment, summaries dropped whole once the block is too big. */
export function attachmentsBlock(attachments, { budget = ATTACH_BLOCK_MAX } = {}) {
  const rows = (Array.isArray(attachments) ? attachments : [])
    .filter(a => a && a.path && a.title).slice(0, ATTACHMENTS_MAX);
  if (!rows.length) return '';
  const full = `${ATTACH_HEADER}\n${rows.map(a =>
    `- ${a.title} (${a.kind}) — ${a.path}${a.summary ? ` — ${a.summary}` : ''}`).join('\n')}\n`;
  if (full.length <= budget) return full;
  const bare = `${ATTACH_HEADER}\n${rows.map(a =>
    `- ${a.title} (${a.kind}) — ${a.path}`).join('\n')}\n`;
  return bare;
}

// ---- the web: a link the reader pasted ------------------------------------
//
// THE FAILURE THIS FIXES. A reader typed `/lasso https://angadh.com/rockets-1`
// into a comment thread. The words of a URL are not the words of anything the
// reader owns, so the search matched almost nothing, offered the page they
// were standing on, and the bots — which cannot reach an arbitrary host from
// inside their sandbox — told them to run `/allow-host`, which is a council
// command that does not exist in a browser drawer. Three dead ends for one
// reasonable request.
//
// So a URL IS NOT A SEARCH. The companion fetches it itself, on this machine,
// at the owner's request, and hands back one chip carrying a digest file —
// the same shape everything else here produces, read the same way. Nothing
// about the bots' sandbox changes and nothing needs granting: the words are
// on disk before the turn goes out.
//
// The HTTP call is injectable (`http`) for the same reason every other edge in
// this tree is: a suite that needs a 403 must not need a server that gives one.

export const WEB_TIMEOUT_MS = 15000;
/** How much of a fetched body is kept. Past this it is not a page, it is a download. */
export const WEB_BYTES_MAX = 8 * 1024 * 1024;
/** How many links one message may drag in by itself (chat.mjs's auto-lasso). */
export const WEB_URLS_PER_MESSAGE = 3;
export const WEB_UA = 'Mozilla/5.0 (compatible; botference-plugin/1.0; +https://botference.com)';
/** Where a fetched link's digest goes when no chat asked for it by name. */
export const WEB_DIR = path.join(ATTACH_DIR, 'web');

/** An http(s) address, whole, with nothing else on the line. */
export function isHttpUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return false;
  try { return !!new URL(s).hostname; } catch { return false; }
}

export const hostOf = raw => {
  try { return new URL(String(raw)).hostname.replace(/^www\./, ''); } catch { return ''; }
};

// Trailing punctuation is the reader's sentence, not the address: "see
// https://x.com/a." names the page and not a path ending in a full stop.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
export function urlsIn(text, { max = WEB_URLS_PER_MESSAGE } = {}) {
  const out = [];
  const body = String(text == null ? '' : text);
  for (const m of body.match(URL_IN_TEXT) || []) {
    const u = m.replace(/[.,;:!?'"”’)\]}]+$/, '');
    if (!isHttpUrl(u)) continue;
    const n = normUrl(u);
    if (!out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

// ---- what the BOTS can reach on their own ---------------------------------
//
// Mirrors core/cli_adapters.py `_DEFAULT_PLAN_ALLOWED_HOSTS` and
// `_plan_allowed_hosts()`: the same defaults, the same
// BOTFERENCE_PLAN_ALLOWED_HOSTS override, and the same per-root grant file
// that `/allow-host` writes. Two copies of one list is a cost; the alternative
// is asking Python at turn-planning time, which is a worse one. If that list
// moves, this one moves with it.
export const DEFAULT_ALLOWED_HOSTS = [
  'github.com', '*.github.com', '*.githubusercontent.com',
  'codeload.github.com', 'objects.githubusercontent.com', 'api.github.com',
  'wikipedia.org', '*.wikipedia.org', 'wikimedia.org', '*.wikimedia.org',
  'ai-2040.com', '*.ai-2040.com',
];

/** The hosts `/allow-host` has granted under one council root. */
export function grantedHostsIn(root) {
  if (!root) return [];
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(
      path.join(root, '.botference', 'allowed-hosts.json'), 'utf8'));
  } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data.map(h => String(h || '').trim()).filter(Boolean);
}

/**
 * Every host the bots may reach from inside their sandbox.
 *
 * BOTH ROOTS, because a plugin turn can run on either child: this companion's
 * own root (where the plugin's pages project lives) and whichever council root
 * a filed page's lane belongs to. A grant made in either is a grant.
 */
export function allowedHosts({ roots = null } = {}) {
  const raw = String(process.env.BOTFERENCE_PLAN_ALLOWED_HOSTS || '').trim();
  const base = raw
    ? raw.split(',').map(s => s.trim()).filter(Boolean)
    : [...DEFAULT_ALLOWED_HOSTS];
  for (const root of roots || [ROOT, ...searchableRoots()]) {
    for (const h of grantedHostsIn(root)) if (!base.includes(h)) base.push(h);
  }
  return base;
}

/** Does one host match the allow-list? `*.x.com` covers x.com and its subdomains. */
export function hostAllowed(host, hosts) {
  const h = String(host == null ? '' : host).toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const raw of hosts || []) {
    const p = String(raw == null ? '' : raw).toLowerCase().trim();
    if (!p) continue;
    if (p.startsWith('*.')) {
      const bare = p.slice(2);
      if (h === bare || h.endsWith(`.${bare}`)) return true;
    } else if (h === p) return true;
  }
  return false;
}

// ---- fetching -------------------------------------------------------------

/**
 * The default transport. Answers `{ok, status, url, contentType, body}` —
 * exactly what an injected `http` must answer, so a suite can be a function.
 */
async function defaultHttp(url, { timeout = WEB_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
    headers: {
      'user-agent': WEB_UA,
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    },
  });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    ok: res.ok, status: res.status, url: res.url || url,
    contentType: res.headers.get('content-type') || '',
    body: body.length > WEB_BYTES_MAX ? body.subarray(0, WEB_BYTES_MAX) : body,
  };
}

const TITLE_RE = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]{0,400}?)<\/h1>/i;
const unent = s => String(s || '')
  .replace(/&nbsp;/gi, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The page's own name, or the tail of its address — never an empty chip. */
export function webTitle(html, url) {
  const m = TITLE_RE.exec(String(html || '')) || H1_RE.exec(String(html || ''));
  const t = m ? clip(unent(m[1].replace(/<[^>]*>/g, ' ')), 160) : '';
  if (t) return t;
  try {
    const u = new URL(String(url));
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return clip(decodeURIComponent(last).replace(/[-_]+/g, ' '), 160) || u.hostname;
  } catch { return String(url || 'a web page'); }
}

/**
 * Fetch one link and read its words.
 *
 * `{title, text, url, type}` or `{error, status}`. A failure is a SENTENCE,
 * not an empty result: "could not fetch: HTTP 403" is something a reader can
 * act on and `results: []` is not (this is the same rule the search obeys —
 * nothing found is a line that says so).
 *
 * HTML goes through the snapshot sanitizer first, so scripts, styles and
 * navigation chrome are gone before the tags are; a PDF goes through the same
 * `pdftotext` the watched-folder index uses, which means a machine without
 * poppler says so rather than attaching an empty file.
 */
export async function fetchWeb(url, { http = null, timeout = WEB_TIMEOUT_MS } = {}) {
  if (!isHttpUrl(url)) return { error: 'that is not a web address' };
  const get = typeof http === 'function' ? http : defaultHttp;
  let r = null;
  try { r = await get(String(url), { timeout }); }
  catch (e) {
    const why = String((e && (e.message || e.name)) || 'network error');
    return { error: `could not fetch: ${/abort|timeout/i.test(why) ? `no answer in ${Math.round(timeout / 1000)}s` : why}`, status: 0 };
  }
  if (!r) return { error: 'could not fetch: nothing came back', status: 0 };
  const status = Number(r.status) || 0;
  if (r.ok === false || (status && (status < 200 || status >= 300))) {
    return { error: `could not fetch: HTTP ${status || '?'}`, status };
  }
  const final = String(r.url || url);
  const type = String(r.contentType || '').toLowerCase();
  const raw = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body == null ? '' : r.body), 'utf8');
  const body = raw.length > WEB_BYTES_MAX ? raw.subarray(0, WEB_BYTES_MAX) : raw;
  if (type.includes('pdf') || /\.pdf(?:$|[?#])/i.test(final)) {
    if (!pdftotextAvailable()) {
      return { error: 'could not fetch: that is a PDF and this machine has no pdftotext', status };
    }
    const tmp = path.join(os.tmpdir(), `bfp-web-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`);
    let text = '';
    try {
      fs.writeFileSync(tmp, body);
      text = pdfText(tmp, { chars: DIGEST_TEXT_MAX });
    } catch { text = ''; }
    finally { try { fs.unlinkSync(tmp); } catch { /* a temp file is a temp file */ } }
    if (!text) return { error: 'could not fetch: no text could be read out of that PDF', status };
    return { title: webTitle('', final), text, url: final, type: 'pdf', status };
  }
  const html = body.toString('utf8');
  if (type && !type.includes('html') && !type.includes('text') && !type.includes('xml')) {
    return { error: `could not fetch: that link is not a page or a PDF (${clip(type, 60)})`, status };
  }
  const looksHtml = type.includes('html') || type.includes('xml') || /<\/?(?:html|body|p|div)\b/i.test(html);
  const text = looksHtml
    ? snapshotPdfText(sanitizeArticle(html, { allowImages: false }).html)
    : html.replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'could not fetch: nothing readable came back', status };
  return { title: webTitle(looksHtml ? html : '', final), text: text.slice(0, DIGEST_TEXT_MAX),
    url: final, type: looksHtml ? 'html' : 'text', status };
}

/** The digest a fetched link becomes — written for a model, like the others. */
export function webDigest({ url, title, text, at = new Date().toISOString() }) {
  const lines = [`# ${title}`, '', `- url: ${url}`, `- fetched: ${at}`,
    '- fetched by the companion on the reader\'s machine, not by you', '',
    '## The page itself', '', String(text || '').slice(0, DIGEST_TEXT_MAX), ''];
  return {
    text: lines.join('\n').trimEnd() + '\n',
    summary: clip(`A web page the companion fetched for the reader: “${title}” (${url}). `
      + 'The whole of its readable text is in the file.', SUMMARY_MAX),
  };
}

// What has been fetched in this run of the companion, by normalised url. The
// chip is an OFFER and the digest is already written when it appears, so the
// click that accepts it must not spend a second request — and must not be able
// to fetch something the reader never asked for by posting a url at /attach.
const webHeld = new Map();
export const heldWeb = url => webHeld.get(normUrl(String(url || ''))) || null;
export const forgetWeb = () => webHeld.clear();

/**
 * Fetch a link and write its digest. `{kind:'web', id, title, url, path,
 * summary, hit}` or `{error}`.
 */
export async function buildWeb(url, { dir = WEB_DIR, http = null, timeout = WEB_TIMEOUT_MS } = {}) {
  const got = await fetchWeb(url, { http, timeout });
  if (got.error) return { error: got.error, status: got.status || 0 };
  const id = normUrl(got.url);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slugify(`web-${got.title}`)}.md`);
  const d = webDigest({ url: got.url, title: got.title, text: got.text });
  fs.writeFileSync(file, d.text);
  const row = { kind: 'web', id, title: got.title, url: got.url, path: file,
    summary: d.summary, hit: clip(got.text, HIT_MAX) };
  webHeld.set(id, row);
  return row;
}

// ---- the one line above the chips -----------------------------------------
//
// "that is this page" is what the reader actually saw, and it is not a
// sentence about their search: it was an ATTACH failure leaking into the place
// a result header goes. So the header is composed in one place, from what
// happened, and every branch of it names the thing that happened.
export function headline(state = {}) {
  const { kind = 'search', query = '', count = 0, title = '', host = '', error = '' } = state;
  const q = String(query);
  const where = host ? ` (${host})` : '';
  if (kind === 'fetched') return `lasso · fetched “${title}”${where}`;
  if (kind === 'known') {
    return `lasso · you have annotated “${title}”${where} already — here is that page, `
      + 'with your comments on it';
  }
  if (kind === 'here') return 'lasso · that link is the page you are on — the bots already have it';
  if (kind === 'failed') return `lasso · ${error}${host ? ` — ${host}` : ''}`;
  if (kind === 'file') return `lasso · ${title}`;
  if (kind === 'error') return `lasso · ${error}`;
  if (count) return `lasso · ${count} match${count === 1 ? '' : 'es'} for “${q}”`;
  return `lasso · nothing matched “${q}” — try other words, or paste a link or a file path`;
}

/**
 * `/lasso <a url>` — the whole of it, header and chip.
 *
 * Three outcomes and never an empty one: the reader has this page already (a
 * `page` chip, whose digest carries their own comments too), the fetch worked
 * (a `web` chip), or it did not (a chip that says why, and what to do).
 */
export async function lassoUrl(query, { dir = WEB_DIR, http = null, notPage = '', timeout = WEB_TIMEOUT_MS } = {}) {
  const url = normUrl(String(query).trim());
  const host = hostOf(url);
  // theirs already? then the thing to hand over is the record, not the page —
  // it has the margin on it, which the live web page does not
  const known = readPage(url);
  const annotated = known && ((known.threads || []).some(t => (t.msgs || []).length)
    || (known.page_chat || []).length || hasSnapshot(pageKey(known.url)));
  if (known && annotated) {
    const key = pageKey(known.url);
    if (notPage && key === notPage) return { query, head: headline({ kind: 'here' }), results: [] };
    return {
      query,
      head: headline({ kind: 'known', title: displayTitle(known), host }),
      results: [{ kind: 'page', id: key, title: displayTitle(known),
        url_or_path: known.url, hit: clip(`your own copy — ${(known.threads || []).length} thread(s), `
          + `${(known.page_chat || []).length} message(s) of page chat`, HIT_MAX),
        when: String(known.updated_at || '') }],
    };
  }
  const row = await buildWeb(url, { dir, http, timeout });
  if (row.error) {
    return {
      query, error: row.error,
      head: headline({ kind: 'failed', error: row.error, host }),
      results: [{ kind: 'web', id: url, title: host || url, url_or_path: url,
        hit: `${row.error} — open it in the browser with the plugin once and lasso it by title`,
        when: '', failed: true }],
    };
  }
  return {
    query,
    head: headline({ kind: 'fetched', title: row.title, host }),
    results: [{ kind: 'web', id: row.id, title: row.title, url_or_path: row.url,
      hit: row.hit, when: new Date().toISOString() }],
  };
}

/**
 * The links in one message that the BOTS cannot reach, fetched for them.
 *
 * `{note, block, urls}` — one system line naming the hosts, plus the same
 * attachment lines every lassoed thing rides on. Nothing is recorded on the
 * page: this is for THIS turn, because the reader pasted a link into it, and a
 * link pasted once is not a standing fact about the page.
 *
 * A host the reader has already granted is skipped: the bots fetch those
 * themselves, and doing it for them would spend a request and tell them a
 * page they can read is a page they cannot.
 */
export async function webForTurn(text, { dir = WEB_DIR, http = null, hosts = null,
  max = WEB_URLS_PER_MESSAGE, timeout = WEB_TIMEOUT_MS } = {}) {
  const found = urlsIn(text, { max: max * 2 });
  if (!found.length) return { note: '', block: '', urls: [] };
  const allow = hosts || allowedHosts();
  const want = found.filter(u => !hostAllowed(hostOf(u), allow)).slice(0, max);
  if (!want.length) return { note: '', block: '', urls: [] };
  const rows = [];
  const notes = [];
  for (const u of want) {
    const host = hostOf(u);
    let row = null;
    try { row = await buildWeb(u, { dir, http, timeout }); }
    catch (e) { row = { error: `could not fetch: ${(e && e.message) || 'error'}` }; }
    if (row.error) {
      notes.push(`The link ${host} is not on your allow-list and the companion could not fetch `
        + `it either (${row.error}). Say so plainly if it matters; do not ask for a slash command.`);
      continue;
    }
    rows.push(row);
    notes.push(`The link ${host} is not on the bots' allow-list; the companion will fetch it for them.`);
  }
  return {
    note: notes.join('\n'),
    block: rows.length
      ? `${WEB_TURN_HEADER}\n${rows.map(r =>
        `- ${r.title} (web) — ${r.path} — ${r.summary}`).join('\n')}\n`
      : '',
    urls: rows.map(r => r.id),
  };
}
// Deliberately NOT the attachments header: nothing here is attached to the
// chat, and a model told "attached for this chat" will go on citing a page the
// reader mentioned once, three turns later.
export const WEB_TURN_HEADER =
  '[Fetched for THIS message only — the link(s) the reader just pasted, read with your '
  + 'file tool, never inlined back:]';

// ---- a bot asking for a search --------------------------------------------
//
// `lasso: <words>` on a line of its own, at the end of a reply. The same three
// rules as `file-in:` and `watch:` — a line of its own, the LAST one wins, the
// model's light markdown peeled off the ends — and the same discipline: the
// reader gets the matches and decides. Nothing is attached, nothing is read,
// and a bot that asks for a search it does not need has cost one directory
// listing.
export const LASSO_MARK = 'lasso:';
const LASSO_RE = /^\s*(?:[-*>]\s*)?lasso:\s*(.+)$/i;
const FENCE_RE = /```[\s\S]*?```/g;
export const LASSO_QUERY_MAX = 120;

const unwrap = raw => String(raw || '').trim()
  .replace(/^[-*>]\s+/, '')
  .replace(/^\*\*(.*)\*\*$/, '$1')
  .replace(/^`(.*)`$/, '$1')
  .trim();

/**
 * The search a reply asked for, or null.
 *
 * `{query, line}` — the words, and the raw line they came on, so the caller
 * can lift it out of the reply's words the way every other reply-line protocol
 * in this tree does (store.liftLines).
 */
export function parseLasso(text) {
  const body = String(text || '');
  const fenced = body.replace(FENCE_RE, m => m.replace(/[^\n]/g, ' '));
  let found = null;
  const lines = body.split(/\r?\n/);
  const masked = fenced.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const m = LASSO_RE.exec(unwrap(masked[i] || ''));
    if (!m) return;
    const q = String(m[1] || '').trim().replace(/[`*_]/g, '').trim().slice(0, LASSO_QUERY_MAX);
    // A bare `lasso:` with nothing after it is not a request; and `file-in:`,
    // `watch:`, `strike:` and `artifact:` are other protocols' lines, which
    // this regex has never matched and must never start to.
    if (q && terms(q).length) found = { query: q, line: raw };
  });
  return found;
}


