#!/usr/bin/env node
/**
 * compose.mjs — original score generator for the botference Discuss product tour.
 *
 * Everything you hear in out/score.wav is synthesised here, sample by sample:
 * plain sine/triangle/noise voices, ADSR envelopes, one-pole filters, a Haas
 * delay for width. No samples, no audio files, no npm dependencies. The only
 * external tool is ffmpeg, and only at the very end, to normalise loudness.
 *
 * ── The arrangement ────────────────────────────────────────────────────────
 * The score is a bed, not a piece of music that wants your attention: soft
 * electric-piano-ish pads in A-flat major, low-ish, one chord per two bars at
 * 84 BPM, a pulse you feel rather than count, and a tape hiss floor for warmth.
 *
 *   Progression   I – vi – IV – V   (Ab – Fm – Db – Eb), cycling.
 *
 * The shape comes from ../edit.json at runtime — nothing about the timing is
 * hardcoded. Scene boundaries are the cumulative sum of durationInFrames/fps,
 * and every layer change hangs off a boundary index:
 *
 *   scene 0  (first, "braid" cold open) — pads only, blooming up from true
 *            silence: the first chord has a ~3 s attack and the pad bus rises
 *            from 0 over the first ~60% of the scene. No pulse, no bass.
 *   scene 1  — bass + pulse enter. From here every boundary gets a "lift":
 *            a fresh chord starting exactly on the cut, a brief ~1.16x swell,
 *            and a single quiet bell on the new chord's top note.
 *   scene 2  — octave pad layer added (brighter, an octave above the top
 *            voice) and the muffled tick joins the kick.
 *   scene 3  — no new layer; the lift is harmonic (the 9th colour tone is in,
 *            the voicing changes) so the busiest scene stays still underneath.
 *   n-2      — thin out: octave layer and tick drop away, pulse eases back.
 *   n-1      (last, "braid" close) — pulse gone, harmony resolves V → I and
 *            the master fades to true digital silence across the final 4 s.
 *
 * Within a scene, chords fall on that scene's own 2-bar grid (so a chord always
 * lands on the cut); the pulse runs on one global beat grid so it never stutters.
 * Change a durationInFrames in edit.json, re-run, and all of it re-aligns.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node music/compose.mjs              render + two-pass loudnorm to -16 LUFS
 *   node music/compose.mjs --no-normalize   render only (raw 16-bit WAV)
 *
 * The six knobs worth touching are the SIX KNOBS block below.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────── SIX KNOBS ──────────────────────────────────
const BPM            = 84;     // tempo. Unhurried. 78–90 all work.
const KEY_MIDI       = 56;     // tonic = Ab3 (MIDI 56). 55 = G3, 57 = A3, …
const MASTER_GAIN    = 0.42;   // pre-normalisation level. Keeps raw peak ~-6 dBFS.
const PAD_BRIGHTNESS = 1500;   // pad lowpass cutoff in Hz. Lower = darker/foggier.
const PULSE_LEVEL    = 0.16;   // kick + tick, relative to the pads. Felt, not counted.
const HISS_LEVEL     = 0.0035; // tape floor, ≈ -49 dBFS. 0 disables it.
// ──────────────────────────────────────────────────────────────────────────

// Secondary trims — rarely need touching.
const BELL_LEVEL   = 0.085;  // sparse high bell on chord changes at scene cuts
const BASS_LEVEL   = 0.30;   // sub-pad root, sine-dominant
const OCT_LEVEL    = 0.14;   // the octave-up pad layer (scene 2 onward)
const LIFT         = 1.16;   // size of the swell at each scene boundary
const TAIL_FADE    = 4.0;    // seconds of fade at the end, to true silence
const SR           = 44100;

const HERE   = dirname(fileURLToPath(import.meta.url));
const ROOT   = dirname(HERE);                 // videos/plugin-tour
const EDIT   = join(ROOT, 'edit.json');
const OUTDIR = join(ROOT, 'out');
const OUTWAV = join(OUTDIR, 'score.wav');
const TMPWAV = join(OUTDIR, '.score-raw.wav'); // intermediate, deleted on success

const NORMALIZE = !process.argv.includes('--no-normalize');

// ── tiny helpers ──────────────────────────────────────────────────────────
const TAU = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const smoothstep = (u) => u * u * (3 - 2 * u);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** Deterministic PRNG (mulberry32) — every run produces a bit-identical WAV. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x0B07F00D);

// ── 1. read the edit ──────────────────────────────────────────────────────
const edit = JSON.parse(readFileSync(EDIT, 'utf8'));
const fps = edit.meta?.fps ?? 30;
const rawScenes = edit.scenes ?? [];
if (!rawScenes.length) throw new Error(`${EDIT} has no scenes`);

// The score follows the film's BEATS, not its cuts.
//
// v1 had seven scenes and one meant the other. v3 cuts nine times inside a
// single continuous take, and giving each of those a chord change, a swell and
// a bell — which is what this file did when a scene WAS a beat — produces a bed
// that fidgets: fourteen bells in thirty-seven seconds, harmony moving every
// second cut, and a listener who notices the music. So edit.json labels each
// scene with the beat it belongs to, consecutive scenes sharing a beat are one
// movement here, and a scene with no label is a beat of its own. Everything
// below is unchanged; it simply sums a coarser list.
const scenes = [];
for (const s of rawScenes) {
  const key = s.beat || s.id;
  const prev = scenes[scenes.length - 1];
  if (prev && prev.id === key) prev.durationInFrames += s.durationInFrames;
  else scenes.push({ id: key, durationInFrames: s.durationInFrames, cuts: 0 });
  scenes[scenes.length - 1].cuts++;
}

const durs = scenes.map((s) => s.durationInFrames / fps);
const starts = [];
let acc = 0;
for (const d of durs) { starts.push(acc); acc += d; }
const TOTAL = acc;                       // seconds — the contract with the picture
const nScenes = scenes.length;
const N = Math.round(TOTAL * SR);        // samples per channel

// ── 2. musical grid ───────────────────────────────────────────────────────
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const CHORD_SPAN = 2 * BAR;              // one chord per two bars

// Voicings are offsets in semitones from KEY_MIDI, kept inside Ab3..Bb4 so the
// bed never gets shrill. Ab3 is a common tone across I, vi and IV, so the
// changes glide instead of stepping.
const PROG = [
  { name: 'I  Ab',  tones: [0, 4, 7, 12],   colour: 14,  bass: -12 }, // Ab C Eb Ab (+Bb9)
  { name: 'vi Fm',  tones: [-3, 0, 4, 9],   colour: 12,  bass: -15 }, // F Ab C F
  { name: 'IV Db',  tones: [-7, 0, 5, 9],   colour: 12,  bass: -7  }, // Db Ab Db F
  { name: 'V  Eb',  tones: [-5, 2, 7, 11],  colour: 14,  bass: -5  }, // Eb Bb Eb G
];

// ── 3. buses ──────────────────────────────────────────────────────────────
const bus = (n) => ({ L: new Float32Array(n), R: new Float32Array(n) });
const pad = bus(N), oct = bus(N), bass = bus(N), pulse = bus(N), bell = bus(N), hiss = bus(N);

/**
 * Breakpoint envelope, smoothstep-interpolated, sampled to a full-length array.
 * Points are [timeSeconds, value]; the value is held before the first and after
 * the last point.
 */
