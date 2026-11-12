// collateral.mjs — the edits a bot made OUTSIDE the passage it was answering.
//
// ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
// Phase 2 lets the bots edit the artifact the reader is reading, and the
// track-changes machinery shows the reader what a change did — but only ever
// to the passage a comment thread was anchored to. The bot narrates the
// rewrite ("done — this passage now reads: …"), the page finds the new wording
// and strikes the old one before it, and the thread turns amber.
//
// A real edit rarely stops there. Fix the sentence a comment is about and the
// cross-reference two sections down is now wrong; tighten a claim and the
// paragraph that restates it disagrees with itself. Following the change out
// is legitimate and wanted — and until now it was INVISIBLE. There is no
// thread at that spot, so nothing narrates it, nothing anchors to it, and the
// tab simply reloads with the new sentence sitting in the prose looking exactly
// like prose nobody has touched. The one edit the reader did not ask for is the
// one they are never shown.
//
// ── THE ANSWER: THE FILE IS THE WITNESS ────────────────────────────────────
// The companion already takes a census of the project folder at turn-start and
// turn-end (workspace.scanProject) to tell the tab its file moved. That census
// records mtime and size — enough to say THAT the artifact changed, nothing
// about WHAT changed. So the turn-start snapshot also keeps the artifact's own
// bytes, and at turn-end this file diffs the two and turns every changed region
// no thread already covers into a thread of its own: quote = the wording that
// is on the page NOW, `prior_quote` = the wording it replaced, `addressed` set.
//
// That triple is the ENTIRE contract the existing machinery runs on:
// content.js's paint loop is `stage 'ready' && t.prior_quote`, and
// it reads all three off the record without caring who wrote them or whether a
// bot ever said a word. So an auto-created thread paints struck-old-then-green-
// new on the page, sorts into "ready for review", clicks through to a card with
// a two-ended diff, and files with ✓ — with ZERO extension changes. The
// backstop is a pure companion-side feature.
//
// WHY THE FILE AND NOT THE BOT'S WORD. A prompt rule asking bots to announce
// collateral edits (bridge-system-prompt rule 5b) rides beside this and makes
// the threads say WHY — but a rule is a request and a diff is a fact. A bot
// that forgets, runs out of turn, or edits three files while narrating one
// still cannot slip a change past the reader. The prompt supplies the reason;
// the file supplies the truth, and where they disagree the file wins.
//
// Everything here is PURE — html in, regions out — so every rule about
// granularity, dedupe and caps is testable without a server, a bridge or a
// browser (test/collateral.test.mjs).

import { createRequire } from 'node:module';
import { newWording, isAgentAuthor, isResolved, PAGE_CHAT } from './store.mjs';
// anchor.js's `plainOf`: a bot narrating a markdown source quotes MARKDOWN
// ("now reads: \"the [IEA](https://…) says\""), and on a blog the regions below
// are in the words the page shows (blog.mdDoc). The two are compared in the
// page's words, through the same rule the page uses.
const { plainOf } = createRequire(import.meta.url)('./extension/anchor.js');

// ---- caps ----------------------------------------------------------------
//
// A backstop that spams the rail is worse than no backstop: the reader stops
// reading the rail, and the ONE change they needed to see goes down with the
// rest. So every cap here is chosen to fail towards "one thread that says the
// document changed a lot" rather than towards forty.

// How many auto-threads one turn may create. Past this the turn gets a single
// SUMMARY thread instead, which lists what moved. Six is about the most a
// reader will actually work through in one sitting, and a turn that changed
// more than six passages was not a collateral edit — it was a rewrite.
export const REGIONS_MAX = 6;
// Regions listed by name inside a summary thread's message.
export const SUMMARY_LIST_MAX = 20;
// The longest quote an auto-thread will anchor to. Longer regions are clipped
// at a word boundary — a clipped quote is still an EXACT substring of the page,
// so it still locates; it just highlights the head of the region rather than
// all of it. (Anchor.WAS_MAX = 600 is where the page stops drawing the struck
// old wording inline and shows the change in the card instead; that is a
// display decision and this is an anchoring one, so they are not the same
// number.)
export const QUOTE_MAX = 1000;
// A narrowed region is grown back out to at least this many characters before
// it is used as an anchor: "not" on its own appears forty times in a draft and
// anchors to none of them.
export const MIN_QUOTE = 24;
// Cells the block-level LCS may fill. Past it the documents are too far apart
// to diff usefully and the turn is reported as extensive.
const LCS_CELLS = 250000;
// …and the same verdict from the other direction: a turn that replaced more
// than this share of the document's blocks rewrote it.
const EXTENSIVE_SHARE = 0.5;
// The artifact is read whole at turn-start. A file past this is not a document
// anybody is reading in a browser tab, and holding it twice per turn is not
// worth it — the census still reports it moved, as it always did.
export const SNAPSHOT_MAX = 4 * 1024 * 1024;

