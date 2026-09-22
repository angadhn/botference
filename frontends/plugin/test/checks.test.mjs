#!/usr/bin/env node
// checks — the claim checker, and the two records that carry its answer.
//
// See SPEC.md "adversarial review — checks, not second opinions" and checks.mjs.
// Everything here is the MODULE plus store.appendMsg's field: pure text in,
// stamps out, no server, no bridge, no browser. (companion.test.mjs owns the
// end-to-end: a bot reply landing through the bridge with checks on it.)
//
//   node frontends/plugin/test/checks.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmps = [];
const tmp = name => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bfp-checks-${name}-`)));
  tmps.push(d);
  return d;
};
const ROOT = tmp('root');
process.env.BOTFERENCE_PROJECT_ROOT = ROOT;
process.env.BOTFERENCE_HOME = ROOT;

const C = await import('../checks.mjs');
const store = await import('../store.mjs');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

const PAGE = 'The inflatable-arm literature has grown quickly since 2019, and the '
  + 'deployment loads it reports are consistently lower than the analytic bound.';

// ---- normalisation ---------------------------------------------------------

test('normalize folds the typography a quote is retyped with', () => {
  assert.equal(C.normalize('It’s “fine” — really'), 'it\'s "fine" - really');
});

test('normalize drops invisibles and collapses whitespace', () => {
  assert.equal(C.normalize('  a​b \n\t c '), 'ab c');
});

test('a curly-quoted page and a straight-quoted reply are the same words', () => {
  const page = 'the deployment’s bound — as measured in the ‘2019’ set';
  const out = C.checkReply("it says \u201cthe deployment's bound - as measured in the '2019' set\u201d", { pageText: page });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true);
});

// ---- which quotes are claims ----------------------------------------------

test('a quote of six words or more is a claim', () => {
  assert.equal(C.quotesIn('he writes “one two three four five six”').length, 1);
});

test('five words is ordinary English and is not checked', () => {
  assert.equal(C.quotesIn('he writes “one two three four five”').length, 0);
  assert.deepEqual(C.checkReply('he writes “one two three four five”', { pageText: PAGE }), []);
});

test('a quote inside a fenced block is code, not a claim', () => {
  const reply = 'like so:\n```\nprint("one two three four five six seven")\n```\ndone';
  assert.deepEqual(C.quotesIn(reply), []);
});

test('an inline code span is not a claim either', () => {
  assert.deepEqual(C.quotesIn('the constant `"one two three four five six seven"` is set'), []);
});

test('the same quote twice is one claim', () => {
  const reply = '“the deployment loads it reports are consistently lower” — again, '
    + '“the deployment loads it reports are consistently lower”.';
  assert.equal(C.quotesIn(reply).length, 1);
});

test('a pasted block past QUOTE_MAX is not a sentence-level claim', () => {
  const big = 'word '.repeat(200).trim();
  assert.deepEqual(C.quotesIn(`“${big}”`), []);
});

// ---- found / not found -----------------------------------------------------

test('a quote that is in the page is stamped found', () => {
  const out = C.checkReply('The page says “the deployment loads it reports are consistently lower”.',
    { pageText: PAGE });
  assert.deepEqual(out, [{
    kind: 'quote', ok: true, detail: 'quote found',
    quote: 'the deployment loads it reports are consistently lower',
  }]);
});

test('a quote that is NOT in the page is stamped not found', () => {
  const out = C.checkReply('The page says “the deployment loads are higher than the bound”.',
    { pageText: PAGE });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].detail, 'not found in the page');
});

test('no page text means the quote is not checkable, not failed', () => {
  assert.deepEqual(C.checkReply('“the deployment loads are higher than the bound”', {}), []);
});

test('case is not what a misquote is', () => {
  const out = C.checkReply('“THE DEPLOYMENT LOADS IT REPORTS ARE CONSISTENTLY LOWER”', { pageText: PAGE });
  assert.equal(out[0].ok, true);
});

test('at most CHECKS_MAX stamps ride one reply', () => {
  const words = i => `alpha${i} bravo charlie delta echo foxtrot golf`;
  const text = Array.from({ length: 20 }, (_, i) => `“${words(i)}”`).join(' and ');
  assert.equal(C.checkReply(text, { pageText: 'nothing' }).length, C.CHECKS_MAX);
});

// ---- "now reads" -----------------------------------------------------------

const FILE = '<html><body><p>The scope <em>now</em> covers stowed configurations too.</p></body></html>';

test('plainText reads a wording that markup runs through the middle of', () => {
  assert.ok(C.plainText(FILE).includes('The scope now covers stowed configurations too.'));
});

test('a now-reads line is checked against the FILE and found', () => {
  const out = C.checkReply('done — this passage now reads: “The scope now covers stowed configurations too.”',
    { pageText: PAGE, fileText: C.plainText(FILE) });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'now-reads');
  assert.equal(out[0].ok, true);
  assert.equal(out[0].detail, 'the new wording is in the file');
});

test('a now-reads line the file does not bear out is flagged', () => {
  const out = C.checkReply('done — this passage now reads: “The scope excludes stowed configurations.”',
    { fileText: C.plainText(FILE) });
  assert.equal(out[0].ok, false);
  assert.equal(out[0].detail, 'the new wording is not in the file');
});

test('rule 5b lines are checked too', () => {
  const out = C.checkReply('also changed — this passage now reads: “The scope now covers stowed configurations too.”',
    { fileText: C.plainText(FILE) });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true);
});

test('with no file the new wording is not re-checked as a page quote', () => {
  // the page never contained it and never should have: it is what the bot
  // just WROTE, so a "not found in the page" stamp would be a false alarm
  const out = C.checkReply('done — this passage now reads: “The scope now covers stowed configurations too.”',
    { pageText: PAGE });
  assert.deepEqual(out, []);
});

// ---- page-number claims ----------------------------------------------------

const pageTextOf = n => (n === 12 ? PAGE : n === 4 ? 'something else entirely, over here on page four' : '');

test('a page number before the quote governs it', () => {
  assert.deepEqual(C.quotesIn('on page 12 it says “one two three four five six”'),
    [{ quote: 'one two three four five six', page: 12 }]);
  assert.equal(C.quotesIn('see p. 7, “one two three four five six”')[0].page, 7);
  assert.equal(C.quotesIn('see pp. 9 — “one two three four five six”')[0].page, 9);
});

test('a page number AFTER the quote governs nothing', () => {
  assert.equal(C.quotesIn('“one two three four five six” appears on page 12')[0].page, 0);
});

test('a page claim is checked against that page alone', () => {
  const out = C.checkReply('on page 12: “the deployment loads it reports are consistently lower”',
    { pageText: PAGE, pageTextOf });
  assert.equal(out[0].kind, 'page');
  assert.equal(out[0].ok, true);
  assert.equal(out[0].detail, 'quote found on page 12');
});

test('a passage that is really on page 4 does not make a page-12 claim true', () => {
  const out = C.checkReply('on page 12: “something else entirely, over here on page four”',
    { pageText: PAGE, pageTextOf });
  assert.equal(out[0].ok, false);
  assert.equal(out[0].detail, 'not found on page 12');
});

test('a page whose text the viewer never stored is skipped, not failed', () => {
  assert.deepEqual(C.checkReply('on page 99: “one two three four five six”',
    { pageText: PAGE, pageTextOf }), []);
});

// ---- the stamp -------------------------------------------------------------

test('no checks, no stamp', () => {
  assert.equal(C.stampOf([]), null);
  assert.equal(C.stampOf(null), null);
});

test('all passing reads as checked, in the done voice', () => {
  const s = C.stampOf(C.checkReply('“the deployment loads it reports are consistently lower”',
    { pageText: PAGE }));
  assert.equal(s.ok, true);
  assert.equal(s.label, 'quote checked');
});

test('one failure names what failed and carries the quote in the tooltip', () => {
  const s = C.stampOf(C.checkReply('“the deployment loads are higher than the bound”',
    { pageText: PAGE }));
  assert.equal(s.ok, false);
  assert.equal(s.label, 'quote not found in the page');
  assert.ok(s.title.includes('the deployment loads are higher than the bound'));
});

test('a failure among passes still fails the stamp', () => {
  const s = C.stampOf([
    { kind: 'quote', ok: true, detail: 'quote found', quote: 'a' },
    { kind: 'quote', ok: false, detail: 'not found in the page', quote: 'b' },
  ]);
  assert.equal(s.ok, false);
});

// ---- the record ------------------------------------------------------------

test('appendMsg stores the checks it is given', () => {
  const page = store.upsertPage({ url: 'https://ex.test/checks-a', title: 'A' });
  store.appendMsg(page, store.PAGE_CHAT, {
    author: 'claude', text: 'hi',
    checks: [{ kind: 'quote', ok: false, detail: 'not found in the page', quote: 'x' }],
  });
  const m = page.page_chat[page.page_chat.length - 1];
  assert.deepEqual(m.checks, [{ kind: 'quote', ok: false, detail: 'not found in the page', quote: 'x' }]);
});

test('an empty list is no field at all — a pass and a skip must not look alike', () => {
  const page = store.upsertPage({ url: 'https://ex.test/checks-b', title: 'B' });
  store.appendMsg(page, store.PAGE_CHAT, { author: 'claude', text: 'hi', checks: [] });
  assert.equal('checks' in page.page_chat[page.page_chat.length - 1], false);
});

test('a record cannot smuggle a field or a truthy "false" past sanitizeCheck', () => {
  assert.equal(store.sanitizeCheck({ kind: 'nope', ok: true, detail: 'x' }), null);
  assert.equal(store.sanitizeCheck({ kind: 'quote', ok: true, detail: '' }), null);
  const c = store.sanitizeCheck({ kind: 'quote', ok: 'false', detail: 'd', quote: 'q', evil: 1, page: 3 });
  assert.deepEqual(c, { kind: 'quote', ok: true, detail: 'd', quote: 'q', page: 3 });
});

for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
console.log(`\n✓ checks.test.mjs — ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => `  · ${f}`).join('\n')); process.exit(1); }


test('a quotation attributed to a person or another document is not checked against the page', () => {
  const q = C.quotesIn('You asked: "can we drop the second paragraph entirely from this section" — the page itself says "the mood in the stands was flat and the walk back".');
  assert.deepEqual(q.map(x => x.quote), ['the mood in the stands was flat and the walk back']);
  assert.equal(C.quotesIn('Codex said "this is a purely software upgrade of existing machines here" earlier.').length, 0);
  assert.equal(C.quotesIn('The attached paper says "returns to scale vanish once the fixed costs are sunk" on p. 3.').length, 0);
  assert.equal(C.quotesIn('The report "called it a structural failure of oversight which is the kind" of sentence…').length, 1, 'an unattributed quote is still a page claim');
});
