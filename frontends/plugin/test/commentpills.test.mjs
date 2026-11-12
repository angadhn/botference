// commentpills.test.mjs — the Comments tab's pill row: All · Notes · With bots.
//
//   1. threadKind — which pill a thread is under, derived from the thread and
//      never stored: 'bots' if a bot (or a summoned agent) speaks in it or one
//      of the people's messages summons one; 'note' otherwise.
//   2. the chosen pill — ONE value (COMMENT_PILLS) changed through ONE setter
//      that refuses anything else; counts are unresolved threads per pill.
//   3. refiling in view — a thread that changes kind while the reader looks at
//      the pill it no longer fits is HELD in place (HOLD_STATES, one setter)
//      with "Moved to …", until the pill or the page changes.
//   4. the pill is remembered per page, in extension storage.
//   5. the old commenter filter is gone.
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
// a fake extension storage, the shape drawer.js's readKey/writeKey use
const store = {};
globalThis.chrome = {
  storage: { local: {
    get(key, cb) { const out = {}; if (key in store) out[key] = JSON.parse(JSON.stringify(store[key])); setTimeout(() => cb(out), 0); },
    set(obj) { for (const k of Object.keys(obj)) store[k] = JSON.parse(JSON.stringify(obj[k])); },
  } },
};
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const clone = x => JSON.parse(JSON.stringify(x));

// ---- 1. threadKind --------------------------------------------------------
{
  const k = msgs => D.threadKind({ id: 't', msgs });
  eq('the kinds, named', D.THREAD_KINDS, ['note', 'bots']);
  eq('a plain comment is a note', k([{ author: 'reader', text: 'keep this line' }]), 'note');
  eq('an empty thread is a note', k([]), 'note');
  eq('a thread with no msgs at all is a note', D.threadKind({ id: 't' }), 'note');
  eq('a missing thread is a note', D.threadKind(null), 'note');
  eq('@claude in the reader’s words: with bots', k([{ author: 'reader', text: '@claude is this right?' }]), 'bots');
  eq('@codex anywhere in the text', k([{ author: 'reader', text: 'ask @codex about it' }]), 'bots');
  eq('@all', k([{ author: 'reader', text: '@all thoughts?' }]), 'bots');
  eq('a summon in a LATER message counts', k([{ author: 'reader', text: 'hm' }, { author: 'reader', text: '@claude ?' }]), 'bots');
  eq('a pill-addressed message (route stamped, no tag in words)', k([{ author: 'reader', text: 'why?', route: 'claude' }]), 'bots');
  eq('…with the @ on the route too', k([{ author: 'reader', text: 'why?', route: '@codex' }]), 'bots');
  eq('a route of none is still a note', k([{ author: 'reader', text: 'mine', route: 'none' }]), 'note');
  eq('a bot speaking in it', k([{ author: 'reader', text: 'hm' }, { author: 'Claude', text: 'yes' }]), 'bots');
  eq('gemini is a bot too', k([{ author: 'gemini', text: 'watched it' }]), 'bots');
  eq('a bot’s tool narration', k([{ author: 'reader', text: 'x' }, { author: 'codex', kind: 'tools', text: 'Read a.md' }]), 'bots');
  eq('a summoned agent’s card', k([{ author: 'reader', text: 'x' }, { author: 'agent', agent: { status: 'done' }, text: '' }]), 'bots');
  eq('"claudette" is a person', k([{ author: 'claudette', text: 'a note' }]), 'note');
  eq('an email-ish "@claudeX" is not a summon', k([{ author: 'reader', text: 'mail me@claudex.com' }]), 'note');
  eq('a guest’s plain reply leaves a note a note', k([{ author: 'reader', text: 'x' }, { author: 'mira', text: 'agreed' }]), 'note');
}

