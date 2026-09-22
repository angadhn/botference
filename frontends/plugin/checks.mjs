// checks.mjs — the claim checker. No model in the loop, ever.
//
// THE PROBLEM THIS EXISTS FOR. Two bots reasoning from the same context agree
// on wrong facts, and the longer they discuss the stickier the shared premise
// gets. So a "second opinion" from the other agent is not a check at all: it is
// the same premise wearing a different hat. A CHECK is something held against
// the SOURCE. Where the claim is mechanically checkable, nothing needs to think
// about it — the text is either in the document or it is not.
//
// What is checkable in a margin reply, and nothing else:
//
//   · A QUOTE. Text the bot puts inside “…” or "…" of six words or more,
//     presented as coming from the page. It is in the page's snapshot text or
//     it is not, and the reader is told which.
//   · A "NOW READS" LINE (bridge-system-prompt rules 5 / 5b). The bot says it
//     rewrote a passage and quotes the new wording. The file on disk either
//     contains that wording now or it does not.
//   · A PAGE-NUMBER CLAIM on a paged document. "…on page 12, “…”" is checked
//     against page 12's own text rather than the whole document, because a
//     passage that exists on page 4 does not make the claim about page 12 true.
//
// Everything else a bot says is prose, and prose is not this file's business.
// Nothing here BLOCKS or ALTERS a reply: the check is a stamp on the message,
// and an unstamped message is one where there was nothing to check or no source
// to check it against. A silent pass and a silent skip would be the same thing
// to the reader, so a reply with no checkable claim carries no `checks` field at
// all rather than an empty one.
//
// Pure, and deliberately so: given a reply's text and some source text it
// answers with no server, no bridge and no browser.

// Six words, because shorter quotations are ordinary English — a bot writing
// "the model" in quotes is not claiming the page says it — and a rule that
// flagged them would cry wolf on every reply.
export const QUOTE_MIN_WORDS = 6;
// One reply's worth of stamps. A typo sweep quoting thirty phrases is not
// thirty separate claims to the reader, and a row of thirty stamps is noise.
export const CHECKS_MAX = 8;
// Past this a "quote" is a pasted block, not a claim about a sentence.
export const QUOTE_MAX = 600;
// How far back from a quote a page number still governs it: one clause.
export const PAGE_NEAR = 120;

// ---- normalisation --------------------------------------------------------
//
// The same fold anchor.js applies when it locates a highlight on a page, so a
// quote that WOULD anchor is a quote this file finds. Three layers and no
// fourth: invisible characters dropped, the typographic variants folded to
// their ASCII forms (a bot that types a straight apostrophe into a quotation
// from a page full of curly ones has not misquoted it), whitespace collapsed.
// Then lowercased — case is not what a misquote is.
const FOLD = {
  '‘': "'", '’': "'", '‚': "'", '‹': "'", '›': "'",
  '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
  '–': '-', '—': '-', '−': '-', '‑': '-', '‐': '-',
};
const INVISIBLE = /[​‌‍⁠﻿­]/g;

