// studiocopy.test.mjs — the drawer's "Copy for Blygger Studio" action.
//
//   node frontends/plugin/test/studiocopy.test.mjs
//
// happy-dom stands in for the browser; the companion is one stubbed callback
// that answers with the REAL pure function's output (studio-paste.mjs), so
// "copies exactly the function's output" is checked against the function.
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-studiocopy-'));
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
const { renderStudioPaste } = await import('../studio-paste.mjs');
const F = await import('./fixtures/export-pages.mjs');

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + String(detail).slice(0, 600) : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const CFG = { author: F.READER };
const PAGE = (page => { page.threads.forEach((t, i) => { t.id = 't' + i; t.ts = 't' + i; (t.msgs || []).forEach((m, j) => { m.id = `m${i}-${j}`; }); }); return page; })(F.blygPage([
  { quote: F.P1, blyg: F.stamp(), msgs: [F.me('Agreed, with a [TK] caveat.'), F.bot('An answer.')] },
  { quote: 'an ordinary line', msgs: [] },
], [], { export_response: 'response' }));

// the clipboard, as a page can have it
const clip = { writes: [] };
function withClipboard(impl) { Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: impl }); }

function make(extra = {}) {
  const calls = { studio: [], export: [] };
  const drawer = D.create({ isTrusted: () => true,
    cssText: '.panel{}',
    onModels: async () => ({ ok: true, current: {}, options: {} }),
    onBlygCheck: async () => ({ ok: true, status: 'not-a-blyg' }),
    onExport: async mode => { calls.export.push(mode); return { ok: true, path: '/vault/x.md' }; },
    onExportStudio: async mode => { calls.studio.push(mode);
      return { ok: true, text: renderStudioPaste(PAGE, CFG, mode, {}), left_out: [], gaps: null }; },
    ...extra,
  });
  drawer.setConn(true); drawer.setAuthor(F.READER);
  drawer.open('comments');
  drawer.setPage(PAGE);
  return { drawer, calls };
}
const openChooser = async drawer => { drawer.shadow.querySelector('[data-act="export"]').click(); await tick(10); };
const row = drawer => drawer.shadow.querySelector('.exportpick [data-mode="studio"]');

// ---- the action is in the chooser, as a destination ------------------------------------
{
  const { drawer } = make();
  await tick(10);
  await openChooser(drawer);
  ok('the chooser offers "Copy for Blygger Studio"', row(drawer) && /Copy for Blygger Studio/.test(row(drawer).textContent), row(drawer) && row(drawer).textContent);
  ok('…and says it is the clipboard only', /clipboard only/.test(row(drawer).textContent));
  eq('the two Obsidian modes are still there, untouched', [...drawer.shadow.querySelectorAll('.exportpick [data-mode]')].map(b => b.dataset.mode).filter(m => m !== 'studio'),
    ['comments', 'all']);
  drawer.setPage({ url: 'bfp://library', title: 'Library', threads: [], page_chat: [] });
  await tick(10);
  await openChooser(drawer);
  if (drawer.popover !== 'export') await openChooser(drawer);
  ok('not offered in the library, which has no page to quote', drawer.popover === 'export' && !row(drawer));
}

// ---- it copies exactly what the function wrote ------------------------------------------
{
  const { drawer, calls } = make();
  const written = [];
  withClipboard({ writeText: async t => { written.push(t); } });
  await tick(10);
  await openChooser(drawer);
  row(drawer).click();
  await tick(30);
  const mode1 = drawer.exportMode;
  const want = renderStudioPaste(PAGE, CFG, mode1, {});
  eq('the clipboard holds exactly the function\'s output, once', written, [want]);
  ok('…and that output is the Studio paste (a directive with its passage, a stub note)',
    want.includes(`![[${F.POST_ID} | On Scheduling]]\n> ${F.P1}`) && want.startsWith('/* STUB THIS POST:'), want.slice(0, 200));
  eq('the footbar confirms, as information', [drawer.footNote.mode, /^copied for Blygger Studio \(\d+ characters\): paste it into a new draft$/.test(drawer.footNote.text)], ['info', true]);
  eq('the characters it counts are the text\'s own', drawer.footNote.text.match(/\((\d+) characters\)/)[1], String(want.length));
  eq('it asked the companion once, in the remembered export mode, and wrote nothing to the vault', [calls.studio, calls.export], [[drawer.exportMode], []]);
  eq('the chooser has closed', drawer.popover, 'none');
  // "my notes and the agents' replies": the mode travels, the text is whatever the function made for it
  const mode2 = mode1 === 'all' ? 'comments' : 'all';
  drawer.setExportMode(mode2);
  await openChooser(drawer);
  row(drawer).click();
  await tick(30);
  eq('in the other mode, exactly that mode\'s output', written[1], renderStudioPaste(PAGE, CFG, mode2, {}));
  const withAgents = [written[0], written[1]].find((_, i) => (i ? mode2 : mode1) === 'all');
  ok('…and "my notes and the agents\' replies" is the one that holds the agent\'s words',
    withAgents.includes('[TK]impyrt=') && !written.find((_, i) => (i ? mode2 : mode1) === 'comments').includes('impyrt'));
}

// ---- when it cannot copy, it says so ------------------------------------------------------------
{
  const { drawer } = make();
  withClipboard({ writeText: async () => { throw new Error('denied'); } });
  await tick(10);
  await openChooser(drawer);
  row(drawer).click();
  await tick(30);
  eq('a refused clipboard is an error, not a confirmation', drawer.footNote.mode, 'error');
  ok('…that says nothing was copied', /nothing was copied/.test(drawer.footNote.text), drawer.footNote.text);
}
{
  const { drawer } = make({ onExportStudio: async () => ({ ok: false, error: 'nothing to copy yet: highlight a passage or write a comment first' }) });
  let wrote = 0;
  withClipboard({ writeText: async () => { wrote++; } });
  await tick(10);
  await openChooser(drawer);
  row(drawer).click();
  await tick(30);
  eq('a companion that refuses is shown, and nothing is copied', [drawer.footNote.mode, drawer.footNote.text, wrote],
    ['error', 'nothing to copy yet: highlight a passage or write a comment first', 0]);
}
{
  const { drawer } = make({ onExportStudio: async () => ({ ok: true, text: 'x', left_out: ['the page chat was not copied'], gaps: { filled: 0, unfilled: 2 } }) });
  withClipboard({ writeText: async () => {} });
  await tick(10);
  await openChooser(drawer);
  row(drawer).click();
  await tick(30);
  eq('what was left out, and gaps Studio can fill, are said beside the confirmation', [drawer.footNote.mode,
    /the page chat was not copied/.test(drawer.footNote.text), /2 gaps not filled, Studio can fill them/.test(drawer.footNote.text)], ['warning', true, true]);
}
{
  // no async clipboard at all (a plain http page): the drawer's own textarea path
  const { drawer } = make();
  withClipboard(undefined);
  const copied = [];
  const realExec = document.execCommand;
  document.execCommand = () => true;
  await tick(10);
  await openChooser(drawer);
  row(drawer).click();
  await tick(30);
  document.execCommand = realExec;
  eq('without navigator.clipboard the legacy path is used, and confirms', drawer.footNote.mode, 'info');
}

console.log(`studiocopy: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(fail ? 1 : 0);
