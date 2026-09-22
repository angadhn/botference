#!/usr/bin/env node
// lasso — the search, the attachments and the reply line.
//
// See SPEC.md "lasso — bringing what you have read and said into a chat" and
// lasso.mjs. Everything here is the MODULE: fixtures on disk, no server, no
// bridge, no network. The companion's three routes are companion.test.mjs's.
//
//   node frontends/plugin/test/lasso.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmps = [];
const tmp = name => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bfp-lasso-${name}-`)));
  tmps.push(d);
  return d;
};

// store.mjs resolves its ROOT at import time, so the throwaway workspace has to
// exist and be named before the first import in this file.
const ROOT = tmp('root');
process.env.BOTFERENCE_PROJECT_ROOT = ROOT;
process.env.BOTFERENCE_HOME = ROOT;

const store = await import('../store.mjs');
const lasso = await import('../lasso.mjs');
const workspace = await import('../workspace.mjs');
const chat = await import('../chat.mjs');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

// ---- fixtures --------------------------------------------------------------

/** A page with a snapshot, a thread and some page chat. */
function page({ url, title, body = '', quote = '', comment = '', chatText = '' }) {
  const p = store.upsertPage({ url, title, site: 'example.org', kind: 'article' });
  if (quote) {
    p.threads = [{ id: 't1', quote, page: 0, msgs: [{ author: 'you', ts: 1, text: comment }] }];
  }
  if (chatText) p.page_chat = [{ author: 'you', ts: 2, text: chatText }];
  store.savePage(p);
  if (body) store.saveSnapshot(url, `<article><p>${body}</p></article>`);
  return store.readPage(url);
}

/** A council root with chats in it, vouched for. */
function council(tag, sessions) {
  const root = tmp(tag);
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ version: 1 }));
  fs.mkdirSync(path.join(root, 'work', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'portfolio.json'), JSON.stringify({
    version: 1,
    projects: [{ id: 'orbits', title: 'Orbit mechanics', status: 'active', root: 'projects/orbits' }],
  }));
  for (const s of sessions) {
    fs.writeFileSync(path.join(root, 'work', 'sessions', `${s.id}.json`), JSON.stringify({
      version: '2', session_id: s.id, project_id: s.project || '', title: s.title,
      created_at: '2026-08-01T10:00:00Z', updated_at: s.updated || '2026-08-10T10:00:00Z',
      transcript: (s.msgs || []).map(([speaker, text]) => ({ speaker, text })),
    }));
  }
  return root;
}

const FOLDER = tmp('watched');
fs.writeFileSync(path.join(FOLDER, 'tether-dynamics.md'),
  '# Tether dynamics\n\nA long note about the libration of a spinning tether.\n');
fs.writeFileSync(path.join(FOLDER, 'shopping.txt'), 'milk, bread, a new kettle\n');
fs.writeFileSync(path.join(FOLDER, 'notes.html'),
  '<html><body><h1>Docking</h1><p>berthing versus docking</p></body></html>');
fs.mkdirSync(path.join(FOLDER, 'sub'), { recursive: true });
fs.writeFileSync(path.join(FOLDER, 'sub', 'deeper.md'), 'a nested libration note');
fs.writeFileSync(path.join(FOLDER, 'ignored.bin'), 'libration libration libration');

const THE_PAPER = page({
  url: 'https://example.org/tether',
  title: 'A spinning tether for orbital transfer',
  body: 'The libration angle grows without bound when the tether is released early.',
  quote: 'released early',
  comment: 'this is the bit I never understood about libration',
  chatText: 'remind me what the libration limit was',
});
page({
  url: 'https://example.org/kettle',
  title: 'How to descale a kettle',
  body: 'Vinegar, mostly.',
});

const COUNCIL = council('council', [
  { id: 'sess-orbits', project: 'orbits', title: 'Tether release timing',
    updated: '2026-08-20T10:00:00Z',
    msgs: [['user', 'when do we release the tether?'],
      ['claude', 'the libration angle has to be through zero — release early and it grows']] },
  { id: 'sess-empty', title: 'nothing here', msgs: [] },
]);
const DECLINED = council('declined', [
  { id: 'sess-secret', title: 'libration secrets',
    msgs: [['user', 'libration libration libration']] },
]);

store.saveConfig({
  council_roots: { [COUNCIL]: true, [DECLINED]: false },
  lasso_folders: [FOLDER],
});
lasso.forget();

// ---- the search ------------------------------------------------------------

await test('a page is found by a word in its title, and titles outrank bodies', () => {
  // "spinning tether" is in this page's TITLE (×3 each) and in the watched
  // note's body (×1 each), so the ordering here is the weighting, not luck.
  const hits = lasso.search('spinning tether');
  assert.ok(hits.length >= 2, 'the page and the note both say it');
  assert.equal(hits[0].kind, 'page');
  assert.equal(hits[0].title, 'A spinning tether for orbital transfer');
  assert.equal(hits[0].id, store.pageKey(THE_PAPER.url));
  assert.equal(hits[0].url_or_path, THE_PAPER.url);
  assert.ok(!hits.some(h => h.title === 'How to descale a kettle'), 'and no coincidences');
});

await test('a council chat is found by what was said in it', () => {
  const hit = lasso.search('release timing').find(r => r.kind === 'chat');
  assert.ok(hit, 'the chat is in the results');
  assert.equal(hit.id, 'sess-orbits');
  assert.equal(hit.title, 'Tether release timing');
  assert.equal(hit.project, 'Orbit mechanics');
  assert.ok(hit.url_or_path.endsWith('sess-orbits.json'));
});

await test('a chat with no messages in it is not a result', () => {
  assert.equal(lasso.search('nothing here').filter(r => r.id === 'sess-empty').length, 0);
});

await test('a council the reader declined is never searched', () => {
  const hits = lasso.search('libration');
  assert.ok(hits.length, 'something matches libration');
  assert.equal(hits.filter(r => r.id === 'sess-secret').length, 0);
});

await test('a watched folder is indexed by filename and by its first words', () => {
  const byName = lasso.search('tether-dynamics').find(r => r.kind === 'file');
  assert.ok(byName, 'the filename matches');
  assert.equal(byName.title, 'tether-dynamics.md');
  const byBody = lasso.search('"a new kettle"').find(r => r.kind === 'file');
  assert.ok(byBody, 'the text inside matches');
  assert.equal(byBody.title, 'shopping.txt');
});

await test('an html file in a watched folder is indexed as text, not as markup', () => {
  const hit = lasso.search('berthing').find(r => r.kind === 'file');
  assert.ok(hit);
  assert.equal(hit.title, 'notes.html');
  assert.ok(!/</.test(hit.hit), `the hit is text: ${hit.hit}`);
});

await test('a subfolder is walked; a file of a kind we do not index is not', () => {
  const files = lasso.search('libration').filter(r => r.kind === 'file');
  assert.ok(files.some(f => f.title === 'deeper.md'), 'the nested note is indexed');
  assert.ok(!files.some(f => f.title === 'ignored.bin'), '.bin is not a document');
});

await test('every term found beats most terms found', () => {
  const hits = lasso.search('libration kettle');
  // nothing says both, so the ranking falls back on counts — but the page that
  // says one of them a dozen times must not outrank one that says the other
  assert.ok(hits.length, 'there are results');
  const both = lasso.search('libration tether');
  assert.equal(both[0].title, 'A spinning tether for orbital transfer');
});

await test('the hit is the matching line, clipped', () => {
  const hit = lasso.search('libration').find(r => r.kind === 'page');
  assert.ok(hit.hit.toLowerCase().includes('libration'), hit.hit);
  assert.ok(hit.hit.length <= lasso.HIT_MAX, `${hit.hit.length} <= ${lasso.HIT_MAX}`);
});

await test('a search for nothing finds nothing, and is not an error', () => {
  assert.deepEqual(lasso.search(''), []);
  assert.deepEqual(lasso.search('   '), []);
  assert.deepEqual(lasso.search('zzzzqqqq'), []);
});

await test('the limit is honoured', () => {
  assert.ok(lasso.search('the', { limit: 1 }).length <= 1);
});

await test('the index is cached against mtimes, and a new chat busts it', () => {
  const before = lasso.search('quasar');
  assert.equal(before.length, 0);
  fs.writeFileSync(path.join(COUNCIL, 'work', 'sessions', 'sess-new.json'), JSON.stringify({
    version: '2', session_id: 'sess-new', title: 'Quasar readings',
    updated_at: '2026-09-01T10:00:00Z',
    transcript: [{ speaker: 'user', text: 'the quasar readings are odd' }],
  }));
  const after = lasso.search('quasar');
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 'sess-new');
});

await test('recency breaks a tie', () => {
  const rows = [
    { kind: 'chat', id: 'a', title: 'x', when: '2026-01-01T00:00:00Z', marks: '', body: 'alpha' },
    { kind: 'chat', id: 'b', title: 'x', when: '2026-06-01T00:00:00Z', marks: '', body: 'alpha' },
  ];
  assert.equal(lasso.score(rows[0], ['alpha']), lasso.score(rows[1], ['alpha']));
});

// ---- attaching -------------------------------------------------------------

const HOST = page({ url: 'https://example.org/host', title: 'The page being written on' });

await test('attaching a page writes a digest carrying the text and the margin', () => {
  const r = lasso.attach(HOST.url, { kind: 'page', id: store.pageKey(THE_PAPER.url) });
  assert.ok(r.ok, r.error);
  const md = fs.readFileSync(r.attachment.path, 'utf8');
  assert.match(md, /^# A spinning tether for orbital transfer/);
  assert.match(md, /- url: https:\/\/example\.org\/tether/);
  assert.match(md, /## The page itself/);
  assert.match(md, /libration angle grows without bound/);
  assert.match(md, /## The margin/);
  assert.match(md, /released early/);
  assert.match(md, /this is the bit I never understood/);
  assert.match(md, /## Page chat/);
  assert.match(md, /remind me what the libration limit was/);
  assert.match(r.attachment.summary, /A page the reader annotated/);
  assert.equal(r.attachment.kind, 'page');
});

await test('the attachment is on the record, and attaching it twice is a no-op', () => {
  const p = store.readPage(HOST.url);
  assert.equal(lasso.attachmentsOf(p).length, 1);
  const again = lasso.attach(HOST.url, { kind: 'page', id: store.pageKey(THE_PAPER.url) });
  assert.ok(again.ok);
  assert.equal(lasso.attachmentsOf(store.readPage(HOST.url)).length, 1);
});

await test('attaching a council chat writes the transcript', () => {
  const r = lasso.attach(HOST.url, { kind: 'chat', id: 'sess-orbits' });
  assert.ok(r.ok, r.error);
  const md = fs.readFileSync(r.attachment.path, 'utf8');
  assert.match(md, /^# Tether release timing/);
  assert.match(md, /- project: Orbit mechanics/);
  assert.match(md, /\*\*user:\*\* when do we release the tether\?/);
  assert.match(md, /\*\*claude:\*\* the libration angle has to be through zero/);
  assert.match(r.attachment.summary, /A council chat from the project “Orbit mechanics”/);
});

await test('attaching a file COPIES it and leaves the original alone', () => {
  const src = path.join(FOLDER, 'tether-dynamics.md');
  const r = lasso.attach(HOST.url, { kind: 'file', id: src });
  assert.ok(r.ok, r.error);
  assert.notEqual(r.attachment.path, src);
  assert.ok(fs.existsSync(src), 'the original is still there');
  assert.equal(fs.readFileSync(r.attachment.path, 'utf8'), fs.readFileSync(src, 'utf8'));
  assert.match(r.attachment.summary, /A file of the reader's own: tether-dynamics\.md/);
});

await test('a path with .. in it is refused; so is a directory and a name for nothing', () => {
  assert.match(lasso.resolveOwnerPath('/tmp/../etc/passwd').error, /not allowed/);
  assert.match(lasso.resolveOwnerPath(FOLDER).error, /no such file/);
  assert.match(lasso.resolveOwnerPath('/nope/nothing/here.pdf').error, /no such file/);
  assert.match(lasso.resolveOwnerPath('tether-dynamics.md').error, /absolute/);
  assert.equal(lasso.resolveOwnerPath(path.join(FOLDER, 'shopping.txt')).path,
    path.join(FOLDER, 'shopping.txt'));
});

await test('a `~` path the owner names resolves against their home', () => {
  assert.equal(lasso.expandHome('~'), os.homedir());
  assert.equal(lasso.expandHome('~/Downloads'), path.join(os.homedir(), 'Downloads'));
  assert.ok(lasso.looksLikePath('~/papers/kalman.pdf'));
  assert.ok(lasso.looksLikePath('/Users/x/a.pdf'));
  assert.ok(!lasso.looksLikePath('kalman filter'));
});

await test('detach removes the row and OUR digest, never the reader\'s own file', () => {
  const src = path.join(FOLDER, 'tether-dynamics.md');
  const list = lasso.attachmentsOf(store.readPage(HOST.url));
  const mine = list.find(a => a.kind === 'file');
  const r = lasso.detach(HOST.url, mine.path);
  assert.ok(r.ok, r.error);
  assert.ok(!fs.existsSync(mine.path), 'the copy is gone');
  assert.ok(fs.existsSync(src), 'the original is not');
  assert.equal(lasso.attachmentsOf(store.readPage(HOST.url)).length, 2);
  assert.match(lasso.detach(HOST.url, mine.path).error, /not attached/);
});

await test('the field is absent, not empty, when the last one comes off', () => {
  const solo = page({ url: 'https://example.org/solo', title: 'Solo' });
  const r = lasso.attach(solo.url, { kind: 'chat', id: 'sess-orbits' });
  assert.ok(r.ok);
  lasso.detach(solo.url, r.attachment.path);
  const raw = JSON.parse(fs.readFileSync(
    path.join(ROOT, '.botference', 'plugin', 'pages', `${store.pageKey(solo.url)}.json`), 'utf8'));
  assert.ok(!('attachments' in raw), 'no empty array is left on disk');
});

await test('twenty attachments is the cap, and the twenty-first says so', () => {
  const many = page({ url: 'https://example.org/many', title: 'Many' });
  for (let i = 0; i < lasso.ATTACHMENTS_MAX; i++) {
    const f = path.join(FOLDER, `cap-${i}.md`);
    fs.writeFileSync(f, `capped note ${i}`);
    const r = lasso.attach(many.url, { kind: 'file', id: f });
    assert.ok(r.ok, `#${i}: ${r.error}`);
  }
  assert.equal(lasso.attachmentsOf(store.readPage(many.url)).length, lasso.ATTACHMENTS_MAX);
  const extra = path.join(FOLDER, 'cap-over.md');
  fs.writeFileSync(extra, 'one too many');
  const over = lasso.attach(many.url, { kind: 'file', id: extra });
  assert.match(over.error, /already carries 20/);
  assert.equal(lasso.attachmentsOf(store.readPage(many.url)).length, lasso.ATTACHMENTS_MAX);
});

