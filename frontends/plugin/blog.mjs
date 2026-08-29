// blog.mjs — the local site, and the source it was rendered from.
//
// The reader writes a post in markdown, runs `jekyll serve`, and opens the
// rendered page at http://localhost:4000/…. What they are looking at is a
// PHOTOCOPY: a file under `_site/` that the next build throws away. The thing
// worth editing is the markdown it came from, three directories away, and
// until now nothing in this companion could find it — so a comment on a
// paragraph of a draft could be answered in prose and never in the draft.
//
// This module is the part that knows the way back:
//
//   REGISTRATION  which local origin is served from which repo on this disk,
//                 declared by the owner and confirmed once (like a council
//                 root: what hangs off a yes is a bridge child spawned with
//                 that repo writable).
//   MAPPING       which markdown file a url renders from — resolved by
//                 READING the repo (front matter, filenames, the permalink
//                 templates in _config.yml), never by guessing from the url.
//   CENSUS        what moved in the repo across a turn, so the tab can be told
//                 to reload once jekyll has rebuilt.
//
// ── THE SITE'S REPOSITORY IS THE READER'S ALONE ───────────────────────────
// There is NO publish here, and there will not be one. Discuss edits working
// files in the reader's site repo and stops there: nothing in this companion
// commits, pushes, branches, tags or stages anything in a blog root, and no
// bot is asked to. The reader publishes their site by their own hand, by
// their own route (an Obsidian workflow, in the case this was built for), and
// that road to the public internet stays theirs.
//
// This is a property of the KIND, held in code (`KIND_RULES` below), not a
// setting. A registration in config.json records WHICH directory is a blog
// root; what a blog root can never do is decided here. A config file copied
// from another machine — the companion's config rides the reader's nightly
// backup repo, so it WILL be copied — can therefore move the path and cannot
// weaken the guarantee: there is no flag to flip and no code path to reach.
//
// The contrast with the review engine (frontends/review) is deliberate rather
// than an inconsistency: a paper repo under review is a collaborative working
// copy where a bot committing is the point, and it keeps those powers. A blog
// repo is the reader's published identity.
//
// ── WHAT IS AND IS NOT PROMISED ABOUT THE WRITE SCOPE ─────────────────────
// The honest boundary is the DIRECTORY. A blog turn's child is spawned with
// the repo as its one extra write root (BOTFERENCE_PLAN_EXTRA_WRITE_ROOTS),
// which is what codex's OS sandbox and claude's Edit/Write allow-list are
// built from — so "nothing outside this repo" is enforced by the tools. That
// the bots touch only THIS POST and the images it uses is a narrower promise,
// and it is kept by two weaker things: the instruction in the envelope, and
// the turn-end census that shows the reader every file that moved. It is not
// a sandbox. Said plainly here because it is said plainly in the SPEC.
//
// The no-git rule has the same shape and one extra layer: the child is spawned
// with `git` and `gh` on a DENY list the claude CLI enforces
// (BOTFERENCE_PLAN_DENY_BASH → permissions.deny), plus `.git/` denied as a
// write path. That is defence in depth, not a sandbox either — a deny rule is
// a command-prefix match and codex has no equivalent — so the guarantee that
// actually holds is the one above: Discuss has no publish code at all.
//
// NOTHING IN THIS FILE WRITES ANYTHING, anywhere. Every function here reads.
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, saveConfig } from './store.mjs';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// The same path with every symlink taken out of it — the rule workspace.mjs
// states at length: macOS hands out /var/folders/… which is really
// /private/var/folders/…, and a root recorded one way and matched the other
// would never match. Resolved on BOTH sides of every comparison.
export function realish(p) {
  if (!p) return '';
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch { return path.resolve(p); }
}

// ---- what a site looks like ----------------------------------------------

