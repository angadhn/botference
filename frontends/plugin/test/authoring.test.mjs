import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as authoring from '../authoring.mjs';
import { createHarness, POST, GET, inputs, listen } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const h = createHarness({ server: path.join(here, '../server.mjs'), tag: 'authoring', realpath: true });
const { test, tmp, waitFor } = h;
const root = tmp('site');
const work = tmp('workspace');
const write = (base, rel, text) => {
  const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p;
};
write(root, '_config.yml', 'collections:\n  notes:\n    output: true\n    permalink: /:slug/\n');
write(root, 'Templates/baseline.md', '---\ntitle:\ncreated:\nreleased:\ntags:\nsubtitle:\n---\n');
const source = write(root, '_notes/existing.md', '---\ntitle: Existing\ncreated: 2025-01-01\nreleased: 2025-02-01\ntags: [essays]\npermalink: /existing/\npublished: false\n---\n\nFirst point.\n\nSecond point.\n');
const css = write(root, '_sass/note.scss', 'body { color: black; }');
write(root, '_site/ignored.html', 'output');
const site = { root, kind: 'jekyll', serve_origin: 'http://127.0.0.1:4000' };

await test('authoring requires a confirmed registered local site', () => {
  assert.equal(authoring.siteForRoot('', [site], () => 'yes'), null);
  assert.equal(authoring.siteForRoot(root, [], () => 'yes'), null);
  assert.equal(authoring.siteForRoot(root, [site], () => 'no'), null);
  assert.equal(authoring.siteForRoot(root, [{ ...site, serve_origin: 'https://example.com' }], () => 'yes'), null);
  assert.equal(authoring.siteForRoot(root, [site], () => 'yes').root, root);
});
await test('authoring census includes CSS and layouts but not built output', () => {
  const scan = authoring.scan(site);
  assert.ok(scan.has('_sass/note.scss'));
  assert.ok(!scan.has('_site/ignored.html'));
});

