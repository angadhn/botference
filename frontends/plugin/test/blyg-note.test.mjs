// blyg-note.test.mjs — the short post as text: what it says, and that a hostile page cannot say anything else in it.
//
//   node --test test/blyg-note.test.mjs
//
// Front matter is checked by a REAL YAML parser (Ruby's Psych, when ruby is on the PATH) so "it round-trips" is a fact
// and not our opinion; the rest is the text itself. No network, no clock but the one handed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as N from '../blyg-note.mjs';

const hasRuby = (() => { try { execFileSync('ruby', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const yamlOf = text => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'the note opens with front matter');
  return JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-rdate', '-e',
    'puts JSON.generate(YAML.safe_load(ARGF.read, permitted_classes: [Date, Time]), quirks_mode: true)'], { input: m[1], encoding: 'utf8' }));
};
const rb = hasRuby ? test : test.skip;

const NOW = new Date('2026-11-23T12:00:00Z');
const ID = '0123456789abcdefghjkmnpqrs';
const ORIGIN = 'https://blyg.example.test/notes/';
const POST = `${ORIGIN}t/${ID}/`;
const PASSAGE = 'A sentence that the post really says.';
const mine = (text, extra = {}) => ({ author: 'owner', ts: '2026-11-22T10:00:00Z', text, provenance: 'owner-typed', ...extra });
const thread = (id, quote, text, extra = {}) => ({ id, quote, msgs: [mine(text)], ...extra });
const stamp = (extra = {}) => ({ status: 'blyg', id: ID, version: 2, origin: ORIGIN, page: POST, passage: { match: true }, ...extra });
const blygPage = (threads, extra = {}) => ({ url: POST, title: 'A made-up post', blyg: { status: 'blyg', item: { origin: ORIGIN, id: ID, version: 2, page: POST } }, threads, ...extra });
const webPage = (threads, extra = {}) => ({ url: 'https://news.example.test/a/story?id=7', title: 'A story', threads, ...extra });
const HOME = { template: N.DEFAULT_TEMPLATE, escape: 'liquid', timezone: 'Europe/London' };
const make = (page, threads, extra = {}) => N.renderShortNote({ page, threads, home: HOME, now: NOW, slug: 'on-liveness', ...extra });

test('a Blygger page: the quote by reference, the response, the sources, today as released, no essays tag', () => {
  const page = blygPage([thread('t1', PASSAGE, 'I agree, and the smoothness is the point.', { blyg: stamp() })]);
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  assert.equal(r.text, `---
created: 2026-11-23
released: "2026-11-23"
blyg: true
permalink: /b/on-liveness
blyg_sources:
  - "${POST}"
blyg_stub_of:
  origin: "${ORIGIN}"
  id: ${ID}
  version: 2
---
![[${ID} | A made-up post]]
> A sentence that the post really says.

I agree, and the smoothness is the point.
`);
  assert.ok(!/essays/.test(r.text));
  assert.equal(r.permalink, '/b/on-liveness');
});

test('an ordinary page: the plain web quote whose last paragraph is the bare URL; no stub unless the owner said response', () => {
  const page = webPage([thread('t1', 'Hiring is slowing for junior roles.', 'This matches what I see.')]);
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  assert.match(r.text, /\n---\n> Hiring is slowing for junior roles\.\n>\n> https:\/\/news\.example\.test\/a\/story\?id=7\n\nThis matches what I see\.\n$/);
  assert.ok(!/blyg_stub_of|blyg_sources/.test(r.text));
  const resp = make({ ...page, export_response: 'response' }, page.threads);
  assert.match(resp.text, /blyg_stub_of:\n {2}url: "https:\/\/news\.example\.test\/a\/story\?id=7"\n---/);
});

