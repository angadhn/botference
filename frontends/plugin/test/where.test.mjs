// where.test.mjs — WHERE A PASSAGE IS, on a document with no page numbers.
//
//   node frontends/plugin/test/where.test.mjs
//
// A PDF thread stores `page` and every card that shows it says "p. 12". An
// ordinary web page had nothing to say at all, so two cards quoting the same
// sentence from two places in one article were indistinguishable in the panel.
// A thread made on a web page now stores two soft facts instead — `section`
// (the heading it sat under) and `ordinal` of `occurrences` (which copy of the
// words it is) — and this suite pins the three things that makes true:
//
//   1. the formatter itself: what a card, a phone and a note actually read;
//   2. the three copies agree, byte for byte in source and answer for answer in
//      behaviour — store.mjs (companion), extension/drawer.js (drawer) and
//      reader.js (phone), the same duplication `<!--more-->` carries and pinned
//      the same way;
//   3. the note in the vault: the line rides inside the blockquote, and a
//      thread with nothing to say leaves the note exactly as it always was.
//
// Exit code is the number of failures.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..');
// store.mjs resolves a workspace at import time; a throwaway root keeps even an
// accidental write out of the developer's real .botference
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-where-'));

const Drawer = createRequire(import.meta.url)(path.join(plugin, 'extension', 'drawer.js'));
const Store = await import(path.join(plugin, 'store.mjs'));
const exp = await import(path.join(plugin, 'export.mjs'));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));

const parts = Store.whereParts;

