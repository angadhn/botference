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
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

// --- tiny runner ---------------------------------------------------------
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// --- fixtures ------------------------------------------------------------
const tmps = [];
function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-blog-${tag}-`));
  tmps.push(d);
  // realpath, always — macOS's /var/folders is really /private/var/folders,
  // and blog.mjs resolves both sides of every comparison
  return fs.realpathSync(d);
}

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
const spawned = [];
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blog-secrets-'));
function startServer({ root, args = [], env = {} }) {
  const proc = spawn(process.execPath, [SERVER, ...args], {
    env: {
      ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: root,
      BOTFERENCE_SECRETS_DIR: SECRETS, PLUGIN_OWNER_PASSWORD: '', REVIEW_HUB_PASSWORD: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(proc);
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  return waitFor(() => {
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    return m ? `http://127.0.0.1:${m[1]}` : null;
  }, `server to listen (got: ${out.slice(0, 300)})`).then(base => ({ proc, base, out: () => out }));
}
function request(base, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + urlPath, {
      method,
      headers: {
        ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
        ...headers,
      },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { }
        resolve({ status: res.statusCode, json, body: buf });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const GET = (b, p, h) => request(b, 'GET', p, undefined, h);
const POST = (b, p, body, h) => request(b, 'POST', p, body, h);
const enc = encodeURIComponent;

const bridgeLog = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const inputs = file => bridgeLog(file).filter(e => e.type === 'input').map(e => String(e.text));

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

  function listen(b) {
    const seen = [];
    const req = http.request(b + '/events', { method: 'GET' }, res => {
      let buf = '';
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(frame);
          if (!m) continue;
          try { seen.push(JSON.parse(m[1])); } catch { }
        }
      });
    });
    req.end();
    return { seen, close: () => req.destroy(), of: t => seen.filter(e => e.type === t) };
  }
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

// --- done ----------------------------------------------------------------
for (const p of spawned) { try { p.kill(); } catch { } }
await sleep(200);
for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
try { fs.rmSync(SECRETS, { recursive: true, force: true }); } catch { }

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
