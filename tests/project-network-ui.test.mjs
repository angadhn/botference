import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Window } = require('happy-dom');
const html = fs.readFileSync(new URL('../frontends/shared/network-ui/network.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../frontends/shared/network-ui/network.js', import.meta.url), 'utf8').replace(/^export /gm, '');

test('project map exposes evidence, safe links, dismissal and multiple outputs', async () => {
  const window = new Window({ url: 'http://localhost/project-network/view' });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const data = { ok: true, root: '/test', roots: ['/test'], surface: 'discuss',
    projects: [{ id: 'a', title: 'Education', status: 'active' }, { id: 'b', title: 'Institutions', status: 'active' }],
    outputs: [{ id: 'o1', title: 'Essay one', path: '/site/one.md', projects: ['a'], url: 'http://localhost:4000/one' },
      { id: 'o2', title: 'Paper two', path: '/site/two.tex', projects: ['a'], url: 'javascript:alert(1)' }],
    sources: [{ id: 's1', title: 'A PDF reading', kind: 'pdf', page_key: 'key', url: 'bfp-pdf://text/test', projects: ['a'], chats: ['chat'] }],
    links: [{ id: 'l1', a: 'a', b: 'b', relation: 'challenges', state: 'suggested', origin: 'agent', reason: '<img src=x onerror=alert(1)> A different assumption.' }],
    uses: [],
  };
  const calls=[];
  window.fetch = async (url, opts={}) => {
    if(opts.method==='POST'){const body=JSON.parse(opts.body);calls.push([url,body]);data.links[0].state=body.action==='dismiss'?'dismissed':'suggested';return {ok:true,json:async()=>({ok:true})};}
    return {ok:true,json:async()=>structuredClone(data)};
  };
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g,''));
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  assert.equal(window.document.querySelectorAll('.edge.suggested').length,1);
  window.document.querySelector('[data-project="a"]').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  assert.ok(window.document.querySelector('.node[data-project="a"]').classList.contains('selected'));
  const detail=window.document.getElementById('detail');
  assert.match(detail.textContent,/Essay one/);assert.match(detail.textContent,/Paper two/);
  assert.equal(detail.querySelectorAll('a[href^="javascript:"]').length,0);
  assert.ok(detail.querySelector('a[href="http://localhost/p/key"]'));
  window.document.querySelector('.edge').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
  assert.match(detail.textContent,/different assumption/);
  assert.equal(detail.querySelectorAll('img').length,0);
  detail.querySelector('[data-action="dismiss"]').click();
  await window.happyDOM.whenAsyncComplete();
  assert.equal(calls[0][1].action,'dismiss');
  assert.equal(window.document.querySelectorAll('.edge').length,0);
  window.close();
});

test('outputs and readings join their projects with member lines, never relationship edges', async () => {
  const window = new Window({ url: 'http://localhost/project-network/view' });
  const data = { ok: true, root: '/test', roots: ['/test'], surface: 'discuss', uses: [],
    projects: [{ id: 'a', title: 'Education', status: 'active' }, { id: 'b', title: 'Institutions', status: 'active' }],
    outputs: [{ id: 'o1', title: 'Shared essay', path: '/x.md', projects: ['a', 'b'] }],
    sources: [{ id: 's1', title: 'A reading', kind: 'web', page_key: 'k', projects: ['a'] }],
    links: [{ id: 'l1', a: 'a', b: 'b', relation: 'extends', state: 'linked', origin: 'user', reason: 'r' }] };
  window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  const doc = window.document;
  assert.equal(doc.querySelectorAll('.node[data-output="o1"]').length, 1);
  assert.equal(doc.querySelectorAll('.member').length, 3);
  assert.equal(doc.querySelectorAll('.member.edge').length, 0);
  assert.equal(doc.querySelectorAll('.edge').length, 1);
  window.close();
});

