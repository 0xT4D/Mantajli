# Next session handoff

## State
Milestones M1–M14 have working, tested implementations (TASKS.md; PROJECT_STATUS.md has per-session
tables with measured results). Sessions 5–6 ran in a cloud Linux container (no GPU). Session 6 added
music generation, voice-over (local + cloud TTS), sound-design suggestions, mix metering and the
ARENA end-to-end benchmark, then a verification and quality pass: frame-scaled looks and
supersampled lens distortion (sharper 3D through the CRT finish), card backdrops, more natural
local voices (RHVoice, Pico, Piper), a content-addressed 3D cache and several audio/caption fixes.
All work is on branch `claude/clever-ramanujan-hqhf0u` (github.com/0xT4D/Mantajli). The dev
machine's nested repo `C:\Users\USER\Desktop\Mantagli` has `main` from before session 5 — merge or
pull the branch there. Release installer (session 3 build) predates sessions 4–6.

## Start here
1. `git log --oneline | head` and `git status`. Read PROJECT_STATUS.md → PROGRESS.md → TASKS.md → DECISIONS.md.
2. `npm install`, `npm run typecheck`, `npx vitest run --project unit` (≈20 s), then
   `npx vitest run --project e2e` (renders 3D: run under `xvfb-run` on Linux; ≈10 min on 4 CPU cores).
   `npm test` runs both projects; without a display the Blender e2e tests fail with a libEGL error.
3. Sweeps (engine + Vite running for the UI ones):
   `npx tsx scripts/feature-sweep.ts`, `node scripts/ui-sweep.mjs tests/.tmp/ui-sweep`,
   `node scripts/ui-live-parity.mjs tests/.tmp/live-parity`.
4. Benchmark: `npx tsx scripts/benchmark/arena.ts` (≈23 min on CPU for the first build, ~2 min
   when the 3D cache is warm; `MANTAGLI_ARENA_STILLS=1` renders only the 2D cards in seconds;
   `MANTAGLI_ARENA_SIZE=1080x1920` on a GPU machine). Output in `tests/.tmp/arena/review/`.
5. Packaging (verified in session 1): `npm run build:engine`, then
   `source scripts/tauri-env.sh && cd apps/desktop && npx tauri build` (~15 min, LTO).

## Highest-value next steps
1. **Natural voice for real**: install Piper (`pip install piper-tts`) and one voice model
   (`*.onnx` + `.onnx.json`, check its licence) into `<app data>/voices/piper` or
   `MANTAGLI_PIPER_VOICES`, then run `voice.test.ts` and the ARENA benchmark with `provider: "piper"`.
   Only a stand-in executable was tested here (no model downloads in this container). On Windows,
   check SAPI with the installed OneCore/Natural voices.
2. **ARENA at full size on the RTX machine** (`MANTAGLI_ARENA_SIZE=1080x1920`), and the older
   NEON QUEST benchmark (`scripts/benchmark/build.ts export`); compare with `example_videos/`.
3. **Live Director run** with a real API key (request shape unverified live).
4. **Installer** rebuild with sessions 4–6, install on a clean machine.
5. Ideas not started: letter-spacing for 2D text (FFmpeg 6.1 drawtext has none; needs per-glyph
   layout or a text raster shared with the live preview), animated backdrops (drifting smoke),
   speech-to-text captions (Whisper), shatter/fracture, three.js interactive viewport.

## Dev loop
Windows (dev machine):
```
export MANTAGLI_HOME="$PWD/tests/.tmp/home-ui"
node node_modules/tsx/dist/cli.mjs packages/engine/src/main.ts --open "<project dir>"   # engine
(cd apps/desktop && npx vite)                                                            # UI
node scripts/ui-shot.mjs out.png [url] '[{"key":"Home"},{"key":"ArrowRight"},{"wait":60}]'  # screenshot
node scripts/rpc.mjs jobs.list        # inspect engine
npx tsx scripts/debug-frame.ts <projectDir> <frame> out.png   # FFmpeg graph debugging (keeps work dir)
```
Linux (cloud container, sessions 5–6): `apt-get install blender xvfb espeak-ng rhvoice rhvoice-english
libttspico-utils` (Blender 4.0.2), run anything that renders 3D under `xvfb-run -a -s "-screen 0
1280x720x24" …` (EEVEE on llvmpipe: ≈3 s per 540×960 frame). UI scripts use Playwright's Chromium
(`scripts/browser.mjs`). Scripts that edit projects should set `autoRenderScenes: false` (the
benchmark does): background draft renders share the single heavy render lane with stills.
- The engine loads code at start: restart it after engine changes before running UI sweeps.
- Background shells in the cloud session are stopped after 2 h (Vite was, once).
- The paused viewer shows the live (approximate) frame for ~350 ms, then the exact render.
- vitest hides console output from e2e tests; write diagnostics to a file under `tests/.tmp`.
