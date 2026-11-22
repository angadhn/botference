// hostcheck.test.mjs — which NAME a request asked for (hosted.mjs hostVerdict / hostRefused).
//
//   node --test test/hostcheck.test.mjs
//
// A page that rebinds its own name to 127.0.0.1 sends Host and Origin of that name; an unhosted companion
// treats everyone who reaches it as its owner, so the name is judged first, once, by one function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOST_VERDICTS, hostVerdict, hostRefused } from '../hosted.mjs';

const req = (host, localPort = 4189) => ({ headers: host === undefined ? {} : { host }, socket: { localPort } });

test('the verdicts are one named list', () => {
  assert.deepEqual(HOST_VERDICTS, ['loopback', 'allowed', 'wrong-port', 'foreign', 'missing']);
  for (const h of ['127.0.0.1:4189', 'attacker.example:4189', undefined, '127.0.0.1:1']) assert.ok(HOST_VERDICTS.includes(hostVerdict(req(h))));
});

test('loopback names on the right port are loopback; the same names on another port are not', () => {
  for (const h of ['127.0.0.1:4189', 'localhost:4189', 'LOCALHOST:4189', '[::1]:4189']) assert.equal(hostVerdict(req(h)), 'loopback', h);
  for (const h of ['127.0.0.1:4190', 'localhost', 'localhost:80', '[::1]:1']) assert.equal(hostVerdict(req(h)), 'wrong-port', h);
  assert.equal(hostVerdict(req('127.0.0.1', 80)), 'loopback', 'no port means 80, which is right only if that is the port');
});

test('a rebound name is foreign, however it is dressed', () => {
  for (const h of ['attacker.example:4189', 'attacker.example', '127.0.0.1.attacker.example:4189', 'localhost.attacker.example:4189',
    '127.0.0.1@attacker.example:4189', '0.0.0.0:4189', '127.0.0.2:4189', '[::ffff:7f00:1]:4189', 'a b', '127.0.0.1:4189:5']) {
    assert.equal(hostVerdict(req(h)), 'foreign', h);
  }
  assert.equal(hostVerdict(req(undefined)), 'missing');
  assert.equal(hostVerdict(req('')), 'missing');
});

test('only configured public hostnames are allowed', () => {
  assert.equal(hostVerdict(req('hub.example.test'), { publicHosts: [] }), 'foreign');
  assert.equal(hostVerdict(req('hub.example.test'), { publicHosts: ['hub.example.test'] }), 'allowed');
  assert.equal(hostVerdict(req('HUB.example.test:8443'), { publicHosts: ['hub.example.test'] }), 'allowed');
  assert.equal(hostVerdict(req('other.example.test'), { publicHosts: ['hub.example.test'] }), 'foreign');
  const was = process.env.PLUGIN_PUBLIC_HOSTNAMES;
  process.env.PLUGIN_PUBLIC_HOSTNAMES = 'a.example.test, b.example.test';
  try { assert.equal(hostVerdict(req('b.example.test')), 'allowed'); } finally { if (was === undefined) delete process.env.PLUGIN_PUBLIC_HOSTNAMES; else process.env.PLUGIN_PUBLIC_HOSTNAMES = was; }
});

test('refusal: unhosted refuses every name but this machine\'s and the configured ones; hosted leaves a foreign name to the password gate', () => {
  for (const hosted of [false, true]) {
    assert.equal(hostRefused('loopback', hosted), false);
    assert.equal(hostRefused('allowed', hosted), false);
    assert.equal(hostRefused('missing', hosted), true);
  }
  assert.equal(hostRefused('foreign', false), true);
  assert.equal(hostRefused('wrong-port', false), true);
  assert.equal(hostRefused('foreign', true), false);
  assert.equal(hostRefused('wrong-port', true), false, 'a tunnel that rewrites Host to "localhost" still reaches the password gate');
});
