// footkeep.test.mjs — landing at the newest message stays landed while late
// content (a picture, a formula) finishes drawing, until the reader scrolls.
//
// The fault (reasoned on 2026-11-10, not seen): opening a chat, fanning a
// bubble's stack or pressing "new reply ↓" scrolls to the foot once; a
// picture in the newest reply that loads a moment later makes the
// conversation taller and leaves the reader a little short of the bottom.
//
// The fix keeps the landing in ONE value, D.footKeep (FOOT_MODES none / card /
// bubble), changed only through footMove. While it is kept, a picture loading,
// the content under it changing size, or a redraw lands it again; the
// reader's own scroll (wheel, touch, a scroll key, a grab of the scroll bar)
// or asking for older messages lets it go. No timer.
//
// happy-dom has no layout, so the landing itself is seen through a spy on
// the scroller's scrollTop: every write is a landing being made.
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
const throws = fn => { try { fn(); return false; } catch { return true; } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---- 1. the machine, pure ---------------------------------------------------
{
  const M = D.footMove;
  eq('the three modes, named', D.FOOT_MODES, ['none', 'card', 'bubble']);
  eq('the two moves, named', D.FOOT_MOVES, ['land', 'letgo']);
  eq('null is none', D.footMode(null), 'none');
  const c = M(null, 'land', { kind: 'card', id: '__page__' });
  eq('land on a card', [D.footMode(c), c.id], ['card', '__page__']);
  eq('land on a bubble, from a card', D.footMode(M(c, 'land', { kind: 'bubble', id: 't1' })), 'bubble');
  ok('land with no kind is refused', throws(() => M(null, 'land', { id: 'x' })));
  ok('land with no id is refused', throws(() => M(null, 'land', { kind: 'card' })));
  eq('letgo: → none, from anything', [M(c, 'letgo'), M(null, 'letgo')], [null, null]);
  ok('an unknown move is refused', throws(() => M(c, 'hold')));
}

// ---- 2. in the drawer --------------------------------------------------------
const URL_ = 'https://example.com/article';
const THR = 'thr-1';
const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({
  ts: `2026-11-11T10:${String(i).padStart(2, '0')}:00.000Z`,
  author: i % 2 ? 'claude' : 'reader', text: `${tag} message ${i}`,
}));
const drawer = D.create({ cssText: '.panel{}' });
drawer.setConn(true);
drawer.setAuthor('reader');
drawer.open('chat');
drawer.setPage({ url: URL_, title: 'Article', page_chat: msgs(30, 'chat'),
  threads: [{ id: THR, quote: 'a passage', msgs: msgs(6, 'thread') }] });
await tick(20);
const root = drawer.shadow;
const chatPane = root.querySelector('.pane[data-pane="chat"]');
// every write to the pane's scrollTop is a landing being made (or a redraw's
// restore); count them
const spy = (el) => {
  const log = [];
  let v = 0;
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => v, set: x => { log.push(x); v = x; } });
  return log;
};
const card = () => root.querySelector('.card[data-thread="__page__"]');
const loadIn = el => { const img = w.document.createElement('img'); el.appendChild(img); img.dispatchEvent(new w.Event('load')); };

{
  eq('a chat that has just arrived is landed at its foot, and the landing kept', D.footMode(drawer.footKeep), 'card');
  const log = spy(chatPane);
  loadIn(card());
  ok('a picture loading late in it lands it again', log.length >= 1, JSON.stringify(log));
  const n = log.length;
  drawer.render();
  ok('a redraw lands it again too (after putting the scroll back)', log.length >= n + 2, JSON.stringify(log.slice(n)));
  chatPane.dispatchEvent(new w.Event('wheel', { bubbles: true }));
  eq('the reader’s own wheel lets it go', D.footMode(drawer.footKeep), 'none');
  const m = log.length;
  loadIn(card());
  ok('…after which a late picture moves nothing', log.length === m, JSON.stringify(log.slice(m)));
}

