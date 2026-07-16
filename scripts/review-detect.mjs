#!/usr/bin/env node
// Detects a document repo's review configuration and writes
// review/review.config.json — everything except the bridge block, which
// review/init-config.mjs owns. Prints a detection summary so the user
// can eyeball what was guessed. Never overwrites an existing config.
// Usage: node scripts/review-detect.mjs [doc-repo-dir]
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(process.argv[2] || process.cwd());
const cfgFile = path.join(ROOT, 'review', 'review.config.json');
if (fs.existsSync(cfgFile)) {
  console.log(`review.config.json already exists — leaving it alone (${cfgFile})`);
  process.exit(0);
}

const read = f => fs.readFileSync(f, 'utf8');
const stripComments = s => s.replace(/(?<!\\)%.*$/gm, '');
const prettify = f => path.basename(f).replace(/\.(tex|md)$/, '')
  .replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const rel = f => path.relative(ROOT, f);

const rootFiles = fs.readdirSync(ROOT);
const texFiles = rootFiles.filter(f => f.endsWith('.tex'));

// --- master file: root-level .tex containing \documentclass ---
const masters = texFiles.filter(f => /\\documentclass/.test(stripComments(read(path.join(ROOT, f)))));
const inputCount = f =>
  (stripComments(read(path.join(ROOT, f))).match(/\\(?:input|include)\s*\{/g) || []).length;
masters.sort((a, b) => inputCount(b) - inputCount(a) || a.localeCompare(b));
const main = masters[0] || null;

const cfg = { slug: path.basename(ROOT).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'review' };
const notes = [];
let figStats = null; // {referenced, resolved} — latex only, for the summary

function sectionTitle(file, fallback) {
  const src = stripComments(read(file));
  if (/abstract/i.test(path.basename(file))) return 'Abstract';
  const m = /\\(?:section|chapter)\*?\s*\{([^}]*)\}/.exec(src);
  return (m && m[1].trim()) || fallback;
}

