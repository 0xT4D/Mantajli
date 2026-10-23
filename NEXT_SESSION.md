# Next session handoff

## State
Milestones M1–M8 and the session-2 "montage power features" (M9) have working, tested
implementations. Release installer (session 1 build, predates session 2 features):
`D:\DevTools\mantagli-target\release\bundle\nsis\Mantagli_0.1.0_x64-setup.exe`.
Read PROGRESS.md for what is verified and TASKS.md for the open checklist.
Nested git repo `C:\Users\USER\Desktop\Mantagli` (separate from the home-folder repo); work is
committed per feature on `main`.

## Start here
1. `git log --oneline | head` and `git status`.
2. `npm test` runs unit + e2e projects (≈150 s, 61 tests) — all should pass. `npm run typecheck`.
3. Packaging (verified in session 1): `npm run build:engine`, then
   `source scripts/tauri-env.sh && cd apps/desktop && npx tauri build` (~15 min, LTO).
   Rebuild the installer to ship session-2 features; not yet tested on a clean machine.

## Session 2 added (all committed, see DECISIONS D13–D17)
OTIO interchange · typewriter text · wipe/iris transitions · camera shake + beat pulse (motion
effects as curves) · speed ramps (speed keyframes, presets) · blend modes · letterbox · glitch ·
music ducking + loudness-normalised export · 3D render quality presets + Cycles device in status
bar · persistent undo history · MCP waits capped at 45 s (`export_status waitSeconds`).

## Highest-value next steps
1. Live Director run with a real API key (user must provide one): run a brief on the demo
   project (`npx tsx scripts/make-demo.ts tests/.tmp/demo`), watch for API 400s on the request
   shape in `packages/engine/src/ai/director.ts` (`fallbacks`, `output_config`, `thinking`).
2. M10 candidates (see TASKS.md): SRT captions import → styled text clips, one-click
   "auto-edit to beats" in the UI, freeze frame / reverse clips, chroma key.
3. Rebuild + install the NSIS package; validate an exported .otio with Python `opentimelineio`.
4. Optional: persist job history; investigate why FFmpeg composition got slower (~3 fps at
   1080×1920 with looks) during session 2 — the same commit was faster earlier.

## Dev loop
```
export MANTAGLI_HOME="$PWD/tests/.tmp/home-ui"
node node_modules/tsx/dist/cli.mjs packages/engine/src/main.ts --open "<project dir>"   # engine
(cd apps/desktop && npx vite)                                                            # UI
node scripts/ui-shot.mjs out.png [url] '[{"key":"Home"},{"key":"ArrowRight"},{"wait":60}]'  # screenshot; keys step frames
node scripts/rpc.mjs jobs.list        # inspect engine
npx tsx scripts/debug-frame.ts <projectDir> <frame> out.png   # FFmpeg graph debugging (keeps work dir)
```
- The paused viewer shows the live (approximate) frame for ~350 ms, then the exact render: take
  screenshots ~60 ms after stepping to see the live compositor, ~2.5 s for the exact frame.
- Stopping `npx tsx …` on Windows can orphan the real node process — kill the PID in
  `$MANTAGLI_HOME/engine.json`.
- vitest hides console output from e2e tests; write diagnostics to a file under `tests/.tmp`.
