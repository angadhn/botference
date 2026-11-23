// ws-hardening.test.mjs — a request must not be able to take the companion down: malformed cookies and escapes, and the WebSocket reader.
//
//   node frontends/plugin/test/ws-hardening.test.mjs
//
// (1) a cookie with a malformed percent escape is NO SESSION, never a throw (the cookie is read before any login, and on the WebSocket
//     upgrade path nothing catches); (2) an exception inside the upgrade listener ends that socket, not the process; (3) the frame reader
//     refuses a frame that announces more than it will ever buffer (close 1009), and a control frame over 125 bytes (1002); (4) a
//     malformed escape in a query is not a page. The server tests start a real companion (hosted, so a request from this machine is the
//     owner and a request that is not asks for a password) and check that it still answers afterwards.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET } from './harness.mjs';
import { deviceSession } from '../identity.mjs';
import { attachWs, MAX_DATA_FRAME, MAX_CONTROL_FRAME, CLOSE_CODES } from '../../review/ws.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const { test, tmp, startServer, cleanup, passed, failures } = createHarness({ server: path.join(TEST, '..', 'server.mjs'), tag: 'wsh', waitMs: 15000 });

await test('a malformed percent escape in a device cookie is no session (it used to throw)', () => {
  assert.equal(deviceSession('%E0%A4%A', 'a-secret'), null);
  assert.equal(deviceSession('%', 'a-secret'), null);
  assert.equal(deviceSession('%zz.1.2', 'a-secret'), null);
  assert.equal(deviceSession('', 'a-secret'), null);
  assert.equal(deviceSession(undefined, 'a-secret'), null);
});

await test('an exception in authorize, or anywhere in the upgrade, ends that socket and nothing else', () => {
  const server = new EventEmitter();
  attachWs(server, { authorize: () => { throw new Error('boom'); }, onOpen() {} });
  const sock = new EventEmitter();
  let destroyed = 0; sock.destroy = () => { destroyed++; }; sock.write = () => {};
  assert.doesNotThrow(() => server.emit('upgrade', { url: '/ws', headers: { 'sec-websocket-key': 'abc', upgrade: 'websocket' } }, sock));
  assert.equal(destroyed, 1);
  // a socket that errors (a reset) before the upgrade is answered has a listener: it is not an uncaught 'error' event
  assert.doesNotThrow(() => sock.emit('error', new Error('reset')));
  // a request whose headers cannot even be read
  const bad = new EventEmitter(); bad.destroy = () => { destroyed++; };
  assert.doesNotThrow(() => server.emit('upgrade', { get url() { throw new Error('boom'); }, headers: {} }, bad));
  assert.equal(destroyed, 2);
});

const root = tmp('root');
const srv = await startServer({ root, args: ['--hosted', '--no-agents'], env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw' } });
const U = new URL(srv.base);
const alive = async () => (await GET(srv.base, '/health')).status === 200;

// a raw upgrade request; resolves with what the server said and whether it hung up
function upgrade(headers = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(U.port), U.hostname, () => {
      const lines = ['GET /ws HTTP/1.1', `Host: 127.0.0.1:${U.port}`, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''];
      s.write(lines.join('\r\n'));
    });
    let out = Buffer.alloc(0);
    s.on('data', c => { out = Buffer.concat([out, c]); });
    s.on('close', () => resolve({ socket: s, out: out.toString('latin1'), closed: true }));
    s.on('error', reject);
    setTimeout(() => resolve({ socket: s, out: out.toString('latin1'), closed: false }), 400);
  });
}
// the server's frames, in order (it says hello first): [{ op, payload }]
const framesOf = (buf) => {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const op = buf[i] & 0x0f; let len = buf[i + 1] & 0x7f; let off = i + 2;
    if (len === 126) { len = buf.readUInt16BE(off); off += 2; } else if (len === 127) { len = Number(buf.readBigUInt64BE(off)); off += 8; }
    if (off + len > buf.length) break;
    out.push({ op, payload: buf.slice(off, off + len) }); i = off + len;
  }
  return out;
};
const maskedFrame = (opcode, payload) => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const p = Buffer.from(payload);
  const body = Buffer.from(p.map((b, i) => b ^ mask[i % 4]));
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | p.length]);
  else head = Buffer.from([0x80 | opcode, 0x80 | 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, mask, body]);
};

