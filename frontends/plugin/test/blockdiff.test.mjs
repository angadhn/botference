#!/usr/bin/env node
// RENDERED PREVIEWS of suggestion cards on a book page — the parts that need
// no browser. preview.mjs (the companion end: a card applied to a scratch
// notebook, the book's script asked for the page, the article cut out) and
// blockdiff.js's pure core (which blocks changed, and where on the live page
// they go). The DOM half — flattening an article, the overlay itself — is
// checked by eye on a real book page.
//
//   node frontends/plugin/test/blockdiff.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as preview from '../preview.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BD = require(path.join(TEST, '..', 'extension', 'blockdiff.js'));

let pass = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
}

// ---- the diff ---------------------------------------------------------------
await test('lcs: identical arrays match one to one', () => {
  assert.deepEqual(BD.lcsPairs(['a', 'b', 'c'], ['a', 'b', 'c']), [[0, 0], [1, 1], [2, 2]]);
});
await test('lcs: a change in the middle leaves head and tail matched', () => {
  assert.deepEqual(BD.lcsPairs(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd']), [[0, 0], [2, 2], [3, 3]]);
});
await test('lcs: an insertion and a deletion', () => {
  assert.deepEqual(BD.lcsPairs(['a', 'b', 'c'], ['a', 'c', 'n']), [[0, 0], [2, 1]]);
});

await test('plan: a changed block is struck where it stands and the new one goes right after it', () => {
  const base = ['h', 'p1', 'p2', 'p3'];
  const card = ['h', 'p1', 'P2', 'p3'];
  const live = ['h', 'p1', 'p2', 'p3'];
  const { hunks, unplaced } = BD.planHunks(base, card, base, live);
  assert.equal(unplaced, 0);
  assert.deepEqual(hunks, [{ remove: [2], add: [2], after: 2, before: -1 }]);
});
await test('plan: a new block goes after the block above it, found on the live page by the loose key', () => {
  const base = ['h', 'p1$x$', 'p2'];
  const card = ['h', 'p1$x$', 'new', 'p2'];
  const loose = ['h', 'p1', 'p2'];
  const live = ['nav', 'h', 'p1', 'p2'];        // the live page has one extra block up top
  const { hunks } = BD.planHunks(base, card, loose, live);
  assert.deepEqual(hunks, [{ remove: [], add: [2], after: 2, before: -1 }]);
});
await test('plan: a cut is struck and adds nothing', () => {
  const base = ['h', 'p1', 'p2'];
  const card = ['h', 'p2'];
  const { hunks } = BD.planHunks(base, card, base, base);
  assert.deepEqual(hunks, [{ remove: [1], add: [], after: 1, before: -1 }]);
});
await test('plan: a block added at the very top goes before the first block on screen', () => {
  const base = ['p1', 'p2'];
  const card = ['new', 'p1', 'p2'];
  const { hunks } = BD.planHunks(base, card, base, base);
  assert.deepEqual(hunks, [{ remove: [], add: [0], after: -1, before: 0 }]);
});
await test('plan: a changed block the live page does not show is UNPLACED, not guessed', () => {
  const base = ['h', 'p1', 'p2'];
  const card = ['h', 'P1', 'p2'];
  const live = ['h', 'stale', 'p2'];            // the live build is behind the notebook
  const { unplaced } = BD.planHunks(base, card, base, live);
  assert.equal(unplaced, 1);
});
await test('plan: the same base on both sides is no change at all', () => {
  const k = ['a', 'b'];
  assert.deepEqual(BD.planHunks(k, k, k, k), { hunks: [], unplaced: 0 });
});

// ---- the companion end ------------------------------------------------------
await test('articleOf: the bd-article, nested articles counted', () => {
  const html = '<html><body><nav>x</nav><article class="bd-article" role="main"><p>a</p>'
    + '<article><p>inner</p></article><p>b</p></article><footer>f</footer></body></html>';
  const got = preview.articleOf(html);
  assert.ok(got.startsWith('<article class="bd-article"'));
  assert.ok(got.endsWith('<p>b</p></article>'));
  assert.equal(preview.articleOf('<article><p>no class</p></article>'), '');
});
await test('pictureRefs: relative pictures only', () => {
  const refs = preview.pictureRefs('<img src="../../_images/a.png"><img src="data:image/png;base64,x">'
    + '<img alt="x" src="https://e.com/b.png"><source src="c.webp">');
  assert.deepEqual(refs, ['../../_images/a.png', 'c.webp']);
});

// A synthetic book: one chapter notebook, and a preview script that "builds"
// by writing the notebook's markdown cells as <p>s into an article.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-preview-'));
const nbFile = path.join(root, 'ch', 'one.ipynb');
fs.mkdirSync(path.dirname(nbFile), { recursive: true });
const nb = {
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Title\n'] },
    { cell_type: 'markdown', metadata: {}, source: ['The orbit is round.\n', '\n', 'It is fast.'] },
  ],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
};
const nbRaw = JSON.stringify(nb, null, 1);
fs.writeFileSync(nbFile, nbRaw);
fs.mkdirSync(path.join(root, 'scripts'));
const out = path.join(root, '.preview', 'html', 'ch');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(root, '.preview', 'html', 'new.png'), Buffer.from([137, 80, 78, 71]));
fs.writeFileSync(path.join(root, 'scripts', 'preview-chapter.sh'), `#!/bin/sh
SRC=\${2:-$1}
node -e '
const nb = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const ps = nb.cells.flatMap(c => [].concat(c.source).join("").split(/\\n\\n+/)).map(t => "<p>" + t.trim() + "</p>");
const pic = ps.some(p => /PIC/.test(p)) ? "<img src=\\"../new.png\\">" : "";
require("fs").writeFileSync(process.argv[2], "<html><body><article class=\\"bd-article\\"><section>" + ps.join("") + pic + "</section></article></body></html>");
' "$SRC" "${out}/one.html"
echo "${out}/one.html"
`);
const bg = { kind: 'jupyterbook', root, source_path: nbFile };

