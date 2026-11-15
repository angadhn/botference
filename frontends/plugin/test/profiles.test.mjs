// shared/profiles.mjs: the registry, its one switch, the env each surface
// gets, the account read-out, and that the companion's storage follows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-profiles-'));
process.env.BOTFERENCE_SECRETS_DIR = SECRETS;
const P = await import('../../shared/profiles.mjs');

const reset = () => { fs.rmSync(SECRETS, { recursive: true, force: true }); fs.mkdirSync(SECRETS, { recursive: true }); };

test('no registry: no profile, and the environment is left exactly as it was', () => {
  reset();
  assert.equal(P.activeProfile(), null);
  const env = { CLAUDE_CONFIG_DIR: '/somewhere', KEEP: '1' };
  assert.equal(P.applyActiveProfile('discuss', env), null);
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/somewhere', KEEP: '1' });
  assert.deepEqual(P.listProfiles(), []);
});

test('init adopts today\'s state: every dir null, active, file is 0600', () => {
  reset();
  assert.equal(P.initRegistry('me').ok, true);
  assert.equal(P.initRegistry('again').ok, false, 'a second init is refused');
  const a = P.activeProfile();
  assert.equal(a.name, 'me');
  for (const f of P.FIELDS) assert.equal(a[f], null, f);
  assert.equal(fs.statSync(P.registryFile()).mode & 0o777, 0o600);
});

test('the default profile unsets the CLI dir variables and leaves the work dir alone', () => {
  reset(); P.initRegistry('me');
  const env = { CLAUDE_CONFIG_DIR: '/stray', CODEX_HOME: '/stray', BOTFERENCE_WORK_DIR: '/from-council-env' };
  P.applyActiveProfile('council', env);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.BOTFERENCE_KEYS_FILE, undefined);
  assert.equal(env.BOTFERENCE_WORK_DIR, '/from-council-env');
  assert.equal(env.BOTFERENCE_PROFILE, 'me');
});

test('add gives a profile its own dirs, and each surface its own history', () => {
  reset(); P.initRegistry('me');
  const r = P.addProfile('ada');
  assert.equal(r.ok, true);
  for (const k of ['claude_config_dir', 'codex_home', 'discuss_data_dir', 'discuss_work_dir', 'council_work_dir']) {
    assert.ok(fs.statSync(r.record[k]).isDirectory(), k);
    assert.ok(r.record[k].startsWith(path.join(SECRETS, 'profiles', 'ada')), k);
  }
  assert.equal(P.addProfile('ada').ok, false, 'duplicate refused');
  const p = { name: 'ada', ...r.record };
  const d = P.profileEnv(p, 'discuss');
  assert.equal(d.set.CLAUDE_CONFIG_DIR, r.record.claude_config_dir);
  assert.equal(d.set.CODEX_HOME, r.record.codex_home);
  assert.equal(d.set.BOTFERENCE_PLUGIN_DIR, r.record.discuss_data_dir);
  assert.equal(d.set.BOTFERENCE_WORK_DIR, r.record.discuss_work_dir);
  const c = P.profileEnv(p, 'council');
  assert.equal(c.set.BOTFERENCE_WORK_DIR, r.record.council_work_dir);
  assert.equal(c.set.BOTFERENCE_PLUGIN_DIR, undefined);
  assert.throws(() => P.profileEnv(p, 'review'), /unknown surface/);
});

test('setActive is the one switch, and refuses what it cannot honour', () => {
  reset(); P.initRegistry('me'); P.addProfile('ada');
  assert.equal(P.setActive('nobody').ok, false);
  assert.deepEqual(P.setActive('me'), { ok: true, name: 'me', changed: false });
  const r = P.setActive('ada');
  assert.equal(r.changed, true); assert.equal(r.from, 'me');
  assert.equal(P.activeProfile().name, 'ada');
});

test('remove refuses the active profile and keeps data unless asked', () => {
  reset(); P.initRegistry('me'); P.addProfile('ada'); P.addProfile('bo');
  assert.equal(P.removeProfile('me').ok, false, 'active one refused');
  const kept = P.removeProfile('ada');
  assert.equal(kept.ok, true); assert.equal(kept.deleted, null);
  assert.ok(fs.existsSync(path.join(SECRETS, 'profiles', 'ada')));
  const gone = P.removeProfile('bo', { deleteData: true });
  assert.ok(gone.deleted && !fs.existsSync(gone.deleted));
  assert.deepEqual(P.listProfiles().map(x => x.name), ['me']);
});

test('bad names are refused everywhere', () => {
  reset();
  for (const n of ['', '../x', 'a b', '.hidden', 'x'.repeat(40), null]) {
    assert.equal(P.initRegistry(n).ok, false, String(n));
  }
});

test('an unreadable registry stops everything rather than guessing', () => {
  reset();
  fs.writeFileSync(P.registryFile(), '{ not json');
  assert.throws(() => P.activeProfile());
  fs.writeFileSync(P.registryFile(), JSON.stringify({ format: 99, active: 'a', profiles: { a: {} } }));
  assert.throws(() => P.activeProfile(), /format 99/);
});

test('accounts are read locally and no token comes back', () => {
  reset(); P.initRegistry('me'); const r = P.addProfile('ada');
  const claims = Buffer.from(JSON.stringify({ email: 'ada@example.org' })).toString('base64url');
  fs.writeFileSync(path.join(r.record.codex_home, 'auth.json'),
    JSON.stringify({ tokens: { id_token: `h.${claims}.s`, access_token: 'SECRET-A', refresh_token: 'SECRET-R' } }));
  fs.writeFileSync(path.join(r.record.claude_config_dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'ada@anthropic.example' } }));
  const ada = P.profilesWithAccounts().find(x => x.name === 'ada');
  assert.deepEqual(ada.claude, { signed_in: true, email: 'ada@anthropic.example' });
  assert.deepEqual(ada.codex, { signed_in: true, email: 'ada@example.org', method: 'chatgpt' });
  assert.ok(!JSON.stringify(P.profilesWithAccounts()).includes('SECRET'), 'no token in the answer');
  assert.equal(P.jwtEmail('garbage'), null);
});

test('the companion\'s history follows the profile; its config does not', () => {
  const store = path.resolve(HERE, '..', 'store.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-root-'));
  const read = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const s = await import(${JSON.stringify('file://' + store)}); console.log(JSON.stringify({ dir: s.DIR, base: s.BASE_DIR }))`],
  { env: { ...process.env, BOTFERENCE_PROJECT_ROOT: root, ...env }, encoding: 'utf8' }));
  const plain = read({ BOTFERENCE_PLUGIN_DIR: '' });
  assert.equal(plain.dir, path.join(root, '.botference', 'plugin'));
  assert.equal(plain.dir, plain.base);
  const own = read({ BOTFERENCE_PLUGIN_DIR: '/profile/plugin' });
  assert.equal(own.dir, '/profile/plugin');
  assert.equal(own.base, path.join(root, '.botference', 'plugin'), 'config and grants stay in the companion\'s own folder');
});
