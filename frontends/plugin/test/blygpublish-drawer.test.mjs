// blygpublish-drawer.test.mjs — the Publish-as-blyg dialog in the drawer, with happy-dom and a scripted companion.
//
//   node frontends/plugin/test/blygpublish-drawer.test.mjs
//
// What is asserted: the paper-plane appears only on a comment the OWNER wrote (not a guest's, not one addressed to an agent,
// not for a non-owner, not on one already published); only a TRUSTED click does anything (a click a page made up is ignored at
// every button); the view moves only along config.js's table; the confirmation shows the note and the plan as TEXT; Cancel and
// Publish send the run's id and token; a reload finds the run and offers a Review, it does not act; a failed or interrupted run
// shows what happened and only the buttons its mode allows.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection', 'ResizeObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const CFG = require(path.join(here, '..', 'extension', 'config.js'));
globalThis.BFPConfig = CFG;
w.BFPConfig = CFG;
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const mine = (text, extra = {}) => ({ author: 'owner', ts: '2026-11-22T10:00:00Z', text, provenance: 'owner-typed', ...extra });
const th = (id, text, extra = {}) => ({ id, quote: 'passage ' + id, msgs: [mine(text)], ...extra });
const PAGE = () => ({ url: 'https://example.com/article', title: 'An article', page_chat: [], threads: [
  th('t1', 'My first thought.'),
  { id: 'tg', quote: 'x', msgs: [{ author: 'guest', ts: 'g', text: 'a guest says' }] },
  th('ta', '@claude explain', {}),
  th('tr', 'Addressed by a pill', { msgs: [mine('Addressed by a pill', { route: '@claude ' })] }),
  th('t2', 'My second thought.'),
  th('tp', 'Already out.', { blyg_published: { at: '2026-11-22T11:00:00Z', title: 'Already out', address: 'https://site.example.test/b/already-out' } }),
  th('tx', 'A third.', { blyg_published: { at: '2026-11-22T11:00:00Z', title: 'x', address: 'javascript:alert(1)' } }),
] });

// a scripted companion: it holds one run and answers the drawer's named operations
function companion(first) {
  const state = { run: first || { mode: 'idle', can: [] }, calls: [] };
  const run = (mode, extra = {}) => ({ id: 'r1', token: 'tok1', mode, title: 'My first thought', note_rel: '_notes/my-first-thought.md', note_text: '---\ntitle: x\n---\nBody <img src=x onerror=alert(1)> {{ x }}\n',
    steps: [], can: { planned: ['confirm', 'cancel'], failed: ['retry', 'abandon'], interrupted: ['abandon'] }[mode] || [], ...extra });
  state.run = first || run('idle');
  state.make = run;
  state.onBlygPublish = async (op, body) => {
    state.calls.push({ op, body });
    if (state.fail && state.fail[op]) return { ok: false, error: state.fail[op] };
    if (op === 'start') { state.run = run('planning', { steps: [], thread_ids: [body.thread_id], ...(state.confirm ? { confirm: state.confirm } : {}) }); return { ok: true, run: state.run }; }
    if (op === 'run' || op === 'resume') return { ok: true, run: state.run, confirm: state.confirm || 'always' };
    if (op === 'confirm') { state.run = run('applying', { steps: [{ step: 'plan', exit: 0, output: 'PLAN' }] }); return { ok: true, run: state.run }; }
    if (op === 'cancel') { state.run = run('cancelled'); return { ok: true, run: state.run }; }
    if (op === 'retry') { state.run = run('publishing', { steps: state.run.steps }); return { ok: true, run: state.run }; }
    if (op === 'abandon') { state.run = run('abandoned'); return { ok: true, run: state.run }; }
    return { ok: false, error: 'no such op' };
  };
  return state;
}
async function make({ trusted = true, owner = true, server = companion() } = {}) {
  const drawer = D.create({ ...(trusted ? { isTrusted: () => true } : {}), cssText: '.panel{}',
    onModels: async () => ({ ok: true, current: {}, options: {} }), onBlygCheck: async () => ({ ok: true, status: 'not-a-blyg' }),
    onBlygPublish: server.onBlygPublish });
  drawer.setConn(true);
  drawer.setAuthor('owner');
  drawer.setOwner(owner);
  drawer.open('comments');
  drawer.setPage(PAGE());
  await tick(20);
  const q = sel => drawer.shadow.querySelector(sel);
  const qa = sel => [...drawer.shadow.querySelectorAll(sel)];
  const dlg = () => q('.pubdlg');
  return { drawer, server, q, qa, dlg, view: () => drawer.pub.view, click: el => el.click() };
}

