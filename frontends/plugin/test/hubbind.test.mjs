// hubbind.test.mjs — the extension's reading of a selection on the companion's own Hub page (extension/hubbind.js).
//
//   node --test test/hubbind.test.mjs
//
// The binding attributes are honoured ONLY on the companion's own Hub pages; on any other website a page that writes the same
// attributes is not believed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { Window } = await import(path.join(HERE, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const H = createRequire(import.meta.url)('../extension/hubbind.js');
const ID1 = '00000000000000000000000001', ID2 = '00000000000000000000000002';
const BASES = ['http://127.0.0.1:4189'];

function doc(html) {
  const w = new Window({ url: 'http://127.0.0.1:4189/hub' });
  w.document.body.innerHTML = html;
  return w.document;
}
const entry = (id, text, extra = '') => `<article class="hub-entry"><div class="hub-entry-body" data-blyg-page="https://alpha.example.test/notes/f/${id}/" data-blyg-origin="https://alpha.example.test/notes/" data-blyg-id="${id}" data-blyg-version="3"${extra}><p>${text}</p></div></article>`;
const rangeIn = (d, a, b) => { const r = d.createRange(); r.setStart(a, 1); r.setEnd(b, 3); return r; };

test('only the companion\'s own Hub pages are Hub pages: its origin, a Hub path', () => {
  assert.equal(H.isHubPage('http://127.0.0.1:4189/hub', BASES), true);
  assert.equal(H.isHubPage('http://127.0.0.1:4189/hub?view=mentions', BASES), true);
  assert.equal(H.isHubPage('http://127.0.0.1:4189/following', BASES), true);
  assert.equal(H.isHubPage('https://hub.example.test/hub', ['https://hub.example.test/plugin']), true, 'a remote companion\'s origin');
  for (const [url, why] of [['https://evil.example.test/hub', 'another website, the same path'], ['http://127.0.0.1:4190/hub', 'another port'],
    ['http://127.0.0.1:4189/a/abc', 'the companion, not a Hub path'], ['http://127.0.0.1:4189/hub/theme/hub.css', 'a deeper path'],
    ['http://localhost:4189/hub', 'another name for it (not an address the extension is configured with)'], ['https://127.0.0.1:4189/hub', 'another scheme'],
    ['file:///hub', 'a file'], ['not a url', 'nonsense']]) assert.equal(H.isHubPage(url, BASES), false, why);
  assert.equal(H.isHubPage('http://127.0.0.1:4189/hub', []), false, 'no companion known: nothing is honoured');
});

test('HONOURED on the Hub: a node inside a post\'s text is bound to that post (page, origin, id, version)', () => {
  const d = doc(entry(ID1, 'alpha words') + entry(ID2, 'beta words'));
  const t1 = d.querySelectorAll('p')[0].firstChild, t2 = d.querySelectorAll('p')[1].firstChild;
  assert.deepEqual(H.bindingOf(t1, 'http://127.0.0.1:4189/hub', BASES), { page: `https://alpha.example.test/notes/f/${ID1}/`, origin: 'https://alpha.example.test/notes/', id: ID1, version: 3 });
  assert.equal(H.bindingOf(t2, 'http://127.0.0.1:4189/hub', BASES).id, ID2);
  assert.equal(H.bindingOf(d.body, 'http://127.0.0.1:4189/hub', BASES), null, 'outside any post\'s text');
  const one = H.selectionBinding(rangeIn(d, t1, t1), 'http://127.0.0.1:4189/hub', BASES);
  assert.equal(one.verdict, 'one');
  assert.equal(one.binding.id, ID1);
  assert.deepEqual(H.BINDING_VERDICTS, ['none', 'one', 'cross']);
});

