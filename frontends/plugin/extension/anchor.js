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

  // WHICH OCCURRENCE a selection is, and how many there are.
  //
  // Counted at the moment a thread is made, on an ordinary web page, and stored
  // beside quote/prefix/suffix. It is not a second way of FINDING the words —
  // locate() still searches text and only text — it is the tiebreak for the one
  // case the search cannot settle on its own: the same phrase, twice, with the
  // same words around it. Before this, that thread simply orphaned.
  //
  // `start` is the raw offset the anchor was cut at. The quote is the collapsed
  // form of raw[start,end), so the span the reader meant is the one whose start
  // is nearest to it — leading whitespace inside the selection is the only
  // thing that can move it, and that is a handful of characters against a whole
  // quote-length gap to any other occurrence.
  //
  // Past ORD_MAX occurrences the count would be a lie (findSpans stops there),
  // so nothing is claimed at all: {ordinal:0, occurrences:0} reads as "unknown"
  // everywhere downstream, exactly as a thread made before this existed does.
  const ORD_MAX = 200;
  function occurrenceAt(raw, quote, start) {
    const spans = findSpans(raw, quote, ORD_MAX);
    if (!spans.length || spans.length >= ORD_MAX) return { ordinal: 0, occurrences: 0 };
    let best = 0, bestD = Infinity;
    for (let i = 0; i < spans.length; i++) {
      const d = Math.abs(spans[i].start - start);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { ordinal: best + 1, occurrences: spans.length };
  }

  // Re-anchor. Returns {ok:true, start, end, unique} or
  // {ok:false, reason:'orphan'|'ambiguous'} (both mean "orphan it" to callers
  // that don't care why).
  function locate(raw, anchor, opts) {
    anchor = anchor || {};
    const spans = findSpans(raw, anchor.quote, (opts && opts.limit) || 50);
    if (!spans.length) return { ok: false, reason: 'orphan' };
    if (spans.length === 1) return { ok: true, start: spans[0].start, end: spans[0].end, unique: true };

    // THE LAST RESORT, and only ever that: the occurrence the thread was made
    // on. It is consulted after prefix/suffix have failed to tell the copies
    // apart, never before — context is evidence about the words on the page
    // now, an ordinal is a memory of the page as it was.
    //
    // Two guards, because a remembered position is worth nothing on a page that
    // has changed underneath it: the ordinal has to be in range, and where the
    // thread also remembers HOW MANY there were, that count has to still hold.
    // A paragraph added or deleted moves every occurrence after it, so a count
    // that no longer matches means the memory is about a different page and the
    // thread orphans exactly as it did before any of this existed.
    const byOrdinal = () => {
      const n = Number(anchor.ordinal) || 0;
      const occ = Number(anchor.occurrences) || 0;
      if (!(n >= 1 && n <= spans.length)) return null;
      if (occ && occ !== spans.length) return null;
      return { ok: true, start: spans[n - 1].start, end: spans[n - 1].end,
        unique: false, ordinal: n };
    };
    const giveUp = () => byOrdinal() || { ok: false, reason: 'ambiguous' };

    const wantPre = normalize(anchor.prefix || '');
    const wantSuf = normalize(anchor.suffix || '');
    if (!wantPre && !wantSuf) return giveUp();

    const scored = spans.map(s => {
      const pre = normalize(raw.slice(Math.max(0, s.start - WINDOW), s.start));
      const suf = normalize(raw.slice(s.end, s.end + WINDOW));
      return { s, score: tailOverlap(pre, wantPre) + headOverlap(suf, wantSuf) };
    }).sort((a, b) => b.score - a.score);

    if (scored[0].score === 0) return giveUp();
    if (scored[1] && scored[1].score === scored[0].score) return giveUp();
    return { ok: true, start: scored[0].s.start, end: scored[0].s.end, unique: false, score: scored[0].score };
  }

  // ---- source markup, read the way the page shows it ----------------------
  // A suggestion card quotes the SOURCE (`current` is what the file holds),
  // and on a blog or a book the source is markdown: `[the Earth](earth.md)`
  // on disk is "the Earth" on the page, `**must**` is "must", a MyST
  // {ref}`gravity` is "gravity". Searched for as written, a marked-up passage
  // is simply not on the page, and the preview had nothing to stand on.
  //
  // So: the same passage with its inline markup taken off, as near to the
  // rendered words as a regex can get without a markdown parser. Links keep
  // their text, emphasis and code keep their words, a role keeps its content
  // (or, for `text <target>`, its text), and the line furniture a renderer
  // turns into layout — list numbers, bullets, heading hashes, quote bars —
  // goes, because the browser draws those and they are never text nodes.
  // Then whitespace is folded, exactly as `normalize` would.
  //
  // Two things are NOT text and are handled as wholes, never reached into:
  //
  //   · MATH ($…$, $$…$$, \(…\), \[…\]) is left exactly as written, every
  //     character. `x_1` would otherwise lose an underscore to the emphasis
  //     rule and `a*b*c` an asterisk pair. The page shows typeset maths, so a
  //     passage with a formula in it still will not locate — the caller's
  //     fallback is for that — but the PROPOSAL shown after it keeps its TeX
  //     intact, which is what lets it be typeset (content.js dressProposals).
  //   · PICTURES (imageRefs: `![alt](src)` and a MyST {figure}/{image}
  //     fence). A picture has no text on the page, so for locating it is
  //     nothing (a figure keeps its caption, which IS text). With
  //     `{keepImages: true}` — the proposal's form — it is kept whole, so the
  //     page can draw the picture rather than its alt text.
  //
  // It is deliberately NOT clever about what it cannot see. An empty-text
  // MyST link, `[](content.Some-Label)`, renders as the target heading's
  // title, which lives in another file; it comes out as nothing here, the
  // search fails, and the caller falls back to something it can stand on.
  // Pure, so the node tests hold it to its word.
  //
  // The math spotter is a small regex, not drawer.js's scanMath: this file has
  // to load in node on its own. It errs towards "that is maths" only where a
  // $ is closed on the same line with no space inside either end, which is
  // the money case scanMath works hardest at, near enough.
  const MATH_LITE = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?!\d)/g;
  const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  // the fence may open mid-line (a word diff re-joins tokens with spaces) but
  // must CLOSE on a line of its own, as MyST requires
  const MYST_FIG = /(`{3,}|:{3,})\{(figure|image)\}[ \t]+(\S+)[^\n]*\n(?:([\s\S]*?)\n)??[ \t]*\1[ \t]*(?=\n|$)/g;

  // Every picture referenced in `text`, in order, never overlapping:
  // {start, end, raw, src, alt, caption, kind: 'md'|'myst'}. A MyST fence's
  // alt is its `:alt:` option, else its caption (the body without options).
  function imageRefs(text) {
    const s = String(text == null ? '' : text);
    const out = [];
    let m;
    MYST_FIG.lastIndex = 0;
    while ((m = MYST_FIG.exec(s))) {
      const body = (m[4] || '').split('\n');
      const alt = (body.map(l => /^\s*:alt:\s*(.*)$/.exec(l)).find(Boolean) || [])[1] || '';
      const caption = body.filter(l => !/^\s*:[\w-]+:/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
      out.push({ start: m.index, end: m.index + m[0].length, raw: m[0], src: m[3],
        alt: (alt || caption).trim(), caption, kind: 'myst' });
    }
    MD_IMAGE.lastIndex = 0;
    while ((m = MD_IMAGE.exec(s))) {
      const at = m.index, to = at + m[0].length;
      if (out.some(r => at < r.end && to > r.start)) continue;   // inside a fence
      out.push({ start: at, end: to, raw: m[0], src: m[2], alt: m[1].trim(), caption: '', kind: 'md' });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function plainOf(md, opts) {
    const keep = !!(opts && opts.keepImages);
    let s = String(md == null ? '' : md);
    // the wholes, swapped for placeholders no markup rule below can match
    // (\u0001 is never typed, and none of the patterns touch it)
    const held = [];
    const hold = raw => '\u0001' + (held.push(raw) - 1) + '\u0001';
    const pics = imageRefs(s);
    if (pics.length) {
      const parts = [];
      let at = 0;
      for (const r of pics) {
        parts.push(s.slice(at, r.start), keep ? hold(r.raw) : (r.kind === 'myst' ? ' ' + r.caption + ' ' : ''));
        at = r.end;
      }
      parts.push(s.slice(at));
      s = parts.join('');
    }
    s = s.replace(MATH_LITE, hold);
    // line furniture, per line, before the lines are folded together
    s = s.split('\n').map(line => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(?:>\s*)+/, '')
      .replace(/^\s*(?:\d+[.)]|[-*+])\s+/, '')).join('\n');
    s = s
      // {role}`text <target>` keeps the text; {role}`x` keeps x
      .replace(/\{[\w:.-]+\}`([^`]*?)\s*<[^`>]*>`/g, '$1')
      .replace(/\{[\w:.-]+\}`([^`]*)`/g, '$1')
      // [text](url) keeps its words; [text][ref] too
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      // inline code keeps its words, backticks gone
      .replace(/`+([^`]*?)`+/g, '$1')
      // strong before emphasis, so ** is never read as two *s
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '$1')
      .replace(/\*(?=\S)([^*]*?\S)\*/g, '$1')
      // an underscore inside a word is a snake_case name, not emphasis
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '$1$2');
    // folded, THEN the wholes put back: a $$ block or a figure fence keeps its
    // own line breaks, which is what its renderer needs
    return s.replace(/\s+/g, ' ').trim().replace(/\u0001(\d+)\u0001/g, (_, n) => held[+n]);
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
  // ---- proposals, on the page ---------------------------------------------
  // The same idiom one step EARLIER: a blog-source suggestion card that is
  // still open, previewed where it would land. The passage it would replace is
  // struck (PROP_CLASS, on marks that wrap the page's own words) and the
  // wording it proposes follows in a display-only <ins> (PROP_INS_CLASS).
  // The strike is the drawer's accent, softened — the colour the card's own
  // left rule is drawn in — so it cannot be read as the reader's red strike
  // or the track-changes hairline, and the marks set NO background colour of
  // their own: a thread's tint under the same words shows through untouched.
  const PROP_CLASS = 'bfp-prop';
  const PROP_INS_CLASS = 'bfp-prop-ins';
  const PROP_LINE = 'rgba(217, 119, 87, .7)';
  // …and the flag on a preview that stands on its THREAD's passage because its
  // own could not be found (paintProposal, fallback 2). Same marks, same
  // classes — so every unpaint, sweep and click treats it identically — and
  // one attribute that says "this is where the comment is, not the edit".
  const APPROX_ATTR = 'data-bfp-prop-approx';

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
          // …and, for the identical reason, the wording a still-open
          // suggestion PROPOSES (PROP_INS_CLASS below): it is not on the page
          // yet, and may never be.
          if (n.classList && n.classList.contains(PROP_INS_CLASS)) continue;
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

  // ---- WHICH SECTION a passage is in ---------------------------------------
  //
  // A PDF says "p. 12". An ordinary web page has nothing to say at all, so two
  // cards quoting the same sentence from two places in a long article were
  // indistinguishable in the panel. The nearest thing a web page has to a page
  // number is the heading the passage sits under, and every article already
  // carries them.
  //
  // "Nearest preceding heading" means nearest in DOCUMENT ORDER walking
  // backwards: each previous sibling (or the last heading INSIDE it — a
  // heading is usually wrapped in a <section> or a <header>), then up to the
  // parent, which may itself be a heading, and so on to the root. That is the
  // same rule a reader applies with their eye, and it costs one walk.
  //
  // A heading is h1–h6, or anything wearing role="heading" with an aria-level —
  // the ARIA form real sites use when the tag is a <div>. Trimmed, collapsed,
  // and cut at SECTION_MAX, because this is a label on a card and not a copy of
  // the heading.
  const SECTION_MAX = 80;
  const HEADING_SEL = 'h1,h2,h3,h4,h5,h6,[role="heading"][aria-level]';
  function isHeadingEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (/^H[1-6]$/.test(el.tagName)) return true;
    return el.getAttribute && el.getAttribute('role') === 'heading'
      && el.getAttribute('aria-level') != null;
  }
  function headingText(el) {
    return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, SECTION_MAX);
  }
  function sectionOf(node) {
    let el = node && node.nodeType === 1 ? node : (node && node.parentElement) || null;
    while (el) {
      for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
        if (isHeadingEl(p)) return headingText(p);
        // …or the last heading inside it, which is what a wrapped <section>
        // looks like from the outside
        let inner = null;
        try { const hs = p.querySelectorAll(HEADING_SEL); inner = hs[hs.length - 1] || null; }
        catch (_) { inner = null; }
        if (inner) return headingText(inner);
      }
      el = el.parentElement;
      if (isHeadingEl(el)) return headingText(el);
    }
    return '';
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
    return wrapOffsets(index, start, end, doc => {
      const el = doc.createElement('mark');
      el.className = 'bfp-hl' + stateClass;
      el.setAttribute('data-bfp', String(id));
      styleMark(el, false);
      return el;
    });
  }

  // The splitting and the mending, on their own: every text-node slice of
  // [start,end) wrapped in whatever element `make(doc)` returns. paintOffsets
  // is a thread's highlight through here; a proposal's struck passage
  // (paintProposal) is the other caller, so both keep the index true the same
  // way.
  function wrapOffsets(index, start, end, make) {
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
      const mark = make(n.ownerDocument || document);
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

  // ---- proposals, on the page ---------------------------------------------
  // An OPEN suggestion card ({id, current, proposed, state}) previewed in the
  // body: `current` struck where it stands, `proposed` inserted right after it.
  //
  // Located exactly the way a thread is, and held to the strictest form of
  // the rule: `current` must occur EXACTLY ONCE in the indexed text. The card
  // carries no prefix/suffix and no ordinal, so a second occurrence is not a
  // tie to break, it is a reason to paint nothing — the companion's own apply
  // refuses the same case (needs-manual), and the preview must never point
  // at a place the accept would not write.
  //
  // Display only, provably, by the same door WAS_CLASS uses: the <ins> is
  // skipped by buildTextIndex, so it is invisible to every locate and offset,
  // and content.js strips it from the snapshot and the article text. The
  // struck marks wrap the page's own words, so they are unwrapped (never
  // removed) wherever thread marks are. The index is mended exactly as
  // paintOffsets mends it, so later locates against it stay true.
  //
  // Two fallbacks, in this order, for a `current` the page does not show as
  // written — a markdown source, where the file says `[text](url)` and the
  // page says "text":
  //
  //   1. the same passage with its markup off (plainOf), held to the same
  //      exactly-once rule. Found, it is the real place; the proposed wording
  //      is shown with its markup off too, since the page will render it so.
  //   2. `near`, a {start, end} in this index: the passage of the THREAD the
  //      card was made in, as the caller located it this pass. The strike
  //      goes over the comment's passage and the proposal after it, and both
  //      say APPROXIMATE (APPROX_ATTR, and in their titles) — what is struck
  //      is where the conversation was, not provably the words the accept
  //      would replace. Display only, and only that: nothing reads these
  //      offsets back, and the accept (suggest.mjs) finds its own place in
  //      the source exactly as it always did. A card with no thread (the
  //      page chat) has no `near`, and stays in the drawer.
  const propSel = (tag, cls, id) => tag + '.' + cls + (id == null ? '[data-bfp-prop]'
    : '[data-bfp-prop="' + String(id).replace(/["\\]/g, '\\$&') + '"]');

  function paintProposal(index, card, near) {
    if (!index || !card || !card.id || card.state !== 'open') return null;
    const id = String(card.id);
    if (document.querySelector(propSel('mark', PROP_CLASS, id))) return null;
    const current = String(card.current == null ? '' : card.current);
    if (!current.trim()) return null;
    let proposed = String(card.proposed == null ? '' : card.proposed).trim();
    let r = locate(index.raw, { quote: current });
    let approx = false;
    if (!r.ok || !r.unique) {
      // 1. the passage as the page would render it
      const plain = plainOf(current);
      r = plain && plain !== normalize(current) ? locate(index.raw, { quote: plain }) : { ok: false };
      if (r.ok && r.unique) proposed = plainOf(proposed, { keepImages: true });
      // 2. the comment's own passage, marked as an approximation
      else if (near && near.end > near.start && near.start >= 0 && near.end <= index.raw.length) {
        r = { ok: true, unique: true, start: near.start, end: near.end };
        proposed = plainOf(proposed, { keepImages: true });
        approx = true;
      } else return null;
    }
    const title = approx
      ? 'proposed change (approximate position) — click to open the suggestion'
      : 'proposed change — click to open the suggestion';
    const marks = wrapOffsets(index, r.start, r.end, doc => {
      const el = doc.createElement('mark');
      el.className = PROP_CLASS;
      el.setAttribute('data-bfp-prop', id);
      if (approx) el.setAttribute(APPROX_ATTR, '1');
      el.setAttribute('title', title);
      const st = el.style;
      // a <mark>'s own yellow is the browser's, not ours: put it out, and let
      // whatever is under the words (a thread's tint, or the page) show
      st.setProperty('background-color', 'transparent', 'important');
      st.setProperty('background-image', strikeImage(PROP_LINE, 1), 'important');
      st.setProperty('background-repeat', 'no-repeat', 'important');
      st.setProperty('color', 'inherit', 'important');
      st.setProperty('padding', '0', 'important');
      st.setProperty('cursor', 'pointer', 'important');
      st.setProperty('box-decoration-break', 'clone', 'important');
      st.setProperty('-webkit-box-decoration-break', 'clone', 'important');
      return el;
    });
    if (!marks.length) return null;
    let ins = null;
    // a deletion proposes nothing, and shows as nothing but the strike
    if (proposed) {
      const last = marks[marks.length - 1];
      ins = (last.ownerDocument || document).createElement('ins');
      ins.className = PROP_INS_CLASS;
      ins.setAttribute('data-bfp-prop', id);
      ins.setAttribute('aria-hidden', 'true');
      if (approx) ins.setAttribute(APPROX_ATTR, '1');
      ins.setAttribute('title', title);
      ins.textContent = proposed;
      const st = ins.style;
      st.setProperty('text-decoration-line', 'underline', 'important');
      st.setProperty('text-decoration-color', INS_LINE, 'important');
      st.setProperty('text-decoration-thickness', '2px', 'important');
      st.setProperty('text-underline-offset', '2px', 'important');
      st.setProperty('background', 'none', 'important');
      st.setProperty('color', 'inherit', 'important');
      // the gap between the struck words and the proposed ones, as a margin
      // rather than a space character, so the <ins> holds exactly `proposed`
      st.setProperty('margin-left', '.25em', 'important');
      st.setProperty('cursor', 'pointer', 'important');
      st.setProperty('user-select', 'none', 'important');
      st.setProperty('-webkit-user-select', 'none', 'important');
      st.setProperty('box-decoration-break', 'clone', 'important');
      st.setProperty('-webkit-box-decoration-break', 'clone', 'important');
      last.parentNode.insertBefore(ins, last.nextSibling);
    }
    return { marks, ins, approx };
  }

  // Every OPEN card of `cards` that can be placed, painted against one index.
  // Cards in any other state are skipped: applied, rejected and needs-manual
  // are answered, and unreadable never had a passage. Returns the ids painted.
  // `near` is card id -> {start, end}, the thread passages paintProposal may
  // fall back to. ONE approximate preview per passage: a thread holding three
  // cards that cannot be placed would otherwise stack three proposals after
  // one strike, which says nothing about any of them — the first is shown
  // and the rest stay in the drawer.
  function paintProposals(index, cards, near) {
    const out = [];
    const taken = Object.create(null);
    for (const c of cards || []) {
      let at = near && c && near[String(c.id)];
      if (at && taken[at.start + ':' + at.end]) at = null;
      const r = paintProposal(index, c, at);
      if (!r) continue;
      if (r.approx) taken[at.start + ':' + at.end] = true;
      out.push(String(c.id));
    }
    return out;
  }

  // The preview for card `id` taken down — or every preview, with no id. The
  // <ins> is removed (it was never the page's), the marks unwrapped, and the
  // split text nodes re-joined, so the DOM is left exactly as it was found.
  // An index built before this call is stale afterwards; build a fresh one.
  function unpaintProposal(id) {
    let n = 0;
    for (const ins of document.querySelectorAll(propSel('ins', PROP_INS_CLASS, id))) {
      const parent = ins.parentNode;
      if (!parent) continue;
      parent.removeChild(ins);
      parent.normalize();
      n++;
    }
    for (const mark of document.querySelectorAll(propSel('mark', PROP_CLASS, id))) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
      n++;
    }
    return n;
  }

  // Every card id currently previewed — the sweep's half, for the same reason
  // paintedIds and wasIds exist.
  function proposalIds() {
    const seen = [];
    const els = document.querySelectorAll(propSel('mark', PROP_CLASS) + ', ' + propSel('ins', PROP_INS_CLASS));
    for (const el of els) {
      const id = el.getAttribute('data-bfp-prop');
      if (id && seen.indexOf(id) === -1) seen.push(id);
    }
    return seen;
  }

  // …and the ones of those standing on a thread's passage rather than their
  // own (paintProposal's second fallback), for the drawer's note on the card.
  function approxProposalIds() {
    const seen = [];
    for (const el of document.querySelectorAll(propSel('mark', PROP_CLASS) + '[' + APPROX_ATTR + ']')) {
      const id = el.getAttribute('data-bfp-prop');
      if (id && seen.indexOf(id) === -1) seen.push(id);
    }
    return seen;
  }

  // Unpaint everything, then (when `on`) paint the open cards against a
  // FRESH index of `rootEl` — the one call for a caller that has no index of
  // its own in hand (the track-changes switch, a refused accept). `nearFor`,
  // if given, is asked for the fallback passages against THAT index, since
  // offsets from any other index are offsets into a different string.
  function syncProposals(cards, on, rootEl, nearFor) {
    unpaintProposal(null);
    if (!on) return [];
    const open = (cards || []).filter(c => c && c.state === 'open');
    if (!open.length) return [];
    const index = buildTextIndex(rootEl || document.body);
    return paintProposals(index, open, nearFor ? nearFor(index) : null);
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
    newWording, NEW_WORDING_RE, WINDOW, WAS_MAX, occurrenceAt, ORD_MAX, plainOf, imageRefs,
    // dom
    buildTextIndex, offsetsFromRange, sectionOf,
    paintOffsets, unpaint, setFocus, scrollTo, rekey, marksFor, paintedIds,
    marksAtPoint,
    markResolved, markAddressed, markStruck,
    paintWas, unpaintWas, wasFor, wasIds, markInserted,
    paintProposal, paintProposals, unpaintProposal, proposalIds, approxProposalIds, syncProposals,
    HL_BG, HL_BG_FOCUS, HL_BG_DONE, HL_BG_DONE_FOCUS,
    HL_BG_READY, HL_BG_READY_FOCUS,
    DONE_CLASS, READY_CLASS, FOCUS_CLASS, INS_CLASS, WAS_CLASS, STRIKE_CLASS,
    PROP_CLASS, PROP_INS_CLASS, PROP_LINE, APPROX_ATTR,
    STRIKE_LINE, STRIKE_LINE_READY, STRIKE_LINE_DONE, STRIKE_AT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPAnchor = api;
})(typeof window !== 'undefined' ? window : globalThis);
