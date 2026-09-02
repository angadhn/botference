#!/usr/bin/env node
// SUGGEST MODE — the bots propose, the reader accepts, and only then does the
// post change. See SPEC.md "suggest mode" and suggest.mjs.
//
// Two halves, deliberately. The FIRST is the grammar and the apply rule with
// no server anywhere near them: a block read into a card, and a card's passage
// found — or refused — in a file. Those refusals are the whole safety property
// of this feature, so they are tested where nothing can be in the way of them.
// The SECOND is the companion end against a SYNTHETIC Jekyll repo in a temp
// dir and the mock bridge: the developer's real site is never read, never
// written and never bridged against, and no git runs because there is no git
// to run.
//
// The span-matching cases (whitespace runs, curly quotes, ambiguity, drift)
// are ported from the review engine's own, because the matcher is the review
// engine's own — imported, not forked. If these ever disagree with
// frontends/review, one of the two has grown a second matcher and that is the
// bug.
//
//   node frontends/plugin/test/suggest.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHarness, sleep, enc, GET, POST, inputs, listen, request,
} from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

// --- tiny runner ---------------------------------------------------------
// The scaffolding — runner, poller, throwaway root, a companion on a random
// port, JSON over HTTP — is test/harness.mjs, shared with every other suite
// that drives a real server. It was a private copy here, as in eight others.
const {
  test, waitFor, tmp, startServer, cleanup, passed, failures,
} = createHarness({ server: SERVER, tag: 'suggest', realpath: true });


// store.mjs fixes its root at import time — point THIS process at a throwaway
// workspace before any plugin module loads
const OWN_ROOT = tmp('own-store');
process.env.BOTFERENCE_PROJECT_ROOT = OWN_ROOT;
const suggest = await import(path.join(PLUGIN, 'suggest.mjs'));
const blog = await import(path.join(PLUGIN, 'blog.mjs'));

const fence = body => '```suggest\n' + body + '\n```';

// =========================================================================
console.log('\nsuggest — the block a bot writes');

await test('a block reads into current, proposed and why', async () => {
  const { cards, text } = suggest.liftSuggestions(
    'I found one.\n\n' + fence([
      'current: The mass saving is the whole argument and it is not a small one.',
      'proposed: The mass saving is the whole argument, and it is not small.',
      'why: the double negative reads as a hedge',
    ].join('\n')));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].state, 'open');
  assert.equal(cards[0].current, 'The mass saving is the whole argument and it is not a small one.');
  assert.equal(cards[0].proposed, 'The mass saving is the whole argument, and it is not small.');
  assert.equal(cards[0].why, 'the double negative reads as a hedge');
  assert.equal(text, 'I found one.', 'the block is machinery and comes off the words');
  assert.ok(cards[0].id, 'and it is addressable');
});

await test('`from:` and `to:` are the same two fields', async () => {
  const { cards } = suggest.liftSuggestions(fence('from: one\nto: two\nwhy: because'));
  assert.equal(cards[0].current, 'one');
  assert.equal(cards[0].proposed, 'two');
});

