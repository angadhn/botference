// pdf-annot.test.mjs — the PDF's own margin, both directions.
//
//   node frontends/plugin/test/pdf-annot.test.mjs
//
// Two halves, and they are tested differently on purpose:
//
//   READING   the decisions are pure (which annotations are comments, what
//             their id is, which spans a quad covers, what a quote is) and are
//             driven here with objects shaped exactly as pdf.js's
//             getAnnotations() answers. The REAL pdf.js parse is asserted in
//             pdf-render.test.mjs, in a real browser, because that is where
//             the parse actually happens.
//   WRITING   there is nothing pure about it, so it is done for real: annotate
//             the two-page fixture with the vendored pdf-lib and read the file
//             back — the annotation dictionaries, the appearance stream, and
//             the invariant the whole feature rests on (the page's CONTENT is
//             untouched, so the document's identity does not move).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
// store.mjs resolves its workspace at import time; a throwaway keeps even an
// accidental write out of the developer's live .botference
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-annot-'));
const require_ = createRequire(import.meta.url);
const A = require_(path.join(ROOT, 'extension', 'pdf', 'annots.js'));
const PDFLib = require_(path.join(ROOT, 'extension', 'vendor', 'pdf-lib', 'pdf-lib.min.js'));
const store = await import(path.join(ROOT, 'store.mjs'));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));

// ---- dates -----------------------------------------------------------------
// Acrobat, Preview and every library write the same field five ways.
eq('an Acrobat date with an offset is that instant, in UTC',
  A.pdfDateToIso("D:20260820190606+01'00'"), '2026-08-20T18:06:06.000Z');
eq('…a negative offset goes the other way',
  A.pdfDateToIso("D:20260820140000-05'00'"), '2026-08-20T19:00:00.000Z');
eq('…Z is an offset too', A.pdfDateToIso('D:20260820190606Z'), '2026-08-20T19:06:06.000Z');
eq('…a truncated date is a date', A.pdfDateToIso('D:2026'), '2026-01-01T00:00:00.000Z');
eq('…the D: is optional, because producers forget it',
  A.pdfDateToIso('20260820190606Z'), '2026-08-20T19:06:06.000Z');
eq('a date that is not one says nothing rather than guessing',
  A.pdfDateToIso('yesterday'), '');
eq('…and so does an empty field', A.pdfDateToIso(''), '');
eq('a month that does not exist is refused', A.pdfDateToIso('D:20261320000000Z'), '');
eq('writing a date back is UTC, always',
  A.isoToPdfDate('2026-08-20T18:06:06.000Z'), "D:20260820180606Z00'00'");
eq('…and it round trips',
  A.pdfDateToIso(A.isoToPdfDate('2026-08-20T18:06:06.000Z')), '2026-08-20T18:06:06.000Z');

// ---- which annotations are comments ----------------------------------------
ok('a highlight is a comment', A.isImportable('Highlight'));
ok('…and so are the other three markups',
  ['Underline', 'StrikeOut', 'Squiggly'].every(A.isImportable));
ok('…and a sticky note', A.isImportable('Text'));
ok('a link is not', !A.isImportable('Link'));
ok('a Popup is not — it is the WINDOW of a comment, not the comment',
  !A.isImportable('Popup'));
ok('and neither is a form field', !A.isImportable('Widget'));

