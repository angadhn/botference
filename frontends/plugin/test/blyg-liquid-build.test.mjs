// blyg-liquid-build.test.mjs — what a hostile page and an agent's words become when REAL Jekyll builds the note.
//
//   BLYG_BLOG_TREE=/path/to/a/checkout/of/the/example/blog node --test test/blyg-liquid-build.test.mjs
//
// RUNS whenever BLYG_BLOG_TREE names a site checkout that can `bundle exec jekyll build` (set it in the environment of `node --test test/`
// and run-all.mjs, as SPEC says: this is the guard of the Liquid/HTML escaping, and a skipped guard is no guard; without it the test
// is skipped and says so on stderr). It copies the tree (never the
// original), replaces its notes with the generated ones plus a "private" note that must never appear in a built post, builds
// with RUBYOPT=-r<tests/support/no_network.rb> (any connection is logged and fails), and reads the built HTML. Run it inside
// the network sandbox as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as N from '../blyg-note.mjs';

const TREE = process.env.BLYG_BLOG_TREE || '';
const run = TREE && fs.existsSync(path.join(TREE, 'Gemfile')) ? test : test.skip;
if (run === test.skip) process.stderr.write('blyg-liquid-build: SKIPPED — set BLYG_BLOG_TREE to a checkout of the example blog to run the real-build guard\n');
const NOW = new Date('2026-11-21T12:00:00Z');
const mine = (text, extra = {}) => ({ author: 'owner', ts: '1', text, provenance: 'owner-typed', ...extra });
const HOME = { template: N.DEFAULT_TEMPLATE, escape: 'liquid', timezone: 'Europe/London' };
const HOSTILE = [
  '{% include_relative zz-private.md %}', '{% cycle site.title %}', '{{ site.url }}', '{% raw %}{{ site.url }}{% endraw %}',
  '{%- cycle site.title -%}', '{{- site.title -}}', '{%\ncycle site.title\n%}', '{% assign x = site.title %}{{ x }}',
];

