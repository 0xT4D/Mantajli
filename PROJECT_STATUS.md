# Project status

_Last updated: 2026-10-24 (session 4, in progress)_

Read this first, then `NEXT_SESSION.md`, `PROGRESS.md`, `TASKS.md`, `DECISIONS.md`,
`REFERENCE_VIDEO_ANALYSIS.md`. Verify against `git log` / `git status` and the code — a line here
is a claim, not proof.

## Architecture (one paragraph)
TypeScript monorepo. `packages/core` (pure: zod schema, immer commands, curves, composition plan,
registries, camera rigs, scene templates) → `packages/engine` (Node: sessions, media + audio
analysis + SFX synthesis, FFmpeg graph builder `render/ffgraph.ts`, Blender runner +
`blender/mantagli_scene.py`, AI tools, RPC server) → `packages/mcp` (MCP stdio) and
`apps/desktop` (React UI + live canvas compositor `lib/liveCompositor.ts`, Tauri shell).
Every feature = core registry/command + FFmpeg (or Blender) renderer + live approximation + AI
tool + test.

## Reference benchmark
- Videos: `example_videos/` (3 files, untracked, ~290 MB): Cybercamp7_Teaser.mp4,
  Securinets_Quals_Teaser_HQ.mp4, tga_teaser.mp4.
- Analysis: `REFERENCE_VIDEO_ANALYSIS.md`; frame sheets in `docs/reference/`
  (regenerate: `node scripts/reference-frames.mjs`).
- Benchmark montage "NEON QUEST": `scripts/benchmark/` (score.mjs + build.ts, stages build /
  stills / export). Project and renders in `D:\MantagliBenchmark` (not in git). Status: see
  "Benchmark log" below.

## Session 4 work (uncommitted unless `git log` says otherwise)
| Feature | Where | Verified by |
|---|---|---|
| Easings expoIn/Out/InOut, backIn/Out | core `timeline.ts ease`, ffgraph `easeExpr`, Blender `INTERP` | `ffgraph.test` (FFmpeg expr = core curve, every easing); `cinematic.e2e` (rendered x within 1.5 px) |
| Scramble/decode text animation | core `textLinesAt` | `animation.test`; `cinematic.e2e` frames viewed |
| Adjustment layers (clip type `adjustment`) | schema, ffgraph (before/during/after segments + concat), liveCompositor, Timeline, OTIO, AI tool | `cinematic.e2e` (range render switches exactly at its frames; layers above untouched) |
| Lens/CRT distortion, scanlines; `crtMonitor` look | effects registry, ffgraph (`lenscorrection` on RGBA after colour fx; `drawgrid`), live remap | `cinematic.e2e` (edge within 2 px of core formula; scanline rows exact) |
| Two-sided transitions: whipLeft/Right/Up/Down, zoomThrough, glitchCut | core `layerCurves` + `transitionFx` (blur from curve velocity), plan `transitionOut`, ffgraph `transitionStage` (premultiplied dblur pair / gblur / rgbashift via sendcmd), live smear | `animation.test` (shots butted, zoom continuous at cut); `cinematic.e2e` (seam where the curve puts it, no dark band, frame always covered) |
| Render cache versioning | `RENDERER_VERSION` in ffgraph (bump when output changes); Blender script hash in scene keys | (bug found: renderer changes reused stale previews) |
| Timeline Insert menu: title / colour / adjustment / sound effects at playhead | `Timeline.tsx InsertMenu` | typecheck; UI screenshot pending |
| 3D media planes (image/video, emissive or lit) | schema `media`, Blender `add_media` | `cinematic.e2e` (video texture advances; stageReveal starts screen-filled) |
| Camera paths + `pathProgress`, camera moves (orbit/dolly/crane/truck, snap stops), 3D shake | core `cameraRigs.ts`, `scene.cameraMove`, Blender `add_path`/`add_shake` | `commands.test` (orbit radius, stop keys); `cinematic.e2e` (holds static, moves between) |
| Scatter instancing (pile/disc/ring/grid/box, geometry nodes) | schema `scatter`, Blender `add_scatter` | `cinematic.e2e` (2600 coins render) |
| Materials: grid + smoke patterns; spot cone/blend; two-tone text (side material) | schema, Blender | renders viewed (`tests/.tmp/templates`) |
| 6 reference templates: arcadePortal, turntableStage, synthwaveHorizon, treasureHoard, stageReveal, metalTitle | `sceneTemplates.ts` (`fillDistance` for portals) | renders viewed and tuned (lighting/colour iterations) |
| Fixed: Blender interpolation applied to all curves sharing a frame | `animate()` filters by data path | |
| Fixed: "Look at: None" never cleared (JSON drops undefined) | `scene.updateObject unset` | `commands.test` |
| Music structure: sections (intro/build/drop/breakdown/change/outro) → section markers | `audioAnalysis.ts detectSections`, `marker.setBeats sections`, ruler labels | `cinematic.e2e` synthetic track; references: 7/9 boundaries within 0.6 s |
| Procedural SFX (whoosh, riser, impact, hit, glitch, blip, downlifter) + anchored placement | `media/sfx.ts`, `engine.generateSfx`, `sfx_generate` tool, Insert menu | `sfx.test` (shape, level, determinism, placement); spectrograms viewed |
| Scene bake to video asset | `engine.bakeScene`, `scene_bake` tool | used by the benchmark |
| AI tools updated: scene_create (mediaAssetId/count/stops), scene_add_object (media/scatter), scene_camera_move, scene_bake, sfx_generate, light spot, text side material, material pattern, capabilities notes | `ai/tools.ts` | unit suite (tool registry) |
| UI: scene inspector (media/scatter/shake/spot/edges/pattern/camera move/key easing), scene creation form (screen/stations/snap on beats) | `Inspector.tsx`, `MediaBrowser.tsx` | typecheck; UI screenshot pending |

Tests at last run (2026-10-24): unit 64/64; `cinematic.e2e` 10/10. Full `npm test` (with the
older e2e files), feature sweep and UI sweep not yet re-run this session.

## Benchmark log
- (in progress) build stage running.

## Next steps (in order)
1. Finish the benchmark: stills review against the references, fix defects, export + verify.
2. UI screenshots of the new controls (Insert menu, adjustment clip, inspector sections).
3. Full `npm test`, `npx tsx scripts/feature-sweep.ts`, `node scripts/ui-sweep.mjs`.
4. Update README/PROGRESS/TASKS/DECISIONS/NEXT_SESSION for session 4.

## Known issues / limits (session 4)
- Live preview: vignette approximated (radial gradient); lens distortion nearest-neighbour;
  directional motion blur is an 8-sample smear; grain/CA still export-only live.
- Section detection misses short breaks (< 4 s) and some timbral cuts; it is an editable
  suggestion (markers), never applied to the edit automatically.
- Video textures in Blender play one video frame per scene frame (a warning is emitted when the
  frame rates differ).
- Portal hand-off colour: the screen is rendered through the scene's view transform (AgX by
  default), so the cut into the real clip can shift tone slightly; motion blur hides most of it.
- No physics (coin bursts, shattering) — instancing only.
