// ownership.test.mjs — who owns a blog post's words (ownership.mjs), the
// figure-editor routing (figedits.mjs, POST /fte-route), and the backstop at
// turn-end in direct-edit mode.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as O from '../ownership.mjs';
import * as F from '../figedits.mjs';
import * as suggest from '../suggest.mjs';
import * as collateral from '../collateral.mjs';
import * as blog from '../blog.mjs';
import { createHarness, POST, GET, inputs } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { plainOf } = createRequire(import.meta.url)('../extension/anchor.js');
const h = createHarness({ server: path.join(here, '../server.mjs'), tag: 'ownership', realpath: true, waitMs: 15000 });
const { test, tmp, waitFor } = h;

const POST_MD = `---
title: My post
created: 2026-11-01
tags: [essays]
---

The first paragraph says energy. EpochAI forecasts growth at five times the rate.

Second paragraph is here, and it is mine. Agent check: is this date right?

> [!note] Agent check: is "five times" right?
> I think it is four.

> [!tip] Answer: yes, five
> Written by a bot.

> A plain quote the owner chose.

Last words.
`;
const bot = (base, steps) => O.plan(base, steps.map(t => ({ text: t, by: 'bot' })));

// ---- the matcher -----------------------------------------------------------
await test('the callout matcher accepts any `> [!type]` head the site renders, and nothing else', () => {
  for (const ok of ['> [!note] Agent check: is "five times" right?', '> [!warning]- How the date was found',
    '> [!tip] Answer: yes', '> [!challenge] AGENT CHECK: x', '> [!note My own title]', '> [!note]',
    '> [!note] Suggested wording', '> [!tip] Reading the chart', '> [!note] Is it five?']) {
    assert.ok(O.isCalloutHead(ok), ok);
  }
  for (const no of ['  > [!note] Agent check: indented', 'Agent check: in the prose', '> Agent check: a plain quote',
    '> A plain quote', '>[!tip] No space (the site shows a blockquote)', '[!note] no quote mark', '> [!] no type']) {
    assert.ok(!O.isCalloutHead(no), no);
  }
});

await test('blocks run to the first blank line; front matter and code fences are never blocks', () => {
  const src = '---\nnote: "> [!note] Agent check: no"\n---\n\n```\n> [!note] Agent check: code\n```\n\n> [!tip] Answer: yes\n> body\nlazy line\n\n> plain quote\n\nprose\n';
  const b = O.calloutBlocks(src);
  assert.equal(b.length, 1);
  assert.equal(src.slice(b[0].start, b[0].end), '> [!tip] Answer: yes\n> body\nlazy line');
});

// ---- the backstop, as a plan ---------------------------------------------------
await test('a callout edit stays; a prose edit is put back and becomes a card', () => {
  const after = POST_MD.replace('I think it is four.', 'Checked: it is five.')
    .replace('and it is mine.', 'and it is the bot’s now.');
  const p = bot(POST_MD, [after]);
  assert.match(p.result, /Checked: it is five\./, 'the callout edit stays');
  assert.match(p.result, /and it is mine\./, 'the prose is put back');
  assert.equal(p.cards.length, 1);
  assert.match(p.cards[0].current, /it is mine\./);
  assert.match(p.cards[0].proposed, /the bot’s now/);
  assert.equal(p.cards[0].ambiguous, false);
  assert.equal(p.calloutText, undefined, 'no marker text: a callout change leaves no trace');
  // and the card applies to the file as it now stands
  assert.equal(suggest.resolveSpan(p.result, p.cards[0].current).ok, true);
});

await test('a callout with any title is the bots’: edit, add one between paragraphs, or remove one', () => {
  const edited = bot(POST_MD, [POST_MD.replace('Written by a bot.', 'Rewritten by a bot.').replace('Answer: yes, five', 'Answer: yes, it is five')]);
  assert.equal(edited.changed, false);
  assert.match(edited.result, /Rewritten by a bot\./);
  const added = POST_MD.replace('Last words.', '> [!warning] How the year was found\n> 2026, from the filing.\n\nLast words.');
  const p1 = bot(POST_MD, [added]);
  assert.equal(p1.changed, false);
  assert.equal(p1.cards.length, 0);
  const removed = POST_MD.replace('> [!note] Agent check: is "five times" right?\n> I think it is four.\n\n', '');
  const p2 = bot(POST_MD, [removed]);
  assert.equal(p2.changed, false);
  assert.equal(p2.cards.length, 0);
});

