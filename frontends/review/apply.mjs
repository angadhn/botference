// apply.mjs — deterministic Apply / Commit / Revert for accepted suggestion cards.
// Owns state/apply.json (the uncommitted-round ledger). Source edits are
// unique-span replacements only: current_text must match exactly once in
// source_file; drifted or ambiguous spans are flagged needs_manual_resolution,
// never guessed. A card's bib_entries land atomically with its span edit.
// Revert restores the exact pre-apply tree via git checkout from a stash-create
// snapshot, so a file's pre-existing uncommitted edits survive the round trip.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export class ApplyEngine {
  constructor({ reviewDir, cfg }) {
    this.review = reviewDir;
    this.root = path.resolve(reviewDir, '..');
    this.cfg = cfg;
    this.ledgerFile = path.join(reviewDir, 'state', 'apply.json');
  }

  ledger() {
    try { return JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8')); }
    catch { return { round: null, applied: {}, flagged: {} }; }
  }
  saveLedger(l) { fs.writeFileSync(this.ledgerFile, JSON.stringify(l, null, 1)); }
  // what the UI needs: per-card status + whether an uncommitted round exists
  publicLedger() {
    const l = this.ledger();
    return { applied: l.applied, flagged: l.flagged, round: l.round ? { ids: l.round.ids, files: l.round.files } : null };
  }

  git(...args) { return execFileSync('git', args, { cwd: this.root, encoding: 'utf8' }).trim(); }
  cards() { return JSON.parse(fs.readFileSync(path.join(this.review, 'suggestions.json'), 'utf8')); }
  bibFile() { const b = [].concat(this.cfg.bib || [])[0]; return b ? path.resolve(this.root, b) : null; }

  // unique-span resolution against the current tree; never writes
  resolve(card) {
    if (!card.current_text || !card.source_file) return { ok: false, reason: 'card carries no current_text/source_file span' };
    const file = path.resolve(this.root, card.source_file);
    if (!file.startsWith(this.root + path.sep)) return { ok: false, reason: 'source_file escapes the repo' };
    if (!fs.existsSync(file)) return { ok: false, reason: `${card.source_file} not found` };
    const text = fs.readFileSync(file, 'utf8');
    const n = text.split(card.current_text).length - 1;
    if (n === 0) return { ok: false, reason: 'span not found — source drifted since the card was written' };
    if (n > 1) return { ok: false, reason: `span ambiguous (${n} matches)` };
    return { ok: true, file, after: text.replace(card.current_text, card.proposed_text ?? '') };
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

  apply(ids, { dryRun = false } = {}) {
    const l = this.ledger();
    const byId = new Map(this.cards().map(c => [c.id, c]));
    const res = { applied: [], flagged: [], skipped: [] };
    for (const id of ids) {
      const card = byId.get(id);
      if (!card) { res.skipped.push({ id, reason: 'unknown card id' }); continue; }
      if (l.applied[id]) { res.skipped.push({ id, reason: 'already applied' }); continue; }
      const r = this.resolve(card);
      if (!r.ok) {
        res.flagged.push({ id, reason: r.reason });
        if (!dryRun) { l.flagged[id] = { reason: r.reason, ts: new Date().toISOString() }; }
        continue;
      }
      const bib = this.bibFile();
      const bibText = bib && fs.existsSync(bib) ? fs.readFileSync(bib, 'utf8') : '';
      const bibAdd = this.newBibEntries(card, bibText);
      if (bibAdd && !bib) {
        res.flagged.push({ id, reason: 'card has bib_entries but no bib file is configured' });
        if (!dryRun) l.flagged[id] = { reason: 'bib_entries without configured bib file', ts: new Date().toISOString() };
        continue;
      }
      res.applied.push(id);
      if (dryRun) continue;
      // span + bib land together, under a round snapshot taken before the first write
      if (!l.round) l.round = { base: this.roundBase(), ids: [], files: [] };
      fs.writeFileSync(r.file, r.after);
      const rel = path.relative(this.root, r.file);
      if (!l.round.files.includes(rel)) l.round.files.push(rel);
      if (bibAdd) {
        fs.writeFileSync(bib, bibText + (bibText.endsWith('\n') ? '' : '\n') + '\n' + bibAdd.join('\n\n') + '\n');
        const relBib = path.relative(this.root, bib);
        if (!l.round.files.includes(relBib)) l.round.files.push(relBib);
      }
      l.round.ids.push(id);
      l.applied[id] = { ts: new Date().toISOString(), source_file: card.source_file };
      delete l.flagged[id];
    }
    if (!dryRun) this.saveLedger(l);
    return res;
  }

  commit() {
    const l = this.ledger();
    if (!l.round) return { ok: false, reason: 'nothing to commit — apply cards first' };
    const msg = `Apply review suggestions: ${l.round.ids.join(', ')}`;
    try { this.git('commit', '-m', msg, '--', ...l.round.files); }
    catch (e) { return { ok: false, reason: `git commit failed: ${String(e.stderr || e.message).slice(0, 300)}` }; }
    const sha = this.git('rev-parse', '--short', 'HEAD');
    for (const id of l.round.ids) if (l.applied[id]) l.applied[id].committed = sha;
    const out = { ok: true, sha, ids: l.round.ids, message: msg };
    l.round = null;
    this.saveLedger(l);
    return out;
  }

  revert() {
    const l = this.ledger();
    if (!l.round) return { ok: false, reason: 'nothing to revert — no uncommitted round' };
    try { this.git('checkout', l.round.base, '--', ...l.round.files); }
    catch (e) { return { ok: false, reason: `git checkout failed: ${String(e.stderr || e.message).slice(0, 300)}` }; }
    const out = { ok: true, ids: l.round.ids, files: l.round.files };
    for (const id of l.round.ids) delete l.applied[id];
    l.round = null;
    this.saveLedger(l);
    return out;
  }
}

// CLI: node apply.mjs [--dry-run] <card-id> [...]   (acceptance is enforced by the server; the CLI trusts its caller)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ids = args.filter(a => !a.startsWith('--'));
  const review = path.dirname(new URL(import.meta.url).pathname);
  const cfg = JSON.parse(fs.readFileSync(path.join(review, 'review.config.json'), 'utf8'));
  const engine = new ApplyEngine({ reviewDir: review, cfg });
  if (!ids.length) { console.log('usage: node apply.mjs [--dry-run] <card-id> [...]'); process.exit(1); }
  console.log(JSON.stringify(engine.apply(ids, { dryRun }), null, 1));
}
