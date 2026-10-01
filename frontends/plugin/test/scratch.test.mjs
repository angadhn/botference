#!/usr/bin/env node
// A blog or book turn's produced files — the site's own scratch folder, the
// placement rule the envelope carries, and the turn-end safety net that puts
// a proposed picture into the book. See blog.mjs "the scratch folder" and
// scratch.mjs.
//
// THE REPORT these hold to: on a Jupyter Book chapter the bots redrew a
// figure, every file of it (SVG, PNG, the python, previews, a fig1-copy.sh)
// landed in the BOTFERENCE repo under projects/plugin-pages/artifacts/, and
// the reader was asked to cp the pictures into the book. Everything here
// runs against synthetic repos in a temp dir; nothing is bridged.
//
//   node frontends/plugin/test/scratch.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const made = [];
const tmp = tag => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bfp-scratch-${tag}-`)));
  made.push(d);
  return d;
};
// config.json (blog_sites, blog_roots) lives under the companion's ROOT, which
// is fixed when store.mjs loads: a throwaway one, never the developer's
const OWN_ROOT = tmp('own');
process.env.BOTFERENCE_PROJECT_ROOT = OWN_ROOT;
// …and never the developer's real project registry (markers.mjs)
process.env.BOTFERENCE_SITES_REGISTRY = path.join(OWN_ROOT, 'sites.json');
const blog = await import(path.join(PLUGIN, 'blog.mjs'));
const scratch = await import(path.join(PLUGIN, 'scratch.mjs'));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')}`); }
}
const w = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
function book(tag) {
  const root = tmp(tag);
  w(root, '_config.yml', 'title: A Book\n');
  w(root, '_toc.yml', 'format: jb-book\nroot: intro\nchapters:\n- file: Lecture1/ch1\n');
  w(root, 'intro.md', '# Welcome\n');
  w(root, 'Lecture1/ch1.md', '# One\n\n```{figure} images/L1_6.png\nThe orbit.\n```\n');
  w(root, 'Lecture1/images/L1_6.png', 'the reader’s own picture');
  return root;
}

console.log('scratch — where a site turn’s files go');

await test('the scratch folder is inside the reader’s repo, never under the Botference repo', async () => {
  const root = book('derive');
  const dir = blog.scratchDir(root);
  assert.equal(dir, path.join(root, '.botference', 'plugin', 'artifacts'));
  assert.ok(path.relative(REPO, dir).startsWith('..'), `not under ${REPO}: ${dir}`);
  assert.ok(!dir.includes(path.join('projects', 'plugin-pages')));
});

await test('the key is stable, readable and different per root', async () => {
  const a = book('key-a');
  const b = book('key-b');
  assert.equal(blog.scratchKey(a), blog.scratchKey(a));
  assert.equal(blog.scratchKey(a), blog.scratchKey(a + '/'), 'a trailing slash is the same root');
  assert.notEqual(blog.scratchKey(a), blog.scratchKey(b));
  assert.match(blog.scratchKey(a), /^bfp-scratch-key-a-[a-z0-9]+-[0-9a-f]{10}$/);
  assert.equal(blog.scratchLink(a), `/files/site-artifacts/${blog.scratchKey(a)}`);
});

await test('ensureScratch makes the folder and gitignores .botference/ exactly once', async () => {
  const root = book('gi');
  fs.writeFileSync(path.join(root, '.gitignore'), '_build/');            // no trailing newline
  const dir = scratch.ensureScratch(root);
  assert.equal(dir, blog.scratchDir(root));
  assert.ok(fs.statSync(dir).isDirectory());
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '_build/\n.botference/\n');
  scratch.ensureScratch(root);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '_build/\n.botference/\n',
    'never duplicated');
});

