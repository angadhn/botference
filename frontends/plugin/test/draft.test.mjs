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

await test('commands select a writer and require a plain filename and brief', () => {
  assert.equal(cmd.agent, 'codex');
  assert.equal(draft.parseCommand('draft me a post'), null);
  assert.equal(draft.parseCommand('/draft ordinary-plan'), null);
  for (const s of ['/draft-blog', '/draft-blog ../escape | hello', '/draft-blog good-name']) assert.throws(() => draft.parseCommand(s));
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
  await POST(base, '/reply', { url, text: 'Keep the economic counterargument.', route: '' });
  await test('owner command creates a preview link and carries source context into later draft turns', async () => {
    const response = fence('# Economics\n\nThe counterargument matters.');
    const r = await POST(base, '/reply', { url, text: '/draft-blog @codex economics | Write it. [mock:says:' + response.replaceAll('\n', '\\n') + ']' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.queued, true);
    const page = await waitFor(async () => {
      const result = (await GET(base, '/page?url=' + encodeURIComponent(url))).json;
      const p = result?.page || result;
      return p?.page_chat.some(m => m.text.includes('Read [the draft]')) ? p : null;
    }, 'saved preview link');
    assert.ok(page.page_chat.some(m => m.text.includes(origin + '/economics/')));
    assert.match(fs.readFileSync(path.join(root, '_notes/economics.md'), 'utf8'), /published: false/);
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
