// tkgrammar.test.mjs — where a reader's message asks an agent for a passage.
//
//   node frontends/plugin/test/tkgrammar.test.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = createRequire(import.meta.url)(path.join(here, '..', 'extension', 'tkgrammar.js'));

let pass = 0, fail = 0;
const failures = [];
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; failures.push(`${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
};
const gaps = s => T.parseGaps(s).map(g => [g.form, g.instruction, s.slice(g.start, g.end)]);

eq('own line', gaps('My view.\n/tk explain the passage\nMore.'),
  [['line', 'explain the passage', '/tk explain the passage']]);
eq('own line, a few spaces in', gaps('   /tk say more'), [['line', 'say more', '/tk say more']]);
eq('own line needs an instruction', gaps('/tk\n/tk   '), []);
eq('inline', gaps('It is /tk(two words) really.'), [['inline', 'two words', '/tk(two words)']]);
eq('inline, nested brackets', gaps('see /tk(a summary (short) please) ok'), [['inline', 'a summary (short) please', '/tk(a summary (short) please)']]);
eq('inline at the start of a line, and after an opening bracket', gaps('/tk(one)\n(/tk(two))'),
  [['inline', 'one', '/tk(one)'], ['inline', 'two', '/tk(two)']]);
eq('inline never crosses a line', gaps('a /tk(unclosed\nb)'), []);
eq('glued to a word: not a gap', gaps('http://example.org/a/tk(x) and x/tk(y)'), []);
eq('several gaps, in order (the bracket form is not one)', gaps('/tk first\nmid /tk(second) and [TK] third [/TK]'),
  [['line', 'first', '/tk first'], ['inline', 'second', '/tk(second)']]);
eq('the bracket form is never a gap in what is typed', gaps('[tk] say\nmore [/Tk]'), []);
eq('…but a STORED message whose gaps were made from it reads it (gapsFor)', T.gapsFor('[TK] old [/TK] and /tk(new)', [{ instruction: 'old' }, { instruction: 'new' }]).map(g => [g.form, g.instruction]),
  [['studio', 'old'], ['inline', 'new']]);
eq('…and only then', T.gapsFor('[TK] old [/TK] and /tk(new)', [{ instruction: 'new' }]).map(g => [g.form, g.instruction]), [['inline', 'new']]);
const named = s => T.parseGaps(s).map(g => [g.form, g.kind, g.agent, g.instruction]);
eq('/tk-claude and /tk-codex, line and inline; plain /tk is Claude', named('/tk-codex write it\nand /tk-claude(a) /tk(b) /TK-CODEX(c)'),
  [['line', 'ask', 'codex', 'write it'], ['inline', 'ask', 'claude', 'a'], ['inline', 'ask', 'claude', 'b'], ['inline', 'ask', 'codex', 'c']]);
eq('/tkimpyrt-claude and /tkimpyrt-codex: pasted text, line and inline', named('/tkimpyrt-claude pasted line\nsee /tkimpyrt-codex(pasted (with) brackets) ok'),
  [['line', 'impyrt', 'claude', 'pasted line'], ['inline', 'impyrt', 'codex', 'pasted (with) brackets']]);
eq('an unknown agent is not a gap; a glued word is not one', named('/tk-gemini(x) and /tk-claudex(y) and a/tk-codex(z)'), []);
eq('in an inline code span: not a gap', gaps('type `/tk(x)` or `/tk y`'), []);
eq('in a fenced block: not a gap', gaps('```\n/tk explain\n```'), []);
eq('backslash: the letters', gaps('write \\/tk(x) literally\n\\/tk not this'), []);
eq('…and the backslash goes once the gaps are found', T.unescape('write \\/tk(x), but `\\/tk` in code'), 'write /tk(x), but `\\/tk` in code');
eq('at most eight', T.parseGaps(Array.from({ length: 12 }, (_, i) => `/tk(g${i})`).join(' ')).length, 8);
for (const f of failures) console.log('  FAIL ' + f);
console.log(`tkgrammar: ${pass} passed, ${fail} failed`);
process.exit(fail);
