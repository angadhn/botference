// Obsidian export: one note per page, regenerated in place (idempotent
// overwrite) so re-exporting after a new comment never leaves a second copy.
import fs from 'node:fs';
import path from 'node:path';
// the routing rules, reused rather than re-guessed: what counts as a mention
// and who counts as a bot are decided in exactly one place
import { hasMention, isBotAuthor } from './chat.mjs';
import { isLibrary, pageKey, runDir, displayTitle, tagsOf, whereParts,
  kindOf, readSnapshot, snapshotPdfText } from './store.mjs';
// the same block parser the runner and the drawer use: a result is written
// under the fence it came out of, found by line number rather than re-guessed
import { codeBlocks } from './run.mjs';
// a bot's capped answer keeps its long half in the note: the vault is where
// the whole thing is meant to live, so the marker comes out and both halves stay
import { stripMore } from './more.mjs';

// note names are article headlines, which contain everything a filesystem
// hates; keep the words, drop the punctuation that breaks paths
export function sanitizeTitle(title) {
  const s = String(title || '')
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 120)
    .trim();
  return s || 'Untitled';
}

const blockquote = q => String(q || '').split('\n')
  .map(l => (l.trim() ? `> ${l}` : '>')).join('\n');
// Where the passage came from, when the document has somewhere to come from.
// A quote out of a PDF without its page number is a quote you cannot check, so
// it rides inside the blockquote as its attribution line — the shape Obsidian
// (and everyone else) already renders as one. Articles have no pages and get
// nothing, which is why this is a suffix rather than a second renderer.
// …and the same line for a document with no pages: the heading the passage sat
// under, and which copy of the words it was where the words repeat. Articles
// used to get nothing here, which is why two notes quoting the same sentence
// from two places in one piece read as duplicates. A thread with neither still
// gets nothing, so every note written before this is byte-for-byte the one it
// always was.
const attribution = t => {
  if (t && Number(t.page) > 0) return `\n> — p. ${Number(t.page)}`;
  const w = whereParts(t).join(', ');
  return w ? `\n> (${w})` : '';
};
// …and WHAT WAS DONE to it. A struck passage is a suggested deletion, and the
// note has to say so or a year later it reads as an ordinary highlight. The
// quote itself is wrapped in `~~`, which is what every markdown renderer
// Obsidian included draws as a line through the words — the same mark the
// document, the drawer and the reading room all show.
const struck = t => !!(t && t.mark === 'strike');
const quoteBlock = t => (struck(t)
  ? blockquote('~~' + String(t.quote || '').replace(/\n+/g, ' ').trim() + '~~')
    + attribution(t) + '\n> *suggested deletion*'
  : blockquote(t.quote) + attribution(t));

