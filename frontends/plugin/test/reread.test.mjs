#!/usr/bin/env node
// Re-read after await — a route that awaits and then saves the copy of the
// page it read BEFORE the await erases whatever landed in between (a bot's
// answer, most often). /run has always re-read; /send-review and the review
// mirror now do too.
//
// This suite runs the companion IN PROCESS (PLUGIN_NO_LISTEN=1, its handler on
// a port of our own) because the only way to land a write inside the route's
// await on purpose is to be the thing it awaits: a link in the comment makes
// the turn fetch it (lasso.webForTurn), and the stubbed fetch writes the "bot
// answer" into the page file before it answers. No network: DNS is stubbed too.
//
//   node frontends/plugin/test/reread.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import { POST, GET } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-reread-root-')));
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-reread-secrets-'));
Object.assign(process.env, {
  PLUGIN_NO_LISTEN: '1', BOTFERENCE_PROJECT_ROOT: ROOT, BOTFERENCE_HOME: ROOT,
  BOTFERENCE_SECRETS_DIR: SECRETS, PLUGIN_OWNER_PASSWORD: '', REVIEW_HUB_PASSWORD: '',
  BOTFERENCE_SITES_REGISTRY: path.join(SECRETS, 'sites.json'), PLUGIN_EDITOR_PROBE: 'none',
  PLUGIN_BRIDGE_POOL: '1', PLUGIN_BRIDGE_CMD: JSON.stringify([process.execPath, path.join(here, 'mock-bridge.mjs')]),
  MOCK_BRIDGE_LOG: path.join(ROOT, 'mock.jsonl'),
});
dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

const store = await import('../store.mjs');
const { handler } = await import('../server.mjs');

// the "bot answer" that lands while the route is suspended on the fetch
const BOT = 'an answer that landed while the route was waiting';
let landOn = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  if (landOn) {
    const p = store.readPage(landOn);
    store.appendMsg(p, store.PAGE_CHAT, { author: 'claude', text: BOT });
    store.savePage(p);
    landOn = null;
  }
  await new Promise(r => setTimeout(r, 20));
  return new Response('<html><head><title>Linked</title></head><body><p>linked text</p></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } });
};

const server = http.createServer(handler);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

// /send-review re-reads before its wrap-up save too, but there is no way to
// land a write inside its awaits from here: the round's turn texts are fixed
// sentences (workspace.reviewTurn — the comment rides in `history`), so they
// carry no link and summon's one await never reaches the network. The fix
// there is the same three lines as below and as /run's, kept for the day a
// turn text does carry one; companion.test.mjs covers the round itself.

await test('review mirror: a bot answer written during a summon survives the comments filed after it', async () => {
  const url = 'https://paper.example/reread-mirror.html';
  landOn = null;
  await POST(base, '/page', { url, title: 'Mirror', site: 'paper.example' });
  landOn = url;
  const r = await POST(base, '/review-comments', { url, summon: true, comments: [
    { id: 'c1', author: 'ada', quote: 'first passage', text: '@claude check https://example.org/first', ts: '2026-11-07T10:00:00Z' },
    { id: 'c2', author: 'ada', quote: 'second passage', text: 'and a plain note', ts: '2026-11-07T10:01:00Z' },
  ] });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.created, 2);
  assert.equal(landOn, null, 'the stubbed fetch ran inside the route');
  const page = (await GET(base, `/page?url=${encodeURIComponent(url)}`)).json;
  assert.ok((page.page_chat || []).some(m => m.text === BOT), 'the answer that landed meanwhile is still there');
  assert.equal(page.threads.length, 2, 'and both comments were filed');
});

globalThis.fetch = realFetch;
server.close();
for (const d of [ROOT, SECRETS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { } }
console.log(`\n✓ reread.test.mjs — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log(failures.map(f => `  · ${f}`).join('\n'));
process.exit(failures.length ? 1 : 0);
