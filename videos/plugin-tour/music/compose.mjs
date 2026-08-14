#!/usr/bin/env node
/**
 * compose.mjs — original score generator for the botference Discuss product tour.
 *
 * Everything you hear in out/score.wav is synthesised here, sample by sample:
 * plain sine/triangle/noise voices, ADSR envelopes, one-pole filters, a Haas
 * delay for width. No samples, no audio files, no npm dependencies. The only
 * external tool is ffmpeg, and only at the very end, to normalise loudness.
 *
 * ── The arrangement (v6) ───────────────────────────────────────────────────
 * The v5 bed (felt piano, I–V–vi–IV at 92) was warm and nobody disliked it —
 * the note on it was that it was TAME. v6 keeps the instruments and the key
 * and gives the thing a pulse you can nod to: Claude-Code-launch-film energy,
 * still felt, never corporate-EDM.
 *
 *   Tempo    100 BPM — chosen so a quarter-note is EXACTLY 18 frames at
 *            30fps. Every durationInFrames in edit.json is a multiple of 18,
 *            so every cut in the film lands on a beat of this score and every
 *            chord (which falls on a movement's own 2-bar grid, anchored to a
 *            cut) lands on a cut. The lock is arithmetic, not luck.
 *   Swing    the eighth grid is swung (~57%), on the marimba and the shaker,
 *            which is where the bounce lives.
 *   Bass     no longer a held root: root on the downbeat, root again on bar
 *            two, the fifth walking in on its third beat and a swung octave
 *            pickup into every change. The swagger is the bassline.
 *   Pulse    felt kick on 1 and 3, a soft backbeat tick on 2 and 4, and a
 *            whispery shaker on the swung offbeats from the Run movement on —
 *            the film's own "drop" is the code cell running, so that is where
 *            the momentum arrives.
 *   Stings   edit.json is also the cue sheet: a scene may declare
 *            "sting": "tada" (two rising bells — the plot landing) or
 *            "sting": "done" (a falling fifth on the marimba — the ✓). The
 *            score reads them with the same sums it reads the cuts from.
 *
 *   Progression   I – V – vi – IV   (F – C – Dm – Bb), cycling, resolved
 *   V → I at the close, voiced with common tones so the changes glide.
 *
 * The shape comes from ../edit.json at runtime — nothing about the timing is
 * hardcoded. Scene boundaries are the cumulative sum of durationInFrames/fps
 * (grouped by `beat`), and every layer change hangs off a boundary index:
 *
 *   scene 0  (the hook card) — felt piano alone, blooming from silence.
 *   scene 1  — bass + felt kick enter. From here every boundary gets a "lift":
 *            a fresh chord rolled exactly on the cut, a brief ~1.14x swell,
 *            and a single quiet bell on the new chord's top note.
 *   scene 2  — the marimba pattern enters, and the backbeat tick joins.
 *   scene 3  — the shaker arrives on the swung offbeats (the Run movement),
 *            and the keys brighten; this is the film's busiest stretch and
 *            the score's.
 *   n-2      — thin out: marimba, tick and shaker drop away, pulse eases back.
 *   n-1      (the close) — pulse gone, harmony resolves V → I and the master
 *            fades to true digital silence across the final 4 s.
 *
 * Pulse, shaker and marimba run on one global beat grid so they never stutter.
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
const BPM            = 100;    // a quarter-note = 18 frames at 30fps, exactly.
                               // The edit cuts on multiples of 18 — the lock
                               // between cuts and beats is this number.
const KEY_MIDI       = 53;     // tonic = F3 (MIDI 53). 50 = D3, 55 = G3, …
const MASTER_GAIN    = 0.42;   // pre-normalisation level. Keeps raw peak ~-6 dBFS.
const KEY_BRIGHTNESS = 2100;   // felt-piano lowpass cutoff in Hz. Lower = foggier.
const PULSE_LEVEL    = 0.13;   // kick + tick, relative to the keys. Felt, not counted.
const HISS_LEVEL     = 0.0035; // tape floor, ≈ -49 dBFS. 0 disables it.
// ──────────────────────────────────────────────────────────────────────────

// Secondary trims — rarely need touching.
const BELL_LEVEL   = 0.075;  // sparse high bell on chord changes at scene cuts
const BASS_LEVEL   = 0.28;   // the walking bass, sine-dominant
const MAR_LEVEL    = 0.22;   // the marimba pattern (scene 2 onward)
const SHAKER_LEVEL = 0.42;   // relative to PULSE_LEVEL; offbeats, Run movement on
const SWING        = 0.57;   // where the offbeat eighth falls (0.5 = straight)
const LIFT         = 1.14;   // size of the swell at each scene boundary
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

// The cue sheet (v6): a RAW scene may declare a sting — a named musical event
// at a frame inside that scene — so the picture's payoffs and the score's
// winks live in the same file and cannot drift. Times are absolute seconds on
// the master timeline, from the same cumulative sum as everything else.
const stings = [];
{
  let f = 0;
  for (const s of rawScenes) {
    if (s.sting) stings.push({ motif: s.sting, at: (f + (s.stingAt || 0)) / fps, scene: s.id });
    f += s.durationInFrames;
  }
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

// Voicings are offsets in semitones from KEY_MIDI (F3), kept inside C3..E4 so
// the keys stay warm. F3 and the third/fifth are common tones across the loop,
// so the changes glide instead of stepping. Order is I–V–vi–IV: the optimist's
// progression, resolved home at the end (the last scene plays V → I).
const PROG = [
  { name: 'I  F',   tones: [0, 4, 7, 12],   colour: 14,  bass: -12 }, // F A C F  (+G9)
  { name: 'V  C',   tones: [-5, 2, 7, 11],  colour: 14,  bass: -17 }, // C G C E  (+G)
  { name: 'vi Dm',  tones: [-3, 0, 4, 9],   colour: 11,  bass: -15 }, // D F A D  (+E9)
  { name: 'IV Bb',  tones: [-7, 0, 5, 9],   colour: 14,  bass: -19 }, // Bb F Bb D (+G6)
];

// ── 3. buses ──────────────────────────────────────────────────────────────
const bus = (n) => ({ L: new Float32Array(n), R: new Float32Array(n) });
const pad = bus(N), mar = bus(N), bass = bus(N), pulse = bus(N), bell = bus(N), hiss = bus(N);

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

// the marimba's gate: in at scene 2, out at the thin-out
const marEnv = makeEnv(nScenes > 3
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
  attack = 1.0, harmonics = [1, 0.42, 0.20, 0.10, 0.06], cutoff = KEY_BRIGHTNESS,
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

/** Shaker: a breath of band-passed noise, swung onto the offbeats. It is the
 *  quietest thing in the pulse and the reason the busy stretch bounces. */