// ---- 2. the pill values and the hold rule (pure) ---------------------------
{
  eq('the pills, named, All first', D.COMMENT_PILLS, ['all', 'notes', 'bots']);
  eq('their labels', D.PILL_LABEL, { all: 'All', notes: 'Notes', bots: 'With bots' });
  eq('the hold states, named', D.HOLD_STATES, ['free', 'held']);
  const note = { id: 'n', msgs: [{ author: 'reader', text: 'x' }] };
  const bot = { id: 'b', msgs: [{ author: 'claude', text: 'y' }] };
  ok('All fits everything', D.pillFits('all', note) && D.pillFits('all', bot));
  ok('Notes fits a note, not a bot thread', D.pillFits('notes', note) && !D.pillFits('notes', bot));
  ok('With bots fits a bot thread, not a note', D.pillFits('bots', bot) && !D.pillFits('bots', note));
  ok('a hold on a thread that no longer fits the pill: allowed', D.holdMove('notes', bot, 'held'));
  ok('a hold under All: refused (nothing can leave All)', !D.holdMove('all', bot, 'held'));
  ok('a hold on a thread that fits anyway: refused', !D.holdMove('notes', note, 'held'));
  ok('a hold on no thread: refused', !D.holdMove('notes', null, 'held'));
  ok('a made-up hold state: refused', !D.holdMove('notes', bot, 'kept'));
  ok('letting go is always allowed', D.holdMove('notes', note, 'free') && D.holdMove('all', null, 'free'));
  ok('a made-up pill holds nothing', !D.holdMove('drafts', bot, 'held'));
}

// ---- 3..5. the drawer -------------------------------------------------------
const URL_ = 'https://example.com/article';
const T = (id, msgs, extra) => ({ id, quote: 'quote ' + id, prefix: '', suffix: '', msgs, ...(extra || {}) });
const PAGE = {
  url: URL_, title: 'Article', page_chat: [],
  threads: [
    T('t-note-1', [{ author: 'reader', ts: '1', text: 'my own note' }]),
    T('t-note-2', [{ author: 'reader', ts: '2', text: 'another note' }]),
    T('t-bot-1', [{ author: 'reader', ts: '3', text: '@claude why?' }, { author: 'claude', ts: '4', text: 'because' }]),
    T('t-bot-2', [{ author: 'reader', ts: '5', text: '@codex check this' }]),
    T('t-note-done', [{ author: 'reader', ts: '6', text: 'filed note' }], { status: 'resolved', summary: 'kept' }),
    T('t-bot-done', [{ author: 'reader', ts: '7', text: '@claude ok?' }, { author: 'claude', ts: '8', text: 'ok' }], { status: 'resolved', summary: 'fine' }),
  ],
};
const d = D.create({ cssText: '.panel{}' });
d.setConn(true); d.setAuthor('reader'); d.open('comments');
d.setPage(clone(PAGE));
await tick(20);
const S = d.shadow;
const pane = () => S.querySelector('.pane[data-pane="comments"]');
const cards = () => [...pane().querySelectorAll('.card[data-thread]')].map(c => c.dataset.thread);
const pillBtn = p => S.querySelector(`.kpill[data-pill="${p}"]`);
const press = async p => { const b = pillBtn(p); if (b) b.click(); await tick(10); return !!b; };
const openArchive = async () => { if (!S.querySelector('.resolved-sec.open')) { S.querySelector('[data-act="resolved-toggle"]').click(); await tick(10); } };

