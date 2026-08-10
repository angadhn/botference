// viewer.js — render the PDF, and get out of the way.
//
// This module has exactly three jobs, and deliberately no fourth:
//
//   1. put the document on screen, page by page, WITH PDF.js's text layer.
//      That layer — absolutely positioned <span>s of transparent text over the
//      canvas — is the whole trick: it is ordinary DOM text, so selection,
//      <mark> painting and quote anchoring all work with no change at all to
//      anchor.js, drawer.js or content.js.
//   2. tell the annotator when there is more of the document to anchor to. A
//      PDF arrives page by page, so highlights are repainted as text layers
//      land (window.__bfp.refresh()), never once at the end.
//   3. say, quietly, when there is nothing to select — a scanned PDF is an
//      image, and there is no OCR here.
//
// It does NOT own the identity, the title-as-record, the snapshot or the
// anchors: adapters.js's `pdf` adapter reads this page's DOM back out and
// answers for all four. One direction of knowledge, so there is one place to
// look when a quote lands on the wrong page.
//
// ── SCALE ──────────────────────────────────────────────────────────────────
// One number, `scale`, is the viewport scale AND the CSS custom property
// --scale-factor on every page box. PDF.js's vendored .textLayer rules size
// every span with calc(var(--total-scale-factor) * var(--font-height)), so the
// two must be the same number or the text layer drifts off the glyphs — a
// selection bug that presents as an anchoring bug. Zooming therefore never
// rebuilds the text layer (which would throw away every painted highlight): it
// moves --scale-factor and asks TextLayer.update() to relayout in place.
import {
  getDocument, GlobalWorkerOptions, TextLayer, PixelsPerInch,
} from '../vendor/pdfjs/build/pdf.min.mjs';

const asset = p => new URL('../vendor/pdfjs/' + p, import.meta.url).href;
GlobalWorkerOptions.workerSrc = asset('build/pdf.worker.min.mjs');

const Adapters = window.BFPAdapters || null;
const $ = id => document.getElementById(id);
const docEl = $('doc');
const noticeEl = $('notice');

// ---- which PDF -------------------------------------------------------------
// adapters.js parses it, not this file: the extension has exactly one rule for
// "which document is a viewer address showing", and both sides must read the
// url the same way or the record and the render disagree.
const SRC = Adapters ? Adapters.pdfViewerSrc(location.href) : null;

function notice(html) {
  noticeEl.innerHTML = html;
  noticeEl.hidden = false;
}

// The escape hatch, and the reason it needs the worker: navigating straight
// back to the PDF would be caught by the same redirect that brought us here.
// The worker parks a one-shot allow rule in front of its own redirect rule,
// and Chrome's built-in viewer gets the page.
async function openOriginal(ev) {
  if (ev) ev.preventDefault();
  if (!SRC) return;
  try {
    await new Promise(resolve => {
      try { chrome.runtime.sendMessage({ t: 'pdf-bypass', url: SRC }, () => resolve()); }
      catch { resolve(); }
    });
  } catch { /* the navigation is still worth attempting */ }
  location.href = SRC;
}
$('original').addEventListener('click', openOriginal);

if (!SRC) {
  $('doc-title').textContent = 'Not a PDF address';
  notice('This viewer needs a <code>?src=</code> pointing at an http(s) PDF. ' +
         'It is opened for you when you navigate to a PDF on the web.');
  $('original').hidden = true;
}

// ---- the title -------------------------------------------------------------
// content.js reads document.title through the adapter, so this IS the record's
// headline. The file name is the honest placeholder until the document's own
// metadata arrives; refresh() then re-posts /page with the real one.
const fileName = (SRC && Adapters) ? Adapters.pdfNameFromUrl(SRC) : '';
function setTitle(t) {
  const name = String(t || '').trim() || fileName || 'PDF';
  document.title = name;
  $('doc-title').textContent = name;
  $('doc-title').title = SRC || '';
}
setTitle('');

