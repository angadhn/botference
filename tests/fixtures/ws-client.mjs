// Minimal raw WebSocket client for tests (node has no built-in WS client):
// handshake + unfragmented text-frame reader, enough to assert that servers
// speak RFC 6455 and deliver JSON events. Supports TLS for through-tunnel
// verification (wss on 443).
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export function wsConnect({ host, port, path = '/ws', headers = {}, secure = false, timeout = 8000 }) {
  return new Promise((resolve, reject) => {
    const sock = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('ws connect timeout')); }, timeout);
    const key = crypto.randomBytes(16).toString('base64');
    const events = [];        // parsed JSON payloads of text frames, in order
    const waiting = [];
    let handshook = false;
    let head = '';
    let carry = Buffer.alloc(0);
    const conn = {
      events,
      statusLine: '',
      close() { sock.destroy(); },
      // resolve with the first event matching pred (scans past + future events)
      next(pred = () => true, waitMs = 5000) {
        return new Promise((res, rej) => {
          const scan = () => {
            const hit = events.find(pred);
            if (hit) { res(hit); return true; }
            return false;
          };
          if (scan()) return;
          const t = setTimeout(() =>
            rej(new Error('ws next() timeout; saw: ' + events.map(e => e && e.type).join(','))), waitMs);
          waiting.push(() => scan() && (clearTimeout(t), true));
        });
      },
    };
    const start = () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
    };
    sock.on(secure ? 'secureConnect' : 'connect', start);
    sock.on('error', err => { clearTimeout(timer); reject(err); });
    sock.on('data', chunk => {
      if (!handshook) {
        head += chunk.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        conn.statusLine = head.slice(0, head.indexOf('\r\n'));
        if (!/ 101 /.test(conn.statusLine)) {
          clearTimeout(timer); sock.destroy();
          reject(new Error('no upgrade: ' + conn.statusLine));
          return;
        }
        handshook = true;
        clearTimeout(timer);
        carry = Buffer.from(head.slice(end + 4), 'latin1');
        head = '';
        resolve(conn);
        chunk = Buffer.alloc(0);
      }
      carry = Buffer.concat([carry, chunk]);
      // server->client frames are unmasked; unfragmented text frames only
      while (carry.length >= 2) {
        const op = carry[0] & 0x0f;
        let len = carry[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (carry.length < 4) return; len = carry.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (carry.length < 10) return; len = Number(carry.readBigUInt64BE(2)); off = 10; }
        if (carry.length < off + len) return;
        if (op === 0x1) {
          try { events.push(JSON.parse(carry.slice(off, off + len).toString('utf8'))); } catch { }
          for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i]()) waiting.splice(i, 1);
        }
        carry = carry.slice(off + len);
      }
    });
  });
}
