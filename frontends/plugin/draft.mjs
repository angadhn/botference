// Creating a first blog draft from a reading conversation. The bot returns
// Markdown; only this module chooses the file and writes it, without replacing
// an existing file. Later edits use the normal blog suggestion flow.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as blog from './blog.mjs';
import { isWebUrl } from './blyg.mjs';
// how a quote is written, and the two optional Blygger front-matter keys:
// the same module the Obsidian export uses, so the rules exist once
import { highlightParts, quoteStyleOf, labelOf, responseOf, readVersion, frontMatter as blygKeys } from './note-quotes.mjs';

export function parseCommand(text) {
  const s = String(text || '').trim();
  if (!/^\/draft-blog(?:\s|$)/i.test(s)) return null;
  let brief = s.replace(/^\/draft-blog\s*/i, '');
  const writer = /^@(claude|codex)(?:\s+|$)/i.exec(brief);
  if (writer) brief = brief.slice(writer[0].length).trim();
  // Keep the original explicit-filename form working, without requiring it.
  const legacy = /^([a-z0-9][a-z0-9-]{0,79})\s*\|\s*([\s\S]+)$/i.exec(brief);
  return { agent: (writer?.[1] || 'claude').toLowerCase(),
    slug: legacy ? legacy[1].toLowerCase() : '',
    brief: legacy ? legacy[2].trim() : brief || 'Write a blog post based on this article and our discussion.' };
}

function fileFields(d, slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(slug)) throw new Error('Invalid draft filename.');
  const file = path.join(d.dir, `${slug}.md`);
  const urlPath = `/${slug}/`;
  return { slug, file, rel: path.relative(d.root, file), urlPath, url: d.serve_origin + urlPath };
}

function occupied(d) {
  return fs.existsSync(d.file) || !!blog.resolvePath(d.root, d.urlPath, 'jekyll').doc;
}

// Read the site's actual Obsidian template, never another post's metadata.
// Keep non-owned YAML fields verbatim (including lists and quoted values).
function templateFor(root, configured) {
  const relative = configured || 'Templates/baseline.md';
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error('draft_template must be inside the site.');
  if (!fs.existsSync(file) && !configured) return '';
  if (!fs.realpathSync(file).startsWith(root + path.sep)) throw new Error('The draft template must be inside the site.');
  const text = fs.readFileSync(file, 'utf8');
  if (!/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) {
    throw new Error('The draft template must start with YAML front matter.');
  }
  return text;
}

export function frontMatterFor(d, title, source, now = new Date(), { preserveDates = false } = {}) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(d.template || '');
  const original = blog.frontMatter(d.template || '') || {};
  const today = now.toISOString().slice(0, 10);
  const date = key => preserveDates && typeof original[key] === 'string' && original[key]
    ? JSON.stringify(original[key]) : today;
  const tags = Array.isArray(original.tags) ? original.tags
    : typeof original.tags === 'string' ? [original.tags] : [];
  const fields = {
    title: JSON.stringify(title), created: date('created'), released: date('released'),
    ...(Object.hasOwn(original, 'date') ? { date: date('date') } : {}),
    tags: JSON.stringify([...new Set(['essays', ...tags])]),
    // a post a site will publish never carries a local path or an internal
    // address (a PDF on this disk is bfp-pdf://…): only a web address is kept
    published: 'false', permalink: JSON.stringify(d.urlPath), source_url: JSON.stringify(isWebUrl(source.url) ? source.url : ''),
  };
  const seen = new Set();
  const lines = [];
  let replacing = false;
  for (const line of (match?.[1] || '').split(/\r?\n/)) {
    const key = /^([A-Za-z_][\w -]*):/.exec(line)?.[1];
    if (key) {
      replacing = Object.hasOwn(fields, key);
      if (replacing) {
        if (!seen.has(key)) lines.push(`${key}: ${fields[key]}`);
        seen.add(key);
      } else lines.push(line);
    } else if (!replacing) lines.push(line);
  }
  for (const [key, value] of Object.entries(fields)) if (!seen.has(key)) lines.push(`${key}: ${value}`);
  return ['---', ...withBlygKeys(lines, d.quotes ? d.quotes.keys : []), '---'].join('\n');
}

