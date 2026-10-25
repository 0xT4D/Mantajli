# Reference video analysis

_Written 2026-10-24 (session 4). Ongoing quality benchmark — re-read before visual-quality decisions._

The folder `example_videos/` holds **three** reference teasers (the brief said two). All three were
inspected: metadata with ffprobe, every second as a contact sheet, consecutive frames around each
transition, full-resolution stills, hard-cut detection (`select=gt(scene,…)`), frame-difference
motion energy, loudness/onset analysis and spectrograms. Frame sheets are regenerated with
`node scripts/reference-frames.mjs` into `docs/reference/` (timestamps burned in).

What "watched" means here: I cannot play video with sound in real time. I examined the frames
(1 fps for the whole runtime, 4–15 fps around every transition) and analysed the audio
numerically and as spectrograms. Anything about the *original tool's* implementation is marked
as inference.

| File | Format | Size | FPS | Duration | Audio |
|---|---|---|---|---|---|
| `Cybercamp7_Teaser.mp4` | H.264 yuv420p, 20 Mb/s | 756×944 (4:5) | 30 | 55.0 s | AAC 48 kHz stereo |
| `Securinets_Quals_Teaser_HQ.mp4` | H.264 yuv420p, 19 Mb/s | 1080×1350 (4:5) | 30 | 49.9 s | AAC 48 kHz stereo |
| `tga_teaser.mp4` | H.264 yuv420p, 4 Mb/s | 1080×1920 (9:16) | 30 | 57.0 s | AAC 48 kHz stereo |

## 1. Cybercamp 7 teaser — retro arcade / treasure hoard, 120 BPM

Frames: `docs/reference/Cybercamp7_Teaser_sheet.jpg`, `cc_portal.jpg`, `cc_dive.jpg`,
`cc_turntable.jpg`, `cc_grid.jpg`, `cc_level7.jpg`.

**Timestamped breakdown**
| Time | Sequence | Technique (observed) |
|---|---|---|
| 0.0–5.3 | Slow dolly-in down a row of arcade cabinets with neon trim; centre cabinet screen shows the next scene | Continuous 3D camera move, shallow DOF, purple/teal practical lights |
| 5.3–6.0 | Camera flies *into* the cabinet screen; screen content becomes the frame | **Portal transition** (screen texture = next shot). Lands exactly on the music drop |
| 6.0–10.5 | "CYBER CAMP / SEVENTH EDITION" over a gold-coin hoard with crystals, curtain backdrop, hex floor, top spotlight | Title **decodes** from random glyphs (`C$$?->8` → `CYBER CAMP`), RGB-split glitch accent at 10.9 s, date band slides in at the bottom |
| 10.6–12.4 | A coin falls from above and rushes past the lens, revealing a retro PC on a platform | **Object-wipe transition** (foreground object fills frame), motion blur |
| 12.4–27.0 | Circular platform with 4 stations (PC, flag, chest, trophy); titles WORKSHOPS / CTF BATTLES / TREASURE HUNT / PRIZES with a "quest" progress row | **Turntable snaps**: each move starts on a beat with a fast start and exponential settle (~0.8 s), then holds still ~2 s (measured: frame-difference drops to grain level). Chest opens with coin burst particles |
| 27.0–28.0 | Camera swoops down past the trophy into the floor; floor becomes a synthwave grid | **Match-move through the floor** into a new environment |
| 28–43 | Synthwave sun + neon grid; "SELECT YOUR LEVEL" menu, cursor steps per beat, "ALL LEVELS WELCOME", loading bar | 2D motion graphics over a looping 3D environment; typewriter subtitles |
| 43.0–44.5 | "LEVEL 7" — lightning, shatter into particles, logo re-assembles | Particle burst + text decode; music drops out for a beat before it |
| 44.5–55 | Hero end card: logo, title, date, "registration opening soon"; fade to black from ~52 s | Static hold with idle motion, long audio tail |

