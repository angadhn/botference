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
  assert.deepEqual(p.calls, [{ url: '/following/read', body: { key, move: 'tick', members: [] } }]);
  assert.equal(p.doc.querySelectorAll('article.hub-entry').length, 3);
  assert.equal(p.doc.getElementById('e-' + key), null);
  assert.equal(countOf(p.doc, 'feed'), 3);
  assert.equal(countOf(p.doc, 'archive'), 1);
  assert.equal(p.reloads(), 0, 'no page reload');
  x.done();
});

test('ticking when the Feed falls below its target and the server says a top-up is worth it: one top-up (not a refresh), a reload only if it brought something', async () => {
  const x = await hub({ n: 3 });
  const answers = { '/following/read': { ok: true, read: 'archived', unread: 2, target: 50, topup: true }, '/following/topup': { ok: true, started: true, new: 4 } };
  const p = x.run({}, { reply: url => answers[url] });
  const c = p.doc.querySelector('input.tick');
  p.change(c);
  await p.settle();
  assert.deepEqual(p.calls.map(c2 => c2.url), ['/following/read', '/following/topup']);
  assert.equal(p.reloads(), 1);
  // a top-up that found nothing new does not reload; one that was refused (too soon, or a refresh running) does not either
  for (const second of [{ ok: true, started: true, new: 0 }, { ok: true, started: false, reason: 'topped up a moment ago' }]) {
    answers['/following/topup'] = second;
    const q = x.run({}, { reply: url => answers[url] });
    q.change(q.doc.querySelector('input.tick'));
    await q.settle();
    assert.equal(q.reloads(), 0);
    assert.equal(q.doc.documentElement.getAttribute('data-hub-fetch'), 'idle');
  }
  x.done();
});

