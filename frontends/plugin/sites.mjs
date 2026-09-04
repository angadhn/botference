// sites.mjs — a site of the reader's own, made by the bots.
//
// The road so far: the reader marks up a page, the bots make an artifact of it
// in a project folder, and `publish` copies that one file into the reader's
// website repo. That last step assumes the site already exists and is theirs.
// This file is what happens when it does not: the reader says "I want this at
// lff.angadh.com" and the bots BUILD the site — a folder, a git repo, a private
// GitHub repo, a Netlify site, a deploy — with one step left over that is the
// reader's alone, because it is at their DNS provider and nothing here has a
// token for it.
//
// ── THE SHAPE OF THE PERMISSION, AND WHY IT IS THIS SHAPE ─────────────────
//
// Everything the bots may do lives in ONE folder: `<root>/sites/<name>/` under
// a council root the reader has confirmed. That folder is the whole of the new
// write scope, it is added only to a PROJECT lane (chat.mjs `sitesRoot`), and
// an ordinary web page's chat is exactly as write-less as it was yesterday.
//
// Commands are a second gate on top of that, and a narrow one. The bots do not
// get "a shell"; they get a list of verbs — git, four shapes of `gh`, five of
// `netlify` — decided on the PARSED argument vector and never on a substring of
// the command line, because a substring rule is a rule that reads
// `--data '{"note":"do not use --public"}'` as a request to publish. A command
// that cannot be parsed into a plain argv is denied, which is also what the
// companion did with every command yesterday, so an unreadable command is never
// a widening.
//
// What is denied is as deliberate as what is allowed:
//   · `--public` on `gh repo create`. `--private` is REQUIRED, in the argv, or
//     the command does not run. A page made from somebody's annotated reading
//     is theirs, and the default has to be the safe one.
//   · A force push, a mirror push, a branch delete. Nothing the bots do may
//     destroy history they did not write.
//   · Anything naming the READER'S OWN BLOG — its repo path, its GitHub
//     owner/name, its Netlify site id. Those are derived from the publish
//     targets already in config.json (protectedTokens), so the protection
//     arrives with the configuration rather than being typed into this file,
//     and a second site the reader adds is protected the day they add it.
//   · `netlify env:*`, `sites:delete`, `repo delete`, and every verb not on the
//     list. The list is the allowance; there is no "and anything similar".
//
// Owner-only at the door, like everything else here that names a path on this
// machine.
import fs from 'node:fs';
import path from 'node:path';

import { readConfig, saveConfig } from './store.mjs';
import { publishTargets } from './publish.mjs';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const read = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// A site's name is its subdomain label and its folder name and its GitHub repo
// name, all three at once — so it is checked once, here, against the strictest
// of the three (a DNS label: lowercase, digits, hyphens, no leading hyphen).
export const SITE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** `<root>/sites` for a confirmed council root, or '' when there is no root. */
export function sitesRoot(root) {
  const r = String(root || '').trim();
  return r && path.isAbsolute(r) ? path.join(r, 'sites') : '';
}

/**
 * Make sure the folder exists, because a write root that does not exist is a
 * `--add-dir` the CLIs refuse at spawn. One empty directory, created next to
 * `projects/` and `work/`, and never anything inside it: what goes in there is
 * the bots' to make.
 */
export function ensureSitesRoot(root) {
  const dir = sitesRoot(root);
  if (!dir) return '';
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return ''; }
  return isDir(dir) ? dir : '';
}

/**
 * The site name a directory is in — `<sites>/lff/…` → `lff` — or ''. Both
 * sides are resolved before comparing, so a symlink is not a way out of the
 * scope here any more than it is anywhere else in this tree.
 */
export function siteOfDir(dir, sites) {
  const s = String(sites || '');
  const d = String(dir || '');
  if (!s || !d || !path.isAbsolute(s) || !path.isAbsolute(d)) return '';
  const rel = path.relative(path.resolve(s), path.resolve(d));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  const name = rel.split(path.sep)[0];
  return SITE_NAME_RE.test(name) ? name : '';
}

