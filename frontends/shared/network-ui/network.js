const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ── force simulation ─────────────────────────────────────────────────
// Shared by layout() and the live map. Deterministic: seeds come from node
// order (a sunflower spiral), never Math.random, so the same input settles
// the same way. Alpha cools from 1 to ALPHA_MIN in about 180 ticks.
const ALPHA_MIN = 0.002, ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 180), VELOCITY_KEEP = 0.58, MAX_STEP = 14, REACH2 = 520 * 520, GRAVITY = 0.035;
const seed = (i, cx, cy, spread = 14) => { const r = spread * Math.sqrt(0.5 + i), a = i * Math.PI * (3 - Math.sqrt(5)); return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
const radius = n => n.kind === 'output' ? Math.min(5, 3 + 0.5 * Math.sqrt(n.deg)) : n.kind === 'source' ? Math.min(4.5, 2.7 + 0.5 * Math.sqrt(n.deg)) : Math.min(16, 5.5 + 1.7 * Math.sqrt(n.deg));
function makeSim(nodes, links, cx = 0, cy = 0) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const ls = links.map(l => ({ ...l, s: byId.get(l.a), t: byId.get(l.b) })).filter(l => l.s && l.t && l.s !== l.t);
  for (const n of nodes) n.deg = 0;
  for (const l of ls) { l.s.deg++; l.t.deg++; }
  nodes.forEach((n, i) => { if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) Object.assign(n, seed(i, cx, cy)); n.vx = n.vx || 0; n.vy = n.vy || 0; n.r = radius(n); });
  for (const l of ls) { l.rest = l.s.r + l.t.r + (l.kind === 'member' ? 26 : 110); l.k = (l.kind === 'member' ? 0.7 : l.state === 'suggested' ? 0.35 : 0.8) / Math.min(l.s.deg, l.t.deg); l.bias = l.s.deg / (l.s.deg + l.t.deg); }
  return { nodes, links: ls, cx, cy, alpha: 1, alphaTarget: 0 };
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
      const min = p.r + q.r + 3, f = a / Math.max(d2, min * min * 0.5), wq = q.r * 7;
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
    p.vx = (p.vx + (cx - p.x) * GRAVITY * a) * VELOCITY_KEEP; p.vy = (p.vy + (cy - p.y) * GRAVITY * a) * VELOCITY_KEEP;
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
  const hash0 = new URLSearchParams(location.hash.slice(1));
  let root = new URLSearchParams(location.search).get('root') || '';
  let data = null, g = null, focus = null, selected = null, savedView = null;
  let pendingFocus = hash0.get('project'), pendingPick = hash0.get('link') ? { link: hash0.get('link') } : hash0.get('output') ? { output: hash0.get('output') } : hash0.get('source') ? { source: hash0.get('source') } : null;
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

  // ── build the graph; positions of nodes that stay are kept ──
  function render() {
    if (!data) return;
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
    const nodes = [...projects.map(p => ({ id: 'p:' + p.id, key: p.id, kind: 'project', title: String(p.title || p.id), ref: p })),
      ...items.map(i => ({ id: (i.kind === 'output' ? 'o:' : 's:') + i.ref.id, key: i.ref.id, kind: i.kind, title: String(i.ref.title || i.ref.id), ref: i.ref, ps: i.ps }))];
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
      if (old) { n.x = old.x; n.y = old.y; } else { fresh++; const parent = n.ps && pos.get('p:' + n.ps[0]); Object.assign(n, parent ? seed(i % 40 + 1, parent.x, parent.y, 5) : seed(i, 0, 0)); }
      const pin = pins.get(n.id); if (pin) { n.fx = n.x = pin.x; n.fy = n.y = pin.y; }
    });
    const prev = g?.sim.alpha ?? 1;
    const sim = makeSim(nodes, [...members, ...edges.filter(e => e.state !== 'dismissed')], 0, 0);
    sim.alpha = fresh > nodes.length / 2 ? 1 : Math.max(prev, 0.4);
    if (sim.alpha === 1 && !reducedMotion) for (let i = 0; i < 25; i++) tick(sim); // untangle before the first paint
    const byId = new Map(nodes.map((n, i) => [n.id, i]));
    // several relationships between one pair bow apart; a grey shared line beside a link bows off it
    const pairCount = new Map(); for (const e of edges) { const k = [e.a, e.b].sort().join('|'); pairCount.set(k, (pairCount.get(k) || 0) + 1); }
    const seen = new Map();
    for (const e of edges) {
      const [u, v] = [e.a, e.b].sort(), k = u + '|' + v, i = seen.get(k) || 0, n = pairCount.get(k); seen.set(k, i + 1);
      e.u = nodes[byId.get(u)]; e.v = nodes[byId.get(v)];
      e.bow = (i - (n - 1) / 2) * 26;
    }
    for (const s of shares) s.bow = pairCount.has(s.a + '|' + s.b) ? 18 : 0;

    const nodeMark = n => `<g class="node ${n.kind}${pins.has(n.id) ? ' pinned' : ''}" data-${n.kind}="${esc(n.key)}" tabindex="${n.kind === 'project' ? 0 : -1}" role="button" aria-label="${esc(KIND[n.kind] + ': ' + n.title + (n.kind === 'source' ? ', ' + plural(new Set(n.ref.chats || []).size, 'chat session') : ''))}"><circle class="hit" r="${(n.r + 6).toFixed(1)}"/><circle class="dot" r="${n.r.toFixed(1)}"/><text class="label" text-anchor="middle" y="${n.r.toFixed(1)}" dy="1.3em">${esc(clip(n.title, narrow() ? 22 : 44))}</text></g>`;
    svg.innerHTML = `<g class="lines">${members.map(() => '<line class="member"/>').join('')}`
      + shares.map(s => `<path class="hit-line" fill="none" data-share="${esc(s.id)}" aria-hidden="true"/>`).join('')
      + edges.map(e => `<path class="hit-line" fill="none" data-link="${esc(e.link.id)}" aria-hidden="true"/>`).join('')
      + shares.map(s => `<path class="share${s.items.length > 2 ? ' many' : ''}" fill="none" data-share="${esc(s.id)}" tabindex="0" role="button" aria-label="${esc(`Shared material, not a recorded connection: ${projectTitle(s.pa)} and ${projectTitle(s.pb)} both hold ${plural(s.items.length, 'item')}`)}"/>`).join('')
      + edges.map(e => { const l = e.link, label = esc(`${originText(l)}: ${projectTitle(l.a)} ${relText(l.relation)} ${projectTitle(l.b)}`);
        return `<path class="edge ${lineKind(l)}${l.stale ? ' stale' : ''}" fill="none" data-link="${esc(l.id)}" tabindex="0" role="button" aria-label="${label}"/>`; }).join('')
      + `<g class="threads"></g></g><g class="nodes">${nodes.map(nodeMark).join('')}</g><g class="chats"></g>`;
    const lines = svg.querySelector('.lines');
    const memberEls = lines.querySelectorAll('line.member'), shareEls = lines.querySelectorAll('path.share'), edgeEls = lines.querySelectorAll('path.edge'), hitEls = lines.querySelectorAll('path.hit-line');
    const nodeEls = svg.querySelectorAll('.nodes .node');
    const near = nodes.map(() => new Set()), touching = nodes.map(() => []);
    const join = (a, b, ...els) => { const i = byId.get(a), j = byId.get(b); near[i].add(j); near[j].add(i); touching[i].push(...els); touching[j].push(...els); };
    members.forEach((m, k) => join(m.a, m.b, memberEls[k]));
    shares.forEach((s, k) => join(s.a, s.b, shareEls[k]));
    edges.forEach((e, k) => join(e.a, e.b, edgeEls[k]));
    g = { sim, nodes, byId, members, shares, edges, near, touching, omitted, omittedBy, want, memberEls, shareEls, edgeEls, nodeEls,
      shareHits: [...hitEls].slice(0, shares.length), edgeHits: [...hitEls].slice(shares.length),
      elIndex: new Map([...nodeEls].map((el, i) => [el, i])), chats: [], chatEls: [], threadEls: [],
      memberPts: members.map(m => [nodes[byId.get(m.a)], nodes[byId.get(m.b)]]), sharePts: shares.map(s => [nodes[byId.get(s.a)], nodes[byId.get(s.b)]]) };
    hovered = null; svg.classList.remove('hovering'); svg.classList.toggle('few', projects.length <= 8);

    const live = data.links.filter(l => l.state !== 'dismissed'), sugg = live.filter(l => l.state === 'suggested').length;
    say(`${plural(projects.length, 'project')} · ${live.length - sugg} linked · ${sugg} suggested · ${plural(shares.length, 'pair', 'pairs')} sharing material`
      + (omitted ? ` · ${omitted} of ${filed.length} readings and writing not drawn, to keep the map light; open a project to see all of its own` : ''));
    if (focus && !g.byId.has('p:' + focus)) { focus = null; svg.classList.remove('focused'); $('focus-name').textContent = ''; }
    if (focus) { layoutFocus(); markFocus(); }
    updateEmpty(); applySearch();
    if (selected) show(selected.kind, selected.id, true);
    heat(); draw();
    if (pendingFocus) { const id = pendingFocus; pendingFocus = null; if (g.byId.has('p:' + id)) { show('project', id); enterFocus(id, false); } }
    if (pendingPick) { const p = pendingPick; pendingPick = null; pick(p); }
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
  const overviewPts = () => g.nodes.map(n => ({ x: n.x, y: n.y, r: n.r }));
  function enterFocus(id, push = true) {
    if (!g || !g.byId.has('p:' + id)) return;
    const was = focus;
    if (!was) savedView = autoFit ? null : { ...vb };
    focus = id;
    if (g.omittedBy.get(id)) render(); // its material was cut from the overview; draw all of it now
    else { layoutFocus(); markFocus(); }
    svg.classList.add('focused'); document.body.classList.add('focusing'); $('empty').hidden = true;
    $('focus-name').textContent = projectTitle(id);
    beginTween(frameOf(focusPts()));
    try {
      const url = '#project=' + encodeURIComponent(id);
      if (push && !was) history.pushState({ bfFocus: id }, '', url); // one history entry, so Back or Esc returns to the overview
      else if (push) history.replaceState(history.state?.bfFocus ? { bfFocus: id } : history.state, '', url);
    } catch {}
  }
  function exitFocus() {
    if (!focus || !g) return;
    focus = null; markFocus(); closeSheet();
    svg.classList.remove('focused'); document.body.classList.remove('focusing'); $('focus-name').textContent = ''; updateEmpty();
    const cam = savedView || frameOf(overviewPts()); savedView = null;
    beginTween(cam, () => { for (const n of g.nodes) n.fp = null; clearChats(); if (g.want && g.omitted) render(); else draw(); });
  }
  function goOverview() {
    if (history.state?.bfFocus) { try { history.back(); return; } catch {} }
    exitFocus(); try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  }
  window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.hash.slice(1)).get('project');
    if (id && g?.byId.has('p:' + id)) { if (id !== focus) { show('project', id); enterFocus(id, false); } } else exitFocus();
  });

  // ── motion: one loop for the cooling layout and the focus transition ──
  const ease = u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  function beginTween(cam, done) {
    if (!g) return;
    for (const n of g.nodes) n.from = { x: n.X ?? n.x, y: n.Y ?? n.y };
    for (const c of g.chats) c.from = { x: c.X ?? c.parent.X ?? c.parent.x, y: c.Y ?? c.parent.Y ?? c.parent.y };
    tween = { start: performance.now(), dur: reducedMotion ? 0 : 560, u: 0, cam0: { ...vb }, cam1: cam || { ...vb }, done };
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
    g.memberPts.forEach(([a, b], i) => { const el = g.memberEls[i]; el.setAttribute('x1', f1(a.X)); el.setAttribute('y1', f1(a.Y)); el.setAttribute('x2', f1(b.X)); el.setAttribute('y2', f1(b.Y)); });
    const curve = (a, b, bow) => { const dx = b.X - a.X, dy = b.Y - a.Y, len = Math.hypot(dx, dy) || 1;
      return bow ? `M ${f1(a.X)} ${f1(a.Y)} Q ${f1((a.X + b.X) / 2 - dy / len * bow)} ${f1((a.Y + b.Y) / 2 + dx / len * bow)} ${f1(b.X)} ${f1(b.Y)}` : `M ${f1(a.X)} ${f1(a.Y)} L ${f1(b.X)} ${f1(b.Y)}`; };
    g.sharePts.forEach(([a, b], i) => { const d = curve(a, b, g.shares[i].bow); g.shareEls[i].setAttribute('d', d); g.shareHits[i].setAttribute('d', d); });
    g.edges.forEach((e, i) => { const d = curve(e.u, e.v, e.bow); g.edgeEls[i].setAttribute('d', d); g.edgeHits[i].setAttribute('d', d); });
  }
  function remember() { for (const n of g.nodes) pos.set(n.id, { x: n.x, y: n.y }); }
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
  }
  function fit(k = 1) { if (!g || !g.nodes.length) return; const t = frameOf(overviewPts()); if (!t) return; homeScale = box().w / t.w; vb.x += (t.x - vb.x) * k; vb.y += (t.y - vb.y) * k; vb.w += (t.w - vb.w) * k; applyView(); }
  function fitNow() { if (!g) return; autoFit = !focus; beginTween(frameOf(focus ? focusPts() : overviewPts())); }
  function toWorld(p) { const b = box(); return { x: vb.x + (p.clientX - b.left) / b.w * vb.w, y: vb.y + (p.clientY - b.top) / b.h * vb.h }; }
  function zoomAt(p, w) { w = Math.max(40, Math.min(40000, w)); const f = w / vb.w; vb.x = p.x - (p.x - vb.x) * f; vb.y = p.y - (p.y - vb.y) * f; vb.w = w; applyView(); }
  svg.addEventListener('wheel', e => { e.preventDefault(); autoFit = false; tween = tween && { ...tween, cam0: vb, cam1: vb }; zoomAt(toWorld(e), vb.w * Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.0015)))); }, { passive: false });

  svg.addEventListener('pointerdown', e => {
    if (!g) return; pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    if (pointers.size === 2) { // two fingers: pinch to zoom
      cancelDrag(); pan = null; const [p, q] = [...pointers.values()];
      pinch = { d: Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY) || 1, w: vb.w }; suppressClick = true; return;
    }
    if (e.button !== 0) return; suppressClick = false;
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
      if (!pan.moved) svg.setPointerCapture?.(e.pointerId); pan.moved = true; autoFit = false; svg.classList.add('panning');
      vb.x = pan.vx - dx / b.w * vb.w; vb.y = pan.vy - dy / b.h * vb.h; applyView();
    } else if (!tip.hidden) moveTip(e);
  });
  function cancelDrag() { if (!drag) return; const n = drag.node; if (!focus && !pins.has(n.id)) n.fx = n.fy = null; if (!focus) g.sim.alphaTarget = 0; drag = null; svg.classList.remove('dragging'); }
  function release(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
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
  window.addEventListener('resize', () => { applyView(); if (autoFit && !focus) fit(1); });

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
    if (d.project) { const o = outputsOf(d.project).length, s = sourcesOf(d.project).length, c = data.links.filter(l => (l.a === d.project || l.b === d.project) && l.state !== 'dismissed').length;
      return `${projectTitle(d.project)}\n${plural(s, 'reading')} · ${o} written · ${plural(c, 'connection')}`; }
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
    if (drag || pan || pinch || !g) return;
    const el = e.target.closest?.('.node,[data-link],[data-share]');
    if (el && e.pointerType !== 'touch') { tip.textContent = tipFor(el); tip.hidden = !tip.textContent; moveTip(e); } else hideTip();
    const i = nodeIndex(e.target.closest?.('.nodes .node')); highlight(i < 0 ? null : i);
  });
  svg.addEventListener('pointerleave', () => { hideTip(); if (!drag) highlight(null); });
  svg.addEventListener('focusin', e => { if (!g) return; const i = nodeIndex(e.target.closest?.('.nodes .node')); highlight(i < 0 ? null : i); });
  svg.addEventListener('focusout', () => highlight(null));

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
  function closeSheet() { sheet.classList.remove('open'); document.body.classList.remove('sheet-open'); selected = null; markSelected(); }
  function markSelected() {
    svg.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    if (!selected || !g) return;
    const { kind, id } = selected;
    if (kind === 'link') g.edgeEls.forEach(el => el.dataset.link === id && el.classList.add('selected'));
    else if (kind === 'share') g.shareEls.forEach(el => el.dataset.share === id && el.classList.add('selected'));
    else g.nodeEls.forEach(el => el.dataset[kind] === id && el.classList.add('selected'));
  }
  const close = '<button class="close" type="button" data-close aria-label="Close">×</button>';
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
      html = `${close}<p class="kicker">Project${p.status && p.status !== 'active' ? ' · ' + esc(p.status) : ''}</p><h2>${esc(p.title || id)}</h2>`
        + (p.summary ? `<p class="summary">${esc(clip(p.summary, 320))}</p>` : '')
        + `<h3>Writing <span>${outs.length}</span></h3>` + (outs.length ? `<ul>${outs.map(writingRow).join('')}</ul>` : '<p class="muted">Nothing written yet. A project can stay a collection of reading and talk.</p>')
        + `<h3>Readings <span>${reads.length}</span></h3>` + (reads.length ? `<ul>${reads.map(s => readingRow(s)).join('')}</ul>` : '<p class="muted">Link a reading to this project from Discuss to gather it here.</p>')
        + `<h3>Connections <span>${links.length + shares.length}</span></h3>`
        + (links.length || shares.length ? `<ul>${links.map(l => `<li>${glyph(lineKind(l) + (l.stale ? ' stale' : ''))}<button class="inline" type="button" data-link="${esc(l.id)}">${esc(projectTitle(l.a === id ? l.b : l.a))}</button><small>${esc(relText(l.relation))} · ${esc(originText(l).toLowerCase())}</small></li>`).join('')}`
          + `${shares.map(s => `<li>${glyph('share')}<button class="inline" type="button" data-share="${esc(s.id)}">${esc(projectTitle(s.pa === id ? s.pb : s.pa))}</button><small>${plural(s.items.length, 'shared item')}, not a recorded connection</small></li>`).join('')}</ul>`
          : '<p class="muted">None yet. Say how this relates to other work in Discuss, and it will show here.</p>')
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
    selected = { kind, id }; sheet.innerHTML = html; sheet.classList.add('open'); document.body.classList.add('sheet-open'); markSelected();
    sheet.querySelectorAll('[data-action]').forEach(b => b.onclick = () => act('/project-network/edge', { root, id, action: b.dataset.action }));
    const form = sheet.querySelector('#output-form');
    if (form) form.onsubmit = async e => { e.preventDefault(); const f = new FormData(form); await act('/project-network/output', { root, project: id, file: f.get('file'), title: f.get('title') }); };
    if (!quiet && kind !== 'project') sheet.scrollTop = 0;
  }
  async function act(url, body) { try { await request(url, body); await load(); } catch (e) { say(e.message, true); } }

  // ── choosing things ──
  function pick(d) {
    if (d.project) { show('project', d.project); if (focus !== d.project) enterFocus(d.project); }
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
    if (e.target.closest('[data-unpin]')) { unpin('p:' + selected.id); show('project', selected.id, true); return; }
    const b = e.target.closest('button[data-project],button[data-link],button[data-share],button[data-output],button[data-source]'); if (b) pick(b.dataset);
  });
  $('empty').addEventListener('click', e => { if (e.target.closest('[data-refresh]')) load(true); });
  $('overview').onclick = () => { if (focus) goOverview(); else fitNow(); };
  function escape() {
    if (focus) { if (selected && !(selected.kind === 'project' && selected.id === focus)) show('project', focus); else goOverview(); }
    else if (sheet.classList.contains('open')) closeSheet();
  }
  function toggleScheme() { const next = document.documentElement.dataset.scheme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.scheme = next; store.set('bf-network-scheme', next); }
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName || '');
    if (e.key === 'Escape') { if (e.target.id === 'search') { if (e.target.value) { e.target.value = ''; applySearch(); } e.target.blur(); return; } if (!typing) escape(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase(), toggle = { s: 'suggestions', d: 'dismissed', a: 'archived' }[k];
    if (k === '/') { e.preventDefault(); $('search').focus(); }
    else if (k === 'f') fitNow();
    else if (toggle) { $(toggle).checked = !$(toggle).checked; render(); }
    else if (k === 't') toggleScheme();
    else if (k === 'u') { for (const id of [...pins.keys()]) unpin(id); }
  });
  $('search').addEventListener('input', applySearch);
  $('search').addEventListener('keydown', e => { if (e.key === 'Enter' && g?.firstMatch) { const n = g.firstMatch; pick({ [n.kind]: n.key }); } });
  for (const id of ['suggestions', 'archived', 'dismissed']) $(id).onchange = render;
  $('fit').onclick = fitNow; $('scheme').onclick = toggleScheme; $('refresh').onclick = () => load(true);
  $('root').onchange = () => { root = $('root').value; selected = null; focus = null; pos.clear(); pins.clear(); g = null; autoFit = true; closeSheet(); svg.classList.remove('focused'); $('focus-name').textContent = ''; load(); };
  applyView();
  load();
}
