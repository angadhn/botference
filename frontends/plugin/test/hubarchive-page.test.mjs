// hubarchive-page.test.mjs — the Hub page's tick box, Archive tab, "Tick all shown", caught-up message, and what a post's own text cannot do.
//
//   node --test test/hubarchive-page.test.mjs
//
// The page is rendered by the real code from the real engine (invented blygs, fake fetch) and run in happy-dom (no layout there:
// the layout is looked at in the screenshots, not here) with its own script; `fetch` is a stand-in that records what the page asks.
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
const A = 'https://alpha.web.test/notes/';
const day = n => `2026-10-${String(1 + n).padStart(2, '0')}T10:00:00Z`;

/** An engine with `n` posts read in, and a way to render its page for a view and to run that page. */
async function hub({ n = 4, settings = {}, evil = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubpage-'));
  const web = makeWeb();
  const site = web.add(A, { title: 'Alpha Notes' });
  for (let k = 1; k <= n; k++) {
    const d = makeDoc({ id: idOf(k), origin: A, title: `Post ${k}`, body: `Distinctive words of post ${k}.`, created: day(k) });
    if (evil && k === n) d.content_html = `<h1>Post ${k}</h1><p>Distinctive words of post ${k}.</p><input type="checkbox" class="tick" data-key="FORGED" data-act="tick" aria-label="Read: move to Archive" checked>`
      + '<button data-act="tick" data-key="FORGED2" class="tick">t</button><form><input name="a"></form><div id="t-FORGED" class="aline" data-key="FORGED3">y</div>';
    site.put(d);
  }
  const f = F.createFollowing({ file: path.join(dir, 'f.json'), get: web.get, getSettings: () => CFG.followingSettingsOf({ following_unread_target: 500, ...settings }).settings, timers: { set: () => 1, clear: () => {} } });
  f.confirmImport([{ origin: A }]);
  await f.refresh();
  await f.refresh(); // (50 documents a blyg a run)
  const x = { f, web, site, dir };
  x.html = (query = {}) => followingPage({ data: f.view(query), settings: CFG.followingSettingsOf({}).settings, nonce: 'N' });
  x.run = (query = {}, { reply = () => ({ ok: true }), confirmAnswer = true } = {}) => {
    const html = x.html(query);
    const w = new GlobalWindow({ url: 'http://127.0.0.1:4189/hub' });
    const calls = [], confirms = [];
    let reloads = 0;
    w.fetch = async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body }); return { json: async () => reply(url, body) }; };
    w.confirm = q => { confirms.push(q); return confirmAnswer; };
    w.document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
    for (const k of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'getComputedStyle', 'confirm']) {
      Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: k === 'window' ? w : w[k] });
    }
    Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { reload: () => { reloads++; }, href: '' } });
    globalThis.fetch = w.fetch;
    const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(html)[1];
    (0, eval)(script);
    return { w, html, calls, confirms, reloads: () => reloads, doc: w.document,
      change: el => el.dispatchEvent(new w.Event('change', { bubbles: true })),
      settle: () => new Promise(r => setTimeout(r, 20)) };
  };
  x.done = () => fs.rmSync(dir, { recursive: true, force: true });
  return x;
}
const countOf = (doc, name) => Number(doc.querySelector(`[data-n="${name}"]`).textContent);

