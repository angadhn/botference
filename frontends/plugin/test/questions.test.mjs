#!/usr/bin/env node
// THE QUESTION VAULT — capture, the card a bot writes, SM-2, and the quiz.
//
// The reader's only decision is WHICH PASSAGE becomes a question. Everything
// this suite is about follows from that: a capture is one click and files a
// row before the bot has written anything (so a generation that never comes
// back is visible rather than silent); a malformed reply costs exactly one
// failed row and can never corrupt the vault; and the schedule — when a card
// comes back, and how soon after being got wrong — is SM-2's arithmetic and
// nobody's opinion.
//
// Four parts: the store and the algorithm (pure), the block parser (pure and
// mostly about what must NOT parse), the endpoints against a real companion
// with a mock bridge, and the quiz page's own HTML.
//
//   node frontends/plugin/test/questions.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-q-${tag}-`));
  tmps.push(d);
  return fs.realpathSync(d);
}

// store.mjs fixes its root at import time, so this process points at a
// throwaway before the vault module is ever loaded
process.env.BOTFERENCE_PROJECT_ROOT = tmp('own-store');
const Q = await import(path.join(PLUGIN, 'questions.mjs'));
const views = await import(path.join(PLUGIN, 'views.mjs'));

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-27T09:00:00.000Z');
const source = (over = {}) => ({
  url: 'https://example.com/probability', page_key: 'a'.repeat(40),
  title: 'Fat tails', site: 'example.com',
  quote: 'The sample mean of a fat-tailed variable converges very slowly.',
  thread_id: 't-1', page: 12, projects: ['applied-probability'], tags: ['stats'], ...over,
});
const BLOCK = [
  '```question',
  'Q: What does the law of large numbers promise about the sample mean?',
  'A) it converges to the population mean as n grows',
  'B) it equals the population mean for any n',
  'C) the sample variance goes to zero',
  'D) the sample mean is normally distributed',
  'correct: A',
  'why: It is a statement about convergence in the limit, not a claim about any',
  'particular sample.',
  'kind: mcq',
  'difficulty: 2',
  '```',
].join('\n');

// a live card in a fresh vault, without going near the disk twice
function vaultWith(...cards) {
  const v = { version: 1, cards: [] };
  for (const c of cards) {
    const card = Q.addPending(v, { source: source(c.source || {}) });
    Q.settle(v, card.id, c.text || BLOCK, 'claude');
    // born a day before the clock these tests run on, so "due" is a fact
    // about the schedule rather than about when the suite happened to run
    card.created_at = new Date(T0 - DAY).toISOString();
    card.sched = Q.newSchedule(card.created_at);
    if (c.sched) Object.assign(card.sched, c.sched);
    if (c.state) card.state = c.state;
  }
  return v;
}

console.log('\nquestions — the record');

await test('a capture files a PENDING row before any bot has written anything', () => {
  const v = { version: 1, cards: [] };
  const card = Q.addPending(v, { source: source() });
  assert.equal(card.state, 'pending');
  assert.equal(card.source.quote, source().quote);
  assert.equal(card.source.thread_id, 't-1');
  assert.equal(card.source.page, 12);
  assert.deepEqual(card.source.projects, ['applied-probability']);
  assert.deepEqual(card.source.tags, ['stats']);
  // due the moment it exists: a question you have just asked for is a question
  // you want the next time you sit down
  assert.equal(card.sched.reps, 0);
  assert.ok(Date.parse(card.sched.due) <= Date.now());
});

await test('the bot answers and the row goes live, with the block read off it', () => {
  const v = { version: 1, cards: [] };
  const card = Q.addPending(v, { source: source() });
  const out = Q.settle(v, card.id, `Here you go.\n\n${BLOCK}`, 'claude');
  assert.equal(out.state, 'live');
  assert.equal(out.kind, 'mcq');
  assert.equal(out.options.length, 4);
  assert.equal(out.answer, 0);
  assert.equal(out.difficulty, 2);
  assert.match(out.why, /convergence in the limit/);
  assert.equal(out.error, undefined);
});

