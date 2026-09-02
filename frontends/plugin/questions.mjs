// THE QUESTION VAULT — what the reader chose to remember, and when to ask it.
//
// Discuss is where things are read and argued about. Almost nothing of that
// survives the week: the passage was understood at the time, the bot's
// explanation was good at the time, and six months later the reader is looking
// at the same paragraph for the first time again. A question is the smallest
// object that fights that, and the whole feature is that MAKING one costs a
// click. There is no card editor, no review queue, no "is this a good card?"
// step — a bot writes the card, it lands in the vault, and a wrong answer in
// the quiz is where a bad card gets caught (there is a flag for exactly that).
//
// This file is the record and the arithmetic. It knows nothing about HTTP, the
// bridge or the drawer: cards in, cards out, and the SM-2 clock in between.
// One file, `<ROOT>/.botference/plugin/questions.json`, written atomically
// (tmp + rename) exactly like every other record in this companion.
//
// ── WHY ONE FILE AND NOT A DIRECTORY ──────────────────────────────────────
// A page is a directory of files because a page holds a snapshot, runs,
// figures — things measured in megabytes. A card is four short strings. Ten
// thousand of them is a couple of megabytes read once per quiz session and
// once per capture, and one file is one atomic write with no half-written
// vault possible. Pages went the other way because pages are written
// CONCURRENTLY by several lanes; the vault is written by the reader, one
// gesture at a time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIR, unwrapLine, fenceRe } from './store.mjs';

export const VAULT_FILE = path.join(DIR, 'questions.json');

