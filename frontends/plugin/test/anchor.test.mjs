// anchor.test.mjs — unit tests for the pure matching core of
// frontends/plugin/extension/anchor.js. No framework, no DOM: every test feeds
// a raw text index (the string buildTextIndex would produce from a page) and
// checks the anchor resolves to the offsets we expect.
//
//   node frontends/plugin/test/anchor.test.mjs
//
// Exit code is the number of failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const A = require(path.join(here, '..', 'extension', 'anchor.js'));

// Section 9 imports store.mjs to pin the newWording twins against each other,
// and store.mjs resolves a workspace at import time. A throwaway root keeps
// even an accidental write out of the developer's real .botference.
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-anchor-'));

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, 'got  ' + g + '\n      want ' + w);
}
const slice = (raw, r) => raw.slice(r.start, r.end);

// A page as buildTextIndex would flatten it: '\n' at block boundaries, raw
// whitespace (indentation, line wraps, nbsp) left intact inside blocks.
const PAGE = [
  '\nThe Quiet Machine\n',
  '\nAragon opened the season with a draw. The mood in the stands\n  was flat.\n',
  '\nThe manager said the team “played within itself” — a phrase he has\nused before.\n',
  '\nThe mood in the stands was flat.\n',
  '\nBy the hour mark Aragon had found a rhythm. The mood in the stands\nwas flat only in memory.\n',
].join('');

// ---- 1. exact match -------------------------------------------------------
{
  const r = A.locate(PAGE, { quote: 'Aragon opened the season with a draw', prefix: '', suffix: '' });
  ok('exact: resolves', r.ok, JSON.stringify(r));
  ok('exact: unique flag', r.ok && r.unique === true);
  eq('exact: slices back to the quote', slice(PAGE, r), 'Aragon opened the season with a draw');
}

// ---- 2. smart quotes, dashes and whitespace runs ---------------------------
{
  // Stored with ASCII quotes, an ASCII hyphen and single spacing; the page has
  // curly quotes, an em dash and a hard line wrap in the middle.
  const anchor = { quote: 'played within itself" - a phrase he has used before', prefix: '', suffix: '' };
  const r = A.locate(PAGE, anchor);
  ok('variance: resolves through curly quotes + em dash + wrap', r.ok, JSON.stringify(r));
  ok('variance: raw slice keeps the page\'s own typography',
    r.ok && slice(PAGE, r).includes('”') && slice(PAGE, r).includes('—') && slice(PAGE, r).includes('\n'),
    JSON.stringify(slice(PAGE, r)));

  // nbsp and zero-width joiners in the page must not defeat a plain quote
  const weird = 'Prices rose 12​% in the first quarter.';
  const w = A.locate(weird, { quote: 'rose 12% in the first quarter' });
  ok('variance: nbsp + zero-width tolerated', w.ok, JSON.stringify(w));
  eq('variance: nbsp slice', slice(weird, w), 'rose 12​% in the first quarter');
}

// ---- 3. duplicate sentence disambiguated by prefix/suffix -------------------
{
  const dup = 'The mood in the stands was flat';
  eq('ambiguity: the quote really is duplicated', A.findSpans(PAGE, dup).length, 3);

  // no context at all -> refuse rather than guess
  const blind = A.locate(PAGE, { quote: dup, prefix: '', suffix: '' });
  ok('ambiguity: contextless duplicate is not resolved', !blind.ok && blind.reason === 'ambiguous', JSON.stringify(blind));

  // second occurrence: its own paragraph, preceded by the em-dash sentence
  const second = A.locate(PAGE, { quote: dup, prefix: 'used before.', suffix: '. By the hour mark' });
  ok('ambiguity: prefix+suffix pick the 2nd occurrence', second.ok, JSON.stringify(second));
  eq('ambiguity: 2nd occurrence offset', second.ok && second.start, PAGE.indexOf('\nThe mood in the stands was flat.\n') + 1);

  // third occurrence: distinguished by suffix alone
  const third = A.locate(PAGE, { quote: dup, prefix: '', suffix: 'only in memory.' });
  ok('ambiguity: suffix alone picks the 3rd occurrence', third.ok, JSON.stringify(third));
  ok('ambiguity: 3rd occurrence is the last one',
    third.ok && third.start > PAGE.indexOf('By the hour mark'), JSON.stringify(third));

  // first occurrence: distinguished by prefix alone
  const first = A.locate(PAGE, { quote: dup, prefix: 'opened the season with a draw.', suffix: '' });
  ok('ambiguity: prefix alone picks the 1st occurrence', first.ok, JSON.stringify(first));
  ok('ambiguity: 1st occurrence is in paragraph one',
    first.ok && first.start < PAGE.indexOf('The manager said'), JSON.stringify(first));
}

