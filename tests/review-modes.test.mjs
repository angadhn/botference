// Review engine: state files, card modes, requests waiting for the owner,
// time limits on child processes, and the page's live-connection mode.
//
// Each test here pins a defect found in the 2026-11 audit of the paper-review
// front end, in the order it would have bitten:
//   · an unreadable record read as empty and then written over
//   · the apply ledger saved only after a whole batch, and not atomically
//   · a rejected suggestion riding into the commit (card modes)
//   · collaborator requests dropped by "Release" while the agents were down
//   · a hung git/pandoc freezing the server; an uncaught error killing it
//   · failed clicks doing nothing visible; skipped cards never redrawn
//   · the connection chip stuck on the backup feed, showing "live" over nothing
//
// Run:  node --test tests/review-modes.test.mjs     (needs pandoc + git)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENGINE = path.join(HOME, 'frontends', 'review');
const DETECT = path.join(HOME, 'scripts', 'review-detect.mjs');
let HAPPY = false;
try { await import('happy-dom'); HAPPY = true; } catch { }
const needsHappy = { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' };

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => port === 4177 ? resolve(freePort()) : resolve(port));
    });
  });
}
function scaffold(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `review-modes-${name}-`));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  // commits made by the server under test need an identity of their own
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
  return dir;
}
function installEngine(dir) {
  const rd = path.join(dir, 'review');
  fs.mkdirSync(path.join(rd, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(ENGINE)) {
    if (f === 'assets' || f === 'site' || f === 'state') continue;
    fs.copyFileSync(path.join(ENGINE, f), path.join(rd, f));
  }
  for (const f of fs.readdirSync(path.join(ENGINE, 'assets'))) {
    fs.copyFileSync(path.join(ENGINE, 'assets', f), path.join(rd, 'assets', f));
  }
  fs.mkdirSync(path.join(rd, 'state', 'users'), { recursive: true });
}
const gitLog = dir => execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');

// a one-file paper with two suggestion cards on it
const PAPER = 'Opening line.\nThe method is fast and also cheap.\nThe second sentence is long.\n';
function paper(name) {
  const dir = scaffold(name, { 'main.tex': PAPER });
  installEngine(dir);
  fs.writeFileSync(path.join(dir, 'review', 'review.config.json'),
    JSON.stringify({ slug: 't', format: 'latex', main: 'main.tex', sections: [{ file: 'main.tex', title: 'T' }] }));
  fs.writeFileSync(path.join(dir, 'review', 'suggestions.json'), JSON.stringify([
    { id: 'c1', type: 'rewrite', section: '00-t', author: 'claude', source_file: 'main.tex',
      current_text: 'is fast and also cheap', proposed_text: 'is fast and cheap' },
    { id: 'c2', type: 'rewrite', section: '00-t', author: 'claude', source_file: 'main.tex',
      current_text: 'second sentence is long', proposed_text: 'second sentence is short' },
  ]));
  return dir;
}
async function engineFor(dir) {
  const { ApplyEngine } = await import(path.join(dir, 'review', 'apply.mjs'));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'review', 'review.config.json'), 'utf8'));
  return new ApplyEngine({ reviewDir: path.join(dir, 'review'), cfg });
}

async function withServer(dir, fn, args = [], env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, 'review', 'server.mjs'), ...args],
    { cwd: dir, env: { ...process.env, PORT: String(port), ...env } });
  let out = '';
  proc.stdout.on('data', c => { out += c; });
  proc.stderr.on('data', c => { out += c; });
  try {
    const deadline = Date.now() + 15000;
    while (!/Review live at/.test(out)) {
      if (Date.now() > deadline) throw new Error(`server did not start:\n${out}`);
      await new Promise(r => setTimeout(r, 100));
    }
    const base = `http://127.0.0.1:${port}`;
    const call = async (url, body) => {
      const r = await fetch(base + url, body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    await fn({ base, call, proc, output: () => out });
  } finally {
    proc.kill();
  }
}

// ================================================================ B3: ledger

test('apply ledger: an unreadable record is never read as empty, and nothing is applied over it', async t => {
  const dir = paper('ledger-broken');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'review', 'state', 'apply.json');
  const broken = '{"round": {"base": "abc", "ids": ["c9"], "files": ["main.tex"]}, "cards": {';
  fs.writeFileSync(ledger, broken);
  const eng = await engineFor(dir);

  const r = eng.apply(['c1']);
  assert.deepEqual(r.applied, []);
  assert.match(r.skipped[0].reason, /record of applied changes .* could not be read, so nothing was changed/);
  assert.equal(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'), PAPER, 'the source is untouched');
  assert.match(eng.commit().reason, /could not be read/);
  assert.match(eng.revert().reason, /could not be read/);
  assert.match(eng.publicLedger().error, /could not be read/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), broken, 'the record is byte-for-byte as it was');
});

