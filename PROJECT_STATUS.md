# Project status

_Last updated: 2026-10-25 (session 5)_

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

## Session 5 work (2026-10-25, cloud Linux container; all committed)
Ran on Ubuntu 24.04 with FFmpeg 6.1.1, Blender 4.0.2 (apt, EEVEE via Xvfb + llvmpipe, no GPU) and
Chromium for the UI scripts — a second platform for every session-4 claim below.

| Work | Where | Verified by |
|---|---|---|
| Portability: FFmpeg < 7 graph-file option (`-filter_complex_script`), Cycles without OpenImageDenoise (OptiX or no denoise + warning), Linux font substitutes (Liberation/DejaVu), browser scripts on Chromium, rpc.mjs home dir; feature sweep fixtures (font, system file, FFmpeg 6 diff graph) | `media/ffmpeg.ts`, `render/compose.ts`, `mantagli_scene.py set_denoiser`, `render/fonts.ts`, `scripts/browser.mjs`, `feature-sweep.ts` | e2e on Linux 10/33 before the fixes → 33/33 (35/35 with session-5 tests); feature sweep 123/123 |
| Settings → "Media folders" (`aiMediaFolders`): extra folders the AI/MCP may import from / export to; tests use it instead of relying on the checkout being under Desktop | `config.ts`, `ai/tools.ts mediaRoots`, Settings dialog | otio.e2e, montage.e2e |
| Live preview parity: media/3D pictures stylized in their own fit-scaled space like the export; exact cos⁴ vignette (core `vignetteFactor`), bilinear lens remap, live grain (`grainSigma`) and chromatic aberration, smear 8–32 copies; export vignette in RGB (`RENDERER_VERSION` 7) | `liveCompositor.ts`, core `effects.ts`, ffgraph | `scripts/ui-live-parity.mjs` (mean abs diff live vs exact, 0–255): vignette 7.5→0.4, lens 27.4→1.0, aberration 6.7→0.9, CRT look 21.2→3.6, grain σ 0→13.0 (exact 13.4); cinematic.e2e vignette = core formula |
| Live 3D frames requested only where rendered (`render.sceneCache` returns frame ranges); file-serving errors carry CORS | `Viewer.tsx`, `server.ts` | UI sweep "play" + "step" states were red with a partial draft cache |
| Transition presets: 8 built-ins + saved per project, applied to many clips in one step | core `TRANSITION_PRESETS`, `transitionPreset.*`, tools `transition_apply_preset` / `transition_save_preset`, Inspector Preset row | `commands.test`, feature-sweep step, UI sweep (apply/save/undo) |
| 3D titles fit the frame width (chromeTitle shares metalTitle's fitting; "NIGHT CITY" in 9:16 was ~2× too wide) | `sceneTemplates.ts fitTextSize` | `commands.test`; render viewed |
| Composition cache keys include the 3D default font | `engine.ts planKey` | (stale stills after a font change) |
| `data-clip-id` on timeline clips; UI sweep selects clips by it | `Timeline.tsx` | UI sweep 31/31 |
| Scatter bursts (physics-lite): pieces launch from their layout at a scene frame inside a cone, fly ballistically, bounce on a floor plane and settle flat; seeded, baked as one keyframe per frame per piece (motion blur and the saved .blend see the motion), ≤ 2000 pieces | schema `scatter.burst`, Blender `add_burst`/`burst_flight`, tool `scene_add_object scatterBurst`, Inspector Burst rows | cinematic.e2e (hidden before start, airborne, settled and still, identical on re-render); feature-sweep step; frames viewed |
| Fixed: scene object patches reset nested settings (patching a scatter's size reset its count/layout/seed; a camera's f-stop reset its focal length) — `patchSchema` now recurses through `.optional()`; `scene.updateObject` stores the parsed object; AI `scene_update_object` can `unset` | core `schema.ts`, `commands.ts`, `tools.ts` | `commands.test` (regression) |

Benchmark export: not feasible on this machine (no GPU: ~80–90 s per final 1080×1920 3D frame,
~26 s per draft quarter-scale frame; the montage needs ~840 3D frames). `scripts/benchmark/build.ts`
now takes `MANTAGLI_BENCH_ROOT` / `MANTAGLI_BENCH_FONT` so it runs anywhere; run `export` on the
dev machine.

## Session 4 work (committed in "init commit"; verified again on Linux in session 5)
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

Tests at last run (2026-10-25, Linux): unit 73/73, e2e 35/35 (all 11 files, ≈10 min on 4 CPU
cores), feature sweep 123/123 (all 65 tools), UI sweep 31/31, live parity script.

## Benchmark log
- Session 4 (dev machine): built, stills reviewed against the references, fixes applied.
- Session 5 (cloud, CPU only): export not run — hardware (see above). Script made portable.

## Next steps (in order)
1. On the dev machine (RTX): `npx tsx scripts/benchmark/build.ts export`, verify, compare with
   the references; re-run `npm test` and the sweeps there (renderer version 7 and the new Blender
   script re-render cached previews once).
2. Live Director run with a real API key.
3. Rebuild the installer with sessions 4–5 and test on a clean machine.
4. Shatter/fracture (text breaking into pieces) — the remaining physics gap.

## Known issues / limits (sessions 4–5)
- Live preview: grain is a different random pattern than the export's (same strength); scanline
  spacing follows the layer when its scale is animated only approximately; directional motion
  blur is a 8–32 copy smear (the export uses a dblur pair).
- Section detection misses short breaks (< 4 s) and some timbral cuts; it is an editable
  suggestion (markers), never applied to the edit automatically.
- Video textures in Blender play one video frame per scene frame (a warning is emitted when the
  frame rates differ).
- Portal hand-off colour: the screen is rendered through the scene's view transform (AgX by
  default), so the cut into the real clip can shift tone slightly; motion blur hides most of it.
- Physics is "lite": scatter bursts (ballistic flight + floor bounces, ≤ 2000 pieces, no
  piece-to-piece collisions); no shatter/fracture.