function renderShaker(dst, t0, gain) {
  const start = Math.round(t0 * SR);
  if (start >= N) return;
  const len = Math.min(N - start, Math.ceil(0.09 * SR));
  const aLo = 1 - Math.exp(-TAU * 6800 / SR);
  const aHi = 1 - Math.exp(-TAU * 3100 / SR);
  let lp = 0, hp = 0;
  const side = rand() < 0.5 ? -1 : 1;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const n = rand() * 2 - 1;
    lp += aLo * (n - lp); hp += aHi * (lp - hp);
    const env = Math.exp(-t / 0.02) * (1 - Math.exp(-t / 0.0015));
    const s = (lp - hp) * env * gain;
    dst.L[start + i] += s * (side > 0 ? 1 : 0.78);
    dst.R[start + i] += s * (side > 0 ? 0.78 : 1);
  }
}

/**
 * Marimba pluck: the fundamental with the bar's characteristic ~4x partial and
 * a whisper of the ~9.2x, each with its own fast decay. Rounded 2.5 ms attack
 * so it reads as mallet-on-rosewood rather than as a click.
 */
function renderPluck(dst, t0, freq, gain, pan = 0) {
  const start = Math.round(t0 * SR);
  if (start >= N || gain <= 0) return;
  const len = Math.min(N - start, Math.ceil(0.9 * SR));
  const parts = [[1, 1.0, 0.42], [3.97, 0.38, 0.085], [9.2, 0.10, 0.045]];
  const ph = [0, 0, 0];
  const gl = Math.cos((pan + 1) * Math.PI / 4) * gain;
  const gr = Math.sin((pan + 1) * Math.PI / 4) * gain;
  const dl = Math.round(0.008 * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let s = 0;
    for (let p = 0; p < parts.length; p++) {
      ph[p] += TAU * freq * parts[p][0] / SR;
      s += parts[p][1] * Math.sin(ph[p]) * Math.exp(-t / parts[p][2]);
    }
    s *= smoothstep(Math.min(1, t / 0.0025));
    dst.L[start + i] += s * gl;
    if (start + i + dl < N) dst.R[start + i + dl] += s * gr;
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
const chordSpans = [];                   // every chord actually sounded, for the marimba
let chordIdx = 0;

/**
 * One felt-piano chord: the notes ROLLED (a few tens of ms between onsets, the
 * pianist's spread), soft short attacks, a slow linear decay across the span
 * and a quiet re-voice a bar later so a five-second chord does not die on the
 * screen. The cold open's first chord rolls much slower — the bloom from
 * silence the film opens on.
 */
function feltChord(t, dur, tones, { bloom = false, bright = 1, vel = 1 } = {}) {
  const strikes = dur > BAR + 0.6 ? [[0, 1.0], [BAR, 0.55]] : [[0, 1.0]];
  for (const [off, sv] of strikes) {
    tones.forEach((semi, k) => {
      const roll = bloom ? k * 0.30 : k * 0.032 + rand() * 0.012;
      renderTone(pad, {
        t0: t + off + roll,
        freq: mtof(KEY_MIDI + semi),
        hold: Math.max(0.6, dur - off - roll),
        release: 2.4,
        gain: vel * sv * MASTER_GAIN * (0.30 - k * 0.026),
        attack: bloom ? 0.9 : 0.020 + k * 0.004,
        harmonics: [1, 0.52, 0.26, 0.13, 0.06, 0.03],
        cutoff: KEY_BRIGHTNESS * bright * (1 - k * 0.05),
        pan: [-0.42, 0.30, -0.2, 0.46, 0.06][k % 5], haasSide: k % 2 ? -1 : 1,
        detuneCents: 2.5 + (k % 3), tine: k === tones.length - 1 ? 0.10 : 0.03,
        sustainDrop: 0.55,
      });
    });
  }
}

for (let i = 0; i < nScenes; i++) {
  const t0 = starts[i], t1 = starts[i] + durs[i];
  const isFirst = i === 0, isLast = i === last;
  const useColour = i >= 2 && !isLast;             // the 9th arrives at scene 3
  const bright = i >= 3 && !isLast ? 1.14 : 1.0;

  // The chord plan for this scene. Every scene STARTS on a chord, so every cut
  // gets a fresh voicing; the last scene resolves V → I. (PROG is I–V–vi–IV,
  // so V is PROG[1].)
  const plan = [];
  if (isLast) {
    if (durs[i] >= 5) {
      const split = t0 + durs[i] * 0.42;
      plan.push({ t: t0, dur: split - t0, ch: PROG[1] });          // V
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
    const release = final ? 4.2 : 2.6;
    const hold = Math.max(0.6, dur * 0.98);
    const vel = atCut ? 1.0 : 0.92;

    const tones = useColour ? [...ch.tones, ch.colour] : ch.tones;
    feltChord(t, dur, tones, { bloom: isFirst && c === 0, bright, vel });
    chordSpans.push({ t, dur, ch });

    // The bass. The cold open and the close hold a long root (the bloom and
    // the resolution both want stillness); everywhere else it WALKS — root on
    // the downbeat, root again on bar two, the fifth on that bar's third beat
    // and a swung octave pickup into the next change. Sine-dominant, hard
    // lowpass, dead centre; the swagger is in the where, not the what.
    if (isFirst || isLast) {
      renderTone(bass, {
        t0: t, freq: mtof(KEY_MIDI + ch.bass), hold, release: release * 1.1,
        gain: vel * MASTER_GAIN * BASS_LEVEL, attack: isFirst && c === 0 ? 2.4 : 0.06,
        harmonics: [1, 0.18, 0.05],
        cutoff: 300, pan: 0, detuneCents: 1.5, haas: 0.005, sustainDrop: 0.22,
      });
    } else {
      const walk = [
        //[offset in beats,        semitones over root, hold in beats, gain]
        [0,                        0,  3.8,  1.0],
        [4,                        0,  1.8,  0.78],
        [6,                        7,  1.3,  0.66],
        [7 + SWING,                12, 0.45, 0.52],
      ];
      for (const [offB, semi, holdB, g] of walk) {
        const off = offB * BEAT;
        if (off >= dur - 0.12) continue;
        renderTone(bass, {
          t0: t + off, freq: mtof(KEY_MIDI + ch.bass + semi),
          hold: Math.min(holdB * BEAT, dur - off), release: 0.5,
          gain: vel * MASTER_GAIN * BASS_LEVEL * g, attack: 0.014,
          harmonics: [1, 0.18, 0.05],
          cutoff: 330, pan: 0, detuneCents: 1.5, haas: 0.005, sustainDrop: 0.3,
        });
      }
    }

    // One quiet bell per scene cut (never on the cold open), plus the final tonic.
    if ((atCut && i > 0 && !isLast) || final) {
      renderBell(bell, t + (final ? 0.35 : 0.06), mtof(KEY_MIDI + Math.max(...ch.tones) + 12),
                 MASTER_GAIN * BELL_LEVEL * (final ? 0.9 : 1), c % 2 ? 0.35 : -0.35);
    }
  }
  log.push(`  scene ${i} "${scenes[i].id}" ${t0.toFixed(2)}–${t1.toFixed(2)}s  ` +
           `${plan.map((p) => p.ch.name.trim()).join(' → ')}`);
}

// ── 5b. the marimba pattern ───────────────────────────────────────────────
// A gentle figure on the eighth-note grid of each sounded chord: six mallet
// hits per two-bar span, chord tones an octave (and once two octaves) up,
// syncopated just enough to lilt. marEnv gates where it is audible (scene 2 to
// the thin-out), so the pattern can be rendered wherever a chord sounds and
// the envelope decides when the listener meets it. Humanised ±8 ms and ±10%
// velocity from the seeded PRNG, so every render is still bit-identical.
const EIGHTH = BEAT / 2;
const FIGURE = [
  //[eighth, toneIndex, octave, velocity]
  [0, 2, 12, 0.9], [3, 1, 12, 0.7], [6, 3, 12, 0.8],
  [9, 2, 12, 0.62], [12, 0, 24, 0.85], [14, 1, 12, 0.58],
];
if (nScenes > 3) {
  for (const { t, dur, ch } of chordSpans) {
    for (const [e, ti, oct, v] of FIGURE) {
      // odd eighths are offbeats, and the offbeats are SWUNG — this one line
      // is where the v6 lilt comes from
      const swing = e % 2 ? (SWING - 0.5) * BEAT : 0;
      const at = t + e * EIGHTH + swing + (rand() - 0.5) * 0.016;
      if (at >= t + dur - 0.05 || at < 0) continue;
      const semi = ch.tones[Math.min(ti, ch.tones.length - 1)] + oct;
      renderPluck(mar, at, mtof(KEY_MIDI + semi),
        MASTER_GAIN * MAR_LEVEL * v * (0.9 + rand() * 0.2),
        e % 3 === 0 ? -0.3 : 0.35);
    }
  }
}

// ── 5c. the stings — the score's winks, cued by edit.json ─────────────────
// 'tada' is two bells rising a fourth (C5 → F5) for the plot landing full
// screen; 'done' is the marimba falling a fifth (C5 → F4) for the ✓ — the
// oldest "settled" cadence there is, played on the smallest instrument in the
// room. Both are scale tones of F that sit inside every chord of the loop, so
// wherever the progression happens to be, the wink lands in tune.
for (const { motif, at } of stings) {
  if (motif === 'tada') {
    renderBell(bell, at, mtof(KEY_MIDI + 19), MASTER_GAIN * BELL_LEVEL * 1.25, -0.3);
    renderBell(bell, at + 0.17, mtof(KEY_MIDI + 24), MASTER_GAIN * BELL_LEVEL * 1.5, 0.3);
  } else if (motif === 'done') {
    renderPluck(mar, at, mtof(KEY_MIDI + 19), MASTER_GAIN * MAR_LEVEL * 1.5, -0.2);
    renderPluck(mar, at + 0.15, mtof(KEY_MIDI + 12), MASTER_GAIN * MAR_LEVEL * 1.7, 0.25);
  }
}

// Pulse on one continuous global beat grid; pulseEnv decides where it is audible.
// v6: kick on 1 and 3, the tick is now a proper BACKBEAT on 2 and 4, and the
// shaker whispers on the swung offbeats from the Run movement to the thin-out —
// the film's own "drop" is the code cell running, so the momentum arrives there.
const pulseFrom = nScenes > 1 ? b(1) : 0;
const pulseTo = nScenes > 1 ? b(last) : TOTAL;
const tickFrom = nScenes > 3 ? b(2) : Infinity;
const tickTo = nScenes > 3 ? b(thin) : -Infinity;
const shakerFrom = nScenes > 4 ? b(3) : Infinity;
const shakerTo = nScenes > 4 ? b(thin) : -Infinity;
for (let k = 0; ; k++) {
  const t = k * BEAT;
  if (t >= TOTAL) break;
  if (t >= pulseFrom - 0.05 && t < pulseTo) {
    if (k % 4 === 0) renderKick(pulse, t, PULSE_LEVEL * MASTER_GAIN * 1.0);
    else if (k % 4 === 2) renderKick(pulse, t, PULSE_LEVEL * MASTER_GAIN * 0.72);
  }
  if (t >= tickFrom && t < tickTo && k % 2 === 1) {
    renderTick(pulse, t, PULSE_LEVEL * MASTER_GAIN * 0.4);
  }
  if (t >= shakerFrom - 0.05 && t + BEAT * SWING < shakerTo) {
    renderShaker(pulse, t + BEAT * SWING,
      PULSE_LEVEL * MASTER_GAIN * SHAKER_LEVEL * (k % 2 ? 0.82 : 1));
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
  let l = pad.L[i] * padEnv[i] + bass.L[i] * bassEnv[i] + mar.L[i] * marEnv[i]
        + pulse.L[i] * pulseEnv[i] + bell.L[i] + hiss.L[i] * hissEnv[i];
  let r = pad.R[i] * padEnv[i] + bass.R[i] * bassEnv[i] + mar.R[i] * marEnv[i]
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
if (stings.length) {
  console.log(`  stings: ${stings.map((s) => `${s.motif} @ ${s.at.toFixed(2)}s (${s.scene})`).join(', ')}`);
}
console.log(`  tempo ${BPM} BPM · beat = ${(60 / BPM * fps).toFixed(1)} frames · chord every ${CHORD_SPAN.toFixed(2)}s · raw peak ${db(peak).toFixed(2)} dBFS`);

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