await test('a sentence slipped between two of the owner’s sentences becomes a card', () => {
  const after = POST_MD.replace('energy. EpochAI', 'energy. That is the joining sentence. EpochAI');
  const p = bot(POST_MD, [after]);
  assert.equal(p.result, POST_MD);
  assert.equal(p.cards.length, 1);
  const c = p.cards[0];
  assert.ok(!c.current.includes('joining') && c.proposed.includes('That is the joining sentence.'));
  assert.equal(c.proposed.replace('That is the joining sentence. ', ''), c.current);
});

await test('a callout dropped INTO the middle of a paragraph is not callout territory', () => {
  const after = POST_MD.replace('energy. EpochAI', 'energy.\n\n> [!note] Agent check: source?\n\nEpochAI');
  const p = bot(POST_MD, [after]);
  assert.equal(p.result, POST_MD);
  assert.equal(p.cards.length, 1);
});

await test('front matter, the owner’s plain quote, and their inline "agent check" prompt are theirs', () => {
  const fm = bot(POST_MD, [POST_MD.replace('title: My post', 'title: A better post')]);
  assert.equal(fm.result, POST_MD);
  assert.match(fm.cards[0].current, /title: My post/);
  const quote = bot(POST_MD, [POST_MD.replace('> A plain quote the owner chose.', '> A plain quote the bot chose.')]);
  assert.equal(quote.result, POST_MD, 'a plain blockquote (no [!type]) is the owner’s');
  assert.equal(quote.cards.length, 1);
  const promote = bot(POST_MD, [POST_MD.replace('> A plain quote the owner chose.', '> [!note] A plain quote the owner chose.')]);
  assert.equal(promote.result, POST_MD, 'turning the owner’s quote into a callout is a change to their text');
  const prompt = bot(POST_MD, [POST_MD.replace(' Agent check: is this date right?', '')]);
  assert.equal(prompt.result, POST_MD);
  assert.equal(prompt.cards.length, 1);
  assert.equal(prompt.cards[0].deletes, undefined, 'context keeps the card from being a bare cut');
});

await test('the owner typing during the turn always survives', () => {
  const b = POST_MD.replace('and it is mine.', 'and it belongs to the bot.');
  // 1. a user edit elsewhere, after the bot's
  const u = b.replace('Last words.', 'Last words, typed in Obsidian.');
  const p1 = O.plan(POST_MD, [{ text: b, by: 'bot' }, { text: u, by: 'user' }]);
  assert.match(p1.result, /typed in Obsidian/);
  assert.match(p1.result, /and it is mine\./);
  assert.equal(p1.cards.length, 1);
  // 2. the user edits the very words the bot changed: their text wins, no hold
  const u2 = b.replace('and it belongs to the bot.', 'and it is still mine, says me.');
  const p2 = O.plan(POST_MD, [{ text: b, by: 'bot' }, { text: u2, by: 'user' }]);
  assert.match(p2.result, /still mine, says me/);
  assert.equal(p2.cards.length, 0);
  // 3. the user first, then the bot rewrites what they just typed: the user's
  //    text stays and the bot's becomes a card
  const u3 = POST_MD.replace('Second paragraph is here', 'Second paragraph is right here');
  const b3 = u3.replace('Second paragraph is right here, and it is mine.', 'Second paragraph, rewritten.');
  const p3 = O.plan(POST_MD, [{ text: u3, by: 'user' }, { text: b3, by: 'bot' }]);
  assert.match(p3.result, /right here, and it is mine\./);
  assert.equal(p3.cards.length, 1);
  assert.match(p3.cards[0].proposed, /rewritten/);
  // 4. the bot's later write that silently drops the user's edit (it wrote
  //    from a stale read): the user's edit is restored
  const p4 = O.plan(POST_MD, [{ text: u3, by: 'user' }, { text: POST_MD, by: 'bot' }]);
  assert.match(p4.result, /right here/);
});

