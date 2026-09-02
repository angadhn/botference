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
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import {
  createHarness, sleep, enc, GET, POST, inputs, bridgeLog, listen,
} from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const SERVER = path.join(PLUGIN, 'server.mjs');
const MOCK = path.join(TEST, 'mock-bridge.mjs');

// --- tiny runner ---------------------------------------------------------
// The scaffolding — runner, poller, throwaway root, a companion on a random
// port, JSON over HTTP — is test/harness.mjs, shared with every other suite
// that drives a real server. It was a private copy here, as in eight others.
const {
  test, waitFor, tmp, startServer, cleanup, passed, failures,
} = createHarness({ server: SERVER, tag: 'ws', realpath: true });

// --- fixtures ------------------------------------------------------------

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

// what the bridge was actually told, in order

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

// ---------------------------------------------------------------------------
// The same artifact, read through the council's own web UI.
//
// A bot links the file it wrote as `/files/<rel>`, so the reader often meets
// the artifact at an http(s) address. That must be the SAME Discuss page — and
// the only thing that separates the reader's council from evil.com serving the
// identical path is the origin allowlist, so most of what is below is about
// what must NOT be believed.
// ---------------------------------------------------------------------------
console.log('\nworkspace — the council web view');

{
  const store = await import(path.join(PLUGIN, 'store.mjs'));
  const LOCAL = 'http://localhost:4187';
  const TUNNEL = 'https://council.example.com';
  const cwRoot = council('cweb');
  ws.setRootState(cwRoot, true);
  const a = artifact(cwRoot, 'spaceship-engineering', 'artifacts/lot3.2 rpod draft.review.html');
  const filesUrl = (base, rel) => `${base}/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const REL = 'projects/spaceship-engineering/artifacts/lot3.2 rpod draft.review.html';
  const localUrl = filesUrl(LOCAL, REL);

  await test('a trusted council-web url is the same artifact as its file: twin', async () => {
    assert.ok(localUrl.includes('%20'), 'sanity: the spaces are escaped, as the browser sends them');
    const found = ws.artifactFor(localUrl);
    assert.ok(found, 'the default council_web origin is trusted');
    assert.equal(found.root, cwRoot);
    assert.equal(found.project_id, 'spaceship-engineering');
    assert.equal(found.project_title, 'Spaceship Engineering');
    assert.equal(found.path, a.path);
    assert.equal(found.rel, path.relative(cwRoot, a.path));
    assert.equal(found.via, 'council-web');
  });

  await test('…and its identity is the file: twin\'s, exactly', async () => {
    assert.equal(ws.artifactFor(localUrl).ident_href, a.url);
    const twin = ws.artifactFor(a.url);
    assert.equal(twin.via, 'file');
    assert.equal(twin.ident_href, undefined,
      'a file: page keeps the address it already has — nothing to canonicalise');
    // and the confirmation state travels with it, either way in
    assert.equal(ws.artifactState(localUrl).confirmed, true);
  });

  await test('an UNTRUSTED origin serving the same path is an ordinary web page', async () => {
    for (const base of ['https://evil.com', 'http://evil.com:4187', TUNNEL,
                        'http://localhost:4188', 'https://localhost:4187']) {
      assert.equal(ws.artifactFor(filesUrl(base, REL)), null, base);
      assert.equal(ws.councilWebPaths(filesUrl(base, REL)).length, 0, base);
    }
  });

  await test('the tunnel origin is one line of config away, and no more', async () => {
    store.saveConfig({ council_web_origins: [TUNNEL] });
    assert.ok(ws.councilWebOrigins().has(TUNNEL), 'the list is read');
    const found = ws.artifactFor(filesUrl(TUNNEL, REL));
    assert.ok(found, 'the tunnel now serves this reader\'s own council');
    assert.equal(found.ident_href, a.url, 'and the identity is still the file: twin');
    // a neighbour on the same host is still nobody
    assert.equal(ws.artifactFor(filesUrl('https://other.example.com', REL)), null);
    // …and garbage in the list is ignored rather than trusted
    store.saveConfig({ council_web_origins: [TUNNEL, 'not a url', 'file:///etc', 42] });
    assert.deepEqual([...ws.councilWebOrigins()].sort(),
      ['http://localhost:4187', TUNNEL].sort());
    store.saveConfig({ council_web_origins: [] });
    assert.equal(ws.artifactFor(filesUrl(TUNNEL, REL)), null, 'and it is gone again when removed');
  });

  await test('the configured council_web origin is trusted, path and all', async () => {
    store.saveConfig({ council_web: 'https://council.example.com/?chat=abc' });
    assert.ok(ws.artifactFor(filesUrl(TUNNEL, REL)), 'only the origin of it is taken');
    store.saveConfig({ council_web: LOCAL });
  });

  await test('traversal out of /files/ is refused, encoded or not', async () => {
    const outside = path.join(cwRoot, 'work', 'report.html');
    fs.writeFileSync(outside, '<h1>report</h1>');
    // A dot SEGMENT never survives to be a traversal, plain or percent-spelled:
    // the URL parser collapses `.`, `..`, `%2e` and `%2e%2e` alike (as the
    // browser does before it sends, and as the council server therefore sees
    // it), so `…/../../work/report.html` simply IS `/files/work/report.html` —
    // refused, but by the projects/<id>/ rule rather than by a check of ours.
    for (const rel of ['projects/spaceship-engineering/../../work/report.html',
                       'projects/spaceship-engineering/%2e%2e/%2e%2e/work/report.html',
                       'projects/spaceship-engineering/../..',
                       '../../../etc/hosts',
                       '%2e%2e/%2e%2e/etc/hosts']) {
      const u = `${LOCAL}/files/${rel}`;
      assert.equal(ws.artifactFor(u), null, u);
    }
    // A traversal hidden behind an encoded SLASH is a different matter: it is
    // one path segment to the parser, so it survives untouched and is refused
    // HERE, after decoding — which is the only place it can be refused.
    const escapes = [
      'projects/spaceship-engineering/..%2f..%2fwork%2freport.html',
      '..%2f..%2f..%2fetc%2fhosts',
      'projects/spaceship-engineering/.hidden/index.html',
      'projects/spaceship-engineering/%2findex.html',
      'projects%2f..%2f..%2fwork%2freport.html',
    ];
    for (const rel of escapes) {
      const u = `${LOCAL}/files/${rel}`;
      assert.equal(ws.artifactFor(u), null, u);
      assert.equal(ws.councilWebPaths(u).length, 0, u);
    }
  });

  await test('only the /files/ route, and only a real .html file under it', async () => {
    for (const p of [
      `${LOCAL}/`, `${LOCAL}/?chat=abc`, `${LOCAL}/uploads/projects/spaceship-engineering/index.html`,
      `${LOCAL}/filesystem/projects/spaceship-engineering/index.html`,
      `${LOCAL}/files/`, `${LOCAL}/files/projects/spaceship-engineering/gone.html`,
      `${LOCAL}/files/projects/spaceship-engineering`,
    ]) assert.equal(ws.artifactFor(p), null, p);
    fs.writeFileSync(path.join(cwRoot, 'projects', 'spaceship-engineering', 'paper.pdf'), '%PDF-1.4');
    assert.equal(ws.artifactFor(`${LOCAL}/files/projects/spaceship-engineering/paper.pdf`), null,
      'a PDF is left to the PDF rules, whichever way it arrived');
  });

  await test('a file inside the council but outside projects/<id>/ is not an artifact', async () => {
    fs.writeFileSync(path.join(cwRoot, 'README.html'), '<h1>readme</h1>');
    assert.equal(ws.artifactFor(`${LOCAL}/files/README.html`), null);
    assert.equal(ws.artifactFor(`${LOCAL}/files/work/report.html`), null);
  });

  await test('a root the reader has never been asked about resolves nothing', async () => {
    // the same rel path, in a council the companion has never seen: an http url
    // carries no absolute path to walk up from, so `council_roots` is the only
    // honest source of candidates
    const unknown = council('cweb-unknown');
    artifact(unknown, 'spaceship-engineering', 'artifacts/lot3.2 rpod draft.review.html');
    assert.equal(ws.rootState(unknown), '', 'sanity: never answered for');
    const found = ws.artifactFor(localUrl);
    assert.equal(found.root, cwRoot, 'the known root answered, not the stranger');
    // …and a DECLINED root still resolves, so the answer stays "declined"
    // rather than quietly becoming an ordinary page for another reason
    const no = council('cweb-declined', { projects: ['ai-futures'] });
    const nb = artifact(no, 'ai-futures');
    ws.setRootState(no, false);
    const st = ws.artifactState(`${LOCAL}/files/projects/ai-futures/index.html`);
    assert.ok(st, 'resolved');
    assert.equal(st.path, nb.path);
    assert.equal(st.declined, true);
  });
}

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

console.log('\nworkspace — projects/<id>/TASKS.md');

await test('a bot-written TASKS.md parses down to items, junk and all', async () => {
  const items = ws.parseTasksMd([
    '# Tasks',
    '',
    'Prose the panels ignore, including why an item left the list.',
    '- [ ] Pull the dataset',
    '* [x] Rebuild the deflator',
    '+ [X] Redraw figure 3',
    '   - [ ]   Re-run   the   regression   ',
    '- [ ] Pull the dataset',
    '- a plain bullet',
    '- [ ]',
    '- [] an empty box is an open item, not junk',
    '| a | table |',
  ].join('\n'));
  assert.deepEqual(items, [
    { text: 'Pull the dataset', done: false },
    { text: 'Rebuild the deflator', done: true },
    { text: 'Redraw figure 3', done: true },
    { text: 'Re-run the regression', done: false },
    { text: 'an empty box is an open item, not junk', done: false },
  ]);
});

await test('junk in, nothing out — never a throw', async () => {
  for (const junk of [null, undefined, '', 'not a list at all', '- [ ] \n', ' ']) {
    assert.ok(Array.isArray(ws.parseTasksMd(junk)), String(junk));
  }
  assert.deepEqual(ws.parseTasksMd('not a list at all'), []);
});

await test('a runaway file is bounded, in items and in line length', async () => {
  const many = Array.from({ length: 500 }, (_, i) => `- [ ] item ${i}`).join('\n');
  assert.equal(ws.parseTasksMd(many).length, 200);
  const long = ws.parseTasksMd('- [ ] ' + 'x'.repeat(1000))[0];
  assert.equal(long.text.length, 300);
  assert.ok(long.text.endsWith('…'));
});

await test('projectTasks reads the project file, and shrugs at a missing one', async () => {
  const root = council('tasksfile');
  assert.deepEqual(ws.projectTasks(root, 'spaceship-engineering'), []);
  fs.writeFileSync(
    path.join(root, 'projects', 'spaceship-engineering', 'TASKS.md'),
    '# Tasks\n\n- [x] Fuel the thing\n- [ ] Light it\n', 'utf8');
  assert.deepEqual(ws.projectTasks(root, 'spaceship-engineering'), [
    { text: 'Fuel the thing', done: true },
    { text: 'Light it', done: false },
  ]);
  assert.deepEqual(ws.projectTasks(root, 'no-such-project'), []);
  assert.deepEqual(ws.projectTasks('', 'spaceship-engineering'), []);
  const d = council('tasksdir');
  fs.mkdirSync(path.join(d, 'projects', 'spaceship-engineering', 'TASKS.md'));
  assert.deepEqual(ws.projectTasks(d, 'spaceship-engineering'), []);
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

  // ---- the project's own task list on the page payload ------------------
  await test('an unconfirmed root TASKS.md is never read into the drawer', async () => {
    // The root above is confirmed, so prove the gate on a DIFFERENT,
    // still-unanswered council rather than by un-confirming this one.
    const shy = council('tasks-unconfirmed');
    const sa = artifact(shy, 'spaceship-engineering', 'doc.html');
    fs.writeFileSync(path.join(shy, 'projects', 'spaceship-engineering', 'TASKS.md'),
      '- [ ] Secret plans\n', 'utf8');
    const r = await GET(base, '/project-page?url=' + enc(sa.url));
    assert.equal(r.json.artifact.confirmed, false);
    assert.equal(r.json.artifact.tasks, undefined,
      'a folder the reader has not claimed is not read from');
  });

  await test('a confirmed project ships its TASKS.md with the page', async () => {
    const file = path.join(root, 'projects', 'spaceship-engineering', 'TASKS.md');
    const before = await GET(base, '/project-page?url=' + enc(a.url));
    assert.equal(before.json.artifact.tasks, undefined,
      'no list: a missing key, not an empty section');
    fs.writeFileSync(file,
      '# Tasks\n\nWhat this project still owes.\n\n- [x] Draw the nozzle\n- [ ] Test-fire it\n',
      'utf8');
    const after = await GET(base, '/project-page?url=' + enc(a.url));
    assert.deepEqual(after.json.artifact.tasks, [
      { text: 'Draw the nozzle', done: true },
      { text: 'Test-fire it', done: false },
    ]);
    // it is the project's list, so it follows the project and not the page
    const b2 = artifact(root, 'spaceship-engineering', 'second.html');
    const other2 = await GET(base, '/project-page?url=' + enc(b2.url));
    assert.deepEqual(other2.json.artifact.tasks, after.json.artifact.tasks);
    fs.rmSync(file);
    const gone = await GET(base, '/project-page?url=' + enc(a.url));
    assert.equal(gone.json.artifact.tasks, undefined, 'delete the file, lose the section');
  });

  // ---- the same artifact through the council's web UI ------------------
  // The reader clicks the link a bot posted — `/files/<rel>` on the council
  // web server — and must land on the SAME Discuss page, not a twin of it.
  const cwRel = path.relative(root, a.path).split(path.sep).map(enc).join('/');
  const cwUrl = `http://localhost:4187/files/${cwRel}`;
  const CFG_FILE = path.join(workspaceRoot, '.botference', 'plugin', 'config.json');

  await test('GET /project-page answers for a trusted council-web url', async () => {
    const r = await GET(base, '/project-page?url=' + enc(cwUrl));
    assert.equal(r.status, 200);
    const art = r.json.artifact;
    assert.ok(art, 'the default council_web origin is this reader\'s own council');
    assert.equal(art.project_id, 'spaceship-engineering');
    assert.equal(art.project_title, 'Spaceship Engineering');
    assert.equal(art.root, root);
    assert.equal(art.confirmed, true, 'the root\'s answer travels, whichever view asked');
    assert.equal(art.via, 'council-web');
    // the identity the extension will file everything under: the file: twin
    assert.equal(art.ident_href, a.url);
  });

  await test('…and the file: view is still told its address IS its identity', async () => {
    const r = await GET(base, '/project-page?url=' + enc(a.url));
    assert.equal(r.json.artifact.via, 'file');
    assert.equal(r.json.artifact.ident_href, undefined);
  });

  await test('an UNTRUSTED origin serving the same path gets no artifact', async () => {
    for (const u of [`https://evil.com/files/${cwRel}`,
                     `http://localhost:4188/files/${cwRel}`,
                     `https://council.example.com/files/${cwRel}`]) {
      const r = await GET(base, '/project-page?url=' + enc(u));
      assert.equal(r.status, 200);
      assert.equal(r.json.artifact, null, u);
    }
  });

  await test('the tunnel origin is one line in config.json and nothing else', async () => {
    // a file of its own, so the artifact cache from the refusals above cannot
    // answer this question (server.mjs memoizes per url for a few seconds)
    const b = artifact(root, 'spaceship-engineering', 'via-tunnel.html');
    const rel = path.relative(root, b.path).split(path.sep).map(enc).join('/');
    const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    cfg.council_web_origins = ['https://council.example.com'];
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
    const r = await GET(base, '/project-page?url=' + enc(`https://council.example.com/files/${rel}`));
    assert.ok(r.json.artifact, 'the listed origin is now the reader\'s own council');
    assert.equal(r.json.artifact.ident_href, b.url);
    // and a neighbour of it is still nobody
    const n = await GET(base, '/project-page?url=' + enc(`https://other.example.com/files/${rel}`));
    assert.equal(n.json.artifact, null);
    cfg.council_web_origins = [];
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  });

  await test('the council-web view writes into the file: twin\'s record, not a second one', async () => {
    // exactly what the extension does: ask, then use the identity it was given
    const art = (await GET(base, '/project-page?url=' + enc(cwUrl))).json.artifact;
    await POST(base, '/page', { url: art.ident_href, title: 'Artifact', site: art.project_id });
    await POST(base, '/reply', { url: art.ident_href, thread_id: '__page__', text: 'from the web view' });
    const twin = (await GET(base, '/page?url=' + enc(a.url))).json;
    assert.equal(twin.url, a.url);
    assert.equal(twin.page_chat.at(-1).text, 'from the web view', 'one record, reached two ways');
    const stray = (await GET(base, '/page?url=' + enc(cwUrl))).json;
    assert.equal(stray.page, null, 'and nothing was ever filed under the http address');
  });

  await test('the archive and the tail answer a council-web url too', async () => {
    const s = await GET(base, '/project-sessions?url=' + enc(cwUrl));
    assert.equal(s.status, 200);
    assert.equal(s.json.project_id, 'spaceship-engineering');
    const t = await GET(base, '/project-session?url=' + enc(cwUrl) + '&sid=sess-old-1');
    assert.equal(t.status, 200);
    assert.equal(t.json.session.session_id, 'sess-old-1');
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

// ── The mirror stays level with the council ───────────────────────────────
// A project artifact page standing in a council session shows a MIRROR of it,
// and the SAME session is driven from the TUI and the council web UI by a
// different bridge. So the companion has to notice when somebody else has
// written: on read (every drawer asks GET /page constantly) and, while a tab
// is connected, from a watcher on the sessions directory.
console.log('\ncompanion — the mirror stays level with the council');

{
  const root = council('mirror', {
    sessions: [
      { id: 'sess-mirror', project: 'spaceship-engineering', title: 'Radiator sizing',
        updated: '2026-08-12T09:00:00Z',
        transcript: [
          { speaker: 'user', text: 'How big does the radiator have to be?' },
          { speaker: 'claude', text: 'About 400 m² at 350 K.' },
        ] },
      { id: 'sess-other', project: 'spaceship-engineering', title: 'Something else',
        updated: '2026-08-11T09:00:00Z',
        transcript: [{ speaker: 'user', text: 'Unrelated.' }] },
    ],
  });
  const a = artifact(root, 'spaceship-engineering');
  const sessionFile = path.join(root, 'work', 'sessions', 'sess-mirror.json');

  // What the TUI (or the council web UI) does behind this companion's back:
  // append to the transcript and save. Nothing here goes near the companion.
  async function councilTurn(...pairs) {
    await sleep(20);                     // a distinguishable mtime, always
    const payload = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    for (const [speaker, text] of pairs) payload.transcript.push({ speaker, text });
    payload.updated_at = new Date().toISOString();
    fs.writeFileSync(sessionFile, JSON.stringify(payload));
  }

  const workspaceRoot = tmp('mirror-companion');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
      // long enough that a turn is demonstrably still IN FLIGHT while the
      // council writes underneath it
      MOCK_TURN_DELAY_MS: '1200',
    },
  });
  const readPage = async () => (await GET(base, '/page?url=' + enc(a.url))).json;
  const texts = p => (p.page_chat || []).map(m => m.text);

  await POST(base, '/council-root', { root, confirm: true });
  await POST(base, '/page', { url: a.url, title: 'Artifact', site: 'spaceship-engineering' });
  await POST(base, '/project-chat', { url: a.url, sid: 'sess-mirror' });

  await test('opening a chat records where the mirror stands', async () => {
    const page = await readPage();
    assert.equal(page.session_id, 'sess-mirror');
    assert.ok(Number(page.session_sync) > 0, 'the session file\'s mtime is the sync mark');
    assert.equal(page.session_total, 2);
  });

  await test('a turn made in the COUNCIL reaches the mirror on the next read', async () => {
    await councilTurn(['user', 'And at 320 K?'], ['codex', 'Roughly 700 m².']);
    const page = await readPage();
    assert.deepEqual(texts(page), [
      'How big does the radiator have to be?', 'About 400 m² at 350 K.',
      'And at 320 K?', 'Roughly 700 m².',
    ]);
    assert.equal(page.session_total, 4, 'the count the drawer prints moves with it');
    assert.ok(page.page_chat.every(m => m.restored),
      'the same restored semantics /project-chat uses — no edit, no delete, no invented time');
  });

  await test('…and reading again changes nothing and says nothing', async () => {
    const before = await readPage();
    const events = listen(base);
    await sleep(150);
    const after = await readPage();
    await sleep(400);
    assert.equal(after.session_sync, before.session_sync, 'the mark did not move');
    assert.deepEqual(texts(after), texts(before));
    assert.equal(events.of('page').length, 0, 'a refill that is not needed broadcasts nothing');
    events.close();
  });

  await test('an OPEN drawer is told, without being asked', async () => {
    const events = listen(base);
    await waitFor(() => events.of('hello').length > 0, 'the sse hello');
    // the watcher exists only because a client is connected and a page it read
    // is standing in this session
    await readPage();
    await sleep(120);
    await councilTurn(['user', 'What drives the panel count?'], ['claude', 'The assembly schedule.']);
    await waitFor(() => events.of('page').some(e => e.url === a.url), 'the page re-render signal');
    const page = await readPage();
    assert.ok(texts(page).includes('The assembly schedule.'), 'and the new tail is there');
    assert.equal(page.session_total, 6);
    events.close();
  });

  await test('another chat in the same folder is not this page\'s news', async () => {
    const events = listen(base);
    await waitFor(() => events.of('hello').length > 0, 'the sse hello');
    await readPage();
    await sleep(120);
    const other = path.join(root, 'work', 'sessions', 'sess-other.json');
    const payload = JSON.parse(fs.readFileSync(other, 'utf8'));
    payload.transcript.push({ speaker: 'claude', text: 'A conversation nobody is looking at.' });
    fs.writeFileSync(other, JSON.stringify(payload));
    await sleep(700);
    assert.equal(events.of('page').length, 0,
      'the whole directory is watched, so the filter has to be the file');
    events.close();
  });

  await test('a turn IN FLIGHT owns the chat: the refill waits for it', async () => {
    // the council writes FIRST, so a refill is genuinely due…
    await councilTurn(['user', 'And the truss?'], ['claude', 'Sized by the radiator.']);
    // …and then the reader sends from the drawer, which is what defers it
    const r = await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: '@claude and the mass?' });
    assert.equal(r.json.queued, true);
    const mid = await readPage();
    assert.ok(!texts(mid).includes('Sized by the radiator.'),
      'nothing rewrote the conversation a turn is answering into');
    assert.ok(texts(mid).includes('@claude and the mass?'), 'and the reader\'s own words are still there');
    await waitFor(async () => {
      const p = await readPage();
      return (p.page_chat || []).some(m => m.author === 'claude' && /MOCK claude reply/.test(m.text));
    }, 'the bot reply to land');
  });

  await test('…and once it is over, the file is the truth again', async () => {
    const page = await waitFor(async () => {
      const p = await readPage();
      return texts(p).includes('Sized by the radiator.') ? p : null;
    }, 'the deferred refill');
    // the honesty rule: what the file holds is restored, whoever typed it
    assert.ok(page.page_chat.filter(m => /Sized by the radiator/.test(m.text)).every(m => m.restored));
    // …and what the file CANNOT have seen — this companion stamped it after
    // the file's own mtime — is kept rather than deleted
    assert.ok(texts(page).includes('@claude and the mass?'),
      'a message newer than the file survives the refill');
    assert.ok(texts(page).some(t => /MOCK claude reply/.test(t)));
    const kept = page.page_chat.filter(m => !m.restored);
    assert.ok(kept.length >= 2 && kept.every(m => Number(page.session_sync) < Date.parse(m.ts)),
      'and only the ones the session file cannot hold');
  });

  await test('a fresh chat clears the mark with the mirror', async () => {
    await POST(base, '/project-chat', { url: a.url, new: true });
    const page = await readPage();
    assert.deepEqual(page.page_chat, []);
    assert.equal(page.session_sync, 0);
    assert.equal(page.session_total, 0);
  });

  await test('an ordinary page has no mirror and is never refilled', async () => {
    const u = 'https://example.test/an-article';
    await POST(base, '/page', { url: u, title: 'An article', site: 'example.test' });
    await POST(base, '/reply', { url: u, thread_id: '__page__', text: 'a note to myself' });
    const page = (await GET(base, '/page?url=' + enc(u))).json;
    assert.equal(page.session_sync, undefined, 'nothing about sessions was invented for it');
    assert.deepEqual(page.page_chat.map(m => m.text), ['a note to myself']);
  });
}

