// Durable project/source/output relationships. Files remain canonical; this
// is a rebuildable index plus explicit human links and use evidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DB = fileURLToPath(new URL('./project-network-db.py', import.meta.url));
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
const read = (p, limit = 16000) => { try { const fd = fs.openSync(p, 'r'); try {
  const buf = Buffer.alloc(limit); return buf.subarray(0, fs.readSync(fd, buf, 0, limit, 0)).toString('utf8');
} finally { fs.closeSync(fd); } } catch { return ''; } };
const json = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
export const projectIdOK = id => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,160}$/.test(String(id || '')) && !String(id).includes('..');
export const sourceId = url => 's-' + hash(url);
export const outputId = file => 'o-' + hash(path.resolve(file));
const linkId = (a, b, relation) => 'l-' + hash([...new Set([a, b])].sort().join('|') + '|' + relation);
export const RELATIONS = ['related', 'supports', 'challenges', 'extends', 'depends_on', 'shared_source'];

export function records(root, actions = []) {
  const r = spawnSync(process.env.BOTFERENCE_PYTHON_BIN || process.env.PLUGIN_PYTHON || 'python3',
    [DB, path.join(root, '.botference', 'project-network.sqlite')], {
      input: JSON.stringify({ actions }), encoding: 'utf8', timeout: 8000, maxBuffer: 12 * 1024 * 1024,
    });
  let data;
  try { data = JSON.parse(r.stdout); } catch { throw new Error('The project index could not be read. Your files and chats are unchanged.'); }
  if (r.status !== 0 || data.error) throw new Error(data.error || 'Project index unavailable');
  return data;
}

export function catalog(root) {
  const portfolio = json(path.join(root, 'projects/portfolio.json'), {}).projects || [];
  const byId = new Map(portfolio.map(p => [p.id, p]));
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(root, 'projects'), { withFileTypes: true }); } catch { }
  return dirs.filter(d => d.isDirectory() && !d.name.startsWith('.') && projectIdOK(d.name)).slice(0, 2000).map(d => {
    const meta = byId.get(d.name) || {};
    const text = read(path.join(root, 'projects', d.name, 'PROJECT.md'), 5000);
    const tasks = read(path.join(root, 'projects', d.name, 'TASKS.md'), 2000);
    const prose = text.split('\n').filter(l => !/^#|^\*\*(Status|Priority|Cadence)|^TODO\s*$/i.test(l)).join('\n').trim();
    return { id: d.name, title: meta.title || /^#\s+(.+)$/m.exec(text)?.[1] || d.name,
      status: meta.status || 'active', summary: [meta.why, meta.desired_outcome, prose, tasks].filter(v => v && v !== 'TODO').join('\n').slice(0, 6000) };
  });
}

const syncTimes = new Map();
export function syncProjects(root, { force = false } = {}) {
  if (!force && Date.now() - (syncTimes.get(root) || 0) < 15000) return records(root);
  const rows = catalog(root);
  const state = records(root, rows.map(p => ({ kind: 'projects', id: p.id, data: p, event: 'catalog' })));
  syncTimes.set(root, Date.now());
  return state;
}

export function sourceRecord(page) {
  const messages = [...(page.page_chat || []), ...(page.threads || []).flatMap(t => t.msgs || [])];
  const human = messages.filter(m => m && !m.kind && !['claude', 'codex', 'agent', 'botference', 'gemini', 'system'].includes(m.author));
  const excerpt = human.slice(-20).map(m => String(m.text || '')).join('\n').slice(-10000);
  return { id: sourceId(page.url), url: page.url, title: page.title || page.url, kind: page.kind || 'article',
    excerpt, revision: hash(excerpt), page_key: crypto.createHash('sha1').update(page.url).digest('hex'),
    ...(page.updated_at ? { page_updated_at: page.updated_at } : {}),
    ...(page.network_record_path ? { record_path: page.network_record_path } : {}),
    ...(page.network_snapshot_path ? { snapshot_path: page.network_snapshot_path } : {}),
    ...(page.session_id ? { latest_session: page.session_id } : {}) };
}

