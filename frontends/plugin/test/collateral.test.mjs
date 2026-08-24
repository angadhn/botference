// collateral.test.mjs — the edits nobody commented on.
//
//   node frontends/plugin/test/collateral.test.mjs
//
// The whole of the backstop's correctness outside the browser lives here,
// because collateral.mjs is pure: html in, threads out. Four things are being
// pinned, and they are the four ways this feature could hurt rather than help:
//
//   1. the TEXT the diff runs over is the text the PAGE carries — blocks split
//      where the browser splits them, inline tags folded away, entities
//      decoded. A quote synthesized from anything else anchors to nothing;
//   2. GRANULARITY — a changed sentence costs a sentence-sized region, not the
//      paragraph and not the file; adjacent changed blocks are one region and
//      blocks with untouched prose between them are never merged;
//   3. DEDUPE — a change the bot narrated into the thread it was answering must
//      not also spawn a thread here, and (the case that is easy to get wrong)
//      a SECOND change to a passage an auto-thread already covers must;
//   4. the CAP — a turn that rewrote the document gets one note, not forty.
//
// Exit code is the number of failures.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store.mjs (imported by collateral.mjs for newWording/isAgentAuthor) resolves
// a workspace at import time; a throwaway keeps even an accidental write out of
// the live .botference
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-coll-'));

const C = await import('../collateral.mjs');
const store = await import('../store.mjs');

let pass = 0, fail = 0;
const check = (what, cond) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${what}`);
};
const eq = (what, got, want) => {
  if (got === want) { pass++; return; }
  fail++;
  console.log(`  ✗ ${what}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};

const doc = (...paras) => `<!doctype html><html><head><style>p{color:red}</style></head>`
  + `<body><article>${paras.map(p => `<p>${p}</p>`).join('\n')}</article>`
  + `<script>console.log(1)</script></body></html>`;

// ---- 1. the document as the page reads it --------------------------------
console.log('\ndocBlocks — the text the page carries');
{
  const b = C.docBlocks(doc('One <em>two</em> three.', 'Four&nbsp;five &amp; six.'));
  eq('one block per paragraph', b.length, 2);
  eq('inline tags fold away', b[0], 'One two three.');
  eq('entities decode', b[1], 'Four five & six.');
  check('script and style are not text', !b.join(' ').includes('console.log'));

  const nested = C.docBlocks('<div><p>Alpha</p><ul><li>Beta</li><li>Gamma</li></ul></div>');
  eq('list items are their own blocks', nested.join('|'), 'Alpha|Beta|Gamma');
  eq('a <br> ends a block too', C.docBlocks('<p>Alpha<br>Beta</p>').join('|'), 'Alpha|Beta');
  eq('whitespace folds', C.docBlocks('<p>  Alpha\n   Beta  </p>')[0], 'Alpha Beta');
  eq('nothing at all is no blocks', C.docBlocks('').length, 0);
}

