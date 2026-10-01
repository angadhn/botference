// markers.mjs — the projects `botference init` / `botference site` put in
// Discuss's scope, and how the companion finds them without crawling the disk.
//
// Until this, the companion knew a site only if somebody had typed it into
// `blog_sites` in THIS workspace's `.botference/plugin/config.json` — the
// vault's own, because that is where the companion happens to run. That does
// not travel: the reader takes botference to a repo outside the vault, runs
// `botference init` there, opens the book in the browser, and nothing happens.
//
// So the declaration moves to where the project is, and the companion is told
// where to look:
//
//   THE MARKER    `<root>/.botference/site.json` — `{kind, serve_origin,
//                 rebuild?, enabled}`. Written by the launcher (site-cli.mjs),
//                 in a folder that is gitignored in that repo, so it never
//                 travels with the reader's published site.
//   THE REGISTRY  `~/.botference/sites.json` — `{roots: [...]}`, the list of
//                 folders that have a marker. One per machine, beside the
//                 other per-user state (plugin-workspace, the keys), and the
//                 only reason the companion does not have to search the disk.
//
// A marker is read AS IF it were a `blog_sites` row (blog.mjs normalizes it
// through the same three-field rule, so a marker can no more switch off the
// no-git or propose-only rules than a config row can). The hand-written
// `blog_sites` keeps working beside it and wins for an origin both name: it is
// the more deliberate of the two, and it lives in the companion's own config.
//
// What running the command in the repo ALSO means: the reader has vouched for
// it. The drawer's "is this your site?" exists because a declaration typed
// into a config file elsewhere says nothing about whether the bots may write
// here; running `botference site` IN the folder is that answer, given by hand.
// An explicit answer stored in `blog_roots` (a NO above all) still wins — the
// launcher sends the yes to a running companion when it registers a root, which
// is the moment the reader said it.
//
// Pure file I/O, no knowledge of kinds or origins beyond their spelling: the
// rules live in blog.mjs, which imports this and never the other way round.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARKER_REL = path.join('.botference', 'site.json');
export const MARKER_KINDS = ['jupyterbook', 'jekyll', 'plain'];

/** Where the registry lives. BOTFERENCE_SITES_REGISTRY moves it (the tests). */
export function registryFile() {
  return process.env.BOTFERENCE_SITES_REGISTRY
    || path.join(os.homedir(), '.botference', 'sites.json');
}

const real = p => {
  if (!p) return '';
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch { return path.resolve(p); }
};
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// tmp + rename, the rule every other state file here keeps
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Every registered root, absolute, de-duplicated, in registration order. */
export function readRegistry() {
  const j = readJson(registryFile());
  const rows = Array.isArray(j) ? j : (j && Array.isArray(j.roots) ? j.roots : []);
  const out = [];
  for (const r of rows) {
    const s = typeof r === 'string' ? r : (r && r.root);
    if (s && path.isAbsolute(String(s)) && !out.includes(String(s))) out.push(String(s));
  }
  return out;
}
function writeRegistry(roots) { writeJson(registryFile(), { roots }); }

/** Add a root (moved to the END: the newest registration wins an origin). */
export function registerRoot(root) {
  const r = real(root);
  writeRegistry([...readRegistry().filter(x => x !== r), r]);
  return r;
}
/** Take a root out. Returns whether it was there. */
export function unregisterRoot(root) {
  const r = real(root);
  const was = readRegistry();
  const kept = was.filter(x => x !== r && x !== path.resolve(String(root || '')));
  if (kept.length !== was.length) writeRegistry(kept);
  return kept.length !== was.length;
}

export const markerFile = root => path.join(real(root), MARKER_REL);
/** The marker as written, or null (missing or unreadable). */
export function readMarker(root) {
  const j = readJson(markerFile(root));
  return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
}
/** Write the marker — exactly these four fields, nothing else carried. */
export function writeMarker(root, { kind, serve_origin = '', rebuild = '', enabled = true }) {
  const m = { kind, serve_origin, ...(rebuild ? { rebuild } : {}), enabled: enabled !== false };
  writeJson(markerFile(root), m);
  return m;
}

/**
 * Every registered root's marker, as raw rows for blog.mjs to normalize:
 * `{rows: [{root, kind, serve_origin, rebuild}], skipped: [{root, why}]}`.
 * Skipped, and SAID: a root that is gone, one with no marker or an unreadable
 * one, and one switched off (`enabled: false`). Nothing is removed from the
 * registry for being skipped — a disk that is unmounted today is back tomorrow.
 */
export function loadMarkers() {
  const rows = [];
  const skipped = [];
  for (const root of readRegistry()) {
    let st = null;
    try { st = fs.statSync(root); } catch { st = null; }
    if (!st || !st.isDirectory()) { skipped.push({ root, why: 'the folder is gone' }); continue; }
    const m = readMarker(root);
    if (!m) { skipped.push({ root, why: `no readable ${MARKER_REL}` }); continue; }
    if (m.enabled === false) { skipped.push({ root, why: 'switched off (enabled: false)' }); continue; }
    rows.push({ root: real(root), kind: String(m.kind || ''), serve_origin: String(m.serve_origin || ''),
      rebuild: String(m.rebuild || '') });
  }
  return { rows, skipped };
}