export function indexSource(root, page, projects = []) {
  const source = sourceRecord(page);
  return records(root, [{ kind: 'sources', id: source.id, data: source,
    union: { projects: projects.filter(projectIdOK), chats: page.session_id ? [page.session_id] : [] }, event: 'reading' }]);
}

export function linkSource(root, page, project, { output = '', attach = true, actor = 'user' } = {}) {
  if (!projectIdOK(project) || !catalog(root).some(p => p.id === project)) throw new Error('Unknown project');
  const state = syncProjects(root);
  if (output && !state.outputs.some(o => o.id === output && o.projects?.includes(project))) throw new Error('Unknown output for that project');
  const source = sourceRecord(page);
  const action = { kind: 'sources', id: source.id, data: source, event: attach ? 'linked by user' : 'unlinked by user' };
  action[attach ? 'union' : 'remove'] = { projects: [project],
    ...(output ? { intended_outputs: [output] } : !attach
      ? { intended_outputs: state.outputs.filter(o => o.projects?.includes(project)).map(o => o.id) } : {}) };
  action.union = { ...(action.union || {}), chats: page.session_id ? [page.session_id] : [] };
  // Filing is an explicit user act; it does not assert that two claims agree.
  const actions = [action];
  if (attach && actor === 'user') for (const other of state.sources.find(s => s.id === source.id)?.projects || []) {
    if (other !== project) actions.push(linkAction(other, project, 'shared_source', 'linked',
      `You linked “${source.title}” to both projects.`, 'user', source.id));
  }
  return records(root, actions);
}

function linkAction(a, b, relation, state, reason, origin, source = '') {
  if (a === b || !projectIdOK(a) || !projectIdOK(b) || !RELATIONS.includes(relation)) throw new Error('Invalid project connection');
  const id = linkId(a, b, relation);
  return { kind: 'links', id, proposal: state === 'suggested', event: state,
    data: { a, b, relation, state, reason: String(reason).slice(0, 1200), origin, ...(source ? { source } : {}) } };
}

export function propose(root, { a, b, relation = 'related', reason, source = '', origin = 'agent' }) {
  const ids = new Set(catalog(root).map(p => p.id));
  if (!ids.has(a) || !ids.has(b) || !String(reason || '').trim()) throw new Error('A connection needs two known projects and a reason');
  const state = records(root), action = linkAction(a, b, relation, 'suggested', reason, origin, source);
  action.data.evidence_versions = Object.fromEntries(state.outputs.filter(o => o.projects?.some(p => p === a || p === b)).slice(0, 20).map(o => [o.id, o.revision]));
  action.data.source_revision = state.sources.find(s => s.id === source)?.revision || '';
  return records(root, [action]);
}

export function changeLink(root, id, action) {
  const state = records(root); const link = state.links.find(l => l.id === id);
  if (!link || !['dismiss', 'restore', 'link'].includes(action)) throw new Error('Unknown connection or action');
  return records(root, [{ kind: 'links', id, data: {
    state: action === 'dismiss' ? 'dismissed' : action === 'restore' ? 'suggested' : 'linked',
    ...(action === 'link' ? { origin: 'user', reason: `Linked by you. ${link.reason}` } : {}),
  }, event: action }]);
}

export function forgetSource(root, url) {
  const state = records(root), id = sourceId(url);
  if (!state.sources.some(s => s.id === id)) return;
  const uses = state.uses.filter(u => u.source === id).map(u => u.id);
  const actions = [{ kind: 'sources', id, delete: true }, ...uses.map(id => ({ kind: 'uses', id, delete: true }))];
  for (const output of state.outputs) if (output.sources?.includes(id)) actions.push({ kind: 'outputs', id: output.id, remove: { sources: [id] } });
  for (const link of state.links) {
    if (link.source !== id && !(link.uses || []).some(u => uses.includes(u))) continue;
    const remaining = (link.uses || []).filter(u => !uses.includes(u));
    actions.push(remaining.length
      ? { kind: 'links', id: link.id, data: { source: '', reason: 'Shared use; inspect the remaining evidence.' }, remove: { uses } }
      : { kind: 'links', id: link.id, delete: true });
  }
  records(root, actions);
}

