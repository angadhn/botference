// envelope.test.mjs — unit tests for the room-protocol footer splitter in
// frontends/plugin/extension/drawer.js (splitEnvelopes) and the one rule that
// decides which bot an author name is (agentOf).
//
//   node frontends/plugin/test/envelope.test.mjs
//
// Free-form mode tells every bot to end its turn with a JSON footer
// {"status","next","writer","summary"} (core/room_prompts.py). The controller
// strips a well-formed TRAILING one, but a bot that pretty-prints it, drops it
// mid-message or is still typing it leaks raw braces into prose the companion
// then PERSISTS. splitEnvelopes lifts those out for the chip row.
//
// The load-bearing case is the last section: an envelope inside a fenced code
// block must survive untouched, because the drawer numbers fenced blocks for
// the Run button and the companion re-parses the stored text with the same
// counter. Swallowing one here would point every later Run button at the
// wrong block.
//
// Pure — no DOM, no drawer instance. No framework; exit code is the failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, 'got  ' + g + '\n      want ' + w);
}

const split = D.splitEnvelopes;
const ENV = '{"status": "continuing", "next": "@codex", "summary": "read the filing"}';

// ---- 1. the footer comes out, the prose stays --------------------------------
{
  const r = split('Here is the answer.\n\n' + ENV);
  eq('a trailing footer leaves the prose alone', r.text, 'Here is the answer.');
  eq('…and is handed back as an object', r.envs.length, 1);
  eq('…with its fields intact', r.envs[0].next, '@codex');

  const mid = split('First half.\n' + ENV + '\nSecond half.');
  eq('a footer in the MIDDLE comes out too — that is why this exists',
    mid.text, 'First half.\n\nSecond half.');
  eq('…still exactly one envelope', mid.envs.length, 1);

  const pretty = split('Done.\n\n{\n  "status": "converged",\n  "summary": "agreed"\n}\n');
  eq('a pretty-printed footer is still a footer', pretty.text, 'Done.');
  eq('…and its status survives the reformatting', pretty.envs[0].status, 'converged');

  const two = split(ENV + '\nprose\n' + ENV);
  eq('two of them, in order', two.envs.length, 2);
  eq('…leaving only the prose', two.text, 'prose');
}

// ---- 2. what is NOT a footer -------------------------------------------------
{
  const plain = 'The status was unclear, so {this} is just prose.';
  eq('an object with no "status" key is prose', split(plain).text, plain);
  eq('…and reports no envelopes', split(plain).envs.length, 0);

  const shaped = 'Config: {"status": "ok", "port": 4189}';
  eq('an object with foreign keys is NOT the room footer', split(shaped).text, shaped);

  const bare = '{"status": "continuing"}';
  eq('"status" alone is not enough — next or summary must be there', split(bare).text, bare);

  const nothing = 'No braces here at all.';
  eq('a message with no braces is returned byte-for-byte', split(nothing).text, nothing);
  ok('…and keeps its own blank lines',
    split('a\n\n\n\nb').text === 'a\n\n\n\nb');
}

// ---- 3. the half-typed one, mid-stream --------------------------------------
{
  const live = split('Answer.\n\n{"status": "contin');
  eq('a footer still being typed does not flash on screen', live.text, 'Answer.');
  eq('…and there is nothing to chip yet', live.envs.length, 0);

  const notYet = split('Answer.\n\n{"stat');
  eq('…but half an opening brace is left as prose', notYet.text, 'Answer.\n\n{"stat');
}

// ---- 4. fenced code is untouchable ------------------------------------------
// The Run button addresses a block by its ordinal among the fences of the
// STORED text (run.mjs codeBlocks counts the same way). If this ever starts
// removing a fence — or hollowing one out — every later Run button silently
// runs the wrong code.
{
  const fenced = 'Look:\n\n```json\n' + ENV + '\n```\n\nThat is the shape.';
  eq('an envelope inside a fence is left exactly where it is', split(fenced).text, fenced);
  eq('…and is never chipped', split(fenced).envs.length, 0);

  const both = 'Shape:\n\n```json\n' + ENV + '\n```\n\nDone.\n\n' + ENV;
  const r = split(both);
  eq('a real footer still comes out from beside a fenced example', r.envs.length, 1);
  ok('…and the fence survives it', /```json\n\{"status"/.test(r.text) && r.text.endsWith('Done.'),
    JSON.stringify(r.text));
  eq('the fence count is unchanged, which is what the Run button rides on',
    (r.text.match(/```/g) || []).length, (both.match(/```/g) || []).length);

  const tilde = 'x\n\n~~~\n' + ENV + '\n~~~\n';
  eq('tilde fences count as fences too', split(tilde).text.includes(ENV), true);

  const open = 'still writing\n\n```json\n' + ENV;
  eq('an UNCLOSED fence mid-stream protects everything after it',
    split(open).text, open);
}

// ---- 5. checkbox ordinals are untouched -------------------------------------
// The companion counts a message's checkboxes line-anchored in the stored
// text; the drawer counts them again while rendering. A footer that took a
// checkbox line with it would put every later tick on the wrong box.
{
  const list = '- [ ] one\n- [x] two\n- [ ] three\n\n' + ENV;
  const r = split(list);
  const boxes = s => (s.match(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\]/gm) || []).length;
  eq('every checkbox survives the footer coming off', boxes(r.text), boxes(list));
  eq('…and they are still in order', r.text, '- [ ] one\n- [x] two\n- [ ] three');
}

// ---- 6. agentOf: one rule for colour AND typeface ---------------------------
{
  eq('claude', D.agentOf('claude'), 'claude');
  eq('codex', D.agentOf('codex'), 'codex');
  eq('a suffixed handle still names its agent', D.agentOf('claude-2'), 'claude');
  eq('case does not matter', D.agentOf('CODEX'), 'codex');
  eq('surrounding space does not matter', D.agentOf('  claude '), 'claude');
  eq('a person is not an agent', D.agentOf('angadh'), '');
  eq('nobody is not an agent', D.agentOf(''), '');
  eq('…nor is nothing at all', D.agentOf(null), '');
  ok('the colour rule agrees with it',
    D.authorColor('claude') === 'var(--claude)' && D.authorColor('codex') === 'var(--codex)');
  ok('…and a person still gets a hue of their own',
    /^oklch\(/.test(D.authorColor('mira')));
}

console.log(`\nenvelope: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail);
