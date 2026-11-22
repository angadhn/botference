// following-view.test.mjs — the Following page escapes everything remote.
//
//   node --test test/following-view.test.mjs
//
// The records here are written BY HAND, as if an older or hand-edited store held
// them, so the page's own escaping is what is tested (the engine's cleaning
// has its own test in following.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { followingPage } from '../following-view.mjs';
import { followingSettingsOf, buildView } from '../following.mjs';

const HOSTILE = [
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "' onmouseover='alert(1)", 'javascript:alert(1)',
  '<a href="javascript:alert(1)">x</a>', 'evil\u202etxet', '\u2066iso\u2069', '</title><script>alert(2)</script>',
];
const rec = (n, text) => ({ key: `k${n}`, origin: `https://x${n}.web.test/`, id: 'i'.repeat(26), kind: n % 2 ? 'thread' : 'fragment', version: 3,
  created: '2026-11-01T00:00:00Z', updated: text, title: text, excerpt: text, author: text, read: 'new', identity: 'disagrees', identity_note: text,
  maintenance: 1, page: 'javascript:alert(1)', blyg_title: text, versions_note: '3 versions',
  in_response_to: { origin: 'javascript:alert(1)', id: '', label: text }, stub_of: null, refs: [], ref_origins: [] });

test('hostile titles, excerpts, authors, notes and labels are escaped; hrefs are only the page\'s own routes', () => {
  const entries = HOSTILE.map((h, n) => ({ head: rec(n, h), members: [rec(n + 50, h)] }));
  const data = { view: 'feed', filter: 'all', counts: { all: 8, new: 8, threads: 4, fragments: 4, responses: 0 }, run: { state: 'idle' }, schedule: { mode: 'scheduled' },
    tabs: { feed: 8, mentions: 0, mentions_unseen: 0, background: 0 }, background: [], mentions: [], inbox: { state: 'off', never_verified: [] },
    last_run: { at: HOSTILE[0], new: 1, edited: 0, requests: 3, deferred: 0 }, entries,
    blygs: [{ origin: HOSTILE[1], title: HOSTILE[0], state: 'unreachable', failures: 2, items: 1, last_error: HOSTILE[2] }] };
  const settings = { ...followingSettingsOf({}).settings, my_origins: [HOSTILE[1]] };
  const html = followingPage({ data, settings, refused: [HOSTILE[0]], notice: HOSTILE[7], nonce: 'N' });
  const body = html.replace(/<script nonce="N">[\s\S]*?<\/script>/, '[our script]');
  assert.ok(!/<script>alert/i.test(body) && !/<img\b/i.test(body) && !/<a href="javascript/i.test(body));
  assert.ok(!/<\/title><script/i.test(body));
  assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(html));
  assert.equal((html.match(/<script/g) || []).length, 1);
  for (const m of body.matchAll(/\s(?:href|src|action)="([^"]*)"/g)) assert.match(m[1], /^\/(hub|pages)/, m[1]);
  // no attribute value was broken out of: every tag's attributes parse as name="value" pairs only
  for (const tag of body.matchAll(/<(?:article|a|button|input|textarea)\b([^>]*)>/g)) {
    const rest = tag[1].replace(/\s[\w-]+(?:="[^"]*")?/g, '').replace(/\s*\/?$/, '');
    assert.equal(rest.trim(), '', `a tag's attributes are clean: <${tag[0].slice(1, 60)}`);
  }
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(body.includes('data-origin="&quot;&gt;&lt;img'), 'an origin with a quote in it stays inside its attribute');
});

test('a post is shown as an excerpt and a link: its text is not re-rendered', () => {
  const r = { ...rec(1, 'hi'), excerpt: 'short', text: 'THE WHOLE POST '.repeat(50) };
  const html = followingPage({ data: { view: 'feed', filter: 'all', counts: { all: 1, new: 1, threads: 1, fragments: 0, responses: 0 }, run: { state: 'idle' },
    tabs: { feed: 1, mentions: 0, mentions_unseen: 0, background: 0 }, background: [], mentions: [], inbox: { state: 'off', never_verified: [] },
    schedule: { mode: 'off' }, last_run: null, entries: [{ head: r, members: [] }], blygs: [] }, settings: followingSettingsOf({}).settings, nonce: 'N' });
  assert.ok(!html.includes('THE WHOLE POST'));
  assert.match(html, /data-act="open" data-key="k1"/);
  assert.ok(!/href="\/following\/open/.test(html), 'Open is a button that POSTs, not a link that changes state');
});

test('buildView: withdrawn posts are in Background, not the Feed, and a post of an unfollowed blyg is in neither', () => {
  const live = { ...rec(1, 'a'), origin: 'https://a.web.test/', id: 'a'.repeat(26) };
  const gone = { ...rec(2, 'b'), origin: 'https://a.web.test/', id: 'b'.repeat(26), kind: 'withdrawn' };
  const orphan = { ...rec(3, 'c'), origin: 'https://nobody.web.test/', id: 'c'.repeat(26) };
  const v = buildView({ items: [live, gone, orphan], blygs: { 'https://a.web.test/': { state: 'active' } } });
  assert.deepEqual(v.feed.entries.map(e => e.head.key), ['k1']);
  assert.deepEqual(v.background.map(b => [b.post.key, b.reason]), [['k2', 'withdrawn']]);
  assert.equal(v.tabs.background, 1);
});

test('the version history renders escaped: "v5 · 5 versions", "pinned: v1, v4", a pinned mark that is a button (never a remote link)', () => {
  const hostile = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', 'javascript:alert(1)'];
  const history = [5, 4, 3, 2, 1].map(n => ({ version: n, at: '2026-11-0' + n + 'T10:00:00Z', note: hostile[n % 3], pin: n === 1 || n === 4 ? 'pinned' : 'unpinned',
    mark: n === 4 ? 'link' : n === 1 ? 'plain' : '' }));
  const head = { ...rec(1, 'hi'), version: 5, versions_note: '5 versions', history, pinned_list: [1, 4], page: 'https://x.web.test/p/' };
  const html = followingPage({ data: { view: 'feed', filter: 'all', counts: { all: 1, new: 1, threads: 1, fragments: 0, responses: 0 }, run: { state: 'idle' },
    tabs: { feed: 1, mentions: 0, mentions_unseen: 0, background: 0 }, background: [], mentions: [], inbox: { state: 'off', never_verified: [] },
    schedule: { mode: 'off' }, last_run: null, entries: [{ head, members: [] }], blygs: [] }, settings: followingSettingsOf({}).settings, nonce: 'N' });
  const body = html.replace(/<script nonce="N">[\s\S]*?<\/script>/, '[our script]');
  assert.match(body, /v5 · 5 versions/);
  assert.match(body, /pinned: v1, v4/);
  assert.match(body, /<details><summary[^>]*>history<\/summary><ul class="history">/);
  assert.equal((body.match(/data-act="open-pin"/g) || []).length, 1, 'only the pin whose page can be told is a button');
  assert.match(body, /data-act="open-pin" data-key="k1" data-version="4"/);
  assert.equal((body.match(/<span class="badge">pinned<\/span>/g) || []).length, 1, 'the other is a plain mark');
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && body.includes('&quot;&gt;&lt;img'));
  assert.ok(!/<script>alert|<img\b/i.test(body));
  assert.ok(!/<[^>]*\son(error|load)\s*=/i.test(body));
  for (const m of body.matchAll(/\s(?:href|src|action)="([^"]*)"/g)) assert.match(m[1], /^\/(hub|pages)/, m[1]);
  assert.ok(!body.includes('x.web.test/p/'), 'the post\'s own address is not in the page');
  // one version only: no history to show
  const one = followingPage({ data: { view: 'feed', filter: 'all', counts: { all: 1, new: 1, threads: 1, fragments: 0, responses: 0 }, run: { state: 'idle' },
    tabs: { feed: 1, mentions: 0, mentions_unseen: 0, background: 0 }, background: [], mentions: [], inbox: { state: 'off', never_verified: [] },
    schedule: { mode: 'off' }, last_run: null, entries: [{ head: { ...rec(2, 'hi'), version: 1, versions_note: '', history: [history[4]], pinned_list: [] }, members: [] }], blygs: [] },
    settings: followingSettingsOf({}).settings, nonce: 'N' });
  assert.ok(!/history<\/summary>/.test(one));
});
