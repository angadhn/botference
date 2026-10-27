// Explicit owner opt-in: one registered site becomes the writing workspace
// for ordinary reading conversations as well as its own local previews.
import fs from 'node:fs';
import path from 'node:path';
import * as blog from './blog.mjs';
import * as drafts from './draft.mjs';

export function siteForRoot(root, sites = blog.listSites(), state = blog.rootState) {
  if (!root || !path.isAbsolute(root)) return null;
  const real = blog.realish(root);
  const site = sites.find(s => blog.realish(s.root) === real && s.kind === 'jekyll');
  if (!site || state(real) !== 'yes') return null;
  try {
    const u = new URL(site.serve_origin);
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname)) return null;
    if (!fs.statSync(real).isDirectory()) return null;
  } catch { return null; }
  return { ...site, root: real };
}

export function context(site, page, source = null) {
  const assets = blog.assetDirs(site.root).map(p => path.relative(site.root, p));
  const today = new Date().toISOString().slice(0, 10);
  return `[blog authoring workspace: ${site.root}]\n`
    + `The owner has explicitly authorized direct editing throughout this site repository, from this conversation. `
    + `You and your summoned builders can write posts, images, CSS, layouts and other site source files under ${site.root}. `
    + `The CLI has this repository in its writable scope. Work directly there; do not create a second site-draft tree in Botference.\n`
    + (source?.source_path ? `This preview's source is ${source.source_path}. Read it before editing.\n`
      : `The page being discussed (${page.url}) is reference material; it is not the file you are editing.\n`)
    + `Before creating a post, search the site's _notes/ and this conversation's previous outputs for the existing draft. `
    + `Continue that file and reuse staged work rather than drafting a duplicate. Preserve unrelated posts. `
    + `Use the site's Templates/baseline.md for new front matter. Fill created and released with ${today} for a new post, `
    + `include essays alongside relevant topic tags, set a stable permalink, and keep published: false during local review. `
    + `Fill missing dates on existing essay drafts too; preserve original creation/release dates when they are already set.\n`
    + `Place finished assets in the site's existing folders (${assets.join(', ') || 'assets'}), following nearby posts' link conventions. `
    + `Scratch work belongs under ${blog.scratchDir(site.root)}. Requested CSS/layout fixes are permitted. `
    + `Edit source files, never _site/ build output. The companion starts or reuses the local preview after changes.\n`
    + `For a comment or a batch review, implement its requested source change directly and reply in that comment with what changed. `
    + `Do not return suggestion blocks unless the owner asks to see a proposal first. For a complex deliverable, delegate with this repository and exact destination in the brief.\n`
    + `No git, gh, commit, push or public deployment. Network access is a separate permission: a writable site does not grant blocked image hosts. `
    + `Do not substitute generated/reconstructed data for an unavailable original chart.\n`;
}

export function scan(site) {
  return blog.scanSite(site.root, site.kind, { includeSiteSource: true });
}

export function builderPlacement(site) {
  return `--- Direct site authoring ---\nThe owner authorized direct source edits in ${site.root}. `
    + `Write and revise the actual Markdown under _notes/, finished images under the site's asset folders, `
    + `and requested CSS, layout and configuration changes in their real source files. Do not stage a second site or alternate HTML preview in Botference. `
    + `Reuse existing drafts and assets. New posts use Templates/baseline.md with current created/released dates, an essays tag and published: false. `
    + `Scratch goes in ${blog.scratchDir(site.root)}. The companion manages the local preview. Never edit _site/ or run git, gh, commit, push or public deployment.\n`;
}

export function changedPosts(site, changed, before, sourceUrl, config = {}) {
  const dir = String(config.draft_dir || '_notes').replace(/\/$/, '') + '/';
  for (const rel of changed) {
    if (!rel.startsWith(dir) || !/\.md$/i.test(rel)) continue;
    const file = path.resolve(site.root, rel);
    if (!fs.realpathSync(file).startsWith(site.root + path.sep)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const fm = blog.frontMatter(raw) || {};
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    const released = typeof fm.released === 'string' && fm.released;
    // Complete touched drafts, not already released ordinary notes.
    if (before.has(rel) && fm.published !== 'false' && (released || !tags.includes('essays'))) continue;
    const title = typeof fm.title === 'string' && fm.title ? fm.title
      : path.basename(file, '.md');
    const urlPath = typeof fm.permalink === 'string' && fm.permalink.startsWith('/')
      ? fm.permalink : '/' + (blog.slugify(title) || 'draft') + '/';
    const template = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw)?.[0];
    const fallback = drafts.destination({ slug: '', brief: '', agent: '' },
      { ...config, draft_site: site.root }, [site], () => 'yes').template;
    const front = drafts.frontMatterFor({ template: template || fallback, urlPath }, title,
      { url: typeof fm.source_url === 'string' && fm.source_url ? fm.source_url : sourceUrl },
      new Date(), { preserveDates: true });
    const body = template ? raw.slice(template.length).trimStart() : raw;
    fs.writeFileSync(file, front + '\n\n' + body);
  }
  blog.forgetIndex(site.root);
  const index = blog.indexOf(site.root, site.kind);
  return index.docs.filter(d => changed.includes(d.rel) && d.rel.startsWith(dir) && d.urls.length)
    .map(d => ({ ...d, url: site.serve_origin + d.urls[0], serve_origin: site.serve_origin,
      root: site.root, previewToken: '' }));
}
