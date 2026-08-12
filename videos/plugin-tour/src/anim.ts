/**
 * anim.ts — the feel of the film, in six numbers.
 *
 * Nothing else in src/ owns a duration or an easing curve. If the edit feels
 * hurried, raise REVEAL and OVERLAY_IN; if the captions feel like they are
 * being fired at you, raise STAGGER. Every change here moves the whole film
 * consistently, which is the point of having the knobs in one place.
 *
 * Camera moves and cut points are NOT here — they are per-shot decisions and
 * they live in edit.json.
 */
import { Easing } from 'remotion';

export const anim = {
  /** frames a title card's type takes to arrive (cold open, close) */
  REVEAL: 26,

  /** frames between one line of type and the next inside a title card */
  STAGGER: 9,

  /** frames a lower-third caption takes to slide up and fade in */
  OVERLAY_IN: 12,

  /** frames a lower-third caption takes to fade back out */
  OVERLAY_OUT: 10,

  /** how far, in px, type and captions travel while arriving — the amount of
   *  "movement" the film has at rest. 0 gives a pure crossfade. */
  EMPHASIS: 18,

  /** the one easing curve the film uses for everything that is not a camera
   *  move: a soft, decelerating settle with no overshoot */
  EASE: Easing.bezier(0.22, 0.61, 0.24, 1),
} as const;

/** Camera moves get their own two curves, named in edit.json by `ease`. */
export const CAMERA_EASE = {
  /** the default: symmetric, unhurried, nothing lands hard */
  ease: Easing.bezier(0.4, 0.0, 0.2, 1),
  /** a push that means "look here": leaves quickly, arrives slowly */
  emphasis: Easing.bezier(0.25, 0.0, 0.15, 1),
} as const;

export type CameraEaseName = keyof typeof CAMERA_EASE;

/** The brand, from site/index.html's :root and council's speaker palette. */
export const brand = {
  bg: '#070a0e',
  panel: '#0e131a',
  border: '#1b2430',
  text: '#dbe2ea',
  muted: '#7f8c9c',
  accent: '#34d399',
  claude: '#d97757',
  codex: '#4a86c8',
  serif: 'Iowan Old Style, Charter, Palatino, Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;