if (main) {
  cfg.format = 'latex';
  cfg.main = main;
  const mainSrc = stripComments(read(path.join(ROOT, main)));

  // masthead title: build.mjs parses \title{} from the master each build; when
  // the paper has none, emit an empty "title" for the user to fill in (an
  // explicit config title always wins over the \title parse). Never guessed.
  if (!/\\title\s*\{/.test(mainSrc)) {
    cfg.title = '';
    notes.push('no \\title{} in the master — the masthead will be empty; set "title" in review/review.config.json to name the paper');
  }

  // sections from \input/\include order
  const sections = [];
  for (const m of mainSrc.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
    let f = m[1].trim();
    if (!path.extname(f)) f += '.tex';
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    sections.push({ file: f, title: sectionTitle(abs, prettify(f)) });
  }
  if (!sections.length) {
    const t = /\\title\s*\{([^}]*)\}/.exec(mainSrc);
    const cleanTitle = s => s.replace(/\\\\/g, ' ').replace(/\\[a-zA-Z]+\*?\s*/g, '')
      .replace(/[{}~]/g, ' ').replace(/\s+/g, ' ').trim();
    sections.push({ file: main, title: (t && cleanTitle(t[1])) || prettify(main) });
    // count section commands in the document body only (not preamble helpers)
    const body = mainSrc.slice(mainSrc.indexOf('\\begin{document}') + 1 || 0);
    const nSec = (body.match(/\\section\*?(?:\[[^\]]*\])?\s*\{/g) || []).length;
    if (nSec >= 2) {
      notes.push(`single-file paper: ${nSec} \\section commands found — the build splits it into ${nSec} section pages (plus a front-matter/abstract page)`);
    } else {
      notes.push('no \\input/\\include found — reviewing the master file as one section');
    }
  }
  cfg.sections = sections;

  // bib: \bibliography / \addbibresource, else root *.bib
  const bib = [];
  for (const m of mainSrc.matchAll(/\\bibliography\s*\{([^}]+)\}/g)) {
    for (let b of m[1].split(',')) {
      b = b.trim(); if (!b) continue;
      if (!b.endsWith('.bib')) b += '.bib';
      if (fs.existsSync(path.join(ROOT, b))) bib.push(b);
    }
  }
  for (const m of mainSrc.matchAll(/\\addbibresource\s*\{([^}]+)\}/g)) {
    const b = m[1].trim();
    if (fs.existsSync(path.join(ROOT, b))) bib.push(b);
  }
  if (!bib.length) bib.push(...rootFiles.filter(f => f.endsWith('.bib')));
  if (bib.length) cfg.bib = [...new Set(bib)];

  // abbreviations: first file defining \newacronym
  const scanned = [...new Set([main, ...sections.map(s => s.file), ...texFiles])];
  for (const f of scanned) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs) && /\\newacronym\{/.test(stripComments(read(abs)))) {
      cfg.abbreviations = f;
      break;
    }
  }

  // todo macros: \newcommand{\todoXxx}... — author name from the suffix
  const todoMacros = {};
  for (const f of scanned) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    for (const m of read(abs).matchAll(/\\(?:re)?newcommand\*?\s*\{?\\(todo[A-Za-z]*)\}?/g)) {
      todoMacros[m[1]] = m[1] === 'todo' ? 'unknown' : m[1].replace(/^todo/, '');
    }
  }
  if (Object.keys(todoMacros).length) cfg.todo_macros = todoMacros;

  // figure dirs: every \graphicspath entry + dirs referenced by \includegraphics
  // arguments across the scanned sources, else a conventional directory name
  const figDirs = new Set();
  const normDir = d => d.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)+)\}/.exec(mainSrc);
  if (gp) for (const d of gp[1].matchAll(/\{([^}]*)\}/g)) {
    const dir = normDir(d[1]);
    if (dir && fs.existsSync(path.join(ROOT, dir))) figDirs.add(dir);
  }
  const figRefs = [];
  for (const f of scanned) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    for (const m of stripComments(read(abs)).matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      figRefs.push(m[1].trim().replace(/^\.\//, ''));
    }
  }
  const exts = ['', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.pdf'];
  const resolveFig = arg => {
    for (const b of [arg, ...[...figDirs].map(d => `${d}/${arg}`)]) {
      for (const e of exts) {
        try { if (fs.statSync(path.join(ROOT, b + e)).isFile()) return b + e; } catch { }
      }
    }
    return null;
  };
  let figResolved = 0;
  for (const arg of figRefs) {
    const hit = resolveFig(arg);
    if (!hit) continue;
    figResolved++;
    const dir = path.dirname(hit);
    if (dir !== '.') figDirs.add(dir);
  }
  if (!figDirs.size) {
    const conv = ['Figures', 'figures', 'figs', 'images', 'img'].find(d => fs.existsSync(path.join(ROOT, d)));
    figDirs.add(conv || 'Figures');
  }
  cfg.figures_dirs = [...figDirs];
  figStats = { referenced: figRefs.length, resolved: figResolved };
} else {
  const mdFiles = rootFiles.filter(f => f.endsWith('.md')).sort();
  if (!mdFiles.length) {
    console.error(`no .tex file with \\documentclass and no .md files found in ${ROOT}`);
    console.error('write review/review.config.json by hand (see frontends/review/SCHEMA.md) and rerun.');
    process.exit(1);
  }
  cfg.format = 'markdown';
  cfg.sections = mdFiles.map(f => {
    const m = /^#\s+(.+)$/m.exec(read(path.join(ROOT, f)));
    return { file: f, title: (m && m[1].trim()) || prettify(f) };
  });
  cfg.figures_dirs = [['Figures', 'figures', 'images', 'img'].find(d => fs.existsSync(path.join(ROOT, d))) || 'Figures'];
  notes.push('no LaTeX master found — falling back to markdown sections');
}

// free port, scanned from 4180 (4177 is the conventional first deployment)
const portFree = p => new Promise(res => {
  const s = net.createServer();
  s.once('error', () => res(false));
  s.once('listening', () => s.close(() => res(true)));
  s.listen(p, '127.0.0.1');
});
let port = 4180;
while (!(await portFree(port))) port++;
cfg.port = port;

fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1));

console.log(`detected configuration → ${rel(cfgFile)}`);
console.log(`  format:        ${cfg.format}`);
if (cfg.main) console.log(`  main:          ${cfg.main}${masters.length > 1 ? `  (candidates: ${masters.join(', ')})` : ''}`);
console.log(`  sections:      ${cfg.sections.length}`);
for (const s of cfg.sections) console.log(`    - ${s.file}  (${s.title})`);
console.log(`  bib:           ${(cfg.bib || []).join(', ') || '(none)'}`);
console.log(`  abbreviations: ${cfg.abbreviations || '(none)'}`);
console.log(`  todo macros:   ${Object.keys(cfg.todo_macros || {}).join(', ') || '(none)'}`);
console.log(`  figure dirs:   ${cfg.figures_dirs.join(', ')}`);
if (figStats) {
  console.log(`  figures:       ${figStats.referenced} referenced, ${figStats.resolved} resolved on disk`);
  if (figStats.referenced && !figStats.resolved) {
    console.log('  WARNING: zero referenced figures resolve on disk — figures will render as placeholders.');
    console.log('           Fix figures_dirs in review/review.config.json (or the image files) and rebuild.');
  }
}
console.log(`  port:          ${cfg.port}`);
for (const n of notes) console.log(`  note: ${n}`);
console.log('edit review/review.config.json if any of this guessed wrong.');
