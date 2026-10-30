# Botference agent sprites

Two character families generated with the built-in `image_gen` tool: Claude (orange sunburst, cream/rust) and Codex (ivory knot, charcoal/teal). No real logos. The original city art is unchanged.

## Contents

- 40 transparent body PNGs: each family has idle and working poses facing front-left/front-right, plus four walk frames in each of four isometric directions.
- Five independent badges: thinking, waiting, done, failed, disconnected.
- Six role overlays, each facing front-left/front-right: writer scarf, engineer goggles, scientist coat, teacher chalk, builder helmet, reviewer glasses. These twelve overlays fit both families' idle sprites.
- Eight horizontal walk strips, a fixed-anchor animated proof, a role-fitting proof, a 1600×1000 scene and a regenerated 155-sprite catalogue.
- Full prompts and original generated outputs, build script, registration data and verification results.

## Placement

Body and role overlay canvases are 160×160. Each body's figure height is 128px, the same as city residents. Place the sprite's `(80,144)` anchor on the projected ground position. Draw a matching role overlay at the same image origin, on idle poses only.

Directions are `sw` front-left, `se` front-right, `nw` back-left and `ne` back-right. A walk ID is `agent-claude-walk-sw-1`; iterate frames 1,2,3,4 at 140ms per frame. Each horizontal strip contains four 160×160 cells and uses the same cell-relative anchor.

Badges use a 32×32 canvas and anchor `(16,31)`. Their attach position is the character ground position plus `(0,-136)`, before applying world scale. For a scene scale `s`, draw a body at `ground - s × anchor` and a badge at `ground + s × (attachOffset - badgeAnchor)`.

Use `manifest.json` for filenames, size, hashes, category, family, pose, direction, frame and overlay metadata. The new category is `agent`; `agentKind` distinguishes `body`, `badge` and `overlay`.

## Rebuild and check

From the city art directory, with Node and ImageMagick 7 available:

```
node build-agents.mjs
node verify-art.mjs
```

All generated source pixels are preserved. Packing only crops, resizes, registers and composites them. The full verifier also checks earlier terrain and planet art. `manifest-set-3.json` freezes all 98 preceding entries. Earlier art build scripts chain into this build so the agent set is retained.

The sample uses the existing reading room, workshop and cobbled road at one common 0.75 scale. It is a static art demonstration: the badges are example states, not reported activity. This delivery does not add live presence, click handling, route highlighting or movement to the city UI, and does not repack its runtime atlas.

Generated frames can vary slightly in texture and silhouette. Foot baselines and emblem axes are registered mechanically, but these are four-frame illustrated cycles rather than a rigged character. Role overlays are aligned to idle, not animated arms.

`generation-agents.json` records the exact prompt per image, selected output path and correction history. `source/agents/` holds the originals. The downloadable agent pack includes these sources and all final agent PNGs; the complete existing city art remains in the repository.
