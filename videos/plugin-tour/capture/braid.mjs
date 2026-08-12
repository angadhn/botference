// The braid, lifted from the site rather than re-drawn.
//
// site/index.html carries the hero as an inline <svg class="braid"> — 34 woven
// over/under segments plus emitters, graticule, comet layers and the "the plan"
// fuse — animated entirely in CSS. Re-implementing that in React would be a
// second copy of the artwork that could drift from the real one. So this pulls
// the <style> block and the <svg> straight out of the page and stands them on
// the site's own dark ground; capture.mjs then films it exactly like any other
// take, and the Remotion comp sets the type over the top.
//
// One clip serves both ends of the film: the cold open runs it from frame 0
// (the strands writing themselves in), the close enters near the fuse, where
// the three strands converge and "the plan" wipes out to the cursor. Which
// in-point each uses is edit.json's business, not this file's.
//
//   node capture/braid.mjs      -> footage/braid.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SITE = path.resolve(ROOT, '../../site/index.html');

const src = fs.readFileSync(SITE, 'utf8');

const style = /<style>([\s\S]*?)<\/style>/.exec(src);
if (!style) throw new Error('site/index.html: no <style> block');

const a = src.indexOf('<svg class="braid"');
const b = src.indexOf('</svg>', a);
if (a < 0 || b < 0) throw new Error('site/index.html: no <svg class="braid">');
const svg = src.slice(a, b + 6);

// The page's own palette, copied from the :root block it defines, so the ground
// under the braid is the site's ground and not an approximation of it.
const html = `<!doctype html><meta charset="utf-8"><title>braid</title>
<style>
${style[1]}
</style>
<style>
  html, body { margin:0; height:100%; background:var(--bg); overflow:hidden; }
  .stage { display:grid; place-items:center; height:100vh; }
  /* the hero is 1200x340 in user units; 1560 across leaves the lower third of
     frame clear, which is where the title card's type lands */
  .stage .art { width:1560px; max-width:none; margin:0; padding:0;
                transform: translateY(-40px); }
</style>
<div class="stage"><div class="art">
${svg}
</div></div>
`;

fs.mkdirSync(path.join(ROOT, 'footage'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'footage', 'braid.html'), html);
console.log('-> footage/braid.html  (svg %d bytes, style %d bytes)', svg.length, style[1].length);
