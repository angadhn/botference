// blygpublish-walk.test.mjs — the owner's first real use, walked through the REAL drawer AND the REAL worker (no stand-in for either):
// the drawer's buttons (happy-dom, trusted clicks) → content's message → background.js (in a vm) → a companion that holds the run.
//
// On 2026-11-24 the owner pressed "Plan again" after a failed plan; the plan then succeeded and the drawer showed Publish, but the
// Publish was refused ("Review the publish again to continue") because the retry had spent the tab's one offer; and after Close the
// plane showed the scope choice again and the companion refused the start. Here: start → plan fails → Try again → planned → Publish →
// applying; and the same through Carry on (interrupted → continue → applying → failed → Try again); Close and the plane on another
// thread bring the run back; no reload anywhere.
//
//   node frontends/plugin/test/blygpublish-walk.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, '..', 'extension');
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection', 'ResizeObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const CFG = require(path.join(EXT, 'config.js'));
globalThis.BFPConfig = CFG; w.BFPConfig = CFG;
const D = require(path.join(EXT, 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = () => tick(800);

// ---- the companion: holds one run; its mode is moved by the routes (and by the test, standing in for the site's commands) ----
const C = { mode: 'idle', seen: [] };
const runOf = () => ({ id: 'r1', token: 'tok1', mode: C.mode, title: 'My first thought', thread_ids: ['t1'], confirm: 'always', reading: [{ kind: 'words', text: 'My first thought.' }],
  failed_step: C.mode === 'failed_plan' ? 'plan' : C.mode === 'failed_apply' ? 'apply' : '', interrupted_from: C.mode === 'interrupted_applying' ? 'applying' : '',
  steps: [], can: C.mode === 'planned' ? ['confirm', 'cancel'] : /^failed_/.test(C.mode) ? ['retry', 'abandon'] : C.mode === 'interrupted_applying' ? ['continue', 'abandon'] : [] });
function companion(url, method, body) {
  const p = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  if (!p.startsWith('/blyg-publish/')) return { ok: true };
  C.seen.push(p);
  const go = (from, to) => { if (!from.includes(C.mode)) return { ok: false, status: 409, error: `refused: ${p} while ${C.mode}` }; C.mode = to; return { ok: true, run: runOf() }; };
  if (p === '/blyg-publish/run') return { ok: true, run: runOf(), confirm: 'always' };
  if (p === '/blyg-publish/preview') return { ok: true, state: 'off' };
  if (p === '/blyg-publish/start') { if (C.mode !== 'idle') return { ok: false, status: 409, error: `a publish run is already under way (${C.mode})` }; C.mode = 'planning'; return { ok: true, run: runOf() }; }
  if (p === '/blyg-publish/retry') return go(['failed_plan', 'failed_apply'], C.mode === 'failed_plan' ? 'planning' : 'applying');
  if (p === '/blyg-publish/confirm') return go(['planned'], 'applying');
  if (p === '/blyg-publish/continue') return go(['interrupted_applying'], 'applying');
  return { ok: false, status: 404, error: 'no' };
}

// ---- the REAL worker, in a vm, with a stand-in `chrome` and `fetch` reaching the companion above --------------------------------
function bootWorker() {
  const listeners = [];
  const make = p => new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (p === 'chrome.runtime.onMessage' && k === 'addListener') return fn => { listeners.push(fn); };
      if (p === 'chrome.tabs' && (k === 'sendMessage' || k === 'query')) return () => Promise.resolve([]);
      if (/^chrome\.storage\.\w+$/.test(p) && k === 'get') return (_k, cb) => { if (typeof cb === 'function') cb({}); return Promise.resolve({}); };
      return make(`${p}.${String(k)}`);
    },
    apply(_t, _this, args) { const cb = args[args.length - 1]; if (typeof cb === 'function' && !/addListener$/.test(p)) { try { cb(); } catch { } } return Promise.resolve(undefined); },
  });
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, Promise, Map, Set, JSON, Math, Date, TextEncoder, TextDecoder, btoa, atob, AbortController,
    WebSocket: class { close() {} send() {} },
    fetch: async (url, init) => { const r = companion(url, init && init.method, init && init.body ? JSON.parse(init.body) : undefined);
      return { ok: r.ok !== false, status: r.ok === false ? r.status : 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(r) }; },
    chrome: make('chrome'),
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f }); };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  // what content.js does: the drawer's onBlygPublish becomes the worker's 'blyg-publish' message from this tab
  return (op, body) => new Promise(resolve => listeners[0]({ t: 'blyg-publish', op, url: 'https://example.com/article', ...(body || {}) }, { tab: { id: 5 } }, resolve));
}

