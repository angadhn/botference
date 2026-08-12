/**
 * The site loop — the same footage, cut for the slot on botference.com where
 * the plugin screenshot currently sits.
 *
 * Two things make it different from the film and both are in loop.json: the
 * frame is narrower (it matches site/plugin-annotator.png's aspect, not 16:9,
 * so the footage is cropped rather than letterboxed), and it has to loop — see
 * Seam below for how the join is made and why it is not a dissolve.
 *
 * No captions, no sound, no title. It runs muted in a page.
 */
import React from 'react';
import {
  AbsoluteFill, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame,
} from 'remotion';
import { Camera } from './Camera';
import loopJson from '../loop.json';
import type { CameraKey } from './edit';

type Beat = {
  id: string;
  clip: string;
  inFrame: number;
  durationInFrames: number;
  fade?: number;
  camera?: CameraKey[];
};
type Loop = {
  meta: { width: number; height: number; fps: number; id: string; seam: number };
  beats: Beat[];
};

export const loop = loopJson as unknown as Loop;

export const loopStarts: number[] = loop.beats.reduce<number[]>((acc, _b, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + loop.beats[i - 1].durationInFrames);
  return acc;
}, []);

export const loopFrames = loop.beats.reduce((n, b) => n + b.durationInFrames, 0);

// The footage is 16:9; the loop frame is not. Draw the source tall enough to
// fill the height and let the sides crop — a letterbox would waste the very
// pixels this size cannot spare.
const DRAW_H = loop.meta.height;
const DRAW_W = Math.round((DRAW_H * 16) / 9);

const BeatView: React.FC<{ beat: Beat; frameOffset?: number }> = ({ beat, frameOffset = 0 }) => (
  <AbsoluteFill style={{ background: PAGE }}>
    <Camera
      keys={beat.camera}
      width={DRAW_W}
      height={DRAW_H}
      viewW={loop.meta.width}
      viewH={loop.meta.height}
      frameOffset={frameOffset}
    >
      <OffthreadVideo
        src={staticFile(beat.clip.replace(/^footage\//, ''))}
        startFrom={beat.inFrame - frameOffset}
        muted
        style={{ width: DRAW_W, height: DRAW_H, objectFit: 'cover' }}
      />
    </Camera>
  </AbsoluteFill>
);

/** A beat that dissolves in over `fade` frames. */
const Dissolve: React.FC<{ beat: Beat }> = ({ beat }) => {
  const frame = useCurrentFrame();
  const f = beat.fade ?? 0;
  const o = f ? interpolate(frame, [0, f], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  }) : 1;
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <BeatView beat={beat} />
    </AbsoluteFill>
  );
};

/**
 * The seam.
 *
 * The obvious move — dissolve the tail of the last beat into the head of the
 * first — does not work here, and the render says so plainly: the two beats are
 * different framings of different layouts (drawer open, drawer shut), so the
 * blend is two sets of body text ghosting through each other. It reads as a
 * broken file.
 *
 * So the loop breathes through the page's own paper colour instead. Both ends
 * dip to the paper colour below, which is the page's own ground and is already most of the
 * frame, so it lands as a beat rather than as a flash — and because the last
 * frame and the first frame are then the same flat colour, the join is exact.
 */
const PAGE = '#ffffff';   // capture/page.mjs's PAPER — the post paints no background at all

const Seam: React.FC = () => {
  const frame = useCurrentFrame();
  const { seam } = loop.meta;
  const out = interpolate(frame, [loopFrames - seam, loopFrames - 1], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const into = interpolate(frame, [0, seam - 1], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const o = Math.max(out, into);
  if (o <= 0) return null;
  return <AbsoluteFill style={{ background: PAGE, opacity: o }} />;
};

export const SiteLoop: React.FC = () => (
  <AbsoluteFill style={{ background: PAGE }}>
    {loop.beats.map((b, i) => (
      <Sequence key={b.id} from={loopStarts[i]} durationInFrames={b.durationInFrames} name={b.id}>
        <Dissolve beat={b} />
      </Sequence>
    ))}
    {/* spans the whole loop: it owns both ends of the dip */}
    <Seam />
  </AbsoluteFill>
);
