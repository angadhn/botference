// make-icons.mjs — regenerate the botference braid mark with zero dependencies.
//
//   node frontends/plugin/extension/icons/make-icons.mjs
//
// Writes:
//   icons/icon16.png icons/icon48.png icons/icon128.png   (extension)
//   icons/icon512.png                                      (master / press)
//   icons/braid.svg                                        (vector source)
//   site/favicon.png                                       (32px, browser tab)
//
// THE MARK — the braid. Three strands of light (claude orange, you green,
// codex blue) twist around one axis: the same rope that runs across the OG
// card, cropped square and full-bleed so it bleeds off the top and bottom
// edges. Full-bleed is the whole trick — it is why the mark still holds
// together at 16px, where a centred composition leaves half the tile empty
// and mushes its detail into the middle.
//
// The card carries the payoff (the rope fuses into one bright line and a
// block cursor: "the plan"). The tile deliberately does not: a cursor block
// inside a 16px square is one white blob, and inside a 512px square it turns
// the mark into a candle. The tile is the rope; the card is the sentence.
//
// Everything is analytic: strokes are stamped as discs with sub-pixel
// coverage, so there is no supersampling and no imaging library. Over/under
// is real — strand runs are depth-sorted and each near run is laid on a dark
// casing so it visibly passes in front.
//
// Small sizes are NOT a downscale of the master. At 16px a near-full turn of
// braid with bloom and hairline casings turns to grey mush, so the geometry
// is retuned per size: fewer turns (one crossing instead of two), much fatter
// strands, a wider swing so the weave reaches the tile edges, and almost no
// glow. See VARIANTS — that table is the icon design, not a detail.

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '../../../../site');

// ---- palette ---------------------------------------------------------------
const STRANDS = [
  { name: 'claude', rgb: [217, 119, 87],  core: [255, 227, 212], phase: -2 * Math.PI / 3 },
  { name: 'you',    rgb: [52, 211, 153],  core: [220, 255, 242], phase: 0 },
  { name: 'codex',  rgb: [74, 134, 200],  core: [216, 235, 255], phase: 2 * Math.PI / 3 },
];
const TILE_IN = [11, 17, 25];      // tile centre
const TILE_OUT = [4, 6, 10];       // tile rim
const CASING = [3, 5, 8];          // the dark sheath that makes over/under read

// ---- geometry, retuned per size -------------------------------------------
// All lengths normalized to the tile edge. `min` is the smallest icon size the
// row applies to; rows are tried largest-first.
const VARIANTS = [
  // 128 / 512 — the full braid: nearly a whole turn, two clean crossings,
  // thin strands, bloom and crossing flares.
  { min: 96, turns: 0.92, radius: 0.268, width: 0.070, casing: 0.030, glow: 1.00, hot: 1.00, flare: 1.00 },
  // 48 — three quarters of a turn, fatter strands, flares dialled back.
  { min: 33, turns: 0.70, radius: 0.272, width: 0.098, casing: 0.036, glow: 0.60, hot: 0.80, flare: 0.55 },
  // 16 / 32 — half a turn: ONE crossing, strands ~2px wide, a hairline casing
  // to keep them apart, a wider swing to fill the tile, no flares.
  { min: 0,  turns: 0.50, radius: 0.312, width: 0.126, casing: 0.018, glow: 0.22, hot: 0.45, flare: 0.00 },
];
const variantFor = (size) => VARIANTS.find((v) => size >= v.min);

// The axis: bottom edge to top edge, overshooting both so the rope is cut off
// by the tile rather than ending inside it.
const AX = [0.50, 1.07];
const BX = [0.50, -0.07];
const AXLEN = Math.hypot(BX[0] - AX[0], BX[1] - AX[1]);
const DIR = [(BX[0] - AX[0]) / AXLEN, (BX[1] - AX[1]) / AXLEN];
const PERP = [-DIR[1], DIR[0]];

// The rope breathes slightly wider through the middle of the tile.
const envelope = (t, R) => R * (0.94 + 0.06 * Math.sin(Math.PI * t));
const angle = (t, phase, turns) => 2 * Math.PI * turns * t + phase;