await test('a card widens until its passage is unique', () => {
  const src = 'Alpha. The same words here.\n\nBeta. The same words here.\n';
  const p = bot(src, [src.replace('Beta. The same words here.', 'Beta. The same words there.')]);
  assert.equal(p.cards.length, 1);
  assert.equal(p.cards[0].ambiguous, false);
  assert.equal(suggest.resolveSpan(p.result, p.cards[0].current).ok, true);
});

await test('several changes in one paragraph are ONE card', () => {
  const after = POST_MD.replace('The first paragraph says', 'The opening paragraph says').replace('five times', 'six times');
  const p = bot(POST_MD, [after]);
  assert.equal(p.cards.length, 1);
});

// ---- the owner's own ✎ on prose ---------------------------------------------
await test('own-prose edits: unique spans are written, everything else goes to the bots', () => {
  const src = '---\ntitle: T\n---\n\nThe [International Energy Agency](https://iea.org) says demand grows.\n\nIt grows. It grows fast.\n\nOnce here. Twice here. It grows.\n\n> [!note] Agent check: demand?\n> demand grows\n';
  const ok = O.proseEdit(src, { original: 'demand grows.', replacement: 'demand rises.' }, plainOf);
  assert.equal(ok.ok, true);
  assert.match(ok.after, /says demand rises\./);
  assert.match(ok.after, /> demand grows/, 'never inside a callout');
  const link = O.proseEdit(src, { original: 'International Energy Agency says', replacement: 'IEA says' }, plainOf);
  assert.equal(link.ok, false); assert.equal(link.reason, 'not-found');
  const amb = O.proseEdit(src, { original: 'It grows.', replacement: 'It rises.' }, plainOf);
  assert.equal(amb.ok, false); assert.equal(amb.reason, 'ambiguous');
  const narrowed = O.proseEdit(src, { original: 'It grows.', replacement: 'It rises.', block: 'Once here. Twice here. It grows.' }, plainOf);
  assert.equal(narrowed.ok, true, 'the rendered block picks the one paragraph');
  assert.match(narrowed.after, /Twice here\. It rises\./);
  assert.match(narrowed.after, /It grows\. It grows fast\./);
  const fm = O.proseEdit(src, { original: 'title: T', replacement: 'title: U' }, plainOf);
  assert.equal(fm.ok, false); assert.equal(fm.reason, 'outside-body');
  const gone = O.proseEdit(ok.after, { original: 'demand grows.', replacement: 'demand rises.' }, plainOf);
  assert.equal(gone.reason, 'already', 'a retry of an applied edit writes nothing');
});

await test('a NEW paragraph goes after the one paragraph it follows, with a blank line; anything unclear goes to the bots', () => {
  const src = '---\ntitle: T\n---\n\nThe [International Energy Agency](https://iea.org) says demand grows.\n\nIt grows.\n\nIt grows.\n\n> [!note] Agent check\n> demand grows\n\n## A heading\n\nLast one.\n';
  const ok = O.paragraphInsert(src, { after: 'The International Energy Agency says demand grows.', text: 'My new thought.' }, plainOf);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(ok.after, /says demand grows\.\n\nMy new thought\.\n\nIt grows\./, 'right after it, blank lines both sides');
  assert.equal(ok.after.replace('\n\nMy new thought.', ''), src, 'nothing else moved');
  const two = O.paragraphInsert(src, { after: 'Last one.', text: 'Tail A.\n\nTail B.' }, plainOf);
  assert.equal(two.after, src + '\nTail A.\n\nTail B.\n'.replace(/^\n/, '\n'), 'at the end of the file, several paragraphs');
  assert.ok(two.after.endsWith('Last one.\n\nTail A.\n\nTail B.\n'));
  const amb = O.paragraphInsert(src, { after: 'It grows.', text: 'x' }, plainOf);
  assert.equal(amb.reason, 'ambiguous');
  const callout = O.paragraphInsert(src, { after: 'demand grows', text: 'x' }, plainOf);
  assert.equal(callout.ok, false, 'never after a callout line');
  const heading = O.paragraphInsert(src, { after: 'A heading', text: 'x' }, plainOf);
  assert.equal(heading.ok, false); assert.equal(heading.reason, 'outside-body');
  const none = O.paragraphInsert(src, { after: 'Not in the post.', text: 'x' }, plainOf);
  assert.equal(none.reason, 'not-found');
  // the paragraph was edited in the same batch: the original wording finds it
  const orig = O.paragraphInsert(src, { after: 'Last one, edited.', after_original: 'Last one.', text: 'Z.' }, plainOf);
  assert.equal(orig.ok, true);
  assert.equal(O.paragraphInsert(ok.after, { after: 'The International Energy Agency says demand grows.', text: 'My new thought.' }, plainOf).reason,
    'already', 'a retry finds it written');
  assert.equal(O.paragraphInsert(src, { after: 'Last one.', text: '  ' }, plainOf).reason, 'empty');
  assert.equal(F.badEdit({ edit_id: 'p', kind: 'paragraph', original: '', replacement: ' ' }), 'a new paragraph is empty');
  assert.match(F.checklist({ batch_id: 'fte-x', edits: [{ edit_id: 'p', kind: 'paragraph', original: '', replacement: 'New words.',
    figure: { id: 'page-text', title: 'Page text' }, source: { after_block: 'It grows fast.' } }] }, []),
  /new paragraph.*add after the paragraph ending “…It grows fast\.”, with a blank line between: “New words\.”/s);
});

