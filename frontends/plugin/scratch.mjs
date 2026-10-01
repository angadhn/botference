// scratch.mjs — where a blog or book turn's produced files go, and the one
// thing the companion does with them by itself.
//
// blog.mjs says WHERE (`scratchDir`, `scratchLink`, and the paragraph every
// blog and book envelope carries) and writes nothing. This is the half that
// writes, kept out of blog.mjs so that file's promise stays true:
//
//   ensureScratch      makes `<root>/.botference/plugin/artifacts/` and makes
//                      sure `.botference/` is gitignored in the reader's repo
//                      — once, appending the one line if it is missing, never
//                      duplicating it (the rule lib/review.sh's
//                      review_ensure_gitignore keeps for a paper repo).
//   scratchFilesPath   the `/files/site-artifacts/<key>/<name>` route: which
//                      file on disk a scratch link names, or ''.
//   placeFromScratch   the turn-end safety net (below).
//
// ── THE SAFETY NET ─────────────────────────────────────────────────────────
// The envelope tells the bots to write a finished picture straight into the
// page's image folder. A model that half-follows it — draws the figure in the
// scratch folder, proposes `images/fig1.png` on a card, and stops — leaves a
// card that previews nothing and a reader who would have to go and copy a file
// by hand, which is exactly the chore this whole change exists to remove. So
// at turn-end, for every picture a suggestion card PROPOSES whose file is not
// in the book, a file of the same name in the scratch folder is copied into
// place, and the census says so. Never over an existing file: a picture the
// book already has is the reader's, and a scratch file with the same name is a
// draft of it, not a replacement for it.
//
// The picture detection is the server's twin of anchor.js `imageRefs` (the
// drawer's): `![alt](src)`, a MyST {figure}/{image} fence, an `<img src>`, and
// a passage that is nothing but one picture's path. Held in agreement by
// test/scratch.test.mjs rather than by importing a browser file.
import fs from 'node:fs';
import path from 'node:path';
import {
  realish, scratchDir, scratchKey, SCRATCH_TOP, listSites, rootState, skipDirsFor,
} from './blog.mjs';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const inside = (root, abs) => {
  const rel = path.relative(root, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// ---- the folder and its gitignore line ----------------------------------

// Any of these already ignores the folder; the line added is the first.
const IGNORE_FORMS = ['.botference/', '.botference', '/.botference/', '/.botference', '.botference/*'];

/**
 * Make sure `.botference/` is ignored in this repo's `.gitignore`. Appends the
 * one line when no form of it is there (fixing a missing trailing newline
 * first, as the shell helper does); creates the file only when there is none.
 * Returns true when it wrote. Never throws: a read-only repo costs the reader
 * one untracked folder, not the turn.
 */
export function ensureGitignore(root) {
  if (!root || !isDir(root)) return false;
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch { text = ''; }
  const have = text.split(/\r?\n/).map(l => l.trim());
  if (IGNORE_FORMS.some(f => have.includes(f))) return false;
  try {
    fs.appendFileSync(gi, `${text && !text.endsWith('\n') ? '\n' : ''}${IGNORE_FORMS[0]}\n`);
    return true;
  } catch { return false; }
}

/** The scratch folder for a site root, made and gitignored. '' on failure. */
export function ensureScratch(root) {
  const dir = scratchDir(root);
  if (!dir) return '';
  ensureGitignore(realish(root));
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return ''; }
}

// ---- the /files/ route ---------------------------------------------------

/**
 * The file a `/files/site-artifacts/<key>/<rest>` path names, or ''. The key
 * is matched against the DECLARED and CONFIRMED sites only — a link cannot
 * name a folder by path, and a site the reader has not vouched for serves
 * nothing. Segments are checked after decoding (no empty, no dot-leading), the
 * same rule workspace.filesSegs keeps for the other three top folders.
 */
export function scratchFilesPath(rel) {
  let s = String(rel || '');
  try { s = decodeURIComponent(s); } catch { return ''; }
  if (!s || s.includes('\0') || path.isAbsolute(s)) return '';
  const segs = s.split(/[\\/]+/);
  if (segs.length < 3 || segs[0] !== SCRATCH_TOP) return '';
  if (segs.some(seg => !seg || seg.startsWith('.'))) return '';
  const site = listSites().find(x => rootState(x.root) === 'yes' && scratchKey(x.root) === segs[1]);
  if (!site) return '';
  const base = scratchDir(site.root);
  const abs = path.resolve(base, ...segs.slice(2));
  if (!inside(base, abs) || !isFile(abs)) return '';
  let real = '';
  try { real = fs.realpathSync(abs); } catch { return ''; }
  return inside(realish(base), real) ? real : '';
}

// ---- which pictures a card proposes -------------------------------------

const PIC_EXT = /\.(?:png|jpe?g|gif|svg|webp|avif|bmp)$/i;
const PIC_PATH = /^[^\s()<>\[\]`*"']+\.(?:png|jpe?g|gif|svg|webp|avif|bmp)(?:[?#]\S*)?$/i;
const MD_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const MYST_FIG = /(?:`{3,}|:{3,})\{(?:figure|image)\}[ \t]+(\S+)/g;
const IMG_TAG = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

/** Every picture path a passage references, in the forms anchor.js knows. */
export function pictureRefs(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  for (const re of [MYST_FIG, MD_IMAGE, IMG_TAG]) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) out.push(m[1]);
  }
  // the bare path: a passage that is nothing but one picture's path (a bot
  // swapping the picture inside a {figure} fence proposes only that line)
  if (!out.length && PIC_PATH.test(s.trim())) out.push(s.trim());
  return [...new Set(out.map(r => r.split(/[?#]/)[0])
    .filter(r => r && PIC_EXT.test(r) && !/^[a-z][\w+.-]*:/i.test(r) && !r.startsWith('//')))];
}

// The newest file called `name` anywhere in the scratch folder (a bot may
// well keep a figure's drafts in a sub-folder of their own), or ''.
function findInScratch(dir, name, depth = 4) {
  let best = '';
  let bestAt = -1;
  const stack = [{ abs: dir, d: 0 }];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = path.join(cur.abs, e.name);
      if (e.isDirectory()) { if (cur.d + 1 <= depth) stack.push({ abs, d: cur.d + 1 }); continue; }
      if (!e.isFile() || e.name !== name) continue;
      let at = 0;
      try { at = fs.statSync(abs).mtimeMs; } catch { continue; }
      if (at > bestAt) { best = abs; bestAt = at; }
    }
  }
  return best;
}

