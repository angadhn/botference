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
import { ownerTyped, AGENT_TEXT_MODES, READER_HAND_MODES, generatedLines, studioInstruction } from './tkgaps.mjs';
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
  // (a generated passage's instruction is never shown: `[TK] … [=]` is left out of what a reader sees)
  const body = String(noteText || '').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/\[TK\] [^\n]*? \[=\]/g, '');
  const seen = body.replace(/&#0*123;|&#x0*7b;|&lbrace;|&lcub;/gi, '{').replace(/&#0*125;|&#x0*7d;|&rbrace;|&rcub;/gi, '}').replace(/\\([{}%])/g, '$1');
  return /\{[{%]/.test(seen);
}
// LINKS AND IMAGES IN THE OWNER'S WORDS, checked before anything is written (review item 6). A short post's links must be web addresses
// (http or https): anything else (javascript:, data:, mailto:, a relative path, an address the site's build cannot parse) is refused
// with a sentence naming it, instead of failing the site's build late. Images are not supported in a short post yet (the example
// site refuses remote media at build: it must be copied into the site first). → [sentence…]; code spans and blocks are left alone.
export function linkProblems(text) {
  const t = String(text);
  const mask = Grammar.codeMask(t);
  const out = [];
  const name = d => `“${String(d).replace(/\s+/g, ' ').slice(0, 60)}”`;
  const webOk = d => {
    const x = String(d).trim().replace(/^<(.*)>$/s, '$1').trim();
    if (!/^https?:\/\/[^\s<>"`]+$/i.test(x)) return false;
    try { const u = new URL(x); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch { return false; }
  };
  for (let i = 0; i < t.length; i++) {
    if (mask[i]) continue;
    if (t[i - 1] === '\\') continue;   // an escaped character is text, never markup
    if (t[i] === '!' && t[i + 1] === '[' && !mask[i + 1]) {
      if (!out.some(x => /images are not supported/.test(x))) out.push('images are not supported in a short post yet: take the image out of the comment (a link to it is fine)');
    }
    if (t[i] === ']' && t[i + 1] === '(') {
      let depth = 1; let j = i + 2;
      while (j < t.length && depth) { if (t[j] === '(') depth++; else if (t[j] === ')') depth--; j++; }
      const inner = t.slice(i + 2, depth ? t.length : j - 1).trim();
      const dest = inner.startsWith('<') ? inner.slice(0, inner.indexOf('>') + 1 || inner.length) : inner.split(/\s+/)[0];
      if (!webOk(dest)) out.push(`a link in the comment points to ${name(dest)}, which is not a web address (http or https): change it or remove it`);
    }
  }
  for (const m of t.matchAll(/^ {0,3}\[[^\]]+\]:[ \t]*(\S+)/gm)) {
    if (!mask[m.index] && !webOk(m[1])) out.push(`a link in the comment points to ${name(m[1])}, which is not a web address (http or https): change it or remove it`);
  }
  return [...new Set(out)];
}
const LIQUID_IN_CODE = /\{[{%]/;
const codeHasLiquid = text => {
  const mask = Grammar.codeMask(text);
  for (let i = 0; i < text.length - 1; i++) if (mask[i] && LIQUID_IN_CODE.test(text.slice(i, i + 2))) return true;
  return false;
};

// AGENT TEXT IN A SHORT POST (the owner's rule: "if an agent wrote any part of a passage, it gets a box"). Every gap whose text an
// agent wrote, whole or in part (tkgaps AGENT_TEXT_MODES: filled, edited, adopted, pasted), is written in the site's generated-passage
// form, so the site shows it in a box labelled with the agent (and "+ the author" when the owner edited or adopted it):
//   asked of an agent   `[TK] <instruction> [=]<text>[/TK]`
//   pasted (impyrt)     `[TK]impyrt <model>=<text>[/TK]`
// with one `blyg_generated` entry each, in note order: model, at, and `edited_by_author: true` when the owner had a hand in it
// (READER_HAND_MODES). The text inside is ESCAPED AS PLAIN TEXT, whoever touched it last (it was shaped by a hostile page's passage,
// which the agent was shown): markdown, raw HTML, Liquid, brackets as passages are, and inside the scope a backtick or a TK mark is a
// character reference, so nothing in it can pair with code or end the scope. A gap on a line of its own is a paragraph of its own (it
// may hold paragraphs); one inside a sentence stays one line. The instruction is the owner's, written as one line with the scope's
// tokens, Liquid and HTML made inert; the example site never shows it on the page or the wire (docs/BLYGGER.md).
const importedModelToken = m => String(m || '').replace(/[\s=\[\]`<>&{}]/g, '').slice(0, 60);
// (inside the site's box the passage sits in an HTML element, where a backslash before `<`, `>` or `&` is shown as a backslash: those
// three are character references here, which read the same everywhere)
export function escapeScopeLine(line, { escape = 'liquid' } = {}) {
  return escapePassage(line, { escape })
    .replace(/`(\[\/?tk\])`/gi, (m, t) => '&#91;' + t.slice(1))
    .replace(/\\`/g, '&#96;')
    .replace(/\\</g, '&lt;').replace(/\\&/g, '&amp;').replace(/^(\s*)\\>/, '$1&gt;');
}
export function scopeText(text, { block = false, escape = 'liquid' } = {}) {
  const t = clean(text).trim();
  if (!block) return t.split('\n').map(l => escapeScopeLine(l, { escape })).filter(Boolean).join(' ');
  return t.split(/\n[ \t]*\n/).map(p => p.split('\n').map(l => escapeScopeLine(l, { escape })).filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
}
const scopeInstruction = (instruction, { escape = 'liquid' } = {}) => {
  let i = studioInstruction(oneLine(instruction)).replace(/</g, '&lt;').replace(/\[(?==\])/g, '&#91;');
  if (escape === 'liquid') i = liquidEntities(i);
  return i || 'passage';
};
export function agentScope(g, { block = false, escape = 'liquid' } = {}) {
  const text = scopeText(g.text, { block, escape });
  if (g.mode === 'pasted-by-reader') { const m = importedModelToken(g.model); return `[TK]impyrt${m ? ' ' + m : ''}=${text}[/TK]`; }
  return `[TK] ${scopeInstruction(g.instruction, { escape })} [=]${text}[/TK]`;
}
/** The blyg_generated entry for one agent-text gap. */
export const generatedEntry = g => ({ ...(g.model ? { model: String(g.model) } : {}), ...(g.at ? { at: String(g.at) } : {}),
  ...(READER_HAND_MODES.includes(g.mode) ? { edited_by_author: true } : {}),
  // (for the owner's view only: generatedLines writes model, at and edited_by_author, nothing else)
  agent: g.agent === 'codex' ? 'codex' : 'claude' });
// a placeholder for a scope while the owner's own words around it are made safe (private-use characters, never in a placeholder twice)
const HOLD_A = '\ue000';
const HOLD_B = '\ue001';

// THE SITE'S OWN MARKS. `[TK]` and `[/TK]` are the example site's grammar for an agent's passage, and its build refuses a post whose
// published text would show either one outside code (`_plugins/blygger.rb`: "the published text would contain [TK] or [/TK] outside
// code"). A character reference does not help: the published text is read back from the rendered page. So a start whose text would
// show them is REFUSED before anything is written, with a plain sentence for each kind of text:
//   the owner's own words (a comment, a reply)   OWNER_TK_SAY: the one place the letters are named, because the owner typed them
//   an agent's passage (filled, edited, adopted, pasted)   AGENT_TK_SAY (the drawer also marks that passage as needing an edit)
//   the quoted passage (the page's words)        PASSAGE_TK_SAY
// Inside the owner's code formatting (a code span or block) they are code, which the site allows. A /tk instruction is never
// published (the site leaves it out of the page and the wire), so it is not refused.
export const OWNER_TK_SAY = 'Your comment contains the letters [TK]; remove them or put them in code formatting';
export const AGENT_TK_SAY = 'an agent\'s passage holds letters your site keeps for marking agents\' passages: edit that passage (or remove it), then publish';
export const PASSAGE_TK_SAY = 'the passage you quoted holds letters your site keeps for marking agents\' passages, so it cannot be published from here: quote a different part of the page';
const HAS_TK_MARK = /\[\/?tk\]/i;
export const hasTkMark = t => HAS_TK_MARK.test(String(t || ''));

/**
 * One of the owner's messages as plain text for the post.
 * → { text, blocked: [sentence…], generated: [entry…] }. A gap an agent wrote (or the owner pasted from an agent's tool) is
 * written as the site's generated passage (above); a gap that is pending, failed or unknown BLOCKS. A bracket mark the owner typed
 * as words (`[TK]`) is no longer a gap: it is written so the site shows the letters and never reads it as its own grammar.
 */
export function ownText(msg, { escape = 'liquid' } = {}) {
  const blocked = [];
  const generated = [];
  const src = clean(withRuns(stripMore(msg.text), msg.runs, null)).replace(/[\ue000\ue001]/g, '');
  if (src.length > LIMITS.commentChars) return { text: '', blocked: [`a comment is longer than ${LIMITS.commentChars} characters`], generated };
  const stored = Array.isArray(msg.gaps) ? msg.gaps : [];
  const found = Grammar.gapsFor(src, stored);
  const scopes = [];
  let out = '';
  let at = 0;
  found.forEach((f, i) => {
    const g = stored[i] && stored[i].instruction === f.instruction ? stored[i] : null;
    out += Grammar.unescape(src.slice(at, f.start));
    at = f.end;
    if (g && g.mode === 'removed') return;
    if (g && AGENT_TEXT_MODES.includes(g.mode)) {
      if (hasTkMark(g.text)) { blocked.push(AGENT_TK_SAY); return; }
      // THE BOX IS ALWAYS A BLOCK OF ITS OWN: a gap typed inside a sentence publishes as the words before it (a paragraph), the box,
      // and the words after it (a new paragraph). Never inline.
      const scope = agentScope(g, { block: true, escape });
      out = out.replace(/[ \t]+$/, '') + `${HOLD_A}${scopes.length}${HOLD_B}`;
      scopes.push(`\n\n${scope}\n\n`);
      // the owner's words after it begin a paragraph of their own (no leading space carried over)
      { const rest = src.slice(at); at += rest.length - rest.replace(/^[ \t]+/, '').length; }
      generated.push(generatedEntry(g));
      return;
    }
    blocked.push(`a /tk passage (“${oneLine(f.instruction).slice(0, 40)}”) is not written yet: fill it, write it yourself or remove it, then publish`);
  });
  out += Grammar.unescape(src.slice(at));
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  // the owner's own words: a TK mark outside code is refused (OWNER_TK_SAY); it is also written as the letters (a character reference),
  // never read as the site's grammar, should a caller write the text anyway
  { const mask = Grammar.codeMask(out);
    if ([...out.matchAll(TK_MARK)].some(m => !mask[m.index])) blocked.push(OWNER_TK_SAY);
    out = out.replace(TK_MARK, (m, i) => (mask[i] ? m : '&#91;' + m.slice(1))); }
  blocked.push(...linkProblems(out));
  out = neutraliseHtml(out);
  if (escape === 'liquid') {
    if (codeHasLiquid(out)) blocked.push('a code span or block in the comment holds “{{” or “{%”, which a Jekyll build would run: change it, or tell the settings the site is not Jekyll');
    else out = liquidOutsideCode(out);
  }
  out = out.replace(new RegExp(`${HOLD_A}(\\d+)${HOLD_B}`, 'g'), (m, n) => scopes[Number(n)] || '');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, blocked, generated };
}

// ---- a quoted passage, as the note writes it -----------------------------------
// The page's words, made text in every renderer we know of: markdown specials,
// raw HTML, wikilinks, Liquid, kramdown attribute lists, math, TK marks.
export function escapePassage(line, { escape = 'liquid' } = {}) {
  // A web address in a passage stays TEXT: the site turns a paragraph that is only a URL into a link card (a fetch of that page's
  // metadata) and a hostile page chooses the URL. So each address is written as a code span (the markup of the passage is
  // ignored by the text rule of Blygger quotes; the reader sees the same characters), with the characters Liquid and markdown
  // read inside it written as percent-encodings, and everything between the addresses is escaped as before.
  // Square brackets are written as character references (&#91; &#93;) in the prose and percent-encoded in an address: the example
  // site's sidenote converter reads `[^1]` and `[^1]: …` in the raw markdown, backslash or not, and would turn a hostile passage into
  // its own markup (review item 5). A reference renders as the same character, so the quote's text still matches its source. The
  // spaces around an address are kept (the text must read as the passage did).
  const parts = clean(line).split(/(https?:\/\/[^\s]+)/i);
  return parts.map((seg, i) => {
    if (i % 2) {
      const url = seg.replace(/[`{}<>"\\[\]]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
      return `\`${url}\``;
    }
    const lead = i > 0 && /^\s/.test(seg) ? ' ' : '';
    const tail = i < parts.length - 1 && /\s$/.test(seg) ? ' ' : '';
    return lead + escapeProse(seg, { escape }) + tail;
  }).join('').replace(/\s+/g, ' ').trim();
}
function escapeProse(line, { escape }) {
  const s = escapePassageLine(oneLine(line));
  // a TK mark was made a code span by escapePassageLine: that is left exactly as it is
  return s.split(/(`\[\/?TK\]`)/i).map((seg, i) => {
    if (i % 2) return seg;
    let t = seg.replace(/[$\]|]/g, '\\$&');
    if (escape === 'liquid') t = liquidEntities(t);
    // a bracket (escaped above with a backslash) is a character reference: no raw `[` or `]` is left for a site's own markup to read
    return t.replace(/\\\[/g, '&#91;').replace(/\\\]/g, '&#93;');
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
export function blygKeyLines({ sources = [], stubOf = null, generated = [] } = {}) {
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
  // one entry per agent-written passage, in note order (tkgaps.generatedLines: model, at, edited_by_author)
  for (const l of generatedLines(generated)) out.push(...l.split('\n'));
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
 *   keep         for a new VERSION of a published post: { created, released } as the published note has them (the id is `id`)
 * → { ok, text, title, slug, permalink, sources, generated, snapshot } | { ok: false, error }
 *   `generated`: the blyg_generated entries (one per agent-written passage); `snapshot`: what a later version is compared with
 *   (snapshotOf), made of hashes only
 */
export function renderShortNote({ page, threads, home, now, slug, id = '', earlier = null, keep = null }) {
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
  const generated = [];
  const snapshot = [];
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
      if (hasTkMark(quote)) blocked.push(PASSAGE_TK_SAY);
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
    const said = [];
    for (const m of t.msgs.filter(isPublishableMsg)) {
      const r = ownText(m, opts);
      blocked.push(...r.blocked);
      generated.push(...r.generated);
      if (r.text) { words.push(r.text); said.push({ ts: String(m.ts || ''), sha: hashOf(r.text) }); }
    }
    snapshot.push({ thread: String(t.id || ''), quote: quote.trim() ? hashOf(quote.trim()) : '', msgs: said });
    if (!words.length && !blocked.length) return { ok: false, error: 'that comment has no words to publish' };
    // the name is the OWNER's first words: an agent's passage (a generated-passage scope) is not part of it
    if (!titleSource && words.length) titleSource = words[0].replace(/\[TK\](?:impyrt[^=\n]*=| [^\n]*? \[=\])[\s\S]*?\[\/TK\]/g, ' ');
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
  const dateOk = d => /^\d{4}-\d\d-\d\d$/.test(String(d || ''));
  const front = renderFront((home && home.template) || DEFAULT_TEMPLATE, {
    title: oneLine(title).replace(/[<>{}]/g, ''), created: keep && dateOk(keep.created) ? keep.created : day, released: keep && dateOk(keep.released) ? keep.released : day,
    slug, id: isBlygId(id) ? id : newBlygId(), keyLines: blygKeyLines({ sources, stubOf, generated }),
  });
  const text = `---\n${front.join('\n')}\n---\n${body}\n`;
  if (text.length > LIMITS.noteChars) return { ok: false, error: `the note would be longer than ${LIMITS.noteChars} characters` };
  const perm = front.map(l => /^permalink:\s*(\S+)\s*$/.exec(l)).find(Boolean);
  return { ok: true, text, title: oneLine(title).replace(/[<>{}]/g, ''), slug, permalink: perm ? perm[1].replace(/^["']|["']$/g, '') : '', sources: [...new Set(sources)],
    generated, notify: notifyOf(page, { sources, stubOf }),
    snapshot: { quotes: snapshot.map(x => x.quote), threads: snapshot, sources: [...new Set(sources)].sort(), stub: stubOf ? hashOf(JSON.stringify(stubOf)) : '' } };
}

const hashOf = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 24);

/** Who the site will tell about this post, in the owner's words, or '' (an ordinary web page: nobody). */
export function notifyOf(page, { sources = [], stubOf = null } = {}) {
  const item = blygItemOf(page);
  if (!item || (!sources.length && !(stubOf && stubOf.id))) return '';
  const who = oneLine((page.blyg && page.blyg.item && page.blyg.item.author) || '').replace(/[<>{}[\]|`*_]/g, '').slice(0, 60) || 'The author of the post you quoted';
  return `${who} will be told you ${stubOf && stubOf.id ? 'responded' : 'quoted them'}`;
}

// THE NOTE AS IT WILL READ, for the owner's preview: the body without its front matter, in parts the drawer draws as text (never as
// HTML): the owner's words, a quoted passage, and each agent-written passage as a box with its label (from `generated`, in order).
// Character references and backslash escapes are shown as the characters they stand for; no bracket grammar is ever shown.
const decodeRefs = t => String(t).replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/\\([\\`*_{}\[\]()#+\-.!|<>~$&=])/g, '$1');
// WHO WROTE A BOX, without names (no agent's, no model's, no owner's): one of AGENT_BOX_KINDS, each with its accessible name. The site
// draws the same two marks (a robot; a robot and the site's own "A" mark), and the model and the time stay in the post's record.
export const AGENT_BOX_KINDS = Object.freeze(['ai', 'ai-and-author']);
export const AGENT_BOX_NAMES = Object.freeze({ ai: 'Written by an AI model', 'ai-and-author': 'Written by an AI model and edited by the author' });
export function readingOf(noteText, generated = []) {
  const body = String(noteText || '').replace(/^---\n[\s\S]*?\n---\n/, '');
  const parts = [];
  const scopeRe = /\[TK\](?:impyrt[^=\n]*=| [^\n]*? \[=\])([\s\S]*?)\[\/TK\]/g;
  let at = 0;
  let k = 0;
  const words = t => {
    for (const para of String(t).split(/\n[ \t]*\n/)) {
      const p = para.trim();
      if (!p) continue;
      if (/^!\[\[[0-9a-z]{26}/.test(p)) {
        const quote = p.split('\n').slice(1).filter(l => /^>/.test(l)).map(l => l.replace(/^>\s?/, '')).join('\n').trim();
        if (quote) parts.push({ kind: 'quote', text: decodeRefs(quote) });
        continue;
      }
      if (p.split('\n').every(l => /^>/.test(l))) { parts.push({ kind: 'quote', text: decodeRefs(p.split('\n').map(l => l.replace(/^>\s?/, '')).join('\n').trim()) }); continue; }
      parts.push({ kind: 'words', text: decodeRefs(p) });
    }
  };
  for (const m of body.matchAll(scopeRe)) {
    const before = body.slice(at, m.index);
    const g = generated[k++] || {};
    const by = g.edited_by_author ? 'ai-and-author' : 'ai';
    // the box is a block of its own (the note writes every one so): the words before it, the box, the words after it
    words(before);
    parts.push({ kind: 'agent', by, name: AGENT_BOX_NAMES[by], text: decodeRefs(m[1].trim()) });
    at = m.index + m[0].length;
  }
  words(body.slice(at));
  return parts;
}

// ---- a new VERSION of a published post: what changed, in words ------------------------------------------------------------
// Written WITHOUT any model, by comparing the snapshot recorded when the post was last published with the one made now (both are
// hashes: the old words are never kept, so the line cannot quote them, which is the Blygger rule for a changelog note). A comment
// is the same comment across versions by its thread and its time stamp; its words are compared by hash.
//   "Added a comment."  "Edited the second comment."  "Removed a comment."  "Edited two comments and added one."
//   "Changed the quoted passage."  "Edited the comment." (a post of one comment)
// → '' when nothing a reader sees has changed.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const numberWord = n => NUMBER_WORDS[n] || String(n);
export const CHANGE_KINDS = Object.freeze(['edited', 'added', 'removed']);
export function changesBetween(before, after) {
  const flat = snap => (snap && Array.isArray(snap.threads) ? snap.threads : []).flatMap(t => (t.msgs || []).map(m => ({ key: `${t.thread}\u0000${m.ts}`, sha: m.sha })));
  const a = flat(before);
  const b = flat(after);
  const old = new Map(a.map(x => [x.key, x.sha]));
  const now = new Map(b.map(x => [x.key, x.sha]));
  const edited = b.map((x, i) => ({ ...x, at: i + 1 })).filter(x => old.has(x.key) && old.get(x.key) !== x.sha);
  const added = b.filter(x => !old.has(x.key));
  const removed = a.filter(x => !now.has(x.key));
  const quotes = JSON.stringify((before && before.quotes) || []) !== JSON.stringify((after && after.quotes) || []);
  return { edited, added, removed, quote: quotes, total: b.length };
}
export function changelogLine(before, after) {
  const c = changesBetween(before, after);
  const clauses = [];
  if (c.quote) clauses.push('changed the quoted passage');
  const counts = { edited: c.edited.length, added: c.added.length, removed: c.removed.length };
  for (const kind of CHANGE_KINDS) {
    const n = counts[kind];
    if (!n) continue;
    const first = clauses.length === 0;
    if (kind === 'edited' && n === 1) {
      const at = c.edited[0].at;
      clauses.push(c.total === 1 ? 'edited the comment' : `edited the ${ORDINALS[at] || 'comment number ' + at} comment`.replace('the comment number', 'comment number'));
    } else if (n === 1) clauses.push(`${kind} ${first ? 'a comment' : 'one'}`);
    else clauses.push(`${kind} ${numberWord(n)}${first ? ' comments' : ''}`);
  }
  if (!clauses.length) return '';
  const joined = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
  return joined[0].toUpperCase() + joined.slice(1) + '.';
}
