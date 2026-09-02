#!/usr/bin/env node
// THE REVIEW'S DECISION LOG.
//
// Editing a long manuscript, decisions pile up across threads: a phrasing
// settled on page 2, a deletion agreed on page 5. A bot answering a comment on
// page 9 sees its own thread and the marks beside its own quote — so it
// proposes wording that contradicts what was decided an hour ago, and the
// reader is the only one who can notice.
//
// The fix is the idiom this companion already has for anything too big to
// inline (the page snapshot, the page images): write it to disk, name the path
// on the turn. This suite pins both halves — the file (what it says, when it is
// rewritten, that it is atomic and dies with the page) and the envelope (which
// turns name it, and which must not).
//
//   node frontends/plugin/test/decisions.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHarness, sleep, enc, inputs, GET, POST,
} from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

// The scaffolding — runner, poller, throwaway root, a companion on a random
// port, JSON over HTTP — is test/harness.mjs, shared with the other suites that
// drive a real server. It was a private copy here, as it was in eight other
// files.
const {
  test, waitFor, tmp, startServer, cleanup, passed, failures,
} = createHarness({ server: SERVER, tag: 'decisions', realpath: true, env: { PLUGIN_BRIDGE_POOL: '1' } });


// store.mjs fixes its ROOT at import time: point THIS process at a throwaway
// before importing it, so nothing here can touch the developer's own workspace.
const OWN = tmp('own-store');
process.env.BOTFERENCE_PROJECT_ROOT = OWN;
const store = await import(path.join(PLUGIN, 'store.mjs'));
const chat = await import(path.join(PLUGIN, 'chat.mjs'));

// ---------------------------------------------------------------------------
// A review with every state in it. Built by hand rather than through the
// server, because the point of a pure log is that it is a function of the
// record and of nothing else.
const ts = n => `2026-08-2${n}T10:00:00.000Z`;
const th = (id, quote, extra = {}) => ({
  id, quote, prefix: '', suffix: '', orphaned: false,
  msgs: [{ author: 'angadh', ts: ts(1), text: 'what about this?' }],
  ...extra,
});
const zoo = () => {
  const open = th('t-open', 'the tumbling debris field', { page: 9 });
  open.msgs.push({ author: 'claude', ts: ts(9), text: 'I would keep it, but tighten the clause.' });

  const struck = th('t-struck', 'nflatable-arm literature', { page: 3, mark: 'strike' });
  struck.msgs = [{ author: 'angadh', ts: ts(3),
    text: 'replace with: "The inflatable-arm literature is thin."' }];

  const child = th('t-child', 'and adds nothing to it', {
    page: 5, mark: 'strike', from_thread: 't-open',
  });
  child.msgs = [{ author: 'angadh', ts: ts(5), text: 'cut: the sentence repeats section 2' }];

  const filed = th('t-filed', 'the radiator area was sized for', {
    page: 2, resolved: true, resolved_at: ts(2), summary: 'Settled: the area stays, the citation goes.',
  });

  const gone = th('t-gone', 'the block that was deleted', {
    page: 4, deleted_passage: true, healed_at: ts(4),
  });

  const card = th('t-card', 'a paragraph of the draft', { page: 6 });
  card.msgs.push({ author: 'claude', ts: ts(6), text: 'here is a rewrite',
    suggestions: [{ id: 'c-1', state: 'open', current: 'a', proposed: 'b' }] });

  const chip = th('t-chip', 'a sentence a bot wants gone', { page: 7 });
  chip.msgs.push({ author: 'codex', ts: ts(7), text: 'this should go',
    strikes: [{ why: 'it repeats section 2' }] });

  return { url: 'https://example.org/manuscript.pdf', title: 'Adriana manuscript v4',
    threads: [open, struck, child, filed, gone, card, chip], page_chat: [] };
};

console.log('\ndecisions — the log itself');

await test('every state a decision can be in gets exactly one line, and says which', () => {
  const log = store.decisionLog(zoo());
  const rows = log.match(/^- .*$/gm) || [];
  assert.equal(rows.length, 7, 'one line per thread, and no line for anything else');
  const at = s => rows.find(r => r.includes(s));
  assert.match(at('tumbling debris'), /^- open · p9 · /);
  assert.match(at('tumbling debris'), /last — claude: I would keep it/);
  assert.match(at('nflatable-arm'), /^- struck · p3 · /);
  assert.match(at('nflatable-arm'), /note: replace with: "The inflatable-arm literature is thin\."/);
  assert.match(at('adds nothing'), /^- struck \(from a discussion\) · p5 · /);
  assert.match(at('radiator area'), /^- resolved · p2 · .* — Settled: the area stays/);
  assert.match(at('was deleted'), /^- deleted-passage · p4 · .* — the passage was deleted from the document/);
  assert.match(at('paragraph of the draft'), /^- suggestion pending · p6 · /);
  assert.match(at('a bot wants gone'), /^- suggestion pending · p7 · /);
});