// ---- what a code block printed --------------------------------------------
// A run's result belongs under the block it came from, in the note as on
// screen: a fenced ```python block, then what it printed, then its plots. The
// figures are COPIED into the vault (exportPage's `attach`) because a note that
// links into .botference/plugin/runs/ would go blank the first time a block was
// re-run — and because a vault is meant to survive the workspace it came from.
//
// A message with no `runs` (every message written before this existed) is
// returned byte-for-byte, so nothing about an ordinary note moved.
const fenceFor = text => {
  let longest = 0;
  for (const m of String(text).matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
};
const block = text => {
  const f = fenceFor(text);
  return `${f}text\n${String(text).replace(/\s+$/, '')}\n${f}`;
};
const RUN_STATUS = {
  error: r => `**exit ${r.exit}**`,
  timeout: () => '**timed out**',
  cancelled: () => '**stopped**',
  failed: () => '**could not start python**',
};

export function runNote(result, attach) {
  const r = result || {};
  const out = [];
  const status = RUN_STATUS[r.status];
  if (status) out.push(status(r));
  if (String(r.stdout || '').trim()) out.push(block(r.stdout));
  if (String(r.stderr || '').trim()) out.push('*stderr*\n' + block(r.stderr));
  const figures = Array.isArray(r.figures) ? r.figures : [];
  const links = [];
  for (let i = 0; i < figures.length; i++) {
    const rel = attach ? attach(r.run_id, figures[i]) : null;
    if (rel) links.push(`![figure ${i + 1}](${rel})`);
  }
  if (links.length) out.push(links.join('\n'));
  else if (figures.length) out.push(`*${figures.length} figure${figures.length === 1 ? '' : 's'}*`);
  return out.join('\n\n');
}

export function withRuns(text, runs, attach) {
  const src = String(text == null ? '' : text);
  if (!runs || typeof runs !== 'object' || !Object.keys(runs).length) return src;
  const blocks = codeBlocks(src);
  if (!blocks.length) return src;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  // after the closing fence of block N (its `close` line), the note gets what
  // that block printed — walked from the end so the earlier line numbers keep
  // meaning what they meant
  for (let i = blocks.length - 1; i >= 0; i--) {
    const note = runNote(runs[String(blocks[i].index)], attach);
    if (!note) continue;
    lines.splice(Math.min(blocks[i].close + 1, lines.length), 0, '', note);
  }
  return lines.join('\n');
}

const bodyOf = (m, attach) => withRuns(stripMore(m.text), m.runs, attach);
const authored = (msgs, attach) =>
  msgs.map(m => `**${m.author}:** ${bodyOf(m, attach)}`).join('\n');
// tool-activity summaries are process noise in a note: the drawer keeps them
// (collapsed), the vault does not
const readable = msgs => (msgs || []).filter(m => m.kind !== 'tools');

// ---- what goes in the note ------------------------------------------------
// Two modes, and the difference is a filter, not a second renderer:
//
//   'all'       everything, exactly as it always was
//   'comments'  the reading, without the conversation: no bot messages, and no
//               messages of your own that were addressed to a bot (a line
//               containing @claude/@codex/@all is a question, not a note).
//               Page chat goes entirely — it is bot conversation by nature.
//
// The highlight ALWAYS survives, for every thread, whether or not anything is
// left underneath it: the passage someone marked is the annotation, and a
// quote with no note under it still says "this mattered".
export const exportMode = m => (m === 'comments' ? 'comments' : 'all');

export function keptMsgs(msgs, mode) {
  const list = readable(msgs);
  if (exportMode(mode) !== 'comments') return list;
  return list.filter(m => m && !isBotAuthor(m.author) && !hasMention(m.text));
}

// `attach(run_id, figure)` → the path a copied figure has in the vault,
// relative to the note (or null: no copy was made, and the note says how many
// figures there were instead of pretending to show them). exportPage passes the
// copier; a caller that only wants the text passes nothing.
// ---- the tags line --------------------------------------------------------
// `botference-discuss` is what marks a note as one of ours and is always
// first, always present, never doubled. The reader's own tags follow it, in
// the order they were written, because the point of putting them in the
// frontmatter is that Obsidian then groups and searches them natively.
//
// A YAML flow sequence is not free-form text: a tag is written with its spaces
// turned into dashes (which is Obsidian's own tag spelling — a tag with a
// space in it is two tags to it), and quoted if anything left in it would
// break the brackets.
export const NOTE_TAG = 'botference-discuss';
const yamlTag = t => {
  const s = String(t).trim().replace(/\s+/g, '-');
  return /^[\w/&+.-]+$/.test(s) ? s : `"${s.replace(/["\\]/g, '\\$&')}"`;
};
export function tagsLine(page) {
  const out = [NOTE_TAG];
  const seen = new Set([NOTE_TAG.toLowerCase()]);
  for (const t of tagsOf(page)) {
    const v = yamlTag(t);
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return `tags: [${out.join(', ')}]`;
}

export function renderNote(page, cfg, now = new Date(), mode = 'all', attach = null) {
  const author = (cfg && cfg.author) || 'angadh';
  const only = exportMode(mode);
  const parts = [
    ['---',
      `url: ${page.url}`,
      `site: ${page.site || ''}`,
      // A PDF read off this disk has no url worth reading: its identity is a
      // content hash (`bfp-pdf://text/…` of its words; `bfp-pdf://sha256/…`
      // of a scan's bytes), which is exactly what makes it survive being
      // moved, renamed and re-saved — and exactly what tells a person
      // nothing. So the file it was opened from is named beside it. Written
      // only when there is one, so every note ever exported before this is
      // byte-for-byte what it was.
      ...(page.file_name ? [`file: ${page.file_name}`] : []),
      `saved: ${now.toISOString().slice(0, 10)}`,
      tagsLine(page),
      '---'].join('\n'),
    // the reader's own name for the page if they gave it one — the same title
    // the file is named after
    `# ${displayTitle(page)}`,
  ];
  for (const t of page.threads || []) {
    parts.push(quoteBlock(t));
    // A thread the reader filed says so, and says what it settled — the note
    // is the thing they will re-read in a year, and "we dealt with this, and
    // here is how" is most of what a resolved thread is worth by then. Plain
    // italic prose so a note without any resolved threads is byte-identical
    // to the one this always wrote.
    if (t.resolved) {
      parts.push(`*Resolved${t.resolved_by ? ` by ${t.resolved_by}` : ''}.*`
        + (t.summary ? ` ${t.summary}` : ''));
    }
    const msgs = keptMsgs(t.msgs, only);
    if (!msgs.length) continue;
    // a lone comment of your own reads as prose under its quote; anything
    // with a second voice in it needs the speakers named
    parts.push(msgs.length === 1 && msgs[0].author === author
      ? bodyOf(msgs[0], attach) : authored(msgs, attach));
  }
  // the page chat is a conversation with the bots from end to end, so
  // "comments only" has nothing to take from it
  const chat = only === 'comments' ? [] : readable(page.page_chat);
  // the library has no page under it: its conversation is not "the page chat",
  // it is the whole note
  if (chat.length) parts.push(isLibrary(page.url) ? '## Library chat' : '## Page chat', authored(chat, attach));
  return parts.join('\n\n') + '\n';
}

// <vault>/<folder>/<title>.md — unless a note of that name already belongs to
// a DIFFERENT url, in which case this page gets " (2)", " (3)", …
// The url is what identifies a note; its NAME is only a name. So before
// writing, ask which files in this folder already claim this url — normally
// exactly one, and normally the one we are about to write.
const noteUrl = file => {
  let head = '';
  try { head = fs.readFileSync(file, 'utf8').slice(0, 400); } catch { return ''; }
  const m = /^url:\s*(.*)$/m.exec(head);
  return m ? m[1].trim() : '';
};
export function notesForUrl(dir, url) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    if (noteUrl(file) === url) out.push(file);
  }
  return out;
}