// ── Plain text on an artifact's page chat goes to the room ────────────────
// Everywhere else in Discuss, no mention means a note and no bots. An
// artifact's Page chat is a COUNCIL chat, and the council's rule is that plain
// text is addressed to everyone — so on those pages, and only there, an
// untagged page-chat message is routed @all by the companion.
console.log('\ncompanion — untagged page chat on an artifact goes to @all');

{
  const root = council('untagged');
  const a = artifact(root, 'spaceship-engineering');
  const unconfirmedRoot = council('untagged-unconfirmed');
  const ua = artifact(unconfirmedRoot, 'spaceship-engineering');
  const workspaceRoot = tmp('untagged-companion');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
    },
  });
  await POST(base, '/council-root', { root, confirm: true });
  await POST(base, '/page', { url: a.url, title: 'Artifact', site: 'spaceship-engineering' });

  await test('an untagged page-chat message reaches the bridge as @all', async () => {
    fs.writeFileSync(logFile, '');
    const r = await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: 'and at 320 K?' });
    assert.equal(r.json.queued, true, 'the room was summoned without a tag');
    await waitFor(() => inputs(logFile).some(t => /and at 320 K\?/.test(t)), 'the turn');
    const turn = inputs(logFile).find(t => /and at 320 K\?/.test(t));
    assert.ok(turn.startsWith('@all '), `the turn is addressed to the room — got ${JSON.stringify(turn.slice(0, 40))}`);
    // and the reader's own words are unchanged: the prefix is the envelope's,
    // never something typed into the message on their behalf
    assert.ok(/asked about this page:\nand at 320 K\?/.test(turn));
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    assert.equal(page.page_chat[0].text, 'and at 320 K?');
  });

  await test('…and both bots answer it', async () => {
    await waitFor(async () => {
      const page = (await GET(base, '/page?url=' + enc(a.url))).json;
      const who = new Set((page.page_chat || []).map(m => m.author));
      return who.has('claude') && who.has('codex');
    }, 'a reply from each');
  });

  await test('a tagged message on the same page is still that bot\'s alone', async () => {
    fs.writeFileSync(logFile, '');
    await POST(base, '/reply', { url: a.url, thread_id: '__page__', text: '@codex only you' });
    await waitFor(() => inputs(logFile).some(t => /only you/.test(t)), 'the turn');
    const turn = inputs(logFile).find(t => /only you/.test(t));
    assert.ok(turn.startsWith('@codex '), `still strict routing — got ${JSON.stringify(turn.slice(0, 40))}`);
  });

  await test('an untagged COMMENT THREAD on the same page still summons nobody', async () => {
    fs.writeFileSync(logFile, '');
    const r = await POST(base, '/thread', {
      url: a.url, quote: 'the truss, not the hull', msg: { text: 'check this later' },
    });
    assert.equal(r.status, 200);
    assert.ok(!r.json.queued, 'a note under a highlight is a note, artifact page or not');
    await sleep(400);
    assert.equal(inputs(logFile).length, 0, 'and no turn was sent');
    // …and a reply into that thread, equally
    await POST(base, '/reply', { url: a.url, thread_id: r.json.thread.id, text: 'still thinking' });
    await sleep(400);
    assert.equal(inputs(logFile).length, 0);
  });

  await test('an untagged page chat on an ORDINARY page still summons nobody', async () => {
    fs.writeFileSync(logFile, '');
    const u = 'https://example.test/some-article';
    await POST(base, '/page', { url: u, title: 'Some article', site: 'example.test' });
    const r = await POST(base, '/reply', { url: u, thread_id: '__page__', text: 'a thought for later' });
    assert.ok(!r.json.queued);
    await sleep(400);
    assert.equal(inputs(logFile).length, 0);
  });

  await test('an untagged message on an UNCONFIRMED root summons nobody either', async () => {
    fs.writeFileSync(logFile, '');
    await POST(base, '/page', { url: ua.url, title: 'Artifact', site: 'spaceship-engineering' });
    const r = await POST(base, '/reply', { url: ua.url, thread_id: '__page__', text: 'is this thing on?' });
    assert.ok(!r.json.queued, 'an untagged sentence must not be what asks for the folder');
    assert.equal(r.json.reason, undefined, 'and it is not refused — it is simply a note');
    await sleep(400);
    assert.equal(inputs(logFile).length, 0);
  });
}


