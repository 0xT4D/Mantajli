# Progress

_Last updated: 2026-10-25 (session 6; sessions 4–6 detail in PROJECT_STATUS.md)_

## What works (verified this session)
| Area | Verification |
|---|---|
| Project model, commands, undo/redo, migrations, validation | 21 core unit tests |
| Sessions: create/open, autosave, backups, corrupt-file recovery, missing media + relink | `pipeline.e2e.test.ts` |
| Media: import (video/audio/image/model), probe, thumbnails, filmstrips, proxies, waveforms | e2e + UI screenshots |
| Beat tracking (120 BPM click track detected at 120 ± 3, 12-frame spacing) | e2e |
| FFmpeg composition: layers, transforms, keyframes, effects, transitions, text, audio | e2e export + frame inspection |
| Blender: chrome title, OBJ model turntable, draft + final renders, resumable cache | e2e + rendered frames viewed |
| Export presets + FFprobe verification + sample decode | e2e (1920×1080 and 1080×1920 exports) |
| AI tools (validation, atomic batches, approvals, import boundaries) | `ai.test.ts` |
| Director loop (scripted model): tool calls, error feedback/stop, approvals, cancel, revert | `ai.test.ts` |
| MCP stdio: standalone and bridged into a running engine | `mcp.test.ts` |
| Agent-style montage through MCP: beat cuts, 3D title, looks, previews, export | `montage.e2e.test.ts` |
| UI in a browser (Edge/Playwright): layout, timeline drag/trim, bin→timeline drop, exact frames | screenshots in session |
| Tauri desktop app (debug): window, engine supervision, clean shutdown | launched + screen capture |
| Engine bundle (single file + Node runtime) starts and renders 3D via Blender | smoke test + RPC-driven 3D still |
| Release build + NSIS installer (23.5 MB) | `npx tauri build`; release exe launched, bundled engine running |
| Preview cancellation leaves no cached output | cancelled a Blender preview mid-render via RPC |
| OpenTimelineIO export/import: lossless Mantagli round trip, foreign OTIO (Clip.1, relative paths, gaps, dissolves), AI media boundary | `otio.e2e.test.ts`; Export dialog + RPC import checked in the UI (screenshots) |
| Typewriter text, wipe left/right/up/down + iris transitions | `textfx.e2e` pixel checks; live vs exact screenshots |
| Motion effects: camera shake, beat pulse (beat/downbeat markers) | `animation.test` + `textfx.e2e` (positions/scales match core curves within 1.5 px) |
| Speed ramps (speed keyframes, 5 presets) | `speedramp.test` + `speedramp.e2e` (rendered frames = predicted source frames, PSNR) |
| Blend modes (8), letterbox, glitch (jitter + RGB split) | `textfx.e2e` pixel values vs formulas; live channel split screenshot |
| Music ducking under dialogue/SFX roles; loudness-normalised export | `animation.test` + `audio.e2e` (−12 dB dip measured; −14 LUFS via ebur128) |
| 3D render quality presets; Cycles GPU device reported | `cycles.e2e` (Cycles frame rendered on GPU backend) |
| Undo/redo history persisted across sessions | `history.test` |
| MCP long calls: export_render wait capped at 45 s, export_status waitSeconds | `montage.e2e` (polls; export takes ~100 s on this machine now) |
| Captions: SRT/WebVTT import (4 styles, safe-zone aware), SRT export | `captions.test`, `ai.test`; rendered caption looks viewed |
| Auto edit to beats (timeline.autoEdit, dialog, AI tool) | `speedramp.test`; run from the UI on the MCP montage project |
| Reverse clips (incl. audio) and freeze frames (ripple) | `speedramp.test` + `speedramp.e2e` (PSNR per frame, audio RMS) |
| Chroma key with despill; live per-pixel key | `textfx.e2e` pixel checks; live vs exact screenshot |
| Shape masks (frame coords, feather, invert); word-by-word text + kinetic captions | `animation.test` + `textfx.e2e` (feather ramp vs core formula); screenshots |
| Feature sweep: all AI/MCP tools + engine RPC over the real WebSocket, every effect / transition / text animation / blend mode rendered and checked | `npx tsx scripts/feature-sweep.ts` → 53/53 in session 3; 123/123 with all 65 tools in session 5 (Linux), report in `tests/.tmp/feature-sweep/REPORT.md` |
| UI sweep: every workspace, dialog, inspector, playback, shortcuts, no console errors | `node scripts/ui-sweep.mjs` (engine + Vite running) → 24/24 |
| 20 s promo made with Mantagli (original score, Blender 3D, UI shots, beat cuts, speed ramp, masks, captions, −14 LUFS) | `scripts/promo/*`; exported + verified 1920×1080, 20.0 s, H.264/AAC; `C:\Users\USER\Videos\Mantagli Promo\` |
| Release installer rebuilt with session-2 features up to chroma key | `npx tauri build` → `Mantagli_0.1.0_x64-setup.exe` 23.5 MiB (21:59) |
| Session-4 cinematic toolkit (easings, scramble, adjustment layers, lens/CRT, two-sided transitions, 3D media/paths/scatter, sections, SFX) | `cinematic.e2e`, `sfx.test` — re-verified on Linux in session 5 |
| Everything above on a second platform: Ubuntu 24.04, FFmpeg 6.1, Blender 4.0 (Xvfb, no GPU), Chromium | session 5: unit 73/73, e2e 35/35, UI sweep 31/31, feature sweep 123/123 (65/65 tools) |
| Live preview ≈ export for vignette, lens, scanlines, grain, aberration (layer-space stylize) | `scripts/ui-live-parity.mjs`: mean abs diff vignette 0.4, lens 1.0, aberration 0.9, CRT look 3.6 (were 7.5 / 27.4 / 6.7 / 21.2); grain σ 13.0 vs 13.4 |
| Transition presets (8 built-ins + saved per project) | `commands.test`, feature sweep, UI sweep (apply / save / undo in the inspector) |
| Scatter bursts (deterministic coin fountains) | `cinematic.e2e` burst test (before / airborne / settled + still / identical re-render), feature sweep |
| 3D titles fit 9:16 frames; scene object patches keep nested settings | `commands.test` |
| Music generator with exact beat grid / sections; energy climbs into the drop | `music.test` (the app's beat tracker recovers tempo and drop) |
| Voice-over: local engines (RHVoice, Pico, eSpeak, flite; SAPI untested here; Piper stand-in only), cloud (mock server), captions, ducking, re-voice | `voice.test`, feature sweep, UI sweep (compare engines) |
| Sound-design suggestions; mix meter; true-peak limiter; two-pass loudness target (±0.5 LU) | `soundDesign.test`, `sounddesign.test`, `audio.e2e`, ARENA (−13.8 LUFS, −0.8 dBTP) |
| Sharper 3D through looks (frame-scaled looks, supersampled lens) | `looks.test`; ARENA edge contrast +31–41 % |
| Card backdrops (5 styles), export = live rasterizer | `backdrop.test`, `backdrop.e2e`, UI sweep |
| Content-addressed 3D cache | `scenekey.test`; ARENA rebuild 1.7 min warm vs 23.5 cold |
| End-to-end benchmark through the tool layer | `scripts/benchmark/arena.ts`: 540×960, 660 frames, 22.000 s, verified |

Test totals (session 6, Linux container, under xvfb): 128 tests in 28 files — unit 92/92 (16 files),
e2e 36/36 (603 s for all on 4 CPU cores); feature sweep 126/126 (71/71 tools, 0 skipped); UI sweep 40/40 with 0 console
errors. `npm run typecheck` clean. Last full run on the RTX machine (session 3): 75 tests in 18 files, ≈160 s.

## Known gaps / limitations
- NEON QUEST benchmark export not yet run (needs the RTX machine); ARENA runs on CPU at 540×960.
- Voice naturalness not verified by ear here; Piper (neural) untested with a real model.
- 2D text has no letter-spacing; card backdrops are static.
- Bursts bake one object per piece (≤ 2000); bigger piles stay static instances. No fracture/shatter.
- In-app Director never ran against the real Claude API (no API key on this machine). Request
  shape (adaptive thinking, effort, `fallbacks: "default"` beta, eager input streaming) follows the
  current API docs but is unverified live. MCP path is verified.
- Live preview shows 3D clips only after "Render 3D previews"; colour effects are approximated
  live (exact when paused/rendered).
- Undo history persists in `history.json` (dropped if project.json was changed outside Mantagli).
- Speed-ramped clips mute their own audio (no variable-rate audio). Live preview approximates
  ramps via playbackRate + drift correction; paused frames are exact.
- Reversed clip audio is silent in the live preview (exact in renders); reverse/freeze cannot be
  combined with speed ramps.
- Blend modes and wipes are exact in the export; the live preview uses canvas equivalents (wipes
  without feathered edges). Live grain is a different random pattern than the export's (same
  strength).
- Composition (FFmpeg) is CPU-bound: ~3 fps for 1080×1920 with looks; an 8 s reel exports in
  ~100 s on this machine (was faster earlier in the session; cause not found, no code regression).
- OTIO: flat tracks only (nested stacks skipped with a warning); non-Mantagli transitions import as
  crossfade; third-party effects other than LinearTimeWarp are ignored. Media imported by an OTIO
  import is not removed by undoing it (same as normal imports). Not yet opened in Resolve/otioview.
- Job history is in memory (no SQLite).
- Installer not yet installed/tested on a clean machine (built and the release exe run in place).
- Observed once: a black preview still in a release-app session whose window was closed during a
  Blender render. Not reproduced (cancellation test leaves no cache). Watch for it.
- `C:\tests\.tmp\demo\…\frame_00001.part.png` is a stray file from a fixed bug (relative project
  dir). Deleting `C:\tests` was blocked by a safety check; the user can delete it.

## Environment notes
- Session 5 ran in a cloud Linux container: Node 22.22, FFmpeg 6.1.1 (apt), Blender 4.0.2 (apt; EEVEE
  under `xvfb-run`, llvmpipe, no GPU), Chromium from `/opt/pw-browsers`, fonts-liberation.
- C: has ~1.3 GB free. All toolchains and build output are on D: (see CLAUDE.md).
- Rust GNU toolchain + MSYS2 binutils (`D:\DevTools\mingw-binutils`) + `gcc` pass-through shim
  (`D:\DevTools\winres-shim`) for Tauri resources. `source scripts/tauri-env.sh` before cargo/tauri.
- User-level env vars set: RUSTUP_HOME, CARGO_HOME, npm_config_cache, PATH += D:\DevTools\cargo\bin.
