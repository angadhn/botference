// blyg-note.test.mjs — the short post as text: what it says, and that a hostile page cannot say anything else in it.
//
//   node --test test/blyg-note.test.mjs
//
// Front matter is checked by a REAL YAML parser (Ruby's Psych, when ruby is on the PATH) so "it round-trips" is a fact
// and not our opinion; the rest is the text itself. No network, no clock but the one handed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
  assert.match(resp.text, /blyg_stub_of:\n {2}url: "https:\/\/news\.example\.test\/a\/story\?id=7"\n {2}title: "A story"\n---/);
  // a page with no title: the url alone (the site shows the host name)
  const bare = make({ ...page, title: '  ', export_response: 'response' }, page.threads);
  assert.match(bare.text, /blyg_stub_of:\n {2}url: "https:\/\/news\.example\.test\/a\/story\?id=7"\n---/);
  // who is told: the page is ASKED (at the site's publish) whether it accepts mentions; nothing is promised
  assert.equal(r.notify, 'Its page will be asked whether it accepts mentions');
  assert.equal(resp.notify, 'Its page will be asked whether it accepts mentions');
  const noQuote = make(webPage([thread('t1', '', 'Just my words.')]), webPage([thread('t1', '', 'Just my words.')]).threads);
  assert.equal(noQuote.notify, '', 'a post that neither quotes nor answers the page tells nobody');
});

test('the page title a response records is the page\'s text made plain: one line, no <>{}, at most 200 characters, quoted', () => {
  const hostile = 'Breaking: {{ site.x }} {% raw %} <script>alert(1)</script> "quoted" \u202e\nsecond line';
  assert.equal(N.pageTitleOf({ title: hostile }), 'Breaking: site.x % raw % script alert(1) /script "quoted" second line');
  assert.equal(N.pageTitleOf({ title: '<>{}' }), '');
  const long = N.pageTitleOf({ title: 'word '.repeat(80) });
  assert.ok(long.length <= N.PAGE_TITLE_CHARS && long.endsWith('word'), long);
  const page = webPage([thread('t1', 'Hiring is slowing.', 'Words.')], { export_response: 'response', title: hostile });
  const r = make(page, page.threads);
  assert.ok(r.ok, r.error);
  const line = r.text.split('\n').find(l => l.startsWith('  title: '));
  assert.equal(line, `  title: ${JSON.stringify(N.pageTitleOf({ title: hostile }))}`);
  assert.ok(!/[<>{}]/.test(line));
  // never for a Blygger post's stub (that target names itself), never without a response
  const post = blygPage([thread('t1', PASSAGE, 'x', { blyg: stamp() })], { export_response: 'response' });
  assert.ok(!/^ {2}title:/m.test(make(post, post.threads).text));
  assert.ok(!/title:/.test(make({ ...page, export_response: 'not-a-response' }, page.threads).text));
});

test('a post\'s one target: the same for every version read and every title the page had; none when not a response', () => {
  const t = [thread('t1', 'x', 'y')];
  const w = webPage(t, { export_response: 'response' });
  assert.equal(N.stubTargetOf(N.stubOfPage(w)), 'page https://news.example.test/a/story?id=7');
  assert.equal(N.stubTargetOf(N.stubOfPage({ ...w, title: 'Renamed' })), N.stubTargetOf(N.stubOfPage(w)));
  assert.equal(N.stubTargetOf(N.stubOfPage(webPage(t))), '');
  const b = blygPage([thread('t1', PASSAGE, 'x', { blyg: stamp() })]);
  assert.equal(N.stubTargetOf(N.stubOfPage(b)), `post ${ORIGIN}${ID}`);
  const later = blygPage([thread('t1', PASSAGE, 'x', { blyg: stamp({ version: 3 }) })]);
  assert.equal(N.stubTargetOf(N.stubOfPage(later)), N.stubTargetOf(N.stubOfPage(b)), 'a later version read is the same target');
  const r = make(b, b.threads);
  assert.equal(r.snapshot.target, N.hashOf(`post ${ORIGIN}${ID}`));
});

