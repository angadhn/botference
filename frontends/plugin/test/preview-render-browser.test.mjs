// preview-render-browser.test.mjs — the picture of a draft, made by a REAL headless browser (throwaway profile) from a fixture page
// served on 127.0.0.1: cropped to the post's element, at 2x, JavaScript off, and nothing fetched from any other origin.
//
//   node --test frontends/plugin/test/preview-render-browser.test.mjs      (skipped when no Chromium is found; set BOTFERENCE_CHROME)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { renderPreview, findChrome, WIDTH_CSS, DPR } from '../preview-render.mjs';

const CHROME = findChrome();
const serve = handler => new Promise(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const pngSize = buf => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

test('a real headless render: cropped to the post, 2x, scripts off, other hosts blocked, a missing page is "missing"', { skip: CHROME ? false : 'no Chromium found', timeout: 90000 }, async () => {
  let otherHits = 0;
  const other = await serve((req, res) => { otherHits++; res.writeHead(200, { 'content-type': 'image/png' }).end(); });
  const otherOrigin = `http://127.0.0.1:${other.address().port}`;
  let scriptRan = 0;
  const site = await serve((req, res) => {
    if (req.url === '/ran') { scriptRan++; res.writeHead(204).end(); return; }
    if (req.url === '/b/attr') { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><style>article{height:60px;background:#fff}[data-theme=dark] article{background:#000}</style></head><body><article>x</article></body></html>'); return; }
    if (req.url !== '/b/0abc') { res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><p>no such page</p>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><meta name="viewport" content="width=device-width">
      <link rel="stylesheet" href="${otherOrigin}/evil.css"><style>body{margin:0;background:#fff}header{height:300px;background:#f00}article{margin:20px;height:150px;background:#0a0}
      @media (prefers-color-scheme: dark){article{background:#00a}}</style></head>
      <body><header>site chrome</header><article><p>The post.</p><img src="${otherOrigin}/pixel.png" width="1" height="1"></article>
      <script>fetch('/ran');document.body.innerHTML='replaced';</script></body></html>`);
  });
  const base = `http://127.0.0.1:${site.address().port}`;
  try {
    const r = await renderPreview({ chrome: CHROME, url: `${base}/b/0abc`, selector: 'article', theme: 'light' });
    assert.equal(r.state, 'ready', r.why);
    const { w, h } = pngSize(r.png);
    assert.deepEqual([w, h], [(WIDTH_CSS - 40) * DPR, 150 * DPR], 'cropped to the article, at 2x (the header is not in it)');
    assert.equal(otherHits, 0, 'nothing was fetched from another origin (a stylesheet and an image were asked for)');
    assert.equal(scriptRan, 0, 'the page\'s script never ran');
    const dark = await renderPreview({ chrome: CHROME, url: `${base}/b/0abc`, selector: 'article', theme: 'dark' });
    assert.equal(dark.state, 'ready');
    assert.notEqual(Buffer.compare(dark.png, r.png), 0, 'the drawer\'s theme reaches the page (prefers-color-scheme)');
    // a site that picks its theme with a script and an attribute on <html>: the renderer sets the attribute itself (scripts stay off)
    const attr = await renderPreview({ chrome: CHROME, url: `${base}/b/attr`, selector: 'article', theme: 'dark', themeAttribute: 'data-theme' });
    const plain = await renderPreview({ chrome: CHROME, url: `${base}/b/attr`, selector: 'article', theme: 'dark' });
    assert.equal(attr.state, 'ready', attr.why);
    assert.notEqual(Buffer.compare(attr.png, plain.png), 0, 'data-theme="dark" was set without any page script');
    assert.equal((await renderPreview({ chrome: CHROME, url: `${base}/b/nope`, selector: 'article' })).state, 'missing', 'not there yet: missing (asked again by the caller)');
    assert.equal((await renderPreview({ chrome: CHROME, url: `${base}/b/0abc`, selector: 'main.nothing' })).state, 'missing');
    assert.equal((await renderPreview({ chrome: '', url: `${base}/b/0abc`, selector: 'article' })).state, 'unavailable', 'no browser: unavailable');
    assert.equal((await renderPreview({ chrome: CHROME, url: 'file:///etc/passwd', selector: 'article' })).state, 'unavailable', 'only http(s)');
  } finally { site.close(); other.close(); }
});