// --- from a page to a project artifact (2026-09-02) -----------------------
// Three steps, and the rule they all keep: the bots may offer, and only the
// reader's click creates a project, files a page or spends a turn. SPEC.md
// "From a page to a project artifact".
console.log('\nfrom a page to a project — the bot may offer a NEW one');

const ROSTER = [{ root: '/council', id: 'acta', title: 'Acta paper' }];

await test('a bot may propose a project that does not exist yet', async () => {
  const hit = ws.parseSuggestion(
    'This is a fortnight of planning, not a filing.\n'
    + 'file-in: new "Sheffield Doc Fest 2026" — a fortnight of screenings to plan',
    ROSTER);
  assert.ok(hit && hit.new, 'the new shape is read');
  assert.equal(hit.title, 'Sheffield Doc Fest 2026');
  assert.equal(hit.why, 'a fortnight of screenings to plan');
  assert.equal(hit.id, undefined, 'and it names no project id, because there is none');
});

await test('the quotes are the guard — without them nothing is proposed', async () => {
  assert.equal(ws.parseSuggestion('file-in: new project for this page', ROSTER), null,
    'a bot musing about projects must not create folders');
  assert.equal(ws.parseSuggestion('file-in: new "ab" — too short', ROSTER), null);
  assert.equal(ws.parseSuggestion(`file-in: new "${'x'.repeat(61)}" — too long`, ROSTER), null);
  assert.equal(ws.parseSuggestion('I think file-in: new "A Real Title" would suit', ROSTER), null,
    'only a line of its own counts, exactly as for the id shape');
});

