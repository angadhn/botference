// tkgrammar.js — where the reader's message asks an agent to write a passage, or marks text an agent wrote elsewhere.
//
// One parser for the drawer (which shows each gap as an agent block inside the
// reader's own message) and the companion (which fills gaps when the owner
// sends, and writes them into notes). Loaded as a content script before
// drawer.js and required in node, as config.js is. Nothing here touches the
// network or the DOM.
//
// THE GRAMMAR. A slash word, then what it is about, in one of two shapes:
//   own line  a line that is the word, a space and the rest, from the start of
//             the line (up to three spaces in) to its end. A block: its fill may
//             hold paragraphs.
//   inline    the word, then `(…)`, anywhere after the start of a line, a space
//             or an opening bracket; brackets inside nest; it ends at the
//             matching `)` and stays on one line.
// The words (KINDS × AGENTS, in one table, WORDS):
//   /tk  /tk-claude  /tk-codex        ASK an agent to write the passage; what follows is the instruction. Plain /tk is Claude.
//   /tkimpyrt-claude  /tkimpyrt-codex  text the reader PASTED from that maker's tool: no agent is asked; what follows is the text.
// The other line word, /quote (quoteMarks, below), is no gap: it places the thread's quoted passage.
// Never a gap: anything in code (an inline code span, a fenced block); a slash word
// after a backslash (`\/tk`: the letters); a word with nothing after it; a word
// glued to a word before it ("a/tk(" in a link).
// Blygger Studio's bracket form (`[TK] … [/TK]`) is NOT a gap any more in what the
// reader types. Messages stored while it was one still render: `gapsFor(text, stored)`
// reads a stored message with the old alias when, and only when, its stored gaps
// were made from it.
(function (root) {
  'use strict';

  const MAX_GAPS = 8;            // gaps read from one message; the rest stay text
  const INSTRUCTION_MAX = 500;   // longer instructions are kept but not sent
  const PASTED_MAX = 4000;       // longer pasted text is kept but not taken as a gap's text
  // what a gap is, named once: ASK an agent to write it, or text the reader PASTED from an agent's tool (impyrt)
  const KINDS = Object.freeze(['ask', 'impyrt']);
  const AGENTS = Object.freeze(['claude', 'codex']);
  // the slash words, lower case → what they mean
  const WORDS = Object.freeze({
    tk: Object.freeze({ kind: 'ask', agent: 'claude' }),
    'tk-claude': Object.freeze({ kind: 'ask', agent: 'claude' }),
    'tk-codex': Object.freeze({ kind: 'ask', agent: 'codex' }),
    'tkimpyrt-claude': Object.freeze({ kind: 'impyrt', agent: 'claude' }),
    'tkimpyrt-codex': Object.freeze({ kind: 'impyrt', agent: 'codex' }),
  });
  // longest first, so `/tk-claude` is never read as `/tk` followed by "-claude"
  const WORD_RE = '(tkimpyrt-claude|tkimpyrt-codex|tk-claude|tk-codex|tk)';

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
   * The gaps in `text`, in order: [{ start, end, form, kind, agent, instruction }]. `start`
   * and `end` cover the whole mark, so text.slice(start, end) is what the
   * reader typed for it. `instruction` is what follows the word: the instruction of an
   * `ask`, the pasted text of an `impyrt`. At most MAX_GAPS.
   * `opts.studio` (only for a message STORED while the bracket alias was a gap): also read `[TK] … [/TK]` (kind ask, Claude).
   */
  function parseGaps(text, opts) {
    const s = String(text == null ? '' : text);
    const studio = !!(opts && opts.studio);
    if (!/\/tk/i.test(s) && !(studio && /\[tk\]/i.test(s))) return [];
    const mask = codeMask(s);
    const found = [];
    // own line
    let at = 0;
    const lineRe = new RegExp('^( {0,3})\\/' + WORD_RE + '[ \\t]+(\\S[^\\n]*)$', 'i');
    for (const line of s.split('\n')) {
      const m = lineRe.exec(line);
      if (m && !mask[at + m[1].length]) {
        const w = WORDS[m[2].toLowerCase()];
        found.push({ start: at + m[1].length, end: at + line.length, form: 'line', kind: w.kind, agent: w.agent, instruction: m[3].trim() });
      }
      at += line.length + 1;
    }
    // inline
    for (const m of s.matchAll(new RegExp('\\/' + WORD_RE + '\\(', 'gi'))) {
      const i = m.index;
      if (mask[i]) continue;
      const before = i === 0 ? '\n' : s[i - 1];
      if (before === '\\') continue;
      if (!/[\s([{]/.test(before)) continue;
      const w = WORDS[m[1].toLowerCase()];
      const open = i + m[0].length - 1;   // the "("
      let depth = 0;
      let j = open;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '\n') { j = -1; break; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
      }
      if (j === -1 || j >= s.length) continue;
      const instruction = s.slice(open + 1, j).trim();
      if (instruction) found.push({ start: i, end: j + 1, form: 'inline', kind: w.kind, agent: w.agent, instruction });
    }
    // the old bracket alias, for a stored message only
    if (studio) {
      const tokens = [];
      for (const m of s.matchAll(/\[\/?tk\]/gi)) if (!mask[m.index]) tokens.push({ at: m.index, len: m[0].length, open: m[0][1] !== '/' });
      for (let k = 0; k < tokens.length - 1; k++) {
        if (!tokens[k].open || tokens[k + 1].open) continue;
        const inner = s.slice(tokens[k].at + tokens[k].len, tokens[k + 1].at);
        k++;
        if (inner.indexOf('[=]') !== -1 || !inner.trim()) continue;
        found.push({ start: tokens[k - 1].at, end: tokens[k].at + tokens[k].len, form: 'studio', kind: 'ask', agent: 'claude', instruction: inner.trim() });
      }
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

  // The key a gap is matched by, between the text and what is stored for it (an edit keeps a fill whose key did not change).
  const gapKey = g => [g.kind || 'ask', g.agent || 'claude', g.instruction].join('\u0000');
  // The gaps of a STORED message, read the way its gaps were made: with the old bracket alias only when the stored gaps line up
  // with that reading (a message written while `[TK] … [/TK]` was a gap), otherwise as the grammar is now.
  function gapsFor(text, stored) {
    const now = parseGaps(text);
    const list = Array.isArray(stored) ? stored : [];
    if (!list.length || !/\[tk\]/i.test(String(text || ''))) return now;
    const old = parseGaps(text, { studio: true });
    const lines = (found) => found.length === list.length && found.every((f, i) => list[i] && list[i].instruction === f.instruction);
    if (lines(now)) return now;
    return lines(old) ? old : now;
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

  // THE /quote MARKER. A line that is only the word `/quote` (any case, spaces or tabs around it) says where the thread's quoted
  // passage goes in the post (blyg-note.mjs renderShortNote). Never a marker: in code (an inline code span, a fenced block), inside
  // a gap (a /tk line's instruction; an agent's passage is not in the reader's text at all), or anything else on the line.
  const QUOTE_WORD = '/quote';
  const QUOTE_LINE = /^[ \t]*\/quote[ \t]*$/i;
  /** Every marker line of `text`, in order: [{ start, end }] (text.slice(start, end) is the whole line). `gaps`: the gaps already
   *  read from it (gapsFor), else parseGaps(text). */
  function quoteMarks(text, gaps) {
    const s = String(text == null ? '' : text);
    if (!/\/quote/i.test(s)) return [];
    const mask = codeMask(s);
    const found = Array.isArray(gaps) ? gaps : parseGaps(s);
    const out = [];
    let at = 0;
    for (const line of s.split('\n')) {
      const m = QUOTE_LINE.exec(line);
      const word = at + line.search(/\//);
      if (m && !mask[word] && !found.some(g => word >= g.start && word < g.end)) out.push({ start: at, end: at + line.length });
      at += line.length + 1;
    }
    return out;
  }

  const api = { MAX_GAPS, INSTRUCTION_MAX, PASTED_MAX, KINDS, AGENTS, WORDS, parseGaps, gapsFor, gapKey, codeMask, unescape, QUOTE_WORD, quoteMarks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPTkGrammar = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