// The two optional Blygger keys (note-quotes.frontMatter), when the draft is
// about a Blygger post: added at the end, or in place of the same key where
// the template already has one (its old value lines dropped). Every other
// template line is kept as the template wrote it, in its order.
function withBlygKeys(lines, keys) {
  const kept = lines.filter((line, i) => line || i > 0);
  if (!keys || !keys.length) return kept;
  const groups = [];
  for (const l of keys) if (/^\S/.test(l)) groups.push([l]); else groups[groups.length - 1].push(l);
  const out = [];
  const placed = new Set();
  let skipping = false;
  for (const line of kept) {
    const key = /^([A-Za-z_][\w -]*):/.exec(line)?.[1];
    if (key) {
      const g = groups.find(x => x[0].startsWith(key + ':'));
      skipping = !!g;
      if (g) { out.push(...g); placed.add(g); continue; }
    } else if (skipping) continue;
    out.push(line);
  }
  for (const g of groups) if (!placed.has(g)) out.push(...g);
  return out;
}

// ---- the reader's highlights, quoted exactly ---------------------------------
// A draft's prose is the bot's; the PASSAGES it quotes are the reader's
// highlights, and a passage a bot retypes drifts (a word smoothed, a clause
// dropped) — which on a Blygger post is a quote the site's build rejects, and
// anywhere is a misquotation. So the bot never writes a highlighted passage:
// it writes a placeholder line, <!-- quote:N -->, and the companion puts the
// highlight there in the format module's own words. And a blockquote the bot
// wrote anyway that is plainly one of the highlights (or a near copy of one)
// is replaced by that highlight, exactly as stored.
//
// quoteSet(page, cfg) → what the draft needs to know, prepared when the
// draft is asked for: the highlights in order, the quote style, the label,
// and the Blygger front-matter keys (only when the page is a Blygger post).
export function quoteSet(page, cfg = {}) {
  const items = (page && Array.isArray(page.threads) ? page.threads : [])
    .filter(t => t && String(t.quote || '').trim()).map((t, i) => ({ n: i + 1, t }));
  const item = page && page.blyg && page.blyg.status === 'blyg' && page.blyg.item ? page.blyg.item : null;
  const label = labelOf((page && (page.custom_title || page.title)) || '');
  const sources = item ? [item.page] : [];
  for (const { t } of items) if (t.blyg && t.blyg.status === 'blyg' && t.blyg.page) sources.push(t.blyg.page);
  const stubOf = item && responseOf(page) === 'response' ? { origin: item.origin, id: item.id, version: readVersion(page, item) } : null;
  return { items, style: quoteStyleOf(cfg.quote_style).style, url: isWebUrl(page && page.url) ? page.url : '', label,
    keys: item ? blygKeys({ sources, stubOf }) : [] };
}

// the lines the bot is shown, so it can choose which to quote and where
export function quotesPrompt(set) {
  if (!set || !set.items.length) return '';
  return 'The reader\'s highlights on the source, numbered:\n'
    + set.items.map(({ n, t }) => `${n}. “${String(t.quote).replace(/\s+/g, ' ').trim().slice(0, 400)}”`).join('\n')
    + '\nTo quote one of them, write a line containing only <!-- quote:N --> (N its number) where the quote belongs; '
    + 'the companion puts the exact passage there in the site\'s quoting syntax. Never retype a highlighted passage yourself.\n';
}

// A draft is built by Jekyll, which runs Liquid over the post first, and
// everything the companion inserts — the label (a page title) and the
// passage (words off a web page) — is somebody else's text. A quote that
// contains a Liquid delimiter ({{, }}, {%, %}) is therefore wrapped in
// {% raw %} … {% endraw %} lines, so Liquid passes it through as written
// (the markdown the site's Blygger build reads keeps the directive and its
// quote adjacent; the raw lines stand apart, after and before blank lines).
// Text that itself contains 'endraw' cannot be wrapped safely and is not
// inserted: a line says so instead.
const LIQUID = /\{[{%]|[}%]\}/;
export function liquidSafe(block) {
  const s = String(block);
  if (!LIQUID.test(s)) return s;
  if (/endraw/i.test(s)) return '*(a highlight here contains Liquid template text that cannot be written safely into this site, so it was left out)*';
  return `{% raw %}\n\n${s}\n\n{% endraw %}`;
}

