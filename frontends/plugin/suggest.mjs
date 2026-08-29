// suggest.mjs — propose-first editing on a blog source page.
//
// ── WHY THIS IS A PORT AND NOT AN INVENTION ────────────────────────────────
// The review engine (frontends/review) solved this problem once already, for
// LaTeX papers: a bot does not edit the manuscript, it writes a SUGGESTION
// CARD carrying `current_text` and `proposed_text`; the card is drawn as a
// del/ins diff; accepting it replaces a UNIQUE SPAN in the source; a span that
// is ambiguous or has drifted is flagged `needs_manual_resolution` and is
// NEVER guessed at. When Discuss absorbed review-page commenting, the comment
// store crossed over and that pipeline did not — so a blog page got direct
// edits plus tracked changes, and the reader had no veto before the file
// moved.
//
// This module brings the propose-first half over. Three things are ported
// rather than reimagined, deliberately:
//
//   1. THE CARD'S FIELDS. current → proposed → why, exactly as
//      `review/SCHEMA.md` defines them, because the whole apply rule hangs off
//      `current` being a span that occurs ONCE.
//   2. THE MATCHER. `frontends/review/assets/span-match.js` is imported here
//      unchanged — not copied, not re-derived. A bot writes single-spaced
//      prose with ASCII quotes; markdown wraps its lines and carries typographic
//      ones; the matcher collapses whitespace runs and folds curly quotes on
//      BOTH sides, and hands back TRUE offsets so the replacement lands on the
//      raw bytes. A second, subtly different matcher is exactly the bug this
//      import exists to prevent. (The extension cannot import across the repo
//      and so duplicates small helpers — normUrl, tagHue — under a test that
//      pins them. Nothing here runs in the browser, so nothing here is copied.)
//   3. THE REFUSALS. Zero matches is drift; more than one is ambiguity; both
//      stop the apply and say so on the card. `apply.mjs` never guesses and
//      neither does this.
//
// ── WHAT IS DELIBERATELY NOT PORTED ────────────────────────────────────────
// `apply.mjs` keeps a round LEDGER (state/apply.json) because a review round
// ends in `git commit`, with `git checkout` as the undo. A blog root has no
// git at all — that is the settled promise of blog.mjs, held in code — so
// there is no round, nothing to commit, and nothing to revert. A card's whole
// life therefore lives on the card: `state` is open, applied, rejected or
// needs-manual, stored on the reply that proposed it. Bib entries and
// `source_json` do not port either: a Jekyll post has no bibliography and its
// front matter is markdown, not a JSON document.
//
// THIS MODULE WRITES EXACTLY ONE THING: the markdown file a card names, and
// only when `applyCard` is called with a span that resolved uniquely.
import fs from 'node:fs';
// The review engine's matcher, imported and not forked. See the header.
import SpanMatch from '../review/assets/span-match.js';
const { findSpans } = SpanMatch;

// ---- the block a bot writes ----------------------------------------------
//
// The established idiom, for the fourth time: machinery inside a reply, lifted
// off the words by the companion, drawn as a card the reader answers. `strike:`
// and `file-in:` are single lines because they carry one fact; a suggestion
// carries three, one of which is a whole paragraph, so it is a FENCED BLOCK —
// fenced for the same reason those are single-line: a boundary a model cannot
// half-produce and a parser cannot half-read.
//
//     ```suggest
//     current: The mass saving is the whole argument and it is not a small one.
//     proposed: The mass saving is the whole argument, and it is not small.
//     why: the double negative reads as a hedge
//     ```
//
// EVERY BLOCK IN THE REPLY COUNTS, and that is the one place this convention
// differs from the question vault's (where the last block wins). A typo sweep
// is a stack of ten small proposals and there is nothing to choose between
// them — they are all meant, they are all the answer, and the reader accepts
// or refuses each on its own.
export const SUGGEST_FENCE = 'suggest';
// A deletion has an empty replacement, and an empty `proposed:` is far more
// often a model that lost its footing than a model that meant to cut a
// sentence. So a cut must be SAID: `proposed: (delete)`. An empty value is
// refused, visibly, rather than silently deleting the reader's prose.
export const DELETE_MARK = '(delete)';
const FENCE_RE = /```[ \t]*suggest[ \t]*\r?\n([\s\S]*?)```/gi;
const KEY_RE = /^\s*(current|from|proposed|to|why|because|reason)\s*:\s*(.*)$/i;

