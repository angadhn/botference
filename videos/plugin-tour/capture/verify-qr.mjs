// Does the QR in the finished film actually scan?
//
// Not "is the PNG valid" — that is never the failure. The failure is the film:
// a code scaled below its module size, sat on a fade, crushed by the h264
// encoder, or cropped by a camera move. So this pulls a frame OUT OF THE
// DELIVERABLE at the given timecode, decodes it with jsQR, and prints what the
// symbol says.
//
//   node capture/verify-qr.mjs [seconds]        default: the close card
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { run } from './rig.mjs';
import { QR_URL } from './qr.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VIDEO = path.join(ROOT, 'out/plugin-tour.mp4');

const edit = JSON.parse(fs.readFileSync(path.join(ROOT, 'edit.json'), 'utf8'));
const fps = edit.meta.fps;
const total = edit.scenes.reduce((n, s) => n + s.durationInFrames, 0);
const close = edit.scenes[edit.scenes.length - 1];
// two thirds of the way through the close: past the type-on, before the fade
const defaultAt = (total - close.durationInFrames + close.durationInFrames * 0.62) / fps;

const at = process.argv[2] ? Number(process.argv[2]) : defaultAt;
const tmp = path.join(ROOT, 'out', `.qr-check-${at.toFixed(2)}.png`);
await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', VIDEO,
  '-frames:v', '1', tmp]);

const png = PNG.sync.read(fs.readFileSync(tmp));
const res = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
fs.rmSync(tmp, { force: true });

if (!res) {
  console.error(`NO QR FOUND in ${path.basename(VIDEO)} @ ${at.toFixed(2)}s (${png.width}x${png.height})`);
  process.exit(1);
}
const ok = res.data === QR_URL;
console.log(`decoded @ ${at.toFixed(2)}s: ${JSON.stringify(res.data)}  ${ok ? 'MATCHES' : 'DOES NOT MATCH ' + QR_URL}`);
const c = res.location;
const side = Math.hypot(c.topRightCorner.x - c.topLeftCorner.x, c.topRightCorner.y - c.topLeftCorner.y);
console.log(`  symbol ${side.toFixed(0)}px across in a ${png.height}px frame`);
process.exit(ok ? 0 : 1);
