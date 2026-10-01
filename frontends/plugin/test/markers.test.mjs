#!/usr/bin/env node
// Registered projects — `botference init` / `botference site` as the one
// gesture that puts a repo in Discuss's scope. See markers.mjs, site-cli.mjs
// and SPEC.md "projects registered by marker".
//
// Every repo here is synthetic, in a temp dir; the registry is a temp file
// (BOTFERENCE_SITES_REGISTRY), never ~/.botference/sites.json; the companion
// runs with --no-agents, so no bridge and no CLI starts; and nothing runs git.
//
//   node frontends/plugin/test/markers.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness, enc, GET, POST } from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const CLI = path.join(PLUGIN, 'site-cli.mjs');

const { test, tmp, startServer, cleanup, passed, failures, REGISTRY } =
  createHarness({ server: SERVER, tag: 'markers', realpath: true });

// this process too: blog.mjs is imported below and reads the registry
const OWN_ROOT = tmp('own');
process.env.BOTFERENCE_PROJECT_ROOT = OWN_ROOT;
process.env.BOTFERENCE_SITES_REGISTRY = REGISTRY;
const blog = await import(path.join(PLUGIN, 'blog.mjs'));
const markers = await import(path.join(PLUGIN, 'markers.mjs'));

const w = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
function book(tag) {
  const root = tmp(tag);
  w(root, '_config.yml', 'title: A Book\n');
  w(root, '_toc.yml', 'format: jb-book\nroot: intro\nchapters:\n- file: ch1/ch1\n');
  w(root, 'intro.md', '# Welcome\n');
  w(root, 'ch1/ch1.md', '# One\n\nThe first chapter.\n');
  return root;
}
function jekyll(tag) {
  const root = tmp(tag);
  w(root, '_config.yml', 'title: T\n');
  w(root, '_posts/2026-01-01-a.md', '---\ntitle: A\n---\n\nHello.\n');
  return root;
}
const reset = () => { try { fs.rmSync(REGISTRY); } catch { } };
const cli = (args, env = {}, cwd = OWN_ROOT) => spawnSync(process.execPath, [CLI, ...args], {
  cwd, encoding: 'utf8',
  env: { ...process.env, BOTFERENCE_SITES_REGISTRY: REGISTRY,
    BOTFERENCE_PLUGIN_URL: 'http://127.0.0.1:9', ...env },
});

console.log('markers — the registry and the marker, in process');

await test('a registered book is a site: its origin, its twin, and vouched for', async () => {
  reset();
  const root = book('reg');
  markers.writeMarker(root, { kind: 'jupyterbook', serve_origin: 'http://localhost:8123' });
  markers.registerRoot(root);
  const r = blog.rescanMarkers();
  assert.deepEqual(r.skipped, []);
  const mine = blog.listSites().filter(s => s.root === root);
  assert.deepEqual(mine.map(s => s.serve_origin).sort(), ['http://127.0.0.1:8123', 'http://localhost:8123']);
  assert.ok(mine.every(s => s.from === 'marker' && s.kind === 'jupyterbook'));
  assert.equal(blog.rootState(root), 'yes', 'running the command in the folder is the yes');
  const p = blog.blogPageFor('http://localhost:8123/ch1/ch1.html');
  assert.equal(p.rel, 'ch1/ch1.md');
  assert.equal(p.confirmed, true);
});

await test('an explicit answer in blog_roots still wins — a NO above all', async () => {
  reset();
  const root = book('no');
  markers.writeMarker(root, { kind: 'jupyterbook', serve_origin: 'http://localhost:8124' });
  markers.registerRoot(root);
  blog.rescanMarkers();
  blog.setRootState(root, false);
  assert.equal(blog.rootState(root), 'no');
  blog.setRootState(root, true);
});

await test('a hand-written blog_sites row wins its origin over a marker', async () => {
  reset();
  const a = book('hand-a');
  const b = book('hand-b');
  markers.writeMarker(a, { kind: 'jupyterbook', serve_origin: 'http://localhost:8125' });
  markers.registerRoot(a);
  blog.rescanMarkers();
  assert.equal(blog.addSite({ serve_origin: 'http://localhost:8125', root: b }).ok, true);
  assert.equal(blog.siteFor('http://localhost:8125/x').root, b, 'the hand-written one');
  assert.equal(blog.siteFor('http://127.0.0.1:8125/x').root, a, 'the twin no hand-written row names stays the marker’s');
  assert.ok(!blog.configSites().some(s => s.root === a), 'and a marker is never copied into config.json');
  blog.removeSite('http://localhost:8125');
});

