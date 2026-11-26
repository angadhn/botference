// hub-link-compose-server.test.mjs — a stand-alone post from the Hub through the real companion (`reply {compose: true}`): filed as a
// thread on ONE private page record at a constant address under the Hub's own origin (never fetched), an agent line filled, the draft
// read back, discarded, published once however many times it is sent, and the note is a plain short post: front matter, the owner's
// words and the agent's box, and nothing of that page. A throwaway notes folder, the fake command set, the stand-in one-shot; no network.
//
//   node test/hub-link-compose-server.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET } from './harness.mjs';
import { makeRig, FAKE } from './blyg-rig.mjs';
import { main as cli } from '../hub-link-cli.mjs';
import * as L from '../hub-link.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const { test, waitFor, tmp, startServer, cleanup, passed, failures, SECRETS } = createHarness({ server: path.join(TEST, '..', 'server.mjs'), tag: 'hubcompose', waitMs: 20000 });
const PUBLIC = 'companion.example.com';
const HUB = 'https://blog.example.com';
const SYNTH = `${HUB}${L.HUB_COMPOSE_PATH}`;
const rig = makeRig({ confirm: 'never' });
const root = tmp('root');
{
  const file = path.join(root, '.botference', 'plugin', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const edit = Object.fromEntries(['plan_edit', 'apply_edit', 'publish_edit'].map(k => [k, [process.execPath, FAKE, rig.log, rig.ctl, k, '{note}', '{changelog}']]));
  fs.writeFileSync(file, JSON.stringify({ author: 'owner', blyg_home: { ...rig.home, commands: { ...rig.home.commands, ...edit }, confirm: 'never', plan_guard: ['--only-note'] } }));
}
const srv = await startServer({ root, args: ['--hosted'], env: { PLUGIN_BLYG_CHECKS: 'off',
  PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(TEST, 'mock-bridge.mjs')]), MOCK_BRIDGE_LOG: path.join(root, 'mock.jsonl'),
  PLUGIN_ONESHOT_CMD: JSON.stringify([process.execPath, path.join(TEST, 'oneshot-stub.mjs')]), ONESHOT_LOG: path.join(root, 'oneshot.jsonl'),
  PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_PUBLIC_HOSTNAMES: PUBLIC, PLUGIN_HUB_LINK_PER_MINUTE: '100000' } });
const S = srv.base;
assert.equal(cli(['pair', '--hub', HUB, '--publish', 'one-click', '--companion', `https://${PUBLIC}`], { dir: SECRETS, say: () => {} }), 0);
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
const status = async (rid, text = false) => (await send('status', { rids: [rid], ...(text ? { text: true } : {}) })).json.replies[0];
const notes = () => fs.readdirSync(rig.folder).map(n => fs.readFileSync(path.join(rig.folder, n), 'utf8'));

