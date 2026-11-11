// drawermodes.test.mjs — more of the drawer's controls whose state was a pile
// of yes/no flags, each now ONE named value changed through ONE function
// (the owner's standing rule: no implicit state machines).
//
//   1. the pop-overs (help, models, export, projects) — were four flags, and
//      two could be up at once; now D.popover (POPOVERS) via setPopover.
//
// Made-up data only.
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

const URL_ = 'https://example.com/article';
const drawer = D.create({
  cssText: '.panel{}',
  onModels: async () => ({ ok: true, current: { claude: 'x' }, options: { claude: ['x'] } }),
  onProjects: async () => ({ projects: [], filed: [], roots: [] }),
});
drawer.setConn(true);
drawer.setAuthor('reader');
drawer.open('comments');
drawer.setPage({ url: URL_, title: 'Article', page_chat: [], threads: [] });
await tick(20);
const root = drawer.shadow;
const click = act => { const b = root.querySelector(`[data-act="${act}"]`); if (b) { b.hidden = false; b.click(); } return !!b; };
const shown = sel => { const e = root.querySelector(sel); return !!e && !e.hidden; };

// ---- 1. the pop-overs: one open at a time -----------------------------------
{
  eq('the pop-overs, named', D.POPOVERS, ['none', 'help', 'models', 'export', 'projects']);
  eq('none open to begin with', drawer.popover, 'none');
  ok('the models button is there', click('models'));
  await tick(10);
  eq('models: open', drawer.popover, 'models');
  ok('…and its panel is up', shown('.popover:not(.helppop)'));
  click('export');
  await tick(10);
  eq('opening export closes models: one value, one pop-over', drawer.popover, 'export');
  ok('…the models panel is down', drawer.el.pop.hidden);
  click('filein');
  await tick(10);
  eq('opening the project picker closes export', drawer.popover, 'projects');
  ok('…the export chooser is down', drawer.el.exportpick.hidden);
  click('models');
  await tick(10);
  eq('and back to models', drawer.popover, 'models');
  ok('…the project picker is down', drawer.el.projpick.hidden);
  click('models');
  await tick(10);
  eq('the same button again closes it', drawer.popover, 'none');
  ok('…its panel is down', drawer.el.pop.hidden);
  drawer.popover = 'nonsense';   // a value from nowhere is read as none
  click('export');
  await tick(10);
  eq('a stray value is replaced, never kept beside a real one', drawer.popover, 'export');
}

console.log(`drawermodes: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