const web = http.createServer((req, res) => res.end('local preview'));
let events;
try {
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${web.address().port}`;
  const cfg = { blog_sites: [{ ...site, serve_origin: origin }], blog_roots: { [root]: true }, blog_authoring_root: root };
  write(work, '.botference/plugin/config.json', JSON.stringify(cfg));
  write(work, '.botference/plugin/grants.json', JSON.stringify({ guest: { agents: true, daily_cap: 10 } }));
  const log = path.join(work, 'bridge.jsonl');
  const envLog = path.join(work, 'env.jsonl');
  const { base } = await h.startServer({ root: work, args: ['--hosted'], env: {
    PLUGIN_PASSWORD: 'authoring-test',
    PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(here, 'mock-bridge.mjs')]),
    MOCK_BRIDGE_LOG: log, MOCK_ENV_DUMP: envLog,
  } });
  events = listen(base);
  const url = 'https://example.test/source';
  const preview = origin + '/existing/';
  await POST(base, '/page', { url, title: 'Source article' });
  await POST(base, '/page', { url: preview, title: 'Existing' });

  await test('source-article conversations get real site write scope and direct authoring instructions', async () => {
    const r = await POST(base, '/reply', { url, text: '@claude Please work directly in the blog.' });
    assert.equal(r.json.queued, true);
    await waitFor(() => inputs(log).some(s => s.includes('Please work directly')), 'source turn');
    const turn = inputs(log).findLast(s => s.includes('Please work directly'));
    assert.match(turn, /explicitly authorized direct editing/);
    assert.ok(turn.includes(root));
    const spawn = JSON.parse(fs.readFileSync(envLog, 'utf8').trim().split('\n')[0]);
    assert.equal(spawn.scope.BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS, root);
    assert.equal(spawn.scope.BOTFERENCE_PLAN_DENY_BASH, 'git,gh');
    assert.match(spawn.scope.BOTFERENCE_SUMMON_PLACEMENT, /Write and revise the actual Markdown/);
    assert.doesNotMatch(spawn.scope.BOTFERENCE_SUMMON_PLACEMENT, /Do not edit the pages/);
  });

  await test('draft command uses direct authoring and fills archive metadata on the real created file', async () => {
    const staged = write(work, 'prepared.md', '---\ntitle: Direct post\ncreated:\nreleased:\ntags: [AI]\npermalink: /direct-post/\n---\n\nExisting work reused.\n');
    const target = path.join(root, '_notes/direct-post.md');
    const r = await POST(base, '/draft-blog', { url,
      text: `/draft-blog Reuse the prepared draft. [mock:copy:${staged}|${target}]` });
    assert.equal(r.json.queued, true);
    await waitFor(async () => (await GET(base, '/page?url=' + encodeURIComponent(url))).json.page_chat
      .some(m => m.text.includes('Open the local preview') && m.text.includes('/direct-post/')), 'direct preview receipt');
    const raw = fs.readFileSync(target, 'utf8');
    assert.match(raw, /created: \d{4}-\d{2}-\d{2}/);
    assert.match(raw, /released: \d{4}-\d{2}-\d{2}/);
    assert.match(raw, /tags: \["essays","AI"\]/);
    assert.match(raw, /published: false/);
    assert.match(raw, /Existing work reused/);
    assert.doesNotMatch(inputs(log).findLast(s => s.includes('Reuse the prepared draft')), /Return the complete Markdown body in ONE fenced block/);
  });

  await test('CSS writes are reported, and local previews advertise direct edits', async () => {
    const r = await POST(base, '/reply', { url, text: `@codex Update the stylesheet. [mock:write:${css}]` });
    assert.equal(r.json.queued, true);
    await waitFor(() => events.seen.some(e => e.type === 'blog-files' && e.url === url && e.files.includes('_sass/note.scss')), 'stylesheet census');
    const e = events.seen.findLast(e => e.type === 'blog-files' && e.url === url && e.files.includes('_sass/note.scss'));
    assert.equal(e.page_changed, false, 'do not reload the external source article');
    const bg = (await GET(base, '/blog-page?url=' + encodeURIComponent(preview))).json.blog;
    assert.equal(bg.suggest_mode, false);
    assert.equal(bg.direct_edit, true);
    assert.equal(fs.readFileSync(envLog, 'utf8').trim().split('\n').length, 1, 'one writer lane for the site');
  });

  await test('Send review dispatches both highlighted comments as direct edits and replies in each thread', async () => {
    const original = fs.readFileSync(source, 'utf8');
    const first = write(work, 'first-edit.md', original.replace('First point.', 'First point clarified.'));
    const second = write(work, 'second-edit.md', original.replace('First point.', 'First point clarified.').replace('Second point.', 'Second point explained.'));
    const a = await POST(base, '/thread', { url: preview, quote: 'First point.',
      msg: { text: `Tighten the first point. [mock:copy:${first}|${source}]` }, route: 'none' });
    const b = await POST(base, '/thread', { url: preview, quote: 'Second point.',
      msg: { text: `Explain the second point. [mock:copy:${second}|${source}]` }, route: 'none' });
    const r = await POST(base, '/send-review', { url: preview });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sent, 2);
    await waitFor(async () => {
      const page = (await GET(base, '/page?url=' + encodeURIComponent(preview))).json;
      return [a.json.thread.id,b.json.thread.id].every(id => page.threads.find(t => t.id === id).msgs.some(m => ['claude','codex'].includes(m.author)));
    }, 'both comment replies');
    const turns = inputs(log).filter(s => s.includes('[review round · comment'));
    assert.equal(turns.length, 2);
    assert.ok(turns.every(s => s.includes('MAKE the change') && s.includes('direct editing')));
    assert.ok(turns.some(s => s.includes('First point.')) && turns.some(s => s.includes('Second point.')));
    assert.match(fs.readFileSync(source, 'utf8'), /released: "2025-02-01"/);
    assert.match(fs.readFileSync(source, 'utf8'), /First point clarified/);
    assert.match(fs.readFileSync(source, 'utf8'), /Second point explained/);
  });

  await test('a granted guest cannot use the owner-authorized site writer', async () => {
    const r = await POST(base, '/reply', { url, text: '@claude edit the blog' }, {
      authorization: 'Bearer authoring-test', 'x-plugin-handle': 'guest', host: 'shared.example',
    });
    assert.equal(r.json.queued, false);
    assert.match(r.json.reason, /authoring is owner-only/);
  });
} finally {
  events?.close(); web.closeAllConnections(); web.close(); h.cleanup();
}
console.log(`authoring: ${h.passed()} passed, ${h.failures().length} failed`);
process.exitCode = h.failures().length ? 1 : 0;
