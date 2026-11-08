#!/usr/bin/env node
// A file that is there but not readable JSON is not a missing file.
//
// readJson answered the same fallback for both, and every write path that
// followed a read then put defaults over the owner's bytes: a config.json with
// one trailing comma became the default config, a corrupt page record became a
// blank page, a broken portfolio became a one-project portfolio. Now reads
// still get the default (loudly, once) and writes over a broken file refuse.
//
//   node frontends/plugin/test/unreadable.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, POST } from './harness.mjs';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(TEST, '..');
const { test, tmp, startServer, cleanup, passed, failures } = createHarness({
  server: path.join(PLUGIN, 'server.mjs'), tag: 'unread', realpath: true,
});

const ROOT = tmp('root');
const SECRETS = tmp('secrets');
process.env.BOTFERENCE_PROJECT_ROOT = ROOT;
process.env.BOTFERENCE_HOME = ROOT;
process.env.BOTFERENCE_SECRETS_DIR = SECRETS;
delete process.env.PLUGIN_OWNER_PASSWORD;
delete process.env.REVIEW_HUB_PASSWORD;
const fsjson = await import('../fsjson.mjs');
const store = await import('../store.mjs');
const questions = await import('../questions.mjs');
const identity = await import('../identity.mjs');
const ws = await import('../workspace.mjs');

const DIR = path.join(ROOT, '.botference', 'plugin');
const CONFIG = path.join(DIR, 'config.json');
const BROKEN_CONFIG = '{\n  "author": "angadh",\n  "verbosity": "long",\n}\n';

// the loud line is the point of half of this; keep it, but out of the test log
const said = [];
const realError = console.error;
console.error = (...a) => { said.push(a.join(' ')); };

console.log('\nunreadable JSON');

await test('fsjson names the three states and tells them apart', async () => {
  assert.deepEqual([...fsjson.JSON_FILE_STATES], ['missing', 'ok', 'unreadable']);
  const d = tmp('states');
  assert.equal(fsjson.readJsonState(path.join(d, 'nope.json')).state, 'missing');
  fs.writeFileSync(path.join(d, 'ok.json'), '{"a":1}');
  assert.deepEqual(fsjson.readJsonState(path.join(d, 'ok.json')), { state: 'ok', value: { a: 1 }, error: null });
  fs.writeFileSync(path.join(d, 'bad.json'), '{"a":1,}');
  assert.equal(fsjson.readJsonState(path.join(d, 'bad.json')).state, 'unreadable');
  fs.mkdirSync(path.join(d, 'dir.json'));
  assert.equal(fsjson.readJsonState(path.join(d, 'dir.json')).state, 'unreadable', 'unreadable is not missing');
});

await test('a config.json with a trailing comma is read as defaults and never overwritten', async () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CONFIG, BROKEN_CONFIG);
  said.length = 0;
  const cfg = store.readConfig();
  assert.equal(cfg.verbosity, 'short', 'defaults stand in for reading');
  store.readConfig();
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), BROKEN_CONFIG, 'the owner\'s bytes are untouched');
  assert.equal(said.filter(l => l.includes('config.json')).length, 1, 'said loudly, and once');
  assert.throws(() => store.saveConfig({ verbosity: 'long' }), e => e.code === 'EUNREADABLEJSON');
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), BROKEN_CONFIG, 'and a save refuses rather than writing over it');
  fs.rmSync(CONFIG);
  store.readConfig();
  assert.ok(fs.existsSync(CONFIG), 'a MISSING config is still the first run, and is written');
});

await test('a corrupt page record is not replaced by a blank page', async () => {
  const url = 'https://ledger.test/broken-record';
  const file = store.pageFile(url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"url":"https://ledger.test/broken-record","threads":[{"id":"t1",');
  assert.equal(store.readPage(url), null, 'reads as absent');
  assert.throws(() => store.upsertPage({ url, title: 'Fresh' }), e => e.code === 'EUNREADABLEJSON');
  assert.match(fs.readFileSync(file, 'utf8'), /"threads":\[\{"id":"t1",$/, 'still the half-record, for the owner to rescue');
});

await test('a broken index is left alone, and the page is still saved', async () => {
  const idx = path.join(DIR, 'index.json');
  fs.writeFileSync(idx, '{"oops": ');
  const page = store.upsertPage({ url: 'https://ledger.test/fine', title: 'Fine' });
  assert.equal(store.readPage(page.url).title, 'Fine', 'the record is written');
  assert.equal(fs.readFileSync(idx, 'utf8'), '{"oops": ', 'the index is not replaced by one row');
  assert.deepEqual(store.readIndex(), {}, 'and reads as empty meanwhile');
  fs.rmSync(idx);
});

await test('a broken question vault reads empty and refuses to be saved over', async () => {
  fs.writeFileSync(questions.VAULT_FILE, '{"version":1,"cards":[{"id":"q-1"},]}');
  const v = questions.readVault();
  assert.deepEqual(v.cards, []);
  assert.throws(() => questions.saveVault(v), e => e.code === 'EUNREADABLEJSON');
  assert.match(fs.readFileSync(questions.VAULT_FILE, 'utf8'), /"q-1"/, 'the deck is still on disk');
});

await test('a broken shared secrets file: no password is minted over it', async () => {
  const f = path.join(SECRETS, 'review-paper-secrets.json');
  fs.writeFileSync(f, '{"owner": "kept", "device": "also kept",');
  assert.equal(identity.ownerPassword(), '', 'no owner password until it is fixed');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"owner": "kept", "device": "also kept",');
  fs.writeFileSync(f, JSON.stringify({ owner: 'kept' }));
  assert.equal(identity.ownerPassword(), 'kept', 'a readable file answers as before');
});

await test('a broken portfolio refuses a new project and makes no folder', async () => {
  const root = tmp('council');
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ version: 1 }));
  fs.mkdirSync(path.join(root, 'work', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  const pf = path.join(root, 'projects', 'portfolio.json');
  fs.writeFileSync(pf, '{"version":1,"projects":[{"id":"orbits"}],}');
  ws.setRootState(root, true);
  const made = ws.createProject(root, { title: 'Second project' });
  assert.equal(made.ok, false);
  assert.equal(made.status, 422, 'not 409, which callers read as "already exists"');
  assert.match(made.error, /not readable JSON/);
  assert.ok(!fs.existsSync(path.join(root, 'projects', 'second-project')), 'no folder');
  assert.equal(fs.readFileSync(pf, 'utf8'), '{"version":1,"projects":[{"id":"orbits"}],}');
});

await test('the companion starts on a broken config, keeps it, and a settings change says why it cannot', async () => {
  const root = tmp('server');
  const dir = path.join(root, '.botference', 'plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), BROKEN_CONFIG);
  const s = await startServer({ root });
  const r = await POST(s.base, '/first-reply', { first: 'claude' });
  assert.equal(r.status, 409, r.body);
  assert.match(r.json.error, /config\.json is not readable JSON/);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), BROKEN_CONFIG);
  assert.match(s.out(), /config\.json is not readable JSON/, 'the log says so');
});

console.error = realError;
cleanup();
console.log(`\n✓ unreadable.test.mjs — ${passed()} passed, ${failures().length} failed`);
if (failures().length) { console.log(failures().map(f => `  · ${f}`).join('\n')); process.exit(1); }
process.exit(0);