function strandPoint(t, s, v) {
  const th = angle(t, s.phase, v.turns);
  const off = envelope(t, v.radius) * Math.sin(th);
  return {
    x: AX[0] + (BX[0] - AX[0]) * t + PERP[0] * off,
    y: AX[1] + (BX[1] - AX[1]) * t + PERP[1] * off,
    z: Math.cos(th),                 // +1 nearest the viewer, -1 furthest
  };
}

// Split each strand into maximal near/far runs, then depth-sort: a run drawn
// later sits on top of everything behind it.
function buildRuns(v, N = 220) {
  const runs = [];
  for (const s of STRANDS) {
    let cur = [], sign = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = strandPoint(t, s, v);
      p.t = t;
      const sg = p.z >= 0 ? 1 : -1;
      if (sign === null) sign = sg;
      if (sg !== sign) { cur.push(p); runs.push({ pts: cur, s }); cur = [p]; sign = sg; }
      cur.push(p);
    }
    if (cur.length > 1) runs.push({ pts: cur, s });
  }
  for (const r of runs) r.z = r.pts.reduce((a, p) => a + p.z, 0) / r.pts.length;
  runs.sort((a, b) => a.z - b.z);
  return runs;
}

// Crossings: where two strands swap sides in projection. Each one flares.
function crossings(v, N = 900) {
  const out = [];
  for (let i = 0; i < STRANDS.length; i++) {
    for (let j = i + 1; j < STRANDS.length; j++) {
      let prev = null;
      for (let k = 0; k <= N; k++) {
        const t = k / N;
        const a = strandPoint(t, STRANDS[i], v);
        const b = strandPoint(t, STRANDS[j], v);
        const d = (a.x - b.x) * PERP[0] + (a.y - b.y) * PERP[1];
        if (prev !== null && prev * d < 0) {
          const p = strandPoint(t, STRANDS[i], v);
          out.push({ x: p.x, y: p.y, amp: envelope(t, v.radius) / v.radius, t });
        }
        prev = d;
      }
    }
  }
  return out;
}

// ---- raster plumbing -------------------------------------------------------
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function roundedRectCoverage(size) {
  // analytic coverage of a full-bleed rounded square
  const r = 0.215 * size, cov = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const qx = Math.min(Math.max(px, r), size - r);
      const qy = Math.min(Math.max(py, r), size - r);
      const d = Math.hypot(px - qx, py - qy);       // 0 in the straight parts
      cov[y * size + x] = clamp01(r - d + 0.5);
    }
  }
  return cov;
}

// Union-stamp a variable-width polyline into a coverage buffer.
function stampStroke(cov, size, pts, widthAt) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = a.x * size, ay = a.y * size, bx = b.x * size, by = b.y * size;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.4));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const cx = ax + (bx - ax) * u, cy = ay + (by - ay) * u;
      const rad = widthAt(a.z + (b.z - a.z) * u) * size / 2;
      const x0 = Math.max(0, Math.floor(cx - rad - 1)), x1 = Math.min(size - 1, Math.ceil(cx + rad + 1));
      const y0 = Math.max(0, Math.floor(cy - rad - 1)), y1 = Math.min(size - 1, Math.ceil(cy + rad + 1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const c = clamp01(rad - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5);
          if (c > 0) { const o = y * size + x; if (c > cov[o]) cov[o] = c; }
        }
      }
    }
  }
}

// Accumulate a soft gaussian bloom along a polyline.
function stampGlow(acc, size, pts, radius, gain) {
  const R = radius * size;
  for (let i = 0; i < pts.length - 1; i += 2) {
    const a = pts[i];
    const cx = a.x * size, cy = a.y * size;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(size - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(size - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R;
        if (d < 1) acc[y * size + x] += gain * Math.exp(-3.2 * d * d);
      }
    }
  }
}

