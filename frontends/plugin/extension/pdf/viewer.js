// viewer.js — render the PDF, and get out of the way.
//
// This module has exactly four jobs, and deliberately no fifth:
//
//   0. decide WHAT DOCUMENT THIS IS, and publish the answer before a single
//      line of the annotator has been loaded (see BOOT below).
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
// It does NOT own the title-as-record, the snapshot or the anchors:
// adapters.js's `pdf` adapter reads this page's DOM back out and answers for
// all three. One direction of knowledge, so there is one place to look when a
// quote lands on the wrong page.
//
// ── BOOT: THE IDENTITY COMES FIRST ─────────────────────────────────────────
// content.js decides which page it is on ONCE, at parse time, and nothing
// downstream ever asks again. For a web PDF the answer is sitting in this
// page's own address (`#raw=https://…`), so the annotator used to be five
// <script> tags in viewer.html and the order did not matter.
//
// A LOCAL pdf has no such answer. `file:///Users/me/Downloads/paper.pdf` is
// where the file is today, not what it is: move it, rename it, or read it on
// another Mac and every comment made on it is filed against an address that no
// longer exists. And its BYTES are not what it is either — Adobe Acrobat
// rewrites the file on every save, so one sticky-note annotation re-keyed the
// page and orphaned its chat. What survives everything a reader does short of
// actually revising the document is its TEXT, so a local PDF is identified by
// the SHA-256 of its extracted, normalized text — `bfp-pdf://text/<hex>`,
// adapters.js — with the byte hash kept for two jobs: the identity of a SCAN
// (no text to hash; `bfp-pdf://sha256/<hex>` with the old semantics), and the
// FAST PATH — a persistent byte-hash → identity cache in extension storage,
// so reopening an untouched file never re-extracts. The cache caches a
// deterministic function: losing it costs one re-extraction, never a re-key.
//
// Hence one boot path for both, with a fork on the cache:
//
//   adapters.js  →  which document is this address showing?
//   (file: only) →  read the bytes, SHA-256 them
//   cache HIT    →  publish the known identity, inject, render (yesterday's boot)
//   cache MISS   →  RENDER FIRST (the annotator does not exist yet, so nothing
//                   can register under a provisional identity), then hash the
//                   text out of the very DOM the snapshot and anchors use,
//                   publish, inject, remember byte-hash → identity
//
// And the refusal that goes with it: a local file whose bytes could not be
// read has NO identity, so the annotator is not loaded at all. Filing comments
// under this page's chrome-extension:// address would be worse than useless —
// it moves with the extension id and is nobody's document.
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

let Adapters = null;              // adapters.js, injected first (see boot)
const $ = id => document.getElementById(id);
const docEl = $('doc');
const noticeEl = $('notice');

// ---- which PDF -------------------------------------------------------------
// adapters.js parses it, not this file: the extension has exactly one rule for
// "which document is a viewer address showing", and both sides must read the
// url the same way or the record and the render disagree.
let SRC = null;                   // the document's own address: http(s) or file:
let LOCAL = false;                // …and file: is the one that needs hashing
let localBytes = null;            // the bytes, read once, hashed and rendered

function notice(html) {
  noticeEl.innerHTML = html;
  noticeEl.hidden = false;
}

// The one sentence anybody needs when a local PDF will not open. Written once,
// shown here and on the options page, and never softened: it names the toggle,
// where it lives, and what to do to it.
const FILE_ACCESS_HELP =
  'Local PDFs need “Allow access to file URLs” — brave://extensions → ' +
  'Botference Discuss → Details → toggle it on.';

// The escape hatch, and the reason a web PDF needs the worker for it:
// navigating straight back would be caught by the same redirect that brought
// us here, so the worker parks a one-shot allow rule in front of its own rule
// and Chrome's built-in viewer gets the page. A local file is not redirected by
// anything (declarativeNetRequest cannot touch a file: navigation), so it is
// simply navigated to.
async function openOriginal(ev) {
  if (ev) ev.preventDefault();
  if (!SRC) return;
  if (!LOCAL) {
    try {
      await new Promise(resolve => {
        try { chrome.runtime.sendMessage({ t: 'pdf-bypass', url: SRC }, () => resolve()); }
        catch { resolve(); }
      });
    } catch { /* the navigation is still worth attempting */ }
  }
  location.href = SRC;
}
$('original').addEventListener('click', openOriginal);