rb('front matter round-trips through a real YAML parser, for both kinds of page', () => {
  const a = make(blygPage([thread('t1', PASSAGE, 'Hello there: a "quoted" # thing', { blyg: stamp() })]), null);
  assert.equal(a.ok, false); // (threads null) refused, not thrown
  const pg = blygPage([thread('t1', PASSAGE, 'Hello there: a "quoted" # thing', { blyg: stamp() })]);
  const doc = yamlOf(make(pg, pg.threads).text);
  assert.deepEqual([doc.title, doc.blyg, doc.released, doc.permalink, doc.blyg_sources, doc.blyg_stub_of],
    [undefined, true, '2026-11-23', '/b/on-liveness', [POST], { origin: ORIGIN, id: ID, version: 2 }]);
  assert.ok(!('tags' in doc));
  const w = webPage([thread('t1', 'x', 'plain words')], { export_response: 'response' });
  assert.deepEqual(yamlOf(make(w, w.threads).text).blyg_stub_of, { url: w.url });
});

rb('yamlString: hostile strings come back exactly (a real parser reads them)', () => {
  const samples = ['a: b', '---', 'x\ny: z', '"q"', "'", '# c', '{{ x }}', 'null', 'true', '~', '- a', '[a', '&a', '!!str x', '%TAG !', 'tab\there', 'é ü 日本', '😀', '\u0085', '\u2028', ': ', '...', '\\'];
  for (const s of samples) {
    const out = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(ARGF.read), quirks_mode: true)'], { input: `k: ${N.yamlString(s)}\n`, encoding: 'utf8' }).replace(/^/, '[').replace(/$/, ']'))[0];
    assert.equal(out.k ?? out, s.replace(/[\u2028]/g, '\u2028'), JSON.stringify(s));
  }
  assert.ok(!/\n/.test(N.yamlString('a\nb')), 'one line, always');
});

