# Progress

_Last updated: 2026-10-23 (session 1)_

## What works (verified this session)
| Area | Verification |
|---|---|
| Project model, commands, undo/redo, migrations, validation | 21 core unit tests |
| Sessions: create/open, autosave, backups, corrupt-file recovery, missing media + relink | `pipeline.e2e.test.ts` |
| Media: import (video/audio/image/model), probe, thumbnails, filmstrips, proxies, waveforms | e2e + UI screenshots |
| Beat tracking (120 BPM click track detected at 120 ± 3, 12-frame spacing) | e2e |
| FFmpeg composition: layers, transforms, keyframes, effects, transitions, text, audio | e2e export + frame inspection |
| Blender: chrome title, OBJ model turntable, draft + final renders, resumable cache | e2e + rendered frames viewed |
| Export presets + FFprobe verification + sample decode | e2e (1920×1080 and 1080×1920 exports) |
| AI tools (validation, atomic batches, approvals, import boundaries) | `ai.test.ts` |
| Director loop (scripted model): tool calls, error feedback/stop, approvals, cancel, revert | `ai.test.ts` |
| MCP stdio: standalone and bridged into a running engine | `mcp.test.ts` |
| Agent-style montage through MCP: beat cuts, 3D title, looks, previews, export | `montage.e2e.test.ts` |
| UI in a browser (Edge/Playwright): layout, timeline drag/trim, bin→timeline drop, exact frames | screenshots in session |
| Tauri desktop app (debug): window, engine supervision, clean shutdown | launched + screen capture |
| Engine bundle (single file + Node runtime) starts and renders 3D via Blender | smoke test + RPC-driven 3D still |
| Release build + NSIS installer (23.5 MB) | `npx tauri build`; release exe launched, bundled engine running |
| Preview cancellation leaves no cached output | cancelled a Blender preview mid-render via RPC |

Test totals: `npm test` + `npm run test:e2e` → 40 tests, all passing (≈85 s, RTX 4060).

## Known gaps / limitations
- In-app Director never ran against the real Claude API (no API key on this machine). Request
  shape (adaptive thinking, effort, `fallbacks: "default"` beta, eager input streaming) follows the
  current API docs but is unverified live. MCP path is verified.
- Live preview shows 3D clips only after "Render 3D previews"; colour effects are approximated
  live (exact when paused/rendered).
- Undo history is per process (not persisted). Op log persists (`oplog.jsonl`).
- No OpenTimelineIO interchange, no curve/graph editor, no typewriter text, no wipe transitions.
- Job history is in memory (no SQLite).
- Installer not yet installed/tested on a clean machine (built and the release exe run in place).
- Observed once: a black preview still in a release-app session whose window was closed during a
  Blender render. Not reproduced (cancellation test leaves no cache). Watch for it.
- `C:\tests\.tmp\demo\…\frame_00001.part.png` is a stray file from a fixed bug (relative project
  dir). Deleting `C:\tests` was blocked by a safety check; the user can delete it.

## Environment notes
- C: has ~1.3 GB free. All toolchains and build output are on D: (see CLAUDE.md).
- Rust GNU toolchain + MSYS2 binutils (`D:\DevTools\mingw-binutils`) + `gcc` pass-through shim
  (`D:\DevTools\winres-shim`) for Tauri resources. `source scripts/tauri-env.sh` before cargo/tauri.
- User-level env vars set: RUSTUP_HOME, CARGO_HOME, npm_config_cache, PATH += D:\DevTools\cargo\bin.