test('apply ledger: each edit is recorded as it lands, so a crash half-way can still be reverted', async t => {
  const dir = paper('ledger-crash');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const eng = await engineFor(dir);
  // the second card blows up mid-batch, after the first edit hit the source
  const resolve = eng.resolve.bind(eng);
  eng.resolve = card => { if (card.id === 'c2') throw new Error('simulated crash'); return resolve(card); };
  assert.throws(() => eng.apply(['c1', 'c2']), /simulated crash/);

  assert.match(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'), /is fast and cheap/, 'c1 landed');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'review', 'state', 'apply.json'), 'utf8'));
  assert.equal(onDisk.cards.c1.mode, 'applied', 'and the record already says so');
  assert.deepEqual(onDisk.round.files, ['main.tex']);
  // so the round can be put back
  const fresh = await engineFor(dir);
  assert.equal(fresh.revert().ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'), PAPER);
});

test('apply ledger: an edit that landed but was never recorded is not committed; the round can still be reverted', async t => {
  const dir = paper('ledger-unrecorded');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const eng = await engineFor(dir);
  // the process dies after the source is written, before the card is saved as applied
  const saveLedger = eng.saveLedger.bind(eng);
  let saves = 0;
  eng.saveLedger = l => { if (++saves === 2) throw new Error('simulated crash'); return saveLedger(l); };
  assert.throws(() => eng.apply(['c1']), /simulated crash/);

  assert.match(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'), /is fast and cheap/, 'the edit is in the source');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'review', 'state', 'apply.json'), 'utf8'));
  assert.deepEqual(onDisk.round.ids, ['c1'], 'the round already names the card');
  assert.notEqual(onDisk.cards.c1.mode, 'applied');
  const fresh = await engineFor(dir);
  assert.match(fresh.commit().reason, /no longer marked as applied\. Revert the round and apply again/);
  assert.equal(fresh.revert().ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'), PAPER);
});

test('apply ledger: writes replace the file whole (temp file, then rename)', async t => {
  const dir = paper('ledger-atomic');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const eng = await engineFor(dir);
  eng.setCardMode('c1', 'accepted');
  const ledger = path.join(dir, 'review', 'state', 'apply.json');
  const before = fs.statSync(ledger).ino;
  eng.setCardMode('c1', 'rejected');
  assert.notEqual(fs.statSync(ledger).ino, before, 'a new file was renamed into place');
  assert.deepEqual(fs.readdirSync(path.dirname(ledger)).filter(f => f.includes('.tmp.')), [], 'no temp files left');
});

test('apply ledger: an old {applied, flagged} ledger is read as the modes it meant', async t => {
  const dir = paper('ledger-old');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'review', 'state', 'apply.json'), JSON.stringify({
    round: null,
    applied: { c1: { ts: 't', source_file: 'main.tex', committed: 'abc1234' }, c3: { ts: 't' } },
    flagged: { c2: { reason: 'span ambiguous', ts: 't' } },
  }));
  const eng = await engineFor(dir);
  const cards = eng.publicLedger().cards;
  assert.equal(cards.c1.mode, 'committed');
  assert.equal(cards.c1.sha, 'abc1234');
  assert.equal(cards.c3.mode, 'applied');
  assert.equal(cards.c2.mode, 'flagged');
  assert.equal(cards.c2.reason, 'span ambiguous');
});

test('apply ledger: a record from newer software is refused out loud and never written over', async t => {
  const dir = paper('ledger-newer');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'review', 'state', 'apply.json');
  const eng = await engineFor(dir);
  const cases = [
    // a format number this engine does not know yet
    JSON.stringify({ format: 99, round: null, cards: { c1: { mode: 'applied' } } }),
    // a shape it cannot read: a card mode it has never heard of
    JSON.stringify({ format: 2, round: null, cards: { c1: { mode: 'half-applied' } } }),
    // a field it has never heard of
    JSON.stringify({ round: null, cards: {}, rounds: [] }),
  ];
  for (const text of cases) {
    fs.writeFileSync(ledger, text);
    const pub = eng.publicLedger();
    assert.match(pub.error, /review software is older than its record of applied changes \(review\/state\/apply\.json\), so nothing was changed\. In the hub, turn this paper off and then on again to update it\./, text);
    assert.deepEqual(eng.apply(['c1']).applied, []);
    assert.match(eng.commit().reason, /older than its record/);
    assert.match(eng.revert().reason, /older than its record/);
    assert.equal(eng.syncDecisions({ c1: 'accepted' }).ok, false);
    assert.equal(eng.setCardMode('c1', 'accepted').ok, false);
    assert.equal(fs.readFileSync(ledger, 'utf8'), text, 'the record is byte-for-byte as it was');
  }
  assert.equal(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'), PAPER, 'the source is untouched');
});

test('apply ledger: a record without a format number still reads, and is saved with one', async t => {
  const dir = paper('ledger-unversioned');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'review', 'state', 'apply.json');
  fs.writeFileSync(ledger, JSON.stringify({ round: null, cards: { c1: { mode: 'accepted' } } }));
  const eng = await engineFor(dir);
  const { LEDGER_FORMAT } = await import(path.join(dir, 'review', 'apply.mjs'));
  assert.equal(eng.publicLedger().error, undefined);
  assert.equal(eng.publicLedger().cards.c1.mode, 'accepted');
  assert.ok(eng.setCardMode('c2', 'accepted').ok);
  const saved = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(saved.format, LEDGER_FORMAT);
  assert.equal(saved.cards.c1.mode, 'accepted');
  assert.equal(saved.cards.c2.mode, 'accepted');
});

test('apply ledger: the page says so in one line and draws no card as not applied (happy-dom)', needsHappy, async t => {
  const msg = "This paper's review software is older than its record of applied changes (review/state/apply.json), so nothing was changed. In the hub, turn this paper off and then on again to update it.";
  const pg = await page(t, { data: { apply: { cards: {}, round: null, error: msg } } });
  assert.equal(pg.doc.getElementById('apply-blocked').textContent, msg);
  pg.focus('s1');
  const accept = pg.doc.querySelector('.card[data-id="s1"] [data-act="accepted"]');
  assert.equal(accept.disabled, true, 'no button may change a card whose state is not known');
  assert.match(pg.doc.querySelector('.card[data-id="s1"]').textContent, /not known/);
});

// ============================================================ B5: card modes

test('card modes: one list, one table; rejecting an applied edit is refused until it is reverted', async t => {
  const CM = (await import(path.join(ENGINE, 'assets', 'card-modes.js'))).default;
  assert.deepEqual([...CM.CARD_MODES], ['pending', 'accepted', 'rejected', 'flagged', 'applied', 'committed']);
  assert.equal(CM.canMove('applied', 'rejected'), false);
  assert.equal(CM.canMove('committed', 'pending'), false);
  assert.equal(CM.decisionAllowed('applied', 'accepted'), true, 'accepting an applied card is a harmless no-op');
  assert.equal(CM.decisionAllowed('applied', 'pending'), false);

  const dir = paper('modes-engine');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const eng = await engineFor(dir);
  eng.syncDecisions({ c1: 'accepted' });
  assert.deepEqual(eng.apply(['c1']).applied, ['c1']);
  const sync = eng.syncDecisions({ c1: 'rejected' });
  assert.equal(sync.refused.length, 1);
  assert.match(sync.refused[0].reason, /revert the round before rejecting it/);
  assert.equal(eng.publicLedger().cards.c1.mode, 'applied', 'the refused move left it as it was');
  // commit re-checks what people decided, whatever the mode says
  const head = gitLog(dir).length;
  const c = eng.commit({ decisions: { c1: 'rejected' } });
  assert.equal(c.ok, false);
  assert.match(c.reason, /rejected or reset after being applied\. Revert the round/);
  assert.equal(gitLog(dir).length, head, 'nothing reached git');
  // revert, and the rejection can now land
  assert.equal(eng.revert().ok, true);
  assert.equal(eng.publicLedger().cards.c1.mode, 'accepted');
  eng.syncDecisions({ c1: 'rejected' });
  assert.equal(eng.publicLedger().cards.c1.mode, 'rejected');
  assert.match(eng.apply(['c1']).skipped[0].reason, /rejected/);
});

test('card modes, end to end: accept → apply → reject leaves the edit out of git', async t => {
  const dir = paper('modes-server');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await withServer(dir, async ({ call }) => {
    const me = (await call('/whoami')).json.handle;
    const decide = status => call('/state', { decisions: { c1: { status } } });
    assert.equal((await decide('accepted')).status, 200);
    assert.equal((await call('/data')).json.apply.cards.c1.mode, 'accepted');
    const ap = await call('/apply', { ids: ['c1'] });
    assert.deepEqual(ap.json.applied, ['c1']);
    // the failing order: reject after apply
    assert.equal((await decide('rejected')).status, 200);
    const data = (await call('/data')).json;
    assert.equal(data.apply.cards.c1.mode, 'applied', 'still applied — the page draws REJECTED nowhere');
    const head = gitLog(dir).length;
    const c = await call('/commit', {});
    assert.equal(c.json.ok, false);
    assert.match(c.json.reason, /rejected or reset after being applied/);
    assert.equal(gitLog(dir).length, head, 'the rejected edit did not land in git');
    assert.ok(me, 'server identified the owner');
  });
});

test('card modes on the page: buttons whose move is refused are greyed out (happy-dom)', needsHappy, async t => {
  const pg = await page(t, {
    data: { apply: { cards: { s1: { mode: 'applied' } }, round: { ids: ['s1'], files: ['main.tex'] } } },
  });
  pg.R.cardMode('s1');
  assert.equal(pg.R.cardMode('s1'), 'applied');
  pg.focus('s1');
  const card = pg.doc.querySelector('.card[data-id="s1"]');
  assert.match(card.querySelector('.state').textContent, /ACCEPTED/);
  assert.match(card.querySelector('.state').textContent, /applied, uncommitted/);
  assert.equal(card.querySelector('[data-act="rejected"]').disabled, true, 'reject is greyed out');
  assert.equal(card.querySelector('[data-act="pending"]').disabled, true, 'so is reset');
  assert.equal(card.querySelector('[data-act="accepted"]').disabled, false);
  assert.equal(pg.R.setCardMode('s1', 'rejected'), false, 'and the move itself is refused');
  assert.equal(pg.R.cardMode('s1'), 'applied');
  assert.match(pg.toasts(), /Revert the round first/);
});

// ==================================================== B4: write-back reads

test('server: an unreadable user, grants or queue file is refused, never written over', async t => {
  const dir = paper('server-unreadable');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await withServer(dir, async ({ call }) => {
    const me = (await call('/whoami')).json.handle;
    const userFile = path.join(dir, 'review', 'state', 'users', `${me.replace(/[^\w-]/g, '_')}.json`);
    fs.writeFileSync(userFile, '{"handle": "me", "decisions": {"x": ');
    const st = await call('/state', { decisions: { c1: { status: 'accepted' } } });
    assert.equal(st.status, 409);
    assert.match(st.json.error, /could not be read, so nothing was changed/);
    assert.equal(fs.readFileSync(userFile, 'utf8'), '{"handle": "me", "decisions": {"x": ');

    const grants = path.join(dir, 'review', 'state', 'grants.json');
    fs.writeFileSync(grants, '{"ada": {"agents": tru');
    const g = await call('/grants', { handle: 'bob', agents: true });
    assert.equal(g.status, 409);
    assert.equal(fs.readFileSync(grants, 'utf8'), '{"ada": {"agents": tru');

    const queue = path.join(dir, 'review', 'state', 'pending-mentions.json');
    fs.writeFileSync(queue, '[{"mention_id": "m1"');
    const rel = await call('/release', {});
    assert.equal(rel.json.ok, false);
    assert.match(rel.json.error, /could not be read/);
    assert.equal(fs.readFileSync(queue, 'utf8'), '[{"mention_id": "m1"');
  });
});

// ===================================================== B7: release honesty

test('release: requests the agents did not take stay waiting, and the answer counts both', async t => {
  const dir = paper('release');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queue = path.join(dir, 'review', 'state', 'pending-mentions.json');
  // an old-format queue (no state field) — read as waiting
  fs.writeFileSync(queue, JSON.stringify([
    { mention_id: 'm1', target_id: 'c1', author: 'ada', text: '@claude look' },
    { mention_id: 'm2', target_id: 'c2', author: 'bob', text: '@codex look' },
  ]));
  // no --chat: the agents are not running, so every submit fails
  await withServer(dir, async ({ call }) => {
    const r = await call('/release', {});
    assert.equal(r.json.ok, true);
    assert.equal(r.json.released, 0);
    assert.equal(r.json.waiting, 2);
    assert.match(r.json.results[0].reason, /agents are not running/);
    const left = JSON.parse(fs.readFileSync(queue, 'utf8'));
    assert.deepEqual(left.map(m => m.mention_id), ['m1', 'm2'], 'nothing was lost');
    assert.ok(left.every(m => m.state === 'waiting'));
    assert.equal((await call('/data')).json.pending_mentions.length, 2, 'the owner still sees both');
  });
});

test('release on the page: the message says how many went and how many still wait (happy-dom)', needsHappy, async t => {
  const pg = await page(t, {
    data: { hosted: true, pending_mentions: [{ mention_id: 'm1' }, { mention_id: 'm2' }] },
    routes: { '/release': () => ({ ok: true, released: 1, refused: 0, waiting: 1, results: [
      { mention_id: 'm1', state: 'released' },
      { mention_id: 'm2', state: 'waiting', reason: 'the agents are not running' }] }) },
  });
  pg.openConsole();
  const btn = pg.doc.getElementById('release-pending');
  assert.match(btn.textContent, /Release 2/);
  btn.click();
  await pg.tick();
  assert.match(pg.toasts(), /Sent 1 request to the agents\. 1 could not be sent and is still waiting \(the agents are not running\)\./);
  assert.match(pg.doc.getElementById('release-pending').textContent, /Release 1/, 'the one left is still offered');
});

// ===================================================== B10: failed clicks

test('a failed click says so and gives the button back; skipped cards are redrawn (happy-dom)', needsHappy, async t => {
  const pg = await page(t, {
    data: { apply: { cards: { s1: { mode: 'applied' } }, round: { ids: ['s1'], files: ['main.tex'] } } },
    routes: {
      '/commit': () => { throw new TypeError('Failed to fetch'); },
      '/apply': () => ({ ok: true, applied: [], flagged: [], skipped: [{ id: 's1', reason: 'already applied' }] }),
    },
  });
  pg.openConsole();
  const btn = pg.doc.getElementById('commit-round');
  btn.click();
  assert.equal(btn.disabled, true, 'greyed while the request is out');
  await pg.tick();
  assert.match(pg.toasts(), /did not answer.*Reload the page to check/);
  assert.equal(btn.disabled, false, 'and back once it failed');

  pg.R.doApply(['s1']);
  await pg.tick();
  assert.equal(pg.R.activityOf('s1').msg, 'not applied: already applied', 'not "applying…" forever');
});

test('an agent permission answer that fails to send keeps its buttons and says so (happy-dom)', needsHappy, async t => {
  let fail = true;
  const pg = await page(t, { routes: { '/permission': () => { if (fail) throw new TypeError('Failed to fetch'); return { ok: true }; } } });
  pg.R.chatEvent({ kind: 'permission', target_id: null, ev: { type: 'permission_request', model: 'claude', reason: 'write', path: 'x.tex' } });
  const allow = () => pg.doc.querySelector('#toasts [data-perm="allow"]');
  assert.ok(allow(), 'the question is on screen');
  allow().click();
  await pg.tick();
  assert.ok(allow(), 'still there to try again');
  assert.equal(allow().disabled, false);
  assert.match(pg.toasts(), /did not reach the agents/);
  fail = false;
  allow().click();
  await pg.tick();
  assert.equal(allow(), null, 'answered: the question goes away');
});

// ===================================================== B11: connection mode

test('connection: a failed retry falls back, and the main feed takes over again when it returns (happy-dom)', needsHappy, async t => {
  const pg = await page(t, {});
  const conn = () => pg.doc.querySelector('#presence .conn').textContent;
  assert.equal(pg.R.link, 'connecting');
  assert.match(conn(), /live/, 'connecting looks as it always did');
  pg.sockets[0].open();
  assert.equal(pg.R.link, 'live');
  // the server restarts: the feed drops, and the first retry cannot connect
  pg.sockets[0].close();
  assert.equal(pg.R.link, 'retrying');
  assert.match(conn(), /reconnecting/);
  await new Promise(r => setTimeout(r, 2100));
  assert.equal(pg.sockets.length, 2, 'the main feed was retried');
  pg.sockets[1].close();                       // never opened
  assert.equal(pg.feeds.length, 1, 'the backup feed started');
  // through a buffering tunnel the backup feed "opens" and delivers nothing:
  // that must not read as live
  assert.notEqual(pg.R.link, 'fallback');
  assert.doesNotMatch(conn(), /● live/);
  // when the backup feed really delivers, it is live on the fallback
  pg.feeds[0].message('{"type":"hello"}');
  assert.equal(pg.R.link, 'fallback');
  // and the main feed is tried again, and wins
  await new Promise(r => setTimeout(r, 4100));
  assert.equal(pg.sockets.length, 3, 'still retrying the main feed while on the fallback');
  pg.sockets[2].open();
  assert.equal(pg.R.link, 'live');
  assert.equal(pg.feeds[0].closed, true, 'the backup feed was let go');
});

test('connection: a backup feed that never delivers is never shown as live (happy-dom)', needsHappy, async t => {
  const pg = await page(t, {});
  const conn = () => pg.doc.querySelector('#presence .conn').textContent;
  pg.sockets[0].close();                       // the main feed is blocked from the start
  assert.equal(pg.feeds.length, 1);
  assert.equal(pg.R.link, 'retrying');
  assert.match(conn(), /reconnecting/, 'not "live" while nothing has arrived');
  pg.feeds[0].message('{"type":"hello"}');
  assert.equal(pg.R.link, 'fallback');
  assert.match(conn(), /● live/);
});

// ================================================= working chip (2026-11-11)

test('working chip: two turns back to back on one card keep it on across the gap (happy-dom)', needsHappy, async t => {
  const pg = await page(t, {});
  const glow = () => pg.doc.querySelector('.card[data-id="s1"]').classList.contains('working');
  pg.R.chatEvent({ kind: 'turn-start', target_id: 's1', mention_id: 'm1' });
  assert.equal(pg.R.chipMode('s1'), 'working');
  assert.ok(glow());
  // the bridge ends turn 1 and starts turn 2 on the same card in one breath;
  // turn 1's reply fetch answers only after turn 2 has begun
  pg.R.chatEvent({ kind: 'turn-end', target_id: 's1', mention_id: 'm1' });
  assert.equal(pg.R.chipMode('s1'), 'landing', 'still on in the gap');
  pg.R.chatEvent({ kind: 'turn-start', target_id: 's1', mention_id: 'm2' });
  await pg.tick();
  assert.equal(pg.R.chipMode('s1'), 'working', 'the late fetch does not say "replied" over turn 2');
  assert.match(pg.R.activityOf('s1').msg, /agents are working/);
  assert.ok(glow());
  // a stray move from an earlier turn is refused, not applied
  assert.equal(pg.R.setChip('s1', 'off'), false);
  assert.equal(pg.R.setChip('s1', 'replied', 'replied ✓'), false);
  assert.equal(pg.R.chipMode('s1'), 'working');
  // turn 2 ends: replied, and off only after that
  pg.R.chatEvent({ kind: 'turn-end', target_id: 's1', mention_id: 'm2' });
  await pg.tick();
  assert.equal(pg.R.chipMode('s1'), 'replied');
  assert.ok(!glow(), 'nothing running or waiting: the glow is off');
});

test('working chip: a queued answer arriving after the turn started does not downgrade it (happy-dom)', needsHappy, async t => {
  const pg = await page(t, {});
  assert.deepEqual([...pg.R.CHIP_MODES], ['off', 'sending', 'waiting', 'working', 'landing', 'replied', 'note', 'failed']);
  assert.equal(pg.R.setChip('s1', 'sending', 'sending to agents…'), true);
  pg.R.chatEvent({ kind: 'turn-start', target_id: 's1', mention_id: 'm1' });
  assert.equal(pg.R.setChip('s1', 'waiting', 'queued — waiting for agents'), false);
  assert.equal(pg.R.chipMode('s1'), 'working');
  // the "replied" line fades by itself, and only from replied
  pg.R.chatEvent({ kind: 'turn-end', target_id: 's1', mention_id: 'm1' });
  await pg.tick();
  assert.equal(pg.R.chipMode('s1'), 'replied');
  assert.equal(pg.R.setChip('s1', 'off'), true);
  assert.equal(pg.R.chipMode('s1'), 'off');
});

// ======================================================== B8, B9: processes

test('every git / pandoc / build call in the engine carries a time limit', () => {
  for (const f of ['apply.mjs', 'server.mjs', 'build.mjs']) {
    const src = fs.readFileSync(path.join(ENGINE, f), 'utf8');
    const calls = src.split('execFileSync(').slice(1);
    for (const c of calls) {
      const call = c.slice(0, c.indexOf(');') + 1);
      assert.match(call, /timeout/, `${f}: execFileSync(${call.slice(0, 80)} has no time limit`);
    }
  }
});

test('a timed-out child process is reported in plain words', async () => {
  const { execFailure } = await import(path.join(ENGINE, 'apply.mjs'));
  let err;
  try { execFileSync('sleep', ['5'], { timeout: 200 }); } catch (e) { err = e; }
  assert.equal(execFailure(err, 'git commit', 30000), 'git commit took longer than 30 seconds and was stopped');
});

test('an unexpected error in the server is logged with its stack, and the server keeps serving', async t => {
  const dir = paper('uncaught');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boom = path.join(dir, 'boom.mjs');
  fs.writeFileSync(boom, "setTimeout(() => { throw new Error('boom-for-the-test'); }, 300);\n");
  await withServer(dir, async ({ call, proc, output }) => {
    await new Promise(r => setTimeout(r, 900));
    assert.equal(proc.exitCode, null, 'still running');
    assert.match(output(), /unexpected error, still serving:\nError: boom-for-the-test\n\s+at /);
    assert.equal((await call('/whoami')).status, 200);
  }, [], { NODE_OPTIONS: `--import=${boom}` });
});

test('a bot process that has gone away does not take the server down when written to', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-modes-chat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  // a bridge that dies without reading what it was sent: the writes queued
  // for it fail with EPIPE once it is gone
  fs.writeFileSync(path.join(root, 'core', 'botference_ink_bridge.py'), 'import sys, time\ntime.sleep(0.4)\nsys.exit(0)\n');
  fs.writeFileSync(path.join(root, 'project.json'), '{}');
  const rd = path.join(root, 'review');
  fs.mkdirSync(path.join(rd, 'state'), { recursive: true });
  fs.copyFileSync(path.join(ENGINE, 'chat.mjs'), path.join(rd, 'chat.mjs'));
  const script = path.join(root, 'drive.mjs');
  fs.writeFileSync(script, `
import { BridgeChat } from ${JSON.stringify(path.join(rd, 'chat.mjs'))};
const chat = new BridgeChat({ reviewDir: ${JSON.stringify(rd)}, cfg: {}, onEvent: () => {} });
chat.start();
setTimeout(() => { for (let i = 0; i < 5; i++) chat.send({ type: 'turn', text: 'x'.repeat(200000) }); }, 50);
chat.proc.on('exit', () => setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 500));
`);
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, BOTFERENCE_HOME: root, BOTFERENCE_PROJECT_ROOT: root },
  });
  assert.match(r.stdout, /SURVIVED/, `the process died: ${r.stderr.slice(0, 600)}`);
});

