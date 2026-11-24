// hubarchive-page.test.mjs — the Hub page's Read button and star, the Archive and Starred tabs, "Mark all read", the caught-up message,
// and what a post's own text cannot do.
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
      + '<button data-act="tick" data-key="FORGED2" class="tick" aria-label="Mark as read: move to Archive">\u2713 Read</button><button data-act="star" data-key="FORGED4" class="star">\u2606 Star</button>'
      + '<form><input name="a"></form><div id="t-FORGED" class="aline" data-key="FORGED3">y</div>';
    site.put(d);
  }
  const f = F.createFollowing({ file: path.join(dir, 'f.json'), get: web.get, getSettings: () => CFG.followingSettingsOf({ following_unread_target: 500, ...settings }).settings, timers: { set: () => 1, clear: () => {} } });
  await f.confirmImport([{ origin: A }]);
  await f.refresh();
  await f.refresh(); // (50 documents a blyg a run)
  const x = { f, web, site, dir };
  x.html = async (query = {}) => followingPage({ data: await f.view(query), settings: CFG.followingSettingsOf({}).settings, nonce: 'N' });
  x.run = async (query = {}, { reply = () => ({ ok: true }), confirmAnswer = true } = {}) => {
    const html = await x.html(query);
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
      press: el => el.click(),
      settle: () => new Promise(r => setTimeout(r, 20)) };
  };
  x.done = () => fs.rmSync(dir, { recursive: true, force: true });
  return x;
}
const countOf = (doc, name) => Number(doc.querySelector(`[data-n="${name}"]`).textContent);

