# Botference city · art sets one, two and three

Original artwork generated with the built-in `image_gen` tool. The inspected tiny.london preview by Boris Starkov supplied the direction: detailed architecture, restrained daylight, lush greenery, and painterly pixel texture. No map imagery was extracted or reused. Exact generation and correction prompts are in `generation.json`; untouched selected outputs are in `source/`.

## Palette and light

| Material | Colour targets |
| --- | --- |
| Limestone | `#c9bd98`, highlights `#ded4b8` |
| Slate | `#58666b` |
| Weathered copper | `#6e9485` |
| Warm brick | `#9b6f58` |
| Grass / leaves | `#72875b`, `#597949`, deep `#344f3f` |
| Woodland litter | `#83735a` |
| Cobbles | `#b2ad96` |
| Water | `#6c9190` |
| Soft shadow | `#3d5149` |

These are generation targets, not a locked indexed palette. Keep the natural texture variation. Daylight comes from upper left; right-facing walls are darker. Shadows fall toward lower right. Avoid black outlines, saturated toy colours, giant heads, exaggerated roofs, and changes of sun direction. Keep glass lightly tinted and foliage irregular.

## Scale and placement

- One ground tile is exactly **128×64 px**. Ground axes are `(64,32)` and `(-64,32)`. Tile images have zero thickness and transparent corners. Their anchor is `(64,32)`.
- All PNG dimensions and pixel anchors are in `manifest.json`. Render at `origin + (64*(u-v),32*(u+v)) - anchorPx`. An upright sprite's anchor is its front ground contact; its declared rectangular footprint extends backwards along both axes. Trees may overhang their planting footprint.
- Native standing human height is **128 px**, twice the tile's screen height. The ladder extends above the engineer; his image is taller to retain human scale. The naturally smaller cat is 42 px tall including its raised tail. Feet, not the centre of the image, meet the ground.
- Buildings occupy 4–8 tiles per axis. This gives their doors a useful scale beside the requested tall residents. Do not shrink a building independently to fit a single tile. Use the footprint for occupancy, not the transparent image rectangle.
- The **1600×1000 sample uses one common 0.25 scale**, so its tiles are 32×16 px and humans about 32 px tall. `sample-scene.json` records every placement. It includes all 43 sprite IDs and both variants of all nine named building types. The brief's count of eight conflicted with its nine named types; none were omitted.
- Pixel placement and ground coverage are exact. The separately generated architectural details approximate the shared 2:1 camera; roof and facade slopes are not CAD-calibrated. Anchors are placement contacts, not extracted structural survey points.
- `build-art.mjs` crops transparent margins, resizes the generated PNGs, clips terrain to an exact diamond, and composites the scene. It does not draw substitute artwork. Use `node build-art.mjs` with ImageMagick 7 installed. The final terrain uses a small interior crop to remove irregular generated tile borders; original alpha remains in `source/`.

## Shuttered variants

Keep the same building, footprint, silhouette, camera, palette, and anchor. Close doors and add fitted, weathered sage or oak shutters only where architecturally plausible. Turn off interior glow. Leave the garden tended and walls intact: quiet, not abandoned. Do not darken the whole sprite or add padlocks, warning symbols, rubble, fog, or status text. Use the selected source PNG as an edit target. Set two includes all 18 original building variants with the suffix `-shuttered`, plus `variantOf` and `state` fields. Their dimensions, footprints and anchors exactly match their originals. Generated details and silhouettes remain approximate matches.

## Files and scope

Set one contains 43 placeable PNGs: 7 ground, 6 vegetation, 18 buildings, 12 residents. Its files remain unchanged. `sample-neighbourhood.png` has a transparent exterior; `sample-neighbourhood-light.png` is the same composition on pale paper for easy inspection. `sprite-catalogue.png` now labels all 95 assets. Residents are decorative and imply no agent activity.

## Set two: terrain, health and quiet buildings

52 additions: 8 terrace edges, one stair ramp, two bridges, six flat ground tiles (deep water, two shorelines, sand, causeway, heather), a rock outcrop, two hospitals, a rehabilitation garden, 18 shuttered buildings, seven props and six residents. Exact built-in image_gen prompts and selected output paths are recorded in `generation-2.json`; untouched outputs are preserved in `source/set-2/`.

Run `node build-art-2.mjs` to repack set two and compose its catalogue and sample. Run `node verify-art.mjs` to check both sets. `build-art.mjs` also preserves and rebuilds set two. The frozen `manifest-set-1.json` lets verification detect accidental changes to any original entry. The main manifest keeps version 1 and its existing fields, and adds optional `samples`, `variantOf`, `state`, `stepPx` and terrain surface metadata.

The ground lattice remains 128×64. Terrace sprites occupy a **128×80 transparent canvas**, with **anchor (64,48)** at the lower tile centre and a **16px step**. At the sample's common 0.25 scale a step is 4px. Objects on a plateau subtract its `zPx` from their projected Y coordinate. The second sample stacks three identical shallow steps below its observatory; elevation is scenery, not status.

Front-facing edges `se` and `sw` carry a raised lawn top with a descending stone face. Rear-facing `ne` and `nw` carry lower lawn with a retaining face rising at the back. `outer-s` joins the two front faces; `outer-n` joins the two rear faces. `inner-e` and `inner-w` make half-tile concave notches. Their exact top polygons and face endpoints are recorded in `edgeGeometry`. Layer these with ground in increasing u+v order, with the edge after ground at the same coordinate. The sample scene records placements and elevations.

