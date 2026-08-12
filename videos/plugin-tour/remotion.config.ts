// Assets are served from footage/ — the clips are already there, and score.wav
// is symlinked in beside them so the comp can reach both through staticFile().
import { Config } from '@remotion/cli/config';

Config.setPublicDir('footage');
Config.setVideoImageFormat('png');
Config.setChromiumOpenGlRenderer('angle');
Config.setOverwriteOutput(true);
