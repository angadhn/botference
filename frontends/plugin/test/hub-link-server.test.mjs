// hub-link-server.test.mjs — the hub link through the real companion: signed requests from the owner's hosted Hub, a reply filed as a
// thread on the quoted post's own page record, its /tk gap filled by the stand-in one-shot, published through the queue by the fake
// command set, idempotent by rid across a restart; and every way a request is refused.
//
//   node test/hub-link-server.test.mjs
//
// The "web" is a loopback server behind test/fake-web.mjs (hosts ending .web.test): one blyg at https://blyg.web.test/notes/. No model
// is called (test/oneshot-stub.mjs), no site is touched (test/fixtures/blyg-fake-cmd.mjs in a throwaway git tree), nothing leaves this
// machine. The Hub is played by this file, signing with the key `botference hub-link pair` wrote into the suite's secrets folder.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, request, GET, POST } from './harness.mjs';
import { makeRig } from './blyg-rig.mjs';
import { main as cli } from '../hub-link-cli.mjs';
import * as L from '../hub-link.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const { test, waitFor, tmp, startServer, cleanup, passed, failures, SECRETS } = createHarness({ server: SERVER, tag: 'hublink', waitMs: 20000 });

// ---- the pretend web: one blyg, two posts ----
const sha = s => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const A = '0123456789abcdefghjkmnpqrs', B = 'abcdefghjkmnpqrstvwxyz0123';
const ORIGIN = 'https://blyg.web.test/notes/';
const SAYS = { [A]: 'The first post says this exact sentence about the river.', [B]: 'The second post keeps its page somewhere unusual on purpose.' };
const PAGES = { [A]: `t/${A}/`, [B]: 'posts/the-second-one/' };
const item = id => {
  const md = `Before it. ${SAYS[id]} After it.`;
  return { blyg: '0.4', id, kind: 'thread', origin: ORIGIN, page: PAGES[id], author: { name: 'Feed Author' }, title: `Post ${id.slice(0, 4)}`,
    created: '2026-11-01T00:00:00Z', updated: '2026-11-02T00:00:00Z', version: 1, content_md: md, content_html: `<p>Before it. ${SAYS[id]} After it.</p>`,
    content_hash: sha(md), media: [], transclusions: [], changelog: [{ version: 1, at: '2026-11-02T00:00:00Z', note: null }] };
};
const web = http.createServer((req, res) => {
  const json = v => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
  if (req.url === '/notes/blyg.json') return json({ blyg: '0.4', title: 'Feed Notes', author: { name: 'Feed Author' } });
  if (req.url === `/notes/items/${A}.json`) return json(item(A));
  if (req.url === `/notes/items/${B}.json`) return json(item(B));
  res.writeHead(404).end('not found');
});
await new Promise(r => web.listen(0, '127.0.0.1', r));

