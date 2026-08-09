#!/usr/bin/env node
// The usage beacon (beacon.mjs). Telemetry is the one feature whose tests are
// mostly about what does NOT happen, and about the exact bytes when it does —
// a README that promises "an install id and a version, nothing else" is only
// true if something checks it every time the file changes.
//
//   node frontends/plugin/test/beacon.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  payload, reason, ping, configured,
  EVENT_NAME, MEASUREMENT_ID, ENDPOINT, API_SECRET, APP_VERSION,
} from '../beacon.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-beacon-'));
// a build that HAS a secret, without one ever existing in the repo
const LIVE = { BOTFERENCE_TELEMETRY_SECRET: 'test-secret' };
const stampOf = dir => JSON.parse(fs.readFileSync(path.join(dir, '.beacon'), 'utf8'));
// records what would have gone on the wire, and never lets it leave
const recorder = () => {
  const calls = [];
  return { calls, send: (url, body) => { calls.push({ url, body }); } };
};

// --- exactly what is sent -------------------------------------------------
await test('the payload is an install id and a version, and nothing else', () => {
  const p = payload('a'.repeat(32));
  assert.deepEqual(Object.keys(p).sort(), ['client_id', 'events', 'non_personalized_ads']);
  assert.equal(p.client_id, 'a'.repeat(32));
  assert.equal(p.non_personalized_ads, true);
  assert.equal(p.events.length, 1);
  assert.deepEqual(Object.keys(p.events[0]).sort(), ['name', 'params']);
  assert.equal(p.events[0].name, 'discuss_alive');
  assert.deepEqual(p.events[0].params, { app_version: APP_VERSION, engagement_time_msec: '1' },
    'no url, no title, no handle, no hostname, no os, no locale, no counts');
});

await test('the documented literal is the literal that is sent', async () => {
  const dir = tmp();
  const r = recorder();
  const out = await ping({ dir, env: LIVE, send: r.send, now: 1e12 });
  assert.equal(out.sent, true);
  assert.equal(r.calls.length, 1);
  const { url, body } = r.calls[0];
  const id = stampOf(dir).id;
  assert.deepEqual(body, {
    client_id: id,
    non_personalized_ads: true,
    events: [{ name: 'discuss_alive', params: { app_version: APP_VERSION, engagement_time_msec: '1' } }],
  }, 'this object is what the README quotes — change one, change the other');
  assert.match(id, /^[0-9a-f]{32}$/, 'the id is 128 random bits and nothing derived');
  assert.ok(url.startsWith(`${ENDPOINT}?measurement_id=${MEASUREMENT_ID}&api_secret=`));
  // and nothing about the machine or the person rode along
  const flat = JSON.stringify(body) + url;
  for (const leak of [os.userInfo().username, os.hostname(), process.cwd()]) {
    if (leak) assert.equal(flat.includes(leak), false, `leaked ${leak}`);
  }
});

// --- every way it stays silent -------------------------------------------
await test('the shipped build has no secret, so it never phones anywhere', async () => {
  assert.equal(API_SECRET, '', 'the constant in the repo must stay empty');
  assert.equal(configured({}), false);
  const dir = tmp();
  const r = recorder();
  const out = await ping({ dir, env: {}, send: r.send });
  assert.equal(out.sent, false);
  assert.match(out.reason, /no api secret/);
  assert.equal(r.calls.length, 0, 'the network was never touched');
  assert.equal(fs.existsSync(path.join(dir, '.beacon')), false, 'and nothing was written down');
});

await test('BOTFERENCE_NO_TELEMETRY=1 wins over a configured build', async () => {
  const dir = tmp();
  const r = recorder();
  const env = { ...LIVE, BOTFERENCE_NO_TELEMETRY: '1' };
  assert.match(reason({ dir, env }), /BOTFERENCE_NO_TELEMETRY/);
  const out = await ping({ dir, env, send: r.send });
  assert.equal(out.sent, false);
  assert.equal(r.calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, '.beacon')), false,
    'an opted-out install never even mints an id');
});

await test('config.json telemetry:false opts out just as hard', async () => {
  const dir = tmp();
  const r = recorder();
  const config = { telemetry: false };
  assert.match(reason({ dir, env: LIVE, config }), /config\.json/);
  const out = await ping({ dir, env: LIVE, config, send: r.send });
  assert.equal(out.sent, false);
  assert.equal(r.calls.length, 0);
});

// --- at most once a day ---------------------------------------------------
await test('a second start the same day sends nothing', async () => {
  const dir = tmp();
  const r = recorder();
  const t0 = Date.parse('2026-08-09T09:00:00Z');
  assert.equal((await ping({ dir, env: LIVE, send: r.send, now: t0 })).sent, true);
  assert.equal(r.calls.length, 1);
  for (const later of [t0 + 1, t0 + 3600e3, t0 + 23 * 3600e3]) {
    const out = await ping({ dir, env: LIVE, send: r.send, now: later });
    assert.equal(out.sent, false, `${later - t0}ms later`);
    assert.match(out.reason, /already pinged today/);
  }
  assert.equal(r.calls.length, 1, 'still exactly one call, however often it restarts');
});

await test('tomorrow it pings again, under the same install id', async () => {
  const dir = tmp();
  const r = recorder();
  const t0 = Date.parse('2026-08-09T09:00:00Z');
  await ping({ dir, env: LIVE, send: r.send, now: t0 });
  const first = stampOf(dir).id;
  const out = await ping({ dir, env: LIVE, send: r.send, now: t0 + 24 * 3600e3 + 1 });
  assert.equal(out.sent, true);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].body.client_id, first, 'one install stays one install');
  assert.equal(stampOf(dir).last, t0 + 24 * 3600e3 + 1);
});

await test('the day is stamped before the call, so a dead network costs one day not a loop', async () => {
  const dir = tmp();
  const t0 = 2e12;
  const out = await ping({
    dir, env: LIVE, now: t0,
    send: () => { throw new Error('offline'); },
  });
  assert.equal(out.sent, true, 'a failed send is not an error anybody hears about');
  assert.equal(stampOf(dir).last, t0);
  const again = await ping({ dir, env: LIVE, now: t0 + 60e3, send: () => { throw new Error('offline'); } });
  assert.equal(again.sent, false, 'and it does not retry against someone else\'s endpoint');
});

await test('a hand-edited install id is replaced rather than trusted', async () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.beacon'), JSON.stringify({ id: 'angadh-laptop', last: 0 }) + '\n');
  const r = recorder();
  await ping({ dir, env: LIVE, send: r.send, now: 3e12 });
  assert.match(r.calls[0].body.client_id, /^[0-9a-f]{32}$/,
    'an id that is not 128 random bits could carry meaning, so it is not kept');
  assert.notEqual(r.calls[0].body.client_id, 'angadh-laptop');
});

await test('deleting the one small file is a complete reset', async () => {
  const dir = tmp();
  const r = recorder();
  await ping({ dir, env: LIVE, send: r.send, now: 4e12 });
  const before = stampOf(dir).id;
  fs.unlinkSync(path.join(dir, '.beacon'));
  await ping({ dir, env: LIVE, send: r.send, now: 4e12 + 1 });
  assert.notEqual(r.calls[1].body.client_id, before,
    'nothing outside that file remembers the install');
});

console.log(`\nbeacon: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(`failed: ${failures.join(', ')}`); process.exit(1); }
