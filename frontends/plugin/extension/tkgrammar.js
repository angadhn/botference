// tkgrammar.js — where the reader's message asks an agent to write a passage.
//
// One parser for the drawer (which shows each gap as an agent block inside the
// reader's own message) and the companion (which fills gaps when the owner
// sends, and writes them into notes). Loaded as a content script before
// drawer.js and required in node, as config.js is. Nothing here touches the
// network or the DOM.
//
// THE GRAMMAR. Three spellings of one thing, a gap with an instruction:
//   own line  a line that is `/tk ` and an instruction, from the start of the
//             line (up to three spaces in) to its end. A block: its fill may
//             hold paragraphs.
//   inline    `/tk(instruction)`, anywhere after the start of a line, a space
//             or an opening bracket; brackets inside nest; it ends at the
//             matching `)` and stays on one line.
//   studio    Blygger Studio's own `[TK] instruction [/TK]`, any case, accepted
//             as an alias.
// Never a gap: anything in code (an inline code span, a fenced block); `\/tk`
// (the backslash says "the letters"); `/tk` with no instruction; `/tk` glued
// to a word ("a/tk(" in a link). Studio's `[TK] … [=] … [/TK]`, which already
// holds its text, is the reader's own words, not a request.
(function (root) {
  'use strict';

  const MAX_GAPS = 8;            // gaps read from one message; the rest stay text
  const INSTRUCTION_MAX = 500;   // longer instructions are kept but not sent

  // true at every index of `text` that is inside code
  function codeMask(text) {
    const mask = new Array(text.length).fill(false);
    let fence = '';
    let at = 0;
    for (const line of text.split('\n')) {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f || fence) for (let i = 0; i < line.length; i++) mask[at + i] = true;
      if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = ''; }
      else if (!fence) {
        let i = 0;
        while (i < line.length) {
          const t = /`+/.exec(line.slice(i));
          if (!t) break;
          const s = i + t.index;
          const close = line.indexOf(t[0], s + t[0].length);
          if (close === -1) break;
          for (let k = s; k < close + t[0].length; k++) mask[at + k] = true;
          i = close + t[0].length;
        }
      }
      at += line.length + 1;
    }
    return mask;
  }

  /**
   * The gaps in `text`, in order: [{ start, end, form, instruction }]. `start`
   * and `end` cover the whole mark, so text.slice(start, end) is what the
   * reader typed for it. At most MAX_GAPS.
   */
  function parseGaps(text) {
    const s = String(text == null ? '' : text);
    if (!/\/tk|\[tk\]/i.test(s)) return [];
    const mask = codeMask(s);
    const found = [];
    // own line
    let at = 0;
    for (const line of s.split('\n')) {
      const m = /^( {0,3})\/tk[ \t]+(\S[^\n]*)$/i.exec(line);
      if (m && !mask[at + m[1].length]) {
        found.push({ start: at + m[1].length, end: at + line.length, form: 'line', instruction: m[2].trim() });
      }
      at += line.length + 1;
    }
    // inline
    for (const m of s.matchAll(/\/tk\(/gi)) {
      const i = m.index;
      if (mask[i]) continue;
      const before = i === 0 ? '\n' : s[i - 1];
      if (before === '\\') continue;
      if (!/[\s([{]/.test(before)) continue;
      let depth = 0;
      let j = i + 3;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '\n') { j = -1; break; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
      }
      if (j === -1 || j >= s.length) continue;
      const instruction = s.slice(i + 4, j).trim();
      if (instruction) found.push({ start: i, end: j + 1, form: 'inline', instruction });
    }
    // Studio's alias
    const tokens = [];
    for (const m of s.matchAll(/\[\/?tk\]/gi)) if (!mask[m.index]) tokens.push({ at: m.index, len: m[0].length, open: m[0][1] !== '/' });
    for (let k = 0; k < tokens.length - 1; k++) {
      if (!tokens[k].open || tokens[k + 1].open) continue;
      const inner = s.slice(tokens[k].at + tokens[k].len, tokens[k + 1].at);
      k++;
      if (inner.indexOf('[=]') !== -1 || !inner.trim()) continue;
      found.push({ start: tokens[k - 1].at, end: tokens[k].at + tokens[k].len, form: 'studio', instruction: inner.trim() });
    }
    // in order; an overlap (a /tk inside an alias) keeps the earlier one
    found.sort((a, b) => a.start - b.start);
    const out = [];
    for (const g of found) {
      if (out.length && g.start < out[out.length - 1].end) continue;
      out.push(g);
      if (out.length >= MAX_GAPS) break;
    }
    return out;
  }

  // the reader's text with `\/tk` written as the letters "/tk" (the escape
  // has done its job once the gaps are found)
  // (outside code only: in code a backslash is a backslash)
  function unescape(text) {
    const s = String(text == null ? '' : text);
    if (!/\\\/tk/i.test(s)) return s;
    const mask = codeMask(s);
    return s.replace(/\\\/tk/gi, (m, i) => (mask[i] ? m : m.slice(1)));
  }

  const api = { MAX_GAPS, INSTRUCTION_MAX, parseGaps, codeMask, unescape };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPTkGrammar = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
