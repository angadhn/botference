// export-golden.test.mjs — the Obsidian export's output, byte for byte.
//
//   node frontends/plugin/test/export-golden.test.mjs
//   node frontends/plugin/test/export-golden.test.mjs --write   (re-record)
//
// The golden file was recorded from the export as it was BEFORE the Studio
// paste target existed. Adding an export target must not move one byte of what
// the others write, so every case below is rendered and compared with it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-golden-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const { renderNote } = await import('../export.mjs');
const F = await import('./fixtures/export-pages.mjs');
const { me, bot, stamp, webPage, blygPage, gapped, P1, P2 } = F;

const NOW = new Date('2026-11-22T00:00:00Z');
const CONFIGS = {
  defaults: { author: F.READER },
  oldshape: { author: F.READER, quote_style: 'plain', comment_order: 'quote-first', agent_style: 'inline' },
  studiogaps: { author: F.READER, gap_style: 'studio' },
};
const PAGES = {
  web: () => webPage([
    { quote: 'a plain claim', msgs: [me('I doubt it.'), bot('It is contested.'), me('Fine.')] },
    { quote: 'two\n\nparagraphs', msgs: [] },
    { quote: 'struck words', mark: 'strike', msgs: [me('wrong')] },
  ], [me('page level question @claude'), bot('an answer')]),
  blyg: () => blygPage([
    { quote: P1, blyg: stamp(), msgs: [me('Agreed, mostly.'), bot('Noted.')] },
    { quote: P2, blyg: stamp({ passage: { match: false, nearest: P1 } }), msgs: [me('Selected too much.')] },
  ]),
  response: () => blygPage([{ quote: P1, blyg: stamp(), msgs: [me('A reply.')] }], [], { export_response: 'response' }),
  webresponse: () => webPage([{ quote: 'x', msgs: [me('re')] }], [], { export_response: 'response' }),
  gaps: () => webPage([{ quote: 'q', msgs: [gapped('Before.\n\n/tk say it shorter\n\nAfter.', 'The short version.')] }]),
  tkchars: () => webPage([{ quote: 'has [TK] and [[x]] and\n> an arrow', msgs: [me('mine [TK] x [/TK] and [[y]]')] }]),
};
const cases = {};
for (const [pn, page] of Object.entries(PAGES)) {
  for (const [cn, cfg] of Object.entries(CONFIGS)) {
    for (const mode of ['all', 'comments']) {
      cases[`${pn}/${cn}/${mode}`] = renderNote(page(), cfg, NOW, mode, null,
        pn === 'blyg' || pn === 'response' ? { post: { id: F.POST_ID, version: 2, text: P1 + ' ' + P2 } } : {});
    }
  }
}

const file = path.join(here, 'fixtures', 'export-golden.json');
if (process.argv.includes('--write')) {
  fs.writeFileSync(file, JSON.stringify(cases, null, 1) + '\n');
  console.log(`wrote ${Object.keys(cases).length} cases`);
  process.exit(0);
}
const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
ok('the same cases are recorded', JSON.stringify(Object.keys(cases)) === JSON.stringify(Object.keys(golden)));
for (const [name, out] of Object.entries(cases)) ok(`${name}: byte for byte`, out === golden[name], `got\n${out}\nwant\n${golden[name]}`);
console.log(`export-golden: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(fail ? 1 : 0);
