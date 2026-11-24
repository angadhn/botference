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
// a click that starts or carries on a publish counts only once the dialog has been on screen, unobstructed and still for 500 ms
// (the readiness check runs 40 ms after the 500; the margin is for a loaded machine running the suites in parallel)
const settle = () => tick(800);

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
  const run = (mode, extra = {}) => ({ id: 'r1', token: 'tok1', mode, title: 'My first thought', log: { id: '0123456789abcdef', path: '/data/blyg-publish-logs/0123456789abcdef.jsonl' },
    reading: [{ kind: 'words', text: 'Body <img src=x onerror=alert(1)> {{ x }}' }, { kind: 'quote', text: 'the passage' }, { kind: 'agent', by: 'ai', name: 'Written by an AI model', text: 'An agent <b>wrote</b> this.' }, { kind: 'agent', by: 'ai-and-author', name: 'Written by an AI model and edited by the author', text: 'Edited by me.' }],
    steps: [], can: mode === 'planned' ? ['confirm', 'cancel'] : /^failed_/.test(mode) ? ['retry', 'abandon'] : /^interrupted_(applying|applied|publishing)$/.test(mode) ? ['continue', 'abandon'] : /^interrupted_/.test(mode) ? ['abandon'] : mode === 'abandon_failed' ? ['abandon', 'forget'] : [], ...extra });
  state.run = first || run('idle');
  state.make = run;
  state.onBlygPublish = async (op, body) => {
    state.calls.push({ op, body });
    if (state.fail && state.fail[op]) return { ok: false, error: state.fail[op] };
    if (op === 'start') { state.run = run('planning', { steps: [], thread_ids: [body.thread_id], ...(state.confirm ? { confirm: state.confirm } : {}) }); return { ok: true, run: state.run }; }
    if (op === 'run' || op === 'arm') return { ok: true, run: { ...state.run, confirm: state.run.confirm || state.confirm || 'always' }, confirm: state.confirm || 'always' };
    if (op === 'preview') return { ok: true, state: state.picture || 'off' };
    if (op === 'preview-image') return { ok: true, image: 'data:image/png;base64,iVBORw0KGgo=' };
    if (op === 'confirm') { state.run = run('applying', { steps: [{ step: 'plan', ok: true, ms: 1 }], thread_ids: state.run.thread_ids || ['t1'] }); return { ok: true, run: state.run }; }
    if (op === 'cancel') { state.run = run('cancelled'); return { ok: true, run: state.run }; }
    if (op === 'retry') { state.run = run('publishing', { steps: state.run.steps }); return { ok: true, run: state.run }; }
    if (op === 'continue') { state.run = run('publishing', { steps: state.run.steps }); return { ok: true, run: state.run }; }
    if (op === 'abandon' && state.abandonFails) { state.run = run('abandon_failed', { abandon_failure: 'Nothing to abandon for the note.', steps: state.run.steps }); return { ok: false, error: 'Your site could not give this publish up.', run: state.run }; }
    if (op === 'abandon') { state.run = run('abandoned'); return { ok: true, run: state.run }; }
    if (op === 'forget') { state.run = run('abandoned', { cleanup: { outcome: 'forgotten', said: 'Forgotten here only.' } }); return { ok: true, run: state.run }; }
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
  eq('server modes → views', ['idle', 'drafted', 'preparing', 'planning', 'planned', 'applying', 'applied', 'publishing', 'published', 'failed_prepare', 'failed_plan', 'failed_apply', 'failed_publish', 'interrupted_drafted', 'interrupted_planning', 'interrupted_applying', 'interrupted_publishing', 'interrupted_unknown', 'cancelled', 'abandoned'].map(CFG.pubViewOf),
    ['closed', 'working', 'working', 'working', 'confirming', 'running', 'running', 'running', 'done', 'problem', 'problem', 'problem', 'problem', 'problem', 'problem', 'problem', 'problem', 'problem', 'closed', 'closed']);
  eq('planned is a confirmation only when the owner asked to confirm', [CFG.pubViewOf('planned', 'always'), CFG.pubViewOf('planned', 'never'), CFG.pubViewOf('planned')], ['confirming', 'running', 'confirming']);
  eq('an unknown mode is shown as a problem, never as success', CFG.pubViewOf('nonsense'), 'problem');
  eq('the named operations', Object.keys(CFG.BLYG_PUBLISH_OPS), ['start', 'run', 'arm', 'confirm', 'retry', 'continue', 'cancel', 'abandon', 'forget', 'preview', 'preview-image']);
  eq('only confirm, retry and continue need an offer', Object.entries(CFG.BLYG_PUBLISH_OPS).filter(([, v]) => v.offer === 'needs').map(([k]) => k), ['confirm', 'retry', 'continue']);
  eq('only arm opens one (for the act it names)', [Object.entries(CFG.BLYG_PUBLISH_OPS).filter(([, v]) => v.offer === 'grants').map(([k]) => k), CFG.BLYG_ARMED_ACTS], [['arm'], ['confirm', 'retry', 'continue']]);
}

