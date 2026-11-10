// typingfocus.test.mjs — a full redraw of the drawer never takes the typing
// cursor out of the box the reader is typing in.
//
// The reader's report: while the bots are working and they keep typing — in
// the page chat, a thread's reply box, "or whatever it is" — every now and
// then the cursor just leaves the box and the next keystrokes go nowhere.
//
// The cause: render() rebuilds both panes (innerHTML), so the box being typed
// in is thrown away and a new one drawn. Its TEXT was carried over (D.drafts)
// and the panes' scroll was carried over, but its keyboard focus, its caret
// and selection, and its own inner scroll were not. A streaming reply only
// patches the live text (no rebuild), which is why the fault came and went:
// it bit whenever a full render() happened to land — a turn starting, a reply
// settling, a status changing, a poll.
//
// What is asserted here, for every text box a rebuild replaces:
//   · after a redraw caused the way a bot event causes one, the same box (by
//     what it is FOR, never by node) has the focus again, with the same text,
//     the same selection and direction, and the same inner scroll;
//   · a redraw never GIVES focus: nothing focused before → nothing after, and
//     a focus on the web page itself stays on the web page;
//   · a box that no longer exists after the redraw (tab changed, thread gone)
//     is left alone — nothing else is focused in its place;
//   · the pane does not move because of it (refocus never scrolls).
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

const URL_ = 'https://example.com/article';
const THR = 'thr-1', THR2 = 'thr-2';
const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({
  ts: `2026-11-10T10:${String(i).padStart(2, '0')}:00.000Z`,
  author: i % 2 ? 'claude' : 'reader', text: `${tag} message ${i}`,
}));
const page = extra => ({
  url: URL_, title: 'Article', page_chat: msgs(2, 'chat'),
  threads: [
    { id: THR, quote: 'a passage', msgs: msgs(2, 'one') },
    { id: THR2, quote: 'another passage', msgs: msgs(2, 'two') },
  ],
  ...(extra || {}),
});

const PAGES = [
  { url: 'https://example.com/a', title: 'Page A', updated_at: '2026-11-10T10:00:00Z', threads: 1 },
  { url: 'https://example.com/b', title: 'Page B', updated_at: '2026-11-09T10:00:00Z', threads: 0 },
];
const drawer = D.create({
  cssText: '.panel{}',
  onPages: async () => ({ ok: true, index: Object.fromEntries(PAGES.map(p => [p.url, p])) }),
  onLibrary: async () => ({ ok: true, page: { url: 'bfp://library', page_chat: [] } }),
});
drawer.setConn(true);
drawer.setOwner(true);
drawer.setAuthor('reader');
drawer.open('chat');
drawer.setPage(page({ projects: [{ root: '/r', id: 'p1' }] }));
await tick(20);
const root = drawer.shadow;
const active = () => root.activeElement;

// A bot event, exactly as content.js forwards one: each of these makes the
// drawer do a full render().
let n = 0;
const botStarts = (target) => drawer.onEvent({ type: 'chat', url: URL_, target, kind: 'turn-start', agents: ['claude'] });
const botReplies = (target) => drawer.onEvent({ type: 'chat', url: URL_, target, kind: 'reply',
  msg: { ts: `2026-11-10T11:${String(n++).padStart(2, '0')}:00.000Z`, author: 'claude', text: 'a reply ' + n } });
const botEnds = (target) => drawer.onEvent({ type: 'chat', url: URL_, target, kind: 'turn-end' });

// Type into a box the way a reader does, leave a backwards selection in the
// middle of it and the box's own text scrolled a little.
const TEXT = 'the quick brown fox jumps over the lazy dog';
function typeInto(box, text = TEXT, start = 4, end = 15, dir = 'backward') {
  box.focus();
  box.value = text;
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  box.setSelectionRange(start, end, dir);
  box.scrollTop = 7;
  return { box, text, start, end, dir };
}
// The same box, after: by what it is for, and a NEW node (the rebuild really
// happened — otherwise the test proves nothing).
function sameBox(name, before, find) {
  const now = find();
  ok(`${name}: the box was rebuilt (a new node)`, now && now !== before.box);
  ok(`${name}: it has the focus again`, !!now && active() === now,
    'active=' + (active() ? active().tagName + '.' + active().className : 'null'));
  ok(`${name}: same text`, now && now.value === before.text, now && JSON.stringify(now.value));
  ok(`${name}: same selection`, now && now.selectionStart === before.start && now.selectionEnd === before.end,
    now && `${now.selectionStart}-${now.selectionEnd}`);
  ok(`${name}: same selection direction`, now && now.selectionDirection === before.dir, now && now.selectionDirection);
  ok(`${name}: same inner scroll`, now && now.scrollTop === 7, now && now.scrollTop);
}
const paneBox = (pane, target) => root.querySelector(
  `.pane[data-pane="${pane}"] .composer[data-target="${target}"] textarea`);