// ---- the table -------------------------------------------------------------------------------
{
  let legal = 0, illegal = 0;
  for (const from of CFG.PUB_VIEWS) for (const to of CFG.PUB_VIEWS) {
    const listed = CFG.PUB_MOVES[from].includes(to);
    eq(`table ${from} → ${to}`, CFG.canPubMove(from, to), listed);
    if (listed) { eq(`pubMove ${from} → ${to} returns it`, CFG.pubMove(from, to), to); legal++; }
    else { let threw = false; try { CFG.pubMove(from, to); } catch (_) { threw = true; } ok(`pubMove ${from} → ${to} refused`, threw); illegal++; }
  }
  ok('the table has legal and illegal moves', legal >= 20 && illegal >= 40, `${legal}/${illegal}`);
  eq('server modes → views', ['idle', 'drafted', 'preparing', 'planning', 'planned', 'applying', 'applied', 'publishing', 'published', 'failed', 'interrupted', 'cancelled', 'abandoned'].map(CFG.pubViewOf),
    ['closed', 'working', 'working', 'working', 'confirming', 'running', 'running', 'running', 'done', 'problem', 'problem', 'closed', 'closed']);
  eq('planned is a confirmation only when the owner asked to confirm', [CFG.pubViewOf('planned', 'always'), CFG.pubViewOf('planned', 'never'), CFG.pubViewOf('planned')], ['confirming', 'running', 'confirming']);
  eq('an unknown mode is shown as a problem, never as success', CFG.pubViewOf('nonsense'), 'problem');
  eq('the named operations', Object.keys(CFG.BLYG_PUBLISH_OPS), ['start', 'run', 'resume', 'confirm', 'retry', 'cancel', 'abandon']);
  eq('only confirm and retry need an offer', Object.entries(CFG.BLYG_PUBLISH_OPS).filter(([, v]) => v.offer === 'needs').map(([k]) => k), ['confirm', 'retry']);
}

// ---- who sees the paper-plane -----------------------------------------------------------------
{
  const { qa, q } = await make();
  eq('the paper-plane is on the owner\'s own, unaddressed, unpublished comments only', qa('.thr-pub').map(b => b.dataset.target), ['t1', 't2']);
  ok('a published one says so, with a link only for a plain http(s) address', q('.pubdone a') && q('.pubdone a').getAttribute('href') === 'https://site.example.test/b/already-out'
    && qa('.pubdone').length === 2 && qa('.pubdone a').length === 1);
  ok('the link opens safely', q('.pubdone a').getAttribute('rel') === 'noopener noreferrer');
  eq('it has a name for the screen reader', q('.thr-pub').getAttribute('aria-label'), 'publish this comment as a blyg');
  const guest = await make({ owner: false });
  eq('a non-owner sees no paper-plane and no "published" mark', [guest.qa('.thr-pub').length, guest.qa('.pubdone').length], [0, 0]);
  guest.drawer.open('comments'); await tick(5);
  eq('…and the drawer never asks the companion about a run', guest.server.calls, []);
}