// ---- who sees the paper-plane -----------------------------------------------------------------
{
  const { qa, q } = await make();
  eq('the paper-plane is on the owner\'s own, unaddressed comments (a published one\'s plane publishes a new version)', qa('.thr-pub').map(b => b.dataset.target), ['t1', 't2', 'tp', 'tx']);
  eq('…and says so', qa('.thr-pub').slice(2).map(b => b.getAttribute('aria-label')), ['publish a new version of this post', 'publish a new version of this post']);
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
  click(qa('.thr-pub')[1]); await tick();                                   // the second comment: there is one above it
  eq('choosing', [view(), dlg().hidden], ['choosing', false]);
  eq('both scopes are offered, the second with its count', qa('.pubdlg [data-act="pub-scope"]').map(b => [b.dataset.scope, b.textContent]), [['one', 'Just this comment'], ['above', 'This and the 1 above']]);
  await settle(); click(q('[data-act="pub-scope"][data-scope="above"]')); await tick();
  eq('start sends the thread, the scope and the setting the owner was shown, nothing else', server.calls.at(-1), { op: 'start', body: { thread_id: 't2', scope: 'above', confirm: 'always' } });
  eq('planning is shown as working', view(), 'working');
  ok('and says nothing is published', /Nothing is published/.test(dlg().textContent));
  server.run = server.make('planning', { steps: [{ step: 'prepare', ok: true, ms: 900 }], running: { step: 'plan', elapsed_ms: 4000 } });
  drawer.blygPublishMoved(); await tick(5);
  eq('plain steps, one line each, ticks for the done ones, the current one marked now with its time', qa('.pubsteps li').map(li => [li.className, li.querySelector('.pubword').textContent, (li.querySelector('.pubnow') || {}).textContent || '']),
    [['done', 'Writing your note', ''], ['now', 'Checking that only this note changes', 'now · 4 s'], ['todo', 'Building and checking your site', ''], ['todo', 'Publishing', ''], ['todo', 'Waiting for your site to update', ''], ['todo', 'Live', '']]);
  { const shown = [...dlg().querySelectorAll('*')].filter(e => !e.closest('details')).map(e => [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('')).join(' ');
    ok('no file name, script name, command output or bracket mark in the owner\'s view (outside the closed details)', !/_notes|scripts\/|blyg-publish|\.md\b|\[TK\]|exit|stdout/.test(shown), shown); }
  ok('the troubleshooting details are closed, and hold the run id and the log file', !q('details.pubdetails').open && /0123456789abcdef/.test(q('details.pubdetails').textContent) && /blyg-publish-logs/.test(q('details.pubdetails').textContent));
  server.run = server.make('planned', { steps: [{ step: 'plan', ok: true, ms: 5 }], notify: 'Venkatesh Rao will be told you responded' });
  drawer.blygPublishMoved(); await tick(5);
  eq('the run arrived planned: the confirmation', view(), 'confirming');
  eq('the note reads as text: the words, the quote, and the agent\'s passage in a box with its marks (an <img> in it is words)', [qa('.pubdlg .pubwords').length, qa('.pubdlg .pubquote').length, q('.pubagenttext').textContent, qa('.pubdlg img').length, qa('.pubdlg b').length, /<img src=x onerror=alert\(1\)>/.test(q('.pubwords').textContent)],
    [1, 1, 'An agent <b>wrote</b> this.', 0, 0, true]);
  eq('the boxes carry marks with an accessible name and a tooltip, never a name of an agent, a model or the owner', qa('.pubagentmarks').map(m => [m.getAttribute('role'), m.getAttribute('aria-label'), m.getAttribute('title'), !!m.querySelector('svg'), !!m.querySelector('.pubagentA')]),
    [['img', 'Written by an AI model', 'Written by an AI model', true, false], ['img', 'Written by an AI model and edited by the author', 'Written by an AI model and edited by the author', true, true]]);
  ok('no name on the boxes', !/Claude|Codex|owner|AI model \+/.test(qa('.pubagent').map(a => a.textContent).join(' ')));
  ok('who is told, in plain words', /Venkatesh Rao will be told you responded\./.test(q('.pubnotify').textContent));
  ok('no file name, no plan output', !/_notes|PLAN|Would notify/.test(dlg().textContent));
  eq('Publish and Cancel, and Close (which keeps the run for later), nothing else', qa('.pubdlg [data-act]').map(b => b.dataset.act), ['pub-confirm', 'pub-cancel', 'pub-close']);
  const before = server.calls.length;
  await settle(); click(q('[data-act="pub-confirm"]')); await tick();
  eq('Publish arms THIS act from the click, then sends the run\'s id and token', server.calls.slice(-2), [{ op: 'arm', body: { act: 'confirm' } }, { op: 'confirm', body: { run: 'r1', token: 'tok1' } }]);
  // IN THE BACKGROUND: the box closes by itself, one line says so and fades; the thread shows a quiet chip, the header a mark
  eq('the box closes by itself; one line says it goes on in the background', [view(), dlg().hidden, drawer.footNote.mode, drawer.footNote.text], ['closed', true, 'info', 'Publishing in the background. You\'ll be told when it\'s live.']);
  eq('the thread\'s quiet chip', qa('.pubchip').map(c => c.textContent), ['publishing…']);
  const mark = q('.hdr .pubprog');
  eq('the header\'s small mark', [!!mark, mark && mark.hidden], [true, false]);
  eq('there is nothing left to press twice: no Publish button while running', [qa('[data-act="pub-confirm"]').length, server.calls.filter(c => c.op === 'confirm').length], [0, 1]);
  click(mark); await tick();
  eq('the mark opens the plain steps (no Try again while it runs)', [view(), qa('.pubdlg [data-act="pub-retry"]').length, !!q('.pubsteps')], ['running', 0, true]);
  click(q('.pubdlg [data-act="pub-close"]')); await tick();
  eq('closed again: the mark stays while the run goes on', [view(), q('.hdr .pubprog').hidden], ['closed', false]);
  void before;
}
{
  const { server, q, dlg, drawer, view, click, qa } = await make();
  click(qa('.thr-pub')[0]); await tick(); await settle(); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'P' }] }); drawer.blygPublishMoved(); await tick(5);
  await settle(); click(q('[data-act="pub-confirm"]')); await tick();
  server.run = server.make('published', { steps: [{ step: 'plan', ok: true }, { step: 'apply', ok: true }, { step: 'publish', ok: true }],
    published: { at: 'now', title: 'My first thought', permalink: '/b/my-first-thought', address: 'https://site.example.test/b/my-first-thought' } });
  drawer.blygPublishMoved(); await tick(5);
  eq('published while the box was closed: no dialog pops up (the worker\'s notice tells), the chip and the mark are gone', [view(), qa('.pubchip').length, q('.hdr .pubprog').hidden], ['closed', 0, true]);
  await drawer.pubShowRun(); await tick(5);
  eq('published: Live, the link, and every step ticked', [view(), q('.pubdlg h2').textContent, q('.pubdlg a').getAttribute('href'), qa('.pubsteps li').map(li => li.className)], ['done', 'Live', 'https://site.example.test/b/my-first-thought', ['done', 'done', 'done', 'done', 'done', 'done']]);
  ok('the link is safe', q('.pubdlg a').getAttribute('rel') === 'noopener noreferrer' && q('.pubdlg a').getAttribute('target') === '_blank');
  server.run = server.make('published', { published: { title: 't', permalink: '/b/t', address: 'javascript:alert(1)' } });
  click(q('[data-act="pub-close"]'));
  eq('closed', view(), 'closed');
}