test('the page\'s requests are named modes: a row being sent ignores a second change; a top-up in flight is not asked again, nor queued', async () => {
  const x = await hub({ n: 4 });
  let releaseTopup;
  const p = x.run({}, { reply: url => (url === '/following/topup' ? new Promise(res => { releaseTopup = () => res({ ok: true, started: true, new: 0 }); }) : { ok: true, read: 'archived', unread: 2, target: 50, topup: true }) });
  const boxes = [...p.doc.querySelectorAll('input.tick')];
  p.change(boxes[0]);
  const row0 = boxes[0].closest('article');
  assert.equal(row0.dataset.tick, 'sending');
  assert.equal(boxes[0].disabled, true, 'disabled because the row is sending');
  p.change(boxes[0]); // a second change while it is being sent: nothing more is sent
  await p.settle();
  assert.equal(p.doc.documentElement.getAttribute('data-hub-fetch'), 'topping_up');
  p.change(boxes[1]);
  await p.settle();
  assert.deepEqual(p.calls.map(c => c.url), ['/following/read', '/following/topup', '/following/read'], 'one top-up while one is in flight');
  p.doc.querySelector('button[data-act=refresh]').click();
  await p.settle();
  assert.equal(p.calls.length, 3, 'Refresh now waits for the top-up too');
  assert.match(p.doc.getElementById('msg').textContent, /already reading/);
  releaseTopup();
  await p.settle();
  assert.equal(p.doc.documentElement.getAttribute('data-hub-fetch'), 'idle');
  assert.ok(!/c\.disabled\s*=/.test(p.html), 'no disabled flag standing in for a mode');
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
  assert.deepEqual(p.calls, [{ url: '/following/read', body: { ticks: shown.map(key => ({ key, members: [] })) } }]);
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

test('a blyg whose reading back is paused says why, in words, with a Retry that asks for exactly that', async () => {
  const x = await hub({ n: 2 });
  const real = x.f.view;
  x.f.view = q => { const v = real(q); v.blygs[0].backfill = 'paused_bad_documents'; v.blygs[0].bad_documents = 100; return v; };
  const p = x.run();
  const cell = p.doc.querySelector('td.b-state');
  assert.match(cell.textContent, /reading back is paused: this blyg served documents that could not be used\. New posts are still fetched\. \(100 of them\)/);
  assert.ok(cell.querySelector('.b-backfill.warn'));
  const retry = cell.querySelector('button[data-act=retry]');
  retry.click();
  await p.settle();
  assert.deepEqual(p.calls.map(c => [c.url, c.body]), [['/following/state', { origin: A, move: 'retry' }]]);
  x.f.view = real;
  assert.ok(!x.run().doc.querySelector('button[data-act=retry]'), 'no Retry when nothing is paused');
  x.done();
});

test('Unfollow offers the choice plainly, says what each does, and sends which one was chosen; no browser confirm box', async () => {
  const x = await hub({ n: 2 });
  const p = x.run();
  const box = p.doc.querySelector('details.unfollow');
  assert.equal(box.querySelector('summary').textContent, 'Unfollow');
  const text = box.textContent.replace(/\s+/g, ' ');
  assert.match(text, /Stop following Its posts leave the Hub\. The list of posts you have read there is kept, so if you follow it again they do not come back as unread\./);
  assert.match(text, /Stop following and forget what I have read there The list goes too: if you follow it again, every post is unread again\./);
  box.querySelector('button[data-act=unfollow]').click();
  box.querySelector('button[data-act=unfollow-forget]').click();
  await p.settle();
  assert.deepEqual(p.calls.map(c => c.body), [{ origin: A, forget: false }, { origin: A, forget: true }]);
  assert.deepEqual(p.confirms, []);
  x.done();
});

test('an edited post says "edited since you read it" in the Feed; an "edited again" line in the Archive offers Open, Mark read and untick', async () => {
  const x = await hub({ n: 3 });
  const k = x.f.keyFor(A, idOf(2));
  x.f.readMove(k, 'tick');
  x.site.put(makeDoc({ id: idOf(2), origin: A, title: 'Post 2', body: 'New words of post 2.', version: 2, created: day(2), updated: day(20) }));
  await x.f.refresh();
  let p = x.run();
  const art = p.doc.querySelector(`article[data-key="${k}"]`);
  assert.equal(art.querySelector('.hub-edited').textContent, 'edited since you read it');
  assert.equal(art.querySelector('.hub-edited').getAttribute('title'), 'you had read version 1');
  x.f.readMove(k, 'tick');
  x.site.put(makeDoc({ id: idOf(2), origin: A, title: 'Post 2', body: 'Newer words of post 2.', version: 3, created: day(2), updated: day(21) }));
  await x.f.refresh();
  p = x.run({ view: 'archive' });
  const line = p.doc.querySelector(`.aline[data-key="${k}"]`);
  assert.ok(line.classList.contains('hub-archive-changed'));
  assert.match(line.textContent, /edited again/);
  assert.ok(line.querySelector('button[data-act=open]'));
  assert.ok(line.querySelector('input.untick'));
  line.querySelector('button[data-act=mark-read]').click();
  await p.settle();
  assert.deepEqual(p.calls.map(c => c.body), [{ key: k, move: 'tick' }]);
  x.done();
});

test('a thread with folded parts carries their keys; ticking it sends them, and the answer "and its N parts" is said', async () => {
  const x = await hub({ n: 1 });
  const parts = [2, 3].map(k => ({ origin: A, id: idOf(k), version: 1 }));
  for (const k of [2, 3]) x.site.put(makeDoc({ id: idOf(k), origin: A, title: `Part ${k}`, created: '2026-11-05T10:00:00Z' }));
  x.site.put(makeDoc({ id: idOf(9), origin: A, kind: 'thread', title: 'Thread', created: '2026-11-05T10:01:00Z', transclusions: parts }));
  await x.f.refresh();
  const head = x.f.keyFor(A, idOf(9));
  const p = x.run({}, { reply: () => ({ ok: true, read: 'archived', parts: 2, unread: 1, target: 50, topup: false }) });
  const art = p.doc.querySelector(`article[data-key="${head}"]`);
  assert.deepEqual(art.dataset.members.split(' ').sort(), [x.f.keyFor(A, idOf(2)), x.f.keyFor(A, idOf(3))].sort());
  const box = art.querySelector('input.tick');
  box.checked = true;
  p.change(box);
  await p.settle();
  assert.deepEqual(p.calls[0].body.members.sort(), art.dataset.members.split(' ').sort());
  assert.equal(p.doc.getElementById('msg').textContent, 'archived, and its 2 parts');
  assert.equal(countOf(p.doc, 'archive'), 3);
  x.done();
});

test('a mass edit is ONE line at the top of the Archive for that blyg, in words', async () => {
  const x = await hub({ n: 2 });
  const real = x.f.view;
  x.f.view = q => ({ ...real(q), archive_notices: [{ origin: A, blyg_title: 'Alpha Notes', held: 37 }] });
  const p = x.run({ view: 'archive' });
  const lines = p.doc.querySelectorAll('.hub-mass-edit');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, 'Alpha Notes changed 37 posts you had read. They stay here, marked "edited again", and come back to the Feed a few at a time.');
  x.done();
});
