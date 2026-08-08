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
//   DOM ADAPTERS (thin)         buildTextIndex · offsetsFromRange
//                               · rangeFromOffsets · textNodesIn · paintOffsets
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

  // Normalized copy of `raw` plus map[i] = raw offset of normalized char i.
  function normIndex(raw) {
    raw = String(raw == null ? '' : raw);
    let norm = '';
    const map = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (INVISIBLE.test(c)) continue;
      if (/\s/.test(c)) { // \s covers nbsp, which article HTML is full of
        if (norm && norm[norm.length - 1] !== ' ') { norm += ' '; map.push(i); }
      } else {
        norm += FOLD[c] || c;
        map.push(i);
      }
    }
    return { norm, map };
  }

  // Comparable form of a fragment: folded, single-spaced, trimmed.
  const normalize = s => normIndex(s).norm.trim();

  // Every (up to `limit`) whitespace-tolerant match of `needle` in `raw`, as
  // {start, end} offsets into raw. `end` is exclusive and lands on the last
  // matched non-space character + 1, so trailing raw whitespace inside a
  // collapsed run is never swallowed into the highlight.
  function findSpans(raw, needle, limit) {
    limit = limit || 50;
    const nn = normalize(needle);
    if (!nn) return [];
    const { norm, map } = normIndex(raw);
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

  const HL_BG = 'rgba(250, 210, 80, .45)';
  const HL_BG_FOCUS = 'rgba(250, 190, 60, .6)';

  function styleMark(mark, focused) {
    const st = mark.style;
    st.setProperty('background-color', focused ? HL_BG_FOCUS : HL_BG, 'important');
    st.setProperty('color', 'inherit', 'important');
    st.setProperty('border-radius', '2px', 'important');
    st.setProperty('padding', '0', 'important');
    st.setProperty('cursor', 'pointer', 'important');
    st.setProperty('box-decoration-break', 'clone', 'important');
    st.setProperty('-webkit-box-decoration-break', 'clone', 'important');
    st.setProperty('transition', 'background-color .15s ease', 'important');
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
  function buildTextIndex(rootEl) {
    const doc = (typeof document !== 'undefined') ? document : null;
    const start = rootEl || (doc && doc.body) || null;
    const segs = [];
    let raw = '';
    if (!start) return { raw, segs, root: null };

    const sep = () => {
      if (!raw || raw[raw.length - 1] === '\n') return;
      segs.push({ node: null, from: raw.length, to: raw.length + 1 });
      raw += '\n';
    };

    (function walk(el) {
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          if (!n.data.length) continue;
          segs.push({ node: n, from: raw.length, to: raw.length + n.data.length });
          raw += n.data;
        } else if (n.nodeType === 1) {
          const tag = n.nodeName.toUpperCase();
          if (SKIP_TAGS.test(tag)) continue;
          if (n.id === 'bfp-root' || (n.classList && n.classList.contains('bfp-ui'))) continue;
          if (isHidden(n)) continue;
          if (tag === 'BR') { sep(); continue; }
          const block = BLOCK_TAGS.test(tag);
          if (block) sep();
          walk(n);
          if (block) sep();
        }
      }
    })(start);

    return { raw, segs, root: start };
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

  // Text nodes overlapping [start,end), clipped: [{node, s, e}].
  function textNodesIn(index, start, end) {
    const out = [];
    for (const seg of index.segs) {
      if (!seg.node) continue;
      if (seg.to <= start || seg.from >= end) continue;
      const s = Math.max(0, start - seg.from);
      const e = Math.min(seg.node.data.length, end - seg.from);
      if (e > s) out.push({ node: seg.node, s, e });
    }
    return out;
  }

  function locusFor(index, off, atEnd) {
    const segs = textSegs(index);
    for (const s of segs) {
      if (atEnd ? (off > s.from && off <= s.to) : (off >= s.from && off < s.to)) {
        return { node: s.node, offset: off - s.from };
      }
    }
    if (!atEnd) {
      const nxt = segs.find(s => s.from >= off);
      if (nxt) return { node: nxt.node, offset: 0 };
    } else {
      let prev = null;
      for (const s of segs) if (s.to <= off) prev = s;
      if (prev) return { node: prev.node, offset: prev.node.data.length };
    }
    const last = segs[segs.length - 1];
    return last ? { node: last.node, offset: last.node.data.length } : null;
  }

  function rangeFromOffsets(index, start, end) {
    const a = locusFor(index, start, false);
    const b = locusFor(index, end, true);
    if (!a || !b) return null;
    const r = (index.root.ownerDocument || document).createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  }

  // Wrap every text node slice of [start,end) in <mark class="bfp-hl">.
  // Splitting a text node never changes the page's concatenated text, so
  // offsets computed from an earlier index stay valid — but `index` itself is
  // stale afterwards and callers must rebuild it before painting the next one.
  function paintOffsets(index, start, end, id) {
    const parts = textNodesIn(index, start, end);
    const marks = [];
    for (const p of parts) {
      let n = p.node;
      if (!n.parentNode) continue;
      if (p.e < n.data.length) n.splitText(p.e);
      if (p.s > 0) n = n.splitText(p.s);
      if (!n.data.trim()) continue; // don't leave empty marks on inter-node whitespace
      const mark = (n.ownerDocument || document).createElement('mark');
      mark.className = 'bfp-hl';
      mark.setAttribute('data-bfp', String(id));
      styleMark(mark, false);
      n.parentNode.insertBefore(mark, n);
      mark.appendChild(n);
      marks.push(mark);
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
    for (const mark of marksFor(id)) styleMark(mark, !!on);
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

  const api = {
    // pure
    normIndex, normalize, findSpans, buildAnchor, locate, tailOverlap, headOverlap,
    CTX, WINDOW,
    // dom
    buildTextIndex, offsetsFromRange, offsetOf, rangeFromOffsets, textNodesIn,
    paintOffsets, unpaint, setFocus, scrollTo, rekey, marksFor, paintedIds,
    HL_BG, HL_BG_FOCUS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPAnchor = api;
})(typeof window !== 'undefined' ? window : globalThis);