// ---- F7: the wording follows the setting in force, asked when the menu opens; the start carries it back ---------------------------------
{
  const server = companion(); server.confirm = 'never';
  const { q, qa, dlg, view, click, drawer } = await make({ server });
  click(qa('.thr-pub')[0]); await tick();
  eq('the menu asked the companion what is in force (as it opened) and shows THAT wording', [server.calls.filter(c => c.op === 'run').length >= 2, /Choosing one of these publishes it now/.test(dlg().textContent), drawer.pub.shown], [true, true, 'never']);
  click(q('.pubdlg [data-act="pub-close"]')); await tick();
  // the setting changes behind the drawer's back: the next opening shows the new wording, and a stale start is refused by the companion
  server.confirm = 'always';
  click(qa('.thr-pub')[0]); await tick();
  eq('reopened: the new wording, with no memory of the old one', [/Nothing is published yet: first you will see exactly what would be/.test(dlg().textContent), drawer.pub.shown], [true, 'always']);
  click(q('.pubdlg [data-act="pub-close"]')); await tick();
  // an answer that cannot say what a click would do offers nothing
  server.fail = { run: 'the companion is not there' };
  click(qa('.thr-pub')[0]); await tick();
  eq('no answer: nothing is offered, with a plain message', [view(), qa('[data-act="pub-scope"]').length, /Could not ask the companion|the companion is not there/.test(dlg().textContent)], ['problem', 0, true]);
}

// ---- confirm 'never': one click is the publish; one line on the thread; no dialog ------------------------------------
{
  const server = companion(); server.confirm = 'never';
  const { q, qa, dlg, view, click, drawer } = await make({ server });
  click(qa('.thr-pub')[0]); await tick();
  ok('choosing says it publishes now', /publishes it now: there is no further step/.test(dlg().textContent) && /Publish just this comment/.test(dlg().textContent));
  await settle(); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  eq('start sent, and the dialog is out of the way', [server.calls.at(-1), dlg().hidden, view()], [{ op: 'start', body: { thread_id: 't1', scope: 'one', confirm: 'never' } }, true, 'working']);
  eq('the thread carries ONE line of progress, in the owner\'s words', [qa('.publine').length, q('.publine').textContent], [1, 'Publishing as a blyg… checking that only this note changes']);
  server.run = server.make('planned', { confirm: 'never', thread_ids: ['t1'], steps: [{ step: 'plan', exit: 0, output: 'P' }] });
  drawer.blygPublishMoved(); await tick(5);
  eq('planned is NOT a confirmation when nobody has to confirm: no buttons, still running', [view(), dlg().hidden, qa('[data-act="pub-confirm"]').length], ['running', true, 0]);
  server.run = server.make('publishing', { confirm: 'never', thread_ids: ['t1'], running: { step: 'publish', phase: 'wait', elapsed_ms: 192000 } });
  drawer.blygPublishMoved(); await tick(5);
  eq('publishing is on the line: the step in the owner\'s words and how long (never what a command printed)', q('.publine').textContent, 'Publishing as a blyg… waiting for your site to update (3 min 12 s)');
  server.run = server.make('published', { confirm: 'never', thread_ids: ['t1'], published: { title: 't', permalink: '/b/t', address: 'https://site.example.test/b/t' } });
  drawer.blygPublishMoved(); await tick(5);
  eq('published: the link on the thread, the view free again', [view(), q('.publine.done a').getAttribute('href'), dlg().hidden], ['closed', 'https://site.example.test/b/t', true]);
  server.run = server.make('failed_plan', { confirm: 'never', thread_ids: ['t1'], failed_step: 'plan', failure: 'This plan is for more than the note and its own sources.', steps: [{ step: 'plan', ok: false }] });
  drawer.pub.view = 'running'; drawer.pub.run = server.run; drawer.pub.opener = 'start';
  drawer.blygPublishMoved(); await tick(5);
  eq('a failure brings the dialog back: ONE sentence (the site\'s recognised line) and the choices', [view(), dlg().hidden, q('.pubdlg p.puberr').textContent, qa('.pubdlg .pbtn').map(b => b.textContent)], ['problem', false, 'This plan is for more than the note and its own sources.', ['Try again', 'Start over', 'Close']]);
}

// ---- clickjacking: a page's overlay over the drawer --------------------------------------------------------------------
// What happy-dom CAN simulate: a top-layer element (document.querySelector(':modal') / ':popover-open' answering), a fullscreen
// element, and elementsFromPoint returning something above the drawer's host. What it cannot: a real top layer, real hit-testing,
// real pointer-events:none; those are the browser's, so the checks are asked of exactly the DOM calls a browser answers.
{
  const BIG = { left: 0, top: 0, right: 5000, bottom: 5000, width: 5000, height: 5000 };
  const real = { qa: document.querySelectorAll.bind(document), q: document.querySelector.bind(document), efp: document.elementsFromPoint, fs: Object.getOwnPropertyDescriptor(document, 'fullscreenElement') };
  const cases = [
    ['a modal dialog in the top layer', () => { document.querySelectorAll = sel => (sel === ':modal' ? [{ tagName: 'DIALOG', getBoundingClientRect: () => BIG }] : real.qa(sel)); }],
    ['a popover in the top layer', () => { document.querySelectorAll = sel => (sel === ':popover-open' ? [{ tagName: 'DIV', getBoundingClientRect: () => BIG }] : real.qa(sel)); }],
    ['a fullscreen element', () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => ({ tagName: 'DIV' }) }); }],
    ['something above the drawer at the click\'s point', () => { document.elementsFromPoint = () => [{ tagName: 'DIV', id: 'cover' }]; }],
  ];
  for (const [name, set] of cases) {
    const server = companion();
    const { q, qa, view, click, dlg, drawer } = await make({ server });
    click(qa('.thr-pub')[0]); await tick();
    eq(name + ': (set up: choosing)', view(), 'choosing');
    await settle();   // the buttons are ready; the page lays something over them at the last moment
    set();
    const ev = new MouseEvent('click', { bubbles: true, composed: true, clientX: 10, clientY: 10 });
    q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev); await tick();
    eq(name + ': nothing is started, and the owner is told what to do', [server.calls.some(c => c.op === 'start'), view(), /Close the page's overlay and try again/.test(dlg().textContent)], [false, 'problem', true]);
    document.querySelector = real.q; document.querySelectorAll = real.qa; document.elementsFromPoint = real.efp; delete document.fullscreenElement;
    void drawer;
  }
  // …and when the point is the drawer's own host, it goes through
  const server = companion();
  const { q, qa, view, click, drawer } = await make({ server });
  click(qa('.thr-pub')[0]); await tick();
  document.elementsFromPoint = () => [drawer.host];
  await settle(); q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 10, clientY: 10 })); await tick();
  eq('with the drawer on top and no top layer, the start goes out', [server.calls.some(c => c.op === 'start'), view()], [true, 'working']);
  document.elementsFromPoint = real.efp;
}