// ---- the title -------------------------------------------------------------
let fileName = '';

// TWO names, and keeping them apart is the whole of the rename fix.
//
//   ownName      what the DOCUMENT calls itself — its /Title, else the file
//                name. This is the "scraped" title: the adapter reports it,
//                POST /page keeps it fresh underneath, and it is what a page
//                falls back to when a rename is cleared. It is published on
//                `window.__BFP_PDF_TITLE` rather than in document.title,
//                because document.title now belongs to the reader.
//   shownName    what the READER calls it — custom_title when they have
//                renamed the page, otherwise ownName. It is what the top bar
//                and the tab say, and it arrives (and re-arrives) from
//                content.js, which hears every rename as a `page` event.
let ownName = '';
let shownName = '';

function paintTitle() {
  const name = shownName || ownName || fileName || 'PDF';
  document.title = name;
  $('doc-title').textContent = name;
  $('doc-title').title = SRC || '';
}
function setOwnTitle(t) {
  ownName = String(t || '').trim() || fileName || 'PDF';
  window.__BFP_PDF_TITLE = ownName;
  paintTitle();
}

// The reader's name for this page, live. A rename made anywhere — this drawer,
// another tab, the reading room on a phone — broadcasts a `page` event, which
// content.js turns into a fresh record and hands on here.
function watchTitle() {
  try {
    if (window.__bfp && window.__bfp.onTitle) {
      window.__bfp.onTitle(t => { shownName = String(t || '').trim(); paintTitle(); });
      return;
    }
  } catch (_) { /* fall through and try again */ }
  setTimeout(watchTitle, 300);
}

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
    // A local file has already been read, whole, so that its bytes could be
    // hashed into an identity: it is handed straight to PDF.js rather than
    // fetched a second time. A web PDF keeps the url, so PDF.js can range-request
    // a 300-page paper instead of waiting for all of it.
    ...(localBytes ? { data: new Uint8Array(localBytes) } : { url: SRC }),
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
    setOwnTitle((meta && meta.info && meta.info.Title) || '');
  } catch { setOwnTitle(''); }
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

  // …and last, what the file already had to say. After the text layers, always:
  // an annotation's quote is the words under its quads, and until every page is
  // laid out there are no words to be under anything.
  try {
    const found = await scanAnnots();
    if (found.length) tellAnnots();
  } catch (e) { console.warn('[botference] the document’s own comments did not read:', e); }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- the comments the FILE arrived with ------------------------------------
//
// A manuscript that has been round a supervisor comes back with Acrobat
// highlights and Preview sticky notes in it. Those are comments — with an
// author, a date and a paragraph of popup text — and this is the only place in
// the extension that can read them: the parsed document and the text layer are
// both here, and "which words are under this quad" is a question only the two
// of them together can answer.
//
// So the viewer does the reading and NOTHING else. It publishes what it found;
// content.js decides whether the reader is offered them, and the companion
// decides what is already known (`origin`, store.mjs). One direction of
// knowledge, as with the title and the snapshot.
let Ann = null;                     // pdf/annots.js, loaded when it is needed

// Lazily, and only on a document that has something to read or write: a paper
// with no annotations in it never loads this file, and the writer (half a
// megabyte) is not loaded until somebody exports.
async function ensureAnn() {
  if (Ann) return Ann;
  try { await loadScript('./annots.js'); } catch { return null; }
  Ann = window.BFPPdfAnnots || null;
  return Ann;
}