test('the link to the bots is one named mode: starting → idle → busy → idle → gone', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-modes-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  // a bridge that is ready, answers one turn, then exits
  fs.writeFileSync(path.join(root, 'core', 'botference_ink_bridge.py'), [
    'import sys, json, time',
    'print(json.dumps({"type": "ready"}), flush=True)',
    'sys.stdin.readline()',
    'time.sleep(0.2)',
    'print(json.dumps({"type": "ready"}), flush=True)',
    'time.sleep(0.3)',
    'sys.exit(0)',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'project.json'), '{}');
  const rd = path.join(root, 'review');
  fs.mkdirSync(path.join(rd, 'state'), { recursive: true });
  fs.copyFileSync(path.join(ENGINE, 'chat.mjs'), path.join(rd, 'chat.mjs'));
  const script = path.join(root, 'drive.mjs');
  fs.writeFileSync(script, `
import { BridgeChat, LINK_STATES } from ${JSON.stringify(path.join(rd, 'chat.mjs'))};
const seen = [];
const chat = new BridgeChat({ reviewDir: ${JSON.stringify(rd)}, cfg: {}, onEvent: ev => {
  if (ev.kind === 'turn-start' || ev.kind === 'turn-end' || ev.kind === 'bridge-exit') seen.push(ev.kind + ':' + chat.link);
} });
const out = { states: LINK_STATES, before: chat.link, beforeAvailable: chat.available };
chat.start();
out.started = chat.link;
const wait = (cond) => new Promise(r => { const i = setInterval(() => { if (cond()) { clearInterval(i); r(); } }, 20); });
await wait(() => chat.link === 'idle');
out.idleReady = chat.ready;
chat.submit({ mention_id: 'm1', target_id: 'c1', author: 'ada', text: '@claude hi' });
out.afterSubmit = chat.link;
await wait(() => chat.link === 'gone');
out.goneAvailable = chat.available;
out.refused = chat.setLink('idle');
out.afterRefused = chat.link;
out.submitWhenGone = chat.submit({ mention_id: 'm2', target_id: 'c1', author: 'ada', text: '@claude again' });
out.seen = seen;
console.log(JSON.stringify(out));
process.exit(0);
`);
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, BOTFERENCE_HOME: root, BOTFERENCE_PROJECT_ROOT: root },
  });
  const out = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
  assert.deepEqual(out.states, ['off', 'starting', 'idle', 'busy', 'gone'], r.stderr.slice(0, 600));
  assert.equal(out.before, 'off');
  assert.equal(out.beforeAvailable, false);
  assert.equal(out.started, 'starting');
  assert.equal(out.idleReady, true);
  assert.equal(out.afterSubmit, 'busy');
  assert.deepEqual(out.seen, ['turn-start:busy', 'turn-end:idle', 'bridge-exit:gone']);
  assert.equal(out.goneAvailable, false);
  assert.equal(out.refused, false, 'nothing leaves gone');
  assert.equal(out.afterRefused, 'gone');
  assert.equal(out.submitWhenGone.queued, false);
});