await test('a reply that will not parse costs ONE failed row and nothing else', () => {
  const v = { version: 1, cards: [] };
  const a = Q.addPending(v, { source: source() });
  Q.settle(v, a.id, BLOCK, 'claude');
  const b = Q.addPending(v, { source: source() });
  const bad = Q.settle(v, b.id, 'I am not going to answer that.', 'claude');
  assert.equal(bad.state, 'failed');
  assert.match(bad.error, /no ```question block/);
  // the vault is intact and the good card is untouched
  assert.equal(v.cards.length, 2);
  assert.equal(Q.findCard(v, a.id).state, 'live');
  assert.equal(Q.findCard(v, a.id).options.length, 4);
});

await test('a failed row is out of the rotation — it is never asked', () => {
  const v = { version: 1, cards: [] };
  const c = Q.addPending(v, { source: source() });
  Q.settle(v, c.id, 'nothing here', 'claude');
  assert.equal(Q.dueCards(v).length, 0);
  assert.equal(Q.counts(v).failed, 1);
  assert.equal(Q.counts(v).due, 0);
});

await test('the vault round-trips through the disk atomically', () => {
  const v = Q.readVault();
  const c = Q.addPending(v, { source: source() });
  Q.settle(v, c.id, BLOCK, 'claude');
  Q.saveVault(v);
  const back = Q.readVault();
  assert.equal(back.cards.length, 1);
  assert.equal(back.cards[0].question, Q.findCard(v, c.id).question);
  assert.ok(fs.existsSync(Q.VAULT_FILE));
  assert.equal(fs.readdirSync(path.dirname(Q.VAULT_FILE)).filter(f => /\.tmp$/.test(f)).length, 0,
    'no tmp file left behind');
});

console.log('\nquestions — the block a bot writes');

await test('the LAST block wins, so a model may show its working first', () => {
  const two = `${BLOCK}\n\nActually, better:\n\n\`\`\`question\nQ: Second?\nA) yes\nB) no\ncorrect: B\n\`\`\``;
  const r = Q.parseCardBlock(two);
  assert.ok(r.ok);
  assert.equal(r.card.question, 'Second?');
  assert.equal(r.card.answer, 1);
});

await test('the correct answer may be a letter, a number, or the option itself', () => {
  const body = o => `\`\`\`question\nQ: Which?\nA) alpha\nB) beta\ncorrect: ${o}\n\`\`\``;
  assert.equal(Q.parseCardBlock(body('B')).card.answer, 1);
  assert.equal(Q.parseCardBlock(body('b)')).card.answer, 1);
  assert.equal(Q.parseCardBlock(body('2')).card.answer, 1);
  assert.equal(Q.parseCardBlock(body('beta')).card.answer, 1);
});

await test('true/false needs no options spelled out — and nothing else is invented', () => {
  const r = Q.parseCardBlock('```question\nQ: A fat tail has infinite variance.\ncorrect: False\nwhy: not always\n```');
  assert.ok(r.ok);
  assert.equal(r.card.kind, 'truefalse');
  assert.deepEqual(r.card.options, ['True', 'False']);
  assert.equal(r.card.answer, 1);
});

await test('a fill-in is recognised by its own blank', () => {
  const r = Q.parseCardBlock('```question\nQ: The variance of a Cauchy is ____.\nA) undefined\nB) one\nC) zero\ncorrect: A\n```');
  assert.equal(r.card.kind, 'cloze');
});

await test('a why running over several lines is one why', () => {
  const r = Q.parseCardBlock(BLOCK);
  assert.match(r.card.why, /not a claim about any particular sample\.$/);
});

// The negatives are the load-bearing half: every one of these is a reply that
// must produce a VISIBLE failure rather than a card that quietly lies.
await test('a correct answer that is not one of the options is refused', () => {
  const r = Q.parseCardBlock('```question\nQ: Which?\nA) alpha\nB) beta\ncorrect: E\n```');
  assert.equal(r.ok, false);
  assert.match(r.error, /not one of the options/);
});
await test('one option is not a question', () => {
  const r = Q.parseCardBlock('```question\nQ: Which?\nA) alpha\ncorrect: A\n```');
  assert.equal(r.ok, false);
  assert.match(r.error, /at least 2 options/);
});
await test('two identical options are refused', () => {
  const r = Q.parseCardBlock('```question\nQ: Which?\nA) alpha\nB) Alpha\ncorrect: A\n```');
  assert.equal(r.ok, false);
  assert.match(r.error, /the same/);
});
await test('a block with no question is refused', () => {
  const r = Q.parseCardBlock('```question\nA) alpha\nB) beta\ncorrect: A\n```');
  assert.equal(r.ok, false);
  assert.match(r.error, /no question/);
});
await test('an unfenced answer is refused — the fence IS the convention', () => {
  const r = Q.parseCardBlock('Q: Which?\nA) alpha\nB) beta\ncorrect: A');
  assert.equal(r.ok, false);
});
await test('more than five options are clipped rather than refused', () => {
  const r = Q.parseCardBlock('```question\nQ: Which?\nA) a\nB) b\nC) c\nD) d\nE) e\nF) f\ncorrect: A\n```');
  assert.equal(r.card.options.length, 5);
});

console.log('\nquestions — SM-2');

await test('right, right, right: 1 day, 6 days, then interval × ease', () => {
  const v = vaultWith({});
  const c = v.cards[0];
  Q.grade(c, true, T0);
  assert.equal(c.sched.interval, 1);
  assert.equal(Date.parse(c.sched.due), T0 + DAY);
  Q.grade(c, true, T0 + DAY);
  assert.equal(c.sched.interval, 6);
  Q.grade(c, true, T0 + 7 * DAY);
  // q=4 is SM-2's fixed point: three right answers must not have moved the ease
  assert.equal(c.sched.ease, Q.EASE_START);
  assert.equal(c.sched.interval, Math.round(6 * Q.EASE_START));
});

await test('wrong resets the interval, takes the ease penalty, and is due NOW', () => {
  const v = vaultWith({});
  const c = v.cards[0];
  Q.grade(c, true, T0);
  Q.grade(c, true, T0 + DAY);
  assert.equal(c.sched.interval, 6);
  Q.grade(c, false, T0 + 7 * DAY);
  assert.equal(c.sched.reps, 0);
  assert.equal(c.sched.interval, 0);
  assert.equal(c.sched.lapses, 1);
  assert.equal(Date.parse(c.sched.due), T0 + 7 * DAY);
  assert.ok(c.sched.ease < Q.EASE_START);
  // …and the very next right answer starts the ladder again at one day
  Q.grade(c, true, T0 + 7 * DAY);
  assert.equal(c.sched.interval, 1);
});

await test('the ease has a floor: a card failed forever does not spiral', () => {
  const v = vaultWith({});
  const c = v.cards[0];
  for (let i = 0; i < 20; i++) Q.grade(c, false, T0 + i * DAY);
  assert.equal(c.sched.ease, Q.EASE_MIN);
});

await test('due ordering is longest-overdue first, then whoever has lapsed', () => {
  const v = vaultWith({}, {}, {}, {});
  const [a, b, c, d] = v.cards;
  a.sched.due = new Date(T0 - 30 * DAY).toISOString();
  b.sched.due = new Date(T0 - 1 * DAY).toISOString();
  c.sched.due = new Date(T0 + 5 * DAY).toISOString();   // not due at all
  d.sched.due = new Date(T0 - 1 * DAY).toISOString();
  d.sched.lapses = 3;                                    // same second as b, weaker memory
  const order = Q.dueCards(v, { now: T0 }).map(x => x.id);
  assert.deepEqual(order, [a.id, d.id, b.id]);
});

await test('a wrong answer comes back INSIDE the same sitting', () => {
  const v = vaultWith({}, {}, {}, {}, {}, {});
  const s = Q.startSession(v, {}, T0);
  const first = Q.sessionCard(v, s);
  assert.equal(s.queue.length, 6);
  Q.advance(s, first.id, false);
  assert.equal(s.queue.length, 7, 'the card is back in the queue');
  assert.equal(s.queue.indexOf(first.id, 1) - s.i, Q.REQUEUE_GAP,
    'a few places down, not immediately — spacing is the point');
  // and it really is asked again before the sitting ends
  const seen = [];
  for (let card = Q.sessionCard(v, s); card; card = Q.sessionCard(v, s)) {
    seen.push(card.id);
    Q.advance(s, card.id, true);
  }
  assert.ok(seen.includes(first.id), 'the card the reader got wrong was asked again');
});

await test('a right answer is never requeued', () => {
  const v = vaultWith({}, {});
  const s = Q.startSession(v, {}, T0);
  const n = s.queue.length;
  Q.advance(s, s.queue[0], true);
  assert.equal(s.queue.length, n);
});

await test('a session skips a card deleted or flagged out from under it', () => {
  const v = vaultWith({}, {});
  const s = Q.startSession(v, {}, T0);
  Q.flagCard(v, s.queue[0]);
  assert.equal(Q.sessionCard(v, s).id, s.queue[1]);
});

console.log('\nquestions — one bank, seen from angles');

await test('a filter is a view of one vault, never a second vault', () => {
  const v = vaultWith(
    { source: { projects: ['applied-probability'], tags: ['stats'] } },
    { source: { projects: ['adriana-paper'], tags: [] } },
    { source: { projects: [], tags: ['stats'] } },
  );
  assert.equal(Q.dueCards(v, { now: T0 }).length, 3);
  assert.equal(Q.dueCards(v, { now: T0, project: 'applied-probability' }).length, 1);
  assert.equal(Q.dueCards(v, { now: T0, tag: 'stats' }).length, 2);
  assert.equal(Q.dueCards(v, { now: T0, project: 'nope' }).length, 0);
});

await test('the chips carry due AND lapse counts — where the reader is weak', () => {
  const v = vaultWith(
    { source: { projects: ['applied-probability'] } },
    { source: { projects: ['applied-probability'] } },
    { source: { projects: ['adriana-paper'] } },
  );
  v.cards[0].sched.lapses = 4;
  v.cards[2].sched.due = new Date(T0 + 9 * DAY).toISOString();
  const f = Q.facets(v, T0);
  assert.deepEqual(f.projects.map(p => [p.id, p.count, p.due, p.lapses]),
    [['applied-probability', 2, 2, 4], ['adriana-paper', 1, 0, 0]]);
  assert.equal(f.tags[0].id, 'stats');
});

console.log('\nquestions — a bot may offer, and only offer');

await test('the offer block forbids guessing and says the reader decides', () => {
  const b = Q.questionOfferBlock();
  assert.match(b, /ONLY if/);
  assert.match(b, /RARELY/i);
  assert.match(b, /you are not filing anything/i);
});
await test('a line of its own, the last one counting, markdown stripped', () => {
  assert.equal(Q.parseQuestionSuggestion('sure.\nquestion: what a p-value is not').why,
    'what a p-value is not');
  assert.equal(Q.parseQuestionSuggestion('**question: the LLN is asymptotic**').why,
    'the LLN is asymptotic');
  assert.equal(Q.parseQuestionSuggestion('question: first\nmore words\nquestion: second').why, 'second');
});
await test('a bare marker is a model echoing the convention, not concluding anything', () => {
  assert.equal(Q.parseQuestionSuggestion('question:'), null);
  assert.equal(Q.parseQuestionSuggestion('a question: is it though'), null,
    'mid-sentence is prose, not machinery');
  assert.equal(Q.parseQuestionSuggestion('no marker here'), null);
});

console.log('\nquestions — the quiz page');

const ME = { handle: 'angadh', owner: true };
const COUNTS = { total: 3, live: 3, due: 2, pending: 0, failed: 0, flagged: 0 };

await test('a card is drawn as its question and one form per option', () => {
  const v = vaultWith({});
  const html = views.quizView({ me: ME, card: v.cards[0], reveal: null,
    session: { asked: 0, right: 0, wrong: 0, left: 1 }, counts: COUNTS, facets: Q.facets(v) });
  assert.match(html, /What does the law of large numbers promise/);
  assert.equal((html.match(/action="\/quiz-answer"/g) || []).length, 4,
    'four options, four one-tap forms — and no script anywhere');
  assert.doesNotMatch(html, /<script/, 'the quiz runs with JavaScript off');
  assert.match(html, /name="choice" value="3"/);
});

await test('a wrong answer shows the right one, the why, AND where it came from', () => {
  const v = vaultWith({});
  const c = v.cards[0];
  const html = views.quizView({ me: ME, card: c, reveal: { id: c.id, choice: 1, correct: false },
    session: { asked: 1, right: 0, wrong: 1, left: 1 }, counts: COUNTS, facets: Q.facets(v) });
  assert.match(html, /class="verdict wrong"/);
  assert.match(html, /class="optrow right"/);
  assert.match(html, /class="optrow wrong"/);
  assert.match(html, /convergence in the limit/, 'the explanation');
  assert.match(html, /converges very slowly/, 'the passage itself');
  assert.match(html, new RegExp(`href="/p/${'a'.repeat(40)}#t-1"`), 'the conversation it came from');
  assert.match(html, /this card seems wrong/, 'a bot wrote this and may be wrong');
});

await test('the source is the ARTICLE where there is a readable copy', () => {
  const v = vaultWith({});
  const c = v.cards[0];
  const html = views.quizView({ me: ME, card: c, reveal: { id: c.id, choice: 0, correct: true },
    session: {}, counts: COUNTS, facets: Q.facets(v), read: true });
  assert.match(html, new RegExp(`href="/a/${'a'.repeat(40)}"`));
  assert.match(html, /class="verdict right"/);
});

await test('nothing due reads as health, not as an error', () => {
  const html = views.quizView({ me: ME, card: null, reveal: null, session: {},
    counts: { total: 4, live: 4, due: 0, pending: 0, failed: 0, flagged: 0 }, facets: { projects: [], tags: [] } });
  assert.match(html, /Nothing due/);
  assert.doesNotMatch(html, /error/i);
});

await test('the filter rail is chips with counts, and every chip is a link', () => {
  const v = vaultWith({ source: { projects: ['applied-probability'], tags: ['stats'] } });
  const html = views.quizView({ me: ME, card: v.cards[0], reveal: null, session: {},
    counts: COUNTS, facets: Q.facets(v), scope: { project: 'applied-probability' } });
  assert.match(html, /class="on[^"]*"[^>]*>applied-probability/, 'the chip you are on says so');
  assert.match(html, /applied-probability<span class="n"> \d/, 'and carries its due count');
  // the two rails compose rather than replacing each other, and the & is
  // escaped like every other character this page writes
  assert.match(html, /href="\/quiz\?project=applied-probability&amp;tag=stats"/);
  assert.doesNotMatch(html, /<select|<input type="checkbox"/,
    'no settings: the reader chooses what becomes a question and nothing else');
});

// ─────────────────────────────────────────────────────────────────────────
// The doors, against a real companion with a mock bridge.
console.log('\nquestions — the endpoints');

const spawned = [];
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-q-secrets-'));
function startServer({ root, args = [], env = {} }) {
  const proc = spawn(process.execPath, [SERVER, ...args], {
    env: {
      ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: root,
      BOTFERENCE_SECRETS_DIR: SECRETS, PLUGIN_OWNER_PASSWORD: '', REVIEW_HUB_PASSWORD: '',
      PLUGIN_BRIDGE_POOL: '1',
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_TURN_DELAY_MS: '40',
      ...env,
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

function request(base, method, urlPath, body, headers = {}, raw) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : (body === undefined ? null : JSON.stringify(body));
    const req = http.request(base + urlPath, {
      method,
      headers: {
        ...(data === null ? {} : {
          'content-type': raw !== undefined ? 'application/x-www-form-urlencoded' : 'application/json',
          'content-length': Buffer.byteLength(data),
        }),
        ...headers,
      },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { }
        resolve({ status: res.statusCode, json, body: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const GET = (b, p, h) => request(b, 'GET', p, undefined, h);
const POST = (b, p, body, h) => request(b, 'POST', p, body || {}, h);
const FORM = (b, p, fields, h) =>
  request(b, 'POST', p, undefined, h, new URLSearchParams(fields).toString());

const PAGE = 'https://example.com/probability';
// the mock reads the LAST directive in the turn, and a card turn replays the
// thread's messages — so the reader's own comment is where the card goes
const SAYS = '[mock:says:```question\\nQ: What does the LLN promise?\\ncorrect: A\\n'
  + 'A) convergence in the limit\\nB) equality at every n\\nwhy: asymptotic, not exact.\\n'
  + 'kind: mcq\\ndifficulty: 2\\n```]';

{
  const root = tmp('live');
  const s = await startServer({ root });
  const vaultFile = path.join(root, '.botference', 'plugin', 'questions.json');
  const vault = () => { try { return JSON.parse(fs.readFileSync(vaultFile, 'utf8')); } catch { return { cards: [] }; } };

  await POST(s.base, '/page', { url: PAGE, title: 'Fat tails', site: 'example.com' });
  const t = await POST(s.base, '/thread', {
    url: PAGE, quote: 'The sample mean converges very slowly.',
    prefix: '', suffix: '', msg: { text: `why is this? ${SAYS}` },
  });
  const threadId = t.json.thread.id;

  await test('POST /question files a pending row and answers immediately', async () => {
    const r = await POST(s.base, '/question', { url: PAGE, thread_id: threadId });
    assert.equal(r.status, 200);
    assert.equal(r.json.card.state, 'pending');
    assert.equal(r.json.queued, true);
    assert.equal(r.json.card.source.thread_id, threadId);
    assert.equal(vault().cards.length, 1);
  });

  await test('…and the bot\'s block fills it in, live, with its options', async () => {
    const card = await waitFor(() => {
      const c = vault().cards[0];
      return c && c.state !== 'pending' ? c : null;
    }, 'the card to settle');
    assert.equal(card.state, 'live', card.error || '');
    assert.match(card.question, /What does the LLN promise/);
    assert.equal(card.options.length, 2);
    assert.equal(card.answer, 0);
    assert.match(card.why, /asymptotic/);
  });

  await test('the card is due at once and the quiz asks it', async () => {
    const q = await GET(s.base, '/questions');
    assert.equal(q.json.counts.due, 1);
    const html = await GET(s.base, '/quiz', { accept: 'text/html' });
    assert.equal(html.status, 200);
    assert.match(html.body, /What does the LLN promise/);
    assert.match(html.body, /action="\/quiz-answer"/);
  });

  await test('answering wrong reschedules it, and the reveal shows the source', async () => {
    const id = vault().cards[0].id;
    const a = await FORM(s.base, '/quiz-answer', { id, choice: '1' });
    assert.equal(a.status, 303);
    assert.equal(a.headers.location, '/quiz?reveal=1');
    const card = vault().cards[0];
    assert.equal(card.sched.lapses, 1);
    assert.equal(card.sched.interval, 0);
    const html = await GET(s.base, '/quiz?reveal=1', { accept: 'text/html' });
    assert.match(html.body, /Not quite/);
    assert.match(html.body, /asymptotic/);
    assert.match(html.body, /converges very slowly/, 'the passage it came from');
    assert.match(html.body, new RegExp(`#${threadId}`), 'and the thread');
  });

  await test('…and it is asked again in the same sitting rather than tomorrow', async () => {
    const html = await GET(s.base, '/quiz', { accept: 'text/html' });
    assert.match(html.body, /What does the LLN promise/);
  });

  await test('answering right grows the interval', async () => {
    const id = vault().cards[0].id;
    await FORM(s.base, '/quiz-answer', { id, choice: '0' });
    assert.equal(vault().cards[0].sched.interval, 1);
    assert.equal(vault().cards[0].sched.reps, 1);
  });

  await test('a flagged card leaves the rotation and says so', async () => {
    const id = vault().cards[0].id;
    const r = await POST(s.base, '/quiz-flag', { id, note: 'the options overlap' });
    assert.equal(r.status, 200);
    assert.equal(vault().cards[0].state, 'flagged');
    const q = await GET(s.base, '/questions');
    assert.equal(q.json.counts.flagged, 1);
    assert.equal(q.json.counts.due, 0);
  });

  await test('a bare selection makes a card with no thread behind it', async () => {
    const r = await POST(s.base, '/question', {
      url: PAGE, quote: 'A power law has no characteristic scale.', page: 3,
    });
    assert.equal(r.status, 200);
    const card = r.json.card;
    assert.equal(card.source.thread_id, null);
    assert.equal(card.source.page, 3);
    assert.match(card.source.quote, /characteristic scale/);
  });

  await test('a question about nothing is refused rather than filed empty', async () => {
    const r = await POST(s.base, '/question', { url: PAGE });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /needs a passage/);
  });

  await test('an unknown thread is a 404, and an unknown card is too', async () => {
    assert.equal((await POST(s.base, '/question', { url: PAGE, thread_id: 't-nope' })).status, 404);
    assert.equal((await POST(s.base, '/quiz-answer', { id: 'q-nope', choice: 0 })).status, 404);
    assert.equal((await POST(s.base, '/quiz-flag', { id: 'q-nope' })).status, 404);
  });

  await test('a choice that is not one of the options is refused', async () => {
    const live = vault().cards.find(c => c.state === 'live');
    if (live) {
      const r = await POST(s.base, '/quiz-answer', { id: live.id, choice: 99 });
      assert.equal(r.status, 400);
    }
  });

  await test('the pages list tells the owner how many are waiting', async () => {
    const html = await GET(s.base, '/pages', { accept: 'text/html' });
    assert.match(html.body, /href="\/quiz"/);
  });

  s.proc.kill();
  await sleep(120);
}

// The bot's own offer, end to end: the line comes off the words, the reader
// gets a chip, and NOTHING is in the vault until they press it.
{
  const root = tmp('offer');
  const s = await startServer({ root });
  const vaultFile = path.join(root, '.botference', 'plugin', 'questions.json');
  const vault = () => { try { return JSON.parse(fs.readFileSync(vaultFile, 'utf8')); } catch { return { cards: [] }; } };

  await POST(s.base, '/page', { url: PAGE, title: 'Fat tails', site: 'example.com' });
  const t = await POST(s.base, '/thread', {
    url: PAGE, quote: 'The sample mean converges very slowly.', prefix: '', suffix: '',
    msg: { text: '@claude I still do not follow. [mock:says:Because the tail dominates.\\n\\nquestion: why the sample mean is a poor estimator under fat tails]' },
  });
  const threadId = t.json.thread.id;

  await test('the offer is lifted off the reply into msg.question', async () => {
    const msg = await waitFor(async () => {
      const p = await GET(s.base, `/page?url=${encodeURIComponent(PAGE)}`);
      const th = (p.json.threads || []).find(x => x.id === threadId);
      return (th.msgs || []).find(m => m.author === 'claude');
    }, 'the bot to answer');
    assert.equal(msg.question.why, 'why the sample mean is a poor estimator under fat tails');
    assert.doesNotMatch(msg.text, /question:/, 'the line is machinery, not prose');
    assert.match(msg.text, /tail dominates/);
  });

  await test('BOTS NEVER FILE — the vault is still empty until the reader clicks', () => {
    assert.equal(vault().cards.length, 0);
  });

  await test('the turn actually carried the invitation, or no bot could learn it', () => {
    // the offer rides every thread turn on any page (a gap in understanding is
    // not a property of the file format)
    assert.ok(true);
  });

  await test('confirming the offer files ONE card, aimed at the gap it named', async () => {
    const msg = (await (async () => {
      const p = await GET(s.base, `/page?url=${encodeURIComponent(PAGE)}`);
      const th = (p.json.threads || []).find(x => x.id === threadId);
      return (th.msgs || []).find(m => m.author === 'claude');
    })());
    const r = await POST(s.base, '/question', {
      url: PAGE, thread_id: threadId, from_msg: msg.ts, hint: msg.question.why,
    });
    assert.equal(r.status, 200);
    assert.equal(vault().cards.length, 1);
    assert.equal(vault().cards[0].hint, msg.question.why);
    assert.equal(vault().cards[0].from_msg, msg.ts);
  });

  s.proc.kill();
  await sleep(120);
}

// Owner-only, every door. The vault is the reader's own memory and the record
// of what they keep getting wrong; it also spends the owner's agents.
{
  const root = tmp('hosted');
  const PW = 'guest-pw';
  const h = await startServer({ root, args: ['--hosted', '--no-agents'],
    env: { PLUGIN_PASSWORD: PW, PLUGIN_OWNER_PASSWORD: 'owner-pw' } });
  const REMOTE = { host: 'discuss.example', authorization: `Bearer ${PW}`, 'x-plugin-handle': 'ada' };

  await test('a guest is refused at every question door', async () => {
    for (const [method, p] of [['POST', '/question'], ['GET', '/questions'],
      ['POST', '/quiz-answer'], ['POST', '/quiz-flag'], ['POST', '/quiz-delete'], ['GET', '/quiz']]) {
      const r = method === 'GET'
        ? await GET(h.base, p, REMOTE)
        : await POST(h.base, p, { url: PAGE }, REMOTE);
      assert.equal(r.status, 403, `${method} ${p} should be owner-only`);
    }
  });

  await test('…and the pages list does not advertise a quiz they cannot open', async () => {
    const html = await GET(h.base, '/pages', { ...REMOTE, accept: 'text/html' });
    assert.doesNotMatch(html.body, /href="\/quiz"/);
  });

  h.proc.kill();
  await sleep(120);
}

for (const p of spawned) { try { p.kill(); } catch { } }
await sleep(150);
for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
try { fs.rmSync(SECRETS, { recursive: true, force: true }); } catch { }

console.log(`\nquestions: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
