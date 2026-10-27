import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, POST, GET, inputs } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const h = createHarness({ server: path.join(here, '../server.mjs'), tag: 'network', realpath: true, waitMs: 15000 });
const councilHarness = createHarness({ server: path.join(here, '../../council/server.mjs'), tag: 'network-council', realpath: true });
const { test, tmp, waitFor } = h;
const work = tmp('plugin'), council = tmp('council'), site = tmp('site');
function write(root, rel, text) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; }
write(council, 'project.json', '{}'); fs.mkdirSync(path.join(council, 'work'));
write(council, 'projects/economics/PROJECT.md', '# Economics\n\nInstitutions education costs and assessment.');
write(council, 'projects/space/PROJECT.md', '# Space engineering\n\nOrbital structures and docking.');
write(site, '_config.yml', 'collections:\n  notes:\n    output: true\n    permalink: /:slug/\n');
write(site, 'Templates/baseline.md', '---\ntitle:\ncreated:\nreleased:\ntags:\n---\n');
fs.mkdirSync(path.join(site, '_notes'));
const web = http.createServer((req, res) => res.end('preview'));
try {
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${web.address().port}`;
  write(work, '.botference/plugin/config.json', JSON.stringify({
    council_roots: { [council]: true }, blog_sites: [{ root: site, kind: 'jekyll', serve_origin: origin }],
    blog_roots: { [site]: true }, blog_authoring_root: site,
  }));
  const log = path.join(work, 'bridge.jsonl'), envLog = path.join(work, 'env.jsonl');
  const { base } = await h.startServer({ root: work, args: ['--hosted'], env: {
    PLUGIN_PASSWORD: 'network-test', PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(here, 'mock-bridge.mjs')]),
    MOCK_BRIDGE_LOG: log, MOCK_ENV_DUMP: envLog,
  } });
  const graph = async url => (await GET(base, '/project-network?url=' + encodeURIComponent(url))).json;
  const pdf = 'bfp-pdf://text/' + 'a'.repeat(64);
  const other = 'https://example.test/other-reading';
  await POST(base, '/page', { url: pdf, title: 'Local education PDF', kind: 'pdf' });
  await POST(base, '/page', { url: other, title: 'Another reading' });
  let project, output;

  await test('a local PDF conversation receives authoring scope without creating a project just for reading', async () => {
    await POST(base, '/reply', { url: pdf, text: '@claude Explain this paper.' });
    await waitFor(() => inputs(log).some(s => s.includes('Explain this paper.')), 'PDF turn');
    assert.match(inputs(log).findLast(s => s.includes('Explain this paper.')), /explicitly authorized direct editing/);
    const scope = JSON.parse(fs.readFileSync(envLog, 'utf8').trim().split('\n')[0]).scope;
    assert.equal(scope.BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS, site);
    const data = await graph(pdf);
    assert.equal(data.projects.length, 2);
    assert.deepEqual(data.current_projects, []);
  });

  await test('a PDF draft creates one real project and links its canonical output and reading', async () => {
    const staged = write(work, 'staged.md', '---\ntitle: Learning and costs\npermalink: /learning-costs/\n---\n\nAn original draft.');
    const target = path.join(site, '_notes/learning-costs.md');
    const r = await POST(base, '/draft-blog', { url: pdf, text: `/draft-blog Use this discussion. [mock:copy:${staged}|${target}]` });
    assert.equal(r.json.queued, true);
    await waitFor(async () => (await graph(pdf)).outputs.some(o => o.path === target && o.projects?.length), 'project output');
    const data = await graph(pdf); output = data.outputs.find(o => o.path === target); project = output.projects[0];
    assert.equal(data.projects.length, 3);
    assert.ok(fs.existsSync(path.join(council, 'projects', project, 'PROJECT.md')));
    assert.equal(data.current_projects[0], project);
    assert.equal(output.path, target);
    assert.match(fs.readFileSync(target, 'utf8'), /An original draft/);
  });

  await test('another output from the same conversation joins that project instead of making a duplicate', async () => {
    const staged = write(work, 'second.md', '---\ntitle: A follow-up\npermalink: /follow-up/\n---\n\nAnother output.');
    const target = path.join(site, '_notes/follow-up.md');
    await POST(base, '/draft-blog', { url: pdf, text: `/draft-blog Write a follow-up. [mock:copy:${staged}|${target}]` });
    await waitFor(async () => (await graph(pdf)).outputs.some(o => o.path === target && o.projects?.includes(project)), 'second output');
    const data = await graph(pdf);
    assert.equal(data.projects.length, 3);
    assert.equal(data.outputs.filter(o => o.projects?.includes(project)).length, 2);
  });

  await test('ordinary language links another reading to the existing draft without waking an agent', async () => {
    await POST(base, '/page-projects', { url: other, root: council, id: 'economics', attach: true });
    const before = inputs(log).length;
    const r = await POST(base, '/reply', { url: other, text: 'Please link this reading to Learning and costs.' });
    assert.equal(r.status, 200);
    assert.equal(r.json.queued, false);
    assert.equal(r.json.project_link.output, output.id);
    assert.equal(inputs(log).length, before);
    const data = await graph(other);
    assert.ok(data.current_projects.includes(project));
    assert.ok(data.links.some(l => l.relation === 'shared_source' && l.state === 'linked'));
    const original = fs.readFileSync(output.path, 'utf8');
    assert.match(original, /An original draft/);
  });

  await test('an agent can propose a meaningful typed connection without approving it', async () => {
    const proposal = JSON.stringify({ project: 'economics', relation: 'challenges', reason: 'The reading challenges the cost assumptions in the economics project.' });
    await POST(base, '/reply', { url: pdf, text: '@claude Compare these arguments. [mock:says:A connection is worth checking.\\n\\nproject-link: ' + proposal + ']' });
    await waitFor(async () => (await graph(pdf)).links.some(l => l.relation === 'challenges'), 'agent proposal');
    const link = (await graph(pdf)).links.find(l => l.relation === 'challenges');
    assert.equal(link.state, 'suggested'); assert.equal(link.origin, 'agent');
    const page = (await GET(base, '/page?url=' + encodeURIComponent(pdf))).json;
    assert.ok(page.page_chat.some(m => m.author === 'claude' && m.text.includes('Suggested a project connection:')));
  });

  await test('Council sees the same records, and a dismissal there is visible in Discuss', async () => {
    const result = await councilHarness.startServer({ root: council, env: {
      COUNCIL_BRIDGE_CMD: JSON.stringify([process.execPath, path.resolve(here, '../../../tests/fixtures/fake-council-bridge.mjs'), path.join(council, 'council-rx')]),
    } });
    const shared = (await GET(result.base, '/project-network')).json;
    assert.ok(shared.outputs.some(o => o.id === output.id));
    const link = shared.links.find(l => l.relation === 'shared_source');
    assert.ok(link);
    assert.equal((await POST(result.base, '/project-network/edge', { id: link.id, action: 'dismiss' })).status, 200);
    assert.equal((await graph(other)).links.find(l => l.id === link.id).state, 'dismissed');
    assert.equal((await GET(result.base, '/project-network/view')).status, 200);
  });

  await test('guest and unconfirmed-root requests cannot read or change project records', async () => {
    const guest = { host: 'shared.example', authorization: 'Bearer network-test', 'x-plugin-handle': 'guest' };
    assert.equal((await GET(base, '/project-network', guest)).status, 403);
    assert.equal((await POST(base, '/project-network/link', { url: other, project }, guest)).status, 403);
    assert.equal((await GET(base, '/project-network?root=' + encodeURIComponent(work))).status, 400);
  });
} finally { web.closeAllConnections(); web.close(); councilHarness.cleanup(); h.cleanup(); }
console.log(`project-network: ${h.passed()} passed, ${h.failures().length} failed`);
process.exitCode = h.failures().length ? 1 : 0;
