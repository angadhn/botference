// blyg-title.test.mjs — a post's TITLE: the owner's first line `# Title` becomes the note's `title:` and leaves the body; nothing else
// about a note changes. Front matter is read by a real YAML parser (Ruby's Psych, when ruby is on the PATH). Includes one test through the
// hub link (a stand-alone Compose post and a reply, each starting `# A title`) into the real publisher and queue.
//
//   node --test test/blyg-title.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as N from '../blyg-note.mjs';
import * as L from '../hub-link.mjs';
import * as R from '../blyg-run.mjs';
import * as Q from '../blyg-queue.mjs';
import { makeRig, until, mine as rigMine } from './blyg-rig.mjs';

const hasRuby = (() => { try { execFileSync('ruby', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const yamlOf = text => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'the note opens with front matter');
  return JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-rdate', '-e',
    'puts JSON.generate(YAML.safe_load(ARGF.read, permitted_classes: [Date, Time]), quirks_mode: true)'], { input: m[1], encoding: 'utf8' }));
};
const rb = hasRuby ? test : test.skip;
const NOW = new Date('2026-11-23T12:00:00Z');
const BID = '0000000000000000000000000z';
const mine = (text, extra = {}) => ({ author: 'owner', ts: '2026-11-22T10:00:00Z', text, provenance: 'owner-typed', ...extra });
const page = { url: 'https://news.example.com/p1', title: 'Page 1', threads: [] };
const alone = { url: 'https://blog.example.test/hub-compose', title: 'Posts', threads: [], stand_alone: true };
const home = { folder: '/x', filename: '${slug}.md', timezone: 'Europe/London', escape: 'liquid' };
const render = (pg, threads, extra = {}) => N.renderShortNote({ page: pg, threads, home, now: NOW, slug: 'x', id: BID, ...extra });
const one = (text, extra = {}) => render(alone, [{ id: 't', quote: '', msgs: [mine(text)] }], extra);
const body = r => r.text.replace(/^---\n[\s\S]*?\n---\n/, '');

test('a first line `# Title` is the title, leaves the body, and the body is otherwise as typed', () => {
  const r = one('# A title\n\nBody text.\n\nSecond paragraph.');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.title, 'A title');
  assert.match(r.text, /^---\ntitle: "A title"\ncreated: /);
  assert.equal(body(r), 'Body text.\n\nSecond paragraph.\n');
  assert.equal(body(one('Body text.\n\nSecond paragraph.')), body(r));
});

test('what is not a title line stays exactly as today (byte for byte)', () => {
  for (const t of ['## Heading\n\nBody.', '#tag and words\n\nBody.', '#\n\nBody.', 'First line.\n\n# Later heading\n\nBody.', '```\n# in a fence\n```\n\nBody.',
    '#  \n\nBody.', '    # indented\n\nBody.', '#\tTab\n\nBody.']) {
    const a = one(t); const b = one(t, { titleFrom: 'words' });
    assert.equal(a.ok, true, `${JSON.stringify(t)} ${a.error}`);
    assert.equal(a.text, b.text, JSON.stringify(t));
    assert.doesNotMatch(a.text, /^title:/m, JSON.stringify(t));
  }
});