const nowIso = () => new Date().toISOString();
export const newCardId = () => `q-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---- the record ----------------------------------------------------------
//
// {
//   "version": 1,
//   "cards": [{
//     "id": "q-1756...-a1b2",
//     "state": "pending" | "live" | "failed" | "flagged",
//     "kind":  "mcq" | "truefalse" | "cloze",
//     "question": "…", "options": ["…"], "answer": 0,
//     "why": "one or two sentences", "difficulty": 1|2|3,
//     "source": { url, page_key, title, site, quote, thread_id, page, projects[] },
//     "created_at": "ISO", "settled_at": "ISO", "model": "claude"|"codex",
//     "error": "…",                       // failed only
//     "flag": { "at": "ISO", "note": "…" },  // flagged only
//     "sched": { due, interval, ease, reps, lapses, last, last_grade, seen }
//   }]
// }
//
// A card is born PENDING — the row exists before the bot has written anything,
// which is the only way a generation that never comes back can be VISIBLE
// rather than silently absent. It settles into `live` or `failed`.
export const CARD_STATES = ['pending', 'live', 'failed', 'flagged'];
export const CARD_KINDS = ['mcq', 'truefalse', 'cloze'];

export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 5;
export const QUESTION_MAX = 400;
export const OPTION_MAX = 200;
export const WHY_MAX = 600;
export const QUOTE_MAX = 1200;

export function readVault() {
  const v = readJson(VAULT_FILE, null);
  if (!v || !Array.isArray(v.cards)) return { version: 1, cards: [] };
  return { version: 1, cards: v.cards.filter(c => c && c.id) };
}
export const saveVault = v => { writeJson(VAULT_FILE, { version: 1, cards: v.cards || [] }); return v; };
export const findCard = (v, id) => (v.cards || []).find(c => c.id === String(id || '')) || null;

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// ---- SM-2 ---------------------------------------------------------------
//
// SuperMemo 2, the algorithm Anki has run on for twenty years, with the one
// simplification this product forces: THE GRADE IS BINARY. The reader taps an
// option and it is right or it is wrong; there is no "hard/good/easy" self-
// assessment, because self-assessment is the step that makes review feel like
// admin and the reader said plainly they do not want to grade themselves.
//
// So the two SM-2 qualities that a binary answer honestly maps to:
//
//   right → q = 4   ("good": correct after some thought). Interval grows,
//                    ease is left where it is — q=4 is the fixed point of
//                    SM-2's ease update, which is exactly the right meaning
//                    for "you knew it".
//   wrong → q = 2   ("again"). Reps reset, the interval collapses, the ease
//                    takes SM-2's own penalty (−0.32) and the card is due NOW
//                    — which is what puts it back inside the same session.
//
// Everything else is SM-2 unaltered: 1 day, then 6 days, then interval × ease,
// with ease floored at 1.3 so a card the reader keeps failing cannot spiral
// into being asked forever.
export const EASE_START = 2.5;
export const EASE_MIN = 1.3;
export const FIRST_INTERVAL = 1;    // days, after the first correct answer
export const SECOND_INTERVAL = 6;   // days, after the second
export const GRADE_RIGHT = 4;
export const GRADE_WRONG = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export const newSchedule = (at = nowIso()) => ({
  due: at, interval: 0, ease: EASE_START, reps: 0, lapses: 0,
  last: null, last_grade: null, seen: 0,
});

// The ease update, verbatim SM-2: EF' = EF + (0.1 − (5−q)(0.08 + (5−q)·0.02)).
export function easeAfter(ease, q) {
  const e = Number(ease) || EASE_START;
  const d = 5 - q;
  return Math.max(EASE_MIN, Math.round((e + (0.1 - d * (0.08 + d * 0.02))) * 1000) / 1000);
}

// Grade one card. `correct` is the whole of the reader's input; `now` is
// injectable so the tests can walk a card through six months in six lines.
export function grade(card, correct, now = Date.now()) {
  const s = card.sched && typeof card.sched === 'object' ? card.sched : newSchedule();
  const q = correct ? GRADE_RIGHT : GRADE_WRONG;
  s.ease = easeAfter(s.ease, q);
  s.seen = (Number(s.seen) || 0) + 1;
  s.last = new Date(now).toISOString();
  s.last_grade = correct ? 'right' : 'wrong';
  if (correct) {
    s.reps = (Number(s.reps) || 0) + 1;
    s.interval = s.reps === 1 ? FIRST_INTERVAL
      : s.reps === 2 ? SECOND_INTERVAL
        : Math.max(1, Math.round((Number(s.interval) || 1) * s.ease));
    s.due = new Date(now + s.interval * DAY_MS).toISOString();
  } else {
    // A lapse is a reset, not a nudge: reps to zero, interval to nothing, due
    // this instant — which is what the quiz session reads as "ask me again
    // before you let me go".
    s.reps = 0;
    s.interval = 0;
    s.lapses = (Number(s.lapses) || 0) + 1;
    s.due = new Date(now).toISOString();
  }
  card.sched = s;
  return card;
}

// ---- what is due, and in what order -------------------------------------
//
// Overdue longest first. That is the whole rule and it is the right one: a
// card that came due three weeks ago is closer to being forgotten than one
// that came due this morning, and the reader who reviews irregularly (which is
// every reader) should meet the oldest debt first.
//
// The two tiebreaks matter only inside one second: a card the reader has
// LAPSED on goes ahead of one they never have (it is the weaker memory), and
// after that the older card goes first, so a queue is stable across reloads.
export const isDue = (card, now = Date.now()) =>
  card.state === 'live' && Date.parse(card.sched && card.sched.due || 0) <= now;

export function dueCards(vault, { now = Date.now(), project = '', key = '', tag = '', limit = 0 } = {}) {
  const wanted = (vault.cards || []).filter(c => isDue(c, now) && inScope(c, { project, key, tag }));
  wanted.sort((a, b) => {
    const d = Date.parse(a.sched.due) - Date.parse(b.sched.due);
    if (d) return d;
    const l = (Number(b.sched.lapses) || 0) - (Number(a.sched.lapses) || 0);
    if (l) return l;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });
  return limit > 0 ? wanted.slice(0, limit) : wanted;
}

// A card born on a page filed in a council project carries that project's id,
// so "quiz me on Applied Probability" is a filter and not a second vault.
export function inScope(card, { project = '', key = '', tag = '' } = {}) {
  const src = card.source || {};
  if (key && src.page_key !== key) return false;
  if (project && !(src.projects || []).includes(project)) return false;
  if (tag && !(src.tags || []).some(t => t.toLowerCase() === tag.toLowerCase())) return false;
  return true;
}

export function counts(vault, scope = {}, now = Date.now()) {
  const cards = (vault.cards || []).filter(c => inScope(c, scope));
  return {
    total: cards.length,
    live: cards.filter(c => c.state === 'live').length,
    due: cards.filter(c => isDue(c, now)).length,
    pending: cards.filter(c => c.state === 'pending').length,
    failed: cards.filter(c => c.state === 'failed').length,
    flagged: cards.filter(c => c.state === 'flagged').length,
  };
}

// ONE BANK, LOOKED AT FROM ANGLES. The quiz's filter rail is drawn from the
// cards themselves — the council projects their pages are filed under, and the
// reader's own tags on those pages — so there is nothing to maintain and no
// deck to put anything in. A chip carries three numbers because the third is
// the one worth having: how many of that topic's cards the reader has got
// WRONG. That is where they are weak, and it costs a count.
export function facets(vault, now = Date.now()) {
  const walk = field => {
    const seen = new Map();
    for (const c of vault.cards || []) {
      for (const name of (c.source && c.source[field]) || []) {
        const k = String(name);
        if (!seen.has(k)) seen.set(k, { id: k, count: 0, due: 0, lapses: 0 });
        const row = seen.get(k);
        row.count += 1;
        if (isDue(c, now)) row.due += 1;
        row.lapses += Number(c.sched && c.sched.lapses) || 0;
      }
    }
    return [...seen.values()].sort((a, b) => b.due - a.due || b.count - a.count || a.id.localeCompare(b.id));
  };
  return { projects: walk('projects'), tags: walk('tags') };
}

// WHICH THREADS ON ONE PAGE HAVE MINTED A MEMORY — the other direction of the
// quiz's own trace link, and the drawer's whole input for saying so on a card.
//
// One pass over the bank for one page, returned as `{ thread_id: n }`, because
// the drawer already asks this endpoint for its due count and a second request
// per thread would be a request per card on the screen. A FAILED row is not a
// memory (nothing was written, and the drawer says so where the click was
// made); a pending one is about to be, and counts — the reader clicked, and a
// thread that says nothing until a bot comes back is exactly the silence the
// pending row exists to prevent.
export function threadCounts(vault, key) {
  const want = String(key || '');
  const out = {};
  if (!want) return out;
  for (const c of vault.cards || []) {
    const s = c.source || {};
    if (s.page_key !== want || !s.thread_id || c.state === 'failed') continue;
    out[s.thread_id] = (out[s.thread_id] || 0) + 1;
  }
  return out;
}

// ---- capture -------------------------------------------------------------

export function addPending(vault, { source, model = 'claude' }) {
  const at = nowIso();
  const card = {
    id: newCardId(),
    state: 'pending',
    question: '', options: [], answer: 0, why: '', kind: 'mcq', difficulty: 2,
    source: {
      url: String((source && source.url) || ''),
      page_key: String((source && source.page_key) || ''),
      title: clip(source && source.title, 200),
      site: String((source && source.site) || ''),
      quote: clip(source && source.quote, QUOTE_MAX),
      thread_id: (source && source.thread_id) || null,
      page: Number((source && source.page) || 0) || 0,
      // PROVENANCE, and the whole of the filing story. There are no decks and
      // no per-project vaults: one bank, and a card remembers where it came
      // from — its page, the council projects that page is filed under, and
      // the reader's own tags on it. The quiz's filter chips are drawn from
      // these and nothing else, so filtering is a way of LOOKING at the bank,
      // never a second act of filing.
      projects: Array.isArray(source && source.projects) ? source.projects.map(String) : [],
      tags: Array.isArray(source && source.tags) ? source.tags.map(String) : [],
    },
    ...(source && source.from_msg ? { from_msg: String(source.from_msg) } : {}),
    ...(source && source.hint ? { hint: clip(source.hint, 300) } : {}),
    created_at: at,
    model: String(model || 'claude'),
    sched: newSchedule(at),
  };
  vault.cards.push(card);
  return card;
}

// The bot answered. Either the block parses — in which case the card goes live
// with the schedule it was born with, so it is due the moment it exists — or it
// does not, and the card is FAILED WITH THE REASON ON IT. A generation that
// went wrong is a row the reader can see and delete, never a silence.
//
// ONLY A PENDING ROW IS SETTLED. A generation is an answer to a click made
// minutes ago, and in between the reader may have revised the card by hand
// (reviseCard below) — at which point the late arrival is a stale draft of
// something that has already been rewritten, and writing it in would undo the
// correction in front of them. A card that is no longer pending is left alone.
export function settle(vault, id, text, model) {
  const card = findCard(vault, id);
  if (!card || card.state !== 'pending') return null;
  if (model) card.model = String(model).toLowerCase().replace(/[^a-z]/g, '') || card.model;
  card.settled_at = nowIso();
  const parsed = parseCardBlock(text);
  if (!parsed.ok) {
    card.state = 'failed';
    card.error = parsed.error;
    return card;
  }
  Object.assign(card, {
    state: 'live',
    kind: parsed.card.kind,
    question: parsed.card.question,
    options: parsed.card.options,
    answer: parsed.card.answer,
    why: parsed.card.why,
    difficulty: parsed.card.difficulty,
  });
  delete card.error;
  return card;
}

export function failCard(vault, id, error) {
  const card = findCard(vault, id);
  // …and the same guard, for the same reason: a turn that came back empty must
  // not be able to fail a card the reader has since put right.
  if (!card || card.state !== 'pending') return null;
  card.state = 'failed';
  card.error = clip(error, 300) || 'the question could not be written';
  card.settled_at = nowIso();
  return card;
}

// "This card seems wrong." It leaves the rotation immediately — a card the
// reader does not trust must not go on being asked — and keeps everything it
// had, because phase 2 hands it back to the bots to revise.
export function flagCard(vault, id, note) {
  const card = findCard(vault, id);
  if (!card) return null;
  card.state = 'flagged';
  card.flag = { at: nowIso(), note: clip(note, 300) };
  return card;
}
export function deleteCard(vault, id) {
  const i = (vault.cards || []).findIndex(c => c.id === String(id || ''));
  if (i < 0) return false;
  vault.cards.splice(i, 1);
  return true;
}

// ---- REVISING A CARD THAT IS ALREADY IN THE BANK -------------------------
//
// Until this existed a bot could only MINT. The reader asked one to rewrite a
// question it had just made — the wording was off — and it did the only thing
// the conventions gave it: it wrote another card. Two live cards from one
// discussion, both asking the same thing, and no route anywhere in the product
// to change the first. It is the strikeout's failure exactly (a note that came
// out wrong with no way to correct it), and it gets the strikeout's answer:
// a confirmed suggestion UPDATES what is already there.
//
// WHAT CHANGES: the question, the options, the correct answer, the why, the
// kind, the difficulty. That is the whole of what a bot writes.
//
// WHAT SURVIVES, and the important half:
//
//   · THE SCHEDULE. `sched` is not touched — not the ease the reader has
//     earned on this idea over four months, not the lapses, not the due date.
//     The card is a handle on a CONCEPT and the reader's history with that
//     concept is the valuable thing in this file; the wording is the cheap
//     part. Resetting SM-2 because a sentence was rephrased would throw away
//     the only data here that took time to make, and would punish correcting
//     a card — which is the last thing this should do.
//   · the provenance (`source`), so the trace links, the page, the projects
//     and the tags all still point where they did;
//   · `created_at` and `model` — when this memory was made, and who wrote the
//     card that made it. `updated_at` and `revised_by` record the rewrite
//     beside them rather than over them (`store.appendMsg`'s `edited` idiom).
//
// A FLAGGED card comes back to life. "Seems wrong" parks a card waiting to be
// rewritten and this is the rewrite; leaving it parked afterwards would make
// the fix invisible. A FAILED one goes live too — a row that says "the reply
// had no block in it" is exactly the row a second try should repair.
export function reviseCard(vault, id, next, { model = '', from_msg = '' } = {}) {
  const card = findCard(vault, id);
  if (!card || !next) return null;
  Object.assign(card, {
    state: 'live',
    kind: next.kind,
    question: next.question,
    options: next.options,
    answer: next.answer,
    why: next.why,
    difficulty: next.difficulty,
    updated_at: nowIso(),
    revisions: (Number(card.revisions) || 0) + 1,
  });
  const who = String(model || '').toLowerCase().replace(/[^a-z]/g, '');
  if (who) card.revised_by = who;
  if (from_msg) card.revised_from = String(from_msg);
  delete card.error;
  delete card.flag;
  return card;
}

// WHAT THIS DISCUSSION HAS ALREADY PUT IN THE BANK — the list the offer block
// shows a bot so it can name one instead of writing another. Pending rows are
// left out (there is nothing written yet to revise), and so is anything from
// another page: a card is revised from the discussion that made it.
export function mintedIn(vault, thread_id, key = '') {
  const want = String(thread_id || '');
  if (!want) return [];
  return (vault.cards || [])
    .filter(c => c && c.state !== 'pending' && (c.source || {}).thread_id === want
      && (!key || c.source.page_key === key))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

// ---- "these two look like the same question" -----------------------------
//
// A HINT, and deliberately not a dedupe engine. The reader can end up with two
// cards about one idea in the ordinary course of using this — a bot minting
// instead of revising, a second click on a passage they had already filed —
// and the place they NOTICE is the place they are asked both of them. So the
// quiz and the Memorize tab say "this looks like a duplicate of …" beside the
// card, with one tap to drop whichever they do not want, and that is all it
// does: nothing merges, nothing is discarded automatically, and a hint the
// reader ignores costs them one quiet line.
//
// THE SIGNAL IS CHEAP, on purpose. Two LIVE cards look like the same question
// when they are from the same page and either
//
//   · they came out of the SAME DISCUSSION (`thread_id`) — the case that
//     actually happened, and the strongest evidence available: one argument,
//     one point, two cards; or
//   · their question texts overlap by DUP_SIM of their words (Jaccard over
//     words of 3+ letters, which is stable against "the"/"a"/word order).
//
// There is no embedding, no model call and no index: it is one pass over the
// bank per card drawn, which for a vault of thousands is nothing.
export const DUP_SIM = 0.7;
const bagOf = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  .trim().split(' ').filter(w => w.length > 2));
export function textOverlap(a, b) {
  const A = bagOf(a);
  const B = bagOf(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both += 1;
  return both / (A.size + B.size - both);
}

// The reader's veto, and the reason the hint is not a nag: "they are different"
// pins the pair on BOTH cards and it is never suggested again.
export function keepBoth(vault, id, otherId) {
  const a = findCard(vault, id);
  const b = findCard(vault, otherId);
  if (!a || !b || a === b) return null;
  for (const [x, y] of [[a, b], [b, a]]) {
    const kept = Array.isArray(x.kept_with) ? x.kept_with : [];
    if (!kept.includes(y.id)) kept.push(y.id);
    x.kept_with = kept;
  }
  return a;
}

// The nearest live sibling that looks like the same question, or null. The
// strongest evidence wins (a shared discussion beats a text overlap), then the
// closest wording, then the older card — so the hint is stable across reloads.
const beats = (row, best) => {
  const a = row.why === 'thread';
  const b = best.why === 'thread';
  if (a !== b) return a;
  if (row.score !== best.score) return row.score > best.score;
  return String(row.card.created_at || '') < String(best.card.created_at || '');
};
export function duplicateOf(vault, card) {
  if (!card || card.state !== 'live') return null;
  const src = card.source || {};
  const kept = new Set(Array.isArray(card.kept_with) ? card.kept_with : []);
  let best = null;
  for (const other of vault.cards || []) {
    if (!other || other.id === card.id || other.state !== 'live') continue;
    if (kept.has(other.id)) continue;
    const s = other.source || {};
    if (!src.page_key || s.page_key !== src.page_key) continue;
    const thread = !!src.thread_id && s.thread_id === src.thread_id;
    const score = textOverlap(card.question, other.question);
    if (!thread && score < DUP_SIM) continue;
    const row = { card: other, why: thread ? 'thread' : 'text', score };
    if (!best || beats(row, best)) best = row;
  }
  return best;
}

// ---- the block a bot writes, and reading it back ------------------------
//
// The convention is the `strike:` / `file-in:` idiom grown up: machinery in a
// reply, lifted off it by the companion. Those two are single lines because
// they carry one fact. A card carries seven, so it is a FENCED BLOCK — fenced
// for exactly the reason those two are single-line: a boundary a model cannot
// half-produce and a parser cannot half-read.
//
//     ```question
//     Q: What does the law of large numbers actually promise?
//     A) the sample mean converges to the population mean as n grows
//     B) the sample mean equals the population mean for any n
//     C) the sample variance goes to zero
//     D) the sample mean is normally distributed
//     correct: A
//     why: It is an asymptotic statement about convergence, not a claim
//     about any particular sample.
//     kind: mcq
//     difficulty: 2
//     ```
//
// THE LAST BLOCK IN THE REPLY WINS, like every other convention here: a model
// that shows its working and then writes the card has written one card, and
// the one it meant is the last one. `why:` may run over several lines; every
// other field is one line.
const FENCE_RE = fenceRe('question');
const OPT_RE = /^\s*([A-E])[).:]\s*(.+)$/;
const TRUE_FALSE = ['True', 'False'];