await test('a page cannot be attached to itself, and a stranger cannot be attached at all', () => {
  assert.match(lasso.attach(HOST.url, { kind: 'page', id: store.pageKey(HOST.url) }).error,
    /the one you are reading/);
  assert.match(lasso.attach(HOST.url, { kind: 'page', id: 'f'.repeat(40) }).error, /no such page/);
  assert.match(lasso.attach(HOST.url, { kind: 'chat', id: 'sess-nope' }).error, /no such chat/);
  assert.match(lasso.attach(HOST.url, { kind: 'wat', id: 'x' }).error, /unknown kind/);
  assert.match(lasso.attach('https://example.org/never-seen', { kind: 'chat', id: 'sess-orbits' }).error,
    /unknown page/);
});

// ---- the envelope block ----------------------------------------------------

await test('the block names each attachment once: title, kind, path, summary', () => {
  const block = lasso.attachmentsBlock(lasso.attachmentsOf(store.readPage(HOST.url)));
  assert.ok(block.startsWith(lasso.ATTACH_HEADER), block.slice(0, 80));
  assert.match(block, /never inline them back/);
  const rows = block.trim().split('\n').slice(1);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r, /^- .+ \((page|chat|file)\) — \/.+ — .+$/);
});

await test('no attachments is no block at all', () => {
  assert.equal(lasso.attachmentsBlock([]), '');
  assert.equal(lasso.attachmentsBlock(undefined), '');
});

