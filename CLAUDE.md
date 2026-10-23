# Mantagli — project instructions for Claude Code

Mantagli is a desktop studio for AI-directed 3D video montages (reels, cinematic edits,
music-driven cuts). Blender renders 3D, FFmpeg composes video, Claude edits the real
project through validated tools.

## Read first every session
`NEXT_SESSION.md` → `PROGRESS.md` → `TASKS.md` → `DECISIONS.md`. Verify claims against the code
and `git log` before building on them.

## Layout
```
packages/core     Pure TS: zod project schema (versioned), commands (immer), history,
                  timeline math, composition plan, animation curves, effect/transition/look
                  registries, 3D scene templates, validation, AI summary. No Node APIs.
packages/engine   Node: ProjectSession (atomic save/autosave/backups/recovery/lock),
                  media (ffprobe, thumbnails, filmstrips, proxies, waveform, beat tracking),
                  JobManager, FFmpeg graph builder (render/ffgraph.ts), compose/verify,
                  Blender runner (render/blender.ts), AI tools (ai/tools.ts), Director
                  (ai/director.ts), RPC/HTTP host (server.ts), entry (main.ts).
packages/mcp      MCP stdio server: bridges into a running engine or runs standalone.
apps/desktop      React/Vite/Tailwind UI (src/) + Tauri 2 shell (src-tauri/).
blender/          mantagli_scene.py — runs inside Blender, interprets JSON scene jobs.
scripts/          Dev utilities (demo project, UI screenshots via Edge, rpc helper, ...).
```

## Rules
- All project mutations go through `@mantagli/core` commands (`applyCommand`) via
  `ProjectSession.dispatch/transaction`. Never mutate project objects elsewhere.
- Patches use `patchSchema()`, never `.partial()` (zod 4 `.partial()` re-applies defaults).
- Every effect/transition/text animation in the core registries must have a renderer in
  `engine/src/render/ffgraph.ts` and (approximately) in `apps/desktop/src/lib/liveCompositor.ts`.
  No UI control without a real implementation.
- Timeline time = integer frames at project fps; source offsets = seconds.
- AI tools: whitelisted, zod-validated, structured results with error categories. No shell tools.
- Never modify or delete user source media. Caches live in `<project>.mantagli/cache/`.
- Keep the composition math in one place (`core/composition.ts`, `core/animation.ts`) so the
  live preview and the export agree.
- Python edits on Windows: always `open(p, encoding="utf-8")`.

## Environment (this machine)
- Drive C: is nearly full. Toolchains live on D:: Blender `D:\DevTools\blender-5.2.3`,
  Rust `D:\DevTools\rustup` + `D:\DevTools\cargo` (GNU toolchain default, MSVC Build Tools
  could not be installed for lack of space), npm cache `D:\DevTools\npm-cache`,
  `node_modules` is a junction to `D:\DevTools\mantagli-node_modules`.
- FFmpeg 8.1 (gyan essentials) on PATH. Node 22.18.
- `tests/.tmp/` holds generated media, test projects and an isolated `MANTAGLI_HOME`.

## Commands
```
npm test                      # unit tests (core, AI tools/director, MCP stdio)
npm run test:e2e              # real FFmpeg + Blender acceptance test (~30 s on RTX 4060)
npm run engine                # engine host (prints MANTAGLI_ENGINE_READY {port, token})
npm run dev:ui                # Vite UI at http://127.0.0.1:1420 (finds the engine via engine.json)
npm run typecheck
npm run mcp                   # MCP stdio server
npx tsx scripts/make-demo.ts tests/.tmp/demo      # demo project with real media
node scripts/ui-shot.mjs out.png                  # headless Edge screenshot of the UI
node scripts/rpc.mjs <method> [json]              # call the running engine
```
Set `MANTAGLI_HOME=tests/.tmp/home-ui` when experimenting so real user settings are untouched.