test('two comments from one ordinary page in one post: each comment, its quote card and the same address, in the order given', () => {
  const page = webPage([thread('t1', 'Hiring is slowing.', 'First thought.'), thread('t2', 'Juniors are hit first.', 'Second thought.')]);
  const r = make(page, [page.threads[0], page.threads[1]]);
  assert.ok(r.ok, r.error);
  assert.match(r.text, /\n---\nFirst thought\.\n\n> Hiring is slowing\.\n>\n> https:\/\/news\.example\.test\/a\/story\?id=7\n\nSecond thought\.\n\n> Juniors are hit first\.\n>\n> https:\/\/news\.example\.test\/a\/story\?id=7\n$/);
  assert.equal(r.title, 'First thought');
  const flip = make(page, [page.threads[1], page.threads[0]]);
  assert.ok(flip.text.indexOf('Second thought.') < flip.text.indexOf('First thought.'), 'the order given is the order written');
  // adding a comment from the same page is "Added a comment." (its passage is part of that comment, not a changed passage)
  const one = make(page, [page.threads[0]]);
  assert.equal(N.changelogLine(one.snapshot, r.snapshot), 'Added a comment.');
  assert.equal(N.changelogLine(r.snapshot, one.snapshot), 'Removed a comment.');
  const moved = webPage([thread('t1', 'Hiring is slowing fast.', 'First thought.'), page.threads[1]]);
  assert.equal(N.changelogLine(r.snapshot, make(moved, moved.threads).snapshot), 'Changed the quoted passage.');
  assert.equal(N.changelogLine({ quotes: ['a'] }, { quotes: ['b'] }), 'Changed the quoted passage.', 'a snapshot without threads is compared as a whole');
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
  assert.deepEqual(yamlOf(make(w, w.threads).text).blyg_stub_of, { url: w.url, title: 'A story' });
  const hostile = webPage([thread('t1', 'x', 'plain words')], { export_response: 'response', title: 'A: "b" # c \\ d \u2028 e: [f] - g' });
  assert.deepEqual(yamlOf(make(hostile, hostile.threads).text).blyg_stub_of, { url: w.url, title: N.pageTitleOf(hostile) });
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
    'a paragraph {: .danger onclick="x()"} here', '| a | b |', '`` ` ``', '&amp; &#123;{ x }}', '    indented code', '* * *'].join('\n');
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
  // a passage that holds the site's own bracket marks is REFUSED (the site's build would refuse the post at its end)
  for (const mark of ['[TK] write me [/TK]', 'a stray [/tk] here', 'see [TK]']) {
    const p2 = blygPage([thread('t1', `Before. ${mark}`, 'My words.', { blyg: stamp() })]);
    const r2 = make(p2, p2.threads);
    assert.deepEqual([r2.ok, r2.error], [false, N.PASSAGE_TK_SAY], mark);
    assert.ok(!/\[\/?TK\]/i.test(r2.error), 'the passage sentence names no bracket letters');
  }
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

test('/tk: an agent-written passage (filled, edited, adopted, pasted) is the site\'s generated-passage form, kept as markdown in the site\'s markdown format, with one blyg_generated entry each; an unfilled or failed one BLOCKS; a [TK] the owner typed is shown as the letters', () => {
  const gap = (mode, text, extra = {}) => ({ instruction: 'say hello', mode, ...(text ? { text } : {}), agent: 'claude', model: 'claude-opus-5', at: '2026-11-24T10:00:00Z', ...extra });
  const one = (text, gaps) => { const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine(text), gaps }] }]); return make(p, p.threads); };
  const filled = one('Intro\n/tk say hello\nAfter', [gap('filled-by-agent', 'Hello, reader. [[x]]')]);
  assert.ok(filled.ok, filled.error);
  // a line gap is a block of its own; a wikilink's bracket as a character reference (nothing for the site's own markup to read)
  assert.match(filled.text, /Intro\n\n\[TK\] say hello \[=\]Hello, reader\. &#91;\[x\]\]\[\/TK\]\n\nAfter\n$/, filled.text);
  assert.match(filled.text, /blyg_generated:\n {2}- model: "claude-opus-5"\n {4}at: 2026-11-24T10:00:00Z\n {4}format: markdown\nblyg_prompts: locked\n---/);
  assert.deepEqual(filled.generated.map(g => [g.agent, !!g.edited_by_author]), [['claude', false]]);
  assert.equal(one('/tk say hello\nMy own words follow it.', [gap('filled-by-agent', 'Agent words first.')]).title, 'My own words follow it', 'the name is the owner\'s first words, never the agent\'s or a mark');
  // edited and adopted: the same form, the text as it now stands, still escaped, and marked as having the owner's hand in it
  // (an INLINE gap, typed inside a sentence, is a block of its own all the same: the words before, the box, the words after)
  for (const mode of ['edited-by-reader', 'adopted-by-reader']) {
    const r = one('Intro /tk(say hello) after', [gap(mode, 'Mine **b** [[x]]')]);
    assert.match(r.text, /\nIntro\n\n\[TK\] say hello \[=\]Mine \*\*b\*\* &#91;\[x\]\]\[\/TK\]\n\nafter\n$/, mode);
    assert.match(r.text, /edited_by_author: true/, mode);
  }
  // pasted from an agent's tool: the impyrt form, with the model of that agent, a block of its own too
  const pasted = one('See /tkimpyrt-codex(pasted words) here', [{ kind: 'impyrt', agent: 'codex', instruction: 'pasted words', mode: 'pasted-by-reader', text: 'pasted words', model: 'gpt-5.5-codex', at: '2026-11-24T10:00:00Z' }]);
  assert.match(pasted.text, /\nSee\n\n\[TK\]impyrt gpt-5\.5-codex=pasted words\[\/TK\]\n\nhere\n$/, pasted.text);
  // every box, inline or not, stands between blank lines: never inside a paragraph
  for (const t of [filled.text, pasted.text]) for (const m of t.matchAll(/\[TK\][\s\S]*?\[\/TK\]/g)) {
    assert.ok(/(^|\n\n)$/.test(t.slice(0, m.index)) && /^(\n\n|\n$)/.test(t.slice(m.index + m[0].length)), `a box on its own: ${t}`);
  }
  assert.deepEqual(pasted.generated.map(g => g.agent), ['codex']);
  for (const [name, gaps] of [['pending', [gap('pending')]], ['failed', [gap('failed')]], ['not stored', undefined]]) {
    const r = one('Intro\n/tk say hello', gaps);
    assert.equal(r.ok, false, name);
    assert.match(r.error, /a \/tk passage .*is not written yet/, name);
    assert.ok(!/\[TK\]/.test(r.error), 'the owner is never told about bracket markers');
  }
  // the bracket form is not a gap any more, and the owner's own words may not show the site's marks: REFUSED with the one sentence
  // that names the letters (the owner typed them), before anything is written
  for (const words of ['Intro [TK] a [/TK] x', 'just [/TK]', 'lower [tk] case', 'a reply'].map((w, i) => (i === 3 ? null : w)).filter(Boolean)) {
    const r = one(words);
    assert.deepEqual([r.ok, r.error], [false, N.OWNER_TK_SAY], words);
  }
  assert.equal(N.OWNER_TK_SAY, 'Your comment contains the letters [TK]; remove them or put them in code formatting');
  { const p2 = webPage([{ id: 't1', quote: '', msgs: [mine('Fine first words.'), { ...mine('a later reply with [TK] in it'), ts: '2026-11-22T10:05:00Z' }] }]);
    assert.deepEqual([make(p2, p2.threads).ok, make(p2, p2.threads).error], [false, N.OWNER_TK_SAY], 'a reply of the owner\'s too'); }
  const code = one('Say `[TK]` out loud, and\n\n```\n[/TK]\n```');
  assert.ok(code.ok && /`\[TK\]`/.test(code.text), 'inside code a mark is only text, and allowed');
  // an agent's passage (filled, edited, adopted, pasted) that holds the marks: refused with its own sentence
  for (const mode of ['filled-by-agent', 'edited-by-reader', 'adopted-by-reader']) {
    const r = one('Intro\n/tk say hello', [gap(mode, 'Hello [/TK] there')]);
    assert.deepEqual([r.ok, r.error], [false, N.AGENT_TK_SAY], mode);
  }
  { const r = one('See /tkimpyrt-claude(pasted [TK] words) here', [{ kind: 'impyrt', agent: 'claude', instruction: 'pasted [TK] words', mode: 'pasted-by-reader', text: 'pasted [TK] words' }]);
    assert.deepEqual([r.ok, r.error], [false, N.AGENT_TK_SAY], 'pasted'); }
  assert.ok(!/\[\/?TK\]/i.test(N.AGENT_TK_SAY + N.PASSAGE_TK_SAY), 'only the owner\'s own sentence names the letters');
});

