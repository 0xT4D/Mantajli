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

## D26 — The live preview stylizes pictures in their own space (2026-10-25)
FFmpeg applies a layer's effects after the fit scale and before the clip transform, so vignette,
scanlines, grain and lens distortion are relative to the fit-scaled picture — including the
overflow a "fill" fit hides (an 800×800 still in 16:9 is a 1920×1920 layer). The live preview now
draws media and 3D pictures into a layer-sized canvas (≤ ~6 frames of pixels), applies those
effects there with the export's formulas (core `vignetteFactor`, `lensSource`, `grainSigma`),
then places it with the clip transform. Colour, text and adjustment layers are frame-sized in the
export, so the frame stays their space. Parity is measured, not asserted: `scripts/ui-live-parity.mjs`
captures the live canvas and the exact frame in the running app and reports their difference.
The export runs the vignette in RGB (on YUV FFmpeg scales limited-range luma and the falloff is
not cos⁴).

## D27 — A second platform as a check, not a target (2026-10-25)
Session 5 ran in a Linux container (FFmpeg 6.1, Blender 4.0, no GPU). Rather than special-casing
tests, the engine adapts: FFmpeg < 7 reads the graph with `-filter_complex_script`; Cycles uses
OpenImageDenoise only when the build has it (OptiX otherwise, else no denoise with a warning);
Linux resolves Arial/Times/Courier to the metric-compatible Liberation fonts so 3D text never
falls back to Blender's ~35 % wider built-in font. The AI media boundary (D12) gained a
user-controlled extension — Settings → Media folders — which no AI/MCP tool can change; tests
declare their fixture folder through it instead of depending on where the checkout lives.

## D28 — Transition presets are data, like looks (2026-10-25)
A preset is a `Transition` value (type, length, easing, intensity) with a label: built-ins in the
core registry (`TRANSITION_PRESETS`), user presets in `project.transitionPresets`. Applying is one
command over many clips (one undo step) that shortens the length to fit short clips and reports
which; built-in names are reserved; saving by an existing label replaces it.

## D29 — Bursts are computed, then baked as keyframes (2026-10-25)
"Physics" for montage needs believable, repeatable motion more than simulation: a burst is a
seeded launch (cone around a direction, speed jitter, stagger) followed by closed-form ballistic
flight with floor bounces (restitution, horizontal friction) until the rebound is too weak, then
the piece settles flat. The scene script bakes it as one keyframe per frame on a per-piece object
sharing the piece mesh: motion blur works (Blender's frame-change handlers do not run at motion-blur
subframes — measured) and the saved .blend keeps the animation. No rigid-body cache, so a single
frame renders on its own and every render of it is identical. Capped at 2000 pieces; piles of
thousands stay on the geometry-nodes instancer.
Related fix: deep patches (`patchSchema`) now recurse through `.optional()`; before, a partial patch
of an optional settings object was parsed whole and reset every other field to its default.

## D30 — Generated music carries its own ground truth (session 6, 2026-10-25)
The music generator (`engine/src/media/music.ts`) is a deterministic synthesizer, not a model:
style (synthwave / cinematic / techno) × mood (dark / tense / uplifting) × length, built from bars
on a fixed tempo with a planned structure (intro → build → drop → breakdown → outro, drops in whole
4-bar phrases). Because the engine wrote every note, the asset's beat analysis is the exact grid
(bpm, beats, downbeats, sections) rather than an estimate, and edits snap to the real drop. The
app's own beat tracker is used as an independent check in `music.test.ts` (tempo within 3 %,
drop within 0.6 s). It is honest about what it is: loop-based production music for drafts and
temp scores, labelled "generated" in the bin. A cloud model provider can be added behind the same
`generateMusic` result shape; none is wired up, and the UI does not claim one.

## D31 — Text-to-speech is a provider interface; local first, cloud only by explicit choice
`engine/src/voice/tts.ts`: providers report `status()` (available + reason) and `voices()`, then
synthesize to a WAV that the engine trims (silenceremove), loudness-normalises (−16 LUFS) and
resamples to 48 kHz stereo, so every voice sits in the mix the same way. Local: Windows SAPI
(System.Speech via PowerShell; text and voice passed through files, never the command line),
espeak-ng, FFmpeg's flite. Cloud: OpenAI and ElevenLabs over HTTPS, keys only from environment
variables read by the engine process (never stored in the project, never sent to the UI). The
default provider is always a local one; a cloud provider is used only when chosen in the dialog or
named in the tool call, and the dialog states that the script text is sent to that service.
Voice cloning is not offered. Captions are timed from text length and punctuation pauses inside
each spoken segment (no speech recognition is claimed); regenerating a line replaces the clip at
the same start and re-times only its own caption clips.