await test('markdown does not hide it, and the LAST line still wins', async () => {
  const hit = ws.parseSuggestion(
    '**file-in: acta — the same manuscript**\nfile-in: new "Film Club" — no, its own thing',
    ROSTER);
  assert.ok(hit.new);
  assert.equal(hit.title, 'Film Club');
  const back = ws.parseSuggestion(
    'file-in: new "Film Club" — its own thing\nfile-in: acta — no, this one',
    ROSTER);
  assert.equal(back.new, undefined);
  assert.equal(back.id, 'acta', 'the last line wins in both directions');
});

await test('the roster block teaches both lines, and forbids guessing at either', async () => {
  const block = ws.suggestBlock(ROSTER);
  assert.match(block, /file-in: <project-id>/);
  assert.match(block, /file-in: new "<Short Title>"/);
  assert.match(block, /never guess/);
  assert.match(block, /nothing at all if in doubt/);
});

{
  const root = council('newproj');
  ws.setRootState(root, true);

  await test('starting a project makes the folder, the PROJECT.md and the row', async () => {
    const made = ws.createProject(root, { title: 'Sheffield Doc Fest 2026', why: 'a fortnight to plan' });
    assert.equal(made.ok, true);
    assert.equal(made.id, 'sheffield-doc-fest-2026');
    const md = fs.readFileSync(path.join(root, 'projects', made.id, 'PROJECT.md'), 'utf8');
    assert.match(md, /^# Sheffield Doc Fest 2026/);
    assert.match(md, /\*\*Status:\*\* active/);
    assert.match(md, /\*\*Cadence:\*\* weekly/);
    assert.match(md, /## Why This Matters\n\na fortnight to plan/);
    assert.match(md, /## Desired Outcome\n\nTODO/);
    assert.match(md, /## Next Action\n\nTODO/);
    const pf = JSON.parse(fs.readFileSync(path.join(root, 'projects', 'portfolio.json'), 'utf8'));
    const row = pf.projects.find(p => p.id === made.id);
    assert.deepEqual(row, {
      id: made.id, title: 'Sheffield Doc Fest 2026', status: 'active', priority: null,
      root: `projects/${made.id}`, cadence: 'weekly', why: 'a fortnight to plan',
      desired_outcome: 'TODO', next_action: 'TODO',
    });
    assert.ok(pf.projects.some(p => p.id === 'spaceship-engineering'),
      'and the rows that were there are still there');
    assert.ok(ws.listProjects(root).some(p => p.id === made.id),
      'the picker sees it immediately — the portfolio is the roster');
  });

  await test('the same title twice is a 409, not a second folder', async () => {
    const again = ws.createProject(root, { title: 'Sheffield Doc Fest 2026' });
    assert.equal(again.ok, false);
    assert.equal(again.status, 409);
    assert.match(again.error, /already a project/);
  });

  await test('a title that is not a title is refused before anything is written', async () => {
    for (const title of ['', 'ab', 'x'.repeat(61)]) {
      const r = ws.createProject(root, { title });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    }
  });

  await test('an UNCONFIRMED council is not somewhere a project gets started', async () => {
    const other = council('newproj-unconfirmed');
    const r = ws.createProject(other, { title: 'Anything At All' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(fs.existsSync(path.join(other, 'projects', 'anything-at-all')), false,
      'nothing is written in a folder nobody vouched for');
  });
}

console.log('\nfrom a page to a project — make artifact');

const artPage = (extra = {}) => ({
  url: 'https://example.com/brochure', title: 'Doc Fest brochure',
  threads: [], page_chat: [], ...extra,
});

await test('the turn names the file to write, the metas, and the line to end with', async () => {
  const t = ws.artifactTurn({
    id: 'doc-fest', projectTitle: 'Doc Fest', title: 'Doc Fest brochure',
    url: 'https://example.com/brochure', page: artPage(),
  });
  assert.ok(t.startsWith('@claude '), 'one writer, and claude by default');
  assert.match(t, /projects\/doc-fest\/<slug>\.html/);
  assert.match(t, /UPDATE it in place/);
  assert.match(t, /No external scripts and no external stylesheets/);
  assert.match(t, /light and dark|BOTH light and dark/);
  assert.match(t, /<meta name="bfp-source" content="https:\/\/example\.com\/brochure">/);
  assert.match(t, /<meta name="bfp-source-title" content="Doc Fest brochure">/);
  assert.match(t, /artifact: projects\/doc-fest\/<slug>\.html/);
});

await test('the reader\'s own words ride it verbatim, and the snapshot is named', async () => {
  const t = ws.artifactTurn({
    id: 'doc-fest', title: 'Brochure', url: 'https://x/y',
    snapshotPath: '/tmp/snap/abc.html',
    brief: 'a planner of what to watch and when, with costs',
    page: artPage(),
  });
  assert.match(t, /What I want: a planner of what to watch and when, with costs/);
  assert.match(t, /\/tmp\/snap\/abc\.html/);
  const bare = ws.artifactTurn({ id: 'd', title: 'B', url: 'https://x/y', page: artPage() });
  assert.equal(/What I want/.test(bare), false, 'no brief, no line about one');
  assert.equal(/on this machine, at/.test(bare), false, 'and no snapshot, no promise of one');
});

await test('@codex in the brief is the only thing that moves the turn', async () => {
  const t = ws.artifactTurn({ route: '@codex', id: 'd', title: 'B', url: 'u', page: artPage() });
  assert.ok(t.startsWith('@codex '));
});

await test('every thread rides it — quote, page, author lines, and whether it is filed', async () => {
  const t = ws.artifactTurn({
    id: 'd', title: 'B', url: 'u',
    page: artPage({
      threads: [
        { id: 'a', quote: 'Chungking Express, Fri 7pm', page: 3,
          msgs: [{ author: 'angadh', text: 'this one for certain' }] },
        { id: 'b', quote: 'Members £8', resolved: true,
          msgs: [{ author: 'angadh', text: 'am I a member?' },
                 { author: 'claude', text: 'you renewed in March' }] },
      ],
      page_chat: [{ author: 'angadh', text: 'which of these clash?' }],
    }),
  });
  assert.match(t, /“Chungking Express, Fri 7pm” \(page 3\)/);
  assert.match(t, /angadh: this one for certain/);
  assert.match(t, /“Members £8” \[filed\]/);
  assert.match(t, /claude: you renewed in March/);
  assert.match(t, /which of these clash\?/, 'and the tail of the page chat');
});

await test('the digest is capped, and says how many it left out', async () => {
  const long = 'x'.repeat(3000);
  const threads = Array.from({ length: 60 }, (_, i) => ({
    id: `t${i}`, quote: `quote ${i}`, msgs: [{ author: 'angadh', text: long }],
  }));
  const digest = ws.threadDigest({ threads });
  assert.ok(digest.length < ws.ARTIFACT_DIGEST_CHARS + 2000, 'the budget holds');
  assert.match(digest, /further comment threads? did not fit/);
  assert.match(digest, /^\[my comments on that page — \d+ of 60\]/,
    'and it says out loud how many of them it read');
});

console.log('\nfrom a page to a project — reading the artifact line back');

{
  const root = council('artline');
  fs.mkdirSync(path.join(root, 'projects', 'spaceship-engineering'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'spaceship-engineering', 'plan.html'), '<h1>plan</h1>');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not in a project');
  const filed = [{ root, id: 'spaceship-engineering' }];

  await test('a path inside the project that exists becomes the receipt', async () => {
    const hit = ws.parseArtifact(
      'Made you a planner.\nartifact: projects/spaceship-engineering/plan.html', filed);
    assert.ok(hit);
    assert.equal(hit.rel, 'projects/spaceship-engineering/plan.html');
    assert.equal(hit.root, root);
    assert.equal(hit.id, 'spaceship-engineering');
  });

  await test('markdown around it does not hide it, and the last line wins', async () => {
    const hit = ws.parseArtifact(
      '`artifact: projects/spaceship-engineering/gone.html`\n'
      + '**artifact: projects/spaceship-engineering/plan.html**', filed);
    assert.equal(hit.rel, 'projects/spaceship-engineering/plan.html');
  });

  await test('everything else is ignored, and the reply is posted as it stands', async () => {
    const abs = path.join(root, 'projects', 'spaceship-engineering', 'plan.html');
    for (const [why, text] of [
      ['an absolute path', `artifact: ${abs}`],
      ['a path outside the project', 'artifact: notes.txt'],
      ['a path out of the project', 'artifact: projects/spaceship-engineering/../../notes.txt'],
      ['another project', 'artifact: projects/somebody-else/plan.html'],
      ['a file that is not there', 'artifact: projects/spaceship-engineering/never.html'],
      ['prose', 'I wrote the artifact: projects/spaceship-engineering/plan.html for you'],
      ['the project folder itself', 'artifact: projects/spaceship-engineering/'],
    ]) {
      assert.equal(ws.parseArtifact(text, filed), null, why);
    }
  });

  await test('a page filed nowhere can have no artifact at all', async () => {
    assert.equal(ws.parseArtifact('artifact: projects/spaceship-engineering/plan.html', []), null);
  });
}

// --- send review: the fan-out --------------------------------------------
// One click hands the reader's WHOLE margin review to the bots as a ROUND: a
// preamble turn into page chat and then one turn PER OPEN THREAD, each queued
// against that thread so the answer lands where the comment is. SPEC.md
// "send review: the fan-out"; workspace.reviewFanout composes it, POST
// /send-review queues it.
console.log('\nsend review — the fan-out');

const revPage = (threads) => ({ url: 'file:///x/index.html', threads });
let revN = 0;
const revThread = (quote, msgs, extra = {}) => ({ id: 'x' + (++revN), quote, msgs, ...extra });

await test('a round is one turn per OPEN thread, each carrying its own comment', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('the truss, not the hull', [
      { author: 'angadh', text: 'this mass number looks wrong' },
      { author: 'claude', text: 'it is the dry mass' },
      { author: 'angadh', text: 'then say so in the caption' },
    ]),
  ]));
  assert.equal(f.sent, 1);
  assert.equal(f.total, 1);
  assert.equal(f.omitted, 0);
  assert.equal(f.turns.length, 1, 'one job per thread — that is the whole feature');
  const t = f.turns[0];
  assert.equal(t.thread_id, f.turns[0].thread_id);
  assert.equal(t.quote, 'the truss, not the hull', 'the passage rides the turn');
  // every message, attributed — the bot's own answers included, because a
  // thread where the reader pushed back is the thread that needs the push-back
  assert.deepEqual(t.history.map(m => m.author), ['angadh', 'claude', 'angadh']);
  assert.ok(/review round . comment 1 of 1/.test(t.text), 'and it says where it sits in the round');
  assert.ok(/MAKE the change/.test(t.text), 'a point that calls for an edit gets an edit');
  assert.ok(/files are yours to edit/.test(t.text), 'one line of round context, not a whole digest');
});

await test('the preamble opens the round and carries no comment text at all', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('the truss', [{ author: 'angadh', text: 'this mass number looks wrong' }]),
    revThread('the radiator', [{ author: 'angadh', text: 'cite a source' }]),
  ]));
  assert.ok(/^Review round:/.test(f.preamble));
  assert.ok(/2 comments follow this message/.test(f.preamble), 'the council chat records that a round happened');
  assert.ok(/one turn each/.test(f.preamble));
  assert.ok(!/this mass number looks wrong/.test(f.preamble), 'the comments are their own turns now');
  assert.ok(/Nothing is resolved by any of this/.test(f.preamble), "filing stays the reader's click");
});

