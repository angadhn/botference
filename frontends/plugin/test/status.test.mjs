// status.test.mjs — what a comment thread is CALLED comes from one function.
//
// The finding (2026-11-10): a thread's status (open, ready, resolved, struck,
// orphaned) is about twelve flags written from five files, and the labels
// read them each their own way, so they could disagree. The labels now all
// read one function: drawer.js threadStatus (stage + mark + orphaned) for
// the side panel, the bubbles and the page paint, and store.mjs threadStage
// for the companion. What is asserted here:
//   · the drawer's and the companion's stage agree on every combination of
//     the stored flags, old records included (a record with both `resolved`
//     and `addressed` set, as an older companion could leave, is resolved);
//   · the page's live orphan answer outranks the record's;
//   · the paint a stage wears on the page;
//   · nothing writes the old `resolved` / `addressed` flags; a record that has
//     them is converted to `status` and stripped (on read and on save);
//   · in the drawer (happy-dom): reopening a resolved thread that still had
//     `addressed` on it reads "open" at once, as the companion will say,
//     not "ready"; and a failed reopen puts every field back as it came.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
// store.mjs resolves its workspace at import time — a throwaway keeps the
// old-record conversion below (a real readPage) out of the live .botference
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-status-'));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection', 'ResizeObserver']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'extension', 'drawer.js'));
const store = await import(path.join(here, '..', 'store.mjs'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ---- 1. one rule, both sides ------------------------------------------------
{
  eq('the three stages, named (drawer)', D.THREAD_STAGES, ['open', 'ready', 'resolved']);
  eq('…the same three (companion)', store.THREAD_STAGES, D.THREAD_STAGES);
  eq('the two marks, named', D.THREAD_MARKS, ['highlight', 'strike']);
  const table = [
    [null, 'open'], [{}, 'open'],
    [{ addressed: true }, 'ready'],
    [{ resolved: true }, 'resolved'],
    [{ resolved: true, addressed: true }, 'resolved'],      // an old record with both
    [{ resolved: false, addressed: true }, 'ready'],
    [{ addressed: false }, 'open'],
    [{ resolved: true, resolved_at: '2026-01-01', orphaned: true }, 'resolved'],
  ];
  for (const [t, want] of table) {
    const label = JSON.stringify(t);
    eq('drawer stage of ' + label, D.threadStage(t), want);
    eq('companion stage of ' + label, store.threadStage(t), want);
    eq('…isResolved agrees, both sides', [D.isResolvedThread(t), store.isResolved(t)], [want === 'resolved', want === 'resolved']);
    eq('…isAddressed means ready', store.isAddressed(t), want === 'ready');
  }
  eq('mark: strike', D.threadMark({ mark: 'strike' }), 'strike');
  eq('mark: anything else is a highlight', [D.threadMark({ mark: 'x' }), D.threadMark(null)], ['highlight', 'highlight']);
  eq('…and the companion’s markOf agrees', [store.markOf({ mark: 'strike' }), store.markOf({})], ['strike', 'highlight']);
  eq('orphaned: the record, when the page has not looked', D.threadStatus({ orphaned: true }).orphaned, true);
  eq('orphaned: the page’s live answer outranks the record', [D.threadStatus({ orphaned: true }, false).orphaned,
    D.threadStatus({}, true).orphaned], [false, true]);
  eq('the whole status', D.threadStatus({ addressed: true, mark: 'strike' }), { stage: 'ready', mark: 'strike', orphaned: false });
  eq('the paint each stage wears', [D.stagePaint({}), D.stagePaint({ addressed: true }), D.stagePaint({ resolved: true, addressed: true })],
    [false, 'ready', true]);
}

// ---- 1b. ONE stored field, ONE setter, ONE move table ------------------------
{
  const S = store.THREAD_STAGES;
  eq('the move table names every stage, both sides', [Object.keys(store.THREAD_MOVES), Object.keys(D.THREAD_MOVES)], [S, S]);
  eq('…and the two tables are the same table', JSON.stringify(D.THREAD_MOVES), JSON.stringify(store.THREAD_MOVES));
  const legal = { open: ['open', 'ready', 'resolved'], ready: ['open', 'ready', 'resolved'], resolved: ['open', 'resolved'] };
  for (const from of S) for (const to of S.concat(['done', '', undefined])) {
    const want = !!(legal[from] && legal[from].includes(to));
    eq(`move ${from} → ${to}: ${want ? 'allowed' : 'refused'} (companion, drawer)`,
      [store.threadMove(from, to), D.threadMove(from, to)], [want, want]);
  }
  eq('no move from a status that is not one', [store.threadMove('filed', 'open'), D.threadMove('filed', 'open')], [false, false]);

  // the setter, every legal move, and what it leaves on the record
  const fresh = () => ({ id: 't', quote: 'q', msgs: [{ author: 'reader', ts: '1', text: 'hm' }], status: 'open' });
  const t = fresh();
  let r = store.setThreadStatus(t, 'ready', 'claude');
  ok('open → ready changes it', r.changed && !r.refused);
  eq('…status and stamps, and no old flag beside them', [t.status, 'addressed' in t, t.addressed_by, typeof t.addressed_at, 'resolved' in t],
    ['ready', false, 'claude', 'string', false]);
  const firstAt = t.addressed_at;
  r = store.setThreadStatus(t, 'ready', 'codex');
  ok('ready → ready is allowed, not a change of stage', !r.refused && r.changed === false);
  eq('…but it is a new claim: re-stamped with who made it', t.addressed_by, 'codex');
  ok('…at a stamp of its own', typeof t.addressed_at === 'string' && t.addressed_at >= firstAt);
  r = store.setThreadStatus(t, 'resolved', 'reader');
  eq('ready → resolved: the claim is spent, the filing stamped',
    [r.changed, t.status, 'resolved' in t, t.resolved_by, 'addressed' in t, 'addressed_at' in t, 'addressed_by' in t],
    [true, 'resolved', false, 'reader', false, false, false]);
  const before = JSON.stringify(t);
  r = store.setThreadStatus(t, 'ready', 'claude');
  ok('resolved → ready is REFUSED', !!r.refused && r.changed === false);
  ok('…in words a person can read', /reopen it first/.test(r.refused), r.refused);
  eq('…and the record is untouched by the attempt', JSON.stringify(t), before);
  r = store.setThreadStatus(t, 'filed', 'reader');
  ok('an unknown status is refused too', !!r.refused && JSON.stringify(t) === before);
  r = store.setThreadStatus(t, 'resolved', 'someone-else');
  ok('resolved → resolved changes nothing, not even who filed it', r.changed === false && t.resolved_by === 'reader');
  r = store.setThreadStatus(t, 'open');
  eq('resolved → open: reopened, every resolved field gone', [r.changed, t.status, Object.keys(t).filter(k => /^(resolved|addressed)/.test(k))],
    [true, 'open', []]);
  eq('…so it is byte-identical to a thread never touched', JSON.stringify(t), JSON.stringify(fresh()));
  ok('the setter survives being handed nothing', store.setThreadStatus(null, 'open') === null);

  // the drawer's twin answers the same on the same moves
  const d = fresh();
  ok('drawer: open → ready', D.setThreadStage(d, 'ready', 'claude').changed && d.status === 'ready' && !('addressed' in d));
  ok('drawer: ready → resolved', D.setThreadStage(d, 'resolved').changed && d.status === 'resolved' && !('resolved' in d) && !('addressed' in d));
  const oldD = { id: 'od', resolved: true, addressed: true, msgs: [] };
  ok('drawer: a move on an old local copy strips its flags', D.setThreadStage(oldD, 'open').changed
    && oldD.status === 'open' && !('resolved' in oldD) && !('addressed' in oldD));
  const snap = D.threadStatusFields(d);
  ok('drawer: resolved → ready refused', !!D.setThreadStage(d, 'ready').refused && d.status === 'resolved');
  ok('drawer: resolved → open', D.setThreadStage(d, 'open').changed && d.status === 'open' && !('resolved' in d));
  D.restoreThreadStatus(d, snap);
  eq('drawer: an undone optimistic move puts back exactly what was there', D.threadStatusFields(d), snap);

  // the orphan flag is not a status, and has its own one writer
  const o = fresh();
  ok('orphaned: set', store.setOrphaned(o, true) && o.orphaned === true);
  ok('orphaned: setting it again is no change', store.setOrphaned(o, true) === false);
  ok('orphaned: cleared', store.setOrphaned(o, false) && o.orphaned === false);
  ok('orphaned: …on any stage', store.setThreadStatus(o, 'resolved').changed && store.setOrphaned(o, true) && o.status === 'resolved');
  ok('drawer: the local copy’s orphan flag has one writer too', D.setThreadOrphaned(o, false) && o.orphaned === false);

  // appendMsg goes through the setter, including the two-step a bot makes
  // into a filed thread (resolved → open → ready)
  const page = { url: 'https://example.com/x', threads: [{ ...fresh(), id: 'a' }], page_chat: [] };
  const a = page.threads[0];
  store.setThreadStatus(a, 'resolved', 'reader');
  store.appendMsg(page, 'a', { author: 'claude', text: 'one more thing' });
  eq('a bot answering a filed thread: reopened, then ready', [a.status, 'addressed' in a, 'resolved' in a, a.addressed_by], ['ready', false, false, 'claude']);
  store.appendMsg(page, 'a', { author: 'claude', kind: 'tools', text: 'Read file' });
  eq('a tools line leaves ready alone', a.status, 'ready');
  store.appendMsg(page, 'a', { author: 'reader', text: 'not quite' });
  eq('the reader writing in: open', [a.status, 'addressed' in a], ['open', false]);
}

// ---- 1c. OLD RECORDS: converted on read, nothing lost, nothing rewritten ----
{
  const URL_OLD = 'https://example.com/old-record';
  const at = '2026-01-02T03:04:05.000Z';
  const old = {
    url: URL_OLD, title: 'Old', kind: 'article', page_chat: [],
    threads: [
      { id: 'o1', quote: 'never touched', msgs: [{ author: 'reader', ts: '1', text: 'made up one' }] },
      { id: 'o2', quote: 'answered', addressed: true, addressed_at: at, addressed_by: 'claude',
        msgs: [{ author: 'reader', ts: '1', text: 'made up two' }, { author: 'claude', ts: '2', text: 'made up reply' }] },
      { id: 'o3', quote: 'filed', resolved: true, resolved_at: at, resolved_by: 'reader', summary: 'settled',
        orphaned: true, mark: 'strike', msgs: [{ author: 'reader', ts: '1', text: 'made up three' }] },
      { id: 'o4', quote: 'both, as an older companion could leave it', resolved: true, resolved_at: at, resolved_by: 'reader',
        addressed: true, addressed_at: at, addressed_by: 'codex', msgs: [{ author: 'reader', ts: '1', text: 'made up four' }] },
      { id: 'o5', quote: 'explicit false', resolved: false, addressed: false, msgs: [{ author: 'reader', ts: '1', text: 'made up five' }] },
    ],
  };
  const file = store.pageFile(URL_OLD);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(old));
  const mtime = fs.statSync(file).mtimeMs;
  const bytes = fs.readFileSync(file, 'utf8');
  const page = store.readPage(URL_OLD);
  const by = id => page.threads.find(t => t.id === id);
  eq('old records get a status, by the old rule', ['o1', 'o2', 'o3', 'o4', 'o5'].map(id => by(id).status),
    ['open', 'ready', 'resolved', 'resolved', 'open']);
  eq('…stamps, summary, mark and orphan flag all kept',
    [by('o2').addressed_at, by('o2').addressed_by, by('o3').resolved_at, by('o3').resolved_by, by('o3').summary, by('o3').orphaned, by('o3').mark],
    [at, 'claude', at, 'reader', 'settled', true, 'strike']);
  eq('…messages untouched', page.threads.map(t => t.msgs.length), [1, 2, 1, 1, 1]);
  eq('the impossible pair reads resolved, its stamps kept',
    [by('o4').status, by('o4').addressed_at, by('o4').addressed_by], ['resolved', at, 'codex']);
  eq('every old flag is stripped on read, true or false', page.threads.map(t => ['resolved' in t, 'addressed' in t].join()),
    Array(5).fill('false,false'));
  eq('reading converts in memory: the file on disk is not rewritten',
    [fs.readFileSync(file, 'utf8') === bytes, fs.statSync(file).mtimeMs === mtime], [true, true]);
  // a second read converts the same way, and still writes nothing
  const again = store.readPage(URL_OLD);
  eq('a second read: same answer, still no write', [again.threads.map(t => t.status).join(), fs.readFileSync(file, 'utf8') === bytes],
    ['open,ready,resolved,resolved,open', true]);
  // the next ordinary save persists the conversion, once
  store.savePage(again);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq('the next save writes the status down', disk.threads.map(t => t.status), ['open', 'ready', 'resolved', 'resolved', 'open']);
  eq('…and no old flag at all', disk.threads.filter(t => 'resolved' in t || 'addressed' in t).length, 0);
  // a stray flag on a record in memory is not saved either
  again.threads[0].resolved = false; again.threads[1].addressed = true;
  store.savePage(again);
  eq('savePage strips a stray flag', JSON.parse(fs.readFileSync(file, 'utf8')).threads.filter(t => 'resolved' in t || 'addressed' in t).length, 0);
  const third = store.readPage(URL_OLD);
  ok('a converted record reads back unchanged', JSON.stringify(third.threads) === JSON.stringify(disk.threads));
  // a record whose status and flags disagree (an older writer touched only the
  // flags): the status is the truth, and the flag is stripped
  const odd = { status: 'open', resolved: true };
  eq('status outranks a stale shadow flag', [store.threadStage(odd), D.threadStage(odd)], ['open', 'open']);
  store.normalizeThreadStatus(odd);
  ok('…and normalising strips the flag', !('resolved' in odd) && odd.status === 'open');
  ok('a record with a status that is not one falls back to its flags',
    store.threadStage({ status: 'nonsense', addressed: true }) === 'ready' && D.threadStage({ status: 'nonsense', addressed: true }) === 'ready');
}

// ---- 2. in the drawer: reopening reads "open" at once -----------------------
const URL_ = 'https://example.com/article';
const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({
  ts: `2026-11-11T10:${String(i).padStart(2, '0')}:00.000Z`,
  author: i % 2 ? 'claude' : 'reader', text: `${tag} message ${i}`,
}));
const pending = [];
const drawer = D.create({
  cssText: '.panel{}',
  onResolve: () => new Promise(r => pending.push(r)),
});
drawer.setConn(true);
drawer.setAuthor('reader');
drawer.open('comments');
drawer.setPage({ url: URL_, title: 'Article', page_chat: [],
  threads: [{ id: 't1', quote: 'a passage', msgs: msgs(2, 'one'), resolved: true, addressed: true, addressed_by: 'claude' }] });