test('a /quote line or a /tk line before it means it is not first, so it is not a title', () => {
  const q = render(page, [{ id: 't', quote: 'A passage.', msgs: [mine('/quote\n# Not a title\n\nWords.')] }]);
  assert.equal(q.ok, true, q.error);
  assert.doesNotMatch(q.text, /^title:/m);
  assert.match(q.text, /# Not a title/);
  const gap = { instruction: 'say hello', mode: 'filled-by-agent', agent: 'claude', model: 'claude-opus-5', at: '2026-11-24T10:00:00Z', text: 'Hello.' };
  const tk = render(page, [{ id: 't', quote: '', msgs: [mine('/tk(say hello)\n# Not a title\n\nWords.', { gaps: [gap] })] }]);
  assert.equal(tk.ok, true, tk.error);
  assert.doesNotMatch(tk.text, /^title:/m);
  assert.match(tk.text, /# Not a title/);
  const mid = render(page, [{ id: 't', quote: '', msgs: [mine('# Title /tk(say hello)\n\nWords.', { gaps: [gap] })] }]);
  assert.doesNotMatch(mid.text || '', /^title:/m, 'a /tk instruction on the line: not a title');
});

test('a reply that quotes a passage: the title is the first line of the owner\'s own words, the quote card is not their text', () => {
  const r = render(page, [{ id: 't', quote: 'A quoted passage here.', msgs: [mine('# A title\n\nMy reply to it.')] }]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.title, 'A title');
  assert.match(r.text, /^---\ntitle: "A title"\n/);
  assert.equal(body(r), 'My reply to it.\n\n> A quoted passage here.\n>\n> https://news.example.com/p1\n');
});

test('over the limit: the title is cut at a word and the WHOLE line stays as the first line of the body; nothing refused', () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const r = one(`# ${words}\n\nBody.`);
  assert.equal(r.ok, true);
  assert.ok(r.title.length <= N.LIMITS.postTitleChars);
  assert.ok(words.startsWith(r.title) && words[r.title.length] === ' ', 'cut at a word boundary, no ellipsis');
  assert.equal(body(r), `# ${words}\n\nBody.\n`);
  const edge = one(`# ${'x'.repeat(300)}\n\nBody.`);
  assert.equal(edge.title.length, N.LIMITS.postTitleChars);
  assert.match(body(edge), /^# x{300}\n\nBody\.\n$/);
});

test('a post that is only a title keeps today\'s behaviour (the line stays a heading; an empty post is still refused)', () => {
  const r = one('# Only a title');
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /^title:/m);
  assert.equal(body(r), '# Only a title\n');
  assert.equal(r.text, one('# Only a title', { titleFrom: 'words' }).text);
  assert.equal(one('   ').ok, false);
  assert.throws(() => N.titleFromMove('words', 'line'), /cannot move/);
  assert.throws(() => N.titleFromMove('line', 'other'), /unknown/);
});

test('an agent passage never sets a title: only the owner\'s typed first line can', () => {
  const g = { instruction: 'a title please', mode: 'filled-by-agent', agent: 'claude', model: 'claude-opus-5', at: '2026-11-24T10:00:00Z', text: '# Agent heading' };
  const filled = render(alone, [{ id: 't', quote: '', msgs: [mine('/tk(a title please)\n\nWords.', { gaps: [g] })] }]);
  assert.equal(filled.ok, true, filled.error);
  assert.doesNotMatch(filled.text, /^title:/m);
  assert.equal(one('/tk(a title please)\n\nWords.').ok, false, 'an unfilled instruction still blocks');
});

test('the title is the post\'s own name: the file name slug comes from it through slugOf', () => {
  const r = one('# Spinning a Station: Easy to Say!\n\nBody.');
  assert.equal(N.slugOf(r.title, { date: '2026-11-23' }), 'spinning-a-station-easy-to-say');
  assert.equal(N.slugOf(one('# 🚀🚀\n\nBody.').title, { date: '2026-11-23' }), 'note-20261123');
});

test('a new version takes the title only from the post\'s FIRST message, as it stands now', () => {
  const t = msgs => [{ id: 't', quote: '', msgs }];
  const base = [mine('# First title\n\nBody.', { ts: 'a1' })];
  assert.equal(render(alone, t(base)).title, 'First title');
  const later = [...base, mine('# A later heading\n\nMore.', { ts: 'a2' })];
  const r = render(alone, t(later));
  assert.equal(r.title, 'First title', 'a later message does not retitle');
  assert.match(body(r), /^Body\.\n\n# A later heading\n\nMore\.\n$/);
  const changed = render(alone, t([mine('# New title\n\nBody.', { ts: 'a1' }), later[1]]));
  assert.equal(changed.title, 'New title');
  const removed = render(alone, t([mine('Body.', { ts: 'a1' }), later[1]]));
  assert.doesNotMatch(removed.text, /^title:/m);
  assert.match(body(removed), /# A later heading/);
  const added = render(alone, t([mine('# Added later\n\nBody.', { ts: 'a1' })]), { keep: { created: '2026-11-20', released: '2026-11-20', before: removed.text, generated: [] } });
  assert.equal(added.ok, true, added.error);
  assert.equal(added.title, 'Added later');
  assert.match(added.text, /^created: "?2026-11-20|created: 2026-11-20/m);
  // the title is part of what an edit of the first message changes
  assert.notDeepEqual(render(alone, t(base)).snapshot.threads[0].msgs, render(alone, t([mine('Body.', { ts: 'a1' })])).snapshot.threads[0].msgs);
});

test('a template with its own `title:` line is filled once, never doubled; a `${title}` template keeps its place', () => {
  const lit = one('# Mine\n\nBody.', { home: undefined });
  assert.equal((lit.text.match(/^title:/gm) || []).length, 1);
  const t = N.renderShortNote({ page: alone, threads: [{ id: 't', quote: '', msgs: [mine('# Mine\n\nBody.')] }], home: { ...home, template: 'title: ${title}\ncreated: ${created}\nreleased: "${released}"\nblyg: true\nblyg_id: "${id}"\npermalink: /b/${id}\n${blyg_keys}' }, now: NOW, slug: 'x', id: BID });
  assert.equal((t.text.match(/^title:/gm) || []).length, 1);
  assert.match(t.text, /^---\ntitle: "Mine"\ncreated:/);
});

rb('hostile titles round-trip through a real YAML parser', () => {
  for (const title of ['Quote "double" and \'single\'', 'Colon: here, and # hash', '- leading dash', '"starts with a quote"', 'null', 'true', '123', '2026-11-23',
    'Ünïcödé — 日本語', 'Emoji 🚀 title', 'back\\slash', '@at and `tick` and *star* and _under_', '[bracketed] & ampersand !bang %percent', '? question', '| pipe', 'a: b: c']) {
    const r = one(`# ${title}\n\nBody.`);
    assert.equal(r.ok, true, `${title}: ${r.error}`);
    assert.equal(yamlOf(r.text).title, title, title);
    assert.equal(yamlOf(r.text).blyg, true);
  }
  assert.equal(yamlOf(one('# A <b>bold</b> {{ x }} title\n\nBody.').text).title, 'A bbold/b x title', 'the characters the site\'s titles never carry (<>{}) are left out, as for any title');
});

test('no title line: the whole note is byte-identical to the one made without the feature', () => {
  const sample = [
    ['Just words.', ''], ['Words with a quote.', 'A passage.'], ['First.\n\n## Sub\n\nMore.', ''],
  ];
  for (const [text, quote] of sample) {
    const th = [{ id: 't', quote, msgs: [mine(text)] }];
    assert.equal(render(quote ? page : alone, th).text, render(quote ? page : alone, th, { titleFrom: 'words' }).text);
  }
  assert.equal(one('Just words.').text, `---\ncreated: 2026-11-23\nreleased: "2026-11-23"\nblyg: true\nblyg_id: "${BID}"\npermalink: /b/${BID}\n---\nJust words.\n`);
});

// ---- through the hub link: a stand-alone Compose post and a reply, each starting `# A title`, into the real publisher and queue ----------
const ORIGIN = 'https://blog.example.com';
const COMPOSE = `${ORIGIN}${L.HUB_COMPOSE_PATH}`;
const POST = 'https://blyg.example.com/t/x/';
test('through the hub link: Compose and reply texts starting `# A title` publish as titled notes, titled files', async t => {
  const rig = makeRig({ confirm: 'never' }); t.after(rig.done);
  const store = new Map([[COMPOSE, { url: COMPOSE, title: 'Posts', threads: [], stand_alone: true }], [POST, { url: POST, title: 'A post', threads: [] }]]);
  const h = { ...rig.home, confirm: 'never', plan_guard: ['--only-note'] };
  let q = null;
  const pub = R.createPublisher({ file: path.join(rig.out, 'run.json'), broadcast: () => {}, readConfig: () => ({ blyg_home: h }),
    readPage: url => store.get(url), savePage: p => store.set(p.url, p), onMove: (run, from) => { if (q) q.onMove(run, from); } });
  q = Q.createQueue({ file: path.join(rig.out, 'queue.json'), publisher: pub, readPage: url => store.get(url), confirmNow: () => h.confirm, log: () => {}, broadcast: () => {}, fillCheckMs: 20 });
  t.after(() => q.stop());
  let n = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hubtitle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = L.newKey({ hub_origin: ORIGIN, publish: 'one-click' });
  L.writeLinkKey(dir, key);
  const link = L.createHubLink({ keyDir: dir, repliesFile: path.join(dir, L.HUB_LINK_REPLIES_FILE), log: () => {}, perMinute: 10000,
    bind: async () => ({ verdict: 'verified', url: POST, origin: 'https://blyg.example.com/', id: 'x', version: 1 }),
    bindCompose: () => ({ verdict: 'verified', url: COMPOSE, compose: true }),
    // as the companion's own file reply: a thread of the owner's, typed on channel hub-link, the comment as sent
    fileReply: ({ bound, quote, comment }) => {
      const pg = store.get(bound.url);
      const th = { id: `t${++n}`, quote: bound.compose ? '' : quote, via: 'hub-link', msgs: [rigMine(comment, { ts: `ts${n}`, channel: 'hub-link' })] };
      pg.threads.push(th);
      return { url: pg.url, thread_id: th.id, ts: `ts${n}` };
    },
    press: async a => q.press({ page: store.get(a.url), threadId: a.thread_id, scope: 'one', shown: 'never', by: 'hub-link' }),
    cancel: () => ({ ok: true }), discard: () => ({ ok: true }), queue: () => ({ entries: [], run: null }), readPage: url => store.get(url), earlierFor: () => null });
  const srv = http.createServer((rq, s) => link.handle(rq, s, rq.url.split('?')[0]));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  const send = async (route, obj) => {
    const b = JSON.stringify(obj);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/hub-link/${route}`, { method: 'POST', body: b, headers: { 'content-type': 'application/json', ...L.signedHeaders(key, `/hub-link/${route}`, b) } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const a = await send('reply', { rid: 'rid-title-0001', compose: true, comment: '# A compose title\n\nA thought of my own.', intent: 'publish' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  await until(() => q.view().entries.every(e => e.state === 'published') && q.view().entries.length === 1, 'compose published');
  const r = await send('reply', { rid: 'rid-title-0002', post: { page: POST, origin: 'https://blyg.example.com/', id: 'x' }, quote: 'A quoted passage here.', comment: '# A reply title\n\nMy reply.', intent: 'publish' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await until(() => q.view().entries.length === 2 && q.view().entries.every(e => e.state === 'published'), 'reply published');
  const files = fs.readdirSync(rig.folder).sort();
  assert.deepEqual(files, ['a-compose-title.md', 'a-reply-title.md']);
  const c = fs.readFileSync(path.join(rig.folder, 'a-compose-title.md'), 'utf8');
  assert.match(c, /^---\ntitle: "A compose title"\n/);
  assert.match(c, /\n---\nA thought of my own\.\n$/);
  const p = fs.readFileSync(path.join(rig.folder, 'a-reply-title.md'), 'utf8');
  assert.match(p, /^---\ntitle: "A reply title"\n/);
  assert.match(p, /\n---\nMy reply\.\n\n> A quoted passage here\./);
  assert.doesNotMatch(p + c, /^# A /m);
});

test('the composer\'s hint about the title is the same words in the drawer', () => {
  const drawer = fs.readFileSync(new URL('../extension/drawer.js', import.meta.url), 'utf8');
  assert.ok(drawer.includes(`'${N.TITLE_HINT.replace(/'/g, "\\'")}'`), 'the drawer carries the same words');
});
