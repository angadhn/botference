/**
 * The camera.
 *
 * A push-in on screen footage is a lie told with a transform: the pixels do not
 * get sharper, so the only honest version is one that never asks for more
 * detail than the source has. Everything here is `transform` — scale and
 * translate on a single element, composited, no re-layout, no filters — and
 * scale is capped so a move can be written carelessly in edit.json without
 * quietly turning 1080p into mush.
 *
 * A move is expressed as keyframes of (scale, origin), and BOTH interpolate.
 * Writing "the camera is here at frame 145" composes; writing "zoom from A to
 * B over 50 frames" does not, and two overlapping zooms with different origins
 * would snap. Origin is a fraction of the frame: [0.83, 0.65] is the Run
 * button, and it stays readable in the file a month later.
 */
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { CAMERA_EASE } from './anim';
import type { CameraKey } from './edit';

/** past this, 1920x1080 source starts to show its pixels */
const MAX_SCALE = 1.55;

export function cameraAt(keys: CameraKey[] | undefined, frame: number) {
  if (!keys || keys.length === 0) return { scale: 1, ox: 0.5, oy: 0.5 };
  if (frame <= keys[0].at) {
    return { scale: keys[0].scale, ox: keys[0].origin[0], oy: keys[0].origin[1] };
  }
  const last = keys[keys.length - 1];
  if (frame >= last.at) {
    return { scale: last.scale, ox: last.origin[0], oy: last.origin[1] };
  }
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].at <= frame) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const easing = CAMERA_EASE[b.ease ?? 'ease'];
  const opts = { easing, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
  return {
    scale: interpolate(frame, [a.at, b.at], [a.scale, b.scale], opts),
    ox: interpolate(frame, [a.at, b.at], [a.origin[0], b.origin[0]], opts),
    oy: interpolate(frame, [a.at, b.at], [a.origin[1], b.origin[1]], opts),
  };
}

export const Camera: React.FC<{
  keys?: CameraKey[];
  /** the size the source is drawn at */
  width: number;
  height: number;
  /** the hole it is seen through, when that differs — the site loop is a
   *  narrower frame than the footage it crops out of */
  viewW?: number;
  viewH?: number;
  frameOffset?: number;
  children: React.ReactNode;
}> = ({ keys, width, height, viewW, viewH, frameOffset = 0, children }) => {
  const frame = useCurrentFrame() + frameOffset;
  const { scale, ox, oy } = cameraAt(keys, frame);
  const s = Math.min(scale, MAX_SCALE);

  // Keep the framed point at the centre of screen, then refuse to show the void:
  // the window onto the source is (viewport / drawn size / scale) wide, so the
  // origin is clamped to half that from each edge and a move aimed past the
  // edge slides instead of revealing black.
  const halfX = Math.min(0.5, (viewW ?? width) / width / (2 * s));
  const halfY = Math.min(0.5, (viewH ?? height) / height / (2 * s));
  const cx = Math.min(Math.max(ox, halfX), 1 - halfX);
  const cy = Math.min(Math.max(oy, halfY), 1 - halfY);
  const tx = (0.5 - cx) * width * s;
  const ty = (0.5 - cy) * height * s;

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          // The drawn source is centred in the viewport BEFORE the transform.
          // Without this the two centres differ whenever the frame is narrower
          // than the footage, and every origin in the file is silently off by
          // half the difference — which is how the site loop first came back
          // with the drawer sliced down the right-hand edge.
          left: '50%',
          top: '50%',
          marginLeft: -width / 2,
          marginTop: -height / 2,
          width,
          height,
          transform: `translate3d(${tx}px, ${ty}px, 0) scale(${s})`,
          transformOrigin: '50% 50%',
          willChange: 'transform',
        }}
      >
        {children}
      </div>
    </div>
  );
};