// ---- 1. what it reads ------------------------------------------------------
{
  eq('a heading alone', parts({ section: 'Results' }), ['§ Results']);
  eq('…and the same heading with the words repeated',
    parts({ section: 'Results', ordinal: 2, occurrences: 3 }), ['§ Results', '2nd of 3']);
  eq('a repeat under no heading at all', parts({ ordinal: 1, occurrences: 2 }), ['1st of 2']);
  eq('nothing to say says nothing', parts({}), []);
  eq('…and neither does a thread with no fields at all', parts(null), []);
  // one occurrence is not a repeat: "1st of 1" is noise on every card in the
  // panel, which is most of them
  eq('a phrase that occurs once carries no count',
    parts({ section: 'Method', ordinal: 1, occurrences: 1 }), ['§ Method']);
  // a record that has drifted (hand-edited, or an older export) must not print
  // a position that is not in its own range
  eq('an ordinal past its own count is not printed',
    parts({ section: 'Method', ordinal: 4, occurrences: 3 }), ['§ Method']);
  // headings are labels here, not documents
  ok('a heading is collapsed and trimmed',
    parts({ section: '  What the   numbers\n say  ' })[0] === '§ What the numbers say');
  ok('…and cut at 80 characters',
    parts({ section: 'x'.repeat(200) })[0].length === 82, parts({ section: 'x'.repeat(200) })[0].length);

  const nth = Store.nthWord;
  eq('the ordinal words', [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(nth),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
  eq('…and nothing below one', [0, -1, NaN].map(nth), ['', '', '']);
}

// ---- 2. the one line each surface draws ------------------------------------
{
  // the drawer's own wrapper: a paged document says its page, an unpaged one
  // says the heading and the count, and either way nothing to say draws nothing
  eq('a PDF card still says its page', Drawer.whereText({ page: 12, section: 'Results' }), 'p. 12');
  eq('an article card says the heading',
    Drawer.whereText({ section: 'Results', ordinal: 2, occurrences: 3 }), '§ Results · 2nd of 3');
  eq('…and an article card with nothing to say draws nothing', Drawer.whereText({}), '');
}

// ---- 3. the three copies agree ---------------------------------------------
// Source first: the block between the ⟦where⟧ sentinels, dedented, must be the
// same text in all three files. Indentation is the only licensed difference —
// one copy lives at module scope, two live inside an IIFE.
{
  const dedent = s => {
    const lines = s.split('\n').filter(l => l.trim());
    const pad = Math.min(...lines.map(l => l.length - l.replace(/^\s+/, '').length));
    return s.split('\n').map(l => l.slice(pad)).join('\n').trim();
  };
  const blockOf = file => {
    const src = fs.readFileSync(file, 'utf8');
    const a = src.indexOf('⟦where⟧ begin'), b = src.indexOf('⟦where⟧ end');
    if (a < 0 || b < 0) return null;
    return dedent(src.slice(src.lastIndexOf('\n', a) + 1, b));
  };
  const files = {
    'store.mjs': path.join(plugin, 'store.mjs'),
    'drawer.js': path.join(plugin, 'extension', 'drawer.js'),
    'reader.js': path.join(plugin, 'reader.js'),
  };
  const blocks = {};
  for (const [name, file] of Object.entries(files)) {
    blocks[name] = blockOf(file);
    ok(`${name} carries the sentinelled block`, !!blocks[name]);
  }
  ok('drawer.js’s copy is the companion’s, character for character',
    blocks['drawer.js'] === blocks['store.mjs'],
    'they have drifted — fix the copy, do not fix the test');
  ok('reader.js’s copy is the companion’s, character for character',
    blocks['reader.js'] === blocks['store.mjs'],
    'they have drifted — fix the copy, do not fix the test');

  // …and behaviour, through the two that node can actually call
  const cases = [null, {}, { section: 'A' }, { ordinal: 2, occurrences: 2 },
    { section: 'A', ordinal: 3, occurrences: 4 }, { section: '  a  b  ', ordinal: 1, occurrences: 1 },
    { section: 'A', ordinal: 21, occurrences: 30 }, { page: 4 }];
  for (const c of cases) {
    eq('drawer and companion agree on ' + JSON.stringify(c),
      Drawer.whereParts(c), parts(c));
  }
  for (const n of [0, 1, 2, 3, 4, 11, 13, 21, 112]) {
    eq('…and on the ordinal word for ' + n, Drawer.nthWord(n), Store.nthWord(n));
  }
}

// ---- 4. what the record keeps ----------------------------------------------
// Written only when it is not the default, the same rule `mark` and `page` obey:
// an article's record on disk is the one it always was until a heading or a
// repeat actually exists to record.
{
  const page = { url: 'https://x.test/a', threads: [] };
  const add = extra => Store.addThread(page, {
    quote: 'q', prefix: 'p', suffix: 's', text: 'hello', author: 'angadh', ...extra });

  const bare = add({});
  ok('a passage under no heading, occurring once, stores nothing new',
    !('section' in bare) && !('ordinal' in bare) && !('occurrences' in bare),
    JSON.stringify(bare));

  const full = add({ section: '  Results  ', ordinal: 2, occurrences: 3 });
  eq('a heading is stored, collapsed', full.section, 'Results');
  eq('…and the position with it', [full.ordinal, full.occurrences], [2, 3]);

  const one = add({ section: 'Method', ordinal: 1, occurrences: 1 });
  ok('one occurrence is not a position, and is not written down',
    one.section === 'Method' && !('ordinal' in one) && !('occurrences' in one), JSON.stringify(one));

  const junk = add({ section: { evil: 1 }, ordinal: 'two', occurrences: -3 });
  ok('nonsense is dropped rather than stored',
    !('ordinal' in junk) && !('occurrences' in junk), JSON.stringify(junk));

  const past = add({ ordinal: 9, occurrences: 3 });
  ok('an ordinal past its own count is not stored',
    !('ordinal' in past) && !('occurrences' in past), JSON.stringify(past));

  const long = add({ section: 'y'.repeat(300) });
  eq('a heading is cut at 80 characters', long.section.length, 80);
}

// ---- 5. the note in the vault ----------------------------------------------
{
  const note = t => exp.renderNote({
    url: 'https://x.test/a', title: 'A', site: 'x.test',
    created_at: '2026-09-07T10:00:00Z', updated_at: '2026-09-07T10:00:00Z',
    threads: [{ id: 't1', quote: 'the effect is small but real',
      msgs: [{ author: 'angadh', ts: '2026-09-07T10:00:00Z', text: 'why?' }], ...t }],
    page_chat: [],
  }, { author: 'angadh' });

  ok('the note says where the passage was',
    note({ section: 'Results', ordinal: 2, occurrences: 3 }).includes('> (§ Results, 2nd of 3)'),
    note({ section: 'Results', ordinal: 2, occurrences: 3 }));
  ok('…a heading alone is enough', note({ section: 'Results' }).includes('> (§ Results)'));
  ok('…and a thread with nothing to say adds no line at all',
    !/^> \(/m.test(note({})), note({}));
  ok('a PDF thread keeps the page attribution it always had',
    note({ page: 12 }).includes('> — p. 12'));
  ok('…and a PDF thread is never given the other one too',
    !note({ page: 12, section: 'Results' }).includes('§'));
}

if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' where.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