function makeEnv(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const e = new Float32Array(N);
  if (pts.length === 1) { e.fill(pts[0][1]); return e; }
  let k = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    while (k < pts.length - 2 && t >= pts[k + 1][0]) k++;
    const [ta, va] = pts[k], [tb, vb] = pts[k + 1];
    e[i] = t <= ta ? va : t >= tb ? vb : va + (vb - va) * smoothstep((t - ta) / (tb - ta));
  }
  return e;
}

// Layer schedules, all derived from the boundary times computed above.
const b = (i) => starts[Math.min(Math.max(i, 0), nScenes - 1)];
const last = nScenes - 1;
const thin = Math.max(1, nScenes - 2);   // the "thin out" scene index
const baseFor = (i) => (i === 0 || i === last ? 1.0 : 0.92);

const padPts = [[0, 0], [durs[0] * 0.62, 1.0]];
for (let i = 1; i < nScenes; i++) {
  padPts.push([b(i) - 0.30, baseFor(i - 1)]);      // hold the outgoing level
  padPts.push([b(i) + 0.90, baseFor(i) * LIFT]);   // the lift
  padPts.push([b(i) + 3.20, baseFor(i)]);          // settle back
}
const padEnv = makeEnv(padPts);

const bassEnv = makeEnv(nScenes > 1
  ? [[0, 0], [b(1) - 0.10, 0], [b(1) + 1.5, 1], [b(last), 1], [b(last) + 1.2, 0.9]]
  : [[0, 1]]);