The image model's separate terrace drawings did not share exact geometry. Packing therefore resamples **generated** grass and the selected generated limestone faces onto shared exact meshes. No replacement grass or stone was painted in code. All eight original generated candidates remain available. This also keeps wall colours and grass continuous across joins. Deep water repeats a small interior crop of its generated ripples in screen coordinates to avoid directional brightness bands.

Adults retain 128px figure height; the children are 88px and 96px. Props use the same world scale. Hospitals use 8×8 footprints. The sample and its light-background companion are exactly 1600×1000, with open space between the observatory hill, health campus and causeway-linked launch island.

`validation.json` reports dimensions, alpha, hashes, original-asset preservation, all shuttered anchors, ground coverage and isolated raised-terrace/front-face coverage. Coverage is not a certificate of CAD geometry or every possible terrain arrangement. The packed atlas contains the additions; automatic selection of hospitals, shuttered art, hill and island terrain remains a separate UI task.

## Set three: destination worlds

Three single-frame `planet` sprites: `planet-blog`, `planet-spacehq`, and `planet-textbook`. Each was generated separately with built-in `image_gen`; exact prompts are in `generation-3.json`, and original RGBA outputs are preserved in `source/set-3/`. Blog has a glass writing dome, books and printing press; SpaceHQ has a hangar, mission-control dome and docked rocket; Textbook has an amphitheatre, chalkboard, orrery, books and observatory. All have rock, roots, cloud wisps and a copper cable with a brass mooring eye.

Each uses a 3×3 footprint: 384px content width, plus 4px transparent padding on each side. These are symbolic miniature worlds. They are deliberately smaller than the human-scale city buildings. `anchorPx` and the optional `routeAnchorPx` both identify the centre of the brass mooring eye; render routes to that point. The centre may be transparent because it is a ring. Do not use the rock tip or transparent rectangle as a route endpoint.

`sample-planets.png` is 1600×1000 with a transparent exterior; `sample-planets-light.png` is the same scene on pale paper. The corner of the city and all three worlds share **one 0.5 scale**: ground tiles are 64×32px, and worlds are about 192px across. `sample-scene-3.json` records placements and screen anchors. No relationship routes are inferred in the art sample.

Run `node build-art-3.mjs` to crop near-transparent margins, resize the generated pixels while retaining alpha, compose the sample, and regenerate the 98-sprite catalogue. Earlier build scripts also rebuild set three. `manifest-set-2.json` freezes all 95 prior entries; `verify-art.mjs` checks those entries and file hashes, all three worlds, route rims, sample bounds and the existing terrain checks. `planet-catalogue.png` is a compact labelled preview. The live atlas has not been repacked for these additions; planet selection and project mapping belong to the UI integration pass.

## Set four: agent characters

57 additional transparent PNGs in the `agent` category: 40 body frames (two families × two idle views, two working views and four frames in each of four walking directions), five status badges, and twelve role overlays (six roles × two front-facing views). Claude uses an original orange sunburst head, cream shirt and rust clothes; Codex uses an original ivory three-loop knotted head, charcoal clothes and a teal shirt. The brief explicitly requests oversized emblem heads here; that is an exception to the general resident head-proportion guidance above. Neither emblem is a real logo.

All artwork was generated separately with built-in `image_gen`. Exact prompts and selected paths are in `generation-agents.json`; untouched RGBA originals are in `source/agents/`. `build-agents.mjs` mechanically crops transparent margins, resizes and registers the generated pixels, and composites the existing building/terrain artwork into the sample. It does not draw character artwork. It preserves all 98 previous manifest entries, frozen in `manifest-set-3.json`.

Body frames are **160×160**, with **anchor (80,144)** and **128px figure height**. The upper emblem silhouette is registered to X=80 independently of the swinging limbs; feet meet the common Y=144 ground baseline. `agent-registration.json` records source crops and placements. This fixed registration prevents canvas drift; the separately generated poses still have small texture and silhouette differences. The four-frame loop runs at 140ms per frame. `sw` and `se` face front-left/front-right, `nw` and `ne` face back-left/back-right; see the manifest direction vectors. Frames are generated views, not mirrored images with reversed lighting.

Role overlays share the body canvas and anchor. Draw them at exactly the same image origin on **idle only**, using the matching `sw` or `se` direction. Each overlay fits both families. Roles are writer scarf, engineer goggles, scientist coat, teacher chalk holder, builder helmet and reviewer glasses. They are not fitted to walking or working arms. Badges have a 32×32 canvas, anchor (16,31), and attach offset (0,-136) from the character's ground anchor. They remain independent of role and pose. Badge meaning is dots/thinking, hourglass/waiting, tick/done, cross/failed and grey plug/disconnected.

`sample-agents.png` is **1600×1000**, on pale paper, with all sprites at **0.75 scale**: 96px-tall agents and 96×48 ground tiles. It uses the original reading room and workshop. This is an artwork demonstration, not evidence of live agent activity. `agent-walk-proof.png` shows all 32 walk frames; `agent-walk-proof.gif` animates the eight directions at fixed anchors. `agent-role-proof.png` shows all 24 family/direction/role combinations. The complete `sprite-catalogue.png` includes all 155 sprites; `agent-catalogue.png` isolates the 57 additions.

Run `node build-agents.mjs` to repack this set and regenerate previews, then `node verify-art.mjs`. The verifier preserves earlier checks and adds asset counts, all required direction/pose combinations, source existence, shared canvas and ground baseline, measured head-axis tolerance, distinct walk-frame hashes, role alignment, badge offsets and sample bounds. The live atlas and client-side agent-presence behaviour remain a later UI integration task.
