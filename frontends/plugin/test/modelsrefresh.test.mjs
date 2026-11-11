// modelsrefresh.test.mjs — the remembered list of models is refreshed when
// the panel opens, not only when a bot answers.
//
// The report (2026-11-11): the panel keeps a remembered copy of the models on
// offer (D.models — what the model menu, the @-menu and the route pills read).
// It was refreshed by the `models` broadcast, which comes with a bot's turn,
// and by opening the model menu; so a model that became available since was
// missing until the next message. Now opening the panel asks the companion
// too, through the same GET /models (onModels) the menu uses — no new
// endpoint. What is asserted here:
//   · opening the panel asks once; switching tabs while it is open does not;
//     closing and opening again asks again;
//   · what comes back is what the model menu shows, even before the menu's
//     own request has answered;
//   · a failed or refused request leaves the remembered list as it was;
//   · opening the model menu still asks for itself.
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

// the companion's answer, which the test changes between openings. Model
// names are made up.
let offer = ['made-model-a', 'made-model-b'];
let mode = 'answer';        // 'answer' | 'refuse' | 'throw' | 'hang'
let asked = 0;
const answer = () => ({
  ok: true, current: { claude: 'made-model-a', codex: 'made-codex-1' },
  options: { claude: offer.slice(), codex: ['made-codex-1'] }, status: null, bridge: 'running',
});
const drawer = D.create({
  cssText: '.panel{}',
  onModels: () => {
    asked++;
    if (mode === 'refuse') return Promise.resolve({ ok: false, error: 'made-up refusal' });
    if (mode === 'throw') return Promise.reject(new Error('made-up network failure'));
    if (mode === 'hang') return new Promise(() => {});
    return Promise.resolve(answer());
  },
});
drawer.setConn(true);
drawer.setPage({ url: 'https://example.com/article', title: 'Article', page_chat: [], threads: [] });
const root = () => drawer.shadow;
// the model menu's claude picker, as drawn from the remembered list
const menuOptions = () => {
  const sel = root().querySelector('.popover.models select[data-agent="claude"]');
  return sel ? [...sel.options].map(o => o.value) : null;
};
const openMenu = async () => { root().querySelector('[data-act="models"]').click(); await tick(5); };
const closeMenu = async () => { if (!root().querySelector('.popover.models').hidden) root().querySelector('[data-act="models"]').click(); await tick(5); };

drawer.open('chat');
await tick(10);
ok('opening the panel asks the companion which models are on offer', asked === 1, 'asked ' + asked);
drawer.open('comments');
drawer.open('chat');
await tick(10);
ok('…switching tabs while it is open does not ask again', asked === 1, 'asked ' + asked);

// a model becomes available between openings
offer = ['made-model-a', 'made-model-b', 'made-model-new'];
drawer.close();
drawer.open('chat');
await tick(10);
ok('closing and opening the panel asks again', asked === 2, 'asked ' + asked);
// the menu's own request never answers here, so what it draws is the
// remembered list as the panel's opening left it
mode = 'hang';
await openMenu();
ok('opening the model menu still asks for itself', asked === 3, 'asked ' + asked);
ok('…and the new model is already in it, from the panel opening',
  (menuOptions() || []).indexOf('made-model-new') !== -1, JSON.stringify(menuOptions()));
await closeMenu();

// failures leave the remembered list alone
offer = ['made-model-a'];
for (const m of ['refuse', 'throw']) {
  mode = m;
  drawer.close();
  drawer.open('chat');
  await tick(10);
  mode = 'hang';
  await openMenu();
  ok(`a ${m === 'refuse' ? 'refused' : 'failed'} request on opening leaves the remembered list as it was`,
    (menuOptions() || []).indexOf('made-model-new') !== -1, JSON.stringify(menuOptions()));
  await closeMenu();
}

// with the menu OPEN, a refresh repaints it in place (no rebuild)
mode = 'answer';
offer = ['made-model-a', 'made-model-z'];
await openMenu();
await tick(10);
ok('the model menu fetch shows the companion\'s current list', (menuOptions() || []).join() === 'made-model-a,made-model-z',
  JSON.stringify(menuOptions()));

console.log(`modelsrefresh: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
