// access-files-browser.test.mjs — a REAL browser opens a hostile file the companion serves, with the person's Access sign-in attached.
//
//   node test/access-files-browser.test.mjs        (skipped, with a message, when no Chrome or Brave is found; set BFP_TEST_BROWSER)
//
// A file a bot or a site's sources put in work/ is served by the companion (GET /files/). Headless Brave/Chrome opens it at the companion's
// own address (a name mapped to the loopback; no other name resolves: no network) with the assertion header Cloudflare would attach to every
// request the browser makes, and the script in it tries to read the page, the cookies, the companion's API and to POST as the person.
//   · served as the companion serves it (CSP sandbox, nosniff): the script does not run at all, and nothing is created;
//   · the same bytes WITHOUT the sandbox (the control) do run: so the test would notice if the sandbox went away;
//   · the same bytes in an opaque origin that may run scripts (`sandbox allow-scripts`, no same-origin): the script runs but cannot read
//     the companion's answers or cookies, and its POST (Origin: null) is refused and creates nothing.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHarness, request, GET, sleep } from './harness.mjs';
import { makeKey, mint, keyServer, TEAM, AUD, OWNER, EXT_ID } from './access-fake.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const BROWSER = [process.env.BFP_TEST_BROWSER, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .filter(Boolean).find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || '';
if (!BROWSER) { console.log('skipped: no Chrome or Brave found (set BFP_TEST_BROWSER)'); process.exit(0); }
const WebSocket = createRequire(path.join(TEST, '..', '..', '..', 'tests', 'x.js'))('ws');

const NAME = 'annotations.example.test';
const key = makeKey('k1'); const keys = await keyServer([key]);
const h = createHarness({ server: SERVER, tag: 'brw', waitMs: 20000, env: { PLUGIN_ACCESS_TEST_CERTS: '1', PLUGIN_PUBLIC_HOSTNAMES: NAME } });
fs.writeFileSync(path.join(h.SECRETS, 'plugin-access.json'), JSON.stringify({ hosted_auth: 'access', team: TEAM, aud: AUD, owner_email: OWNER, extension_ids: [EXT_ID], certs_url_for_tests: keys.url }));
const root = h.tmp('root'); fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const ATTACK = `<!doctype html><html><body>no</body><script>
(async () => {
  const out = { ran: true, cookie: null, read: null, post: null };
  try { out.cookie = document.cookie; } catch (e) { out.cookie = 'blocked: ' + e.name; }
  try { out.read = (await (await fetch('/health')).text()).slice(0, 40); } catch (e) { out.read = 'blocked: ' + e.name; }
  try { out.post = (await fetch('http://${NAME}/page', { method: 'POST', body: JSON.stringify({ url: 'https://pwned.web.test/a', title: 'pwned' }) })).status; } catch (e) { out.post = 'blocked: ' + e.name; }
  document.body.textContent = JSON.stringify(out);
})();
</script></html>`;
fs.writeFileSync(path.join(root, 'work', 'evil.html'), ATTACK);
const srv = await h.startServer({ root, args: ['--hosted', '--no-agents'], env: {} });
const companionPort = new URL(srv.base).port;
// the same bytes, served by something that is NOT the companion, with a policy of the test's choosing
const mk = csp => new Promise(r => { const s = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html', ...(csp ? { 'content-security-policy': csp } : {}) }).end(ATTACK); }); s.listen(0, '127.0.0.1', () => r(s)); });
const control = await mk(''); const opaque = await mk('sandbox allow-scripts');

async function open(url, expression = 'document.body.textContent', wait = 1500) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-brw-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, 'profile')}`,
    `--host-resolver-rules=MAP ${NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, 'about:blank'], { stdio: 'ignore' });
  try {
    let tabs;
    for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.length) break; } catch { } await sleep(250); }
    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    let id = 0; const pend = new Map();
    ws.on('message', m => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); } });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable'); await send('Network.enable');
    // what Cloudflare does: the signed-in person's assertion on EVERY request the browser makes to the host
    await send('Network.setExtraHTTPHeaders', { headers: { 'cf-access-jwt-assertion': mint(key, { email: OWNER }) } });
    await send('Page.navigate', { url });
    await sleep(wait);
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    ws.close();
    return r.result && r.result.value;
  } finally {
    const gone = new Promise(r => br.once('exit', r)); br.kill(); await Promise.race([gone, sleep(3000)]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
// the companion's pages, asked on the loopback directly (the owner there)
const pages = async () => JSON.stringify((await GET(srv.base, '/index')).json);
let passed = 0; const failed = [];
const test = async (name, fn) => { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e}`); } };

try {
  // the page is served at the companion's own, mapped, name: the port is the companion's (the browser needs it in the URL)
  const OWN = `http://${NAME}:${companionPort}`;
  await test('the control runs: the same bytes with no policy DO run, which is what the sandbox prevents', async () => {
    const out = JSON.parse(await open(`http://127.0.0.1:${control.address().port}/`));
    assert.equal(out.ran, true);
    assert.equal(out.cookie, '');                       // (the control is not the companion: it has no cookie; it is here to show the script runs)
    assert.ok(await pages() && !(await pages()).includes('pwned'), 'its POST (a foreign Origin) created nothing');
  });
  await test('served by the companion: the script in a stored .html does not run, and nothing is created', async () => {
    const text = await open(`${OWN}/files/work/evil.html`, 'document.body.firstChild.textContent');
    assert.equal(String(text).trim(), 'no', 'the page text is untouched: no script ran');
    assert.ok(!(await pages()).includes('pwned'));
  });
  await test('in an opaque origin that may run scripts: it cannot read the answers or the cookies, and its POST is refused', async () => {
    const out = JSON.parse(await open(`http://127.0.0.1:${opaque.address().port}/`));
    assert.equal(out.ran, true);
    assert.match(String(out.cookie), /blocked: SecurityError/, 'an opaque origin has no cookies to read');
    assert.ok(!(await pages()).includes('pwned'));
  });
  await test('a page opened at the companion that is not a stored file still works (the reading room is not sandboxed)', async () => {
    const title = await open(`${OWN}/pages`, 'document.title');
    assert.ok(typeof title === 'string' && title.length > 0, 'the reading room rendered: ' + title);
  });
} finally {
  control.close(); opaque.close(); h.cleanup(); await keys.close();
}
console.log(`${failed.length ? '✗' : '✓'} access-files-browser — ${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
process.exit(0);