// The annotator boots from the same DOM this module is still filling in, so it
// is told whenever there is more of it. Debounced: forty pages landing in a
// second must not be forty refetches.
let refreshTimer = null;
function tellAnnotator() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    try { window.__bfp && window.__bfp.refresh && window.__bfp.refresh(); } catch { /* the render is not its business */ }
  }, 250);
}

// ---- render ----------------------------------------------------------------
//
// ── ONE VIEWPORT PER PAGE PER LAYOUT ───────────────────────────────────────
// This is the invariant the whole thing rests on, and getting it wrong is not
// a subtle bug: the text layer detaches from the glyphs and every selection
// rectangle lands somewhere the words are not.
//
// PDF.js positions text-layer spans as PERCENTAGES of `viewport.rawDims`, which
// is the page's UNSCALED viewBox (612×792 for US Letter, in points), and sizes
// the layer itself — in CSS, inside the vendored stylesheet — as
// `--total-scale-factor × rawDims.pageWidth`. So the number handed to
// `--scale-factor` is not "a zoom level"; it is precisely
//
//     viewport.width / viewport.rawDims.pageWidth
//
// (`--user-unit` is pinned to 1 in viewer.css and folded into that ratio, so a
// PDF declaring a UserUnit is handled without a second knob to forget.)
//
// The original bug here was one line of convention drift: the page box was
// sized from a viewport built at `PixelsPerInch.PDF_TO_CSS_UNITS × scale`
// (which is 1.333× the point size) while `--scale-factor` was given the bare
// `scale`. The text layer therefore laid itself out inside a box three-quarters
// the width of the page it was covering — spans too far left, too far up, too
// small, with the leftovers pooling in the margins. The canvas was drawn at the
// third convention again and stretched by CSS to fit, which is why the page
// still LOOKED right and only the selection gave it away.
//
// The cure is structural rather than a corrected constant: `scale` now always
// means "the scale argument to getViewport", every consumer takes its numbers
// from the SAME viewport object, and `--scale-factor` is derived from that
// object instead of being asserted alongside it.
// `scale` is in POINTS, so the familiar percentages are expressed against
// PixelsPerInch.PDF_TO_CSS_UNITS — the 96/72 that makes "100%" mean "the size a
// browser would call it". Stated once, here, rather than smuggled into the
// geometry.
const CSS_UNITS = PixelsPerInch.PDF_TO_CSS_UNITS;
const MIN_SCALE = 0.25 * CSS_UNITS;
const MAX_SCALE = 6 * CSS_UNITS;
const PAGE_GUTTER = 48;             // px of breathing room either side, at fit
// …and a page is never wider than this at "Fit", however wide the window is.
// A PDF page blown up to 2000px is not more readable, it is just larger, and
// the drawer needs somewhere to be.
const MAX_FIT_WIDTH = 1000;
const pages = [];                   // {n, div, canvas, layerDiv, page, base, viewport, layer, task}
let scale = 1;
let fitWidth = true;
let pdfDoc = null;

const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

// What the vendored .textLayer rules must be told, read off the very viewport
// the page was laid out with. Never computed a second way.
const totalScaleFactor = vp => vp.width / vp.rawDims.pageWidth;

function fitScale(base) {
  const avail = Math.max(240, Math.min(docEl.clientWidth - PAGE_GUTTER, MAX_FIT_WIDTH));
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, avail / base.width));
}

// The page box IS the viewport, in CSS pixels: same width, same height, same
// scale factor announced to the stylesheet. The canvas and the text layer are
// both hung on this and nothing else.
function sizePage(p) {
  const vp = p.page.getViewport({ scale });
  p.viewport = vp;
  const w = Math.floor(vp.width);
  const h = Math.floor(vp.height);
  p.div.style.setProperty('--scale-factor', String(totalScaleFactor(vp)));
  p.div.style.width = w + 'px';
  p.div.style.height = h + 'px';
  p.canvas.style.width = w + 'px';
  p.canvas.style.height = h + 'px';
  return vp;
}

