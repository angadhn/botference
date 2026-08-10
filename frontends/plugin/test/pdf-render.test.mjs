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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');            // frontends/plugin
const FIXTURE = 'test/fixtures/two-pages.pdf';

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
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+/, '');
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

try { ws.close(); } catch { /* closing anyway */ }
cleanup();

if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' pdf-render.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