// Every text-layer span on one page, as a box in PDF USER SPACE — the space
// QuadPoints are written in. Converting the DOM into the file's own
// coordinates (rather than the file into the DOM's) is what keeps this
// independent of the zoom, the device pixel ratio and the fit width: the
// numbers compared below are the numbers Acrobat wrote.
function spansOf(p) {
  const out = [];
  if (!p || !p.viewport || !p.layerDiv) return out;
  const box = p.div.getBoundingClientRect();
  for (const el of p.layerDiv.querySelectorAll('span')) {
    const text = el.textContent || '';
    if (!text.trim()) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    out.push({ text, box: pdfBox(p, box, r) });
  }
  return out;
}
// a client rectangle → [x0,y0,x1,y1] in PDF points. The y axis flips (PDF
// counts up from the bottom of the page, the DOM down from the top), which
// convertToPdfPoint already knows; the min/max is what keeps the box a box.
function pdfBox(p, pageRect, r) {
  const a = p.viewport.convertToPdfPoint(r.left - pageRect.left, r.top - pageRect.top);
  const b = p.viewport.convertToPdfPoint(r.right - pageRect.left, r.bottom - pageRect.top);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

// The quote for one annotation: the words its quads cover, with the four spans
// either side as prefix/suffix — the very same three fields a selection in the
// drawer captures, so an imported thread anchors and re-anchors exactly as a
// hand-made one does.
function quoteFor(a, spans) {
  const rects = (a.quads && a.quads.length) ? a.quads : [a.rect];
  let idxs = Ann.spansUnder(spans, rects);
  if (!idxs.length) {
    // a sticky note (no quads at all), or a mark whose quads sit between two
    // lines: the line it points at is the nearest span to its top-left corner
    const i = Ann.spanNearest(spans, a.rect[0], a.rect[3]);
    idxs = i >= 0 ? [i] : [];
  }
  // nothing near it at all — a note on a blank page. It has no anchor, and the
  // companion files it as page chat rather than minting an orphan.
  return idxs.length ? Ann.quoteFromSpans(spans, idxs) : { quote: '', prefix: '', suffix: '' };
}

// What crosses to the companion: a comment, not an annotation. The rectangles,
// the quads and the object numbers stay here — they are how this side FOUND
// the comment, and none of them means anything to a thread.
function asComment(a) {
  return {
    id: a.id, page: a.page, author: a.author, ts: a.ts, text: a.text,
    quote: a.quote, prefix: a.prefix, suffix: a.suffix,
    kind: a.subtype,
    replies: (a.replies || []).map(r => ({ id: r.id, author: r.author, ts: r.ts, text: r.text })),
  };
}

async function scanAnnots() {
  if (!pdfDoc) return [];
  if (!await ensureAnn()) return [];
  const found = [];
  for (const p of pages) {
    let raw;
    try { raw = await p.page.getAnnotations({ intent: 'display' }); }
    catch (e) { console.warn('[botference] page ' + p.n + ' annotations did not read:', e); continue; }
    const list = (raw || []).map(x => Ann.normalizeAnnot(x, p.n)).filter(Boolean);
    if (!list.length) continue;
    const roots = Ann.foldReplies(list);
    if (!roots.length) continue;
    const spans = spansOf(p);
    for (const a of roots) Object.assign(a, quoteFor(a, spans));
    found.push(...roots);
  }
  window.__BFP_PDF_ANNOTS = found.map(asComment);
  return window.__BFP_PDF_ANNOTS;
}

// The annotator boots after this module and may not exist yet, so the offer is
// pushed the same way the title is: try, and try again shortly. Bounded — a
// page with no annotator (the render test, a refused local file) must not spin.
function tellAnnots(tries) {
  const left = tries == null ? 20 : tries;
  if (!window.__BFP_PDF_ANNOTS || !window.__BFP_PDF_ANNOTS.length) return;
  try {
    if (window.__bfp && window.__bfp.pdfAnnots) { window.__bfp.pdfAnnots(window.__BFP_PDF_ANNOTS); return; }
  } catch (_) { /* fall through and try again */ }
  if (left > 0) setTimeout(() => tellAnnots(left - 1), 300);
}

// ---- …and the other direction: the discussion, written back ----------------
//
// A copy of this file with every Discuss thread in it as a standard Highlight,
// the whole conversation (the bots included) in its popup. The reader who gets
// that copy needs no extension, no companion and no account — just a PDF
// viewer, which is the entire point.
//
// WHY IT HAPPENS HERE, AND NOT IN THE COMPANION. Two reasons, both structural.
// The companion has never seen this file and must not start now: a local PDF's
// bytes are deliberately never uploaded, copied or stored (the local-PDF
// amendment says so in those words), and uploading a 7 MB manuscript to write
// three highlights into it would trade that for nothing. And the geometry only
// exists here: a thread is a QUOTE, and the only thing on this machine that
// knows where those words are in PDF coordinates is the text layer in this
// tab. The file is written in memory and handed to the browser's own
// downloader; nothing is written beside the original, and the original is
// never touched.
let PDFLibMod = null;
async function pdfLib() {
  if (PDFLibMod) return PDFLibMod;
  await loadScript('../vendor/pdf-lib/pdf-lib.min.js');
  PDFLibMod = window.PDFLib || null;
  if (!PDFLibMod) throw new Error('the PDF writer did not load');
  return PDFLibMod;
}

// The page box a node is painted in, and the record that goes with it.
function pageOfNode(node) {
  const div = node && node.closest ? node.closest('.bfp-pdf-page') : null;
  return div ? pages.find(p => p.div === div) || null : null;
}

// A thread's highlight, as the file would draw it: one quad per line of the
// passage, grouped by the page it is on (a quote across a page break is two
// annotations, because an annotation belongs to exactly one page).
//
// The rectangles come from the PAINTED HIGHLIGHT, not from a fresh text hunt —
// anchor.js has already decided where this thread is, including after a
// re-anchor, so the ink in the file lands exactly where the ink on screen is.
// A thread that is orphaned has no marks and is reported as skipped rather
// than guessed at.
function quadsForThread(id) {
  const A = window.BFPAnchor;
  const marks = (A && A.marksFor) ? A.marksFor(id) : [];
  const byPage = new Map();
  for (const m of marks) {
    const p = pageOfNode(m);
    if (!p || !p.viewport) continue;
    const box = p.div.getBoundingClientRect();
    for (const r of m.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (!byPage.has(p.n)) byPage.set(p.n, []);
      byPage.get(p.n).push(pdfBox(p, box, r));
    }
  }
  return [...byPage.entries()].map(([page, quads]) => ({ page, quads }));
}

// A thread that came out of THIS FILE and has not been added to since is
// already in the file — writing it back would put the supervisor's own comment
// beside itself. One that has grown (a reply, a bot's answer) is written, and
// its popup carries the original remark at the top, where it belongs.
function purelyImported(t) {
  const o = t && t.origin;
  if (!o || o.system !== 'pdf-annot') return false;
  return (t.msgs || []).every((m, i) => i === 0 || (m && m.origin));
}

const DISCUSS_YELLOW = [1, 0.83, 0.25];
const DISCUSS_GREEN = [0.62, 0.85, 0.62];   // …and a filed thread is not live
// A STRUCK thread goes out as a real /StrikeOut in Acrobat's own red, because
// the person receiving the copy has no Discuss and no way of learning a house
// convention: red-line-through-the-words is the one mark every reader of PDFs
// already knows. A filed strikeout keeps the sage — the thread is closed, and
// the colour says so here exactly as it does on the page.
const DISCUSS_RED = [0.78, 0.19, 0.19];

// Threads → the annotations that would be written for them, and the tally of
// what could not be. Separated from the writing so the round trip is
// observable: pdf-render.test.mjs imports an annotation, makes the thread it
// would make, and asks this for the quads it would write back — which must
// land on the passage the original annotation covered.
function collectItems(threads) {
  const items = [];
  let orphaned = 0;
  let already = 0;
  for (const t of threads || []) {
    if (purelyImported(t)) { already++; continue; }
    const groups = quadsForThread(t.id);
    if (!groups.length) { orphaned++; continue; }
    const msgs = (t.msgs || []).filter(m => m && m.kind !== 'tools');
    const resolved = !!t.resolved;
    const struck = t.mark === 'strike';
    for (const g of groups) {
      items.push({
        page: g.page,
        quads: g.quads,
        subtype: struck ? 'StrikeOut' : 'Highlight',
        contents: Ann.threadContents(t, { head: '“' + String(t.quote || '').replace(/\s+/g, ' ').trim() + '”' }),
        // the annotation is signed by whoever opened the thread — the reply
        // chain inside the popup names everybody else, in order
        author: (msgs[0] && msgs[0].author) || 'Discuss',
        ts: (msgs[msgs.length - 1] && msgs[msgs.length - 1].ts) || '',
        created: (msgs[0] && msgs[0].ts) || '',
        subject: 'Discuss' + (struck ? ' · suggested deletion' : '') + (resolved ? ' · resolved' : ''),
        color: resolved ? DISCUSS_GREEN : (struck ? DISCUSS_RED : DISCUSS_YELLOW),
        name: 'bfp-' + t.id,
      });
    }
  }
  return { items, orphaned, already };
}

async function exportAnnotated() {
  if (!await ensureAnn()) return { ok: false, error: 'the annotation writer did not load' };
  const rec = (window.__bfp && window.__bfp.page) || null;
  const threads = ((rec && rec.threads) || []).filter(t => t && (t.msgs || []).length);
  if (!threads.length) return { ok: false, error: 'no comments on this page to write' };
  const { items, orphaned, already } = collectItems(threads);
  if (!items.length) {
    return { ok: false, error: already && !orphaned
      ? 'every comment here came from this PDF already'
      : 'none of these comments could be placed in the file' };
  }
  const name = Ann.exportFileName(fileName || ownName);
  // THE DIALOG COMES FIRST — see pickSaveFile. Everything below it (half a
  // megabyte of writer, a re-read of the original, the write itself) takes
  // longer than the click's transient activation lasts, and a Save dialog
  // asked for after that activation has gone is not shown at all.
  const dest = await pickSaveFile(name);
  if (dest.cancelled) return { ok: true, cancelled: true, name };
  const lib = await pdfLib();
  const bytes = await sourceBytes();
  const out = await Ann.writeAnnots(lib, bytes, items);
  let where = name;
  if (dest.handle) {
    const w = await dest.handle.createWritable();
    await w.write(out.bytes);
    await w.close();
    where = dest.handle.name || name;
  } else {
    download(out.bytes, name);
  }
  return { ok: true, name: where, picked: !!dest.handle,
           written: out.written, orphaned, already };
}

// ---- where the copy goes ---------------------------------------------------
// The reader chooses the folder. `showSaveFilePicker` is the only API that can
// put a real Save dialog on screen from a page, and it has one hard rule: it
// must be called while the click that asked for it is still live, which is why
// exportAnnotated asks BEFORE it writes anything.
//
// Three answers, and they are not the same answer:
//   a handle      the reader chose a place — write there, and nowhere else
//   cancelled     the reader said no. Nothing is written and NOTHING is
//                 downloaded behind their back: a cancel is a decision.
//   neither       the dialog could not be shown at all (an older browser, a
//                 policy, an activation already spent) — fall back to the
//                 browser's own downloader, which is what this always did.
async function pickSaveFile(name) {
  if (typeof window.showSaveFilePicker !== 'function') return {};
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
    });
    return { handle };
  } catch (e) {
    if (e && e.name === 'AbortError') return { cancelled: true };
    return {};                       // unsupported, refused, or no activation
  }
}

