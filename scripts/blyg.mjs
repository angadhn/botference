#!/usr/bin/env node
// The botference blyg: turns the posts in blyg/posts/*.md into the static
// Blygger 0.4 surface under site/blyg/ (manifest, archive index, item
// documents, RSS feed, and an HTML page for each post).
//
//   node scripts/blyg.mjs new <slug>              write a new post file with a fresh id
//   node scripts/blyg.mjs version <post> [note]   add the next version line to a post
//   node scripts/blyg.mjs build                   write site/blyg/ from the posts
//   node scripts/blyg.mjs check                   run the Blygger conformance checker
//                                                 (BLYG_CHECKER = blygger-spec/conformance/schemas/lib)
//
// The build reads no clock and no network, so the same posts give the same
// bytes. The published item documents in site/blyg/items/ are the record of
// what was published: the build refuses to change a published version in
// place. A changed text needs a new version line in the post's front matter.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULTS = Object.freeze({
  posts: path.join(REPO, 'blyg', 'posts'),
  out: path.join(REPO, 'site', 'blyg'),
  origin: 'https://botference.com/blyg/',
});
export const SITE = Object.freeze({
  title: 'The botference blyg',
  description: 'Release notes and short posts about botference, published as a blyg.',
  generator: 'botference-blyg/1.0.0',
  generator_url: 'https://github.com/angadhn/botference/blob/main/scripts/blyg.mjs',
  author: { name: 'botference', links: [{ label: 'GitHub', url: 'https://github.com/angadhn/botference' }] },
});
const FEED_WINDOW = 50;

export class Refusal extends Error {}
const refuse = msg => { throw new Refusal(msg); };

// ── ids, hashes, times ───────────────────────────────────────────────
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
export const ID_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const UTC_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/** 128 random bits as 26 lowercase Crockford base32 characters (§5.1). */
export function mintId(bytes = crypto.randomBytes(16)) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let s = '';
  for (let i = 0; i < 26; i++) { s = CROCKFORD[Number(n & 31n)] + s; n >>= 5n; }
  return s;
}
export const hashOf = md => 'sha256:' + crypto.createHash('sha256').update(md, 'utf8').digest('hex');
const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const rfc822 = at => new Date(at).toUTCString();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayOf = at => { const d = new Date(at); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

// ── a post file ──────────────────────────────────────────────────────
// ---
// id: <26 characters, minted once by `new`>
// v1: 2026-11-26T21:00:00Z
// v2: 2026-11-28T09:00:00Z Fixed the link to the laws page.
// ---
// # The title is the first line of the text
//
// Markdown text.
export function parsePost(text, file = 'post') {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) refuse(`${file}: no front matter (a --- line, the id and version lines, a --- line)`);
  let id = null;
  const versions = [];
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    let v;
    if ((v = /^id:\s*(\S+)\s*$/.exec(line))) id = v[1];
    else if ((v = /^v(\d+):\s*(\S+)(?:\s+(.+?))?\s*$/.exec(line))) versions.push({ version: Number(v[1]), at: v[2], note: v[3] ?? null });
    else refuse(`${file}: front matter line not understood: "${line}"`);
  }
  if (!id || !ID_RE.test(id)) refuse(`${file}: id must be 26 lowercase Crockford characters (run \`node scripts/blyg.mjs new\`)`);
  if (!versions.length) refuse(`${file}: no version line (v1: <UTC time>)`);
  versions.forEach((v, i) => {
    if (v.version !== i + 1) refuse(`${file}: version lines must be v1, v2, … in order`);
    if (!UTC_RE.test(v.at) || Number.isNaN(Date.parse(v.at))) refuse(`${file}: v${v.version} time must be UTC like 2026-11-26T21:00:00Z`);
    if (i && v.at < versions[i - 1].at) refuse(`${file}: v${v.version} is earlier than v${i}`);
  });
  const md = m[2].replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
  checkText(md, file);
  return { id, versions, md, file };
}