const pulseEnv = makeEnv(nScenes > 2
  ? [[0, 0], [b(1) - 0.10, 0], [b(1) + 1.8, 1], [b(thin), 1], [b(thin) + 1.4, 0.55],
     [b(last) - 0.10, 0.55], [b(last) + 0.9, 0]]
  : [[0, 0]]);

const octEnv = makeEnv(nScenes > 3
  ? [[0, 0], [b(2) - 0.20, 0], [b(2) + 2.4, 1], [b(thin) - 0.10, 1], [b(thin) + 1.6, 0]]
  : [[0, 0]]);

const hissEnv = makeEnv([[0, 0], [4.0, 1]]);

// ── 4. voices ─────────────────────────────────────────────────────────────
/**
 * One pad/bass/oct note. Additive sines, a one-pole lowpass, a slow-attack ADSR,
 * and stereo width from a few cents of detune plus a small Haas delay on one side.
 * Attacks are smoothstepped from zero, so nothing can click.
 */
function renderTone(dst, {
  t0, freq, hold, release, gain,
  attack = 1.0, harmonics = [1, 0.42, 0.20, 0.10, 0.06], cutoff = PAD_BRIGHTNESS,
  pan = 0, detuneCents = 4, haas = 0.013, haasSide = 1,
  drift = 0.0012, driftHz = 0.13, tine = 0, sustainDrop = 0.22,
}) {
  const start = Math.round(t0 * SR);
  if (start >= N || gain <= 0) return;
  const len = Math.min(N - start + Math.round(haas * SR) + 1,
                       Math.ceil((hold + release + 0.05) * SR));
  if (len <= 0) return;

  const a = 1 - Math.exp(-TAU * cutoff / SR);       // one-pole LP coefficient
  const dRatio = Math.pow(2, detuneCents / 1200);
  const fL = freq / dRatio, fR = freq * dRatio;
  const phL = new Float64Array(harmonics.length);
  const phR = new Float64Array(harmonics.length);
  const dph = new Float64Array(harmonics.length);
  const driftPhase = rand() * TAU;
  let tineL = 0, tineR = 0, lpL = 0, lpR = 0;
  const atk = Math.max(0.004, attack);

  const outL = new Float32Array(len), outR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // tape-ish wow: a very slow, very small pitch drift
    const w = 1 + drift * Math.sin(TAU * driftHz * t + driftPhase);
    let sL = 0, sR = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const m = h + 1;
      phL[h] += TAU * fL * m * w / SR;
      phR[h] += TAU * fR * m * w / SR;
      sL += harmonics[h] * Math.sin(phL[h]);
      sR += harmonics[h] * Math.sin(phR[h]);
    }
    if (tine > 0) {                                  // brief EP "tine" shimmer
      tineL += TAU * fL * 4.02 / SR; tineR += TAU * fR * 4.02 / SR;
      const g = tine * Math.exp(-t / 0.7);
      sL += g * Math.sin(tineL); sR += g * Math.sin(tineR);
    }
    lpL += a * (sL - lpL); lpR += a * (sR - lpR);

    let env;
    if (t < atk) env = smoothstep(t / atk);
    else if (t < hold) env = 1 - sustainDrop * ((t - atk) / Math.max(0.001, hold - atk));
    else env = (1 - sustainDrop) * Math.pow(1 - Math.min(1, (t - hold) / release), 2.2);

    outL[i] = lpL * env; outR[i] = lpR * env;
  }

  const gl = Math.cos((pan + 1) * Math.PI / 4) * gain;
  const gr = Math.sin((pan + 1) * Math.PI / 4) * gain;
  const dl = Math.round(haas * SR);
  const offL = haasSide > 0 ? 0 : dl;
  const offR = haasSide > 0 ? dl : 0;
  for (let i = 0; i < len; i++) {
    const jL = start + i + offL, jR = start + i + offR;
    if (jL < N) dst.L[jL] += outL[i] * gl;
    if (jR < N) dst.R[jR] += outR[i] * gr;
  }
}

