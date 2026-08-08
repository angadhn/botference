#!/usr/bin/env node
// Launcher tests for `botference plugin` (lib/plugin.sh): the sticky workspace
// and the flag combinations that must fail loudly instead of half-starting.
// Same no-framework shape as companion.test.mjs; every case runs the real
// shell functions in a throwaway HOME so the developer's own
// ~/.botference/plugin-workspace is never touched.
//
//   node frontends/plugin/test/launcher.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST, '..', '..', '..');
const PLUGIN_SH = path.join(REPO, 'lib', 'plugin.sh');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}
const tmp = tag => fs.mkdtempSync(path.join(os.tmpdir(), `bfp-${tag}-`));

// run shell in a scratch HOME; returns {out, code}
function sh(script, { cwd, home, env = {} } = {}) {
  const full = `set -euo pipefail\nsource "${PLUGIN_SH}"\n${script}\n`;
  try {
    const out = execFileSync('bash', ['-c', full], {
      cwd, encoding: 'utf8',
      env: { ...process.env, HOME: home, ...env },
    });
    return { out, code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status };
  }
}
// the resolver's two outputs, as one line
const pick = (args, opts) => sh(`_plugin_pick_workspace ${args}\necho "$PLUGIN_WS|$PLUGIN_WS_STICKY"`, opts)
  .out.trim().split('\n').pop();
const memo = home => {
  const f = path.join(home, '.botference', 'plugin-workspace');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
};
// bash -c runs with the real (possibly symlinked) tmp path; compare resolved
const real = p => fs.realpathSync(p);

// --- the launcher runs the whole mode, for the argument-validation cases ---
function launcher(args, { cwd, home }) {
  try {
    const out = execFileSync(path.join(REPO, 'botference'), ['plugin', ...args], {
      cwd, encoding: 'utf8',
      env: { ...process.env, HOME: home, PLUGIN_PASSWORD: '', PLUGIN_OWNER_PASSWORD: '' },
    });
    return { out, code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status };
  }
}

// --- sticky workspace ---------------------------------------------------
const home = tmp('home');
const wsA = tmp('wsA');
const wsB = tmp('wsB');
fs.mkdirSync(path.join(wsA, '.botference', 'plugin'), { recursive: true });

test('the first run adopts the directory you are standing in', () => {
  assert.equal(pick('false', { cwd: wsB, home }), `${real(wsB)}|false`);
  assert.equal(memo(home), null, 'picking alone records nothing');
});

test('a directory with plugin state always wins', () => {
  sh(`_plugin_remember_workspace "${real(wsB)}"`, { cwd: wsB, home });
  assert.equal(pick('false', { cwd: wsA, home }), `${real(wsA)}|false`,
    'annotations already here — never follow the memo away from them');
});

test('elsewhere, the remembered workspace is reused', () => {
  sh(`_plugin_remember_workspace "${real(wsA)}"`, { cwd: wsA, home });
  assert.equal(pick('false', { cwd: wsB, home }), `${real(wsA)}|true`);
});

test('--here overrides the memo and re-records', () => {
  assert.equal(pick('true', { cwd: wsB, home }), `${real(wsB)}|false`);
  const r = sh('_plugin_enter_workspace true\necho "ROOT=$BOTFERENCE_PROJECT_ROOT"', { cwd: wsB, home });
  assert.match(r.out, new RegExp(`ROOT=${real(wsB)}$`, 'm'));
  assert.equal(memo(home), real(wsB));
});

test('a remembered workspace that no longer exists is forgotten', () => {
  const gone = tmp('gone');
  sh(`_plugin_remember_workspace "${gone}"`, { cwd: wsB, home });
  fs.rmSync(gone, { recursive: true, force: true });
  assert.equal(pick('false', { cwd: wsB, home }), `${real(wsB)}|false`);
});

test('entering a sticky workspace says so in exactly one line', () => {
  sh(`_plugin_remember_workspace "${real(wsA)}"`, { cwd: wsA, home });
  const away = sh('_plugin_enter_workspace false\necho "ROOT=$BOTFERENCE_PROJECT_ROOT"\necho "PWD=$(pwd -P)"',
    { cwd: wsB, home });
  const lines = away.out.replace(/\n+$/, '').split('\n');
  assert.equal(lines.length, 3, away.out);
  assert.equal(lines[0], `📦 workspace: ${real(wsA)}  (run with --here to use the current directory instead)`);
  assert.equal(lines[1], `ROOT=${real(wsA)}`);
  assert.equal(lines[2], `PWD=${real(wsA)}`, 'and it moves there before the server starts');
  const here = sh('_plugin_enter_workspace false\necho done', { cwd: wsA, home });
  assert.equal(here.out.trim(), 'done', 'standing in the workspace, it says nothing');
});

// --- flag validation ----------------------------------------------------
test('--hosted without a password refuses to start, and points at --share', () => {
  const r = launcher(['--hosted'], { cwd: wsA, home });
  assert.equal(r.code, 2);
  assert.match(r.out, /--hosted requires PLUGIN_PASSWORD/);
  assert.match(r.out, /--share, which generates one/);
});

test('autostart and sharing are refused as a combination', () => {
  for (const args of [['--install-autostart', '--share'], ['--install-autostart', '--hosted']]) {
    const r = launcher(args, { cwd: wsA, home });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.out, /cannot be combined with --hosted\/--share/);
  }
});

test('an unknown flag is still an unknown flag', () => {
  const r = launcher(['--shared'], { cwd: wsA, home });
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown plugin option '--shared'/);
});

test('--help documents the sharing flags and the sticky workspace', () => {
  const r = launcher(['--help'], { cwd: wsA, home });
  assert.equal(r.code, 0);
  for (const bit of ['--share', '--hosted', '--here', 'PLUGIN_PASSWORD', 'grants.json',
    'sticky', 'plugin-workspace', '/pages']) {
    assert.ok(r.out.includes(bit), `plugin_usage must mention ${bit}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(`failed: ${failures.join(', ')}`); process.exit(1); }