export const CURRENT_MAX = 4000;
export const PROPOSED_MAX = 6000;
export const WHY_MAX = 240;
// A sweep of a long post is a real thing; a reply with fifty cards in it is a
// model that has stopped answering and started generating. The extra ones are
// dropped at the lift and the reader is told how many.
export const CARDS_MAX = 30;
// How many matches the uniqueness test bothers to count before it says "lots".
const SPAN_LIMIT = 10;

const clip = (s, n) => {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n).trimEnd() : t;
};

/**
 * One block's body, read into its three fields.
 *
 * `current:`, `proposed:` and `why:` may each run over several lines — a
 * proposed paragraph is not a one-liner and a model should not have to fold it
 * onto one. A key line closes whatever field was open, which is the only rule
 * needed: the fields are three and their names are fixed.
 */
export function parseSuggestBlock(body) {
  const fields = { current: null, proposed: null, why: null };
  let open = '';
  for (const raw of String(body == null ? '' : body).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const kv = KEY_RE.exec(line);
    if (kv) {
      const k = kv[1].toLowerCase();
      const key = (k === 'current' || k === 'from') ? 'current'
        : (k === 'proposed' || k === 'to') ? 'proposed' : 'why';
      fields[key] = [kv[2]];
      open = key;
      continue;
    }
    // a blank line ends `why:` (a one-line field by intent) but not the two
    // that carry prose — a paragraph with a blank line in it is a paragraph
    if (!line.trim() && open === 'why') { open = ''; continue; }
    if (open) fields[open].push(line);
  }
  const join = k => (fields[k] === null ? null : fields[k].join('\n').replace(/^\n+|\n+$/g, ''));
  const current = join('current');
  const proposed = join('proposed');
  const why = join('why');

  if (current === null) return { ok: false, error: 'the block has no `current:` line' };
  if (!current.trim()) return { ok: false, error: '`current:` is empty' };
  if (proposed === null) return { ok: false, error: 'the block has no `proposed:` line' };
  const cut = proposed.trim().toLowerCase() === DELETE_MARK;
  if (!cut && !proposed.trim()) {
    return { ok: false, error: `\`proposed:\` is empty — to cut the passage write \`proposed: ${DELETE_MARK}\`` };
  }
  if (current.length > CURRENT_MAX) return { ok: false, error: 'the `current:` passage is too long to match on' };
  if (!cut && proposed.length > PROPOSED_MAX) return { ok: false, error: 'the `proposed:` passage is too long' };
  if (!cut && current.trim() === proposed.trim()) {
    return { ok: false, error: 'the proposal is the same as what is there' };
  }
  return {
    ok: true,
    current: current.trim(),
    proposed: cut ? '' : proposed.trim(),
    deletes: cut,
    why: clip(why, WHY_MAX),
  };
}

// A card's id. Short, minted at the lift, and carried by the endpoints — an
// index into the reply's array would be an address that moves when anything
// else about the message does.
let seq = 0;
const newId = () => `sg${Date.now().toString(36)}${(seq = (seq + 1) % 46656).toString(36).padStart(3, '0')}`;

/**
 * Every ```suggest block in a reply, lifted off the words.
 *
 * Returns `{ text, cards }` — the reply with the blocks removed (they are
 * machinery, not prose, exactly as `strike:` and `file-in:` are) and the cards
 * in the order they were written.
 *
 * A block that will not parse still comes off the words and still becomes a
 * card — a buttonless one that says what was wrong. Refusing VISIBLY is the
 * whole point: the failure this idiom keeps hitting is a bot announcing a fix
 * that the companion quietly dropped, leaving the reader no way to tell a
 * proposal that vanished from one that was never made.
 */
export function liftSuggestions(text) {
  const src = String(text == null ? '' : text);
  const cards = [];
  let out = src;
  let dropped = 0;
  for (const m of src.matchAll(FENCE_RE)) {
    if (cards.length >= CARDS_MAX) { dropped++; out = out.split(m[0]).join(''); continue; }
    const parsed = parseSuggestBlock(m[1]);
    out = out.split(m[0]).join('');
    cards.push(parsed.ok
      ? { id: newId(), state: 'open', current: parsed.current, proposed: parsed.proposed,
        ...(parsed.deletes ? { deletes: true } : {}), why: parsed.why }
      : { id: newId(), state: 'unreadable', error: parsed.error });
  }
  if (!cards.length) return { text: src, cards: [], dropped: 0 };
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), cards, dropped };
}