await test('switched off, gone, unmarked, mis-kinded: skipped, and each one said', async () => {
  reset();
  const off = book('off');
  markers.writeMarker(off, { kind: 'jupyterbook', serve_origin: 'http://localhost:8126', enabled: false });
  const gone = path.join(tmp('gone-parent'), 'nope');
  const bare = tmp('bare');
  const wrong = jekyll('wrong');
  markers.writeMarker(wrong, { kind: 'jupyterbook', serve_origin: 'http://localhost:8127' });
  for (const r of [off, gone, bare, wrong]) markers.registerRoot(r);
  // a registry naming a folder that is not there is written by hand here:
  // registerRoot resolves through realpath, which a missing folder has none of
  fs.writeFileSync(REGISTRY, JSON.stringify({ roots: [off, gone, bare, wrong] }));
  const r = blog.rescanMarkers();
  const why = Object.fromEntries(r.skipped.map(x => [x.root, x.why]));
  assert.match(why[off], /enabled: false/);
  assert.match(why[gone], /gone/);
  assert.match(why[bare], /site\.json/);
  assert.match(why[wrong], /no _toc\.yml/);
  assert.equal(r.sites.length, 0);
  assert.ok(markers.readRegistry().includes(gone), 'a skipped root stays registered — a disk unmounted today is back tomorrow');
});

await test('two projects claiming one origin: the later registration wins, the other is reported', async () => {
  reset();
  const a = book('clash-a');
  const b = book('clash-b');
  for (const r of [a, b]) markers.writeMarker(r, { kind: 'jupyterbook', serve_origin: 'http://localhost:8128' });
  markers.registerRoot(a);
  markers.registerRoot(b);
  const r = blog.rescanMarkers();
  assert.equal(blog.siteFor('http://localhost:8128/').root, b);
  assert.match(r.skipped.find(x => x.root === a).why, /also claimed by/);
  markers.registerRoot(a);                         // registering again moves it to the end
  blog.rescanMarkers();
  assert.equal(blog.siteFor('http://localhost:8128/').root, a);
});

await test('a plain folder has no origin; a file of it opened off the disk is in scope', async () => {
  reset();
  const root = tmp('plain');
  const note = w(root, 'notes/plan.md', '# Plan\n\nA plan.\n');
  markers.writeMarker(root, { kind: 'plain' });
  markers.registerRoot(root);
  blog.rescanMarkers();
  assert.equal(blog.siteFor('http://localhost:8000/'), null, 'it answers for no address');
  const p = blog.blogPageFor('file://' + note);
  assert.ok(p, 'the file is a page of a registered project');
  assert.equal(p.root, root);
  assert.equal(p.kind, 'plain');
  assert.equal(p.same_file, true);
  assert.equal(p.confirmed, true);
  assert.match(blog.blogBlock(p), /opened straight off the disk\. There is no rendering step/);
});

console.log('\nbotference site / sites — the command');

await test('site on a book writes the marker, the gitignore line and the registry', async () => {
  reset();
  const root = book('cli');
  const bin = tmp('bin');
  fs.writeFileSync(path.join(bin, 'jupyter-book'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const r = cli(['site', root], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(root, '.botference', 'site.json'), 'utf8'));
  assert.deepEqual(m, { kind: 'jupyterbook', serve_origin: 'http://localhost:8000',
    rebuild: `${bin}/jupyter-book build .`, enabled: true });
  assert.match(r.stdout, /served at http:\/\/localhost:8000 {3}\(a guess/);
  assert.match(r.stdout, /found on PATH/);
  assert.match(r.stdout, /will be picked up when the companion starts/);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.botference/\n');
  assert.deepEqual(markers.readRegistry(), [root]);
  // again, with nothing said: the values are KEPT, the line is not duplicated
  const again = cli(['site', root, '--serve', ':8001']);
  assert.equal(again.status, 0, again.stderr);
  const m2 = JSON.parse(fs.readFileSync(path.join(root, '.botference', 'site.json'), 'utf8'));
  assert.equal(m2.serve_origin, 'http://localhost:8001');
  assert.equal(m2.rebuild, `${bin}/jupyter-book build .`, 'the rebuild command survives a second run');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.botference/\n');
  assert.deepEqual(markers.readRegistry(), [root]);
  assert.ok(!fs.existsSync(path.join(root, '.git')), 'and no git anywhere');
});

await test('site detects Jekyll and plain, and refuses a kind the folder is not', async () => {
  const j = jekyll('cli-j');
  const r = cli(['site', j, '--no-rebuild']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(j, '.botference', 'site.json'), 'utf8')).serve_origin, 'http://localhost:4000');
  const plain = tmp('cli-plain');
  const p = cli(['site'], {}, plain);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(plain, '.botference', 'site.json'), 'utf8')).kind, 'plain');
  assert.match(p.stdout, /a plain folder/);
  const bad = cli(['site', plain, '--kind', 'jupyterbook']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not a Jupyter Book/);
  const git = cli(['site', book('cli-git'), '--rebuild', 'jupyter-book build . && git push']);
  assert.equal(git.status, 2, 'a rebuild command that names git is refused');
});

