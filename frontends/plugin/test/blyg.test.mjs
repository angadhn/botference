// blyg.test.mjs — Discuss and Blygger: is this page a blyg post, which one,
// and what is recorded about it.
//
//   node frontends/plugin/test/blyg.test.mjs
//
// Nothing here touches the network. Detection runs against the saved public
// documents in fixtures/blyg/ (sources.json says where each came from) through
// an injected transport; the guard runs against a loopback server of its own.
// No framework. Exit code is the number of failures.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CFG = require(path.join(here, '..', 'extension', 'config.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + String(detail).slice(0, 800) : ''));
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const throws = fn => { try { fn(); return false; } catch { return true; } };

// ---- the status modes and their one move function -------------------------
{
  eq('modes: one named list', CFG.BLYG_MODES,
    ['unknown', 'checking', 'blyg', 'blyg-site', 'not-a-blyg', 'check-failed']);
  ok('move: unknown → checking', CFG.blygMove('unknown', 'checking') === 'checking');
  for (const s of CFG.BLYG_SETTLED) {
    ok(`move: checking → ${s}`, CFG.blygMove('checking', s) === s);
    ok(`move: unknown → ${s} (the companion already knew)`, CFG.blygMove('unknown', s) === s);
    ok(`move: ${s} → checking (ask again)`, CFG.blygMove(s, 'checking') === 'checking');
    ok(`move: ${s} → unknown (the tab moved on)`, CFG.blygMove(s, 'unknown') === 'unknown');
  }
  ok('refused: an answer out of nowhere replacing another', throws(() => CFG.blygMove('not-a-blyg', 'blyg')));
  ok('refused: blyg → check-failed without asking again', throws(() => CFG.blygMove('blyg', 'check-failed')));
  ok('refused: checking → checking', throws(() => CFG.blygMove('checking', 'checking')));
  ok('refused: a mode that is not named', throws(() => CFG.blygMove('unknown', 'maybe')));
  ok('refused: from a mode that is not named', throws(() => CFG.blygMove('maybe', 'checking')));
  ok('canBlygMove says no without throwing', CFG.canBlygMove('blyg', 'not-a-blyg') === false);
}

// ---- report -----------------------------------------------------------------
for (const f of failures) console.log('  FAIL ' + f);
console.log(`blyg: ${pass} passed, ${fail} failed`);
process.exit(fail);