// ---------------------------------------------------------------- the page

const PAGE_TEX = `\\documentclass{article}
\\title{Modes Fixture}
\\begin{document}
\\maketitle
\\begin{abstract}
We study modes in a small paper.
\\end{abstract}
\\section{Introduction}
Opening text.
\\end{document}
`;
let builtPage = null;
function buildPage() {
  if (builtPage) return builtPage;
  const dir = scaffold('page', { 'main.tex': PAGE_TEX });
  execFileSync(process.execPath, [DETECT, dir], { encoding: 'utf8' });
  installEngine(dir);
  const r = spawnSync(process.execPath, [path.join(dir, 'review', 'build.mjs')], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });
  const site = path.join(dir, 'review', 'site');
  const first = fs.readdirSync(site).filter(f => f.endsWith('.html') && f !== 'index.html').sort()[0];
  builtPage = {
    dir,
    html: fs.readFileSync(path.join(site, first), 'utf8'),
    js: ['card-modes.js', 'review.js'].map(f => fs.readFileSync(path.join(dir, 'review', 'site', 'assets', f), 'utf8')),
  };
  return builtPage;
}

// review.js running LIVE in happy-dom against a stubbed server: `data` is
// merged into /data; `routes` answer POSTs (a throw = the server unreachable)
async function page(t, { data = {}, routes = {} }) {
  const { html, js } = buildPage();
  const { GlobalWindow } = await import('happy-dom');
  const vm = await import('node:vm');
  const w = new GlobalWindow({ url: 'http://localhost/00-abstract.html', width: 1280, height: 900 });
  t.after(() => w.happyDOM.close());
  const doc = w.document;
  doc.write(html.replace(/<script[^>]*src=[^>]*>\s*<\/script>/g, ''));
  const slug = doc.body.getAttribute('data-slug');
  if (!w.CSS || !w.CSS.escape) w.CSS = { escape: s => String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch) };
  w.matchMedia = q => ({ matches: false, media: q, addEventListener() { }, removeEventListener() { } });
  w.SUGGESTIONS = [{ id: 's1', type: 'rewrite', section: slug, author: 'claude', current_text: 'small paper',
    proposed_text: 'tiny paper', source_file: 'main.tex', rationale: 'brevity' }];
  w.BUILD_META = { slug: 'modes-fixture' };
  const body = { me: 'ada', hosted: false, owner: true, owner_handle: 'ada', users: { ada: {} }, threads: {},
    suggestions: w.SUGGESTIONS, apply: { cards: {}, round: null }, chat: true, ...data };
  w.fetch = async (url, opts) => {
    const u = String(url);
    if (routes[u]) {
      const out = routes[u](opts);   // may throw: the server could not be reached
      return { ok: true, status: 200, json: async () => out };
    }
    return { ok: true, status: 200, json: async () => (u === '/data' ? body : { ok: true }) };
  };
  const sockets = [], feeds = [];
  w.WebSocket = class {
    constructor() { sockets.push(this); }
    open() { this.onopen && this.onopen(); }
    close() { this.onclose && this.onclose(); }
    send() { }
  };
  w.EventSource = class {
    constructor() { feeds.push(this); this.closed = false; }
    message(data) { this.onmessage && this.onmessage({ data }); }
    close() { this.closed = true; }
  };
  vm.createContext(w);
  for (const src of js) vm.runInContext(src, w);
  const tick = () => new Promise(r => setTimeout(r, 30));
  await tick();
  const R = w.__review;
  return {
    w, doc, R, sockets, feeds, tick,
    toasts: () => [...doc.querySelectorAll('#toasts .toast')].map(n => n.textContent).join(' | '),
    focus: id => { doc.querySelector(`.card[data-id="${id}"]`).click(); },
    openConsole: () => { const b = doc.getElementById('tc-toggle-btn'); if (!doc.getElementById('apply-bar').innerHTML) b.click(); },
  };
}

