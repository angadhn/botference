// span-match.js — whitespace- and smart-quote-tolerant span matching, shared
// by the browser (review.js inline tracked changes) and node (apply.mjs
// unique-span apply). Suggestion cards carry single-spaced ASCII-quoted
// current_text while rendered page text wraps lines mid-paragraph and uses
// pandoc's typographic quotes (’ “ ”), so exact matching silently fails.
// Matching collapses every whitespace run to a single space and folds curly
// quotes to ASCII on BOTH sides; an index map carries each hit back to TRUE
// offsets in the raw string, so wrapping and replacement always operate on
// the original text.
// UMD-lite: `module.exports` under CommonJS, `window.SpanMatch` in the page.
(function (root) {
  'use strict';

  const QUOTES = { '‘': "'", '’': "'", '“': '"', '”': '"' };
  const foldQuotes = s => s.replace(/[‘’“”]/g, q => QUOTES[q]);

  // normalized copy of raw + map[i] = raw offset of normalized char i
  function normIndex(raw) {
    let norm = '';
    const map = [];
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) { // \s includes nbsp, which pandoc emits for ~
        if (norm && norm[norm.length - 1] !== ' ') { norm += ' '; map.push(i); }
      } else {
        norm += QUOTES[raw[i]] || raw[i];
        map.push(i);
      }
    }
    return { norm, map };
  }

  // all (up to `limit`) whitespace-tolerant matches of needle in raw, as
  // {start, end} offsets into raw. Needle whitespace is normalized and
  // trimmed; an empty needle matches nothing. end is exclusive and lands
  // on the last matched non-space character + 1 (trailing raw whitespace
  // inside a collapsed run is never swallowed).
  function findSpans(raw, needle, limit = 10) {
    const nn = foldQuotes(String(needle == null ? '' : needle)).replace(/\s+/g, ' ').trim();
    if (!nn) return [];
    const { norm, map } = normIndex(String(raw == null ? '' : raw));
    const spans = [];
    let from = 0, at;
    while (spans.length < limit && (at = norm.indexOf(nn, from)) !== -1) {
      spans.push({ start: map[at], end: map[at + nn.length - 1] + 1 });
      from = at + 1;
    }
    return spans;
  }

  const api = { normIndex, findSpans };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpanMatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
