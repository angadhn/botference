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
  const m = /^\/draft-blog\s+(?:@(claude|codex)\s+)?([a-z0-9][a-z0-9-]{0,79})\s*\|\s*([\s\S]+)$/i.exec(s);
  if (!m) throw new Error('Use /draft-blog [@claude|@codex] post-name | what you want written');
  return { agent: (m[1] || 'claude').toLowerCase(), slug: m[2].toLowerCase(), brief: m[3].trim() };
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
  const file = path.join(dir, `${command.slug}.md`);
  const urlPath = `/${command.slug}/`;
  if (fs.existsSync(file) || blog.resolvePath(root, urlPath, 'jekyll').doc) {
    throw new Error('That draft name or URL already exists. Choose another name.');
  }
  return { ...command, root, dir, file, rel: path.relative(root, file),
    serve_origin: origin.origin, url: origin.origin + urlPath, urlPath, previewToken: randomUUID() };
}

export function prompt(d) {
  return '[new blog draft requested by the reader]\n'
    + `Write the first draft for ${d.rel}, based on this article and our discussion. Brief: ${d.brief}\n`
    + 'Return the complete Markdown body in ONE fenced block labelled blog-draft, using FOUR backticks for its fences. '
    + 'Start with a # title. Do not include YAML front matter. This is the requested deliverable: write it in your reply, do not summon another agent or write files. '
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
  if (blog.resolvePath(d.root, d.urlPath, 'jekyll').doc) throw new Error('The draft URL is now used by another file.');
  const title = body.split('\n')[0].replace(/^#\s+/, '').trim();
  const content = ['---', `title: ${JSON.stringify(title)}`, 'published: false',
    `permalink: ${JSON.stringify(d.urlPath)}`, `source_url: ${JSON.stringify(source.url)}`,
    '---', '', body, '', `<!-- botference-draft:${d.previewToken} -->`, ''].join('\n');
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
