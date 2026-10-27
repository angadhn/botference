// Discuss adapter: use the same council records without moving source chats
// or the site's canonical files into another workspace.
import path from 'node:path';
import crypto from 'node:crypto';
import * as graph from '../shared/project-network.mjs';
import * as workspace from './workspace.mjs';
import * as store from './store.mjs';
import * as blog from './blog.mjs';

function withReferences(page) {
  const key = store.pageKey(page.url);
  return { ...page, network_record_path: path.join(store.DIR, 'pages', key + '.json'),
    ...(store.hasSnapshot(key) ? { network_snapshot_path: store.snapshotFile(key) } : {}) };
}

export function roots() {
  const preferred = store.readConfig().last_council_root;
  return workspace.knownCouncilRoots().filter(r => workspace.rootState(r) === 'yes')
    .sort((a, b) => (b === preferred ? 1 : 0) - (a === preferred ? 1 : 0));
}
export function rootFor(page, requested = '') {
  const available = roots();
  if (requested) {
    const r = workspace.realish(requested);
    if (!available.includes(r)) throw new Error('That council is not confirmed');
    return r;
  }
  const attached = store.projectsOf(page).map(p => p.root).filter(r => available.includes(r));
  const distinct = [...new Set(attached)];
  if (distinct.length === 1) return distinct[0];
  if (available.length === 1) return available[0];
  const selected = store.readConfig().last_council_root;
  if (available.includes(selected)) return selected;
  throw new Error(available.length ? 'Choose a council for these project records' : 'Confirm a council first to use project connections');
}

const discovered = new Map();
export function discover(root, force = false) {
  graph.syncProjects(root, { force });
  if (!force && Date.now() - (discovered.get(root) || 0) < 30000) return;
  const outputs = [], seen = new Set();
  for (const site of blog.listSites()) {
    if (blog.rootState(site.root) !== 'yes' || seen.has(site.root)) continue;
    seen.add(site.root);
    for (const doc of blog.indexOf(site.root, site.kind).docs) {
      if (!doc.rel.startsWith('_notes/') || !doc.urls?.length) continue;
      outputs.push({ path: doc.path, title: doc.title, url: site.serve_origin + doc.urls[0], allowed_root: site.root });
    }
  }
  if (outputs.length) graph.discoverOutputs(root, outputs);
  discovered.set(root, Date.now());
}

function newProject(root, title, identity) {
  const base = String(title || 'Writing project').slice(0, workspace.PROJECT_TITLE_MAX - 7);
  let made = workspace.createProject(root, { title: base, why: 'Work emerging from a reading conversation; outputs and source discussions are linked in Project connections.' });
  if (!made.ok && made.status === 409) {
    const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 6);
    made = workspace.createProject(root, { title: base + ' ' + suffix });
    if (!made.ok && made.status === 409) {
      const id = workspace.slugifyProject(base + ' ' + suffix);
      made = { ok: true, id };
    }
  }
  if (!made.ok) throw new Error(made.error);
  graph.syncProjects(root, { force: true });
  return made.id;
}

export function observeOutput(page, site, post, { create = false } = {}) {
  page = withReferences(page);
  const root = rootFor(page);
  discover(root);
  const existing = graph.records(root).outputs.find(o => o.id === graph.outputId(post.path || post.source_path));
  const filed = store.projectsOf(store.readPage(page.url) || page).filter(p => p.root === root);
  let project = existing?.projects?.[0] || (filed.length === 1 ? filed[0].id : '');
  if (!project && !filed.length && create) project = newProject(root, post.title, post.path || post.source_path);
  if (project) {
    store.filePageInProject(page.url, { root, id: project });
    if (store.readPage(post.url)) store.filePageInProject(post.url, { root, id: project });
  }
  const result = graph.registerOutput(root, { file: post.path || post.source_path, allowedRoot: site.root,
    title: post.title, url: post.url, project, page });
  return { root, project, output: result.output };
}

export function pageView(page, requested = '', refresh = false) {
  page = withReferences(page);
  const root = rootFor(page, requested);
  discover(root, refresh);
  const projects = store.projectsOf(page).filter(p => p.root === root).map(p => p.id);
  graph.indexSource(root, page, projects);
  const data = graph.view(root, { source: graph.sourceId(page.url), refresh });
  const s = graph.sourceRecord(page);
  return { ...data, roots: roots(), current_projects: projects,
    candidates: graph.candidateProjects(graph.records(root), s.title + '\n' + s.excerpt, projects) };
}

export function link(page, { root: requested = '', project, output = '', attach = true }) {
  page = withReferences(page);
  const root = rootFor(page, requested);
  discover(root);
  let state = graph.records(root);
  if (output) {
    const target = state.outputs.find(o => o.id === output);
    if (!target) throw new Error('Unknown output');
    project ||= target.projects?.[0] || newProject(root, target.title, target.path);
    graph.registerOutput(root, { file: target.path, allowedRoot: target.allowed_root, title: target.title, url: target.url, project });
  }
  graph.linkSource(root, page, project, { output, attach });
  store.filePageInProject(page.url, { root, id: project, attach });
  // Intent was the user's action; observe whether the current output already
  // cites this reading. Future revisions will be checked again automatically.
  if (output) graph.refreshOutputs(root);
  return { root, project, output };
}

export function naturalLink(page, text) {
  const query = graph.parseLinkIntent(text);
  if (!query) return null;
  const root = rootFor(page); discover(root, true);
  const state = graph.records(root);
  // Unassigned blog outputs can acquire a project when the user links a reading.
  const targets = graph.resolveTarget(state, query);
  const norm = s => String(s || '').toLowerCase().replace(/[“”".!?]/g, '').trim();
  if (!targets.length) for (const o of state.outputs.filter(o => !o.projects?.length)) {
    if (norm(o.title) === norm(query) || o.path === query || o.url === query) targets.push({ kind: 'output', id: o.id, title: o.title });
  }
  if (targets.length !== 1) return { query, targets, text: targets.length
    ? 'Several matches: ' + targets.map(t => t.title).join('; ') + '. Choose one in Project connections.'
    : 'No project or output matched that name. Open Project connections to find it or create a project.' };
  const target = targets[0];
  const result = link(page, { root, project: target.project, output: target.kind === 'output' ? target.id : '' });
  return { ...result, text: `Linked this reading to “${target.title}”. Its discussion and source are now available through that project.` };
}

export function context(page) {
  page = withReferences(page);
  const root = rootFor(page); discover(root);
  const ids = store.projectsOf(page).filter(p => p.root === root).map(p => p.id);
  return graph.context(root, page, ids);
}

export function acceptProposal(page, text) {
  const proposal = graph.parseProposal(text);
  if (!proposal) return null;
  const root = rootFor(page);
  const filed = store.projectsOf(page).filter(p => p.root === root);
  if (filed.length !== 1) return null;
  graph.propose(root, { a: filed[0].id, b: proposal.project, relation: proposal.relation,
    reason: proposal.reason, source: graph.sourceId(page.url), origin: 'agent' });
  return proposal;
}

export function forgetSource(url) {
  for (const root of roots()) graph.forgetSource(root, url);
}

export { graph };
