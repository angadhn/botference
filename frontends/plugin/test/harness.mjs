// harness.mjs — the scaffolding nine suites had a private copy of.
//
// Every server-driving suite in this tree needs the same five things: a tiny
// test runner, a poller, a throwaway root, a companion started on a random
// port, and JSON over HTTP. Each of them wrote all five out. The `test(name,
// fn)` runner was byte-identical in nine files; the SSE `listen()` helper was
// byte-identical in four sites (twice inside one file); `startServer`,
// `request`, `tmp` and `bridgeLog` were near-identical everywhere. About six
// hundred lines of it, and — the part that actually cost something — nine
// chances for the boot sequence to drift apart without anyone seeing the nine
// side by side, because until test/run-all.mjs existed nothing ran them
// together.
//
// The differences that were REAL are kept, as arguments:
//
//   · the waitFor timeout. parallel.test.mjs drives a three-lane pool and
//     genuinely needs longer; companion.test.mjs deliberately runs shorter.
//     `createHarness({ waitMs })`.
//   · the temp-directory tag, so a leftover directory says which suite left it.
//   · realpath on the root. macOS hands out /var/folders which is really
//     /private/var/folders, and blog.mjs and workspace.mjs resolve both sides
//     of every path comparison — so a suite about paths MUST have the resolved
//     one. `createHarness({ realpath: true })`.
//   · whatever extra env a suite's servers all want (PLUGIN_BRIDGE_POOL: '1'
//     throughout companion.test.mjs, for instance).
//
// Nothing here decides anything about a test. It starts processes, makes
// requests and cleans up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const enc = encodeURIComponent;

// The mock bridge's log, as objects. `inputs` is the one question almost every
// assertion about a turn asks: what text reached the child, in what order.
export const bridgeLog = file => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : []);
export const inputs = file => bridgeLog(file).filter(e => e.type === 'input').map(e => String(e.text));

/**
 * An open /events stream, collecting what the companion broadcasts.
 *
 * `seen` is every frame so far, `of(type)` the ones of one kind, `close()` ends
 * it — and a suite that forgets to close one leaves node's event loop alive, so
 * close it.
 */
export function listen(base) {
  const seen = [];
  const req = http.request(base + '/events', { method: 'GET' }, res => {
    let buf = '';
    res.on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(frame);
        if (!m) continue;
        try { seen.push(JSON.parse(m[1])); } catch { }
      }
    });
  });
  req.end();
  return { seen, close: () => req.destroy(), of: t => seen.filter(e => e.type === t) };
}

/** What a browser sends back on the next request after a Set-Cookie. */
export const cookieJar = res =>
  (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

/**
 * One request. JSON in and JSON out by default; `raw` sends a form-encoded body
 * instead, which is what the reading room's own composers post.
 *
 * Answers `{ status, headers, json, body }` — `json` is null for a body that is
 * not JSON, which is a normal answer here (an HTML page, a redirect) and not an
 * error.
 */
export function request(base, method, urlPath, body, headers = {}, raw = null) {
  return new Promise((resolve, reject) => {
    const data = raw !== null ? raw : (body === undefined ? null : JSON.stringify(body));
    const type = raw !== null ? 'application/x-www-form-urlencoded' : 'application/json';
    const req = http.request(base + urlPath, {
      method,
      headers: {
        ...(data === null ? {} : { 'content-type': type, 'content-length': Buffer.byteLength(data) }),
        ...headers,
      },
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch { }
        resolve({ status: res.statusCode, headers: res.headers, json, body: buf });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** The same GET keeping the BYTES: a favicon is a png, and a png read as utf-8 is a different file. */
export function getBytes(base, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + urlPath, { headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
  });
}

export const GET = (b, p, h) => request(b, 'GET', p, undefined, h);
export const POST = (b, p, body, h) => request(b, 'POST', p, body || {}, h);
export const FORM = (b, p, fields, h) =>
  request(b, 'POST', p, undefined, h, new URLSearchParams(fields).toString());

/**
 * The per-suite half: a runner that counts, a poller with this suite's own
 * patience, throwaway directories tagged with this suite's name, and a
 * `startServer` that knows where server.mjs is and which secrets directory to
 * keep the developer's real one out of reach behind.
 *
 * `tag` names the temp directories. `waitMs` is this suite's default patience.
 * `realpath` resolves the temp root's symlinks (mandatory for any suite about
 * paths). `env` is merged into every server this suite starts.
 */
export function createHarness({ server, tag = 'bfp', waitMs = 10000, realpath = false, env: baseEnv = {} } = {}) {
  let passed = 0;
  const failures = [];

  async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
  }

  async function waitFor(pred, what, ms = waitMs) {
    const t0 = Date.now();
    for (;;) {
      const v = await pred();   // predicates may be async (a fetch, a file read)
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  const tmps = [];
  function tmp(name) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-${tag}-${name}-`));
    tmps.push(d);
    return realpath ? fs.realpathSync(d) : d;
  }

  // Every server this suite starts gets a throwaway secrets directory. The
  // owner credential is deliberately SHARED with the review hub's
  // (~/.botference/review-paper-secrets.json, identity.mjs), and a test must
  // never read — let alone generate into — the developer's real one.
  const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), `bfp-${tag}-secrets-`));
  const spawned = [];

  function startServer({ root, args = [], env = {} }) {
    const proc = spawn(process.execPath, [server, ...args], {
      env: {
        ...process.env, PORT: '0', BOTFERENCE_PROJECT_ROOT: root,
        BOTFERENCE_SECRETS_DIR: SECRETS, PLUGIN_OWNER_PASSWORD: '', REVIEW_HUB_PASSWORD: '',
        ...baseEnv, ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(proc);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    return waitFor(() => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      return m ? `http://127.0.0.1:${m[1]}` : null;
    }, `server on ${root} to listen (got: ${out.slice(0, 300)})`)
      .then(base => ({ proc, base, out: () => out }));
  }

  /** Kill every child and remove every temp directory this suite made. */
  function cleanup() {
    for (const p of spawned) { try { p.kill(); } catch { } }
    for (const d of [...tmps, SECRETS]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { }
    }
  }

  return {
    test, waitFor, tmp, startServer, cleanup, spawned, tmps, SECRETS,
    passed: () => passed,
    failures: () => failures,
  };
}
