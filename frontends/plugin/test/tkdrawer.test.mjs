// tkdrawer.test.mjs — a /tk gap drawn as an agent block inside the reader's
// own message, and the block's actions.
//
//   node frontends/plugin/test/tkdrawer.test.mjs
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
const asked = [];
const drawer = D.create({ isTrusted: () => true, cssText: '.panel{}', onModels: async () => ({ ok: true, current: {}, options: {} }),
  onBlygCheck: async () => ({ ok: true, status: 'not-a-blyg' }),
  onGap: async body => { asked.push(body); return { ok: true }; } });
drawer.setConn(true); drawer.setAuthor('reader');
drawer.open('chat');
const text = 'Before.\n/tk explain it\nMiddle /tk(a word) and /tk(third) and /tk(fourth) end. \\/tk(not a gap)';
const gaps = [
  { id: 'g0', instruction: 'explain it', mode: 'filled-by-agent', text: 'The agent\'s **answer**.', agent: 'claude', at: 't' },
  { id: 'g1', instruction: 'a word', mode: 'pending' },
  { id: 'g2', instruction: 'third', mode: 'failed', reason: 'the agent took too long' },
  { id: 'g3', instruction: 'fourth', mode: 'adopted-by-reader', text: 'now mine' },
];
drawer.setPage({ url: URL_, title: 'A', threads: [],
  page_chat: [{ author: 'reader', ts: '2026-11-21T10:00:00Z', text, provenance: 'owner-typed', gaps }] });
await tick(20);
const S = drawer.shadow;
const blocks = () => [...S.querySelectorAll('.gapblock')];
eq('one block per gap: an adopted one is still the agent\'s words (a post shows it boxed, "Claude + you")', blocks().map(b => b.className), [
  'gapblock filled-by-agent', 'gapblock pending', 'gapblock failed', 'gapblock adopted-by-reader']);
eq('adopted: "made yours", and only remove', [blocks()[3].querySelector('.gapstate').textContent, [...blocks()[3].querySelectorAll('.gapbtn')].map(x => x.textContent)], ['made yours', ['remove']]);
const b0 = blocks()[0];
const marks = b => b.querySelector('.gaphead .pubagentmarks');
eq('the block carries the published box\'s marks, no name on it (the name only in the tooltip and accessible name)',
  [!!marks(b0).querySelector('svg'), !!marks(b0).querySelector('.pubagentA'), marks(b0).getAttribute('role'), marks(b0).getAttribute('aria-label'), marks(b0).getAttribute('title'), /agent|Claude|Codex/.test(b0.querySelector('.gaphead').textContent)],
  [true, false, 'img', 'Written by an AI model (Claude)', 'Written by an AI model (Claude)', false]);
eq('…an accepted ("mine") passage: the robot and the owner\'s mark', [!!marks(blocks()[3]).querySelector('.pubagentA'), marks(blocks()[3]).getAttribute('aria-label')], [true, 'Written by an AI model and edited by the author'], 'no agent recorded: no name in it');
eq('"mine" says what happens: accepted as it stands, still published as written with an AI', b0.querySelector('.gapbtn[data-op="adopt"]').getAttribute('title'), 'accept this text as it stands: it still publishes marked as written with an AI');
ok('…draws the agent\'s text as markdown', !!b0.querySelector('.gaptext strong'), b0.innerHTML);
eq('…and the instruction, de-emphasised', b0.querySelector('.gapask').textContent, 'asked: explain it');
eq('filled: fill again, edit, mine, remove', [...b0.querySelectorAll('.gapbtn')].map(x => x.textContent), ['fill again', 'edit', 'mine', 'remove']);
eq('pending: writing, no actions', [blocks()[1].querySelector('.gapstate').textContent, blocks()[1].querySelectorAll('.gapbtn').length], ['writing…', 0]);
eq('failed: the reason, and try again', [blocks()[2].querySelector('.reason').textContent, [...blocks()[2].querySelectorAll('.gapbtn')].map(x => x.textContent)],
  ['the agent took too long', ['fill again', 'remove']]);
