// Scratch probe: load the patched harness in each mode the film needs, dump the
// selectors that matter, and leave a screenshot to read. Not part of the render.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { installCursor, moveTo, sleep } from './rig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../out/probe');
const plotDataUrl = 'data:image/png;base64,' +
  fs.readFileSync(path.resolve(HERE, 'fixtures/figure-01.png')).toString('base64');

const { server, base } = await startServer({ plotDataUrl });
const browser = await chromium.launch({ headless: true, args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
fs.mkdirSync(OUT, { recursive: true });

const modes = process.argv.slice(2).length ? process.argv.slice(2)
  : ['closed=1', 'run=fresh&chat=1', 'crowded=1', 'export=1'];

for (const q of modes) {
  const page = await ctx.newPage();
  await page.goto(`${base}/test/harness.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__bfp && window.__bfp.drawer, null, { timeout: 15000 }).catch(() => {});
  await sleep(2500);
  await installCursor(page);
  await moveTo(page, 700, 520, 0);
  const info = await page.evaluate(() => {
    const d = window.__bfp && window.__bfp.drawer;
    const S = d && d.shadow;
    const list = sel => [...(S ? S.querySelectorAll(sel) : [])].map(e => ({
      cls: e.className, text: (e.textContent || '').trim().slice(0, 60),
    }));
    return {
      open: d ? d.isOpen() : null,
      log: (document.getElementById('h-log') || {}).textContent,
      cards: list('.card').length,
      acts: [...new Set([...(S ? S.querySelectorAll('[data-act]') : [])].map(e => e.getAttribute('data-act')))],
      tabs: list('.tab'),
      runbtn: list('[data-act="run"]'),
      runstat: list('.runstat'),
      marks: [...document.querySelectorAll('mark.bfp-hl')].map(m => m.className),
      selbtn: !!(S && S.querySelector('.selbtn')),
      topClasses: S ? [...S.firstElementChild.children].map(e => e.className) : null,
      cursorLast: document.documentElement.lastElementChild.id,
    };
  });
  const name = q.replace(/[^a-z0-9]+/gi, '_');
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('---', q, '\n', JSON.stringify(info).slice(0, 1400));
  await page.close();
}

await browser.close();
server.close();