test('Feed: every post has ONE "✓ Read" button under its text, beside Open original, labelled for what it does, reachable by keyboard', async () => {
  const x = await hub({ n: 4 });
  const p = await x.run();
  const entries = [...p.doc.querySelectorAll('article.hub-entry')];
  assert.equal(entries.length, 4);
  for (const e of entries) {
    const row = e.querySelector('.hub-entry-actions');
    const read = row.querySelectorAll('button.tick');
    assert.equal(read.length, 1, 'once per post, in its row of actions');
    assert.equal(read[0].textContent, '\u2713 Read');
    assert.equal(read[0].getAttribute('aria-label'), 'Mark as read: move to Archive');
    assert.equal(read[0].dataset.key, e.dataset.key);
    assert.equal(read[0].getAttribute('tabindex'), null, 'a button: in the tab order');
    assert.equal(read[0].disabled, false);
    const names = [...row.children].map(b => b.textContent.trim());
    assert.deepEqual(names.slice(-3), ['Open original', '\u2713 Read', '\u2606 Star'], 'Open original, Read, Star (then the … menu when there is one)');
    assert.equal(e.querySelector('.hub-entry-meta input'), null, 'nothing to tick on the meta line any more');
  }
  assert.equal(p.doc.querySelectorAll('button.tick').length, 4, 'one per post, and nothing else on the page');
  assert.equal(p.doc.querySelectorAll('input[type=checkbox]').length, 0);
  const tabs = [...p.doc.querySelectorAll('nav.hub-tabs a')].map(a => a.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(tabs, ['Feed (4)', 'Mentions (0)', 'Background (0)', 'Starred (0)', 'Archive (0)']);
  assert.ok(!/Mark seen|Mark all seen|Tick all shown|data-act="(see|seen-all)"/.test(p.html), 'no "seen", no "Tick all shown"');
  assert.match(p.html, /data-act="tick-all">Mark all read</);
  x.done();
});

test('ticking: one click posts the tick, the post leaves the page in place (no reload), the counts follow; the next unread posts are already there', async () => {
  const x = await hub({ n: 4 });
  const p = await x.run({}, { reply: () => ({ ok: true, read: 'archived', unread: 3, target: 50, topup: false }) });
  const first = p.doc.querySelector('button.tick');
  const key = first.dataset.key;
  p.press(first);
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
  const p = await x.run({}, { reply: url => answers[url] });
  p.press(p.doc.querySelector('button.tick'));
  await p.settle();
  assert.deepEqual(p.calls.map(c2 => c2.url), ['/following/read', '/following/topup']);
  assert.equal(p.reloads(), 1);
  // a top-up that found nothing new does not reload; one that was refused (too soon, or a refresh running) does not either
  for (const second of [{ ok: true, started: true, new: 0 }, { ok: true, started: false, reason: 'topped up a moment ago' }]) {
    answers['/following/topup'] = second;
    const q = await x.run({}, { reply: url => answers[url] });
    q.press(q.doc.querySelector('button.tick'));
    await q.settle();
    assert.equal(q.reloads(), 0);
    assert.equal(q.doc.documentElement.getAttribute('data-hub-fetch'), 'idle');
  }
  x.done();
});

test('the page\'s requests are named modes: a row being sent ignores a second change; a top-up in flight is not asked again, nor queued', async () => {
  const x = await hub({ n: 4 });
  let releaseTopup;
  const p = await x.run({}, { reply: url => (url === '/following/topup' ? new Promise(res => { releaseTopup = () => res({ ok: true, started: true, new: 0 }); }) : { ok: true, read: 'archived', unread: 2, target: 50, topup: true }) });
  const boxes = [...p.doc.querySelectorAll('button.tick')];
  p.press(boxes[0]);
  const row0 = boxes[0].closest('article');
  assert.equal(row0.dataset.tick, 'sending');
  assert.equal(row0.getAttribute('aria-busy'), 'true', 'aria-busy shows the mode');
  assert.equal(boxes[0].disabled, false, 'no disabled flag standing in for the mode');
  p.press(boxes[0]); // a second press while it is being sent: nothing more is sent
  p.press(row0.querySelector('button.star'));
  await p.settle();
  assert.equal(p.doc.documentElement.getAttribute('data-hub-fetch'), 'topping_up');
  p.press(boxes[1]);
  await p.settle();
  assert.deepEqual(p.calls.map(c => c.url), ['/following/read', '/following/topup', '/following/read'], 'one top-up while one is in flight');
  p.doc.querySelector('button[data-act=refresh]').click();
  await p.settle();
  assert.equal(p.calls.length, 3, 'Refresh now waits for the top-up too');
  assert.match(p.doc.getElementById('msg').textContent, /already reading/);
  releaseTopup();
  await p.settle();
  assert.equal(p.doc.documentElement.getAttribute('data-hub-fetch'), 'idle');
  assert.ok(!/\.disabled\s*=\s*to/.test(p.html), 'no disabled flag standing in for a mode');
  x.done();
});

test('a Read that fails leaves the post where it is, its row ready again with the same button, and says why', async () => {
  const x = await hub({ n: 2 });
  const p = await x.run({}, { reply: () => ({ ok: false, error: 'no such post' }) });
  const c = p.doc.querySelector('button.tick');
  p.press(c);
  await p.settle();
  assert.equal(p.doc.querySelectorAll('article.hub-entry').length, 2);
  const row = c.closest('article');
  assert.equal(row.dataset.tick, 'ready');
  assert.equal(row.getAttribute('aria-busy'), 'false');
  assert.equal(c.textContent, '\u2713 Read');
  assert.equal(p.doc.getElementById('msg').textContent, 'no such post');
  assert.equal(countOf(p.doc, 'feed'), 2);
  // and it can be pressed again
  p.press(c);
  await p.settle();
  assert.equal(p.calls.length, 2);
  x.done();
});

test('Mark all read: asks first; sends exactly the posts shown (not the ones the search hides); declining sends nothing', async () => {
  const x = await hub({ n: 4 });
  let p = await x.run({}, { confirmAnswer: false });
  p.doc.querySelector('button[data-act=tick-all]').click();
  await p.settle();
  assert.equal(p.confirms.length, 1);
  assert.match(p.confirms[0], /Mark the 4 posts shown as read \(move them to the Archive\)\?/);
  assert.deepEqual(p.calls, [], 'declined: nothing is sent');
  p = await x.run();
  const search = p.doc.getElementById('hub-search');
  search.value = 'post 2';
  search.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.doc.querySelector('button[data-act=tick-all]').click();
  await p.settle();
  assert.match(p.confirms[0], /Mark the 1 post shown as read/);
  const shown = [...p.doc.querySelectorAll('article.hub-entry')].filter(e => !e.hidden).map(e => e.dataset.key);
  assert.deepEqual(p.calls, [{ url: '/following/read', body: { ticks: shown.map(key => ({ key, members: [] })) } }]);
  assert.equal(shown.length, 1);
  x.done();
});

test('Archive: lines with an Unread button, kind, blyg, title, date and Open original; NO text of the post; counts right', async () => {
  const x = await hub({ n: 5 });
  await x.f.tickMany((await Promise.all([2, 4, 5].map(async k => await x.f.keyFor(A, idOf(k))))));
  const p = await x.run({ view: 'archive' });
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
  const un = lines[0].querySelector('button.untick');
  assert.equal(lines[0].firstElementChild, un, 'where the ticked box was: first on the line');
  assert.equal(un.textContent, 'Unread');
  assert.equal(un.getAttribute('aria-label'), 'Unread: move back to the Feed');
  assert.ok(lines[0].querySelector('button[data-act=open]'));
  assert.equal(p.doc.querySelectorAll('button.tick').length, 0, 'the Feed\'s Read buttons are not on this tab');
  assert.equal(p.doc.querySelector('button[data-act=tick-all]'), null, 'Mark all read belongs to the Feed');
  assert.deepEqual([...p.doc.querySelectorAll('nav.hub-tabs a')].map(a => a.textContent.replace(/\s+/g, ' ').trim()), ['Feed (2)', 'Mentions (0)', 'Background (0)', 'Starred (0)', 'Archive (3)']);
  assert.equal(p.doc.querySelector('nav.hub-tabs a[aria-current=page]').textContent.replace(/\s+/g, ' ').trim(), 'Archive (3)');
  assert.ok(!p.doc.querySelector('nav.filters:not(.hub-tabs)'), 'the Feed\'s sub-filters are not on the Archive');
  assert.ok(p.doc.querySelector('input[type=search][name=q]'), 'a search box, which asks the companion (all records, not only the shown ones)');
  // back to the Feed from here
  p.press(un);
  await p.settle();
  assert.deepEqual(p.calls, [{ url: '/following/read', body: { key: un.dataset.key, move: 'untick' } }]);
  assert.equal(p.doc.querySelectorAll('.hub-archive-line').length, 2);
  assert.equal(countOf(p.doc, 'archive'), 2);
  assert.equal(countOf(p.doc, 'feed'), 3);
  x.done();
});

test('the Archive pages: 50 lines at a time with "show more"; a search that matches nothing says so; an empty Archive says what to do', async () => {
  const x = await hub({ n: 60 });
  await x.f.tickMany((await x.f.view({ limit: 1000 })).entries.map(e => e.head.key));
  const first = await x.run({ view: 'archive', limit: F.LIMITS.archivePage });
  assert.equal(first.doc.querySelectorAll('.hub-archive-line').length, 50);
  assert.match(first.html, /50 of 60 shown\. <a href="\/hub\?view=archive&amp;n=100">show more<\/a>/);
  const none = await x.run({ view: 'archive', q: 'zzzz', limit: 50 });
  assert.match(none.html, /Nothing in the Archive matches that\./);
  const empty = await hub({ n: 1 });
  assert.match((await empty.run({ view: 'archive' })).html, /Nothing archived yet\. Tick a post in the Feed/);
  empty.done(); x.done();
});

test('when everything is read the Feed says so plainly; before that, it does not', async () => {
  const x = await hub({ n: 3 });
  assert.ok(!/You have read everything/.test(await x.html()));
  await x.f.tickMany((await x.f.view()).entries.map(e => e.head.key));
  const p = await x.run();
  const m = p.doc.querySelector('.caught-up');
  assert.equal(m.textContent, 'You have read everything from the blygs you follow.');
  assert.equal(p.doc.querySelector('button[data-act=tick-all]'), null, 'nothing to tick');
  // a Feed that is empty only because nothing has been fetched yet is not "read everything"
  const y = await hub({ n: 3, settings: { following_unread_target: 1 } });
  await y.f.tickMany((await y.f.view()).entries.map(e => e.head.key));
  assert.ok(!/You have read everything/.test(await y.html()), 'a blyg with more to read back is "more", not "caught up"');
  assert.match(await y.html(), /A refresh reads further back/);
  y.done(); x.done();
});

test('nothing in a post\'s text can forge a Read or Star control: the sanitiser strips buttons, inputs, ids, classes and data attributes; and a stray one would be ignored', async () => {
  const x = await hub({ n: 2, evil: true });
  const p = await x.run();
  assert.ok(!/FORGED/.test(p.html), 'no trace of the forged keys in the page');
  assert.equal(p.doc.querySelectorAll('button.tick').length, 2, 'only the page\'s own Read buttons (one per post)');
  assert.equal(p.doc.querySelectorAll('button.star').length, 2, 'and stars');
  assert.equal(p.doc.querySelectorAll('[aria-label="Mark as read: move to Archive"]').length, 2);
  assert.equal(p.doc.querySelectorAll('.hub-entry-body input, .hub-entry-body button, .hub-entry-body form').length, 0);
  assert.equal(p.doc.querySelectorAll('.hub-entry-body [id], .hub-entry-body [data-key], .hub-entry-body .tick').length, 0, 'no ids, keys or tick classes inside a post\'s text');
  assert.equal(p.doc.querySelector('.hub-entry-body .aline'), null);
  // even a control that did land inside a post's text is ignored by the page's handler
  const body = p.doc.querySelector('.hub-entry-body');
  for (const act of ['tick', 'star', 'untick']) {
    const rogue = p.doc.createElement('button');
    rogue.className = act; rogue.dataset.act = act; rogue.dataset.key = 'ROGUE';
    body.appendChild(rogue);
    p.press(rogue);
  }
  await p.settle();
  assert.deepEqual(p.calls, []);
  x.done();
});

test('Background and Mentions are unchanged by the Archive; the Following table says how far back each blyg has been read', async () => {
  const x = await hub({ n: 3, settings: { following_unread_target: 2 } });
  const html = await x.html();
  assert.match(html, /more to fetch/);
  assert.match(html, /2 unread/);
  await x.f.tickMany((await x.f.view()).entries.map(e => e.head.key));
  assert.match(await x.html(), /2 archived/);
  x.done();
});

test('a blyg whose reading back is paused says why, in words, with a Retry that asks for exactly that', async () => {
  const x = await hub({ n: 2 });
  const real = x.f.view;
  x.f.view = async q => { const v = await real(q); v.blygs[0].backfill = 'paused_bad_documents'; v.blygs[0].bad_documents = 100; return v; };
  const p = await x.run();
  const cell = p.doc.querySelector('td.b-state');
  assert.match(cell.textContent, /reading back is paused: this blyg served documents that could not be used\. New posts are still fetched\. \(100 of them\)/);
  assert.ok(cell.querySelector('.b-backfill.warn'));
  const retry = cell.querySelector('button[data-act=retry]');
  retry.click();
  await p.settle();
  assert.deepEqual(p.calls.map(c => [c.url, c.body]), [['/following/state', { origin: A, move: 'retry' }]]);
  x.f.view = real;
  assert.ok(!(await x.run()).doc.querySelector('button[data-act=retry]'), 'no Retry when nothing is paused');
  x.done();
});

test('Unfollow offers the choice plainly, says what each does, and sends which one was chosen; no browser confirm box', async () => {
  const x = await hub({ n: 2 });
  const p = await x.run();
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
  const k = await x.f.keyFor(A, idOf(2));
  await x.f.readMove(k, 'tick');
  x.site.put(makeDoc({ id: idOf(2), origin: A, title: 'Post 2', body: 'New words of post 2.', version: 2, created: day(2), updated: day(20) }));
  await x.f.refresh();
  let p = await x.run();
  const art = p.doc.querySelector(`article[data-key="${k}"]`);
  assert.equal(art.querySelector('.hub-edited').textContent, 'edited since you read it');
  assert.equal(art.querySelector('.hub-edited').getAttribute('title'), 'you had read version 1');
  await x.f.readMove(k, 'tick');
  x.site.put(makeDoc({ id: idOf(2), origin: A, title: 'Post 2', body: 'Newer words of post 2.', version: 3, created: day(2), updated: day(21) }));
  await x.f.refresh();
  p = await x.run({ view: 'archive' });
  const line = p.doc.querySelector(`.aline[data-key="${k}"]`);
  assert.ok(line.classList.contains('hub-archive-changed'));
  assert.match(line.textContent, /edited again/);
  assert.ok(line.querySelector('button[data-act=open]'));
  assert.ok(line.querySelector('button.untick'));
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
  const head = await x.f.keyFor(A, idOf(9));
  const p = await x.run({}, { reply: () => ({ ok: true, read: 'archived', parts: 2, unread: 1, target: 50, topup: false }) });
  const art = p.doc.querySelector(`article[data-key="${head}"]`);
  assert.deepEqual(art.dataset.members.split(' ').sort(), [await x.f.keyFor(A, idOf(2)), await x.f.keyFor(A, idOf(3))].sort());
  const box = art.querySelector('button.tick');
  assert.equal(box.textContent, '\u2713 Read (and its 2 parts)');
  assert.equal(box.getAttribute('aria-label'), 'Mark as read: move to Archive (and its 2 parts)');
  p.press(box);
  await p.settle();
  assert.deepEqual(p.calls[0].body.members.sort(), art.dataset.members.split(' ').sort());
  assert.equal(p.doc.getElementById('msg').textContent, 'archived, and its 2 parts');
  assert.equal(countOf(p.doc, 'archive'), 3);
  x.done();
});

test('a mass edit is ONE line at the top of the Archive for that blyg, in words', async () => {
  const x = await hub({ n: 2 });
  const real = x.f.view;
  x.f.view = async q => ({ ...(await real(q)), archive_notices: [{ origin: A, blyg_title: 'Alpha Notes', held: 37 }] });
  const p = await x.run({ view: 'archive' });
  const lines = p.doc.querySelectorAll('.hub-mass-edit');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, 'Alpha Notes changed 37 posts you had read. They stay here, marked "edited again", and come back to the Feed a few at a time.');
  x.done();
});

