/** The edit, loaded. Types plus the two derivations everything else needs. */
import editJson from '../edit.json';
import type { CameraEaseName } from './anim';

export type Label = {
  text: string;
  /** first frame of the label, relative to its scene */
  at: number;
  dur: number;
  /**
   * WHICH action this label names: one of the marks capture/capture.mjs recorded
   * during the take (footage/shots.json). The marks a label may use carry the
   * viewport box of the thing that moved, so the type is placed against a
   * MEASURED position rather than a typed-in guess. No anchor => bottom-right.
   */
  anchorMark?: string;
  /** which side of that box the type sits on. Default 'below'. */
  place?: 'above' | 'below' | 'left' | 'right';
  /** put it in the bottom-right corner and do not look for an anchor */
  corner?: boolean;
};

export type CameraKey = {
  /** frame, relative to the scene */
  at: number;
  scale: number;
  /** [x, y] as fractions of the frame */
  origin: [number, number];
  ease?: CameraEaseName;
};

export type Scene = {
  id: string;
  /** 'card' draws type only; 'footage' and 'braid' draw a clip under it */
  kind: 'card' | 'braid' | 'footage';
  clip?: string;
  inFrame?: number;
  durationInFrames: number;
  rationale?: string;
  labels?: Label[];
  camera?: CameraKey[];
  /** cards only */
  title?: string;
  subtitle?: string;
  titleAt?: number;
  qr?: boolean;
  fadeIn?: number;
  fadeOut?: number;
};

export type Edit = {
  meta: { title: string; width: number; height: number; fps: number; id: string };
  scenes: Scene[];
};

export const edit = editJson as unknown as Edit;

/** Scene start frames on the master timeline — the same cumulative sum
 *  music/compose.mjs uses, so picture and score cannot drift apart. */
export const starts: number[] = edit.scenes.reduce<number[]>((acc, s, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + edit.scenes[i - 1].durationInFrames);
  return acc;
}, []);

export const totalFrames = edit.scenes.reduce((n, s) => n + s.durationInFrames, 0);

/**
 * The two rules of the film that a render can check for itself, checked at
 * import so a broken edit fails loudly instead of quietly shipping.
 *   - one label at a time, ever
 *   - 45 seconds, hard
 */
const CAP_SECONDS = 45;   // the storyboard's hard cap
if (totalFrames > CAP_SECONDS * edit.meta.fps) {
  throw new Error(`the edit is ${(totalFrames / edit.meta.fps).toFixed(2)}s — the cap is ${CAP_SECONDS}s`);
}
for (const s of edit.scenes) {
  const ls = (s.labels || []).slice().sort((a, b) => a.at - b.at);
  for (let i = 1; i < ls.length; i++) {
    if (ls[i].at < ls[i - 1].at + ls[i - 1].dur) {
      throw new Error(`two labels overlap in "${s.id}": ${JSON.stringify(ls[i - 1].text)} and ${JSON.stringify(ls[i].text)}`);
    }
  }
}
