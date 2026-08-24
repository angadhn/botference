// more.test.mjs — the "▸ more" marker: `<!--more-->` on its own line splits a
// bot's capped answer from the long version folded behind it.
//
//   node frontends/plugin/test/more.test.mjs
//
// Three things are asserted here, and they are the whole of the feature's
// correctness outside the browser:
//
//   1. the parser itself — where it splits, where it must NOT (a marker inside
//      a fenced code block is code: fence ordinals are the Run button's
//      address, and eating one would move every block after it);
//   2. the three copies agree, byte for byte in source and answer for answer
//      in behaviour: more.mjs (companion), extension/drawer.js (drawer) and
//      reader.js (phone). The extension cannot import from the server and the
//      phone's script has no build step — the same duplication normUrl and
//      tagHue carry, pinned the same way;
//   3. the vault gets the WHOLE answer. An export that kept only the head
//      would silently lose the half the reader asked to see.
//
// Exit code is the number of failures.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(here, '..');
// export.mjs → store.mjs resolves a workspace at import time; a throwaway keeps
// even an accidental write out of the live .botference
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-more-'));

const Drawer = createRequire(import.meta.url)(path.join(plugin, 'extension', 'drawer.js'));
const More = await import(path.join(plugin, 'more.mjs'));
const views = await import(path.join(plugin, 'views.mjs'));
const exp = await import(path.join(plugin, 'export.mjs'));
const chat = await import(path.join(plugin, 'chat.mjs'));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));

const split = More.splitMore;
const strip = More.stripMore;

// ---- 1. the parser ----------------------------------------------------------
{
  eq('a reply with no marker is all head',
    split('just the one sentence.'), { head: 'just the one sentence.', more: '' });
  eq('…and is handed back untouched, whitespace and all',
    split('a\n\n  b  \n').head, 'a\n\n  b  \n');
  eq('the empty message is not a crash', split(''), { head: '', more: '' });
  eq('…nor is a non-string', split(null), { head: '', more: '' });

  eq('the marker splits head from tail',
    split('short answer.\n\n<!--more-->\n\nthe long version.'),
    { head: 'short answer.', more: 'the long version.' });
  eq('…with the blank lines around it closed up on both sides',
    split('short.\n\n\n<!--more-->\n\n\nlong.\n\n').more, 'long.');
  eq('inner spaces and case are tolerated (models retype it)',
    split('a\n<!--  MORE  -->\nb'), { head: 'a', more: 'b' });
  eq('…and so is leading indentation',
    split('a\n   <!--more-->\nb'), { head: 'a', more: 'b' });
  eq('a marker with words on its line is prose, not a marker',
    split('a\nsee <!--more--> below\nb').more, '');

  eq('a SECOND marker does not split again — it is dropped from the tail',
    split('a\n<!--more-->\nb\n<!--more-->\nc'), { head: 'a', more: 'b\nc' });
  eq('a marker with nothing after it folds nothing',
    split('all of it.\n\n<!--more-->\n\n  \n'), { head: 'all of it.', more: '' });
  eq('…and a marker with nothing BEFORE it folds nothing either — the reply is the reply',
    split('<!--more-->\nthe whole answer.'), { head: 'the whole answer.', more: '' });

  eq('CRLF is normalized before anything else',
    split('a\r\n<!--more-->\r\nb'), { head: 'a', more: 'b' });

  // the load-bearing negative: a marker inside a fence is CODE
  const fenced = 'wordpress uses this:\n\n```html\n<!--more-->\n```\n\nthat is all.';
  eq('a marker inside a fenced block never splits', split(fenced), { head: fenced, more: '' });
  eq('…nor inside a tilde fence',
    split('a\n~~~\n<!--more-->\n~~~\nb').more, '');
  eq('…and a REAL marker after a closed fence still does',
    split('a\n```\n<!--more-->\n```\nb\n<!--more-->\nc'),
    { head: 'a\n```\n<!--more-->\n```\nb', more: 'c' });
  eq('an unterminated fence swallows the rest, marker included (it is code)',
    split('a\n```\nb\n<!--more-->\nc').more, '');
  eq('a longer closing fence closes a shorter opening one',
    split('a\n```\nx\n`````\n<!--more-->\nb').more, 'b');

  // the tail is whole markdown, not a paragraph
  eq('the tail keeps its structure', split('head\n<!--more-->\n## deep\n\n- one\n- two').more,
    '## deep\n\n- one\n- two');
}

// ---- 2. stripMore: nothing is lost ------------------------------------------
{
  eq('stripping gives back both halves with the seam closed',
    strip('short.\n\n<!--more-->\n\nlong.'), 'short.\n\nlong.');
  eq('…and an unmarked message unchanged', strip('plain.'), 'plain.');
  eq('…and every stray marker gone',
    strip('a\n<!--more-->\nb\n<!--more-->\nc'), 'a\n\nb\nc');
  ok('nothing that was written is dropped',
    strip('one\n<!--more-->\ntwo\nthree').includes('two')
    && strip('one\n<!--more-->\ntwo\nthree').includes('three'));
  ok('no marker survives a strip', !/<!--\s*more\s*-->/i.test(strip('a\n<!--more-->\nb')));
}

