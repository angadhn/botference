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
const exportNote = await import(path.join(PLUGIN, 'export.mjs'));
const { SPAN_DISCIPLINE: chatSpan } = await import(path.join(PLUGIN, 'chat.mjs'));
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

// ONE REPLY, SEVERAL CHANGES (2026-08-29). A discussion routinely concludes
// that two or three separate places have to change, and a thread can only ever
// mint one card for its own quote — so a reply may carry up to
// STRIKE_PER_REPLY_MAX suggestions, each with a `passage:` of its own.
await test('a reply may carry SEVERAL suggestions, each with its own passage', () => {
  const hits = store.parseStrikeSuggestions([
    'Three things have to change here.',
    'passage: The inflatable-arm literature',
    'strike: replace with: "Work on inflatable arms"',
    'strike: it repeats section 2',
    'passage: and adds nothing to it',
    'strike: replace with: "and adds little"',
  ].join('\n'));
  assert.equal(hits.length, 3);
  assert.equal(hits[0].passage, 'The inflatable-arm literature');
  assert.match(hits[0].why, /Work on inflatable arms/);
  assert.equal(hits[1].passage, '', 'a suggestion with no passage means the thread’s own quote');
  assert.equal(hits[2].passage, 'and adds nothing to it');
  assert.equal(hits[0].lines.length, 2, 'both lines are machinery and both come off the words');
  assert.equal(hits[1].lines.length, 1);
});

await test('…the passage line binds FORWARD, and a stray one aims at nothing', () => {
  const hits = store.parseStrikeSuggestions('strike: cut it\npassage: some wording');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].passage, '', 'a passage AFTER a suggestion does not re-aim it');
  assert.deepEqual(hits.orphanLines, ['passage: some wording'],
    'but it is still machinery, and still comes off the reply’s words');
  assert.equal(store.parseStrikeSuggestions('passage: “quoted wording”\nstrike: cut')[0].passage,
    'quoted wording', 'the quote marks a model wraps it in come off');
});

// A CHANGE ON ANOTHER PAGE (2026-08-29). Reported on the reader's manuscript: a
// thread on page 13 concluded that the scope sentence belonged in Section 1, on
// page 2, and the bot could only refuse — a `passage:` had to sit on the
// thread's own page — and tell the reader to go and mark it up themselves.
await test('a `page:` line names another page, and binds forward with its passage', () => {
  const hits = store.parseStrikeSuggestions([
    'That belongs in Section 1.',
    'page: 2',
    'passage: The method is described in section 4.',
    'strike: replace with: "The method is described in section 1."',
  ].join('\n'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page, 2);
  assert.equal(hits[0].passage, 'The method is described in section 4.');
  assert.equal(hits[0].lines.length, 3, 'all three lines are machinery and all three come off');
});

await test('…in either order, and written the way a model actually writes it', () => {
  const a = store.parseStrikeSuggestions('passage: some wording\npage: p. 13\nstrike: cut it')[0];
  assert.equal(a.page, 13, '"p. 13" is a page number');
  assert.equal(a.passage, 'some wording');
  const b = store.parseStrikeSuggestions('page: page 4 (Section 2)\npassage: some wording\nstrike: cut')[0];
  assert.equal(b.page, 4, 'the number is what is meant, whatever is written round it');
});

await test('…and a `page:` alone still comes off the words, naming nothing', () => {
  const hits = store.parseStrikeSuggestions('strike: cut it\npage: 7');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page, 0, 'a page AFTER a suggestion does not re-aim it');
  assert.deepEqual(hits.orphanLines, ['page: 7']);
  assert.equal(store.parseStrikeSuggestions('page: nowhere in particular\nstrike: cut')[0].page, 0,
    'a line with no number in it names no page');
});

await test('…and same-page and cross-page suggestions mix in one reply', () => {
  const hits = store.parseStrikeSuggestions([
    'Two things.',
    'passage: the sentence here',
    'strike: it repeats the one before it',
    'page: 2',
    'passage: the sentence there',
    'strike: replace with: "the corrected sentence"',
  ].join('\n'));
  assert.deepEqual(hits.map(h => h.page), [0, 2], 'the page binds to ITS suggestion and no other');
  assert.deepEqual(hits.map(h => h.passage), ['the sentence here', 'the sentence there']);
});

await test('…and a message carries the list, old records and new alike', () => {
  assert.deepEqual(store.strikesOf({ strike: { why: 'one' } }), [{ why: 'one' }],
    'a reply written before any of this reads back exactly as it did');
  assert.deepEqual(store.strikesOf({ strikes: [{ why: 'a' }, { why: 'b' }] }),
    [{ why: 'a' }, { why: 'b' }]);
  assert.deepEqual(store.strikesOf({}), []);
});

await test('…and the offer teaches both, including the end of "go and re-highlight"', () => {
  const block = store.strikeOfferBlock();
  assert.match(block, /MORE THAN ONE CHANGE IS ALLOWED/);
  assert.match(block, /IF THE HIGHLIGHT IS INCOMPLETE, NAME THE PASSAGE YOURSELF/);
  assert.match(block, /Never ask the reader to go back and re-highlight/);
  assert.match(block, /passage: <the full exact wording as it appears on the page>/);
  assert.match(block, /exactly ONCE on this page/);
  // …and the end of "go and do it yourself on the other page", which is the
  // refusal the reader actually hit
  assert.match(block, /A CHANGE ON ANOTHER PAGE NAMES THAT PAGE/);
  assert.match(block, /page: <N>/);
  assert.match(block, /NEVER tell the reader to go and highlight it themselves/);
  // …and the span rule says the same thing from its own side: naming a passage
  // is the sanctioned way past the highlight, silent widening still is not
  assert.match(chatSpan, /SANCTIONED way to reach just beyond an incomplete highlight/);
  assert.match(chatSpan, /Never send the reader away to re-highlight/);
  assert.match(chatSpan, /forbidden is widening in SILENCE/);
});

await test('…and every fault a suggestion can have says what it was', () => {
  for (const [fault, re] of [
    ['capped', /more than 3 suggestions/],
    ['unlocatable', /not on this page/],
    ['offpage', /different page/],
    ['ambiguous', /more than once on this page/],
    ['covered', /another mark/],
    ['pageless', /names where to look and nothing to look for/],
  ]) {
    assert.match(store.strikeFaultWhy(fault, 'the words'), re, fault);
    assert.match(store.strikeRefusedBlock(fault, 'the words'), /REFUSED/);
  }
});

await test('…and a refusal about ANOTHER page says which page was searched', () => {
  assert.match(store.strikeFaultWhy('unlocatable', 'the words', 2), /not on page 2/);
  assert.match(store.strikeFaultWhy('ambiguous', 'the words', 2), /more than once on page 2/);
  assert.match(store.strikeFaultWhy('covered', 'the words', 2), /already on page 2/);
  assert.match(store.strikeFaultWhy('offpage', 'the words', 2), /not on page 2/);
  assert.match(store.strikeRefusedBlock('unlocatable', 'the words', 2), /page 2/);
  // …and with no page named it is the message it has always been
  assert.match(store.strikeFaultWhy('unlocatable', 'the words'), /not on this page/);
});

await test('…and a REASONLESS suggestion is no suggestion at all', () => {
  assert.equal(store.parseStrikeSuggestion('strike:'), null);
  assert.equal(store.parseStrikeSuggestion('strike:   '), null);
  assert.equal(store.parseStrikeSuggestion('nothing here'), null);
});