const PLACEHOLDER = /^\s*<!--\s*quote:(\d{1,4})\s*-->\s*$/;
const DIRECTIVE = /^\s*!\[\[[0-9abcdefghjkmnpqrstvwxyz]{26}(?:\s*\|[^\n]*)?\]\]\s*$/;
// words of a passage, for telling "the same passage" from "another one":
// case, punctuation, markdown escapes and URLs set aside
const words = s => String(s || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ')
  .replace(/\\(.)/g, '$1').match(/[\p{L}\p{N}]+/gu) || [];
function likeness(a, b) {
  const x = words(a); const y = words(b);
  if (x.length < 4 || y.length < 4) return 0;
  const pool = new Map();
  for (const w of y) pool.set(w, (pool.get(w) || 0) + 1);
  let common = 0;
  for (const w of x) if (pool.get(w) > 0) { common++; pool.set(w, pool.get(w) - 1); }
  return common / Math.max(x.length, y.length);
}
const SAME_PASSAGE = 0.6;

/**
 * The draft body with the highlights put in: placeholders filled, and any
 * blockquote (with the directive line above it, if any) that is one of the
 * highlights or a near copy replaced by that highlight as the format module
 * writes it. → { body, placed, restored, unknown }: counts for the receipt.
 */
export function placeQuotes(body, set) {
  const lines = String(body || '').split('\n');
  if (!set || !set.items.length) {
    return { body: lines.filter(l => !PLACEHOLDER.test(l)).join('\n'), placed: 0, restored: 0,
      unknown: lines.filter(l => PLACEHOLDER.test(l)).length };
  }
  const render = t => liquidSafe(highlightParts(t, { style: set.style, url: set.url, label: set.label }).parts.join('\n\n'));
  const out = [];
  let placed = 0, restored = 0, unknown = 0;
  for (let i = 0; i < lines.length; i++) {
    const ph = PLACEHOLDER.exec(lines[i]);
    if (ph) {
      const hit = set.items.find(x => x.n === Number(ph[1]));
      if (hit) { out.push(render(hit.t)); placed++; } else unknown++;
      continue;
    }
    // a blockquote the bot wrote: a run of '>' lines, with a directive line
    // directly above it belonging to it
    const startsQuote = /^\s*>/.test(lines[i]);
    const directiveFirst = DIRECTIVE.test(lines[i]) && i + 1 < lines.length && /^\s*>/.test(lines[i + 1]);
    if (!startsQuote && !directiveFirst) { out.push(lines[i]); continue; }
    let j = directiveFirst ? i + 1 : i;
    while (j < lines.length && /^\s*>/.test(lines[j])) j++;
    const run = lines.slice(i, j);
    const text = run.filter(l => /^\s*>/.test(l)).map(l => l.replace(/^\s*>\s?/, '')).join(' ');
    let best = null; let score = 0;
    for (const x of set.items) {
      const s = likeness(text, x.t.quote);
      if (s > score) { best = x; score = s; }
    }
    if (best && score >= SAME_PASSAGE) {
      const fresh = render(best.t);
      if (fresh !== run.join('\n')) restored++;
      out.push(fresh);
    } else out.push(...run);
    i = j - 1;
  }
  return { body: out.join('\n'), placed, restored, unknown };
}


export function destination(command, config, sites = blog.listSites(), state = blog.rootState,
                            { allowExisting = false } = {}) {
  const roots = new Map(sites.filter(s => s.kind === 'jekyll' && state(s.root) === 'yes')
    .map(s => [blog.realish(s.root), s]));
  const site = config.draft_site ? roots.get(blog.realish(config.draft_site))
    : (roots.size === 1 ? [...roots.values()][0] : null);
  if (!site) throw new Error('Register a Jekyll site with botference site first. If you have several, set draft_site to its absolute root in the companion config.');
  const origin = new URL(site.serve_origin);
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname)) {
    throw new Error('Draft previews need a registered http://localhost or http://127.0.0.1 origin.');
  }
  const root = fs.realpathSync(site.root);
  const rel = String(config.draft_dir || '_notes');
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).some(p => !p || p === '..' || p.startsWith('.'))) {
    throw new Error('draft_dir must name a collection directory inside the site.');
  }
  const dir = fs.realpathSync(path.join(root, rel));
  if (!dir.startsWith(root + path.sep) || !fs.statSync(dir).isDirectory()) {
    throw new Error('The draft directory must be inside the registered site.');
  }
  const cfg = blog.readSiteConfig(root);
  const collection = rel.split('/')[0].replace(/^_/, '');
  if (!rel.startsWith('_') || cfg.collections[collection]?.output !== 'true') {
    throw new Error('draft_dir must be an existing Jekyll collection, such as _notes.');
  }
  const d = { ...command, root, dir, rel: rel + '/', file: '', url: '', urlPath: '',
    serve_origin: origin.origin, previewToken: randomUUID(),
    template: templateFor(root, config.draft_template) };
  if (command.slug) Object.assign(d, fileFields(d, command.slug));
  if (!allowExisting && d.file && occupied(d)) {
    throw new Error('That draft name or URL already exists. Choose another name.');
  }
  return d;
}