function checkText(md, file) {
  if (md.trim() === '') refuse(`${file}: the post has no text`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(md)) refuse(`${file}: the text holds a control character (§5.1)`);
  if (/[\ud800-\udfff]/.test(md.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) refuse(`${file}: the text holds an unpaired surrogate (§5.1)`);
  if (md !== md.normalize('NFC')) refuse(`${file}: the text is not in Unicode NFC (§5.1)`);
  // This generator resolves no quotes or links between items, so the bracket
  // grammar (§10.1) and TK marks are refused rather than published as text.
  if (/\[\[/.test(md)) refuse(`${file}: "[[" is the Blygger quote/link grammar, which this generator does not resolve; write an ordinary markdown link`);
  if (/\[\/?TK\]/.test(md)) refuse(`${file}: [TK] marks must not be published (§5.7)`);
}

// ── markdown → self-contained HTML (every URL absolute, §5.2) ─────────
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function absolute(url, origin) {
  let u;
  try { u = new URL(url, origin); } catch { refuse(`link "${url}" is not a URL`); }
  if (!/^(https?|mailto):$/.test(u.protocol)) refuse(`link "${url}" must be http, https or mailto`);
  return u.href;
}
function emphasis(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}
// Code spans are set aside as placeholders first (U+0000 never reaches here:
// checkText refuses control characters), so emphasis and links may wrap them.
function inline(text, origin) {
  const codes = [];
  const held = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  let out = '', last = 0, m;
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  while ((m = re.exec(held))) {
    out += emphasis(held.slice(last, m.index)) + `<a href="${esc(absolute(m[2], origin))}">${emphasis(m[1])}</a>`;
    last = re.lastIndex;
  }
  out += emphasis(held.slice(last));
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}
const BLOCK_START = /^(#{1,6}\s|>|[-*]\s|\d+\.\s|```)/;

export function renderMarkdown(md, origin) {
  const lines = md.replace(/\n$/, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      out.push(`<h${m[1].length}>${inline(m[2].trim(), origin)}</h${m[1].length}>`);
      i++;
    } else if (line.startsWith('>')) {
      const body = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>\n${renderMarkdown(body.join('\n') + '\n', origin)}\n</blockquote>`);
    } else if ((m = /^([-*]|\d+\.)\s+/.exec(line))) {
      const ordered = /\d/.test(m[1]);
      const itemRe = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      const items = [];
      while (i < lines.length && (itemRe.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (itemRe.test(lines[i])) items.push(lines[i].replace(itemRe, ''));
        else items[items.length - 1] += '\n' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>\n${items.map(t => `<li>${inline(t, origin)}</li>`).join('\n')}\n</${tag}>`);
    } else {
      const body = [];
      for (; i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<p>${inline(body.join('\n'), origin)}</p>`);
    }
  }
  return out.join('\n');
}

/** The plain words of a markdown text, for titles and excerpts. */
export function plainText(md) {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^>\s?/gm, '').replace(/^([-*]|\d+\.)\s+/gm, '')
    .replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}
function clip(s, n) {
  const cps = [...s];
  if (cps.length <= n) return s;
  const cut = cps.slice(0, n).join('');
  return cut.replace(/\s+\S*$/, '') + '…';
}
/** A page's title: the post's leading heading, or its first words. */
export function titleOf(md) {
  const m = /^#\s+(.+)$/m.exec(md.split('\n')[0]);
  return m ? plainText(m[1]) : clip(plainText(md), 70);
}

// ── what a build does with one post ───────────────────────────────────
// A post is in exactly one of these cases against the published record.
// Every other combination is refused.
export const OUTCOMES = Object.freeze(['first', 'same', 'next']);
export function outcomeOf(post, published) {
  const last = post.versions[post.versions.length - 1].version;
  if (!published) {
    if (last !== 1) refuse(`${post.file}: not published yet, so it must have only the v1 line (it has v1–v${last})`);
    return 'first';
  }
  if (published.kind !== 'thread') refuse(`${post.file}: the published item is a ${published.kind}; this generator publishes threads only`);
  for (const c of published.changelog) {
    const v = post.versions[c.version - 1];
    if (!v) refuse(`${post.file}: v${c.version} is published but its line is gone from the front matter; published versions cannot be removed`);
    if (v.at !== c.at || v.note !== c.note) refuse(`${post.file}: the v${c.version} line differs from what was published (${c.at}${c.note ? ' ' + c.note : ''}); a published version cannot be changed`);
  }
  const changed = hashOf(post.md) !== published.content_hash;
  if (last === published.version) {
    if (changed) refuse(`${post.file}: the text differs from published v${last}. Add a v${last + 1} line (\`node scripts/blyg.mjs version ${path.basename(post.file)} "what changed"\`), or undo the change`);
    return 'same';
  }
  if (last === published.version + 1) {
    if (!changed) refuse(`${post.file}: v${last} has the same text as v${published.version}; remove the v${last} line or change the text`);
    if (post.versions[last - 1].at < published.updated) refuse(`${post.file}: v${last} is earlier than v${published.version}`);
    return 'next';
  }
  refuse(`${post.file}: published at v${published.version}, so the next line is v${published.version + 1} (the post has v${last})`);
}

const pagePath = id => `t/${id}/`;

export function itemDoc(post, published, origin) {
  const outcome = outcomeOf(post, published);
  if (outcome === 'same') return { outcome, doc: published };
  const v = post.versions[post.versions.length - 1];
  const doc = {
    blyg: '0.4',
    id: post.id,
    kind: 'thread',
    origin,
    page: pagePath(post.id),
    author: { name: SITE.author.name },
    created: post.versions[0].at,
    updated: v.at,
    version: v.version,
    content_md: post.md,
    content_html: renderMarkdown(post.md, origin),
    content_hash: hashOf(post.md),
    media: [],
    transclusions: [],
    changelog: [...(published ? published.changelog : []), { version: v.version, at: v.at, note: v.note }],
  };
  return { outcome, doc };
}

// ── the surface files ────────────────────────────────────────────────
const json = v => JSON.stringify(v, null, 2) + '\n';
const byUpdated = (a, b) => (b.updated.localeCompare(a.updated) || b.id.localeCompare(a.id));

function manifest(docs, origin) {
  const updated = docs.map(d => d.updated).sort().pop();
  return {
    blyg: '0.4', level: 2, generator: SITE.generator, generator_url: SITE.generator_url,
    site: origin, title: SITE.title, description: SITE.description, author: SITE.author,
    feed: 'feed.xml', items: 'items/index.json', updated,
  };
}
function archiveIndex(docs) {
  const sorted = [...docs].sort(byUpdated);
  return { updated: sorted[0].updated, items: sorted.map(d => ({ id: d.id, kind: d.kind, created: d.created, updated: d.updated, version: d.version })) };
}
const cdata = s => '<![CDATA[' + s.replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
function feed(docs, origin) {
  const events = docs.flatMap(d => d.changelog.map(c => ({ d, c })))
    .sort((a, b) => b.c.at.localeCompare(a.c.at) || b.d.id.localeCompare(a.d.id) || b.c.version - a.c.version)
    .slice(0, FEED_WINDOW);
  const updated = docs.map(d => d.updated).sort().pop();
  const entry = ({ d, c }) => {
    const excerpt = clip(plainText(d.content_md), 80);
    const title = c.note ? `${c.note} — ${excerpt}` : excerpt;
    return `    <item>
      <guid isPermaLink="false">blyg:${d.id}:v${c.version}</guid>
      <link>${esc(new URL(d.page, origin).href)}</link>
      <title>${esc(title)}</title>
      <description>${cdata(d.content_html)}</description>
      <pubDate>${rfc822(c.at)}</pubDate>
      <dc:creator>${esc(d.author.name)}</dc:creator>
      <blyg:id>${d.id}</blyg:id>
      <blyg:kind>${d.kind}</blyg:kind>
      <blyg:version>${c.version}</blyg:version>
      <blyg:created>${d.created}</blyg:created>
      <blyg:item>${origin}items/${d.id}.json</blyg:item>
    </item>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:blyg="https://blygger.org/ns/0.1" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(SITE.title)}</title>
    <link>${origin}</link>
    <description>${esc(SITE.description)}</description>
    <lastBuildDate>${rfc822(updated)}</lastBuildDate>
    <blyg:level>2</blyg:level>
    <blyg:manifest>${origin}blyg.json</blyg:manifest>
${events.map(entry).join('\n')}
  </channel>
</rss>
`;
}

// ── HTML pages ───────────────────────────────────────────────────────
function shell({ title, description, canonical, origin, extraHead = '', body, current }) {
  const nav = [['/blygger.html', 'Blygger'], ['/laws.html', 'Laws'], ['/blyg/', 'Blyg'],
    ['https://github.com/angadhn/botference', 'GitHub'], ['https://github.com/sponsors/angadhn', 'Sponsor']]
    .map(([href, label]) => `      <a href="${href}"${label === current ? ' aria-current="page"' : ''}>${label}</a>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#0b0e12">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">
<link rel="stylesheet" href="/site.css">
<link rel="blyg" href="${origin}blyg.json">
<link rel="alternate" type="application/rss+xml" title="${esc(SITE.title)}" href="${origin}feed.xml">
${extraHead}</head>
<body>

<header>
  <div class="wrap">
    <a class="logo" href="/" title="Botference — home">botference<span>_</span></a>
    <nav>
${nav}
    </nav>
  </div>
</header>

${body}

<footer>
  <div class="wrap">
    <span>© 2026 botference · MIT</span>
    <span class="spacer"></span>
    <a href="https://github.com/angadhn/botference">GitHub</a>
    <a href="https://github.com/angadhn/botference/blob/main/CHANGELOG.md">Changelog</a>
    <a href="https://github.com/sponsors/angadhn">Sponsor</a>
  </div>
</footer>

</body>
</html>
`;
}

function itemPage(d, origin) {
  const changes = [...d.changelog].reverse().map(c =>
    `      <li><b>v${c.version}</b> · ${esc(dayOf(c.at))} · ${c.note ? esc(c.note) : (c.version === 1 ? 'first version' : 'no note')}</li>`).join('\n');
  const body = `<main class="doc blyg-item">
  <p class="eyebrow"><a href="../../">the botference blyg</a></p>
  <article class="blyg-post">
${d.content_html}
  </article>
  <p class="blyg-meta">Version ${d.version} · ${esc(dayOf(d.updated))}${d.version > 1 ? ` · first published ${esc(dayOf(d.created))}` : ''}</p>
  <h2>Versions</h2>
  <ol class="blyg-changelog">
${changes}
  </ol>
  <p class="note">This post is a blyg item: other blygs can quote it and answer it by reference.
    Its <a href="../../items/${d.id}.json">item document</a> is the machine-readable version.
    Older texts are not kept online; the list above gives only each version's date and note.</p>
</main>`;
  return shell({
    title: `${titleOf(d.content_md)} — the botference blyg`,
    description: clip(plainText(d.content_md), 160),
    canonical: new URL(d.page, origin).href,
    origin,
    extraHead: `<link rel="alternate" type="application/json" href="${origin}items/${d.id}.json">\n`,
    body,
    current: 'Blyg',
  });
}

function indexPage(docs, origin) {
  const rows = [...docs].sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id)).map(d =>
    `    <li><a href="${d.page}">${esc(titleOf(d.content_md))}</a>
      <span>${esc(dayOf(d.created))}${d.version > 1 ? ` · v${d.version}, ${esc(dayOf(d.updated))}` : ''}</span></li>`).join('\n');
  const body = `<main class="doc">
  <p class="eyebrow">a blyg · Blygger protocol 0.4</p>
  <h1>The botference<br><em>blyg.</em></h1>
  <p class="lede">
    Release notes and short posts about botference.
    A blyg is a blog that follows the <a href="https://blygger.org">Blygger</a> protocol.
    Other blygs can quote each post here and answer it by reference.
  </p>

  <h2>Posts</h2>
  <ul class="blyg-list">
${rows}
  </ul>

  <h2>Follow</h2>
  <p>
    Give this page's address to a Blygger reader, or add the <a href="feed.xml">RSS feed</a> to a feed reader.
    The <a href="blyg.json">manifest</a> and the <a href="items/index.json">archive index</a> are the machine-readable parts.
  </p>
</main>`;
  return shell({ title: SITE.title, description: SITE.description, canonical: origin, origin, body, current: 'Blyg' });
}

// ── build ────────────────────────────────────────────────────────────
export function readPosts(postsDir) {
  if (!fs.existsSync(postsDir)) return [];
  const posts = fs.readdirSync(postsDir).filter(f => f.endsWith('.md')).sort()
    .map(f => parsePost(fs.readFileSync(path.join(postsDir, f), 'utf8'), f));
  const seen = new Map();
  for (const p of posts) {
    if (seen.has(p.id)) refuse(`${p.file} and ${seen.get(p.id)} have the same id`);
    seen.set(p.id, p.file);
  }
  return posts;
}

function readPublished(outDir) {
  const dir = path.join(outDir, 'items');
  const published = new Map();
  if (!fs.existsSync(dir)) return published;
  for (const f of fs.readdirSync(dir)) {
    if (/^[0-9a-z]{26}\.json$/.test(f)) published.set(f.slice(0, 26), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return published;
}

/** Plan the whole build in memory. Refuses before anything is written. */
export function plan({ posts: postsDir = DEFAULTS.posts, out = DEFAULTS.out, origin = DEFAULTS.origin } = {}) {
  const posts = readPosts(postsDir);
  const published = readPublished(out);
  for (const id of published.keys()) {
    if (!posts.some(p => p.id === id)) refuse(`item ${id} is published but no post has its id; a published item cannot be removed (withdrawal is not supported yet)`);
  }
  if (!posts.length) refuse(`no posts in ${postsDir}`);
  const results = posts.map(p => ({ post: p, ...itemDoc(p, published.get(p.id), origin) }));
  const docs = results.map(r => r.doc);
  const files = new Map([
    ['blyg.json', json(manifest(docs, origin))],
    ['items/index.json', json(archiveIndex(docs))],
    ['feed.xml', feed(docs, origin)],
    ['index.html', indexPage(docs, origin)],
  ]);
  for (const r of results) {
    const d = r.doc;
    files.set(`items/${d.id}.json`, r.outcome === 'same' ? fs.readFileSync(path.join(out, 'items', `${d.id}.json`), 'utf8') : json(d));
    files.set(`${d.page}index.html`, itemPage(d, origin));
  }
  return { results, files };
}

/** Write the planned files; returns the paths whose bytes changed. */
export function build(opts = {}) {
  const out = opts.out || DEFAULTS.out;
  const { results, files } = plan(opts);
  const changed = [];
  for (const [rel, text] of files) {
    const p = path.join(out, rel);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    changed.push(rel);
  }
  return { results, changed };
}

/** Run the official checker over a copy of the output. */
export async function check({ out = DEFAULTS.out, origin = DEFAULTS.origin, checker = process.env.BLYG_CHECKER } = {}) {
  if (!checker) refuse('BLYG_CHECKER is not set: point it at blygger-spec/conformance/schemas/lib');
  const { checkSite } = await import(pathToFileURL(path.join(checker, 'check-site.mjs')).href);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'botference-blyg-check-'));
  try {
    fs.cpSync(out, stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'scenario.json'), JSON.stringify({ origin }));
    return checkSite(stage);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ── the commands that write a post file ──────────────────────────────
export function newPost(slug, { posts = DEFAULTS.posts, at = nowUtc(), id = mintId() } = {}) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug || '')) refuse('give a slug of lowercase letters, digits and hyphens');
  const file = path.join(posts, `${at.slice(0, 10)}-${slug}.md`);
  if (fs.existsSync(file)) refuse(`${file} exists`);
  fs.mkdirSync(posts, { recursive: true });
  fs.writeFileSync(file, `---\nid: ${id}\nv1: ${at}\n---\n# A title\n\nThe text.\n`);
  return file;
}

export function addVersion(file, note = '', { at = nowUtc() } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const post = parsePost(text, path.basename(file));
  const n = post.versions.length + 1;
  if (/\n/.test(note)) refuse('a note is one line');
  const line = `v${n}: ${at}${note.trim() ? ' ' + note.trim() : ''}`;
  fs.writeFileSync(file, text.replace(/\n---\n/, `\n${line}\n---\n`));
  return line;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'new') {
    console.log(newPost(args[0]));
  } else if (cmd === 'version') {
    const file = fs.existsSync(args[0] || '') ? args[0] : path.join(DEFAULTS.posts, args[0] || '');
    console.log(addVersion(file, args.slice(1).join(' ')));
  } else if (cmd === 'build') {
    const { results, changed } = build();
    for (const r of results) console.log(`${r.outcome.padEnd(5)} v${r.doc.version} ${r.post.file}`);
    console.log(changed.length ? `wrote ${changed.length} file(s) under site/blyg/` : 'site/blyg/ is up to date');
  } else if (cmd === 'check') {
    const r = await check();
    let fail = false;
    for (const d of r.docs) {
      console.log(`${d.verdict.padEnd(5)} ${d.path}`);
      for (const rule of d.rules || []) if (rule.messages?.length) console.log(`      ${rule.level} ${rule.id}: ${rule.messages.join('; ')}`);
      for (const e of [...(d.schema?.fail || []), ...(d.schema?.warn || [])]) console.log(`      schema: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
      if (d.verdict === 'fail') fail = true;
    }
    process.exitCode = fail ? 1 : 0;
  } else {
    console.log('usage: node scripts/blyg.mjs new <slug> | version <post> [note] | build | check');
    process.exitCode = cmd ? 2 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => {
    console.error(e instanceof Refusal ? `blyg: refused: ${e.message}` : e);
    process.exitCode = 1;
  });
}
