// pdf-perf.test.mjs — the test that says a TEXTBOOK still opens.
//
//   node frontends/plugin/test/pdf-perf.test.mjs
//
// Every other test here asks whether the answer is right. This one asks
// whether it arrives, on a document the size the reader actually wants to
// annotate: three hundred pages with two hundred and fifty threads spread
// across them, driven through the real viewer, real PDF.js and the real
// extension over CDP — the same rig as pdf-render.test.mjs.
//
// ── WHY IT EXISTS ──────────────────────────────────────────────────────────
// Anchoring was quadratic in the length of the document, twice over, and both
// times for the same reason: a string was built with `+=` and then INDEXED,
// which flattens the rope V8 was building. Nothing about it was visible on an
// article, or on the eighteen-page manuscript every other test uses. On a
// 500-page book a single re-anchor of 300 threads cost about NINETY MINUTES,
// which is not a slow product, it is a product that never finishes opening.
//
// A correctness suite cannot see that: every assertion in the repo still
// passed. So the ceilings below are the guard, and they are set where a
// return of that class of bug is caught by two orders of magnitude while
// ordinary machine-to-machine variation is not. They are NOT benchmarks and
// must never be tightened towards the measured numbers — a flaky perf test is
// a perf test that gets deleted.
//
//   measured on the author's laptop (2026-08-28), 300 pages / 250 threads:
//     whole load, nav → every page box and every highlight painted   2260 ms
//     buildTextIndex over the whole document                           22 ms
//     locate × 25                                                     9.4 ms
//     reanchorAll — the whole page re-anchored and repainted        249 ms
//     Send → the reader's own words visibly in the thread            110 ms
//
// Skips (exit 0, and says so) when there is no Chromium on this machine.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');            // frontends/plugin
// Nothing here imports the companion: this test is about what the TAB costs,
// so there is no workspace to point somewhere safe and nothing to write.

const PAGES = 300;
const THREADS = 250;
const LINES_PER_PAGE = 34;

// ---- the ceilings ----------------------------------------------------------
// Generous by construction: see the note at the top of this file.
const MAX = {
  load: 12000,        // measured 2260
  index: 600,         // measured 22
  locate25: 600,      // measured 9.4
  reanchor: 3000,     // measured 249
  send: 2500,         // measured 432-463 over three runs — see the note below
};
// The Send ceiling has the least headroom of the five, and deliberately so: it
// is not measuring anchoring, it is measuring the DRAWER redrawing its whole
// comment list, which it does a handful of times on the send path (~58 ms a
// rebuild at 250 threads). That is a known cost with a designed fix that is not
// built (SPEC: windowing the comment list), so this ceiling is set to catch the
// list going superlinear rather than to hold the current number.

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
};
const under = (name, got, ceiling) =>
  ok(`${name} — ${got} ms, under the ${ceiling} ms ceiling`,
    typeof got === 'number' && got >= 0 && got < ceiling,
    'took ' + got + ' ms');

const done = () => {
  for (const f of failures) console.log('  ✗ ' + f);
  console.log((fail ? '✗' : '✓') + ` pdf-perf.test.mjs — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

// ---- a document whose every line is known without reading the render -------
const WORDS = ('the invariant of anchor stability under repaint holds while the index is rebuilt '
  + 'between paints because splitting a text node never changes the concatenated text of the page '
  + 'and so an offset taken from an earlier index is still the same offset afterwards which is the '
  + 'whole reason a repaint may proceed one thread at a time without relocating any of them again')
  .split(/\s+/);
const lineText = (p, l) =>
  `Page ${p} line ${l}: ${WORDS[(p * 7 + l * 3) % WORDS.length]} `
  + `${WORDS[(p * 11 + l * 5) % WORDS.length]} ${WORDS[(p * 13 + l * 17) % WORDS.length]} `
  + `— marker p${p}l${l} kappa lambda mu nu`;

const PDFLib = createRequire(import.meta.url)(path.join(ROOT, 'extension', 'vendor', 'pdf-lib', 'pdf-lib.min.js'));
const BOOK = await (async () => {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= PAGES; p++) {
    const page = doc.addPage([612, 792]);
    for (let l = 0; l < LINES_PER_PAGE; l++) {
      page.drawText(lineText(p, l), { x: 54, y: 730 - l * 20, size: 9, font, color: rgb(0.1, 0.1, 0.12) });
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
})();

// ---- and a record with a review's worth of threads on it -------------------
// A realistic mix, because the buckets cost different things to draw: open
// threads, threads a bot has answered ("ready for review"), filed ones in the
// closed archive, and struck passages.
function makeThreads(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = 1 + Math.floor((i * PAGES) / n);
    const l = (i * 7) % LINES_PER_PAGE;
    const line = lineText(p, l);
    const at = line.indexOf('marker');
    const kind = i % 7;
    const t = {
      id: `t-perf-${i}`,
      quote: line.slice(at, at + 24),
      prefix: line.slice(Math.max(0, at - 32), at),
      suffix: line.slice(at + 24, at + 56),
      orphaned: false,
      page: p,
      ...(kind === 3 ? { mark: 'strike' } : {}),
      msgs: [{ author: 'angadh', ts: '2026-08-20T10:00:00.000Z',
        text: `What does this passage on page ${p} actually claim? #${i}` }],
    };
    if (kind === 1 || kind === 5) {
      t.msgs.push({ author: 'claude', ts: '2026-08-20T10:01:00.000Z',
        text: 'It claims that the rebuild is unnecessary between paints, because splitting '
          + 'a text node preserves the concatenated text. '.repeat(3) });
      t.addressed = true;
    }
    if (kind === 2) {
      Object.assign(t, { resolved: true, resolved_at: '2026-08-20T11:00:00.000Z',
        resolved_by: 'angadh', summary_by: 'claude', summary_at: '2026-08-20T11:00:00.000Z',
        summary: 'Asked and answered: the index rebuild between paints is redundant.' });
    }
    out.push(t);
  }
  return out;
}
const RECORD = {
  version: 1, url: '', title: 'A very long manuscript', site: 'perf', kind: 'pdf',
  created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-20T12:00:00.000Z',
  session_id: null, threads: makeThreads(THREADS), page_chat: [],
};

