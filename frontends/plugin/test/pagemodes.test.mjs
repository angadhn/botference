// pagemodes.test.mjs — the page side's states that were written as loose
// words with no list, each now ONE named value changed through ONE function
// (the owner's standing rule: no implicit state machines).
//
//   1. a figure-edit batch (config.js FTE_STATES / fteBatchMove) — content.js
//      fteSend and the worker's ledger (background.js fteLedger)
//   2. one card's rendered preview on a book page (blockdiff.js
//      RP_CARD_STATES / rpCardMove) — content.js RP.byCard
//   3. the figure editor's tray outbox (test/fixtures/figure-text-editor.js,
//      a copy of the blog's editor: OUTBOX_STATES / moveOutbox)
//
// content.js cannot be loaded in node (a content script that wants a document,
// a `chrome` and a live page), so the machines live in files that can, and
// content.js is held to them by source checks. The live flow is in the
// harness (test/harness.html, the ?blog=1 figure-editor checks).
//
// Made-up data only.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ext = f => path.join(here, '..', 'extension', f);
const C = require(ext('config.js'));
const BD = require(ext('blockdiff.js'));
const FTE_SRC = path.join(here, 'fixtures', 'figure-text-editor.js');
require(FTE_SRC);                       // no document: only its core loads
const FC = globalThis.FigureTextEditorCore;
const CONTENT = fs.readFileSync(ext('content.js'), 'utf8');
const BG = fs.readFileSync(ext('background.js'), 'utf8');

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const throws = (name, fn) => { try { fn(); ok(name, false, 'did not throw'); } catch { ok(name, true); } };

