// modes.test.mjs — three small controls whose state used to be a pile of
// flags, each now ONE named mode changed through ONE function that refuses an
// illegal move (the owner's standing rule: no implicit state machines).
//
//   · "+ new chat" and its archive chooser — was confirm/open/loading flags
//     beside a `busy` text field; now D.newchat.mode (NEWCHAT_MODES).
//   · a page row's rename / tag box — was two fields (`renaming`, `tagging`)
//     for one mode, and the typed text lived only in the box, so a refresh of
//     the list while the box was not focused emptied it; now D.pages.row
//     (ROW_EDIT_MODES), holding which page, which kind, and the text.
//   · one pop-up bubble — was three yes/no maps per thread (stack fanned,
//     dragged by hand, started as a new comment); now B.how[id] with two
//     named parts (BUB_PLACES, BUB_STACKS). The fanned stack's "open" is
//     spelled one way only.
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

// ---- 1. "+ new chat", pure ---------------------------------------------------
{
  const M = D.newChatMove;
  eq('new chat: the six modes, named', D.NEWCHAT_MODES, ['idle', 'confirm', 'reading', 'list', 'starting', 'opening']);
  eq('new chat: the ten moves, named', D.NEWCHAT_MOVES, ['ask', 'decline', 'start', 'show', 'hide', 'read', 'unread', 'open', 'done', 'failed']);
  const asked = M(null, 'ask');
  eq('ask: idle → confirm', asked.mode, 'confirm');
  eq('decline: confirm → idle', M(asked, 'decline').mode, 'idle');
  const starting = M(asked, 'start');
  eq('start: confirm → starting', starting.mode, 'starting');
  ok('start from idle is refused (no yes without the ask)', throws(() => M(null, 'start')));
  ok('a second start while starting is refused', throws(() => M(starting, 'start')));
  ok('ask while starting is refused', throws(() => M(starting, 'ask')));
  eq('done: starting → idle', M(starting, 'done').mode, 'idle');
  const failed = M(starting, 'failed', 'no room');
  eq('failed: starting → idle, with why', [failed.mode, failed.err], ['idle', 'no room']);
  const reading = M(null, 'show');
  eq('show with no rows yet: idle → reading', reading.mode, 'reading');
  const listed = M(reading, 'read', [{ index: 0 }, { index: 1 }]);
  eq('read: reading → list, rows kept', [listed.mode, listed.list.length], ['list', 2]);
  eq('show again once the rows are known goes straight to list', M(M(listed, 'hide'), 'show').mode, 'list');
  eq('read after the chooser was closed: rows kept, mode left alone',
    (() => { const v = M(M(reading, 'hide'), 'read', [{ index: 3 }]); return [v.mode, v.list.length]; })(), ['idle', 1]);
  eq('unread: reading → list, with why', (() => { const v = M(reading, 'unread', 'down'); return [v.mode, v.err]; })(), ['list', 'down']);
  const opening = M(listed, 'open', 1);
  eq('open: list → opening, on that row', [opening.mode, opening.index], ['opening', 1]);
  ok('open from idle is refused', throws(() => M(null, 'open', 0)));
  ok('open with no row is refused', throws(() => M(listed, 'open', 'x')));
  ok('show while opening is refused', throws(() => M(opening, 'show')));
  eq('failed: opening → list, with why', (() => { const v = M(opening, 'failed', 'gone'); return [v.mode, v.err, v.index]; })(), ['list', 'gone', null]);
  eq('done: opening → idle, the rows to be read afresh', (() => { const v = M(opening, 'done'); return [v.mode, v.list]; })(), ['idle', null]);
  eq('ask from the open chooser: list → confirm', M(listed, 'ask').mode, 'confirm');
  ok('an unknown move is refused', throws(() => M(null, 'busy')));
}

// ---- 2. the row editor, pure -------------------------------------------------
{
  const M = D.rowEditMove;
  eq('row editor: the three modes, named', D.ROW_EDIT_MODES, ['none', 'rename', 'tag']);
  eq('row editor: the three moves, named', D.ROW_EDIT_MOVES, ['open', 'type', 'close']);
  eq('null is none', D.rowEditMode(null), 'none');
  const r = M(null, 'open', { kind: 'rename', url: 'https://x/a', text: 'Old' });
  eq('open: which page, which kind, the text', r, { kind: 'rename', url: 'https://x/a', text: 'Old' });
  eq('…which is the rename mode', D.rowEditMode(r), 'rename');
  eq('type: the text as it now is', M(r, 'type', { text: 'New' }).text, 'New');
  eq('open another row: that one only', D.rowEditMode(M(r, 'open', { kind: 'tag', url: 'https://x/b', text: '' })), 'tag');
  ok('type with no box open is refused', throws(() => M(null, 'type', { text: 'x' })));
  ok('open with no kind is refused', throws(() => M(null, 'open', { url: 'https://x/a' })));
  ok('open with no page is refused', throws(() => M(null, 'open', { kind: 'tag' })));
  eq('close: → none', M(r, 'close'), null);
  ok('an unknown move is refused', throws(() => M(r, 'renaming')));
}

