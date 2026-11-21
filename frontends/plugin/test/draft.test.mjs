import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import * as draft from '../draft.mjs';
import { createHarness, POST, GET, inputs } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const h = createHarness({ server: path.join(here, '../server.mjs'), tag: 'draft', realpath: true });
const { test, tmp, waitFor } = h;
const root = tmp('site');
fs.mkdirSync(path.join(root, '_notes'));
fs.writeFileSync(path.join(root, '_config.yml'), 'collections:\n  notes:\n    output: true\n    permalink: /:slug\n');
const site = { root, kind: 'jekyll', serve_origin: 'http://127.0.0.1:4000' };
const cmd = draft.parseCommand('/draft-blog @codex new-post | Turn our disagreement into an essay.');
const dest = (c = cmd, cfg = {}) => draft.destination(c, cfg, [site], () => 'yes');
const fence = body => '````blog-draft\n' + body + '\n````';

await test('command accepts ordinary prose, a bare command, and the older explicit filename form', () => {
  assert.equal(cmd.agent, 'codex');
  assert.equal(draft.parseCommand('draft me a post'), null);
  assert.equal(draft.parseCommand('/draft ordinary-plan'), null);
  assert.equal(draft.parseCommand('/draft-blog').slug, '');
  assert.match(draft.parseCommand('/draft-blog').brief, /our discussion/);
  assert.deepEqual(draft.parseCommand('/draft-blog @codex Write my response to this article.'),
    { agent: 'codex', slug: '', brief: 'Write my response to this article.' });
  assert.equal(draft.parseCommand('/draft-blog ../escape | hello').slug, '', 'a path in prose cannot name a file');
  assert.throws(() => dest({ ...cmd, slug: '../escape' }));
});
await test('confirmed local collection required; duplicate origins count as one site', () => {
  assert.throws(() => draft.destination(cmd, {}, [site], () => 'no'));
  assert.throws(() => dest(cmd, { draft_dir: '../outside' }));
  assert.throws(() => draft.destination(cmd, {}, [{ ...site, serve_origin: 'https://example.com' }], () => 'yes'));
  assert.equal(draft.destination(cmd, {}, [site, site], () => 'yes').root, root);
  fs.symlinkSync(tmp('outside'), path.join(root, '_escape'));
  assert.throws(() => dest(cmd, { draft_dir: '_escape' }));
});
await test('draft saves unpublished source and never replaces a file or permalink', () => {
  const d = dest();
  const body = draft.bodyOf(fence('# New post\n\nA considered response.\n\n```js\nconst x = 1;\n```'));
  draft.saveDraft(d, body, { url: 'https://example.com/article' });
  assert.match(fs.readFileSync(d.file, 'utf8'), /published: false/);
  assert.throws(() => draft.saveDraft(d, '# Overwrite', { url: 'x' }));
  assert.throws(() => dest());
  fs.writeFileSync(path.join(root, '_notes', 'different.md'), '---\npermalink: /occupied/\n---\nBody');
  assert.throws(() => dest({ ...cmd, slug: 'occupied' }));
  assert.throws(() => draft.bodyOf('No fenced draft'));
  assert.throws(() => draft.bodyOf(fence('# One') + '\n' + fence('# Two')));
});
await test('freeform drafts derive filenames from titles and avoid existing posts', () => {
  const automatic = () => dest(draft.parseCommand('/draft-blog Write my response.'));
  const first = automatic();
  draft.saveDraft(first, '# My response!\n\nOne view.', { url: 'https://example.com/article' });
  assert.equal(first.rel, '_notes/my-response.md');
  const second = automatic();
  draft.saveDraft(second, '# My response!\n\nAnother view.', { url: 'https://example.com/article' });
  assert.equal(second.rel, '_notes/my-response-2.md');
  assert.match(fs.readFileSync(first.file, 'utf8'), /One view/);
});
await test('baseline front matter is preserved while generated fields stay safe and unpublished', () => {
  const folder = path.join(root, 'Templates'); fs.mkdirSync(folder);
  const file = path.join(folder, 'baseline.md');
  const template = '---\ntitle:\ncreated:\nreleased:\ntags:\n  - essays\npermalink:\n'
    + 'top_of_mind: "false"\ncompanion music:\nimage:\npremium: false\npublished: true\n---\n';
  fs.writeFileSync(file, template);
  const d = dest(draft.parseCommand('/draft-blog'));
  draft.saveDraft(d, '# A title: with punctuation\n\nBody.', { url: 'https://example.com/article' });
  const saved = fs.readFileSync(d.file, 'utf8');
  assert.match(saved, /title: "A title: with punctuation"/);
  assert.doesNotMatch(saved, /^# A title/m, 'the layout renders the title, so do not duplicate it in the body');
  assert.match(saved, /created: \d{4}-\d{2}-\d{2}/);
  assert.match(saved, /released: \d{4}-\d{2}-\d{2}/);
  assert.match(saved, /tags: \["essays"\]/);
  assert.match(saved, /companion music:\nimage:\npremium: false/);
  assert.match(saved, /published: false/);
  assert.doesNotMatch(saved, /published: true/);
  assert.equal(fs.readFileSync(file, 'utf8'), template);
  assert.throws(() => dest(cmd, { draft_template: '../outside.md' }));
});
// ---- the reader's highlights in a draft, and Blygger posts -------------------
// Generic templates only: one with a `blyg:` key (a site that publishes
// Blygger threads) and one without (any other site).
const BLYG_ORIGIN = 'https://example.org/blyg/';
const BLYG_ID = '0123456789abcdefghjkmnpqrs';
const BLYG_PAGE = `${BLYG_ORIGIN}t/${BLYG_ID}/`;
const P1 = 'The first sentence the reader marked, word for word.';
const P2 = 'A second passage from an ordinary part of the page.';
const blygPage = (extra = {}) => ({
  url: 'https://example.org/blyg/t/0123456789abcdefghjkmnpqrs', title: 'A made-up post',
  blyg: { status: 'blyg', checked: '2026-11-21T00:00:00Z', item: { origin: BLYG_ORIGIN, id: BLYG_ID, kind: 'thread',
    version: 3, latest: 3, pinned: false, pinned_versions: [], page: BLYG_PAGE, pinned_page: '', source: 'Made-up', author: 'Someone' } },
  threads: [
    { id: 'a', quote: P1, msgs: [], blyg: { status: 'blyg', origin: BLYG_ORIGIN, id: BLYG_ID, version: 3, pinned: false,
      page: BLYG_PAGE, as_of: 'record', passage: { match: true } } },
    { id: 'b', quote: P2, msgs: [] },
  ], page_chat: [], ...extra });
const withTemplate = (text, fn) => {
  const file = path.join(root, 'Templates', 'baseline.md');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text);
  try { return fn(); } finally { fs.writeFileSync(file, before); }
};