await test('an INSERTION (the new words contain the old) is written once; a retry finds it already there', () => {
  const src = 'Intro.\n\nThere will be strong implications on the future of humanity.\n\nEnd.\n';
  const edit = { original: 'There will be strong implications on the future of humanity.',
    replacement: 'There will be strong implications on the future of humanity. While I am sure they will get built, I want the reasons first.' };
  const one = O.proseEdit(src, edit, plainOf);
  assert.equal(one.ok, true);
  const two = O.proseEdit(one.after, edit, plainOf);
  assert.equal(two.ok, false, 'the old words still match inside the new ones — but the edit is done');
  assert.equal(two.reason, 'already');
  // a prefix insertion too
  const pre = { original: 'End.', replacement: 'Thanks for reading. End.' };
  const p1 = O.proseEdit(one.after, pre, plainOf);
  assert.equal(p1.ok, true);
  assert.equal(O.proseEdit(p1.after, pre, plainOf).reason, 'already');
  // …while the same words elsewhere, NOT inside the replacement, still get the edit
  const twice = 'Go on.\n\nGo on. And on.\n';
  const r = O.proseEdit(twice, { original: 'Go on.', replacement: 'Go on. And on.', block: 'Go on.' }, plainOf);
  assert.equal(r.ok, true, 'the one occurrence not already expanded is the one edited');
  assert.equal(r.after, 'Go on. And on.\n\nGo on. And on.\n');
});

await test('collateral opens no thread for a change inside a callout, and still does for prose', () => {
  const before = 'Prose one here, long enough to anchor.\n\n> [!tip] Answer: yes\n> It is five times.\n\nProse two here, long enough to anchor.\n';
  const afterC = before.replace('It is five times.', 'It is six times, per the filing.');
  const afterP = before.replace('Prose two here', 'Prose two, rewritten here');
  const callouts = (a, b) => ({ before: blog.calloutPlains(a, 'p.md'), after: blog.calloutPlains(b, 'p.md') });
  const c = collateral.collateral(blog.mdDoc(before), blog.mdDoc(afterC), { threads: [] }, { callouts: callouts(before, afterC) });
  assert.equal(c.threads.length, 0, JSON.stringify(c.threads));
  assert.ok(c.skipped.some(x => x.callout));
  const p = collateral.collateral(blog.mdDoc(before), blog.mdDoc(afterP), { threads: [] }, { callouts: callouts(before, afterP) });
  assert.equal(p.threads.length, 1);
  const added = before.replace('Prose two', '> [!note] Agent check: new?\n> A whole new callout.\n\nProse two');
  const a = collateral.collateral(blog.mdDoc(before), blog.mdDoc(added), { threads: [] }, { callouts: callouts(before, added) });
  assert.equal(a.threads.length, 0, 'a whole new callout opens no thread either');
});

