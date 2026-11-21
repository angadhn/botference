// blygdrawer.test.mjs — the drawer's quiet line for a Blygger post, and the
// one field that says what the drawer knows about the page (D.blyg.mode, one
// of config.js BLYG_MODES, moved only by blygSet).
//
//   node frontends/plugin/test/blygdrawer.test.mjs
//
// happy-dom stands in for the browser; the companion is one stubbed callback.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection', 'ResizeObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const POST_URL = 'https://venkateshrao.com/blyg/t/27x0ewgc6yqq0h9e2n9g16me8n';
const ANSWER = { ok: true, status: 'blyg', site: { origin: 'https://venkateshrao.com/blyg/', title: "Venkatesh Rao's Blyg", author: 'Venkatesh Rao' },
  item: { origin: 'https://venkateshrao.com/blyg/', id: '27x0ewgc6yqq0h9e2n9g16me8n', kind: 'thread', version: 2, latest: 2,
    pinned: false, pinned_versions: [], page: POST_URL + '/', pinned_page: '', source: "Venkatesh Rao's Blyg", author: 'Venkatesh Rao' } };

function make(answers) {
  const asked = [];
  const pending = [];
  const drawer = D.create({
    cssText: '.panel{}',
    onModels: async () => ({ ok: true, current: {}, options: {} }),
    onBlygCheck: () => { asked.push(drawer.page && drawer.page.url); const a = answers.shift();
      return typeof a === 'function' ? new Promise(r => pending.push(() => r(a()))) : Promise.resolve(a); },
  });
  drawer.setConn(true);
  drawer.setAuthor('reader');
  return { drawer, asked, pending, line: () => drawer.shadow.querySelector('.hdr .blyg') };
}

// ---- a post -------------------------------------------------------------------
{
  const { drawer, asked, line } = make([ANSWER]);
  drawer.setPage({ url: POST_URL, title: 'It’s the Liveness, Stupid', threads: [], page_chat: [] });
  eq('before the drawer opens: nothing asked, mode unknown', [asked.length, drawer.blyg.mode], [0, 'unknown']);
  drawer.open('comments');
  await tick(10);
  eq('opening asks once and settles', [asked.length, drawer.blyg.mode], [1, 'blyg']);
  ok('the header says so, quietly', !line().hidden && line().textContent === 'blyg · v2 · Venkatesh Rao', line().textContent);
  ok('…and the tooltip says what it means', /version 2/.test(line().title) && /quotes them by reference/.test(line().title), line().title);
  drawer.close(); drawer.open(); await tick(10);
  eq('reopening does not ask again', asked.length, 1);
  drawer.setPage({ url: POST_URL, title: 'It’s the Liveness, Stupid', threads: [], page_chat: [] });
  await tick(10);
  eq('a refresh of the same page does not ask again', asked.length, 1);
}

// ---- pinned ---------------------------------------------------------------------
{
  const pinned = { ...ANSWER, item: { ...ANSWER.item, pinned: true, pinned_versions: [2] } };
  const { drawer, line } = make([pinned]);
  drawer.setPage({ url: POST_URL, title: 'x', threads: [], page_chat: [] });
  drawer.open(); await tick(10);
  eq('a pinned version says so', line().textContent, 'blyg · v2 pinned · Venkatesh Rao');
}

// ---- everything that is not a post shows what the drawer always showed --------
for (const status of ['not-a-blyg', 'blyg-site', 'check-failed']) {
  const { drawer, line } = make([{ ok: true, status, reason: 'x' }]);
  drawer.setPage({ url: 'https://example.com/a', title: 'A', threads: [], page_chat: [] });
  drawer.open(); await tick(10);
  eq(`${status}: settled`, drawer.blyg.mode, status);
  ok(`${status}: nothing shown`, line().hidden && line().textContent === '');
}
{
  const { drawer } = make([{ ok: false, error: 'companion offline' }]);
  drawer.setPage({ url: 'https://example.com/b', title: 'B', threads: [], page_chat: [] });
  drawer.open(); await tick(10);
  eq('the companion could not be asked: check-failed', drawer.blyg.mode, 'check-failed');
  const { drawer: d2 } = make([{ ok: true, status: 'something new' }]);
  d2.setPage({ url: 'https://example.com/c', title: 'C', threads: [], page_chat: [] });
  d2.open(); await tick(10);
  eq('an answer that is not a mode is not believed', d2.blyg.mode, 'check-failed');
}

// ---- the answer comes later, on the page record -----------------------------------
{
  const { drawer, line } = make([{ ok: true, status: 'checking' }]);
  drawer.setPage({ url: POST_URL, title: 'x', threads: [], page_chat: [] });
  drawer.open(); await tick(10);
  eq('still being asked when the companion replied', drawer.blyg.mode, 'checking');
  drawer.setPage({ url: POST_URL, title: 'x', threads: [], page_chat: [],
    blyg: { status: 'blyg', checked: '2000-01-01T00:00:00.000Z', item: ANSWER.item } });
  eq('an answer older than the asking is not taken', drawer.blyg.mode, 'checking');
  drawer.setPage({ url: POST_URL, title: 'x', threads: [], page_chat: [],
    blyg: { status: 'blyg', checked: new Date(Date.now() + 1000).toISOString(), site: ANSWER.site, item: ANSWER.item } });
  eq('the page record\'s fresh answer settles it', drawer.blyg.mode, 'blyg');
  eq('…and the line appears', line().textContent, 'blyg · v2 · Venkatesh Rao');
}

// ---- a late answer for a page the tab has left ---------------------------------------
{
  const { drawer, asked, pending, line } = make([() => ANSWER, { ok: true, status: 'not-a-blyg' }]);
  drawer.setPage({ url: POST_URL, title: 'x', threads: [], page_chat: [] });
  drawer.open(); await tick(10);
  eq('asking', drawer.blyg.mode, 'checking');
  drawer.setPage({ url: 'https://example.com/elsewhere', title: 'Elsewhere', threads: [], page_chat: [] });
  await tick(10);
  eq('the tab moved on: the new page is asked about', [asked.length, drawer.blyg.mode], [2, 'not-a-blyg']);
  pending.shift()();
  await tick(10);
  eq('the old page\'s late answer changes nothing', drawer.blyg.mode, 'not-a-blyg');
  ok('…and shows nothing', line().hidden);
}

// ---- the library is never asked about ------------------------------------------------
{
  const { drawer, asked } = make([ANSWER]);
  drawer.setPage({ url: 'bfp://library', title: 'Library', threads: [], page_chat: [] });
  drawer.open(); await tick(10);
  eq('library: not asked', [asked.length, drawer.blyg.mode], [0, 'unknown']);
}

for (const f of failures) console.log('  FAIL ' + f);
console.log(`blygdrawer: ${pass} passed, ${fail} failed`);
process.exit(fail);