// The note is not always a reason. Where the discussion concluded in a
// REPLACEMENT, the note is the replacement — and the whole of it, because the
// person reading it has only the struck passage and this line.
await test('a REPLACEMENT note survives the parse whole, markdown and all', () => {
  const long = 'replace with: "The ET-Class model [9] extends their stiff/flexible '
    + 'formulation to the tumbling case, and the decay predicted by Shan et al. (2024) '
    + 'is recovered within one per cent over the first hundred orbits (Figure 1); the '
    + 'discrepancy reported in section 4 is therefore an artefact of the *earlier* '
    + 'linearisation and not of the model itself."';
  assert.ok(long.length > 300, 'a realistic replacement is not 200 characters');
  const hit = store.parseStrikeSuggestion(`Here is the wording.\n\nstrike: ${long}`);
  assert.equal(hit.why, long, 'byte for byte — nothing here truncates');
  assert.match(hit.why, /\*earlier\*/, 'and markdown INSIDE the note is left alone');
  assert.equal(store.strikeNoteFault(hit.why).fault, '', 'it carries its own words, so it stands');
});

console.log('\nstrike — a note that will be useless on the document');

// A note that points at the discussion is a note that will be meaningless
// within the minute: the reader's next act is to DELETE the discussion, and the
// co-author receives the struck passage and this line and nothing else.
await test('a DEICTIC note is refused', () => {
  for (const bad of [
    'replace with the wording above naming Shan [X], ET-Class [9] and Figure 1',
    'use the replacement I gave above',
    'as discussed, this should come out',
    'as I said, section 2 covers it',
    'see my suggestion above',
    'my earlier wording is better',
    'this thread has settled it',
  ]) {
    const f = store.strikeNoteFault(bad);
    assert.equal(f.fault, 'deictic', `should be refused: ${bad}`);
    assert.ok(f.phrase, 'and the offending words come back, for the chip and the bot');
  }
});

await test('…while a note about the DOCUMENT passes, however it points', () => {
  for (const good of [
    'the paragraph above already says this',
    'section 2 already makes the point',
    'this repeats an earlier result and adds nothing',
    'the figure below shows the same thing',
    'replace with: "The debris decays within ten orbits."',
    // deixis is forgiven where the words themselves are carried: the note is
    // self-contained however it introduces itself
    'as discussed, replace with: "The debris decays within ten orbits."',
  ]) {
    assert.equal(store.strikeNoteFault(good).fault, '', `should pass: ${good}`);
  }
});

await test('…and an ENORMOUS note is refused rather than cut in half', () => {
  const huge = 'replace with: "' + 'x'.repeat(store.STRIKE_NOTE_MAX + 50) + '"';
  assert.equal(store.strikeNoteFault(huge).fault, 'long');
  assert.equal(store.strikeNoteFault('replace with: "' + 'x'.repeat(500) + '"').fault, '',
    'a real replacement sentence is nowhere near the cap');
});

await test('…and the offer says both things, in words a model cannot read past', () => {
  const block = store.strikeOfferBlock();
  assert.match(block, /STAND ON ITS OWN/);
  assert.match(block, /IN FULL and in quotes/);
  assert.match(block, /refused rather than cut/);
  assert.match(store.strikeRefusedBlock('deictic'), /REFUSED/);
  assert.match(store.strikeRefusedBlock('long'), /not cut a note in half/);
});

console.log('\nstrike — the OTHER marks in the same sentence');

// One sentence, three marks: two struck, one still being discussed. This is the
// shape that produced the bug — the bot answering the third one rewrote the
// whole sentence, swallowing the words the other two already cover, because the
// whole sentence was the only thing its turn ever showed it.
const SENTENCE =
  'The long-term simulations of the tumbling debris were run for one hundred orbits, '
  + 'and in every case, as we shall see below, the attitude motion decayed.';
const FILLER = 'Section four repeats this argument at greater length and adds nothing to it, '
  + 'which is why the referee asked for it to be cut down to a paragraph or removed. '
  + 'The appendix carries the derivation in full and is the only place it appears. ';
const FAR = 'A separate claim, far away in the same page, about the thermal model.';
const P3 = `${SENTENCE} ${FILLER}${FAR}`;
const SNAPSHOT = `<section><h2>Page 3</h2><p>${P3}</p></section>`
  + '<section><h2>Page 4</h2><p>Page four says nothing about the tumbling debris at all.</p></section>';

const mkThread = (id, quote, extra = {}) => ({
  id, quote, prefix: '', suffix: '', orphaned: false, page: 3,
  msgs: [{ author: 'angadh', ts: '2026-08-26T09:00:00.000Z', text: 'hm' }],
  ...extra,
});
const A = mkThread('t-a', 'of the tumbling debris', { mark: 'strike' });
const B = mkThread('t-b', 'as we shall see below,', { mark: 'strike', from_thread: 't-x' });
const C = mkThread('t-c', 'the attitude motion decayed');
const FART = mkThread('t-far', 'about the thermal model');
const OTHER_PAGE = mkThread('t-p4', 'the tumbling debris', { page: 4, mark: 'strike' });
const FIXTURE = { url: 'x', threads: [A, B, C, FART, OTHER_PAGE] };
const text3 = () => store.snapshotPageText(SNAPSHOT, 3);

await test('the snapshot is measured a PAGE at a time', () => {
  const t = store.snapshotPageText(SNAPSHOT, 3);
  assert.match(t, /^The long-term simulations/);
  assert.ok(!/Page four says/.test(t), 'page 4 is a different page and a different sentence');
  assert.match(store.snapshotPageText(SNAPSHOT, 4), /^Page four says/);
  assert.equal(store.snapshotPageText(SNAPSHOT, 9), '', 'a page with no section measures nothing');
});

await test('an open thread sees the two strikeouts standing beside it', () => {
  const near = store.nearbyMarks(FIXTURE, C, text3());
  assert.deepEqual(near.map(n => n.thread.id), ['t-b', 't-a'], 'nearest first');
  const block = store.nearbyMarksBlock(FIXTURE, C, text3());
  assert.match(block, /OTHER MARKS ON THIS SAME PASSAGE/);
  assert.match(block, /strikeout — a suggested deletion; open: "of the tumbling debris"/);
  assert.match(block, /strikeout, minted from a discussion; open: "as we shall see below,"/);
  assert.ok(!/thermal model/.test(block), 'a mark further down the page is not "beside" this one');
  assert.ok(!/^- highlight/m.test(block), 'and the only highlight here is this thread itself');
});

await test('…and never a mark on another page, however alike the words', () => {
  const near = store.nearbyMarks(FIXTURE, C, text3());
  assert.ok(!near.some(n => n.thread.id === 't-p4'),
    'page 4 quotes the same phrase and has nothing to do with this sentence');
});

await test('a filed neighbour says so, and an overlap measures zero', () => {
  const inner = mkThread('t-inner', 'tumbling debris', { resolved: true });
  const page = { url: 'x', threads: [A, inner] };
  const near = store.nearbyMarks(page, A, text3());
  assert.equal(near[0].dist, 0, 'it sits inside A’s own span');
  assert.match(store.nearbyMarksBlock(page, A, text3()), /highlight; filed: "tumbling debris"/);
});

await test('with no snapshot at all it falls back to the anchors, and under-reports', () => {
  const a = mkThread('t-1', 'the tumbling debris', { prefix: 'simulations of ', suffix: ' were run' });
  const b = mkThread('t-2', 'were run', { mark: 'strike' });
  const far = mkThread('t-3', 'the thermal model');
  const page = { url: 'x', threads: [a, b, far] };
  const near = store.nearbyMarks(page, a, '');
  assert.deepEqual(near.map(n => n.thread.id), ['t-2'],
    'the 32-character window catches the neighbour it touches and claims no more');
});