// ── the parser ────────────────────────────────────────────────────────────
//
// A shell-ish split, and a deliberately unambitious one. It understands single
// quotes, double quotes (with the four escapes that mean anything inside them),
// backslashes, and `&&`. It understands NOTHING else: a pipe, a semicolon, a
// redirect, a subshell, a `$`, a backtick or a newline makes the whole command
// unreadable, and unreadable is denied. That is the right direction to fail in
// — every command this gate exists to allow is a plain one, and a command that
// needs a subshell to say what it does is a command nobody should be approving
// from a rule table.

/** The command as tokens (with `&&` as its own token), or null. */
export function splitArgv(input) {
  const s = String(input == null ? '' : input);
  if (!s.trim()) return null;
  const toks = [];
  let cur = '';
  let has = false;
  const push = () => { if (has) { toks.push(cur); cur = ''; has = false; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { push(); i++; continue; }
    if (c === '\n' || c === '\r') return null;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += s.slice(i + 1, end); has = true; i = end + 1; continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= s.length) return null;
        const d = s[i];
        if (d === '"') { i++; break; }
        if (d === '\\') {
          const n = s[i + 1];
          if (n === undefined) return null;
          if (n === '"' || n === '\\' || n === '$' || n === '`') { cur += n; has = true; i += 2; continue; }
          cur += d; has = true; i++; continue;
        }
        // a substitution inside double quotes is live, and a rule table cannot
        // read what it will become
        if (d === '$' || d === '`') return null;
        cur += d; has = true; i++;
      }
      has = true;
      continue;
    }
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) return null;
      cur += n; has = true; i += 2; continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') { push(); toks.push('&&'); i += 2; continue; }
      return null;
    }
    if (';|<>()`$'.includes(c)) return null;
    cur += c; has = true; i++;
  }
  push();
  return toks.length ? toks : null;
}

// A path argument the bots hand a command has to stay inside the site: `.`,
// `dist`, `./index.html`. Absolute or climbing is refused.
const localPath = v => {
  const s = String(v == null ? '' : v).trim();
  if (!s || s === '-' || path.isAbsolute(s) || s.includes('\0')) return false;
  return !s.split('/').some(seg => seg === '..');
};

// ── what the reader's own site is, so nothing here can touch it ───────────

/** The Netlify site id a repo is linked to, from its own `.netlify/state.json`. */
export function netlifySiteId(repo) {
  try {
    const raw = JSON.parse(read(path.join(String(repo || ''), '.netlify', 'state.json')));
    const id = raw && typeof raw === 'object' ? String(raw.siteId || '').trim() : '';
    return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : '';
  } catch { return ''; }
}

