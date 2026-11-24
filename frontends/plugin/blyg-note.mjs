// blyg-note.mjs — the short post that "Publish as blyg" writes, as TEXT.
//
// Pure: no disk, no network, no clock but the one it is handed. The owner's own
// comment(s) on a page become one short note for their own site: front matter
// from a template the owner edits, then (for a page that has one) the quoted
// passage, then their words. Everything here exists because the page is
// HOSTILE and the note is read by a site build:
//
//   · every string the PAGE supplies (a quoted passage, a title, a URL, a
//     Blygger post's id, origin, label) is either written through a real
//     quoting function (yamlString, a URL parsed by `new URL`) or escaped so a
//     renderer shows it as the characters it is (escapePassage: markdown,
//     raw HTML, wikilinks, Liquid, kramdown attribute lists, math, TK marks);
//   · the front matter is made of the template's own LITERAL lines, which are
//     checked against a small line grammar when the template is saved and again
//     when it is used, and of values that can only be inserted as one quoted
//     scalar, a date, a slug, or a block this file generates itself;
//   · the owner's own words are theirs (a deliberate `[[id | link]]` stays
//     live) but can never reach the front matter, and Liquid in them is made
//     inert unless the owner has said the site is not Jekyll (escape: 'none').
//
// The note's format is the site's own contract (docs/blyg-note-format.md of the
// example consumer): `![[<id> | label]]` with the passage as `> ` lines directly
// under it, `blyg_sources`, `blyg_stub_of`; an ordinary page's passage is the
// plain web quote whose last paragraph is the bare URL.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { isWebUrl } from './blyg.mjs';
import { isBotAuthor, hasMention } from './chat.mjs';
import { stripMore } from './more.mjs';
import { withRuns } from './export.mjs';
import { ownerTyped } from './tkgaps.mjs';
import { urlRefusal } from './netguard.mjs';
import { escapePassageLine, byReference, labelOf, readVersion, responseOf, canRespond, TK_MARK } from './note-quotes.mjs';

const Grammar = createRequire(import.meta.url)('./extension/tkgrammar.js');

// ---- the caps, stated once -----------------------------------------------------
export const LIMITS = Object.freeze({
  commentChars: 8000,     // one message of the owner's
  quoteChars: 2000,       // one quoted passage (never cut: a cut passage would not match its post)
  noteChars: 40000,       // the whole note
  titleChars: 80,
  titleWords: 8,
  slugChars: 48,
  comments: 12,           // threads in one post ("this and the ones above")
  templateChars: 2000,
  templateLines: 40,
});

// ---- scopes --------------------------------------------------------------------
export const SCOPES = Object.freeze(['one', 'above']);

// ---- text hygiene ----------------------------------------------------------------
// controls (newline and tab kept), zero-width, bidi, BOM, line/paragraph separators
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const loneSurrogates = s => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
export const clean = v => loneSurrogates(String(v == null ? '' : v)).replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
const oneLine = v => clean(v).replace(/\s+/g, ' ').trim();

/**
 * A double-quoted YAML scalar for ANY string. A JSON string is a YAML 1.2
 * double-quoted scalar; what JSON leaves raw and YAML does not like (DEL, C1
 * controls, U+2028/9, a lone surrogate) is escaped here too.
 */