// pdf.js's shape, as it actually comes back (see the probe in the amendment):
// contentsObj/titleObj, a rect, quadPoints as an indexable Float32Array.
const rawHighlight = {
  subtype: 'Highlight', id: '489R',
  titleObj: { str: 'adril' },
  contentsObj: { str: 'Is shorter as for review is 100 word abstract' },
  modificationDate: "D:20260820190606+01'00'",
  rect: [275.43, 596.237, 320.155, 611.352],
  quadPoints: Float32Array.from([275.875, 610.908, 319.711, 610.908, 275.875, 596.681, 319.711, 596.681]),
  color: new Uint8ClampedArray([150, 67, 252]),
};
const h = A.normalizeAnnot(rawHighlight, 1);
eq('an annotation keeps its author', h.author, 'adril');
eq('…its words', h.text, 'Is shorter as for review is 100 word abstract');
eq('…its moment', h.ts, '2026-08-20T18:06:06.000Z');
eq('…and the page it is on', h.page, 1);
eq('a quad becomes one box, corners sorted',
  h.quads.map(q => q.map(v => Math.round(v * 1000) / 1000)),
  [[275.875, 596.681, 319.711, 610.908]]);
ok('a Popup normalizes to nothing at all',
  A.normalizeAnnot({ subtype: 'Popup', rect: [0, 0, 1, 1] }, 1) === null);
ok('a highlight with nothing said in it is a MARKER, not a comment',
  A.foldReplies([A.normalizeAnnot({ ...rawHighlight, contentsObj: { str: '   ' } }, 1)]).length === 0);

// ---- the origin id ---------------------------------------------------------
// The whole of idempotence. It must not move when the file is re-saved, and it
// must move when the comment is edited.
const key = A.annotKey(h);
eq('the id is stable across a re-save that renumbers the objects',
  A.annotKey(A.normalizeAnnot({ ...rawHighlight, id: '1204R' }, 1)), key);
eq('…and across float noise in the rectangle',
  A.annotKey(A.normalizeAnnot({ ...rawHighlight, rect: [275.4304, 596.2371, 320.1552, 611.3519] }, 1)), key);
eq('…and across whitespace in the words',
  A.annotKey({ ...h, text: 'Is shorter as  for review\nis 100 word abstract' }), key);
ok('EDITING the comment makes a new one',
  A.annotKey({ ...h, text: h.text + ' — actually 150' }) !== key);
ok('…so does another author saying the same thing',
  A.annotKey({ ...h, author: 'angadh' }) !== key);
ok('…and so does the same comment on another page',
  A.annotKey({ ...h, page: 2 }) !== key);
ok('the id survives store.cleanOrigin, which is where it has to live',
  !!store.cleanOrigin({ system: 'pdf-annot', id: key }));
eq('…unchanged', store.cleanOrigin({ system: 'pdf-annot', id: key }).id, key);
ok('`pdf-annot` is a system the store knows',
  store.ORIGIN_SYSTEMS.includes('pdf-annot'));

// ---- Acrobat's reply chains ------------------------------------------------
const parent = A.normalizeAnnot(rawHighlight, 1);
const reply = A.normalizeAnnot({
  subtype: 'Text', id: '500R', inReplyTo: '489R',
  titleObj: { str: 'angadh' }, contentsObj: { str: 'Cut it to 100 then.' },
  modificationDate: 'D:20260821090000Z', rect: [275, 596, 320, 611],
}, 1);
const folded = A.foldReplies([parent, reply]);
eq('a reply chain is ONE conversation', folded.length, 1);
eq('…with the reply under the comment it answers', folded[0].replies.length, 1);
eq('…in that person’s name', folded[0].replies[0].author, 'angadh');
ok('…and a reply that stands alone (its parent was deleted) is its own thread',
  A.foldReplies([reply]).length === 1);

// ---- geometry --------------------------------------------------------------
// Boxes in PDF user space: y counts UP from the bottom of the page.
const spans = [
  { text: 'This paper examines advances in soft', box: [88, 552, 507, 567] },
  { text: 'and inflatable robotic systems to make', box: [88, 538, 507, 553] },
  { text: 'a credible case for their use.', box: [88, 524, 300, 539] },
  { text: 'The next paragraph is elsewhere.', box: [88, 480, 400, 495] },
];
eq('a quad over one line picks that line',
  A.spansUnder(spans, [[88, 553, 507, 567]]), [0]);