test('hostile QUOTE: nothing in it can leave its blockquote or run (markdown, HTML, wikilinks, Liquid, kramdown, math, TK, front-matter lines)', () => {
  const evil = ['---', 'title: pwned', '---', '{{ site.data.secret }} {% include evil.html %} {%- raw -%}', '<script>alert(1)</script> <img src=x onerror=1>',
    '![[abcdefghjkmnpqrstvwxyz0123]] [[Some note]] ![](http://t.example.test/p.gif) [x](javascript:alert(1))', '# heading', '- item', '1. numbered', '> nested', '=== setext', '$$ \\alpha $$ and $5',
    'a paragraph {: .danger onclick="x()"} here', '[TK] write me [/TK]', '| a | b |', '`` ` ``', '&amp; &#123;{ x }}', '    indented code', '* * *'].join('\n');
  const page = blygPage([thread('t1', evil, 'My words.', { blyg: stamp() })]);
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  const body = r.text.split('\n---\n').slice(1).join('\n---\n');
  const lines = body.split('\n');
  assert.equal(lines[0], `![[${ID} | A made-up post]]`, 'the one directive is the real one');
  const quote = lines.slice(1, lines.indexOf('')).filter(l => l !== '>');
  assert.ok(quote.length >= 15 && quote.every(l => l.startsWith('> ')), 'every quoted line stays inside the blockquote');
  for (const l of quote) {
    const bare = l.slice(2).replace(/\\./g, '');       // what a renderer would still READ as syntax
    assert.ok(!/\{\{|\{%|\{:/.test(bare), `no live Liquid or kramdown attribute list: ${l}`);
    assert.ok(!/</.test(bare), `no raw HTML: ${l}`);
    assert.ok(!/\[\[|\]\(|!\[/.test(bare), `no wikilink, link or image: ${l}`);
    assert.ok(!/^(#|-|\d+\.|=|\*|\+|>|\|)/.test(l.slice(2)), `no block syntax at the start of: ${l}`);
    assert.ok(!/\$/.test(bare), `no math: ${l}`);
  }
  assert.ok(!/(^|\n)\[\/?TK\]/i.test(body.replace(/`\[\/?TK\]`/gi, '')), 'a TK mark is only ever code');
  assert.ok(!/(^|\n)---(\n|$)/.test(body), 'no front-matter-looking line in the body');
  assert.equal(r.text.match(/^---$/gm).length, 2, 'exactly the two fences');
  assert.ok(/\n\nMy words\.\n$/.test(r.text));
});

test('hostile PAGE fields: title, URL, and a Blygger post\'s id, origin and version cannot reach the front matter or the directive', () => {
  const evilTitle = 'x]] | y\n---\ntitle: pwned {{ 7 }} <b>';
  const evilUrl = 'https://user:pw@news.example.test/a b?x={{1}}&y=[z]#frag';
  const w = webPage([thread('t1', 'quoted', 'words')], { title: evilTitle, url: evilUrl });
  const rw = make(w, w.threads);
  assert.ok(rw.ok);
  assert.ok(!/user:pw|frag|pwned/.test(rw.text), 'credentials, fragment and the page title never appear');
  assert.equal(rw.text.match(/^---$/gm).length, 2);
  const bad = [{ id: 'SHORT' }, { id: ID.toUpperCase() }, { origin: 'javascript:alert(1)' }, { origin: 'https://h.example.test/no-slash' }, { version: 0 }, { version: 'x' }, { version: 1.5 }];
  for (const b of bad) {
    const item = { origin: ORIGIN, id: ID, version: 2, page: POST, ...b };
    const page = blygPage([thread('t1', PASSAGE, 'words', { blyg: stamp() })], { blyg: { status: 'blyg', item } });
    const r = make(page, page.threads);
    assert.ok(r.ok, JSON.stringify(b));
    assert.ok(!/!\[\[|blyg_sources|origin:/.test(r.text), `an odd Blygger identity is treated as an ordinary page: ${JSON.stringify(b)}`);
  }
  const labelPage = blygPage([thread('t1', PASSAGE, 'words', { blyg: stamp() })], { title: 'a]] b | c {{x}} <i>' });
  const rl = make(labelPage, labelPage.threads);
  assert.ok(rl.text.split('\n').some(l => l.startsWith(`![[${ID}`) && !/[{}<>|]{1}.*\]\]/.test(l.replace(/^!\[\[[^|\]]*/, '').replace(/\]\]$/, '').replace(/^ \| /, ''))), 'the label is plain words');
  assert.ok(!/\{\{/.test(rl.text));
});

test('what a note makes a site FETCH (blyg_sources): a private, local or other-host address from a hostile page is never written; the page falls back to an ordinary quote', () => {
  const hostile = [
    { origin: 'http://127.0.0.1:4189/', page: 'http://127.0.0.1:4189/t/' + ID + '/' },
    { origin: 'http://localhost/blyg/', page: 'http://localhost/blyg/t/' + ID + '/' },
    { origin: 'https://10.0.0.5/blyg/', page: 'https://10.0.0.5/blyg/t/' + ID + '/' },
    { origin: 'http://[::1]/blyg/', page: 'http://[::1]/blyg/t/' + ID + '/' },
    { origin: 'http://169.254.169.254/', page: 'http://169.254.169.254/latest/' },
    { origin: 'https://printer.local/blyg/', page: 'https://printer.local/blyg/t/' + ID + '/' },
    { origin: ORIGIN, page: 'https://evil.example.test/t/' + ID + '/' },            // a page on ANOTHER host than its origin
    { origin: ORIGIN, page: 'http://blyg.example.test/notes/t/' + ID + '/' },          // a downgraded scheme
    { origin: ORIGIN, page: 'file:///etc/passwd' },
  ];
  for (const h of hostile) {
    const page = blygPage([thread('t1', PASSAGE, 'words', { blyg: stamp() })], { blyg: { status: 'blyg', item: { id: ID, version: 2, ...h } } });
    assert.equal(N.blygItemOf(page), null, JSON.stringify(h));
    const r = make(page, page.threads);
    assert.ok(r.ok, JSON.stringify(h));
    assert.ok(!/blyg_sources|!\[\[|origin:/.test(r.text), `nothing for a site to fetch: ${JSON.stringify(h)}`);
  }
  assert.ok(N.blygItemOf(blygPage([thread('t1', PASSAGE, 'w', { blyg: stamp() })])), 'the ordinary public case still works');
});

test('the owner\'s own words: trusted as content, but Liquid is made inert, front matter cannot be reached, a deliberate wikilink stays', () => {
  const page = webPage([thread('t1', '', 'Use {{ page.title }} and {% include x %}.\n\nSee [[' + ID + ' | that post]].\n\n---\n\ntitle: nope')]);
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  assert.ok(!/(^|[^\\])\{\{|(^|[^\\])\{%/.test(r.text.split('\n---\n').slice(1).join('')), 'Liquid made inert');
  assert.match(r.text, new RegExp(`\\[\\[${ID} \\| that post\\]\\]`));
  assert.equal(r.text.split('\n').filter(l => l === '---').length, 3, 'the two fences, and the owner\'s own thematic break');
  const none = N.renderShortNote({ page, threads: page.threads, home: { ...HOME, escape: 'none' }, now: NOW, slug: 's' });
  assert.match(none.text, /\{\{ page\.title \}\}/, 'escape: none leaves them (a site that is not Jekyll)');
  const code = webPage([thread('t1', '', 'Write `{{ x }}` in the layout.')]);
  const rc = make(code, code.threads);
  assert.equal(rc.ok, false);
  assert.match(rc.error, /code span or block/);
  assert.ok(N.renderShortNote({ page: code, threads: code.threads, home: { ...HOME, escape: 'none' }, now: NOW, slug: 's' }).ok);
});

test('/tk: a filled gap is the owner\'s text, escaped as a passage (an adopted one is the owner\'s own markdown); an unfilled, failed, unknown or leftover [TK] BLOCKS with a plain message', () => {
  const gap = (mode, text) => ({ instruction: 'say hello', mode, ...(text ? { text } : {}) });
  const one = (text, gaps) => { const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine(text), gaps }] }]); return make(p, p.threads); };
  const filled = one('Intro\n/tk say hello\nAfter', [gap('filled-by-agent', 'Hello, reader. [[x]]')]);
  assert.ok(filled.ok);
  assert.match(filled.text, /Intro\nHello, reader\. \\\[\\\[x\\\]\\\]\nAfter\n$/, 'an agent\'s fill is escaped as a passage is');
  assert.ok(!/\/tk|TK/.test(filled.text));
  assert.match(one('Intro /tk(say hello) after', [gap('adopted-by-reader', 'Mine [[x]]')]).text, /Intro Mine \[\[x\]\] after/);
  for (const [name, gaps] of [['pending', [gap('pending')]], ['failed', [gap('failed')]], ['not stored', undefined]]) {
    const r = one('Intro\n/tk say hello', gaps);
    assert.equal(r.ok, false, name);
    assert.match(r.error, /\/tk or \[TK\] placeholder .*still in the comment and nobody has filled it in/, name);
  }
  const studio = one('Intro [TK] a [/TK] x');
  assert.equal(studio.ok, false);
  const code = one('Say `[TK]` out loud');
  assert.ok(code.ok, 'inside code a mark is only text');
});

test('who may publish: only a thread whose first message the owner typed, addressed to no agent, not a deletion', () => {
  const ok = thread('t', 'q', 'mine');
  assert.ok(N.eligibleThread(ok).ok);
  assert.equal(N.eligibleThread({ id: 't', msgs: [{ author: 'guest', text: 'x', ts: 'a' }] }).ok, false, 'not owner-typed');
  assert.equal(N.eligibleThread({ id: 't', msgs: [mine('x', { origin: 'review' })] }).ok, false, 'an imported comment');
  assert.equal(N.eligibleThread({ id: 't', msgs: [mine('@claude what is this?')] }).ok, false, 'addressed to an agent by text');
  assert.equal(N.eligibleThread({ id: 't', msgs: [mine('what is this?', { route: '@claude ' })] }).ok, false, 'addressed by a pill');
  assert.equal(N.eligibleThread({ id: 't', msgs: [{ author: 'claude', text: 'x', ts: 'a', provenance: 'owner-typed' }] }).ok, false, 'an agent author');
  assert.equal(N.eligibleThread({ ...ok, mark: 'strike' }).ok, false);
  assert.equal(N.eligibleThread({ id: 't', msgs: [] }).ok, false);
  // a bot's reply in the owner's thread is never published
  const page = webPage([{ id: 't1', quote: 'q', msgs: [mine('My view.'), { author: 'claude', ts: 'b', text: 'Agent view.' }, mine('More from me.')] }]);
  const r = make(page, page.threads);
  assert.ok(r.ok);
  assert.ok(!/Agent view/.test(r.text) && /My view\.\n\nMore from me\./.test(r.text));
});

test('scope: several comments are one post in order, with each quote above its own words; a chain link only for one comment', () => {
  const page = blygPage([
    thread('t1', PASSAGE, 'First thought.', { blyg: stamp() }),
    thread('t2', PASSAGE, 'Second thought.', { blyg: stamp() }),
  ]);
  const r = make(page, page.threads);
  assert.ok(r.ok);
  assert.match(r.text, /First thought\.\n\n!\[\[[^\n]*\n> [^\n]*\n\nSecond thought\.\n$/);
  assert.equal((r.text.match(/blyg_sources:/g) || []).length, 1);
  const chained = make(page, [page.threads[1]], { earlier: { title: 'The first [one] {{x}}', link: '/b/the-first' } });
  assert.match(chained.text, /\n\nEarlier: \[The first one x\]\(\/b\/the-first\)\n$/);
  const external = make(page, [page.threads[1]], { earlier: { title: 'T', link: 'https://site.example.test/b/a_b' } });
  assert.match(external.text, /Earlier: \[T\]\(https:\/\/site\.example\.test\/b\/a%5Fb\)/);
  assert.equal(make(page, [page.threads[1]], { earlier: { title: 'T', link: 'javascript:alert(1)' } }).text.includes('Earlier'), false, 'only http(s) or a site path');
  assert.equal(make(page, Array.from({ length: 13 }, (_, i) => thread('x' + i, 'q', 'w'))).ok, false, 'at most twelve');
});

test('a passage that does not pass the post\'s check is an ordinary web quote of the post\'s page, and the response still names the post', () => {
  const page = blygPage([thread('t1', 'Not in the post.', 'Hm.', { blyg: stamp({ passage: { match: false } }) })]);
  const r = make(page, page.threads);
  assert.ok(r.ok);
  assert.ok(!/!\[\[/.test(r.text));
  assert.match(r.text, new RegExp(`> Not in the post\\.\\n>\\n> ${POST.replace(/[/.]/g, '\\$&')}\\n`));
  assert.match(r.text, /blyg_stub_of:\n {2}origin:/);
});

test('caps: comment, quote and note sizes are refused with a sentence, never cut', () => {
  const long = thread('t', 'q', 'w'.repeat(N.LIMITS.commentChars + 1));
  assert.match(make(webPage([long]), [long]).error, /longer than 8000/);
  const q = thread('t', 'q'.repeat(N.LIMITS.quoteChars + 1), 'w');
  assert.match(make(webPage([q]), [q]).error, /longer than 2000/);
  const many = Array.from({ length: 12 }, (_, i) => thread('t' + i, '', 'w'.repeat(4000)));
  assert.match(make(webPage(many), many).error, /note would be longer than 40000/);
});

test('titles and slugs: first words, no markup; hostile or odd input gives one safe [a-z0-9-] name', () => {
  assert.equal(N.titleOf('**Hello** [world](http://x.test) and `more` words here that are long indeed'), 'Hello world and more words here that are');
  assert.equal(N.titleOf('   \n  '), 'A short note');
  assert.equal(N.titleOf('<b>{{ x }}</b> ok'), 'x ok');
  assert.ok(N.titleOf('word '.repeat(60)).length <= N.LIMITS.titleChars);
  const odd = ['../../etc/passwd', 'CON', 'con', 'index', '...', '   ', '日本語のタイトル', '😀😀', 'Ünïcödé Tëxt', 'a\0b/c\\d', 'x'.repeat(500), '-- leading', 'NUL.txt', '.hidden', 'a/../b'];
  for (const o of odd) {
    const s = N.slugOf(o, { date: '2026-11-23' });
    assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/, JSON.stringify(o));
    assert.ok(s.length <= N.LIMITS.slugChars + 5, o);
    assert.ok(!['con', 'nul', 'index', 'prn', 'aux'].includes(s), o);
  }
  assert.equal(N.slugOf('Ünïcödé Tëxt'), 'unicode-text');
  assert.equal(N.slugOf('😀', { date: '2026-11-23' }), 'note-20261123');
  assert.equal(N.uniqueSlug('a', new Set(['a', 'a-2'])), 'a-3');
});

test('the template: the default is valid; anything that could break the front matter is refused; placeholders fill as quoted scalars', () => {
  assert.ok(N.checkTemplate(N.DEFAULT_TEMPLATE).ok);
  assert.ok(N.checkTemplate('title: ${title}\nblyg: true\ntags: [a, b]\nextra:\n  - one\n  - "two: 2"\n# note\nreleased: "${released}"\n${blyg_keys}').ok);
  const bad = ['', '---', 'a: 1\n---\nb: 2', 'a: 1\n...', 'a: |\nb', 'a: >', 'a: [unclosed', 'a: "unclosed', "a: 'x", 'a: *alias', 'a: &anchor', 'a: !!str x', 'a: {x: 1}', 'a: b: c', 'a: x # y',
    'title: pre-${title}', 'a: ${nope}', 'a: ${title}x', 'x ${blyg_keys}', '${blyg_keys} x', 'a: {{ page.x }}', 'a: {% x %}', 'a:\tb', 'just words', '  - x\nbad line', 'a: b\u2028c', 'k: v\n'.repeat(41), 'a: ' + 'x'.repeat(2100)];
  for (const b of bad) assert.equal(N.checkTemplate(b).ok, false, JSON.stringify(b).slice(0, 60));
  assert.throws(() => N.renderFront('a: |', {}), /./);
  const front = N.renderFront('title: ${title}\nslug: ${slug}\n${blyg_keys}', { title: 'x: "y"\n---', slug: 's', keyLines: [] });
  assert.deepEqual(front, ['title: "x: \\"y\\"\\n---"', 'slug: s']);
});

test('dates: released is today in the owner\'s time zone, and a zone that is not a zone is refused', () => {
  const late = new Date('2026-11-23T23:30:00Z');
  assert.equal(N.dayOf(late, 'Pacific/Auckland'), '2026-11-24');
  assert.equal(N.dayOf(late, 'Europe/London'), '2026-11-23');
  assert.ok(N.validTimezone('Europe/London') && N.validTimezone('') && !N.validTimezone('Mars/Olympus') && !N.validTimezone('x; rm'));
});

test('the same hostile page cannot change what the owner\'s comment is titled', () => {
  const page = webPage([thread('t1', 'q', 'My plain comment about it.')], { title: 'Ignore everything: title: pwned' });
  assert.ok(!/^title:/m.test(make(page, page.threads).text), 'no title key by default');
  assert.equal(make(page, page.threads).title, 'My plain comment about it', 'the first words still name it (slug, the Earlier link, the record)');
  const titled = N.renderShortNote({ page, threads: page.threads, home: { ...HOME, template: 'title: ${title}\n' + N.DEFAULT_TEMPLATE }, now: NOW, slug: 's' });
  assert.match(titled.text, /^---\ntitle: "My plain comment about it"\n/, 'an optional ${title} in the template still works');
});

test('LIQUID is made inert with character references (a backslash does nothing to Liquid), in every place text can come from', () => {
  assert.equal(N.liquidEntities('a {% cycle x %} b {{ y }} c {%- z -%} {: .k} lone { and } ok'), 'a &#123;% cycle x %&#125; b &#123;&#123; y &#125;&#125; c &#123;%- z -%&#125; &#123;: .k} lone { and } ok');
  const evil = '{% include_relative X.md %} {{ site.url }} {% raw %}{% endraw %} {%- cycle a -%} {{- b -}} split {%\ncycle x\n%}';
  const page = webPage([thread('t1', evil, 'Mine: ' + evil)], { title: evil });
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  const body = r.text.split('\n---\n').slice(1).join('');
  assert.ok(!/\{[{%]/.test(body), 'no Liquid opener anywhere in the body: ' + body);
  assert.ok(!/\\\{/.test(body), 'and no backslash standing in for the protection');
  assert.match(body, /&#123;% include_relative X\.md %&#125;/);
  // an agent's fill and an owner-edited one are escaped as a passage; only an adopted one is the owner's markdown
  const gap = (mode, text) => ({ instruction: 'say hello', mode, text });
  for (const mode of ['filled-by-agent', 'edited-by-reader']) {
    const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Before\n/tk say hello\nAfter'), gaps: [gap(mode, 'X {% cycle site.title %} <script>alert(1)</script> [a](javascript:alert(1)) "q" # head')] }] }]);
    const t = make(p, p.threads).text;
    assert.ok(!/\{[{%]/.test(t) && !/(^|[^\\])<script/.test(t) && !/[^\\]\]\(javascript/.test(t), mode + ': ' + t);
    assert.match(t, /\\<script>|&lt;script/, mode);
  }
  const adopted = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Before\n/tk say hello\nAfter'), gaps: [gap('adopted-by-reader', 'Mine **bold** [[x]]')] }] }]);
  assert.match(make(adopted, adopted.threads).text, /Mine \*\*bold\*\* \[\[x\]\]/);
  // a code span with Liquid in it is refused, with a message (a reference would show as its letters there)
  const code = webPage([thread('t1', '', 'See `{% cycle a %}` here')]);
  assert.match(make(code, code.threads).error, /code span or block/);
});

test('an edited-away message (superseded) is not part of the post', () => {
  const page = webPage([{ id: 't1', quote: 'q', msgs: [mine('The words I kept.'), mine('Old words set aside.', { superseded: '1' })] }]);
  const r = make(page, page.threads);
  assert.ok(/kept/.test(r.text) && !/set aside/.test(r.text));
});

test('a passage that is only a URL (or holds one) stays text (a code span): no autolink, no link card; the note\'s own source line is still the card', () => {
  const page = webPage([thread('t1', 'Intro line\nhttps://hostile.example.test/steal?x=1\nSee HTTP://Other.test/a and http://x.test/', 'words')]);
  const r = make(page, page.threads);
  const body = r.text.split('\n---\n').slice(1).join('');
  assert.ok(!/(^|[^`])\bhttps?:\/\/(hostile|Other|x\.test)/i.test(body.split('\n>\n> https://news.example.test')[0].replace(/`[^`]*`/g, '')), 'every address in the passage is inside a code span: ' + body);
  assert.match(body, /> `https:\/\/hostile\.example\.test\/steal\?x=1`/, 'a code span: the same characters, never a paragraph that is only a URL');
  assert.ok(!/\n>\s*https?:\/\/hostile/i.test(body));
  assert.match(body, /\n>\n> https:\/\/news\.example\.test\/a\/story\?id=7\n/, 'the source line is a plain bare URL: the card');
});
