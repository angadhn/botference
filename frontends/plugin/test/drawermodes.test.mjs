// drawermodes.test.mjs — more of the drawer's controls whose state was a pile
// of yes/no flags, each now ONE named value changed through ONE function
// (the owner's standing rule: no implicit state machines).
//
//   1. the pop-overs (help, models, export, projects) — were four flags, and
//      two could be up at once; now D.popover (POPOVERS) via setPopover.
//   5. a thread's request out (✓ / ↺, "not done", highlight ⇄ strike) — were
//      three maps, D.resolving / D.addressing / D.marking, so two could be out
//      on one thread; now D.threadReq[id] (THREAD_REQS) via setThreadReq.
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

// ---- 3. a list read from the companion ---------------------------------------
{
  const throws = fn => { try { fn(); return false; } catch { return true; } };
  eq('the list modes, named', D.LOAD_MODES, ['idle', 'loading', 'loaded', 'failed']);
  const legal = { ask: ['idle', 'loaded', 'failed'], got: ['loading'], lost: ['loading'] };
  eq('…and the moves', Object.keys(D.LOAD_MOVES), Object.keys(legal));
  for (const move of Object.keys(legal)) for (const load of D.LOAD_MODES) {
    const want = legal[move].includes(load);
    eq(`${move} from ${load}: ${want ? 'allowed' : 'refused'}`, D.canLoadMove({ load }, move), want);
    ok(`${move} from ${load}: loadMove ${want ? 'moves' : 'throws'}`, want ? !throws(() => D.loadMove({ load }, move)) : throws(() => D.loadMove({ load }, move)));
  }
  ok('a second read while one is out is refused', throws(() => D.loadMove({ load: 'loading' }, 'ask')));
  ok('an unknown move throws', throws(() => D.loadMove({ load: 'idle' }, 'reload')));
  const L = { load: 'idle', list: ['kept'], err: '' };
  D.loadMove(L, 'ask'); D.loadMove(L, 'lost', 'made-up outage');
  eq('lost: failed, with why, and the list it had is kept', [L.load, L.err, L.list], ['failed', 'made-up outage', ['kept']]);
  const M = { load: 'loading', error: '' };
  D.loadMove(M, 'lost', 'why', 'error');
  eq('…why goes where that list keeps it', M.error, 'why');
  const N = { load: 'loading', note: 'own words' };
  D.loadMove(N, 'lost', 'why', null);
  eq('…or nowhere, for a list that words its own failure', [N.load, N.note, 'err' in N], ['failed', 'own words', false]);
}

// ---- 3b. …in the drawer: the project picker's first read -------------------
{
  let answer;
  const d3 = D.create({
    cssText: '.panel{}',
    onProjects: () => new Promise((res, rej) => { answer = { res, rej }; }),
  });
  d3.setConn(true); d3.setAuthor('reader'); d3.open('comments');
  d3.setPage({ url: URL_, title: 'Article', page_chat: [], threads: [] });
  await tick(20);
  const b = d3.shadow.querySelector('[data-act="filein"]');
  b.hidden = false; b.click(); await tick(5);
  eq('first open: reading', d3.projects.load, 'loading');
  ok('…and it says so', /reading your council/.test(d3.el.projpick.textContent));
  answer.rej(new Error('made-up: no council here')); await tick(10);
  eq('a failed read: failed', d3.projects.load, 'failed');
  ok('…and says why', /no council here/.test(d3.el.projpick.textContent));
}

// ---- 4. a message on its way out ---------------------------------------------
{
  const throws = fn => { try { fn(); return false; } catch { return true; } };
  eq('the outbox states, named', D.OUTBOX_STATES, ['sending', 'failed']);
  const legal = { sending: ['failed'], failed: ['sending'] };
  for (const from of D.OUTBOX_STATES) for (const to of D.OUTBOX_STATES) {
    const want = legal[from].includes(to);
    eq(`${from} → ${to}: ${want ? 'allowed' : 'refused'}`, D.canOutboxMove({ state: from }, to), want);
    ok(`${from} → ${to}: moveOutbox ${want ? 'moves' : 'throws'}`, want ? !throws(() => D.moveOutbox({ state: from }, to)) : throws(() => D.moveOutbox({ state: from }, to)));
  }
  ok('a state that is not one throws', throws(() => D.moveOutbox({ state: 'sending' }, 'sent')));
  ok('an entry in no known state cannot move', !D.canOutboxMove({ state: 'x' }, 'sending') && !D.canOutboxMove(null, 'failed'));
  const e = { state: 'sending', error: '' };
  D.moveOutbox(e, 'failed', 'made-up refusal');
  eq('failed carries why', [e.state, e.error], ['failed', 'made-up refusal']);
  D.moveOutbox(e, 'sending');
  eq('retry clears it', [e.state, e.error], ['sending', '']);
}