test('layout() places the same input in the same positions', async () => {
  const src = fs.readFileSync(new URL('../frontends/shared/network-ui/network.js', import.meta.url), 'utf8');
  const { layout } = await import('data:text/javascript,' + encodeURIComponent(src));
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i }));
  const links = nodes.slice(1).map((n, i) => ({ a: n.id, b: 'p' + (i % 5), state: i % 3 ? 'linked' : 'suggested' }));
  const place = () => layout(nodes, links).map(p => [p.id, p.x, p.y]);
  const first = place();
  assert.ok(first.every(([, x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.deepEqual(place(), first);
});

async function openMap(data) {
  const window = new Window({ url: 'http://localhost/project-network/view' });
  window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  return window;
}
const twoProjects = [{ id: 'a', title: 'Education', status: 'active' }, { id: 'b', title: 'Institutions', status: 'active' }, { id: 'c', title: 'Health', status: 'active' }];

test('a reading excerpt carries its current version, apart from the version the suggestion saw', async () => {
  const window = await openMap({ ok: true, root: '/t', roots: ['/t'], surface: 'council', projects: twoProjects, outputs: [], uses: [],
    sources: [{ id: 's1', title: 'Ostrom', kind: 'pdf', page_key: 'k', projects: ['a'], excerpt: 'Notes as they read today.', revision: 'cccc1111dddd' }],
    links: [{ id: 'l1', a: 'a', b: 'b', relation: 'supports', state: 'suggested', origin: 'agent', reason: 'r', source: 's1', source_revision: 'aaaa2222bbbb' }] });
  window.document.querySelector('.edge').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const ev = window.document.querySelector('#detail .ev').textContent;
  assert.match(ev, /now, version cccc1111/);
  assert.match(ev, /When suggested: version aaaa2222/);
  assert.match(ev, /changed since/);
  window.close();
});

test('shared-material lines take the keyboard, and focus view drops faded items from the tab order', async () => {
  const window = await openMap({ ok: true, root: '/t', roots: ['/t'], surface: 'council', projects: twoProjects, uses: [], links: [],
    outputs: [{ id: 'o1', title: 'Shared essay', path: '/x.md', projects: ['a', 'b'] }], sources: [] });
  const doc = window.document, share = doc.querySelector('.share');
  assert.equal(share.getAttribute('tabindex'), '0');
  share.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.match(doc.getElementById('detail').textContent, /Shared material/);
  doc.querySelector('.node[data-project="c"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.querySelector('.node[data-project="a"]').getAttribute('tabindex'), '-1');
  assert.equal(share.getAttribute('tabindex'), '-1');
  assert.equal(doc.querySelector('.node[data-project="c"]').getAttribute('tabindex'), '0');
  window.close();
});

test('short titles keep at most seven words, drop chat openers and never end on a dangling word', async () => {
  const { shortTitle } = await import(new URL('../frontends/shared/network-ui/titles.js', import.meta.url));
  const words = s => s.replace(/…$/, '').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  assert.equal(shortTitle('Hi there, I want you to help me teach myself a paper from first principles'), 'Teach myself a paper from first principles');
  assert.equal(shortTitle("I'm thinking about switching careers out of academia and want a sounding board"), 'Switching careers out of academia…');
  assert.equal(shortTitle('Collision Risk In Crowded Orbits For Reviewers'), 'Collision risk in crowded orbits for reviewers');
  assert.equal(shortTitle('AI 2040 plan'), 'AI 2040 plan');
  for (const t of ['Can you help me put together a health and fitness vision for the next year?', 'Working notes for a very long project about the history of steam engines in Britain'])
    assert.ok(words(shortTitle(t)).length <= 7, shortTitle(t));
});

test('arrowheads mark only relations with a recorded direction', async () => {
  const window = await openMap({ ok: true, root: '/t', roots: ['/t'], surface: 'council', projects: twoProjects, uses: [], sources: [],
    outputs: [{ id: 'o1', title: 'Shared essay', path: '/x.md', projects: ['b', 'c'] }],
    links: [{ id: 'l1', a: 'a', b: 'b', relation: 'depends_on', state: 'linked', origin: 'user', reason: 'r' },
      { id: 'l2', a: 'a', b: 'c', relation: 'related', state: 'suggested', origin: 'agent', reason: 'r' },
      { id: 'l3', a: 'b', b: 'c', relation: 'shared_source', state: 'used', origin: 'agent', reason: 'r' }] });
  const doc = window.document;
  assert.equal(doc.querySelectorAll('.edge').length, 3);
  assert.equal(doc.querySelectorAll('.share').length, 1);
  assert.deepEqual([...doc.querySelectorAll('.arrow')].map(el => el.dataset.arrow), ['l1']);
  window.close();
});

test('in the city, paused and archived buildings say so in words, and the recent-reading count is in the hover label, not over the building', async () => {
  const window = new Window({ url: 'http://localhost/project-network/view' });
  window.localStorage.setItem('bf-network-view', 'campus');
  const recent = new Date(Date.now() - 2 * 864e5).toISOString();
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], links: [], outputs: [], capacity: { limit: 10 },
    projects: [{ id: 'a', title: 'Education essays', status: 'active' }, { id: 'b', title: 'Short stories', status: 'paused' }, { id: 'c', title: 'Old archive', status: 'archived' }],
    sources: ['a', 'b', 'c'].map(p => ({ id: 's' + p, title: 'Reading ' + p, kind: 'web', page_key: 'k' + p, projects: [p], chats: [p + '1', p + '2'], page_updated_at: recent })) };
  window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  const doc = window.document, bld = id => doc.querySelector(`.bld[data-project="${id}"]`);
  doc.getElementById('archived').checked = true; doc.getElementById('archived').dispatchEvent(new window.Event('change'));
  assert.equal(bld('a').classList.contains('shut'), false);
  assert.equal(bld('a').querySelector('.sign'), null);
  assert.match(bld('a').getAttribute('aria-label'), /1 reading updated in 30 days/);
  for (const [id, word] of [['b', 'paused'], ['c', 'archived']]) { assert.ok(bld(id).classList.contains('shut'), id); assert.equal(bld(id).querySelector('.sign.shut').textContent, word); }
  window.close();
});

test('in the city, a building you drag keeps its place after a reload', async () => {
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], links: [], outputs: [], sources: [], projects: twoProjects };
  const open = async saved => {
    const window = new Window({ url: 'http://localhost/project-network/view' });
    for (const [k, v] of Object.entries(saved)) window.localStorage.setItem(k, v);
    window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
    window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
    window.eval(js);
    await window.happyDOM.whenAsyncComplete();
    return window;
  };
  const first = await open({ 'bf-network-view': 'city' }), doc = first.document, map = doc.getElementById('map');
  const tile = d => d.querySelector('.bld[data-project="a"]').dataset.tile, before = tile(doc);
  const at = (type, x, y, el = map) => el.dispatchEvent(new first.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' }));
  at('pointerdown', 300, 300, doc.querySelector('.bld[data-project="a"]'));
  at('pointermove', 360, 330); at('pointermove', 460, 380); at('pointerup', 460, 380);
  const after = tile(doc);
  assert.notEqual(after, before);
  const saved = Object.fromEntries(Array.from({ length: first.localStorage.length }, (_, i) => first.localStorage.key(i)).map(k => [k, first.localStorage.getItem(k)]));
  first.close();
  const second = await open(saved);
  assert.equal(tile(second.document), after);
  second.close();
});