// ---- the document as text ------------------------------------------------
//
// The regions have to be expressed in the words that are ON THE PAGE, because
// that is what an anchor is matched against — `Anchor.locate` walks the live
// DOM's text, not the file's markup. So the diff is taken over TEXT BLOCKS,
// extracted here the same way the browser's text index is built: block-level
// elements separate, inline ones do not, script/style are not text at all.
//
// This is a deliberate second implementation of a browser rule rather than a
// shared one — the companion has no DOM and cannot borrow anchor.js's walk. It
// is kept honest the only way that works: the harness drives a real page and
// asserts the quote this file synthesized locates in it (`?colledit=1`).

const BLOCKISH = /^(address|article|aside|blockquote|body|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)$/;
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', shy: '', middot: '·',
};

export function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,9});/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const hit = NAMED[e.toLowerCase()];
    return hit === undefined ? m : hit;
  });
}

// The document as an array of block strings, whitespace folded, empties gone.
// Everything the reader cannot see is dropped rather than emptied, so a style
// block moving does not read as a paragraph changing.
// a separator no document contains, so a block boundary can be one character
const SPLIT = '\u0000';

export function docBlocks(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|head|select|textarea)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // the doctype is not a tag and not text; left alone it reads as a first
  // paragraph, and every document would then start with a changed block
  s = s.replace(/<![^>]*>/g, ' ');
  // a block tag — opening OR closing — ends the block either side of it; every
  // other tag is inline and leaves a single space where it stood, so
  // "<em>structural</em> failure" folds back to "structural failure"
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (m, tag) => (BLOCKISH.test(tag.toLowerCase()) ? SPLIT : ' '));
  return decodeEntities(s)
    .split(SPLIT)
    .map(b => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// The comparable form of a fragment — the same fold anchor.js matches under,
// so "covers" here means what "locates" means there.
export const fold = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// …and the looser fold anchor.js matches under: curly quotes and dashes are the
// straight ones. A reader's quote is cut from a page kramdown made "smart"; the
// markdown it came from may say it straight.
const loose = s => fold(s).replace(/[‘’‚‹›]/g, "'").replace(/[“”„«»]/g, '"').replace(/[–—−‑‐]/g, '-');

// ---- the diff ------------------------------------------------------------
//
// Block-level, because a block is a paragraph and a paragraph is the unit a
// reader reviews. Common head and tail are trimmed first (a turn that edits one
// sentence of a long draft leaves everything either side identical, so the LCS
// usually runs over a handful of blocks), then a plain LCS over what is left.
//
// Returns changed HUNKS in document order — {oldStart, oldEnd, newStart,
// newEnd}, absolute indices, ends exclusive — or null when the two documents
// are too far apart to be worth diffing, which the caller reports as extensive.
//
// ADJACENT CHANGED BLOCKS ARE ONE HUNK, and that is the merge the granularity
// rule asks for: a bot that rewrote two paragraphs in a row made ONE change
// there and should cost one thread, not two. Blocks separated by so much as one
// untouched block are NOT merged — merging across them would swallow prose
// nobody touched into the quote, and the reader would see a highlight claiming
// a sentence had changed when it had not.
export function hunks(a, b) {
  a = Array.isArray(a) ? a : [];
  b = Array.isArray(b) ? b : [];
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  if (!A.length && !B.length) return [];
  if (A.length * B.length > LCS_CELLS) return null;

  // LCS table over the middles. One Int32Array row per old block: the middles
  // are small by construction, and this stays well inside a turn-end's budget.
  const n = A.length, m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the table forward, collecting runs of "not matched on either side".
  const out = [];
  let i = 0, j = 0, run = null;
  const close = () => { if (run) { out.push(run); run = null; } };
  const open = () => { if (!run) run = { oldStart: s + i, oldEnd: s + i, newStart: s + j, newEnd: s + j }; };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { close(); i++; j++; continue; }
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { open(); j++; run.newEnd = s + j; continue; }
    open(); i++; run.oldEnd = s + i;
  }
  close();
  return out;
}

// ---- narrowing a hunk to the words that actually moved --------------------
//
// A one-block-for-one-block hunk is usually a sentence changing inside a
// paragraph that is otherwise word for word what it was. Anchoring the whole
// paragraph would strike the whole paragraph through on the page and show the
// reader a wall of red to find four words in — so the shared head and tail are
// trimmed off and become the anchor's CONTEXT instead, which is exactly what
// prefix/suffix are for.
//
// Word granularity, not character: a trim that lands mid-word produces a quote
// that starts with "…ctural failure" and reads as damage.
//
// Two guards. The narrowed new side is grown back out until it is long enough
// to anchor (MIN_QUOTE) — a three-word quote appears everywhere. And a hunk
// where the new side narrows to NOTHING (a sentence deleted from inside a
// paragraph) keeps the whole pair: there is no shorter thing on the page to
// point at, and the paragraph is where the deletion happened.
export function narrow(oldText, newText) {
  const ow = fold(oldText).split(' ').filter(Boolean);
  const nw = fold(newText).split(' ').filter(Boolean);
  let head = 0;
  while (head < ow.length && head < nw.length && ow[head] === nw[head]) head++;
  let tail = 0;
  while (tail < ow.length - head && tail < nw.length - head
    && ow[ow.length - 1 - tail] === nw[nw.length - 1 - tail]) tail++;
  const cut = () => ({
    old: ow.slice(head, ow.length - tail).join(' '),
    new: nw.slice(head, nw.length - tail).join(' '),
  });
  let r = cut();
  if (!r.new) return { old: fold(oldText), new: fold(newText), prefix: '', suffix: '' };
  // grow back — from the head first, because context that reads left to right
  // is the context a reader recognises
  while (r.new.length < MIN_QUOTE && (head > 0 || tail > 0)) {
    if (head > 0) head--; else tail--;
    r = cut();
  }
  return {
    old: r.old,
    new: r.new,
    prefix: nw.slice(0, head).join(' '),
    suffix: nw.slice(nw.length - tail).join(' '),
  };
}

