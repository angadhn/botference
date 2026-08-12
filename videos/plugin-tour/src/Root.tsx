import React from 'react';
import { Composition } from 'remotion';
import { PluginTour } from './PluginTour';
import { SiteLoop, loop, loopFrames } from './SiteLoop';
import { edit, totalFrames } from './edit';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id={edit.meta.id}
      component={PluginTour}
      durationInFrames={totalFrames}
      fps={edit.meta.fps}
      width={edit.meta.width}
      height={edit.meta.height}
    />
    {/* the ~13s muted loop for the site, cut from the same footage */}
    <Composition
      id={loop.meta.id}
      component={SiteLoop}
      durationInFrames={loopFrames}
      fps={loop.meta.fps}
      width={loop.meta.width}
      height={loop.meta.height}
    />
  </>
);