test('in the city, the week line counts a reading shared by two projects once and names its page as the source', async () => {
  const window = new Window({ url: 'http://localhost/project-network/view' });
  window.localStorage.setItem('bf-network-view', 'city');
  const recent = new Date(Date.now() - 2 * 864e5).toISOString();
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], links: [], outputs: [], projects: twoProjects,
    sources: [{ id: 's1', title: 'Ostrom', kind: 'web', page_key: 'k', projects: ['a', 'b'], page_updated_at: recent }] };
  window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  const week = window.document.getElementById('week').textContent;
  assert.match(week, /2 projects had updates: 1 reading page saved\./);
  assert.doesNotMatch(week, /discuss/);
  window.close();
});

test('in the city, a hidden archived project keeps its saved tile and gets it back when shown', async () => {
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], links: [], outputs: [], sources: [],
    projects: [{ id: 'a', title: 'Education', status: 'active' }, { id: 'c', title: 'Old archive', status: 'archived' }] };
  const open = async saved => {
    const window = new Window({ url: 'http://localhost/project-network/view' });
    for (const [k, v] of Object.entries({ 'bf-network-view': 'city', ...saved })) window.localStorage.setItem(k, v);
    window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
    window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
    window.eval(js);
    await window.happyDOM.whenAsyncComplete();
    return window;
  };
  const tile = (w, id) => w.document.querySelector(`.bld[data-project="${id}"]`)?.dataset.tile;
  const first = await open({}), spot = tile(first, 'a'); first.close();
  const second = await open({ 'bf-city:/t': JSON.stringify({ v: 2, placed: { c: spot.split(',').map(Number) }, auto: {} }) });
  assert.equal(tile(second, 'c'), undefined);
  assert.notEqual(tile(second, 'a'), spot);
  const box = second.document.getElementById('archived'); box.checked = true; box.dispatchEvent(new second.Event('change'));
  assert.equal(tile(second, 'c'), spot);
  second.close();
});

test('in the city, buildings placed by hand in the old one-tile city keep their place and arrangement, and the old save is kept', async () => {
  // side by side in the old small tiles; read as new tiles their lots overlapped and one placement was dropped
  const old = JSON.stringify({ placed: { a: [3, 3], b: [4, 3] }, auto: { c: [6, 6] } });
  const window = new Window({ url: 'http://localhost/project-network/view' });
  for (const [k, v] of Object.entries({ 'bf-network-view': 'city', 'bf-city:/t': old })) window.localStorage.setItem(k, v);
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], links: [], outputs: [], sources: [], projects: twoProjects };
  window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  const bld = id => window.document.querySelector(`.bld[data-project="${id}"]`), tile = id => bld(id).dataset.tile.split(',').map(Number);
  assert.ok(bld('a').classList.contains('placed') && bld('b').classList.contains('placed'));
  assert.ok(tile('b')[0] > tile('a')[0]);
  assert.equal(window.localStorage.getItem('bf-city:/t:before-v2'), old);
  window.close();
});