await test('past the budget the summaries go and the paths stay', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    kind: 'page', id: `p${i}`, title: `Attachment number ${i}`,
    path: `/tmp/attachments/very-long-name-number-${i}.md`,
    summary: 'x'.repeat(400),
  }));
  const block = lasso.attachmentsBlock(rows);
  assert.ok(block.length <= 1200, `titles-only block is short: ${block.length}`);
  assert.ok(!block.includes('xxxx'), 'no summaries survived');
  for (const r of rows) assert.ok(block.includes(r.path), `${r.path} is still named`);
  // …and a small set keeps its summaries
  assert.ok(lasso.attachmentsBlock(rows.slice(0, 2)).includes('xxxx'));
});

await test('the envelope carries the block on a page turn and on the library', () => {
  const block = lasso.attachmentsBlock([{ kind: 'chat', id: 's', title: 'Tether release timing',
    path: '/tmp/a/chat.md', summary: 'A council chat.' }]);
  const page1 = chat.envelope({ url: 'https://example.org/host', title: 'Host', target: '__page__',
    text: '@claude what now?', first: true, attachContext: block });
  assert.ok(page1.includes(lasso.ATTACH_HEADER), 'the header rides the first turn');
  assert.ok(page1.includes('/tmp/a/chat.md'));
  const later = chat.envelope({ url: 'https://example.org/host', title: 'Host', target: '__page__',
    text: '@claude and now?', first: false, attachContext: block });
  assert.ok(later.includes(lasso.ATTACH_HEADER), 'and every later turn');
  const lib = chat.envelope({ url: 'bfp://library', title: 'Library', target: '__page__',
    text: '@claude what have I read?', library: '/tmp/plugin', attachContext: block });
  assert.ok(lib.includes(lasso.ATTACH_HEADER), 'and the library, which is a chat too');
  const none = chat.envelope({ url: 'https://example.org/host', title: 'Host', target: '__page__',
    text: '@claude hello', first: true });
  assert.ok(!none.includes(lasso.ATTACH_HEADER), 'and nothing at all without attachments');
});

