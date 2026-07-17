// Review-engine end-to-end tests: detect + build + serve on fixture papers.
// Covers the single-file-paper shape (virtual section splitting, figure
// resolution across dirs, extensionless \includegraphics, PDF placeholders)
// and the pre-split multi-file shape with a legacy figures_dir config
// (regression: the Acta-shaped config must keep working verbatim).
//
// Run:  node --test tests/review-engine.test.mjs     (needs pandoc + git)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENGINE = path.join(HOME, 'frontends', 'review');
const DETECT = path.join(HOME, 'scripts', 'review-detect.mjs');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function freePort() {
  // ephemeral port from the OS; never the conventional deployment port 4177
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => port === 4177 ? resolve(freePort()) : resolve(port));
    });
  });
}

function scaffold(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `review-${name}-`));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function installEngine(dir) {
  const rd = path.join(dir, 'review');
  fs.mkdirSync(path.join(rd, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(ENGINE)) {
    if (f === 'assets' || f === 'site' || f === 'state') continue;
    fs.copyFileSync(path.join(ENGINE, f), path.join(rd, f));
  }
  for (const f of fs.readdirSync(path.join(ENGINE, 'assets'))) {
    fs.copyFileSync(path.join(ENGINE, 'assets', f), path.join(rd, 'assets', f));
  }
}

const runDetect = dir => execFileSync(process.execPath, [DETECT, dir], { encoding: 'utf8' });
const runBuild = dir => { // stdout + stderr: build warnings go to stderr
  const r = spawnSync(process.execPath, [path.join(dir, 'review', 'build.mjs')],
    { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout + r.stderr;
};
const readSite = (dir, f) => fs.readFileSync(path.join(dir, 'review', 'site', f), 'utf8');
const htmlPages = dir => fs.readdirSync(path.join(dir, 'review', 'site'))
  .filter(f => f.endsWith('.html') && f !== 'index.html').sort();

async function withServer(dir, fn, env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, 'review', 'server.mjs')],
    { cwd: dir, env: { ...process.env, PORT: String(port), ...env } });
  let out = '';
  proc.stdout.on('data', c => { out += c; });
  proc.stderr.on('data', c => { out += c; });
  try {
    const deadline = Date.now() + 15000;
    while (!/Review live at/.test(out)) {
      if (Date.now() > deadline) throw new Error(`server did not start:\n${out}`);
      await new Promise(r => setTimeout(r, 100));
    }
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    proc.kill();
  }
}

// ---------------------------------------------------------------- fixtures

const SINGLE = {
  'main.tex': `\\documentclass{article}
\\usepackage{graphicx}
\\graphicspath{{Figures/}}
\\newcommand{\\satsys}{SATSYS}
\\title{Single File Test Paper\\\\ \\large With a Broken-Line Subtitle}
\\begin{document}
\\maketitle
\\begin{abstract}
We study \\satsys{} collisions in a single-file paper.
\\end{abstract}

\\section{Introduction}\\label{sec:intro}
Opening text with an extensionless graphicspath figure.
\\begin{figure}
\\includegraphics{plot1}
\\caption{First plot.}\\label{fig:plot1}
\\end{figure}
An equation:
\\begin{equation}\\label{eq:one}
a = b + c
\\end{equation}

\\section{System Modeling}\\label{sec:model}
% \\section{Commented Out} -- a comment must not create a page boundary
Modeling text with a figure outside the graphics path.
\\begin{figure}
\\includegraphics{img/diagram}
\\caption{Diagram.}\\label{fig:diagram}
\\end{figure}

\\section{Results}\\label{sec:results}
\\begin{equation}\\label{eq:two}
x = y
\\end{equation}
A PDF-only figure:
\\begin{figure}
\\includegraphics{schematic}
\\caption{Schematic.}\\label{fig:schem}
\\end{figure}

\\section{Conclusion}\\label{sec:conc}
As shown in Section~\\ref{sec:intro}, Eq.~\\ref{eq:one} and Fig.~\\ref{fig:plot1} hold.
\\end{document}
`,
  'Figures/plot1.png': PNG,
  'img/diagram.png': PNG,
  'Figures/schematic.pdf': '%PDF-1.4\n%dummy\n',
};

