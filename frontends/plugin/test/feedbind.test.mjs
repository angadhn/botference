// feedbind.test.mjs — which post a selection on a blyg's HOME FEED claims (extension/feedbind.js). A claim is only a claim: the
// companion verifies it (feedbind-server.test.mjs); here only what is read from the markup.
//
//   node --test test/feedbind.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { Window } = await import(path.join(HERE, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const F = createRequire(import.meta.url)('../extension/feedbind.js');
const A = '0123456789abcdefghjkmnpqrs', B = 'abcdefghjkmnpqrstvwxyz0123', Q = '7c9wk2mhq0v3xj8tn5rzfd41bg';
const HOME = 'https://example.com/blyg/';
function doc(html, url = HOME) {
  const w = new Window({ url });
  w.document.body.innerHTML = html;
  return w.document;
}
const rangeIn = (d, a, b) => { const r = d.createRange(); r.setStart(a, 1); r.setEnd(b, 3); return r; };
// the reference markup of one real Blygger Studio home feed (generator blygger-studio 0.71), shortened
const studio = `
<article class="fragment"><div class="item-content"><p id="pa">Alpha words of the first post.</p></div><a class="permalink" href="/blyg/f/${A}/">#</a></article>
<article class="fragment thread-card"><div class="item-content"><p id="pb">Beta words, and a link to <a href="/blyg/t/${A}/">the first</a>.</p>
<blockquote class="blyg-transclusion" data-blyg-id="${Q}" data-blyg-origin="https://other.example.org/notes/"><p id="pq">Quoted words.</p></blockquote>
<blockquote class="blyg-transclusion" data-blyg-id="${A}"><p id="pown">Own quoted words.</p></blockquote></div>
<p class="read-more"><a href="/blyg/t/${B}/">Read more</a></p></article>
<p id="outside">Between posts.</p>`;

test('a selection inside one post claims that post: its own link alone when it has one (permalink, read-more)', () => {
  const d = doc(studio);
  const pa = d.getElementById('pa').firstChild, pb = d.getElementById('pb').firstChild;
  assert.deepEqual(F.selectionPost(rangeIn(d, pa, pa), HOME), { verdict: 'one', candidates: [{ ids: [A], origin: '' }] });
  assert.deepEqual(F.selectionPost(rangeIn(d, pb, pb), HOME), { verdict: 'one', candidates: [{ ids: [B], origin: '' }] },
    'the read-more link ALONE: the link to the first post inside the text is never tried for it');
  assert.deepEqual(F.FEED_VERDICTS, ['none', 'one', 'cross']);
});

test('THE B/C CASE: an article with NO own link claims every id it links to, and the companion must find exactly one', () => {
  const d = doc(`<article><p id="b">Words of post B, citing <a href="/blyg/t/${Q}/">post C</a>.</p><a href="/blyg/t/${B}/">${B}</a></article>`);
  const b = d.getElementById('b').firstChild;
  assert.deepEqual(F.selectionPost(rangeIn(d, b, b), HOME).candidates, [{ ids: [Q, B], origin: '' }]);
  const src = fs.readFileSync(path.join(HERE, '..', 'server.mjs'), 'utf8');
  assert.match(src, /if \(good\.length !== 1\) return no\(/, 'exactly one must verify');
});

test('inside a quoted post: the QUOTED post at its origin first, then the post around it', () => {
  const d = doc(studio);
  const pq = d.getElementById('pq').firstChild, pown = d.getElementById('pown').firstChild;
  assert.deepEqual(F.selectionPost(rangeIn(d, pq, pq), HOME).candidates, [{ ids: [Q], origin: 'https://other.example.org/notes/' }, { ids: [B], origin: '' }]);
  assert.deepEqual(F.selectionPost(rangeIn(d, pown, pown), HOME).candidates[0], { ids: [A], origin: '' }, 'an own-origin quote has no origin: the page\'s own blyg');
  const bad = doc(studio.replace('https://other.example.org/notes/', 'javascript:alert(1)//'));
  assert.deepEqual(F.selectionPost(rangeIn(bad, bad.getElementById('pq').firstChild, bad.getElementById('pq').firstChild), HOME).candidates, [{ ids: [B], origin: '' }]);
});

test('across two posts, or from a post into the page: cross; outside any post: none', () => {
  const d = doc(studio);
  const pa = d.getElementById('pa').firstChild, pb = d.getElementById('pb').firstChild, out = d.getElementById('outside').firstChild;
  assert.equal(F.selectionPost(rangeIn(d, pa, pb), HOME).verdict, 'cross');
  assert.equal(F.selectionPost(rangeIn(d, pa, out), HOME).verdict, 'cross');
  assert.deepEqual(F.selectionPost(rangeIn(d, out, out), HOME), { verdict: 'none', candidates: [] });
  assert.equal(F.selectionPost(null, HOME).verdict, 'none');
});

test('the generic rule works on another generator\'s feed (the example site: article, /b/<id>)', () => {
  const d = doc(`<div class="blyg-stream"><article class="blyg-stream__item"><div class="blyg-stream__body"><p id="s">Short words.</p></div>
    <p class="blyg-stream__more"><a href="/b/${A}">view →</a></p></article></div>`, 'https://example.com/blyg/');
  const s = d.getElementById('s').firstChild;
  assert.deepEqual(F.selectionPost(rangeIn(d, s, s), 'https://example.com/blyg/').candidates, [{ ids: [A], origin: '' }]);
});

test('nothing is claimed from another site\'s links, a post\'s own page, or a link that is not an id', () => {
  const d = doc(`<article><p id="x">Words.</p><a href="https://elsewhere.example/blyg/t/${A}/">elsewhere</a><a href="/blyg/about/">about</a><a href="javascript:alert(1)">x</a></article>`);
  const x = d.getElementById('x').firstChild;
  assert.equal(F.selectionPost(rangeIn(d, x, x), HOME).verdict, 'none', 'a link to another site\'s post is not this page\'s post');
  const own = doc(`<article><p id="y">Words.</p><a class="permalink" href="/blyg/t/${A}/">#</a></article>`, `https://example.com/blyg/t/${A}/`);
  const y = own.getElementById('y').firstChild;
  assert.equal(F.selectionPost(rangeIn(own, y, y), `https://example.com/blyg/t/${A}/`).verdict, 'none', 'on the post\'s own page the page is the post');
  assert.equal(F.idOf('/blyg/t/not-an-id/', HOME), '');
  assert.equal(F.idOf(`//example.com.evil.example/blyg/t/${A}/`, HOME), '');
  assert.equal(F.idOf(`/blyg/t/${A}/`, HOME), A);
});

test('wired: loaded before content.js; a claim goes to the companion to verify, and only a verified one gets the thread', () => {
  const ext = f => fs.readFileSync(path.join(HERE, '..', 'extension', f), 'utf8');
  const js = JSON.parse(ext('manifest.json')).content_scripts[0].js;
  assert.ok(js.indexOf('feedbind.js') > -1 && js.indexOf('feedbind.js') < js.indexOf('content.js'));
  const c = ext('content.js');
  const save = /async function saveOnFeedPost[\s\S]*?\n  }\n/.exec(c)[0];
  assert.match(save, /api\('POST', '\/blyg\/bind'/);
  assert.match(save, /v\.data\.verdict !== 'verified'/);
  assert.match(save, /url: v\.data\.url/, 'the address the companion answers, never the markup\'s');
  assert.match(save, /return null;/, 'nothing verified: the caller does what it always did');
  assert.match(c, /This passage runs across two posts/);
});