test('inside a generated passage nothing can end the scope or pair with code: a TK mark, [=] and a backtick are character references; Liquid and HTML inert', () => {
  const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('A /tk(go) b'), gaps: [{ instruction: 'go', mode: 'filled-by-agent', agent: 'claude', text: 'x [=] y [[z]] ` w {{ site.title }} <b>' }] }] }]);
  const t = make(p, p.threads).text;
  const scope = /\[TK\] go \[=\](.*?)\[\/TK\]/.exec(t)[1];
  assert.ok(!/\[\/?TK\]|\[=\]|\[\[|`|\{\{|(^|[^\\])<b/.test(scope), scope);
  // (a TK mark in an agent's text never gets this far: the start is refused, AGENT_TK_SAY)
  assert.ok(!N.escapeScopeLine('x [/TK] y').includes('[/TK]'), 'and the escaping alone would still keep it from ending the scope');
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
  assert.match(box, /\*\*bold\*\*/, 'in the box markdown stays markdown (the site renders it from an allow-list)');
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

// (review round 5: what the mutants left untested)
test('showsLiquid reads the TEXT of an agent\'s box (only the never-shown instruction is left out); the instruction is made inert', () => {
  const fm = '---\ntitle: x\n---\n';
  assert.equal(N.showsLiquid(`${fm}Words.\n\n[TK] an instruction [=]The agent says {{ site.title }}.[/TK]\n`), true, 'Liquid shown inside a box is Liquid a reader sees');
  assert.equal(N.showsLiquid(`${fm}Words.\n\n[TK] say {{ x }} please [=]Plain text.[/TK]\n`), false, 'the instruction is never shown');
  assert.equal(N.showsLiquid(`${fm}Words.\n\n[TK]impyrt m=Pasted &#123;% x %&#125;[/TK]\n`), true, 'a character reference is still shown as the brace');
  const scope = N.agentScope({ instruction: 'a <b> [=] c {{x}}', text: 't', mode: 'filled-by-agent' }, { block: true });
  assert.equal(scope, '[TK] a &lt;b> &#91;=] c &#123;&#123;x&#125;&#125; [=]t[/TK]', 'the instruction: no HTML, no [=] that would end it early, no Liquid');
  assert.equal(N.agentScope({ instruction: 'about [/TK] and [tk] marks', text: 't', mode: 'filled-by-agent' }, { block: true }),
    '[TK] about &#91;/TK] and &#91;tk] marks [=]t[/TK]', 'the instruction: none of the site\'s own marks, which would end or nest the scope');
});

// A second belt for the example site's own (it neutralises every scope's text, whatever wrote it): the writer already leaves no
// kramdown attribute list, extension, header id, link, footnote or abbreviation definition, and no script link, in an agent's text.
test('an agent\'s text in a scope can set no attribute and redefine none of the author\'s references (kramdown)', () => {
  const hostile = ['Harmless.\n{: onmouseover="alert(1)"}', 'see *here*{: onclick="alert(2)"} ok', '{:evil: onclick="x"}', '{::nomarkdown}<b>x</b>{:/}',
    '## Head {#hijack}', '[^1]: AGENT-FOOTNOTE', '[ref]: https://evil.example/', '*[WORD]: AGENT-ABBR', 'a [s](javascript:alert(4)) b', '> [ref]: https://e.example/'];
  for (const h of hostile) for (const block of [true, false]) {
    const t = N.scopeText(h, { block });
    assert.ok(!/\{:|\{#|\[|^\s*#|<b/m.test(t.replace(/&#91;|&#123;/g, '')), `${JSON.stringify(h)} → ${JSON.stringify(t)}`);
  }
});

// THE MARKDOWN FORM of an agent's passage (format: markdown): markdown kept, only what would act on the NOTE as character references.
test('an agent\'s passage is stored as markdown: lists, bold, tables, code and links kept; nothing can end the scope, pair with the owner\'s code, run Liquid or add HTML', () => {
  const S = N.storedAgentMarkdown;
  assert.equal(S('- **A browser plugin.** One click.\n- **A Hub.** Mine.'), '- **A browser plugin.** One click.\n- **A Hub.** Mine.');
  assert.equal(S('| a | b |\n|---|---|\n| 1 | 2 |'), '| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(S('See [a post](https://x.example/t/1/) and <https://y.example/>.'), 'See [a post](https://x.example/t/1/) and <https://y.example/>.');
  assert.equal(S('a [TK] b [/TK] c [=] d [[w]] ![[0000000000000000000000000z]] e[^1] <b onclick=x> {{ x }} {% y %} {: .z} {#i} a ` lone'),
    'a &#91;TK] b &#91;/TK] c &#91;=] d &#91;[w]] !&#91;[0000000000000000000000000z]] e&#91;^1] &lt;b onclick=x> &#123;&#123; x &#125;&#125; &#123;% y %&#125; &#123;: .z&#125; &#123;#i&#125; a &#96; lone');
  assert.equal(S('[a](javascript:alert(1)) [d](java&#115;cript:x) [m](mailto:a@b) [ok](https://ok.example/)'),
    '[a&#93;(javascript:alert(1)) [d&#93;(java&#115;cript:x) [m&#93;(mailto:a@b) [ok](https://ok.example/)');
  assert.equal(S('Use `{{ x }}` here'), 'Use `{{ x }}` here', 'a code span is code');
  assert.equal(S('```\nopen {{ x }}'), '\n```\nopen {{ x }}\n```\n', 'an unclosed fence is closed; neither [=] nor [/TK] shares a line with code');
  assert.equal(S('para\n\n    indented'), '\npara\n\n    indented\n');
  assert.equal(S('one\ntwo', { inline: true }), 'one two');
  // in a note: one scope, whatever the agent wrote around fences, backticks and indents
  for (const raw of ['```\nunclosed [/TK]', 'a ` b', '- a\n\n    - b', '~~~\nx', 'x\n\n```js\ny\n```']) {
    const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Mine `code` here\n/tk go\nAfter `more`'), gaps: [{ instruction: 'go', mode: 'filled-by-agent', agent: 'claude', text: raw }] }] }]);
    const r = make(p, p.threads);
    if (/\[\/TK\]/.test(raw)) { assert.equal(r.ok, false); continue; }
    assert.ok(r.ok, r.error);
    assert.equal((r.text.match(/\[\/TK\]/g) || []).length, 1, raw);
    assert.match(r.text, /format: markdown/);
  }
  assert.deepEqual(N.AGENT_TEXT_FORMATS, ['legacy', 'markdown']);
});

// A BARE ADDRESS in the owner's own words is clickable on the post, and still tells nobody: it is listed in blyg_silent_links, and the
// lone-link response reads the owner's typed text (where it is bare).
test('a bare web address in the owner\'s words becomes an autolink, listed as silent; code, links, quote cards and agents\' passages are left alone', () => {
  const L = t => N.linkBareUrls(t);
  assert.deepEqual(L('at https://other.example.test/blyg/.'), { text: 'at <https://other.example.test/blyg/>.', urls: ['https://other.example.test/blyg/'] });
  assert.deepEqual(L('(https://code.example.test/project).'), { text: '(<https://code.example.test/project>).', urls: ['https://code.example.test/project'] });
  assert.equal(L('see https://a.example/x_(y)) and https://b.example/q?x=1,').text, 'see <https://a.example/x_(y)>) and <https://b.example/q?x=1>,');
  const kept = '[x](https://a.b/) <https://c.d/> `https://e.f` [https://g.h](https://g.h) [[https://i]] word:https://no.example \\https://n.o ftp://f.example/ javascript://x';
  assert.deepEqual(L(kept), { text: kept, urls: [] });
  assert.deepEqual(L('```\nhttps://in.code\n```').urls, []);
  assert.deepEqual(L('> a quote\n>\n> https://card.example/x').urls, [], 'the site\'s quote card stays as it was');
  assert.deepEqual(L('[ref]: https://def.example/').urls, []);
  const p = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Mine at https://other.example.test/blyg/ and (https://code.example.test/project). Also [linked](https://linked.example/) and https://linked.example/ again.\n/tk go\n'),
    gaps: [{ instruction: 'go', mode: 'filled-by-agent', agent: 'claude', text: 'Agent https://agent.example/x' }] }] }]);
  const r = make(p, p.threads);
  assert.ok(r.ok, r.error);
  assert.match(r.text, /Mine at <https:\/\/other\.example\.test\/blyg\/> and \(<https:\/\/code\.example\.test\/project>\)\./);
  assert.match(r.text, /blyg_silent_links:\n {2}- "https:\/\/other\.example\.test\/blyg\/"\n {2}- "https:\/\/code\.example\.test\/project"\n/);
  assert.ok(!/silent_links:[\s\S]*linked\.example/.test(r.text.split('\n---\n')[0]), 'an address the owner also linked on purpose keeps its reference');
  assert.ok(!/<https:\/\/agent\.example/.test(r.text) && !/silent_links:[\s\S]*agent\.example/.test(r.text.split('\n---\n')[0]), 'an agent\'s address is the site\'s to render, not the owner\'s');
  assert.deepEqual(N.linkTargetsOf(p.threads), ['https://linked.example/'], 'the lone-link response reads only what the owner linked on purpose');
  assert.equal(r.title, N.titleOf('Mine at https://other.example.test/blyg/ and (https://code.example.test/project). Also [linked](https://linked.example/) and https://linked.example/ again.'), 'the name is the same words as before');
});

// REVIEW 2026-11-26, item 4: the site matches blyg_silent_links in its normalised form (AutoLinks.normalize), so a bare address that is
// the same target as a link the owner made on purpose is left exactly as typed and never silenced: the deliberate link keeps its reference.
test('a bare address that is the same target as a deliberate link is left as typed and never silent (in the site\'s normalised form)', () => {
  assert.equal(N.normalizeLinkAddress('https://www.Bob.example:443/p/1/?ref=x#f'), 'bob.example/p/1');
  assert.equal(N.normalizeLinkAddress('http://bob.example:8080/a%7eb%2F/'), 'bob.example:8080/a~b%2F');
  assert.equal(N.normalizeLinkAddress('javascript:alert(1)'), null);
  for (const [words, link] of [['See https://bob.example/p/1?ref=x and [Bobs post](https://bob.example/p/1).', 'https://bob.example/p/1'],
    ['See http://www.bob.example/p/1/ and <https://bob.example/p/1>.', 'https://bob.example/p/1']]) {
    const p = webPage([{ id: 't1', quote: '', msgs: [mine(words)] }]);
    const r = make(p, p.threads);
    assert.ok(r.ok, r.error);
    const body = r.text.split('\n---\n').slice(1).join('');
    assert.ok(!/blyg_silent_links/.test(r.text), words);
    assert.ok(!/<https?:\/\/(www\.)?bob\.example\/p\/1(\?ref=x|\/)>/.test(body), 'the bare address is left as typed: ' + body);
    assert.ok(body.includes(link), words);
  }
  // in another comment of the same post, too
  const p2 = webPage([{ id: 't1', quote: '', msgs: [mine('See https://bob.example/p/1?ref=x here.'), { ...mine('And [Bobs post](https://bob.example/p/1).'), ts: '2026-11-22T10:05:00Z' }] }]);
  const r2 = make(p2, p2.threads);
  assert.ok(r2.ok && !/blyg_silent_links/.test(r2.text) && /See https:\/\/bob\.example\/p\/1\?ref=x here\./.test(r2.text), r2.text);
});

// item 5: when in doubt the text is left as typed
test('a bare address in link syntax with spaces, in an indented code block, or holding a character reference is left as typed', () => {
  for (const t of ['[x]( https://a.example/ )', '[x](\n https://a.example/ )', 'Para.\n\n    https://code.example/x', '\thttps://tab.example/x',
    'see https://a.example/?q=&lt;b&gt; here', 'see https://a.example/&amp;x', 'see https://a.example/&#x41;']) {
    assert.deepEqual(N.linkBareUrls(t), { text: t, urls: [] }, t);
  }
});

// item 8: a passage keeps its form across an edit. A published post's legacy passage is written again in the legacy form (the same
// text, no `format`), so its item document does not change; a new passage is markdown; a move is only through formatMove.
test('a passage keeps its form across an edit: legacy stays legacy unless the move is asked for', () => {
  assert.deepEqual(N.AGENT_TEXT_FORMATS, ['legacy', 'markdown']);
  assert.equal(N.formatMove('legacy', 'markdown'), 'markdown');
  assert.equal(N.formatMove('markdown', 'markdown'), 'markdown');
  assert.throws(() => N.formatMove('markdown', 'legacy'), /cannot move/);
  assert.throws(() => N.formatMove('legacy', 'html'), /unknown/);
  const g = { instruction: 'say hello', mode: 'filled-by-agent', agent: 'claude', model: 'claude-opus-5', at: '2026-11-24T10:00:00Z', text: '- **one**\n- two' };
  const page = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Intro\n/tk say hello\nAfter'), gaps: [g] }] }]);
  // as it was published before the markdown form existed (the escaped text, no format)
  const legacyScope = N.agentScope(g, { block: true, format: 'legacy' });
  assert.match(legacyScope, /\\- \\\*\\\*one\\\*\\\*/);
  const before = `---\ntitle: "x"\nblyg_generated:\n  - model: "claude-opus-5"\n    at: 2026-11-24T10:00:00Z\n---\nIntro\n\n${legacyScope}\n\nAfter\n`;
  const generated = [{ model: 'claude-opus-5', at: '2026-11-24T10:00:00Z' }];
  const edited = N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', before, generated } });
  assert.ok(edited.ok, edited.error);
  assert.ok(edited.text.includes(`\n${legacyScope}\n`), 'the legacy passage is written exactly as before: ' + edited.text);
  assert.ok(!/format:/.test(edited.text), 'and stays legacy');
  const moved = N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', before, generated, moveFormat: 'markdown' } });
  assert.ok(moved.text.includes('[=]- **one**\n- two[/TK]') && /format: markdown/.test(moved.text), 'moved on purpose: converted and labelled together');
  const fresh = make(page, page.threads);
  assert.ok(/format: markdown/.test(fresh.text) && fresh.text.includes('[=]- **one**\n- two[/TK]'), 'a new passage is markdown');
});

// RE-CHECK 2026-11-26, item 3: deliberate links whose address holds a bar or parentheses are read whole (balanced parentheses), so
// a bare address beside them is the same target and is left as typed; an address the writer cannot normalise leaves every bare
// address of the post as typed.
test('a deliberate link with a bar or parentheses is read whole; an address that cannot be normalised leaves the post\'s bare addresses as typed', () => {
  assert.deepEqual(N.explicitLinks('See [Bob](https://bob.example/p/(1)) and [B2](<https://b.example/x y>) and [B3](https://c.example/a_(b)_c "t")'),
    ['https://bob.example/p/(1)', 'https://b.example/x y', 'https://c.example/a_(b)_c']);
  for (const words of ['See [Bob](https://bob.example/p?a=b|c) and https://bob.example/p again',
    'See [Bob](https://bob.example/p/(1)) and https://bob.example/p/(1) again']) {
    const p = webPage([{ id: 't1', quote: '', msgs: [mine(words)] }]);
    const r = make(p, p.threads);
    assert.ok(r.ok, r.error);
    assert.ok(!/blyg_silent_links/.test(r.text), words + '\n' + r.text);
    assert.ok(!/<https:\/\/bob\.example\/p/.test(r.text.split('\n---\n').slice(1).join('')), 'left as typed: ' + r.text);
  }
  const odd = webPage([{ id: 't1', quote: '', msgs: [mine('See [odd](https://bob.example/%zz) and https://other.example/x here')] }]);
  const r = make(odd, odd.threads);
  assert.ok(!/blyg_silent_links/.test(r.text) && /and https:\/\/other\.example\/x here/.test(r.text), 'when in doubt, nothing is made clickable: ' + r.text);
});

// item 4: a passage's form is read from the front matter by a real YAML parser (handed in: the companion asks Ruby's Psych) and
// matched by POSITION; when it cannot be told, the edit is refused with a plain sentence instead of a guess.
test('passage forms come from parsed front matter, by position; an edit that cannot tell them is refused', () => {
  const g = (instruction, text) => ({ instruction, mode: 'filled-by-agent', agent: 'claude', text });
  const page = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Intro\n/tk same\nMiddle\n/tk same\nAfter'), gaps: [g('same', '**a**'), g('same', '**b**')] }] }]);
  const fresh = make(page, page.threads);
  const before = fresh.text;
  // the same two passages, the same instruction: forms by position, and a mixed pair keeps each its own
  const mixed = { before, generated: [{}, { format: 'markdown' }] };
  const r = N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', ...mixed } });
  assert.ok(r.ok, r.error);
  const scopes = [...r.text.matchAll(/\[TK\] same \[=\]([\s\S]*?)\[\/TK\]/g)].map(m => m[1]);
  assert.deepEqual(scopes, ['\\*\\*a\\*\\*', '**b**'], 'first legacy, second markdown: by position, never swapped');
  // whatever YAML shape the entries came in, they arrive parsed: the forms are read from the values
  assert.deepEqual(N.formsFromGenerated([{ format: 'markdown' }, null, {}, { model: 'm', format: 'markdown' }]), ['markdown', 'legacy', 'legacy', 'markdown']);
  // fewer entries than passages: a missing entry is legacy, as the site reads it
  const short = N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', before, generated: [{ format: 'markdown' }] } });
  assert.deepEqual([...short.text.matchAll(/\[TK\] same \[=\]([\s\S]*?)\[\/TK\]/g)].map(m => m[1]), ['**a**', '\\*\\*b\\*\\*']);
  // a passage added while a legacy one is there: every legacy passage moves to markdown with this edit (see the test below)
  const three = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Intro\n/tk same\nMiddle\n/tk same\nMore\n/tk other\nAfter'), gaps: [g('same', '**a**'), g('same', '**b**'), g('other', 'c')] }] }]);
  const grown = N.renderShortNote({ page: three, threads: three.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', ...mixed } });
  assert.ok(grown.ok && grown.formsMoved && (grown.text.match(/format: markdown/g) || []).length === 3, grown.error);
  const allMd = N.renderShortNote({ page: three, threads: three.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', before, generated: [{ format: 'markdown' }, { format: 'markdown' }] } });
  assert.ok(allMd.ok && (allMd.text.match(/format: markdown/g) || []).length === 3, 'all markdown before: every passage stays markdown');
  for (const bad of [{ generated: 'not a list' }, { generated: [{ format: 'html' }] }, { generated: null, unreadable: 'the front matter could not be read' }]) {
    const x = N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', before, ...bad } });
    assert.equal(x.ok, false, JSON.stringify(bad));
    assert.match(x.error, /agent passages? .*cannot be told|could not be read/, JSON.stringify(bad));
  }
});

rb('blyg-run reads a published note\'s blyg_generated with a real YAML parser, in every shape; unreadable front matter is said, not guessed', async () => {
  const { generatedOf } = await import('../blyg-run.mjs');
  const shapes = {
    'unindented list, trailing comment': '---\nblyg_generated:\n- model: m   # a comment\n  format: markdown\n- model: n\n---\nx',
    'inline list of flow maps': '---\nblyg_generated: [{format: markdown}, {model: n}]\n---\nx',
    'dash then newline': '---\nblyg_generated:\n  -\n    format: markdown\n  -\n    model: n\n---\nx',
    'quoted value': '---\nblyg_generated:\n  - format: "markdown"\n  - {}\n---\nx',
  };
  for (const [name, note] of Object.entries(shapes)) {
    assert.deepEqual(N.formsFromGenerated(generatedOf(note).generated), ['markdown', 'legacy'], name);
  }
  assert.deepEqual(generatedOf('---\ntitle: x\n---\nbody'), { generated: [] }, 'no key: no entries (every passage legacy, as the site reads it)');
  assert.ok(generatedOf('---\nblyg_generated: [\n---\nx').unreadable);
  assert.ok(generatedOf('no front matter').unreadable);
});

// RE-CHECK 2, the owner's ordinary edit ("add to earlier post", the Hub): when the passages of a post that holds a legacy one change in
// number or order, every legacy passage moves to markdown through formatMove with that edit (text and label together, the text the
// agent wrote, or the owner's own edit of it), so position no longer matters; the edit is never refused for it.
test('adding, removing or reordering passages moves every legacy passage to markdown with the edit, from its original text', () => {
  const g = (instruction, text, mode = 'filled-by-agent') => ({ instruction, mode, agent: 'claude', model: 'm', at: '2026-11-24T10:00:00Z', text });
  const one = g('one', '- **first** point\n- second');
  const two = g('two', '*two* words');
  const legacyNote = (gaps) => {
    const scopes = gaps.map(x => N.agentScope(x, { block: true, format: 'legacy' }));
    return { before: `---\ntitle: "x"\nblyg_generated:\n${gaps.map(() => '  - model: "m"\n    at: 2026-11-24T10:00:00Z').join('\n')}\n---\nIntro\n\n${scopes.join('\n\nMid\n\n')}\n\nAfter\n`,
      generated: gaps.map(() => ({ model: 'm', at: '2026-11-24T10:00:00Z' })) };
  };
  const edit = (text, gaps, published) => {
    const page = webPage([{ id: 't1', quote: '', msgs: [{ ...mine(text), gaps }] }]);
    return N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', ...published } });
  };
  const scopesOf = t => [...t.matchAll(/\[TK\] (\w+) \[=\]([\s\S]*?)\[\/TK\]/g)].map(m => [m[1], m[2]]);
  const allMarkdown = (r, n) => { assert.ok(r.ok, r.error); assert.equal((r.text.match(/format: markdown/g) || []).length, n, r.text); assert.ok(r.formsMoved); };
  // a passage added BEFORE the legacy one
  let r = edit('Intro\n/tk new\nMid\n/tk one\nAfter', [g('new', 'brand **new**'), one], legacyNote([one]));
  allMarkdown(r, 2);
  assert.deepEqual(scopesOf(r.text), [['new', 'brand **new**'], ['one', '- **first** point\n- second']], 'the text the agent wrote, not the escaped form');
  // a passage removed AFTER the legacy one
  r = edit('Intro\n/tk one\nAfter', [one], legacyNote([one, two]));
  allMarkdown(r, 1);
  assert.deepEqual(scopesOf(r.text), [['one', '- **first** point\n- second']]);
  // two legacy passages reordered
  r = edit('Intro\n/tk two\nMid\n/tk one\nAfter', [two, one], legacyNote([one, two]));
  allMarkdown(r, 2);
  assert.deepEqual(scopesOf(r.text), [['two', '*two* words'], ['one', '- **first** point\n- second']]);
  // a legacy passage the owner edited by hand keeps the owner's edit (and says so)
  const mineEdit = g('one', 'My **own** words now', 'edited-by-reader');
  r = edit('Intro\n/tk new\nMid\n/tk one\nAfter', [g('new', 'n'), mineEdit], legacyNote([mineEdit]));
  allMarkdown(r, 2);
  assert.deepEqual(scopesOf(r.text)[1], ['one', 'My **own** words now']);
  assert.match(r.text, /edited_by_author: true/);
  // nothing added, removed or moved: the legacy passage stays legacy, as published
  r = edit('Intro\n/tk one\nMid\n/tk two\nAfter', [one, two], legacyNote([one, two]));
  assert.ok(r.ok && !r.formsMoved && !/format:/.test(r.text), r.text);
  assert.equal(N.FORMS_MOVED_SAY, 'Older agent passages in this post will now show their formatting.');
});

test('the publish box is told when an edit moves older passages (the run view carries forms_moved)', async () => {
  const { viewOf } = await import('../blyg-run.mjs');
  assert.equal(viewOf({ mode: 'drafted', forms_moved: true }).forms_moved, true);
  assert.equal(viewOf({ mode: 'drafted' }).forms_moved, false);
  const fs = await import('node:fs');
  assert.ok(fs.readFileSync(new URL('../extension/drawer.js', import.meta.url), 'utf8').includes("run.forms_moved === true ? `<p class=\"pubquiet\">${esc('Older agent passages in this post will now show their formatting.')}"));
});

// RE-CHECK 3: the companion runs as a launch agent; `ruby` on its PATH may be the system's (Ruby 2.6, Psych 3.1). The reader works
// there too; it runs in the site's own folder (so the site's .ruby-version applies when there is one); a Ruby that is missing or fails
// for any reason but unreadable YAML is said plainly, and the new version is not written.
test('generatedOf works under the system Ruby 2.6 too, in the site\'s folder; no Ruby is said plainly', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const { generatedOf, RUBY_NEEDED_SAY } = await import('../blyg-run.mjs');
  const note = '---\nreleased: "2026-11-26"\nblyg_generated:\n  - model: "claude-x"\n    at: 2026-11-26T08:27:04Z\n    format: markdown\n  - model: m\n---\nbody';
  const rubies = ['ruby', ...(fs.existsSync('/usr/bin/ruby') ? ['/usr/bin/ruby'] : [])];
  for (const ruby of rubies) {
    const r = generatedOf(note, { ruby });
    assert.deepEqual(N.formsFromGenerated(r.generated), ['markdown', 'legacy'], ruby);
    assert.ok(generatedOf('---\nblyg_generated: [\n---\nx', { ruby }).unreadable, `${ruby}: bad YAML is unreadable, not "Ruby is needed"`);
    assert.ok(generatedOf('---\nblyg_generated: *a\n---\nx', { ruby }).unreadable, `${ruby}: an alias is refused as YAML`);
  }
  assert.deepEqual(generatedOf(note, { ruby: '/nonexistent/ruby' }), { refusal: RUBY_NEEDED_SAY });
  assert.match(RUBY_NEEDED_SAY, /^Ruby is needed to read this post's agent passages/);
  // the cwd is the site's folder: a .ruby-version there is honoured by a version manager's shim
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'blyg-site-'));
  assert.deepEqual(N.formsFromGenerated(generatedOf(note, { cwd: dir }).generated), ['markdown', 'legacy']);
  // the refusal reaches the owner as that sentence
  const page = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Intro\n/tk go\nAfter'), gaps: [{ instruction: 'go', mode: 'filled-by-agent', agent: 'claude', text: 't' }] }] }]);
  const r = N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', keep: { created: '2026-11-23', released: '2026-11-23', before: note, refusal: RUBY_NEEDED_SAY } });
  assert.deepEqual([r.ok, r.error], [false, RUBY_NEEDED_SAY]);
});

// PROMPTS: the post's choice (PROMPT_MODES: locked | shown, one field), written by the note writer as `blyg_prompts` when the post has
// an agent passage; the site then shows each passage's prompt on the post's page only (or nowhere, locked: the default).
test('prompts: the note writer writes the one field when there is an agent passage; locked by default; an unknown choice is refused', () => {
  assert.deepEqual(N.PROMPT_MODES, ['locked', 'shown']);
  assert.equal(N.DEFAULT_PROMPTS, 'locked');
  assert.equal(N.promptsMove('locked', 'shown'), 'shown');
  assert.equal(N.promptsMove('shown', 'locked'), 'locked');
  assert.throws(() => N.promptsMove('locked', 'open'), /unknown/);
  const gap = { instruction: 'say hello', mode: 'filled-by-agent', agent: 'claude', text: 'Hello.' };
  const withPassage = webPage([{ id: 't1', quote: '', msgs: [{ ...mine('Intro\n/tk say hello\nAfter'), gaps: [gap] }] }]);
  const plain = webPage([thread('t1', '', 'Only my words.')]);
  const front = r => r.text.split('\n---\n')[0];
  const run = (page, prompts) => N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug: 's', ...(prompts === undefined ? {} : { prompts }) });
  assert.match(front(run(withPassage, 'shown')), /\nblyg_prompts: shown$/m);
  assert.match(front(run(withPassage, 'locked')), /\nblyg_prompts: locked$/m);
  assert.match(front(run(withPassage)), /\nblyg_prompts: locked$/m, 'default locked');
  assert.ok(!/blyg_prompts/.test(run(plain, 'shown').text), 'no agent passage: nothing to show, no field');
  const bad = run(withPassage, 'open');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /prompts/);
});