await test('a RESOLVED thread gets no turn — that argument is over', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('open one', [{ author: 'angadh', text: 'still bothers me' }]),
    revThread('filed one', [{ author: 'angadh', text: 'settled' }], { resolved: true }),
  ]));
  assert.equal(f.total, 1);
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].quote, 'open one');
});

// A thread a bot has already replied into is sitting under "Ready for review"
// waiting on the READER. Sending it back would ask for work that has already
// been reported — and a second send after a round is precisely the case this
// state exists for.
await test('a thread already ready for review gets no turn either', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('open one', [{ author: 'angadh', text: 'still bothers me' }]),
    revThread('answered one', [
      { author: 'angadh', text: 'the units are wrong' },
      { author: 'claude', text: 'done — fixed in the caption' },
    ], { addressed: true, addressed_by: 'claude' }),
  ]));
  assert.equal(f.total, 1, 'the count the button shows is the count that is sent');
  assert.equal(f.turns.length, 1);
});

await test('a page with nothing open composes NO round at all', async () => {
  assert.equal(ws.reviewFanout(revPage([])), null);
  assert.equal(ws.reviewFanout(revPage([revThread('q', [{ author: 'a', text: 'b' }], { resolved: true })])), null);
  assert.equal(ws.reviewFanout(revPage([revThread('q', [])])), null, 'an empty thread is not a comment');
  assert.equal(ws.reviewFanout(revPage([revThread('q', [{ author: 'a', text: 'b' }], { addressed: true })])), null,
    'a page whose every thread is ready for review has nothing left to send');
});

// A change that REWRITES a quoted passage orphans its highlight: the thread
// holds the old wording, the page no longer contains it, and nothing says what
// replaced it. The one instruction that fixes it costs the bots a line — and it
// now rides EVERY turn of the round, beside the passage it is about.
await test('every turn asks for the new wording when a change rewrites its passage', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('the truss, not the hull', [{ author: 'angadh', text: 'this reads badly' }]),
    revThread('the radiator area', [{ author: 'angadh', text: 'and so does this' }]),
  ]));
  for (const t of f.turns) {
    assert.ok(/rewrites the passage quoted above/.test(t.text), 'the case is named');
    assert.ok(/quote the new wording back verbatim/.test(t.text), 'and what to do about it');
    assert.ok(/now reads/.test(t.text), 'in the phrasing the drawer draws a diff from');
  }
  assert.ok(/now reads/.test(f.preamble), 'the round says it once up front too');
});

await test('an orphaned thread says so in its own turn', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('a passage that is gone', [{ author: 'angadh', text: 'fix this' }], { orphaned: true }),
  ]));
  assert.ok(/edited out of the page/.test(f.turns[0].text));
});

await test('paged documents go in page order; unpaged keep record order', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('late', [{ author: 'a', text: 'on page nine' }], { page: 9 }),
    revThread('early', [{ author: 'a', text: 'on page two' }], { page: 2 }),
    revThread('middle', [{ author: 'a', text: 'on page four' }], { page: 4 }),
  ]));
  assert.deepEqual(f.turns.map(t => t.quote), ['early', 'middle', 'late']);
  assert.deepEqual(f.turns.map(t => t.page), [2, 4, 9], 'and each turn knows which page it is on');
  assert.ok(/comment 1 of 3/.test(f.turns[0].text));
  // an unpaged HTML artifact: the companion has no DOM and does not pretend to
  // know where a highlight falls, so record order stands
  const flat = ws.reviewFanout(revPage([
    revThread('third', [{ author: 'a', text: 'c' }]),
    revThread('first', [{ author: 'a', text: 'a' }]),
  ]));
  assert.deepEqual(flat.turns.map(t => t.quote), ['third', 'first']);
  assert.deepEqual(flat.turns.map(t => t.page), [0, 0], 'and no page is claimed');
});

await test('a very long quote and a very long comment are both clipped, per turn', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('Q'.repeat(4000), [{ author: 'angadh', text: 'M'.repeat(4000) }]),
  ]));
  const t = f.turns[0];
  assert.ok(t.quote.length <= ws.REVIEW_QUOTE_MAX, `quote clipped — got ${t.quote.length}`);
  assert.ok(t.quote.endsWith('…'), 'and says it was clipped');
  assert.ok(t.history[0].text.length <= ws.REVIEW_MSG_MAX);
  assert.ok(t.history[0].text.endsWith('…'));
});

await test('a very long thread keeps its LATEST messages and says how many it dropped', async () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ author: 'angadh', text: `point ${i}` }));
  const f = ws.reviewFanout(revPage([revThread('q', msgs)]));
  const t = f.turns[0];
  assert.equal(t.history.length, ws.REVIEW_MSGS_PER_THREAD);
  assert.equal(t.history[t.history.length - 1].text, 'point 29', 'the latest is kept');
  assert.ok(!t.history.some(m => m.text === 'point 11'), 'the oldest is not');
  assert.ok(/\(18 earlier messages in this thread are not shown\.\)/.test(t.text),
    'and the turn says so — never a silent truncation');
});

await test('a bot narrating with a tools line is not part of the conversation', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('q', [
      { author: 'angadh', text: 'check the units' },
      { author: 'claude', kind: 'tools', text: 'Explored\n└ Read index.html' },
    ]),
  ]));
  assert.deepEqual(f.turns[0].history.map(m => m.text), ['check the units']);
});

await test('over the thread cap, the extra are NAMED and sent next time', async () => {
  const threads = Array.from({ length: 26 }, (_, i) => revThread(`quote ${i}`, [{ author: 'a', text: `note ${i}` }]));
  const f = ws.reviewFanout(revPage(threads));
  assert.equal(f.total, 26);
  assert.equal(f.sent, ws.REVIEW_THREADS_MAX);
  assert.equal(f.turns.length, ws.REVIEW_THREADS_MAX);
  assert.equal(f.omitted, 6);
  assert.ok(/…and 6 more open comment threads did not fit in this round/.test(f.preamble));
  assert.ok(/send review again after these/.test(f.preamble), 'and the reader is told the remedy');
  assert.ok(/20 comments follow/.test(f.preamble), 'the count is what actually went');
});

// The old 8000-character cap was the size of ONE turn's digest. There is no
// such turn any more, so twenty fat threads are twenty ordinary turns rather
// than four threads and a "did not fit" line.
await test('no whole-review character cap binds any more — every thread gets its turn', async () => {
  const N = 18;
  const threads = Array.from({ length: N }, (_, i) =>
    revThread(`quote ${i}`, [{ author: 'a', text: ('x'.repeat(1200) + ` tail${i}`) }]));
  const f = ws.reviewFanout(revPage(threads));
  assert.equal(f.sent, N);
  assert.equal(f.omitted, 0);
  assert.ok(f.turns.every(t => t.text.length < 1200), 'and each turn is small on its own');
  assert.equal(ws.REVIEW_CHARS_MAX, undefined, 'the whole-review cap is retired, not merely unused');
});

await test('one enormous thread still goes: a cap that sends nothing is a dead button', async () => {
  const f = ws.reviewFanout(revPage([revThread('q', [{ author: 'a', text: 'y'.repeat(50000) }])]));
  assert.equal(f.sent, 1);
  assert.equal(f.omitted, 0);
});

// --- the two registers ---------------------------------------------------
// A round is sent on two kinds of page. On a confirmed project artifact the
// draft's files are the bots' to edit and the round asks for edits. Everywhere
// else — an article, a web PDF, a PDF on this machine — the bots have deny-all
// file writes, so a round that asked for a change would be asking for something
// nothing can do. `editable` picks the register, and it is a flag on the pure
// function so both wordings are testable without a server.
console.log('\nsend review — the read-only register');

// The artifact wording is load-bearing (it is what makes "make the change" a
// thing the bots do rather than a thing they discuss) and it is the wording
// that shipped. Nothing about this feature was allowed to move a byte of it.
await test('the artifact register is unchanged, byte for byte', async () => {
  const threads = [
    revThread('the truss', [{ author: 'angadh', text: 'this mass looks wrong' }]),
    revThread('the radiator', [{ author: 'angadh', text: 'cite a source' }]),
  ];
  const before = ws.reviewFanout(revPage(threads));
  const explicit = ws.reviewFanout(revPage(threads), { editable: true });
  assert.equal(before.preamble, explicit.preamble, 'editable is the default, and it is the old text');
  assert.equal(before.turns[0].text, explicit.turns[0].text);
  assert.equal(before.preamble, ws.reviewPreamble(2, 0), 'and the preamble helper agrees');
  assert.ok(/make the change it calls for/.test(before.preamble));
  assert.ok(/files are yours to edit/.test(before.turns[0].text));
  assert.equal(before.wrapUp, null, 'a draft round ends with the last edit, not with a summary');
});