await test('the block is capped, nearest first, and says what it left out', () => {
  const long = 'x'.repeat(400);
  const many = Array.from({ length: 9 }, (_, i) => mkThread(`t-${i}`, `${long} ${i}`));
  const me = mkThread('t-me', SENTENCE);
  // no snapshot → the fallback, and every one of them overlaps `me`'s window
  const page = { url: 'x', threads: [me, ...many.map(t => ({ ...t, prefix: '', suffix: SENTENCE }))] };
  const block = store.nearbyMarksBlock(page, me, '');
  assert.equal((block.match(/^- /gm) || []).length, store.NEARBY_MAX, 'six neighbours, no more');
  assert.match(block, /\(…and 3 more nearby, not listed\.\)/);
  for (const line of block.match(/^- .*$/gm) || []) {
    assert.ok(line.length <= store.NEARBY_QUOTE_MAX + 80, 'each quote is clipped');
  }
  assert.match(block, /apply the same edit twice\.\n$/,
    'the closing instruction is appended after the cap, so it can never be the part clipped off');
});

await test('a passage standing alone carries no block at all', () => {
  assert.equal(store.nearbyMarksBlock({ url: 'x', threads: [C] }, C, text3()), '');
  assert.equal(store.nearbyMarksBlock(FIXTURE, mkThread('t-none', ''), text3()), '',
    'and neither does a thread with no quote to be beside');
});

console.log('\nstrike — the span rule');

