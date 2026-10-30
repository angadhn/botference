// Packs the city art into one WebP sprite sheet with a JSON atlas, small enough to ride inside
// network.js (the servers serve only network.js and network.css).
//   node art/pack.mjs [--scale 0.5] [--quality 82] [--debug out.png]
// Every sprite is downscaled from its 128×64-tile size in manifest.json by one common `scale`
// (0.5 gives the 64×32 world tile the city is drawn in), packed on shelves with a gap so
// neighbours never bleed, and encoded with ImageMagick 7. For each upright sprite the atlas also
// records an outline (for hovering and clicking the building, not its transparent box). Paused and
// archived buildings use their own shuttered drawings, so nothing is drawn over the windows.
// Agent sprites (category `agent`) are cut down to their painted pixels after the downscale, with
// the anchor moved by the same amount, so a body, its role overlay and every walk frame still land
// on one ground point; the atlas keeps their family, pose, direction, frame and badge offset.
// Writes art/art-sheet.js and splices the same text into network.js between its ART markers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SCALE = Number(arg('scale', 0.5)), BUDGET = 1.5 * 1024 * 1024, GAP = 2, SHEET_W = 2048;
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const magick = (args, input) => execFileSync('magick', args, { input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'ignore'] });

// ── downscale ──
const sprites = manifest.sprites.map(s => {
  const w = Math.max(1, Math.round(s.sizePx[0] * SCALE)), h = Math.max(1, Math.round(s.sizePx[1] * SCALE));
  const px = magick([path.join(here, s.file), '-filter', 'Lanczos', '-resize', `${w}x${h}!`, '-depth', '8', 'rgba:-']);
  return s.category === 'agent' ? trim({ ...s, w, h, px }) : { ...s, w, h, px };
});

// ── trim to the painted pixels (any alpha), one pixel of margin; ox/oy is the cut, in sheet pixels ──
function trim(s) {
  const { w, h, px } = s; let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3]) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  if (r < 0) return { ...s, ox: 0, oy: 0 };
  l = Math.max(0, l - 1); t = Math.max(0, t - 1); r = Math.min(w - 1, r + 1); b = Math.min(h - 1, b + 1);
  const tw = r - l + 1, th = b - t + 1, out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) px.copy(out, y * tw * 4, ((t + y) * w + l) * 4, ((t + y) * w + r + 1) * 4);
  return { ...s, w: tw, h: th, px: out, ox: l, oy: t };
}

// ── outline: the opaque silhouette as a polygon, top edge left to right then bottom edge back ──
function outline({ w, h, px }, step) {
  const top = [], bot = [], A = (x, y) => px[(y * w + x) * 4 + 3];
  for (let x0 = 0; x0 < w; x0 += step) {
    let t = h, b = -1;
    for (let x = x0; x < Math.min(w, x0 + step); x++) for (let y = 0; y < h; y++) if (A(x, y) > 96) { if (y < t) t = y; if (y > b) b = y; }
    if (b < 0) continue;
    const xm = Math.min(w, x0 + step); top.push([x0, t], [xm, t]); bot.push([xm, b + 1], [x0, b + 1]);
  }
  return [...top, ...bot.reverse()].flat();
}

// ── pack on shelves, tallest first ──
const order = [...sprites].sort((a, b) => b.h - a.h || b.w - a.w);
let x = GAP, y = GAP, shelf = 0;
for (const s of order) {
  if (x + s.w + GAP > SHEET_W) { x = GAP; y += shelf + GAP; shelf = 0; }
  s.x = x; s.y = y; x += s.w + GAP; shelf = Math.max(shelf, s.h);
}
const SHEET_H = y + shelf + GAP, sheet = Buffer.alloc(SHEET_W * SHEET_H * 4);
for (const s of sprites) for (let r = 0; r < s.h; r++) s.px.copy(sheet, ((s.y + r) * SHEET_W + s.x) * 4, r * s.w * 4, (r + 1) * s.w * 4);

