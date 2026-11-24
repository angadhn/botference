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

async function feedWindow({ threads = {}, holdReply = null, long = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubfeed-'));
  const web = makeWeb();
  const site = web.add(A, { title: 'Alpha Notes' });
  const [one, two] = [1, 2].map(idOf);
  for (const [id, words] of [[one, 'The first post says something quotable about gardens.'], [two, 'The second post talks about kettles and tea.']]) {
    const d = makeDoc({ id, origin: A, kind: 'fragment', title: '', created: id === one ? '2026-11-02T10:00:00Z' : '2026-11-03T10:00:00Z' });
    d.content_html = `<p>${words}</p>`; site.put(d);
  }
  if (long) {
    const d = makeDoc({ id: idOf(3), origin: A, kind: 'thread', title: '', created: '2026-11-04T10:00:00Z', transclusions: [] });
    d.content_html = `<p>${'first block words '.repeat(30)}</p><p>${'second block words '.repeat(30)}</p>`; site.put(d);
  }
  const f = F.createFollowing({ file: path.join(dir, 'f.json'), get: web.get, getSettings: () => CFG.followingSettingsOf({ following_feed_clip_words: 50 }).settings, timers: { set: () => 1, clear: () => {} } });
  await f.confirmImport([{ origin: A }]);
  await f.refresh();
  const data = await f.view();
  for (const e of data.entries) e.head.threads = threads[e.head.id] || [];
  const html = followingPage({ data, settings: CFG.followingSettingsOf({}).settings, nonce: 'N' });
  const w = new GlobalWindow({ url: 'http://127.0.0.1:4189/hub' });
  const calls = [];
  w.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    // the companion answers where it keeps the post (not the address the page's markup states)
    const body = url === '/following/hold' ? { ok: true, url: `${A}items/${one}.json` } : { ok: true, thread: { id: 't-1' } };
    const reply = holdReply ? await holdReply(url, body) : body;
    return { json: async () => reply };
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
  assert.equal(x.calls[1].body.url, `${A}items/${x.one}.json`, 'the thread goes to the address the companion returned from hold, not to the Hub and not to the markup\'s own');
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

const mode = x => x.w.document.documentElement.getAttribute('data-hub-composer');
async function openComposer(x, id = x.one, word = 'quotable') {
  const node = x.text(id);
  await x.select(node, node.data.indexOf(word), node, node.data.indexOf(word) + word.length);
  x.w.document.getElementById('hub-pill').click();
  return x.byId[id].parentNode.querySelector('.hub-composer');
}

test('the composer has ONE named mode (idle, composing, saving), moved through one function: Save pressed twice saves once; Cancel and failure move it back', async () => {
  let release;
  const x = await feedWindow({ holdReply: (url, body) => (url === '/following/hold' ? new Promise(r => { release = () => r(body); }) : body) });
  assert.equal(mode(x), null, 'nothing yet: idle');
  const box = await openComposer(x);
  assert.equal(mode(x), 'composing');
  box.querySelector('textarea').value = 'a comment';
  const save = box.querySelectorAll('button')[0];
  save.click();
  assert.equal(mode(x), 'saving');
  save.click(); save.click();
  assert.deepEqual(x.calls.map(c => c.url), ['/following/hold'], 'a second press while saving does nothing');
  release();
  await new Promise(res => setTimeout(res, 30));
  assert.equal(mode(x), 'idle', 'saved: back to idle');
  assert.deepEqual(x.calls.map(c => c.url), ['/following/hold', '/thread']);
  assert.equal(x.w.document.querySelector('.hub-composer'), null);
  // cancel
  const b2 = await openComposer(x, x.two, 'kettles');
  assert.equal(mode(x), 'composing');
  b2.querySelectorAll('button')[1].click();
  assert.equal(mode(x), 'idle');
  assert.equal(x.w.document.querySelector('.hub-composer'), null);
  // a second selection while composing replaces the first composer: still composing
  await openComposer(x, x.two, 'kettles');
  const b3 = await openComposer(x, x.two, 'tea');
  assert.equal(mode(x), 'composing');
  assert.equal(x.w.document.querySelectorAll('.hub-composer').length, 1);
  x.done();
  // a failure leaves the composer open and composing, with the reason
  const y = await feedWindow({ holdReply: async () => ({ ok: false, error: 'no text is held' }) });
  const b4 = await openComposer(y);
  b4.querySelector('textarea').value = 'text';
  b4.querySelectorAll('button')[0].click();
  await new Promise(res => setTimeout(res, 30));
  assert.equal(mode(y), 'composing');
  assert.match(y.w.document.getElementById('msg').textContent, /no text is held/);
  assert.equal(b4.querySelectorAll('button')[0].disabled, false);
  y.done();
});

test('the "more" control of a long post is one field with two named modes (collapsed, expanded)', async () => {
  const x = await feedWindow({ long: true });
  const body = x.byId[idOf(3)];
  const rest = body.querySelector('.rest'), btn = body.querySelector('button[data-act=more]');
  assert.ok(rest && btn, 'a long post is clipped');
  assert.equal(rest.hidden, true);
  assert.match(rest.textContent, /second block words/);
  btn.click();
  assert.deepEqual([body.dataset.more, rest.hidden, btn.textContent], ['expanded', false, 'less']);
  btn.click();
  assert.deepEqual([body.dataset.more, rest.hidden, btn.textContent], ['collapsed', true, 'more']);
  x.done();
});
