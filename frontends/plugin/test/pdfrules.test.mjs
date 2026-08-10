// pdfrules.test.mjs — the two decisions behind "a PDF opens in Discuss every
// time, not most times" (extension/pdfrules.js).
//
//   node frontends/plugin/test/pdfrules.test.mjs
//
// Both of these shipped wrong, and both were invisible to every test that
// existed because they are about WHEN a browser API is called rather than what
// the DOM looks like afterwards:
//
//   · the redirect rule was rewritten on every worker wake — churn, and the
//     write is the only moment the rule can be absent
//   · the one-shot "open it in the browser instead" allow rule was removed by a
//     setTimeout inside an MV3 worker, which Chrome retires whenever it likes.
//     The rule persists; the timer does not. That url then opened in the
//     browser's own viewer for ever.
//
// Exit code is the number of failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const R = require(path.join(here, '..', 'extension', 'pdfrules.js'));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));

const VIEWER = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pdf/viewer.html';

// ---- 1. which urls the rule is for ------------------------------------------
{
  for (const u of ['https://a.test/x.pdf', 'http://a.test/x.PDF', 'https://a.test/x.pdf?v=2',
                   'https://a.test/deep/paper.pdf#page=4']) {
    ok('a pdf url: ' + u, R.looksPdfUrl(u));
  }
  for (const u of ['https://a.test/x.pdfx', 'https://a.test/download?id=7', 'file:///a/x.pdf',
                   'chrome-extension://x/pdf/viewer.html', '']) {
    ok('not a pdf url: ' + u, !R.looksPdfUrl(u));
  }
}

// ---- 2. the redirect rule is written ONCE -----------------------------------
{
  const want = R.redirectRule(VIEWER);
  eq('a fresh store needs the rule written',
    R.pdfRulePlan([], true, want), { remove: [R.PDF_RULE_ID], add: [want] });

  // the store hands back a COPY, so the comparison has to be field-by-field
  const asStored = JSON.parse(JSON.stringify(want));
  eq('a store that already holds it is left completely alone',
    R.pdfRulePlan([asStored], true, want), null);
  eq('…even with other rules beside it',
    R.pdfRulePlan([{ id: 99, action: { type: 'allow' }, condition: {} }, asStored], true, want), null);

  // this is the case that must NOT be skipped: a rule written by a previous
  // install, pointing at an extension id that no longer exists
  const stale = JSON.parse(JSON.stringify(want));
  stale.action.redirect.regexSubstitution = 'chrome-extension://OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOL/pdf/viewer.html#raw=\\0';
  eq('a rule pointing at another extension id IS rewritten',
    R.pdfRulePlan([stale], true, want), { remove: [R.PDF_RULE_ID], add: [want] });

  const wrongFilter = JSON.parse(JSON.stringify(want));
  wrongFilter.condition.regexFilter = '^https?://.*$';
  eq('…and so is one that matches the wrong urls',
    R.pdfRulePlan([wrongFilter], true, want), { remove: [R.PDF_RULE_ID], add: [want] });

  const wrongTypes = JSON.parse(JSON.stringify(want));
  wrongTypes.condition.resourceTypes = ['main_frame', 'sub_frame'];
  eq('…or the wrong resource types',
    R.pdfRulePlan([wrongTypes], true, want), { remove: [R.PDF_RULE_ID], add: [want] });

  // the off switch
  eq('turning the feature off removes the rule', R.pdfRulePlan([asStored], false, want),
    { remove: [R.PDF_RULE_ID], add: [] });
  eq('…and turning it off twice does nothing the second time',
    R.pdfRulePlan([], false, want), null);
}

// ---- 3. the bypass is litter the moment its minute is up --------------------
{
  const NOW = 1_000_000;
  const live = { url: 'https://a.test/x.pdf', until: NOW + 1000 };
  ok('a bypass inside its minute is kept', !R.bypassExpired(live, NOW));
  ok('…and is gone the instant the deadline passes', R.bypassExpired(live, NOW + 1000));
  ok('…and after it', R.bypassExpired(live, NOW + 60000));

  // Everything unreadable counts as EXPIRED, deliberately: a bypass that goes
  // too early costs one redirect the reader can undo again, while one that
  // stays too long costs them a document that never opens in Discuss.
  for (const junk of [null, undefined, {}, { url: '' }, { url: 'x' },
                      { url: 'x', until: null }, { url: 'x', until: 'soon' },
                      { url: 'x', until: NaN }]) {
    ok('unreadable is expired: ' + JSON.stringify(junk), R.bypassExpired(junk, NOW));
  }
  // the shipped bug, stated as a test: a worker that died at NOW leaves this
  // record behind, and the NEXT worker — a different process, no timer — has
  // to be able to see that it is rubbish
  ok('a bypass whose worker died is swept by whoever runs next',
    R.bypassExpired({ url: 'https://a.test/x.pdf', until: NOW - 1 }, NOW));
}

// ---- 4. the allow rule is scoped to exactly one url -------------------------
{
  const rule = R.allowRule('https://a.test/paper (final).pdf?x=1&y=2');
  eq('the bypass is an allow at a higher priority than the redirect',
    [rule.id, rule.priority > R.redirectRule(VIEWER).priority, rule.action.type],
    [R.PDF_BYPASS_ID, true, 'allow']);
  const re = new RegExp(rule.condition.regexFilter);
  ok('it matches the url it was made for', re.test('https://a.test/paper (final).pdf?x=1&y=2'));
  ok('…and nothing else', !re.test('https://a.test/paper.pdf') &&
    !re.test('https://a.test/paper (final).pdf?x=1&y=2&z=3'));
  ok('…with every regex metacharacter in the url neutralised',
    !new RegExp(R.allowRule('https://a.test/a.b?c=.*').condition.regexFilter)
      .test('https://a.test/aXb?c=ZZZ'));
}

// ---- 5. which page a viewer tab is showing ----------------------------------
{
  const PDF = 'https://a.test/x.pdf?id=7&t=abc';
  eq('#raw= is read back verbatim', R.tabPageUrl(VIEWER + '#raw=' + PDF, VIEWER), PDF);
  eq('?src= is decoded', R.tabPageUrl(VIEWER + '?src=' + encodeURIComponent(PDF), VIEWER), PDF);
  eq('an ordinary tab is itself', R.tabPageUrl('https://example.com/a', VIEWER), 'https://example.com/a');
  eq('a viewer with nothing in it is itself', R.tabPageUrl(VIEWER, VIEWER), VIEWER);
}

// ---- report -----------------------------------------------------------------
if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' pdfrules.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