// `urls` is every identity this page has ever had: the current one first,
// then prior_urls (a local PDF adopted from its byte-hash identity). A note
// claiming ANY of them is this page's note — matching only the current url
// would mint a " (2)" beside the note the old identity wrote.
function targetFile(dir, title, urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  const base = sanitizeTitle(title);
  for (let n = 1; n < 100; n++) {
    const file = path.join(dir, n === 1 ? `${base}.md` : `${base} (${n}).md`);
    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch { return file; }
    const m = /^url:\s*(.*)$/m.exec(existing.slice(0, 400));
    if (m && list.includes(m[1].trim())) return file;
  }
  return path.join(dir, `${base} (100).md`);
}

// A page's figures in the vault: <folder>/attachments/<pageKey>-<n>.<ext>,
// numbered in the order the note reaches them. Every previous copy for this
// page is removed first, so a re-export after deleting a plot does not leave
// the old one lying in the vault — the note and the attachments are one
// replacement, exactly as the note itself always has been.
export const ATTACH_DIR = 'attachments';
function attacher(dir, page) {
  const key = pageKey(page.url);
  const at = path.join(dir, ATTACH_DIR);
  try {
    for (const name of fs.readdirSync(at)) {
      if (name.startsWith(`${key}-`)) fs.rmSync(path.join(at, name), { force: true });
    }
  } catch { /* no attachments folder yet */ }
  let n = 0;
  return (runId, figure) => {
    const from = path.join(runDir(key, runId), figure);
    if (!runId || !fs.existsSync(from)) return null;
    const ext = path.extname(figure).toLowerCase() === '.svg' ? '.svg' : '.png';
    const name = `${key}-${++n}${ext}`;
    try {
      fs.mkdirSync(at, { recursive: true });
      fs.copyFileSync(from, path.join(at, name));
    } catch { return null; }
    return `${ATTACH_DIR}/${name}`;
  };
}

