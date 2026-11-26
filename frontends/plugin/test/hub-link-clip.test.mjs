// hub-link-clip.test.mjs — the owner's clippings through the real companion: `clippings` lists only the allow-listed files (facts, no
// names, no paths), `clipping` pages one by id, a reply to a clipping is checked against its own text, filed on the page record of
// its SOURCE address (never fetched), and published by the plugin's ordinary web-page path (blyg_stub_of {url, title}, the web quote,
// the page asked about mentions); `earlier` and `add_to` work for it; nothing outside the allow-list is readable. A throwaway notes
// folder, the fake command set, the stand-in one-shot; no network (the clipping's address is never fetched).
//
//   node test/hub-link-clip.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET } from './harness.mjs';
import { makeRig, FAKE } from './blyg-rig.mjs';
import { main as cli } from '../hub-link-cli.mjs';
import * as L from '../hub-link.mjs';
import * as C from '../clippings.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const { test, waitFor, tmp, startServer, cleanup, passed, failures, SECRETS } = createHarness({ server: path.join(TEST, '..', 'server.mjs'), tag: 'hubclip', waitMs: 20000 });
const PUBLIC = 'companion.example.com';

// ---- the notes folder: three clippings on the list, one off it, one symlinked out ----
const vault = tmp('vault');
const outside = tmp('outside');
const clipFile = (title, source, published, body) => `---\ntitle: ${title}\nsource: ${source}\nauthor:\n  - "[[A Writer]]"\npublished: ${published}\ntags:\n  - clippings\n---\n${body}\n`;
const BODY1 = 'Shipyards were *busy* during the war. The [Maritime Commission](https://en.example.com/mc) planned hundreds of ships.[^1]\n\n![](https://img.example.com/a.png)\n\n<iframe src="https://chart.example.com/x"></iframe>\n\nA second paragraph about welding and prefabrication.\n\n[^1]: A note.';
fs.writeFileSync(path.join(vault, 'Ships one.md'), clipFile('How ships were built', 'https://www.example.com/p/ships-one?s=w&utm_source=x', '2025-05-07', BODY1));
fs.writeFileSync(path.join(vault, 'Ships zero.md'), clipFile('An older one', 'https://www.example.com/p/ships-zero', '2022-03-04', 'Older words about shipbuilding productivity in yards.'));
fs.writeFileSync(path.join(vault, 'Not listed.md'), clipFile('Private', 'https://www.example.com/p/private', '2024-01-01', 'PRIVATE words never to be read.'));
fs.writeFileSync(path.join(outside, 'secret.md'), clipFile('Secret', 'https://www.example.com/p/secret', '2024-01-01', 'SECRET outside the folder.'));
fs.symlinkSync(path.join(outside, 'secret.md'), path.join(vault, 'Linked.md'));
const SETTING = { folder: vault, collections: [{ name: 'Shipbuilding', files: ['Ships one.md', 'Ships zero.md', 'Linked.md'] }] };

const rig = makeRig({ confirm: 'never' });
const root = tmp('root');
{
  const file = path.join(root, '.botference', 'plugin', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const edit = Object.fromEntries(['plan_edit', 'apply_edit', 'publish_edit'].map(k => [k, [process.execPath, FAKE, rig.log, rig.ctl, k, '{note}', '{changelog}']]));
  fs.writeFileSync(file, JSON.stringify({ author: 'owner', clippings: SETTING, blyg_home: { ...rig.home, commands: { ...rig.home.commands, ...edit }, confirm: 'never', plan_guard: ['--only-note'] } }));
}
const srv = await startServer({ root, args: ['--hosted'], env: { PLUGIN_BLYG_CHECKS: 'off',
  PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(TEST, 'mock-bridge.mjs')]), MOCK_BRIDGE_LOG: path.join(root, 'mock.jsonl'),
  PLUGIN_ONESHOT_CMD: JSON.stringify([process.execPath, path.join(TEST, 'oneshot-stub.mjs')]), ONESHOT_LOG: path.join(root, 'oneshot.jsonl'),
  PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_PUBLIC_HOSTNAMES: PUBLIC, PLUGIN_HUB_LINK_PER_MINUTE: '100000' } });
const S = srv.base;
assert.equal(cli(['pair', '--hub', 'https://blog.example.com', '--publish', 'one-click', '--companion', `https://${PUBLIC}`], { dir: SECRETS, say: () => {} }), 0);
const key = L.readLinkKey(SECRETS).key;
function send(route, body) {
  const p = `/hub-link/${route}`;
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const rq = http.request(S + p, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), host: PUBLIC, ...L.signedHeaders(key, p, text) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    });
    rq.on('error', reject); rq.end(text);
  });
}
const status = async rid => (await send('status', { rids: [rid] })).json.replies[0];
const SOURCE = 'https://www.example.com/p/ships-one';
const ID1 = C.clippingId('Ships one.md');

await test('CLIPPINGS: the allow-listed files only, oldest first, facts only (no file names, no paths); a symlink out is left out', async () => {
  const r = await send('clippings', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.collections.length, 1);
  const c = r.json.collections[0];
  assert.equal(c.name, 'Shipbuilding');
  assert.deepEqual(c.clippings.map(x => x.title), ['An older one', 'How ships were built']);
  assert.deepEqual(c.clippings[1], { id: ID1, title: 'How ships were built', author: 'A Writer', source: SOURCE, published: '2025-05-07', words: c.clippings[1].words, rev: c.clippings[1].rev });
  assert.match(c.clippings[1].rev, /^[0-9a-f]{12}$/);
  const all = JSON.stringify(r.json);
  for (const no of ['Ships one.md', vault, 'PRIVATE', 'SECRET', 'Private', 'Secret']) assert.ok(!all.includes(no), no);
});

