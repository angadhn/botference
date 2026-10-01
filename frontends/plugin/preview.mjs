// preview.mjs — a suggestion card on a book page, RENDERED, before anyone accepts it.
//
// The drawer's word diff says what a card changes in the notebook's text. On a
// Jupyter Book page that is the wrong thing to show a reader: the source is
// MyST inside JSON, and the change they care about is the page — a rebuilt
// equation, a figure with a new caption, a check card with a reworded prompt.
// So the book renders it. A book that wants this ships a script (the
// convention: `<root>/scripts/preview-chapter.sh <chapter> <scratch.ipynb>`,
// run in the book root) that builds ONE chapter from a scratch notebook in a
// cache of its own, never touching the repo's files or its _build, and prints
// the absolute path of the page it made.
//
// What this module does, and all it does:
//   1. applies the card to a COPY of the notebook (editNotebook's projection
//      offsets, exactly as suggest.applyCard would — the same refusals);
//   2. asks the script for two pages: the chapter as the file stands (the
//      base) and the chapter with the card applied;
//   3. hands both <article class="bd-article"> bodies back, plus the pictures
//      that exist only in the card's build, as data: urls.
// The browser diffs base against card block by block and places the
// difference on the live page (content.js, renderedPreview). Diffing the two
// PREVIEWS rather than preview-against-live is deliberate: both came out of
// the same build of the same file, so the only blocks that differ are the
// card's — a live _build that is a rebuild behind the working tree, or a page
// whose maths MathJax has already typeset, cannot pass for a change.
//
// Display only. The scratch notebook lives in the site's own scratch dir
// (<root>/.botference/plugin/preview/); the source file is read, never
// written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { projectNotebook, editNotebook } from '../review/notebook.mjs';
import { resolveSpan } from './suggest.mjs';

export const SCRIPT_REL = path.join('scripts', 'preview-chapter.sh');
// the first build of a book can take minutes; every one after it, seconds
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const PIC_MAX = 8 * 1024 * 1024;
const PICS_MAX = 40 * 1024 * 1024;
const CACHE_MAX = 64;

/** The book's renderer for this page, or '' when there is none to ask. */
export function previewScript(bg) {
  if (!bg || bg.kind !== 'jupyterbook' || !bg.root || !bg.source_path) return '';
  if (!/\.ipynb$/i.test(bg.source_path)) return '';
  const s = path.join(bg.root, SCRIPT_REL);
  try { return fs.statSync(s).isFile() ? s : ''; } catch { return ''; }
}

/**
 * The page's own <article class="bd-article">…</article>, cut out of a built
 * page. Nested <article>s are counted, so the right closing tag is the one
 * taken. '' when the page has none.
 */
export function articleOf(html) {
  const src = String(html || '');
  const open = /<article\b[^>]*\bclass\s*=\s*["'][^"']*\bbd-article\b[^"']*["'][^>]*>/i.exec(src);
  if (!open) return '';
  const re = /<(\/?)article\b[^>]*>/gi;
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m; (m = re.exec(src));) {
    depth += m[1] ? -1 : 1;
    if (!depth) return src.slice(open.index, m.index + m[0].length);
  }
  return '';
}