await test('A STAND-ALONE DRAFT: filed on the synthetic page (made once, titled, never a response), read back, one thread each', async () => {
  const r = await send('reply', { rid: 'rid-comp-draft-01', compose: true, comment: 'A first thought, written on a phone.', intent: 'draft' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.state, 'saved');
  const page = (await GET(S, '/page?url=' + encodeURIComponent(SYNTH))).json;
  assert.equal(page.url, SYNTH);
  assert.equal(page.title, L.HUB_COMPOSE_TITLE);
  assert.notEqual(page.export_response, 'response');
  const t = page.threads.find(x => x.msgs[0].text === 'A first thought, written on a phone.');
  assert.equal(t.quote, '');
  assert.equal(t.via, 'hub-link');
  const s = await status('rid-comp-draft-01', true);
  assert.deepEqual(s.blocks.map(b => b.text), ['A first thought, written on a phone.']);
  // a second one goes on the same page record
  await send('reply', { rid: 'rid-comp-draft-02', compose: true, comment: 'A second thought.', intent: 'draft' });
  assert.equal((await GET(S, '/page?url=' + encodeURIComponent(SYNTH))).json.threads.length, 2);
});

await test('REFUSED: no target, two targets, a quote, add_to; nothing is filed for them', async () => {
  const before = (await GET(S, '/page?url=' + encodeURIComponent(SYNTH))).json.threads.length;
  const bad = x => send('reply', { comment: 'x', intent: 'draft', ...x });
  assert.equal((await bad({ rid: 'rid-comp-bad-001' })).status, 400);
  assert.equal((await bad({ rid: 'rid-comp-bad-002', compose: true, post: { page: 'https://p.example/', origin: 'https://p.example/', id: 'x' } })).status, 400);
  assert.equal((await bad({ rid: 'rid-comp-bad-003', compose: true, quote: 'some words that were selected' })).status, 400);
  const add = await bad({ rid: 'rid-comp-bad-004', compose: true, add_to: 'abc123' });
  assert.equal(add.status, 400);
  assert.match(add.json.error, /never added/);
  assert.equal((await GET(S, '/page?url=' + encodeURIComponent(SYNTH))).json.threads.length, before);
  assert.equal((await status('rid-comp-bad-004')).state, 'unknown');
});

await test('DISCARD: a stand-alone draft is thrown away (its thread deleted), like any other', async () => {
  assert.equal((await send('cancel', { rid: 'rid-comp-draft-02' })).json.state, 'cancelled');
  const page = (await GET(S, '/page?url=' + encodeURIComponent(SYNTH))).json;
  assert.ok(!page.threads.some(t => t.msgs[0].text === 'A second thought.'));
});

await test('A /tk LINE in a stand-alone draft is filled, and read back as the agent\'s passage', async () => {
  const r = await send('reply', { rid: 'rid-comp-tk-0001', compose: true, comment: 'Mine.\n/tk-claude say something short', intent: 'draft' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = await waitFor(async () => { const x = await status('rid-comp-tk-0001', true); return x.fill === 'ready' ? x : null; }, 'the passage filled', 30000);
  assert.deepEqual(v.blocks.map(b => b.kind), ['own', 'agent']);
  assert.equal((await send('cancel', { rid: 'rid-comp-tk-0001' })).json.state, 'cancelled');
});

await test('PUBLISH ONCE: a stand-alone post pressed, published, sent again twice: one note, a plain short post with nothing of the synthetic page', async () => {
  const body = { rid: 'rid-comp-pub-0001', compose: true, comment: 'A stand-alone short post from my phone.', intent: 'publish' };
  const r = await send('reply', body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const again = await send('reply', body);
  assert.deepEqual([again.status, again.json.repeated], [200, true]);
  const v = await waitFor(async () => { const x = await status('rid-comp-pub-0001'); return ['published', 'failed', 'saved'].includes(x.state) ? x : null; }, 'published', 60000);
  assert.equal(v.state, 'published', JSON.stringify(v));
  await send('reply', body);
  const mine = notes().filter(x => x.includes('A stand-alone short post from my phone.'));
  assert.equal(mine.length, 1, 'one note');
  const note = mine[0];
  assert.match(note, /^---\ncreated: \d{4}-\d\d-\d\d\nreleased: "\d{4}-\d\d-\d\d"\nblyg: true\nblyg_id: "[0-9a-z]{26}"\npermalink: \/b\/[0-9a-z]{26}\n---\nA stand-alone short post from my phone\.\n$/, note);
  assert.ok(!/blyg_stub_of|blyg_sources|written-here|blog\.example\.com|Posts written/.test(note));
  assert.equal(notes().filter(x => x.includes('written-here')).length, 0, 'no note anywhere names the synthetic page');
});

const PLAIN = words => new RegExp(`^---\\ncreated: \\d{4}-\\d\\d-\\d\\d\\nreleased: "\\d{4}-\\d\\d-\\d\\d"\\nblyg: true\\nblyg_id: "[0-9a-z]{26}"\\npermalink: \\/b\\/[0-9a-z]{26}\\n---\\n${words}\\n$`);
await test('THE SECOND AND THIRD STAND-ALONE POSTS are plain too: a note of their own, never a link to the previous one, never an addition', async () => {
  for (const [n, words] of [['0002', 'Another one, separate.'], ['0003', 'And a third, also separate.']]) {
    const r = await send('reply', { rid: `rid-comp-pub-${n}`, compose: true, comment: words, intent: 'publish' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const v = await waitFor(async () => { const x = await status(`rid-comp-pub-${n}`); return ['published', 'failed', 'saved'].includes(x.state) ? x : null; }, 'published', 60000);
    assert.deepEqual([v.state, v.version], ['published', 1]);
    const note = notes().find(x => x.includes(words));
    assert.match(note, PLAIN(words.replace(/\./g, '\\.')), note);
    assert.ok(!/Earlier:/.test(note));
  }
  assert.equal(notes().filter(x => /A stand-alone short post|Another one, separate\.|And a third/.test(x)).length, 3);
});

await test('THE STAND-ALONE PAGE OFFERS NOTHING TO ADD TO: earlier-for-a-thread says none, and a pressed addition is refused', async () => {
  const d = await send('reply', { rid: 'rid-comp-add-0001', compose: true, comment: 'A draft after three posts.', intent: 'draft' });
  assert.equal(d.status, 200);
  const page = (await GET(S, '/page?url=' + encodeURIComponent(SYNTH))).json;
  assert.equal(page.stand_alone, true);
  const e = await send('earlier', { post: { page: SYNTH, origin: HUB + '/', id: 'x' } });
  assert.deepEqual(e.json.earlier, []);
  const v = await status('rid-comp-add-0001');
  assert.equal(v.adds_to, undefined);
  assert.equal((await send('cancel', { rid: 'rid-comp-add-0001' })).json.state, 'cancelled');
});

cleanup();
rig.done();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) process.exit(1);
