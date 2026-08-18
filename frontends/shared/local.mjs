// "Did this request arrive on this machine, or through the tunnel?" — the one
// test every frontend needs before it will accept a secret.
//
// It lived in the plugin's hosted.mjs first (which still re-exports it, so the
// companion's owner model reads exactly as it did); the council web server
// needs the identical test for the identical reason, and a second copy of a
// security boundary is a second thing to get wrong.

// Headers no browser on this machine ever sends, and that every reverse proxy
// in front of us does — cloudflared included. Their presence is proof the
// request was forwarded, whatever the socket or the Host line claims.
export const PROXY_HEADERS = [
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cf-worker',
  'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip',
];

// A request that arrived directly on the loopback interface — NOT through the
// tunnel. This is the whole owner/guest boundary, so it is deliberately three
// independent tests, ALL of which must pass:
//
//   1. Host names this machine. A named tunnel (discuss.botference.com) carries
//      its public hostname here, because cloudflared forwards Host unchanged.
//   2. No proxy headers. cloudflared's own hop to the server also comes from
//      127.0.0.1, so the socket alone cannot tell tunnel traffic apart — but
//      the Cloudflare edge stamps CF-Connecting-IP/CF-Ray and cloudflared adds
//      X-Forwarded-*, and neither can be suppressed by a visitor. This is the
//      test that still holds if the tunnel is ever configured with
//      httpHostHeader (which would rewrite Host to localhost).
//   3. The peer really is loopback, so a LAN client cannot claim to be local.
//
// It fails closed in both directions: no test can be satisfied from outside,
// and the worst a false negative does is refuse to take a key from a browser
// that is standing right next to the disk it would be written to.
export function isLocalDirect(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
  for (const h of PROXY_HEADERS) if (req.headers[h]) return false;
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}
