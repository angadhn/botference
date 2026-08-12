// Mirror the real page the film is shot on.
//
// v4 is filmed on the user's OWN blog post — https://angadh.com/whereVonBraunWheel
// — and "faithful" here does not mean "a recreation that looks close". It means
// the bytes: this loads the live page in the same browser engine the shoot uses,
// saves every same-origin response it made to disk under the SAME path the site
// serves it from, and writes out the post-JavaScript DOM of the nav and the
// article. capture/page.mjs then reads that file, and capture/serve.mjs serves
// capture/site/ as the site's own docroot, so the page under the drawer during
// the take is the site's own markup, the site's own 84KB stylesheet, the site's
// own ET Book and Aniron faces and the site's own figures.
//
// Two rewrites are made, both because the shoot has no network:
//   - the external-link favicons. assets/js/favicon-loader.js sets a
//     --favicon-url custom property on every outbound link, pointing at
//     google.com/s2/favicons. Those icons are fetched here and saved under
//     /favicons/<domain>.png, and the inline property is rewritten to the local
//     path — so the little icons the live page shows are the ones the film
//     shows, rather than eleven empty boxes.
//   - the scripts. A mirrored page must not run supabase, plotly or giscus, and
//     the ones that only decorate (heading anchors, mobile TOC) are noise in a
//     film. Every <script> is dropped, and the only behaviour worth keeping —
//     the scroll-progress bar along the top, which the film's scroll beat moves
//     — is reinstated by page.mjs in eleven lines.
//
// It also leaves reference-*.png behind: the live page as this browser drew it,
// so the mirror can be compared against the original rather than trusted.
//
//   node capture/mirror-site.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = path.join(HERE, 'site');
const PAGE_URL = 'https://angadh.com/whereVonBraunWheel';
const ORIGIN = 'https://angadh.com';

const saved = [];
const failed = [];

// The one third-party origin the picture depends on. The post's stylesheet
// draws the little mark after every outbound link — a Wikipedia W, a red PDF
// page, a bird — as a Font Awesome glyph, so without the CDN's stylesheet and
// its webfonts the article renders eleven tidy squares where the live page has
// icons. Mirrored under /cdn/<path>, which is where the harness then links it.
const CDN = 'https://cdnjs.cloudflare.com';

function outPath(url) {
  const u = new URL(url);
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  if (url.startsWith(CDN)) rel = path.join('cdn', rel);
  return path.join(SITE_DIR, rel);
}

async function main() {
  fs.rmSync(SITE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SITE_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const page = await ctx.newPage();

  // Everything the page fetches from its own origin is written to disk exactly
  // where the site serves it, so the local docroot IS the site's docroot.
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.startsWith(ORIGIN) && !url.startsWith(CDN)) return;
    if (!res.ok()) { failed.push(`${res.status()} ${url}`); return; }
    try {
      const buf = await res.body();
      const file = outPath(url);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      saved.push(`${path.relative(SITE_DIR, file)}  ${buf.length}`);
    } catch (e) { failed.push(`body ${url}: ${e.message}`); }
  });

  console.log(`loading ${PAGE_URL} …`);
  await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(4000);            // favicon-loader + fonts settle

  // Media is streamed, and CDP will not hand back the body of a response it
  // streamed — so the wine-tasting clip in the margin, which the film scrolls
  // straight past, arrives as an error rather than as bytes. Fetch it plainly.
  for (const src of await page.$$eval('video source, video[src]',
    els => els.map(e => e.src).filter(Boolean))) {
    if (!src.startsWith(ORIGIN)) continue;
    const r = await ctx.request.get(src);
    if (!r.ok()) { failed.push(`media ${src}: ${r.status()}`); continue; }
    const file = outPath(src);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = await r.body();
    fs.writeFileSync(file, buf);
    saved.push(`${path.relative(SITE_DIR, file)}  ${buf.length}`);
  }

  // ---- the reference frames -----------------------------------------------
  await page.screenshot({ path: path.join(SITE_DIR, 'reference-top.png') });
  await page.evaluate(() => window.scrollTo(0, 2400));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SITE_DIR, 'reference-passage.png') });
  await page.evaluate(() => window.scrollTo(0, 0));

  // ---- the favicons the loader script resolved ----------------------------
  const domains = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      const v = a.style.getPropertyValue('--favicon-url');
      const m = /domain=([^&'")]+)/.exec(v || '');
      if (m) out.push(m[1]);
    }
    return [...new Set(out)];
  });
  fs.mkdirSync(path.join(SITE_DIR, 'favicons'), { recursive: true });
  for (const d of domains) {
    const u = `https://www.google.com/s2/favicons?domain=${d}&size=32`;
    try {
      const r = await ctx.request.get(u);
      if (!r.ok()) { failed.push(`favicon ${d}: ${r.status()}`); continue; }
      fs.writeFileSync(path.join(SITE_DIR, 'favicons', `${d}.png`), await r.body());
    } catch (e) { failed.push(`favicon ${d}: ${e.message}`); }
  }
  console.log(`  favicons: ${domains.length} domains`);

  // ---- the markup, after the page's own scripts have had their say --------
  const html = await page.evaluate(() => {
    // rewrite the loader's remote favicon urls to the local mirror
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      const v = a.style.getPropertyValue('--favicon-url');
      const m = /domain=([^&'")]+)/.exec(v || '');
      if (m) a.style.setProperty('--favicon-url', `url('/favicons/${m[1]}.png')`);
    }
    const nav = document.querySelector('nav');
    const main = document.querySelector('main');
    const pick = (el) => {
      const c = el.cloneNode(true);
      // no script runs in the mirror: the ones that matter to the picture are
      // reinstated by page.mjs, the rest need a network and a login
      c.querySelectorAll('script, noscript, iframe#giscus, .giscus').forEach(n => n.remove());
      return c.outerHTML;
    };
    return { nav: pick(nav), main: pick(main), title: document.title.trim() };
  });

  fs.writeFileSync(path.join(SITE_DIR, 'article.html'), `${html.nav}\n${html.main}\n`);
  fs.writeFileSync(path.join(SITE_DIR, 'mirror.json'), JSON.stringify({
    url: PAGE_URL, title: html.title, fetched: new Date().toISOString(),
    files: saved.length, favicons: domains, failed,
  }, null, 2));

  await browser.close();
  console.log(`\n${saved.length} files -> capture/site/`);
  for (const s of saved) console.log('  ', s);
  if (failed.length) { console.log('\nnot mirrored:'); for (const f of failed) console.log('  ', f); }
  console.log(`\ntitle: ${html.title}`);
  console.log(`article.html: ${(html.nav.length + html.main.length) / 1024 | 0} KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