// ---- review item 7: fail closed, the host's position, and a button that must have been ready for 500 ms ---------------------------
{
  const real = { efp: document.elementsFromPoint, gcs: globalThis.getComputedStyle };
  const ev = () => new MouseEvent('click', { bubbles: true, composed: true, clientX: 10, clientY: 10 });
  // a page that makes the check throw gets nothing (it used to pass)
  {
    const server = companion(); const { q, qa, view, click, drawer } = await make({ server });
    click(qa('.thr-pub')[0]); await tick(); await settle();
    document.elementsFromPoint = () => [drawer.host];
    globalThis.getComputedStyle = () => { throw new Error('a page broke getComputedStyle'); };
    q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev()); await tick();
    globalThis.getComputedStyle = real.gcs;
    eq('an exception while checking: refused (fails closed)', [server.calls.some(c => c.op === 'start'), view()], [false, 'problem']);
    document.elementsFromPoint = real.efp;
  }
  // the host moved or unpinned: refused, as an overlay is
  for (const [name, set] of [['top moved', h => { h.style.setProperty('top', '300px', 'important'); }], ['left moved', h => { h.style.setProperty('left', '-40px', 'important'); }],
    ['bottom moved', h => { h.style.setProperty('bottom', '200px', 'important'); }], ['position not fixed', h => { h.style.setProperty('position', 'absolute', 'important'); }],
    ['inset changed', h => { h.style.setProperty('inset', '10px', 'important'); }]]) {
    const server = companion(); const { q, qa, view, click, drawer } = await make({ server });
    click(qa('.thr-pub')[0]); await tick(); await settle();
    const h = drawer.host; set(h);
    document.elementsFromPoint = () => [h];
    q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev()); await tick();
    eq(`the host's ${name}: blocked`, [server.calls.some(c => c.op === 'start'), view()], [false, 'problem']);
    for (const k of ['top', 'left', 'right', 'bottom', 'position', 'inset']) h.style.removeProperty(k);
    document.elementsFromPoint = real.efp;
  }
  // readiness: a click the moment the buttons appear does not count; after 500 ms on screen and still, it does; a dialog that moved
  // must settle again
  {
    const server = companion(); const { q, qa, view, click, drawer, dlg } = await make({ server });
    document.elementsFromPoint = () => [drawer.host];
    click(qa('.thr-pub')[0]); await tick();
    q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev()); await tick();
    eq('a click right after the buttons appear: nothing is started, and it says to wait', [server.calls.some(c => c.op === 'start'), view(), /only just appeared or moved/.test(dlg().textContent)], [false, 'choosing', true]);
    await settle();
    const box = drawer.shadow.querySelector('.pubdlg');
    let at = 0; box.getBoundingClientRect = () => ({ left: at, top: 0, right: at + 300, bottom: 400, width: 300, height: 400 });
    at = 50;   // the page slid the dialog after it was ready
    q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev()); await tick();
    eq('the dialog moved after it was ready: not counted', server.calls.some(c => c.op === 'start'), false);
    await settle();
    q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev()); await tick();
    eq('ready again after 500 ms in the same place: the start goes out', [server.calls.some(c => c.op === 'start'), view()], [true, 'working']);
    document.elementsFromPoint = real.efp;
  }
}

