// safehandler.test.mjs — a request handler that throws must not take the companion down.
//
//   node --test test/safehandler.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PLUGIN_NO_LISTEN = '1';
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-safe-'));
const server = await import('../server.mjs');

const resOf = () => ({ headersSent: false, code: 0, body: '', writeHead(c) { this.code = c; this.headersSent = true; return this; }, end(b) { this.body += b || ''; return this; } });

test('a handler that throws answers 500 and the process goes on', () => {
  // a request whose url cannot be read: the handler's very first line throws
  const req = { method: 'GET', headers: { host: '127.0.0.1:4189' }, socket: {}, get url() { throw new Error('boom'); } };
  const res = resOf();
  assert.doesNotThrow(() => server.safeHandler(req, res));
  assert.equal(res.code, 500);
  assert.match(res.body, /internal error/);
  assert.ok(!/boom/.test(res.body), 'and says nothing of why');
});

test('a throw after the headers went out ends the answer instead of writing them twice, and a dead socket is not a second crash', () => {
  const req = { method: 'GET', headers: { host: '127.0.0.1:4189' }, socket: {}, get url() { throw new Error('boom'); } };
  const half = resOf(); half.headersSent = true;
  assert.doesNotThrow(() => server.safeHandler(req, half));
  assert.equal(half.code, 0);
  const dead = { get headersSent() { throw new Error('socket'); }, writeHead() { throw new Error('socket'); }, end() { throw new Error('socket'); } };
  assert.doesNotThrow(() => server.safeHandler(req, dead));
});

test('an ordinary request still gets its ordinary answer through it', () => {
  const req = { method: 'GET', url: '/health', headers: { host: '127.0.0.1:4189' }, socket: { localPort: 4189, remoteAddress: '127.0.0.1' }, resume() {} };
  const res = resOf();
  res.setHeader = () => {};
  server.safeHandler(req, res);
  assert.equal(res.code, 200);
});
