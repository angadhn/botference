#!/usr/bin/env node
// IS THE EXTENSION IN TOUCH WITH THE COMPANION? — one list of modes, one set
// of words (config.js CONN_MODES / CONN_WORDS), for every layer that keeps or
// shows it. Before: the worker's socket said closed / connecting / open, the
// content script kept fail counters and relayed true/false, and the drawer
// kept `connected`, `connKnown` and `reloadNeeded` with words of its own.
//
//   1. config.js: the list, the moves each mode allows, the words
//   2. the drawer: D.conn, set only through setConn, drawn in those words
//   (the worker's half is test/background-socket.test.mjs)
//
//   node frontends/plugin/test/connmode.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection', 'ResizeObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const CFG = require(path.join(here, '..', 'extension', 'config.js'));
const DR = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---- 1. config.js ------------------------------------------------------------
await test('the modes are named in one list, each with its words', () => {
  assert.deepEqual(CFG.CONN_MODES, ['connecting', 'connected', 'offline', 'reload']);
  assert.deepEqual(Object.keys(CFG.CONN_WORDS).sort(), [...CFG.CONN_MODES].sort());
  for (const m of CFG.CONN_MODES) assert.ok(CFG.CONN_WORDS[m], m);
  assert.match(CFG.CONN_NOTICE.offline, new RegExp('^' + CFG.CONN_WORDS.offline, 'i'),
    'the offline notice opens with the same words as the header');
  assert.match(CFG.CONN_NOTICE.reload, new RegExp(CFG.CONN_WORDS.reload));
});

await test('each move starts only from the modes it names', () => {
  assert.equal(CFG.connMove('connecting', 'reach'), 'connected');
  assert.equal(CFG.connMove('connected', 'fail'), 'offline');
  assert.equal(CFG.connMove('offline', 'retry'), 'connecting');
  assert.equal(CFG.connMove('offline', 'reach'), 'connected');
  for (const m of CFG.CONN_MODES) assert.equal(CFG.connMove(m, 'unload'), 'reload', 'unload from ' + m);
  assert.throws(() => CFG.connMove('offline', 'fail'), /cannot fail while offline/);
  assert.throws(() => CFG.connMove('reload', 'reach'), /cannot reach while reload/, 'reload is final');
  assert.throws(() => CFG.connMove('reload', 'retry'), /cannot retry while reload/);
  assert.throws(() => CFG.connMove('connected', 'shrug'), /no such move/);
  assert.equal(CFG.canConnMove('reload', 'reach'), false);
});

// ---- 2. the drawer -----------------------------------------------------------
let reconnects = 0;
const drawer = DR.create({ cssText: '.panel{}', onReconnect: () => { reconnects++; } });
drawer.open('chat');
drawer.setPage({ url: 'https://example.com/article', title: 'Article', page_chat: [], threads: [] });
await tick(10);
const S = drawer.shadow;
const dot = () => S.querySelector('.conn .ctext').textContent;
const banner = () => S.querySelector('.pane[data-pane="chat"] .notice');

await test('it starts connecting, and says so in the shared words', () => {
  assert.equal(drawer.conn, 'connecting');
  assert.equal(dot(), CFG.CONN_WORDS.connecting);
  assert.equal(banner(), null, 'no verdict yet, so no banner');
});

await test('reach → connected; fail → offline, with the notice and a retry', () => {
  assert.equal(drawer.setConn('reach'), true);
  assert.equal(dot(), CFG.CONN_WORDS.connected);
  assert.equal(drawer.setConn('fail'), true);
  assert.equal(drawer.conn, 'offline');
  assert.equal(dot(), CFG.CONN_WORDS.offline + ' — retry');
  assert.match(banner().textContent, new RegExp(CFG.CONN_NOTICE.offline.slice(0, 20)));
  assert.ok(banner().querySelector('[data-act="retry"]'));
});

await test('retry shows connecting… while it tries, and asks content.js to', async () => {
  banner().querySelector('[data-act="retry"]').click();
  await tick(5);
  assert.equal(reconnects, 1);
  assert.equal(drawer.conn, 'connecting');
  assert.equal(dot(), CFG.CONN_WORDS.connecting);
  drawer.setConn(true);   // true / false are shorthand for reach / fail
  assert.equal(drawer.conn, 'connected');
  assert.equal(banner(), null);
});

await test('a move the mode does not allow is refused, and nothing changes', () => {
  assert.equal(drawer.setConn('nonsense'), false);
  assert.equal(drawer.conn, 'connected');
});

await test('the extension reloaded under the tab: its own words, and final', () => {
  drawer.contextLost();
  assert.equal(drawer.conn, 'reload');
  assert.equal(dot(), CFG.CONN_WORDS.reload);
  assert.match(banner().textContent, new RegExp(CFG.CONN_NOTICE.reload.slice(0, 20)));
  assert.equal(banner().querySelector('[data-act="retry"]'), null, 'nothing to retry');
  assert.equal(drawer.setConn('reach'), false, 'a late answer cannot undo it');
  assert.equal(drawer.conn, 'reload');
});

await test('the old fields are gone', () => {
  for (const k of ['connected', 'connKnown', 'reloadNeeded']) assert.equal(k in drawer, false, k);
});

console.log(`\nconnmode: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
process.exit(0);
