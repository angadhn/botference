#!/usr/bin/env node
// The strikethrough a DISCUSSION arrives at.
//
// A passage was highlighted, argued about, and the argument concluded it should
// come out. Until now the thread stayed an amber highlight and the only route
// to the red line was to delete the thread and draw the strikeout again, losing
// the conversation that reached the decision. Two doors close that gap, and they
// are deliberately not the same door:
//
//   POST /mark          the reader converts the thread they are looking at.
//                       One field, both directions, idempotent, nothing else on
//                       the record touched.
//   POST /strike-from   a bot suggested it (`strike: <reason>`) and the reader
//                       agreed. This MINTS A SECOND THREAD on the same passage,
//                       in the reader's name, carrying the reason and NOT ONE
//                       WORD of the conversation — so the discussion can be
//                       deleted afterwards and the person receiving the PDF gets
//                       a clean red line signed by a human.
//
// Fixtures in a temp dir, the mock bridge, no CLI, no network.
//
//   node frontends/plugin/test/strike.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const tmps = [];
function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-strike-${tag}-`));
  tmps.push(d);
  return fs.realpathSync(d);   // macOS /var vs /private/var — both sides, always
}

const spawned = [];
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-strike-secrets-'));
function startServer({ root, env = {} }) {
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: root,
      BOTFERENCE_SECRETS_DIR: SECRETS, PLUGIN_OWNER_PASSWORD: '', REVIEW_HUB_PASSWORD: '',
      PLUGIN_BRIDGE_POOL: '1', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(proc);
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  return waitFor(() => {
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    return m ? `http://127.0.0.1:${m[1]}` : null;
  }, `server to listen (got: ${out.slice(0, 300)})`).then(base => ({ proc, base, out: () => out }));
}
function request(base, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + urlPath, {
      method,
      headers: {
        ...(data === null ? {} : {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        }),
        ...headers,
      },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { }
        resolve({ status: res.statusCode, json, body: buf });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const GET = (b, p, h) => request(b, 'GET', p, undefined, h);
const POST = (b, p, body, h) => request(b, 'POST', p, body, h);
const enc = encodeURIComponent;
const inputs = file => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.type === 'input').map(e => String(e.text))
  : []);

// store.mjs fixes its ROOT at import time: point THIS process at a throwaway
// before importing it, so nothing here can touch the developer's own workspace.
process.env.BOTFERENCE_PROJECT_ROOT = tmp('own-store');
const store = await import(path.join(PLUGIN, 'store.mjs'));
const views = await import(path.join(PLUGIN, 'views.mjs'));
const Ann = createRequire(import.meta.url)(path.join(PLUGIN, 'extension', 'pdf', 'annots.js'));

// ---------------------------------------------------------------------------
console.log('\nstrike — the mark, changed after the fact');

await test('the mark flips both ways, and REVERTING leaves no key behind', () => {
  const page = { url: 'https://x.test/a.pdf', threads: [], page_chat: [] };
  const t = store.addThread(page, { quote: 'Long-term simulations', text: 'is this needed?', author: 'angadh' });
  assert.equal('mark' in t, false, 'an ordinary thread carries no mark at all');
  assert.equal(store.setThreadMark(t, 'strike'), true);
  assert.equal(t.mark, 'strike');
  assert.equal(store.markOf(t), 'strike');
  assert.equal(store.setThreadMark(t, 'highlight'), true);
  assert.equal('mark' in t, false,
    'a converted-and-reverted thread is byte-for-byte the record it was');
});

await test('…and setting the mark it already has moves nothing', () => {
  const page = { url: 'https://x.test/a.pdf', threads: [], page_chat: [] };
  const t = store.addThread(page, { quote: 'q', text: 'w', author: 'angadh' });
  assert.equal(store.setThreadMark(t, 'highlight'), false, 'already a highlight');
  store.setThreadMark(t, 'strike');
  assert.equal(store.setThreadMark(t, 'strike'), false, 'already struck');
});

