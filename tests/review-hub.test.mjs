// Review-hub tests: hostname routing, transparent proxy (incl. the offline
// stand-in page), and the gated portal that lists only the papers a login
// validates on (via each paper's own /auth) or is declared on.
//
// The second suite ("hub v2") covers auto-discovery, the owner on/off
// toggles, wake-on-request, owner device approval and default privacy. It
// runs a second hub against a scratch workspace with FAKE botference /
// cloudflared / osascript binaries: no live service, tunnel or paper is
// touched, and every process the fakes start is killed by explicit pid.
//
// Run:  node --test tests/review-hub.test.mjs
import { test, describe, before, after } from 'node:test';
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

// ══ hub v2: discovery, toggles, wake-on-request, device approval ══════
// Everything the hub shells out to is an overridable binary, so the whole
// lifecycle runs against fakes that log their argv:
//   REVIEW_HUB_BOTFERENCE   scaffolds on `review <dir> --setup`, and on
//                           `review <dir> --hosted --service --port N`
//                           stands a stub paper server up on N (pid
//                           recorded so we kill it by pid, never a pattern)
//   REVIEW_HUB_CLOUDFLARED  logs the dns route; fails for bare-*, so the
//                           "surface the command, don't crash" path is real
//   REVIEW_HUB_OSASCRIPT    prints whatever the test put in the answer file
const FAKE_BOTFERENCE = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
mode=$1; shift
if [ "$mode" = "review" ]; then
  dir=$1; shift
  setup=no; port=""; svc=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --setup) setup=yes ;;
      --port) shift; port=$1 ;;
      --service-name) shift; svc=$1 ;;
    esac
    shift
  done
  if [ "$setup" = yes ]; then
    mkdir -p "$dir/review"
    b=$(basename "$dir")
    printf '{"slug":"%s","title":"Scaffolded %s"}\\n' "$b" "$b" > "$dir/review/review.config.json"
    exit 0
  fi
  [ -n "$port" ] || exit 1
  printf 'ENV %s REVIEW_PASSWORD=%s REVIEW_OWNER_PASSWORD=%s CWD=%s\\n' \\
    "$svc" "$REVIEW_PASSWORD" "$REVIEW_OWNER_PASSWORD" "$(pwd)" >> "$FAKE_LOG"
  node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'text/html'});s.end('STUB-$svc')}).listen($port,'127.0.0.1')" >/dev/null 2>&1 &
  printf '%s %s\\n' "$svc" "$!" >> "$FAKE_PIDS"
  sleep 1
  exit 0
fi
if [ "$mode" = "service" ]; then
  name=$2
  pid=$(grep "^$name " "$FAKE_PIDS" | tail -1 | cut -d' ' -f2)
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; sleep 1; exit 0; fi
  echo "Error: no service named '$name' in the ledger." >&2
  exit 1