let quality = Number(arg('quality', 82)), webp;
for (;;) {
  webp = magick(['-size', `${SHEET_W}x${SHEET_H}`, '-depth', '8', 'rgba:-', '-quality', String(quality), '-define', 'webp:alpha-quality=70', '-define', 'webp:method=6', 'webp:-'], sheet);
  if (Math.ceil(webp.length / 3) * 4 < BUDGET - 64 * 1024 || quality <= 40) break;
  quality -= 2;
}

const r1 = v => Math.round(v * 10) / 10;
const atlas = {
  scale: SCALE, tile: [manifest.tile.width * SCALE, manifest.tile.height * SCALE], size: [SHEET_W, SHEET_H],
  sprites: Object.fromEntries(sprites.map(s => [s.id, {
    cat: s.category, x: s.x, y: s.y, w: s.w, h: s.h, ax: r1(s.anchorPx[0] * SCALE - (s.ox || 0)), ay: r1(s.anchorPx[1] * SCALE - (s.oy || 0)), fp: s.footprintTiles,
    ...(s.category === 'building' ? { hit: outline(s, Math.max(4, Math.round(s.w / 22))) } : {}),
    // where a route attaches to a floating planet (its tether), in sheet pixels like ax/ay
    ...(s.routeAnchorPx ? { rx: r1(s.routeAnchorPx[0] * SCALE), ry: r1(s.routeAnchorPx[1] * SCALE) } : {}),
    // an agent: kind body|overlay|badge; a body's family, pose, direction (sw se nw ne) and walk frame;
    // an overlay's role; a badge's status and where it sits from the ground point, in sheet pixels
    ...(s.category === 'agent' ? {
      kind: s.agentKind, ...(s.family ? { fam: s.family } : {}), ...(s.pose ? { pose: s.pose } : {}), ...(s.direction ? { dir: s.direction } : {}),
      ...(s.frame ? { frame: s.frame } : {}), ...(s.role ? { role: s.role } : {}), ...(s.status ? { status: s.status } : {}),
      ...(s.attachOffsetPx ? { bx: r1(s.attachOffsetPx[0] * SCALE), by: r1(s.attachOffsetPx[1] * SCALE) } : {}),
    } : {}),
  }])),
  ...(manifest.agents ? { agents: { frameMs: manifest.agents.animation.frameDurationMs, frames: manifest.agents.animation.order.length, dirs: Object.keys(manifest.agents.directions) } } : {}),
};
const b64 = webp.toString('base64');
const text = `// generated by art/pack.mjs from art/manifest.json: ${sprites.length} sprites at scale ${SCALE}, WebP quality ${quality}; do not edit by hand
const ART_ATLAS = ${JSON.stringify(atlas)};
const ART_SHEET = 'data:image/webp;base64,${b64}';
`;
fs.writeFileSync(path.join(here, 'art-sheet.js'), text);
const target = path.join(here, '..', 'network.js'), START = '// ── ART: the city sprite sheet ──', END = '// ── end ART ──';
const js = fs.readFileSync(target, 'utf8'), a = js.indexOf(START), b = js.indexOf(END);
if (a < 0 || b < a) throw new Error('network.js has no ART markers');
fs.writeFileSync(target, js.slice(0, a + START.length) + '\n' + text + js.slice(b));

const dbg = arg('debug');
if (dbg) { // the sheet with every building outline drawn on it, for checking by eye
  const draw = sprites.flatMap(s => atlas.sprites[s.id].hit ? ['-draw', `polygon ${atlas.sprites[s.id].hit.reduce((t, v, i) => t + (i % 2 ? `,${s.y + v} ` : `${s.x + v}`), '')}`] : []);
  magick(['-size', `${SHEET_W}x${SHEET_H}`, '-depth', '8', 'rgba:-', '-background', '#e9e4d8', '-flatten', '-fill', 'none', '-stroke', '#ff00aa', '-strokewidth', '1', ...draw, dbg], sheet);
}
console.log(`sheet ${SHEET_W}×${SHEET_H}, WebP q${quality}: ${(webp.length / 1024).toFixed(0)} KB, inlined as base64 ${(b64.length / 1024).toFixed(0)} KB (budget ${BUDGET / 1024} KB); atlas ${(JSON.stringify(atlas).length / 1024).toFixed(0)} KB`);
