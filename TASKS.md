# Tasks

Legend: [x] done and verified · [~] implemented, partially verified · [ ] not started · [!] blocked

## M1 Foundation
- [x] Repo inspected (was empty), nested git repo, npm workspaces
- [x] Toolchains: Node 22, FFmpeg 8.1, Blender 5.2.3 (portable, D:), Rust GNU (D:)
- [!] MSVC Build Tools — failed: drive C: full. Worked around with GNU toolchain + MSYS2 binutils
- [x] Architecture + docs (CLAUDE.md, DECISIONS.md)

## M2 Editor UI
- [x] Workspace layout, resizable/persisted panels, workspaces (Edit/Color/3D/AI)
- [x] Media browser (grid/list, search, kind filters, favourites, tags, relink, beats)
- [x] Viewer (live approx + exact rendered frame, quality, zoom, safe areas, transport)
- [x] Inspector (clip/text/effects/keyframes/track/marker/project/3D scene/object)
- [x] Timeline (move across tracks, trim, split, ripple delete, duplicate, snapping, zoom,
      markers, waveforms, filmstrips, context menu, drop from bin)
- [x] Keyboard shortcuts, toasts, dialogs (new/open/export/settings), welcome screen
- [x] Track reordering by dragging the header icon
- [x] Marker dragging on the ruler (beat corrections), plus exact frame in inspector
- [x] Keyframe curve editor (drag time/value, easing per key, add/delete, playhead line)

## M3 Media engine
- [x] Import with validation, ffprobe metadata, duplicate detection, missing-file detection
- [x] Thumbnails, filmstrips, waveforms, 540p proxies (background jobs)
- [x] Relink, auto-relink via project-relative path
- [x] Atomic saves, autosave, rotating backups, corrupt-file recovery, lock file
- [x] 3D models (OBJ verified in Blender turntable), fonts, LUTs imported as references; LUT effect verified (lut.e2e)
- [x] Undo history persisted across sessions (see M9)

## M4 3D rendering
- [x] Blender discovery + capability probe, JSON job protocol, resumable frame cache
- [x] Templates: chromeTitle, productTurntable, neonFlythrough, particleBackdrop, empty
- [x] Objects: primitives, 3D text, cameras (DOF, track-to), lights, particles, models
- [x] Materials (presets), animation with easing, world (reflection band, fog), bloom
- [x] Draft previews in the inspector and timeline stills; final renders + .blend saved
- [x] Automatic background draft renders of timeline scenes after edits (debounced, superseding, cancelled by export; setting toggle)
- [x] Cycles GPU quality presets surfaced in UI (see M9)

## M5 Composition / export
- [x] FFmpeg filter-graph compositor (layers, transforms, keyframes, effects, transitions,
      text, audio mix with gain/fades/speed), BT.709 output
- [x] Export presets (reel/square/landscape 1080, 4K, ProRes master), verification
- [x] Draft range preview renders
- [x] OpenTimelineIO export/import (engine, AI/MCP tools, Export dialog; round trip + third-party file in otio.e2e)

## M6 Cinematic workflows
- [x] Beat/downbeat/onset detection → markers, snapping to markers
- [x] Looks (6), 19 effects, 13 transitions, text animations (fade/slide/pop/typewriter/words)
- [x] Typewriter text (in/out), wipe left/right/up/down + iris transitions (textfx.e2e, pixel checks)
- [x] Motion effects as curves: camera shake (seeded), beat pulse on beat/downbeat markers (animation.test + textfx.e2e)

## M9 Montage power features (session 2 roadmap)
- [x] Speed ramps: speed keyframes, 5 presets, frame-exact export (speedramp.test + speedramp.e2e); ramped clip audio muted
- [x] Layer blend modes: screen, add, multiply, overlay, soft light, lighten, darken, difference (pixel-checked)
- [x] Letterbox bars and digital glitch (jitter + RGB split, exact in export, channel-split live)
- [x] 3D render quality presets (EEVEE fast/high, Cycles GPU preview/final/film) in UI + AI; Cycles device shown in status bar (cycles.e2e)
- [x] Audio: clip-timed ducking of music under dialogue/SFX roles; loudness-normalised export (loudnorm, verified with ebur128)
- [x] Undo/redo history persisted across sessions (content-addressed snapshots, history.json; discarded if project.json changed elsewhere)
- [ ] Job history persisted across sessions (optional)

## M10 Creator features (session 2, continued)
- [x] Captions: SRT/WebVTT import as styled caption clips (bold/boxed/clean/karaoke, safe-zone aware), SRT export (captions.test, ai.test)
- [x] One-click auto-edit to beats: core command timeline.autoEdit, Auto edit dialog (bin wand button), AI tool timeline_auto_edit (speedramp.test; run in UI)
- [x] Freeze frame (clip.freezeFrame, ripple) and reverse clips incl. reversed audio (speedramp.test + speedramp.e2e)
- [x] Chroma key: matte from ungraded pixels (separate branch), despill, live per-pixel key with the same formula (textfx.e2e + screenshots)
- [x] Shape masks (rectangle/ellipse, feather, invert; frame coordinates; split screens)
- [x] Word-by-word text reveal + kinetic caption style

