// hubtheme.mjs — the owner's own stylesheet for the Hub ("my personalised reader").
//
// `hub_theme_dir` names a local folder holding hub.css and, if wanted, font files. The companion serves ONLY files directly in that
// folder, by name, with the extensions below, under /hub/theme/<name>, behind the same gate as the Hub: no directory listing, no
// path (a name with a slash or a dot-dot is refused), no symlink that leads out of the folder, a size cap per file. The folder may
// not be inside the companion's own data folders. Its state is one of THEME_STATES, worked out here and nowhere else.
//   none       — no folder is set
//   ok         — the folder is there, outside the data folders, and hub.css in it can be served
//   unreadable — a folder is set but cannot be used (missing, not a folder, inside the data folders, no usable hub.css);
//                the built-in look is used, untouched
import fs from 'node:fs';
import path from 'node:path';

export const THEME_STATES = Object.freeze(['none', 'ok', 'unreadable']);
export const THEME_TYPES = Object.freeze({
  css: 'text/css; charset=utf-8', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
});
export const THEME_MAX = Object.freeze({ css: 256 * 1024, font: 2 * 1024 * 1024 });
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const real = p => { try { return fs.realpathSync(p); } catch { return ''; } };
const inside = (child, dir) => { const d = real(dir) || path.resolve(dir); return child === d || child.startsWith(d.endsWith(path.sep) ? d : d + path.sep); };

/** The file a theme request names, or { refused }. */
export function themeFile(dir, name, forbidden = []) {
  if (!dir) return { refused: 'no theme is set' };
  const base = real(dir);
  if (!base || !fs.statSync(base).isDirectory()) return { refused: 'the theme folder is not usable' };
  if (forbidden.some(f => f && inside(base, f))) return { refused: 'the theme folder may not be inside the companion\'s data folders' };
  const n = String(name || '');
  if (!NAME_RE.test(n) || n.includes('..')) return { refused: 'not a theme file name' };
  const ext = n.slice(n.lastIndexOf('.') + 1).toLowerCase();
  if (!n.includes('.') || !Object.prototype.hasOwnProperty.call(THEME_TYPES, ext)) return { refused: 'not a theme file type' };
  const file = path.join(base, n);
  let st;
  try { st = fs.lstatSync(file); } catch { return { refused: 'no such theme file' }; }
  // a symlink is followed only if it leads to a file still inside the folder
  const target = real(file);
  if (!target || !inside(target, base)) return { refused: 'that file leads outside the theme folder' };
  try { st = fs.statSync(target); } catch { return { refused: 'no such theme file' }; }
  if (!st.isFile()) return { refused: 'not a file' };
  if (st.size > (ext === 'css' ? THEME_MAX.css : THEME_MAX.font)) return { refused: 'that theme file is too large' };
  return { file: target, type: THEME_TYPES[ext], bytes: st.size };
}
/** → { state, reason }. */
export function themeState(dir, forbidden = []) {
  if (!dir) return { state: 'none', reason: '' };
  const r = themeFile(dir, 'hub.css', forbidden);
  return r.refused ? { state: 'unreadable', reason: r.refused === 'no such theme file' ? 'the folder has no hub.css' : r.refused } : { state: 'ok', reason: '' };
}
/** Read the file named (for the route): → { body, type } or { refused }. */
export function readThemeFile(dir, name, forbidden = []) {
  const r = themeFile(dir, name, forbidden);
  if (r.refused) return r;
  try { return { body: fs.readFileSync(r.file), type: r.type }; } catch { return { refused: 'unreadable' }; }
}
