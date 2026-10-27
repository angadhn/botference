import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as graph from '../frontends/shared/project-network.mjs';
import { layout } from '../frontends/shared/network-ui/network.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-network-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = (id, title, body) => {
    const dir = path.join(root, 'projects', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), `# ${title}\n\n${body}`);
    return dir;
  };
  const a = project('education', 'Education costs', 'Teaching institutions degree assessment costs');
  project('coordination', 'Institutional coordination', 'Institutions degree assessment administration costs');
  project('stations', 'Space stations', 'Inflatable orbital habitats radiation docking');
  graph.syncProjects(root);
  return { root, a };
}

test('ordinary reading records do not create projects; one project has multiple outputs', t => {
  const { root, a } = fixture(t);
  const page = { url: 'https://example.test/article', title: 'Article', page_chat: [{ author: 'reader', text: 'My view' }], session_id: 'chat-one' };
  graph.indexSource(root, page);
  assert.deepEqual(graph.records(root).sources[0].projects, []);
  for (const file of ['essay.md', 'paper.tex']) {
    const p = path.join(a, file); fs.writeFileSync(p, 'Draft text');
    graph.registerOutput(root, { file: p, allowedRoot: a, project: 'education', title: file });
  }
  assert.equal(graph.records(root).outputs.filter(o => o.projects.includes('education')).length, 2);
  assert.equal(graph.catalog(root).length, 3);
});

test('a generated citation stays provisional until human-directed use; removal marks evidence stale', t => {
  const { root, a } = fixture(t);
  const page = { url: 'https://example.test/source', title: 'Evidence', page_chat: [] };
  graph.linkSource(root, page, 'coordination');
  const file = path.join(a, 'essay.md');
  fs.writeFileSync(file, `---\nsource_url: ${page.url}\n---\n\nNo citation yet.`);
  const { output } = graph.registerOutput(root, { file, allowedRoot: a, project: 'education' });
  assert.equal(graph.records(root).uses.length, 0, 'front matter is not evidence of use');
  graph.propose(root, { a: 'education', b: 'coordination', relation: 'supports', reason: 'A possible supporting argument.' });
  fs.writeFileSync(file, `[Read this](${page.url}).`);
  graph.refreshOutputs(root);
  assert.equal(graph.records(root).uses[0].human_directed, false);
  assert.equal(graph.records(root).links[0].state, 'suggested');
  graph.linkSource(root, page, 'education', { output: output.id });
  graph.refreshOutputs(root);
  const state = graph.records(root);
  assert.equal(state.links.find(l => l.relation === 'shared_source').state, 'used');
  assert.equal(state.links.find(l => l.relation === 'supports').state, 'suggested', 'co-use does not establish agreement');
  const used = state.links.find(l => l.relation === 'shared_source');
  graph.changeLink(root, used.id, 'dismiss');
  graph.refreshOutputs(root);
  assert.equal(graph.records(root).links.find(l => l.id === used.id).state, 'dismissed', 'background observations must respect dismissal');
  graph.changeLink(root, used.id, 'restore');
  graph.refreshOutputs(root);
  fs.writeFileSync(file, 'The source is no longer cited.');
  const refreshed = graph.view(root, { refresh: true });
  assert.equal(refreshed.links.find(l => l.relation === 'shared_source').stale, true);
});

test('dismissals survive regenerated suggestions and no file is changed by linking', t => {
  const { root, a } = fixture(t);
  graph.propose(root, { a: 'education', b: 'coordination', reason: 'Shared concern', relation: 'related' });
  const id = graph.records(root).links[0].id;
  graph.changeLink(root, id, 'dismiss');
  graph.propose(root, { a: 'education', b: 'coordination', reason: 'Another guess', relation: 'related' });
  assert.equal(graph.records(root).links[0].state, 'dismissed');
  const file = path.join(a, 'draft.md'); fs.writeFileSync(file, 'My exact prose.');
  const before = fs.readFileSync(file);
  graph.registerOutput(root, { file, allowedRoot: a, project: 'education' });
  assert.deepEqual(fs.readFileSync(file), before);
  const outside = path.join(root, 'private.md'); fs.writeFileSync(outside, 'outside');
  assert.throws(() => graph.registerOutput(root, { file: outside, allowedRoot: a, project: 'education' }), /outside/);
});