function stampDot(acc, size, x, y, radius, gain) {
  const R = radius * size, cx = x * size, cy = y * size;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(size - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(size - 1, Math.ceil(cy + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R;
      if (d < 1) acc[y * size + x] += gain * Math.exp(-3.0 * d * d);
    }
  }
}

// ---- the render ------------------------------------------------------------
function render(size) {
  const v = variantFor(size);
  const n = size * size;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  const tile = roundedRectCoverage(size);

  // 1. tile: a faint radial lift so the mark has air behind it
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      const d = Math.min(1, Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.47) / 0.62);
      const k = Math.pow(d, 1.25);
      R[o] = TILE_IN[0] + (TILE_OUT[0] - TILE_IN[0]) * k;
      G[o] = TILE_IN[1] + (TILE_OUT[1] - TILE_IN[1]) * k;
      B[o] = TILE_IN[2] + (TILE_OUT[2] - TILE_IN[2]) * k;
    }
  }

  const add = (buf, col, gain) => {
    for (let o = 0; o < n; o++) {
      const a = 1 - Math.exp(-buf[o]);
      if (a > 0.001) {
        R[o] += col[0] * a * gain; G[o] += col[1] * a * gain; B[o] += col[2] * a * gain;
      }
    }
  };
  const over = (cov, col, alpha) => {
    for (let o = 0; o < n; o++) {
      const a = cov[o] * alpha;
      if (a > 0.002) {
        R[o] += (col[0] - R[o]) * a; G[o] += (col[1] - G[o]) * a; B[o] += (col[2] - B[o]) * a;
      }
    }
  };

  const runs = buildRuns(v);

  // 2. bloom underlay, one pass per strand colour
  if (v.glow > 0) {
    for (const s of STRANDS) {
      const pts = [];
      for (let i = 0; i <= 160; i++) { const t = i / 160; const p = strandPoint(t, s, v); p.t = t; pts.push(p); }
      const acc = new Float32Array(n);
      stampGlow(acc, size, pts, v.width * 2.6, 0.052 * v.glow);
      add(acc, s.rgb, 0.42);
    }
  }

  // 3. the braid itself: casing then colour, run by run, far to near
  for (const run of runs) {
    const near = (run.z + 1) / 2;                       // 0 far, 1 near
    const wOf = (z) => v.width * (0.80 + 0.30 * ((z + 1) / 2));
    if (near > 0.55 && v.casing > 0) {
      const cov = new Float32Array(n);
      stampStroke(cov, size, run.pts, (z) => wOf(z) + v.casing);
      over(cov, CASING, 0.95 * Math.min(1, (near - 0.55) / 0.28));
    }
    const cov = new Float32Array(n);
    stampStroke(cov, size, run.pts, wOf);
    over(cov, run.s.rgb, 0.62 + 0.38 * near);
    if (near > 0.62 && v.hot > 0) {
      const hc = new Float32Array(n);
      stampStroke(hc, size, run.pts, (z) => wOf(z) * 0.26);
      over(hc, run.s.core, Math.min(0.60, (near - 0.62) * 1.5) * v.hot);
    }
  }

  // 4. every crossing throws a spark
  if (v.flare > 0) {
    const acc = new Float32Array(n);
    for (const c of crossings(v)) {
      stampDot(acc, size, c.x, c.y, v.width * 1.5 * c.amp + v.width * 0.5, 0.30 * c.amp * v.flare);
    }
    add(acc, [255, 255, 255], 0.55);
  }

  // 5. out, masked by the tile
  const px = new Uint8Array(n * 4);
  for (let o = 0; o < n; o++) {
    px[o * 4] = Math.round(Math.min(255, Math.max(0, R[o])));
    px[o * 4 + 1] = Math.round(Math.min(255, Math.max(0, G[o])));
    px[o * 4 + 2] = Math.round(Math.min(255, Math.max(0, B[o])));
    px[o * 4 + 3] = Math.round(255 * tile[o]);
  }
  return px;
}