await test('the companion survives a malformed cookie on the WebSocket upgrade (it used to exit)', async () => {
  assert.ok(await alive());
  for (const cookie of ['hub_device=%E0%A4%A', 'hub_device=%', 'plugin_auth=%zz; hub_device=%E0%A4%A']) {
    const r = await upgrade({ Cookie: cookie });
    assert.ok(/^HTTP\/1\.1 (101|401)/.test(r.out) || r.closed, cookie + ' -> ' + r.out.slice(0, 40));
    r.socket.destroy();
    assert.ok(await alive(), 'still serving after ' + cookie);
  }
  // …and the same cookie on an ordinary request
  assert.equal((await GET(srv.base, '/health', { cookie: 'hub_device=%E0%A4%A' })).status, 200);
  assert.ok(await alive());
});

await test('a malformed escape in a page query names no page and does not stop the companion', async () => {
  for (const q of ['/page?url=%E0%A4%A', '/page?url=%', '/index?url=%zz']) {
    const r = await GET(srv.base, q);
    assert.ok([400, 404, 200].includes(r.status), `${q} -> ${r.status}`);
  }
  assert.ok(await alive());
});

await test('a frame that announces more than the reader will buffer is refused (1009), without being waited for', async () => {
  const r = await upgrade();
  assert.match(r.out, /^HTTP\/1\.1 101/);
  const s = r.socket;
  let got = Buffer.alloc(0);
  s.on('data', c => { got = Buffer.concat([got, c]); });
  // a header that announces 2^40 bytes, then nothing: the server must not wait for them
  const hdr = Buffer.alloc(14); hdr[0] = 0x82; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(2n ** 40n, 2);
  s.write(hdr);
  await new Promise(res => setTimeout(res, 300));
  const head = r.out.indexOf('\r\n\r\n') + 4;
  const frameBytes = Buffer.concat([Buffer.from(r.out.slice(head), 'latin1'), got]);
  const close = framesOf(frameBytes).find(f => f.op === 0x8);
  assert.ok(close, 'a close frame');
  assert.equal(close.payload.readUInt16BE(0), CLOSE_CODES.tooBig, 'status 1009');
  assert.equal(CLOSE_CODES.tooBig, 1009);
  s.destroy();
  assert.ok(await alive());
});

await test('a data frame over the cap (even one that fits in 16 bits) is refused; a control frame over 125 bytes is a protocol error; an ordinary ping is answered', async () => {
  assert.equal(MAX_CONTROL_FRAME, 125);
  const one = async (build) => {
    const r = await upgrade();
    const s = r.socket;
    let got = Buffer.alloc(0);
    s.on('data', c => { got = Buffer.concat([got, c]); });
    s.write(build());
    await new Promise(res => setTimeout(res, 250));
    const head = r.out.indexOf('\r\n\r\n') + 4;
    const all = Buffer.concat([Buffer.from(r.out.slice(head), 'latin1'), got]);
    s.destroy();
    return framesOf(all);
  };
  const big = await one(() => { const h = Buffer.alloc(14); h[0] = 0x82; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(MAX_DATA_FRAME + 1), 2); return h; });
  assert.equal(big.find(f => f.op === 0x8).payload.readUInt16BE(0), 1009);
  const ctl = await one(() => { const h = Buffer.alloc(4); h[0] = 0x89; h[1] = 0x80 | 126; h.writeUInt16BE(200, 2); return h; });
  assert.equal(ctl.find(f => f.op === 0x8).payload.readUInt16BE(0), 1002);
  const ping = await one(() => maskedFrame(0x9, 'hello'));
  const pong = ping.find(f => f.op === 0xa);
  assert.ok(pong, 'a pong');
  assert.equal(pong.payload.toString(), 'hello');
  assert.ok(await alive());
});

cleanup();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