/** `owner/name` from a repo's `origin` remote, read out of `.git/config`. */
export function originSlug(repo) {
  const cfg = read(path.join(String(repo || ''), '.git', 'config'));
  if (!cfg) return '';
  const block = /\[remote\s+"origin"\][^[]*/.exec(cfg);
  if (!block) return '';
  const url = /url\s*=\s*(\S+)/.exec(block[0]);
  if (!url) return '';
  const m = /[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url[1]);
  return m ? `${m[1]}/${m[2]}` : '';
}

/** Whether a repo has an `origin` remote at all. */
export const hasOrigin = repo => !!originSlug(repo)
  || /\[remote\s+"origin"\]/.test(read(path.join(String(repo || ''), '.git', 'config')));

/**
 * The strings no command may name: the reader's existing publish targets —
 * repo path, GitHub owner/name, Netlify site id — as they stand in config.json
 * right now.
 *
 * Derived, never typed in. The reader's blog is protected because it is a
 * publish target, so a second site they configure tomorrow is protected
 * tomorrow, and a copy of this companion on somebody else's machine protects
 * THEIR site instead of this one's. `sites_protect` in config.json is the
 * escape hatch for something that is not a publish target.
 *
 * A target that lives INSIDE `sites/` is deliberately not protected: those are
 * the ones the bots made and are expected to keep deploying.
 */
export function protectedTokens(sites = '') {
  const out = new Set();
  const cfg = readConfig();
  const extra = Array.isArray(cfg.sites_protect) ? cfg.sites_protect : [];
  for (const s of extra) {
    const v = String(s || '').trim().toLowerCase();
    if (v.length >= 4) out.add(v);
  }
  for (const t of publishTargets()) {
    if (sites && siteOfDir(t.repo, sites)) continue;
    out.add(t.repo.toLowerCase());
    const id = netlifySiteId(t.repo); if (id) out.add(id.toLowerCase());
    const slug = originSlug(t.repo); if (slug) out.add(slug.toLowerCase());
  }
  return [...out].filter(Boolean);
}

// ── the gate ──────────────────────────────────────────────────────────────

const deny = why => ({ allow: false, kind: 'command', why });
const ok = () => ({ allow: true, kind: 'command', why: '' });

// git: everything except the three ways to destroy history you did not write.
function gitOk(argv) {
  const sub = argv[1] || '';
  // No global option before the subcommand — not `-C`, not `--git-dir`, not
  // `-c`. Every one of them either points git at another repository or changes
  // what the subcommand means, and a gate that has to model `git -c
  // push.default=… push` is a gate nobody can read.
  if (sub.startsWith('-')) return deny(`git ${sub} is not allowed before the subcommand here`);
  if (!sub) return deny('git needs a subcommand');
  if (sub === 'push') {
    const rest = argv.slice(2);
    for (const a of rest) {
      if (a === '-f' || a === '--force' || a.startsWith('--force-with-lease')
        || a.startsWith('--force-if-includes')) return deny('a force push is never allowed here');
      if (a === '--mirror') return deny('a mirror push is never allowed here');
      if (a === '-d' || a === '--delete') return deny('deleting a remote branch is never allowed here');
      if (a.startsWith('+')) return deny('a `+` refspec is a force push, which is never allowed here');
    }
  }
  return ok();
}

// gh: repo create (private, always), repo view, and the Pages endpoint.
const GH_REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[a-z0-9][a-z0-9-]{1,39}$/;
const GH_PAGES_API = /^(?:\/)?repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pages(?:\/[A-Za-z0-9._-]+)?$/;
// flags that swallow the next token, so it is a value and not an endpoint
const GH_VALUE_FLAGS = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field',
  '-F', '--field', '-q', '--jq', '-t', '--template', '--input', '--hostname', '--cache',
  '-p', '--preview', '--jq']);

function ghOk(argv) {
  const sub = argv[1] || '';
  if (sub === 'repo') {
    const verb = argv[2] || '';
    if (verb === 'view') return ok();
    if (verb !== 'create') return deny(`gh repo ${verb || '<nothing>'} is not allowed here`);
    const rest = argv.slice(3);
    if (rest.includes('--public') || rest.includes('--internal')) {
      return deny('a site made here is PRIVATE — --public is refused');
    }
    if (!rest.includes('--private')) return deny('gh repo create must carry --private');
    const slug = rest.find(a => !a.startsWith('-'));
    if (!slug || !GH_REPO_SLUG.test(slug)) return deny('gh repo create needs an <owner>/<name>');
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--source' || rest[i] === '-s') {
        if (!localPath(rest[i + 1])) return deny('--source must be a path inside the site folder');
      }
    }
    return ok();
  }
  if (sub === 'api') {
    const rest = argv.slice(2);
    const endpoints = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (GH_VALUE_FLAGS.has(a)) { i++; continue; }
      if (a.startsWith('-')) continue;
      endpoints.push(a);
    }
    const method = (() => {
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-X' || rest[i] === '--method') return String(rest[i + 1] || '').toUpperCase();
        if (rest[i].startsWith('--method=')) return rest[i].slice(9).toUpperCase();
      }
      return '';
    })();
    if (method === 'DELETE') return deny('gh api DELETE is not allowed here');
    if (endpoints.length !== 1) return deny('gh api takes exactly one endpoint here');
    if (!GH_PAGES_API.test(endpoints[0])) {
      return deny('gh api is allowed only for repos/<owner>/<name>/pages');
    }
    return ok();
  }
  return deny(`gh ${sub || '<nothing>'} is not allowed here`);
}