// ---- the companion ----
const rigs = [];
const PUBLIC = 'companion.example.com';
const envFor = (root, extra = {}) => {
  const portFile = path.join(root, 'fake-web-port');
  fs.writeFileSync(portFile, String(web.address().port));
  return { PLUGIN_BLYG_CHECKS: 'on', FAKE_WEB_PORT_FILE: portFile,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${JSON.stringify(path.join(TEST, 'fake-web.mjs'))}`.trim(),
    PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(TEST, 'mock-bridge.mjs')]), MOCK_BRIDGE_LOG: path.join(root, 'mock.jsonl'),
    PLUGIN_ONESHOT_CMD: JSON.stringify([process.execPath, path.join(TEST, 'oneshot-stub.mjs')]), ONESHOT_LOG: path.join(root, 'oneshot.jsonl'),
    PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_PUBLIC_HOSTNAMES: PUBLIC, ...extra };
};
const setHome = (root, rig, confirm) => {
  const file = path.join(root, '.botference', 'plugin', 'config.json');
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cfg, author: 'owner', blyg_home: { ...rig.home, confirm, ...(confirm === 'never' ? { plan_guard: ['--only-note'] } : {}) } }));
};
const boot = (root, extra) => startServer({ root, args: ['--hosted'], env: envFor(root, extra) });
const stop = srv => new Promise(r => { srv.proc.once('exit', r); srv.proc.kill(); });
const recordsFile = root => path.join(root, '.botference', 'plugin', L.HUB_LINK_REPLIES_FILE);

// ---- the Hub's side: sign and send ----
const keyNow = () => L.readLinkKey(SECRETS).key;
const say = () => {};
function send(base, route, body, { key = keyNow(), headers = {}, method = 'POST', raw, signBody, ts, nonce } = {}) {
  const p = `/hub-link/${route}`;
  const text = raw !== undefined ? raw : JSON.stringify(body || {});
  const sig = key ? L.signedHeaders(key, p, signBody !== undefined ? signBody : text, { ...(ts ? { ts } : {}), ...(nonce ? { nonce } : {}) }) : {};
  return new Promise((resolve, reject) => {
    const rq = http.request(base + p, { method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), host: PUBLIC, ...sig, ...headers } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { } resolve({ status: res.statusCode, json, body: b }); });
    });
    rq.on('error', e => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 413, json: null, body: '' }) : reject(e)));
    rq.end(text);
  });
}
const postOf = (id, page = `${ORIGIN}${PAGES[id]}`) => ({ page, origin: ORIGIN, id, version: 1 });
// (the JSON routes; speech has its own walk in hub-link-speech.test.mjs, and is on only where its tools are)
const JSON_ROUTES = Object.keys(L.HUB_LINK_ROUTES).filter(r => !['transcribe', 'transcript'].includes(r));
const reply = (base, rid, extra = {}) => send(base, 'reply', { rid, post: postOf(A), quote: SAYS[A], comment: 'My reply from the phone.', intent: 'draft', ...extra });
const status = async (base, rid) => (await send(base, 'status', { rids: [rid] })).json.replies[0];
// (GET /page answers the record itself, as the owner on this machine; an address with no record has no `url`)
const pageAt = async (base, url) => { const j = (await GET(base, '/page?url=' + encodeURIComponent(url))).json; return j && j.url ? j : null; };
const threadsOf = async (base, url) => ((await pageAt(base, url)) || {}).threads || [];
const POST_A = `${ORIGIN}t/${A}/`;

const rig = makeRig({ confirm: 'never' }); rigs.push(rig);
const root = tmp('main');
setHome(root, rig, 'never');
let srv = await boot(root, { PLUGIN_HUB_LINK_PER_MINUTE: '1000' });
let S = srv.base;

await test('UNPAIRED: every /hub-link/* path is 404, signed or not, any method', async () => {
  const fake = { key_id: '01234567', secret: crypto.randomBytes(32).toString('base64url') };
  for (const r of [...Object.keys(L.HUB_LINK_ROUTES), 'nope']) {
    assert.equal((await send(S, r, { rid: 'abcdefgh' }, { key: fake })).status, 404, r);
    assert.equal((await send(S, r, undefined, { key: null, method: 'GET', raw: '' })).status, 404, r);
  }
});

const pair = publish => { const out = []; assert.equal(cli(['pair', '--hub', 'https://blog.example.com', '--publish', publish, '--companion', `https://${PUBLIC}`], { dir: SECRETS, say: s => out.push(s) }), 0, out.join('\n')); };
pair('drafts-only');

await test('ping: the link version and the publish setting, nothing else', async () => {
  const r = await send(S, 'ping', {});
  assert.equal(r.status, 200, r.body);
  assert.ok(['on', 'off'].includes(r.json.speech), 'whether speech is on (its tools are on this machine or not)');
  assert.deepEqual(r.json, { ok: true, version: 'v1', publish: 'drafts-only', key_id: keyNow().key_id, speech: r.json.speech });
});

await test('EVERY ROUTE refuses: a wrong key, a stale timestamp, a replayed nonce, a body not the one signed, an Origin, a GET, a big body, no JSON type', async () => {
  const wrong = { ...keyNow(), secret: crypto.randomBytes(32).toString('base64url') };
  const body = { rid: 'zzzzzzzz', rids: ['zzzzzzzz'] };
  for (const r of JSON_ROUTES) {
    const expect = (got, code, what) => { assert.equal(got.status, code, `${r}: ${what} (${got.body})`); if (code === 401) assert.deepEqual(got.json, { ok: false, error: 'refused' }); };
    expect(await send(S, r, body, { key: wrong }), 401, 'wrong key');
    expect(await send(S, r, body, { key: { ...keyNow(), key_id: 'ffffffff' } }), 401, 'unknown key id');
    expect(await send(S, r, body, { ts: Math.floor(Date.now() / 1000) - 600 }), 401, 'stale');
    const nonce = crypto.randomBytes(16).toString('hex');
    const first = await send(S, r, body, { nonce });
    assert.notEqual(first.status, 401, `${r}: the first use of a nonce (${first.body})`);
    expect(await send(S, r, body, { nonce }), 401, 'replayed nonce');
    expect(await send(S, r, body, { signBody: '{"rid":"other"}' }), 401, 'body not the one signed');
    expect(await send(S, r, body, { key: null }), 401, 'unsigned');
    expect(await send(S, r, body, { headers: { origin: 'https://blog.example.com' } }), 403, 'an Origin header');
    expect(await send(S, r, undefined, { method: 'GET', raw: '' }), 405, 'GET');
    expect(await send(S, r, undefined, { raw: JSON.stringify({ rid: 'zzzzzzzz', pad: 'x'.repeat(L.HUB_LINK_LIMITS.bodyBytes) }) }), 413, 'body over the cap');
    expect(await send(S, r, body, { headers: { 'content-type': 'text/plain' } }), 415, 'not JSON');
  }
});

await test('THE LINK IS NOT THE OWNER: its signed headers open no owner route (hosted, over the tunnel)', async () => {
  const routes = [['POST', '/blyg-publish/start'], ['GET', '/blyg-publish/run'], ['POST', '/blyg-publish/queue-cancel'], ['POST', '/blyg-publish/confirm'],
    ['POST', '/thread'], ['POST', '/page'], ['POST', '/blyg/bind'], ['GET', '/pages'], ['GET', '/page?url=' + encodeURIComponent(POST_A)], ['GET', '/blyg-home']];
  for (const [m, p] of routes) {
    const text = m === 'POST' ? JSON.stringify({ url: POST_A, thread_id: 't', scope: 'one', quote: SAYS[A], msg: { text: 'x' } }) : '';
    const sig = L.signedHeaders(keyNow(), p.split('?')[0], text);
    const r = await request(S, m, p, m === 'POST' ? JSON.parse(text) : undefined, { host: PUBLIC, ...sig, accept: 'application/json' });
    assert.equal(r.status, 401, `${m} ${p}: ${r.status} ${r.body.slice(0, 120)}`);
  }
});

await test('AN OWNER SESSION IS NOT THE LINK: the owner\'s password, over the tunnel or on this machine, opens no /hub-link/* route', async () => {
  for (const r of JSON_ROUTES) {
    assert.equal((await send(S, r, { rid: 'zzzzzzzz' }, { key: null, headers: { authorization: 'Bearer owner-pw' } })).status, 401, `${r} tunnel`);
    const local = await request(S, 'POST', `/hub-link/${r}`, { rid: 'zzzzzzzz' });
    assert.equal(local.status, 401, `${r} loopback owner`);
  }
});

await test('A REPLY is filed on the post\'s own page record as the owner typed it on channel hub-link, marked from the Hub; anchored on the verified text', async () => {
  const r = await reply(S, 'rid-draft-0001');
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.state, 'saved');
  const ts = await threadsOf(S, POST_A);
  assert.equal(ts.length, 1);
  const t = ts[0];
  assert.deepEqual([t.quote, t.via, t.msgs[0].text, t.msgs[0].provenance, t.msgs[0].channel, t.msgs[0].author], [SAYS[A], 'hub-link', 'My reply from the phone.', 'owner-typed', 'hub-link', 'owner']);
  assert.deepEqual([t.prefix, t.suffix], ['Before it. ', ' After it.']);
  assert.deepEqual([t.blyg.status, t.blyg.id], ['blyg', A], 'stamped as a highlight on the post\'s own page is');
  assert.ok(!t.msgs[0].route, 'no agent is summoned');
  const recs = JSON.parse(fs.readFileSync(recordsFile(root), 'utf8')).records;
  // (the signed cancel of an unseen rid in the refusal walk above is remembered as withdrawn: that is not a reply)
  assert.deepEqual(recs.filter(x => x.step !== 'withdrawn').map(x => [x.rid, x.step, x.thread_id]), [['rid-draft-0001', 'saved', t.id]]);
  assert.deepEqual(recs.filter(x => x.step === 'withdrawn').map(x => x.rid), ['zzzzzzzz']);
  assert.equal(fs.statSync(recordsFile(root)).mode & 0o777, 0o600);
  const log = srv.out();
  assert.ok(!log.includes('My reply from the phone') && !log.includes(SAYS[A]) && !log.includes(keyNow().secret), 'no text, quote or secret in the log');
  assert.match(log, /hub-link: rid-draf saved/);
});

await test('THE SAME RID AGAIN is the same reply: one thread, the state as it is, nothing done twice', async () => {
  const again = await reply(S, 'rid-draft-0001', { comment: 'A different text this time.' });
  assert.equal(again.status, 200);
  assert.deepEqual([again.json.state, again.json.repeated], ['saved', true]);
  const both = await Promise.all([reply(S, 'rid-twice-0002'), reply(S, 'rid-twice-0002')]);
  assert.deepEqual(both.map(x => x.status), [200, 200]);
  assert.equal((await threadsOf(S, POST_A)).length, 2, 'two rids, two threads; never a third');
});

await test('A PASSAGE NOT IN THE POST writes nothing: no page, no thread, no record', async () => {
  const before = fs.readFileSync(recordsFile(root), 'utf8');
  const r = await send(S, 'reply', { rid: 'rid-wrong-0003', post: postOf(B), quote: SAYS[A], comment: 'Nope.', intent: 'publish' });
  assert.equal(r.status, 422, r.body);
  assert.deepEqual([r.json.state, r.json.reason], ['refused', 'not-verified']);
  assert.equal(await pageAt(S, `${ORIGIN}${PAGES[B]}`), null);
  assert.equal(fs.readFileSync(recordsFile(root), 'utf8'), before);
  assert.equal((await status(S, 'rid-wrong-0003')).state, 'unknown');
  const short = await send(S, 'reply', { rid: 'rid-short-0004', post: postOf(A), quote: 'exact', comment: 'x', intent: 'draft' });
  assert.equal(short.status, 422, 'too short to say which post it is from');
  const elsewhere = await send(S, 'reply', { rid: 'rid-evil-00005', post: { page: POST_A, origin: 'https://evil.web.test/', id: A, version: 1 }, quote: SAYS[A], comment: 'x', intent: 'draft' });
  assert.equal(elsewhere.status, 422, 'another origin cannot claim the post');
});

await test('THE ITEM\'S PAGE, not the Hub\'s: a claim naming another address files under the post\'s own page', async () => {
  const claimed = `${ORIGIN}t/${B}/`;
  const r = await send(S, 'reply', { rid: 'rid-moved-0006', post: postOf(B, claimed), quote: SAYS[B], comment: 'On the moved post.', intent: 'draft' });
  assert.equal(r.status, 200, r.body);
  assert.equal(await pageAt(S, claimed), null, 'nothing at the Hub\'s address');
  const ts = await threadsOf(S, `${ORIGIN}${PAGES[B]}`);
  assert.deepEqual(ts.map(t => t.msgs[0].text), ['On the moved post.']);
});

await test('A /tk GAP in a Hub reply is asked: pending, then filled by the one-shot; the status counts it', async () => {
  const r = await reply(S, 'rid-gap-00007', { comment: 'My view.\n/tk say the river part in one line' });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.gaps.total, 1);
  const t = await waitFor(async () => (await threadsOf(S, POST_A)).find(x => x.msgs[0].text.startsWith('My view.') && x.msgs[0].gaps && x.msgs[0].gaps[0].mode === 'filled-by-agent'), 'the fill');
  assert.equal(t.msgs[0].gaps[0].text, 'ONESHOT filled text.');
  assert.deepEqual((await status(S, 'rid-gap-00007')).gaps, { total: 1, written: 1, failed: 0 });
  const runs = fs.readFileSync(path.join(root, 'oneshot.jsonl'), 'utf8').trim().split('\n');
  assert.equal(runs.length, 1, 'one agent run for one gap');
});