const clipQuote = q => {
  const s = fold(q);
  if (s.length <= QUOTE_MAX) return s;
  const cut = s.slice(0, QUOTE_MAX);
  const sp = cut.lastIndexOf(' ');
  return (sp > QUOTE_MAX / 2 ? cut.slice(0, sp) : cut).trim();
};

const ctxBefore = (blocks, at, extra) => fold(`${blocks[at - 1] || ''} ${extra || ''}`).slice(-32);
const ctxAfter = (blocks, at, extra) => fold(`${extra || ''} ${blocks[at] || ''}`).slice(0, 32);

// ---- regions -------------------------------------------------------------
//
// A REGION is one changed place in the document, expressed the way a thread
// needs it: `quote` is what stands there now (the anchor — it must be text the
// page really carries), `old` is what it replaced (`prior_quote` — the struck
// half), plus the context either side.
//
// Three kinds, and the difference is only ever about what there is to point at:
//   edit    — text replaced text. The ordinary case.
//   insert  — text arrived where there was none. `old` is empty, so the page
//             draws no strike-through; the thread still anchors on the new
//             text and still turns amber, which is the part that matters.
//   delete  — text left and nothing replaced it. NOTHING IS THERE TO ANCHOR TO,
//             so the thread anchors to the surviving block that now follows the
//             hole (or precedes it, at the end of a document) and carries the
//             departed wording as `prior_quote`. The page then strikes the
//             deleted sentence through immediately before the paragraph that
//             outlived it — which is where it was, and is exactly Word's idiom.
export function regionsFrom(beforeHtml, afterHtml) {
  const before = docBlocks(beforeHtml);
  const after = docBlocks(afterHtml);
  const hs = hunks(before, after);
  if (hs === null) return { regions: [], extensive: true, reason: 'too-far-apart' };
  if (!hs.length) return { regions: [], extensive: false };

  const regions = [];
  for (const h of hs) {
    const oldText = before.slice(h.oldStart, h.oldEnd).join(' ');
    const newText = after.slice(h.newStart, h.newEnd).join(' ');
    if (!oldText && !newText) continue;

    if (!newText) {
      // pure deletion: borrow the survivor next door as the anchor
      const at = h.newStart < after.length ? h.newStart : after.length - 1;
      if (at < 0) continue;                       // the document is now empty
      regions.push({
        kind: 'delete',
        quote: clipQuote(after[at]),
        old: fold(oldText),
        prefix: ctxBefore(after, at, ''),
        suffix: ctxAfter(after, at + 1, ''),
      });
      continue;
    }
    if (!oldText) {
      regions.push({
        kind: 'insert',
        quote: clipQuote(newText),
        old: '',
        prefix: ctxBefore(after, h.newStart, ''),
        suffix: ctxAfter(after, h.newEnd, ''),
      });
      continue;
    }
    // one block for one block is where narrowing pays; a multi-block hunk is
    // already a structural change and the blocks themselves are the region
    const one = (h.oldEnd - h.oldStart) === 1 && (h.newEnd - h.newStart) === 1;
    const n = one ? narrow(oldText, newText) : { old: fold(oldText), new: fold(newText), prefix: '', suffix: '' };
    regions.push({
      // a sentence added INSIDE a paragraph narrows to nothing on the old side:
      // that is an insertion, and is told and painted as one (green new words,
      // nothing struck), not as a rewrite of nothing
      kind: n.old ? 'edit' : 'insert',
      quote: clipQuote(n.new),
      old: fold(n.old),
      prefix: ctxBefore(after, h.newStart, n.prefix),
      suffix: ctxAfter(after, h.newEnd, n.suffix),
      // The un-narrowed pair, kept beside the narrowed one because HEALING
      // needs the other granularity. An auto-thread is announcing "these words
      // moved", so the tight quote is right. A heal is moving a READER'S
      // comment, which was on the whole passage — re-anchoring it to a
      // four-word fragment would shrink their highlight and leave the card
      // diffing a whole sentence against a fragment of one, which reads as a
      // deletion that never happened.
      whole: {
        quote: clipQuote(newText),
        old: fold(oldText),
        prefix: ctxBefore(after, h.newStart, ''),
        suffix: ctxAfter(after, h.newEnd, ''),
      },
    });
  }
  // …and the other reading of "extensive": most of the document is not the
  // document it was. A count of six regions is not what makes that a rewrite —
  // the share of the blocks they cover is.
  const touched = hs.reduce((k, h) => k + Math.max(h.oldEnd - h.oldStart, h.newEnd - h.newStart), 0);
  const span = Math.max(before.length, after.length, 1);
  const extensive = touched / span > EXTENSIVE_SHARE && span > 3;
  return { regions, extensive, reason: extensive ? 'most-of-the-document' : '' };
}