// ---- only a trusted click ----------------------------------------------------------------------
{
  const x = await make({ trusted: false });
  x.click(x.q('.thr-pub')); await tick();
  eq('an untrusted click on the paper-plane does nothing', [x.view(), x.dlg().hidden, x.server.calls], ['closed', true, [{ op: 'run' }]]);   // (opening asked what the run is; the click asked nothing)
  const t = await make();
  t.click(t.q('.thr-pub')); await tick();
  eq('a trusted click opens the choice', t.view(), 'choosing');
  // a page cannot reach the closed root, but suppose it made up the click: the choice's own buttons are inert too
  const y = await make({ trusted: false });
  y.drawer.pub = Object.assign(y.drawer.pub, {});
  eq('(and an untrusted drawer\'s choosing buttons do not exist to press: it never got there)', y.qa('.pubdlg [data-act]').length, 0);
}

// ---- the whole flow, trusted ---------------------------------------------------------------------
{
  const { server, q, qa, dlg, drawer, view, click } = await make();
  click(qa('.thr-pub')[1]);                                   // the second comment: there is one above it
  eq('choosing', [view(), dlg().hidden], ['choosing', false]);
  eq('both scopes are offered, the second with its count', qa('.pubdlg [data-act="pub-scope"]').map(b => [b.dataset.scope, b.textContent]), [['one', 'Just this comment'], ['above', 'This and the 1 above']]);
  click(q('[data-act="pub-scope"][data-scope="above"]')); await tick();
  eq('start sends the thread and the scope, nothing else', server.calls.at(-1), { op: 'start', body: { thread_id: 't2', scope: 'above' } });
  eq('planning is shown as working', view(), 'working');
  ok('and says nothing is published', /Nothing is published/.test(dlg().textContent));
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'Would notify: <b>nobody</b>' }] });
  drawer.blygPublishMoved(); await tick(5);
  eq('the run arrived planned: the confirmation', view(), 'confirming');
  eq('the note is shown as text (an <img> in it is words, not a picture)', [qa('.pubdlg pre.pubnote').length, qa('.pubdlg img').length, /<img src=x onerror=alert\(1\)>/.test(q('pre.pubnote').textContent)], [1, 0, true]);
  eq('the plan is shown as text', [q('pre.pubplan').textContent, qa('.pubdlg b').filter(b => b.textContent === 'nobody').length], ['Would notify: <b>nobody</b>', 0]);
  ok('it names the file, relative', /_notes\/my-first-thought\.md/.test(q('.pubwhere').textContent));
  ok('and says what Publish does', /live site and cannot be undone/.test(q('.pubwarn').textContent));
  eq('Publish and Cancel, nothing else that acts', qa('.pubdlg [data-act]').map(b => b.dataset.act), ['pub-confirm', 'pub-cancel']);
  const before = server.calls.length;
  click(q('[data-act="pub-confirm"]')); await tick();
  eq('Publish sends the run\'s id and token', server.calls.at(-1), { op: 'confirm', body: { run: 'r1', token: 'tok1' } });
  eq('and the view is running at once', view(), 'running');
  click(q('.pubdlg [data-act="pub-close"]')); await tick();
  eq('there is nothing left to press twice: no Publish button while running', [qa('[data-act="pub-confirm"]').length, server.calls.filter(c => c.op === 'confirm').length], [0, 1]);
  void before;
}
{
  const { server, q, dlg, drawer, view, click, qa } = await make();
  click(qa('.thr-pub')[0]); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'P' }] }); drawer.blygPublishMoved(); await tick(5);
  click(q('[data-act="pub-confirm"]')); await tick();
  server.run = server.make('published', { steps: [{ step: 'plan', exit: 0, output: 'P' }, { step: 'apply', exit: 0, output: 'A' }, { step: 'publish', exit: 0, output: 'U' }],
    published: { at: 'now', title: 'My first thought', permalink: '/b/my-first-thought', address: 'https://site.example.test/b/my-first-thought' } });
  drawer.blygPublishMoved(); await tick(5);
  eq('published: the done view with the link and every step', [view(), q('.pubdlg a').getAttribute('href'), qa('.pubsteps li').map(li => li.querySelector('b').textContent)], ['done', 'https://site.example.test/b/my-first-thought', ['plan', 'apply', 'publish']]);
  ok('the link is safe', q('.pubdlg a').getAttribute('rel') === 'noopener noreferrer' && q('.pubdlg a').getAttribute('target') === '_blank');
  server.run = server.make('published', { published: { title: 't', permalink: '/b/t', address: 'javascript:alert(1)' } });
  click(q('[data-act="pub-close"]'));
  eq('closed', view(), 'closed');
}

