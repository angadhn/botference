#!/usr/bin/env node
// Blog source pages — the local site and the markdown behind it.
// See SPEC.md "Blog source pages" and blog.mjs.
//
// Everything here runs against a SYNTHETIC Jekyll repo built in a temp dir.
// The developer's real site (…/angadhn.github.io) is never read, never
// written and never bridged against, and the bridge is always the mock, so no
// CLI starts and no network is touched. Nothing here runs git either — there
// is no git to run: the last section asserts that, which is the point.
//
//   node frontends/plugin/test/blog.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHarness, sleep, enc, GET, POST, inputs, listen, request,
} from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

// --- tiny runner ---------------------------------------------------------
// The scaffolding — runner, poller, throwaway root, a companion on a random
// port, JSON over HTTP — is test/harness.mjs, shared with every other suite
// that drives a real server. It was a private copy here, as in eight others.
const {
  test, waitFor, tmp, startServer, cleanup, passed, failures,
} = createHarness({ server: SERVER, tag: 'blog', realpath: true });

// --- fixtures ------------------------------------------------------------

// A Jekyll source tree with everything the mapping has to survive: a
// site-wide permalink template with categories in it, a post that overrides
// it in its own front matter, two collections with different templates, a
// page, an index, images, and a `_site/` full of the rendered copy that must
// never be mapped to and never counted as a change.
function jekyll(tag, { extra = {} } = {}) {
  const root = tmp(tag);
  const w = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  w('_config.yml', [
    'title: A Test Site',
    'permalink: /:categories/:title/',
    'collections:',
    '  opinions:',
    '    output: true',
    '    permalink: /:collection/:title/',
    '  publications:',
    '    output: true',
    '    permalink: /:collection/:path/',
    '',
  ].join('\n'));
  w('_posts/2026-08-20-space-balloons.md', [
    '---',
    'title:  "Space balloons"',
    'date: 2026-08-20 10:00:00',
    'categories:',
    '  - Large Space Stations',
    '  - Inflatables',
    '---',
    '',
    'A balloon in orbit is a pressure vessel that arrived folded.',
    '',
    'The mass saving is the whole argument and it is not a small one.',
    '',
    'A third paragraph, left alone by every test in this file.',
    '',
  ].join('\n'));
  w('_posts/2026-08-21-pinned.md', [
    '---', 'title: Pinned', 'permalink: /pinned-forever/', '---', '', 'Body.', '',
  ].join('\n'));
  w('_opinions/moravec.md', ['---', 'title: "Moravec\'s Paradox"', '---', '', 'Opinion.', ''].join('\n'));
  w('_publications/2012-lagrange.md', ['---', 'title: Lagrange', '---', '', 'Paper.', ''].join('\n'));
  w('_pages/about.md', ['---', 'title: About', 'permalink: /about/', '---', '', 'About me.', ''].join('\n'));
  w('index.md', ['---', 'title: Home', '---', '', 'Welcome.', ''].join('\n'));
  w('assets/images/balloon.png', 'not really a png');
  // the rendered copy: what the reader is LOOKING at, and what nothing may map
  // to or count
  w('_site/index.html', '<h1>Welcome</h1>');
  w('_site/large-space-stations/inflatables/space-balloons/index.html', '<h1>Space balloons</h1>');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  for (const [rel, text] of Object.entries(extra)) w(rel, text);
  return root;
}

// --- server harness ------------------------------------------------------


// blog.mjs pulls in store.mjs, whose ROOT is fixed at import time from the
// environment. Point THIS PROCESS at a throwaway workspace before either is
// loaded: `addSite` and `setRootState` write a config.json, and it must never
// be the developer's own.
const OWN_ROOT = tmp('own-store');
process.env.BOTFERENCE_PROJECT_ROOT = OWN_ROOT;
const blog = await import(path.join(PLUGIN, 'blog.mjs'));

// =========================================================================
console.log('\nblog — reading the repo');

await test('front matter is read, including the list shape categories use', async () => {
  const fm = blog.frontMatter([
    '---', 'title:  "Space balloons"', 'date: 2026-08-20 10:00:00',
    'categories:', '  - Large Space Stations', '  - Inflatables',
    'published: false', '---', '', 'body',
  ].join('\n'));
  assert.equal(fm.title, 'Space balloons');
  assert.deepEqual(fm.categories, ['Large Space Stations', 'Inflatables']);
  assert.equal(fm.published, 'false');
  assert.equal(blog.frontMatter('no front matter here'), null);
  assert.equal(blog.frontMatter('---\nbroken: yes\n'), null, 'an unterminated block is not front matter');
});

await test('an inline list and a quoted scalar both read', async () => {
  const fm = blog.frontMatter("---\ncategories: [Robotics, 'Artificial Intelligence']\ntitle: 'X'\n---\n");
  assert.deepEqual(fm.categories, ['Robotics', 'Artificial Intelligence']);
  assert.equal(fm.title, 'X');
});

await test('_config.yml gives up its permalink template and its collections', async () => {
  const root = jekyll('cfg');
  const cfg = blog.readSiteConfig(root);
  assert.equal(cfg.permalink, '/:categories/:title/');
  assert.deepEqual(Object.keys(cfg.collections).sort(), ['opinions', 'publications']);
  assert.equal(cfg.collections.opinions.permalink, '/:collection/:title/');
});

await test('a repo with neither _config.yml nor _posts/ is not a Jekyll site', async () => {
  const bare = tmp('bare');
  assert.equal(blog.isJekyllRoot(bare), false);
  fs.mkdirSync(path.join(bare, '_posts'));
  assert.equal(blog.isJekyllRoot(bare), true);
});

console.log('\nblog — url to source');

{
  const root = jekyll('map');
  const map = p => blog.resolvePath(root, p);

  await test('the site-wide permalink template resolves a dated post', async () => {
    const r = map('/large-space-stations/inflatables/space-balloons/');
    assert.equal(r.doc.rel, '_posts/2026-08-20-space-balloons.md');
    assert.equal(r.how, 'convention');
  });

  await test('front-matter permalink overrides everything', async () => {
    const r = map('/pinned-forever/');
    assert.equal(r.doc.rel, '_posts/2026-08-21-pinned.md');
    assert.equal(r.how, 'permalink');
    assert.equal(map('/pinned/').doc.rel, '_posts/2026-08-21-pinned.md',
      'the slug fallback still finds it, which is what a stale link needs');
  });

  await test('a collection resolves through its own template', async () => {
    assert.equal(map('/opinions/moravec/').doc.rel, '_opinions/moravec.md');
    assert.equal(map('/publications/2012-lagrange/').doc.rel, '_publications/2012-lagrange.md');
  });

  await test('pages and the index resolve', async () => {
    assert.equal(map('/about/').doc.rel, '_pages/about.md');
    assert.equal(map('/').doc.rel, 'index.md');
  });

  await test('the slug fallback carries a permalink style nobody modelled', async () => {
    const r = map('/2026/08/20/space-balloons/');
    assert.equal(r.doc.rel, '_posts/2026-08-20-space-balloons.md');
    const odd = map('/blog/deep/nesting/space-balloons/');
    assert.equal(odd.doc.rel, '_posts/2026-08-20-space-balloons.md');
    assert.equal(odd.how, 'slug');
  });

  await test('trailing slash, index.html and a query string are one address', async () => {
    for (const p of ['/pinned-forever', '/pinned-forever/', '/pinned-forever/index.html', '/pinned-forever/?x=1']) {
      assert.equal(map(p).doc.rel, '_posts/2026-08-21-pinned.md', p);
    }
  });

  await test('a url that renders from nothing is UNMAPPED, and says so', async () => {
    const r = map('/no-such-post/');
    assert.equal(r.doc, null);
    assert.match(r.why, /no markdown source/);
  });

  await test('two files sharing a slug are ambiguous, not resolved by luck', async () => {
    const twin = jekyll('twin', {
      extra: {
        '_posts/2026-01-01-twins.md': '---\ntitle: One\n---\nA',
        '_opinions/twins.md': '---\ntitle: Two\n---\nB',
      },
    });
    const r = blog.resolvePath(twin, '/somewhere/twins/');
    assert.equal(r.doc, null);
    assert.match(r.why, /share the slug/);
    assert.match(r.why, /_opinions\/twins\.md/);
  });

  await test('nothing under _site/ is ever the source', async () => {
    for (const doc of blog.indexOf(root).docs) {
      assert.ok(!doc.rel.startsWith('_site/'), `${doc.rel} is the rendered copy`);
    }
  });

  await test('a new post is found without restarting anything', async () => {
    assert.equal(map('/brand-new/').doc, null);
    await sleep(15);
    fs.writeFileSync(path.join(root, '_posts', '2026-08-25-brand-new.md'),
      '---\ntitle: Brand new\npermalink: /brand-new/\n---\n\nHot off the keyboard.\n');
    assert.equal(map('/brand-new/').doc.rel, '_posts/2026-08-25-brand-new.md',
      'the index is stamped on directory and file mtimes, so it rebuilds itself');
  });

  await test('a permalink edited INSIDE an existing file is picked up too', async () => {
    await sleep(15);
    fs.writeFileSync(path.join(root, '_posts', '2026-08-25-brand-new.md'),
      '---\ntitle: Brand new\npermalink: /moved-again/\n---\n\nHot off the keyboard.\n');
    assert.equal(map('/moved-again/').doc.rel, '_posts/2026-08-25-brand-new.md');
  });
}