test('Feed: every post has a tick box at the start of its header line, labelled "Read: move to Archive", reachable by keyboard', async () => {
  const x = await hub({ n: 4 });
  const p = x.run();
  const entries = [...p.doc.querySelectorAll('article.hub-entry')];
  assert.equal(entries.length, 4);
  for (const e of entries) {
    const first = e.querySelector('.hub-entry-meta').firstElementChild;
    assert.equal(first.tagName, 'INPUT', 'the tick box is the first thing on the header line');
    assert.equal(first.type, 'checkbox');
    assert.equal(first.getAttribute('aria-label'), 'Read: move to Archive');
    assert.ok(first.classList.contains('tick'));
    assert.equal(first.dataset.key, e.dataset.key);
    assert.equal(first.getAttribute('tabindex'), null, 'in the tab order');
    assert.equal(first.disabled, false);
    assert.equal(first.checked, false);
  }
  assert.equal(p.doc.querySelectorAll('input.tick').length, 4, 'one per post, and nothing else on the page');
  const tabs = [...p.doc.querySelectorAll('nav.hub-tabs a')].map(a => a.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(tabs, ['Feed (4)', 'Mentions (0)', 'Background (0)', 'Archive (0)']);
  assert.ok(!/Mark seen|Mark all seen|data-act="(see|seen-all)"/.test(p.html), 'no "seen" any more');
  assert.match(p.html, /data-act="tick-all">Tick all shown</);
  x.done();
});

test('ticking: one click posts the tick, the post leaves the page in place (no reload), the counts follow; the next unread posts are already there', async () => {
  const x = await hub({ n: 4 });
  const p = x.run({}, { reply: () => ({ ok: true, read: 'archived', unread: 3, target: 50, topup: false }) });
  const first = p.doc.querySelector('input.tick');
  const key = first.dataset.key;
  first.checked = true;
  p.change(first);
  await p.settle();
  assert.deepEqual(p.calls, [{ url: '/following/read', body: { key, move: 'tick' } }]);
  assert.equal(p.doc.querySelectorAll('article.hub-entry').length, 3);
  assert.equal(p.doc.getElementById('e-' + key), null);
  assert.equal(countOf(p.doc, 'feed'), 3);
  assert.equal(countOf(p.doc, 'archive'), 1);
  assert.equal(p.reloads(), 0, 'no page reload');
  x.done();
});

test('ticking when the Feed falls below its target and the server says a top-up is worth it: one refresh, and a reload only if it brought something', async () => {
  const x = await hub({ n: 3 });
  const answers = { '/following/read': { ok: true, read: 'archived', unread: 2, target: 50, topup: true }, '/following/refresh': { ok: true, started: true, new: 4 } };
  const p = x.run({}, { reply: url => answers[url] });
  const c = p.doc.querySelector('input.tick');
  p.change(c);
  await p.settle();
  assert.deepEqual(p.calls.map(c2 => c2.url), ['/following/read', '/following/refresh']);
  assert.equal(p.reloads(), 1);
  // a refresh that found nothing new does not reload; one that was refused (already running) does not either
  for (const second of [{ ok: true, started: true, new: 0 }, { ok: true, started: false, reason: 'a refresh is already running' }]) {
    answers['/following/refresh'] = second;
    const q = x.run({}, { reply: url => answers[url] });
    q.change(q.doc.querySelector('input.tick'));
    await q.settle();
    assert.equal(q.reloads(), 0);
  }
  // topup false: no refresh at all
  answers['/following/read'] = { ok: true, read: 'archived', unread: 2, target: 50, topup: false };
  const q = x.run({}, { reply: url => answers[url] });
  q.change(q.doc.querySelector('input.tick'));
  await q.settle();
  assert.deepEqual(q.calls.map(c2 => c2.url), ['/following/read']);
  x.done();
});

test('a tick that fails leaves the post where it is, the box unticked again, and says why', async () => {
  const x = await hub({ n: 2 });
  const p = x.run({}, { reply: () => ({ ok: false, error: 'no such post' }) });
  const c = p.doc.querySelector('input.tick');
  c.checked = true;
  p.change(c);
  await p.settle();
  assert.equal(p.doc.querySelectorAll('article.hub-entry').length, 2);
  assert.equal(c.checked, false);
  assert.equal(c.disabled, false);
  assert.equal(p.doc.getElementById('msg').textContent, 'no such post');
  assert.equal(countOf(p.doc, 'feed'), 2);
  x.done();
});

test('Tick all shown: asks first; sends exactly the posts shown (not the ones the search hides); declining sends nothing', async () => {
  const x = await hub({ n: 4 });
  let p = x.run({}, { confirmAnswer: false });
  p.doc.querySelector('button[data-act=tick-all]').click();
  await p.settle();
  assert.equal(p.confirms.length, 1);
  assert.match(p.confirms[0], /Move the 4 posts shown to the Archive\?/);
  assert.deepEqual(p.calls, [], 'declined: nothing is sent');
  p = x.run();
  const search = p.doc.getElementById('hub-search');
  search.value = 'post 2';
  search.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.doc.querySelector('button[data-act=tick-all]').click();
  await p.settle();
  assert.match(p.confirms[0], /Move the 1 post shown/);
  const shown = [...p.doc.querySelectorAll('article.hub-entry')].filter(e => !e.hidden).map(e => e.dataset.key);
  assert.deepEqual(p.calls, [{ url: '/following/read', body: { keys: shown } }]);
  assert.equal(shown.length, 1);
  x.done();
});

test('Archive: lines with kind, blyg, title, date, Open original and an untick box; NO text of the post; counts right', async () => {
  const x = await hub({ n: 5 });
  x.f.tickMany([2, 4, 5].map(k => x.f.keyFor(A, idOf(k))));
  const p = x.run({ view: 'archive' });
  const lines = [...p.doc.querySelectorAll('.hub-archive-line')];
  assert.equal(lines.length, 3);
  const text = lines.map(l => l.textContent.replace(/\s+/g, ' ').trim());
  for (const t of text) {
    assert.match(t, /fragment/);
    assert.match(t, /Alpha Notes/);
    assert.match(t, /Open original/);
    assert.ok(!/Distinctive words/.test(t), 'no body text');
  }
  assert.ok(!/Distinctive words/.test(p.html), 'none anywhere on the Archive page');
  assert.ok(/Post [245]/.test(text[0]));
  const un = lines[0].querySelector('input.untick');
  assert.equal(un.checked, true);
  assert.equal(un.getAttribute('aria-label'), 'Unread again: move back to the Feed');
  assert.ok(lines[0].querySelector('button[data-act=open]'));
  assert.equal(p.doc.querySelectorAll('input.tick').length, 0, 'the Feed\'s boxes are not on this tab');
  assert.equal(p.doc.querySelector('button[data-act=tick-all]'), null, 'Tick all shown belongs to the Feed');
  assert.deepEqual([...p.doc.querySelectorAll('nav.hub-tabs a')].map(a => a.textContent.replace(/\s+/g, ' ').trim()), ['Feed (2)', 'Mentions (0)', 'Background (0)', 'Archive (3)']);
  assert.equal(p.doc.querySelector('nav.hub-tabs a[aria-current=page]').textContent.replace(/\s+/g, ' ').trim(), 'Archive (3)');
  assert.ok(!p.doc.querySelector('nav.filters:not(.hub-tabs)'), 'the Feed\'s sub-filters are not on the Archive');
  assert.ok(p.doc.querySelector('input[type=search][name=q]'), 'a search box, which asks the companion (all records, not only the shown ones)');
  // unticking from here
  un.checked = false;
  p.change(un);
  await p.settle();
  assert.deepEqual(p.calls, [{ url: '/following/read', body: { key: un.dataset.key, move: 'untick' } }]);
  assert.equal(p.doc.querySelectorAll('.hub-archive-line').length, 2);
  assert.equal(countOf(p.doc, 'archive'), 2);
  assert.equal(countOf(p.doc, 'feed'), 3);
  x.done();
});

test('the Archive pages: 50 lines at a time with "show more"; a search that matches nothing says so; an empty Archive says what to do', async () => {
  const x = await hub({ n: 60 });
  x.f.tickMany(x.f.view({ limit: 1000 }).entries.map(e => e.head.key));
  const first = x.run({ view: 'archive', limit: F.LIMITS.archivePage });
  assert.equal(first.doc.querySelectorAll('.hub-archive-line').length, 50);
  assert.match(first.html, /50 of 60 shown\. <a href="\/hub\?view=archive&amp;n=100">show more<\/a>/);
  const none = x.run({ view: 'archive', q: 'zzzz', limit: 50 });
  assert.match(none.html, /Nothing in the Archive matches that\./);
  const empty = await hub({ n: 1 });
  assert.match(empty.run({ view: 'archive' }).html, /Nothing archived yet\. Tick a post in the Feed/);
  empty.done(); x.done();
});

test('when everything is read the Feed says so plainly; before that, it does not', async () => {
  const x = await hub({ n: 3 });
  assert.ok(!/You have read everything/.test(x.html()));
  x.f.tickMany(x.f.view().entries.map(e => e.head.key));
  const p = x.run();
  const m = p.doc.querySelector('.caught-up');
  assert.equal(m.textContent, 'You have read everything from the blygs you follow.');
  assert.equal(p.doc.querySelector('button[data-act=tick-all]'), null, 'nothing to tick');
  // a Feed that is empty only because nothing has been fetched yet is not "read everything"
  const y = await hub({ n: 3, settings: { following_unread_target: 1 } });
  y.f.tickMany(y.f.view().entries.map(e => e.head.key));
  assert.ok(!/You have read everything/.test(y.html()), 'a blyg with more to read back is "more", not "caught up"');
  assert.match(y.html(), /A refresh reads further back/);
  y.done(); x.done();
});

test('nothing in a post\'s text can forge a tick control: the sanitiser strips inputs, ids, classes and data attributes; and a stray one would be ignored', async () => {
  const x = await hub({ n: 2, evil: true });
  const p = x.run();
  assert.ok(!/FORGED/.test(p.html), 'no trace of the forged keys in the page');
  const boxes = p.doc.querySelectorAll('input.tick');
  assert.equal(boxes.length, 2, 'only the page\'s own boxes (one per post)');
  assert.equal(p.doc.querySelectorAll('.hub-entry-body input, .hub-entry-body button, .hub-entry-body form').length, 0);
  assert.equal(p.doc.querySelectorAll('.hub-entry-body [id], .hub-entry-body [data-key], .hub-entry-body .tick').length, 0, 'no ids, keys or tick classes inside a post\'s text');
  assert.equal(p.doc.querySelector('.hub-entry-body .aline'), null);
  // even a control that did land inside a post's text is ignored by the page's handler
  const body = p.doc.querySelector('.hub-entry-body');
  const rogue = p.doc.createElement('input');
  rogue.type = 'checkbox'; rogue.className = 'tick'; rogue.dataset.key = 'ROGUE';
  body.appendChild(rogue);
  p.change(rogue);
  await p.settle();
  assert.deepEqual(p.calls, []);
  x.done();
});

test('Background and Mentions are unchanged by the Archive; the Following table says how far back each blyg has been read', async () => {
  const x = await hub({ n: 3, settings: { following_unread_target: 2 } });
  const html = x.html();
  assert.match(html, /more to fetch/);
  assert.match(html, /2 unread/);
  x.f.tickMany(x.f.view().entries.map(e => e.head.key));
  assert.match(x.html(), /2 archived/);
  x.done();
});