// ---- 4b. …in the drawer: a refused send, then a retry ------------------------
{
  const answers = [];
  const d4 = D.create({
    cssText: '.panel{}',
    onReply: () => new Promise(r => answers.push(r)),
  });
  d4.setConn(true); d4.setAuthor('reader'); d4.open('comments');
  d4.setPage({ url: URL_, title: 'Article', page_chat: [],
    threads: [{ id: 'q1', quote: 'a made-up passage', msgs: [{ author: 'reader', ts: '1', text: 'made up' }] }] });
  await tick(20);
  d4.tab = 'comments';
  const S = d4.shadow;
  const box = S.querySelector('.card[data-thread="q1"] textarea') || S.querySelector('textarea[data-target="q1"]');
  if (box) {
    box.value = 'a made-up reply';
    const send = S.querySelector('.card[data-thread="q1"] [data-act="send"]');
    if (send) send.click(); else box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    await tick(10);
    const entry = () => (d4.outbox.q1 || [])[0];
    eq('the message is on its way', entry() && entry().state, 'sending');
    answers.shift()({ ok: false, error: 'made-up refusal' }); await tick(10);
    eq('refused: failed, with why', entry() && [entry().state, entry().error], ['failed', 'made-up refusal']);
    const retry = S.querySelector('[data-act="send-retry"]');
    if (retry) {
      retry.click(); await tick(5);
      eq('retry: sending again', entry() && entry().state, 'sending');
      answers.shift()({ ok: true }); await tick(10);
      eq('delivered: it leaves the outbox', (d4.outbox.q1 || []).length, 0);
    } else ok('a retry button is offered on a failed send', false);
  } else ok('the thread has a reply box', false);
}

// ---- 5. a thread's request out: one at a time ---------------------------------
{
  const throws = fn => { try { fn(); return false; } catch { return true; } };
  eq('the requests, named', D.THREAD_REQS, ['none', 'resolving', 'addressing', 'marking']);
  ok('…frozen', Object.isFrozen(D.THREAD_REQS));
  for (const k of ['resolving', 'addressing', 'marking']) {
    eq(`none → ${k}`, D.threadReqMove(undefined, k), k);
    eq(`${k} → none (the answer)`, D.threadReqMove(k, 'none'), 'none');
    for (const k2 of ['resolving', 'addressing', 'marking']) {
      ok(`${k} → ${k2}: refused (one out at a time)`, throws(() => D.threadReqMove(k, k2)));
    }
  }
  ok('an answer with nothing out is refused', throws(() => D.threadReqMove(undefined, 'none')));
  ok('a request that is not one throws', throws(() => D.threadReqMove(undefined, 'deleting')));

  const calls = [];
  const held = {};
  const d5 = D.create({
    cssText: '.panel{}',
    onResolve: (id, on) => { calls.push('resolve'); return new Promise(r => { held.resolve = r; }); },
    onNotDone: id => { calls.push('not-done'); return new Promise(r => { held.notDone = r; }); },
  });
  d5.setConn(true); d5.setAuthor('reader'); d5.open('comments');
  d5.setPage({ url: URL_, title: 'Article', page_chat: [],
    threads: [{ id: 'r1', quote: 'a made-up passage', status: 'ready', addressed_by: 'claude',
      msgs: [{ author: 'reader', ts: '1', text: 'made up' }, { author: 'claude', ts: '2', text: 'made up too' }] }] });
  await tick(20);
  const S = d5.shadow;
  const btn = act => S.querySelector(`.card[data-thread="r1"] [data-act="${act}"]`);
  const nd = btn('not-done');
  ok('a ready thread offers "not done"', !!nd);
  if (nd) {
    nd.click(); await tick(5);
    eq('"not done" is out', d5.threadReq.r1, 'addressing');
    ok('…the card has gone back to open at once', !S.querySelector('.card[data-thread="r1"]').classList.contains('ready'));
    const rs = btn('resolve');
    if (rs) { rs.click(); await tick(5); }
    eq('a ✓ while "not done" is out is refused: nothing sent', calls, ['not-done']);
    eq('…and the request out is still the first', d5.threadReq.r1, 'addressing');
    held.notDone({ ok: true }); await tick(10);
    ok('answered: nothing out', !('r1' in d5.threadReq));
    const rs2 = btn('resolve');
    if (rs2) { rs2.click(); await tick(5); }
    eq('now a ✓ goes', calls, ['not-done', 'resolve']);
    eq('…resolving', d5.threadReq.r1, 'resolving');
    held.resolve({ ok: true }); await tick(10);
    ok('…answered: nothing out', !('r1' in d5.threadReq));
  }
}

console.log(`drawermodes: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
