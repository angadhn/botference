// What is falling off the edge of every framing.
//
// The failure this catches is specific and it cost a render to find: a camera
// whose origin is a whisker inside the clamp does not sit flush against the
// source's edge — it leaves the last few pixels of the source OUTSIDE the frame.
// On a page that is nothing, because the page has margins. On the drawer it is
// the Send button sliced in half down the right-hand edge of the film.
//
// So for every camera key in edit.json and loop.json this prints how much of the
// source is off each side, and how much of the DRAWER's own width (source x
// 1500..1920 at 1.0) survives. A framing may lose the top and bottom of the
// drawer — it is taller than the frame and always will be — but a framing that
// keeps a THIN VERTICAL SLIVER of it down the right-hand edge is always wrong:
// either the drawer is in the shot or it is not. Under 55% and not zero is the
// flag. Framings from before the drawer opened, and clips it never appears in,
// are exempt, and that is read off the shoot rather than listed here.
//
//   node capture/frame-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MAX_SCALE = 1.55;                  // src/Camera.tsx
const DRAWER_X = [1500, 1920];           // the drawer's own columns at scale 1.0

function window1d(size, view, s, o) {
  const half = Math.min(0.5, view / size / (2 * s));
  const c = Math.min(Math.max(o, half), 1 - half);
  return { from: c * size - view / (2 * s), to: c * size + view / (2 * s), clamped: c !== o };
}

function audit(file, label, scenes, drawW, drawH, viewW, viewH, drawerUp) {
  console.log(`\n=== ${label} (${file})`);
  let bad = 0;
  for (const sc of scenes) {
    for (const k of sc.camera || []) {
      const s = Math.min(k.scale, MAX_SCALE);
      const X = window1d(drawW, viewW, s, k.origin[0]);
      const Y = window1d(drawH, viewH, s, k.origin[1]);
      const lostL = Math.max(0, X.from), lostR = Math.max(0, drawW - X.to);
      const lostT = Math.max(0, Y.from), lostB = Math.max(0, drawH - Y.to);
      // how much of the drawer's own width is on screen
      const dw = [DRAWER_X[0] * drawW / 1920, DRAWER_X[1] * drawW / 1920];
      const seen = Math.max(0, Math.min(X.to, dw[1]) - Math.max(X.from, dw[0]));
      const pct = seen / (dw[1] - dw[0]);
      const note = [];
      if (drawerUp(sc) && pct > 0.001 && pct < 0.55) {
        note.push(`DRAWER SLIVER: only ${(pct * 100).toFixed(0)}% of it in frame`);
        bad++;
      }
      if (X.clamped || Y.clamped) note.push('origin clamped');
      console.log(
        `  ${sc.id.padEnd(12)} @${String(k.at).padStart(4)}  s=${k.scale.toFixed(2)}`
        + `  origin=[${k.origin[0]}, ${k.origin[1]}]`
        + `  off-frame L${lostL.toFixed(0)} R${lostR.toFixed(0)} T${lostT.toFixed(0)} B${lostB.toFixed(0)}`
        + `  drawer ${(pct * 100).toFixed(0)}%`
        + (note.length ? `   <-- ${note.join(', ')}` : ''));
    }
  }
  return bad;
}

const edit = JSON.parse(fs.readFileSync(path.join(ROOT, 'edit.json'), 'utf8'));
const loop = JSON.parse(fs.readFileSync(path.join(ROOT, 'loop.json'), 'utf8'));

// When is the drawer on screen at all? It is open from the frame the shoot
// marked `drawer-open` to the end of the thread take, and it appears in no other
// clip. A scene whose window closes before that mark is framing a bare page and
// cannot be sliced.
const shots = JSON.parse(fs.readFileSync(path.join(ROOT, 'footage/shots.json'), 'utf8')).shots;
const OPENS = (shots.thread.marks.find(m => m.label === 'drawer-open') || {}).frame ?? 0;
const drawerUp = sc => /thread\.mp4$/.test(sc.clip || '')
  && (sc.inFrame || 0) + sc.durationInFrames > OPENS;

let bad = audit('edit.json', 'the film', edit.scenes,
  edit.meta.width, edit.meta.height, edit.meta.width, edit.meta.height, drawerUp);

// the loop draws the 16:9 take at the loop's own height and crops the sides
const DRAW_H = loop.meta.height;
const DRAW_W = Math.round((DRAW_H * 16) / 9);
bad += audit('loop.json', 'the site loop', loop.beats,
  DRAW_W, DRAW_H, loop.meta.width, loop.meta.height, drawerUp);

console.log(bad ? `\n${bad} framing(s) show a sliver of the drawer.`
  : '\nno framing shows a sliver of the drawer.');
process.exit(bad ? 1 : 0);
