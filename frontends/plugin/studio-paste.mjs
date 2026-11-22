// studio-paste.mjs — the 'studio' export target: markdown to paste into
// Blygger Studio's compose screen. Pure text in, text out: no file, no network,
// no token. (The 'vault' target is export.mjs renderNote.)
//
// What Studio accepts, and where that was read, is written down in
// docs/blygger.md ("Pasting into Blygger Studio"). The short form:
//
//   a passage of a post   `![[id | label]]` with the passage as `> ` lines
//                         directly under it. No version in the line: Studio
//                         quotes the version current at publish.
//   the whole post        `![[id | label]]` alone.
//   a link                `[[id | text]]` (the reader's own words may hold one)
//   a gap                 `[TK] instruction [/TK]` (Studio generates it)
//   generated text        `[TK]impyrt <model>=text[/TK]`: how Studio is told
//                         that text came from a model somewhere else
//   a note to yourself    `/* … */`, which Studio strips before publishing:
//                         used for everything Discuss has to tell the reader
//                         that must not be published
//   a stub                NOT markup: Studio's "stub" button on a post it holds.
//                         So the note says which post, in a note to yourself.
//
// What this does NOT do: write front matter, a title, the page chat, callouts,
// HTML comments (Studio renders without HTML, so `<!-- -->` would publish as
// literal text), or anything for a site other than Studio.
import { isLibrary, displayTitle, isResolved } from './store.mjs';
import { isWebUrl } from './blyg.mjs';
import { isBotAuthor } from './chat.mjs';
import { renderNote, keptMsgs, exportMode, withRuns } from './export.mjs';
import { stripMore } from './more.mjs';
import { renderGaps, gapExportOf, studioOutput, ownerTyped } from './tkgaps.mjs';
import { byReference, currentFor, quoteNotes, blygQuote, wholePost, labelOf, responseOf, canRespond, readVersion,
  commentOrderOf, splitOpening, tkSafe, attribution } from './note-quotes.mjs';
import { createRequire } from 'node:module';
// the target names live in extension/config.js, shared with the drawer
export const { EXPORT_TARGETS, exportTargetOf } = createRequire(import.meta.url)('./extension/config.js');

