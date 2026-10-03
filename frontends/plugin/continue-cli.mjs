#!/usr/bin/env node
// continue-cli.mjs — `botference discuss continue`: the drawer's "continue in
// council" button, from a terminal.
//
//   botference discuss continue <url | words from the title or address>
//       [--council <root>] [--project <id> | --inbox] [--fresh]
//       [--council-web <base>] [--dry-run]
//   botference discuss continue --list [words]
//
// Same implementation as POST /continue-in-council (council-handoff.mjs), run
// straight against the files on disk — so it works whether or not the
// companion is running, and from a machine where the only thing in front of
// you is a shell. It prints the council chat's id and its link.
//
// The page is named by its address, or by a few words of its title or
// address ("lesswrong", "conquer what you cannot"). More than one match is
// listed and nothing is written: this never picks between two pages for you.
//
// One thing differs from the button: a page record written here while the
// companion is also writing the same page can lose the receipt (the list of
// copies on the page) to the companion's next save. The council chat itself
// is unaffected — it lives in the council, not in the record.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const say = s => process.stdout.write(s + '\n');
const die = (s, code = 2) => { process.stderr.write(`Error: ${s}\n`); process.exit(code); };

const USAGE = `Usage: botference discuss continue <url | words> [--council <root>] [--project <id> | --inbox]
                                   [--fresh] [--council-web <base>] [--dry-run]
       botference discuss continue --list [words]

Copy a Discuss page's chat and margin comments into your council as a chat of
its own, and print its link. The page keeps its chat; nothing is sent to a bot.`;

// The companion's workspace, found the way \`botference discuss\` finds it: the
// environment if the launcher set it, else the remembered one, else here.
function pluginWorkspace() {
  if (process.env.BOTFERENCE_PROJECT_ROOT) return process.env.BOTFERENCE_PROJECT_ROOT;
  try {
    const saved = fs.readFileSync(path.join(os.homedir(), '.botference', 'plugin-workspace'), 'utf8')
      .split('\n')[0].trim();
    if (saved && fs.existsSync(saved)) return saved;
  } catch { /* first run, or never run */ }
  return process.cwd();
}

function parse(argv) {
  const o = { words: [], council: '', project: null, fresh: false, web: '', dry: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
    if (a === '--help' || a === '-h') { say(USAGE); process.exit(0); }
    else if (a === '--council') o.council = val();
    else if (a === '--project') o.project = val();
    else if (a === '--inbox') o.project = '';
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--council-web') o.web = val();
    else if (a === '--dry-run') o.dry = true;
    else if (a === '--list') o.list = true;
    else if (a.startsWith('--')) die(`unknown option ${a}\n\n${USAGE}`);
    else o.words.push(a);
  }
  return o;
}

async function main() {
  const o = parse(process.argv.slice(2));
  // store.mjs reads its workspace from the environment AT IMPORT, so it is
  // set first and the modules are loaded after
  process.env.BOTFERENCE_PROJECT_ROOT = pluginWorkspace();
  if (!process.env.BOTFERENCE_HOME) process.env.BOTFERENCE_HOME = path.resolve(HERE, '..', '..');
  const store = await import('./store.mjs');
  const workspace = await import('./workspace.mjs');
  const handoff = await import('./council-handoff.mjs');

  const index = store.readIndex();
  const rows = Object.values(index).filter(r => r && r.url)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const q = o.words.join(' ').trim();
  const exact = q ? rows.filter(r => r.url === store.normUrl(q)) : [];
  const needle = q.toLowerCase();
  const hits = exact.length ? exact
    : rows.filter(r => !needle || `${r.title || ''} ${r.url}`.toLowerCase().includes(needle));

  if (o.list || !q) {
    if (!q && !o.list) { say(USAGE); process.exit(2); }
    for (const r of hits.slice(0, 40)) say(`${String(r.updated_at || '').slice(0, 16)}  ${r.title || '(untitled)'}\n    ${r.url}`);
    if (!hits.length) say('no pages match');
    return;
  }
  if (!hits.length) die(`no Discuss page matches “${q}” (try --list)`);
  if (hits.length > 1) {
    process.stderr.write(`“${q}” matches ${hits.length} pages — name one by its address:\n`);
    for (const r of hits.slice(0, 20)) process.stderr.write(`  ${r.title || '(untitled)'}\n    ${r.url}\n`);
    process.exit(2);
  }
  const page = store.readPage(hits[0].url);
  if (!page) die('that page record could not be read');
  if (workspace.artifactState(store.normUrl(page.url))) {
    die('this page’s chat already lives in your council (it is a project artifact page)');
  }

  // the council: named, else the one used last, else the only confirmed one
  const cfg = store.readConfig();
  const confirmed = workspace.knownCouncilRoots().filter(r => workspace.rootState(r) === 'yes');
  const last = workspace.realish(String(cfg.last_council_root || ''));
  const root = o.council ? workspace.realish(o.council)
    : (confirmed.includes(last) ? last : confirmed[0] || '');
  if (!root) die('no council confirmed yet — pass --council <root>');
  if (!workspace.isCouncilRoot(root)) die(`${root} is not a council (no project.json + work/ + projects/)`);
  const projectId = o.project != null ? o.project : handoff.defaultProject(store.projectsOf(page), root);
  const key = store.pageKey(page.url);
  const snapshotPath = store.hasSnapshot(key) ? store.snapshotFile(key) : '';

  if (o.dry) {
    const { note, body } = handoff.handoffEntries(page, { owner: String(cfg.author || ''), snapshotPath });
    say(`page:    ${store.displayTitle(page)}\n         ${page.url}`);
    say(`council: ${root}${projectId ? `  (project ${projectId})` : '  (unfiled — the Inbox)'}`);
    say(`entries: ${body.length + 1}\n`);
    for (const e of [note, ...body]) say(`[${e.speaker}] ${e.text.length > 300 ? e.text.slice(0, 300) + '…' : e.text}\n`);
    return;
  }

  const r = handoff.continueInCouncil(page, {
    root, projectId,
    home: process.env.BOTFERENCE_HOME,
    python: process.env.BOTFERENCE_PYTHON_BIN || process.env.PLUGIN_PYTHON || 'python3',
    councilWeb: o.web || String(cfg.council_web || handoff.COUNCIL_WEB_DEFAULT),
    owner: String(cfg.author || ''),
    snapshotPath,
    fresh: o.fresh,
  });
  if (!r.ok) die(r.error, 1);
  if (!r.reused) store.savePage(page);
  say(`${r.reused ? 'Already in the council (nothing new since the last copy)' : 'Copied into the council'}: ${page.custom_title || page.title || page.url}`);
  say(`  chat:    ${r.session_id}${r.project_id ? `  (project ${r.project_id})` : '  (unfiled — the Inbox)'}`);
  say(`  open:    ${r.url}`);
}

main().catch(e => die(e && e.stack || String(e), 1));