// ---- F8: the stronger check, on every action that publishes or carries on ----------------------------------------------------------
// Unverifiable without a real browser: that IntersectionObserver v2's isVisible really turns false under a page's overlay/filter/frame
// (here its callback is fed by hand), real top-layer and hit-testing behaviour, and real computed style across a page's own stylesheets.
{
  const BIG = { left: 0, top: 0, right: 5000, bottom: 5000, width: 5000, height: 5000 };
  const FAR = { left: 4000, top: 4000, right: 4100, bottom: 4100, width: 100, height: 100 };
  const MINE = { left: 0, top: 0, right: 300, bottom: 400, width: 300, height: 400 };
  const real = { qa: document.querySelectorAll.bind(document), efp: document.elementsFromPoint };
  const ev = () => new MouseEvent('click', { bubbles: true, composed: true, clientX: 10, clientY: 10 });
  // a top-layer element that does NOT meet the drawer's box is none of our business (it must not block)
  {
    const server = companion(); const { q, qa, view, click, drawer } = await make({ server });
    drawer.shadow.querySelector('.pubdlg').getBoundingClientRect = () => MINE;
    click(qa('.thr-pub')[0]); await tick();
    document.querySelectorAll = sel => (sel === ':modal' ? [{ getBoundingClientRect: () => FAR }] : real.qa(sel));
    document.elementsFromPoint = () => [drawer.host];
    await settle(); q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev()); await tick();
    eq('a modal far from the drawer does not block', [server.calls.some(c => c.op === 'start'), view()], [true, 'working']);
    document.querySelectorAll = real.qa;
    // …but one over it does
    const s2 = companion(); const x = await make({ server: s2 });
    x.drawer.shadow.querySelector('.pubdlg').getBoundingClientRect = () => MINE;
    x.click(x.qa('.thr-pub')[0]); await tick();
    await settle();
    document.querySelectorAll = sel => (sel === ':popover-open' ? [{ getBoundingClientRect: () => BIG }] : real.qa(sel));
    document.elementsFromPoint = () => [x.drawer.host];
    x.q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev()); await tick();
    eq('a popover over the drawer blocks', [s2.calls.some(c => c.op === 'start'), x.view()], [false, 'problem']);
    document.querySelectorAll = real.qa; document.elementsFromPoint = real.efp;
  }
  // the host's style chain
  for (const [name, set] of [['opacity', h => { h.style.opacity = '0.4'; }], ['filter', h => { h.style.filter = 'blur(2px)'; }], ['clip-path', h => { h.style.clipPath = 'inset(0 50% 0 0)'; }], ['visibility', h => { h.style.visibility = 'hidden'; }], ['transform on the host', h => { h.style.transform = 'scale(0.1)'; }], ['opacity on an ancestor', h => { h.parentElement.style.opacity = '0.5'; }]]) {
    const server = companion(); const { q, qa, view, click, drawer } = await make({ server });
    click(qa('.thr-pub')[0]); await tick();
    await settle();
    const h = drawer.host; set(h);
    document.elementsFromPoint = () => [h];
    q('[data-act="pub-scope"][data-scope="one"]').dispatchEvent(ev()); await tick();
    eq(`the host's ${name}: blocked`, [server.calls.some(c => c.op === 'start'), view()], [false, 'problem']);
    h.style.opacity = ''; h.style.filter = ''; h.style.clipPath = ''; h.style.visibility = ''; h.style.transform = ''; if (h.parentElement) h.parentElement.style.opacity = '';
    document.elementsFromPoint = real.efp;
  }
  // confirm, retry and continue each get the same check (a mutant that dropped it from one of them survived)
  for (const [mode, act, op, extra] of [['planned', 'pub-confirm', 'confirm', {}], ['failed_publish', 'pub-retry', 'retry', { failed_step: 'publish', failed_reason: 'x' }], ['interrupted_publishing', 'pub-continue', 'continue', { interrupted_from: 'publishing', interrupted_why: 'x' }]]) {
    const server = companion();
    server.run = server.make(mode, { steps: [{ step: 'plan', exit: 0, output: 'P' }], ...extra });
    const { q, view, click, drawer } = await make({ server });
    await tick(10); click(q('[data-act="pub-review"]')); await tick();
    const before = server.calls.length;
    document.elementsFromPoint = () => [{ id: 'cover' }];
    await settle(); q(`[data-act="${act}"]`).dispatchEvent(ev()); await tick();
    eq(`${op}: an overlay at the click point stops it (nothing sent)`, [server.calls.slice(before).some(c => c.op === op || c.op === 'arm'), /Close the page's overlay and try again/.test(drawer.shadow.querySelector('.pubdlg').textContent)], [false, true]);
    document.elementsFromPoint = () => [drawer.host];
    await settle(); q(`[data-act="${act}"]`).dispatchEvent(ev()); await tick();
    eq(`${op}: and goes through when the drawer is on top`, server.calls.slice(before).some(c => c.op === op), true);
    document.elementsFromPoint = real.efp;
  }
  // IntersectionObserver v2, where it exists: act only if isVisible was true
  {
    // every publish-buttons observer (one per drawer: drawers made by earlier tests make theirs too), and a report delivered to the
    // observer that watches that button, as a browser would
    const seen = []; const watchers = [];
    const cb = entries => { for (const o of watchers) { const its = entries.filter(en => o.els.includes(en.target)); if (its.length) o.f(its); } };
    globalThis.IntersectionObserverEntry = class { get isVisible() { return true; } };
    // (only the publish buttons' observer asks for trackVisibility: another observer the drawer makes must not take its callback)
    globalThis.IntersectionObserver = class { constructor(f, o) { this.mine = !!(o && o.trackVisibility); this.f = f; this.els = []; if (this.mine) watchers.push(this); } observe(el) { if (this.mine) { seen.push(el); this.els.push(el); } } unobserve() {} disconnect() {} };
    w.IntersectionObserver = globalThis.IntersectionObserver; w.IntersectionObserverEntry = globalThis.IntersectionObserverEntry;
    const server = companion(); const { q, qa, view, click, drawer } = await make({ server });
    click(qa('.thr-pub')[0]); await tick();
    ok('the buttons are watched with v2', seen.length >= 2 && seen.every(b => b.classList && b.classList.contains('pbtn')));
    await settle(); const btn = q('[data-act="pub-scope"][data-scope="one"]');
    document.elementsFromPoint = () => [drawer.host];
    // no report yet that it is visible: refused (the browser has not vouched for it)
    btn.dispatchEvent(ev()); await tick();
    eq('v2 has not said visible: refused', [server.calls.some(c => c.op === 'start'), view()], [false, 'problem']);
    const s2 = companion(); const y = await make({ server: s2 });
    y.click(y.qa('.thr-pub')[0]); await tick();
    await settle(); const b2 = y.q('[data-act="pub-scope"][data-scope="one"]');
    cb([{ target: b2, isVisible: false, intersectionRatio: 1 }]);
    document.elementsFromPoint = () => [y.drawer.host];
    b2.dispatchEvent(ev()); await tick();
    eq('v2 says NOT visible (covered or filtered): refused', [s2.calls.some(c => c.op === 'start'), y.view()], [false, 'problem']);
    const s3 = companion(); const z = await make({ server: s3 });
    z.click(z.qa('.thr-pub')[0]); await tick();
    await settle(); const b3 = z.q('[data-act="pub-scope"][data-scope="one"]');
    cb([{ target: b3, isVisible: true, intersectionRatio: 1 }]);
    document.elementsFromPoint = () => [z.drawer.host];
    b3.dispatchEvent(ev()); await tick();
    eq('v2 says visible: it goes through', [s3.calls.some(c => c.op === 'start'), z.view()], [true, 'working']);
    delete globalThis.IntersectionObserver; delete globalThis.IntersectionObserverEntry; delete w.IntersectionObserver; delete w.IntersectionObserverEntry;
    document.elementsFromPoint = real.efp;
  }
}

// ---- F9: an earlier step still running, and a record that cannot be trusted ----------------------------------------------------------
{
  const server = companion();
  server.run = server.make('interrupted_publishing', { interrupted_from: 'publishing', interrupted_why: 'x', earlier_step: 'alive', steps: [{ step: 'apply', ok: true }] });
  server.run.can = ['stop-and-continue', 'stop-and-abandon'];
  const { q, qa, view, click } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  eq('the earlier step is still running: no plain Carry on or Start over, a choice to stop it first', [view(), qa('.pubdlg [data-act]').filter(b => b.tagName === 'BUTTON').map(b => b.dataset.act), /still running on the companion's machine: stop it first/.test(q('.pubdlg').textContent)], ['problem', ['pub-stop-continue', 'pub-stop-abandon', 'pub-close'], true]);
  const before = server.calls.length;
  document.elementsFromPoint = () => [{ id: 'x' }];
  await settle(); click(q('[data-act="pub-stop-continue"]')); await tick();
  document.elementsFromPoint = undefined; delete document.elementsFromPoint;
  await settle(); click(q('[data-act="pub-stop-continue"]')); await tick();
  eq('the owner\'s choice sends continue with stop: yes', server.calls.slice(before).filter(c => c.op === 'continue').map(c => c.body), [{ run: 'r1', token: 'tok1', stop: 'yes' }]);
}
{
  // an earlier step that cannot be identified: only Forget, and Forget asks twice
  const server = companion();
  server.run = server.make('interrupted_publishing', { interrupted_from: 'publishing', earlier_step: 'unknown', steps: [] });
  server.run.can = ['forget'];
  const { q, qa, view, click } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  eq('unknown: only Forget', qa('.pubdlg button[data-act]').map(b => b.dataset.act), ['pub-forget', 'pub-close']);
  click(q('[data-act="pub-forget"]')); await tick();
  eq('the first press asks again and sends nothing', [server.calls.some(c => c.op === 'forget'), /Press again to confirm/.test(q('.pubdlg').textContent), q('[data-act="pub-forget"]').textContent], [false, true, 'Yes, forget it']);
  click(q('[data-act="pub-forget"]')); await tick();
  eq('the second sends forget with sure: yes', [server.calls.at(-1), view()], [{ op: 'forget', body: { run: 'r1', token: 'tok1', sure: 'yes' } }, 'closed']);
}
{
  const server = companion();
  server.run = server.make('interrupted_publishing', { interrupted_from: 'publishing', interrupted_why: 'x', tainted: 'This run\'s record names a note outside the notes folder, so nothing will be run or removed with it.', steps: [] });
  server.run.can = ['abandon'];
  const { q, qa, click } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  eq('a tainted record: its words, and only Start over', [/names a note outside the notes folder/.test(q('.pubdlg').textContent), qa('.pubdlg button[data-act]').map(b => b.dataset.act)], [true, ['pub-abandon', 'pub-close']]);
}

// ---- the picture of the draft (the companion renders it; the drawer shows pixels in a box) ---------------------------------------
{
  const server = companion(); server.picture = 'waiting';
  server.run = server.make('planned', { steps: [{ step: 'plan', ok: true }], preview_url: 'http://127.0.0.1:4000/b/0abc' });
  const { q, qa, view, click, drawer } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick(20);
  eq('confirming asks for the picture, with the drawer\'s theme; while it is made the box says so and the note\'s text is shown',
    [view(), server.calls.filter(c => c.op === 'preview').at(-1).body.theme, drawer.pub.pic.state, /it can take a few seconds to appear/.test(q('.pubpic').textContent), qa('.pubread').length], ['confirming', 'light', 'waiting', true, 1]);
  server.picture = 'ready'; drawer.blygPublishMoved(); await tick(20);
  eq('ready: the picture in a box with its caption, open full size and refresh; the text is not repeated', [drawer.pub.pic.state, q('.pubpicimg').getAttribute('src').startsWith('data:image/png;base64,'), /how it will look/.test(q('.pubpic figcaption').textContent),
    q('.pubpicopen').getAttribute('href'), q('.pubpicopen').getAttribute('rel'), qa('.pubread').length], ['ready', true, true, 'http://127.0.0.1:4000/b/0abc', 'noopener noreferrer', 0]);
  click(q('[data-act="pub-pic-refresh"]')); await tick(20);
  eq('refresh asks again (fresh)', [server.calls.filter(c => c.op === 'preview').at(-1).body.fresh], ['yes']);
  // a forged image address is never shown
  const s2 = companion(); s2.picture = 'ready'; s2.run = s2.make('planned', { steps: [] });
  s2.onBlygPublish = (orig => async (op, body) => (op === 'preview-image' ? { ok: true, image: 'javascript:alert(1)' } : orig(op, body)))(s2.onBlygPublish);
  const y = await make({ server: s2 }); await tick(10); y.click(y.q('[data-act="pub-review"]')); await tick(20);
  eq('an image that is not a PNG data address: "Preview not available", and the text', [y.drawer.pub.pic.state, /Preview not available/.test(y.q('.pubpic').textContent), y.qa('.pubpicimg').length, y.qa('.pubread').length], ['unavailable', true, 0, 1]);
  // no preview address: no box at all
  const s3 = companion(); s3.run = s3.make('planned', { steps: [] });
  const z = await make({ server: s3 }); await tick(10); z.click(z.q('[data-act="pub-review"]')); await tick(20);
  eq('no preview set: no box, the note\'s text', [z.qa('.pubpic').length, z.qa('.pubread').length], [0, 1]);
}
// a new VERSION of a published post: the plane on it, the preview says which version and the changelog line
{
  const server = companion();
  const { q, qa, view, click, drawer } = await make({ server });
  click(q('.thr-pub[data-target="tp"]')); await tick();
  eq('the plane on a published thread offers a new version', [view(), q('.pubdlg h2').textContent, qa('[data-act="pub-scope"]').map(b => b.textContent)], ['choosing', 'Publish a new version', ['Prepare version 2']]);
  await settle(); click(q('[data-act="pub-scope"]')); await tick();
  server.run = server.make('planned', { kind: 'edit', version: 2, changelog: 'Edited the second comment.', steps: [{ step: 'plan', ok: true }] });
  drawer.blygPublishMoved(); await tick(5);
  eq('the edit preview: which version, and the changelog line', [view(), q('.pubdlg h2').textContent, q('.pubchange').textContent, q('[data-act="pub-confirm"]').textContent], ['confirming', 'This updates your post (version 2)', 'Edited the second comment.', 'Publish version 2']);
}

// ---- cancel, and Escape --------------------------------------------------------------------------
{
  const { server, q, drawer, view, click, qa } = await make();
  click(qa('.thr-pub')[0]); await tick(); await settle(); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'P' }] }); drawer.blygPublishMoved(); await tick(5);
  click(q('[data-act="pub-cancel"]')); await tick();
  eq('Cancel sends the run\'s id and token and closes', [server.calls.at(-1), view()], [{ op: 'cancel', body: { run: 'r1', token: 'tok1' } }, 'closed']);
}
{
  const { server, q, drawer, view, click, qa } = await make();
  click(qa('.thr-pub')[0]); await tick(); await settle(); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'P' }] }); drawer.blygPublishMoved(); await tick(5);
  drawer.escape();
  eq('Escape closes the dialog and sends nothing (the run stays where it is)', [view(), server.calls.filter(c => ['cancel', 'confirm', 'abandon'].includes(c.op)).length], ['closed', 0]);
}