test('IGNORED elsewhere: the same markup on any other page binds nothing, however it is written', () => {
  const d = doc(entry(ID1, 'alpha words'));
  const t1 = d.querySelector('p').firstChild;
  for (const url of ['https://evil.example.test/hub', 'https://evil.example.test/some-post', 'http://127.0.0.1:4190/hub', 'http://127.0.0.1:4189/a/abc', 'https://alpha.example.test/notes/t/x/']) {
    assert.equal(H.bindingOf(t1, url, BASES), null, url);
    const sel = H.selectionBinding(rangeIn(d, t1, t1), url, BASES);
    assert.deepEqual([sel.verdict, sel.binding], ['none', null], url);
  }
  // …and with no companion address known (the worker has not answered), not honoured even on the right path
  assert.equal(H.bindingOf(t1, 'http://127.0.0.1:4189/hub', []), null);
});

test('a selection that begins in one post and ends in another, or in none, is refused', () => {
  const d = doc(entry(ID1, 'alpha words') + '<p id="outside">outside text</p>' + entry(ID2, 'beta words'));
  const [p1, p2] = [...d.querySelectorAll('.hub-entry-body p')].map(p => p.firstChild);
  const out = d.getElementById('outside').firstChild;
  assert.equal(H.selectionBinding(rangeIn(d, p1, p2), 'http://127.0.0.1:4189/hub', BASES).verdict, 'cross');
  assert.equal(H.selectionBinding(rangeIn(d, p1, out), 'http://127.0.0.1:4189/hub', BASES).verdict, 'cross');
  assert.equal(H.selectionBinding(rangeIn(d, out, p2), 'http://127.0.0.1:4189/hub', BASES).verdict, 'cross');
  assert.equal(H.selectionBinding(rangeIn(d, out, out), 'http://127.0.0.1:4189/hub', BASES).verdict, 'none');
  assert.equal(H.selectionBinding(null, 'http://127.0.0.1:4189/hub', BASES).verdict, 'none');
});

test('a binding whose attributes are not valid is not believed, even on the Hub', () => {
  for (const [what, html] of [
    ['a page that is not http(s)', entry(ID1, 'x').replace('https://alpha.example.test/notes/f/', 'javascript:alert(1)//')],
    ['an id that is not an id', entry('not-an-id', 'x')],
    ['an origin without its trailing slash', entry(ID1, 'x').replace('notes/"', 'notes"')],
    ['a version that is not a number', entry(ID1, 'x').replace('data-blyg-version="3"', 'data-blyg-version="three"')],
    ['a version below one', entry(ID1, 'x').replace('data-blyg-version="3"', 'data-blyg-version="0"')]]) {
    const d = doc(html);
    assert.equal(H.bindingOf(d.querySelector('p').firstChild, 'http://127.0.0.1:4189/hub', BASES), null, what);
  }
});

test('the extension is wired to it: loaded before content.js, asks the worker for the companion addresses, posts a Hub selection to the post\'s own page with no hints, stands down for the Feed\'s own pill', () => {
  const ext = f => fs.readFileSync(path.join(HERE, '..', 'extension', f), 'utf8');
  const manifest = JSON.parse(ext('manifest.json'));
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf('hubbind.js') > -1 && js.indexOf('hubbind.js') < js.indexOf('content.js'));
  assert.match(ext('background.js'), /case 'companion-bases':[^\n]*CONF\.base/);
  const c = ext('content.js');
  assert.match(c, /HubBind\.selectionBinding\(sel\.getRangeAt\(0\), HREF, COMPANION_BASES\)/);
  assert.match(c, /data-bfp-extension/);
  const save = /async function saveOnHubPost[\s\S]*?\n  }\n/.exec(c)[0];
  assert.match(save, /api\('POST', '\/following\/hold', \{ origin: h\.origin, id: h\.id \}\)/);
  assert.match(save, /url: h\.page/);
  assert.ok(!/blyg_hints/.test(save), 'no hints: the identity is the document\'s');
  assert.match(c, /if \(pendingSel && pendingSel\.hub\) return saveOnHubPost/);
  assert.match(fs.readFileSync(path.join(HERE, '..', 'following-view.mjs'), 'utf8'), /hasAttribute\('data-bfp-extension'\)\)return hide\(\)/);
});