export function parseCardBlock(text) {
  const src = String(text == null ? '' : text);
  let body = '';
  for (const m of src.matchAll(FENCE_RE)) body = m[1];
  if (!body) return { ok: false, error: 'no ```question block in the reply' };

  const lines = body.split(/\r?\n/);
  const fields = { question: [], options: [], correct: '', why: [], kind: '', difficulty: '', revises: '' };
  let where = '';                     // which multi-line field is still open
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() && where !== 'why') { where = ''; continue; }
    const kv = /^\s*(Q|question|correct|answer|why|because|kind|type|difficulty|revises|revise|updates)\s*:\s*(.*)$/i.exec(line);
    const opt = OPT_RE.exec(line);
    // an option letter beats a key: "A) answer: 3" is an option, not a field
    if (opt && !/^\s*(Q|question)\s*:/i.test(line)) {
      fields.options.push(opt[2].trim());
      where = '';
      continue;
    }
    if (kv) {
      const k = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (k === 'q' || k === 'question') { fields.question = [v]; where = 'question'; }
      else if (k === 'correct' || k === 'answer') { fields.correct = v; where = ''; }
      else if (k === 'why' || k === 'because') { fields.why = [v]; where = 'why'; }
      else if (k === 'kind' || k === 'type') { fields.kind = v.toLowerCase(); where = ''; }
      // WHICH CARD THIS BLOCK REWRITES, if any. A line of the block rather
      // than a line of the reply, because it belongs to the card and not to
      // the conversation — and named here so that it also CLOSES a running
      // `why:`, whichever order a model writes the fields in.
      else if (k === 'revises' || k === 'revise' || k === 'updates') {
        fields.revises = v.trim().replace(/^[`"']|[`"'.,;]+$/g, '');
        where = '';
      }
      else { fields.difficulty = v; where = ''; }
      continue;
    }
    if (where === 'question') fields.question.push(line.trim());
    else if (where === 'why') fields.why.push(line.trim());
  }

  const question = clip(fields.question.join(' '), QUESTION_MAX);
  if (!question) return { ok: false, error: 'the block has no question' };
  let options = fields.options.map(o => clip(o, OPTION_MAX)).filter(Boolean);
  let kind = CARD_KINDS.includes(fields.kind) ? fields.kind : '';
  // A true/false card may be written without its two options spelled out —
  // that is the format's whole economy — so they are supplied here rather than
  // refused. Nothing else is ever invented.
  if (!options.length && (kind === 'truefalse' || /^(true|false)$/i.test(fields.correct.trim()))) {
    options = [...TRUE_FALSE];
    kind = 'truefalse';
  }
  if (options.length < OPTIONS_MIN) {
    return { ok: false, error: `a card needs at least ${OPTIONS_MIN} options; the block had ${options.length}` };
  }
  options = options.slice(0, OPTIONS_MAX);
  if (new Set(options.map(o => o.toLowerCase())).size !== options.length) {
    return { ok: false, error: 'two of the options are the same' };
  }

  const answer = answerIndex(fields.correct, options);
  if (answer < 0) {
    return { ok: false, error: `the correct answer ("${clip(fields.correct, 40)}") is not one of the options` };
  }
  if (!kind) {
    kind = options.length === 2
      && options.every(o => TRUE_FALSE.some(t => t.toLowerCase() === o.toLowerCase()))
      ? 'truefalse'
      : (/_{3,}|\[\s*\.{2,}\s*\]|……/.test(question) ? 'cloze' : 'mcq');
  }
  const dRaw = parseInt(fields.difficulty, 10);
  const difficulty = Number.isFinite(dRaw) ? Math.min(3, Math.max(1, dRaw)) : 2;
  return { ok: true,
    card: { question, options, answer, kind, difficulty, why: clip(fields.why.join(' '), WHY_MAX) },
    revises: fields.revises };
}

