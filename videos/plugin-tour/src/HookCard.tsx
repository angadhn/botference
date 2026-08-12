/**
 * The hook card — three seconds, one sentence, no braid.
 *
 * The v1 cut opened on eight seconds of logo animation, which is eight seconds
 * spent on the company rather than on the idea. This one says what the thing is
 * before it shows you anything, and then gets out of the way. There is no
 * transition out: a dissolve would suggest the card and the drawer are the same
 * picture, and they are a claim and its evidence.
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { anim, brand } from './anim';

/**
 * Slower than the closing card's REVEAL on purpose. A card whose type has
 * finished arriving by 0.8s and then sits perfectly still until the cut is a
 * frame ffmpeg's freezedetect calls dead air, and a viewer calls a stalled
 * video. Arriving over a second and a half is both the fix and the better
 * reading of the line.
 */
const HOOK_REVEAL = 44;

export const HookCard: React.FC<{ title?: string; at?: number }> = ({ title, at = 0 }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + HOOK_REVEAL], [0, 1], {
    easing: anim.EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        background: brand.bg,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 190px',
      }}
    >
      <div
        style={{
          opacity: p,
          transform: `translateY(${(1 - p) * anim.EMPHASIS}px)`,
          fontFamily: brand.serif,
          fontSize: 76,
          lineHeight: 1.24,
          letterSpacing: '-0.018em',
          color: '#f2f6fa',
          textAlign: 'center',
          textWrap: 'balance',
        }}
      >
        {title}
      </div>
      {/* One hairline of the brand accent, drawing itself AFTER the sentence
          has landed. It is not decoration: a card that reaches its final pixel
          at 1.0s and then holds to 2.8s is 1.8 seconds of a frozen frame, which
          reads as a stalled video and which ffmpeg's freezedetect will call
          dead air. The rule finishes at 2.0s instead, so the still part of the
          card is under a second. */}
      <div
        style={{
          marginTop: 54,
          width: interpolate(frame, [at + 26, at + 68], [0, 96], {
            easing: anim.EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
          }),
          height: 3,
          borderRadius: 2,
          background: brand.accent,
          opacity: p * 0.9,
        }}
      />
    </AbsoluteFill>
  );
};
