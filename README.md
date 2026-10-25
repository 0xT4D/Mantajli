# Mantagli

AI-directed 3D montage studio for reels, cinematic edits and music-driven videos.
Blender renders the 3D scenes, FFmpeg composes and encodes, and Claude (in-app or through
Claude Code via MCP) edits the real, editable project.

## Requirements
- Windows 10/11 (primary). The engine, tests and browser UI also run on Linux (verified on
  Ubuntu 24.04 with apt `ffmpeg` 6.1 and `blender` 4.0; headless EEVEE needs a display, e.g.
  `xvfb-run`; install `fonts-liberation` for Arial-compatible text). macOS is untested.
- Node.js 22.13+
- FFmpeg + FFprobe on PATH (e.g. `winget install Gyan.FFmpeg`)
- Blender 4.2+ (5.2 LTS tested). Auto-detected in Program Files, `D:\DevTools`, or set in Settings
- For the desktop shell: Rust + Tauri prerequisites (WebView2 ships with Windows 11)
- Optional: an Anthropic API key for the in-app AI Director
- Optional voice-over engines: Windows voices (built in), `espeak-ng`, or FFmpeg built with
  `libflite`; cloud voices with `OPENAI_API_KEY` or `ELEVENLABS_API_KEY` in the engine's environment

## Run (development)
```bash
npm install
npm run engine          # terminal 1: engine host
npm run dev:ui          # terminal 2: UI at http://127.0.0.1:1420 (browser dev mode)
# or the desktop app (starts its own engine):
source scripts/tauri-env.sh   # only needed on this machine's GNU toolchain setup
cd apps/desktop && npx tauri dev
```

## Build the desktop app
```bash
npm run build:engine     # bundles the engine + Node runtime into dist-engine/
source scripts/tauri-env.sh && cd apps/desktop && npx tauri build
```
The installer lands in `<cargo target>/release/bundle/nsis/`.

## Using it
1. **New project** → choose vertical / square / landscape and frame rate.
2. **Import** media (button, Ctrl+I, or drop files on the window). Thumbnails, proxies and
   waveforms are generated in the background.
3. Drag clips from the bin to the timeline. Trim edges, move across tracks, split with **S**,
   delete with **Del** (Shift+Del ripples), duplicate with **Ctrl+D**, copy / cut / paste at the
   playhead with **Ctrl+C / Ctrl+X / Ctrl+V** (relative timing and tracks kept), undo/redo
   **Ctrl+Z / Ctrl+Shift+Z**.
4. Select a music clip's asset → **Beats** to detect tempo; beat markers appear on the ruler and
   clips snap to them.
5. **3D Scenes** tab → pick a template (e.g. 3D Chrome Title) → drag the scene to a track.
   Edit objects, camera, lights, materials and animation in the inspector; **Render** shows a
   Blender draft frame.
6. Inspector: transform/opacity keyframes (◆ buttons at the playhead), effects stack, looks,
   fades and transitions, text style and animation.
7. Viewer: plays a live approximate preview; when paused it shows the exact rendered frame.
   **Render preview video** renders the whole timeline exactly at draft quality.
8. **Export** → preset → exports, verifies with FFprobe and decodes a sample.

### Cinematic toolkit (session 4)
- **Insert menu** (layers icon on the timeline toolbar): title, colour solid, **adjustment layer**
  (its effects finish everything below it — e.g. the *CRT Monitor* look: barrel/CRT lens
  distortion, scanlines, fringing, grain, vignette), and **sound effects** synthesized on the spot
  (riser ending at the playhead, whoosh peaking on it, impact, hit, glitch, UI blip, downlifter).
- **Transitions** that move both shots: whip pans (motion blur derived from the motion), zoom
  through, glitch cut — plus the earlier dissolves, dips, slides, wipes and iris.
- **Text**: scramble/decode reveal, typewriter, word-by-word; **easings** include expo
  (snap-and-settle) and back (overshoot).
- **Music**: beat analysis also finds the song structure — drops, breakdowns, builds — as
  labelled section markers on the ruler (suggestions only; nothing moves by itself).
