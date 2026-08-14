// Verification stills.
//
// A render that finished without an error has proved nothing about what is on
// screen — captions land over the wrong thing, a camera move frames an empty
// margin, a payoff arrives after its own scene has ended, and none of it raises
// so much as a warning. So the beats are pulled back out of the FINISHED file
// and read.
//
// The timecodes are not typed in. Each beat names a mark from
// footage/shots.json (the instant capture.mjs performed that action); this
// converts it to master-timeline seconds through the same inFrame/duration
// arithmetic the composition uses, so a still is by construction the frame the
// edit claims it is.
//
//   node capture/stills.mjs            -> out/stills/NN-scene-beat.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './rig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const edit = JSON.parse(fs.readFileSync(path.join(ROOT, 'edit.json'), 'utf8'));
const shots = JSON.parse(fs.readFileSync(path.join(ROOT, 'footage/shots.json'), 'utf8')).shots;
const FPS = edit.meta.fps;
const VIDEO = path.join(ROOT, 'out/plugin-tour.mp4');
const OUT = path.join(ROOT, 'out/stills');

// entry / action / payoff for every scene, as the storyboard asks. `mark` is a
// label from shots.json; `off` nudges by frames where the interesting frame is
// a beat after the action (a fade settling, a reply finishing).
// A 'label' beat is pulled at the middle of a label's own cue, because a label
// is the one thing in the film whose position is computed at render time from a
// measured box and a camera — so it is the one thing that has to be LOOKED at
// rather than trusted. It is added automatically for every labelled scene.
const BEATS = {
  hook:          [['entry', null, 6], ['action', null, 40], ['payoff', null, 100]],
  page:          [['entry', null, 4], ['action', 'scrolled', -40], ['payoff', 'scrolled', -4]],
  highlight:     [['entry', null, 4], ['action', 'drag-start', 20], ['payoff', 'selection-made', 10]],
  compose:       [['entry', null, 4], ['action', 'sent', -60], ['payoff', 'sent', -4]],
  'dial-claude': [['entry', null, 3], ['action', null, 30], ['payoff', null, 55]],
  claude:        [['entry', null, 4], ['action', 'claude-landed', 10], ['payoff', null, 190]],
  handoff:       [['entry', null, 4], ['action', null, 30], ['payoff', null, 65]],
  breathe:       [['entry', null, 4], ['action', null, 30], ['payoff', null, 54]],
  route:         [['entry', null, 4], ['action', 'sent-2', -40], ['payoff', 'sent-2', -2]],
  'dial-codex':  [['entry', null, 3], ['action', null, 30], ['payoff', null, 55]],
  codecell:      [['entry', null, 4], ['action', null, 50], ['payoff', null, 90]],
  run:           [['entry', null, 4], ['action', 'run-clicked', 8], ['payoff', 'figure-in', 20]],
  plot:          [['entry', null, 4], ['action', null, 60], ['payoff', null, 130]],
  resolve:       [['entry', null, 4], ['action', 'resolved', 6], ['payoff', 'filed', 25]],
  digest:        [['entry', null, 6], ['action', 'summarize', 8], ['payoff', 'summary-landed', 40]],
  green:         [['entry', null, 4], ['action', null, 60], ['payoff', null, 140]],
  export:        [['entry', null, 4], ['action', 'export-pick', 8], ['payoff', 'export-run', -8]],
  exported:      [['entry', null, 6], ['action', 'exported', 12], ['payoff', null, 78]],
  'note-head':   [['entry', null, 4], ['action', null, 90], ['payoff', null, 180]],
  'note-foot':   [['entry', null, 4], ['action', null, 90], ['payoff', null, 180]],
  close:         [['entry', null, 8], ['action', null, 60], ['payoff', null, 200]],
};

// Which take a scene's marks belong to: the braid and the note are their own
// clips; everything else is the one long thread take.
const clipOf = id => (id === 'close' ? 'braid'
  : id.startsWith('note') ? 'note'
  : id === 'hook' ? 'hook' : 'thread');

function starts() {
  let n = 0;
  const map = {};
  for (const s of edit.scenes) { map[s.id] = n; n += s.durationInFrames; }
  return map;
}

const START = starts();
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sheet = [];
let n = 0;
for (const scene of edit.scenes) {
  const beats = (BEATS[scene.id] || [['mid', null, Math.round(scene.durationInFrames / 2)]]).slice();
  // …plus one frame per label cue, at the middle of the cue
  for (const [n, cue] of (scene.labels || []).entries()) {
    beats.push([(scene.labels.length > 1 ? `label${n + 1}` : 'label'), null,
      Math.round(cue.at + cue.dur / 2)]);
  }
  const marks = (shots[clipOf(scene.id)] || {}).marks || [];
  for (const [name, mark, off] of beats) {
    let rel;
    if (mark) {
      const m = marks.find(x => x.label === mark);
      if (!m) { console.warn(`  ! ${scene.id}: no mark "${mark}"`); continue; }
      rel = m.frame - scene.inFrame + off;
    } else {
      rel = off;
    }
    // never the last frame of a scene: ffmpeg's seek rounds up at the boundary
    // and hands back the FIRST frame of the next one, which is how a still of
    // scene 3's payoff came back showing scene 4's entry
    rel = Math.max(0, Math.min(scene.durationInFrames - 4, rel));
    const master = START[scene.id] + rel;
    const t = master / FPS;
    const file = path.join(OUT, `${String(++n).padStart(2, '0')}-${scene.id}-${name}.png`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', VIDEO,
      '-frames:v', '1', file]);
    sheet.push({ n, scene: scene.id, beat: name, mark, masterFrame: master, t: Number(t.toFixed(2)) });
    console.log(`  ${path.basename(file)}  @ ${t.toFixed(2)}s (frame ${master})`);
  }
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(sheet, null, 2));
console.log(`\n${sheet.length} stills -> out/stills/`);
