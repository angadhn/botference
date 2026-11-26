// The botference blyg generator (scripts/blyg.mjs): posts in, Blygger 0.4
// files out, and a published version never changed in place.
// Run: node --test tests/blyg.test.mjs
// With BLYG_CHECKER set (blygger-spec/conformance/schemas/lib), the official
// conformance checker also runs over a fresh build and the committed site/blyg/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  build, plan, check, mintId, hashOf, parsePost, renderMarkdown, titleOf,
  newPost, addVersion, outcomeOf, OUTCOMES, ID_RE, Refusal, DEFAULTS,
} from '../scripts/blyg.mjs';

const ORIGIN = 'https://botference.com/blyg/';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blyg-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { posts: path.join(root, 'posts'), out: path.join(root, 'out'), origin: ORIGIN };
}
function write(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}
const ID = '0abcdefghjkmnpqrstvwxyz012';
const post = (body, lines = 'v1: 2026-11-26T10:00:00Z', id = ID) => `---\nid: ${id}\n${lines}\n---\n${body}`;
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const snapshot = dir => Object.fromEntries(fs.readdirSync(dir, { recursive: true })
  .filter(f => fs.statSync(path.join(dir, f)).isFile()).sort().map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

test('a minted id is 26 lowercase Crockford characters', () => {
  for (let i = 0; i < 50; i++) assert.match(mintId(), ID_RE);
  assert.equal(mintId(Buffer.alloc(16, 0)), '0'.repeat(26));
  assert.equal(mintId(Buffer.alloc(16, 255)), '7' + 'z'.repeat(25));
});

test('the outcomes are one named list', () => {
  assert.deepEqual([...OUTCOMES], ['first', 'same', 'next']);
});

test('first build writes the surface, and a second build changes nothing', t => {
  const o = scratch(t);
  write(o.posts, '2026-11-26-a.md', post('# Hello\n\nA [link](https://example.com/x) and [home](../laws.html).\n'));
  const first = build(o);
  assert.equal(first.results[0].outcome, 'first');
  const doc = readJson(path.join(o.out, 'items', `${ID}.json`));
  assert.equal(doc.version, 1);
  assert.equal(doc.kind, 'thread');
  assert.equal(doc.page, `t/${ID}/`);
  assert.deepEqual(doc.transclusions, []);
  assert.equal(doc.content_hash, hashOf(doc.content_md));
  assert.match(doc.content_html, /href="https:\/\/botference.com\/laws.html"/);
  assert.deepEqual(doc.changelog, [{ version: 1, at: '2026-11-26T10:00:00Z', note: null }]);
  const page = fs.readFileSync(path.join(o.out, 't', ID, 'index.html'), 'utf8');
  assert.match(page, new RegExp(`<link rel="alternate" type="application/json" href="${ORIGIN}items/${ID}.json">`));
  const feed = fs.readFileSync(path.join(o.out, 'feed.xml'), 'utf8');
  assert.match(feed, new RegExp(`<guid isPermaLink="false">blyg:${ID}:v1</guid>`));
  assert.match(feed, /<blyg:manifest>https:\/\/botference.com\/blyg\/blyg.json<\/blyg:manifest>/);
  const before = snapshot(o.out);
  const second = build(o);
  assert.equal(second.results[0].outcome, 'same');
  assert.deepEqual(second.changed, []);
  assert.deepEqual(snapshot(o.out), before);
});

test('a text change without a new version line is refused, and nothing is written', t => {
  const o = scratch(t);
  write(o.posts, 'a.md', post('# Hello\n\nOne.\n'));
  build(o);
  const before = snapshot(o.out);
  write(o.posts, 'a.md', post('# Hello\n\nTwo.\n'));
  assert.throws(() => build(o), e => e instanceof Refusal && /differs from published v1/.test(e.message));
  assert.deepEqual(snapshot(o.out), before);
});

test('a text change with a new version line publishes v2 with its note', t => {
  const o = scratch(t);
  const file = write(o.posts, 'a.md', post('# Hello\n\nOne.\n'));
  build(o);
  write(o.posts, 'a.md', post('# Hello\n\nTwo.\n'));
  assert.equal(addVersion(file, 'Changed one word.', { at: '2026-11-27T08:00:00Z' }), 'v2: 2026-11-27T08:00:00Z Changed one word.');
  const r = build(o);
  assert.equal(r.results[0].outcome, 'next');
  const doc = readJson(path.join(o.out, 'items', `${ID}.json`));
  assert.equal(doc.version, 2);
  assert.equal(doc.created, '2026-11-26T10:00:00Z');
  assert.equal(doc.updated, '2026-11-27T08:00:00Z');
  assert.equal(doc.changelog[1].note, 'Changed one word.');
  const feed = fs.readFileSync(path.join(o.out, 'feed.xml'), 'utf8');
  assert.ok(feed.indexOf(`blyg:${ID}:v2`) < feed.indexOf(`blyg:${ID}:v1`), 'newest event first');
  assert.match(feed, /<title>Changed one word. — Hello Two.<\/title>/);
  assert.equal(readJson(path.join(o.out, 'items', 'index.json')).items[0].version, 2);
});

test('a new version line with the same text is refused', t => {
  const o = scratch(t);
  write(o.posts, 'a.md', post('# Hello\n\nOne.\n'));
  build(o);
  write(o.posts, 'a.md', post('# Hello\n\nOne.\n', 'v1: 2026-11-26T10:00:00Z\nv2: 2026-11-27T08:00:00Z'));
  assert.throws(() => build(o), /same text/);
});

test('a published version line cannot be edited or removed', t => {
  const o = scratch(t);
  write(o.posts, 'a.md', post('# Hello\n\nOne.\n'));
  build(o);
  write(o.posts, 'a.md', post('# Hello\n\nOne.\n', 'v1: 2026-11-26T10:00:00Z A late note'));
  assert.throws(() => build(o), /cannot be changed/);
});

test('a published item whose post is gone is refused', t => {
  const o = scratch(t);
  write(o.posts, 'a.md', post('# Hello\n'));
  write(o.posts, 'b.md', post('# Other\n', 'v1: 2026-11-26T11:00:00Z', mintId()));
  build(o);
  fs.rmSync(path.join(o.posts, 'a.md'));
  assert.throws(() => build(o), /cannot be removed/);
});

test('an unpublished post must start at v1 only', () => {
  const p = parsePost(post('x\n', 'v1: 2026-11-26T10:00:00Z\nv2: 2026-11-27T10:00:00Z'));
  assert.throws(() => outcomeOf(p, undefined), /only the v1 line/);
});

test('front matter and text checks refuse bad posts', () => {
  assert.throws(() => parsePost('no front matter'), /no front matter/);
  assert.throws(() => parsePost(post('x', 'v1: 2026-11-26T10:00:00Z', 'short')), /26 lowercase/);
  assert.throws(() => parsePost(post('x', 'v2: 2026-11-26T10:00:00Z')), /v1, v2/);
  assert.throws(() => parsePost(post('x', 'v1: 26 Nov')), /UTC/);
  assert.throws(() => parsePost(post('See ![[' + ID + ']]\n')), /quote\/link grammar/);
  assert.throws(() => parsePost(post('A [TK] mark\n')), /TK/);
  assert.throws(() => parsePost(post('bell \u0007\n')), /control character/);
  assert.throws(() => parsePost(post('é\n')), /NFC/);
});

test('markdown renders with absolute links, escaped text and code inside emphasis', () => {
  const html = renderMarkdown('# T\n\n- **Drafts with `fill-gap`.** See [a](t/x/) & <b>\n  more\n\n1. one\n2. two\n\n> quoted\n', ORIGIN);
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<li><strong>Drafts with <code>fill-gap<\/code>.<\/strong> See <a href="https:\/\/botference.com\/blyg\/t\/x\/">a<\/a> &amp; &lt;b&gt;\nmore<\/li>/);
  assert.match(html, /<ol>\n<li>one<\/li>\n<li>two<\/li>\n<\/ol>/);
  assert.match(html, /<blockquote>\n<p>quoted<\/p>\n<\/blockquote>/);
  assert.throws(() => renderMarkdown('[x](javascript:alert(1))\n', ORIGIN), /http/);
  assert.equal(titleOf('# A *title*\n\nText.\n'), 'A title');
});