await test('RETROACTIVITY: a thread written before any of this converts cleanly', () => {
  // exactly the shape store.addThread wrote before the mark existed — no
  // `mark`, no `origin`, no `page`, nothing to migrate
  const old = {
    id: 't-1700000000-abcd', quote: 'Long-term simulations', prefix: '', suffix: '',
    orphaned: false, msgs: [{ author: 'angadh', ts: '2025-11-14T09:00:00.000Z', text: 'why here?' }],
  };
  assert.equal(store.markOf(old), 'highlight');
  assert.equal(store.setThreadMark(old, 'strike'), true);
  assert.equal(old.mark, 'strike');
  assert.equal(old.msgs.length, 1, 'the conversation is untouched');
  assert.equal(old.quote, 'Long-term simulations', 'and so is the anchor');
});

console.log('\nstrike — a bot suggesting one');

await test('the offer names the convention, and the parse reads it back', () => {
  const block = store.strikeOfferBlock();
  assert.match(block, /strike:/);
  assert.match(block, /rarely/i, 'a bot that suggests one every turn is worse than none');
  assert.deepEqual(store.parseStrikeSuggestion('Yes.\nstrike: it repeats section 2'),
    { why: 'it repeats section 2', line: 'strike: it repeats section 2' });
});

await test('…only on a line of its own, and the LAST one counts', () => {
  assert.equal(store.parseStrikeSuggestion('you could strike: this if you liked'), null,
    'the marker mid-sentence is prose, not machinery');
  assert.equal(store.parseStrikeSuggestion('strike: first\nstrike: second').why, 'second');
  assert.equal(store.parseStrikeSuggestion('- `strike: it repeats section 2`').why,
    'it repeats section 2', 'markdown around the line does not hide it');
});

await test('…and a REASONLESS suggestion is no suggestion at all', () => {
  assert.equal(store.parseStrikeSuggestion('strike:'), null);
  assert.equal(store.parseStrikeSuggestion('strike:   '), null);
  assert.equal(store.parseStrikeSuggestion('nothing here'), null);
});