test('the URL hash carries the overview, the open project and both cameras, so a reload opens the same place', async () => {
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], links: [], outputs: [], sources: [], projects: twoProjects };
  const open = async url => {
    const window = new Window({ url });
    window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
    window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
    window.eval(js);
    await window.happyDOM.whenAsyncComplete();
    return window;
  };
  const panBy = async (w, dx, dy) => {
    const map = w.document.getElementById('map'), at = (type, x, y) => map.dispatchEvent(new w.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' }));
    at('pointerdown', 700, 500); at('pointermove', 700 + dx / 2, 500 + dy / 2); at('pointermove', 700 + dx, 500 + dy); at('pointerup', 700 + dx, 500 + dy);
    map.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); // the click that ends a pan, as a browser sends it
    await w.happyDOM.whenAsyncComplete();
  };
  const camIn = (w, key) => new URLSearchParams(w.location.hash.slice(1)).get(key);
  const shown = w => w.document.getElementById('map').getAttribute('viewBox').split(' ').slice(0, 3).map(v => Math.round(+v)).join(',');
  const first = await open('http://localhost/project-network/view');
  first.document.querySelector('#view-menu [data-view="city"]').click();
  await panBy(first, -120, 60);
  const cityCam = camIn(first, 'cam');
  assert.ok(cityCam);
  first.document.querySelector('.bld[data-project="b"]').dispatchEvent(new first.MouseEvent('click', { bubbles: true }));
  await first.happyDOM.whenAsyncComplete();
  await panBy(first, 90, -40);
  const projectCam = camIn(first, 'cam');
  assert.notEqual(projectCam, cityCam);
  assert.equal(camIn(first, 'back'), cityCam);
  const url = first.location.href; first.close();
  const second = await open(url), doc = second.document;
  assert.ok(doc.querySelector('.node[data-project="b"]').classList.contains('selected'));
  assert.equal(shown(second), projectCam);
  assert.equal(doc.getElementById('back').textContent, '← Back to city');
  doc.getElementById('back').click();
  await second.happyDOM.whenAsyncComplete();
  assert.ok(doc.querySelector('.bld[data-project="b"]'));
  assert.doesNotMatch(second.location.hash, /project=/);
  assert.equal(shown(second), cityCam);
  second.close();
});

test('in the city, the ground under a building depends only on its kind and project id', async () => {
  const src = fs.readFileSync(new URL('../frontends/shared/network-ui/network.js', import.meta.url), 'utf8');
  const a = await import('data:text/javascript,' + encodeURIComponent(src)), b = await import('data:text/javascript,' + encodeURIComponent(src + '\n// again'));
  const ids = ['acta-collision', 'health', 'x', 'teach-myself', 'a very long project id 42'];
  const kinds = { observatory: 'hill', 'lecture-hall': 'hill', 'launch-gantry': 'island', library: 'plain', hospital: 'plain', workshop: 'plain', 'cottage-stone': 'plain' };
  for (const [kind, type] of Object.entries(kinds)) for (const id of ids) {
    const t = a.terrainOf(kind, id);
    assert.equal(t.type, type, `${kind} ${id}`);
    assert.deepEqual(a.terrainOf(kind, id), t); // the same answer every time
    assert.deepEqual(b.terrainOf(kind, id), t); // and from a fresh copy of the page: no hidden state
  }
});

test('in the city, a linked path over a long stretch of water is bridged bank to bank, in straight spans round a bend', async () => {
  // seven tiles of water along u, a turn, three more along v: once skipped for being over four tiles long
  const { bridgeSpans } = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(new URL('../frontends/shared/network-ui/network.js', import.meta.url), 'utf8')));
  const tiles = [[2, 5], ...Array.from({ length: 7 }, (_, k) => [3 + k, 5]), [9, 6], [9, 7], [9, 8], [9, 9]]; // a bank, water 1..10, a bank
  const spans = bridgeSpans(tiles, 1, 10), [U, V] = ['u', 'v'].map(axis => spans.filter(sp => sp.axis === axis));
  const bridged = (line, along, across) => [0.01, 0.5, 0.99].every(d => line.some(sp => sp.c === across + 0.5 && sp.a <= along + d && along + d <= sp.b));
  for (const [u, v] of tiles.slice(1, 11)) assert.ok(bridged(U, u, v) || bridged(V, v, u), `water tile ${u},${v} has no bridge over it`);
  assert.ok(spans.every(sp => sp.b - sp.a <= 3.5 && Math.abs(sp.s * 3 - (sp.b - sp.a)) < 1e-9));
  assert.ok(spans.some(sp => sp.axis === 'u' && sp.a === 2.5), 'reaches half a tile up the first bank');
  assert.ok(spans.some(sp => sp.axis === 'v' && sp.b === 9.5), 'reaches half a tile up the far bank');
});

