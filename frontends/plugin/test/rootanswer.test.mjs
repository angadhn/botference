// "Is this folder yours?" — the reader's answer about a council root (a
// project page) or a site's repo (a blog page). It is ONE value with three
// names ('unasked' | 'yes' | 'no'), shipped to the page as `state` and drawn
// from that alone. It used to travel as two booleans, and the project path
// set only one of them: "No, leave this page alone" left the same question up,
// both buttons live, until a reload. happy-dom stands in for the browser; the
// companion is one stubbed callback per answer.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await tick(5); } return true; };

// ---- the named answer and its one setter ----------------------------------
ok('three named answers', JSON.stringify(D.ROOT_ANSWERS) === JSON.stringify(['unasked', 'yes', 'no']));
ok('no state reads as unasked', D.rootAnswer({}) === 'unasked' && D.rootAnswer(null) === 'unasked');
const x = { state: 'unasked' };
ok('the setter refuses a value that is not one of the three', D.setRootAnswer(x, 'maybe') === false && x.state === 'unasked');
ok('…and takes one that is', D.setRootAnswer(x, 'no') === true && x.state === 'no');
ok('nothing un-asks a question', D.setRootAnswer(x, 'unasked') === false && x.state === 'no');
ok('a changed mind is a new answer', D.setRootAnswer(x, 'yes') === true && x.state === 'yes');

// ---- a project page: the reader says no -----------------------------------
const said = [];
const drawer = D.create({
  cssText: '.panel{}',
  onConfirmRoot: async yes => { said.push(['root', yes]); return { ok: true, state: yes ? 'yes' : 'no' }; },
  onConfirmBlogRoot: async yes => { said.push(['blog', yes]); return { ok: true, state: yes ? 'yes' : 'no' }; },
});
drawer.open('chat');
drawer.setConn(true);
drawer.setPage({ url: 'file:///council/projects/p/index.html', title: 'P', threads: [], page_chat: [] });
const ROOT = '/Users/reader/council';
// what the companion sends: `state`, and `confirmed` (the same answer read as
// a yes, for its own checks) — the drawer must not need the second
drawer.setProject({ root: ROOT, project_id: 'p', project_title: 'P', rel: 'projects/p/index.html',
  path: ROOT + '/projects/p/index.html', state: 'unasked', confirmed: false });
await tick(20);
const root = drawer.shadow || (drawer.host && drawer.host.shadowRoot) || w.document.querySelector('div').shadowRoot;
const btn = act => root.querySelector(`[data-act="${act}"]`);
ok('the question is up, with both answers', !!btn('root-yes') && !!btn('root-no'), root && root.innerHTML.slice(0, 1500));
btn('root-no') && btn('root-no').click();
ok('the companion was told no', await until(() => said.some(s => s[0] === 'root' && s[1] === false)));
ok('the question is gone after a no', await until(() => !btn('root-yes') && !btn('root-no')),
  root.innerHTML.slice(0, 1500));
ok('and the page says it is left alone', /leaving this page alone/.test(root.textContent));

// ---- a blog page: the reader says no --------------------------------------
drawer.setProject(null);
drawer.setBlog({ root: '/Users/reader/site', kind: 'jekyll', source_path: '/Users/reader/site/_posts/a.md',
  rel: '_posts/a.md', state: 'unasked', confirmed: false });
await tick(20);
ok('the site question is up', !!btn('blogroot-yes') && !!btn('blogroot-no'));
btn('blogroot-no') && btn('blogroot-no').click();
ok('the companion was told no about the site', await until(() => said.some(s => s[0] === 'blog' && s[1] === false)));
ok('the site question is gone after a no', await until(() => !btn('blogroot-yes') && !btn('blogroot-no')));

console.log(`rootanswer: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
