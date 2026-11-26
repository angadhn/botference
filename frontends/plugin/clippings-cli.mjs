#!/usr/bin/env node
// clippings-cli.mjs — `botference clippings`: the owner's clippings setting for the Hub's Reading list (clippings.mjs), checked on the
// machine. It reads the setting from the companion's config.json (BOTFERENCE_PROJECT_ROOT decides which; `check` names it) and only
// the files it lists; it never writes anything.
//
//   botference clippings check   the setting's problems, then each listed file: read, or left out and why
//   botference clippings list    the collections as the Hub will see them (id, published, words, title, source)
//
// The setting (edit config.json by hand):
//   "clippings": { "folder": "/absolute/path/to/the/clippings/folder",
//                  "collections": [ { "name": "A name", "files": ["A clipped article.md", "…"] } ],
//                  "substack_hosts": ["www.example.com"],          (optional: Substack custom domains, whose s, r, … are removed)
//                  "confirmed_sources": ["https://…"] }            (optional: addresses the owner checked after a secret was taken out)
// Exit 0: valid (every listed file read); 1: a problem; 2: usage.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, CONFIG_PATH } from './store.mjs';
import { validateClippings, listClippings } from './clippings.mjs';

export function main(argv, { config = () => readConfig(), configPath = CONFIG_PATH, say = s => process.stdout.write(`${s}\n`) } = {}) {
  const [cmd, ...rest] = argv;
  if (!['check', 'list'].includes(cmd) || rest.length) { say('Usage: botference clippings check | list'); return 2; }
  const v = validateClippings(config().clippings);
  if (cmd === 'check') say(`config file: ${configPath}`);
  if (!v.ok) {
    say(`The clippings setting is not valid (${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}):`);
    for (const e of v.errors) say(`  - ${e}`);
    return 1;
  }
  const { collections, problems, changed } = listClippings(v.settings);
  // (a secret-named part of a clipping's address is never sent, and taking it out may make the address name another page: until the
  // owner adds the address as shown to "confirmed_sources", a reply to it is not published. The part's value is never shown.)
  for (const d of changed) {
    if (d.confirmed) say(`  confirmed: ${d.collection} / ${d.file}: ${d.source} (${d.names.join(', ')} taken out)`);
    else say(`  address changed: check it: ${d.collection} / ${d.file}: ${d.names.join(', ')} taken out, now ${d.source} (add it to "confirmed_sources" when it is the right page)`);
  }
  if (cmd === 'list') {
    for (const c of collections) {
      say(`${c.name} (${c.clippings.length})`);
      for (const x of c.clippings) say(`  ${x.id}  ${x.published || '----------'}  ${String(x.words).padStart(6)} words  ${x.title}  <${x.source}>`);
    }
    return problems.length ? 1 : 0;
  }
  const files = v.settings.collections.reduce((n, c) => n + c.files.length, 0);
  say(`Valid: ${collections.length} collection${collections.length === 1 ? '' : 's'}, ${files - problems.length} of ${files} files read.`);
  for (const p of problems) say(`  left out: ${p.collection} / ${p.file}: ${p.problem}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
