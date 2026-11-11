// apply.mjs — deterministic Apply / Commit / Revert for accepted suggestion cards.
// Owns state/apply.json (the uncommitted-round ledger). Source edits are
// unique-span replacements only: current_text must match exactly once in
// source_file; drifted or ambiguous spans are flagged needs_manual_resolution,
// never guessed. A card's bib_entries land atomically with its span edit.
// Revert restores the exact pre-apply tree via git checkout from a stash-create
// snapshot, so a file's pre-existing uncommitted edits survive the round trip.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
// whitespace-tolerant span matching, shared with the browser (review.js)
import SpanMatch from './assets/span-match.js';
const { findSpans } = SpanMatch;
// notebooks: spans are matched against the text projection, edits land in one cell
import { notebookText, editNotebook } from './notebook.mjs';
// the one list of card modes and the moves between them, shared with the page
import CardModes from './assets/card-modes.js';
const { CARD_MODES, DECISION_OF_MODE, canMove } = CardModes;

// a hung git must never freeze the review server: plumbing gets a short leash
export const GIT_TIMEOUT_MS = 30000;

// ---- state files: a missing file is not a broken one ------------------------
// Every JSON record this engine keeps is read into exactly one of three
// results, and only `missing` may be quietly treated as empty. `unreadable`
// (bad JSON, no permission) is never read as empty and then written over —
// the write is refused and the person is told which file to fix. Mirrors
// frontends/plugin/fsjson.mjs; kept here because each paper carries its own
// copy of this folder and nothing in it may import from outside it.
export const JSON_FILE_STATES = Object.freeze(['missing', 'ok', 'unreadable']);
export function readJsonState(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'missing', value: undefined, error: null };
    return { state: 'unreadable', value: undefined, error: e };
  }
  try { return { state: 'ok', value: JSON.parse(text), error: null }; } catch (e) {
    return { state: 'unreadable', value: undefined, error: e };
  }
}
// temp file beside the target, then rename: a reader sees the old file or the
// new one, never half of one. An existing file keeps its permission bits.
export function writeFileAtomic(file, data, opts = {}) {
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  let mode = opts.mode;
  if (mode == null) { try { mode = fs.statSync(file).mode & 0o7777; } catch { } }
  try {
    fs.writeFileSync(tmp, data, mode == null ? undefined : { mode });
    if (mode != null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { }
    throw e;
  }
}
export const writeJsonAtomic = (file, value, opts) =>
  writeFileAtomic(file, JSON.stringify(value, null, 1), opts);
// the plain sentence a person sees when a record cannot be read
export const unreadableMessage = (rel, what) =>
  `${what} (${rel}) could not be read, so nothing was changed. Fix or move that file, then try again.`;
// a child process that ran out of time, said in words
export function execFailure(e, what, ms) {
  if (e && (e.code === 'ETIMEDOUT' || (e.signal === 'SIGTERM' && e.status == null))) {
    return `${what} took longer than ${Math.round(ms / 1000)} seconds and was stopped`;
  }
  return `${what} failed: ${String((e && (e.stderr || e.message)) || e).trim().slice(0, 300)}`;
}

// ---- the record's format number ---------------------------------------------
// state/apply.json carries `format`. Bump LEDGER_FORMAT whenever its shape
// changes. Each paper keeps its own copy of this engine, so an older copy can
// meet a record a newer copy wrote: it must refuse that record out loud and
// never read it as "nothing applied" or write over it. Records from before
// the number existed (no `format`) are format 1 or the older {applied,
// flagged} maps, and are read as before.
export const LEDGER_FORMAT = 2;
export const tooNewMessage = rel =>
  `This paper's review software is older than its record of applied changes (${rel}), so nothing was changed. `
  + 'In the hub, turn this paper off and then on again to update it.';
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const LEDGER_KEYS = ['format', 'round', 'cards', 'applied', 'flagged'];
// null when this engine can read `raw`; otherwise why not (for the log)
export function ledgerProblem(raw) {
  if (!isMap(raw)) return 'not a JSON object';
  if ('format' in raw) {
    if (!Number.isInteger(raw.format) || raw.format < 1) return `format ${JSON.stringify(raw.format)} is not a format number`;
    if (raw.format > LEDGER_FORMAT) return `format ${raw.format} is newer than ${LEDGER_FORMAT}`;
  }
  const extra = Object.keys(raw).filter(k => !LEDGER_KEYS.includes(k));
  if (extra.length) return `unknown fields: ${extra.join(', ')}`;
  if (raw.round != null && !isMap(raw.round)) return 'round is not an object';
  if ('cards' in raw) {
    if (!isMap(raw.cards)) return 'cards is not an object';
    for (const [id, c] of Object.entries(raw.cards)) {
      if (!isMap(c) || !CARD_MODES.includes(c.mode)) return `card ${id} has an unknown mode ${JSON.stringify(c && c.mode)}`;
    }
  }
  for (const k of ['applied', 'flagged']) if (k in raw && !isMap(raw[k])) return `${k} is not an object`;
  return null;
}

// the ledger before suggestion cards had one mode each: {applied, flagged}
// maps. Read it as the modes it meant, so an old round still commits.
function normalizeLedger(raw) {
  const l = { round: (raw && raw.round) || null, cards: {} };
  if (raw && raw.cards && typeof raw.cards === 'object') {
    for (const [id, c] of Object.entries(raw.cards)) l.cards[id] = { ...c };
    return l;
  }
  for (const [id, f] of Object.entries((raw && raw.flagged) || {})) {
    l.cards[id] = { mode: 'flagged', reason: f && f.reason, ts: f && f.ts };
  }
  for (const [id, a] of Object.entries((raw && raw.applied) || {})) {
    l.cards[id] = a && a.committed
      ? { mode: 'committed', sha: a.committed, ts: a.ts, source_file: a.source_file || null }
      : { mode: 'applied', ts: a && a.ts, source_file: (a && a.source_file) || null };
  }
  return l;
}
export const modeOf = (l, id) => (l.cards[id] && l.cards[id].mode) || 'pending';
// THE one place a card's mode changes. Refuses any move the table in
// assets/card-modes.js does not list; asking for the mode a card is already
// in is a no-op that may refresh its details (a new flag reason, say).
export function moveCard(l, id, next, extra = {}) {
  const from = modeOf(l, id);
  if (!CARD_MODES.includes(next)) return { ok: false, from, to: next, reason: `"${next}" is not a card mode` };
  if (!canMove(from, next)) {
    return { ok: false, from, to: next, reason: from === 'applied' && next === 'rejected'
      ? `${id} is already written into the source — revert the round before rejecting it`
      : `${id} cannot go from ${from} to ${next}` };
  }
  if (next === 'pending') delete l.cards[id];
  else l.cards[id] = { mode: next, ts: new Date().toISOString(), ...extra };
  return { ok: true, from, to: next };
}

export class ApplyEngine {
  constructor({ reviewDir, cfg }) {
    this.review = reviewDir;
    this.root = path.resolve(reviewDir, '..');
    this.cfg = cfg;
    this.ledgerFile = path.join(reviewDir, 'state', 'apply.json');
    this.ledgerRel = path.join(path.basename(reviewDir), 'state', 'apply.json');
  }

  // {ok, ledger} or {ok:false, reason} — an unreadable ledger is never empty,
  // and one this engine is too old to understand is refused, never rewritten
  loadLedger() {
    const r = readJsonState(this.ledgerFile);
    if (r.state === 'missing') return { ok: true, ledger: normalizeLedger(null) };
    if (r.state === 'ok' && isMap(r.value)) {
      const problem = ledgerProblem(r.value);
      if (!problem) return { ok: true, ledger: normalizeLedger(r.value) };
      const reason = tooNewMessage(this.ledgerRel);
      console.error(`review: ${reason} (${problem})`);
      return { ok: false, reason, tooNew: true };
    }
    const reason = unreadableMessage(this.ledgerRel, 'The record of applied changes');
    console.error(`review: ${reason} (${(r.error && r.error.message) || 'not a JSON object'})`);
    return { ok: false, reason };
  }
  saveLedger(l) {
    fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
    writeJsonAtomic(this.ledgerFile, { format: LEDGER_FORMAT, round: l.round, cards: l.cards });
  }
  // the public way to change one card's mode: load, move, save
  setCardMode(id, next, extra) {
    const lr = this.loadLedger();
    if (!lr.ok) return { ok: false, reason: lr.reason };
    const m = moveCard(lr.ledger, id, next, extra);
    if (m.ok && m.from !== m.to) this.saveLedger(lr.ledger);
    return m;
  }
  // bring every decided card in line with what people decided. `decisions`
  // is {id: 'accepted'|'rejected'|'pending'}; a card absent from it is
  // pending. Moves the table refuses (rejecting an applied edit) are left
  // as they are and reported, never forced.
  syncDecisions(decisions) {
    const lr = this.loadLedger();
    if (!lr.ok) return { ok: false, reason: lr.reason, refused: [] };
    const l = lr.ledger;
    const refused = [];
    let changed = false;
    for (const id of new Set([...Object.keys(decisions), ...Object.keys(l.cards)])) {
      const want = decisions[id] || 'pending';
      const cur = modeOf(l, id);
      if (DECISION_OF_MODE[cur] === want) continue;
      const m = moveCard(l, id, want);
      if (m.ok) changed = true; else refused.push({ id, reason: m.reason });
    }
    if (changed) this.saveLedger(l);
    return { ok: true, refused };
  }
  // what the UI needs: one mode per card + whether an uncommitted round exists
  publicLedger() {
    const lr = this.loadLedger();
    if (!lr.ok) return { cards: {}, round: null, error: lr.reason };
    const l = lr.ledger;
    return { cards: l.cards, round: l.round ? { ids: l.round.ids, files: l.round.files } : null };
  }

  git(...args) {
    return execFileSync('git', args, { cwd: this.root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim();
  }
  // every suggestion the applier can act on: bot cards (suggestions.json) plus
  // HUMAN suggestions, which live in their author's own state/users/<handle>.json
  // (file ownership: humans never write suggestions.json). Apply itself is
  // author-agnostic — it only ever needs {id, current_text, proposed_text,
  // source_file | source_json}.
  humanCards() {
    const dir = path.join(this.review, 'state', 'users');
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let u; try { u = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const handle = u.handle || f.replace(/\.json$/, '');
      for (const [id, v] of Object.entries(u.decisions || {})) {
        if (v && v.status === 'user-suggestion' && (v.current_text || v.source_json)) {
          out.push({ ...v, id, author: handle, type: 'user-suggestion' });
        }
      }
    }
    return out;
  }
  cards() {
    let bots = [];
    try { bots = JSON.parse(fs.readFileSync(path.join(this.review, 'suggestions.json'), 'utf8')); } catch { }
    return [...bots, ...this.humanCards()];
  }
  bibFile() { const b = [].concat(this.cfg.bib || [])[0]; return b ? path.resolve(this.root, b) : null; }

  // JSON-aware edit for cards targeting a config key (papers with no \title{}
  // carry their masthead in review.config.json's "title"). The file is parsed,
  // the key replaced, and re-serialized — a JSON document is NEVER string-
  // replaced, so a value that also occurs elsewhere can't corrupt it.
  resolveJson(card) {
    const { file: rel, key } = card.source_json || {};
    if (!rel || !key) return { ok: false, reason: 'source_json needs {file, key}' };
    const file = path.resolve(this.root, rel);
    if (!file.startsWith(this.root + path.sep)) return { ok: false, reason: 'source_json.file escapes the repo' };
    if (!fs.existsSync(file)) return { ok: false, reason: `${rel} not found` };
    let obj;
    try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return { ok: false, reason: `${rel} is not valid JSON` }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: `${rel} is not a JSON object` };
    // drift guard, the JSON analogue of unique-span matching: if the card
    // recorded what the key held, it must still hold it
    const cur = obj[key] == null ? '' : String(obj[key]);
    if (card.current_text != null && String(card.current_text).trim() && cur.trim() !== String(card.current_text).trim()) {
      return { ok: false, reason: `${rel} "${key}" drifted since the card was written` };
    }
    obj[key] = card.proposed_text ?? '';
    return { ok: true, file, after: JSON.stringify(obj, null, 1) + '\n' };
  }

  // unique-span resolution against the current tree; never writes
  resolve(card) {
    if (card.source_json) return this.resolveJson(card);
    if (!card.current_text || !card.source_file) return { ok: false, reason: 'card carries no current_text/source_file span' };
    const file = path.resolve(this.root, card.source_file);
    if (!file.startsWith(this.root + path.sep)) return { ok: false, reason: 'source_file escapes the repo' };
    if (!fs.existsSync(file)) return { ok: false, reason: `${card.source_file} not found` };
    const isNb = file.endsWith('.ipynb');
    let text;
    try { text = isNb ? notebookText(file) : fs.readFileSync(file, 'utf8'); }
    catch { return { ok: false, reason: `${card.source_file} ${isNb ? 'is not valid notebook JSON' : 'could not be read'}` }; }
    // whitespace-tolerant: cards carry single-spaced spans, LaTeX wraps lines;
    // matching normalizes \s+ runs, the replacement uses true raw offsets
    const spans = findSpans(text, card.current_text, 10);
    if (spans.length === 0) return { ok: false, reason: 'span not found — source drifted since the card was written' };
    if (spans.length > 1) return { ok: false, reason: `span ambiguous (${spans.length}${spans.length === 10 ? '+' : ''} matches)` };
    const { start, end } = spans[0];
    if (isNb) {
      const e = editNotebook(file, start, end, card.proposed_text ?? '');
      return e.ok ? { ok: true, file, after: e.after } : { ok: false, reason: e.reason };
    }
    return { ok: true, file, after: text.slice(0, start) + (card.proposed_text ?? '') + text.slice(end) };
  }

  // bib entries whose keys are not already present; null = nothing to add
  newBibEntries(card, bibText) {
    if (!card.bib_entries || !card.bib_entries.length) return null;
    const fresh = [].concat(card.bib_entries).filter(e => {
      const key = /@\w+\s*\{\s*([^,\s]+)/.exec(e)?.[1];
      return !key || !bibText.includes(`{${key},`) && !bibText.includes(`{${key} ,`);
    });
    return fresh.length ? fresh : null;
  }

  // snapshot of the working tree the round can be reverted to
  roundBase() {
    return this.git('stash', 'create', 'review-apply pre-round snapshot') || this.git('rev-parse', 'HEAD');
  }

  // Each edit is recorded as it lands, not after the whole batch: the round
  // (with its revert snapshot and the files it is about to touch) is saved
  // BEFORE a source file is written, and the card is marked applied right
  // after. A crash half-way leaves a ledger that still knows every file the
  // round touched, so Revert can put them back.
  apply(ids, { dryRun = false } = {}) {
    const res = { applied: [], flagged: [], skipped: [] };
    const lr = this.loadLedger();
    if (!lr.ok) {
      for (const id of ids) res.skipped.push({ id, reason: lr.reason });
      return { ...res, error: lr.reason };
    }
    // a dry run works on a throwaway copy and never saves
    const l = dryRun ? structuredClone(lr.ledger) : lr.ledger;
    const save = () => { if (!dryRun) this.saveLedger(l); };
    const byId = new Map(this.cards().map(c => [c.id, c]));
    for (const id of ids) {
      const card = byId.get(id);
      if (!card) { res.skipped.push({ id, reason: 'unknown card id' }); continue; }
      const mode = modeOf(l, id);
      if (mode === 'applied') { res.skipped.push({ id, reason: 'already applied' }); continue; }
      if (mode === 'committed') { res.skipped.push({ id, reason: 'already committed' }); continue; }
      if (mode === 'rejected') { res.skipped.push({ id, reason: 'rejected — accept it first' }); continue; }
      // the caller vouches for acceptance (the server only asks for accepted
      // cards; the CLI trusts its caller), so an undecided card is accepted here
      if (mode === 'pending') moveCard(l, id, 'accepted');
      const flag = reason => {
        res.flagged.push({ id, reason });
        moveCard(l, id, 'flagged', { reason });
        save();
      };
      const r = this.resolve(card);
      if (!r.ok) { flag(r.reason); continue; }
      const bib = this.bibFile();
      const bibText = bib && fs.existsSync(bib) ? fs.readFileSync(bib, 'utf8') : '';
      const bibAdd = this.newBibEntries(card, bibText);
      if (bibAdd && !bib) { flag('card has bib_entries but no bib file is configured'); continue; }
      res.applied.push(id);
      if (dryRun) continue;
      // 1. the round, this card and every file it is about to touch, on disk
      //    first. If the process dies between the write below and the save
      //    after it, the card is in the round but not marked applied, so
      //    Commit refuses and asks for a revert instead of committing an
      //    edit nothing recorded.
      if (!l.round) l.round = { base: this.roundBase(), ids: [], files: [] };
      if (!l.round.ids.includes(id)) l.round.ids.push(id);
      const rel = path.relative(this.root, r.file);
      if (!l.round.files.includes(rel)) l.round.files.push(rel);
      const relBib = bibAdd ? path.relative(this.root, bib) : null;
      if (relBib && !l.round.files.includes(relBib)) l.round.files.push(relBib);
      save();
      // 2. span + bib land together, each file replaced whole
      writeFileAtomic(r.file, r.after);
      if (bibAdd) writeFileAtomic(bib, bibText + (bibText.endsWith('\n') ? '' : '\n') + '\n' + bibAdd.join('\n\n') + '\n');
      // 3. and the card says so at once
      moveCard(l, id, 'applied', { source_file: card.source_file || (card.source_json && card.source_json.file) || null });
      save();
    }
    return res;
  }

  // `decisions` (optional, {id: 'accepted'|'rejected'|'pending'}) is what
  // people decided as of now; the server passes it so a card rejected after
  // its edit was applied can never ride into the commit.
  commit({ decisions = null } = {}) {
    const lr = this.loadLedger();
    if (!lr.ok) return { ok: false, reason: lr.reason };
    const l = lr.ledger;
    if (!l.round) return { ok: false, reason: 'nothing to commit — apply cards first' };
    const notApplied = l.round.ids.filter(id => modeOf(l, id) !== 'applied');
    if (notApplied.length) {
      return { ok: false, reason: `Not committed: ${notApplied.join(', ')} ${notApplied.length === 1 ? 'is' : 'are'} no longer marked as applied. Revert the round and apply again.` };
    }
    if (decisions) {
      const undecided = l.round.ids.filter(id => (decisions[id] || 'pending') !== 'accepted');
      if (undecided.length) {
        return { ok: false, reason: `Not committed: ${undecided.join(', ')} ${undecided.length === 1 ? 'was' : 'were'} rejected or reset after being applied. Revert the round, then apply again without ${undecided.length === 1 ? 'it' : 'them'}.` };
      }
    }
    const msg = `Apply review suggestions: ${l.round.ids.join(', ')}`;
    try { this.git('commit', '-m', msg, '--', ...l.round.files); }
    catch (e) { return { ok: false, reason: execFailure(e, 'git commit', GIT_TIMEOUT_MS) }; }
    let sha = '';
    try { sha = this.git('rev-parse', '--short', 'HEAD'); } catch { }
    for (const id of l.round.ids) moveCard(l, id, 'committed', { source_file: l.cards[id].source_file || null, sha });
    const out = { ok: true, sha, ids: l.round.ids, message: msg };
    l.round = null;
    this.saveLedger(l);
    return out;
  }

  revert() {
    const lr = this.loadLedger();
    if (!lr.ok) return { ok: false, reason: lr.reason };
    const l = lr.ledger;
    if (!l.round) return { ok: false, reason: 'nothing to revert — no uncommitted round' };
    try { this.git('checkout', l.round.base, '--', ...l.round.files); }
    catch (e) { return { ok: false, reason: execFailure(e, 'git checkout', GIT_TIMEOUT_MS) }; }
    const out = { ok: true, ids: l.round.ids, files: l.round.files };
    // back to accepted: the edit is out of the source, the decision stands
    for (const id of l.round.ids) if (modeOf(l, id) === 'applied') moveCard(l, id, 'accepted');
    l.round = null;
    this.saveLedger(l);
    return out;
  }
}

// CLI: node apply.mjs [--dry-run] <card-id> [...]   (acceptance is enforced by the server; the CLI trusts its caller)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ids = args.filter(a => !a.startsWith('--'));
  const review = path.dirname(fileURLToPath(import.meta.url));
  const cfg = JSON.parse(fs.readFileSync(path.join(review, 'review.config.json'), 'utf8'));
  const engine = new ApplyEngine({ reviewDir: review, cfg });
  if (!ids.length) { console.log('usage: node apply.mjs [--dry-run] <card-id> [...]'); process.exit(1); }
  console.log(JSON.stringify(engine.apply(ids, { dryRun }), null, 1));
}