// The directories a Jekyll source tree keeps its documents in, and the ones
// that are output or machinery. `_site` above all: it is the rendered copy,
// and mapping a url to a file in there would hand the bots the photocopy.
export const SKIP_DIRS = new Set([
  '_site', '.jekyll-cache', '.jekyll-metadata', '.sass-cache', '.bundle',
  'node_modules', 'vendor', '_includes', '_layouts', '_sass', '_data',
  '_plugins', 'build', 'dist',
]);
// Where images and other attachments live in the layouts this understands.
// Only the ones that exist are ever named.
const ASSET_DIRS = ['assets', 'images', 'img', 'files', 'media', 'static'];
// Documents. `.html` counts because a Jekyll page may be written in HTML with
// front matter on it — and it is still SOURCE, not `_site` output.
const DOC_RE = /\.(md|markdown|html|htm)$/i;
// How deep the document scan goes inside a collection directory. Jekyll nests
// (`_posts/2024/…`), but not far.
const SCAN_DEPTH = 4;
// Caps, so a repo that is really a monorepo cannot cost a page load seconds.
export const DOCS_MAX = 4000;
export const CENSUS_MAX = 8000;
const FRONT_MATTER_BYTES = 8 * 1024;

/**
 * Does this directory look like a Jekyll source tree? `_config.yml` is the
 * marker Jekyll itself uses; `_posts/` alone is accepted because a theme
 * gem's site can be configured from elsewhere, and because the reader has to
 * confirm the root anyway before anything is spawned against it.
 */
export function isJekyllRoot(dir) {
  if (!dir || !isDir(dir)) return false;
  return isFile(path.join(dir, '_config.yml'))
    || isFile(path.join(dir, '_config.yaml'))
    || isDir(path.join(dir, '_posts'));
}

// ---- registration ---------------------------------------------------------
// Two records, deliberately separate, exactly as a council root is:
//
//   `blog_sites`  the DECLARATION — "localhost:4000 is served from this repo".
//                 A list, because a reader may run two sites.
//   `blog_roots`  the ANSWER — "yes, that repo is mine and the bots may edit
//                 it". Keyed by the resolved absolute path, so confirming a
//                 repo once covers every origin it is ever served at.

