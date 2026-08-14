/**
 * The closing card: type and a QR code, set over the braid.
 *
 * The braid is footage (see capture/braid.mjs — it is the site's own SVG,
 * filmed), and it leaves the bottom third of the frame empty once the three
 * strands have fused into "the plan". That empty band is what this fills.
 *
 * The QR is the reason the card has a layout at all. A code somebody is meant
 * to scan off a playing video has real constraints: it must be big (the
 * storyboard says ≥240px at 1080p; this draws 288), it must keep its quiet zone
 * (capture/qr.mjs bakes four modules of margin INTO the image, so nothing here
 * can crop it away), it must be light-on-dark to match the card, and it must be
 * still and unfaded for long enough to acquire — which is why it lands with the
 * type rather than after it, and why edit.json's `fadeOut` is short.
 */
import React from 'react';
import { interpolate, staticFile, useCurrentFrame, Img } from 'remotion';
import { anim, brand } from './anim';

const Line: React.FC<{
  delay: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ delay, children, style }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [delay, delay + anim.REVEAL], [0, 1], {
    easing: anim.EASE, extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return (
    <div style={{ opacity: p, transform: `translateY(${(1 - p) * anim.EMPHASIS}px)`, ...style }}>
      {children}
    </div>
  );
};

/**
 * Drawn size of the QR IMAGE, px at 1080p.
 *
 * The storyboard's floor of 240 is about the symbol, and the image is bigger
 * than the symbol: capture/qr.mjs bakes four modules of quiet zone into the
 * png on every side, so a version-2 code is 25 modules of data inside 33
 * modules of picture. 330 image px therefore buys 25/33 x 330 = 250 px of
 * actual symbol, which is what capture/verify-qr.mjs measures off a frame of
 * the finished file.
 */
export const QR_PX = 330;

export const TitleCard: React.FC<{
  title?: string;
  subtitle?: string;
  /** one small line of brand voice under the url — a garnish, not a focal
   *  text, so it sits below the phone-legibility floor on purpose and the url
   *  above it stays the line a phone must read */
  tag?: string;
  at?: number;
  qr?: boolean;
}> = ({ title, subtitle, tag, at = 0, qr }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      right: 0,
      // low enough that the QR's dark panel clears the braid's lowest strand —
      // a code with a glowing sine wave running through the corner of it is a
      // code a phone hunts for
      bottom: 62,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 54,
    }}
  >
    {qr ? (
      <Line delay={at} style={{ flex: 'none' }}>
        <Img
          src={staticFile('qr.png')}
          style={{
            width: QR_PX,
            height: QR_PX,
            display: 'block',
            borderRadius: 6,
            // the symbol's own quiet zone is inside the png; this is only the
            // seam between the card's black and the code's black
            boxShadow: '0 0 0 1px rgba(242,246,250,.12), 0 18px 48px rgba(0,0,0,.55)',
          }}
        />
      </Line>
    ) : null}
    <div style={{ textAlign: qr ? 'left' : 'center' }}>
      <Line
        delay={at}
        style={{
          fontFamily: brand.serif,
          fontSize: 78,
          lineHeight: 1.02,
          letterSpacing: '-0.022em',
          color: '#f2f6fa',
          textShadow: '0 6px 40px rgba(0,0,0,.6)',
        }}
      >
        {title}
      </Line>
      <Line
        delay={at + anim.STAGGER}
        style={{
          marginTop: 20,
          fontFamily: brand.mono,
          // the url is the one line of the close a phone viewer must be able
          // to read (the QR covers everyone else); 26px was 5.4px at phone
          // width, 38px is ~8px
          fontSize: 38,
          letterSpacing: '0.1em',
          color: brand.accent,
        }}
      >
        {subtitle}
      </Line>
      {tag ? (
        <Line
          delay={at + anim.STAGGER * 2}
          style={{
            marginTop: 16,
            fontFamily: brand.serif,
            fontStyle: 'italic',
            fontSize: 32,
            letterSpacing: '0.01em',
            color: brand.muted,
          }}
        >
          {tag}
        </Line>
      ) : null}
    </div>
  </div>
);