await test('off a draft, no turn of the round asks for a change', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('the tunnel', [{ author: 'angadh', text: 'is this the same tunnel as chapter 2?' }]),
    revThread('a note', [{ author: 'angadh', text: 'check this against the 2019 paper' }]),
  ]), { editable: false });
  const every = [f.preamble, ...f.turns.map(t => t.text), f.wrapUp];
  for (const text of every) {
    assert.ok(!/make the change/i.test(text), 'nothing here can be changed');
    assert.ok(!/yours to edit/i.test(text));
    assert.ok(!/write rules/i.test(text), 'and the write rules on this page are deny-all');
  }
});

await test('…it asks for an answer, in that comment’s own thread', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('the tunnel', [{ author: 'angadh', text: 'is this the same tunnel as chapter 2?' }]),
  ]), { editable: false });
  assert.ok(/^Review round:/.test(f.preamble));
  assert.ok(/1 comment follows this message/.test(f.preamble));
  assert.ok(/comment's own\s+thread/.test(f.preamble.replace(/\n/g, ' ')) || /own thread/.test(f.preamble));
  assert.ok(/note I was making to myself/.test(f.preamble),
    'a margin note is not always a question, and the bots are told what to do with one');
  assert.ok(/Keep each reply\s+short/.test(f.preamble.replace(/\n/g, ' ')) || /short/.test(f.preamble));
  const t = f.turns[0].text;
  assert.ok(/review round . comment 1 of 1/.test(t), 'it is still a numbered turn in a round');
  assert.ok(/Answer this point on its own terms/.test(t));
  assert.ok(/note I was making to myself/.test(t));
  assert.ok(/nothing here to change/.test(t));
});

await test('…and it ends with ONE wrap-up turn that adds the answers up', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('one', [{ author: 'a', text: 'first' }]),
    revThread('two', [{ author: 'a', text: 'second' }]),
    revThread('three', [{ author: 'a', text: 'third' }]),
  ]), { editable: false });
  assert.ok(f.wrapUp, 'the answers are the product here, and they are scattered down three threads');
  assert.ok(/^Round wrap-up: the 3 comments above have each been answered/.test(f.wrapUp));
  assert.ok(/Do not repeat the per-thread answers/.test(f.wrapUp), 'it is a view across them, not a rerun');
  assert.ok(!/--- comment/.test(f.wrapUp) && !/first/.test(f.wrapUp),
    'and it carries no comment text: the bots have just answered every one of them');
  assert.ok(/^Round wrap-up: the comment above has been answered in its own thread/
    .test(ws.reviewWrapUp(1)), 'one comment reads as one comment');
});

await test('the preamble promises the wrap-up, so it is not a bot going off on its own', async () => {
  const f = ws.reviewFanout(revPage([revThread('one', [{ author: 'a', text: 'x' }])]), { editable: false });
  assert.ok(/wrap-up here in page chat/.test(f.preamble));
});

console.log('\nsend review — who each turn is addressed to');

await test('a turn is the room’s by default', async () => {
  assert.equal(ws.reviewRoute({ msgs: [{ author: 'angadh', text: 'this needs a source' }] }), '@all');
});

await test('…unless the reader’s LAST message in that thread tags one bot', async () => {
  assert.equal(ws.reviewRoute({ msgs: [
    { author: 'angadh', text: '@claude is this a quote or a paraphrase?' },
    { author: 'claude', text: 'a paraphrase' },
    { author: 'angadh', text: '@codex check the source document' },
  ] }), '@codex', 'the reader already chose; the round does not overrule them');
});

await test('an EARLIER tag does not win — the last word is the address', async () => {
  assert.equal(ws.reviewRoute({ msgs: [
    { author: 'angadh', text: '@claude have a look at this' },
    { author: 'claude', text: 'looked' },
    { author: 'angadh', text: 'still not right' },
  ] }), '@all');
});

await test('a BOT’s tag is not the reader’s address, and a tools line addresses nobody', async () => {
  assert.equal(ws.reviewRoute({ msgs: [
    { author: 'angadh', text: 'whose call is this?' },
    { author: 'claude', text: '@codex over to you' },
  ] }), '@all');
  assert.equal(ws.reviewRoute({ msgs: [
    { author: 'angadh', text: '@codex check the source' },
    { author: 'claude', kind: 'tools', text: 'Explored\n└ Read @claude notes.md' },
  ] }), '@codex');
});

await test('both bots tagged, or @all, is the room', async () => {
  assert.equal(ws.reviewRoute({ msgs: [{ author: 'a', text: '@claude @codex both of you' }] }), '@all');
  assert.equal(ws.reviewRoute({ msgs: [{ author: 'a', text: '@all thoughts?' }] }), '@all');
});

await test('the route rides the turn text, so the bridge routes it like any other', async () => {
  const f = ws.reviewFanout(revPage([
    revThread('one', [{ author: 'a', text: 'plain' }]),
    revThread('two', [{ author: 'a', text: '@codex your call' }]),
  ]));
  assert.ok(f.turns[0].text.startsWith('@all '));
  assert.equal(f.turns[0].route, '@all');
  assert.ok(f.turns[1].text.startsWith('@codex '));
  assert.equal(f.turns[1].route, '@codex');
});

console.log('\ncompanion — POST /send-review');