// The canvas is the expensive half and is drawn only for pages that are
// actually on screen; the TEXT layer is built for every page regardless,
// because an anchor has to be findable whether or not its page has been looked
// at. That asymmetry is the whole of this viewer's laziness.
const seen = new WeakMap();
const io = ('IntersectionObserver' in window)
  ? new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const p = seen.get(e.target);
        if (p) paintCanvas(p);
      }
    }, { root: null, rootMargin: '400px 0px' })
  : null;

async function paintCanvas(p) {
  if (!p.page) return;
  const want = scale;
  if (p.drawnAt === want || p.drawing) return;
  p.drawing = true;
  try { p.task && p.task.cancel(); } catch { /* replaced mid-flight */ }
  const ratio = dpr();
  const viewport = p.page.getViewport({ scale: want * ratio });
  p.canvas.width = Math.floor(viewport.width);
  p.canvas.height = Math.floor(viewport.height);
  const ctx = p.canvas.getContext('2d', { alpha: false });
  try {
    p.task = p.page.render({ canvasContext: ctx, viewport });
    await p.task.promise;
    p.drawnAt = want;
  } catch (e) {
    // a cancelled render is the normal cost of zooming, not a failure
    if (!e || e.name !== 'RenderingCancelledException') console.warn('[botference] page ' + p.n + ' did not render:', e);
  } finally {
    p.drawing = false;
    p.task = null;
  }
  // The scale moved while this was drawing (a zoom, or the drawer opening):
  // the canvas that just landed is the wrong size, so draw the right one.
  // Only after a SUCCESSFUL draw — a page that cannot render must fail once,
  // not spin.
  if (p.drawnAt === want && want !== scale) paintCanvas(p);
}

function relayout() {
  if (!pages.length) return;
  if (fitWidth) scale = fitScale(pages[0].base);
  for (const p of pages) {
    const vp = sizePage(p);
    p.drawnAt = -1;
    // the SAME viewport the box was just sized from — a text layer relayed out
    // against a freshly built one is how the two drift apart again
    if (p.layer) {
      try { p.layer.update({ viewport: vp }); }
      catch (e) { console.warn('[botference] text layer did not rescale:', e); }
    }
  }
  // redraw whatever is on screen now; the rest waits for the observer
  for (const p of pages) {
    const r = p.div.getBoundingClientRect();
    if (r.bottom > -400 && r.top < window.innerHeight + 400) paintCanvas(p);
  }
  $('zoom-fit').setAttribute('aria-pressed', fitWidth ? 'true' : 'false');
}

function setScale(next) {
  fitWidth = false;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
  relayout();
}
$('zoom-in').addEventListener('click', () => setScale(scale * 1.25));
$('zoom-out').addEventListener('click', () => setScale(scale / 1.25));
$('zoom-fit').addEventListener('click', () => { fitWidth = true; relayout(); });

// The window is not the only thing that resizes this: the drawer pushes the
// page aside with a margin on <html>, which fires no resize event at all. So
// the CONTAINER is watched, and a fit that has not actually changed does
// nothing — otherwise a relayout could feed itself.
let resizeTimer = null;
function refit() {
  if (!fitWidth || !pages.length) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (Math.abs(fitScale(pages[0].base) - scale) < 0.001) return;
    relayout();
  }, 150);
}
window.addEventListener('resize', refit);
if ('ResizeObserver' in window) new ResizeObserver(refit).observe(docEl);

