// editbox.test.mjs — editing one of your own messages survives a redraw.
//
// The report (2026-11-11): editing an old message in the side panel puts up
// an edit box; when a bot event redraws the panel the box was destroyed, and
// what had been typed with it. (In a bubble it survived, because a bubble's
// cards are patched, not rebuilt.)
//
// The fix keeps "which message is being edited" in ONE value, D.edit — the
// conversation, the message's ts and author, and the draft with its caret —
// changed only through editMove, which refuses an illegal move. The panel and
// the bubble both draw the editor from it. What is asserted here:
//   · the pure machine: its two modes, its five moves, and the refusals
//     (a second start, typing / saving / cancelling with nothing open);
//   · in the drawer (happy-dom): a redraw puts the box back with the typed
//     text, the caret and the focus; a second ✎ does not open a second box;
//     Cancel, Save and leaving the page each end the edit; a failed Save does
//     not; a deleted message ends its edit.
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
  const M = D.editMove;
  eq('the two modes, named', D.EDIT_MODES, ['none', 'open']);
  eq('the five moves, named', D.EDIT_MOVES, ['start', 'type', 'save', 'cancel', 'leave']);
  eq('null is none', D.editMode(null), 'none');
  const ed = M(null, 'start', { target: 'thr', ts: 't1', author: 'reader', text: 'hello there' });
  eq('start: the message and its stored text, caret at the end', ed,
    { target: 'thr', ts: 't1', author: 'reader', text: 'hello there', start: 11, end: 11 });
  eq('…which is open', D.editMode(ed), 'open');
  ok('a second start while one is open is refused', throws(() => M(ed, 'start', { target: 'thr', ts: 't2', text: 'x' })));
  ok('a start with no message is refused', throws(() => M(null, 'start', { target: 'thr' })));
  const typed = M(ed, 'type', { text: 'hello again', start: 2, end: 5 });
  eq('type: the draft and the selection', [typed.text, typed.start, typed.end, typed.ts], ['hello again', 2, 5, 't1']);
  eq('type: a caret past the end is pulled back to it', [M(ed, 'type', { text: 'hi', start: 9, end: 9 }).start], [2]);
  eq('type: an end before the start is the start', M(ed, 'type', { text: 'hello', start: 4, end: 1 }).end, 4);
  ok('type with nothing open is refused', throws(() => M(null, 'type', { text: 'x' })));
  eq('save: open → none', M(typed, 'save'), null);
  ok('save with nothing open is refused', throws(() => M(null, 'save')));
  eq('cancel: open → none', M(typed, 'cancel'), null);
  ok('cancel with nothing open is refused', throws(() => M(null, 'cancel')));
  eq('leave: open → none', M(typed, 'leave'), null);
  eq('leave with nothing open is no move at all', M(null, 'leave'), null);
  ok('an unknown move is refused', throws(() => M(ed, 'resume')));
  ok('isEditOf: the same conversation, ts and author', D.isEditOf(ed, 'thr', { ts: 't1', author: 'reader' }));
  ok('…not the same ts from another author (a ts is not an identity)', !D.isEditOf(ed, 'thr', { ts: 't1', author: 'claude' }));
  ok('…not the same message in another conversation', !D.isEditOf(ed, 'other', { ts: 't1', author: 'reader' }));
}

// ---- 2. in the drawer --------------------------------------------------------
const URL_ = 'https://example.com/article';
const THR = 'thr-1';
const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({
  ts: `2026-11-11T10:${String(i).padStart(2, '0')}:00.000Z`,
  author: i % 2 ? 'claude' : 'reader', text: `${tag} message ${i}`,
}));
let rec = null;
const page = (url, threadMsgs) => ({
  url: url || URL_, title: 'Article', page_chat: msgs(4, 'chat'),
  threads: [{ id: THR, quote: 'a passage', msgs: threadMsgs || msgs(4, 'thread') }],
});
const edits = [];
let editAnswer = { ok: true };
const drawer = D.create({
  cssText: '.panel{}',
  onEdit: async (target, ts, text) => { edits.push({ target, ts, text }); return editAnswer; },
});
drawer.setConn(true);
drawer.setAuthor('reader');
drawer.open('comments');
rec = page();
drawer.setPage(rec);
await tick(20);
const root = drawer.shadow;
const active = () => root.activeElement;
const card = () => root.querySelector(`.pane[data-pane="comments"] .card[data-thread="${THR}"]`);
const mineAt = i => card().querySelector(`.reply[data-ts="${msgs(4, 'x')[i].ts}"][data-author="reader"]`);
const box = () => root.querySelector('.composer[data-target="__edit__"] textarea');
const boxes = () => root.querySelectorAll('.composer[data-target="__edit__"]');
// a bot event, as content.js forwards one: a full render()
const botEvent = () => drawer.onEvent({ type: 'chat', url: URL_, target: 'thr-other', kind: 'turn-start', agents: ['claude'] });