{
  const root = council('review');
  const a = artifact(root, 'spaceship-engineering');
  const unconfirmedRoot = council('review-unconfirmed');
  const ua = artifact(unconfirmedRoot, 'spaceship-engineering');
  const workspaceRoot = tmp('review-companion');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
    },
  });
  await POST(base, '/council-root', { root, confirm: true });
  await POST(base, '/page', { url: a.url, title: 'Artifact', site: 'spaceship-engineering' });

  await test('with no open comments the answer is a friendly 400, not an empty round', async () => {
    fs.writeFileSync(logFile, '');
    const r = await POST(base, '/send-review', { url: a.url });
    assert.equal(r.status, 400);
    assert.ok(/no open comments/.test(r.json.error));
    await sleep(300);
    assert.equal(inputs(logFile).length, 0);
  });

  // A page the companion has never seen has no comments to send, and saying
  // "no open comments" about a page it holds no record of would be a small
  // lie. (A page it DOES know is a round now, artifact or not — see the
  // ordinary-page block below.)
  await test('a page the companion has no record of is a 404', async () => {
    const r = await POST(base, '/send-review', { url: 'https://example.test/never-seen' });
    assert.equal(r.status, 404);
  });

  await test('an UNCONFIRMED council root is a 409', async () => {
    await POST(base, '/page', { url: ua.url, title: 'Artifact', site: 'spaceship-engineering' });
    await POST(base, '/thread', { url: ua.url, quote: 'the truss', msg: { text: 'check this' } });
    const r = await POST(base, '/send-review', { url: ua.url });
    assert.equal(r.status, 409);
  });

  let turns = [];
  let ids = [];
  await test('the round reaches the bridge as a preamble and then ONE TURN PER THREAD', async () => {
    fs.writeFileSync(logFile, '');
    const t1 = (await POST(base, '/thread', { url: a.url, quote: 'the truss, not the hull',
      msg: { text: 'this mass looks wrong' } })).json.thread;
    // a thread the reader tagged at one bot: the round keeps that choice
    const t2 = (await POST(base, '/thread', { url: a.url, quote: 'the radiator area',
      msg: { text: '@codex cite a source for this' } })).json.thread;
    // …and codex answers it, which marks that thread READY FOR REVIEW and takes
    // it out of the round. The reader writing once more makes it their open
    // question again — which is what puts it back in.
    await waitFor(async () => {
      const page = (await GET(base, '/page?url=' + enc(a.url))).json;
      const t = (page.threads || []).find(x => x.id === t2.id);
      return t && t.addressed;
    }, 'codex answering the tagged thread');
    // the reader says "not done" — the one clearing that summons nobody, so the
    // thread is open again with the reader's own "@codex" still its last word
    await POST(base, '/addressed', { url: a.url, thread_id: t2.id, addressed: false });
    await waitFor(async () => {
      const page = (await GET(base, '/page?url=' + enc(a.url))).json;
      return !(page.threads || []).some(t => t.addressed);
    }, 'both threads open again');
    ids = [t1.id, t2.id];
    fs.writeFileSync(logFile, '');
    const r = await POST(base, '/send-review', { url: a.url });
    assert.equal(r.status, 200);
    assert.equal(r.json.sent, 2);
    assert.equal(r.json.total, 2);
    assert.equal(r.json.omitted, 0);
    assert.equal(r.json.queued, 3, 'the preamble and one turn per thread');
    assert.deepEqual(r.json.threads, ids, 'named, in page order, so the drawer can spin them');
    await waitFor(() => inputs(logFile).filter(t => /review round/i.test(t)).length === 3,
      'the preamble and both per-thread turns');
    turns = inputs(logFile).filter(t => /review round/i.test(t));
  });

  await test('the preamble goes first, into page chat, routed @all', async () => {
    assert.ok(/^@all /.test(turns[0]), `the room, not one bot — got ${JSON.stringify(turns[0].slice(0, 40))}`);
    assert.ok(/Review round:/.test(turns[0]));
    assert.ok(/asked about this page/.test(turns[0]), 'the page-chat envelope, like any typed message');
    assert.ok(!/highlighted this passage/.test(turns[0]), 'and it is not a thread turn');
  });

  await test('…then one turn per thread, in page order, each in ITS thread’s envelope', async () => {
    assert.equal(turns.length, 3);
    assert.ok(/the truss, not the hull/.test(turns[1]));
    assert.ok(/the radiator area/.test(turns[2]));
    for (const t of turns.slice(1)) {
      assert.ok(/highlighted this passage/.test(t), 'the thread envelope, quote first');
      assert.ok(/posted directly into the comment thread/.test(t),
        'which is the sentence that is finally true of a review turn');
      assert.ok(/comment \d+ of 2/.test(t), 'and each says where it sits in the round');
    }
  });

  await test('…routed @all unless that thread’s last message chose one bot', async () => {
    assert.ok(/^@all /.test(turns[1]), 'an untagged thread is the room’s');
    assert.ok(/^@codex /.test(turns[2]), 'a thread the reader addressed to codex stays codex’s');
  });

  await test('…and every turn of the round carries the Phase 2 write rules', async () => {
    for (const t of turns) {
      assert.ok(/You may create and edit files under .*projects[/]spaceship-engineering/.test(t),
        'a point that calls for a change has to be allowed to make it');
    }
  });

  // A round is a dozen turns about one draft, so it is the place where a bot
  // is most likely to answer comment 7 with wording that contradicts what
  // comment 2 settled. Every turn of the round names the review's decision log
  // (chat.decisionLogBlock) for exactly that reason — the preamble included,
  // since page chat is where the round's terms are set.
  await test('…and every turn of the round names the review’s decision log', async () => {
    const { pageKey } = await import(path.join(PLUGIN, 'store.mjs'));
    const decisions = path.join(workspaceRoot, '.botference', 'plugin', 'snapshots',
      `${pageKey(a.url)}-decisions.md`);
    assert.ok(fs.existsSync(decisions), 'two open comments is a review with decisions in it');
    const written = fs.readFileSync(decisions, 'utf8');
    assert.ok(/the truss, not the hull/.test(written) && /the radiator area/.test(written),
      'and the log holds both of them');
    for (const t of turns) {
      assert.ok(/THE REVIEW'S DECISION LOG/.test(t), 'a round has to be internally consistent');
      assert.ok(t.includes(decisions), 'named by absolute path, like the snapshot');
    }
  });

  await test('the preamble is a REAL, visible user message in page chat', async () => {
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    const mine = (page.page_chat || []).filter(m => !/^(claude|codex)/i.test(m.author));
    assert.equal(mine.length, 1);
    assert.ok(/Review round:/.test(mine[0].text), 'the reader can see the round they started');
    assert.ok(!/this mass looks wrong/.test(mine[0].text), 'the comments are not retyped into it');
  });

  await test('the ANSWERS land in the threads — which is the whole point', async () => {
    await waitFor(async () => {
      const page = (await GET(base, '/page?url=' + enc(a.url))).json;
      return ids.every(id => {
        const t = (page.threads || []).find(x => x.id === id);
        return t && (t.msgs || []).some(m => /^(claude|codex)/i.test(m.author) && /MOCK/.test(m.text));
      });
    }, 'a bot reply in each thread');
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    const t2 = (page.threads || []).find(x => x.id === ids[1]);
    const last = (t2.msgs || []).filter(m => m.kind !== 'tools').pop();
    assert.ok(/^codex/i.test(last.author), 'answered by the bot that thread was addressed to');
  });

  await test('…so every thread flips to ready for review, through the SAME choke point', async () => {
    await waitFor(async () => {
      const page = (await GET(base, '/page?url=' + enc(a.url))).json;
      return ids.every(id => ((page.threads || []).find(x => x.id === id) || {}).addressed);
    }, 'addressed on both threads');
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    for (const id of ids) {
      const t = (page.threads || []).find(x => x.id === id);
      assert.ok(t.addressed_by, 'and the badge knows which bot claimed it');
    }
  });

  // ---- the round ticker ------------------------------------------------
  // Per-comment re-renders hide the round. The strip that fixes that renders a
  // state the COMPANION owns — it built the queue and sees every turn boundary
  // — so the round survives a refresh, a reopened drawer and a second tab.
  // These are the transitions that state has to make.
  await test('the round is a thing with a length, and GET /round says so', async () => {
    const r = (await GET(base, '/round?url=' + enc(a.url))).json.round;
    assert.ok(r, 'a round that has run is still there to be asked about');
    assert.equal(r.type, 'round');
    assert.equal(r.total, 2, 'one entry per comment the round was sent to');
    assert.equal(r.url, a.url);
    assert.ok(r.started_at, 'stamped, so a stale round can be told from a live one');
  });

  await test('…and it ENDS: every turn answered, running false, the count complete', async () => {
    await waitFor(async () => {
      const r = (await GET(base, '/round?url=' + enc(a.url))).json.round;
      return r && !r.running;
    }, 'the round finishing');
    const r = (await GET(base, '/round?url=' + enc(a.url))).json.round;
    assert.equal(r.answered, 2, 'both comments answered');
    assert.equal(r.current, null, 'nothing left in flight');
    assert.ok(r.done_at, 'and an end stamp for the "round done" note');
  });

  await test('a page nobody sent a round on has no round', async () => {
    const other = 'https://example.test/ordinary';
    const r = (await GET(base, '/round?url=' + enc(other))).json.round;
    assert.equal(r, null, 'null, not an empty round — the strip stays down');
  });

  await test('the round is owner-only, like the queue of agent time it describes', async () => {
    const h = await startServer({
      root: tmp('round-hosted'),
      args: ['--hosted', '--no-agents'],
      env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw' },
    });
    const guest = { host: 'annotations.example', authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
    const g = await GET(h.base, '/round?url=' + enc(a.url), guest);
    assert.equal(g.status, 403);
    h.proc.kill();
  });

  await test('the threads are left OPEN — resolution stays the reader\'s click', async () => {
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    assert.equal(page.threads.length, 2);
    assert.ok(page.threads.every(t => !t.resolved), 'nothing was filed on the reader\'s behalf');
  });

  await test('a second round after the first sends nothing: every thread is ready', async () => {
    const r = await POST(base, '/send-review', { url: a.url });
    assert.equal(r.status, 400, 'the work has been reported; asking again would ask for it twice');
  });

  await test('a guest is refused outright — this is an owner-only endpoint', async () => {
    const h = await startServer({
      root: tmp('review-hosted'),
      args: ['--hosted', '--no-agents'],
      env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw' },
    });
    const guest = { host: 'annotations.example', authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
    const r = await POST(h.base, '/send-review', { url: a.url }, guest);
    assert.equal(r.status, 403);
    h.proc.kill();
  });
}

// --- a round on a page with no draft behind it ---------------------------
// The button was gated on "confirmed project artifact" for a year, which meant
// the reader could mark up an article or a PDF all afternoon and then had to
// retype the lot into the chat. Nothing underneath ever needed the gate: the
// round is keyed on the page url. So the gate is gone, and what a page with no
// draft gets instead is the read-only register plus one wrap-up turn.
//
// Its own server, on purpose: these turns say "review round" too, and the
// artifact block above counts the lines in a shared bridge log.
console.log('\ncompanion — POST /send-review on a page with no draft');

{
  const workspaceRoot = tmp('review-ordinary');
  const logFile = path.join(workspaceRoot, 'bridge.jsonl');
  const { base } = await startServer({
    root: workspaceRoot,
    env: {
      PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, MOCK]),
      MOCK_BRIDGE_LOG: logFile,
    },
  });

  const ART = 'https://example.test/the-long-quarter';
  let ids = [];
  let turns = [];

  await test('an ordinary web page with no comments is still a friendly 400', async () => {
    await POST(base, '/page', { url: ART, title: 'The Long Quarter', site: 'example.test' });
    const r = await POST(base, '/send-review', { url: ART });
    assert.equal(r.status, 400);
    assert.ok(/no open comments/.test(r.json.error));
  });

  await test('…and with comments it is a ROUND: preamble, one turn each, wrap-up', async () => {
    fs.writeFileSync(logFile, '');
    const t1 = (await POST(base, '/thread', { url: ART, quote: 'the tunnel under the river',
      msg: { text: 'is this the same tunnel as chapter 2?' } })).json.thread;
    const t2 = (await POST(base, '/thread', { url: ART, quote: 'the second estimate',
      msg: { text: 'check this against the 2019 paper' } })).json.thread;
    ids = [t1.id, t2.id];
    const r = await POST(base, '/send-review', { url: ART });
    assert.equal(r.status, 200, 'no artifact, no project, no council root — and it goes');
    assert.equal(r.json.sent, 2);
    assert.equal(r.json.queued, 4, 'the preamble, one turn per comment, and the wrap-up');
    assert.deepEqual(r.json.threads, ids);
    await waitFor(() => inputs(logFile).filter(t => /review round|Round wrap-up/i.test(t)).length === 4,
      'four turns of the round reaching the bridge');
    turns = inputs(logFile).filter(t => /review round|Round wrap-up/i.test(t));
  });

  await test('no turn of that round asks for an edit — there is nothing here to edit', async () => {
    for (const t of turns) {
      assert.ok(!/make the change/i.test(t), 'the bots have deny-all writes on this page');
      assert.ok(!/yours to edit/i.test(t));
    }
    assert.ok(/Answer this point on its own terms/.test(turns[1]));
    assert.ok(/note I was making to myself/.test(turns[1]),
      'a margin note is not always a question');
  });

  await test('the wrap-up goes LAST, into page chat, routed @all', async () => {
    assert.ok(/Round wrap-up/.test(turns[3]), 'queued last is run last: a page is one FIFO lane');
    assert.ok(/^@all /.test(turns[3]), 'the room, like the preamble');
    assert.ok(/asked about this page/.test(turns[3]), 'the page-chat envelope, not a thread’s');
    assert.ok(/Do not repeat the per-thread answers/.test(turns[3]));
  });

  await test('…and it is a visible message, not a hidden prompt', async () => {
    const page = (await GET(base, '/page?url=' + enc(ART))).json;
    const mine = (page.page_chat || []).filter(m => !/^(claude|codex)/i.test(m.author));
    assert.equal(mine.length, 2, 'the preamble and the wrap-up, both the reader’s own');
    assert.ok(/Review round:/.test(mine[0].text));
    assert.ok(/Round wrap-up/.test(mine[1].text));
  });

  await test('the strip counts the wrap-up as a step, and names it', async () => {
    const r = (await GET(base, '/round?url=' + enc(ART))).json.round;
    assert.ok(r);
    assert.equal(r.total, 3, 'two comments and the wrap-up — the reader is waiting on all three');
  });

  await test('…and the round ENDS when the wrap-up ends, not before', async () => {
    const r = await waitFor(async () => {
      const got = (await GET(base, '/round?url=' + enc(ART))).json.round;
      return got && !got.running ? got : null;
    }, 'the round finishing');
    assert.equal(r.answered, 3, 'the wrap-up is answered like any other step');
    assert.ok(r.done_at);
  });

  await test('every comment was answered in its own thread, wrap-up or not', async () => {
    await waitFor(async () => {
      const page = (await GET(base, '/page?url=' + enc(ART))).json;
      return ids.every(id => {
        const t = (page.threads || []).find(x => x.id === id);
        return t && (t.msgs || []).some(m => /^(claude|codex)/i.test(m.author));
      });
    }, 'a bot reply in each thread');
  });

  // A PDF the reader opened off their own disk is a page like any other, and
  // the identity is the SHA-256 of its bytes rather than a path. "It is only a
  // url" is exactly the sort of claim that turns out to have an https regex
  // hiding behind it, so it is asserted rather than assumed.
  await test('a local PDF gets a round too — its key is a hash, not an address', async () => {
    const PDF = 'bfp-pdf://sha256/' + 'a'.repeat(64);
    await POST(base, '/page', { url: PDF, title: 'The Quiet Machine', site: 'local pdf', kind: 'pdf' });
    await POST(base, '/thread', { url: PDF, page: 4, quote: 'the radiator area',
      msg: { text: 'where does this number come from?' } });
    const r = await POST(base, '/send-review', { url: PDF });
    assert.equal(r.status, 200);
    assert.equal(r.json.sent, 1);
    assert.equal(r.json.queued, 3, 'the preamble, the one comment, and the wrap-up');
  });
}

