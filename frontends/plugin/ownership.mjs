// ownership.mjs — who owns which words of a blog post, enforced at turn-end.
//
// ── THE RULE (2026-11-06, the owner's decision; widened 2026-11-07) ────────
// On the reader's own blog in direct-edit mode the bots write the post's
// markdown themselves. That stays true for exactly one kind of text: a
// CALLOUT — a blockquote whose first line carries a callout tag:
//
//     > [!note] Agent check: is "five times" right?
//     > [!tip] Answer: yes, five
//     > [!warning] How the 2030 figure is reached
//
// Any type (note, warning, tip …), any title. The owner writes the prose and
// the bots write the callouts, so callout blocks are the BOTS' territory: they
// may add one between paragraphs, edit inside one, or remove one, and the
// change stays as written — no marker on the page and no approval.
//
// EVERY OTHER BYTE OF THE POST IS THE READER'S: their prose, a sentence added
// between two of their sentences, their front matter, their own inline
// "agent check" prompts, their plain blockquotes (`> ` with no `[!type]`). A
// bot change there is PUT BACK in the file and turned into a propose-first
// suggestion card (suggest.mjs's card: current → proposed → why, unique-span
// apply, drift refusal) on the conversation that asked. The prompt asks the
// bots to propose prose changes as ```suggest blocks in the first place; this
// file is the backstop that holds when one forgets.
//
// ── WHY STEPS, NOT ONE DIFF ────────────────────────────────────────────────
// The reader can be typing in Obsidian while a bot turn runs. A single
// turn-start → turn-end diff cannot tell their words from the bot's, and the
// one promise that matters is that THEIR words survive. So the companion keeps
// every version of the file it saw during the turn (turnwatch.mjs), each one
// labelled with who most likely wrote it, and `settle` replays them in order:
//
//   · a USER step is kept as it is — and where it lands on a bot change that
//     was being held back, the user's text wins and the hold is dropped;
//   · a BOT step inside a callout is kept as it is;
//   · any other BOT step is HELD: the reader's text from before it is what the
//     file will say, and the bot's text becomes a card.
//
// The result is the file with only the held bot hunks reverted — never the
// turn-start snapshot written back, so nothing the reader typed meanwhile can
// be lost by the revert.
//
// Everything in this file is PURE: strings in, strings and plans out.

import SpanMatch from '../review/assets/span-match.js';
const { findSpans } = SpanMatch;

// ---- the one matcher: is this line the head of a callout? ------------------
//
// The site's own renderer decides what a callout is (_plugins/callout.rb:
// `^> \[!([A-Za-z]+)([^\]]*)\]`), and this says the same thing: a line that
// starts (column 0) with `> ` — one space, as the renderer wants — then a
// callout tag `[!type]` whose type is letters, optionally followed inside the
// brackets by more words (`[!note My title]`). What comes after the `]` is
// free: a fold marker, a title, or nothing.
//
//     > [!note] Agent check: is "five times" right?       ✓
//     > [!tip] Answer: yes                                 ✓
//     > [!warning]- How the date was found                 ✓
//     > [!note My own title]                               ✓
//     > [!note]                                            ✓
//     > A plain quote                                      ✗ (no callout tag)
//     >[!tip] No space                                     ✗ (the renderer shows a blockquote)
//       > [!note] Indented                                 ✗ (not column 0)
//
// The block it heads runs, like the renderer's `(?=\n\n|\Z)`, to the first
// blank line or the end of the file. A line of only spaces counts as blank
// here, which can only make the block SHORTER than the renderer's — the safe
// direction, since anything outside the block is the reader's.
export const CALLOUT_RE = /^> \[![A-Za-z]+[^\]\n]*\]/;
export const isCalloutHead = line => CALLOUT_RE.test(String(line == null ? '' : line));

const lineStarts = text => {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
};

// Front matter (`---` … `---` at the very top) — never callout territory.
export function frontMatterEnd(text) {
  const m = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text || ''));
  return m ? m[0].length : 0;
}

/** Every callout block in a markdown source, as char ranges. */
export function calloutBlocks(text) {
  const src = String(text == null ? '' : text);
  const starts = lineStarts(src);
  const fm = frontMatterEnd(src);
  const out = [];
  let fence = null;
  for (let li = 0; li < starts.length; li++) {
    const s = starts[li];
    if (s < fm) continue;
    const e = li + 1 < starts.length ? starts[li + 1] - 1 : src.length;
    const line = src.slice(s, e);
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0].repeat(f[1].length);
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence || !isCalloutHead(line)) continue;
    // to the first blank line
    let end = e;
    let lj = li + 1;
    for (; lj < starts.length; lj++) {
      const ls = starts[lj];
      const le = lj + 1 < starts.length ? starts[lj + 1] - 1 : src.length;
      if (!src.slice(ls, le).trim()) break;
      end = le;
    }
    out.push({ start: s, end });
    li = lj - 1;
  }
  return out;
}

