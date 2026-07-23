#!/usr/bin/env node
// Generic review-site builder: renders configured sections to commentable HTML.
// All document-specific values come from review.config.json. Read-only w.r.t. sources.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REVIEW = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(REVIEW, '..');
const OUT = path.join(REVIEW, 'site');
const CFG = JSON.parse(fs.readFileSync(path.join(REVIEW, 'review.config.json'), 'utf8'));

const slugify = (t, i) => String(i).padStart(2, '0') + '-' +
  t.replace(/^[\d.\s]+/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// figure dirs: figures_dirs (array) with legacy figures_dir (string) still honored
const FIG_DIRS = [...new Set([].concat(CFG.figures_dirs ?? CFG.figures_dir ?? [])
  .map(d => String(d).replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean))];

// --- optional acronym map (\newacronym{key}{SHORT}{long form}) ---
const ACR = {};
if (CFG.abbreviations) {
  const src = fs.readFileSync(path.join(ROOT, CFG.abbreviations), 'utf8');
  for (const m of src.matchAll(/^[^%\n]*\\newacronym\{(\w+)\}\{([^}]*)\}\{([^}]*)\}/gm)) {
    ACR[m[1]] = { short: m[2], long: m[3] };
  }
}

function braceArg(src, i) {
  let depth = 0, start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') { if (depth === 0) start = i + 1; depth++; }
    else if (src[i] === '}') { depth--; if (depth === 0) return { text: src.slice(start, i), end: i + 1 }; }
  }
  return null;
}
function replaceMacro(src, re, wrap) {
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    const arg = braceArg(src, re.lastIndex - 1);
    if (!arg) break;
    out += src.slice(last, m.index) + wrap(arg.text, m);
    last = arg.end; re.lastIndex = arg.end;
  }
  return out + src.slice(last);
}