test('the sprite atlas inlined in network.js lists every sprite in the art manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../frontends/shared/network-ui/art/manifest.json', import.meta.url), 'utf8'));
  const atlas = JSON.parse(js.match(/^const ART_ATLAS = (.*);$/m)[1]);
  assert.deepEqual(Object.keys(atlas.sprites).sort(), manifest.sprites.map(s => s.id).sort());
});

test('in the city, no road passes through a building footprint, even where the straight way runs through one', async () => {
  // three buildings placed by hand in a row along u, the outer two linked, so the road must go round the middle one
  const window = new Window({ url: 'http://localhost/project-network/view' });
  const places = { v: 2, placed: { a: [8, 20], b: [17, 20], c: [29, 20] }, auto: {} };
  for (const [k, v] of Object.entries({ 'bf-network-view': 'city', 'bf-city:/t': JSON.stringify(places) })) window.localStorage.setItem(k, v);
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], outputs: [], sources: [],
    projects: [{ id: 'a', title: 'Education essays', status: 'active' }, { id: 'b', title: 'Old library history', status: 'active' },
      { id: 'c', title: 'Garden plants', status: 'active' }, { id: 'd', title: 'Engineering prototype', status: 'active' }],
    links: [{ id: 'l1', a: 'a', b: 'c', relation: 'related', state: 'linked', origin: 'user', reason: 'r' },
      { id: 'l2', a: 'b', b: 'd', relation: 'related', state: 'suggested', origin: 'agent', reason: 'r' },
      { id: 'l3', a: 'd', b: 'a', relation: 'supports', state: 'used', origin: 'agent', reason: 'r' }] };
  window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  const doc = window.document, sprites = JSON.parse(js.match(/^const ART_ATLAS = (.*);$/m)[1]).sprites;
  const feet = [...doc.querySelectorAll('.bld[data-project]')].map(el => {
    const kind = [...el.classList].find(c => sprites[c + '-a']), [i, j] = el.dataset.tile.split(',').map(Number), [w, h] = sprites[kind + '-a'].fp;
    return { id: el.dataset.project, i, j, w, h };
  });
  assert.equal(feet.length, 4);
  const roads = [...doc.querySelectorAll('.fp[data-link]')];
  assert.deepEqual(roads.map(el => el.dataset.link).sort(), ['l1', 'l2', 'l3']);
  for (const el of roads) for (const p of el.getAttribute('points').trim().split(/\s+/)) {
    const [x, y] = p.split(',').map(Number), u = Math.round((x / 32 + y / 16) / 2 - 0.5), v = Math.round((y / 16 - x / 32) / 2 - 0.5); // a tile's centre, back to its tile
    const under = feet.find(f => u >= f.i && u < f.i + f.w && v >= f.j && v < f.j + f.h);
    assert.ok(!under, `road ${el.dataset.link} passes through ${under?.id} at tile ${u},${v}`);
  }
  window.close();
});

test('in the city, dropping a building past the edge of the land makes a patch of its kind of ground at the drop tile', async () => {
  const window = new Window({ url: 'http://localhost/project-network/view' });
  window.localStorage.setItem('bf-network-view', 'city');
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], links: [], outputs: [], sources: [],
    projects: [{ id: 'obs', title: 'Orbit collision paper', status: 'active' }, { id: 'home', title: 'Garden plants', status: 'active' }] };
  window.fetch = async () => ({ ok: true, json: async () => structuredClone(data) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  const doc = window.document, map = doc.getElementById('map'), bld = id => doc.querySelector(`.bld[data-project="${id}"]`);
  // world to screen through the view box, on happy-dom's 900 by 600 map; grab a building by its front corner and drop that corner on a tile's
  const screen = (x, y) => { const [vx, vy, vw, vh] = map.getAttribute('viewBox').split(' ').map(Number); return [(x - vx) / vw * 900, (y - vy) / vh * 600]; };
  const at = (type, [x, y], el = map) => el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' }));
  const drop = (id, t) => { const el = bld(id), [ax, ay] = el.getAttribute('transform').match(/-?[\d.]+/g).map(Number), fp = { obs: 6, home: 6 }[id];
    at('pointerdown', screen(ax, ay), el.querySelector('.hit'));
    const to = screen((t[0] + fp - t[1] - fp) * 32, (t[0] + fp + t[1] + fp) * 16);
    at('pointermove', [to[0] - 30, to[1]]); at('pointermove', to); at('pointerup', to); };
  const saved = () => JSON.parse(window.localStorage.getItem('bf-city:/t'));
  drop('obs', [64, 20]); // the land is 52 tiles a side
  assert.equal(bld('obs').dataset.tile, '64,20');
  let p = saved().patches.at(-1);
  assert.equal(p.type, 'terrace'); assert.equal(p.by, 'obs');
  assert.ok(p.r[0] <= 64 && p.r[1] <= 20 && p.r[2] >= 70 && p.r[3] >= 26, 'the clearing holds the building');
  drop('home', [20, -16]);
  assert.equal(bld('home').dataset.tile, '20,-16');
  p = saved().patches.at(-1);
  assert.equal(p.type, 'meadow'); assert.equal(saved().patches.length, 2);
  window.close();
});

