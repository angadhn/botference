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
import { followingSettingsOf, listFor } from '../following.mjs';

const HOSTILE = [
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "' onmouseover='alert(1)", 'javascript:alert(1)',
  '<a href="javascript:alert(1)">x</a>', 'evil‮txet', '⁦iso⁩', '</title><script>alert(2)</script>',
];
const rec = (n, text) => ({ key: `k${n}`, origin: `https://x${n}.web.test/`, id: 'i'.repeat(26), kind: n % 2 ? 'thread' : 'fragment', version: 3,
  created: '2026-11-01T00:00:00Z', updated: text, title: text, excerpt: text, author: text, read: 'new', identity: 'disagrees', identity_note: text,
  maintenance: 1, page: 'javascript:alert(1)', blyg_title: text, versions_note: '3 versions',
  in_response_to: { origin: 'javascript:alert(1)', id: '', label: text }, stub_of: null, refs: [], ref_origins: [] });

test('hostile titles, excerpts, authors, notes and labels are escaped; hrefs are only the page\'s own routes', () => {
  const entries = HOSTILE.map((h, n) => ({ head: rec(n, h), members: [rec(n + 50, h)] }));
  const data = { filter: 'all', counts: { all: 8, new: 8, threads: 4, fragments: 4, responses: 0 }, run: { state: 'idle' }, schedule: { mode: 'scheduled' },
    last_run: { at: HOSTILE[0], new: 1, edited: 0, requests: 3, deferred: 0 }, entries,
    blygs: [{ origin: HOSTILE[1], title: HOSTILE[0], state: 'unreachable', failures: 2, items: 1, last_error: HOSTILE[2] }] };
  const settings = { ...followingSettingsOf({}).settings, my_origins: [HOSTILE[1]] };
  const html = followingPage({ data, settings, refused: [HOSTILE[0]], notice: HOSTILE[7] });
  const body = html.replace(/<script>[\s\S]*?<\/script>/, '[our script]');
  assert.ok(!/<script>alert/i.test(body) && !/<img\b/i.test(body) && !/<a href="javascript/i.test(body));
  assert.ok(!/<\/title><script/i.test(body));
  assert.ok(!/[‪-‮⁦-⁩]/.test(html));
  assert.equal((html.match(/<script>/g) || []).length, 1);
  for (const m of body.matchAll(/\s(?:href|src|action)="([^"]*)"/g)) assert.match(m[1], /^\/(following|pages)/, m[1]);
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
  const html = followingPage({ data: { filter: 'all', counts: { all: 1, new: 1, threads: 1, fragments: 0, responses: 0 }, run: { state: 'idle' },
    schedule: { mode: 'off' }, last_run: null, entries: [{ head: r, members: [] }], blygs: [] }, settings: followingSettingsOf({}).settings });
  assert.ok(!html.includes('THE WHOLE POST'));
  assert.match(html, /href="\/following\/open\?key=k1"/);
});

test('listFor leaves withdrawn posts out of every filter', () => {
  const live = { ...rec(1, 'a'), withdrawn: false }, gone = { ...rec(2, 'b'), withdrawn: true };
  for (const f of ['all', 'new', 'threads', 'fragments']) {
    assert.ok(!listFor([live, gone], f).entries.some(e => e.head.key === 'k2'), f);
  }
});
