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

test('the crash policy: an error in one request is logged and survived; what means the companion cannot serve at all is fatal', () => {
  assert.deepEqual(server.CRASH_ACTIONS, ['log', 'exit']);
  assert.equal(server.crashPolicy(new Error('a route threw later'), { listening: true }), 'log');
  assert.equal(server.crashPolicy(Object.assign(new Error('x'), { code: 'ECONNRESET' }), { listening: true }), 'log');
  assert.equal(server.crashPolicy(new Error('before it was listening'), { listening: false }), 'exit');
  assert.equal(server.crashPolicy(Object.assign(new Error('port taken'), { code: 'EADDRINUSE' }), { listening: true }), 'exit');
  assert.equal(server.crashPolicy(Object.assign(new Error('not ours'), { code: 'EACCES' }), { listening: true }), 'exit');
  assert.equal(server.crashPolicy(null, { listening: true }), 'log');
});

test('the policy is installed on the process (uncaught exceptions and unhandled rejections), and the STANDINGS and mayHear of live events are named', () => {
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(src, /process\.on\('uncaughtException', \(e\) => \{\s+if \(crashPolicy\(e, \{ listening: server\.listening \}\) === 'exit'\)/);
  assert.match(src, /process\.on\('unhandledRejection'/);
  assert.deepEqual(server.STANDINGS, ['owner', 'guest']);
  assert.equal(server.mayHear('guest', true), false);
  assert.equal(server.mayHear('owner', true), true);
  assert.equal(server.mayHear('guest', false), true);
  assert.equal(server.mayHear(undefined, true), false, 'a client with no recorded standing hears nothing hushed');
});

test('an ordinary request still gets its ordinary answer through it', () => {
  const req = { method: 'GET', url: '/health', headers: { host: '127.0.0.1:4189' }, socket: { localPort: 4189, remoteAddress: '127.0.0.1' }, resume() {} };
  const res = resOf();
  res.setHeader = () => {};
  server.safeHandler(req, res);
  assert.equal(res.code, 200);
});
