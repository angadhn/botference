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
const BID = '0000000000000000000000000z';
const PASSAGE = 'A sentence that the post really says.';
const mine = (text, extra = {}) => ({ author: 'owner', ts: '2026-11-22T10:00:00Z', text, provenance: 'owner-typed', ...extra });
const thread = (id, quote, text, extra = {}) => ({ id, quote, msgs: [mine(text)], ...extra });
const stamp = (extra = {}) => ({ status: 'blyg', id: ID, version: 2, origin: ORIGIN, page: POST, passage: { match: true }, ...extra });
const blygPage = (threads, extra = {}) => ({ url: POST, title: 'A made-up post', blyg: { status: 'blyg', item: { origin: ORIGIN, id: ID, version: 2, page: POST } }, threads, ...extra });
const webPage = (threads, extra = {}) => ({ url: 'https://news.example.test/a/story?id=7', title: 'A story', threads, ...extra });
const HOME = { template: N.DEFAULT_TEMPLATE, escape: 'liquid', timezone: 'Europe/London' };
const make = (page, threads, extra = {}) => N.renderShortNote({ page, threads, home: HOME, now: NOW, slug: 'on-liveness', id: BID, ...extra });

test('a Blygger page: the quote by reference, the response, the sources, today as released, no essays tag', () => {
  const page = blygPage([thread('t1', PASSAGE, 'I agree, and the smoothness is the point.', { blyg: stamp() })]);
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  assert.equal(r.text, `---
created: 2026-11-23
released: "2026-11-23"
blyg: true
blyg_id: "${BID}"
permalink: /b/${BID}
blyg_sources:
  - "${POST}"
blyg_stub_of:
  origin: "${ORIGIN}"
  id: "${ID}"
  version: 2
---
I agree, and the smoothness is the point.

![[${ID} | A made-up post]]
> A sentence that the post really says.
`);
  assert.ok(!/essays/.test(r.text));
  assert.equal(r.permalink, `/b/${BID}`);
});

// A Blygger id is 26 characters of [0-9a-hjkmnp-tv-z] with the first 0-7, so a page can name one that YAML 1.1 (Ruby's Psych, the
// site's reader) takes for a number: 0x + hex, 0b + binary, 0 + octal digits. The note writes it quoted, so the site reads the string.
test('blyg_stub_of.id is a quoted string, so an id a YAML 1.1 reader would take for a number (0x…, 0b…, octal) stays the id', () => {
  for (const id of ['0x1234567890abcdef12345678', '0b111111111111111111111111', '01234567012345670123456701']) {
    assert.ok(N.isBlygId(id), id);
    const page = { ...blygPage([]), blyg: { status: 'blyg', item: { origin: ORIGIN, id, version: 2, page: POST } } };
    page.threads = [thread('t1', PASSAGE, 'A reply.', { blyg: stamp({ id }) })];
    const r = make(page, page.threads);
    assert.ok(r.ok, r.error);
    assert.match(r.text, new RegExp(`\\nblyg_stub_of:\\n  origin: "${ORIGIN.replace(/[.]/g, '\\.')}"\\n  id: "${id}"\\n  version: 2\\n`), id);
    assert.ok(!r.text.includes(`id: ${id}`), 'never bare');
  }
});