eq('a two-line highlight picks both lines',
  A.spansUnder(spans, [[88, 552, 507, 567], [88, 538, 300, 553]]), [0, 1]);
eq('a mark that merely grazes the line above does not take it',
  A.spansUnder(spans, [[88, 550, 507, 555]]), []);
eq('the quote is the words, whitespace folded',
  A.quoteFromSpans(spans, [0, 1]).quote,
  'This paper examines advances in soft and inflatable robotic systems to make');
ok('…with the neighbouring text as prefix and suffix',
  A.quoteFromSpans(spans, [1]).prefix.endsWith('in soft'),
  A.quoteFromSpans(spans, [1]).prefix);
eq('…suffix too', A.quoteFromSpans(spans, [1]).suffix.slice(0, 10), 'a credible');
ok('a quote is capped rather than allowed to be a page',
  A.quoteFromSpans([{ text: 'x '.repeat(2000), box: [0, 0, 1, 1] }], [0]).quote.length <= A.QUOTE_MAX);
eq('a sticky note takes the line it is pinned beside',
  A.spanNearest(spans, 80, 560), 0);
eq('…the nearest line when it sits between two',
  A.spanNearest(spans, 80, 510), 2);
eq('…and nothing at all when there is nothing near it',
  A.spanNearest(spans, 80, -900), -1);
eq('a page with no text under the mark yields no quote',
  A.quoteFromSpans(spans, []), null);

// ---- what a popup says -----------------------------------------------------
const thread = {
  quote: 'deploy and commit',
  msgs: [
    { author: 'angadh', ts: '2026-08-25T09:00:00Z', text: 'Is this the right phrase?' },
    { author: 'claude', ts: '2026-08-25T09:01:00Z', kind: 'tools', text: 'read 3 files' },
    { author: 'claude', ts: '2026-08-25T09:02:00Z', text: 'Suggest “release and secure”.' },
  ],
};
const contents = A.threadContents(thread, { head: '“deploy and commit”' });
ok('the popup names every speaker', /angadh/.test(contents) && /claude/.test(contents));
ok('…and dates them', /25 Aug 2026/.test(contents));
ok('…keeps the quote at the top', contents.startsWith('“deploy and commit”'));
ok('…and leaves the bots’ tool narration out of it', !/read 3 files/.test(contents));
eq('a copy is never the original', A.exportFileName('adriana-manuscript-v4.pdf'),
  'adriana-manuscript-v4 (discussed).pdf');
eq('…even when the name has no extension', A.exportFileName('paper'), 'paper (discussed).pdf');

// ---- writing, for real -----------------------------------------------------
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'two-pages.pdf');
const src = new Uint8Array(fs.readFileSync(FIXTURE));
const items = [
  {
    page: 1,
    quads: [[72, 700, 400, 714], [72, 686, 300, 700]],
    contents, author: 'angadh', ts: '2026-08-25T09:02:00Z', created: '2026-08-25T09:00:00Z',
    subject: 'Discuss', color: [1, 0.83, 0.25], name: 'bfp-t1',
  },
  {
    page: 2,
    quads: [[72, 600, 380, 614]],
    contents: 'mira · 25 Aug 2026, 10:00:\nSecond page, second comment.',
    author: 'mira', ts: '2026-08-25T10:00:00Z', subject: 'Discuss',
    color: [1, 0.83, 0.25], name: 'bfp-t2',
  },
  // a thread whose highlight could not be placed: no quads, nothing written
  { page: 1, quads: [], contents: 'orphan', author: 'angadh', name: 'bfp-t3' },
];
const out = await A.writeAnnots(PDFLib, src, items);
eq('every placeable thread is written', out.written, 2);
eq('…and one that could not be placed is reported, not invented', out.skipped.length, 1);
ok('the file grew rather than being replaced', out.bytes.length > src.length);