// "A", "a)", "1", "True", or the option's own text — a model will write any of
// them and all five mean the same thing.
export function answerIndex(correct, options) {
  const c = String(correct || '').trim().replace(/[).:]+$/, '');
  if (!c) return -1;
  const letter = /^[A-Ea-e]$/.exec(c);
  if (letter) {
    const i = letter[0].toUpperCase().charCodeAt(0) - 65;
    return i < options.length ? i : -1;
  }
  const n = /^[1-9]$/.exec(c);
  if (n) {
    const i = Number(n[0]) - 1;
    return i < options.length ? i : -1;
  }
  const flat = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const exact = options.findIndex(o => flat(o) === flat(c));
  return exact;
}

// ---- the other way a card gets made -------------------------------------
//
// The reader is not the only one who can tell that something here is worth
// coming back to. A bot three exchanges into explaining conditional
// probability can SEE that the reader has not got it — they asked the same
// thing twice, in different words — and the reader, who is busy understanding
// it, is the last person likely to press a button about it.
//
// So a bot may OFFER. The convention is `strike:` / `file-in:` exactly, for
// the third time and deliberately: a line of its own, at the end of a reply,
// lifted off the words by the companion and drawn as a one-step confirm chip.
// The rules are the same three that make that idiom safe —
//
//   1. it is only ever an OFFER; nothing is filed until the reader clicks
//   2. the line is machinery, so it comes out of the prose
//   3. a bot that was never shown the convention cannot use it
//
// — and the per-MESSAGE lift is the same too, so claude offering and codex
// offering in one thread are two chips, each with its own wording.
export const QUESTION_MARK = 'question:';

