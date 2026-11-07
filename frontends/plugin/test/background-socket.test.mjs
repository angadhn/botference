#!/usr/bin/env node
// THE SERVICE WORKER'S CONNECTION STATE (extension/background.js), with no
// browser: the worker is run in a vm with a stand-in `chrome` and a fake
// WebSocket, so a test can drive sockets open and shut by hand.
//
// What this pins down: a reconnect drops one socket and opens another at once,
// and the dropped socket's late `close` must not undo the new one — it used to
// null the shared socket, mark the connection closed, tell every tab "offline"
// and start a second retry on top of the live connection.
//
//   node frontends/plugin/test/background-socket.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');

let pass = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); }
}
const tick = () => new Promise(r => setTimeout(r, 0));

// A `chrome` that answers every call: any property is another stub, any call
// resolves to undefined (and calls a trailing callback, for the callback-style
// APIs). Enough for the worker's top level to run; nothing here is asserted.
function stubChrome(sent) {
  const make = (pathName) => new Proxy(function () {}, {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (pathName === 'chrome.tabs' && k === 'sendMessage') {
        return (_id, msg) => { sent.push(msg); return Promise.resolve(); };
      }
      if (pathName === 'chrome.tabs' && k === 'query') return () => Promise.resolve([{ id: 1 }]);
      if (/^chrome\.storage\.\w+$/.test(pathName) && k === 'get') {
        return (_keys, cb) => { if (typeof cb === 'function') cb({}); return Promise.resolve({}); };
      }
      return make(`${pathName}.${String(k)}`);
    },
    apply(_t, _this, args) {
      const cb = args[args.length - 1];
      if (typeof cb === 'function' && !/addListener$/.test(pathName)) { try { cb(); } catch { } }
      return Promise.resolve(undefined);
    },
  });
  return make('chrome');
}

function boot() {
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
    close() { if (this.closed) return; this.closed = true; setTimeout(() => this.onclose && this.onclose(), 0); }
    send() { }
  }
  const sent = [];
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams,
    Promise, Map, Set, JSON, Math, Date, TextEncoder, TextDecoder, btoa, atob,
    WebSocket: FakeWS,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    chrome: stubChrome(sent),
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f });
  };
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  const run = code => vm.runInContext(code, ctx);
  return { sockets, sent, run };
}

await test('a reconnect leaves the NEW socket in charge when the old one finishes closing', async () => {
  const W = boot();
  W.run('ensureSocket()');
  await tick(); await tick();
  assert.equal(W.sockets.length, 1, 'one socket opened');
  W.sockets[0].onopen();
  assert.equal(W.run('wsState'), 'open');

  W.run('forceReconnect()');
  await tick(); await tick();
  assert.equal(W.sockets.length, 2, 'a second socket opened straight away');
  const fresh = W.sockets[1];
  // the old socket's close lands now, after the new one exists
  await tick(); await tick();
  assert.equal(W.run('ws === null'), false, 'the shared socket is still the new one');
  assert.equal(W.run('wsState'), 'connecting', 'and still connecting, not closed');
  assert.equal(W.run('retryTimer'), null, 'no second retry was scheduled on top of it');
  fresh.onopen();
  assert.equal(W.run('wsState'), 'open');
  assert.equal(W.sockets.length, 2, 'no third socket');
  W.run('if (retryTimer) clearTimeout(retryTimer)');
});

await test("the old socket's late error cannot close the new one", async () => {
  const W = boot();
  W.run('ensureSocket()');
  await tick(); await tick();
  W.sockets[0].onopen();
  W.run('forceReconnect()');
  await tick(); await tick();
  W.sockets[0].onerror && W.sockets[0].onerror();
  await tick();
  assert.equal(W.sockets[1].closed, false);
  W.sockets[1].onopen();
  assert.equal(W.run('wsState'), 'open');
});

await test('the CURRENT socket closing still reports offline and retries, exactly as before', async () => {
  const W = boot();
  W.run('ensureSocket()');
  await tick(); await tick();
  W.sockets[0].onopen();
  W.sent.length = 0;
  W.sockets[0].onclose();
  assert.equal(W.run('wsState'), 'closed');
  assert.equal(W.run('ws'), null);
  assert.notEqual(W.run('retryTimer'), null, 'a retry is scheduled');
  W.run('clearTimeout(retryTimer); retryTimer = null');
});

console.log(`\nbackground-socket: ${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
process.exit(0);
