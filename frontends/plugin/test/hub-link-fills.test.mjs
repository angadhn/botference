// hub-link-fills.test.mjs — the fills under way (server.mjs liveFills), through the real companion: a Hub draft with two passages,
// the first asked again (redo) while the second is still being written. When the first fill ends it must not take the redo's place
// in the list of fills under way: the next status must see the first passage still being written, not "interrupted", and the
// redo's answer must land. The one-shot is test/oneshot-slow-stub.mjs (a delay per call); no model, no network.
//
//   node test/hub-link-fills.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET } from './harness.mjs';
import { main as cli } from '../hub-link-cli.mjs';
import * as L from '../hub-link.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const { test, waitFor, tmp, startServer, cleanup, passed, failures, SECRETS } = createHarness({ server: path.join(TEST, '..', 'server.mjs'), tag: 'hubfills', waitMs: 20000 });
const sha = s => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const A = '0123456789abcdefghjkmnpqrs';
const ORIGIN = 'https://blyg.web.test/notes/';
const SAYS = 'The first post says this exact sentence about the river.';
const md = `Before it. ${SAYS} After it.`;
const web = http.createServer((req, res) => {
  const json = v => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  if (req.url === '/notes/blyg.json') return json({ blyg: '0.4', title: 'Feed Notes', author: { name: 'Feed Author' } });
  if (req.url === `/notes/items/${A}.json`) return json({ blyg: '0.4', id: A, kind: 'thread', origin: ORIGIN, page: `t/${A}/`, author: { name: 'Feed Author' },
    created: '2026-11-01T00:00:00Z', updated: '2026-11-02T00:00:00Z', version: 1, content_md: md, content_html: `<p>${md}</p>`, content_hash: sha(md), media: [], transclusions: [],
    changelog: [{ version: 1, at: '2026-11-02T00:00:00Z', note: null }] });
  res.writeHead(404).end('not found');
});
await new Promise(r => web.listen(0, '127.0.0.1', r));
const root = tmp('root');
fs.writeFileSync(path.join(root, 'fake-web-port'), String(web.address().port));
const oLog = path.join(root, 'oneshot.jsonl');
// call 0: the first passage (at once); call 1: the second (held 8 s); call 2: the first asked again (held 14 s). Wide on purpose: the
// redo must be asked while the second is still being written, on a machine that may be busy.
fs.writeFileSync(`${oLog}.delays`, JSON.stringify([0, 8000, 14000]));
const PUBLIC = 'companion.example.com';
const srv = await startServer({ root, args: ['--hosted'], env: { PLUGIN_BLYG_CHECKS: 'on', FAKE_WEB_PORT_FILE: path.join(root, 'fake-web-port'),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(path.join(TEST, 'fake-web.mjs'))}`.trim(),
  PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(TEST, 'mock-bridge.mjs')]), MOCK_BRIDGE_LOG: path.join(root, 'mock.jsonl'),
  PLUGIN_ONESHOT_CMD: JSON.stringify([process.execPath, path.join(TEST, 'oneshot-slow-stub.mjs')]), ONESHOT_LOG: oLog,
  PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_PUBLIC_HOSTNAMES: PUBLIC, PLUGIN_HUB_LINK_PER_MINUTE: '100000' } });
assert.equal(cli(['pair', '--hub', 'https://blog.example.com', '--publish', 'drafts-only', '--companion', `https://${PUBLIC}`], { dir: SECRETS, say: () => {} }), 0);
const key = L.readLinkKey(SECRETS).key;
function send(route, body) {
  const p = `/hub-link/${route}`;
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const rq = http.request(srv.base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), host: PUBLIC, ...L.signedHeaders(key, p, text) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    });
    rq.on('error', reject); rq.end(text);
  });
}
const view = async rid => (await send('status', { rids: [rid], text: true })).json.replies[0];
const passages = v => (v.blocks || []).filter(b => b.kind === 'agent').map(b => [b.id, b.state, b.text, b.reason || '']);

await test('A REDO WHILE ANOTHER PASSAGE IS BEING WRITTEN: the first fill ending does not end the redo; its answer lands', async () => {
  const r = await send('reply', { rid: 'rid-twofills-01', post: { page: `${ORIGIN}t/${A}/`, origin: ORIGIN, id: A, version: 1 }, quote: SAYS,
    comment: 'Mine.\n/tk first one\n/tk second one', intent: 'draft' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // the first written, the second still being written (held 8 s)
  const v1 = await waitFor(async () => { const v = await view('rid-twofills-01'); const p = passages(v); return p.length === 2 && p[0][1] === 'filled-by-agent' ? v : null; }, 'the first passage');
  const g1 = passages(v1)[0][0];
  assert.equal(passages(v1)[1][1], 'pending');
  // asked again (held 14 s), while the second is still being written
  assert.equal((await send('redo', { rid: 'rid-twofills-01', gap: g1 })).status, 200);
  assert.equal(passages(await view('rid-twofills-01'))[1][1], 'pending', 'the premise: the redo was asked while the second passage is still being written');
  // the first fill ends (the second passage written); the redo is still writing
  await waitFor(async () => passages(await view('rid-twofills-01'))[1][1] === 'filled-by-agent', 'the second passage', 25000);
  const mid = await view('rid-twofills-01');
  assert.deepEqual(passages(mid)[0].slice(0, 2), [g1, 'pending'], `still being written, not interrupted: ${JSON.stringify(passages(mid))}`);
  assert.equal(mid.fill, 'writing');
  const done = await waitFor(async () => { const v = await view('rid-twofills-01'); return passages(v)[0][1] === 'filled-by-agent' ? v : null; }, 'the redo\'s answer', 25000);
  assert.equal(passages(done)[0][2], 'FILL 2', 'the redo\'s answer, not thrown away');
  assert.equal(done.fill, 'ready');
});

cleanup();
web.close();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
