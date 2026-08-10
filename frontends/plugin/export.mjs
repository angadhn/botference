// Obsidian export: one note per page, regenerated in place (idempotent
// overwrite) so re-exporting after a new comment never leaves a second copy.
import fs from 'node:fs';
import path from 'node:path';
// the routing rules, reused rather than re-guessed: what counts as a mention
// and who counts as a bot are decided in exactly one place
import { hasMention, isBotAuthor } from './chat.mjs';
import { isLibrary, pageKey, runDir } from './store.mjs';
// the same block parser the runner and the drawer use: a result is written
// under the fence it came out of, found by line number rather than re-guessed
import { codeBlocks } from './run.mjs';

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
const attribution = t => (t && Number(t.page) > 0 ? `\n> — p. ${Number(t.page)}` : '');

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

const bodyOf = (m, attach) => withRuns(m.text, m.runs, attach);
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
export const EXPORT_MODES = ['all', 'comments'];
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
export function renderNote(page, cfg, now = new Date(), mode = 'all', attach = null) {
  const author = (cfg && cfg.author) || 'angadh';
  const only = exportMode(mode);
  const parts = [
    ['---',
      `url: ${page.url}`,
      `site: ${page.site || ''}`,
      `saved: ${now.toISOString().slice(0, 10)}`,
      'tags: [botference-discuss]',
      '---'].join('\n'),
    `# ${page.title || page.url}`,
  ];
  for (const t of page.threads || []) {
    parts.push(blockquote(t.quote) + attribution(t));
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
function targetFile(dir, title, url) {
  const base = sanitizeTitle(title);
  for (let n = 1; n < 100; n++) {
    const file = path.join(dir, n === 1 ? `${base}.md` : `${base} (${n}).md`);
    let existing = '';
    try { existing = fs.readFileSync(file, 'utf8'); } catch { return file; }
    const m = /^url:\s*(.*)$/m.exec(existing.slice(0, 400));
    if (m && m[1].trim() === url) return file;
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
export function exportPage(page, cfg, now = new Date(), mode = 'all') {
  const dir = path.join(cfg.vault_path, cfg.export_folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = targetFile(dir, page.title || page.url, page.url);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, renderNote(page, cfg, now, mode, attacher(dir, page)));
  fs.renameSync(tmp, file);
  return file;
}