// read it back through pdf-lib itself: the dictionaries, exactly as written
const { PDFDocument, PDFName, PDFHexString } = PDFLib;
const back = await PDFDocument.load(out.bytes);
const annotsOf = i => {
  const arr = back.getPage(i).node.Annots();
  const list = [];
  for (let n = 0; n < (arr ? arr.size() : 0); n++) list.push(arr.lookup(n));
  return list;
};
const p1 = annotsOf(0);
eq('page 1 carries its one annotation', p1.length, 1);
const a1 = p1[0];
const nameOf = (d, k) => { const v = d.get(PDFName.of(k)); return v ? v.toString() : ''; };
eq('…as a Highlight', nameOf(a1, 'Subtype'), '/Highlight');
eq('…with two quads, one per line', a1.get(PDFName.of('QuadPoints')).size(), 16);
const textOf = (d, k) => {
  const v = d.get(PDFName.of(k));
  return v instanceof PDFHexString ? v.decodeText() : String(v);
};
ok('…the whole discussion in its popup', textOf(a1, 'Contents').includes('Suggest “release and secure”.'),
  textOf(a1, 'Contents'));
ok('…in UTF-16, so a curly quote is a curly quote',
  textOf(a1, 'Contents').includes('“deploy and commit”'));
eq('…signed by whoever opened the thread', textOf(a1, 'T'), 'angadh');
eq('…dated', nameOf(a1, 'M'), "(D:20260825090200Z00'00')");
eq('…named, so a second export is recognisably the same annotation',
  nameOf(a1, 'NM'), '(bfp-t1)');
eq('…printable and not hidden', nameOf(a1, 'F'), '4');
ok('…and pointing back at its own page', !!a1.get(PDFName.of('P')));
eq('page 2 gets its own', annotsOf(1).length, 1);
eq('…drawn in the live colour, which is the only colour a written thread has: '
   + 'a resolved thread never reaches the writer at all (viewer.js collectItems)',
  annotsOf(1)[0].get(PDFName.of('C')).toString(), '[ 1 0.83 0.25 ]');
ok('…and no annotation goes out marked as filed',
  ![...annotsOf(0), ...annotsOf(1)].some(d => /resolved/.test(textOf(d, 'Subj'))));

// the appearance stream — the difference between "Acrobat draws it" and
// "Acrobat is entitled to draw nothing"
const ap = a1.get(PDFName.of('AP'));
ok('every annotation carries an appearance', !!ap);
const apStream = back.context.lookup(ap.get(PDFName.of('N')));
const apText = Buffer.from(apStream.getContents()).toString('latin1');
ok('…which fills one box per quad', (apText.match(/re\b/g) || []).length === 2, apText);
const apDict = apStream.dict;
eq('…as a form XObject', apDict.get(PDFName.of('Subtype')).toString(), '/Form');
ok('…in a transparency group, which is what makes a highlight ink and not paint',
  apDict.get(PDFName.of('Group')).toString().includes('/Transparency'));
ok('…blended Multiply, exactly as Acrobat writes it',
  apDict.get(PDFName.of('Resources')).toString().includes('/Multiply')
  || back.context.lookup(apDict.get(PDFName.of('Resources'))).toString().includes('/Multiply'));

// ---- the OTHER mark: a strikeout --------------------------------------------
// Adobe's second tool. A thread struck on screen goes out as a real
// /StrikeOut, which every viewer already draws — the whole point of the export
// being the person who has no Discuss.
eq('a StrikeOut is a deletion', A.markForKind('StrikeOut'), 'strike');
eq('…and so is a Squiggly, which means the same thing to whoever drew it',
  A.markForKind('Squiggly'), 'strike');
eq('a Highlight is a pointer, not a deletion', A.markForKind('Highlight'), 'highlight');
eq('…and so is an Underline', A.markForKind('Underline'), 'highlight');
eq('…and anything unknown is a highlight, which is the safe reading',
  A.markForKind('Ink'), 'highlight');