/** Soft sine thump. Pitch drops fast, amplitude decays fast, phase starts at 0. */
function renderKick(dst, t0, gain) {
  const start = Math.round(t0 * SR);
  if (start >= N) return;
  const len = Math.min(N - start, Math.ceil(0.45 * SR));
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 46 + 52 * Math.exp(-t / 0.035);
    ph += TAU * f / SR;
    const env = Math.exp(-t / 0.15) * (1 - Math.exp(-t / 0.004)); // no click on entry
    const s = Math.sin(ph) * env * gain;
    dst.L[start + i] += s; dst.R[start + i] += s * 0.97;
  }
}

/** Muffled tick: a short noise blip, lowpassed hard so it reads as felt, not heard. */
function renderTick(dst, t0, gain) {
  const start = Math.round(t0 * SR);
  if (start >= N) return;
  const len = Math.min(N - start, Math.ceil(0.12 * SR));
  const a = 1 - Math.exp(-TAU * 1900 / SR);
  const ah = 1 - Math.exp(-TAU * 420 / SR);
  let lp = 0, lp2 = 0, dc = 0;
  const side = rand() < 0.5 ? -1 : 1;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const n = rand() * 2 - 1;
    lp += a * (n - lp); lp2 += a * (lp - lp2); dc += ah * (lp2 - dc);
    const env = Math.exp(-t / 0.028) * (1 - Math.exp(-t / 0.002));
    const s = (lp2 - dc) * env * gain;
    dst.L[start + i] += s * (side > 0 ? 1 : 0.75);
    dst.R[start + i] += s * (side > 0 ? 0.75 : 1);
  }
}

/** Sparse bell: three slightly inharmonic partials, fast-but-smooth attack. */
function renderBell(dst, t0, freq, gain, pan = 0) {
  const start = Math.round(t0 * SR);
  if (start >= N) return;
  const len = Math.min(N - start, Math.ceil(3.2 * SR));
  const parts = [[1, 1.0, 2.6], [2.76, 0.30, 1.1], [5.40, 0.12, 0.6]];
  const ph = [0, 0, 0];
  const gl = Math.cos((pan + 1) * Math.PI / 4) * gain;
  const gr = Math.sin((pan + 1) * Math.PI / 4) * gain;
  const dl = Math.round(0.011 * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let s = 0;
    for (let p = 0; p < parts.length; p++) {
      ph[p] += TAU * freq * parts[p][0] / SR;
      s += parts[p][1] * Math.sin(ph[p]) * Math.exp(-t / parts[p][2]);
    }
    s *= smoothstep(Math.min(1, t / 0.012));
    dst.L[start + i] += s * gl;
    if (start + i + dl < N) dst.R[start + i + dl] += s * gr;
  }
}