const mine = text => ({ author: 'owner', ts: '2026-11-24T10:00:00Z', text, provenance: 'owner-typed', channel: 'drawer' });
const worker = bootWorker();
const drawer = D.create({ isTrusted: () => true, cssText: '.panel{}', onModels: async () => ({ ok: true, current: {}, options: {} }),
  onBlygCheck: async () => ({ ok: true, status: 'not-a-blyg' }), onBlygPublish: worker });
drawer.setConn(true); drawer.setAuthor('owner'); drawer.setOwner(true); drawer.open('comments');
drawer.setPage({ url: 'https://example.com/article', title: 'An article', page_chat: [], threads: [
  { id: 't1', quote: 'passage one', msgs: [mine('My first thought.')] }, { id: 't2', quote: 'passage two', msgs: [mine('My second thought.')] }] });
await tick(30);
const q = sel => drawer.shadow.querySelector(sel);
const view = () => drawer.pub.view;
document.elementsFromPoint = () => [drawer.host];
const press = async act => { await settle(); q(`[data-act="${act}"]`).click(); await tick(30); };
const moved = async mode => { C.mode = mode; drawer.blygPublishMoved(); await tick(30); };

q('.thr-pub[data-target="t1"]').click(); await tick(30);
eq('the plane: the scope choice', view(), 'choosing');
await press('pub-scope');
eq('started: working', [view(), C.mode], ['working', 'planning']);
await moved('failed_plan');
eq('the plan failed: one sentence, and Try again', [view(), q('.pubdlg p.puberr').textContent, !!q('[data-act="pub-retry"]')], ['problem', 'Something went wrong while checking that only this note changes.', true]);
await press('pub-retry');
eq('Try again went through the worker, and the box stepped out of the way (the run goes on in the background)', [C.mode, view()], ['planning', 'closed']);
await moved('planned');
await drawer.pubShowRun(); await tick(30);
eq('planned: the preview with a Publish button', [view(), !!q('[data-act="pub-confirm"]')], ['confirming', true]);
await press('pub-confirm');
eq('(b) Publish after a retry WORKS: the companion is applying, the box is out of the way', [C.mode, view(), drawer.pub.error], ['applying', 'closed', '']);
// …and the same through Carry on (the notice's "Show what happened" opens the run's own view)
await moved('interrupted_applying');
eq('(set up) interrupted while the box was closed: nothing pops up', view(), 'closed');
await drawer.pubShowRun(); await tick(30);
eq('interrupted: Carry on', [view(), !!q('[data-act="pub-continue"]')], ['problem', true]);
await press('pub-continue');
eq('Carry on went through', [C.mode, view()], ['applying', 'closed']);
await moved('failed_apply');
await drawer.pubShowRun(); await tick(30);
eq('then a failure: Try again', [view(), !!q('[data-act="pub-retry"]')], ['problem', true]);
await press('pub-retry');
eq('the act after a Carry on works too', [C.mode, view()], ['applying', 'closed']);
// (c) the plane on the run's thread brings back a run that waits for the owner (never the scope choice, never a refused start);
// another thread's plane is a press of its own (the publish queue)
await moved('planned');
q('.thr-pub[data-target="t1"]').click(); await tick(30);
eq('(c) after Close, the plane on its thread shows the run waiting for the look', [view(), !!q('[data-act="pub-scope"]'), !!q('[data-act="pub-confirm"]')], ['confirming', false, true]);
await press('pub-confirm');
eq('(c) …and its Publish works, with no reload', [C.mode, view()], ['applying', 'closed']);
eq('the companion was never asked to start a second run', C.seen.filter(p => p === '/blyg-publish/start').length, 1);
delete document.elementsFromPoint;

console.log(`${fail ? '✗' : '✓'} blygpublish-walk — ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('  · ' + f);
process.exit(fail ? 1 : 0);
