#!/usr/bin/env node
// botference profile — whose accounts and history the bots run under.
//
//   botference profile                    list profiles, mark the active one
//   botference profile init <name>        adopt this machine's current accounts
//                                         and history as the first profile
//   botference profile add <name>         a new profile with its own dirs, then
//                                         sign its Claude and Codex in
//   botference profile login <name> [claude|codex]
//                                         sign a profile's bots in (again)
//   botference profile use <name>         switch the whole machine to it and
//                                         restart the Discuss companion and the
//                                         council so they run under it
//   botference profile remove <name> [--delete-data]
//                                         forget a profile; its files stay
//                                         unless --delete-data
//
// See shared/profiles.mjs for the registry and what a profile holds.
import { spawnSync } from 'node:child_process';
import * as P from './profiles.mjs';

const [cmd = 'list', ...rest] = process.argv.slice(2);
const out = s => process.stdout.write(s + '\n');
const die = (s, code = 1) => { process.stderr.write(`✗ ${s}\n`); process.exit(code); };

function account(line, a) {
  if (!a.signed_in) return `${line}: not signed in`;
  return `${line}: ${a.email || (a.method === 'api-key' ? 'API key' : 'signed in')}`;
}

function list() {
  const rows = P.profilesWithAccounts();
  if (!rows.length) {
    out('No profiles yet. `botference profile init <name>` adopts the current accounts and history as the first one.');
    return;
  }
  for (const p of rows) {
    out(`${p.active ? '●' : '○'} ${p.name}${p.active ? '  (active)' : ''}`);
    out(`    ${account('claude', p.claude)}`);
    out(`    ${account('codex ', p.codex)}`);
  }
}

function login(name, which = 'both') {
  const p = P.listProfiles().find(x => x.name === name);
  if (!p) die(`no profile named "${name}"`);
  const run = (bin, args, envName, dir) => {
    const env = { ...process.env };
    if (dir) env[envName] = dir; else delete env[envName];
    out(`\n→ ${bin} ${args.join(' ')}  (${envName}=${dir || 'default'})`);
    const r = spawnSync(bin, args, { stdio: 'inherit', env });
    if (r.error) out(`  could not run ${bin}: ${r.error.message}`);
    else if (r.status !== 0) out(`  ${bin} exited ${r.status}`);
  };
  if (which === 'both' || which === 'claude') run('claude', ['auth', 'login'], 'CLAUDE_CONFIG_DIR', p.claude_config_dir);
  if (which === 'both' || which === 'codex') run('codex', ['login'], 'CODEX_HOME', p.codex_home);
}

try {
  switch (cmd) {
    case 'list': case 'ls': list(); break;
    case 'current': {
      const a = P.activeProfile();
      out(a ? a.name : '(no profiles)');
      break;
    }
    case 'init': {
      const r = P.initRegistry(rest[0]);
      if (!r.ok) die(r.error);
      out(`Profile "${r.name}" now holds this machine's current accounts and history, unchanged. It is active.`);
      break;
    }
    case 'add': {
      const r = P.addProfile(rest[0]);
      if (!r.ok) die(r.error);
      out(`Profile "${r.name}" created under ${P.profilesRoot()}/${r.name}.`);
      if (!rest.includes('--no-login')) login(r.name);
      out(`\nSwitch to it with: botference profile use ${r.name}`);
      break;
    }
    case 'login': {
      const which = rest[1] || 'both';
      if (!['both', 'claude', 'codex'].includes(which)) die('login <name> [claude|codex]');
      login(rest[0], which);
      break;
    }
    case 'use': {
      const r = P.setActive(rest[0]);
      if (!r.ok) die(r.error);
      if (!r.changed) { out(`Already on profile "${r.name}".`); break; }
      const restarted = P.restartServices();
      out(`Active profile: ${r.name} (was ${r.from}).`);
      out(restarted.length
        ? `Restarted: ${restarted.join(', ')}.`
        : process.env.BOTFERENCE_SECRETS_DIR
          ? 'BOTFERENCE_SECRETS_DIR is set, so this is not the registry the services read; nothing restarted.'
          : 'No botference services are loaded here; whatever you start next runs under it.');
      break;
    }
    case 'remove': case 'rm': {
      const r = P.removeProfile(rest[0], { deleteData: rest.includes('--delete-data') });
      if (!r.ok) die(r.error);
      out(r.deleted ? `Removed "${r.name}" and deleted ${r.deleted}.` : `Removed "${r.name}". Its files are still at ${r.kept}.`);
      break;
    }
    case 'help': case '-h': case '--help':
      out('botference profile [list|current|init <name>|add <name> [--no-login]|login <name> [claude|codex]|use <name>|remove <name> [--delete-data]]');
      break;
    default:
      die(`unknown profile command "${cmd}" (try: botference profile help)`, 2);
  }
} catch (e) {
  die(e.message || String(e));
}