await test('…newest decision first, whichever stamp made it the newest', () => {
  const rows = (store.decisionLog(zoo()).match(/^- .*$/gm) || []);
  const quoted = rows.map(r => (/"([^"]*)"/.exec(r) || [])[1]);
  assert.deepEqual(quoted, [
    'the tumbling debris field',      // a reply at ts(9)
    'a sentence a bot wants gone',    // ts(7)
    'a paragraph of the draft',       // ts(6)
    'and adds nothing to it',         // ts(5)
    'the block that was deleted',     // healed_at ts(4)
    'nflatable-arm literature',       // ts(3)
    'the radiator area was sized for', // resolved_at ts(2)
  ]);
});

await test('a struck thread with no note says so rather than saying nothing', () => {
  const page = zoo();
  page.threads.find(t => t.id === 't-struck').msgs[0].text = '';
  assert.match(store.decisionLog(page), /no note — the strikeout speaks for itself/);
});

await test('a filed thread with no summary falls back to the digest — and never to an agent', () => {
  const page = zoo();
  const t = page.threads.find(t => t.id === 't-filed');
  delete t.summary;
  t.msgs.push({ author: 'claude', ts: ts(2), text: 'The citation is wrong and should come out.' });
  const row = (store.decisionLog(page).match(/^- resolved.*$/m) || [''])[0];
  assert.match(row, /The citation is wrong and should come out\./,
    'store.threadDigest, mechanically: the last thing a bot concluded');
});

await test('the quote is clipped, and so is a replacement note that runs long', () => {
  const page = zoo();
  const t = page.threads.find(t => t.id === 't-struck');
  t.quote = 'x'.repeat(400);
  t.msgs[0].text = `replace with: "${'y'.repeat(400)}"`;
  const row = (store.decisionLog(page).match(/^- struck ·.*$/m) || [''])[0];
  assert.match(row, /x{79}…/, `the quote stops at ${store.DECISION_QUOTE_MAX}`);
  assert.ok(row.length < store.DECISION_QUOTE_MAX + store.DECISION_NOTE_MAX + 60,
    'one line stays one line');
});

