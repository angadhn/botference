// hubguard.test.mjs — the page a route FOUND is what is authorised (pageOf), whatever the gate in front of it saw.
//
//   node --test test/hubguard.test.mjs
//
// The gate in readBody refuses a guest who names an owner-only page; this drives pageOf directly, which skips the gate, so the second
// door is tested on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PLUGIN_NO_LISTEN = '1';
process.env.PLUGIN_PASSWORD = 'guest-pw';
process.env.PLUGIN_OWNER_PASSWORD = 'owner-pw';
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-guard-'));
process.argv.push('--hosted');
const server = await import('../server.mjs');
const store = await import('../store.mjs');

const reqOf = bearer => ({ method: 'POST', url: '/thread', headers: { host: 'discuss.botference.com', authorization: `Bearer ${bearer}`, 'x-plugin-handle': 'ada' }, socket: { remoteAddress: '203.0.113.9' }, resume() {} });
const resOf = () => ({ headersSent: false, code: 0, body: '', writeHead(c) { this.code = c; this.headersSent = true; return this; }, end(b) { this.body += b || ''; return this; } });

test('pageOf answers a guest 404 for a page the Hub made, exactly as for a missing one, and serves the owner', () => {
  const hubUrl = 'https://guard.web.test/a/t/1/';
  store.upsertPage({ url: hubUrl, title: 'Hub page' });
  const rec = store.readPage(hubUrl); rec.hub = { origin: 'https://guard.web.test/a/', id: '1' }; store.savePage(rec);
  store.upsertPage({ url: 'https://guard.web.test/plain', title: 'Plain' });

  const g = resOf();
  assert.equal(server.pageOf(reqOf('guest-pw'), g, { url: hubUrl }), null);
  const missing = resOf();
  assert.equal(server.pageOf(reqOf('guest-pw'), missing, { url: 'https://guard.web.test/none' }), null);
  assert.equal(g.code, 404);
  assert.equal(g.body, missing.body, 'the same words as a page that is not there');
  assert.ok(!g.body.includes('Hub page'));

  assert.equal(server.pageOf(reqOf('guest-pw'), resOf(), { url: 'https://guard.web.test/plain' }).title, 'Plain', 'a shared page is still served to a guest');
  assert.equal(server.pageOf(reqOf('owner-pw'), resOf(), { url: hubUrl }).title, 'Hub page', 'the owner reads it');
});