// ── 5. arrange ────────────────────────────────────────────────────────────
const log = [];
let chordIdx = 0;

for (let i = 0; i < nScenes; i++) {
  const t0 = starts[i], t1 = starts[i] + durs[i];
  const isFirst = i === 0, isLast = i === last;
  const useColour = i >= 2 && !isLast;             // the 9th arrives at scene 3
  const brightness = PAD_BRIGHTNESS * (i >= 3 && !isLast ? 1.18 : 1.0);

  // The chord plan for this scene. Every scene STARTS on a chord, so every cut
  // gets a fresh voicing; the last scene resolves V → I.
  const plan = [];
  if (isLast) {
    if (durs[i] >= 5) {
      const split = t0 + durs[i] * 0.42;
      plan.push({ t: t0, dur: split - t0, ch: PROG[3] });          // V
      plan.push({ t: split, dur: t1 - split, ch: PROG[0], final: true }); // I
    } else {
      plan.push({ t: t0, dur: durs[i], ch: PROG[0], final: true });
    }
  } else {
    for (let t = t0; t < t1 - 0.5; t += CHORD_SPAN) {
      plan.push({ t, dur: Math.min(CHORD_SPAN, t1 - t), ch: PROG[chordIdx++ % PROG.length] });
    }
  }

  for (let c = 0; c < plan.length; c++) {
    const { t, dur, ch, final } = plan[c];
    const atCut = c === 0;
    const attack = isFirst && c === 0 ? 3.0 : atCut ? 1.5 : 1.0;   // the first chord blooms
    const release = final ? 4.2 : 2.6;
    const hold = Math.max(0.6, dur * 0.98);
    const vel = (atCut ? 1.0 : 0.92) * MASTER_GAIN;

    const tones = useColour ? [...ch.tones, ch.colour] : ch.tones;
    tones.forEach((semi, k) => {
      renderTone(pad, {
        t0: t, freq: mtof(KEY_MIDI + semi), hold, release, gain: vel * (0.30 - k * 0.028),
        attack: attack * (1 + k * 0.12), cutoff: brightness * (1 - k * 0.06),
        pan: [-0.45, 0.30, -0.22, 0.48, 0.08][k % 5], haasSide: k % 2 ? -1 : 1,
        detuneCents: 3 + (k % 3), tine: k === 0 ? 0.05 : 0.02,
      });
    });

    // Low root. Sine-dominant, hard lowpass, dead centre.
    renderTone(bass, {
      t0: t, freq: mtof(KEY_MIDI + ch.bass), hold, release: release * 1.1,
      gain: vel * BASS_LEVEL, attack: attack * 0.85, harmonics: [1, 0.18, 0.05],
      cutoff: 320, pan: 0, detuneCents: 1.5, haas: 0.005, sustainDrop: 0.18,
    });

    // Octave layer — brighter, slower, quieter. Gated by octEnv per scene.
    renderTone(oct, {
      t0: t, freq: mtof(KEY_MIDI + Math.max(...ch.tones) + 12), hold, release: release * 1.2,
      gain: vel * OCT_LEVEL, attack: attack * 1.6, harmonics: [1, 0.22, 0.08],
      cutoff: 2600, pan: -0.2, haasSide: -1, detuneCents: 6,
    });

    // One quiet bell per scene cut (never on the cold open), plus the final tonic.
    if ((atCut && i > 0 && !isLast) || final) {
      renderBell(bell, t + (final ? 0.35 : 0.06), mtof(KEY_MIDI + Math.max(...ch.tones) + 12),
                 MASTER_GAIN * BELL_LEVEL * (final ? 0.9 : 1), c % 2 ? 0.35 : -0.35);
    }
  }
  log.push(`  scene ${i} "${scenes[i].id}" ${t0.toFixed(2)}–${t1.toFixed(2)}s  ` +
           `${plan.map((p) => p.ch.name.trim()).join(' → ')}`);
}