// ---- a static server over frontends/plugin ---------------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream',
  '.woff2': 'font/woff2', '.icc': 'application/octet-stream' };
const BOOK_PATH = '/the-book.pdf';
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(String(req.url).split('?')[0]);
  if (rel === BOOK_PATH) {
    res.writeHead(200, { 'content-type': 'application/pdf', 'accept-ranges': 'bytes' }).end(BOOK);
    return;
  }
  const file = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
                         'accept-ranges': 'bytes' }).end(buf);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
RECORD.url = origin + BOOK_PATH;

// ---- headless Chromium, driven over CDP ------------------------------------
const CHROMES = [
  process.env.BOTFERENCE_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = CHROMES.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!chromePath) {
  console.log('- pdf-perf.test.mjs — skipped (no Chromium found; set BOTFERENCE_CHROME)');
  server.close();
  process.exit(0);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-perf-profile-'));
const DEBUG_PORT = 9222 + Math.floor(Math.random() * 900);
const chrome = spawn(chromePath, [
  // deliberately the OLD headless, as in pdf-render.test.mjs
  '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking',
  '--window-size=1400,1000',
  '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => {
  try { chrome.kill(); } catch { /* already gone */ }
  try { server.close(); } catch { /* already closed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp dir */ }
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
  console.log('- pdf-perf.test.mjs — skipped (Chromium did not open a debuggable page)');
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
  const id = ++msgId; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r && r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');

// The companion, mocked in the page — the same shape background.js proxies.
// This test is about what the TAB costs; the companion has its own suites.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
(() => {
  const RECORD = ${JSON.stringify(RECORD)};
  const okp = data => ({ ok: true, status: 200, data });
  const companion = (method, p, body) => {
    if (method === 'GET' && p.indexOf('/page') === 0) return okp({ page: RECORD });
    if (method === 'GET' && p.indexOf('/index') === 0) return okp({ index: {} });
    if (method === 'POST' && p === '/page') return okp({ page: RECORD });
    if (method === 'POST' && p === '/reply') {
      const t = RECORD.threads.find(x => x.id === (body && body.thread_id));
      if (t) t.msgs.push({ author: 'angadh', ts: new Date().toISOString(), text: (body && body.text) || '' });
      return okp({ page: RECORD, msg: t ? t.msgs[t.msgs.length - 1] : null });
    }
    return okp({});
  };
  window.chrome = {
    runtime: {
      id: 'perf', lastError: null,
      getURL: p => '/extension/' + p,
      connect: () => ({ postMessage(){}, disconnect(){},
        onMessage: { addListener(){} }, onDisconnect: { addListener(){} } }),
      onMessage: { addListener(){}, removeListener(){} },
      sendMessage(msg, cb) {
        let reply = { ok: true };
        switch (msg && msg.t) {
          case 'hello': reply = { ok: true, known: true, threads: RECORD.threads.length,
            connected: true, index: {} }; break;
          case 'get-index': reply = companion('GET', '/index'); break;
          case 'api': reply = companion(msg.method, msg.path, msg.body); break;
          case 'identity': reply = { ok: true, handle: 'angadh', is_owner: true,
            base: 'http://127.0.0.1:4189', remote: false, auth: false }; break;
        }
        if (cb) setTimeout(() => cb(reply), 0);
      },
    },
    storage: { local: {
      get: (k, cb) => (cb ? cb({}) : Promise.resolve({})),
      set: (o, cb) => (cb ? cb() : Promise.resolve()),
      remove: (k, cb) => (cb ? cb() : Promise.resolve()),
    } },
  };
})();` });

const src = origin + BOOK_PATH;
const navAt = Date.now();
await send('Page.navigate', { url: origin + '/extension/pdf/viewer.html?src=' + encodeURIComponent(src) });

// ---- (a) THE LOAD ----------------------------------------------------------
// Not "the first page is up" — every page box laid out AND every thread's
// highlight painted, which is the moment the reader can actually use the
// document. (A seventh of the threads are filed and painted green; all of them
// are painted, so the count is the whole record.)
let state = null, loadMs = 0;
const DEADLINE = MAX.load + 20000;   // enough rope to report a real number
while (Date.now() - navAt < DEADLINE) {
  await sleep(200);
  state = await evaluate(`(() => {
    const b = window.__bfp;
    return {
      boxes: document.querySelectorAll('[data-bfp-pdf-page]').length,
      marks: new Set(Array.from(document.querySelectorAll('mark.bfp-hl[data-bfp]'))
        .map(m => m.getAttribute('data-bfp'))).size,
      threads: b && b.page ? (b.page.threads || []).length : -1,
    };
  })()`);
  if (state && state.boxes >= PAGES && state.marks >= THREADS) { loadMs = Date.now() - navAt; break; }
}
ok('every page of a 300-page book is laid out', !!(state && state.boxes === PAGES),
  'boxes ' + JSON.stringify(state));
ok('…and all 250 threads found their passage and were painted',
  !!(state && state.marks === THREADS), 'marks ' + JSON.stringify(state));
under('a 300-page book with 250 threads is READY', loadMs || (Date.now() - navAt), MAX.load);

// ---- the primitives, each on its own ---------------------------------------
// Timed separately so a regression names itself instead of showing up as one
// slow number with three possible causes.
const prim = await evaluate(`(() => {
  const b = window.__bfp, A = window.BFPAnchor, out = {};
  let t = performance.now();
  const idx = A.buildTextIndex(document.body);
  out.index = +(performance.now() - t).toFixed(1);
  out.chars = idx.raw.length;
  out.segs = idx.segs.length;
  t = performance.now();
  let hits = 0;
  for (const th of b.page.threads.slice(0, 25)) if (A.locate(idx.raw, th).ok) hits++;
  out.locate25 = +(performance.now() - t).toFixed(1);
  out.hits = hits;
  t = performance.now();
  b.reanchorAll();
  out.reanchor = +(performance.now() - t).toFixed(1);
  out.marks = new Set(Array.from(document.querySelectorAll('mark.bfp-hl[data-bfp]'))
    .map(m => m.getAttribute('data-bfp'))).size;
  out.orphans = b.page.threads.filter(x => x.orphaned).length;
  return out;
})()`);
ok('the whole book is one text index', !!(prim && prim.chars > 500000),
  JSON.stringify(prim));
under('reading the whole document into a text index', prim.index, MAX.index);
under('locating 25 threads in it', prim.locate25, MAX.locate25);
ok('…and all 25 were found', prim.hits === 25, 'found ' + prim.hits);
under('re-anchoring and repainting every one of 250 threads', prim.reanchor, MAX.reanchor);
ok('a repaint leaves every thread painted and none orphaned',
  prim.marks === THREADS && prim.orphans === 0, JSON.stringify(prim));

// ---- (b) THE SEND ----------------------------------------------------------
// From the click to the reader's own words being IN the thread. The drawer
// appends optimistically, so this is the drawer's redraw at 250 threads and
// nothing else — which is exactly the thing that must not grow with the book.
const sent = await evaluate(`(async () => {
  const b = window.__bfp, d = b.drawer, sh = d.shadow;
  d.open('comments');
  await new Promise(r => setTimeout(r, 400));
  const t = b.page.threads[Math.floor(b.page.threads.length / 2)];
  const ta = sh.querySelector('[data-thread="' + t.id + '"] .composer textarea')
    || sh.querySelector('.card .composer textarea');
  if (!ta) return { err: 'no composer to type into' };
  const WORDS = 'A timed reply, written into the middle of a long book.';
  ta.value = WORDS;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = ta.closest('.composer').querySelector('button[data-act="send"], .send');
  if (!btn) return { err: 'no send button' };
  const t0 = performance.now();
  btn.click();
  for (let i = 0; i < 600; i++) {
    await new Promise(r => setTimeout(r, 5));
    if (sh.textContent.indexOf(WORDS) >= 0) return { ms: +(performance.now() - t0).toFixed(1) };
  }
  return { err: 'the message never appeared' };
})()`);
ok('a Send on a 250-thread page puts the words in the thread', !sent.err, sent.err || '');
if (!sent.err) under('Send → the reader sees their own comment filed', sent.ms, MAX.send);

console.log(`  (300 pages, ${THREADS} threads: load ${loadMs} ms · index ${prim.index} ms · `
  + `locate×25 ${prim.locate25} ms · reanchor ${prim.reanchor} ms · send ${sent.ms} ms)`);
done();
