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
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const A = require(path.join(here, '..', 'extension', 'anchor.js'));

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

// ---- report -----------------------------------------------------------------
if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' anchor.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
