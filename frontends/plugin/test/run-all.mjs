// run-all.mjs — the aggregate runner for the discuss plugin's test tree.
//
//   node frontends/plugin/test/run-all.mjs            # every *.test.mjs, in order
//   node frontends/plugin/test/run-all.mjs strike     # only suites whose name matches
//   node frontends/plugin/test/run-all.mjs -j 4       # four at a time (each server takes PORT=0)
//
// Why this file exists: for a long time nothing ran the suites together. Every
// suite was a `node test/<one>.test.mjs` you had to remember, so nine of them
// quietly grew a private copy of the same server harness and drifted apart —
// nobody ever saw the nine side by side. This runner is what forces them into
// one view. It shells each suite out to its own `node`, exactly as a human
// would, and re-prints the tail line each suite already writes for itself
// ("✓ name — N passed, 0 failed"), then adds a total.
//
// Exit code is the number of FAILING SUITES (not failing assertions), so CI and
// a shell `&&` both read it the obvious way.
//
// Grep hazard, since a future agent will run this before searching the tree:
// server.mjs, store.mjs and test/adapters.test.mjs contain non-UTF-8 bytes, so
// plain `grep` reports NOTHING on them. Always `grep -a` when checking whether
// a name still has callers.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
let jobs = 1;
const filters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-j' || argv[i] === '--jobs') { jobs = Math.max(1, +argv[++i] || 1); continue; }
  filters.push(argv[i]);
}

const files = fs.readdirSync(here)
  .filter(f => f.endsWith('.test.mjs'))
  .filter(f => !filters.length || filters.some(s => f.includes(s)))
  .sort();

if (!files.length) {
  console.error('run-all: no suites matched ' + JSON.stringify(filters));
  process.exit(1);
}

// Each suite ends with a line of its own counting what it ran. The wording is
// not uniform across the tree — "87 passed, 0 failed", "strike: 87 passed, 0
// failed" and "✓ anchor.test.mjs — 47 passed, 0 failed" all occur — so match
// only the part every one of them shares and take the LAST such line, which is
// always the suite's own total.
const TAIL = /(\d+)\s+passed,\s+(\d+)\s+failed/;

function runOne(file) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const proc = spawn(process.execPath, [path.join(here, file)], {
      stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', code => {
      const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
      let passed = 0, failed = 0, tail = null;
      for (const line of lines) {
        const m = TAIL.exec(line);
        if (m) { tail = line; passed = +m[1]; failed = +m[2]; }
      }
      // A suite that skipped everything (no Chromium, say) prints a SKIPPED
      // line of its own; surface it rather than letting a silent zero pass for
      // a green run.
      const skips = lines.filter(l => /\bSKIPPED\b/.test(l));
      if (!tail) skips.push('SKIPPED? no "N passed, M failed" line — this suite counted nothing');
      resolve({ file, code, passed, failed, tail, skips, out, ms: Date.now() - t0 });
    });
  });
}

const results = [];
const queue = files.slice();
async function worker() {
  for (;;) {
    const f = queue.shift();
    if (!f) return;
    const r = await runOne(f);
    results.push(r);
    const label = r.code === 0 ? '✓' : '✗';
    const secs = (r.ms / 1000).toFixed(1) + 's';
    console.log(`${label} ${r.file.padEnd(24)} ${String(r.passed).padStart(5)} passed  `
      + `${String(r.failed).padStart(3)} failed  ${secs.padStart(7)}`);
    for (const s of r.skips) console.log('    ' + s);
    if (r.code !== 0) console.log(r.out.split('\n').map(l => '    | ' + l).join('\n'));
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));

const totalPassed = results.reduce((a, r) => a + r.passed, 0);
const totalFailed = results.reduce((a, r) => a + r.failed, 0);
const badSuites = results.filter(r => r.code !== 0);
const skipped = results.filter(r => r.skips.length);

console.log('');
console.log(`${badSuites.length ? '✗' : '✓'} ${results.length} suites — `
  + `${totalPassed} passed, ${totalFailed} failed, `
  + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (skipped.length) {
  console.log(`  note: ${skipped.map(r => r.file).join(', ')} skipped work — see the SKIPPED lines above`);
}
if (badSuites.length) {
  console.log('  failing suites: ' + badSuites.map(r => r.file).join(', '));
}
process.exit(badSuites.length);