await test('the header says how many, and what the words in the first column mean', () => {
  const log = store.decisionLog(zoo());
  assert.match(log, /^# Decisions on "Adriana manuscript v4"/);
  assert.match(log, /7 comment threads on this document, newest decision first/);
  for (const word of ['open', 'suggestion pending', 'struck', 'resolved', 'deleted-passage']) {
    assert.ok(log.includes(word), `the legend names ${word}`);
  }
});

await test('a thread with no words in it, or no passage, is not a decision', () => {
  const page = { url: 'https://x.test/a.pdf', title: 'A', threads: [
    th('t-a', 'a real passage'),
    { id: 't-empty', quote: 'never commented on', msgs: [] },
    th('t-noquote', ''),
  ] };
  assert.equal((store.decisionLog(page).match(/^- .*$/gm) || []).length, 1);
});

console.log('\ndecisions — the file on disk');

const decisionsOf = (root, url) => path.join(root, '.botference', 'plugin', 'snapshots',
  `${store.pageKey(url)}-decisions.md`);

await test('two threads write the log; one thread writes nothing at all', () => {
  const page = { url: 'https://own.test/one.pdf', title: 'One', threads: [th('t-1', 'a passage')] };
  assert.equal(store.writeDecisionLog(page), '', 'nothing to be inconsistent WITH');
  assert.equal(fs.existsSync(decisionsOf(OWN, page.url)), false);
  page.threads.push(th('t-2', 'another passage'));
  const file = store.writeDecisionLog(page);
  assert.equal(file, decisionsOf(OWN, page.url));
  assert.match(fs.readFileSync(file, 'utf8'), /another passage/);
});

await test('…and when the review shrinks back the file is REMOVED, never left stale', () => {
  const page = { url: 'https://own.test/one.pdf', title: 'One',
    threads: [th('t-1', 'a passage'), th('t-2', 'another passage')] };
  const file = store.writeDecisionLog(page);
  assert.ok(fs.existsSync(file));
  page.threads.pop();
  assert.equal(store.writeDecisionLog(page), '');
  assert.equal(fs.existsSync(file), false);
});

await test('an unchanged log is not rewritten, and a write leaves no temp file behind', () => {
  const page = { url: 'https://own.test/two.pdf', title: 'Two',
    threads: [th('t-1', 'a passage'), th('t-2', 'another passage')] };
  const file = store.writeDecisionLog(page);
  const was = fs.statSync(file).mtimeMs;
  store.writeDecisionLog(page);
  assert.equal(fs.statSync(file).mtimeMs, was, 'a serialization that did not move is not a write');
  const dir = path.dirname(file);
  assert.equal(fs.readdirSync(dir).some(n => n.includes('.tmp.')), false,
    'tmp-then-rename: a bot reading mid-write reads the old file, never half of either');
  store.setResolved(page.threads[0], true, 'angadh');
  store.writeDecisionLog(page);
  assert.match(fs.readFileSync(file, 'utf8'), /^- resolved/m, 'a decision DOES rewrite it');
});

await test('the log dies with the page', () => {
  const url = 'https://own.test/three.pdf';
  const page = store.blankPage({ url, title: 'Three' });
  page.threads = [th('t-1', 'a passage'), th('t-2', 'another passage')];
  store.savePage(page);
  const file = store.writeDecisionLog(page);
  assert.ok(fs.existsSync(file));
  store.deletePage(url);
  assert.equal(fs.existsSync(file), false);
});

await test('…and nothing else that walks the snapshots folder trips over it', () => {
  const url = 'https://own.test/four.pdf';
  const page = { url, title: 'Four', threads: [th('t-1', 'a'), th('t-2', 'b')] };
  store.savePage(store.blankPage({ url, title: 'Four' }));
  store.savePageImage(url, 1, Buffer.from('not really a png'));
  store.writeDecisionLog(page);
  assert.deepEqual(store.pageImagesOf(store.pageKey(url)), [1],
    'the page-image census counts pictures and never the log');
  assert.equal(store.hasSnapshot(store.pageKey(url)), false,
    'and the log is not mistaken for the reading text');
});

console.log('\ndecisions — the envelope');

{
  const LOG = '/tmp/x/abc-decisions.md';
  const base = { url: 'https://example.org/p.pdf', title: 'P', text: 'tighten this', history: [] };
  await test('a quote-bearing turn names the log, and says what to do when it conflicts', () => {
    const env = chat.envelope({ ...base, target: 't-1', quote: 'a passage', decisionPath: LOG });
    assert.match(env, /THE REVIEW'S DECISION LOG/);
    assert.ok(env.includes(LOG), 'named by absolute path, like the snapshot and the figures');
    assert.match(env, /READ IT before you propose any wording/);
    assert.match(env, /SAY SO/, 'the disagreement is the thing only the log can surface');
    assert.match(env, /rather than silently conforming/);
  });
  await test('…so does a page chat, which is about the document as a whole', () => {
    const env = chat.envelope({ ...base, target: store.PAGE_CHAT, quote: '', decisionPath: LOG });
    assert.match(env, /THE REVIEW'S DECISION LOG/);
    assert.ok(!/YOUR REMIT IS/.test(env), 'and it still carries no span rule: there is no quote');
  });
  await test('…and it rides beside the snapshot path, above the passage', () => {
    const env = chat.envelope({ ...base, target: 't-1', quote: 'a passage',
      snapshotPath: '/tmp/x/abc.html', decisionPath: LOG, first: true });
    assert.ok(env.indexOf('/tmp/x/abc.html') < env.indexOf(LOG));
    assert.ok(env.indexOf(LOG) < env.indexOf('The user highlighted this passage'));
  });
  await test('no path, no lines — a page with one comment on it is unchanged', () => {
    const env = chat.envelope({ ...base, target: 't-1', quote: 'a passage', decisionPath: '' });
    assert.ok(!/DECISION LOG/.test(env));
  });
  await test('…and neither the library nor a filing turn is ever handed one', () => {
    assert.ok(!/DECISION LOG/.test(chat.envelope({
      ...base, target: store.PAGE_CHAT, library: '/tmp/lib', decisionPath: LOG })));
    assert.ok(!/DECISION LOG/.test(chat.envelope({
      ...base, target: 't-1', quote: 'a passage', summary: true, decisionPath: LOG })),
    'a summary writes nothing into the document');
    assert.ok(!/DECISION LOG/.test(chat.envelope({
      ...base, target: 't-1', quote: 'a passage', card: true, decisionPath: LOG })),
    'and neither does a question for the vault');
  });
}

// ---------------------------------------------------------------------------
console.log('\ndecisions — end to end, over the real doors');
{
  const root = tmp('server');
  const logDir = tmp('logs');
  const log = path.join(logDir, 'bridge.jsonl');
  const { base } = await startServer({
    root,
    env: { PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]), MOCK_BRIDGE_LOG: log },
  });
  const PDF = 'https://example.org/manuscript-v4.pdf';
  const ONE = 'https://example.org/only-one-comment.pdf';
  await POST(base, '/page', { url: PDF, title: 'Manuscript v4', kind: 'pdf' });
  await POST(base, '/page', { url: ONE, title: 'One comment', kind: 'pdf' });
  const file = decisionsOf(root, PDF);
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const threadOn = async (url, quote, text, page = 0) =>
    (await POST(base, '/thread', { url, quote, page, msg: { text } })).json.thread;

  let t1 = null; let t2 = null;
  await test('a second comment brings the log into being, listing both', async () => {
    t1 = await threadOn(PDF, 'the radiator area was sized for', 'this mass looks wrong', 2);
    t2 = await threadOn(PDF, 'the tumbling debris field', 'is this still true?', 9);
    await waitFor(() => /radiator area/.test(read()) && /tumbling debris/.test(read()),
      'the log naming both threads');
    assert.match(read(), /^- open · p2 · /m);
  });

  await test('filing a thread rewrites it, without a bot turn anywhere', async () => {
    await POST(base, '/resolve', { url: PDF, thread_id: t1.id, resolved: true });
    await waitFor(() => /^- resolved · p2 · /m.test(read()), 'the filed thread saying so');
  });

  await test('a strikeout minted from a discussion lands in it, with its note', async () => {
    const r = await POST(base, '/strike-from', {
      url: PDF, thread_id: t2.id, note: 'replace with: "the debris field is stable"',
    });
    assert.equal(r.status, 200);
    await waitFor(() => /note: replace with: "the debris field is stable"/.test(read()),
      'the minted card');
    assert.match(read(), /^- struck \(from a discussion\) · p9/m);
  });

  await test('…and RENOTING it rewrites the same line rather than adding a second', async () => {
    await POST(base, '/strike-from', {
      url: PDF, thread_id: t2.id, note: 'replace with: "the debris field is not"',
    });
    await waitFor(() => /is not"/.test(read()), 'the corrected note');
    assert.equal((read().match(/^- struck/gm) || []).length, 1, 'one mark, one line');
  });

  await test('converting a thread in place moves its line too', async () => {
    const t = await threadOn(PDF, 'a passage that will be struck by hand', 'take it out', 4);
    await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'strike' });
    await waitFor(() => /^- struck · p4 · "a passage that will be struck by hand"/m.test(read()),
      'the converted thread');
  });

  await test('deleting a thread takes its decision out of the log', async () => {
    const t = await threadOn(PDF, 'a passage nobody will keep', 'never mind', 5);
    await waitFor(() => /nobody will keep/.test(read()), 'the new thread');
    await POST(base, '/delete', { url: PDF, thread_id: t.id });
    await waitFor(() => !/nobody will keep/.test(read()), 'the deleted thread leaving');
  });

  await test('the turn names the log, and only where there is one', async () => {
    fs.writeFileSync(log, '');
    await POST(base, '/reply', { url: PDF, thread_id: t2.id, text: '@claude what should this say?' });
    const env = await waitFor(() => inputs(log).find(x => /what should this say\?/.test(x)),
      'the envelope');
    assert.match(env, /THE REVIEW'S DECISION LOG/);
    assert.ok(env.includes(file), 'by absolute path');

    await threadOn(ONE, 'the only comment on this page', '@claude and this one?');
    const solo = await waitFor(() => inputs(log).find(x => /and this one\?/.test(x)), 'the envelope');
    assert.ok(!/DECISION LOG/.test(solo),
      'one thread: there is nothing on this page to be inconsistent with');
  });

  await test('…and the log the turn names is the CURRENT one, decided while it waited', async () => {
    fs.writeFileSync(log, '');
    await POST(base, '/thread', { url: ONE, quote: 'a second passage here', page: 2,
      msg: { text: '@claude and now?' } });
    const env = await waitFor(() => inputs(log).find(x => /and now\?/.test(x)), 'the envelope');
    assert.match(env, /THE REVIEW'S DECISION LOG/,
      'the second comment made the log, and this very turn already names it');
    const soloFile = decisionsOf(root, ONE);
    assert.match(fs.readFileSync(soloFile, 'utf8'), /a second passage here/);
  });

  await test('forgetting the page takes the log with it', async () => {
    assert.ok(fs.existsSync(file));
    await POST(base, '/delete-page', { url: PDF });
    assert.equal(fs.existsSync(file), false);
    const gone = (await GET(base, '/page?url=' + enc(PDF))).json;
    assert.equal(((gone && gone.threads) || []).length, 0, 'the record went with it');
  });
}

// ---------------------------------------------------------------------------
cleanup();
await sleep(150);

console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  - ${f}`); process.exit(1); }
