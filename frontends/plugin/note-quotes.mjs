// note-quotes.mjs — how a quoted passage is written into markdown, in ONE place.
//
// Two things write a reader's highlights out as markdown: the Obsidian export
// (export.mjs) and the blog draft written into a site from its template
// (draft.mjs). Both call this module, so the rules below exist once. Every
// output kind has one function:
//
//   webQuote      a passage from an ordinary web page, in the chosen
//                 quote_style (QUOTE_STYLES)
//   blygQuote     a passage from a Blygger post: the spec's partial
//                 transclusion, a directive line with the passage as a
//                 blockquote directly under it (spec 0.4 §10.1)
//   wholePost     a whole Blygger post: the bare directive line
//   frontMatter   the two optional front-matter keys, blyg_sources and
//                 blyg_stub_of
//   quoteNotes    the italic lines that say why a highlight on a post was
//                 NOT quoted by reference, or how old its version is
//
// The Blygger body syntax is the spec's own and any Blygger editor accepts it;
// the two front-matter keys are only for a site whose build reads them, and
// can be deleted by anyone who does not want them.
import { whereParts } from './store.mjs';
import { checkPassage } from './blyg.mjs';

// ---- the choices, named -------------------------------------------------------
// How a passage from an ordinary (non-Blygger) page is written. One setting,
// `quote_style` in the companion's config:
//   'url-card' — the blockquote's LAST paragraph is the page's bare URL, after
//                an empty '>' line. Sites that turn a trailing bare URL into a
//                link card (with the quote as a text fragment) want this; in
//                any other renderer it reads as a quote with its source under it.
//   'plain'    — the blockquote alone, as Discuss always wrote it; the page's
//                URL is in the note's front matter only.
export const QUOTE_STYLES = Object.freeze(['url-card', 'plain']);
export const DEFAULT_QUOTE_STYLE = 'url-card';
// → { style, refused }: an unknown value is refused, with a sentence saying
// so, and the export goes on in 'plain' — the style that adds nothing.
export function quoteStyleOf(value) {
  if (value === undefined || value === null || value === '') return { style: DEFAULT_QUOTE_STYLE, refused: '' };
  if (QUOTE_STYLES.includes(value)) return { style: value, refused: '' };
  return { style: 'plain',
    refused: `quote_style ${JSON.stringify(String(value)).slice(0, 60)} is not one of ${QUOTE_STYLES.join(', ')}; wrote plain quotes` };
}

// Whether the note answers the page it is about (spec §10.6, a "stub"). One
// field on the page record, `export_response`, one of these; absent or
// anything else reads as the first. A note has at most one target, and a page
// note's only candidate is its page.
export const RESPONSE_MODES = Object.freeze(['not-a-response', 'response']);
export const responseOf = page => (page && page.export_response === 'response' ? 'response' : 'not-a-response');

// ---- small pieces ---------------------------------------------------------------
const blockquote = q => String(q || '').split('\n')
  .map(l => (l.trim() ? `> ${l}` : '>')).join('\n');
// Where the passage came from, when the document has somewhere to come from:
// a PDF's page number, or the heading it sat under and which copy of the
// words it was. Rides inside the blockquote as its attribution line.
const attribution = t => {
  if (t && Number(t.page) > 0) return `\n> — p. ${Number(t.page)}`;
  const w = whereParts(t).join(', ');
  return w ? `\n> (${w})` : '';
};
const struck = t => !!(t && t.mark === 'strike');

