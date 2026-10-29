const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// ── short titles ─────────────────────────────────────────────────────
// (titles.js and groups.js re-export these; the servers serve only network.js and network.css)
// Short display titles for the map: at most seven words, sentence case.
// Worked out in the browser each time; nothing is renamed. The full title
// stays in the side sheet and the hover tip.

// Chat openers that often become a project's title ("Hi there, I want you to…").
const OPENERS = [
  /^(hi|hello|hey)( there)?\b[\s,!.:;–—-]*/i,
  /^(so|ok|okay|right|well)\b[\s,]+/i,
  /^(i want|i'd like|i would like|i need|i'm hoping|i am hoping|i was hoping)( for)?( you)?( to)?\b[\s,]*/i,
  /^(can|could|would|will) you( please)?\b[\s,]*/i,
  /^(please|help me|let's|lets|let us)\b[\s,]*/i,
  /^(i'm|i am|i've been|i have been) (thinking about|trying to|working on|planning to|planning)\b\s*/i,
];
// Lead-ins that say nothing about the subject, dropped only from long titles.
const LEADINS = /^(working notes (for|on)|notes (on|for|about)|thoughts on|some thoughts on|a note on|an introduction to|introduction to)\s+/i;
// a cut title should not end mid-thought, on a word like "of" or "want"
const WEAK_END = new Set('a an the and or but so of to in on for with from by at as & into about vs i my our your is are was be will would can could want need like'.split(' '));
const MAX_WORDS = 7;

const words = s => s.split(/\s+/).filter(Boolean);
const counted = s => words(s).filter(w => /[\p{L}\p{N}]/u.test(w)); // dashes and lone symbols are not words
const keepCase = w => /\d/.test(w) || /^[^a-z]*[A-Z][^a-z]*[A-Z]/.test(w) || /^\p{Ll}+\p{Lu}/u.test(w); // AI, UKSA, 2040, iPhone

function sentenceCase(s) {
  const ws = words(s), long = ws.slice(1).filter(w => /^\p{L}{4,}/u.test(w));
  // Title Case Like This gets lowered; a title already in sentence case keeps its proper nouns
  const titleCased = long.length >= 2 && long.filter(w => /^\p{Lu}/u.test(w)).length / long.length >= 0.75;
  return ws.map((w, i) => {
    if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1);
    return titleCased && !keepCase(w) ? w.toLowerCase() : w;
  }).join(' ');
}

export function shortTitle(title, max = MAX_WORDS) {
  const original = String(title ?? '').replace(/\s+/g, ' ').trim();
  let s = original.replace(/[…]+$|\.{3,}$/, '').trim();
  for (let again = true; again;) { again = false; for (const re of OPENERS) { const t = s.replace(re, ''); if (t !== s) { s = t.trim(); again = true; } } }
  if (!counted(s).length) s = original.replace(/[…]+$/, '').trim(); // nothing but greeting: keep what there was
  if (counted(s).length > max) {
    const bare = s.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
    if (counted(bare).length) s = bare;
  }
  if (counted(s).length > max) {
    const head = s.split(/\s[—–-]\s|:\s|\?\s/)[0].trim();
    if (counted(head).length >= 2 && counted(head).length <= max) s = head;
  }
  if (counted(s).length > max) s = s.replace(LEADINS, '');
  let cut = false;
  if (counted(s).length > max) {
    const out = []; let n = 0;
    for (const w of words(s)) { if (/[\p{L}\p{N}]/u.test(w) && ++n > max) break; out.push(w); }
    while (out.length > 1 && (WEAK_END.has(out.at(-1).toLowerCase().replace(/[^\p{L}&]/gu, '')) || !/[\p{L}\p{N}]/u.test(out.at(-1)))) out.pop();
    s = out.join(' '); cut = true;
  }
  s = s.replace(/[\s,;:—–-]+$/, '');
  return sentenceCase(s) + (cut ? '…' : '');
}

// ── groups ───────────────────────────────────────────────────────────
// Loose groups for the project map. PROVISIONAL: these are guesses from the
// words in a project's title and summary, not a filing system. Nothing here
// is written back to projects. Correct a guess by adding the project's id to
// OVERRIDES; a project may sit in several groups.

export const GROUPS = [
  { id: 'writing', label: 'Writing' },
  { id: 'teaching', label: 'Teaching' },
  { id: 'research', label: 'Research & ventures' },
  { id: 'other', label: 'Other' },
];

// project id → group ids, first one is where it sits on the map
export const OVERRIDES = {
  conquistador: ['writing'], // a novel; nothing in the title says so
  'plugin-pages': ['other'],
};

const RULES = {
  writing: /\b(essays?|blog(s|ging)?|posts?|stor(y|ies)|fiction|novels?|drafts?|chapters?|books?|poe(m|ms|try)|memoir|writing|newsletter|history)\b/gi,
  teaching: /\b(teach(ing|es)?|lectures?|lecturing|courses?|modules?|students?|education|classroom|curriculum|syllabus|tutor(ial|ing)?s?|exams?|marking|seminars?|pedagogy)\b/gi,
  research: /\b(papers?|research|journals?|stud(y|ies)|engineering|space(craft|ship)?|orbit(s|al)?|satellites?|hypersonic|AI|probability|statistics|attention|hackathon|startups?|ventures?|compan(y|ies)|grants?|prototype|R&D|UKSA|lab|control|attitude|reproducibility|experiments?)\b/gi,
};
const hits = (re, text) => new Set((String(text || '').match(re) || []).map(w => w.toLowerCase())).size;

export function groupsFor(project, overrides = OVERRIDES) {
  if (overrides[project?.id]) return [...overrides[project.id]];
  const title = String(project?.title || project?.id || ''), summary = String(project?.summary || '');
  // a word in the title is enough; the summary is noisier, so it needs two different words
  const scored = Object.keys(RULES).map((id, order) => ({ id, order, t: hits(RULES[id], title), s: hits(RULES[id], summary) }))
    .filter(r => r.t > 0 || r.s >= 2)
    .sort((a, b) => (b.t - a.t) || (b.s - a.s) || (a.order - b.order));
  return scored.length ? scored.map(r => r.id) : ['other'];
}

// A paused or archived project is shuttered on the campus: still on its plot, not taking up attention.
export const SHUTTERED = new Set(['paused', 'archived']);
export const isShuttered = p => SHUTTERED.has(String(p?.status || '').toLowerCase());
// Only an explicit "active" counts against the budget. Finished work is not counted either;
// a missing or unrecognised status is shown as unknown, never guessed into one of the others.
const DONE = new Set(['done', 'complete', 'completed', 'finished']);
export function statusOf(p) {
  const s = String(p?.status ?? '').trim().toLowerCase();
  return s === 'active' ? 'active' : SHUTTERED.has(s) ? 'shut' : DONE.has(s) ? 'done' : 'unknown';
}
// the active-project limit is a budget of project count, not a measure of available time
export function capacityOf(projects, limit) {
  const n = { active: 0, shut: 0, done: 0, unknown: 0 }; for (const p of projects) n[statusOf(p)]++;
  limit = Number(limit) || 0; return { limit, ...n, room: limit ? limit - n.active : null };
}
// Readings whose page (or, lacking a page time, this map's record of them) was updated within
// `days`. Chat sessions carry no dates, so they are never counted: an updated page says nothing about which.
const DAY = 864e5;
export function recentReadings(sources, now = Date.now(), days = 30) {
  return sources.filter(s => { const t = Date.parse(s?.page_updated_at || s?.updated_at || ''); return Number.isFinite(t) && t <= now + DAY && now - t <= days * DAY; }).length;
}

const shortOf = t => shortTitle(t);
const groupsOf = p => { try { return groupsFor(p); } catch { return ['other']; } };
const groupList = () => GROUPS;
// only these relations read one way, so only these get an arrowhead (from a to b)
const DIRECTED = new Set(['depends_on', 'extends', 'challenges', 'supports']);

// ── force simulation ─────────────────────────────────────────────────
// Shared by layout() and the live map. Deterministic: seeds come from node
// order (a sunflower spiral), never Math.random, so the same input settles
// the same way. Alpha cools from 1 to ALPHA_MIN in about 180 ticks.
const ALPHA_MIN = 0.002, ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 180), VELOCITY_KEEP = 0.58, MAX_STEP = 14, REACH2 = 520 * 520, GRAVITY = 0.035, ANCHOR = 0.14;
const seed = (i, cx, cy, spread = 14) => { const r = spread * Math.sqrt(0.5 + i), a = i * Math.PI * (3 - Math.sqrt(5)); return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
const radius = n => n.kind === 'output' ? Math.min(5, 3 + 0.5 * Math.sqrt(n.deg)) : n.kind === 'source' ? Math.min(4.5, 2.7 + 0.5 * Math.sqrt(n.deg)) : Math.min(16, 5.5 + 1.7 * Math.sqrt(n.deg));
function makeSim(nodes, links, cx = 0, cy = 0, { edgeK = 1, gap = 3 } = {}) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const ls = links.map(l => ({ ...l, s: byId.get(l.a), t: byId.get(l.b) })).filter(l => l.s && l.t && l.s !== l.t);
  for (const n of nodes) n.deg = 0;
  for (const l of ls) { l.s.deg++; l.t.deg++; }
  nodes.forEach((n, i) => { if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) Object.assign(n, seed(i, cx, cy)); n.vx = n.vx || 0; n.vy = n.vy || 0; n.r = n.R || radius(n); });
  for (const l of ls) { l.rest = l.s.r + l.t.r + (l.kind === 'member' ? 26 : 110); l.k = (l.kind === 'member' ? 0.7 : (l.state === 'suggested' ? 0.35 : 0.8) * edgeK) / Math.min(l.s.deg, l.t.deg); l.bias = l.s.deg / (l.s.deg + l.t.deg); }
  return { nodes, links: ls, cx, cy, gap, alpha: 1, alphaTarget: 0 };
}
function tick(sim) {
  const { nodes, links, cx, cy } = sim, a = sim.alpha, n = nodes.length;
  for (let i = 0; i < n; i++) {
    const p = nodes[i], wp = p.r * 7;
    for (let j = i + 1; j < n; j++) {
      const q = nodes[j];
      let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
      if (d2 > REACH2) continue;
      if (d2 < 1e-6) { dx = 0.01 * (1 + (j - i) % 7); dy = 0.01; d2 = dx * dx + dy * dy; }
      const min = p.r + q.r + sim.gap, f = a / Math.max(d2, min * min * 0.5), wq = q.r * 7;
      p.vx -= dx * wq * f; p.vy -= dy * wq * f; q.vx += dx * wp * f; q.vy += dy * wp * f;
      if (d2 < min * min) { const d = Math.sqrt(d2), push = (min - d) / d * 0.25; p.vx -= dx * push; p.vy -= dy * push; q.vx += dx * push; q.vy += dy * push; }
    }
  }
  for (const l of links) {
    const { s, t } = l; let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy;
    const d = Math.hypot(dx, dy) || 1, k = (d - l.rest) / d * a * l.k; dx *= k; dy *= k;
    t.vx -= dx * l.bias; t.vy -= dy * l.bias; s.vx += dx * (1 - l.bias); s.vy += dy * (1 - l.bias);
  }
  for (const p of nodes) {
    if (p.fx != null) { p.x = p.fx; p.y = p.fy; p.vx = p.vy = 0; continue; }
    // a project with a group anchor is drawn to its group's region instead of the middle
    const k = p.ax != null ? ANCHOR : GRAVITY, ax = p.ax ?? cx, ay = p.ay ?? cy;
    p.vx = (p.vx + (ax - p.x) * k * a) * VELOCITY_KEEP; p.vy = (p.vy + (ay - p.y) * k * a) * VELOCITY_KEEP;
    const v = Math.hypot(p.vx, p.vy); if (v > MAX_STEP) { p.vx *= MAX_STEP / v; p.vy *= MAX_STEP / v; }
    p.x += p.vx; p.y += p.vy;
  }
  sim.alpha += (sim.alphaTarget - sim.alpha) * ALPHA_DECAY;
}
const cooled = sim => sim.alpha < ALPHA_MIN && sim.alphaTarget === 0;
function runToRest(sim) { for (let i = 0; i < 1000 && !cooled(sim); i++) tick(sim); }

export function layout(nodes, links, width = 900, height = 600) {
  const sim = makeSim(nodes.map(n => ({ ...n, x: NaN, y: NaN, vx: 0, vy: 0 })), links, width / 2, height / 2);
  runToRest(sim);
  return sim.nodes;
}

// ── wording ──────────────────────────────────────────────────────────
const KIND = { project: 'Project', output: 'Writing', source: 'Reading', chat: 'Chat' };
const REL = { related: 'is related to', supports: 'supports', challenges: 'challenges', extends: 'extends', depends_on: 'depends on', shared_source: 'draws on the same source as' };
const relText = r => REL[r] || String(r || 'related').replaceAll('_', ' ');
const ver = r => r ? String(r).slice(0, 8) : 'not indexed yet';
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function originText(l) {
  if (l.state === 'dismissed') return 'Dismissed by you';
  if (l.state === 'suggested') return 'Suggested by ' + (l.origin === 'agent' ? 'an agent' : l.origin === 'text overlap' ? 'wording overlap' : l.origin === 'user' ? 'you' : (l.origin || 'an agent'));
  if (l.state === 'used') return 'Validated by use in your writing';
  return l.origin === 'user' ? 'Linked by you' : 'Linked';
}
const lineKind = l => l.state === 'dismissed' ? 'dismissed' : l.state === 'suggested' ? 'suggested' : 'linked';
const glyph = cls => `<svg class="glyph" viewBox="0 0 28 6" aria-hidden="true"><line x1="1" y1="3" x2="27" y2="3" class="g-${cls}"/></svg>`;