await test('DRAFTS-ONLY never presses: "publish now" ends at saved, said why; publish {rid} too; no site command ran', async () => {
  const r = await reply(S, 'rid-nopub-0008', { intent: 'publish' });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual([r.json.state, r.json.press.refused], ['saved', 'drafts-only']);
  const p = await send(S, 'publish', { rid: 'rid-nopub-0008' });
  assert.deepEqual([p.status, p.json.state, p.json.press.refused], [200, 'saved', 'drafts-only']);
  assert.deepEqual(rig.calls(), []);
  assert.equal((await send(S, 'publish', { rid: 'rid-never-0009' })).status, 404, 'an unknown rid');
  const gone = await send(S, 'cancel', { rid: 'rid-nopub-0008' });
  assert.deepEqual([gone.status, gone.json.state], [200, 'cancelled'], 'a saved draft is thrown away');
});

const oldKey = keyNow();
{ const out = []; assert.equal(cli(['rotate', '--publish', 'one-click'], { dir: SECRETS, say: s => out.push(s) }), 0); }

await test('ROTATE: the old key is refused at once; the new one works; the setting is one-click', async () => {
  assert.equal((await send(S, 'ping', {}, { key: oldKey })).status, 401);
  const r = await send(S, 'ping', {});
  assert.deepEqual([r.status, r.json.publish], [200, 'one-click']);
});