await test('every block in one reply counts, in the order written', async () => {
  const { cards, text } = suggest.liftSuggestions([
    'Three typos.',
    fence('current: teh cat\nproposed: the cat\nwhy: typo'),
    'And another:',
    fence('current: recieve\nproposed: receive\nwhy: typo'),
    fence('current: seperate\nproposed: separate\nwhy: typo'),
  ].join('\n\n'));
  assert.equal(cards.length, 3, 'a sweep is a stack, not a last-one-wins');
  assert.deepEqual(cards.map(c => c.current), ['teh cat', 'recieve', 'seperate']);
  assert.match(text, /Three typos\./);
  assert.doesNotMatch(text, /```/, 'and none of the machinery is left in the prose');
});

await test('current and proposed may run over several lines', async () => {
  const { cards } = suggest.liftSuggestions(fence([
    'current: One line.',
    'And a second line of the same passage.',
    'proposed: One line.',
    'A better second line.',
    'why: it scans',
  ].join('\n')));
  assert.equal(cards[0].current, 'One line.\nAnd a second line of the same passage.');
  assert.equal(cards[0].proposed, 'One line.\nA better second line.');
  assert.equal(cards[0].why, 'it scans');
});

await test('a cut must be said, and an empty proposal is refused', async () => {
  const cut = suggest.liftSuggestions(fence('current: A stray sentence.\nproposed: (delete)\nwhy: it repeats'));
  assert.equal(cut.cards[0].state, 'open');
  assert.equal(cut.cards[0].proposed, '');
  assert.equal(cut.cards[0].deletes, true);
  const empty = suggest.liftSuggestions(fence('current: A stray sentence.\nproposed:\nwhy: it repeats'));
  assert.equal(empty.cards[0].state, 'unreadable');
  assert.match(empty.cards[0].error, /\(delete\)/,
    'and the refusal says how a cut is written, rather than deleting the prose on a guess');
});

await test('a block missing a field is a card that says so, and still comes off the words', async () => {
  const a = suggest.liftSuggestions('Hm.\n\n' + fence('proposed: something\nwhy: because'));
  assert.equal(a.cards[0].state, 'unreadable');
  assert.match(a.cards[0].error, /current/);
  assert.equal(a.text, 'Hm.', 'a refusal is visible; it is never silence');
  const b = suggest.liftSuggestions(fence('current: something\nwhy: because'));
  assert.match(b.cards[0].error, /proposed/);
});

await test('a proposal identical to what is there is not a proposal', async () => {
  const { cards } = suggest.liftSuggestions(fence('current: the same\nproposed: the same\nwhy: none'));
  assert.equal(cards[0].state, 'unreadable');
});

await test('a reply with no block is left exactly as it was', async () => {
  const src = 'Just an answer, with a ``` code fence ``` in it.';
  const { cards, text } = suggest.liftSuggestions(src);
  assert.equal(cards.length, 0);
  assert.equal(text, src);
});

await test('a reply cannot carry more than CARDS_MAX proposals', async () => {
  const one = fence('current: a\nproposed: b\nwhy: c');
  const { cards, dropped } = suggest.liftSuggestions(
    Array.from({ length: suggest.CARDS_MAX + 4 }, () => one).join('\n\n'));
  assert.equal(cards.length, suggest.CARDS_MAX);
  assert.equal(dropped, 4);
});

// =========================================================================
console.log('\nsuggest — finding the passage (the review engine\'s rule)');

const DOC = [
  '---',
  'title: Space balloons',
  '---',
  '',
  'A balloon in orbit is a pressure vessel',
  'that arrived folded.',
  '',
  'The reader’s own words, in “curly quotes”, as pandoc leaves them.',
  '',
  'The mass saving is the whole argument.',
  '',
  'The mass saving is the whole argument.',
  '',
].join('\n');

await test('a wrapped passage matches a single-spaced one, and lands on true offsets', async () => {
  const at = suggest.resolveSpan(DOC, 'A balloon in orbit is a pressure vessel that arrived folded.');
  assert.equal(at.ok, true);
  assert.equal(DOC.slice(at.start, at.end), 'A balloon in orbit is a pressure vessel\nthat arrived folded.',
    'the raw text is what is addressed — the newline is inside the span, not lost');
});

await test('straight quotes match the curly ones the file actually has', async () => {
  const at = suggest.resolveSpan(DOC, 'The reader\'s own words, in "curly quotes", as pandoc leaves them.');
  assert.equal(at.ok, true);
  assert.match(DOC.slice(at.start, at.end), /“curly quotes”/);
});

await test('a passage that stands in two places is AMBIGUOUS and is never guessed at', async () => {
  const at = suggest.resolveSpan(DOC, 'The mass saving is the whole argument.');
  assert.equal(at.ok, false);
  assert.equal(at.reason, 'ambiguous');
  assert.equal(at.matches, 2);
  assert.match(at.detail, /appears 2 times/);
});

await test('a passage that is not there any more is DRIFT', async () => {
  const at = suggest.resolveSpan(DOC, 'A sentence nobody ever wrote.');
  assert.equal(at.ok, false);
  assert.equal(at.reason, 'drift');
});

await test('an empty passage matches nothing at all', async () => {
  assert.equal(suggest.resolveSpan(DOC, '   ').ok, false);
});

// =========================================================================
console.log('\nsuggest — accepting one');

const scratch = (name, text) => {
  const f = path.join(tmp('file'), name);
  fs.writeFileSync(f, text);
  return f;
};

await test('accepting replaces the span and nothing else in the file', async () => {
  const f = scratch('post.md', DOC);
  const card = { id: 'a', state: 'open',
    current: 'A balloon in orbit is a pressure vessel that arrived folded.',
    proposed: 'A balloon in orbit is a pressure vessel that arrived folded flat.' };
  const r = suggest.applyCard(f, card);
  assert.equal(r.ok, true);
  const after = fs.readFileSync(f, 'utf8');
  assert.equal(after,
    DOC.replace('A balloon in orbit is a pressure vessel\nthat arrived folded.',
      'A balloon in orbit is a pressure vessel that arrived folded flat.'),
    'byte for byte: the front matter, the blank lines and every other paragraph survive');
});

await test('a cut removes the passage and leaves the rest standing', async () => {
  const f = scratch('cut.md', 'One.\n\nTwo.\n\nThree.\n');
  const r = suggest.applyCard(f, { id: 'a', state: 'open', current: 'Two.', proposed: '' });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'One.\n\n\n\nThree.\n');
});

await test('an ambiguous span is refused and the file is not touched', async () => {
  const f = scratch('amb.md', DOC);
  const r = suggest.applyCard(f, { id: 'a', state: 'open',
    current: 'The mass saving is the whole argument.', proposed: 'The mass saving is everything.' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(fs.readFileSync(f, 'utf8'), DOC, 'a refusal writes NOTHING');
});

await test('a drifted span is refused and the file is not touched', async () => {
  const f = scratch('drift.md', DOC);
  const r = suggest.applyCard(f, { id: 'a', state: 'open',
    current: 'A sentence nobody ever wrote.', proposed: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'drift');
  assert.equal(fs.readFileSync(f, 'utf8'), DOC);
});

await test('a file that is not there is a refusal, not a throw', async () => {
  const r = suggest.applyCard(path.join(OWN_ROOT, 'nope.md'),
    { id: 'a', state: 'open', current: 'x', proposed: 'y' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gone');
});

console.log('\nsuggest — accepting a whole sweep');

const SWEEP = 'Alpha one.\n\nBravo two.\n\nCharlie three.\n\nDelta four.\n';

await test('a stack applies in DOCUMENT order, whatever order it was written in', async () => {
  const f = scratch('sweep.md', SWEEP);
  const out = suggest.applyStack(f, [
    { id: 'd', state: 'open', current: 'Delta four.', proposed: 'Delta 4.' },
    { id: 'a', state: 'open', current: 'Alpha one.', proposed: 'Alpha 1.' },
    { id: 'c', state: 'open', current: 'Charlie three.', proposed: 'Charlie 3.' },
  ]);
  assert.deepEqual(out.applied, ['a', 'c', 'd']);
  assert.equal(out.stopped, null);
  assert.equal(fs.readFileSync(f, 'utf8'), 'Alpha 1.\n\nBravo two.\n\nCharlie 3.\n\nDelta 4.\n');
});

await test('…and it STOPS at the first refusal, leaving everything after it alone', async () => {
  // The real mid-sweep refusal, and the reason the run stops: card A rewrites
  // a paragraph that card B's passage was sitting inside, so B — which was
  // perfectly placeable when the sweep began — has drifted by the time its
  // turn comes. A stack whose author has lost track of the document that far
  // is not a stack to keep applying.
  const f = scratch('stop.md', 'Alpha one.\n\nBravo two, and a tail on the end.\n\nDelta four.\n');
  const out = suggest.applyStack(f, [
    { id: 'a', state: 'open', current: 'Alpha one.', proposed: 'Alpha 1.' },
    { id: 'b', state: 'open', current: 'Bravo two, and a tail on the end.', proposed: 'Bravo 2.' },
    { id: 'c', state: 'open', current: 'and a tail on the end', proposed: 'with a tail' },
    { id: 'd', state: 'open', current: 'Delta four.', proposed: 'Delta 4.' },
  ]);
  assert.deepEqual(out.applied, ['a', 'b']);
  assert.equal(out.stopped.id, 'c');
  assert.equal(out.stopped.reason, 'drift');
  assert.deepEqual(out.left, ['d'], 'and everything after it is left alone, loudly');
  assert.equal(fs.readFileSync(f, 'utf8'), 'Alpha 1.\n\nBravo 2.\n\nDelta four.\n',
    'what landed stays landed — it landed correctly');
});

await test('a card with no address at all sorts last, so a sweep is not derailed by it', async () => {
  // Drift and ambiguity discovered UP FRONT are different from drift caused
  // mid-run: a card that never had a position in the document has no place in
  // document order either, so it goes to the end rather than stopping nine
  // good changes the reader has already read and agreed to.
  const f = scratch('last.md', 'Alpha one.\n\nBravo two.\n\nBravo two.\n');
  const out = suggest.applyStack(f, [
    { id: 'x', state: 'open', current: 'A passage that left long ago.', proposed: 'y' },
    { id: 'z', state: 'open', current: 'Bravo two.', proposed: 'Bravo 2.' },
    { id: 'a', state: 'open', current: 'Alpha one.', proposed: 'Alpha 1.' },
  ]);
  assert.deepEqual(out.applied, ['a']);
  assert.ok(['x', 'z'].includes(out.stopped.id));
  assert.equal(fs.readFileSync(f, 'utf8'), 'Alpha 1.\n\nBravo two.\n\nBravo two.\n');
});

await test('an edit that moves everything after it does not break the next card', async () => {
  // the whole reason each card is re-resolved against a freshly read file
  const f = scratch('shift.md', SWEEP);
  const out = suggest.applyStack(f, [
    { id: 'a', state: 'open', current: 'Alpha one.', proposed: 'Alpha one, at very considerable length indeed.' },
    { id: 'b', state: 'open', current: 'Bravo two.', proposed: 'Bravo 2.' },
  ]);
  assert.deepEqual(out.applied, ['a', 'b']);
  assert.match(fs.readFileSync(f, 'utf8'), /Bravo 2\./);
});

console.log('\nsuggest — what the bots are told');

await test('the turn teaches the convention, and says the file does not move', async () => {
  const b = suggest.suggestBlock();
  assert.match(b, /```suggest/);
  assert.match(b, /current:/);
  assert.match(b, /proposed:/);
  assert.match(b, /EXACTLY ONCE/);
  assert.match(b, /NOTHING HAPPENS TO THE FILE UNTIL THE READER ACCEPTS/);
});

