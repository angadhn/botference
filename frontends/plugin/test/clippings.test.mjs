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

test('the canonical source (tracking-v2): utm_* and the fragment removed, other parameters kept as they are; http(s) only', () => {
  assert.equal(C.canonicalSource('https://www.example.com/p/a-post?s=w'), 'https://www.example.com/p/a-post');
  assert.equal(C.canonicalSource('https://www.example.com/p/a?utm_source=x&utm_medium=y&id=7&r=abc#section'), 'https://www.example.com/p/a?id=7');
  assert.equal(C.canonicalSource('https://example.com/a?fbclid=1&gclid=2&page=3&ref=tw'), 'https://example.com/a?fbclid=1&gclid=2&page=3&ref=tw', 'only utm_* on any host');
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
  assert.deepEqual(got[0], { id: C.clippingId('a.md'), title: 'First', author: 'One, Two', source: 'https://www.example.com/p/a-post', published: '2022-03-04', words: 3, rev: got[0].rev });
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

// ---- review: linear text rules, the same output as the regular expressions; the source address v2; reading; the cache ----
// THE REFERENCE: the rule exactly as first built (regular expressions; quadratic on hostile input), to check the linear passes against
function referenceText(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  const body = m ? md.slice(m[0].length) : md;
  const marks = t => String(t).replace(/\\([\\`*_{}[\]()#+\-.!|<>~&])/g, '$1').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[x])
    .replace(/[*~`]/g, '').replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1').replace(/\s+/g, ' ').trim();
  const lines = body.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (/^<.*>$/.test(t)) return null;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return null;
    if (/^(\[)?!\[[^\]]*\]\([^)]*\)(\]\([^)]*\))?$/.test(t)) return null;
    return line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[\^[^\]]+\]:\s*/g, '').replace(/\[\^[^\]]+\]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1').replace(/<\/?[A-Za-z][^>]*>/g, '').replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '');
  });
  const paras = []; let cur = [];
  for (const l of lines) { if (l === null) continue; if (!l.trim()) { if (cur.length) paras.push(cur.join(' ')); cur = []; continue; } cur.push(l); }
  if (cur.length) paras.push(cur.join(' '));
  return paras.map(marks).filter(Boolean).join('\n\n');
}
test('THE LINEAR RULE GIVES THE SAME TEXT as the regular expressions, on 20000 random strings of the characters that matter', () => {
  const alphabet = ['[', ']', '(', ')', '!', '^', ':', '<', '>', '/', 'a', 'b', ' ', '\n', '\n\n', '_', '*', '~', '`', '\\', '&amp;', 'https://', 'http://', '#', '-', '1.', '>', 'x', 'é', '\t', '---'];
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 20000; k++) {
    let s = '';
    const len = 1 + rnd(40);
    for (let i = 0; i < len; i++) s += alphabet[rnd(alphabet.length)];
    assert.equal(C.clippingText(s), referenceText(s), JSON.stringify(s));
  }
});
test('HOSTILE INPUT IS LINEAR: a megabyte of unclosed `[`, `![`, `[^`, `\\[`, `<a `, `](`, backticks, `_` runs, each in milliseconds', () => {
  for (const unit of ['[', '![', '[^', '\\[', '<a ', '](', '`', '**x', ' _a', '_', '[x](', '<https://a', '[^a]', '![a](']) {
    const md = `para ${unit.repeat(Math.ceil(1024 * 1024 / unit.length))} end`;
    const t = Date.now();
    C.clippingText(md);
    assert.ok(Date.now() - t < 1500, `${JSON.stringify(unit)}: ${Date.now() - t} ms`);
  }
});
test('A PAGE IS NOT A FILE: front matter is removed only at the start of the file; a later page beginning `---` keeps its words', () => {
  const page2 = '---\nhidden: words here\n---\nvisible after';
  assert.equal(C.bodyText(page2), 'hidden: words here visible after', 'the `---` lines are only thematic breaks there');
  assert.equal(C.clippingText(page2), 'visible after', 'a whole file: its own front matter');
});
test('THE SOURCE ADDRESS, tracking-v2: utm_* everywhere; Substack\'s own parameters only on Substack; secrets dropped and said; the query not re-encoded', () => {
  const c = u => C.canonicalSource(u);
  assert.equal(c('https://ex.com/?s=apple'), 'https://ex.com/?s=apple', 's kept on another site (a search)');
  assert.equal(c('https://forum.ex/view?post_id=123'), 'https://forum.ex/view?post_id=123');
  assert.equal(c('https://ex.com/a?q=a%20b&utm_source=x'), 'https://ex.com/a?q=a%20b', 'not re-encoded');
  assert.equal(c('https://ex.com/p?amp&utm_medium=e'), 'https://ex.com/p?amp', 'a bare name stays bare');
  assert.equal(c('https://x.substack.com/p/slug?utm_source=email&token=eyJTOKEN&isFreemail=true&r=2a&s=w'), 'https://x.substack.com/p/slug');
  assert.equal(c('https://www.example.com/p/a-post?s=w&r=1x'), 'https://www.example.com/p/a-post', 'a Substack post on its own domain (/p/<slug>)');
  assert.equal(c('https://ex.com/a?id=7&access_token=abc&sig=1#frag'), 'https://ex.com/a?id=7');
  assert.equal(c('https://user:pw@ex.com/a'), '', 'never an address with a user or password');
  assert.deepEqual(C.canonicalSourceOf('https://x.substack.com/p/slug?token=eyJ&utm_source=e').dropped, ['token']);
});
test('READING A FILE: no symlink, one link, at most the cap, from the open file; a hard link to a file elsewhere refused', () => {
  const dir = tmp(), out = tmp();
  fs.writeFileSync(path.join(out, 'secret.md'), clip({ body: 'SECRET' }));
  fs.linkSync(path.join(out, 'secret.md'), path.join(dir, 'hard.md'));
  assert.equal(C.readClipping(dir, 'hard.md').problem, 'not a plain file inside the folder');
  fs.writeFileSync(path.join(dir, 'ok.md'), clip());
  assert.equal(C.readClipping(dir, 'ok.md').problem, '');
});
test('THE CACHE AND rev: a second read of an unchanged file reads nothing; a changed file is read again with a new rev; no title falls back to the address', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.md'), clip());
  const s = { folder: dir, collections: [{ name: 'R', files: ['a.md'] }] };
  const first = C.listClippings(s).collections[0].clippings[0];
  assert.match(first.rev, /^[0-9a-f]{12}$/);
  const reads = C.clippingStats().reads;
  C.listClippings(s); C.findClipping(s, first.id);
  assert.equal(C.clippingStats().reads, reads, 'nothing read again');
  fs.writeFileSync(path.join(dir, 'a.md'), clip({ body: 'Changed words, more of them.' }));
  const second = C.listClippings(s).collections[0].clippings[0];
  assert.notEqual(second.rev, first.rev);
  fs.writeFileSync(path.join(dir, 'Private name.md'), '---\nsource: https://www.example.com/p/the-slug?s=w\n---\nWords.\n');
  const t = C.listClippings({ folder: dir, collections: [{ name: 'R', files: ['Private name.md'] }] }).collections[0].clippings[0];
  assert.equal(t.title, 'the-slug');
  assert.ok(!JSON.stringify(t).includes('Private name'));
});
