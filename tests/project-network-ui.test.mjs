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

test('on the campus, paused and archived projects are shuttered and their windows stay dark', async () => {
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
  assert.equal(bld('a').querySelectorAll('.win.lit').length, 1);
  for (const id of ['b', 'c']) { assert.ok(bld(id).classList.contains('shut'), id); assert.equal(bld(id).querySelectorAll('.win.lit').length, 0, id); }
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
  const second = await open({ 'bf-city:/t': JSON.stringify({ placed: { c: spot.split(',').map(Number) }, auto: {} }) });
  assert.equal(tile(second, 'c'), undefined);
  assert.notEqual(tile(second, 'a'), spot);
  const box = second.document.getElementById('archived'); box.checked = true; box.dispatchEvent(new second.Event('change'));
  assert.equal(tile(second, 'c'), spot);
  second.close();
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