// ============================== a question the bots put to the owner (ask status)
// The two-minute auto-refusal used to be a bare timer racing the owner's click:
// a late answer was still sent to the bots after the refusal had gone. Now
// each question has one status (ASK_STATES) changed only through setAsk(), and
// whichever of "answer" / "time limit" comes first wins.
async function askChat(t, timeoutMs = 40) {
  const { BridgeChat, ASK_STATES, ASK_MOVES } = await import(path.join(ENGINE, 'chat.mjs'));
  const rd = fs.mkdtempSync(path.join(os.tmpdir(), 'review-modes-ask-'));
  t.after(() => fs.rmSync(rd, { recursive: true, force: true }));
  const events = [], sent = [];
  const chat = new BridgeChat({ reviewDir: rd, cfg: {}, onEvent: ev => events.push(ev), askTimeoutMs: timeoutMs });
  chat.proc = { stdin: { write: line => sent.push(JSON.parse(line)) } };
  t.after(() => { for (const k of ['permission', 'choice']) clearTimeout(chat.asks[k].timer); });
  return { chat, events, sent, ASK_STATES, ASK_MOVES, wait: ms => new Promise(r => setTimeout(r, ms)) };
}

test('ask status: the move table — legal moves made, illegal ones refused', async t => {
  const { chat, ASK_STATES, ASK_MOVES } = await askChat(t, 10000);
  assert.deepEqual(ASK_STATES, ['none', 'asked', 'answered', 'timed-out', 'withdrawn']);
  for (const from of ASK_STATES) for (const to of ASK_STATES) {
    chat.asks.permission = { status: from, seq: 0, timer: null };
    const ok = chat.setAsk('permission', to);
    assert.equal(ok, ASK_MOVES[from].includes(to), `${from} -> ${to}`);
    assert.equal(chat.asks.permission.status, ok ? to : from);
    clearTimeout(chat.asks.permission.timer);
  }
  assert.equal(chat.setAsk('permission', 'bogus'), false);
  assert.equal(chat.setAsk('nonsense', 'asked'), false);
});

