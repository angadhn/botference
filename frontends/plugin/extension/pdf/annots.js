// annots.js — the PDF's own margin, in both directions.
//
// A manuscript that has been round a supervisor, a co-author and a copy editor
// arrives with comments ALREADY IN IT: Acrobat's highlights and sticky notes,
// Preview's yellow bars, each with an author, a date and a paragraph of
// popup text. Discuss used to render that paper and say "No comments yet",
// which was a lie about the document on screen.
//
// So the two directions:
//
//   IMPORT   a text-markup annotation (Highlight/Underline/StrikeOut/Squiggly)
//            or a text note (Text) becomes an ordinary Discuss thread — the
//            words under its quads are the quote, its /Contents is the first
//            comment, its /T is the author and its /M is the timestamp.
//   EXPORT   a Discuss thread becomes a Highlight annotation in a COPY of the
//            file, its whole discussion (bots included) in the popup, so a
//            reader who only has Acrobat sees the conversation.
//
// ── WHAT IS PURE AND WHAT IS NOT ───────────────────────────────────────────
// Everything here is either pure (dates, keys, geometry, the digest a popup
// carries) or takes its world as an argument — `writeAnnots` is handed the
// PDF-lib module rather than importing one, so node can test the writer with
// the vendored copy and the viewer can hand it the copy it loaded. The DOM
// half (which spans are under which quad) lives in pdf/viewer.js, because that
// is where the text layer is; this file only knows boxes of numbers.
//
// ── THE ONE INVARIANT WORTH STATING TWICE ──────────────────────────────────
// A local PDF is identified by the SHA-256 of its extracted TEXT
// (`bfp-pdf://text/…`, adapters.js). Annotations are not text: writing them
// changes every byte of the file and not one word of the extract. So the
// annotated copy is THE SAME PAGE — same identity, same key, same chat — and
// re-opening it shows the discussion it was written from. That is not a happy
// accident, it is why the text identity exists, and pdf-annot.test.mjs pins it.
(function (root) {
  'use strict';

  // ---- the annotations we take seriously -----------------------------------
  // Text markup (a mark over words) and a text note (a sticky pinned at a
  // point). Everything else in the /Annots array — links, widgets, stamps,
  // ink, the Popup objects that merely hold a markup annotation's window — is
  // either not a comment or is the same comment counted twice.
  const MARKUP = ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'];
  const NOTES = ['Text', 'FreeText'];
  const isMarkup = s => MARKUP.indexOf(String(s || '')) >= 0;
  const isNote = s => NOTES.indexOf(String(s || '')) >= 0;
  const isImportable = s => isMarkup(s) || isNote(s);

  // ---- dates ---------------------------------------------------------------
  // PDF dates are `D:YYYYMMDDHHmmSSOHH'mm'` with everything after the year
  // optional and the offset written three different ways in the wild (`Z`,
  // `+01'00'`, `+01'00`, `-0500`). A comment's date is half of what it means,
  // so this is parsed properly rather than shown as the raw string.
  function pdfDateToIso(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const m = /^D?:?\s*(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(\d{2})'?(\d{2})?'?)?/.exec(s);
    if (!m) return '';
    const [, Y, Mo, D, H, Mi, S, sign, oh, om] = m;
    const year = Number(Y);
    if (!(year >= 1000 && year <= 9999)) return '';
    const num = (v, d) => (v == null ? d : Number(v));
    const mo = num(Mo, 1), da = num(D, 1), hh = num(H, 0), mi = num(Mi, 0), ss = num(S, 0);
    if (mo < 1 || mo > 12 || da < 1 || da > 31 || hh > 23 || mi > 59 || ss > 60) return '';
    let ms = Date.UTC(year, mo - 1, da, hh, mi, Math.min(ss, 59));
    if (sign === '+' || sign === '-') {
      const off = (num(oh, 0) * 60 + num(om, 0)) * 60000;
      ms += (sign === '+' ? -off : off);
    }
    const d = new Date(ms);
    return isFinite(d.getTime()) ? d.toISOString() : '';
  }

  // …and back, for an annotation this end writes. Always UTC (`Z` is a legal
  // PDF offset and needs no local-time guesswork).
  function isoToPdfDate(iso) {
    const d = iso instanceof Date ? iso : new Date(String(iso || ''));
    const t = isFinite(d.getTime()) ? d : new Date();
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return 'D:' + t.getUTCFullYear() + p(t.getUTCMonth() + 1) + p(t.getUTCDate())
      + p(t.getUTCHours()) + p(t.getUTCMinutes()) + p(t.getUTCSeconds()) + "Z00'00'";
  }

  // ---- the origin key ------------------------------------------------------
  // WHY NOT THE OBJECT NUMBER. `489R` is what pdf.js calls an annotation, and
  // it is the file's own address for it — which Acrobat renumbers on every
  // save. An id that changes when the reader saves the file would re-offer
  // every comment in the document as new, which is precisely the bug the
  // origin marker exists to prevent.
  //
  // So the key is a hash of what the comment IS: which page, where on it (to
  // the point, so a re-save's float noise cannot move it), who wrote it and
  // what it says. Two consequences, both deliberate:
  //   · re-opening the same paper offers nothing again, however often it was
  //     saved in between;
  //   · EDITING a comment in Acrobat makes a NEW key, so it comes back as a
  //     new comment to import. The thread already here is left exactly as it
  //     is, because by then it may hold a bot's answer and the reader's reply,
  //     and neither of those belongs to the sentence that was edited.
  //
  // FNV-1a over two 32-bit lanes: sixteen hex characters, no crypto, no
  // promise, and the same answer in node and in the page. Collisions are a
  // non-event here — the alternative to a wrong key is a comment offered twice.
  function hash16(str) {
    const s = String(str == null ? '' : str);
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a ^= c; a = (a * 0x01000193) >>> 0;
      b = (b + c) >>> 0; b = (b * 0x85ebca6b) >>> 0; b ^= b >>> 13;
    }
    const hex = n => (n >>> 0).toString(16).padStart(8, '0');
    return hex(a) + hex(b);
  }
  const round1 = n => Math.round(Number(n) * 10) / 10;
  function annotKey(a) {
    const r = (a && a.rect) || [];
    return hash16([
      'p' + Number((a && a.page) || 0),
      String((a && a.subtype) || ''),
      r.slice(0, 4).map(round1).join(','),
      String((a && a.author) || ''),
      String((a && a.text) || '').replace(/\s+/g, ' ').trim(),
    ].join('|'));
  }

  // ---- one annotation, as this side understands it -------------------------
  // Takes what pdf.js's getAnnotations() answers and keeps the five things a
  // thread is made of. Returns null for anything that is not a comment: a
  // Popup (the window, not the note), a Link, and — importantly — a markup
  // annotation with NO contents, which is a reader's own yellow marker rather
  // than something said to anybody.
  function normalizeAnnot(raw, pageNum) {
    if (!raw || !isImportable(raw.subtype)) return null;
    // a reply (/IRT) is part of its parent's conversation, not a thread of its
    // own; it is folded into the parent by `foldReplies` below
    const text = String((raw.contentsObj && raw.contentsObj.str) || raw.contents || '').trim();
    const author = String((raw.titleObj && raw.titleObj.str) || raw.title || '').trim();
    const rect = Array.from(raw.rect || []).map(Number);
    if (rect.length !== 4) return null;
    const out = {
      page: Number(pageNum) || 0,
      subtype: String(raw.subtype),
      author,
      text,
      ts: pdfDateToIso(raw.modificationDate || raw.creationDate || ''),
      rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]),
             Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])],
      quads: quadRects(raw.quadPoints),
      ref: String(raw.id || ''),
      irt: String(raw.inReplyTo || ''),
    };
    out.id = annotKey(out);
    return out;
  }

  // pdf.js hands QuadPoints back as a flat run of eight numbers per quad
  // (upper-left, upper-right, lower-left, lower-right). Two of those corners
  // are enough for a box, and a box is all the text hunt wants.
  function quadRects(q) {
    const flat = [];
    if (!q) return flat;
    const n = q.length != null ? q.length : Object.keys(q).length;
    const at = i => Number(q[i]);
    for (let i = 0; i + 7 < n; i += 8) {
      const xs = [at(i), at(i + 2), at(i + 4), at(i + 6)];
      const ys = [at(i + 1), at(i + 3), at(i + 5), at(i + 7)];
      if (xs.some(v => !isFinite(v)) || ys.some(v => !isFinite(v))) continue;
      flat.push([Math.min.apply(null, xs), Math.min.apply(null, ys),
                 Math.max.apply(null, xs), Math.max.apply(null, ys)]);
    }
    return flat;
  }

  // A markup annotation and its replies (/IRT) are ONE conversation in
  // Acrobat, and one thread here: the parent opens it and each reply is a
  // message under it, in the order the file gives them.
  function foldReplies(list) {
    const byRef = Object.create(null);
    for (const a of list || []) if (a && a.ref) byRef[a.ref] = a;
    const roots = [];
    for (const a of list || []) {
      if (!a) continue;
      const parent = a.irt && byRef[a.irt];
      if (parent && parent !== a) {
        (parent.replies = parent.replies || []).push(a);
      } else roots.push(a);
    }
    // a markup with nothing said in it and no replies is a marker, not a
    // comment — the reader highlighted a line for themselves
    return roots.filter(a => a.text || (a.replies && a.replies.length));
  }

  // ---- geometry: which words are under the mark ----------------------------
  // Both directions work in PDF user space (points, origin bottom-left), which
  // is the space quads are written in and the space viewer.js converts its DOM
  // rectangles into. Nothing here knows about CSS pixels or zoom.
  const overlap = (a, b) => {
    const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const area = r => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

  // A span counts as "under the mark" when a THIRD of it is covered. Not any
  // touch (a highlight overshoots its line and would swallow the line above),
  // and not most-of-it either (the first and last words of a selection are
  // usually clipped mid-glyph).
  const COVERED = 0.33;
  function spansUnder(spans, rects, minCover) {
    const want = minCover == null ? COVERED : minCover;
    const hits = [];
    for (let i = 0; i < (spans || []).length; i++) {
      const s = spans[i];
      const box = s && s.box;
      if (!box) continue;
      const a = area(box);
      if (!a) continue;
      let cov = 0;
      for (const r of rects || []) cov += overlap(box, r);
      if (cov / a >= want) hits.push(i);
    }
    return hits;
  }

  // A sticky note is pinned at a point and points at a LINE. The line is the
  // span whose vertical band the note's top-left corner sits in and which
  // starts nearest to it; failing that (a note in a margin, a note between
  // paragraphs) it is simply the nearest span by distance. A note with no text
  // anywhere near it — a note on a blank page — gets no quote at all and
  // becomes a page-chat message rather than an orphan.
  const NEAR_MAX = 400;               // points — a third of a page away is "nowhere near"
  function spanNearest(spans, x, y) {
    let best = -1;
    let bestScore = Infinity;
    let bestDist = Infinity;
    for (let i = 0; i < (spans || []).length; i++) {
      const b = spans[i] && spans[i].box;
      if (!b) continue;
      const inBand = y >= b[1] - 2 && y <= b[3] + 2;
      const dx = x < b[0] ? b[0] - x : (x > b[2] ? x - b[2] : 0);
      const dy = y < b[1] ? b[1] - y : (y > b[3] ? y - b[3] : 0);
      const dist = Math.sqrt(dx * dx + dy * dy);
      // a span on the note's own line wins over a closer one on another line.
      // The band bonus rides the SCORE and not the distance, because the
      // distance is what decides whether there is anything here at all.
      const score = (inBand ? 0 : 1000) + dist;
      if (score < bestScore) { bestScore = score; bestDist = dist; best = i; }
    }
    return bestDist > NEAR_MAX ? -1 : best;
  }

  // ---- quote, prefix, suffix ----------------------------------------------
  // The same three fields the drawer captures from a selection, so an imported
  // thread anchors, re-anchors and orphans exactly as a hand-made one does.
  // Whitespace is folded because the text layer's spans do not carry the
  // spaces between them.
  const QUOTE_MAX = 600;
  function quoteFromSpans(spans, idxs) {
    const list = spans || [];
    const pick = (idxs || []).slice().sort((a, b) => a - b);
    if (!pick.length) return null;
    const join = ids => ids.map(i => String((list[i] && list[i].text) || '')).join(' ')
      .replace(/\s+/g, ' ').trim();
    const first = pick[0];
    const last = pick[pick.length - 1];
    const before = [];
    for (let i = Math.max(0, first - 4); i < first; i++) before.push(i);
    const after = [];
    for (let i = last + 1; i < Math.min(list.length, last + 5); i++) after.push(i);
    let quote = join(pick);
    if (quote.length > QUOTE_MAX) quote = quote.slice(0, QUOTE_MAX).replace(/\s\S*$/, '');
    return {
      quote,
      prefix: join(before).slice(-32),
      suffix: join(after).slice(0, 32),
    };
  }

  // ---- export: what the popup says ----------------------------------------
  // ONE annotation per thread, with the whole conversation in its /Contents.
  //
  // The alternative was a parent plus one /IRT reply per message, which is how
  // Acrobat models a conversation — and which macOS Preview, Skim and every
  // browser viewer ignore completely, showing only the parent's first line.
  // The point of writing the file at all is the person who does not have
  // Discuss, so the format is the one every viewer renders: a popup with the
  // conversation in it, each entry named and dated.
  function threadContents(thread, opts) {
    const o = opts || {};
    const msgs = ((thread && thread.msgs) || []).filter(m => m && m.kind !== 'tools');
    const lines = [];
    for (const m of msgs) {
      const who = String(m.author || 'someone');
      const when = prettyDate(m.ts);
      lines.push(who + (when ? ' · ' + when : '') + ':');
      lines.push(String(m.text || '').replace(/\r\n?/g, '\n').trim());
      lines.push('');
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    const head = o.head ? [o.head, ''] : [];
    return head.concat(lines).join('\n');
  }
  function prettyDate(ts) {
    const d = new Date(String(ts || ''));
    if (!isFinite(d.getTime())) return '';
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = n => String(n).padStart(2, '0');
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear()
      + ', ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // the name of the copy. Never the original: an export must not be able to
  // overwrite the file it was made from, and a reader wants to see which is
  // which in their Downloads folder.
  function exportFileName(name) {
    const base = String(name || 'document').replace(/\.pdf$/i, '').trim() || 'document';
    return base + ' (discussed).pdf';
  }

  // ---- export: the writing itself ------------------------------------------
  // `PDFLib` is handed in (see the header): the viewer passes the vendored copy
  // it loaded, node passes the same file through require(). Nothing here
  // imports anything.
  //
  // items: [{ page, quads:[[x0,y0,x1,y1],…], contents, author, ts, subject, color }]
  //   page   1-based, as everything user-facing in this codebase is
  //   quads   PDF user space, one box per line of the passage
  //   color   [r,g,b] 0..1 — the highlight's own colour
  //
  // WHY AN APPEARANCE STREAM. A Highlight with no /AP is drawn by pdf.js and
  // by Preview, and by Acrobat only sometimes — Acrobat is entitled to render
  // nothing at all for an annotation that does not say how it looks, and on a
  // flattened or printed copy it does exactly that. So every annotation here
  // carries the appearance Acrobat itself writes: a transparency group filled
  // with the highlight colour under a /Multiply blend, which is what makes a
  // highlight look like ink over glyphs rather than a block covering them.
  async function writeAnnots(PDFLib, bytes, items, opts) {
    const o = opts || {};
    const { PDFDocument, PDFName, PDFNumber, PDFArray, PDFString, PDFHexString, PDFRawStream } = PDFLib;
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const ctx = doc.context;
    const pages = doc.getPages();
    let written = 0;
    const skipped = [];

    for (const item of items || []) {
      const n = Number(item && item.page) || 0;
      const page = pages[n - 1];
      const quads = (item && item.quads) || [];
      if (!page || !quads.length) { skipped.push(item); continue; }
      const color = normColor(item.color);

      // the annotation's box is every quad, with a hair of padding so a
      // rounded coordinate cannot clip the ink
      const rect = quads.reduce((r, q) => [
        Math.min(r[0], q[0]), Math.min(r[1], q[1]),
        Math.max(r[2], q[2]), Math.max(r[3], q[3]),
      ], [Infinity, Infinity, -Infinity, -Infinity]).map((v, i) => (i < 2 ? v - 1 : v + 1));

      // QuadPoints: upper-left, upper-right, lower-left, lower-right per quad
      // — the order every real producer writes and every real consumer reads.
      const qp = [];
      for (const q of quads) qp.push(q[0], q[3], q[2], q[3], q[0], q[1], q[2], q[1]);

      const apRef = appearanceStream(ctx, PDFRawStream, rect, quads, color);
      const dict = ctx.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: rect.map(v => PDFNumber.of(v)),
        QuadPoints: qp.map(v => PDFNumber.of(v)),
        // text, author and date carry the whole point of the export, so they
        // are written as UTF-16 hex strings: an em-dash or an accent in a
        // reply must not come out as mojibake in Acrobat
        Contents: PDFHexString.fromText(String(item.contents || '')),
        T: PDFHexString.fromText(String(item.author || 'Discuss')),
        Subj: PDFHexString.fromText(String(item.subject || 'Comment')),
        M: PDFString.of(isoToPdfDate(item.ts)),
        CreationDate: PDFString.of(isoToPdfDate(item.created || item.ts)),
        C: color.map(v => PDFNumber.of(v)),
        CA: PDFNumber.of(o.opacity == null ? 1 : o.opacity),
        F: PDFNumber.of(4),                       // print, and not hidden
        // a stable per-annotation name, so a second export of the same thread
        // into the same file is recognisably the same annotation
        NM: PDFString.of(String(item.name || '')),
        AP: ctx.obj({ N: apRef }),
      });
      const ref = ctx.register(dict);
      dict.set(PDFName.of('P'), page.ref);
      page.node.addAnnot(ref);
      written++;
    }

    // `useObjectStreams:false` keeps the result readable to anything that can
    // read a PDF at all, including a plain-text grep in a failing test.
    const out = await doc.save({ useObjectStreams: false, addDefaultPage: false });
    return { bytes: out, written, skipped };
  }

  const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));
  function normColor(c) {
    const a = Array.isArray(c) && c.length >= 3 ? c : [1, 0.85, 0.2];
    // pdf.js hands colours back as 0..255; a caller may equally pass 0..1
    const scale = a.some(v => Number(v) > 1) ? 255 : 1;
    return [clamp01(a[0] / scale), clamp01(a[1] / scale), clamp01(a[2] / scale)];
  }

  // The form XObject Acrobat would have written: a transparency group, a
  // Multiply blend, and one filled box per quad. Drawn in the annotation's own
  // coordinate space (BBox = Rect, no /Matrix), which is what lets a viewer
  // move the annotation without re-rendering it.
  function appearanceStream(ctx, PDFRawStream, rect, quads, color) {
    const ops = ['/GS0 gs', color.map(v => round3(v)).join(' ') + ' rg'];
    for (const q of quads) {
      ops.push([round3(q[0]), round3(q[1]), round3(q[2] - q[0]), round3(q[3] - q[1]), 're', 'f'].join(' '));
    }
    const body = ops.join('\n') + '\n';
    const gs = ctx.obj({ Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 });
    const stream = PDFRawStream.of(ctx.obj({
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: rect,
      Group: ctx.obj({ Type: 'Group', S: 'Transparency', CS: 'DeviceRGB' }),
      Resources: ctx.obj({ ExtGState: ctx.obj({ GS0: gs }) }),
      Length: body.length,
    }), encodeAscii(body));
    return ctx.register(stream);
  }
  const round3 = n => Math.round(Number(n) * 1000) / 1000;
  function encodeAscii(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  const api = {
    MARKUP, NOTES, isMarkup, isNote, isImportable,
    pdfDateToIso, isoToPdfDate,
    hash16, annotKey, normalizeAnnot, quadRects, foldReplies,
    spansUnder, spanNearest, quoteFromSpans, overlap, COVERED, QUOTE_MAX,
    threadContents, prettyDate, exportFileName,
    writeAnnots, normColor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BFPPdfAnnots = api;
})(typeof window !== 'undefined' ? window : globalThis);
