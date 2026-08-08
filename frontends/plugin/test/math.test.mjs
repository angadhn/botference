// math.test.mjs — unit tests for the TeX tokenizer in
// frontends/plugin/extension/drawer.js: which `$`s are maths and which are
// money, where display differs from inline, what happens when a delimiter is
// never closed — and the one companion-side rule that goes with it, that
// Obsidian export hands the vault the RAW source and nothing else.
//
//   node frontends/plugin/test/math.test.mjs
//
// Pure functions only: scanMath/protectMath touch no DOM and no KaTeX, which
// is the whole reason they are separate from the rendering. No framework.
//
// Exit code is the number of failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderNote } from '../export.mjs';

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

const NUL = String.fromCharCode(0);
// the shape a test cares about: what was matched, what TeX came out, and
// whether it is display
const spans = s => D.scanMath(s).map(m => [m.raw, m.tex, m.display]);
const texOf = s => D.scanMath(s).map(m => m.tex);

// ---- 1. the four delimiter pairs -------------------------------------------
{
  eq('inline $…$', spans('mass $E=mc^2$ here'), [['$E=mc^2$', 'E=mc^2', false]]);
  eq('inline \\(…\\)', spans('so \\(a_1 + a_2\\) holds'), [['\\(a_1 + a_2\\)', 'a_1 + a_2', false]]);
  eq('display $$…$$', spans('$$\\int_0^1 x\\,dx$$'), [['$$\\int_0^1 x\\,dx$$', '\\int_0^1 x\\,dx', true]]);
  eq('display \\[…\\]', spans('\\[x^2 + y^2 = z^2\\]'),
    [['\\[x^2 + y^2 = z^2\\]', 'x^2 + y^2 = z^2', true]]);

  eq('several spans in one message, in source order',
    texOf('first $a$ then $$b$$ then \\(c\\) then \\[d\\]'), ['a', 'b', 'c', 'd']);

  // display is the flag the renderer branches on — a block of its own vs a
  // formula sitting in a line of prose
  eq('display vs inline is per span',
    D.scanMath('$a$ and $$b$$ and \\(c\\) and \\[d\\]').map(m => m.display),
    [false, true, false, true]);

  // $$ is allowed to run over lines; the drawer draws it as a block either way
  eq('display math may span lines',
    texOf('before\n$$\n\\alpha \\\\\n\\beta\n$$\nafter'), ['\n\\alpha \\\\\n\\beta\n']);
}

// ---- 2. money is not maths --------------------------------------------------
{
  // the case that made these rules exist
  eq('"costs $5 and $10" is prose', spans('it costs $5 and $10 in total'), []);
  eq('a lone amount is prose', spans('the fee is $12'), []);
  eq('two amounts on one line are prose', spans('$5, $10, $20 — pick one'), []);
  eq('an amount at the very start is prose', spans('$300 is the number'), []);
  eq('"US$5" is prose', spans('US$5 for the report'), []);
  // "…and$10": a closer with no space in front, but a digit right after it
  eq('an amount glued to a word is still prose', spans('costs $5 and$10 more'), []);
  eq('a space after the opening $ disqualifies it', spans('$ x + y$ is not maths'), []);
  eq('a space before the closing $ disqualifies it', spans('$x + y $ is not maths'), []);
  eq('an escaped dollar never opens maths', spans('costs \\$5 for the lot'), []);
  eq('an empty pair is not maths', spans('$$ $$ and $$'), []);

  // …and the same sentence with real maths in it still finds the real maths
  eq('money and maths in one sentence',
    texOf('the $5 fee scales as $n^2$ in the crowd'), ['n^2']);
}

// ---- 3. unterminated maths is left exactly as it was ------------------------
{
  eq('an unclosed $ stays prose', spans('unterminated $x + y and then nothing'), []);
  eq('an unclosed $$ stays prose', spans('start $$x + y and nothing closes it'), []);
  eq('an unclosed \\( stays prose', spans('start \\(x + y with no partner'), []);
  eq('an unclosed \\[ stays prose', spans('start \\[x + y with no partner'), []);

  // the paragraph rule: a single $ may not reach past a blank line to find a
  // partner three paragraphs down
  eq('$ does not close across a paragraph break',
    spans('a $ opener here\n\nand a closer$ down here'), []);
  eq('…but $ closes on a soft-wrapped line',
    texOf('a $x +\ny$ across one line break'), ['x +\ny']);
  eq('…and $$ may cross a blank line',
    texOf('$$a\n\nb$$'), ['a\n\nb']);
}

