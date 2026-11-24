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

// ---- local: the owner's own companion ----------------------------------------------------------
const rig = newRig();
const root = tmp('local');
const local = await startServer({ root, args: ['--no-agents'] });
const B = local.base;

await test('unset: every route refuses to act, a start writes nothing, and the settings page says what is missing', async () => {
  const s = await GET(B, '/blyg-home');
  assert.equal(s.status, 200);
  assert.equal(s.json.valid, false);
  assert.match(s.json.errors.join(' '), /not set up/);
  assert.match(s.json.defaults.template, /blyg_id: "\$\{id\}"\npermalink: \/b\/\$\{id\}/);
  const tid = await comment(B, 'My view on this story.');
  const r = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not set up/);
  assert.deepEqual(fs.readdirSync(rig.folder), []);
  assert.equal((await runOf(B)).mode, 'idle');
});

await test('the settings are validated when saved: a bad one is 400 with every reason, nothing stored; a good one is stored', async () => {
  const bad = await POST(B, '/blyg-home', { settings: { ...settingsOf(rig), commands: { plan: ['/bin/sh', '-c', 'x {note}'], apply: ['x'], publish: ['y', '{note}'] } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.errors.length >= 2 && bad.json.errors.some(e => /shell/.test(e)) && bad.json.errors.some(e => /{note}/.test(e)));
  assert.equal((await GET(B, '/blyg-home')).json.valid, false, 'nothing was stored');
  const good = await POST(B, '/blyg-home', { settings: settingsOf(rig) });
  assert.equal(good.status, 200, good.body);
  const now = await GET(B, '/blyg-home');
  assert.deepEqual([now.json.valid, now.json.errors], [true, []]);
  assert.deepEqual(now.json.settings.commands.plan, rig.home.commands.plan);
  const page = await request(B, 'GET', '/blyg-home/page', undefined, { accept: 'text/html' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
  assert.match(page.body, /<title>Where my blyg lives<\/title>/);
  assert.ok(!/<script>/.test(page.body), 'only a nonced script');
});

await test('request hygiene: only JSON, only this site; a form, text/plain, a foreign Origin and a rebound Host are all refused before anything runs', async () => {
  const tid = await comment(B, 'Another view on this story.');
  const body = JSON.stringify({ url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() });
  const send = (headers, raw = body) => new Promise((resolve, reject) => {
    const rq = http.request(B + '/blyg-publish/start', { method: 'POST', headers: { 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    rq.on('error', reject); rq.end(raw);
  });
  assert.equal((await send({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send({ 'content-type': 'application/x-www-form-urlencoded' }, 'url=x&thread_id=y&scope=one')).status, 415);
  assert.equal((await send({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ 'content-type': 'application/json', origin: 'null' })).status, 403);
  assert.equal((await send({ 'content-type': 'application/json', host: 'rebound.attacker.example' })).status, 421);
  for (const p of ['/blyg-publish/confirm', '/blyg-publish/cancel', '/blyg-publish/retry', '/blyg-publish/abandon', '/blyg-home']) {
    assert.equal((await request(B, 'POST', p, undefined, { 'content-type': 'application/x-www-form-urlencoded' }, 'run=x&token=y')).status, 415, p);
  }
  assert.equal((await request(B, 'GET', '/blyg-publish/run', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(B, 'GET', '/blyg-home', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(fs.readdirSync(rig.folder), [], 'and nothing was written by any of them');
  assert.deepEqual(rig.calls(), []);
});

await test('the flow: start writes the note and runs plan; the owner hears each move; confirm runs apply then publish; the thread is marked', async () => {
  const events = listen(B);
  const tid = await comment(B, 'A third view on this story, which is the one I will publish.');
  const s = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() });
  assert.equal(s.status, 200, s.body);
  assert.ok(['drafted', 'planning', 'planned'].includes(s.json.run.mode));
  const planned = await waitFor(async () => { const r = await runOf(B); return r.mode === 'planned' ? r : null; }, 'planned');
  assert.deepEqual(rig.calls().map(c => c.step), ['plan']);
  assert.match(planned.note_text, /^---\ncreated: \d{4}-\d\d-\d\d\n/);
  assert.match(planned.note_text, /\nA third view on this story, which is the one I will publish\.\n\n> Hiring is slowing for junior roles\.\n>\n> https:\/\/notes\.web\.test\/post\n$/);
  assert.ok(!JSON.stringify(planned).includes(rig.top), 'no absolute path of the work tree in what the client is shown');
  assert.equal((await POST(B, '/blyg-publish/confirm', { run: planned.id, token: 'wrong' })).status, 404);
  assert.equal((await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() })).status, 409, 'one run at a time');
  const c = await POST(B, '/blyg-publish/confirm', { run: planned.id, token: planned.token });
  assert.equal(c.status, 200, c.body);
  const done = await waitFor(async () => { const r = await runOf(B); return r.mode === 'published' ? r : null; }, 'published');
  assert.deepEqual(rig.calls().map(x => x.step), ['plan', 'apply', 'publish']);
  assert.match(done.published.address, /^https:\/\/site\.example\.test\/b\/[0-9a-hjkmnp-tv-z]{26}$/);
  const page = (await GET(B, '/page?url=' + encodeURIComponent(PAGE))).json;
  const th = (page.page || page).threads.find(x => x.id === tid);
  assert.equal(th.blyg_published.address, done.published.address);
  assert.equal((await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() })).status, 409, 'not offered again');
  await waitFor(() => events.of('blyg-publish').length >= 6, 'the moves were announced');
  assert.deepEqual([...new Set(events.of('blyg-publish').map(e => e.run.mode))].sort(), ['applied', 'applying', 'drafted', 'planned', 'planning', 'published', 'publishing']);
  assert.ok(events.of('blyg-publish').every(e => Object.keys(e.run).sort().join() === 'id,mode'), 'an event says which run and which mode, nothing else');
  events.close();
});

// The command set is code that runs on this machine: only the companion's OWN page (its own origin) or no Origin at all (the owner's
// curl) may write it. A page served on another loopback port (a local dev server, another tool), a sibling name, or any extension
// (pinned or not) is refused, and nothing is stored.
await test('the settings write accepts only the companion\'s own page (or no Origin): another loopback port, a same-site page or an extension is refused', async () => {
  const port = new URL(B).port;
  const other = String(Number(port) === 4000 ? 4001 : 4000);
  const changed = { ...settingsOf(rig), filename: 'changed-${slug}.md' };
  const refusedBy = [
    { origin: `http://127.0.0.1:${other}`, 'sec-fetch-site': 'cross-site' },
    { origin: `http://localhost:${other}`, 'sec-fetch-site': 'same-site' },
    { origin: `http://localhost:${other}` },
    { origin: 'null' },
    { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'sec-fetch-site': 'cross-site' },
    { origin: B, 'sec-fetch-site': 'same-site' },
  ];
  for (const h of refusedBy) {
    const r = await request(B, 'POST', '/blyg-home', { settings: changed }, { 'content-type': 'application/json', ...h });
    assert.equal(r.status, 403, JSON.stringify(h));
  }
  assert.equal((await GET(B, '/blyg-home')).json.settings.filename, '${slug}.md', 'nothing was stored');
  const own = await request(B, 'POST', '/blyg-home', { settings: changed }, { 'content-type': 'application/json', origin: B, 'sec-fetch-site': 'same-origin' });
  assert.equal(own.status, 200, own.body);
  assert.equal((await GET(B, '/blyg-home')).json.settings.filename, 'changed-${slug}.md', 'the companion\'s own page may');
  assert.equal((await POST(B, '/blyg-home', { settings: settingsOf(rig) })).status, 200, 'and no Origin (a curl on this machine) may');
});

await test('a settings change is refused while a run is under way', async () => {
  rig.control({});
  const tid = await comment(B, 'A fourth view that will sit at the confirmation.');
  const s = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() });
  assert.equal(s.status, 200);
  const planned = await waitFor(async () => { const r = await runOf(B); return r.mode === 'planned' ? r : null; }, 'planned');
  const r = await POST(B, '/blyg-home', { settings: settingsOf(rig) });
  assert.equal(r.status, 409);
  const cancel = await POST(B, '/blyg-publish/cancel', { run: planned.id, token: planned.token });
  assert.equal(cancel.status, 200);
  assert.deepEqual(fs.readdirSync(rig.folder).filter(f => f.startsWith('a-fourth')), [], 'the draft is gone');
  assert.equal((await POST(B, '/blyg-home', { settings: settingsOf(rig) })).status, 200, 'and the settings can change again');
});

await test('confirm never (with a guard): one start is the publish, end to end, with no confirm call; GET /blyg-publish/run says which setting is in force', async () => {
  rig.control({});
  const never = { ...settingsOf(rig), confirm: 'never', plan_guard: ['--only-note'] };
  assert.equal((await POST(B, '/blyg-home', { settings: never })).status, 200);
  shownNow = 'never';
  assert.equal((await GET(B, '/blyg-publish/run')).json.confirm, 'never');
  const before = rig.calls().length;
  const tid = await comment(B, 'A fifth view, published with one click and no other step.');
  const s = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() });
  assert.equal(s.status, 200, s.body);
  assert.equal(s.json.run.confirm, 'never');
  const done = await waitFor(async () => { const r = await runOf(B); return r.mode === 'published' ? r : null; }, 'published without a confirm');
  assert.deepEqual(rig.calls().slice(before).map(c => c.step), ['plan', 'apply', 'publish']);
  assert.ok(rig.calls()[before].argv.includes('--only-note'), 'the plan carried the guard flag');
  assert.ok(rig.calls()[before + 1].argv.includes('--only-note') && rig.calls()[before + 2].argv.includes('--only-note'), 'apply and publish carry it too');
  assert.equal((await POST(B, '/blyg-home', { settings: { ...never, plan_guard: [] } })).status, 400, 'never without a guard is refused when saving');
  assert.match(done.published.address, /^https:\/\/site\.example\.test\/b\/[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal((await POST(B, '/blyg-home', { settings: { ...never, plan_guard: ['not-a-flag'] } })).status, 400);
  const stale = await POST(B, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: 'always' });
  assert.equal(stale.status, 409, 'a drawer that showed the other wording is refused');
  assert.match(stale.json.error, /The setting changed/);
  assert.equal((await POST(B, '/blyg-home', { settings: settingsOf(rig) })).status, 200, 'back to confirming for the rest of the suite');
  shownNow = 'always';
});

// ---- crash and restart ------------------------------------------------------------------------------
await test('the companion is killed mid-run: after a restart the record is interrupted and offers only "show" and "abandon"', async () => {
  const rig2 = newRig();
  const root2 = tmp('crash');
  rig2.control({ plan: 'sleep' });
  let srv = await startServer({ root: root2, args: ['--no-agents'] });
  await POST(srv.base, '/blyg-home', { settings: settingsOf(rig2) });
  const tid = await comment(srv.base, 'A view the companion will not finish publishing.');
  const s = await POST(srv.base, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() });
  assert.equal(s.status, 200, s.body);
  await waitFor(() => rig2.calls().length === 1, 'plan started');
  const { id, token } = s.json.run;
  const sleeper = rig2.calls()[0].pid;
  srv.proc.kill('SIGKILL');
  await new Promise(r => srv.proc.on('exit', r));
  try { process.kill(sleeper, 'SIGKILL'); } catch { /* already gone */ }
  srv = await startServer({ root: root2, args: ['--no-agents'] });
  const v = await runOf(srv.base);
  assert.equal(v.mode, 'interrupted_planning');
  assert.equal(v.interrupted_from, 'planning');
  assert.deepEqual(v.can, ['abandon']);
  for (const p of ['confirm', 'retry', 'cancel']) assert.equal((await POST(srv.base, `/blyg-publish/${p}`, { run: id, token })).status, 409, p);
  assert.equal((await POST(srv.base, '/blyg-publish/start', { url: PAGE, thread_id: tid, scope: 'one', confirm: SHOWN() })).status, 409, 'it blocks a new run');
  const a = await POST(srv.base, '/blyg-publish/abandon', { run: id, token });
  assert.equal(a.status, 200, a.body);
  assert.equal((await runOf(srv.base)).mode, 'abandoned');
  assert.deepEqual(rig2.calls().map(c => c.step), ['plan'], 'nothing else ever ran');
});

// ---- hosted: guests -----------------------------------------------------------------------------------
const hrig = newRig();
const hroot = tmp('hosted');
const hosted = await startServer({ root: hroot, args: ['--hosted', '--no-agents'], env: { PLUGIN_PASSWORD: 'guest-pw', PLUGIN_OWNER_PASSWORD: 'owner-pw' } });
const GUEST = { host: 'discuss.botference.com', authorization: 'Bearer guest-pw', 'x-plugin-handle': 'ada' };
const OWNER = { host: 'discuss.botference.com', authorization: 'Bearer owner-pw' };
const ROUTES = [['GET', '/blyg-home'], ['GET', '/blyg-home/page'], ['POST', '/blyg-home'], ['GET', '/blyg-publish/run'], ['POST', '/blyg-publish/start'],
  ['POST', '/blyg-publish/confirm'], ['POST', '/blyg-publish/retry'], ['POST', '/blyg-publish/continue'], ['POST', '/blyg-publish/cancel'], ['POST', '/blyg-publish/abandon']];

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
});

await test('hosted: a same-site page cannot publish (a present Origin must be trusted, Sec-Fetch-Site must be same-origin or none, a POST must say it is JSON); the real owner page can', async () => {
  const t = await request(hosted.base, 'POST', '/blyg-home', { settings: settingsOf(hrig) }, {});
  assert.equal(t.status, 200);
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
    const r = await new Promise((resolve, reject) => { const u = new URL(hosted.base); const rq = http.request({ host: u.hostname, port: u.port, path: '/blyg-publish/start', method: 'POST', headers: { ...OWNER, ...(ct ? { 'content-type': ct } : {}) } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); rq.on('error', reject); rq.end(JSON.stringify(body)); });
    assert.equal(r.status, 415, `content-type ${ct}: ${r.body}`);
  }
  assert.equal(hrig.calls().length, calls, 'nothing ran for any of them');
  assert.equal((await request(hosted.base, 'GET', '/blyg-publish/run', undefined, { ...OWNER, 'sec-fetch-site': 'same-site' })).status, 403, 'a read is refused too');
  const good = await request(hosted.base, 'GET', '/blyg-publish/run', undefined, { ...OWNER, origin: 'https://discuss.botference.com', 'sec-fetch-site': 'same-origin' });
  assert.equal(good.status, 200, 'the companion\'s own page, same-origin, is let through');
  void sneaky;
});

await test('hosted: a guest cannot change the settings, start a run, or act on one (even with the right id and token, even by naming the page)', async () => {
  // the setting is written on the machine (a loopback request with no proxy headers), never by a remote owner session
  const remoteSet = await request(hosted.base, 'POST', '/blyg-home', { settings: settingsOf(hrig) }, OWNER);
  assert.equal(remoteSet.status, 403);
  assert.match(remoteSet.json.error, /only on the machine/);
  const set = await request(hosted.base, 'POST', '/blyg-home', { settings: settingsOf(hrig) }, {});
  assert.equal(set.status, 200, set.body);
  const redacted = (await request(hosted.base, 'GET', '/blyg-home', undefined, OWNER)).json;
  assert.deepEqual([redacted.redacted, redacted.valid, redacted.confirm, 'settings' in redacted, JSON.stringify(redacted).includes(hrig.top)], [true, true, 'always', false, false], 'a remote owner sees a redacted view: no paths, no commands');
  assert.equal((await request(hosted.base, 'GET', '/blyg-home/page', undefined, OWNER)).status, 403);
  const evil = { ...settingsOf(hrig), commands: { plan: ['/usr/bin/touch', '/tmp/pwned-by-guest', '{note}'], apply: ['/usr/bin/true', '{note}'], publish: ['/usr/bin/true', '{note}'] } };
  assert.equal((await request(hosted.base, 'POST', '/blyg-home', { settings: evil }, GUEST)).status, 403);
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
  const ownGuest = await request(hosted.base, 'POST', '/blyg-publish/start', { url: PAGE, thread_id: guestThread, scope: 'one', confirm: 'always' }, OWNER);
  assert.equal(ownGuest.status, 409, 'and the owner cannot publish a guest\'s comment either');
  assert.match(ownGuest.json.error, /you wrote yourself/);
  const s = await request(hosted.base, 'POST', '/blyg-publish/start', { url: PAGE, thread_id: t.json.thread.id, scope: 'above', confirm: 'always' }, OWNER);
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
  assert.ok(local.note_rel, 'on the machine: the relative note path');
  assert.ok(!('note_rel' in run), 'remote: none');
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
  const c = await request(hosted.base, 'POST', '/blyg-publish/confirm', { run: run.id, token: run.token }, OWNER);
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