## D32 — Sound design is suggested from the edit, with mix-clarity rules
`core/soundDesign.ts suggestSoundDesign` reads the timeline (two-sided transitions, section markers,
animated titles on beats) and proposes procedural SFX anchored where the motion peaks (a whip's
whoosh mid-transition, a zoom-through's riser ending on the cut). Rules keep the mix readable:
one effect per moment (riser + hit allowed), per-kind minimum gaps, nothing where an SFX already
sits, −6 dB and no title accents under dialogue, a density cap of ⌈0.6/s⌉ + 2 (title accents go
first), no drop hits over generated music (it has its own). Suggestions are a list until applied;
applying is one undo step and applied effects count as existing on the next pass.

## D33 — Meter the mix the way it will be exported; limit true peak at the master
`engine.meterMix` renders the export's own audio graph (gains, fades, ducking, loudness target,
limiter, AAC) for the range and runs `ebur128` (integrated, LRA, true peak, short-term max and the
spans above −0.5 dBTP). The ARENA benchmark measured +0.3 dBTP with a −14 LUFS target because the
master limiter worked on samples (−0.2 dBFS); it now limits at 4× oversampling with a −1 dBFS
ceiling, so inter-sample overs stay below 0 dBTP.

## D34 — Pixel-unit look settings follow the frame; lens remaps are supersampled (session 6)
Measured on the ARENA title (edge contrast, 99th-percentile horizontal gradient): raw Blender
frame 112, after yuv420/x264 112, after the CRT look 44. The render was not the problem; the
finish was. Two causes, two fixes:
- Built-in looks are authored for a 1080 px short side. `lookSpec(id, saved, size)` scales their
  `unit: "px"` params (fringe offset, scanline pitch, glow/blur radii, defaults included) to the
  project's short side when the look is applied. Effects already on clips and looks saved by the
  user keep their values: they were made in that project's pixels.
- `lenscorrection` only interpolates bilinearly. Exports and exact stills remap at 2× and come
  back with Lanczos (+~180 ms per 1080×1920 frame); draft range previews keep the fast path.
Result on the same frame: 44 → 65. A narrower EEVEE pixel filter (1.0 vs 1.5 px) gained only 6 %
and risks aliasing on thin neon lines, so Blender's default stays.

## D35 — Card backdrops are rasterized once, by core, for both renderers
A colour clip can carry `backdrop {style, accent, light, texture, focus, seed}` (spotlight,
studio, smoke, grid, panel), modelled on what the reference teasers put behind type: a light pool,
a lit wall meeting a floor, fractal smoke, a horizon grid, a UI window. `renderBackdrop` (core, pure)
produces RGBA; the export writes it as a PNG input of the FFmpeg graph, the live compositor draws
it to a canvas. Shapes are in short-side units, so the picture is the same at every resolution;
only the static grain is per pixel. An e2e test compares exported pixels with the rasterizer
(mean difference < 1.5 levels). Backdrops are static: motion comes from transforms, grain and
cuts, which keeps the export a single looped image per card.

## D36 — Voice engines are ranked by how they make speech, and compared by ear
No speech-recognition model or neural voice could be downloaded in this environment (Hugging
Face and GitHub releases are blocked), so naturalness could not be measured here; a crude pitch
analysis was inconclusive and is not used. Providers carry `quality` (neural > parametric >
formant) and `license`; the default is the best available local engine: Piper (neural, model
installed by the user) > Windows SAPI > RHVoice > SVOX Pico > flite > eSpeak. RHVoice voices with
non-commercial data licences are labelled. The Voice-over dialog's "Compare engines" speaks the
first line with every local engine so the user chooses by listening. Cloud engines are never a
default (D31). Engines without a usable rate control get a pitch-preserving tempo change.

## D37 — The 3D frame cache is content-addressed
Scene render keys hash the scene with every id renamed by order of first appearance, and frames
live in `cache/scenes/<key>`. A scene rebuilt from a template, duplicated, or re-created by a
script reuses frames; any change to its content (or its assets' bytes, the Blender script, the
font, the quality) changes the key. Identical scenes share one render job (job keys derive from
the directory). Key version 3: caches from earlier versions render once more.

## D38 — Captions are timed from the clip as placed
`clip.add` clamps a media clip to its source's whole frames, which can be one frame shorter than
`round(seconds × fps)`. Narration timed captions from the rounded value, so the last caption
could outlast its voice line by a frame. Captions (narrate and re-voice) now use the placed clip.