// The file's own bytes. A local PDF has been read once already (it is what its
// identity was computed from) and is not read again; a web PDF is fetched with
// the reader's session, exactly as the render was.
async function sourceBytes() {
  if (localBytes) return new Uint8Array(localBytes);
  const r = await fetch(SRC, { credentials: 'include' });
  if (!r.ok) throw new Error('could not re-read this PDF (' + r.status + ')');
  return new Uint8Array(await r.arrayBuffer());
}

// The fallback, for when no Save dialog could be shown (pickSaveFile): the
// browser's own downloader, from an extension page — a blob, an <a download>
// and a click. No file is written beside the original, no path is guessed, and
// where the copy lands is the reader's own browser setting.
function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { /* gone already */ } }, 30000);
}

// The two doors content.js knocks on. Deliberately narrow: everything else in
// here is this module's own business.
window.__BFP_PDF = {
  get annots() { return window.__BFP_PDF_ANNOTS || []; },
  rescan: scanAnnots,
  exportAnnotated,
  // The export, stopped one step short of writing a file: what would be drawn,
  // where, and what could not be. This is the seam the round-trip test uses —
  // import an annotation, make the thread it makes, and ask for the quads that
  // would go back in.
  async collect(threads) {
    if (!await ensureAnn()) return null;
    return collectItems(threads);
  },
  // observable, for the render test: which library is loaded, and how many
  // pages the document has
  get ready() { return !!pdfDoc; },
};