// ---- the apply rule, ported whole ----------------------------------------

/**
 * Where a card's `current` stands in this text — or why it cannot be placed.
 *
 * The rule is `apply.mjs`'s, unchanged: exactly one whitespace-tolerant match
 * is an address, zero is drift, and more than one is ambiguity. The reasons
 * are the reader's own words rather than the engine's, because they are read
 * on a card in a drawer and not in a JSON ledger.
 */
export function resolveSpan(text, current) {
  const spans = findSpans(String(text == null ? '' : text), current, SPAN_LIMIT);
  if (spans.length === 0) {
    return { ok: false, reason: 'drift',
      detail: 'that wording is not in the source any more — the file changed after this was written' };
  }
  if (spans.length > 1) {
    const n = spans.length === SPAN_LIMIT ? `${SPAN_LIMIT} or more` : String(spans.length);
    return { ok: false, reason: 'ambiguous', matches: spans.length,
      detail: `that wording appears ${n} times in the source, so there is no way to tell which one is meant` };
  }
  return { ok: true, start: spans[0].start, end: spans[0].end };
}

const readFile = file => {
  try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; }
  catch { return { ok: false, reason: 'gone', detail: 'the source file could not be read' }; }
};

/**
 * Accept one card: the unique span, replaced, in place.
 *
 * Returns `{ok:true, before, after, start, end}` on success and
 * `{ok:false, reason, detail}` on every refusal — and a refusal writes
 * NOTHING. There is no third outcome and no best-effort: a span that cannot be
 * placed exactly is a card the reader has to settle by hand, which is what the
 * needs-manual state on the card says.
 */
export function applyCard(file, card, { dryRun = false } = {}) {
  if (!card || card.state === 'unreadable') {
    return { ok: false, reason: 'unreadable', detail: 'this block was never readable as a suggestion' };
  }
  if (!card.current) {
    return { ok: false, reason: 'unreadable', detail: 'this card carries no passage to replace' };
  }
  const read = readFile(file);
  if (!read.ok) return read;
  const at = resolveSpan(read.text, card.current);
  if (!at.ok) return at;
  const after = read.text.slice(0, at.start) + String(card.proposed ?? '') + read.text.slice(at.end);
  if (!dryRun) {
    try { fs.writeFileSync(file, after); }
    catch (e) { return { ok: false, reason: 'gone', detail: `the source file could not be written: ${String(e.message || e)}` }; }
  }
  return { ok: true, before: read.text, after, start: at.start, end: at.end };
}

/**
 * Accept a stack — a typo sweep's worth of cards — in DOCUMENT ORDER.
 *
 * Order is taken from where each card's passage stands in the file as it is
 * NOW, so the reader watching the post rebuild sees the changes arrive top to
 * bottom. Each card is then applied against a freshly read file, because every
 * accepted edit moves every offset after it.
 *
 * IT STOPS AT THE FIRST REFUSAL, LOUDLY. A sweep where card six cannot be
 * placed is a sweep whose author has lost track of the document, and grinding
 * on through cards seven to ten would be applying edits nobody has any reason
 * to trust. What already landed stays landed — it landed correctly — and the
 * answer names the card that stopped it and everything that was left.
 *
 * Cards that cannot be placed AT ALL (drift, ambiguity) have no position in
 * the document, so they sort last in the order they were written: a sweep is
 * not derailed halfway by a card that never had an address, and the refusal is
 * still reported.
 */