// netlify: make a site, link this folder to it, deploy it, ask about it, and
// the three api calls that set a custom domain. Nothing that reads or writes
// environment variables, and nothing that deletes.
const NETLIFY_API = new Set(['getSite', 'updateSite', 'createSiteInTeam']);
function netlifyOk(argv) {
  const sub = argv[1] || '';
  if (!sub || sub.startsWith('-')) return deny('netlify needs a subcommand');
  if (sub.startsWith('env:')) return deny('netlify env:* is never allowed here');
  if (sub === 'api') {
    const call = argv[2] || '';
    if (!NETLIFY_API.has(call)) return deny(`netlify api ${call || '<nothing>'} is not allowed here`);
    return ok();
  }
  if (sub === 'deploy') {
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--dir' || argv[i] === '-d' || argv[i] === '--functions') {
        if (!localPath(argv[i + 1])) return deny('netlify deploy may only publish a path inside the site folder');
      }
      if (argv[i].startsWith('--dir=') && !localPath(argv[i].slice(6))) {
        return deny('netlify deploy may only publish a path inside the site folder');
      }
    }
    return ok();
  }
  if (sub === 'sites:create' || sub === 'link' || sub === 'status') return ok();
  return deny(`netlify ${sub} is not allowed here`);
}

function segmentOk(argv) {
  const cmd = path.basename(String(argv[0] || ''));
  if (cmd === 'git') return gitOk(argv);
  if (cmd === 'gh') return ghOk(argv);
  if (cmd === 'netlify' || cmd === 'ntl') return netlifyOk(argv);
  return deny(`${cmd || 'that command'} is not one of the commands allowed in a site folder`);
}

/**
 * May this command run? The whole answer, as data.
 *
 * `{allow, kind, why}` — `kind` is `'command'` when this really was a command
 * request and `'other'` when it was not (a bare write-permission request, which
 * is what today's bridge sends and which stays deny-all: answering yes to one
 * of THOSE grants a whole additional write root for the rest of the session,
 * which is exactly the widening this contract refuses).
 *
 * Everything is decided on the parsed argv. Nothing is decided on a substring
 * of the command line, except the protected names — a deny-side check, where a
 * false positive costs a refusal and never an allowance.
 */
export function commandDecision({ tool = '', command = '', cwd = '', sites = '', protect = [] } = {}) {
  const line = String(command || '').trim();
  if (!line) return { allow: false, kind: 'other', why: '' };
  const name = String(tool || '').trim().toLowerCase();
  // an explicitly non-shell tool that nonetheless carried a command line is
  // not something this gate understands
  if (name && !/^(bash|shell|exec|local_shell|run_command|terminal)$/.test(name)) {
    return { allow: false, kind: 'other', why: '' };
  }
  if (!sites) return deny('this chat has no sites folder');
  const toks = splitArgv(line);
  if (!toks) return deny('that command could not be read as a plain command line');

  const bad = protect.map(p => String(p || '').toLowerCase()).filter(p => p.length >= 4);
  for (const t of toks) {
    const low = t.toLowerCase();
    for (const p of bad) {
      if (low.includes(p)) return deny(`that command names ${p}, which is the reader's own and off limits`);
    }
  }

  const segments = [];
  let cur = [];
  for (const t of toks) {
    if (t === '&&') { segments.push(cur); cur = []; continue; }
    cur.push(t);
  }
  segments.push(cur);
  if (segments.some(s => !s.length)) return deny('that command line has an empty step in it');

  let at = String(cwd || '').trim();
  if (at && !path.isAbsolute(at)) return deny('the working directory is not an absolute path');
  if (at) at = path.resolve(at);
  let ran = 0;
  for (const seg of segments) {
    if (seg[0] === 'cd') {
      if (seg.length !== 2) return deny('`cd` takes exactly one directory here');
      const to = seg[1];
      if (!path.isAbsolute(to) && !at) return deny('a relative `cd` has nowhere to start from');
      at = path.resolve(at || '/', to);
      continue;
    }
    if (!at) {
      return deny('that command names no directory to run in — `cd` into the site folder first');
    }
    if (!siteOfDir(at, sites)) {
      return deny(`commands here may only run inside ${sites}/<name>/`);
    }
    const d = segmentOk(seg);
    if (!d.allow) return d;
    ran++;
  }
  if (!ran) return deny('that command line runs nothing');
  if (!siteOfDir(at, sites)) return deny(`commands here may only run inside ${sites}/<name>/`);
  return ok();
}