await tick(20);
const root = drawer.shadow;
const card = () => root.querySelector('.pane[data-pane="comments"] .card[data-thread="t1"]');
{
  const sec = root.querySelector('[data-act="resolved-toggle"]');
  if (sec && !root.querySelector('.resolved-list')) { sec.click(); await tick(5); }
  ok('a resolved thread (with an old `addressed` still on it) is under Resolved', !!card() && card().classList.contains('resolved'));
  const reopen = card() && card().querySelector('[data-act="reopen"]');
  ok('it has a reopen button', !!reopen);
  if (reopen) {
    reopen.click();
    await tick(5);
    ok('reopened: it reads open at once, not ready for review', !!card() && !card().classList.contains('resolved')
      && !card().classList.contains('ready'), card() && card().className);
    // the companion refuses: everything goes back as it was
    pending.shift()({ ok: false, error: 'no' });
    await tick(10);
    ok('a refused reopen puts it back under Resolved', !!card() && card().classList.contains('resolved'));
    const t = drawer.page.threads[0];
    eq('…with every field as it was', [t.resolved, t.addressed, t.addressed_by, t.status], [true, true, 'claude', undefined]);
  }
}

// ---- 1d. nothing but the conversion path touches the old flags ------------
{
  const PLUGIN = path.join(here, '..');
  const files = [];
  const walk = dir => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'test' || f.name === 'vendor' || f.name === 'node_modules') continue;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walk(full); else if (/\.(mjs|js|html)$/.test(f.name)) files.push(full);
  } };
  walk(PLUGIN);
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'latin1').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;                                   // a comment
      const code = line.replace(/\b(data|body)\.(resolved|addressed)\b/g, '')    // a request's own field
        .replace(/\.card\.resolved\b/g, '');                                   // a CSS class
      if (/\.(resolved|addressed)\b(?!-)/.test(code)) hits.push(path.relative(PLUGIN, f) + ':' + (i + 1));
    });
  }
  // the conversion path, and one field that is not a thread's: a mirrored
  // review comment's own `resolved` (server.mjs POST /comments-sync)
  const allowed = [/^extension\/drawer\.js:/, /^store\.mjs:/, /^reader\.js:/, /^extension\/pdf\/viewer\.js:/, /^server\.mjs:/];
  const lines = hits.map(h => h.replace(/:\d+$/, ''));
  eq('only the conversion path reads or writes .resolved / .addressed',
    hits.filter(h => !allowed.some(r => r.test(h))), []);
  eq('…and there, once each: threadStage + the setter (drawer), stageOfFlags (store), isFiled (reader, viewer), the review comment (server)',
    lines.sort(), ['extension/drawer.js', 'extension/drawer.js', 'extension/pdf/viewer.js', 'reader.js', 'server.mjs', 'store.mjs']);
}

console.log(`status: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
