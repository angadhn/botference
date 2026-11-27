#!/usr/bin/env node
// tk-read-cli.mjs — `botference tk-read check`: what a `/tk` passage's agent may read (tk-read.mjs), from the companion's config.json
// (BOTFERENCE_PROJECT_ROOT decides which; `check` names it). It reads the settings and writes nothing.
//   "tk_read_roots": ["/absolute/folder", …]   the folders a passage may read (none: the web only)
//   "hub_link_tk_notes": "on" | "off"           may a passage asked through your Hub read them (default off)
// Exit 0: valid; 1: a problem; 2: usage.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, CONFIG_PATH } from './store.mjs';
import { validateTkRead } from './tk-read.mjs';
import { claudeVersionSync, CLAUDE_FETCH_RULES_VERSION, FETCH_OFF_SAY } from './oneshot.mjs';

export function main(argv, { config = () => readConfig(), configPath = CONFIG_PATH, home = os.homedir(), say = s => process.stdout.write(`${s}\n`),
  claudeVersion = () => claudeVersionSync() } = {}) {
  if (argv.length !== 1 || argv[0] !== 'check') { say('Usage: botference tk-read check'); return 2; }
  const v = validateTkRead(config(), { home });
  say(`config file: ${configPath}`);
  if (!v.ok) { say(`Not valid (${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}):`); for (const e of v.errors) say(`  - ${e}`); return 1; }
  if (!v.roots.length) say('A /tk passage may read no folders: passages search the web only.');
  else {
    say('A /tk passage may read (only read) these folders:'); for (const r of v.roots) say(`  ${r}`);
    // (the fetch rules of a notes run are written for one version of Claude Code: oneshot.mjs CLAUDE_FETCH_RULES_VERSION)
    const ver = String(claudeVersion() || '');
    say(ver === CLAUDE_FETCH_RULES_VERSION ? `Claude Code ${ver}: notes runs may fetch pages from the sites their line names (searching is always allowed).`
      : `${FETCH_OFF_SAY} (${ver || 'version unknown'}; the rules are written for ${CLAUDE_FETCH_RULES_VERSION}): notes runs search the web but fetch no page. Web-only passages are unaffected.`);
  }
  say(v.hubLinkNotes === 'on' ? 'Passages asked through your Hub: web and these folders (hub_link_tk_notes is on).' : 'Passages asked through your Hub: web only (hub_link_tk_notes is off).');
  say('Codex passages: web only (Codex reads files only through a shell, which a passage never gets).');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
