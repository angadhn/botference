// notebook.mjs — Jupyter Book support for the review engine.
//
// The whole engine works on TEXT: the browser matches a selection against the
// source text (GET /source), apply.mjs replaces a unique span of it. A
// notebook's source is JSON, so every .ipynb gets a TEXT PROJECTION that
// stands in for it everywhere text is expected: markdown cells verbatim, code
// cells as ```{code-cell} fences (the MyST/jupytext shape), cells joined by a
// blank line. Each cell's source offsets within the projection are recorded,
// so a span edit on the projection maps back to exactly one cell's `source`
// and is written back surgically — the rest of the file (outputs, metadata,
// ids, formatting) is byte-identical after an edit.
//
// Also here: the _toc.yml walker (book order) and the MyST → pandoc-markdown
// preprocessing the build uses to render MyST directives approximately.
import fs from 'node:fs';
import path from 'node:path';

const cellText = src => Array.isArray(src) ? src.join('') : String(src ?? '');
const fenceFor = body => {
  const runs = body.match(/`{3,}/g) || [];
  return '`'.repeat(Math.max(3, ...runs.map(r => r.length + 1)));
};

// ---------------------------------------------------------------- projection

// nb: parsed notebook JSON. withOutputs (build only): stored image outputs are
// appended after their code fence as data-URI images. The /source + apply
// projection never carries them; the cell texts are identical either way, so
// a selection matched against the rendered page still matches /source.
export function projectNotebook(nb, { withOutputs = false } = {}) {
  const lang = nb?.metadata?.kernelspec?.language || nb?.metadata?.language_info?.name || 'python';
  let text = '';
  const cells = [];
  (nb?.cells || []).forEach((c, index) => {
    if (index > 0) text += '\n\n';
    const src = cellText(c.source);
    if (c.cell_type === 'code') {
      const fence = fenceFor(src);
      text += `${fence}{code-cell} ${lang}\n`;
      const start = text.length;
      text += src;
      cells.push({ index, type: 'code', start, end: text.length });
      text += `\n${fence}`;
      if (withOutputs) {
        for (const o of c.outputs || []) {
          const d = o.data || {};
          for (const mime of ['image/png', 'image/jpeg']) {
            if (d[mime]) { text += `\n\n![](data:${mime};base64,${cellText(d[mime]).replace(/\s+/g, '')})`; break; }
          }
        }
      }
    } else {
      const start = text.length;
      text += src;
      cells.push({ index, type: c.cell_type === 'raw' ? 'raw' : 'markdown', start, end: text.length });
    }
  });
  return { text, cells };
}

export function notebookText(file, opts) {
  return projectNotebook(JSON.parse(fs.readFileSync(file, 'utf8')), opts).text;
}

// ------------------------------------------------ surgical JSON value location
// Minimal JSON scanner: returns the raw [start, end) of the value at `keys`
// (e.g. ['cells', 3, 'source']) so an edit rewrites just that value and
// every other byte of the file stays as the tool that wrote it left it.
function locate(text, keys) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => { // at opening quote; returns decoded string
    const s = i; i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(s, i));
  };
  const skip = () => {
    ws();
    const ch = text[i];
    if (ch === '"') { str(); return; }
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      i++; ws();
      if (text[i] === close) { i++; return; }
      for (;;) {
        if (ch === '{') { ws(); str(); ws(); i++; /* : */ }
        skip(); ws();
        if (text[i] === ',') { i++; continue; }
        i++; return; // close
      }
    }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++; // number/literal
  };
  const find = depth => {
    ws();
    if (depth === keys.length) { const s = i; skip(); return { start: s, end: i }; }
    const want = keys[depth];
    const ch = text[i];
    if (ch === '{') {
      i++; ws();
      if (text[i] === '}') return null;
      for (;;) {
        ws(); const k = str(); ws(); i++; // :
        if (k === want) return find(depth + 1);
        skip(); ws();
        if (text[i] === ',') { i++; continue; }
        return null;
      }
    }
    if (ch === '[') {
      i++; ws();
      if (text[i] === ']') return null;
      for (let n = 0; ; n++) {
        if (n === want) return find(depth + 1);
        skip(); ws();
        if (text[i] === ',') { i++; continue; }
        return null;
      }
    }
    return null;
  };
  return find(0);
}

