// chatwindow.test.mjs — a long CHAT reads like a messaging app: it opens on
// its newest messages, and older ones appear above as the reader scrolls up.
//
// The owner's words: "show the last 20 messages and reveal more as we scroll
// up". So in the page chat and the library chat:
//
//   · no middle ever folds away — no "Show N earlier replies", no gap line;
//   · only the newest stretch (about twenty messages, whole turns) is drawn;
//   · a "Show earlier messages" line at the TOP of what is drawn, and the
//     reader scrolling up to it, reveal the next stretch, and the message they
//     were looking at stays exactly where it was on screen;
//   · a reply arriving never moves the top of the window, and never moves a
//     reader who is reading further up;
//   · a jump to an older message (a suggestion's card) grows the window to it;
//   · a different page, or the panel reopened, starts from the newest stretch.
// Since 2026-11-11 a COMMENT THREAD is drawn the same way (section 11): its
// newest stretch, the same line at its top, the same reveal that keeps the
// reader's place, and nothing in its middle ever hidden. A card is not its own
// scroller, so in a thread the line is the only way up (no scroll reveal).
//
// happy-dom does not lay anything out, so the geometry is stubbed: in a pane
// whose window is 500px tall, every message is a 100px box stacked from 300px
// down, in drawing order. What is tested is the DECISION — which scroll offset
// the drawer asked for, which messages it drew — not what a real screen shows.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
const DR = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---- the stubbed geometry ---------------------------------------------------
const TOP = 300, ROW = 100, BTN = 30, PANE_H = 500;
const P = w.HTMLElement.prototype;
const realRect = P.getBoundingClientRect;
const box = (top, h) => ({ top, bottom: top + h, left: 0, right: 400, width: 400, height: h, x: 0, y: top });
const repliesIn = pane => [...pane.querySelectorAll('.card .reply[data-ts]')];
P.getBoundingClientRect = function () {
  const cl = this.classList;
  const pane = this.closest && this.closest('.pane');
  const st = pane ? pane.scrollTop : 0;
  if (cl && cl.contains('pane')) return box(0, PANE_H);
  if (cl && cl.contains('reply') && pane) return box(TOP + repliesIn(pane).indexOf(this) * ROW - st, ROW);
  if (cl && cl.contains('earlier') && pane) return box(TOP - BTN - st, BTN);
  if (cl && cl.contains('card') && pane) return box(TOP - st, repliesIn(pane).length * ROW);
  return realRect.call(this);
};
const geom = (name, fn) => {
  const desc = Object.getOwnPropertyDescriptor(P, name) || Object.getOwnPropertyDescriptor(w.Element.prototype, name);
  Object.defineProperty(P, name, {
    configurable: true,
    get() { const v = fn(this); return v == null ? (desc && desc.get ? desc.get.call(this) : 0) : v; },
  });
};
geom('clientHeight', el => (el.classList.contains('pane') ? PANE_H : null));
geom('scrollHeight', el => (el.classList.contains('pane') ? TOP + repliesIn(el).length * ROW + 40 : null));