- **3D**: image/video screens inside scenes (portals), camera moves along smooth paths (orbit,
  dolly, crane, truck; optional snap on downbeats), camera shake, instanced scatter (coin piles,
  seat rows), neon-grid and smoke materials, two-tone extruded type, spot cones. Templates:
  Arcade Portal, Turntable Stations, Synthwave Horizon, Treasure Hoard, Stage Reveal, Metal Title.
  **Bake** a scene to a video asset to play it on a screen in another scene.
- The reference teasers and what Mantagli learned from them: `REFERENCE_VIDEO_ANALYSIS.md`;
  the benchmark montage built only with these tools: `scripts/benchmark/`.

### Session 5
- **Transition presets**: Inspector → *Preset* applies a transition with its length, easing and
  intensity to the selected clip(s) in one step (whip on the drop, punch through, glitch hit,
  beat flash, ...); *Save preset* keeps a clip's transition for reuse in the project.
- **Live preview closer to the export**: vignette, lens/CRT distortion, scanlines, film grain and
  chromatic aberration now use the export's formulas and geometry while playing.
- **Settings → Media folders**: extra folders (e.g. footage on another drive) the AI Director and
  Claude Code may import from and export to.
- **Bursts**: a scatter object's *Burst* makes its pieces fly out at a frame — coin fountains,
  debris — falling, bouncing on the floor and settling flat, identically on every render.

### Session 6
- **Generate music** (Insert menu): a synthesized score in a chosen style (synthwave, cinematic,
  techno), mood and length with a real structure — intro, build, drop, breakdown, outro. It is a
  procedural synthesizer, not an AI model; because the app wrote every note, its beat and section
  markers are exact, so cuts land on the real drop.
- **Voice-over** (Insert menu): one line per paragraph is spoken, placed on a *Voice* track with
  timed captions, and the music ducks under it. Local engines by default (Windows voices,
  espeak-ng, flite); OpenAI or ElevenLabs only when you pick them — then the script text is sent to
  that service. Re-voice a single line without touching the rest. Captions are timed from the text,
  not transcribed.
- **Sound design & mix** (Insert menu): suggested whooshes, risers, hits and glitches where the
  edit's transitions, drops and title reveals happen (fewer under dialogue), placed in one step;
  *Measure mix* reports loudness (LUFS), loudness range and true peak of the export mix, with
  warnings. The master limiter holds peaks under −1 dBTP.
- **Export presets** 720p (vertical and landscape) and *Project size* (any custom resolution).
- `scripts/benchmark/arena.ts`: an end-to-end teaser built only through the AI tool layer and
  exported through the real pipeline (see PROJECT_STATUS.md for measured results).

## AI Director (in-app)
Open the AI panel, add your Anthropic API key (stored in the Windows Credential Manager), write a
brief and press **Direct**. The Director inspects the project, analyses music, records a shot
plan, edits the timeline, builds 3D scenes, renders preview frames it actually looks at, revises
and (when asked) exports. **Review** mode asks before exports and large deletions. After a run:
**Accept** or **Revert all** (one undoable step).

## Claude Code via MCP
```bash
claude mcp add mantagli -- node <repo>/node_modules/tsx/dist/cli.mjs <repo>/packages/mcp/src/main.ts
```
If the app is running, Claude Code edits the open project live (shared undo history). Otherwise
the MCP server runs its own engine: use `project_create` or `project_open` first.
Start with `project_get_state` and `capabilities`.

## Tests
```bash
npm test             # unit: core model/commands, AI tools, director (scripted model), MCP stdio
npm run test:e2e     # real FFmpeg + Blender: pipeline acceptance + agent montage over MCP
npx tsx scripts/feature-sweep.ts            # every tool / effect / transition over the real protocol
node scripts/ui-sweep.mjs out [url]         # every workspace, dialog, menu (engine + Vite running)
node scripts/ui-live-parity.mjs out [url]   # live preview vs exact frame per effect (engine + Vite running)
```

## Project folder
`Name.mantagli/` contains `project.json` (versioned schema), `backups/`, `cache/` (thumbnails,
proxies, waveforms, 3D frames, previews — safe to delete), `exports/`, `scenes/*.blend`,
`oplog.jsonl`, `generated/` (synthesized sound effects, music, voice-overs, baked scenes —
imported as assets).
Source media are referenced, never modified.