const originOf = v => {
  try {
    const u = new URL(String(v || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin.toLowerCase();
  } catch { return ''; }
};

// WHAT A KIND OF SITE IS ALLOWED TO BE, in code.
//
// One entry per kind, and every kind of blog root has `git: false`. This is
// the durable half of the no-git commitment: a registration says which folder
// is a blog root, and this table says what a blog root is. There is
// deliberately no per-site override, no `allow_git` key, and no environment
// escape — `normalizeSite` keeps exactly three fields off a config row, so a
// hand-edited (or restored, or copied) config.json cannot carry a fourth.
// `suggest: true` is the second rule of the same shape, and it arrived for the
// same reason. A blog root is the reader's published identity, so what a bot
// may do to the markdown in it is PROPOSE — the file does not move until the
// reader accepts a card (suggest.mjs). Like `git`, it is a property of the
// KIND rather than a setting: there is no per-site override, no `direct_edit`
// key, and `normalizeSite` keeps exactly three fields off a config row, so a
// restored or hand-edited config.json can move the path and cannot turn the
// mode off.
const KIND_RULES = {
  jekyll: { git: false, suggest: true, label: 'Jekyll' },
};
const KINDS = new Set(Object.keys(KIND_RULES));

/**
 * May anything Discuss drives run git in a root of this kind? Always false,
 * for every kind there is. It is a function rather than a constant so the
 * question has one answer in one place, and so that the day a kind wants a
 * different answer it is a code review rather than a config edit.
 */
export function gitAllowed(kind) {
  const rule = KIND_RULES[String(kind || '')] || KIND_RULES.jekyll;
  return rule.git === true;
}

/**
 * Do the bots PROPOSE changes to a root of this kind rather than make them?
 * True for every kind there is, and asked in exactly one place for exactly the
 * reason `gitAllowed` is: the day a kind wants a different answer, that is a
 * code review and not a config edit.
 */
export function suggestMode(kind) {
  const rule = KIND_RULES[String(kind || '')] || KIND_RULES.jekyll;
  return rule.suggest === true;
}

/** The commands a child spawned for this root is denied outright. */
export const DENIED_COMMANDS = ['git', 'gh'];
export function deniedCommands(kind) {
  return gitAllowed(kind) ? [] : [...DENIED_COMMANDS];
}

function normalizeSite(row) {
  if (!row || typeof row !== 'object') return null;
  const origin = originOf(row.serve_origin || row.origin);
  const root = realish(String(row.root || ''));
  if (!origin || !root || !path.isAbsolute(root)) return null;
  // three fields, always these three: anything else a config row carries is
  // dropped here rather than read, which is what makes the kind's rules
  // un-overridable from config
  const kind = KINDS.has(String(row.kind || '')) ? String(row.kind) : 'jekyll';
  return { serve_origin: origin, root, kind };
}

/** Every declared site, normalized, newest declaration of an origin winning. */
export function listSites() {
  const cfg = readConfig();
  const rows = Array.isArray(cfg.blog_sites) ? cfg.blog_sites : [];
  const by = new Map();
  for (const row of rows) {
    const s = normalizeSite(row);
    if (s) by.set(s.serve_origin, s);
  }
  return [...by.values()];
}

/**
 * Declare (or re-point) one site. Refuses anything that is not an http(s)
 * origin pointing at a directory that looks like a Jekyll source tree — the
 * companion has no business spawning a write-enabled child against a folder
 * that is not one, and a typo in a path must fail loudly here rather than
 * quietly at the first turn.
 */
export function addSite({ serve_origin, root, kind = 'jekyll' } = {}) {
  const s = normalizeSite({ serve_origin, root, kind });
  if (!s) return { ok: false, error: 'a site needs an http(s) origin and an absolute path' };
  if (!isDir(s.root)) return { ok: false, error: `no such directory: ${s.root}` };
  if (!isJekyllRoot(s.root)) {
    return { ok: false, error: `${s.root} has no _config.yml and no _posts/ — that is not a Jekyll site` };
  }
  const kept = listSites().filter(x => x.serve_origin !== s.serve_origin);
  saveConfig({ blog_sites: [...kept, s] });
  forgetIndex(s.root);
  return { ok: true, site: s };
}

/** Undeclare one origin. The confirmation for its root is left alone. */
export function removeSite(serve_origin) {
  const origin = originOf(serve_origin);
  if (!origin) return { ok: false, error: 'not an origin' };
  const kept = listSites().filter(x => x.serve_origin !== origin);
  saveConfig({ blog_sites: kept });
  return { ok: true, sites: kept };
}

const rootsMap = () => {
  const m = readConfig().blog_roots;
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
};

/** 'yes' | 'no' | '' (never asked) */
export function rootState(root) {
  const key = realish(root);
  const m = rootsMap();
  if (!Object.prototype.hasOwnProperty.call(m, key)) return '';
  return m[key] ? 'yes' : 'no';
}

export function setRootState(root, confirmed) {
  const key = realish(root);
  if (!key || !path.isAbsolute(key)) return rootState(root);
  saveConfig({ blog_roots: { ...rootsMap(), [key]: !!confirmed } });
  return rootState(root);
}

/** The declared site this url is served by, or null. Exact origin, always. */
export function siteFor(url) {
  const origin = originOf(url);
  if (!origin) return null;
  return listSites().find(s => s.serve_origin === origin) || null;
}

// ---- reading the repo -----------------------------------------------------

/** Jekyll's own slug rule, near enough: lowercase, non-alphanumerics fused. */
export function slugify(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The front matter of a document, as a flat map of the scalars and the one
 * list shape that matters (`categories`).
 *
 * A deliberately small YAML reader. It is looking for six keys on a document
 * whose front matter is almost always six lines long, and the alternative — a
 * YAML dependency in a plugin that has none — buys nothing: anything it cannot
 * read simply falls through to filename resolution, which is the path most
 * posts take anyway.
 */
export function frontMatter(text) {
  const s = String(text == null ? '' : text);
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(s);
  if (!m) return null;
  const out = {};
  let listKey = '';
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] = out[listKey] || []).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (!val) { listKey = key; out[key] = out[key] || []; continue; }
    listKey = '';
    if (/^\[.*\]$/.test(val)) {
      out[key] = val.slice(1, -1).split(',').map(v => unquote(v.trim())).filter(Boolean);
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}

const unquote = v => String(v || '').replace(/^["'](.*)["']$/, '$1').trim();

// `_config.yml`, as much of it as the mapping needs: the site-wide permalink
// template and the per-collection ones. Same reasoning as frontMatter — the
// keys are few and the fallback is total.
export function readSiteConfig(root) {
  const file = ['_config.yml', '_config.yaml'].map(n => path.join(root, n)).find(isFile);
  const out = { permalink: '', collections: {} };
  if (!file) return out;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const lines = text.split(/\r?\n/);
  let inCollections = false;
  let current = '';
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    const top = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (top) {
      inCollections = top[1] === 'collections' && !top[2].trim();
      current = '';
      if (top[1] === 'permalink' && top[2].trim()) out.permalink = unquote(top[2]);
      continue;
    }
    if (!inCollections) continue;
    const key = /^ {2}([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/.exec(line);
    if (key) { current = key[1]; out.collections[current] = out.collections[current] || {}; continue; }
    const sub = /^ {4}([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (sub && current) out.collections[current][sub[1]] = unquote(sub[2]);
  }
  return out;
}

// Which underscore directories hold documents. The config's `collections:` is
// the authority where it can be read; otherwise every `_name` directory that
// is not machinery is treated as one, which is what Jekyll effectively does
// for a site whose collections are declared somewhere this cannot see.
function collectionDirs(root, cfg) {
  const names = new Set(Object.keys(cfg.collections || {}));
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('_') || SKIP_DIRS.has(e.name)) continue;
    if (e.name === '_posts' || e.name === '_drafts' || e.name === '_pages') continue;
    names.add(e.name.slice(1));
  }
  return [...names].filter(n => isDir(path.join(root, `_${n}`)));
}

// Every document file under one directory, relative to the repo root.
function docsUnder(root, rel, out) {
  const start = path.join(root, rel);
  if (!isDir(start)) return;
  const stack = [{ abs: start, rel, depth: 0 }];
  while (stack.length && out.length < DOCS_MAX) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(cur.abs, e.name);
      const r = `${cur.rel}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || cur.depth + 1 > SCAN_DEPTH) continue;
        stack.push({ abs, rel: r, depth: cur.depth + 1 });
        continue;
      }
      if (!e.isFile() || !DOC_RE.test(e.name)) continue;
      out.push(r.replace(/^\//, ''));
      if (out.length >= DOCS_MAX) return;
    }
  }
}

// ---- url paths ------------------------------------------------------------

// The comparable form of a path: decoded, one leading slash, `index.html`
// dropped, one trailing slash. `/a/b`, `/a/b/`, `/a/b/index.html` and
// `/a/b/?draft=1` are one address, because Jekyll serves them as one page.
export function normPath(p) {
  let s = String(p == null ? '' : p);
  try { s = decodeURIComponent(s); } catch { /* a malformed escape stays as typed */ }
  s = s.split('#')[0].split('?')[0];
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/index\.html?$/i, '/');
  s = s.replace(/\/{2,}/g, '/');
  if (!/\.[a-z0-9]{1,6}$/i.test(s) && !s.endsWith('/')) s += '/';
  return s;
}

const PLACEHOLDER = /:[a-z_]+/i;

/**
 * A Jekyll permalink template, filled in. Supports the placeholders a real
 * site uses (`:categories`, `:title`, `:slug`, `:year`, `:month`, `:day`,
 * `:collection`, `:path`, `:name`) and the three named styles. A template with
 * something left in it after this is unresolved and answers '' — the slug
 * fallback covers those rather than a guess dressed up as an answer.
 */
export function expandPermalink(tmpl, doc) {
  const named = {
    date: '/:categories/:year/:month/:day/:title.html',
    pretty: '/:categories/:year/:month/:day/:title/',
    ordinal: '/:categories/:year/:y_day/:title.html',
    none: '/:categories/:title.html',
  };
  let t = String(tmpl || '');
  if (named[t]) t = named[t];
  if (!t) return '';
  const cats = (doc.categories || []).map(slugify).filter(Boolean).join('/');
  const map = {
    ':categories': cats,
    ':collection': doc.collection || '',
    ':year': doc.year || '',
    ':month': doc.month || '',
    ':day': doc.day || '',
    ':title': doc.slug || '',
    ':slug': doc.slug || '',
    ':name': doc.slug || '',
    ':path': doc.collection ? `${doc.collection}/${doc.slug}` : (doc.slug || ''),
    ':output_ext': '.html',
  };
  t = t.replace(/:[a-z_]+/gi, m => (m in map ? map[m] : m));
  if (PLACEHOLDER.test(t)) return '';
  return normPath(t.replace(/\/{2,}/g, '/'));
}

// One document, as the index needs it.
function readDoc(root, rel) {
  const abs = path.join(root, rel);
  let head = '';
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(FRONT_MATTER_BYTES);
    const n = fs.readSync(fd, buf, 0, FRONT_MATTER_BYTES, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n).toString('utf8');
  } catch { return null; }
  const fm = frontMatter(head) || {};
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel).replace(DOC_RE, '');
  const top = rel.split('/')[0];
  const dated = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/.exec(base);
  const collection = top.startsWith('_') && top !== '_posts' && top !== '_drafts' && top !== '_pages'
    ? top.slice(1) : '';
  const kind = top === '_posts' ? 'post'
    : top === '_drafts' ? 'draft'
      : collection ? 'collection'
        : 'page';
  const slug = String(fm.slug || '') || (dated ? dated[4] : base);
  const doc = {
    rel,
    path: abs,
    kind,
    collection,
    slug: slugify(slug),
    title: String(fm.title || ''),
    categories: Array.isArray(fm.categories) ? fm.categories
      : (fm.categories ? [String(fm.categories)] : []),
    year: dated ? dated[1] : '',
    month: dated ? dated[2] : '',
    day: dated ? dated[3] : '',
    permalink: String(fm.permalink || ''),
    published: fm.published === undefined ? true : String(fm.published) !== 'false',
    dir,
    base,
  };
  return doc;
}

/**
 * Every url this document could be served at, best first.
 *
 * Front-matter `permalink` is the document's own word and wins outright — a
 * post that declares `/about-me/` is at `/about-me/` whatever its filename
 * says. Everything after it is the configured template, then the conventions a
 * site with no template at all falls back to.
 */
export function candidatesFor(doc, cfg) {
  const out = [];
  const push = p => { const n = p && normPath(p); if (n && !out.includes(n)) out.push(n); };

  if (doc.permalink) {
    const exp = expandPermalink(doc.permalink, doc);
    if (exp) push(exp);
    else if (!PLACEHOLDER.test(doc.permalink)) push(doc.permalink);
  }
  const tmpl = doc.collection
    ? ((cfg.collections || {})[doc.collection] || {}).permalink
    : (doc.kind === 'post' || doc.kind === 'draft' ? cfg.permalink : '');
  if (tmpl) push(expandPermalink(tmpl, doc));

  if (doc.kind === 'post' || doc.kind === 'draft') {
    push(`/${doc.slug}/`);
    if (doc.year) {
      push(`/${doc.year}/${doc.month}/${doc.day}/${doc.slug}/`);
      push(`/${doc.year}/${doc.month}/${doc.slug}/`);
    }
    const cats = (doc.categories || []).map(slugify).filter(Boolean);
    if (cats.length) {
      push(`/${cats.join('/')}/${doc.slug}/`);
      if (doc.year) push(`/${cats.join('/')}/${doc.year}/${doc.month}/${doc.day}/${doc.slug}/`);
    }
  } else if (doc.collection) {
    push(`/${doc.collection}/${doc.slug}/`);
  } else {
    // a page: its path in the repo IS its path on the site, `_pages` aside
    const rel = doc.rel.replace(/^_pages\//, '');
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel).replace(DOC_RE, '');
    const at = dir === '.' ? '' : `${dir}/`;
    push(base === 'index' ? `/${at}` : `/${at}${base}/`);
    push(`/${at}${base}.html`);
  }
  return out;
}

// ---- the index ------------------------------------------------------------
//
// Built by reading the repo, cached against a cheap stamp, and rebuilt when
// the stamp moves. The stamp is the mtimes of the directories documents live
// in plus `_config.yml` — a new post, a renamed one and a changed permalink
// template all move it. (A permalink edited INSIDE an existing file does not
// move a directory mtime, so the file's own mtime is in the stamp too, via the
// per-document mtimes gathered while scanning.)

const indexCache = new Map();
export function forgetIndex(root) {
  if (root) indexCache.delete(realish(root)); else indexCache.clear();
}

function docDirs(root, cfg) {
  return ['_posts', '_drafts', '_pages', ...collectionDirs(root, cfg).map(c => `_${c}`)]
    .filter(d => isDir(path.join(root, d)));
}

function stampOf(root, dirs) {
  const parts = [];
  for (const d of ['.', ...dirs, '_config.yml', '_config.yaml']) {
    try {
      const st = fs.statSync(path.join(root, d));
      parts.push(`${d}:${Math.round(st.mtimeMs)}`);
    } catch { parts.push(`${d}:-`); }
  }
  return parts.join('|');
}

/**
 * {docs, byPath, bySlug, cfg} for one repo. `byPath` is the exact answer;
 * `bySlug` is the fallback, and it keeps EVERY document that claims a slug so
 * an ambiguous one can be reported as ambiguous rather than resolved by luck.
 */
export function indexOf(root) {
  const key = realish(root);
  if (!key || !isDir(key)) return { docs: [], byPath: new Map(), bySlug: new Map(), cfg: { collections: {} } };
  const cfg = readSiteConfig(key);
  const dirs = docDirs(key, cfg);
  const stamp = stampOf(key, dirs);
  const hit = indexCache.get(key);
  if (hit && hit.stamp === stamp && hit.mtimes === mtimesOf(key, hit.index.docs)) return hit.index;

  const rels = [];
  for (const d of dirs) docsUnder(key, d, rels);
  // top-level pages (index.md, about.md, a hand-written .html with front matter)
  try {
    for (const e of fs.readdirSync(key, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.') || !DOC_RE.test(e.name)) continue;
      if (/^(README|LICENSE|CONTRIBUTING|CHANGELOG)\./i.test(e.name)) continue;
      rels.push(e.name);
    }
  } catch { /* an unreadable root is an index with nothing in it */ }

  const docs = [];
  for (const rel of rels) {
    const doc = readDoc(key, rel);
    if (doc) docs.push(doc);
  }
  const byPath = new Map();
  const bySlug = new Map();
  for (const doc of docs) {
    doc.urls = candidatesFor(doc, cfg);
    for (const u of doc.urls) if (!byPath.has(u)) byPath.set(u, doc);
    if (doc.slug) bySlug.set(doc.slug, [...(bySlug.get(doc.slug) || []), doc]);
  }
  const index = { docs, byPath, bySlug, cfg, root: key };
  indexCache.set(key, { stamp, mtimes: mtimesOf(key, docs), index });
  return index;
}

// The documents' own mtimes, folded to one string — the half of the stamp a
// directory mtime cannot see (a permalink edited inside an existing file).
function mtimesOf(root, docs) {
  let acc = '';
  for (const d of docs || []) {
    try { acc += `${d.rel}:${Math.round(fs.statSync(d.path).mtimeMs)};`; } catch { acc += `${d.rel}:-;`; }
  }
  return acc;
}

/**
 * Which source file a url renders from.
 *
 * Returns `{doc, how}` — `how` is 'permalink' | 'convention' | 'slug' — or
 * `{doc: null, why}` when the page is under a registered origin and cannot be
 * mapped. THAT SECOND CASE IS AN ANSWER, not a silence: the drawer says it and
 * refuses the write scope, because a bot let loose on the repo with no idea
 * which file the reader means is exactly what this whole module exists to
 * prevent.
 */
export function resolvePath(root, urlPath) {
  const p = normPath(urlPath);
  const index = indexOf(root);
  const hit = index.byPath.get(p);
  if (hit) return { doc: hit, how: hit.permalink ? 'permalink' : 'convention' };
  // the slug fallback: the last real segment of the address, matched against
  // the slugs the repo actually contains. It is what carries a site whose
  // permalink style this module does not model.
  const segs = p.split('/').filter(Boolean);
  const last = segs.length ? slugify(segs[segs.length - 1].replace(DOC_RE, '')) : '';
  if (!last) {
    // "/" — the site's front page. Only an index document answers for it, and
    // `byPath` already tried that.
    return { doc: null, why: 'the front page of the site is not one post' };
  }
  const rows = index.bySlug.get(last) || [];
  if (rows.length === 1) return { doc: rows[0], how: 'slug' };
  if (rows.length > 1) {
    return {
      doc: null,
      why: `${rows.length} files in this repo share the slug “${last}” `
        + `(${rows.map(r => r.rel).join(', ')}) — give one of them a permalink and reload`,
    };
  }
  return { doc: null, why: `no markdown source in this repo renders at ${p}` };
}

// ---- the page record's answer --------------------------------------------

/**
 * The whole question in one call: is this url a page of a registered local
 * site, which file is it from, and has the reader vouched for the repo?
 *
 * null for every other address in the world — which is nearly all of them, and
 * costs a config read and a string compare to establish.
 */
export function blogPageFor(url) {
  const site = siteFor(url);
  if (!site) return null;
  let u = null;
  try { u = new URL(String(url)); } catch { return null; }
  const state = rootState(site.root);
  const base = {
    serve_origin: site.serve_origin,
    root: site.root,
    kind: site.kind,
    url_path: normPath(u.pathname),
    confirmed: state === 'yes',
    declined: state === 'no',
    // said on the wire as well as in the code, so the drawer can promise it in
    // the same words the confirmation card asks in
    git_allowed: gitAllowed(site.kind),
    // …and the same for the other promise: on this page the bots propose and
    // the reader accepts. The drawer draws the source card differently for it,
    // and it must not have to infer the mode from the absence of something.
    suggest_mode: suggestMode(site.kind),
  };
  if (!isDir(site.root)) {
    return { ...base, source_path: '', rel: '', why: `the repo is gone: ${site.root}` };
  }
  const r = resolvePath(site.root, u.pathname);
  if (!r.doc) return { ...base, source_path: '', rel: '', why: r.why };
  return {
    ...base,
    source_path: r.doc.path,
    rel: r.doc.rel,
    title: r.doc.title,
    doc_kind: r.doc.kind,
    mapped_by: r.how,
    assets: assetDirs(site.root).map(d => path.relative(site.root, d)),
  };
}

/** The asset directories this repo actually has, absolute. */
export function assetDirs(root) {
  return ASSET_DIRS.map(d => path.join(root, d)).filter(isDir);
}

// ---- the census -----------------------------------------------------------
// The same shape workspace.scanProject has, over a different skip list. A
// Jekyll repo carries its own rendered output (`_site/`) and its own caches,
// and every single one of them moves when jekyll rebuilds — which happens
// BECAUSE the bots edited the source. Counting them would make every turn a
// change and every change a reload loop.

export function scanSite(dir) {
  const out = new Map();
  if (!dir || !isDir(dir)) return out;
  const stack = [{ abs: dir, rel: '', depth: 0 }];
  while (stack.length && out.size < CENSUS_MAX) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;      // .git above all
      const abs = path.join(cur.abs, e.name);
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || cur.depth + 1 > 12) continue;
        stack.push({ abs, rel, depth: cur.depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;                 // a symlink's target is elsewhere
      let st = null;
      try { st = fs.statSync(abs); } catch { continue; }
      out.set(rel, `${Math.round(st.mtimeMs)}:${st.size}`);
      if (out.size >= CENSUS_MAX) break;
    }
  }
  return out;
}

// ---- markdown, in blocks the diff can read --------------------------------
//
// collateral.mjs diffs DOCUMENTS BY BLOCK, and its idea of a block comes from
// HTML tags (`docBlocks`). Handed raw markdown it sees no tags at all, folds
// the whole file into one block, and reports every edit anywhere in the post
// as one enormous region running from the first changed word to the last.
//
// So the source is presented to it the way it expects: one paragraph per
// block, escaped so that markdown which happens to contain angle brackets is
// not eaten as markup and comes back out of `decodeEntities` exactly as it
// went in. The front matter is a block like any other — a bot that changes the
// title has changed the document, and the reader should be told.
export function mdDoc(text) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text == null ? '' : text)
    .split(/\r?\n\s*\r?\n/)
    .map(b => b.trim())
    .filter(Boolean)
    .map(b => `<p>${esc(b)}</p>`)
    .join('\n');
}

// ---- the envelope's write rules ------------------------------------------

/**
 * What a blog turn tells the bots, in words: which file this page came from,
 * what may be touched, and what must not be.
 *
 * Two things it is careful about. The reader's comment quotes RENDERED text —
 * they highlighted a paragraph in a browser — and the bot is reading MARKDOWN,
 * so the turn says so and asks the bot to find the corresponding source itself
 * rather than pretending a source map exists. And the write scope is stated
 * twice over at two different strengths: the repo is what the sandbox enforces,
 * this post is what the reader asked for.
 *
 * ── AND THE THING IT NO LONGER SAYS ────────────────────────────────────────
 * It does not say "edit it". Since suggest mode, a bot on a blog page PROPOSES
 * and the reader accepts (suggest.mjs `suggestBlock`, appended to this one by
 * the server). The write scope below is still spelled out, because it is still
 * true and still the sandbox's own boundary — a model that thinks it cannot
 * write anywhere will not read a file either — but it is now the SAFETY NET
 * rather than the route. Which of the two is the route is said here in one
 * sentence and at length in the block that follows.
 */
export function blogBlock(blog) {
  if (!blog || !blog.source_path) return '';
  const dirs = (blog.assets || []).length ? blog.assets : ['assets'];
  const assets = dirs.map(a => `${blog.root}/${a}/`).join(', ');
  const first = `${blog.root}/${dirs[0]}/`;
  return `[blog draft: ${blog.url_path} · source ${blog.source_path}]\n`
    + `The reader is looking at this post RENDERED by a local Jekyll server at `
    + `${blog.serve_origin}${blog.url_path}. The rendered HTML is a photocopy — it is rebuilt `
    + `from source on every save and editing it achieves nothing. The document is the markdown `
    + `file named above; READ it before you change anything.\n`
    + `Quotes in this conversation come from the RENDERED page, so the wording you are given is `
    + `the prose without its markdown. Find the matching passage in the source yourself and quote `
    + `it back EXACTLY as the file has it — the front matter, the markdown body and the image `
    + `lines are all in scope, and all of them are changed the same way.\n`
    + `YOU DO NOT EDIT THIS FILE. You propose a change and the reader accepts or refuses it; the `
    + `block below says how a proposal is written. Nothing you say moves a single byte of the `
    + `post until the reader presses Accept.\n`
    + `WHERE YOU MAY WRITE — and you will normally write NOTHING AT ALL: ${blog.source_path} is `
    + `in the sandbox's writable scope because a directory is the only boundary an OS sandbox `
    + `understands, not because editing it is your job. Do not edit it. The one thing that is `
    + `still a real write is a PICTURE — an image file cannot be proposed as a passage of text — `
    + `so the image and attachment files this post uses under ${assets} are yours to place and `
    + `change directly, while the markdown LINE that references a new picture is proposed like `
    + `every other line. New images may be added `
    + `(put the file under ${first} and reference it with a site-absolute path, e.g. `
    + `\`![caption](/assets/images/name.png)\`, matching however the other images in this post are `
    + `written), and existing ones may be edited with whatever image tools this machine has `
    + `(\`sips\` on macOS, ImageMagick's \`magick\`/\`convert\` where it is installed — check before `
    + `you rely on one).\n`
    + `WHAT YOU MUST LEAVE ALONE unless the reader asks in so many words: every OTHER post, `
    + `_config.yml, _layouts/, _includes/, _sass/, _data/, the Gemfile, and _site/ (that is the `
    + `build output — never edit it, never commit it). The whole repository is technically `
    + `writable because a directory is the only boundary the sandbox has; this paragraph is the `
    + `rest of the boundary, and the reader is shown every file that moved when your turn ends.\n`
    + `DO NOT RUN GIT IN THIS REPOSITORY. No \`git add\`, no \`git commit\`, no \`git push\`, no `
    + `branch, checkout, stash, reset, tag or \`gh\` command — not to "save" your work, not to `
    + `tidy up, not even if the reader's words sound like they might want it. This is the `
    + `reader's published website and they put it live themselves, by their own route. Your `
    + `whole job ends at the working files: edit them, say what you changed, stop. (The CLI is `
    + `configured to refuse these commands as well; this paragraph is why, so you do not waste `
    + `the turn discovering it.) If the reader asks you to publish, tell them Discuss does not `
    + `do that and they publish it themselves.\n`
    + `When the reader accepts a proposal the companion makes the change, jekyll rebuilds by `
    + `itself and their tab reloads. That is the only way this post changes, and it is not `
    + `something you do — so never report an edit as done.\n`;
}

