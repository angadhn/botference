// access-fake.mjs — a stand-in for Cloudflare Access: signing keys, tokens, and a local key-list server.
// No real network: the companion is pointed at the key list here (settings key certs_url_for_tests).
import http from 'node:http';
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';

export const TEAM = 'team.example.test';
export const AUD = 'aud-tag-0123456789abcdef';
export const OWNER = 'owner@example.test';
export const ADA = 'ada@example.test';
export const NOBODY = 'stranger@example.test';

const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function makeKey(kid = 'k1') {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, publicKey, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

/** A token as Access would make it; every claim can be overridden (undefined removes it). */
export function mint(key, over = {}, { alg = 'RS256', kid = key.kid, header = {}, now = Date.now() } = {}) {
  const s = Math.floor(now / 1000);
  const claims = { aud: [AUD], email: OWNER, exp: s + 3600, iat: s, nbf: s, iss: `https://${TEAM}`, type: 'app', identity_nonce: 'nonce-1', sub: 'sub-1', ...over };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  const head = b64({ alg, kid, typ: 'JWT', ...header });
  const body = b64(claims);
  let sig;
  if (alg === 'RS256') sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.privateKey).toString('base64url');
  else if (alg === 'HS256') sig = createHmac('sha256', key.publicKey.export({ type: 'spki', format: 'pem' })).update(`${head}.${body}`).digest('base64url');
  else sig = '';
  return `${head}.${body}.${sig}`;
}

/** A key list server. `keys` may be replaced at any time (rotation); `down` makes it answer 500; `delayMs` slows it. */
export function keyServer(keys) {
  const state = { keys, down: false, delayMs: 0, hits: 0 };
  const srv = http.createServer((req, res) => {
    state.hits++;
    setTimeout(() => {
      if (state.down) return res.writeHead(500).end('no');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: state.keys.map(k => k.jwk) }));
    }, state.delayMs);
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
    state.url = `http://127.0.0.1:${srv.address().port}/certs`;
    state.close = () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); });
    resolve(state);
  }));
}