// ---- the batch as a file ------------------------------------------------------
await test('the checklist lists every item with its locator; the chat summary names the file', () => {
  const batch = { batch_id: 'fte-20261106T1200-0000abcd', page: { title: 'A post', url: 'http://localhost:4000/a/' },
    edits: [
      { edit_id: 'e1', kind: 'text', figure: { id: 'page-text', title: 'Page text' }, element: { kind: 'html-text' },
        source: { file: '_notes/a.md', locator: 'paragraph', block: 'The IEA says' }, original: 'IEA', replacement: 'Agency' },
      { edit_id: 'e2', kind: 'comment', note: 'make this bar orange', figure: { id: 'fig', title: 'Figure', generator: 'gen.py', exports: ['f.html'] },
        element: { kind: 'element', tag: 'rect', selector: ':scope > *:nth-child(2)', path: 'svg > rect', anchor_id: 'bar-3' },
        context: { step: 2, of: 5 }, source: { file: 'gen.py', locator: 'bars' } },
      { edit_id: 'e3', kind: 'comment', note: 'circle the peak', figure: { id: 'page-picture', title: 'Chart', kind: 'raster' },
        element: { kind: 'raster', tag: 'img', src: '/assets/c.png' } },
      { edit_id: 'e4', kind: 'text', figure: { id: 'page-text', title: 'Page text' }, element: {}, source: {}, original: 'a', replacement: 'b' },
    ] };
  const routes = [{ edit_id: 'e1', to: 'bots', reason: 'not-found', detail: 'inside a link' }, { edit_id: 'e2', to: 'bots' },
    { edit_id: 'e3', to: 'bots' }, { edit_id: 'e4', to: 'source' }];
  const md = F.checklist(batch, routes);
  assert.equal((md.match(/^- \[ \]/gm) || []).length, 3);
  assert.match(md, /- \[x\] .*“a” → “b”/);
  assert.match(md, /make this bar orange/);
  assert.match(md, /anchor #bar-3; selector `:scope > \*:nth-child\(2\)`/);
  assert.match(md, /generator: `gen.py`/);
  assert.match(md, /add an overlay\/annotation/);
  assert.match(md, /inside a link/);
  const sum = F.summary(batch, routes, { md: '/x/fte.md', json: '/x/fte.json' });
  assert.match(sum, /1 prose edit was written straight into the post/);
  assert.match(sum, /`\/x\/fte\.md`/);
  assert.ok(sum.length < 2000, 'the chat message stays short');
  const big = { ...batch, edits: Array.from({ length: 400 }, (_, i) => ({ edit_id: 'b' + i, kind: 'text', figure: { title: 'F' },
    element: {}, original: 'w' + i, replacement: 'W' + i })) };
  const s2 = F.summary(big, [], { md: 'm', json: 'j' });
  assert.match(s2, /…and 388 more in the checklist/);
  assert.equal(F.badEdit({ edit_id: 'x', original: 'a', replacement: 'b'.repeat(2001) }), 'an edit is longer than 2000 characters');
  assert.equal(F.badEdit({ edit_id: 'x', kind: 'comment', note: ' ' }), 'a comment has no note');
});

// ---- the backstop and the routing, through a real companion -----------------
const root = tmp('site');
const work = tmp('workspace');
const write = (base, rel, text) => {
  const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p;
};
write(root, '_config.yml', 'collections:\n  notes:\n    output: true\n    permalink: /:slug/\n');
write(root, 'Templates/baseline.md', '---\ntitle:\ncreated:\nreleased:\ntags:\nsubtitle:\n---\n');
const ORIGINAL = POST_MD.replace('tags: [essays]', 'tags: [essays]\npermalink: /my-post/\npublished: false');
const source = write(root, '_notes/my-post.md', ORIGINAL);
const web = http.createServer((req, res) => res.end('local preview'));
try {
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${web.address().port}`;
  const site = { root, kind: 'jekyll', serve_origin: origin };
  write(work, '.botference/plugin/config.json', JSON.stringify({ blog_sites: [site], blog_roots: { [root]: true }, blog_authoring_root: root }));
  const log = path.join(work, 'bridge.jsonl');
  const { base } = await h.startServer({ root: work, env: {
    PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(here, 'mock-bridge.mjs')]),
    MOCK_BRIDGE_LOG: log,
  } });
  const url = origin + '/my-post/';
  await POST(base, '/page', { url, title: 'My post' });
  const page = async () => (await GET(base, '/page?url=' + encodeURIComponent(url))).json;

  await test('the blog turn is told who owns what', async () => {
    const r = await POST(base, '/reply', { url, text: '@claude hello there' });
    assert.equal(r.json.queued, true);
    await waitFor(() => inputs(log).some(s => s.includes('hello there')), 'the turn');
    const turn = inputs(log).findLast(s => s.includes('hello there'));
    assert.match(turn, /WHO OWNS WHAT IN THIS POST/);
    assert.match(turn, /Callouts are YOURS/);
    assert.match(turn, /```suggest/);
    await waitFor(async () => (await page()).page_chat.some(m => m.author === 'claude'), 'the reply');
  });

  await test('turn-end: the callout edit stays with no marker, the prose edit is put back as a card', async () => {
    const edited = write(work, 'edit1.md', ORIGINAL.replace('I think it is four.', 'Checked: it is five.')
      .replace('energy. EpochAI', 'energy. A bot sentence in between. EpochAI').replace('title: My post', 'title: Bot title'));
    await POST(base, '/reply', { url, text: `@codex tidy the post [mock:copy:${edited}|${source}]` });
    await waitFor(async () => (await page()).page_chat.some(m => m.author === 'botference' && (m.suggestions || []).length), 'the cards');
    const now = fs.readFileSync(source, 'utf8');
    assert.match(now, /Checked: it is five\./, 'callout edit kept');
    assert.match(now, /title: My post/, 'front matter put back');
    assert.ok(!now.includes('A bot sentence in between'), 'the inserted sentence put back');
    assert.equal(now, ORIGINAL.replace('I think it is four.', 'Checked: it is five.'), 'nothing else moved');
    const p = await page();
    const holder = p.page_chat.find(m => m.author === 'botference' && (m.suggestions || []).length);
    assert.match(holder.text, /@codex edited your words in the post directly/);
    assert.equal(holder.suggestions.length, 2);
    assert.ok(!(p.marks || []).length, 'a callout change leaves no marker: ' + JSON.stringify(p.marks));
    assert.ok(!p.threads.some(t => t.auto), 'no collateral threads for the owner’s own post');
    // Accept all, against the current file
    const r = await POST(base, '/suggest-accept-all', { url, thread_id: '__page__', ts: holder.ts, author: holder.author });
    assert.equal(r.json.applied, 2, JSON.stringify(r.json));
    const after = fs.readFileSync(source, 'utf8');
    assert.match(after, /A bot sentence in between/);
    assert.match(after, /title: Bot title/);
    // …and the bot hears about it next turn
    await POST(base, '/reply', { url, text: '@claude what happened?' });
    await waitFor(() => inputs(log).some(s => s.includes('what happened?')), 'the next turn');
    assert.match(inputs(log).findLast(s => s.includes('what happened?')), /ACCEPTED/);
    // wait the turn out before putting the file back: a write DURING a turn
    // is a bot's write as far as the backstop knows
    await waitFor(async () => (await page()).page_chat.filter(m => m.author === 'claude').length >= 2, 'its reply');
    await new Promise(r => setTimeout(r, 600));
    fs.writeFileSync(source, ORIGINAL);
  });

  // The put-back is this post's machinery; another existing post the bots
  // wrote into is not put back (ownership.plan needs its turn-start text,
  // which only the page's own post has) — but it is never silent.
  await test('a bot that writes into ANOTHER existing post is reported in the thread, and that post is left', async () => {
    const otherPost = write(root, '_posts/2026-01-01-older.md', '---\ntitle: Older\npermalink: /older/\n---\n\nThe owner wrote this long ago.\n');
    await new Promise(r => setTimeout(r, 50));
    const rewritten = write(work, 'older-edit.md', '---\ntitle: Older\npermalink: /older/\n---\n\nA bot rewrote this.\n');
    await POST(base, '/reply', { url, text: `@claude while you are there [mock:copy:${rewritten}|${otherPost}]` });
    const note = await waitFor(async () => (await page()).page_chat.find(m => m.author === 'botference'
      && /also changed another existing post/.test(m.text)), 'the note');
    assert.match(note.text, /@claude also changed another existing post: `_posts\/2026-01-01-older\.md`/);
    assert.match(note.text, /left as the bots wrote them/);
    assert.match(fs.readFileSync(otherPost, 'utf8'), /A bot rewrote this/, 'reported, not put back');
    assert.equal(fs.readFileSync(source, 'utf8'), ORIGINAL, 'this post did not move');
    await waitFor(async () => (await page()).page_chat.filter(m => m.author === 'claude').length >= 3, 'its reply');
    await new Promise(r => setTimeout(r, 600));
  });

  const batchOf = (id, edits) => ({ schema: 'botference.figure-edits/2', batch_id: id,
    page: { url, path: '/my-post/', title: 'My post', source: '_notes/my-post.md' }, edits });
  const prose = (id, original, replacement, block) => ({ edit_id: id, kind: 'text',
    figure: { id: 'page-text', title: 'Page text' }, element: { kind: 'html-text' },
    source: { file: '_notes/my-post.md', region: 'body', locator: 'markdown body, paragraph', ...(block ? { block } : {}) },
    original, replacement });

  await test('/fte-route writes the owner’s prose, sends the rest to the bots as a file', async () => {
    const b = batchOf('fte-20261106T1300-0000aaaa', [
      prose('e1', 'Last words.', 'Final words.'),
      prose('e2', 'is here', 'is there'),                      // a short span, still unique
      prose('e3', 'Agent check: is "five times" right?', 'x'),  // inside a callout
      { edit_id: 'e4', kind: 'comment', note: 'make the third bar orange', figure: { id: 'fig', title: 'Fig', generator: 'gen.py' },
        element: { kind: 'element', tag: 'rect', path: 'svg > rect' } },
      { edit_id: 'e5', kind: 'text', figure: { id: 'fig', title: 'Fig' }, element: { kind: 'svg-text' }, original: 'Power', replacement: 'Grid power' },
    ]);
    const r = await POST(base, '/fte-route', { url, batch: b });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const to = Object.fromEntries(r.json.routes.map(x => [x.edit_id, x.to]));
    assert.deepEqual(to, { e1: 'source', e2: 'source', e3: 'bots', e4: 'bots', e5: 'bots' });
    assert.equal(r.json.wrote, 2);
    const now = fs.readFileSync(source, 'utf8');
    assert.match(now, /Final words\./);
    assert.match(now, /Second paragraph is there/);
    assert.match(r.json.summary, /2 prose edits were written straight into the post/);
    assert.ok(fs.existsSync(r.json.files.md) && fs.existsSync(r.json.files.json));
    assert.ok(r.json.files.md.startsWith(path.join(root, '.botference', 'plugin', 'artifacts')), r.json.files.md);
    const md = fs.readFileSync(r.json.files.md, 'utf8');
    assert.match(md, /make the third bar orange/);
    assert.match(md, /inside a callout/);
    assert.ok((await page()).marks.some(m => m.kind === 'yours' && m.quote === 'Final words.'));
    // a retry: the same answer, nothing written twice
    const again = await POST(base, '/fte-route', { url, batch: b });
    assert.equal(again.json.repeated, true);
    assert.equal(fs.readFileSync(source, 'utf8'), now);
    fs.writeFileSync(source, ORIGINAL);
  });

  await test('/fte-route writes a NEW paragraph after the one it follows, marks it, and never twice', async () => {
    const para = { edit_id: 'np1', kind: 'paragraph', figure: { id: 'page-text', title: 'Page text' }, element: { kind: 'html-text', tag: 'p' },
      source: { file: '_notes/my-post.md', region: 'body', locator: 'new paragraph after: markdown body, paragraph',
        block: 'Second paragraph is here, and it is mine. Agent check: is this date right?',
        after_block: 'Second paragraph is here, and it is mine. Agent check: is this date right?' },
      original: '', replacement: 'A paragraph I just wrote.' };
    const r = await POST(base, '/fte-route', { url, batch: batchOf('fte-20261107T1400-0000d001', [para]) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.routes.map(x => x.to), ['source']);
    const now = fs.readFileSync(source, 'utf8');
    assert.equal(now, ORIGINAL.replace('is this date right?\n', 'is this date right?\n\nA paragraph I just wrote.\n'));
    assert.ok((await page()).marks.some(m => m.kind === 'yours' && m.quote === 'A paragraph I just wrote.'), 'added by you, on the page');
    const again = await POST(base, '/fte-route', { url, batch: batchOf('fte-20261107T1401-0000d002', [{ ...para, edit_id: 'np2' }]) });
    assert.equal(again.json.wrote, 0);
    assert.equal(again.json.routes[0].already, true);
    assert.equal(fs.readFileSync(source, 'utf8'), now, 'written once');
    // after a callout: the bots' territory, so it goes to them, with the reason
    const inCallout = { ...para, edit_id: 'np3', source: { ...para.source, after_block: 'I think it is four.' } };
    const r3 = await POST(base, '/fte-route', { url, batch: batchOf('fte-20261107T1402-0000d003', [inCallout]) });
    assert.equal(r3.json.routes[0].to, 'bots');
    assert.match(fs.readFileSync(r3.json.files.md, 'utf8'), /new paragraph/);
    fs.writeFileSync(source, ORIGINAL);
  });

  await test('retry after a write: a new batch id with the same edit, or an insertion, never writes twice', async () => {
    const ins = prose('i1', 'Last words.', 'Last words. And one more sentence after them.');
    const r1 = await POST(base, '/fte-route', { url, batch: batchOf('fte-20261107T1213-0000c001', [ins]) });
    assert.equal(r1.json.wrote, 1);
    const once = fs.readFileSync(source, 'utf8');
    assert.equal(once.split('And one more sentence').length - 1, 1);
    // the page reloaded before the ack; the editor resends under a NEW id
    // (its drafts changed) — the companion knows the edit id
    const r2 = await POST(base, '/fte-route', { url, batch: batchOf('fte-20261107T1214-0000c002', [ins]) });
    assert.equal(r2.json.wrote, 0);
    assert.equal(r2.json.routes[0].to, 'source');
    assert.equal(r2.json.routes[0].already, true);
    // …and a fresh edit id for the same insertion (a re-made draft) finds the
    // words already there, though the old words still match inside them
    const r3 = await POST(base, '/fte-route', { url, batch: batchOf('fte-20261107T1215-0000c003', [{ ...ins, edit_id: 'i2' }]) });
    assert.equal(r3.json.wrote, 0);
    assert.equal(r3.json.routes[0].already, true);
    assert.equal(fs.readFileSync(source, 'utf8'), once, 'the file is exactly as after the first write');
    assert.ok((await page()).fte_written.some(w => w.edit_id === 'i1'), 'the written edit id is kept on the page record');
    fs.writeFileSync(source, ORIGINAL);
  });

  await test('a prose edit the owner makes DURING a bot turn survives the backstop', async () => {
    const userText = ORIGINAL.replace('Last words.', 'Last words, mid-turn.');
    // the bot read the file after the owner's edit and changed their prose too
    const botFile = write(work, 'edit2.md', userText.replace('and it is mine.', 'and the bot rewrote it.'));
    await POST(base, '/reply', { url, text: `@claude rework [mock:sleep:1500] [mock:copy:${botFile}|${source}]` });
    await waitFor(() => inputs(log).some(s => s.includes('rework')), 'the turn started');
    const r = await POST(base, '/fte-route', { url, batch: batchOf('fte-20261106T1301-0000bbbb', [prose('m1', 'Last words.', 'Last words, mid-turn.')]) });
    assert.equal(r.json.routes[0].to, 'source');
    await waitFor(async () => (await page()).page_chat.filter(m => m.author === 'botference' && (m.suggestions || []).length).length >= 2, 'the card');
    const now = fs.readFileSync(source, 'utf8');
    assert.match(now, /Last words, mid-turn\./, 'the owner’s edit survived');
    assert.match(now, /and it is mine\./, 'the bot’s edit was put back');
    const holder = (await page()).page_chat.filter(m => m.author === 'botference' && (m.suggestions || []).length).pop();
    assert.equal(holder.suggestions.length, 1);
    assert.match(holder.suggestions[0].proposed, /bot rewrote it/);
  });
} finally {
  web.closeAllConnections(); web.close(); h.cleanup();
}
console.log(`ownership: ${h.passed()} passed, ${h.failures().length} failed`);
process.exitCode = h.failures().length ? 1 : 0;