export const questionOfferBlock = (minted = []) =>
  'If — and ONLY if — this exchange has shown a real gap in the reader\'s understanding of '
  + 'something worth remembering (they asked the same thing twice, or took away the opposite '
  + 'of what the passage says), you may END your reply with a line of its own reading '
  + `\`${QUESTION_MARK} <the one idea they should be able to recall>\`. The reader gets a `
  + 'button that files a revision question about it; you are not filing anything, and you are '
  + 'not writing the question here. Offer this RARELY — a reader who understood the answer '
  + 'does not need to be quizzed on it, and an offer on every turn is an offer nobody reads. '
  + 'Say nothing at all if there is no such gap.\n'
  + reviseOfferBlock(minted);

// …AND THE ONLY WAY TO CHANGE ONE THAT IS ALREADY FILED.
//
// This block rides a turn only where this discussion has actually minted
// something, because until then there is nothing to revise and the paragraph
// would be an invitation to invent a card id. When it does ride, it carries
// the ids, so a bot asked to "reword that question" has the one fact it needs
// and never has to guess.
//
// The sentence that matters most is the LAST one. A model that means to
// correct a card and writes a block without `revises:` files a SECOND card —
// which is the failure this whole amendment came out of — and the only defence
// against it is saying so plainly here. There is no way to infer the intent
// from a block that does not carry it: two questions about one passage are a
// perfectly ordinary thing to want.
export const REVISE_KEY = 'revises:';
export const QUESTION_FENCE = 'question';
export const reviseOfferBlock = (minted = []) => {
  const rows = (minted || []).filter(c => c && c.id);
  if (!rows.length) return '';
  return '\nQUESTIONS THIS DISCUSSION HAS ALREADY FILED:\n'
    + rows.map(c => `  · ${c.id} — “${clip(c.question, 90)}${
      String(c.question || '').length > 90 ? '…' : ''}”${
      c.state === 'flagged' ? ' (the reader flagged this one as wrong)' : ''}`).join('\n')
    + '\n\nTo CHANGE one of them — the reader says it is wrong, or you can see that it is — '
    + `write the WHOLE corrected card as a \`\`\`${QUESTION_FENCE} block whose first line is `
    + `\`${REVISE_KEY} <the id above>\`:\n\n`
    + `    \`\`\`${QUESTION_FENCE}\n`
    + `    ${REVISE_KEY} ${rows[0].id}\n`
    + '    Q: <the corrected question>\n'
    + '    A) <option>\n'
    + '    B) <option>\n'
    + '    correct: A\n'
    + '    why: <one or two sentences>\n'
    + '    ```\n\n'
    + 'The reader gets a button that rewrites THAT card where it stands, keeping everything '
    + 'they have earned on it — how well they know it, and when it next comes back. '
    + `A \`\`\`${QUESTION_FENCE} block WITHOUT a \`${REVISE_KEY}\` line does not correct anything: `
    + 'it asks for a NEW, SECOND card beside the old one. So if you mean to change one of the '
    + `questions above, the \`${REVISE_KEY}\` line is not optional.\n`;
};