// the council's presence feed, faked: GET /presence answers the first snapshot, and the page's one
// WebSocket takes the rest. Waits by polling, since the feed keeps timers pending.
async function openCity(data, first) {
  const window = new Window({ url: 'http://localhost/project-network/view' });
  window.localStorage.setItem('bf-network-view', 'city');
  const sockets = [];
  window.WebSocket = class { constructor(url) { this.url = url; sockets.push(this); } close() {} };
  window.fetch = async url => ({ ok: true, json: async () => structuredClone(String(url).startsWith('/presence') ? first : data) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  window.eval(js);
  for (let i = 0; i < 200 && !sockets.length; i++) await new Promise(r => setTimeout(r, 10));
  const push = s => sockets.at(-1).onmessage({ data: JSON.stringify(s) });
  return { window, sockets, push };
}
const snap = (revision, runs, recent = []) => ({ type: 'presence', version: 1, server_id: 's1', root: '/t', heartbeat_ms: 15000, revision, generated_at: new Date().toISOString(), runs, recent });
const run = (id, chat, project, family = 'claude') => ({ run_id: id, kind: 'turn', agent_family: family, chat_id: chat, project_id: project,
  project_association: project ? 'session' : 'unknown', state: 'running', started_at: new Date().toISOString(), ended_at: null });

test('in the city, each presence snapshot replaces the avatars, so a run that vanished is gone', async () => {
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], links: [], outputs: [], sources: [], projects: twoProjects };
  const { window, sockets, push } = await openCity(data, snap(1, [run('r1', 'c1', 'a'), run('r2', 'c2', 'b', 'codex'), run('r3', 'c3', null)]));
  const doc = window.document, runs = () => [...doc.querySelectorAll('#map .agent')].map(el => el.dataset.run).sort();
  assert.equal(sockets[0].url, 'ws://localhost/ws?scope=presence');
  assert.deepEqual(runs(), ['r1', 'r2', 'r3']);
  assert.equal(doc.querySelector('.agents .ag-label').textContent, 'unfiled chat');
  assert.equal(doc.querySelector('.agent[data-run="r1"]').getAttribute('href'), '/#/chat/c1');
  push(snap(2, [run('r2', 'c2', 'b', 'codex')]));
  assert.deepEqual(runs(), ['r2']);
  assert.equal(doc.querySelector('.agents .ag-label'), null);
  await window.happyDOM.abort(); window.close();
});

test('in the city, a chat whose next run is filed under another project walks its avatar from the old building to the new, labelled as a refiling and in its outfit', async () => {
  const data = { ok: true, root: '/t', roots: ['/t'], surface: 'council', uses: [], outputs: [], sources: [], projects: twoProjects,
    links: [{ id: 'l1', a: 'a', b: 'b', relation: 'related', state: 'linked', origin: 'user' }] };
  const { window, push } = await openCity(data, snap(1, [run('r1', 'c1', 'a')]));
  const doc = window.document, at = el => el.getAttribute('transform').match(/-?[\d.]+/g).map(Number);
  const front = id => at(doc.querySelector(`.bld[data-project="${id}"]`)), dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  push(snap(2, [{ ...run('r2', 'c1', 'b', 'codex'), kind: 'build' }], [{ ...run('r1', 'c1', 'a'), state: 'completed', ended_at: new Date().toISOString() }]));
  const walker = doc.querySelector('.agent[data-run="r2"]');
  assert.ok(walker.classList.contains('walking'));
  assert.equal(walker.dataset.from, 'a'); assert.equal(walker.dataset.to, 'b');
  assert.ok(dist(at(walker), front('a')) < dist(at(walker), front('b')), 'it sets out from the old building');
  assert.match(walker.getAttribute('aria-label'), /Chat refiled from “Education” to “Institutions”.*not the agent choosing to move/);
  assert.match(walker.querySelector('.ag-role').getAttribute('href'), /^#s-agent-role-builder-/, 'a walking build agent keeps its helmet');
  await window.happyDOM.abort(); window.close();
});

async function openMobileCity() {
  const window = new Window({ url: 'http://localhost/project-network/view', width: 390, height: 844 });
  window.localStorage.setItem('bf-network-view', 'city');
  window.localStorage.setItem('bf-network-intro', 'seen');
  window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, root: '/mobile', roots: ['/mobile'], surface: 'discuss', projects: twoProjects, links: [], sources: [], outputs: [], uses: [] }) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  const doc = window.document;
  const rect = (top, width, height) => ({ left: 0, right: width, top, bottom: top + height, width, height });
  doc.getElementById('map').getBoundingClientRect = () => rect(0, 390, 844);
  doc.querySelector('.top').getBoundingClientRect = () => rect(0, 390, 64);
  doc.querySelector('.tools').getBoundingClientRect = () => rect(784, 390, 60);
  doc.getElementById('campus-list').getBoundingClientRect = () => doc.body.classList.contains('activity-open') ? rect(200, 390, 584) : rect(732, 390, 52);
  window.eval(js);
  await window.happyDOM.whenAsyncComplete();
  return window;
}