// One note per page whichever mode wrote it: re-exporting is a REPLACEMENT,
// so a reader who decides they wanted the conversation after all exports
// again and gets it, rather than collecting variants of the same page.
// …and a RENAME is still one note, which is the whole reason this looks at the
// folder rather than only at the name it is about to use: the note that holds
// this url was named after the old title, and the new one is a different file
// entirely. So the note is written under its new name and the old file — found
// by its url, whatever it was called and whichever " (2)" variant it was — is
// removed. Renaming a page must not leave two copies of it in the vault.
export function exportPage(page, cfg, now = new Date(), mode = 'all') {
  const dir = path.join(cfg.vault_path, cfg.export_folder);
  fs.mkdirSync(dir, { recursive: true });
  // every identity this page has answered to: a local PDF adopted onto its
  // text identity replaces the note its byte-hash identity wrote
  const urls = [page.url, ...(Array.isArray(page.prior_urls) ? page.prior_urls : [])];
  const held = urls.flatMap(u => notesForUrl(dir, u));
  const file = targetFile(dir, displayTitle(page), urls);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, renderNote(page, cfg, now, mode, attacher(dir, page)));
  fs.renameSync(tmp, file);
  for (const old of held) {
    if (old !== file) { try { fs.rmSync(old, { force: true }); } catch { /* leave it */ } }
  }
  return file;
}

// ---- the reading log: one row per paper -----------------------------------
// The vault keeps a reading log, <vault>/Clippings/read-links.md: a markdown
// table the Web Clipper appends one row to per article, and that the
// read-links-thread Obsidian plugin turns into the monthly "Links I consumed"
// site note. A PDF never passes through the Web Clipper, so a paper read here
// was missing from it. Exporting a PDF therefore also logs it: one row, tagged
// `papers`, with an exact word count and a wiki link to the note just written
// (the plugin prints "you can read more about my thoughts on this paper here"
// under it, but only when that note is a public one).
//
// Only PDFs. An article is the Web Clipper's job, and a second row for it from
// here would be a duplicate. Only an EXISTING log: a vault without one has not
// asked for this, so nothing is created. And append-only: a paper exported a
// second time updates its own row's Words and Note cells in place, padding
// kept, and every other row is left byte-for-byte alone.
export const READ_LOG = path.join('Clippings', 'read-links.md');
export const PAPER_TAG = 'papers';