test('a companion that cannot be reached (the request itself fails): the row, the top-up and Refresh now all come back to rest and say so', async () => {
  const x = await hub({ n: 3 });
  const p = await x.run();
  p.w.fetch = globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const box = p.doc.querySelector('button.tick');
  p.press(box);
  await p.settle();
  const row = box.closest('article');
  assert.equal(row.dataset.tick, 'ready', 'the row is not left sending');
  assert.equal(row.getAttribute('aria-busy'), 'false');
  const star = row.querySelector('button.star');
  p.press(star);
  await p.settle();
  assert.equal(row.dataset.tick, 'ready', 'nor after a star that could not be sent');
  assert.equal(star.textContent, '\u2606 Star', 'and the star says what is stored: not starred');
  assert.equal(p.doc.getElementById('msg').textContent, 'could not reach the Hub');
  p.doc.querySelector('button[data-act=refresh]').click();
  await p.settle();
  assert.equal(p.doc.documentElement.getAttribute('data-hub-fetch'), 'idle', 'Refresh now is not left refreshing');
  assert.equal(p.doc.getElementById('msg').textContent, 'could not reach the Hub');
  x.done();
});

test('the star: one per post beside Read; a press stars it in place (no reload), says so, and counts; again removes it; a failure changes nothing', async () => {
  const x = await hub({ n: 3 });
  let answer = { ok: true, star: 'starred' };
  const p = await x.run({}, { reply: () => answer });
  const star = p.doc.querySelector('article.hub-entry button.star');
  assert.equal(star.getAttribute('aria-pressed'), 'false');
  assert.equal(star.getAttribute('aria-label'), 'Star: come back to it later');
  p.press(star);
  await p.settle();
  assert.deepEqual(p.calls[0], { url: '/following/read', body: { key: star.dataset.key, move: 'star' } });
  assert.equal(star.textContent, '\u2605 Starred');
  assert.equal(star.getAttribute('aria-label'), 'Starred: remove star');
  assert.equal(star.getAttribute('aria-pressed'), 'true');
  assert.equal(countOf(p.doc, 'starred'), 1);
  assert.equal(p.reloads(), 0);
  assert.equal(p.doc.querySelectorAll('article.hub-entry').length, 3, 'a star does not mark it read: the post stays');
  answer = { ok: false, error: 'at most 500 posts can be starred: remove a star first' };
  p.press(star);
  await p.settle();
  assert.equal(star.textContent, '\u2605 Starred', 'a failed request leaves it as stored');
  assert.match(p.doc.getElementById('msg').textContent, /at most 500/);
  answer = { ok: true, star: 'plain' };
  p.press(star);
  await p.settle();
  assert.equal(star.textContent, '\u2606 Star');
  assert.equal(countOf(p.doc, 'starred'), 0);
  x.done();
});

