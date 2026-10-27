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
