// tk-read-server.test.mjs — what a `/tk` passage may use, through the real companion: a line typed on this machine may read the
// notes (`tk_read_roots`), a line from the owner's Hub may only search the web while `hub_link_tk_notes` is off (and may read them once
// it is on); what a passage used is kept privately on its gap, and the hub link is told only the plain word. The agent is
// test/oneshot-stub.mjs (it records its argv; no model is called); no network.
//
//   node test/tk-read-server.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, POST } from './harness.mjs';
import { main as cli } from '../hub-link-cli.mjs';
import * as L from '../hub-link.mjs';
import * as C from '../clippings.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const { test, waitFor, tmp, startServer, cleanup, passed, failures, SECRETS } = createHarness({ server: path.join(TEST, '..', 'server.mjs'), tag: 'tkread', waitMs: 20000, realpath: true });
const PUBLIC = 'companion.example.com';
const notes = tmp('notes');
fs.writeFileSync(path.join(notes, 'n.md'), 'a note');
const vault = tmp('vault');
fs.writeFileSync(path.join(vault, 'a.md'), '---\ntitle: A clipped article\nsource: https://www.example.com/p/a\n---\nShips were built in yards during the war years.\n');
const root = tmp('root');
const cfgFile = path.join(root, '.botference', 'plugin', 'config.json');
fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
const setCfg = extra => fs.writeFileSync(cfgFile, JSON.stringify({ author: 'owner', tk_read_roots: [notes], clippings: { folder: vault, collections: [{ name: 'R', files: ['a.md'] }] }, ...extra }));
setCfg({});
const oLog = path.join(root, 'oneshot.jsonl');
fs.writeFileSync(`${oLog}.tools`, JSON.stringify([{ name: 'WebFetch', input: { url: 'https://www.example.com/source' } }, { name: 'Read', input: { file_path: path.join(notes, 'n.md') } }]));
const srv = await startServer({ root, args: ['--hosted'], env: { PLUGIN_BLYG_CHECKS: 'off',
  PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(TEST, 'mock-bridge.mjs')]), MOCK_BRIDGE_LOG: path.join(root, 'mock.jsonl'),
  PLUGIN_ONESHOT_CMD: JSON.stringify([process.execPath, path.join(TEST, 'oneshot-stub.mjs')]), ONESHOT_LOG: oLog,
  PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_PUBLIC_HOSTNAMES: PUBLIC, PLUGIN_HUB_LINK_PER_MINUTE: '100000' } });