// ---- boot: identity, annotator, render -------------------------------------
//
// The order is the contract (see the note at the top of this file), so it is
// written here as five plain steps rather than distributed over five <script>
// tags in the HTML.

// Classic scripts, injected in order. `async = false` is not decoration: a
// dynamically inserted script defaults to async, and the chain would then run
// in whatever order the disk answered in — content.js before the drawer it
// needs.
function loadScript(rel) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL(rel, import.meta.url).href;
    s.async = false;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('could not load ' + rel));
    document.head.appendChild(s);
  });
}
async function loadScripts(list) { for (const rel of list) await loadScript(rel); }

// Does this extension have the reader's permission to read files at all? Only
// an extension PAGE can ask (chrome.extension does not exist in a service
// worker), so the answer is also written down where the worker can see it: it
// uses it to decide whether reopening a local PDF in here could possibly work.
function fileSchemeAccess() {
  return new Promise(resolve => {
    try {
      if (chrome && chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
        chrome.extension.isAllowedFileSchemeAccess(a => resolve(!!a));
        return;
      }
    } catch { /* fall through */ }
    resolve(null);                                   // cannot be asked here
  });
}
function rememberFileAccess(allowed) {
  if (allowed == null) return;
  try { chrome.storage.local.set({ 'bfp:file-access': !!allowed }); } catch { /* a hint, not a state */ }
}