// Words as the plugin counts them (read-links-thread's countWords): a run of
// letters or digits, apostrophes and hyphens inside it. The same rule on both
// sides, so a count written here is the count the plugin would have made.
export const countWords = text =>
  (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length;

// The paper's own identifier, when it says one: an arXiv url, else a DOI or an
// arXiv stamp near the top of the text (the first ~6000 characters, which is
// the first page or two: a DOI further down is far more likely a reference).
// → {label, link} or null. `label` goes in the Published cell; `link` is the
// row's url for a local PDF, which has no web address of its own.
const ARXIV_URL_RE = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?\/?(?:[?#]|$)/i;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>|]+)/;
const ARXIV_RE = /\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)/i;
const arxivId = id => ({ label: `arXiv:${id}`, link: `https://arxiv.org/abs/${id}` });
export function paperId(text, url) {
  const u = ARXIV_URL_RE.exec(String(url || ''));
  if (u) return arxivId(u[1]);
  const head = String(text || '').slice(0, 6000);
  const d = DOI_RE.exec(head);
  if (d) {
    let doi = d[1].replace(/[.,;:'"’”\]}>]+$/, '');
    // a closing bracket is the DOI's own only when it opened one
    while (doi.endsWith(')') && (doi.match(/\(/g) || []).length < (doi.match(/\)/g) || []).length) {
      doi = doi.slice(0, -1).replace(/[.,;:]+$/, '');
    }
    return { label: doi, link: `https://doi.org/${doi}` };
  }
  const a = ARXIV_RE.exec(head);
  return a ? arxivId(a[1]) : null;
}

// a cell is one line, and a bare pipe would end it
const cellText = s => String(s == null ? '' : s)
  .replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/(?<!\\)\|/g, '\\|');
const localDate = d => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
  String(d.getDate()).padStart(2, '0')].join('-');
const isWeb = u => /^https?:\/\//i.test(String(u || ''));

// The row for one exported paper, as values (not yet a line). `words` and
// `published` are what the extension measured in the viewer when it sent them
// (the live text layer, the PDF's metadata date); without them — an older
// extension, an export from the pages list — the companion's own snapshot of
// the words answers instead.
export function paperRow(page, notePath, { now = new Date(), text = '', words, published } = {}) {
  const id = paperId(text, page.url);
  const n = Math.floor(Number(words));
  const pub = cellText(published).slice(0, 80);
  return {
    date: localDate(now),
    published: pub || (id ? id.label : ''),
    title: displayTitle(page),
    url: isWeb(page.url) ? String(page.url) : (id ? id.link : ''),
    words: n > 0 ? n : countWords(text),
    note: path.basename(String(notePath || ''), '.md'),
  };
}

// The log's columns are found by header name, any order, exactly as the plugin
// finds them. First match per cell wins, and `note` is asked before `notes`
// (My comments), because "Note" would otherwise read as a comments column.
const LOG_FIELDS = [
  ['date', /^(date|read|clipped)$/i],
  ['published', /^published/i],
  ['link', /^(article|title|link)$/i],
  ['words', /^words?$/i],
  ['note', /^(note|notes? link|internal links?)$/i],
  ['notes', /^(my )?(comments?|notes?)$/i],
  ['tag', /^tags?$/i],
];
// the cells of one table line (an escaped pipe is part of its cell), or null
function logCells(line) {
  const t = String(line).trim();
  if (!t.startsWith('|')) return null;
  const ESC = '\u0000';
  return t.slice(1, t.endsWith('|') && !t.endsWith('\\|') ? -1 : undefined)
    .replace(/\\\|/g, ESC).split('|').map(c => c.split(ESC).join('|').trim());
}
function logColumns(cells) {
  const cols = {};
  cells.forEach((c, i) => {
    for (const [f, re] of LOG_FIELDS) {
      if (!(f in cols) && re.test(c)) { cols[f] = i; break; }
    }
  });
  return 'date' in cols && 'link' in cols ? cols : null;
}
const isSeparator = cells => cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
// url || title, the key the plugin collapses duplicate rows by
function rowKey(cell) {
  const m = /^\[(.*?)\]\((\S+?)\)$/.exec(cell);
  return m ? m[2] : cell;
}
// a line with one more cell on the end
const addCell = (line, value) => `${line.replace(/\s+$/, '').replace(/\|$/, '')}| ${value} |`;
// Cell `idx` of a row replaced in place: its span is found by walking the
// unescaped pipes, and the new value is padded to the old width so the table
// stays aligned. A row shorter than that gets blank cells up to it.
function setCell(line, idx, value) {
  const bars = [];
  for (let j = 0; j < line.length; j++) if (line[j] === '|' && line[j - 1] !== '\\') bars.push(j);
  let out = line;
  let have = Math.max(0, bars.length - 1);
  if (idx >= have) {
    while (have < idx) { out = addCell(out, ''); have++; }
    return addCell(out, value);
  }
  const start = bars[idx] + 1, end = bars[idx + 1];
  const width = end - start;
  const cell = ` ${value}`;
  return out.slice(0, start) + (cell.length < width ? cell.padEnd(width) : `${cell} `) + out.slice(end);
}

// Append (or update) one paper's row. → {logged, updated, reason?}
// `row` is what paperRow returns.
export function logPaperRow(logPath, row) {
  let text;
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return { logged: false, reason: 'no log' }; }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const link = row.url ? `[${cellText(row.title)}](${row.url})` : cellText(row.title);
  const key = row.url || String(row.title || '').replace(/\s+/g, ' ').trim();
  const note = row.note ? `[[${row.note}]]` : '';
  const words = row.words > 0 ? String(row.words) : '';

  let cols = null, width = 0, lastRow = -1, match = -1, matchCols = null, pendingSep = false;
  for (let i = 0; i < lines.length; i++) {
    const cells = logCells(lines[i]);
    if (!cells) { pendingSep = false; continue; }
    lastRow = i;
    const h = logColumns(cells);
    if (h) {
      // the header gains a Note column on the end if it has none
      if (!('note' in h)) {
        h.note = cells.length;
        lines[i] = addCell(lines[i], 'Note');
        pendingSep = true;
      } else pendingSep = false;
      cols = h; width = Math.max(cells.length, h.note + 1);
      continue;
    }
    if (isSeparator(cells)) {
      if (pendingSep) lines[i] = addCell(lines[i], '---');
      pendingSep = false;
      continue;
    }
    pendingSep = false;
    if (!cols) continue;
    const at = rowKey(cells[cols.link] || '');
    if (at && at === key) { match = i; matchCols = cols; }
  }
  if (!cols) return { logged: false, reason: 'no table header' };

  if (match >= 0) {
    let line = lines[match];
    if ('words' in matchCols && words) line = setCell(line, matchCols.words, words);
    line = setCell(line, matchCols.note, note);
    lines[match] = line;
  } else {
    const cells = new Array(width).fill('');
    const put = (f, v) => { if (f in cols) cells[cols[f]] = v; };
    put('date', row.date);
    put('published', cellText(row.published));
    put('link', link);
    put('words', words);
    put('tag', PAPER_TAG);
    put('note', note);
    lines.splice(lastRow + 1, 0, `| ${cells.join(' | ')} |`.replace(/ {2,}\|/g, ' |'));
  }
  const out = lines.join(eol);
  if (out !== text) {
    const tmp = `${logPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, logPath);
  }
  return { logged: true, updated: match >= 0 };
}

// What POST /export calls after the note is written. `extra` is what the
// extension measured ({words, published}), either of which may be missing.
// → {logged, log}: `log` is the log's path for a PDF, '' for anything else.
export function logExportedPaper(page, notePath, cfg, now = new Date(), extra = {}) {
  if (!page || kindOf(page) !== 'pdf' || !cfg || !cfg.vault_path) return { logged: false, log: '' };
  const log = path.join(cfg.vault_path, READ_LOG);
  let text = '';
  try { text = snapshotPdfText(readSnapshot(pageKey(page.url))); } catch { text = ''; }
  const row = paperRow(page, notePath, { now, text, words: extra.words, published: extra.published });
  return { logged: logPaperRow(log, row).logged, log };
}
