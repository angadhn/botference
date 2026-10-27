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
  assert.match(saved, /released:\ntags:\n  - essays/);
  assert.match(saved, /companion music:\nimage:\npremium: false/);
  assert.match(saved, /published: false/);
  assert.doesNotMatch(saved, /published: true/);
  assert.equal(fs.readFileSync(file, 'utf8'), template);
  assert.throws(() => dest(cmd, { draft_template: '../outside.md' }));
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
