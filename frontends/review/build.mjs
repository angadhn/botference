#!/usr/bin/env node
// Generic review-site builder: renders configured sections to commentable HTML.
// All document-specific values come from review.config.json. Read-only w.r.t. sources.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REVIEW = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(REVIEW, '..');
const OUT = path.join(REVIEW, 'site');
const CFG = JSON.parse(fs.readFileSync(path.join(REVIEW, 'review.config.json'), 'utf8'));

const slugify = (t, i) => String(i).padStart(2, '0') + '-' +
  t.replace(/^[\d.\s]+/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SECTIONS = CFG.sections.map((s, i) => ({ ...s, slug: slugify(s.title, i) }));

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

const todos = [];
let EQC = 0; const eqNum = {};

// --- LaTeX preprocessing: extract todo annotations, fix constructs pandoc rejects ---
function preprocessLatex(src, slug) {
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

function postprocess(html) {
  return html
    .replace(/@@CARD\|([\w-]+)@@/g, '<span class="card-anchor" id="$1"></span>')
    .replace(/@@HLS@@/g, '<mark>').replace(/@@HLE@@/g, '</mark>')
    .replace(/@@ABBR\|([^|]*)\|([^@]*)@@/g, '<abbr title="$2">$1</abbr>')
    .replace(/@@EQA\|([^@]+)@@/g, '<span class="eq-anchor" id="$1"></span>')
    .replace(/@@EQN\|(\d+)@@/g, '<span class="eqno">($1)</span>')
    .replace(new RegExp(`src="${CFG.figures_dir}/`, 'g'), `src="../../${CFG.figures_dir}/`);
}

// paper title, parsed from the main source each build so a retitle flows through
let PAPER_TITLE = '';
if (CFG.main) {
  try {
    const main = fs.readFileSync(path.join(ROOT, CFG.main), 'utf8');
    const m = /\\title\s*\{/.exec(main);
    const arg = m && braceArg(main, m.index + m[0].length - 1);
    if (arg) PAPER_TITLE = arg.text.replace(/(?<!\\)%[^\n]*/g, '').replace(/\\\\/g, ' ')
      .replace(/\s+/g, ' ').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  } catch { }
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
  const raw = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
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
  const srcPaths = [...new Set([CFG.main, CFG.abbreviations, CFG.figures_dir, ...(CFG.bib || []),
    ...CFG.sections.map(s => s.file)].filter(Boolean))];
  const dirty = execFileSync('git', ['status', '--porcelain', '--', ...srcPaths], { cwd: ROOT, encoding: 'utf8' }).trim() ? '-dirty' : '';
  git = rev + dirty;
} catch { }
const meta = { site_version: 3, slug: CFG.slug, built_at: new Date().toISOString(), source_commit: git,
  legacy_keys: CFG.legacy_storage_keys || [], suggestion_ids: cards.map(c => c.id) };
fs.writeFileSync(path.join(OUT, 'suggestions.js'),
  'window.SUGGESTIONS=' + JSON.stringify(cards) + ';\nwindow.BUILD_META=' + JSON.stringify(meta) + ';');
fs.writeFileSync(path.join(OUT, 'index.html'), `<meta http-equiv="refresh" content="0;url=${SECTIONS[0].slug}.html">`);
console.log(`done: ${todos.length} legacy annotation cards extracted`);