// ---- a long chat ------------------------------------------------------------
// n messages, the reader and claude taking turns: one drawn unit each
const T = i => `2026-11-11T09:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
const conv = (n, tag) => Array.from({ length: n }, (_, i) => ({
  ts: T(i), author: i % 2 ? 'claude' : 'reader', text: `${tag} message ${i}`,
}));
const THR = 'thr-long';
const page = (chat, url, thr) => ({
  url: url || 'https://example.com/article', title: 'Article', page_chat: chat,
  threads: [{ id: THR, quote: 'a long passage', msgs: thr || conv(10, 'thread') }],
});

const drawer = DR.create({ cssText: '.panel{}' });
drawer.setConn(true);
drawer.open('chat');
drawer.setPage(page(conv(60, 'chat')));
await tick(20);
const root = drawer.shadow;
const chatPane = root.querySelector('.pane[data-pane="chat"]');
const thread = () => root.querySelector('.card.chatpane .thread');
const replies = () => [...thread().querySelectorAll('.reply')];
const texts = () => replies().map(r => r.textContent);
const has = i => texts().some(t => new RegExp(`chat message ${i}\\b`).test(t));
const earlier = () => thread().querySelector('.showmore.earlier');
const footAt = () => TOP + replies().length * ROW - PANE_H + 8;
const scrollTo = top => { chatPane.scrollTop = top; chatPane.dispatchEvent(new w.Event('scroll')); };

// ---- 1. opening: the newest stretch, no fold --------------------------------
ok('a long chat has no fold control', !thread().querySelector('.showmore[data-act="expand"], .showmore[data-act="fold"]'));
ok('…and no gap line', !thread().querySelector('.foldgap'));
ok('only the newest twenty messages are drawn', replies().length === 20, replies().length);
ok('…the newest one among them', has(59) && !has(39) && has(40));
ok('a "Show earlier messages" line, with how many remain',
  !!earlier() && earlier().textContent.trim() === 'Show earlier messages · 40 more', earlier() && earlier().textContent);
ok('…at the very top of the window', thread().firstElementChild === earlier());
ok('opening lands at the newest message', chatPane.scrollTop === footAt(), chatPane.scrollTop + ' vs ' + footAt());

// ---- 2. the button reveals the next stretch, and nothing jumps ---------------
// the reader at the top: the first message showing is #40, 300px down the pane
scrollTo(0);
earlier().click();
await tick(10);
ok('pressing it reveals twenty more', replies().length === 40 && has(20) && !has(19), replies().length);
ok('…the newest message is still there', has(59));
ok('…and the line now counts the rest', earlier() && /· 20 more$/.test(earlier().textContent), earlier() && earlier().textContent);
{
  // #40 is now the 21st box: 300 + 20*100 down the content. To keep it 300px
  // down the pane the drawer must have scrolled by exactly 2000.
  const at40 = replies().findIndex(r => /chat message 40\b/.test(r.textContent));
  ok('…the message being read stays where it was on screen',
    chatPane.scrollTop === 2000 && TOP + at40 * ROW - chatPane.scrollTop === TOP, 'scrollTop=' + chatPane.scrollTop);
  ok('…which is not a jump to the bottom', chatPane.scrollTop !== footAt());
}

// ---- 3. a reply arriving moves neither the top nor the reader ----------------
scrollTo(1234);
drawer.setPage(page(conv(61, 'chat')));
await tick(10);
ok('a new message adds at the bottom', has(60) && replies().length === 41, replies().length);
ok('…the top of the window stays where it was', has(20) && !has(19));
ok('…and the reader reading older messages is not moved', chatPane.scrollTop === 1234, chatPane.scrollTop);

// ---- 4. scrolling up to the top reveals the rest ----------------------------
scrollTo(900);          // somewhere in the middle: the line is far above
ok('scrolling down does nothing', replies().length === 41);
scrollTo(800);          // up, but the line is still 1000px above the pane
ok('scrolling up far from the top does nothing yet', replies().length === 41);
scrollTo(100);          // up, and the line is within reach
await tick(5);
ok('scrolling up near the top reveals the rest', replies().length === 61 && has(0), replies().length);
ok('…and with nothing older left, the line is gone', !earlier());
{
  // the first message showing at scrollTop 100 was #20 (box 0 spans 300..400,
  // shifted up by 100 → 200..300, bottom > 0). It is now box 20.
  const at20 = replies().findIndex(r => /chat message 20\b/.test(r.textContent));
  ok('…again keeping the message being read in place',
    TOP + at20 * ROW - chatPane.scrollTop === TOP - 100, 'scrollTop=' + chatPane.scrollTop);
}

// ---- 5. a different page starts from the newest stretch ----------------------
drawer.setPage(page(conv(60, 'other'), 'https://example.com/other'));
await tick(10);
ok('a different page: back to the newest twenty', replies().length === 20 && /other message 59/.test(texts().join(' ')));
// …and that window was pinned where it opened: the next reply does not push
// its top down, even though nothing was ever revealed in it
drawer.setPage(page(conv(61, 'other'), 'https://example.com/other'));
await tick(10);
ok('a reply to a freshly opened chat keeps its top', replies().length === 21
  && /other message 40\b/.test(replies()[0].textContent), replies().length);
drawer.setPage(page(conv(60, 'other'), 'https://example.com/other'));
await tick(10);

// ---- 6. a wheel turned up at the very top reveals too ------------------------
// (a pane at scrollTop 0 cannot scroll further, so no scroll event fires)
chatPane.scrollTop = 0;
{
  const e = new w.Event('wheel');
  Object.defineProperty(e, 'deltaY', { value: -120 });
  chatPane.dispatchEvent(e);
}
await tick(5);
ok('a wheel turned upward at the top reveals the next stretch', replies().length === 40, replies().length);

// ---- 7. the panel reopened: the newest stretch again, at the bottom ----------
drawer.close();
drawer.open('chat');
await tick(10);
ok('reopened: back to the newest twenty', replies().length === 20, replies().length);
ok('…landed at the newest message', chatPane.scrollTop === footAt(), chatPane.scrollTop + ' vs ' + footAt());

// ---- 8. a jump to an older message grows the window to it --------------------
{
  const chat = conv(60, 'chat');
  chat[5] = { ...chat[5], suggestions: [{ id: 'sg-old', state: 'open', why: 'a made-up change', old: 'alpha', new: 'beta' }] };
  drawer.setPage(page(chat, 'https://example.com/third'));
  await tick(10);
  ok('before the jump, the old message is not drawn', !has(5) && replies().length === 20);
  const found = drawer.focusSuggestion('__page__', chat[5].ts, 'sg-old');
  await tick(5);
  ok('a jump to a suggestion on an older message finds its card', found === true);
  ok('…the window grew up to that message, not further', has(5) && !has(4) && replies().length === 55, replies().length);
  ok('…and the line still offers the five above it', earlier() && /· 5 more$/.test(earlier().textContent));
}

// ---- 9. set-aside messages keep their fold inside the window -----------------
{
  const chat = conv(30, 'chat').map((m, i) => (i >= 25 && i < 28 ? { ...m, superseded: true } : m));
  drawer.setPage(page(chat, 'https://example.com/fourth'));
  await tick(10);
  const aside = thread().querySelector('details.superseded');
  ok('messages set aside by an edit still fold under "before the edit"',
    !!aside && /3 messages set aside/.test(aside.querySelector('summary').textContent), aside && aside.textContent.slice(0, 80));
}

// ---- 10. the library chat has the same window --------------------------------
drawer.showPages();
await tick(10);
drawer.setLibrary({ url: 'library', page_chat: conv(50, 'lib') });
await tick(10);
{
  const lib = () => root.querySelector('.card.libchat .thread');
  const libReplies = () => (lib() ? [...lib().querySelectorAll('.reply')] : []);
  ok('the library chat: newest twenty, no fold', libReplies().length === 20
    && !lib().querySelector('.showmore[data-act="expand"], .foldgap'), libReplies().length);
  const btn = lib() && lib().querySelector('.showmore.earlier');
  ok('…with the line at its top', !!btn && lib().firstElementChild === btn && /· 30 more$/.test(btn.textContent));
  btn && btn.click();
  await tick(5);
  ok('…which reveals twenty more there too', libReplies().length === 40, libReplies().length);
}
drawer.showThreads();
await tick(5);

// ---- 11. a comment thread has the same window --------------------------------
// The owner, 2026-11-11: comment threads "behave like the page chat: nothing
// hidden in the middle, ever".
{
  const URL5 = 'https://example.com/fifth';
  drawer.setPage(page(conv(20, 'chat'), URL5, conv(50, 'thread')));
  await tick(10);
  root.querySelector('.tab[data-tab="comments"]').click();
  await tick(5);
  const comPane = root.querySelector('.pane[data-pane="comments"]');
  const card = () => root.querySelector(`.card[data-thread="${THR}"]`);
  const tr = () => [...card().querySelectorAll('.thread .reply')];
  const tHas = i => tr().some(r => new RegExp(`thread message ${i}\\b`).test(r.textContent));
  const tLine = () => card().querySelector('.thread .showmore.earlier');
  ok('a long comment thread: no fold, no "Hide", no gap line',
    !card().querySelector('.showmore[data-act="expand"], .showmore[data-act="fold"], .foldgap'));
  ok('…only its newest twenty messages are drawn', tr().length === 20 && tHas(49) && tHas(30) && !tHas(29), tr().length);
  ok('…with "Show earlier messages · 30 more" at the top of its messages',
    !!tLine() && card().querySelector('.thread').firstElementChild === tLine()
    && tLine().textContent.trim() === 'Show earlier messages · 30 more', tLine() && tLine().textContent);
  // scrolling the comments pane up never reveals: the card is not its own
  // scroller, and a pane of many cards must not grow under the reader
  comPane.scrollTop = 200;
  comPane.dispatchEvent(new w.Event('scroll'));
  comPane.scrollTop = 0;
  comPane.dispatchEvent(new w.Event('scroll'));
  await tick(5);
  ok('…scrolling the comments pane up does not reveal anything by itself', tr().length === 20, tr().length);
  // the reader at the top of the pane, reading the thread's first drawn
  // message (#30, 300px down): the line reveals twenty more and #30 stays put
  comPane.scrollTop = 0;
  tLine().click();
  await tick(10);
  ok('pressing it reveals twenty more', tr().length === 40 && tHas(10) && !tHas(9), tr().length);
  {
    const at30 = tr().findIndex(r => /thread message 30\b/.test(r.textContent));
    ok('…keeping the message being read where it was on screen',
      TOP + at30 * ROW - comPane.scrollTop === TOP, 'scrollTop=' + comPane.scrollTop);
  }
  ok('…and the line counts the rest', !!tLine() && /· 10 more$/.test(tLine().textContent));
  // a reply arriving hides nothing already shown and does not move the reader
  comPane.scrollTop = 777;
  drawer.setPage(page(conv(20, 'chat'), URL5, conv(51, 'thread')));
  await tick(10);
  ok('a new reply in the thread is drawn at the bottom', tHas(50) && tr().length === 41, tr().length);
  ok('…without hiding anything that was on screen', tHas(10) && !tHas(9));
  ok('…or moving the reader', comPane.scrollTop === 777, comPane.scrollTop);
  // a jump to an older message in a thread grows its window to it
  const thr = conv(51, 'thread');
  thr[3] = { ...thr[3], suggestions: [{ id: 'sg-thr', state: 'open', why: 'a made-up change', old: 'gamma', new: 'delta' }] };
  drawer.setPage(page(conv(20, 'chat'), 'https://example.com/sixth', thr));
  await tick(10);
  ok('a different page: the thread opens on its newest twenty again', tr().length === 20 && !tHas(3), tr().length);
  const found = drawer.focusSuggestion(THR, thr[3].ts, 'sg-thr');
  await tick(5);
  ok('a jump to a suggestion on an older thread message finds its card', found === true);
  ok('…the thread\'s window grew up to that message, not further', tHas(3) && !tHas(2) && tr().length === 48, tr().length);
  // the panel reopened: the thread goes back to its newest stretch too
  drawer.close();
  drawer.open('comments');
  await tick(10);
  ok('reopened: the thread is back to its newest twenty', tr().length === 20, tr().length);
  ok('…and no chat line leaked into it from anywhere', card().querySelectorAll('.showmore').length === 1);
}

console.log(`chatwindow: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