/**
 * What the safety net WOULD do for these cards on this page, without doing it:
 * `[{src, from, to, rel}]`, one per picture that a card proposes, that the book
 * does not have, and that the scratch folder does. Resolved the way the bots
 * are told to write it (blog.imagePathFor's rule): site-absolute from the
 * root, relative from the page's SOURCE directory. Refused: anything outside
 * the root, through a dot directory, or into the build output.
 */
export function scratchPlan(bg, cards) {
  if (!bg || !bg.root || !bg.source_path) return [];
  const root = realish(bg.root);
  const scratch = scratchDir(root);
  if (!isDir(scratch)) return [];
  const skip = skipDirsFor(bg.kind);
  const plan = [];
  const seen = new Set();
  for (const c of cards || []) {
    if (!c || c.state !== 'open' || c.deletes) continue;
    for (const src of pictureRefs(c.proposed)) {
      let ref = src;
      try { ref = decodeURIComponent(ref); } catch { continue; }
      const base = ref.startsWith('/') ? root : path.dirname(realish(String(bg.source_path)));
      const to = path.resolve(base, ref.replace(/^\/+/, ''));
      if (!inside(root, to) || seen.has(to)) continue;
      const rel = path.relative(root, to).split(path.sep);
      if (rel.slice(0, -1).some(seg => seg.startsWith('.') || skip.has(seg))) continue;
      seen.add(to);
      if (fs.existsSync(to)) continue;                 // the book has it: nothing to do, ever
      const from = findInScratch(scratch, path.basename(to));
      if (!from) continue;
      plan.push({ src, from, to, rel: rel.join('/') });
    }
  }
  return plan;
}

/**
 * The safety net itself: copy each planned picture into the book, never over
 * an existing file (COPYFILE_EXCL — the check above and the copy are two
 * moments, and the copy is the one that is final). The folder it lands in is
 * made if it is missing, after checking that its nearest existing ancestor
 * really is inside the root (a symlinked directory does not get to carry the
 * copy out). Returns `[{rel, from}]` for what was placed, `from` relative to
 * the scratch folder; a copy that fails is simply not in the list.
 */
export function placeFromScratch(bg, cards) {
  const plan = scratchPlan(bg, cards);
  if (!plan.length) return [];
  const root = realish(bg.root);
  const scratch = scratchDir(root);
  const placed = [];
  for (const p of plan) {
    let anc = path.dirname(p.to);
    while (!fs.existsSync(anc) && anc !== root && inside(root, anc)) anc = path.dirname(anc);
    if (anc !== root && !inside(root, realish(anc))) continue;
    try {
      fs.mkdirSync(path.dirname(p.to), { recursive: true });
      fs.copyFileSync(p.from, p.to, fs.constants.COPYFILE_EXCL);
      placed.push({ rel: p.rel, from: path.relative(scratch, p.from).split(path.sep).join('/') });
    } catch { /* already there by now, or unwritable: the book keeps what it has */ }
  }
  return placed;
}

/** The census line for what was placed: "placed images/x.png from scratch". */
export const placedNote = placed => (placed && placed.length
  ? `placed ${placed.map(p => p.rel).join(', ')} from scratch` : '');
