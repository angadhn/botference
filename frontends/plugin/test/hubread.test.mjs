// hubread.test.mjs — "Read here": a followed post as an annotatable page (hubread.mjs, following.mjs fetchPost / bodies).
//
//   node --test test/hubread.test.mjs
//
// No network: a fake `get` over an invented blyg (test/following-fake.mjs). The page store is a throwaway root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubread-'));
const store = await import('../store.mjs');
const blyg = await import('../blyg.mjs');
const F = await import('../following.mjs');
const { holdPost, hubInfoOf } = await import('../hubread.mjs');
const { articleView } = await import('../views.mjs');
const { followingPage } = await import('../following-view.mjs');
const { sanitizeArticle } = await import('../sanitize.mjs');
const { makeWeb, makeDoc, idOf } = await import('./following-fake.mjs');
const CFG = (await import('node:module')).createRequire(import.meta.url)('../extension/config.js');

const A = 'https://alpha.web.test/notes/';
const HOSTILE = fs.readFileSync(path.join(HERE, 'fixtures', 'following', 'hostile-post.html'), 'utf8');
const SETTINGS = (over = {}) => CFG.followingSettingsOf(over).settings;

function rig({ settings = {}, mayFetch = () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubread-state-'));
  const web = makeWeb();
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const f = F.createFollowing({ file: path.join(dir, 'following.json'), get: web.get, now: () => clock.t, mayFetch,
    getSettings: () => SETTINGS(settings), timers: { set: () => 1, clear: () => {} } });
  return { f, web, dir, clock, file: path.join(dir, 'following.json'), bodies: path.join(dir, 'following-bodies'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const doc = (id, over = {}) => { const d = makeDoc({ id, origin: A, ...over }); return d; };
function putHostile(site, id, over = {}) {
  const d = doc(id, over);
  d.content_html = HOSTILE;
  return site.put(d);
}
const view = h => articleView({ page: store.readPage(h.page.url), key: h.key, me: { handle: 'owner', owner: true }, snapshot: store.readSnapshot(h.key), info: null, nonce: 'N',
  hub: hubInfoOf(store.readPage(h.page.url), {}) });
const seeded = async (r, id, over = {}) => {
  const site = r.web.sites.get(A) || r.web.add(A, { title: 'Alpha Notes', author: 'Alpha Author' });
  site.put(doc(id, over));
  r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  return r.f.keyFor(A, id);
};

test('hostile content_html is neutralised in the article view (and in the Feed): every dangerous tag, attribute and scheme', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const id = idOf(1);
  putHostile(site, id);
  r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  const key = r.f.keyFor(A, id);
  const post = await r.f.fetchPost(key);
  const held = holdPost({ store, applyAnswer: blyg.applyAnswer, post });
  const html = view(held);
  const art = /<article id="bfp-article">([\s\S]*?)<\/article>/.exec(html)[1];
  for (const bad of [/<script/i, /<iframe/i, /<form/i, /<input/i, /<button/i, /<meta/i, /<base/i, /<svg/i, /<math/i, /<object/i, /<embed/i, /<link/i, /<style(?! nonce)/i,
    /\son\w+\s*=/i, /\sstyle\s*=/i, /srcset/i, /javascript:/i, /data:text/i, /vbscript:/i, /evil\.example/i, /http:\/\/img\.example/i, /data:image/i]) {
    assert.ok(!bad.test(art), `the article body has no ${bad}`);
  }
  assert.match(art, /Honest words before the trouble/);
  assert.match(art, /Honest words after the trouble/);
  assert.match(art, /<blockquote>/);
  for (const a of art.match(/<a [^>]*>/g)) assert.match(a, /rel="noreferrer noopener" target="_blank"/, a);
  assert.ok(!/<a [^>]*href="javascript/.test(art));
  assert.match(art, /<a href="https:\/\/ok\.example\.test\/page" rel="noreferrer noopener" target="_blank">/, 'an https link keeps only href, rel and target _blank');
  assert.match(art, /<a href="mailto:someone@example\.test"/, 'mailto is allowed');
  const imgs = art.match(/<img [^>]*>/g) || [];
  assert.equal(imgs.length, 1, 'only the https image is kept');
  assert.match(imgs[0], /^<img src="https:\/\/img\.example\.test\/a\.png" alt="ok" loading="lazy" decoding="async" referrerpolicy="no-referrer">$/);
  // the same body in the Feed
  r.f.refresh();
  const feed = followingPage({ data: r.f.view(), settings: SETTINGS(), nonce: 'N' });
  const entry = feed.split('<div class="hub-entry-body"')[1] || '';
  assert.match(entry, /Honest words before/);
  for (const bad of [/<script(?! nonce)/i, /\son\w+\s*=/i, /\sstyle\s*=/i, /javascript:/i, /<iframe/i, /<form/i, /srcset/i]) assert.ok(!bad.test(entry.split('</article>')[0]), `the Feed body has no ${bad}`);
  r.done();
});

test('the sanitiser: bidirectional overrides and control characters are never kept; https images only, lazy; mailto links; the cap', () => {
  const O = String.fromCharCode(0x202e), I = String.fromCharCode(0x2066), C = String.fromCharCode(1);
  const out = sanitizeArticle(`<p title="a${O}b">x${O}y${I}z${C}w</p>`).html;
  assert.equal(out, '<p>xyzw</p>');
  assert.equal(sanitizeArticle('<img src="http://i.test/a.png">').html, '');
  assert.equal(sanitizeArticle('<img src="https://i.test/a.png">').html, '<img src="https://i.test/a.png" loading="lazy" decoding="async" referrerpolicy="no-referrer">');
  assert.equal(sanitizeArticle('<a href="mailto:a@b.test">m</a>').html, '<a href="mailto:a@b.test" rel="noreferrer noopener" target="_blank">m</a>');
  assert.equal(sanitizeArticle('<a href="javascript:alert(1)">m</a>').html, '<a rel="noreferrer noopener" target="_blank">m</a>');
  const big = sanitizeArticle('<p>' + 'word '.repeat(20000) + '</p><p>tail</p>', { max: 1000, truncate: true });
  assert.ok(big.tooBig && big.html.length < 1100 && big.html.endsWith('</p>'), 'truncated, and still well formed');
  assert.ok(sanitizeArticle('<p>' + 'word '.repeat(20000) + '</p>', { max: 1000 }).tooBig);
});

test('the identity on the page record is the item document\'s, named item-document; the Hub and the extension address the same record', async () => {
  const r = rig();
  const id = idOf(2);
  const key = await seeded(r, id, { kind: 'thread', title: 'Doc title', version: 2, updated: '2026-11-02T10:00:00Z',
    changelog: [{ version: 1, at: 'a', note: 'x', pinned: true }, { version: 2, at: 'b', note: 'y' }], transclusions: [] });
  const post = await r.f.fetchPost(key);
  assert.deepEqual(F.ANSWER_SOURCES, ['detected', 'from-list', 'item-document']);
  assert.equal(post.result.source, 'item-document');
  const held = holdPost({ store, applyAnswer: blyg.applyAnswer, post });
  const rec = store.readPage(`${A}t/${id}/`);
  assert.equal(store.pageKey(rec.url), store.pageKey(post.page_url), 'the post\'s canonical page, normalised the one way the store does');
  assert.deepEqual([rec.blyg.status, rec.blyg.source, rec.blyg.item.origin, rec.blyg.item.id, rec.blyg.item.version], ['blyg', 'item-document', A, id, 2]);
  assert.equal(blyg.versionStateOf(rec.blyg.item), 'current-unpinned');
  assert.equal(rec.hub.text_from, 'item-document');
  // the extension on the original page: the same URL (a tracking query, a fragment, a trailing slash) is the same record
  for (const variant of [`${A}t/${id}/`, `${A}t/${id}`, `${A}t/${id}/?utm_source=x#frag`]) {
    const again = store.upsertPage({ url: variant, title: 'whatever the site calls it' });
    assert.equal(store.pageKey(again.url), held.key, variant);
    assert.equal(again.hub.version, 2, 'and it is the record the Hub made');
  }
  // a highlight made on the original page appears in the Hub's page, and the reverse
  const page = store.readPage(`${A}t/${id}/`);
  store.addThread(page, { quote: 'Some invented words', text: 'from the extension', author: 'owner' });
  store.savePage(page);
  const shown = JSON.parse(/<script type="application\/json" id="bfp-data" nonce="N">([\s\S]*?)<\/script>/.exec(view(held))[1]);
  assert.equal(shown.threads.length, 1);
  assert.equal(shown.threads[0].quote, 'Some invented words');
  r.done();
});

test('Read here marks the post opened; exporting a note marks THE SAME post responded (the record the Hub made)', async () => {
  const r = rig();
  const id = idOf(3);
  const key = await seeded(r, id);
  assert.equal(r.f.itemByKey(key).read, 'new');
  await r.f.fetchPost(key);
  assert.equal(r.f.openedHere(key), 'opened');
  const post = await r.f.fetchPost(key);
  const held = holdPost({ store, applyAnswer: blyg.applyAnswer, post });
  const item = store.readPage(held.page.url).blyg.item;
  assert.equal(r.f.markResponded(item.origin, item.id), true, 'what the export calls');
  assert.equal(r.f.itemByKey(key).read, 'responded');
  assert.equal(r.f.openedHere(key), 'responded', 'reading again never takes a response back');
  r.done();
});

test('a newer version: the page says so, loading keeps highlights whose quotes still match and orphans the rest; nothing is swapped silently', async () => {
  const r = rig();
  const id = idOf(4);
  const body = n => `<p>The first paragraph stays exactly as it was.</p><p>${n}</p><p>The last paragraph also stays.</p>`;
  const site = r.web.add(A, { title: 'Alpha Notes' });
  site.put(Object.assign(doc(id, { version: 1 }), { content_html: body('A middle sentence that will be rewritten.') }));
  r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  const key = r.f.keyFor(A, id);
  const held = holdPost({ store, applyAnswer: blyg.applyAnswer, post: await r.f.fetchPost(key) });
  const page = store.readPage(held.page.url);
  for (const q of ['first paragraph stays exactly', 'middle sentence that will be rewritten', 'last paragraph also']) {
    store.addThread(page, { quote: q, prefix: '', suffix: '', text: 'note on ' + q, author: 'owner' });
  }
  store.savePage(page);
  assert.equal(hubInfoOf(store.readPage(held.page.url), { following: r.f }).newer, null, 'no newer version yet');
  // the blyg publishes version 2 and the Hub's refresh sees it
  const d2 = Object.assign(doc(id, { version: 2, updated: '2026-11-12T10:00:00Z', body: 'x' }), { content_html: body('A completely different middle.') });
  d2.content_md = 'a different md'; d2.content_hash = (await import('node:crypto')).createHash('sha256').update(d2.content_md).digest('hex').replace(/^/, 'sha256:');
  site.put(d2);
  r.clock.t += 3600e3;
  await r.f.refresh();
  const info = hubInfoOf(store.readPage(held.page.url), { following: r.f });
  assert.deepEqual([info.newer.version, info.version], [2, 1], 'the page says a newer version (v2) exists');
  assert.match(info.newer.key, /^[0-9a-f]{24}$/);
  const before = store.readSnapshot(held.key);
  assert.match(before, /A middle sentence that will be rewritten/, 'the text under the highlights has NOT changed');
  assert.ok(store.readPage(held.page.url).threads.every(t => !t.orphaned));
  // asking to read again without `replace` changes nothing
  const kept = holdPost({ store, applyAnswer: blyg.applyAnswer, post: await r.f.fetchPost(key) });
  assert.equal(kept.kept, true);
  assert.equal(store.readSnapshot(held.key), before);
  // loading it, explicitly
  const loaded = holdPost({ store, applyAnswer: blyg.applyAnswer, post: await r.f.fetchPost(key), replace: true });
  assert.equal(loaded.orphaned, 1);
  const after = store.readPage(held.page.url);
  assert.match(store.readSnapshot(held.key), /completely different middle/);
  assert.deepEqual(Object.fromEntries(after.threads.map(t => [t.quote.slice(0, 12), !!t.orphaned])), { 'first paragr': false, 'middle sente': true, 'last paragra': false });
  assert.equal(after.hub.version, 2);
  assert.equal(after.blyg.item.version, 2);
  assert.equal(hubInfoOf(after, { following: r.f }).newer, null);
  // an extension capture with highlights is kept unless the reader asks
  const url2 = 'https://alpha.web.test/notes/f/captured/';
  const cap = store.upsertPage({ url: url2, title: 'captured' });
  store.saveSnapshot(url2, '<p>Captured words of the original page.</p>');
  store.addThread(cap, { quote: 'Captured words', prefix: '', suffix: '', text: 'mine', author: 'owner' });
  store.savePage(cap);
  const kept2 = holdPost({ store, applyAnswer: blyg.applyAnswer, post: { ...(await r.f.fetchPost(key)), page_url: url2 } });
  assert.equal(kept2.text_from, 'captured');
  assert.match(store.readSnapshot(store.pageKey(url2)), /Captured words/, 'never swapped under existing highlights');
  assert.match(hubInfoOf(store.readPage(url2), {}).source_note, /captured/);
  r.done();
});

test('fetches stay origin-scoped and counted; fetching off fetches nothing', async () => {
  const r = rig();
  const key = await seeded(r, idOf(5));
  r.web.requests.length = 0;
  await r.f.fetchPost(key);
  assert.deepEqual(r.web.requests, [`${A}items/${idOf(5)}.json`], 'one request, to the blyg\'s own item address');
  // a manifest whose item template points elsewhere (after the post is held): refused, and nothing outside is asked
  const orig = r.web.get;
  let mode = 'normal';
  const f2 = F.createFollowing({ file: path.join(r.dir, 'f2.json'), getSettings: () => SETTINGS(), timers: { set: () => 1, clear: () => {} },
    get: async (u, o) => {
      if (u === `${A}blyg.json` && mode === 'template') return { status: 200, url: u, text: JSON.stringify({ blyg: '0.4', title: 't', item: 'https://third.web.test/{id}.json' }) };
      const x = await orig(u, o);
      return mode === 'redirect' && /items\/0/.test(u) && !/index/.test(u) ? { ...x, url: 'https://third.web.test/x.json' } : x;
    } });
  f2.confirmImport([{ origin: A }]);
  await f2.refresh();
  const k2 = f2.keyFor(A, idOf(5));
  assert.ok(k2, 'the post is held');
  mode = 'template';
  await f2.refresh();
  const third = r.web.requests.length;
  await assert.rejects(() => f2.fetchPost(k2), /outside the blyg's own origin/);
  assert.equal(r.web.requests.length, third, 'nothing outside the origin was asked');
  // served from somewhere else after a redirect
  mode = 'normal';
  await f2.refresh();
  assert.equal((await f2.fetchPost(k2)).meta.id, idOf(5), 'back to normal: fine');
  mode = 'redirect';
  await assert.rejects(() => f2.fetchPost(k2), /served from outside/);
  // fetching off
  let on = true;
  const g = rig({ mayFetch: () => on });
  const gk = await seeded(g, idOf(6));
  on = false;
  g.web.requests.length = 0;
  await assert.rejects(() => g.f.fetchPost(gk), /fetching is off/);
  assert.equal(g.web.requests.length, 0);
  r.done(); g.done();
});

test('every post\'s text is kept in a file of its own beside the list; capped, truncated, swept with its post', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const [short, long, gone] = [1, 2, 3].map(idOf);
  site.put(doc(short, { body: 'a short fragment' }));
  const big = doc(long, { kind: 'thread', transclusions: [] });
  big.content_html = '<p>' + 'word '.repeat(12000) + '</p><p>second block</p>';
  site.put(big);
  site.put(doc(gone, { body: 'soon gone' }));
  r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  const files = fs.readdirSync(r.bodies);
  assert.equal(files.length, 3);
  const state = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.ok(!JSON.stringify(state).includes('second block'), 'the text is not in following.json (only a clipped excerpt is)');
  assert.ok(fs.statSync(r.file).size < 20000, 'following.json holds records, not text');
  const sizes = files.map(f => fs.statSync(path.join(r.bodies, f)).size);
  assert.ok(Math.max(...sizes) <= F.LIMITS.bodyBytes + 200, `no body over the cap (${Math.max(...sizes)})`);
  const items = Object.fromEntries(Object.values(state.items).map(i => [i.id, i]));
  assert.deepEqual([items[short].body_state, items[long].body_state], ['whole', 'truncated']);
  assert.deepEqual(F.BODY_STATES, ['whole', 'truncated', 'none']);
  assert.match(fs.readFileSync(path.join(r.bodies, `${items[short].key}.html`), 'utf8'), /a short fragment/);
  assert.ok(fs.readFileSync(path.join(r.bodies, `${items[long].key}.html`), 'utf8').endsWith('</p>'), 'a truncated body is still well formed');
  // withdrawn: its file goes
  const w = doc(gone, { kind: 'withdrawn', title: '', version: 2, updated: '2026-11-09T10:00:00Z' });
  site.put(w);
  await r.f.refresh();
  assert.equal(fs.readdirSync(r.bodies).length, 2);
  // removed from the index: its file goes
  site.drop(short);
  await r.f.refresh();
  assert.equal(fs.readdirSync(r.bodies).length, 1);
  // unfollow: all gone
  r.f.unfollow(A);
  assert.equal(fs.readdirSync(r.bodies).length, 0);
  // a hand-edited body is sanitised again on the way out
  r.f.confirmImport([{ origin: A }]);
  site.put(doc(short, { body: 'back again' }));
  await r.f.refresh();
  const k = r.f.keyFor(A, short);
  fs.writeFileSync(path.join(r.bodies, `${k}.html`), '<p>ok</p><script>alert(1)</script><p onclick="x()">fine</p>');
  assert.equal(r.f.bodyHtml(k), '<p>ok</p><p>fine</p>');
  r.done();
});

test('the Feed shows each post in place: full when short, clipped at a block boundary when long (the setting), "Read here for the rest" when truncated', async () => {
  const r = rig({ settings: { following_feed_clip_words: 50 } });
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const [frag, thr, huge] = [1, 2, 3].map(idOf);
  const para = n => `<p>${'word '.repeat(n).trim()}.</p>`;
  const f1 = doc(frag, { kind: 'fragment' }); f1.content_html = para(100) + para(100); site.put(f1);
  const t1 = doc(thr, { kind: 'thread', transclusions: [], created: '2026-11-02T10:00:00Z' });
  t1.content_html = `${para(30)}<blockquote>${para(30)}</blockquote>${para(30)}${para(30)}`; site.put(t1);
  const h1 = doc(huge, { kind: 'thread', transclusions: [], created: '2026-11-03T10:00:00Z' });
  h1.content_html = para(9000) + '<p>end</p>'; site.put(h1);
  r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  const v = r.f.view();
  const by = Object.fromEntries(v.entries.map(e => [e.head.id, e.head]));
  assert.equal(by[frag].body_rest, '', 'a fragment (200 words, over the clip, in two paragraphs) is always shown in full');
  assert.ok(by[frag].body_head.length > 900);
  assert.match(by[thr].body_head, /^<p>[^<]*<\/p><blockquote>/, 'the clip falls at a block boundary: here after the quote, never inside it');
  assert.ok(by[thr].body_head.includes('</blockquote>') && by[thr].body_rest.startsWith('<p>'));
  assert.equal(by[huge].body_state, 'truncated');
  const html = followingPage({ data: v, settings: SETTINGS({ following_feed_clip_words: 50 }), nonce: 'N' });
  assert.match(html, /<div class="rest" hidden>/);
  assert.match(html, /data-act="more">more</);
  assert.match(html, /data-act="read" data-key="[0-9a-f]{24}">Read here for the rest</);
  assert.match(html, /class="hub-quote"/);
  assert.equal(CFG.followingSettingsOf({ following_feed_clip_words: 10 }).refused[0], 'following_feed_clip_words');
  assert.equal(CFG.followingSettingsOf({}).settings.following_feed_clip_words, 300);
  r.done();
});

test('excerpts are plain text: markdown links, images, emphasis, headings, directives and quote markers are gone (when kept and when shown)', async () => {
  const md = '## Heading\n> a quote with **bold** and _it_ and [a link](https://x.test/a?b=1) ![alt](https://x.test/i.png)\n![[abcdefghjkmnpqrstvwxyz0123]]\nsnake_case stays [[abcdefghjkmnpqrstvwxyz0123|named]]';
  assert.equal(F.cleanText(F.plainText(md.split('\n').join(' ')), 300).includes('http'), false);
  const lines = md.split('\n').map(l => F.cleanText(F.plainText(l), 300)).filter(Boolean).join(' ');
  assert.equal(lines, 'Heading a quote with bold and it and a link snake_case stays named');
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const id = idOf(1);
  const d = doc(id, { title: '' });
  d.content_html = '<p>See [the post](https://x.test/p) and **this** ![[abcdefghjkmnpqrstvwxyz0123]]</p>';
  site.put(d);
  r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  assert.equal(r.f.view().entries[0].head.excerpt, 'See the post and this', 'cleaned when kept');
  // a record stored before the cleaning existed is cleaned when shown
  const raw = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  for (const i of Object.values(raw.items)) i.excerpt = '> [old](https://x.test/o) **stored** text';
  fs.writeFileSync(r.file, JSON.stringify(raw));
  const again = F.createFollowing({ file: r.file, getSettings: () => SETTINGS(), timers: { set: () => 1, clear: () => {} } });
  assert.equal(again.view().entries[0].head.excerpt, 'old stored text', 'and cleaned when shown');
  r.done();
});

test('dates: "Nov 22, 2026" or "22 Nov 2026" by the viewer\'s locale, with the time where asked; stored values untouched; reading time', async () => {
  assert.equal(F.formatDate('2026-11-22T09:45:00', 'en-GB', true), '22 Nov 2026, 09:45');
  assert.equal(F.formatDate('2026-11-22T09:45:00', 'en-GB'), '22 Nov 2026');
  assert.equal(F.formatDate('2026-11-20T10:00:00', 'en-US'), 'Nov 20, 2026');
  assert.equal(F.formatDate('not a date', 'en-GB'), '');
  assert.equal(F.localeOf('en-GB,en;q=0.9'), 'en-GB');
  assert.equal(F.localeOf('xx-<script>'), 'en-US');
  assert.equal(F.localeOf(undefined), 'en-US');
  assert.equal(F.readingLabel(100), '< 1 min');
  assert.equal(F.readingLabel(440), '2 min');
  const r = rig();
  const key = await seeded(r, idOf(1), { created: '2026-11-05T10:00:00Z', updated: '2026-11-05T10:00:00Z' });
  const view = r.f.view();
  const gb = followingPage({ data: view, settings: SETTINGS(), nonce: 'N', locale: 'en-GB' });
  const us = followingPage({ data: view, settings: SETTINGS(), nonce: 'N', locale: 'en-US' });
  assert.match(gb, /5 Nov 2026/);
  assert.match(us, /Nov 5, 2026/);
  assert.equal(r.f.itemByKey(key).updated, '2026-11-05T10:00:00Z', 'the stored value is not changed');
  assert.match(gb, /Last refresh 10 Nov 2026, \d\d:\d\d/);
  r.done();
});

test('"in response to" shows the target\'s title when it is a followed post held here, else the host', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const [target, reply, stray] = [1, 2, 3].map(idOf);
  site.put(doc(target, { title: 'The target post' }));
  site.put(doc(reply, { kind: 'thread', stub_of: { origin: A, id: target }, transclusions: [], created: '2026-11-02T10:00:00Z' }));
  site.put(doc(stray, { kind: 'thread', stub_of: { origin: 'https://elsewhere.web.test/blyg/', id: idOf(77) }, transclusions: [], created: '2026-11-03T10:00:00Z' }));
  r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  const by = Object.fromEntries(r.f.view().entries.map(e => [e.head.id, e.head]));
  assert.equal(by[reply].in_response_to.label, 'The target post');
  assert.equal(by[stray].in_response_to.label, 'elsewhere.web.test');
  r.done();
});

test('the Feed entry reads like the reference: meta line, version lines, title link, body in place, address, actions, search', async () => {
  const r = rig();
  const site = r.web.add(A, { title: 'Alpha Notes' });
  const id = idOf(1);
  const log = [1, 2, 3, 4, 5].map(n => ({ version: n, at: `2026-11-0${n}T10:00:00Z`, note: n === 3 ? `<script>x</script>${String.fromCharCode(0x202e)}hostile` : n === 2 ? null : `note ${n}`, pinned: n === 1 }));
  site.put(doc(id, { kind: 'thread', title: 'A <b>title</b>', version: 5, updated: '2026-11-05T10:00:00Z', changelog: log, transclusions: [], body: 'Body words here.' }));
  r.f.confirmImport([{ origin: A }]);
  await r.f.refresh();
  const mine = [A];
  const data = r.f.view({ mine });
  const html = followingPage({ data, settings: SETTINGS({ my_origins: mine }), nonce: 'N', locale: 'en-US' });
  const body = html.replace(/<script nonce="N">[\s\S]*?<\/script>/, '[ours]');
  assert.match(body, /<span class="dot" title="unread">/);
  assert.match(body, /<span class="kind">thread<\/span><strong>you<\/strong>/, 'a blyg of my_origins is "you"');
  assert.match(body, /Nov 5, 2026<\/span><span>&lt; 1 min<\/span>/);
  assert.match(body, /V5 Nov 5, 2026: note 5/);
  assert.match(body, /V4 Nov 4, 2026: note 4/);
  assert.match(body, /V3 Nov 3, 2026: &lt;script&gt;x&lt;\/script&gt;hostile/, 'a hostile note is escaped');
  const [recent, earlier] = body.split('and 2 earlier, in history');
  assert.ok(earlier, 'the older versions are behind "and 2 earlier, in history"');
  assert.ok(!/<div>V2 /.test(recent) && /<div>V2 Nov 2, 2026: <span class="mut">no note<\/span><\/div>/.test(earlier), 'only the three most recent versions are lines; an empty note says so');
  assert.match(earlier, /<div>V1 Nov 1, 2026: note 1 <button type="button" class="badge" data-act="open-pin"[^>]*>pinned<\/button><\/div>/);
  assert.match(body, /<div class="title hub-entry-title"><a href="#e-[0-9a-f]{24}" data-act="read"/);
  assert.match(body, /<div class="hub-entry-body" data-blyg-page="https:\/\/alpha\.web\.test\/notes\/t\/[^"]+" data-blyg-origin="https:\/\/alpha\.web\.test\/notes\/" data-blyg-id="[^"]+" data-blyg-version="5">/);
  assert.match(body, /<span class="addr" title="https:\/\/alpha\.web\.test\/notes\/t\/[^"]+">alpha\.web\.test\/notes\/t\/[^<]+<\/span>/);
  assert.match(body, /class="acts right hub-entry-actions"><button type="button" data-act="respond"[^>]*>Respond<\/button><button type="button" data-act="read"[^>]*>Read here<\/button><button type="button" data-act="open"[^>]*>Open original<\/button><details class="menu">/);
  assert.match(body, /data-act="see"[^>]*>Mark seen/);
  assert.match(body, /<input type="search" id="hub-search" placeholder="search every word"/);
  assert.ok(!/[\u202a-\u202e]/.test(html));
  // the search is plain substring, case-insensitive, over the loaded page, in the page's script (no new fetch)
  const script = /<script nonce="N">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.match(script, /toLowerCase\(\)\.indexOf\(q\)<0/);
  assert.ok(!/fetch\([^)]*search/.test(script));
  r.done();
});

test('no token or secret reaches the article view or the Feed', async () => {
  const TOKEN = 'tok_INVENTED_read_here_0123456789';
  const r = rig({ settings: { inbox_api_url: 'https://inbox.web.test/api', inbox_token_file: '/nonexistent/token' } });
  const key = await seeded(r, idOf(1));
  const held = holdPost({ store, applyAnswer: blyg.applyAnswer, post: await r.f.fetchPost(key) });
  const all = view(held) + followingPage({ data: r.f.view(), settings: SETTINGS(), nonce: 'N' }) + JSON.stringify(store.readPage(held.page.url)) + fs.readFileSync(r.file, 'utf8');
  assert.ok(!all.includes(TOKEN));
  assert.ok(!/authorization|bearer/i.test(view(held)));
  r.done();
});