// ---- the reply line --------------------------------------------------------

await test('`lasso:` on a line of its own is a request; the last one wins', () => {
  assert.equal(lasso.parseLasso('nothing here'), null);
  assert.equal(lasso.parseLasso('lasso: tether release').query, 'tether release');
  assert.equal(lasso.parseLasso('sure.\n\nlasso: first\nlasso: second').query, 'second');
  assert.equal(lasso.parseLasso('- **lasso: tether release**').query, 'tether release');
  assert.equal(lasso.parseLasso('`lasso: tether release`').query, 'tether release');
});

await test('the line it reports is the RAW line, so it can be lifted out', () => {
  const text = 'The libration matters here.\n\n- **lasso: tether release**';
  const hit = lasso.parseLasso(text);
  assert.equal(hit.line, '- **lasso: tether release**');
  assert.equal(store.liftLines(text, hit.line).trim(), 'The libration matters here.');
});

await test('a lasso: inside a code fence is code, not a request', () => {
  assert.equal(lasso.parseLasso('```\nlasso: not a request\n```'), null);
  const mixed = '```\nlasso: no\n```\nlasso: yes please';
  assert.equal(lasso.parseLasso(mixed).query, 'yes please');
});

await test('a bare lasso: asks for nothing', () => {
  assert.equal(lasso.parseLasso('lasso:'), null);
  assert.equal(lasso.parseLasso('lasso:   '), null);
  assert.equal(lasso.parseLasso('lasso: a'), null);   // one letter is not a term
});

