// make-icons.mjs — regenerate icon16/48/128.png with zero dependencies.
//
//   node frontends/plugin/extension/icons/make-icons.mjs
//
// The mark: a #d97757 rounded square (botference accent) carrying three text
// lines, the middle one struck through with the highlighter yellow used by
// mark.bfp-hl in the page. Legible at 16px because it is only three bars.
// Rendered at 4x and box-filtered down, so the corners and bar edges are
// antialiased without any imaging library.

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const SS = 4; // supersample factor

const ACCENT = [217, 119, 87];
const CREAM = [250, 247, 240];
const HIGHLIGHT = [250, 210, 80];

// Bars in normalized [0,1] coords: [x0, x1, y0, y1, color]
const BARS = [
  [0.22, 0.78, 0.28, 0.395, CREAM],
  [0.17, 0.83, 0.50, 0.70, HIGHLIGHT],
  [0.22, 0.62, 0.775, 0.875, CREAM],
];

const inRounded = (x, y, r) => {
  // rounded unit square inset by 0.055 with corner radius r
  const i = 0.055, lo = i, hi = 1 - i;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r + 1e-9;
};

function sampleAt(x, y) {
  if (!inRounded(x, y, 0.19)) return null;
  for (const [x0, x1, y0, y1, c] of BARS) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return c;
  }
  return ACCENT;
}

function render(size) {
  const px = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sampleAt((pxx + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS, o = (py * size + pxx) * 4;
      const hit = a / 255;
      px[o] = hit ? Math.round(r / hit) : 0;
      px[o + 1] = hit ? Math.round(g / hit) : 0;
      px[o + 2] = hit ? Math.round(b / hit) : 0;
      px[o + 3] = Math.round(a / n);
    }
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

for (const size of [16, 48, 128]) {
  const file = path.join(OUT, `icon${size}.png`);
  fs.writeFileSync(file, png(size, render(size)));
  console.log('wrote:', file);
}