// ── finding the sites the bots made, and registering them ─────────────────

/**
 * Every `<root>/sites/<name>/` that is a git repo with an `origin` remote, and
 * how it is hosted: `netlify` (a `.netlify/state.json` with a siteId in it) or
 * `pages` (a CNAME file, a `docs/` folder or a `gh-pages` branch — the three
 * ways GitHub Pages is ever set up).
 */
export function discoverSites(root) {
  const sites = sitesRoot(root);
  if (!sites || !isDir(sites)) return [];
  let names = [];
  try { names = fs.readdirSync(sites); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!SITE_NAME_RE.test(name)) continue;
    const dir = path.join(sites, name);
    if (!isDir(dir) || !isDir(path.join(dir, '.git'))) continue;
    if (!hasOrigin(dir)) continue;
    const siteId = netlifySiteId(dir);
    const packed = read(path.join(dir, '.git', 'packed-refs'));
    const pages = isFile(path.join(dir, 'CNAME'))
      || isDir(path.join(dir, 'docs'))
      || isFile(path.join(dir, '.git', 'refs', 'heads', 'gh-pages'))
      || /refs\/heads\/gh-pages\b/.test(packed);
    if (!siteId && !pages) continue;
    out.push({ name, dir, host: siteId ? 'netlify' : 'pages', site_id: siteId, slug: originSlug(dir) });
  }
  return out;
}

/**
 * The domain a site of the reader's own hangs under — `angadh.com`, so a site
 * called `lff` is `lff.angadh.com`.
 *
 * `sites_domain` in config.json when it is set; otherwise the host of the first
 * publish target that is NOT itself one of these sites, which for a reader with
 * a blog configured is their blog's domain and is right every time.
 */
export function sitesDomain(root = '') {
  const cfg = readConfig();
  const named = String(cfg.sites_domain || '').trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9.-]{1,120}\.[a-z]{2,}$/.test(named)) return named;
  const sites = sitesRoot(root);
  for (const t of publishTargets()) {
    if (sites && siteOfDir(t.repo, sites)) continue;
    try {
      const h = new URL(t.url).hostname.replace(/^www\./, '').toLowerCase();
      if (h) return h;
    } catch { /* a hand-written url that is not one: the next target answers */ }
  }
  return '';
}

/**
 * Register a publish target for every site the bots have finished, and return
 * the names that were newly added.
 *
 * Called at turn-end on a project lane. Three rules, and the third is the one
 * that matters: an existing target of that name is NEVER overwritten. The
 * reader may have edited the url, the branch or the deploy command by hand, and
 * a census that quietly rewrites a hand-edited config is a census nobody can
 * leave switched on.
 */
export function registerSiteTargets(root) {
  const found = discoverSites(root);
  if (!found.length) return [];
  const domain = sitesDomain(root);
  if (!domain) return [];
  const cfg = readConfig();
  const raw = cfg.publish;
  // the flat single-target form becomes the map form the moment there is a
  // second target — that is what "site" has always been called
  const map = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (typeof raw.repo === 'string' ? { site: raw } : { ...raw })
    : {};
  const added = [];
  for (const s of found) {
    if (Object.prototype.hasOwnProperty.call(map, s.name)) continue;
    map[s.name] = {
      repo: s.dir,
      dir: '.',
      file: 'index.html',
      url: `https://${s.name}.${domain}/`,
      branch: 'main',
      push: true,
      // Netlify deploys from THIS machine, which is how a private repo reaches
      // a host without being handed to it. GitHub Pages needs no deploy step:
      // the push IS the deploy.
      ...(s.host === 'netlify' ? { deploy: ['netlify', 'deploy', '--prod', '--dir', '.'] } : {}),
    };
    added.push(s.name);
  }
  if (!added.length) return [];
  const patch = { publish: map };
  // …and remember the domain we worked it out from, so a later site cannot be
  // named after one of these sites' own hosts
  if (!String(cfg.sites_domain || '').trim()) patch.sites_domain = domain;
  saveConfig(patch);
  return added;
}
