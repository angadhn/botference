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
import { checkPassage, isWebUrl } from './blyg.mjs';

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

// Where the reader's own words go around a quote. One setting,
// `comment_order` in the companion's config, beside quote_style:
//   'comment-first' — the comment the reader wrote WHEN MAKING the highlight
//                     (the thread's opening message, if it is theirs and has
//                     words) comes first, then the quote, then everything else
//                     in the thread. Blygger readers take position to mean
//                     something: words above a quote are a quote post, words
//                     below it a reply.
//   'quote-first'   — the quote first and the whole thread under it, as
//                     Discuss always wrote it.
// An unknown value is refused, with a sentence, and the default is used.
export const COMMENT_ORDERS = Object.freeze(['comment-first', 'quote-first']);
export const DEFAULT_COMMENT_ORDER = 'comment-first';
export function commentOrderOf(value) {
  if (value === undefined || value === null || value === '') return { order: DEFAULT_COMMENT_ORDER, refused: '' };
  if (COMMENT_ORDERS.includes(value)) return { order: value, refused: '' };
  return { order: DEFAULT_COMMENT_ORDER,
    refused: `comment_order ${JSON.stringify(String(value)).slice(0, 60)} is not one of ${COMMENT_ORDERS.join(', ')}; wrote ${DEFAULT_COMMENT_ORDER}` };
}

// THE RULE, once, for the export and the draft alike. `msgs` are the thread's
// messages as the caller will write them (already filtered for the export's
// mode); `first` is the thread's first readable message. The opening comment
// is msgs[0] only when it IS that first message, is the reader's own and has
// words; a thread a bot began, or begun with nothing said (a bare strike),
// has none. → { opening: msg | null, rest: msgs }.
export function splitOpening(msgs, { first = null, reader = '', order = DEFAULT_COMMENT_ORDER } = {}) {
  const list = Array.isArray(msgs) ? msgs : [];
  const m = list[0];
  if (order !== 'comment-first' || !m || m !== first || !reader || m.author !== reader || !String(m.text || '').trim()) {
    return { opening: null, rest: list };
  }
  return { opening: m, rest: list.slice(1) };
}

// The reader's words never swallow the quote, nor are swallowed by it: blocks
// are always separated by a blank line, and words that end in a list item or
// an indented line get an empty HTML comment after them, so the directive
// that follows can never be read as part of a list (the receiving grammar
// refuses a directive under a list line). A comment ending in a blockquote
// needs nothing more: a blank line ends a blockquote, so the two stay two.
export function proseBlock(text) {
  const s = String(text || '').replace(/\s+$/, '');
  const last = s.split('\n').filter(l => l.trim()).pop() || '';
  return /^(\s*([-*+]|\d{1,9}[.)])\s|\s{4}|\t)/.test(last) ? `${s}\n\n<!-- -->` : s;
}

/** One thread's parts, in order: [opening prose], quote parts, [the rest]. */
export function arrangeThread({ opening = '', quote = [], after = [] } = {}) {
  return [...(opening ? [proseBlock(opening)] : []), ...quote, ...after];
}

// How an agent's words are written into a note. One setting, `agent_style`,
// beside quote_style and comment_order:
//   'callout' — each agent message in its own Obsidian callout, headed with
//               the agent's name (`> [!note] Claude`), so the reader's words
//               and the agents' are never confused, and the box is easy to
//               delete; the reader's own words are never inside one
//   'inline'  — `**claude:** …` lines, as Discuss always wrote them
// The callout's type is a setting of its own, `callout_type` (default
// 'note', which Obsidian and the common static-site callout plugins draw).
export const AGENT_STYLES = Object.freeze(['callout', 'inline']);
export const DEFAULT_AGENT_STYLE = 'callout';
export function agentStyleOf(value) {
  if (value === undefined || value === null || value === '') return { style: DEFAULT_AGENT_STYLE, refused: '' };
  if (AGENT_STYLES.includes(value)) return { style: value, refused: '' };
  return { style: DEFAULT_AGENT_STYLE,
    refused: `agent_style ${JSON.stringify(String(value)).slice(0, 60)} is not one of ${AGENT_STYLES.join(', ')}; wrote ${DEFAULT_AGENT_STYLE}` };
}
export const DEFAULT_CALLOUT_TYPE = 'note';
export function calloutTypeOf(value) {
  if (value === undefined || value === null || value === '') return { type: DEFAULT_CALLOUT_TYPE, refused: '' };
  if (/^[a-z][a-z0-9-]{0,30}$/.test(String(value))) return { type: String(value), refused: '' };
  return { type: DEFAULT_CALLOUT_TYPE,
    refused: `callout_type ${JSON.stringify(String(value)).slice(0, 60)} is not a callout name (lowercase letters, digits, dashes); wrote ${DEFAULT_CALLOUT_TYPE}` };
}
export const agentName = a => { const s = String(a || 'agent'); return s.charAt(0).toUpperCase() + s.slice(1); };

