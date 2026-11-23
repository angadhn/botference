// drawerclosed.test.mjs — the drawer's shadow root is closed, and nothing in it acts on a click or key a page made up.
//
//   node frontends/plugin/test/drawerclosed.test.mjs
//
// A hostile page used to reach `host.shadowRoot` (it was open), read the drawer, plant a button with any `data-act` and dispatch a click:
// delete page records, send comments, publish, change roots. Now the root is closed (host.shadowRoot is null) AND every delegated handler
// that acts refuses an event that is not trusted. The browser sets isTrusted and a script cannot; happy-dom has no real clicks, so the
// drawer takes the test's answer through opts.isTrusted (a drawer given none, as in the shipped extension, asks the event itself).
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
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const URL_ = 'https://example.com/article';
const THR = 'thr-1';
const msgs = n => Array.from({ length: n }, (_, i) => ({ ts: `2026-11-11T10:${String(i).padStart(2, '0')}:00.000Z`, author: i % 2 ? 'claude' : 'reader', text: `thread message ${i}` }));
const rec = () => ({ url: URL_, title: 'Article', page_chat: [], threads: [{ id: THR, quote: 'a passage', msgs: msgs(4) }] });

function make(extra) {
  for (const h of [...w.document.querySelectorAll('#bfp-root')]) h.remove();   // one drawer in the page at a time
  const calls = { del: [], save: [], edit: [], reply: [] };
  const d = D.create({
    cssText: '.panel{}',
    onDeletePage: async url => { calls.del.push(url); return { ok: true }; },
    onSave: async (...a) => { calls.save.push(a); return { ok: true, id: 't1' }; },
    onReply: async (...a) => { calls.reply.push(a); return { ok: true }; },
    onEdit: async (target, ts, text) => { calls.edit.push({ target, ts, text }); return { ok: true }; },
    ...extra,
  });
  d.setConn(true); d.setAuthor('reader'); d.open('comments'); d.setPage(rec());
  return { d, calls };
}
const plant = (d, act, attrs = {}) => {
  const b = w.document.createElement('button');
  b.setAttribute('data-act', act);
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  d.shadow.appendChild(b);
  return b;
};

// ---- the root is closed ---------------------------------------------------------------------------------------------------------------
{
  const { d } = make({});
  await tick(20);
  ok('the drawer is mounted', !!d.host && d.host.isConnected);
  ok('host.shadowRoot is null: a page that holds the host cannot reach inside', d.host.shadowRoot === null);
  ok('…by the document too', w.document.getElementById('bfp-root').shadowRoot === null);
  ok('the root is kept on the drawer object, in its own world, for its own code', !!d.shadow && typeof d.shadow.querySelector === 'function');
  const src = (await import('node:fs')).readFileSync(path.join(here, '..', 'extension', 'drawer.js'), 'utf8');
  ok("attachShadow is only ever called with mode 'closed'", /attachShadow\(\{ mode: 'closed' \}\)/.test(src) && !/mode: 'open'/.test(src));
  ok('nothing writes the root onto the host or a global', !/host\.shadow|window\.[A-Za-z_$]*[sS]hadow|globalThis\.[A-Za-z_$]*[sS]hadow/.test(src.replace(/\/\/.*$/gm, '')));
}

// ---- a drawer that asks the event (the shipped one): a click or key a script made does nothing ------------------------------------------
{
  const { d, calls } = make({});            // no opts.isTrusted
  await tick(20);
  const del = plant(d, 'page-del-yes', { 'data-url': 'https://example.com/victim' });
  del.click();
  await tick(10);
  ok('a synthetic click on a planted page-del-yes deletes nothing', calls.del.length === 0, JSON.stringify(calls.del));
  for (const act of ['send', 'publish', 'edit-save', 'del-thread-yes', 'blog-root', 'council-root']) plant(d, act, { 'data-target': THR }).click();
  await tick(10);
  ok('…nor does any other planted action send, publish or delete', calls.save.length === 0 && calls.reply.length === 0 && calls.del.length === 0 && calls.edit.length === 0);
  // a change that would save a setting
  const sel = w.document.createElement('select');
  sel.setAttribute('data-agent', 'claude'); sel.innerHTML = '<option value="x">x</option>'; sel.value = 'x';
  d.el.pop.appendChild(sel);
  let picked = 0; d.shadow.addEventListener('change', () => { picked++; });
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok('a made-up change event reaches the root but is not acted on (no model request)', picked === 1);
  // Enter-to-send: ⌘↩ typed (synthetically) into a composer sends nothing
  d.beginNew({ quote: 'a passage', prefix: '', suffix: '', mark: 'highlight' }, {});
  await tick(20);
  const ta = d.shadow.querySelector('.card.pending textarea');
  ta.value = 'a comment a page typed for the person';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  ta.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  await tick(20);
  ok('a synthetic ⌘↩ sends no comment', calls.save.length === 0 && calls.reply.length === 0);
  const real = d.shadow.querySelector('.card.pending [data-act="send"]');
  if (real) real.click();
  await tick(20);
  ok('…and neither does a synthetic click on the real Send button', calls.save.length === 0 && calls.reply.length === 0);
}

// ---- a trusted event does (the test hook says so), so the refusals above are the check's doing --------------------------------------------
{
  const { d, calls } = make({ isTrusted: () => true });
  await tick(20);
  plant(d, 'page-del-yes', { 'data-url': 'https://example.com/victim' }).click();
  await tick(10);
  ok('the same planted click, trusted, reaches the action', calls.del.length === 1 && calls.del[0] === 'https://example.com/victim');
}

// ---- the paths that used to call .click() on a button now call the action ------------------------------------------------------------------
{
  const { d, calls } = make({ isTrusted: () => true });
  await tick(20);
  const root = d.shadow;
  const mine = () => root.querySelector(`.pane[data-pane="comments"] .card[data-thread="${THR}"] .reply[data-ts="${msgs(4)[0].ts}"][data-author="reader"]`);
  const box = () => root.querySelector('.composer[data-target="__edit__"] textarea');
  mine().querySelector('[data-act="edit"]').click();
  await tick(10);
  ok('✎ opens the edit box', !!box());
  box().value = 'saved by the keyboard';
  box().dispatchEvent(new w.Event('input', { bubbles: true }));
  box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  await tick(20);
  ok('⌘↩ in the edit box saves it (no button is clicked)', calls.edit.length === 1 && calls.edit[0].text === 'saved by the keyboard', JSON.stringify(calls.edit));
  ok('…and the edit ends', !box());
  mine().querySelector('[data-act="edit"]').click();
  await tick(10);
  ok('(open again)', !!box());
  ok('cancelBubbleEdit does not claim an Esc when nothing in a bubble is being edited', d.cancelBubbleEdit({}) === false);
  box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick(10);
}

console.log(`drawerclosed: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  ✗ ' + f); process.exit(1); }
process.exit(0);