test('new writes a post with a fresh id that builds', t => {
  const o = scratch(t);
  const file = newPost('first-post', { posts: o.posts, at: '2026-11-26T10:00:00Z' });
  assert.equal(path.basename(file), '2026-11-26-first-post.md');
  assert.throws(() => newPost('Bad Slug', { posts: o.posts }), /slug/);
  assert.equal(build(o).results[0].outcome, 'first');
});

test('the committed site/blyg/ is what the committed posts build to', () => {
  const { files } = plan();
  for (const [rel, text] of files) {
    assert.equal(fs.readFileSync(path.join(DEFAULTS.out, rel), 'utf8'), text, `site/blyg/${rel} is stale: run node scripts/blyg.mjs build`);
  }
});

test('the conformance checker passes the committed blyg and a two-version build', { skip: !process.env.BLYG_CHECKER && 'BLYG_CHECKER not set' }, async t => {
  const o = scratch(t);
  const file = write(o.posts, 'a.md', post('# Hello\n\nOne.\n'));
  build(o);
  write(o.posts, 'a.md', post('# Hello\n\nTwo.\n'));
  addVersion(file, 'Changed one word.', { at: '2026-11-27T08:00:00Z' });
  build(o);
  for (const out of [o.out, DEFAULTS.out]) {
    const r = await check({ out, origin: ORIGIN });
    const failed = r.docs.filter(d => d.verdict === 'fail').map(d => d.path);
    assert.deepEqual(failed, [], `failing documents under ${out === DEFAULTS.out ? 'site/blyg' : 'a fresh build'}`);
  }
});

test('the site pages link the blyg and advertise it', () => {
  for (const f of ['index.html', 'blygger.html', 'laws.html']) {
    const html = fs.readFileSync(path.join(REPO, 'site', f), 'utf8');
    assert.match(html, /<a href="blyg\/">Blyg<\/a>/, f);
    assert.match(html, /<link rel="blyg" href="https:\/\/botference.com\/blyg\/blyg.json">/, f);
  }
});
