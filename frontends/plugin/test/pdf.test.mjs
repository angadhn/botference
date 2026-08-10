// pdf.test.mjs — the web-PDF path, everything of it that runs without a browser.
//
//   node frontends/plugin/test/pdf.test.mjs
//
// Four layers, and the last one is the point:
//
//   1. IDENTITY      which document a viewer address is showing. The record
//                    must be the PDF's url and never chrome-extension://…, and
//                    both spellings of the address (`?src=` encoded, `#raw=`
//                    verbatim from the redirect) have to mean the same thing.
//   2. EXTRACTION    reading PDF.js's text layer back out of the DOM — lines,
//                    page numbers, the article text the bots get, the snapshot
//                    a phone reads.
//   3. THE ANCHOR    a quote captured in the viewer must re-locate in the
//                    snapshot. That is the whole reason the snapshot is built
//                    from the same string the text layer produced, and it is
//                    asserted here rather than hoped for.
//   4. THE RECORD    the page number survives store.addThread and comes out of
//                    the Obsidian export as an attribution line — and a thread
//                    without one is byte-for-byte what it always was.
//
// No framework, no jsdom: the DOM readers take a document, so the tests hand
// them a hand-built one (below) that implements exactly the four methods they
// use. Exit code is the number of failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const A = require(path.join(here, '..', 'extension', 'adapters.js'));
const Anchor = require(path.join(here, '..', 'extension', 'anchor.js'));
const { renderNote } = await import(path.join(here, '..', 'export.mjs'));
const store = await import(path.join(here, '..', 'store.mjs'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, 'got  ' + g + '\n      want ' + w);
}

// ---- a document, hand-built -------------------------------------------------
// Only what adapters.js touches: nodeType, firstChild/nextSibling/parentNode,
// data, nodeName, getAttribute/hasAttribute, querySelector('.textLayer') and
// querySelectorAll('[data-bfp-pdf-page]').
function text(s) { return { nodeType: 3, data: s, parentNode: null }; }
function el(name, kids = [], attrs = {}) {
  const node = {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    attrs,
    kids,
    parentNode: null,
    firstChild: null,
    nextSibling: null,
    getAttribute: k => (k in attrs ? String(attrs[k]) : null),
    hasAttribute: k => k in attrs,
    querySelector(sel) {
      const want = sel.replace(/^\./, '');
      const hit = [];
      (function walk(n) {
        for (const k of n.kids || []) {
          if (k.nodeType !== 1) continue;
          if (String(k.attrs.class || '').split(/\s+/).includes(want)) hit.push(k);
          walk(k);
        }
      })(node);
      return hit[0] || null;
    },
  };
  for (let i = 0; i < kids.length; i++) {
    kids[i].parentNode = node;
    kids[i].nextSibling = kids[i + 1] || null;
  }
  node.firstChild = kids[0] || null;
  return node;
}
const span = s => el('span', [text(s)]);
const br = () => el('br');
// one page of the viewer, exactly as pdf/viewer.js builds it
function pageEl(n, lines, opts = {}) {
  const kids = [];
  lines.forEach((line, i) => {
    // PDF.js emits one span per text RUN, so a line is often several — that
    // split is precisely the "quirk" the extraction has to survive
    for (const run of line) kids.push(span(run));
    if (i < lines.length - 1 || opts.trailingBr) kids.push(br());
  });
  const layer = el('div', kids, { class: 'textLayer' });
  return el('div', [el('canvas'), layer], { 'data-bfp-pdf-page': String(n) });
}
const docOf = (...pages) => ({ querySelectorAll: () => pages });

