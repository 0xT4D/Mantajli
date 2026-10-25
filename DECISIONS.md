# Architecture decisions

## D1 — One TypeScript engine shared by UI, AI Director and MCP (2026-10-23)
The editing engine (project model, media, rendering orchestration, AI tools) is TypeScript
running in a Node process ("engine host"). The UI, the in-app Claude Director and the MCP
server all drive the *same* tool layer and the *same* live session, so Claude Code edits are
visible in the app and share one undo history.
Why: the official MCP SDK and Anthropic SDK are first-class in TS; core commands are pure TS
and testable without native toolchains; one implementation instead of Rust+TS duplicates.
Rust (Tauri) keeps: window/shell, native dialogs, OS keychain for the API key, supervising the
engine process. Deviation from "Rust for project access/job orchestration" is deliberate.

## D2 — Engine host transport: localhost WebSocket + HTTP with a random token
Bound to 127.0.0.1, 192-bit random token on every request (timing-safe compare), files served
only if inside the project folder or an asset of the open project. Connection info is written
to `%APPDATA%/Mantagli/engine.json` (user-only location) so the MCP bridge can connect.
Why: works identically in Tauri and in a dev browser, supports ranged video streaming for
`<video>`, no Tauri asset-scope plumbing.

## D3 — Immutable project + snapshot undo
Project state is an immutable immer tree; every command produces a new tree. History stores
before/after snapshots (structural sharing keeps them cheap). Transactions group commands into
one undo step and are atomic (failure leaves state untouched). Asset bookkeeping (derived files,
analysis, status) is carried forward across undo so undo never "forgets" a proxy.

## D4 — Folder-based project, continuous atomic saves
`<Name>.mantagli/project.json` + `backups/` (rotating, max 25) + `cache/` + `exports/` +
`scenes/*.blend` + `oplog.jsonl`. Every change autosaves (debounced 1.2 s) via temp-file + fsync
+ rename. Corrupt project.json → automatic recovery from newest valid backup (corrupt file kept).
A `.lock` with PID prevents two engines editing one project.

## D5 — Composition via one explicit FFmpeg filter graph
Background canvas + every visual layer overlaid bottom-up (`overlay` with shifted PTS).
Per layer: decode with input seeking → retime → fixed frame count (tpad/trim) → crop → fit
scale → effects (alpha-preserving wrapper for layers with transparency) → RGBA → rotate (fixed
canvas, transparent fill) → animated scale → opacity via sendcmd → shift → overlay with
expression-driven x/y. Compositing in RGB, single BT.709 conversion at the end, output tagged
BT.709. Audio: per-segment trims, atempo, gain/fade expressions, adelay, amix (no normalize),
limiter. Not a concat — the timeline is rendered as a real composition.

## D6 — Shared animation curves
`core/animation.ts` turns keyframes, fades, transitions and text animations into curves
(x/y/rotation additive, scale/opacity multiplicative). FFmpeg expressions and the live canvas
preview are generated from the same curves. Opacity is sampled per frame and driven by
`sendcmd` so arbitrary curves work even mid-clip (range previews).

## D7 — Transitions belong to the incoming clip
A transition plays over the first N frames of the incoming clip; the outgoing clip on the same
track is extended under it (source handles, frozen last frame if none). Dip/flash transitions
are a synthetic colour layer with a triangle opacity curve.

## D8 — Blender as a background renderer with a JSON protocol
`blender -b --factory-startup -P blender/mantagli_scene.py -- job.json`. The script rebuilds the
scene from a validated spec, renders only missing frames (resumable, `.part.png` then rename),
saves a `.blend` for final renders. Frame cache key = hash of everything affecting pixels.
EEVEE by default; Cycles with OptiX/CUDA when selected. Chrome reads well thanks to a
"studio reflection band" world (camera rays see the dark background). World fog absorbs that
band, so chrome templates default to fog 0. Bloom via compositor Glare node (Blender 5 API
with menu sockets; attached only when fully linked).

## D9 — Two preview modes, labelled honestly
Live (approximate) canvas compositor for playback and scrubbing; exact FFmpeg/Blender frame
when paused (content-hash cached); draft MP4 range renders. The viewer badge always says which.