// A passage as Blygger reads it is plain text (§10.2), and the publisher reads
// the markdown we write, so anything markdown would turn into formatting is
// escaped with a backslash (CommonMark: a backslash before ASCII punctuation
// is that character, literally). Inline: * _ ` [ < \ ~ and an & that would
// start an entity. At the start of a line: what would make it a heading, a
// list item, a quote or a rule.
export function escapePassageLine(line) {
  return String(line)
    .replace(/[\\*_`[<~]/g, '\\$&')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
    .replace(/^(\s*)([#>+=-])/, '$1\\$2')
    .replace(/^(\s*\d{1,9})([.)])/, '$1\\$2');
}

// A directive's label is the quoter's plain words (§10.1): one line, and it
// cannot contain ']]'. Clipped so a long page title stays one readable line.
export function labelOf(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\]\]/g, '] ]').trim().slice(0, 120).trim();
}

// ---- one function per output kind ------------------------------------------------

/** The whole post, by reference: a line of its own. */
export function wholePost(id, label = '') {
  const l = labelOf(label);
  return `![[${id}${l ? ` | ${l}` : ''}]]`;
}

/**
 * A passage of a Blygger post, by reference: the directive, then the passage
 * as a blockquote DIRECTLY under it (no blank line), one paragraph per line
 * of the selection with an empty '>' line between paragraphs. The passage is
 * the highlight's own words, never retyped.
 */
export function blygQuote(stamp, label, quote) {
  const lines = String(quote || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [wholePost(stamp.id, label), lines.map(l => `> ${escapePassageLine(l)}`).join('\n>\n')].join('\n');
}

/** A passage of an ordinary page, in `style` (QUOTE_STYLES). `url` is the page's. */
export function webQuote(t, style, url) {
  const body = struck(t)
    ? blockquote('~~' + String(t.quote || '').replace(/\n+/g, ' ').trim() + '~~')
      + attribution(t) + '\n> *suggested deletion*'
    : blockquote(t.quote) + attribution(t);
  return style === 'url-card' && url ? `${body}\n>\n> ${url}` : body;
}

// YAML for a URL: bare when it is plainly a URL, quoted when anything in it
// could be read as YAML syntax.
const yamlUrl = u => (/^https?:\/\/[^\s#'"]+$/.test(u) && !/: /.test(u) ? u : JSON.stringify(u));
/**
 * The two optional front-matter keys, as lines (none when there is nothing
 * to say). `sources`: page URLs of every Blygger post the note quotes or
 * references. `stubOf`: the one thing the note is a response to — a post
 * { origin, id, version } or an ordinary page { url } — or null.
 */
export function frontMatter({ sources = [], stubOf = null } = {}) {
  const out = [];
  const list = [...new Set(sources.filter(Boolean))];
  if (list.length) out.push('blyg_sources:', ...list.map(u => `  - ${yamlUrl(u)}`));
  if (stubOf && stubOf.id) {
    out.push('blyg_stub_of:', `  origin: ${yamlUrl(stubOf.origin)}`, `  id: ${stubOf.id}`, `  version: ${Number(stubOf.version)}`);
  } else if (stubOf && stubOf.url) {
    out.push('blyg_stub_of:', `  url: ${yamlUrl(stubOf.url)}`);
  }
  return out;
}

/**
 * The italic lines under a highlight made on a Blygger post that say what the
 * reader needs to know about its quote: why it is NOT a quote by reference
 * (its words are not word for word in the post, or the page could not be
 * checked), or that its version is as of a later check. `current` is the
 * post's version now, when known, with its verdict on this passage.
 */
export function quoteNotes(stamp, { current = null } = {}) {
  if (!stamp) return [];
  if (stamp.status === 'check-failed' || stamp.status === 'checking') {
    return ['*Discuss could not check whether this page is a Blygger post, so this is an ordinary quote.*'];
  }
  if (stamp.status !== 'blyg') return [];
  const out = [];
  const p = stamp.passage;
  if (p && p.match === false) {
    out.push(`*Not quoted by reference: these words are not word for word in version ${stamp.version} of the post`
      + (p.nearest ? ` (nearest exact passage: “${escapePassageLine(p.nearest.replace(/\n/g, ' '))}”).*` : '.*'));
  } else if (current && current.match === false) {
    out.push(`*Not quoted by reference: this passage was in version ${stamp.version} of the post and is not in version ${current.version}, the current one.*`);
  } else if (stamp.as_of === 'check') {
    out.push(`*Version ${stamp.version} is the version current when Discuss first checked this page, which was after this highlight was made.*`);
  }
  return out;
}

/** True when this highlight is written as a quote by reference. */
export function byReference(stamp, { current = null } = {}) {
  return !!(stamp && stamp.status === 'blyg' && stamp.passage && stamp.passage.match === true
    && !(current && current.match === false));
}

/**
 * The post as it is NOW, for one highlight: when the highlight was made on an
 * older version of the same post, does its passage still pass the check
 * against the current one? (The site that publishes the note will quote
 * whatever version it imports, which is the current one.) `post` is
 * { id, version, text } from the export's own check, or null; `quote` is
 * the highlight's words (a stamp does not hold them).
 */
export function currentFor(stamp, post, quote) {
  if (!post || !stamp || stamp.status !== 'blyg' || stamp.id !== post.id || stamp.version === post.version) return null;
  return { version: post.version, match: checkPassage(quote, post.text).match };
}

/**
 * Everything one highlight contributes to a note, before its comments:
 * → { parts, source }. A highlight on a Blygger post whose words pass the
 * post's check is a quote by reference (and `source` is the post's page, for
 * blyg_sources); every other highlight is an ordinary quote in `style`, with
 * the italic line saying why when it was made on a post.
 */
export function highlightParts(t, { style, url, label, post = null }) {
  const st = t && t.blyg;
  const current = currentFor(st, post, String((t && t.quote) || ''));
  if (byReference(st, { current })) {
    const parts = [blygQuote(st, label, t.quote)];
    if (struck(t)) parts.push('*suggested deletion*');
    return { parts: [...parts, ...quoteNotes(st, { current })], source: st.page };
  }
  const from = st && st.status === 'blyg' && st.page ? st.page : url;
  return { parts: [webQuote(t, style, from), ...quoteNotes(st, { current })], source: '' };
}