// --- virtual sections: a configured LaTeX file holding several \section
// commands (single-file papers) is split at \section boundaries into one page
// each. The split is recomputed from the source on every build — no offsets
// are stored in the config, so edits to the file can never desync it.
// Opt out per entry with "split": false.
function sectionMarks(src) {
  const marks = [];
  let off = 0;
  for (const line of src.split('\n')) {
    const cut = line.search(/(?<!\\)%/);
    const eff = cut === -1 ? line : line.slice(0, cut);
    for (const m of eff.matchAll(/\\section\*?(?:\[[^\]]*\])?\s*\{/g)) {
      const arg = braceArg(src, off + m.index + m[0].length - 1);
      if (arg) marks.push({ offset: off + m.index, title: arg.text.replace(/\s+/g, ' ').trim() });
    }
    off += line.length + 1;
  }
  return marks;
}
// LaTeX title text -> plain page title (strip commands/braces, escape HTML)
const cleanTitle = t => t.replace(/\\([&%#_$])/g, '$1').replace(/\\\\/g, ' ')
  .replace(/\\[a-zA-Z]+\*?\s*/g, '').replace(/[{}~]/g, ' ').replace(/\s+/g, ' ').trim()
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function expandSections(list) {
  if (CFG.format !== 'latex') return list;
  const out = [];
  for (const s of list) {
    const src = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
    // chunk within the document body only; every chunk is re-wrapped in the
    // full preamble + \begin{document}…\end{document} so it parses as a
    // complete document (pandoc rejects an unterminated \begin{document})
    // and preamble \newcommand macros keep working on every page
    const beginM = /\\begin\{document\}/.exec(src);
    const bodyStart = beginM ? beginM.index + beginM[0].length : 0;
    const endM = /\\end\{document\}/.exec(src);
    const body = src.slice(bodyStart, endM ? endM.index : src.length);
    const wrap = beginM ? c => src.slice(0, bodyStart) + '\n' + c + '\n\\end{document}\n' : c => c;
    const marks = s.split === false ? [] : sectionMarks(body);
    if (marks.length < 2) { out.push({ ...s }); continue; }
    const front = body.slice(0, marks[0].offset);
    const frontBody = front
      .replace(/(?<!\\)%.*$/gm, '')
      .replace(/\\(maketitle|tableofcontents|listoffigures|listoftables|linenumbers|modulolinenumbers)(\[[^\]]*\])?/g, '');
    if (frontBody.trim()) {
      out.push({ file: s.file, source: wrap(front),
        title: /\\begin\{abstract\}|\\abstract\s*\{/.test(front) ? 'Abstract' : 'Front Matter' });
    }
    marks.forEach((m, j) => {
      const end = j + 1 < marks.length ? marks[j + 1].offset : body.length;
      out.push({ file: s.file, title: cleanTitle(m.title) || `Section ${j + 1}`, source: wrap(body.slice(m.offset, end)) });
    });
    console.log(`split ${s.file}: ${marks.length} section pages${frontBody.trim() ? ' + front matter' : ''}`);
  }
  return out;
}
const SECTIONS = expandSections(CFG.sections).map((s, i) => ({ ...s, slug: slugify(s.title, i) }));

// --- TikZ figures: pandoc drops tikzpicture environments, so each one is
// compiled to SVG (standalone doc reusing the paper's preamble minus page-
// layout packages) and swapped in as a synthetic \includegraphics token —
// the wrapping figure/caption/label stay with pandoc, so global figure
// numbering and refs are untouched. SVGs are cached by content hash under
// site/tikz/; compile failures or a missing toolchain degrade to the
// fig-placeholder pattern and a build warning, never a broken build.
const TIKZ = { count: 0, failed: 0, dir: path.join(OUT, 'tikz') };
const _tools = new Map();
function hasTool(cmd) {
  if (!_tools.has(cmd)) {
    // pdftocairo only understands -v; the others accept --version
    try { execFileSync(cmd, [cmd === 'pdftocairo' ? '-v' : '--version'], { stdio: 'ignore' }); _tools.set(cmd, true); }
    catch { _tools.set(cmd, false); }
  }
  return _tools.get(cmd);
}
let _tikzPre;
function tikzPreamble() {
  if (_tikzPre !== undefined) return _tikzPre;
  let pre = '';
  try {
    const src = fs.readFileSync(path.join(ROOT, CFG.main), 'utf8');
    const at = src.indexOf('\\begin{document}');
    pre = (at === -1 ? '' : src.slice(0, at))
      .replace(/(?<!\\)%.*$/gm, '')
      .replace(/\\documentclass(\[[^\]]*\])?\s*\{[^}]*\}/, '')
      // page-layout packages make no sense (or error) under standalone;
      // combined \usepackage{a,fancyhdr,b} lists keep their other packages
      .replace(/\\usepackage\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g, (m, opt, list) => {
        const pkgs = list.split(',').map(s => s.trim()).filter(Boolean);
        const keep = pkgs.filter(p => !/^(geometry|fancyhdr|fullpage|hyperref)$/.test(p));
        if (!keep.length) return '';
        return keep.length === pkgs.length ? m : `\\usepackage{${keep.join(',')}}`;
      })
      .split('\n').filter(l =>
        !/\\(pagestyle|thispagestyle|fancyhf|fancyhead|fancyfoot|[lcr]head|[lcr]foot)\b/.test(l) &&
        !/\\(head|foot)rulewidth\b/.test(l)).join('\n');
  } catch { }
  _tikzPre = pre;
  return pre;
}
function compileTikz(body) {
  const doc = `\\documentclass[tikz,border=2pt]{standalone}\n${tikzPreamble()}\n\\begin{document}\n${body}\n\\end{document}\n`;
  const hash = crypto.createHash('sha256').update(doc).digest('hex').slice(0, 16);
  const svg = path.join(TIKZ.dir, `${hash}.svg`);
  if (fs.existsSync(svg)) return hash; // rebuilds skip unchanged pictures
  if (!hasTool('pdflatex')) {
    figWarnings.add('pdflatex not found on PATH — TikZ figures shown as placeholders');
    return null;
  }
  const conv = hasTool('pdftocairo') ? 'pdftocairo' : hasTool('dvisvgm') ? 'dvisvgm' : null;
  if (!conv) {
    figWarnings.add('no PDF→SVG converter found (pdftocairo or dvisvgm) — TikZ figures shown as placeholders');
    return null;
  }
  fs.mkdirSync(TIKZ.dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(TIKZ.dir, '.build-'));
  try {
    fs.writeFileSync(path.join(tmp, 'fig.tex'), doc);
    execFileSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'fig.tex'],
      { cwd: tmp, stdio: 'pipe', timeout: 60000 });
    if (conv === 'pdftocairo') {
      execFileSync('pdftocairo', ['-svg', 'fig.pdf', 'fig.svg'], { cwd: tmp, stdio: 'pipe', timeout: 30000 });
    } else {
      execFileSync('dvisvgm', ['--pdf', 'fig.pdf', '-o', 'fig.svg'], { cwd: tmp, stdio: 'pipe', timeout: 30000 });
    }
    fs.copyFileSync(path.join(tmp, 'fig.svg'), svg);
    return hash;
  } catch (e) {
    const texErr = String(e.stdout || '').split('\n').find(l => l.startsWith('!'));
    figWarnings.add(`tikzpicture failed to compile: ${texErr || String(e.message).slice(0, 120)}`);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function extractTikz(src) {
  return src.replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g, m => {
    TIKZ.count++;
    const hash = compileTikz(m);
    if (!hash) { TIKZ.failed++; return '\\includegraphics{__tikzfail__}'; }
    return `\\includegraphics{__tikz_${hash}__}`;
  });
}