// ---- what a thread already covers ----------------------------------------
//
// THE DEDUPE, and it is the rule that decides whether this feature helps or
// doubles everything. A change a bot NARRATED into the thread it was answering
// is already on its way to being shown — content.js re-anchors that thread onto
// the new wording and strikes the old one — so an auto-thread at the same spot
// would be a second card about one change, with two highlights fighting over
// one paragraph.
//
// The test is COVERAGE OF THE NEW TEXT, and only ever the new text:
//
//   · `newWording(t)` — what a bot claimed, in any thread, that a passage now
//     reads. This is the narrated case, and it catches it BEFORE the extension
//     has re-anchored anything (the census runs at turn-end, in the companion,
//     with no browser involved) — which is the only reason the two paths can
//     never race.
//   · `t.quote` — something is already anchored exactly there. That covers a
//     thread the reader left on the passage, and it covers an auto-thread from
//     an earlier turn that has not moved.
//
// The OLD text is deliberately NOT part of the test, with one exception below.
// Testing it would break the second turn on the same passage: an auto-thread
// created last turn carries the old wording as its quote, and matching on that
// would suppress the thread announcing the passage changed AGAIN — the reader
// would be shown one change and silently given two.
//
// The exception: a NON-auto thread the bots answered this turn, whose own quote
// is the wording that just left. That is the narrated case where the bot forgot
// to narrate — the change still belongs to the reader's thread, and the reader
// is already looking at it. Gated on `!t.auto` precisely so it cannot swallow
// the second-turn case above.
const MIN_OVERLAP = 16;
const covers = (a, b) => {
  const x = loose(a), y = loose(b);
  if (!x || !y) return false;
  if (Math.min(x.length, y.length) < MIN_OVERLAP) return x === y;
  return x.includes(y) || y.includes(x);
};

export function coveredBy(region, threads) {
  for (const t of (threads || [])) {
    if (!t) continue;
    const said = newWording(t);
    if (covers(said, region.quote)) return t;
    // …in the page's words, too: on a markdown source the bot quotes the file
    if (said && covers(plainOf(said), region.quote)) return t;
    if (covers(t.quote, region.quote)) return t;
  }
  return null;
}

// ---- healing an orphan ----------------------------------------------------
//
// THE GAP: a bot rewrites (or deletes) the passage a READER's comment is
// anchored to, and says nothing about it — no rule-5 `now reads` line, so the
// page has nothing to re-anchor with. The thread's quote is not on the page any
// more, the highlight cannot be painted, and the card says "orphaned". The
// reader's own comment, on their own draft, pointing at nothing.
//
// Before this, the turn-end diff KNEW. It had the departed wording and the
// wording that replaced it, matched the pair against the thread, and used that
// knowledge only to keep quiet — the old third branch of `coveredBy` skipped
// the region as "the reader is already looking at it", which was true of the
// card and a lie about the page.
//
// So the diff now routes into the thread instead of past it. The pair it holds
// is the pair `prior_quote`/`quote` are FOR:
//
//   rewrite — the region's old text is (or contains) the thread's quote, and
//             something replaced it. The thread re-anchors onto the new
//             wording with the old one as `prior_quote`, and paints struck-old-
//             then-green-new on the READER'S OWN CARD, exactly as a narrated
//             rewrite does. Same three fields, same paint loop, no new state.
//   delete  — nothing replaced it. The region already carries the anchor for
//             this case (the surviving block next door), so the thread borrows
//             it and is marked `deleted_passage`: the card says the passage was
//             deleted and the page strikes it through before the paragraph that
//             outlived it.
//
// WHY THE FILE MAY DO THIS AND A SENTENCE MAY NOT. `/reanchor` is deliberately
// the page's job: a bot's claim about a wording is not evidence the wording is
// on the page, so the extension has to locate it first. A diff is not a claim.
// The new text here came out of the file's own bytes, so "is it on the page?"
// is not an open question — which is why this path needs no browser and cannot
// race the browser one.
//
// The rules, and each is load-bearing:
//   · `!t.auto` — an auto-thread from an earlier turn is the machine's note,
//     not a reader's comment, and a second change to that passage is news to
//     report (a fresh thread) rather than a rewrite of the note.
//   · `!isResolved(t)` — a filed thread is closed. Re-anchoring it would drag it
//     back onto the page under a green highlight nobody asked to move.
//   · the region must have OLD text, and the thread's quote must be covered by
//     it. Coverage either way, like everywhere else here: a comment on one
//     sentence of a rewritten paragraph is about the passage that left.
//   · one heal per thread per turn — two regions cannot fight over one anchor.
//
// Order matters and is the caller's: `coveredBy` runs FIRST. A thread that
// narrated the change re-anchors from the page (which has proof), and a thread
// already sitting on the new text needs nothing at all.
export function healableBy(region, threads, used) {
  if (!region || !region.old) return null;
  // Both granularities of "what left": the narrowed words, and the whole block
  // they sat in. A reader quoting a sentence and a diff narrowing that sentence
  // to four words are talking about the same passage, but the four words can
  // fall under the 16-character overlap floor and miss it.
  const gone = [region.old, region.whole && region.whole.old].filter(Boolean);
  for (const t of (threads || [])) {
    if (!t || t.auto || isResolved(t)) continue;
    if (used && used.has(t.id)) continue;
    if (!t.quote || !gone.some(g => covers(t.quote, g))) continue;
    // already where it needs to be — nothing to heal
    if (covers(t.quote, region.quote)) continue;
    return t;
  }
  return null;
}

