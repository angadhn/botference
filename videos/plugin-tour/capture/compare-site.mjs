// Is the page the film is shot on the same page as the live one?
//
// capture/mirror-site.mjs saves the site's bytes; this checks that serving them
// through the harness reproduces the site's LAYOUT. It loads the live post and
// the patched harness side by side in the same engine at the same viewport and
// prints, for each element the camera actually sees, its position, width, font,
// size and colour — plus the height of the whole document, which is the single
// number that catches a stylesheet or a webfont having quietly failed to load.
//
// The pass condition is that the two columns are identical. When this was first
// run they were not: the harness's own `article { max-width: 40rem }` survived
// underneath the site's stylesheet (the cascade is per PROPERTY, and the site
// sets its column on <body>) and squeezed a 1030px measure into 450px. Nothing
// in a render would have said so.
//
//   node capture/compare-site.mjs         (needs a network — it fetches the live page)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { PAGE_URL } from './page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const plotDataUrl = 'data:image/png;base64,'
  + fs.readFileSync(path.join(HERE, 'fixtures/figure-01.png')).toString('base64');

/** Runs in the page: the geometry and typography of what the film frames. */
const probe = () => {
  const g = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.left), w: Math.round(r.width), y: Math.round(r.top + scrollY),
      font: cs.fontFamily.split(',')[0], size: cs.fontSize, color: cs.color,
    };
  };
  const p = [...document.querySelectorAll('content p')]
    .find(e => e.textContent.includes('This elegant solution'));
  const pr = p && p.getBoundingClientRect();
  return {
    body: g('body'),
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    h1: g('article h1'),
    h2: g('content h2'),
    figure: g('content figure img'),
    caption: g('content figcaption'),
    passage: pr ? { x: Math.round(pr.left), w: Math.round(pr.width), y: Math.round(pr.top + scrollY) } : null,
    docHeight: document.documentElement.scrollHeight,
  };
};

const browser = await chromium.launch({
  headless: true,
  args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'],
});
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'light',
});

const live = await ctx.newPage();
await live.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
await live.waitForTimeout(3000);
const A = await live.evaluate(probe);

const { server, base } = await startServer({ plotDataUrl });
const mirror = await ctx.newPage();
await mirror.goto(`${base}/test/harness.html?closed=1`, { waitUntil: 'load' });
await mirror.waitForTimeout(3000);
const B = await mirror.evaluate(probe);

let same = 0, diff = 0;
for (const k of Object.keys(A)) {
  const a = JSON.stringify(A[k]);
  const b = JSON.stringify(B[k]);
  const ok = a === b;
  ok ? same++ : diff++;
  console.log(`${ok ? '  ' : '!!'} ${k}`);
  console.log(`     live ${a}`);
  if (!ok) console.log(`      mir ${b}`);
}
await browser.close();
server.close();
console.log(`\n${same} identical, ${diff} different`);
// The one legitimate difference: the live page paints no background and sits on
// the browser's white canvas, while the mirror states that white explicitly
// (capture/page.mjs PAPER), because the harness would otherwise paint its own.
process.exit(diff > 1 ? 1 : 0);