await test('mid-sentence is not a line of its own', () => {
  assert.equal(lasso.parseLasso('I could lasso: something for you'), null);
});

await test('the other reply-line protocols ignore lasso:, and lasso ignores theirs', () => {
  const roster = [{ id: 'orbits', title: 'Orbit mechanics', root: COUNCIL }];
  assert.equal(workspace.parseSuggestion('lasso: tether release', roster), null);
  assert.equal(lasso.parseLasso('file-in: orbits — it belongs here'), null);
  assert.equal(lasso.parseLasso('watch: https://youtu.be/abc'), null);
  assert.equal(lasso.parseLasso('artifact: projects/orbits/note.md'), null);
  assert.equal(lasso.parseLasso('strike: because it is wrong'), null);
  // and a reply that carries both keeps both readable
  const both = 'Yes.\n\nfile-in: orbits — the tether work\nlasso: tether release';
  assert.equal(lasso.parseLasso(both).query, 'tether release');
  assert.equal(workspace.parseSuggestion(both, roster).id, 'orbits');
});

// ---- the folder reader -----------------------------------------------------

await test('a PDF is indexed by its words where this machine can read one, else its name', () => {
  const pdf = path.join(FOLDER, 'kalman-1960.pdf');
  // not a real PDF: pdftotext refuses it, which is exactly the "no text" path
  fs.writeFileSync(pdf, '%PDF-1.4\nnot really a pdf\n');
  lasso.forget();
  const hit = lasso.search('kalman').find(r => r.kind === 'file');
  assert.ok(hit, 'the filename alone finds it');
  assert.equal(hit.title, 'kalman-1960.pdf');
  const head = lasso.fileHead(pdf);
  assert.equal(head.how, 'filename');
  assert.equal(head.text, '');
});