## D10 — AI Director: manual streaming tool loop
Claude Opus 5.5, adaptive thinking (summarized), effort high, server-side refusal fallbacks
(`fallbacks: "default"`), eager input streaming + zod validation. Append-only transcript
(preserved thinking). Images of real rendered frames are returned in tool results so visual
review is genuine. Limits: 60 steps, 6 consecutive failing turns. Review mode asks before exports
and large deletions. Each run keeps a baseline → one-step undoable "Revert all".

## D11 — Toolchain on D:, Rust GNU target
C: has ~1 GB free; MSVC Build Tools failed (out of space). Rust GNU toolchain
(self-contained mingw linker) is used for the Tauri shell. If GNU builds of Tauri prove
problematic, free space on C: and install MSVC Build Tools (`winget install
Microsoft.VisualStudio.2022.BuildTools` with the VCTools workload).

## D12 — Media folder boundary for AI imports
AI/MCP may import only from the user's Videos/Music/Pictures/Downloads/Desktop/Documents and
the project folder; exports only into those or the project. The UI (user-initiated) is not
restricted.

## D13 — OpenTimelineIO as hand-written otio_json
No OTIO library (the reference implementation is C++/Python). The engine writes/reads the JSON
schema directly (Timeline.1, Stack.1, Track.1, Clip.2/Clip.1, Gap.1, Transition.1, Marker.2,
LinearTimeWarp.1, ExternalReference.1). Each clip also carries its full Mantagli definition in
`metadata.mantagli` (and the timeline carries scenes), so Mantagli → OTIO → Mantagli is lossless
while other tools see standard clips. Mantagli's "transition plays over the head of the incoming
clip" maps to `in_offset = 0, out_offset = duration`. Import adds new tracks in one transaction
(one undo step); media import happens before it and is not undone. AI/MCP imports enforce the D12
media boundary on every referenced file, not only on the .otio itself.

## D14 — Motion and per-frame effects live in core curves
Camera shake, beat pulse and glitch jitter are generated as animation curves in
`core/animation.ts` (seeded deterministic noise, beat markers), so FFmpeg and the live canvas
render them from one source. Frame-varying filter parameters (glitch RGB split, opacity) are
sampled per frame and driven by `sendcmd`. Typewriter text uses one `drawtext` per (line,
visible prefix) with `enable=` ranges; wipes/iris use a `geq` alpha mask enabled only during the
transition. Letterbox bars are drawn on the composite (frame coordinates) after the layer.

## D15 — Speed ramps are speed keyframes integrated per frame
`speed` is a keyframe property. Source time = sourceIn + Σ speed(frame midpoint)/fps
(`timeline.ts: sourceOffset`), used by the plan, trims/splits, clamping and the preview. FFmpeg
remaps with a flat `setpts` sum of clamped linear pieces (≤ ~120), seeking slightly early and
keeping exact PTS, with `fps=round=up` so each output frame shows the latest source frame at or
before its source time (player semantics). Ramped clips mute their own audio (plan warning).
Trims/splits insert boundary keys so every keyframed curve keeps its shape.

## D16 — Blend modes via blend + alphamerge
Non-normal layers are placed on a transparent full frame, `blend`ed with the base (base as the
"top" input so overlay/soft light follow Photoshop semantics), then merged over the base through
the layer's alpha so transparency and opacity leave the base untouched. Canvas uses
`globalCompositeOperation`.

## D17 — Ducking from clip timing; persistent history as a Merkle store
Ducking is computed from dialogue/SFX-role clip spans (not audio level): deterministic, cheap,
identical in preview and export, and editable as a dB envelope with attack/release. Undo history
persists as content-addressed JSON subtrees (hash cached per immutable object) and is restored
only when the stored head matches the project.json text — stale history is dropped, never
applied. MCP tool calls block ≤ 45 s (clients time out at 60 s); long work is polled.