// ---- 1. the page chat ------------------------------------------------------
{
  const chatPane = root.querySelector('.pane[data-pane="chat"]');
  chatPane.scrollTop = 0;
  const b = typeInto(paneBox('chat', '__page__'));
  botStarts('__page__');
  sameBox('page chat, turn starts', b, () => paneBox('chat', '__page__'));
  const b2 = { ...b, box: paneBox('chat', '__page__') };
  botReplies('__page__');
  sameBox('page chat, a reply settles', b2, () => paneBox('chat', '__page__'));
  const b3 = { ...b, box: paneBox('chat', '__page__') };
  botEnds('__page__');
  sameBox('page chat, turn ends', b3, () => paneBox('chat', '__page__'));
  // the same, with the event about somewhere else entirely
  const b4 = { ...b, box: paneBox('chat', '__page__') };
  botReplies(THR2);
  sameBox('page chat, a reply in another thread', b4, () => paneBox('chat', '__page__'));
}

// ---- 2. a comment thread's reply box ----------------------------------------
drawer.open('comments');
await tick(5);
{
  const b = typeInto(paneBox('comments', THR));
  botReplies(THR);
  sameBox('thread reply box, a reply in it', b, () => paneBox('comments', THR));
  const b2 = { ...b, box: paneBox('comments', THR) };
  botStarts(THR2);
  sameBox('thread reply box, another thread starts', b2, () => paneBox('comments', THR));
  botEnds(THR2);
}

// ---- 3. the new comment (pending) box ----------------------------------------
{
  drawer.beginNew({ quote: 'a fresh passage', prefix: '', suffix: '' });
  await tick(5);
  const find = () => paneBox('comments', '__new__');
  ok('pending composer is drawn', !!find());
  if (find()) {
    const b = typeInto(find(), 'a new comment being written', 2, 2, 'none');
    b.dir = 'none';
    botReplies(THR);
    // selection direction 'none' with a caret: still asserted as the same
    sameBox('new comment box, a reply elsewhere', b, find);
  }
  drawer.cancelNew();
  await tick(5);
}

// ---- 4. the @-menu: one path puts the box back, and the menu stays ----------
{
  const box = paneBox('comments', THR);
  box.focus();
  box.value = 'hello @cl';
  box.setSelectionRange(9, 9);
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  const menu = () => root.querySelector(`.pane[data-pane="comments"] .composer[data-target="${THR}"] .mentions`);
  ok('@-menu opens on "@cl"', menu() && !menu().hidden);
  botReplies(THR2);
  const now = paneBox('comments', THR);
  ok('@-menu: box rebuilt and focused', now !== box && active() === now);
  ok('@-menu: caret where it was', now.selectionStart === 9 && now.selectionEnd === 9, `${now.selectionStart}-${now.selectionEnd}`);
  ok('@-menu: the menu is still open', menu() && !menu().hidden);
  now.value = '';
  now.dispatchEvent(new w.Event('input', { bubbles: true }));
}

// ---- 5. never steals ---------------------------------------------------------
{
  active() && active().blur();
  ok('setup: nothing in the drawer has focus', !active());
  botReplies(THR);
  ok('nothing focused before → nothing focused after', !active(),
    active() && active().tagName);
  // focus on the web page itself
  const pageInput = w.document.createElement('input');
  w.document.body.appendChild(pageInput);
  pageInput.focus();
  ok('setup: the web page has the focus', w.document.activeElement === pageInput);
  botReplies(THR);
  ok('focus on the page stays on the page', w.document.activeElement === pageInput && !active());
  pageInput.blur();
  pageInput.remove();
  // a button in the drawer is not a text box: nothing to put back, and
  // render() does not invent a focus for it either
}

// ---- 6. a box that no longer exists is left alone -------------------------
{
  const b = typeInto(paneBox('comments', THR));
  // the tab changes as part of the same redraw (the comments pane hides)
  drawer.open('chat');
  botReplies(THR2);
  const hiddenBox = paneBox('comments', THR);
  ok('tab changed: the hidden box is not given the focus', active() !== hiddenBox);
  ok('…and nothing else was focused in its place', !active() || active() === b.box,
    active() && active().tagName + '.' + active().className);
  drawer.open('comments');
  await tick(5);
  // the thread goes away under the reader
  const b2 = typeInto(paneBox('comments', THR2));
  drawer.setPage(page({ threads: [{ id: THR, quote: 'a passage', msgs: msgs(2, 'one') }], projects: [{ root: '/r', id: 'p1' }] }));
  await tick(5);
  ok('thread gone: no box for it', !paneBox('comments', THR2));
  ok('thread gone: nothing else takes the focus', !active(), active() && active().tagName);
  void b2;
  drawer.setPage(page({ projects: [{ root: '/r', id: 'p1' }] }));
  await tick(5);
}

