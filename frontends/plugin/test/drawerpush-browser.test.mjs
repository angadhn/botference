// drawerpush-browser.test.mjs — the drawer's PUSH layout, measured in a REAL headless Chromium-family browser (throwaway profile, no window).
//
//   node --test frontends/plugin/test/drawerpush-browser.test.mjs      (skipped when no browser is found; set BOTFERENCE_CHROME)
//
// jsdom/happy-dom have no layout, so the claims that need one are made here: opening in push mode narrows the page by the drawer's width,
// a fixed element anchored to the right edge ends up fully visible LEFT of the drawer, a fixed bar across the window is narrowed, a
// fixed element added after opening is moved too, closing puts every style attribute back byte for byte, overlay leaves the page alone,
// and a window narrower than drawer + 320 falls back to overlay. The fixture page is served from 127.0.0.1 with the real drawer.js,
// config.js and drawer.css.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../preview-render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = f => fs.readFileSync(path.join(here, '..', 'extension', f), 'utf8');
const CHROME = findChrome();

// The page the drawer is put on: a theme-toggle-like button fixed top right (inline style, and one from a stylesheet), a fixed bar across
// the top, an ordinary article. `?case=` picks what the script does; the result is written into <pre id=out> as JSON.
const fixture = () => `<!doctype html><html style="background:#fdfdfd"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
  body{margin:0;font:16px/1.5 sans-serif} article{padding:16px 24px}
  #bar{position:fixed;top:0;left:0;right:0;height:40px;background:#223;color:#fff;z-index:5}
  #toggle{position:fixed;top:8px;right:12px;width:56px;height:28px;z-index:6;background:#e60;color:#fff;border:0}
  .late{position:fixed;bottom:12px;right:12px;width:90px;height:30px;background:#06c;color:#fff;z-index:6}
  #plain{position:fixed;top:60px;right:0;width:40px;height:40px;background:#0a0;z-index:6}
</style></head><body>
<div id="bar">bar</div>
<button id="toggle" style="color:#fff">theme</button>
<div id="plain"></div>
<article id="art"><h1>An article</h1><p>${'Some words to fill the page. '.repeat(120)}</p></article>
<pre id="out"></pre>
<script>${ext('config.js')}</script>
<script>window.BFP_CSS = ${JSON.stringify(ext('drawer.css'))};</script>
<script>${ext('drawer.js')}</script>
<script>
(async () => {
  const q = new URLSearchParams(location.search), which = q.get('case');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const settle = () => document.getAnimations().forEach(a => { try { a.finish(); } catch (_) {} });   // the page's own slide is a CSS transition; virtual time does not run it
  const $ = id => document.getElementById(id);
  const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width }; };
  const attrs = () => ({ html: document.documentElement.getAttribute('style'), toggle: $('toggle').getAttribute('style'), bar: $('bar').getAttribute('style'), plain: $('plain').getAttribute('style') });
  const d = BFPDrawer.create({ cssText: window.BFP_CSS, hostname: 'fixture.test' });
  d.setConn(true); d.setAuthor('reader');
  if (q.get('layout')) d.setLayout(q.get('layout'));
  const out = { vw: document.documentElement.clientWidth, which, before: attrs(), layoutNow: null };
  out.articleBefore = rect($('art')).width;
  d.open('comments');
  await sleep(300); settle();
  out.layoutNow = d.layoutNow();
  out.panel = rect(d.shadow.querySelector('.panel'));
  out.article = rect($('art')).width;
  out.toggle = rect($('toggle')); out.bar = rect($('bar')); out.plain = rect($('plain'));
  out.during = attrs();
  if (which === 'late') {
    const e = document.createElement('div'); e.className = 'late'; e.id = 'late'; document.body.appendChild(e);
    await sleep(400);
    out.late = rect(e);
    out.lateStyle = e.getAttribute('style');
  }
  if (which === 'drag') { d.setWidth(520); await sleep(300); settle(); out.panel2 = rect(d.shadow.querySelector('.panel')); out.toggle2 = rect($('toggle')); out.article2 = rect($('art')).width; }
  d.close();
  await sleep(300); settle();
  out.after = attrs();
  out.articleAfter = rect($('art')).width;
  if (which === 'late') out.lateAfter = $('late').getAttribute('style');
  $('out').textContent = JSON.stringify(out);
})();
</script></body></html>`;