// JSON string literal the way nbformat writes it (ensure_ascii=False), or
// with \uXXXX escapes when the file was written ASCII-only
function jsonStr(s, ascii) {
  const j = JSON.stringify(s);
  return ascii ? j.replace(/[\u0080-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) : j;
}
const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1;
const indentAt = (text, at) => /^[ \t]*/.exec(text.slice(lineStart(text, at)))[0];

// Replace projection span [start, end) with `replacement`. The span must lie
// inside ONE cell's source text; a span crossing a cell boundary, or touching
// the generated ```{code-cell} fence lines, is refused (never guessed).
export function editNotebook(file, start, end, replacement) {
  const raw = fs.readFileSync(file, 'utf8');
  let nb;
  try { nb = JSON.parse(raw); } catch { return { ok: false, reason: `${path.basename(file)} is not valid notebook JSON` }; }
  const { cells } = projectNotebook(nb);
  const cell = cells.find(c => c.start <= start && end <= c.end);
  if (!cell) {
    const touched = cells.filter(c => start < c.end && end > c.start);
    return { ok: false, reason: touched.length > 1
      ? `span crosses a notebook cell boundary (cells ${touched.map(c => c.index + 1).join(', ')}) — split it into one suggestion per cell`
      : 'span covers generated notebook scaffolding (a code-cell fence or the gap between cells), not cell text' };
  }
  const orig = nb.cells[cell.index].source;
  const old = cellText(orig);
  const next = old.slice(0, start - cell.start) + (replacement ?? '') + old.slice(end - cell.start);
  const loc = locate(raw, ['cells', cell.index, 'source']);
  if (!loc) return { ok: false, reason: `could not locate cell ${cell.index + 1}'s source in the file` };
  const ascii = !/[^\x00-\x7f]/.test(raw);
  let value;
  if (typeof orig === 'string') {
    value = jsonStr(next, ascii);
  } else {
    // list of lines, "\n" kept on all but the last — nbformat's own shape
    const lines = next.split(/(?<=\n)/).filter(l => l !== '');
    const cur = raw.slice(loc.start, loc.end);
    const keyIndent = indentAt(raw, loc.start);
    const m = /^\[(\s*)/.exec(cur);
    const itemIndent = m && m[1].includes('\n') ? m[1].slice(m[1].lastIndexOf('\n') + 1) : keyIndent + ' ';
    const closeIndent = /\n([ \t]*)\]$/.exec(cur)?.[1] ?? keyIndent;
    value = lines.length
      ? '[\n' + lines.map(l => itemIndent + jsonStr(l, ascii)).join(',\n') + '\n' + closeIndent + ']'
      : '[]';
  }
  const after = raw.slice(0, loc.start) + value + raw.slice(loc.end);
  // belt and braces: the result parses and holds exactly the intended text
  try {
    const chk = JSON.parse(after);
    if (cellText(chk.cells[cell.index].source) !== next) throw new Error('mismatch');
  } catch { return { ok: false, reason: 'notebook edit did not round-trip — refusing to write' }; }
  return { ok: true, after, cell: cell.index };
}

// ------------------------------------------------------------------ _toc.yml

const prettify = f => path.basename(f).replace(/\.(ipynb|md|tex)$/, '')
  .replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const unquote = v => v.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2').trim();

// resolve a toc entry (extension optional) to an existing repo-relative path
function tocResolve(root, name) {
  for (const cand of [name, name + '.ipynb', name + '.md']) {
    try { if (fs.statSync(path.join(root, cand)).isFile()) return cand; } catch { }
  }
  return null;
}

// first "# " heading of a notebook (markdown cells) or markdown file
export function firstHeading(root, rel) {
  try {
    const abs = path.join(root, rel);
    const text = rel.endsWith('.ipynb')
      ? (JSON.parse(fs.readFileSync(abs, 'utf8')).cells || [])
        .filter(c => c.cell_type === 'markdown').map(c => cellText(c.source)).join('\n\n')
      : fs.readFileSync(abs, 'utf8');
    // outside code fences only
    let inFence = null;
    for (const line of text.split('\n')) {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) { if (!inFence) inFence = f[1]; else if (f[1][0] === inFence[0] && f[1].length >= inFence.length && !line.trim().slice(f[1].length)) inFence = null; continue; }
      if (inFence) continue;
      const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) return m[1].trim();
    }
  } catch { }
  return null;
}