const todos = [];
let EQC = 0; const eqNum = {};

// --- LaTeX preprocessing: extract todo annotations, fix constructs pandoc rejects ---
function preprocessLatex(src, slug) {
  src = extractTikz(src); // first, so no later rewrite touches TikZ code
  const macroNames = Object.keys(CFG.todo_macros || {});
  if (macroNames.length) {
    const todoRe = new RegExp('\\\\(' + macroNames.join('|') + ')(\\[[^\\]]*\\])?\\s*\\{', 'g');
    let out = '', last = 0, m;
    while ((m = todoRe.exec(src))) {
      const arg = braceArg(src, todoRe.lastIndex - 1);
      if (!arg) break;
      const id = `todo-${slug}-${todos.length}`;
      const ctx = src.slice(Math.max(0, m.index - 120), m.index).replace(/\s+/g, ' ').trim();
      todos.push({ id, type: 'old-todo', author: CFG.todo_macros[m[1]] || 'unknown', section: slug,
        text: arg.text.replace(/\s+/g, ' ').trim(), context: ctx });
      out += src.slice(last, m.index) + `@@CARD|${id}@@`;
      last = arg.end; todoRe.lastIndex = arg.end;
    }
    src = out + src.slice(last);
  }
  src = replaceMacro(src, /\\hl\s*\{/g, t => `@@HLS@@${t}@@HLE@@`);
  src = src.replace(/\\[gG]ls(pl)?\{(\w+)\}/g, (_, pl, key) => {
    const a = ACR[key];
    if (!a) return key.toUpperCase();
    return `@@ABBR|${a.short}${pl ? 's' : ''}|${a.long}@@`;
  });
  // optidef mini -> equation/aligned; addConstraint args can nest braces
  src = src.replace(/\\begin\{mini\}(?:\|[^|]*\|)?/g, '\\begin{equation}\\begin{aligned}')
           .replace(/\\end\{mini\}/g, '\\end{aligned}\\end{equation}');
  src = replaceMacro(src, /\\addConstraint\s*\{/g, a => `\\\\ \\text{s.t. }\\quad ${a}`);
  // math texmath rejects: \bf, \textnormal, \hfill, $..$ nested in \text{}
  src = src.replace(/\\bf\{/g, '\\mathbf{').replace(/\{\\bf\s+([^}]*)\}/g, '\\mathbf{$1}')
           .replace(/\\textnormal\{/g, '\\text{').replace(/\\hfill\b/g, ' ');
  src = replaceMacro(src, /\\text\s*\{/g, a => !a.includes('$') ? `\\text{${a}}`
    : a.split('$').map((p, i) => i % 2 ? ` ${p} ` : (p.trim() ? `\\text{${p}}` : '')).join(''));
  // number equations globally; move labels out of math bodies as anchors
  src = src.replace(/\\begin\{equation\}([\s\S]*?)\\end\{equation\}/g, (_, body) => {
    EQC++;
    let anchor = `@@EQN|${EQC}@@`;
    body = body.replace(/\\label\{([^}]+)\}/g, (_, l) => { eqNum[l] = EQC; anchor += `@@EQA|${l}@@`; return ''; });
    body = body.replace(/(\\\\)?\s*$/, '');
    return `${anchor}\\begin{equation}${body}\\end{equation}`;
  });
  src = src.replace(/\\(begin|end)\{(figure|table)\*\}/g, '\\$1{$2}');
  src = src.replace(/\\(modulolinenumbers|linenumbers|printglossary|makeglossaries)(\[[^\]]*\])?/g, '');
  src = src.replace(/\\(begin|end)\{abstract\}/g, ''); // pandoc shunts abstract env to metadata
  // strip comments, rescuing card tokens inside them
  src = src.split('\n').map(line => {
    const i = line.search(/(?<!\\)%/);
    if (i === -1) return line;
    const rescued = (line.slice(i).match(/@@CARD\|[\w-]+@@/g) || []).join(' ');
    return line.slice(0, i) + (rescued ? ' ' + rescued : '');
  }).join('\n');
  return src;
}

const bibArgs = (CFG.bib || []).flatMap(b => ['--bibliography', path.join(ROOT, b)]);
const RENDERERS = {
  latex: {
    preprocess: preprocessLatex,
    pandocArgs: ['-f', 'latex', '-t', 'html', '--mathml', '--citeproc', ...bibArgs, '--wrap=none'],
  },
  markdown: {
    preprocess: s => s,
    pandocArgs: ['-f', 'markdown', '-t', 'html', '--mathml', '--citeproc', ...bibArgs, '--wrap=none'],
  },
};
const renderer = RENDERERS[CFG.format];
if (!renderer) throw new Error(`no renderer for format "${CFG.format}"`);

// --- figures: resolve every <img> src against the repo and the configured
// figure dirs (\graphicspath semantics), probing extensions for extensionless
// \includegraphics refs. PDF-only and missing figures become placeholders
// instead of broken <img> tags.
const IMG_EXTS = ['', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.pdf'];
const figWarnings = new Set();
let figResolved = 0, figTotal = 0;
function resolveFigure(src) {
  const clean = src.replace(/^\.\//, '');
  const bases = [clean, ...FIG_DIRS.map(d => `${d}/${clean}`)];
  const exts = path.extname(clean) ? [''] : IMG_EXTS;
  for (const b of bases) for (const e of exts) {
    try { if (fs.statSync(path.join(ROOT, b + e)).isFile()) return b + e; } catch { }
  }
  return null;
}
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
function rewriteImages(html) {
  return html.replace(/<img\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/g, (tag, pre, src, post) => {
    if (/^(https?:|data:|\.\.\/)/.test(src)) return tag;
    // synthetic TikZ tokens: compiled SVGs live inside site/tikz/
    const tz = /^__tikz_([0-9a-f]+)__$/.exec(src);
    if (tz) return `<img class="tikz-fig"${pre}src="tikz/${tz[1]}.svg"${post}>`;
    if (src === '__tikzfail__') {
      return '<span class="fig-placeholder">TikZ figure could not be rendered — see build warnings (the PDF remains the figure of record)</span>';
    }
    figTotal++;
    const hit = resolveFigure(decodeURIComponent(src));
    if (!hit) {
      figWarnings.add(`figure not found on disk: ${src} (searched repo root${FIG_DIRS.length ? ' and ' + FIG_DIRS.join(', ') : ''})`);
      return `<span class="fig-placeholder">missing figure: ${src}</span>`;
    }
    figResolved++;
    if (hit.toLowerCase().endsWith('.pdf')) {
      return `<span class="fig-placeholder">figure ${path.basename(hit)} is a PDF — not renderable inline; <a href="../../${encPath(hit)}">open the file</a></span>`;
    }
    if (!FIG_DIRS.some(d => hit.startsWith(d + '/'))) {
      figWarnings.add(`figure ${hit} lies outside the configured figure dirs (${FIG_DIRS.join(', ') || 'none'}) — add its dir to figures_dirs in review.config.json so the server can serve it`);
    }
    return `<img${pre}src="../../${encPath(hit)}"${post}>`;
  });
}

function postprocess(html) {
  return rewriteImages(html)
    .replace(/@@CARD\|([\w-]+)@@/g, '<span class="card-anchor" id="$1"></span>')
    .replace(/@@HLS@@/g, '<mark>').replace(/@@HLE@@/g, '</mark>')
    .replace(/@@ABBR\|([^|]*)\|([^@]*)@@/g, '<abbr title="$2">$1</abbr>')
    .replace(/@@EQA\|([^@]+)@@/g, '<span class="eq-anchor" id="$1"></span>')
    .replace(/@@EQN\|(\d+)@@/g, '<span class="eqno">($1)</span>');
}

// paper title: an explicit config "title" wins (papers without \title{} —
// detect emits "title": "" for those); otherwise parsed from the main source
// each build so a retitle flows through.
// TITLE_SOURCE records WHERE the rendered title came from, so a title
// suggestion knows what to edit: the master's \title{…} macro (string span)
// or the config's "title" key (JSON-aware edit — never string-replaced).
let PAPER_TITLE = '';
let TITLE_SOURCE = null;
if (CFG.title) {
  PAPER_TITLE = String(CFG.title).trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  TITLE_SOURCE = { kind: 'config', file: 'review/review.config.json', key: 'title', raw: String(CFG.title) };
} else if (CFG.main) {
  try {
    const main = fs.readFileSync(path.join(ROOT, CFG.main), 'utf8');
    const m = /\\title\s*\{/.exec(main);
    const arg = m && braceArg(main, m.index + m[0].length - 1);
    if (arg) {
      PAPER_TITLE = cleanTitle(arg.text.replace(/(?<!\\)%[^\n]*/g, ''));
      // the full macro call is the unique span an apply can replace
      TITLE_SOURCE = { kind: 'latex', file: CFG.main, macro: main.slice(m.index, arg.end), arg: arg.text };
    }
  } catch { }
}
if (!PAPER_TITLE && CFG.title !== false) {
  // Never render a blank masthead: fall back to the first markdown H1,
  // else the humanized folder name. Set "title": false to opt out.
  if (CFG.format === 'markdown' && SECTIONS.length) {
    try {
      const first = fs.readFileSync(path.join(ROOT, SECTIONS[0].file), 'utf8');
      const h1 = /^#\s+(.+)$/m.exec(first);
      if (h1) PAPER_TITLE = h1[1].trim()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    } catch { }
  }
  if (!PAPER_TITLE) {
    PAPER_TITLE = path.basename(ROOT).replace(/\.(tex|md)$/, '')
      .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // derived masthead (no \title{}, no config title): renaming means setting the
  // config's "title" key, so that is what a title suggestion must target
  if (!TITLE_SOURCE) TITLE_SOURCE = { kind: 'config', file: 'review/review.config.json', key: 'title', raw: '' };
}

const NAV = SECTIONS.map(s => `<a href="${s.slug}.html" data-slug="${s.slug}">${s.title}</a>`).join('\n');
// data-cid makes the title selectable/commentable like body blocks; it lives
// outside #paper so positional blk-N ids (and existing comment anchors) don't shift
// shared cid: one title anchor across pages (display unification still needs review.js)
const MASTHEAD = PAPER_TITLE
  ? `<header class="masthead" data-cid="paper-title">${PAPER_TITLE}</header>`
  : '';
function page(title, slug, body, prev, next) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Review</title>
<link rel="stylesheet" href="assets/style.css">
<style>.masthead{font:700 1.5rem/1.35 var(--serif);color:var(--fg);border-bottom:1px solid var(--card-line);padding-bottom:.6rem;margin-bottom:1.6rem}</style>
</head><body data-slug="${slug}">
<nav class="toc"><h2>Sections</h2>${NAV}
<div class="toc-foot"><button id="export-btn">Export decisions</button><div id="progress"></div></div></nav>
<main>${MASTHEAD}<article id="paper">${body}</article>
<div class="pager">${prev ? `<a href="${prev.slug}.html">← ${prev.title}</a>` : '<span></span>'}${next ? `<a href="${next.slug}.html">${next.title} →</a>` : '<span></span>'}</div>
</main>
<aside id="margin"></aside>
<script src="suggestions.js"></script>
<script src="assets/span-match.js"></script>
<script src="assets/review.js"></script>
</body></html>`;
}

// --- build (two-pass: render all, then resolve cross-page refs) ---
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
// site/ is a disposable build product; canonical UI assets live in review/assets/
for (const f of fs.readdirSync(path.join(REVIEW, 'assets'))) {
  fs.copyFileSync(path.join(REVIEW, 'assets', f), path.join(OUT, 'assets', f));
}
const built = SECTIONS.map(s => {
  const raw = s.source ?? fs.readFileSync(path.join(ROOT, s.file), 'utf8');
  const tmp = path.join(OUT, `.${s.slug}.tmp`);
  fs.writeFileSync(tmp, renderer.preprocess(raw, s.slug));
  const html = execFileSync('pandoc', [...renderer.pandocArgs, tmp], { cwd: ROOT, encoding: 'utf8' });
  fs.unlinkSync(tmp);
  return { s, html: postprocess(html) };
});

const idMap = {}, figNum = {}, tabNum = {};
let nf = 0, nt = 0;
for (const b of built) {
  for (const m of b.html.matchAll(/id="([^"]+)"/g)) if (!(m[1] in idMap)) idMap[m[1]] = b.s.slug;
  for (const m of b.html.matchAll(/id="(fig:[^"]+)"/g)) if (!(m[1] in figNum)) figNum[m[1]] = ++nf;
  for (const m of b.html.matchAll(/id="(tab:[^"]+)"/g)) if (!(m[1] in tabNum)) tabNum[m[1]] = ++nt;
}
function resolveRefs(html, slug) {
  return html.replace(/<a href="#([^"]+)"[^>]*data-reference="[^"]*"[^>]*>\[?([^\]<]*)\]?<\/a>/g, (_, target) => {
    const pg = idMap[target];
    let text;
    if (figNum[target]) text = `Fig. ${figNum[target]}`;
    else if (tabNum[target]) text = `Table ${tabNum[target]}`;
    else if (eqNum[target]) text = `Eq. (${eqNum[target]})`;
    else if (target.startsWith('sec:') && pg) text = SECTIONS.find(x => x.slug === pg).title;
    else text = target.replace(/^\w+:/, '');
    if (!pg) return `<span class="xref-unresolved" title="unresolved label: ${target}">${text}</span>`;
    return `<a class="xref" href="${pg === slug ? '' : pg + '.html'}#${target}">${text}</a>`;
  });
}
built.forEach(({ s, html }, i) => {
  // pages whose source starts with a section heading keep it; others get the config title
  const h1 = /<h1/.test(html) ? '' : `<h1>${s.title}</h1>`;
  fs.writeFileSync(path.join(OUT, `${s.slug}.html`),
    page(s.title, s.slug, h1 + resolveRefs(html, s.slug), SECTIONS[i - 1], SECTIONS[i + 1]));
  console.log(`built ${s.slug}.html`);
});

// suggestions.json: extracted todos + previously authored (non-todo) cards
const suggFile = path.join(REVIEW, 'suggestions.json');
let cards = todos;
if (fs.existsSync(suggFile)) {
  const prior = JSON.parse(fs.readFileSync(suggFile, 'utf8'));
  cards = [...todos, ...prior.filter(c => c.type !== 'old-todo')];
}
fs.writeFileSync(suggFile, JSON.stringify(cards, null, 1));
let git = 'unknown';
try {
  const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const srcPaths = [...new Set([CFG.main, CFG.abbreviations, ...FIG_DIRS, ...(CFG.bib || []),
    ...CFG.sections.map(s => s.file)].filter(Boolean))];
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...srcPaths], { cwd: ROOT, encoding: 'utf8' }).trim() ? '-dirty' : '';
  git = rev + dirty;
} catch { }
// `sections` + `title_source` are additive: they let the browser resolve a
// human suggestion to a SOURCE span (which file a page came from, what the
// masthead title is written in) before the card is ever saved. Older clients
// ignore them; a client on a newer engine than its build simply can't offer
// suggest mode until the next rebuild.
const meta = { site_version: 3, slug: CFG.slug, built_at: new Date().toISOString(), source_commit: git,
  legacy_keys: CFG.legacy_storage_keys || [], suggestion_ids: cards.map(c => c.id),
  sections: SECTIONS.map(s => ({ slug: s.slug, file: s.file, title: s.title })),
  title_source: TITLE_SOURCE };
fs.writeFileSync(path.join(OUT, 'suggestions.js'),
  'window.SUGGESTIONS=' + JSON.stringify(cards) + ';\nwindow.BUILD_META=' + JSON.stringify(meta) + ';');
fs.writeFileSync(path.join(OUT, 'index.html'), `<meta http-equiv="refresh" content="0;url=${SECTIONS[0].slug}.html">`);
if (figTotal) console.log(`figures: ${figResolved}/${figTotal} resolved`);
if (TIKZ.count) console.log(`tikz: ${TIKZ.count - TIKZ.failed}/${TIKZ.count} compiled to SVG`);
for (const w of figWarnings) console.warn(`warning: ${w}`);
console.log(`done: ${todos.length} legacy annotation cards extracted`);