/** Every relative picture address an article names (img/source src). */
export function pictureRefs(html) {
  const out = new Set();
  const re = /<(?:img|source)\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;
  for (let m; (m = re.exec(String(html || '')));) {
    const s = m[2];
    if (s && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(s)) out.add(s);
  }
  return [...out];
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif' };

// The pictures the card's page names that the base page does not — a new
// figure, built only into the preview cache, which the live site has never
// served. Read from the preview's own html root and nowhere else.
function newPictures(pageFile, cardArticle, baseArticle) {
  const have = new Set(pictureRefs(baseArticle));
  const dir = path.dirname(pageFile);
  const htmlRoot = (() => {
    const i = pageFile.split(path.sep).lastIndexOf('html');
    return i > 0 ? pageFile.split(path.sep).slice(0, i + 1).join(path.sep) : dir;
  })();
  const out = {};
  let total = 0;
  for (const ref of pictureRefs(cardArticle)) {
    if (have.has(ref)) continue;
    let rel = ref.split(/[?#]/)[0];
    try { rel = decodeURIComponent(rel); } catch { /* as written */ }
    const file = path.resolve(dir, rel);
    if (path.relative(htmlRoot, file).startsWith('..')) continue;
    const mime = MIME[path.extname(file).slice(1).toLowerCase()];
    if (!mime) continue;
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    if (buf.length > PIC_MAX || total + buf.length > PICS_MAX) continue;
    total += buf.length;
    out[ref] = `data:${mime};base64,${buf.toString('base64')}`;
  }
  return out;
}

// ---- running the book's script, one at a time per book -------------------
const chains = new Map();          // root -> the tail of its queue
function queued(root, job) {
  const tail = (chains.get(root) || Promise.resolve()).then(job, job);
  chains.set(root, tail.catch(() => {}));
  return tail;
}

function runScript(bg, script, scratchFile) {
  const rel = path.relative(bg.root, bg.source_path).split(path.sep).join('/');
  const args = [script, rel].concat(scratchFile ? [scratchFile] : []);
  return queued(bg.root, () => new Promise((resolve, reject) => {
    execFile('sh', args, { cwd: bg.root, timeout: BUILD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const why = String(stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
          return reject(new Error(why || err.message || 'the book could not build the preview'));
        }
        const out = String(stdout || '').trim().split('\n').pop().trim();
        if (!out || !path.isAbsolute(out)) return reject(new Error('the preview script printed no page'));
        resolve(out);
      });
  }));
}

async function builtArticle(bg, script, scratchFile) {
  const page = await runScript(bg, script, scratchFile);
  const html = fs.readFileSync(page, 'utf8');
  const art = articleOf(html);
  if (!art) throw new Error('the preview page has no article.bd-article');
  return { page, article: art };
}

// ---- the cache -------------------------------------------------------------
// Keyed by what the answer depends on: the notebook's bytes (so an accepted
// card, or the author's own edit, makes every older preview stale) and the
// card. Promises, so two tabs asking at once share one build.
const cache = new Map();
function remember(key, make) {
  if (cache.has(key)) return cache.get(key);
  const p = make();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return p;
}

function scratchDir(bg) {
  return path.join(bg.root, '.botference', 'plugin', 'preview');
}

/**
 * Start (or join) the rendered preview of one open card.
 *
 * Resolves `{ok:true, base, html, pictures}` — the base and card articles and
 * the card-only pictures — or `{ok:false, why}`, never throws. The card is
 * placed exactly as an accept would place it: a passage that has drifted,
 * stands twice, or crosses a cell is refused here for the same reason it
 * would be refused there, and nothing is built.
 */
export function renderCard(bg, card) {
  const script = previewScript(bg);
  if (!script) return Promise.resolve({ ok: false, why: 'this book has no preview script' });
  if (!card || card.state !== 'open' || !card.current) {
    return Promise.resolve({ ok: false, why: 'only an open card is previewed' });
  }
  let raw;
  try { raw = fs.readFileSync(bg.source_path, 'utf8'); }
  catch { return Promise.resolve({ ok: false, why: 'the notebook could not be read' }); }
  const sha = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  const base = remember(`${bg.source_path}|${sha}|base`, () => builtArticle(bg, script, ''));
  const key = `${bg.source_path}|${sha}|${card.id}|${crypto.createHash('sha1')
    .update(String(card.current) + '\u0000' + String(card.proposed ?? '')).digest('hex').slice(0, 12)}`;
  return remember(key, async () => {
    let text;
    try { text = projectNotebook(JSON.parse(raw)).text; }
    catch { return { ok: false, why: 'the notebook is not valid JSON' }; }
    const at = resolveSpan(text, card.current);
    if (!at.ok) return { ok: false, why: at.detail };
    const nb = editNotebook(bg.source_path, at.start, at.end, String(card.proposed ?? ''));
    if (!nb.ok) return { ok: false, why: nb.reason };
    const dir = scratchDir(bg);
    fs.mkdirSync(dir, { recursive: true });
    const scratchFile = path.join(dir, `${String(card.id).replace(/[^\w-]/g, '_')}.ipynb`);
    fs.writeFileSync(scratchFile, nb.after);
    try {
      const b = await base;
      const c = await builtArticle(bg, script, scratchFile);
      return { ok: true, base: b.article, html: c.article,
        pictures: newPictures(c.page, c.article, b.article) };
    } finally {
      try { fs.unlinkSync(scratchFile); } catch { /* already gone */ }
    }
  }).catch(e => ({ ok: false, why: String((e && e.message) || e) }));
}

/**
 * The same, answered within `waitMs`: the result if it is ready by then,
 * otherwise `{pending:true}` while the build carries on — so a first build of
 * the whole book never holds an HTTP request open for minutes. Ask again.
 */
export function renderCardWithin(bg, card, waitMs) {
  const p = renderCard(bg, card);
  return Promise.race([p, new Promise(r => setTimeout(() => r({ pending: true }), waitMs))]);
}