// ── the page ─────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const svg = $('map'), sheet = $('detail'), tip = $('tip'), CAP = 600;
  const reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  document.documentElement.dataset.scheme = store.get('bf-network-scheme') || 'dark';
  // Where you are lives in the URL hash: the overview (view=map|city), the camera you see (cam=x,y,w),
  // filters that differ from the defaults (f=…) and the open project (project=id), whose entry also
  // keeps the camera of the overview it was opened from (back=x,y,w). Opening a
  // project adds a history entry, so the browser's Back returns to the overview and camera you
  // left, and a reload keeps your place. Older links (#project=, #link=, …) still work.
  const hash0 = new URLSearchParams(location.hash.slice(1));
  let root = new URLSearchParams(location.search).get('root') || '';
  let data = null, g = null, focus = null, selected = null;
  let pendingFocus = hash0.get('project'), pendingPick = hash0.get('link') ? { link: hash0.get('link') } : hash0.get('output') ? { output: hash0.get('output') } : hash0.get('source') ? { source: hash0.get('source') } : null;
  const viewName = v => v === 'city' || v === 'campus' ? 'city' : v === 'map' || v === 'regions' || v === 'discs' ? 'map' : null; // the city grew out of the campus; discs are gone
  let view = viewName(hash0.get('view')) || viewName(store.get('bf-network-view')) || 'map';
  const camOf = s => { const v = String(s || '').split(',').map(Number); return v.length === 3 && v.every(Number.isFinite) && v[2] > 0 ? { x: v[0], y: v[1], w: v[2] } : null; };
  let startCam = pendingFocus ? null : camOf(hash0.get('cam')); // a camera to restore once the overview is drawn
  let focusCam = pendingFocus ? camOf(hash0.get('cam')) : null; // the open project's framing, on a reload or Forward
  let backCam = pendingFocus ? camOf(hash0.get('back')) : null; // the overview camera the open project came from
  let cm = null; // the city as drawn, when that view is on
  let homeScale = 1, frame = 0, tween = null, autoFit = true, drag = null, pan = null, pinch = null, suppressClick = false, hovered = null;
  const vb = { x: -450, y: -300, w: 900, h: 600 };
  const pos = new Map(), pins = new Map(), pointers = new Map();

  async function request(url, body) {
    const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let d; try { d = await r.json(); } catch { throw new Error('Sign in to this workspace, then reopen Project connections.'); }
    if (!r.ok || d.ok === false) throw new Error(d.error || 'The request failed'); return d;
  }
  function say(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
  async function load(refresh = false) {
    say(refresh ? 'Re-reading files and looking for suggestions…' : 'Loading project records…'); $('refresh').disabled = true;
    try {
      data = await request('/project-network?root=' + encodeURIComponent(root) + (refresh ? '&refresh=1' : '')); root = data.root;
      data.outputs ||= []; data.sources ||= []; data.links ||= []; data.uses ||= []; data.projects ||= [];
      const roots = data.roots || [root];
      $('root').innerHTML = roots.map(r => `<option value="${esc(r)}">${esc(r.split('/').pop() || r)}</option>`).join(''); $('root').value = root; $('root').hidden = roots.length < 2;
      render();
    } catch (e) { say(e.message, true); } finally { $('refresh').disabled = false; }
  }
  const narrow = () => (window.innerWidth || 1000) <= 640;
  const outputsOf = id => data.outputs.filter(o => o.projects?.includes(id)), sourcesOf = id => data.sources.filter(s => s.projects?.includes(id));
  const projectTitle = id => data.projects.find(p => p.id === id)?.title || id;
  const discussBase = () => data.surface === 'discuss' ? location.origin : (data.discuss_base || 'http://127.0.0.1:4189');
  const discussionUrl = s => discussBase() + '/p/' + encodeURIComponent(s.page_key);

  // ── per-project counts, groups and how recently it was touched ──
  const when = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : 0; };
  function projectStats(projects) {
    const stats = new Map();
    for (const p of projects) {
      const outs = outputsOf(p.id), reads = sourcesOf(p.id), chats = new Set(reads.flatMap(s => s.chats || [])).size;
      const t = Math.max(when(p.updated_at), ...outs.map(o => when(o.updated_at)), ...reads.map(s => when(s.page_updated_at) || when(s.updated_at)));
      stats.set(p.id, { outs: outs.length, reads: reads.length, chats, t, groups: groupsOf(p) });
    }
    // brightness is relative to your latest activity, so a quiet month does not fade everything
    const newest = Math.max(0, ...[...stats.values()].map(s => s.t));
    const recent = new Set([...stats.entries()].filter(([, s]) => s.t).sort((a, b) => b[1].t - a[1].t).slice(0, 5).map(([id]) => id));
    for (const [id, s] of stats) {
      const age = s.t ? (newest - s.t) / DAY : 0;
      s.fresh = 0.26 + 0.74 * Math.max(0, Math.min(1, 1 - (age - 14) / 150)); s.recent = recent.has(id);
    }
    return stats;
  }
  const ago = t => { if (!t) return ''; const d = Math.round((Date.now() - t) / DAY); return d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? d + ' days ago' : Math.round(d / 30) + ' months ago'; };
  const dotR = n => Math.min(12, 4.5 + 1.4 * Math.sqrt(n));
  // where the four groups sit: a 2×2 block, taller than wide on a phone
  function anchors(count, n) {
    const D = 70 + 22 * Math.sqrt(n), [sx, sy] = narrow() ? [0.8, 1.5] : [1.3, 0.8];
    return Array.from({ length: count }, (_, i) => ({ x: (i % 2 ? 1 : -1) * D * sx, y: (i < 2 ? -1 : 1) * D * sy * (count > 2 ? 1 : 0) }));
  }

  // ── build the graph; positions of nodes that stay are kept ──
  function render() {
    if (!data) return;
    syncMenus();
    // an open project is always shown on the graph, whichever overview it was opened from
    if (view === 'city' && !focus && !(pendingFocus && data.projects.some(p => p.id === pendingFocus))) return renderCampus();
    svg.classList.remove('campus', 'finding'); document.body.classList.remove('campus-mode'); cm = null;
    const projects = data.projects.filter(p => p.id !== 'plugin-pages' && ($('archived').checked || p.status !== 'archived'));
    const pids = new Set(projects.map(p => p.id));
    const filed = [...data.outputs.map(ref => ({ kind: 'output', ref })), ...data.sources.map(ref => ({ kind: 'source', ref }))]
      .map(i => ({ ...i, ps: [...new Set(i.ref.projects || [])].filter(id => pids.has(id)) })).filter(i => i.ps.length);
    // the overview draws at most CAP points; the project in focus always gets all of its material
    const want = focus || pendingFocus;
    let room = Math.max(0, CAP - projects.length - (want ? filed.filter(i => i.ps.includes(want)).length : 0));
    const items = filed.filter(i => (want && i.ps.includes(want)) || room-- > 0);
    const omitted = filed.length - items.length, omittedBy = new Map();
    if (omitted) { const drawn = new Set(items); for (const i of filed) if (!drawn.has(i)) for (const p of i.ps) omittedBy.set(p, (omittedBy.get(p) || 0) + 1); }
    const stats = projectStats(projects), GL = groupList(), spots = anchors(GL.length, projects.length);
    const projectNodes = projects.map(p => { const st = stats.get(p.id), title = String(p.title || p.id);
      const n = { id: 'p:' + p.id, key: p.id, kind: 'project', title, short: shortOf(title), ref: p, st };
      n.R = dotR(st.outs + st.reads);
      // a project sits in its first group, leaning a little towards any others
      const at = st.groups.map(id => spots[Math.max(0, GL.findIndex(g => g.id === id))] || spots[spots.length - 1]), w = at.length > 1 ? 0.2 / (at.length - 1) : 0;
      n.ax = at.reduce((t, a, i) => t + a.x * (i ? w : 1 - w * (at.length - 1)), 0); n.ay = at.reduce((t, a, i) => t + a.y * (i ? w : 1 - w * (at.length - 1)), 0);
      return n; });
    const nodes = [...projectNodes,
      ...items.map(i => ({ id: (i.kind === 'output' ? 'o:' : 's:') + i.ref.id, key: i.ref.id, kind: i.kind, title: String(i.ref.title || i.ref.id), short: shortOf(i.ref.title || i.ref.id), ref: i.ref, ps: i.ps }))];
    // readings and writing are not drawn loose in the overview: they wait under their first
    // project's dot and fan out when the project is opened
    const projById = new Map(projectNodes.map(n => [n.key, n]));
    for (const n of nodes) if (n.ps) { n.home = projById.get(n.ps[0]); n.deg = n.ps.length; n.r = radius(n); }
    const edges = data.links.filter(l => pids.has(l.a) && pids.has(l.b) && l.a !== l.b && ($('suggestions').checked || l.state !== 'suggested') && ($('dismissed').checked || l.state !== 'dismissed'))
      .map(l => ({ a: 'p:' + l.a, b: 'p:' + l.b, kind: 'edge', state: l.state, link: l }));
    const members = nodes.filter(n => n.ps).flatMap(n => n.ps.map(pid => ({ a: n.id, b: 'p:' + pid, kind: 'member' })));
    // shared material: the same reading or output filed in both projects
    const shareMap = new Map();
    for (const i of filed) for (let x = 0; x < i.ps.length; x++) for (let y = x + 1; y < i.ps.length; y++) {
      const [pa, pb] = [i.ps[x], i.ps[y]].sort(), k = pa + '|' + pb;
      if (!shareMap.has(k)) shareMap.set(k, { id: k, pa, pb, a: 'p:' + pa, b: 'p:' + pb, kind: 'share', items: [] });
      shareMap.get(k).items.push(i);
    }
    const shares = [...shareMap.values()];

    let fresh = 0;
    nodes.forEach((n, i) => {
      const old = pos.get(n.id);
      if (old) { n.x = old.x; n.y = old.y; } else { fresh++; Object.assign(n, n.home ? { x: n.home.x, y: n.home.y } : seed(i, n.ax || 0, n.ay || 0)); }
      const pin = pins.get(n.id); if (pin) { n.fx = n.x = pin.x; n.fy = n.y = pin.y; }
    });
    const prev = g?.sim.alpha ?? 1;
    // regions: links pull weakly, so a group stays together even when its projects link elsewhere
    // projects keep a label's height apart, so short titles rarely sit on each other
    const sim = makeSim(projectNodes, edges.filter(e => e.state !== 'dismissed'), 0, 0, { edgeK: 0.2, gap: 24 });
    sim.alpha = fresh > nodes.length / 2 ? 1 : Math.max(prev, 0.4);
    if (sim.alpha === 1 && !reducedMotion) for (let i = 0; i < 25; i++) tick(sim); // untangle before the first paint
    settle(nodes);
    const byId = new Map(nodes.map((n, i) => [n.id, i]));
    // several relationships between one pair bow apart; a grey shared line beside a link bows off it
    const pairCount = new Map(); for (const e of edges) { const k = [e.a, e.b].sort().join('|'); pairCount.set(k, (pairCount.get(k) || 0) + 1); }
    const seen = new Map();
    for (const e of edges) {
      const [u, v] = [e.a, e.b].sort(), k = u + '|' + v, i = seen.get(k) || 0, n = pairCount.get(k); seen.set(k, i + 1);
      // drawn from a to b so an arrowhead lands on b; the bow flips with the direction so pairs still fan apart
      e.u = nodes[byId.get(e.a)]; e.v = nodes[byId.get(e.b)];
      e.bow = (i - (n - 1) / 2) * 26 * (e.a === u ? 1 : -1); e.directed = DIRECTED.has(e.link.relation);
    }
    for (const s of shares) s.bow = pairCount.has(s.a + '|' + s.b) ? 18 : 0;

    const nodeMark = n => `<g class="node ${n.kind}${pins.has(n.id) ? ' pinned' : ''}${n.st?.recent ? ' recent' : ''}" data-${n.kind}="${esc(n.key)}"${n.st ? ` style="--fresh:${n.st.fresh.toFixed(2)}"` : ''} tabindex="${n.kind === 'project' ? 0 : -1}" role="button" aria-label="${esc(KIND[n.kind] + ': ' + n.title + (n.kind === 'source' ? ', ' + plural(new Set(n.ref.chats || []).size, 'chat session') : ''))}"><circle class="hit" r="${(n.r + 6).toFixed(1)}"/><circle class="dot" r="${n.r.toFixed(1)}"/><text class="label" text-anchor="middle" y="${n.r.toFixed(1)}" dy="1.3em">${esc(n.short)}</text></g>`;
    const regionMarks = GL.map(gr => `<g class="region" data-group="${esc(gr.id)}"><circle/><text text-anchor="middle">${esc(gr.label)}</text></g>`).join('');
    svg.innerHTML = `<g class="regions" aria-hidden="true">${regionMarks}</g><g class="lines">${members.map(() => '<line class="member"/>').join('')}`
      + shares.map(s => `<path class="hit-line" fill="none" data-share="${esc(s.id)}" aria-hidden="true"/>`).join('')
      + edges.map(e => `<path class="hit-line" fill="none" data-link="${esc(e.link.id)}" aria-hidden="true"/>`).join('')
      + shares.map(s => `<path class="share${s.items.length > 2 ? ' many' : ''}" fill="none" data-share="${esc(s.id)}" tabindex="0" role="button" aria-label="${esc(`Shared material, not a recorded connection: ${projectTitle(s.pa)} and ${projectTitle(s.pb)} both hold ${plural(s.items.length, 'item')}`)}"/>`).join('')
      + edges.map(e => { const l = e.link, label = esc(`${originText(l)}: ${projectTitle(l.a)} ${relText(l.relation)} ${projectTitle(l.b)}`);
        return `<path class="edge ${lineKind(l)}${l.stale ? ' stale' : ''}" fill="none" data-link="${esc(l.id)}" tabindex="0" role="button" aria-label="${label}"/>`
          + (e.directed ? `<path class="arrow ${lineKind(l)}" data-arrow="${esc(l.id)}" aria-hidden="true"/>` : ''); }).join('')
      + `<g class="threads"></g></g><g class="nodes">${nodes.map(nodeMark).join('')}</g><g class="chats"></g>`;
    const lines = svg.querySelector('.lines');
    const memberEls = lines.querySelectorAll('line.member'), shareEls = lines.querySelectorAll('path.share'), edgeEls = lines.querySelectorAll('path.edge'), hitEls = lines.querySelectorAll('path.hit-line');
    const nodeEls = svg.querySelectorAll('.nodes .node');
    const near = nodes.map(() => new Set()), touching = nodes.map(() => []);
    const join = (a, b, ...els) => { const i = byId.get(a), j = byId.get(b); near[i].add(j); near[j].add(i); touching[i].push(...els); touching[j].push(...els); };
    members.forEach((m, k) => join(m.a, m.b, memberEls[k]));
    shares.forEach((s, k) => join(s.a, s.b, shareEls[k], hitEls[k]));
    edges.forEach((e, k) => join(e.a, e.b, edgeEls[k], hitEls[shares.length + k]));
    g = { sim, nodes, byId, members, shares, edges, near, touching, omitted, omittedBy, want, memberEls, shareEls, edgeEls, nodeEls,
      shareHits: [...hitEls].slice(0, shares.length), edgeHits: [...hitEls].slice(shares.length),
      elIndex: new Map([...nodeEls].map((el, i) => [el, i])), chats: [], chatEls: [], threadEls: [], arrowEls: [...lines.querySelectorAll('path.arrow')],
      regions: GL.map((gr, i) => ({ el: svg.querySelectorAll('.regions .region')[i], members: projectNodes.filter(n => n.st.groups[0] === gr.id) })),
      memberPts: members.map(m => [nodes[byId.get(m.a)], nodes[byId.get(m.b)]]), sharePts: shares.map(s => [nodes[byId.get(s.a)], nodes[byId.get(s.b)]]) };
    hovered = null; svg.classList.remove('hovering'); svg.classList.toggle('few', projects.length <= 8);
    svg.classList.add('regions');
    $('caption').textContent = 'Groups are a first guess from project titles and can be wrong; a project in two groups sits between them. Closeness is only arrangement.';
    applyToggles();

    const live = data.links.filter(l => l.state !== 'dismissed'), sugg = live.filter(l => l.state === 'suggested').length;
    say(`${plural(projects.length, 'project')} · ${live.length - sugg} linked · ${sugg} suggested · ${plural(shares.length, 'pair', 'pairs')} sharing material`
      + (omitted ? ` · ${omitted} of ${filed.length} readings and writing held back to keep the map light; opening a project shows all of its own` : ''));
    if (focus && !g.byId.has('p:' + focus)) { focus = null; svg.classList.remove('focused'); document.body.classList.remove('focusing'); $('focus-name').textContent = ''; markBack(); }
    if (focus) { layoutFocus(); markFocus(); }
    updateEmpty(); applySearch();
    if (selected) show(selected.kind, selected.id, true);
    if (startCam && !pendingFocus && !focus) { autoFit = false; Object.assign(vb, startCam); startCam = null; applyView(); }
    heat(); draw();
    if (pendingFocus) { const id = pendingFocus, push = pendingPush; pendingFocus = null; pendingPush = false; if (g.byId.has('p:' + id)) { show('project', id); enterFocus(id, push, !push || view === 'city'); } }
    if (pendingPick) { const p = pendingPick; pendingPick = null; pick(p); }
    syncHash();
  }

  function updateEmpty() {
    const el = $('empty'), live = data.links.filter(l => l.state !== 'dismissed').length, base = esc(discussBase() + '/');
    let html = '';
    if (focus) html = '';
    else if (!data.projects.length) html = `<p class="lead">No projects in this council yet.</p><p>A project appears once a conversation becomes one. Start in <a href="${base}" target="_blank" rel="noopener">Discuss</a>.</p>`;
    else if (!live) html = `<p class="lead">No connections yet.</p><p>Each point is a project, unconnected for now. Tell <a href="${base}" target="_blank" rel="noopener">Discuss</a> “this reading relates to my draft” to link work as you go, or <button type="button" data-refresh>refresh</button> to let agents look for overlaps.${g.shares.length ? ' Grey lines show shared material only.' : ''}</p>`;
    else if (!$('suggestions').checked && !g.edges.length) html = `<p>Suggestions are hidden. Press S to show them.</p>`;
    el.innerHTML = html; el.hidden = !html;
  }


  // ── C: the city. Each project is a building in a clearing in the woods ──
  // A building's footprint never changes with activity. Lit windows are readings whose page
  // or record was updated in the last 30 days; a flag flies where anything dated was updated in the
  // last 7; paused or archived projects are shuttered, finished ones carry a tick and
  // unrecognised statuses a question mark. Footpaths run only along recorded connections:
  // solid where linked or used in writing, stepping stones where only suggested. You arrange
  // the city by dragging; positions live in this browser (localStorage, per council root and
  // project id) because the server has no placement store yet. Unused land grows trees.
  const TW = 64, TH = 32, HW = TW / 2, HH = TH / 2, BORDER = 3;
  const iso = (i, j) => ({ x: (i - j) * HW, y: (i + j) * HH });
  const tileAt = p => { const a = p.x / HW, b = p.y / HH; return [Math.floor((a + b) / 2), Math.floor((b - a) / 2)]; };
  const pt = p => `${f1(p.x)},${f1(p.y)}`;
  const diamond = (a, b, z = 0) => [{ x: -a, y: -z }, { x: 0, y: b - z }, { x: a, y: -z }, { x: 0, y: -b - z }];
  const BUILDING = { writing: 'hall', teaching: 'school', other: 'cabin' };
  const SPACEY = /\b(space\w*|rockets?|launch\w*|orbit\w*|satellites?|hypersonic|astronaut\w*|re-?entry|UKSA|attitude)\b/i;
  const buildingOf = (p, gid) => BUILDING[gid] || (SPACEY.test(`${p.title || ''} ${p.summary || ''}`) ? 'gantry' : 'workshop');
  const KIND_NAME = { hall: 'domed library', school: 'school', cabin: 'cabin', workshop: 'workshop', gantry: 'launch site' };
  // the same tile always grows the same tree
  const noise = (i, j, s = 0) => { const v = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };

  // one building, drawn around its plot's centre; `lit` of its windows glow, a shuttered one has none
  function buildingSvg(kind, lit, shut, flag = false) {
    const parts = [], wins = [];
    const poly = (cls, pts) => parts.push(`<polygon class="${cls}" points="${pts.map(pt).join(' ')}"/>`);
    const box = (a, b, h, z = 0, dx = 0, dy = 0) => {
      const [L, F, R, B] = diamond(a, b, z).map(p => ({ x: p.x + dx, y: p.y + dy })), up = p => ({ x: p.x, y: p.y - h });
      poly('f-l', [L, F, up(F), up(L)]); poly('f-r', [F, R, up(R), up(F)]); poly('f-t', [up(L), up(F), up(R), up(B)]);
      return { L: up(L), F: up(F), R: up(R), B: up(B) };
    };
    // nc windows across and nr up each named face ('l' left, 'r' right), between heights v0 and v1
    const win = (a, b, z, sides, nc, nr, v0, v1, dx = 0, dy = 0) => { for (const side of sides) for (let r = 0; r < nr; r++) for (let k = 0; k < nc; k++) {
      const at = (u, v) => side === 'l' ? { x: dx - a + u * a, y: dy - z + u * b - v } : { x: dx + u * a, y: dy - z + b - u * b - v };
      const rh = (v1 - v0) / nr, w0 = v0 + r * rh + rh * 0.2, w1 = v0 + (r + 1) * rh - rh * 0.2, u0 = (k + 0.25) / nc, u1 = (k + 0.75) / nc;
      wins.push([at(u0, w0), at(u1, w0), at(u1, w1), at(u0, w1)]); } };
    if (kind === 'cabin') { // a log cabin under a pitched roof, with a chimney
      const a = HW * 0.56, b = HH * 0.56, h = 12, top = box(a, b, h), apex = { x: 0, y: -h - 12 };
      for (let v = 2.4; v < h; v += 2.4) parts.push(`<line class="log" x1="${f1(-a)}" y1="${f1(-v)}" x2="0" y2="${f1(b - v)}"/><line class="log" x1="0" y1="${f1(b - v)}" x2="${f1(a)}" y2="${f1(-v)}"/>`);
      parts.push(`<rect class="f-r" x="${f1(a * 0.3)}" y="${f1(-h - 13)}" width="3.2" height="9"/>`);
      poly('f-l roof', [top.L, top.F, apex]); poly('f-r roof', [top.F, top.R, apex]);
      win(a, b, 0, ['l', 'r'], 2, 1, 3, 10);
    } else if (kind === 'hall') { // a library hall under a drum and dome
      const a = HW * 0.74, b = HH * 0.74, h = 11; box(a, b, h); win(a, b, 0, ['l', 'r'], 3, 1, 1, 10);
      parts.push(`<ellipse class="f-r" cx="0" cy="${-h}" rx="8.5" ry="4.2"/><rect class="f-l" x="-8.5" y="${-h - 6}" width="8.5" height="6"/><rect class="f-r" x="0" y="${-h - 6}" width="8.5" height="6"/>`
        + `<path class="dome" d="M -8.5 ${-h - 6} A 8.5 9.5 0 0 1 8.5 ${-h - 6} Z"/><rect class="f-t" x="-1.3" y="${-h - 19}" width="2.6" height="4"/><line class="spire" x1="0" y1="${-h - 19}" x2="0" y2="${-h - 23}"/>`);
    } else if (kind === 'school') { // a schoolhouse under a cornice, with a bell turret
      const a = HW * 0.72, b = HH * 0.72, h = 22; box(a, b, h); box(a + 1.4, b + 0.7, 2, h);
      const t = box(3.4, 1.7, 6, h + 2); parts.push(`<path class="cap" d="M ${f1(t.L.x - 1)} ${f1(t.L.y)} L 0 ${f1(t.L.y - 7)} L ${f1(t.R.x + 1)} ${f1(t.R.y)} Z"/>`);
      win(a, b, 0, ['l', 'r'], 3, 2, 2, 20);
    } else if (kind === 'workshop') { // a low shed with a glazed sawtooth roof
      const a = HW * 0.76, b = HH * 0.76, h = 11, t = box(a, b, h);
      const T = (s, u, v = 0) => ({ x: t.L.x + s * (t.F.x - t.L.x) + u * (t.B.x - t.L.x), y: t.L.y + s * (t.F.y - t.L.y) + u * (t.B.y - t.L.y) - v });
      for (let k = 0; k < 3; k++) { const s0 = k / 3, s1 = (k + 1) / 3;
        poly('f-t', [T(s0, 0), T(s0, 1), T(s1, 1, 6), T(s1, 0, 6)]); poly('glaze', [T(s1, 0), T(s1, 1), T(s1, 1, 6), T(s1, 0, 6)]); }
      win(a, b, 0, ['l', 'r'], 3, 1, 1, 9);
    } else { // launch site: a pad, a lattice tower with lights, and a rocket unless stood down
      const a = HW * 0.76, b = HH * 0.76, tx = -8, ty = -2, th = 40; box(a, b, 3);
      const tw = box(3, 1.5, th, 3, tx, ty);
      for (let v = 0, n = 0; v < th - 4; v += 5, n++) { const y0 = ty - 3 - v, x0 = tx - 3, x1 = tx; // bracing on the tower's left face
        parts.push(`<line class="lattice" x1="${f1(n % 2 ? x0 : x1)}" y1="${f1(y0 + (n % 2 ? 0 : 1.5))}" x2="${f1(n % 2 ? x1 : x0)}" y2="${f1(y0 - 5 + (n % 2 ? 1.5 : 0))}"/>`); }
      if (!shut) { const rx = 6, base = -4, len = 27;
        parts.push(`<line class="arm" x1="${f1(tw.R.x)}" y1="${f1(base - len + 6)}" x2="${rx - 2.6}" y2="${f1(base - len + 6)}"/>`
          + `<path class="fin" d="M ${rx - 2.6} ${base - 6} L ${rx - 5.5} ${base} L ${rx - 2.6} ${base} Z M ${rx + 2.6} ${base - 6} L ${rx + 5.5} ${base} L ${rx + 2.6} ${base} Z"/>`
          + `<rect class="rocket" x="${rx - 2.6}" y="${base - len}" width="5.2" height="${len}"/><path class="nose" d="M ${rx - 2.6} ${base - len} L ${rx} ${base - len - 7} L ${rx + 2.6} ${base - len} Z"/>`);
      }
      win(3, 1.5, 3, ['l'], 1, 6, 6, th, tx, ty);
    }
    // lit windows are spread over the building rather than filled in order
    const order = wins.map((_, k) => k).sort((p, q) => (p * 37 % 101) - (q * 37 % 101)), on = new Set(order.slice(0, shut ? 0 : Math.min(lit, wins.length)));
    for (let k = 0; k < wins.length; k++) { const w = wins[k];
      parts.push(`<polygon class="win${shut ? ' shutter' : on.has(k) ? ' lit' : ''}" points="${w.map(pt).join(' ')}"/>`);
      if (shut) { const m0 = { x: (w[0].x + w[3].x) / 2, y: (w[0].y + w[3].y) / 2 }, m1 = { x: (w[1].x + w[2].x) / 2, y: (w[1].y + w[2].y) / 2 };
        parts.push(`<line class="slat" x1="${f1(m0.x)}" y1="${f1(m0.y)}" x2="${f1(m1.x)}" y2="${f1(m1.y)}"/>`); }
    }
    // a pennant on the plot's front corner: something dated was updated in the last 7 days
    if (flag) { const x = HW * 0.6, y = HH * 0.2;
      parts.push(`<line class="pole" x1="${f1(x)}" y1="${f1(y)}" x2="${f1(x)}" y2="${f1(y - 24)}"/><path class="flag" d="M ${f1(x)} ${f1(y - 24)} L ${f1(x + 9)} ${f1(y - 21)} L ${f1(x)} ${f1(y - 18)} Z"/>`); }
    return { svg: parts.join(''), windows: wins.length };
  }
  const treeSvg = (x, y, s, pine) => `<g class="tree" transform="translate(${f1(x)},${f1(y)}) scale(${s.toFixed(2)})"><ellipse class="shade" rx="7" ry="3"/>` + (pine
    ? '<rect class="trunk" x="-1.2" y="-5" width="2.4" height="5"/><polygon class="la" points="-8,-4 0,-19 8,-4"/><polygon class="lb" points="-6,-11 0,-25 6,-11"/>'
    : '<rect class="trunk" x="-1.3" y="-7" width="2.6" height="7"/><circle class="la" cx="0" cy="-13" r="7.5"/><circle class="lb" cx="-2.5" cy="-15.5" r="4.5"/>') + '</g>';

  // ── where buildings stand: yours where you put them, the rest laid out by group ──
  const placeKey = () => 'bf-city:' + (data?.root || root || '');
  function readPlaces() { try { const v = JSON.parse(store.get(placeKey()) || 'null') || {}; return { placed: { ...v.placed }, auto: { ...v.auto } }; } catch { return { placed: {}, auto: {} }; } }
  const writePlaces = pl => store.set(placeKey(), JSON.stringify(pl));
  // the grid is sized from every project, archived ones too, so showing them never moves the land
  function cityGrid(projects) {
    const sizes = GROUPS.map(gr => projects.filter(p => (groupsOf(p)[0] || 'other') === gr.id).length);
    const k = Math.max(2, Math.ceil(Math.sqrt(Math.max(0, ...sizes) + 1))), q = 2 * k + 1;
    return { k, q, S: 2 * q };
  }
  // Placed buildings keep their tile. The others keep the tile the city first gave them, so a new
  // project never reshuffles the rest; `tidy` forgets those and lays them out again by group:
  // one quarter of the city per group, a tile of grass between buildings, current work nearest the middle.
  // Projects not shown (archived ones, while hidden) keep their saved tiles: nobody else may take
  // them, so showing archived projects again puts each back where it was. Returns those tiles.
  function arrange(items, { k, q, S }, pl, tidy, hidden = []) {
    const taken = new Map(), key = t => t[0] + ',' + t[1], mid = S / 2, d = t => Math.hypot(t[0] + 0.5 - mid, t[1] + 0.5 - mid);
    const fits = t => Array.isArray(t) && Number.isInteger(t[0]) && Number.isInteger(t[1]) && t[0] >= 0 && t[1] >= 0 && t[0] < S && t[1] < S;
    const claim = (x, t, placed) => { x.tile = [t[0], t[1]]; x.placed = placed; taken.set(key(t), x.id); };
    for (const id of hidden) for (const t of [pl.placed[id], pl.auto[id]]) if (fits(t) && !taken.has(key(t))) { taken.set(key(t), id); break; }
    const reserved = new Set(taken.keys());
    for (const x of items) { const t = pl.placed[x.id]; if (fits(t) && !taken.has(key(t))) claim(x, t, true); else delete pl.placed[x.id]; }
    if (tidy) for (const x of items) delete pl.auto[x.id];
    for (const x of items) { const t = pl.auto[x.id]; if (!x.tile && fits(t) && !taken.has(key(t))) claim(x, t, false); }
    const everywhere = []; for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) everywhere.push([i, j]);
    GROUPS.forEach((gr, n) => {
      const oi = n % 2 ? q : 0, oj = n >= 2 ? q : 0, slots = [], quarter = everywhere.filter(t => t[0] >= oi && t[0] < oi + q && t[1] >= oj && t[1] < oj + q);
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) slots.push([oi + 1 + 2 * a, oj + 1 + 2 * b]);
      slots.sort((s, t) => d(s) - d(t)); quarter.sort((s, t) => d(s) - d(t));
      for (const x of items) if (!x.tile && x.gid === gr.id) {
        const t = slots.find(t => !taken.has(key(t))) || quarter.find(t => !taken.has(key(t))) || everywhere.find(t => !taken.has(key(t)));
        if (t) { claim(x, t, false); pl.auto[x.id] = x.tile; }
      }
    });
    return reserved;
  }

  // dated updates in a project, newest first, each named by where its time comes from: a reading's
  // page time (the page was saved), or else `updated_at`, which is only this map's own record of the
  // reading, writing or project being refreshed. Neither says a discussion or a file's text changed.
  function changesOf(p) {
    const ev = [];
    for (const o of outputsOf(p.id)) { const t = when(o.updated_at); if (t) ev.push({ t, kind: 'writing', id: o.id, from: 'record', what: `map record of “${o.title}” updated` }); }
    for (const s of sourcesOf(p.id)) { const tp = when(s.page_updated_at), t = tp || when(s.updated_at);
      if (t) ev.push({ t, kind: 'reading', id: s.id, from: tp ? 'page' : 'record', what: tp ? `page for “${s.title}” updated` : `map record of “${s.title}” updated` }); }
    const t = when(p.updated_at); if (t) ev.push({ t, kind: 'project', id: p.id, from: 'record', what: 'project’s map record updated' });
    return ev.sort((a, b) => b.t - a.t);
  }
  // the week in one line: a reading or piece of writing shared by several projects counts once
  function weekSummary(items, now = Date.now()) {
    const seen = new Map();
    for (const x of items) for (const e of x.changes) if (now - e.t <= WEEK && e.t <= now + DAY) {
      const k = e.kind + ':' + e.id, s = seen.get(k) || { ...e, projects: new Set() }; s.projects.add(x.id); seen.set(k, s); }
    const all = [...seen.values()], nP = new Set(all.flatMap(e => [...e.projects])).size;
    if (!nP) return 'Nothing dated was updated this week.';
    const pages = all.filter(e => e.from === 'page').length, rec = k => all.filter(e => e.from === 'record' && e.kind === k).length;
    const records = [[rec('reading'), 'reading'], [rec('writing'), 'piece of writing', 'pieces of writing'], [rec('project'), 'project']].filter(r => r[0]).map(r => plural(...r)).join(', ');
    return `This week ${plural(nP, 'project')} had updates: ${[pages && `${plural(pages, 'reading page')} saved`, records && `map records refreshed for ${records}`].filter(Boolean).join('; ')}.`;
  }
  const WEEK = 7 * DAY;
  const agoShort = t => { const d = Math.floor((Date.now() - t) / DAY); return d < 1 ? 'today' : d === 1 ? 'yesterday' : d < 14 ? d + ' days' : d < 60 ? Math.round(d / 7) + ' weeks' : Math.round(d / 30) + ' months'; };

  function cityModel(tidy = false) {
    const counted = data.projects.filter(p => p.id !== 'plugin-pages');
    const shown = counted.filter(p => $('archived').checked || p.status !== 'archived');
    const stats = projectStats(shown), now = Date.now();
    const RANK = { active: 0, unknown: 1, done: 2, shut: 3 };
    const items = shown.map(p => { const st = stats.get(p.id), gid = st.groups[0] || 'other', status = statusOf(p), changes = changesOf(p);
      return { p, id: p.id, st, gid, status, shut: status === 'shut', lit: recentReadings(sourcesOf(p.id), now), changes, t: changes[0]?.t || 0,
        flag: !!changes[0] && now - changes[0].t <= WEEK && changes[0].t <= now + DAY, title: String(p.title || p.id), short: shortOf(p.title || p.id), kind: buildingOf(p, gid) }; })
      .sort((x, y) => (RANK[x.status] - RANK[y.status]) || (y.t - x.t) || x.short.localeCompare(y.short));
    const grid = cityGrid(counted), pl = readPlaces(), shownIds = new Set(shown.map(p => p.id));
    const reserved = arrange(items, grid, pl, tidy, counted.filter(p => !shownIds.has(p.id)).map(p => p.id)); writePlaces(pl);
    for (const x of items) x.at = iso(x.tile[0] + 0.5, x.tile[1] + 0.5);
    const byId = new Map(items.map(x => [x.id, x]));
    // footpaths: recorded connections between two buildings; a dismissed suggestion is no path
    const paths = data.links.filter(l => l.a !== l.b && byId.has(l.a) && byId.has(l.b) && l.state !== 'dismissed' && ($('suggestions').checked || l.state !== 'suggested'))
      .map(l => ({ link: l, a: byId.get(l.a), b: byId.get(l.b), kind: l.state === 'suggested' ? 'suggested' : 'linked' }));
    // the budget: the active-project limit if the server sends it, else the `capacity` field; the count is always ours
    const cap = capacityOf(counted, data.active_project_limit ?? data.capacity?.limit);
    const recent = new Set(items.filter(x => !x.shut && x.t).sort((x, y) => y.t - x.t).slice(0, 5).map(x => x.id));
    return { items, grid, paths, ...cap, recent, byId, reserved, ds: GROUPS.map(gr => ({ ...gr, its: items.filter(x => x.gid === gr.id) })),
      shut: items.filter(x => x.shut).length, placedN: items.filter(x => x.placed).length,
      zoom: cm?.zoom || null, manual: !!cm?.manual };
  }
  const roomText = m => !m.limit ? `${plural(m.active, 'active project')}; no project budget is recorded`
    : m.room > 0 ? `${m.active} of a ${m.limit}-project budget active: room for ${m.room} more`
    : m.room === 0 ? `Project budget full: ${m.active} of ${m.limit} active` : `${m.active} active against a ${m.limit}-project budget: ${-m.room} over`;
  const STATUS_NOTE = { done: 'finished, not counted', unknown: 'status not recognised, not counted' };
  const statusWord = x => x.shut ? x.p.status : x.status === 'unknown' ? (x.p.status ? `status “${x.p.status}”` : 'no status') : x.status === 'done' ? x.p.status : '';
  const litText = n => `${plural(n, 'reading')} with a page or record update in the last 30 days`;
  const budgetNote = m => [m.unknown ? `${plural(m.unknown, 'project')} with no recognised status ${m.unknown === 1 ? 'is' : 'are'} not counted.` : '',
    m.done ? `${plural(m.done, 'finished project')} ${m.done === 1 ? 'is' : 'are'} not counted.` : '', 'The budget counts projects, not your time.'].filter(Boolean).join(' ');

  function renderCampus(tidy = false) {
    g = null; hovered = null; tween = null;
    svg.classList.remove('focused', 'hovering', 'searching', 'regions', 'few'); svg.classList.add('campus'); document.body.classList.add('campus-mode');
    $('empty').hidden = true;
    const m = cm = cityModel(tidy), { S } = m.grid, now = Date.now();
    const taken = new Set(m.items.map(x => x.tile.join(','))), yard = new Set(), trail = new Set();
    for (const x of m.items) for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) yard.add((x.tile[0] + di) + ',' + (x.tile[1] + dj));
    // each path turns once; it bends round a building rather than through one where it can
    let paths = '';
    m.paths.forEach((p, k) => {
      const [ai, aj] = p.a.tile, [bi, bj] = p.b.tile, c1 = [bi, aj], c2 = [ai, bj], corner = taken.has(c1.join(',')) && !taken.has(c2.join(',')) ? c2 : c1;
      for (const [u, v] of [[p.a.tile, corner], [corner, p.b.tile]])
        for (let i = Math.min(u[0], v[0]); i <= Math.max(u[0], v[0]); i++) for (let j = Math.min(u[1], v[1]); j <= Math.max(u[1], v[1]); j++) trail.add(i + ',' + j);
      const off = ((k % 3) - 1) * 3, P = [p.a.tile, corner, p.b.tile].map(t => { const c = iso(t[0] + 0.5, t[1] + 0.5); return pt({ x: c.x, y: c.y + off }); }).join(' ');
      const l = p.link, ends = `data-link="${esc(l.id)}" data-a="${esc(l.a)}" data-b="${esc(l.b)}"`;
      paths += `<polyline class="fp-hit" ${ends} points="${P}" aria-hidden="true"/><polyline class="fp ${p.kind}${l.stale ? ' stale' : ''}" ${ends} points="${P}" tabindex="0" role="button" aria-label="${esc(`Path: ${originText(l)}: ${projectTitle(l.a)} ${relText(l.relation)} ${projectTitle(l.b)}`)}"/>`;
    });
    const things = [];
    // unused land grows trees: thick in the forest round the edge, thinner inside, none in a yard or on a path
    for (let i = -BORDER; i < S + BORDER; i++) for (let j = -BORDER; j < S + BORDER; j++) {
      const id = i + ',' + j; if (yard.has(id) || trail.has(id)) continue;
      const inside = i >= 0 && j >= 0 && i < S && j < S; if (noise(i, j) > (inside ? 0.6 : 0.9)) continue;
      const c = iso(i + 0.5, j + 0.5);
      things.push({ depth: i + j, gi: i, html: treeSvg(c.x + (noise(i, j, 1) - 0.5) * 22, c.y + (noise(i, j, 2) - 0.5) * 9, 0.8 + noise(i, j, 3) * 0.45, noise(i, j, 4) < 0.55) });
    }
    let labels = '';
    for (const x of m.items) {
      const b = buildingSvg(x.kind, x.lit, x.shut, x.flag); x.windows = b.windows;
      const state = x.shut ? `shuttered, ${x.p.status}` : [STATUS_NOTE[x.status] && `${statusWord(x)}, ${STATUS_NOTE[x.status]}`, litText(x.lit)].filter(Boolean).join('; ');
      const badge = x.status === 'unknown' ? '?' : x.status === 'done' ? '✓' : '', last = x.changes[0];
      things.push({ depth: x.tile[0] + x.tile[1], gi: x.tile[0], html: `<g class="bld cg-${esc(x.gid)} ${x.kind} st-${x.status}${x.shut ? ' shut' : ''}${x.placed ? ' placed' : ''}" data-project="${esc(x.id)}" data-tile="${x.tile.join(',')}" transform="translate(${pt(x.at)})" tabindex="0" role="button"`
        + ` aria-label="${esc(`Project: ${x.title}. ${groupNames([x.gid])}, ${KIND_NAME[x.kind]}, ${state}.${last ? ` Last update ${ago(last.t)}: ${last.what}.` : ''}`)}">`
        + `<polygon class="plot" points="${diamond(HW * 0.92, HH * 0.92).map(pt).join(' ')}"/>${b.svg}`
        + (badge ? `<g class="badge" transform="translate(${f1(-HW * 0.62)},${f1(HH * 0.1)})"><circle r="5.5"/><text text-anchor="middle" dy=".36em">${badge}</text></g>` : '') + '</g>' });
      labels += `<text class="c-label${m.recent.has(x.id) ? ' keep' : ''}" data-for="${esc(x.id)}" x="${f1(x.at.x)}" y="${f1(x.at.y + HH)}" dy="1em" text-anchor="middle">${esc(x.short)}</text>`;
    }
    things.sort((a, b) => a.depth - b.depth || a.gi - b.gi); // back to front, so nearer things overlap farther ones
    // a district is wherever its buildings are; its name sits over them, its box is what its button zooms to
    const boxOf = its => { const xs = its.map(x => x.at.x), ys = its.map(x => x.at.y); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }; };
    for (const d of m.ds) if (d.its.length) { const b = boxOf(d.its);
      d.box = { x0: b.x0 - TW * 1.2, x1: b.x1 + TW * 1.2, y0: b.y0 - 64, y1: b.y1 + TH * 1.2 };
      labels += `<text class="d-label cg-${esc(d.id)}" x="${f1((b.x0 + b.x1) / 2)}" y="${f1(b.y0 - 50)}" text-anchor="middle">${esc(d.label)} · ${d.its.length}</text>`; }
    const sq = (a0, a1) => [iso(a0, a0), iso(a1, a0), iso(a1, a1), iso(a0, a1)].map(pt).join(' ');
    let grid = ''; for (let t = 0; t <= S; t++) grid += `<line x1="${pt(iso(t, 0)).replace(',', '" y1="')}" x2="${pt(iso(t, S)).replace(',', '" y2="')}"/><line x1="${pt(iso(0, t)).replace(',', '" y1="')}" x2="${pt(iso(S, t)).replace(',', '" y2="')}"/>`;
    svg.innerHTML = `<g class="city-ground" aria-hidden="true"><polygon class="floor" points="${sq(-BORDER, S + BORDER)}"/><polygon class="clearing" points="${sq(0, S)}"/><g class="grid">${grid}</g></g>`
      + `<g class="city-paths">${paths}</g><g class="campus-plots">${things.map(t => t.html).join('')}</g><g class="campus-labels" aria-hidden="true">${labels}</g>`;
    const all = m.items.length ? boxOf(m.items) : { x0: iso(0, S).x, x1: iso(S, 0).x, y0: 0, y1: iso(S, S).y };
    m.bounds = { x0: all.x0 - TW * 1.4, x1: all.x1 + TW * 1.4, y0: all.y0 - 70, y1: all.y1 + TH * 1.6 };

    $('caption').textContent = 'Each building is a project; its kind is a first guess from the title. Lit windows: readings whose page or record was updated in the last 30 days. Flag: a dated update in the last 7 days. Shutters: paused or archived. '
      + 'Paths follow recorded connections only: solid when linked or used in your writing, stepping stones when only suggested. Drag a building to move it. Positions are saved in this browser only: the server has no placement store yet.';
    $('capacity').innerHTML = `<b>${esc(roomText(m))}</b><small>${esc(budgetNote(m))} ${plural(m.shut, 'project')} shuttered.</small>`;
    $('capacity').classList.toggle('over', !!m.limit && m.room <= 0);
    $('districts').innerHTML = `<button type="button" data-zoom="">all</button>` + m.ds.filter(d => d.its.length).map(d => `<button type="button" class="cg-${esc(d.id)}" data-zoom="${esc(d.id)}">${esc(d.label)}</button>`).join('');
    $('placed-note').textContent = `${m.placedN ? `You placed ${plural(m.placedN, 'building')}; ` : 'Drag a building to place it; '}tidy re-lays the others by group. Saved in this browser only.`;
    // activity: newest change first, one line each; this week and this month open, the rest folded
    $('week').textContent = weekSummary(m.items, now);
    const row = x => { const c = x.changes[0], more = x.changes.filter(e => now - e.t <= WEEK).length - 1, tag = x.shut ? x.p.status : x.status === 'unknown' ? '?' : x.status === 'done' ? '✓' : '';
      return `<li><button type="button" class="row cg-${esc(x.gid)} st-${x.status}${x.shut ? ' shut' : ''}" data-project="${esc(x.id)}" title="${esc(`${x.title}${c ? `\n${c.what}, ${ago(c.t)}` : ''}${more > 0 ? `\nand ${more} more this week` : ''}`)}">`
        + `<span class="r-t">${esc(x.short)}</span><span class="r-w">${esc(c ? c.what : 'nothing dated yet')}${more > 0 ? ` <i>+${more}</i>` : ''}</span>${tag ? `<span class="r-s">${esc(tag)}</span>` : ''}<time>${c ? esc(agoShort(c.t)) : ''}</time></button></li>`; };
    const band = x => !x.t ? 3 : now - x.t <= WEEK ? 0 : now - x.t <= 30 * DAY ? 1 : 2, newest = [...m.items].sort((x, y) => (y.t - x.t) || x.short.localeCompare(y.short));
    const of = n => newest.filter(x => band(x) === n), older = [...of(2), ...of(3)];
    $('campus-rows').innerHTML = `<h3>This week <span>${of(0).length}</span></h3>` + (of(0).length ? `<ul>${of(0).map(row).join('')}</ul>` : '<p class="muted">No dated updates in the last 7 days.</p>')
      + (of(1).length ? `<h3>Earlier this month <span>${of(1).length}</span></h3><ul>${of(1).map(row).join('')}</ul>` : '')
      + (older.length ? `<details id="older"><summary>Older <span>${older.length}</span></summary><ul>${older.map(row).join('')}</ul></details>` : '');
    say(`City · ${roomText(m)} · ${plural(m.shut, 'shuttered project')}${m.unknown ? ` · ${m.unknown} status unknown` : ''}`);
    campusFind();
    if (startCam) { Object.assign(vb, startCam); startCam = null; m.manual = true; m.zoom = null; applyView(); }
    else if (m.manual) applyView(); else campusFit(m.zoom);
    campusDeclutter();
    if (selected) show(selected.kind, selected.id, true);
    if (pendingPick) { const p = pendingPick; pendingPick = null; pick(p); }
    syncHash();
  }
  // the city fills the space beside the activity panel (or above it, on a phone), clear of an open sheet
  function campusArea() {
    const b = box(), open = sheet.classList.contains('open');
    return b.w <= 640 ? { x: 8, y: 70, w: b.w - 16, h: Math.max(160, b.h * (open ? 0.46 : 0.5) - 78) }
      : { x: 350, y: 78, w: Math.max(240, b.w - 360 - (open ? sheet.offsetWidth || 360 : 0)), h: Math.max(200, b.h - 78 - 58) };
  }
  // the scale and centre that frame `bounds` in the city's area, and the view box that shows it
  function campusFrame(B) { const u = campusArea(), scale = Math.min(u.w / (B.x1 - B.x0), u.h / (B.y1 - B.y0), 2.6); return { scale, cx: (B.x0 + B.x1) / 2, cy: (B.y0 + B.y1) / 2, u }; }
  const frameVb = f => ({ x: f.cx - (f.u.x + f.u.w / 2) / f.scale, y: f.cy - (f.u.y + f.u.h / 2) / f.scale, w: box().w / f.scale });
  // fit the whole city, or one district (`zoom` is its id) so its buildings are big enough to tap
  function campusFit(zoom = cm?.zoom) {
    if (!cm) return;
    const d = zoom && cm.ds.find(d => d.id === zoom && d.box); cm.zoom = d ? d.id : null;
    homeScale = campusFrame(cm.bounds).scale; cm.manual = false; Object.assign(vb, frameVb(campusFrame(d ? d.box : cm.bounds)));
    applyView();
    for (const el of document.querySelectorAll('#districts [data-zoom]')) el.setAttribute('aria-pressed', String(el.dataset.zoom === (cm.zoom || '')));
  }
  // names that would sit on another name already placed stay hidden until hover; the selected
  // project's goes first, then the recent few, and once you zoom in past the fitted city every project's
  function campusDeclutter() {
    if (!cm) return;
    const b = box(), scale = b.w / vb.w, placed = [], zoomed = scale > homeScale * 1.5;
    svg.classList.toggle('z1', zoomed);
    const rank = el => el.classList.contains('selected') ? 3 : el.classList.contains('keep') ? 1 : 0;
    const els = [...svg.querySelectorAll('.c-label')].filter(el => zoomed || rank(el)).sort((p, q) => rank(q) - rank(p));
    for (const el of svg.querySelectorAll('.c-label.show')) el.classList.remove('show');
    for (const el of els) {
      const x = cm.byId.get(el.dataset.for); if (!x?.at) continue;
      const w = x.short.length * 7 + 8, sx = (x.at.x - vb.x) * scale, sy = (x.at.y + HH - vb.y) * scale;
      const r = { x0: sx - w / 2, x1: sx + w / 2, y0: sy, y1: sy + 16 }, hit = placed.some(p => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
      el.classList.toggle('show', !hit); if (!hit) placed.push(r);
    }
  }
  $('districts').addEventListener('click', e => { const b = e.target.closest('[data-zoom]'); if (b) campusFit(b.dataset.zoom || null); });
  $('tidy').addEventListener('click', () => { if (!cm) return; cm.manual = false; cm.zoom = null; renderCampus(true); say(`Tidied: ${cm.items.length - cm.placedN} buildings re-laid by group${cm.placedN ? `; the ${plural(cm.placedN, 'building')} you placed stayed put` : ''}.`); });

  // ── moving a building: drag it (hold first, on a touch screen); it snaps to a free tile ──
  let lift = null;
  function liftStart(e, el) {
    const x = cm.byId.get(el.dataset.project), w = toWorld(e);
    lift = { id: x.id, el, x: e.clientX, y: e.clientY, off: { x: x.at.x - w.x, y: x.at.y - w.y }, moved: false, armed: e.pointerType !== 'touch' };
    // on a touch screen a plain drag pans the city; holding still for a moment picks the building up
    if (!lift.armed) { const L = lift; L.timer = setTimeout(() => { if (lift === L && !L.moved) { L.armed = true; pan = null; el.classList.add('lifting'); suppressClick = true; } }, 380); }
  }
  function liftMove(e) {
    const L = lift; if (!L.moved && Math.hypot(e.clientX - L.x, e.clientY - L.y) < 4) return;
    if (!L.moved) { L.moved = true; svg.setPointerCapture?.(e.pointerId); svg.classList.add('placing'); L.el.classList.add('lifting'); L.el.parentNode.appendChild(L.el); hideTip(); }
    const w = toWorld(e), [i, j] = tileAt({ x: w.x + L.off.x, y: w.y + L.off.y }), S = cm.grid.S, t = [Math.max(0, Math.min(S - 1, i)), Math.max(0, Math.min(S - 1, j))];
    L.tile = t; L.ok = !cm.reserved.has(t.join(',')) && !cm.items.some(x => x.id !== L.id && x.tile[0] === t[0] && x.tile[1] === t[1]);
    L.el.setAttribute('transform', `translate(${pt(iso(t[0] + 0.5, t[1] + 0.5))})`); L.el.classList.toggle('blocked', !L.ok);
  }
  function liftEnd(L) {
    clearTimeout(L.timer); svg.classList.remove('placing'); L.el.classList.remove('lifting', 'blocked');
    if (!L.moved) return;
    suppressClick = true;
    const x = cm.byId.get(L.id);
    if (!L.ok || !L.tile || (L.tile[0] === x.tile[0] && L.tile[1] === x.tile[1])) { renderCampus(); if (L.tile && !L.ok) say(cm.reserved.has(L.tile.join(',')) ? 'That tile is kept for a hidden archived project; the building went back.' : 'That tile is taken; the building went back.'); return; }
    const pl = readPlaces(); pl.placed[L.id] = L.tile; delete pl.auto[L.id]; writePlaces(pl);
    cm.manual = true; renderCampus(); say(`Moved “${x.short}”. Its place is saved in this browser.`);
  }
  function unplace(id) {
    const pl = readPlaces(); delete pl.placed[id]; delete pl.auto[id]; writePlaces(pl);
    if (cm) { cm.manual = true; renderCampus(); } else { show('project', id, true); say('The city will place it again when you go back.'); }
  }

  let campusLit = null;
  function campusHl(id) {
    if (campusLit === id) return; campusLit = id;
    document.querySelectorAll('.bld.hl,.row.hl,.fp.hl,.c-label.on').forEach(el => el.classList.remove('hl', 'on'));
    if (!id) return;
    for (const el of document.querySelectorAll('.bld[data-project],.row[data-project],.c-label[data-for]')) if ((el.dataset.project ?? el.dataset.for) === id) el.classList.add(el.matches('.c-label') ? 'on' : 'hl');
    for (const el of svg.querySelectorAll('.fp')) if (el.dataset.a === id || el.dataset.b === id) el.classList.add('hl');
  }
  function campusTip(el) {
    if (el.dataset.link) { const l = data.links.find(l => l.id === el.dataset.link); if (!l) return '';
      return `${originText(l)}: ${shortOf(projectTitle(l.a))} ${relText(l.relation)} ${shortOf(projectTitle(l.b))}\n${l.state === 'suggested' ? 'Stepping stones: suggested, not yet confirmed by you.' : 'A solid path: linked by you, or used in your writing.'}${l.stale ? '\nFaint: its evidence has changed since.' : ''}\nClick for the reason and evidence.`; }
    const x = cm.byId.get(el.dataset.project); if (!x) return '';
    const c = x.changes[0];
    return `${x.short}\n${groupNames([x.gid])} · ${KIND_NAME[x.kind]}${x.shut ? ` · shuttered (${x.p.status})` : STATUS_NOTE[x.status] ? ` · ${statusWord(x)}, ${STATUS_NOTE[x.status]}` : ''}\n`
      + (x.shut ? 'Paused work keeps its place; its windows stay dark.' : `${Math.min(x.lit, x.windows)} of ${x.windows} windows lit: ${litText(x.lit)}`)
      + (c ? `\nLast update ${ago(c.t)}: ${c.what}` : '') + `\n${x.placed ? 'You placed it here.' : 'Placed by the city. Drag to move it.'}`;
  }
  function campusFind() {
    if (!cm) return;
    const q = $('campus-find').value.trim().toLowerCase(), hit = x => !q || `${x.title} ${x.p.summary || ''}`.toLowerCase().includes(q);
    svg.classList.toggle('finding', !!q); if (q && $('older')) $('older').open = true;
    for (const el of document.querySelectorAll('.bld[data-project],.row[data-project],.c-label[data-for]')) {
      const x = cm.byId.get(el.dataset.project ?? el.dataset.for), m = !!x && hit(x);
      if (el.matches('.row')) el.parentElement.hidden = !m; else el.classList.toggle('match', !!q && m);
    }
    return [...cm.items].sort((x, y) => y.t - x.t).find(hit);
  }
  $('campus-find').addEventListener('input', campusFind);
  $('campus-find').addEventListener('keydown', e => { if (e.key === 'Enter' && $('campus-find').value.trim()) { const x = campusFind(); if (x) openProject(x.id); } });
  $('campus-rows').addEventListener('click', e => { const b = e.target.closest('button[data-project]'); if (b) openProject(b.dataset.project); });
  $('campus-rows').addEventListener('pointerover', e => campusHl(e.target.closest('[data-project]')?.dataset.project || null));
  $('campus-rows').addEventListener('pointerleave', () => campusHl(null));
  $('campus-rows').addEventListener('focusin', e => campusHl(e.target.closest('[data-project]')?.dataset.project || null));

  // ── focus view: one project with its readings, writing, chats and neighbours ──
  function layoutFocus() {
    for (const n of g.nodes) n.fp = n.crowd = null;
    clearChats();
    const c = g.nodes[g.byId.get('p:' + focus)], at = { x: c.x, y: c.y }; c.fp = at;
    // writing fans out to the right and readings to the left, labels pointing outward;
    // neighbouring projects sit above and below, clear of those labels
    const mats = g.nodes.filter(n => n.ps?.includes(focus)), outs = mats.filter(n => n.kind === 'output'), reads = mats.filter(n => n.kind === 'source');
    // a long side wraps into further arcs, PER to a row, so a big project stays compact
    const PER = 24, most = Math.max(outs.length, reads.length, 1), rows = Math.ceil(most / PER), R1 = Math.max(90, 26 * (Math.min(most, PER) - 1) / (Math.PI * 0.8));
    const fan = (list, mid, side) => list.forEach((n, i) => {
      const row = Math.floor(i / PER), k = i - row * PER, inRow = Math.min(PER, list.length - row * PER), R = R1 + row * 20;
      const step = inRow < 2 ? 0 : Math.min(26 / R, Math.PI * 0.8 / (inRow - 1)), a = mid + (side === 'r' ? 1 : -1) * (k - (inRow - 1) / 2 + (row % 2) * 0.5) * step;
      n.fa = a; n.side = side; n.crowd = list.length > PER; n.fp = { x: at.x + R * Math.cos(a), y: at.y + R * Math.sin(a) }; });
    fan(outs, 0, 'r'); fan(reads, Math.PI, 'l');
    const nb = new Set();
    for (const e of g.edges) if (e.a === c.id || e.b === c.id) nb.add(e.a === c.id ? e.b : e.a);
    for (const s of g.shares) if (s.a === c.id || s.b === c.id) nb.add(s.a === c.id ? s.b : s.a);
    const R2 = R1 + (rows - 1) * 20 + 120, ring = [...nb].map(id => g.nodes[g.byId.get(id)]);
    for (const [list, mid] of [[ring.filter(n => n.y < at.y).sort((p, q) => p.x - q.x), -Math.PI / 2], [ring.filter(n => n.y >= at.y).sort((p, q) => q.x - p.x), Math.PI / 2]]) {
      const step = list.length < 2 ? 0 : Math.min(2.4 / (list.length - 1), Math.max(narrow() ? 1.2 : 0.5, 170 / R2));
      list.forEach((n, i) => { const a = mid + (i - (list.length - 1) / 2) * step; n.fp = { x: at.x + R2 * Math.cos(a), y: at.y + R2 * Math.sin(a) }; });
    }
    // one quiet count just inside each reading: Discuss opens a reading's page, not a
    // single session, so separate dots would promise navigation that does not exist
    const threads = [], marks = [];
    for (const r of reads) { // sits just above its reading, clear of the line to the project
      const count = new Set(r.ref.chats || []).size; if (!count) continue;
      const n = { kind: 'chat', key: r.key, count, title: `${plural(count, 'chat session')} on ${r.title}`, parent: r, r: 1.8, fp: { x: r.fp.x, y: r.fp.y - r.r - 6 } };
      g.chats.push(n);
      marks.push(`<g class="node chat in" data-source="${esc(r.key)}" aria-hidden="true"><circle class="hit" r="6"/><text class="count" text-anchor="middle" dy=".35em">${count}</text></g>`);
    }
    svg.querySelector('.threads').innerHTML = threads.join(''); svg.querySelector('.chats').innerHTML = marks.join('');
    g.threadEls = svg.querySelectorAll('.threads line'); g.chatEls = svg.querySelectorAll('.chats .node');
  }
  function clearChats() { g.chats = []; g.chatEls = []; g.threadEls = []; const t = svg.querySelector('.threads'), c = svg.querySelector('.chats'); if (t) t.innerHTML = ''; if (c) c.innerHTML = ''; }
  function markFocus() {
    const c = focus && g.nodes[g.byId.get('p:' + focus)], isIn = n => !!(focus && n.fp);
    // whatever focus fades out also leaves the tab order, and comes back with the overview
    const reach = (el, on) => { el.setAttribute('tabindex', on ? '0' : '-1'); if (focus && !on) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden'); };
    g.nodes.forEach((n, i) => {
      const on = isIn(n), el = g.nodeEls[i]; el.classList.toggle('in', on);
      if (n.kind === 'project') return reach(el, !focus || on);
      reach(el, on); el.classList.toggle('crowd', on && !!n.crowd); // too many names on that side to print at once
      const t = el.querySelector('.label'), side = on && n.side; // in focus, labels read outward from the ring
      t.setAttribute('text-anchor', side ? (side === 'r' ? 'start' : 'end') : 'middle');
      t.setAttribute('x', side ? (side === 'r' ? 1 : -1) * (n.r + 5) : 0); t.setAttribute('y', side ? 0 : n.r.toFixed(1)); t.setAttribute('dy', side ? '.35em' : '1.3em');
    });
    g.memberPts.forEach(([m, p], i) => g.memberEls[i].classList.toggle('in', isIn(m) && isIn(p)));
    g.shares.forEach((s, i) => { const on = !!c && (s.a === c.id || s.b === c.id); g.shareEls[i].classList.toggle('in', on); g.shareHits[i].classList.toggle('in', on); reach(g.shareEls[i], !focus || on); });
    g.edges.forEach((e, i) => { const on = !!c && (e.a === c.id || e.b === c.id); g.edgeEls[i].classList.toggle('in', on); g.edgeHits[i].classList.toggle('in', on); reach(g.edgeEls[i], !focus || on); });
  }
  const focusPts = () => [...g.nodes.filter(n => n.fp).map(n => ({ x: n.fp.x, y: n.fp.y, r: n.r })), ...g.chats.map(c => ({ ...c.fp, r: 2 }))];
  const overviewPts = () => [...g.nodes.map(n => ({ x: n.x, y: n.y, r: n.r })), ...g.regions.filter(r => r.R).map(r => ({ x: r.cx, y: r.cy, r: r.R }))];
  // Opening a project, from the map or the city, shows the same view: the project on the graph
  // with its readings, writing, chat counts and connections, and its sheet beside it.
  let pendingPush = false;
  function openProject(id) {
    if (!data?.projects.some(p => p.id === id)) return;
    if (focus === id) return show('project', id);
    if (!focus) { syncHash(); backCam = overviewCam(); } // the overview's own history entry keeps its camera, for Back
    if (cm) { pendingFocus = id; pendingPush = true; cm = null; render(); return; } // from the city: draw the graph, then open
    show('project', id); enterFocus(id);
  }
  function enterFocus(id, push = true, instant = false) {
    if (!g || !g.byId.has('p:' + id)) return;
    const was = focus;
    focus = id;
    if (g.omittedBy.get(id)) render(); // its material was cut from the overview; draw all of it now
    else { layoutFocus(); markFocus(); }
    svg.classList.add('focused'); document.body.classList.add('focusing'); $('empty').hidden = true;
    $('focus-name').textContent = shortOf(projectTitle(id)); markBack();
    const cam = focusCam; focusCam = null;
    beginTween(cam || frameOf(focusPts()), null, instant);
    syncHash(push && !was); // one history entry per visit, so Back returns to the overview
  }
  // back to the overview you came from; `cam` is where its camera was, else it is fitted
  function exitFocus(cam = null) {
    if (!focus) return;
    focus = null; closeSheet(); document.body.classList.remove('focusing'); $('focus-name').textContent = ''; markBack();
    if (view === 'city' || !g) { svg.classList.remove('focused'); g = null; startCam = cam; render(); return; }
    markFocus(); svg.classList.remove('focused'); updateEmpty(); autoFit = !cam;
    beginTween(cam || frameOf(overviewPts()), () => { for (const n of g.nodes) n.fp = null; clearChats(); if (g.want && g.omitted) render(); else draw(); });
  }
  function goOverview() {
    if (history.state?.bf === 'focus') { try { history.back(); return; } catch {} }
    exitFocus(backCam); syncHash(); // opened from a link or a reload: there is no earlier entry to go back to
  }
  function markBack() { const b = $('back'); b.hidden = !focus; b.textContent = `← Back to ${view === 'city' ? 'city' : 'map'}`; }

  // ── the URL hash: view, camera, filters and open project ──
  const FILTERS = [['suggestions', 'suggested', true], ['dismissed', 'dismissed', false], ['archived', 'archived', false], ['alllinks', 'all', false], ['recency', 'recent', true]];
  const camText = c => [c.x, c.y, c.w].map(Math.round).join(',');
  // the overview's camera, or null while it is fitted (a fitted overview refits on return)
  const overviewCam = () => (cm ? cm.manual || cm.zoom : g && !autoFit) ? { x: vb.x, y: vb.y, w: vb.w } : null;
  function stateHash() {
    const h = new URLSearchParams(); h.set('view', view);
    if (FILTERS.some(([id, , on]) => $(id).checked !== on)) h.set('f', FILTERS.filter(([id]) => $(id).checked).map(f => f[1]).join('.') || 'none');
    if (focus) { h.set('project', focus); h.set('cam', camText(tween?.cam1 || vb)); if (backCam) h.set('back', camText(backCam)); } // mid-move, where it is heading
    else { const c = overviewCam(); if (c) h.set('cam', camText(c)); }
    return '#' + h.toString().replace(/%2C/gi, ',');
  }
  // filters from the hash; anything not named is off, and no `f` at all means the defaults
  function setFilters(f) {
    const on = f == null ? null : new Set(f.split('.')); let changed = false;
    for (const [id, name, def] of FILTERS) { const v = on ? on.has(name) : def; if ($(id).checked !== v) { $(id).checked = v; changed = true; } }
    applyToggles(); return changed;
  }
  let hashT = 0;
  function syncHash(push = false) {
    clearTimeout(hashT); hashT = 0; if (!data) return;
    const h = stateHash(); if (!push && h === location.hash) return;
    try { history[push ? 'pushState' : 'replaceState']({ bf: focus ? 'focus' : 'overview' }, '', location.pathname + location.search + h); } catch {}
  }
  const syncSoon = () => { clearTimeout(hashT); hashT = setTimeout(syncHash, 300); };
  window.addEventListener('popstate', () => {
    if (!data) return;
    const h = new URLSearchParams(location.hash.slice(1)), id = h.get('project'), cam = camOf(h.get('cam')), v = viewName(h.get('view')) || view;
    const changed = setFilters(h.get('f'));
    if (id && data.projects.some(p => p.id === id)) {
      if (id === focus && !changed) return;
      view = v; pendingFocus = id; pendingPush = false; cm = null; focusCam = cam; backCam = camOf(h.get('back'));
      if (g && !changed && !focus) { pendingFocus = null; show('project', id); enterFocus(id, false); } else { focus = null; render(); }
      return;
    }
    if (focus && v === view && !changed) return exitFocus(cam);
    if (focus) { focus = null; document.body.classList.remove('focusing'); $('focus-name').textContent = ''; closeSheet(); markBack(); }
    view = v; startCam = cam; autoFit = !cam; if (cm) { cm.manual = false; cm.zoom = null; } if (view !== 'city') cm = null;
    render();
  });

  // ── motion: one loop for the cooling layout and the focus transition ──
  const ease = u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  // `instant` jumps: used when the graph was just drawn, so there is no earlier picture to move from
  function beginTween(cam, done, instant = false) {
    if (!g) return;
    for (const n of g.nodes) n.from = { x: n.X ?? n.x, y: n.Y ?? n.y };
    for (const c of g.chats) c.from = { x: c.X ?? c.parent.X ?? c.parent.x, y: c.Y ?? c.parent.Y ?? c.parent.y };
    tween = { start: performance.now(), dur: reducedMotion || instant ? 0 : 560, u: 0, cam0: { ...vb }, cam1: cam || { ...vb }, done };
    kick();
  }
  function place() {
    const e = tween ? ease(tween.u) : 1;
    const put = (n, T) => { if (tween && n.from) { n.X = n.from.x + (T.x - n.from.x) * e; n.Y = n.from.y + (T.y - n.from.y) * e; } else { n.X = T.x; n.Y = T.y; } };
    for (const n of g.nodes) put(n, focus && n.fp ? n.fp : n);
    for (const c of g.chats) put(c, focus && c.fp ? c.fp : { x: c.parent.X, y: c.parent.Y });
  }
  const f1 = v => v.toFixed(1);
  function draw() {
    if (!g) return; place();
    const { nodes, nodeEls } = g;
    for (let i = 0; i < nodes.length; i++) nodeEls[i].setAttribute('transform', `translate(${f1(nodes[i].X)},${f1(nodes[i].Y)})`);
    for (let i = 0; i < g.chats.length; i++) {
      const c = g.chats[i], t = g.threadEls[i]; g.chatEls[i]?.setAttribute('transform', `translate(${f1(c.X)},${f1(c.Y)})`);
      if (t) { t.setAttribute('x1', f1(c.parent.X)); t.setAttribute('y1', f1(c.parent.Y)); t.setAttribute('x2', f1(c.X)); t.setAttribute('y2', f1(c.Y)); }
    }
    const u = vb.w / box().w; // world units per screen pixel, so gaps and arrowheads keep their size at any zoom
    // a member line stops at the rim of its project, which may be a see-through disc
    g.memberPts.forEach(([a, b], i) => { const el = g.memberEls[i], dx = a.X - b.X, dy = a.Y - b.Y, len = Math.hypot(dx, dy) || 1, t = Math.min(b.r, len);
      el.setAttribute('x1', f1(a.X)); el.setAttribute('y1', f1(a.Y)); el.setAttribute('x2', f1(b.X + dx / len * t)); el.setAttribute('y2', f1(b.Y + dy / len * t)); });
    // lines run rim to rim; the end direction is kept for an arrowhead
    const curve = (a, b, bow, gap) => { const dx = b.X - a.X, dy = b.Y - a.Y, len = Math.hypot(dx, dy) || 1;
      const cx = (a.X + b.X) / 2 - dy / len * bow, cy = (a.Y + b.Y) / 2 + dx / len * bow;
      const sx = cx - a.X, sy = cy - a.Y, sl = Math.hypot(sx, sy) || 1, ex = b.X - cx, ey = b.Y - cy, el = Math.hypot(ex, ey) || 1;
      const ta = Math.min(a.r + 1.5 * u, len * 0.4), tb = Math.min(b.r + gap * u, len * 0.4);
      const A = { x: a.X + sx / sl * ta, y: a.Y + sy / sl * ta }, B = { x: b.X - ex / el * tb, y: b.Y - ey / el * tb };
      return { d: bow ? `M ${f1(A.x)} ${f1(A.y)} Q ${f1(cx)} ${f1(cy)} ${f1(B.x)} ${f1(B.y)}` : `M ${f1(A.x)} ${f1(A.y)} L ${f1(B.x)} ${f1(B.y)}`, B, ux: ex / el, uy: ey / el }; };
    g.sharePts.forEach(([a, b], i) => { const { d } = curve(a, b, g.shares[i].bow, 1.5); g.shareEls[i].setAttribute('d', d); g.shareHits[i].setAttribute('d', d); });
    let k = 0;
    g.edges.forEach((e, i) => { const c = curve(e.u, e.v, e.bow, e.directed ? 2.5 : 1.5); g.edgeEls[i].setAttribute('d', c.d); g.edgeHits[i].setAttribute('d', c.d);
      if (!e.directed) return;
      const L = 8 * u, W = 3.4 * u, bx = c.B.x - c.ux * L, by = c.B.y - c.uy * L;
      g.arrowEls[k++]?.setAttribute('d', `M ${f1(c.B.x)} ${f1(c.B.y)} L ${f1(bx - c.uy * W)} ${f1(by + c.ux * W)} L ${f1(bx + c.uy * W)} ${f1(by - c.ux * W)} Z`); });
    // each group's field is a circle around the projects that sit in it first
    for (const r of g.regions) {
      const ms = r.members; r.el.style.display = ms.length ? '' : 'none'; if (!ms.length) continue;
      const cx = ms.reduce((t, n) => t + n.X, 0) / ms.length, cy = ms.reduce((t, n) => t + n.Y, 0) / ms.length;
      const R = Math.max(...ms.map(n => Math.hypot(n.X - cx, n.Y - cy) + n.r)) + 26;
      const c = r.el.firstChild, t = r.el.lastChild;
      c.setAttribute('cx', f1(cx)); c.setAttribute('cy', f1(cy)); c.setAttribute('r', f1(R)); Object.assign(r, { cx, cy, R });
      t.setAttribute('x', f1(cx)); t.setAttribute('y', f1(cy - R + 15 * u));
    }
    declutter();
  }
  // overview labels that would overlap one already placed wait for hover, zoom or search;
  // recent projects are placed first, so the current work always keeps its name
  function declutter() {
    if (!g || focus || !g.nodes.length) return;
    const b = box(), scale = b.w / vb.w;
    const ps = g.nodes.filter(n => n.kind === 'project' && n.X != null).sort((p, q) => (q.st.recent - p.st.recent) || (q.st.fresh - p.st.fresh) || (q.r - p.r));
    // dots are in the way too, except for the recent few, whose names always show
    const placed = [], dots = ps.map(n => { const x = (n.X - vb.x) * scale, y = (n.Y - vb.y) * scale, r = n.r * scale * 0.85; return { x0: x - r, x1: x + r, y0: y - r, y1: y + r }; });
    for (const n of ps) {
      const w = n.short.length * (n.st.recent ? 7.1 : 6.6) + 8, x = (n.X - vb.x) * scale, y = (n.Y - vb.y) * scale + n.r * scale + 2;
      const r = { x0: x - w / 2, x1: x + w / 2, y0: y, y1: y + 16 };
      const over = p => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0, hit = placed.some(over) || (!n.st.recent && dots.some(over));
      g.nodeEls[g.byId.get(n.id)].classList.toggle('tuck', hit); if (!hit) placed.push(r);
    }
  }
  function settle(nodes) { for (const n of nodes) if (n.home) { n.x = n.home.x; n.y = n.home.y; } }
  function remember() { settle(g.nodes); for (const n of g.nodes) pos.set(n.id, { x: n.x, y: n.y }); }
  function applyToggles() { svg.classList.toggle('all-links', $('alllinks').checked); svg.classList.toggle('recency', $('recency').checked); }
  // choosing an overview from the View menu: a new history entry, so Back returns to the last one
  function setView(v) {
    closeMenus();
    if (v === view && !focus) return;
    syncHash(); // the overview being left keeps its camera in its entry
    if (focus) { focus = null; document.body.classList.remove('focusing'); svg.classList.remove('focused'); $('focus-name').textContent = ''; closeSheet(); g = null; }
    view = v; store.set('bf-network-view', v); cm = null; g = null; autoFit = true; startCam = null; markBack();
    syncHash(true); render();
  }
  function kick() { if (!frame) frame = requestAnimationFrame(loop); }
  function loop() {
    frame = 0; if (!g) return;
    const now = performance.now(); let busy = false;
    if (!cooled(g.sim)) {
      if (reducedMotion) runToRest(g.sim); else { let n = 0; do tick(g.sim); while (++n < 2 && !cooled(g.sim) && performance.now() - now < 6); }
      busy = !cooled(g.sim); remember();
      if (autoFit && !focus && !tween) fit(busy ? 0.18 : 1);
    }
    if (tween) {
      tween.u = tween.dur ? Math.min(1, (now - tween.start) / tween.dur) : 1;
      const e = ease(tween.u), { cam0, cam1 } = tween;
      vb.x = cam0.x + (cam1.x - cam0.x) * e; vb.y = cam0.y + (cam1.y - cam0.y) * e; vb.w = cam0.w + (cam1.w - cam0.w) * e; applyView();
      if (tween.u >= 1) { const done = tween.done; tween = null; for (const n of g.nodes) n.from = null; draw(); done?.(); } else busy = true;
    }
    draw();
    if (busy) kick();
  }
  function heat(alpha) {
    if (!g) return; if (alpha != null) g.sim.alpha = Math.max(g.sim.alpha, alpha);
    if (reducedMotion) { runToRest(g.sim); remember(); draw(); if (autoFit && !focus) fit(1); return; }
    kick();
  }

  // ── view: pan, zoom and fit all go through the viewBox ──
  function box() { const r = svg.getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width || 900, h: r.height || 600 }; }
  function usable(b) { // the part of the screen not under the header, toolbar or sheet
    const open = sheet.classList.contains('open'), narrow = b.w <= 640;
    const top = narrow ? 76 : 70, bottom = narrow ? (open ? b.h * 0.54 : 58) : 40, right = !narrow && open ? (sheet.offsetWidth || 340) : 0;
    return { x: 0, y: top, w: Math.max(120, b.w - right), h: Math.max(120, b.h - top - bottom) };
  }
  function frameOf(pts, pad = 50) {
    if (!pts.length) return null;
    const b = box(), u = usable(b); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x - p.r); y0 = Math.min(y0, p.y - p.r); x1 = Math.max(x1, p.x + p.r); y1 = Math.max(y1, p.y + p.r + 16); }
    const scale = Math.min(u.w / Math.max(160, x1 - x0 + pad * 2), u.h / Math.max(120, y1 - y0 + pad * 2), 3.2);
    return { x: (x0 + x1) / 2 - (u.x + u.w / 2) / scale, y: (y0 + y1) / 2 - (u.y + u.h / 2) / scale, w: b.w / scale };
  }
  function applyView() {
    const b = box(), scale = b.w / vb.w; vb.h = vb.w * b.h / b.w;
    svg.setAttribute('viewBox', `${f1(vb.x)} ${f1(vb.y)} ${f1(vb.w)} ${f1(vb.h)}`);
    svg.style.setProperty('--u', (1 / scale).toFixed(3) + 'px');
    // labels appear once you zoom in past the fitted view; small councils always show them
    svg.classList.toggle('z1', scale > homeScale * 1.6); svg.classList.toggle('z2', scale > homeScale * 2.8);
    declutter(); campusDeclutter(); syncSoon();
  }
  function fit(k = 1) { if (!g || !g.nodes.length) return; const t = frameOf(overviewPts()); if (!t) return; homeScale = box().w / t.w; vb.x += (t.x - vb.x) * k; vb.y += (t.y - vb.y) * k; vb.w += (t.w - vb.w) * k; applyView(); }
  function fitNow() { if (!g) return; autoFit = !focus; beginTween(frameOf(focus ? focusPts() : overviewPts())); }
  function toWorld(p) { const b = box(); return { x: vb.x + (p.clientX - b.left) / b.w * vb.w, y: vb.y + (p.clientY - b.top) / b.h * vb.h }; }
  function zoomAt(p, w) { if (cm) cm.manual = true; w = Math.max(40, Math.min(40000, w)); const f = w / vb.w; vb.x = p.x - (p.x - vb.x) * f; vb.y = p.y - (p.y - vb.y) * f; vb.w = w; applyView(); }
  svg.addEventListener('wheel', e => { if (!g && !cm) return; e.preventDefault(); autoFit = false; tween = tween && { ...tween, cam0: vb, cam1: vb }; zoomAt(toWorld(e), vb.w * Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.0015)))); }, { passive: false });

  svg.addEventListener('pointerdown', e => {
    if (!g && !cm) return; pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (pointers.size === 2) { // two fingers: pinch to zoom
      cancelDrag(); pan = null; if (lift) { clearTimeout(lift.timer); lift.el.classList.remove('lifting'); lift = null; renderCampus(); } const [p, q] = [...pointers.values()];
      pinch = { d: Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY) || 1, w: vb.w }; suppressClick = true; return;
    }
    if (e.button !== 0) return; suppressClick = false;
    if (cm) { const b = e.target.closest?.('.bld'); if (b) liftStart(e, b);
      if (!lift?.armed && !e.target.closest?.('.fp,.fp-hit')) pan = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false }; return; }
    const el = e.target.closest?.('.nodes .node');
    if (el) { const i = g.elIndex.get(el), n = g.nodes[i]; if (!focus || n.fp) drag = { node: n, i, x: e.clientX, y: e.clientY, moved: false }; }
    else if (!e.target.closest?.('[data-link],[data-share],.chats .node')) pan = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false };
  });
  // capture only once it is a drag, so a plain click still lands on its node
  svg.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (pinch && pointers.size === 2) {
      const [p, q] = [...pointers.values()], mid = { clientX: (p.clientX + q.clientX) / 2, clientY: (p.clientY + q.clientY) / 2 };
      autoFit = false; zoomAt(toWorld(mid), pinch.w * pinch.d / (Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY) || 1)); return;
    }
    if (lift && !lift.armed && Math.hypot(e.clientX - lift.x, e.clientY - lift.y) >= 6) { clearTimeout(lift.timer); lift = null; } // a touch that moves is a pan
    if (lift?.armed) { liftMove(e); return; }
    if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      if (!drag.moved) {
        drag.moved = true; autoFit = false; svg.setPointerCapture?.(e.pointerId); svg.classList.add('dragging'); highlight(drag.i); hideTip();
        if (!focus && !reducedMotion) { g.sim.alphaTarget = 0.25; heat(0.25); }
      }
      const p = toWorld(e);
      if (focus) { drag.node.fp = p; draw(); } else { drag.node.fx = drag.node.x = p.x; drag.node.fy = drag.node.y = p.y; if (reducedMotion) draw(); }
    } else if (pan) {
      const b = box(), dx = e.clientX - pan.x, dy = e.clientY - pan.y; if (!pan.moved && Math.hypot(dx, dy) < 4) return;
      if (!pan.moved) svg.setPointerCapture?.(e.pointerId); pan.moved = true; autoFit = false; if (cm) cm.manual = true; svg.classList.add('panning');
      vb.x = pan.vx - dx / b.w * vb.w; vb.y = pan.vy - dy / b.h * vb.h; applyView();
    } else if (!tip.hidden) moveTip(e);
  });
  function cancelDrag() { if (!drag) return; const n = drag.node; if (!focus && !pins.has(n.id)) n.fx = n.fy = null; if (!focus) g.sim.alphaTarget = 0; drag = null; svg.classList.remove('dragging'); }
  function release(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (lift) { const L = lift; lift = null; liftEnd(L); }
    if (drag) {
      const { node, moved, i } = drag; drag = null; svg.classList.remove('dragging');
      if (moved) {
        suppressClick = true;
        if (!focus) { pins.set(node.id, { x: node.x, y: node.y }); g.nodeEls[i].classList.add('pinned'); g.sim.alphaTarget = 0; heat(0.3); }
      }
      // hover events were ignored while dragging, so re-read what is under the pointer now
      const under = e.type === 'pointerup' ? document.elementFromPoint?.(e.clientX, e.clientY) : null;
      const j = under && svg.contains(under) ? nodeIndex(under.closest?.('.nodes .node')) : -1; highlight(j < 0 ? null : j);
    }
    if (pan) { suppressClick = pan.moved; pan = null; svg.classList.remove('panning'); }
  }
  svg.addEventListener('pointerup', release); svg.addEventListener('pointercancel', release);
  function unpin(id) { const n = g?.nodes[g.byId.get(id)]; pins.delete(id); if (!n) return; n.fx = n.fy = null; g.nodeEls[g.byId.get(id)].classList.remove('pinned'); heat(0.3); }
  window.addEventListener('resize', () => { if (cm) return cm.manual ? applyView() : campusFit(); applyView(); if (autoFit && !focus) fit(1); });

  // ── hover: labels, the neighbourhood, and what a line means ──
  const nodeIndex = el => el ? (g.elIndex.get(el) ?? -1) : -1;
  function highlight(i) {
    if (hovered === i || !g) return;
    svg.querySelectorAll('.hl').forEach(el => el.classList.remove('hl', 'hub')); hovered = i;
    svg.classList.toggle('hovering', i != null); if (i == null) return;
    g.nodeEls[i].classList.add('hl', 'hub'); for (const j of g.near[i]) g.nodeEls[j].classList.add('hl'); for (const el of g.touching[i]) el.classList.add('hl');
  }
  function tipFor(el) {
    const d = el.dataset;
    if (el.classList.contains('chat')) { const s = data.sources.find(s => s.id === d.source), n = new Set(s?.chats || []).size;
      return `${plural(n, 'chat session')} on this reading\nThey open together on its discussion page.`; }
    if (d.project) { const n = g.nodes[g.byId.get('p:' + d.project)], st = n?.st, c = data.links.filter(l => (l.a === d.project || l.b === d.project) && l.state !== 'dismissed').length;
      return `${projectTitle(d.project)}\n${plural(st?.reads || 0, 'reading')} · ${st?.outs || 0} written · ${plural(st?.chats || 0, 'chat')} · ${plural(c, 'connection')}`
        + (st?.t ? `\nLast active ${ago(st.t)}` : '') + `\nGroup (a guess): ${groupNames(st?.groups)}`; }
    if (d.output) return 'Writing · ' + (data.outputs.find(o => o.id === d.output)?.title || '');
    if (d.source) { const s = data.sources.find(s => s.id === d.source); return `Reading · ${s?.title || ''}\n${plural(new Set(s?.chats || []).size, 'chat session')}`; }
    if (d.link) { const l = data.links.find(l => l.id === d.link); if (!l) return '';
      const style = l.state === 'suggested' ? 'Red dashed: an AI suggestion, not yet yours.' : l.state === 'dismissed' ? 'Faint: you dismissed this.' : 'Green solid: you made this, or your writing uses it.';
      return `${originText(l)} · ${relText(l.relation)}\n${style}${l.stale ? '\nDotted: its evidence has changed since.' : ''}\nClick for the reason and evidence.`; }
    if (d.share) { const s = g.shares.find(s => s.id === d.share); return `Grey: shared material, ${plural(s?.items.length || 0, 'item')} filed in both.\nNot a recorded connection.`; }
    return '';
  }
  function moveTip(e) { const w = tip.offsetWidth || 220, x = e.clientX + 14 + w > innerWidth ? e.clientX - w - 10 : e.clientX + 14; tip.style.left = x + 'px'; tip.style.top = (e.clientY + 16) + 'px'; }
  function hideTip() { tip.hidden = true; }
  svg.addEventListener('pointerover', e => {
    if (cm) { if (lift?.moved) return; const el = e.target.closest?.('.bld,.fp,.fp-hit'); campusHl(el?.dataset.project || null);
      if (el && e.pointerType !== 'touch') { tip.textContent = campusTip(el); tip.hidden = !tip.textContent; moveTip(e); } else hideTip(); return; }
    if (drag || pan || pinch || !g) return;
    const el = e.target.closest?.('.node,[data-link],[data-share]');
    if (el && e.pointerType !== 'touch') { tip.textContent = tipFor(el); tip.hidden = !tip.textContent; moveTip(e); } else hideTip();
    const i = nodeIndex(e.target.closest?.('.nodes .node'));
    if (i < 0 && e.target.closest?.('[data-link],[data-share]')?.classList.contains('hl')) return; // moving onto a lit line keeps it lit, so it can be clicked
    highlight(i < 0 ? null : i);
  });
  svg.addEventListener('pointerleave', () => { hideTip(); if (cm) campusHl(null); if (!drag) highlight(null); });
  svg.addEventListener('focusin', e => { if (cm) return campusHl(e.target.closest?.('.bld')?.dataset.project || null); if (!g) return; const i = nodeIndex(e.target.closest?.('.nodes .node')); highlight(i < 0 ? null : i); });
  svg.addEventListener('focusout', () => { if (cm) campusHl(null); highlight(null); });

  // ── search: matches stay lit, the rest recede ──
  function applySearch() {
    if (!g) return;
    const q = $('search').value.trim().toLowerCase(); let first = null;
    svg.classList.toggle('searching', !!q);
    g.nodes.forEach((n, i) => {
      let hay = n.title + ' ' + (n.ref.summary || '');
      if (n.kind === 'project') hay += ' ' + outputsOf(n.key).map(o => o.title).join(' ') + ' ' + sourcesOf(n.key).map(s => s.title).join(' ');
      const m = !!q && hay.toLowerCase().includes(q); g.nodeEls[i].classList.toggle('match', m); if (m && (!first || (first.kind !== 'project' && n.kind === 'project'))) first = n;
    });
    g.firstMatch = first;
  }

  // ── the side sheet ──
  function closeSheet() { const was = sheet.classList.contains('open'); sheet.classList.remove('open'); document.body.classList.remove('sheet-open'); selected = null; markSelected(); if (cm && was && !cm.manual) campusFit(); }
  function markSelected() {
    document.querySelectorAll('.selected,.ends').forEach(el => el.classList.remove('selected', 'ends'));
    if (cm) { if (selected) for (const el of document.querySelectorAll('.bld,.row,.fp,.c-label')) if ((el.dataset[selected.kind] ?? (selected.kind === 'project' && el.dataset.for)) === selected.id) el.classList.add('selected'); campusDeclutter(); return; }
    if (!selected || !g) return;
    const { kind, id } = selected;
    if (kind === 'link') { g.edgeEls.forEach(el => el.dataset.link === id && el.classList.add('selected'));
      const l = data.links.find(l => l.id === id); // both projects of an open connection keep their names
      for (const p of l ? [l.a, l.b] : []) g.nodeEls[g.byId.get('p:' + p)]?.classList.add('ends'); }
    else if (kind === 'share') g.shareEls.forEach(el => el.dataset.share === id && el.classList.add('selected'));
    else g.nodeEls.forEach(el => el.dataset[kind] === id && el.classList.add('selected'));
  }
  const close = '<button class="close" type="button" data-close aria-label="Close">×</button>';
  const groupNames = ids => (ids || ['other']).map(id => groupList().find(gr => gr.id === id)?.label || id).join(', ');
  const projectBtn = id => `<button class="inline" type="button" data-project="${esc(id)}">${esc(projectTitle(id))}</button>`;
  function writingRow(o) {
    const url = safeUrl(o.url), file = String(o.path || '').split('/').pop();
    return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(o.title)}</a>` : `<span>${esc(o.title)}</span>`}<small>${esc(file)} · version ${esc(ver(o.revision))}${o.missing ? ' · <em class="warn">file missing, record kept</em>' : ''}</small></li>`;
  }
  function readingRow(s, withButton = true) {
    const url = safeUrl(s.url), n = new Set(s.chats || []).size;
    return `<li>${withButton ? `<button class="inline" type="button" data-source="${esc(s.id)}">${esc(s.title)}</button>` : url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : `<span>${esc(s.title)}</span>`}<small>${esc(s.kind || 'reading')} · ${plural(n, 'chat session')} · <a href="${esc(discussionUrl(s))}" target="_blank" rel="noopener">open discussion</a></small></li>`;
  }
  function show(kind, id, quiet = false) {
    if (!data) return;
    let html = '';
    if (kind === 'project') {
      const p = data.projects.find(p => p.id === id); if (!p) return closeSheet();
      const outs = outputsOf(id), reads = sourcesOf(id);
      const links = data.links.filter(l => (l.a === id || l.b === id) && (l.state !== 'dismissed' || $('dismissed').checked));
      const shares = (g?.shares || []).filter(s => s.pa === id || s.pb === id);
      const n = g?.nodes[g.byId.get('p:' + id)], st = n?.st || cm?.byId.get(id)?.st, short = shortOf(p.title || id), changes = changesOf(p);
      html = `${close}<p class="kicker">Project${p.status && p.status !== 'active' ? ' · ' + esc(p.status) : ''}${st?.t ? ' · active ' + esc(ago(st.t)) : ''}</p><h2>${esc(p.title || id)}</h2>`
        + (short !== String(p.title || id) ? `<p class="fine">Shown on the map as “${esc(short)}”.</p>` : '')
        + (view === 'city' && readPlaces().placed[id] ? '<p><button type="button" data-unplace>Let the city place its building</button><small>You placed it in the city; that place is saved in this browser only.</small></p>' : '')
        + `<p class="groups">${esc(groupNames(st?.groups || groupsOf(p)))} <small>a first guess from the title, not a filing; correct it in OVERRIDES in network.js</small></p>`
        + (p.summary ? `<p class="summary">${esc(clip(p.summary, 320))}</p>` : '')
        + `<h3>Writing <span>${outs.length}</span></h3>` + (outs.length ? `<ul>${outs.map(writingRow).join('')}</ul>` : '<p class="muted">Nothing written yet. A project can stay a collection of reading and talk.</p>')
        + `<h3>Readings <span>${reads.length}</span></h3>` + (reads.length ? `<ul>${reads.map(s => readingRow(s)).join('')}</ul>` : '<p class="muted">Link a reading to this project from Discuss to gather it here.</p>')
        + `<h3>Connections <span>${links.length + shares.length}</span></h3>`
        + (links.length || shares.length ? `<ul>${links.map(l => `<li>${glyph(lineKind(l) + (l.stale ? ' stale' : ''))}<button class="inline" type="button" data-link="${esc(l.id)}">${esc(projectTitle(l.a === id ? l.b : l.a))}</button><small>${esc(relText(l.relation))} · ${esc(originText(l).toLowerCase())}</small></li>`).join('')}`
          + `${shares.map(s => `<li>${glyph('share')}<button class="inline" type="button" data-share="${esc(s.id)}">${esc(projectTitle(s.pa === id ? s.pb : s.pa))}</button><small>${plural(s.items.length, 'shared item')}, not a recorded connection</small></li>`).join('')}</ul>`
          : '<p class="muted">None yet. Say how this relates to other work in Discuss, and it will show here.</p>')
        + (changes.length ? `<h3>Latest updates</h3><ul>${changes.slice(0, 3).map(c => `<li><span>${esc(c.what)}</span><small>${esc(ago(c.t))}</small></li>`).join('')}</ul>` : '')
        + (pins.has('p:' + id) ? '<p><button type="button" data-unpin>Unpin from the map</button></p>' : '')
        + `<details><summary>Attach an existing file</summary><form id="output-form"><label>File <input name="file" type="text" required placeholder="Absolute path inside this project"></label><label>Title <input name="title" type="text" placeholder="Optional"></label><button>Attach</button><small class="muted">The file stays where it is. Nothing is copied or rewritten.</small></form></details>`;
    } else if (kind === 'link') {
      const l = data.links.find(l => l.id === id); if (!l) return closeSheet();
      const uses = (l.uses || []).map(u => data.uses.find(x => x.id === u)).filter(Boolean);
      const src = l.source && data.sources.find(s => s.id === l.source);
      const checked = Object.entries(l.evidence_versions || {});
      const evidence = uses.map(u => { const o = data.outputs.find(o => o.id === u.output);
          return `<div class="ev"><p class="ev-head">${esc(o?.title || u.output)}</p><blockquote>${esc(u.excerpt || '')}</blockquote><small>line ${esc(u.line)} · version ${esc(ver(u.revision))} · ${u.active ? 'still in the current file' : '<em class="warn">removed from the current file</em>'}${o?.revision && u.revision && o.revision !== u.revision ? ' · file changed since' : ''}</small></div>`; }).join('')
        // the excerpt is today's notes, so it carries today's version; the version the suggestion saw is reported beside it
        + (src ? `<div class="ev"><p class="ev-head">From the reading ${`<button class="inline" type="button" data-source="${esc(src.id)}">${esc(src.title)}</button>`}</p>${src.excerpt ? `<blockquote>${esc(src.excerpt)}</blockquote>` : ''}<small>${src.excerpt ? 'Your notes now' : 'Notes now'}, version ${esc(ver(src.revision))}</small>`
          + `<small>${!l.source_revision ? 'No version was recorded when this was suggested' : `When suggested: version ${esc(ver(l.source_revision))}${!src.revision ? '' : src.revision === l.source_revision ? ' · unchanged' : ' · <em class="warn">the discussion has changed since, so this excerpt is newer than the suggestion</em>'}`}</small></div>` : '')
        + (checked.length ? `<p class="ev-head">Files as they were when suggested</p><ul class="files">${checked.map(([oid, rev]) => { const o = data.outputs.find(o => o.id === oid);
            return `<li><span>${esc(o?.title || oid)}</span><small>version ${esc(ver(rev))}${!o || o.missing ? ' · <em class="warn">file missing</em>' : o.revision !== rev ? ' · <em class="warn">changed since</em>' : ' · unchanged'}</small></li>`; }).join('')}</ul>` : '');
      const actions = l.state === 'dismissed' ? '<button type="button" data-action="restore">Restore</button>'
        : (l.state === 'suggested' ? '<button type="button" class="primary" data-action="link">Link</button>' : '') + '<button type="button" data-action="dismiss">Dismiss</button>';
      html = `${close}<p class="kicker">${glyph(lineKind(l) + (l.stale ? ' stale' : ''))}${esc(originText(l))}</p>`
        + `<h2>${projectBtn(l.a)} <span class="rel">${esc(relText(l.relation))}</span> ${projectBtn(l.b)}</h2>`
        + (l.stale ? '<p class="warn">The evidence behind this has changed. Check it still holds.</p>' : '')
        + `<h3>Reason</h3><p class="reason">${esc(l.reason || 'No reason was recorded.')}</p>`
        + `<h3>Evidence</h3>${evidence || '<p class="muted">No excerpts were recorded for this connection.</p>'}`
        + `<div class="actions">${actions}</div><p class="fine">A connection records relevance or use. It does not mean the projects agree, or that either is right.</p>`;
    } else if (kind === 'share') {
      const s = g?.shares.find(s => s.id === id); if (!s) return closeSheet();
      html = `${close}<p class="kicker">${glyph('share')}Shared material</p><h2>${projectBtn(s.pa)} <span class="rel">and</span> ${projectBtn(s.pb)}</h2>`
        + `<p>Both projects hold ${s.items.length === 1 ? 'this item' : `these ${s.items.length} items`}. That is shared material, not a recorded connection.</p>`
        + `<ul>${s.items.map(i => `<li><button class="inline" type="button" data-${i.kind}="${esc(i.ref.id)}">${esc(i.ref.title || i.ref.id)}</button><small>${i.kind === 'output' ? 'writing' : 'reading'}</small></li>`).join('')}</ul>`
        + `<p class="fine">To connect the projects, say how they relate in <a href="${esc(discussBase() + '/')}" target="_blank" rel="noopener">Discuss</a>.</p>`;
    } else if (kind === 'output') {
      const o = data.outputs.find(o => o.id === id); if (!o) return closeSheet();
      html = `${close}<p class="kicker">Writing</p><h2>${esc(o.title)}</h2><ul>${writingRow(o)}</ul><p class="muted path">${esc(o.path || '')}</p><h3>Projects</h3><p>${(o.projects || []).map(projectBtn).join(', ') || 'None yet.'}</p>`;
    } else if (kind === 'source') {
      const s = data.sources.find(s => s.id === id); if (!s) return closeSheet();
      html = `${close}<p class="kicker">Reading</p><h2>${esc(s.title)}</h2><ul>${readingRow(s, false)}</ul>${s.excerpt ? `<h3>Your notes</h3><blockquote>${esc(s.excerpt)}</blockquote><small>version ${esc(ver(s.revision))}</small>` : ''}<h3>Projects</h3><p>${(s.projects || []).map(projectBtn).join(', ') || 'None yet.'}</p>`;
    }
    const was = sheet.classList.contains('open');
    selected = { kind, id }; sheet.innerHTML = html; sheet.classList.add('open'); document.body.classList.add('sheet-open'); markSelected();
    if (cm && !was && !cm.manual) campusFit();
    sheet.querySelectorAll('[data-action]').forEach(b => b.onclick = () => act('/project-network/edge', { root, id, action: b.dataset.action }));
    const form = sheet.querySelector('#output-form');
    if (form) form.onsubmit = async e => { e.preventDefault(); const f = new FormData(form); await act('/project-network/output', { root, project: id, file: f.get('file'), title: f.get('title') }); };
    if (!quiet && kind !== 'project') sheet.scrollTop = 0;
  }
  async function act(url, body) { try { await request(url, body); await load(); } catch (e) { say(e.message, true); } }

  // ── choosing things ──
  function pick(d) {
    if (d.project) openProject(d.project);
    else if (d.link) show('link', d.link); else if (d.share) show('share', d.share);
    else if (d.output) show('output', d.output); else if (d.source) show('source', d.source);
  }
  svg.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    const el = e.target.closest?.('[data-project],[data-output],[data-source],[data-link],[data-share]');
    if (el) pick(el.dataset); else if (focus) goOverview(); else closeSheet();
  });
  svg.addEventListener('keydown', e => { if (e.key !== 'Enter' && e.key !== ' ') return; const el = e.target.closest?.('[data-project],[data-output],[data-source],[data-link],[data-share]'); if (el) { e.preventDefault(); pick(el.dataset); } });
  sheet.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { if (focus && !(selected?.kind === 'project' && selected.id === focus)) show('project', focus); else if (focus) goOverview(); else closeSheet(); return; }
    if (e.target.closest('[data-unplace]')) { unplace(selected.id); return; }
    if (e.target.closest('[data-unpin]')) { unpin('p:' + selected.id); show('project', selected.id, true); return; }
    const b = e.target.closest('button[data-project],button[data-link],button[data-share],button[data-output],button[data-source]'); if (b) pick(b.dataset);
  });
  $('empty').addEventListener('click', e => { if (e.target.closest('[data-refresh]')) load(true); });
  $('overview').onclick = () => { if (focus) goOverview(); else if (cm) campusFit(null); else fitNow(); };
  $('back').onclick = goOverview;
  function escape() {
    if (menuOpen()) closeMenus(true);
    else if (!$('intro').hidden) closeIntro();
    else if (focus) { if (selected && !(selected.kind === 'project' && selected.id === focus)) show('project', focus); else goOverview(); }
    else if (sheet.classList.contains('open')) closeSheet();
  }
  function toggleScheme() { const next = document.documentElement.dataset.scheme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.scheme = next; store.set('bf-network-scheme', next); }
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName || '');
    if (e.key === 'Escape') { if (menuOpen() || !$('intro').hidden) return escape(); if (e.target.id === 'search') { if (e.target.value) { e.target.value = ''; applySearch(); } e.target.blur(); return; } if (!typing) escape(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase(), toggle = { s: 'suggestions', d: 'dismissed', a: 'archived' }[k], quick = { c: 'alllinks', r: 'recency' }[k];
    if (k === '/') { e.preventDefault(); $('search').focus(); }
    else if (k === 'f') { if (cm) campusFit(null); else fitNow(); }
    else if (toggle) { $(toggle).checked = !$(toggle).checked; render(); }
    else if (quick) { $(quick).checked = !$(quick).checked; applyToggles(); syncHash(); }
    else if (k === '?') toggleIntro();
    else if (k === 't') toggleScheme();
    else if (k === 'u') { for (const id of [...pins.keys()]) unpin(id); }
  });
  $('search').addEventListener('input', applySearch);
  $('search').addEventListener('keydown', e => { if (e.key === 'Enter' && g?.firstMatch) { const n = g.firstMatch; pick({ [n.kind]: n.key }); } });
  for (const id of ['suggestions', 'archived', 'dismissed']) $(id).onchange = render;
  for (const id of ['alllinks', 'recency']) $(id).onchange = () => { applyToggles(); syncHash(); };

  // ── the View and Filters menus: a button that opens a small list, each choice ticked when on ──
  const MENUS = [['view', 'view-menu'], ['filters-btn', 'filters']];
  const menuOpen = () => MENUS.some(([, m]) => !$(m).hidden);
  function closeMenus(refocus = false) {
    for (const [b, m] of MENUS) { if (refocus && !$(m).hidden) $(b).focus(); $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
  }
  function openMenu(b, m) {
    const was = !$(m).hidden; closeMenus(); if (was) return;
    $(m).hidden = false; $(b).setAttribute('aria-expanded', 'true');
    ($(m).querySelector('[aria-current="true"]') || $(m).querySelector('input,button'))?.focus();
  }
  for (const [b, m] of MENUS) $(b).onclick = () => openMenu(b, m);
  document.addEventListener('pointerdown', e => { if (menuOpen() && !e.target.closest?.('.menu')) closeMenus(); });
  for (const [, m] of MENUS) $(m).addEventListener('keydown', e => { // arrow keys move through a menu's choices
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; e.preventDefault();
    const items = [...$(m).querySelectorAll('input,button')].filter(el => el.offsetParent !== null || !el.closest('.graph-only')), i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });
  $('view-menu').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  // which overview is on, ticked, and the name on the View button
  function syncMenus() {
    $('view-name').textContent = view === 'city' ? 'City' : 'Map';
    for (const b of $('view-menu').querySelectorAll('[data-view]')) b.setAttribute('aria-current', String(b.dataset.view === view));
  }

  // ── what this page shows: one paragraph, once on a first visit, and behind "?" ──
  function toggleIntro(show = $('intro').hidden) { $('intro').hidden = !show; $('help').setAttribute('aria-expanded', String(show)); if (show) { closeMenus(); $('intro-ok').focus(); } }
  function closeIntro() { toggleIntro(false); store.set('bf-network-intro', 'seen'); $('help').focus(); }
  $('help').onclick = () => $('intro').hidden ? toggleIntro(true) : closeIntro();
  $('intro-ok').onclick = closeIntro;
  if (!store.get('bf-network-intro')) toggleIntro(true);
  $('fit').onclick = () => cm ? campusFit(null) : fitNow(); $('scheme').onclick = toggleScheme; $('refresh').onclick = () => load(true);
  $('root').onchange = () => { root = $('root').value; selected = null; focus = null; pos.clear(); pins.clear(); g = null; cm = null; autoFit = true; startCam = null; closeSheet(); svg.classList.remove('focused'); document.body.classList.remove('focusing'); $('focus-name').textContent = ''; markBack(); load(); };
  if (hash0.has('f')) setFilters(hash0.get('f'));
  syncMenus(); applyView();
  load();
}