test('mobile activity can expand and close with Escape while keeping the city fitted above it', async () => {
  const window = await openMobileCity(), doc = window.document;
  try {
    const toggle = doc.getElementById('activity-toggle'), map = doc.getElementById('map');
    const width = () => Number(map.getAttribute('viewBox').split(' ')[2]);
    const closedWidth = width();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(width() > closedWidth, 'the city zooms out to fit above the expanded activity panel');
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(doc.activeElement, toggle);
    assert.ok(Math.abs(width() - closedWidth) < 0.2);
  } finally { window.close(); }
});

test('mobile zoom buttons zoom around the visible city and leave building positions unchanged', async () => {
  const window = await openMobileCity(), doc = window.document;
  try {
    const map = doc.getElementById('map'), view = () => map.getAttribute('viewBox').split(' ').map(Number);
    const positions = () => [...doc.querySelectorAll('.bld')].map(el => el.getAttribute('transform'));
    const before = view(), buildings = positions();
    doc.getElementById('zoom-in').click();
    const after = view();
    assert.ok(after[2] < before[2]);
    // The available city is between the header at 64 and drawer at 732, with 10px margins.
    const centre = v => [v[0] + v[2] / 2, v[1] + 398 / 390 * v[2]];
    centre(before).forEach((n, i) => assert.ok(Math.abs(n - centre(after)[i]) < 0.3));
    assert.deepEqual(positions(), buildings);
    doc.getElementById('zoom-out').click();
    assert.ok(Math.abs(view()[2] - before[2]) < 0.2);
  } finally { window.close(); }
});

// ── drawing cost on a phone ──
// a 2D context that accepts every call and property, so the ground canvas can be painted in happy-dom
const fakeContext = () => new Proxy({}, { get: (t, k) => k in t ? t[k] : k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}, set: (t, k, v) => { t[k] = v; return true; } });
async function openPaintedCity({ width = 390, height = 844, dpr = 1, rafs = null } = {}) {
  const window = new Window({ url: 'http://localhost/project-network/view', width, height });
  Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  window.HTMLCanvasElement.prototype.getContext = function () { return this._ctx ||= fakeContext(); };
  window.Image = class { constructor() { setTimeout(() => { this.complete = true; this.naturalWidth = 2048; this.onload?.(); }, 0); } };
  if (rafs) { let id = 0; window.requestAnimationFrame = cb => { rafs.set(++id, cb); return id; }; window.cancelAnimationFrame = n => rafs.delete(n); }
  window.localStorage.setItem('bf-network-view', 'city'); window.localStorage.setItem('bf-network-intro', 'seen');
  window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, root: '/paint', roots: ['/paint'], surface: 'discuss', projects: twoProjects, links: [], sources: [], outputs: [], uses: [] }) });
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  const rect = (top, w, h) => ({ left: 0, right: w, top, bottom: top + h, width: w, height: h });
  window.document.getElementById('map').getBoundingClientRect = () => rect(0, width, height);
  window.eval(js);
  await window.happyDOM.whenAsyncComplete(); await new Promise(r => setTimeout(r, 30));
  return window;
}

