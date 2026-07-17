// Minimal dependency-free WebSocket server transport (RFC 6455, server side).
//
// Why this exists: cloudflared (observed on 2026.1.1 quick tunnels) buffers
// streamed HTTP bodies until the response ENDS — SSE headers arrive but zero
// events ever reach the browser through a tunnel. WebSocket upgrades are
// proxied unbuffered end-to-end, so the live-event streams ride WS first and
// keep SSE as the fallback transport.
//
// Scope: server->client text frames only. The browser clients never send
// application data over the socket (input travels over POST); the reader
// exists to honor close and answer protocol pings. No extensions, no
// fragmentation of outgoing messages (our events are far below frame limits).
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | opcode, p.length]);
  else if (p.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(p.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(p.length), 2);
  }
  return Buffer.concat([head, p]);
}

function makeWs(socket) {
  const ws = {
    alive: true,
    onclose: null,
    send(text) {
      if (!ws.alive) return;
      try { socket.write(frame(0x1, text)); } catch { ws.alive = false; }
    },
    close() {
      if (!ws.alive) return;
      ws.alive = false;
      try { socket.end(frame(0x8, Buffer.alloc(0))); } catch { }
    },
  };
  const died = () => {
    if (!ws.alive && !ws.onclose) return;
    ws.alive = false;
    const cb = ws.onclose; ws.onclose = null;
    if (cb) cb();
  };
  // minimal reader with a carry buffer (frames may split across TCP chunks):
  // honor close (0x8), answer ping (0x9) with pong; drop everything else
  let carry = Buffer.alloc(0);
  socket.on('data', chunk => {
    carry = Buffer.concat([carry, chunk]);
    while (carry.length >= 2) {
      const op = carry[0] & 0x0f;
      const masked = carry[1] & 0x80;
      let len = carry[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (carry.length < off + 2) return; len = carry.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (carry.length < off + 8) return; len = Number(carry.readBigUInt64BE(off)); off += 8; }
      const maskOff = off;
      if (masked) off += 4;
      if (carry.length < off + len) return; // incomplete frame: wait for more
      if (op === 0x8) { ws.close(); died(); carry = Buffer.alloc(0); return; }
      if (op === 0x9) {
        let payload = carry.slice(off, off + len);
        if (masked) {
          const mask = carry.slice(maskOff, maskOff + 4);
          payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        }
        try { socket.write(frame(0xa, payload)); } catch { }
      }
      carry = carry.slice(off + len);
    }
  });
  socket.on('error', died);
  socket.on('close', died);
  return ws;
}

// Attach a WS endpoint to an http.Server. authorize(req) runs against the
// upgrade request (cookies/Authorization present as on any request);
// onOpen(ws, req) receives the ready socket.
export function attachWs(server, { path = '/ws', authorize = () => true, onOpen }) {
  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== path || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    if (!authorize(req)) {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch { }
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    onOpen(makeWs(socket), req);
  });
}