// ---------------------------------------------------------------------------
{
  const root = tmp('server');
  const logDir = tmp('logs');
  const log = path.join(logDir, 'bridge.jsonl');
  const { base } = await startServer({
    root,
    env: { PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]), MOCK_BRIDGE_LOG: log },
  });
  const PDF = 'https://example.org/adriana-manuscript-v4.pdf';
  const WEB = 'https://example.org/an-article';
  const QUOTE = 'Long-term simulations';

  await POST(base, '/page', { url: PDF, title: 'Adriana manuscript v4', kind: 'pdf' });
  await POST(base, '/page', { url: WEB, title: 'An article', kind: 'article' });

  const threadOn = async (url, quote, text) => {
    const r = await POST(base, '/thread', { url, quote, page: 7, msg: { text } });
    return r.json.thread;
  };
  const pageOf = async url => (await GET(base, '/page?url=' + enc(url))).json;

  console.log('\nstrike — POST /mark');

  await test('a discussed highlight becomes a strikethrough, in place', async () => {
    const t = await threadOn(PDF, QUOTE, 'do we still need this?');
    const r = await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'strike' });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, true);
    const page = await pageOf(PDF);
    const now = page.threads.find(x => x.id === t.id);
    assert.equal(now.mark, 'strike');
    assert.equal(now.quote, QUOTE, 'the anchor is not touched');
    assert.equal(now.page, 7, 'nor the page it sits on');
    assert.deepEqual(now.msgs.map(m => m.text), ['do we still need this?'],
      'nor one word of the conversation');
  });

  await test('…and it is idempotent: clicking twice is clicking once', async () => {
    const t = (await pageOf(PDF)).threads.find(x => x.mark === 'strike');
    const r = await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'strike' });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, false, 'nothing moved, so nothing was written');
  });

  await test('…and the reverse takes the key back off the record', async () => {
    const t = (await pageOf(PDF)).threads.find(x => x.mark === 'strike');
    const r = await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'highlight' });
    assert.equal(r.json.changed, true);
    const now = (await pageOf(PDF)).threads.find(x => x.id === t.id);
    assert.equal('mark' in now, false);
  });

  await test('a page that cannot carry a strikeout refuses one', async () => {
    const t = await threadOn(WEB, 'a sentence on a web page', 'hm');
    const r = await POST(base, '/mark', { url: WEB, thread_id: t.id, mark: 'strike' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /PDF markup/);
  });

  await test('a FILED thread refuses one too — the argument is over', async () => {
    const t = await threadOn(PDF, 'a filed passage', 'settled');
    await POST(base, '/resolve', { url: PDF, thread_id: t.id, resolved: true });
    const r = await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'strike' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /reopen it/);
  });

  await test('…but UNDOING a mark is never gated: a struck thread can be filed and put back', async () => {
    const t = await threadOn(PDF, 'a struck passage that got filed', 'take it out');
    await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'strike' });
    await POST(base, '/resolve', { url: PDF, thread_id: t.id, resolved: true });
    const r = await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'highlight' });
    assert.equal(r.status, 200, 'a mark already on the record must always be undoable');
    assert.equal(r.json.changed, true);
  });

  await test('an unknown thread is a 404, not a silent no-op', async () => {
    const r = await POST(base, '/mark', { url: PDF, thread_id: 't-nope', mark: 'strike' });
    assert.equal(r.status, 404);
  });

  console.log('\nstrike — the envelope offer');

  await test('a thread turn on a PDF carries the offer', async () => {
    const t = await threadOn(PDF, 'a passage worth arguing about', '@claude what is this for?');
    const env = await waitFor(
      () => inputs(log).find(x => /what is this for\?/.test(x)), 'the envelope');
    assert.match(env, /strike: <one short reason>/);
    return t;
  });

  await test('…and a thread turn on an ARTICLE carries none', async () => {
    await POST(base, '/thread', { url: WEB, quote: 'another sentence', msg: { text: '@claude and this?' } });
    const env = await waitFor(() => inputs(log).find(x => /and this\?/.test(x)), 'the envelope');
    assert.ok(!/strike: <one short reason>/.test(env),
      'there is nothing on a web page to write an /StrikeOut into');
  });

  await test('…nor does a passage that is ALREADY struck', async () => {
    const t = await threadOn(PDF, 'a passage already crossed out', 'gone');
    await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'strike' });
    await POST(base, '/reply', { url: PDF, thread_id: t.id, text: '@claude anything else?' });
    const env = await waitFor(() => inputs(log).find(x => /anything else\?/.test(x)), 'the envelope');
    assert.ok(!/strike: <one short reason>/.test(env), 'nothing left to suggest');
    assert.match(env, /STRUCK this passage through/, '…and the standing context still rides it');
  });

  console.log('\nstrike — the suggestion becomes a button, and the button mints a thread');

  let discussion = null;
  // the owner's handle is whatever this machine calls them (identity.mjs), so
  // every claim about WHO SIGNED the annotation is made against the record's own
  // answer rather than against a name written into this file
  let ME = '';
  await test('a bot’s `strike:` line is lifted off its words onto the message', async () => {
    // untagged, so exactly ONE turn runs on this thread and the reply the
    // assertions are about is the only bot message in it
    discussion = await threadOn(PDF, QUOTE, 'is this section pulling its weight?');
    await POST(base, '/reply', {
      url: PDF, thread_id: discussion.id,
      text: '@claude [mock:says:No — section 2 already makes the point.\\nstrike: section 2 already makes the point]',
    });
    const page = await waitFor(async () => {
      const p = await pageOf(PDF);
      const th = p.threads.find(x => x.id === discussion.id);
      return (th.msgs || []).some(m => m.author === 'claude') ? p : null;
    }, 'the reply');
    const th = page.threads.find(x => x.id === discussion.id);
    ME = th.msgs[0].author;
    const reply = th.msgs.filter(m => m.author === 'claude').pop();
    assert.deepEqual(reply.strike, { why: 'section 2 already makes the point' });
    assert.equal(reply.text, 'No — section 2 already makes the point.',
      'the machinery line is taken out of the words');
    assert.equal(store.markOf(th), 'highlight',
      'BOTS NEVER MARK UP: the passage is untouched until the reader clicks');
  });

  let minted = null;
  await test('confirming it mints a SEPARATE strikeout, signed by the reader', async () => {
    const r = await POST(base, '/strike-from', {
      url: PDF, thread_id: discussion.id, note: 'section 2 already makes the point',
    });
    assert.equal(r.status, 200);
    minted = r.json.thread;
    assert.notEqual(minted.id, discussion.id, 'a NEW thread, not a converted one');
    assert.equal(minted.mark, 'strike');
    assert.equal(minted.quote, QUOTE, 'the same passage');
    assert.equal(minted.page, 7, 'and the same page of the document');
    assert.equal(minted.msgs.length, 1, 'one comment, and it is the reader’s');
    assert.equal(minted.msgs[0].author, ME, 'the reader’s own handle, not a bot’s');
    assert.equal(minted.msgs[0].text, 'section 2 already makes the point');
    assert.equal(minted.from_thread, discussion.id, 'a soft note of where it came from');
  });

  await test('…and leaves the discussion exactly as it was', async () => {
    const th = (await pageOf(PDF)).threads.find(x => x.id === discussion.id);
    assert.equal(store.markOf(th), 'highlight');
    assert.equal(th.msgs.length, 3, 'the question, the follow-up and the bot’s answer');
  });

  await test('…and lands directly after it in page order', async () => {
    const ids = (await pageOf(PDF)).threads.map(x => x.id);
    assert.equal(ids.indexOf(minted.id), ids.indexOf(discussion.id) + 1);
  });

  await test('BOTH BOTS MAY SUGGEST, and the reader takes the wording they prefer', async () => {
    // the reader's real scenario: ask one, ask the other, compare, pick
    const d = await threadOn(PDF, 'a passage two bots were asked about', 'thoughts?');
    for (const [who, words, why] of [
      ['claude', 'It repeats section 2.', 'it repeats section 2'],
      ['codex', 'It is throat-clearing.', 'it is throat-clearing before the real point'],
    ]) {
      await POST(base, '/reply', {
        url: PDF, thread_id: d.id,
        text: `@${who} [mock:says:${words}\\nstrike: ${why}]`,
      });
      await waitFor(async () => {
        const th = (await pageOf(PDF)).threads.find(x => x.id === d.id);
        return (th.msgs || []).some(m => m.author === who && m.strike);
      }, `${who}'s suggestion`);
    }
    const th = (await pageOf(PDF)).threads.find(x => x.id === d.id);
    const suggestions = th.msgs.filter(m => m.strike);
    assert.equal(suggestions.length, 2, 'a suggestion rides its own REPLY — never last-one-wins');
    assert.deepEqual(suggestions.map(m => m.author), ['claude', 'codex']);
    assert.match(suggestions[1].strike.why, /throat-clearing/);
    // …and the reader takes the SECOND one
    const chosen = suggestions[1];
    const r = await POST(base, '/strike-from', {
      url: PDF, thread_id: d.id, note: chosen.strike.why, from_msg: chosen.ts,
    });
    assert.equal(r.status, 200);
    assert.match(r.json.thread.msgs[0].text, /throat-clearing/, 'the wording they chose');
    assert.ok(!/repeats section 2/.test(r.json.thread.msgs[0].text), 'and not the other one');
    assert.equal(r.json.thread.from_msg, chosen.ts,
      'the record says which REPLY was taken, not merely which thread');
    assert.equal(r.json.thread.msgs[0].author, ME, 'and it is still the reader’s comment');
    // taking the other one afterwards cannot put a second line over one passage
    const again = await POST(base, '/strike-from', {
      url: PDF, thread_id: d.id, note: suggestions[0].strike.why, from_msg: suggestions[0].ts,
    });
    assert.equal(again.json.deduped, true);
    assert.equal(again.json.thread.id, r.json.thread.id);
    assert.equal((await pageOf(PDF)).threads.filter(
      x => x.quote === 'a passage two bots were asked about' && x.mark === 'strike').length, 1);
  });

  await test('a second click does not put a second red line over one passage', async () => {
    const r = await POST(base, '/strike-from', { url: PDF, thread_id: discussion.id, note: 'again' });
    assert.equal(r.status, 200);
    assert.equal(r.json.deduped, true);
    assert.equal(r.json.thread.id, minted.id);
  });

  await test('no bot is summoned by a conversion — the decision is already made', async () => {
    const before = inputs(log).length;
    const t = await threadOn(PDF, 'a quiet passage', 'no tag here');
    await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'strike' });
    await sleep(200);
    assert.equal(inputs(log).length, before, 'nothing was sent to the bridge');
  });

  await test('THE POINT: delete the discussion and the strikeout stands alone', async () => {
    const del = await POST(base, '/delete', { url: PDF, thread_id: discussion.id });
    assert.equal(del.status, 200);
    const page = await pageOf(PDF);
    assert.equal(page.threads.some(x => x.id === discussion.id), false, 'the conversation is gone');
    const still = page.threads.find(x => x.id === minted.id);
    assert.ok(still, 'and the strikeout is not');
    assert.equal(still.mark, 'strike');
    assert.equal(still.quote, QUOTE);
    assert.equal(still.msgs[0].author, ME);
    // the provenance is soft BY DESIGN: it may dangle, and nothing reads it
    // expecting to find anything
    assert.equal(still.from_thread, discussion.id);
  });

  await test('…and what the co-author receives is a red line with a human’s name on it', async () => {
    const still = (await pageOf(PDF)).threads.find(x => x.id === minted.id);
    // exactly what pdf/viewer.js collectItems builds for the export
    const contents = Ann.threadContents(still, { head: `“${still.quote}”` });
    const author = (still.msgs[0] || {}).author;
    assert.equal(author, ME, 'the annotation is signed by whoever opened the thread');
    assert.ok(contents.includes(ME));
    assert.match(contents, /section 2 already makes the point/);
    assert.ok(!/claude/i.test(contents), 'no bot anywhere in the popup');
    assert.ok(!/pulling its weight/.test(contents), 'and not one line of the discussion');
    assert.ok(!/from_thread/.test(contents),
      'nor any reference to a thread the recipient cannot see');
  });

  await test('a strike minted with no note says so rather than signing a blank', async () => {
    const d = await threadOn(PDF, 'a passage struck without a word', 'thoughts?');
    const r = await POST(base, '/strike-from', { url: PDF, thread_id: d.id, note: '' });
    assert.equal(r.json.thread.msgs[0].text, '');
    const contents = Ann.threadContents(r.json.thread, { head: '“x”' });
    assert.match(contents, /\(no note\)/, 'the popup is never a name over a blank');
  });

  await test('/strike-from refuses a page that cannot carry a strikeout', async () => {
    const t = await threadOn(WEB, 'a third web sentence', 'hm');
    const r = await POST(base, '/strike-from', { url: WEB, thread_id: t.id });
    assert.equal(r.status, 409);
  });

  console.log('\nstrike — what a converted thread looks like everywhere else');

  await test('the reading room draws the struck quote and says what it is', async () => {
    const page = await pageOf(PDF);
    const html = views.pageView({ page, key: 'k', me: { owner: true } });
    assert.match(html, /<blockquote class="struck">/);
    assert.match(html, /this passage is struck through in the document/);
  });

  for (const p of spawned) { try { p.kill(); } catch { } }
  await sleep(150);
}

for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
try { fs.rmSync(SECRETS, { recursive: true, force: true }); } catch { }

console.log(`\nstrike: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
