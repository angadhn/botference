#!/usr/bin/env node
// site-cli.mjs — `botference site`, `botference sites`, and the half of
// `botference init` that puts a project in Discuss's scope.
//
//   botference site [dir] [--serve <origin>] [--rebuild <cmd> | --no-rebuild] [--kind <k>]
//   botference sites [--remove <dir>]
//
// The one gesture. Run in a repo, it writes that repo's marker
// (`.botference/site.json`, markers.mjs), makes sure `.botference/` is
// gitignored there, adds the folder to `~/.botference/sites.json`, and tells a
// running companion to read the registry again — so the next page of that
// project opened in the browser is in scope: the repo is its write root and
// `.botference/plugin/artifacts/` its scratch (blog.mjs scratchDir).
//
// It writes exactly three things: the marker, one line of `.gitignore` if it
// is missing, and the registry. Nothing else in the repo is touched and git is
// never run — the same promise the companion keeps about a site's repository.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectKind, isJupyterBookRoot, isJekyllRoot, rebuildOf, scratchDir, kindLabel } from './blog.mjs';
import { ensureGitignore } from './scratch.mjs';
import {
  MARKER_KINDS, MARKER_REL, readMarker, writeMarker, registerRoot, unregisterRoot, readRegistry,
  registryFile,
} from './markers.mjs';

const COMPANION = (process.env.BOTFERENCE_PLUGIN_URL || 'http://127.0.0.1:4189').replace(/\/$/, '');
// the address a kind is usually served at — a GUESS, printed as one
const GUESS = { jupyterbook: 'http://localhost:8000', jekyll: 'http://localhost:4000', plain: '' };

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const say = s => process.stdout.write(s + '\n');
const fail = s => { process.stderr.write(`Error: ${s}\n`); process.exit(2); };

// `8000`, `:8000`, `localhost:8000` and `http://localhost:8000/x` all mean
// the origin http://localhost:8000
export function originArg(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (/^:?\d+$/.test(s)) s = `http://localhost:${s.replace(/^:/, '')}`;
  if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : '';
  } catch { return ''; }
}

const which = cmd => {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  const p = String(r.stdout || '').trim();
  return r.status === 0 && path.isAbsolute(p) ? p : '';
};

async function companion(method, route, body) {
  try {
    const r = await fetch(COMPANION + route, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, json: await r.json() };
  } catch { return { ok: false, down: true }; }
}

function parse(argv) {
  const o = { dir: '', serve: null, rebuild: null, kind: '', remove: '', fromInit: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--serve') o.serve = val();
    else if (a.startsWith('--serve=')) o.serve = a.slice(8);
    else if (a === '--rebuild') o.rebuild = val();
    else if (a.startsWith('--rebuild=')) o.rebuild = a.slice(10);
    else if (a === '--no-rebuild') o.rebuild = '';
    else if (a === '--kind') o.kind = val();
    else if (a.startsWith('--kind=')) o.kind = a.slice(7);
    else if (a === '--remove' || a === 'remove') o.remove = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '.';
    else if (a === '--from-init') o.fromInit = true;
    else if (a === '--help' || a === '-h' || a === 'help') o.help = true;
    else if (!a.startsWith('-') && !o.dir) o.dir = a;
    else fail(`unknown option: ${a}`);
  }
  return o;
}

const SITE_HELP = `Usage: botference site [dir] [--serve <origin>] [--rebuild <cmd> | --no-rebuild] [--kind <k>]

Put this project (dir defaults to the current one) in Discuss's scope: the
browser plugin then treats a page of it as yours — the repo is the bots'
write root, their scratch goes in .botference/plugin/artifacts/, and they
propose changes to the source for you to accept. 'botference init' does
this too.

Writes .botference/site.json, adds .botference/ to .gitignore if it is not
there, and registers the folder in ~/.botference/sites.json. Nothing else in
the repo is touched and git is never run. Run it again to change a value;
values not given are kept.

  --serve <origin>   Where you serve the site locally (default: a guess —
                     http://localhost:8000 for a Jupyter Book,
                     http://localhost:4000 for Jekyll). 8000 and :8000 work.
  --rebuild <cmd>    A Jupyter Book's rebuild command, run after an accepted
                     change (default: <jupyter-book on PATH> build .)
  --no-rebuild       No rebuild command (you serve with sphinx-autobuild)
  --kind <k>         jupyterbook | jekyll | plain (default: detected)

See also: botference sites`;

const SITES_HELP = `Usage: botference sites [--remove <dir>]

List the projects 'botference site' (or 'botference init') registered: the
folder, its kind, where it is served, whether it is on, and whether the
running companion sees it. --remove takes one out of the registry and
switches its marker off (enabled: false); nothing else is deleted.`;

// ---- botference site -------------------------------------------------------

