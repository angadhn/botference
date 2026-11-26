// clippings.mjs — THE OWNER'S CLIPPINGS for the Hub's Reading list: articles clipped into a folder of the owner's notes (Obsidian Web
// Clipper: front matter with `source`, `title`, `author`, `published`, then the article as markdown). The hub link reads ONLY the files
// the owner allow-listed on this computer, by name, in named collections; it never lists the folder.
//
// THE SETTING (`clippings` in the companion's config.json, changed only on this machine; `botference clippings check | list`):
//   { "folder": "/absolute/path/to/the/clippings/folder",
//     "collections": [ { "name": "A name", "files": ["A clipped article.md", "Another one.md"] } ] }
// A file name is a plain name inside that folder: no separator, no `..`, not hidden; read only when its real path is a plain file
// directly inside the folder's real path (a symlink out is refused) and at most CLIPPING_LIMITS.fileBytes.
//
// A CLIPPING'S ID is the first 16 hex of sha256 of its file name: stable while the file keeps its name, and never the name or a path.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bindablePassage } from './blyg.mjs';

export const CLIPPING_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,    // one clipping file
  pageChars: 40000,          // one page of markdown in a `clipping` answer
  collections: 20,
  filesPerCollection: 100,
  nameChars: 80,
  titleChars: 200,
  authorChars: 120,
});
export const clippingId = name => crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 16);
const plainName = n => typeof n === 'string' && n.length > 0 && n.length <= 255 && !/[\/\\\0]/.test(n) && n !== '.' && n !== '..' && !n.startsWith('.');

/** The setting checked: → { ok, errors (sentences), settings }. */
export function validateClippings(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['the clippings setting is not set (an object with "folder" and "collections")'], settings: null };
  const folder = typeof raw.folder === 'string' ? raw.folder : '';
  if (!folder || !path.isAbsolute(folder)) errors.push('"folder" must be an absolute path');
  else { try { if (!fs.statSync(folder).isDirectory()) errors.push('"folder" is not a folder'); } catch { errors.push('"folder" is not there'); } }
  const cols = Array.isArray(raw.collections) ? raw.collections : null;
  if (!cols || !cols.length) errors.push('"collections" must be a list of at least one collection');
  else if (cols.length > CLIPPING_LIMITS.collections) errors.push(`at most ${CLIPPING_LIMITS.collections} collections`);
  (cols || []).forEach((c, i) => {
    const at = `collection ${i + 1}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${at} must be { "name", "files" }`); return; }
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > CLIPPING_LIMITS.nameChars) errors.push(`${at}: "name" must be 1 to ${CLIPPING_LIMITS.nameChars} characters`);
    const files = Array.isArray(c.files) ? c.files : null;
    if (!files || !files.length) { errors.push(`${at}: "files" must be a list of file names`); return; }
    if (files.length > CLIPPING_LIMITS.filesPerCollection) errors.push(`${at}: at most ${CLIPPING_LIMITS.filesPerCollection} files`);
    const seen = new Set();
    for (const f of files) {
      if (!plainName(f)) errors.push(`${at}: ${JSON.stringify(f)} is not a plain file name (no folders, no "..", not hidden)`);
      else if (seen.has(f)) errors.push(`${at}: ${JSON.stringify(f)} is listed more than once`);
      seen.add(f);
    }
  });
  return { ok: !errors.length, errors, settings: errors.length ? null : { folder, collections: cols.map(c => ({ name: c.name.trim(), files: c.files.slice() })) } };
}

/** One file, by its plain name, inside the folder: → { problem: '' | a sentence, raw } (raw: the file's text). */
export function readClipping(folder, name) {
  if (!plainName(name)) return { problem: 'not a plain file name', raw: '' };
  let realFolder;
  try { realFolder = fs.realpathSync(folder); } catch { return { problem: 'the folder is not there', raw: '' }; }
  const file = path.join(realFolder, name);
  let st;
  try { st = fs.lstatSync(file); } catch { return { problem: 'not there', raw: '' }; }
  if (!st.isFile() || st.isSymbolicLink()) return { problem: 'not a plain file inside the folder', raw: '' };
  let real;
  try { real = fs.realpathSync(file); } catch { return { problem: 'not there', raw: '' }; }
  if (path.dirname(real) !== realFolder) return { problem: 'not a plain file inside the folder', raw: '' };
  if (st.size > CLIPPING_LIMITS.fileBytes) return { problem: `larger than ${CLIPPING_LIMITS.fileBytes} bytes`, raw: '' };
  try { return { problem: '', raw: fs.readFileSync(real, 'utf8') }; } catch { return { problem: 'could not be read', raw: '' }; }
}

// ---- the front matter: the few keys Obsidian Web Clipper writes, one line or a list of `- ` lines --------------------------------
function frontMatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const fm = {};
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; fm[key] = kv[2].trim() ? unquote(kv[2].trim()) : []; continue; }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key && Array.isArray(fm[key])) fm[key].push(unquote(item[1].trim()));
  }
  return { fm, body: raw.slice(m[0].length) };
}
const unquote = v => (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v) ? v.slice(1, -1) : v);
const oneLine = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const authorOf = a => (Array.isArray(a) ? a : a ? [a] : []).map(x => String(x).replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean).join(', ');

