// THE /quote MARKER: a line that is only `/quote` in the owner's comment puts the thread's quoted passage there.
// Without it a post reads as before (the first comment, the passage, the rest), byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as N from '../blyg-note.mjs';
import * as C from './fixtures/quotemark-corpus.mjs';

const Grammar = createRequire(import.meta.url)('../extension/tkgrammar.js');
const GOLDEN = JSON.parse(fs.readFileSync(new URL('./fixtures/quotemark-golden.json', import.meta.url), 'utf8'));
const { ID, ORIGIN, POST, BID, NOW, HOME } = C;
const mine = (text, ts = '2026-11-22T10:00:00Z', extra = {}) => ({ author: 'owner', ts, text, provenance: 'owner-typed', ...extra });
const stamp = { status: 'blyg', id: ID, version: 2, origin: ORIGIN, page: POST, passage: { match: true } };
const blygPage = threads => ({ url: POST, title: 'A made-up post', blyg: { status: 'blyg', item: { origin: ORIGIN, id: ID, version: 2, page: POST } }, threads });
const webPage = (threads, extra = {}) => ({ url: 'https://news.example.test/a/story?id=7', title: 'A story', threads, ...extra });
const make = (page, extra = {}) => N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', id: BID, ...extra });
const bodyOf = r => r.text.split('\n---\n')[1];
const frontOf = r => r.text.split('\n---\n')[0];
const QUOTE = `![[${ID} | A made-up post]]\n> A sentence that the post really says.`;
const one = (...msgs) => blygPage([{ id: 't1', quote: 'A sentence that the post really says.', blyg: stamp, msgs }]);

test('the grammar: a line that is only /quote (any case, spaces around), outside code and outside an agent\'s passage', () => {
  const at = text => Grammar.quoteMarks(text).map(m => text.slice(m.start, m.end));
  assert.deepEqual(at('/quote'), ['/quote']);
  assert.deepEqual(at('a\n  /QUOTE \t\nb'), ['  /QUOTE \t']);
  assert.deepEqual(at('a\n/Quote\nb\n/quote'), ['/Quote', '/quote'], 'every one is found (the note writer refuses a second)');
  for (const text of ['/quote it', 'x /quote', '/quotes', '\\/quote', '/ quote', '`/quote`', '```\n/quote\n```', '~~~\n/quote\n~~~',
    '/tk /quote', '> /quote', '- /quote']) assert.deepEqual(at(text), [], JSON.stringify(text));
  assert.equal(Grammar.QUOTE_WORD, '/quote');
  assert.deepEqual(Grammar.quoteMarks('a\n/quote\nb')[0], { start: 2, end: 8 });
});

test('no marker: exactly today\'s output, byte for byte, for every case of the corpus (some hold the letters where they are not one)', () => {
  for (const [name, page] of Object.entries(C.CASES)) {
    const r = N.renderShortNote({ page, threads: page.threads, home: C.HOME, now: C.NOW, slug: 's', id: C.BID, ...(C.EXTRA[name] || {}) });
    assert.deepEqual(JSON.parse(JSON.stringify(r)), GOLDEN[name], name);
  }
});

test('the marker places the quote: first, between two paragraphs, last; the marker itself is never written', () => {
  const first = make(one(mine('/quote\nI agree with this.\n\nAnd more.')));
  assert.ok(first.ok, first.error);
  assert.equal(bodyOf(first), `${QUOTE}\n\nI agree with this.\n\nAnd more.\n`);
  const middle = make(one(mine('Above it.\n\n  /QUOTE  \n\nBelow it.')));
  assert.equal(bodyOf(middle), `Above it.\n\n${QUOTE}\n\nBelow it.\n`);
  const tight = make(one(mine('Above it.\n/quote\nBelow it.')));
  assert.equal(bodyOf(tight), bodyOf(middle), 'no blank lines needed around the marker');
  const last = make(one(mine('My words.\n/quote')));
  assert.equal(bodyOf(last), `My words.\n\n${QUOTE}\n`);
  for (const r of [first, middle, tight, last]) assert.ok(!/\/quote/i.test(r.text), r.text);
});