export function registerOutput(root, { file, allowedRoot, title, url = '', project = '', page = null }) {
  const actual = fs.realpathSync(file), allowed = fs.realpathSync(allowedRoot);
  if (!actual.startsWith(allowed + path.sep) || !/\.(md|markdown|tex|html?|ipynb)$/i.test(actual)) throw new Error('Output is outside its authorized content folder');
  if (project && !catalog(root).some(p => p.id === project)) throw new Error('Unknown output project');
  const text = read(actual, 200000);
  const id = outputId(actual);
  const old = records(root).outputs.find(o => o.id === id);
  const revision = hash(fs.readFileSync(actual));
  const data = { path: actual, allowed_root: allowed, title: title || old?.title || path.basename(actual), url: url || old?.url || '',
    revision, summary: text.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 5000),
    kind: /\.tex$/i.test(actual) ? 'paper' : 'document', missing: false };
  const actions = [{ kind: 'outputs', id, data, union: { projects: project ? [project] : [], sources: page ? [sourceId(page.url)] : [] }, event: 'output revision' }];
  if (page) actions.push({ kind: 'sources', id: sourceId(page.url), data: sourceRecord(page),
    union: { projects: project ? [project] : [] }, event: 'output source' });
  let state = records(root, actions);
  state = observeUse(root, id, text, revision, state);
  return { output: state.outputs.find(o => o.id === id), state };
}

function observeUse(root, id, text, revision, state) {
  // source_url metadata and generated comments are provenance, not citations.
  const original = text;
  const frontLength = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0].length || 0;
  text = text.slice(frontLength).replace(/<!--[\s\S]*?-->/g, s => s.replace(/[^\n]/g, ' '));
  const output = state.outputs.find(o => o.id === id);
  const actions = [];
  for (const source of state.sources) {
    if (!/^https?:\/\//.test(source.url)) continue;
    const escaped = source.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = new RegExp(escaped + '(?=$|[\\s\\)\\]"\'<>?#&])').exec(text)?.index ?? -1;
    const useId = 'u-' + hash(id + '|' + source.id);
    const old = state.uses.find(u => u.id === useId);
    if (at < 0) {
      if (old?.active) actions.push({ kind: 'uses', id: useId, data: { active: false, checked_revision: revision }, event: 'citation removed' });
      continue;
    }
    const directed = source.intended_outputs?.includes(id) || false;
    const absoluteAt = frontLength + at;
    const evidence = { output: id, source: source.id, revision,
      active: true, human_directed: directed, line: original.slice(0, absoluteAt).split('\n').length,
      excerpt: original.slice(Math.max(frontLength, absoluteAt - 140), Math.min(original.length, absoluteAt + source.url.length + 140)) };
    if (!old || Object.entries(evidence).some(([k, v]) => old[k] !== v)) actions.push({ kind: 'uses', id: useId, data: evidence, event: 'citation observed' });
    if (!directed) continue; // Generated co-citation is not human validation.
    for (const a of output.projects || []) for (const b of source.projects || []) if (a !== b) {
      const action = linkAction(a, b, 'shared_source', 'used',
        `You asked to use “${source.title}” in “${output.title}”; the current file cites it.`, 'human-directed use', source.id);
      const existing = state.links.find(l => l.id === action.id);
      if (existing?.state !== 'dismissed' && (existing?.state !== 'used' || !existing.uses?.includes(useId))) {
        actions.push({ ...action, union: { uses: [useId] }, respect_dismissal: true });
      }
    }
  }
  return actions.length ? records(root, actions) : state;
}

export function refreshOutputs(root) {
  let state = syncProjects(root);
  for (const output of state.outputs.filter(o => o.projects?.length).slice(0, 300)) {
    if (!fs.existsSync(output.path)) {
      if (!output.missing) state = records(root, [{ kind: 'outputs', id: output.id, data: { missing: true }, event: 'file missing' }]);
      continue;
    }
    const actual = fs.realpathSync(output.path);
    if (!actual.startsWith(fs.realpathSync(output.allowed_root) + path.sep)) continue;
    const revision = hash(fs.readFileSync(actual));
    if (revision !== output.revision || output.missing) {
      state = registerOutput(root, { file: actual, allowedRoot: output.allowed_root, title: output.title, url: output.url }).state;
    } else state = observeUse(root, output.id, read(actual, 200000), revision, state);
  }
  return state;
}