test('every canvas is drawn at no more than twice the CSS pixels, even on a 3x phone screen', async () => {
  const { pixelRatio, groundRes, DPR_CAP } = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(new URL('../frontends/shared/network-ui/network.js', import.meta.url), 'utf8')));
  assert.equal(DPR_CAP, 2);
  assert.equal(pixelRatio(3), 2); assert.equal(pixelRatio(1), 1); assert.equal(pixelRatio(undefined), 1);
  assert.equal(groundRes({ W: 2000, H: 1000, scale: 1, dpr: 3, follow: true }), groundRes({ W: 2000, H: 1000, scale: 1, dpr: 2, follow: true }));
  // the desktop keeps its one painting, as before: at most 1.5, and under the 14-million-pixel area cap
  assert.equal(groundRes({ W: 2000, H: 1000, dpr: 2 }), 1.5);
  assert.ok(Math.abs(groundRes({ W: 6000, H: 3000, dpr: 2 }) - Math.sqrt(14e6 / 18e6)) < 1e-9);
  const window = await openPaintedCity({ dpr: 3 });
  try {
    const mm = window.document.getElementById('mm-canvas'), ground = window.document.getElementById('ground');
    assert.equal(mm.width, Math.round(parseFloat(mm.style.width) * 2), 'the overhead map is drawn at 2x, not 3x');
    assert.ok(ground.width > 0 && ground.width <= Math.ceil(parseFloat(ground.style.width) * 2));
  } finally { window.close(); }
});

test('on a phone the painted ground is drawn again when a zoom crosses a power of two, and not for a small zoom', async () => {
  const { groundRes } = await import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(new URL('../frontends/shared/network-ui/network.js', import.meta.url), 'utf8')));
  const at = scale => groundRes({ W: 4000, H: 2000, scale, dpr: 2, follow: true });
  assert.equal(at(0.1), at(0.11), 'a small zoom keeps the painting');
  assert.ok(at(0.3) > at(0.1), 'zooming in paints it finer');
  assert.ok(at(0.1) >= 2 * 0.1 * 2, 'never coarser than twice what the screen shows');
  const window = await openPaintedCity();
  try {
    const doc = window.document, ground = doc.getElementById('ground'), full = ground.width, rest = () => new Promise(r => setTimeout(r, 250));
    const zoom = (id, n) => { for (let i = 0; i < n; i++) doc.getElementById(id).click(); };
    assert.ok(full > 0, 'the ground was painted');
    zoom('zoom-out', 4); await rest();
    const far = ground.width;
    assert.ok(far < full, 'seen from far out, the ground is a smaller canvas');
    zoom('zoom-in', 1); await rest();
    assert.equal(ground.width, far, 'a small zoom keeps the painting');
    zoom('zoom-in', 3);
    assert.equal(ground.width, far, 'it waits for the zoom to rest');
    await rest();
    const small = far;
    assert.ok(ground.width > small, 'after a zoom of almost three times, the ground is painted finer');
  } finally { window.close(); }
});

test('the one animation loop asks for no frames while nothing moves, and none while the tab is hidden', async () => {
  const rafs = new Map(), window = await openPaintedCity({ rafs });
  try {
    const doc = window.document, map = doc.getElementById('map');
    assert.equal(rafs.size, 0, 'a city at rest asks for no frames');
    // a finger pans the city: frames while it moves, the town drawn again only when it lifts
    const touch = (type, x) => map.dispatchEvent(new window.PointerEvent(type, { bubbles: true, clientX: x, clientY: 400, pointerId: 1, pointerType: 'touch', button: 0 }));
    const box0 = map.getAttribute('viewBox');
    touch('pointerdown', 200); touch('pointermove', 240); touch('pointermove', 260);
    assert.equal(rafs.size, 1, 'one frame asked for, however many moves');
    for (const cb of [...rafs.values()]) { rafs.clear(); cb(0); }
    assert.equal(map.getAttribute('viewBox'), box0, 'while the finger moves, the drawn town is moved as a picture');
    assert.match(map.style.transform, /translate\(/);
    touch('pointerup', 260);
    assert.notEqual(map.getAttribute('viewBox'), box0, 'when it lifts, the town is drawn at the new place');
    assert.equal(map.style.transform, '');
    assert.equal(rafs.size, 0, 'and the loop stops');
    // a hidden tab: a pending frame is cancelled, and asked for again when the tab is shown
    touch('pointerdown', 200); touch('pointermove', 240);
    assert.equal(rafs.size, 1);
    Object.defineProperty(doc, 'hidden', { value: true, configurable: true }); doc.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(rafs.size, 0, 'hidden: no frame pending');
    touch('pointermove', 250);
    assert.equal(rafs.size, 0, 'hidden: none asked for');
    Object.defineProperty(doc, 'hidden', { value: false, configurable: true }); doc.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(rafs.size, 1, 'shown again: the pending work gets its frame');
    touch('pointerup', 250);
  } finally { window.close(); }
});