{
  reset();
  const early = book('srv-early');
  markers.writeMarker(early, { kind: 'jupyterbook', serve_origin: 'http://localhost:8140' });
  markers.registerRoot(early);
  const workspaceRoot = tmp('srv');
  const { base } = await startServer({ root: workspaceRoot, args: ['--no-agents'] });

  console.log('\nthe companion');

  await test('a project registered before the start is in scope from the first page', async () => {
    const r = await GET(base, '/blog-page?url=' + enc('http://localhost:8140/ch1/ch1.html'));
    assert.equal(r.json.blog.rel, 'ch1/ch1.md', JSON.stringify(r.json));
    assert.equal(r.json.blog.confirmed, true);
  });

  await test('site against a running companion takes effect at once (POST /sites/rescan)', async () => {
    const late = book('srv-late');
    const url = 'http://localhost:8141/ch1/ch1.html';
    assert.equal((await GET(base, '/blog-page?url=' + enc(url))).json.blog, null);
    const r = cli(['site', late, '--serve', 'http://localhost:8141', '--no-rebuild'], { BOTFERENCE_PLUGIN_URL: base });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /companion: picked up/);
    const p = (await GET(base, '/blog-page?url=' + enc(url))).json.blog;
    assert.equal(p.root, late);
    assert.equal(p.confirmed, true);
  });

  await test('sites lists them, and says the companion sees them', async () => {
    const r = cli(['sites'], { BOTFERENCE_PLUGIN_URL: base });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /srv-early/);
    assert.match(r.stdout, /Jupyter Book · http:\/\/localhost:8141 · on · companion sees it/);
  });

  await test('sites --remove takes one out and switches its marker off', async () => {
    const late = markers.readRegistry().find(x => /srv-late/.test(x));
    const r = cli(['sites', '--remove', late], { BOTFERENCE_PLUGIN_URL: base });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /out of scope/);
    assert.match(r.stdout, /companion: dropped it/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(late, '.botference', 'site.json'), 'utf8')).enabled, false);
    assert.ok(!markers.readRegistry().includes(late));
    const s = await GET(base, '/blog-sites');
    assert.ok(!s.json.sites.some(x => x.root === late));
  });

  await test('POST /sites/rescan reports what it skipped', async () => {
    const off = book('srv-off');
    markers.writeMarker(off, { kind: 'jupyterbook', serve_origin: 'http://localhost:8142', enabled: false });
    markers.registerRoot(off);
    const r = await POST(base, '/sites/rescan', {});
    assert.equal(r.status, 200);
    assert.ok(r.json.skipped.some(x => x.root === off && /enabled: false/.test(x.why)));
  });
}

console.log('\nthe launcher');

await test('`botference site --help` and `botference sites` reach the command', async () => {
  const r = spawnSync('bash', [path.join(REPO, 'botference'), 'site', '--help'], { encoding: 'utf8',
    env: { ...process.env, BOTFERENCE_SITES_REGISTRY: REGISTRY } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: botference site/);
  const l = spawnSync('bash', [path.join(REPO, 'botference'), 'sites', '--help'], { encoding: 'utf8' });
  assert.match(l.stdout, /Usage: botference sites/);
});

await test('`botference init` scaffolds and registers the project in one gesture', async () => {
  reset();
  const root = book('init');
  const r = spawnSync('bash', [path.join(REPO, 'botference'), 'init', '--serve', '8150', '--no-rebuild'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, BOTFERENCE_SITES_REGISTRY: REGISTRY, BOTFERENCE_PLUGIN_URL: 'http://127.0.0.1:9' },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(root, 'botference', 'project.json')), 'init still did its own job');
  const m = JSON.parse(fs.readFileSync(path.join(root, '.botference', 'site.json'), 'utf8'));
  assert.deepEqual(m, { kind: 'jupyterbook', serve_origin: 'http://localhost:8150', enabled: true });
  assert.deepEqual(markers.readRegistry(), [root]);
  assert.match(r.stdout, /Discuss: .* is in scope \(Jupyter Book\)/);
});

// --- done ----------------------------------------------------------------
cleanup();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