export function discoverOutputs(root, outputs) {
  return records(root, outputs.slice(0, 4000).map(o => ({ kind: 'outputs', id: outputId(o.path),
    data: { title: o.title, path: o.path, url: o.url || '', allowed_root: o.allowed_root,
      kind: o.kind || 'document' }, event: 'output catalog' })));
}

const STOP = new Set('the and that this with from have will your about project work what when into which their they them were been are for not but you our can its all more how some new use using status active weekly priority cadence todo desired outcome next action matters completed'.split(' '));
export function terms(text) {
  const out = new Set();
  for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) || []) if (!STOP.has(word)) out.add(word);
  return out;
}

function features(state) {
  const df = new Map();
  const rows = state.projects.map(p => {
    const text = p.title + '\n' + p.summary + '\n' + state.outputs.filter(o => o.projects?.includes(p.id)).map(o => o.summary).join('\n').slice(0, 10000);
    const words = terms(text);
    for (const word of words) df.set(word, (df.get(word) || 0) + 1);
    return { p, text, words };
  });
  return { rows, weight: w => Math.log(1 + rows.length / (1 + (df.get(w) || 0))) ** 2 };
}

export function candidateProjects(state, text, exclude = [], limit = 5, index = features(state)) {
  const query = terms(text), rows = [];
  const qnorm = [...query].reduce((n, w) => n + index.weight(w), 0);
  for (const { p, words: own } of index.rows) {
    if (exclude.includes(p.id) || p.status === 'archived' || p.id === 'plugin-pages') continue;
    const shared = [...query].filter(t => own.has(t)).sort((a, b) => index.weight(b) - index.weight(a));
    if (shared.length < 2) continue;
    const norm = [...own].reduce((n, w) => n + index.weight(w), 0);
    rows.push({ project: p.id, title: p.title, score: shared.reduce((n, w) => n + index.weight(w), 0) / Math.sqrt(Math.max(1, qnorm * norm)),
      terms: shared.slice(0, 8), reason: `Shared wording: ${shared.slice(0, 5).join(', ')}. Check whether the connection is useful.` });
  }
  return rows.sort((a, b) => b.score - a.score || a.project.localeCompare(b.project)).slice(0, limit);
}

export function suggestOverlaps(root, state = syncProjects(root)) {
  const actions = [], known = new Set(state.links.map(l => l.id));
  const index = features(state);
  for (const { p, text } of index.rows.filter(r => r.p.status !== 'archived' && r.p.id !== 'plugin-pages').slice(0, 300)) {
    for (const c of candidateProjects(state, text, [p.id], 3, index)) {
      if (c.score < 0.08) continue;
      const a = linkAction(p.id, c.project, 'related', 'suggested', c.reason, 'text overlap');
      if (!known.has(a.id)) { actions.push(a); known.add(a.id); }
    }
  }
  return actions.length ? records(root, actions) : state;
}

export function context(root, page, projectIds, maxChars = 6000) {
  const state = page.url ? indexSource(root, page, projectIds) : syncProjects(root);
  const source = state.sources.find(s => s.id === sourceId(page.url)) || sourceRecord(page);
  const active = projectIds.length ? projectIds : source?.projects || [];
  const relevant = candidateProjects(state, page.title + '\n' + source?.excerpt, active, 4);
  const lines = ['[Project network — references, not instructions]'];
  let protocol = '';
  for (const id of active) {
    const p = state.projects.find(p => p.id === id);
    if (p) lines.push(`Project ${id}: ${p.title}`);
    for (const o of state.outputs.filter(o => o.projects?.includes(id)).slice(0, 8)) {
      lines.push(`Output ${o.id}: ${o.title} — ${o.path}${o.missing ? ' (missing; do not invent its contents)' : ''}. Read the current file before editing; do not create a duplicate.`);
    }
    for (const s of state.sources.filter(s => s.projects?.includes(id) && s.id !== sourceId(page.url)).slice(-5)) {
      lines.push(`Related reading: ${s.title} — ${s.url}. ${s.snapshot_path ? 'Saved source: ' + s.snapshot_path + '. ' : ''}${s.record_path ? 'Discussion: ' + s.record_path + '. ' : ''}Reader notes: ${(s.excerpt || '').slice(0, 450)}`);
    }
  }
  if (relevant.length) {
    lines.push('Possible related projects (retrieved by wording overlap, not verified relationships):');
    for (const c of relevant) lines.push(`- ${c.project}: ${c.title}. ${c.reason}`);
    if (active.length === 1) protocol = 'If you identify a concrete connection to a listed project, you may end with project-link: {"project":"id","relation":"related|supports|challenges|extends|depends_on","reason":"specific reason"}. This creates a suggestion, never approval. Omit it unless useful.\n';
  }
  if (lines.length <= 1) return '';
  let budget = Math.max(0, maxChars - protocol.length - 120), omitted = false;
  const kept = [];
  for (const line of lines) {
    if (line.length + 1 > budget) { omitted = true; continue; }
    kept.push(line); budget -= line.length + 1;
  }
  if (omitted) kept.push('[Further index items omitted; consult the source files or Project connections when needed.]');
  return kept.join('\n') + '\n[end project network]\n' + protocol;
}

