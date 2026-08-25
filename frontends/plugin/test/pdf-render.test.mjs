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

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+/, '');
  if (rel === 'annotated.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'accept-ranges': 'bytes' }).end(ANNOTATED);
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
const DEBUG_PORT = 9222 + Math.floor(Math.random() * 900);
const chrome = spawn(chromePath, [
  // deliberately the OLD headless: --headless=new hangs in sandboxed shells
  '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => {
  try { chrome.kill(); } catch { /* already gone */ }
  try { server.close(); } catch { /* already closed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* it is a temp dir */ }
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
    }]);
    return { out, quote: c.quote };
  })()`);

  ok('a thread whose conversation has grown is written back', !!(trip && trip.out && trip.out.items.length >= 1),
    JSON.stringify(trip));
  eq('…and one that is still only what the file already said is NOT',
    trip && trip.out && trip.out.already, 1);
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

try { ws.close(); } catch { /* closing anyway */ }
cleanup();

if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' pdf-render.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