**Visual identity**: near-black base, teal (#1de9b6-ish) + purple/magenta neon, gold hoard as
the warm accent. Pixel/arcade display font with hard drop shadow. Whole frame is finished with a
**CRT/lens look**: barrel-distorted frame edges (black outside), vignette, fine grain, slight
chromatic fringing at edges.
**Camera**: dolly-in, crane-down, turntable snaps, push-through-screen; never handheld, never
erratic. Lens: moderate wide (~28–35 mm equivalent), shallow DOF on close-ups.
**Rendering** (inference: Blender EEVEE-like): soft shadows, warm bounce on the floor from
the coins, bloom on emissive trims, volumetric light shaft from the top spot, thousands of
instanced coins. Some aliasing on the grid floor lines; grain hides banding.
**Sound**: 120 BPM chip/synth track. Intro 0–5.3 s is filtered/sparse; the **drop lands on the
portal transition**. Strong onsets every 0.5 s (20 of 38 inter-onset intervals = 0.5 s).
Breakdown at ~43 s right before "LEVEL 7", outro fade from 50.5 s.

## 2. Securinets Quals teaser — red cinematic, globe + 3D type

Frames: `docs/reference/Securinets_Quals_Teaser_HQ_sheet.jpg`, `sq_earth.jpg`, `sq_flash.jpg`,
`sq_whip.jpg`, `sq_glitch.jpg`.

| Time | Sequence | Technique (observed) |
|---|---|---|
| 0–6.4 | Dark violet void, a small red mark grows | Slow build, almost black frame — tension |
| 6.4–7.4 | The mark zooms toward camera, warm flash, then Earth (Africa, city lights) with a red highlight on Tunisia and light streaks | **Zoom-through flash transition** + scale reveal |
| 7.4–19 | Earth rotates; a fiery red front spreads from North Africa until the globe is red | Long continuous shot, emission/texture animation, rim atmosphere glow |
| 19–21 | Globe engulfed in red glow, bloom flash to a red smoke field | **Light/bloom transition** at the musical cut (riser 17.5→20 s, high-cut at 20 s) |
| 21–31 | Kinetic type on red smoke: "SECURINETS QUALS", "17TH OCTOBER 2026", "WE'RE LOOKING FOR THE BEST HACKERS IN THE WORLD", "TO QUALIFY FOR SECURINETS FINALS" | **Decode/scramble reveals**, blinking cursor, **3D extruded type: white face, gold bevel**, floating hex glyphs (`0x`, `FF`, `{`, `#`) as particles |
| 31.3–32.0 | Text whips up with heavy motion blur, red streaks | **Whip-pan transition** (directional blur, both shots moving) |
| 32–34 | "NEW CTF FORMAT FOR THE FINALS" on dark grey | Clean type, subtle chromatic edge |
| 34–41.5 | Pull back from a game screen to reveal an auditorium stage with audience silhouettes; logo appears on screen | **Dolly-out reveal**, video texture on a 3D screen, uplights on walls |
| 41.5–42.5 | Logo pushes to camera, white bloom, glitch/scrambled title, end card | **Push-through + glitch** transition |
| 42.5–49.9 | End card: metallic logo, "SECURINETS QUALS 17.10.2026 JOIN US"; fade | Hold + fade out |

**Visual identity**: monochrome red/black with white-silver type; gold bevels. Heavy smoke texture
and bloom. Restrained camera; drama from light, scale and type.
**Sound**: cinematic/ambient — no strong rhythmic onsets (onset detector found 1). Structure is
carried by **risers and filter sweeps**: build 0–7 s (filter opening), riser into 20 s, change at
31.5–32 s (whip), break at ~41 s before the end card.

## 3. TGA teaser — hacker terminal UI, 2D motion design

Frames: `docs/reference/tga_teaser_sheet.jpg`, `tga_glitch.jpg`, `tga_flash.jpg`.

| Time | Sequence | Technique (observed) |
|---|---|---|
| 0–3 | Dim logo heartbeat on black | Opacity pulse |
| 3–10 | "SELECT TARGET" grid; selection cursor hops between tiles, UI blips per hop | 2D UI animation synced to SFX |
| 5.0–5.3 | Horizontal **slice/block displacement glitch** | 2–3 frame glitch burst |
| 10–38 | Windows: `exploit.sh` terminal typing, webcam face scan, game cheat engine, Burp Suite request, browser admin panel, "PWNED BY SECURINETS"; headers "WE TOOK THE MACHINE", "WE OPENED YOUR CAMERA", "WE BROKE THE GAME", "WE OWNED THE WEBSITE" | Typewriter text, panels snapping, pixel font, glitch between windows |
| 38.3–38.5 | White flash with CRT bulge | **Flash transition** on a section change |
| 38.5–41.5 | Rapid recap of previous windows, ~0.3 s each | Fast montage cutting |
| 42–47.5 | Near-black: "THAT WAS LAST YEAR" … "THIS YEAR …" | Breakdown — silence-like low end only, type only |
| 47.5–55 | Logo end card + date; "BE THERE" | Drop lands on the end card |

**Visual identity**: black, crimson UI chrome, white monospace/pixel type; barrel-distorted CRT
frame throughout. **Sound**: UI blips (~2 kHz ticks at cursor hops, visible in the spectrogram
3–8 s), impacts at 3 s and on the drops (9 s, 47.5 s), pitch risers (27, 42, 44, 47 s).

## 4. What makes them effective (common to all three)

1. **Transitions are motivated and land on musical structure.** Every big transition sits on a
   drop or section change (Cybercamp 5.3 s, Securinets 20 s / 31.5 s / 41.5 s, TGA 38.3 s,
   47.5 s). Cuts are rare (Cybercamp has 2 hard cuts in 55 s); continuity comes from camera
   moves through space (into a screen, through the floor, past an object).
2. **Snap-and-settle motion.** Moves start on the beat, fast, and settle exponentially, then
   hold. Holds let titles read.
3. **Typography is animated as information**: decode/scramble, typewriter with cursor, word
   swaps — never a plain fade.
4. **One consistent finish** over the whole frame (CRT/lens distortion, vignette, grain, bloom,
   chromatic fringe) and a 2–3 colour palette per video.
5. **Dense, cheap detail**: instancing (coins, seats, glyphs), emissive trims, volumetric shafts.
6. **Dynamic range of energy**: quiet/dark openings, breakdowns before the end card.

## 5. Comparison with Mantagli (state at the start of session 4)

| Quality | Mantagli before this session | Gap |
|---|---|---|
| 3D cameras with eased keyframes, DOF, track-to | Yes (keyframes; easing linear/quad/smoothstep) | No spline paths or orbit rigs; no expo/back easing for snap-and-settle; no camera shake in 3D |
| Portal / screen transitions (media inside 3D) | No image/video textures in scenes | **Missing** |
| Instanced detail (coin piles, seats, glyphs) | Only emissive dot particles | **Missing** scatter/instancing |
| Extruded 3D type | Yes, single material | No separate bevel/side material |
| Neon grid / synthwave floor, spot shafts | Emissive meshes + world fog; spot cone not exposed | Grid material and spot cone controls missing |
| Decode/scramble text | Typewriter and word reveal only | **Missing** |
| Whole-frame finish (CRT/lens) | Effects are per clip only; vignette/grain/CA exist; no lens distortion, no scanlines | **Missing** adjustment layers and lens distortion |
| Transitions | 13 types, all incoming-only (outgoing is held still) | No whip/zoom-blur/glitch transitions that move both shots |
| Music structure | Beats, downbeats, onsets → markers | No section/energy (drop/breakdown) detection; no SFX library |
| 2D UI panels (TGA) | Text, colour clips, masks, images | No stroked shapes — use image assets (limitation) |

## 6. Prioritised improvements (impact × feasibility ÷ cost)

| # | Improvement | Why (reference evidence) | Cost |
|---|---|---|---|
| 1 | Expo/back/circ easings in core, FFmpeg, canvas and Blender | Snap-and-settle moves (Cybercamp turntable, type slams) | S |
| 2 | Text **scramble/decode** animation (in/out) | All titles in Cybercamp + Securinets | S–M |
| 3 | **Adjustment layers** + lens distortion (barrel/CRT) + scanlines effects, "CRT" look | All three share a whole-frame finish | M |
| 4 | Two-sided transitions: **whip pan** (directional blur), **zoom blur push**, **glitch cut** | Securinets 31.5 s / 41.5 s, Cybercamp 10.9 s, TGA 5 s | M |
| 5 | 3D **media planes** (image/video texture, emissive screen) → portal fly-through | Cybercamp 5.3 s, Securinets stage screen, logos | M |
| 6 | Camera **path rigs** (spline, orbit), eased progress, look-at, 3D shake | Every 3D shot | M–L |
| 7 | **Scatter/instancing** (pile, ring, box, grid), seeded | Coins, crystals, seats, glyphs | M |
| 8 | Music **section/energy detection** (drops, breakdowns) → section markers | Transitions on drops in all three | M |
| 9 | Procedural **SFX** (whoosh, impact, riser, blip) generated as original assets | Risers/impacts/UI blips | M |
| 10 | Two-tone 3D text bevel, neon grid material, spot cone/blend | Securinets type, Cybercamp grid & spotlight | S–M |

**Realistically matchable**: camera choreography, portal and through-object transitions, decode
type, CRT finish, palette discipline, beat/section-synchronised edits, instanced detail, 3D type.
**Could improve upon**: deterministic, frame-exact re-renders; editable everything (the
references are baked); automatic beat/section alignment.
**Limited by architecture/hardware**: rigid-body/destruction simulations (coin bursts, shatter)
— no physics sim in the scene protocol yet; hand-modelled hero assets (arcade cabinets, globe
textures) must come from imported models/images; Earth-scale texture work needs user assets;
FFmpeg composition is CPU-bound (~3 fps at 1080×1920 with looks), so long 4K exports are slow.

## 7. Benchmark status

See `PROJECT_STATUS.md` → "Reference benchmark" for the montage built with Mantagli's own
features, where its renders live, and the latest side-by-side findings.