test('the Starred tab: newest starred first, light lines (no text), where each post is now, Open original and Remove star', async () => {
  const x = await hub({ n: 4 });
  const keys = await Promise.all([1, 2, 3].map(k => x.f.keyFor(A, idOf(k))));
  for (const k of keys) await x.f.readRequest({ key: k, move: 'star' });
  await x.f.readMove(keys[1], 'tick'); // read: it keeps its star
  const p = await x.run({ view: 'starred' });
  const lines = [...p.doc.querySelectorAll('.hub-starred-line')];
  assert.deepEqual(lines.map(l => l.dataset.key), [...keys].reverse(), 'newest starred first (same time: by key)');
  assert.ok(!/Distinctive words/.test(p.html), 'no text of any post');
  const byKey = k => lines.find(l => l.dataset.key === k).textContent.replace(/\s+/g, ' ');
  assert.match(byKey(keys[0]), /unread, in your Feed/);
  assert.match(byKey(keys[1]), /read, in the Archive/);
  assert.equal(countOf(p.doc, 'starred'), 3);
  const remove = lines[0].querySelector('button[data-act=unstar]');
  assert.equal(remove.textContent, 'Remove star');
  p.press(remove);
  await p.settle();
  assert.deepEqual(p.calls[0].body, { key: lines[0].dataset.key, move: 'unstar' });
  assert.equal(p.doc.querySelectorAll('.hub-starred-line').length, 2);
  assert.equal(countOf(p.doc, 'starred'), 2);
  const empty = await hub({ n: 1 });
  assert.match((await empty.run({ view: 'starred' })).html, /Nothing starred yet/);
  empty.done(); x.done();
});