// ---- 1. identity ------------------------------------------------------------
{
  const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pdf/viewer.html';
  const PDF = 'https://arxiv.org/pdf/2401.01234v2.pdf';

  eq('?src= carries the pdf url', A.pdfViewerSrc(EXT + '?src=' + encodeURIComponent(PDF)), PDF);
  eq('#raw= carries it verbatim (the redirect cannot encode)',
    A.pdfViewerSrc(EXT + '#raw=' + PDF), PDF);
  eq('…including a query with an ampersand in it, which ?src= parsing would cut in half',
    A.pdfViewerSrc(EXT + '#raw=https://files.test/get.pdf?id=7&token=abc'),
    'https://files.test/get.pdf?id=7&token=abc');
  eq('…and an encoded ?src= with the same ampersand survives too',
    A.pdfViewerSrc(EXT + '?src=' + encodeURIComponent('https://files.test/get.pdf?id=7&token=abc')),
    'https://files.test/get.pdf?id=7&token=abc');
  eq('the harness serves the same page over http and is the same viewer',
    A.pdfViewerSrc('http://127.0.0.1:8000/extension/pdf/viewer.html?src=' + encodeURIComponent(PDF)), PDF);

  eq('an ordinary page is not the viewer', A.pdfViewerSrc('https://example.com/sport/quiet'), null);
  eq('…nor is a page merely called viewer.html elsewhere',
    A.pdfViewerSrc('https://example.com/viewer.html?src=' + encodeURIComponent(PDF)), null);
  eq('the viewer with no src at all has no opinion', A.pdfViewerSrc(EXT), null);
  eq('a src that is not http(s) is refused', A.pdfViewerSrc(EXT + '?src=' + encodeURIComponent('file:///Users/a/x.pdf')), null);
  eq('…including javascript:', A.pdfViewerSrc(EXT + '#raw=javascript:alert(1)'), null);
  eq('…and an empty one', A.pdfViewerSrc(EXT + '?src='), null);
  eq('garbage in, no opinion out', A.pdfViewerSrc('::::'), null);
  eq('the url we build is the url we read back',
    A.pdfViewerSrc(A.pdfViewerUrl(EXT, PDF)), PDF);

  // what the redirect rule keys off
  const yes = ['https://a.test/x.pdf', 'http://a.test/x.PDF', 'https://a.test/x.pdf?v=2',
    'https://a.test/deep/path/paper.pdf#page=4'];
  const no = ['https://a.test/x.pdfx', 'https://a.test/x.pdf.html', 'https://a.test/download?id=7',
    'file:///Users/a/x.pdf', 'https://a.test/'];
  for (const u of yes) ok('looksPdfUrl: ' + u, A.looksPdfUrl(u));
  for (const u of no) ok('not a pdf url: ' + u, !A.looksPdfUrl(u));

  eq('the file name is the fallback title',
    A.pdfNameFromUrl('https://arxiv.org/pdf/2401.01234v2.pdf'), '2401.01234v2');
  eq('…decoded and de-punctuated',
    A.pdfNameFromUrl('https://x.test/a/The%20Quiet_Machine.pdf'), 'The Quiet Machine');
  eq('…and empty where there is nothing to take', A.pdfNameFromUrl('https://x.test/'), '');
}

// ---- 2. extraction ----------------------------------------------------------
const P1 = [
  ['The mood in the stands ', 'was flat', ', and the walk back'],
  ['to the tram stop was quieter than it has been in years.'],
];
const P2 = [
  ['The report called it a ', 'structural', ' failure of oversight,'],
  ['which is the kind of sentence that survives a season.'],
];

{
  const layer = pageEl(3, P1).querySelector('.textLayer');
  eq('a line is the runs joined, and <br> is where lines end',
    A.pdfLayerLines(layer),
    ['The mood in the stands was flat, and the walk back',
     'to the tram stop was quieter than it has been in years.']);

  const messy = el('div', [span('  double  spaced  '), br(), span('   '), br(), span('tail')],
    { class: 'textLayer' });
  eq('whitespace runs fold and empty lines are dropped',
    A.pdfLayerLines(messy), ['double spaced', 'tail']);

  const marked = el('div', [el('span', [span('inside '), span('marked content')],
    { class: 'markedContent' }), br(), span('after')], { class: 'textLayer' });
  eq('marked-content wrappers are walked through, not stopped at',
    A.pdfLayerLines(marked), ['inside marked content', 'after']);

  const doc = docOf(pageEl(1, P1), pageEl(2, P2));
  const pages = A.pdfPagesFromDom(doc);
  eq('every page with a text layer is read, in order', pages.map(p => p.page), [1, 2]);
  eq('…with its lines', pages[1].lines[0], 'The report called it a structural failure of oversight,');

  const blank = A.pdfPagesFromDom(docOf(el('div', [], { 'data-bfp-pdf-page': '1' })));
  eq('a page whose text layer has not rendered yet is empty, not absent', blank, [{ page: 1, lines: [] }]);

  const ctx = A.pdfContextText(pages);
  ok('the bots are told which page they are reading', /^\[page 1\]\n/.test(ctx));
  ok('…for every page', ctx.includes('[page 2]'));
  ok('…and the words are all there', ctx.includes('structural failure of oversight'));
  eq('a scan (no lines anywhere) produces nothing at all',
    A.pdfContextText([{ page: 1, lines: [] }, { page: 2, lines: [] }]), '');
  ok('the cap is honoured', A.pdfContextText(pages, 40).length <= 40);

  const snap = A.pdfSnapshotHtml(pages);
  ok('the snapshot is one section per page', (snap.match(/<section>/g) || []).length === 2);
  ok('…under the same page marker the viewer shows', snap.includes('<h2>Page 2</h2>'));
  ok('…with lines kept as <br>, which is what the anchors were built over',
    snap.includes('walk back<br>to the tram stop'));
  ok('…and nothing but section/h2/p/br, which is what the sanitizer keeps',
    !/<(?!\/?(section|h2|p|br)\b)[a-z]/i.test(snap));
  eq('a page with no text contributes no empty section',
    A.pdfSnapshotHtml([{ page: 1, lines: [] }]), '');
  ok('text is escaped on the way in',
    A.pdfSnapshotHtml([{ page: 1, lines: ['a <script>alert(1)</script> & b'] }])
      .includes('a &lt;script&gt;alert(1)&lt;/script&gt; &amp; b'));

  // which page an anchor came off
  const page = pageEl(12, P1);
  const node = page.querySelector('.textLayer').firstChild.firstChild;   // a text node
  eq('a node knows which page it is on', A.pdfPageOfNode(node), 12);
  eq('…and a node on no page says so', A.pdfPageOfNode(text('loose')), 0);
}