export function yamlString(v) {
  return JSON.stringify(loneSurrogates(String(v == null ? '' : v)))
    .replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** A web address that is safe to write in a note, or ''. http(s) only, no credentials, no fragment, no whitespace. */
export function safeWebUrl(raw) {
  let u;
  try { u = new URL(String(raw == null ? '' : raw).trim()); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.username || u.password) return '';
  u.hash = '';
  let href = u.href;
  if (href.length > 600 || /[\s\u0000-\u001f\u007f-\u009f]/.test(href)) return '';
  // braces and the markdown/liquid specials, as percent-encodings: the same address
  href = href.replace(/[{}|\\^`<>"*_[\]]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  return href;
}

// ---- the title and the slug ---------------------------------------------------
/** The words of a comment with the markdown taken off, for a name. */
function plainWords(text) {
  return oneLine(String(text || '')
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_~#>|\\{}[\]<]/g, ' ')
    .replace(/\[\/?tk\]/gi, ' '));
}
/** Title: the first words of the comment (LIMITS.titleWords, LIMITS.titleChars). */
export function titleOf(text) {
  const words = plainWords(text).split(' ').filter(Boolean).slice(0, LIMITS.titleWords);
  let t = words.join(' ');
  if (t.length > LIMITS.titleChars) t = t.slice(0, LIMITS.titleChars).replace(/\s+\S*$/, '');
  t = t.replace(/[\s.,;:!?-]+$/, '').trim();
  return t || 'A short note';
}
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'index', 'feed', 'items', 'tags', 'assets', 'admin', 'api',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);
/** A slug of [a-z0-9-] from any text; never empty, never a reserved name, never a dot-name. */
export function slugOf(text, { date = '' } = {}) {
  let s = clean(text).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > LIMITS.slugChars) s = s.slice(0, LIMITS.slugChars).replace(/-[^-]*$/, '') || s.slice(0, LIMITS.slugChars);
  s = s.replace(/^-+|-+$/g, '');
  if (!s) s = `note-${String(date).replace(/[^0-9]/g, '') || 'today'}`;
  if (RESERVED.has(s)) s += '-note';
  return s;
}
/** `base`, or `base-2`, `base-3` … the first not in `taken` (a Set). */
export function uniqueSlug(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const c = `${base.slice(0, LIMITS.slugChars - String(n).length - 1)}-${n}`;
    if (!taken.has(c)) return c;
  }
  throw new Error('no free name for this note');
}

// ---- the owner's own words, as the note's text ------------------------------------
// A comment is publishable when the OWNER typed it in the drawer (the server stamped
// it, tkgaps.ownerTyped), no agent was addressed, and it is not a tool summary.
// (a message an edit set aside — `superseded`, store.supersedeAfter — is the owner's earlier words, not part of the post)
export const isPublishableMsg = m => !!m && ownerTyped(m) && m.kind !== 'tools' && !m.agent && !m.route && !m.superseded
  && !isBotAuthor(m.author) && !hasMention(m.text);
export const isPublishedThread = t => !!(t && t.blyg_published && t.blyg_published.at);
/** May this thread be published at all? → { ok, why } (the first message must be the owner's own, untagged). */
export function eligibleThread(t) {
  if (!t || !Array.isArray(t.msgs) || !t.msgs.length) return { ok: false, why: 'that comment has no words' };
  const first = t.msgs.find(m => m && m.kind !== 'tools');
  if (!isPublishableMsg(first)) return { ok: false, why: 'only a comment you wrote yourself, and did not address to an agent, can be published' };
  if (t.mark === 'strike') return { ok: false, why: 'a suggested deletion cannot be published as a post' };
  if (!t.msgs.some(m => isPublishableMsg(m) && String(m.text || '').trim())) return { ok: false, why: 'that comment has no words' };
  return { ok: true, why: '' };
}

// LIQUID AND KRAMDOWN ATTRIBUTE LISTS are made inert with CHARACTER REFERENCES, never a backslash (Liquid does not read a
// backslash: `\{%` still runs). Every `{` that opens or sits in `{{`, `{%` or `{:`, and every `}` that closes `}}` or
// `%}`, is written `&#123;` / `&#125;`, which a markdown renderer shows as the same character and Liquid never sees as a tag.
// Inside a code span or block a reference would show as its letters, so there the owner's own text that holds `{{` or `{%`
// is REFUSED (a plain message), and a passage or an agent's words never has a code span at all (the backtick is escaped).
export function liquidEntities(text) {
  const t = String(text);
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '{' && (t[i + 1] === '{' || t[i + 1] === '%' || t[i + 1] === ':' || t[i - 1] === '{')) out += '&#123;';
    else if (c === '}' && (t[i + 1] === '}' || t[i - 1] === '}' || t[i - 1] === '%')) out += '&#125;';
    else out += c;
  }
  return out;
}
const liquidOutsideCode = text => {
  const mask = Grammar.codeMask(text);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const open = c === '{' && (text[i + 1] === '{' || text[i + 1] === '%' || text[i + 1] === ':' || text[i - 1] === '{');
    const close = c === '}' && (text[i + 1] === '}' || text[i - 1] === '}' || text[i - 1] === '%');
    out += !mask[i] && open ? '&#123;' : !mask[i] && close ? '&#125;' : c;
  }
  return out;
};
// SHORT POSTS ARE TEXT. In the owner's own words (and an adopted gap) the markdown stays (emphasis, links, code, lists, quotes) but raw
// HTML cannot: outside code every `<` is written `&lt;` (so `a < b` reads as typed), except an autolink `<https://…>`, which kramdown
// turns into a link; a link whose destination is a javascript:, data:, vbscript: or file: address (or hides its scheme in a character
// reference) is made `#`; a `|` that is not inside a [[wikilink]] is escaped so a stray bar never becomes a table. Inside a code span
// or block nothing is changed: a `<` there is shown literally by the renderer (and `&lt;` would show as its letters). (Indented code
// blocks are not recognised as code here, so a `<` in one shows as `&lt;`.)
export function neutraliseHtml(text) {
  const t = String(text);
  const mask = Grammar.codeMask(t);
  let out = '';
  let wiki = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (mask[i]) { out += c; continue; }
    if (c === '[' && t[i + 1] === '[') wiki++;
    if (c === ']' && t[i + 1] === ']' && wiki) wiki--;
    if (c === '<' && t[i - 1] === '\\') out += c;   // already escaped by the passage rules (an agent's or a quoted text)
    else if (c === '<') out += /^<https?:\/\/[^\s<>"'`]+>/i.test(t.slice(i)) ? c : '&lt;';
    else if (c === '|' && !wiki && t[i - 1] !== '\\') out += '\\|';
    else out += c;
  }
  // link destinations: `](dest)` and `[ref]: dest` with a dangerous scheme (checked on the text with character references decoded)
  const bad = d => { const x = d.replace(/&#x?[0-9a-f]+;?|&colon;|&Tab;|&NewLine;/gi, ':').replace(/[\s\u0000-\u001f]+/g, '').toLowerCase(); return /^<?(?:javascript|data|vbscript|file)(?::|$)/.test(x) || /&#|&colon/i.test(d); };
  // `](dest)` with balanced parentheses (a destination may hold some), outside code
  const m2 = Grammar.codeMask(out);
  let res = '';
  for (let i = 0; i < out.length; i++) {
    if (out[i] === ']' && out[i + 1] === '(' && !m2[i]) {
      let depth = 1; let j = i + 2;
      while (j < out.length && depth) { if (out[j] === '(') depth++; else if (out[j] === ')') depth--; j++; }
      const dest = out.slice(i + 2, depth ? out.length : j - 1);
      if (bad(dest.trim().split(/\s+"/)[0])) { res += '](#)'; i = (depth ? out.length : j) - 1; continue; }
    }
    res += out[i];
  }
  return res.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/gm, (m, a, d) => (bad(d) ? a + '#' : m));
}
// WHAT A READER WOULD SEE. A Jekyll site may keep Liquid-looking text out of what it publishes altogether (the example site's own
// generated-publication test refuses any item whose content_md holds `{{` or `{%`), so a note that DISPLAYS either one, however inert
// it was made here, is refused by that site at the end of its apply. → true when the note's body, read as the reader sees it
// (character references and backslash escapes of braces decoded), shows `{{` or `{%`. blyg-run.mjs refuses such a start at once.
export function showsLiquid(noteText) {
  const body = String(noteText || '').replace(/^---\n[\s\S]*?\n---\n/, '');
  const seen = body.replace(/&#0*123;|&#x0*7b;|&lbrace;|&lcub;/gi, '{').replace(/&#0*125;|&#x0*7d;|&rbrace;|&rcub;/gi, '}').replace(/\\([{}%])/g, '$1');
  return /\{[{%]/.test(seen);
}
const LIQUID_IN_CODE = /\{[{%]/;
const codeHasLiquid = text => {
  const mask = Grammar.codeMask(text);
  for (let i = 0; i < text.length - 1; i++) if (mask[i] && LIQUID_IN_CODE.test(text.slice(i, i + 2))) return true;
  return false;
};

/**
 * One of the owner's messages as plain text for the post.
 * → { text, blocked: [sentence…] }. `/tk` gaps count as the owner's text once filled (an
 * agent's fill is escaped as a passage is, so it is only ever text); a gap
 * that is pending, failed or unknown BLOCKS, and so does any `[TK]` mark left outside code.
 */
export function ownText(msg, { escape = 'liquid' } = {}) {
  const blocked = [];
  const src = clean(withRuns(stripMore(msg.text), msg.runs, null));
  if (src.length > LIMITS.commentChars) return { text: '', blocked: [`a comment is longer than ${LIMITS.commentChars} characters`] };
  const found = Grammar.parseGaps(src);
  const stored = Array.isArray(msg.gaps) ? msg.gaps : [];
  let out = '';
  let at = 0;
  found.forEach((f, i) => {
    const g = stored[i] && stored[i].instruction === f.instruction ? stored[i] : null;
    out += Grammar.unescape(src.slice(at, f.start));
    at = f.end;
    if (g && g.mode === 'removed') return;
    if (g && g.mode === 'adopted-by-reader') { out += clean(g.text); return; }
    // Only an ADOPTED gap is the owner's own markdown. What an agent wrote, or the owner only edited, is escaped exactly as a
    // passage is, so it is shown as plain text: it is shaped by a hostile page's passage (the agent was shown it).
    if (g && (g.mode === 'filled-by-agent' || g.mode === 'edited-by-reader')) {
      out += clean(g.text).split('\n').map(l => escapePassage(l, { escape })).join('\n');
      return;
    }
    blocked.push(`a /tk or [TK] placeholder (“${oneLine(f.instruction).slice(0, 40)}”) is still in the comment and nobody has filled it in: fill it, adopt it or remove it, then publish`);
  });
  out += Grammar.unescape(src.slice(at));
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  const mask = Grammar.codeMask(out);
  for (const m of out.matchAll(TK_MARK)) {
    if (!mask[m.index]) { blocked.push('a [TK] marker is still in the comment and nobody has filled it in: fill it or remove it (write `[TK]` as code to mean the letters), then publish'); break; }
  }
  out = neutraliseHtml(out);
  if (escape === 'liquid') {
    if (codeHasLiquid(out)) blocked.push('a code span or block in the comment holds “{{” or “{%”, which a Jekyll build would run: change it, or tell the settings the site is not Jekyll');
    else out = liquidOutsideCode(out);
  }
  return { text: out, blocked };
}

// ---- a quoted passage, as the note writes it -----------------------------------
// The page's words, made text in every renderer we know of: markdown specials,
// raw HTML, wikilinks, Liquid, kramdown attribute lists, math, TK marks.
export function escapePassage(line, { escape = 'liquid' } = {}) {
  // A web address in a passage stays TEXT: the site turns a paragraph that is only a URL into a link card (a fetch of that page's
  // metadata) and a hostile page chooses the URL. So each address is written as a code span (the markup of the passage is
  // ignored by the text rule of Blygger quotes; the reader sees the same characters), with the characters Liquid and markdown
  // read inside it written as percent-encodings, and everything between the addresses is escaped as before.
  const parts = clean(line).split(/(https?:\/\/[^\s]+)/i);
  return parts.map((seg, i) => {
    if (i % 2) {
      const url = seg.replace(/[`{}<>"\\]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
      return `\`${url}\``;
    }
    return escapeProse(seg, { escape });
  }).join('').replace(/\s+/g, ' ').trim();
}
function escapeProse(line, { escape }) {
  const s = escapePassageLine(oneLine(line));
  // a TK mark was made a code span by escapePassageLine: that is left exactly as it is
  return s.split(/(`\[\/?TK\]`)/i).map((seg, i) => {
    if (i % 2) return seg;
    let t = seg.replace(/[$\]|]/g, '\\$&');
    if (escape === 'liquid') t = liquidEntities(t);
    return t;
  }).join('');
}
/** The passage as `> ` lines (a paragraph per line of the selection, an empty `>` between). */
export function quoteBlock(quote, opts) {
  const lines = clean(quote).split('\n').map(l => l.trim()).filter(Boolean);
  return lines.map(l => `> ${escapePassage(l, opts)}`).join('\n>\n');
}
/** A label for `![[id | label]]`: plain words only, nothing the directive grammar or a renderer reads. */
export const directiveLabel = text => labelOf(oneLine(text).replace(/[{}<>[\]|\\*_`!#$&~]/g, ' ').replace(/\s+/g, ' ').trim());

const BLYG_ID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
/** The page's Blygger identity, strictly checked; null when anything about it is odd. */
export function blygItemOf(page) {
  const st = page && page.blyg;
  const it = st && st.status === 'blyg' && st.item;
  if (!it) return null;
  const origin = safeWebUrl(it.origin);
  const where = safeWebUrl(it.page);
  const version = Number(it.version);
  if (!BLYG_ID.test(String(it.id || '')) || !origin || !origin.endsWith('/') || !where || !Number.isInteger(version) || version < 1) return null;
  // The note's `blyg_sources` is what a site's importer FETCHES. It must be a public address (never this computer, a private
  // network or the companion's own port) and on the origin's own host and scheme: a page cannot name another host to be fetched.
  if (urlRefusal(origin) || urlRefusal(where)) return null;
  const o = new URL(origin); const w = new URL(where);
  if (o.protocol !== w.protocol || o.host !== w.host) return null;
  return { id: String(it.id), origin, page: where, version, pageUrl: where };
}

// ---- the template (front matter) ----------------------------------------------
export const ESCAPES = Object.freeze(['liquid', 'none']);
export const DEFAULT_ESCAPE = 'liquid';
// A short blyg's address is made of its Blygger id, like the reference blyg's `/blyg/t/<id>/`. The id is 128 random bits from crypto, encoded
// exactly as the blog's `Blygger.new_id` does (26 digits of 5 bits, most significant first, from Crockford's lowercase base32 without
// i, l, o, u): the same value gives the same id in both languages (the tests hold vectors made by the Ruby function).
export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export function blygIdFrom(bytes) {
  let v = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  for (let i = 0; i < 26; i++) { out = ID_ALPHABET[Number(v & 31n)] + out; v >>= 5n; }
  return out;
}
export const newBlygId = (random = crypto.randomBytes) => blygIdFrom(random(16));
export const isBlygId = s => /^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(String(s));

export const DEFAULT_TEMPLATE = [
  // no title: a short blyg is tweet-sized and the site names it by its first words; add `title: ${title}` here for one
  'created: ${created}',
  'released: "${released}"',
  'blyg: true',
  'blyg_id: "${id}"',   // quoted: an id of digits and one e would be read as a number
  'permalink: /b/${id}',
  '${blyg_keys}',
].join('\n');
const PLACEHOLDERS = Object.freeze(['title', 'created', 'released', 'slug', 'id', 'blyg_keys']);
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// a value the template may carry: a plain scalar (no indicator first, no `: `, no ` #`), a one-line
// JSON-quoted string, or a one-line list of plain words
const plainScalar = v => v === '' || (!/^[\[\]{},&*!|>'"%@`#?]/.test(v) && !/^[-:](\s|$)/.test(v) && !/: |\s#|:$/.test(v) && !/[\u0000-\u001f\u007f]/.test(v));
const quotedScalar = v => { if (!/^"/.test(v)) return false; try { return typeof JSON.parse(v) === 'string'; } catch { return false; } };
const flowWords = v => /^\[\s*[\w .-]*(\s*,\s*[\w .-]+)*\s*\]$/.test(v);
const valueOk = v => plainScalar(v) || quotedScalar(v) || flowWords(v);

/** → { ok, error }: is this template one this file can fill without breaking the front matter? */
export function checkTemplate(text) {
  const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!t.trim()) return { ok: false, error: 'the template is empty' };
  if (t.length > LIMITS.templateChars) return { ok: false, error: `the template is longer than ${LIMITS.templateChars} characters` };
  const lines = t.replace(/\n+$/, '').split('\n');
  if (lines.length > LIMITS.templateLines) return { ok: false, error: `the template has more than ${LIMITS.templateLines} lines` };
  for (const [i, line] of lines.entries()) {
    const at = `template line ${i + 1}`;
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff\t]/.test(line)) return { ok: false, error: `${at} has a control character or a tab` };
    if (/^(---|\.\.\.)\s*$/.test(line)) return { ok: false, error: `${at} would end the front matter` };
    if (/\{\{|\{%/.test(line)) return { ok: false, error: `${at} has Liquid in it` };
    for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
      if (!PLACEHOLDERS.includes(m[1])) return { ok: false, error: `${at}: \${${m[1].slice(0, 20)}} is not one of ${PLACEHOLDERS.map(p => '${' + p + '}').join(', ')}` };
    }
    if (line.trim() === '') continue;
    if (/^\s*#/.test(line)) continue;
    if (line === '${blyg_keys}') continue;
    if (line.includes('${blyg_keys}')) return { ok: false, error: `${at}: \${blyg_keys} must be a line of its own` };
    const map = /^( {0,6})([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/.exec(line);
    const item = /^( {1,6})- (.*)$/.exec(line);
    if (map) {
      const v = map[3] === undefined ? '' : map[3];
      if (v.includes('${title}') && v !== '${title}') return { ok: false, error: `${at}: \${title} must be the whole value` };
      if (v === '${title}') continue;
      if (!valueOk(v.replace(/\$\{(created|released|slug|id)\}/g, 'x'))) return { ok: false, error: `${at}: the value is not a plain word, a quoted string or a one-line list` };
    } else if (item) {
      if (item[2].includes('${title}') && item[2] !== '${title}') return { ok: false, error: `${at}: \${title} must be the whole value` };
      if (item[2] !== '${title}' && !valueOk(item[2].replace(/\$\{(created|released|slug|id)\}/g, 'x'))) return { ok: false, error: `${at}: the list item is not a plain word or a quoted string` };
    } else return { ok: false, error: `${at} is not “key: value”, “  - item” or a comment` };
  }
  return { ok: true, error: '' };
}

/** The keys a note adds when it quotes or responds to a Blygger post (or a web page), as lines. */
export function blygKeyLines({ sources = [], stubOf = null } = {}) {
  const out = [];
  const list = [...new Set(sources.filter(Boolean))];
  if (list.length) out.push('blyg_sources:', ...list.map(u => `  - ${yamlString(u)}`));
  if (stubOf && stubOf.id) {
    // the id QUOTED, like blyg_id: the page chose it, and an id such as `0x…`, `0b…` or `0` followed by digits 0-7 is a valid Blygger
    // id that a YAML 1.1 reader (the site's Ruby) would otherwise read as a NUMBER, and the build would then refuse the note
    out.push('blyg_stub_of:', `  origin: ${yamlString(stubOf.origin)}`, `  id: ${yamlString(stubOf.id)}`, `  version: ${Number(stubOf.version)}`);
  } else if (stubOf && stubOf.url) {
    out.push('blyg_stub_of:', `  url: ${yamlString(stubOf.url)}`);
  }
  return out;
}

/** Fill the template: → the front matter lines (without the `---` fences). Throws on a template checkTemplate refuses. */
export function renderFront(template, v) {
  const c = checkTemplate(template);
  if (!c.ok) throw new Error(c.error);
  const out = [];
  for (const line of String(template).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')) {
    if (line === '${blyg_keys}') { out.push(...v.keyLines); continue; }
    out.push(line
      .replace(/\$\{title\}/g, () => yamlString(v.title))
      .replace(/\$\{created\}/g, () => v.created)
      .replace(/\$\{released\}/g, () => v.released)
      .replace(/\$\{slug\}/g, () => v.slug)
      .replace(/\$\{id\}/g, () => v.id));
  }
  return out;
}

// ---- dates ------------------------------------------------------------------------
export function validTimezone(tz) {
  if (tz === undefined || tz === null || tz === '') return true;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: String(tz) }); return true; } catch { return false; }
}
/** YYYY-MM-DD for `now` in the given IANA zone (default: this machine's). */
export function dayOf(now, tz = '') {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// ---- the note ---------------------------------------------------------------------
const linkText = s => oneLine(s).replace(/[\\[\]*_`<>{}|!]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The short post. `args`:
 *   page         the page record
 *   threads      the threads to publish, in order (each already checked eligible)
 *   home         { template, escape, timezone }
 *   now          a Date
 *   slug         the slug to use (the caller made it unique)
 *   earlier      { title, link } when the post chains to an earlier one (scope 'one' only), else null
 * → { ok, text, title, slug, permalink, sources } | { ok: false, error }
 */
export function renderShortNote({ page, threads, home, now, slug, id = '', earlier = null }) {
  const escape = ESCAPES.includes(home && home.escape) ? home.escape : DEFAULT_ESCAPE;
  const opts = { escape };
  if (!page || !Array.isArray(threads) || !threads.length) return { ok: false, error: 'nothing to publish' };
  if (threads.length > LIMITS.comments) return { ok: false, error: `at most ${LIMITS.comments} comments can go in one post` };
  const item = blygItemOf(page);
  const webPage = isWebUrl(page.url) ? safeWebUrl(page.url) : '';
  const response = responseOf(page) === 'response' && canRespond(page);
  const label = directiveLabel(page.title || '');
  const sources = [];
  const blocks = [];
  const blocked = [];
  let titleSource = '';
  for (const t of threads) {
    const el = eligibleThread(t);
    if (!el.ok) return { ok: false, error: el.why };
    // One thread reads: the FIRST comment, then the QUOTED PASSAGE, then the thread's remaining comments (the owner's order: what I said
    // about it comes first, the passage is what I was looking at). A thread with one comment is that comment, then the quote.
    let quoteBlockText = '';
    const quote = clean(t.quote);
    if (quote.trim()) {
      if (quote.length > LIMITS.quoteChars) return { ok: false, error: `a quoted passage is longer than ${LIMITS.quoteChars} characters` };
      const st = t.blyg;
      if (item && st && st.id === item.id && byReference(st, { current: null })) {
        quoteBlockText = `![[${item.id}${label ? ` | ${label}` : ''}]]\n${quoteBlock(quote, opts)}`;
        sources.push(item.page);
      } else {
        const from = item ? item.page : webPage;
        quoteBlockText = quoteBlock(quote, opts) + (from ? `\n>\n> ${from}` : '');
      }
    }
    const words = [];
    for (const m of t.msgs.filter(isPublishableMsg)) {
      const r = ownText(m, opts);
      blocked.push(...r.blocked);
      if (r.text) words.push(r.text);
    }
    if (!words.length && !blocked.length) return { ok: false, error: 'that comment has no words to publish' };
    if (!titleSource && words.length) titleSource = words[0];
    if (!words.length) continue;
    blocks.push([words[0], ...(quoteBlockText ? [quoteBlockText] : []), ...words.slice(1)].join('\n\n'));
  }
  if (blocked.length) return { ok: false, error: [...new Set(blocked)].join('; '), blocked: [...new Set(blocked)] };
  let body = blocks.join('\n\n');
  if (earlier && earlier.title && earlier.link) {
    const href = earlier.link.startsWith('/') ? earlier.link.replace(/[()\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()) : safeWebUrl(earlier.link);
    if (href) body += `\n\nEarlier: [${linkText(earlier.title) || 'an earlier note'}](${href})`;
  }
  const title = titleOf(titleSource);
  const stubOf = response ? (item ? { origin: item.origin, id: item.id, version: readVersion(page, { id: item.id, version: item.version }) }
    : (webPage ? { url: webPage } : null)) : null;
  if (stubOf && item) sources.push(item.page);
  const day = dayOf(now, home && home.timezone);
  const front = renderFront((home && home.template) || DEFAULT_TEMPLATE, {
    title: oneLine(title).replace(/[<>{}]/g, ''), created: day, released: day, slug, id: isBlygId(id) ? id : newBlygId(), keyLines: blygKeyLines({ sources, stubOf }),
  });
  const text = `---\n${front.join('\n')}\n---\n${body}\n`;
  if (text.length > LIMITS.noteChars) return { ok: false, error: `the note would be longer than ${LIMITS.noteChars} characters` };
  const perm = front.map(l => /^permalink:\s*(\S+)\s*$/.exec(l)).find(Boolean);
  return { ok: true, text, title: oneLine(title).replace(/[<>{}]/g, ''), slug, permalink: perm ? perm[1].replace(/^["']|["']$/g, '') : '', sources: [...new Set(sources)] };
}