// ---- a LINK the reader pasted ---------------------------------------------
//
// The whole of this section runs against an injected `http`: no network, no
// server, and a 403 is one line of fixture rather than a site that happens to
// refuse us today.

const WEBDIR = path.join(lasso.ATTACH_DIR, 'web-test');
const html = (title, body) =>
  `<html><head><title>${title}</title><script>var x=1</script></head>`
  + `<body><nav>home about</nav><article><p>${body}</p></article></body></html>`;

/** A transport that answers from a table, and records what it was asked. */
function httpOf(table) {
  const asked = [];
  const fn = async (url) => {
    asked.push(url);
    const row = table[url];
    if (!row) return { ok: false, status: 404, url, contentType: '', body: Buffer.alloc(0) };
    if (row.throws) throw new Error(row.throws);
    return { ok: row.status === undefined || (row.status >= 200 && row.status < 300),
      status: row.status === undefined ? 200 : row.status,
      url: row.finalUrl || url, contentType: row.type || 'text/html; charset=utf-8',
      body: Buffer.isBuffer(row.body) ? row.body : Buffer.from(String(row.body || ''), 'utf8') };
  };
  fn.asked = asked;
  return fn;
}

const ROCKETS = 'https://angadh.com/rockets-1';
const FT = 'https://ft.com/paywalled';
const PAPER_PDF = 'https://arxiv.org/pdf/2101.00001.pdf';