const words = S.querySelector('.reply').textContent;
ok('the reader\'s words around the blocks stay', words.includes('Before.') && words.includes('Middle') && words.includes('end.'), words);
ok('an adopted gap\'s words are on screen', words.includes('now mine'));
ok('`\\/tk` shows as the letters', words.includes('/tk(not a gap)') && !words.includes('\\/tk'), words);

// actions
b0.querySelector('.gapbtn[data-op="refill"]').click(); await tick(10);
eq('fill again asks the companion', asked.pop(), { thread_id: '', ts: '2026-11-21T10:00:00Z', gap_id: 'g0', action: 'refill' });
blocks()[0].querySelector('.gapbtn[data-op="edit"]').click(); await tick(10);
const box = S.querySelector('textarea.gapedit');
ok('edit opens a box with the agent\'s text', box && box.value === 'The agent\'s **answer**.');
eq('…the field that says which block is edited', drawer.gapEdit, '__page__|2026-11-21T10:00:00Z|g0');
box.value = 'My own rewrite.';
S.querySelector('[data-act="gap-save"]').click(); await tick(10);
eq('save sends the new words', asked.pop(), { thread_id: '', ts: '2026-11-21T10:00:00Z', gap_id: 'g0', action: 'edit', text: 'My own rewrite.' });
eq('…and the box closes', drawer.gapEdit, null);
blocks()[0].querySelector('.gapbtn[data-op="adopt"]').click(); await tick(10);
eq('mine: adopt', asked.pop().action, 'adopt');

blocks()[0].querySelector('.gapbtn[data-op="remove"]').click(); await tick(10);
eq('remove', asked.pop().action, 'remove');

// SENT, then FILLED IN PLACE, with no reload: the companion's page broadcast brings the record again (content.js setPage) and the
// block that said "writing…" now holds the text, where it was, with its buttons
const sent = 'Intro.\n/tk-codex summarise it\nAfter, and /tkimpyrt-claude(pasted words) end.';
const asSent = (g0) => ({ url: URL_, title: 'A', threads: [], page_chat: [{ author: 'reader', ts: '9', text: sent, provenance: 'owner-typed',
  gaps: [g0, { id: 'p1', kind: 'impyrt', agent: 'claude', instruction: 'pasted words', mode: 'pasted-by-reader', text: 'pasted words', at: 't' }] }] });
drawer.setPage(asSent({ id: 'c0', kind: 'ask', agent: 'codex', instruction: 'summarise it', mode: 'pending' })); await tick(20);
const first = blocks()[0];
eq('sent: "writing…", by Codex (the agent the owner named)', [first.querySelector('.gapstate').textContent, marks(first).getAttribute('aria-label'), first.querySelector('.gaptext').textContent], ['writing…', 'Written by an AI model (Codex)', 'the agent is writing this passage…']);
eq('a pasted passage is drawn like an agent fill: its maker, "pasted by you", only remove, no "asked:" line', [marks(blocks()[1]).getAttribute('aria-label'), blocks()[1].querySelector('.gapstate').textContent,
  [...blocks()[1].querySelectorAll('.gapbtn')].map(x => x.textContent), !!blocks()[1].querySelector('.gapask')], ['Written by an AI model (Claude)', 'pasted by you', ['remove'], false]);
drawer.setPage(asSent({ id: 'c0', kind: 'ask', agent: 'codex', instruction: 'summarise it', mode: 'filled-by-agent', text: 'A **summary**.', model: 'gpt-x', at: 't' })); await tick(20);
const filled = blocks()[0];
eq('…the fill lands IN PLACE (same slot, no reload), with its buttons', [blocks().length, filled.className, filled.querySelector('.gaptext').textContent, [...filled.querySelectorAll('.gapbtn')].map(x => x.textContent), S.querySelector('.reply').textContent.indexOf('Intro.') < S.querySelector('.reply').textContent.indexOf('A summary.')],
  [2, 'gapblock filled-by-agent', 'A summary.', ['fill again', 'edit', 'mine', 'remove'], true]);