const S = srv.base;
assert.equal(cli(['pair', '--hub', 'https://blog.example.com', '--publish', 'drafts-only', '--companion', `https://${PUBLIC}`], { dir: SECRETS, say: () => {} }), 0);
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
const runs = () => (fs.existsSync(oLog) ? fs.readFileSync(oLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const argsOf = run => run.argv.slice(run.argv.indexOf('claude'));
const page = async url => (await GET(S, '/page?url=' + encodeURIComponent(url))).json;
const URL1 = 'https://news.example.com/story';

await test('A LINE TYPED ON THIS MACHINE may read the notes: the read roots as --add-dir, Read/Glob/Grep allowed; what it used kept on the gap', async () => {
  await POST(S, '/page', { url: URL1, title: 'A story' });
  const r = await POST(S, '/thread', { url: URL1, quote: 'A passage of the story.', msg: { text: 'Mine.\n/tk look this up in my notes and at https://www.example.com/source' } });
  assert.equal(r.status, 200, r.body);
  const g = await waitFor(async () => { const p = await page(URL1); const x = p.threads[0].msgs[0].gaps[0]; return x.mode === 'filled-by-agent' ? x : null; }, 'filled');
  const a = argsOf(runs()[0]);
  assert.equal(a[a.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Glob,Grep');
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--add-dir'), [notes]);
  assert.equal(runs()[0].argv[0], '/usr/bin/sandbox-exec', 'wrapped');
  // a notes run fetches only from the host its line names
  const perms = JSON.parse(a[a.indexOf('--settings') + 1]).permissions;
  assert.ok(perms.allow.includes('WebFetch(domain:www.example.com)') && !perms.allow.includes('WebFetch'), JSON.stringify(perms.allow));
  assert.deepEqual([g.used, g.sources.web, g.sources.notes], ['both', ['https://www.example.com/source'], [path.join(notes, 'n.md')]]);
  assert.match(runs()[0].input, /read the reader's notes \(read only, in these folders: /);
  const guest = await GET(S, '/page?url=' + encodeURIComponent(URL1), { host: PUBLIC, authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' });
  assert.ok(!JSON.stringify(guest.json).includes('www.example.com/source'), 'a guest never sees where it came from');
});

await test('A LINE FROM THE HUB may only search the web while hub_link_tk_notes is off; the hub link hears only `used`', async () => {
  const before = runs().length;
  const r = await send('reply', { rid: 'rid-tkread-0001', clipping: C.clippingId('a.md'), quote: 'Ships were built in yards', comment: 'Mine.\n/tk-claude what do my notes say', intent: 'draft' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await waitFor(async () => runs().length > before, 'the run');
  const a = argsOf(runs()[before]);
  assert.equal(a[a.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.ok(!a.includes('--add-dir'), 'no notes through the hub link');
  assert.ok(!/read the reader's notes/.test(runs()[before].input));
  const v = await waitFor(async () => { const x = (await send('status', { rids: ['rid-tkread-0001'], text: true })).json.replies[0]; return x.fill === 'ready' ? x : null; }, 'ready');
  const block = v.blocks.find(b => b.kind === 'agent');
  assert.equal(block.used, 'both');
  assert.ok(!JSON.stringify(v).includes('www.example.com/source') && !JSON.stringify(v).includes(notes), 'never the addresses or paths over the link');
});

await test('…and with hub_link_tk_notes on, a line from the Hub may read the notes', async () => {
  setCfg({ hub_link_tk_notes: 'on' });
  const before = runs().length;
  await send('reply', { rid: 'rid-tkread-0002', clipping: C.clippingId('a.md'), quote: 'Ships were built in yards', comment: 'Mine.\n/tk again', intent: 'draft' });
  await waitFor(async () => runs().length > before, 'the run');
  const a = argsOf(runs()[before]);
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--add-dir'), [notes]);
});

// THE REVIEWER'S SEQUENCE: a thread filed over the hub link while hub_link_tk_notes is off, then saved by the owner on the computer with
// the instruction's words unchanged (the message's channel is re-stamped), then asked again from the Hub and from the drawer: every
// run is web only. Only the owner's rewording of the instruction makes it the owner's (and its run may read the notes).
await test('A HUB-FILED INSTRUCTION STAYS THE HUB\'S through an owner\'s save on the computer: Redo from the Hub and refill in the drawer are web only', async () => {
  setCfg({});
  const before = runs().length;
  const r = await send('reply', { rid: 'rid-tkread-0003', clipping: C.clippingId('a.md'), quote: 'Ships were built in yards', comment: 'Mine.\n/tk-claude what do my notes say about yards', intent: 'draft' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = await waitFor(async () => { const x = (await send('status', { rids: ['rid-tkread-0003'] })).json.replies[0]; return x.fill === 'ready' ? x : null; }, 'filled');
  assert.equal(argsOf(runs()[before]).includes('--add-dir'), false, 'filed: web only');
  // where it was filed, and the owner's save of the message with the instruction unchanged
  const CLIP = 'https://www.example.com/p/a';
  const rec = await waitFor(async () => { const t = ((await page(CLIP)).threads || []).find(x => (x.msgs[0].text || '').includes('about yards')); return t ? { url: CLIP, t } : null; }, 'the filed thread');
  const m = rec.t.msgs[0];
  assert.equal(m.gaps[0].from, 'hub-link');
  const e = await POST(S, '/edit', { url: rec.url, thread_id: rec.t.id, ts: m.ts, author: m.author, text: 'Mine, and a word of my own.\n/tk-claude what do my notes say about yards' });
  assert.equal(e.status, 200, e.body);
  const saved = (await page(rec.url)).threads.find(x => x.id === rec.t.id).msgs[0];
  assert.deepEqual([saved.gaps[0].from, saved.gaps[0].mode], ['hub-link', 'filled-by-agent'], 'kept: same words, same writer');
  // asked again from the Hub
  const n1 = runs().length;
  const redo = await send('redo', { rid: 'rid-tkread-0003', gap: saved.gaps[0].id });
  assert.equal(redo.status, 200, JSON.stringify(redo.json));
  await waitFor(async () => runs().length > n1, 'the redo run');
  assert.equal(argsOf(runs()[n1]).includes('--add-dir'), false, 'Redo from the Hub: web only');
  await waitFor(async () => (await page(rec.url)).threads.find(x => x.id === rec.t.id).msgs[0].gaps[0].mode === 'filled-by-agent', 'refilled');
  // asked again in the drawer
  const n2 = runs().length;
  const refill = await POST(S, '/gap', { url: rec.url, thread_id: rec.t.id, ts: m.ts, gap_id: saved.gaps[0].id, action: 'refill' });
  assert.equal(refill.status, 200, refill.body);
  await waitFor(async () => runs().length > n2, 'the refill run');
  assert.equal(argsOf(runs()[n2]).includes('--add-dir'), false, 'refill in the drawer: web only');
  await waitFor(async () => (await page(rec.url)).threads.find(x => x.id === rec.t.id).msgs[0].gaps[0].mode === 'filled-by-agent', 'refilled again');
  // the owner rewords the instruction on the computer: now the owner's, and its run may read the notes
  const n3 = runs().length;
  const e2 = await POST(S, '/edit', { url: rec.url, thread_id: rec.t.id, ts: m.ts, author: m.author, text: 'Mine, and a word of my own.\n/tk-claude what do my notes say about the yards in winter' });
  assert.equal(e2.status, 200, e2.body);
  await waitFor(async () => runs().length > n3, 'the reworded run');
  assert.deepEqual(argsOf(runs()[n3]).filter((x, i, a) => a[i - 1] === '--add-dir'), [notes], 'reworded by the owner: the owner\'s line');
  const now = (await page(rec.url)).threads.find(x => x.id === rec.t.id).msgs[0].gaps[0];
  assert.notEqual(now.from, 'hub-link');
  void v;
});

cleanup();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