// What the healed thread says for itself. The reader is being told something
// happened to THEIR passage without them asking, so it says who, what and what
// their two buttons now mean — the same contract the auto-threads spell out.
export function healText(region, claim, who) {
  if (claim && claim.line) {
    return `${MARK} ${who} rewrote the passage this comment is on, without saying so in this thread.\n\n`
      + `> ${claim.line}\n\n`
      + 'The wording it replaced is struck through on the page and in the card above. '
      + '✓ files this thread; ↺ puts it back in the open list.';
  }
  if (region.kind === 'delete') {
    return `${MARK} ${who} DELETED the passage this comment is on, while working on the document — `
      + 'nothing replaced it, and nothing was said about it here. The comment now sits on the '
      + 'passage that follows the hole, with the deleted wording struck through before it. '
      + '✓ files this thread; ↺ puts it back in the open list.';
  }
  return `${MARK} ${who} rewrote the passage this comment is on, while working on the document, `
    + 'without saying so in this thread. The comment has moved onto the new wording; what it '
    + 'replaced is struck through on the page and in the card above. '
    + '✓ files this thread; ↺ puts it back in the open list.';
}

// ---- the comment the change was made FOR -----------------------------------
//
// A turn answers ONE conversation — a thread, or the page chat — and every
// change it makes was made in that conversation's name. Before this, the diff
// threw that away and every region it found said "changed while answering a
// comment elsewhere": true of a cross-reference two sections down, and
// nonsense for the sentence the reader had just ASKED for. Seen 2026-11-06: a
// reader highlighted "energy. EpochAI" and asked for a joining sentence; the bot
// wrote it in between those two words — so the reader's own highlight was split
// and orphaned, and the sentence they asked for turned up as a stranger's note
// with no route back to the conversation that produced it.
//
// Two rules, both keyed on the turn's own conversation (`origin`):
//
//   ADOPT — an INSERTION that landed inside the passage the comment was on,
//     splitting it so it no longer stands anywhere on the page. That is the
//     reader's request, answered where they made it: the comment moves onto the
//     new words, painted as an insertion, and the conversation carries straight
//     on. No second thread. (A REWRITE of that passage needs no rule here:
//     `healableBy` already moves any reader's comment onto what replaced its
//     words.)
//   LINK — anything else the turn changed still gets a thread of its own,
//     but that thread names the conversation it came from (`origin_thread`,
//     or `origin: 'page'` for the page chat), and the drawer draws the link
//     both ways: "in answer to …" on the change, "changed …" on the comment.
//
// Only the turn's own conversation is ever adopted into. Another reader's
// comment split by the same insertion is not theirs to be answered with, so it
// is left exactly as before.
export function adoptableBy(region, t, afterFlat, used) {
  if (!region || region.kind !== 'insert' || !t) return false;
  if (t.auto || isResolved(t) || !t.quote) return false;
  if (used && used.has(t.id)) return false;
  // still on the page as written: the comment has a place, nothing to adopt
  if (afterFlat && afterFlat.includes(loose(t.quote))) return false;
  const was = (region.whole && region.whole.old) || '';
  return !!was && loose(was).includes(loose(t.quote));
}

const clipQ = (q, n = 60) => {
  const s = fold(q);
  return s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s;
};

export function adoptText(region, t, who) {
  return `${MARK} ${who} added this passage in answer to this comment. It went in between the `
    + `words you highlighted (“${clipQ(t.quote)}”), so the comment now sits on the new wording, `
    + 'marked as an insertion. ✓ files it once you are happy with it; ↺ puts it back in the open list.';
}