await test('ONE-CLICK: "publish now" is pressed into the queue (by the Hub, the owner away) and goes live once; repeats do nothing', async () => {
  const r = await reply(S, 'rid-live-00010', { comment: 'This one goes out.', intent: 'publish' });
  assert.equal(r.status, 200, r.body);
  assert.ok(['queued', 'publishing', 'published'].includes(r.json.state), r.body);
  const done = await waitFor(async () => { const s = await status(S, 'rid-live-00010'); return s.state === 'published' || s.state === 'failed' ? s : null; }, 'published');
  assert.equal(done.state, 'published', JSON.stringify(done));
  assert.match(done.address, /^https:\/\/site\.example\.test\/b\//);
  assert.deepEqual(rig.calls().map(c => c.step), ['plan', 'apply', 'publish']);
  const q = JSON.parse(fs.readFileSync(path.join(root, '.botference', 'plugin', 'blyg-publish-queue.json'), 'utf8'));
  const e = q.entries.find(x => x.label.startsWith('This one goes out'));
  assert.deepEqual([e.pressed_by, e.presence, e.started_by], ['hub-link', 'away', 'queue'], 'queued by the Hub, never run at once in a dialog');
  for (const again of [await reply(S, 'rid-live-00010', { intent: 'publish' }), await send(S, 'publish', { rid: 'rid-live-00010' })]) {
    assert.deepEqual([again.status, again.json.state, again.json.repeated], [200, 'published', true]);
  }
  assert.equal((await send(S, 'cancel', { rid: 'rid-live-00010' })).status, 409, 'too late to cancel');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan', 'apply', 'publish'], 'published once');
});

await test('CANCEL while it waits: taken out of the queue; again is the same answer; a running one cannot be', async () => {
  rig.control({ plan: 'hold' });
  const first = await reply(S, 'rid-hold-00011', { comment: 'Held in its plan.', intent: 'publish' });
  assert.equal(first.status, 200, first.body);
  await waitFor(async () => (await status(S, 'rid-hold-00011')).state === 'publishing', 'the first to run');
  const second = await reply(S, 'rid-wait-00012', { comment: 'Waiting behind it.', intent: 'publish' });
  assert.deepEqual([second.json.state, second.json.ahead], ['queued', 1]);
  const c = await send(S, 'cancel', { rid: 'rid-wait-00012' });
  assert.deepEqual([c.status, c.json.state], [200, 'cancelled']);
  const c2 = await send(S, 'cancel', { rid: 'rid-wait-00012' });
  assert.deepEqual([c2.status, c2.json.state, c2.json.repeated], [200, 'cancelled', true]);
  assert.equal((await send(S, 'cancel', { rid: 'rid-hold-00011' })).status, 409);
  rig.control({});
  await waitFor(async () => (await status(S, 'rid-hold-00011')).state === 'published', 'the first goes live');
  assert.equal(rig.calls().filter(x => x.step === 'publish').length, 2, 'the cancelled one never ran');
});

await test('A RESTART between reply and publish: the record is read back; the publish presses once; again does nothing', async () => {
  const r = await reply(S, 'rid-restart-013', { comment: 'Saved before the restart.' });
  assert.equal(r.json.state, 'saved');
  await stop(srv);
  srv = await boot(root, { PLUGIN_HUB_LINK_PER_MINUTE: '1000' });
  S = srv.base;
  assert.equal((await status(S, 'rid-restart-013')).state, 'saved');
  assert.equal((await reply(S, 'rid-restart-013')).json.repeated, true, 'the same rid after a restart is not a new reply');
  const p = await send(S, 'publish', { rid: 'rid-restart-013' });
  assert.equal(p.status, 200, p.body);
  await waitFor(async () => (await status(S, 'rid-restart-013')).state === 'published', 'published');
  assert.equal((await send(S, 'publish', { rid: 'rid-restart-013' })).json.repeated, true);
  assert.equal(rig.calls().filter(x => x.step === 'publish').length, 3);
});

const oneshots = () => { try { return fs.readFileSync(path.join(root, 'oneshot.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
const statusText = async rid => (await send(S, 'status', { rids: [rid], text: true })).json.replies[0];

await test('A DRAFT FILLS AT SAVE: its passage is written without a press, read back as blocks; Publish does not ask again', async () => {
  const before = oneshots();
  const r = await reply(S, 'rid-dfill-0001', { comment: 'Saved for later.\n/tk the river in a line' });
  assert.equal(r.json.state, 'saved');
  const ready = await waitFor(async () => { const x = await statusText('rid-dfill-0001'); return x.fill === 'ready' ? x : null; }, 'the passage written');
  assert.equal(oneshots(), before + 1);
  assert.deepEqual(ready.blocks.map(b => [b.kind, b.text]), [['own', 'Saved for later.\n'], ['agent', 'ONESHOT filled text.']]);
  assert.equal(ready.blocks[1].state, 'filled-by-agent');
  assert.equal((await send(S, 'publish', { rid: 'rid-dfill-0001' })).status, 200);
  await waitFor(async () => (await status(S, 'rid-dfill-0001')).state === 'published', 'published');
  assert.equal(oneshots(), before + 1, 'nothing written twice');
});

await test('REDO from the Hub: one passage asked again through the same one-shot', async () => {
  await reply(S, 'rid-dredo-0001', { comment: 'Again please.\n/tk one more line' });
  const x = await waitFor(async () => { const v = await statusText('rid-dredo-0001'); return v.fill === 'ready' ? v : null; }, 'first fill');
  const before = oneshots();
  const r = await send(S, 'redo', { rid: 'rid-dredo-0001', gap: x.blocks.find(b => b.kind === 'agent').id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await waitFor(async () => (await status(S, 'rid-dredo-0001')).fill === 'ready' && oneshots() === before + 1, 'filled again');
});

await test('A PASSAGE LEFT WRITING BY A RESTART is failed "interrupted" at the next status, so the Hub can offer Write again', async () => {
  await reply(S, 'rid-dintr-0001', { comment: 'Interrupted one.\n/tk a line' });
  await waitFor(async () => (await status(S, 'rid-dintr-0001')).fill === 'ready', 'filled');
  await stop(srv);
  // as if the companion had stopped mid-fill: the passage is still pending on disk
  const dir = path.join(root, '.botference', 'plugin', 'pages');
  for (const f of fs.readdirSync(dir)) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const t = (p.threads || []).find(x => x.msgs && x.msgs[0] && x.msgs[0].text === 'Interrupted one.\n/tk a line');
    if (!t) continue;
    Object.assign(t.msgs[0].gaps[0], { mode: 'pending' }); delete t.msgs[0].gaps[0].text;
    fs.writeFileSync(path.join(dir, f), JSON.stringify(p));
  }
  srv = await boot(root, { PLUGIN_HUB_LINK_PER_MINUTE: '1000' });
  S = srv.base;
  const v = await statusText('rid-dintr-0001');
  assert.deepEqual([v.fill, v.fill_why], ['failed', 'interrupted']);
  assert.equal(v.blocks.find(b => b.kind === 'agent').state, 'failed');
  const before = oneshots();
  assert.equal((await send(S, 'redo', { rid: 'rid-dintr-0001', gap: v.blocks.find(b => b.kind === 'agent').id })).status, 200);
  await waitFor(async () => (await status(S, 'rid-dintr-0001')).fill === 'ready' && oneshots() === before + 1, 'written again');
});

await test('AN OWNER\'S EDIT ON THE COMPUTER: the Hub reads the edited text, marked edited, with a new text_rev; Publish sends the edited text once', async () => {
  await reply(S, 'rid-dedit-0001', { comment: 'Filed from the phone.' });
  const before = await statusText('rid-dedit-0001');
  const t = (await threadsOf(S, POST_A)).find(x => x.msgs[0].text === 'Filed from the phone.');
  const e = await POST(S, '/edit', { url: POST_A, thread_id: t.id, ts: t.msgs[0].ts, author: 'owner', text: 'Rewritten at the desk.', resend: false });
  assert.equal(e.status, 200, e.body);
  const after = await statusText('rid-dedit-0001');
  assert.deepEqual([after.state, after.text_state, after.blocks.map(b => b.text)], ['saved', 'edited-on-computer', ['Rewritten at the desk.']]);
  assert.notEqual(after.text_rev, before.text_rev);
  const notes = () => rig.calls().filter(c => c.step === 'plan').length;
  const planned = notes();
  assert.equal((await send(S, 'publish', { rid: 'rid-dedit-0001' })).status, 200);
  await waitFor(async () => (await status(S, 'rid-dedit-0001')).state === 'published', 'published');
  assert.equal(notes(), planned + 1, 'one run');
  const q = JSON.parse(fs.readFileSync(path.join(root, '.botference', 'plugin', 'blyg-publish-queue.json'), 'utf8'));
  assert.equal(q.entries.filter(x => x.label.startsWith('Rewritten at the desk')).length, 1, 'the edited text, pressed once');
  assert.equal(q.entries.filter(x => x.label.startsWith('Filed from the phone')).length, 0);
});

await test('CANCEL A SAVED DRAFT from the Hub deletes its thread', async () => {
  await reply(S, 'rid-dgone-0001', { comment: 'Throw me away.' });
  assert.ok((await threadsOf(S, POST_A)).some(t => t.msgs[0].text === 'Throw me away.'));
  const c = await send(S, 'cancel', { rid: 'rid-dgone-0001' });
  assert.deepEqual([c.status, c.json.state], [200, 'cancelled']);
  assert.ok(!(await threadsOf(S, POST_A)).some(t => t.msgs[0].text === 'Throw me away.'), 'gone from the page');
});

await test('THREE DRAFTS PUBLISHED IN A ROW are three queue entries, in order, and all go live', async () => {
  rig.control({ plan: 'hold' });
  const rids = ['rid-row1-00001', 'rid-row2-00002', 'rid-row3-00003'];
  for (const [i, rid] of rids.entries()) await reply(S, rid, { comment: `Row draft ${i + 1}.` });
  for (const rid of rids) assert.equal((await send(S, 'publish', { rid })).status, 200);
  const q = JSON.parse(fs.readFileSync(path.join(root, '.botference', 'plugin', 'blyg-publish-queue.json'), 'utf8'));
  const mine = q.entries.filter(e => /^Row draft/.test(e.label)).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(mine.map(e => [e.label, e.pressed_by]), [['Row draft 1.', 'hub-link'], ['Row draft 2.', 'hub-link'], ['Row draft 3.', 'hub-link']]);
  rig.control({});
  for (const rid of rids) await waitFor(async () => (await status(S, rid)).state === 'published', `${rid} published`, 60000);
});

await test('CONFIRM ALWAYS is honoured: a Hub press waits for the owner\'s look on the computer', async () => {
  setHome(root, rig, 'always');
  const r = await reply(S, 'rid-look-00014', { comment: 'Look at me first.', intent: 'publish' });
  assert.equal(r.status, 200, r.body);
  const s = await waitFor(async () => { const x = await status(S, 'rid-look-00014'); return x.state === 'awaiting_look' ? x : null; }, 'awaiting the look');
  assert.equal(s.state, 'awaiting_look');
  assert.equal(rig.calls().filter(x => x.step === 'publish').length, 8, 'nothing published unseen');
});

await test('OFF: the key is deleted and every route is 404 at once', async () => {
  assert.equal(cli(['off'], { dir: SECRETS, say }), 0);
  for (const r of JSON_ROUTES) assert.equal((await send(S, r, { rid: 'rid-look-00014', rids: ['rid-look-00014'] }, { key: oldKey })).status, 404, r);
});
await stop(srv);

// ---- the limits, and a broken records file: a fresh companion with the limits as they ship ----
const rig2 = makeRig({ confirm: 'never' }); rigs.push(rig2);
const root2 = tmp('limits');
setHome(root2, rig2, 'never');
pair('one-click');
const seed = (n, fields) => {
  const at = new Date().toISOString();
  fs.mkdirSync(path.dirname(recordsFile(root2)), { recursive: true });
  fs.writeFileSync(recordsFile(root2), JSON.stringify({ version: 1, records: Array.from({ length: n }, (_, i) => ({ rid: `seed-rid-${String(i).padStart(4, '0')}`, step: 'saved', at, intent: 'draft',
    page_url: POST_A, thread_id: 'gone', entry_id: '', pressed_at: '', ...fields })) }));
};

await test('LIMITS: 20 replies an hour, 10 Hub publishes a day (counted from the records, so a restart does not reset them), 30 requests a minute', async () => {
  seed(20, {});
  let s2 = await boot(root2);
  try {
    const r = await reply(s2.base, 'rid-over-00001');
    assert.deepEqual([r.status, r.json.limit], [429, 'replies-per-hour']);
    assert.equal(await pageAt(s2.base, POST_A), null, 'nothing filed');
  } finally { await stop(s2); }
  seed(10, { step: 'pressed', pressed_at: new Date().toISOString(), entry_id: 'aaaaaaaaaaaa', at: new Date(Date.now() - 2 * 3600e3).toISOString() });
  s2 = await boot(root2);
  try {
    const r = await reply(s2.base, 'rid-over-00002', { intent: 'publish' });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual([r.json.state, r.json.press.refused], ['saved', 'publishes-per-day']);
    assert.deepEqual(rig2.calls(), []);
    let last = null;
    for (let i = 0; i < 40 && !last; i++) { const p = await send(s2.base, 'ping', {}); if (p.status === 429) last = { i, p }; }
    assert.ok(last, 'refused within the minute');
    assert.ok(last.i >= 25 && last.i <= 30, `after about 30 (${last.i})`);
    assert.equal(last.p.json.limit, 'requests-per-minute');
  } finally { await stop(s2); }
});

await test('AN UNREADABLE RECORDS FILE is kept as it is: every route but ping is refused (503) rather than risk acting twice or saying a rid is unknown', async () => {
  fs.writeFileSync(recordsFile(root2), '{ "records": [ broken');
  const s2 = await boot(root2);
  try {
    const r = await reply(s2.base, 'rid-broken-0001');
    assert.equal(r.status, 503, r.body);
    assert.equal((await send(s2.base, 'ping', {})).status, 200, 'ping still answers');
    // (no route answers as if a rid were unknown: the records cannot be read, so nothing is said about any rid)
    for (const [route, body] of [['status', { rids: ['rid-broken-0001'] }], ['cancel', { rid: 'rid-broken-0001' }], ['publish', { rid: 'rid-broken-0001' }]]) {
      const x = await send(s2.base, route, body);
      assert.equal(x.status, 503, `${route}: ${x.body}`);
      assert.deepEqual(x.json, { ok: false, error: 'the hub link records on the computer are unreadable' }, route);
    }
    assert.equal(fs.readFileSync(recordsFile(root2), 'utf8'), '{ "records": [ broken');
  } finally { await stop(s2); }
});

cleanup();
web.close();
for (const r of rigs) r.done();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