// Book order from _toc.yml: `root:` first, then every `file:` entry in
// document order (url:/glob: entries ignored). A purpose-built line walker —
// no YAML dependency. Returns {sections:[{file,title}], missing:[names]}.
export function tocSections(root) {
  const toc = fs.readFileSync(path.join(root, '_toc.yml'), 'utf8');
  const names = [];
  for (const line of toc.split('\n')) {
    const m = /^\s*(?:-\s+)?(root|file)\s*:\s*(.+)$/.exec(line.replace(/\r$/, ''));
    if (m) { const v = unquote(m[2]); if (v) names.push(v); }
  }
  const sections = [], missing = [], seen = new Set();
  for (const n of names) {
    const file = tocResolve(root, n.replace(/^\.\//, ''));
    if (!file) { missing.push(n); continue; }
    if (seen.has(file)) continue;
    seen.add(file);
    sections.push({ file, title: firstHeading(root, file) || prettify(file) });
  }
  return { sections, missing };
}

// top-level scalar keys of _config.yml we care about (title, bibtex_bibfiles)
export function bookConfig(root) {
  const out = { title: null, bib: [] };
  let text = '';
  try { text = fs.readFileSync(path.join(root, '_config.yml'), 'utf8'); } catch { return out; }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const t = /^title\s*:\s*(.+)$/.exec(line);
    if (t && !out.title) out.title = unquote(t[1]) || null;
    const b = /^bibtex_bibfiles\s*:\s*(.*)$/.exec(line);
    if (b) {
      const inline = b[1].trim();
      if (inline.startsWith('[')) out.bib.push(...inline.replace(/[[\]]/g, '').split(',').map(unquote).filter(Boolean));
      else if (inline) out.bib.push(unquote(inline));
      else for (let j = i + 1; j < lines.length && /^\s+-\s+/.test(lines[j]); j++) out.bib.push(unquote(lines[j].replace(/^\s+-\s+/, '')));
    }
  });
  return out;
}