await test('CLIPPING: markdown and its plain text, paged; anything not on the list is 404', async () => {
  const r = await send('clipping', { id: ID1 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.page, r.json.pages, r.json.source], [1, 1, SOURCE]);
  assert.equal(r.json.rev, (await send('clippings', {})).json.collections[0].clippings[1].rev, 'the same rev as the list');
  assert.match(r.json.markdown, /\[Maritime Commission\]\(https:\/\/en\.example\.com\/mc\)/);
  assert.equal(r.json.text, 'Shipyards were busy during the war. The Maritime Commission planned hundreds of ships.\n\nA second paragraph about welding and prefabrication.\n\nA note.');
  for (const name of ['Not listed.md', 'Linked.md', 'nothing.md']) assert.equal((await send('clipping', { id: C.clippingId(name) })).status, 404, name);
  assert.equal((await send('clipping', { id: '../../etc/passwd' })).status, 400);
  assert.equal((await send('clipping', { id: ID1, page: 2 })).status, 400);
});

await test('A REPLY TO A CLIPPING: checked against its text, filed on the SOURCE page record, published by the web-page path; earlier names it', async () => {
  const bad = await send('reply', { rid: 'rid-clip-bad-01', clipping: ID1, quote: 'words that are not in the clipping at all', comment: 'x', intent: 'draft' });
  assert.deepEqual([bad.status, bad.json.reason], [422, 'not-in-clipping']);
  assert.equal((await send('reply', { rid: 'rid-clip-two-01', clipping: ID1, post: { page: SOURCE, origin: 'https://x/', id: 'y' }, quote: 'Shipyards were busy', comment: 'x', intent: 'draft' })).status, 400);
  assert.equal((await send('reply', { rid: 'rid-clip-404-01', clipping: C.clippingId('Not listed.md'), quote: 'PRIVATE words never', comment: 'x', intent: 'draft' })).status, 404);
  // the passage as the Hub shows it (rendered: no marks, the link as its text), across two paragraphs
  const r = await send('reply', { rid: 'rid-clip-pub-01', clipping: ID1, quote: 'The Maritime Commission planned hundreds of ships.\nA second paragraph about welding',
    comment: 'A reply to a clipped article.', intent: 'publish' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = await waitFor(async () => { const x = await status('rid-clip-pub-01'); return ['published', 'failed', 'saved'].includes(x.state) ? x : null; }, 'published', 60000);
  assert.equal(v.state, 'published', JSON.stringify(v));
  const page = (await GET(S, '/page?url=' + encodeURIComponent(SOURCE))).json;
  assert.equal(page.url.replace(/\/$/, ''), SOURCE);
  assert.equal(page.title, 'How ships were built');
  const t = page.threads.find(x => x.msgs[0].text === 'A reply to a clipped article.');
  assert.equal(t.quote, 'The Maritime Commission planned hundreds of ships.\nA second paragraph about welding');
  const note = fs.readdirSync(rig.folder).map(n => fs.readFileSync(path.join(rig.folder, n), 'utf8')).find(x => x.includes('A reply to a clipped article.'));
  assert.match(note, /blyg_stub_of:\n {2}url: "https:\/\/www\.example\.com\/p\/ships-one"\n {2}title: "How ships were built"/);
  assert.match(note, /> The Maritime Commission planned hundreds of ships\./);
  assert.match(note, /https:\/\/www\.example\.com\/p\/ships-one/);
  const e = await send('earlier', { clipping: ID1 });
  assert.equal(e.status, 200);
  assert.equal(e.json.earlier.length, 1);
  // …and an addition to it goes out as its next version
  const postId = e.json.earlier[0].id;
  const add = await send('reply', { rid: 'rid-clip-add-01', clipping: ID1, quote: 'Shipyards were busy during the war.', comment: 'And another thought.', intent: 'publish', add_to: postId });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const av = await waitFor(async () => { const x = await status('rid-clip-add-01'); return ['published', 'failed', 'saved'].includes(x.state) ? x : null; }, 'added', 60000);
  assert.deepEqual([av.state, av.version], ['published', 2]);
});

await test('DRAFTS FROM A CLIPPING: text read back, discard works', async () => {
  const d = await send('reply', { rid: 'rid-clip-dra-01', clipping: ID1, quote: 'welding and prefabrication', comment: 'A draft from a clipping.', intent: 'draft' });
  assert.equal(d.json.state, 'saved');
  const s = (await send('status', { rids: ['rid-clip-dra-01'], text: true })).json.replies[0];
  assert.deepEqual(s.blocks.map(b => b.text), ['A draft from a clipping.']);
  assert.equal((await send('cancel', { rid: 'rid-clip-dra-01' })).json.state, 'cancelled');
});

await test('THE SETTING REMOVED: the list is empty and every clipping 404 at once', async () => {
  const file = path.join(root, '.botference', 'plugin', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete cfg.clippings;
  fs.writeFileSync(file, JSON.stringify(cfg));
  assert.deepEqual((await send('clippings', {})).json.collections, []);
  assert.equal((await send('clipping', { id: ID1 })).status, 404);
  assert.equal((await send('reply', { rid: 'rid-clip-off-01', clipping: ID1, quote: 'Shipyards were busy during', comment: 'x', intent: 'draft' })).status, 404);
});

cleanup();
rig.done();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