// ---- confirm 'never': one click is the publish; one line on the thread; no dialog ------------------------------------
{
  const server = companion(); server.confirm = 'never';
  const { q, qa, dlg, view, click, drawer } = await make({ server });
  eq('(the drawer learned the setting when it opened)', drawer.pub.confirm, 'never');
  click(qa('.thr-pub')[0]);
  ok('choosing says it publishes now', /publishes it now: there is no further step/.test(dlg().textContent) && /Publish just this comment/.test(dlg().textContent));
  click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  eq('start sent, and the dialog is out of the way', [server.calls.at(-1), dlg().hidden, view()], [{ op: 'start', body: { thread_id: 't1', scope: 'one' } }, true, 'working']);
  eq('the thread carries ONE line of progress', [qa('.publine').length, q('.publine').textContent], [1, 'Publishing as a blyg… checking what would change']);
  server.run = server.make('planned', { confirm: 'never', thread_ids: ['t1'], steps: [{ step: 'plan', exit: 0, output: 'P' }] });
  drawer.blygPublishMoved(); await tick(5);
  eq('planned is NOT a confirmation when nobody has to confirm: no buttons, still running', [view(), dlg().hidden, qa('[data-act="pub-confirm"]').length], ['running', true, 0]);
  server.run = server.make('publishing', { confirm: 'never', thread_ids: ['t1'] });
  drawer.blygPublishMoved(); await tick(5);
  eq('publishing is on the line', q('.publine').textContent, 'Publishing as a blyg… publishing to your site');
  server.run = server.make('published', { confirm: 'never', thread_ids: ['t1'], published: { title: 't', permalink: '/b/t', address: 'https://site.example.test/b/t' } });
  drawer.blygPublishMoved(); await tick(5);
  eq('published: the link on the thread, the view free again', [view(), q('.publine.done a').getAttribute('href'), dlg().hidden], ['closed', 'https://site.example.test/b/t', true]);
  server.run = server.make('failed', { confirm: 'never', thread_ids: ['t1'], failed_step: 'plan', failed_reason: 'plan exited with code 1', steps: [{ step: 'plan', exit: 1, output: 'Refused: this plan would change more than the note' }] });
  drawer.pub.view = 'running'; drawer.pub.run = server.run;
  drawer.blygPublishMoved(); await tick(5);
  eq('a failure brings the dialog back, with the step, the output and the choices', [view(), dlg().hidden, /Refused: this plan would change more than the note/.test(dlg().textContent), qa('.pubdlg [data-act]').map(b => b.dataset.act)], ['problem', false, true, ['pub-retry', 'pub-abandon', 'pub-close']]);
}