// ---- 4. code wins over maths ------------------------------------------------
{
  eq('a $ inside a code span is literal', spans('run `echo $5` first'), []);
  eq('a formula inside a code span is literal', spans('the string `$x^2$` verbatim'), []);
  eq('a fenced block is skipped whole',
    spans('```\nlet a = $x$;\ncost = $5;\n```'), []);
  eq('…and maths after the fence still renders',
    texOf('```\n$nope$\n```\nbut $yes$ here'), ['yes']);
  eq('a double-backtick span is skipped too', spans('`` a $b$ c `` done'), []);
  // an unclosed backtick run is not a code span, so what follows is scanned
  eq('an unclosed backtick does not swallow the rest',
    texOf('stray ` tick then $x$'), ['x']);
}

// ---- 5. protectMath: markdown never sees the TeX ----------------------------
{
  // the point of the whole exercise. Every one of these would be mangled by
  // the markdown parser: _ is a subscript, * a multiplication, \\ a newline.
  const src = 'given $a_1 * b_2$ and $$x \\\\ y$$ done';
  const held = D.protectMath(src);
  ok('protectMath removes every TeX character from the text markdown parses',
    !/[_*\\]/.test(held.text), JSON.stringify(held.text));
  eq('…and hands the spans over intact', held.spans.map(s => s.tex),
    ['a_1 * b_2', 'x \\\\ y']);
  eq('…leaving numbered placeholders in source order', held.text,
    'given ' + NUL + '0' + NUL + ' and ' + NUL + '1' + NUL + ' done');
  ok('the placeholder cannot be mistaken for markdown',
    !/^[-*+#>]|`/.test(NUL + '0' + NUL));

  // asterisks and underscores OUTSIDE the maths are still markdown's business
  const mixed = D.protectMath('**bold** and $x^2$ and *em*');
  eq('emphasis around a formula survives untouched', mixed.text,
    '**bold** and ' + NUL + '0' + NUL + ' and *em*');

  // nothing to protect ⇒ the string comes back as it went in
  const plain = D.protectMath('no maths here at all');
  eq('a message with no maths is passed through byte for byte',
    plain.text, 'no maths here at all');
  eq('…with no spans', plain.spans, []);

  // the substitution is reversible: raw slices put back where they came from
  const round = D.protectMath(src);
  let rebuilt = round.text;
  // a function replacement, not a string: "$$" in a String.replace replacement
  // is an escape for a single "$", which would silently eat the delimiters
  round.spans.forEach((s, n) => { rebuilt = rebuilt.replace(NUL + n + NUL, () => s.raw); });
  eq('placeholders round-trip back to the exact source', rebuilt, src);
}

// ---- 6. degenerate input ----------------------------------------------------
{
  eq('empty string', spans(''), []);
  eq('null', spans(null), []);
  eq('undefined', spans(undefined), []);
  eq('a bare dollar', spans('$'), []);
  eq('bare dollars', spans('$$$$'), []);
  // KaTeX will refuse this at render time; the tokenizer's job is only to find
  // it, and the renderer's is to fall back to the raw text
  eq('invalid TeX is still recognised as a span',
    texOf('$\\frobnicate{}$'), ['\\frobnicate{}']);
}

// ---- 7. Obsidian export passes the raw source through -----------------------
// Obsidian typesets maths itself, so the vault must get exactly what was
// typed — an export that escaped a backslash or a dollar would break every
// note it touched.
{
  const tex = 'The rate is $\\lambda_0 = e^{-x}$, so:\n\n$$\\int_0^\\infty e^{-x}\\,dx = 1$$';
  const page = {
    url: 'https://example.com/a', title: 'Rates', site: 'example.com',
    threads: [{ quote: 'the decay is exponential', msgs: [{ author: 'angadh', ts: 'x', text: tex }] }],
    page_chat: [{ author: 'claude', ts: 'y', text: 'In short, $E = mc^2$ and $5 is still $5.' }],
  };
  const note = renderNote(page, { author: 'angadh' }, new Date('2026-08-08T00:00:00Z'));
  ok('export keeps inline $…$ exactly as written', note.includes('$\\lambda_0 = e^{-x}$'), note);
  ok('export keeps display $$…$$ exactly as written',
    note.includes('$$\\int_0^\\infty e^{-x}\\,dx = 1$$'), note);
  ok('export escapes no backslash', !note.includes('\\\\lambda'), note);
  ok('export escapes no dollar', !note.includes('\\$'), note);
  ok('a bot reply keeps its maths and its money alike',
    note.includes('In short, $E = mc^2$ and $5 is still $5.'), note);
}

// ---- report -----------------------------------------------------------------
console.log(`\nmath: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail);