## D18 — Composite commands and per-clip time mapping
Bulk edits that need fresh clip ids (auto edit to beats, freeze frame) are core commands that
call other commands through `sub()` (params validated, one undo step). `sourceTimeAt(clip,
frame)` is the single forward/reverse/freeze time mapping. Reverse keeps the clip's source range
and shows it backwards, so trimming the end of a reversed clip moves its in-point. Chroma key
derives the matte from ungraded pixels in a separate graph branch; the preview keys per pixel with
the same U/V-distance formula (`chromaKeyAlpha`). Captions are plain text clips on a "Captions"
text track (styles sized from the frame); SRT export reads any text track back.

## D19 — Sweeps over the real protocol; promo built with the product
The feature sweep talks to an in-process engine server over the same WebSocket protocol as the UI
and MCP bridge (`tools.call` + RPC), and judges rendered features by pixel difference against a
reference frame rather than by inspecting graph strings. The promo is built by a script that uses
only the app's tools, so it doubles as an end-to-end test of a real production; anything that
needed a workaround there was fixed in the app instead.


## D20 — Reference videos are the quality benchmark (2026-10-24)
`example_videos/` holds three reference teasers; `REFERENCE_VIDEO_ANALYSIS.md` records what makes
them work (transitions on musical drops, snap-and-settle moves, decode typography, one whole-frame
CRT/lens finish, dense instanced detail) and the prioritised gaps. Session-4 features were chosen
from that analysis, and the benchmark montage (`scripts/benchmark/`) is rebuilt from the app's own
tools to compare against them.

## D21 — Adjustment layers composite in three segments
An adjustment clip's source is the composite below it. A time-shifted `split` branch would make
FFmpeg queue every frame before the layer starts (overlay waits for the branch's first frame), so
the running base is split into before / during / after with `trim`, only the middle runs through
the normal layer chain (effects, opacity, masks, blend, motion) and is overlaid on the untouched
middle, and `concat` rejoins the three (timestamps re-based per segment; verified continuous).
Geometric effects (lens distortion) run after colour effects, on RGBA, so alpha bends with colour.

## D22 — Two-sided transitions derive their blur from their own motion
The plan gives the outgoing layer the next clip's transition (`transitionOut`); `layerCurves`
animates its tail and `transitionFx` returns per-frame motion blur computed from the curve's
velocity (180° shutter) and the glitch-cut RGB split, for both export and preview. FFmpeg: a pair of
opposite `dblur` streaks (dblur alone is one-sided and shifts the image), blurred premultiplied
(`premultiply` → blur → `unpremultiply`) so transparent margins do not darken edges, after padding
the layer along the blur axis — the incoming shot with a transparent margin, the outgoing one with
smeared edge pixels, so the background never shows through the seam.

## D23 — 3D camera paths, instancing, media planes, bakes
Paths are Blender bezier curves with auto handles through the points, followed with a Follow Path
constraint whose `offset_factor` is the keyframed `pathProgress` (easing per key; "hold" keys give
snap-and-settle steps). Cameras keep a Track To target, so moves stay framed without tangent
rotation. Scatter = one points mesh with per-point rotation/scale attributes + a geometry-nodes
Instance on Points modifier (thousands of instances cheaply). Media planes are emissive (screens)
or lit (prints); portal templates compute the camera distance at which the screen fills the frame
exactly like a fill-fit clip (`fillDistance`). `scene_bake` renders a scene to an H.264 asset so a
scene can play on a screen inside another scene.

## D24 — Cache keys carry the renderer version
Composition previews are keyed by plan content plus `RENDERER_VERSION` (bump it whenever the same
plan renders different pixels); 3D frame caches include a hash of `mantagli_scene.py`. Without this
an app update that fixes a renderer would keep serving stale cached frames.

## D25 — Music structure and sound design are suggestions, made locally
Sections come from novelty of loudness (power-averaged), brightness and onset density over 3 s on
each side, refined to the sharpest 0.5 s step and snapped to a beat; a boundary after a riser is a
drop even on a loudness-flat master. They become labelled section markers only — never automatic
edits. Sound effects are synthesized procedurally (seeded, deterministic, original material) into
`generated/sfx`, and placed by the effect's own anchor (risers end on the frame, whooshes peak on
it, hits start on it).