## M11 Verification and promo (session 3)
- [x] Feature sweep script (59 tools + RPC, every effect/transition/animation/blend rendered) — 53/53
- [x] UI sweep script (workspaces, dialogs, inspectors, playback) — 24/24
- [x] Fixes from the sweeps: Director missing-key message; dialogs close on Escape while a field is focused; timeline_add_clip kept transform/name/fontAssetId; product turntable material on imported models; Auto edit default track
- [x] 20 s cinematic promo built in the app (scripts/promo), exported and verified
- [~] Installer rebuilt with all features (build verified; clean-machine install still untested)

## M12 Reference-driven cinematic toolkit (session 4; see REFERENCE_VIDEO_ANALYSIS.md)
- [x] Reference analysis of the 3 teasers (frames, transitions, motion energy, audio structure) + docs/reference sheets
- [x] Easings: expo in/out/in-out (snap and settle), back in/out (core, FFmpeg, Blender)
- [x] Scramble/decode text animation
- [x] Adjustment layers (segmented composite) + lens/CRT distortion + scanlines + CRT Monitor look
- [x] Two-sided transitions: whip pans (motion-matched blur), zoom through, glitch cut
- [x] Slides/whips crop fill-fit sources to the frame cell (was: overflow slid over the other shot)
- [x] Frozen tail when the outgoing clip has no handles (was: black under the transition in stills/ranges)
- [x] Render caches keyed by renderer version / Blender script hash
- [x] 3D: media planes (image/video), camera paths + moves (orbit/dolly/crane/truck, snap stops), shake, scatter instancing, grid + smoke materials, two-tone text, spot cones
- [x] 6 reference templates (arcadePortal, turntableStage, synthwaveHorizon, treasureHoard, stageReveal, metalTitle)
- [x] Scene bake to a video asset (portals, reuse)
- [x] Music structure (drops, breakdowns, builds, dropouts) -> section markers
- [x] Procedural SFX (whoosh, riser, impact, hit, glitch, blip, downlifter) with anchored placement
- [x] Timeline Insert menu (title / solid / adjustment / SFX); Add-track menu made visible (was clipped)
- [x] Copy / cut / paste clips (Ctrl+C/X/V) via `clip.paste`
- [x] Saved project looks (look.save/remove, Looks tab, look_save tool)
- [x] UI for 3D: media/scatter/shake/spot/edges/pattern fields, camera move section, key easing
- [x] Feature sweep fixed (the rendered-feature checks had been silently skipped) + new tool steps
- [~] Benchmark montage "NEON QUEST" (scripts/benchmark): built, reviewed, fixes applied; export pending (needs the RTX dev machine; script portable since session 5)
- [x] Live preview parity: layer-space stylize, exact vignette, bilinear lens, live grain + CA, longer smear (session 5, `ui-live-parity.mjs`)
- [~] Physics: coin bursts done (scatter.burst, deterministic ballistic + floor bounces, session 5); shatter/fracture not started
- [x] Transition presets: 8 built-ins + saved per project, Inspector + AI tools (session 5)

## M13 Second platform + parity (session 5, cloud Linux container)
- [x] Verified sessions 1–4 on Ubuntu 24.04 (FFmpeg 6.1, Blender 4.0 via Xvfb, Chromium): unit, e2e, UI sweep
- [x] Portability fixes: FFmpeg < 7 graph files, Cycles without OIDN, Linux fonts, browser scripts, rpc home dir, benchmark paths
- [x] Settings "Media folders" for the AI media boundary (tests no longer depend on the checkout location)
- [x] Live preview: only rendered 3D draft frames are requested (partial cache flooded failed loads)
- [x] chromeTitle text fits the frame width; composition cache keys include the 3D font
- [x] Export vignette in RGB, equal to the core formula (RENDERER_VERSION 7)
- [x] Feature sweep on Linux: 123/123, all 65 tools (sweep fixtures made portable)
- [x] Scatter bursts (physics-lite) + fix: nested scene-object patches reset other settings

## M7 AI Director
- [x] Shared tool layer (52 tools), MCP server (standalone + bridge to app)
- [x] Director loop (streaming, approvals, cancel, revert/accept, previews as images)
- [x] Agent acceptance test over MCP (real renders + export)
- [!] Live Claude API run of the in-app Director — needs an API key (none on this machine)

## M8 Polish / delivery
- [x] Tauri debug build runs; engine supervised and shut down cleanly
- [x] Release build + NSIS installer (`D:/DevTools/mantagli-target/release/bundle/nsis/Mantagli_0.1.0_x64-setup.exe`)
- [ ] Code signing, auto-update
- [x] README / usage docs