// A block widened over the whitespace either side of it — the blank lines
// that separate it from the prose belong to it for the purpose of adding or
// removing the whole block.
function zonesOf(text, blocks) {
  return blocks.map(b => {
    let s = b.start, e = b.end;
    while (s > 0 && /\s/.test(text[s - 1])) s--;
    while (e < text.length && /\s/.test(text[e])) e++;
    return { start: s, end: e };
  });
}
const inZone = (zones, s, e) => zones.some(z => z.start <= s && e <= z.end);
// An insertion point that sits on a paragraph boundary: inside a whitespace
// run holding a blank line, or at either end of the file.
function onParagraphGap(text, at) {
  let s = at, e = at;
  while (s > 0 && /\s/.test(text[s - 1])) s--;
  while (e < text.length && /\s/.test(text[e])) e++;
  if (s === 0 || e === text.length) return true;
  return /\n[ \t]*\n/.test(text.slice(s, e));
}
// One side of a hunk is callout territory when it is wholly inside a block's
// zone — or, if it is empty, when it sits in a zone or on a paragraph gap
// (a whole new block being added, or a whole one leaving).
function sideOk(text, zones, s, e) {
  if (s === e) return inZone(zones, s, s) || onParagraphGap(text, s);
  return inZone(zones, s, e);
}
const hasInk = s => /\S/.test(s);

/**
 * Is this change wholly the bots' — inside callouts on both sides?
 * `a,b` is the old range in `oldText`, `c,d` the new range in `newText`.
 */
export function calloutHunk(oldText, newText, h, zonesOld, zonesNew) {
  const zo = zonesOld || zonesOf(oldText, calloutBlocks(oldText));
  const zn = zonesNew || zonesOf(newText, calloutBlocks(newText));
  const oldPart = oldText.slice(h.a, h.b);
  const newPart = newText.slice(h.c, h.d);
  // a change of whitespace alone between two of the reader's paragraphs is a
  // change to the reader's layout, so at least one side must carry a block
  if (!hasInk(oldPart) && !hasInk(newPart) && !(inZone(zo, h.a, h.b) && inZone(zn, h.c, h.d))) return false;
  return sideOk(oldText, zo, h.a, h.b) && sideOk(newText, zn, h.c, h.d);
}

// ---- the diff -------------------------------------------------------------
//
// Lines first (a post is mostly unchanged lines), then each changed run of
// lines token by token — words, whitespace runs, single punctuation marks — so
// a sentence slipped between two of the reader's sentences is one small hunk
// and not a rewritten paragraph. Myers' O(ND) algorithm, with a cap on D:
// past it the run is reported as one hunk, which is coarse and still correct.

const MAX_D_LINES = 2000;
const MAX_D_TOKENS = 2500;