// Pulse on one continuous global beat grid; pulseEnv decides where it is audible.
const pulseFrom = nScenes > 1 ? b(1) : 0;
const pulseTo = nScenes > 1 ? b(last) : TOTAL;
const tickFrom = nScenes > 3 ? b(2) : Infinity;
const tickTo = nScenes > 3 ? b(thin) : -Infinity;
for (let k = 0; ; k++) {
  const t = k * BEAT;
  if (t >= TOTAL) break;
  if (t >= pulseFrom - 0.05 && t < pulseTo) {
    if (k % 4 === 0) renderKick(pulse, t, PULSE_LEVEL * MASTER_GAIN * 1.0);
    else if (k % 4 === 2) renderKick(pulse, t, PULSE_LEVEL * MASTER_GAIN * 0.72);
  }
  if (t >= tickFrom && t < tickTo && k % 4 !== 0) {
    renderTick(pulse, t + (k % 2 ? 0 : BEAT / 2), PULSE_LEVEL * MASTER_GAIN * 0.30);
  }
}

// Tape floor: two independent seeded noise streams, band-limited, barely there.
{
  const aLo = 1 - Math.exp(-TAU * 5200 / SR);
  const aHi = 1 - Math.exp(-TAU * 180 / SR);
  let lpL = 0, lpR = 0, hpL = 0, hpR = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const wobble = 1 + 0.18 * Math.sin(TAU * 0.037 * t) + 0.09 * Math.sin(TAU * 0.011 * t + 1.7);
    const nL = rand() * 2 - 1, nR = rand() * 2 - 1;
    lpL += aLo * (nL - lpL); lpR += aLo * (nR - lpR);
    hpL += aHi * (lpL - hpL); hpR += aHi * (lpR - hpR);
    hiss.L[i] = (lpL - hpL) * HISS_LEVEL * wobble;
    hiss.R[i] = (lpR - hpR) * HISS_LEVEL * wobble;
  }
}

// ── 6. mix ────────────────────────────────────────────────────────────────
const mixL = new Float32Array(N), mixR = new Float32Array(N);
const fadeStart = Math.max(0, TOTAL - TAIL_FADE);
// The fade reaches exact zero 0.5 s before the end, so the tail is true digital
// silence rather than a very small number.
const fadeSpan = Math.max(0.001, TAIL_FADE - 0.5);
for (let i = 0; i < N; i++) {
  const t = i / SR;
  let l = pad.L[i] * padEnv[i] + bass.L[i] * bassEnv[i] + oct.L[i] * octEnv[i]
        + pulse.L[i] * pulseEnv[i] + bell.L[i] + hiss.L[i] * hissEnv[i];
  let r = pad.R[i] * padEnv[i] + bass.R[i] * bassEnv[i] + oct.R[i] * octEnv[i]
        + pulse.R[i] * pulseEnv[i] + bell.R[i] + hiss.R[i] * hissEnv[i];
  // Gentle saturation: rounds off any stray peak instead of clipping it.
  l = Math.tanh(l * 1.05) * 0.95;
  r = Math.tanh(r * 1.05) * 0.95;
  let g = smoothstep(clamp(t / 0.03, 0, 1));                 // 30 ms head ramp
  if (t >= fadeStart) g *= Math.pow(clamp(1 - (t - fadeStart) / fadeSpan, 0, 1), 2.4);
  mixL[i] = l * g; mixR[i] = r * g;
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mixL[i]), Math.abs(mixR[i]));