await test('and the next turn is told what became of the last stack', async () => {
  const v = suggest.verdictBlock([
    { id: 'a', state: 'applied', current: 'one' },
    { id: 'b', state: 'rejected', current: 'two' },
    { id: 'c', state: 'needs-manual', current: 'three', detail: 'it appears twice' },
    { id: 'd', state: 'open', current: 'four' },
  ]);
  assert.match(v, /ACCEPTED/);
  assert.match(v, /TURNED DOWN/);
  assert.match(v, /COULD NOT BE APPLIED/);
  assert.doesNotMatch(v, /four/, 'a card nobody has answered yet is not news');
  assert.equal(suggest.verdictBlock([{ id: 'a', state: 'open' }]), '',
    'and a stack nobody has answered says nothing at all');
});

await test('suggest mode is a property of the KIND, held in code', async () => {
  assert.equal(blog.suggestMode('jekyll'), true);
  assert.equal(blog.suggestMode('anything-else'), true, 'there is no kind that edits directly');
  assert.equal(blog.gitAllowed('jekyll'), false, 'and the git promise is untouched');
});

// =========================================================================
// The companion end. One server, one synthetic repo, the mock bridge, no git.
console.log('\ncompanion — suggest mode on a blog page');

// --- server harness ------------------------------------------------------