test('ask status: answer first, then the time limit — the answer stands, no refusal is sent', async t => {
  const { chat, events, sent, wait } = await askChat(t);
  chat.handle({ type: 'permission_request', model: 'claude', reason: 'write', path: 'x.tex' });
  assert.equal(chat.asks.permission.status, 'asked');
  assert.deepEqual(chat.answerPermission({ type: 'permission_response', allow: true }), { ok: true });
  await wait(100);
  assert.equal(chat.asks.permission.status, 'answered');
  assert.deepEqual(sent, [{ type: 'permission_response', allow: true }]);
  assert.equal(events.filter(e => e.kind === 'permission-timeout').length, 0);
});

test('ask status: time limit first, then a late answer — refused in plain words, never sent', async t => {
  const { chat, events, sent, wait } = await askChat(t);
  chat.handle({ type: 'choice_request', prompt: 'which?', options: ['a', 'b'] });
  await wait(100);
  assert.equal(chat.asks.choice.status, 'timed-out');
  assert.deepEqual(sent, [{ type: 'choice_response', index: null }]);
  assert.equal(events.filter(e => e.kind === 'choice-timeout').length, 1);
  const late = chat.answerChoice({ type: 'choice_response', index: 0 });
  assert.equal(late.ok, false);
  assert.match(late.reason, /Too late/);
  assert.equal(chat.asks.choice.status, 'timed-out');
  assert.equal(sent.length, 1, 'the late answer never reached the bots');
});

