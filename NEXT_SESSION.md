# Next session handoff

## State
Milestones M1–M13 have working, tested implementations (see TASKS.md; PROJECT_STATUS.md has the
per-session tables). Session 5 ran in a cloud Linux container (no GPU): it verified sessions 1–4 on a
second platform, fixed what broke there, and added live-preview parity, transition presets, scatter
bursts and several bug fixes. All work is committed on branch `claude/clever-ramanujan-hqhf0u`
(pushed to `origin`, github.com/0xT4D/Mantajli); the dev machine's nested repo
`C:\Users\USER\Desktop\Mantagli` has `main` from before session 5 — merge or pull the branch there.
Release installer (session 3 build): `D:\DevTools\mantagli-target\release\bundle\nsis\Mantagli_0.1.0_x64-setup.exe`
— predates sessions 4–5.

## Start here
1. `git log --oneline | head` and `git status`. Read PROJECT_STATUS.md → PROGRESS.md → TASKS.md → DECISIONS.md.
2. `npm install`, `npm run typecheck`, `npm test` (unit ≈ 7 s; with e2e ≈ 160 s on the RTX machine,
   ≈ 9 min on a 4-core CPU-only container). `RENDERER_VERSION` is 7 and the Blender script changed, so
   cached previews and 3D frames re-render once.
3. Sweeps (engine + Vite running for the UI ones):
   `npx tsx scripts/feature-sweep.ts`, `node scripts/ui-sweep.mjs tests/.tmp/ui-sweep`,
   `node scripts/ui-live-parity.mjs tests/.tmp/live-parity`.
4. Packaging (verified in session 1): `npm run build:engine`, then
   `source scripts/tauri-env.sh && cd apps/desktop && npx tauri build` (~15 min, LTO).

## Highest-value next steps
1. **Benchmark export on the dev machine** (could not run without a GPU):
   `npx tsx scripts/benchmark/build.ts export` (project in `D:\MantagliBenchmark`), verify, compare
   against `example_videos/` (git LFS: `git lfs pull`) and log findings in PROJECT_STATUS.md.
   Consider adding a coin burst to the treasure shot now that bursts exist.
2. **Live Director run** with a real API key (user must provide one): watch for API 400s on the request
   shape in `packages/engine/src/ai/director.ts` (`fallbacks`, `output_config`, `thinking`).
3. **Installer**: rebuild with sessions 4–5 and install on a clean machine.
4. Ideas not started: shatter/fracture (text breaking into pieces), keyframed masks, auto-reframe
   (horizontal → vertical tracked crop), speech-to-text captions (local Whisper), animated title
   templates, LUT browser, persisted job history.

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
Linux (cloud container, as in session 5): `apt-get install blender xvfb` (4.0.2), run anything that
renders 3D under `xvfb-run -a -s "-screen 0 1280x720x24" …` (EEVEE needs a display; llvmpipe is slow:
~26 s per quarter-scale draft frame of a dense scene). UI scripts use Playwright's Chromium
(`scripts/browser.mjs`; `MANTAGLI_CHROMIUM` overrides). Set `autoRenderScenes: false` in
`$MANTAGLI_HOME/settings.json` to keep Blender out of the way while scripting the UI.
- The paused viewer shows the live (approximate) frame for ~350 ms, then the exact render: take
  screenshots ~60 ms after stepping to see the live compositor, ~2.5 s for the exact frame.
- Stopping `npx tsx …` on Windows can orphan the real node process — kill the PID in
  `$MANTAGLI_HOME/engine.json`.
- vitest hides console output from e2e tests; write diagnostics to a file under `tests/.tmp`.