// ---- 2. granularity ------------------------------------------------------
console.log('\nregions — how big a change is');
{
  const before = doc('Head stays.', 'The mood in the stands was flat, and the walk back was quiet.', 'Tail stays.');
  const after = doc('Head stays.', 'The mood in the stands was jubilant, and the walk back was loud.', 'Tail stays.');
  const { regions, extensive } = C.regionsFrom(before, after);
  eq('one changed paragraph is one region', regions.length, 1);
  check('and not extensive', !extensive);
  const r = regions[0];
  eq('the region is the words that moved, not the paragraph',
    r.quote, 'jubilant, and the walk back was loud.');
  eq('…with the wording it replaced', r.old, 'flat, and the walk back was quiet.');
  check('the shared head became context', r.prefix.endsWith('The mood in the stands was'));
  check('the region is a real substring of the new document',
    C.docBlocks(after).join(' ').includes(r.quote));
  check('the OLD wording is a real substring of the old document',
    C.docBlocks(before).join(' ').includes(r.old));
}
{
  // adjacent changed paragraphs are ONE change in one place
  const before = doc('Head.', 'Alpha one.', 'Beta two.', 'Tail.');
  const after = doc('Head.', 'Alpha changed.', 'Beta changed.', 'Tail.');
  const { regions } = C.regionsFrom(before, after);
  eq('two adjacent changed blocks merge into one region', regions.length, 1);
  check('…and the quote spans both', regions[0].quote.includes('Alpha changed.')
    && regions[0].quote.includes('Beta changed.'));
}
{
  // …but never across prose nobody touched
  const before = doc('Head.', 'Alpha one.', 'Untouched middle.', 'Beta two.', 'Tail.');
  const after = doc('Head.', 'Alpha changed.', 'Untouched middle.', 'Beta changed.', 'Tail.');
  const { regions } = C.regionsFrom(before, after);
  eq('an untouched block between them keeps them apart', regions.length, 2);
  check('and neither quote swallows the untouched prose',
    !regions[0].quote.includes('Untouched') && !regions[1].quote.includes('Untouched'));
}
{
  const before = doc('Head.', 'Tail.');
  const after = doc('Head.', 'A whole new paragraph arrived here.', 'Tail.');
  const { regions } = C.regionsFrom(before, after);
  eq('an insertion is one region', regions.length, 1);
  eq('…of kind insert', regions[0].kind, 'insert');
  eq('…with nothing struck through, because nothing left', regions[0].old, '');
  eq('…anchored on the new text', regions[0].quote, 'A whole new paragraph arrived here.');
}
{
  const before = doc('Head paragraph here.', 'This paragraph is about to go.', 'Tail paragraph here.');
  const after = doc('Head paragraph here.', 'Tail paragraph here.');
  const { regions } = C.regionsFrom(before, after);
  eq('a deletion is one region', regions.length, 1);
  eq('…of kind delete', regions[0].kind, 'delete');
  eq('…anchored to the paragraph that outlived it', regions[0].quote, 'Tail paragraph here.');
  eq('…carrying the wording that left', regions[0].old, 'This paragraph is about to go.');
}
{
  // a sentence deleted from INSIDE a paragraph: there is no shorter thing on
  // the page to point at, so the pair is kept whole
  const before = doc('Head.', 'Alpha stands. Beta goes away now. Gamma stands.', 'Tail.');
  const after = doc('Head.', 'Alpha stands. Gamma stands.', 'Tail.');
  const { regions } = C.regionsFrom(before, after);
  eq('an inner deletion is one region', regions.length, 1);
  eq('…anchored on the whole surviving paragraph', regions[0].quote, 'Alpha stands. Gamma stands.');
  check('…with the whole original as the struck half', regions[0].old.includes('Beta goes away now.'));
}
{
  const same = doc('Head.', 'Body.', 'Tail.');
  eq('a turn that changed nothing has no regions', C.regionsFrom(same, same).regions.length, 0);
}
{
  // a two-word change is grown back out: "loud" on its own anchors to anything
  const before = doc('Head paragraph one.', 'The walk back to the tram stop was quiet.', 'Tail paragraph one.');
  const after = doc('Head paragraph one.', 'The walk back to the tram stop was loud.', 'Tail paragraph one.');
  const r = C.regionsFrom(before, after).regions[0];
  check('a tiny change is grown out to an anchorable length', r.quote.length >= C.MIN_QUOTE);
  check('…and is still real text on the page', C.docBlocks(after).join(' ').includes(r.quote));
}
{
  // a very long region is clipped at a word boundary — still an exact
  // substring, so it still locates
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const r = C.regionsFrom(doc('Head.', 'short.', 'Tail.'), doc('Head.', long, 'Tail.')).regions[0];
  check('an oversized region is clipped', r.quote.length <= C.QUOTE_MAX);
  check('…at a word boundary, so it is still exact', C.docBlocks(doc('Head.', long, 'Tail.')).join(' ').includes(r.quote));
}