// ---- 4. orphan: the text is simply gone ------------------------------------
{
  const r = A.locate(PAGE, { quote: 'Aragon were relegated in April', prefix: 'x', suffix: 'y' });
  ok('orphan: reports failure', !r.ok, JSON.stringify(r));
  eq('orphan: reason', r.reason, 'orphan');

  const empty = A.locate(PAGE, { quote: '   ', prefix: '', suffix: '' });
  ok('orphan: blank quote never matches', !empty.ok && empty.reason === 'orphan');
}

// ---- 5. quote spanning an inline element boundary ---------------------------
{
  // <p>The report called it a <em>structural</em> failure of oversight.</p>
  // buildTextIndex concatenates the three text nodes with no separator (inline),
  // so the raw string a real page yields is exactly this:
  const inline = '\nThe report called it a ' + 'structural' + ' failure of oversight.\n';
  const r = A.locate(inline, { quote: 'a structural failure', prefix: 'report called it', suffix: 'of oversight.' });
  ok('inline: quote crossing <em> boundaries resolves', r.ok, JSON.stringify(r));
  eq('inline: slice', slice(inline, r), 'a structural failure');

  // and with a block boundary in between the quote must NOT match across it
  // as if it were a plain space-free join
  const blocks = '\nend of one\n\nstart of two\n';
  const across = A.locate(blocks, { quote: 'end of one start of two' });
  ok('inline: block boundary collapses to a space (still matchable)', across.ok, JSON.stringify(across));
  const glued = A.locate(blocks, { quote: 'onestart' });
  ok('inline: blocks are not glued together', !glued.ok, JSON.stringify(glued));
}

// ---- 6. buildAnchor round-trips through locate ------------------------------
{
  const start = PAGE.indexOf('found a rhythm');
  const end = start + 'found a rhythm'.length;
  const a = A.buildAnchor(PAGE, start, end);
  eq('buildAnchor: quote is whitespace-collapsed', a.quote, 'found a rhythm');
  ok('buildAnchor: prefix ≤32 chars', a.prefix.length <= 32, JSON.stringify(a.prefix));
  ok('buildAnchor: suffix ≤32 chars', a.suffix.length <= 32, JSON.stringify(a.suffix));
  ok('buildAnchor: prefix is the text before', a.prefix.endsWith('By the hour mark Aragon had'), JSON.stringify(a.prefix));
  const back = A.locate(PAGE, a);
  ok('buildAnchor: round-trips', back.ok && back.start === start && back.end === end,
    JSON.stringify({ a, back, start, end }));

  // round-trip a duplicated sentence too — buildAnchor must capture enough
  // context for locate to pick the same occurrence back out
  const dupStart = PAGE.lastIndexOf('The mood in the stands');
  const dupEnd = dupStart + 'The mood in the stands'.length;
  const da = A.buildAnchor(PAGE, dupStart, dupEnd);
  const dback = A.locate(PAGE, da);
  ok('buildAnchor: duplicated quote round-trips to the same occurrence',
    dback.ok && dback.start === dupStart, JSON.stringify({ da, dback, dupStart }));
}