test('prompts: the drawer has the one checkbox, remembered, sent with every press; the press carries it through the queue', () => {
  const drawer = fs.readFileSync(new URL('../extension/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes('Show my prompts with this post'));
  assert.ok(/data-act="pub-prompts"/.test(drawer));
  assert.ok(/writeKey\('blygPrompts'/.test(drawer) && /readKey\('blygPrompts'/.test(drawer), 'remembered');
  assert.ok(/prompts: promptsNow/.test(drawer), 'sent with the press');
  const config = fs.readFileSync(new URL('../extension/config.js', import.meta.url), 'utf8');
  assert.ok(/body: \[[^\]]*'prompts'/.test(config), 'a field of the start request');
});

test('prompts: a new version that changes only the prompts choice is told apart (the site makes no new version of the item for it)', async () => {
  const { promptsOnlyChange } = await import('../blyg-run.mjs');
  const a = '---\ntitle: "x"\nblyg_prompts: locked\n---\nBody\n';
  assert.equal(promptsOnlyChange(a, a.replace('locked', 'shown')), true);
  assert.equal(promptsOnlyChange(a, a), false, 'nothing changed is not a change');
  assert.equal(promptsOnlyChange(a, a.replace('locked', 'shown').replace('Body', 'Body, edited')), false);
  assert.equal(promptsOnlyChange('---\ntitle: "x"\n---\nBody\n', a.replace('locked', 'shown')), true, 'an older note without the field');
  assert.equal(promptsOnlyChange('---\ntitle: "x"\n---\nBody\n', a), false, 'the default written out is no change');
});

test('prompts: a note\'s own facts for the drawer (its choice, absent = locked; whether it holds an agent passage)', () => {
  assert.deepEqual(N.promptsFactsOf('---\ntitle: x\nblyg_prompts: shown\n---\nWords.\n\n[TK] go [=]text[/TK]\n'), { prompts: 'shown', agent_text: true });
  assert.deepEqual(N.promptsFactsOf('---\ntitle: x\n---\nWords.\n\n[TK]impyrt=pasted[/TK]\n'), { prompts: 'locked', agent_text: true });
  assert.deepEqual(N.promptsFactsOf('---\ntitle: x\nblyg_prompts: odd\n---\nWords only.\n'), { prompts: 'locked', agent_text: false });
});

test('prompts in the drawer: the box is drawn for the RESULTING post, starts from that post\'s own choice, and sends nothing when not drawn', () => {
  const drawer = fs.readFileSync(new URL('../extension/drawer.js', import.meta.url), 'utf8');
  assert.ok(!/blyg_published\.prompts|blyg_published && t\.blyg_published\.prompts/.test(drawer), 'never from the page record');
  assert.ok(/const promptsNow = pubPromptsOffered\(\) \? D\.pub\.prompts : ''/.test(drawer) && /prompts: promptsNow/.test(drawer), 'no box: no choice sent');
  assert.ok(drawer.includes('Prompts become public on your site.'));
  assert.ok(/function pubPromptsOffered/.test(drawer) && /pubAbove\(/.test(drawer.slice(drawer.indexOf('function pubPromptsOffered'), drawer.indexOf('function pubPromptsOffered') + 1500)), 'the threads above count');
  const run = fs.readFileSync(new URL('../blyg-run.mjs', import.meta.url), 'utf8');
  assert.ok(!/prompts_only/.test(run), 'no unread flag');
});
