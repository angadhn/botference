// blyg-home.test.mjs — the command runner and the small pure rules of "Where my blyg lives": time limits that stop a
// command AND its children, a capped output, no stdin to prompt on, the exact environment, the file name pattern.
//
//   node --test test/blyg-home.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import * as H from '../blyg-home.mjs';
import { FAKE, sleep } from './blyg-rig.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-blyghome-'));

test('a command that outlives its time limit is stopped, and so is the child it started', async () => {
  const d = tmp();
  const pidFile = path.join(d, 'child.pid');
  // a parent that starts a grandchild sleeping a minute and then waits
  const script = path.join(d, 'parent.mjs');
  fs.writeFileSync(script, `import { spawn } from 'node:child_process'; import fs from 'node:fs';
const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(()=>{},60000);`);
  const t0 = Date.now();
  const r = await H.runCommand({ argv: [process.execPath, script], cwd: d, env: H.minimalEnv(), limitMs: 400 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 6000, 'stopped promptly');
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  await sleep(200);
  assert.equal(alive(child), false, 'the grandchild is gone too: nothing is left running');
  fs.rmSync(d, { recursive: true, force: true });
});

test('output is captured and capped (head and tail kept), a flood is stopped, ANSI and control characters are removed', async () => {
  const d = tmp();
  const big = H.capOutput('a'.repeat(H.OUTPUT.kept) + 'MIDDLE' + 'z'.repeat(H.OUTPUT.kept));
  assert.equal(big.truncated, true);
  assert.ok(big.text.length < H.OUTPUT.kept + 100);
  assert.ok(big.text.startsWith('aaaa') && big.text.endsWith('zzzz') && /characters cut/.test(big.text) && !big.text.includes('MIDDLE'));
  assert.equal(H.capOutput('\u001b[31mred\u001b[0m\u0007 ok\u0000\r\nline').text, 'red ok\nline');
  const flood = await H.runCommand({ argv: [process.execPath, FAKE, path.join(d, 'l'), path.join(d, 'c'), 'x', 'n'], cwd: d, env: H.minimalEnv(), limitMs: 20000 });
  assert.equal(flood.exit, 0); // (control file absent: ok)
  fs.writeFileSync(path.join(d, 'c'), JSON.stringify({ x: 'big' }));
  const r = await H.runCommand({ argv: [process.execPath, FAKE, path.join(d, 'l'), path.join(d, 'c'), 'x', 'n'], cwd: d, env: H.minimalEnv(), limitMs: 20000 });
  assert.notEqual(r.exit, 0, 'a command that prints more than the buffer allows is stopped, not trusted');
  assert.ok(r.output.length <= H.OUTPUT.kept + 100);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a command has no stdin to prompt on (it is closed), and a missing program is a plain failure', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'c'), JSON.stringify({ x: 'prompt' }));
  const r = await H.runCommand({ argv: [process.execPath, FAKE, path.join(d, 'l'), path.join(d, 'c'), 'x', 'n'], cwd: d, env: H.minimalEnv(), limitMs: 10000 });
  assert.equal(r.exit, 3);
  assert.match(r.output, /stdin closed/);
  const gone = await H.runCommand({ argv: [path.join(d, 'no-such-program'), 'x'], cwd: d, env: H.minimalEnv(), limitMs: 5000 });
  assert.equal(gone.spawnError, 'ENOENT');
  fs.rmSync(d, { recursive: true, force: true });
});

test('the environment is stated exactly: a fixed list, copied only when set, plus the owner\'s named extras; nothing else of the companion\'s', () => {
  const from = { PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'C', SECRET_TOKEN: 's', AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'g', EXTRA_OK: 'e', NODE_OPTIONS: '--evil' };
  assert.deepEqual(H.minimalEnv([], from), { PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'C', TERM: 'dumb', NO_COLOR: '1', CI: '1', GIT_TERMINAL_PROMPT: '0' }, 'a locale the owner set is passed as it is');
  // NO locale at all (a launch agent's environment): a UTF-8 one is given, so a site's Ruby never reads text as US-ASCII
  const bare = H.minimalEnv([], { PATH: '/bin', HOME: '/h' });
  assert.deepEqual([bare.LANG, bare.LC_ALL], [H.UTF8_LOCALE, H.UTF8_LOCALE]);
  assert.match(H.UTF8_LOCALE, /^(en_US|C)\.UTF-8$/);
  assert.equal(H.minimalEnv([], { PATH: '/bin', LC_CTYPE: 'en_GB.UTF-8' }).LANG, undefined, 'LC_CTYPE alone counts as a locale set');
  assert.equal(H.minimalEnv(['EXTRA_OK', 'NOT_SET'], from).EXTRA_OK, 'e');
  assert.ok(!('NOT_SET' in H.minimalEnv(['NOT_SET'], from)));
  assert.deepEqual(H.BASE_ENV_NAMES.slice().sort(), ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']);
});

test('the edit commands go together, carry {changelog} as an argument of their own, and only they may; preview_url is an http(s) template', () => {
  const d = tmp();
  execFileSync('git', ['init', '-q', d]);
  fs.mkdirSync(path.join(d, '_notes'));
  const prog = process.execPath;
  const base = { folder: path.join(d, '_notes'), commands: { plan: [prog, '{note}'], apply: [prog, '{note}'], publish: [prog, '{note}'] } };
  const edits = { plan_edit: [prog, '{note}', '--edit', '--generated-note', '{changelog}'], apply_edit: [prog, '{note}', '{changelog}'], publish_edit: [prog, '{note}', '{changelog}'] };
  assert.ok(H.validateHome({ ...base, commands: { ...base.commands, ...edits } }).ok);
  assert.match(H.validateHome({ ...base, commands: { ...base.commands, plan_edit: edits.plan_edit } }).errors.join(), /go together/);
  assert.match(H.validateHome({ ...base, commands: { ...base.commands, plan: [prog, '{note}', '{changelog}'] } }).errors.join(), /only for the edit commands/);
  assert.match(H.validateHome({ ...base, commands: { ...base.commands, ...edits, apply_edit: [prog, '{note}', '--note={changelog}'] } }).errors.join(), /argument of its own/);
  assert.deepEqual(H.expandArgv(edits.plan_edit, { rel: 'n.md', abs: '/n.md', changelog: 'Edited the second comment. --push ; rm' }), [prog, 'n.md', '--edit', '--generated-note', 'Edited the second comment. --push ; rm'], 'one argument, never split');
  assert.deepEqual(H.COMMAND_FOR.edit, { plan: 'plan_edit', apply: 'apply_edit', publish: 'publish_edit' });
  for (const [t, ok] of [['http://127.0.0.1:4000{permalink}', true], ['https://preview.example.test/{id}/', true], ['javascript:alert(1)//{permalink}', false], ['http://x.test/', false], ['http://u:p@x.test{permalink}', false], ['http://x.test/{title}', false]]) {
    assert.equal(!H.previewUrlProblem(t), ok, t);
  }
  assert.equal(H.previewUrlFor('http://127.0.0.1:4000{permalink}', { permalink: '/b/0abc' }), 'http://127.0.0.1:4000/b/0abc');
  assert.equal(H.previewUrlFor('http://127.0.0.1:4000{permalink}', { permalink: '/b/x"><script>' }), '', 'only a plain path is put in');
  assert.match(H.validateHome({ ...base, preview_selector: 'article { } <x>' }).errors.join(), /preview_selector/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('{note} becomes ONE argument whatever it holds; it is never split, never interpreted, and never replaces the program', () => {
  const rel = '_notes/it\'s "quoted" $(rm -rf ~) ; & | `x` {note} *.md';
  const out = H.expandArgv(['scripts/p', '{note}', '--file={note}', '{note_abs}', '--x'], { rel, abs: '/abs/' + rel });
  assert.deepEqual(out, ['scripts/p', rel, `--file=${rel}`, '/abs/' + rel, '--x']);
  assert.equal(H.expandArgv(['{note}', '{note}'], { rel: 'r', abs: 'a' })[0], '{note}', 'the program is never expanded');
});

test('the file name pattern and the names it makes', () => {
  assert.ok(H.checkFilename('${slug}.md').ok && H.checkFilename('${date} ${slug}.md').ok);
  for (const bad of ['', 'a.md', '${slug}', '../${slug}.md', '${slug}/x.md', '.${slug}.md', '${slug}..md', '${slug}${x}.md', '${slug}$.md', '${slug}\n.md', '${slug}.md ; rm'.replace(' ; rm', ';x'), 'x'.repeat(200) + '${slug}.md']) {
    assert.equal(H.checkFilename(bad).ok, false, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(H.filenameFor('${date} ${slug}.md', { slug: 'a-b', date: '2026-11-23' }), '2026-11-23 a-b.md');
  assert.throws(() => H.filenameFor('${slug}.md', { slug: '../x', date: 'd' }), /unusable/);
  assert.throws(() => H.filenameFor('${slug}.md', { slug: '.hidden', date: 'd' }), /unusable/);
});

test('the limits are the ones stated', () => {
  assert.deepEqual(H.TIME_LIMITS_MS, { check: 15000, prepare: 300000, plan: 120000, apply: 1800000, publish: 1800000, plan_edit: 120000, apply_edit: 1800000, publish_edit: 1800000, discard: 60000, abandon: 60000 });
  assert.deepEqual([H.OUTPUT.maxBuffer, H.OUTPUT.kept, H.ARGV.maxArgs, H.ARGV.maxArgChars], [4194304, 65536, 32, 400]);
});

test('a command\'s life is one named list in one field: every move listed or refused, an ending is left by nothing, and the ending says how it ended (no separate cause)', () => {
  for (const from of H.CMD_STATES) for (const to of H.CMD_STATES) {
    const cmd = { state: from };
    if (H.CMD_MOVES[from].includes(to)) { H.moveCmd(cmd, to); assert.equal(cmd.state, to, `${from} → ${to}`); }
    else { assert.throws(() => H.moveCmd(cmd, to), /cannot go from/, `${from} → ${to}`); assert.equal(cmd.state, from); }
  }
  for (const end of ['done', 'timed-out', 'flooded', 'failed-to-start']) assert.deepEqual(H.CMD_MOVES[end], [], `${end} is left by nothing`);
  assert.deepEqual(Object.keys(H.CMD_ENDING).sort(), ['flooding', 'running', 'spawn-failing', 'timing-out'], 'each way of ending has exactly one ending');
  assert.throws(() => H.moveCmd({ state: 'running' }, 'settled'), /no such state/);
  const src = fs.readFileSync(new URL('../blyg-home.mjs', import.meta.url), 'utf8');
  assert.ok(!/\b(timedOut|flooded|settled)\s*=/.test(src.slice(src.indexOf('export function runCommand'))), 'no boolean flags standing in for the lifecycle');
});

test('each way a command can end gives one result, once: exit, timeout, flood and a program that does not exist', async () => {
  const d = tmp();
  const one = async argv => H.runCommand({ argv, cwd: d, env: H.minimalEnv(), limitMs: 400 });
  assert.deepEqual((({ exit, timedOut, spawnError }) => ({ exit, timedOut, spawnError }))(await one([process.execPath, '-e', 'process.exit(3)'])), { exit: 3, timedOut: false, spawnError: '' });
  const slow = await one([process.execPath, '-e', 'setTimeout(()=>{},30000)']);
  assert.deepEqual([slow.timedOut, slow.exit], [true, null]);
  assert.equal((await one([path.join(d, 'nope')])).spawnError, 'ENOENT');
  const flood = await H.runCommand({ argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(5*1024*1024))"], cwd: d, env: H.minimalEnv(), limitMs: 20000 });
  assert.deepEqual([flood.spawnError, flood.exit, flood.timedOut], ['OUTPUT_LIMIT', null, false]);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- the settings page is READ ONLY (review item 1b): no form, no script, the CLI lines, and what is set ----------------------------
test('the settings page shows the setting and the CLI lines that change it, with no form and no script; every command is listed', async () => {
  const { blygHomePage, PAGE_COMMANDS } = await import('../blyg-home-page.mjs');
  assert.deepEqual([...PAGE_COMMANDS].sort(), [...H.COMMAND_KEYS].sort(), 'a row for every command');
  const settings = { folder: '/w/site/_notes', confirm: 'never', plan_guard: ['--only-note'], published_marker: 'State: merged_back', env_pass: ['BLYG_CHECKER'],
    commands: { check: ['scripts/blyg-publish', '--preflight'], plan: ['scripts/blyg-publish', '{note}'], apply: ['x', '{note}'], publish: ['</code><script>alert(1)</script>', '{note}'] } };
  const html = blygHomePage({ settings, valid: true, errors: [], defaults: { filename: '${slug}.md', escape: 'liquid', confirm: 'always' }, nonce: 'n' });
  assert.ok(!/<script|<form|<input|<textarea|onclick=|style="/i.test(html), 'no script, no form, no inline handler or style attribute');
  assert.match(html, /&lt;\/code&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'a stored value is text');
  for (const line of ['botference blyg-home show', 'botference blyg-home check', 'botference blyg-home set', 'botference blyg-home example']) assert.ok(html.includes(line), line);
  assert.match(html, /never ask \(one click publishes\)/);
  assert.match(html, /command: abandon<\/th><td><code>\(not set\)/);
});

// Review item 9: env_pass is an allow-list. BLYG_CHECKER passes; an owner's own upper-case name passes; every name that changes what a
// step's programs load, trust or fetch through is refused (one rule, case-insensitive), and so are the site's other run variables.
test('env_pass: BLYG_CHECKER and an owner\'s own name pass; loaders, proxies, CA files, GIT_*, BLYG_* run variables and lower case are refused', () => {
  const ok = ['BLYG_CHECKER', 'MY_SITE_TOKEN_NAME', 'NETLIFY_SITE', 'LANGUAGE_X'];
  const refused = ['PATH', 'HOME', 'RUBYOPT', 'RUBYLIB', 'BUNDLE_GEMFILE', 'BUNDLE_PATH', 'GEM_HOME', 'GEM_PATH', 'RBENV_VERSION', 'NODE_PATH',
    'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'PERL5OPT', 'PERL5LIB', 'PYTHONPATH', 'PYTHONSTARTUP', 'GIT_DIR', 'GIT_SSH_COMMAND', 'GIT_ANYTHING',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
    'XDG_CONFIG_HOME', 'ZDOTDIR', 'EDITOR', 'VISUAL', 'TZ', 'JEKYLL_ENV', 'BLYG_RUN_MODE', 'BLYG_PIN_CLOCK', 'BLYG_PREPARE', 'BLYG_NOTE',
    'BLYG_CHECKERX', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'ENV', 'lower', '1ABC', 'A-B', '', 5];
  for (const n of ok) assert.ok(H.envPassable(n), n);
  for (const n of refused) assert.equal(H.envPassable(n), false, String(n));
  const d = tmp();
  try {
    execFileSync('git', ['init', '-q', d]); fs.mkdirSync(path.join(d, '_notes'));
    const base = { folder: path.join(d, '_notes'), commands: { plan: ['plan', '{note}'], apply: ['apply', '{note}'], publish: ['publish', '{note}'] } };
    assert.ok(H.validateHome({ ...base, env_pass: ['BLYG_CHECKER'] }).ok);
    const v = H.validateHome({ ...base, env_pass: ['BLYG_CHECKER', 'RUBYOPT'] });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' '), /refused: "RUBYOPT"/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// (review round 5) {changelog} is ONE argument of its own: as part of a longer argument it is the letters, never the line
test('{changelog} is expanded only as a whole argument', () => {
  const out = H.expandArgv(['scripts/x', '--generated-note', '{changelog}', '--note={changelog}', 'x{changelog}y', '{note}'], { rel: '_notes/a.md', abs: '/t/_notes/a.md', changelog: 'Edited the comment; rm -rf /' });
  assert.deepEqual(out, ['scripts/x', '--generated-note', 'Edited the comment; rm -rf /', '--note={changelog}', 'x{changelog}y', '_notes/a.md']);
});