test('natural link requests are explicit and ambiguous names stay ambiguous', t => {
  const { root } = fixture(t);
  assert.equal(graph.parseLinkIntent('@claude Please link this reading to Education costs.'), 'Education costs');
  assert.equal(graph.parseLinkIntent('What if we link this reading to a project?'), null);
  assert.equal(graph.parseLinkIntent('The article says to link this reading to Education costs'), null);
  assert.equal(graph.resolveTarget(graph.records(root), 'Education costs').length, 1);
  const data = { projects: [{ id: 'one', title: 'Education costs A' }, { id: 'two', title: 'Education costs B' }], outputs: [] };
  assert.equal(graph.resolveTarget(data, 'Education costs').length, 2);
});

test('an older source snapshot cannot overwrite newer notes, while memberships still merge', t => {
  const { root } = fixture(t);
  const page = { url: 'https://example.test/source', title: 'Reading', updated_at: '2026-10-27T10:00:00Z', page_chat: [{ author: 'reader', text: 'New conclusion' }] };
  graph.indexSource(root, page, ['education']);
  graph.indexSource(root, { ...page, updated_at: '2026-10-26T10:00:00Z', page_chat: [{ author: 'reader', text: 'Old conclusion' }] }, ['coordination']);
  const source = graph.records(root).sources[0];
  assert.equal(source.excerpt, 'New conclusion');
  assert.deepEqual(source.projects.sort(), ['coordination', 'education']);
});

test('deleting a reading removes its cached notes and dependent evidence without deleting outputs', t => {
  const { root, a } = fixture(t);
  const page = { url: 'https://example.test/private', title: 'Private reading', page_chat: [{ author: 'reader', text: 'Personal notes' }] };
  graph.linkSource(root, page, 'coordination');
  const file = path.join(a, 'essay.md'); fs.writeFileSync(file, `[Source](${page.url})`);
  const output = graph.registerOutput(root, { file, allowedRoot: a, project: 'education', page }).output;
  graph.linkSource(root, page, 'education', { output: output.id }); graph.refreshOutputs(root);
  graph.forgetSource(root, page.url);
  const state = graph.records(root);
  assert.equal(state.sources.length, 0); assert.equal(state.uses.length, 0); assert.equal(state.links.length, 0);
  assert.ok(fs.existsSync(file)); assert.equal(state.outputs.length, 1);
});

test('retrieval and layout are bounded, deterministic and preserve disconnected projects', t => {
  const { root } = fixture(t);
  const state = graph.records(root);
  const candidates = graph.candidateProjects(state, 'teaching institutions assessment costs', ['education']);
  assert.equal(candidates[0].project, 'coordination');
  const view = graph.view(root);
  const positions = layout(view.projects, view.links);
  assert.deepEqual(positions, layout(view.projects, view.links));
  assert.equal(positions.length, 3);
  assert.ok(positions.every(p => Number.isFinite(p.x) && p.x >= 100 && p.x <= 800 && p.y >= 65 && p.y <= 535));
  const ctx = graph.context(root, { url: '', title: 'assessment', page_chat: [] }, ['education'], 700);
  assert.ok(ctx.length < 750);
});

test('independent processes can update the shared SQLite store without losing links', async t => {
  const { root } = fixture(t);
  const module = new URL('../frontends/shared/project-network.mjs', import.meta.url).href;
  await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const code = `import {indexSource} from ${JSON.stringify(module)}; indexSource(${JSON.stringify(root)}, {url:'https://example.test/${i}',title:'Source ${i}',page_chat:[]}, ['education']);`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let error=''; p.stderr.on('data', x => error += x); p.on('exit', code => code ? reject(new Error(error)) : resolve());
  })));
  assert.equal(graph.records(root).sources.length, 6);
});
