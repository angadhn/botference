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
    'sticky', 'plugin-workspace', '/pages', '--install-tunnel', '--uninstall-tunnel',
    'plugin.botference.com', 'plugin-password']) {
    assert.ok(r.out.includes(bit), `plugin_usage must mention ${bit}`);
  }
});

test('--install-tunnel is a one-off install, not a way to start a server', () => {
  for (const args of [['--install-tunnel', '--service'], ['--install-tunnel', '--share'],
    ['--install-tunnel', '--hosted'], ['--install-tunnel', '--install-autostart']]) {
    const r = launcher(args, { cwd: wsA, home });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.out, /--install-tunnel is a one-off install/);
  }
});

// --- the permanent public address --------------------------------------
// Nothing here may reach the real Cloudflare account, the real launchd, or
// the companion that is running on this machine right now, so cloudflared,
// launchctl and curl are shims on PATH that only write down what they were
// asked to do. plutil is deliberately REAL: it is what proves the plists we
// emit are loadable, which is the only part launchd would have told us.
const UUID = '11111111-2222-3333-4444-555555555555';
function fakeBin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };
  write('cloudflared', `
printf '%s\\n' "$*" >> "$CFD_LOG"
state="$HOME/.cloudflared/fake-tunnels.json"
case "$1 $2" in
  "tunnel list") [ -f "$state" ] && cat "$state" || echo '[]' ;;
  "tunnel create")
    printf '[{"id":"${UUID}","name":"%s","deleted_at":null}]\\n' "$3" > "$state"
    : > "$HOME/.cloudflared/${UUID}.json" ;;
  "tunnel route")
    if [ "\${CFD_ROUTE_TAKEN:-}" = 1 ]; then
      echo "Failed to add route: An A, AAAA, or CNAME record with that host already exists." >&2
      exit 1
    fi
    echo "Added CNAME $4 which will route to this tunnel" ;;
esac
exit 0`);
  write('launchctl', 'printf \'%s\\n\' "$*" >> "$LAUNCHCTL_LOG"\nexit 0');
  // the live companion answers on 4189; never ask it anything
  write('curl', 'exit 1');
  return dir;
}

