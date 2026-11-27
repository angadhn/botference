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
import { claudeVersionSync, CLAUDE_FETCH_RULES_VERSION, FETCH_OFF_SAY, codexInstallSync, codexRunFor } from './oneshot.mjs';

export function main(argv, { config = () => readConfig(), configPath = CONFIG_PATH, home = os.homedir(), say = s => process.stdout.write(`${s}\n`),
  claudeVersion = () => claudeVersionSync(), codexInstall = () => codexInstallSync() } = {}) {
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
  // Codex: what its run would be held as on THIS install (oneshot.mjs codexRunFor: the version of the program PATH resolves to now,
  // and whether its code-mode helper is beside it), in plain words
  const install = codexInstall() || {};
  const cv = String(install.version || '');
  const held = codexRunFor({ caps: v.roots.length ? 'web+notes' : 'web', roots: v.roots, version: cv, helper: !!install.helper });
  if (held.run === 'notes') say(`Codex CLI ${cv}: Codex passages read (only read) the same folders, through the companion's notes reader, and search the web.`);
  else if (held.run === 'web-helper') say(`Codex CLI ${cv}: Codex passages search the web (no folders are set).`);
  else say(`Codex CLI ${cv || '(version unknown)'}: ${held.note}. Codex passages run without notes and without a working web search.`);
  if (v.roots.length) {
    say('A difference to know: a Claude notes passage fetches pages only from the sites your line names. A Codex notes passage keeps its');
    say('  provider\'s web search with no limit by site, so a page or a note that tells the agent to do so could carry text from a note to an');
    say('  outside site. You asked for both agents to have the web and the notes; to keep Codex off the notes, take `codex` out of');
    say('  NOTES_AGENTS (tk-read.mjs).');
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