// image references in a section's text, repo-relative (for figures_dirs)
export function imageRefs(text, baseDir) {
  const refs = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) refs.push(m[1]);
  for (const m of text.matchAll(/^\s*(`{3,}|:{3,})\{(?:figure|image)\}\s+(\S+)/gm)) refs.push(m[2]);
  for (const m of text.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) refs.push(m[1]);
  return refs.filter(r => !/^(https?:|data:)/.test(r)).map(r => rebase(r, baseDir));
}

// section-relative image path -> repo-root-relative (what resolveFigure wants)
function rebase(p, baseDir) {
  if (/^(https?:|data:|\/)/.test(p)) return p.replace(/^\/+/, '');
  return path.posix.normalize(path.posix.join(baseDir || '.', p.replace(/^\.\//, '')));
}

// ------------------------------------------------------ MyST -> pandoc markdown

const ADMONITIONS = new Set(['note', 'tip', 'warning', 'important', 'caution', 'attention',
  'danger', 'error', 'hint', 'seealso', 'admonition']);
const UNWRAP = new Set(['margin', 'sidebar', 'div', 'container', 'card', 'dropdown', 'tab-item', 'tab-set']);
const CODE = new Set(['code-cell', 'code', 'code-block', 'sourcecode']);
const ROLE_RE = /\{(numref|ref|eq|cite|cite:p|cite:t|doc|term|download|abbr|prf:ref|sub|sup|math)\}`([^`]*)`/g;

// math macros pandoc's texmath rejects (the build.mjs preprocessLatex rewrite,
// extended for MyST courseware): old-style font switches become \mathbf/\mathrm
// — keeping the group braces, so `\ddot{\bf r}` stays a valid `\ddot{…}` —
// plus \LaTeX and \Bigl/\Bigr, which texmath does not know
const FONT = { bf: 'mathbf', rm: 'mathrm', it: 'mathit', sf: 'mathsf', tt: 'mathtt', cal: 'mathcal' };
const fixMath = s => s
  .replace(/\{\\(bf|rm|it|sf|tt|cal)(?![A-Za-z])\s*([^{}]*)\}/g, (_, f, x) => `{\\${FONT[f]}{${x.trim()}}}`)
  .replace(/\\(bf|rm|it|sf|tt|cal)\s*\{/g, (_, f) => `\\${FONT[f]}{`)
  .replace(/\\(bf|rm)(?![A-Za-z])\s*(\\[A-Za-z]+\s*(?:\{[^{}]*\}|[A-Za-z0-9])|[A-Za-z0-9])/g, (_, f, x) => `{\\${FONT[f]}{${x}}}`)
  .replace(/\\LaTeX\b/g, '\\text{LaTeX}').replace(/\\TeX\b/g, '\\text{TeX}')
  .replace(/\\Big([lr])(?![a-z])/g, '\\Big');

// Light preprocessing so pandoc's markdown reader produces sane HTML from
// MyST: directive scaffolding is rewritten, prose text passes through byte-
// identical (the browser matches selections against the unprocessed text).
// Rendering of directives is approximate by design.
export function mystToPandoc(text, { baseDir = '.' } = {}) {
  const labels = {};
  const lines = text.split('\n');
  const body = convert(lines, baseDir, labels);
  return body.join('\n')
    .replace(/(?<!!)\[\]\(([^)\s]+)\)/g, (m, l) => `[${labels[l] || l}](#${l})`);
}

function inline(line, baseDir) {
  return fixMath(line)
    .replace(ROLE_RE, (_, role, arg) => {
      if (role === 'math') return `$${arg}$`;
      const lbl = /^(.*?)\s*<([^>]+)>\s*$/.exec(arg);
      return lbl && lbl[1] ? lbl[1] : (lbl ? lbl[2] : arg);
    })
    .replace(/(\$\$)\s*\(([^)\s]+)\)\s*$/, '$1')
    .replace(/(!\[[^\]]*\]\()\s*([^)\s]+)/g, (m, pre, p) => /^(https?:|data:)/.test(p) ? m : pre + rebase(p, baseDir))
    .replace(/(<img\b[^>]*?\bsrc=")([^"]+)"/g, (m, pre, p) => /^(https?:|data:)/.test(p) ? m : `${pre}${rebase(p, baseDir)}"`);
}

function convert(lines, baseDir, labels) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^(\s*)(`{3,}|~{3,}|:{3,})(.*)$/.exec(line);
    if (!open || (open[2][0] === ':' && !/^\{/.test(open[3].trim()))) {
      const target = /^\s*\(([^()\s]+)\)=\s*$/.exec(line);
      if (target) {
        // attach the target to the next heading (so [](label) links work), else drop
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const h = j < lines.length && /^(#{1,6})\s+(.+?)\s*$/.exec(lines[j]);
        if (h && !/\{#[^}]*\}\s*$/.test(lines[j])) {
          labels[target[1]] = h[2];
          lines[j] = lines[j].replace(/\s*$/, '') + ` {#${target[1]}}`;
        }
        continue;
      }
      out.push(inline(line, baseDir));
      continue;
    }
    // every block a fence becomes is separated by blank lines: pandoc needs
    // them around fenced code/blockquotes/display math, and without them the
    // line after a {note} would lazily continue the blockquote
    if (out.length && out[out.length - 1].trim()) out.push('');
    const [, indent, fence, infoRaw] = open;
    const ch = fence[0], n = fence.length;
    // closing fence: same char, at least as long, nothing else on the line
    let j = i + 1;
    const closeRe = new RegExp(`^\\s*\\${ch}{${n},}\\s*$`);
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    const inner = lines.slice(i + 1, j);
    i = j; // skip past close (or to EOF)
    const info = infoRaw.trim();
    const dir = /^\{([\w:-]+)\}\s*(.*)$/.exec(info);
    if (!dir) { out.push(line, ...inner, `${indent}${fence}`, ''); continue; } // plain code fence: verbatim
    const [, name, arg] = dir;
    // directive options: a leading --- block, or leading :key: value lines
    const opts = {};
    let k = 0;
    if (inner[0] !== undefined && inner[0].trim() === '---') {
      k = 1;
      while (k < inner.length && inner[k].trim() !== '---') {
        const o = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(inner[k]); if (o) opts[o[1]] = o[2].trim(); k++;
      }
      k++;
    } else {
      while (k < inner.length && /^\s*:[\w-]+:/.test(inner[k])) {
        const o = /^\s*:([\w-]+):\s*(.*)$/.exec(inner[k]); opts[o[1]] = o[2].trim(); k++;
      }
    }
    const rest = inner.slice(k);
    const strip = l => l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^\s+/, '');
    if (CODE.has(name)) {
      out.push(`${indent}${fence}${arg ? ' ' + arg.split(/\s+/)[0] : ''}`, ...rest, `${indent}${fence}`);
    } else if (name === 'math') {
      const math = rest.filter(l => l.trim()).map(l => fixMath(l));
      const aligned = math.some(l => /&|\\\\/.test(l)) && !math.some(l => /\\begin\{/.test(l));
      out.push(`${indent}$$`, ...(aligned ? [`${indent}\\begin{aligned}`, ...math, `${indent}\\end{aligned}`] : math), `${indent}$$`);
    } else if (name === 'figure' || name === 'image') {
      const caption = convert(rest.map(strip), baseDir, labels).filter(l => l.trim()).join(' ').trim();
      const id = opts.name ? `{#${opts.name}}` : '';
      if (opts.name && caption) labels[opts.name] = caption;
      out.push(`${indent}![${caption}](${rebase(arg.trim(), baseDir)})${id}`);
    } else if (ADMONITIONS.has(name)) {
      const title = name === 'admonition' ? (arg || 'Note') : (arg || name[0].toUpperCase() + name.slice(1));
      const bodyLines = convert(rest.map(strip), baseDir, labels);
      out.push(`${indent}> **${inline(title, baseDir)}**`, `${indent}>`, ...bodyLines.map(l => `${indent}>${l ? ' ' + l : ''}`));
    } else {
      // margin/sidebar and anything unknown: unwrap, keep the content
      if (!UNWRAP.has(name) && arg) out.push(`${indent}**${inline(arg, baseDir)}**`, '');
      out.push(...convert(rest.map(strip), baseDir, labels).map(l => l ? indent + l : l));
    }
    if (out.length && out[out.length - 1].trim()) out.push('');
  }
  return out;
}

// the text a section renders from: notebook projection (with stored image
// outputs) or the markdown file itself
export function sectionSource(root, rel) {
  const abs = path.join(root, rel);
  return rel.endsWith('.ipynb') ? notebookText(abs, { withOutputs: true }) : fs.readFileSync(abs, 'utf8');
}