// open the edit on the reader's first message in the thread
mineAt(0).querySelector('[data-act="edit"]').click();
await tick(5);
ok('✎ opens the edit box, focused, holding the stored text',
  !!box() && active() === box() && box().value === 'thread message 0');
// the reader types, and leaves the caret in the middle
box().value = 'thread message 0, now longer';
box().setSelectionRange(7, 14);
box().dispatchEvent(new w.Event('input', { bubbles: true }));
const before = box();
botEvent();
await tick(5);
ok('a redraw rebuilt the panel (the old box is gone from the page)', !before.isConnected);
ok('…and the edit box is back, with what was typed', !!box() && box().value === 'thread message 0, now longer',
  box() && box().value);
ok('…still in place of the same message', !!mineAt(0) && !!mineAt(0).querySelector('.composer[data-target="__edit__"]'));
ok('…with the focus', active() === box(), active() && active().tagName);
ok('…and the caret / selection where it was', box() && box().selectionStart === 7 && box().selectionEnd === 14,
  box() && box().selectionStart + '-' + box().selectionEnd);

// typed without an input event (paste by script, dictation): a redraw still keeps it
box().value = 'typed with no input event';
botEvent();
await tick(5);
ok('a redraw keeps text that arrived without an input event', !!box() && box().value === 'typed with no input event');

// a redraw while the box does NOT have the focus: the text comes back, the
// focus is not given to it
box().blur();
botEvent();
await tick(5);
ok('unfocused: the box comes back with its text', !!box() && box().value === 'typed with no input event');
ok('…and is not handed the focus', active() !== box());

// a second ✎ does not open a second box: the open one gets the focus back
mineAt(2).querySelector('[data-act="edit"]').click();
await tick(5);
ok('a second ✎ opens no second box', boxes().length === 1 && !!mineAt(0).querySelector('.composer[data-target="__edit__"]'));
ok('…and hands the focus to the box already open', active() === box());

// Cancel ends it
card().querySelector('.composer[data-target="__edit__"] [data-act="edit-cancel"]').click();
await tick(5);
ok('Cancel ends the edit: no box, the message as it was', !box() && /thread message 0/.test(mineAt(0).textContent));
botEvent();
await tick(5);
ok('…and a redraw does not bring it back', !box());
ok('…and nothing was sent', edits.length === 0);

// Save, refused by the companion: the box stays, with its text
mineAt(2).querySelector('[data-act="edit"]').click();
await tick(5);
ok('✎ on another message works once the first edit is over', !!box() && box().value === 'thread message 2');
box().value = 'a better second message';
editAnswer = { ok: false, error: 'made-up refusal' };
card().querySelector('[data-act="edit-save"]').click();
await tick(10);
ok('a refused Save sends once', edits.length === 1 && edits[0].text === 'a better second message' && edits[0].target === THR);
ok('…and keeps the box open with the text', !!box() && box().value === 'a better second message');

// Save, accepted: the edit ends
editAnswer = { ok: true };
card().querySelector('[data-act="edit-save"]').click();
await tick(10);
ok('an accepted Save sends the text', edits.length === 2 && edits[1].text === 'a better second message'
  && edits[1].ts === msgs(4, 'x')[2].ts);
ok('…and ends the edit', !box());

// leaving the page ends an open edit
mineAt(0).querySelector('[data-act="edit"]').click();
await tick(5);
box().value = 'half-typed when the page changed';
drawer.setPage(page('https://example.com/elsewhere'));
await tick(10);
ok('a different page: no edit box, anywhere', !box());
drawer.setPage(page());
await tick(10);
ok('…and coming back does not reopen it', !box());

// a message deleted while it is being edited ends the edit
mineAt(0).querySelector('[data-act="edit"]').click();
await tick(5);
ok('(edit open again)', !!box());
drawer.setPage(page(URL_, msgs(4, 'thread').slice(1)));
await tick(10);
ok('the message being edited is deleted: the edit ends', !box());
drawer.setPage(page());
await tick(10);
ok('…and does not come back with the message', !box());

// the page chat: the same box, the same survival
drawer.open('chat');
await tick(5);
const chatMine = () => root.querySelector(`.pane[data-pane="chat"] .reply[data-ts="${msgs(4, 'x')[2].ts}"][data-author="reader"]`);
chatMine().querySelector('[data-act="edit"]').click();
await tick(5);
box().value = 'chat edit in progress';
box().setSelectionRange(4, 4);
box().dispatchEvent(new w.Event('input', { bubbles: true }));
drawer.onEvent({ type: 'chat', url: URL_, kind: 'turn-start', agents: ['claude'] });
await tick(5);
ok('page chat: a redraw keeps the edit box, its text, caret and focus',
  !!box() && box().value === 'chat edit in progress' && active() === box() && box().selectionStart === 4);
// Enter-to-send (⌘↩) in the edit box saves the edit, it does not post a reply
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, composed: true }));
await tick(10);
ok('⌘↩ in the edit box saves the edit', edits.length === 3 && edits[2].target === '__page__'
  && edits[2].text === 'chat edit in progress');
ok('…and ends it', !box());

console.log(`editbox: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