function myers(A, B, maxD) {
  const n = A.length, m = B.length;
  const max = n + m;
  if (!max) return [];
  const cap = Math.min(max, maxD);
  const off = cap + 1;
  const v = new Int32Array(2 * cap + 3);
  // trace[d] keeps only the window [-d-1, d+1] of v as it stood when round d
  // began — the whole array per round would be quadratic in the file length
  const trace = [];
  let found = -1;
  for (let d = 0; d <= cap; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // backtrack into a list of {op:'=', '-', '+'} over indices
  const ops = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const at = kk => vv[kk + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const px = at(prevK);
    const py = px - prevK;
    while (x > px && y > py) { ops.push('='); x--; y--; }
    if (x === px) { ops.push('+'); y--; } else { ops.push('-'); x--; }
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y--; }
  return ops.reverse();
}

// ops over token arrays → hunks in char offsets of the joined strings
function hunksFromOps(ops, A, B, baseA, baseB) {
  const out = [];
  let i = 0, j = 0, pa = baseA, pb = baseB, run = null;
  const close = () => { if (run) { out.push(run); run = null; } };
  for (const op of ops) {
    if (op === '=') { close(); pa += A[i].length; pb += B[j].length; i++; j++; continue; }
    if (!run) run = { a: pa, b: pa, c: pb, d: pb };
    if (op === '-') { pa += A[i].length; i++; run.b = pa; }
    else { pb += B[j].length; j++; run.d = pb; }
  }
  close();
  return out;
}

const splitLines = s => s.match(/[^\n]*\n|[^\n]+$/g) || [];
const TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const tokens = s => s.match(TOKEN_RE) || [];

/** Hunks between two texts: [{a,b,c,d}] — old [a,b) became new [c,d). */
export function diffText(oldText, newText) {
  const A = splitLines(oldText), B = splitLines(newText);
  const lineOps = myers(A, B, MAX_D_LINES);
  const coarse = lineOps ? hunksFromOps(lineOps, A, B, 0, 0)
    : (oldText === newText ? [] : [{ a: 0, b: oldText.length, c: 0, d: newText.length }]);
  const out = [];
  for (const h of coarse) {
    const ta = tokens(oldText.slice(h.a, h.b)), tb = tokens(newText.slice(h.c, h.d));
    const ops = myers(ta, tb, MAX_D_TOKENS);
    if (!ops) { out.push(h); continue; }
    for (const f of hunksFromOps(ops, ta, tb, h.a, h.c)) out.push(f);
  }
  return out;
}

// ---- replaying a turn -------------------------------------------------------

// The reader's text over [s,e) of the working text: the working text with
// every held region inside it swapped back for what it replaced.
function readerText(w, regions, s, e) {
  let out = '', at = s;
  for (const r of regions.filter(x => x.kind === 'held' && x.start >= s && x.end <= e)
    .sort((p, q) => p.start - q.start)) {
    out += w.slice(at, r.start) + r.orig;
    at = r.end;
  }
  return out + w.slice(at, e);
}

const overlaps = (r, a, b) => (a === b ? (r.start < a && a < r.end) : (r.start < b && r.end > a));

/**
 * Replay a turn's versions of a post and decide what the file should say.
 *
 *   base   the post's text when the turn started
 *   steps  [{text, by:'bot'|'user'}] every later version, in order
 *
 * Returns {final, result, held:[{start,end,orig}], callouts:[{start,end}]}:
 * `final` is the last version (what is on disk), `result` is what it should
 * be — final with every held bot hunk put back — and `held`/`callouts` are in
 * FINAL's coordinates (`callouts` is what the bots changed inside callouts:
 * information only, nothing is painted from it).
 */
export function settle(base, steps) {
  let cur = String(base == null ? '' : base);
  let regions = [];   // {kind:'held'|'callout', start, end, orig?}
  for (const step of (steps || [])) {
    const next = String(step && step.text != null ? step.text : '');
    if (next === cur) continue;
    const bot = step.by !== 'user';
    const hunks = diffText(cur, next);
    const zo = zonesOf(cur, calloutBlocks(cur));
    const zn = zonesOf(next, calloutBlocks(next));
    const kinds = hunks.map(h => {
      if (!bot) return 'user';
      const touchesHeld = regions.some(r => r.kind === 'held' && overlaps(r, h.a, h.b));
      return !touchesHeld && calloutHunk(cur, next, h, zo, zn) ? 'callout' : 'prose';
    });
    // apply from the bottom up, so every offset above a hunk stays put
    let w = cur;
    for (let i = hunks.length - 1; i >= 0; i--) {
      const h = hunks[i], kind = kinds[i];
      const t = next.slice(h.c, h.d);
      const delta = t.length - (h.b - h.a);
      const involved = regions.filter(r => overlaps(r, h.a, h.b));
      const rest = regions.filter(r => !involved.includes(r));
      let made = null;
      if (kind === 'prose') {
        const s = Math.min(h.a, ...involved.map(r => r.start));
        const e = Math.max(h.b, ...involved.map(r => r.end));
        made = { kind: 'held', start: s, end: e + delta, orig: readerText(w, involved, s, e) };
      } else if (kind === 'callout' && t.length) {
        const s = Math.min(h.a, ...involved.map(r => r.start));
        const e = Math.max(h.b, ...involved.map(r => r.end));
        made = { kind: 'callout', start: s, end: e + delta };
      }
      // a USER hunk over a held region: the reader's text wins, the hold goes
      regions = rest.map(r => (r.start >= h.b && !(h.a === h.b && r.start < h.a)
        ? { ...r, start: r.start + delta, end: r.end + delta } : r));
      if (made) regions.push(made);
      w = w.slice(0, h.a) + t + w.slice(h.b);
    }
    cur = next;
  }
  regions.sort((p, q) => p.start - q.start);
  const held = regions.filter(r => r.kind === 'held' && (r.orig !== cur.slice(r.start, r.end)));
  const callouts = regions.filter(r => r.kind === 'callout').map(r => ({ start: r.start, end: r.end }));
  return { final: cur, result: readerText(cur, held, 0, cur.length), held, callouts };
}

// ---- held regions → cards ---------------------------------------------------

// Held regions in one paragraph are one card: accepting the first would move
// the words the second is anchored on, and the reader reads a paragraph, not
// a list of fragments.
const GAP_MAX = 160;
export function mergeHeld(final, held) {
  const out = [];
  for (const r of [...held].sort((p, q) => p.start - q.start)) {
    const last = out[out.length - 1];
    if (last) {
      const gap = final.slice(last.end, r.start);
      if (!/\S/.test(gap) || (gap.length <= GAP_MAX && !/\n[ \t]*\n/.test(gap))) {
        last.orig = last.orig + gap + r.orig;
        last.end = r.end;
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

const MIN_INK = 16;
const CONTEXT_MAX = 600;
const isWord = ch => /\S/.test(ch || '');   // whole whitespace-delimited words

/**
 * One card per merged held region, widened until its `current` is a unique
 * span of `result` (the file as it now stands) — suggest.resolveSpan's rule.
 *
 * `current` is the reader's text plus context; `proposed` is the bot's text
 * with the SAME context, so the card's own diff shows only what the bot did.
 * Context never crosses a blank line unless the paragraph itself is not
 * unique; a card that still cannot be made unique is returned anyway with
 * `ambiguous: true` — its Accept will refuse, visibly, like any other.
 */
export function cardsFor(final, result, held) {
  const merged = mergeHeld(final, held);
  // positions of each region in RESULT
  let shift = 0;
  const placed = merged.map(r => {
    const rs = r.start + shift;
    shift += r.orig.length - (r.end - r.start);
    return { ...r, rs, re: rs + r.orig.length };
  });
  return placed.map((r, i) => {
    let L = 0, R = 0;   // context taken on the left and on the right
    const cur = () => result.slice(r.rs - L, r.re + R);
    const prop = () => final.slice(r.start - L, r.end + R);
    // context is text the two versions SHARE, so it never reaches into a
    // neighbouring held region (where they differ)
    const floor = i > 0 ? placed[i - 1].re : 0;
    const ceil = i + 1 < placed.length ? placed[i + 1].rs : result.length;
    const canL = () => r.rs - L > floor && L < CONTEXT_MAX;
    const canR = () => r.re + R < ceil && R < CONTEXT_MAX;
    const grow = side => {
      if (side < 0) { L++; while (canL() && isWord(result[r.rs - L - 1]) && isWord(result[r.rs - L])) L++; }
      else { R++; while (canR() && isWord(result[r.re + R]) && isWord(result[r.re + R - 1])) R++; }
    };
    // whole words at both edges, never whitespace at either
    while (canL() && isWord(result[r.rs - L - 1]) && (L === 0 ? isWord(result[r.rs]) || r.rs === r.re : true)) L++;
    while (canR() && isWord(result[r.re + R]) && (R === 0 ? isWord(result[r.re - 1]) || r.rs === r.re : true)) R++;
    const settled = () => {
      const c = cur();
      if (c.replace(/\s/g, '').length < MIN_INK) return false;
      if (/^\s|\s$/.test(c) || /^\s|\s$/.test(prop())) return false;
      return findSpans(result, c, 2).length === 1;
    };
    let turn = -1;
    let guard = 0;
    while (!settled() && (canL() || canR()) && guard++ < 4000) {
      // prefer the side still inside the paragraph
      const leftOk = canL() && !/\n[ \t]*\n$/.test(result.slice(0, r.rs - L));
      const rightOk = canR() && !/^\n[ \t]*\n/.test(result.slice(r.re + R));
      let side = turn;
      if (side < 0 && !leftOk && rightOk) side = 1;
      if (side > 0 && !rightOk && leftOk) side = -1;
      if (!leftOk && !rightOk) side = canL() ? -1 : 1;
      if (side < 0 && !canL()) side = 1;
      if (side > 0 && !canR()) side = -1;
      grow(side);
      turn = -turn;
    }
    const current = cur().trim();
    const proposed = prop().trim();
    return {
      current, proposed,
      ...(proposed ? {} : { deletes: true }),
      ambiguous: findSpans(result, current, 2).length !== 1,
      at: r.rs,
    };
  });
}

/**
 * The whole decision for one turn of one post, as data. The server writes
 * `result` (compare-and-swap against `final`) and posts `cards` to the turn's
 * conversation. A callout change needs nothing more: it stays as written and
 * leaves no trace on the page (the owner's call, 2026-11-07: "callouts can
 * live happily without the highlights").
 */
export function plan(base, steps) {
  const s = settle(base, steps);
  const cards = s.held.length ? cardsFor(s.final, s.result, s.held) : [];
  return { ...s, cards, changed: s.result !== s.final };
}

// ---- the reader's own ✎ on page prose ---------------------------------------
//
// The figure editor sends a prose edit as the words the PAGE shows
// (`original` → `replacement`) plus the rendered block they sat in. The
// companion writes it straight into the markdown — no bot — but only where the
// page words ARE a unique span of the source:
//
//   · findSpans (the review engine's matcher, the one suggest.mjs uses) finds
//     `original` exactly once in the body; or
//   · it occurs more than once, and exactly one paragraph's rendered words
//     (plainOf, the rule collateral.mjs and blog.mdDoc use) contain the edit's
//     block, and `original` occurs exactly once inside that paragraph.
//
// Anything else — the words cross markup (a link's text and the words around
// it, emphasis that splits them), they are in front matter or in a callout,
// they occur ambiguously, or they are not there at all — is
// NOT written. Those edits go to the bots instead, with the reason.
export function proseEdit(src, edit, plainOf) {
  const text = String(src == null ? '' : src);
  const original = String(edit && edit.original || '').trim();
  const replacement = String(edit && edit.replacement != null ? edit.replacement : '').trim();
  if (!original) return { ok: false, reason: 'empty', detail: 'the edit names no words' };
  if (!replacement) return { ok: false, reason: 'empty', detail: 'the new wording is empty' };
  const fm = frontMatterEnd(text);
  const blocks = calloutBlocks(text);
  const usable = sp => sp.start >= fm && !blocks.some(b => sp.start < b.end && sp.end > b.start);
  const all = findSpans(text, original, 50);
  let hits = all.filter(usable);
  if (!all.length) {
    const already = findSpans(text, replacement, 2).filter(usable);
    if (already.length === 1) return { ok: false, reason: 'already', detail: 'the source already says this' };
    return { ok: false, reason: 'not-found',
      detail: 'those words are not in the source as written (they may run across a link, emphasis or other markup)' };
  }
  if (!hits.length) {
    return { ok: false, reason: 'outside-body',
      detail: all.some(sp => sp.start < fm) ? 'those words are in the front matter' : 'those words are inside a callout (callouts are the bots’ to write)' };
  }
  // Already written? When the new wording CONTAINS the old (an insertion, an
  // expansion: "…of humanity." → "…of humanity. While I am sure…"), the old
  // words still match after the edit landed — inside the new ones — and a
  // second write would add the new words twice. A hit that sits inside an
  // occurrence of the replacement is that edit, done.
  if (replacement.includes(original)) {
    const done = findSpans(text, replacement, 50).filter(usable);
    const fresh = hits.filter(sp => !done.some(d => d.start <= sp.start && sp.end <= d.end));
    if (!fresh.length) return { ok: false, reason: 'already', detail: 'the source already says this' };
    hits = fresh;
  }
  if (hits.length > 1 && edit && edit.block && typeof plainOf === 'function') {
    // narrow to the one paragraph whose rendered words hold the block
    const fold = s => String(s || '').replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
    const want = fold(String(edit.block).replace(/…$/, ''));
    const paras = [];
    const re = /[^\n]+(?:\n(?![ \t]*\n)[^\n]*)*/g;
    let m;
    while ((m = re.exec(text))) {
      if (m.index < fm) continue;
      let plain = '';
      try { plain = fold(plainOf(m[0])); } catch { plain = ''; }
      if (plain && want && plain.includes(want.slice(0, 300))) paras.push({ start: m.index, end: m.index + m[0].length });
    }
    if (paras.length === 1) {
      const inPara = hits.filter(sp => sp.start >= paras[0].start && sp.end <= paras[0].end);
      if (inPara.length === 1) hits = inPara;
    }
  }
  if (hits.length !== 1) {
    return { ok: false, reason: 'ambiguous', matches: hits.length,
      detail: `those words appear ${hits.length} times in the source, so there is no telling which one is meant` };
  }
  const sp = hits[0];
  // a span that crosses a line holding markdown furniture is not a plain run
  // of the reader's words — leave it to the bots
  const raw = text.slice(sp.start, sp.end);
  if (/[[\]*_`<>|]|\]\(/.test(raw) && !/[[\]*_`<>|]/.test(original)) {
    return { ok: false, reason: 'markup', detail: 'those words run across markdown formatting in the source' };
  }
  const after = text.slice(0, sp.start) + replacement + text.slice(sp.end);
  return { ok: true, start: sp.start, end: sp.start + replacement.length, after, before: text };
}
