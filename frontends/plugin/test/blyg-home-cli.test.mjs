// blyg-home-cli.test.mjs — `botference blyg-home`: the one way to change the Publish-as-blyg command set (it is never written over HTTP).
//   node --test test/blyg-home-cli.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRig } from './blyg-rig.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'blyg-home-cli.mjs');
function cli(root, ...args) {
  const env = { ...process.env, BOTFERENCE_PROJECT_ROOT: root };
  delete env.BOTFERENCE_PLUGIN_DIR;
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('blyg-home: example, check (every problem), set (validated, written to the companion\'s config.json), show; refused while a run is live', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blyghomecli-'));
  const rig = makeRig(); t.after(() => { rig.done(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = path.join(root, '.botference', 'plugin', 'config.json');
  const ex = cli(root, 'example');
  assert.equal(ex.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(ex.out).commands), ['check', 'prepare', 'plan', 'apply', 'publish', 'plan_edit', 'apply_edit', 'publish_edit', 'discard', 'abandon', 'link_targets']);
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ folder: 'relative', env_pass: ['RUBYOPT'], commands: { plan: ['/bin/sh', '-c', 'x {note}'] } }));
  const c = cli(root, 'check', bad);
  assert.equal(c.code, 1);
  assert.match(c.out, /Not valid \(\d+ problems\)/);
  assert.match(c.out, /absolute path/); assert.match(c.out, /RUBYOPT/); assert.match(c.out, /shell/);
  assert.equal(cli(root, 'set', bad).code, 1);
  assert.ok(!fs.existsSync(config) || !JSON.parse(fs.readFileSync(config, 'utf8')).blyg_home, 'nothing was written');
  const good = path.join(root, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ blyg_home: { folder: rig.folder, confirm: 'always', commands: rig.home.commands } }));
  assert.equal(cli(root, 'check', good).code, 0);
  const s = cli(root, 'set', good);
  assert.equal(s.code, 0, s.out + s.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')).blyg_home.commands, rig.home.commands);
  const sh = cli(root, 'show');
  assert.equal(sh.code, 0);
  assert.ok(sh.out.includes(config), 'show names the config file');
  assert.match(sh.out, /Valid\./);
  // a live run: set is refused and changes nothing
  fs.writeFileSync(path.join(root, '.botference', 'plugin', 'blyg-publish-run.json'), JSON.stringify({ mode: 'planned', id: 'a', token: 't' }));
  fs.writeFileSync(good, JSON.stringify({ folder: rig.folder, confirm: 'always', filename: 'other-${slug}.md', commands: rig.home.commands }));
  const busy = cli(root, 'set', good);
  assert.equal(busy.code, 1);
  assert.match(busy.out, /under way \(planned\).*Nothing was written/s);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).blyg_home.filename, undefined);
  assert.equal(cli(root).code, 2, 'usage');
});

// `botference blyg-home links`: the catalogue of published posts as a /tk passage would get it (tk-links.mjs), from the `link_targets`
// command of the setting; made-up posts.
test('blyg-home links: runs the catalogue command and says what it gave; no command, or a failing one, is said plainly', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blyghomecli-links-'));
  const rig = makeRig(); t.after(() => { rig.done(); fs.rmSync(root, { recursive: true, force: true }); });
  const setting = path.join(root, 'home.json');
  const set = commands => { fs.writeFileSync(setting, JSON.stringify({ ...rig.home, commands: { ...rig.home.commands, ...commands } })); return cli(root, 'set', setting); };
  assert.equal(set({}).code, 0);
  const none = cli(root, 'links');
  assert.equal(none.code, 1);
  assert.match(none.out, /No `link_targets` command is set/);
  const script = (name, body) => { const f = path.join(rig.top, name); fs.writeFileSync(f, `#!${process.execPath}\n${body}\n`); fs.chmodSync(f, 0o755); return name; };
  const posts = [{ name: 'Harbour cranes', title: 'Harbour cranes and tides', id: '0123456789abcdefghjkmnpqrs', date: '2026-03-01', excerpt: 'Why a crane waits.' },
    { name: 'An old essay', kind: 'page', title: 'An old essay' }, { name: 'bad|name', id: '0123456789abcdefghjkmnpqrv' }];
  assert.equal(set({ link_targets: [`./${script('targets', `process.stdout.write(${JSON.stringify(JSON.stringify({ posts }))})`)}`] }).code, 0);
  const ok = cli(root, 'links');
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /2 published posts a \/tk passage may link to \(1 blyg, 1 page\); 1 entry dropped as unusable\./);
  assert.match(ok.out, /\[\[Harbour cranes\]\]  Harbour cranes and tides  \(2026-03-01\)/);
  assert.ok(!ok.out.includes('Why a crane waits'), 'names only, never a post\'s words');
  assert.equal(set({ link_targets: [`./${script('broken', 'process.exit(4)')}`] }).code, 0);
  const broken = cli(root, 'links');
  assert.equal(broken.code, 1);
  assert.match(broken.out, /No catalogue: the catalogue command failed \(exit 4\)\. A \/tk passage runs without one\./);
});
