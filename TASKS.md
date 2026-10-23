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
- [ ] Track reordering by drag (command exists: track.move)
- [x] Marker dragging on the ruler (beat corrections), plus exact frame in inspector
- [ ] Curve/graph editor for keyframes (keyframes list + diamonds only)

## M3 Media engine
- [x] Import with validation, ffprobe metadata, duplicate detection, missing-file detection
- [x] Thumbnails, filmstrips, waveforms, 540p proxies (background jobs)
- [x] Relink, auto-relink via project-relative path
- [x] Atomic saves, autosave, rotating backups, corrupt-file recovery, lock file
- [x] 3D models (OBJ verified in Blender turntable), fonts, LUTs imported as references; LUT effect verified (lut.e2e)
- [ ] Undo history persisted across sessions (in memory only)

## M4 3D rendering
- [x] Blender discovery + capability probe, JSON job protocol, resumable frame cache
- [x] Templates: chromeTitle, productTurntable, neonFlythrough, particleBackdrop, empty
- [x] Objects: primitives, 3D text, cameras (DOF, track-to), lights, particles, models
- [x] Materials (presets), animation with easing, world (reflection band, fog), bloom
- [x] Draft previews in the inspector and timeline stills; final renders + .blend saved
- [ ] Cycles GPU quality presets surfaced in UI (engine selectable; GPU auto-enabled)

## M5 Composition / export
- [x] FFmpeg filter-graph compositor (layers, transforms, keyframes, effects, transitions,
      text, audio mix with gain/fades/speed), BT.709 output
- [x] Export presets (reel/square/landscape 1080, 4K, ProRes master), verification
- [x] Draft range preview renders
- [ ] OpenTimelineIO export/import

## M6 Cinematic workflows
- [x] Beat/downbeat/onset detection → markers, snapping to markers
- [x] Looks (6), 13 effects, 8 transitions, text animations (fade/slide/pop)
- [ ] Typewriter text animation, curves editor, wipe transitions

## M7 AI Director
- [x] Shared tool layer (50 tools), MCP server (standalone + bridge to app)
- [x] Director loop (streaming, approvals, cancel, revert/accept, previews as images)
- [x] Agent acceptance test over MCP (real renders + export)
- [!] Live Claude API run of the in-app Director — needs an API key (none on this machine)

## M8 Polish / delivery
- [x] Tauri debug build runs; engine supervised and shut down cleanly
- [~] Release build + NSIS installer (see PROGRESS.md for current state)
- [ ] Code signing, auto-update
- [x] README / usage docs
