// pdf-render.test.mjs — the one test that runs REAL PDF.js on a REAL PDF.
//
//   node frontends/plugin/test/pdf-render.test.mjs
//
// Everything else about the web-PDF path is tested against a text layer built
// by hand (pdf.test.mjs, and the harness's ?pdf=1 state), because that is the
// contract the extension actually depends on. This one asks the other question:
// does the vendored copy of PDF.js, loaded exactly as extension/pdf/viewer.html
// loads it, turn a file into that DOM at all?
//
// It drives a headless Chromium over the DevTools protocol rather than with
// `--virtual-time-budget --dump-dom`, and the reason is worth writing down:
// PDF.js parses in a WEB WORKER, and a worker's clock is not advanced by
// virtual time. Under `--virtual-time-budget` the document promise simply never
// resolves and the page dumps empty — which looks exactly like a broken viewer
// and is not one. So: a real clock, a real wait, a real answer.
//
// Skips (exit 0, and says so) when there is no Chromium on this machine —
// a laptop without one should not fail the suite it cannot run.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');            // frontends/plugin
const FIXTURE = 'test/fixtures/two-pages.pdf';
// store.mjs resolves its workspace at import time; a throwaway keeps even an
// accidental write out of the developer's live .botference
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-render-'));
const A = createRequire(import.meta.url)(path.join(ROOT, 'extension', 'adapters.js'));
// the annotation geometry, node-side: the same file the page loads, so the bar
// this test predicts is the bar the viewer would draw
const Annots = createRequire(import.meta.url)(path.join(ROOT, 'extension', 'pdf', 'annots.js'));
const { sanitizeArticle } = await import(path.join(ROOT, 'sanitize.mjs'));
const storeMod = await import(path.join(ROOT, 'store.mjs'));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));

const CHROMES = [
  process.env.BOTFERENCE_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = CHROMES.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!chromePath) {
  console.log('- pdf-render.test.mjs — skipped (no Chromium found; set BOTFERENCE_CHROME)');
  process.exit(0);
}

// ---- a static server over frontends/plugin ---------------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream',
  '.woff2': 'font/woff2', '.icc': 'application/octet-stream' };
// ---- a fixture with somebody else's comments already in it -----------------
// Built here rather than committed, so that what the import is tested against
// is a file whose every annotation this repo can account for — and so that the
// shape of what Acrobat and Preview actually write is written down in code
// rather than trapped in a binary. Three annotations over `two-pages.pdf`:
//
//   a Highlight on page 1, by "adril", over the third line
//   a Text note (a reply, /IRT) under it, by "angadh"
//   a Text note on page 2, by "adril", pinned in the margin beside line one
//
// The fixture's own geometry is known exactly (72pt margin, 14pt type, 18pt
// leading, first baseline at y=720), which is what lets the assertions below
// name the words the marks must land on.
const PDFLib = createRequire(import.meta.url)(path.join(ROOT, 'extension', 'vendor', 'pdf-lib', 'pdf-lib.min.js'));
const ANNOTATED = await (async () => {
  const { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString } = PDFLib;
  const doc = await PDFDocument.load(fs.readFileSync(path.join(ROOT, FIXTURE)));
  const ctx = doc.context;
  const [p1, p2] = doc.getPages();
  const line = y => [72, y - 3, 520, y + 11];        // the box a 14pt line fills
  const mark = ctx.obj({
    Type: 'Annot', Subtype: 'Highlight',
    Rect: line(684).map(v => PDFNumber.of(v)),
    QuadPoints: [72, 695, 520, 695, 72, 681, 520, 681].map(v => PDFNumber.of(v)),
    Contents: PDFHexString.fromText('Is “the tram stop” the right image here?'),
    T: PDFHexString.fromText('adril'),
    M: PDFString.of("D:20260820190606+01'00'"),
    C: [1, 0.9, 0].map(v => PDFNumber.of(v)),
  });
  const markRef = ctx.register(mark);
  mark.set(PDFName.of('P'), p1.ref);
  const reply = ctx.obj({
    Type: 'Annot', Subtype: 'Text',
    Rect: [520, 681, 544, 705].map(v => PDFNumber.of(v)),
    Contents: PDFHexString.fromText('Yes — keep it.'),
    T: PDFHexString.fromText('angadh'),
    M: PDFString.of('D:20260821090000Z'),
    IRT: markRef, RT: PDFName.of('R'),
  });
  const replyRef = ctx.register(reply);
  reply.set(PDFName.of('P'), p1.ref);
  p1.node.addAnnot(markRef);
  p1.node.addAnnot(replyRef);
  const note = ctx.obj({
    Type: 'Annot', Subtype: 'Text',
    Rect: [46, 709, 70, 733].map(v => PDFNumber.of(v)),
    Contents: PDFHexString.fromText('This sentence needs a citation.'),
    T: PDFHexString.fromText('adril'),
    M: PDFString.of("D:20260820191132+01'00'"),
  });
  const noteRef = ctx.register(note);
  note.set(PDFName.of('P'), p2.ref);
  p2.node.addAnnot(noteRef);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
})();

// ---- …and a page whose words are not level ---------------------------------
// A landscape table on a portrait page: the thing that broke, reduced to the
// smallest file that still breaks it. Three column heads set with
// `rotate: degrees(90)`, so their glyphs run bottom-to-top, and two ordinary
// horizontal lines above and below them so that every assertion below has a
// level control beside the turned one.
//
// Built here rather than committed for the reason ANNOTATED is, and for one
// more: the real specimen this was found on is a colleague's unpublished
// manuscript, and no test fixture in this repo is going to be made of somebody
// else's paper.
const ROT_RUN = 'Characterize the debris field';
const ROT_LEVEL = 'An ordinary horizontal line of prose for contrast.';
const ROTATED = await (async () => {
  const { PDFDocument, StandardFonts, degrees } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Table 3 the sideways table', { x: 72, y: 740, size: 14, font });
  const cols = ['Stabilize and control the platform', ROT_RUN, 'Requirements for capture'];
  // x=120/180/240, all starting at y=200 and running UP the page
  cols.forEach((s, i) => page.drawText(s, { x: 120 + i * 60, y: 200, size: 12, font, rotate: degrees(90) }));
  page.drawText(ROT_LEVEL, { x: 72, y: 120, size: 12, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
})();

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+/, '');
  if (rel === 'annotated.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'accept-ranges': 'bytes' }).end(ANNOTATED);
    return;
  }
  if (rel === 'rotated.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'accept-ranges': 'bytes' }).end(ROTATED);
    return;
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                         'accept-ranges': 'bytes' }).end(buf);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;