// ---- minimal PNG encoder ---------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- vector source, emitted from the same geometry -------------------------
function svg(size = 512) {
  const v = variantFor(size);
  const S = (n) => (n * size).toFixed(2);
  const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
  const runs = buildRuns(v, 160);
  const L = [];
  L.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`);
  L.push(`<title>botference — the braid</title>`);
  L.push(`<defs>
  <clipPath id="tile"><rect width="${size}" height="${size}" rx="${S(0.215)}"/></clipPath>
  <radialGradient id="bg" cx="50%" cy="47%" r="62%">
    <stop offset="0%" stop-color="${hex(TILE_IN)}"/><stop offset="100%" stop-color="${hex(TILE_OUT)}"/>
  </radialGradient>
  <filter id="bloom" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${S(v.width * 1.15)}"/></filter>
  <filter id="spark" x="-400%" y="-400%" width="900%" height="900%"><feGaussianBlur stdDeviation="${S(v.width * 0.42)}"/></filter>
</defs>`);
  L.push(`<g clip-path="url(#tile)">`);
  L.push(`<rect width="${size}" height="${size}" fill="url(#bg)"/>`);
  const pathOf = (pts) => 'M ' + pts.map((p) => `${S(p.x)} ${S(p.y)}`).join(' L ');
  L.push(`<g style="mix-blend-mode:screen" fill="none" stroke-linecap="round">`);
  for (const s of STRANDS) {
    const pts = [];
    for (let i = 0; i <= 160; i++) { const t = i / 160; const p = strandPoint(t, s, v); p.t = t; pts.push(p); }
    L.push(`  <path d="${pathOf(pts)}" stroke="${hex(s.rgb)}" stroke-width="${S(v.width * 1.5)}" stroke-opacity=".34" filter="url(#bloom)"/>`);
  }
  L.push(`</g>`);
  L.push(`<g fill="none" stroke-linecap="round" stroke-linejoin="round">`);
  for (const run of runs) {
    const near = (run.z + 1) / 2;
    const w = (p) => v.width * (0.80 + 0.30 * ((p.z + 1) / 2));
    // piecewise so the width can breathe with depth, casing before colour
    if (near > 0.55) {
      const a = 0.95 * Math.min(1, (near - 0.55) / 0.28);
      for (let i = 0; i < run.pts.length - 1; i++) {
        const p = run.pts[i], q = run.pts[i + 1];
        L.push(`  <line x1="${S(p.x)}" y1="${S(p.y)}" x2="${S(q.x)}" y2="${S(q.y)}" stroke="${hex(CASING)}" stroke-width="${S(w(p) + v.casing)}" stroke-opacity="${a.toFixed(2)}"/>`);
      }
    }
    const op = (0.62 + 0.38 * near).toFixed(2);
    for (let i = 0; i < run.pts.length - 1; i++) {
      const p = run.pts[i], q = run.pts[i + 1];
      L.push(`  <line x1="${S(p.x)}" y1="${S(p.y)}" x2="${S(q.x)}" y2="${S(q.y)}" stroke="${hex(run.s.rgb)}" stroke-width="${S(w(p))}" stroke-opacity="${op}"/>`);
    }
    if (near > 0.62) {
      const a = Math.min(0.85, (near - 0.62) * 2.2).toFixed(2);
      for (let i = 0; i < run.pts.length - 1; i++) {
        const p = run.pts[i], q = run.pts[i + 1];
        L.push(`  <line x1="${S(p.x)}" y1="${S(p.y)}" x2="${S(q.x)}" y2="${S(q.y)}" stroke="${hex(run.s.core)}" stroke-width="${S(w(p) * 0.34)}" stroke-opacity="${a}"/>`);
      }
    }
  }
  L.push(`</g>`);
  L.push(`<g style="mix-blend-mode:screen">`);
  for (const c of crossings(v)) {
    L.push(`  <circle cx="${S(c.x)}" cy="${S(c.y)}" r="${S(v.width * 1.5 * c.amp + v.width * 0.5)}" fill="#ffffff" opacity="${(0.42 * c.amp).toFixed(2)}" filter="url(#spark)"/>`);
  }
  L.push(`</g>`);
  L.push(`</g></svg>`);
  return L.join('\n');
}

// ---- write -----------------------------------------------------------------
for (const size of [16, 48, 128, 512]) {
  const file = path.join(HERE, `icon${size}.png`);
  fs.writeFileSync(file, png(size, render(size)));
  console.log('wrote:', file);
}
fs.writeFileSync(path.join(HERE, 'braid.svg'), svg(512) + '\n');
console.log('wrote:', path.join(HERE, 'braid.svg'));
if (fs.existsSync(SITE)) {
  const fav = path.join(SITE, 'favicon.png');
  fs.writeFileSync(fav, png(32, render(32)));
  console.log('wrote:', fav);
}
