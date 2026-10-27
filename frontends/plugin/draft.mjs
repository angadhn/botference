// Creating a first blog draft from a reading conversation. The bot returns
// Markdown; only this module chooses the file and writes it, without replacing
// an existing file. Later edits use the normal blog suggestion flow.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as blog from './blog.mjs';

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

export function frontMatterFor(d, title, source, now = new Date()) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(d.template || '');
  const fields = {
    title: JSON.stringify(title), created: now.toISOString().slice(0, 10),
    published: 'false', permalink: JSON.stringify(d.urlPath), source_url: JSON.stringify(source.url),
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
  return ['---', ...lines.filter((line, i) => line || i > 0), '---'].join('\n');
}

export function destination(command, config, sites = blog.listSites(), state = blog.rootState) {
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
  if (d.file && occupied(d)) {
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
    + 'The companion saves this block as a new unpublished post and starts its local preview. Do not claim the file was saved or the preview is live yourself.\n';
}

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
  const prose = body.slice(body.indexOf('\n') < 0 ? body.length : body.indexOf('\n') + 1).trimStart();
  const content = [frontMatterFor(d, title, source), '', prose, '',
    `<!-- botference-draft:${d.previewToken} -->`, ''].join('\n');
  fs.writeFileSync(d.file, content, { flag: 'wx' });
  blog.forgetIndex(d.root);
  return title;
}

// Own the child for the lifetime of the companion. Reuse an existing server,
// never stop someone else's. No shell, dependency installation, or deployment.
export function createPreviewer({ spawnProcess = spawn, fetchPage = fetch, timeoutMs = 60000, intervalMs = 500 } = {}) {
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
      child = { proc: spawnProcess(bundled ? 'bundle' : 'jekyll', bundled ? ['exec', 'jekyll', ...args] : args,
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