// the node side and the companion side must not drift: two copies of one rule
for (const k of ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text', '']) {
  eq('the companion agrees about ' + (k || 'nothing'),
    store.markForAnnotKind(k), A.markForKind(k) === 'strike' ? 'strike' : '');
}

// the bar, as pure geometry: a thin box through the middle of the quad, never
// thicker than the line it strikes
const bar = A.strikeBar([72, 700, 400, 714]);
eq('a strike bar spans the quad it strikes', [bar[0], bar[2]], [72, 328]);
ok('…and is thin — a line, not a wash', bar[3] > 0 && bar[3] <= A.STRIKE_H, JSON.stringify(bar));
ok('…sitting at the middle of the x-height, below the middle of the box',
  bar[1] > 700 && bar[1] + bar[3] < 700 + 14 * 0.5, JSON.stringify(bar));
const tiny = A.strikeBar([72, 100, 200, 104]);   // 4pt type
ok('…and on very small type it is thinner still, never thicker than the line',
  tiny[3] < bar[3] && tiny[3] > 0, JSON.stringify(tiny));

const sOut = await A.writeAnnots(PDFLib, src, [{
  page: 1, quads: [[72, 700, 400, 714]], subtype: 'StrikeOut',
  contents: 'angadh · 25 Aug 2026, 09:00:\n(no note)', author: 'angadh',
  ts: '2026-08-25T09:00:00Z', subject: 'Discuss · suggested deletion',
  color: [0.78, 0.19, 0.19], name: 'bfp-t9',
}]);
eq('a struck thread is written', sOut.written, 1);
const sBack = await PDFDocument.load(sOut.bytes);
const sArr = sBack.getPage(0).node.Annots();
const sa = sArr.lookup(0);
eq('…as a StrikeOut, which is what Acrobat and Preview already draw',
  nameOf(sa, 'Subtype'), '/StrikeOut');
eq('…with the same quads a highlight would have had',
  sa.get(PDFName.of('QuadPoints')).size(), 8);
eq('…in Acrobat\u2019s own strikeout red', sa.get(PDFName.of('C')).toString(), '[ 0.78 0.19 0.19 ]');
ok('…saying in its subject what it is', textOf(sa, 'Subj').includes('suggested deletion'));
ok('…and a note-less strikeout does not sign a name over a blank popup',
  textOf(sa, 'Contents').includes('(no note)'));
const sAp = sBack.context.lookup(sa.get(PDFName.of('AP')).get(PDFName.of('N')));
const sApText = Buffer.from(sAp.getContents()).toString('latin1');
ok('…with an appearance of its own, so no viewer is entitled to draw nothing',
  (sApText.match(/re\b/g) || []).length === 1, sApText);
const sBox = sApText.match(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re/);
ok('…which is a thin bar through the words, not a box over them',
  !!sBox && Number(sBox[4]) <= A.STRIKE_H && Number(sBox[2]) > 700, sApText);
ok('…and NOT blended Multiply: a line through the glyphs is meant to be opaque',
  !back.context.lookup(sAp.dict.get(PDFName.of('Resources'))).toString().includes('/Multiply')
  && sBack.context.lookup(sAp.dict.get(PDFName.of('Resources'))).toString().includes('/Normal'));
// and the writer's default is unchanged for everything that does not ask
eq('an item that says nothing about its subtype is still a Highlight',
  nameOf(a1, 'Subtype'), '/Highlight');

// the store's own half of the rule
eq('a strike mark survives the store', store.cleanMark('strike'), 'strike');
eq('…and anything else is the default, written as nothing at all',
  [store.cleanMark('highlight'), store.cleanMark(''), store.cleanMark(null), store.cleanMark('STRIKE ')],
  ['', '', '', 'strike']);
