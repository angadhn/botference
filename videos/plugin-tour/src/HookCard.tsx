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

export const HookCard: React.FC<{
  title?: string;
  /** the second line: smaller, accent colour, arriving a beat after the claim.
   *  v6's voice note put the film's plot on the card — the title is the map,
   *  the kicker is the mischief — and staggering the arrival is what makes the
   *  second line read as a raised eyebrow rather than as a subtitle. */
  kicker?: string;
  at?: number;
  kickerAt?: number;
}> = ({ title, kicker, at = 0, kickerAt }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + HOOK_REVEAL], [0, 1], {
    easing: anim.EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const kAt = kickerAt ?? at + 26;
  const k = interpolate(frame, [kAt, kAt + HOOK_REVEAL], [0, 1], {
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
          // (1-p) is the arrival; the -0.06/frame is a continuous drift of
          // about 2px a second that never stops. v5 holds this card past four
          // seconds, and a card whose last motion ends at 2.3s is a frame
          // freezedetect calls dead air — which it did, at 1.17–4.03s, before
          // the drift existed.
          transform: `translateY(${(1 - p) * anim.EMPHASIS - frame * 0.06}px)`,
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
      {kicker ? (
        <div
          style={{
            opacity: k,
            transform: `translateY(${(1 - k) * anim.EMPHASIS - frame * 0.06}px)`,
            marginTop: 34,
            fontFamily: brand.serif,
            fontStyle: 'italic',
            // 46px so the joke survives a phone: ~9.6px at 400px width, above
            // the 8px floor the labels are held to
            fontSize: 46,
            lineHeight: 1.2,
            letterSpacing: '-0.008em',
            color: brand.accent,
            textAlign: 'center',
          }}
        >
          {kicker}
        </div>
      ) : null}
      {/* One hairline of the brand accent, drawing itself AFTER the sentence
          has landed. It is not decoration: a card that reaches its final pixel
          at 1.0s and then holds to 2.8s is 1.8 seconds of a frozen frame, which
          reads as a stalled video and which ffmpeg's freezedetect will call
          dead air. The rule finishes at 2.0s instead, so the still part of the
          card is under a second. */}
      <div
        style={{
          marginTop: 54,
          // draws until 3.5s in — most of the v5 card's longer life — so the
          // still part of the card stays under freezedetect's 2s line
          width: interpolate(frame, [at + 26, at + 104], [0, 96], {
            easing: anim.EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
          }),
          height: 3,
          borderRadius: 2,
          background: brand.accent,
          opacity: p * 0.9,
          transform: `translateY(${-frame * 0.06}px)`,
        }}
      />
    </AbsoluteFill>
  );
};