await test('quotes: placeholders are filled with the highlights, by reference on a Blygger post', () => {
  const set = draft.quoteSet(blygPage(), { quote_style: 'url-card' });
  const r = draft.placeQuotes(`Opening.\n\n<!-- quote:1 -->\n\nMiddle.\n\n<!-- quote:2 -->\n\n<!-- quote:9 -->\nEnd.`, set);
  assert.equal(r.body, 'Opening.\n\n'
    + `![[${BLYG_ID} | A made-up post]]\n> ${P1}\n\nMiddle.\n\n`
    + `> ${P2}\n>\n> https://example.org/blyg/t/0123456789abcdefghjkmnpqrs\n\nEnd.`);
  assert.deepEqual([r.placed, r.restored, r.unknown], [2, 0, 1]);
  assert.match(draft.quotesPrompt(set), /<!-- quote:N -->/);
});

await test('quotes: a passage the bot retyped is replaced by the stored words; its own quotes are left alone', () => {
  const set = draft.quoteSet(blygPage(), { quote_style: 'plain' });
  const bot = 'As the post puts it:\n\n'
    + `![[${BLYG_ID}]]\n> The first sentence that the reader marked, word for word!\n\n`
    + '> A completely different line the bot chose to quote from elsewhere.\n\nDone.';
  const r = draft.placeQuotes(bot, set);
  assert.equal(r.body, 'As the post puts it:\n\n'
    + `![[${BLYG_ID} | A made-up post]]\n> ${P1}\n\n`
    + '> A completely different line the bot chose to quote from elsewhere.\n\nDone.');
  assert.equal(r.restored, 1);
});

