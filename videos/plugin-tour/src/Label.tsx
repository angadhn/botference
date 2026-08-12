/**
 * The labels.
 *
 * Not captions. A caption narrates; a label names the thing you are looking at
 * and gets out of the way — three to six words, one at a time, top of frame.
 * The v1 cut had sentences in the lower left and they read as subtitles for a
 * film nobody was speaking in.
 *
 * Two rules from the storyboard, enforced here rather than remembered:
 *   1. Top-RIGHT, one at a time. Never two on screen together (edit.json owns
 *      that, and the render throws if it is broken).
 *   2. Never over the drawer. The drawer owns the right edge of every frame it
 *      is in — at 1.0 its left edge is at x=1500, and a camera pushed into it
 *      moves that edge LEFT on screen, so `right` is per-label: the x a label's
 *      right edge may not cross in the framing it plays over.
 *
 * Labels live OUTSIDE the camera, so a push-in never drags the type with it.
 */
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { anim, brand } from './anim';
import type { Label as LabelT } from './edit';

/** the drawer's left edge at scale 1.0, less a margin */
export const SAFE_RIGHT = 1436;

export const Labels: React.FC<{ labels?: LabelT[] }> = ({ labels }) => {
  const frame = useCurrentFrame();
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
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: 58,
              left: 0,
              width: c.right ?? SAFE_RIGHT,
              textAlign: 'right',
              opacity: p,
              transform: `translateY(${(1 - inP) * -anim.EMPHASIS}px)`,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                background: 'rgba(7,10,14,.90)',
                border: `1px solid ${brand.border}`,
                borderRight: `3px solid ${brand.accent}`,
                borderRadius: 9,
                padding: '13px 22px 15px',
                boxShadow: '0 14px 40px rgba(0,0,0,.40)',
                fontFamily: brand.serif,
                fontSize: 37,
                lineHeight: 1.1,
                letterSpacing: '-0.008em',
                color: brand.text,
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