// ---- what the bot said it also changed ------------------------------------
//
// Layer (a): the prompt asks a bot that edited outside the passage it was
// answering to say so, in one line per edit, quoting the new wording —
// `also changed — this passage now reads: "…"` (bridge-system-prompt rule 5b).
//
// Those lines do NOT create threads. The file does that; a bot's sentence is
// not evidence about a file. What they do is give the thread the file created
// its REASON: matched up by the wording they quote, the bot's own sentence
// becomes the auto-thread's first message, so the reader gets "I changed this
// because the claim two paragraphs up no longer held" instead of a bare diff.
// A line that quotes a wording the diff did not find is simply dropped — the
// bot was wrong about its own edit, and the file is the witness.
//
// Global, because a turn may name several. Anchored on "also changed" so it can
// never fire on rule 5's own sentence — which matters, because store.newWording
// reads the FIRST match in a message and a claim about somewhere else must not
// be able to move the thread's own anchor.
export const ALSO_CHANGED_RE =
  /\balso changed\b[^"“\n]{0,120}?\b(?:now reads|reads now|now says)\b\s*[:—-]?\s*[“"']([\s\S]{4,600}?)[”"']/gi;

// Every collateral claim a bot made in this page since `sinceIso`, newest last.
export function claimsSince(page, sinceIso) {
  const since = Date.parse(sinceIso || '') || 0;
  const out = [];
  const scan = (msgs, where) => {
    for (const m of (msgs || [])) {
      if (!m || m.kind === 'tools' || !isAgentAuthor(m.author)) continue;
      if (since && (Date.parse(m.ts || '') || 0) < since) continue;
      const text = String(m.text || '');
      ALSO_CHANGED_RE.lastIndex = 0;
      let hit;
      while ((hit = ALSO_CHANGED_RE.exec(text))) {
        out.push({ author: m.author, wording: fold(hit[1]), plain: plainOf(hit[1]), line: fold(hit[0]), where });
      }
    }
  };
  for (const t of ((page && page.threads) || [])) scan(t.msgs, t.id);
  scan((page && page.page_chat) || [], '');
  return out;
}

const claimFor = (region, claims) => (claims || [])
  .find(c => covers(c.wording, region.quote) || (c.plain && covers(c.plain, region.quote))) || null;

// ---- the threads themselves ----------------------------------------------

const MARK = '✎';
const WHY = 'This passage changed while the bots were working on a comment somewhere else in the '
  + 'document — nobody commented here. The wording it replaced is struck through on the page. '
  + '✓ files this once you are happy with it; ↺ puts it back in the open list.';
// The same note when the conversation is known: it is named, and linked from
// the card, so the reader can go and see why.
const WHY_FROM = 'Nobody commented on this passage itself; the change came out of the conversation '
  + 'named above, which links back here. The wording it replaced is struck through on the page. '
  + '✓ files this once you are happy with it; ↺ puts it back in the open list.';

// "while answering …" — the conversation, in a few words
function whileAnswering(origin) {
  if (origin && origin.quote) return `while answering the comment on “${clipQ(origin.quote)}”`;
  if (origin && origin.page) return 'while answering in the page chat';
  return 'while answering a comment elsewhere in the document';
}

// The message an auto-thread opens with. The bot's own sentence when it gave
// one, the standing explanation when it did not — and NEVER the phrase
// `now reads`, which is rule 5's and would set this thread re-anchoring itself
// onto the wording it is already anchored to.
export function autoText(region, claim, who, origin) {
  const where = whileAnswering(origin);
  const why = origin && (origin.quote || origin.page) ? WHY_FROM : WHY;
  const head = `${MARK} ${who} changed this passage ${where}.`;
  if (claim && claim.line) return `${head}\n\n> ${claim.line}\n\n${why}`;
  if (region.kind === 'insert') {
    return `${MARK} ${who} added this passage ${where}. `
      + 'Nothing here was commented on. ✓ files it; ↺ puts it back in the open list.';
  }
  if (region.kind === 'delete') {
    return `${MARK} ${who} removed a passage from just here ${where}. `
      + 'The wording that left is struck through on the page, before the paragraph '
      + 'that outlived it. ✓ files this; ↺ puts it back in the open list.';
  }
  return `${head}\n\n${why}`;
}

// …and the ONE thread a turn that changed the document extensively gets. Not a
// silent drop: the reader is told the count and shown the first line of each
// region, which is what tells them whether to go and read the whole thing.
export function summaryText(regions, who, why) {
  const n = regions.length;
  const head = why === 'too-far-apart' || !n
    ? `${MARK} ${who} rewrote this document while answering a comment. It is too different from the `
      + 'version you were reading to mark up passage by passage.'
    : `${MARK} ${who} changed ${n} passages in this document while answering comments elsewhere in it — `
      + 'too many to mark up one at a time without burying the rail.';
  const list = regions.slice(0, SUMMARY_LIST_MAX)
    .map(r => `- ${r.kind === 'delete' ? 'removed before' : r.kind === 'insert' ? 'added' : 'changed'}: `
      + `“${fold(r.quote).slice(0, 80)}${fold(r.quote).length > 80 ? '…' : ''}”`)
    .join('\n');
  const more = n > SUMMARY_LIST_MAX ? `\n- …and ${n - SUMMARY_LIST_MAX} more` : '';
  return `${head}${list ? `\n\n${list}${more}` : ''}\n\n`
    + 'Read the document itself for this one. ✓ files this note; ↺ puts it back in the open list.';
}