await test('front matter: a template with a blyg key gains the two keys, every template line kept in order', () => {
  const template = '---\ntitle:\nreleased:\nblyg: true\ntags:\n  - essays\npublished: true\n---\n';
  withTemplate(template, () => {
    const d = dest(draft.parseCommand('/draft-blog'));
    d.quotes = draft.quoteSet(blygPage({ export_response: 'response' }), {});
    draft.saveDraft(d, `# My answer\n\n<!-- quote:1 -->\n\nI disagree.`, { url: blygPage().url });
    const saved = fs.readFileSync(d.file, 'utf8');
    const front = saved.slice(0, saved.indexOf('\n---\n', 4) + 5);
    assert.match(front, /^---\ntitle: "My answer"\nreleased: \d{4}-\d{2}-\d{2}\nblyg: true\ntags: \["essays"\]\npublished: false\n/);
    assert.ok(front.endsWith(`blyg_sources:\n  - ${BLYG_PAGE}\nblyg_stub_of:\n  origin: ${BLYG_ORIGIN}\n  id: ${BLYG_ID}\n  version: 3\n---\n`), front);
    assert.ok(saved.includes(`![[${BLYG_ID} | A made-up post]]\n> ${P1}\n\nI disagree.`), saved);
    assert.deepEqual(d.quoteCounts, { placed: 1, restored: 0, unknown: 0 });
  });
});

await test('front matter: a template without a blyg key, on an ordinary page, is exactly as before', () => {
  const template = '---\ntitle:\ncreated:\ntags:\npublished: true\n---\n';
  withTemplate(template, () => {
    const plain = { url: 'https://example.com/article', title: 'An article', threads: [{ id: 'x', quote: P2, msgs: [] }], page_chat: [] };
    const a = dest(draft.parseCommand('/draft-blog'));
    a.quotes = draft.quoteSet(plain, { quote_style: 'plain' });
    draft.saveDraft(a, '# Ordinary one\n\nNo quotes here.', { url: plain.url });
    const b = dest(draft.parseCommand('/draft-blog'));
    draft.saveDraft(b, '# Ordinary two\n\nNo quotes here.', { url: plain.url });
    const front = f => fs.readFileSync(f, 'utf8').split('\n---\n')[0].replace(/title: "[^"]*"/, 'title: X').replace(/permalink: "[^"]*"/, 'permalink: X');
    assert.equal(front(a.file), front(b.file), 'no Blygger keys, nothing else different');
    assert.doesNotMatch(fs.readFileSync(a.file, 'utf8'), /blyg/);
  });
});

await test('Liquid in a page title or a passage is passed through as text, never run by Jekyll', () => {
  const hostile = blygPage({ title: 'Title {{ site.secret }}' });
  hostile.threads[1].quote = 'Run {% include evil.html %} please';
  const set = draft.quoteSet(hostile, { quote_style: 'plain' });
  const r = draft.placeQuotes('<!-- quote:1 -->\n\n<!-- quote:2 -->', set);
  assert.equal(r.body, `{% raw %}\n\n![[${BLYG_ID} | Title {{ site.secret }}]]\n> ${P1}\n\n{% endraw %}\n\n`
    + '{% raw %}\n\n> Run {% include evil.html %} please\n\n{% endraw %}');
  assert.equal(draft.liquidSafe('no templates here'), 'no templates here');
  assert.match(draft.liquidSafe('{% endraw %}{{ x }}'), /left out/);
});

await test('a draft from a PDF on this computer carries no local path or internal address', () => {
  for (const url of ['bfp-pdf://sha256/0123abcd', 'file:///home/someone/papers/paper.pdf']) {
    const pdf = { url, title: 'A paper', threads: [{ id: 'p', quote: P2, msgs: [] }], page_chat: [] };
    const d = dest(draft.parseCommand('/draft-blog'));
    d.quotes = draft.quoteSet(pdf, {});
    draft.saveDraft(d, `# From a paper ${url.length}\n\n<!-- quote:1 -->\n\nThoughts.`, { url });
    const saved = fs.readFileSync(d.file, 'utf8');
    assert.ok(saved.includes(`> ${P2}\n\nThoughts.`), saved);
    assert.ok(!saved.includes(url) && !saved.includes('bfp-pdf') && !saved.includes('file:'), saved);
    assert.match(saved, /source_url: ""/);
  }
});

