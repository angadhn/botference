// foldfoot.test.mjs — the fold control of a long conversation lives at its
// FOOT, and using it never takes the reader away from the newest message.
//
// The reader's words: "I'm more likely to be at the bottom of a message […]
// I'm probably going to want to read backwards in time, not forwards […]
// ideally, I'm just starting at the bottom, even if I unstack. And then I
// work my way to the top." Two places carry that rule:
//
//   · the bubble beside a highlight: the lip ("+N" / "− stack up") sits in its
//     own slot under the cards and over the reply box, in the same place open
//     or shut, and fanning open leaves the stack scrolled to the newest card;
//   · the side panel's comment threads: "Show N earlier replies" /
//     "Hide N earlier replies" is drawn after the last message, a quiet count
//     marks the gap while folded, and unfolding lands the foot of that thread
//     at the bottom of the pane. (The page chat no longer folds at all since
//     2026-11-11 — it is a window on its newest messages, chatwindow.test.mjs —
//     so here it only checks landing, staying put, and the absence of a fold.)
//
// happy-dom does not lay anything out, so the geometry is stubbed: every
// `.card` reports a fixed box, every `.pane` and `.bbody` a fixed height.
// What is tested is the DECISION — which scroll offset the drawer asked for —
// not what a real screen shows.
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

// ---- the stubbed geometry ---------------------------------------------------
// A card is 2000px tall starting 300px down its pane's content; a pane is a
// 500px window whose top is at 0. So a card's foot, in the pane's content, is
// at 300 + 2000 - scrollTop + scrollTop = 2300, and landing it at the bottom
// of the pane asks for 2300 - 500 + 8 = 1808. A bubble's scroller is 900px of
// content in a 200px window.
const CARD_TOP = 300, CARD_H = 2000, PANE_H = 500, BODY_SH = 900, BODY_H = 200;
const LANDED = CARD_TOP + CARD_H - PANE_H + 8;
const P = w.HTMLElement.prototype;
const realRect = P.getBoundingClientRect;
P.getBoundingClientRect = function () {
  const cl = this.classList;
  if (cl && cl.contains('card')) {
    // a card's box moves with its pane's scroll, as a real one does
    const pane = this.closest('.pane');
    const top = CARD_TOP - (pane ? pane.scrollTop : 0);
    return { top, bottom: top + CARD_H, left: 0, right: 400, width: 400, height: CARD_H, x: 0, y: top };
  }
  if (cl && cl.contains('pane')) return { top: 0, bottom: PANE_H, left: 0, right: 400, width: 400, height: PANE_H, x: 0, y: 0 };
  return realRect.call(this);
};
const geom = (name, fn) => {
  const desc = Object.getOwnPropertyDescriptor(P, name)
    || Object.getOwnPropertyDescriptor(w.Element.prototype, name);
  Object.defineProperty(P, name, {
    configurable: true,
    get() { const v = fn(this); return v == null ? (desc && desc.get ? desc.get.call(this) : 0) : v; },
  });
};
geom('clientHeight', el => (el.classList.contains('pane') ? PANE_H : el.classList.contains('bbody') ? BODY_H : null));
geom('scrollHeight', el => (el.classList.contains('pane') ? CARD_TOP + CARD_H + 40 : el.classList.contains('bbody') ? BODY_SH : null));

// ---- a long conversation ----------------------------------------------------
// ten messages, the reader and claude taking turns: five rounds, so the rule
// keeps the first message and the last two rounds and folds the five between
const conv = (n, tag) => Array.from({ length: n }, (_, i) => ({
  ts: `2026-11-10T10:${String(i).padStart(2, '0')}:00.000Z`,
  author: i % 2 ? 'claude' : 'reader',
  text: `${tag} message ${i}`,
}));
const LONG = 'thr-long', SHORT = 'thr-short';
const page = (chat, threads) => ({
  url: 'https://example.com/article', title: 'Article', page_chat: chat,
  threads: threads || [
    { id: LONG, quote: 'a long passage', msgs: conv(10, 'long') },
    { id: SHORT, quote: 'a short passage', msgs: conv(2, 'short') },
  ],
});