await test('…leaves an existing form of the line alone, and creates a .gitignore only when none', async () => {
  const has = book('gi-has');
  fs.writeFileSync(path.join(has, '.gitignore'), '.ipynb_checkpoints/\nbotference/\n.botference/\n_build/\n');
  assert.equal(scratch.ensureGitignore(has), false);
  const slash = book('gi-slash');
  fs.writeFileSync(path.join(slash, '.gitignore'), '/.botference\n');
  assert.equal(scratch.ensureGitignore(slash), false);
  const none = book('gi-none');
  assert.equal(scratch.ensureGitignore(none), true);
  assert.equal(fs.readFileSync(path.join(none, '.gitignore'), 'utf8'), '.botference/\n');
});

await test('pictureRefs reads the forms the drawer reads', async () => {
  assert.deepEqual(scratch.pictureRefs('images/L1_6-vector.svg'), ['images/L1_6-vector.svg'], 'a bare path');
  assert.deepEqual(scratch.pictureRefs('![orbit](/assets/images/o.png "t")'), ['/assets/images/o.png']);
  assert.deepEqual(scratch.pictureRefs('```{figure} images/a.png\n:width: 60%\nCap.\n```'), ['images/a.png']);
  assert.deepEqual(scratch.pictureRefs('<img src="imgs/x.webp" alt="x">'), ['imgs/x.webp']);
  assert.deepEqual(scratch.pictureRefs('see images/a.png for more'), [], 'a path in a sentence is a word');
  assert.deepEqual(scratch.pictureRefs('![x](https://e.com/a.png)'), [], 'a url is not a path');
});