const MULTI = {
  'master.tex': `\\documentclass{article}
\\usepackage{graphicx}
\\title{Multi File Test Paper}
\\begin{document}
\\input{tex/intro}
\\input{tex/methods}
\\input{tex/conclusion}
\\end{document}
`,
  'tex/intro.tex': `\\section{Introduction}\\label{sec:intro}
Intro text.
\\begin{figure}
\\includegraphics{Figures/a.png}
\\caption{A figure.}\\label{fig:a}
\\end{figure}
\\begin{equation}\\label{eq:base}
E = mc^2
\\end{equation}
`,
  'tex/methods.tex': `\\section{Methods}\\label{sec:methods}
\\begin{equation}\\label{eq:second}
F = ma
\\end{equation}
`,
  'tex/conclusion.tex': `\\section{Conclusion}\\label{sec:conc}
See Section~\\ref{sec:intro} and Eq.~\\ref{eq:base}.
`,
  'Figures/a.png': PNG,
};

// legacy Acta-shaped config: figures_dir as a string — must keep working verbatim
const MULTI_CFG = {
  slug: 'multi-test', format: 'latex', main: 'master.tex',
  sections: [
    { file: 'tex/intro.tex', title: '1. Introduction' },
    { file: 'tex/methods.tex', title: '2. Methods' },
    { file: 'tex/conclusion.tex', title: '3. Conclusion' },
  ],
  figures_dir: 'Figures', port: 4177,
};

// ------------------------------------------------------------------ tests

test('single-file paper: detect summarizes split + figure dirs', async t => {
  const dir = scaffold('single-detect', SINGLE);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = runDetect(dir);
  assert.match(out, /single-file paper: 4 \\section commands/);
  assert.match(out, /figure dirs:\s+Figures, img/);
  assert.match(out, /figures:\s+3 referenced, 3 resolved/);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'review', 'review.config.json'), 'utf8'));
  assert.deepEqual(cfg.figures_dirs, ['Figures', 'img']);
  assert.equal(cfg.sections.length, 1);
  assert.notEqual(cfg.port, 4177);
  // multi-line \title with \\ and \large slugs/echoes sanely
  assert.equal(cfg.sections[0].title, 'Single File Test Paper With a Broken-Line Subtitle');
  // paper has no bib, abbreviations, or todo macros: keys absent, summary says (none)
  assert.equal(cfg.bib, undefined);
  assert.equal(cfg.abbreviations, undefined);
  assert.equal(cfg.todo_macros, undefined);
  assert.match(out, /bib:\s+\(none\)/);
  assert.match(out, /abbreviations:\s+\(none\)/);
});