{
  ok('the pill row is drawn at the very top of the Comments pane', pane().firstElementChild && pane().firstElementChild.classList.contains('kindbar'));
  eq('three pills, All first', [...S.querySelectorAll('.kpill')].map(b => b.dataset.pill), ['all', 'notes', 'bots']);
  eq('…labelled', [...S.querySelectorAll('.kpill')].map(b => b.firstChild.textContent.trim()), ['All', 'Notes', 'With bots']);
  eq('All is on to begin with', d.commentPillNow(), 'all');
  ok('…and says so', pillBtn('all').classList.contains('on') && pillBtn('all').getAttribute('aria-pressed') === 'true');
  eq('the counts are UNRESOLVED threads per pill', d.commentPillCounts(), { all: 4, notes: 2, bots: 2 });
  eq('…and the pills show them', [...S.querySelectorAll('.kpill .cn')].map(n => n.textContent), ['4', '2', '2']);
  eq('the Comments tab’s own count is every unresolved thread', S.querySelector('.tab[data-tab="comments"] .count').textContent, '4');
  ok('the old commenter row is gone', !S.querySelector('.cfilter') && !S.querySelector('.cpill') && !S.querySelector('[data-act="filter-by"]'));
  ok('…and its API with it', !('commenters' in d) && !('pickCommenter' in d) && !('commenterFilter' in d) && !('commenter' in d));

  ok('pressing Notes', await press('notes'));
  eq('…turns Notes on', d.commentPillNow(), 'notes');
  eq('…and shows only notes', cards().sort(), ['t-note-1', 't-note-2']);
  await openArchive();
  ok('the resolved note is in the archive under Notes', cards().includes('t-note-done') && !cards().includes('t-bot-done'));
  ok('…and the archive counts under the pill', /Resolved\s*1/.test(S.querySelector('.resolved-head').textContent));
  eq('the tab count does not move with the pill', S.querySelector('.tab[data-tab="comments"] .count').textContent, '4');

  await press('bots');
  eq('With bots shows the bot threads, resolved one in the archive', cards().sort(), ['t-bot-1', 't-bot-2', 't-bot-done']);
  await press('all');
  eq('All shows everything again', cards().length, 6);

  ok('a made-up pill is refused', d.pickCommentPill('drafts') === false && d.commentPillNow() === 'all');
  ok('so is an empty one', d.pickCommentPill('') === false && d.commentPillNow() === 'all');
  ok('…and the field holds only named values', D.COMMENT_PILLS.includes(d.commentPill));
}

// ---- 3. refiling in view ---------------------------------------------------
{
  await press('notes');
  eq('on Notes', cards().sort(), ['t-note-1', 't-note-2', 't-note-done']);
  // a bot answers t-note-1 (the record arrives again, as every refresh does)
  const p2 = clone(PAGE);
  p2.threads[0].msgs.push({ author: 'claude', ts: '9', text: 'an unasked answer' });
  d.setPage(p2); await tick(10);
  eq('it is a bot thread now', D.threadKind(p2.threads[0]), 'bots');
  ok('…but it does NOT vanish from under the reader', cards().includes('t-note-1'));
  eq('…it is held', d.heldThreads(), ['t-note-1']);
  const moved = S.querySelector('.card[data-thread="t-note-1"] .moved');
  ok('…with a line saying where it lives now', !!moved && moved.textContent.trim() === 'Moved to With bots');
  ok('no other card carries the line', S.querySelectorAll('.moved').length === 1);
  eq('the counts already follow the record', d.commentPillCounts(), { all: 4, notes: 1, bots: 3 });
  // another refresh changes nothing — it stays held
  d.setPage(clone(p2)); await tick(10);
  ok('a second refresh keeps it held', cards().includes('t-note-1') && d.heldThreads().length === 1);
  // changing pill lets go
  await press('bots');
  eq('changing pill lets go of every hold', d.heldThreads(), []);
  ok('…it is under With bots, without the line', cards().includes('t-note-1') && !S.querySelector('.moved'));
  await press('notes');
  ok('…and back on Notes it is gone', !cards().includes('t-note-1'));

  // an EDIT that calls a bot does the same thing
  const p3 = clone(p2);
  p3.threads[1].msgs[0].text = 'another note — @codex what do you think?';
  d.setPage(p3); await tick(10);
  ok('a note edited to call a bot is held too', cards().includes('t-note-2') && d.heldThreads().includes('t-note-2'));
  // the same rule in reverse: a held thread that fits again is simply back
  d.setPage(clone(p2)); await tick(10);
  ok('an edit undone: it fits Notes again, the hold goes', cards().includes('t-note-2') && !d.heldThreads().length && !S.querySelector('.moved'));

  // the reverse direction, under With bots: a bot message deleted
  await press('bots');
  const p4 = clone(p2);
  p4.threads[0].msgs = p4.threads[0].msgs.filter(m => m.author !== 'claude');
  d.setPage(p4); await tick(10);
  ok('under With bots, a thread that became a note is held', cards().includes('t-note-1') && d.heldThreads().includes('t-note-1'));
  ok('…saying "Moved to Notes"', /Moved to Notes/.test((S.querySelector('.card[data-thread="t-note-1"] .moved') || {}).textContent || ''));

  // a held thread that is deleted takes its hold with it
  const p5 = clone(p4); p5.threads = p5.threads.filter(t => t.id !== 't-note-1');
  d.setPage(p5); await tick(10);
  eq('a deleted thread’s hold goes with it', d.heldThreads(), []);

  // a change of page lets go too
  d.setPage(clone(p4)); await tick(10);
  ok('(no hold on a thread first seen after it changed)', !d.heldThreads().length);
  await press('notes');
  const p6 = clone(p4); p6.threads[0].msgs.push({ author: 'codex', ts: '10', text: 'me again' });
  d.setPage(p6); await tick(10);
  ok('held again on Notes', d.heldThreads().includes('t-note-1'));
  d.setPage({ url: 'https://example.com/other', title: 'Other', page_chat: [], threads: [] }); await tick(10);
  eq('a change of page lets go of every hold', d.heldThreads(), []);
  eq('…and opens the new page on All', d.commentPillNow(), 'all');
  ok('…a page with no comments shows no pill row', !S.querySelector('.kindbar'));
}

