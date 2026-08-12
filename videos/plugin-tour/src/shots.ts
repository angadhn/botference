/**
 * The shoot's own record, read by the edit.
 *
 * capture/capture.mjs marks the instant of every real action and, for the ones a
 * label names, the viewport box of the thing that moved (footage/shots.json).
 * The composition reads those marks rather than restating them: a label says
 * WHICH action it names and the geometry comes from the take.
 *
 * Frames in shots.json are absolute in the source clip; a scene's own frame 0 is
 * its `inFrame`, so `markOf` returns the mark and the caller compares against
 * scene-relative frames if it needs to.
 */
import shotsJson from '../footage/shots.json';
import type { Scene } from './edit';

export type Mark = {
  label: string;
  t: number;
  frame: number;
  x?: number;
  y?: number;
  /** [left, top, right, bottom] in viewport px at the moment of the action */
  box?: [number, number, number, number];
};

type Shot = { clip: string; marks: Mark[] };
export const shots = shotsJson as unknown as { fps: number; shots: Record<string, Shot> };

/** Which take a scene's marks belong to — the same mapping capture/stills.mjs uses. */
export function takeOf(scene: Scene): string {
  if (scene.kind === 'braid') return 'braid';
  if (scene.id.startsWith('note')) return 'note';
  return 'thread';
}

export function markOf(scene: Scene, label: string): Mark | null {
  const take = shots.shots[takeOf(scene)];
  if (!take) return null;
  return take.marks.find(m => m.label === label) || null;
}
