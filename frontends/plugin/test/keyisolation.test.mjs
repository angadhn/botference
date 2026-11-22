// Keys typed into the drawer stay in the drawer. A key pressed in a composer
// leaves the shadow root with its target rewritten to the host, so a page
// cannot tell it was typed into a text box and runs its own shortcut (on
// YouTube, Space paused the video and "/" moved the focus to the site's
// search). The host stops keydown / keypress / keyup after the drawer's own
// listeners have run; a capture-phase listener on the document (which is how
// content.js listens for its own keys) still sees every key.
//
//   node frontends/plugin/test/keyisolation.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/watch' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'CustomEvent', 'KeyboardEvent']) {
  try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
}
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await tick(5); } return true; };

const drawer = D.create({
  cssText: '.panel{}',
  capabilities: { highlights: true, strike: true },
  onSave: async () => ({ ok: true, id: 't1' }),
});
drawer.setConn(true);
drawer.setPage({ url: 'https://example.com/watch', title: 'A video', threads: [], page_chat: [] });
await tick(20);
drawer.beginNew({ quote: 'a passage', prefix: '', suffix: '', mark: 'highlight' }, {});
const root = () => drawer.shadow || (drawer.host && drawer.host.shadowRoot) || null;
const box = () => root() && root().querySelector('.card.pending textarea');
ok('the composer is drawn', await until(() => !!box()));

const seen = { page: [], capture: [], inside: [] };
for (const type of ['keydown', 'keypress', 'keyup']) {
  w.document.addEventListener(type, e => seen.page.push(type + ':' + e.key));
  w.addEventListener(type, e => seen.page.push('window:' + type + ':' + e.key));
  w.document.addEventListener(type, e => seen.capture.push(type + ':' + e.key), true);
  root().addEventListener(type, e => seen.inside.push(type + ':' + e.key));
}
const press = (target, key) => {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    target.dispatchEvent(new w.KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true }));
  }
};

for (const key of [' ', '/', 'k', 'f', 'ArrowLeft', 'j']) press(box(), key);
ok('the page hears none of the keys typed into the composer', seen.page.length === 0, seen.page.join(' '));
ok('the drawer itself still hears every one', seen.inside.length === 18, String(seen.inside.length));
ok('a capture-phase listener on the document still hears every one', seen.capture.length === 18, String(seen.capture.length));

// a button in the drawer is the same: Space on it must not pause the page's video
seen.page.length = 0;
const button = root().querySelector('button');
if (button) press(button, ' ');
ok('nor a key pressed on one of the drawer\'s buttons', !!button && seen.page.length === 0, seen.page.join(' '));

// keys pressed on the page itself are the page's own
seen.page.length = 0;
press(w.document.body, ' ');
ok('a key pressed on the page still reaches the page', seen.page.length === 6, String(seen.page.length));

console.log(`keyisolation: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map(f => '  ✗ ' + f).join('\n')); process.exit(1); }
process.exit(0);