// The whole decision, as data: what a turn-end should do to the page record.
// Returns {threads:[{quote, prefix, suffix, prior_quote, text, kind, summary,
//                    origin_thread? | origin?}],
//          heals:[{thread_id, quote, prefix, suffix, deleted, inserted?, text, kind}],
//          regions, skipped, extensive}. Applying them is the server's job —
// this says WHAT, and is pure so the whole rule set is unit-testable.
//
// A region is routed exactly once, and the order of the four fates is the
// design: already-covered (nothing to do) → heals an existing orphan → is
// adopted by the comment the turn was answering → gets a thread of its own.
// `origin` is that comment's thread id, or store.PAGE_CHAT, or ''. A region absorbed into a reader's thread must NEVER also
// spawn an auto-thread; that would be two cards and two highlights over one
// change, which is the failure this whole feature exists to avoid.
// A region wholly inside callouts on both sides — the bots' own text in a
// blog post (ownership.mjs). `callouts` is {before, after}: the rendered words
// of each callout in the two versions (blog.calloutPlains). Such a change opens
// no thread and joins no summary: the owner asked for callout changes to leave
// no trace on the page. A heal or an adoption still happens first — that is a
// reader's own thread being kept on its passage, not a new marker.
const within = (t, list) => !t || (list || []).some(c => loose(c).includes(loose(t)));
export function calloutOnly(region, callouts) {
  if (!callouts) return false;
  const w = region.whole || region;
  const nw = region.kind === 'delete' ? '' : w.quote;
  const old = w.old || region.old || '';
  if (!nw && !old) return false;
  return within(nw, callouts.after) && within(old, callouts.before);
}

export function collateral(beforeHtml, afterHtml, page, { since, who = 'the bots', origin = '', callouts = null } = {}) {
  const { regions, extensive, reason } = regionsFrom(beforeHtml, afterHtml);
  const threads = (page && page.threads) || [];
  // the conversation this turn answered: a thread on this page, or the page chat
  const from = origin && origin !== PAGE_CHAT ? threads.find(t => t && t.id === origin) || null : null;
  const originRef = from ? { id: from.id, quote: from.quote || '' }
    : origin === PAGE_CHAT ? { page: true } : null;
  const afterFlat = from ? loose(docBlocks(afterHtml).join(' ')) : '';
  const fresh = [];
  const skipped = [];
  const healed = [];
  const adopted = [];
  const usedThreads = new Set();
  for (const r of regions) {
    const hit = coveredBy(r, threads);
    if (hit) { skipped.push({ region: r, thread_id: hit.id }); continue; }
    const orphan = healableBy(r, threads, usedThreads);
    if (orphan) { usedThreads.add(orphan.id); healed.push({ thread: orphan, region: r }); continue; }
    if (adoptableBy(r, from, afterFlat, usedThreads)) {
      usedThreads.add(from.id); adopted.push({ thread: from, region: r }); continue;
    }
    if (calloutOnly(r, callouts)) { skipped.push({ region: r, callout: true }); continue; }
    fresh.push(r);
  }
  // The reasons ride with the heals too: a bot that DID say "also changed"
  // somewhere else on the page explains the rewrite better than we can.
  const healClaims = healed.length ? claimsSince(page, since) : [];
  const heals = healed.map(({ thread, region }) => {
    // the whole passage, not the narrowed fragment — see `whole` in regionsFrom
    const at = region.whole || region;
    return {
      thread_id: thread.id,
      quote: at.quote,
      prefix: at.prefix,
      suffix: at.suffix,
      deleted: region.kind === 'delete',
      kind: region.kind,
      text: healText(region, claimFor(region, healClaims), who),
    };
  });
  // …and the reader's request, answered where they made it: the comment moves
  // onto the inserted words themselves (not the whole paragraph — the point is
  // to show which words are new), with nothing struck, because nothing left.
  for (const { thread, region } of adopted) {
    heals.push({
      thread_id: thread.id,
      quote: region.quote,
      prefix: region.prefix,
      suffix: region.suffix,
      deleted: false,
      inserted: true,
      kind: 'insert',
      text: adoptText(region, thread, who),
    });
  }
  const tag = t => (originRef && originRef.id ? { ...t, origin_thread: originRef.id }
    : originRef && originRef.page ? { ...t, origin: 'page' } : t);
  // Heals are not capped with the fresh regions below and are never replaced by
  // a summary note: they are repairs to comments the reader wrote by hand, and
  // "the document changed a lot" is no reason to leave one of those pointing at
  // nothing. The cap exists to stop the rail filling with threads nobody asked
  // for; a heal adds no row to the rail at all.
  if (!fresh.length) return { threads: [], heals, regions, skipped, extensive: false };
  // extensive, or simply too many to show one at a time: one note, not forty
  if (extensive || fresh.length > REGIONS_MAX) {
    const at = fresh[0];
    return {
      threads: [tag({
        quote: at.quote, prefix: at.prefix, suffix: at.suffix,
        prior_quote: at.old || '', kind: 'summary', summary: true,
        text: summaryText(fresh, who, extensive ? reason : 'too-many'),
      })],
      heals, regions, skipped, extensive: true,
    };
  }
  const claims = claimsSince(page, since);
  return {
    threads: fresh.map(r => tag({
      quote: r.quote, prefix: r.prefix, suffix: r.suffix,
      prior_quote: r.old || '', kind: r.kind, summary: false,
      text: autoText(r, claimFor(r, claims), who, originRef),
    })),
    heals, regions, skipped, extensive: false,
  };
}