{
  // agents off: the preamble is still written down, the refusal is the same
  // {queued:false, reason} shape every other submit answers with, and NOTHING is
  // queued — twenty per-thread turns behind a refusal would be twenty identical
  // error lines in twenty threads
  const root = council('review-noagents');
  const a = artifact(root, 'spaceship-engineering');
  const { base } = await startServer({
    root: tmp('review-noagents-companion'),
    args: ['--no-agents'],
  });
  await POST(base, '/council-root', { root, confirm: true });
  await POST(base, '/page', { url: a.url, title: 'Artifact', site: 'spaceship-engineering' });
  await POST(base, '/thread', { url: a.url, quote: 'the truss', msg: { text: 'this needs a number' } });

  await test('with the agents off the review is kept and the refusal explains', async () => {
    const r = await POST(base, '/send-review', { url: a.url });
    assert.equal(r.status, 200);
    assert.equal(r.json.queued, 0, 'no turn was queued at all');
    assert.deepEqual(r.json.threads, [], 'and no thread is told to expect one');
    assert.ok(r.json.reason, 'the same shape as any other refused submit');
    assert.equal(r.json.sent, 1);
    const page = (await GET(base, '/page?url=' + enc(a.url))).json;
    assert.ok((page.page_chat || []).some(m => /Review round:/.test(m.text)),
      'a refusal loses the review nowhere');
    assert.ok((page.threads || []).every(t => !t.addressed), 'and claims nothing about any thread');
  });

  await test('a second click within seconds sends nothing twice', async () => {
    const before = (await GET(base, '/page?url=' + enc(a.url))).json.page_chat.length;
    const r = await POST(base, '/send-review', { url: a.url });
    assert.equal(r.json.deduped, true);
    assert.equal(r.json.queued, 0);
    const after = (await GET(base, '/page?url=' + enc(a.url))).json.page_chat.length;
    assert.equal(after, before);
  });
}

// --- and the whole of it, over the wire -----------------------------------
// A page that is filed nowhere, in a council with one project in it: the
// reader starts a project for it, has an artifact made in that project, and
// the file that comes out is a project artifact page in its own right. The
// bridge is the mock throughout, and the ONLY thing that writes the artifact
// is the mock acting as the bot would.
console.log('\ncompanion — POST /project-create and POST /make-artifact');

{
  const root = council('mkart');
  const workspaceRoot = tmp('mkart-companion');
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
  const PAGE = 'https://example.test/doc-fest-brochure';
  const readPage = async () => (await GET(base, '/page?url=' + enc(PAGE))).json;

  await POST(base, '/council-root', { root, confirm: true });
  await POST(base, '/page', { url: PAGE, title: 'Doc Fest brochure', site: 'example.test' });
  await POST(base, '/thread', { url: PAGE, quote: 'Chungking Express, Fri 7pm',
    msg: { text: 'this one for certain' } });

  let projectId = '';
  const projectDir = () => path.join(root, 'projects', projectId);

  await test('POST /project-create starts the project and files the page in it', async () => {
    const r = await POST(base, '/project-create', { url: PAGE, root, title: 'Doc Fest 2026',
      why: 'a fortnight of screenings to plan' });
    assert.equal(r.status, 200);
    projectId = r.json.id;
    assert.equal(projectId, 'doc-fest-2026');
    assert.ok(fs.existsSync(path.join(projectDir(), 'PROJECT.md')));
    assert.deepEqual(r.json.filed.map(f => f.id), [projectId], 'and the page is in it');
    const page = await readPage();
    assert.deepEqual((page.projects || []).map(p => p.id), [projectId],
      'which is the ordinary filing record — nothing new was invented for it');
  });

  await test('…and it cannot be started twice, or in a council nobody vouched for', async () => {
    const dup = await POST(base, '/project-create', { url: PAGE, root, title: 'Doc Fest 2026' });
    assert.equal(dup.status, 409);
    const other = council('mkart-unconfirmed');
    const bad = await POST(base, '/project-create', { url: PAGE, root: other, title: 'Anything At All' });
    assert.equal(bad.status, 400);
    assert.equal(fs.existsSync(path.join(other, 'projects', 'anything-at-all')), false);
  });

  await test('POST /make-artifact runs ONE turn on the PROJECT\'s lane', async () => {
    const before = spawnEnvs().length;
    const out = path.join(projectDir(), 'plan.html');
    const r = await POST(base, '/make-artifact', {
      url: PAGE, root, id: projectId,
      // the mock plays the bot: it writes the file and ends its reply with the
      // line the turn asked for
      brief: `a planner of what to watch and when [mock:write:${out}]`
        + `[mock:says:Here is the planner.\\nartifact: projects/${projectId}/plan.html]`,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.route, '@claude', 'one writer, and claude unless the brief says codex');
    assert.equal(r.json.queued, true);
    await waitFor(() => spawnEnvs().length > before, 'the project\'s own child to spawn');
    const spawned = spawnEnvs()[spawnEnvs().length - 1];
    assert.equal((spawned.scope || {}).BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS, projectDir(),
      'spawned with that project\'s folder as its one writable directory');
    assert.equal((spawned.scope || {}).BOTFERENCE_PROJECT_ROOT, root,
      'and the council as its workspace — the same child an artifact page would use');
  });

  await test('the turn carries the write rule, the comments and the reader\'s words', async () => {
    const turn = await waitFor(() => inputs(logFile).find(t => /make artifact/.test(t)), 'the turn');
    assert.ok(turn.includes(`You may create and edit files under ${projectDir()}`),
      'the write scope is the envelope\'s own, not a second mechanism');
    assert.match(turn, /Chungking Express, Fri 7pm/, 'the margin comments ride it');
    assert.match(turn, /a planner of what to watch and when/, 'and the brief, verbatim');
    assert.match(turn, /artifact: projects\/doc-fest-2026\/<slug>\.html/);
    const open = inputs(logFile).filter(t => t.trim() === `/project open ${projectId}`);
    assert.ok(open.length >= 1, 'in that project\'s own chat, opened the ordinary way');
  });

  await test('the file it wrote becomes the page\'s artifact, and the line comes off the reply', async () => {
    const page = await waitFor(async () => {
      const p = await readPage();
      return (p.artifacts || []).length ? p : null;
    }, 'the artifact to be recorded');
    assert.deepEqual(page.artifacts.map(a => ({ id: a.id, rel: a.rel })),
      [{ id: projectId, rel: `projects/${projectId}/plan.html` }]);
    assert.equal(page.artifacts[0].root, root);
    assert.ok(page.artifacts[0].at, 'and when it was made');
    const reply = page.page_chat.filter(m => /claude/i.test(m.author)).pop();
    assert.match(reply.text, /Here is the planner\./, 'the reply is posted like any other');
    assert.equal(/artifact:/.test(reply.text), false, 'with the machinery lifted out of the words');
    assert.ok(!page.session_id,
      'and the BORROWED turn wrote no session onto the page: that chat is the '
      + 'project\'s, in the council\'s own state, and this page\'s own child could not resume it');
  });

  await test('…and that file is a project artifact page in its own right', async () => {
    const url = pathToFileURL(path.join(projectDir(), 'plan.html')).href;
    const r = await GET(base, '/project-page?url=' + enc(url));
    assert.equal(r.status, 200);
    assert.ok(r.json.artifact, 'the existing detection finds it — nothing was told about it');
    assert.equal(r.json.artifact.project_id, projectId);
    assert.equal(r.json.artifact.confirmed, true,
      'in a council already confirmed, so it is editable from the moment it exists');
  });

  await test('a page filed nowhere is refused, and says which button to press', async () => {
    const loose = 'https://example.test/nowhere';
    await POST(base, '/page', { url: loose, title: 'Loose', site: 'example.test' });
    const r = await POST(base, '/make-artifact', { url: loose, brief: 'anything' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /file this page in a project first/);
  });

  await test('the page keeps its own lane: its ordinary turns never touch the council', async () => {
    const before = inputs(logFile).length;
    await POST(base, '/reply', { url: PAGE, thread_id: '__page__', text: '@claude and what is on Sunday?' });
    await waitFor(() => inputs(logFile).some((t, i) => i >= before && /what is on Sunday/.test(t)),
      'the ordinary turn');
    const turn = inputs(logFile).slice(before).find(t => /what is on Sunday/.test(t));
    assert.equal(/You may create and edit files under/.test(turn), false,
      'no write scope on the page\'s own lane — filing is a read, and stays one');
    assert.match(turn, /filed in council projects/,
      'what it does carry is the digest, which is what filing has always meant');
    const page = await waitFor(async () => {
      const p = await readPage();
      return p.session_id ? p : null;
    }, 'the page\'s own chat');
    assert.ok(page.session_id, 'and NOW it has a session, made by its own child');
  });
}

cleanup();
await sleep(150);

console.log(`\nworkspace: ${passed()} passed, ${failures().length} failed`);
if (failures().length) { console.log(failures().map(f => '  - ' + f).join('\n')); process.exit(1); }