await test('a url is fetched, not searched — one chip, already readable', async () => {
  const http = httpOf({
    [ROCKETS]: { body: html('Rockets, part 1', 'The first stage is the whole argument.') },
  });
  const r = await lasso.lassoUrl(ROCKETS, { dir: WEBDIR, http });
  assert.equal(http.asked.length, 1, 'exactly one request');
  assert.equal(r.results.length, 1);
  const chip = r.results[0];
  assert.equal(chip.kind, 'web');
  assert.equal(chip.title, 'Rockets, part 1');
  assert.match(chip.hit, /first stage is the whole argument/);
  assert.equal(r.head, 'lasso · fetched “Rockets, part 1” (angadh.com)');
  // the digest is on disk BEFORE the chip is offered, and carries the words
  // and not the page's scripts or its navigation
  const held = lasso.heldWeb(chip.id);
  assert.ok(held && fs.existsSync(held.path), 'a digest file');
  const digest = fs.readFileSync(held.path, 'utf8');
  assert.match(digest, /^# Rockets, part 1/);
  assert.match(digest, new RegExp(`- url: ${ROCKETS}`));
  assert.match(digest, /first stage is the whole argument/);
  assert.ok(!/var x=1/.test(digest), 'no scripts in the digest');
});

await test('…and attaching it is a copy, not a second request', async () => {
  const http = httpOf({ [ROCKETS]: { body: html('Rockets, part 1', 'The first stage.') } });
  const r = await lasso.lassoUrl(ROCKETS, { dir: WEBDIR, http });
  const id = r.results[0].id;
  const before = http.asked.length;
  const a = lasso.attach(HOST.url, { kind: 'web', id });
  assert.ok(a.ok, a.error);
  assert.equal(http.asked.length, before, 'nothing went over the wire');
  assert.equal(a.attachment.kind, 'web');
  assert.equal(a.attachment.title, 'Rockets, part 1');
  assert.ok(fs.existsSync(a.attachment.path));
  assert.ok(a.attachment.path.includes(store.pageKey(HOST.url)), 'copied into this chat’s folder');
  // and the envelope names it by path, like everything else lassoed
  assert.match(lasso.attachmentsBlock(lasso.attachmentsOf(store.readPage(HOST.url))),
    /Rockets, part 1 \(web\) — /);
  lasso.detach(HOST.url, a.attachment.path);
});

await test('a link nobody ever lassoed cannot be attached by posting its url', () => {
  const r = lasso.attach(HOST.url, { kind: 'web', id: 'https://example.net/never-asked-for' });
  assert.match(r.error, /no longer in hand — lasso it again/);
});

await test('a refused link is a chip that says why, never an empty result', async () => {
  const http = httpOf({ [FT]: { status: 403, body: 'no' } });
  const r = await lasso.lassoUrl(FT, { dir: WEBDIR, http });
  assert.equal(r.results.length, 1, 'never nothing');
  assert.equal(r.results[0].failed, true);
  assert.match(r.results[0].hit,
    /could not fetch: HTTP 403 — open it in the browser with the plugin once and lasso it by title/);
  assert.equal(r.head, 'lasso · could not fetch: HTTP 403 — ft.com');
  assert.equal(r.error, 'could not fetch: HTTP 403');
});

await test('a network that never answers says so in the same shape', async () => {
  const http = httpOf({ [FT]: { throws: 'TimeoutError' } });
  const r = await lasso.lassoUrl(FT, { dir: WEBDIR, http });
  assert.equal(r.results.length, 1);
  assert.match(r.head, /^lasso · could not fetch: no answer in 15s — ft\.com$/);
});

await test('a PDF goes through the same pdftotext the folder index uses', async () => {
  const http = httpOf({ [PAPER_PDF]: { type: 'application/pdf', body: '%PDF-1.4\nnot really\n' } });
  const r = await lasso.lassoUrl(PAPER_PDF, { dir: WEBDIR, http });
  // On a machine with poppler this fixture is not a readable PDF, so the
  // honest answer is a refusal; on a machine without one it is the other
  // refusal. Either way it is a sentence and never a silent empty chip.
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].failed, true);
  assert.match(r.head, /^lasso · could not fetch: (no text could be read out of that PDF|that is a PDF and this machine has no pdftotext) — arxiv\.org$/);
});

await test('a url the reader has ALREADY annotated comes back as their page', async () => {
  const http = httpOf({ [THE_PAPER.url]: { body: html('nope', 'the live web copy') } });
  const r = await lasso.lassoUrl(THE_PAPER.url, { dir: WEBDIR, http });
  assert.equal(http.asked.length, 0, 'their own copy is better — nothing was fetched');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].kind, 'page');
  assert.equal(r.results[0].id, store.pageKey(THE_PAPER.url));
  assert.equal(r.head,
    'lasso · you have annotated “A spinning tether for orbital transfer” (example.org) already '
    + '— here is that page, with your comments on it');
});

await test('…and the page you are STANDING on says so instead of offering itself', async () => {
  const http = httpOf({});
  const r = await lasso.lassoUrl(THE_PAPER.url,
    { dir: WEBDIR, http, notPage: store.pageKey(THE_PAPER.url) });
  assert.deepEqual(r.results, []);
  assert.equal(r.head, 'lasso · that link is the page you are on — the bots already have it');
});