// The reader never saw a button, and the bot has to be told — the same
// sentence-on-the-next-turn `store.strikeRefusedBlock` writes, and for the same
// reason: a suggestion that vanishes silently is indistinguishable from one
// that landed, and a bot with no news assumes the card was fixed.
export const reviseRefusedBlock = (fault, id, minted = []) =>
  'YOUR LAST `' + REVISE_KEY + '` BLOCK WAS REFUSED — the reader never saw a button for it, and '
  + `NOTHING in their vault was changed. ${fault === 'elsewhere'
    ? `The card \`${id}\` exists but belongs to a different page, and a card is only ever `
      + 'revised from the discussion it was made in.'
    : fault === 'unparsed'
      ? `The block naming \`${id}\` could not be read as a card.`
      : `There is no card \`${id}\` in the vault — the id was wrong or invented.`} `
  + (minted && minted.length
    ? `The questions this discussion filed are: ${minted.map(c => c.id).join(', ')}. `
      + 'If you still mean to correct one, write the whole card again against one of those ids.\n'
    : 'This discussion has not filed any questions, so there is nothing here to revise.\n');

// The block, back out of a reply. The LAST fenced block that names a card is
// the one that counts (same rule as every other convention here), and one that
// names no card is not a revision at all — it is a bot writing a card into the
// conversation, which nothing lifts.
export function parseCardRevision(text) {
  const src = String(text == null ? '' : text);
  let hit = null;
  for (const m of src.matchAll(FENCE_RE)) {
    const parsed = parseCardBlock(m[0]);
    const id = parsed.ok ? parsed.revises : revisesIn(m[1]);
    if (!id) continue;
    hit = parsed.ok
      ? { id, block: m[0], ok: true, card: parsed.card }
      : { id, block: m[0], ok: false, error: parsed.error };
  }
  return hit;
}
// …read straight off the body too, so a block that will not PARSE is still
// recognised as an attempted revision and refused out loud rather than left
// sitting in the reply as prose.
const REVISES_RE = /^\s*(?:revises|revise|updates)\s*:\s*(\S+)\s*$/im;
const revisesIn = body => {
  const m = REVISES_RE.exec(String(body || ''));
  return m ? m[1].replace(/^[`"']|[`"'.,;]+$/g, '') : '';
};

