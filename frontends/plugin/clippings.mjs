// clippings.mjs — THE OWNER'S CLIPPINGS for the Hub's Reading list: articles clipped into a folder of the owner's notes (Obsidian Web
// Clipper: front matter with `source`, `title`, `author`, `published`, then the article as markdown). The hub link reads ONLY the files
// the owner allow-listed on this computer, by name, in named collections; it never lists the folder.
//
// THE SETTING (`clippings` in the companion's config.json, changed only on this machine; `botference clippings check | list`):
//   { "folder": "/absolute/path/to/the/clippings/folder",
//     "collections": [ { "name": "A name", "files": ["A clipped article.md", "Another one.md"] } ],
//     "substack_hosts": ["www.example.com"],       (optional) Substack custom domains: Substack's own parameters are removed there
//     "confirmed_sources": ["https://…"] }        (optional) addresses the owner checked after a secret-named part was taken out
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
  const hosts = raw.substack_hosts === undefined ? [] : raw.substack_hosts;
  if (!Array.isArray(hosts) || !hosts.every(h => typeof h === 'string' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(h)) || hosts.length > 50) errors.push('"substack_hosts" must be a list of host names (lower case, like www.example.com)');
  const confirmed = raw.confirmed_sources === undefined ? [] : raw.confirmed_sources;
  if (!Array.isArray(confirmed) || !confirmed.every(u => typeof u === 'string' && /^https?:\/\//.test(u) && u.length <= 2048) || confirmed.length > 500) errors.push('"confirmed_sources" must be a list of addresses, as `botference clippings check` shows them');
  return { ok: !errors.length, errors, settings: errors.length ? null : { folder, collections: cols.map(c => ({ name: c.name.trim(), files: c.files.slice() })),
    substack_hosts: hosts.slice(), confirmed_sources: confirmed.slice() } };
}

/** One file, by its plain name, inside the folder, read FROM ITS OPEN DESCRIPTOR: opened with O_NOFOLLOW (a symlink is refused), then
 *  that open file checked (a regular file, ONE link, so a hard link to a file elsewhere is refused, at most the cap) and at most the
 *  cap read from it. → { problem: '' | a sentence, raw, stat } */
export function readClipping(folder, name) {
  if (!plainName(name)) return { problem: 'not a plain file name', raw: '' };
  let realFolder;
  try { realFolder = fs.realpathSync(folder); } catch { return { problem: 'the folder is not there', raw: '' }; }
  let fd;
  try { fd = fs.openSync(path.join(realFolder, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (e) { return { problem: e && e.code === 'ENOENT' ? 'not there' : 'not a plain file inside the folder', raw: '' }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return { problem: 'not a plain file inside the folder', raw: '' };
    if (st.size > CLIPPING_LIMITS.fileBytes) return { problem: `larger than ${CLIPPING_LIMITS.fileBytes} bytes`, raw: '' };
    const buf = Buffer.alloc(CLIPPING_LIMITS.fileBytes + 1);
    let n = 0, got;
    while (n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, n)) > 0) n += got;
    if (n > CLIPPING_LIMITS.fileBytes) return { problem: `larger than ${CLIPPING_LIMITS.fileBytes} bytes`, raw: '' };
    stats.reads++;
    return { problem: '', raw: buf.subarray(0, n).toString('utf8'), stat: st };
  } catch { return { problem: 'could not be read', raw: '' }; } finally { try { fs.closeSync(fd); } catch { /* closed */ } }
}
const stats = { reads: 0 };
/** (tests) how many files have been read */
export const clippingStats = () => ({ reads: stats.reads });

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

// ---- the canonical source address (tracking-v3) ----------------------------------------------------------------------------------
// The page's own address with what only tracks a reader, or carries a secret, taken out of the RAW query (what stays is never decoded
// or re-encoded): the fragment; on every host `utm_*` and the click ids (CLICK_IDS); Substack's own names only on Substack's hosts
// (under substack.com, and the hosts the owner names in the setting, `substack_hosts`: a custom domain cannot be told by its look); and
// SECRETS on every host (named in `dropped`: such a drop may change which page the address names, so the clipping is publishable only
// once the owner has confirmed its address, `confirmed_sources`). A parameter's name is read decoded, with control characters and
// white space taken out and any leading `amp;` (an `&amp;` left in an address) removed. An address with a user or a password is
// refused whole.
export const CANONICAL_RULE = 'tracking-v3';
export const CLICK_IDS = Object.freeze(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid']);
export const SECRET_PARAMS = Object.freeze(['token', 'access_token', 'refresh_token', 'id_token', 'auth', 'auth_token', 'key', 'api_key', 'apikey',
  'sig', 'signature', 'secret', 'password', 'pass', 'session', 'sessionid', 'jwt', 'code']);
export const SUBSTACK_PARAMS = Object.freeze(['s', 'r', 'triedRedirect', 'publication_id', 'post_id', 'isFreemail', 'sd', 'showWelcomeOnShare']);
const isSubstackHost = (host, named) => /(^|\.)substack\.com$/.test(host) || named.includes(host);
const nameOf = piece => {
  const k = piece.split('=')[0];
  let n;
  try { n = decodeURIComponent(k.replace(/\+/g, ' ')); } catch { n = k; }
  n = n.replace(/[\u0000-\u001f\u007f\s]/g, '');
  while (/^amp;/i.test(n)) n = n.slice(4);
  return n;
};
/** → { url, dropped (secret names taken out) } ('' when it cannot be used). `substackHosts`: the owner's `substack_hosts`. */
export function canonicalSourceOf(raw, { substackHosts = [] } = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { url: '', dropped: [] }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: '', dropped: [] };
  if (u.username || u.password) return { url: '', dropped: [] };
  const platform = isSubstackHost(u.hostname, substackHosts) ? SUBSTACK_PARAMS : [];
  const dropped = [];
  const kept = (u.search ? u.search.slice(1).split('&') : []).filter(piece => {
    if (!piece) return false;
    const n = nameOf(piece);
    if (SECRET_PARAMS.includes(n.toLowerCase())) { dropped.push(n.toLowerCase()); return false; }
    return !(/^utm_/i.test(n) || CLICK_IDS.includes(n.toLowerCase()) || platform.includes(n));
  });
  return { url: `${u.origin}${u.pathname}${kept.length ? `?${kept.join('&')}` : ''}`, dropped };
}
export const canonicalSource = (raw, opts) => canonicalSourceOf(raw, opts).url;
/** May a reply to this clipping be published? Unless a secret-named parameter was dropped from its address (which may name another
 *  page then), or the owner has confirmed the address as it now is (`confirmed_sources`). */
export const clippingPublishable = (settings, c) => !!c && (!c.dropped.length || ((settings && settings.confirmed_sources) || []).includes(c.facts.source));

// ---- the plain text (clippingText v2): what a quote is checked against, and what the Hub may show for selection ------------------
// v2 = v1 with every inside BOUNDED, as the Hub writes it (WIRE-clip.md "clippingText v2"): a bracket's or a tag's insides at most
// CLIP_BOUNDS.inside characters, an address at most .address, a footnote label 1 to .label; nothing crosses a line end. Past a bound
// the mark is not taken out (its characters stay, on both sides alike).
export const CLIP_BOUNDS = Object.freeze({ inside: 500, address: 2000, label: 100 });
const B = CLIP_BOUNDS;
// EVERY RULE IS ONE LINEAR PASS (the same output as the regular expressions WIRE-clip.md writes them as, which were quadratic on a
// paragraph of unclosed `[`, `![`, `[^` or `<a `): each pass walks its string once with a table of where the next `]`, `)`, `>` (or
// space) is, so a match is decided at each place in constant time. There is no paragraph cap: a hostile 1 MiB file takes
// milliseconds (test/clippings.test.mjs times it).
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
/** where the next character satisfying `test` is, from each position (-1: none), in one backward pass */
function nextOf(s, test) {
  const at = new Int32Array(s.length + 1).fill(-1);
  for (let i = s.length - 1; i >= 0; i--) at[i] = test(s[i]) ? i : at[i + 1];
  return at;
}
/** Rules 6 to 8 of WIRE-clip.md, on one paragraph (also applied to a quote): escapes and entities, then the marks, then white space. */
export function marksOff(t) {
  const s = String(t)
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~&])/g, '$1')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m => ENTITIES[m])
    .replace(/[*~`]/g, '')
    // (this one is linear as it is: a run of `_` is taken whole at its first character, never retried from inside it)
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1');
  return s.replace(/\s+/g, ' ').trim();
}
// the inline passes, each linear, each the leftmost non-overlapping matches of its pattern
function imagesOff(s) {                       // !\[[^\]\n]{0,500}\]\([^)\n]{0,2000}\)  → ''
  const rb = nextOf(s, c => c === ']'), rp = nextOf(s, c => c === ')');
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] === '!' && s[i + 1] === '[') {
      const j = rb[i + 2];
      if (j >= 0 && j - (i + 2) <= B.inside && s[j + 1] === '(') { const k = rp[j + 2]; if (k >= 0 && k - (j + 2) <= B.address) { i = k + 1; continue; } }
    }
    out += s[i]; i++;
  }
  return out;
}
function footnotesOff(s, definition) {         // \[\^[^\]\n]{1,100}\]:\s*  (definition) or \[\^[^\]\n]{1,100}\]  → ''
  const rb = nextOf(s, c => c === ']');
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] === '[' && s[i + 1] === '^') {
      const j = rb[i + 2];
      if (j > i + 2 && j - (i + 2) <= B.label && (!definition || s[j + 1] === ':')) {
        let k = j + 1;
        if (definition) { k = j + 2; while (k < s.length && /\s/.test(s[k])) k++; }
        i = k; continue;
      }
    }
    out += s[i]; i++;
  }
  return out;
}
function linksOff(s) {                         // \[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)  → $1
  const rb = nextOf(s, c => c === ']'), rp = nextOf(s, c => c === ')');
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] === '[') {
      const j = rb[i + 1];
      if (j >= 0 && j - (i + 1) <= B.inside && s[j + 1] === '(') { const k = rp[j + 2]; if (k >= 0 && k - (j + 2) <= B.address) { out += s.slice(i + 1, j); i = k + 1; continue; } }
    }
    out += s[i]; i++;
  }
  return out;
}
function autolinksOff(s) {                     // <(https?:\/\/[^>\s]{1,2000})>  → $1
  const stop = nextOf(s, c => c === '>' || /\s/.test(c));
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] === '<') {
      const p = s.startsWith('https://', i + 1) ? 9 : s.startsWith('http://', i + 1) ? 8 : 0;
      if (p) { const k = stop[i + p]; if (k > i + p && k - (i + p) <= B.address && s[k] === '>') { out += s.slice(i + 1, k); i = k + 1; continue; } }
    }
    out += s[i]; i++;
  }
  return out;
}
function tagsOff(s) {                          // <\/?[A-Za-z][^>\n]{0,500}>  → ''
  const gt = nextOf(s, c => c === '>');
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] === '<') {
      const l = s[i + 1] === '/' ? i + 2 : i + 1;
      if (/[A-Za-z]/.test(s[l] || '')) { const k = gt[l + 1]; if (k >= 0 && k - (l + 1) <= B.inside) { i = k + 1; continue; } }
    }
    out += s[i]; i++;
  }
  return out;
}
/** an image-only line, `^(\[)?!\[[^\]\n]{0,500}\]\([^)\n]{0,2000}\)(\]\([^)\n]{0,2000}\))?$`, decided in one pass */
function imageOnly(t) {
  let i = t[0] === '[' ? 1 : 0;
  const img = () => {
    if (t[i] !== '!' || t[i + 1] !== '[') return false;
    const j = t.indexOf(']', i + 2); if (j < 0 || j - (i + 2) > B.inside || t[j + 1] !== '(') return false;
    const k = t.indexOf(')', j + 2); if (k < 0 || k - (j + 2) > B.address) return false;
    i = k + 1; return true;
  };
  if (!img()) return false;
  if (i === t.length) return true;
  if (t[i] === ']' && t[i + 1] === '(') { const k = t.indexOf(')', i + 2); return k === t.length - 1 && k - (i + 2) <= B.address; }
  return false;
}
// (the regular expressions they stand for are anchored or fixed-width, and so linear as they are)
const HTML_LINE = t => t.length >= 2 && t[0] === '<' && t[t.length - 1] === '>';
const BREAK_LINE = /^(-{3,}|\*{3,}|_{3,})$/;
const LINE_MARKS = /^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/;
/** the rule on a body that has no front matter of its own: a clipping's body, or one page of it (rules 2 to 8) */
export function bodyText(body) {
  const lines = String(body || '').split(/\r?\n/).map(line => {
    const t = line.trim();
    if (HTML_LINE(t)) return null;                                                // an HTML-only line
    if (BREAK_LINE.test(t)) return null;                                          // a thematic break
    if (imageOnly(t)) return null;                                                // an image-only line
    const s = tagsOff(autolinksOff(linksOff(footnotesOff(footnotesOff(imagesOff(line), true), false))));
    return s.replace(LINE_MARKS, '');                                             // heading, quote, list marks
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
/** the rule on a whole FILE: its front matter (only at its very start) removed (rule 1), then bodyText */
export const clippingText = md => bodyText(frontMatter(String(md || '')).body);
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
// A CACHE per file, kept while the file's stat (device, inode, size, change time) is the same: a call for an unchanged file reads
// nothing (one stat). Each file is at most 1 MiB and the rules are linear, so even a cold call is bounded; LIST_DEADLINE_MS bounds one
// call's reading: files not reached by then are left out of that answer (and read on the next call).
export const LIST_DEADLINE_MS = 2000;
const cache = new Map();   // real folder + name → { key, loaded }
const wordsOf = t => (String(t).match(/\S+/g) || []).length;
const titleFromSource = src => { try { const u = new URL(src); const seg = u.pathname.split('/').filter(Boolean).pop(); return seg ? decodeURIComponent(seg) : u.hostname; } catch { return ''; } };
/** One allow-listed file read and understood: → { facts, body, text, pages, dropped } or { problem }. */
export function loadClipping(folder, name, { substackHosts = [] } = {}) {
  if (!plainName(name)) return { problem: 'not a plain file name' };
  let st = null;
  try { st = fs.lstatSync(path.join(folder, name)); } catch { st = null; }
  const ck = `${folder}\u0000${name}`;
  const key = st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${substackHosts.join(',')}` : '';
  const hit = cache.get(ck);
  if (hit && key && hit.key === key) return hit.loaded;
  const loaded = parse(name, readClipping(folder, name), substackHosts);
  if (key) cache.set(ck, { key, loaded });
  return loaded;
}
function parse(name, r, substackHosts) {
  if (r.problem) return { problem: r.problem };
  const { fm, body } = frontMatter(r.raw);
  const { url: source, dropped } = canonicalSourceOf(typeof fm.source === 'string' ? fm.source : '', { substackHosts });
  if (!source) return { problem: 'no usable source' };
  const text = bodyText(body);
  const published = typeof fm.published === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fm.published) ? fm.published.slice(0, 10) : '';
  // (no title: the source address's last path segment, or its host; never the file name, which is the owner's)
  const title = oneLine(typeof fm.title === 'string' && fm.title.trim() ? fm.title : titleFromSource(source), CLIPPING_LIMITS.titleChars);
  return { facts: { id: clippingId(name), title, author: oneLine(authorOf(fm.author), CLIPPING_LIMITS.authorChars), source, published, words: wordsOf(text),
    rev: crypto.createHash('sha256').update(r.raw).digest('hex').slice(0, 12) }, body, text, pages: pagesOf(body), dropped };
}
/** The collections as the Hub sees them, and (for the owner's check) each file left out and why, and secrets taken out of addresses. */
export function listClippings(settings, { now = Date.now, deadlineMs = LIST_DEADLINE_MS } = {}) {
  const collections = [], problems = [], dropped = [], changed = [];
  const opts = { substackHosts: settings.substack_hosts || [] };
  const until = now() + deadlineMs;
  for (const c of settings.collections) {
    const got = [];
    for (const f of c.files) {
      if (now() > until) { problems.push({ collection: c.name, file: f, problem: 'not read in time (the next call reads it)' }); continue; }
      const l = loadClipping(settings.folder, f, opts);
      if (l.problem) problems.push({ collection: c.name, file: f, problem: l.problem });
      else {
        got.push(l.facts);
        if (l.dropped.length) {
          dropped.push({ collection: c.name, file: f, names: l.dropped });
          changed.push({ collection: c.name, file: f, names: l.dropped, source: l.facts.source, confirmed: clippingPublishable(settings, l) });
        }
      }
    }
    got.sort((a, b) => (a.published || '9999').localeCompare(b.published || '9999') || a.title.localeCompare(b.title));
    collections.push({ name: c.name, clippings: got });
  }
  return { collections, problems, dropped, changed };
}
/** An allow-listed clipping by id: → { name, facts, body, text, pages } or null. */
export function findClipping(settings, id) {
  if (!settings || !/^[0-9a-f]{16}$/.test(String(id || ''))) return null;
  for (const c of settings.collections) for (const f of c.files) {
    if (clippingId(f) !== id) continue;
    const l = loadClipping(settings.folder, f, { substackHosts: settings.substack_hosts || [] });
    return l.problem ? null : { name: f, ...l };
  }
  return null;
}