// a scroll key in the pane lets go; the same key typed in a box does not
{
  drawer.setPage({ url: URL_ + '?2', title: 'Two', page_chat: msgs(30, 'two'), threads: [] });
  await tick(20);
  eq('(a new page: a new landing, kept)', D.footMode(drawer.footKeep), 'card');
  const ta = root.querySelector('.composer[data-target="__page__"] textarea');
  ta.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, composed: true }));
  eq('ArrowUp typed in the chat box keeps it', D.footMode(drawer.footKeep), 'card');
  card().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, composed: true }));
  eq('Page Up in the pane lets it go', D.footMode(drawer.footKeep), 'none');
}

// a reader who scrolled away by a means no gesture listener sees (find in
// page, a link tabbed to) is found by where the pane is: moved from where the
// landing left it, and no longer at the card's foot
{
  drawer.setPage({ url: URL_ + '?2b', title: 'Two b', page_chat: msgs(30, 'twob'), threads: [] });
  await tick(20);
  eq('(kept again)', D.footMode(drawer.footKeep), 'card');
  const log = spy(chatPane);
  const c = card();
  c.getBoundingClientRect = () => ({ top: -1500 - chatPane.scrollTop, bottom: 2000 - chatPane.scrollTop, left: 0, right: 400, width: 400, height: 3500 });
  chatPane.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 400, width: 400, height: 500 });
  chatPane.scrollTop = 120;            // moved, and nowhere near the foot
  const m = log.length;
  loadIn(c);
  eq('a late picture after the reader scrolled away lets it go', D.footMode(drawer.footKeep), 'none');
  ok('…and moves nothing', log.length === m, JSON.stringify(log.slice(m)));
  delete chatPane.getBoundingClientRect;
}

// asking for older messages lets it go
{
  drawer.setPage({ url: URL_ + '?3', title: 'Three', page_chat: msgs(30, 'three'), threads: [] });
  await tick(20);
  eq('(kept again)', D.footMode(drawer.footKeep), 'card');
  const earlier = root.querySelector('.showmore.earlier[data-act="earlier"]');
  ok('(a long chat shows its "Show earlier" line)', !!earlier);
  if (earlier) earlier.click();
  await tick(5);
  eq('Show earlier lets it go', D.footMode(drawer.footKeep), 'none');
}

// another tab: the landing is not showing, so it is let go at the next redraw
{
  drawer.setPage({ url: URL_ + '?4', title: 'Four', page_chat: msgs(5, 'four'), threads: [{ id: THR, quote: 'q', msgs: msgs(6, 'thread') }] });
  await tick(20);
  eq('(kept again)', D.footMode(drawer.footKeep), 'card');
  drawer.open('comments');
  await tick(5);
  drawer.render();
  eq('on another tab, a redraw lets it go', D.footMode(drawer.footKeep), 'none');
}

// the bubble: fanning the stack open lands at its foot and keeps it
{
  drawer.close();
  drawer.setBubbles('bubbles');
  drawer.showBubble(THR);
  await tick(10);
  const bub = () => root.querySelector(`.bubble[data-thread="${THR}"]`);
  const lip = bub() && bub().querySelector('.bfan');
  ok('(a bubble is up with its stack shut)', !!lip);
  if (lip) {
    lip.click();
    await tick(5);
    eq('fanning the stack open keeps the landing on the bubble', [D.footMode(drawer.footKeep), drawer.footKeep && drawer.footKeep.id], ['bubble', THR]);
    const body = bub().querySelector('.bbody');
    const log = spy(body);
    loadIn(bub().querySelector('.bstack'));
    ok('a picture loading late in the stack lands it again', log.length >= 1);
    body.dispatchEvent(new w.Event('touchmove', { bubbles: true }));
    eq('a drag on a touch screen lets it go', D.footMode(drawer.footKeep), 'none');
    // the pip lands and keeps it as well
    const pip = bub().querySelector('[data-act="bubble-pip"]');
    if (pip) { pip.hidden = false; pip.click(); await tick(5); }
    eq('“new reply ↓” lands and keeps it', D.footMode(drawer.footKeep), 'bubble');
    // a grab of the scroll bar (a mousedown on the scroller itself)
    body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    eq('a grab of the scroll bar lets it go', D.footMode(drawer.footKeep), 'none');
  }
}

console.log(`footkeep: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