// ---- a refusal ----------------------------------------------------------------------------------------
{
  const server = companion(); server.fail = { start: 'Nothing has changed since you published this. <script>x</script>' };
  const { q, view, click, qa, dlg } = await make({ server });
  click(qa('.thr-pub')[0]); await tick(); await settle(); click(q('[data-act="pub-scope"][data-scope="one"]')); await tick();
  eq('a refusal is shown as words in a problem view', [view(), dlg().textContent.includes('Nothing has changed since you published this. <script>x</script>'), qa('.pubdlg script').length], ['problem', true, 0]);
  eq('with only Close', qa('.pubdlg [data-act]').map(b => b.dataset.act), ['pub-close']);
}

// ---- a reload: the run is found, offered, and not acted on ---------------------------------------------------
{
  const server = companion();
  server.run = server.make('planned', { steps: [{ step: 'plan', exit: 0, output: 'PLAN-TEXT' }] });
  const { q, qa, dlg, view, click, drawer } = await make({ server });
  await tick(10);
  eq('a reloaded drawer finds a run waiting and offers to open it (no note, no Publish)', [view(), qa('.pubdlg [data-act]').map(b => b.dataset.act), /For “My first thought”/.test(dlg().textContent)], ['waiting', ['pub-review', 'pub-close'], true]);
  eq('it only asked what the run is', server.calls.map(c => c.op), ['run']);
  click(q('[data-act="pub-review"]')); await tick();
  eq('Open it shows the run\'s own view; it asks nothing to act (an act arms itself, from its own click)', [server.calls.filter(c => c.op !== 'preview').map(c => c.op), view(), qa('.pubdlg [data-act]').map(b => b.dataset.act)], [['run'], 'confirming', ['pub-confirm', 'pub-cancel', 'pub-close']]);
  void drawer;
}
for (const [mode, buttons] of [['failed_publish', ['pub-retry', 'pub-abandon', 'pub-close']], ['interrupted_publishing', ['pub-continue', 'pub-abandon', 'pub-close']]]) {
  const server = companion();
  server.run = server.make(mode, { failed_step: mode === 'failed_publish' ? 'publish' : '', failure: '', interrupted_from: mode === 'failed_publish' ? '' : 'publishing', tries: 3,
    steps: [{ step: 'plan', ok: true }, { step: 'apply', ok: true }, { step: 'publish', ok: false }] });
  const { q, qa, dlg, view, click } = await make({ server });
  await tick(10);
  click(q('[data-act="pub-review"]')); await tick();
  eq(`${mode}: a problem view with one sentence and only what the mode allows`, [view(), qa('.pubdlg button[data-act]').map(b => b.dataset.act)], ['problem', buttons]);
  ok(`${mode}: no command words on screen`, !/--push|--abandon|exit/.test(dlg().textContent));
  ok(`${mode}: and nothing is retried by itself`, !server.calls.some(c => ['retry', 'confirm'].includes(c.op)));
  if (mode === 'failed_publish') {
    eq('the sentence when the site printed nothing recognised, and a quiet count of tries (earlier attempts are not listed as failures)', [q('.pubdlg p.puberr').textContent, /Tried 3 times\./.test(dlg().textContent), qa('.pubsteps li.failed').length], ['Something went wrong while publishing.', true, 1]);
    eq('the buttons, in the owner\'s words', qa('.pubdlg .pbtn').map(b => b.textContent), ['Try again', 'Start over', 'Close']);
    await settle(); click(q('[data-act="pub-retry"]')); await tick();
    eq('a retry is the owner\'s click: it arms THIS act and then retries, with the run\'s token', server.calls.slice(-2), [{ op: 'arm', body: { act: 'retry' } }, { op: 'retry', body: { run: 'r1', token: 'tok1' } }]);
    eq('and it goes on in the background: the box closes by itself', view(), 'closed');
  } else {
    click(q('[data-act="pub-abandon"]')); await tick();
    eq('abandon sends the run\'s id and token', [server.calls.at(-1), view()], [{ op: 'abandon', body: { run: 'r1', token: 'tok1' } }, 'closed']);
  }
}
// the site's own abandon fails: the run comes back as abandon_failed, and the drawer alone can still end it (Forget this run here)
{
  const server = companion();
  server.abandonFails = true;
  server.run = server.make('failed_publish', { failed_step: 'publish', failed_reason: 'publish exited with code 1', steps: [{ step: 'publish', exit: 1, output: 'boom' }] });
  const { q, qa, dlg, view, click } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  click(q('[data-act="pub-abandon"]')); await tick();
  eq('a failed site abandon: the problem view offers giving up again and Forget, with the reason', [view(), qa('.pubdlg button[data-act]').map(b => b.dataset.act)], ['problem', ['pub-abandon', 'pub-forget', 'pub-close']]);
  ok('the site\'s plain line is on screen', /Nothing to abandon for the note/.test(dlg().textContent) && /Try giving it up again/.test(dlg().textContent));
  click(q('[data-act="pub-forget"]')); await tick();
  eq('Forget sends the run\'s id and token and closes', [server.calls.at(-1), view()], [{ op: 'forget', body: { run: 'r1', token: 'tok1' } }, 'closed']);
}
// an action the run's mode does not allow is never sent (a drawer that is out of date cannot confirm a failed run)
{
  const server = companion();
  server.run = server.make('failed_plan', { failed_step: 'plan', failed_reason: 'x', steps: [] });
  const { q, view, click, drawer } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  drawer.shadow.querySelector('.pubdlg').insertAdjacentHTML('beforeend', '<button data-act="pub-confirm">forged</button>');
  await settle(); click(q('[data-act="pub-confirm"]')); await tick();
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


// ---- (c) the drawer never loses a run: Close keeps what is needed; the plane on ANY thread first asks for the run and shows it ----------
for (const [mode, view0, act] of [['planning', 'working', ''], ['planned', 'confirming', 'pub-confirm'], ['applying', 'running', ''], ['failed_plan', 'problem', 'pub-retry'],
  ['interrupted_publishing', 'problem', 'pub-continue'], ['abandon_failed', 'problem', 'pub-forget']]) {
  const server = companion();
  server.run = server.make(mode, { thread_ids: ['t1'], failed_step: mode === 'failed_plan' ? 'plan' : '', interrupted_from: mode === 'interrupted_publishing' ? 'publishing' : '', steps: [] });
  const { q, qa, view, click, drawer } = await make({ server });
  await tick(10);
  const live = ['working', 'running'].includes(view0);
  // a run going on in the background is not put in front of the owner on opening: the chip and the header mark say it
  eq(`${mode}: (set up) found on opening`, [view(), q('.hdr .pubprog').hidden], live ? ['closed', false] : ['waiting', true]);
  if (!live) { click(q('[data-act="pub-close"]')); await tick(); }
  for (const tid of ['t1', 't2']) {
    click(q(`.thr-pub[data-target="${tid}"]`)); await tick();
    eq(`${mode}: the plane on ${tid} shows the run, never the scope choice`, [view(), qa('[data-act="pub-scope"]').length, /For “My first thought”/.test(q('.pubdlg').textContent)], [view0, 0, true]);
    click(q('[data-act="pub-close"]')); await tick();
    eq(`${mode}: Close`, [view(), !!drawer.pub.run], ['closed', true]);
  }
  if (act) {
    click(q('.thr-pub[data-target="t2"]')); await tick();
    document.elementsFromPoint = () => [drawer.host];
    await settle(); click(q(`[data-act="${act}"]`)); await tick(10);
    const op = act.slice(4);
    ok(`${mode}: reopened from another thread, ${op} works with no reload`, server.calls.some(c => c.op === op), JSON.stringify(server.calls.slice(-3)));
    delete document.elementsFromPoint;
  }
}

// ---- review (b): the on-screen check: a button the page moved off screen does not count ---------------------------------------------
{
  const server = companion();
  server.run = server.make('planned', { steps: [] });
  const { q, view, click, drawer } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  document.elementsFromPoint = () => [drawer.host];
  await settle();
  const btn = q('[data-act="pub-confirm"]');
  btn.getBoundingClientRect = () => ({ left: -4000, top: -4000, right: -3900, bottom: -3970, width: 100, height: 30 });
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 10, clientY: 10 })); await tick();
  eq('a button off screen: nothing is armed or sent, and the owner is told', [server.calls.some(c => c.op === 'arm' || c.op === 'confirm'), /Close the page's overlay and try again/.test(q('.pubdlg').textContent)], [false, true]);
  const box = drawer.shadow.querySelector('.pubdlg');
  delete btn.getBoundingClientRect;
  box.getBoundingClientRect = () => ({ left: 9000, top: 9000, right: 9300, bottom: 9400, width: 300, height: 400 });
  await settle();
  q('[data-act="pub-confirm"]').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 10, clientY: 10 })); await tick();
  eq('the whole dialog off screen: nothing is sent', [server.calls.some(c => c.op === 'arm' || c.op === 'confirm'), view()], [false, 'confirming']);
  delete document.elementsFromPoint;
}