// ---- 7. normIndex / findSpans primitives ------------------------------------
{
  const { norm, map } = A.normIndex('a  b\n c');
  eq('normIndex: collapses runs', norm, 'a b c');
  eq('normIndex: maps back to raw offsets', map, [0, 1, 3, 4, 6]);
  eq('normalize: trims and folds', A.normalize('  “hi”  —  there  '), '"hi" - there');
  eq('findSpans: limit respected', A.findSpans(PAGE, 'The mood in the stands was flat', 2).length, 2);
  eq('tailOverlap', A.tailOverlap('the quick fox', 'a quick fox'), 10);
  eq('headOverlap', A.headOverlap('fox jumped', 'fox jumps'), 8);
}
// ---- "this passage now reads: …", and finding the wording it names ----------
// The parse that lets a rewritten passage be found again. It lives here rather
// than in the drawer because the same sentence does two jobs — it draws the
// card's before→after AND it moves the highlight onto the new wording — and
// two copies of the rule could drift into a card that shows a change the page
// does not.
{
  const t = msgs => ({ id: 't1', quote: 'the old wording', msgs });
  const NEW = 'the walk back was quiet, and unhurried';
  ok('a bot quoting the new wording back is read',
    A.newWording(t([{ author: 'claude', ts: '1', text: 'Done — this passage now reads: "' + NEW + '"' }])) === NEW);
  ok('…in curly quotes too, which is what an agent actually types',
    A.newWording(t([{ author: 'codex', ts: '1', text: 'it now reads: “' + NEW + '”' }])) === NEW);
  ok('…"reads now", "now says" and "new wording is" all count',
    A.newWording(t([{ author: 'claude', ts: '1', text: 'reads now: "abcd"' }])) === 'abcd'
    && A.newWording(t([{ author: 'claude', ts: '1', text: 'now says "abcd"' }])) === 'abcd'
    && A.newWording(t([{ author: 'claude', ts: '1', text: 'new wording is "abcd"' }])) === 'abcd');
  ok('the LAST bot word on it wins — an agent may correct itself',
    A.newWording(t([
      { author: 'claude', ts: '1', text: 'now reads: "first try"' },
      { author: 'claude', ts: '2', text: 'now reads: "second try"' },
    ])) === 'second try');
  ok('a READER cannot move an anchor by typing the sentence',
    A.newWording(t([{ author: 'angadh', ts: '1', text: 'it now reads: "whatever I like"' }])) === '');
  ok('…nor can a bot NARRATING its tools',
    A.newWording(t([{ author: 'claude', ts: '1', kind: 'tools', text: 'now reads: "x y z"' }])) === '');
  ok('a bot quoting the reader back at themselves claims nothing',
    A.newWording(t([{ author: 'claude', ts: '1',
      text: 'you asked whether "structural failure of oversight" is a quote. It is a paraphrase.' }])) === '');
  ok('a reply that says nothing about the wording says nothing',
    A.newWording(t([{ author: 'claude', ts: '1', text: 'Fixed the units, nothing else changed.' }])) === '');
  ok('no messages, no claim', A.newWording({ msgs: [] }) === '' && A.newWording(null) === '');

  // …and the wording it names is located exactly as any other quote is: the
  // OLD context still applies, because a rewrite replaces the passage and not
  // the paragraph around it
  const raw = 'They drew on Saturday. ' + NEW + '. Nobody sang on the way home.';
  const hit = A.locate(raw, { quote: NEW, prefix: 'They drew on Saturday.', suffix: 'Nobody sang' });
  ok('the new wording locates against the old context', hit.ok && hit.unique
    && raw.slice(hit.start, hit.end) === NEW);
  ok('…and a wording that is not on the page locates nowhere, which leaves the '
    + 'thread orphaned exactly as it was',
    A.locate(raw, { quote: 'a sentence nobody wrote' }).ok === false);
  const twice = NEW + '. ' + NEW + '.';
  const amb = A.locate(twice, { quote: NEW, prefix: '', suffix: '' });
  ok('a wording that appears twice with nothing to tell them apart is ambiguous',
    amb.ok === false && amb.reason === 'ambiguous');

  ok('the cap is a prose span, not a page', A.WAS_MAX === 600);
}

