#!/usr/bin/env node
// blyg-home-cli.mjs — `botference blyg-home`: the ONE way to change "Where my blyg lives" (the Publish-as-blyg command set).
//
//   botference blyg-home show               what is set, whether it is valid, and which config file it is in
//   botference blyg-home check <file.json>  validate a file (the setting itself, or {"blyg_home": {…}}) and print every problem
//   botference blyg-home set <file.json>    validate, then write it to the companion's config.json (refused while a run is under way)
//   botference blyg-home example            print an example for a Jekyll blog that uses scripts/blyg-publish
//
// The setting decides what commands run on this machine, so it is never writable over HTTP (server.mjs answers 405 to any write);
// this runs on the machine, as the owner, in the environment the companion is started with (BOTFERENCE_PROJECT_ROOT decides which
// config.json: `show` names it). Exit 0: done / valid; 1: not valid or refused; 2: usage.
import fs from 'node:fs';
import path from 'node:path';
import { validateHome, storable } from './blyg-home.mjs';
import { readConfig, saveConfig, CONFIG_PATH, DIR } from './store.mjs';
import { readJsonState } from './fsjson.mjs';
import { RUN_LIVE, migrateRecord } from './blyg-run.mjs';

const say = s => process.stdout.write(s + '\n');
const usage = () => { process.stderr.write('Usage: botference blyg-home show | check <file.json> | set <file.json> | example\n'); process.exit(2); };

export const EXAMPLE = Object.freeze({
  folder: '/path/to/your/blog/_notes',
  filename: '${slug}.md',
  timezone: 'Europe/London',
  confirm: 'always',
  plan_guard: ['--only-note', '--quick'],
  published_marker: 'State: merged_back',
  env_pass: ['BLYG_CHECKER'],
  // the owner's local preview site (it serves the working branch's drafts); the drawer shows a picture of the draft from it
  preview_url: 'http://127.0.0.1:4000{permalink}',
  preview_selector: 'article',
  commands: {
    check: ['scripts/blyg-publish', '--preflight'],
    prepare: ['scripts/blyg-publish', '{note}', '--prepare-note'],
    plan: ['scripts/blyg-publish', '{note}'],
    apply: ['scripts/blyg-publish', '{note}', '--apply'],
    publish: ['scripts/blyg-publish', '{note}', '--push'],
    // publishing again: a new version of a post already published from here (the changelog line is written by the companion)
    plan_edit: ['scripts/blyg-publish', '{note}', '--edit', '--generated-note', '{changelog}'],
    apply_edit: ['scripts/blyg-publish', '{note}', '--edit', '--generated-note', '{changelog}', '--apply'],
    publish_edit: ['scripts/blyg-publish', '{note}', '--edit', '--generated-note', '{changelog}', '--push'],
    discard: ['scripts/blyg-publish', '{note}', '--unstage-note'],
    abandon: ['scripts/blyg-publish', '--abandon', '{note}'],
  },
});

function readSettingFile(file) {
  if (!file) usage();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { say(`Not valid: ${file} is not a readable JSON file (${e.message.slice(0, 120)}).`); process.exit(1); }
  return raw && typeof raw === 'object' && !Array.isArray(raw) && raw.blyg_home && typeof raw.blyg_home === 'object' ? raw.blyg_home : raw;
}
function report(v) {
  if (v.ok) { say('Valid.'); return; }
  say(`Not valid (${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}):`);
  for (const e of v.errors) say(`  - ${e}`);
}
function liveRun() {
  const got = readJsonState(path.join(DIR, 'blyg-publish-run.json'));
  if (got.state !== 'ok' || !got.value) return '';
  const mode = migrateRecord(got.value).mode;
  return RUN_LIVE.includes(mode) ? mode : '';
}

export function main(argv) {
  const [cmd, file] = argv;
  if (cmd === 'example') { say(JSON.stringify(EXAMPLE, null, 2)); return 0; }
  if (cmd === 'show') {
    const raw = readConfig().blyg_home;
    say(`config file: ${CONFIG_PATH}`);
    if (!raw) { say('Where my blyg lives is not set. Start from: botference blyg-home example > blyg-home.json'); return 1; }
    say(JSON.stringify(storable(raw), null, 2));
    const v = validateHome(raw);
    report(v);
    const live = liveRun();
    if (live) say(`A publish run is under way (${live}).`);
    return v.ok ? 0 : 1;
  }
  if (cmd === 'check') { const v = validateHome(readSettingFile(file)); report(v); return v.ok ? 0 : 1; }
  if (cmd === 'set') {
    const raw = readSettingFile(file);
    const v = validateHome(raw);
    report(v);
    if (!v.ok) { say('Nothing was written.'); return 1; }
    const live = liveRun();
    if (live) { say(`A publish run is under way (${live}): finish or abandon it in the drawer first. Nothing was written.`); return 1; }
    saveConfig({ blyg_home: storable(raw) });
    say(`Written to ${CONFIG_PATH}. The next Publish as blyg uses it.`);
    return 0;
  }
  usage();
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) process.exit(main(process.argv.slice(2)));