// The bytes of a local file. XMLHttpRequest and not fetch(): Chrome's fetch
// refuses the file: scheme outright ("URL scheme must be http or https"),
// while XHR is exactly what the "Allow access to file URLs" toggle governs —
// which is also why a refusal here is a permissions answer and is reported as
// one. A file: response carries status 0 on success, so the RESPONSE is what
// is checked, never the code.
function readLocalFile(url) {
  return new Promise(resolve => {
    let xhr;
    try { xhr = new XMLHttpRequest(); } catch { resolve({ ok: false }); return; }
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      const buf = xhr.response;
      if (buf && buf.byteLength) resolve({ ok: true, bytes: buf });
      else resolve({ ok: false, empty: true });
    };
    xhr.onerror = () => resolve({ ok: false });
    try { xhr.send(); } catch { resolve({ ok: false }); }
  });
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Adapters.bytesToHex(new Uint8Array(digest));
}
const sha256HexText = s => sha256Hex(new TextEncoder().encode(String(s)));

// ---- the byte-hash → identity cache (the fast path) -------------------------
// One object under one key: {"<byteHex>": {ident, at}}. Capped, oldest-touched
// dropped, and everything about it best-effort — a world with no
// chrome.storage (the render test, the harness) simply always misses, and a
// miss only costs the extraction the first open pays anyway.
const IDS_KEY = 'bfp:pdf-ids';
const IDS_MAX = 400;
function readIdsMap() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(IDS_KEY, r => {
        const m = r && r[IDS_KEY];
        resolve(m && typeof m === 'object' ? m : {});
      });
    } catch { resolve({}); }
  });
}
async function cachedIdent(byteHex) {
  if (!byteHex) return '';
  const map = await readIdsMap();
  const hit = map[byteHex];
  const ident = hit && hit.ident;
  // only a shape adapters.js recognises is believed — a hand-mangled store
  // must fall through to a recompute, never become an identity
  return Adapters.isPdfIdentUrl(ident) ? ident : '';
}
async function rememberIdent(byteHex, ident) {
  if (!byteHex || !Adapters.isPdfIdentUrl(ident)) return;
  const map = await readIdsMap();
  map[byteHex] = { ident, at: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > IDS_MAX) {
    keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
    for (const k of keys.slice(0, keys.length - IDS_MAX)) delete map[k];
  }
  try { chrome.storage.local.set({ [IDS_KEY]: map }); } catch { /* a cache, not a state */ }
}

// A local PDF that cannot be read is not a failure to hide: say which of the
// two things it is, offer the file itself as the way out, and stop. Nothing is
// filed, because there is nothing to file it under.
function refuseLocal(reason) {
  $('doc-title').textContent = fileName || 'Could not open';
  $('doc-meta').textContent = '';
  notice(reason + ' <a href="#" id="notice-original">Open it in the browser instead</a>.');
  const a = $('notice-original');
  if (a) a.addEventListener('click', openOriginal);
}

