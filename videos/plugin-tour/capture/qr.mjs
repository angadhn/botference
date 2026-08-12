// The QR code on the end card.
//
// Generated, never drawn: `qrcode` encodes the url and this writes the PNG into
// footage/ (Remotion's public dir) so the composition can reach it through
// staticFile. Light-on-dark to sit on the closing card, error correction M, and
// a four-module quiet zone — which is not decoration, it is part of the symbol:
// a QR printed hard against other ink is a QR a phone cannot find.
//
// The only proof that any of this worked is a decode, and the decode is done at
// the end of the pipeline against a still pulled out of the FINISHED mp4
// (capture/verify-qr.mjs), not against this file.
//
//   node capture/qr.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const QR_URL = 'https://botference.com';
const OUT = path.join(ROOT, 'footage', 'qr.png');

// 1024px so the card can draw it at any size up to full-bleed without
// resampling artefacts eating the modules. `margin` is in MODULES, not pixels.
await QRCode.toFile(OUT, QR_URL, {
  errorCorrectionLevel: 'M',
  margin: 4,
  width: 1024,
  color: { dark: '#f2f6faff', light: '#070a0eff' },
});

const { width, height } = { width: 1024, height: 1024 };
console.log(`qr -> ${path.relative(ROOT, OUT)}  ${width}x${height}  ${QR_URL}`);
if (!fs.existsSync(OUT)) throw new Error('qrcode wrote nothing');