// ---- headless Chromium, driven over CDP ------------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-pdf-render-'));
// somewhere on disk that is not this repo, for the file: half of the export
// section at the end — a local PDF has to be a real file at a real path
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-local-pdf-'));
const DEBUG_PORT = 9222 + Math.floor(Math.random() * 900);
const chrome = spawn(chromePath, [
  // deliberately the OLD headless: --headless=new hangs in sandboxed shells
  '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking',
  // the export section below drives the viewer on a real file: url, which is
  // the only way to take the LOCAL boot branch (bytes read, hashed, handed to
  // PDF.js). Without this a file: page cannot read the pdf beside it, cannot
  // load its own module graph, and the branch is never entered. Test-only, on
  // a throwaway profile.
  '--allow-file-access-from-files',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => {
  try { chrome.kill(); } catch { /* already gone */ }
  try { server.close(); } catch { /* already closed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* it is a temp dir */ }
  try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* likewise */ }
};
process.on('exit', cleanup);

let targets = null;
for (let i = 0; i < 80 && !targets; i++) {
  await sleep(250);
  try { targets = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json(); }
  catch { targets = null; }
}
const target = (targets || []).find(t => t.type === 'page');
if (!target) {
  console.log('- pdf-render.test.mjs — skipped (Chromium did not open a debuggable page)');
  cleanup();
  process.exit(0);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r && r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
const src = origin + '/' + FIXTURE;
await send('Page.navigate', {
  url: origin + '/extension/pdf/viewer.html?src=' + encodeURIComponent(src),
});

// the render is asynchronous in three hops (module load → worker → text layer),
// so wait for the outcome rather than for a duration
let state = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  state = await evaluate(`(() => {
    const A = window.BFPAdapters;
    if (!A) return null;
    const boxes = document.querySelectorAll('[data-bfp-pdf-page]').length;
    const notice = document.getElementById('notice');
    return {
      ready: boxes >= 2 && document.querySelectorAll('.textLayer span').length > 0,
      boxes,
      title: document.title,
      meta: (document.getElementById('doc-meta') || {}).textContent || '',
      notice: notice && !notice.hidden ? notice.textContent : '',
      pages: A.pdfPagesFromDom(document),
      identity: (A.pick(location.href, {}) || {}).identityHref || '',
      // the boot contract, in a real browser: viewer.js publishes the page
      // identity and only THEN injects the annotator, so both of these are
      // true by the time anything is on screen
      published: window.__BFP_PDF_IDENT || '',
      chain: !!(window.BFPAnchor && window.BFPDrawer),
    };
  })()`);
  if (state && state.ready) break;
}

ok('the viewer renders the PDF at all', !!(state && state.ready),
  'last state ' + JSON.stringify(state));
eq('the identity is published before the annotator is injected',
  state && state.published, src);
ok('…and the annotator was in fact injected, in order', !!(state && state.chain));

if (state && state.ready) {
  eq('every page gets a page box', state.boxes, 2);
  eq('the tab title is the document’s own /Title, not the file name',
    state.title, 'The Quiet Machine: control without possession');
  eq('the bar counts the pages', state.meta, '2 pages');
  eq('nothing is wrong, so nothing is said', state.notice, '');
  eq('the identity is the PDF, not chrome-extension://…', state.identity, src);
  eq('the page numbers are 1-based and in order', state.pages.map(p => p.page), [1, 2]);
  ok('page 1’s prose came through PDF.js intact',
    state.pages[0].lines.join(' ').includes('walk back to the tram stop'),
    JSON.stringify(state.pages[0].lines));
  ok('…and so did page 2’s',
    state.pages[1].lines.join(' ').includes('structural failure of oversight'),
    JSON.stringify(state.pages[1].lines));
  ok('a PDF line is one line, not one span per word', state.pages[0].lines.length === 4,
    JSON.stringify(state.pages[0].lines));

  // ---- the durable-identity pipeline, over a REAL text layer ---------------
  // The local-PDF identity is sha256(pdfNormalizedText(pages)), and adoption
  // recomputes that same hash from the stored snapshot. Run both halves over
  // the lines real PDF.js produced: one character of drift between them and
  // no old record would ever adopt.
  const norm = A.pdfNormalizedText(state.pages);
  ok('a real text layer normalizes to a non-empty string',
    norm.includes('walk back to the tram stop') && !/\s\s/.test(norm));
  const { html: snapHtml } = sanitizeArticle(A.pdfSnapshotHtml(state.pages));
  eq('snapshot → sanitize → snapshotPdfText reproduces the normalized text, on real lines',
    storeMod.snapshotPdfText(snapHtml), norm);
  eq('…so the identity the viewer would mint matches the hash adoption computes',
    A.pdfTextUrl(crypto.createHash('sha256').update(norm, 'utf8').digest('hex')),
    'bfp-pdf://text/' + storeMod.pdfTextHashOf(storeMod.snapshotPdfText(snapHtml)));

  // The whole feature in one expression: capture an anchor across a typeset
  // line break in the REAL text layer, paint it, ask which page it is on, and
  // find it again in the snapshot a phone would be served.
  const trip = await evaluate(`(() => {
    const A = window.BFPAnchor, Ad = window.BFPAdapters;
    const idx = A.buildTextIndex(document.body);
    const s = idx.raw.indexOf('walk back to the tram stop');
    const e = idx.raw.indexOf('quieter than it has been') + 'quieter than it has been'.length;
    if (s < 0 || e < s) return { err: 'the fixture text is not where it should be' };
    const anchor = A.buildAnchor(idx.raw, s, e);
    const marks = A.paintOffsets(idx, s, e, 't-render');
    const page = Ad.pdfPageOfNode(marks[0]);
    const holder = document.createElement('div');
    holder.innerHTML = Ad.pdfSnapshotHtml(Ad.pdfPagesFromDom(document));
    document.body.appendChild(holder);
    const found = A.locate(A.buildTextIndex(holder).raw, anchor);
    const snapIdx = A.buildTextIndex(holder);
    return {
      quote: anchor.quote,
      marks: marks.length,
      inLayer: marks.every(m => !!m.closest('.textLayer')),
      page,
      found: found.ok,
      text: found.ok ? snapIdx.raw.slice(found.start, found.end).replace(/\\s+/g, ' ') : found.reason,
    };
  })()`);

  // ---- geometry: the text layer must sit ON the glyphs --------------------
  //
  // This is the shipped bug this file now guards. PDF.js positions text-layer
  // spans as PERCENTAGES of the page's UNSCALED viewBox and sizes the layer, in
  // CSS, as `--scale-factor × rawDims.pageWidth`. Size the page box from a
  // viewport that has PixelsPerInch.PDF_TO_CSS_UNITS already folded in, hand
  // `--scale-factor` the bare scale, and the layer lays itself out inside a box
  // three-quarters the width of the page it covers: text is still selectable,
  // and every selection rectangle lands somewhere the words are not.
  //
  // Nothing about that is visible to a DOM-shape assertion, which is why it
  // shipped. So the numbers are checked instead, against the fixture's own PDF
  // coordinates: its text begins at x=72pt in a 612pt-wide page, at 14pt.
  const geom = await evaluate(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    function measure(tag) {
      const box = document.querySelector('.bfp-pdf-page');
      const layer = box.querySelector('.textLayer');
      const span = layer.querySelector('span');
      const b = box.getBoundingClientRect(), l = layer.getBoundingClientRect(), s = span.getBoundingClientRect();
      const k = b.width / 612;                       // CSS px per PDF point
      return { tag,
        scaleFactor: +getComputedStyle(box).getPropertyValue('--scale-factor'),
        expectFactor: b.width / 612,
        dW: l.width - b.width, dH: l.height - b.height,
        dLeft: l.left - b.left, dTop: l.top - b.top,
        leftErr: (s.left - b.left) - 72 * k,         // the fixture's own margin
        heightErr: s.height - 14 * k,                // …and its own font size
        boxW: Math.round(b.width) };
    }
    const out = [measure('fit')];
    document.getElementById('zoom-in').click();
    document.getElementById('zoom-in').click();
    await sleep(1200);
    out.push(measure('zoomed'));
    document.getElementById('zoom-fit').click();
    await sleep(1200);
    out.push(measure('refit'));
    return out;
  })()`);

  for (const m of geom || []) {
    ok('[' + m.tag + '] --scale-factor is the page box over the UNSCALED page width',
      Math.abs(m.scaleFactor - m.expectFactor) < 0.002,
      JSON.stringify(m));
    ok('[' + m.tag + '] the text layer is exactly the page box',
      Math.abs(m.dW) <= 1 && Math.abs(m.dH) <= 1 && Math.abs(m.dLeft) <= 1 && Math.abs(m.dTop) <= 1,
      JSON.stringify(m));
    ok('[' + m.tag + '] a span sits where the PDF says its glyphs are',
      Math.abs(m.leftErr) <= 2 && Math.abs(m.heightErr) <= 2, JSON.stringify(m));
  }
  ok('zooming actually changed the scale (so the checks above meant something)',
    (geom || []).length === 3 && geom[1].boxW > geom[0].boxW + 20 && geom[2].boxW === geom[0].boxW,
    JSON.stringify((geom || []).map(g => g.boxW)));

  eq('a quote across a typeset line break is one line of prose',
    trip && trip.quote, 'walk back to the tram stop was quieter than it has been');
  ok('…is painted on every line it covers', trip && trip.marks >= 2, JSON.stringify(trip));
  ok('…inside PDF.js’s own text layer, which is where the words are', !!(trip && trip.inLayer));
  eq('…knows which page it came off', trip && trip.page, 1);
  ok('…and re-locates in the snapshot a phone is served', !!(trip && trip.found));
  eq('…on exactly the same words', trip && trip.text,
    'walk back to the tram stop was quieter than it has been');
}

// ---- the comments the FILE arrived with, read by real PDF.js ---------------
//
// Everything above renders a clean PDF. This renders one that has been through
// somebody else's Acrobat, and asks the question the feature exists for: does
// the viewer find the comments in it, and do they land on the right words?
//
// It is also where the INVARIANT is pinned end to end: the annotated file and
// the plain one are the same document (annotations are not text), so the
// identity the viewer mints for them must be the same string. That is what
// makes an annotated copy keep its chat rather than starting a new one.
const plainNorm = state && state.ready ? A.pdfNormalizedText(state.pages) : '';
await send('Page.navigate', {
  url: origin + '/extension/pdf/viewer.html?src=' + encodeURIComponent(origin + '/annotated.pdf'),
});
let ann = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  ann = await evaluate(`(() => {
    const A = window.BFPAdapters, P = window.__BFP_PDF;
    if (!A || !P) return null;
    const list = P.annots;
    return {
      ready: !!list && list.length > 0 && document.querySelectorAll('.textLayer span').length > 0,
      list,
      pages: A.pdfPagesFromDom(document),
      chain: !!(window.BFPAnchor && window.BFPDrawer),
      notice: (document.getElementById('notice') || {}).hidden === false,
    };
  })()`);
  if (ann && ann.ready) break;
}

ok('a PDF with annotations in it still renders, and the comments are found',
  !!(ann && ann.ready), 'last state ' + JSON.stringify(ann && { ready: ann.ready, n: (ann.list || []).length }));

if (ann && ann.ready) {
  const list = ann.list;
  eq('the file’s three annotations are TWO comments (the reply belongs to its parent)',
    list.length, 2);
  const hl = list.find(c => c.kind === 'Highlight');
  const note = list.find(c => c.kind === 'Text');
  ok('a highlight came through', !!hl, JSON.stringify(list));
  eq('…in its author’s name', hl && hl.author, 'adril');
  eq('…at the moment it was written, in UTC', hl && hl.ts, '2026-08-20T18:06:06.000Z');
  eq('…on the page it is on', hl && hl.page, 1);
  eq('…saying what the popup says', hl && hl.text, 'Is “the tram stop” the right image here?');
  eq('…quoting the words its quads actually cover', hl && hl.quote,
    'stands was flat, and the walk back to the tram stop was');
  ok('…with the line before it as prefix, so it anchors like any other thread',
    !!(hl && hl.prefix && /mood in the/.test(hl.prefix)), JSON.stringify(hl));
  eq('…and Acrobat’s own reply under it, not beside it', hl && hl.replies.length, 1);
  eq('…in the replier’s name', hl && hl.replies[0].author, 'angadh');
  eq('…and words', hl && hl.replies[0].text, 'Yes — keep it.');
  ok('a sticky note came through too', !!note);
  eq('…on its own page', note && note.page, 2);
  eq('…quoting the line it is pinned beside', note && note.quote,
    'The report called it a structural failure of oversight,');
  ok('…and every comment has an id to be filed under',
    list.every(c => /^[0-9a-f]{16}$/.test(String(c.id || ''))), JSON.stringify(list.map(c => c.id)));
  ok('…the two of them different ones', list[0].id !== list[1].id);

  eq('THE INVARIANT: an annotated copy is the same document, so the same identity',
    A.pdfNormalizedText(ann.pages), plainNorm);
  ok('…and that identity is a real one, not two empty strings agreeing',
    plainNorm.includes('walk back to the tram stop'));

  // ---- and back out again --------------------------------------------------
  // The round trip in one expression: take the comment that was IN the file,
  // make the thread Discuss would make of it, paint it the way the annotator
  // paints every thread, and ask the export what it would write. The quads it
  // answers with must land back on the passage the original mark covered.
  const trip = await evaluate(`(async () => {
    const An = window.BFPAnchor, P = window.__BFP_PDF;
    const c = P.annots.find(a => a.kind === 'Highlight');
    const idx = An.buildTextIndex(document.body);
    const at = idx.raw.indexOf(c.quote);
    if (at < 0) return { err: 'the imported quote is not in the document' };
    An.paintOffsets(idx, at, at + c.quote.length, 'imported-1');
    const at2 = idx.raw.indexOf('structural failure of oversight');
    if (at2 < 0) return { err: 'the second passage is not in the document' };
    An.paintOffsets(idx, at2, at2 + 'structural failure of oversight'.length, 'filed-1');
    const out = await P.collect([{
      id: 'imported-1', quote: c.quote,
      origin: { system: 'pdf-annot', id: c.id },
      msgs: [
        { author: c.author, ts: c.ts, text: c.text, origin: { system: 'pdf-annot', id: c.id } },
        { author: 'claude', ts: '2026-08-25T10:00:00Z', text: 'It is the right image.' },
      ],
    }, {
      id: 'untouched-1', quote: c.quote,
      origin: { system: 'pdf-annot', id: 'deadbeefdeadbeef' },
      msgs: [{ author: c.author, ts: c.ts, text: c.text }],
    }, {
      // grown, placeable, painted — and FILED. The copy is for somebody else
      // to read, and a settled argument is not theirs to re-open.
      id: 'filed-1', quote: 'structural failure of oversight',
      resolved: true, resolved_by: 'angadh',
      msgs: [
        { author: 'angadh', ts: '2026-08-25T09:00:00Z', text: 'Is oversight the word?' },
        { author: 'claude', ts: '2026-08-25T10:00:00Z', text: 'Settled: the image stays.' },
      ],
    }]);
    return { out, quote: c.quote };
  })()`);

  ok('a thread whose conversation has grown is written back', !!(trip && trip.out && trip.out.items.length >= 1),
    JSON.stringify(trip));
  eq('…and one that is still only what the file already said is NOT',
    trip && trip.out && trip.out.already, 1);
  eq('…nor is a filed one, however grown and however placeable',
    trip && trip.out && trip.out.filed, 1);
  ok('…and what it settled is nowhere in what would be written',
    !(trip.out.items || []).some(i => /Settled: the image stays\./.test(i.contents || '')),
    JSON.stringify(trip.out.items));
  eq('…so only the live thread is a candidate at all',
    trip && trip.out && trip.out.items.length, 1);
  eq('…and nothing is reported as unplaceable — filing is not a failure to place',
    trip && trip.out && trip.out.orphaned, 0);
  const item = trip && trip.out && trip.out.items[0];
  eq('…onto the page the passage is on', item && item.page, 1);
  ok('…with the whole discussion in the popup, the bot included',
    !!(item && /It is the right image\./.test(item.contents)), item && item.contents);
  // the fixture's own coordinates: the third line of page 1, 72pt in, around
  // y=684. This is the assertion that the two directions agree about WHERE.
  const box = (item && item.quads || []).reduce((r, q) => [
    Math.min(r[0], q[0]), Math.min(r[1], q[1]), Math.max(r[2], q[2]), Math.max(r[3], q[3]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  ok('…and quads that land back on the words the original mark covered',
    Math.abs(box[0] - 72) < 6 && Math.abs(box[1] - 681) < 8 && Math.abs(box[3] - 695) < 8,
    'got ' + JSON.stringify(box.map(v => Math.round(v))) + ' want ~[72,681,…,695]');

  // ---- and the writer, in the browser it actually runs in ------------------
  // The node suite writes the file with the same code, but through
  // createRequire; this is the half that can only be checked here — that the
  // vendored UMD build loads as a classic script beside the annotator, writes
  // in the page, and that what it wrote re-parses in the SAME tab with the
  // vendored pdf.js: the original comments still there, the new one beside
  // them, and not a word of the document changed.
  const wrote = await evaluate(`(async () => {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/extension/vendor/pdf-lib/pdf-lib.min.js';
      s.onload = res; s.onerror = () => rej(new Error('pdf-lib did not load'));
      document.head.appendChild(s);
    });
    const A = window.BFPPdfAnnots;
    if (!A || !window.PDFLib) return { err: 'no writer in the page' };
    const src = new Uint8Array(await (await fetch('/annotated.pdf')).arrayBuffer());
    const out = await A.writeAnnots(window.PDFLib, src, [{
      page: 1, quads: [[72, 681, 520, 695]],
      contents: 'angadh · 25 Aug 2026, 12:00:\\nWritten back from Discuss.',
      author: 'angadh', ts: '2026-08-25T12:00:00Z', name: 'bfp-roundtrip',
      color: [1, 0.83, 0.25], subject: 'Discuss',
    }]);
    const pdfjs = await import('/extension/vendor/pdfjs/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/extension/vendor/pdfjs/build/pdf.worker.min.mjs';
    const read = async bytes => {
      const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
      const comments = [];
      const words = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        for (const a of await page.getAnnotations({ intent: 'display' })) {
          const t = (a.contentsObj && a.contentsObj.str) || '';
          if (t) comments.push({ page: n, author: (a.titleObj || {}).str || '', text: t });
        }
        words.push((await page.getTextContent()).items.map(i => i.str).join(''));
      }
      return { comments, words: words.join('\\n') };
    };
    const before = await read(new Uint8Array(src));
    const after = await read(new Uint8Array(out.bytes));
    return { written: out.written, grew: out.bytes.length > src.length, before, after };
  })()`);

  ok('the writer loads and runs in the browser', !!(wrote && wrote.written === 1),
    JSON.stringify(wrote && wrote.err));
  ok('…producing a bigger file, not a replaced one', !!(wrote && wrote.grew));
  eq('the annotations the file already had are still there',
    wrote && wrote.after.comments.length, wrote && wrote.before.comments.length + 1);
  ok('…including the supervisor’s, untouched',
    !!(wrote && wrote.after.comments.some(c => c.author === 'adril'
      && /right image here/.test(c.text))), JSON.stringify(wrote && wrote.after.comments));
  ok('…and the discussion beside them, readable by an ordinary PDF reader',
    !!(wrote && wrote.after.comments.some(c => c.author === 'angadh'
      && /Written back from Discuss\./.test(c.text))));
  eq('THE INVARIANT again, at the bytes: the words of the document did not move',
    wrote && wrote.after.words, wrote && wrote.before.words);
}

// ---- THE EXPORT, END TO END, THROUGH THE VIEWER'S OWN DOOR -----------------
//
// Everything above builds the writer's input by hand — `fetch('/annotated.pdf')`
// in the page — which is a fine test of the WRITER and no test at all of where
// the bytes come from. That gap shipped a bug: `exportAnnotated()` dies on
// every LOCAL pdf with "Cannot perform Construct on a detached ArrayBuffer".
//
// The mechanism is worth writing down, because nothing about it is visible to
// a DOM-shape assertion. A local file is read once at boot (its bytes are its
// identity) and handed to `getDocument({data})`. pdf.js posts that data to its
// worker AS A TRANSFERABLE — literally `sendWithPromise("GetDocRequest", …,
// [r.buffer])` in the vendored build — which DETACHES the ArrayBuffer on this
// side. The export then built a second `Uint8Array` over the corpse. The web
// path never had the bug (PDF.js is given a url, not bytes), which is exactly
// why an http-only test stayed green through it.
//
// So this runs the real `exportAnnotated()` — real PDF.js, real pdf-lib, real
// `sourceBytes()` — on BOTH kinds of document, and gates ONLY the Save dialog,
// because a file picker is the one thing headless Chrome cannot answer. What
// it captures is then re-parsed in the same tab: bytes that came from a
// detached or truncated buffer do not become a readable PDF.
//
// The local half needs `--allow-file-access-from-files` (above) and a real
// file: url, since a file read from an http page is blocked by the browser and
// the LOCAL branch would never be taken.
const localPdf = path.join(localDir, 'the-quiet-machine.pdf');
fs.writeFileSync(localPdf, ANNOTATED);

// Stage a thread over a real quote, paint it the way the annotator paints
// every thread, stub the picker, and press the button.
const exportProbe = (quote, quote2) => `(async () => {
  const An = window.BFPAnchor, P = window.__BFP_PDF;
  if (!An || !P) return { err: 'the annotator did not load on this page' };
  const idx = An.buildTextIndex(document.body);
  const at = idx.raw.indexOf(${JSON.stringify(quote)});
  if (at < 0) return { err: 'the fixture text is not where it should be' };
  An.paintOffsets(idx, at, at + ${JSON.stringify(quote)}.length, 't-export');
  // A SECOND thread beside it, on its own passage, filed. A mixed page is the
  // real case: the copy must carry the live one and only the live one.
  const at2 = idx.raw.indexOf(${JSON.stringify(quote2)});
  if (at2 < 0) return { err: 'the second fixture passage is not where it should be' };
  An.paintOffsets(idx, at2, at2 + ${JSON.stringify(quote2)}.length, 't-filed');
  // content.js does not publish window.__bfp on a page with no extension
  // behind it, so the record it would have held is staged at the same seam
  // exportAnnotated reads it from — and nowhere else is stubbed.
  window.__bfp = { page: { threads: [{
    id: 't-export', quote: ${JSON.stringify(quote)}, mark: 'strike',
    msgs: [{ author: 'angadh', ts: '2026-08-25T12:00:00Z', text: 'This should come out.' }],
  }, {
    id: 't-filed', quote: ${JSON.stringify(quote2)}, resolved: true, resolved_by: 'angadh',
    msgs: [{ author: 'angadh', ts: '2026-08-25T12:05:00Z', text: 'This one is settled already.' }],
  }] } };
  let captured = null, asked = null;
  window.showSaveFilePicker = async o => {
    asked = o;
    return { name: o.suggestedName,
             createWritable: async () => ({ write: b => { captured = b; }, close: async () => {} }) };
  };
  let r;
  try { r = await P.exportAnnotated(); }
  catch (e) { return { err: 'export threw: ' + ((e && e.message) || e) }; }
  if (!r || r.ok === false) return { r, err: 'export refused: ' + (r && r.error) };
  // …and the proof that the bytes were live and whole: read the copy back with
  // the same vendored pdf.js, in this tab.
  const pdfjs = await import('/*PDFJS*/');
  pdfjs.GlobalWorkerOptions.workerSrc = '/*WORKER*/';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(captured), isEvalSupported: false }).promise;
  const comments = [], words = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    for (const a of await page.getAnnotations({ intent: 'display' })) {
      const t = (a.contentsObj && a.contentsObj.str) || '';
      if (t) comments.push({ page: n, author: (a.titleObj || {}).str || '', text: t, subtype: a.subtype });
    }
    words.push((await page.getTextContent()).items.map(i => i.str).join(''));
  }
  return { r, suggested: asked && asked.suggestedName, bytes: captured ? captured.byteLength : 0,
           pages: doc.numPages, comments, words: words.join('\\n') };
})()`;

const QUOTE = 'walk back to the tram stop';
const FILED_QUOTE = 'structural failure of oversight';
for (const kind of ['web', 'local']) {
  const base = kind === 'local'
    ? 'file://' + path.join(ROOT, 'extension/pdf/viewer.html')
    : origin + '/extension/pdf/viewer.html';
  const docSrc = kind === 'local' ? 'file://' + localPdf : origin + '/annotated.pdf';
  const pdfjsUrl = kind === 'local'
    ? 'file://' + path.join(ROOT, 'extension/vendor/pdfjs/build/pdf.min.mjs')
    : '/extension/vendor/pdfjs/build/pdf.min.mjs';
  const workerUrl = kind === 'local'
    ? 'file://' + path.join(ROOT, 'extension/vendor/pdfjs/build/pdf.worker.min.mjs')
    : '/extension/vendor/pdfjs/build/pdf.worker.min.mjs';
  await send('Page.navigate', { url: base + '?src=' + encodeURIComponent(docSrc) });

  let up = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    up = await evaluate(`(() => ({
      spans: document.querySelectorAll('.textLayer span').length,
      chain: !!(window.BFPAnchor && window.__BFP_PDF),
      ident: window.__BFP_PDF_IDENT || '',
      notice: (document.getElementById('notice') || {}).hidden === false
        ? document.getElementById('notice').textContent.slice(0, 120) : '',
    }))()`);
    if (up && (up.spans > 0 || up.notice)) break;
  }
  ok('[' + kind + '] the viewer renders it and the annotator is up',
    !!(up && up.spans > 0 && up.chain), JSON.stringify(up));
  // the local boot is the one that reads bytes, hashes them and mints a
  // text identity — if it fell back to anything else the branch under test
  // was never taken and the assertions below would be worthless
  if (kind === 'local') {
    ok('[local] …by the LOCAL boot, which is the branch that reads the bytes',
      !!(up && /^bfp-pdf:\/\/text\//.test(up.ident)), JSON.stringify(up && up.ident));
  }

  if (up && up.spans > 0) {
    const out = await evaluate(exportProbe(QUOTE, FILED_QUOTE)
      .replace('/*PDFJS*/', pdfjsUrl).replace('/*WORKER*/', workerUrl));
    ok('[' + kind + '] the export runs to the end and writes the copy',
      !!(out && !out.err && out.r && out.r.ok === true), JSON.stringify(out && (out.err || out.r)));
    if (out && !out.err) {
      ok('[' + kind + '] …into the place the reader picked, not the downloads folder',
        out.r.picked === true, JSON.stringify(out.r));
      ok('[' + kind + '] …named so it cannot overwrite the file it was made from',
        / \(discussed\)\.pdf$/.test(String(out.suggested || '')), String(out.suggested));
      ok('[' + kind + '] …carrying the thread that was on screen', out.r.written === 1,
        JSON.stringify(out.r));
      // a MIXED page: one live thread, one filed. Only the live one travels.
      ok('[' + kind + '] …and only that one — the filed thread beside it is not written',
        out.r.filed === 1 && out.r.written === 1, JSON.stringify(out.r));
      ok('[' + kind + '] …and is not counted as a failure to place, because it is not one',
        (out.r.orphaned || 0) === 0, JSON.stringify(out.r));
      // THE ASSERTION THIS SECTION EXISTS FOR: a copy built from detached or
      // half-read source bytes is not a PDF, and does not still contain the
      // document it was made from.
      eq('[' + kind + '] …and the copy re-parses as the whole document', out.pages, 2);
      ok('[' + kind + '] …with the supervisor’s own comments still in it',
        out.comments.some(c => c.author === 'adril' && /right image here/.test(c.text)),
        JSON.stringify(out.comments));
      ok('[' + kind + '] …the new one beside them, struck as a suggested deletion',
        out.comments.some(c => /This should come out\./.test(c.text) && c.subtype === 'StrikeOut'),
        JSON.stringify(out.comments));
      ok('[' + kind + '] …the settled one nowhere in the copy at all',
        !out.comments.some(c => /This one is settled already\./.test(c.text)),
        JSON.stringify(out.comments));
      ok('[' + kind + '] …and not a word of the document changed',
        out.words.includes(QUOTE) && out.words.includes('structural failure of oversight'));
    }
  }
}

// ---- and the reader who says no --------------------------------------------
// A cancelled Save dialog must write nothing and download nothing. It is the
// branch where an over-helpful fallback would quietly put a file somewhere the
// reader had just declined to put it.
const cancelled = await evaluate(`(async () => {
  const P = window.__BFP_PDF;
  let downloads = 0;
  const realCreate = document.createElement.bind(document);
  document.createElement = tag => {
    const el = realCreate(tag);
    if (String(tag).toLowerCase() === 'a') {
      const realClick = el.click.bind(el);
      el.click = () => { if (el.hasAttribute('download')) downloads++; else realClick(); };
    }
    return el;
  };
  window.showSaveFilePicker = async () => {
    const e = new Error('The user aborted a request.');
    e.name = 'AbortError';
    throw e;
  };
  let r;
  try { r = await P.exportAnnotated(); }
  catch (e) { return { err: 'export threw: ' + ((e && e.message) || e) }; }
  document.createElement = realCreate;
  return { r, downloads };
})()`);
ok('cancelling the Save dialog is a decision, not a failure',
  !!(cancelled && cancelled.r && cancelled.r.ok === true && cancelled.r.cancelled === true),
  JSON.stringify(cancelled));
eq('…and nothing is downloaded behind the reader’s back', cancelled && cancelled.downloads, 0);

// ---- a page where every argument is settled ---------------------------------
// Nothing to write, and the refusal must say WHY. "None of these could be
// placed" would be a lie: they placed perfectly, they are simply not going.
// The Save dialog must never open either — a copy identical to the original is
// not a copy worth asking the reader for a folder for.
const allFiled = await evaluate(`(async () => {
  const P = window.__BFP_PDF;
  // the same two threads the export above wrote from, still painted where they
  // were — filed, both of them, and nothing else has changed
  window.__bfp = { page: { threads: [{
    id: 't-export', quote: ${JSON.stringify(QUOTE)}, mark: 'strike', resolved: true,
    msgs: [{ author: 'angadh', ts: '2026-08-25T12:00:00Z', text: 'This should come out.' }],
  }, {
    id: 't-filed', quote: ${JSON.stringify(FILED_QUOTE)}, resolved: true,
    msgs: [{ author: 'angadh', ts: '2026-08-25T12:05:00Z', text: 'This one is settled already.' }],
  }] } };
  let asked = false;
  window.showSaveFilePicker = async () => { asked = true; throw new Error('should never be reached'); };
  let r;
  try { r = await P.exportAnnotated(); }
  catch (e) { return { err: 'export threw: ' + ((e && e.message) || e) }; }
  return { r, asked };
})()`);
ok('a page with nothing but filed threads writes no copy',
  !!(allFiled && allFiled.r && allFiled.r.ok === false), JSON.stringify(allFiled));
eq('…and says why, rather than blaming the anchors',
  allFiled && allFiled.r && allFiled.r.error,
  'every comment here is resolved or already in the file');
eq('…without ever opening a Save dialog for a file it was not going to write',
  allFiled && allFiled.asked, false);


// ---- the picture of a page --------------------------------------------------
// The whole seam, end to end, on a REAL rendering: the viewer draws page 1 to
// an offscreen canvas, the bytes come back here, the store files them where an
// envelope will name them, and the file on disk is a PNG that really does open.
// A live bridge is the one thing this machine cannot stand up in a test, so the
// assertion stops exactly where the CLI would pick it up: the path the envelope
// prints exists and is an image.
const shot = await evaluate(`(async () => {
  const P = window.__BFP_PDF;
  if (!P || typeof P.capture !== 'function') return { err: 'no capture seam' };
  const s = await P.capture(1);
  const none = await P.capture(99);
  return { s, none };
})()`);
ok('the viewer can render a page to an image', !!(shot && shot.s && shot.s.data),
  JSON.stringify(shot && shot.err));
eq('…a page that does not exist is not invented', shot && shot.none, null);
if (shot && shot.s && shot.s.data) {
  const s = shot.s;
  eq('…it is the page that was asked for', s.page, 1);
  eq('…encoded as a PNG', s.ext, 'png');
  ok('…at a legible size, and no larger than it needs to be',
    Math.max(s.w, s.h) > 1000 && Math.max(s.w, s.h) <= 1700, s.w + 'x' + s.h);
  const buf = Buffer.from(s.data, 'base64');
  ok('…real PNG bytes', buf.length > 1000 && buf.slice(1, 4).toString() === 'PNG', 'bytes ' + buf.length);
  ok('…and not a blank sheet: a drawn page compresses to more than a solid colour',
    buf.length > 4000, 'bytes ' + buf.length);
  // where the envelope will look for it
  const url = 'bfp-pdf://text/' + 'a'.repeat(64);
  storeMod.upsertPage({ url, title: 'two pages', site: 'local pdf', kind: 'pdf' });
  const w = storeMod.savePageImage(url, 1, buf, s.ext);
  ok('the store files it where the turn will name it', w.stored && fs.existsSync(w.file));
  eq('…and that is the path the envelope resolves',
    storeMod.findPageImage(storeMod.pageKey(url), 1), w.file);
  const chatMod = await import(path.join(ROOT, 'chat.mjs'));
  ok('…which the envelope prints in full', chatMod.figureBlock({
    pageImage: storeMod.findPageImage(storeMod.pageKey(url), 1), paged: true, pageNumber: 1,
  }).includes(w.file));
  ok('…and the file it names is on disk, an image, and readable by anything that opens PNGs',
    fs.readFileSync(w.file).slice(1, 4).toString() === 'PNG');
}

// ---- THE SIDEWAYS TABLE ----------------------------------------------------
//
// A landscape table rotated onto a portrait page. Three separate layers can be
// wrong about it and only one of them was, which is why this section checks
// all three by name.
//
//   PAINT     the strike's band is a gradient in the MARK's own box, and the
//             mark sits inside a span the text layer has already rotated — so
//             the band comes along and runs through the words. This was always
//             right, and is asserted so it stays right.
//   EXPORT    the quads were built from getClientRects(), which answers with
//             axis-aligned boxes and therefore describes a bottom-to-top run
//             as a tall thin rectangle. Acrobat, told "here is a box", struck
//             it out across the middle: a short red dash at right angles to
//             the sentence being deleted. THIS was the bug.
//   TURNING   and the reader's own answer to a sideways table, which is to
//             turn the page — checked here because turning must not disturb
//             either of the two above.
await send('Page.navigate', {
  url: origin + '/extension/pdf/viewer.html?src=' + encodeURIComponent(origin + '/rotated.pdf'),
});
let rot = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  rot = await evaluate(`(() => ({
    spans: document.querySelectorAll('.textLayer span').length,
    chain: !!(window.BFPAnchor && window.__BFP_PDF),
  }))()`);
  if (rot && rot.spans > 0) break;
}
ok('[rotated] the sideways page renders and the annotator is up',
  !!(rot && rot.spans > 0 && rot.chain), JSON.stringify(rot));

// A real drag, in real screen coordinates — the only way to ask what a reader
// dragging across these words actually gets.
async function drag(x0, y0, x1, y1, steps) {
  const n = steps || 16;
  // Let go of whatever was selected last. A mousedown INSIDE an existing
  // selection starts a drag-and-drop of that text, not a new selection, and a
  // test that forgot this measures the browser's drag handler instead of its
  // selection.
  await evaluate('window.getSelection().removeAllRanges()');
  const at = (a, b, i) => a + (b - a) * (i / n);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(30);
  for (let i = 1; i <= n; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at(x0, x1, i), y: at(y0, y1, i), button: 'left', buttons: 1 });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(60);
  return evaluate(`String(window.getSelection())`);
}
// Where the run is on screen right now, and which way it lies. Scrolled into
// the middle of the window first: a mouse event dispatched at a y below the
// window is dispatched at nothing, and "the selection came back empty" would
// then be a fact about the test's window rather than about rotated text.
const runBox = () => evaluate(`(() => {
  const s = [...document.querySelectorAll('.textLayer span')].find(x => x.textContent === ${JSON.stringify(ROT_RUN)});
  if (!s) return null;
  s.scrollIntoView({ block: 'center', inline: 'center' });
  const r = s.getBoundingClientRect();
  return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2,
           rotate: getComputedStyle(s).getPropertyValue('--rotate').trim() };
})()`);