// One page: the label (repeated verbatim in the snapshot, so the phone reads
// the same string), the canvas, and the text layer over it.
function makePage(n, page) {
  // The reference size, at scale 1 — points, plus whatever UserUnit the
  // document declares. Everything else is this times `scale`, and NOTHING here
  // pre-multiplies by PixelsPerInch: that constant belongs in the default zoom
  // (below), not in the geometry, which is exactly the confusion that used to
  // put the text layer three-quarters of the way across the page.
  const base = page.getViewport({ scale: 1 });
  const label = document.createElement('div');
  label.className = 'bfp-pdf-label';
  label.textContent = Adapters ? Adapters.pdfPageLabel(n) : 'Page ' + n;

  const div = document.createElement('div');
  div.className = 'bfp-pdf-page';
  div.setAttribute(Adapters ? Adapters.PDF_PAGE_ATTR : 'data-bfp-pdf-page', String(n));

  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'presentation');
  const layerDiv = document.createElement('div');
  layerDiv.className = 'textLayer';
  div.append(canvas, layerDiv);
  docEl.append(label, div);

  const p = { n, div, canvas, layerDiv, page, base, viewport: null, layer: null, task: null, drawnAt: -1 };
  pages.push(p);
  if (pages.length === 1 && fitWidth) scale = fitScale(base);
  sizePage(p);
  seen.set(div, p);
  if (io) io.observe(div); else paintCanvas(p);
  return p;
}

async function buildTextLayer(p) {
  let source;
  try { source = await p.page.getTextContent(); }
  catch (e) { console.warn('[botference] page ' + p.n + ' has no text content:', e); return; }
  // The scale may have moved while the text content was in flight (a resize, a
  // zoom), so the box is re-sized here and the layer is built from THAT
  // viewport — the one the page is actually wearing, never a stale copy.
  const vp = sizePage(p);
  const layer = new TextLayer({
    textContentSource: source,
    container: p.layerDiv,
    viewport: vp,
  });
  p.layer = layer;
  try { await layer.render(); } catch (e) { console.warn('[botference] text layer failed on page ' + p.n + ':', e); }
}

// ---- the whole document ----------------------------------------------------
async function run() {
  if (!SRC) return;
  const task = getDocument({
    url: SRC,
    // the reader's own session: a paper behind a library login is the common
    // case, and the extension has host permissions, so CORS is not in the way
    withCredentials: true,
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    iccUrl: asset('iccs/'),
    wasmUrl: asset('wasm/'),
    // a document must never run code inside the extension's own origin
    isEvalSupported: false,
    enableXfa: false,
  });
  task.onPassword = (updatePassword, reason) => {
    const again = reason === 2; // PasswordResponses.INCORRECT_PASSWORD
    const pw = window.prompt(again ? 'That password was not right. Try again:' : 'This PDF is password-protected.');
    if (pw == null) { task.destroy(); notice('This PDF is password-protected, and no password was given.'); return; }
    updatePassword(pw);
  };

  try {
    pdfDoc = await task.promise;
  } catch (e) {
    const why = (e && e.message) || String(e);
    $('doc-title').textContent = fileName || 'Could not open';
    notice('This did not open as a PDF (<code>' + escapeHtml(why) + '</code>). ' +
           '<a href="#" id="notice-original">Open it in the browser instead</a>.');
    const a = $('notice-original');
    if (a) a.addEventListener('click', openOriginal);
    return;
  }

  try {
    const meta = await pdfDoc.getMetadata();
    setTitle((meta && meta.info && meta.info.Title) || '');
  } catch { setTitle(''); }
  $('doc-meta').textContent = pdfDoc.numPages + (pdfDoc.numPages === 1 ? ' page' : ' pages');
  tellAnnotator();

  // In order, one at a time, yielding between pages: the first page is on
  // screen in a moment and a long document fills in behind it rather than
  // freezing the tab.
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    let page;
    try { page = await pdfDoc.getPage(n); }
    catch (e) { console.warn('[botference] page ' + n + ' did not load:', e); continue; }
    const p = makePage(n, page);
    await buildTextLayer(p);
    tellAnnotator();
    await new Promise(r => setTimeout(r, 0));
  }

  // …and the honest ending. A scan is an image of words, and this extension
  // does no OCR: say so once, quietly, rather than leaving the reader dragging
  // over a page that will never select.
  const words = Adapters ? Adapters.pdfPagesFromDom(document).reduce((n, p) => n + p.lines.length, 0) : 1;
  if (!words) {
    notice('This PDF has no selectable text — it is a scan. You can read it here, ' +
           'but there is nothing to highlight and the bots cannot be given its words.');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

run();
