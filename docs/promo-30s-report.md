# Mantagli 30-second promo — "Your ideas. In motion."

Made with Mantagli, through the same tool layer the AI Director and MCP clients use
(`scripts/promo-30s/build.ts`), rendered by the app's own Blender + FFmpeg export pipeline.

## Deliverables
| | Path |
|---|---|
| Video | `tests/.tmp/promo-30s/mantagli-promo-30s.mp4` |
| Editable project | `tests/.tmp/promo-30s/Mantagli Promo 30s.mantagli/` (open in the app; per-scene `.blend` files in `scenes/`) |
| Contact sheet / waveform | `tests/.tmp/promo-30s/review/contact-sheet.jpg`, `review/waveform.png` |
| Review stills (exact renders) | `tests/.tmp/promo-30s/review/still_*.png` |
| First (cold) export, kept for comparison | `tests/.tmp/promo-30s/review/cold-export.mp4` |
| Voice takes for listening (7 engine/voice options × 4 lines) | `tests/.tmp/promo-30s/voice-test/*.wav` |
| Rebuild | `npx tsx scripts/promo-30s/build.ts export` (project + export); `… stills` for review frames |

## Measured result (delivered file, independently re-measured)
- 1080×1920, H.264 High yuv420p, 30 fps, **900 frames, 30.000 s**, 21 Mb/s.
- AAC LC 48 kHz stereo. **−13.7 LUFS** integrated (target −14), **−0.6 dBTP** true peak,
  sample peak −0.63 dBFS, LRA 7.3 LU, flat factor 0 (no clipping), no silence ≥ 0.5 s at −50 dB.
- Voice lines in the mix: −17.5 to −17.9 LUFS (within 0.4 LU of each other); music alone under the
  intro −21.9 LUFS; drops −12.3 LUFS.
- The app's export verification passed (size, duration, frame count, codec, audio, decoded sample).
- Every shot moves (blurred frame-difference never near zero); no black frames; captions start and
  end exactly with their voice clips; no title crosses an unrelated cut.
- Exact preview stills vs the same exported frames: 38–42 dB PSNR (lossless PNG vs CRF-18 H.264).

## Render
- No GPU in this environment (no `/dev/dri`, no NVIDIA driver). Blender 4.0.2 EEVEE ("EEVEE fast"
  preset, 16 samples, no motion blur) through software OpenGL under Xvfb; FFmpeg 6.1 composition.
- **Cold export: 92.5 min** (721 3D frames at 1080×1920, ≈6–13 s each by scene).
  **Cached rebuild + export: 5.3 min**, project rebuilt from scratch, 0 frames re-rendered.
  Frames of the hook, world, recap and brand shots were bit-identical between the cold and the
  cached export; the only real differences were scramble-title glyphs (seeded by clip id, and a
  rebuilt project has new ids) and the H.264 residue that follows them.

## What ran (all real)
Music generator (synthwave, uplifting, 120 BPM, explicit 15-bar structure intro/build/drop/
breakdown/build/drop/outro → section markers at 0/120/240/420/540/600/780) · 6 Blender scenes from
templates (chromeTitle, neonFlythrough, synthwaveHorizon, particleBackdrop, stageReveal with an
image on its screen, metalTitle) with brand accents and an imported font on the 3D titles ·
transitions zoomThrough ×2, whipLeft (preset), whipUp, glitchCut ×2, dipBlack, flash ×2 · the
"vintageFilm" look · smoke card backdrops · Inter Display (imported OTF, SIL OFL) on 2D titles with
glow · RHVoice narration (`bdl`), boxed captions, music ducking · 12 suggested SFX applied + one
manual impact · vignette/grain finish, beat pulse on the recap · two-pass −14 LUFS loudness ·
project validation · export + verification. The stage screen shows a real screenshot of the
Mantagli editor with this promo project open (captured from the running app,
`scripts/promo-30s/ui-screen.mjs`).

No production code was changed for the promo.

## Defects found and fixed while making it
- Kicker titles collided with a headline and sat on the horizon's cyan sun → one kicker line
  300 px from the top.
- Brand subline crowded the caption → raised.
- App-icon tile visible on the end card ("screen" blend) → "lighten" + contrast.
- Recap card had no text (an empty half-second) → carries "TYPE.".
- The "COLOR." grade (tealOrange) barely changed an already teal/violet shot → "vintageFilm".

## Remaining defects / limits (seen, not fixed)
- The hook title starts small: the chromeTitle push-in goes from ~25 % to ~75 % of the width over
  4 s, so the first second is a small title on black.
- The "M" monogram is low-contrast on the violet smoke (the app icon has no transparent version).
- The voice reads sentences without pauses ("Score it. Voice it. Land every cut…").
- EEVEE fast without motion blur: fast moves (whips, zooms) rely on the 2D transition blur only.
- Captions are timed by text length, not speech recognition (they cover the right line exactly;
  word timing inside a line is approximate).

## Needs a human to watch / listen
- Whether RHVoice `bdl` sounds natural enough for a promo (not verifiable here: no listening, no
  speech recognition). Alternatives are rendered in `voice-test/`.
- Overall pacing and energy, the musical feel of the generated score, and SFX taste.
- Whether captions are readable at phone size in motion.

## What it shows about the app
The whole chain works end to end at full 1080×1920 from a script: a structured score drives the
edit, 3D and 2D share one timeline, the mix lands on its loudness target with clean peaks, and a
rebuilt project reuses its 3D renders. The weak points are the ones a viewer notices first:
voice naturalness, the CPU-only 3D look (no motion blur, modest detail), and type that cannot be
letter-spaced or set as true 3D per shot without long renders.

## Top 3 improvements for the next promo
1. **A natural voice**: install Piper with a licensed neural voice model (or use Windows natural
   voices) and verify by ear; add sentence-pause control (SSML-style breaks) to narration.
2. **GPU rendering for 3D** (the RTX machine): EEVEE high / Cycles with motion blur at 1080×1920 —
   the 3D shots carry most of the "premium" impression and are the slowest part (92 min on CPU).
3. **Typography and brand assets**: letter-spacing and per-line styling for 2D text, plus a
   transparent logo asset (SVG/PNG) so the brand mark can be shown cleanly and large.