await test('front matter: a blyg_sources key already in the template is filled in place', () => {
  withTemplate('---\ntitle:\nblyg_sources:\n  - https://old.example/\nnotes: keep me\npublished: true\n---\n', () => {
    const d = dest(draft.parseCommand('/draft-blog'));
    d.quotes = draft.quoteSet(blygPage(), {});
    draft.saveDraft(d, '# In place\n\nText.', { url: blygPage().url });
    const saved = fs.readFileSync(d.file, 'utf8');
    assert.match(saved, new RegExp(`title: "In place"\\nblyg_sources:\\n  - ${BLYG_PAGE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\nnotes: keep me\\n`));
    assert.doesNotMatch(saved, /old\.example/);
  });
});

await test('preview starts one Jekyll process for concurrent requests and checks its actual output', async () => {
  const calls = [];
  const child = new EventEmitter(); child.kill = () => calls.push('kill');
  let running = false;
  const p = draft.createPreviewer({ intervalMs: 1, timeoutMs: 50,
    spawnProcess: (...args) => { calls.push(args); running = true; return child; },
    fetchPage: async () => ({ ok: running, text: async () => 'botference-draft:test-token' }),
  });
  const d = { ...dest({ ...cmd, slug: 'preview' }), previewToken: 'test-token' };
  await Promise.all([p.start(d), p.start(d)]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].includes('--unpublished'));
  assert.equal(calls[0][2].cwd, root);
  p.stop();
  assert.equal(calls[1], 'kill');
  const wrong = draft.createPreviewer({ timeoutMs: 5, intervalMs: 1,
    fetchPage: async () => ({ ok: true, text: async () => 'another app' }),
    spawnProcess: () => { throw new Error('must reuse existing listener'); },
  });
  await assert.rejects(wrong.start(d), /preview is not ready/);
});