// A line of its own, the LAST one counts, and a reason is REQUIRED: a bare
// `question:` is a model echoing the convention back rather than concluding
// anything about the reader.
export function parseQuestionSuggestion(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  let hit = null;
  const qre = new RegExp(`^${QUESTION_MARK}\\s*(.+)$`, 'i');
  for (const raw of lines) {
    // `store.unwrapLine`, the one spelling of "peel the model's markdown off
    // this line". This used to be a private copy that stripped `` ` ``, `*` and
    // `_` from the WHOLE line, so a reason emphasising a term or naming a
    // symbol in backticks arrived at the card with the markup silently gone.
    const m = qre.exec(unwrapLine(raw));
    if (!m) continue;
    const why = m[1].trim();
    if (why) hit = { line: raw, why: clip(why, 300) };
  }
  return hit;
}

// ---- a quiz session ------------------------------------------------------
//
// The ORDER of one sitting, and the only thing the vault's schedule cannot
// express: a card answered wrong must be seen again BEFORE the reader stands
// up, not merely "soon". SM-2 makes it due this instant, which is necessary
// and not sufficient — the reader would have to start another session to meet
// it. So a session is a list, and a wrong answer puts the card back into that
// list a few places down.
//
// Memory only, and deliberately: the schedule is on disk, so a restart costs
// the ORDER of the current sitting and nothing else. A session that is
// interrupted simply becomes a new one, over the same due cards.
export const SESSION_MAX = 20;      // cards drawn into one sitting
export const REQUEUE_GAP = 3;       // how far down a wrong card comes back

export function startSession(vault, scope = {}, now = Date.now()) {
  return {
    at: now,
    scope,
    queue: dueCards(vault, { ...scope, now, limit: SESSION_MAX }).map(c => c.id),
    i: 0,
    asked: 0, right: 0, wrong: 0,
    last: null,       // {id, choice, correct} — the reveal the next GET paints
  };
}

export const sessionCard = (vault, s) => {
  while (s && s.i < s.queue.length) {
    const card = findCard(vault, s.queue[s.i]);
    // a card deleted or flagged out from under a live session is skipped, not
    // an error: the session is an order, not a lock
    if (card && card.state === 'live') return card;
    s.i += 1;
  }
  return null;
};

// Wrong: the card comes back REQUEUE_GAP places later (or at the end, on a
// short queue — which is how a two-card session still asks it again).
export function advance(s, id, correct) {
  s.asked += 1;
  if (correct) s.right += 1;
  else {
    s.wrong += 1;
    const at = Math.min(s.i + 1 + REQUEUE_GAP, s.queue.length);
    s.queue.splice(at, 0, id);
  }
  s.i += 1;
  return s;
}