fi
exit 0
`;
const FAKE_CLOUDFLARED = `#!/bin/sh
printf 'cloudflared %s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *\\ bare-*) echo "failed to add route: record already exists" >&2; exit 1 ;;
esac
exit 0
`;
const FAKE_OSASCRIPT = `#!/bin/sh
printf 'osascript asked\\n' >> "$FAKE_LOG"
[ -f "$FAKE_ANSWER" ] && cat "$FAKE_ANSWER"
exit 0
`;

describe('hub v2 — discovery, toggles, wake-on-request, device approval', () => {
  let hub2, port2, portC, paperC, root, ws, cfgFile, log, pidFile, answerFile, lo;

  const cfgJson = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const logLines = () => {
    try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); }
    catch { return []; }
  };
  const status = async () =>
    JSON.parse((await req(port2, { url: '/status.json', host: 'localhost' })).text);
  const paperOf = (s, slug) => s.papers.find(p => p.slug === slug);
  // the toggles are fire-and-forget (scaffold + build outlast any browser),
  // so tests wait on the job the portal itself polls
  async function settle(slug, want, ms = 25000) {
    const deadline = Date.now() + ms;
    let p;
    while (Date.now() < deadline) {
      p = paperOf(await status(), slug);
      if (p && (!p.job || p.job.done) && (want === undefined || p.running === want)) return p;
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`'${slug}' never settled to running=${want}: ${JSON.stringify(p)}`);
  }
  const project = (name, reviewConfig) => {
    const dir = path.join(ws, 'projects', name);
    fs.mkdirSync(dir, { recursive: true });
    if (reviewConfig) {
      fs.mkdirSync(path.join(dir, 'review'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'review', 'review.config.json'), JSON.stringify(reviewConfig));
    }
    return dir;
  };

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-hub-v2-'));
    ws = path.join(root, 'workspace');
    log = path.join(root, 'exec.log');
    pidFile = path.join(root, 'pids');
    answerFile = path.join(root, 'osascript-answer');
    fs.writeFileSync(log, '');
    fs.writeFileSync(pidFile, '');

    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const write = (name, body) => {
      const p = path.join(bin, name);
      fs.writeFileSync(p, body, { mode: 0o755 });
      return p;
    };
    const fakeBot = write('botference', FAKE_BOTFERENCE);
    const fakeCf = write('cloudflared', FAKE_CLOUDFLARED);
    const fakeOsa = write('osascript', FAKE_OSASCRIPT);

    // one already-published paper (a real gate, so a guest can log in), one
    // scaffolded project the hub has never published, one bare project, and
    // one project whose review slug collides with the explicit entry
    const explicitDir = project('Explicit-Dir', { slug: 'explicit-one', title: 'Explicit One' });
    project('alpha-set', { slug: 'alpha-set', title: 'Alpha Set' });
    project('bare-project', null);
    project('dupe-slug', { slug: 'explicit-one', title: 'Impostor' });

    [port2, portC] = [await freePort(), await freePort()];
    paperC = await fakePaper(portC, 'pw-c', 'PAPER-C');
    lo = await freePort();  // base of the hub's auto-assign range

    cfgFile = path.join(root, 'hub.json');
    fs.writeFileSync(cfgFile, JSON.stringify({
      port: port2, host: 'review.example.com', name: 'V2 portal',
      workspace: ws, portRange: [lo, lo + 30],
      papers: [{
        slug: 'explicit-one', host: 'explicit-one.example.com', port: portC,
        dir: explicitDir, title: 'Explicit One', collaborators: ['ada'],
      }],
    }, null, 2));

    hub2 = spawn(process.execPath, [HUB], {
      env: {
        ...process.env, REVIEW_HUB_CONFIG: cfgFile, PORT: String(port2),
        REVIEW_HUB_PASSWORD: 'v2-owner-pw', REVIEW_HUB_TUNNEL: 'review',
        REVIEW_HUB_BOTFERENCE: fakeBot, REVIEW_HUB_CLOUDFLARED: fakeCf,
        REVIEW_HUB_OSASCRIPT: fakeOsa,
        FAKE_LOG: log, FAKE_PIDS: pidFile, FAKE_ANSWER: answerFile,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      hub2.stdout.on('data', d => { if (String(d).includes('review hub on')) resolve(); });
      hub2.on('exit', c => reject(new Error(`hub2 exited ${c}`)));
      setTimeout(() => reject(new Error('hub2 start timeout')), 8000).unref();
    });
  });

  after(() => {
    hub2 && hub2.kill();
    paperC && paperC.close();
    // every stub server the fake launcher started, by explicit pid only
    let lines = [];
    try { lines = fs.readFileSync(pidFile, 'utf8').split('\n'); } catch { }
    for (const line of lines) {
      const pid = Number(String(line).split(' ')[1]);
      if (pid > 1) { try { process.kill(pid); } catch { } }
    }
  });

  test('discovery: every project in the workspace is a candidate, explicit config wins', async () => {
    const s = await status();
    const slugs = s.papers.map(p => p.slug);
    assert.equal(slugs.filter(x => x === 'explicit-one').length, 1, 'no duplicate for the explicit entry');
    assert.ok(slugs.includes('alpha-set'));
    assert.ok(slugs.includes('bare-project'));
    assert.ok(!slugs.includes('dupe-slug'), 'a scan hit that collides on slug folds into the config entry');

    const explicit = paperOf(s, 'explicit-one');
    assert.equal(explicit.explicit, true);
    assert.equal(explicit.title, 'Explicit One');   // config title, not the scan's
    assert.equal(explicit.enabled, true);
    assert.equal(explicit.running, true);

    const alpha = paperOf(s, 'alpha-set');
    assert.equal(alpha.scaffolded, true);           // has review/review.config.json
    assert.equal(alpha.enabled, false);             // but was never published
    assert.equal(alpha.title, 'Alpha Set');

    const bare = paperOf(s, 'bare-project');
    assert.equal(bare.scaffolded, false);           // not set up yet
    assert.equal(bare.enabled, false);
  });

  test('owner portal shows running, stopped and not-set-up alike, each with a toggle', async () => {
    const r = await req(port2, { host: 'localhost' });
    assert.equal(r.status, 200);
    assert.match(r.text, /owner view/);
    assert.match(r.text, /Explicit One/);
    assert.match(r.text, /Alpha Set/);
    assert.match(r.text, /bare-project/);
    assert.match(r.text, /not set up yet/);
    assert.match(r.text, /action="\/toggle"/);
    assert.match(r.text, /turn on/);
    assert.match(r.text, /turn off/);
  });

  test('toggle on: assigns a port, routes DNS, starts the service, persists the entry', async () => {
    const before = logLines().length;
    const post = await req(port2, {
      method: 'POST', url: '/toggle', host: 'localhost',
      body: new URLSearchParams({ slug: 'alpha-set', action: 'on' }).toString(),
    });
    assert.equal(post.status, 303);
    const p = await settle('alpha-set', true);

    assert.equal(p.running, true);
    assert.equal(p.enabled, true);
    assert.equal(p.host, 'alpha-set.example.com');   // <slug>.<hub's parent domain>
    assert.ok(p.port >= lo && p.port <= lo + 30, `assigned port ${p.port} is inside the range`);
    assert.notEqual(p.port, portC);                  // never an already-taken port
    assert.equal(p.job.error, '');

    const fresh = logLines().slice(before);
    assert.ok(fresh.some(l => l === 'cloudflared tunnel route dns review alpha-set.example.com'),
      `dns route not requested: ${JSON.stringify(fresh)}`);
    assert.ok(fresh.some(l =>
      l.includes('review') && l.includes('--hosted') && l.includes('--service')
      && l.includes(`--port ${p.port}`) && l.includes('--service-name review-alpha-set')),
      `hosted service not started: ${JSON.stringify(fresh)}`);
    const env = fresh.find(l => l.startsWith('ENV review-alpha-set'));
    assert.ok(env, 'the service did not run with an env');
    assert.match(env, /REVIEW_PASSWORD=[0-9a-f]{8,}/);        // generated guest password
    assert.match(env, /REVIEW_OWNER_PASSWORD=v2-owner-pw/);   // hub's owner secret
    assert.match(env, /CWD=.*alpha-set/);                     // ledger scoped to the paper

    // persisted so a hub restart keeps the slug, host and port
    const entry = cfgJson().papers.find(x => x.slug === 'alpha-set');
    assert.ok(entry, 'the paper was not written into the hub config');
    assert.equal(entry.port, p.port);
    assert.equal(entry.host, 'alpha-set.example.com');
    assert.match(entry.dir, /alpha-set$/);
  });

  test('default privacy: a new paper has no collaborators and no secret in the config', async () => {
    const entry = cfgJson().papers.find(x => x.slug === 'alpha-set');
    assert.deepEqual(entry.collaborators, [], 'nobody is declared on a fresh paper');
    assert.ok(!('password' in entry) && !('secret' in entry), 'no secret in the config');

    // the generated password lives in a 0600 file beside the config
    const secretsFile = path.join(root, 'review-paper-secrets.json');
    const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
    assert.match(secrets.papers['alpha-set'], /^[0-9a-f]{16}$/);
    assert.equal(fs.statSync(secretsFile).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(cfgJson()).includes(secrets.papers['alpha-set']));

    // and a guest with a different paper's password sees nothing of it
    const login = await req(port2, {
      method: 'POST', url: '/auth', host: 'review.example.com', ip: '198.51.100.21',
      body: new URLSearchParams({ handle: 'ada', password: 'pw-c' }).toString(),
    });
    assert.equal(login.status, 303);
    const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];
    const list = await req(port2, { host: 'review.example.com', ip: '198.51.100.21', cookie });
    assert.match(list.text, /Explicit One/);
    assert.doesNotMatch(list.text, /Alpha Set/, 'a private paper is invisible to a guest');
  });

  test('toggle on a project never set up: scaffolds first, survives a DNS failure', async () => {
    const before = logLines().length;
    const post = await req(port2, {
      method: 'POST', url: '/toggle', host: 'localhost',
      body: new URLSearchParams({ slug: 'bare-project', action: 'on' }).toString(),
    });
    assert.equal(post.status, 303);
    const p = await settle('bare-project', true);

    const fresh = logLines().slice(before);
    assert.ok(fresh.some(l => l.includes('review') && l.includes('--setup')), 'scaffold was not run');
    assert.equal(p.scaffolded, true);
    assert.equal(p.running, true, 'a failed DNS route must not stop the paper coming up');
    assert.equal(p.job.error, '', 'a failed DNS route is not an error');
    assert.ok(p.job.notes.some(n => n.includes('cloudflared tunnel route dns review bare-project.example.com')),
      `the exact command was not surfaced: ${JSON.stringify(p.job.notes)}`);

    const r = await req(port2, { host: 'localhost' });
    assert.match(r.text, /cloudflared tunnel route dns review bare-project\.example\.com/);
  });

  test('toggle off stops the paper by its ledger entry, never by pattern', async () => {
    const before = logLines().length;
    const post = await req(port2, {
      method: 'POST', url: '/toggle', host: 'localhost',
      body: new URLSearchParams({ slug: 'bare-project', action: 'off' }).toString(),
    });
    assert.equal(post.status, 303);
    const p = await settle('bare-project', false);
    assert.equal(p.running, false);
    assert.equal(p.enabled, true, 'the entry stays so the friendly offline page keeps serving');

    const fresh = logLines().slice(before);
    assert.ok(fresh.some(l => l === 'service stop review-bare-project'),
      `stop did not go through the service ledger: ${JSON.stringify(fresh)}`);
    assert.ok(!fresh.some(l => /pkill|killall/.test(l)), 'no pattern kill, ever');
  });

  test('toggles and status are owner-only', async () => {
    const login = await req(port2, {
      method: 'POST', url: '/auth', host: 'review.example.com', ip: '198.51.100.22',
      body: new URLSearchParams({ handle: 'ada', password: 'pw-c' }).toString(),
    });
    const cookie = (login.headers['set-cookie'] || [])[0].split(';')[0];
    const toggle = await req(port2, {
      method: 'POST', url: '/toggle', host: 'review.example.com', ip: '198.51.100.22', cookie,
      body: new URLSearchParams({ slug: 'alpha-set', action: 'off' }).toString(),
    });
    assert.equal(toggle.status, 403);
    const s = await req(port2, { url: '/status.json', host: 'review.example.com', ip: '198.51.100.22', cookie });
    assert.equal(s.status, 403);
    // and nothing happened
    assert.equal(paperOf(await status(), 'alpha-set').running, true);
  });

  test('wake-on-request: a guest gets the offline page, the owner gets a start', async () => {
    // stop it the sanctioned way, then knock on its hostname
    await req(port2, {
      method: 'POST', url: '/toggle', host: 'localhost',
      body: new URLSearchParams({ slug: 'bare-project', action: 'off' }).toString(),
    });
    await settle('bare-project', false);

    const guest = await req(port2, { host: 'bare-project.example.com', ip: '198.51.100.30' });
    assert.equal(guest.status, 503);
    assert.match(guest.text, /offline/);
    assert.doesNotMatch(guest.text, /Starting this review/, 'guests never start a paper');
    assert.equal(paperOf(await status(), 'bare-project').running, false);

    const login = await req(port2, {
      method: 'POST', url: '/auth', host: 'review.example.com', ip: '198.51.100.31',
      body: new URLSearchParams({ handle: 'boss', password: 'v2-owner-pw' }).toString(),
    });
    const owner = (login.headers['set-cookie'] || [])[0].split(';')[0];
    const woken = await req(port2, { host: 'bare-project.example.com', ip: '198.51.100.31', cookie: owner });
    assert.equal(woken.status, 503);
    assert.match(woken.text, /Starting this review/);
    assert.match(woken.text, /http-equiv="refresh"/);   // the page brings itself back
    await settle('bare-project', true);

    const back = await req(port2, { host: 'bare-project.example.com', ip: '198.51.100.31', cookie: owner });
    assert.equal(back.status, 200);
    assert.match(back.text, /STUB-review-bare-project/);
  });

  test('device approval: a new device waits, the owner approves, it is the owner for a year', async () => {
    fs.writeFileSync(answerFile, 'button returned:Approve, gave up:false\n');
    const before = logLines().length;
    const ask = await req(port2, { url: '/device/request', host: 'review.example.com', ip: '198.51.100.40' });
    assert.equal(ask.status, 200);
    assert.match(ask.text, /Waiting for approval/);
    assert.match(ask.text, /\/device\/wait\?id=/);
    // the dialog is fired without blocking the response, so give it a beat
    let asked = false;
    for (let i = 0; i < 60 && !asked; i++) {
      asked = logLines().slice(before).some(l => l === 'osascript asked');
      if (!asked) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(asked, 'the machine was never asked');

    const id = /\/device\/wait\?id=([0-9a-f]+)/.exec(ask.text)[1];
    let approved;
    for (let i = 0; i < 60; i++) {
      approved = await req(port2, { url: `/device/wait?id=${id}`, host: 'review.example.com', ip: '198.51.100.40' });
      if (approved.status === 303) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(approved.status, 303);
    const set = (approved.headers['set-cookie'] || [])[0];
    assert.match(set, /^hub_device=/);
    assert.match(set, /Domain=example\.com/);          // works on the paper subdomains too
    assert.match(set, /HttpOnly/);
    assert.ok(Number(/Max-Age=(\d+)/.exec(set)[1]) >= 300 * 24 * 3600, 'a long-lived device cookie');

    // no password anywhere in this flow — the cookie alone is owner
    const dev = set.split(';')[0];
    const r = await req(port2, { host: 'review.example.com', ip: '198.51.100.40', cookie: dev });
    assert.equal(r.status, 200);
    assert.match(r.text, /owner view/);
    assert.match(r.text, /action="\/toggle"/);
  });

  test('device approval: a denied device is told so, and stays a stranger', async () => {
    fs.writeFileSync(answerFile, 'button returned:Deny, gave up:false\n');
    const ask = await req(port2, { url: '/device/request', host: 'review.example.com', ip: '198.51.100.41' });
    const id = /\/device\/wait\?id=([0-9a-f]+)/.exec(ask.text)[1];
    let out;
    for (let i = 0; i < 60; i++) {
      out = await req(port2, { url: `/device/wait?id=${id}`, host: 'review.example.com', ip: '198.51.100.41' });
      if (/Not approved/.test(out.text)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.match(out.text, /Not approved/);
    assert.ok(!(out.headers['set-cookie'] || []).some(c => c.startsWith('hub_device=')));
    const still = await req(port2, { host: 'review.example.com', ip: '198.51.100.41' });
    assert.equal(still.status, 401);
  });

  test('device approval: expired ids get a clear message, forged cookies get nothing', async () => {
    const gone = await req(port2, { url: '/device/wait?id=deadbeef', host: 'review.example.com', ip: '198.51.100.42' });
    assert.equal(gone.status, 403);
    assert.match(gone.text, /Approval expired/);

    const forged = `hub_device=${encodeURIComponent(`${Date.now() + 1e9}.abcdef.${'0'.repeat(64)}`)}`;
    const r = await req(port2, { host: 'review.example.com', ip: '198.51.100.43', cookie: forged });
    assert.equal(r.status, 401);
    assert.match(r.text, /Sign in to see the reviews/);
    assert.match(r.text, /ask the owner to approve/);  // the way in is offered on the gate
  });
});