export function prompt(d) {
  return '[new blog draft requested by the reader]\n'
    + `Write the first draft in ${d.rel}, based on this article and our discussion. Brief: ${d.brief}\n`
    + 'Return the complete Markdown body in ONE fenced block labelled blog-draft, using FOUR backticks for its fences. '
    + 'Choose a fitting # title; the companion moves it into front matter and derives an available filename from it. Do not include YAML front matter: the companion fills the site’s baseline template. This is the requested deliverable: write it in your reply, do not summon another agent or write files. '
    + 'The normal short-reply limit does not apply to the draft. Cite the source where useful, distinguish your interpretation from its claims, and do not invent evidence. '
    + 'The companion saves this block as a new unpublished post and starts its local preview. Do not claim the file was saved or the preview is live yourself.\n'
    + quotesPrompt(d.quotes)
    + DRAFT_STYLE;
}

// The house style at its strictest, because a first draft is where it is
// cheapest to get right and where a bot's habits (long sentences, stacked
// nouns, restating the source) do the most harm. The same rule, in short
// form, lives in bridge-system-prompt.md for replies and suggestions.
export const DRAFT_STYLE =
  'Writing style for the draft, and this outranks your habits: about 80 percent of the way to ASD-STE100, the Simplified Technical English used for aircraft manuals. '
  + 'One topic per paragraph; paragraphs of three to five sentences. Sentences of about 20 words, one idea each, with a verb; split any sentence that needs a semicolon. '
  + 'Active voice. Concrete verbs. The same word for the same thing every time; no elegant variation. Plain words over technical ones, and define a term in the sentence that first uses it. '
  + 'No stacked nouns, no filler openers, no throat-clearing, no summary paragraph that restates the piece. Lead each section with its point. '
  + 'Keep what the full spec forbids only where it earns its place: a qualified claim, a contrast, a subordinate clause that carries meaning, a passive where the actor is unknown. '
  + 'This is an essay, so keep the hedges and the counterargument; never make the piece sound more certain than the discussion was. '
  + 'Write in the reader\'s first person and voice as shown in the discussion, not in a manual\'s. Headings are short noun phrases. Lists only for parallel items, never for argument.\n';

