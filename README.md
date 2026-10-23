# Mantagli

AI-directed 3D montage studio for reels, cinematic edits and music-driven videos.
Blender renders the 3D scenes, FFmpeg composes and encodes, and Claude (in-app or through
Claude Code via MCP) edits the real, editable project.

## Requirements
- Windows 10/11 (macOS/Linux should work but are untested)
- Node.js 22.13+
- FFmpeg + FFprobe on PATH (e.g. `winget install Gyan.FFmpeg`)
- Blender 4.2+ (5.2 LTS tested). Auto-detected in Program Files, `D:\DevTools`, or set in Settings
- For the desktop shell: Rust + Tauri prerequisites (WebView2 ships with Windows 11)
- Optional: an Anthropic API key for the in-app AI Director

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
   delete with **Del** (Shift+Del ripples), duplicate with **Ctrl+D**, undo/redo **Ctrl+Z / Ctrl+Shift+Z**.
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
```

## Project folder
`Name.mantagli/` contains `project.json` (versioned schema), `backups/`, `cache/` (thumbnails,
proxies, waveforms, 3D frames, previews — safe to delete), `exports/`, `scenes/*.blend`,
`oplog.jsonl`. Source media are referenced, never modified.
