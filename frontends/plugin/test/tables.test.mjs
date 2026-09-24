// The drawer draws a GFM table as a real <table> — the council page already
// did; the drawer showed one paragraph of pipes. happy-dom stands in for the
// browser; drawer.js is loaded after the DOM globals exist.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// happy-dom lives in the repo's tests/node_modules (cd tests && npm install)
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'http://localhost/' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document') globalThis[k] = w[k] ?? w;
}
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };

const src = 'Roughly 100 times more raw AI math.\n\n'
  + '| | MVP | Mac Studio |\n|---|---|---|\n| Memory | 128 GB | up to 512 GB |\n| Power | ~1 kW | ~300 W |\n\n'
  + 'Caveats: peak numbers.\n- [ ] check the M5 figures';
const frag = D.renderMarkdown(src, false);
const host = w.document.createElement('div'); host.appendChild(frag);
const table = host.querySelector('table');
ok('a table is drawn', !!table);
ok('header cells', table && table.querySelectorAll('thead th').length === 3, table && String(table.querySelectorAll('thead th').length));
ok('body rows', table && table.querySelectorAll('tbody tr').length === 2);
ok('cell text', table && /512 GB/.test(table.querySelectorAll('tbody tr')[0].textContent));
ok('the paragraph before it is its own block', host.querySelector('p') && /raw AI math/.test(host.querySelector('p').textContent));
ok('the paragraph after it survives', /Caveats/.test(host.textContent));
ok('a checklist after the table still renders', host.querySelectorAll('input.md-tick').length === 1);
ok('no pipes leak into prose', !/\|/.test(host.textContent));
const solo = w.document.createElement('div'); solo.appendChild(D.renderMarkdown('a | b\nplain text', false));
ok('a lone pipe line is not a table', !solo.querySelector('table'));

console.log(`tables: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
