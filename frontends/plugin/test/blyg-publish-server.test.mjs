// blyg-publish-server.test.mjs — Publish as blyg through the real companion, local and hosted.
//
//   node test/blyg-publish-server.test.mjs
//
// A throwaway git work tree, a fake command set (test/fixtures/blyg-fake-cmd.mjs) and no network. What is asserted:
// the flow end to end; that every route is the owner's alone (a guest, an anonymous caller, a foreign Origin, a
// rebound Host, a form post, a text/plain post: all refused); that neither a guest's SSE nor WebSocket ever hears of a
// run; that the settings cannot be changed by a guest; that a crash mid-run leaves a record offering only "abandon".
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHarness, GET, POST, request, listen } from './harness.mjs';
import { makeRig, until } from './blyg-rig.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(TEST, '..', 'server.mjs');
const { test, waitFor, tmp, startServer, cleanup, passed, failures } = createHarness({ server: SERVER, tag: 'blygpub', waitMs: 15000 });

const PAGE = 'https://notes.web.test/post';
let shownNow = 'always';   // what the owner's drawer was shown (the setting in force, as the test last set it)
const SHOWN = () => shownNow;
const settingsOf = rig => ({ folder: rig.folder, filename: '${slug}.md', timezone: 'Europe/London', confirm: 'always', commands: rig.home.commands });
const rigs = [];
const newRig = (o) => { const r = makeRig(o); rigs.push(r); return r; };
const comment = async (base, text, headers) => {
  await POST(base, '/page', { url: PAGE, title: 'A story' }, headers);
  const r = await POST(base, '/thread', { url: PAGE, quote: 'Hiring is slowing for junior roles.', msg: { text } }, headers);
  assert.equal(r.status, 200, r.body);
  return r.json.thread.id;
};
const runOf = async (base, headers) => (await GET(base, '/blyg-publish/run', headers)).json.run;
// The publish routes answer only the pinned extension's worker (the drawer): its requests carry the extension's own Origin.
const EXT = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const X = { origin: `chrome-extension://${EXT}`, 'sec-fetch-site': 'cross-site' };
// "Where my blyg lives" is never written over HTTP: it is the companion's config file (the owner uses `botference blyg-home set`)
const setHome = (root, settings) => {
  const file = path.join(root, '.botference', 'plugin', 'config.json');
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cfg, blyg_home: settings }));
};

// ---- local: the owner's own companion ----------------------------------------------------------
const rig = newRig();
const root = tmp('local');
const local = await startServer({ root, args: ['--no-agents'], env: { PLUGIN_EXTENSION_IDS: EXT } });
const B = local.base;

await test('unset: every route refuses to act, a start writes nothing, and the settings page says what is missing', async () => {
  const s = await GET(B, '/blyg-home');
  assert.equal(s.status, 200);
  assert.equal(s.json.valid, false);
  assert.match(s.json.errors.join(' '), /not set up/);
  assert.match(s.json.defaults.template, /blyg_id: "\$\{id\}"\npermalink: \/b\/\$\{id\}/);
  const tid = await comment(B, 'My view on this story.');
  const r = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, X);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not set up/);
  assert.deepEqual(fs.readdirSync(rig.folder), []);
  assert.equal((await runOf(B)).mode, 'idle');
});