const drawer = D.create({ cssText: '.panel{}' });
drawer.setConn(true);
drawer.open('chat');
drawer.setPage(page(conv(10, 'chat')));
await tick(20);
const root = drawer.shadow;
const chatPane = root.querySelector('.pane[data-pane="chat"]');
const comPane = root.querySelector('.pane[data-pane="comments"]');
const chatThread = () => root.querySelector('.card.chatpane .thread');
const kidsOf = el => [...(el ? el.children : [])];
const lastReply = el => kidsOf(el).filter(k => k.classList.contains('reply')).pop();

// ---- 1. opening a chat lands at its newest message --------------------------
ok('a chat that has just arrived opens at its foot, not its top',
  chatPane.scrollTop === LANDED, 'scrollTop=' + chatPane.scrollTop);

// ---- 2. a chat never folds ----------------------------------------------------
// (2026-11-11) The page chat no longer folds its middle: it shows a window on
// its newest messages and reveals older ones from the top (chatwindow.test.mjs).
// Ten messages fit the window whole, so there is no control of any kind.
{
  ok('a chat: no fold control', !chatThread().querySelector('.showmore[data-act="expand"], .showmore[data-act="fold"]'));
  ok('…no count in a gap', !chatThread().querySelector('.foldgap'));
  ok('…and, short enough to fit its window, no "Show earlier" line either', !chatThread().querySelector('.showmore'));
  ok('…every message is drawn', chatThread().querySelectorAll('.reply').length === 10);
}

// ---- 3. a reader scrolled up is not moved by a reply or a poll --------------
chatPane.scrollTop = 120;
drawer.setPage(page(conv(11, 'chat')));
await tick(10);
ok('a new message arriving does not move a reader who scrolled up', chatPane.scrollTop === 120, chatPane.scrollTop);
drawer.setPage(page(conv(11, 'chat')));
await tick(10);
ok('…nor does a poll bringing nothing new', chatPane.scrollTop === 120, chatPane.scrollTop);

// ---- 4/5. (the chat's own fold control is gone; see chatwindow.test.mjs) --------
chatPane.scrollTop = 200;
drawer.setPage(page(conv(12, 'chat')));
await tick(10);
ok('a bot answering does not move a reader who scrolled up', chatPane.scrollTop === 200, chatPane.scrollTop);
ok('…and the chat still draws every message, unfolded', chatThread().querySelectorAll('.reply').length === 12
  && !chatThread().querySelector('.showmore'));

// ---- 6. switching to a chat while its tab is hidden -------------------------
// the reader is on Comments when a different page's chat arrives; the landing
// waits for the tab rather than being spent on a pane nobody can see
root.querySelector('.tab[data-tab="comments"]').click();
await tick(5);
chatPane.scrollTop = 0;
drawer.setPage({ ...page(conv(10, 'other')), url: 'https://example.com/other' });
await tick(10);
ok('a chat arriving on a hidden tab does not scroll it yet', chatPane.scrollTop === 0, chatPane.scrollTop);
root.querySelector('.tab[data-tab="chat"]').click();
await tick(5);
ok('…going to the tab lands at its newest message', chatPane.scrollTop === LANDED, chatPane.scrollTop);
chatPane.scrollTop = 50;
root.querySelector('.tab[data-tab="comments"]').click();
root.querySelector('.tab[data-tab="chat"]').click();
await tick(5);
ok('…once: coming back to the tab later leaves the reader where they were', chatPane.scrollTop === 50, chatPane.scrollTop);

// ---- 7. a comment thread among other cards ----------------------------------
root.querySelector('.tab[data-tab="comments"]').click();
await tick(5);
const longCard = () => root.querySelector(`.card[data-thread="${LONG}"]`);
const longThread = () => longCard() && longCard().querySelector('.thread');
{
  const kids = kidsOf(longThread());
  const ctrls = longCard().querySelectorAll('.showmore');
  ok('a long comment thread: one control, at the foot of its messages',
    ctrls.length === 1 && kids[kids.length - 1] === ctrls[0] && ctrls[0].dataset.act === 'expand',
    kids.map(k => k.className).join(' | '));
  ok('…and the count in its gap', !!longThread().querySelector('.foldgap'));
  ok('a two-message thread has neither', !root.querySelector(`.card[data-thread="${SHORT}"] .showmore`)
    && !root.querySelector(`.card[data-thread="${SHORT}"] .foldgap`));
}
comPane.scrollTop = 0;
longCard().querySelector('.showmore[data-act="expand"]').click();
await tick(10);
ok('unfolding a comment thread brings the foot of ITS card to the bottom of the pane',
  comPane.scrollTop === LANDED, comPane.scrollTop);