export function applyStack(file, cards) {
  const list = (cards || []).filter(c => c && c.state === 'open');
  const read = readFile(file);
  if (!read.ok) return { applied: [], stopped: { id: (list[0] || {}).id || '', ...read }, left: list.map(c => c.id) };
  const placed = list.map((card, i) => {
    const at = resolveSpan(read.text, card.current);
    return { card, i, at: at.ok ? at.start : Number.MAX_SAFE_INTEGER };
  }).sort((a, b) => (a.at - b.at) || (a.i - b.i));

  const applied = [];
  let stopped = null;
  const left = [];
  for (const row of placed) {
    if (stopped) { left.push(row.card.id); continue; }
    const r = applyCard(file, row.card);
    if (r.ok) { applied.push(row.card.id); continue; }
    stopped = { id: row.card.id, reason: r.reason, detail: r.detail };
  }
  return { applied, stopped, left };
}

// ---- what the turn says ---------------------------------------------------

/**
 * The convention, taught to the bots on every blog-page turn.
 *
 * It rides EVERY turn, like the write rule beside it and for the same reason:
 * a resumed session's replayed history is uneven, a bridge restart drops it
 * whole, and the only thing a turn can rely on carrying is the turn. A model
 * never shown this block cannot use the convention, which is exactly the
 * safety property the idiom is built on.
 */
export function suggestBlock() {
  return 'HOW YOU CHANGE THIS POST: YOU DO NOT EDIT THE FILE. You PROPOSE, and the reader accepts '
    + 'or refuses. Every change you want to make to the markdown — a word, a sentence, a whole '
    + 'paragraph, the front matter — is written as a fenced block of its own:\n\n'
    + `    \`\`\`${SUGGEST_FENCE}\n`
    + '    current: <the passage exactly as it stands in the source file right now>\n'
    + '    proposed: <what it should say instead>\n'
    + '    why: <one line — what this fixes>\n'
    + '    ```\n\n'
    + 'READ the source file first and copy `current:` out of it verbatim, including its markdown. '
    + 'The passage must appear EXACTLY ONCE in the file: that is how the companion finds the place '
    + 'to change. If the wording you want to fix occurs more than once, widen it — take in the '
    + 'sentence before it, or the whole paragraph — until it is unique, and put the whole widened '
    + 'passage in both fields. Line breaks and the difference between straight and curly quotes do '
    + 'not matter; every other character does.\n'
    + `To CUT a passage, write \`proposed: ${DELETE_MARK}\` — an empty \`proposed:\` is refused rather `
    + 'than guessed at.\n'
    + 'WRITE AS MANY BLOCKS AS YOU HAVE CHANGES. A spell-check of a whole post is one reply with a '
    + 'stack of small blocks in it, each with its own `current:`; they are not alternatives, they '
    + 'are the answer. Put your ordinary prose around them — say what you found, briefly — and let '
    + 'each block carry the change itself. Do not paste the new wording into your prose as well: '
    + 'the reader is shown the before-and-after of every block as a diff.\n'
    + 'NOTHING HAPPENS TO THE FILE UNTIL THE READER ACCEPTS. You will be told next turn what they '
    + 'accepted and what they turned down. Never say a change has been made — it has not; you '
    + 'proposed it.\n';
}

/**
 * What became of the last stack, told to the bot on its next turn here.
 *
 * The same sentence-on-the-next-turn rule `store.strikeRefusedBlock` and
 * `questions.reviseRefusedBlock` follow, and for the same reason: a proposal
 * that vanishes silently is indistinguishable from one that landed, and a bot
 * with no news assumes the file changed and tells the reader so.
 */
export function verdictBlock(cards) {
  const list = (cards || []).filter(c => c && c.state && c.state !== 'open');
  if (!list.length) return '';
  const line = c => {
    const what = c.current ? `“${clip(c.current, 90)}${String(c.current).length > 90 ? '…' : ''}”`
      : 'an unreadable block';
    if (c.state === 'applied') return `  · ACCEPTED — ${what} now reads as you proposed.`;
    if (c.state === 'rejected') return `  · TURNED DOWN — ${what}. The file is unchanged. Do not propose it again unless the reader asks.`;
    if (c.state === 'unreadable') return `  · NOT READABLE — ${c.error || 'the block could not be parsed'}. Nothing was shown to the reader but the fault.`;
    return `  · COULD NOT BE APPLIED — ${what}: ${c.detail || 'the passage could not be placed in the source'}. `
      + 'Re-read the file and propose it again with a passage that occurs exactly once.';
  };
  return '\nWHAT THE READER DID WITH YOUR LAST SUGGESTIONS:\n'
    + list.map(line).join('\n') + '\n';
}