run('Liquid in a passage, owner text, an agent\'s fill, a label and a URL is shown as text; nothing from another file; attributes stay closed', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-liquid-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  for (const n of fs.readdirSync(TREE)) {
    if (['.git', '_site', '.jekyll-cache', '.cache', 'node_modules', '_notes'].includes(n)) continue;
    spawnSync('cp', ['-cR', path.join(TREE, n), src]);
    if (!fs.existsSync(path.join(src, n))) spawnSync('cp', ['-R', path.join(TREE, n), src]);
  }
  fs.mkdirSync(path.join(src, '_notes'));
  fs.writeFileSync(path.join(src, '_notes', 'zz-private.md'), '---\ntitle: Private\n---\nPRIVATE-FILE-MARKER\n');
  const pub = path.join(src, '_blyg/publication.json');
  const rec = JSON.parse(fs.readFileSync(pub, 'utf8')); rec.items = {}; fs.writeFileSync(pub, JSON.stringify(rec, null, 2));
  const cases = {};
  HOSTILE.forEach((h, i) => {
    const t1 = { id: 't', quote: `before ${h} after`, msgs: [mine(`own ${h} end`)] };
    cases[`liq-${i}`] = { url: `https://news.example.test/a${i}`, title: h, threads: [t1] };
  });
  cases['liq-gap'] = { url: 'https://news.example.test/gap', title: 'S', threads: [{ id: 't', quote: 'q', msgs: [{ ...mine('Intro\n/tk go\nOutro'), gaps: [{ instruction: 'go', mode: 'filled-by-agent',
    text: 'LEAK {% cycle site.title %} {% include_relative zz-private.md %} <script>alert(1)</script> [x](javascript:alert(1)) " onmouseover="x' }] }] }] };
  cases['liq-url'] = { url: 'https://news.example.test/{{ site.title }}/{% cycle site.url %}?q={%25', title: 'S', threads: [{ id: 't', quote: 'q', msgs: [mine('plain')] }] };
  cases['liq-url-only'] = { url: 'https://news.example.test/urlonly', title: 'S', threads: [{ id: 't', quote: 'before\nhttps://hostile-card.example.test/steal\nafter', msgs: [mine('plain')] }] };
  const html = '<script>alert(1)</script> <img src=x onerror=alert(1)> <iframe src=//x></iframe> <style>*{x:y}</style> <!-- c --> <details open ontoggle=alert(1)>t</details> [x](javascript:alert(1)) <https://ok.example.test/a> a < b';
  // (in the owner's own words a javascript: link is REFUSED at the start since review item 6; the rest of the HTML is made text)
  const own = html.replace(' [x](javascript:alert(1))', '');
  cases['html-owner'] = { url: 'https://news.example.test/ho', title: 'S', threads: [{ id: 't', quote: 'q', msgs: [mine('Own: ' + own)] }] };
  cases['html-adopted'] = { url: 'https://news.example.test/ha', title: 'S', threads: [{ id: 't', quote: 'q', msgs: [{ ...mine('A\n/tk go\nB'), gaps: [{ instruction: 'go', mode: 'adopted-by-reader', text: own }] }] }] };
  cases['html-agent'] = { url: 'https://news.example.test/hg', title: 'S', threads: [{ id: 't', quote: 'q', msgs: [{ ...mine('A\n/tk go\nB'), gaps: [{ instruction: 'go', mode: 'filled-by-agent', text: html }] }] }] };
  cases['html-passage'] = { url: 'https://news.example.test/hp', title: 'S', threads: [{ id: 't', quote: html, msgs: [mine('plain')] }] };
  // review item 5: a hostile passage written in the site's sidenote syntax stays text (no sidenote markup, nothing of it as HTML)
  cases['sidenote-passage'] = { url: 'https://news.example.test/sn', title: 'S', threads: [{ id: 't', quote: 'A claim[^1] here.\n[^1]: <b>FOOTNOTE-MARKER</b> injected', msgs: [mine('plain')] }] };
  cases['sidenote-agent'] = { url: 'https://news.example.test/sg', title: 'S', threads: [{ id: 't', quote: 'q', msgs: [{ ...mine('A\n/tk go\nB'), gaps: [{ instruction: 'go', mode: 'filled-by-agent', text: 'x[^2] y\n[^2]: <i>AGENT-NOTE</i>' }] }] }] };
  cases['liq-attr'] = { url: 'https://news.example.test/attr', title: 'S', threads: [{ id: 't', quote: 'q', msgs: [mine('"><script>alert(1)</script> \' onfocus=\'x say "hello" & <b>bold</b>')] }] };
  const permalinks = {};
  for (const [slug, page] of Object.entries(cases)) {
    const r = N.renderShortNote({ page, threads: page.threads, home: HOME, now: NOW, slug });
    assert.ok(r.ok, `${slug}: ${r.error}`);
    permalinks[slug] = r.permalink;   // the page is built at the note's own address (/b/<id>), not at its file name
    fs.writeFileSync(path.join(src, '_notes', `${slug}.md`), r.text);
    // a card for a link nobody cached is looked up by the site's card plugin: mark these as looked up (no answer), so the build stays offline
    for (const m of r.text.matchAll(/^> (https?:\/\/\S+)$/gm)) fs.appendFileSync(path.join(src, '_data/link_cards.yml'), `${JSON.stringify(m[1])}: null\n`);
  }
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const netlog = path.join(tmp, 'net.log');
  let err = '';
  for (const mode of ['prepare', 'build']) {
    const r = spawnSync('bundle', ['exec', 'jekyll', 'build', '--source', src, '--destination', path.join(tmp, `site-${mode}`), '--quiet'], {
      cwd: src, encoding: 'utf8', timeout: 280000,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', BUNDLE_GEMFILE: path.join(src, 'Gemfile'), BLYG_RUN_MODE: mode, JEKYLL_ENV: 'development',
        RUBYOPT: `-r${path.join(TREE, 'tests/support/no_network.rb')}`, BLYG_NO_NET_LOG: netlog } });
    err += r.stdout + r.stderr;
    assert.equal(r.status, 0, `${mode} build failed:\n${err.slice(0, 1800)}`);
  }
  const site = path.join(tmp, 'site-build');
  const decode = h => h.replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  // the built page of a case, at its permalink (/b/<id>.html or /b/<id>/index.html)
  const built = slug => {
    const p = permalinks[slug].replace(/\/+$/, '');
    const f = [path.join(site, `${p}.html`), path.join(site, p, 'index.html')].find(x => fs.existsSync(x));
    assert.ok(f, `${slug}: built at ${p}`);
    return fs.readFileSync(f, 'utf8');
  };
  const siteTitle = (fs.readFileSync(path.join(TREE, '_config.yml'), 'utf8').match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1] || 'Angadh';
  for (const slug of Object.keys(cases)) {
    const html = built(slug);
    assert.ok(!html.includes('PRIVATE-FILE-MARKER'), `${slug}: nothing of another file`);
    const body = (/<content>([\s\S]*?)<\/content>/.exec(html) || [, html])[1];
    assert.ok(!body.includes(siteTitle), `${slug}: Liquid did not run (the site title is not in the post body)`);
    // short posts are text: raw HTML is never live, whoever wrote it
    assert.ok(!/<script|href="javascript:|on\w+="/i.test(body), `${slug}: no live script or javascript: link`);
    // every meta attribute is closed: og:title and twitter:title hold the whole value on one tag
    for (const m of html.matchAll(/<meta (?:property="og:title"|name="twitter:title") content="([^"]*)"/g)) assert.ok(!/<script/.test(m[1]), `${slug}: ${m[1]}`);
    assert.ok(!/onmouseover="|onfocus='x/.test(html.replace(/&quot;/g, '')) || !/<[^>]*\sonmouseover="x/.test(html), `${slug}: no injected attribute`);
  }
  // the text is shown, literally
  const lit = decode(built('liq-1'));
  assert.match(lit, /before \{% cycle site\.title %\} after/);
  assert.match(decode(built('liq-0')), /\{% include_relative zz-private\.md %\}/);
  assert.match(decode(built('liq-3')), /\{% raw %\}\{\{ site\.url \}\}\{% endraw %\}/);
  for (const k of ['html-owner', 'html-adopted', 'html-agent', 'html-passage']) {
    const h = built(k);
    const b = (/<content>([\s\S]*?)<\/content>/.exec(h) || [, h])[1];
    assert.ok(!/<(script|iframe|style|details)\b|<img [^>]*onerror|<!--\s*c\s*-->|href="javascript:/i.test(b), `${k}: no live HTML in the post`);
    assert.match(decode(b), /a < b/, `${k}: a < b reads as typed`);
  }
  const attr = built('liq-attr');
  assert.ok(/<meta property="og:title" content="[^"]*&quot;|<meta property="og:title" content="[^"<>]*"/.test(attr), 'og:title is one closed attribute');
  const urlOnly = built('liq-url-only');
  assert.ok(!/link-card|<a [^>]*hostile-card/.test(urlOnly), 'a URL-only passage line is not a link or a card');
  assert.match(decode(urlOnly), /https:\/\/hostile-card\.example\.test\/steal/, 'and it is shown as text');
  for (const [k, marker] of [['sidenote-passage', 'FOOTNOTE-MARKER'], ['sidenote-agent', 'AGENT-NOTE']]) {
    const h = built(k);
    const b = (/<content>([\s\S]*?)<\/content>/.exec(h) || [, h])[1];
    assert.ok(!/class=.sidenote|class=.margin-toggle/.test(b), `${k}: the site's sidenote converter did not read the passage`);
    assert.ok(!/<b>FOOTNOTE-MARKER|<i>AGENT-NOTE/.test(b), `${k}: nothing of it became HTML`);
    assert.match(decode(b), /\[\^[12]\]/, `${k}: the brackets read as typed`);
    assert.ok(decode(b).includes(marker), `${k}: and the words are there, as text`);
  }
  assert.ok(!fs.existsSync(netlog), `a connection was attempted: ${fs.existsSync(netlog) ? fs.readFileSync(netlog, 'utf8') : ''}`);
});
