// hub-link-cli.test.mjs — `botference hub-link pair|rotate|off|status` (hub-link-cli.mjs), in a throwaway secrets folder.
//
//   node --test test/hub-link-cli.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../hub-link-cli.mjs';
import * as L from '../hub-link.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.resolve(HERE, '..', '..', '..', 'botference');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-hublinkcli-'));
const run = (argv, dir, env = {}) => { const out = []; const code = main(argv, { dir, env, say: s => out.push(s) }); return { code, out, text: out.join('\n') }; };
const lineOf = (text, name) => (new RegExp(`^${name}=(.*)$`, 'm').exec(text) || [])[1];

test('pair: the key file is 0600 in the secrets folder; the two lines for the Hub and the fingerprint are printed', () => {
  const dir = tmp();
  const r = run(['pair', '--hub', 'https://blog.example.com', '--publish', 'one-click', '--companion', 'https://companion.example.com'], dir);
  assert.equal(r.code, 0, r.text);
  const file = path.join(dir, 'hub-link.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const key = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([key.hub_origin, key.publish], ['https://blog.example.com', 'one-click']);
  assert.equal(lineOf(r.text, 'BLYG_HUB_STUDIO_URL'), 'https://companion.example.com');
  assert.equal(lineOf(r.text, 'BLYG_HUB_STUDIO_KEY'), `${key.key_id}.${key.secret}`);
  assert.match(r.text, new RegExp(`Key ${key.key_id}, fingerprint ${crypto.createHash('sha256').update(key.secret).digest('hex').slice(0, 8)}`));
  assert.equal(run(['pair', '--hub', 'https://blog.example.com'], dir).code, 1, 'already linked: refused, not overwritten');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), key);
});

test('the companion\'s address comes from the reading room\'s name when not given; a placeholder (said) when there is none', () => {
  const a = run(['pair', '--hub', 'https://blog.example.com'], tmp(), { PLUGIN_READING_HOSTNAME: 'discuss.example.com' });
  assert.equal(lineOf(a.text, 'BLYG_HUB_STUDIO_URL'), 'https://discuss.example.com');
  assert.match(a.text, /Publishing from the Hub: drafts-only/, 'drafts only unless asked');
  const b = run(['pair', '--hub', 'https://blog.example.com'], tmp(), {});
  assert.match(b.text, /BLYG_HUB_STUDIO_URL=https:\/\/<your companion's public name>/);
  assert.match(b.text, /No public name is set/);
});

test('status never prints the secret: key id and fingerprint only', () => {
  const dir = tmp();
  assert.match(run(['status'], dir).text, /Not linked/);
  run(['pair', '--hub', 'https://blog.example.com'], dir);
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'hub-link.json'), 'utf8'));
  const s = run(['status'], dir);
  assert.equal(s.code, 0);
  assert.ok(!s.text.includes(key.secret), 'no secret');
  assert.match(s.text, new RegExp(`Key ${key.key_id}, fingerprint ${L.fingerprintOf(key.secret)}`));
  assert.match(s.text, /Linked to https:\/\/blog\.example\.com/);
});

test('--hub must be an https origin; --companion too; a bad --publish is usage', () => {
  for (const hub of ['http://blog.example.com', 'https://blog.example.com/hub', 'blog.example.com', 'https://blog.example.com/?a=1']) {
    const dir = tmp();
    assert.equal(run(['pair', '--hub', hub], dir).code, 1, hub);
    assert.equal(fs.existsSync(path.join(dir, 'hub-link.json')), false, hub);
  }
  assert.equal(run(['pair', '--hub', 'https://blog.example.com', '--companion', 'http://companion.example.com'], tmp()).code, 1);
  assert.equal(run(['pair', '--hub', 'https://blog.example.com', '--publish', 'always'], tmp()).code, 2);
  assert.equal(run(['pair', '--nope'], tmp()).code, 2);
  assert.equal(run(['dance'], tmp()).code, 2);
});

test('rotate: a new key; the old one is refused at once by the signature check; the Hub and publish setting are kept unless --publish', () => {
  const dir = tmp();
  run(['pair', '--hub', 'https://blog.example.com', '--publish', 'one-click'], dir);
  const old = L.readLinkKey(dir).key;
  const r = run(['rotate'], dir);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, new RegExp(`old key ${old.key_id} is refused`));
  const now = L.readLinkKey(dir).key;
  assert.notEqual(now.secret, old.secret);
  assert.deepEqual([now.hub_origin, now.publish], [old.hub_origin, old.publish]);
  assert.equal(lineOf(r.text, 'BLYG_HUB_STUDIO_KEY'), `${now.key_id}.${now.secret}`);
  const ts = Math.floor(Date.now() / 1000);
  const nonces = L.createNonceCache();
  const v = h => L.verifySigned({ headers: h, urlPath: '/hub-link/ping', body: Buffer.from('{}'), key: L.readLinkKey(dir).key, nowSec: ts, nonces });
  assert.equal(v(L.signedHeaders(old, '/hub-link/ping', '{}', { ts })).ok, false, 'the old key');
  assert.equal(v(L.signedHeaders(now, '/hub-link/ping', '{}', { ts })).ok, true, 'the new key');
  assert.equal(run(['rotate', '--publish', 'drafts-only'], dir).code, 0);
  assert.equal(L.readLinkKey(dir).key.publish, 'drafts-only');
  assert.equal(run(['rotate', '--hub', 'https://other.example.com'], dir).code, 2, 'rotate keeps its Hub');
  assert.equal(run(['rotate'], tmp()).code, 1, 'nothing to rotate');
});

test('off deletes the key; an unreadable key file is never written over by pair or rotate', () => {
  const dir = tmp();
  run(['pair', '--hub', 'https://blog.example.com'], dir);
  assert.equal(run(['off'], dir).code, 0);
  assert.equal(fs.existsSync(path.join(dir, 'hub-link.json')), false);
  assert.match(run(['off'], dir).text, /already off/);
  fs.writeFileSync(path.join(dir, 'hub-link.json'), '{ broken');
  assert.equal(run(['pair', '--hub', 'https://blog.example.com'], dir).code, 1);
  assert.equal(run(['rotate'], dir).code, 1);
  assert.equal(run(['status'], dir).code, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'hub-link.json'), 'utf8'), '{ broken');
});

test('the launcher runs it: botference hub-link status, in the secrets folder it is given', () => {
  const dir = tmp();
  run(['pair', '--hub', 'https://blog.example.com'], dir);
  const out = execFileSync(LAUNCHER, ['hub-link', 'status'], { cwd: dir, env: { ...process.env, BOTFERENCE_SECRETS_DIR: dir }, encoding: 'utf8' });
  assert.match(out, /Linked to https:\/\/blog\.example\.com/);
});
