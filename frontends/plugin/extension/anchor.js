// anchor.js — quote + prefix/suffix anchoring for the Botference Web Annotator.
//
// Adapted from frontends/review/assets/span-match.js. Two layers, deliberately
// separated so the hard part is testable in node:
//
//   PURE CORE (no DOM at all)   normIndex · normalize · findSpans · buildAnchor
//                               · locate · tailOverlap · headOverlap
//     Everything operates on a *raw text string* plus offsets into it. Matching
//     folds whitespace runs to one space, curly quotes to ASCII, dashes to '-',
//     and drops zero-width junk — while an index map carries every hit back to
//     TRUE offsets in the raw string, so painting always cuts the original text.
//
//   DOM ADAPTERS (thin)         buildTextIndex · offsetsFromRange · paintOffsets
//                               · unpaint · setFocus · scrollTo
//     buildTextIndex flattens the page into { raw, segs } where each seg maps a
//     slice of `raw` back to a Text node. Everything else is offset arithmetic.
//
// Anchoring contract (SPEC.md): a thread stores {quote, prefix, suffix}. Re-anchor
// requires an exactly-once match of `quote`; multiple hits are disambiguated by
// prefix/suffix overlap; no hit (or an unresolvable tie) => orphaned.
//
// UMD-lite: `module.exports` under CommonJS (node tests), `window.BFPAnchor` in
// the page (content script / harness).
(function (root) {
  'use strict';

  // ---- pure core ---------------------------------------------------------

  const FOLD = {
    '‘': "'", '’': "'", '‚': "'", '‹': "'", '›': "'",
    '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
    '–': '-', '—': '-', '−': '-', '‑': '-', '‐': '-',
  };
  // zero-width + soft hyphen: present in raw text, invisible to the user, and
  // never present in a stored quote — drop them from the normalized view.
  const INVISIBLE = /[​‌‍⁠﻿­]/;

  const SPACE = /\s/;   // \s covers nbsp, which article HTML is full of

  // Normalized copy of `raw` plus map[i] = raw offset of normalized char i.
  //
  // ── WHY THIS BUILDS AN ARRAY AND JOINS ONCE ────────────────────────────────
  // The obvious spelling accumulates into a string (`norm += c`) and asks the
  // string what its last character was (`norm[norm.length - 1] !== ' '`). That
  // second line is a trap: V8 builds `+=` into a CONS-STRING rope, and INDEXING
  // a rope flattens the whole thing. So every whitespace character in the
  // document re-copied every character before it, and normIndex was O(n²) in
  // the length of the page — invisible on an article, fatal on a book. Measured
  // on a synthetic PDF: 59 ms at 40 pages, 1.0 s at 120, 17.9 s at 500. Since
  // `locate` normalizes the whole page once per thread, a 500-page document
  // with 300 threads spent about ninety MINUTES on a single repaint.
  //
  // Chunks in an array, joined once, and the "was the last emitted character a
  // space" question answered by a boolean instead of by the string. Same output,
  // character for character; linear. (FOLD never maps anything to a space and a
  // space is never a non-space, so the flag is exactly the test it replaces.)
  function normIndex(raw) {
    raw = String(raw == null ? '' : raw);
    const out = [];
    const map = [];
    let lastSpace = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (INVISIBLE.test(c)) continue;
      if (SPACE.test(c)) {
        if (out.length && !lastSpace) { out.push(' '); map.push(i); lastSpace = true; }
      } else {
        out.push(FOLD[c] || c);
        map.push(i);
        lastSpace = false;
      }
    }
    return { norm: out.join(''), map };
  }

  // ── THE HAYSTACK IS NORMALIZED ONCE PER REPAINT, NOT ONCE PER THREAD ───────
  // Every thread on the page is located against the SAME page text, in one
  // loop, with the same `raw` string object. Normalizing it afresh for each of
  // them is the second half of the same bug the note above describes: linear
  // now rather than quadratic, but still multiplied by the thread count. One
  // entry, keyed on string identity — a repaint hits it for every thread after
  // the first, and the next repaint's `raw` (a fresh string) replaces it.
  //
  // Only for haystacks worth caching: a needle is normalized through
  // `normalize()` and must never evict the page. Identity (`===`) rather than
  // content, deliberately — comparing two 1 MB strings to save one traversal of
  // one of them is not a saving.
  const CACHE_MIN = 4096;
  let normCache = null;
  function normIndexOf(raw) {
    if (typeof raw !== 'string' || raw.length < CACHE_MIN) return normIndex(raw);
    if (normCache && normCache.raw === raw) return normCache.idx;
    const idx = normIndex(raw);
    normCache = { raw, idx };
    return idx;
  }

  // Comparable form of a fragment: folded, single-spaced, trimmed.
  const normalize = s => normIndex(s).norm.trim();

  // ---- "this passage now reads: …" ---------------------------------------
  // A bot whose change rewrote the quoted passage is asked to quote the new
  // wording back verbatim (bridge-system-prompt rule 5). That one line is what
  // lets the drawer draw a before→after AND what lets the page find the
  // passage again after the rewrite orphaned it — so the parse lives HERE,
  // beside the locating it feeds, and the drawer and content.js share it
  // rather than each carrying a regex that could drift from the other.
  //
  // Only that explicit phrasing, and only from a BOT. A loose "any quoted
  // string in a reply" rule would move an anchor every time an agent quoted
  // the reader back at themselves.
  // (store.mjs carries the node-side twin, `store.newWording`, for the one
  // thing the companion must not take a client's word for: which wording a
  // /reanchor is allowed to write. Keep the two in step.)
  //
  // THEY HAD DRIFTED, and the drift was a real hole: the companion understood
  // seven phrasings and this copy understood four, so a bot writing "rewrote it
  // to: '…'" produced a re-anchor the companion would have authorized and this
  // file never proposed — the thread simply orphaned instead of following the
  // rewrite. Both copies are the seven now, and anchor.test.mjs pins the regex
  // source and the behaviour of the two against each other, so "keep the two in
  // step" is a test rather than a hope. Change one, change the other.
  const NEW_WORDING_RE =
    /\b(?:(?:now reads|reads now|now says|new wording(?: is)?)\b\s*[:—-]?|(?:reworded|rewritten|rewrote)\b[^"“\n]{0,80}[:—-]|(?:changed|updated)(?: it)? to\b\s*[:—-]?)\s*[“"']([\s\S]{4,400}?)[”"']/i;
  // the same authors the drawer calls bots and store.mjs calls agents — with
  // store's word boundary, so "claudette" is nobody's bot in either file
  const isBotAuthor = a => /^(claude|codex)\b/i.test(String(a || '').trim());

  // The LAST bot word on the wording, or ''. A human writing into the thread
  // after it does not clear this on its own — `addressed` does that, and every
  // caller here is already gated on a thread being addressed.
  function newWording(thread) {
    const msgs = (thread && thread.msgs) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.kind === 'tools' || !isBotAuthor(m.author)) continue;
      const hit = NEW_WORDING_RE.exec(String(m.text || ''));
      return hit ? hit[1].trim() : '';
    }
    return '';
  }

  // Every (up to `limit`) whitespace-tolerant match of `needle` in `raw`, as
  // {start, end} offsets into raw. `end` is exclusive and lands on the last
  // matched non-space character + 1, so trailing raw whitespace inside a
  // collapsed run is never swallowed into the highlight.
  function findSpans(raw, needle, limit) {
    limit = limit || 50;
    const nn = normalize(needle);
    if (!nn) return [];
    const { norm, map } = normIndexOf(raw);
    const spans = [];
    let from = 0, at;
    while (spans.length < limit && (at = norm.indexOf(nn, from)) !== -1) {
      spans.push({ start: map[at], end: map[at + nn.length - 1] + 1 });
      from = at + 1;
    }
    return spans;
  }

  // Longest common suffix / prefix length of two normalized strings.
  function tailOverlap(a, b) {
    let k = 0;
    while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
    return k;
  }
  function headOverlap(a, b) {
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    return k;
  }

  const CTX = 32;      // stored prefix/suffix length (SPEC: ≤32 chars)
  const WINDOW = 160;  // raw chars sampled either side before normalizing

  // Capture an anchor for raw[start,end). Quote is whitespace-collapsed (it is
  // displayed and exported verbatim); prefix/suffix are normalized context.
  function buildAnchor(raw, start, end) {
    raw = String(raw == null ? '' : raw);
    const quote = normalize(raw.slice(start, end));
    const prefix = normalize(raw.slice(Math.max(0, start - WINDOW), start)).slice(-CTX);
    const suffix = normalize(raw.slice(end, end + WINDOW)).slice(0, CTX);
    return { quote, prefix, suffix };
  }

  // Re-anchor. Returns {ok:true, start, end, unique} or
  // {ok:false, reason:'orphan'|'ambiguous'} (both mean "orphan it" to callers
  // that don't care why).
  function locate(raw, anchor, opts) {
    anchor = anchor || {};
    const spans = findSpans(raw, anchor.quote, (opts && opts.limit) || 50);
    if (!spans.length) return { ok: false, reason: 'orphan' };
    if (spans.length === 1) return { ok: true, start: spans[0].start, end: spans[0].end, unique: true };

    const wantPre = normalize(anchor.prefix || '');
    const wantSuf = normalize(anchor.suffix || '');
    if (!wantPre && !wantSuf) return { ok: false, reason: 'ambiguous' };

    const scored = spans.map(s => {
      const pre = normalize(raw.slice(Math.max(0, s.start - WINDOW), s.start));
      const suf = normalize(raw.slice(s.end, s.end + WINDOW));
      return { s, score: tailOverlap(pre, wantPre) + headOverlap(suf, wantSuf) };
    }).sort((a, b) => b.score - a.score);

    if (scored[0].score === 0) return { ok: false, reason: 'ambiguous' };
    if (scored[1] && scored[1].score === scored[0].score) return { ok: false, reason: 'ambiguous' };
    return { ok: true, start: scored[0].s.start, end: scored[0].s.end, unique: false, score: scored[0].score };
  }

  // ---- DOM adapters ------------------------------------------------------
  // (guarded: the pure core above must import cleanly in node)

  const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|EMBED|VIDEO|AUDIO|SELECT|TEXTAREA|INPUT|HEAD|LINK|META)$/;
  const BLOCK_TAGS = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BODY|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H1|H2|H3|H4|H5|H6|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

  // Two tints, one meaning each: yellow is "somebody is still thinking about
  // this passage", green is "this was dealt with". A resolved highlight is NOT
  // removed — the mark is the point, months later, on a re-read.
  //
  // The green is a desaturated sage, deliberately NOT the braid's mint (#34d399
  // / --you, the reader's own speech colour in the drawer): a highlight is a
  // state of a passage, not a speaker, and the two must not read as the same
  // thing. Both tints are translucent and pale for the same reason the yellow
  // always was — they land on pages whose own colours we do not control, dark
  // ones included, and the text under them has to stay readable.
  const HL_BG = 'rgba(250, 210, 80, .45)';
  const HL_BG_FOCUS = 'rgba(250, 190, 60, .6)';
  const HL_BG_DONE = 'rgba(141, 199, 146, .42)';
  const HL_BG_DONE_FOCUS = 'rgba(108, 184, 118, .58)';
  // …and the middle state: a thread a bot has replied into and the reader has
  // not yet filed ("ready for review"). Amber, and deliberately BETWEEN the
  // other two on the same hue arc — yellow says "nobody has been here", amber
  // says "somebody has, your turn", sage says "done". Read down a page, the
  // three tints are a progress bar the reader never has to open the drawer to
  // see.
  const HL_BG_READY = 'rgba(246, 173, 85, .45)';
  const HL_BG_READY_FOCUS = 'rgba(237, 145, 40, .6)';
  // The state lives on the mark itself, as classes, rather than in a table
  // beside it: every restyle (focus, resolve, reopen) can then read the mark's
  // current state off the mark, and a repaint from the record cannot disagree
  // with what is on screen.
  const DONE_CLASS = 'bfp-done';
  const READY_CLASS = 'bfp-ready';
  const FOCUS_CLASS = 'bfp-focused';
  // ---- track changes -----------------------------------------------------
  // A re-anchored ready thread: the highlight sits on the wording the bot put
  // there, and the wording it REPLACED is shown, struck through, immediately
  // before it. Word's idiom, and the drawer's own before→after idiom, on the
  // page itself — so the reader looking at the draft can see where the change
  // landed and what changed without opening a card.
  //
  // The tint is NOT the sage of a resolved highlight. Three background tints
  // already mean three states of a THREAD (open / ready / filed) and a fourth
  // would muddle the one thing the colours are for. So the arrival is marked
  // the way Word marks an insertion — an underline in the accepted colour,
  // over whatever background the thread's state already gives it — and the
  // departure is a struck, dimmed <del> that is not part of the page at all.
  const INS_CLASS = 'bfp-ins';       // on the mark: this wording ARRIVED
  const WAS_CLASS = 'bfp-was';       // the display-only <del> before it
  // Passages are prose spans, not pages. Past this the inline markup stops
  // being a change and starts being a second copy of the document sitting in
  // the middle of the first one, so the highlight is left to speak alone.
  const WAS_MAX = 600;
  const INS_LINE = 'rgba(45, 145, 85, .95)';
  const WAS_BG = 'rgba(203, 68, 58, .10)';

  // ---- the OTHER mark: a strikeout ----------------------------------------
  // Adobe's second tool, and the reason a PDF's selection pill has two. A
  // struck passage is not "look at this", it is "this should go" — a
  // suggestion, with or without a note under it — and it is drawn the way
  // Acrobat draws it: a thin line through the middle of the words, and NO
  // wash. The words stay black on white, exactly as the author left them.
  //
  // WHY A BACKGROUND GRADIENT AND NOT `text-decoration: line-through`.
  // Two reasons, both about not colliding with something that already exists:
  //
  //   · the ins-underline (INS_CLASS above) is a text-decoration, and a single
  //     element has ONE text-decoration-color. A struck passage that a bot
  //     then rewrites would have had to choose between the two lines, or draw
  //     both in one colour. A gradient is a background, so the two markings
  //     are mechanically independent and can sit on the same mark.
  //   · a decoration lands on the font's own strikeout metric, which in a PDF
  //     text layer (spans whose font-size is a scaled glyph height) wanders.
  //     55% of the mark's box is the middle of the x-height for the fonts a
  //     paper is set in, and it is the same 55% at every zoom.
  //
  // And it is NOT the track-changes <del> (WAS_CLASS): that is dimmed to .55
  // over a pale red wash with a hairline in the page's own text colour, and it
  // is a different ELEMENT, painted by a different function, from a different
  // field of the record. This is undimmed, unwashed, and 2px of saturated ink.
  const STRIKE_CLASS = 'bfp-strike';
  // The line carries the thread's state, because the wash it replaced used to.
  // Open is Acrobat's own red — a thin yellow line on white paper is not a
  // line, it is a rumour — and ready/filed keep the amber and the sage the
  // rest of the page reads as a progress bar.
  const STRIKE_LINE = 'rgba(200, 48, 48, .95)';
  const STRIKE_LINE_READY = 'rgba(214, 118, 20, .95)';
  const STRIKE_LINE_DONE = 'rgba(72, 146, 88, .95)';
  // …and focus, which a strike cannot say with a darker wash because it has no
  // wash: the line thickens and the faintest tint of its own colour comes up
  // under it, so a click still lands somewhere visible.
  const STRIKE_FOCUS_BG = 'rgba(200, 48, 48, .12)';
  const STRIKE_FOCUS_BG_READY = 'rgba(214, 118, 20, .14)';
  const STRIKE_FOCUS_BG_DONE = 'rgba(72, 146, 88, .14)';
  // where the line sits in the mark's box: the middle of the x-height, which
  // is a little below the middle of the line box
  const STRIKE_AT = '55%';
  const strikeImage = (color, half) =>
    'linear-gradient(to bottom, transparent 0, transparent calc(' + STRIKE_AT + ' - ' + half + 'px), '
    + color + ' calc(' + STRIKE_AT + ' - ' + half + 'px), ' + color + ' calc(' + STRIKE_AT + ' + ' + half + 'px), '
    + 'transparent calc(' + STRIKE_AT + ' + ' + half + 'px), transparent 100%)';

  function styleMark(mark, focused) {
    const st = mark.style;
    const cl = mark.classList;
    // resolved outranks ready outranks open — a filed thread is filed whatever
    // was claimed about it on the way there
    const done = cl && cl.contains(DONE_CLASS);
    const ready = !done && cl && cl.contains(READY_CLASS);
    const struck = cl && cl.contains(STRIKE_CLASS);
    const bg = struck
      ? (!focused ? 'transparent'
        : done ? STRIKE_FOCUS_BG_DONE : ready ? STRIKE_FOCUS_BG_READY : STRIKE_FOCUS_BG)
      : done ? (focused ? HL_BG_DONE_FOCUS : HL_BG_DONE)
      : ready ? (focused ? HL_BG_READY_FOCUS : HL_BG_READY)
      : (focused ? HL_BG_FOCUS : HL_BG);
    st.setProperty('background-color', bg, 'important');
    // the line itself, and — set both ways every time, for the same reason the
    // ins-underline is — nothing at all where the mark is an ordinary highlight
    if (struck) {
      const line = done ? STRIKE_LINE_DONE : ready ? STRIKE_LINE_READY : STRIKE_LINE;
      st.setProperty('background-image', strikeImage(line, focused ? 1.5 : 1), 'important');
      st.setProperty('background-repeat', 'no-repeat', 'important');
    } else {
      st.removeProperty('background-image');
      st.removeProperty('background-repeat');
    }
    st.setProperty('color', 'inherit', 'important');
    st.setProperty('border-radius', '2px', 'important');
    st.setProperty('padding', '0', 'important');
    st.setProperty('cursor', 'pointer', 'important');
    st.setProperty('box-decoration-break', 'clone', 'important');
    st.setProperty('-webkit-box-decoration-break', 'clone', 'important');
    st.setProperty('transition', 'background-color .15s ease', 'important');
    // …and, where track changes is showing, the Word underline that says this
    // wording ARRIVED. Set both ways every time: styleMark is what a restyle
    // goes through, so a mark that has stopped being an insertion must lose it
    // here rather than keep a stale decoration.
    if (cl && cl.contains(INS_CLASS)) {
      st.setProperty('text-decoration-line', 'underline', 'important');
      st.setProperty('text-decoration-color', INS_LINE, 'important');
      st.setProperty('text-decoration-thickness', '2px', 'important');
      st.setProperty('text-underline-offset', '2px', 'important');
    } else {
      st.removeProperty('text-decoration-line');
      st.removeProperty('text-decoration-color');
      st.removeProperty('text-decoration-thickness');
      st.removeProperty('text-underline-offset');
    }
  }

  function isHidden(el) {
    if (el.hidden) return true;
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    if (!w || !w.getComputedStyle) return false;
    const cs = w.getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  // Flatten a subtree into { raw, segs } where segs[i] = {node, from, to}.
  // node === null marks a synthetic '\n' inserted at block boundaries so a
  // quote can never silently run across two unrelated paragraphs' edges.
  // (The chunks-and-join spelling is not a style choice — see normIndex above.
  // `sep()` asked the accumulated string for its last character at every block
  // boundary, and indexing a `+=` rope flattens it, so the walk was O(n²) in
  // the document's own length: 2.6 SECONDS on a 500-page PDF, for a walk that
  // touches 36,000 nodes and should cost tens of milliseconds. The question
  // "does what we have so far end in a newline" is answered by a flag instead,
  // and the pieces are joined once at the end. Byte-identical output.)
  function buildTextIndex(rootEl) {
    const doc = (typeof document !== 'undefined') ? document : null;
    const start = rootEl || (doc && doc.body) || null;
    const segs = [];
    const chunks = [];
    let len = 0;
    let endsNl = true;            // "" counts: the original bailed on empty too
    if (!start) return { raw: '', segs, root: null };

    const sep = () => {
      if (endsNl) return;
      segs.push({ node: null, from: len, to: len + 1 });
      chunks.push('\n');
      len += 1;
      endsNl = true;
    };

    (function walk(el) {
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          if (!n.data.length) continue;
          segs.push({ node: n, from: len, to: len + n.data.length });
          chunks.push(n.data);
          len += n.data.length;
          endsNl = n.data.charCodeAt(n.data.length - 1) === 10;
        } else if (n.nodeType === 1) {
          const tag = n.nodeName.toUpperCase();
          if (SKIP_TAGS.test(tag)) continue;
          if (n.id === 'bfp-root' || (n.classList && n.classList.contains('bfp-ui'))) continue;
          // OUR OWN track-changes markup is not part of the page. The struck
          // old wording we insert before a re-anchored highlight is display
          // only: if it entered the index it would be matchable text, and the
          // very first thing it would match is the anchor it was made from —
          // a thread would re-anchor onto its own ghost and every repaint
          // would have two candidates for one passage. Skipped here, which is
          // the single place every locate, offset and paint reads the page
          // through, so there is nowhere else for it to leak in.
          if (n.classList && n.classList.contains(WAS_CLASS)) continue;
          if (isHidden(n)) continue;
          if (tag === 'BR') { sep(); continue; }
          const block = BLOCK_TAGS.test(tag);
          if (block) sep();
          walk(n);
          if (block) sep();
        }
      }
    })(start);

    return { raw: chunks.join(''), segs, root: start };
  }

  const textSegs = index => index.segs.filter(s => s.node);

  // Offset in index.raw for a (node, offset) DOM position. `atEnd` decides
  // which way to lean when the position sits on an element boundary.
  function offsetOf(index, node, offset, atEnd) {
    if (!node) return atEnd ? index.raw.length : 0;
    if (node.nodeType === 3) {
      for (const s of index.segs) {
        if (s.node === node) return s.from + Math.min(offset, node.data.length);
      }
    }
    if (node.nodeType === 1) {
      const kids = node.childNodes;
      if (!atEnd) {
        for (let i = offset; i < kids.length; i++) {
          const hit = textSegs(index).find(s => kids[i] === s.node || (kids[i].contains && kids[i].contains(s.node)));
          if (hit) return hit.from;
        }
      } else {
        for (let i = Math.min(offset, kids.length) - 1; i >= 0; i--) {
          const inside = textSegs(index).filter(s => kids[i] === s.node || (kids[i].contains && kids[i].contains(s.node)));
          if (inside.length) return inside[inside.length - 1].to;
        }
      }
      const all = textSegs(index).filter(s => node.contains(s.node));
      if (all.length) return atEnd ? all[all.length - 1].to : all[0].from;
    }
    return atEnd ? index.raw.length : 0;
  }

  function offsetsFromRange(index, range) {
    const start = offsetOf(index, range.startContainer, range.startOffset, false);
    const end = offsetOf(index, range.endContainer, range.endOffset, true);
    return start <= end ? { start, end } : { start: end, end: start };
  }

  // `index.segs` is contiguous and ascending by construction — every segment
  // begins where the one before it ended — so the segment covering an offset
  // can be found by halving instead of by walking. On an article the walk was
  // free; on a 500-page book it is 35,000 segments per highlight painted, and
  // there are hundreds of highlights.
  // Returns the index of the first segment whose `to` is past `off`.
  function segIndexAt(segs, off) {
    let lo = 0, hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].to <= off) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Text nodes overlapping [start,end), clipped: [{node, s, e, seg}].
  // `seg` rides along so paintOffsets can put the index right after splitting.
  function textNodesIn(index, start, end) {
    const out = [];
    const segs = index.segs;
    for (let i = segIndexAt(segs, start); i < segs.length; i++) {
      const seg = segs[i];
      if (seg.from >= end) break;
      if (!seg.node) continue;
      const s = Math.max(0, start - seg.from);
      const e = Math.min(seg.node.data.length, end - seg.from);
      if (e > s) out.push({ node: seg.node, s, e, seg });
    }
    return out;
  }

  // Wrap every text node slice of [start,end) in <mark class="bfp-hl">.
  // Splitting a text node never changes the page's concatenated text, so
  // offsets computed from an earlier index stay valid.
  //
  // ── THE INDEX IS MENDED, NOT THROWN AWAY ───────────────────────────────────
  // It used to be that `index` was stale afterwards and the caller had to
  // rebuild it before painting the next thread. That rule cost a full walk of
  // the document — with a getComputedStyle on every element in it — once per
  // highlight, so a book with three hundred threads walked five hundred pages
  // three hundred times before it could show a single one.
  //
  // But the damage a paint does to the index is small and exactly known: ONE
  // text node became at most three, over the same span of offsets, and nothing
  // else in the document moved. So the split is written back into `index.segs`
  // here, in place, and the index stays true. Callers may now paint every
  // thread against one index — and a caller that rebuilds anyway is still
  // correct, just slower.
  //
  // `state` is `true`/"done" for a resolved thread, "ready" for one a bot has
  // answered and the reader has not yet filed, anything falsy for an open one.
  // (The boolean spelling is the original one and is still what most callers
  // pass, so it keeps working unchanged.)
  // `mark` is the thread's mark kind — 'strike' for a struck passage, anything
  // else (including nothing, which is every caller that predates it) for an
  // ordinary highlight.
  function paintOffsets(index, start, end, id, state, mark) {
    const stateClass = (state === true || state === 'done' ? ' ' + DONE_CLASS
      : state === 'ready' ? ' ' + READY_CLASS : '')
      + (mark === 'strike' ? ' ' + STRIKE_CLASS : '');
    const parts = textNodesIn(index, start, end);
    const marks = [];
    const mended = new Map();
    for (const p of parts) {
      let n = p.node;
      if (!n.parentNode) continue;
      const seg = p.seg;
      const whole = n.data.length;
      let tail = null, head = null;
      if (p.e < whole) tail = n.splitText(p.e);
      if (p.s > 0) { head = n; n = n.splitText(p.s); }
      // …and the index's picture of that one text node, put right. The three
      // pieces cover exactly the offsets the one node covered.
      if (seg) {
        const pieces = [];
        if (head) pieces.push({ node: head, from: seg.from, to: seg.from + p.s });
        pieces.push({ node: n, from: seg.from + p.s, to: seg.from + p.e });
        if (tail) pieces.push({ node: tail, from: seg.from + p.e, to: seg.to });
        mended.set(seg, pieces);
      }
      if (!n.data.trim()) continue; // don't leave empty marks on inter-node whitespace
      const mark = (n.ownerDocument || document).createElement('mark');
      mark.className = 'bfp-hl' + stateClass;
      mark.setAttribute('data-bfp', String(id));
      styleMark(mark, false);
      n.parentNode.insertBefore(mark, n);
      mark.appendChild(n);
      marks.push(mark);
    }
    if (mended.size && index && index.segs) {
      const next = [];
      for (const s of index.segs) {
        const pieces = mended.get(s);
        if (pieces) { for (const piece of pieces) next.push(piece); }
        else next.push(s);
      }
      index.segs = next;
    }
    return marks;
  }

  const marksFor = id => Array.prototype.slice.call(
    document.querySelectorAll('mark.bfp-hl[data-bfp="' + String(id).replace(/"/g, '\\"') + '"]'));

  // Every thread id currently painted on the page. The caller compares this
  // with the ids in the page record to find highlights whose thread has been
  // deleted (here or in another tab) and still needs unpainting — additions
  // alone are not enough to keep the page in sync with the record.
  function paintedIds() {
    const seen = [];
    const marks = document.querySelectorAll('mark.bfp-hl[data-bfp]');
    for (let i = 0; i < marks.length; i++) {
      const id = marks[i].getAttribute('data-bfp');
      if (id && seen.indexOf(id) === -1) seen.push(id);
    }
    return seen;
  }

  // ── WHAT IS UNDER THE CURSOR ──────────────────────────────────────────────
  // THE REPORT. A passage is discussed, the discussion is resolved, and then
  // the reader strikes the passage through. The strike's red line is painted
  // over the discussion's highlight, so clicking the words on the page could
  // only ever reach the strike — the conversation underneath was unreachable
  // from the document and had to be hunted for in the drawer.
  //
  // So a click asks what ELSE is under it. Overlapping paints NEST: the second
  // paint of the same words finds the text node the first one already wrapped
  // and wraps it again, so at any point on the page the marks covering that
  // point are an ancestor chain — innermost is the most recently painted, the
  // one whose ink the reader is actually looking at. Walking the chain from
  // the click target IS a point test, and an exact one; `elementsFromPoint` is
  // folded in afterwards only to catch a paint that overlaps this one on
  // SCREEN without containing it in the tree, which a PDF's absolutely
  // positioned text layer can produce.
  //
  // Order is nearest-fitting: the smallest painted span first, because that is
  // the most specific thing the reader can have meant by clicking there, and
  // the innermost paint breaks a tie between two marks over the same words.
  // Returns ids only — naming them is the drawer's job, since only the drawer
  // has the threads.
  const POINT_SEL = 'mark.bfp-hl[data-bfp], del.' + WAS_CLASS + '[data-bfp]';

  // How much of the document a thread's marking covers, in characters. The
  // <del> of a track change counts too: it is painted, it is clickable, and it
  // is part of what that thread put on the page.
  function paintedLen(id) {
    let n = 0;
    for (const m of marksFor(id)) n += (m.textContent || '').length;
    const del = wasFor(id);
    if (del) n += (del.textContent || '').length;
    return n;
  }

  function marksAtPoint(target, x, y) {
    const found = new Map();   // id → depth (0 = innermost at the click)
    const add = (el, depth) => {
      const id = el && el.getAttribute && el.getAttribute('data-bfp');
      if (!id || id === '__new__') return;
      const prev = found.get(id);
      if (prev == null || depth < prev) found.set(id, depth);
    };
    let depth = 0;
    for (let n = target; n; n = n.parentNode) {
      if (n.nodeType === 1 && n.matches && n.matches(POINT_SEL)) add(n, depth++);
    }
    // …and anything whose painted box contains the point without being an
    // ancestor of what was hit. Ranked after the chain, in stacking order.
    if (typeof document.elementsFromPoint === 'function'
        && typeof x === 'number' && typeof y === 'number') {
      let stack = [];
      try { stack = document.elementsFromPoint(x, y) || []; } catch { stack = []; }
      for (let i = 0; i < stack.length; i++) {
        const el = stack[i];
        if (el && el.matches && el.matches(POINT_SEL)) add(el, 1e6 + i);
      }
    }
    const ids = Array.from(found.keys());
    const len = new Map(ids.map(id => [id, paintedLen(id)]));
    ids.sort((a, b) => (len.get(a) - len.get(b)) || (found.get(a) - found.get(b)));
    return ids;
  }

  // Unwrap cleanly: text back into the parent, then normalize() re-joins the
  // split siblings so a delete leaves the DOM exactly as it was found.
  function unpaint(id) {
    for (const mark of marksFor(id)) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  function setFocus(id, on) {
    for (const mark of marksFor(id)) {
      mark.classList.toggle(FOCUS_CLASS, !!on);
      styleMark(mark, !!on);
    }
  }

  // Yellow ⇄ green in place, without unpainting: resolving a thread must not
  // disturb the anchor it is painted on, and the reader is watching this
  // happen while they sweep down the list. Each mark keeps whatever focus it
  // already had, which is read back off the mark rather than passed in.
  function markResolved(id, on) {
    const marks = marksFor(id);
    for (const mark of marks) {
      mark.classList.toggle(DONE_CLASS, !!on);
      // filing a thread spends its "ready" — and the companion clears
      // `addressed` in the same write, so leaving the class on would mean a
      // reopen flashed amber for a passage nobody had claimed since
      if (on) mark.classList.remove(READY_CLASS);
      styleMark(mark, mark.classList.contains(FOCUS_CLASS));
    }
    return marks.length;
  }
  // Yellow ⇄ amber, the same way and for the same reason: a bot's reply
  // landing in a thread turns its passage amber where the reader is looking,
  // without disturbing the anchor or the focus it already had.
  function markAddressed(id, on) {
    const marks = marksFor(id);
    for (const mark of marks) {
      mark.classList.toggle(READY_CLASS, !!on);
      styleMark(mark, mark.classList.contains(FOCUS_CLASS));
    }
    return marks.length;
  }
  // Wash ⇄ line, in place, and for exactly the reasons the two above exist: the
  // reader has just converted a thread's mark and is watching the passage they
  // clicked. Repainting from the record would work and would also unpaint and
  // repaint the anchor — a flicker on the one span their eye is on — so the
  // class is toggled and the mark restyled where it stands, keeping its focus
  // and whatever state (ready, filed) it already had.
  function markStruck(id, on) {
    const marks = marksFor(id);
    for (const mark of marks) {
      mark.classList.toggle(STRIKE_CLASS, !!on);
      styleMark(mark, mark.classList.contains(FOCUS_CLASS));
    }
    return marks.length;
  }
  // ---- track changes, on the page ----------------------------------------
  // The wording a bot's change REPLACED, shown struck through immediately
  // before the wording that replaced it. A <del> because that is what it is,
  // `aria-hidden` because a screen reader working down the prose should hear
  // the draft as it stands and not a sentence that no longer exists, and
  // `user-select:none` so a reader dragging across the passage to comment on
  // it cannot capture a quote half of which is not on the page.
  //
  // Display only, and provably so: WAS_CLASS is skipped by buildTextIndex (so
  // it is invisible to every locate and every offset) and removed outright
  // from the snapshot and from the article text content.js sends the bots.
  const wasFor = id => document.querySelector(
    'del.' + WAS_CLASS + '[data-bfp="' + String(id).replace(/"/g, '\\"') + '"]');

  function paintWas(id, text) {
    const mark = marksFor(id)[0];
    if (!mark || !mark.parentNode) return null;
    const body = String(text == null ? '' : text).trim();
    if (!body || body.length > WAS_MAX) return null;
    unpaintWas(id);
    const del = (mark.ownerDocument || document).createElement('del');
    del.className = WAS_CLASS;
    del.setAttribute('data-bfp', String(id));
    del.setAttribute('aria-hidden', 'true');
    del.setAttribute('title', 'this passage was rewritten — click to open the comment');
    // a hair space after the struck text keeps it from butting up against the
    // wording that replaced it; it lives INSIDE the del, so it leaves with it
    del.textContent = body + ' ';
    const st = del.style;
    st.setProperty('text-decoration', 'line-through', 'important');
    st.setProperty('text-decoration-thickness', '1px', 'important');
    st.setProperty('background-color', WAS_BG, 'important');
    st.setProperty('color', 'inherit', 'important');
    st.setProperty('opacity', '.55', 'important');
    st.setProperty('border-radius', '2px', 'important');
    st.setProperty('cursor', 'pointer', 'important');
    st.setProperty('user-select', 'none', 'important');
    st.setProperty('-webkit-user-select', 'none', 'important');
    st.setProperty('box-decoration-break', 'clone', 'important');
    st.setProperty('-webkit-box-decoration-break', 'clone', 'important');
    mark.parentNode.insertBefore(del, mark);
    markInserted(id, true);
    return del;
  }

  function unpaintWas(id) {
    let n = 0;
    const sel = 'del.' + WAS_CLASS + (id == null ? '' :
      '[data-bfp="' + String(id).replace(/"/g, '\\"') + '"]');
    for (const del of document.querySelectorAll(sel)) {
      const parent = del.parentNode;
      if (!parent) continue;
      parent.removeChild(del);
      parent.normalize();
      n++;
    }
    if (id != null) markInserted(id, false);
    return n;
  }

  // Every thread id currently carrying track-changes markup — the same reason
  // paintedIds exists: a sweep needs to find markup whose thread has moved on.
  function wasIds() {
    const seen = [];
    for (const del of document.querySelectorAll('del.' + WAS_CLASS + '[data-bfp]')) {
      const id = del.getAttribute('data-bfp');
      if (id && seen.indexOf(id) === -1) seen.push(id);
    }
    return seen;
  }

  // The arrival half, on its own: a re-anchored passage whose old wording is
  // too long (or too ambiguously placed) to show inline still gets the
  // underline, with the reason in a title the reader can hover.
  function markInserted(id, on, why) {
    const marks = marksFor(id);
    for (const mark of marks) {
      mark.classList.toggle(INS_CLASS, !!on);
      if (why) mark.setAttribute('title', why);
      else if (!on) mark.removeAttribute('title');
      styleMark(mark, mark.classList.contains(FOCUS_CLASS));
    }
    return marks.length;
  }

  function scrollTo(id) {
    const m = marksFor(id)[0];
    if (m && m.scrollIntoView) m.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return !!m;
  }

  // Re-key a provisional highlight once the server hands back the real id.
  function rekey(from, to) {
    for (const mark of marksFor(from)) mark.setAttribute('data-bfp', String(to));
  }

  // Everything here has a caller — content.js, drawer.js, the harness or a test.
  // `offsetOf`, `textNodesIn` and `paintedLen` were on this list with none, and
  // are internal now; four functions that had none even internally
  // (rangeFromOffsets, isMarkResolved, isMarkAddressed, isMarkStruck) are gone.
  // The colour and class constants STAY, callers or not: they are named as this
  // file's contract in the SPEC and read by eye when a mark's state is argued
  // about. `NEW_WORDING_RE` stays for the same reason — it is the half of the
  // twin rule store.mjs's `newWording` has to agree with.
  const api = {
    // pure
    normIndex, normalize, findSpans, buildAnchor, locate, tailOverlap, headOverlap,
    newWording, NEW_WORDING_RE, WINDOW, WAS_MAX,
    // dom
    buildTextIndex, offsetsFromRange,
    paintOffsets, unpaint, setFocus, scrollTo, rekey, marksFor, paintedIds,
    marksAtPoint,
    markResolved, markAddressed, markStruck,
    paintWas, unpaintWas, wasFor, wasIds, markInserted,
    HL_BG, HL_BG_FOCUS, HL_BG_DONE, HL_BG_DONE_FOCUS,
    HL_BG_READY, HL_BG_READY_FOCUS,
    DONE_CLASS, READY_CLASS, FOCUS_CLASS, INS_CLASS, WAS_CLASS, STRIKE_CLASS,
    STRIKE_LINE, STRIKE_LINE_READY, STRIKE_LINE_DONE, STRIKE_AT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPAnchor = api;
})(typeof window !== 'undefined' ? window : globalThis);