// ---- clickjacking: a page's overlay over the drawer --------------------------------------------------------------------
// What happy-dom CAN simulate: a top-layer element (document.querySelector(':modal') / ':popover-open' answering), a fullscreen
// element, and elementsFromPoint returning something above the drawer's host. What it cannot: a real top layer, real hit-testing,
// real pointer-events:none; those are the browser's, so the checks are asked of exactly the DOM calls a browser answers.
{
  const real = { q: document.querySelector.bind(document), efp: document.elementsFromPoint, fs: Object.getOwnPropertyDescriptor(document, 'fullscreenElement') };
  const cases = [
    ['a modal dialog in the top layer', () => { document.querySelector = sel => (sel === ':modal' ? { tagName: 'DIALOG' } : real.q(sel)); }],
    ['a popover in the top layer', () => { document.querySelector = sel => (sel === ':popover-open' ? { tagName: 'DIV' } : real.q(sel)); }],
    ['a fullscreen element', () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => ({ tagName: 'DIV' }) }); }],
    ['something above the drawer at the click\'s point', () => { document.elementsFromPoint = () => [{ tagName: 'DIV', id: 'cover' }]; }],
  ];
  for (const [name, set] of cases) {
    const server = companion();
    const { q, qa, view, click, dlg, drawer } = await make({ server });
    click(qa('.thr-pub')[0]);
    eq(name + ': (set up: choosing)', view(), 'choosing');
    set();
    const ev = new MouseEvent('click', { bubbles: true, composed: true, clientX: 10, clientY: 10 });
    q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev); await tick();
    eq(name + ': nothing is started, and the owner is told what to do', [server.calls.some(c => c.op === 'start'), view(), /Close the page's overlay and try again/.test(dlg().textContent)], [false, 'problem', true]);
    document.querySelector = real.q; document.elementsFromPoint = real.efp; delete document.fullscreenElement;
    void drawer;
  }
  // …and when the point is the drawer's own host, it goes through
  const server = companion();
  const { q, qa, view, click, drawer } = await make({ server });
  click(qa('.thr-pub')[0]);
  document.elementsFromPoint = () => [drawer.host];
  q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 10, clientY: 10 })); await tick();
  eq('with the drawer on top and no top layer, the start goes out', [server.calls.some(c => c.op === 'start'), view()], [true, 'working']);
  document.elementsFromPoint = real.efp;
}

// ---- what prepare did is shown with the plan -----------------------------------------------------------------
{
  const server = companion();
  server.run = server.make('planned', { steps: [{ step: 'prepare', exit: 0, output: 'Imported: <i>a post</i>' }, { step: 'plan', exit: 0, output: 'PLAN' }] });
  const { q, qa, view, click } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  eq('prepare\'s output is shown, as text, before the note and the plan', [view(), q('pre.pubprep').textContent, qa('.pubdlg i').length, q('pre.pubplan').textContent], ['confirming', 'Imported: <i>a post</i>', 0, 'PLAN']);
  const none = companion(); none.run = none.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'P' }] });
  const y = await make({ server: none }); await tick(10); y.click(y.q('[data-act="pub-review"]')); await tick();
  eq('no prepare, no such block', y.qa('pre.pubprep').length, 0);
}

// ---- cancel, and Escape --------------------------------------------------------------------------
{
  const { server, q, drawer, view, click, qa } = await make();
  click(qa('.thr-pub')[0]); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'P' }] }); drawer.blygPublishMoved(); await tick(5);
  click(q('[data-act="pub-cancel"]')); await tick();
  eq('Cancel sends the run\'s id and token and closes', [server.calls.at(-1), view()], [{ op: 'cancel', body: { run: 'r1', token: 'tok1' } }, 'closed']);
}
{
  const { server, q, drawer, view, click, qa } = await make();
  click(qa('.thr-pub')[0]); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'P' }] }); drawer.blygPublishMoved(); await tick(5);
  drawer.escape();
  eq('Escape closes the dialog and sends nothing (the run stays where it is)', [view(), server.calls.filter(c => ['cancel', 'confirm', 'abandon'].includes(c.op)).length], ['closed', 0]);
}

// ---- a refusal ----------------------------------------------------------------------------------------
{
  const server = companion(); server.fail = { start: 'Publish as blyg is not set up: the notes folder is not set <script>x</script>' };
  const { q, view, click, qa, dlg } = await make({ server });
  click(qa('.thr-pub')[0]); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  eq('a refusal is shown as words in a problem view', [view(), dlg().textContent.includes('the notes folder is not set <script>x</script>'), qa('.pubdlg script').length], ['problem', true, 0]);
  eq('with only Close', qa('.pubdlg [data-act]').map(b => b.dataset.act), ['pub-close']);
}