export function bodyOf(text) {
  const hits = [...String(text || '').matchAll(/^(`{4,})blog-draft\s*\n([\s\S]*?)^\1\s*$/gm)];
  if (hits.length !== 1) throw new Error('The bot did not return one complete blog-draft block. Retry /draft-blog; no file was written.');
  const body = hits[0][2].trim();
  if (!/^#\s+\S/.test(body) || body.length > 200000) throw new Error('The draft needs a # title and must be under 200,000 characters.');
  return body;
}

export function saveDraft(d, body, source) {
  // Recheck the parent at write time: a directory replaced by a symlink while
  // the bot was working must not redirect the write outside the site.
  if (fs.realpathSync(d.dir) !== d.dir || fs.realpathSync(d.root) !== d.root) {
    throw new Error('The site directory changed while the draft was being written.');
  }
  blog.forgetIndex(d.root);
  const title = body.split('\n')[0].replace(/^#\s+/, '').trim();
  if (!d.slug) {
    const base = blog.slugify(title).slice(0, 80).replace(/-+$/, '') || 'draft';
    let candidate;
    for (let n = 1; n <= 100; n++) {
      candidate = { ...d, ...fileFields(d, base + (n > 1 ? `-${n}` : '')) };
      if (!occupied(candidate)) break;
    }
    if (occupied(candidate)) throw new Error('Could not find an unused draft filename.');
    Object.assign(d, candidate);
  }
  if (occupied(d)) throw new Error('The draft filename or URL is now used by another file.');
  const rawProse = body.slice(body.indexOf('\n') < 0 ? body.length : body.indexOf('\n') + 1).trimStart();
  // the reader's highlights, exactly as stored (placeQuotes); the counts go
  // back to the caller for the receipt
  const q = placeQuotes(rawProse, d.quotes || null);
  d.quoteCounts = { placed: q.placed, restored: q.restored, unknown: q.unknown };
  const prose = q.body;
  const content = [frontMatterFor(d, title, source), '', prose, '',
    `<!-- botference-draft:${d.previewToken} -->`, ''].join('\n');
  fs.writeFileSync(d.file, content, { flag: 'wx' });
  blog.forgetIndex(d.root);
  return title;
}

// Own the child for the lifetime of the companion. Reuse an existing server,
// never stop someone else's. No shell, dependency installation, or deployment.
export function createPreviewer({ spawnProcess = spawn, fetchPage = fetch, timeoutMs = 60000, intervalMs = 500,
                                  command = null } = {}) {
  if (command !== null && (!Array.isArray(command) || !command.length
      || command.some(part => typeof part !== 'string' || !part))) {
    throw new Error('jekyll_command must be a nonempty array of command arguments.');
  }
  const children = new Map();
  const booting = new Map();
  const reachable = async (url, token = '') => {
    try {
      const res = await fetchPage(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      const body = await res.text();
      return res.ok && (!token || body.includes(`botference-draft:${token}`));
    }
    catch { return false; }
  };
  async function boot(d) {
    const u = new URL(d.serve_origin);
    let child = children.get(d.root);
    if (!child && !await reachable(d.serve_origin)) {
      const port = u.port || '80';
      const args = ['serve', '--host', '127.0.0.1', '--port', port, '--unpublished'];
      const bundled = fs.existsSync(path.join(d.root, 'Gemfile'));
      const invocation = command || (bundled ? ['bundle', 'exec', 'jekyll'] : ['jekyll']);
      child = { proc: spawnProcess(invocation[0], [...invocation.slice(1), ...args],
        { cwd: d.root, stdio: ['ignore', 'pipe', 'pipe'] }), error: '', tail: '' };
      children.set(d.root, child);
      const capture = chunk => { child.tail = (child.tail + chunk).slice(-2000); };
      child.proc.stdout?.on('data', capture);
      child.proc.stderr?.on('data', capture);
      child.proc.on('error', e => { child.error = e.message; children.delete(d.root); });
      child.proc.on('exit', code => { child.error ||= `Jekyll exited (${code}). ${child.tail}`; children.delete(d.root); });
    }
    return child;
  }
  async function start(d) {
    if (!booting.has(d.root)) booting.set(d.root, boot(d).finally(() => booting.delete(d.root)));
    const child = await booting.get(d.root);
    const until = Date.now() + timeoutMs;
    do {
      if (child?.error) throw new Error(child.error);
      if (await reachable(d.url, d.previewToken)) return d.url;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    } while (Date.now() < until);
    throw new Error(`The draft is saved, but its preview is not ready. An existing Jekyll server must use --unpublished. Preview: ${d.url}${child?.tail ? `\n${child.tail}` : ''}`);
  }
  return { start, stop() { for (const c of children.values()) c.proc.kill(); children.clear(); } };
}