console.log('\nblog — registration');

await test('a site is declared by origin and path, and refuses a folder that is not one', async () => {
  const root = jekyll('reg');
  const bad = blog.addSite({ serve_origin: 'http://localhost:4000', root: path.join(root, 'assets') });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /_config\.yml/);
  assert.equal(blog.addSite({ serve_origin: 'notaurl', root }).ok, false);
  assert.equal(blog.addSite({ serve_origin: 'http://localhost:4000', root: '/nope/nowhere' }).ok, false);
  const good = blog.addSite({ serve_origin: 'http://localhost:4000/some/path', root });
  assert.equal(good.ok, true);
  assert.equal(good.site.serve_origin, 'http://localhost:4000', 'the origin only — a path is not an origin');
  assert.equal(good.site.root, root);
});

await test('a page under a declared origin is a blog page; anything else is not', async () => {
  assert.equal(blog.blogPageFor('https://example.com/space-balloons/'), null);
  assert.equal(blog.blogPageFor('http://localhost:4001/space-balloons/'), null,
    'a different port is a different origin, and there is no wildcard');
  const p = blog.blogPageFor('http://localhost:4000/pinned-forever/');
  assert.ok(p);
  assert.equal(p.rel, '_posts/2026-08-21-pinned.md');
  assert.equal(p.confirmed, false, 'declared is not confirmed');
});

await test('confirming the repo is a separate, kept answer', async () => {
  const root = blog.listSites().find(s => s.serve_origin === 'http://localhost:4000').root;
  assert.equal(blog.rootState(root), '');
  blog.setRootState(root, true);
  assert.equal(blog.rootState(root), 'yes');
  assert.equal(blog.blogPageFor('http://localhost:4000/about/').confirmed, true);
  blog.setRootState(root, false);
  assert.equal(blog.blogPageFor('http://localhost:4000/about/').declined, true);
  blog.setRootState(root, true);
});

await test('an unmappable page under a declared origin is an ANSWER, not a silence', async () => {
  const p = blog.blogPageFor('http://localhost:4000/nothing-here/');
  assert.ok(p, 'still a blog page — the reader is on their own site');
  assert.equal(p.source_path, '');
  assert.match(p.why, /no markdown source/);
});

await test('a local file inside a declared root is a page, and its source is itself', async () => {
  const root = blog.listSites().find(s => s.serve_origin === 'http://localhost:4000').root;
  fs.mkdirSync(path.join(root, 'assets', 'imgs', 'ai-2040'), { recursive: true });
  const scrolly = path.join(root, 'assets', 'imgs', 'ai-2040', 'plan-a-scrolly.html');
  fs.writeFileSync(scrolly, '<h1>Plan A</h1><section class="step">A step.</section>');
  const p = blog.blogPageFor('file://' + scrolly);
  assert.ok(p, 'a file inside the declared root is a blog page');
  assert.equal(p.source_path, blog.realish(scrolly), 'the source IS the file');
  assert.equal(p.rel, 'assets/imgs/ai-2040/plan-a-scrolly.html');
  assert.equal(p.same_file, true, 'there is no rendering step to explain');
  assert.equal(p.mapped_by, 'path');
  assert.equal(p.root, root);
  // …and the markdown of the same repo is still resolved exactly as before
  assert.equal(blog.blogPageFor('http://localhost:4000/pinned-forever/').rel,
    '_posts/2026-08-21-pinned.md');
  assert.ok(!blog.blogPageFor('http://localhost:4000/pinned-forever/').same_file);
});

await test('…and the same file served by jekyll passthrough resolves to it too', async () => {
  const p = blog.blogPageFor('http://localhost:4000/assets/imgs/ai-2040/plan-a-scrolly.html');
  assert.ok(p);
  assert.equal(p.rel, 'assets/imgs/ai-2040/plan-a-scrolly.html');
  assert.equal(p.mapped_by, 'passthrough');
  assert.equal(p.same_file, true);
  // a url-encoded path is the same file
  assert.equal(blog.blogPageFor('http://localhost:4000/assets/imgs/ai-2040/plan-a-scrolly.html?x=1').rel,
    'assets/imgs/ai-2040/plan-a-scrolly.html');
});

await test('the build output, the dot directories and anything outside are refused', async () => {
  const root = blog.listSites().find(s => s.serve_origin === 'http://localhost:4000').root;
  const rendered = path.join(root, '_site', 'large-space-stations', 'inflatables',
    'space-balloons', 'index.html');
  assert.equal(blog.blogPageFor('file://' + rendered), null, '_site/ is the photocopy');
  assert.equal(blog.blogPageFor('http://localhost:4000/_site/index.html').source_path, '',
    'and it is not reachable through the origin either');
  fs.writeFileSync(path.join(root, '.git', 'HEAD.html'), '<p>no</p>');
  assert.equal(blog.blogPageFor('file://' + path.join(root, '.git', 'HEAD.html')), null);
  const outside = tmp('outside-root');
  fs.writeFileSync(path.join(outside, 'loose.html'), '<p>a file of nobody’s site</p>');
  assert.equal(blog.blogPageFor('file://' + path.join(outside, 'loose.html')), null,
    'a loose local file is not a page — the whole reason the file: gate exists');
  // a walk out of the repo dressed as a path inside it
  assert.equal(blog.passthroughFor(root, '/../../etc/hosts'), null);
  // and a file of the right place with the wrong kind
  assert.equal(blog.blogPageFor('file://' + path.join(root, 'assets', 'images', 'balloon.png')),
    null, 'a picture is not a page');
});

await test('a file of a DECLARED but unconfirmed root is still a page, and says so', async () => {
  const root = blog.listSites().find(s => s.serve_origin === 'http://localhost:4000').root;
  const f = path.join(root, 'assets', 'imgs', 'ai-2040', 'plan-a-scrolly.html');
  blog.setRootState(root, false);
  const no = blog.blogPageFor('file://' + f);
  assert.equal(no.declined, true, 'a NO is kept as firmly as a YES');
  blog.setRootState(root, true);
  assert.equal(blog.blogPageFor('file://' + f).confirmed, true);
});