test('ask status: a withdrawn or replaced question cannot time out, and a second answer is refused', async t => {
  const { chat, events, sent, wait } = await askChat(t);
  chat.handle({ type: 'permission_request', model: 'claude' });
  chat.handle({ type: 'permission_cleared' });
  assert.equal(chat.asks.permission.status, 'withdrawn');
  chat.handle({ type: 'choice_request', prompt: 'p', options: ['a'] });
  chat.handle({ type: 'choice_request', prompt: 'q', options: ['b'] }); // replaces the first
  assert.deepEqual(chat.answerChoice({ type: 'choice_response', index: 0 }), { ok: true });
  assert.equal(chat.answerChoice({ type: 'choice_response', index: 0 }).ok, false, 'already answered');
  await wait(100);
  assert.equal(events.filter(e => /-timeout$/.test(e.kind)).length, 0, 'no stale timer fired');
  assert.deepEqual(sent, [{ type: 'choice_response', index: 0 }]);
  assert.equal(chat.answerPermission({ type: 'permission_response', allow: true }).ok, false);
});

test('a question that timed out leaves the page, and a late click says why (happy-dom)', needsHappy, async t => {
  const pg = await page(t, { routes: { '/permission': () => ({ ok: false, reason: 'Too late: nobody answered within two minutes, so it was turned down automatically.' }) } });
  const ask = () => pg.R.chatEvent({ kind: 'permission', target_id: null, ev: { type: 'permission_request', model: 'claude', reason: 'write', path: 'x.tex' } });
  const allow = () => pg.doc.querySelector('#toasts [data-perm="allow"]');
  ask();
  assert.ok(allow());
  pg.R.chatEvent({ kind: 'permission-timeout', target_id: null });
  assert.equal(allow(), null, 'no buttons left for a closed question');
  ask();
  allow().click();
  await pg.tick();
  assert.equal(allow(), null);
  assert.match(pg.toasts(), /Too late/);
});

// ============================== are the agents attached? (chat mode)
test('chat mode: unknown → on/off, on ↔ off, never back to unknown (happy-dom)', needsHappy, async t => {
  const pg = await page(t, { data: { chat: undefined } });
  const R = pg.R;
  assert.deepEqual([...R.CHAT_MODES], ['unknown', 'on', 'off']);
  assert.equal(R.PRESENCE.chat, 'unknown', 'a server that does not say');
  assert.match(pg.doc.querySelector('#presence .chatmode').textContent, /agents: —/);
  assert.equal(R.setChatMode(true), false, 'a yes/no is not a mode name');
  assert.equal(R.setChatMode('on'), true);
  assert.match(pg.doc.querySelector('#presence .chatmode').textContent, /agents: on/);
  assert.equal(R.setChatMode('unknown'), false, 'once known, never unknown again');
  R.chatEvent({ kind: 'bridge-exit', code: 1 });
  assert.equal(R.PRESENCE.chat, 'off');
  assert.match(pg.doc.querySelector('#presence .chatmode').textContent, /agents: off/);
  R.chatEvent({ kind: 'meta', type: 'x' });
  assert.equal(R.PRESENCE.chat, 'on', 'any event from the agents proves they are back');
});
