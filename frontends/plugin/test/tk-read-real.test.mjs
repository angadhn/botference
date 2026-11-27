// tk-read-real.test.mjs — OPT-IN SMOKE TEST WITH REAL MODEL CALLS (three short `claude -p` runs on the owner's subscription), through
// the companion's own one-shot code, inside the real wrapper: a plain passage, a web search, and a notes passage reading a fixture file.
// Skipped unless BOTFERENCE_REAL_SMOKE=1. Run it before merging a change to oneshot.mjs, tk-read.mjs or the wrapper:
//
//   BOTFERENCE_REAL_SMOKE=1 node --test test/tk-read-real.test.mjs
//
// No stub stands in: the stub tests cannot see the CLI's sign-in, its network or its temporary files (a wrapper that broke all three
// passed every stub test, 2026-11-27).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as O from '../oneshot.mjs';

const on = process.env.BOTFERENCE_REAL_SMOKE === '1' && process.platform === 'darwin';
const skip = !on && 'set BOTFERENCE_REAL_SMOKE=1 (macOS) to run three real `claude -p` passages';
const WITHIN_MS = 60000;   // a passage that worked took 2 to 8 s on 2026-11-27; the failure mode was a three-minute stall
const timed = async (prompt, o) => { const t = Date.now(); const r = await O.runOneShot('claude', prompt, o); return { ...r, ms: Date.now() - t }; };

test('REAL: a plain passage (no tools needed) answers within a minute', { skip, timeout: 200000 }, async () => {
  const r = await timed('Say in one short sentence that this is a test passage.', { caps: 'web' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.ms < WITHIN_MS, `${r.ms} ms`);
  console.log(`plain: ${r.ms} ms`);
});

test('REAL: a web-search passage searches and answers', { skip, timeout: 200000 }, async () => {
  const r = await timed('Search the web for the capital of Iceland and answer in one short sentence.', { caps: 'web' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.ms < WITHIN_MS, `${r.ms} ms`);
  assert.ok(r.sources.web.some(s => s.startsWith('search:')), JSON.stringify(r.sources));
  console.log(`web: ${r.ms} ms`);
});

test('REAL: a notes passage reads a fixture file under a root and answers from it', { skip, timeout: 200000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-real-notes-')));
  fs.writeFileSync(path.join(root, 'yard.md'), 'The fixture note says the yard built forty ships.\n');
  try {
    const r = await timed(`Read yard.md in ${root} and say in one short sentence how many ships it says the yard built.`, { caps: 'web+notes', roots: [root] });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.ms < WITHIN_MS, `${r.ms} ms`);
    assert.match(r.text, /forty|40/i);
    assert.ok(r.sources.notes.some(s => s.endsWith('yard.md')), JSON.stringify(r.sources));
    console.log(`notes: ${r.ms} ms`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
