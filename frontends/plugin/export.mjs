// Obsidian export: one note per page, regenerated in place (idempotent
// overwrite) so re-exporting after a new comment never leaves a second copy.
import fs from 'node:fs';
import path from 'node:path';
// the routing rules, reused rather than re-guessed: what counts as a mention
// and who counts as a bot are decided in exactly one place
import { hasMention, isBotAuthor } from './chat.mjs';

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
const authored = msgs => msgs.map(m => `**${m.author}:** ${m.text}`).join('\n');
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

export function renderNote(page, cfg, now = new Date(), mode = 'all') {
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
      ? String(msgs[0].text) : authored(msgs));
  }
  // the page chat is a conversation with the bots from end to end, so
  // "comments only" has nothing to take from it
  const chat = only === 'comments' ? [] : readable(page.page_chat);
  if (chat.length) parts.push('## Page chat', authored(chat));
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

// One note per page whichever mode wrote it: re-exporting is a REPLACEMENT,
// so a reader who decides they wanted the conversation after all exports
// again and gets it, rather than collecting variants of the same page.
export function exportPage(page, cfg, now = new Date(), mode = 'all') {
  const dir = path.join(cfg.vault_path, cfg.export_folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = targetFile(dir, page.title || page.url, page.url);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, renderNote(page, cfg, now, mode));
  fs.renameSync(tmp, file);
  return file;
}