async function boot() {
  // 1. the parser, and nothing else — adapters.js defines globals and acts on
  //    nothing, so loading it before an identity exists is safe.
  try { await loadScript('../adapters.js'); } catch { /* reported below */ }
  Adapters = window.BFPAdapters || null;
  SRC = Adapters ? Adapters.pdfViewerSrc(location.href) : null;
  LOCAL = !!(SRC && Adapters.isFileUrl(SRC));
  // the NAME, not the file name: a title is not "paper.pdf". The file's own
  // name (extension and all) travels separately, as the record's `file_name`.
  fileName = SRC && Adapters ? Adapters.pdfNameFromUrl(SRC) : '';
  setOwnTitle('');

  if (!SRC) {
    $('doc-title').textContent = 'Not a PDF address';
    notice('This viewer needs a <code>?src=</code> pointing at a PDF — an http(s) url, ' +
           'or a <code>file://</code> one on this machine. It is opened for you when you ' +
           'navigate to a PDF.');
    $('original').hidden = true;
    return;
  }

  // 2. the identity. A web PDF has one already: publish, inject, render —
  //    exactly the boot it has always had.
  if (!LOCAL) {
    await publishAndInject(SRC);
    await run();
    return;
  }

  // A local one starts from its bytes, whatever happens next.
  const allowed = await fileSchemeAccess();
  rememberFileAccess(allowed);
  if (allowed === false) { refuseLocal(escapeHtml(FILE_ACCESS_HELP)); return; }
  const got = await readLocalFile(SRC);
  if (!got.ok) {
    // The toggle can be on and the file still unreadable (moved, deleted,
    // renamed while the tab sat open), so both are named rather than guessed
    // between.
    refuseLocal(got.empty
      ? 'This file is empty, or it could not be read.'
      : 'This file could not be read. If it is still there, ' + escapeHtml(FILE_ACCESS_HELP));
    return;
  }
  localBytes = got.bytes;
  let byteHex = '';
  try { byteHex = await sha256Hex(localBytes); } catch { byteHex = ''; }
  if (!byteHex) { refuseLocal('This file could not be identified (its contents would not hash).'); return; }

  // 3a. the fast path: these bytes have been identified before, so the boot is
  //     yesterday's — publish, inject, render, and no extraction at all.
  const known = await cachedIdent(byteHex);
  if (known) {
    await publishAndInject(known);
    await run();
    return;
  }

  // 3b. first sight of these bytes: the TEXT decides. Render first — the
  //     reader sees the paper while it is identified, and the annotator does
  //     not exist yet, so nothing can register under a provisional identity —
  //     then hash the words out of the very DOM the snapshot and the anchors
  //     are built from (one extraction, shared by all three).
  await run();
  let ident = '';
  if (pdfDoc) {
    const norm = Adapters.pdfNormalizedText(Adapters.pdfPagesFromDom(document));
    if (norm) {
      let hex = '';
      try { hex = await sha256HexText(norm); } catch { hex = ''; }
      ident = Adapters.pdfTextUrl(hex);
    }
  }
  // a scan (or a parse that failed outright) keeps the byte-hash identity and
  // its old semantics; only a SUCCESSFUL parse is worth caching — a refused
  // password answered today must not decide the identity for ever
  if (!ident) ident = Adapters.pdfHashUrl(byteHex);
  if (pdfDoc) rememberIdent(byteHex, ident);
  await publishAndInject(ident);
  // the document is already fully rendered, so the freshly injected annotator
  // is told once that there is everything to anchor to
  tellAnnotator();
}

// publish → inject, in that order, always: content.js decides which page it is
// on at parse time, from window.__BFP_PDF_IDENT, and never asks again.
async function publishAndInject(ident) {
  window.__BFP_PDF_IDENT = ident;
  // the file's own name, extension and all — the adapter sends it with the
  // record, and this is here so a reader looking at the page can see it too
  window.__BFP_PDF_FILE = LOCAL ? Adapters.pdfFileName(SRC) : '';
  try { await loadScripts(['../vendor/katex/katex.min.js', '../anchor.js', '../drawer.js', '../content.js']); }
  catch (e) { console.warn('[botference] the annotator did not load:', (e && e.message) || e); }
  watchTitle();
  // the scan may have finished before the annotator existed (the identity-last
  // boot renders first), in which case this is where the offer is delivered
  tellAnnots();
}

boot();