async function site(o) {
  const root = real(o.dir || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`no such directory: ${root}`);
  const had = readMarker(root) || {};
  const detected = detectKind(root) || 'plain';
  const kind = o.kind || (MARKER_KINDS.includes(had.kind) ? had.kind : detected);
  if (!MARKER_KINDS.includes(kind)) fail(`--kind must be one of ${MARKER_KINDS.join(', ')}`);
  if (kind === 'jupyterbook' && !isJupyterBookRoot(root)) fail(`${root} has no _toc.yml beside a _config.yml — that is not a Jupyter Book`);
  if (kind === 'jekyll' && !isJekyllRoot(root)) fail(`${root} has no _config.yml and no _posts/ — that is not a Jekyll site`);

  let serve = '';
  let guessed = false;
  if (o.serve !== null) {
    serve = originArg(o.serve);
    if (!serve) fail(`--serve wants an http(s) origin, e.g. http://localhost:8000 — got ${o.serve}`);
  } else if (had.serve_origin && had.kind === kind) {
    serve = String(had.serve_origin);
  } else {
    serve = GUESS[kind] || '';
    guessed = !!serve;
  }
  if (kind === 'plain') serve = '';

  let rebuild = '';
  let offered = false;
  if (kind === 'jupyterbook') {
    if (o.rebuild !== null) rebuild = o.rebuild;
    else if (had.kind === kind && 'rebuild' in had) rebuild = String(had.rebuild || '');
    else if (had.kind === kind && had.serve_origin) rebuild = '';
    else {
      const jb = which('jupyter-book');
      if (jb) { rebuild = `${jb} build .`; offered = true; }
    }
    const rb = rebuildOf(kind, rebuild);
    if (rb.error) fail(rb.error);
    rebuild = rb.cmd;
  } else if (o.rebuild) {
    fail(`a ${kindLabel(kind)} takes no rebuild command`);
  }

  writeMarker(root, { kind, serve_origin: serve, rebuild, enabled: true });
  const ignored = ensureGitignore(root);
  registerRoot(root);

  const name = path.basename(root);
  say(`${o.fromInit ? '\n' : ''}Discuss: ${name} is in scope (${kindLabel(kind)})`);
  say(`  marker    ${path.join(root, MARKER_REL)}`);
  if (serve) say(`  served at ${serve}${guessed ? '   (a guess — correct it with: botference site --serve <origin>)' : ''}`);
  else say('  served at (nothing — a plain folder: a file of it opened off the disk is in scope)');
  if (kind === 'jupyterbook') {
    say(`  rebuild   ${rebuild || '(none — you rebuild, or serve with sphinx-autobuild)'}${offered ? '   (found on PATH; --no-rebuild to drop it)' : ''}`);
  }
  say(`  scratch   ${scratchDir(root)}/`);
  if (ignored) say('  .gitignore: added .botference/');

  // a running companion takes it in now; one that is not running reads the
  // registry when it starts
  const r = await companion('POST', '/sites/rescan', {});
  if (r.ok) {
    // running the command in this folder IS the yes the drawer would ask for —
    // sent, so an earlier "no" in the drawer does not quietly outlive it
    if (serve || kind === 'plain') await companion('POST', '/blog-root', { root, confirm: true });
    const seen = (r.json.sites || []).some(x => x.root === root);
    const why = (r.json.skipped || []).find(x => x.root === root);
    say(seen ? `  companion: picked up (${COMPANION})`
      : `  companion: running, but it did not take this one in${why ? ` — ${why.why}` : ''}`);
  } else if (r.status) {
    // a companion that answers but has no /sites/rescan is an older one
    say(`  companion: running at ${COMPANION} but did not take the rescan (HTTP ${r.status}) — `
      + 'restart it and it picks this up as it starts');
  } else {
    say('  companion: not running — it will be picked up when the companion starts');
  }
}

// ---- botference sites ------------------------------------------------------

async function sites(o) {
  if (o.remove) {
    const root = real(o.remove);
    const was = unregisterRoot(root);
    const m = readMarker(root);
    if (m) writeMarker(root, { ...m, enabled: false });
    if (!was && !m) fail(`${root} is not a registered project`);
    const r = await companion('POST', '/sites/rescan', {});
    say(`Discuss: ${path.basename(root)} is out of scope${m ? ' (marker switched off: enabled: false)' : ''}`);
    if (r.ok) {
      const still = (r.json.sites || []).some(x => x.root === root);
      if (still) say('  …but the companion still lists it: it is declared by hand in blog_sites (config.json)');
      else say('  companion: dropped it');
    }
    return;
  }
  const roots = readRegistry();
  const live = await companion('GET', '/blog-sites');
  const seen = live.ok ? new Set((live.json.sites || []).map(x => x.root)) : null;
  if (!roots.length) {
    say(`No registered projects (${registryFile()}). Run 'botference site' in one.`);
  }
  for (const root of roots) {
    const m = readMarker(root);
    const gone = !fs.existsSync(root);
    const state = gone ? 'folder gone' : !m ? 'no marker' : m.enabled === false ? 'off' : 'on';
    const sees = !seen ? 'companion not running' : seen.has(real(root)) ? 'companion sees it' : 'companion does not see it';
    say(`${path.basename(root)}  ${root}`);
    say(`    ${m ? kindLabel(m.kind) : '?'} · ${(m && m.serve_origin) || 'not served'} · ${state} · ${sees}`);
  }
  if (live.ok) {
    const hand = (live.json.sites || []).filter(x => x.from === 'config');
    if (hand.length) {
      say('\nDeclared by hand in the companion\'s config.json (blog_sites):');
      for (const x of hand) say(`    ${x.serve_origin} → ${x.root}`);
    }
    for (const x of live.json.skipped || []) say(`skipped: ${x.root} — ${x.why}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const o = parse(rest);
if (cmd === 'site') { if (o.help) say(SITE_HELP); else await site(o); }
else if (cmd === 'sites') { if (o.help) say(SITES_HELP); else await sites(o); }
else fail('usage: site-cli.mjs site|sites …');