// ---- 7. refocus does not move the pane ------------------------------------
{
  const pane = root.querySelector('.pane[data-pane="comments"]');
  const box = paneBox('comments', THR);
  box.focus();
  pane.scrollTop = 13;
  const seen = [];
  const desc = Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, 'scrollIntoView');
  w.HTMLElement.prototype.scrollIntoView = function () { seen.push(this); };
  const realFocus = w.HTMLElement.prototype.focus;
  const opts = [];
  w.HTMLElement.prototype.focus = function (o) { opts.push(o); return realFocus.call(this, o); };
  botReplies(THR2);
  w.HTMLElement.prototype.focus = realFocus;
  if (desc) Object.defineProperty(w.HTMLElement.prototype, 'scrollIntoView', desc);
  else delete w.HTMLElement.prototype.scrollIntoView;
  ok('refocus asks for no scroll', opts.length > 0 && opts.every(o => o && o.preventScroll === true), JSON.stringify(opts));
  ok('…and nothing was scrolled into view', seen.length === 0);
  ok('…and the pane is where it was', pane.scrollTop === 13 || pane.scrollTop === 0, pane.scrollTop);
}

// ---- 8. the make-artifact brief (a one-line box in the chat pane) -----------
{
  drawer.open('chat');
  await tick(5);
  const btn = root.querySelector('[data-act="make-artifact"]');
  ok('make-artifact button is there', !!btn && !btn.disabled);
  if (btn) btn.click();
  await tick(5);
  const find = () => root.querySelector('.pane[data-pane="chat"] [data-role="artifact-brief"]');
  ok('artifact brief box is drawn', !!find());
  if (find()) {
    const b = typeInto(find(), 'a planner of what to watch', 2, 9, 'forward');
    b.box.scrollTop = 7;
    botReplies('__page__');
    sameBox('artifact brief, a reply in the chat', b, find);
    const no = root.querySelector('[data-act="make-artifact-no"]');
    if (no) no.click();
  }
}

// ---- 9. the library: its composer, redrawn by a reply landing --------------
{
  drawer.showPages();
  await tick(20);
  const find = () => root.querySelector('.pane[data-pane="pages"] .composer[data-target="__library__"] textarea');
  ok('library composer is drawn', !!find());
  if (find()) {
    const b = typeInto(find());
    // a library reply lands: content.js hands the drawer the new record
    drawer.setLibrary({ url: 'bfp://library', page_chat: msgs(3, 'lib') });
    sameBox('library composer, setLibrary', b, find);
    const b2 = { ...b, box: find() };
    drawer.refreshPages();     // the live refresh of the list under it
    await tick(20);
    sameBox('library composer, the list refreshes', b2, find);
    const b3 = { ...b, box: find() };
    drawer.render();
    sameBox('library composer, a full render', b3, find);
  }
}

// ---- 10. a page row's rename box, under a live refresh ----------------------
{
  const ren = root.querySelector('[data-act="page-rename"]');
  ok('rename button is there', !!ren);
  if (ren) ren.click();
  await tick(5);
  const find = () => root.querySelector('.pane[data-pane="pages"] .pedit .pinput[data-act="rename-input"]');
  ok('rename box is drawn', !!find());
  if (find()) {
    const b = typeInto(find(), 'My own name', 3, 6, 'forward');
    drawer.refreshPages();
    await tick(20);
    sameBox('rename box, the list refreshes', b, find);
  }
  drawer.showThreads();
  await tick(5);
}

// ---- 11. the edit box ------------------------------------------------------
// In a pane the edit composer is drawn by startEdit straight into the DOM, and
// a rebuild of the pane takes it away whole (see the report: not a focus fault
// but a lost edit). Here: whatever happens, the redraw does not throw and does
// not hand the focus to some other box.
{
  drawer.open('comments');
  await tick(5);
  const reply = root.querySelector(`.pane[data-pane="comments"] .card[data-thread="${THR}"] .reply[data-author="reader"]`);
  const edit = reply && reply.querySelector('[data-act="edit"]');
  if (edit) {
    edit.click();
    await tick(5);
    const box = root.querySelector('.composer[data-target="__edit__"] textarea');
    ok('edit box opens focused', !!box && active() === box);
    botReplies(THR2);
    const again = root.querySelector('.composer[data-target="__edit__"] textarea');
    ok('edit box: focus is on the edit box or on nothing — never elsewhere',
      !active() || active() === again, active() && active().tagName);
  } else {
    ok('edit button found on a reader message', false, 'no [data-act="edit"]');
  }
}

console.log(`typingfocus: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
