#!/usr/bin/env node
// Project artifact pages — detection, confirmation, and the council chat
// behind a local file. See SPEC.md "Project artifact pages" and workspace.mjs.
//
// Everything here runs against FIXTURE council roots built in a temp dir. The
// developer's real council (…/MySiteFromObsidianVault/botference) is never
// read, never written and never bridged against, and the bridge is always the
// mock — no CLI is ever started.
//
//   node frontends/plugin/test/workspace.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

// --- tiny runner ---------------------------------------------------------
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

// --- fixtures ------------------------------------------------------------
const tmps = [];
function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-ws-${tag}-`));
  tmps.push(d);
  // realpath, always: macOS hands out /var/folders/… which is really
  // /private/var/folders/…, and a fixture compared one way against an answer
  // resolved the other would fail for a reason that has nothing to do with the
  // code under test. workspace.mjs resolves both sides; so does this file.
  return fs.realpathSync(d);
}

// A council root exactly as botference lays one out: project.json beside
// work/ and projects/, a portfolio naming the projects, a metadata index over
// the sessions, and session payloads carrying their project_id.
function council(tag, { projects = ['spaceship-engineering'], sessions = [] } = {}) {
  const root = tmp(tag);
  fs.writeFileSync(path.join(root, 'project.json'),
    JSON.stringify({ version: 1, profile: 'vault-drafter' }));
  fs.mkdirSync(path.join(root, 'work', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  for (const id of projects) fs.mkdirSync(path.join(root, 'projects', id), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'portfolio.json'), JSON.stringify({
    version: 1,
    projects: projects.map((id, i) => ({
      id, title: id === 'spaceship-engineering' ? 'Spaceship Engineering' : id,
      status: 'active', priority: i + 1, root: `projects/${id}`,
    })),
  }));
  const entries = {};
  sessions.forEach((s, i) => {
    const payload = {
      version: '2', session_id: s.id, project_id: s.project,
      title: s.title, custom_title: '',
      created_at: '2026-08-01T10:00:00Z', updated_at: s.updated || '2026-08-10T10:00:00Z',
      transcript: s.transcript || [],
      room_history: s.room_history || [],
    };
    fs.writeFileSync(path.join(root, 'work', 'sessions', `${s.id}.json`), JSON.stringify(payload));
    if (s.indexed === false) return;   // legacy: known only to session-index.json
    entries[s.id] = {
      // mtime is what the archive sorts on, and botference's own index keeps it
      // in step with the chat's last turn — so the fixture does too
      mtime: Date.parse(payload.updated_at) / 1000, project_id: s.hideProjectId ? '' : s.project,
      entry_count: (s.transcript || []).length,
      updated_at: payload.updated_at, title: s.title, created_at: payload.created_at,
    };
  });
  fs.writeFileSync(path.join(root, 'work', 'sessions', '.metadata-index.json'),
    JSON.stringify({ version: 1, entries }));
  const legacy = sessions.filter(s => s.hideProjectId);
  if (legacy.length) {
    fs.writeFileSync(path.join(root, 'projects', 'session-index.json'), JSON.stringify({
      sessions: legacy.map(s => ({ project: s.project, session_id: s.id })),
    }));
  }
  return root;
}

function artifact(root, project, name = 'index.html', html = '<h1>Artifact</h1>') {
  const p = path.join(root, 'projects', project, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `<!doctype html><title>Artifact</title>${html}`);
  return { path: p, url: pathToFileURL(p).href };
}

// --- server harness ------------------------------------------------------
const spawned = [];
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-ws-secrets-'));
function startServer({ root, args = [], env = {} }) {
  const proc = spawn(process.execPath, [SERVER, ...args], {
    env: {
      ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: root,
      BOTFERENCE_SECRETS_DIR: SECRETS, PLUGIN_OWNER_PASSWORD: '', REVIEW_HUB_PASSWORD: '',
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
function request(base, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + urlPath, {
      method,
      headers: {
        ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
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

// what the bridge was actually told, in order
const bridgeLog = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const inputs = file => bridgeLog(file).filter(e => e.type === 'input').map(e => String(e.text));

// workspace.mjs pulls in store.mjs, whose ROOT is fixed at import time from
// the environment. Point THIS PROCESS at a throwaway workspace before either
// is loaded: `ws.setRootState` writes a config.json, and it must never be the
// developer's own.
const OWN_ROOT = tmp('own-store');
process.env.BOTFERENCE_PROJECT_ROOT = OWN_ROOT;
const ws = await import(path.join(PLUGIN, 'workspace.mjs'));

console.log('\nworkspace — detection');

await test('a council root is three markers together, never one of them', async () => {
  const root = council('markers');
  assert.equal(ws.isCouncilRoot(root), true);
  const bare = tmp('bare');
  fs.writeFileSync(path.join(bare, 'project.json'), '{}');
  assert.equal(ws.isCouncilRoot(bare), false, 'project.json alone is a file, not a council');
  fs.mkdirSync(path.join(bare, 'work'));
  assert.equal(ws.isCouncilRoot(bare), false, 'two of three is still not a council');
  fs.mkdirSync(path.join(bare, 'projects'));
  assert.equal(ws.isCouncilRoot(bare), true);
});

await test('an artifact is found from any depth inside its project', async () => {
  const root = council('depth');
  const shallow = artifact(root, 'spaceship-engineering');
  const deep = artifact(root, 'spaceship-engineering', 'book/chapters/three.html');
  for (const a of [shallow, deep]) {
    const found = ws.artifactFor(a.url);
    assert.ok(found, `artifact not found for ${a.url}`);
    assert.equal(found.root, root);
    assert.equal(found.project_id, 'spaceship-engineering');
    assert.equal(found.project_title, 'Spaceship Engineering', 'portfolio.json names it');
    assert.equal(found.path, a.path);
  }
});

await test('the project title falls back to the folder name with no portfolio', async () => {
  const root = council('noportfolio', { projects: ['unlisted'] });
  fs.unlinkSync(path.join(root, 'projects', 'portfolio.json'));
  const a = artifact(root, 'unlisted');
  assert.equal(ws.artifactFor(a.url).project_title, 'unlisted');
});

await test('the NEAREST council root wins when one is nested inside another', async () => {
  const outer = council('outer');
  const inner = path.join(outer, 'projects', 'spaceship-engineering', 'sub');
  fs.mkdirSync(path.join(inner, 'work'), { recursive: true });
  fs.mkdirSync(path.join(inner, 'projects', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(inner, 'project.json'), '{}');
  const p = path.join(inner, 'projects', 'nested', 'index.html');
  fs.writeFileSync(p, '<h1>x</h1>');
  const found = ws.artifactFor(pathToFileURL(p).href);
  assert.equal(found.root, inner);
  assert.equal(found.project_id, 'nested');
});

await test('a local file outside any council is not an artifact', async () => {
  const loose = tmp('loose');
  const p = path.join(loose, 'notes.html');
  fs.writeFileSync(p, '<h1>notes</h1>');
  assert.equal(ws.artifactFor(pathToFileURL(p).href), null);
});

await test('a file inside a council but outside projects/ is not an artifact', async () => {
  const root = council('outside');
  const p = path.join(root, 'work', 'report.html');
  fs.writeFileSync(p, '<h1>report</h1>');
  assert.equal(ws.artifactFor(pathToFileURL(p).href), null);
  const top = path.join(root, 'README.html');
  fs.writeFileSync(top, '<h1>readme</h1>');
  assert.equal(ws.artifactFor(pathToFileURL(top).href), null);
});

await test('a DELETED project folder ends the page — the artifact is refused', async () => {
  const root = council('deleted');
  const a = artifact(root, 'spaceship-engineering');
  assert.ok(ws.artifactFor(a.url), 'sanity: found while the project exists');
  fs.rmSync(path.join(root, 'projects', 'spaceship-engineering'), { recursive: true, force: true });
  assert.equal(ws.artifactFor(a.url), null);
});

await test('a missing file is not a page, however good its address looks', async () => {
  const root = council('missing');
  const url = pathToFileURL(path.join(root, 'projects', 'spaceship-engineering', 'gone.html')).href;
  assert.equal(ws.artifactFor(url), null);
});

await test('only HTML: a PDF at the same path is left to the PDF rules', async () => {
  const root = council('pdf');
  const p = path.join(root, 'projects', 'spaceship-engineering', 'paper.pdf');
  fs.writeFileSync(p, '%PDF-1.4');
  assert.equal(ws.artifactFor(pathToFileURL(p).href), null);
});

await test('http(s) and bfp-pdf urls are never artifacts', async () => {
  for (const u of ['https://example.com/index.html', 'bfp-pdf://text/abc', 'file://host/x/index.html']) {
    assert.equal(ws.artifactFor(u), null, u);
  }
});

await test('a file url survives percent-escapes and a fragment', async () => {
  const root = council('escapes');
  const a = artifact(root, 'spaceship-engineering', 'my report.html');
  assert.ok(a.url.includes('%20'), 'sanity: the space is escaped in the url');
  assert.equal(ws.artifactFor(a.url).path, a.path);
  assert.equal(ws.artifactFor(a.url + '#section-2').path, a.path);
});

console.log('\nworkspace — root confirmation');

await test('a root is unanswered, then yes, then remembered', async () => {
  const store = await import(path.join(PLUGIN, 'store.mjs'));
  const root = council('confirm');
  assert.equal(ws.rootState(root), '', 'never asked');
  assert.equal(ws.artifactState(artifact(root, 'spaceship-engineering').url).confirmed, false);
  ws.setRootState(root, true);
  assert.equal(ws.rootState(root), 'yes');
  // and it is on disk, in the plugin's own config — not in the council
  const cfg = JSON.parse(fs.readFileSync(path.join(store.DIR, 'config.json'), 'utf8'));
  assert.equal(cfg.council_roots[root], true);
  assert.equal(fs.existsSync(path.join(root, '.botference')), false,
    'nothing was written into the council root');
});

await test('a NO is kept as firmly as a yes', async () => {
  const root = council('declined');
  ws.setRootState(root, false);
  assert.equal(ws.rootState(root), 'no');
  const st = ws.artifactState(artifact(root, 'spaceship-engineering').url);
  assert.equal(st.confirmed, false);
  assert.equal(st.declined, true, 'the extension must not attach at all');
});

console.log('\nworkspace — the project\'s chats');

const ARCHIVE = council('archive', {
  projects: ['spaceship-engineering', 'ai-futures'],
  sessions: [
    { id: 'aaaa1111-0000-4000-8000-000000000001', project: 'spaceship-engineering',
      title: 'Radiator sizing for the transit hab', updated: '2026-08-12T09:00:00Z',
      transcript: [
        { speaker: 'user', text: 'How big does the radiator have to be?' },
        { speaker: 'claude', text: 'About 400 m² at 350 K.' },
        { speaker: 'codex', text: 'Agreed, and it drives the truss layout.' },
      ] },
    { id: 'bbbb2222-0000-4000-8000-000000000002', project: 'spaceship-engineering',
      title: 'Unitised hull economics', updated: '2026-08-11T09:00:00Z',
      transcript: [{ speaker: 'user', text: 'What does a unitised hull cost?' }] },
    { id: 'cccc3333-0000-4000-8000-000000000003', project: 'ai-futures',
      title: 'Not this project', updated: '2026-08-13T09:00:00Z',
      transcript: [{ speaker: 'user', text: 'elsewhere' }] },
    { id: 'dddd4444-0000-4000-8000-000000000004', project: 'spaceship-engineering',
      title: 'Legacy chat with no project_id in its payload', hideProjectId: true,
      updated: '2026-08-09T09:00:00Z',
      transcript: [{ speaker: 'user', text: 'old' }] },   // entry_count 1, project_id blank
    { id: 'eeee5555-0000-4000-8000-000000000005', project: 'spaceship-engineering',
      title: 'Empty chat nobody spoke in', updated: '2026-08-14T09:00:00Z',
      transcript: [] },
  ],
});

await test('the archive lists only this project\'s chats, newest first', async () => {
  const rows = ws.listSessions(ARCHIVE, 'spaceship-engineering');
  const ids = rows.map(r => r.session_id);
  assert.ok(ids.includes('aaaa1111-0000-4000-8000-000000000001'));
  assert.ok(ids.includes('bbbb2222-0000-4000-8000-000000000002'));
  assert.ok(!ids.includes('cccc3333-0000-4000-8000-000000000003'), 'another project');
  assert.ok(!ids.includes('eeee5555-0000-4000-8000-000000000005'), 'no turns in it');
  assert.deepEqual(rows.map(r => r.title), [
    'Radiator sizing for the transit hab',
    'Unitised hull economics',
    'Legacy chat with no project_id in its payload',
  ], 'newest first');
  assert.equal(rows[0].entry_count, 3);
});

await test('session-index.json backfills a chat whose payload predates project_id', async () => {
  const ids = ws.listSessions(ARCHIVE, 'spaceship-engineering').map(r => r.session_id);
  assert.ok(ids.includes('dddd4444-0000-4000-8000-000000000004'));
});

await test('a project-local sessions/ dir is read too', async () => {
  const root = council('local');
  const dir = path.join(root, 'projects', 'spaceship-engineering', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local-1.json'), JSON.stringify({
    session_id: 'local-1', project_id: 'spaceship-engineering', title: 'A project-local chat',
    updated_at: '2026-08-15T00:00:00Z', transcript: [{ speaker: 'user', text: 'hi' }],
  }));
  const rows = ws.listSessions(root, 'spaceship-engineering');
  assert.deepEqual(rows.map(r => r.session_id), ['local-1']);
});

await test('the legacy self-hosted layout (<root>/sessions, no work/) is read too', async () => {
  // the original vault keeps sessions at <root>/sessions — the layout the
  // live spaceship-engineering root actually uses. This test fails on code
  // that only knows work/sessions.
  const root = council('legacy-layout');
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'ffff6666-0000-4000-8000-000000000006';
  fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
    version: '2', session_id: sid, project_id: 'spaceship-engineering',
    title: 'A legacy-layout chat', updated_at: '2026-08-16T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    transcript: [{ speaker: 'user', text: 'hello from the old layout' },
      { speaker: 'claude', text: 'still here' }],
  }));
  fs.writeFileSync(path.join(dir, '.metadata-index.json'), JSON.stringify({
    version: 1,
    entries: { [sid]: { mtime: Date.parse('2026-08-16T00:00:00Z') / 1000,
      project_id: 'spaceship-engineering', entry_count: 2,
      updated_at: '2026-08-16T00:00:00Z', title: 'A legacy-layout chat',
      created_at: '2026-08-01T00:00:00Z' } },
  }));
  const rows = ws.listSessions(root, 'spaceship-engineering');
  assert.deepEqual(rows.map(r => r.session_id), [sid]);
  const t = ws.sessionTail(root, 'spaceship-engineering', sid);
  assert.equal(t.msgs.length, 2);
  assert.equal(t.msgs[1].author, 'claude');
});

await test('the tail of a chat comes back as drawer messages, marked restored', async () => {
  const t = ws.sessionTail(ARCHIVE, 'spaceship-engineering', 'aaaa1111-0000-4000-8000-000000000001');
  assert.equal(t.title, 'Radiator sizing for the transit hab');
  assert.equal(t.msgs.length, 3);
  assert.equal(t.total, 3, 'total counts renderable messages in the whole chat');
  assert.equal(t.msgs[1].author, 'claude');
  assert.equal(t.msgs[1].text, 'About 400 m² at 350 K.');
  assert.ok(t.msgs.every(m => m.restored === true), 'every one of them is restored');
  assert.ok(t.msgs.every(m => Number.isNaN(Date.parse(m.ts))),
    'the ts is an address, never a date the transcript did not record');
  assert.equal(new Set(t.msgs.map(m => m.ts)).size, 3, 'and it is unique per message');
});

await test('system lines and empty turns are not messages', async () => {
  const root = council('systemlines', {
    sessions: [{ id: 'sys-1', project: 'spaceship-engineering', title: 'x',
      room_history: [
        { speaker: 'user', text: 'go' },
        { speaker: 'system', text: 'Starting claude session…' },
        { speaker: 'claude', text: '' },
        { speaker: 'claude', text: 'done' },
      ] }],
  });
  const t = ws.sessionTail(root, 'spaceship-engineering', 'sys-1');
  assert.deepEqual(t.msgs.map(m => m.text), ['go', 'done']);
});

await test('a sid from another project, or with a slash in it, is refused', async () => {
  assert.equal(ws.sessionTail(ARCHIVE, 'spaceship-engineering', 'cccc3333-0000-4000-8000-000000000003'), null);
  assert.equal(ws.sessionTail(ARCHIVE, 'spaceship-engineering', '../../../etc/passwd'), null);
  assert.equal(ws.sessionTail(ARCHIVE, 'spaceship-engineering', 'nope'), null);
});

await test('a drawer envelope is taken back off the reader\'s own words', async () => {
  const chat = await import(path.join(PLUGIN, 'chat.mjs'));
  const env = chat.envelope({
    url: 'file:///c/projects/p/index.html', title: 'Artifact', target: '__page__',
    text: '@claude what does this chart mean?', first: true, verbosity: 'short',
    project: { id: 'p', title: 'P', path: '/c/projects/p/index.html' },
  });
  assert.ok(env.includes('[project artifact:'), 'sanity: the artifact banner is there');
  assert.equal(ws.stripEnvelope(env), '@claude what does this chart mean?');
  // an anchored thread's envelope, and a plain TUI turn that never had one
  const anchored = chat.envelope({
    url: 'x', title: 'T', target: 't-1', text: 'why?', quote: 'the passage',
    history: [], verbosity: 'short',
  });
  assert.equal(ws.stripEnvelope(anchored), 'why?');
  assert.equal(ws.stripEnvelope('just a question I typed in the TUI'),
    'just a question I typed in the TUI');
});

console.log('\ncompanion — the project-page endpoints');

{
  const root = council('api', {
    sessions: [
      { id: 'sess-old-1', project: 'spaceship-engineering', title: 'An earlier chat',
        updated: '2026-08-12T09:00:00Z',
        transcript: [
          { speaker: 'user', text: 'What is the thesis?' },
          { speaker: 'claude', text: 'Fields form around production systems.' },
        ] },
    ],
  });
  const a = artifact(root, 'spaceship-engineering');
  const other = tmp('api-elsewhere');
  const loosePath = path.join(other, 'loose.html');
  fs.writeFileSync(loosePath, '<h1>loose</h1>');
  const looseUrl = pathToFileURL(loosePath).href;

  const workspaceRoot = tmp('api-companion');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
    },
  });

  await test('GET /project-page says no for an ordinary local file', async () => {
    const r = await GET(base, '/project-page?url=' + enc(looseUrl));
    assert.equal(r.status, 200);
    assert.equal(r.json.artifact, null);
  });

  await test('GET /project-page names the project, unconfirmed at first', async () => {
    const r = await GET(base, '/project-page?url=' + enc(a.url));
    assert.equal(r.json.artifact.project_id, 'spaceship-engineering');
    assert.equal(r.json.artifact.project_title, 'Spaceship Engineering');
    assert.equal(r.json.artifact.root, root);
    assert.equal(r.json.artifact.confirmed, false);
    assert.equal(r.json.artifact.declined, false);
  });

  await test('the archive and the tail are refused until the root is confirmed', async () => {
    const s = await GET(base, '/project-sessions?url=' + enc(a.url));
    assert.equal(s.status, 409);
    const t = await GET(base, '/project-session?url=' + enc(a.url) + '&sid=sess-old-1');
    assert.equal(t.status, 409);
  });

  await test('a mention on an unconfirmed page is KEPT but summons nobody', async () => {
    await POST(base, '/page', { url: a.url, title: 'Artifact', site: 'spaceship-engineering' });
    const r = await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: '@claude hello' });
    assert.equal(r.status, 200);
    assert.equal(r.json.queued, false);
    assert.match(String(r.json.reason), /not confirmed/i);
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    assert.equal(page.page_chat.at(-1).text, '@claude hello', 'the message is not lost');
    assert.equal(inputs(logFile).length, 0, 'and no bridge was started');
  });

  await test('POST /council-root refuses a directory that is not a council', async () => {
    const r = await POST(base, '/council-root', { root: other, confirm: true });
    assert.equal(r.status, 400);
  });

  await test('POST /council-root confirms it, and the answer sticks', async () => {
    const r = await POST(base, '/council-root', { root, confirm: true });
    assert.equal(r.json.state, 'yes');
    const p = await GET(base, '/project-page?url=' + enc(a.url));
    assert.equal(p.json.artifact.confirmed, true);
  });

  await test('GET /project-sessions is the project\'s chat archive', async () => {
    const r = await GET(base, '/project-sessions?url=' + enc(a.url));
    assert.equal(r.json.project_id, 'spaceship-engineering');
    assert.equal(r.json.current, null, 'this page is standing in no chat yet');
    assert.deepEqual(r.json.sessions.map(s => s.session_id), ['sess-old-1']);
    assert.equal(r.json.sessions[0].title, 'An earlier chat');
  });

  await test('POST /project-chat opens a past chat and fills the page with its tail', async () => {
    const r = await POST(base, '/project-chat', { url: a.url, sid: 'sess-old-1' });
    assert.equal(r.json.session_id, 'sess-old-1');
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    assert.equal(page.session_id, 'sess-old-1');
    assert.equal(page.session_title, 'An earlier chat');
    assert.deepEqual(page.page_chat.map(m => m.text),
      ['What is the thesis?', 'Fields form around production systems.']);
    assert.ok(page.page_chat.every(m => m.restored));
  });

  await test('…and GET /project-sessions now says which chat that is', async () => {
    const r = await GET(base, '/project-sessions?url=' + enc(a.url));
    assert.equal(r.json.current, 'sess-old-1');
  });

  await test('a turn on the opened chat RESUMES it in the real project', async () => {
    fs.writeFileSync(logFile, '');
    const r = await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: '@claude and now?' });
    assert.equal(r.json.queued, true);
    await waitFor(() => inputs(logFile).some(t => t.includes('@claude and now')), 'the user turn');
    const sent = inputs(logFile);
    assert.ok(sent.some(t => t === '/project open spaceship-engineering'),
      `the REAL project was opened — got ${JSON.stringify(sent)}`);
    assert.ok(!sent.some(t => t.startsWith('/project create')),
      'a workspace bridge never creates a project — it exists already');
    assert.ok(sent.some(t => t === '/resume sess-old-1'), 'and the page\'s own chat was resumed');
    assert.ok(sent.every(t => t !== '/quit'));
  });

  await test('the bot\'s reply lands in the page record', async () => {
    await waitFor(async () => {
      const page = (await GET(base, '/page?url=' + enc(a.url))).json;
      return page.page_chat.some(m => m.author === 'claude' && /MOCK claude reply/.test(m.text));
    }, 'the reply to be persisted');
  });

  await test('the bridge ran against the COUNCIL root, not the companion\'s', async () => {
    // the mock writes the session choreography, but the working root is only
    // visible in what the child was spawned with — assert it the honest way:
    // the plugin bridge was never started, and no "Plugin pages" was created
    const sent = inputs(logFile);
    assert.ok(!sent.some(t => /Plugin pages/.test(t)));
  });

  await test('POST /project-chat {new:true} starts a fresh chat in the project', async () => {
    const r = await POST(base, '/project-chat', { url: a.url, new: true });
    assert.equal(r.json.session_id, null);
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    assert.deepEqual(page.page_chat, [], 'the mirror of the old chat is gone');
    fs.writeFileSync(logFile, '');
    await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: '@claude fresh start' });
    await waitFor(() => inputs(logFile).some(t => t.includes('@claude fresh start')), 'the new turn');
    const sent = inputs(logFile);
    assert.ok(sent.some(t => t === '/new'), `a new chat was created — got ${JSON.stringify(sent)}`);
    assert.ok(sent.some(t => t.startsWith('/rename ')));
  });

  await test('a second artifact in ANOTHER project re-opens that project', async () => {
    fs.mkdirSync(path.join(root, 'projects', 'ai-futures'), { recursive: true });
    const b = artifact(root, 'ai-futures', 'index.html');
    await POST(base, '/page', { url: b.url, title: 'Futures', site: 'ai-futures' });
    fs.writeFileSync(logFile, '');
    await POST(base, '/reply', { url: b.url, thread_id: '__page__', text: '@claude hello there' });
    await waitFor(() => inputs(logFile).some(t => t.includes('@claude hello there')), 'the turn');
    assert.ok(inputs(logFile).some(t => t === '/project open ai-futures'),
      `the other project was opened — got ${JSON.stringify(inputs(logFile))}`);
  });

  await test('POST /project-chat refuses a sid from another project', async () => {
    const r = await POST(base, '/project-chat', { url: a.url, sid: 'sess-nope' });
    assert.equal(r.status, 404);
  });

  await test('a declined root turns the page back into an ordinary file', async () => {
    const dr = council('declined-api');
    const da = artifact(dr, 'spaceship-engineering');
    assert.equal((await GET(base, '/project-page?url=' + enc(da.url))).json.artifact.declined, false);
    await POST(base, '/council-root', { root: dr, confirm: false });
    const r = await GET(base, '/project-page?url=' + enc(da.url));
    assert.equal(r.json.artifact.declined, true);
    assert.equal(r.json.artifact.confirmed, false);
  });

  await test('the ordinary "Plugin pages" bridge is untouched by all of this', async () => {
    const plainLog = path.join(workspaceRoot, 'plain.jsonl');
    const plain = await startServer({
      root: tmp('plain'),
      env: {
        PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
        MOCK_BRIDGE_LOG: plainLog,
      },
    });
    const u = 'https://example.test/an-article';
    await POST(plain.base, '/page', { url: u, title: 'An article', site: 'example.test' });
    await POST(plain.base, '/reply', { url: u, thread_id: '__page__', text: '@claude hi' });
    await waitFor(() => inputs(plainLog).some(t => t.includes('@claude hi')), 'the turn');
    const sent = inputs(plainLog);
    assert.equal(sent[0], '/project create Plugin pages');
    assert.equal(sent[1], '/project open plugin-pages');
  });
}

// ── Phase 2: writes scoped to projects/<id>/, and the tab that reloads ─────
// Two claims, and they are separate claims:
//
//   1. WHERE the bots may write is decided when the child is SPAWNED, and the
//      value it is spawned with is exactly one project folder. The real
//      bridge turns BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS into claude's
//      permissions.allow Edit rules and codex's workspace-write sandbox root
//      (core/cli_adapters.py planner_write_config), so what is asserted here
//      is the thing that decides both. No CLI is started; the mock records
//      the environment it was born with.
//   2. WHAT changed is a census of the folder taken around the turn, and the
//      event only fires when a turn moved something under it.
console.log('\ncompanion — Phase 2: writes and the reload');

{
  const root = council('w2');
  const a = artifact(root, 'spaceship-engineering');
  const projectDir = path.join(root, 'projects', 'spaceship-engineering');

  const workspaceRoot = tmp('w2-companion');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const envFile = path.join(workspaceRoot, 'bridge-env.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
      MOCK_ENV_DUMP: envFile,
    },
  });
  const spawnEnvs = () => (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const writeRootOf = e => (e.scope || {}).BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS;

  // every event the companion broadcast, in order
  function listen(b) {
    const seen = [];
    const req = http.request(b + '/events', { method: 'GET' }, res => {
      let buf = '';
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(frame);
          if (!m) continue;
          try { seen.push(JSON.parse(m[1])); } catch { }
        }
      });
    });
    req.end();
    return { seen, close: () => req.destroy(), of: t => seen.filter(e => e.type === t) };
  }
  const events = listen(base);
  await sleep(120);

  await POST(base, '/council-root', { root, confirm: true });
  await POST(base, '/page', { url: a.url, title: 'Artifact', site: 'spaceship-engineering' });

  await test('the workspace bridge is spawned with the project folder as its ONE write root', async () => {
    await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: '@claude hello' });
    await waitFor(() => spawnEnvs().length >= 1, 'the workspace child to spawn');
    const e = spawnEnvs()[0];
    assert.equal(writeRootOf(e), projectDir,
      `the write root is this project's folder — got ${JSON.stringify(e.scope)}`);
    assert.equal((e.scope || {}).BOTFERENCE_PROJECT_ROOT, root,
      'and the workspace is still the council root, so the chat files where it belongs');
    assert.ok(!writeRootOf(e).includes('..'), 'absolute, with nothing to walk out of');
  });

  await test('the envelope states the rule in words as well', async () => {
    const turn = await waitFor(() => inputs(logFile).find(t => t.includes('@claude hello')), 'the turn');
    assert.ok(turn.includes(`You may create and edit files under ${projectDir}`),
      `the write scope is spelled out — got:\n${turn}`);
    assert.ok(/nothing outside it/.test(turn), 'and the boundary is named');
  });

  await test('a second project in the same council gets its own child and its own folder', async () => {
    fs.mkdirSync(path.join(root, 'projects', 'ai-futures'), { recursive: true });
    const b = artifact(root, 'ai-futures');
    await POST(base, '/page', { url: b.url, title: 'Futures', site: 'ai-futures' });
    await POST(base, '/reply', { url: b.url, thread_id: '__page__', text: '@claude hello there' });
    await waitFor(() => spawnEnvs().length >= 2, 'the second workspace child');
    const roots = spawnEnvs().map(writeRootOf).filter(Boolean);
    assert.deepEqual([...new Set(roots)].sort(),
      [path.join(root, 'projects', 'ai-futures'), projectDir].sort(),
      'one child per project, each writable only in its own folder');
  });

  await test('the ordinary bridge is spawned with NO write root at all', async () => {
    const plainRoot = tmp('w2-plain');
    const plainEnv = path.join(plainRoot, 'env.jsonl');
    const plain = await startServer({
      root: plainRoot,
      env: {
        PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
        MOCK_BRIDGE_LOG: path.join(plainRoot, 'log.jsonl'),
        MOCK_ENV_DUMP: plainEnv,
      },
    });
    const u = 'https://example.test/an-article';
    await POST(plain.base, '/page', { url: u, title: 'An article', site: 'example.test' });
    await POST(plain.base, '/reply', { url: u, thread_id: '__page__', text: '@claude hi' });
    await waitFor(() => fs.existsSync(plainEnv) && fs.readFileSync(plainEnv, 'utf8').trim(), 'the plain child');
    const e = JSON.parse(fs.readFileSync(plainEnv, 'utf8').split('\n').filter(Boolean)[0]);
    assert.ok(!('BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS' in (e.scope || {})),
      `an ordinary page grants no write root — got ${JSON.stringify(e.scope)}`);
  });

  await test('the permission gate stays shut on a workspace bridge, even inside the project', async () => {
    const inside = path.join(projectDir, 'notes.md');
    await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: `@claude [mock:perm:${inside}] write it` });
    await waitFor(() => bridgeLog(logFile).some(e => e.type === 'permission_response'), 'the answer');
    const answers = bridgeLog(logFile).filter(e => e.type === 'permission_response');
    assert.ok(answers.length >= 1);
    assert.ok(answers.every(e => e.allow === false),
      'a yes here would grant a whole extra write ROOT — the folder is already writable without asking');
  });

  await test('a turn that rewrites the artifact broadcasts one project-files event', async () => {
    const before = events.of('project-files').length;
    await POST(base, '/reply', { url: a.url, thread_id: '__page__',
      text: `@claude [mock:write:${a.path}] rewrite it` });
    await waitFor(() => events.of('project-files').length > before, 'the change event');
    const ev = events.of('project-files').pop();
    assert.equal(ev.url, a.url);
    assert.equal(ev.project_id, 'spaceship-engineering');
    assert.equal(ev.page_changed, true, "this page's own file moved, so the tab reloads");
    assert.equal(ev.count, 1);
    assert.deepEqual(ev.files, ['index.html']);
  });

  await test('a sibling file changing is reported, but not as this page changing', async () => {
    const before = events.of('project-files').length;
    const sib = path.join(projectDir, 'appendix.html');
    await POST(base, '/reply', { url: a.url, thread_id: '__page__',
      text: `@claude [mock:write:${sib}] add an appendix` });
    await waitFor(() => events.of('project-files').length > before, 'the change event');
    const ev = events.of('project-files').pop();
    assert.equal(ev.page_changed, false, 'a note, not a reload');
    assert.deepEqual(ev.files, ['appendix.html']);
  });

  await test('a turn that changes nothing says nothing', async () => {
    const before = events.of('project-files').length;
    await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: '@claude just talk' });
    await waitFor(() => inputs(logFile).some(t => t.includes('just talk')), 'the turn');
    await sleep(500);
    assert.equal(events.of('project-files').length, before, 'no census difference, no event');
  });

  await test('a change OUTSIDE the project is never reported as one', async () => {
    const before = events.of('project-files').length;
    // the mock can write anywhere — the real child cannot, and that is the
    // point: even when something outside projects/<id>/ moves during a turn,
    // nothing here claims the bots were allowed to do it
    const outside = path.join(root, 'work', 'stray.md');
    await POST(base, '/reply', { url: a.url, thread_id: '__page__',
      text: `@claude [mock:write:${outside}] stray` });
    await waitFor(() => inputs(logFile).some(t => t.includes('stray')), 'the turn');
    await sleep(500);
    assert.equal(events.of('project-files').length, before,
      'the census only ever looks inside the project folder');
    assert.ok(fs.existsSync(outside), 'the mock really did write it — the silence is the census, not the write failing');
  });

  await test('the session botference writes during a turn is not a change', async () => {
    const before = events.of('project-files').length;
    fs.mkdirSync(path.join(projectDir, 'sessions'), { recursive: true });
    const s = path.join(projectDir, 'sessions', 'sess-x.json');
    await POST(base, '/reply', { url: a.url, thread_id: '__page__',
      text: `@claude [mock:write:${s}] save the chat` });
    await waitFor(() => inputs(logFile).some(t => t.includes('save the chat')), 'the turn');
    await sleep(500);
    assert.equal(events.of('project-files').length, before,
      'sessions/ churns on every turn and would make every turn a change');
  });

  await test('GET /project-changes hands back the last change set', async () => {
    const r = await GET(base, '/project-changes?url=' + enc(a.url));
    assert.equal(r.status, 200);
    assert.ok(r.json.changes, 'something was recorded');
    assert.equal(r.json.changes.project_id, 'spaceship-engineering');
  });

  await test('GET /project-changes is owner-only', async () => {
    const hostedRoot = tmp('w2-hosted');
    const h = await startServer({
      root: hostedRoot,
      args: ['--hosted'],
      env: {
        PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw',
        PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
        MOCK_BRIDGE_LOG: path.join(hostedRoot, 'log.jsonl'),
      },
    });
    const guest = { host: 'annotations.example', authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
    for (const route of ['/project-changes', '/project-page', '/project-sessions', '/project-session']) {
      const r = await GET(h.base, `${route}?url=${enc(a.url)}`, guest);
      assert.equal(r.status, 403, `${route} must be owner-only`);
    }
  });

  events.close();
}

for (const p of spawned) { try { p.kill(); } catch { } }
await sleep(150);
for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
try { fs.rmSync(SECRETS, { recursive: true, force: true }); } catch { }

console.log(`\nworkspace: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