await test('the envelope block for a file that is its own source says so', async () => {
  const root = blog.listSites().find(s => s.serve_origin === 'http://localhost:4000').root;
  const f = path.join(root, 'assets', 'imgs', 'ai-2040', 'plan-a-scrolly.html');
  const block = blog.blogBlock(blog.blogPageFor('file://' + f));
  assert.match(block, /THIS VERY FILE/, 'no photocopy story on a page that is its own source');
  assert.ok(!/photocopy/.test(block));
  assert.match(block, /DO NOT RUN GIT/, 'the no-git rule is a property of the root, not the page');
  assert.match(block, /_site\//, 'and so is the build output');
  // the HTML is handed to the collateral blocker as HTML, not wrapped in <p>
  assert.equal(blog.sourceDoc('<p>One.</p>', 'x.html'), '<p>One.</p>');
  assert.match(blog.sourceDoc('One.\n\nTwo.', 'x.md'), /<p>One\.<\/p>/);
});

await test('the envelope block names the source, the assets and what to leave alone', async () => {
  const p = blog.blogPageFor('http://localhost:4000/pinned-forever/');
  const block = blog.blogBlock(p);
  assert.ok(block.includes(p.source_path), 'the source path is in it');
  assert.match(block, /photocopy/, 'the rendered page is named as disposable');
  assert.match(block, /RENDERED page/, 'and the quote provenance is stated');
  assert.match(block, /_site\//, 'the build output is named as off limits');
  assert.match(block, /_config\.yml/);
  assert.match(block, /sips|magick/, 'the image tools are named rather than assumed');
  assert.equal(blog.blogBlock({ root: '/x' }), '', 'no source, no write rules');
});

console.log('\nblog — the census and the markdown diff');

await test('the census skips _site/ and the caches', async () => {
  const root = jekyll('census');
  fs.mkdirSync(path.join(root, '.jekyll-cache', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, '.jekyll-cache', 'x', 'junk'), 'junk');
  const seen = [...blog.scanSite(root).keys()];
  assert.ok(seen.includes('_posts/2026-08-20-space-balloons.md'));
  assert.ok(seen.includes('assets/images/balloon.png'));
  assert.ok(!seen.some(p => p.startsWith('_site/')), 'the rendered copy is not a change');
  assert.ok(!seen.some(p => p.startsWith('.')), 'dotfiles and .git are not either');
});

await test('markdown is presented to the diff one paragraph per block', async () => {
  const doc = blog.mdDoc('---\ntitle: X\n---\n\nOne.\n\nTwo <em>three</em>.\n');
  const collateral = await import(path.join(PLUGIN, 'collateral.mjs'));
  const blocks = collateral.docBlocks(doc);
  assert.equal(blocks.length, 3, `front matter and two paragraphs — got ${JSON.stringify(blocks)}`);
  assert.equal(blocks[2], 'Two <em>three</em>.', 'markdown that looks like markup survives the round trip');
});

await test('an edit to one paragraph is one region, not the whole post', async () => {
  const collateral = await import(path.join(PLUGIN, 'collateral.mjs'));
  const before = blog.mdDoc('One.\n\nTwo is the old wording of this sentence here.\n\nThree.\n');
  const after = blog.mdDoc('One.\n\nTwo is the NEW wording of this sentence here.\n\nThree.\n');
  const { regions } = collateral.regionsFrom(before, after);
  assert.equal(regions.length, 1);
  assert.ok(!/Three/.test(regions[0].quote), `the untouched paragraphs stay out — got ${regions[0].quote}`);
});

// =========================================================================
// The companion end: the scoped child, the envelope, the reload and the
// endpoints. One server, one fixture repo, the mock bridge — and no git.
console.log('\ncompanion — blog source pages');

{
  const root = jekyll('srv');
  const ORIGIN = 'http://localhost:4055';
  const POST_URL = `${ORIGIN}/large-space-stations/inflatables/space-balloons/`;
  const SOURCE = path.join(root, '_posts', '2026-08-20-space-balloons.md');
  // a page of the site that is its OWN source: a scrollytelling file under
  // assets/, opened straight off the disk
  const SCROLLY = path.join(root, 'assets', 'imgs', 'ai-2040', 'plan-a-scrolly.html');
  const SCROLLY_URL = 'file://' + SCROLLY;

  const workspaceRoot = tmp('srv-companion');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const envFile = path.join(workspaceRoot, 'bridge-env.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
      MOCK_ENV_DUMP: envFile,
    },
  });
  const spawnEnvs = () => (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const writeRootOf = e => (e.scope || {}).BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS;

  const events = listen(base);
  await sleep(120);

  await test('GET /blog-page is null until a site is declared', async () => {
    const r = await GET(base, '/blog-page?url=' + enc(POST_URL));
    assert.equal(r.status, 200);
    assert.equal(r.json.blog, null);
  });

  await test('POST /blog-site declares one, and refuses a folder that is not a site', async () => {
    const bad = await POST(base, '/blog-site', { serve_origin: ORIGIN, root: path.join(root, 'assets') });
    assert.equal(bad.status, 400);
    const r = await POST(base, '/blog-site', { serve_origin: ORIGIN, root });
    assert.equal(r.status, 200);
    assert.equal(r.json.site.root, root);
    assert.equal(r.json.state, '', 'declared, not yet confirmed');
  });

  await test('GET /blog-page maps the url to its markdown source', async () => {
    const r = await GET(base, '/blog-page?url=' + enc(POST_URL));
    assert.equal(r.json.blog.rel, '_posts/2026-08-20-space-balloons.md');
    assert.equal(r.json.blog.source_path, SOURCE);
    assert.equal(r.json.blog.confirmed, false);
    assert.equal(r.json.blog.title, 'Space balloons');
    assert.deepEqual(r.json.blog.assets, ['assets']);
  });

  // a suggestion card's picture, when the served site has not got it: read
  // off the source tree, inside the root, pictures only
  await test('GET /blog-image answers a picture under the site, and nothing else', async () => {
    const q = src => GET(base, '/blog-image?url=' + enc(POST_URL) + '&src=' + enc(src));
    const r = await q('/assets/images/balloon.png');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.mime, 'image/png');
    assert.match(r.json.data_url, /^data:image\/png;base64,/);
    const rel = await q('../assets/images/balloon.png');
    assert.equal(rel.status, 200, 'relative to the SOURCE directory (_posts/)');
    assert.equal((await q('/assets/images/missing.png')).status, 404);
    assert.equal((await q('/_config.yml')).status, 404, 'not a picture');
    assert.equal((await q('../../../../../../etc/hosts.png')).status, 404, 'never out of the root');
    assert.equal((await q('https://example.com/x.png')).status, 404, 'a url is not a path');
    const off = await GET(base, '/blog-image?url=' + enc('https://example.com/a') + '&src=' + enc('/x.png'));
    assert.equal(off.status, 404, 'not a blog page');
  });

  await test('an unconfirmed repo keeps the comment and summons nobody', async () => {
    await POST(base, '/page', { url: POST_URL, title: 'Space balloons', site: 'localhost' });
    const r = await POST(base, '/reply', { url: POST_URL, thread_id: '__page__', text: '@claude tighten this' });
    assert.equal(r.status, 200);
    assert.equal(r.json.queued, false);
    assert.match(String(r.json.reason), /have not confirmed/);
    await sleep(300);
    assert.equal(spawnEnvs().length, 0, 'nothing was spawned against an unvouched-for repo');
  });

  await test('POST /blog-root refuses a folder nobody declared', async () => {
    const r = await POST(base, '/blog-root', { root: os.tmpdir(), confirm: true });
    assert.equal(r.status, 400);
  });

  await test('confirming the repo lets the turn through', async () => {
    const r = await POST(base, '/blog-root', { root, confirm: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, 'yes');
    await waitFor(() => events.of('blog-root').length, 'every tab on this site to be told');
  });

  await test('the blog bridge is spawned with the REPO as its one write root', async () => {
    await POST(base, '/reply', { url: POST_URL, thread_id: '__page__', text: '@claude tighten the opening' });
    await waitFor(() => spawnEnvs().length >= 1, 'the blog child to spawn');
    const e = spawnEnvs()[0];
    assert.equal(writeRootOf(e), root, `the write root is the repo — got ${JSON.stringify(e.scope)}`);
    assert.equal((e.scope || {}).BOTFERENCE_PROJECT_ROOT, workspaceRoot,
      "…and the workspace is still the companion's own: a blog chat is not filed in the website");
  });

  await test('the envelope carries the source path and the write rules', async () => {
    const turn = await waitFor(() => inputs(logFile).find(t => t.includes('tighten the opening')), 'the turn');
    assert.ok(turn.includes(SOURCE), `the markdown file is named — got:\n${turn.slice(0, 1200)}`);
    assert.match(turn, /photocopy/);
    assert.match(turn, /RENDERED page/);
    assert.match(turn, /_site\//);
  });

  await test('a second post in the same repo shares that one child', async () => {
    const other = `${ORIGIN}/pinned-forever/`;
    await POST(base, '/page', { url: other, title: 'Pinned', site: 'localhost' });
    await POST(base, '/reply', { url: other, thread_id: '__page__', text: '@claude a word here' });
    await waitFor(() => inputs(logFile).some(t => t.includes('a word here')), 'the turn');
    assert.equal(spawnEnvs().filter(e => writeRootOf(e) === root).length, 1,
      'one repo, one child, one FIFO — the child IS the write lock');
  });

  // ---- a local file of the reader's own site ------------------------------
  // The gate content.js asks on a `file:` document, and the lane behind it.
  await test('GET /project-page carries the blog answer for a file of the site', async () => {
    fs.mkdirSync(path.join(root, 'assets', 'imgs', 'ai-2040'), { recursive: true });
    fs.writeFileSync(SCROLLY, '<h1>Plan A</h1>\n<section class="step">A step.</section>\n');
    const r = await GET(base, '/project-page?url=' + enc(SCROLLY_URL));
    assert.equal(r.status, 200);
    assert.equal(r.json.artifact, null, 'it is not a council artifact');
    assert.ok(r.json.blog, 'but it IS a page of the declared site');
    assert.equal(r.json.blog.rel, 'assets/imgs/ai-2040/plan-a-scrolly.html');
    assert.equal(r.json.blog.source_path, SCROLLY);
    assert.equal(r.json.blog.same_file, true);
    assert.equal(r.json.blog.confirmed, true);
  });

  await test('…and says nothing at all for a local file outside every declared root', async () => {
    const loose = path.join(tmp('loose-file'), 'notes.html');
    fs.writeFileSync(loose, '<p>somebody else\u2019s file</p>');
    const r = await GET(base, '/project-page?url=' + enc('file://' + loose));
    assert.equal(r.json.artifact, null);
    assert.equal(r.json.blog, null, 'nothing attaches to a loose local file');
    const inSite = await GET(base, '/blog-page?url=' + enc('file://' + path.join(root, '_site', 'index.html')));
    assert.equal(inSite.json.blog, null, 'and not to the build output either');
  });

  await test('a turn on that file gets the repo as its write root and is told the file is the page',
    async () => {
      await POST(base, '/page', { url: SCROLLY_URL, title: 'Plan A', site: 'file' });
      await POST(base, '/reply',
        { url: SCROLLY_URL, thread_id: '__page__', text: '@claude widen the second step' });
      await waitFor(() => inputs(logFile).some(t => t.includes('widen the second step')), 'the turn');
      const turn = inputs(logFile).find(t => t.includes('widen the second step'));
      assert.ok(turn.includes(SCROLLY), 'the envelope names the file');
      assert.match(turn, /THIS VERY FILE/, 'and does not tell a photocopy story about it');
      assert.match(turn, /DO NOT RUN GIT/);
      assert.equal(spawnEnvs().filter(e => writeRootOf(e) === root).length, 1,
        'the same one child as the served pages: one repo, one lane');
    });

  await test('rewriting that file reloads the file: tab', async () => {
    const before = events.of('blog-files').length;
    await POST(base, '/reply', { url: SCROLLY_URL, thread_id: '__page__',
      text: `@claude [mock:write:${SCROLLY}] widen it` });
    await waitFor(() => events.of('blog-files').length > before, 'the census to report');
    const ev = events.of('blog-files').slice(-1)[0];
    assert.equal(ev.url, SCROLLY_URL, 'addressed to the file: tab, by the url it is filed under');
    assert.equal(ev.page_changed, true, 'the page IS the file that moved');
    assert.equal(ev.source, 'assets/imgs/ai-2040/plan-a-scrolly.html');
  });

  await test('a page under the origin that maps to nothing gets no write root', async () => {
    const stray = `${ORIGIN}/not-a-post-at-all/`;
    await POST(base, '/page', { url: stray, title: 'Stray', site: 'localhost' });
    const before = spawnEnvs().length;
    await POST(base, '/reply', { url: stray, thread_id: '__page__', text: '@claude what is this' });
    await waitFor(() => inputs(logFile).some(t => t.includes('what is this')), 'the turn');
    const turn = inputs(logFile).find(t => t.includes('what is this'));
    assert.ok(!turn.includes('WHERE YOU MAY WRITE'), 'no write rules where no file is known');
    const fresh = spawnEnvs().slice(before);
    assert.ok(fresh.every(e => !writeRootOf(e)), 'and no write root on any child it woke');
  });

  await test('a turn that rewrites the source broadcasts one blog-files event', async () => {
    const before = events.of('blog-files').length;
    await POST(base, '/reply', { url: POST_URL, thread_id: '__page__',
      text: `@claude [mock:write:${SOURCE}] rewrite the opening` });
    await waitFor(() => events.of('blog-files').length > before, 'the change event');
    const ev = events.of('blog-files').pop();
    assert.equal(ev.url, POST_URL.replace(/\/$/, ''));
    assert.equal(ev.page_changed, true, 'the post the reader is reading moved — reload');
    assert.equal(ev.source, '_posts/2026-08-20-space-balloons.md');
    assert.deepEqual(ev.files, ['_posts/2026-08-20-space-balloons.md']);
  });

  await test('a jekyll rebuild during the turn is not a change', async () => {
    const before = events.of('blog-files').length;
    const built = path.join(root, '_site', 'large-space-stations', 'inflatables', 'space-balloons', 'index.html');
    await POST(base, '/reply', { url: POST_URL, thread_id: '__page__',
      text: `@claude [mock:write:${built}] pretend jekyll rebuilt` });
    await waitFor(() => inputs(logFile).some(t => t.includes('pretend jekyll rebuilt')), 'the turn');
    await sleep(500);
    assert.equal(events.of('blog-files').length, before,
      '_site/ moves on every build and would make every turn a reload');
  });

  await test('an image placed under assets/ reloads the page too', async () => {
    const before = events.of('blog-files').length;
    const img = path.join(root, 'assets', 'images', 'diagram.png');
    await POST(base, '/reply', { url: POST_URL, thread_id: '__page__',
      text: `@claude [mock:write:${img}] add the diagram` });
    await waitFor(() => events.of('blog-files').length > before, 'the change event');
    const ev = events.of('blog-files').pop();
    assert.equal(ev.assets_changed, true);
    assert.equal(ev.page_changed, true, 'a picture appearing is a change to the page');
  });

  await test('a turn that changes nothing says nothing', async () => {
    const before = events.of('blog-files').length;
    await POST(base, '/reply', { url: POST_URL, thread_id: '__page__', text: '@claude just talk' });
    await waitFor(() => inputs(logFile).some(t => t.includes('just talk')), 'the turn');
    await sleep(500);
    assert.equal(events.of('blog-files').length, before);
  });

  // SINCE SUGGEST MODE, this is the other way round, and deliberately.
  //
  // The turn-end diff exists to catch an edit that landed with no comment at
  // it — a silence. On a blog page there is now no such thing: a bot proposes
  // and NOTHING moves until the reader accepts a card, so a diff across a turn
  // has nothing to narrate and could only ever report the reader's own
  // accepted changes back to them as if a bot had slipped them in. Worse, the
  // >6-region collapse would fold a sweep the reader is halfway through into
  // one summary note.
  //
  // What still holds is the guarantee the SPEC actually makes about a bot that
  // writes anyway, against its instructions: THE CENSUS. Every file that moved
  // is counted, named and broadcast, and the tab reloads. That is asserted
  // here — the reporting survives; only the auto-threads are gone.
  await test('a turn cannot open collateral threads on a blog page any more', async () => {
    // the reader's own comment is on the FIRST paragraph; the bot silently
    // rewrites the SECOND, which nothing narrates and nothing would show
    const t = await POST(base, '/thread', {
      url: POST_URL,
      quote: 'A balloon in orbit is a pressure vessel that arrived folded.',
      msg: { text: 'the opening is good' },
    });
    assert.equal(t.status, 200);
    // …starting from the post as the reader wrote it: earlier turns in this
    // file left the mock's placeholder in the file, and a diff needs two real
    // versions of a real document
    const original = [
      '---', 'title:  "Space balloons"', '---', '',
      'A balloon in orbit is a pressure vessel that arrived folded.', '',
      'The mass saving is the whole argument and it is not a small one.', '',
      'A third paragraph, left alone by every test in this file.', '',
    ].join('\n');
    fs.writeFileSync(SOURCE, original);
    const rewritten = original
      .replace('The mass saving is the whole argument and it is not a small one.',
        'The mass saving is the entire argument, and it is an enormous one.');
    const patch = path.join(workspaceRoot, 'patch.md');
    fs.writeFileSync(patch, rewritten);
    const before = events.of('blog-files').length;
    await POST(base, '/reply', { url: POST_URL, thread_id: '__page__',
      text: `@claude [mock:copy:${patch}|${SOURCE}] tighten paragraph two` });
    const ev = await waitFor(() => (events.of('blog-files').length > before
      ? events.of('blog-files').pop() : null), 'the change event');
    // the reporting half, which is the promise the SPEC makes: the file that
    // moved is named, and the tab is told to reload
    assert.equal(ev.page_changed, true);
    assert.deepEqual(ev.files, ['_posts/2026-08-20-space-balloons.md']);
    assert.ok(!ev.collateral, 'and nothing was narrated as a change nobody asked for');
    const page = (await GET(base, '/page?url=' + enc(POST_URL))).json;
    assert.equal((page.threads || []).filter(x => x.auto).length, 0,
      'a page where nothing moves during a turn has no silent edits to surface');
  });

  await test('a DECLINED repo turns the page back into an ordinary web page', async () => {
    const declined = jekyll('declined');
    const origin = 'http://localhost:4066';
    await POST(base, '/blog-site', { serve_origin: origin, root: declined });
    await POST(base, '/blog-root', { root: declined, confirm: false });
    const u = `${origin}/pinned-forever/`;
    await POST(base, '/page', { url: u, title: 'Pinned', site: 'localhost' });
    const r = await POST(base, '/reply', { url: u, thread_id: '__page__', text: '@claude declined but discussable' });
    assert.equal(r.json.queued !== false, true, 'the turn goes through — the answer was about the FILES');
    await waitFor(() => inputs(logFile).some(t => t.includes('declined but discussable')), 'the turn');
    const turn = inputs(logFile).find(t => t.includes('declined but discussable'));
    assert.ok(!turn.includes('WHERE YOU MAY WRITE'), 'and nothing in that repo is writable');
  });

  // ---- the road to the internet stays the reader's -----------------------
  // There is no publish here and there is no way to ask for one. What is
  // asserted is the whole of the commitment: no route answers, no git runs,
  // and every turn TELLS the bots so — because a bot that does not know is a
  // bot that helpfully commits.
  await test('there is no publish route, and asking for one is a 404', async () => {
    for (const [method, path_] of [['GET', '/blog-publish?url=' + enc(POST_URL)],
      ['POST', '/blog-publish'], ['POST', '/blog-commit'], ['POST', '/blog-push']]) {
      const r = await request(base, method, path_, method === 'POST' ? { url: POST_URL, confirm: true } : undefined);
      assert.equal(r.status, 404, `${method} ${path_} answered ${r.status}`);
    }
  });

  await test('the turn forbids git in so many words', async () => {
    const turn = inputs(logFile).find(t => t.includes('tighten the opening'));
    assert.match(turn, /DO NOT RUN GIT IN THIS REPOSITORY/);
    assert.match(turn, /git commit/);
    assert.match(turn, /git push/);
    assert.match(turn, /publish/, 'and says who does publish it');
  });

  await test('the blog child is spawned with git and gh denied', async () => {
    const e = spawnEnvs().find(x => (x.scope || {}).BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS === root);
    assert.equal((e.scope || {}).BOTFERENCE_PLAN_DENY_BASH, 'git,gh',
      'the controller turns this into claude permissions.deny plus a .git write deny');
  });

  await test('no git process is ever started by the companion', async () => {
    // the seam a publish would have needed does not exist: nothing in the
    // plugin spawns git at all
    const src = fs.readFileSync(path.join(PLUGIN, 'blog.mjs'), 'utf8');
    assert.ok(!/spawnSync|execFile|child_process/.test(src),
      'blog.mjs starts no processes — every function in it reads');
    for (const name of ['publish', 'publishStatus', 'git', 'gitArgv']) {
      assert.equal(blog[name], undefined, `blog.${name} must not exist`);
    }
  });

  await test('no kind of blog root allows git, and config cannot say otherwise', async () => {
    assert.equal(blog.gitAllowed('jekyll'), false);
    assert.equal(blog.gitAllowed('anything-else'), false, 'an unknown kind is not a loophole');
    assert.deepEqual(blog.deniedCommands('jekyll'), ['git', 'gh']);
    // a config row that tries to grant it keeps exactly three fields
    const sneaky = await POST(base, '/blog-site',
      { serve_origin: ORIGIN, root, kind: 'jekyll', git: true, allow_git: true });
    assert.equal(sneaky.status, 200);
    assert.deepEqual(Object.keys(sneaky.json.site).sort(), ['kind', 'root', 'serve_origin']);
  });

  await test('an ordinary web page is untouched by any of this', async () => {
    const u = 'https://example.test/an-article';
    await POST(base, '/page', { url: u, title: 'An article', site: 'example.test' });
    await POST(base, '/reply', { url: u, thread_id: '__page__', text: '@claude hi there' });
    await waitFor(() => inputs(logFile).some(t => t.includes('hi there')), 'the turn');
    const turn = inputs(logFile).find(t => t.includes('hi there'));
    assert.ok(!turn.includes('blog draft'), 'no blog block on a page that is not one');
    assert.equal((await GET(base, '/blog-page?url=' + enc(u))).json.blog, null);
  });

  events.close();
}

// =========================================================================
// A Jupyter Book: the same mechanism, a second kind. The book is SYNTHETIC
// (a temp dir, like the Jekyll one): the reader's real book is never read or
// written here. See SPEC.md "Jupyter Book source pages".
console.log('\nblog — a Jupyter Book');

// A notebook the way jupyter/nbformat writes one: one-space indent, list-of-
// lines sources, a stored output, metadata — so a byte comparison after an
// edit means something.
function notebook(cells) {
  return JSON.stringify({
    cells: cells.map((c, i) => (c.code != null
      ? { cell_type: 'code', execution_count: 1, id: `c${i}`, metadata: {},
        outputs: [{ name: 'stdout', output_type: 'stream', text: ['42\n'] }],
        source: c.code.split(/(?<=\n)/) }
      : { cell_type: 'markdown', id: `c${i}`, metadata: {}, source: c.md.split(/(?<=\n)/) })),
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' } },
    nbformat: 4, nbformat_minor: 5,
  }, null, 1) + '\n';
}
const CH1 = notebook([
  { md: '# Elliptic Orbits\n\n![fig](imgs/orbit.png)\n\nThe eccentricity vector points at periapsis.' },
  { md: 'The mass saving is the whole argument and it is not a small one.\nA second line of the same cell.' },
  { code: 'import numpy as np\nprint(42)' },
  { md: 'A closing cell, left alone by every test in this file.' },
]);

function book(tag, { extra = {} } = {}) {
  const root = tmp(tag);
  const w = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  w('_config.yml', 'title: A Test Book\nauthor: Nobody\n');
  w('_toc.yml', [
    'format: jb-book',
    'root: intro',
    'parts:',
    '  - caption: Part one',
    '    chapters:',
    '    - file: part1/ch1/ch1      ',
    '    - file: part1/notes.md',
    '    - file: twins/t',
    '',
  ].join('\n'));
  w('intro.md', '# Welcome\n\nThe front page of the book.\n');
  w('part1/ch1/ch1.ipynb', CH1);
  w('part1/ch1/imgs/orbit.png', 'not really a png');
  w('part1/notes.md', '# Notes\n\nSome MyST notes.\n');
  w('twins/t.ipynb', notebook([{ md: '# Twin notebook' }]));
  w('twins/t.md', '# Twin markdown\n');
  w('extra/loose.ipynb', notebook([{ md: '# Not in the toc' }]));
  w('_static/custom.css', 'body { color: black; }\n');
  // the build output and the caches: what the reader is LOOKING at, and what
  // nothing may map to or count
  w('_build/html/index.html', '<meta http-equiv="Refresh" content="0; url=intro.html" />');
  w('_build/html/intro.html', '<h1>Welcome</h1>');
  w('_build/html/part1/ch1/ch1.html', '<h1>Elliptic Orbits</h1>');
  w('_build/.jupyter_cache/global.db', 'x');
  w('part1/ch1/.ipynb_checkpoints/ch1-checkpoint.ipynb', CH1);
  w('part1/__pycache__/x.pyc', 'x');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  for (const [rel, text] of Object.entries(extra)) w(rel, text);
  return root;
}

await test('a _toc.yml beside _config.yml is a Jupyter Book; a Jekyll tree is not', async () => {
  assert.equal(blog.detectKind(book('kind')), 'jupyterbook');
  assert.equal(blog.isJupyterBookRoot(book('kind2')), true);
  assert.equal(blog.detectKind(jekyll('kind-j')), 'jekyll');
  const half = tmp('half-book');
  fs.writeFileSync(path.join(half, '_toc.yml'), 'root: intro\n');
  assert.equal(blog.isJupyterBookRoot(half), false, 'a toc with no _config.yml is not a book');
  assert.equal(blog.detectKind(half), '');
});

await test('registration reads the kind off the tree when the caller does not say', async () => {
  const root = book('reg-book');
  const r = blog.addSite({ serve_origin: 'http://localhost:8123', root });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.site.kind, 'jupyterbook');
  const j = blog.addSite({ serve_origin: 'http://localhost:8124', root: jekyll('reg-j') });
  assert.equal(j.site.kind, 'jekyll', 'no toc, no book');
  const wrong = blog.addSite({ serve_origin: 'http://localhost:8125', root: jekyll('reg-j2'), kind: 'jupyterbook' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /_toc\.yml/);
  assert.equal(blog.addSite({ serve_origin: 'http://localhost:8126', root, kind: 'hugo' }).ok, false,
    'an unknown kind is refused, not quietly read as Jekyll');
  blog.removeSite('http://localhost:8123');
  blog.removeSite('http://localhost:8124');
});

await test('a rebuild command is kept for a book, dropped for Jekyll, refused if it names git', async () => {
  const root = book('rebuild-row');
  const r = blog.addSite({ serve_origin: 'http://localhost:8127', root, rebuild: 'jupyter-book build .' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.site.rebuild, 'jupyter-book build .');
  assert.deepEqual(Object.keys(r.site).sort(), ['kind', 'rebuild', 'root', 'serve_origin'],
    'three fields and the rebuild command — nothing else survives');
  for (const bad of ['jupyter-book build . && git commit -am x', 'gh pages', '/usr/bin/git push', 'a\nb']) {
    const x = blog.addSite({ serve_origin: 'http://localhost:8128', root, rebuild: bad });
    assert.equal(x.ok, false, `refused: ${JSON.stringify(bad)}`);
  }
  const j = blog.addSite({ serve_origin: 'http://localhost:8129', root: jekyll('rebuild-j'), rebuild: 'make' });
  assert.equal(j.ok, false, 'jekyll rebuilds itself; a rebuild on its row is a mistake said out loud');
  assert.equal(blog.rebuildOf('jekyll', 'make').cmd, '');
  assert.equal(blog.gitAllowed('jupyterbook'), false);
  assert.equal(blog.suggestMode('jupyterbook'), true);
  assert.deepEqual(blog.deniedCommands('jupyterbook'), ['git', 'gh']);
  blog.removeSite('http://localhost:8127');
});

{
  const root = book('map-book');
  const map = p => blog.resolvePath(root, p, 'jupyterbook');

  await test('a nested chapter maps from its built url to its notebook, in every spelling', async () => {
    for (const p of ['/part1/ch1/ch1.html', '/part1/ch1/ch1/', '/part1/ch1/ch1', '/part1/ch1/ch1.html?x=1#sec']) {
      const r = map(p);
      assert.ok(r.doc, `${p}: ${r.why}`);
      assert.equal(r.doc.rel, 'part1/ch1/ch1.ipynb', p);
      assert.equal(r.how, 'toc');
    }
    assert.equal(r0(map('/part1/notes.html')), 'part1/notes.md', 'an entry written with its extension');
  });

  await test('the root page answers for /, index.html and its own name', async () => {
    for (const p of ['/', '/index.html', '/intro.html']) assert.equal(r0(map(p)), 'intro.md', p);
  });

  await test('a notebook and a markdown file with one stem are ambiguous, not resolved by luck', async () => {
    const r = map('/twins/t.html');
    assert.equal(r.doc, null);
    assert.match(r.why, /twins\/t\.ipynb/);
    assert.match(r.why, /twins\/t\.md/);
  });

  await test('a page built from a file outside the toc is found at its own path', async () => {
    const r = map('/extra/loose.html');
    assert.equal(r.doc.rel, 'extra/loose.ipynb');
    assert.equal(r.how, 'path');
  });

  await test('the build output, a dot directory and a missing page map to nothing', async () => {
    assert.equal(map('/_build/html/part1/ch1/ch1.html').doc, null, '_build/ is the photocopy');
    assert.equal(map('/part1/ch1/.ipynb_checkpoints/ch1-checkpoint.html').doc, null);
    assert.equal(map('/genindex.html').doc, null);
    assert.match(map('/nope.html').why, /no notebook or markdown/);
    for (const doc of blog.bookIndexOf(root).docs) assert.ok(!doc.rel.startsWith('_build/'));
  });

  await test('the page record names the notebook, its pictures and the kind', async () => {
    blog.addSite({ serve_origin: 'http://localhost:8130', root });
    const p = blog.blogPageFor('http://localhost:8130/part1/ch1/ch1.html');
    assert.equal(p.kind, 'jupyterbook');
    assert.equal(p.kind_label, 'Jupyter Book');
    assert.equal(p.source_path, path.join(root, 'part1', 'ch1', 'ch1.ipynb'));
    assert.equal(p.notebook, true);
    assert.deepEqual(p.assets, ['part1/ch1/imgs'], 'pictures sit beside the chapter');
    assert.deepEqual(p.images, ['part1/ch1/imgs/orbit.png']);
    assert.equal(p.suggest_mode, true);
    assert.equal(p.git_allowed, false);
    assert.equal(p.rebuild, '', 'no rebuild command declared');
  });

  await test('a built page opened off the disk maps back to its notebook too', async () => {
    const p = blog.blogPageFor('file://' + path.join(root, '_build', 'html', 'part1', 'ch1', 'ch1.html'));
    assert.ok(p, 'a page of the declared book');
    assert.equal(p.rel, 'part1/ch1/ch1.ipynb');
    assert.ok(!p.same_file, 'the built page is a photocopy, not its own source');
    blog.removeSite('http://localhost:8130');
  });

  await test('the notebook reads as its text projection, not its JSON', async () => {
    const text = blog.sourceText(path.join(root, 'part1', 'ch1', 'ch1.ipynb'));
    assert.ok(text.startsWith('# Elliptic Orbits'), text.slice(0, 60));
    assert.match(text, /```\{code-cell\} python\nimport numpy as np\nprint\(42\)\n```/);
    assert.ok(!/"cell_type"|"outputs"/.test(text), 'no JSON in the projection');
    assert.equal(blog.sourceText(path.join(root, 'part1', 'notes.md')), '# Notes\n\nSome MyST notes.\n',
      'a markdown chapter is its own text');
  });

  await test('the envelope tells the bots about cells, style files and the rebuild', async () => {
    const p = { ...blog.blogPageFor('file://' + path.join(root, '_build', 'html', 'part1', 'ch1', 'ch1.html')) };
    blog.addSite({ serve_origin: 'http://localhost:8131', root });
    const page = blog.blogPageFor('http://localhost:8131/part1/ch1/ch1.html');
    const block = blog.blogBlock(page);
    assert.match(block, /WITHIN ONE CELL/);
    assert.match(block, /\{code-cell\}/);
    assert.match(block, /_config\.yml and _static\//, 'the book\'s style is named as leave-alone-unless-asked');
    assert.match(block, /_build\//);
    assert.match(block, /DO NOT RUN GIT/);
    assert.match(block, /rebuilds the book themselves/, 'no rebuild command: the reader rebuilds by hand');
    assert.ok(!/Jekyll|jekyll/.test(block), 'no jekyll story on a book');
    assert.ok(block.includes(page.source_path));
    const md = blog.blogBlock(blog.blogPageFor('http://localhost:8131/part1/notes.html'));
    assert.ok(!/WITHIN ONE CELL/.test(md), 'a markdown chapter has no cells to stay inside');
    assert.ok(p);
    blog.removeSite('http://localhost:8131');
  });
}
function r0(r) { return r && r.doc ? r.doc.rel : `(none: ${r && r.why})`; }

{
  const suggest = await import(path.join(PLUGIN, 'suggest.mjs'));
  const root = book('apply-book');
  const NB = path.join(root, 'part1', 'ch1', 'ch1.ipynb');

  await test('a card on a notebook markdown cell changes that cell and not one other byte', async () => {
    fs.writeFileSync(NB, CH1);
    const r = suggest.applyCard(NB, { state: 'open',
      current: 'The mass saving is the whole argument and it is not a small one.',
      proposed: 'The mass saving is the whole argument, and it is not small.' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.cell, 1);
    const after = fs.readFileSync(NB, 'utf8');
    assert.equal(after, CH1.replace('whole argument and it is not a small one.', 'whole argument, and it is not small.'),
      'byte-identical outside the one line that changed: outputs, ids, metadata, indentation');
    const a = JSON.parse(CH1).cells;
    const b = JSON.parse(after).cells;
    assert.deepEqual(b.map((c, i) => JSON.stringify(c) === JSON.stringify(a[i])), [true, false, true, true]);
  });

  await test('a card whose span crosses two cells is refused and writes nothing', async () => {
    fs.writeFileSync(NB, CH1);
    const r = suggest.applyCard(NB, { state: 'open',
      current: 'points at periapsis.\n\nThe mass saving is the whole argument',
      proposed: 'something else' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cell');
    assert.match(r.detail, /cell boundary/);
    assert.equal(fs.readFileSync(NB, 'utf8'), CH1);
  });

  await test('…and so is one that touches a code-cell fence', async () => {
    fs.writeFileSync(NB, CH1);
    const r = suggest.applyCard(NB, { state: 'open',
      current: '```{code-cell} python\nimport numpy as np', proposed: 'import numpy' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cell');
    assert.equal(fs.readFileSync(NB, 'utf8'), CH1);
  });

  await test('a code cell\'s own text can be changed, and the output stays as stored', async () => {
    fs.writeFileSync(NB, CH1);
    const r = suggest.applyCard(NB, { state: 'open', current: 'print(42)', proposed: 'print(6 * 7)' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const cell = JSON.parse(fs.readFileSync(NB, 'utf8')).cells[2];
    assert.deepEqual(cell.source, ['import numpy as np\n', 'print(6 * 7)']);
    assert.deepEqual(cell.outputs, JSON.parse(CH1).cells[2].outputs);
  });

  await test('a sweep over a notebook lands cell by cell, in document order', async () => {
    fs.writeFileSync(NB, CH1);
    const out = suggest.applyStack(NB, [
      { id: 'b', state: 'open', current: 'A closing cell, left alone', proposed: 'A closing cell, now edited' },
      { id: 'a', state: 'open', current: 'points at periapsis', proposed: 'points toward periapsis' },
    ]);
    assert.deepEqual(out.applied, ['a', 'b']);
    assert.equal(out.stopped, null);
    const text = blog.sourceText(NB);
    assert.match(text, /points toward periapsis/);
    assert.match(text, /A closing cell, now edited/);
  });

  await test('a markdown chapter takes the existing text path unchanged', async () => {
    const md = path.join(root, 'part1', 'notes.md');
    const r = suggest.applyCard(md, { state: 'open', current: 'Some MyST notes.', proposed: 'Some better notes.' });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(md, 'utf8'), '# Notes\n\nSome better notes.\n');
  });
}

await test('the census skips _build/, the caches and the checkpoints', async () => {
  const root = book('census-book');
  const seen = [...blog.scanSite(root, 'jupyterbook').keys()];
  assert.ok(seen.includes('part1/ch1/ch1.ipynb'));
  assert.ok(seen.includes('part1/ch1/imgs/orbit.png'));
  assert.ok(seen.includes('_static/custom.css'), 'the book\'s style is a source, and a change to it counts');
  for (const bad of ['_build/', '.ipynb_checkpoints/', '__pycache__/', '.jupyter_cache']) {
    assert.ok(!seen.some(p => p.includes(bad)), `${bad} is build output, not an edit`);
  }
  assert.deepEqual([...blog.scanSite(root).keys()].sort(), seen.sort(), 'and the kind is read off the tree when not said');
});

await test('the rebuild scheduler runs one build for a burst of changes, one at a time', async () => {
  const { createRebuilder } = await import(path.join(PLUGIN, 'rebuild.mjs'));
  const root = book('sched-book');
  const lines = [];
  const rb = createRebuilder({ log: l => lines.push(l), delayMs: 60 });
  const site = { root, rebuild: 'echo run >> built.flag' };
  const results = [];
  for (let i = 0; i < 4; i++) rb.schedule(site, r => results.push(r));
  await waitFor(() => results.length === 4, 'the build to report to every waiter');
  assert.equal(fs.readFileSync(path.join(root, 'built.flag'), 'utf8'), 'run\n', 'four requests, one build');
  assert.ok(results.every(r => r.ok && r.code === 0));
  // a change while a build runs queues exactly one more
  const slow = { root, rebuild: 'sleep 0.3; echo run >> built.flag' };
  const more = [];
  rb.schedule(slow, r => more.push(r));
  await waitFor(() => rb.busy(root) && lines.some(l => l.includes('sleep 0.3')), 'the slow build to start');
  rb.schedule(slow, r => more.push(r));
  rb.schedule(slow, r => more.push(r));
  await waitFor(() => more.length === 3 && !rb.busy(root), 'both builds to finish');
  assert.equal(fs.readFileSync(path.join(root, 'built.flag'), 'utf8'), 'run\nrun\nrun\n',
    'the one in flight plus exactly one after it');
  const bad = [];
  rb.schedule({ root, rebuild: 'echo broken >&2; exit 3' }, r => bad.push(r));
  await waitFor(() => bad.length, 'the failing build');
  assert.equal(bad[0].ok, false);
  assert.equal(bad[0].code, 3);
  assert.deepEqual(bad[0].tail, ['broken'], 'the output rides the result for the drawer');
  assert.ok(lines.some(l => l.includes('FAILED')), 'and the companion log says so');
});

// The companion end, for a book: registration without a kind, the mapping on
// the wire, the envelope, an accepted card writing one cell, and the owner's
// rebuild command running once before the reload.
console.log('\ncompanion — a Jupyter Book');

{
  const root = book('srv-book');
  const ORIGIN = 'http://localhost:4077';
  const PAGE = `${ORIGIN}/part1/ch1/ch1.html`;
  const NB = path.join(root, 'part1', 'ch1', 'ch1.ipynb');
  const FLAG = path.join(root, 'built.flag');
  const workspaceRoot = tmp('srv-book-companion');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const envFile = path.join(workspaceRoot, 'bridge-env.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
      MOCK_ENV_DUMP: envFile,
      PLUGIN_REBUILD_DEBOUNCE_MS: '100',
    },
  });
  const spawnScope = () => ((fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])[0] || {}).scope || {};
  const events = listen(base);
  await sleep(120);
  const says = lines => `[mock:says:${lines.join('\\n')}]`;
  const pageMsgs = async () => ((await GET(base, '/page?url=' + enc(PAGE))).json || {}).page_chat || [];
  let turnN = 0;
  async function turn(blocks) {
    const tag = `booknote-${++turnN}`;
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__', text: '@claude ' + says([tag, '', ...blocks]) });
    return waitFor(async () => (await pageMsgs())
      .find(m => m.author === 'claude' && String(m.text || '').startsWith(tag)), `the answer to ${tag}`);
  }

  await test('POST /blog-site with no kind registers a book, rebuild command and all', async () => {
    const r = await POST(base, '/blog-site', { serve_origin: ORIGIN, root, rebuild: 'echo run >> built.flag' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.site.kind, 'jupyterbook');
    assert.equal(r.json.site.rebuild, 'echo run >> built.flag');
    const bad = await POST(base, '/blog-site', { serve_origin: ORIGIN, root, rebuild: 'git push' });
    assert.equal(bad.status, 400, 'a rebuild command that names git is refused at the door');
    await POST(base, '/blog-root', { root, confirm: true });
  });

  await test('GET /blog-page maps the chapter to its notebook', async () => {
    const r = await GET(base, '/blog-page?url=' + enc(PAGE));
    assert.equal(r.json.blog.rel, 'part1/ch1/ch1.ipynb');
    assert.equal(r.json.blog.kind, 'jupyterbook');
    assert.equal(r.json.blog.rebuild, 'echo run >> built.flag');
    assert.equal(r.json.blog.confirmed, true);
  });

  let msg = null;
  await test('a turn carries the notebook rules and lifts the cards', async () => {
    await POST(base, '/page', { url: PAGE, title: 'Elliptic Orbits', site: 'localhost' });
    msg = await turn(['```suggest', 'current: points at periapsis.', 'proposed: points toward periapsis.',
      'why: direction, not location', '```']);
    const t = inputs(logFile).find(x => x.includes('booknote-1'));
    assert.match(t, /book chapter/);
    assert.match(t, /WITHIN ONE CELL/);
    assert.ok(t.includes(NB));
    assert.equal(msg.suggestions.length, 1);
    assert.equal(fs.readFileSync(NB, 'utf8'), CH1, 'the turn moved nothing');
    assert.ok(!fs.existsSync(FLAG), 'and nothing was rebuilt for a turn that changed nothing');
  });

  await test('accepting it writes one cell, rebuilds ONCE, then reloads', async () => {
    const before = events.of('blog-files').length;
    const r = await POST(base, '/suggest-accept', { url: PAGE, ts: msg.ts, author: 'claude', id: msg.suggestions[0].id });
    assert.equal(r.json.applied, true, JSON.stringify(r.json));
    assert.equal(fs.readFileSync(NB, 'utf8'), CH1.replace('points at periapsis.', 'points toward periapsis.'));
    const first = await waitFor(() => events.of('blog-files').slice(before)[0], 'the held event');
    assert.equal(first.rebuilding, true);
    assert.equal(first.page_changed, false, 'the reload waits for the build');
    const done = await waitFor(() => events.of('blog-files').slice(before).find(e => e.rebuilt), 'the build');
    assert.equal(done.rebuild_ok, true);
    assert.equal(done.page_changed, true, 'and then the tab reloads onto the new build');
    assert.equal(fs.readFileSync(FLAG, 'utf8'), 'run\n', 'one accepted card, one rebuild');
  });

  await test('a cross-cell card goes to needs-manual and writes nothing', async () => {
    // two markdown cells, one boundary between them — a span a bot might
    // well write, and one no single cell can hold
    const m = await turn(['```suggest', 'current: toward periapsis.', '', 'The mass saving is the whole argument',
      'proposed: x', 'why: crosses', '```']);
    assert.equal(m.suggestions[0].state, 'open', JSON.stringify(m.suggestions));
    const now = fs.readFileSync(NB, 'utf8');
    const r = await POST(base, '/suggest-accept', { url: PAGE, ts: m.ts, author: 'claude', id: m.suggestions[0].id });
    assert.equal(r.json.applied, false);
    assert.equal(r.json.card.state, 'needs-manual');
    assert.equal(r.json.card.reason, 'cell');
    assert.equal(fs.readFileSync(NB, 'utf8'), now);
  });

  await test('a rebuild writing _build/ is not a change', async () => {
    const before = events.of('blog-files').length;
    const built = path.join(root, '_build', 'html', 'part1', 'ch1', 'ch1.html');
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__',
      text: `@claude [mock:write:${built}] pretend the book rebuilt` });
    await waitFor(() => inputs(logFile).some(t => t.includes('pretend the book rebuilt')), 'the turn');
    await sleep(500);
    assert.equal(events.of('blog-files').length, before, '_build/ moves on every build');
    assert.equal(fs.readFileSync(FLAG, 'utf8'), 'run\n', 'and it does not set off another build');
  });

  // ---- where the turn's produced files go (blog.mjs "the scratch folder") ----
  // THE REPORT: a redrawn figure, its script and its previews landed in the
  // Botference repo under projects/plugin-pages/artifacts/, and the reader was
  // asked to cp the pictures into the book.
  const SCRATCH = blog.scratchDir(root);

  await test('the book child is told its artifacts folder is the book\u2019s own scratch', async () => {
    const sc = await waitFor(() => (spawnScope().BOTFERENCE_PLAN_ARTIFACTS_DIR ? spawnScope() : null),
      'the spawn env');
    assert.equal(sc.BOTFERENCE_PLAN_ARTIFACTS_DIR, SCRATCH);
    assert.equal(sc.BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS, root, 'inside the write root: nothing widened');
    for (const not of [workspaceRoot, path.resolve(PLUGIN, '..', '..')]) {
      assert.ok(path.relative(not, SCRATCH).startsWith('..'), `never under ${not}`);
    }
    assert.equal(sc.BOTFERENCE_PLAN_ARTIFACTS_LINK, blog.scratchLink(root));
    assert.match(sc.BOTFERENCE_SUMMON_PLACEMENT, /never leave the reader a copy step/,
      'a summoned build agent gets the placement rule too');
    assert.ok(fs.statSync(SCRATCH).isDirectory(), 'the folder is made');
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.botference\/$/m,
      '…and gitignored in the reader\u2019s repo');
    assert.ok(!fs.existsSync(path.join(workspaceRoot, 'projects', 'plugin-pages', 'artifacts')),
      'and nothing of the book\u2019s in the companion workspace');
  });

  await test('the envelope names the chapter\u2019s image folder and the scratch folder', async () => {
    const t = inputs(logFile).find(x => x.includes('booknote-1'));
    assert.ok(t.includes(`${root}/part1/ch1/imgs/`), 'the absolute image folder');
    assert.ok(t.includes(`${SCRATCH}/`), 'the absolute scratch folder');
    assert.match(t, /never ask the reader to copy/);
  });

  await test('/files/ serves a scratch file under the site\u2019s key', async () => {
    fs.writeFileSync(path.join(SCRATCH, 'preview.png'), 'preview');
    const r = await request(base, 'GET', `${blog.scratchLink(root)}/preview.png`);
    assert.equal(r.status, 200, JSON.stringify(r).slice(0, 300));
  });

  await test('turn-end places a proposed picture from scratch, and says so in the census', async () => {
    const before = events.of('blog-files').length;
    const prepared = path.join(workspaceRoot, 'orbit-v2.png');
    fs.writeFileSync(prepared, 'the redrawn orbit');
    const target = path.join(root, 'part1', 'ch1', 'imgs', 'orbit-v2.png');
    assert.ok(!fs.existsSync(target));
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__', text: '@claude '
      + `[mock:copy:${prepared}|${path.join(SCRATCH, 'orbit-v2.png')}] `
      + says(['placenote', '', '```suggest', 'current: imgs/orbit.png', 'proposed: imgs/orbit-v2.png',
        'why: the redrawn figure', '```']) });
    const ev = await waitFor(() => events.of('blog-files').slice(before).find(e => e.placed), 'the census');
    assert.equal(fs.readFileSync(target, 'utf8'), 'the redrawn orbit', 'copied into the chapter\u2019s folder');
    assert.deepEqual(ev.placed.map(p => p.rel), ['part1/ch1/imgs/orbit-v2.png']);
    assert.equal(ev.placed_note, 'placed part1/ch1/imgs/orbit-v2.png from scratch');
    assert.ok(ev.files.includes('part1/ch1/imgs/orbit-v2.png'), 'counted like any file that moved');
    assert.ok(!ev.files.some(f => f.startsWith('.botference')), 'the scratch folder is never a change');
  });

  await test('…and never over a picture the book already has', async () => {
    const own = path.join(root, 'part1', 'ch1', 'imgs', 'orbit.png');
    const was = fs.readFileSync(own, 'utf8');
    const prepared = path.join(workspaceRoot, 'orbit-draft.png');
    fs.writeFileSync(prepared, 'a draft');
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__', text: '@claude '
      + `[mock:copy:${prepared}|${path.join(SCRATCH, 'orbit.png')}] `
      + says(['keepnote', '', '```suggest', 'current: imgs/orbit-v2.png', 'proposed: imgs/orbit.png', '```']) });
    await waitFor(async () => (await pageMsgs()).find(m => String(m.text || '').startsWith('keepnote')), 'the turn');
    await sleep(400);
    assert.equal(fs.readFileSync(own, 'utf8'), was);
  });

  await test('a picture the chapter uses, replaced in a turn, rebuilds and reloads', async () => {
    const before = events.of('blog-files').length;
    const img = path.join(root, 'part1', 'ch1', 'imgs', 'orbit.png');
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__', text: `@claude [mock:write:${img}] redraw the figure` });
    const done = await waitFor(() => events.of('blog-files').slice(before).find(e => e.rebuilt), 'the build');
    assert.equal(done.page_changed, true);
    assert.match(fs.readFileSync(FLAG, 'utf8'), /^(run\n){3,}$/, 'one more build (the placed picture made one too)');
  });

  events.close();
}

// --- done ----------------------------------------------------------------
cleanup();
await sleep(200);

console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