// ---- 3. the anchor, from the viewer to the phone ----------------------------
// anchor.js reads a DOM; both sides of this journey are DOMs it would flatten
// the same way (a block boundary and a <br> are each one '\n'). `rawOf` is
// that flattening, applied to the two strings this feature actually produces —
// so the assertion below is the real question: is a quote captured in the
// viewer still findable in the snapshot a phone is served?
const BLOCK = /^(section|h2|p|div|br)$/i;
function rawOfHtml(html) {
  let raw = '';
  const sep = () => { if (raw && !raw.endsWith('\n')) raw += '\n'; };
  const re = /<\/?([a-z0-9]+)[^>]*>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[2] !== undefined) {
      raw += m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    } else if (BLOCK.test(m[1])) sep();
  }
  return raw;
}
function rawOfViewer(pages) {
  // label, then the text layer's own runs and line breaks — what
  // buildTextIndex(document.body) would concatenate for pdf/viewer.html
  let raw = '';
  for (const p of pages) {
    raw += '\n' + A.pdfPageLabel(p.page) + '\n' + p.lines.join('\n') + '\n';
  }
  return raw;
}

{
  const pages = A.pdfPagesFromDom(docOf(pageEl(1, P1), pageEl(2, P2)));
  const viewerRaw = rawOfViewer(pages);
  const snapRaw = rawOfHtml(A.pdfSnapshotHtml(pages));

  // a selection that spans a line break, which is the interesting one: PDF text
  // is broken into lines by the typesetting, not by the sentence
  const quoteStart = viewerRaw.indexOf('the walk back');
  const quoteEnd = viewerRaw.indexOf('quieter') + 'quieter'.length;
  const anchor = Anchor.buildAnchor(viewerRaw, quoteStart, quoteEnd);
  ok('a quote spanning a PDF line break is captured as one line of prose',
    anchor.quote === 'the walk back to the tram stop was quieter',
    'got ' + JSON.stringify(anchor.quote));

  const found = Anchor.locate(snapRaw, anchor);
  ok('…and re-locates in the snapshot a phone is served', found.ok,
    'reason ' + JSON.stringify(found.reason) + ' in ' + JSON.stringify(snapRaw));
  eq('…on the same words', snapRaw.slice(found.start, found.end).replace(/\s+/g, ' '),
    'the walk back to the tram stop was quieter');

  // and the way back: an anchor built on the phone is findable in the viewer
  const s = snapRaw.indexOf('structural failure');
  const back = Anchor.buildAnchor(snapRaw, s, s + 'structural failure of oversight'.length);
  ok('an anchor made on the phone is findable back in the viewer',
    Anchor.locate(viewerRaw, back).ok);
}

// ---- 4. the record ----------------------------------------------------------
{
  const page = { url: 'https://x.test/p.pdf', title: 'A paper', site: 'x.test', threads: [], page_chat: [] };
  const t = store.addThread(page, { quote: 'a passage', text: 'note', author: 'angadh', page_number: 12 });
  eq('a page number is stored beside the anchor', t.page, 12);
  const plain = store.addThread(page, { quote: 'another', text: 'note', author: 'angadh' });
  eq('an article thread has no page field at all', 'page' in plain, false);
  for (const bad of [0, -3, 1.5, null, undefined, 1e9, 'twelve', {}, [4]]) {
    const x = store.addThread(page, { quote: 'q', text: 'n', author: 'a', page_number: bad });
    eq('a page number that is not one is not stored: ' + JSON.stringify(bad), 'page' in x, false);
  }
  // …but a number that arrived as a string is still a number: a form POST has
  // no other way to send one, and refusing it would only lose the attribution
  eq('a numeric string is accepted',
    store.addThread(page, { quote: 'q', text: 'n', author: 'a', page_number: '12' }).page, 12);

  const rec = {
    url: 'https://x.test/p.pdf', title: 'A paper', site: 'x.test',
    threads: [
      { id: 't1', quote: 'the boredom is the strategy', page: 12,
        msgs: [{ author: 'angadh', ts: 'now', text: 'the whole argument' }] },
      { id: 't2', quote: 'no page here',
        msgs: [{ author: 'angadh', ts: 'now', text: 'an article quote' }] },
    ],
    page_chat: [],
  };
  const note = renderNote(rec, { author: 'angadh' }, new Date('2026-08-10T00:00:00Z'));
  ok('the export attributes the page inside the blockquote',
    note.includes('> the boredom is the strategy\n> — p. 12'), note);
  ok('…and a quote with no page is written exactly as it always was',
    note.includes('> no page here\n\nan article quote'), note);
  const comments = renderNote(rec, { author: 'angadh' }, new Date('2026-08-10T00:00:00Z'), 'comments');
  ok('…in both modes', comments.includes('> — p. 12'));
}

// ---- report -----------------------------------------------------------------
if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' pdf.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