// ---- a reload: the run is found, offered, and not acted on ---------------------------------------------------
{
  const server = companion();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'PLAN-TEXT' }] });
  const { q, qa, dlg, view, click, drawer } = await make({ server });
  await tick(10);
  eq('a reloaded drawer finds a run waiting and offers a review (no note, no Publish)', [view(), qa('.pubdlg [data-act]').map(b => b.dataset.act), dlg().textContent.includes('PLAN-TEXT')], ['waiting', ['pub-review', 'pub-close'], false]);
  eq('it only asked what the run is', server.calls.map(c => c.op), ['run']);
  click(q('[data-act="pub-review"]')); await tick();
  eq('Review resumes (which is what opens the worker\'s one-use offer) and continues from the run\'s own mode', [server.calls.at(-1).op, view(), qa('.pubdlg [data-act]').map(b => b.dataset.act)], ['resume', 'confirming', ['pub-confirm', 'pub-cancel']]);
  void drawer;
}
for (const [mode, buttons] of [['failed', ['pub-retry', 'pub-abandon', 'pub-close']], ['interrupted', ['pub-abandon', 'pub-close']]]) {
  const server = companion();
  server.run = server.make(mode, { failed_step: 'publish', failed_reason: 'publish exited with code 1', interrupted_why: 'the companion stopped while this run was under way',
    steps: [{ step: 'plan', exit: 0, output: 'P' }, { step: 'apply', exit: 0, output: 'A' }, { step: 'publish', exit: 1, output: 'boom\nrun the same --push again, or --abandon' }] });
  const { q, qa, dlg, view, click } = await make({ server });
  await tick(10);
  click(q('[data-act="pub-review"]')); await tick();
  eq(`${mode}: a problem view with what happened and only what the mode allows`, [view(), qa('.pubdlg [data-act]').map(b => b.dataset.act)], ['problem', buttons]);
  ok(`${mode}: the command's own words are on screen`, /run the same --push again, or --abandon/.test(dlg().textContent));
  ok(`${mode}: and nothing is retried by itself`, !server.calls.some(c => ['retry', 'confirm'].includes(c.op)));
  if (mode === 'failed') {
    ok('the step that failed is named on the button', /Try publish again/.test(q('[data-act="pub-retry"]').textContent));
    click(q('[data-act="pub-retry"]')); await tick();
    eq('a retry is the owner\'s click: it resumes (the offer) and then retries, with the run\'s token', server.calls.slice(-2), [{ op: 'resume', body: undefined }, { op: 'retry', body: { run: 'r1', token: 'tok1' } }]);
    eq('and the view follows the run', view(), 'running');
  } else {
    click(q('[data-act="pub-abandon"]')); await tick();
    eq('abandon sends the run\'s id and token', [server.calls.at(-1), view()], [{ op: 'abandon', body: { run: 'r1', token: 'tok1' } }, 'closed']);
  }
}
// an action the run's mode does not allow is never sent (a drawer that is out of date cannot confirm a failed run)
{
  const server = companion();
  server.run = server.make('failed', { failed_step: 'plan', failed_reason: 'x', steps: [] });
  const { q, view, click, drawer } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  drawer.shadow.querySelector('.pubdlg').insertAdjacentHTML('beforeend', '<button data-act="pub-confirm">forged</button>');
  click(q('[data-act="pub-confirm"]')); await tick();
  eq('a confirm on a failed run is not sent', [server.calls.some(c => c.op === 'confirm'), view()], [false, 'problem']);
}
// untrusted clicks on every dialog button
{
  const server = companion();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'P' }] });
  const trusted = await make({ server });
  await tick(10); trusted.click(trusted.q('[data-act="pub-review"]')); await tick();
  eq('(set up: the confirmation is showing)', trusted.view(), 'confirming');
  const callsBefore = server.calls.length;
  // the same dialog, a distrusting drawer: build one on the same page and click every button
  const server2 = companion(); server2.run = server.run;
  const dis = await make({ trusted: false, server: server2 });
  await tick(10);
  for (const b of dis.qa('.pubdlg [data-act]')) b.click();
  await tick(5);
  eq('untrusted clicks on the waiting dialog\'s buttons do nothing', [dis.view(), server2.calls.map(c => c.op)], ['waiting', ['run']]);
  void callsBefore;
}

console.log(`${fail ? '✗' : '✓'} blygpublish-drawer — ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('  · ' + f);
process.exit(fail ? 1 : 0);