await test('previewScript: found for a book notebook, not for markdown or a book without one', () => {
  assert.equal(preview.previewScript(bg), path.join(root, 'scripts', 'preview-chapter.sh'));
  assert.equal(preview.previewScript({ ...bg, source_path: path.join(root, 'a.md') }), '');
  assert.equal(preview.previewScript({ ...bg, kind: 'jekyll' }), '');
});

await test('renderCard: base and card articles, the card applied, the source untouched', async () => {
  const card = { id: 'sg1', state: 'open', current: 'It is fast.', proposed: 'It is very fast. PIC' };
  const r = await preview.renderCard(bg, card);
  assert.ok(r.ok, r.why);
  assert.match(r.base, /<p>It is fast\.<\/p>/);
  assert.match(r.html, /<p>It is very fast\. PIC<\/p>/);
  assert.equal(fs.readFileSync(nbFile, 'utf8'), nbRaw, 'the notebook was never written');
  assert.deepEqual(Object.keys(r.pictures), ['../new.png'], 'only the card-only picture comes back');
  assert.match(r.pictures['../new.png'], /^data:image\/png;base64,/);
  assert.ok(!fs.existsSync(path.join(root, '.botference', 'plugin', 'preview', 'sg1.ipynb')), 'scratch cleaned up');
});

await test('renderCard: a passage that is not in the notebook is refused, nothing built', async () => {
  const r = await preview.renderCard(bg, { id: 'sg2', state: 'open', current: 'not there', proposed: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.why, /not in the source/);
});

await test('renderCard: an answered card is not previewed', async () => {
  const r = await preview.renderCard(bg, { id: 'sg3', state: 'applied', current: 'It is fast.', proposed: 'x' });
  assert.equal(r.ok, false);
});

await test('renderCardWithin: a slow build answers pending, then the result', async () => {
  const slow = path.join(root, 'scripts', 'preview-chapter.sh');
  const orig = fs.readFileSync(slow, 'utf8');
  fs.writeFileSync(slow, orig.replace('#!/bin/sh\n', '#!/bin/sh\nsleep 1\n'));
  const card = { id: 'sg4', state: 'open', current: 'The orbit is round.', proposed: 'The orbit is an ellipse.' };
  fs.writeFileSync(nbFile, nbRaw + '\n');           // new bytes: nothing cached
  const first = await preview.renderCardWithin(bg, card, 50);
  assert.deepEqual(first, { pending: true });
  const later = await preview.renderCardWithin(bg, card, 10000);
  assert.ok(later.ok, later.why);
  assert.match(later.html, /an ellipse/);
  fs.writeFileSync(slow, orig);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nblockdiff: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