// ── 7. write ──────────────────────────────────────────────────────────────
/** Interleaved WAV writer. float32 for the intermediate, int16 for the deliverable. */
function writeWav(path, L, R, { float = false } = {}) {
  const frames = L.length;
  const bps = float ? 4 : 2;
  const dataLen = frames * 2 * bps;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float ? 3 : 1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2 * bps, 28);
  buf.writeUInt16LE(2 * bps, 32); buf.writeUInt16LE(bps * 8, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    if (float) { buf.writeFloatLE(L[i], o); o += 4; buf.writeFloatLE(R[i], o); o += 4; }
    else {
      buf.writeInt16LE(Math.round(clamp(L[i], -1, 1) * 32767), o); o += 2;
      buf.writeInt16LE(Math.round(clamp(R[i], -1, 1) * 32767), o); o += 2;
    }
  }
  writeFileSync(path, buf);
}

if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });

console.log(`botference tour score — ${nScenes} scenes, ${TOTAL.toFixed(3)}s @ ${fps}fps`);
console.log(log.join('\n'));
console.log(`  tempo ${BPM} BPM · chord every ${CHORD_SPAN.toFixed(2)}s · raw peak ${db(peak).toFixed(2)} dBFS`);

if (!NORMALIZE) {
  writeWav(OUTWAV, mixL, mixR);
  console.log(`wrote ${OUTWAV} (not normalised)`);
  process.exit(0);
}

// ── 8. two-pass loudnorm via ffmpeg ───────────────────────────────────────
writeWav(TMPWAV, mixL, mixR, { float: true });

// ffmpeg prints its filter reports (loudnorm JSON, astats) on stderr, so both
// streams are captured and concatenated.
const ff = (args) => {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error) throw r.error;
  return (r.stdout || '') + (r.stderr || '');
};
const TARGET = 'I=-16:TP=-1.5:LRA=11';

// Pass 1: measure.
const measured = ff(['-hide_banner', '-nostats', '-i', TMPWAV,
  '-af', `loudnorm=${TARGET}:print_format=json`, '-f', 'null', '-']);
const jsonText = measured.slice(measured.lastIndexOf('{'), measured.lastIndexOf('}') + 1);
let m;
try { m = JSON.parse(jsonText); }
catch { throw new Error('could not parse loudnorm pass-1 output:\n' + measured.slice(-800)); }
console.log(`  pass 1: I=${m.input_i} LUFS  TP=${m.input_tp} dBTP  LRA=${m.input_lra}  thresh=${m.input_thresh}`);

// Pass 2: apply a single static gain (linear=true) so the intro swell and the
// silent tail survive untouched.
const filter = `loudnorm=${TARGET}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
  `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
  `:offset=${m.target_offset}:linear=true:print_format=summary`;
const applied = ff(['-y', '-hide_banner', '-nostats', '-i', TMPWAV, '-af', filter,
  '-ar', String(SR), '-ac', '2', '-c:a', 'pcm_s16le', OUTWAV]);
if (/Normalization Type\s*:\s*dynamic/i.test(applied)) {
  console.warn('  ! loudnorm fell back to dynamic mode (target would clip) — lower MASTER_GAIN?');
}
if (!existsSync(OUTWAV)) throw new Error('ffmpeg did not produce ' + OUTWAV + '\n' + applied.slice(-800));
try { unlinkSync(TMPWAV); } catch { /* keep going */ }

// Pass 3: verify what actually landed on disk.
const verify = ff(['-hide_banner', '-nostats', '-i', OUTWAV,
  '-af', `loudnorm=${TARGET}:print_format=json,astats=measure_overall=Peak_level:measure_perchannel=none`,
  '-f', 'null', '-']);
const vj = verify.slice(verify.lastIndexOf('{'), verify.lastIndexOf('}') + 1);
let v = null; try { v = JSON.parse(vj); } catch { /* fall through */ }
const pk = /Peak level dB:\s*(-?[\d.]+|-inf)/i.exec(verify);
console.log(`wrote ${OUTWAV}`);
if (v) console.log(`  final : I=${v.input_i} LUFS  TP=${v.input_tp} dBTP  LRA=${v.input_lra}`);
if (pk) console.log(`  peak  : ${pk[1]} dBFS`);