// ---- 9. the twins agree — anchor.js vs store.mjs ----------------------------
// Both files carry this rule and both carry a comment telling the next reader
// to keep them in step. For most of a year that comment was the only thing
// holding them together, and it did not: the companion learned three extra
// phrasings ("rewrote it to:", "changed it to:", "updated to:") and the browser
// did not, so a bot using one of them produced a re-anchor the companion would
// happily authorize and the page never offered. The thread orphaned instead of
// following the rewrite, silently, and no test anywhere could see it — each
// file's copy was tested only against itself.
//
// This is the "▸ more" treatment: the regex source pinned character for
// character, and then the two implementations run over the same table of
// messages and required to answer the same. The extension cannot import from
// store.mjs, so the duplication stays — what changes is that drift now fails a
// test instead of quietly costing a feature.
{
  const Store = await import(path.join(here, '..', 'store.mjs'));

  ok('the regex is the same rule in both files, character for character',
    A.NEW_WORDING_RE.source === Store.NEW_WORDING_RE.source,
    'anchor.js  ' + A.NEW_WORDING_RE.source + '\n      store.mjs  ' + Store.NEW_WORDING_RE.source
    + '\n      they have drifted — bring the copies together, do not fix the test');
  ok('…and the same flags', A.NEW_WORDING_RE.flags === Store.NEW_WORDING_RE.flags);

  // The seven phrasings the rule accepts, the ones it must not, and the author
  // and kind gates around it. Every row is asserted against BOTH copies.
  const W = 'the walk back was quiet, and unhurried';
  const rows = [
    ['now reads', [{ author: 'claude', ts: '1', text: 'Done — this passage now reads: "' + W + '"' }], W],
    ['reads now', [{ author: 'claude', ts: '1', text: 'reads now: "' + W + '"' }], W],
    ['now says', [{ author: 'codex', ts: '1', text: 'now says "' + W + '"' }], W],
    ['new wording is', [{ author: 'claude', ts: '1', text: 'new wording is "' + W + '"' }], W],
    // the three the browser used to miss — this is the bug, pinned
    ['rewrote it to', [{ author: 'claude', ts: '1', text: 'rewrote it to: "' + W + '"' }], W],
    ['reworded that line as', [{ author: 'codex', ts: '1', text: 'reworded that line as — "' + W + '"' }], W],
    ['changed it to', [{ author: 'claude', ts: '1', text: 'changed it to: "' + W + '"' }], W],
    ['updated to', [{ author: 'claude', ts: '1', text: 'updated to: "' + W + '"' }], W],
    ['rewritten', [{ author: 'claude', ts: '1', text: 'rewritten, and it is now: “' + W + '”' }], W],
    ['the last bot word wins', [
      { author: 'claude', ts: '1', text: 'now reads: "first try"' },
      { author: 'codex', ts: '2', text: 'rewrote it to: "second try"' },
    ], 'second try'],
    ['a reader claims nothing', [{ author: 'angadh', ts: '1', text: 'it now reads: "whatever I like"' }], ''],
    ['a tools line claims nothing', [{ author: 'claude', ts: '1', kind: 'tools', text: 'now reads: "x y z"' }], ''],
    ['"claudette" is not a bot', [{ author: 'claudette', ts: '1', text: 'now reads: "not hers to say"' }], ''],
    ['a quote about a quote claims nothing', [{ author: 'claude', ts: '1',
      text: 'you asked whether "structural failure of oversight" is a quote. It is a paraphrase.' }], ''],
    ['a reply about nothing else', [{ author: 'claude', ts: '1', text: 'Fixed the units.' }], ''],
    ['no messages', [], ''],
  ];
  for (const [label, msgs, want] of rows) {
    const a = A.newWording({ id: 't1', msgs });
    const s = Store.newWording({ id: 't1', msgs });
    ok('twins: ' + label + ' — anchor.js', a === want, 'got ' + JSON.stringify(a));
    ok('twins: ' + label + ' — store.mjs', s === want, 'got ' + JSON.stringify(s));
  }
  ok('twins: neither reads a null thread',
    A.newWording(null) === '' && Store.newWording(null) === '');
}

// ---- report -----------------------------------------------------------------
if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' anchor.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
