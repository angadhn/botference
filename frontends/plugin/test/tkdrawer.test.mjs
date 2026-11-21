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
const drawer = D.create({ cssText: '.panel{}', onModels: async () => ({ ok: true, current: {}, options: {} }),
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
eq('one block per gap that is the agent\'s (adopted is the reader\'s own words)', blocks().map(b => b.className), [
  'gapblock filled-by-agent', 'gapblock pending', 'gapblock failed']);
const b0 = blocks()[0];
ok('the block says agent and who', /agent/.test(b0.querySelector('.gapword').textContent) && b0.querySelector('.gapwho').textContent === 'Claude');
ok('…carries a robot mark', !!b0.querySelector('.gaprobot svg'));
ok('…draws the agent\'s text as markdown', !!b0.querySelector('.gaptext strong'), b0.innerHTML);
eq('…and the instruction, de-emphasised', b0.querySelector('.gapask').textContent, 'asked: explain it');
eq('filled: fill again, edit, mine, remove', [...b0.querySelectorAll('.gapbtn')].map(x => x.textContent), ['fill again', 'edit', 'mine', 'remove']);
eq('pending: writing, no actions', [blocks()[1].querySelector('.gapstate').textContent, blocks()[1].querySelectorAll('.gapbtn').length], ['writing…', 0]);
eq('failed: the reason, and try again', [blocks()[2].querySelector('.reason').textContent, [...blocks()[2].querySelectorAll('.gapbtn')].map(x => x.textContent)],
  ['the agent took too long', ['fill again', 'remove']]);
const words = S.querySelector('.reply').textContent;
ok('the reader\'s words around the blocks stay', words.includes('Before.') && words.includes('Middle') && words.includes('end.'), words);
ok('an adopted gap reads as the reader\'s own text', words.includes('now mine'));
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

// a guest's message with the same words: no blocks (it carries no gaps)
drawer.setPage({ url: URL_, title: 'A', threads: [], page_chat: [{ author: 'ada', ts: '2', text: '/tk explain it' }] });
await tick(20);
eq('a message with no stored gaps draws its /tk as text', S.querySelectorAll('.gapblock').length, 0);

for (const f of failures) console.log('  FAIL ' + f);
console.log(`tkdrawer: ${pass} passed, ${fail} failed`);
process.exit(fail);