// ---- 3. the three copies agree ----------------------------------------------
// Source first: the block between the ⟦more⟧ sentinels, dedented, must be the
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
    const a = src.indexOf('⟦more⟧ begin'), b = src.indexOf('⟦more⟧ end');
    if (a < 0 || b < 0) return null;
    return dedent(src.slice(src.lastIndexOf('\n', a) + 1, b));
  };
  const files = {
    'more.mjs': path.join(plugin, 'more.mjs'),
    'drawer.js': path.join(plugin, 'extension', 'drawer.js'),
    'reader.js': path.join(plugin, 'reader.js'),
  };
  const blocks = {};
  for (const [name, file] of Object.entries(files)) {
    blocks[name] = blockOf(file);
    ok(`${name} carries the sentinelled block`, !!blocks[name]);
  }
  ok('drawer.js’s copy is the companion’s, character for character',
    blocks['drawer.js'] === blocks['more.mjs'],
    'they have drifted — fix the copy, do not fix the test');
  ok('reader.js’s copy is the companion’s, character for character',
    blocks['reader.js'] === blocks['more.mjs'],
    'they have drifted — fix the copy, do not fix the test');

  // …and behaviour, through the two that node can actually call
  const cases = ['', 'plain', 'a\n<!--more-->\nb', 'a\n```\n<!--more-->\n```\nb',
    '<!--more-->\nx', 'a\n<!-- MORE -->\nb', 'a\n<!--more-->\n', 'a\n<!--more-->\nb\n<!--more-->\nc'];
  for (const c of cases) {
    eq('drawer and companion agree on ' + JSON.stringify(c),
      Drawer.splitMore(c), split(c));
    eq('…and on stripping it', Drawer.stripMore(c), strip(c));
  }
  eq('views.mjs re-exports the one parser rather than owning a fourth',
    views.splitMore === split, true);
}

// ---- 4. what the phone and the reading room draw ----------------------------
{
  const page = {
    url: 'https://x.test/a', title: 'A', threads: [{
      id: 't1', anchor: { quote: 'the passage' },
      msgs: [
        { author: 'angadh', ts: '2026-08-19T10:00:00Z', text: '@claude why?' },
        { author: 'claude', ts: '2026-08-19T10:01:00Z',
          text: 'Because of the rate.\n\n<!--more-->\n\nThe long version: it is the fitted rate, not the raw one.' },
      ],
    }], page_chat: [],
  };
  const html = views.pageView({ page, key: 'k'.repeat(40), me: { owner: true } });
  if (html) {
    ok('the reading room shows the head', html.includes('Because of the rate.'));
    ok('…behind a details/more disclosure', html.includes('class="more"'));
    ok('…which holds the long version', html.includes('The long version'));
    ok('…and never shows the marker itself', !/&lt;!--more--&gt;/.test(html));
  } else {
    ok('views exposes a page renderer to assert on', false, 'no pageView export');
  }
}

// ---- 5. the vault gets everything -------------------------------------------
{
  const page = {
    url: 'https://x.test/a', title: 'The Quiet Machine',
    threads: [{
      id: 't1', anchor: { quote: 'the tram stop' },
      msgs: [
        { author: 'angadh', ts: '2026-08-19T10:00:00Z', text: '@claude why the tram?' },
        { author: 'claude', ts: '2026-08-19T10:01:00Z',
          text: 'It is the only fixed point.\n\n<!--more-->\n\nEvery other landmark in the piece moves between drafts.' },
      ],
    }],
    page_chat: [],
  };
  const note = exp.renderNote(page, { vault_path: '/tmp', export_folder: 'x' });
  if (note) {
    ok('the note keeps the head', note.includes('It is the only fixed point.'));
    ok('the note keeps the folded half — the export is not the truncated answer',
      note.includes('Every other landmark'));
    ok('…and carries no marker into the vault', !/<!--\s*more\s*-->/i.test(note));
  } else {
    ok('export exposes a note renderer to assert on', false,
      'neither renderNote nor noteFor is exported');
  }
}

// ---- 6. the bots are told about it ------------------------------------------
{
  const prompt = fs.readFileSync(path.join(plugin, 'bridge-system-prompt.md'), 'utf8');
  ok('the system prompt names the marker', prompt.includes('<!--more-->'));
  ok('…and says the head must stand alone', /stand alone/i.test(prompt));
  for (const v of ['short', 'long']) {
    ok(`the ${v} length line carries it too (a resumed session may have lost the prompt)`,
      chat.verbosityLine(v).includes('<!--more-->'));
  }
}

console.log(`\n more: ${pass} passed, ${fail} failed`);
if (fail) console.log('\n' + failures.map(f => '  ✗ ' + f).join('\n') + '\n');
process.exit(fail);