const mpage = { url: 'bfp-pdf://text/' + 'b'.repeat(64), threads: [], page_chat: [] };
const th = store.addThread(mpage, { quote: 'q', text: 't', author: 'angadh', mark: 'strike' });
eq('…and rides the thread', th.mark, 'strike');
eq('…and reads back as its kind', store.markOf(th), 'strike');
const hh = store.addThread(mpage, { quote: 'q2', text: 't', author: 'angadh' });
ok('an ordinary thread carries no mark field at all — nothing to migrate',
  !('mark' in hh) && store.markOf(hh) === 'highlight');

// ---- THE INVARIANT ---------------------------------------------------------
// A local PDF is identified by the sha256 of its extracted TEXT. Annotations
// are not text, so an annotated copy is THE SAME PAGE — same identity, same
// key, same chat. That is the entire reason the text identity exists, and it
// is pinned here at the only level node can see it at: the pages' content
// streams, and the resources that decode them, come back byte-for-byte. A
// text extractor reads exactly those, so if they have not moved, no word has.
// Every string this page SHOWS, in order, read off its content streams. Not
// the streams themselves: pdf-lib wraps a page it has touched in another
// `q`/`Q` pair, which changes those bytes and draws exactly the same ink.
// What a text extractor reads is the text operators, and they are what must
// come back identical.
const SHOWN = /\((?:[^()\\]|\\.)*\)\s*T[Jj]/g;
async function pageWords(bytes) {
  const doc = await PDFDocument.load(bytes);
  const out = [];
  for (const page of doc.getPages()) {
    const streams = page.node.normalizedEntries().Contents;
    const parts = [];
    const n = streams && streams.size ? streams.size() : 0;
    for (let i = 0; i < n; i++) {
      parts.push(Buffer.from(doc.context.lookup(streams.get(i)).getContents()).toString('latin1'));
    }
    out.push({
      words: parts.join('\n').match(SHOWN) || [],
      fonts: String(page.node.normalizedEntries().Resources.get(PDFName.of('Font')) || ''),
    });
  }
  return out;
}
const before = await pageWords(src);
const after = await pageWords(out.bytes);
ok('the fixture has words to lose in the first place', before[0].words.length >= 4);
eq('writing annotations does not touch one text operator on the page',
  after.map(p => p.words), before.map(p => p.words));
eq('…nor of the fonts that decode it', after.map(p => p.fonts), before.map(p => p.fonts));
ok('…while the FILE is of course a different file (the identity is the words, not the bytes)',
  Buffer.compare(Buffer.from(out.bytes), Buffer.from(src)) !== 0);

// …and, one level up: an annotated copy re-imported offers exactly what it
// carries, and importing it twice is importing it once.
const reread = await PDFDocument.load(out.bytes);
eq('an annotated copy carries both comments', reread.getPages().reduce((n, p) => {
  const arr = p.node.Annots();
  return n + (arr ? arr.size() : 0);
}, 0), 2);

// ---- idempotence, at the level the companion sees it ------------------------
// (the endpoint itself is driven in companion.test.mjs; this is the rule it
// implements, over the store's own primitives)
const page = { url: 'bfp-pdf://text/' + 'a'.repeat(64), threads: [], page_chat: [] };
const comment = { quote: 'a passage', text: 'a remark', author: 'adril', ts: '2026-08-20T18:06:06.000Z' };
const origin = store.cleanOrigin({ system: 'pdf-annot', id: key });
store.addThread(page, { ...comment, origin });
ok('a thread filed under a pdf-annot origin is found again by it',
  !!store.findOrigin(page, 'pdf-annot', key));
ok('…and a second import of the same annotation finds it rather than adding one',
  store.findOrigin(page, 'pdf-annot', key) === page.threads[0] && page.threads.length === 1);
ok('…while a REVIEW comment with the same id is a different comment entirely',
  !store.findOrigin(page, 'review', key));

try { fs.rmSync(process.env.BOTFERENCE_PROJECT_ROOT, { recursive: true, force: true }); } catch { /* temp */ }

if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' pdf-annot.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
