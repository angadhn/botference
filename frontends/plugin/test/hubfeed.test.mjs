// hubfeed.test.mjs — respond from the Feed: a selection inside one post's text is a highlight on THAT post's page record.
//
//   node --test test/hubfeed.test.mjs
//
// The Feed page is rendered by the real code and run in happy-dom (no layout there, so nothing here measures one) with its two scripts
// (anchor.js and the page's own); `fetch` is a stand-in that records what the page asks the companion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(HERE, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const F = await import('../following.mjs');
const { followingPage } = await import('../following-view.mjs');
const { makeWeb, makeDoc, idOf } = await import('./following-fake.mjs');
const CFG = createRequire(import.meta.url)('../extension/config.js');
const ANCHOR = fs.readFileSync(path.join(HERE, '..', 'extension', 'anchor.js'), 'utf8');
const A = 'https://alpha.web.test/notes/';

async function feedWindow({ threads = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubfeed-'));
  const web = makeWeb();
  const site = web.add(A, { title: 'Alpha Notes' });
  const [one, two] = [1, 2].map(idOf);
  for (const [id, words] of [[one, 'The first post says something quotable about gardens.'], [two, 'The second post talks about kettles and tea.']]) {
    const d = makeDoc({ id, origin: A, kind: 'fragment', title: '', created: id === one ? '2026-11-02T10:00:00Z' : '2026-11-03T10:00:00Z' });
    d.content_html = `<p>${words}</p>`; site.put(d);
  }
  const f = F.createFollowing({ file: path.join(dir, 'f.json'), get: web.get, getSettings: () => CFG.followingSettingsOf({}).settings, timers: { set: () => 1, clear: () => {} } });
  f.confirmImport([{ origin: A }]);
  await f.refresh();
  const data = f.view();
  for (const e of data.entries) e.head.threads = threads[e.head.id] || [];
  const html = followingPage({ data, settings: CFG.followingSettingsOf({}).settings, nonce: 'N' });
  const w = new GlobalWindow({ url: 'http://127.0.0.1:4189/hub' });
  const calls = [];
  w.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const body = url === '/following/hold' ? { ok: true, url: `${A}f/${one}/` } : { ok: true, thread: { id: 't-1' } };
    return { json: async () => body };
  };
  w.document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  // the page's scripts run with this window as the browser's globals
  for (const k of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'getComputedStyle', 'location', 'confirm']) {
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: k === 'window' ? w : w[k] });
  }
  globalThis.fetch = w.fetch;
  (0, eval)(ANCHOR);
  const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(html)[1];
  (0, eval)(script);
  const bodies = [...w.document.querySelectorAll('.hub-entry-body[data-blyg-page]')];
  const byId = Object.fromEntries(bodies.map(b => [b.dataset.blygId, b]));
  const select = async (fromNode, from, toNode, to) => {
    const r = w.document.createRange(); r.setStart(fromNode, from); r.setEnd(toNode, to);
    const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    w.document.dispatchEvent(new w.Event('selectionchange'));
    await new Promise(res => setTimeout(res, 10));
  };
  return { w, calls, byId, one, two, select, text: id => byId[id].querySelector('p').firstChild, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the page script is valid and every entry body carries its binding (page, origin, id, version)', async () => {
  const x = await feedWindow();
  assert.equal(Object.keys(x.byId).length, 2);
  const b = x.byId[x.one];
  assert.deepEqual([b.dataset.blygPage, b.dataset.blygOrigin, b.dataset.blygId, b.dataset.blygVersion], [`${A}f/${x.one}/`, A, x.one, '1']);
  assert.ok(x.w.document.getElementById('hub-pill'), 'the Comment pill is there');
  x.done();
});

test('a selection inside one post: the pill offers a comment, and saving it holds THAT post\'s page (no request) and posts the thread to that page\'s address', async () => {
  const x = await feedWindow();
  const node = x.text(x.one);
  const from = node.data.indexOf('quotable'), to = from + 'quotable about gardens'.length;
  await x.select(node, from, node, to);
  const pill = x.w.document.getElementById('hub-pill');
  assert.equal(pill.hidden, false);
  pill.click();
  const box = x.byId[x.one].parentNode.querySelector('.hub-composer');
  assert.ok(box, 'a composer opens inside that post\'s entry');
  assert.equal(box.querySelector('blockquote').textContent, 'quotable about gardens');
  box.querySelector('textarea').value = 'my comment';
  box.querySelectorAll('button')[0].click();
  await new Promise(res => setTimeout(res, 30));
  assert.deepEqual(x.calls.map(c => c.url), ['/following/hold', '/thread']);
  assert.deepEqual(x.calls[0].body, { origin: A, id: x.one }, 'the post is named by its origin and id, from the entry');
  assert.equal(x.calls[1].body.url, `${A}f/${x.one}/`, 'the thread goes to the post\'s own page record, not to the Hub');
  assert.equal(x.calls[1].body.quote, 'quotable about gardens');
  assert.equal(x.calls[1].body.msg.text, 'my comment');
  assert.ok(!('blyg_hints' in x.calls[1].body), 'no hints: the identity is the entry\'s (item document), never a guess');
  x.done();
});

test('a selection that spans two posts is refused, with a message, and no composer', async () => {
  const x = await feedWindow();
  // (the newest post is listed first, so the range runs from the second post's text back to the first's)
  await x.select(x.text(x.two), 5, x.text(x.one), 10);
  assert.equal(x.w.document.getElementById('hub-pill').hidden, true);
  assert.match(x.w.document.getElementById('msg').textContent, /one post/);
  assert.equal(x.w.document.querySelector('.hub-composer'), null);
  assert.equal(x.calls.length, 0);
  x.done();
});

test('a selection outside any post\'s text does nothing; existing highlights are drawn in their entry', async () => {
  const x = await feedWindow({});
  const h1 = x.w.document.querySelector('h1');
  await x.select(h1.firstChild, 0, h1.firstChild, 2);
  assert.equal(x.w.document.getElementById('hub-pill').hidden, true);
  x.done();
  const y = await feedWindow({ threads: { [idOf(2)]: [{ id: 't-9', quote: 'kettles and tea', prefix: 'talks about ', suffix: '.' }] } });
  const marks = y.byId[y.two].querySelectorAll('mark[data-bfp="t-9"]');
  assert.ok(marks.length >= 1, 'the highlight is painted in the entry it belongs to');
  assert.equal([...marks].map(m => m.textContent).join(''), 'kettles and tea');
  assert.equal(y.byId[y.one].querySelectorAll('mark').length, 0);
  y.done();
});