// ---- the grammar's hazards in somebody's words -----------------------------
// Studio reads three things out of ordinary text that ordinary text can hold by
// accident: TK marks, a comment opener `/*` (a stray one swallows what follows
// or stops the publish), and `[[+` / `![[+`, which makes a NEW item at publish.
// Inside code none of them is read. So words are put through here before they
// are written, and each hazard is made inert in a way that renders as the same
// characters:
//   [TK] [/TK]      a code span (note-quotes.tkSafe)
//   /*  */         a backslash (markdown reads `\/` and `\*` as the characters)
//   [[+  ![[+      the first bracket as a character reference, &#91;
//   any [[ , in words that are not the reader's own (a guest's, a web page's)
// A fence the words open and never close would turn everything after it into
// code, so a closing fence is added.
const backslashesBefore = (s, i) => { let n = 0; while (i - 1 - n >= 0 && s[i - 1 - n] === '\\') n++; return n; };
function inertSegment(seg, own) {
  let t = seg.replace(/\*\//g, (m, i, s) => (backslashesBefore(s, i) % 2 ? m : '\\*/'));
  t = t.replace(/\/\*/g, (m, i, s) => (backslashesBefore(s, i) % 2 ? m : '\\/*'));
  return own ? t.replace(/(!?)\[\[(?=\s*\+)/g, '$1&#91;[') : t.replace(/(!?)\[\[/g, '$1&#91;[');
}
// the text with `fn` applied to everything that is not code (a fenced block, or
// an inline span closed by a run of the same length on the same line)
function mapOutsideCode(text, fn) {
  let fence = '';
  const lines = String(text).split('\n').map(line => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^\s{0,3}[`~]+\s*$/.test(line)) fence = '';
      return line;
    }
    if (fence) return line;
    let out = '';
    let i = 0;
    while (i < line.length) {
      const tick = /`+/.exec(line.slice(i));
      const end = tick ? i + tick.index : line.length;
      out += fn(line.slice(i, end));
      if (!tick) break;
      const run = tick[0];
      const close = line.indexOf(run, end + run.length);
      if (close === -1) { out += fn(line.slice(end)); break; }
      out += line.slice(end, close + run.length);
      i = close + run.length;
    }
    return out;
  });
  if (fence) lines.push(fence[0].repeat(Math.max(3, fence.length)));
  return lines.join('\n');
}
/** Words made safe to write into Studio's grammar. `own`: the reader's own. */
export function studioProse(text, { own = true } = {}) {
  return mapOutsideCode(tkSafe(String(text == null ? '' : text)), seg => inertSegment(seg, own));
}

// ---- notes to yourself, and links ------------------------------------------
// A `/* … */` is private (stripped before anything is hashed or stored), and
// must not close early or be hidden by code: no `*`, no backtick, no bracket.
const clean = s => String(s == null ? '' : s).replace(/[*`[\]]/g, m => (m === '[' ? '(' : m === ']' ? ')' : '')).replace(/\s+/g, ' ').trim();
const safeUrl = u => String(u).replace(/[*`[\]\s()<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
export const noteToSelf = text => `/* ${clean(text)} */`;
// a markdown link to a web address (and no other: a PDF on this disk has
// none), with a text that cannot hold the grammar
function webLink(text, url) {
  if (!isWebUrl(url)) return '';
  let href;
  try { href = safeUrl(new URL(url).href); } catch { return ''; }
  const label = studioProse(String(text || '').replace(/[[\]\\]/g, '').replace(/\s+/g, ' ').trim(), { own: false })
    || (() => { try { return new URL(url).host; } catch { return url; } })();
  return `[${label}](${href})`;
}

// ---- a passage from an ordinary page ---------------------------------------
// A plain blockquote, then the source as a link inside it. Never directly under
// a `![[id]]` line (Studio would take it as that directive's passage): every
// part of the note is separated from the next by a blank line.
function webQuote(t, { url, title }) {
  const struck = !!(t && t.mark === 'strike');
  const words = struck ? `~~${String(t.quote || '').replace(/\n+/g, ' ').trim()}~~` : String(t.quote || '');
  const quote = studioProse(words, { own: false }).split('\n').map(l => (l.trim() ? `> ${l}` : '>')).join('\n');
  const where = studioProse(attribution(t), { own: false });
  const link = webLink(title, url);
  return quote + where + (struck ? '\n> *suggested deletion*' : '') + (link ? `\n>\n> — ${link}` : '');
}

/**
 * The note for Blygger Studio. `cfg` is the companion's config (author,
 * comment_order, gap_export); `mode` is export.mjs exportMode ('all' |
 * 'comments'); `opts.post` is { id, version, text } from the export's own
 * check of the post, or null. → the markdown, or '' when there is nothing to
 * paste (the library, an empty page).
 */
export function renderStudioPaste(page, cfg, mode = 'all', opts = {}) {
  if (!page || isLibrary(page.url)) return '';
  const author = (cfg && cfg.author) || '';
  const only = exportMode(mode);
  const { order } = commentOrderOf(cfg && cfg.comment_order);
  const includeGaps = only !== 'comments' || gapExportOf(cfg && cfg.gap_export).choice === 'include';
  const title = displayTitle(page);
  const label = labelOf(title);
  const post = opts.post || null;
  const item = page.blyg && page.blyg.status === 'blyg' && page.blyg.item ? page.blyg.item : null;
  const response = responseOf(page) === 'response' && canRespond(page);

  const ownWords = m => !!m && m.author === author && !m.origin;
  // one message's words, in the grammar it belongs to
  const body = m => {
    const text = withRuns(stripMore(m.text), m.runs, null);
    if (isBotAuthor(m.author)) {
      const t = studioOutput(text);
      return t ? `[TK]impyrt=${t}[/TK]` : '';
    }
    if (ownerTyped(m)) {
      return renderGaps(text, m.gaps, { style: 'studio', filled: 'imported', include: includeGaps,
        prose: t => studioProse(t, { own: true }) });
    }
    return ownWords(m) ? studioProse(text, { own: true })
      : `**${studioProse(m.author, { own: false })}:** ${studioProse(text, { own: false })}`;
  };

  const parts = [];
  const checked = new Map();       // `${id} v${n}` → page, for the note about the check
  let referenced = 0;
  const threads = [];
  for (const t of page.threads || []) {
    const st = t && t.blyg;
    const current = currentFor(st, post, String((t && t.quote) || ''));
    const after = [];
    let quote;
    if (byReference(st, { current })) {
      quote = [blygQuote(st, label, t.quote), ...(t.mark === 'strike' ? ['*suggested deletion*'] : [])];
      referenced++;
      checked.set(`${st.id} v${st.version}`, { version: st.version, page: st.page });
    } else {
      const from = st && st.status === 'blyg' && st.page ? st.page : page.url;
      quote = [webQuote(t, { url: from, title })];
    }
    // what Discuss has to say about the quote is for the reader, not the post
    for (const n of quoteNotes(st, { current })) after.push(noteToSelf(n.replace(/^\*|\*$/g, '')));
    if (isResolved(t)) after.push(noteToSelf(`Resolved${t.resolved_by ? ` by ${t.resolved_by}` : ''}.${t.summary ? ` ${t.summary}` : ''}`));
    const kept = keptMsgs(t.msgs, only);
    const first = (t.msgs || []).filter(m => m && m.kind !== 'tools')[0] || null;
    const { opening, rest } = splitOpening(kept, { first, reader: author, order });
    for (const m of rest) { const b = body(m); if (String(b).trim()) after.push(b); }
    // (not note-quotes.arrangeThread: it puts an empty HTML comment after words
    // that end in a list, and Studio renders without HTML, so that would publish
    // as literal text; Studio's directive is line-based and a blank line is enough)
    threads.push([...(opening && String(body(opening)).trim() ? [body(opening)] : []), ...quote, ...after]);
  }

  // what must be said before anything else
  if (response) {
    if (item) {
      parts.push(noteToSelf(`STUB THIS POST: ${safeUrl(item.page)} (id ${item.id}, version ${readVersion(page, item)} as you read it). `
        + 'Studio cannot take a stub from pasted text. Find the post under reading, press stub, then paste everything below this line over the draft it opens.'));
      if (!referenced || order === 'quote-first') parts.push(wholePost(item.id, label));
    } else {
      parts.push(noteToSelf(`RESPONSE TO: ${safeUrl(page.url)}. Studio cannot declare a response to an ordinary web page from pasted text; the link below is the nearest it has.`));
      const link = webLink(title, page.url);
      if (link) parts.push(link);
    }
  }
  if (referenced) {
    const seen = [...checked.values()].map(c => `version ${c.version} of ${safeUrl(c.page || (item && item.page) || page.url)}`);
    parts.push(noteToSelf(`Discuss checked the quotes below word for word against ${[...new Set(seen)].join(' and ')}. `
      + 'Studio quotes the version current when you publish and checks again, so it will refuse a quote that version no longer holds.'));
  }
  for (const th of threads) parts.push(...th);
  const out = parts.filter(p => String(p).trim());
  return out.length ? out.join('\n\n') + '\n' : '';
}

/**
 * What was left out of a paste, as sentences for the person who copied it: the
 * page chat is a conversation with the agents and has no place in a post.
 */
export function studioLeftOut(page, mode = 'all') {
  const out = [];
  const chat = exportMode(mode) === 'comments' ? 0 : (page.page_chat || []).filter(m => m && m.kind !== 'tools').length;
  if (chat) out.push('the page chat was not copied');
  return out;
}

/**
 * THE one place a target is chosen: → the text for `target`. An unknown name is
 * refused, never guessed. `vault` is the Obsidian note (export.mjs renderNote).
 */
export function renderTarget(target, page, cfg, now = new Date(), mode = 'all', opts = {}) {
  if (!EXPORT_TARGETS.includes(target)) throw new Error(`no such export target: ${String(target).slice(0, 40)}`);
  return target === 'studio' ? renderStudioPaste(page, cfg, mode, opts) : renderNote(page, cfg, now, mode, null, opts);
}