if (rot && rot.spans > 0) {
  const before = await runBox();
  eq('[rotated] the text layer says so: the run carries a quarter turn of its own',
    before && before.rotate, '-90deg');
  ok('[rotated] …and stands up on screen — taller than it is wide',
    !!(before && before.h > before.w * 3), JSON.stringify(before));

  // ---- 0. THE WORDS THEMSELVES ---------------------------------------------
  // Before any of the geometry: does a sideways run survive as TEXT? This is
  // what the bots read, what a phone reads, and what a `passage:` suggestion is
  // located in — and if a turned run came out of the text layer chopped up or
  // interleaved with its neighbours, none of the rest would be worth fixing.
  //
  // It survives, and the reason is worth knowing: a rotated run is ONE text
  // item in the file and therefore one span in the layer, so it is contiguous
  // however the page is turned. What is NOT preserved is which visual COLUMN a
  // cell belongs to — the order is the order the file drew the cells in, which
  // for a table is row by row. That is inherent, and the limitation is written
  // down in SPEC.md rather than papered over here.
  const words = await evaluate(`(() => {
    const Ad = window.BFPAdapters, An = window.BFPAnchor;
    const pages = Ad.pdfPagesFromDom(document);
    const holder = document.createElement('div');
    holder.innerHTML = Ad.pdfSnapshotHtml(pages);
    document.body.appendChild(holder);
    const snap = An.buildTextIndex(holder);
    const idx = An.buildTextIndex(document.body);
    const at = idx.raw.indexOf(${JSON.stringify(ROT_RUN)});
    const anchor = at < 0 ? null : An.buildAnchor(idx.raw, at, at + ${JSON.stringify(ROT_RUN)}.length);
    const found = anchor ? An.locate(snap.raw, anchor) : null;
    holder.remove();
    return {
      lines: pages[0].lines,
      whole: pages[0].lines.includes(${JSON.stringify(ROT_RUN)}),
      found: !!(found && found.ok),
      text: found && found.ok ? snap.raw.slice(found.start, found.end) : (found && found.reason),
      prefix: anchor && anchor.prefix, suffix: anchor && anchor.suffix,
    };
  })()`);
  ok('[rotated] a sideways run comes out of the text layer whole, not in pieces',
    !!(words && words.whole), JSON.stringify(words && words.lines));
  ok('[rotated] …so an anchor made on it is found again in the snapshot a phone reads',
    !!(words && words.found), JSON.stringify(words));
  eq('[rotated] …quoting the same words', words && words.text, ROT_RUN);
  ok('[rotated] …with a sane prefix and suffix, which is what a bot’s passage lands by',
    !!(words && /platform/.test(words.prefix || '') && /Requirements/.test(words.suffix || '')),
    JSON.stringify(words));

  // ---- 1. PAINT ------------------------------------------------------------
  const paint = await evaluate(`(() => {
    const A = window.BFPAnchor;
    const idx = A.buildTextIndex(document.body);
    const at = idx.raw.indexOf(${JSON.stringify(ROT_RUN)});
    if (at < 0) return { err: 'the rotated run is not in the index' };
    const marks = A.paintOffsets(idx, at, at + ${JSON.stringify(ROT_RUN)}.length, 'rot-strike', null, 'strike');
    const m = marks[0];
    if (!m) return { err: 'nothing was painted' };
    const cs = getComputedStyle(m);
    const r = m.getBoundingClientRect();
    return {
      marks: marks.length,
      struck: m.classList.contains('bfp-strike'),
      // the mark's OWN box, before any ancestor transform: this is the space
      // the gradient's 55% is measured in
      localW: m.offsetWidth, localH: m.offsetHeight,
      ownTransform: cs.transform,
      band: cs.backgroundImage,
      screenW: r.width, screenH: r.height,
      inRotatedSpan: (() => { const s = m.closest('span'); return s ? getComputedStyle(s).getPropertyValue('--rotate').trim() : ''; })(),
    };
  })()`);
  eq('[rotated] the struck run paints as one mark', paint && paint.marks, 1);
  ok('[rotated] …with the strike band on it', !!(paint && paint.struck && /linear-gradient/.test(paint.band || '')),
    JSON.stringify(paint));
  // THE PAINT ASSERTION. The band is `to bottom` at 55% of the mark's own box,
  // and the mark's own box is WIDE — the run is only stood up by the span
  // above it. So the 55% line crosses the box's short axis, which is across
  // the letters and along the words, and the ancestor's rotation carries it
  // onto the glyphs. A band drawn from the SCREEN rectangle instead (tall and
  // thin) would be a 2px dash across one letter.
  ok('[rotated] …drawn in the mark’s own un-turned box, which is wide',
    !!(paint && paint.localW > paint.localH * 3), JSON.stringify(paint));
  eq('[rotated] …because the mark itself is not transformed — the span above it is',
    paint && paint.ownTransform, 'none');
  eq('[rotated] …by exactly the quarter turn the file drew the words at',
    paint && paint.inRotatedSpan, '-90deg');
  ok('[rotated] …so on screen the same mark is tall and thin: the band runs ALONG the words',
    !!(paint && paint.screenH > paint.screenW * 3), JSON.stringify(paint));

  // ---- 2. EXPORT -----------------------------------------------------------
  // The numbers, in PDF user space. The fixture's own geometry is known: the
  // run was drawn at x=180, from y=200, at 12pt, turned a quarter turn — so
  // its quad must be about 14pt across and about 149pt long, and the long side
  // must lie along the PAGE'S Y AXIS. An axis-aligned box would have the same
  // extent and no way to say which of its sides the words run down.
  const quads = await evaluate(`(async () => {
    const A = window.BFPAnchor, P = window.__BFP_PDF;
    const idx = A.buildTextIndex(document.body);
    const at2 = idx.raw.indexOf(${JSON.stringify(ROT_LEVEL)});
    A.paintOffsets(idx, at2, at2 + ${JSON.stringify(ROT_LEVEL)}.length, 'rot-level', null, 'strike');
    const out = await P.collect([
      { id: 'rot-strike', quote: ${JSON.stringify(ROT_RUN)}, mark: 'strike',
        msgs: [{ author: 'angadh', ts: '2026-08-29T09:00:00Z', text: 'This column head should go.' }] },
      { id: 'rot-level', quote: ${JSON.stringify(ROT_LEVEL)}, mark: 'strike',
        msgs: [{ author: 'angadh', ts: '2026-08-29T09:01:00Z', text: 'And this level line.' }] },
    ]);
    return out;
  })()`);
  const turnedItem = (quads && quads.items || []).find(i => /column head/.test(i.contents || ''));
  const levelItem = (quads && quads.items || []).find(i => /level line/.test(i.contents || ''));
  eq('[rotated] both threads are placeable', quads && quads.orphaned, 0);
  eq('[rotated] a LEVEL line is still four numbers — an ordinary paper’s file does not change',
    levelItem && levelItem.quads[0].length, 4);
  eq('[rotated] …and a turned one is eight: four corners, which is what a QuadPoint is',
    turnedItem && turnedItem.quads[0].length, 8);
  if (turnedItem && turnedItem.quads[0].length === 8) {
    const q = turnedItem.quads[0];
    const run = [q[2] - q[0], q[3] - q[1]];         // UL → UR: along the words
    const across = [q[4] - q[0], q[5] - q[1]];      // UL → LL: the line's height
    const len = Math.hypot(run[0], run[1]);
    const thick = Math.hypot(across[0], across[1]);
    ok('[rotated] …whose long side runs the length of the words (~149pt at 12pt type)',
      len > 130 && len < 170, 'len ' + len.toFixed(2) + ' of ' + JSON.stringify(q.map(v => +v.toFixed(2))));
    ok('[rotated] …and whose short side is one line high (~14pt)',
      thick > 10 && thick < 20, 'thick ' + thick.toFixed(2));
    // THE ASSERTION THE BUG WAS: the run lies along the page's Y axis, and the
    // file now says so. Before, both directions were lost to a bounding box.
    ok('[rotated] …and the words run UP THE PAGE, not across it',
      Math.abs(run[0]) < 2 && Math.abs(run[1]) > 130,
      'run ' + JSON.stringify(run.map(v => +v.toFixed(2))));
    ok('[rotated] …with the line’s height across the page, at right angles to it',
      Math.abs(across[1]) < 2 && Math.abs(across[0]) > 10,
      'across ' + JSON.stringify(across.map(v => +v.toFixed(2))));
    // WHICH CORNER IS WHICH, not merely which way the quad lies. Turned a
    // quarter this way, the glyphs' ascenders point toward SMALLER x and the
    // baseline sits at larger x (the run was drawn at x=180 and the quad runs
    // 169→183). So UL — the ascender side — must be the small-x corner. Get
    // this backwards and every number above still passes while the strikeout
    // bar lands at 58% of the line instead of 42%: a red rule along the tops
    // of the letters rather than through them.
    ok('[rotated] …and UL is the ascender side, so the bar knows where the baseline is',
      q[0] < q[4] - 5, 'UL.x ' + q[0].toFixed(2) + ' LL.x ' + q[4].toFixed(2));
    // …which is exactly what strikeQuad then does with it
    const bar = Annots.strikeQuad([[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]);
    const barX = (bar[0][0] + bar[2][0]) / 2;
    ok('[rotated] …and the bar it makes sits at the middle of the x-height, near the baseline',
      barX > (q[0] + q[4]) / 2, 'bar at x ' + barX.toFixed(2)
      + ' between ascender ' + q[0].toFixed(2) + ' and baseline ' + q[4].toFixed(2));
    // and it is where the run actually is: drawn at x=180, from y=200 upward
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    ok('[rotated] …on the words themselves, not somewhere near them',
      Math.min(...xs) > 165 && Math.max(...xs) < 190
      && Math.min(...ys) > 195 && Math.max(...ys) < 355,
      JSON.stringify(q.map(v => +v.toFixed(2))));
  }

  // ---- 3. …and what a PDF reader gets ---------------------------------------
  // Written, re-parsed, and read back: a StrikeOut whose QuadPoints are NOT an
  // upright rectangle, and an appearance stream that draws its bar as a PATH
  // (`re` cannot say "rectangle, turned") — while the level line beside it is
  // still one `re`, exactly as it always was.
  const reparse = await evaluate(`(async () => {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/extension/vendor/pdf-lib/pdf-lib.min.js';
      s.onload = res; s.onerror = () => rej(new Error('pdf-lib did not load'));
      document.head.appendChild(s);
    });
    const A = window.BFPPdfAnnots, P = window.__BFP_PDF;
    const got = await P.collect([
      { id: 'rot-strike', quote: ${JSON.stringify(ROT_RUN)}, mark: 'strike',
        msgs: [{ author: 'angadh', ts: '2026-08-29T09:00:00Z', text: 'turned' }] },
      { id: 'rot-level', quote: ${JSON.stringify(ROT_LEVEL)}, mark: 'strike',
        msgs: [{ author: 'angadh', ts: '2026-08-29T09:01:00Z', text: 'level' }] },
    ]);
    const src = new Uint8Array(await (await fetch('/rotated.pdf')).arrayBuffer());
    const out = await A.writeAnnots(window.PDFLib, src, got.items);
    const pdfjs = await import('/extension/vendor/pdfjs/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/extension/vendor/pdfjs/build/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: new Uint8Array(out.bytes), isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const annots = (await page.getAnnotations({ intent: 'display' })).map(a => ({
      subtype: a.subtype,
      text: (a.contentsObj && a.contentsObj.str) || '',
      quadPoints: a.quadPoints ? JSON.parse(JSON.stringify(a.quadPoints)) : null,
    }));
    // …and the ink itself, read straight out of the file's bytes
    const raw = new TextDecoder('latin1').decode(out.bytes);
    return { written: out.written, annots,
             paths: (raw.match(/\\bh f\\b/g) || []).length,
             rawQuads: (raw.match(/\\/QuadPoints\\s*\\[[^\\]]*\\]/g) || []),
             words: (await page.getTextContent()).items.map(i => i.str).join('') };
  })()`);
  eq('[rotated] both marks are written into the copy', reparse && reparse.written, 2);
  const back = (reparse && reparse.annots) || [];
  const turnedBack = back.find(a => /\bturned\b/.test(a.text));
  const levelBack = back.find(a => /\blevel\b/.test(a.text));
  eq('[rotated] the turned one comes back a StrikeOut', turnedBack && turnedBack.subtype, 'StrikeOut');
  eq('[rotated] …and so does the level one', levelBack && levelBack.subtype, 'StrikeOut');
  // WHAT "TURNED" MEANS IN A QUADPOINT, EXACTLY. A quarter-turned rectangle is
  // still an axis-aligned rectangle — its four corners have two x values and
  // two y values either way, so you cannot tell a sideways run from a level one
  // by looking at the set of points. What says which way the words run is the
  // ORDER: the first two corners are the top of the line, left to right ALONG
  // the text, so a level run has UL.y == UR.y and a sideways one has
  // UL.x == UR.x. That ordering is the whole of what the file was failing to
  // say, and the whole of what Acrobat reads to decide which way to draw a bar.
  const upright = qp => {
    const f = [];
    JSON.stringify(qp, (k, v) => { if (typeof v === 'number') f.push(v); return v; });
    if (f.length < 8) return null;
    return Math.abs(f[1] - f[3]) < 0.2 && Math.abs(f[0] - f[4]) < 0.2;
  };
  // Read out of the FILE'S OWN BYTES, not out of pdf.js: pdf.js normalises
  // QuadPoints on the way in (it sorts the corners into a box), which is
  // precisely the information this fix exists to preserve. The bytes are what
  // Acrobat gets.
  const rawOrders = (reparse && reparse.rawQuads || []).map(t =>
    upright((t.match(/-?[\d.]+/g) || []).map(Number)));
  eq('[rotated] two marks, two QuadPoints arrays in the file', rawOrders.length, 2);
  ok('[rotated] …one of them saying its words run level, as they always did',
    rawOrders.includes(true), JSON.stringify(reparse && reparse.rawQuads));
  ok('[rotated] …and one saying they do not — which is what the file could not say before',
    rawOrders.includes(false), JSON.stringify(reparse && reparse.rawQuads));
  eq('[rotated] …and the turned bar is drawn as a path, because `re` cannot say “turned”',
    reparse && reparse.paths, 1);
  ok('[rotated] …and not a word of the document changed',
    !!(reparse && reparse.words.includes('Characterize')), reparse && reparse.words);

  // ---- 4. TURNING THE PAGE --------------------------------------------------
  // What the reader actually wants: the table the right way up. Per page, view
  // only, and — the whole reason it is done as one transform on the layer —
  // without disturbing a single thing painted on it.
  // ---- what selecting a sideways run is actually like ---------------------
  // "Finicky" was the reader's word and it is exactly right, so it is measured
  // here rather than described: three drags, before the turn and after it.
  const clean = sel => {
    const v = String(sel || '').trim();
    // inside the run, and nowhere else — the neighbouring columns are the
    // thing a bad selection swallows, and the caption is the other one
    return v.length > ROT_RUN.length * 0.7 && ROT_RUN.includes(v);
  };
  Object.assign(before, await runBox());
  const alongBefore = await drag(before.cx, before.t + before.h - 4, before.cx, before.t + 4);
  ok('[rotated] the machinery is not broken: dragging ALONG the run does select it',
    clean(alongBefore), JSON.stringify(alongBefore));
  // …but that is a bottom-to-top drag, and nobody makes one. The gesture a
  // reader actually makes over words is left to right, and over a sideways
  // run it is a drag ACROSS the letters. This is the complaint, reproduced.
  Object.assign(before, await runBox());
  const sweepBefore = await drag(before.l - 30, before.cy, before.l + before.w + 220, before.cy);
  ok('[rotated] …whereas the sweep anybody would ACTUALLY make gets nothing like it',
    !clean(sweepBefore), JSON.stringify(sweepBefore));
  // …and the drift that decides it. Along a sideways run, a few pixels sideways
  // is a few pixels ACROSS the column, and the neighbouring column is right
  // there — so a hand that is not dead straight takes two cells at once.
  Object.assign(before, await runBox());
  const driftBefore = await drag(before.cx - before.w * 0.9, before.t + before.h - 4,
                                 before.cx + before.w * 0.9, before.t + 4);
  // …and the third drag, which is the honest one. A hand that wanders off the
  // column entirely gets NOTHING — not the next column, not a fragment: the
  // press lands on the layer between two runs and there is no text position
  // there. Recorded so that nobody later claims turning the page cured this;
  // it does not, and the assertion after the turn says so in the same words.
  const NEIGHBOURS = ['Stabilize and control the platform', 'Requirements for capture'];
  const spilled = sel => NEIGHBOURS.some(t => String(sel || '').includes(t));
  ok('[rotated] …and a hand that wanders off the column gets nothing usable at all',
    !clean(driftBefore) && !spilled(driftBefore), JSON.stringify(driftBefore));

  const turned = await evaluate(`(() => {
    const box = document.querySelector('.bfp-pdf-page');
    const layer = box.querySelector('.textLayer');
    const b0 = box.getBoundingClientRect();
    const b4 = { w: layer.offsetWidth, h: layer.offsetHeight };
    const sf0 = getComputedStyle(box).getPropertyValue('--scale-factor');
    const painted0 = window.BFPAnchor.marksFor('rot-strike').length;
    const btn = document.querySelector('.bfp-pdf-label .bfp-rot');
    btn.click();                                   // the control the reader sees
    const b1 = box.getBoundingClientRect();
    return {
      hadButton: !!btn,
      pressed: btn.getAttribute('aria-pressed'),
      attr: box.getAttribute('data-bfp-rot'),
      rotations: window.__BFP_PDF.rotations,
      before: { w: Math.round(b0.width), h: Math.round(b0.height) },
      after: { w: Math.round(b1.width), h: Math.round(b1.height) },
      // the LAYOUT box, not the client rect: a turned element's client rect is
      // the bounding box of the turn, which is the page box by construction
      layerBefore: b4, layerAfter: { w: layer.offsetWidth, h: layer.offsetHeight },
      scaleBefore: sf0.trim(), scaleAfter: getComputedStyle(box).getPropertyValue('--scale-factor').trim(),
      painted0, painted1: window.BFPAnchor.marksFor('rot-strike').length,
      canvasCss: { w: Math.round(parseFloat(box.querySelector('canvas').style.width)),
                   h: Math.round(parseFloat(box.querySelector('canvas').style.height)) },
    };
  })()`);
  ok('[rotated] every page carries its own turn control', !!(turned && turned.hadButton));
  eq('[rotated] …one press turns this page a quarter turn', turned && turned.attr, '90');
  eq('[rotated] …and only this page', JSON.stringify(turned && turned.rotations), '{"1":90}');
  eq('[rotated] …and the control says it is turned', turned && turned.pressed, 'true');
  ok('[rotated] the page box swaps its sides',
    !!(turned && Math.abs(turned.after.w - turned.before.h) <= 2
       && Math.abs(turned.after.h - turned.before.w) <= 2), JSON.stringify(turned));
  ok('[rotated] …and the canvas with it',
    !!(turned && Math.abs(turned.canvasCss.w - turned.after.w) <= 2), JSON.stringify(turned));
  // The text layer keeps its UN-turned size: every span inside it is positioned
  // as a percentage of the file's own viewBox, so a layer that swapped sides
  // would put every word somewhere the glyphs are not. It is turned by one
  // transform instead, which is why nothing inside it has to move.
  eq('[rotated] …while the text layer keeps the size the spans are laid out against',
    JSON.stringify(turned && turned.layerAfter), JSON.stringify(turned && turned.layerBefore));
  eq('[rotated] …and the scale factor does not lurch because the sides swapped',
    turned && turned.scaleAfter, turned && turned.scaleBefore);
  // NOTHING WAS REPAINTED. The marks are the same nodes they were.
  eq('[rotated] …and every mark painted on the page survives the turn, un-repainted',
    turned && turned.painted1, turned && turned.painted0);

  const after = await runBox();
  ok('[rotated] the sideways run is now the right way up — wider than it is tall',
    !!(after && after.w > after.h * 3), JSON.stringify(after));
  const paintAfter = await evaluate(`(() => {
    const m = window.BFPAnchor.marksFor('rot-strike')[0];
    const r = m.getBoundingClientRect();
    return { w: r.width, h: r.height, band: getComputedStyle(m).backgroundImage,
             localW: m.offsetWidth, localH: m.offsetHeight };
  })()`);
  ok('[rotated] …and its strike band came with it, still along the words',
    !!(paintAfter && paintAfter.w > paintAfter.h * 3 && /linear-gradient/.test(paintAfter.band || '')),
    JSON.stringify(paintAfter));

  // THE ACCEPTANCE CRITERION. The same gesture a reader makes over any line of
  // text — left to right, along the words — which got nothing before the turn.
  Object.assign(after, await runBox());
  const afterSel = await drag(after.l + 2, after.cy, after.l + after.w - 2, after.cy);
  Object.assign(after, await runBox());
  const afterDrift = await drag(after.l + 2, after.cy - after.h * 0.9,
                                after.l + after.w - 2, after.cy + after.h * 0.9);
  ok('[rotated] THE POINT: after turning, the ordinary left-to-right drag selects the run cleanly',
    clean(afterSel), JSON.stringify(afterSel));
  // …and it now tolerates a wandering hand the way any line of text does: the
  // drift that used to cross into the next column is now drift ALONG the line,
  // where there is nothing to cross into.
  // The same wandering drag, after the turn. It is no better — it gets nothing
  // either — and that is the limit of what turning a page can do: it changes
  // which GESTURE is the natural one, not how the browser resolves a press
  // that lands between two runs. Stated as a test so the claim stays honest.
  ok('[rotated] …while a hand that wanders off the line still gets nothing, turned or not',
    !clean(afterDrift) && !spilled(afterDrift), JSON.stringify(afterDrift));

  // …and the export still lands on the words, from the turned page. The quads
  // go through viewport.convertToPdfPoint, which knows about the turn, so the
  // numbers must be the ones the un-turned page gave.
  const quadsAfter = await evaluate(`(async () => {
    const out = await window.__BFP_PDF.collect([{ id: 'rot-strike', quote: ${JSON.stringify(ROT_RUN)}, mark: 'strike',
      msgs: [{ author: 'angadh', ts: '2026-08-29T09:00:00Z', text: 'turned' }] }]);
    return out.items[0] && out.items[0].quads[0];
  })()`);
  if (turnedItem && quadsAfter) {
    const same = turnedItem.quads[0].every((v, i) => Math.abs(v - quadsAfter[i]) < 1.5);
    ok('[rotated] …and the file gets the SAME quad whether the reader turned the page or not',
      same, JSON.stringify([turnedItem.quads[0], quadsAfter].map(a => a.map(v => +v.toFixed(2)))));
  }

  // the keyboard, and the way back
  const keyed = await evaluate(`(() => {
    const box = document.querySelector('.bfp-pdf-page');
    // a reader mid-selection is not asking for the page to move, and the last
    // drag left one — so the key does nothing until the selection is let go
    window.getSelection().selectAllChildren(box);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    const whileSelecting = box.getAttribute('data-bfp-rot');
    window.getSelection().removeAllRanges();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', shiftKey: true, bubbles: true }));
    const back = box.getAttribute('data-bfp-rot');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    const fwd = box.getAttribute('data-bfp-rot');
    // …and never while the reader is typing
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    const typed = box.getAttribute('data-bfp-rot');
    input.remove();
    // …including into the DRAWER, which is a shadow root. A keystroke from
    // inside one arrives at window with its target rewritten to the HOST, so a
    // guard that only looks at e.target sees a <div> and turns the page under
    // somebody halfway through the word "rather".
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('textarea');
    shadow.appendChild(inner);
    inner.focus();
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, composed: true }));
    const shadowTyped = box.getAttribute('data-bfp-rot');
    host.remove();
    // the positive control, so the two guards above cannot pass by simply
    // never reaching the handler: the same bubbled keystroke from something
    // that is NOT a place to type does turn the page
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    plain.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', shiftKey: true, bubbles: true }));
    const bubbled = box.getAttribute('data-bfp-rot');
    const btnAfterKey = document.querySelector('.bfp-pdf-label .bfp-rot').getAttribute('aria-pressed');
    plain.remove();
    // …and put it back the way it was, because the figure capture below is
    // about what a TURNED page hands the bots
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    return { whileSelecting, back, fwd, typed, shadowTyped, bubbled, btnAfterKey };
  })()`);
  eq('[rotated] a key never moves the page out from under a live selection',
    keyed && keyed.whileSelecting, '90');
  eq('[rotated] shift-R turns it back', keyed && keyed.back, '0');
  eq('[rotated] …and r turns it again', keyed && keyed.fwd, '90');
  eq('[rotated] …but never out from under somebody who is typing', keyed && keyed.typed, '90');
  eq('[rotated] …including typing into the drawer, which is a shadow root',
    keyed && keyed.shadowTyped, '90');
  eq('[rotated] …while an ordinary keystroke from the page still turns it',
    keyed && keyed.bubbled, '0');
  eq('[rotated] …and the button on the page agrees, however the turn was asked for',
    keyed && keyed.btnAfterKey, 'false');

  // the picture the bots get is the picture the reader is looking at
  const shotTurned = await evaluate(`(async () => {
    const s = await window.__BFP_PDF.capture(1);
    return s ? { w: s.w, h: s.h } : null;
  })()`);
  ok('[rotated] a figure captured from a turned page is captured the right way up',
    !!(shotTurned && shotTurned.w > shotTurned.h), JSON.stringify(shotTurned));
}

try { ws.close(); } catch { /* closing anyway */ }
cleanup();

if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' pdf-render.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
