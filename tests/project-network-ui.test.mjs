import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Window } = require('happy-dom');
const html = fs.readFileSync(new URL('../frontends/shared/network-ui/network.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../frontends/shared/network-ui/network.js', import.meta.url), 'utf8').replace('export function layout', 'function layout');

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
