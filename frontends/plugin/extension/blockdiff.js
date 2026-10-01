// blockdiff.js — a suggestion card's RENDERED change, placed on the live page.
//
// The companion (preview.mjs) hands back two builds of a book chapter: the
// article as the notebook stands (BASE) and as it would read with the card
// applied (CARD). This file works out what to show where:
//
//   1. both articles are flattened into top-level blocks — the children of
//      article.bd-article, with every <section> opened up, exactly the way the
//      book's own learn-mode script reads a chapter;
//   2. BASE is diffed against CARD block by block (longest common
//      subsequence on each block's text). Same build, same file: the blocks
//      that differ are the card's and nothing else's;
//   3. BASE is matched against the LIVE page the same way, on a looser key —
//      maths and the page's own controls left out, because MathJax has
//      typeset the live page's formulas and learn mode has added buttons to
//      its check cards — so each changed block can be found on screen.
//
// PURE CORE (no DOM): lcsPairs, planHunks — tested in node (test/blockdiff.test.mjs).
// DOM HALF (thin):    blocksOf, fullKey, looseKey.
(function (root) {
  'use strict';

  // ---- pure ---------------------------------------------------------------

  /**
   * The matched index pairs [i, j] of a longest common subsequence of two
   * key arrays, in order. A shared head and tail are matched first and
   * outright, so a chapter of a thousand blocks with one changed costs
   * almost nothing; the DP runs on what is left between them.
   */
  function lcsPairs(a, b) {
    const pairs = [];
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) { pairs.push([lo, lo]); lo++; }
    let ea = a.length, eb = b.length;
    const tail = [];
    while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; tail.push([ea, eb]); }
    const n = ea - lo, m = eb - lo;
    if (n && m) {
      // dp[i][j] = LCS length of a[lo+i..ea) and b[lo+j..eb)
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * w + j] = a[lo + i] === b[lo + j] ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[lo + i] === b[lo + j]) { pairs.push([lo + i, lo + j]); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
        else j++;
      }
    }
    for (let k = tail.length - 1; k >= 0; k--) pairs.push(tail[k]);
    return pairs;
  }

  /**
   * Where a card's change lands on the live page.
   *
   *   base, card  full keys of the two preview builds
   *   baseLoose   loose keys of the base build (same order as `base`)
   *   live        loose keys of the live page's blocks
   *
   * Returns `{hunks, unplaced}`. Each hunk is one run of change:
   *   remove  live block indices to dim and strike (old blocks found on screen)
   *   add     card block indices to render, in order
   *   after   the live index the added blocks go right after, or -1 with
   *   before  the live index they go right before (the hunk opens the chapter)
   * A hunk with nothing on screen to stand by is not returned; `unplaced`
   * counts them, so the caller can fall back to the drawer's own preview.
   */
  function planHunks(base, card, baseLoose, live) {
    const bc = lcsPairs(base, card);
    const bl = lcsPairs(baseLoose, live);
    const onLive = new Map(bl.map(([b, l]) => [b, l]));
    // the alignment, walked with sentinels at both ends
    const steps = bc.concat([[base.length, card.length]]);
    const hunks = [];
    let unplaced = 0;
    let pb = -1, pc = -1;
    for (const [nb, nc] of steps) {
      const removed = [];
      for (let b = pb + 1; b < nb; b++) removed.push(b);
      const added = [];
      for (let c = pc + 1; c < nc; c++) added.push(c);
      pb = nb; pc = nc;
      if (!removed.length && !added.length) continue;
      const remove = removed.map(b => onLive.get(b)).filter(l => l !== undefined);
      let after = -1, before = -1;
      if (remove.length) after = remove[remove.length - 1];
      else {
        // the nearest unchanged base block above that is on screen…
        for (let b = removed.length ? removed[0] - 1 : nb - 1; b >= 0 && after < 0; b--) {
          if (onLive.has(b)) after = onLive.get(b);
        }
        // …or, at the very top, the nearest one below
        if (after < 0) {
          for (let b = nb; b < base.length && before < 0; b++) if (onLive.has(b)) before = onLive.get(b);
        }
      }
      if ((removed.length && !remove.length && !added.length)
        || (added.length && after < 0 && before < 0)) { unplaced++; continue; }
      if (removed.length && remove.length < removed.length) unplaced++;
      hunks.push({ remove, add: added, after, before });
    }
    return { hunks, unplaced };
  }

  // ---- dom ----------------------------------------------------------------

  const NOT_BLOCKS = /^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT)$/;
  // The reading-order blocks of an article: <section>s opened up, and our own
  // overlay (and anything else of ours) left out.
  function blocksOf(article) {
    const out = [];
    (function walk(node) {
      for (const c of Array.prototype.slice.call(node.children || [])) {
        if (NOT_BLOCKS.test(c.tagName)) continue;
        if (c.id === 'bfp-root' || (c.classList && (c.classList.contains('bfp-ui') || c.classList.contains('bfp-rp')))) continue;
        if (c.tagName === 'SECTION') walk(c); else out.push(c);
      }
    })(article);
    return out;
  }

  const squash = s => String(s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  const OURS = 'ins.bfp-prop-ins, del.bfp-was, img.bfp-prop-img, .bfp-ui, #bfp-root, script, style';
  // a picture's file name, not its address: the live page and a preview build
  // sit at the same depth, but a name is all a block's identity needs
  const picsOf = el => [el].concat(Array.prototype.slice.call(el.querySelectorAll('img')))
    .filter(i => i.tagName === 'IMG' && !(i.classList && i.classList.contains('bfp-prop-img')))
    .map(i => String(i.getAttribute('src') || '').split(/[?#]/)[0].split('/').pop()).filter(Boolean);

  function keyOf(el, strip) {
    const c = el.cloneNode(true);
    for (const n of c.querySelectorAll(strip)) n.remove();
    const pics = picsOf(el);
    return el.tagName + '|' + squash(c.textContent) + (pics.length ? '|' + pics.join(',') : '');
  }
  // Every character of the block, maths' TeX included: the key two preview
  // builds are compared on, where an equation edited is a block changed.
  function fullKey(el) { return keyOf(el, OURS); }
  // …and the one the live page is compared on, which leaves out what the
  // live page renders differently from a raw build: typeset maths, the
  // learn-mode controls and its rewritten card titles, permalink anchors,
  // copy buttons.
  const LOOSE = OURS + ', .math, mjx-container, mjx-assistive-mml, .MathJax, .katex, '
    + '.headerlink, .sdb-ui, .lm-ctl, .admonition-title, button, textarea, .copybtn';
  function looseKey(el) { return keyOf(el, LOOSE); }

  const api = { lcsPairs, planHunks, blocksOf, fullKey, looseKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPBlockDiff = api;
})(typeof window !== 'undefined' ? window : globalThis);
