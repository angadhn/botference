/**
 * The labels.
 *
 * v2 put them across the top of the frame and the note back was exact: they
 * pulled the eye away from the thing that was happening. A label at the top of
 * a 1920px frame and an action at (1560, 750) are two places, and a viewer with
 * three seconds cannot be in both.
 *
 * So a v4 label is not a caption and not a lower third. It is a small flash of
 * type BESIDE the thing it names — by the highlight as it lands, to the left of
 * the Run button as it is pressed, under the ✓ as it files — on screen for
 * about a second and a half, and then gone. The rules, enforced here rather
 * than remembered:
 *
 *   1. NEVER at the top of frame, and never centred over the action. `place`
 *      picks a side and `GAP` keeps a hand's width between the type and the
 *      element, so a label cannot cover what it points at.
 *   2. The anchor is MEASURED, not typed. `anchorMark` names one of the marks
 *      capture.mjs recorded during the take (footage/shots.json), which carry
 *      the viewport box of the thing that moved. A co-ordinate written into
 *      edit.json by hand is a guess that a re-shoot silently invalidates.
 *   3. The camera moves the action around, so the anchor is projected through
 *      the scene's own camera at the current frame (Camera.project).
 *   4. If the projected place would put the label off the frame, or the cue has
 *      no anchor at all, it falls back to the BOTTOM-RIGHT corner. Never the
 *      top, never the centre.
 *   5. One at a time. edit.ts throws if two overlap in a scene.
 *
 * Labels live OUTSIDE the camera element, so a push-in never drags the type
 * with it — only the anchor point moves.
 */
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { anim, brand } from './anim';
import { project } from './Camera';
import { markOf } from './shots';
import type { Label as LabelT, Scene } from './edit';

/** clear space between the type and the element it names, in frame px */
const GAP = 30;
/** the frame's own margin — nothing is drawn closer than this to an edge */
const EDGE = 40;
/** measured off the rendered type; only used to keep a label inside the frame */
const APPROX_H = 46;
const APPROX_CH = 15.2;

type Placed = { left?: number; right?: number; top: number; align: 'left' | 'right' };

function place(
  cue: LabelT, scene: Scene, frame: number, W: number, H: number,
): Placed {
  const corner: Placed = { right: EDGE, top: H - EDGE - APPROX_H, align: 'right' };
  if (cue.corner || !cue.anchorMark) return corner;
  const mark = markOf(scene, cue.anchorMark);
  if (!mark || !mark.box) return corner;
  const [l, t, r, b] = mark.box;
  const where = cue.place || 'below';
  // the corner of the element the label hangs off
  const px = where === 'left' ? l : where === 'right' ? r : l;
  const py = where === 'above' ? t : where === 'below' ? b : (t + b) / 2;
  const p = project(scene.camera, frame, W, H, px, py);
  const width = cue.text.length * APPROX_CH + 44;

  let out: Placed;
  if (where === 'left') out = { right: W - (p.x - GAP), top: p.y - APPROX_H / 2, align: 'right' };
  else if (where === 'right') out = { left: p.x + GAP, top: p.y - APPROX_H / 2, align: 'left' };
  else if (where === 'above') out = { left: p.x, top: p.y - GAP - APPROX_H, align: 'left' };
  else out = { left: p.x, top: p.y + GAP, align: 'left' };

  // Off the frame is not a placement. A label whose anchor the camera has
  // pushed out of shot goes to the corner rather than to the nearest edge,
  // because a label clamped against an edge no longer points at anything.
  const left = out.left ?? W - (out.right ?? 0) - width;
  if (left < EDGE || left + width > W - EDGE
      || out.top < EDGE * 2 || out.top + APPROX_H > H - EDGE) return corner;
  return out;
}

export const Labels: React.FC<{ scene: Scene; width: number; height: number }> =
({ scene, width, height }) => {
  const frame = useCurrentFrame();
  const labels = scene.labels;
  if (!labels) return null;
  return (
    <>
      {labels.map((c, i) => {
        const end = c.at + c.dur;
        if (frame < c.at - 1 || frame > end + anim.OVERLAY_OUT + 1) return null;
        const inP = interpolate(frame, [c.at, c.at + anim.OVERLAY_IN], [0, 1], {
          easing: anim.EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });
        const outP = interpolate(frame, [end, end + anim.OVERLAY_OUT], [1, 0], {
          easing: anim.EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
        });
        const p = Math.min(inP, outP);
        const pos = place(c, scene, frame, width, height);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: pos.left,
              right: pos.right,
              top: pos.top,
              textAlign: pos.align,
              opacity: p,
              // arrives from the side it sits on, so the motion reads as
              // "attached to that" rather than as type flying in
              transform: `translateY(${(1 - inP) * 8}px)`,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                background: 'rgba(9,12,17,.93)',
                borderLeft: `3px solid ${brand.accent}`,
                borderRadius: '3px 7px 7px 3px',
                padding: '8px 15px 9px 13px',
                boxShadow: '0 8px 26px rgba(0,0,0,.35)',
                fontFamily: brand.serif,
                fontSize: 27,
                lineHeight: 1.12,
                letterSpacing: '-0.006em',
                color: '#eef3f8',
                whiteSpace: 'nowrap',
              }}
            >
              {c.text}
            </span>
          </div>
        );
      })}
    </>
  );
};