// The post every test below proposes changes to. Two paragraphs that are
// unique and one sentence that stands twice — the ambiguity case has to be in
// the fixture, not manufactured by a test.
const BODY = [
  '---',
  'title: "Space balloons"',
  'permalink: /balloons/',
  '---',
  '',
  'A balloon in orbit is a pressure vessel that arrived folded.',
  '',
  'The mass saving is the whole argument and it is not a small one.',
  '',
  'It was worth doing.',
  '',
  'It was worth doing.',
  '',
].join('\n');

function jekyll(tag) {
  const root = tmp(tag);
  const w = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  w('_config.yml', 'title: A Test Site\n');
  w('_posts/2026-08-29-balloons.md', BODY);
  w('_site/balloons/index.html', '<h1>Space balloons</h1>');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

{
  const root = jekyll('srv');
  const ORIGIN = 'http://localhost:4066';
  const PAGE = `${ORIGIN}/balloons/`;
  const SOURCE = path.join(root, '_posts', '2026-08-29-balloons.md');
  const reset = () => fs.writeFileSync(SOURCE, BODY);
  const source = () => fs.readFileSync(SOURCE, 'utf8');

  const workspaceRoot = tmp('srv-companion');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: { PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]), MOCK_BRIDGE_LOG: logFile },
  });

  const events = listen(base);
  await sleep(120);

  await POST(base, '/blog-site', { serve_origin: ORIGIN, root });
  await POST(base, '/blog-root', { root, confirm: true });
  await POST(base, '/page', { url: PAGE, title: 'Space balloons', site: 'localhost' });

  // The bot's reply, driven through the mock. `[mock:says:…]` may not contain
  // a `]`, so nothing in these blocks does.
  const says = lines => `[mock:says:${lines.join('\\n')}]`;
  const SG = (cur, prop, why) => ['```suggest', `current: ${cur}`, `proposed: ${prop}`, `why: ${why}`, '```'];

  // Every turn's prose is a tag nothing else uses, and the answer is waited for
  // BY that tag. Counting messages would be a race: a previous turn's reply can
  // land while this one is still in the queue, and the test would then assert
  // about somebody else's message.
  let turnN = 0;
  async function turn(blocks) {
    const tag = `note-${++turnN}`;
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__',
      text: '@claude ' + says([tag, '', ...blocks]) });
    return waitFor(async () => (await pageMsgs())
      .find(m => m.author === 'claude' && String(m.text || '').startsWith(tag)),
    `the answer to ${tag}`);
  }
  const pageMsgs = async () => ((await GET(base, '/page?url=' + enc(PAGE))).json || {}).page_chat || [];
  const cardsOf = async ts => {
    const m = (await pageMsgs()).find(x => x.ts === ts);
    return (m && m.suggestions) || [];
  };

  await test('the envelope teaches the convention and no longer says "edit it"', async () => {
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__', text: '@claude read this post' });
    const t = await waitFor(() => inputs(logFile).find(x => x.includes('read this post')), 'the turn');
    assert.match(t, /```suggest/, 'the grammar rides the turn');
    assert.match(t, /YOU DO NOT EDIT THIS FILE/);
    assert.match(t, /NOTHING HAPPENS TO THE FILE UNTIL THE READER ACCEPTS/);
    assert.match(t, /DO NOT RUN GIT IN THIS REPOSITORY/, 'and the git prohibition is untouched');
    assert.ok(t.includes(SOURCE), 'and the file is still named, because the bot has to read it');
  });

  let msg = null;
  await test('a ```suggest block becomes a card, and comes off the words', async () => {
    msg = await turn([
      ...SG('A balloon in orbit is a pressure vessel that arrived folded.',
        'A balloon in orbit is a pressure vessel that arrived folded flat.',
        'flat is the point')]);
    assert.equal((msg.suggestions || []).length, 1);
    assert.equal(msg.suggestions[0].state, 'open');
    assert.match(msg.text, /^note-\d+$/, 'the prose survives; the block does not');
    assert.doesNotMatch(msg.text, /```/);
  });

  await test('…and the turn itself changed nothing on disk', async () => {
    assert.equal(source(), BODY, 'proposing is not writing');
    const page = (await GET(base, '/page?url=' + enc(PAGE))).json;
    assert.equal((page.threads || []).filter(t => t.auto).length, 0,
      'and no collateral thread: nothing moved for a diff to find');
  });

  await test('accepting one changes the source EXACTLY, and nothing else in it', async () => {
    const id = msg.suggestions[0].id;
    const r = await POST(base, '/suggest-accept', { url: PAGE, ts: msg.ts, author: 'claude', id });
    assert.equal(r.status, 200);
    assert.equal(r.json.applied, true);
    assert.equal(r.json.card.state, 'applied');
    assert.equal(source(), BODY.replace(
      'A balloon in orbit is a pressure vessel that arrived folded.',
      'A balloon in orbit is a pressure vessel that arrived folded flat.'));
  });

  await test('…and the tab is told to reload, the way a turn\'s own edit tells it', async () => {
    const ev = await waitFor(() => events.of('blog-files').pop(), 'the change event');
    assert.equal(ev.page_changed, true);
    assert.equal(ev.source, '_posts/2026-08-29-balloons.md');
    assert.equal(ev.accepted, true, 'and it says this one was the reader\'s own press');
    assert.ok(!ev.collateral, 'nothing here was discovered by a diff');
  });

  await test('a card cannot be accepted twice', async () => {
    const r = await POST(base, '/suggest-accept',
      { url: PAGE, ts: msg.ts, author: 'claude', id: msg.suggestions[0].id });
    assert.equal(r.status, 409);
  });

  await test('rejecting one leaves the file alone and keeps the refusal on the record', async () => {
    reset();
    const m = await turn([
      ...SG('It was worth doing.', 'It was worth every penny.', 'stronger')]);
    const r = await POST(base, '/suggest-reject',
      { url: PAGE, ts: m.ts, author: 'claude', id: m.suggestions[0].id });
    assert.equal(r.status, 200);
    assert.equal(r.json.card.state, 'rejected');
    assert.equal(source(), BODY);
    assert.equal((await cardsOf(m.ts))[0].state, 'rejected', 'and it survives the round trip');
  });

  await test('an ambiguous passage goes to needs-manual, visibly, and writes nothing', async () => {
    reset();
    const m = await turn([
      ...SG('It was worth doing.', 'It was worth every penny.', 'stronger')]);
    const r = await POST(base, '/suggest-accept',
      { url: PAGE, ts: m.ts, author: 'claude', id: m.suggestions[0].id });
    assert.equal(r.status, 200, 'the request was answered; the answer is on the card');
    assert.equal(r.json.applied, false);
    assert.equal(r.json.card.state, 'needs-manual');
    assert.equal(r.json.card.reason, 'ambiguous');
    assert.match(r.json.card.detail, /appears 2 times/);
    assert.equal(source(), BODY, 'and the post is untouched');
  });

  await test('a passage that has drifted goes the same way', async () => {
    reset();
    const m = await turn([
      ...SG('A sentence that is not in this post at all.', 'x', 'stale')]);
    const r = await POST(base, '/suggest-accept',
      { url: PAGE, ts: m.ts, author: 'claude', id: m.suggestions[0].id });
    assert.equal(r.json.card.state, 'needs-manual');
    assert.equal(r.json.card.reason, 'drift');
    assert.equal(source(), BODY);
  });

  await test('a whole sweep is accepted in one press, in document order', async () => {
    reset();
    const m = await turn([
      ...SG('The mass saving is the whole argument and it is not a small one.',
        'The mass saving is the whole argument, and it is not small.', 'the double negative'),
      '',
      ...SG('A balloon in orbit is a pressure vessel that arrived folded.',
        'A balloon in orbit is a pressure vessel that arrived folded flat.', 'flat is the point')]);
    assert.equal(m.suggestions.length, 2);
    const r = await POST(base, '/suggest-accept-all', { url: PAGE, ts: m.ts, author: 'claude' });
    assert.equal(r.status, 200);
    assert.equal(r.json.applied, 2);
    assert.equal(r.json.stopped, null);
    assert.equal(source(), BODY
      .replace('A balloon in orbit is a pressure vessel that arrived folded.',
        'A balloon in orbit is a pressure vessel that arrived folded flat.')
      .replace('The mass saving is the whole argument and it is not a small one.',
        'The mass saving is the whole argument, and it is not small.'));
    assert.deepEqual((await cardsOf(m.ts)).map(c => c.state), ['applied', 'applied']);
  });

  await test('…and it stops loudly at the first one that cannot be placed', async () => {
    reset();
    const m = await turn([
      ...SG('A balloon in orbit is a pressure vessel that arrived folded.',
        'A balloon in orbit is a pressure vessel that arrived folded flat.', 'flat'),
      '',
      ...SG('It was worth doing.', 'It was worth every penny.', 'stronger'),
      '',
      ...SG('The mass saving is the whole argument and it is not a small one.',
        'The mass saving is the whole argument, and it is not small.', 'hedge')]);
    const r = await POST(base, '/suggest-accept-all', { url: PAGE, ts: m.ts, author: 'claude' });
    // the two that HAVE a place in the document are made, top to bottom; the
    // one that stands in two places has no place in document order at all, so
    // it goes last and stops the run there rather than derailing the two the
    // reader has already read and agreed to
    assert.equal(r.json.applied, 2);
    assert.equal(r.json.left, 0);
    assert.ok(r.json.stopped, 'and it names the one that stopped it');
    assert.match(r.json.stopped.detail, /appears 2 times/);
    const states = (await cardsOf(m.ts)).map(c => c.state);
    assert.deepEqual(states, ['applied', 'needs-manual', 'applied'],
      'every card says on its own face what became of it');
    assert.match(source(), /arrived folded flat/);
    assert.match(source(), /and it is not small\./);
    assert.equal(source().match(/It was worth doing\./g).length, 2,
      'and the ambiguous passage was never touched, in either of its two places');
  });

  await test('accept-all with nothing open is refused rather than answered emptily', async () => {
    const m = (await pageMsgs()).filter(x => (x.suggestions || []).length
      && !(x.suggestions || []).some(c => c.state === 'open')).pop();
    assert.ok(m, 'a stack the reader has already been all the way through');
    const r = await POST(base, '/suggest-accept-all', { url: PAGE, ts: m.ts, author: 'claude' });
    assert.equal(r.status, 409);
  });

  await test('the next turn tells the bot what the reader did', async () => {
    reset();
    const m = await turn([
      ...SG('It was worth doing.', 'It was worth every penny.', 'stronger')]);
    await POST(base, '/suggest-reject',
      { url: PAGE, ts: m.ts, author: 'claude', id: m.suggestions[0].id });
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__', text: '@claude anything else' });
    const t = await waitFor(() => inputs(logFile).find(x => x.includes('anything else')), 'the turn');
    assert.match(t, /WHAT THE READER DID WITH YOUR LAST SUGGESTIONS/);
    assert.match(t, /TURNED DOWN/);
  });

  await test('a page with no confirmed source refuses every door', async () => {
    const stray = `${ORIGIN}/not-a-post/`;
    await POST(base, '/page', { url: stray, title: 'Stray', site: 'localhost' });
    const r = await POST(base, '/suggest-accept', { url: stray, ts: 'x', id: 'y' });
    assert.ok(r.status === 404 || r.status === 409, `got ${r.status}`);
  });

  await test('a reply on an ordinary web page carries no cards at all', async () => {
    const web = 'https://example.test/an-article';
    await POST(base, '/page', { url: web, title: 'Article', site: 'example.test' });
    await POST(base, '/reply', { url: web, thread_id: '__page__',
      text: '@claude ' + says(['Sure.', '', ...SG('a', 'b', 'c')]) });
    await sleep(600);
    const msgs = ((await GET(base, '/page?url=' + enc(web))).json || {}).page_chat || [];
    const bot = msgs.filter(x => x.author === 'claude').pop();
    assert.ok(bot, 'the bot did answer');
    assert.equal(bot.suggestions, undefined,
      'the convention was never taught here and the accept path has nowhere to write');
    assert.match(bot.text, /```suggest/, 'so the block stays in the words, as prose');
  });

  events.close();
}

// Owner-only, every new door. Accepting a card WRITES A FILE on the owner's
// machine, which is the most dangerous thing in this companion, and a tunnel is
// exactly where it must not be reachable.
{
  const root = tmp('hosted');
  const PW = 'guest-pw';
  const h = await startServer({ root, args: ['--hosted', '--no-agents'],
    env: { PLUGIN_PASSWORD: PW, PLUGIN_OWNER_PASSWORD: 'owner-pw' } });
  const REMOTE = { host: 'discuss.example', authorization: `Bearer ${PW}`, 'x-plugin-handle': 'ada' };

  await test('a guest is refused at every suggestion door', async () => {
    for (const p of ['/suggest-accept', '/suggest-reject', '/suggest-accept-all']) {
      const r = await POST(h.base, p, { url: 'http://localhost:4066/balloons/' }, REMOTE);
      assert.equal(r.status, 403, `POST ${p} should be owner-only`);
    }
  });

  h.proc.kill();
  await sleep(120);
}

cleanup();
await sleep(150);

console.log(`\nsuggest: ${passed()} passed, ${failures().length} failed`);
if (failures().length) { console.log(failures().map(f => '  - ' + f).join('\n')); process.exit(1); }
