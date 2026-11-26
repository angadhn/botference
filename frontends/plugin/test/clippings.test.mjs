// clippings.test.mjs — the owner's clipped articles for the Hub's Reading list (clippings.mjs): the setting and its allow-list, the
// file rules (a plain name inside the folder, no way out, a size cap), the plain-text rule, the canonical source address, the order,
// the pages, and the passage check. Throwaway folders; no network.
//
//   node --test test/clippings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as C from '../clippings.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-clip-')));
const clip = ({ title = 'A Title', source = 'https://www.example.com/p/a-post?s=w', published = '2025-05-07', author = '  - "[[Some Author]]"', body = 'Body words here.' } = {}) =>
  `---\ntitle: ${title}\nsource: ${source}\nauthor:\n${author}\npublished: ${published}\ncreated: 2025-06-06\ntags:\n  - clippings\n---\n${body}\n`;

test('the plain-text rule (clippingText v1): images, HTML lines, links, footnotes, marks, escapes, paragraphs', () => {
  const md = [
    '# A heading',
    '',
    'First *para* with a [link](https://x.example.com/) and a footnote.[^1] And **bold** and `code` and snake_case_word and _em_.',
    'Same paragraph, next line.',
    '',
    '<iframe src="https://datawrapper.example.com/a/" width="730"></iframe>',
    '',
    '![](https://img.example.com/a.png)',
    '',
    '[![alt](https://img.example.com/b.png)](https://img.example.com/b)',
    '',
    '> A quoted line with an ![inline](https://i.example.com/x.png) image and <span>inline html</span>.',
    '',
    '- a list item',
    '1. a numbered item',
    '',
    '[^1]: The footnote text \\*escaped\\* &amp; more.',
    '',
    'Auto <https://auto.example.com/x> link and ~~struck~~.',
  ].join('\n');
  assert.equal(C.clippingText(md), [
    'A heading',
    'First para with a link and a footnote. And bold and code and snake_case_word and em. Same paragraph, next line.',
    'A quoted line with an image and inline html.',
    'a list item 1. a numbered item'.replace('1. ', ''),
    'The footnote text escaped & more.',
    'Auto https://auto.example.com/x link and struck.',
  ].join('\n\n'));
});

test('the canonical source (tracking-v1): tracking parameters and the fragment removed, other parameters kept; http(s) only', () => {
  assert.equal(C.canonicalSource('https://www.example.com/p/a-post?s=w'), 'https://www.example.com/p/a-post');
  assert.equal(C.canonicalSource('https://www.example.com/p/a?utm_source=x&utm_medium=y&id=7&r=abc#section'), 'https://www.example.com/p/a?id=7');
  assert.equal(C.canonicalSource('https://example.com/a?fbclid=1&gclid=2&page=3&ref=tw'), 'https://example.com/a?page=3');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', '']) assert.equal(C.canonicalSource(bad), '', bad);
});

test('the setting: a folder and collections of plain file names; every problem said', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.md'), clip());
  const ok = C.validateClippings({ folder: dir, collections: [{ name: 'Reading', files: ['a.md'] }] });
  assert.deepEqual([ok.ok, ok.errors], [true, []]);
  const bad = C.validateClippings({ folder: 'relative/path', collections: [{ name: '', files: ['../x.md', 'a/b.md', 'ok.md', 'ok.md', 7] }, 'x'] });
  assert.equal(bad.ok, false);
  for (const re of [/folder/, /name/, /\.\.\/x\.md/, /a\/b\.md/, /more than once/, /collection 2/]) assert.ok(bad.errors.some(e => re.test(e)), `${re}: ${bad.errors.join(' | ')}`);
  assert.equal(C.validateClippings(undefined).ok, false);
});

test('a file is read only as a plain name inside the folder: no symlink out, no other file, a size cap', () => {
  const dir = tmp(), out = tmp();
  fs.writeFileSync(path.join(out, 'secret.md'), clip({ body: 'SECRET' }));
  fs.symlinkSync(path.join(out, 'secret.md'), path.join(dir, 'link.md'));
  fs.writeFileSync(path.join(dir, 'big.md'), clip({ body: 'x'.repeat(C.CLIPPING_LIMITS.fileBytes) }));
  fs.writeFileSync(path.join(dir, 'good.md'), clip());
  fs.mkdirSync(path.join(dir, 'sub.md'));
  assert.equal(C.readClipping(dir, 'link.md').problem, 'not a plain file inside the folder');
  assert.equal(C.readClipping(dir, 'big.md').problem, `larger than ${C.CLIPPING_LIMITS.fileBytes} bytes`);
  assert.equal(C.readClipping(dir, 'sub.md').problem, 'not a plain file inside the folder');
  assert.equal(C.readClipping(dir, 'missing.md').problem, 'not there');
  assert.equal(C.readClipping(dir, '../secret.md').problem, 'not a plain file name');
  assert.equal(C.readClipping(dir, 'good.md').problem, '');
});