// ---- review round 5: the drawer inside another page's frame acts on nothing --------------------------------------------------------
{
  const realTop = Object.getOwnPropertyDescriptor(w, 'top');
  const frame = () => Object.defineProperty(w, 'top', { configurable: true, get: () => ({ framing: 'page' }) });
  const unframe = () => { if (realTop) Object.defineProperty(w, 'top', realTop); else delete w.top; };
  try {
    // the plane
    const a = await make();
    frame();
    a.click(a.q('.thr-pub[data-target="t1"]')); await tick();
    eq('framed: the plane shows a plain refusal and asks the companion nothing more', [a.view(), /in a tab of its own/.test(a.dlg().textContent), a.server.calls.filter(c => c.op !== 'run').length], ['problem', true, 0]);
    unframe();
    // a run waiting for the owner: Publish and Cancel do nothing while framed
    const server = companion();
    server.run = server.make('planned', { steps: [] });
    const b = await make({ server });
    await tick(10); b.click(b.q('[data-act="pub-review"]')); await tick();
    document.elementsFromPoint = () => [b.drawer.host];
    await settle();
    frame();
    for (const act of ['pub-confirm', 'pub-cancel']) { b.click(b.q(`[data-act="${act}"]`)); await tick(); }
    eq('framed: no act is armed or sent', server.calls.filter(c => ['arm', 'confirm', 'cancel'].includes(c.op)).length, 0);
    ok('…and the owner is told why', /in a tab of its own/.test(b.dlg().textContent));
    unframe();
    await settle();
    b.click(b.q('[data-act="pub-confirm"]')); await tick(20);
    ok('in its own tab again: Publish works', server.calls.some(c => c.op === 'confirm'));
    delete document.elementsFromPoint;
  } finally { unframe(); }
}

// ---- review round 5: the second confirmation is one named value moved by one function; a new version that may be live says so ----
{
  const src = (await import('node:fs')).readFileSync(path.join(here, '..', 'extension', 'drawer.js'), 'utf8');
  eq('D.pub.ask is written only by pubAskMove', [...src.matchAll(/D\.pub\.ask\s*=(?!=)/g)].length, 1);
  const server = companion();
  server.run = server.make('failed_publish', { kind: 'edit', version: 2, can: ['retry', 'abandon', 'forget'], unsure: 'Your site may already have published the new version, so your note was left as it is: look at the post on your site, and if the new version is not there, publish it from your site.' });
  const { q, click } = await make({ server });
  await tick(10); click(q('[data-act="pub-review"]')); await tick();
  ok('a new version that may be live: the one sentence, and Forget', /may already have published the new version/.test(q('.pubunsure').textContent) && !!q('[data-act="pub-forget"]'));
}

console.log(`${fail ? '✗' : '✓'} blygpublish-drawer — ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('  · ' + f);
process.exit(fail ? 1 : 0);