/** One agent message as a callout: `> [!type] Name`, then its lines, quoted. */
export function agentCallout(name, text, type = DEFAULT_CALLOUT_TYPE) {
  const lines = String(text == null ? '' : text).replace(/\s+$/, '').split('\n');
  return [`> [!${type}] ${name}`, ...lines.map(l => (l.trim() ? `> ${l}` : '>'))].join('\n');
}

/**
 * How a run of a thread's (or a page chat's) messages is written: → parts.
 * 'inline': a lone message of the reader's own is prose, anything with a
 * second voice is `**name:** …` lines, as before. 'callout': each message is
 * its own part — an agent's in a callout, the reader's as prose, anyone
 * else's with their name. `body(m)` writes one message's text.
 */
export function messageParts(msgs, { reader = '', isBot = () => false, style = DEFAULT_AGENT_STYLE,
  type = DEFAULT_CALLOUT_TYPE, body = m => String(m.text || '') } = {}) {
  const list = Array.isArray(msgs) ? msgs : [];
  if (!list.length) return [];
  if (style !== 'callout') {
    return [list.length === 1 && list[0].author === reader ? body(list[0])
      : list.map(m => `**${m.author}:** ${body(m)}`).join('\n')];
  }
  // (a message with nothing in it is written as nothing)
  return list.filter(m => String(body(m) || '').trim())
    .map(m => (isBot(m.author) ? agentCallout(agentName(m.author), body(m), type)
      : m.author === reader ? body(m) : `**${m.author}:** ${body(m)}`));
}

// A callout is a blockquote, and two blockquotes that touch can be read as
// one (a renderer that merges across a blank line, or a lazy line). So a
// callout never touches another `>` block — a quote, a Blygger passage or
// another callout: an empty HTML comment line is put between them, which
// every markdown reader takes as the end of a blockquote. Nothing else moves.
const firstLine = p => String(p).split('\n')[0] || '';
const lastLine = p => String(p).split('\n').filter(l => l.trim()).pop() || '';
const isCallout = p => /^> \[![a-z]/.test(firstLine(p));
// …and a part (a comment with a filled TK gap in it) may END in a callout
const lastBlock = p => String(p).replace(/\s+$/, '').split(/\n[ \t]*\n/).pop() || '';
const endsInCallout = p => lastBlock(p).split("\n").some(l => /^> \[![a-z]/.test(l));
export function separateCallouts(parts) {
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && (isCallout(p) || endsInCallout(prev))
        && /^\s*>/.test(lastLine(prev)) && /^\s*>/.test(firstLine(p))) out.push('<!-- -->');
    out.push(p);
  }
  return out;
}

// Whether the note answers the page it is about (spec §10.6, a "stub"). One
// field on the page record, `export_response`, one of these; absent or
// anything else reads as the first. A note has at most one target, and a page
// note's only candidate is its page.
export const RESPONSE_MODES = Object.freeze(['not-a-response', 'response']);
// The reader's explicit choice, once made on a page, is what counts. Until
// then the default comes from the page: a note made from a Blygger post's own
// page is nearly always a reply to it, so there it is 'response'; everywhere
// else 'not-a-response'. (One field; the default is derived, never stored.)
export const responseOf = page => (page && RESPONSE_MODES.includes(page.export_response) ? page.export_response
  : page && page.blyg && page.blyg.status === 'blyg' ? 'response' : 'not-a-response');