ok('…with the control still last', kidsOf(longThread()).pop().dataset.act === 'fold');
comPane.scrollTop = 333;
drawer.setPage(page(conv(12, 'chat'), [
  { id: LONG, quote: 'a long passage', msgs: conv(12, 'long') },
  { id: SHORT, quote: 'a short passage', msgs: conv(2, 'short') },
]));
await tick(10);
ok('a reply landing in the open thread leaves a scrolled-up reader alone', comPane.scrollTop === 333, comPane.scrollTop);

// ---- 8. the bubble ------------------------------------------------------------
drawer.close();
drawer.setBubbles('bubbles');
drawer.showBubble(LONG);
await tick(10);
const bub = () => root.querySelector(`.bubble[data-thread="${LONG}"]`);
const body = () => bub().querySelector('.bbody');
const stack = () => bub().querySelector('.bstack');
const foot = () => bub().querySelector('.bfoot');
{
  ok('a bubble is up', !!bub(), drawer.bubbleState(LONG));
  const lip = foot() && foot().querySelector('.bfan');
  ok('shut: the lip is in the foot slot, not among the cards', !!lip && !stack().querySelector('.bfan'));
  ok('…the foot sits under the scroller and above the reply box',
    foot() && foot().previousElementSibling === body()
    && kidsOf(bub()).indexOf(foot()) < kidsOf(bub()).indexOf(bub().querySelector(':scope > .composer')));
  ok('…the stack shows only the newest card', stack().querySelectorAll('.bcard').length === 1
    && /long message 11/.test(stack().textContent));
  ok('…and the count is exact', lip && lip.textContent.trim().endsWith('+11'), lip && lip.textContent);
  ok('…with slivers under the card, nearest (widest) first',
    lip && [...lip.querySelectorAll('.bedge')].map(e => e.className).join(',') === 'bedge e2,bedge e1,bedge e0');
}
body().scrollTop = 0;
const lipBefore = foot().querySelector('.bfan');
lipBefore.click();
await tick(10);
{
  const lip = foot().querySelector('.bfan');
  ok('open: the lip is in the same slot', !!lip && lip.classList.contains('open') && !stack().querySelector('.bfan'),
    foot().innerHTML.slice(0, 200));
  ok('…every card is drawn, oldest first', stack().querySelectorAll('.bcard').length === 12
    && /long message 0/.test(stack().firstElementChild.textContent)
    && /long message 11/.test(stack().lastElementChild.textContent));
  ok('fanning open leaves the stack at the newest card (its foot), not the top',
    body().scrollTop === BODY_SH && drawer.bubbleState(LONG).fanned, 'scrollTop=' + body().scrollTop);
}
// a reader scrolled up through the fanned stack is not moved by a reply
body().scrollTop = 40;
const keepFoot = foot();
drawer.setPage(page(conv(12, 'chat'), [
  { id: LONG, quote: 'a long passage', msgs: conv(13, 'long') },
  { id: SHORT, quote: 'a short passage', msgs: conv(2, 'short') },
]));
await tick(10);
ok('a reply while scrolled up in a fanned stack leaves the reader where they were', body().scrollTop === 40, body().scrollTop);
ok('…the count line keeps its slot (the foot is never rebuilt)', foot() === keepFoot && !!foot().querySelector('.bfan.open'));
ok('…and the composer is the same element', !!bub().querySelector(':scope > .composer'));
foot().querySelector('.bfan').click();
await tick(10);
ok('stacking back up: the lip is shut, in the same slot, with the new count',
  !!foot().querySelector('.bfan:not(.open)') && foot().querySelector('.bfan').textContent.trim().endsWith('+12')
  && stack().querySelectorAll('.bcard').length === 1, foot().textContent);
drawer.showBubble(SHORT);
await tick(10);
ok('a short thread\'s bubble has an empty foot', !root.querySelector(`.bubble[data-thread="${SHORT}"] .bfoot .bfan`));

console.log(`foldfoot: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