// Full HTTP + bridge test. A tiny existing local server stands in for Jekyll;
// it serves only the draft that the companion actually saved, including its
// preview marker. Jekyll itself is exercised separately against a temp site.
const web = http.createServer((req, res) => {
  if (req.url === '/') return res.end('test site');
  const file = path.join(root, '_notes', req.url.split('/').filter(Boolean)[0] + '.md');
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.end(fs.readFileSync(file));
});
try {
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${web.address().port}`;
  const work = tmp('companion');
  const dir = path.join(work, '.botference/plugin'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    blog_sites: [{ ...site, serve_origin: origin }], blog_roots: { [root]: true },
  }));
  const log = path.join(work, 'bridge.jsonl');
  const { base } = await h.startServer({ root: work, env: {
    PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(here, 'mock-bridge.mjs')]), MOCK_BRIDGE_LOG: log,
  } });
  const url = 'https://example.test/source';
  await POST(base, '/page', { url, title: 'Source article' });
  await test('dedicated draft routes advertise support and refuse ordinary chat', async () => {
    assert.equal((await GET(base, '/health')).json.capabilities.draft_blog, 1);
    assert.equal((await POST(base, '/draft-blog', { url, text: '@claude create an artifact' })).status, 400);
    assert.equal((await POST(base, '/draft-blog/thread', { url, quote: 'passage', msg: { text: 'ordinary comment' } })).status, 400);
  });
  await POST(base, '/reply', { url, text: 'Keep the economic counterargument.', route: '' });
  await test('owner command creates a preview link and carries source context into later draft turns', async () => {
    const response = fence('# Economics\n\nThe counterargument matters.');
    const r = await POST(base, '/draft-blog', { url, text: '/draft-blog @codex Write it. [mock:says:' + response.replaceAll('\n', '\\n') + ']' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.queued, true);
    const repeated = await POST(base, '/reply', { url, text: '/draft-blog @codex Write it. [mock:says:' + response.replaceAll('\n', '\\n') + ']' });
    assert.equal(repeated.json.deduped, true, 'retrying the same submission must not create a second post');
    const page = await waitFor(async () => {
      const result = (await GET(base, '/page?url=' + encodeURIComponent(url))).json;
      const p = result?.page || result;
      return p?.page_chat.some(m => m.text.includes('Read [the draft]')) ? p : null;
    }, 'saved preview link');
    assert.ok(page.page_chat.some(m => m.text.includes(origin + '/economics/')));
    assert.match(fs.readFileSync(path.join(root, '_notes/economics.md'), 'utf8'), /published: false/);
    assert.match(fs.readFileSync(path.join(root, '_notes/economics.md'), 'utf8'), /companion music:/);
    const preview = origin + '/economics/';
    await POST(base, '/reply', { url: preview, text: '@claude tighten the argument' });
    await waitFor(() => inputs(log).some(s => s.includes('tighten the argument')), 'follow-up turn');
    const turn = inputs(log).findLast(s => s.includes('tighten the argument'));
    assert.match(turn, /Keep the economic counterargument/);
    assert.match(turn, /YOU DO NOT EDIT THIS FILE/);
    const again = await POST(base, '/reply', { url, text: '/draft-blog economics | Replace it' });
    assert.equal(again.status, 400);
  });
  await test('ordinary bot replies cannot create a draft', async () => {
    await POST(base, '/reply', { url, text: '@codex [mock:says:' + fence('# Unauthorized').replaceAll('\n', '\\n') + ']' });
    await waitFor(async () => (await GET(base, '/page?url=' + encodeURIComponent(url))).json
      ?.page_chat.some(m => m.author === 'codex' && m.text.includes('# Unauthorized')), 'ordinary reply');
    assert.equal(fs.existsSync(path.join(root, '_notes/unauthorized.md')), false);
  });
  await test('the first comment on a highlight and a later reply both create drafts in that thread', async () => {
    const quote = 'A specific line worth responding to.';
    const command = '/draft-blog Discuss this passage. [mock:says:'
      + fence('# From a highlight\n\nAn answer to the line.').replaceAll('\n', '\\n') + ']';
    const body = { url, quote, msg: { text: command } };
    const r = await POST(base, '/draft-blog/thread', body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.queued, true);
    const id = r.json.thread.id;
    const duplicate = await POST(base, '/thread', body);
    assert.equal(duplicate.json.deduped, true);
    const receipt = async title => {
      const page = (await GET(base, '/page?url=' + encodeURIComponent(url))).json;
      return page.threads.find(t => t.id === id)?.msgs.some(m => m.text.includes(title) && m.text.includes('Read [the draft]'));
    };
    await waitFor(() => receipt('/from-a-highlight/'), 'preview link in the new comment thread');
    const input = inputs(log).findLast(s => s.includes('Discuss this passage.'));
    assert.match(input, /A specific line worth responding to/);
    const next = await POST(base, '/reply', { url, thread_id: id,
      text: '/draft-blog @codex Try another angle. [mock:says:'
        + fence('# Another angle\n\nA second answer.').replaceAll('\n', '\\n') + ']' });
    assert.equal(next.json.queued, true);
    await waitFor(() => receipt('/another-angle/'), 'preview link for thread reply');
    const draftPage = (await GET(base, '/page?url=' + encodeURIComponent(origin + '/another-angle/'))).json;
    assert.match(draftPage.draft_context, /A specific line worth responding to/);
  });
  await test('a missing draft block reports failure and releases the filename for retry', async () => {
    await POST(base, '/reply', { url, text: '/draft-blog malformed | [mock:says:I could not draft this.]' });
    await waitFor(async () => (await GET(base, '/page?url=' + encodeURIComponent(url))).json
      ?.page_chat.some(m => m.text.includes('Draft creation failed:')), 'visible draft failure');
    assert.equal(fs.existsSync(path.join(root, '_notes/malformed.md')), false);
    const retry = await POST(base, '/reply', { url, text: '/draft-blog malformed | [mock:says:'
      + fence('# A second attempt').replaceAll('\n', '\\n') + ']' });
    assert.equal(retry.json.queued, true);
    await waitFor(() => fs.existsSync(path.join(root, '_notes/malformed.md')), 'successful retry');
  });
} finally {
  web.closeAllConnections(); web.close(); h.cleanup();
}
console.log(`draft: ${h.passed()} passed, ${h.failures().length} failed`);
process.exitCode = h.failures().length ? 1 : 0;
