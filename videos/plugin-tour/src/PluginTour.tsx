/**
 * The composition. It reads edit.json and lays the scenes end to end; there is
 * no timing decision in this file that is not read from that one.
 */
import React from 'react';
import {
  AbsoluteFill, Audio, OffthreadVideo, Sequence, interpolate,
  staticFile, useCurrentFrame,
} from 'remotion';
import { brand } from './anim';
import { Camera } from './Camera';
import { HookCard } from './HookCard';
import { Labels } from './Label';
import { TitleCard } from './TitleCard';
import { edit, starts, totalFrames } from './edit';
import type { Scene } from './edit';

/** A cut between two takes is a hard cut. The only fades in the film are from
 *  and to black, and they are declared per scene in edit.json. */
const Fade: React.FC<{ inF?: number; outF?: number; length: number }> = ({ inF, outF, length }) => {
  const frame = useCurrentFrame();
  let o = 0;
  if (inF) o = Math.max(o, interpolate(frame, [0, inF], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  }));
  if (outF) o = Math.max(o, interpolate(frame, [length - outF, length], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  }));
  if (o <= 0) return null;
  return <AbsoluteFill style={{ background: '#000', opacity: o }} />;
};

const SceneView: React.FC<{ scene: Scene }> = ({ scene }) => {
  const { width, height } = edit.meta;
  if (scene.kind === 'card') {
    return (
      <AbsoluteFill>
        <HookCard title={scene.title} at={scene.titleAt} />
        <Fade inF={scene.fadeIn} outF={scene.fadeOut} length={scene.durationInFrames} />
      </AbsoluteFill>
    );
  }
  // startFrom trims the source clip; the scene's own frame 0 is the trim point,
  // which is what makes every `at` in edit.json scene-relative.
  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <Camera keys={scene.camera} width={width} height={height}>
        <OffthreadVideo
          src={staticFile((scene.clip || '').replace(/^footage\//, ''))}
          startFrom={scene.inFrame || 0}
          muted
          style={{ width, height, objectFit: 'cover' }}
        />
      </Camera>

      {scene.kind === 'braid' ? (
        <TitleCard title={scene.title} subtitle={scene.subtitle} at={scene.titleAt} qr={scene.qr} />
      ) : (
        // the labels are outside the Camera so a push-in never drags the type
        // with it — only the anchor they are placed against moves
        <Labels scene={scene} width={width} height={height} />
      )}

      <Fade inF={scene.fadeIn} outF={scene.fadeOut} length={scene.durationInFrames} />
    </AbsoluteFill>
  );
};

export const PluginTour: React.FC = () => (
  <AbsoluteFill style={{ background: '#000' }}>
    {edit.scenes.map((s, i) => (
      <Sequence key={s.id} from={starts[i]} durationInFrames={s.durationInFrames} name={s.id}>
        <SceneView scene={s} />
      </Sequence>
    ))}
    {/* music/compose.mjs renders this from the same scene boundaries */}
    <Sequence from={0} durationInFrames={totalFrames} name="score">
      <Audio src={staticFile('score.wav')} />
    </Sequence>
  </AbsoluteFill>
);
