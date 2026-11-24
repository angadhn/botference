// blyg-log.mjs — the troubleshooting log of a Publish-as-blyg run, for AGENTS, never for the owner's screen.
//
// The owner sees plain steps (blyg-run.mjs viewOf, the drawer's one wording table). Everything raw goes HERE: one file per run,
//   <data dir>/blyg-publish-logs/<run id>.jsonl
// (the data dir is the companion's store folder, the one that holds blyg-publish-run.json), one JSON object per line:
//   {"t": ISO time, "ev": "run",   "id", "kind", "settings_fp", "page_url", "scope", "note_rel", "permalink", "version"}  first line
//   {"t", "ev": "check", "argv", "ok", "message"}                         the pre-flight
//   {"t", "ev": "move",  "from", "to"}                                     every change of the run's mode
//   {"t", "ev": "step",  "step", "command", "argv", "exit", "signal", "timed_out", "spawn_error", "ms", "truncated", "output"}
//                                                                          every command run, with its whole captured output
//                                                                          (blyg-home OUTPUT: the first 8 KiB and the last 56 KiB)
//   {"t", "ev": "note",  "text"}                                           anything else worth knowing (a preview render, a refusal)
// The folder is 0700 and each file 0600 (owner only); after a new file is made, all but the newest LOG_KEEP files are removed.
// A log that cannot be written never stops a run (it is for troubleshooting).
import fs from 'node:fs';
import path from 'node:path';

export const LOG_KEEP = 50;
export const LOG_DIR_NAME = 'blyg-publish-logs';
const ID = /^[0-9a-f]{16}$/;

export function createRunLog(dir) {
  const fileOf = id => path.join(dir, `${id}.jsonl`);
  const ensureDir = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  };
  function rotate() {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /^[0-9a-f]{16}\.jsonl$/.test(n)); } catch { return; }
    if (names.length <= LOG_KEEP) return;
    const dated = names.map(n => { let m = 0; try { m = fs.statSync(path.join(dir, n)).mtimeMs; } catch { /* gone */ } return [n, m]; })
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
    for (const [n] of dated.slice(LOG_KEEP)) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* gone */ } }
  }
  function write(id, ev) {
    if (!ID.test(String(id || ''))) return;
    try {
      ensureDir();
      const file = fileOf(id);
      const fresh = !fs.existsSync(file);
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n', { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* ours */ }
      if (fresh) rotate();
    } catch { /* a log is never in the way of a run */ }
  }
  return { dir, pathOf: id => (ID.test(String(id || '')) ? fileOf(id) : ''), write };
}