export function normalize(s) {
  let out = String(s == null ? '' : s).replace(INVISIBLE, '');
  out = out.replace(/[‘’‚‹›“”„«»–—−‑‐]/g,
    c => FOLD[c] || c);
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

export const wordCount = s => (String(s || '').trim().match(/\S+/g) || []).length;

// A fenced block is code, and code is not a claim about the page — the same
// rule every other reply-line convention in this tree holds (`watch:`,
// `lasso:`, `strike:`). Inline code spans go too: a bot naming a `"constant"`
// is quoting the source it is editing, not the document.
export function stripCode(text) {
  return String(text || '')
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, '\n')
    .replace(/`[^`\n]*`/g, ' ');
}

// A file's words, whatever markup they arrived in. The wording a bot quotes
// back is PROSE — it does not carry the `<em>` that sits in the middle of it —
// so the file has to be compared as prose too. Tags become a space (never
// nothing: `a<br>b` is two words), the three entities our own writers produce
// come back, and `<script>`/`<style>` bodies go entirely, because a
// self-contained artifact is mostly those and none of it is the document.
// (store.snapshotPdfText is the twin of this for SNAPSHOTS, where an `<h2>` is
// the viewer's own page label and must go. Here a heading is the document.)
export function plainText(src) {
  return String(src || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- what the bot said it rewrote -----------------------------------------
//
// store.NEW_WORDING_RE and collateral.ALSO_CHANGED_RE are the twins of these,
// and they are deliberately NOT imported: those two decide whether to MOVE an
// anchor or open a thread, and their phrasings are load-bearing to the
// machinery. This file only wants to know what wording was claimed, so it takes
// the narrow, explicit shape the prompt actually asks for and nothing looser. A
// claim this misses is a claim that goes unchecked, which is the safe direction.
export const NOW_READS_RE =
  /\b(?:now reads|reads now|now says)\b\s*[:—-]?\s*[“"']([\s\S]{4,600}?)[”"']/gi;

// ---- the quotes in a reply ------------------------------------------------

const QUOTE_RES = [
  /“([^”\n]{1,900})”/g,   // “…”
  /"([^"\n]{1,900})"/g,                  // "…"
];

/**
 * Every quotation in a reply worth checking, in order, deduped.
 *
 * `{ quote, page }` — `page` is the page number a nearby "page 12" / "p. 12"
 * puts this quotation on, or 0. The number has to come BEFORE the quote and
 * within one clause of it: a page named after a quotation is talking about
 * something else, and one named three sentences back is not talking about this.
 */
export function quotesIn(text) {
  const clean = stripCode(text);
  const seen = new Set();
  const out = [];
  for (const re of QUOTE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean))) {
      const quote = String(m[1] || '').trim();
      if (!quote || quote.length > QUOTE_MAX) continue;
      if (wordCount(quote) < QUOTE_MIN_WORDS) continue;
      const key = normalize(quote);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ quote, page: pageNear(clean, m.index), at: m.index });
    }
  }
  return out.sort((a, b) => a.at - b.at).map(({ quote, page }) => ({ quote, page }));
}

// "page 12", "p. 12", "pp. 12" — the last one before the quote, within a clause.
export function pageNear(text, at) {
  const win = String(text || '').slice(Math.max(0, at - PAGE_NEAR), at);
  const re = /\b(?:pages?|pp?)\.?\s*(\d{1,4})\b/gi;
  let m;
  let n = 0;
  while ((m = re.exec(win))) n = Number(m[1]) || 0;
  return n > 0 ? n : 0;
}

/** Every `now reads: "…"` wording claimed in a reply, deduped, in order. */
export function newWordings(text) {
  const clean = stripCode(text);
  const seen = new Set();
  const out = [];
  NOW_READS_RE.lastIndex = 0;
  let m;
  while ((m = NOW_READS_RE.exec(clean))) {
    const quote = String(m[1] || '').trim();
    if (!quote) continue;
    const key = normalize(quote);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(quote);
  }
  return out;
}

// ---- the check itself -----------------------------------------------------

const contains = (haystack, needle) => {
  const h = normalize(haystack);
  const n = normalize(needle);
  return !!(h && n && h.includes(n));
};

/**
 * Check one bot reply.
 *
 * Sources, all optional — a source that is not there means those claims are not
 * checkable, and an unchecked claim gets NO stamp rather than a failing one:
 *
 *   pageText     the page's snapshot text (store.snapshotPdfText)
 *   pageTextOf   (n) => that page's text, on a paged document
 *   fileText     the artifact/blog file's CURRENT contents, for `now reads`
 *
 * Returns `[{kind, ok, detail, quote}]`, capped, or `[]` when there was nothing
 * to check. `[]` is the caller's signal to store no field at all.
 */
export function checkReply(text, { pageText = '', pageTextOf = null, fileText = '' } = {}) {
  const body = String(text || '');
  if (!body.trim()) return [];
  const out = [];
  const claimed = new Set();

  // 1. the rewrite claims, first — they are the strongest thing a bot says
  //    about a document and the one the reader acts on without re-reading.
  if (fileText) {
    for (const quote of newWordings(body)) {
      claimed.add(normalize(quote));
      const ok = contains(fileText, quote);
      out.push({ kind: 'now-reads', ok, quote,
        detail: ok ? 'the new wording is in the file'
          : 'the new wording is not in the file' });
      if (out.length >= CHECKS_MAX) return out;
    }
  } else {
    // no file to check against: the wording is still a quotation and must not
    // fall through into the page check as if it came OFF the page
    for (const quote of newWordings(body)) claimed.add(normalize(quote));
  }

  // 2. the quotations presented as coming from the document
  if (pageText || pageTextOf) {
    for (const { quote, page } of quotesIn(body)) {
      if (claimed.has(normalize(quote))) continue;
      if (page && pageTextOf) {
        const only = String(pageTextOf(page) || '');
        // a page whose text the viewer never stored is not a page this can
        // speak about — skip rather than guess (SPEC: "else skip")
        if (!only) continue;
        const ok = contains(only, quote);
        out.push({ kind: 'page', ok, quote, page,
          detail: ok ? `quote found on page ${page}` : `not found on page ${page}` });
      } else if (pageText) {
        const ok = contains(pageText, quote);
        out.push({ kind: 'quote', ok, quote,
          detail: ok ? 'quote found' : 'not found in the page' });
      } else {
        continue;
      }
      if (out.length >= CHECKS_MAX) return out;
    }
  }
  return out;
}

/**
 * The one line the drawer, the bubbles and the council web all stamp a message
 * with. Written here so the three cannot drift: a stamp that said different
 * things in two places would be worse than no stamp.
 */
export function stampOf(checks) {
  const rows = (Array.isArray(checks) ? checks : []).filter(c => c && c.detail);
  if (!rows.length) return null;
  const bad = rows.filter(c => !c.ok);
  if (!bad.length) {
    return { ok: true, label: rows.length === 1 ? 'quote checked' : `${rows.length} quotes checked`,
      title: rows.map(c => `${c.detail}: “${c.quote}”`).join('\n') };
  }
  const first = bad[0];
  const label = first.kind === 'now-reads' ? 'the new wording is not in the file'
    : first.kind === 'page' ? `quote not found on page ${first.page}`
      : 'quote not found in the page';
  return { ok: false, label: bad.length > 1 ? `${label} (+${bad.length - 1} more)` : label,
    title: bad.map(c => `${c.detail}: “${c.quote}”`).join('\n') };
}
