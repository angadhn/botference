#!/usr/bin/env node
// Filing an ORDINARY page under a council project — the manuscript case.
// See SPEC.md "filing a page in a council project" and workspace.mjs.
//
// The distinction this file exists to pin: a project ARTIFACT page lives in
// projects/<id>/ and gets that project's lane and its write scope; a page
// FILED in a project is a PDF in the reader's Downloads that keeps its own
// lane, its own bridge and no write scope at all, and gains only context.
//
// Fixture councils in a temp dir, the mock bridge, no CLI, no network.
//
//   node frontends/plugin/test/filing.test.mjs
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-file-${tag}-`));
  tmps.push(d);
  return fs.realpathSync(d);   // macOS /var vs /private/var — both sides, always
}

// A council root as botference lays one out, with real chats in it: the whole
// point of filing is that those chats become context, so the fixture has to
// contain words worth carrying.
function council(tag, { projects = ['adriana-paper', 'journal-submissions'], sessions = [] } = {}) {
  const root = tmp(tag);
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ version: 1 }));
  fs.mkdirSync(path.join(root, 'work', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  for (const id of projects) fs.mkdirSync(path.join(root, 'projects', id), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'portfolio.json'), JSON.stringify({
    version: 1,
    projects: projects.map(id => ({
      id,
      title: id === 'adriana-paper' ? "Adriana's paper" : 'Journal submissions',
      status: 'active',
      root: `projects/${id}`,
      next_action: id === 'adriana-paper' ? 'read draft two' : 'pick a venue',
    })),
  }));
  const entries = {};
  for (const s of sessions) {
    const payload = {
      version: '2', session_id: s.id, project_id: s.project, title: s.title,
      created_at: '2026-08-01T10:00:00Z', updated_at: s.updated || '2026-08-10T10:00:00Z',
      transcript: s.transcript || [],
    };
    fs.writeFileSync(path.join(root, 'work', 'sessions', `${s.id}.json`), JSON.stringify(payload));
    entries[s.id] = {
      mtime: Date.parse(payload.updated_at) / 1000, project_id: s.project,
      entry_count: (s.transcript || []).length, updated_at: payload.updated_at,
      title: s.title, created_at: payload.created_at,
    };
  }
  fs.writeFileSync(path.join(root, 'work', 'sessions', '.metadata-index.json'),
    JSON.stringify({ version: 1, entries }));
  return root;
}

const spawned = [];
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-file-secrets-'));
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

// store.mjs fixes its ROOT at import time. Point THIS process at a throwaway
// workspace first: setRootState writes a config.json, and it must never be the
// developer's own.
const OWN_ROOT = tmp('own-store');
process.env.BOTFERENCE_PROJECT_ROOT = OWN_ROOT;
const ws = await import(path.join(PLUGIN, 'workspace.mjs'));
const store = await import(path.join(PLUGIN, 'store.mjs'));

const CHATS = [
  {
    id: 'chat-draft-one', project: 'adriana-paper', title: 'Draft one, section 3',
    updated: '2026-08-09T10:00:00Z',
    transcript: [
      { speaker: 'user', text: 'The estimator in section 3 is not identified.' },
      { speaker: 'claude', text: 'Agreed — the instrument is weak; ask for a first stage.' },
    ],
  },
  {
    id: 'chat-venue', project: 'journal-submissions', title: 'Where to send it',
    updated: '2026-08-05T10:00:00Z',
    transcript: [{ speaker: 'user', text: 'JPE or ReStud?' }],
  },
];

console.log('\nfiling — the roster and the record');

await test('the roster lists only projects of CONFIRMED council roots', async () => {
  const root = council('roster', { sessions: CHATS });
  ws.setRootState(root, false);
  assert.deepEqual(ws.projectRoster().filter(p => p.root === root), [],
    'a declined root is not somewhere anything gets filed');
  ws.setRootState(root, true);
  const rows = ws.projectRoster().filter(p => p.root === root);
  assert.deepEqual(rows.map(p => p.id).sort(), ['adriana-paper', 'journal-submissions']);
  const paper = rows.find(p => p.id === 'adriana-paper');
  assert.equal(paper.title, "Adriana's paper");
  assert.equal(paper.next_action, 'read draft two');
  assert.deepEqual(paper.chats.map(c => c.title), ['Draft one, section 3'],
    'the peek names the recent chats');
});

await test('the peek lists the project folder, top level only', async () => {
  const root = council('peek', { sessions: [] });
  ws.setRootState(root, true);
  const dir = path.join(root, 'projects', 'adriana-paper');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# notes');
  fs.mkdirSync(path.join(dir, 'figures'));
  fs.writeFileSync(path.join(dir, 'figures', 'fig1.png'), 'x');
  fs.mkdirSync(path.join(dir, 'sessions'));           // botference's own; never shown
  fs.writeFileSync(path.join(dir, '.hidden'), 'x');
  const files = ws.projectFiles(root, 'adriana-paper');
  assert.deepEqual(files, ['figures/', 'notes.md']);
  assert.ok(!files.includes('fig1.png'), 'shallow: nothing from inside a folder');
});

await test('attaching is a list, idempotent in both directions', async () => {
  const url = 'https://example.com/paper-two.pdf';
  store.upsertPage({ url, title: 'Draft two' });
  const root = '/some/council';
  let page = store.filePageInProject(url, { root, id: 'adriana-paper' });
  const first = store.projectsOf(page)[0].at;
  page = store.filePageInProject(url, { root, id: 'adriana-paper' });
  assert.equal(store.projectsOf(page).length, 1, 'attaching twice is one attachment');
  assert.equal(store.projectsOf(page)[0].at, first, 'and keeps the original date');
  page = store.filePageInProject(url, { root, id: 'journal-submissions' });
  assert.deepEqual(store.projectsOf(page).map(p => p.id),
    ['adriana-paper', 'journal-submissions'], 'a page may be filed in several');
  page = store.filePageInProject(url, { root, id: 'adriana-paper', attach: false });
  assert.deepEqual(store.projectsOf(page).map(p => p.id), ['journal-submissions']);
  page = store.filePageInProject(url, { root, id: 'nowhere', attach: false });
  assert.deepEqual(store.projectsOf(page).map(p => p.id), ['journal-submissions'],
    'detaching something never attached is a no-op, not an error');
  page = store.filePageInProject(url, { root, id: 'journal-submissions', attach: false });
  assert.equal('projects' in page, false,
    'filed nowhere costs nothing on disk — no field, no migration');
});

console.log('\nfiling — the digest');

await test('the digest carries the words of the project’s past chats', async () => {
  const root = council('digest', { sessions: CHATS });
  ws.setRootState(root, true);
  const text = ws.projectDigest(root, 'adriana-paper', { fresh: true });
  assert.match(text, /Adriana's paper \(adriana-paper\)/);
  assert.match(text, /Draft one, section 3/, 'the chat titles');
  assert.match(text, /the instrument is weak/, 'and the actual words said in them');
  assert.match(text, /claude:/, 'attributed to whoever said them');
});

await test('the digest carries TASKS.md and the file list', async () => {
  const root = council('digest-tasks', { sessions: CHATS });
  ws.setRootState(root, true);
  const dir = path.join(root, 'projects', 'adriana-paper');
  fs.writeFileSync(path.join(dir, 'TASKS.md'), '- [ ] check the first stage\n- [x] read draft one\n');
  fs.writeFileSync(path.join(dir, 'referee-1.md'), 'x');
  const text = ws.projectDigest(root, 'adriana-paper', { fresh: true });
  assert.match(text, /\[ \] check the first stage/);
  assert.match(text, /\[x\] read draft one/);
  assert.match(text, /Files: .*referee-1\.md/);
});

await test('several projects are capped, and the block says how many it dropped', async () => {
  const root = council('caps', {
    projects: ['p1', 'p2', 'p3', 'p4'],
    sessions: ['p1', 'p2', 'p3', 'p4'].map((p, i) => ({
      id: `s-${p}`, project: p, title: `chat in ${p}`,
      transcript: [{ speaker: 'user', text: `something about ${p}` }],
    })),
  });
  ws.setRootState(root, true);
  const attached = ['p1', 'p2', 'p3', 'p4'].map(id => ({ root, id }));
  const block = ws.attachedContext(attached, { fresh: true });
  assert.equal(block.split('###').length - 1, ws.DIGEST_PROJECTS,
    `only the newest ${ws.DIGEST_PROJECTS} attachments talk`);
  assert.match(block, /1 further project/, 'and it says so rather than pretending');
  assert.ok(block.length <= ws.DIGEST_TOTAL_CHARS + 800, 'total budget respected');
  assert.ok(!/something about p1/.test(block), 'the OLDEST attachment is the one dropped');
});

await test('an attachment whose root is no longer confirmed is silently skipped', async () => {
  const root = council('unconfirmed', { sessions: CHATS });
  ws.setRootState(root, true);
  assert.notEqual(ws.attachedContext([{ root, id: 'adriana-paper' }], { fresh: true }), '');
  ws.setRootState(root, false);
  assert.equal(ws.attachedContext([{ root, id: 'adriana-paper' }], { fresh: true }), '',
    'the record keeps the attachment; the envelope just stops claiming to know it');
});

await test('a project deleted out from under an attachment claims nothing', async () => {
  const root = council('gone', { sessions: CHATS });
  ws.setRootState(root, true);
  assert.equal(ws.attachedContext([{ root, id: 'never-existed' }], { fresh: true }), '');
});

console.log('\nfiling — the suggestion');

await test('the roster block is offered, and it forbids guessing', async () => {
  const block = ws.suggestBlock([
    { id: 'adriana-paper', title: "Adriana's paper", next_action: 'read draft two' },
  ]);
  assert.match(block, /filed nowhere/);
  assert.match(block, /- adriana-paper — Adriana's paper; next: read draft two/);
  assert.match(block, /file-in: <project-id>/);
  assert.match(block, /never guess/);
  assert.equal(ws.suggestBlock([]), '', 'no projects, no block, no invitation to invent one');
});

await test('a suggestion is read only for a project the roster offered', async () => {
  const roster = [{ id: 'adriana-paper', root: '/r', title: "Adriana's paper" }];
  const hit = ws.parseSuggestion('Some answer.\n\nfile-in: adriana-paper — same author', roster);
  assert.equal(hit.id, 'adriana-paper');
  assert.equal(hit.root, '/r');
  assert.equal(hit.why, 'same author');
  assert.equal(ws.parseSuggestion('file-in: invented-project — trust me', roster), null,
    'a bot that invents a project gets no button');
  assert.equal(ws.parseSuggestion('I could file-in: adriana-paper if you liked', roster), null,
    'only a line of its own counts');
});

await test('markdown around the line does not hide it, and the last one wins', async () => {
  const roster = [
    { id: 'adriana-paper', root: '/r', title: 'A' },
    { id: 'journal-submissions', root: '/r', title: 'J' },
  ];
  assert.equal(ws.parseSuggestion('**file-in: adriana-paper** - because', roster).id,
    'adriana-paper');
  assert.equal(ws.parseSuggestion('- `file-in: adriana-paper`', roster).id, 'adriana-paper');
  assert.equal(
    ws.parseSuggestion('file-in: adriana-paper — a\nfile-in: journal-submissions — b', roster).id,
    'journal-submissions', 'the last word is the bot’s final answer');
});

console.log('\nfiling — end to end, against a companion');

{
  const root = council('live', { sessions: CHATS });
  const logDir = tmp('live-log');
  const { base, out } = await startServer({
    root,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: path.join(logDir, 'bridge.jsonl'),
    },
  });
  const url = 'https://arxiv.example/adriana-draft-two.pdf';
  await POST(base, '/page', { url, title: 'Draft two', kind: 'pdf' });
  // vouch for the fixture council the way the drawer's card does
  await POST(base, '/council-root', { root, confirm: true });

  await test('GET /projects lists the roster and what this page is already filed under', async () => {
    const r = await GET(base, '/projects?url=' + enc(url));
    assert.equal(r.status, 200);
    const ours = r.json.projects.filter(p => p.root === root);
    assert.deepEqual(ours.map(p => p.id).sort(), ['adriana-paper', 'journal-submissions']);
    assert.deepEqual(r.json.filed, []);
  });

  await test('filing is a POST, and the record remembers it', async () => {
    const r = await POST(base, '/page-projects', { url, root, id: 'adriana-paper' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.filed.map(f => f.id), ['adriana-paper']);
    const page = (await GET(base, '/page?url=' + enc(url))).json;
    assert.deepEqual((page.projects || []).map(p => p.id), ['adriana-paper']);
  });

  await test('a project in no confirmed council is refused', async () => {
    const r = await POST(base, '/page-projects', { url, root: '/nowhere', id: 'x' });
    assert.equal(r.status, 400);
  });

  await test('the filed page’s next turn carries what the project knows', async () => {
    await POST(base, '/reply', { url, target: 'page', text: '@claude what did we say last time?' });
    const log = path.join(logDir, 'bridge.jsonl');
    const env = await waitFor(
      () => inputs(log).find(t => /what did we say last time/.test(t)),
      'the envelope',
    );
    assert.match(env, /\[filed in council projects\]/);
    assert.match(env, /Draft one, section 3/, 'the past chat rides along');
    assert.match(env, /the instrument is weak/, 'with its actual words');
    assert.ok(!/\[project artifact:/.test(env),
      'and it is still an ordinary page — filing gives context, not custody');
    assert.ok(!/You may create and edit files under/.test(env),
      'no write scope: attaching a page never opens the project folder to it');
  });

  await test('a page filed nowhere carries the roster instead, once', async () => {
    const other = 'https://example.org/loose-article';
    await POST(base, '/page', { url: other, title: 'Loose' });
    await POST(base, '/reply', { url: other, target: 'page', text: '@claude thoughts?' });
    const log = path.join(logDir, 'bridge.jsonl');
    const env = await waitFor(
      () => inputs(log).find(t => /thoughts\?/.test(t)), 'the envelope',
    );
    assert.match(env, /\[this page is filed nowhere\]/);
    assert.match(env, /adriana-paper/);
    assert.ok(!/\[filed in council projects\]/.test(env), 'never both blocks at once');
  });

  await test('the roster and the digest are mutually exclusive', async () => {
    await POST(base, '/reply', { url, target: 'page', text: '@claude second question' });
    const log = path.join(logDir, 'bridge.jsonl');
    const env = await waitFor(
      () => inputs(log).find(t => /second question/.test(t)), 'the envelope',
    );
    assert.ok(!/\[this page is filed nowhere\]/.test(env));
  });

  await test('a bot’s suggestion becomes a button, and never a filing', async () => {
    const loose = 'https://example.org/second-loose';
    await POST(base, '/page', { url: loose, title: 'Second loose' });
    await POST(base, '/reply', {
      url: loose, target: 'page',
      text: '@claude [mock:says:It is the same author.\\nfile-in: adriana-paper — same paper]',
    });
    const page = await waitFor(async () => {
      const p = (await GET(base, '/page?url=' + enc(loose))).json;
      return (p.page_chat || []).some(m => m.author === 'claude') ? p : null;
    }, 'the reply');
    const reply = page.page_chat.filter(m => m.author === 'claude').pop();
    assert.deepEqual(reply.file_in,
      { root: root, id: 'adriana-paper', title: "Adriana's paper", why: 'same paper' },
      'the suggestion is lifted onto the message as a button');

    assert.equal(reply.text, 'It is the same author.',
      'and the machinery line is taken out of the words');
    assert.equal('projects' in page, false,
      'BOTS NEVER FILE: the page is still filed nowhere until the reader clicks');
  });

  await test('a suggestion on an already-filed page is not offered at all', async () => {
    const filed = 'https://example.org/already-filed';
    await POST(base, '/page', { url: filed, title: 'Already filed' });
    await POST(base, '/page-projects', { url: filed, root, id: 'journal-submissions' });
    await POST(base, '/reply', {
      url: filed, target: 'page',
      text: '@claude [mock:says:file-in: adriana-paper — I still think so]',
    });
    const page = await waitFor(async () => {
      const p = (await GET(base, '/page?url=' + enc(filed))).json;
      return (p.page_chat || []).some(m => m.author === 'claude') ? p : null;
    }, 'the reply');
    const reply = page.page_chat.filter(m => m.author === 'claude').pop();
    assert.equal('file_in' in reply, false);
    assert.deepEqual((page.projects || []).map(p => p.id), ['journal-submissions']);
  });

  await test('unfiling puts the record back exactly as it was', async () => {
    const r = await POST(base, '/page-projects',
      { url, root, id: 'adriana-paper', attach: false });
    assert.deepEqual(r.json.filed, []);
    const page = (await GET(base, '/page?url=' + enc(url))).json;
    assert.equal('projects' in page, false);
  });
}

for (const p of spawned) { try { p.kill(); } catch { } }
await sleep(150);
for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
try { fs.rmSync(SECRETS, { recursive: true, force: true }); } catch { }

console.log(`\nfiling: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