export function parseProposal(text) {
  const match = /^project-link:\s*(\{[^\n]+\})\s*$/mi.exec(String(text || ''));
  if (!match) return null;
  try { const data = JSON.parse(match[1]); return projectIdOK(data.project) && RELATIONS.includes(data.relation) && typeof data.reason === 'string'
    ? { ...data, line: match[0] } : null; } catch { return null; }
}

export function parseLinkIntent(text) {
  const s = String(text || '').trim().replace(/^@(claude|codex|all)\s+/i, '')
    .replace(/^(?:hey[, ]+)?(?:please\s+|could you\s+|can you\s+)?/i, '');
  const m = /^(?:link|add|connect)\s+(?:this\s+)?(?:reading|page|pdf|chat|article)\s+to\s+(.+?)[.!]?$/i.exec(s)
    || /^use\s+(?:this\s+)?(?:reading|page|pdf|article)\s+in\s+(.+?)[.!]?$/i.exec(s);
  return m ? m[1].replace(/^["“]|["”]$/g, '').trim() : null;
}

export function resolveTarget(state, query) {
  const norm = s => String(s || '').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const want = norm(query);
  const rows = [...state.projects.map(p => ({ kind: 'project', id: p.id, title: p.title, project: p.id })),
    ...state.outputs.flatMap(o => (o.projects || []).map(project => ({ kind: 'output', id: o.id, title: o.title, project, path: o.path, url: o.url })))];
  const exact = rows.filter(r => [r.id, r.title, r.path, r.url].some(s => s && norm(s) === want));
  if (exact.length) {
    const outputs = exact.filter(r => r.kind === 'output');
    if (outputs.length === 1 && exact.every(r => r.kind === 'output' || r.id === outputs[0].project)) return outputs;
    return exact;
  }
  return rows.filter(r => want.length > 3 && norm(r.title).includes(want)).slice(0, 8);
}

export function view(root, { source = '', refresh = false } = {}) {
  const state = suggestOverlaps(root, refresh ? refreshOutputs(root) : syncProjects(root));
  const existing = new Set(catalog(root).map(p => p.id));
  return { ...state, projects: state.projects.filter(p => existing.has(p.id)).map(p => ({ ...p, summary: p.summary?.slice(0, 600) })),
    sources: state.sources.map(({ excerpt, ...s }) => ({ ...s, excerpt: excerpt?.slice(0, 300) })),
    outputs: state.outputs.map(({ summary, ...o }) => o),
    links: state.links.filter(l => existing.has(l.a) && existing.has(l.b)).map(l => ({ ...l,
      stale: (l.state === 'used' && !(l.uses || []).some(id => state.uses.some(u => u.id === id && u.active && u.human_directed)))
        || (l.origin === 'agent' && (Object.entries(l.evidence_versions || {}).some(([id, rev]) => state.outputs.find(o => o.id === id)?.revision !== rev)
          || (l.source_revision && state.sources.find(s => s.id === l.source)?.revision !== l.source_revision))),
    })), current_source: source, root };
}