filled.querySelector('.gapbtn[data-op="refill"]').click(); await tick(10);
eq('fill again on the new block', asked.pop(), { thread_id: '', ts: '9', gap_id: 'c0', action: 'refill' });
filled.querySelector('.gapbtn[data-op="edit"]').click(); await tick(10);
ok('edit opens its box', S.querySelector('textarea.gapedit') && S.querySelector('textarea.gapedit').value === 'A **summary**.');
S.querySelector('[data-act="gap-cancel"]').click(); await tick(10);
blocks()[0].querySelector('.gapbtn[data-op="adopt"]').click(); await tick(10);
eq('mine', asked.pop().action, 'adopt');

// no owner-facing word about bracket markers anywhere in the drawer's own strings
{ const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(here, '..', 'extension', 'drawer.js'), 'utf8');
  const strings = [...src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map(m => m[2]).filter(t => /\[\/?TK\]/i.test(t));
  eq('the drawer never shows or tells the owner about bracket markers', strings, []); }

// an agent's passage holding the site's own bracket marks: shown as needing an edit (the companion refuses to publish it as it is)
drawer.setPage({ url: URL_, title: 'A', threads: [], page_chat: [{ author: 'reader', ts: '7', text: '/tk say it', provenance: 'owner-typed',
  gaps: [{ id: 'm0', instruction: 'say it', mode: 'filled-by-agent', text: 'It says ' + '[' + '/TK] here.', agent: 'claude', at: 't' }] }] });
await tick(20);
eq('a fill with the site\'s marks: "needs an edit", and one line saying why', [blocks()[0].querySelector('.gapstate').textContent, /cannot be published as it is: edit it/.test(blocks()[0].querySelector('.gapneeds').textContent)], ['needs an edit', true]);
drawer.setPage({ url: URL_, title: 'A', threads: [], page_chat: [{ author: 'reader', ts: '8', text: '/tk say it', provenance: 'owner-typed',
  gaps: [{ id: 'm1', instruction: 'say it', mode: 'filled-by-agent', text: 'Plain words.', agent: 'claude', at: 't' }] }] });
await tick(20);
eq('…and an ordinary fill does not say so', [blocks()[0].querySelector('.gapstate'), blocks()[0].querySelector('.gapneeds')], [null, null]);

// typing an inline /tk…(…) says ONCE, quietly, that it publishes as a block of its own
{
  drawer.setOwner(true);
  await tick(10);
  const box = S.querySelector('.composer textarea');
  ok('(a composer to type in)', !!box);
  const type = v => { box.value = v; box.dispatchEvent(new w.Event('input', { bubbles: true, composed: true })); };
  type('A line /tk on its own is not inline');
  eq('a line-form gap: no hint', [drawer.tkBlockHint, drawer.footNote.text], ['unseen', '']);
  type('Mid-sentence /tk-codex(a word) here');
  eq('an inline gap: the hint, once', [drawer.tkBlockHint, drawer.footNote.mode, /will stand as its own block when published/.test(drawer.footNote.text)], ['said', 'info', true]);
  drawer.footNoteMove('clear');
  type('Mid-sentence /tk(another) here');
  eq('…never again', [drawer.tkBlockHint, drawer.footNote.text], ['said', '']);
}

// a guest's message with the same words: no blocks (it carries no gaps)
drawer.setPage({ url: URL_, title: 'A', threads: [], page_chat: [{ author: 'ada', ts: '2', text: '/tk explain it' }] });
await tick(20);
eq('a message with no stored gaps draws its /tk as text', S.querySelectorAll('.gapblock').length, 0);

for (const f of failures) console.log('  FAIL ' + f);
console.log(`tkdrawer: ${pass} passed, ${fail} failed`);
process.exit(fail);
