// Obsidian export: one note per page, regenerated in place (idempotent
// overwrite) so re-exporting after a new comment never leaves a second copy.
import fs from 'node:fs';
import path from 'node:path';

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
const authored = msgs => msgs.map(m => `**${m.author}:** ${m.text}`).join('\n');
// tool-activity summaries are process noise in a note: the drawer keeps them
// (collapsed), the vault does not
const readable = msgs => (msgs || []).filter(m => m.kind !== 'tools');

export function renderNote(page, cfg, now = new Date()) {
  const author = (cfg && cfg.author) || 'angadh';
  const parts = [
    ['---',
      `url: ${page.url}`,
      `site: ${page.site || ''}`,
      `saved: ${now.toISOString().slice(0, 10)}`,
      'tags: [web-annotation]',
      '---'].join('\n'),
    `# ${page.title || page.url}`,
  ];
  for (const t of page.threads || []) {
    parts.push(blockquote(t.quote));
    const msgs = readable(t.msgs);
    if (!msgs.length) continue;
    // a lone comment of your own reads as prose under its quote; anything
    // with a second voice in it needs the speakers named
    parts.push(msgs.length === 1 && msgs[0].author === author
      ? String(msgs[0].text) : authored(msgs));
  }
  const chat = readable(page.page_chat);
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

export function exportPage(page, cfg, now = new Date()) {
  const dir = path.join(cfg.vault_path, cfg.export_folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = targetFile(dir, page.title || page.url, page.url);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, renderNote(page, cfg, now));
  fs.renameSync(tmp, file);
  return file;
}
