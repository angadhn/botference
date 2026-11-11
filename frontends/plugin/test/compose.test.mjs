// compose.test.mjs — typing with an input method (Japanese, Chinese, accents).
//
// While a character is being chosen ("composing"), the half-made text is in
// the box and Enter belongs to the input method: it picks the character. Two
// faults were reasoned on 2026-11-10: Enter could SEND the half-made message,
// and a redraw (a bot event) rebuilt the box mid-choice and cut the text short.
//
// What is asserted here:
//   · the pure machine D.ime: its three modes and three moves, the refusals;
//   · in the drawer (happy-dom): Enter with isComposing, or keyCode 229, does
//     not send, in a thread's reply box and in the page chat; plain Enter
//     afterwards does; a bot event while composing leaves the very same box
//     (not a rebuilt one) with its text, and the held redraw runs the moment
//     the character is chosen; a composition whose box lost the focus does
//     not hold redraws back.
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
  const M = D.imeMove;
  eq('the three modes, named', D.IME_MODES, ['none', 'composing', 'held']);
  eq('the three moves, named', D.IME_MOVES, ['start', 'hold', 'end']);
  const box = {};
  const c = M(null, 'start', box);
  eq('start: none → composing', D.imeMode(c), 'composing');
  ok('…in that box', c.el === box);
  ok('a second start while composing is refused', throws(() => M(c, 'start', box)));
  ok('start with no box is refused', throws(() => M(null, 'start')));
  const h = M(c, 'hold');
  eq('hold: composing → held', D.imeMode(h), 'held');
  eq('hold again: still held', D.imeMode(M(h, 'hold')), 'held');
  ok('hold with nothing composed is refused', throws(() => M(null, 'hold')));
  eq('end: → none, from anything', [M(h, 'end'), M(c, 'end'), M(null, 'end')], [null, null, null]);
  ok('an unknown move is refused', throws(() => M(c, 'composing')));
  ok('composingKey: isComposing', D.composingKey({ isComposing: true, key: 'Enter' }));
  ok('composingKey: keyCode 229', D.composingKey({ isComposing: false, keyCode: 229, key: 'Enter' }));
  ok('composingKey: a plain Enter is not', !D.composingKey({ isComposing: false, keyCode: 13, key: 'Enter' }));
}

// ---- 2. in the drawer --------------------------------------------------------
const URL_ = 'https://example.com/article';
const THR = 'thr-1';
const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({
  ts: `2026-11-11T10:${String(i).padStart(2, '0')}:00.000Z`,
  author: i % 2 ? 'claude' : 'reader', text: `${tag} message ${i}`,
}));
const sent = [];
const drawer = D.create({
  cssText: '.panel{}',
  onReply: async (target, text) => { sent.push({ target, text }); return { ok: true }; },
});
drawer.setConn(true);
drawer.setAuthor('reader');
drawer.open('comments');
drawer.setPage({ url: URL_, title: 'Article', page_chat: msgs(2, 'chat'),
  threads: [{ id: THR, quote: 'a passage', msgs: msgs(2, 'thread') }] });
await tick(20);
const root = drawer.shadow;
const box = () => root.querySelector(`.pane[data-pane="comments"] .composer[data-target="${THR}"] textarea`);
const botEvent = () => drawer.onEvent({ type: 'chat', url: URL_, target: 'thr-other', kind: 'turn-start', agents: ['claude'] });
const key = (el, init) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true, ...init }));
const compose = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true, composed: true }));
const keyCode229 = el => {
  const ev = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(ev, 'keyCode', { value: 229 });
  el.dispatchEvent(ev);
};

{
  ok('the thread reply box is drawn', !!box());
  const b = box();
  b.focus();
  compose(b, 'compositionstart');
  b.value = 'にほん';
  b.dispatchEvent(new w.Event('input', { bubbles: true }));
  key(b, { isComposing: true });
  await tick(5);
  ok('Enter while choosing a character does not send', sent.length === 0, JSON.stringify(sent.length));
  keyCode229(b);
  await tick(5);
  ok('…nor does a key the input method has taken (keyCode 229)', sent.length === 0);
  botEvent();
  await tick(5);
  ok('a redraw while choosing leaves the very same box (not rebuilt)', box() === b && b.isConnected);
  ok('…with its half-made text', b.value === 'にほん');
  ok('…and the focus', root.activeElement === b);
  b.value = '日本';
  compose(b, 'compositionend');
  await tick(5);
  ok('the held redraw runs the moment the character is chosen (the box is rebuilt)', box() !== b);
  ok('…with the chosen text', !!box() && box().value === '日本', box() && box().value);
  ok('…and the focus back on it', root.activeElement === box());
  key(box(), {});
  await tick(10);
  ok('plain Enter afterwards sends', sent.length === 1 && sent[0].text === '日本', JSON.stringify(sent));
}

// a composition whose box lost the focus does not hold redraws back
{
  const b = box();
  b.focus();
  compose(b, 'compositionstart');
  b.blur();
  botEvent();
  await tick(5);
  ok('a composition in a box that lost the focus does not hold a redraw', box() !== b);
}

// the page chat, where Enter sends with Shift (or ⌘) — still never mid-choice
{
  drawer.open('chat');
  await tick(5);
  const pc = root.querySelector('.composer[data-target="__page__"] textarea');
  ok('the page chat box is drawn', !!pc);
  pc.focus();
  compose(pc, 'compositionstart');
  pc.value = 'かな';
  const before = sent.length;
  key(pc, { isComposing: true, metaKey: true });
  key(pc, { isComposing: true, shiftKey: true });
  await tick(5);
  ok('⌘↩ or ⇧↩ while choosing a character does not send in the page chat', sent.length === before);
  compose(pc, 'compositionend');
}

console.log(`compose: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
