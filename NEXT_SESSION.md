# Next session handoff

## State
All milestones M1–M8 have working, tested implementations. Release installer built:
`D:\DevTools\mantagli-target\release\bundle\nsis\Mantagli_0.1.0_x64-setup.exe` (23.5 MB).
Read PROGRESS.md for what is verified and TASKS.md for the open checklist.
Last commit on `main` of the nested repo `C:\Users\USER\Desktop\Mantagli` (its own git repo,
separate from the home-folder repo).

## Start here
1. `git log --oneline | head` and `git status`.
2. `npm test` (≈10 s) and `npm run test:e2e` (≈70 s) — all should pass.
3. Packaging (verified): `npm run build:engine`, then
   `source scripts/tauri-env.sh && cd apps/desktop && npx tauri build` (~15 min, LTO).
   Not yet tested: installing the NSIS installer on a clean machine.

## Highest-value next steps
1. Live Director run with a real API key (user must provide one): run a brief on the demo
   project (`npx tsx scripts/make-demo.ts tests/.tmp/demo`), watch for API 400s on the request
   shape in `packages/engine/src/ai/director.ts` (`fallbacks`, `output_config`, `thinking`).
2. Done since: track reordering, marker dragging, keyframe curve editor, automatic background
   3D previews, OpenTimelineIO export/import (`engine/src/interchange/otio.ts`, tools
   `timeline_export_otio` / `timeline_import_otio`, RPC `interchange.*`, Export dialog section).
   Optional: validate an exported .otio with the Python `opentimelineio` package / Resolve.
3. More templates/effects: typewriter text animation, wipe transitions (each needs ffgraph +
   liveCompositor renderers), Cycles GPU quality presets in the UI.
4. Persist job history (node:sqlite) and undo history across sessions (optional).

## Dev loop
```
export MANTAGLI_HOME="$PWD/tests/.tmp/home-ui"
node node_modules/tsx/dist/cli.mjs packages/engine/src/main.ts --open "<project dir>"   # engine
(cd apps/desktop && npx vite)                                                            # UI
node scripts/ui-shot.mjs out.png      # screenshot via headless Edge
node scripts/rpc.mjs jobs.list        # inspect engine
npx tsx scripts/debug-frame.ts <projectDir> <frame> out.png   # FFmpeg graph debugging (keeps work dir)
```
Note: stopping `npx tsx …` on Windows can orphan the real node process — kill the PID in
`$MANTAGLI_HOME/engine.json`.
