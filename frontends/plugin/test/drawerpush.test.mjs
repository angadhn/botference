// drawerpush.test.mjs — how the drawer sits against the page: the layout MODE (overlay | push), the one rule for where push falls back,
// and that the style changes push makes are made and undone exactly. happy-dom has no layout, so what needs measuring (a right-anchored
// fixed element ending up left of the drawer, the page's width) is in drawerpush-browser.test.mjs, which runs a real headless browser.
//
//   node frontends/plugin/test/drawerpush.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article', width: 1300, height: 800 });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection', 'ResizeObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const CFG = require(path.join(here, '..', 'extension', 'config.js'));
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const throws = (name, fn) => { try { fn(); ok(name, false, 'did not throw'); } catch (_) { ok(name, true); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---- the mode list and the function that moves it ----------------------------------------------
eq('the layouts, named', CFG.LAYOUT_MODES, ['overlay', 'push']);
eq('push is the default', CFG.DEFAULT_LAYOUT, 'push');
eq('layoutMove accepts overlay', CFG.layoutMove('push', 'overlay'), 'overlay');
eq('layoutMove accepts push', CFG.layoutMove('overlay', 'push'), 'push');
throws('layoutMove refuses an unknown mode', () => CFG.layoutMove('push', 'dock'));
throws('layoutMove refuses nothing', () => CFG.layoutMove('push', undefined));
eq('a stored value that is not a mode reads as the default', CFG.layoutOf('sideways'), 'push');

// ---- the one fallback rule ---------------------------------------------------------------------
const env = (o = {}) => ({ protocol: 'https:', framed: false, innerWidth: 1300, width: 420, ...o });
eq('push on an ordinary wide page', CFG.layoutFor('push', env()), 'push');
eq('overlay is asked for: overlay', CFG.layoutFor('overlay', env()), 'overlay');
eq('the extension\'s own PDF viewer page: overlay', CFG.layoutFor('push', env({ protocol: 'chrome-extension:' })), 'overlay');
eq('a frame: overlay', CFG.layoutFor('push', env({ framed: true })), 'overlay');
eq('exactly drawer + 320 wide: push', CFG.layoutFor('push', env({ innerWidth: 740 })), 'push');
eq('one pixel narrower than drawer + 320: overlay', CFG.layoutFor('push', env({ innerWidth: 739 })), 'overlay');
eq('an unreadable window width: overlay', CFG.layoutFor('push', env({ innerWidth: NaN })), 'overlay');
eq('a bad choice is read as the default (push)', CFG.layoutFor('dock', env()), 'push');

// ---- the choice is stored with the other options -----------------------------------------------
{
  const mem = {};
  const area = { get: (keys, cb) => cb(Object.fromEntries([].concat(keys).map(k => [k, mem[k]]))), set: (o, cb) => { Object.assign(mem, o); cb(); } };
  eq('nothing stored: push', (await CFG.readConfig(area)).layout, 'push');
  await CFG.writeConfig({ layout: 'overlay' }, area);
  eq('stored with the options, under its key', mem[CFG.KEYS.layout], 'overlay');
  eq('and read back', (await CFG.readConfig(area)).layout, 'overlay');
  await CFG.writeConfig({ layout: 'nonsense' }, area);
  eq('a bad value is never written', mem[CFG.KEYS.layout], 'push');
}

// ---- the drawer: one field, one function, styles made and undone exactly -----------------------
const root = document.documentElement;
root.setAttribute('style', 'background: #fff;');
const fixedBtn = document.createElement('button');
fixedBtn.setAttribute('style', 'position:fixed;top:8px;right:12px');
document.body.appendChild(fixedBtn);
const bare = document.createElement('div');   // no style attribute at all
document.body.appendChild(bare);
const snap = () => JSON.stringify([root.getAttribute('style'), fixedBtn.getAttribute('style'), bare.getAttribute('style')]);

const make = () => { const d = D.create({ isTrusted: () => true, cssText: '.panel{}' }); d.setConn(true); d.setAuthor('reader'); return d; };

{
  const before = snap();
  const d = make();
  eq('the drawer starts in push', d.layout, 'push');
  throws('the drawer refuses an unknown layout', () => d.setLayout('dock'));
  eq('…and keeps the one it had', d.layout, 'push');
  d.open('comments'); await tick(30);
  const W = d.layoutNow();
  eq('push applies on a wide window', W, 'push');
  ok('open in push: the root has a margin-right of the drawer\'s width', /margin-right:\s*\d+px\s*!important/.test(root.getAttribute('style') || ''), root.getAttribute('style'));
  ok('the page\'s own root style survives alongside', /background:\s*#fff/.test(root.getAttribute('style')));
  d.close(); await tick(30);
  eq('close: every style attribute is byte for byte what it was', snap(), before);
  eq('…and the page is no longer pushed', d.layoutNow(), 'push');

  // switching to overlay while open lifts the push at once; switching back puts it again
  d.open('comments'); await tick(30);
  d.setLayout('overlay');
  eq('overlay while open: the root is as it was', snap(), before);
  d.setLayout('push');
  ok('back to push while open: narrowed again', /margin-right/.test(root.getAttribute('style')));
  d.close(); await tick(30);
  eq('closed again: as it was', snap(), before);

  // overlay from the start leaves the page untouched all the way through
  d.setLayout('overlay');
  d.open('comments'); await tick(30);
  eq('overlay: opening writes nothing on the page', snap(), before);
  d.close(); await tick(30);
  eq('overlay: closing writes nothing either', snap(), before);

  // the extension lost: a page that is pushed is let go
  d.setLayout('push'); d.open('comments'); await tick(30);
  ok('pushed again', /margin-right/.test(root.getAttribute('style')));
  d.contextLost();
  eq('the extension lost: the page is not left narrowed', snap(), before);
  d.close();

  // the page's own edit of the root's style while pushed is kept; only what the push wrote goes
  d.open('comments'); await tick(30);
  root.style.setProperty('color', 'red');
  d.close(); await tick(30);
  ok('a page edit made while pushed survives the close', /color:\s*red/.test(root.getAttribute('style')) && !/margin-right/.test(root.getAttribute('style')), root.getAttribute('style'));
  root.setAttribute('style', 'background: #fff;');
}

{
  // a narrow window: push falls back to overlay and the page is untouched
  const before = snap();
  const d = make();
  const was = window.innerWidth;
  window.innerWidth = 600;
  d.open('comments'); await tick(30);
  eq('a narrow window: overlay', d.layoutNow(), 'overlay');
  eq('…and nothing on the page was changed', snap(), before);
  d.close(); await tick(30);
  window.innerWidth = was;
  eq('…nor by closing', snap(), before);
}

console.log(`drawerpush: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  FAIL ' + f); process.exit(1); }
process.exit(0);
