// status.test.mjs — what a comment thread is CALLED comes from one function.
//
// The finding (2026-11-10): a thread's status (open, ready, resolved, struck,
// orphaned) is about twelve flags written from five files, and the labels
// read them each their own way, so they could disagree. The labels now all
// read one function: drawer.js threadStatus (stage + mark + orphaned) for
// the side panel, the bubbles and the page paint, and store.mjs threadStage
// for the companion. What is asserted here:
//   · the drawer's and the companion's stage agree on every combination of
//     the stored flags, old records included (a record with both `resolved`
//     and `addressed` set, as an older companion could leave, is resolved);
//   · the page's live orphan answer outranks the record's;
//   · the paint a stage wears on the page;
//   · in the drawer (happy-dom): reopening a resolved thread that still had
//     `addressed` on it reads "open" at once, as the companion will say,
//     not "ready"; and a failed reopen puts every flag back.
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
const store = await import(path.join(here, '..', 'store.mjs'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---- 1. one rule, both sides ------------------------------------------------
{
  eq('the three stages, named (drawer)', D.THREAD_STAGES, ['open', 'ready', 'resolved']);
  eq('…the same three (companion)', store.THREAD_STAGES, D.THREAD_STAGES);
  eq('the two marks, named', D.THREAD_MARKS, ['highlight', 'strike']);
  const table = [
    [null, 'open'], [{}, 'open'],
    [{ addressed: true }, 'ready'],
    [{ resolved: true }, 'resolved'],
    [{ resolved: true, addressed: true }, 'resolved'],      // an old record with both
    [{ resolved: false, addressed: true }, 'ready'],
    [{ addressed: false }, 'open'],
    [{ resolved: true, resolved_at: '2026-01-01', orphaned: true }, 'resolved'],
  ];
  for (const [t, want] of table) {
    const label = JSON.stringify(t);
    eq('drawer stage of ' + label, D.threadStage(t), want);
    eq('companion stage of ' + label, store.threadStage(t), want);
    eq('…isResolved agrees, both sides', [D.isResolvedThread(t), store.isResolved(t)], [want === 'resolved', want === 'resolved']);
    eq('…isAddressed means ready', store.isAddressed(t), want === 'ready');
  }
  eq('mark: strike', D.threadMark({ mark: 'strike' }), 'strike');
  eq('mark: anything else is a highlight', [D.threadMark({ mark: 'x' }), D.threadMark(null)], ['highlight', 'highlight']);
  eq('…and the companion’s markOf agrees', [store.markOf({ mark: 'strike' }), store.markOf({})], ['strike', 'highlight']);
  eq('orphaned: the record, when the page has not looked', D.threadStatus({ orphaned: true }).orphaned, true);
  eq('orphaned: the page’s live answer outranks the record', [D.threadStatus({ orphaned: true }, false).orphaned,
    D.threadStatus({}, true).orphaned], [false, true]);
  eq('the whole status', D.threadStatus({ addressed: true, mark: 'strike' }), { stage: 'ready', mark: 'strike', orphaned: false });
  eq('the paint each stage wears', [D.stagePaint({}), D.stagePaint({ addressed: true }), D.stagePaint({ resolved: true, addressed: true })],
    [false, 'ready', true]);
}

// ---- 2. in the drawer: reopening reads "open" at once -----------------------
const URL_ = 'https://example.com/article';
const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({
  ts: `2026-11-11T10:${String(i).padStart(2, '0')}:00.000Z`,
  author: i % 2 ? 'claude' : 'reader', text: `${tag} message ${i}`,
}));
const pending = [];
const drawer = D.create({
  cssText: '.panel{}',
  onResolve: () => new Promise(r => pending.push(r)),
});
drawer.setConn(true);
drawer.setAuthor('reader');
drawer.open('comments');
drawer.setPage({ url: URL_, title: 'Article', page_chat: [],
  threads: [{ id: 't1', quote: 'a passage', msgs: msgs(2, 'one'), resolved: true, addressed: true, addressed_by: 'claude' }] });
await tick(20);
const root = drawer.shadow;
const card = () => root.querySelector('.pane[data-pane="comments"] .card[data-thread="t1"]');
{
  const sec = root.querySelector('[data-act="resolved-toggle"]');
  if (sec && !root.querySelector('.resolved-list')) { sec.click(); await tick(5); }
  ok('a resolved thread (with an old `addressed` still on it) is under Resolved', !!card() && card().classList.contains('resolved'));
  const reopen = card() && card().querySelector('[data-act="reopen"]');
  ok('it has a reopen button', !!reopen);
  if (reopen) {
    reopen.click();
    await tick(5);
    ok('reopened: it reads open at once, not ready for review', !!card() && !card().classList.contains('resolved')
      && !card().classList.contains('ready'), card() && card().className);
    // the companion refuses: everything goes back as it was
    pending.shift()({ ok: false, error: 'no' });
    await tick(10);
    ok('a refused reopen puts it back under Resolved', !!card() && card().classList.contains('resolved'));
    const t = drawer.page.threads[0];
    eq('…with every flag as it was', [t.resolved, t.addressed, t.addressed_by], [true, true, 'claude']);
  }
}

console.log(`status: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