// ---- 3. one bubble's own state, pure -------------------------------------------
{
  const M = D.bubbleHowMove;
  eq('bubble: the three places, named', D.BUB_PLACES, ['ours', 'growing', 'theirs']);
  eq('bubble: the two stack states, named', D.BUB_STACKS, ['shut', 'open']);
  eq('bubble: the six moves, named', D.BUB_HOW_MOVES, ['drag', 'adopt', 'close', 'fan', 'unfan', 'forget']);
  const fanned = M(null, 'fan');
  eq('fan: shut → open', fanned, { place: 'ours', stack: 'open' });
  ok('fan when already open is refused', throws(() => M(fanned, 'fan')));
  ok('unfan when already shut is refused', throws(() => M(null, 'unfan')));
  eq('unfan: open → shut', M(fanned, 'unfan').stack, 'shut');
  const grown = M(null, 'adopt');
  eq('adopt: ours → growing', grown.place, 'growing');
  eq('close: growing → ours, the stack kept', M(M(grown, 'fan'), 'close'), { place: 'ours', stack: 'open' });
  const theirs = M(grown, 'drag');
  eq('drag: → theirs', theirs.place, 'theirs');
  eq('adopt never takes a dragged bubble back', M(theirs, 'adopt').place, 'theirs');
  eq('close keeps a dragged bubble theirs', M(theirs, 'close').place, 'theirs');
  eq('forget: → null', M(theirs, 'forget'), null);
  ok('an unknown move is refused', throws(() => M(null, 'moved')));
}

// ---- 4. in the drawer ---------------------------------------------------------
const URL_ = 'https://example.com/article';
const PAGES = [
  { url: 'https://example.com/a', title: 'Page A', updated_at: '2026-11-10T10:00:00Z', threads: 1, tags: ['one'] },
  { url: 'https://example.com/b', title: 'Page B', updated_at: '2026-11-09T10:00:00Z', threads: 0 },
];
const calls = [];
let archiveAnswer = { ok: true, archive: [{ index: 0, title: 'An older chat', archived_at: '2026-11-01T10:00:00Z', count: 3 }] };
let openAnswer = { ok: false, error: 'that chat is gone' };
let newAnswer = { ok: true };
const drawer = D.create({
  cssText: '.panel{}',
  onPages: async () => ({ ok: true, index: Object.fromEntries(PAGES.map(p => [p.url, p])) }),
  onLibrary: async () => ({ ok: true, page: { url: 'bfp://library', page_chat: [] } }),
  onPageChatArchive: async () => { calls.push('archive'); return archiveAnswer; },
  onPageChatOpen: async i => { calls.push('open ' + i); return openAnswer; },
  onPageChatNew: async () => { calls.push('new'); return newAnswer; },
});
drawer.setConn(true);
drawer.setOwner(true);
drawer.setAuthor('reader');
drawer.open('chat');
drawer.setPage({ url: URL_, title: 'Article', page_chat: [{ ts: '2026-11-10T10:00:00.000Z', author: 'reader', text: 'hello' }],
  threads: [], chat_archive: [{ index: 0 }] });
await tick(20);
const root = drawer.shadow;
const act = a => root.querySelector(`[data-act="${a}"]`);

// "+ new chat"
{
  ok('the + new chat button is drawn', !!act('page-chat-new'));
  act('page-chat-new').click();
  await tick(5);
  ok('+ new chat puts up the one-step ask', !!act('page-chat-new-yes') && !act('page-chat-new'));
  act('page-chat-new-no').click();
  await tick(5);
  ok('no takes it down again', !act('page-chat-new-yes') && !!act('page-chat-new'));
  act('page-chat-arch').click();
  await tick(10);
  ok('archive ▾ reads the set-aside chats and lists them', calls.includes('archive') && !!root.querySelector('.archrow[data-act="page-chat-open"]'));
  root.querySelector('.archrow[data-act="page-chat-open"]').click();
  await tick(10);
  ok('opening a row that fails says why, under the chooser', calls.includes('open 0')
    && /that chat is gone/.test((root.querySelector('.pagearch') || {}).textContent || ''));
  act('page-chat-arch').click();
  await tick(5);
  ok('archive ▴ closes the chooser', !root.querySelector('.pagearch'));
  act('page-chat-new').click();
  await tick(5);
  act('page-chat-new-yes').click();
  await tick(10);
  ok('yes starts a fresh chat, and the control is back to its buttons', calls.includes('new')
    && !!act('page-chat-new') && !act('page-chat-new-yes') && !root.querySelector('.rvnote.busy'));
}

// the rename / tag box keeps what was typed through a refresh, focused or not
{
  drawer.showPages();
  await tick(20);
  const ren = root.querySelector('.prow[data-url="https://example.com/a"] [data-act="page-rename"]');
  ok('rename button is there', !!ren);
  ren.click();
  await tick(5);
  const box = () => root.querySelector('.pedit .pinput[data-act="rename-input"]');
  ok('the rename box opens with the page’s name', !!box() && box().value === 'Page A');
  box().value = 'My own name';
  box().dispatchEvent(new w.Event('input', { bubbles: true }));
  box().blur();
  ok('…and the box is not focused now', root.activeElement !== box());
  drawer.refreshPages();
  await tick(20);
  ok('a refresh of the list while the box is not focused keeps what was typed', !!box() && box().value === 'My own name',
    box() && box().value);
  // the tag box on another row replaces it: one mode, one row
  root.querySelector('.prow[data-url="https://example.com/b"] [data-act="page-tag"]').click();
  await tick(5);
  ok('opening the tag box on another row closes the rename box', !box()
    && root.querySelectorAll('.pedit').length === 1 && !!root.querySelector('.pedit .pinput[data-act="tag-input"]'));
  const tagBox = () => root.querySelector('.pedit .pinput[data-act="tag-input"]');
  tagBox().value = 'two, three';
  tagBox().dispatchEvent(new w.Event('input', { bubbles: true }));
  tagBox().blur();
  drawer.refreshPages();
  await tick(20);
  ok('the tag box keeps its text through a refresh too', !!tagBox() && tagBox().value === 'two, three');
  root.querySelector('[data-act="tag-no"]').click();
  await tick(5);
  ok('cancel closes it', !root.querySelector('.pedit'));
}

console.log(`modes: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