// …and a response needs a target the spec can name: a post, or a web page
// (§10.6's {url}). A PDF on this disk, a file: page or the library has none.
export const canRespond = page => !!(page && isWebUrl(page.url));

// The version of the post the reader READ, for blyg_stub_of (§10.6: "at
// creation, what the author saw"): the newest version stamped on the reader's
// own records on this post; else the version current when the note was marked
// as a response (`export_response_version`); else the record's. Never simply
// the latest check, which may be a version the reader never opened.
export function readVersion(page, item) {
  const seen = [...((page && page.threads) || []), ...((page && page.page_chat) || [])]
    .map(r => r && r.blyg).filter(b => b && b.status === 'blyg' && b.id === item.id && Number.isInteger(b.version))
    .map(b => b.version);
  if (seen.length) return Math.max(...seen);
  const marked = Number(page && page.export_response_version);
  return Number.isInteger(marked) && marked > 0 ? marked : item.version;
}

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
//
// …EXCEPT a TK mark. [TK] and [/TK] are Blygger Studio's authoring grammar
// for a gap an agent fills (§5.7), and a conformance checker refuses a
// published item whose content_md contains either outside code — testing the
// raw text, so a backslash does not help. Inside a passage they are written
// as code spans instead (`[TK]`), which the §10.2 text rule reads as the same
// words (inline formatting is ignored). Bracket-directive text ([[id]],
// ![[id]]) is NOT put in code spans — a receiving site's wikilink pass reads
// inside them — and keeps its backslash.
export const TK_MARK = /\[\/?tk\]/gi;
const escapeInline = s => String(s)
  .replace(/[\\*_`[<~]/g, '\\$&')
  .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
export function escapePassageLine(line) {
  const s = String(line);
  let out = '';
  let at = 0;
  for (const m of s.matchAll(TK_MARK)) {
    out += escapeInline(s.slice(at, m.index)) + '`' + m[0] + '`';
    at = m.index + m[0].length;
  }
  out += escapeInline(s.slice(at));
  return out
    .replace(/^(\s*)([#>+=-])/, '$1\\$2')
    .replace(/^(\s*\d{1,9})([.)])/, '$1\\$2');
}

// The same rule for every other piece of text a note carries (a comment, a
// reply, a page chat, a page's quoted words, a title): outside code, a TK mark
// becomes a code span, so no bare TK grammar ever reaches a note. Code that
// is already code — fenced blocks and inline code spans — is left as written.
export function tkSafe(text) {
  const src = String(text == null ? '' : text);
  if (!/\[\/?tk\]/i.test(src)) return src;
  const lines = src.split('\n');
  let fence = '';
  const wrapInline = line => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      const tick = /`+/.exec(line.slice(i));
      const end = tick ? i + tick.index : line.length;
      out += line.slice(i, end).replace(TK_MARK, m => '`' + m + '`');
      if (!tick) break;
      const run = tick[0];
      const close = line.indexOf(run, end + run.length);
      if (close === -1) { out += line.slice(end); break; }
      out += line.slice(end, close + run.length);
      i = close + run.length;
    }
    return out;
  };
  return lines.map(line => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = '';
      return line;
    }
    return fence ? line : wrapInline(line);
  }).join('\n');
}

// A directive's label is the quoter's plain words (§10.1): one line, read as
// everything after the pipe up to the first ']]'. The grammar has no escape,
// so a label that contains ']]', or ends in ']' (which would make the first
// ']]' come one character early and leave a stray ']' on the line), cannot be
// written so that it reads back the same: such a label is DROPPED and the
// directive is written bare, which names the same post. Clipped so a long
// page title stays one readable line.
export function labelOf(text) {
  const l = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
  // …nor TK grammar, which a label is plain text for and cannot hide
  return l.includes(']]') || l.endsWith(']') || /\[\/?tk\]/i.test(l) ? '' : l;
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
  // only a web page has an address worth closing a quote with: a PDF read off
  // this disk (bfp-pdf://…), a file: page or the library keeps the plain shape,
  // so no local path or internal address ever reaches a note's body
  return tkSafe(style === 'url-card' && isWebUrl(url) ? `${body}\n>\n> ${url}` : body);
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
  } else if (stubOf && isWebUrl(stubOf.url)) {
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