test('single-file paper: build splits, numbers globally, resolves figures; server serves all dirs', async t => {
  const dir = scaffold('single', SINGLE);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  runDetect(dir);
  installEngine(dir);
  const buildOut = runBuild(dir);
  assert.match(buildOut, /split main\.tex: 4 section pages \+ front matter/);
  assert.match(buildOut, /figures: 3\/3 resolved/);

  // N sections + 1 front-matter page, slugged and TOC'd like multi-file papers
  const pages = htmlPages(dir);
  assert.deepEqual(pages, ['00-abstract.html', '01-introduction.html',
    '02-system-modeling.html', '03-results.html', '04-conclusion.html']);
  const abstract = readSite(dir, '00-abstract.html');
  assert.equal((abstract.match(/data-slug="/g) || []).length - 1, 5, 'TOC lists all 5 pages');
  assert.match(abstract, /SATSYS/); // \newcommand from preamble expands on split pages
  // masthead: multi-line \title cleaned of \\ and \large
  assert.match(abstract, /Single File Test Paper With a Broken-Line Subtitle/);
  assert.doesNotMatch(abstract, /\\large/);

  // figures: graphicspath + extensionless refs rewritten to real files
  const intro = readSite(dir, '01-introduction.html');
  assert.match(intro, /src="\.\.\/\.\.\/Figures\/plot1\.png"/);
  const modeling = readSite(dir, '02-system-modeling.html');
  assert.match(modeling, /src="\.\.\/\.\.\/img\/diagram\.png"/);
  assert.doesNotMatch(modeling, /Commented Out/);

  // PDF-only figure -> placeholder, not a broken <img>
  const results = readSite(dir, '03-results.html');
  assert.match(results, /fig-placeholder/);
  assert.match(results, /schematic\.pdf/);
  assert.doesNotMatch(results, /<img[^>]*schematic/);

  // global equation numbering is monotonic across virtual pages
  assert.match(intro, /class="eqno"\>\(1\)/);
  assert.match(results, /class="eqno"\>\(2\)/);

  // cross-page refs from the last section link back to earlier pages
  const conc = readSite(dir, '04-conclusion.html');
  assert.match(conc, /href="01-introduction\.html#sec:intro"/);
  assert.match(conc, /href="01-introduction\.html#eq:one"[^>]*>Eq\. \(1\)/);
  assert.match(conc, /href="01-introduction\.html#fig:plot1"[^>]*>Fig\. 1/);

  await withServer(dir, async base => {
    for (const p of pages) {
      const r = await fetch(`${base}/${p}`);
      assert.equal(r.status, 200, `${p} serves`);
    }
    for (const [u, mime] of [['/Figures/plot1.png', 'image/png'],
                             ['/img/diagram.png', 'image/png'],
                             ['/Figures/schematic.pdf', 'application/pdf']]) {
      const r = await fetch(base + u);
      assert.equal(r.status, 200, `${u} serves`);
      assert.equal(r.headers.get('content-type'), mime);
    }
    // path traversal out of a figure dir stays blocked (raw request —
    // fetch would normalize the ".." away client-side)
    const { port } = new URL(base);
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/Figures/%2e%2e/main.tex' },
        r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  });
});

test('multi-file paper with legacy figures_dir config: unchanged behavior (regression)', async t => {
  const dir = scaffold('multi', MULTI);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installEngine(dir);
  fs.writeFileSync(path.join(dir, 'review', 'review.config.json'),
    JSON.stringify(MULTI_CFG, null, 1));
  runBuild(dir);

  const pages = htmlPages(dir);
  assert.deepEqual(pages, ['00-introduction.html', '01-methods.html', '02-conclusion.html'],
    'single-\\section files are never split');
  const intro = readSite(dir, '00-introduction.html');
  assert.equal((intro.match(/data-slug="/g) || []).length - 1, 3, 'TOC lists 3 pages');
  assert.match(intro, /src="\.\.\/\.\.\/Figures\/a\.png"/);
  assert.match(intro, /class="eqno"\>\(1\)/);
  assert.match(readSite(dir, '01-methods.html'), /class="eqno"\>\(2\)/);
  assert.match(readSite(dir, '02-conclusion.html'), /href="00-introduction\.html#sec:intro"/);
  assert.match(readSite(dir, '02-conclusion.html'), /href="00-introduction\.html#eq:base"[^>]*>Eq\. \(1\)/);

  await withServer(dir, async base => {
    assert.equal((await fetch(`${base}/00-introduction.html`)).status, 200);
    const fig = await fetch(`${base}/Figures/a.png`);
    assert.equal(fig.status, 200);
    assert.equal(fig.headers.get('content-type'), 'image/png');
  });
});

test('SSE transport hygiene: /events opens with a flushed 2KB comment pad + heartbeat (tunnel-proxy safe)', async t => {
  // regression for the --share field bug: cloudflared (and other edges)
  // buffer small first chunks and idle streams, so a bare "hello" never
  // reached the browser — the page sat at "loading…" through the tunnel
  const dir = scaffold('sse', MULTI);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installEngine(dir);
  fs.writeFileSync(path.join(dir, 'review', 'review.config.json'),
    JSON.stringify(MULTI_CFG, null, 1));
  await withServer(dir, async base => {
    const { port } = new URL(base);
    const { headers, body } = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/events' }, r => {
        let all = '';
        r.on('data', c => { all += c; });
        setTimeout(() => { req.destroy(); resolve({ headers: r.headers, body: all }); }, 600);
      });
      req.on('error', reject);
    });
    assert.equal(headers['content-type'], 'text/event-stream');
    assert.equal(headers['x-accel-buffering'], 'no');
    assert.match(headers.connection || '', /keep-alive/i);
    assert.equal(body[0], ':', 'stream opens with a comment pad');
    assert.ok(body.indexOf('\n\n') >= 2048, 'pad is >= 2KB');
    assert.match(body, /data: \{"type":"hello"\}/, 'hello arrives after the pad');
    assert.ok((body.match(/: ping\n\n/g) || []).length >= 2, 'comment heartbeats flow');

    // WS transport (primary through tunnels, where SSE is edge-buffered):
    // hello on connect, heartbeat pings as JSON events
    const { wsConnect } = await import('./fixtures/ws-client.mjs');
    const c = await wsConnect({ host: '127.0.0.1', port });
    try {
      await c.next(e => e.type === 'hello');
      await c.next(e => e.type === 'ping');
    } finally { c.close(); }
  }, { SSE_HEARTBEAT_MS: '120' });
});

test('span matching is whitespace-tolerant with true raw offsets', async () => {
  const { findSpans } = (await import(path.join(ENGINE, 'assets', 'span-match.js'))).default;

  // single-spaced needle vs newline-wrapped haystack (the live failure shape)
  const hay = 'The optimization problem is solved\nto generate   trajectories.';
  const spans = findSpans(hay, 'is solved to generate trajectories.');
  assert.equal(spans.length, 1);
  const { start, end } = spans[0];
  assert.equal(hay.slice(start, end), 'is solved\nto generate   trajectories.');
  assert.equal(start, hay.indexOf('is solved'));
  assert.equal(end, hay.length); // ends on the final matched char, exclusive

  // needle with newlines/multi-space vs single-spaced haystack (both normalize)
  assert.equal(findSpans('a b c', 'a\n  b\tc').length, 1);

  // smart quotes fold both ways (pandoc renders ' as ’, " as “”)
  const smart = 'the manipulator’s “end-effector”\nprior to collision';
  const sq = findSpans(smart, `manipulator's "end-effector" prior`);
  assert.equal(sq.length, 1);
  assert.equal(smart.slice(sq[0].start, sq[0].end), 'manipulator’s “end-effector”\nprior');
  assert.equal(findSpans("plain 'ascii' source", 'plain ‘ascii’ source').length, 1);

  // uniqueness counting is normalized: 'x y' twice, once wrapped
  assert.equal(findSpans('x y ... x\ny', 'x y').length, 2);

  // no match / empty needle
  assert.equal(findSpans(hay, 'not present').length, 0);
  assert.equal(findSpans(hay, '  \n ').length, 0);
});

test('apply engine: whitespace-tolerant unique-span replacement', async t => {
  const dir = scaffold('apply', {
    'main.tex': 'Preamble line.\nThe optimization problem is solved\nto generate  optimal trajectories here.\nTail. dup one\ndup  one end.\n',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installEngine(dir);
  fs.writeFileSync(path.join(dir, 'review', 'review.config.json'),
    JSON.stringify({ slug: 't', format: 'latex', main: 'main.tex', sections: [{ file: 'main.tex', title: 'T' }] }));
  fs.mkdirSync(path.join(dir, 'review', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'review', 'suggestions.json'), JSON.stringify([
    { id: 'c1', type: 'rewrite', section: '00-t', author: 'claude', source_file: 'main.tex',
      current_text: 'is solved to generate optimal trajectories here.', proposed_text: 'is solved to yield paths here.' },
    { id: 'c2', type: 'rewrite', section: '00-t', author: 'claude', source_file: 'main.tex',
      current_text: 'dup one', proposed_text: 'X' },
  ]));
  const { ApplyEngine } = await import(path.join(dir, 'review', 'apply.mjs'));
  const engine = new ApplyEngine({ reviewDir: path.join(dir, 'review'),
    cfg: JSON.parse(fs.readFileSync(path.join(dir, 'review', 'review.config.json'), 'utf8')) });

  // c1: card text is single-spaced, source wraps the line — must still apply
  // at true offsets; c2: ambiguity counting must also be normalized
  const r = engine.apply(['c1', 'c2']);
  assert.deepEqual(r.applied, ['c1']);
  assert.equal(r.flagged.length, 1);
  assert.match(r.flagged[0].reason, /ambiguous \(2 matches\)/);
  const after = fs.readFileSync(path.join(dir, 'main.tex'), 'utf8');
  assert.match(after, /The optimization problem is solved to yield paths here\.\nTail\./);
  assert.doesNotMatch(after, /optimal trajectories/);
});

test('masthead title: config "title" wins; detect notes a missing \\title{}', async t => {
  const dir = scaffold('title', {
    'main.tex': `\\documentclass{article}
\\begin{document}
Body before sections.
\\section{One}\\label{sec:one}
First.
\\section{Two}
Second, see~\\ref{sec:one}.
\\end{document}
`,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = runDetect(dir);
  assert.match(out, /no \\title\{\} in the master/);
  const cfgFile = path.join(dir, 'review', 'review.config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(cfg.title, '');
  cfg.title = 'A Hand-Named Paper';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1));
  installEngine(dir);
  runBuild(dir);
  const page = readSite(dir, '01-one.html');
  assert.match(page, /class="masthead"[^>]*>A Hand-Named Paper</);
  assert.match(page, /assets\/span-match\.js/); // matcher ships on every page
});

const hasTool = (cmd, flag = '--version') => {
  try { execFileSync(cmd, [flag], { stdio: 'ignore' }); return true; } catch { return false; }
};
const TIKZ_TOOLCHAIN = hasTool('pdflatex') && (hasTool('pdftocairo', '-v') || hasTool('dvisvgm'));

test('tikz figures compile to SVG; failures degrade to placeholders',
  { skip: TIKZ_TOOLCHAIN ? false : 'pdflatex + pdftocairo/dvisvgm not on PATH' }, async t => {
  const dir = scaffold('tikz', {
    'main.tex': `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{xcolor,fancyhdr,tikz}
\\usetikzlibrary{arrows.meta,positioning}
\\pagestyle{fancy}
\\lhead{Draft}
\\definecolor{myblue}{RGB}{25,73,102}
\\title{Tikz Paper}
\\begin{document}
\\section{Diagrams}\\label{sec:d}
A figure-wrapped picture using preamble colors and libraries:
\\begin{figure}[h]\\centering
\\begin{tikzpicture}
\\node[draw,fill=myblue!20] (a) {A};
\\node[draw,right=1cm of a] (b) {B};
\\draw[-{Latex}] (a) -- (b);
\\end{tikzpicture}
\\caption{Two nodes.}\\label{fig:nodes}
\\end{figure}
Bare picture: \\begin{tikzpicture}\\draw (0,0) circle (0.3);\\end{tikzpicture} done.
\\begin{figure}[h]\\centering
\\begin{tikzpicture}\\node {\\undefinedmacroxyz};\\end{tikzpicture}
\\caption{Deliberately broken.}\\label{fig:broken}
\\end{figure}

\\section{Refs}
See Fig.~\\ref{fig:nodes}.
\\end{document}
`,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  runDetect(dir);
  installEngine(dir);
  const out = runBuild(dir);
  assert.match(out, /tikz: 2\/3 compiled to SVG/);
  assert.match(out, /warning: tikzpicture failed to compile/);

  const svgs = fs.readdirSync(path.join(dir, 'review', 'site', 'tikz')).filter(f => f.endsWith('.svg'));
  assert.equal(svgs.length, 2);
  const page = readSite(dir, '00-diagrams.html');
  const imgs = [...page.matchAll(/<img class="tikz-fig"[^>]*src="(tikz\/[0-9a-f]+\.svg)"/g)];
  assert.equal(imgs.length, 2, 'both good pictures render as SVG imgs');
  assert.match(page, /id="fig:nodes"/); // label survives on the figure img
  assert.match(page, /Two nodes\./);    // caption kept by pandoc
  assert.match(page, /fig-placeholder">TikZ figure could not be rendered/);
  assert.match(page, /Deliberately broken\./); // broken figure's caption identifies it
  // cross-page ref to the tikz figure resolves with global numbering
  assert.match(readSite(dir, '01-refs.html'), /href="00-diagrams\.html#fig:nodes"[^>]*>Fig\. 1/);

  // rebuild reuses the cache (mtimes unchanged), and the server serves the SVGs
  const before = svgs.map(f => fs.statSync(path.join(dir, 'review', 'site', 'tikz', f)).mtimeMs);
  runBuild(dir);
  const after = svgs.map(f => fs.statSync(path.join(dir, 'review', 'site', 'tikz', f)).mtimeMs);
  assert.deepEqual(after, before, 'cached SVGs are not recompiled');
  await withServer(dir, async base => {
    for (const [, src] of imgs) {
      const r = await fetch(`${base}/${src}`);
      assert.equal(r.status, 200, `${src} serves`);
      assert.equal(r.headers.get('content-type'), 'image/svg+xml');
    }
  });
});

// happy-dom lives in tests/package.json (dev-only; the engine ships no deps) —
// tests that need it skip with a hint when it is not installed
let HAPPY = false;
try { await import('happy-dom'); HAPPY = true; } catch { }

test('mobile UX: touch-selection pill, composer sheet, comments drawer (happy-dom smoke)',
  { skip: HAPPY ? false : 'happy-dom not installed (cd tests && npm install)' }, async t => {
  const dir = scaffold('mobile', SINGLE);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  runDetect(dir);
  installEngine(dir);
  runBuild(dir);
  const html = readSite(dir, '00-abstract.html');

  const { GlobalWindow } = await import('happy-dom');
  const vm = await import('node:vm');
  // GlobalWindow is a vm-compatible global: review.js runs inside it exactly
  // as in a browser (a 390px-wide one, so the narrow-viewport paths engage)
  const w = new GlobalWindow({ url: 'file:///paper/00-abstract.html', width: 390, height: 844 });
  t.after(() => w.happyDOM.close());
  const doc = w.document;
  // strip external <script src> tags (file:// fetches don't resolve here);
  // review.js is evaluated manually below, after globals/stubs are in place
  doc.write(html.replace(/<script[^>]*src=[^>]*>\s*<\/script>/g, ''));
  const slug = doc.body.getAttribute('data-slug');
  assert.ok(slug, 'built page carries data-slug');
  // stubs review.js needs that happy-dom may not provide
  if (!w.CSS || !w.CSS.escape) {
    w.CSS = { escape: s => String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch) };
  }
  if (!w.matchMedia('(max-width: 1100px)').matches) {
    // happy-dom version can't evaluate the query against window width: stub it
    w.matchMedia = q => ({ matches: /max-width/.test(q), media: q, addEventListener() { }, removeEventListener() { } });
  }
  w.SUGGESTIONS = [{ id: 's1', type: 'rewrite', section: slug, author: 'claude', text: 'Tighten this.', rationale: 'clarity' }];
  w.BUILD_META = { slug: 'mobile-fixture' };
  // a user comment with a quote that exists in the abstract text, so a body
  // highlight (mark.user-hl) is wrapped and can be clicked to focus its thread
  w.localStorage.setItem('review-mobile-fixture', JSON.stringify({
    uc1: { status: 'user-comment', comment: 'is this the right term?', section: slug, anchor: `${slug}-blk-0`, quote: 'SATSYS collisions' },
  }));
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(dir, 'review', 'site', 'assets', 'review.js'), 'utf8'), w);

  // --- focus mode default: every card is a collapsed one-liner, no thread UI
  assert.equal(doc.querySelectorAll('#margin .thread').length, 0, 'default: no thread visible');
  assert.equal(doc.querySelectorAll('#margin .card.collapsed').length, 2, 'both cards collapsed');
  assert.match(doc.querySelector('.card.collapsed[data-id="s1"] .mini-thread').textContent,
    /view thread/, 'explicit "view thread ›" affordance on collapsed cards');

  // --- polish: segmented theme control, avatar pill, spotlight off by default
  const segDark = doc.querySelector('#theme-toggle .seg-btn[data-theme-opt="dark"]');
  assert.ok(segDark && segDark.querySelector('svg'), 'segmented icon theme control renders');
  segDark.click();
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark', 'segment click stamps data-theme');
  doc.querySelector('#theme-toggle .seg-btn[data-theme-opt="system"]').click();
  assert.equal(doc.documentElement.getAttribute('data-theme'), null, 'system segment clears data-theme');
  assert.equal(doc.querySelectorAll('#avatars .avatar-ring').length, 2, 'avatar pill cluster renders (offline too)');
  assert.equal(doc.body.classList.contains('spotlight'), false, 'no spotlight while nothing is focused');

  // --- comments overview: FAB counts open cards; drawer lists + closes on tap
  const fab = doc.getElementById('mob-fab');
  assert.ok(fab, 'overview FAB exists');
  assert.match(fab.textContent, /2 open/);
  fab.click();
  const drawer = doc.getElementById('mob-drawer');
  assert.equal(drawer.hasAttribute('hidden'), false, 'drawer opens from the FAB');
  assert.match(drawer.textContent, /claude/, 'entry shows the author');
  assert.match(drawer.textContent, /Tighten this\./, 'entry shows the first line');
  assert.match(drawer.querySelector('[data-mob-id="s1"] .mob-thread-link').textContent,
    /view thread/, 'drawer entries carry the thread affordance');
  assert.ok(drawer.querySelector('.chip[data-p="all"]'), 'author filter chips render in the drawer');
  const entry = drawer.querySelector('[data-mob-id="s1"]');
  assert.ok(entry, 'drawer lists the open card');
  entry.click();
  assert.equal(drawer.hasAttribute('hidden'), true, 'tapping an entry closes the drawer');

  // --- drawer tap lands FOCUSED (accordion) with the bottom sheet open on it
  assert.ok(doc.querySelector('.card.focused[data-id="s1"]'), 'drawer tap focuses the thread');
  assert.ok(doc.querySelector('.card.focused[data-id="s1"] .acts'), 'focused card shows the full UI');
  assert.equal(doc.querySelectorAll('.card.focused').length, 1, 'exactly one expanded card');
  assert.ok(doc.body.classList.contains('spotlight'), 'focusing applies the spotlight class');
  assert.ok(doc.getElementById('margin').classList.contains('sheet-open'), 'narrow: sheet opens on the thread');

  // --- sheet/drawer dismissal: ✕, backdrop, Esc — never trapped
  const backdrop = doc.getElementById('backdrop');
  assert.equal(backdrop.hasAttribute('hidden'), false, 'dimmed backdrop shows behind the sheet');
  doc.getElementById('sheet-close').click();
  assert.equal(doc.getElementById('margin').classList.contains('sheet-open'), false, 'sheet closes via ✕');
  assert.equal(backdrop.hasAttribute('hidden'), true, 'backdrop hides with it');
  fab.click();
  assert.equal(drawer.hasAttribute('hidden'), false);
  backdrop.click();
  assert.equal(drawer.hasAttribute('hidden'), true, 'backdrop tap closes the drawer');

  // --- focus accordion: highlight click expands; drawer swaps; Esc collapses
  const mk = doc.querySelector('mark.user-hl[data-card-id="uc1"]');
  assert.ok(mk, 'user-comment quote is highlighted in the body');
  mk.click();
  assert.ok(doc.querySelector('.card.focused[data-id="uc1"]'), 'clicking the highlight expands its thread');
  assert.ok(doc.querySelector('.card.focused[data-id="uc1"] .thread'), 'expanded card has the thread UI');
  assert.ok(doc.querySelector('.card.collapsed[data-id="s1"]'), 'the other card stays collapsed');
  assert.ok(doc.querySelector('mark.user-hl[data-card-id="uc1"].focused'), 'focused highlight gets the stronger tint');
  fab.click();
  drawer.querySelector('[data-mob-id="s1"]').click(); // swap focus via the drawer index
  assert.ok(doc.querySelector('.card.focused[data-id="s1"]'), 'second tap swaps focus');
  assert.ok(doc.querySelector('.card.collapsed[data-id="uc1"]'), 'previous thread collapses');
  assert.equal(doc.querySelectorAll('mark.user-hl.focused').length, 0, 'old highlight loses the focus tint');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); // 1st: closes the sheet
  assert.equal(doc.getElementById('margin').classList.contains('sheet-open'), false, 'Esc closes the sheet');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); // 2nd: collapses the focus
  assert.equal(doc.querySelectorAll('.card.focused').length, 0, 'Esc collapses back to the stack');
  assert.equal(doc.body.classList.contains('spotlight'), false, 'spotlight lifts when focus collapses');

  // --- touch selection: selectionchange (no mouseup) -> bottom pill -> composer
  const blk = doc.querySelector('#paper [data-cid]');
  assert.ok(blk, 'paper blocks are id-stamped');
  w.getSelection = () => ({ // stubbed Selection: happy-dom's is minimal
    isCollapsed: false, rangeCount: 1,
    toString: () => 'collisions in a single-file paper',
    getRangeAt: () => ({
      commonAncestorContainer: blk,
      getBoundingClientRect: () => ({ left: 10, top: 300, width: 80, bottom: 320 }),
    }),
  });
  doc.dispatchEvent(new w.Event('selectionchange'));
  await new Promise(r => setTimeout(r, 450)); // past the 300ms debounce
  const pill = doc.getElementById('sel-pill');
  assert.ok(pill, 'selection pill exists');
  assert.equal(pill.hasAttribute('hidden'), false, 'pill appears for a touch selection');
  assert.equal(doc.getElementById('sel-pop').hasAttribute('hidden'), true,
    'desktop floating popover stays hidden on narrow viewports');
  pill.click();
  const ta = doc.querySelector('#margin .card.composing textarea');
  assert.ok(ta, 'tapping the pill opens the composer');
  assert.ok(doc.getElementById('margin').classList.contains('sheet-open'),
    'margin opens as a bottom sheet so the composer is visible');
  // collapsing the selection hides the pill again
  w.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => '' });
  doc.dispatchEvent(new w.Event('selectionchange'));
  await new Promise(r => setTimeout(r, 450));
  assert.equal(pill.hasAttribute('hidden'), true, 'pill hides when the selection collapses');
});

test('multi-file paper: detect still finds \\input sections (regression)', async t => {
  const dir = scaffold('multi-detect', MULTI);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = runDetect(dir);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'review', 'review.config.json'), 'utf8'));
  assert.deepEqual(cfg.sections.map(s => s.file), ['tex/intro.tex', 'tex/methods.tex', 'tex/conclusion.tex']);
  assert.deepEqual(cfg.figures_dirs, ['Figures']);
  assert.doesNotMatch(out, /single-file paper/);
});
