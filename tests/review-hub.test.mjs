// Review-hub tests: hostname routing, transparent proxy (incl. the offline
// stand-in page), and the gated portal that lists only the papers a login
// validates on (via each paper's own /auth) or is declared on.
//
// Run:  node --test tests/review-hub.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(HOME, 'frontends', 'review', 'hub.mjs');

function freePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// raw request against the hub with full control of the Host header (the hub
// routes on it); remote callers are simulated with tunnel headers, exactly
// like real cloudflared traffic arriving on the loopback hop
function req(port, { method = 'GET', url = '/', host, ip, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: host || 'localhost' };
    if (ip) { headers['cf-connecting-ip'] = ip; headers['cf-ray'] = 'test'; }
    if (cookie) headers.cookie = cookie;
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end(body || undefined);
  });
}

// a fake paper server: gate semantics of frontends/review/server.mjs /auth
// (303 + cookie on the right password, 401 otherwise), and an index that
// echoes the forwarded client IP so header pass-through is observable
function fakePaper(port, password, tag) {
  return new Promise(resolve => {
    const srv = http.createServer((rq, rs) => {
      if (rq.method === 'POST' && rq.url === '/auth') {
        let b = '';
        rq.on('data', c => b += c);
        rq.on('end', () => {
          const form = new URLSearchParams(b);
          if (form.get('password') === password) {
            rs.writeHead(303, { 'set-cookie': 'review_auth=x; Path=/', location: '/' }).end();
          } else rs.writeHead(401, { 'content-type': 'text/html' }).end('wrong');
        });
        return;
      }
      rs.writeHead(200, { 'content-type': 'text/html' })
        .end(`${tag} ip=${rq.headers['cf-connecting-ip'] || ''} host=${rq.headers.host || ''}`);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

let hub, hubPort, portA, portB, portDead, paperA, paperB;

before(async () => {
  [hubPort, portA, portB, portDead] = [await freePort(), await freePort(), await freePort(), await freePort()];
  paperA = await fakePaper(portA, 'pw-a', 'PAPER-A');
  paperB = await fakePaper(portB, 'pw-b', 'PAPER-B');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hub-'));
  const cfg = path.join(dir, 'hub.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: hubPort, host: 'review.example.com', name: 'Test portal',
    papers: [
      { slug: 'alpha', host: 'alpha.example.com', port: portA, title: 'Paper Alpha' },
      { slug: 'beta', host: 'beta.example.com', port: portB, title: 'Paper Beta' },
      { slug: 'ghost', host: 'ghost.example.com', port: portDead, title: 'Paper Ghost',
        repo: 'https://example.com/ghost.git', collaborators: ['ada'] },
    ],
  }));
  hub = spawn(process.execPath, [HUB], {
    env: { ...process.env, REVIEW_HUB_CONFIG: cfg, PORT: String(hubPort), REVIEW_HUB_PASSWORD: 'hub-owner-pw' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    hub.stdout.on('data', d => { if (String(d).includes('review hub on')) resolve(); });
    hub.on('exit', c => reject(new Error(`hub exited ${c}`)));
    setTimeout(() => reject(new Error('hub start timeout')), 8000).unref();
  });
});

after(() => {
  hub && hub.kill();
  paperA && paperA.close();
  paperB && paperB.close();
});

test('paper hostname proxies to its server, headers passing through', async () => {
  const r = await req(hubPort, { host: 'alpha.example.com', ip: '203.0.113.9' });
  assert.equal(r.status, 200);
  assert.match(r.text, /PAPER-A/);
  assert.match(r.text, /ip=203\.0\.113\.9/);        // tunnel headers survive the hop
  assert.match(r.text, /host=alpha\.example\.com/); // so the paper never mistakes a guest for localhost
});

test('offline paper hostname serves the work-from-the-repo page, not a bare 502', async () => {
  const r = await req(hubPort, { host: 'ghost.example.com', ip: '203.0.113.9' });
  assert.equal(r.status, 503);
  assert.match(r.text, /offline/);
  assert.match(r.text, /git repository/);
  assert.match(r.text, /https:\/\/example\.com\/ghost\.git/);
});

test('unknown hostname gets a plain 404', async () => {
  const r = await req(hubPort, { host: 'nothing.example.com', ip: '203.0.113.9' });
  assert.equal(r.status, 404);
  assert.match(r.text, /No review here/);
});

test('portal: remote visitors are gated', async () => {
  const r = await req(hubPort, { host: 'review.example.com', ip: '203.0.113.9' });
  assert.equal(r.status, 401);
  assert.match(r.text, /Sign in to see the reviews/);
});

test('portal: a wrong password matches nothing', async () => {
  const r = await req(hubPort, {
    method: 'POST', url: '/auth', host: 'review.example.com', ip: '203.0.113.10',
    body: new URLSearchParams({ handle: 'eve', password: 'nope', next: '/' }).toString(),
  });
  assert.equal(r.status, 401);
  assert.match(r.text, /no review here matches/);
});

test('portal: login lists exactly the papers that password opens', async () => {
  const login = await req(hubPort, {
    method: 'POST', url: '/auth', host: 'review.example.com', ip: '203.0.113.11',
    body: new URLSearchParams({ handle: 'bob', password: 'pw-a', next: '/' }).toString(),
  });
  assert.equal(login.status, 303);
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];
  assert.match(cookie, /^hub_auth=/);
  const r = await req(hubPort, { host: 'review.example.com', ip: '203.0.113.11', cookie });
  assert.equal(r.status, 200);
  assert.match(r.text, /signed in as <b>bob<\/b>/);
  assert.match(r.text, /Paper Alpha/);
  assert.doesNotMatch(r.text, /Paper Beta/);  // different password — invisible
  assert.doesNotMatch(r.text, /Paper Ghost/); // not declared on it — invisible
});

test('portal: a declared collaborator sees their paper even while it is offline', async () => {
  // ada is in ghost's collaborators; ghost's server is down so no password can
  // validate there — the declaration alone lists it, marked offline
  const login = await req(hubPort, {
    method: 'POST', url: '/auth', host: 'review.example.com', ip: '203.0.113.12',
    body: new URLSearchParams({ handle: 'ada', password: 'pw-b', next: '/' }).toString(),
  });
  assert.equal(login.status, 303);
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];
  const r = await req(hubPort, { host: 'review.example.com', ip: '203.0.113.12', cookie });
  assert.match(r.text, /Paper Beta/);
  assert.match(r.text, /Paper Ghost/);
  assert.match(r.text, /offline \(work from the git repo/);
  assert.doesNotMatch(r.text, /Paper Alpha/);
});

test('portal: localhost is the owner — no login, every paper listed', async () => {
  const r = await req(hubPort, { host: 'localhost' });
  assert.equal(r.status, 200);
  assert.match(r.text, /owner view/);
  assert.match(r.text, /Paper Alpha/);
  assert.match(r.text, /Paper Beta/);
  assert.match(r.text, /Paper Ghost/);
  assert.match(r.text, new RegExp(`localhost:${portA}`)); // owner gets direct links
});

test('portal: the hub owner password opens the full list from any device', async () => {
  const login = await req(hubPort, {
    method: 'POST', url: '/auth', host: 'review.example.com', ip: '203.0.113.13',
    body: new URLSearchParams({ handle: 'boss', password: 'hub-owner-pw', next: '/' }).toString(),
  });
  assert.equal(login.status, 303);
  const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];
  const r = await req(hubPort, { host: 'review.example.com', ip: '203.0.113.13', cookie });
  assert.equal(r.status, 200);
  assert.match(r.text, /owner view/);
  assert.match(r.text, /Paper Alpha/);
  assert.match(r.text, /Paper Beta/);
  assert.match(r.text, /Paper Ghost/);
  assert.match(r.text, /sign out/);                       // remote sessions can sign out
  assert.doesNotMatch(r.text, /href="http:\/\/localhost/); // no dead localhost links on a phone
});

test('portal: login attempts are rate limited per client IP', async () => {
  let last;
  for (let i = 0; i < 20; i++) {
    last = await req(hubPort, {
      method: 'POST', url: '/auth', host: 'review.example.com', ip: '203.0.113.66',
      body: new URLSearchParams({ handle: 'mallory', password: 'x', next: '/' }).toString(),
    });
  }
  assert.equal(last.status, 429);
  assert.match(last.text, /too many attempts/);
});
