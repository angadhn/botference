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

// ---- 2. a button that asks, works, and says how it went ----------------------
{
  const throws = fn => { try { fn(); return false; } catch { return true; } };
  eq('the button modes, named', D.ACT_MODES, ['idle', 'confirm', 'busy', 'done', 'failed']);
  eq('…and the moves', Object.keys(D.ACT_MOVES), ['ask', 'decline', 'start', 'go', 'done', 'failed']);
  const legal = {
    ask: ['idle', 'done', 'failed'], decline: ['confirm'], start: ['confirm'],
    go: ['idle', 'done', 'failed'], done: ['busy'], failed: ['busy'],
  };
  for (const move of Object.keys(legal)) for (const mode of D.ACT_MODES) {
    const want = legal[move].includes(mode);
    eq(`${move} from ${mode}: ${want ? 'allowed' : 'refused'}`, D.canActMove({ mode }, move), want);
    ok(`${move} from ${mode}: actMove ${want ? 'moves' : 'throws'}`, want ? !throws(() => D.actMove({ mode }, move)) : throws(() => D.actMove({ mode }, move)));
  }
  ok('an unknown move throws', throws(() => D.actMove({ mode: 'idle' }, 'confirm')));
  const b = { mode: 'idle', err: '', note: '' };
  D.actMove(b, 'ask'); D.actMove(b, 'start');
  D.actMove(b, 'failed', 'no answer');
  eq('failed carries why, and only why', [b.mode, b.err, b.note], ['failed', 'no answer', '']);
  D.actMove(b, 'ask');
  eq('asking again clears what was said', [b.mode, b.err, b.note], ['confirm', '', '']);
  D.actMove(b, 'start'); D.actMove(b, 'done', 'sent 2');
  eq('done carries what to say, and no error', [b.mode, b.err, b.note], ['done', '', 'sent 2']);
  eq('a mode from nowhere reads as idle', D.canActMove({ mode: 'x' }, 'ask'), true);
}

// ---- 2b. …in the drawer: send review, a refused second click while working --
{
  let release;
  const d2 = D.create({
    cssText: '.panel{}',
    onSendReview: () => new Promise(r => { release = r; }),
  });
  d2.setConn(true); d2.setAuthor('reader'); d2.open('comments');
  d2.setPage({ url: URL_, title: 'Article', page_chat: [],
    threads: [{ id: 'r1', quote: 'a made-up passage', msgs: [{ author: 'reader', ts: '1', text: 'made up' }] }] });
  await tick(20);
  const S = d2.shadow;
  const btn = a => S.querySelector(`[data-act="${a}"]`);
  ok('send review is offered', !!btn('send-review'));
  btn('send-review').click(); await tick(5);
  eq('pressed: asking', d2.review.mode, 'confirm');
  ok('…the question is up, the button gone', !!btn('review-yes') && !btn('send-review'));
  btn('review-no').click(); await tick(5);
  eq('no: idle again', d2.review.mode, 'idle');
  btn('send-review').click(); await tick(5);
  btn('review-yes').click(); await tick(5);
  eq('yes: working', d2.review.mode, 'busy');
  ok('…and nothing to press while it works', !btn('send-review') && !btn('review-yes'));
  release({ ok: false, error: 'made-up refusal' }); await tick(10);
  eq('the answer: failed, with why', [d2.review.mode, d2.review.err], ['failed', 'made-up refusal']);
  ok('…shown beside the button', /made-up refusal/.test((S.querySelector('.rvnote.err') || {}).textContent || ''));
  d2.close && d2.close();
}

console.log(`drawermodes: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