test('the list: allow-listed files only, each with its id (never the name), facts, oldest first; a broken one left out', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'b.md'), clip({ title: 'Second', published: '2025-05-15' }));
  fs.writeFileSync(path.join(dir, 'a.md'), clip({ title: 'First', published: '2022-03-04', author: '  - "[[One]]"\n  - "[[Two]]"' }));
  fs.writeFileSync(path.join(dir, 'nosource.md'), '---\ntitle: X\n---\nbody\n');
  fs.writeFileSync(path.join(dir, 'unlisted.md'), clip({ title: 'Not on the list' }));
  const list = C.listClippings({ folder: dir, collections: [{ name: 'Reading', files: ['b.md', 'a.md', 'nosource.md', 'gone.md'] }] });
  assert.equal(list.collections.length, 1);
  const got = list.collections[0].clippings;
  assert.deepEqual(got.map(c => c.title), ['First', 'Second']);
  assert.deepEqual(got[0], { id: C.clippingId('a.md'), title: 'First', author: 'One, Two', source: 'https://www.example.com/p/a-post', published: '2022-03-04', words: 3 });
  assert.equal(C.clippingId('a.md'), crypto.createHash('sha256').update('a.md').digest('hex').slice(0, 16));
  assert.ok(!JSON.stringify(list).includes('a.md') && !JSON.stringify(list).includes(dir), 'no names, no paths');
  assert.deepEqual(list.problems.map(p => p.problem).sort(), ['no usable source', 'not there']);
  assert.equal(C.findClipping({ folder: dir, collections: [{ name: 'Reading', files: ['a.md'] }] }, C.clippingId('unlisted.md')), null, 'not on the list: not found');
});

test('pages: at most 40000 characters of markdown each, split at blank lines; text is the plain form of the same page', () => {
  const para = n => `Paragraph ${n} ${'word '.repeat(2000)}`.trim();
  const body = Array.from({ length: 8 }, (_, i) => para(i)).join('\n\n');
  const pages = C.pagesOf(body);
  assert.ok(pages.length >= 2);
  assert.ok(pages.every(p => p.length <= C.CLIPPING_LIMITS.pageChars));
  assert.equal(pages.join('\n\n'), body, 'nothing lost or added');
  const long = 'x'.repeat(C.CLIPPING_LIMITS.pageChars * 2 + 5);
  assert.deepEqual(C.pagesOf(long).map(p => p.length), [C.CLIPPING_LIMITS.pageChars, C.CLIPPING_LIMITS.pageChars, 5]);
});

test('the passage check: against the plain text, the quote through the same marks rules; long enough; across paragraphs', () => {
  const text = C.clippingText('One *emphasised* sentence about ships and [yards](https://x.example.com/).\n\nThe next paragraph begins here.');
  assert.equal(C.passageInClipping(text, 'One emphasised sentence about ships'), true);
  assert.equal(C.passageInClipping(text, 'One *emphasised* sentence'), true, 'a quote with the marks still matches');
  assert.equal(C.passageInClipping(text, 'about ships and yards.\nThe next paragraph'), true, 'across paragraphs');
  assert.equal(C.passageInClipping(text, 'not in the text at all, no'), false);
  assert.equal(C.passageInClipping(text, 'ships'), false, 'too short to say where it is from');
});

// ---- the CLI ----
import { main as cli } from '../clippings-cli.mjs';
test('botference clippings check | list: names the config file, says every problem, lists ids and facts; usage otherwise', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.md'), clip({ title: 'First' }));
  const run = (argv, setting) => { const out = []; const code = cli(argv, { config: () => ({ clippings: setting }), configPath: '/x/config.json', say: s => out.push(s) }); return { code, text: out.join('\n') }; };
  const good = { folder: dir, collections: [{ name: 'Reading', files: ['a.md'] }] };
  const c = run(['check'], good);
  assert.equal(c.code, 0, c.text);
  assert.match(c.text, /config file: \/x\/config\.json/);
  assert.match(c.text, /Valid: 1 collection, 1 of 1 files read/);
  const l = run(['list'], good);
  assert.match(l.text, new RegExp(`${C.clippingId('a.md')}  2025-05-07 .* First  <https://www.example.com/p/a-post>`));
  const missing = run(['check'], { folder: dir, collections: [{ name: 'Reading', files: ['a.md', 'gone.md'] }] });
  assert.equal(missing.code, 1);
  assert.match(missing.text, /left out: Reading \/ gone\.md: not there/);
  const bad = run(['check'], { folder: 'nope', collections: [] });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /not valid/);
  assert.equal(run(['dance'], good).code, 2);
});