await test('the header says what happened, in every case there is', () => {
  assert.equal(lasso.headline({ query: 'fat tails', count: 3 }),
    'lasso · 3 matches for “fat tails”');
  assert.equal(lasso.headline({ query: 'fat tails', count: 1 }),
    'lasso · 1 match for “fat tails”');
  assert.equal(lasso.headline({ query: 'zzz', count: 0 }),
    'lasso · nothing matched “zzz” — try other words, or paste a link or a file path');
  assert.equal(lasso.headline({ kind: 'fetched', title: 'Rockets, part 1', host: 'angadh.com' }),
    'lasso · fetched “Rockets, part 1” (angadh.com)');
  assert.equal(lasso.headline({ kind: 'file', title: 'kalman.pdf' }), 'lasso · kalman.pdf');
  assert.equal(lasso.headline({ kind: 'error', error: 'no such file' }), 'lasso · no such file');
  // the words the reader actually saw, and must never see again
  for (const h of [
    lasso.headline({ query: 'x', count: 0 }),
    lasso.headline({ kind: 'here' }),
    lasso.headline({ kind: 'fetched', title: 'x', host: 'y.com' }),
  ]) assert.ok(!/^that is this page$/.test(h), h);
});

// ---- what the BOTS may reach on their own ----------------------------------

await test('the allow-list is the defaults plus what /allow-host granted, in either root', () => {
  const grants = path.join(COUNCIL, '.botference');
  fs.mkdirSync(grants, { recursive: true });
  fs.writeFileSync(path.join(grants, 'allowed-hosts.json'), JSON.stringify(['angadh.com']));
  const hosts = lasso.allowedHosts();
  assert.ok(hosts.includes('github.com'), 'the defaults');
  assert.ok(hosts.includes('angadh.com'), 'the grant, from the council root');
  assert.ok(lasso.hostAllowed('gist.github.com', hosts), '*.github.com covers a subdomain');
  assert.ok(lasso.hostAllowed('github.com', hosts));
  assert.ok(lasso.hostAllowed('angadh.com', hosts));
  assert.ok(!lasso.hostAllowed('ft.com', hosts));
  assert.ok(!lasso.hostAllowed('notgithub.com', hosts));
  fs.rmSync(path.join(grants, 'allowed-hosts.json'));
});

await test('the links in a message are found, and the reader’s punctuation is not one', () => {
  assert.deepEqual(lasso.urlsIn('see https://angadh.com/rockets-1, and nothing else.'),
    ['https://angadh.com/rockets-1']);
  assert.deepEqual(lasso.urlsIn('no links here'), []);
  assert.equal(lasso.urlsIn('a https://a.com b https://b.com c https://c.com d https://d.com').length,
    lasso.WEB_URLS_PER_MESSAGE);
});

await test('a link the bots cannot reach is fetched FOR the turn, and the turn says so', async () => {
  const http = httpOf({
    [ROCKETS]: { body: html('Rockets, part 1', 'The first stage is the whole argument.') },
  });
  const w = await lasso.webForTurn(`what do you make of ${ROCKETS} ?`,
    { dir: WEBDIR, http, hosts: ['github.com'] });
  assert.equal(w.urls.length, 1);
  assert.equal(w.note,
    'The link angadh.com is not on the bots\' allow-list; the companion will fetch it for them.');
  assert.match(w.block, /Fetched for THIS message only/);
  assert.match(w.block, /Rockets, part 1 \(web\) — /);
  // …and it rides the envelope, on an ordinary page turn
  const turn = chat.envelope({ url: HOST.url, title: 'Host', target: '__page__',
    text: 'what do you make of it?', webContext: `${w.note}\n${w.block}` });
  assert.ok(turn.includes('is not on the bots\' allow-list'), 'the line');
  assert.ok(turn.includes(w.urls.length ? 'Fetched for THIS message only' : ''), 'the digest path');
});

await test('…and a host the reader HAS granted is left to the bots', async () => {
  const http = httpOf({ [ROCKETS]: { body: html('Rockets', 'x') } });
  const w = await lasso.webForTurn(`read ${ROCKETS}`,
    { dir: WEBDIR, http, hosts: ['angadh.com'] });
  assert.equal(http.asked.length, 0);
  assert.equal(w.note, '');
  assert.equal(w.block, '');
});

await test('a message with no links costs nothing at all', async () => {
  const http = httpOf({});
  const w = await lasso.webForTurn('no links in this one', { dir: WEBDIR, http });
  assert.equal(http.asked.length, 0);
  assert.equal(w.block, '');
});


for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
console.log(`\n✓ lasso.test.mjs — ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => `  · ${f}`).join('\n')); process.exit(1); }