test('an ordinary page: the plain web quote whose last paragraph is the bare URL; no stub unless the owner said response', () => {
  const page = webPage([thread('t1', 'Hiring is slowing for junior roles.', 'This matches what I see.')]);
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  assert.match(r.text, /\n---\nThis matches what I see\.\n\n> Hiring is slowing for junior roles\.\n>\n> https:\/\/news\.example\.test\/a\/story\?id=7\n$/);
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
    [undefined, true, '2026-11-23', `/b/${BID}`, [POST], { origin: ORIGIN, id: ID, version: 2 }]);
  assert.ok(!('tags' in doc));
  assert.equal(doc.blyg_id, BID, 'the id is read back as the string it is');
  const digits = yamlOf(make(pg, pg.threads, { id: '12345678901234567890123456' }).text);
  assert.equal(digits.blyg_id, '12345678901234567890123456', 'an id of only digits is still a string (it is quoted)');
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
  assert.equal(lines[0], 'My words.', 'the owner\'s first comment comes first');
  assert.equal(lines[2], `![[${ID} | A made-up post]]`, 'the one directive is the real one');
  const quote = lines.slice(3).filter(l => l !== '>' && l !== '');
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
  assert.ok(/\n---\nMy words\.\n\n/.test(r.text));
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

test('/tk: an agent-written passage (filled, edited, adopted, pasted) is the site\'s generated-passage form, escaped as text, with one blyg_generated entry each; an unfilled or failed one BLOCKS; a [TK] the owner typed is shown as the letters', () => {
  const gap = (mode, text, extra = {}) => ({ instruction: 'say hello', mode, ...(text ? { text } : {}), agent: 'claude', model: 'claude-opus-5', at: '2026-11-24T10:00:00Z', ...extra });
  const one = (text, gaps) => { const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine(text), gaps }] }]); return make(p, p.threads); };
  const filled = one('Intro\n/tk say hello\nAfter', [gap('filled-by-agent', 'Hello, reader. [[x]]')]);
  assert.ok(filled.ok, filled.error);
  // a line gap is a block of its own; brackets as character references (no raw [ or ] for a site's own markup to read)
  assert.match(filled.text, /Intro\n\n\[TK\] say hello \[=\]Hello, reader\. &#91;&#91;x&#93;&#93;\[\/TK\]\n\nAfter\n$/, filled.text);
  assert.match(filled.text, /blyg_generated:\n {2}- model: "claude-opus-5"\n {4}at: 2026-11-24T10:00:00Z\n---/);
  assert.deepEqual(filled.generated.map(g => [g.agent, !!g.edited_by_author]), [['claude', false]]);
  // edited and adopted: the same form, the text as it now stands, still escaped, and marked as having the owner's hand in it
  for (const mode of ['edited-by-reader', 'adopted-by-reader']) {
    const r = one('Intro /tk(say hello) after', [gap(mode, 'Mine **b** [[x]]')]);
    assert.match(r.text, /Intro \[TK\] say hello \[=\]Mine \\\*\\\*b\\\*\\\* &#91;&#91;x&#93;&#93;\[\/TK\] after/, mode);
    assert.match(r.text, /edited_by_author: true/, mode);
  }
  // pasted from an agent's tool: the impyrt form, with the model of that agent
  const pasted = one('See /tkimpyrt-codex(pasted words) here', [{ kind: 'impyrt', agent: 'codex', instruction: 'pasted words', mode: 'pasted-by-reader', text: 'pasted words', model: 'gpt-5.5-codex', at: '2026-11-24T10:00:00Z' }]);
  assert.match(pasted.text, /See \[TK\]impyrt gpt-5\.5-codex=pasted words\[\/TK\] here/, pasted.text);
  assert.deepEqual(pasted.generated.map(g => g.agent), ['codex']);
  for (const [name, gaps] of [['pending', [gap('pending')]], ['failed', [gap('failed')]], ['not stored', undefined]]) {
    const r = one('Intro\n/tk say hello', gaps);
    assert.equal(r.ok, false, name);
    assert.match(r.error, /a \/tk passage .*is not written yet/, name);
    assert.ok(!/\[TK\]/.test(r.error), 'the owner is never told about bracket markers');
  }
  // the bracket form is not a gap any more: the owner's own words, shown as the letters, never the site's grammar
  const studio = one('Intro [TK] a [/TK] x');
  assert.ok(studio.ok, studio.error);
  assert.match(studio.text, /Intro &#91;TK\] a &#91;\/TK\] x/);
  const code = one('Say `[TK]` out loud');
  assert.ok(code.ok && /`\[TK\]`/.test(code.text), 'inside code a mark is only text');
});

test('inside a generated passage nothing can end the scope or pair with code: a TK mark, [=] and a backtick are character references; Liquid and HTML inert', () => {
  const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('A /tk(go) b'), gaps: [{ instruction: 'go', mode: 'filled-by-agent', agent: 'claude', text: 'x [/TK] y [=] z ` w {{ site.title }} <b>' }] }] }]);
  const t = make(p, p.threads).text;
  const scope = /\[TK\] go \[=\](.*?)\[\/TK\]/.exec(t)[1];
  assert.ok(!/\[\/?TK\]|\[=\]|`|\{\{|(^|[^\\])<b/.test(scope), scope);
  assert.equal((t.match(/\[\/TK\]/g) || []).length, 1, 'one scope, one end');
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
  assert.ok(!/Agent view/.test(r.text) && /My view\.\n\n> q\n>\n> [^\n]*\n\nMore from me\./.test(r.text), 'first comment, quote, then the rest of the thread');
});

test('scope: several comments are one post in order, with each quote above its own words; a chain link only for one comment', () => {
  const page = blygPage([
    thread('t1', PASSAGE, 'First thought.', { blyg: stamp() }),
    thread('t2', PASSAGE, 'Second thought.', { blyg: stamp() }),
  ]);
  const r = make(page, page.threads);
  assert.ok(r.ok);
  assert.match(r.text, /First thought\.\n\n!\[\[[^\n]*\n> [^\n]*\n\nSecond thought\.\n\n!\[\[[^\n]*\n> [^\n]*\n$/);
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
  // every agent-written passage (adopted included) is escaped as a passage is
  const gap = (mode, text) => ({ instruction: 'say hello', mode, text });
  for (const mode of ['filled-by-agent', 'edited-by-reader', 'adopted-by-reader']) {
    const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Before\n/tk say hello\nAfter'), gaps: [gap(mode, 'X {% cycle site.title %} <script>alert(1)</script> [a](javascript:alert(1)) "q" # head')] }] }]);
    const t = make(p, p.threads).text;
    assert.ok(!/\{[{%]/.test(t) && !/(^|[^\\])<script/.test(t) && !/[^\\]\]\(javascript/.test(t), mode + ': ' + t);
    assert.match(t, /\\<script>|&lt;script/, mode);
  }
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

test('short posts are text: raw HTML in the owner\'s own words is written so it renders literally (markdown, an http(s) autolink and code kept); an adopted agent passage is plain text in its box', () => {
  const evil = 'a < b and <script>alert(1)</script> <img src=x onerror=alert(1)> <iframe src=//x></iframe> <style>*{x:y}</style> <!-- c --> <details open ontoggle=alert(1)> <https://ok.example.test/a> **bold** `<code>` [h](https://ok.example.test)';
  const page = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Own: ' + evil + '\n/tk go\n'), gaps: [{ instruction: 'go', mode: 'adopted-by-reader', agent: 'claude', text: 'Adopted: ' + evil }] }] }]);
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  const body = r.text.split('\n---\n').slice(1).join('');
  const [own, box] = body.split('[TK] go [=]');
  const noCode = own.replace(/`[^`]*`/g, '');
  assert.ok(!/<(script|img|iframe|style|details|!--)/i.test(noCode), 'no raw HTML tag outside code: ' + own);
  // (an address in it is a code span, as in a passage: its backticks come in pairs; any other backtick is a character reference)
  assert.ok(!/(^|[^\\])<(script|img|iframe|style|details|!--)/i.test(box) && (box.match(/`/g) || []).length % 2 === 0, 'the box holds text only: ' + box);
  assert.match(own, /a &lt; b/, '“a < b” reads as typed');
  assert.ok(!/\]\(javascript/i.test(body), 'no javascript: link (one in the owner\'s words is refused: see the test below)');
  assert.match(own, /<https:\/\/ok\.example\.test\/a>/, 'the autolink is kept in the owner\'s words');
  assert.match(own, /\*\*bold\*\*/, 'markdown is kept in the owner\'s words');
  assert.match(own, /`<code>`/, 'a code span shows < literally: not double-escaped');
  assert.match(own, /\[h\]\(https:\/\/ok\.example\.test\)/, 'an https link is kept');
  assert.match(box, /\\\*\\\*bold\\\*\\\*/, 'in the box markdown is text');
  // a stray bar never becomes a table; a wikilink keeps its own
  assert.equal(N.neutraliseHtml('a | b\n- | -\nsee [[x | y]]'), 'a \\| b\n- \\| -\nsee [[x | y]]');
});

test('a short blyg\'s id: 128 bits encoded exactly as the blog\'s Blygger.new_id (vectors made by that Ruby function); the default template addresses /b/<id>', () => {
  const vec = [['00000000000000000000000000000001', '00000000000000000000000001'], ['ffffffffffffffffffffffffffffffff', '7zzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['0123456789abcdeffedcba9876543210', '014d2pf2dbsqqzxq5tk1v58cgg'], ['80000000000000000000000000000000', '40000000000000000000000000']];
  for (const [hex, id] of vec) assert.equal(N.blygIdFrom(Buffer.from(hex, 'hex')), id);
  assert.ok(N.isBlygId(N.newBlygId()) && N.newBlygId() !== N.newBlygId());
  assert.equal(N.newBlygId(() => Buffer.alloc(16, 255)), '7zzzzzzzzzzzzzzzzzzzzzzzzz');
  assert.ok(!N.isBlygId('../x') && !N.isBlygId('A'.repeat(26)));
  const page = webPage([thread('t1', 'x', 'plain words')]);
  const r = make(page, page.threads, { id: '' });                // no id handed in: one is made
  assert.match(r.text, /\nblyg_id: "([0-9a-hjkmnp-tv-z]{26})"\npermalink: \/b\/\1\n/);
  assert.equal(make(page, page.threads, { id: '../evil' }).permalink.startsWith('/b/../'), false, 'a bad id is never used');
});

// Review item 6: a link in the owner's words must be a web address, and a short post has no images (the example site refuses remote
// media at build). Both are refused when the note is written (the start), with a sentence naming the link, instead of failing the
// site's build late. Code spans, an escaped passage and an agent's escaped fill are text, never links.
test('a non-http(s) link or any image in the owner\'s words is refused by name; http(s) links, code and escaped text are fine', () => {
  const one = text => make(webPage([thread('t1', 'A passage.', text)]), webPage([thread('t1', 'A passage.', text)]).threads);
  for (const [text, why] of [
    ['see [x](<javascript:alert(1)>)', /a link in the comment points to “<javascript:alert\(1\)>”, which is not a web address/],
    ['see [x](javascript:alert(1))', /“javascript:alert\(1\)”, which is not a web address/],
    ['mail [me](mailto:a@b.example)', /“mailto:a@b\.example”/],
    ['local [p](/somewhere)', /“\/somewhere”/],
    ['data [d](data:text/html,x)', /“data:text\/html,x”/],
    ['ref [r][1]\n\n[1]: javascript:alert(1)', /“javascript:alert\(1\)”/],
    ['broken [b](http://[bad)', /“http:\/\/\[bad”/],
    ['pic ![i](javascript:alert(1))', /images are not supported in a short post yet/],
    ['pic ![i](https://img.example.test/x.png)', /images are not supported in a short post yet/],
  ]) {
    const r = one(text);
    assert.equal(r.ok, false, text);
    assert.match(r.error, why, text);
  }
  for (const text of ['see [x](https://ok.example.test/a?b=1)', 'plain <https://ok.example.test/>', 'code `[x](javascript:alert(1))` and `![i](x)`', 'wiki [[0123456789abcdefghjkmnpqrs | a post]]']) {
    const r = one(text);
    assert.ok(r.ok, `${text}: ${r.error}`);
  }
  assert.deepEqual(N.linkProblems('escaped \\[a\\]\\(javascript:x\\) and \\!\\[i\\]'), []);
});

// Review item 5: a passage's square brackets are character references (and percent-encoded inside an address), so the example site's
// sidenote converter (`[^1]` and `[^1]: …` in the raw markdown, backslash or not) can never read a hostile passage as its markup;
// the spaces around an address in a passage are kept.
test('passage brackets are &#91; / &#93; (none left raw), brackets in an address are %5B / %5D, and the spaces around an address stay', () => {
  for (const t of ['x[^1] and more', '[^1]: <b>hi</b> note', 'a ] b [ c', 'nested [[^2]] and \\[^3]']) {
    const e = N.escapePassage(t);
    assert.ok(!/[[\]]/.test(e.replace(/`[^`]*`/g, '')), `${t} → ${e}`);
  }
  assert.equal(N.escapePassage('see https://x.example/[^1]/y now'), 'see `https://x.example/%5B^1%5D/y` now');
  const page = webPage([thread('t1', 'A claim[^1] here.\n[^1]: <img src=x onerror=alert(1)> a footnote', 'My words.')]);
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  const body = r.text.split('\n---\n').slice(1).join('');
  assert.ok(!/\[\^/.test(body), 'no [^ anywhere in the body: ' + body);
});