{
  const thome = tmp('tunnelhome');
  const tws = tmp('tunnelws');
  const bin = fakeBin(path.join(thome, 'bin'));
  const cfdLog = path.join(thome, 'cloudflared.log');
  const lcLog = path.join(thome, 'launchctl.log');
  fs.mkdirSync(path.join(thome, '.cloudflared'), { recursive: true });
  fs.writeFileSync(path.join(thome, '.cloudflared', 'cert.pem'), 'not-a-real-cert\n');
  const tenv = {
    HOME: thome, PATH: `${bin}:${process.env.PATH}`,
    BOTFERENCE_HOME: REPO, CFD_LOG: cfdLog, LAUNCHCTL_LOG: lcLog,
  };
  const tsh = (script, extra = {}) =>
    sh(script, { cwd: tws, home: thome, env: { ...tenv, ...extra } });
  const p = (...bits) => path.join(thome, ...bits);
  const AGENT = p('Library', 'LaunchAgents', 'com.botference.plugin-web.plist');
  const TUNNEL_AGENT = p('Library', 'LaunchAgents', 'com.botference.plugin-tunnel.plist');
  const CONFIG = p('.cloudflared', 'botference-plugin.yml');
  const PWFILE = p('.botference', 'plugin-password');
  const read = f => fs.readFileSync(f, 'utf8');
  const logLines = f => (fs.existsSync(f) ? read(f).trim().split('\n').filter(Boolean) : []);

  test('the ingress config points the hostname at the local companion, and 404s the rest', () => {
    const r = tsh(`plugin_tunnel_config "${UUID}" /creds.json plugin.botference.com 4189`);
    assert.match(r.out, /^tunnel: 11111111-2222-3333-4444-555555555555$/m);
    assert.match(r.out, /^credentials-file: \/creds\.json$/m);
    assert.match(r.out, /^ {2}- hostname: plugin\.botference\.com$/m);
    assert.match(r.out, /^ {4}service: http:\/\/127\.0\.0\.1:4189$/m);
    assert.match(r.out, /^ {2}- service: http_status:404$/m,
      'without a catch-all rule cloudflared refuses to start');
  });

  test('the tunnel LaunchAgent runs cloudflared and never gives up on it', () => {
    const r = tsh('plugin_tunnel_plist com.botference.plugin-tunnel /opt/homebrew/bin/cloudflared /cfg.yml /log.txt');
    const lint = path.join(thome, 'lint.plist');
    fs.writeFileSync(lint, r.out);
    execFileSync('plutil', ['-lint', lint]);
    const args = JSON.parse(execFileSync('plutil',
      ['-extract', 'ProgramArguments', 'json', '-o', '-', lint], { encoding: 'utf8' }));
    assert.deepEqual(args, ['/opt/homebrew/bin/cloudflared', 'tunnel', '--no-autoupdate', '--config', '/cfg.yml', 'run']);
    assert.match(r.out, /<key>KeepAlive<\/key>\s*<true\/>/,
      'a tunnel that exits cleanly (the edge hung up) must still come back');
    assert.match(r.out, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.ok(r.out.includes('/log.txt'));
  });

  test('a password is four words and a number, and is not a hex blob', () => {
    const r = tsh('_plugin_generate_password');
    assert.match(r.out.trim(), /^[a-z]{3,}(-[a-z]{3,}){3}-\d\d$/, r.out);
    const again = tsh('_plugin_generate_password');
    assert.notEqual(again.out.trim(), r.out.trim(), 'and it is random');
  });

  test('--install-tunnel creates the tunnel, routes DNS, and installs both agents', () => {
    const r = tsh('plugin_tunnel_install "" ');
    assert.equal(r.code, 0, r.out);
    const cfd = logLines(cfdLog).join('\n');
    assert.match(cfd, /^tunnel create botference-plugin$/m);
    assert.match(cfd, /^tunnel route dns botference-plugin plugin\.botference\.com$/m);
    assert.ok(fs.existsSync(CONFIG), 'the ingress config is written');
    assert.match(read(CONFIG), new RegExp(`credentials-file: ${p('.cloudflared', `${UUID}.json`)}`));
    assert.ok(fs.existsSync(TUNNEL_AGENT), 'the tunnel LaunchAgent is installed');
    execFileSync('plutil', ['-lint', TUNNEL_AGENT]);
    assert.ok(fs.existsSync(AGENT), 'and the companion gets one too');
    execFileSync('plutil', ['-lint', AGENT]);
    const lc = logLines(lcLog).join('\n');
    assert.match(lc, /bootstrap gui\/\d+ .*com\.botference\.plugin-tunnel\.plist/);
    assert.match(lc, /bootstrap gui\/\d+ .*com\.botference\.plugin-web\.plist/);
    assert.match(r.out, /https:\/\/plugin\.botference\.com\/pages/, 'and it says where to go');
  });

  test('the companion agent moves to hosted mode, and never carries the password', () => {
    const args = JSON.parse(execFileSync('plutil',
      ['-extract', 'ProgramArguments', 'json', '-o', '-', AGENT], { encoding: 'utf8' }));
    assert.ok(args.includes('--hosted'), args.join(' '));
    assert.equal(args.filter(a => a === '--hosted').length, 1);
    const pw = read(PWFILE).trim();
    assert.ok(pw.length > 10);
    assert.ok(!read(AGENT).includes(pw), 'a plist is world-readable and gets backed up');
    assert.ok(!read(TUNNEL_AGENT).includes(pw));
    assert.equal(fs.statSync(PWFILE).mode & 0o777, 0o600, 'and the file it does live in is 0600');
    assert.ok(!read(AGENT).includes('PLUGIN_PASSWORD'),
      'not even as an environment key launchd would fill in');
  });

  test('--hosted with no password in the environment reads the file launchd cannot hold', () => {
    // This is exactly what the installed LaunchAgent does: launchd starts the
    // LAUNCHER, and the launcher reads the 0600 file. `node` is a shim here so
    // the server is never actually started — it just records its own argv and
    // the password it was handed.
    const pw = read(PWFILE).trim();
    const nodeDir = path.join(thome, 'nodebin');
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(path.join(nodeDir, 'node'),
      '#!/usr/bin/env bash\nprintf \'%s|%s\\n\' "$*" "${PLUGIN_PASSWORD:-}" >> "$NODE_LOG"\nexit 0\n',
      { mode: 0o755 });
    const nodeLog = path.join(thome, 'node.log');
    const r = tsh('run_plugin_mode --hosted', {
      PATH: `${nodeDir}:${bin}:${process.env.PATH}`, NODE_LOG: nodeLog, PLUGIN_PASSWORD: '',
    });
    assert.equal(r.code, 0, r.out);
    const line = logLines(nodeLog).pop() || '';
    assert.match(line, /server\.mjs --hosted\|/, line);
    assert.equal(line.split('|').pop(), pw, 'the server is handed the password from the file');
    assert.match(r.out, /public address: https:\/\/plugin\.botference\.com\/pages/,
      'and a hosted companion behind the tunnel says where it can be reached');
  });

  test('--hosted with no password anywhere still refuses, and names the file', () => {
    const bare = tmp('nopwhome');
    const r = sh('run_plugin_mode --hosted', { cwd: tws, home: bare, env: { ...tenv, HOME: bare, PLUGIN_PASSWORD: '' } });
    assert.equal(r.code, 2);
    assert.match(r.out, /--hosted requires PLUGIN_PASSWORD/);
    assert.match(r.out, /--install-tunnel, which saves one in/);
  });

  test('running it again reuses the tunnel and keeps the password', () => {
    const pw = read(PWFILE).trim();
    fs.writeFileSync(cfdLog, '');
    const r = tsh('plugin_tunnel_install "" ', { CFD_ROUTE_TAKEN: '1' });
    assert.equal(r.code, 0, r.out);
    const cfd = logLines(cfdLog).join('\n');
    assert.ok(!/tunnel create/.test(cfd), 'a second create would just be an error');
    assert.match(r.out, /already exists — reusing it/);
    assert.match(r.out, /was already routed here/, 'an existing DNS record is success, not failure');
    assert.equal(read(PWFILE).trim(), pw, 'rotating it would lock the phone out');
    assert.match(r.out, /keeping the one already in/);
  });

  test('an install on top of an existing companion agent keeps its port and workspace', () => {
    // pretend the user had installed the plain companion for wsA on 4200
    tsh(`BOTFERENCE_PROJECT_ROOT="${real(tws)}" PLUGIN_AUTOSTART_QUIET=true \\
      plugin_autostart_install 4200 --no-agents --port 4200`);
    const r = tsh('plugin_tunnel_install "" ');
    assert.equal(r.code, 0, r.out);
    const args = JSON.parse(execFileSync('plutil',
      ['-extract', 'ProgramArguments', 'json', '-o', '-', AGENT], { encoding: 'utf8' }));
    assert.deepEqual(args.slice(-4), ['--hosted', '--no-agents', '--port', '4200'],
      'the flags it was installed with survive, with exactly one --hosted added');
    assert.match(read(CONFIG), /service: http:\/\/127\.0\.0\.1:4200/,
      'and the tunnel follows the companion to that port');
  });

  test('--uninstall-tunnel stops the tunnel and puts the companion back on localhost', () => {
    fs.writeFileSync(lcLog, '');
    const r = tsh('plugin_tunnel_uninstall');
    assert.equal(r.code, 0, r.out);
    assert.ok(!fs.existsSync(TUNNEL_AGENT), 'the tunnel agent is gone');
    assert.match(logLines(lcLog).join('\n'), /bootout gui\/\d+\/com\.botference\.plugin-tunnel/);
    const args = JSON.parse(execFileSync('plutil',
      ['-extract', 'ProgramArguments', 'json', '-o', '-', AGENT], { encoding: 'utf8' }));
    assert.ok(!args.includes('--hosted'), 'the companion is private again');
    assert.deepEqual(args.slice(-3), ['--no-agents', '--port', '4200'], 'and otherwise unchanged');
    assert.ok(fs.existsSync(PWFILE), 'the password survives, so re-installing is one command');
    assert.match(r.out, /cloudflared tunnel delete botference-plugin/,
      'the account-level cleanup is named but never done for you');
  });

  test('--uninstall-tunnel is safe when nothing was installed', () => {
    const bare = tmp('barehome');
    fs.mkdirSync(path.join(bare, 'Library', 'LaunchAgents'), { recursive: true });
    const r = sh('plugin_tunnel_uninstall',
      { cwd: tws, home: bare, env: { ...tenv, HOME: bare } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /No tunnel LaunchAgent was installed/);
  });

  test('--install-tunnel refuses to guess when cloudflared is missing or logged out', () => {
    const nologin = tmp('nologin');
    const r = sh('plugin_tunnel_install "" ',
      { cwd: tws, home: nologin, env: { ...tenv, HOME: nologin } });
    assert.equal(r.code, 1);
    assert.match(r.out, /cloudflared tunnel login/);
    const empty = tmp('nocfd');
    const r2 = sh('plugin_tunnel_install "" ', {
      cwd: tws, home: empty,
      env: { ...tenv, HOME: empty, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    assert.equal(r2.code, 1);
    assert.match(r2.out, /brew install cloudflared/);
  });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(`failed: ${failures.join(', ')}`); process.exit(1); }