// ---- repairing threads born in markdown -------------------------------------
//
// Before blog.mdDoc spoke the page's words, an auto-thread on a markdown source
// was written in MARKDOWN — `The [IEA’s base case](https://…) projects…` — and
// orphaned on arrival, because no page shows a link's brackets. Its record is
// still sitting there, pointing at nothing. So on load, an ORPHANED auto-thread
// whose quote reads differently with its markup off is given the rendered
// form, and the page gets one more chance to find it. Generic, idempotent (a
// rendered quote renders to itself, so a second pass changes nothing), and it
// never touches a reader's own thread — their quote came from the page.
//
// Context is cut mid-markup as often as not (`[EpochAI forecasts](https://www.`),
// so prefix and suffix have their dangling link halves closed or dropped first.
//
// …and the record was FOLDED when it was written: its line breaks are gone, so
// the furniture plainOf strips at the start of a line (a callout's `> [!note]`,
// a table's pipes and rule row, a heading's hashes, a list's number) now sits
// mid-string. Those are taken off by shape here, where the alternative is a
// thread that stays orphaned anyway.
const unfold = s => String(s || '')
  .replace(/\|(\s*:?-+:?\s*\|)+/g, ' ')                    // |---|:-:| rule rows
  .replace(/(^|\s)>(?=\s|$)/g, '$1')                        // quote bars
  .replace(/\[![\w-]+\][+-]?/g, ' ')                         // callout tags
  .replace(/(^|\s)\|(?=\s|$)/g, '$1')                       // cell walls
  .replace(/(^|\s)#{1,6}(?=\s)/g, '$1')                     // heading hashes
  .replace(/(^|\s)(?:\d+[.)]|[-*+])(?=\s)/g, '$1');         // list numbers, bullets
const fragPlain = s => plainOf(unfold(String(s || '')
  .replace(/\]\([^)]*$/, ']()')                  // a link cut off in its address
  .replace(/\[([^\]]*)$/, '$1')                  // …or in its text
  .replace(/^([^[\]]*)\]\([^)]*\)/, '$1')));     // a link whose start was cut off

// The conversation a thread made before `origin_thread` existed most likely
// came from: the ONE conversation a bot answered in during the seconds before
// the thread was written (the census runs at turn-end, right after the reply).
// Two candidates is a guess, and a guess is not written down.
const ORIGIN_WINDOW_MS = 15000;
export function guessOrigin(page, t) {
  const born = Date.parse((t && t.msgs && t.msgs[0] && t.msgs[0].ts) || '') || 0;
  if (!born) return null;
  const near = msgs => (msgs || []).some(m => m && m.kind !== 'tools' && isAgentAuthor(m.author)
    && (() => { const at = Date.parse(m.ts || '') || 0; return at <= born && born - at <= ORIGIN_WINDOW_MS; })());
  const hits = [];
  for (const o of (page && page.threads) || []) {
    if (o && o !== t && !o.auto && near(o.msgs)) hits.push({ thread: o.id });
  }
  if (near(page && page.page_chat)) hits.push({ page: true });
  return hits.length === 1 ? hits[0] : null;
}

export function renderAnchors(page) {
  let n = 0;
  for (const t of (page && page.threads) || []) {
    if (!t || !t.auto || isResolved(t) || !t.orphaned || !t.quote) continue;
    const q = clipQuote(fragPlain(t.quote));
    if (!q || q === fold(t.quote)) continue;
    t.quote = q;
    t.prefix = fragPlain(t.prefix).slice(-32);
    t.suffix = fragPlain(t.suffix).slice(0, 32);
    if (t.prior_quote) t.prior_quote = fragPlain(t.prior_quote);
    else if (!t.auto_summary && !t.deleted_passage) t.inserted = true;
    if (!t.origin_thread && !t.origin) {
      const o = guessOrigin(page, t);
      if (o && o.thread) t.origin_thread = o.thread;
      else if (o && o.page) t.origin = 'page';
    }
    t.rendered_at = new Date().toISOString();
    n++;
  }
  return n;
}
