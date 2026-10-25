# Project audit

_Written 2026-10-25 (session 6), on the state at commit `8f32753`. Facts below were checked against
the code and by running it; estimates are marked as such._

## 1. What the application is
A desktop studio (Tauri 2 shell + React UI) driving a Node "engine host" over a local WebSocket.
The engine owns the project (immutable zod-validated tree, command-based edits, undo history),
renders 3D through Blender in background mode (JSON scene protocol, `blender/mantagli_scene.py`),
composes and encodes through one FFmpeg filter graph per render (`render/ffgraph.ts`), and exposes
the same validated tool layer (65 tools) to the in-app Claude Director and to Claude Code via MCP.
≈21 k lines of TypeScript/Python (excluding dependencies).

| Layer | Technology | State |
|---|---|---|
| Project model | zod schema v1, immer commands (47), snapshot undo persisted as a Merkle store | solid; atomic saves, autosave, rotating backups, corrupt-file recovery, lock |
| 3D | Blender 4.2–5.2 (4.0 works), EEVEE/Cycles, scene JSON → objects, materials, lights, paths, scatter, bursts, media planes | real renderer, not interactive modelling (see §3) |
| Composition | FFmpeg filter graph: layers, transforms/keyframes, 22 effects, 19 transitions, blend modes, masks, adjustment layers, text | exact; CPU-bound |
| Live preview | Canvas 2D compositor sharing core curves/formulas; exact frame when paused | close parity for effects (session 5 measurements) |
| Audio | FFmpeg mix (gain, fades, ducking envelope, loudnorm), beat/onset/section analysis, procedural SFX | no pan, no per-clip peak/clip metering, no music or voice generation in-app |
| AI | Tool layer (validated, permissioned, atomic), Director loop (Anthropic API), MCP stdio | Director never run live (no key); MCP path verified |
| Export | presets (reel/square/landscape 1080, 4K, ProRes), ffprobe + decode verification, OTIO, SRT | verified |
| Tests | unit 73, e2e 35, feature sweep 123 checks (all tools), UI sweep 31 states, live-parity script | all passing (session 5, Linux) |

## 2. Implemented vs. incomplete vs. missing (against the master mission)

**Implemented and verified**: multitrack timeline (move/trim/split/ripple/copy-paste/snapping/markers/
keyframes/curve editor), transitions incl. two-sided whips/zoom-through/glitch and portals via 3D media
planes, transition presets, text animations (fade/slide/pop/typewriter/words/scramble), captions
(SRT/VTT in, SRT out, kinetic styles), looks and saved looks, adjustment layers, lens/CRT finish,
chroma key, shape masks, speed ramps, reverse/freeze, beat/downbeat/section detection, auto-edit to
beats, ducking, loudness-normalised export, procedural SFX (7 kinds) with anchored placement, 3D
templates (11), camera rigs (orbit/dolly/crane/truck + snap stops), DOF, 3D camera shake, scatter
instancing, deterministic bursts, render quality presets (EEVEE/Cycles), bake scene to video,
OTIO interchange, autosave/backups/recovery, AI tools + MCP.

**Partially implemented**
- *3D modelling*: objects are created and edited through forms (transform, material, kind settings)
  and rendered by Blender; there is no interactive 3D viewport, gizmos or mesh editing. Modelling
  operations are limited to primitives, extruded text, imported models, instancing, paths.
- *Audio*: no stereo pan, no clip-level volume automation UI beyond keyframes, no peak/clipping meter.
- *AI Director*: implemented against the Anthropic API but never exercised live (no key here).

**Missing (relevant to the mission)**
- Music generation of any kind inside the app (scores so far were standalone scripts).
- Text-to-speech / narration workflow; speech recognition / transcription.
- Context-aware sound-design suggestions (SFX are placed by hand or by explicit tool calls).
- Asset provenance/licensing metadata; semantic asset search.
- AI 3D/image generation providers.
- Nested sequences / clip groups.

## 3. Architectural constraints
- **Rendering is offline by design** (Blender background + FFmpeg). Live playback is a canvas
  approximation; exact frames are cached renders. This gives frame-exact, reproducible exports but
  no real-time 3D viewport. An interactive viewport (e.g. three.js mirroring the scene JSON) would be
  a large addition and would create a second renderer to keep in parity; deferred (see priorities).
- **CPU-bound composition** (~3 fps at 1080×1920 with looks on the dev machine).
- **No GPU here**: the cloud container renders EEVEE on llvmpipe (~80–90 s per final 1080×1920 frame).
  3D-heavy verification must use small resolutions on this machine.
- **Network**: PyPI/npm reachable; Hugging Face/GitHub releases blocked here, so neural models cannot
  be downloaded in this environment.

## 4. Performance observations (measured)
- e2e suite: ≈ 9–10 min on 4 CPU cores (≈160 s on the RTX dev machine).
- Dense 3D template (treasure hoard, 2 860 instances): ≈ 26 s per quarter-scale draft frame on CPU.
- Composition graph: one FFmpeg process per still/range/export; previews cached by content hash.

## 5. Prioritised plan for this session
Scored by impact on finished videos, verifiability here, and cost.

| # | Improvement | Impact | Complexity | Verifiable here | Decision |
|---|---|---|---|---|---|
| 1 | **Music generator** in-app: structure-aware (intro/build/drop/breakdown/outro), tempo, mood, style; exact beat grid + section markers written from the composition | High: every montage needs music; structure drives the edit | M | yes (synthesis + beat detection) | do |
| 2 | **Text-to-speech + narration workflow**: provider layer (Windows SAPI, espeak-ng, FFmpeg flite; OpenAI/ElevenLabs by key), segments → voice track, captions, ducking | High (mission part 8) | M | local engines yes; cloud adapters vs. a mock server only | do |
| 3 | **Context-aware sound design**: suggest SFX from transitions, drops, titles, with spacing and level rules; review then apply | High: cheap polish | S–M | yes | do |
| 4 | Audio metering: peak/true-peak/LUFS of the mix with clipping report | Medium | S | yes | do if time |
| 5 | End-to-end benchmark through the app incl. music, voice, SFX, 3D, export (CPU-sized) | Required validation | M (render time) | yes, at reduced resolution | do |
| 6 | Interactive 3D viewport (three.js) with gizmos | High for modelling UX | L | partially | defer; document |
| 7 | Speech recognition (whisper) | Medium | M | no model download possible here | defer; document |
| 8 | AI image/3D generation providers | Medium | L, external | no keys | defer |