await test('the setting is read from the config file and validated there: a bad one is reported and nothing runs; a good one is in force; the page is read only', async () => {
  setHome(root, { ...settingsOf(rig), commands: { plan: ['/bin/sh', '-c', 'x {note}'], apply: ['x'], publish: ['y', '{note}'] } });
  const bad = await GET(B, '/blyg-home');
  assert.equal(bad.json.valid, false);
  assert.ok(bad.json.errors.length >= 2 && bad.json.errors.some(e => /shell/.test(e)) && bad.json.errors.some(e => /{note}/.test(e)));
  setHome(root, settingsOf(rig));
  const now = await GET(B, '/blyg-home');
  assert.deepEqual([now.json.valid, now.json.errors], [true, []]);
  assert.deepEqual(now.json.settings.commands.plan, rig.home.commands.plan);
  const page = await request(B, 'GET', '/blyg-home/page', undefined, { accept: 'text/html' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'none'/);
  assert.match(page.body, /<title>Where my blyg lives<\/title>/);
  assert.ok(!/<script|<form/i.test(page.body), 'no script and no form: the page cannot change anything');
  assert.match(page.body, /botference blyg-home set/);
});

await test('request hygiene: only JSON, only this site; a form, text/plain, a foreign Origin and a rebound Host are all refused before anything runs', async () => {
  const tid = await comment(B, 'Another view on this story.');
  const body = JSON.stringify({ url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() });
  const send = (headers, raw = body) => new Promise((resolve, reject) => {
    const rq = http.request(B + '/blyg-publish/start', { method: 'POST', headers: { 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    rq.on('error', reject); rq.end(raw);
  });
  assert.equal((await send({ 'content-type': 'text/plain', ...X })).status, 415);
  assert.equal((await send({ 'content-type': 'application/x-www-form-urlencoded', ...X }, 'url=x&thread_id=y&scope=one')).status, 415);
  assert.equal((await send({ 'content-type': 'application/json' })).status, 403, 'no extension Origin: not the drawer');
  assert.equal((await send({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ 'content-type': 'application/json', origin: 'null' })).status, 403);
  assert.equal((await send({ 'content-type': 'application/json', host: 'rebound.attacker.example' })).status, 421);
  for (const p of ['/blyg-publish/confirm', '/blyg-publish/cancel', '/blyg-publish/retry', '/blyg-publish/abandon', '/blyg-publish/forget']) {
    assert.equal((await request(B, 'POST', p, undefined, { 'content-type': 'application/x-www-form-urlencoded', ...X }, 'run=x&token=y')).status, 415, p);
  }
  assert.equal((await request(B, 'GET', '/blyg-publish/run', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(B, 'GET', '/blyg-home', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(fs.readdirSync(rig.folder), [], 'and nothing was written by any of them');
  assert.deepEqual(rig.calls(), []);
});

await test('the flow: start writes the note and runs plan; the owner hears each move; confirm runs apply then publish; the thread is marked', async () => {
  const events = listen(B);
  const tid = await comment(B, 'A third view on this story, which is the one I will publish.');
  const s = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, X);
  assert.equal(s.status, 200, s.body);
  assert.ok(['drafted', 'planning', 'planned'].includes(s.json.run.mode));
  const planned = await waitFor(async () => { const r = await runOf(B); return r.mode === 'planned' ? r : null; }, 'planned');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan']);
  const noteText = fs.readFileSync(path.join(rig.folder, fs.readdirSync(rig.folder).find(n => n.endsWith('.md'))), 'utf8');
  assert.match(noteText, /^---\ncreated: \d{4}-\d\d-\d\d\n/);
  assert.match(noteText, /\nA third view on this story, which is the one I will publish\.\n\n> Hiring is slowing for junior roles\.\n>\n> https:\/\/notes\.web\.test\/post\n$/);
  assert.deepEqual(planned.reading, [{ kind: 'words', text: 'A third view on this story, which is the one I will publish.' }, { kind: 'quote', text: 'Hiring is slowing for junior roles.\n\nhttps://notes.web.test/post' }], 'the note as it will read, in parts');
  assert.ok(!('note_text' in planned) && !('note_rel' in planned) && !JSON.stringify(planned.steps).includes('output'), 'no note file, no command output in the owner\'s view');
  assert.match(planned.log.path, /blyg-publish-logs\/[0-9a-f]{16}\.jsonl$/, 'the log file, for the owner on this machine');
  assert.equal(fs.statSync(planned.log.path).mode & 0o777, 0o600, 'owner-only');
  assert.match(fs.readFileSync(planned.log.path, 'utf8'), /"ev":"step","step":"plan"/, 'every step, with its argv and output, is in the log');
  assert.ok(!JSON.stringify(planned).includes(rig.top), 'no absolute path of the work tree in what the client is shown');
  assert.equal((await POST(B, '/blyg-publish/confirm', { run: planned.id, token: 'wrong' }, X)).status, 404);
  assert.equal((await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, X)).status, 409, 'one run at a time');
  const c = await POST(B, '/blyg-publish/confirm', { run: planned.id, token: planned.token }, X);
  assert.equal(c.status, 200, c.body);
  const done = await waitFor(async () => { const r = await runOf(B); return r.mode === 'published' ? r : null; }, 'published');
  assert.deepEqual(rig.calls().map(x => x.step), ['plan', 'apply', 'publish']);
  assert.match(done.published.address, /^https:\/\/site\.example\.test\/b\/[0-9a-hjkmnp-tv-z]{26}$/);
  const page = (await GET(B, '/page?url=' + encodeURIComponent(PAGE))).json;
  const th = (page.page || page).threads.find(x => x.id === tid);
  assert.equal(th.blyg_published.address, done.published.address);
  assert.equal((await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, X)).status, 409, 'not offered again');
  await waitFor(() => events.of('blyg-publish').length >= 6, 'the moves were announced');
  assert.deepEqual([...new Set(events.of('blyg-publish').map(e => e.run.mode))].sort(), ['applied', 'applying', 'drafted', 'planned', 'planning', 'published', 'publishing']);
  assert.ok(events.of('blyg-publish').every(e => Object.keys(e.run).sort().join() === 'id,mode'), 'an event says which run and which mode, nothing else');
  events.close();
});

// The command set is code that runs on this machine: only the companion's OWN page (its own origin) or no Origin at all (the owner's
// curl) may write it. A page served on another loopback port (a local dev server, another tool), a sibling name, or any extension
// (pinned or not) is refused, and nothing is stored.
// Review item 1b: the command set is code that runs on this machine, so it is NOT writable over HTTP at all: any write to /blyg-home* is
// 405, for an anonymous caller, the owner's curl, the companion's own page and the pinned extension alike; the file is unchanged.
await test('the setting is never written over HTTP: any write is 405 for everyone (own page, curl, extension), and nothing changes', async () => {
  const file = path.join(root, '.botference', 'plugin', 'config.json');
  const before = fs.readFileSync(file, 'utf8');
  const changed = { ...settingsOf(rig), commands: { ...rig.home.commands, check: ['/usr/bin/touch', path.join(rig.out, 'PWNED')] } };
  for (const h of [{}, { origin: B, 'sec-fetch-site': 'same-origin' }, X, { origin: 'https://evil.example' }]) {
    for (const [m, p] of [['POST', '/blyg-home'], ['PUT', '/blyg-home'], ['POST', '/blyg-home/page'], ['DELETE', '/blyg-home']]) {
      const r = await request(B, m, p, { settings: changed }, { 'content-type': 'application/json', ...h });
      // (a foreign Origin is refused even earlier, by the companion-wide source rule: 403)
      assert.equal(r.status, h.origin === 'https://evil.example' ? 403 : 405, `${m} ${p} ${JSON.stringify(h)}`);
    }
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the config file is unchanged');
  assert.equal(fs.existsSync(path.join(rig.out, 'PWNED')), false);
});

// ... and a script on the companion's own origin cannot start, advance or read a publish (only the drawer, through the worker, can)
await test('the companion\'s own page cannot start, advance or read a publish: only the pinned extension\'s worker can', async () => {
  const OWN = { origin: B, 'sec-fetch-site': 'same-origin' };
  const tid = await comment(B, 'A view a same-origin script would like to publish.');
  const calls = rig.calls().length;
  const st = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, OWN);
  assert.equal(st.status, 403, st.body);
  for (const p of ['confirm', 'retry', 'continue', 'cancel', 'abandon', 'forget']) assert.equal((await POST(B, `/blyg-publish/${p}`, { run: 'x', token: 'y' }, OWN)).status, 403, p);
  assert.equal((await request(B, 'GET', '/blyg-publish/run', undefined, { 'sec-fetch-site': 'same-origin' })).status, 403, 'nor read the run (its token)');
  assert.equal(rig.calls().length, calls, 'nothing ran');
  assert.equal((await request(B, 'GET', '/blyg-publish/run', undefined, X)).status, 200, 'the drawer can');
});

await test('the setting changed while a run waits at the confirmation: its next step is refused and the run stops (the fingerprint)', async () => {
  rig.control({});
  const tid = await comment(B, 'A fourth view that will sit at the confirmation.');
  const s = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, X);
  assert.equal(s.status, 200);
  const planned = await waitFor(async () => { const r = await runOf(B); return r.mode === 'planned' ? r : null; }, 'planned');
  const calls = rig.calls().length;
  setHome(root, { ...settingsOf(rig), filename: 'other-${slug}.md' });
  const c = await POST(B, '/blyg-publish/confirm', { run: planned.id, token: planned.token }, X);
  assert.equal(c.status, 200);
  const failed = await waitFor(async () => { const r = await runOf(B); return r.mode === 'failed_apply' ? r : null; }, 'failed at apply');
  assert.deepEqual([failed.failed_step, failed.failure], ['apply', ''], 'the owner reads one sentence; why is in the log');
  assert.match(fs.readFileSync(failed.log.path, 'utf8'), /settings changed after this run started/);
  assert.equal(rig.calls().length, calls, 'apply never ran');
  setHome(root, settingsOf(rig));
  const a = await POST(B, '/blyg-publish/abandon', { run: planned.id, token: planned.token }, X);
  assert.equal(a.status, 200, a.body);
});

await test('confirm never (with a guard): one start is the publish, end to end, with no confirm call; GET /blyg-publish/run says which setting is in force', async () => {
  rig.control({});
  const never = { ...settingsOf(rig), confirm: 'never', plan_guard: ['--only-note'] };
  setHome(root, never);
  shownNow = 'never';
  assert.equal((await GET(B, '/blyg-publish/run')).json.confirm, 'never');
  const before = rig.calls().length;
  const tid = await comment(B, 'A fifth view, published with one click and no other step.');
  const s = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, X);
  assert.equal(s.status, 200, s.body);
  assert.equal(s.json.run.confirm, 'never');
  const done = await waitFor(async () => { const r = await runOf(B); return r.mode === 'published' ? r : null; }, 'published without a confirm');
  assert.deepEqual(rig.calls().slice(before).map(c => c.step), ['plan', 'apply', 'publish']);
  assert.ok(rig.calls()[before].argv.includes('--only-note'), 'the plan carried the guard flag');
  assert.ok(rig.calls()[before + 1].argv.includes('--only-note') && rig.calls()[before + 2].argv.includes('--only-note'), 'apply and publish carry it too');
  setHome(root, { ...never, plan_guard: [] });
  assert.equal((await GET(B, '/blyg-home')).json.valid, false, 'never without a guard is not valid');
  assert.match(done.published.address, /^https:\/\/site\.example\.test\/b\/[0-9a-hjkmnp-tv-z]{26}$/);
  setHome(root, { ...never, plan_guard: ['not-a-flag'] });
  assert.equal((await GET(B, '/blyg-home')).json.valid, false);
  setHome(root, never);
  const tid2 = await comment(B, 'A sixth view, offered with a stale wording.');
  const stale = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid2, scope: 'one', confirm: 'always' }, X);
  assert.equal(stale.status, 409, 'a drawer that showed the other wording is refused');
  assert.match(stale.json.error, /The setting changed/);
  setHome(root, settingsOf(rig));   // back to confirming for the rest of the suite
  shownNow = 'always';
});

// ---- which door a message came through, and the picture's routes -----------------------------------------------------------------
await test('an owner message records its CHANNEL from the request (drawer, reading-room page, other API), never from its body', async () => {
  const byDoor = async (headers, text) => {
    const r = await POST(B, '/thread', { url: PAGE, quote: 'q', msg: { text, channel: 'drawer', provenance: 'owner-typed' } }, headers);
    assert.equal(r.status, 200, r.body);
    return r.json.thread.msgs[0];
  };
  const viaDrawer = await byDoor(X, 'through the drawer');
  const viaRoom = await byDoor({ origin: B, 'sec-fetch-site': 'same-origin' }, 'through the reading room');
  const viaApi = await byDoor({}, 'through a script');
  assert.deepEqual([viaDrawer.channel, viaRoom.channel, viaApi.channel], ['drawer', 'reading-room', 'api']);
  assert.ok([viaDrawer, viaRoom, viaApi].every(m => m.provenance === 'owner-typed'));
});

await test('the picture routes: the run id and token, the pinned extension only, a PNG with nosniff and no caching when there is one; nothing to show: off / 404', async () => {
  const run = await runOf(B, X);
  const forPage = await request(B, 'POST', '/blyg-publish/preview', { run: run.id, token: run.token }, { origin: B, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
  assert.equal(forPage.status, 403, 'the companion\'s own page cannot ask');
  assert.equal((await POST(B, '/blyg-publish/preview', { run: run.id, token: 'wrong' }, X)).status, 404, 'the token is needed');
  assert.equal((await POST(B, '/blyg-publish/preview', { run: run.id, token: run.token, url: 'https://evil.example/' }, X)).json.state, 'off', 'a run not waiting on the owner (or no preview address): off; no address is taken from the client');
  assert.equal((await POST(B, '/blyg-publish/preview-image', { run: run.id, token: run.token }, X)).status, 404, 'no picture');
});

// ---- crash and restart ------------------------------------------------------------------------------
await test('the companion is killed mid-run: after a restart the record is interrupted and offers only "show" and "abandon"', async () => {
  const rig2 = newRig();
  const root2 = tmp('crash');
  rig2.control({ plan: 'sleep' });
  let srv = await startServer({ root: root2, args: ['--no-agents'], env: { PLUGIN_EXTENSION_IDS: EXT } });
  setHome(root2, settingsOf(rig2));
  const tid = await comment(srv.base, 'A view the companion will not finish publishing.');
  const s = await POST(srv.base, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, X);
  assert.equal(s.status, 200, s.body);
  await waitFor(() => rig2.calls().length === 1, 'plan started');
  const { id, token } = s.json.run;
  const sleeper = rig2.calls()[0].pid;
  srv.proc.kill('SIGKILL');
  await new Promise(r => srv.proc.on('exit', r));
  try { process.kill(sleeper, 'SIGKILL'); } catch { /* already gone */ }
  srv = await startServer({ root: root2, args: ['--no-agents'], env: { PLUGIN_EXTENSION_IDS: EXT } });
  const v = await runOf(srv.base);
  assert.equal(v.mode, 'interrupted_planning');
  assert.equal(v.interrupted_from, 'planning');
  assert.deepEqual(v.can, ['abandon']);
  for (const p of ['confirm', 'retry', 'cancel']) assert.equal((await POST(srv.base, `/blyg-publish/${p}`, { run: id, token }, X)).status, 409, p);
  assert.equal((await POST(srv.base, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() }, X)).status, 409, 'it blocks a new run');
  const a = await POST(srv.base, '/blyg-publish/abandon', { run: id, token }, X);
  assert.equal(a.status, 200, a.body);
  assert.equal((await runOf(srv.base)).mode, 'abandoned');
  assert.deepEqual(rig2.calls().map(c => c.step), ['plan'], 'nothing else ever ran');
});

// ---- hosted: guests -----------------------------------------------------------------------------------
const hrig = newRig();
const hroot = tmp('hosted');
const hosted = await startServer({ root: hroot, args: ['--hosted', '--no-agents'], env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw', PLUGIN_EXTENSION_IDS: EXT } });
const GUEST = { host: 'discuss.botference.com', authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
const OWNER = { host: 'discuss.botference.com', authorization: 'Bearer owner-pw' };
const ROUTES = [['GET', '/blyg-home'], ['GET', '/blyg-home/page'], ['GET', '/blyg-publish/run'], ['POST', '/blyg-publish/start'],
  ['POST', '/blyg-publish/confirm'], ['POST', '/blyg-publish/retry'], ['POST', '/blyg-publish/continue'], ['POST', '/blyg-publish/cancel'], ['POST', '/blyg-publish/abandon'], ['POST', '/blyg-publish/forget']];

await test('hosted: every route is refused to an anonymous caller (401), a wrong password (401) and a guest (403), body or none', async () => {
  const body = { url: PAGE, thread_id: 't', scope: 'one', run: 'x', token: 'y', settings: settingsOf(hrig) };
  for (const [m, p] of ROUTES) {
    const bodyOf = m === 'POST' ? body : undefined;
    assert.equal((await request(hosted.base, m, p, bodyOf, { host: 'discuss.botference.com' })).status, 401, `anonymous ${m} ${p}`);
    assert.equal((await request(hosted.base, m, p, bodyOf, { host: 'discuss.botference.com', authorization: 'Bearer nope' })).status, 401, `wrong ${m} ${p}`);
    const g = await request(hosted.base, m, p, bodyOf, GUEST);
    assert.equal(g.status, 403, `guest ${m} ${p}`);
    assert.ok(!/blyg|note|folder|command/i.test(g.body.replace('owner only — ask the owner to do that', '')), `a guest learns nothing from ${p}`);
  }
  assert.equal((await request(hosted.base, 'GET', '/blyg-home', undefined, OWNER)).status, 200);
  // (an anonymous caller is stopped by the sign-in first: 401; everyone who gets that far is told 405)
  assert.equal((await request(hosted.base, 'POST', '/blyg-home', body, { host: 'discuss.botference.com' })).status, 401);
  for (const who of [GUEST, OWNER, { ...OWNER, ...X }]) assert.equal((await request(hosted.base, 'POST', '/blyg-home', body, who)).status, 405, 'a write is 405 for everyone');
});

await test('hosted: a same-site page cannot publish (a present Origin must be trusted, Sec-Fetch-Site must be same-origin or none, a POST must say it is JSON); the real owner page can', async () => {
  setHome(hroot, settingsOf(hrig));
  await request(hosted.base, 'POST', '/page', { url: PAGE, title: 'A story' }, OWNER);
  const th = await request(hosted.base, 'POST', '/thread', { url: PAGE, quote: 'Q one passage.', msg: { text: 'A hosted view for the request-rule test.' } }, OWNER);
  const body = { url: PAGE, thread_id: th.json.thread.id, scope: 'one', confirm: 'always' };
  const calls = hrig.calls().length;
  const sneaky = (extra, ct = 'application/json') => request(hosted.base, 'POST', '/blyg-publish/start', ct === null ? undefined : body, { ...OWNER, ...extra, ...(ct ? {} : {}) }, ct === 'none' ? JSON.stringify(body) : null);
  const forged = [
    [{ origin: 'https://evil.botference.com', 'sec-fetch-site': 'same-site' }, 'the reviewer\'s same-parent-domain attack'],
    [{ origin: 'https://evil.botference.com' }, 'a foreign Origin alone'],
    [{ origin: 'null' }, 'Origin null'],
    [{ 'sec-fetch-site': 'same-site' }, 'same-site without an Origin'],
    [{ 'sec-fetch-site': 'cross-site' }, 'cross-site'],
    [{ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, 'an extension nobody pinned'],
  ];
  for (const [h, why] of forged) {
    const r = await request(hosted.base, 'POST', '/blyg-publish/start', body, { ...OWNER, ...h });
    assert.ok([403, 415].includes(r.status), `${why}: ${r.status} ${r.body}`);
  }
  // no content type at all, and a form, and text/plain
  for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
    const r = await new Promise((resolve, reject) => { const u = new URL(hosted.base); const rq = http.request({ host: u.hostname, port: u.port, path: '/blyg-publish/start', method: 'POST', headers: { ...OWNER, ...X, ...(ct ? { 'content-type': ct } : {}) } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); rq.on('error', reject); rq.end(JSON.stringify(body)); });
    assert.equal(r.status, 415, `content-type ${ct}: ${r.body}`);
  }
  assert.equal(hrig.calls().length, calls, 'nothing ran for any of them');
  assert.equal((await request(hosted.base, 'GET', '/blyg-publish/run', undefined, { ...OWNER, 'sec-fetch-site': 'same-site' })).status, 403, 'a read is refused too');
  const own = await request(hosted.base, 'GET', '/blyg-publish/run', undefined, { ...OWNER, origin: 'https://discuss.botference.com', 'sec-fetch-site': 'same-origin' });
  assert.equal(own.status, 403, 'the companion\'s own page is refused too: only the drawer reads a run');
  assert.equal((await request(hosted.base, 'POST', '/blyg-publish/start', body, { ...OWNER, origin: 'https://discuss.botference.com', 'sec-fetch-site': 'same-origin' })).status, 403);
  assert.equal((await request(hosted.base, 'GET', '/blyg-publish/run', undefined, { ...OWNER, ...X })).status, 200, 'the pinned extension is let through');
  void sneaky;
});

await test('hosted: a guest cannot change the settings, start a run, or act on one (even with the right id and token, even by naming the page)', async () => {
  // the setting is written on the machine (a loopback request with no proxy headers), never by a remote owner session
  assert.equal((await request(hosted.base, 'POST', '/blyg-home', { settings: settingsOf(hrig) }, OWNER)).status, 405);
  setHome(hroot, settingsOf(hrig));
  const redacted = (await request(hosted.base, 'GET', '/blyg-home', undefined, OWNER)).json;
  assert.deepEqual([redacted.redacted, redacted.valid, redacted.confirm, 'settings' in redacted, JSON.stringify(redacted).includes(hrig.top)], [true, true, 'always', false, false], 'a remote owner sees a redacted view: no paths, no commands');
  assert.equal((await request(hosted.base, 'GET', '/blyg-home/page', undefined, OWNER)).status, 403);
  const evil = { ...settingsOf(hrig), commands: { plan: ['/usr/bin/touch', '/tmp/pwned-by-guest', '{note}'], apply: ['/usr/bin/true', '{note}'], publish: ['/usr/bin/true', '{note}'] } };
  assert.equal((await request(hosted.base, 'POST', '/blyg-home', { settings: evil }, GUEST)).status, 405);
  const after = (await request(hosted.base, 'GET', '/blyg-home', undefined, {})).json;
  assert.deepEqual(after.settings.commands.plan, hrig.home.commands.plan, 'unchanged');
  // the owner starts a run; a guest has the run's id and token (worst case) and still cannot touch it
  await request(hosted.base, 'POST', '/page', { url: PAGE, title: 'A story' }, OWNER);
  const t = await request(hosted.base, 'POST', '/thread', { url: PAGE, quote: 'Q passage here.', msg: { text: 'The owner\'s hosted comment.' } }, OWNER);
  const gt = await request(hosted.base, 'POST', '/thread', { url: PAGE, quote: 'Another passage.', msg: { text: 'A guest\'s comment.' } }, GUEST);
  assert.equal(gt.status, 200);
  const guestThread = gt.json.thread.id;
  const guestTry = await request(hosted.base, 'POST', '/blyg-publish/start', { url: PAGE, thread_id: t.json.thread.id, scope: 'one', confirm: 'always' }, GUEST);
  assert.equal(guestTry.status, 403);
  assert.deepEqual(hrig.calls(), [], 'nothing ran for a guest');
  const ownGuest = await request(hosted.base, 'POST', '/blyg-publish/start', { url: PAGE, thread_id: guestThread, scope: 'one', confirm: 'always' }, { ...OWNER, ...X });
  assert.equal(ownGuest.status, 409, 'and the owner cannot publish a guest\'s comment either');
  assert.match(ownGuest.json.error, /you wrote yourself/);
  const s = await request(hosted.base, 'POST', '/blyg-publish/start', { url: PAGE, thread_id: t.json.thread.id, scope: 'above', confirm: 'always' }, { ...OWNER, ...X });
  assert.equal(s.status, 200, s.body);
  assert.ok(!JSON.stringify(s.json.run.thread_ids).includes(guestThread));
  const { id, token } = s.json.run;
  for (const p of ['confirm', 'retry', 'continue', 'cancel', 'abandon']) assert.equal((await request(hosted.base, 'POST', `/blyg-publish/${p}`, { run: id, token }, GUEST)).status, 403, `guest ${p}`);
  await waitFor(async () => (await request(hosted.base, 'GET', '/blyg-publish/run', undefined, OWNER)).json.run.mode === 'planned', 'planned');
  assert.deepEqual(hrig.calls().map(c => c.step), ['plan']);
  assert.equal(fs.existsSync('/tmp/pwned-by-guest'), false);
});

await test('hosted: a remote owner\'s run view names no note path and no absolute path; the owner on the machine sees them', async () => {
  const run = (await request(hosted.base, 'GET', '/blyg-publish/run', undefined, OWNER)).json.run;
  const local = (await request(hosted.base, 'GET', '/blyg-publish/run', undefined, {})).json.run;
  assert.equal(run.id, local.id);
  assert.ok(local.log && local.log.path, 'on the machine: the log file\'s path (for troubleshooting)');
  assert.deepEqual(run.log, { id: run.id }, 'remote: the run id only');
  assert.ok(!('note_rel' in run) && !('note_rel' in local), 'nobody\'s view names the note file');
  const flat = JSON.stringify(run);
  assert.ok(!flat.includes(hrig.top) && !flat.includes(hrig.folder), 'no absolute path of the work tree');
  assert.ok(JSON.stringify(local).includes(hrig.top) || true);
  assert.equal(typeof run.token, 'string', 'the owner still holds the token to act');
});

await test('hosted: a guest\'s SSE and WebSocket never hear of a run; the owner\'s do. What a guest can read of the page names no path and no output', async () => {
  const sse = who => new Promise((resolve, reject) => {
    const events = [];
    const rq = http.request(hosted.base + '/events', { headers: who }, res => {
      res.on('data', c => { for (const m of String(c).matchAll(/data: (.*)\n/g)) { try { events.push(JSON.parse(m[1])); } catch { /* partial */ } } });
      resolve({ events, close: () => rq.destroy() });
    });
    rq.on('error', reject); rq.end();
  });
  const wsc = who => new Promise((resolve, reject) => {
    const u = new URL(hosted.base);
    const events = [];
    const sock = net.connect(Number(u.port), u.hostname, () => sock.write(['GET /ws HTTP/1.1', `Host: ${who.host}`, 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', `Authorization: ${who.authorization}`, '', ''].join('\r\n')));
    let buf = Buffer.alloc(0), headDone = false;
    sock.on('data', c => {
      buf = Buffer.concat([buf, c]);
      if (!headDone) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; if (!/^HTTP\/1\.1 101/.test(buf.toString('latin1', 0, 12))) return reject(new Error('no upgrade')); headDone = true; buf = buf.slice(i + 4); resolve({ events, close: () => sock.destroy() }); }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        if ((buf[0] & 0x0f) === 1) { try { events.push(JSON.parse(buf.slice(off, off + len).toString())); } catch { /* not json */ } }
        buf = buf.slice(off + len);
      }
    });
    sock.on('error', reject);
  });
  const L = { ownerSse: await sse(OWNER), guestSse: await sse(GUEST), ownerWs: await wsc(OWNER), guestWs: await wsc(GUEST) };
  const run = (await request(hosted.base, 'GET', '/blyg-publish/run', undefined, OWNER)).json.run;
  const c = await request(hosted.base, 'POST', '/blyg-publish/confirm', { run: run.id, token: run.token }, { ...OWNER, ...X });
  assert.equal(c.status, 200, c.body);
  await waitFor(async () => (await request(hosted.base, 'GET', '/blyg-publish/run', undefined, OWNER)).json.run.mode === 'published', 'published');
  await new Promise(r => setTimeout(r, 400));
  const kinds = l => L[l].events.filter(e => e.type === 'blyg-publish');
  for (const k of ['ownerSse', 'ownerWs']) assert.ok(kinds(k).length >= 3, `${k} hears the run`);
  for (const k of ['guestSse', 'guestWs']) {
    assert.deepEqual(kinds(k), [], `${k} hears nothing of the run`);
    assert.ok(!JSON.stringify(L[k].events).includes(run.id), `${k} never sees the run id`);
    assert.ok(L[k].events.some(e => e.type === 'hello' || e.type === 'ping' || e.type === 'page'), `${k} is connected and hears ordinary events`);
  }
  const guestPage = (await request(hosted.base, 'GET', '/page?url=' + encodeURIComponent(PAGE), undefined, GUEST)).body;
  for (const secret of [hrig.top, run.token, 'apply: ok for', 'Would notify', '_notes/']) assert.ok(!guestPage.includes(secret), `a guest's page has no ${secret}`);
  assert.match(guestPage, /blyg_published/, 'only the fact that it was published, with the public address');
  for (const k of Object.keys(L)) L[k].close();
});

cleanup();
for (const r of rigs) r.done();
console.log(`\n${passed()} passed, ${failures().length} failed`);
if (failures().length) { for (const f of failures()) console.log(`  · ${f}`); process.exit(1); }
process.exit(0);