// ---- 3. dedupe -----------------------------------------------------------
console.log('\ndedupe — what a thread already covers');
const before3 = doc('Head paragraph stays.', 'The report called it a structural failure of oversight.', 'Tail stays.');
const after3 = doc('Head paragraph stays.', 'The report called it a failure of oversight by the board.', 'Tail stays.');
{
  // the narrated case: a bot answered a comment on that passage and said what
  // it now reads. content.js will re-anchor that thread; a second thread here
  // would be two cards and two highlights for one change.
  const page = { threads: [{
    id: 't1',
    quote: 'The report called it a structural failure of oversight.',
    addressed: true,
    msgs: [
      { author: 'angadh', ts: '2026-08-19T10:00:00.000Z', text: '@claude is "structural" fair?' },
      { author: 'claude', ts: '2026-08-19T10:01:00.000Z',
        text: 'Overstated. done — this passage now reads: "The report called it a failure of oversight by the board."' },
    ],
  }] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z', who: '@claude' });
  eq('a narrated rewrite spawns nothing', plan.threads.length, 0);
  eq('…and is reported as skipped, against the thread that covered it',
    plan.skipped.length && plan.skipped[0].thread_id, 't1');
}
{
  // the same edit, NOT narrated: the reader's own thread sits on the wording
  // that just left and a bot answered it this turn. The change belongs to that
  // thread — and is HEALED into it rather than merely skipped (§5 below).
  const page = { threads: [{
    id: 't1',
    quote: 'The report called it a structural failure of oversight.',
    addressed: true,
    msgs: [{ author: 'claude', ts: '2026-08-19T10:01:00.000Z', text: 'Fixed it.' }],
  }] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z' });
  eq('an answered thread on the old wording spawns no second thread', plan.threads.length, 0);
  eq('…the change is routed into it instead', plan.heals.length, 1);
  eq('…named by id', plan.heals[0].thread_id, 't1');
}
{
  // …and the case that must NOT be suppressed: an auto-thread from an earlier
  // turn carries the OLD wording as its quote, and the passage has moved again
  const page = { threads: [{
    id: 'auto1', auto: true, addressed: true,
    quote: 'The report called it a structural failure of oversight.',
    prior_quote: 'The report called it an oversight.',
    msgs: [{ author: 'claude', ts: '2026-08-19T09:00:00.000Z', text: '✎ @claude changed this passage.' }],
  }] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z' });
  eq('a SECOND change to a passage an auto-thread covers is still reported', plan.threads.length, 1);
  check('…carrying the wording that has just left',
    plan.threads[0].prior_quote.includes('structural failure of oversight'));
}
{
  // a thread already anchored exactly where the change landed
  const page = { threads: [{
    id: 't9', quote: 'The report called it a failure of oversight by the board.',
    msgs: [{ author: 'angadh', ts: '2026-08-19T10:00:00.000Z', text: 'noted' }],
  }] };
  eq('an existing anchor on the NEW wording covers it',
    C.collateral(before3, after3, page, {}).threads.length, 0);
}
{
  eq('and with no threads at all the change is reported',
    C.collateral(before3, after3, { threads: [] }, {}).threads.length, 1);
}

// ---- 4. the bot's own reason --------------------------------------------
console.log('\nthe bot\'s line — "also changed"');
{
  const page = { threads: [{
    id: 't1', quote: 'somewhere else entirely', addressed: true,
    msgs: [{ author: 'claude', ts: '2026-08-19T10:01:00.000Z',
      text: 'done — this passage now reads: "somewhere else entirely"\n'
        + 'also changed — the report sentence, which cited the wording I just fixed — '
        + 'this passage now reads: "The report called it a failure of oversight by the board."' }],
  }] };
  const claims = C.claimsSince(page, '2026-08-19T09:59:00.000Z');
  eq('the collateral claim is parsed', claims.length, 1);
  eq('…and it is the SECOND quote in the message, not the rule-5 one',
    claims[0].wording, 'The report called it a failure of oversight by the board.');
  eq('…while store.newWording still reads the rule-5 line, first in the message',
    store.newWording(page.threads[0]), 'somewhere else entirely');

  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z', who: '@claude' });
  eq('the region still gets its own thread', plan.threads.length, 1);
  check('…and the thread says why, in the bot\'s own words',
    plan.threads[0].text.includes('cited the wording I just fixed'));
}
{
  const bare = { threads: [], page_chat: [] };
  const plan = C.collateral(before3, after3, bare, { who: '@claude' });
  check('with no claim the thread carries the standing explanation',
    plan.threads[0].text.startsWith('✎ @claude changed this passage'));
  check('…and never the phrase rule 5 owns, which would set it re-anchoring itself',
    !/now reads/i.test(plan.threads[0].text));
}
{
  const page = { threads: [], page_chat: [{ author: 'claude', ts: '2026-08-19T10:01:00.000Z',
    text: 'also changed — this passage now reads: "a wording that is nowhere in the file"' }] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z' });
  eq('a claim the diff cannot confirm creates nothing on its own', plan.threads.length, 1);
  check('…and does not attach itself to an unrelated region',
    !plan.threads[0].text.includes('nowhere in the file'));
}
{
  const page = { threads: [], page_chat: [{ author: 'angadh', ts: '2026-08-19T10:01:00.000Z',
    text: 'also changed — this passage now reads: "a reader typing the sentence"' }] };
  eq('a HUMAN typing the sentence claims nothing', C.claimsSince(page, '2026-08-19T09:00:00.000Z').length, 0);
}
{
  const page = { threads: [], page_chat: [{ author: 'claude', ts: '2026-08-19T08:00:00.000Z',
    text: 'also changed — this passage now reads: "a claim from a turn that ended long ago"' }] };
  eq('a claim from BEFORE this turn is not this turn\'s',
    C.claimsSince(page, '2026-08-19T09:59:00.000Z').length, 0);
}

// ---- 5. the cap ----------------------------------------------------------
console.log('\nthe cap — a turn that rewrote the draft');
{
  const paras = n => Array.from({ length: 24 }, (_, i) =>
    (i % 2 === 1 && i / 2 < n ? `Paragraph number ${i} as it was rewritten this turn.`
      : `Paragraph number ${i} exactly as the reader left it, untouched.`));
  const before = doc(...paras(0));
  const after = doc(...paras(C.REGIONS_MAX + 3));
  const plan = C.collateral(before, after, { threads: [] }, { who: '@claude' });
  eq('more regions than the cap becomes ONE thread', plan.threads.length, 1);
  check('…which says so, and how many', plan.threads[0].text.includes(`${C.REGIONS_MAX + 3} passages`));
  check('…and lists them', plan.threads[0].text.includes('as it was rewritten this turn.'));
  eq('…marked as the summary', plan.threads[0].summary, true);
  check('…anchored to the first of them, so it clicks through somewhere real',
    C.docBlocks(after).join(' ').includes(plan.threads[0].quote));
  eq('…and the regions are still reported for anyone counting',
    plan.regions.length, C.REGIONS_MAX + 3);
}
{
  // the other reading of extensive: not many places, but most of the document
  const before = doc('One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.');
  const after = doc('One.', 'Wholly different prose here now, at length.',
    'And more of it, nothing like what stood here.', 'Nor this.', 'Nor this either.', 'Six.');
  const plan = C.collateral(before, after, { threads: [] }, { who: '@claude' });
  check('a rewrite of most of the document is extensive', plan.extensive);
  eq('…and gets one note', plan.threads.length, 1);
}

// ---- 6. the shape the server writes --------------------------------------
console.log('\nthe thread the companion writes');
{
  const plan = C.collateral(before3, after3, { threads: [] }, { who: '@claude' });
  const t = plan.threads[0];
  check('quote is what stands there now', t.quote.includes('by the board'));
  check('prior_quote is what it replaced — the struck half the page needs', !!t.prior_quote);
  check('prefix and suffix are context, capped by store.addThread', typeof t.prefix === 'string' && typeof t.suffix === 'string');
  check('the text is the thread\'s first message', t.text.length > 40);
  eq('and it is not the summary', t.summary, false);
}

// ---- 7. and the record the extension reads -------------------------------
// The server writes these through store.addThread + store.setAddressed and
// nothing else — no new persistence, no new endpoint. This composes that here,
// exactly as server.reportCollateral does, and checks the result is the triple
// content.js paints from: `t.addressed && !t.resolved && t.prior_quote`.
console.log('\nthe record content.js paints from');
{
  const page = { url: 'file:///x/index.html', threads: [], page_chat: [] };
  const plan = C.collateral(before3, after3, page, { who: '@claude' });
  for (const t of plan.threads) {
    const thread = store.addThread(page, {
      quote: t.quote, prefix: t.prefix, suffix: t.suffix, text: t.text, author: 'claude',
    });
    thread.auto = true;
    if (t.prior_quote) thread.prior_quote = t.prior_quote;
    store.setAddressed(thread, true, 'claude');
  }
  const t = page.threads[0];
  eq('the thread is on the page', page.threads.length, 1);
  check('addressed — the amber middle state', !!t.addressed && !t.resolved);
  check('…and attributed to the bot that did it', /^claude/.test(t.addressed_by || ''));
  check('prior_quote is the struck half', !!t.prior_quote);
  check('auto is set, which is what a LATER turn\'s dedupe reads', t.auto === true);
  check('the first message is the bot\'s', /^claude/.test(t.msgs[0].author));
  check('prefix and suffix are capped exactly as every other anchor is',
    t.prefix.length <= 32 && t.suffix.length <= 32);
  // and the reason send review needs no new rule
  const ws = await import('../workspace.mjs');
  eq('an auto-thread is out of the next send review, because it is addressed',
    ws.openThreads(page).length, 0);
  store.setAddressed(t, false);
  eq('…and "not done" puts it back in, like any other ready thread',
    ws.openThreads(page).length, 1);
}


// ---- 5. healing an orphan -------------------------------------------------
//
// The case the whole of §5 is about: a bot silently rewrites (or deletes) the
// passage a READER's comment is anchored to and says nothing about it. There is
// no `now reads` line, so the page has nothing to locate; the thread's quote is
// no longer in the document and the card reads "orphaned". The diff knows what
// replaced it, so the thread is re-anchored from the file rather than left
// pointing at nothing — and the region that healed it must NOT also spawn an
// auto-thread, which would be two cards for one change.
console.log('\nhealing — the reader\'s own comment, silently rewritten');
const QUOTE = 'The report called it a structural failure of oversight.';
const reader = (over = {}) => ({
  id: 't1', quote: QUOTE,
  msgs: [{ author: 'angadh', ts: '2026-08-19T10:00:00.000Z', text: 'is "structural" fair?' }],
  ...over,
});
{
  // nobody answered the thread at all — the bots were working somewhere else
  // and took this passage with them. The old dedupe required `addressed` and
  // let exactly this case fall through to a stranger's auto-thread.
  const page = { threads: [reader()] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z', who: '@claude' });
  eq('an unanswered orphan is healed, not stepped over', plan.heals.length, 1);
  eq('…and spawns no auto-thread of its own', plan.threads.length, 0);
  const h = plan.heals[0];
  eq('the new anchor is the wording that replaced it',
    h.quote, 'The report called it a failure of oversight by the board.');
  check('it is not a deletion', h.deleted === false);
  check('the note says who did it and that nothing was said here',
    /@claude/.test(h.text) && /without saying so in this thread/.test(h.text));
  check('…and never the phrase rule 5 owns, which would set it re-anchoring itself',
    !/now reads/i.test(h.text));
}
{
  // a bot DID narrate it: the page has proof and re-anchors itself through
  // /reanchor. The companion must keep its hands off that thread's anchor.
  const page = { threads: [reader({
    addressed: true,
    msgs: [{ author: 'claude', ts: '2026-08-19T10:01:00.000Z',
      text: 'done — this passage now reads: "The report called it a failure of oversight by the board."' }],
  })] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z' });
  eq('a narrated rewrite is left to the page', plan.heals.length, 0);
  eq('…and still spawns nothing', plan.threads.length, 0);
}
{
  // a FILED thread is closed. Healing it would drag it back onto the page
  // under a green highlight nobody asked to move.
  const page = { threads: [reader({ resolved: true })] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z' });
  eq('a resolved thread is never healed', plan.heals.length, 0);
  eq('…and the change is reported on its own instead', plan.threads.length, 1);
}
{
  // an auto-thread is the machine's note, not a reader's comment. A second
  // change to that passage is news to report, not a rewrite of the note —
  // the case the dedupe comment has protected since the feature shipped.
  const page = { threads: [reader({ id: 'auto1', auto: true, addressed: true })] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z' });
  eq('an auto-thread is not healed', plan.heals.length, 0);
  eq('…the second change gets its own thread', plan.threads.length, 1);
}
{
  // DELETION: nothing replaced the passage, so there is nothing to re-anchor
  // ONTO — the thread borrows the surviving block next door and is marked, so
  // the card can say the passage was deleted rather than draw a rewrite.
  const beforeD = doc('Head paragraph stays.', QUOTE, 'Tail paragraph stays.');
  const afterD = doc('Head paragraph stays.', 'Tail paragraph stays.');
  const page = { threads: [reader()] };
  const plan = C.collateral(beforeD, afterD, page, { since: '2026-08-19T09:59:00.000Z', who: '@codex' });
  eq('the deletion is routed into the reader\'s thread', plan.heals.length, 1);
  const h = plan.heals[0];
  check('marked as a deletion', h.deleted === true);
  eq('anchored to the block that outlived it', h.quote, 'Tail paragraph stays.');
  check('and the note says so in those words', /DELETED/.test(h.text));
  eq('no auto-thread doubles it', plan.threads.length, 0);
}
{
  // two changed places, one thread. The heal is claimed once; the other place
  // is a change nobody commented on and gets the thread it always got.
  const b = doc('Head paragraph stays.', QUOTE, 'Untouched prose in between.',
    'A second untouched paragraph.', 'Tail stays.');
  const a = doc('Head paragraph stays.', 'The report called it a failure of oversight by the board.',
    'Untouched prose in between.', 'A second paragraph, rewritten entirely by the bots.', 'Tail stays.');
  const page = { threads: [reader()] };
  const plan = C.collateral(b, a, page, { since: '2026-08-19T09:59:00.000Z' });
  eq('one heal', plan.heals.length, 1);
  eq('…and one ordinary auto-thread for the place nobody commented on', plan.threads.length, 1);
  check('which is the OTHER passage, not the healed one',
    /rewritten entirely by the bots/.test(plan.threads[0].quote));
}
{
  // a bot's "also changed" line elsewhere on the page explains the rewrite
  // better than the standing text does, so the heal borrows it
  const page = {
    threads: [reader()],
    page_chat: [{ author: 'claude', ts: '2026-08-19T10:01:00.000Z',
      text: 'also changed — this passage now reads: "The report called it a failure of oversight by the board." because the claim above no longer held' }],
  };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z' });
  eq('still one heal', plan.heals.length, 1);
  check('carrying the bot\'s own sentence rather than the standing text',
    /also changed/.test(plan.heals[0].text));
}
{
  // end to end against the record, which is what content.js actually paints
  // from: `addressed && !resolved && prior_quote`
  const page = { url: 'file:///x/index.html', threads: [reader()], page_chat: [] };
  const plan = C.collateral(before3, after3, page, { since: '2026-08-19T09:59:00.000Z', who: '@claude' });
  const t = page.threads[0];
  const done = store.healThread(t, plan.heals[0]);
  check('the heal applies', done.ok && done.changed);
  store.appendMsg(page, t.id, { author: 'claude', text: plan.heals[0].text });
  eq('the anchor is the new wording', t.quote, 'The report called it a failure of oversight by the board.');
  eq('prior_quote is the reader\'s original passage', t.prior_quote, QUOTE);
  check('no longer orphaned', t.orphaned === false);
  check('addressed — the amber middle state, from the appended note', !!t.addressed && !t.resolved);
  check('the paint contract content.js reads is satisfied',
    !!(t.addressed && !t.resolved && t.prior_quote));
  check('healed_at is stamped', typeof t.healed_at === 'string' && t.healed_at.length > 0);
  check('it is still the READER\'S thread, never marked auto', t.auto === undefined);
  // …and prior_quote is written ONCE: a passage rewritten twice still has one
  // original, and it is the only thing here nothing can recover
  store.healThread(t, { quote: 'Something else entirely, later on.' });
  eq('a second heal leaves the original alone', t.prior_quote, QUOTE);
  eq('…while the anchor follows the document', t.quote, 'Something else entirely, later on.');
  // idempotence: a re-run of the same turn-end is not a second rewrite
  const again = store.healThread(t, { quote: 'Something else entirely, later on.' });
  check('healing to the wording already there changes nothing', again.ok && !again.changed);
  // and a filed thread refuses at the store as well as in the plan
  store.setResolved(t, true, 'angadh');
  check('a resolved thread refuses to be healed', store.healThread(t, { quote: 'x y z' }).ok === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail);
