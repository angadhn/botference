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

// What a browser may send us. The clients never send application data (input travels over POST): all that is expected is a close and
// a ping, control frames of at most 125 bytes. A data frame is read and dropped, so it gets a modest cap rather than none: a frame
// announcing more is refused (close code 1009, "message too big") without ever being buffered, and a control frame over 125 bytes is
// a protocol error (1002). Frame sizes are compared as BigInt: an announced 2^64 is not a number to wait for.
export const MAX_DATA_FRAME = 64 * 1024;
export const MAX_CONTROL_FRAME = 125;
export const CLOSE_CODES = Object.freeze({ protocol: 1002, tooBig: 1009 });

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
  // close with a status code (RFC 6455 7.4): the frame carries it as two bytes
  const closeWith = (code) => {
    if (ws.alive) {
      ws.alive = false;
      const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
      try { socket.end(frame(0x8, p)); } catch { }
    }
    carry = Buffer.alloc(0);
    died();
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
    if (!ws.alive && !ws.onclose) return; // closed: nothing more is read
    carry = Buffer.concat([carry, chunk]);
    while (carry.length >= 2) {
      const op = carry[0] & 0x0f;
      const masked = carry[1] & 0x80;
      let len = carry[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (carry.length < off + 2) return; len = carry.readUInt16BE(off); off += 2; }
      else if (len === 127) {
        if (carry.length < off + 8) return;
        const big = carry.readBigUInt64BE(off); off += 8;
        if (big > BigInt(MAX_DATA_FRAME)) return closeWith(CLOSE_CODES.tooBig);
        len = Number(big);
      }
      // refused as soon as the header says so, before any of the payload is waited for
      if (op >= 0x8 ? len > MAX_CONTROL_FRAME : len > MAX_DATA_FRAME) return closeWith(op >= 0x8 ? CLOSE_CODES.protocol : CLOSE_CODES.tooBig);
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
    // An exception here is not caught by anything above it: it would end the whole process. A reset socket also raises 'error' on
    // the socket itself. So: an error listener first, and the whole upgrade inside a try; anything that throws ends THIS socket only.
    socket.on('error', () => { });
    try { upgrade(req, socket); } catch { try { socket.destroy(); } catch { } }
  });
  function upgrade(req, socket) {
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
  }
}