// ---- 4. remembered per page -------------------------------------------------
{
  d.setPage(clone(PAGE)); await tick(20);
  eq('back on the first page, its pill is read back', d.commentPillNow(), 'notes');
  eq('…stored per page, under one key', store['bfp:commentPill'], { [URL_]: 'notes' });
  await press('all');
  await tick(10);
  ok('All is the default and is not stored', !(URL_ in (store['bfp:commentPill'] || {})));
  await press('bots'); await tick(10);
  d.setPage({ url: 'https://example.com/other', title: 'Other', page_chat: [], threads: [T('o1', [{ author: 'reader', text: 'n' }])] });
  await tick(20);
  eq('another page opens on All', d.commentPillNow(), 'all');
  await press('notes'); await tick(10);
  eq('each page keeps its own', store['bfp:commentPill'], { [URL_]: 'bots', 'https://example.com/other': 'notes' });

  // the empty pill
  await press('bots');
  ok('an empty pill says so in one plain line',
    (pane().querySelector('.pillempty') || {}).textContent === 'No bot discussions on this page yet.');
  ok('…not "No comments yet"', !/No comments yet/.test(pane().textContent));
  ok('…and the pill row is still there to leave by', !!S.querySelector('.kindbar'));
  d.setPage({ url: 'https://example.com/third', title: 'Third', page_chat: [], threads: [T('b1', [{ author: 'claude', text: 'hi' }])] });
  await tick(20);
  await press('notes');
  ok('the Notes empty line', (pane().querySelector('.pillempty') || {}).textContent === 'No notes on this page yet.');

  // a remembered pill that is not a pill (an old or hand-edited key) is refused
  store['bfp:commentPill'] = { 'https://example.com/fourth': 'drafts' };
  d.setPage({ url: 'https://example.com/fourth', title: 'Fourth', page_chat: [], threads: [T('x', [{ author: 'reader', text: 'n' }])] });
  await tick(20);
  eq('a stored value outside COMMENT_PILLS is refused on the way back in', d.commentPillNow(), 'all');
}

// ---- 4b. a highlight click always wins ---------------------------------------
{
  d.setPage(clone(PAGE)); await tick(20);
  await press('bots');
  d.focus('t-note-1'); await tick(20);
  eq('focusing a note hidden by With bots stands the pill aside', d.commentPillNow(), 'all');
  ok('…and the card is there', cards().includes('t-note-1'));
}

// ---- 5. the old filter's source is gone ---------------------------------------
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(here, '..', 'extension', 'drawer.js'), 'utf8');
  ok('no D.commenter, commenters(), pickCommenter or filter-by left in drawer.js',
    !/D\.commenter\b|function commenters\b|pickCommenter|'filter-by'|commenterRail/.test(src));
  const css = fs.readFileSync(path.join(here, '..', 'extension', 'drawer.css'), 'utf8');
  ok('no .cfilter / .cpill rules left in drawer.css', !/\.cfilter\b|\.cpill\b/.test(css));
}

console.log(`commentpills: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