{
  const chat = await import(path.join(PLUGIN, 'chat.mjs'));
  const base = {
    url: 'https://example.org/p.pdf', title: 'P', text: 'add it', history: [],
  };
  await test('every turn that quotes a passage carries it', () => {
    const env = chat.envelope({ ...base, target: 't-c', quote: C.quote });
    assert.match(env, /YOUR REMIT IS THE QUOTED PASSAGE, EXACTLY/);
    assert.match(env, /must not change a single word outside it/);
    assert.match(env, /this would also need changing outside your highlight/);
    assert.match(env, /"add some of it" means the part they named/);
  });
  await test('…the neighbours ride directly above it', () => {
    const env = chat.envelope({
      ...base, target: 't-c', quote: C.quote,
      nearbyContext: store.nearbyMarksBlock(FIXTURE, C, text3()),
    });
    assert.ok(env.indexOf('OTHER MARKS ON THIS SAME PASSAGE') < env.indexOf('YOUR REMIT IS'),
      'here is where your passage ends, and here is who owns what is past it');
  });
  await test('…and page chat and the library carry neither', () => {
    const chatEnv = chat.envelope({ ...base, target: store.PAGE_CHAT, quote: '' });
    assert.ok(!/YOUR REMIT IS/.test(chatEnv), 'no quote, nothing to confine to');
    const lib = chat.envelope({ ...base, target: store.PAGE_CHAT, library: '/tmp/x' });
    assert.ok(!/YOUR REMIT IS/.test(lib));
  });
  await test('…nor does filing a resolved thread, which writes nothing', () => {
    const env = chat.envelope({ ...base, target: 't-c', quote: C.quote, summary: true });
    assert.ok(!/YOUR REMIT IS/.test(env), 'a summary is a note for the archive, not an edit');
  });
}

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
    assert.match(env, /strike: <the note>/);
    return t;
  });

  await test('…and a thread turn on an ARTICLE carries none', async () => {
    await POST(base, '/thread', { url: WEB, quote: 'another sentence', msg: { text: '@claude and this?' } });
    const env = await waitFor(() => inputs(log).find(x => /and this\?/.test(x)), 'the envelope');
    assert.ok(!/strike: <the note>/.test(env),
      'there is nothing on a web page to write an /StrikeOut into');
  });

  await test('…nor does a passage that is ALREADY struck', async () => {
    const t = await threadOn(PDF, 'a passage already crossed out', 'gone');
    await POST(base, '/mark', { url: PDF, thread_id: t.id, mark: 'strike' });
    await POST(base, '/reply', { url: PDF, thread_id: t.id, text: '@claude anything else?' });
    const env = await waitFor(() => inputs(log).find(x => /anything else\?/.test(x)), 'the envelope');
    assert.ok(!/strike: <the note>/.test(env),
      'a MINTED STRIKE IS INERT: no offer rides it, so no chip can ever appear on it');
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
    assert.deepEqual(store.strikesOf(reply), [{ why: 'section 2 already makes the point' }]);
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
        return (th.msgs || []).some(m => m.author === who && store.strikesOf(m).length);
      }, `${who}'s suggestion`);
    }
    const th = (await pageOf(PDF)).threads.find(x => x.id === d.id);
    const suggestions = th.msgs.filter(m => store.strikesOf(m).length);
    assert.equal(suggestions.length, 2, 'a suggestion rides its own REPLY — never last-one-wins');
    assert.deepEqual(suggestions.map(m => m.author), ['claude', 'codex']);
    assert.match(store.strikesOf(suggestions[1])[0].why, /throat-clearing/);
    // …and the reader takes the SECOND one
    const chosen = suggestions[1];
    const r = await POST(base, '/strike-from', {
      url: PDF, thread_id: d.id, note: store.strikesOf(chosen)[0].why, from_msg: chosen.ts,
    });
    assert.equal(r.status, 200);
    assert.match(r.json.thread.msgs[0].text, /throat-clearing/, 'the wording they chose');
    assert.ok(!/repeats section 2/.test(r.json.thread.msgs[0].text), 'and not the other one');
    assert.equal(r.json.thread.from_msg, chosen.ts,
      'the record says which REPLY was taken, not merely which thread');
    assert.equal(r.json.thread.msgs[0].author, ME, 'and it is still the reader’s comment');
    // …and taking the OTHER one afterwards moves the note onto the strike that
    // is already there rather than putting a second line over one passage
    const again = await POST(base, '/strike-from', {
      url: PDF, thread_id: d.id, note: store.strikesOf(suggestions[0])[0].why, from_msg: suggestions[0].ts,
    });
    assert.equal(again.json.updated, true);
    assert.equal(again.json.thread.id, r.json.thread.id);
    assert.match(again.json.thread.msgs[0].text, /repeats section 2/, 'the wording they changed to');
    assert.equal(again.json.thread.from_msg, suggestions[0].ts, 'and which reply won, now');
    assert.equal((await pageOf(PDF)).threads.filter(
      x => x.quote === 'a passage two bots were asked about' && x.mark === 'strike').length, 1);
  });

  console.log('\nstrike — the note the companion will not file');

  await test('A DEICTIC SUGGESTION NEVER BECOMES A BUTTON, and says so', async () => {
    const d = await threadOn(PDF, 'a passage the bot pointed at', 'what should this say?');
    await POST(base, '/reply', { url: PDF, thread_id: d.id,
      text: '@claude [mock:says:Here is the replacement, in full: … .\\n'
        + 'strike: replace with the wording above naming Shan et al. and Figure 1]' });
    const reply = await waitFor(async () => {
      const th = (await pageOf(PDF)).threads.find(x => x.id === d.id);
      return (th.msgs || []).filter(m => m.author === 'claude' && store.strikesOf(m).length).pop();
    }, 'the lift');
    assert.equal(store.strikesOf(reply)[0].rejected, 'deictic', 'refused, and the record says why');
    assert.equal(store.strikesOf(reply)[0].phrase, 'the wording above', 'and which words did it');
    assert.ok(!/^strike:/m.test(reply.text), 'the machinery line is still off the words');
    assert.equal((await pageOf(PDF)).threads.filter(x => x.quote === 'a passage the bot pointed at'
      && x.mark === 'strike').length, 0, 'and nothing whatever was marked up');
  });

  await test('…and the bot is TOLD, on its next turn in that thread', async () => {
    const th = (await pageOf(PDF)).threads.find(x => x.quote === 'a passage the bot pointed at');
    await POST(base, '/reply', { url: PDF, thread_id: th.id, text: '@claude did that work?' });
    const env = await waitFor(() => inputs(log).find(x => /did that work\?/.test(x)), 'the envelope');
    assert.match(env, /YOUR LAST `strike:` LINE WAS REFUSED/);
    assert.match(env, /pointed back at this discussion/);
  });

  await test('…and a good line afterwards is lifted as an ordinary offer again', async () => {
    const th = (await pageOf(PDF)).threads.find(x => x.quote === 'a passage the bot pointed at');
    await POST(base, '/reply', { url: PDF, thread_id: th.id,
      text: '@claude [mock:says:Sorry.\\nstrike: replace with: "The debris decays within ten orbits."]' });
    const reply = await waitFor(async () => {
      const t2 = (await pageOf(PDF)).threads.find(x => x.id === th.id);
      return (t2.msgs || []).filter(m => m.author === 'claude'
        && store.strikesOf(m).some(s => !s.rejected)).pop();
    }, 'the second lift');
    assert.match(store.strikesOf(reply)[0].why, /decays within ten orbits/);
    // and the refusal is no longer riding the turn: only the LAST suggestion counts
    await POST(base, '/reply', { url: PDF, thread_id: th.id, text: '@claude and now?' });
    const env = await waitFor(() => inputs(log).find(x => /and now\?/.test(x)), 'the envelope');
    assert.ok(!/WAS REFUSED/.test(env), 'a bot that fixed it is not lectured about the first try');
  });

  // The OTHER silent failure on the reported session: the note arrived whole
  // and the record cut it at 200 characters, mid-word, without telling anybody.
  await test('A FULL REPLACEMENT SURVIVES END TO END — lift, mint, export', async () => {
    const FULL = 'replace with: "The ET-Class model of Boschetti and co-workers extends '
      + 'the stiff/flexible formulation of Shan et al. to the tumbling case, and reproduces the attitude '
      + 'decay reported there to within one per cent over the first hundred orbits '
      + '(Figure 1); the discrepancy noted in section 4 is an artefact of the earlier '
      + 'linearisation rather than of the model."';
    assert.ok(FULL.length > 340 && FULL.length < 700, `a realistic replacement (${FULL.length})`);
    const d = await threadOn(PDF, 'a passage needing a whole new sentence', 'rewrite this?');
    await POST(base, '/reply', { url: PDF, thread_id: d.id,
      text: `@claude [mock:says:Here it is.\\nstrike: ${FULL}]` });
    const reply = await waitFor(async () => {
      const th = (await pageOf(PDF)).threads.find(x => x.id === d.id);
      return (th.msgs || []).filter(m => m.author === 'claude' && store.strikesOf(m).length).pop();
    }, 'the lift');
    assert.equal(store.strikesOf(reply)[0].rejected, undefined, 'it carries its own words');
    assert.equal(store.strikesOf(reply)[0].why, FULL, 'INTACT at the lift');
    const r = await POST(base, '/strike-from', {
      url: PDF, thread_id: d.id, note: store.strikesOf(reply)[0].why, from_msg: reply.ts,
    });
    assert.equal(r.json.thread.msgs[0].text, FULL, 'INTACT on the mint');
    const still = (await pageOf(PDF)).threads.find(x => x.id === r.json.thread.id);
    assert.equal(still.msgs[0].text, FULL, 'INTACT on the record');
    const contents = Ann.threadContents(still, { head: `“${still.quote}”` });
    assert.ok(contents.includes(FULL), 'and INTACT in what the co-author receives');
    assert.ok(!/stiff\/flexibl["\s]*$/.test(contents), 'nothing ends mid-word');
  });

  await test('…and a note past the cap is refused at the door, never trimmed', async () => {
    const d = await threadOn(PDF, 'a passage with an essay attached', 'hm');
    const huge = 'replace with: "' + 'x'.repeat(store.STRIKE_NOTE_MAX + 100) + '"';
    const r = await POST(base, '/strike-from', { url: PDF, thread_id: d.id, note: huge });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /never cut/);
    assert.equal((await pageOf(PDF)).threads.filter(
      x => x.quote === 'a passage with an essay attached' && x.mark === 'strike').length, 0);
  });

  console.log('\nstrike — a note that came out wrong, and the reader fixing it');

  // Its own discussion and its own strike, deliberately: this section rewrites
  // a note over and over, and the mint above is the one the export test reads.
  const FIXQ = 'a passage whose note came out wrong';
  let fixDisc = null, fixMint = null;
  await test('a second click with the SAME note is a double tap: nothing moves', async () => {
    fixDisc = await threadOn(PDF, FIXQ, 'is this pulling its weight?');
    const first = await POST(base, '/strike-from', {
      url: PDF, thread_id: fixDisc.id, note: 'section 2 already makes the point',
    });
    fixMint = first.json.thread;
    const r = await POST(base, '/strike-from', {
      url: PDF, thread_id: fixDisc.id, note: 'section 2 already makes the point',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.deduped, true);
    assert.equal(r.json.thread.id, fixMint.id);
    assert.equal('updated' in r.json.thread, false, 'an idempotent click is not an edit');
  });

  await test('…and a click with no note at all leaves the one that is there', async () => {
    const r = await POST(base, '/strike-from', { url: PDF, thread_id: fixDisc.id, note: '' });
    assert.equal(r.json.deduped, true);
    assert.equal(r.json.thread.msgs[0].text, 'section 2 already makes the point');
  });

  // THE BUG THIS CLOSES. The reader confirmed a chip whose note turned out to be
  // useless on the document; the bot reissued the suggestion properly; and the
  // door refused to do anything with it, so the bad note was stuck on the record
  // for good while the bots reported it fixed.
  await test('A BETTER NOTE, CONFIRMED, REWRITES THE ONE ON THE STRIKE', async () => {
    const better = 'replace with: "The tumbling debris decays within ten orbits (Shan et al. 2024)."';
    const created = fixMint.msgs[0].ts;
    const r = await POST(base, '/strike-from', {
      url: PDF, thread_id: fixDisc.id, note: better, from_msg: '2026-08-27T09:00:00.000Z',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.updated, true, 'the confirm is the owner choosing better wording');
    assert.equal(r.json.thread.id, fixMint.id, 'the same red line, not a second one');
    assert.equal(r.json.thread.msgs[0].text, better);
    assert.equal(r.json.thread.msgs[0].author, ME, 'still signed by the reader');
    assert.equal(r.json.thread.msgs[0].ts, created, 'and still dated when it was made');
    assert.equal(r.json.thread.msgs[0].edited, true, 'the card says so');
    assert.ok(r.json.thread.updated >= created, 'the moment it was rewritten is on the record');
    assert.equal(r.json.thread.from_msg, '2026-08-27T09:00:00.000Z', 'and which reply won');
    const page = await pageOf(PDF);
    assert.equal(page.threads.filter(x => x.quote === FIXQ && x.mark === 'strike').length, 1);
    // …and what the co-author receives is the CORRECTED note
    const still = page.threads.find(x => x.id === fixMint.id);
    const contents = Ann.threadContents(still, { head: `“${still.quote}”` });
    assert.match(contents, /Shan et al\. 2024/);
    assert.ok(!/section 2 already makes the point/.test(contents), 'and not the note it replaced');
  });

  await test('…and the OWNER may rewrite it by hand, through the ordinary door', async () => {
    // the minted comment is the reader's own message, so POST /edit takes it —
    // no second editing path, and the export follows because it reads msgs[0]
    const hand = 'replace with: "The tumbling debris decays within ten orbits (Shan 2024, Fig. 1)."';
    const still = (await pageOf(PDF)).threads.find(x => x.id === fixMint.id);
    const r = await POST(base, '/edit', {
      url: PDF, thread_id: fixMint.id, ts: still.msgs[0].ts, text: hand,
    });
    assert.equal(r.status, 200);
    const after = (await pageOf(PDF)).threads.find(x => x.id === fixMint.id);
    assert.equal(after.msgs[0].text, hand);
    assert.match(Ann.threadContents(after, { head: '“x”' }), /Fig\. 1/);
  });

  await test('THE LINK, not the quote, is what a correction follows home', async () => {
    // the passage is rewritten under the discussion and the two anchors drift
    // apart: quote-equality alone would mint a SECOND red line, which is the
    // failure this ordering exists to prevent
    const d = await threadOn(PDF, 'a passage that will drift', 'thoughts?');
    const first = await POST(base, '/strike-from', {
      url: PDF, thread_id: d.id, note: 'it repeats the abstract',
    });
    const id = first.json.thread.id;
    await POST(base, '/reply', { url: PDF, thread_id: d.id,
      text: '@claude [mock:says:Done — this passage now reads: "a passage that HAS drifted"]' });
    await waitFor(async () => {
      const th = (await pageOf(PDF)).threads.find(x => x.id === d.id);
      return (th.msgs || []).some(m => m.author === 'claude' && /HAS drifted/.test(m.text));
    }, 'the bot’s new wording');
    const re = await POST(base, '/reanchor', { url: PDF, thread_id: d.id,
      quote: 'a passage that HAS drifted' });
    assert.equal(re.json.changed, true, 'the discussion now quotes the new wording');
    const r = await POST(base, '/strike-from', {
      url: PDF, thread_id: d.id, note: 'replace with: "the abstract already says this"',
    });
    assert.equal(r.json.updated, true);
    assert.equal(r.json.thread.id, id, 'the strike this discussion minted, whatever it quotes now');
    assert.equal((await pageOf(PDF)).threads.filter(x => x.mark === 'strike'
      && x.from_thread === d.id).length, 1, 'and still exactly one line on the passage');
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

  console.log('\nstrike — the neighbours, on a real turn');

  await test('the third mark in a sentence is told about the other two', async () => {
    const url = 'https://example.org/three-marks.pdf';
    await POST(base, '/page', { url, title: 'Three marks', kind: 'pdf' });
    const snap = await POST(base, '/snapshot', { url, html: SNAPSHOT });
    assert.equal(snap.json.stored, true, 'the page text is what "near" is measured in');
    const a = await POST(base, '/thread', { url, quote: A.quote, page: 3, msg: { text: 'cut' } });
    await POST(base, '/mark', { url, thread_id: a.json.thread.id, mark: 'strike' });
    const b = await POST(base, '/thread', { url, quote: B.quote, page: 3, msg: { text: 'cut' } });
    await POST(base, '/mark', { url, thread_id: b.json.thread.id, mark: 'strike' });
    await POST(base, '/thread', { url, quote: C.quote, page: 3,
      msg: { text: '@claude tighten this — add it' } });
    const env = await waitFor(() => inputs(log).find(x => /tighten this — add it/.test(x)),
      'the envelope');
    assert.match(env, /OTHER MARKS ON THIS SAME PASSAGE/);
    assert.match(env, /of the tumbling debris/);
    assert.match(env, /as we shall see below/);
    assert.match(env, /YOUR REMIT IS THE QUOTED PASSAGE, EXACTLY/);
  });

  await test('…a passage nobody else has marked hears nothing about neighbours', async () => {
    const t = await threadOn(PDF, 'a lonely unmarked clause', '@claude and this one?');
    const env = await waitFor(() => inputs(log).find(x => /and this one\?/.test(x)), 'the envelope');
    assert.ok(!/OTHER MARKS ON THIS SAME PASSAGE/.test(env), 'there are none');
    assert.match(env, /YOUR REMIT IS THE QUOTED PASSAGE, EXACTLY/, 'the span rule rides anyway');
    return t;
  });

  await test('…and an ARTICLE turn is the turn it always was, plus the span rule', async () => {
    await POST(base, '/thread', { url: WEB, quote: 'a web sentence, marked',
      msg: { text: '@claude what about here?' } });
    const env = await waitFor(() => inputs(log).find(x => /what about here\?/.test(x)), 'the envelope');
    assert.ok(!/OTHER MARKS ON THIS SAME PASSAGE/.test(env),
      'a web page carries no strikeouts, so a neighbour is only ever another conversation');
    assert.match(env, /YOUR REMIT IS THE QUOTED PASSAGE, EXACTLY/);
  });

  await test('…and PAGE CHAT, which quotes nothing, carries neither', async () => {
    await POST(base, '/reply', { url: PDF, text: '@claude what is this paper about?' });
    const env = await waitFor(() => inputs(log).find(x => /what is this paper about\?/.test(x)),
      'the envelope');
    assert.ok(!/OTHER MARKS ON THIS SAME PASSAGE/.test(env));
    assert.ok(!/YOUR REMIT IS/.test(env));
  });

  // ------------------------------------------------------------------------
  // ONE DISCUSSION, SEVERAL CHANGES — and a bot that corrects the highlight.
  //
  // Both halves come out of one reported failure on a real manuscript. The
  // reader highlighted "nflatable-arm" — short of the initial letter and of the
  // words either side — the discussion concluded the phrase should be rewritten,
  // and the bot REFUSED to suggest anything, telling the reader to go back and
  // re-highlight the full wording. And more generally: one discussion often
  // concludes that two or three separate places need changing, while a thread
  // can only ever mint one card for its own quote.
  console.log('\nstrike — one discussion, several changes');

  const MANU = 'https://example.org/inflatable-arms.pdf';
  const P9 = 'Deployment is treated only in passing. The inflatable-arm literature is thin, '
    + 'and nobody has measured the damping. Section four repeats the argument at greater '
    + 'length and adds nothing to it. The thermal model is described in appendix B, and '
    + 'the thermal model is described again in appendix C.';
  const P10 = 'Page ten mentions the ET-Class formulation and nothing else at all.';
  const MSNAP = `<section><h2>Page 9</h2><p>${P9}</p></section>`
    + `<section><h2>Page 10</h2><p>${P10}</p></section>`;
  const manuPage = async () => (await GET(base, '/page?url=' + enc(MANU))).json;
  const threadOnPage9 = async (quote, text) =>
    (await POST(base, '/thread', { url: MANU, quote, page: 9, msg: { text } })).json.thread;

  await POST(base, '/page', { url: MANU, title: 'Inflatable arms', kind: 'pdf' });
  {
    const snap = await POST(base, '/snapshot', { url: MANU, html: MSNAP });
    assert.equal(snap.json.stored, true);
  }

  let inflate = null;
  let inflateCard = null;
  await test('THE REPORTED CASE: a partial highlight, corrected by the bot itself', async () => {
    // exactly what the reader had: the highlight is missing the first letter of
    // "inflatable" and stops short of the words either side
    inflate = await threadOnPage9('nflatable-arm', 'this phrase reads backwards, no?');
    await POST(base, '/reply', {
      url: MANU, thread_id: inflate.id,
      text: '@claude [mock:says:Agreed — the whole phrase has to turn round.\\n'
        + 'passage: The inflatable-arm literature\\n'
        + 'strike: replace with: "Work on inflatable arms is thin."]',
    });
    const reply = await waitFor(async () => {
      const th = (await manuPage()).threads.find(x => x.id === inflate.id);
      return (th.msgs || []).filter(m => m.author === 'claude' && store.strikesOf(m).length).pop();
    }, 'the lift');
    const [s] = store.strikesOf(reply);
    assert.equal(s.rejected, undefined, 'the bot names the passage rather than refusing');
    assert.equal(s.passage, 'The inflatable-arm literature', 'located on the page, and kept');
    assert.ok(!/^passage:/m.test(reply.text), 'the passage line is machinery, and comes off');
    assert.ok(!/^strike:/m.test(reply.text), 'so is the strike line');
    // …and the confirm anchors THERE, not on the reader's partial selection
    const r = await POST(base, '/strike-from', {
      url: MANU, thread_id: inflate.id, from_msg: reply.ts, from_idx: 0,
      passage: s.passage, note: s.why,
    });
    assert.equal(r.status, 200);
    inflateCard = r.json.thread;
    assert.equal(inflateCard.quote, 'The inflatable-arm literature',
      'THE WHOLE POINT: the reader never re-highlighted anything');
    assert.equal(inflateCard.page, 9);
    assert.match(inflateCard.prefix, /passing\. $/, 'anchored with the page’s own context before it');
    assert.match(inflateCard.suffix, /^ is thin/, '…and after it');
    assert.equal(inflateCard.passage_named, true, 'and the record says the bot named the span');
    assert.equal(inflateCard.from_thread, inflate.id);
    const disc = (await manuPage()).threads.find(x => x.id === inflate.id);
    assert.equal(disc.quote, 'nflatable-arm', 'the discussion’s own highlight is untouched');
  });

  let brood = null;
  let broodIds = [];
  await test('THREE SUGGESTIONS IN ONE REPLY BECOME THREE CARDS, one parent', async () => {
    brood = await threadOnPage9('Section four', 'what else needs doing round here?');
    await POST(base, '/reply', {
      url: MANU, thread_id: brood.id,
      text: '@claude [mock:says:Three things.\\n'
        + 'passage: Deployment is treated only in passing.\\n'
        + 'strike: replace with: "Deployment is treated in section 3."\\n'
        + 'passage: nobody has measured the damping\\n'
        + 'strike: replace with: "the damping was measured by Shan et al. (2024)"\\n'
        + 'passage: appendix B\\n'
        + 'strike: replace with: "appendix C"]',
    });
    const reply = await waitFor(async () => {
      const th = (await manuPage()).threads.find(x => x.id === brood.id);
      return (th.msgs || []).filter(m => m.author === 'claude'
        && store.strikesOf(m).length === 3).pop();
    }, 'three suggestions in one reply');
    const list = store.strikesOf(reply);
    assert.deepEqual(list.map(s => s.rejected), [undefined, undefined, undefined]);
    assert.deepEqual(list.map(s => s.passage), [
      'Deployment is treated only in passing.',
      'nobody has measured the damping',
      'appendix B',
    ]);
    // DISJOINT IS ALLOWED, deliberately: none of the three touches the words the
    // reader highlighted. A rule that every passage must overlap the highlight
    // would make "one discussion, several changes" unbuildable, and what makes
    // it safe is not overlap but consent — the chip shows the wording, and
    // nothing is marked up until the reader presses the button.
    assert.ok(!list.some(s => s.passage.includes('Section four')),
      'a second place on the page is a second change, not a widening of this one');
    for (let i = 0; i < 3; i++) {
      const r = await POST(base, '/strike-from', {
        url: MANU, thread_id: brood.id, from_msg: reply.ts, from_idx: i,
        passage: list[i].passage, note: list[i].why,
      });
      assert.equal(r.status, 200, `chip ${i}`);
      assert.equal(r.json.deduped, undefined, `chip ${i} minted rather than deduped`);
      broodIds.push(r.json.thread.id);
    }
    assert.equal(new Set(broodIds).size, 3, 'three chips, three separate red lines');
    const page = await manuPage();
    const kids = store.broodOf(page, brood.id);
    assert.equal(kids.length, 3, 'and one parent holding all three');
    assert.deepEqual(kids.map(t => t.quote), list.map(s => s.passage),
      'in the order they were confirmed, which is where the drawer numbers them');
    assert.deepEqual(kids.map(t => Number(t.from_idx) || 0), [0, 1, 2],
      'each says WHICH suggestion in that reply it came from');
    assert.deepEqual(kids.map(t => t.from_msg), [reply.ts, reply.ts, reply.ts]);
    // …and the discussion still holds its own quote, unstruck
    const disc = page.threads.find(x => x.id === brood.id);
    assert.equal(store.markOf(disc), 'highlight');
  });

  await test('…and a fourth suggestion in one reply is refused OUT LOUD', async () => {
    const d = await threadOnPage9('a clause nowhere near the others', 'anything else?');
    await POST(base, '/reply', {
      url: MANU, thread_id: d.id,
      text: '@claude [mock:says:Lots.\\nstrike: one\\nstrike: two\\nstrike: three\\nstrike: four]',
    });
    const reply = await waitFor(async () => {
      const th = (await manuPage()).threads.find(x => x.id === d.id);
      return (th.msgs || []).filter(m => m.author === 'claude'
        && store.strikesOf(m).length === 4).pop();
    }, 'the lift');
    const list = store.strikesOf(reply);
    assert.deepEqual(list.map(s => s.rejected),
      [undefined, undefined, undefined, 'capped'],
      'the first three are offers and the fourth is a visible refusal, never a silent drop');
    // …and the bot hears about it on its next turn here
    await POST(base, '/reply', { url: MANU, thread_id: d.id, text: '@claude what about the fourth?' });
    const env = await waitFor(() => inputs(log).find(x => /what about the fourth\?/.test(x)), 'the envelope');
    assert.match(env, /YOUR LAST `strike:` LINE WAS REFUSED/);
    assert.match(env, /more than 3 suggestions/);
  });

  console.log('\nstrike — the passage a suggestion named for itself');

  const badPassage = async (thread, passage) => POST(base, '/strike-from',
    { url: MANU, thread_id: thread.id, passage, note: 'it should come out' });

  await test('a passage on ANOTHER PAGE is refused — this is a correction, not a teleport', async () => {
    const d = await threadOnPage9('a clause of its own, one', 'hm');
    const r = await badPassage(d, 'the ET-Class formulation');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /different page/);
  });

  await test('…a passage that is nowhere on the page is refused', async () => {
    const d = await threadOnPage9('a clause of its own, two', 'hm');
    const r = await badPassage(d, 'a sentence this manuscript has never contained');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not on this page/);
  });

  await test('…an AMBIGUOUS passage is refused: two matches name neither', async () => {
    const d = await threadOnPage9('a clause of its own, three', 'hm');
    const r = await badPassage(d, 'thermal model is described');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /more than once/);
  });

  await test('…and one running across ANOTHER MARK is refused, span discipline enforced', async () => {
    // the rule of 2026-08-26 said "never re-cover text another mark already
    // covers"; until now nothing could check it. A named passage can be checked.
    const neighbour = await threadOnPage9('repeats the argument', 'this is somebody else’s');
    await POST(base, '/mark', { url: MANU, thread_id: neighbour.id, mark: 'strike' });
    const d = await threadOnPage9('a clause of its own, four', 'hm');
    const r = await badPassage(d, 'four repeats the argument at greater length');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /another mark/);
    // …and the same fault comes back at the LIFT, as a buttonless chip
    await POST(base, '/reply', { url: MANU, thread_id: d.id,
      text: '@claude [mock:says:Try this.\\npassage: four repeats the argument at greater length\\n'
        + 'strike: cut the repetition]' });
    const reply = await waitFor(async () => {
      const th = (await manuPage()).threads.find(x => x.id === d.id);
      return (th.msgs || []).filter(m => m.author === 'claude' && store.strikesOf(m).length).pop();
    }, 'the lift');
    assert.equal(store.strikesOf(reply)[0].rejected, 'covered', 'refused before it was ever a button');
    assert.equal((await manuPage()).threads.filter(t =>
      t.quote === 'four repeats the argument at greater length').length, 0, 'and nothing was marked up');
  });

  // ------------------------------------------------------------------------
  // A CHANGE ON ANOTHER PAGE.
  //
  // THE REPORT, from the reader's own manuscript. A thread on page 13 concluded
  // that a scope sentence belonged in Section 1 — which is on page 2 — and the
  // bot answered: "A page-13 strike cannot add wording on an earlier page; use
  // the Section 1 scope sentence there." That refusal was this companion's own
  // rule working exactly as written, and the rule had simply been outgrown: one
  // discussion legitimately concludes changes on other pages. So a suggestion
  // may now name its page. Nothing is relaxed — the wording must locate on THAT
  // page, once, clear of its other marks — the search just moves.
  // ------------------------------------------------------------------------
  // THE WORD, NOT THE CLAUSE AROUND IT.
  //
  // THE REPORT. Asked to change one word, the bots proposed striking the phrase
  // it sat in — "can stabilize the" for a change to "stabilise",
  // "momentum-conserving motion" where "motion" survives — and the reader was
  // typing "only suggest changes at the word level if that is all you are
  // changing" into the chat by hand. Half of that habit is a rule the bots are
  // now given; the other half is that widening was, until now, the only way to
  // be unambiguous about a word that occurs twice on a page. It is not needed:
  // the suggestion is made inside a discussion, and the discussion says which
  // occurrence is meant.
  console.log('\nstrike — the word, not the clause around it');

  const WORDS = 'https://example.org/word-level.pdf';
  const W5 = 'A reaction wheel can stabilize the platform in yaw. '
    + 'Later work shows the same wheel can stabilize the platform in pitch, '
    + 'which is the claim under discussion here. '
    + 'A tether can stabilize nothing at all.';
  const WSNAP = `<section><h2>Page 5</h2><p>${W5}</p></section>`;
  const wordsPage = async () => (await GET(base, '/page?url=' + enc(WORDS))).json;
  await POST(base, '/page', { url: WORDS, title: 'Word level', kind: 'pdf' });
  {
    const snap = await POST(base, '/snapshot', { url: WORDS, html: WSNAP });
    assert.equal(snap.json.stored, true);
  }

  await test('THE REPORTED CASE: one word struck, though the word occurs three times', async () => {
    // the reader's thread sits beside the SECOND occurrence — that is the
    // sentence they are arguing about
    const t = (await POST(base, '/thread', {
      url: WORDS, quote: 'which is the claim under discussion here', page: 5,
      msg: { text: '@claude “stabilize” should be British spelling.' },
    })).json.thread;
    const r = await POST(base, '/strike-from', {
      url: WORDS, thread_id: t.id, passage: 'stabilize',
      note: 'replace with: "stabilise"',
    });
    assert.equal(r.status, 200, 'a one-word span is not ambiguous — the discussion says which');
    const card = r.json.thread;
    assert.equal(card.quote, 'stabilize', 'the mark is the word, and not the clause round it');
    assert.equal(card.page, 5);
    // the occurrence NEAREST the thread's own anchor: the second one, whose
    // context is "the same wheel can " / " the platform in pitch"
    assert.match(card.prefix, /the same wheel can $/,
      'anchored by the text around where it actually landed');
    assert.match(card.suffix, /^ the platform in pitch/);
    assert.ok(!/yaw/.test(card.suffix), 'not the first occurrence, which is a sentence away');
  });

  await test('…and with no discussion beside either of them it is still refused', async () => {
    // a thread whose own quote is nowhere in this page's text has no locality
    // to lend, and two matches then name neither — exactly as they always did
    const t = (await POST(base, '/thread', {
      url: WORDS, quote: 'a clause this page has never contained', page: 5,
      msg: { text: 'hm' },
    })).json.thread;
    const r = await POST(base, '/strike-from', {
      url: WORDS, thread_id: t.id, passage: 'stabilize', note: 'it should come out',
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /more than once/);
    assert.match(r.json.error, /no nearer one than the other/);
  });

  await test('…and the offer tells the bots to stop widening in the first place', () => {
    const block = store.strikeOfferBlock();
    assert.match(block, /THE MARK COVERS THE CHANGING WORDS, EXACTLY/);
    assert.match(block, /passage: stabilize`, not the clause it sits in/);
    assert.match(block, /Neighbouring words that SURVIVE the change must stay outside the mark/);
    assert.match(block, /DO NOT WIDEN TO BE UNAMBIGUOUS/);
    assert.match(block, /NEAREST the passage under discussion/);
  });

  console.log('\nstrike — a change on another page');

  const CROSS = 'https://example.org/cross-page.pdf';
  const C2 = 'Section 1 sets out the scope of the work. The definition of arm length is '
    + 'given in appendix B. The same claim appears here and the same claim appears here.';
  const C13 = 'Deployment is treated only in passing on this page. '
    + 'The scope sentence really belongs in section 1.';
  const CSNAP = `<section><h2>Page 2</h2><p>${C2}</p></section>`
    + `<section><h2>Page 13</h2><p>${C13}</p></section>`;
  const crossPage = async () => (await GET(base, '/page?url=' + enc(CROSS))).json;
  const threadOnPage13 = async (quote, text) =>
    (await POST(base, '/thread', { url: CROSS, quote, page: 13, msg: { text } })).json.thread;

  await POST(base, '/page', { url: CROSS, title: 'Cross page', kind: 'pdf' });
  {
    const snap = await POST(base, '/snapshot', { url: CROSS, html: CSNAP });
    assert.equal(snap.json.stored, true);
  }

  let far = null;
  let farCard = null;
  await test('THE REPORTED CASE: a page-13 discussion changes a sentence on page 2', async () => {
    far = await threadOnPage13('The scope sentence really belongs in section 1.',
      '@claude where should this actually live?');
    await POST(base, '/reply', {
      url: CROSS, thread_id: far.id,
      text: '@claude [mock:says:In section 1, where the scope is already set out.\n'
        + 'page: 2\n'
        + 'passage: Section 1 sets out the scope of the work.\n'
        + 'strike: replace with: "Section 1 sets out the scope of the work, including deployment."]',
    });
    const reply = await waitFor(async () => {
      const th = (await crossPage()).threads.find(x => x.id === far.id);
      return (th.msgs || []).filter(m => m.author === 'claude' && store.strikesOf(m).length).pop();
    }, 'the lift');
    const [sug] = store.strikesOf(reply);
    assert.equal(sug.rejected, undefined, 'the bot names the page rather than refusing');
    assert.equal(sug.page, 2, 'and the record carries which page it means');
    assert.equal(sug.passage, 'Section 1 sets out the scope of the work.');
    assert.ok(!/^page:/m.test(reply.text), 'the page line is machinery, and comes off the words');
    assert.ok(!/^passage:/m.test(reply.text));
    const r = await POST(base, '/strike-from', {
      url: CROSS, thread_id: far.id, from_msg: reply.ts, from_idx: 0,
      passage: sug.passage, page: sug.page, note: sug.why,
    });
    assert.equal(r.status, 200);
    farCard = r.json.thread;
    assert.equal(farCard.page, 2, 'THE WHOLE POINT: the mark lands on the page it is about');
    assert.equal(farCard.quote, 'Section 1 sets out the scope of the work.');
    assert.match(farCard.suffix, /^ The definition/, 'anchored in PAGE 2’s own context');
    assert.equal(store.markOf(farCard), 'strike');
    assert.equal(farCard.from_thread, far.id, 'an ordinary child of the discussion that decided it');
    const page = await crossPage();
    assert.deepEqual(store.broodOf(page, far.id).map(t => t.id), [farCard.id]);
    assert.equal(page.threads.find(t => t.id === far.id).page, 13,
      'and the discussion itself has not moved an inch');
  });

  await test('…the wrong page named is refused, at the lift and at the door alike', async () => {
    const d = await threadOnPage13('Deployment is treated only in passing on this page.', 'hm');
    // the wording is real, and it is on page 13 — not on the page 2 they named
    const r = await POST(base, '/strike-from', {
      url: CROSS, thread_id: d.id, page: 2,
      passage: 'Deployment is treated only in passing on this page.',
      note: 'it should come out',
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not on page 2/);
    await POST(base, '/reply', { url: CROSS, thread_id: d.id,
      text: '@claude [mock:says:Here.\npage: 2\n'
        + 'passage: Deployment is treated only in passing on this page.\n'
        + 'strike: cut it]' });
    const reply = await waitFor(async () => {
      const th = (await crossPage()).threads.find(x => x.id === d.id);
      return (th.msgs || []).filter(m => m.author === 'claude' && store.strikesOf(m).length).pop();
    }, 'the lift');
    const [sug] = store.strikesOf(reply);
    assert.equal(sug.rejected, 'offpage', 'refused before it was ever a button');
    assert.equal(sug.page, 2, 'and the refusal remembers which page was searched');
    // …and the bot is told which page, not merely "this page"
    await POST(base, '/reply', { url: CROSS, thread_id: d.id, text: '@claude why not?' });
    const env = await waitFor(() => inputs(log).find(x => /why not\?/.test(x)), 'the envelope');
    assert.match(env, /YOUR LAST `strike:` LINE WAS REFUSED/);
    assert.match(env, /page 2/);
  });

  await test('…an AMBIGUOUS wording on the named page is refused there', async () => {
    const d = await threadOnPage13('a clause of its own, far one', 'hm');
    const r = await POST(base, '/strike-from', {
      url: CROSS, thread_id: d.id, page: 2,
      passage: 'same claim appears here', note: 'it should come out',
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /more than once on page 2/);
  });

  await test('…and a page named with no wording names nowhere', async () => {
    const d = await threadOnPage13('a clause of its own, far two', 'hm');
    const r = await POST(base, '/strike-from',
      { url: CROSS, thread_id: d.id, page: 2, note: 'it should come out' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /names where to look and nothing to look for/);
  });

  await test('ONE REPLY, ONE CHANGE HERE AND ONE THERE', async () => {
    const d = await threadOnPage13('Deployment is treated only in passing', 'anything else?');
    await POST(base, '/reply', {
      url: CROSS, thread_id: d.id,
      text: '@claude [mock:says:Two.\n'
        + 'passage: The scope sentence really belongs in section 1.\n'
        + 'strike: it repeats what section 1 already says\n'
        + 'page: 2\n'
        + 'passage: The definition of arm length is given in appendix B.\n'
        + 'strike: replace with: "The definition of arm length is given in section 2."]',
    });
    const reply = await waitFor(async () => {
      const th = (await crossPage()).threads.find(x => x.id === d.id);
      return (th.msgs || []).filter(m => m.author === 'claude'
        && store.strikesOf(m).length === 2).pop();
    }, 'two suggestions');
    const list = store.strikesOf(reply);
    assert.deepEqual(list.map(x => x.rejected), [undefined, undefined]);
    assert.deepEqual(list.map(x => Number(x.page) || 0), [0, 2],
      'the page binds to its own suggestion, and the other one stays here');
    const made = [];
    for (let i = 0; i < 2; i++) {
      const r = await POST(base, '/strike-from', {
        url: CROSS, thread_id: d.id, from_msg: reply.ts, from_idx: i,
        passage: list[i].passage, page: Number(list[i].page) || 0, note: list[i].why,
      });
      assert.equal(r.status, 200, `chip ${i}`);
      assert.equal(r.json.deduped, undefined, `chip ${i} minted rather than deduped`);
      made.push(r.json.thread);
    }
    assert.deepEqual(made.map(t => Number(t.page) || 0), [13, 2],
      'one mark on the page under discussion, one on the page the reply named');
    assert.equal(new Set(made.map(t => t.id)).size, 2);
    assert.equal(store.broodOf(await crossPage(), d.id).length, 2,
      'one discussion, two children, two pages');
  });

  await test('THE EXPORT carries the cross-page mark on the page it was made on', async () => {
    const page = await crossPage();
    const note = exportNote.renderNote(page, store.readConfig(), new Date('2026-08-29T10:00:00Z'));
    assert.ok(note.includes('~~Section 1 sets out the scope of the work.~~'),
      'struck in the note like any other strikeout');
    const at = note.indexOf('Section 1 sets out the scope of the work.');
    assert.match(note.slice(at, at + 400), /— p\. 2/,
      'and attributed to page 2, not to the page the discussion was on');
  });

  console.log('\nstrike — a child changes parents');

  await test('A LATER DISCUSSION MAY TAKE OVER AN EARLIER MARK, and the trace is kept', async () => {
    // editing a long draft surfaces inconsistencies late: this conversation
    // concludes that a mark decided in an earlier one now needs different words
    const later = await threadOnPage9('appendix C', 'this contradicts page 3');
    const child = broodIds[1];
    const before = (await manuPage()).threads.find(t => t.id === child);
    assert.equal(before.from_thread, brood.id, 'it belongs to the first discussion for now');
    const r = await POST(base, '/strike-from', {
      url: MANU, thread_id: later.id,
      passage: 'nobody has measured the damping',
      note: 'replace with: "the damping is measured in section 5"',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.thread.id, child, 'the same red line — never a second one on the passage');
    assert.equal(r.json.adopted, true, 'and the record says the parent changed');
    assert.equal(r.json.updated, true);
    const page = await manuPage();
    const now = page.threads.find(t => t.id === child);
    assert.equal(now.from_thread, later.id, 'ONE parent, and it is the new one');
    assert.deepEqual(now.prior_threads, [brood.id], 'the old one is lineage, not erasure');
    assert.match(now.msgs[0].text, /section 5/);
    assert.equal(store.broodOf(page, brood.id).length, 2, 'the old brood drops it');
    assert.equal(store.broodOf(page, later.id).length, 1, '…and the new one gains it');
  });

  await test('…and adopting it back does not lose where it has been', async () => {
    const child = broodIds[1];
    const r = await POST(base, '/strike-from', {
      url: MANU, thread_id: brood.id,
      passage: 'nobody has measured the damping', note: 'replace with: "measured in section 5"',
    });
    assert.equal(r.json.thread.id, child);
    const now = (await manuPage()).threads.find(t => t.id === child);
    assert.equal(now.from_thread, brood.id);
    assert.equal(now.prior_threads.length, 1, 'the list keeps where it has been, not a loop of it');
  });

  await test('…and a mark that never moved keeps no lineage at all', async () => {
    const still = (await manuPage()).threads.find(t => t.id === broodIds[0]);
    assert.equal('prior_threads' in still, false, 'nothing on disk that did not have to be there');
  });

  await test('THE EXPORT does not care how many children a discussion had', async () => {
    const page = await manuPage();
    const note = exportNote.renderNote(page, store.readConfig(), new Date('2026-08-29T10:00:00Z'));
    for (const q of ['The inflatable-arm literature', 'Deployment is treated only in passing.',
      'appendix B']) {
      assert.ok(note.includes(`~~${q}~~`), `struck in the note: ${q}`);
    }
    assert.match(note, /suggested deletion/);
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