// the turn-end safety net, over a registered and confirmed book
{
  const root = book('place');
  blog.addSite({ serve_origin: 'http://localhost:8191', root });
  blog.setRootState(root, true);
  const bg = blog.blogPageFor('http://localhost:8191/Lecture1/ch1.html');
  const dir = scratch.ensureScratch(root);
  const card = (proposed, extra = {}) => ({ id: 'c', state: 'open', current: 'images/L1_6.png', proposed, ...extra });

  await test('the page record resolves (fixture sanity)', async () => {
    assert.ok(bg && bg.source_path, JSON.stringify(bg));
    assert.equal(bg.rel, 'Lecture1/ch1.md');
  });

  await test('a proposed picture missing from the book but in scratch is copied into place', async () => {
    w(dir, 'fig1/L1_6-vector.svg', '<svg>new</svg>');
    const placed = scratch.placeFromScratch(bg, [card('images/L1_6-vector.svg')]);
    assert.deepEqual(placed, [{ rel: 'Lecture1/images/L1_6-vector.svg', from: 'fig1/L1_6-vector.svg' }]);
    assert.equal(fs.readFileSync(path.join(root, 'Lecture1', 'images', 'L1_6-vector.svg'), 'utf8'), '<svg>new</svg>');
    assert.equal(scratch.placedNote(placed), 'placed Lecture1/images/L1_6-vector.svg from scratch');
  });

  await test('a picture in neither place is left alone (nothing to place)', async () => {
    assert.deepEqual(scratch.placeFromScratch(bg, [card('images/nowhere.png')]), []);
    assert.ok(!fs.existsSync(path.join(root, 'Lecture1', 'images', 'nowhere.png')));
  });

  await test('an existing book file is NEVER overwritten by a scratch file of the same name', async () => {
    w(dir, 'L1_6.png', 'a draft that must not win');
    assert.deepEqual(scratch.placeFromScratch(bg, [card('images/L1_6.png', { current: 'old.png' })]), []);
    assert.equal(fs.readFileSync(path.join(root, 'Lecture1', 'images', 'L1_6.png'), 'utf8'),
      'the reader’s own picture');
  });

  await test('only OPEN cards that propose, inside the root and outside dot/build folders, count', async () => {
    w(dir, 'escape.png', 'x');
    w(dir, 'built.png', 'x');
    w(dir, 'gone.png', 'x');
    const plan = scratch.scratchPlan(bg, [
      card('../../escape.png'),
      card('/../escape.png'),
      card('/_build/html/built.png'),
      card('/.git/built.png'),
      card('images/gone.png', { state: 'rejected' }),
      card('', { deletes: true }),
      { id: 'u', state: 'unreadable', error: 'x' },
    ]);
    assert.deepEqual(plan, []);
  });

  await test('a new sub-folder for the picture is made inside the chapter', async () => {
    w(dir, 'orbit-v2.png', 'v2');
    const placed = scratch.placeFromScratch(bg, [card('```{figure} figs/orbit-v2.png\nCap.\n```')]);
    assert.deepEqual(placed.map(p => p.rel), ['Lecture1/figs/orbit-v2.png']);
  });

  await test('/files/site-artifacts/<key>/… serves a confirmed site’s scratch and nothing else', async () => {
    w(dir, 'preview.png', 'p');
    const key = blog.scratchKey(root);
    assert.equal(scratch.scratchFilesPath(`site-artifacts/${key}/preview.png`), path.join(dir, 'preview.png'));
    assert.equal(scratch.scratchFilesPath(`site-artifacts/${key}/fig1/L1_6-vector.svg`),
      path.join(dir, 'fig1', 'L1_6-vector.svg'));
    assert.equal(scratch.scratchFilesPath(`site-artifacts/${key}/..%2F..%2F_config.yml`), '');
    assert.equal(scratch.scratchFilesPath(`site-artifacts/${key}/.hidden`), '');
    assert.equal(scratch.scratchFilesPath('site-artifacts/nobody-0123456789/preview.png'), '');
    blog.setRootState(root, false);
    assert.equal(scratch.scratchFilesPath(`site-artifacts/${key}/preview.png`), '', 'a declined root serves nothing');
    blog.setRootState(root, true);
  });

  await test('the book envelope names the image folder, the scratch folder, and forbids the copy step', async () => {
    const block = blog.blogBlock(bg);
    assert.ok(block.includes(`${root}/Lecture1/images/`), 'the absolute image folder, from the resolver');
    assert.ok(block.includes(`${dir}/`), 'the absolute scratch folder');
    assert.ok(block.includes(`${blog.scratchLink(root)}/<name>`), 'how to link a scratch file');
    assert.match(block, /you place it there YOURSELF/);
    assert.match(block, /never ask the reader to copy/);
    assert.match(block, /projects\/<id>\/artifacts\//, 'the general convention is named and overridden');
    assert.ok(!block.includes(REPO + '/projects'), 'and the Botference repo is never offered');
  });

  await test('the summon placement rule names both folders and the copy ban', async () => {
    const s = blog.summonPlacement(root, 'jupyterbook');
    assert.ok(s.includes(`${dir}/`));
    assert.match(s, /Jupyter Book/);
    assert.match(s, /beside the chapter/);
    assert.match(s, /never leave the reader a copy step/);
    assert.match(s, /never run git/);
    assert.equal(blog.summonPlacement(''), '');
  });
  blog.removeSite('http://localhost:8191');
}

await test('the Jekyll envelope carries the same placement rule', async () => {
  const root = tmp('jk');
  w(root, '_config.yml', 'title: T\n');
  w(root, '_posts/2026-01-01-a.md', '---\ntitle: A\n---\n\nHello.\n');
  fs.mkdirSync(path.join(root, 'assets', 'images'), { recursive: true });
  blog.addSite({ serve_origin: 'http://localhost:8192', root });
  blog.setRootState(root, true);
  const bg = blog.blogPageFor('http://localhost:8192/2026/01/01/a.html');
  assert.ok(bg && bg.source_path, JSON.stringify(bg));
  const block = blog.blogBlock(bg);
  assert.ok(block.includes(`${root}/assets/`), block.slice(0, 400));
  assert.ok(block.includes(blog.scratchDir(root)));
  assert.match(block, /WHERE YOUR FILES GO/);
  blog.removeSite('http://localhost:8192');
});

for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