// ---- the canonical source address (tracking-v1) ----------------------------------------------------------------------------------
export const TRACKING_PARAMS = Object.freeze(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 's', 'r', 'triedRedirect', 'publication_id', 'post_id', 'isFreemail', 'sd', 'showWelcomeOnShare']);
export const CANONICAL_RULE = 'tracking-v1';
export function canonicalSource(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || TRACKING_PARAMS.includes(k)) u.searchParams.delete(k);
  return u.href.replace(/\?$/, '');
}

// ---- the plain text (clippingText v1): what a quote is checked against, and what the Hub may show for selection ------------------
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
/** Rules 6 to 8 of WIRE-clip.md, on one paragraph (also applied to a quote): escapes and entities, then the marks, then white space. */
export function marksOff(t) {
  return String(t)
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~&])/g, '$1')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m => ENTITIES[m])
    .replace(/[*~`]/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1')
    .replace(/\s+/g, ' ').trim();
}
export function clippingText(md) {
  const body = frontMatter(String(md || '')).body;
  const lines = body.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (/^<.*>$/.test(t)) return null;                                                            // an HTML-only line
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return null;                                             // a thematic break
    if (/^(\[)?!\[[^\]]*\]\([^)]*\)(\]\([^)]*\))?$/.test(t)) return null;                          // an image-only line
    let s = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                                                       // inline images
      .replace(/\[\^[^\]]+\]:\s*/g, '')                                                           // a footnote definition's label
      .replace(/\[\^[^\]]+\]/g, '')                                                               // footnote references
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                                                    // links
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')                                                   // autolinks
      .replace(/<\/?[A-Za-z][^>]*>/g, '');                                                        // other inline HTML tags
    s = s.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '');                          // heading, quote, list marks
    return s;
  });
  const paras = [];
  let cur = [];
  for (const l of lines) {
    if (l === null) continue;
    if (!l.trim()) { if (cur.length) paras.push(cur.join(' ')); cur = []; continue; }
    cur.push(l);
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras.map(marksOff).filter(Boolean).join('\n\n');
}
/** Is the passage the clipping's own text? Its paragraphs through the same rules, each found in order, joined as in the text. */
export function passageInClipping(text, quote) {
  const parts = String(quote || '').split(/\r?\n/).map(marksOff).filter(Boolean);
  if (!parts.length || !bindablePassage(parts.join(' '))) return false;
  const flat = String(text).replace(/\n\n/g, '\n');
  return flat.includes(parts.join('\n')) || String(text).replace(/\n\n/g, ' ').includes(parts.join(' '));
}
/** The passage as it is kept on the thread: its paragraphs through the rules, joined by a line break. */
export const passageOfClipping = quote => String(quote || '').split(/\r?\n/).map(marksOff).filter(Boolean).join('\n');

// ---- the pages of a `clipping` answer ------------------------------------------------------------------------------------------------
export function pagesOf(body) {
  const max = CLIPPING_LIMITS.pageChars;
  const paras = String(body).split(/\n\n/);
  const pages = [];
  let cur = '';
  const flush = () => { if (cur) pages.push(cur); cur = ''; };
  for (const p of paras) {
    if (p.length > max) { flush(); for (let i = 0; i < p.length; i += max) pages.push(p.slice(i, i + max)); continue; }
    if (cur && cur.length + 2 + p.length > max) flush();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return pages.length ? pages : [''];
}

// ---- the list and one clipping -------------------------------------------------------------------------------------------------------
const wordsOf = t => (String(t).match(/\S+/g) || []).length;
/** One allow-listed file read and understood: → { facts, body, text } or { problem }. */
export function loadClipping(folder, name) {
  const r = readClipping(folder, name);
  if (r.problem) return { problem: r.problem };
  const { fm, body } = frontMatter(r.raw);
  const source = canonicalSource(typeof fm.source === 'string' ? fm.source : '');
  if (!source) return { problem: 'no usable source' };
  const text = clippingText(r.raw);
  const published = typeof fm.published === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fm.published) ? fm.published.slice(0, 10) : '';
  return { facts: { id: clippingId(name), title: oneLine(typeof fm.title === 'string' ? fm.title : name.replace(/\.md$/i, ''), CLIPPING_LIMITS.titleChars),
    author: oneLine(authorOf(fm.author), CLIPPING_LIMITS.authorChars), source, published, words: wordsOf(text) }, body, text };
}
/** The collections as the Hub sees them, and (for the owner's check) each file left out and why. */
export function listClippings(settings) {
  const collections = [], problems = [];
  for (const c of settings.collections) {
    const got = [];
    for (const f of c.files) {
      const l = loadClipping(settings.folder, f);
      if (l.problem) problems.push({ collection: c.name, file: f, problem: l.problem }); else got.push(l.facts);
    }
    got.sort((a, b) => (a.published || '9999').localeCompare(b.published || '9999') || a.title.localeCompare(b.title));
    collections.push({ name: c.name, clippings: got });
  }
  return { collections, problems };
}
/** An allow-listed clipping by id: → { name, facts, body, text } or null. */
export function findClipping(settings, id) {
  if (!settings || !/^[0-9a-f]{16}$/.test(String(id || ''))) return null;
  for (const c of settings.collections) for (const f of c.files) {
    if (clippingId(f) !== id) continue;
    const l = loadClipping(settings.folder, f);
    return l.problem ? null : { name: f, ...l };
  }
  return null;
}