test('the title is the owner\'s first words, after the quote when the quote is first, never the quoted words', () => {
  const r = make(one(mine('/quote\nI agree with this, and here is why.')));
  assert.match(frontOf(r), /^title: "?I agree with this/m);
  assert.equal(r.title, N.titleOf('I agree with this, and here is why.'));
  assert.ok(!/sentence that the post/.test(frontOf(r)));
});

test('references, mentions, stub_of and who is told are the same with and without the marker', () => {
  const pages = [
    t => one(mine(t)),
    t => webPage([{ id: 't1', quote: 'Hiring is slowing.', msgs: [mine(t)] }], { export_response: 'response' }),
    t => webPage([{ id: 't1', quote: 'Hiring is slowing.', msgs: [mine(t + '\n\nSee <https://other.example.test/x> and https://bare.example.test/y')] }]),
  ];
  for (const p of pages) {
    const plain = make(p('Words here.'));
    const marked = make(p('/quote\nWords here.'));
    assert.ok(plain.ok && marked.ok);
    assert.equal(frontOf(marked), frontOf(plain));
    for (const k of ['title', 'sources', 'generated', 'notify', 'permalink']) assert.deepEqual(marked[k], plain[k], k);
    assert.deepEqual(marked.snapshot.sources, plain.snapshot.sources);
    assert.deepEqual(marked.snapshot.quotes, plain.snapshot.quotes);
    assert.equal(marked.snapshot.stub, plain.snapshot.stub);
    assert.deepEqual(N.linkTargetsOf(p('/quote\nWords [x](https://l.example.test/a).').threads), N.linkTargetsOf(p('Words [x](https://l.example.test/a).').threads));
  }
});

test('a thread of several messages: the marker in any one of them puts the quote at that point of the combined text', () => {
  const r = make(one(mine('First.'), mine('Second, above.\n/quote\nSecond, below.', '2026-11-22T10:01:00Z'), mine('Third.', '2026-11-22T10:02:00Z')));
  assert.ok(r.ok, r.error);
  assert.equal(bodyOf(r), `First.\n\nSecond, above.\n\n${QUOTE}\n\nSecond, below.\n\nThird.\n`);
  const alone = make(one(mine('First.'), mine('/quote', '2026-11-22T10:01:00Z'), mine('Third.', '2026-11-22T10:02:00Z')));
  assert.equal(bodyOf(alone), `First.\n\n${QUOTE}\n\nThird.\n`, 'a message that is only the marker');
  const opens = make(one(mine('/quote'), mine('Then mine.', '2026-11-22T10:01:00Z')));
  assert.equal(bodyOf(opens), `${QUOTE}\n\nThen mine.\n`);
  assert.equal(opens.title, N.titleOf('Then mine.'), 'the name from the owner\'s first words after the quote');
});

test('one marker per thread: a second /quote line (in the same message or another) is refused before anything is written', () => {
  for (const p of [one(mine('/quote\nA.\n/quote\nB.')), one(mine('/quote\nA.'), mine('B.\n/quote', '2026-11-22T10:01:00Z'))]) {
    const r = make(p);
    assert.equal(r.ok, false);
    assert.ok(r.blocked.includes(N.QUOTE_ONCE_SAY), r.error);
  }
  assert.equal(N.QUOTE_ONCE_SAY, 'Only one /quote line can place the quoted passage: remove the others, or put them in code formatting');
  // a /quote in code beside a real one is code, not a second marker
  assert.ok(make(one(mine('/quote\nA `/quote` and\n\n```\n/quote\n```'))).ok);
});

test('each thread places its own quote (add to an earlier post: each added section)', () => {
  const p = webPage([{ id: 't1', quote: 'One.', msgs: [mine('/quote\nAbout one.')] },
    { id: 't2', quote: 'Two.', msgs: [mine('About two, above.\n/quote\nbelow.', '2026-11-22T11:00:00Z')] }]);
  const r = make(p);
  assert.ok(r.ok, r.error);
  const card = q => `> ${q}\n>\n> https://news.example.test/a/story?id=7`;
  assert.equal(bodyOf(r), `${card('One.')}\n\nAbout one.\n\nAbout two, above.\n\n${card('Two.')}\n\nbelow.\n`);
  assert.equal(r.title, N.titleOf('About one.'));
});

test('a thread with no quoted passage: the marker line is left out (nothing to place, never written)', () => {
  const r = make(webPage([{ id: 't1', quote: '', msgs: [mine('Above.\n/quote\nBelow.')] }]));
  assert.ok(r.ok, r.error);
  assert.equal(bodyOf(r), 'Above.\n\nBelow.\n');
});

test('in code or in an agent\'s passage the letters are text; a passage beside a marker keeps its place and its record', () => {
  const g = { instruction: 'go', mode: 'filled-by-agent', agent: 'claude', model: 'm', text: 'Agent words.\n/quote\nMore.' };
  const r = make(one({ ...mine('Mine.\n/tk go\n/quote\nAfter.'), gaps: [g] }));
  assert.ok(r.ok, r.error);
  assert.equal(bodyOf(r), `Mine.\n\n[TK] go [=]Agent words.\n/quote\nMore.[/TK]\n\n${QUOTE}\n\nAfter.\n`);
  assert.equal(r.generated.length, 1);
});

test('the snapshot: no marker hashes as before; moving the marker is an edit of that comment', () => {
  const a = make(one(mine('Above.\n/quote\nBelow.')));
  const b = make(one(mine('/quote\nAbove.\nBelow.')));
  assert.notEqual(a.snapshot.threads[0].msgs[0].sha, b.snapshot.threads[0].msgs[0].sha);
  assert.equal(N.changelogLine(a.snapshot, b.snapshot), 'Edited the comment.');
  // the companion matches a published comment by the hash of ownText(...).text (blyg-run.mjs): the same for both readings
  const m = mine('Above.\n/quote\nBelow.');
  assert.equal(N.hashOf(N.ownText(m).text), a.snapshot.threads[0].msgs[0].sha);
});

test('the reading preview draws the quote where the marker put it', () => {
  const r = make(one(mine('/quote\nMine.')));
  assert.deepEqual(N.readingOf(r.text).map(p => p.kind), ['quote', 'words']);
});

test('a label of first words never holds the marker', () => {
  assert.equal(N.withoutQuoteMarks('/quote\nMy words.'), '\nMy words.');
  assert.equal(N.withoutQuoteMarks('A\n  /QUOTE\nB\n`/quote`'), 'A\n\nB\n`/quote`');
  assert.equal(N.withoutQuoteMarks('No marker.'), 'No marker.');
});

test('the hint, one string for the drawer and the Hub', () => {
  assert.equal(N.QUOTE_HINT, 'A line with only /quote puts the quoted passage there.');
  const drawer = fs.readFileSync(new URL('../extension/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes(`'${N.QUOTE_HINT}'`), 'the drawer carries the same words');
});