// ---- 1. a figure-edit batch -------------------------------------------------
{
  eq('the batch states, named', C.FTE_STATES, ['inflight', 'acked', 'failed']);
  ok('…frozen', Object.isFrozen(C.FTE_STATES) && Object.isFrozen(C.FTE_MOVES));
  eq('no batch yet reads as none', C.fteState(null), 'none');
  // a ledger entry from before the list was named: the same three words
  eq('an old ledger entry still reads: inflight', C.fteState({ state: 'inflight' }), 'inflight');
  eq('…acked, with its ack', C.fteState({ state: 'acked', ack: { type: 'ack' } }), 'acked');
  eq('…failed', C.fteState({ state: 'failed' }), 'failed');
  eq('an unknown word reads as failed (may be resent)', C.fteState({ state: 'sent' }), 'failed');
  eq('an acked entry that lost its ack reads as failed', C.fteState({ state: 'acked', ack: null }), 'failed');

  const e = C.fteBatchMove(null, 'send', { authorised: true, request_ids: ['r1'], url: 'http://127.0.0.1:4000/p/', text: 'x', at: 1, mine: true });
  eq('send: a new batch, in flight', [e.state, e.ack, e.request_ids], ['inflight', null, ['r1']]);
  throws('ack with no batch is refused', () => C.fteBatchMove(null, 'ack', {}));
  const ack = { accepted: { message_ts: '1' } };
  eq('ack: inflight → acked, keeping the ack', (() => { const x = C.fteBatchMove(e, 'ack', ack); return [x === e, x.state, x.ack]; })(), [true, 'acked', ack]);
  throws('an acked batch is final: no send', () => C.fteBatchMove(e, 'send', {}));
  throws('…no fail', () => C.fteBatchMove(e, 'fail'));
  throws('…no second ack', () => C.fteBatchMove(e, 'ack', ack));
  const f = C.fteBatchMove(null, 'send', {});
  C.fteBatchMove(f, 'fail');
  eq('fail: inflight → failed', f.state, 'failed');
  throws('failed cannot ack without being sent again', () => C.fteBatchMove(f, 'ack', ack));
  eq('failed → send again', C.fteBatchMove(f, 'send', { text: 'y' }).state, 'inflight');
  eq('a reloaded script\'s inflight entry may be sent again', C.fteBatchMove({ state: 'inflight' }, 'send', {}).state, 'inflight');
  throws('an unknown move throws', () => C.fteBatchMove(e, 'jump'));

  // content.js and the worker keep it through config.js, nowhere else
  const fte = CONTENT.slice(CONTENT.indexOf('const FTE_CAP'), CONTENT.indexOf('function onFigureMessage'));
  ok('the figure-edit code is where we think it is', fte.length > 2000);
  eq('content.js never writes a batch state by hand', fte.match(/\.state\s*=[^=]/g), null);
  eq('…nor reads one by hand', fte.match(/\b[eo]\.state\b/g), null);
  ok('…every change is a fteBatchMove', (fte.match(/CFG\.fteBatchMove\(/g) || []).length === 5);
  ok('the worker keeps only the named states', /CFG\.FTE_STATES\.includes\(e\.state\)/.test(BG)
    && !/\['inflight', 'acked', 'failed'\]/.test(BG));
}

// ---- 2. a rendered preview's card --------------------------------------------
{
  eq('the card states, named', BD.RP_CARD_STATES, ['queued', 'pending', 'ready', 'failed']);
  ok('…frozen', Object.isFrozen(BD.RP_CARD_STATES) && Object.isFrozen(BD.RP_CARD_MOVES));
  eq('no entry reads as none', BD.rpCardState(undefined), 'none');
  const q = BD.rpCardMove(undefined, 'queue');
  eq('queue: none → queued', q, { state: 'queued' });
  throws('a queued card is not queued twice', () => BD.rpCardMove(q, 'queue'));
  const p = BD.rpCardMove(q, 'wait');
  eq('wait: queued → pending', p.state, 'pending');
  eq('wait again: still building', BD.rpCardMove(p, 'wait').state, 'pending');
  const pv = { ok: true, base: '<p>a</p>', card: '<p>b</p>' };
  const r = BD.rpCardMove(p, 'got', pv);
  eq('got: pending → ready, with the preview', [r.state, r.data === pv], ['ready', true]);
  eq('got straight from queued', BD.rpCardMove(q, 'got', pv).state, 'ready');
  throws('a ready card is not waited on', () => BD.rpCardMove(r, 'wait'));
  throws('…nor got twice', () => BD.rpCardMove(r, 'got', pv));
  const f = BD.rpCardMove(r, 'fail');
  eq('fail: ready → failed (the page could not place it)', [f.state, f.why], ['failed', '']);
  eq('fail from queued keeps why', BD.rpCardMove(q, 'fail', 'no build').why, 'no build');
  for (const m of ['queue', 'wait', 'got', 'fail']) throws('failed is final: no ' + m, () => BD.rpCardMove(f, m, pv));
  throws('an unknown move throws', () => BD.rpCardMove(q, 'skip'));

  const a = CONTENT.indexOf('async function rpPump(');
  const rp = CONTENT.slice(a, CONTENT.indexOf('function answerRendered(', a));
  ok('the preview pump is where we think it is', a > 0 && rp.length > 800);
  eq('content.js never writes a card state by hand', rp.match(/state\s*[:=]\s*'/g), null);
  eq('…nor reads one by hand', rp.match(/\.state\s*[!=]==\s*'(queued|pending|ready|failed)'/g), null);
  ok('…every change is an rpCardMove', (rp.match(/BD\.rpCardMove\(/g) || []).length === 5);
}

// ---- 3. the figure editor's tray outbox --------------------------------------
{
  eq('the outbox states, named', FC.OUTBOX_STATES, ['sending', 'failed', 'interrupted']);
  ok('…frozen', Object.isFrozen(FC.OUTBOX_STATES));
  const legal = { none: ['sending'], sending: ['failed', 'interrupted', 'none'],
    failed: ['sending', 'none'], interrupted: ['sending', 'none'] };
  for (const from of Object.keys(legal)) for (const to of ['none', ...FC.OUTBOX_STATES]) {
    const st = { outbox: from === 'none' ? null : { batch_id: 'b', state: from, error: null } };
    const want = legal[from].includes(to);
    let moved = true; try { FC.moveOutbox(st, to, to === 'sending' ? { batch_id: 'b2' } : { code: 'x' }); } catch { moved = false; }
    eq(`${from} → ${to}: ${want ? 'allowed' : 'refused'}`, moved, want);
  }
  throws('a state that is not one throws', () => FC.moveOutbox({ outbox: null }, 'sent'));
  const st = { outbox: null };
  FC.moveOutbox(st, 'sending', { batch_id: 'b', attempts: 1 });
  eq('sending: the new outbox, no error', st.outbox, { batch_id: 'b', attempts: 1, state: 'sending', error: null });
  FC.moveOutbox(st, 'failed', { code: 'x', message: 'made up' });
  eq('failed keeps why', [st.outbox.state, st.outbox.error.code], ['failed', 'x']);
  FC.moveOutbox(st, 'none');
  eq('none: no outbox', st.outbox, null);

  // a reload mid-send: a stored 'sending' outbox reads back interrupted
  const mem = {};
  const storage = { getItem: k => mem[k] || null, setItem: (k, v) => { mem[k] = v; } };
  mem.k = JSON.stringify({ v: 1, edits: [], undo: [], applied: [],
    outbox: { batch_id: 'fte-20261112T1200-0000beef', print: 'p', state: 'sending', attempts: 1, error: null } });
  const S = new FC.Store(storage, 'k');
  eq('a stored send that a reload cut short is resumed, not failed', [S.state.outbox.state, S.state.outbox.error], ['interrupted', null]);
  mem.k = JSON.stringify({ v: 1, edits: [], undo: [], applied: [], outbox: { batch_id: 'x', state: 'failed', error: { code: 'x' } } });
  eq('a stored failed outbox reads as it was', new FC.Store(storage, 'k').state.outbox.state, 'failed');

  // nothing in the editor writes an outbox state but moveOutbox
  const src = fs.readFileSync(FTE_SRC, 'utf8');
  const a = src.indexOf('function moveOutbox(');
  const setter = src.slice(a, src.indexOf('\n  }\n', a));
  const rest = src.slice(0, a) + src.slice(a + setter.length);
  eq('the outbox state is written only in moveOutbox', rest.match(/outbox\.state\s*=[^=]/g), null);
  eq('…and the outbox is cleared only there', rest.match(/\.outbox\s*=\s*null/g), null);
  eq('…and read only through outboxState', rest.match(/\b(ob|outbox)\.state\s*[!=]==/g), null);
}

console.log(`pagemodes: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