const serve = () => new Promise(r => { const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(fixture()); }); s.listen(0, '127.0.0.1', () => r(s)); });
const run = (url, width, extra = []) => new Promise((resolve, reject) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-push-'));
  execFile(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--incognito', `--user-data-dir=${profile}`,
    `--window-size=${width},800`, '--virtual-time-budget=6000', ...extra, url], { timeout: 60000, maxBuffer: 1 << 26 }, (err, stdout) => {
    fs.rmSync(profile, { recursive: true, force: true });
    if (err && !stdout) return reject(err);
    resolve(stdout);
  });
});
const measure = async (site, query, width) => {
  const dom = await run(`http://127.0.0.1:${site.address().port}/?${query}`, width, ['--dump-dom']);
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  assert.ok(m && m[1].trim(), 'the fixture reported nothing: ' + dom.slice(0, 300));
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
};
const SKIP = CHROME ? false : 'no Chromium-family browser found';

test('push: the page is narrowed by the drawer width, fixed elements clear the drawer, and close restores every style byte for byte', { skip: SKIP, timeout: 120000 }, async () => {
  const site = await serve();
  try {
    const r = await measure(site, 'case=late', 1200);
    const W = r.panel.width, edge = r.vw - W;
    assert.equal(r.layoutNow, 'push');
    assert.ok(W >= 320 && W <= 600, 'the drawer has a width: ' + W);
    assert.ok(Math.abs(r.articleBefore - r.article - W) < 1, `the article is ${W}px narrower while open (${r.articleBefore} -> ${r.article})`);
    assert.ok(r.toggle.right <= edge + 0.5, `the right-anchored toggle is fully left of the drawer (right ${r.toggle.right} <= ${edge})`);
    assert.ok(r.toggle.left >= 0 && r.toggle.width === 56, 'and is still the same size, on screen');
    assert.ok(r.plain.right <= edge + 0.5, 'a fixed box from a stylesheet (right:0) clears the drawer too');
    assert.ok(r.bar.right <= edge + 0.5 && r.bar.left === 0, 'the full-width fixed bar is narrowed to end at the drawer, not shifted');
    assert.ok(r.late && r.late.right <= edge + 0.5, 'a fixed element added after opening is moved as well');
    assert.deepEqual(r.after, r.before, 'after close: the root, the toggle, the bar and the box have exactly the style attributes they had (byte for byte)');
    assert.equal(r.lateAfter, null, 'the element added while open has no style attribute again');
    assert.ok(Math.abs(r.articleAfter - r.articleBefore) < 0.5, 'the page is its old width again');
    assert.notDeepEqual(r.during, r.before, 'sanity: the push did write something while open');
  } finally { site.close(); }
});

test('overlay: the page is left exactly as it was while the drawer is open', { skip: SKIP, timeout: 120000 }, async () => {
  const site = await serve();
  try {
    const r = await measure(site, 'layout=overlay', 1200);
    assert.equal(r.layoutNow, 'overlay');
    assert.ok(Math.abs(r.articleBefore - r.article) < 0.5, 'the article keeps its width');
    assert.deepEqual(r.during, r.before, 'no style was written on the page');
    assert.ok(r.toggle.right > r.vw - r.panel.width, 'and the toggle is under the drawer (what overlay means)');
  } finally { site.close(); }
});

test('a window narrower than the drawer + 320 px falls back to overlay: the page is untouched', { skip: SKIP, timeout: 120000 }, async () => {
  const site = await serve();
  try {
    const r = await measure(site, 'x=1', 600);
    assert.equal(r.layoutNow, 'overlay');
    assert.deepEqual(r.during, r.before);
    assert.ok(Math.abs(r.articleBefore - r.article) < 0.5);
  } finally { site.close(); }
});

test('widening the drawer while open moves the page and the fixed elements with it', { skip: SKIP, timeout: 120000 }, async () => {
  const site = await serve();
  try {
    const r = await measure(site, 'case=drag', 1400);
    assert.ok(r.panel2.width > r.panel.width, 'the drawer is wider: ' + r.panel.width + ' -> ' + r.panel2.width);
    assert.ok(Math.abs(r.articleBefore - r.article2 - r.panel2.width) < 1, 'the page follows the new width ' + JSON.stringify(r));
    assert.ok(r.toggle2.right <= r.vw - r.panel2.width + 0.5, 'and the toggle clears the wider drawer');
    assert.deepEqual(r.after, r.before);
  } finally { site.close(); }
});
